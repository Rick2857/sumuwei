/** EBL v1: closed, inspectable claims. No executable model text or M9 status changes. */
import { fnv1a64Hex } from '../action/idempotency.ts'

export const EBL_EVENT = 'EPISTEMIC_BELIEF_RECORDED'
export const EBL_VERSION = 'epistemic-belief@2'
export const EBL_POLICY = 'epistemic-policy@3'
/** 工具域的**谓词闭集**（ADR-151 步骤 A 追加 write_precondition_holds；其它域**不得**放宽）。 */
export const EBL_TOOL_PREDICATES = ['readback_matches', 'document_extracts', 'write_precondition_holds'] as const
export const EBL_LIMIT = 128
/** A withdrawal can list every historical root; ordinary commands remain much smaller. */
export const EBL_EVENT_MAX_BYTES = 1024 * 1024
export type EblDomain = 'tool' | 'interpersonal'
export type EblStatus = 'pending' | 'validated' | 'suspended' | 'retired' | 'superseded' | 'withdrawn'
export type EblValue = boolean | 'concise' | 'detailed' | 'compare_only' | 'execute'
export interface EblSourceRef { kind: 'conversation' | 'action'; id: string }
export interface EblClaim {
  id: string
  characterId: string
  subjectId: string
  domain: EblDomain
  predicate: 'readback_matches' | 'document_extracts' | 'explanation_detail' | 'task_intent' | 'write_precondition_holds'
  expected: EblValue
  scope: string
  environment: string
  conditions: Record<string, string>
  formation: EblSourceRef
  predecessor?: string
  policy: 'epistemic-policy@1' | 'epistemic-policy@2' | typeof EBL_POLICY
}
export interface EblTest {
  id: string
  episodeId: string
  bindingKey: string
  designId: string
  /** Trusted action/interaction identity, fixed before the observation. */
  targetId: string
  /** Tool readback identity is known before execution; future human feedback ID is not. */
  source?: EblSourceRef
  anchor?: EblSourceRef
}
/** Supplied by a trusted source reader, never accepted from a model proposal. */
export interface EblObservation {
  ref: EblSourceRef
  characterId: string
  subjectId: string
  episodeId: string
  bindingKey: string
  environment: string
  targetId: string
  observedAt: number
  independentKey: string
  revision: string
  rootIds: string[]
  usable: boolean
  witnessed: boolean
  executed: boolean
  complete: boolean
  value?: EblValue
  excluded?: 'interface_failure' | 'transport_failure' | 'permission_denied' | 'cancelled'
  influencedBy: string[]
  /** Explicit persistent preferences can correct an inference without a pre-arranged experiment. */
  feedbackScope?: 'persistent' | 'turn'
}
export type EblVerdict = 'support' | 'counterexample' | 'inconclusive' | 'excluded'
/**
 * 一次结算**比的是哪一版**（2026-10-21 新增 · 认知能力建设计划 P2 第 4 步）。
 *
 * ⚠️ 为什么需要它：集成架构 §4 的「真实观察 → EBL：比较与结算」要求带上
 *    「对应**预测/规则/模型版本**」——
 *    没有它，账本里只说"这条命题被支持/被反驳了"，
 *    答不出"那是**哪一版模型**、**哪条规则**、**哪个对象**下的结论"。
 *    ⇒ 收益归因、失效追责、复现都缺一环。
 *
 * ⚠️ 它是**引用**，不是正文：不含任何私有内容，只含版本号与摘要。
 */
export interface EblModelBinding {
  /** 模型版本（"比的是哪一版模型"） */
  readonly modelVersion: string
  /** 规则版本（"是哪条规则的哪一版"） */
  readonly ruleVersion: string
  /** 预测的引用（谁产生的这次比较；没有就省略） */
  readonly predictionRef?: string
  /** 参数绑定摘要（"比的是哪个对象"；**摘要**，不是参数） */
  readonly parameterBindingDigest?: string
  /** 预测核对与原生证据结论分开；预测 mismatch 本身不决定信念反驳。 */
  readonly forecastVerdict?: 'match' | 'mismatch' | 'unknown'
}
export interface EblSettlement {
  testId: string
  observation: EblObservation
  verdict: EblVerdict
  independent: boolean
  /** 这次比较**比的是哪一版**（可选；没有模型参与时省略） */
  model?: EblModelBinding
}
export interface EblUse {
  decisionId: string
  before: string
  after: string
  context: { subjectId: string; scope: string; environment: string; conditions: Record<string, string> }
}
export type EblCommand =
  | { kind: 'propose'; claim: EblClaim }
  | { kind: 'register'; test: EblTest }
  | { kind: 'settle'; testId: string; source: EblSourceRef; model?: EblModelBinding }
  | { kind: 'correct'; source: EblSourceRef }
  | { kind: 'close_test'; testId: string; source: EblSourceRef }
  | { kind: 'review' }
  | { kind: 'retire' | 'withdraw' }
  | { kind: 'supersede'; successorId: string }
  | { kind: 'use'; use: EblUse }
export interface EblState {
  claim: EblClaim
  formation: EblObservation
  status: EblStatus
  formedAt: number
  tests: (EblTest & { registeredAt: number })[]
  evidence: EblSettlement[]
  corrections?: EblObservation[]
  closedTests?: { testId: string; source: EblObservation }[]
  uses: EblUse[]
  successorId?: string
  /** A fresh review is necessary after a source revision changes, including counterevidence. */
  reviewedFingerprint?: string
}
export interface EblEventPayload {
  claimId: string
  command: EblCommand
  settlement?: EblSettlement
  sourceFingerprint: string
  nextStatus: EblStatus
  forbiddenRoots?: string[]
  formation?: EblObservation
  correction?: EblObservation
  closure?: EblObservation
}
export interface EblSources {
  formation: EblObservation | undefined
  /** Exact references; includes both supports and counterexamples. */
  observations: readonly EblObservation[]
  fingerprint: string
}

export function eblAssert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`ebl_${code}`)
}
function short(value: unknown): asserts value is string {
  eblAssert(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value), 'invalid_token')
}
function object(value: unknown): asserts value is Record<string, unknown> {
  eblAssert(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_object')
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  eblAssert(Object.keys(value).every(key => allowed.includes(key)), 'unknown_field')
}
export function validateEblRef(value: unknown): EblSourceRef {
  object(value); fields(value, ['kind', 'id'])
  eblAssert(value.kind === 'conversation' || value.kind === 'action', 'invalid_source_kind'); short(value.id)
  return value as unknown as EblSourceRef
}
export function validateEblConditions(value: unknown): Record<string, string> {
  object(value)
  eblAssert(Object.keys(value).length > 0 && Object.keys(value).length <= 8, 'invalid_conditions')
  for (const [key, item] of Object.entries(value)) { eblAssert(/^[a-z][a-z0-9_]{0,39}$/.test(key), 'invalid_condition_key'); short(item) }
  return value as Record<string, string>
}
export function eblSignature(claim: Omit<EblClaim, 'id'>): string {
  return JSON.stringify([claim.characterId, claim.subjectId, claim.domain, claim.predicate, claim.expected,
    claim.scope, claim.environment, Object.entries(claim.conditions).sort(([a], [b]) => a.localeCompare(b)), claim.predecessor ?? '',
    // @1 identities remain replayable; revised policy forms a separate claim, never mutates the old one.
    ...(claim.policy === 'epistemic-policy@1' ? [] : [claim.policy])])
}
export function makeEblClaim(input: Omit<EblClaim, 'id' | 'policy'>): EblClaim {
  const candidate: Omit<EblClaim, 'id'> = { ...input, policy: EBL_POLICY }
  return validateEblClaim({ ...candidate, id: `ebl:${fnv1a64Hex(eblSignature(candidate))}` })
}
export function validateEblClaim(value: unknown): EblClaim {
  object(value)
  fields(value, ['id', 'characterId', 'subjectId', 'domain', 'predicate', 'expected', 'scope', 'environment', 'conditions', 'formation', 'predecessor', 'policy'])
  for (const key of ['id', 'characterId', 'subjectId', 'scope', 'environment']) short(value[key])
  if (value.predecessor !== undefined) short(value.predecessor)
  validateEblConditions(value.conditions); validateEblRef(value.formation)
  eblAssert(value.policy === EBL_POLICY || value.policy === 'epistemic-policy@1' || value.policy === 'epistemic-policy@2', 'policy_version')
  eblAssert(value.domain === 'tool' || value.domain === 'interpersonal', 'domain')
  eblAssert(value.domain === 'tool' ? (EBL_TOOL_PREDICATES as readonly string[]).includes(String(value.predicate)) && typeof value.expected === 'boolean'
    : value.predicate === 'explanation_detail' ? ['concise', 'detailed'].includes(String(value.expected))
      : value.predicate === 'task_intent' && ['compare_only', 'execute'].includes(String(value.expected)), 'predicate_value')
  const claim = value as unknown as EblClaim
  eblAssert(claim.id === `ebl:${fnv1a64Hex(eblSignature(claim))}`, 'claim_identity')
  return claim
}
export function validateEblCommand(value: unknown): EblCommand {
  object(value)
  switch (value.kind) {
    case 'propose': fields(value, ['kind', 'claim']); validateEblClaim(value.claim); break
    case 'register': {
      fields(value, ['kind', 'test']); object(value.test)
      fields(value.test, ['id', 'episodeId', 'bindingKey', 'designId', 'targetId', 'source', 'anchor'])
      for (const key of ['id', 'episodeId', 'bindingKey', 'designId', 'targetId']) short(value.test[key])
      if (value.test.source !== undefined) validateEblRef(value.test.source)
      if (value.test.anchor !== undefined) validateEblRef(value.test.anchor)
      break
    }
    case 'settle': fields(value, ['kind', 'testId', 'source', 'model']); short(value.testId); validateEblRef(value.source); if (value.model !== undefined) validateEblModelBinding(value.model); break
    case 'correct': fields(value, ['kind', 'source']); validateEblRef(value.source); break
    case 'close_test': fields(value, ['kind', 'testId', 'source']); short(value.testId); validateEblRef(value.source); break
    case 'supersede': fields(value, ['kind', 'successorId']); short(value.successorId); break
    case 'use': {
      fields(value, ['kind', 'use']); object(value.use); fields(value.use, ['decisionId', 'before', 'after', 'context'])
      for (const key of ['decisionId', 'before', 'after']) short(value.use[key])
      object(value.use.context); fields(value.use.context, ['subjectId', 'scope', 'environment', 'conditions'])
      for (const key of ['subjectId', 'scope', 'environment']) short(value.use.context[key])
      validateEblConditions(value.use.context.conditions); break
    }
    case 'review': case 'retire': case 'withdraw': fields(value, ['kind']); break
    default: eblAssert(false, 'command_kind')
  }
  return value as unknown as EblCommand
}
export const eblSourceKey = (ref: EblSourceRef): string => `${ref.kind}:${ref.id}`
/** JSONB reorders object keys. Identity and evidence comparisons must ignore that ordering. */
export function eblCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(eblCanonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${eblCanonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function validateEblObservation(value: unknown): EblObservation {
  object(value)
  fields(value, ['ref', 'characterId', 'subjectId', 'episodeId', 'bindingKey', 'environment', 'targetId', 'observedAt',
    'independentKey', 'revision', 'rootIds', 'usable', 'witnessed', 'executed', 'complete', 'value', 'excluded', 'influencedBy', 'feedbackScope'])
  validateEblRef(value.ref)
  for (const key of ['characterId', 'subjectId', 'episodeId', 'bindingKey', 'environment', 'targetId', 'independentKey', 'revision']) short(value[key])
  eblAssert(typeof value.observedAt === 'number' && Number.isFinite(value.observedAt) && value.observedAt >= 0, 'observation_time')
  for (const key of ['usable', 'witnessed', 'executed', 'complete']) eblAssert(typeof value[key] === 'boolean', 'observation_flag')
  for (const key of ['rootIds', 'influencedBy']) {
    const items = value[key]
    eblAssert(Array.isArray(items) && items.length <= 16 && new Set(items).size === items.length, 'observation_refs')
    items.forEach(short)
  }
  eblAssert((value.rootIds as string[]).length > 0, 'observation_roots')
  eblAssert(value.value === undefined || typeof value.value === 'boolean'
    || ['concise', 'detailed', 'compare_only', 'execute'].includes(String(value.value)), 'observation_value')
  eblAssert(value.excluded === undefined || ['interface_failure', 'transport_failure', 'permission_denied', 'cancelled'].includes(String(value.excluded)), 'observation_exclusion')
  eblAssert(value.feedbackScope === undefined || ['persistent', 'turn'].includes(String(value.feedbackScope)), 'feedback_scope')
  return value as unknown as EblObservation
}
/** 一次模型绑定的形状校验（闭集字段；值都是**引用/摘要**，不含正文） */
export function validateEblModelBinding(value: unknown): EblModelBinding {
  object(value)
  fields(value, ['modelVersion', 'ruleVersion', 'predictionRef', 'parameterBindingDigest', 'forecastVerdict'])
  short(value.modelVersion); short(value.ruleVersion)
  if (value.predictionRef !== undefined) short(value.predictionRef)
  if (value.parameterBindingDigest !== undefined) short(value.parameterBindingDigest)
  eblAssert(value.forecastVerdict === undefined || (typeof value.forecastVerdict === 'string'
    && ['match', 'mismatch', 'unknown'].includes(value.forecastVerdict)), 'model_forecast_verdict')
  return value as unknown as EblModelBinding
}

export function validateEblEventPayload(value: unknown): EblEventPayload {
  object(value); fields(value, ['claimId', 'command', 'settlement', 'sourceFingerprint', 'nextStatus', 'forbiddenRoots', 'formation', 'correction', 'closure'])
  short(value.claimId); short(value.sourceFingerprint); validateEblCommand(value.command)
  eblAssert(['pending', 'validated', 'suspended', 'retired', 'superseded', 'withdrawn'].includes(String(value.nextStatus)), 'event_status')
  if (value.settlement !== undefined) {
    object(value.settlement); fields(value.settlement, ['testId', 'observation', 'verdict', 'independent', 'model'])
    short(value.settlement.testId); validateEblObservation(value.settlement.observation)
    eblAssert(['support', 'counterexample', 'inconclusive', 'excluded'].includes(String(value.settlement.verdict)), 'settlement_verdict')
    eblAssert(typeof value.settlement.independent === 'boolean', 'settlement_independence')
    if (value.settlement.model !== undefined) validateEblModelBinding(value.settlement.model)
  }
  eblAssert((value.command as EblCommand).kind === 'settle' ? value.settlement !== undefined : value.settlement === undefined, 'settlement_shape')
  eblAssert((value.command as EblCommand).kind === 'propose' ? value.formation !== undefined : value.formation === undefined, 'formation_shape')
  if (value.formation !== undefined) validateEblObservation(value.formation)
  eblAssert((value.command as EblCommand).kind === 'correct' ? value.correction !== undefined : value.correction === undefined, 'correction_shape')
  if (value.correction !== undefined) validateEblObservation(value.correction)
  eblAssert((value.command as EblCommand).kind === 'close_test' ? value.closure !== undefined : value.closure === undefined, 'closure_shape')
  if (value.closure !== undefined) validateEblObservation(value.closure)
  if (value.forbiddenRoots !== undefined) {
    eblAssert((value.command as EblCommand).kind === 'withdraw' && Array.isArray(value.forbiddenRoots)
      && value.forbiddenRoots.length > 0 && value.forbiddenRoots.length <= 2048, 'forbidden_roots')
    value.forbiddenRoots.forEach(short)
  }
  return value as unknown as EblEventPayload
}
