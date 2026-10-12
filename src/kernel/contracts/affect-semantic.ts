/**
 * M8.5 Semantic Affect —— 合同层（WP3，detached：只登记，不接线）。
 *
 * 权威源：
 *   · [ADR-068](../../../docs/adr/ADR-068-m8.5-semantic-affect.md)（M85-D01…D22）
 *   · [M8.5-Contract-Freeze.md](../../../docs/m8.5/M8.5-Contract-Freeze.md)（数值与名称级冻结）
 *   · [M8.5-Corpus-Spec.md](../../../docs/m8.5/M8.5-Corpus-Spec.md) §4（reasonCode 词表）
 *
 * 本文件只含**纯类型、闭集与纯函数**（contracts 纪律：不 import 框架 / SQL / node:*）。
 * WP3 阶段没有任何运行时消费者（评估器/worker/Validator 在 WP4–WP8 才接线）；
 * `scripts/m8.5-wp3-contracts.ts` 是唯一读者，登记证明 = contracts/index.ts 的 re-export。
 *
 * 关键纪律（与 affect.ts 同构）：
 *   · 闭集先冻结、后实现——新码必须先改本文件（可审计）。
 *   · 模型无权指定的字段（sourceEventId / characterId / 版本 / epoch / delta / model profile）
 *     不出现在模型输出类型里；它们由程序在提案→事件阶段填写。
 *   · 传输失败与解析失败是两类：仅传输类可重试（Contract-Freeze §7）。
 */

import type { AffectImpactPayload, AffectRuleFamily } from './affect.ts'
import type { ConversationEventId, Timestamp } from './ids.ts'

// ---------------------------------------------------------------------------
// 身份常量（Contract-Freeze §1）
// ---------------------------------------------------------------------------

/** 语义策略版本（独立于 affect-rules@1；M85-D07） */
export const AFFECT_SEMANTIC_POLICY_VERSION = 'affect-semantic-policy@1' as const

/** 语义评估器 processor 名（job 行 + 幂等键分量） */
export const AFFECT_SEMANTIC_EVALUATOR_NAME = 'affect-semantic-evaluator' as const

/** 语义评估器版本 */
export const AFFECT_SEMANTIC_EVALUATOR_VERSION = 'affect-semantic-evaluator@1' as const

/** 扫描水位 processor（已扫描到的 source 序号，含不合格项推进） */
export const AFFECT_SEMANTIC_SCANNER_PROCESSOR = 'affect-semantic-scanner@1' as const

/** 语义完成水位 processor（已取得持久终态的 source 序号） */
export const AFFECT_SEMANTIC_WORKER_PROCESSOR = 'affect-semantic-worker@1' as const

/** 最后成功影响水位 processor */
export const AFFECT_SEMANTIC_IMPACT_PROCESSOR = 'affect-semantic-impact@1' as const

/**
 * 模式切换 cutover 边界 processor（§24 ②/③、§22.2、§23——M85-D20 的"模式切换
 * cutover 边界"）。存于既有水位表（零迁移）：`processedThroughSequence` = 边界
 * 账本序号，**序号 ≤ 边界的 source 永不语义评估**（M8-D05 同构）。
 *
 * 写入时机（只进不退——水位单调守卫即边界单调守卫）：
 * · 激活程序（§22.2）：受控 rebuild 后置为当时账本尾（激活 ADR 另记文档值）；
 * · 模式切离扫面（§24 ②"切换时刻记录切换边界"）：非 semantic 启动扫面把它
 *   推进到当时账本尾——切走期间词形消费过的 source 全部落到边界之前。
 * 残余窗口（扫面启动之后、切回之前出生的**中性** source）无词形 IMPACT 可供
 * 判别，时龄政策（120s）内可能被评估一次（单计不双计）——登记为已知局限，
 * 不假装关闭。有词形 IMPACT 的残余 source 由发现扫描的证据式跳过兜底。
 */
export const AFFECT_SEMANTIC_CUTOVER_NAME = 'affect-semantic-cutover' as const
export const AFFECT_SEMANTIC_CUTOVER_PROCESSOR = 'affect-semantic-cutover@1' as const

/**
 * 终结闸键前缀（跨版本稳定：与 processor/version/ruleId 无关——M85-D20）。
 * 闸在 ⇒ 该来源永不重评（换模型/提示词/策略版本都不重评）。
 */
export const AFFECT_SEMANTIC_FINALIZED_PREFIX = 'affect-semantic-finalized:' as const

/** 终结闸键：`affect-semantic-finalized:<sourceEventId>`（processed_operations 幂等键） */
export function affectSemanticFinalizedGateKey(sourceEventId: ConversationEventId): string {
  return `${AFFECT_SEMANTIC_FINALIZED_PREFIX}${String(sourceEventId)}`
}

/**
 * 语义 IMPACT 的幂等 operation 分量：`affect-semantic-impact:<family>:<sourceEventId>`。
 * 复合键含 processor+version（跨版本不撞键——闸存在的机器原因）；
 * 与 M8 词形路径的 `affect-impact:<ruleId>:<sourceEventId>` 永不冲突（前缀不同）。
 */
export function affectSemanticImpactIdempotencyOperation(
  family: AffectRuleFamily,
  sourceEventId: ConversationEventId,
): string {
  return `affect-semantic-impact:${family}:${String(sourceEventId)}`
}

// ---------------------------------------------------------------------------
// 模式开关（M85-D03；Contract-Freeze §2）
// ---------------------------------------------------------------------------

export type AffectSemanticMode = 'rules' | 'shadow' | 'semantic'

export const AFFECT_SEMANTIC_MODES: readonly AffectSemanticMode[] = ['rules', 'shadow', 'semantic']

/** 缺省模式：现行 M8 行为逐字不变；非法值失败关闭到 rules + warn */
export const AFFECT_SEMANTIC_DEFAULT_MODE: AffectSemanticMode = 'rules'

const AFFECT_SEMANTIC_MODE_SET: ReadonlySet<string> = new Set(AFFECT_SEMANTIC_MODES)

export function isAffectSemanticMode(value: string): value is AffectSemanticMode {
  return AFFECT_SEMANTIC_MODE_SET.has(value)
}

// ---------------------------------------------------------------------------
// 判定闭集（M85-D06；Contract-Freeze §3）
// ---------------------------------------------------------------------------

export type AffectSemanticDecision = 'IMPACT' | 'NEUTRAL' | 'UNCERTAIN' | 'OUT_OF_SCOPE'

export const AFFECT_SEMANTIC_DECISIONS: readonly AffectSemanticDecision[] = [
  'IMPACT',
  'NEUTRAL',
  'UNCERTAIN',
  'OUT_OF_SCOPE',
]

const AFFECT_SEMANTIC_DECISION_SET: ReadonlySet<string> = new Set(AFFECT_SEMANTIC_DECISIONS)

export function isAffectSemanticDecision(value: string): value is AffectSemanticDecision {
  return AFFECT_SEMANTIC_DECISION_SET.has(value)
}

/** 无影响判定（NO_IMPACT 终态的三种合法成因） */
export const AFFECT_SEMANTIC_NO_IMPACT_DECISIONS: readonly AffectSemanticDecision[] = [
  'NEUTRAL',
  'UNCERTAIN',
  'OUT_OF_SCOPE',
]

// ---------------------------------------------------------------------------
// reasonCode 闭集（Corpus-Spec §4 冻结的 16 词；只进 trace result 步，不进机器判分）
// ---------------------------------------------------------------------------

export type AffectSemanticReasonCode =
  | 'DIRECT_APPRECIATION'
  | 'IMPLIED_APPRECIATION'
  | 'APOLOGY_ACKNOWLEDGED'
  | 'RETRACTION_ISSUED'
  | 'DIRECT_WARMTH'
  | 'CHERISH_EXPRESSION'
  | 'REASSURANCE_OFFERED'
  | 'PRESSURE_RELIEF'
  | 'DIRECT_ATTACK'
  | 'REPROACH_IRONY'
  | 'CONTACT_REFUSED'
  | 'EXCLUSION_EXPRESSED'
  | 'IMMEDIATE_INTERVENTION_REQUESTED'
  | 'ORDINARY_INTERACTION'
  | 'INSUFFICIENT_CONTEXT'
  | 'AMBIGUOUS_STANCE'
  | 'NON_INTERACTION_CONTENT'
  | 'STATE_MANIPULATION_REQUEST'
  | 'META_INSTRUCTION'

export interface AffectSemanticReasonSpec {
  readonly code: AffectSemanticReasonCode
  readonly decision: AffectSemanticDecision
  /** 仅 IMPACT 码携带：该码合法的家族 */
  readonly family?: AffectRuleFamily
}

/** reasonCode → (decision, family?) 的冻结映射表（解析校验的判据源） */
export const AFFECT_SEMANTIC_REASON_TABLE: readonly AffectSemanticReasonSpec[] = [
  { code: 'DIRECT_APPRECIATION', decision: 'IMPACT', family: 'A-GRATITUDE' },
  { code: 'IMPLIED_APPRECIATION', decision: 'IMPACT', family: 'A-GRATITUDE' },
  { code: 'APOLOGY_ACKNOWLEDGED', decision: 'IMPACT', family: 'A-REPAIR' },
  { code: 'RETRACTION_ISSUED', decision: 'IMPACT', family: 'A-REPAIR' },
  { code: 'DIRECT_WARMTH', decision: 'IMPACT', family: 'A-WARM-CONTACT' },
  { code: 'CHERISH_EXPRESSION', decision: 'IMPACT', family: 'A-WARM-CONTACT' },
  { code: 'REASSURANCE_OFFERED', decision: 'IMPACT', family: 'A-COMFORT' },
  { code: 'PRESSURE_RELIEF', decision: 'IMPACT', family: 'A-COMFORT' },
  { code: 'DIRECT_ATTACK', decision: 'IMPACT', family: 'A-HOSTILE' },
  { code: 'REPROACH_IRONY', decision: 'IMPACT', family: 'A-HOSTILE' },
  { code: 'CONTACT_REFUSED', decision: 'IMPACT', family: 'A-REJECTION' },
  { code: 'EXCLUSION_EXPRESSED', decision: 'IMPACT', family: 'A-REJECTION' },
  { code: 'IMMEDIATE_INTERVENTION_REQUESTED', decision: 'IMPACT', family: 'A-URGENT' },
  { code: 'ORDINARY_INTERACTION', decision: 'NEUTRAL' },
  { code: 'INSUFFICIENT_CONTEXT', decision: 'UNCERTAIN' },
  { code: 'AMBIGUOUS_STANCE', decision: 'UNCERTAIN' },
  { code: 'NON_INTERACTION_CONTENT', decision: 'OUT_OF_SCOPE' },
  { code: 'STATE_MANIPULATION_REQUEST', decision: 'OUT_OF_SCOPE' },
  { code: 'META_INSTRUCTION', decision: 'OUT_OF_SCOPE' },
]

const AFFECT_SEMANTIC_REASON_BY_CODE = new Map(
  AFFECT_SEMANTIC_REASON_TABLE.map((spec) => [spec.code as string, spec]),
)

export function isAffectSemanticReasonCode(value: string): value is AffectSemanticReasonCode {
  return AFFECT_SEMANTIC_REASON_BY_CODE.has(value)
}

// ---------------------------------------------------------------------------
// span 协议（M85-D12；Contract-Freeze §5：原始输入 UTF-16 半开区间，不跨 surrogate）
// ---------------------------------------------------------------------------

export interface AffectSemanticSpan {
  /** 起始 UTF-16 code unit（含） */
  readonly start: number
  /** 结束 UTF-16 code unit（不含） */
  readonly end: number
}

const LOW_SURROGATE_MIN = 0xdc00
const LOW_SURROGATE_MAX = 0xdfff
const HIGH_SURROGATE_MIN = 0xd800
const HIGH_SURROGATE_MAX = 0xdbff

/**
 * span 合法性：`0 ≤ start < end ≤ message.length`，且区间不拆开 surrogate pair
 * ——start 处不得是低位代理项（不许从一对的中间开始），
 *   end−1 处不得是高位代理项（不许在一对的中间结束）。
 * 只证明"引用存在"，不证明"分类蕴含正确"（后者归语义验收，M85-D05）。
 */
export function isValidAffectSemanticSpan(span: AffectSemanticSpan, message: string): boolean {
  const { start, end } = span
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  if (start < 0 || end <= start || end > message.length) return false
  const first = message.charCodeAt(start)
  if (first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX) return false
  const last = message.charCodeAt(end - 1)
  if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) return false
  return true
}

// ---------------------------------------------------------------------------
// 结构化提案（模型输出的唯一合法形状；M85-D12/D13；Contract-Freeze §4）
// ---------------------------------------------------------------------------

export interface AffectSemanticCandidate {
  /** 七族之一（复用 M8 冻结家族——M85-D07） */
  readonly family: AffectRuleFamily
  /** 当前消息内的证据片段（span 只落当前消息，跨消息一律拒） */
  readonly span: AffectSemanticSpan
}

export const AFFECT_SEMANTIC_MAX_CANDIDATES = 3
export const AFFECT_SEMANTIC_MAX_CONTEXT_REFS = 6
/** 响应体硬上限（content 字符串的 UTF-16 code units；超限 = invalid_output） */
export const AFFECT_SEMANTIC_RESPONSE_CAP_UNITS = 16_384

/** 解析成功后的判定（权威字段全部缺席——由程序在提案→事件阶段填写） */
export interface AffectSemanticJudgment {
  readonly decision: AffectSemanticDecision
  readonly target: 'CHARACTER'
  /** IMPACT ⇒ 1..3；其余决定 ⇒ 恰为空 */
  readonly candidates: readonly AffectSemanticCandidate[]
  /** 只认本次请求分配的别名 m-1…m-6；伪造引用拒 */
  readonly contextRefs: readonly string[]
  readonly reasonCode: AffectSemanticReasonCode
}

// ---------------------------------------------------------------------------
// 解析失败闭集（§7.2；Contract-Freeze §10 计数器对齐）
// ---------------------------------------------------------------------------

/**
 * 解析层失败码（响应到达但不可成为合法判定）。
 * 传输层失败（超时/429/5xx/网络）**不在此列**——见 AffectSemanticTransportFailureCode；
 * 只有传输类可重试（Contract-Freeze §7）。
 */
export type AffectSemanticParseFailureCode =
  | 'missing_content'
  | 'refusal'
  | 'tool_calls'
  | 'truncated'
  | 'json_parse_failed'
  | 'schema_failed'
  | 'decision_candidate_mismatch'
  | 'forged_context_ref'
  | 'span_out_of_bounds'
  | 'span_splits_surrogate'
  | 'response_too_large'

export const AFFECT_SEMANTIC_PARSE_FAILURE_CODES: readonly AffectSemanticParseFailureCode[] = [
  'missing_content',
  'refusal',
  'tool_calls',
  'truncated',
  'json_parse_failed',
  'schema_failed',
  'decision_candidate_mismatch',
  'forged_context_ref',
  'span_out_of_bounds',
  'span_splits_surrogate',
  'response_too_large',
]

/** 传输层失败码——唯一可重试类别（重试烧尝试次数，≤ MAX_ATTEMPTS） */
export type AffectSemanticTransportFailureCode =
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'

export const AFFECT_SEMANTIC_TRANSPORT_FAILURE_CODES: readonly AffectSemanticTransportFailureCode[] =
  ['timeout', 'rate_limited', 'server_error', 'network_error']

const AFFECT_SEMANTIC_TRANSPORT_FAILURE_SET: ReadonlySet<string> = new Set(
  AFFECT_SEMANTIC_TRANSPORT_FAILURE_CODES,
)

export function isAffectSemanticTransportFailure(
  value: string,
): value is AffectSemanticTransportFailureCode {
  return AFFECT_SEMANTIC_TRANSPORT_FAILURE_SET.has(value)
}

// ---------------------------------------------------------------------------
// 有界上下文快照（M85-D10；Contract-Freeze §6）
// ---------------------------------------------------------------------------

export type AffectSemanticContextRole = 'user' | 'assistant'

/** 上文别名：m-1 = 最近一条先前消息 … m-6 = 最旧（当前消息不是 contextRef） */
export type AffectSemanticContextAlias = 'm-1' | 'm-2' | 'm-3' | 'm-4' | 'm-5' | 'm-6'

export const AFFECT_SEMANTIC_CONTEXT_ALIASES: readonly AffectSemanticContextAlias[] = [
  'm-1',
  'm-2',
  'm-3',
  'm-4',
  'm-5',
  'm-6',
]

const AFFECT_SEMANTIC_CONTEXT_ALIAS_SET: ReadonlySet<string> = new Set(AFFECT_SEMANTIC_CONTEXT_ALIASES)

export function isAffectSemanticContextAlias(value: string): value is AffectSemanticContextAlias {
  return AFFECT_SEMANTIC_CONTEXT_ALIAS_SET.has(value)
}

export interface AffectSemanticContextMessage {
  /** 脱敏说话者角色（assistant 只作显式标注的指代背景，§6.1） */
  readonly role: AffectSemanticContextRole
  readonly text: string
  readonly alias: AffectSemanticContextAlias
}

/** 上下文窗口：最旧在前；截断只移除完整最旧消息，当前消息永不截断 */
export interface AffectSemanticContextWindow {
  readonly messages: readonly AffectSemanticContextMessage[]
}

/**
 * 上下文版本：每个 source 的上下文事件引用 + 内容摘要在**首次任务创建时固定**；
 * 重试不读取后来新增的消息（Contract-Freeze §6）。
 */
export interface AffectSemanticContextVersion {
  readonly eventIds: readonly ConversationEventId[]
  /** 与 eventIds 一一对应的内容版本摘要（不含正文本身） */
  readonly contentDigests: readonly string[]
}

/** 出站请求的可变部分（固定指令文本由 WP4 冻结，不在此类型内） */
export interface AffectSemanticEvaluationRequest {
  readonly characterAlias: string
  readonly currentMessage: string
  readonly context: readonly AffectSemanticContextMessage[]
}

// ---------------------------------------------------------------------------
// 冻结预算 / 时间 / 重试 / 时龄 / 批量（Contract-Freeze §6/§7；改值 = 修订记录）
// ---------------------------------------------------------------------------

/** 单次模型超时（探针 max 11.6s ×1.7 头寸；判别器先例 25s） */
export const AFFECT_SEMANTIC_TIMEOUT_MS = 20_000
/** 输出 max_tokens（推理占 completion 91% 实测；2000 上限曾被烧穿；3000 仍偶发烧穿 ⇒
 *  2026-09-26 WP10 用户裁定上调 5000——ADR-068 §7 R-5；截断率进 §12.2 计数） */
export const AFFECT_SEMANTIC_MAX_TOKENS = 5_000
/** 输入 token 预算（估算口径；真实 usage 每次回填） */
export const AFFECT_SEMANTIC_INPUT_BUDGET_TOKENS = 3_000
/** 出站前字符守卫（组装后总文本 UTF-16 units；超限 ⇒ input_budget_exceeded，不出站） */
export const AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS = 6_000
/** 每 source 总尝试（含首次）；仅传输类可重试 */
export const AFFECT_SEMANTIC_MAX_ATTEMPTS = 2
/** 重试最短间隔 */
export const AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS = 2_000
/** Retry-After 遵守上限（仅在任务寿命内遵守） */
export const AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS = 60_000
/** 任务最大影响时龄（自 source createdAt；排队计入；到龄 ⇒ EXPIRED） */
export const AFFECT_SEMANTIC_MAX_AGE_MS = 120_000
/** 每次扫描批量上限 */
export const AFFECT_SEMANTIC_SCAN_BATCH_SIZE = 32
/** 上下文窗口消息数上限（当前消息之外） */
export const AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES = 6
/** 上下文回溯窗口 */
export const AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// 任务状态机（M85-D17；Contract-Freeze §7）
// ---------------------------------------------------------------------------

export type AffectSemanticTaskState =
  | 'DISCOVERED'
  | 'CLAIMED'
  | 'EVALUATING'
  | 'VALIDATED'
  | 'COMMITTED'
  | 'NO_IMPACT'
  | 'RETRYABLE_FAILED'
  | 'TERMINAL_FAILED'
  | 'EXPIRED'
  | 'CANCELLED_BY_MODE_CHANGE'
  | 'SOURCE_INVALIDATED'

export const AFFECT_SEMANTIC_TASK_STATES: readonly AffectSemanticTaskState[] = [
  'DISCOVERED',
  'CLAIMED',
  'EVALUATING',
  'VALIDATED',
  'COMMITTED',
  'NO_IMPACT',
  'RETRYABLE_FAILED',
  'TERMINAL_FAILED',
  'EXPIRED',
  'CANCELLED_BY_MODE_CHANGE',
  'SOURCE_INVALIDATED',
]

/** 可审计终态（闸行 + 完成水位推进的前提） */
export const AFFECT_SEMANTIC_TASK_TERMINAL_STATES: readonly AffectSemanticTaskState[] = [
  'COMMITTED',
  'NO_IMPACT',
  'TERMINAL_FAILED',
  'EXPIRED',
  'CANCELLED_BY_MODE_CHANGE',
  'SOURCE_INVALIDATED',
]

const AFFECT_SEMANTIC_TASK_TERMINAL_SET: ReadonlySet<string> = new Set(
  AFFECT_SEMANTIC_TASK_TERMINAL_STATES,
)

export function isAffectSemanticTaskTerminal(state: AffectSemanticTaskState): boolean {
  return AFFECT_SEMANTIC_TASK_TERMINAL_SET.has(state)
}

// ---------------------------------------------------------------------------
// 终结回执编码（Contract-Freeze §8.1 的冻结语法；承载于 processed_operations.operation）
// ---------------------------------------------------------------------------

/** 回执编码版本分量 */
export const AFFECT_SEMANTIC_RECEIPT_VERSION = 'affect-semantic@1' as const

/** 输入版本指纹：组装出站输入 SHA-256 的前 16 hex（计算在 WP4；此处只冻结形状） */
export type AffectSemanticInputFingerprint = string

const FINGERPRINT_RE = /^[0-9a-f]{16}$/

export function isAffectSemanticInputFingerprint(value: string): value is AffectSemanticInputFingerprint {
  return FINGERPRINT_RE.test(value)
}

/** COMMITTED 回执：`affect-semantic@1|COMMITTED|<FAMILY>|fp=<16hex>` */
export function encodeAffectSemanticCommittedReceipt(
  family: AffectRuleFamily,
  fingerprint: AffectSemanticInputFingerprint,
): string {
  return `${AFFECT_SEMANTIC_RECEIPT_VERSION}|COMMITTED|${family}|fp=${fingerprint}`
}

/** NO_IMPACT 回执：`affect-semantic@1|NO_IMPACT|<NEUTRAL|UNCERTAIN|OUT_OF_SCOPE>|fp=<16hex>` */
export function encodeAffectSemanticNoImpactReceipt(
  decision: 'NEUTRAL' | 'UNCERTAIN' | 'OUT_OF_SCOPE',
  fingerprint: AffectSemanticInputFingerprint,
): string {
  return `${AFFECT_SEMANTIC_RECEIPT_VERSION}|NO_IMPACT|${decision}|fp=${fingerprint}`
}

/** 其余终态回执：`affect-semantic@1|<TERMINAL>`（无判定则无 fp） */
export function encodeAffectSemanticTerminalReceipt(
  state: 'TERMINAL_FAILED' | 'EXPIRED' | 'CANCELLED_BY_MODE_CHANGE' | 'SOURCE_INVALIDATED',
): string {
  return `${AFFECT_SEMANTIC_RECEIPT_VERSION}|${state}`
}

// ---------------------------------------------------------------------------
// SOURCE_ANCHORED 时间语义（M85-D19；reducer@2 分支在 WP6/WP8 接线）
// ---------------------------------------------------------------------------

/** 语义 IMPACT 的时间语义标记（程序填写；历史事件无此字段 ⇒ 按 @1 行为折算） */
export type AffectSemanticTimingKind = 'SOURCE_ANCHORED'

export const AFFECT_SEMANTIC_TIMING_KINDS: readonly AffectSemanticTimingKind[] = ['SOURCE_ANCHORED']

/**
 * 语义 IMPACT 的 payload：M8 形状 + `sourceAt` + `timingKind`。
 * reducer@2 的 SOURCE_ANCHORED 分支：衰减结算到 sourceAt，**不推进** lastInteractionAt；
 * 无 timingKind 的历史事件在 @2 下与 @1 逐字一致（混合重放 A==B）。
 * ruleVersion 携带 AFFECT_SEMANTIC_POLICY_VERSION（不得伪装成 affect-rules@1 词形命中）。
 */
export interface AffectSemanticImpactPayload extends AffectImpactPayload {
  /** 来源事件时间（SOURCE_ANCHORED 衰减结算点） */
  readonly sourceAt: Timestamp
  readonly timingKind: AffectSemanticTimingKind
}
