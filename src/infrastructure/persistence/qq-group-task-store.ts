/**
 * 主人授权的 QQ 群任务 —— **持久层**（post-Lv2 / ADR-156，P1）。
 *
 * ============================================================================
 *  它是什么 / 不是什么
 * ============================================================================
 * ```text
 * 是：迁移 0027 三张表（qq_group_tasks / qq_group_task_events /
 *     qq_group_send_instances）的**唯一**读写口；
 *     任务建/读/列/改、状态迁移、**原子额度预留**、发送结算、重启恢复。
 * 不是：不是决策器（闭集与判定全在 `src/kernel/contracts/qq-group-task.ts`）、
 *     不是发送器（不碰 OneBot、不碰 TTS、不发任何消息）、
 *     不是装配（本批不接 `src/main.ts`）。
 * ```
 *
 * ============================================================================
 *  四条不能让步的实现纪律（每一条都对应本仓库踩过的真缺陷）
 * ============================================================================
 * ```text
 * ① **判定只有一份**：状态迁移 / 额度 / 停止读回 / 结算后处置 全部 import 冻结契约，
 *    本文件**不复制**任何闭集或阈值（复制一份就会漂，漂了就是两套规则）。
 * ② **"先写后判失败"必须抛异常回滚**：drizzle 的事务回调**正常 return 就会 COMMIT**
 *    （P3-2 踩过的真缺陷）。本文件里凡是"写完还要判"的位置，一律 throw 让事务回滚；
 *    可以返回 `{ok:false}` 的拒绝都发生在**任何写之前**。
 * ③ **抢最后一条额度必须行锁**：`reserveGroupSend()` 在**同一个事务**里
 *    `select … for update` 锁任务行 → 用 `decideSendAllowance` 判定 →
 *    写实例 + 事件。禁止"先查再写"（那在并发下必然超发）。
 * ④ **读回坏行抛具名错**：`assertGroupTaskView`（契约）+ 本地字段校验，
 *    坏行抛 `KernelError`（`group_task_row_invalid` /
 *    `group_task_contract_version_mismatch` / `group_send_instance_row_invalid`），
 *    **绝不**回退成默认值（一个默认值会让"库里坏了"看起来像"她没做过这件事"）。
 * ```
 *
 * ============================================================================
 *  额度口径（两个计数器，别混）
 * ============================================================================
 * ```text
 * used_messages（任务行的"已占用"）：
 *   结算为 `api_accepted` / `unknown` 时**增加**该实例的 reserved_messages。
 *   `unknown` 保守计入（结果不明也可能已经送达）；
 *   `failed_confirmed` **不增加**，但也**不退还** —— 见下一条。
 *
 * 总预算占用（判额度用的 totalMessages）：
 *   该任务**全部**发送实例的 `reserved_messages` 之和。
 *   实例行没有删除路径 ⇒ 一次尝试一旦落库就消耗额度，
 *   "明确失败"不会变成"可以重试的免费次数"（ADR-156 §2.8）。
 *   重启恢复里 `queued → failed_confirmed` 同理不退还。
 * ```
 * ⚠️ 因此 `decideSendAllowance` 的 `usage.totalMessages` **不是** `used_messages`
 *    列，而是上面那个"全部实例之和"。两处都按 `reserved_messages` 计（按对外消息数）。
 */

import { randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'

import { KernelError } from '../../kernel/contracts/ids.ts'
import {
  GROUP_SEND_STATES,
  GROUP_SEND_TERMINAL_STATES,
  GROUP_TASK_AUTH_SOURCES,
  GROUP_TASK_CATEGORIES,
  GROUP_TASK_CONTRACT_VERSION,
  GROUP_TASK_CONTENT_MODES,
  GROUP_TASK_KINDS,
  GROUP_TASK_LIMITS,
  GROUP_TASK_MEDIA,
  GROUP_TASK_STATUSES,
  assertGroupTaskView,
  decideSendAllowance,
  decideTaskAfterSendSettlement,
  decideTaskModification,
  decideTaskStop,
  decideTaskTransition,
  isTerminalGroupTaskStatus,
  recoverSendStateOnRestart,
  type GroupSendDenialCode,
  type GroupSendInstanceView,
  type GroupSendState,
  type GroupTaskContent,
  type GroupTaskContentMode,
  type GroupTaskKind,
  type GroupTaskMedia,
  type GroupTaskPatchDraft,
  type GroupTaskQuota,
  type GroupTaskStatus,
  type GroupTaskTarget,
  type GroupTaskTerm,
  type GroupTaskTrigger,
  type GroupTaskView,
  type TaskStopReport,
} from '../../kernel/contracts/qq-group-task.ts'
import { exec, inTransaction, type RawDb } from './db.ts'

// ---------------------------------------------------------------------------
// 事件闭集
// ---------------------------------------------------------------------------

/**
 * 事件名闭集（DDL 的 `qq_group_task_events.event` check 与它逐项同源）。
 *
 * ⚠️ 与 `task-1` 规格列的 9 项相比多一个 `complete`：冻结契约的迁移表允许
 *    `active→completed`，而 `completed` 没有任何既存事件名能如实表达
 *    （记成 `expired` / `exhausted` / `stop` 都是**假记**，会让批记录说没发生过的事）。
 *    这一项同时在迁移 0027 的注释里写明 —— 若契约侧决定不支持 completed 迁移，
 *    两处要一起删。
 */
export const GROUP_TASK_EVENT_NAMES = [
  'create', 'modify', 'pause', 'resume', 'stop', 'send_reserved', 'send_settled',
  'expired', 'exhausted', 'complete',
] as const
export type GroupTaskEventName = (typeof GROUP_TASK_EVENT_NAMES)[number]

/** 非终态（partial unique index 的那三个状态，由闭集派生而不是手抄） */
const OPEN_TASK_STATUSES = GROUP_TASK_STATUSES.filter(status => !isTerminalGroupTaskStatus(status))

// ---------------------------------------------------------------------------
// 小工具（读行用：坏值 → undefined / 具名错，**不给默认值**）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** bigint 列在不同驱动下是 number / string；只接受**精确**整数，其余返回 undefined */
function safeInt(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

/** jsonb 列：正常是对象；某些驱动会给字符串（那是**驱动差异**，不是坏值） */
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return undefined
    }
  }
  return isPlainObject(parsed) ? parsed : undefined
}

/** 闭集字符串数组（成员合法性由调用方按各自的闭集再核） */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function intOf(value: unknown): number {
  const parsed = safeInt(value)
  return parsed === undefined ? Number.NaN : parsed
}

// ---------------------------------------------------------------------------
// 行 → 视图
// ---------------------------------------------------------------------------

/**
 * 读回一条任务行。
 *
 * 顺序是刻意的：先 `assertGroupTaskView`（契约的契约版本核对，抛
 * `group_task_contract_version_mismatch`），再本地核字段与 jsonb 结构
 * （抛 `group_task_row_invalid`）。这样"版本不对"与"内容坏了"是两个可区分的码。
 */
function taskViewFromRow(row: Record<string, unknown>): GroupTaskView {
  const content = jsonObject(row.content)
  const trigger = jsonObject(row.trigger)
  const term = jsonObject(row.term)
  const quota = jsonObject(row.quota)
  const lastSendAt = row.last_send_at === null || row.last_send_at === undefined
    ? null
    : intOf(row.last_send_at)

  const view = {
    id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
    contractVersion: intOf(row.contract_version),
    version: intOf(row.version),
    status: String(row.status ?? '') as GroupTaskStatus,
    kind: String(row.kind ?? '') as GroupTaskKind,
    target: {
      botId: typeof row.bot_id === 'string' ? row.bot_id : String(row.bot_id ?? ''),
      groupId: typeof row.group_id === 'string' ? row.group_id : String(row.group_id ?? ''),
    },
    // ⚠️ 这三个字段刻意**不**填缺省对象：`undefined` 会被下面的结构校验判成坏行，
    //    而不是被"补成一个空 trigger/quota"从而看起来像一条正常的任务。
    content: content as unknown as GroupTaskContent,
    media: String(row.media ?? '') as GroupTaskMedia,
    textFallback: row.text_fallback as boolean,
    trigger: trigger as unknown as GroupTaskTrigger,
    term: term as unknown as GroupTaskTerm,
    quota: quota as unknown as GroupTaskQuota,
    usedMessages: intOf(row.used_messages),
    lastSendAt,
    authSource: String(row.auth_source ?? '') as GroupTaskView['authSource'],
    createdAt: intOf(row.created_at),
    updatedAt: intOf(row.updated_at),
  }
  assertGroupTaskView(view)
  const problems = taskViewProblems(view)
  if (problems.length > 0) {
    throw new KernelError(
      'validation_error',
      'group_task_row_invalid',
      `群任务行 ${view.id === '' ? '(空 id)' : view.id} 结构非法：${problems.join('；')}`
    )
  }
  return view
}

/** 任务视图的结构校验（坏 → 问题列表；**不**修正任何字段） */
function taskViewProblems(view: GroupTaskView): string[] {
  const problems: string[] = []
  const fail = (message: string): void => { problems.push(message) }

  if (typeof view.id !== 'string' || view.id.trim() === '') fail('id 不是非空字符串')
  if (!Number.isSafeInteger(view.version) || view.version < 1) fail(`version=${String(view.version)}`)
  if (!GROUP_TASK_STATUSES.includes(view.status)) fail(`status=${String(view.status)}`)
  if (!GROUP_TASK_KINDS.includes(view.kind)) fail(`kind=${String(view.kind)}`)
  if (typeof view.target?.botId !== 'string' || view.target.botId === '') fail('botId 不是非空字符串')
  if (typeof view.target?.groupId !== 'string' || view.target.groupId === '') fail('groupId 不是非空字符串')
  if (!GROUP_TASK_MEDIA.includes(view.media)) fail(`media=${String(view.media)}`)
  if (typeof view.textFallback !== 'boolean') fail('textFallback 不是布尔')
  if (view.media === 'text' && view.textFallback === true) fail('media=text 却允许文字兜底')
  if (view.media === 'voice' && view.textFallback === true) fail('media=voice 却允许文字兜底')
  if (!GROUP_TASK_AUTH_SOURCES.includes(view.authSource)) fail(`authSource=${String(view.authSource)}`)
  if (!Number.isSafeInteger(view.usedMessages) || view.usedMessages < 0) {
    fail(`usedMessages=${String(view.usedMessages)}`)
  }
  if (view.lastSendAt !== null && (!Number.isSafeInteger(view.lastSendAt) || view.lastSendAt < 0)) {
    fail(`lastSendAt=${String(view.lastSendAt)}`)
  }
  if (!Number.isSafeInteger(view.createdAt) || view.createdAt < 0) fail(`createdAt=${String(view.createdAt)}`)
  if (!Number.isSafeInteger(view.updatedAt) || view.updatedAt < 0) fail(`updatedAt=${String(view.updatedAt)}`)

  const content = view.content as unknown
  if (!isPlainObject(content)) {
    fail('content 不是对象')
  } else {
    if (!GROUP_TASK_CONTENT_MODES.includes(content.mode as GroupTaskContentMode)) {
      fail(`content.mode=${String(content.mode)}`)
    }
    if (content.text !== null && typeof content.text !== 'string') fail('content.text 不是字符串/null')
    if (content.brief !== null && typeof content.brief !== 'string') fail('content.brief 不是字符串/null')
    if (content.mode === 'owner_verbatim' && content.text === null) fail('owner_verbatim 缺 text')
    if (content.mode === 'model_generated' && content.brief === null) fail('model_generated 缺 brief')
  }

  const trigger = view.trigger as unknown
  if (!isPlainObject(trigger)) {
    fail('trigger 不是对象')
  } else {
    const members = stringList(trigger.memberIds)
    if (members === undefined) fail('trigger.memberIds 不是字符串数组')
    else if (members.length > GROUP_TASK_LIMITS.maxMemberIds) fail(`memberIds=${String(members.length)}`)
    if (trigger.replyToMessageId !== null && typeof trigger.replyToMessageId !== 'string') {
      fail('trigger.replyToMessageId 不是字符串/null')
    }
    const categories = stringList(trigger.categories)
    if (categories === undefined) fail('trigger.categories 不是字符串数组')
    else if (categories.some(item => !GROUP_TASK_CATEGORIES.includes(item as never))) {
      fail(`trigger.categories=${categories.join(',')}`)
    }
    if (trigger.topicScope !== null && typeof trigger.topicScope !== 'string') {
      fail('trigger.topicScope 不是字符串/null')
    }
  }

  const term = view.term as unknown
  if (!isPlainObject(term)) {
    fail('term 不是对象')
  } else if (term.kind === 'window') {
    const startAt = safeInt(term.startAt)
    const endAt = safeInt(term.endAt)
    if (startAt === undefined) fail(`term.startAt=${String(term.startAt)}`)
    if (endAt === undefined) fail(`term.endAt=${String(term.endAt)}`)
    if (startAt !== undefined && endAt !== undefined) {
      if (endAt <= startAt) fail('term.endAt 不大于 startAt')
      if (endAt - startAt > GROUP_TASK_LIMITS.maxWindowMs) fail('term 窗口超过上界')
    }
  } else if (term.kind === 'long_term') {
    if (safeInt(term.startAt) === undefined) fail(`term.startAt=${String(term.startAt)}`)
  } else {
    fail(`term.kind=${String(term.kind)}`)
  }

  const quota = view.quota as unknown
  if (!isPlainObject(quota)) {
    fail('quota 不是对象')
  } else {
    const total = safeInt(quota.totalMaxMessages)
    if (quota.totalMaxMessages !== null && (total === undefined || total < 1)) {
      fail(`quota.totalMaxMessages=${String(quota.totalMaxMessages)}`)
    }
    const perInbound = safeInt(quota.perInboundMaxMessages)
    if (perInbound === undefined || perInbound < 1 || perInbound > GROUP_TASK_LIMITS.maxPerInboundMessages) {
      fail(`quota.perInboundMaxMessages=${String(quota.perInboundMaxMessages)}`)
    }
    if (quota.slot !== null) {
      if (!isPlainObject(quota.slot)) {
        fail('quota.slot 不是对象/null')
      } else {
        const windowMs = safeInt(quota.slot.windowMs)
        const maxMessages = safeInt(quota.slot.maxMessages)
        if (windowMs === undefined || windowMs < GROUP_TASK_LIMITS.minSlotWindowMs
          || windowMs > GROUP_TASK_LIMITS.maxSlotWindowMs) {
          fail(`quota.slot.windowMs=${String(quota.slot.windowMs)}`)
        }
        if (maxMessages === undefined || maxMessages < 1
          || maxMessages > GROUP_TASK_LIMITS.maxSlotMessages) {
          fail(`quota.slot.maxMessages=${String(quota.slot.maxMessages)}`)
        }
      }
    }
    const minIntervalMs = safeInt(quota.minIntervalMs)
    if (minIntervalMs === undefined || minIntervalMs < 0 || minIntervalMs > GROUP_TASK_LIMITS.maxMinIntervalMs) {
      fail(`quota.minIntervalMs=${String(quota.minIntervalMs)}`)
    }
  }

  return problems
}

function sendInstanceViewFromRow(row: Record<string, unknown>): GroupSendInstanceView {
  const view: GroupSendInstanceView = {
    id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
    taskId: typeof row.task_id === 'string' ? row.task_id : String(row.task_id ?? ''),
    taskVersion: intOf(row.task_version),
    state: String(row.state ?? '') as GroupSendState,
    reservedMessages: intOf(row.reserved_messages),
    media: String(row.media ?? '') as GroupTaskMedia,
    target: {
      botId: typeof row.bot_id === 'string' ? row.bot_id : String(row.bot_id ?? ''),
      groupId: typeof row.group_id === 'string' ? row.group_id : String(row.group_id ?? ''),
    },
    inboundMessageId: row.inbound_message_id === null || row.inbound_message_id === undefined
      ? null : String(row.inbound_message_id),
    textFingerprint: row.text_fingerprint === null || row.text_fingerprint === undefined
      ? null : String(row.text_fingerprint),
    platformMessageId: row.platform_message_id === null || row.platform_message_id === undefined
      ? null : String(row.platform_message_id),
    createdAt: intOf(row.created_at),
    settledAt: row.settled_at === null || row.settled_at === undefined ? null : intOf(row.settled_at),
  }
  const problems: string[] = []
  const fail = (message: string): void => { problems.push(message) }
  if (view.id === '') fail('id 为空')
  if (view.taskId === '') fail('taskId 为空')
  if (!Number.isSafeInteger(view.taskVersion) || view.taskVersion < 1) fail(`taskVersion=${String(view.taskVersion)}`)
  if (!GROUP_SEND_STATES.includes(view.state)) fail(`state=${String(view.state)}`)
  if (!Number.isSafeInteger(view.reservedMessages)
    || view.reservedMessages < 1 || view.reservedMessages > GROUP_TASK_LIMITS.maxPlannedMessages) {
    fail(`reservedMessages=${String(view.reservedMessages)}`)
  }
  if (!GROUP_TASK_MEDIA.includes(view.media)) fail(`media=${String(view.media)}`)
  if (view.target.botId === '' || view.target.groupId === '') fail('target 不完整')
  if (!Number.isSafeInteger(view.createdAt) || view.createdAt < 0) fail(`createdAt=${String(view.createdAt)}`)
  if (view.settledAt !== null && (!Number.isSafeInteger(view.settledAt) || view.settledAt < 0)) {
    fail(`settledAt=${String(view.settledAt)}`)
  }
  if (problems.length > 0) {
    throw new KernelError(
      'validation_error',
      'group_send_instance_row_invalid',
      `群发送实例行 ${view.id === '' ? '(空 id)' : view.id} 结构非法：${problems.join('；')}`
    )
  }
  return view
}

// ---------------------------------------------------------------------------
// 事件（append-only：本文件只有 INSERT）
// ---------------------------------------------------------------------------

async function appendEvent(db: RawDb, input: {
  taskId: string
  version: number
  event: GroupTaskEventName
  at: number
  detail?: Record<string, unknown>
}): Promise<void> {
  await exec(db, sql`insert into qq_group_task_events (event_id, task_id, version, event, detail, at)
    values (${`qgte:${randomUUID()}`}, ${input.taskId}, ${input.version}, ${input.event},
            ${JSON.stringify(input.detail ?? {})}::jsonb, ${input.at})`, '写入群任务事件（append-only）')
}

/** 状态 → 事件名的**唯一**映射（同一个目标状态不允许两处写法不同） */
function eventForStatus(status: GroupTaskStatus): GroupTaskEventName {
  switch (status) {
    case 'paused': return 'pause'
    case 'active': return 'resume'
    case 'revoked': return 'stop'
    case 'expired': return 'expired'
    case 'exhausted': return 'exhausted'
    case 'completed': return 'complete'
    /*
     * `clarifying` 不可达：迁移表里没有任何状态能迁到 clarifying
     * （`decideTaskTransition` 只允许 from===to，而本函数在 from===to 时不会被调用）。
     * 返回 `resume` 只是为了让 switch 是全函数；它不构成一个可达行为。
     */
    case 'clarifying': return 'resume'
  }
}

// ---------------------------------------------------------------------------
// 建单
// ---------------------------------------------------------------------------

export interface CreateGroupTaskInput {
  /** 调用方分配的任务 id（端口层用 `qgt:` 前缀；本层不生成，避免"读回才发现 id 不是自己写的那个"） */
  readonly id: string
  /**
   * 去重键：由 `authSource` + **受信来源事件 id** 派生（例：`owner_qq_private:<eventId>`）。
   * 同一键重复建单 ⇒ 返回既有任务（`created: false`），不报错、不建第二条。
   */
  readonly dedupeKey: string
  readonly authSource: GroupTaskView['authSource']
  readonly kind: GroupTaskKind
  /** 建单时的状态（`clarifying` / `active` / 直接 `revoked` 都合法；由端口层决定） */
  readonly status: GroupTaskStatus
  readonly target: GroupTaskTarget
  readonly content: GroupTaskContent
  readonly media: GroupTaskMedia
  readonly textFallback: boolean
  readonly trigger: GroupTaskTrigger
  readonly term: GroupTaskTerm
  readonly quota: GroupTaskQuota
  /** 通常是 0；只有"从既有事实补登记"时才非零 */
  readonly usedMessages?: number
  readonly lastSendAt?: number | null
  readonly now: number
}

export interface CreateGroupTaskResult {
  readonly task: GroupTaskView
  /** `false` = 同 dedupe 键已有一条（这是"同一件事不建两次"的机器形态，**不是**失败） */
  readonly created: boolean
}

/** 唯一约束名（partial unique index）：供 `on conflict` 之外的路径识别"每群一条"冲突 */
const ONE_OPEN_REPLY_WINDOW_INDEX = 'qq_group_tasks_one_open_reply_window'

function isOneOpenReplyWindowViolation(error: unknown): boolean {
  if (!(error instanceof KernelError)) return false
  const message = error.message
  return message.includes(ONE_OPEN_REPLY_WINDOW_INDEX)
    || (message.includes('duplicate key') && message.includes('reply_window'))
}

/**
 * 建一条群任务（单事务：任务行 + `create` 事件）。
 *
 * 顺序（全部在**同一事务**里，且拒绝发生在任何写之前）：
 * ```text
 * ① 同 dedupe 键已存在           ⇒ 返回既有任务（created=false），不写事件
 * ② reply_window 且非终态，同 (bot, 群) 已有 ⇒ 抛 group_task_conflict_requires_decision
 *    （这一条是**再核一次**：partial unique index 才是机器保证；这里给出具名理由）
 * ③ 写任务行 + create 事件 ⇒ 返回读回视图
 * ```
 * ⚠️ 并发下 ①② 都通过、③ 撞 partial unique index ⇒ 把唯一冲突**具名**成
 *    `group_task_conflict_requires_decision`（不是裸 `query_failed`）。
 */
export async function createGroupTask(
  db: RawDb,
  input: CreateGroupTaskInput
): Promise<CreateGroupTaskResult> {
  if (typeof input.id !== 'string' || input.id.trim() === '') {
    throw new KernelError('validation_error', 'group_task_input_invalid', '建单必须有非空任务 id')
  }
  if (typeof input.dedupeKey !== 'string' || input.dedupeKey.trim() === '') {
    throw new KernelError('validation_error', 'group_task_input_invalid', '建单必须有非空去重键')
  }
  const usedMessages = input.usedMessages ?? 0
  const lastSendAt = input.lastSendAt ?? null
  const prospective: GroupTaskView = {
    id: input.id,
    contractVersion: GROUP_TASK_CONTRACT_VERSION,
    version: 1,
    status: input.status,
    kind: input.kind,
    target: input.target,
    content: input.content,
    media: input.media,
    textFallback: input.textFallback,
    trigger: input.trigger,
    term: input.term,
    quota: input.quota,
    usedMessages,
    lastSendAt,
    authSource: input.authSource,
    createdAt: input.now,
    updatedAt: input.now,
  }
  const problems = taskViewProblems(prospective)
  if (problems.length > 0) {
    throw new KernelError(
      'validation_error',
      'group_task_input_invalid',
      `建单输入非法：${problems.join('；')}`
    )
  }

  try {
    return await inTransaction(db, async tx => {
      const existing = await findTaskRowByDedupeKey(tx, input.dedupeKey)
      if (existing !== undefined) {
        return { task: taskViewFromRow(existing), created: false }
      }
      if (input.kind === 'reply_window' && !isTerminalGroupTaskStatus(input.status)) {
        const conflict = await exec(tx, sql`select id from qq_group_tasks
          where kind = 'reply_window' and bot_id = ${input.target.botId} and group_id = ${input.target.groupId}
            and status in ${sql.raw(`(${OPEN_TASK_STATUSES.map(status => `'${status}'`).join(',')})`)}
          limit 1 for update`, '检查同群是否已有非终态回复任务')
        if (conflict.length > 0) {
          throw new KernelError(
            'validation_error',
            'group_task_conflict_requires_decision',
            `群 ${input.target.groupId} 已有非终态回复任务 ${String(conflict[0]!.id)}：` +
              '重叠时不静默覆盖也不同时跑两份，须由主人明确修改/替代/延后'
          )
        }
      }
      const rows = await exec(tx, sql`insert into qq_group_tasks
          (id, contract_version, version, status, kind, bot_id, group_id, content, media,
           text_fallback, trigger, term, quota, used_messages, last_send_at, auth_source,
           dedupe_key, created_at, updated_at, revoked_at)
        values (${input.id}, ${GROUP_TASK_CONTRACT_VERSION}, 1, ${input.status}, ${input.kind},
                ${input.target.botId}, ${input.target.groupId},
                ${JSON.stringify(input.content)}::jsonb, ${input.media}, ${input.textFallback},
                ${JSON.stringify(input.trigger)}::jsonb, ${JSON.stringify(input.term)}::jsonb,
                ${JSON.stringify(input.quota)}::jsonb, ${usedMessages}, ${lastSendAt},
                ${input.authSource}, ${input.dedupeKey}, ${input.now}, ${input.now},
                ${input.status === 'revoked' ? input.now : null})
        on conflict (dedupe_key) do nothing
        returning *`, '登记群任务')
      if (rows.length === 0) {
        /* 并发下同 dedupe 键被另一条事务抢先 ⇒ 读回那一条（不报错、不建第二条） */
        const raced = await findTaskRowByDedupeKey(tx, input.dedupeKey)
        if (raced === undefined) {
          throw new KernelError('persistence_error', 'group_task_dedupe_readback_missing',
            '插入被去重键挡下，但读回不到既有任务（不猜，如实失败）')
        }
        return { task: taskViewFromRow(raced), created: false }
      }
      const task = taskViewFromRow(rows[0]!)
      await appendEvent(tx, {
        taskId: task.id, version: task.version, event: 'create', at: input.now,
        detail: {
          kind: task.kind, status: task.status, groupId: task.target.groupId,
          authSource: task.authSource, dedupeKey: input.dedupeKey,
        },
      })
      return { task, created: true }
    })
  } catch (error) {
    if (isOneOpenReplyWindowViolation(error)) {
      throw new KernelError(
        'validation_error',
        'group_task_conflict_requires_decision',
        `群 ${input.target.groupId} 已有非终态回复任务（partial unique index 挡下）：` +
          '重叠时不静默覆盖也不同时跑两份'
      )
    }
    throw error
  }
}

async function findTaskRowByDedupeKey(
  db: RawDb,
  dedupeKey: string
): Promise<Record<string, unknown> | undefined> {
  const rows = await exec(db, sql`select * from qq_group_tasks where dedupe_key = ${dedupeKey} limit 1`,
    '按去重键读取群任务')
  return rows[0]
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export async function getGroupTask(db: RawDb, id: string): Promise<GroupTaskView | undefined> {
  const rows = await exec(db, sql`select * from qq_group_tasks where id = ${id} limit 1`, '读取群任务')
  if (rows.length === 0) return undefined
  return taskViewFromRow(rows[0]!)
}

export interface ListGroupTasksFilter {
  readonly status?: GroupTaskStatus
  readonly statuses?: readonly GroupTaskStatus[]
  readonly groupId?: string
  readonly botId?: string
  readonly kind?: GroupTaskKind
  /** 缺省 50，上界 200（与其它列表读口同一口径） */
  readonly limit?: number
}

export async function listGroupTasks(
  db: RawDb,
  filter: ListGroupTasksFilter = {}
): Promise<GroupTaskView[]> {
  const conditions: SQL[] = []
  if (filter.status !== undefined) conditions.push(sql`status = ${filter.status}`)
  if (filter.statuses !== undefined) {
    if (filter.statuses.length === 0) return []
    conditions.push(sql.raw(`status in (${filter.statuses.map(status => `'${status}'`).join(',')})`))
  }
  if (filter.groupId !== undefined) conditions.push(sql`group_id = ${filter.groupId}`)
  if (filter.botId !== undefined) conditions.push(sql`bot_id = ${filter.botId}`)
  if (filter.kind !== undefined) conditions.push(sql`kind = ${filter.kind}`)
  const where = conditions.length === 0 ? sql`true` : sql.join(conditions, sql` and `)
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
  const rows = await exec(db, sql`select * from qq_group_tasks where ${where}
    order by created_at desc, id asc limit ${limit}`, '列出群任务')
  return rows.map(row => taskViewFromRow(row))
}

export async function listGroupSendInstances(
  db: RawDb,
  taskId: string
): Promise<GroupSendInstanceView[]> {
  const rows = await exec(db, sql`select * from qq_group_send_instances where task_id = ${taskId}
    order by created_at asc, id asc`, '列出群任务发送实例')
  return rows.map(row => sendInstanceViewFromRow(row))
}

// ---------------------------------------------------------------------------
// 修改（CAS）
// ---------------------------------------------------------------------------

interface MergedTaskSpec {
  content: GroupTaskContent
  media: GroupTaskMedia
  textFallback: boolean
  trigger: GroupTaskTrigger
  term: GroupTaskTerm
  quota: GroupTaskQuota
  /** 因内容形态切换而被清空的字段（写进 `modify` 事件的 detail，审计要看得见） */
  cleared: readonly ('text' | 'brief')[]
}

/**
 * 把补丁合并进任务（**不做合法性判定** —— 判定在 `decideTaskModification`）。
 *
 * 唯一一条"合并侧的语义"：`contentMode` 切换时，若调用方没显式给另一个字段，
 * 就把**不适用**的那个清成 null —— 保持"原文模式只有 text / 生成模式只有 brief"
 * 这条建单不变式，否则库里会出现一条"模式是原文、却还挂着生成要求"的行。
 *
 * ⚠️ 清空了哪些字段必须**记进事件**（`cleared`）：否则审计只能看到"改过"，
 *    看不到"内容形态切换把旧正文清掉了"。
 */
function mergeTaskPatch(
  task: GroupTaskView,
  patch: GroupTaskPatchDraft
): MergedTaskSpec | undefined {
  const media = patch.media ?? task.media
  const textFallback = patch.textFallback ?? task.textFallback
  const mode = patch.contentMode ?? task.content.mode
  let text = 'text' in patch ? patch.text ?? null : task.content.text
  let brief = 'brief' in patch ? patch.brief ?? null : task.content.brief
  const cleared: ('text' | 'brief')[] = []
  if (patch.contentMode !== undefined) {
    if (mode === 'owner_verbatim' && !('brief' in patch) && brief !== null) {
      brief = null
      cleared.push('brief')
    }
    if (mode === 'model_generated' && !('text' in patch) && text !== null) {
      text = null
      cleared.push('text')
    }
  }
  const content: GroupTaskContent = { mode, text, brief }


  const trigger: GroupTaskTrigger = {
    memberIds: patch.memberIds ?? task.trigger.memberIds,
    replyToMessageId: 'replyToMessageId' in patch
      ? patch.replyToMessageId ?? null
      : task.trigger.replyToMessageId,
    categories: patch.categories ?? task.trigger.categories,
    topicScope: 'topicScope' in patch ? patch.topicScope ?? null : task.trigger.topicScope,
  }

  const longTerm = 'longTerm' in patch ? patch.longTerm ?? false : task.term.kind === 'long_term'
  const startAt = patch.startAt ?? task.term.startAt
  const endAt = 'endAt' in patch
    ? patch.endAt ?? null
    : (task.term.kind === 'window' ? task.term.endAt : null)
  let term: GroupTaskTerm
  if (longTerm) term = { kind: 'long_term', startAt }
  else if (endAt !== null) term = { kind: 'window', startAt, endAt }
  else return undefined /* 判定已挡；这里只是"不构造一条自相矛盾的 term" */

  const quota: GroupTaskQuota = {
    totalMaxMessages: patch.totalMaxMessages === undefined ? task.quota.totalMaxMessages : patch.totalMaxMessages,
    perInboundMaxMessages: patch.perInboundMaxMessages ?? task.quota.perInboundMaxMessages,
    slot: 'slot' in patch ? patch.slot ?? null : task.quota.slot,
    minIntervalMs: patch.minIntervalMs ?? task.quota.minIntervalMs,
  }
  return { content, media, textFallback, trigger, term, quota, cleared }
}

export type ModifyGroupTaskResult =
  | { readonly ok: true; readonly task: GroupTaskView }
  | { readonly ok: false; readonly code: string }

/**
 * 修改一条任务（CAS：`where version = expectedVersion`）。
 *
 * ```text
 * 版本不符 ⇒ {ok:false, code:'group_task_version_conflict'}（不写任何东西）
 * 终态不可改 / 补丁自相矛盾 ⇒ 由 `decideTaskModification` 给具名码
 * 成功 ⇒ version+1、updated_at=now、写 `modify` 事件；**used_messages 逐字保留**
 * ```
 * ⚠️ 修改**不**作废旧版本已排队的实例（冻结契约把"旧版本排队结果作废"归调用方：
 *    发送前的 `decideSendAllowance(expectedVersion)` 复核会拒掉旧版本）。
 *    这里擅自作废会让"修改"这条路径多出一个契约没规定的副作用。
 */
export async function modifyGroupTask(
  db: RawDb,
  taskId: string,
  expectedVersion: number,
  patch: GroupTaskPatchDraft,
  now: number
): Promise<ModifyGroupTaskResult> {
  return inTransaction(db, async tx => {
    const rows = await exec(tx, sql`select * from qq_group_tasks where id = ${taskId} for update`,
      '锁定并读取群任务（修改）')
    if (rows.length === 0) return { ok: false as const, code: 'group_task_not_found' }
    const task = taskViewFromRow(rows[0]!)
    const verdict = decideTaskModification({ task, expectedVersion, patch })
    if (!verdict.ok) return { ok: false as const, code: verdict.code }
    const merged = mergeTaskPatch(task, patch)
    if (merged === undefined) return { ok: false as const, code: 'group_task_patch_invalid' }
    const { cleared, ...mergedSpec } = merged
    const prospective: GroupTaskView = {
      ...task,
      ...mergedSpec,
      version: verdict.nextVersion,
      updatedAt: now,
    }
    const problems = taskViewProblems(prospective)
    if (problems.length > 0) return { ok: false as const, code: 'group_task_patch_invalid' }

    const updated = await exec(tx, sql`update qq_group_tasks set
        version = version + 1,
        content = ${JSON.stringify(mergedSpec.content)}::jsonb,
        media = ${mergedSpec.media},
        text_fallback = ${mergedSpec.textFallback},
        trigger = ${JSON.stringify(mergedSpec.trigger)}::jsonb,
        term = ${JSON.stringify(mergedSpec.term)}::jsonb,
        quota = ${JSON.stringify(mergedSpec.quota)}::jsonb,
        updated_at = ${now}
      where id = ${taskId} and version = ${expectedVersion}
      returning *`, '修改群任务（CAS）')
    if (updated.length === 0) {
      /* 持锁后不可达；真到了这里必须**抛**（"写了但没写成"不许正常返回 ⇒ 回滚） */
      throw new KernelError('revision_conflict', 'group_task_version_conflict',
        `群任务 ${taskId} 在持锁后被并发修改（version 期望 ${expectedVersion}）`)
    }
    await appendEvent(tx, {
      taskId, version: verdict.nextVersion, event: 'modify', at: now,
      detail: { expectedVersion, patchKeys: Object.keys(patch).sort(), cleared },
    })
    return { ok: true as const, task: taskViewFromRow(updated[0]!) }
  })
}

// ---------------------------------------------------------------------------
// 状态迁移 / 停止
// ---------------------------------------------------------------------------

export type SetGroupTaskStatusResult =
  | { readonly ok: true; readonly task: GroupTaskView; readonly stopReport?: TaskStopReport; readonly invalidatedQueued: number }
  | { readonly ok: false; readonly code: string }

interface SendStateCounts {
  readonly inFlight: number
  readonly queued: number
  readonly maybeDelivered: number
}

async function readSendStateCounts(db: RawDb, taskId: string): Promise<SendStateCounts> {
  const rows = await exec(db, sql`select state, count(*)::int as n from qq_group_send_instances
    where task_id = ${taskId} group by state`, '统计群任务发送实例状态')
  let inFlight = 0
  let queued = 0
  let maybeDelivered = 0
  for (const row of rows) {
    const count = safeInt(row.n) ?? 0
    const state = String(row.state ?? '')
    if (state === 'in_flight') inFlight += count
    else if (state === 'queued') queued += count
    else if (state === 'api_accepted' || state === 'unknown') maybeDelivered += count
  }
  return { inFlight, queued, maybeDelivered }
}

/**
 * 作废尚未发出的实例（`queued → failed_confirmed`）。
 *
 * ⚠️ 作废**不等于**退额：实例行仍然在 ⇒ 总预算占用不变（ADR-156 §2.8）。
 *    返回作废条数（读数用）。
 */
async function invalidateQueuedInstances(
  db: RawDb,
  taskId: string,
  code: string,
  now: number
): Promise<number> {
  const rows = await exec(db, sql`update qq_group_send_instances
      set state = 'failed_confirmed', settled_at = ${now}
    where task_id = ${taskId} and state = 'queued'
    returning id, task_version`, '作废尚未发出的群发送实例')
  for (const row of rows) {
    await appendEvent(db, {
      taskId,
      version: safeInt(row.task_version) ?? 1,
      event: 'send_settled',
      at: now,
      detail: { instanceId: String(row.id), settlement: 'failed_confirmed', code },
    })
  }
  return rows.length
}

/**
 * 状态迁移（CAS + `decideTaskTransition` + 事件）。
 *
 * ```text
 * 版本不符        ⇒ group_task_version_conflict
 * 目标态===当前态 ⇒ 幂等成功（不写任何东西、不升版本）
 * 迁移非法        ⇒ group_task_transition_invalid（`decideTaskTransition`）
 * 成功            ⇒ version+1 + 事件（pause/resume/stop/expired/exhausted/complete）
 * 终态            ⇒ 顺带作废全部 `queued` 实例（`failed_confirmed`）
 * 停止（revoked） ⇒ 额外返回 `TaskStopReport`（`decideTaskStop` 计算，
 *                   读数取自**写之前**的实例状态：在途/可能已达 如实计数）
 * ```
 * ⚠️ `stop` 只承诺**阻止后续发送**；已发出/结果不明的内容不撤回（`canRevokeDelivered=false`）。
 */
export async function setGroupTaskStatus(
  db: RawDb,
  taskId: string,
  expectedVersion: number,
  toStatus: GroupTaskStatus,
  now: number,
  detail: Record<string, unknown> = {}
): Promise<SetGroupTaskStatusResult> {
  return inTransaction(db, async tx => {
    const rows = await exec(tx, sql`select * from qq_group_tasks where id = ${taskId} for update`,
      '锁定并读取群任务（状态迁移）')
    if (rows.length === 0) return { ok: false as const, code: 'group_task_not_found' }
    const task = taskViewFromRow(rows[0]!)
    if (task.version !== expectedVersion) {
      return { ok: false as const, code: 'group_task_version_conflict' }
    }
    const transition = decideTaskTransition(task.status, toStatus)
    if (!transition.ok) return { ok: false as const, code: transition.code }
    if (toStatus === task.status) {
      return { ok: true as const, task, invalidatedQueued: 0 }
    }

    /* 停止读回必须在**写之前**取：写完之后 `queued` 已经变成 `failed_confirmed` */
    const counts = await readSendStateCounts(tx, taskId)
    const stopReport = toStatus === 'revoked'
      ? decideTaskStop({ inFlightInstances: counts.inFlight, maybeDeliveredInstances: counts.maybeDelivered })
      : undefined
    const nextVersion = task.version + 1
    const updated = await exec(tx, sql`update qq_group_tasks set
        status = ${toStatus},
        version = ${nextVersion},
        updated_at = ${now},
        revoked_at = case when ${toStatus} = 'revoked' then ${now} else revoked_at end
      where id = ${taskId} and version = ${expectedVersion}
      returning *`, '迁移群任务状态（CAS）')
    if (updated.length === 0) {
      throw new KernelError('revision_conflict', 'group_task_version_conflict',
        `群任务 ${taskId} 在持锁后被并发修改（version 期望 ${expectedVersion}）`)
    }
    await appendEvent(tx, {
      taskId, version: nextVersion, event: eventForStatus(toStatus), at: now,
      detail: { fromStatus: task.status, toStatus, ...detail },
    })
    let invalidatedQueued = 0
    if (isTerminalGroupTaskStatus(toStatus)) {
      invalidatedQueued = await invalidateQueuedInstances(
        tx, taskId, toStatus === 'revoked' ? 'task_stopped' : 'task_terminal', now)
    }
    return {
      ok: true as const,
      task: taskViewFromRow(updated[0]!),
      invalidatedQueued,
      ...(stopReport === undefined ? {} : { stopReport }),
    }
  })
}

// ---------------------------------------------------------------------------
// 额度预留（原子）
// ---------------------------------------------------------------------------

export interface ReserveGroupSendInput {
  readonly taskId: string
  readonly now: number
  /** 本侧认定的目标（装配层从绑定取的**真实**目标）；与任务不一致 ⇒ 拒 */
  readonly target: GroupTaskTarget
  /** `null`/缺省 = 首次预留；数字 = 发送前复核（版本变了 ⇒ `group_task_version_changed`） */
  readonly expectedVersion?: number | null
  /** 本次要占用的**对外消息数**（1..3；最坏情形由 `worstCaseOutgoingMessages` 算好） */
  readonly plannedMessages: number
  readonly plannedMedia: GroupTaskMedia
  /** 这条入站消息的 id（per-inbound 额度按它算；`null` = 不是回复某条入站） */
  readonly inboundMessageId?: string | null
  readonly textFingerprint?: string | null
}

export type ReserveGroupSendResult =
  | { readonly kind: 'granted'; readonly instance: GroupSendInstanceView }
  | { readonly kind: 'denied'; readonly code: GroupSendDenialCode | 'group_task_not_found' }

interface SendOccupancy {
  readonly total: number
  readonly slot: number
  readonly perInbound: number
}

/**
 * 该任务**已消耗的额度**（按实例账本，不按 `used_messages` 列 —— 见文件头的口径）。
 *
 * ```text
 * total       = 全部实例的 reserved_messages 之和（没有退还路径）
 * slot        = 落在"当前时间段窗口"内的那部分（无 slot ⇒ 0，调用方不用）
 * perInbound  = 同一 inbound_message_id 的实例之和（用于 per-inbound 上限）
 * ```
 */
async function readSendOccupancy(
  db: RawDb,
  task: GroupTaskView,
  now: number,
  inboundMessageId: string | null
): Promise<SendOccupancy> {
  const slot = task.quota.slot
  const slotCondition = slot === null ? sql`true` : sql`created_at >= ${now - slot.windowMs}`
  const rows = await exec(db, sql`select inbound_message_id as inbound,
      coalesce(sum(reserved_messages), 0)::int as reserved,
      coalesce(sum(reserved_messages) filter (where ${slotCondition}), 0)::int as slot_reserved
    from qq_group_send_instances where task_id = ${task.id}
    group by inbound_message_id`, '统计群任务已消耗额度')
  let total = 0
  let slotUsed = 0
  let perInbound = 0
  for (const row of rows) {
    const reserved = safeInt(row.reserved) ?? 0
    total += reserved
    slotUsed += safeInt(row.slot_reserved) ?? 0
    if (inboundMessageId !== null && row.inbound === inboundMessageId) perInbound += reserved
  }
  return { total, slot: slot === null ? 0 : slotUsed, perInbound }
}

/**
 * **原子**占用一次发送额度。
 *
 * ```text
 * 单事务：select … for update 锁任务行
 *      → 读额度（实例账本）→ decideSendAllowance 判定
 *      → 写 `queued` 实例 + send_reserved 事件
 * ```
 * ⚠️ 并发两个事件抢**最后一条**额度只能一个 granted：第二个事务在行锁上等待，
 *    拿到锁后重读账本才会看到第一条实例 —— 这是"先查再写"做不到的事。
 * ⚠️ 被拒是**正常返回**（`{kind:'denied', code}`）：它没有写任何东西。
 */
export async function reserveGroupSend(
  db: RawDb,
  input: ReserveGroupSendInput
): Promise<ReserveGroupSendResult> {
  const inboundMessageId = input.inboundMessageId ?? null
  const textFingerprint = input.textFingerprint ?? null
  return inTransaction(db, async tx => {
    const rows = await exec(tx, sql`select * from qq_group_tasks where id = ${input.taskId} for update`,
      '锁定并读取群任务（额度预留）')
    if (rows.length === 0) return { kind: 'denied' as const, code: 'group_task_not_found' }
    const task = taskViewFromRow(rows[0]!)
    const occupancy = await readSendOccupancy(tx, task, input.now, inboundMessageId)
    const decision = decideSendAllowance({
      task,
      now: input.now,
      target: input.target,
      expectedVersion: input.expectedVersion ?? null,
      plannedMessages: input.plannedMessages,
      plannedMedia: input.plannedMedia,
      usage: {
        totalMessages: occupancy.total,
        slotMessages: occupancy.slot,
        perInboundMessages: occupancy.perInbound,
        lastSendAt: task.lastSendAt,
      },
    })
    if (decision.kind === 'denied') return decision

    const instanceId = `qgsi:${randomUUID()}`
    await exec(tx, sql`insert into qq_group_send_instances
        (id, task_id, task_version, state, reserved_messages, media, group_id, bot_id,
         inbound_message_id, text_fingerprint, platform_message_id, created_at, settled_at)
      values (${instanceId}, ${task.id}, ${decision.taskVersion}, 'queued', ${decision.reservedMessages},
              ${input.plannedMedia}, ${task.target.groupId}, ${task.target.botId},
              ${inboundMessageId}, ${textFingerprint}, null, ${input.now}, null)`, '占用群发送额度')
    await appendEvent(tx, {
      taskId: task.id, version: decision.taskVersion, event: 'send_reserved', at: input.now,
      detail: {
        instanceId, reservedMessages: decision.reservedMessages, media: input.plannedMedia,
        inboundMessageId, usageTotal: occupancy.total, usageSlot: occupancy.slot,
        usagePerInbound: occupancy.perInbound,
      },
    })
    const created = await exec(tx, sql`select * from qq_group_send_instances where id = ${instanceId} limit 1`,
      '读回刚占用的群发送实例')
    if (created.length === 0) {
      throw new KernelError('persistence_error', 'group_send_instance_readback_missing',
        '刚占用的发送实例读不回来（不猜，如实失败并回滚）')
    }
    return { kind: 'granted' as const, instance: sendInstanceViewFromRow(created[0]!) }
  })
}

/**
 * **发送前复核**用的额度读数：把"这一次预留自己"从账本里**排除**掉。
 *
 * ```text
 * 预留（reserveGroupSend）  : 自己还没进账本 ⇒ 账本里的数就是"别人的"
 * 发送前复核（本函数）      : 自己**已经在**账本里 ⇒ 必须先剔除，否则自己会把自己算两遍
 * ```
 *
 * ⚠️ 为什么不能直接用 `task.usedMessages`：那一列只累计 `api_accepted`/`unknown`
 *    的**已结算**条数 ⇒ 在途/已明确失败的其它实例**一条都不算**。复核要回答的
 *    恰恰是"把这一条也算上之后还超不超额度"，所以必须用实例账本（
 *    `reserved_messages` 之和，**没有退还路径**）再剔除自己。
 * ⚠️ 这不是原子预留（预留那一步才是）：这里只读一次账本给"最后一刻"的判定用；
 *    真正防并发越额的是 `reserveGroupSend` 的行锁事务。
 * ⚠️ 找不到自己 ⇒ **失败关闭**（`group_send_instance_not_found`）：宁可拒发，
 *    也不用一个来路不明的账本去放行。
 */
export interface SendOccupancyForRecheck {
  /** 除自己以外的实例已占用条数（含在途 / 已结算 / 已明确失败） */
  readonly totalMessages: number
  /** 除自己以外、落在当前时间窗内的占用（无 slot ⇒ 0） */
  readonly slotMessages: number
  /** 除自己以外、与**自己这条**同 inbound 的占用（自己不是回复某条入站 ⇒ 0） */
  readonly perInboundMessages: number
  /** 自己这条实例（调用方用它取 `reservedMessages` 作为本次 planned） */
  readonly current: GroupSendInstanceView
}

export type ReadSendOccupancyForRecheckResult =
  | { readonly ok: true; readonly occupancy: SendOccupancyForRecheck }
  | { readonly ok: false; readonly code: 'group_send_instance_not_found' }

export async function readSendOccupancyForRecheck(
  db: RawDb,
  input: { readonly task: GroupTaskView; readonly instanceId: string; readonly now: number }
): Promise<ReadSendOccupancyForRecheckResult> {
  const instances = await listGroupSendInstances(db, input.task.id)
  const current = instances.find(instance => instance.id === input.instanceId)
  if (current === undefined) return { ok: false, code: 'group_send_instance_not_found' }
  const others = instances.filter(instance => instance.id !== input.instanceId)
  const slot = input.task.quota.slot
  let totalMessages = 0
  let slotMessages = 0
  let perInboundMessages = 0
  for (const instance of others) {
    totalMessages += instance.reservedMessages
    if (slot !== null && instance.createdAt >= input.now - slot.windowMs) {
      slotMessages += instance.reservedMessages
    }
    if (current.inboundMessageId !== null && instance.inboundMessageId === current.inboundMessageId) {
      perInboundMessages += instance.reservedMessages
    }
  }
  return {
    ok: true,
    occupancy: { totalMessages, slotMessages, perInboundMessages, current },
  }
}

export type MarkGroupSendInFlightResult =
  | { readonly ok: true; readonly instance: GroupSendInstanceView }
  | { readonly ok: false; readonly code: string; readonly instance?: GroupSendInstanceView }
/**
 * 标记一次发送**已发出网络请求**（`queued → in_flight`，CAS `where state = 'queued'`）。
 *
 * ⚠️ 调用顺序是硬要求：**发出网络请求之前**先调它落盘。等请求回来才写，
 *    进程在请求期间被杀就分不清"从未发出"与"可能已发出"（本仓库 `f2` 那批的教训：
 *    账本要即时落盘，不能事后补）。恢复逻辑 `recoverGroupSendStateOnRestart` 据此把
 *    `in_flight → unknown`、`queued → failed_confirmed`。
 *
 * ⚠️ **幂等**：重复调用**不抛错**，返回 `{ok:false, code:'group_send_already_in_flight'}`
 *    （调用方据此知道"已经有一方在发"，不是"我这条坏了"）。
 *    只有从 `queued` 出发的第一次调用会成功（CAS）；其它状态返回具名拒绝。
 *
 * ⚠️ `at` 只为调用方的账本顺序而接受：实例表**没有** `in_flight` 的转移时刻列
 *    （task-1 的 DDL 只有 `created_at` / `settled_at`，`in_flight` 两者都不是），
 *    因此这里**不伪造**一个时间戳落库 —— 宁可少一列，不写一个假时刻。
 */
export async function markGroupSendInFlight(
  db: RawDb,
  instanceId: string,
  at: number = Date.now()
): Promise<MarkGroupSendInFlightResult> {
  void at /* 见上：没有可落盘的转移时刻列；显式吞掉而不是假装用上了 */
  return inTransaction(db, async tx => {
    const locked = await exec(tx, sql`select * from qq_group_send_instances where id = ${instanceId} for update`,
      '锁定并读取群发送实例（进入在途）')
    if (locked.length === 0) return { ok: false as const, code: 'group_send_instance_not_found' }
    const instance = sendInstanceViewFromRow(locked[0]!)
    if (instance.state === 'in_flight') {
      return { ok: false as const, code: 'group_send_already_in_flight', instance }
    }
    if (instance.state !== 'queued') return { ok: false as const, code: 'group_send_not_queued' }
    const updated = await exec(tx, sql`update qq_group_send_instances set state = 'in_flight'
      where id = ${instanceId} and state = 'queued' returning *`, '标记群发送实例在途')
    if (updated.length === 0) {
      /* 持锁后不可达；真到了这里必须**抛**（CAS 没写成不许正常返回） */
      throw new KernelError('revision_conflict', 'group_send_concurrent_update',
        `群发送实例 ${instanceId} 在持锁后被并发修改`)
    }
    return { ok: true as const, instance: sendInstanceViewFromRow(updated[0]!) }
  })
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

export interface SettleGroupSendOptions {
  /** `api_accepted` 必填（平台接受却不知道是哪条 ⇒ 不可审计） */
  readonly platformMessageId?: string | null
  readonly at?: number
  readonly detail?: Record<string, unknown>
}

export type SettleGroupSendResult =
  | {
    readonly ok: true
    readonly instance: GroupSendInstanceView
    readonly task: GroupTaskView
    /** `true` = 同结局重复上报（幂等命中，没有第二次写） */
    readonly alreadySettled: boolean
    readonly usedMessagesAdded: number
    readonly paused: boolean
    readonly exhausted: boolean
  }
  | { readonly ok: false; readonly code: string }

/**
 * 结算一次发送（**幂等**）。
 *
 * ```text
 * api_accepted     used_messages += reserved；记录 platform_message_id
 * failed_confirmed used_messages 不变，但**不退额**（总预算占用仍含这条实例）
 * unknown          used_messages += reserved（保守）→ `decideTaskAfterSendSettlement`
 *                  ⇒ 任务 `paused`（结果不明绝不重播）
 * 任一同结局重报   ⇒ 幂等成功（alreadySettled=true），不再加账、不再写事件
 * 已有别的终态     ⇒ group_send_already_settled（不覆盖已定案的事实）
 * ```
 * ⚠️ 持锁顺序与预留一致（任务行 → 实例行），避免与 `reserveGroupSend` 交叉。
 */
export async function settleGroupSend(
  db: RawDb,
  instanceId: string,
  settlement: GroupSendState,
  options: SettleGroupSendOptions = {}
): Promise<SettleGroupSendResult> {
  const platformMessageId = options.platformMessageId ?? null
  const at = options.at ?? Date.now()
  return inTransaction(db, async tx => {
    const locating = await exec(tx, sql`select task_id from qq_group_send_instances where id = ${instanceId} limit 1`,
      '定位群发送实例所属任务')
    if (locating.length === 0) return { ok: false as const, code: 'group_send_instance_not_found' }
    const taskId = String(locating[0]!.task_id)
    const taskRows = await exec(tx, sql`select * from qq_group_tasks where id = ${taskId} for update`,
      '锁定并读取群任务（结算）')
    if (taskRows.length === 0) return { ok: false as const, code: 'group_task_not_found' }
    const task = taskViewFromRow(taskRows[0]!)
    const instRows = await exec(tx, sql`select * from qq_group_send_instances where id = ${instanceId} for update`,
      '锁定并读取群发送实例（结算）')
    if (instRows.length === 0) return { ok: false as const, code: 'group_send_instance_not_found' }
    const instance = sendInstanceViewFromRow(instRows[0]!)

    if (instance.state === settlement) {
      return {
        ok: true as const, instance, task, alreadySettled: true,
        usedMessagesAdded: 0, paused: false, exhausted: false,
      }
    }
    if (GROUP_SEND_TERMINAL_STATES.includes(instance.state)) {
      return { ok: false as const, code: 'group_send_already_settled' }
    }
    if (settlement === 'queued' || settlement === 'in_flight') {
      return { ok: false as const, code: 'group_send_settlement_invalid' }
    }
    if (settlement === 'api_accepted'
      && (platformMessageId === null || platformMessageId.trim() === '')) {
      return { ok: false as const, code: 'group_send_accepted_without_message_id' }
    }

    const usedMessagesAdded = (settlement === 'api_accepted' || settlement === 'unknown')
      ? instance.reservedMessages : 0
    const usedMessages = task.usedMessages + usedMessagesAdded
    const after = decideTaskAfterSendSettlement({ task, usedMessages, settlement })
    const nextStatus: GroupTaskStatus = isTerminalGroupTaskStatus(task.status)
      ? task.status
      : after.markExhausted
        ? 'exhausted'
        : after.pauseTask && task.status !== 'paused'
          ? 'paused'
          : task.status
    const statusChanged = nextStatus !== task.status
    const nextVersion = task.version + (statusChanged ? 1 : 0)

    const updatedInstance = await exec(tx, sql`update qq_group_send_instances set
        state = ${settlement},
        platform_message_id = coalesce(${platformMessageId}, platform_message_id),
        settled_at = ${at}
      where id = ${instanceId} and state = ${instance.state}
      returning *`, '结算群发送实例')
    if (updatedInstance.length === 0) {
      throw new KernelError('revision_conflict', 'group_send_concurrent_update',
        `群发送实例 ${instanceId} 在持锁后被并发修改`)
    }
    const updatedTask = await exec(tx, sql`update qq_group_tasks set
        used_messages = ${usedMessages},
        last_send_at = ${settlement === 'api_accepted' || settlement === 'unknown'
          ? at : task.lastSendAt},
        status = ${nextStatus},
        version = ${nextVersion},
        updated_at = ${at}
      where id = ${taskId} and version = ${task.version}
      returning *`, '结算群任务账目')
    if (updatedTask.length === 0) {
      throw new KernelError('revision_conflict', 'group_task_version_conflict',
        `群任务 ${taskId} 在持锁后被并发修改（结算）`)
    }
    await appendEvent(tx, {
      taskId, version: nextVersion, event: 'send_settled', at,
      detail: {
        instanceId, settlement, reservedMessages: instance.reservedMessages,
        usedMessages, ...(after.code === undefined ? {} : { code: after.code }),
        ...(options.detail ?? {}),
      },
    })
    if (statusChanged) {
      await appendEvent(tx, {
        taskId, version: nextVersion, event: eventForStatus(nextStatus), at,
        detail: {
          fromStatus: task.status, toStatus: nextStatus, cause: 'send_settlement',
          ...(after.code === undefined ? {} : { code: after.code }),
        },
      })
    }
    return {
      ok: true as const,
      instance: sendInstanceViewFromRow(updatedInstance[0]!),
      task: taskViewFromRow(updatedTask[0]!),
      alreadySettled: false,
      usedMessagesAdded,
      paused: statusChanged && nextStatus === 'paused',
      exhausted: statusChanged && nextStatus === 'exhausted',
    }
  })
}

// ---------------------------------------------------------------------------
// 重启恢复
// ---------------------------------------------------------------------------

/** 重启恢复的读数（数字都是**实际改了几行**，不是估算） */
export interface GroupSendRecoveryReport {
  readonly at: number
  /** 有多少条任务被真的动过（孤立实例的任务不计） */
  readonly tasksTouched: number
  /** `in_flight → unknown` 的条数 */
  readonly inFlightToUnknown: number
  /** `queued → failed_confirmed` 的条数 */
  readonly queuedToFailedConfirmed: number
  /** 因 `unknown` 而保守计入 `used_messages` 的对外消息数 */
  readonly usedMessagesAdded: number
  /** 被暂停的任务数（结果不明绝不继续发） */
  readonly tasksPaused: number
  /** 恒为 0：本函数**不发送任何东西**（`unknown` 永不重播） */
  readonly replayed: 0
}

/**
 * 启动时恢复发送状态（**不重播**）。
 *
 * ```text
 * in_flight → unknown         （已发出、结局不明 ⇒ 保守占用额度 + 暂停任务）
 * queued    → failed_confirmed（从未发出 ⇒ 作废；不退额）
 * ```
 * 状态迁移本身来自冻结契约的 `recoverSendStateOnRestart`（本层不复制那张表）。
 *
 * ⚠️ 恢复**不**发送任何东西（`replayed: 0`），`unknown` **永不**重播。
 * ⚠️ 孤立实例（任务行不存在）**跳过**而不是猜归属：那属于数据损坏，
 *    猜一个任务去暂停等于替主人做了一个没发生过的决定。
 */
export async function recoverGroupSendStateOnRestart(
  db: RawDb,
  now: number = Date.now()
): Promise<GroupSendRecoveryReport> {
  return inTransaction(db, async tx => {
    const openRows = await exec(tx, sql`select * from qq_group_send_instances
      where state in ('queued', 'in_flight') order by task_id asc, created_at asc, id asc`,
      '读取重启时仍在途的群发送实例')
    let inFlightToUnknown = 0
    let queuedToFailedConfirmed = 0
    let usedMessagesAdded = 0
    let tasksPaused = 0
    let tasksTouched = 0

    const byTask = new Map<string, Record<string, unknown>[]>()
    for (const row of openRows) {
      const taskId = String(row.task_id ?? '')
      if (taskId === '') continue
      const bucket = byTask.get(taskId)
      if (bucket === undefined) byTask.set(taskId, [row])
      else bucket.push(row)
    }

    for (const [taskId, rows] of byTask) {
      const taskRows = await exec(tx, sql`select * from qq_group_tasks where id = ${taskId} for update`,
        '锁定并读取群任务（重启恢复）')
      if (taskRows.length === 0) {
        /* 孤立实例：不猜归属、不改状态（留给数据修复，不由恢复逻辑编一个任务出来） */
        continue
      }
      const task = taskViewFromRow(taskRows[0]!)
      tasksTouched += 1
      let taskUsedAdd = 0
      let sawUnknown = false
      for (const row of rows) {
        const instance = sendInstanceViewFromRow(row)
        const next = recoverSendStateOnRestart(instance.state)
        if (next === instance.state) continue
        const updated = await exec(tx, sql`update qq_group_send_instances
            set state = ${next}, settled_at = ${now}
          where id = ${instance.id} and state = ${instance.state}
          returning id`, '重启恢复群发送实例状态')
        if (updated.length === 0) {
          throw new KernelError('revision_conflict', 'group_send_concurrent_update',
            `群发送实例 ${instance.id} 在持锁后被并发修改（重启恢复）`)
        }
        if (next === 'unknown') {
          inFlightToUnknown += 1
          taskUsedAdd += instance.reservedMessages
          sawUnknown = true
        } else {
          queuedToFailedConfirmed += 1
        }
        await appendEvent(tx, {
          taskId, version: task.version, event: 'send_settled', at: now,
          detail: {
            instanceId: instance.id, settlement: next, recoveredFrom: instance.state,
            code: next === 'unknown'
              ? 'process_restarted_before_receipt'
              : 'process_restarted_before_send',
          },
        })
      }
      if (sawUnknown) {
        const usedMessages = task.usedMessages + taskUsedAdd
        const canPause = !isTerminalGroupTaskStatus(task.status) && task.status !== 'paused'
        const nextStatus: GroupTaskStatus = canPause ? 'paused' : task.status
        const nextVersion = task.version + (canPause ? 1 : 0)
        const updatedTask = await exec(tx, sql`update qq_group_tasks set
            used_messages = ${usedMessages},
            last_send_at = ${now},
            status = ${nextStatus},
            version = ${nextVersion},
            updated_at = ${now}
          where id = ${taskId} and version = ${task.version}
          returning *`, '重启恢复群任务账目')
        if (updatedTask.length === 0) {
          throw new KernelError('revision_conflict', 'group_task_version_conflict',
            `群任务 ${taskId} 在持锁后被并发修改（重启恢复）`)
        }
        usedMessagesAdded += taskUsedAdd
        if (canPause) {
          tasksPaused += 1
          await appendEvent(tx, {
            taskId, version: nextVersion, event: 'pause', at: now,
            detail: {
              fromStatus: task.status, toStatus: 'paused',
              code: 'group_send_result_unknown', cause: 'process_restart',
            },
          })
        }
      }
    }

    return {
      at: now,
      tasksTouched,
      inFlightToUnknown,
      queuedToFailedConfirmed,
      usedMessagesAdded,
      tasksPaused,
      replayed: 0 as const,
    }
  })
}
