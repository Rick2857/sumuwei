/**
 * 通知意图 / 通知实例的**持久化**（post-Lv2 / QQ 主动联系 · ADR-110 `D07`/`D08`）。
 *
 * ============================================================================
 *  它是什么 / 不是什么
 * ============================================================================
 * ```text
 * 是   —— 两张新表（迁移 0014）的**唯一**读写口：意图登记、实例占用、状态推进、额度统计
 * 不是 —— 不是调度器（Croner 提供时间触发）、不是决策器（WP4）、不是投递器（WP5）
 * ```
 * ⚠️ 发送幂等靠 `notification_occurrences.occurrence_key` 的**主键**：
 *    `reserveOccurrence()` 是"插入成功才算占用"的**唯一**入口，
 *    重复调用同键 ⇒ `created: false`（**不**报错、**不**重发）。
 *    这里**不**用内存 `Set`、**不**用随机 requestId（`ADR-110` `D07` 逐字）。
 *
 * ⚠️ 正文（`candidate_text`）只在这两张表里；它的**指纹与长度**才是给账本/trace 看的东西
 *    （`D09`：正文不进 `ActionRequest.arguments`、不进账本、不进 trace）。
 */
import { sql } from 'drizzle-orm'

import {
  KernelError,
  assertOccurrenceTransition,
  buildNotificationCandidate,
  canTransitionOccurrence,
  isTerminalOccurrenceState,
  stateForOrphanedDispatching,
  type CharacterId,
  type NotificationIntentId,
  type NotificationIntentStatus,
  type NotificationKind,
  type NotificationOccurrenceState,
  type Timestamp,
} from '../../kernel/contracts/index.ts'
import { affectedRows, asRows, exec, firstRow, type RawDb } from './db.ts'
import type { ChatChannel } from '../../kernel/contracts/chat-channel.ts'
import type { RelayMetadata } from '../../kernel/app/relay-turn.ts'

const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

export interface NotificationIntentRecord {
  relayMetadata?: RelayMetadata
  id: NotificationIntentId
  characterId: CharacterId
  ownerRef: string
  conversationRef: string
  deliveryChannel: ChatChannel
  /*
   * ★ S3 ③（ADR-129 D05）：重复模式 —— `'once' | 'until_reply'`。
   *   缺省 `undefined` = **旧行/旧行为**（只发一次）；驱动按它决定要不要续发。
   */
  repeatMode?: string
  kind: NotificationKind
  status: NotificationIntentStatus
  sourceRefs: readonly string[]
  scheduledAt: Timestamp
  timezone: string
  planVersion: number
  permissionVersion: string
  policyVersion: string
  /** 有界的提醒内容（只有 `reminder` 有；关心为 `undefined`） */
  text?: string
  textFingerprint?: string
  dedupeKey: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface NotificationOccurrenceRecord {
  occurrenceKey: string
  /** 只有 `reminder` 的实例挂意图；关心的实例由机会键锚定 */
  intentId?: NotificationIntentId
  characterId: CharacterId
  kind: NotificationKind
  state: NotificationOccurrenceState
  dueAt: Timestamp
  attempt: number
  candidateText?: string
  candidateFingerprint?: string
  candidateLength?: number
  assistantEventId?: string
  platformMessageId?: string
  reasonCode?: string
  permissionVersion: string
  policyVersion: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface IntentRow {
  relay_metadata?: RelayMetadata | null
  id: string
  character_id: string
  owner_ref: string
  conversation_ref: string
  delivery_channel: ChatChannel
  /* ★ S3 ③（缺口 A）：读映射也要有它 —— 否则驱动读到的永远是 undefined（"写了但读不回"） */
  repeat_mode: string | null
  kind: string
  status: string
  source_refs: unknown
  has_source: boolean
  scheduled_at: number
  timezone: string
  plan_version: number
  permission_version: string
  policy_version: string
  text: string | null
  text_fingerprint: string | null
  dedupe_key: string
  created_at: number
  updated_at: number
}

interface OccurrenceRow {
  occurrence_key: string
  intent_id: string | null
  character_id: string
  kind: string
  state: string
  due_at: number
  attempt: number
  candidate_text: string | null
  candidate_fingerprint: string | null
  candidate_length: number | null
  assistant_event_id: string | null
  platform_message_id: string | null
  reason_code: string | null
  permission_version: string
  policy_version: string
  created_at: number
  updated_at: number
}

function sourceRefsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry))
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : []
    } catch {
      return []
    }
  }
  return []
}

function rowToIntent(row: IntentRow | undefined): NotificationIntentRecord | undefined {
  if (!row) return undefined
  return {
    ...(row.relay_metadata ? { relayMetadata: row.relay_metadata } : {}),
    id: row.id as NotificationIntentId,
    characterId: row.character_id as CharacterId,
    ownerRef: String(row.owner_ref),
    conversationRef: String(row.conversation_ref),
    deliveryChannel: row.delivery_channel,
    /* ★ S3 ③（缺口 A）：只在有值时给（缺省不出现 = 旧行为）；'once' 与 'until_reply' 都如实带出 */
    ...(row.repeat_mode === null ? {} : { repeatMode: String(row.repeat_mode) }),
    kind: String(row.kind) as NotificationKind,
    status: String(row.status) as NotificationIntentStatus,
    sourceRefs: sourceRefsOf(row.source_refs),
    scheduledAt: Number(row.scheduled_at),
    timezone: String(row.timezone),
    planVersion: Number(row.plan_version),
    permissionVersion: String(row.permission_version),
    policyVersion: String(row.policy_version),
    ...(row.text === null ? {} : { text: String(row.text) }),
    ...(row.text_fingerprint === null ? {} : { textFingerprint: String(row.text_fingerprint) }),
    dedupeKey: String(row.dedupe_key),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function rowToOccurrence(row: OccurrenceRow | undefined): NotificationOccurrenceRecord | undefined {
  if (!row) return undefined
  return {
    occurrenceKey: String(row.occurrence_key),
    ...(row.intent_id === null ? {} : { intentId: row.intent_id as NotificationIntentId }),
    characterId: row.character_id as CharacterId,
    kind: String(row.kind) as NotificationKind,
    state: String(row.state) as NotificationOccurrenceState,
    dueAt: Number(row.due_at),
    attempt: Number(row.attempt),
    ...(row.candidate_text === null ? {} : { candidateText: String(row.candidate_text) }),
    ...(row.candidate_fingerprint === null ? {} : { candidateFingerprint: String(row.candidate_fingerprint) }),
    ...(row.candidate_length === null ? {} : { candidateLength: Number(row.candidate_length) }),
    ...(row.assistant_event_id === null ? {} : { assistantEventId: String(row.assistant_event_id) }),
    ...(row.platform_message_id === null ? {} : { platformMessageId: String(row.platform_message_id) }),
    ...(row.reason_code === null ? {} : { reasonCode: String(row.reason_code) }),
    permissionVersion: String(row.permission_version),
    policyVersion: String(row.policy_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

// ---------------------------------------------------------------------------
// 意图
// ---------------------------------------------------------------------------

export interface CreateIntentInput {
  relayMetadata?: RelayMetadata
  id: NotificationIntentId
  characterId: CharacterId
  ownerRef: string
  conversationRef: string
  deliveryChannel?: ChatChannel
  kind: NotificationKind
  sourceRefs?: readonly string[]
  scheduledAt: Timestamp
  timezone: string
  planVersion?: number
  permissionVersion: string
  policyVersion: string
  /** `reminder` **必须**给（有界、已校验的提醒内容）；`care` **不许**给 */
  text?: string
  dedupeKey: string
  /*
   * ★ S3 ③（ADR-129 D05/D07）：重复模式 —— `'once' | 'until_reply'`。
   *   缺省 `null` = **旧行为**（只发一次）；`'until_reply'` 由调度器在投递后按
   *   `decideReminderRepeat()`（冻结纯函数）续发，**跨重启靠这一列**。
   */
  repeatMode?: string | null
  now?: Timestamp
}

/**
 * 登记一条通知意图。
 *
 * ⚠️ 返回 `created: false` 表示**同 `dedupeKey` 已有一条 `pending` 意图**
 *    （部分唯一索引 `notification_intents_active_dedupe` 挡下的）——
 *    那**不是**失败：它正是"同一件事不许排两次"的机器形态。
 *    调用方据此如实回"已经设过了"，而**不**再排一条。
 */
export async function createIntent(
  db: RawDb,
  input: CreateIntentInput
): Promise<{ intent: NotificationIntentRecord | undefined; created: boolean }> {
  const kind = input.kind
  const isReminder = kind !== 'care'
  if (kind === 'relay' && (!input.relayMetadata || input.deliveryChannel !== 'qq_private'
    || (input.repeatMode != null && input.repeatMode !== 'once'))) {
    throw new KernelError('validation_error', 'relay_binding_invalid', '转告必须有来源身份、仅QQ私聊、只投递一次')
  }
  if (isReminder && (input.text === undefined || input.text.trim() === '')) {
    throw new KernelError(
      'validation_error',
      'notification_reminder_without_text',
      '明确提醒必须有已校验的内容（不许"设了一个空提醒"）'
    )
  }
  if (!isReminder && input.text !== undefined) {
    throw new KernelError(
      'validation_error',
      'notification_care_with_text',
      '自主关心的意图**不**保存正文（候选正文只活在实例行上）'
    )
  }
  const sourceRefs = [...(input.sourceRefs ?? [])]
  if (isReminder && sourceRefs.length === 0) {
    throw new KernelError(
      'validation_error',
      'notification_reminder_without_source',
      '明确提醒必须有**原请求来源**（否则无法回答"这条提醒是凭什么设的"）'
    )
  }
  if (!isReminder && sourceRefs.length > 0) {
    throw new KernelError(
      'validation_error',
      'notification_care_with_source',
      '自主关心**没有**用户请求来源；带来源的必须走提醒那条路'
    )
  }
  const candidate = isReminder ? buildNotificationCandidate(input.text!) : undefined
  const now = input.now ?? Date.now()

  const rows = await exec(
    db,
    sql`insert into notification_intents
          (id, character_id, owner_ref, conversation_ref, kind, status, source_refs, has_source,
           scheduled_at, timezone, plan_version, permission_version, policy_version,
           text, text_fingerprint, dedupe_key, created_at, updated_at, schema_version, delivery_channel, repeat_mode, relay_metadata)
        values (${String(input.id)}, ${String(input.characterId)}, ${input.ownerRef},
                ${input.conversationRef}, ${kind}, 'pending',
                ${JSON.stringify(sourceRefs)}::jsonb, ${sourceRefs.length > 0},
                ${input.scheduledAt}, ${input.timezone}, ${input.planVersion ?? 1},
                ${input.permissionVersion}, ${input.policyVersion},
                ${candidate?.text ?? null}, ${candidate?.fingerprint ?? null},
                ${input.dedupeKey}, ${now}, ${now}, ${SCHEMA_VERSION}, ${input.deliveryChannel ?? 'qq_private'}, ${input.repeatMode ?? null},
                ${input.relayMetadata ? JSON.stringify(input.relayMetadata) : null}::jsonb)
        ${kind === 'relay' ? sql`on conflict do nothing` : sql`on conflict (dedupe_key) where status = 'pending' do nothing`}
        returning *`,
    '登记通知意图'
  )

  const created = rows.length > 0
  const intent = rowToIntent(firstRow<IntentRow>(rows))
  if (intent !== undefined) return { intent, created }
  /* 撞上部分唯一索引 ⇒ 读回那条既有的 pending 意图（如实：是它挡住了） */
  const existing = await findIntentByDedupeKey(db, input.dedupeKey)
  return { intent: existing, created: false }
}

export async function getIntent(
  db: RawDb,
  id: NotificationIntentId
): Promise<NotificationIntentRecord | undefined> {
  const rows = await exec(
    db,
    sql`select * from notification_intents where id = ${String(id)} limit 1`,
    '读取通知意图'
  )
  return rowToIntent(firstRow<IntentRow>(rows))
}

export async function findIntentByDedupeKey(
  db: RawDb,
  dedupeKey: string
): Promise<NotificationIntentRecord | undefined> {
  const rows = await exec(
    db,
    sql`select * from notification_intents
        where dedupe_key = ${dedupeKey} and (status = 'pending' or kind = 'relay')
        order by created_at desc limit 1`,
    '按去重键读取通知意图'
  )
  return rowToIntent(firstRow<IntentRow>(rows))
}

/** 待办提醒列表（按排期升序）—— 计划 §8 WP3 的"首版最多 20 个待办"用它数 */
export async function listPendingIntents(
  db: RawDb,
  characterId: CharacterId,
  options: { kind?: NotificationKind; limit?: number; ownerRef?: string; conversationRef?: string; editable?: boolean } = {}
): Promise<NotificationIntentRecord[]> {
  const rows = await exec(
    db,
    sql`select * from notification_intents
        where character_id = ${String(characterId)} and status = 'pending'
          ${options.kind === undefined ? sql`` : sql`and kind = ${options.kind}`}
          ${options.ownerRef === undefined ? sql`` : sql`and owner_ref = ${options.ownerRef}`}
          ${options.conversationRef === undefined ? sql`` : sql`and conversation_ref = ${options.conversationRef}`}
          ${options.editable !== true ? sql`` : sql`and not exists (select 1 from notification_occurrences o where o.intent_id = notification_intents.id and o.state <> 'cancelled')`}
        order by scheduled_at asc
        limit ${Math.max(1, Math.min(500, options.limit ?? 50))}`,
    '列出待办通知意图'
  )
  return asRows<IntentRow>(rows).map((row) => rowToIntent(row)!)
}

/** Bounded read view for the current reminder conversation; never writes chat history. */
export async function recentReminderDeliveries(db: RawDb, input: {
  characterId: CharacterId; ownerRef: string; conversationRef: string; channel: ChatChannel
  now: number; withdrawnEventIds: readonly string[]
}): Promise<{ occurrenceKey: string; state: string; text: string; at: number; stoppedByMessage: boolean }[]> {
  const rows = await exec(db, sql`select o.occurrence_key, o.state, o.candidate_text, o.updated_at,
      i.repeat_mode, exists (select 1 from conversation_events e
        where e.character_id = o.character_id and e.conversation_id = i.conversation_ref
          and e.type = 'user_message' and e.actor_type = 'user'
          and e.created_at > o.updated_at and e.created_at <= ${input.now}) as replied
    from notification_occurrences o
    join notification_intents i on i.id = o.intent_id
    where o.character_id = ${String(input.characterId)} and i.character_id = ${String(input.characterId)}
      and i.owner_ref = ${input.ownerRef} and i.conversation_ref = ${input.conversationRef}
      and i.delivery_channel = ${input.channel} and o.kind = 'reminder'
      and o.state in ('api_accepted', 'failed_confirmed', 'delivery_unknown', 'dispatching')
      and o.updated_at between ${input.now - 86_400_000} and ${input.now}
      and not exists (select 1 from jsonb_array_elements_text(i.source_refs) ref(value)
        where ref.value in (select jsonb_array_elements_text(${JSON.stringify(input.withdrawnEventIds)}::jsonb)))
    order by o.updated_at desc, o.occurrence_key desc limit 10`, '读取同会话近期提醒投递')
  return rows.reverse().map(row => ({ occurrenceKey: String(row.occurrence_key), state: String(row.state),
    text: String(row.candidate_text ?? ''), at: Number(row.updated_at),
    stoppedByMessage: row.repeat_mode === 'until_reply' && row.state === 'api_accepted' && row.replied === true }))
}

/** 到点（或已过期）的待办提醒 —— 含**已经过去**的那些（调用方决定 `grace` / `expired`） */
export async function listDueIntents(
  db: RawDb,
  characterId: CharacterId,
  now: Timestamp,
  limit = 20
): Promise<NotificationIntentRecord[]> {
  const rows = await exec(
    db,
    sql`select * from notification_intents
        where character_id = ${String(characterId)} and status = 'pending'
          and kind = 'reminder' and scheduled_at <= ${now}
        order by scheduled_at asc
        limit ${Math.max(1, Math.min(200, limit))}`,
    '列出到点的提醒'
  )
  return asRows<IntentRow>(rows).map((row) => rowToIntent(row)!)
}

/**
 * 改时 —— 计划版本 +1（`D07`：**旧计划版本不再触发**）。
 *
 * ⚠️ 它**只**允许在 `pending` 上做：已经交付/取消/过期的意图不许被改时复活
 *    （`D13`：改回 `on` 不复活旧授权）。
 */
export async function rescheduleIntent(
  db: RawDb,
  id: NotificationIntentId,
  input: { scheduledAt: Timestamp; timezone: string; permissionVersion: string; now?: Timestamp }
): Promise<{ ok: boolean; planVersion?: number; code?: string }> {
  const now = input.now ?? Date.now()
  const rows = await exec(
    db,
    sql`update notification_intents
        set scheduled_at = ${input.scheduledAt},
            timezone = ${input.timezone},
            permission_version = ${input.permissionVersion},
            plan_version = plan_version + 1,
            updated_at = ${now}
        where id = ${String(id)} and status = 'pending'
        returning plan_version`,
    '改时通知意图'
  )
  const updated = firstRow<{ plan_version: number }>(rows)
  if (updated === undefined) return { ok: false, code: 'intent_not_pending' }
  return { ok: true, planVersion: Number(updated.plan_version) }
}

/** 内容补充使用版本比较；已经开始投递的提醒不能被悄悄改写。 */
export async function updateReminderText(db: RawDb, target: NotificationIntentRecord, text: string, sourceRefs: readonly string[], now = Date.now(), channel: ChatChannel = target.deliveryChannel, repeatMode?: import('../../kernel/app/reminder/repeat-mode.ts').ReminderRepeatMode): Promise<boolean> {
  const refs = [...new Set([...target.sourceRefs, ...sourceRefs])]
  const candidate = buildNotificationCandidate(text)
  const rows = await exec(db, sql`update notification_intents
    set text = ${candidate.text}, text_fingerprint = ${candidate.fingerprint}, source_refs = ${JSON.stringify(refs)}::jsonb,
        delivery_channel = ${channel}, repeat_mode = ${repeatMode ?? target.repeatMode ?? null}, plan_version = plan_version + 1, updated_at = ${now}
    where id = ${String(target.id)} and character_id = ${String(target.characterId)}
      and owner_ref = ${target.ownerRef} and conversation_ref = ${target.conversationRef}
      and kind = 'reminder' and status = 'pending' and plan_version = ${target.planVersion}
      and scheduled_at > ${now}
      and not exists (select 1 from notification_occurrences o where o.intent_id = notification_intents.id and o.state <> 'cancelled')
    returning id`, '补充待发送提醒内容')
  return rows.length > 0
}

/** Batch edits keep the same owner/conversation/version fence as content updates. */
export async function revisePendingReminder(db: RawDb, target: NotificationIntentRecord,
  change: ({ dueAt: number } | { cancel: true }) & { sourceRefs?: readonly string[]; repeatMode?: import('../../kernel/app/reminder/repeat-mode.ts').ReminderRepeatMode }, now = Date.now()): Promise<boolean> {
  if ('dueAt' in change && (!Number.isFinite(change.dueAt) || change.dueAt <= now)) return false
  const rows = await exec(db, sql`update notification_intents
    set scheduled_at = ${'dueAt' in change ? change.dueAt : target.scheduledAt},
        status = ${'cancel' in change ? 'cancelled' : 'pending'}, repeat_mode = ${change.repeatMode ?? target.repeatMode ?? null}, plan_version = plan_version + 1, updated_at = ${now},
        source_refs = ${JSON.stringify([...new Set([...target.sourceRefs, ...(change.sourceRefs ?? [])])])}::jsonb
    where id = ${String(target.id)} and character_id = ${String(target.characterId)}
      and owner_ref = ${target.ownerRef} and conversation_ref = ${target.conversationRef}
      and kind = 'reminder' and status = 'pending' and plan_version = ${target.planVersion}
      and scheduled_at > ${now}
      and not exists (select 1 from notification_occurrences o where o.intent_id = notification_intents.id and o.state <> 'cancelled')
    returning id`, '批量提醒改期或取消')
  return rows.length > 0
}

/** 取消（`cancelled` 是**终态**：不许被后来任何动作改回 `pending`） */
export async function cancelIntent(
  db: RawDb,
  id: NotificationIntentId,
  input: { reason?: string; now?: Timestamp } = {}
): Promise<{ ok: boolean; code?: string }> {
  const now = input.now ?? Date.now()
  const affected = await affectedRows(
    db,
    sql`update notification_intents
        set status = 'cancelled', updated_at = ${now}
        where id = ${String(id)} and status = 'pending'
        returning id`,
    '取消通知意图'
  )
  if (affected === 0) return { ok: false, code: 'intent_not_pending' }
  /* 未发送的实例一并作废（已发出/未知的**不动** —— 那是已定案的事实） */
  await exec(
    db,
    sql`update notification_occurrences
        set state = 'cancelled', reason_code = ${input.reason ?? 'intent_cancelled'}, updated_at = ${now}
        where intent_id = ${String(id)} and state in ('pending', 'evaluating', 'prepared')
        returning occurrence_key`,
    '作废未发送的通知实例'
  )
  return { ok: true }
}

/** 把意图推到某个终态（`delivered` / `expired` / `missed`） */
export async function finishIntent(
  db: RawDb,
  id: NotificationIntentId,
  status: Extract<NotificationIntentStatus, 'delivered' | 'expired' | 'missed'>,
  now: Timestamp = Date.now()
): Promise<{ ok: boolean; code?: string }> {
  const affected = await affectedRows(
    db,
    sql`update notification_intents
        set status = ${status}, updated_at = ${now}
        where id = ${String(id)} and status = 'pending'
        returning id`,
    '结束通知意图'
  )
  return affected === 0 ? { ok: false, code: 'intent_not_pending' } : { ok: true }
}

// ---------------------------------------------------------------------------
// 实例（发送幂等的**唯一**占用口）
// ---------------------------------------------------------------------------

export interface ReserveOccurrenceInput {
  expectedPlanVersion?: number
  occurrenceKey: string
  intentId?: NotificationIntentId
  characterId: CharacterId
  kind: NotificationKind
  dueAt: Timestamp
  permissionVersion: string
  policyVersion: string
  now?: Timestamp
}

/**
 * **占用**一次外发机会。
 *
 * ```text
 * 插入成功  ⇒ created: true  —— 这一次机会现在归我们了（可以往下走）
 * 键已存在  ⇒ created: false —— **不报错、不重发**：同一次机会只产生一个外发尝试
 * ```
 * ⚠️ 这是"同 occurrence 只产生一个外发尝试"的机器形态（计划 §9 验收行）：
 *    它**不**依赖调用方记得去重，**不**依赖内存状态，**重启后依然成立**。
 */
export async function reserveOccurrence(
  db: RawDb,
  input: ReserveOccurrenceInput
): Promise<{ occurrence: NotificationOccurrenceRecord | undefined; created: boolean }> {
  if (input.kind !== 'care' && input.intentId === undefined) {
    throw new KernelError(
      'validation_error',
      'notification_occurrence_reminder_without_intent',
      '提醒的实例必须挂在一条意图上（表级 CHECK 也挡这一条）'
    )
  }
  const now = input.now ?? Date.now()
  const rows = await exec(
    db,
    sql`insert into notification_occurrences
          (occurrence_key, intent_id, character_id, kind, state, due_at, attempt,
           permission_version, policy_version, created_at, updated_at, schema_version)
        select ${input.occurrenceKey}, ${input.intentId === undefined ? null : String(input.intentId)},
                ${String(input.characterId)}, ${input.kind}, 'pending', ${input.dueAt}, 1,
                ${input.permissionVersion}, ${input.policyVersion}, ${now}, ${now}, ${SCHEMA_VERSION}
        ${input.expectedPlanVersion === undefined ? sql`` : sql`where exists (select 1 from notification_intents i
          where i.id = ${String(input.intentId)} and i.character_id = ${String(input.characterId)}
            and i.status = 'pending' and i.plan_version = ${input.expectedPlanVersion}
            and i.scheduled_at = ${input.dueAt})`}
        on conflict (occurrence_key) do nothing
        returning *`,
    '占用通知实例'
  )
  const created = rows.length > 0
  if (created) return { occurrence: rowToOccurrence(firstRow<OccurrenceRow>(rows)), created: true }
  const existing = await getOccurrence(db, input.occurrenceKey)
  return { occurrence: existing, created: false }
}

export async function getOccurrence(
  db: RawDb,
  occurrenceKey: string
): Promise<NotificationOccurrenceRecord | undefined> {
  const rows = await exec(
    db,
    sql`select * from notification_occurrences where occurrence_key = ${occurrenceKey} limit 1`,
    '读取通知实例'
  )
  return rowToOccurrence(firstRow<OccurrenceRow>(rows))
}

/**
 * ★ S3 ③（ADR-129 D05）：取某条意图**最新的一条实例**（`due_at` 降序，再按键稳序）。
 *
 * 用途：续发的**排期与恢复收在同一处**（`listPendingReminders()`，见
 * `docs/post-lv2/Reminder-Repeat-Wiring-Spec-2026-10-10.md` §1.2c）——
 * 那里要判断"上次投递到哪一步、第几次、什么时候"，这些事实**只读**取出来即可。
 * ⚠️ 只读：不推进任何状态（推进仍只走 `advanceOccurrence`）。
 */
export async function latestOccurrenceForIntent(
  db: RawDb,
  intentId: NotificationIntentId
): Promise<{ occurrence: NotificationOccurrenceRecord | undefined; count: number; lastDeliveredAt?: number }> {
  const rows = await exec(
    db,
    sql`select * from notification_occurrences where intent_id = ${String(intentId)}
        order by due_at desc, occurrence_key desc limit 1`,
    '读取意图的最新实例'
  )
  /*
   * ★ S3 ③ 缺口 G2 的推荐修法（b）：**"第几次"做成可推导事实** —— 不再依赖 `repeat_attempt`
   *   列（`reserveOccurrence` 的入参里没有 attempt ⇒ 那列会一直是缺省值，上限 10 就判不出来）。
   * ⚠️ 两条查询只对**续发意图**（`repeat_mode='until_reply'`）调用 ⇒ 不在每个 tick 上放大。
   */
  const counted = await exec(
    db,
    sql`select count(*)::int as total, max(updated_at) filter (where state = 'api_accepted') as last_delivered_at
        from notification_occurrences where intent_id = ${String(intentId)}`,
    '统计意图实例数'
  )
  return {
    occurrence: rowToOccurrence(firstRow<OccurrenceRow>(rows)),
    count: Number(firstRow<{ total: number }>(counted)?.total ?? 0),
    ...(counted[0]?.last_delivered_at == null ? {} : { lastDeliveredAt: Number(counted[0].last_delivered_at) }),
  }
}

/**
 * ★ S3 ③ 续发（ADR-129 D05）：把**意图自己的排期**前移到下一条。
 *
 * ============================================================================
 *  为什么需要它（一条真缺陷的修法）
 * ============================================================================
 *  `reserveOccurrence` 带一条一致性 EXISTS：**实例的 `dueAt` 必须等于意图的 `scheduled_at`**
 *  （见本文件 :502-505）。而续发的实例 dueAt = 上次 + 60s ≠ 原 `scheduled_at`
 *  ⇒ 插入什么都不做 ⇒ `created:false` ⇒ **续发排上了、却永远发不出去**。
 *  ⇒ 修法：续发时把**意图的 `scheduled_at` 一起前移**，让那条不变式对每一条续发都成立。
 *     附带好处：`listPendingReminders` 变简单（意图自己的 `scheduled_at` 就是"下一条该发"）。
 *
 * ============================================================================
 *  它被刻意做窄（这不是普通的 update）
 * ============================================================================
 * ```text
 * ① 只动 `repeat_mode = 'until_reply'` 的意图 —— 普通提醒的排期**任何路径都不得改写**（逐字保持旧行为）；
 * ② `scheduled_at = fromDueAt` 是**乐观并发**：只有"当前排期正是我以为的那一格"才更新，
 *    ⇒ 同一次机会被并发臂两次也不会跳过一拍（第二次受影响行数 0）；
 * ③ 只允许**前移**（`toDueAt > fromDueAt`）—— 调用方先判，这里再兜一道；
 * ④ 返回 `true` = 真的前移了（调用方据此决定要不要把下一条排出去）。
 * ```
 */
export async function advanceRepeatSchedule(
  db: RawDb,
  input: { intentId: NotificationIntentId; fromDueAt: Timestamp; toDueAt: Timestamp; now?: Timestamp }
): Promise<boolean> {
  if (input.toDueAt <= input.fromDueAt) return false
  const now = input.now ?? Date.now()
  const rows = await exec(
    db,
    sql`update notification_intents
           set scheduled_at = ${input.toDueAt}, updated_at = ${now}
         where id = ${String(input.intentId)}
           and status = 'pending'
           and repeat_mode = 'until_reply'
           and scheduled_at = ${input.fromDueAt}
         returning id`,
    '前移续发排期'
  )
  return rows.length > 0
}

/**
 * ★ S4 ②（ADR-129 D08）：列出**待补说**的错过提醒（`status = 'missed'`），按排期升序。
 *
 * 用途：下一轮对话时按 `takeCatchupBatch`（≤10 条）**逐条**补说；
 *      补说成功 ⇒ 那批推 `delivered`（`delivered` = 内容已经到他那儿了）⇒
 *      **候选集永远只是 `missed`** ⇒ 天然幂等，重复补说在结构上不可能。
 * ⚠️ 只读；`expired`（尝试过没送成 / 作废）**不在**候选里（标记侧已把两者分开）。
 */
export async function listMissedIntents(
  db: RawDb,
  characterId: CharacterId,
  limit = 50
): Promise<NotificationIntentRecord[]> {
  const rows = await exec(
    db,
    sql`select * from notification_intents
         where character_id = ${String(characterId)} and status = 'missed'
         order by scheduled_at asc
         limit ${limit}`,
    '列出待补说的错过提醒'
  )
  return rows
    .map(row => rowToIntent(row as unknown as IntentRow))
    .filter((intent): intent is NotificationIntentRecord => intent !== undefined)
}

/**
 * 推进实例状态 —— **唯一**的状态写入口。
 *
 * ⚠️ 它做三件事，缺一不可：
 * ```text
 * ① 读当前状态（读不到 ⇒ 具名拒绝；不许"给一个不存在的实例改状态"）
 * ② `assertOccurrenceTransition` 复核迁移（终态不可迁移、未知态不许变接受态）
 * ③ `where state = <读到的旧值>` 乐观更新（并发下后到者失败，而不是覆盖）
 * ```
 * ⚠️ 候选正文**只**在 `prepared` 那一步写入，且必须走 `buildNotificationCandidate`
 *    （空/超长/控制字符 ⇒ 抛）。
 */
export async function advanceOccurrence(
  db: RawDb,
  occurrenceKey: string,
  input: {
    to: NotificationOccurrenceState
    /** `prepared` 时给的候选正文（其它状态不许给） */
    text?: string
    assistantEventId?: string
    platformMessageId?: string
    reasonCode?: string
    now?: Timestamp
  }
): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }> {
  const now = input.now ?? Date.now()
  const current = await getOccurrence(db, occurrenceKey)
  if (current === undefined) return { ok: false, code: 'occurrence_missing' }
  if (current.kind === 'relay' && input.to === 'dispatching' && current.state === 'dispatching') {
    return { ok: false, code: 'relay_already_dispatching', state: current.state }
  }
  if (!canTransitionOccurrence(current.state, input.to) && current.state !== input.to) {
    /* 先复核再抛：抛是"调用方写错了"，而返回码是"运行期的正常拒绝" */
    try {
      assertOccurrenceTransition(current.state, input.to)
    } catch (error) {
      return {
        ok: false,
        code: error instanceof KernelError ? error.code : 'notification_transition_denied',
        state: current.state,
      }
    }
  }
  if (input.to === 'prepared' && input.text === undefined) {
    return { ok: false, code: 'occurrence_prepared_without_candidate', state: current.state }
  }
  if (input.to !== 'prepared' && input.text !== undefined) {
    return { ok: false, code: 'occurrence_candidate_outside_prepared', state: current.state }
  }
  if (input.to === 'api_accepted' &&
      (input.platformMessageId === undefined || input.platformMessageId.trim() === '')) {
    /* 表级 CHECK 也会挡这一条；在这里先挡是为了给一个**具名**理由码 */
    return { ok: false, code: 'occurrence_accepted_without_message_id', state: current.state }
  }
  const candidate = input.to === 'prepared' ? buildNotificationCandidate(input.text!) : undefined

  const affected = await affectedRows(
    db,
    sql`update notification_occurrences
        set state = ${input.to},
            candidate_text = coalesce(${candidate?.text ?? null}, candidate_text),
            candidate_fingerprint = coalesce(${candidate?.fingerprint ?? null}, candidate_fingerprint),
            candidate_length = coalesce(${candidate?.length ?? null}, candidate_length),
            assistant_event_id = coalesce(${input.assistantEventId ?? null}, assistant_event_id),
            platform_message_id = coalesce(${input.platformMessageId ?? null}, platform_message_id),
            reason_code = ${input.reasonCode ?? null},
            updated_at = ${now}
        where occurrence_key = ${occurrenceKey} and state = ${current.state}
        returning occurrence_key`,
    '推进通知实例状态'
  )
  if (affected === 0) return { ok: false, code: 'occurrence_concurrent_update', state: current.state }
  return { ok: true, state: input.to }
}

/**
 * 重启兜底：把遗留的 `dispatching` 实例判成**结果不明**（`D08` 表格最后一行）。
 *
 * ⚠️ 它**不**重发、**不**释放额度、**不**按 failed 作业重跑。
 *    返回被改判的键（供如实登记"重启时丢了几条"）。
 */
export async function quarantineOrphanedDispatching(
  db: RawDb,
  now: Timestamp = Date.now()
): Promise<readonly string[]> {
  const target = stateForOrphanedDispatching()
  const rows = await exec(
    db,
    sql`update notification_occurrences
        set state = ${target},
            reason_code = 'process_restarted_before_receipt',
            updated_at = ${now}
        where state = 'dispatching'
        returning occurrence_key`,
    '隔离遗留的在途投递'
  )
  return asRows<{ occurrence_key: string }>(rows).map((row) => String(row.occurrence_key))
}

// ---------------------------------------------------------------------------
// 额度与统计（计划 §6）
// ---------------------------------------------------------------------------

/**
 * 统计某角色在**某一天**已经占用的额度。
 *
 * ⚠️ 三处口径是刻意的：
 * ```text
 * ① 按**指定时区**算日界（计划 §6：「跨日以指定时区计算」）——
 *    调用方传进来的 `dayStart` / `dayEnd` 必须已经由 `dayKeyOf` 那套时区逻辑算好；
 *    本函数**不**碰时区（它只做 SQL）—— 那正是"两处算日界迟早会漂"的常见来源。
 * ② 只数**占额**的状态（`occurrenceOccupiesQuota`）：`dispatching` / `api_accepted` /
 *    `delivery_unknown` / `failed_confirmed` 都算 —— **结果不明也不借重试绕过**（计划 §9）。
 * ③ 关心与全类分开数（两类限额不同），但两者的行都在同一张表里。
 * ```
 */
/**
 * 本次调度周期里**已经被尝试过**的机会键（`L-QQP-05` 的读侧修法）。
 *
 * ```text
 * "还要不要发"（意图 / 机会）与"发出去之后平台怎么说"（实例行的终态）是**两件事**。
 * 投递之后意图仍然是 `pending`（本批刻意**不**把 `api_accepted` 写成"已送达"：
 * `D08` 说平台接受 ≠ 送达）⇒ 调度器每次重排都会再列出同一条。
 * ⇒ 这里给出"已经产生过实例行"的那些键，让调度器**不再重复交付**；
 *    ⚠️ 这**不**改任何状态、**不**主张任何平台事实。
 * ```
 * ⚠️ 键**不**从库里反解，而是用与占用那一步**同一条冻结的纯函数**重算
 *    （`reminderOccurrenceKey`）—— 否则"排的那条"与"占用过的那条"可能对不上。
 */
export async function listAttemptedReminderOccurrenceKeys(
  db: RawDb,
  characterId: CharacterId
): Promise<Set<string>> {
  const rows = await exec(
    db,
    sql`select o.occurrence_key as occurrence_key
        from notification_occurrences o
        join notification_intents i on i.id = o.intent_id
        where i.character_id = ${String(characterId)} and i.kind = 'reminder'`,
    '列出已经尝试过的提醒机会键'
  )
  const keys = new Set<string>()
  for (const row of asRows<{ occurrence_key?: unknown }>(rows)) {
    const key = typeof row.occurrence_key === 'string' ? row.occurrence_key.trim() : ''
    if (key !== '') keys.add(key)
  }
  return keys
}

/**
 * 现在**有没有候选在途**（计划 §4.4：最多一个候选在途）。
 *
 * ```text
 * "在途" = 还没走到终态的那些实例：pending / evaluating / prepared / dispatching
 * ⚠️ `dispatching` **算在途**：平台结局还没回来（`D07` 的"交给外壳了")
 *    它既不是"已接受"也不是"已失败" —— 此时再开一个新候选就会与它并行。
 * ```
 */
export async function hasInFlightOccurrence(
  db: RawDb,
  characterId: CharacterId
): Promise<boolean> {
  const rows = await exec(
    db,
    sql`select count(*) as used from notification_occurrences
        where character_id = ${String(characterId)}
          and state in ('pending', 'evaluating', 'prepared', 'dispatching')`,
    '查询是否有候选在途'
  )
  const row = firstRow<{ used: number | string }>(rows)
  return Number(row?.used ?? 0) > 0
}

/**
 * 最近一次**真实入站**的时刻（关心机会的"空闲度"判据要用它）。
 *
 * ⚠️ 判据是**两个条件的合取**：`type = 'user_message'` **且** `actor_type = 'user'`
 *    （`conversation-event.ts` 的 `assertConversationEvent` 就是这么约束的）。
 *    只按 `type` 数，会把任何写错 `actor_type` 的行当成"真人说过话"。
 * ⚠️ 她自己的输出、系统事件、主动投递**都不算入站** ——
 *    把那些算进去，等于"她自己说了一句话就把自己的空闲度清零了"。
 * ⚠️ **没有按入口分列**：`entry` 不是 `conversation_events` 的列（它在运行时的元数据里）。
 *    缺省给的是**全局最近入站** —— 对"空闲度"来说这正是要的：
 *    两条入口只要有任何一条活跃过，`max` 就是那一次（`D14` 的"跨入口活动"由此成立）。
 *    提醒确认传 conversationRef，只接受该提醒所在会话的入站，不按消息内容匹配确认词。
 */
export async function lastInboundAt(
  db: RawDb,
  characterId: CharacterId,
  conversationRef?: string
): Promise<Timestamp | undefined> {
  const rows = await exec(
    db,
    sql`select max(created_at) as at from conversation_events
        where character_id = ${String(characterId)}
          and type = 'user_message' and actor_type = 'user'
          and (${conversationRef === undefined ? sql`true` : sql`conversation_id = ${conversationRef}`})`,
    '查询最近一次入站时刻'
  )
  const row = firstRow<{ at: number | string | null }>(rows)
  if (row?.at === null || row?.at === undefined) return undefined
  const at = Number(row.at)
  return Number.isNaN(at) ? undefined : (at as Timestamp)
}

/**
 * 把一次**关心**机会改期到 `until`（ADR-110 `D03` 的 `defer` 那一支；迁移 `0016`）。
 *
 * ```text
 * `deferred_until` 与 `state` 是**正交**的：
 *   一个实例行可以在任何**非终态**上带着一个改期时刻 ⇒ 只写那一列，不动状态机。
 * ```
 * ⚠️ **只允许关心**（`kind = 'care'`）：提醒的"过一会儿再说"是**改意图的时刻**
 *    （`rescheduleIntent` 那条路），不是"这一次机会先压着"—— 两者不是一件事。
 *    混用会让"提醒的 `defer`"在实例行上留一个谁也不看的时刻。
 * ⚠️ 终态的实例行**不许**改期：它已经定案了，再挂一个将来的时刻只会让 tick 白等。
 */
export async function deferOccurrence(
  db: RawDb,
  occurrenceKey: string,
  until: Timestamp
): Promise<{ ok: boolean; code?: string }> {
  const rows = await exec(
    db,
    sql`select state, kind from notification_occurrences where occurrence_key = ${occurrenceKey}`,
    '读取实例行以判断能不能改期'
  )
  const row = firstRow<{ state: string; kind: string }>(rows)
  if (row === undefined) return { ok: false, code: 'occurrence_missing' }
  if (String(row.kind) !== 'care') return { ok: false, code: 'occurrence_defer_not_care' }
  if (isTerminalOccurrenceState(row.state as NotificationOccurrenceState)) {
    return { ok: false, code: 'occurrence_defer_terminal' }
  }
  await exec(
    db,
    sql`update notification_occurrences
        set deferred_until = ${until}, updated_at = ${Date.now()}
        where occurrence_key = ${occurrenceKey}`,
    '写入改期时刻'
  )
  return { ok: true }
}

/**
 * 现在**还压着的**改期（`deferred_until > now` 的那些关心实例）。
 *
 * ⚠️ 给 tick 用：只要还有一条没到期，这一轮就**不问模型**（避免"她刚说了过会儿再说，
 *    下一个 tick 又来问一遍"）。返回的是**时刻**而不是布尔，是为了让读数能说出"压到什么时候"。
 */
export async function pendingCareDeferrals(
  db: RawDb,
  characterId: CharacterId,
  now: Timestamp
): Promise<Timestamp[]> {
  const rows = await exec(
    db,
    sql`select deferred_until from notification_occurrences
        where character_id = ${String(characterId)}
          and kind = 'care'
          and deferred_until is not null
          and deferred_until > ${now}
        order by deferred_until asc`,
    '查询还压着的改期'
  )
  return rows
    .map((row) => Number((row as { deferred_until: number | string }).deferred_until))
    .filter((value) => !Number.isNaN(value)) as Timestamp[]
}

export async function countQuotaUsage(
  db: RawDb,
  input: {
    characterId: CharacterId
    /** 日窗口的**起点**（含）与**终点**（不含），由调用方按指定时区算好 */
    dayStart: Timestamp
    dayEnd: Timestamp
    kind?: NotificationKind
  }
): Promise<number> {
  const rows = await exec(
    db,
    sql`select count(*) as used from notification_occurrences
        where character_id = ${String(input.characterId)}
          ${input.kind === undefined ? sql`` : sql`and kind = ${input.kind}`}
          and state in ('dispatching', 'api_accepted', 'delivery_unknown', 'failed_confirmed')
          and due_at >= ${input.dayStart} and due_at < ${input.dayEnd}`,
    '统计通知额度占用'
  )
  const row = firstRow<{ used: number | string }>(rows)
  return row === undefined ? 0 : Number(row.used)
}

/**
 * 某角色**最近一次成功投递**的时刻（冷却与"有没有得到新入站回应"的判据输入）。
 *
 * ⚠️ 它**只**回答"她上次真正发出去是什么时候"——**不**回答"本人读了没有"
 *    （QQ 协议没有已读凭据；`D08` 逐字）。
 */
export async function lastAcceptedAt(
  db: RawDb,
  characterId: CharacterId,
  kind?: NotificationKind
): Promise<Timestamp | undefined> {
  const rows = await exec(
    db,
    sql`select max(due_at) as last_at from notification_occurrences
        where character_id = ${String(characterId)} and state = 'api_accepted'
          ${kind === undefined ? sql`` : sql`and kind = ${kind}`}`,
    '读取最近一次已接受的投递'
  )
  const row = firstRow<{ last_at: number | null }>(rows)
  const value = row?.last_at
  return value === null || value === undefined ? undefined : Number(value)
}

// ---------------------------------------------------------------------------
// 用户控制面（`D13`：暂停 / 恢复 / 状态）
// ---------------------------------------------------------------------------

export interface NotificationControlRecord {
  characterId: CharacterId
  paused: boolean
  pausedAt?: Timestamp
  pauseReason?: string
  permissionVersion: string
  policyVersion: string
  updatedAt: Timestamp
}

interface ControlRow {
  character_id: string
  paused: boolean
  paused_at: number | null
  pause_reason: string | null
  permission_version: string
  policy_version: string
  updated_at: number
}

function rowToControl(row: ControlRow | undefined): NotificationControlRecord | undefined {
  if (!row) return undefined
  return {
    characterId: row.character_id as CharacterId,
    paused: row.paused === true,
    ...(row.paused_at === null ? {} : { pausedAt: Number(row.paused_at) }),
    ...(row.pause_reason === null ? {} : { pauseReason: String(row.pause_reason) }),
    permissionVersion: String(row.permission_version),
    policyVersion: String(row.policy_version),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * 读控制面。
 *
 * ⚠️ **没有行时的缺省是"未暂停"** —— 但调用方必须同时看**模式**
 *    （`off` / `shadow` / `on` 是配置层，不是控制层）："没有暂停行"**不等于**"该发"。
 *    这条缺省是刻意的：一个刚建库的实例不该因为"还没写过控制行"就发不出任何东西
 *    —— 真正拦住它的是模式与许可。
 */
export async function readControl(
  db: RawDb,
  characterId: CharacterId
): Promise<NotificationControlRecord | undefined> {
  const rows = await exec(
    db,
    sql`select * from notification_control where character_id = ${String(characterId)} limit 1`,
    '读取主动联系控制面'
  )
  return rowToControl(firstRow<ControlRow>(rows))
}

/**
 * 暂停（**幂等**）。
 *
 * ⚠️ 三件事同真同假（表级 CHECK 也挡）：`paused ⇔ paused_at ⇔ pause_reason`。
 *    "暂停了却不知道从什么时候起、为什么"是不可审计的暂停 ⇒ 拒绝。
 * ⚠️ 已经是暂停态时**保留原来的 `paused_at`**：重复暂停不该把"停了多久"重置成 0。
 */
export async function pauseNotifications(
  db: RawDb,
  input: {
    characterId: CharacterId
    reason: string
    permissionVersion: string
    policyVersion: string
    now?: Timestamp
  }
): Promise<{ ok: boolean; code?: string; control?: NotificationControlRecord }> {
  if (input.reason.trim() === '') {
    throw new KernelError(
      'validation_error',
      'notification_pause_without_reason',
      '暂停必须带理由（否则"为什么停着"查不出来）'
    )
  }
  const now = input.now ?? Date.now()
  const current = await readControl(db, input.characterId)
  const pausedAt = current?.paused === true ? (current.pausedAt ?? now) : now

  await exec(
    db,
    sql`insert into notification_control
          (character_id, paused, paused_at, pause_reason, permission_version, policy_version,
           updated_at, schema_version)
        values (${String(input.characterId)}, true, ${pausedAt}, ${input.reason},
                ${input.permissionVersion}, ${input.policyVersion}, ${now}, ${SCHEMA_VERSION})
        on conflict (character_id) do update set
          paused = true,
          paused_at = ${pausedAt},
          pause_reason = ${input.reason},
          permission_version = ${input.permissionVersion},
          policy_version = ${input.policyVersion},
          updated_at = ${now}
        returning *`,
    '暂停主动联系'
  )
  const control = await readControl(db, input.characterId)
  return { ok: true, ...(control === undefined ? {} : { control }) }
}

/**
 * 恢复。
 *
 * ⚠️ 它把三件套**一起**清掉（表级 CHECK 要求同真同假）——
 *    "恢复了却还留着暂停理由"会让"现在到底停没停"有两种答案。
 * ⚠️ 恢复**不补发**积压的关心（计划 §10 逐字）：它只把闸打开，历史机会已过期。
 */
export async function resumeNotifications(
  db: RawDb,
  input: {
    characterId: CharacterId
    permissionVersion: string
    policyVersion: string
    now?: Timestamp
  }
): Promise<{ ok: boolean; code?: string; control?: NotificationControlRecord }> {
  const now = input.now ?? Date.now()
  const current = await readControl(db, input.characterId)
  if (current === undefined || current.paused !== true) {
    return { ok: false, code: 'not_paused' }
  }
  await exec(
    db,
    sql`update notification_control
        set paused = false, paused_at = null, pause_reason = null,
            permission_version = ${input.permissionVersion},
            policy_version = ${input.policyVersion},
            updated_at = ${now}
        where character_id = ${String(input.characterId)} and paused = true
        returning *`,
    '恢复主动联系'
  )
  const control = await readControl(db, input.characterId)
  return { ok: true, ...(control === undefined ? {} : { control }) }
}
