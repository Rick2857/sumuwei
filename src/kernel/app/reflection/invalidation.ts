/**
 * M11 WP6 —— **同轮阻断、跨域待审与失效规划**（ADR-085 `D07` · `D12` · `D13` · §5）。
 *
 * ============================================================================
 *  这个文件的三件事
 * ============================================================================
 * ```text
 * ① filterAdaptiveSelfThisTurn()  当前轮：哪些槽**现在**还能用（不等后台失效）
 * ② filterReflectionsThisTurn()   当前轮：哪些反思还能被引用
 * ③ planInvalidation()            后台：把"为什么失效"落成**确定性**的失效计划
 * ④ listPendingRevisionIntents()  只读待审面 + checkRevisionIntent() 的版本校验
 * ```
 *
 * ============================================================================
 *  四条硬边界
 * ============================================================================
 * ① **失败关闭**：拿不到某条根的读数 ⇒ `unavailable` ⇒ **不可用**
 *    （先例：`recheckGoalDependencies` 的"读不到证据 = 不能用"）。
 * ② **顺序固定**：当前轮过滤**先于**任何注入；后台落账是**补**，不是前提（`D12`）。
 * ③ **确定性**：失效计划里的 `causeEventId` 取**排序后第一个**不可用根 ——
 *    同一状态重跑给出同一个计划（幂等键因此稳定，重跑不产生第二份事件）。
 * ④ **不碰别的域**：本文件没有旧域的写入口（`D13`）；它只**读**资格读数、
 *    只**产**本域的失效计划。
 *
 * ⚠️ 纯逻辑：没有 SQL、没有 `node:*`、不调模型。
 */

import {
  isRevisionTargetDomain,
  type AdaptiveSelfUsability,
  type AdaptiveSelfUsabilityInput,
  type InvalidationOutcome,
  type PendingRevisionIntent,
  type RevisionIntentCheck,
  type RevisionTargetReading,
  type RootUsabilityReading,
  type SameTurnUsability,
  type SourceBlockReason,
} from '../../contracts/revision-intent.ts'

/** 不可用原因 → 保守归类（拿不到具体原因时按最宽的那一档处理） */
function blockReasonOf(reading: RootUsabilityReading | undefined): SourceBlockReason | undefined {
  if (reading === undefined) return 'unavailable' // 没给读数 ⇒ 当不可用（失败关闭）
  if (reading.usable) return undefined
  return reading.reason ?? 'unavailable'
}

function verdictOfRoots(
  roots: readonly string[],
  readings: readonly RootUsabilityReading[]
): SameTurnUsability {
  if (roots.length === 0) {
    return { usable: false, reason: 'unavailable', at: '(no_roots)', detail: '没有根 ⇒ 不可用于当前轮' }
  }
  const byId = new Map(readings.map((reading) => [reading.rootId, reading]))
  // 确定性：按 id 升序找第一个被挡下的根
  for (const rootId of [...roots].sort()) {
    const reason = blockReasonOf(byId.get(rootId))
    if (reason !== undefined) {
      return {
        usable: false,
        reason,
        at: rootId,
        detail: `根 ${rootId} 当前不可用（${reason}）—— 当前轮就停止使用，不等后台失效落账`,
      }
    }
  }
  return { usable: true }
}

/** 当前轮：一个槽还能不能用（**同步**，不依赖后台任务） */
export function filterAdaptiveSelfThisTurn(input: AdaptiveSelfUsabilityInput): AdaptiveSelfUsability {
  const verdict = verdictOfRoots(input.roots, input.rootVerdicts)
  return verdict.usable
    ? { slot: input.slot, usable: true }
    : { slot: input.slot, usable: false, reason: verdict.reason, at: verdict.at, detail: verdict.detail }
}

/** 当前轮：批量过滤（返回可用的那些；被挡下的带具名原因） */
export function usableAdaptiveSelfThisTurn(
  inputs: readonly AdaptiveSelfUsabilityInput[]
): { readonly usable: AdaptiveSelfUsability[]; readonly blocked: AdaptiveSelfUsability[] } {
  const verdicts = inputs.map(filterAdaptiveSelfThisTurn)
  return {
    usable: verdicts.filter((verdict) => verdict.usable),
    blocked: verdicts.filter((verdict) => !verdict.usable),
  }
}

/** 当前轮：一条反思还能不能被引用（根被挡下即不可用） */
export function filterReflectionThisTurn(
  reflection: { readonly reflectionId: string; readonly roots: readonly string[] },
  readings: readonly RootUsabilityReading[]
): SameTurnUsability {
  return verdictOfRoots(reflection.roots, readings)
}

// ---------------------------------------------------------------------------
// 后台：失效计划（确定性）
// ---------------------------------------------------------------------------

/**
 * 规划一次失效（**纯函数**）。
 *
 * @returns `no_change` 当所有根都还可用；否则给出**确定性**的 `cause` + `causeEventId`
 */
export function planInvalidation(input: {
  readonly reflectionId: string
  readonly roots: readonly string[]
  readonly rootVerdicts: readonly RootUsabilityReading[]
}): InvalidationOutcome {
  const verdict = verdictOfRoots(input.roots, input.rootVerdicts)
  if (verdict.usable) {
    return { kind: 'no_change', reason: 'sources_usable', detail: '所有根当前都可用 ⇒ 不失效' }
  }
  /*
   * ⚠️ 失效的 cause 只取三档（遗忘 / 撤回 / 版本漂移）。
   *    `source_privacy_masked` 与 `unavailable` **不是**失效原因：
   *    前者是"这一轮不该看"，后者是"读不到" —— 两者都不该把一条已采纳的反思永久废掉。
   */
  const cause =
    verdict.reason === 'source_forgotten' ||
    verdict.reason === 'source_retracted' ||
    verdict.reason === 'source_version_changed'
      ? verdict.reason
      : undefined
  if (cause === undefined) {
    return {
      kind: 'no_change',
      reason: verdict.reason,
      detail: `${verdict.reason} 不构成永久失效（遮蔽与读不到都是**暂时**的）`,
    }
  }
  return { kind: 'invalidate', plan: { reflectionId: input.reflectionId, cause, causeEventId: verdict.at } }
}

// ---------------------------------------------------------------------------
// 只读待审面：跨域修订意图
// ---------------------------------------------------------------------------

/**
 * 从反思记录里列出**待审**修订意图。
 *
 * ⚠️ 只有 `pending` / `accepted` 的记录进待审面：
 *    `rejected` / `retracted` 的意图**不是**"还没处理"，而是**已经不该处理**（§4.3）。
 */
export function listPendingRevisionIntents(
  records: readonly {
    readonly reflectionId: string
    readonly status: string
    readonly revisionIntent?: {
      readonly domain: string
      readonly targetId: string
      readonly expectedRevision: number
    }
  }[]
): readonly PendingRevisionIntent[] {
  const out: PendingRevisionIntent[] = []
  for (const record of records) {
    if (record.status !== 'pending' && record.status !== 'accepted') continue
    const intent = record.revisionIntent
    if (intent === undefined) continue
    if (!isRevisionTargetDomain(intent.domain)) continue // 越界域不进待审面
    out.push({
      reflectionId: record.reflectionId,
      reflectionStatus: record.status,
      domain: intent.domain,
      targetId: intent.targetId,
      expectedRevision: intent.expectedRevision,
    })
  }
  return out.sort((a, b) => (a.reflectionId < b.reflectionId ? -1 : a.reflectionId > b.reflectionId ? 1 : 0))
}

/**
 * 校验一条待审意图（**只读**；不提交、不改目标领域）。
 *
 * 顺序：域闭集 → 意图里**不得**夹带 proposal 正文 → 目标存在 → 版本一致。
 */
export function checkRevisionIntent(
  intent: PendingRevisionIntent & { readonly proposalBody?: unknown },
  target: RevisionTargetReading
): RevisionIntentCheck {
  if (!isRevisionTargetDomain(intent.domain)) {
    return { ok: false, reason: 'domain_not_allowed', detail: `域 ${String(intent.domain)} 不在闭集` }
  }
  if (intent.proposalBody !== undefined) {
    return {
      ok: false,
      reason: 'intent_has_proposal_body',
      detail: '意图里夹带了 proposal 正文 —— 目标领域的提案形状由该领域定义（D13）',
    }
  }
  if (!target.exists) {
    return { ok: false, reason: 'target_missing', detail: `目标 ${intent.targetId} 不存在` }
  }
  if (target.currentRevision !== intent.expectedRevision) {
    return {
      ok: false,
      reason: 'revision_changed',
      detail: `期望版本 ${String(intent.expectedRevision)}，当前 ${String(target.currentRevision)} —— 过期意图不得提交`,
    }
  }
  return { ok: true }
}
