/**
 * M11 **反思放行口**（ADR-085 `D08` · §4.5 · §4.3）—— 审查与生命周期转换的**唯一**放行口。
 *
 * ============================================================================
 *  它在整条链里的位置
 * ============================================================================
 * ```text
 * 草案（WP3 已过结构闭集）→ 程序解析根（WP2）→ 【本文件】→ 事件 → 折叠（projections/reflection.ts）
 *                                                    ↑
 *                                        **只有**它能产 reviewed / invalidated 的结论
 * ```
 *
 * ============================================================================
 *  四条硬边界（判据，不是注释）
 * ============================================================================
 * ① **候选 ≠ 采纳**（`D03`/`D28`）：`propose()` 只落 `pending`；
 *    `review()` 才可能给出 accepted。两个动作**两个事件**，读面能分别回答。
 * ② **模型不自批**（`D08`）：本函数的入参里**没有**任何"模型说它可靠 / 置信度"的位置。
 *    判定**只**由程序事实决定：来源资格、门槛（`D10`）、未解决冲突、重复审查、状态机。
 * ③ **失败关闭**：没给来源资格读数 ⇒ 当**不可用**处理（不是"当作合格"）；
 *    端口抛错由调用方处理成 `unavailable`（先例：`recheckGoalDependencies`）。
 * ④ **门槛的两种"没到"要分开**（`D10`）：根数不够（`threshold_not_met` / `single_root_only`）
 *    与会话数不够（`single_session_only`）是不同的读数，合并会让"该多聊几次"与
 *    "该多来几件独立的事"看起来一样。
 */

import {
  meetsStabilityThreshold,
  type StabilityThresholdReason,
} from '../app/reflection/inputs.ts'
import type { ReflectionDraft } from '../contracts/reflection.ts'
import type { CharacterId, ProcessorVersion } from '../contracts/ids.ts'
import type { DomainProposal, ProposedDomainEvent } from '../contracts/proposal.ts'
import type { DomainEventRegistry } from '../contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_ORIGIN,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
} from '../contracts/reflection-events.ts'
import { computeIdempotencyKey } from '../contracts/job.ts'
import {
  DOMAIN_EVENT_SCOPE,
  assertCharacterInternalScope,
} from '../contracts/domain-event.ts'
import type { AcceptedDomainEvent, ProcessedOperationStore, RejectedTarget, ValidatorOutcome } from './validator.ts'

/** 策略版本（写进 reviewed payload；改判据必须升版本） */
export const REFLECTION_POLICY_VERSION = 'reflection-policy@1'

/**
 * **审查理由码的闭集**（ADR-085 §6.2 · 计划 §12.1 的"理由码生产者"）。
 *
 * ⚠️ 这一格是**补上的**：第一版 `reviewReflection()` 直接把字符串推进 `reasons: string[]`，
 *    于是"有哪些理由码"只能靠读代码 —— 而"闭集 + 可达性事实"是本里程碑的硬要求
 *    （`m11:observability:verify` 的 A6 就是它的机器判据）。
 * ⚠️ 类型收紧之后，**再想推一个闭集外的码就是编译错误**（这是它存在的意义）。
 */
export const REFLECTION_REVIEW_REASONS = [
  'duplicate_review',
  'source_forgotten',
  'source_retracted',
  'source_version_changed',
  'threshold_not_met',
  'single_root_only',
  'single_session_only',
  'conflicting_support',
] as const

export type ReflectionReviewReason = (typeof REFLECTION_REVIEW_REASONS)[number]

/** 每个码的**可达性事实**（`producer` 里点名的函数必须真的含这个码 —— 门会去核） */
export const REFLECTION_REVIEW_REASON_FACTS: Readonly<
  Record<ReflectionReviewReason, { reachable: true; producer: string; howToReach: string }>
> = {
  duplicate_review: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的 `alreadyReviewed` 分支',
    howToReach: '同一条反思被审第二次（`alreadyReviewed = true`）',
  },
  source_forgotten: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的来源资格循环',
    howToReach: '某条根的资格读数是 `source_forgotten`（用户让它忘掉）',
  },
  source_retracted: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的来源资格循环',
    howToReach: '某条根被撤回（`source_retracted`）',
  },
  source_version_changed: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的来源资格循环',
    howToReach: '版本漂移，**或**资格读数是 `unavailable`（读不到 ⇒ 版本无法确认）',
  },
  threshold_not_met: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的 `meetsStabilityThreshold()` 分支',
    howToReach: '独立根数不足（`D10` 要求 ≥3 个去重根）',
  },
  single_root_only: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的 `meetsStabilityThreshold()` 分支',
    howToReach: '只有一个独立根（复述不算第二根）',
  },
  single_session_only: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的 `meetsStabilityThreshold()` 分支',
    howToReach: '只在一个会话里出现过（`D10` 要求 ≥2 个会话）',
  },
  conflicting_support: {
    reachable: true,
    producer: 'reflection-validator.ts · reviewReflection() 的 `meetsStabilityThreshold()` 分支',
    howToReach: '存在未解决的反例（`unresolvedConflict = true`）',
  },
}

/** 一条来源引用的**资格读数**（由调用方按各域既有资格链给出） */
export interface ReflectionSourceVerdict {
  readonly handleId: string
  readonly usable: boolean
  /** 不可用时的具名原因（闭集见验收契约 §3.3 的「资格 / 版本」族） */
  readonly reason?:
    | 'source_forgotten'
    | 'source_retracted'
    | 'source_version_changed'
    | 'unavailable'
}

/** 程序侧的候选（**不是**模型输出；由 WP3 的输入 + 草案 + WP2 的根解析装配） */
export interface ReflectionProposal {
  readonly reflectionId: string
  readonly characterId: string
  readonly draft: ReflectionDraft
  /** **程序解析**的原始根（`expandLineage()` 的输出） */
  readonly roots: readonly string[]
  readonly conversationCount: number
  readonly windowTruncated: boolean
  /** 每个被引用的 handle 的资格读数 */
  readonly sourceVerdicts: readonly ReflectionSourceVerdict[]
  /** 有没有**未解决**的直接冲突（反例尚未被解释掉） */
  readonly unresolvedConflict: boolean
  /** 该候选是否已经被审查过（去重） */
  readonly alreadyReviewed: boolean
}

export interface ReflectionReviewOutcome {
  readonly decision: 'accepted' | 'rejected'
  /** 具名理由码（accepted 时为空数组） */
  readonly reasons: readonly string[]
  readonly rootCount: number
  readonly conversationCount: number
  readonly policyVersion: typeof REFLECTION_POLICY_VERSION
}

/**
 * 审查（**唯一**能给出 accepted 的地方）。
 *
 * 顺序（先到先拒，理由码不合并）：
 * ① 重复审查 → ② 来源资格（**逐条**：不可用的来源一律拒） →
 * ③ 未解决冲突 → ④ 门槛（根数 / 会话数）。
 */
export function reviewReflection(proposal: ReflectionProposal): ReflectionReviewOutcome {
  /*
   * ⚠️ 类型收紧到**闭集**：推一个闭集外的码 = 编译错误（第一版是 `string[]`，靠读代码才知道有哪些码）。
   */
  const reasons: ReflectionReviewReason[] = []

  if (proposal.alreadyReviewed) reasons.push('duplicate_review')

  for (const verdict of proposal.sourceVerdicts) {
    if (verdict.usable) continue
    // 资格不可用：按各域给的具名原因分列（不合并成一句"来源有问题"）
    const reason =
      verdict.reason === 'source_forgotten' ||
      verdict.reason === 'source_retracted' ||
      verdict.reason === 'source_version_changed'
        ? verdict.reason
        : 'source_version_changed' // `unavailable` 归到"读不到 ⇒ 版本无法确认"
    reasons.push(reason)
  }

  const stability = meetsStabilityThreshold({
    rootCount: proposal.roots.length,
    conversationCount: proposal.conversationCount,
    unresolvedConflict: proposal.unresolvedConflict,
  })
  if (!stability.met) reasons.push(stability.reason satisfies StabilityThresholdReason)

  return {
    decision: reasons.length === 0 ? 'accepted' : 'rejected',
    reasons,
    rootCount: proposal.roots.length,
    conversationCount: proposal.conversationCount,
    policyVersion: REFLECTION_POLICY_VERSION,
  }
}

/**
 * **状态机**：这次转换合不合法（§4.3 的唯一真值表）。
 *
 * ⚠️ 它**只**回答"能不能转"；"该不该转"是 `reviewReflection()` 的事 ——
 *    两者分开，是为了让"非法边"与"证据不足"在读数上永远可分辨。
 */
export function reviewTransitionAllowed(
  from: 'pending' | 'accepted' | 'rejected' | 'retracted',
  to: 'pending' | 'accepted' | 'rejected' | 'retracted'
): boolean {
  const table: Record<string, readonly string[]> = {
    pending: ['accepted', 'rejected', 'retracted'],
    accepted: ['retracted'],
    rejected: [],
    retracted: [],
  }
  return (table[from] ?? []).includes(to)
}

// ---------------------------------------------------------------------------
// 幂等键：**自带确定性事件身份**（ADR-085 `D26`）
// ---------------------------------------------------------------------------

/**
 * 本域的**单元操作串**（幂等键的第 5 个分量）。
 *
 * ⚠️ 这是 `D26` 的落点，而且它是**被实测逼出来的**：
 *    第一版门用通用放行口发两条 `REFLECTION_PROPOSED`（同一个窗口、同一个 processor 版本、
 *    同一个 operation），于是它们的幂等键**完全相同** ⇒ 第二条被静默去重 ⇒
 *    **两条不同的反思塌成一条**。
 *    通用键只含 `character|processor|version|source-range|operation`，而反思的**身份**
 *    是 `reflectionId`（不是"哪个窗口"）⇒ 必须自带单元串（先例：`goalUnitOperationOf()`）。
 */
export function reflectionUnitOperationOf(target: ProposedDomainEvent): string | undefined {
  const payload = target.payload as Record<string, unknown> | undefined
  if (payload === undefined) return undefined
  const reflectionId = typeof payload.reflectionId === 'string' ? payload.reflectionId : undefined

  switch (target.type) {
    case REFLECTION_ORIGIN:
      return 'reflection-origin'
    case REFLECTION_PROPOSED:
      return reflectionId === undefined ? undefined : `reflection-proposed:${reflectionId}`
    case REFLECTION_REVIEWED: {
      const decision = typeof payload.decision === 'string' ? payload.decision : undefined
      return reflectionId === undefined || decision === undefined
        ? undefined
        : `reflection-reviewed:${reflectionId}:${decision}`
    }
    case REFLECTION_INVALIDATED: {
      const causeEventId = typeof payload.causeEventId === 'string' ? payload.causeEventId : undefined
      return reflectionId === undefined || causeEventId === undefined
        ? undefined
        : `reflection-invalidated:${reflectionId}:${causeEventId}`
    }
    case ADAPTIVE_SELF_REVISED: {
      const slot = typeof payload.slot === 'string' ? payload.slot : undefined
      const revision = typeof payload.revision === 'number' ? String(payload.revision) : undefined
      return slot === undefined || revision === undefined
        ? undefined
        : `adaptive-self-revised:${slot}:${revision}`
    }
    default:
      return undefined
  }
}

/** 本域的幂等键（**唯一**算法；装配与门都必须走这里） */
export function idempotencyKeyForReflectionEvent(input: {
  characterId: CharacterId
  processor: string
  processorVersion: ProcessorVersion
  sourceFromSequence: number
  sourceToSequence: number
  unitOperation: string
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: input.sourceFromSequence,
    sourceToSequence: input.sourceToSequence,
    operation: input.unitOperation,
  })
}

// ---------------------------------------------------------------------------
// 本域的放行口（唯一；`D08`）
// ---------------------------------------------------------------------------

/** 每个候选的**程序事实**（门槛 / 来源资格 / 冲突 / 是否已审查） */
export interface ReflectionReviewFacts {
  readonly roots: readonly string[]
  readonly conversationCount: number
  readonly unresolvedConflict: boolean
  readonly sourceVerdicts: readonly ReflectionSourceVerdict[]
  readonly alreadyReviewed: boolean
}

export interface ReflectionValidatorDeps {
  readonly registry: DomainEventRegistry
  readonly processed: ProcessedOperationStore
  /** 按 `reflectionId` 给程序事实（**不是**模型输出） */
  readonly reviewFacts: (reflectionId: string) => ReflectionReviewFacts | undefined
  /** 单条 payload 的兜底字节上限（registry 未声明时用） */
  readonly fallbackMaxBytes?: number
}

/**
 * 反思域的放行口。
 *
 * 比通用放行口多两件事（都是 `D08`/`D26` 的要求）：
 * ① **域内幂等键**（`reflectionUnitOperationOf`）—— 两条不同的反思不会塌成一条；
 * ② **结论必须与策略一致**：`REFLECTION_REVIEWED` 的 payload 说 accepted 而
 *    `reviewReflection()` 说 rejected ⇒ 拒收（`not_fact_authority`）。
 *    ⇒ 发射方**无法**夹带一个"模型自批"的结论。
 */
export async function validateReflectionProposal(
  deps: ReflectionValidatorDeps,
  proposal: DomainProposal
): Promise<ValidatorOutcome> {
  const rejected: RejectedTarget[] = []
  const acceptedEvents: AcceptedDomainEvent[] = []
  const fallbackMaxBytes = deps.fallbackMaxBytes ?? 4096

  for (const target of proposal.targetEvents) {
    const spec = deps.registry.get(target.type)
    if (spec === undefined) {
      rejected.push({
        type: target.type,
        code: 'domain_event_type_unregistered',
        message: `${target.type} 未在 DomainEventRegistry 登记`,
      })
      continue
    }
    let payload: unknown
    try {
      payload = spec.validatePayload(target.payload)
    } catch (error) {
      rejected.push({
        type: target.type,
        code: 'payload_schema_invalid',
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const unit = reflectionUnitOperationOf(target)
    if (unit === undefined) {
      rejected.push({
        type: target.type,
        code: 'reflection_unit_operation_missing',
        message: `${target.type} 的 payload 缺少确定身份（reflectionId / decision / causeEventId / slot+revision）`,
      })
      continue
    }

    // 结论必须与策略一致（发射方不得夹带采纳）
    if (target.type === REFLECTION_REVIEWED) {
      const claimed = payload as { reflectionId: string; decision: string; reasons: readonly string[] }
      const facts = deps.reviewFacts(String(claimed.reflectionId))
      if (facts === undefined) {
        rejected.push({
          type: target.type,
          code: 'reflection_review_facts_missing',
          message: `没有 ${String(claimed.reflectionId)} 的程序事实 ⇒ 无法复核结论（失败关闭）`,
        })
        continue
      }
      const verdict = reviewReflection({
        reflectionId: String(claimed.reflectionId),
        characterId: String(proposal.characterId),
        draft: { schemaVersion: 'reflection-draft@1', focusQuestion: 'x', explanation: 'x', supportHandles: [], counterHandles: [], scope: 'current_character_user' },
        roots: facts.roots,
        conversationCount: facts.conversationCount,
        windowTruncated: false,
        sourceVerdicts: facts.sourceVerdicts,
        unresolvedConflict: facts.unresolvedConflict,
        alreadyReviewed: facts.alreadyReviewed,
      })
      if (verdict.decision !== claimed.decision || verdict.reasons.join(',') !== claimed.reasons.join(',')) {
        rejected.push({
          type: target.type,
          code: 'not_fact_authority',
          message: `payload 的结论（${String(claimed.decision)}:${claimed.reasons.join(',')}）与策略判定（${verdict.decision}:${verdict.reasons.join(',')}）不一致 —— 发射方不得夹带采纳`,
        })
        continue
      }
    }

    const sourceFrom = proposal.sourceConversationEventIds.length === 0 ? 0 : 1
    const key = idempotencyKeyForReflectionEvent({
      characterId: proposal.characterId,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      sourceFromSequence: sourceFrom,
      sourceToSequence: sourceFrom,
      unitOperation: unit,
    })
    let duplicate = false
    try {
      duplicate = await deps.processed.hasProcessed(key)
    } catch (error) {
      rejected.push({
        type: target.type,
        code: 'idempotency_lookup_failed',
        message: `幂等查询失败：${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    if (duplicate) {
      rejected.push({
        type: target.type,
        code: 'duplicate_operation',
        message: `幂等键已处理过（单元操作 ${unit}）`,
      })
      continue
    }

    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length
    const limit = spec.maxPayloadBytes || fallbackMaxBytes
    if (bytes > limit) {
      rejected.push({ type: target.type, code: 'payload_too_large', message: `${String(bytes)} > ${String(limit)}` })
      continue
    }

    const scope = target.scope ?? DOMAIN_EVENT_SCOPE
    try {
      assertCharacterInternalScope(scope)
    } catch (error) {
      rejected.push({
        type: target.type,
        code: 'domain_event_scope_not_character_internal',
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    acceptedEvents.push({
      type: target.type,
      operation: unit,
      payload,
      sourceConversationEventIds: [...proposal.sourceConversationEventIds],
      idempotencyKey: key,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      scope,
    })
  }

  const accepted = rejected.length === 0 && acceptedEvents.length > 0
  return {
    proposalId: proposal.proposalId,
    characterId: proposal.characterId,
    accepted,
    acceptedEvents: accepted ? acceptedEvents : [],
    rejected,
  }
}
