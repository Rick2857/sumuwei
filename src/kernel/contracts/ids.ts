/**
 * Character Kernel —— 领域基础类型与 ID。
 *
 * ============================================================================
 *  这一层是 Character Domain，**不允许依赖任何基础设施**
 * ============================================================================
 * 允许 import 的东西只有：本目录内的其它契约 / 纯类型 / 纯函数。
 *
 * 禁止出现（会被 `kernel-boundary.test.ts` 静态检查拦下）：
 *   @elizaos/*            —— Runtime 不是 Kernel
 *   node:fs / node:path   —— 领域不碰文件系统
 *   drizzle-orm           —— 领域不碰 SQL
 *   ../infrastructure/*   —— 依赖方向必须是 infrastructure → domain
 *
 * ID 的设计原则（M2.5 计划书第 8 节）：
 *   必须不依赖 Session、不依赖模型、不依赖登录用户、不依赖 Runtime 实例、
 *   不依赖数据库行号变化。因此全部是"带前缀的字符串 ID"，可读、可人肉核对、
 *   可在日志里直接认出来，而不是裸 UUID。
 */

// ---------------------------------------------------------------------------
// 基础标量
// ---------------------------------------------------------------------------

/** 毫秒时间戳（与既有 M1/M2 代码保持一致：一律用 number，不用 Date） */
export type Timestamp = number

declare const brand: unique symbol

/** 领域内不透明的 ID 类型：编译期互相不可赋值，运行期就是 string */
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** 角色 id（稳定，形如 `char_sumuwei` 或既有 UUID） */
export type CharacterId = Brand<string, 'CharacterId'>

/**
 * 会话 id：一个角色可以有多个会话（本项目按"角色 × 用户"划分 DM 会话）。
 *
 * 注意：会话是**对话事件的分组单位**，而 Domain Event / Projection 是
 * **角色级**的（需要区分用户时把 userId 编进 projectionType，见 plan 8.6）。
 */
export type ConversationId = Brand<string, 'ConversationId'>

/** 对话事件 id（事实账本主键） */
export type ConversationEventId = Brand<string, 'ConversationEventId'>

/** 领域事件 id（角色变化历史主键） */
export type DomainEventId = Brand<string, 'DomainEventId'>

/** 提案 id（Processor 的"建议"，不是事实） */
export type ProposalId = Brand<string, 'ProposalId'>

/** 后台任务 id */
export type JobId = Brand<string, 'JobId'>

/** Agent 单轮运行的 trace id */
export type TraceId = Brand<string, 'TraceId'>

// ---------------------------------------------------------------------------
// M3.5：跨实体（Entity）与"她感知到 / 她想做"的 ID
// ---------------------------------------------------------------------------

/**
 * 通用实体 id。
 *
 * 与 `CharacterId` / `ConversationId` 的关系（计划书第 6 / 8 节）：
 * **两者都保留**。`CharacterDefinition.characterId` 继续用 `CharacterId`，
 * 因为它语义更强（"这是角色，不是别的实体"）。
 *
 * `EntityId` 只用于**跨实体关系**：`actor` / `target` / `observer` / `subject` /
 * `perspectiveOwner` —— 也就是"这里可以是任何东西"的那些位置。
 * 把它们写成 `CharacterId` 才会真正堵死未来（第二个角色、NPC、地点、组织都来不了）。
 */
export type EntityId = Brand<string, 'EntityId'>

/**
 * Observation id —— "什么东西被角色感知到了"。
 *
 * 由**事件 id 确定性派生**（`makeObservationId`）：同一条事件永远得到同一个
 * Observation id。这样重放、幂等与"这条 Observation 从哪来"三件事同时成立，
 * 而不是靠随机 id + 一张对照表。
 */
export type ObservationId = Brand<string, 'ObservationId'>

/** Intent id —— "角色想做什么"（不是"做了什么"，计划书第 20 节） */
export type IntentId = Brand<string, 'IntentId'>

/**
 * Memory id —— 一条长期记忆的身份（计划书第 21 节）。
 *
 * ⚠️ 它**不是** ConversationEventId，也不是 DomainEventId。
 * 一条记忆可以来自多条事件（`sourceRefs` 是复数），
 * 而一条事件也可以产生多条记忆（一次抽取常常同时产出 fact + preference + episode）。
 * 三者是三个独立的东西，用同一个 id 类型会立刻让"这条记忆从哪来"变得无法回答。
 */
export type MemoryId = Brand<string, 'MemoryId'>

/**
 * Action id —— 一次**真实动作**的身份（M4.5）。
 *
 * ⚠️ 它既不是 MemoryId 也不是 DomainEventId：
 *   · Memory 回答"她知道什么"
 *   · Action 回答"她做过什么"（ADR-034：两本账，不合并）
 * 它由请求方在**执行之前**分配（`newActionId()`），
 * 因此"想做什么"与"做了什么"共享同一个 id，trace 才串得起来。
 */
export type ActionId = Brand<string, 'ActionId'>

/**
 * 通知**意图** id（post-Lv2 / QQ 主动联系 · ADR-110 `D07`）。
 *
 * ⚠️ 它标识"本人要求过的一次提醒 / 一次关心的许可登记"这一**行**，
 *    **不是**发送幂等键 —— 后者是通知实例的 `occurrenceKey`（见 `contracts/notification.ts`）。
 *    因此这里允许随机（与 `newActionId()` 同理）。
 */
export type NotificationIntentId = Brand<string, 'NotificationIntentId'>

/**
 * Belief id —— 一条**视角化信念**的身份（M9 / ADR-070）。
 *
 * ⚠️ 它不是 MemoryId（"用户保存的事实"）、不是 DomainEventId（"账本行"）、
 * 也不是 ConversationEventId（"原始发言"）：Belief 回答"她当前对某命题的
 * 判断是什么、依据什么、还作数吗"。修订产生**新** beliefId（supersedes 链
 * 留因果），绝不复用旧 id 改写内容（INV-M9-11）。
 */
export type BeliefId = Brand<string, 'BeliefId'>

/**
 * Goal id —— 一个**协作目标**的身份（M10 / ADR-076 `D05`）。
 *
 * ⚠️ 它与内容键**不是**一回事：派生材料含 `acceptanceSourceEventId` 与 `operation`
 * （见 `contracts/goal.ts` 的 `makeGoalId`），因此
 *   · **同内容重新设立**（新的一轮）⇒ **新身份** —— 这是"取消后同内容永远建不起来"
 *     （M9 的 F-4 同族）的结构性修法；
 *   · **同一操作重复投递**（同事件 + 同操作 + 同内容）⇒ 同一 id ⇒ 放行口幂等拒绝。
 * 身份一旦建立**不复用**（`GOAL_SUPERSEDED` 留旧项 + 新项，不原地改写）。
 */
export type GoalId = Brand<string, 'GoalId'>

/**
 * Commitment id —— 一次**正式承担**的身份（M10 / ADR-076 `D03`）。
 *
 * ⚠️ 它既不是 GoalId 也不是 ActionId：
 *   · Goal 回答"她准备追求什么结果"
 *   · Commitment 回答"她在什么范围内正式承担了什么"
 *   · Action 回答"她实际做了什么"（M4.5 的执行账）
 * 三者分开判定：Goal 完成**不能**推算 Commitment 已兑现（ADR-076 §4.4）。
 */
export type CommitmentId = Brand<string, 'CommitmentId'>

// ---------------------------------------------------------------------------
// 版本号
// ---------------------------------------------------------------------------

/**
 * Processor / Reducer / Compiler 的版本号，例如 `memory-extractor@1`、
 * `character-state@1`。
 *
 * 刻意**独立于应用版本**（`project-v0.2.4` 这种写法是错的）：
 * 以后很可能只有某个 Extractor 的 Prompt 改了，而应用版本没动；
 * 反过来应用发版也常常完全不涉及认知逻辑。
 */
export type ProcessorVersion = string

/** 行/结构的 schema 版本，用于未来做数据迁移 */
export type SchemaVersion = number

// ---------------------------------------------------------------------------
// ID 生成与解析
// ---------------------------------------------------------------------------

/** 允许出现在 ID 里的字符：字母数字与 `-` `_` `:`，避免日志里出现不可读字符 */
function assertSafePart(part: string, label: string, maxLength = 120): void {
  if (!/^[A-Za-z0-9_:-]+$/.test(part) || part.length > maxLength) {
    throw new Error(
      `${label} 含有不适合放进 ID 的字符：${JSON.stringify(part)}（只允许字母数字与 _ - :，长度 1..${maxLength}）`
    )
  }
}

/**
 * 由稳定字符串片段构造 ID。
 *
 * 用确定性的 `makeId` 而不是随机 UUID 的理由与 M1 相同：
 * 同一个 (角色, 会话, 序号) 必须永远得到同一个事件 id，否则
 * "重复事件"检测（SC-003 / SC-004）与跨进程重放都做不了。
 */
export function makeConversationEventId(
  characterId: CharacterId,
  conversationId: ConversationId,
  sequence: number
): ConversationEventId {
  assertSafePart(characterId, 'characterId')
  assertSafePart(conversationId, 'conversationId')
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`sequence 必须是 >= 1 的安全整数，收到 ${sequence}`)
  }
  return `cev:${characterId}:${conversationId}:${sequence}` as ConversationEventId
}

/** 领域事件 id：`dev:<characterId>:<序号>`，序号来自持久层的原子分配器 */
export function makeDomainEventId(characterId: CharacterId, sequence: number): DomainEventId {
  assertSafePart(characterId, 'characterId')
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`domain event sequence 必须是 >= 1 的安全整数，收到 ${sequence}`)
  }
  return `dev:${characterId}:${sequence}` as DomainEventId
}

/**
 * Memory id（确定性，计划书第 21 节）。
 *
 * 形如 `mem:<characterId>:<slot>`。
 *
 * ⚠️ 为什么**必须**是确定性的（不能用 `crypto.randomUUID()`）：
 * M4 的幂等键把 memoryId 编进去（见 `docs/m4/compatibility-audit.md` §6 F4）——
 * 因为一次抽取会从同一段事件区间产出多条候选，而幂等键里若没有
 * "这是哪条记忆"这个分量，同一批的候选会算出**同一个键**，
 * 于是第 2、3 条会被判成重复而**静默丢弃**。
 *
 * 确定性 id 让"同一批事件 + 同一 processor 版本重跑"得到同一批 id，
 * 因此幂等成立；而同一批里的不同候选必须给出**不同**的 `slot`。
 *
 * `slot` 由调用方构造，通常形如
 * `<批次内序号>-<规范化谓词或事件序号>`；只有一条硬要求：
 * **同一批里互不相同、跨批次对同一事实相同**。
 */
export function makeMemoryId(characterId: CharacterId, slot: string): MemoryId {
  assertSafePart(characterId, 'characterId')
  if (typeof slot !== 'string' || slot.trim() === '') {
    throw new KernelError(
      'validation_error',
      'empty_memory_slot',
      'MemoryId 的 slot 不能为空：空 slot 会让同一角色的所有记忆挤进同一个 id'
    )
  }
  assertSafePart(slot, 'memorySlot')
  return `mem:${characterId}:${slot}` as MemoryId
}

/**
 * 从 `mem:<characterId>:<slot>` 取回 slot（供诊断与测试用）。
 *
 * 返回 `undefined` 而不是抛错：它会被用在"这条 id 是不是 Memory id"这类
 * 判断里，而那种地方用异常表达"不是"会很别扭。
 */
export function memorySlotFromId(id: MemoryId): string | undefined {
  const parts = String(id).split(':')
  if (parts.length < 3 || parts[0] !== 'mem') return undefined
  return parts.slice(2).join(':')
}

/** 提案 id：随机 UUID（提案本身不是长期事实，允许随机） */
export function newProposalId(): ProposalId {
  return `prp:${crypto.randomUUID()}` as ProposalId
}

/** 任务 id */
export function newJobId(): JobId {
  return `job:${crypto.randomUUID()}` as JobId
}

/** trace id */
export function newTraceId(): TraceId {
  return `trc:${crypto.randomUUID()}` as TraceId
}

/**
 * Observation id（确定性）。
 *
 * 形如 `obs:cev:<角色>:<会话>:<序号>`：把来源事件 id 原样嵌进去，
 * 于是"这条 Observation 是哪条事件派生的"在日志里**一眼可读**，
 * 不需要任何额外的对照表。
 */
export function makeObservationId(sourceEventId: string): ObservationId {
  if (typeof sourceEventId !== 'string' || sourceEventId.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', 'Observation 的派生来源不能为空')
  }
  // A complete cev ID has two 120-character parts plus prefix, separators and a 16-digit safe sequence.
  assertSafePart(sourceEventId, 'sourceEventId', 262)
  return `obs:${sourceEventId}` as ObservationId
}

/**
 * Intent id（随机）。
 *
 * 与 `newProposalId()` 同一个道理：Intent 是"她此刻想做的一件事"这个**瞬时**判断，
 * 不是长期事实（长期事实是它被 Resolver 接受后产生的那个事件）。
 * 因此允许随机，而真正需要可追溯的那一头是 `resultRefs`。
 */
export function newIntentId(): IntentId {
  return `int:${crypto.randomUUID()}` as IntentId
}

/**
 * Action id（随机）。
 *
 * 与 `newProposalId()` / `newIntentId()` 同一个道理：动作请求是**瞬时**的
 * 一次"要做什么"，而它的长期痕迹是账本里的 `character_action_events`
 * （那一条才是需要可追溯的事实）。
 */
export function newActionId(): ActionId {
  return `act:${crypto.randomUUID()}` as ActionId
}

/**
 * 通知**意图** id（随机）。
 *
 * ⚠️ 与 `newProposalId()` / `newActionId()` 同一个道理：意图是"本人要求过一件事"的**登记**，
 *    它的长期痕迹是 `notification_intents` 那一行；
 *    而**发送幂等**靠的不是这个 id，是通知**实例**的 `occurrenceKey`（见 `notification.ts`）。
 *    随机 id 在这里是安全的：它只做行身份，不做幂等键。
 */
export function newNotificationIntentId(): NotificationIntentId {
  return `qni:${crypto.randomUUID()}` as NotificationIntentId
}

export const asNotificationIntentId = (value: string): NotificationIntentId => {
  assertSafePart(value, 'notificationIntentId')
  return value as NotificationIntentId
}

// ---------------------------------------------------------------------------
// 品牌化辅助（供测试与适配器构造 ID）
// ---------------------------------------------------------------------------

export const asCharacterId = (value: string): CharacterId => {
  assertSafePart(value, 'characterId')
  return value as CharacterId
}
export const asConversationId = (value: string): ConversationId => {
  assertSafePart(value, 'conversationId')
  return value as ConversationId
}
export const asConversationEventId = (value: string): ConversationEventId => {
  if (value.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', '事件 id 不能为空')
  }
  return value as ConversationEventId
}
export const asDomainEventId = (value: string): DomainEventId => {
  if (value.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', '领域事件 id 不能为空')
  }
  return value as DomainEventId
}
export const asProposalId = (value: string): ProposalId => value as ProposalId
export const asJobId = (value: string): JobId => value as JobId
export const asTraceId = (value: string): TraceId => value as TraceId
export const asEntityId = (value: string): EntityId => {
  assertSafePart(value, 'entityId')
  return value as EntityId
}
export const asObservationId = (value: string): ObservationId => {
  if (value.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', 'Observation id 不能为空')
  }
  return value as ObservationId
}
export const asIntentId = (value: string): IntentId => {
  if (value.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', 'Intent id 不能为空')
  }
  return value as IntentId
}
export const asMemoryId = (value: string): MemoryId => {
  if (value.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', 'Memory id 不能为空')
  }
  return value as MemoryId
}
export const asActionId = (value: string): ActionId => {
  if (value.trim() === '') {
    throw new KernelError('validation_error', 'empty_id', 'Action id 不能为空')
  }
  return value as ActionId
}

// ---------------------------------------------------------------------------
// 错误分类（M2.5 计划书第 69 节：不要只有 Exception）
// ---------------------------------------------------------------------------

export type KernelErrorKind =
  | 'validation_error'
  | 'revision_conflict'
  | 'duplicate_operation'
  | 'processor_error'
  | 'persistence_error'
  | 'telemetry_error'

/**
 * Kernel 的统一错误类型。
 *
 * `kind` 是机器可判定的类别，`code` 是更细的稳定枚举（供测试断言与日志聚合）。
 * 上层据此决定"重试 / 放弃 / 记 trace"，而不是靠字符串匹配。
 */
export class KernelError extends Error {
  readonly kind: KernelErrorKind
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(
    kind: KernelErrorKind,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'KernelError'
    this.kind = kind
    this.code = code
    this.details = details
  }
}

export const isKernelError = (e: unknown): e is KernelError => e instanceof KernelError

export function isKernelErrorKind(e: unknown, kind: KernelErrorKind): boolean {
  return isKernelError(e) && e.kind === kind
}
