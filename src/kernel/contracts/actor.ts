/**
 * ActorRef / 身份分层 —— **谁**说的这句话。
 *
 * ============================================================================
 *  计划书第 5–11 节：身份必须分层，而且四者不是一回事
 * ============================================================================
 *
 *     CharacterIdentity    苏沐薇是谁        —— 不随 Session / 登录 / 模型 / 重启变化
 *     UserIdentity         用户是谁          —— 不随 Session 变化（否则 M4 会把用户事实绑到会话上）
 *     ConversationIdentity 这段对话是什么    —— **可替换**（换新会话 ≠ 换角色）
 *     RuntimeIdentity      这次程序运行      —— 只用于 diagnostics / trace / deployment
 *
 * 把它们混成一个 `name` 是长期角色系统最典型的退化方式：
 * 于是"重启后她还在吗"变成"重启后那行记录还在吗"，
 * 而"换设备还认识我吗"变成"换个 room id 就变成陌生人"。
 *
 * ---------------------------------------------------------------------------
 *  为什么现在就要有 tool
 * ---------------------------------------------------------------------------
 * 计划书第 11 节：即使 M3 没有复杂 Tool reasoning，也要有 `tool` 这一种 actor。
 * 因为以后 Tool 返回"天气是 20°C"，绝不能被记成"用户说天气是 20°C"——
 * 那是一条**观测**，不是一句**陈述**。等到真接 Tool 时再补这个枚举，
 * 就会有一批历史数据已经错了，而且无法回溯修正（append-only）。
 */

import { KernelError, type CharacterId, type ConversationId } from './ids.ts'

// ---------------------------------------------------------------------------
// RuntimeIdentity
// ---------------------------------------------------------------------------

/** 本次程序运行的 id，形如 `runtime_20260916_1a2b3c` */
export type RuntimeId = string & { readonly __brand?: 'RuntimeId' }

/**
 * 生成一个 runtime id。
 *
 * 计划书第 9 节：它**只能**用于 diagnostics / trace / deployment，
 * 绝对不能当 CharacterId 或 UserId 用。这里的类型名刻意与那两个不同，
 * 且没有任何转换函数 —— 想混用就必须显式 cast，于是代码 review 时看得见。
 */
export function newRuntimeId(now: number = Date.now()): RuntimeId {
  const stamp = new Date(now)
  const y = stamp.getUTCFullYear()
  const m = String(stamp.getUTCMonth() + 1).padStart(2, '0')
  const d = String(stamp.getUTCDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  return `runtime_${y}${m}${d}_${random}` as RuntimeId
}

// ---------------------------------------------------------------------------
// ActorRef
// ---------------------------------------------------------------------------

/**
 * 谁做的这件事（计划书第 10 节）。
 *
 * ⚠️ `actorType` 与 `actorId` 一起才构成"谁"：
 *   · `{actorType:'user', actorId:'<uuid>'}`      —— 具体某个用户
 *   · `{actorType:'character', actorId:'char_…'}` —— 苏沐薇本人
 *   · `{actorType:'system', actorId:'scheduler'}` —— 某个系统组件（**不是**她）
 *   · `{actorType:'tool', actorId:'weather'}`     —— 某个工具（**不是**用户）
 */
export type ActorType = 'user' | 'character' | 'system' | 'tool'

export interface ActorRef {
  actorId: string
  actorType: ActorType
}

export const ACTOR_TYPES: readonly ActorType[] = ['user', 'character', 'system', 'tool']

/**
 * 由事件形状推导 actor（**唯一的推导处**）。
 *
 * 事件类型与 actor 种类必须严格对应，否则就是伪造来源。
 * M2.5 已经有 `createConversationEvent` 里的两道闸（user_message↔user、
 * assistant_message↔character）；M3 把它收敛到这里，
 * 这样新增 tool / system 事件时不会在两处各写一半规则。
 */
export function actorTypeForEventKind(kind: 'user' | 'character' | 'system' | 'tool'): ActorType {
  return kind
}

export function actorRefEquals(a: ActorRef, b: ActorRef): boolean {
  return a.actorType === b.actorType && a.actorId === b.actorId
}

/** 人类可读标签（进日志与上下文；**领域层不知道用户叫什么**，因此只是类型名） */
export function actorLabel(actor: ActorRef): string {
  switch (actor.actorType) {
    case 'user':
      return 'USER'
    case 'character':
      return 'CHARACTER'
    case 'system':
      return 'SYSTEM'
    case 'tool':
      return 'TOOL'
    default:
      return 'UNKNOWN'
  }
}

// ---------------------------------------------------------------------------
// 参与者（Participant）—— 一次对话涉及哪些稳定身份
// ---------------------------------------------------------------------------

/**
 * 一个会话的参与者构成。
 *
 * 注意：**UserId 与 ConversationId 必须分开传**。这个接口的存在就是为了
 * 让"同一个用户的两个会话"在类型上写得出来：
 *
 *     { userId: 'u-1', conversationId: 'c-A' }
 *     { userId: 'u-1', conversationId: 'c-B' }   ← 同一个人，不同会话
 */
export interface Participants {
  characterId: CharacterId
  userId: string
  conversationId: ConversationId
}

/**
 * 会话参与者错误。
 *
 * 单独一个码是为了让上层能区分"数据不存在"与"数据存在但不属于这里"——
 * 后者才是真正的完整性事故（例如把别人的会话 id 写进了自己的账本）。
 */
export function participantsMismatch(
  field: 'characterId' | 'userId' | 'conversationId',
  expected: string,
  actual: string
): KernelError {
  return new KernelError(
    'validation_error',
    'participant_mismatch',
    `${field} 不匹配：期望 ${expected}，收到 ${actual}`,
    { field, expected, actual }
  )
}

// ---------------------------------------------------------------------------
// M5.1.1（ADR-042 D5 / D6）：PrincipalKind / PrincipalRef / UnknownReason / AttributionValue
// ---------------------------------------------------------------------------

/**
 * 归因位次（principal）的**种类** —— ADR-042 D5。
 *
 * ⚠️ 与上面的 `ActorType` **并存，但不是它的超集，也不做互相转换**：
 *
 *     ActorType     （4） = 账本里 legacy presented role / message role，由 event family 决定
 *     PrincipalKind （6） = 归因位次的种类（多了 SERVICE / EXTERNAL_ACTOR）
 *
 * ADR-042 D8.1 **删除**了"唯一投影函数"与反向投影（`actorTypeFromPrincipalKind`）：
 * 旧 `ActorType` 里根本没有 `SERVICE`，任何方向的一一映射都会让合法行变得**表达不出来**
 * （D01 会换个形状回来）。因此这里**故意没有任何转换函数** —— 想混用必须显式写出来。
 *
 * ⚠️ **没有** `UNKNOWN*`：未知不是一种位次种类，它由 `UnknownReason` 表达（裁定 B4）。
 *    `UNKNOWN_LEGACY` / `UNKNOWN_NOW` 是**被删除**的候选值，别再引入。
 * ⚠️ **没有** `DEVELOPER`：developer 是**上下文角色**，不是位次种类（U-02）。
 *    控制面自己是 `SERVICE`；能确认身份的开发者是 `USER/<developer-id>`；
 *    确认不了就是 `Unknown(RUNTIME_UNRESOLVED)`。
 */
export type PrincipalKind =
  | 'USER'
  | 'CHARACTER'
  | 'SYSTEM'
  | 'SERVICE'
  | 'TOOL'
  | 'EXTERNAL_ACTOR'

/** 受控词汇的唯一登记表（顺序即 ADR-042 D5 的顺序） */
export const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  'USER',
  'CHARACTER',
  'SYSTEM',
  'SERVICE',
  'TOOL',
  'EXTERNAL_ACTOR',
]

/**
 * 一个**具体位次**：种类 + 标识。
 *
 * 刻意只有两个字段（ADR-042 D5）：
 *   · 不是 `CharacterId` / `UserId` 的替代品，两者**不互相转换**
 *   · 不许带 `displayName` / `traits` / `relationships` —— 那属于 Entity Model，
 *     不是归因（"谁与谁是同一个实体"是另一个问题）
 *   · id 的形态由各 kind 自己约定：`u-…` / `char_…` / `scheduler` / `weather` /
 *     `svc:telemetry` / `agent-runner` 等；**领域层不解释它的内部结构**
 */
export interface PrincipalRef {
  kind: PrincipalKind
  id: string
}

/**
 * 一个槽位**为什么**是未知（ADR-042 §5.2）。
 *
 *     LEGACY_UNRECORDED  这个概念本该存在，但历史从未记录过它（迁移的默认结论）
 *     RUNTIME_UNRESOLVED 这个概念本该存在，但运行时确定不了（例如工具没有自报身份）
 *
 * ⚠️ 它与 `Absent` 是**两件事**：
 *   · `Unknown` = "这个概念适用于这条事件，但我们不知道是谁"
 *   · `Absent`  = "这个概念对这条事件**不适用**"（没有执行者，因为什么都没执行）
 * 把两者折叠起来，等于把"不知道"洗成"不适用"（或反过来），
 * 这是 ADR-042 §5.2 明令禁止的（也是 D01 的同一种错误形状）。
 */
export type UnknownReason = 'LEGACY_UNRECORDED' | 'RUNTIME_UNRESOLVED'

/** 受控词汇的唯一登记表 */
export const UNKNOWN_REASONS: readonly UnknownReason[] = [
  'LEGACY_UNRECORDED',
  'RUNTIME_UNRESOLVED',
]

/**
 * 一个归因槽位的**三态**取值（ADR-042 D5）。
 *
 *     KNOWN    —— 有具体位次（或具体 authority），或一条已被记录的具体值
 *     UNKNOWN  —— 概念适用，但来源未知/运行时定不下来，**必须带理由**
 *     ABSENT   —— 概念对此事件不适用
 *
 * 三态**不可互相折叠**，也不允许"既像 Known 又像 Unknown"的混合形状：
 *   · `UNKNOWN` 不带 value（不允许"未知但顺手填一个默认位次"）
 *   · `ABSENT` 不带 reason（"不适用"不需要解释，它本身就是要说的事）
 *
 * 注意 `ATTRIBUTION_VALUE_STATES` 是**判据**（test 与 validator 都读它），
 * 不是又一份真相。
 */
export type AttributionValue<T> =
  | { readonly state: 'KNOWN'; readonly value: T }
  | { readonly state: 'UNKNOWN'; readonly reason: UnknownReason }
  | { readonly state: 'ABSENT' }

export const ATTRIBUTION_VALUE_STATES: readonly ('KNOWN' | 'UNKNOWN' | 'ABSENT')[] = [
  'KNOWN',
  'UNKNOWN',
  'ABSENT',
]

/**
 * 构造三态值。
 *
 * 名字带 `attribution` 前缀：契约层是公开出口（`contracts/index.ts` 是 `export *`），
 * 一个裸的 `known()` / `absent()` 迟早会与别处的词撞名。
 */
export function attributionKnown<T>(value: T): AttributionValue<T> {
  return { state: 'KNOWN', value }
}

export function attributionUnknown<T = never>(reason: UnknownReason): AttributionValue<T> {
  return { state: 'UNKNOWN', reason }
}

export function attributionAbsent<T = never>(): AttributionValue<T> {
  return { state: 'ABSENT' }
}

/** 三态的名字（渲染与判据都用它；**不要**再各写一份 if/else） */
export function attributionStateOf<T>(value: AttributionValue<T>): 'KNOWN' | 'UNKNOWN' | 'ABSENT' {
  return value.state
}

/** 两个位次是否指向同一个"谁" */
export function principalRefEquals(a: PrincipalRef, b: PrincipalRef): boolean {
  return a.kind === b.kind && a.id === b.id
}
