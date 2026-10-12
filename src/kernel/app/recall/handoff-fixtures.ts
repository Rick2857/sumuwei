/**
 * M9.5 WP7/8 —— **交给 M10 / M11 的两个纯 fixture consumer**（计划 §4.4 第 7 条）。
 *
 * ============================================================================
 *  计划 §4.4「交给 M10/M11 的稳定边界」（逐字要点）
 * ============================================================================
 * ```text
 * ① 检索请求带明确 character、user/subject、查询目的、时间范围、预算和**调用版本**。
 * ② 返回的引用可追溯到当前 Memory ID、版本和证据；**不返回可直接当"新事实"的摘要文本**。
 * ④ M10 读到偏好可以作目标规划的输入，**不等于**用户授权执行或新承诺。
 * ⑤ M11 读到过去经历可以形成**独立待审**反思提案，**不得**直接把索引文本写回长期状态。
 * ⑥ 后续异步工作在**真正使用引用前必须再次回查有效性**，不能长期持有一次检索时的授权快照。
 * ⑦ 用**两个纯 fixture consumer** 验证以上规则；**不创建** Goal/Reflection 的空生产服务。
 * ```
 *
 * ============================================================================
 *  为什么这两个 fixture 要留在仓库里（而不是写在某个门里）
 * ============================================================================
 * ```text
 * 它们是**可执行的契约**：M10/M11 的实现应当长得像这里的形状 ——
 *   · 拿一个 `RecallTurnOutcome`，产出"规划输入"或"待审提案"；
 *   · **绝不**产出执行授权、新承诺、或直接写回长期状态。
 * 把它们放在 `src/kernel/app/recall/` 而不是门脚本里，是为了让下一个里程碑**读得到**，
 * 而不是只能读一份散文式的交接说明。
 *
 * ⚠️ 它们是**纯函数**：不写库、不产事件、不调用任何生产服务（§4.4 第 7 条：
 *    "不创建 Goal/Reflection 的空生产服务"）。
 * ```
 */

import type { RecallTurnOutcome } from './turn.ts'

// ---------------------------------------------------------------------------
// 共同形状：可追溯引用 + 使用前复核
// ---------------------------------------------------------------------------

/** 交给下游的**引用**：只有 id / 版本 / 证据指针，**没有**正文。 */
export interface RecallReference {
  readonly memoryId: string
  /** 被引用时的记忆版本（用于"事后是否变了"的核对） */
  readonly sourceRevision: number
  /** 根证据 id（可追溯到证据本身） */
  readonly evidenceIds: readonly string[]
}

/**
 * **使用前复核**（§4.4 第 6 条）：不许长期持有"一次检索时的授权快照"。
 *
 * 调用方传入"现在还算不算"的读数（由**当前**事实层给出），fixture 据此丢弃失效引用。
 * ⚠️ 复核**不是**可选的：异步消费者在真正使用前必须再查一次。
 */
export interface ReferenceRecheck {
  /** 这条引用现在是否仍然有效（未遗忘 / 未被取代 / 仍属该 user） */
  readonly stillValid: (reference: RecallReference) => boolean
}

/** 复核之后的引用分区（两条都要如实给出，不能只给"留下的"） */
export interface RecheckResult {
  readonly usable: readonly RecallReference[]
  readonly dropped: readonly { readonly reference: RecallReference; readonly reason: string }[]
}

export function recheckReferences(
  references: readonly RecallReference[],
  recheck: ReferenceRecheck
): RecheckResult {
  const usable: RecallReference[] = []
  const dropped: { reference: RecallReference; reason: string }[] = []
  for (const reference of references) {
    if (recheck.stillValid(reference)) usable.push(reference)
    else dropped.push({ reference, reason: 'stale_reference_recheck_failed' })
  }
  return { usable, dropped }
}

/** 从一次召回结果里取引用（**只取 id/版本/证据**；不取任何正文）。 */
export function referencesFromOutcome(
  outcome: RecallTurnOutcome,
  evidenceByMemoryId: ReadonlyMap<string, readonly string[]>
): readonly RecallReference[] {
  return outcome.trace.selectedIds.map((memoryId) => ({
    memoryId,
    /* 结构版本：本里程碑里 source_revision 与"这一轮的读数"同代 */
    sourceRevision: 1,
    evidenceIds: evidenceByMemoryId.get(memoryId) ?? [],
  }))
}

// ---------------------------------------------------------------------------
// Fixture A —— **M10 Goal 形状**的消费者
// ---------------------------------------------------------------------------

export interface GoalPlanningInput {
  readonly memoryId: string
  /** 这条偏好**可以**作为目标规划的输入 */
  readonly usableAsPlanningInput: true
  /** ⚠️ 永远为 false：读到偏好**不等于**用户授权 */
  readonly impliesUserAuthorization: false
}

export interface GoalFixtureOutput {
  readonly planningInputs: readonly GoalPlanningInput[]
  /** ⚠️ **必须为空**：召回结果不产生执行授权 */
  readonly executionAuthorizations: readonly never[]
  /** ⚠️ **必须为空**：召回结果不产生新承诺 */
  readonly newCommitments: readonly never[]
  readonly droppedCount: number
}

/**
 * **M10 形状**的纯消费者：把召回结果当成**规划输入**，仅此而已。
 *
 * ```text
 * 它刻意**不**提供任何"执行/承诺"的输出形状 —— 不是"我们没这么用"，
 * 而是**没有这个出口**（类型上就没有）。§4.4 第 4 条因此是结构性的。
 * ```
 */
export function goalFixtureConsume(input: {
  readonly outcome: RecallTurnOutcome
  readonly references: readonly RecallReference[]
  readonly recheck: ReferenceRecheck
}): GoalFixtureOutput {
  const { usable, dropped } = recheckReferences(input.references, input.recheck)
  return {
    planningInputs: usable.map((reference) => ({
      memoryId: reference.memoryId,
      usableAsPlanningInput: true,
      impliesUserAuthorization: false,
    })),
    executionAuthorizations: [],
    newCommitments: [],
    droppedCount: dropped.length,
  }
}

// ---------------------------------------------------------------------------
// Fixture B —— **M11 Reflection 形状**的消费者
// ---------------------------------------------------------------------------

export type ReflectionProposalStatus = 'pending_review'

export interface ReflectionProposal {
  readonly proposalId: string
  /** 独立待审提案：**不得**自证（§4.4 第 5 条 + M11 的"不得自证"反例） */
  readonly status: ReflectionProposalStatus
  readonly basedOnMemoryIds: readonly string[]
  /** ⚠️ 提案**只引用 id**，不带原文（免得"索引文本"被当成新事实写回） */
  readonly evidenceIds: readonly string[]
}

export interface ReflectionFixtureOutput {
  readonly proposals: readonly ReflectionProposal[]
  /** ⚠️ **必须为空**：fixture 不写回长期状态（把"记录写入"也做成没有出口） */
  readonly stateWrites: readonly never[]
  readonly droppedCount: number
}

/**
 * **M11 形状**的纯消费者：形成**独立待审**提案，不写回任何状态。
 *
 * ⚠️ 计划点名「反思**不得自证**」：因此提案的状态**只能**是 `pending_review`，
 *    类型上没有"已成立/已采信"这种值。
 */
export function reflectionFixtureConsume(input: {
  readonly outcome: RecallTurnOutcome
  readonly references: readonly RecallReference[]
  readonly recheck: ReferenceRecheck
  readonly proposalIdPrefix?: string
}): ReflectionFixtureOutput {
  const { usable, dropped } = recheckReferences(input.references, input.recheck)
  if (usable.length === 0) {
    return { proposals: [], stateWrites: [], droppedCount: dropped.length }
  }
  const prefix = input.proposalIdPrefix ?? 'reflection-proposal'
  return {
    proposals: [
      {
        /* 提案 id 由**被引用的记忆集合**派生 ⇒ 同一组证据给出同一个 id（可对账） */
        proposalId: `${prefix}:${usable.map((item) => item.memoryId).sort().join(',')}`,
        status: 'pending_review',
        basedOnMemoryIds: usable.map((item) => item.memoryId),
        evidenceIds: [...new Set(usable.flatMap((item) => item.evidenceIds))],
      },
    ],
    stateWrites: [],
    droppedCount: dropped.length,
  }
}
