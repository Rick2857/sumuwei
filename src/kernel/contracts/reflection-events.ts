/**
 * M11 **反思事件族**（ADR-085 §4.2 / §4.3 · `D03` · `D11` · `D28` · `D33`）。
 *
 * ============================================================================
 *  五条事件，各管一段生命周期
 * ============================================================================
 * ```text
 * REFLECTION_ORIGIN        首次建立的 cutover 标记（**结构性**，不回填历史 —— D33）
 * REFLECTION_PROPOSED      候选落库  ⇒ 状态 pending（**不等于采纳** —— D03/D28）
 * REFLECTION_REVIEWED      审查结论  ⇒ accepted / rejected（**一条结论一条事件**）
 * REFLECTION_INVALIDATED   失效      ⇒ retracted（append-only；旧记录不删 —— D11）
 * ADAPTIVE_SELF_REVISED    槽位版本变化（WP5 接线；本文件先**登记**形状）
 * ```
 *
 * ============================================================================
 *  三条硬边界（判据，不是注释）
 * ============================================================================
 * ① **payload 里没有正文之外的东西**：没有完整 prompt、没有模型隐藏推理、没有凭证。
 *    候选解释与焦点问题**是数据**（要审查、要人审），但它们**只进本域的事件**，
 *    不进 telemetry / 公共 artifact（§6 的两条隐私边界）。
 * ② **`rejected` / `retracted` 不许翻案**（§4.3）：要重新成立就走**新的**候选记录
 *    —— 翻案会抹掉"当时为什么拒"的因果（`INV-CI-05`）。
 * ③ **根是程序解析的**：`REFLECTION_PROPOSED` 里的 `roots` / `rootCount` 由
 *    WP2 的 `expandLineage()` 给出，**不是**模型自报（`D05`/`D06`）。
 *
 * ⚠️ 纯契约 + 纯函数（校验器抛**普通 `Error`**，与 `goal.ts` / `belief.ts` 同一分工：
 *    契约层抛 Error，策略层累积 `RejectedTarget`）。
 */

import { isReflectionSlot, type ReflectionRevisionIntent, type ReflectionSlot } from './reflection.ts'

// ---------------------------------------------------------------------------
// 事件类型常量（**登记**；接线在 WP4）
// ---------------------------------------------------------------------------

export const REFLECTION_ORIGIN = 'REFLECTION_ORIGIN' as const
export const REFLECTION_PROPOSED = 'REFLECTION_PROPOSED' as const
export const REFLECTION_REVIEWED = 'REFLECTION_REVIEWED' as const
export const REFLECTION_INVALIDATED = 'REFLECTION_INVALIDATED' as const
export const ADAPTIVE_SELF_REVISED = 'ADAPTIVE_SELF_REVISED' as const

export const REFLECTION_DOMAIN_EVENT_TYPES = [
  REFLECTION_ORIGIN,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
  REFLECTION_INVALIDATED,
  ADAPTIVE_SELF_REVISED,
] as const

export type ReflectionDomainEventType = (typeof REFLECTION_DOMAIN_EVENT_TYPES)[number]

export function isReflectionDomainEventType(value: unknown): value is ReflectionDomainEventType {
  return (
    typeof value === 'string' && (REFLECTION_DOMAIN_EVENT_TYPES as readonly string[]).includes(value)
  )
}

/** 记录形状版本（改形状必须升版本） */
export const REFLECTION_RECORD_SCHEMA_VERSION = 'reflection-record@1'

// ---------------------------------------------------------------------------
// 生命周期状态（§4.3 的合法边 / 非法边）
// ---------------------------------------------------------------------------

export type ReflectionStatus = 'pending' | 'accepted' | 'rejected' | 'retracted'

export const REFLECTION_STATUSES: readonly ReflectionStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'retracted',
]

/**
 * 合法边（**唯一**真值表）。
 *
 * ⚠️ `rejected → accepted` 与 `retracted → accepted` **不在表里**，这是刻意的：
 *    它们不是"暂时没实现"，而是**禁止**（§4.3：翻案会抹掉因果）。
 */
export const REFLECTION_LEGAL_TRANSITIONS: Readonly<
  Record<ReflectionStatus, readonly ReflectionStatus[]>
> = {
  pending: ['accepted', 'rejected', 'retracted'],
  accepted: ['retracted'],
  rejected: [],
  retracted: [],
}

export function reflectionTransitionAllowed(
  from: ReflectionStatus,
  to: ReflectionStatus
): boolean {
  return REFLECTION_LEGAL_TRANSITIONS[from].includes(to)
}

// ---------------------------------------------------------------------------
// payload 形状
// ---------------------------------------------------------------------------

export interface ReflectionOriginPayload {
  readonly activationId: string
  /** 首次建立的序号边界（**不是**投影字段 —— D33） */
  readonly cutoverSequence: number
  readonly policyVersion: string
}

export interface ReflectionProposedPayload {
  readonly reflectionId: string
  readonly focusQuestion: string
  readonly explanation: string
  readonly supportHandles: readonly string[]
  readonly counterHandles: readonly string[]
  readonly scope: string
  readonly suggestedSlot?: ReflectionSlot
  readonly revisionIntent?: ReflectionRevisionIntent
  /** **程序解析**的原始根（WP2 的 `expandLineage()`） */
  readonly roots: readonly string[]
  readonly rootCount: number
  /** 根落在几个不同会话里（`D10` 门槛的第二个分量） */
  readonly conversationCount: number
  readonly windowTruncated: boolean
  readonly jobId?: string
  /** 生成版本（可审计；**不**充当质量背书） */
  readonly modelVersion: string
  readonly promptVersion: string
  readonly inputWindowFingerprint: string
}

export type ReflectionReviewDecision = 'accepted' | 'rejected'

export interface ReflectionReviewedPayload {
  readonly reflectionId: string
  readonly decision: ReflectionReviewDecision
  /** 具名理由码（闭集；accepted 时为空数组） */
  readonly reasons: readonly string[]
  readonly rootCount: number
  readonly conversationCount: number
  readonly policyVersion: string
}

export type ReflectionInvalidationCause =
  | 'source_forgotten'
  | 'source_retracted'
  | 'source_version_changed'

export interface ReflectionInvalidatedPayload {
  readonly reflectionId: string
  readonly cause: ReflectionInvalidationCause
  /** 触发失效的**真实**事件 id（可追溯） */
  readonly causeEventId: string
}

export interface AdaptiveSelfRevisedPayload {
  readonly slot: ReflectionSlot
  readonly level: 'baseline' | 'enhanced'
  readonly revision: number
  readonly roots: readonly string[]
  readonly reason: string
}

// ---------------------------------------------------------------------------
// payload 校验（抛普通 Error；消息含事件类型与字段路径）
// ---------------------------------------------------------------------------

function fail(eventType: string, field: string, why: string): never {
  throw new Error(`${eventType} payload.${field} ${why}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(object: Record<string, unknown>, field: string, eventType: string): string {
  const value = object[field]
  if (typeof value !== 'string' || value.trim() === '') fail(eventType, field, '必须是非空字符串')
  return value
}

function requirePositiveInteger(
  object: Record<string, unknown>,
  field: string,
  eventType: string
): number {
  const value = object[field]
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail(eventType, field, `必须是非负整数（收到 ${JSON.stringify(value)}）`)
  }
  return value as number
}

function requireStringArray(
  object: Record<string, unknown>,
  field: string,
  eventType: string
): string[] {
  const value = object[field]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    fail(eventType, field, '必须是字符串数组（不许含空元素）')
  }
  return value as string[]
}

export function validateReflectionOriginPayload(payload: unknown): ReflectionOriginPayload {
  const eventType = REFLECTION_ORIGIN
  if (!isRecord(payload)) fail(eventType, '(root)', '必须是对象')
  return {
    activationId: requireString(payload, 'activationId', eventType),
    cutoverSequence: requirePositiveInteger(payload, 'cutoverSequence', eventType),
    policyVersion: requireString(payload, 'policyVersion', eventType),
  }
}

export function validateReflectionProposedPayload(payload: unknown): ReflectionProposedPayload {
  const eventType = REFLECTION_PROPOSED
  if (!isRecord(payload)) fail(eventType, '(root)', '必须是对象')
  const rootCount = requirePositiveInteger(payload, 'rootCount', eventType)
  const roots = requireStringArray(payload, 'roots', eventType)
  if (rootCount !== roots.length) {
    fail(eventType, 'rootCount', `必须等于 roots.length（${String(rootCount)} vs ${String(roots.length)}）`)
  }
  const base = {
    reflectionId: requireString(payload, 'reflectionId', eventType),
    focusQuestion: requireString(payload, 'focusQuestion', eventType),
    explanation: requireString(payload, 'explanation', eventType),
    supportHandles: requireStringArray(payload, 'supportHandles', eventType),
    counterHandles: requireStringArray(payload, 'counterHandles', eventType),
    scope: requireString(payload, 'scope', eventType),
    roots,
    rootCount,
    conversationCount: requirePositiveInteger(payload, 'conversationCount', eventType),
    windowTruncated: payload.windowTruncated === true,
    modelVersion: requireString(payload, 'modelVersion', eventType),
    promptVersion: requireString(payload, 'promptVersion', eventType),
    inputWindowFingerprint: requireString(payload, 'inputWindowFingerprint', eventType),
  }
  const withOptional: ReflectionProposedPayload = {
    ...base,
    ...(payload.suggestedSlot === undefined
      ? {}
      : { suggestedSlot: payload.suggestedSlot as ReflectionSlot }),
    ...(payload.revisionIntent === undefined
      ? {}
      : { revisionIntent: payload.revisionIntent as ReflectionRevisionIntent }),
    ...(payload.jobId === undefined ? {} : { jobId: String(payload.jobId) }),
  }
  return withOptional
}

export function validateReflectionReviewedPayload(payload: unknown): ReflectionReviewedPayload {
  const eventType = REFLECTION_REVIEWED
  if (!isRecord(payload)) fail(eventType, '(root)', '必须是对象')
  const decision = payload.decision
  if (decision !== 'accepted' && decision !== 'rejected') {
    fail(eventType, 'decision', `必须是 accepted | rejected（收到 ${JSON.stringify(decision)}）`)
  }
  const reasons = requireStringArray(payload, 'reasons', eventType)
  if (decision === 'accepted' && reasons.length > 0) {
    fail(eventType, 'reasons', 'accepted 时不得带理由码（采纳不是"有问题的采纳"）')
  }
  return {
    reflectionId: requireString(payload, 'reflectionId', eventType),
    decision,
    reasons,
    rootCount: requirePositiveInteger(payload, 'rootCount', eventType),
    conversationCount: requirePositiveInteger(payload, 'conversationCount', eventType),
    policyVersion: requireString(payload, 'policyVersion', eventType),
  }
}

export function validateReflectionInvalidatedPayload(
  payload: unknown
): ReflectionInvalidatedPayload {
  const eventType = REFLECTION_INVALIDATED
  if (!isRecord(payload)) fail(eventType, '(root)', '必须是对象')
  const cause = payload.cause
  if (cause !== 'source_forgotten' && cause !== 'source_retracted' && cause !== 'source_version_changed') {
    fail(eventType, 'cause', `不在闭集（收到 ${JSON.stringify(cause)}）`)
  }
  return {
    reflectionId: requireString(payload, 'reflectionId', eventType),
    cause,
    causeEventId: requireString(payload, 'causeEventId', eventType),
  }
}

export function validateAdaptiveSelfRevisedPayload(payload: unknown): AdaptiveSelfRevisedPayload {
  const eventType = ADAPTIVE_SELF_REVISED
  if (!isRecord(payload)) fail(eventType, '(root)', '必须是对象')
  const level = payload.level
  if (level !== 'baseline' && level !== 'enhanced') {
    fail(eventType, 'level', `必须是 baseline | enhanced（收到 ${JSON.stringify(level)}）`)
  }
  /*
   * ⚠️ 槽位必须在这里就查**闭集**（`D09`）。
   *
   * 实测教训（WP5 的门抓到的）：第一版只 `requireString` 后**强转** `ReflectionSlot`
   * ⇒ 一个闭集外的槽（`reconcile_goal`）能一路写进账本与投影行，
   * 而"三槽闭集"就只剩文档上的一句话。策略层虽然会拦（规划时 `slot_out_of_scope`），
   * 但**契约层**是最后一道形状闸 —— 它不该把越界值放行。
   */
  const slot = requireString(payload, 'slot', eventType)
  if (!isReflectionSlot(slot)) {
    fail(eventType, 'slot', `不在三槽闭集（收到 ${JSON.stringify(slot)}）`)
  }
  return {
    slot,
    level,
    revision: requirePositiveInteger(payload, 'revision', eventType),
    roots: requireStringArray(payload, 'roots', eventType),
    reason: requireString(payload, 'reason', eventType),
  }
}

// ---------------------------------------------------------------------------
// 折叠后的记录形状（投影行 state）
// ---------------------------------------------------------------------------

export interface ReflectionRecordState {
  readonly reflectionId: string
  readonly schemaVersion: typeof REFLECTION_RECORD_SCHEMA_VERSION
  readonly status: ReflectionStatus
  readonly focusQuestion: string
  readonly explanation: string
  readonly supportHandles: readonly string[]
  readonly counterHandles: readonly string[]
  readonly scope: string
  readonly suggestedSlot?: ReflectionSlot
  readonly revisionIntent?: ReflectionRevisionIntent
  /** **程序解析**的原始根 */
  readonly roots: readonly string[]
  readonly rootCount: number
  readonly conversationCount: number
  /** 审查结论（pending 时为空） */
  readonly reviewReasons: readonly string[]
  readonly generatedBy: {
    readonly modelVersion: string
    readonly promptVersion: string
    readonly inputWindowFingerprint: string
  }
  /** 发生过的转换（事件 id，供回放审计） */
  readonly lifecycleEventIds: readonly string[]
  readonly lastEventAt?: number
}
