/**
 * M8.5 语义评估器 —— 纯函数层（WP4；detached：WP6 worker 才消费）。
 *
 * 职责（计划 §15 WP4）：出站构造（含字符守卫与指纹）· 上下文装配（资格 + 回溯 +
 * 别名）· 严格解析（11 码闭集）· 程序映射（§5.3 全序 + 固定增量）· 失败分类。
 *
 * 权威源：ADR-068（M85-D10/D12/D13/D19）· Contract-Freeze §4–§6 · Corpus-Spec §2/§4。
 *
 * 纪律：
 *   · 模型无权指定的字段一律由程序填（M85-D12）。
 *   · 解析失败 ≠ 传输失败：本文件只产解析失败码；传输码归 WP5 provider。
 *   · 不记录模型自由解释 / 用户正文 / 原始响应——本层返回结构化结果，
 *     落盘纪律由调用方（WP6+）按 Contract-Freeze §9 执行。
 *   · 传输调用不在本层：`buildSemanticOutbound` + `parseSemanticJudgment`
 *     之间的一次 HTTP 属于 WP5 provider。
 */

import { createHash } from 'node:crypto'

import {
  AFFECT_SEMANTIC_CONTEXT_ALIASES,
  AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS,
  AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES,
  AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS,
  AFFECT_SEMANTIC_MAX_CANDIDATES,
  AFFECT_SEMANTIC_MAX_CONTEXT_REFS,
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_REASON_TABLE,
  AFFECT_SEMANTIC_RESPONSE_CAP_UNITS,
  isAffectSemanticContextAlias,
  isAffectSemanticDecision,
  isAffectSemanticReasonCode,
  isValidAffectSemanticSpan,
  type AffectSemanticCandidate,
  type AffectSemanticContextMessage,
  type AffectSemanticContextWindow,
  type AffectSemanticDecision,
  type AffectSemanticEvaluationRequest,
  type AffectSemanticInputFingerprint,
  type AffectSemanticJudgment,
  type AffectSemanticParseFailureCode,
  type AffectSemanticReasonCode,
  type AffectSemanticSpan,
} from '../../contracts/affect-semantic.ts'
import type { AffectRuleFamily } from '../../contracts/affect.ts'
import type { ConversationEvent } from '../../contracts/conversation-event.ts'
import { AFFECT_RULE_DELTAS, AFFECT_RULE_PRIORITY } from './patterns.ts'
import { AFFECT_SEMANTIC_INSTRUCTION, AFFECT_SEMANTIC_INSTRUCTION_VERSION } from './semantic-instruction.ts'

// ---------------------------------------------------------------------------
// 上下文装配（§6.1 资格矩阵 + §6.2 窗口上限）
// ---------------------------------------------------------------------------

/** 装配输入：source 坐标 + 候选先前事件（调用方给同会话的近期事件即可，过滤在这里） */
export interface SemanticContextAssemblyInput {
  readonly conversationId: string
  /** source 的角色级序号：只取序号更早的事件 */
  readonly sourceSequence: number
  /** source 发生时间：回溯窗口的锚（毫秒 epoch） */
  readonly sourceAt: number
  readonly candidates: readonly ConversationEvent[]
}

/**
 * 装配有界上下文窗口（纯函数）：
 * ① 只收 user_message / assistant_message（tool/system/external 不进——§6.1）；
 * ② 同一会话、序号早于 source；
 * ③ createdAt 距 source ≤ 30 分钟（回溯窗口；跨会话不拼接）；
 * ④ 取最近的 ≤6 条，别名 m-1（最近）… m-6（最旧）。
 * 字符守卫截断在 `buildSemanticOutbound` 做（需要指令尺寸一起算）。
 */
export function assembleSemanticContextWindow(
  input: SemanticContextAssemblyInput,
): AffectSemanticContextWindow {
  const eligible = input.candidates.filter((event) => {
    if (event.conversationId !== input.conversationId) return false
    if (event.sequence >= input.sourceSequence) return false
    if (event.type !== 'user_message' && event.type !== 'assistant_message') return false
    const age = input.sourceAt - Number(event.createdAt)
    if (age < 0 || age > AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS) return false
    return true
  })
  eligible.sort((a, b) => b.sequence - a.sequence) // 最近在前
  const selected = eligible.slice(0, AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES)
  const messages: AffectSemanticContextMessage[] = selected.map((event, index) => ({
    role: event.type === 'assistant_message' ? 'assistant' : 'user',
    text: event.content,
    alias: AFFECT_SEMANTIC_CONTEXT_ALIASES[index] as AffectSemanticContextMessage['alias'],
  }))
  return { messages }
}

// ---------------------------------------------------------------------------
// 出站构造（§6.3 出站与落盘 + §6.2 预算）
// ---------------------------------------------------------------------------

export interface SemanticOutbound {
  /** 组装后的完整出站文本（指令 + 输入块） */
  readonly text: string
  /** 出站输入指纹：SHA-256 前 16 hex（回执 fp 分量） */
  readonly fingerprint: AffectSemanticInputFingerprint
  /** 因字符守卫被整条移除的最旧上下文条数（审计计数） */
  readonly droppedContextMessages: number
  readonly instructionVersion: typeof AFFECT_SEMANTIC_INSTRUCTION_VERSION
}

export type SemanticOutboundResult =
  | { readonly ok: true; readonly outbound: SemanticOutbound }
  | { readonly ok: false; readonly reason: 'input_budget_exceeded' }

function renderInputBlock(request: AffectSemanticEvaluationRequest): string {
  const lines: string[] = []
  lines.push('【输入】')
  lines.push(`角色别名：${request.characterAlias}`)
  if (request.context.length > 0) {
    lines.push('【先前消息】（m-1 = 最近一条；assistant = 该角色说的话）')
    for (const message of request.context) {
      lines.push(`[${message.alias}] ${message.role}: ${message.text}`)
    }
  }
  lines.push('【当前消息】')
  lines.push(request.currentMessage)
  return lines.join('\n')
}

/**
 * 组装出站文本并施加字符守卫（Contract-Freeze §6）：
 * 守卫 = 指令 + 输入块的 UTF-16 总长 ≤ 6,000 units。
 * 超限时**只移除完整的最旧上下文消息**（整条，不截半句）；
 * 移除到零上下文仍超限（当前消息过长）⇒ `input_budget_exceeded`，不出站、不产生 IMPACT。
 * 当前消息永不截断。
 */
export function buildSemanticOutbound(request: AffectSemanticEvaluationRequest): SemanticOutboundResult {
  let context = [...request.context]
  let dropped = 0
  let text = ''
  for (;;) {
    const candidate: AffectSemanticEvaluationRequest = { ...request, context }
    text = `${AFFECT_SEMANTIC_INSTRUCTION}\n\n${renderInputBlock(candidate)}`
    if (text.length <= AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS) break
    if (context.length === 0) {
      return { ok: false, reason: 'input_budget_exceeded' }
    }
    // 移除最旧一条（别名数组语义上 m-6 端；重新渲染时别名保持 m-1..m-k 连续）
    context = context.slice(0, -1)
    dropped += 1
  }
  const fingerprint = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  return {
    ok: true,
    outbound: { text, fingerprint, droppedContextMessages: dropped, instructionVersion: AFFECT_SEMANTIC_INSTRUCTION_VERSION },
  }
}

// ---------------------------------------------------------------------------
// 严格解析（§7.2 解析纪律；失败码闭集 = AFFECT_SEMANTIC_PARSE_FAILURE_CODES）
// ---------------------------------------------------------------------------

/** provider 交付的响应信封（WP5 负责从 HTTP 抽出；此处只认闭集事实） */
export interface SemanticModelResponseEnvelope {
  readonly content: string | null
  /** OpenAI 风格 finish_reason（'stop' | 'length' | 'content_filter' | …） */
  readonly finishReason: string | null
  readonly hasToolCalls: boolean
  /** message.refusal 在场（OpenAI 拒答可伴随 finish_reason='stop'——WP5 透传事实） */
  readonly refusalPresent?: boolean
}

export type SemanticParseResult =
  | { readonly ok: true; readonly judgment: AffectSemanticJudgment }
  | { readonly ok: false; readonly failure: AffectSemanticParseFailureCode }

const JUDGMENT_KEYS = new Set(['decision', 'target', 'candidates', 'contextRefs', 'reasonCode'])
const CANDIDATE_KEYS = new Set(['family', 'span'])
const SPAN_KEYS = new Set(['start', 'end'])

function reasonSpecFor(code: string) {
  return AFFECT_SEMANTIC_REASON_TABLE.find((spec) => spec.code === code)
}

/**
 * 解析纪律（顺序即失败归因顺序）：
 * tool_calls → refusal → truncated → missing_content → response_too_large →
 * json_parse_failed → schema_failed → decision_candidate_mismatch →
 * forged_context_ref → span_out_of_bounds → span_splits_surrogate。
 * 不用第二次模型调用"修 JSON"；未知字段 / 未知枚举 / 数值 delta 一律 schema 拒。
 */
export function parseSemanticJudgment(
  envelope: SemanticModelResponseEnvelope,
  request: AffectSemanticEvaluationRequest,
): SemanticParseResult {
  if (envelope.hasToolCalls) return { ok: false, failure: 'tool_calls' }
  if (envelope.finishReason === 'content_filter' || envelope.refusalPresent === true) {
    return { ok: false, failure: 'refusal' }
  }
  if (envelope.finishReason === 'length') return { ok: false, failure: 'truncated' }
  if (typeof envelope.content !== 'string' || envelope.content.length === 0) {
    return { ok: false, failure: 'missing_content' }
  }
  if (envelope.content.length > AFFECT_SEMANTIC_RESPONSE_CAP_UNITS) {
    return { ok: false, failure: 'response_too_large' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(envelope.content)
  } catch {
    return { ok: false, failure: 'json_parse_failed' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: 'schema_failed' }
  }
  const root = parsed as Record<string, unknown>
  for (const key of Object.keys(root)) {
    if (!JUDGMENT_KEYS.has(key)) return { ok: false, failure: 'schema_failed' }
  }
  if (root.target !== 'CHARACTER') return { ok: false, failure: 'schema_failed' }
  const decision = root.decision
  if (typeof decision !== 'string' || !isAffectSemanticDecision(decision)) {
    return { ok: false, failure: 'schema_failed' }
  }
  const reasonCode = root.reasonCode
  if (typeof reasonCode !== 'string' || !isAffectSemanticReasonCode(reasonCode)) {
    return { ok: false, failure: 'schema_failed' }
  }
  const spec = reasonSpecFor(reasonCode)
  if (spec === undefined || spec.decision !== decision) {
    return { ok: false, failure: 'schema_failed' }
  }

  if (!Array.isArray(root.candidates) || !Array.isArray(root.contextRefs)) {
    return { ok: false, failure: 'schema_failed' }
  }
  if (root.candidates.length > AFFECT_SEMANTIC_MAX_CANDIDATES) {
    return { ok: false, failure: 'schema_failed' }
  }
  if (root.contextRefs.length > AFFECT_SEMANTIC_MAX_CONTEXT_REFS) {
    return { ok: false, failure: 'schema_failed' }
  }
  for (const ref of root.contextRefs) {
    // 形状不合法（非字符串 / 不在 m-1..m-6）= schema 拒
    if (typeof ref !== 'string' || !isAffectSemanticContextAlias(ref)) {
      return { ok: false, failure: 'schema_failed' }
    }
  }

  // decision ↔ candidates 一致性（§7.2：IMPACT 至少一项；其余恰为空）
  if (decision === 'IMPACT' && root.candidates.length === 0) {
    return { ok: false, failure: 'decision_candidate_mismatch' }
  }
  if (decision !== 'IMPACT' && root.candidates.length > 0) {
    return { ok: false, failure: 'decision_candidate_mismatch' }
  }

  // 伪造引用：形状合法但不在本次请求分配的别名里（含"无上下文却引用 m-1"）
  const assignedAliases = new Set(request.context.map((message) => message.alias as string))
  for (const ref of root.contextRefs as string[]) {
    if (!assignedAliases.has(ref)) {
      return { ok: false, failure: 'forged_context_ref' }
    }
  }

  const candidates: AffectSemanticCandidate[] = []
  for (const raw of root.candidates) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, failure: 'schema_failed' }
    }
    const candidate = raw as Record<string, unknown>
    for (const key of Object.keys(candidate)) {
      if (!CANDIDATE_KEYS.has(key)) return { ok: false, failure: 'schema_failed' }
    }
    if (typeof candidate.family !== 'string' || !AFFECT_RULE_PRIORITY.includes(candidate.family as AffectRuleFamily)) {
      return { ok: false, failure: 'schema_failed' }
    }
    const span = candidate.span
    if (
      typeof span !== 'object' || span === null || Array.isArray(span) ||
      Object.keys(span as Record<string, unknown>).some((key) => !SPAN_KEYS.has(key)) ||
      typeof (span as Record<string, unknown>).start !== 'number' ||
      typeof (span as Record<string, unknown>).end !== 'number' ||
      !Number.isInteger((span as Record<string, unknown>).start) ||
      !Number.isInteger((span as Record<string, unknown>).end)
    ) {
      return { ok: false, failure: 'schema_failed' }
    }
    candidates.push({
      family: candidate.family as AffectRuleFamily,
      span: span as unknown as AffectSemanticSpan,
    })
  }

  // IMPACT 的 reasonCode 家族必须落在候选家族里（判定自洽）
  if (decision === 'IMPACT') {
    const reasonFamily = reasonSpecFor(reasonCode)?.family
    if (reasonFamily === undefined || !candidates.some((c) => c.family === reasonFamily)) {
      return { ok: false, failure: 'schema_failed' }
    }
  }

  // span 校验：先界内，后代理对（两种失败分开计数——Contract-Freeze §10）
  for (const candidate of candidates) {
    if (
      candidate.span.start < 0 ||
      candidate.span.end <= candidate.span.start ||
      candidate.span.end > request.currentMessage.length
    ) {
      return { ok: false, failure: 'span_out_of_bounds' }
    }
    if (!isValidAffectSemanticSpan(candidate.span, request.currentMessage)) {
      return { ok: false, failure: 'span_splits_surrogate' }
    }
  }

  return {
    ok: true,
    judgment: {
      decision,
      target: 'CHARACTER',
      candidates,
      contextRefs: [...root.contextRefs] as string[],
      reasonCode,
    },
  }
}

// ---------------------------------------------------------------------------
// 程序映射（§5.3 全序 + 固定增量；模型无权指定数值）
// ---------------------------------------------------------------------------

export interface SemanticMapping {
  readonly decision: AffectSemanticDecision
  /** IMPACT 时的主导家族（全序裁定；其余决定为 undefined） */
  readonly dominantFamily: AffectRuleFamily | undefined
  /** IMPACT 时的固定增量（AFFECT_RULE_DELTAS 查表；其余决定为 undefined） */
  readonly delta: { readonly deltaValence: number; readonly deltaArousal: number } | undefined
  readonly reasonCode: AffectSemanticReasonCode
  readonly policyVersion: typeof AFFECT_SEMANTIC_POLICY_VERSION
}

/**
 * 候选 → 唯一主导类别（M8 冻结全序：HOSTILE > REJECTION > URGENT > REPAIR >
 * COMFORT > GRATITUDE > WARM-CONTACT）→ 固定增量查表。
 * 同一用户事件至多一条 IMPACT；不叠加、不按"强烈程度"加倍（M85-D13）。
 */
export function mapSemanticJudgment(judgment: AffectSemanticJudgment): SemanticMapping {
  if (judgment.decision !== 'IMPACT') {
    return {
      decision: judgment.decision,
      dominantFamily: undefined,
      delta: undefined,
      reasonCode: judgment.reasonCode,
      policyVersion: AFFECT_SEMANTIC_POLICY_VERSION,
    }
  }
  let dominant: AffectRuleFamily | undefined
  let bestRank = Number.MAX_SAFE_INTEGER
  for (const candidate of judgment.candidates) {
    const rank = AFFECT_RULE_PRIORITY.indexOf(candidate.family)
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank
      dominant = candidate.family
    }
  }
  if (dominant === undefined) {
    // 解析层已保证候选家族合法；此处防御性兜底（不可达路径，失败关闭语义）
    throw new Error('semantic_mapping_no_legal_family')
  }
  return {
    decision: 'IMPACT',
    dominantFamily: dominant,
    delta: AFFECT_RULE_DELTAS[dominant],
    reasonCode: judgment.reasonCode,
    policyVersion: AFFECT_SEMANTIC_POLICY_VERSION,
  }
}

// ---------------------------------------------------------------------------
// 门面：解析 + 映射一步完成（传输在 WP5 provider；本函数两侧都是纯的）
// ---------------------------------------------------------------------------

export type SemanticEvaluationOutcome =
  | { readonly kind: 'judgment'; readonly judgment: AffectSemanticJudgment; readonly mapping: SemanticMapping }
  | { readonly kind: 'parse_failed'; readonly failure: AffectSemanticParseFailureCode }

export function evaluateSemanticResponse(
  envelope: SemanticModelResponseEnvelope,
  request: AffectSemanticEvaluationRequest,
): SemanticEvaluationOutcome {
  const parsed = parseSemanticJudgment(envelope, request)
  if (!parsed.ok) return { kind: 'parse_failed', failure: parsed.failure }
  return { kind: 'judgment', judgment: parsed.judgment, mapping: mapSemanticJudgment(parsed.judgment) }
}
