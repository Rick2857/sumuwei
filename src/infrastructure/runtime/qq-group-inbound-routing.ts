/**
 * QQ 群入站路由（ADR-156 §5 / P3-A；P3-H 补"没有生效任务"那一支）。
 *
 * ```text
 * 该群没有生效任务（从未有 / 已终态 / 已过期）⇒ default（默认规则逐字照旧）
 * 有生效任务、结构上不满足 ⇒ suppress（**默认路线也不许兜底**）
 * 有生效任务、结构上满足   ⇒ task_candidate（类别/话题交给模型判断）
 * ```
 *
 * ⚠️ **P3-H**："没有生效任务"这一支**只**回落 `default`，**不许**再因为"历史上曾有一条
 *    耗尽/撤销/过期的任务"把这个群长期挡在门外（用户裁定：任务结束后恢复默认路线）。
 *    这一支里唯一还能否认这个群的东西是**旧静态名单与成员核验**（`admission.basis = 'denied'`）
 *    —— 那一条保留，但它必须**静默**（`qq_group_not_authorized` 在 `BRIDGE_SILENT_CODES` 里）。
 *
 * ⚠️ 判定**全部**来自契约里的两个纯函数（`decideGroupAdmission` /
 *    `decideInboundRouting`）：本模块只负责**取事实**（持久层任务行）与
 *    **组装入参**，不重判任何一条规则。
 * ⚠️ 准入顺序按方案 §5：**先看有没有生效任务，再看旧名单** ——
 *    反过来就是"先拿旧名单把消息丢掉"。
 * ⚠️ 单次发送任务（`send_once`）**不**接管路由（契约里就是这么规定的）：
 *    它只管理自己那一次发送。
 */
import {
  decideGroupAdmission,
  decideInboundRouting,
  type GroupAdmissionBasis,
  type GroupTaskCategory,
  type GroupTaskView,
} from '../../kernel/contracts/qq-group-task.ts'
import { listGroupTasks } from '../persistence/qq-group-task-store.ts'
import type { RawDb } from '../persistence/db.ts'

export type GroupInboundRoute = 'default' | 'task_candidate' | 'suppress'

export interface GroupInboundRouting {
  readonly route: GroupInboundRoute
  /** 抑制原因（`route === 'suppress'` 时有） */
  readonly code?: string
  readonly taskId?: string
  /**
   * ADR-156 / P3-E：**给读数用的对账串**（可选，不含正文，不参与判据）。
   * ⚠️ 例如 `members=1(尾508) sender=9(尾508)` —— 用来回答"两个看起来一样的值为什么不等"。
   */
  readonly detail?: string
  readonly taskVersion?: number
  readonly categories?: readonly GroupTaskCategory[]
  readonly topicScope?: string | null
  readonly replyToMessageId?: string | null
  /** 准入依据（`legacy_allowlist` / `group_task` / `denied`） */
  readonly admission: {
    readonly allowed: boolean
    readonly basis: GroupAdmissionBasis
    readonly scope: 'legacy' | 'task_only' | 'none'
  }
}

export interface GroupInboundRoutingInput {
  readonly db: RawDb
  readonly groupId: string
  readonly inbound: {
    readonly messageId: string
    readonly senderId: string
    readonly at: number
  }
  readonly now: number
  /** 旧静态名单（`QQ_ALLOWED_GROUP_IDS`）是否放行这个群 */
  readonly legacyGroupAllowed: boolean
}

/**
 * 该群当前**生效中**的回复任务（单次发送任务不参与路由）。
 *
 * ```text
 * 参与路由 = kind 是 reply_window
 *          + 状态是 active / paused（终态一律退出：completed / exhausted / expired / revoked）
 *          + **此刻在生效期内**（`startAt <= now` 且 window 的 `now < endAt`）
 * ```
 *
 * ⚠️ **P3-H：为什么要多这一条"生效期"判据**（用户裁定原话："不要因为历史上有一条耗尽任务，
 *    就永久抑制这个群"、"任务结束后恢复默认规则"）：
 * ```text
 * 旧行为：额度耗尽后任务被置终态 exhausted ⇒ 不再进"生效任务"集合 ⇒ 该群回到准入判定；
 *        但一条 **window 任务到期** 而状态仍停留在 active 时，它**还会**进路由
 *        ⇒ `decideInboundRouting` 判 `group_task_out_of_term` ⇒ suppress
 *        ⇒ 这个群被一条**已经过期**的任务长期挡住（默认路线不许兜底）。
 *        那与"任务结束后恢复默认路线"（方案已规定）直接冲突。
 * 现在：**不在生效期内**的任务（已到期 / **还没开始**）**都不算生效任务** ⇒ 路由回落 `default`
 *        ⇒ 交回旧静态名单与成员核验。
 * ```
 * ⚠️ **"还没开始"也一并剔除**（Lead 2026-10-29 裁定）：任务不在生效期是一个**单一状态**
 *    （还没开始 / 已到期 / 已撤销 / 已删除），语义都是"此刻没有生效任务" ⇒ 一律回落 `default`。
 *    只把"已到期"剔除、把"还没开始"留成一个静默抑制态，会产生一段**主人看不见、
 *    也解释不了**的"她突然不说话"的窗口 —— 而那段窗口的真实语义就是"没有生效任务"。
 *    名单内群照旧正常回、名单外群照旧静默（`qq_group_not_authorized` → `no_reply`）。
 * ⚠️ 终态 + 不在生效期都只是"它不再生效"，**不**删行、**不**改状态机 —— 本批零存储改动。
 */
function effectiveReplyTasks(tasks: readonly GroupTaskView[], now: number): GroupTaskView[] {
  return tasks.filter(task => {
    if (task.kind !== 'reply_window') return false
    if (task.status !== 'active' && task.status !== 'paused') return false
    /* 还没开始 ⇒ 此刻没有生效任务（与"已到期"同一条理由，见上面的裁定） */
    if (now < task.term.startAt) return false
    /* 已到期 ⇒ 同上 */
    if (task.term.kind === 'window' && now >= task.term.endAt) return false
    return true
  })
}
/**
 * 路由判定（读事实 + 调契约）。
 *
 * ⚠️ `addressesBot` 恒为 `false`：契约用它表达"这条入站是否 @ 了她"，
 *    而**默认路线**的 @ 条件是既有行为的一部分（由旧路径自己判），
 *    本模块只判"任务 vs 默认 vs 抑制" ⇒ 不在这里猜 @。
 */
export async function resolveGroupInboundRouting(
  input: GroupInboundRoutingInput
): Promise<GroupInboundRouting> {
  const tasks = await listGroupTasks(input.db, { groupId: input.groupId, limit: 50 })
  const replyTasks = effectiveReplyTasks(tasks, input.now)
  const active = replyTasks.find(task => task.status === 'active')
  const admission = decideGroupAdmission({
    groupId: input.groupId,
    legacyGroupAllowed: input.legacyGroupAllowed,
    activeReplyTask: active === undefined
      ? undefined
      : { taskId: active.id, taskVersion: active.version },
  })
  const admissionView = {
    allowed: admission.allowed,
    basis: admission.basis,
    scope: admission.scope,
  }
  if (!admission.allowed) {
    /*
     * 既**没有生效任务**、旧名单也不放行 ⇒ 消息连门都进不去。
     *
     * ⚠️ P3-H：这一支**保留**（P3-B 的负控就是它：核心判定这条入站不属于任何生效任务
     *    的范围、旧名单也不允许 ⇒ 具名 `qq_group_not_authorized`）。
     *    变的**不是**它，而是它的**外观**：那个码现在落在 `BRIDGE_SILENT_CODES` 里
     *    ⇒ 外壳只记一条 `qq_no_reply`，**不发失败提示、不重试、不记 `lg_turn_failed`**。
     * ⚠️ 它**不再**能被"一条早已耗尽/撤销/过期的任务"触发 —— 那类任务已经被
     *    `effectiveReplyTasks` 从"生效任务"里剔掉，于是这个群交回旧规则（`default`）。
     */
    return { route: 'suppress', code: 'group_task_admission_denied', admission: admissionView }
  }
  const decision = decideInboundRouting({
    groupId: input.groupId,
    inbound: { ...input.inbound, addressesBot: false },
    replyTasks,
    now: input.now,
    usage: {
      totalMessages: active?.usedMessages ?? 0,
      slotMessages: active === undefined ? 0 : slotUsageOf(active),
      lastSendAt: active?.lastSendAt ?? null,
    },
  })
  if (decision.route === 'default') return { route: 'default', admission: admissionView }
  if (decision.route === 'suppress') {
    return {
      route: 'suppress',
      code: decision.code,
      ...(decision.taskId === undefined ? {} : { taskId: decision.taskId }),
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
      admission: admissionView,
    }
  }
  return {
    route: 'task_candidate',
    taskId: decision.taskId,
    taskVersion: decision.taskVersion,
    categories: decision.categories,
    topicScope: decision.topicScope,
    replyToMessageId: decision.replyToMessageId,
    admission: admissionView,
  }
}

/**
 * slot 窗口已用量（**估算**：任务行上只留了总额，窗口内条数按任务口径取 0）。
 *
 * ⚠️ 如实边界：slot 是"时间窗内条数"上限，而任务行没有按窗分桶的计数列
 *    ⇒ 这里传 0 意味着**发送前复核**才拦得住窗口超额（那一步读的是实例账本）。
 *    路由这一层不因 slot 拒绝消息（否则会把"窗口没满"也当成拒绝）。
 */
function slotUsageOf(_task: GroupTaskView): number {
  return 0
}

/**
 * ADR-156 / P3-H：派生关联键时**唯一**需要的平台事实（结构子集，便于单测）。
 *
 * ⚠️ 刻意**不**接收整条 `BridgeInboundPlatformFacts`：那里面还有 `senderUserId` 等
 *    与本判定无关的字段 —— 传得越少，越不会有"顺手拿它做别的事"。
 */
export interface InboundMessageIdFacts {
  readonly transport: 'qq' | 'wechat'
  readonly messageType: 'private' | 'group'
  /** 机器人自己的平台账号（外壳从包取，非自报） */
  readonly selfId: string
  readonly groupId?: string
}

/**
 * 外壳构造的群入站 `requestId` 形状（`onebot-private-client.ts` 的 `receive()`）。
 * ⚠️ 三个数字段分别是 **bot / 群 / 消息号**；多一个字符都不认（失败关闭）。
 */
const QQ_GROUP_REQUEST_ID = /^qq:(\d+):group:(\d+):(-?\d+)$/

/**
 * ADR-156 / P3-H：**可信入站关联键**的派生（纯函数，失败关闭）。
 *
 * ============================================================================
 *  它回答什么，以及为什么必须由**受信 requestId** 派生
 * ============================================================================
 * ```text
 * 要回答：这一轮群任务接管轮的回复，属于**哪一条入站**？
 *        （账本列 `qq_group_send_instances.inbound_message_id`；
 *          空 ⇒ per-inbound 维度恒 0 ⇒ `perInboundMaxMessages` 对这条链路不生效）
 *
 * 为什么不能用 `platformFacts.messageId`：
 *   桥的 `platformFactsProblems` 对 `transport === 'qq'` **明确禁止**它
 *   （`bridge_bad_platform_facts_key`）—— 那条禁止是**防伪造**的：那个字段一旦放开，
 *   "让它以为这是另一条消息"就成了可填的东西。本函数**不碰**它，也不许放开它。
 *
 * 为什么 `requestId` 可信：
 *   外壳的 `receive()` 用**已经校验过**的三样东西拼出它：
 *     `qq:<botId>:group:<groupId>:<message_id>`
 *   其中 selfId 来自包（与配置逐字比对过）、groupId/message_id 来自本帧报文，
 *   且 message_id 已经进了外壳自己的白名单 ⇒ 它是**受信**关联键，不是模型可填字段。
 *
 * 为什么回**完整 requestId** 而不是裸 `message_id`：
 *   完整 id 编码了 **bot + 群 + 消息号** ⇒ 跨群 / 跨机器人的同号消息不会撞在一起
 *   （两个机器人各自的 `message_id=1` 是两条不同的入站）。
 *   存储列是文本列 ⇒ 不需要任何 DDL。
 * ```
 *
 * ⚠️ **失败关闭**：形状不符 / bot 不符 / 群不符 / 不是群消息 ⇒ `undefined`，**绝不猜**。
 *    返回 `undefined` 的后果是"这一轮拿不到关联键"（per-inbound 维度按 0 计，与改动前
 *    逐字相同），**不是**"编一个键让它能过"。宁可少一道额度横切，不可把两条入站混成一条。
 */
export function deriveInboundMessageId(
  requestId: string | undefined,
  facts: InboundMessageIdFacts | undefined
): string | undefined {
  /* ① 这一轮没有 requestId（旧调用点 / 非桥入口）⇒ 没有关联键，不做推断 */
  if (typeof requestId !== 'string') return undefined
  /* ② 平台事实缺席 ⇒ 无从校验 bot/群，**不猜** */
  if (facts === undefined) return undefined
  /* ③ 只对 QQ 群消息成立：微信的消息 id 是另一套摘要（且它从不走这条派发） */
  if (facts.transport !== 'qq' || facts.messageType !== 'group') return undefined
  /* ④ 形状闭集：`qq:<bot>:group:<group>:<message>`，逐段都要是纯数字 */
  const matched = QQ_GROUP_REQUEST_ID.exec(requestId)
  if (matched === null) return undefined
  /* ⑤ bot 与群必须与本轮**已校验的平台事实**逐字相同（跨群/跨机器人 ⇒ 不是同一条入站） */
  if (matched[1] !== facts.selfId) return undefined
  if (typeof facts.groupId !== 'string' || matched[2] !== facts.groupId) return undefined
  /* ⑥ 通过 ⇒ 回**完整** requestId（不是裸 message_id） */
  return requestId
}

/**
 * ADR-156 / P3-F：**模型显式拒答**的标记（方案 §11「乙、其它类别和超限/过期消息不回复」）。
 *
 * ```text
 * 为什么需要它：任务的"类别/话题"判据是**自然语言**的（"只回复甲的数学问题"），
 *   程序侧判不了一条群消息属不属于它 ⇒ 只能由**模型**判。
 *   模型要能说"这条不该接"，就需要一条**可判定**的显式信号。
 * 怎么用：接管轮的上下文告诉模型 —— 不该回时**只**输出这一串标记；
 *   核心在把回复交出去**之前**比对（逐字、trim 后全等）⇒ 命中即"有意不回"。
 * ```
 *
 * ⚠️ **只认逐字全等**：模型若输出"标记 + 其它内容"，按**普通回复**处理（不静默吞掉半句话）。
 * ⚠️ 它**不是**失败：命中后走 `no_reply`（不回复、不发失败提示、不计额度）。
 */
export const GROUP_TASK_NO_REPLY_MARKER = '[lg:no-reply]'

/** 这段回复是不是"模型显式拒答"（逐字、trim 后全等） */
export function isGroupTaskDeclineReply(text: string): boolean {
  return text.trim() === GROUP_TASK_NO_REPLY_MARKER
}

/** 任务接管轮给模型看的上下文（**资料**，不是指令） */
export function renderGroupTaskInboundContext(input: {
  readonly taskId: string
  readonly taskVersion: number
  readonly categories: readonly GroupTaskCategory[]
  readonly topicScope: string | null
  readonly replyToMessageId: string | null
}): string {
  const categories = input.categories.length === 0 ? '不限' : input.categories.join('、')
  return [
    '【本轮群任务接管】本群当前有一条**生效中的回复任务**，本轮按它的规则走。',
    '默认的闲聊规则本轮**退后**：不要把这条消息当成普通群聊来接。',
    `任务：${input.taskId}（版本 ${input.taskVersion}）`,
    `关注类别：${categories}`,
    `话题范围：${input.topicScope ?? '不限'}`,
    `指定回复对象：${input.replyToMessageId ?? '不限'}`,
    '事实与限制按任务记录如实执行；任务没让你回，就**不要回**；不要编造任务范围。',
    `若你判定这条消息**不在任务范围内**（类别/话题不符、或你决定不接），**只**输出这一串标记、不要输出其它内容：${GROUP_TASK_NO_REPLY_MARKER}`,
  ].join('\n')
}
