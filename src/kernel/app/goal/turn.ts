/**
 * Goal **一轮的编排**（M10 WP8b / ADR-076 §7.2 · §6 · `D07` · `D29`）。
 *
 * ============================================================================
 *  它在链路里的位置
 * ============================================================================
 * ```text
 * TurnGateway
 *   └─ runGoalTurn()            ← 本文件（唯一的编排入口）
 *        ├─ 读候选（只读端口，走遮蔽）
 *        ├─ understandGoalProposal()（WP4：有界输入 → provider → 严格校验）
 *        ├─ draftToProgramProposal()（WP4：草案 → 程序提案）
 *        ├─ validateGoalProposal()  （WP3：**唯一放行口**）
 *        ├─ 写：领域事件 + 投影行   （WP3 的 store；**两个事务**，见 L-M10-05）
 *        └─ 出：结论 + 程序事实 + 五个 trace 读数（**只有码/计数/id**）
 * ```
 *
 * ============================================================================
 *  四条硬性质
 * ============================================================================
 * ① **它不吞失败**：传输失败 / 非法输出 / 读不到依赖 / 来源不合格**各有具名结论**，
 *    **绝不**退化成"她没提目标"（那是本层存在要防的最坏失败模式）。
 * ② **它不越权**：授权、合法边、乐观锁、幂等全部由**放行口**判 ——
 *    本文件只**搬运**结论，不自己判"能不能写"。
 * ③ **它不抛**：任何一步失败都变成 `GoalTurnResult` 里的一格。
 *    抛出去会让网关的其余部分一起死，而"目标域出问题"不该拖垮整轮对话。
 * ④ **读数不含正文**：五个 trace 读数只有操作名、具名码、计数与 id（§6）。
 *
 * ⚠️ 纯编排 + 端口：不 import SQL / 框架 / `node:*`，不读时钟。
 */

import type { SourceQualification } from '../../contracts/attribution.ts'
import type {
  CommitmentStatus,
  GoalBlockedReason,
  GoalRowState,
  GoalState,
  GoalSuccessCriterion,
} from '../../contracts/goal.ts'
import type { GoalFactView } from '../../context/goal-sections.ts'
import { goalContentMustBeMasked } from './invalidation.ts'
import { judgeGoalCompletion, type GoalCompletionPorts } from './completion.ts'
import {
  GOAL_UNDERSTANDING_DEADLINE_MS,
  draftToProgramProposal,
  understandGoalProposal,
  type GoalCandidateSummary,
  type GoalUnderstandingOutcome,
  type GoalUnderstandingProvider,
  type GoalUnderstandingInput,
} from './understanding.ts'
import type { GoalProposal } from '../../policies/goal-validator.ts'

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 只读：把当前目标读成候选（**已经过遮蔽**） */
export interface GoalCandidatePort {
  /**
   * 读出候选。
   *
   * ⚠️ 返回的 `maskedCount` 是"因已忘掉而不进候选"的**计数**（不是内容）——
   *    它进事实块的那一句"另有 N 项…"。
   */
  readCandidates(characterId: string): Promise<{
    readonly candidates: readonly GoalCandidateSummary[]
    readonly goals: readonly GoalState[]
    readonly maskedCount: number
    /**
     * **M10.1 追加（可选）**：可见目标各自的**当前承诺**（`commitmentSummariesOf` 造）。
     *
     * ⚠️ 缺省 ⇒ `report_complete` **不补** `COMMITMENT_FULFILLED`（**失败关闭**：
     *    宁可不结清，也不猜一个 `commitmentId`/`revision`）。
     */
    readonly commitments?: readonly GoalCommitmentSummary[]
  }>
}

/** 写：受理之后的落库（事件 + 投影行） */
export interface GoalTurnWriter {
  /**
   * 提交一批**已受理**的事件，并把投影行跟着落库。
   *
   * ⚠️ 返回值里 `eventsCommitted` 与 `rowsCommitted` **分开报**（`L-M10-05`：
   *    它们是两个事务，中间可能崩）。崩在中间的收敛属 `planGoalReconciliation`。
   */
  commit(input: {
    readonly characterId: string
    readonly proposal: GoalProposal
    readonly now: number
  }): Promise<{
    readonly eventsCommitted: number
    readonly rowsCommitted: number
  }>
}

/** 放行口（形状与 `validateGoalProposal` 一致；注入以便门里换成真库端口） */
export interface GoalPassThroughPort {
  validate(proposal: GoalProposal): Promise<{
    readonly accepted: boolean
    readonly rejectedCodes: readonly string[]
    readonly acceptedEventTypes: readonly string[]
    /**
     * **已受理的事件，原样透传**（`unknown[]` 是刻意的）。
     *
     * ⚠️ 这里**不得**把它削成一个自造的小形状：`applyAcceptedEvents` 需要
     *    `AcceptedDomainEvent` 的**全部**字段（`operation` / `scope` /
     *    `idempotencyKey` / …）。第一版把它削成 `{type,payload,idempotencyKey}`
     *    ⇒ 写入器一调就抛，整条链读成 `commit_failed`。
     *    "编排不解释载荷、只搬运"这条纪律在这里是**具体**的：搬运就要原样搬。
     */
    readonly acceptedEvents: readonly unknown[]
  }>
}

export interface GoalTurnPorts {
  readonly candidates: GoalCandidatePort
  readonly writer: GoalTurnWriter
  readonly passThrough: GoalPassThroughPort
  /** 兑现判定用的证据端口（WP6）——`report_complete` 路径要用 */
  readonly completion: GoalCompletionPorts
}

// ---------------------------------------------------------------------------
// 输入 / 结论
// ---------------------------------------------------------------------------

export interface GoalTurnInput {
  readonly characterId: string
  /** 本轮原话（唯一的文本来源） */
  readonly currentInput: string
  readonly sourceEventId: string
  readonly sourceQualification: SourceQualification
  /** 当前撤销集（遮蔽的第二道口） */
  readonly withdrawnEventIds: ReadonlySet<string>
  /** 上一轮她说过的那条 assistant 事件 id（采纳路径定位） */
  readonly lastAssistantEventId?: string
  /**
   * **M10.1 / `L-M10.1-05` 装配第 ② 跳**：上一轮她那条回复的**原文**。
   *
   * ⚠️ 与 `lastAssistantEventId` **成对**使用，且只在两个都给时才作为
   *    `proposalEvidence` 交给映射层（`character_proposed` 的 create 要用它算**提议侧指纹**）。
   *    两者有一个缺 ⇒ 这一轮**不提供**提议侧证据 ⇒ 放行口按 `D28` 拒（失败关闭）。
   * ⚠️ 它**只**用于算指纹，**不进**任何事件正文（`goalSpanFingerprint` 是 FNV-1a）。
   */
  readonly lastAssistantText?: string
  readonly recentConversation?: GoalUnderstandingInput['recentConversation']
  /** **程序**时钟 */
  readonly now: number
  readonly provider: GoalUnderstandingProvider
  readonly runtime: Parameters<typeof understandGoalProposal>[2]
}

/** 五个 trace 读数的**唯一**来源（**只有码/计数/id**，§6） */
export interface GoalTraceReadings {
  readonly eligibility: {
    readonly outcome: 'invoked' | 'source_unusable' | 'not_invoked'
    readonly candidateCount: number
    readonly maskedCount: number
  }
  readonly proposal: {
    readonly outcome: GoalUnderstandingOutcome['kind']
    readonly operation?: string
    readonly elapsedMs?: number
    /** 具名拒绝原因（非法输出时） */
    readonly rejectionReason?: string
    /** 传输失败的原因（超时 / provider 抛错） */
    readonly transportReason?: string
  }
  readonly validation: {
    readonly outcome: 'accepted' | 'rejected' | 'not_attempted'
    readonly rejectionCodes: readonly string[]
  }
  readonly event: {
    readonly acceptedEventTypes: readonly string[]
    readonly eventsCommitted: number
    readonly rowsCommitted: number
  }
  readonly context: {
    readonly includedRowIds: readonly string[]
    readonly renderedNextSteps: number
    readonly maskedCount: number
  }
}

export interface GoalTurnResult {
  /** 这一轮目标域**做了什么**的具名结论 */
  readonly outcome:
    | 'no_operation'
    | 'query'
    | 'clarify'
    | 'accepted'
    | 'rejected'
    | 'invalid_output'
    | 'transport_failed'
    | 'source_unusable'
    | 'not_invoked'
    | 'commit_failed'
  /** 给上下文事实块（`kind='instruction'`）——**无操作时为 undefined**（`D29`） */
  readonly fact?: GoalFactView
  /** 给 trace 的五个读数 */
  readonly trace: GoalTraceReadings
  /** 焦点目标的 id（给状态块；**不含正文**） */
  readonly focusGoalId?: string
  /** 被阻塞 / 受阻的具名原因（若有） */
  readonly blockedReason?: GoalBlockedReason
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function baseTrace(): GoalTraceReadings {
  return {
    eligibility: { outcome: 'not_invoked', candidateCount: 0, maskedCount: 0 },
    proposal: { outcome: 'not_invoked' },
    validation: { outcome: 'not_attempted', rejectionCodes: [] },
    event: { acceptedEventTypes: [], eventsCommitted: 0, rowsCommitted: 0 },
    context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: 0 },
  }
}

/**
 * 跑一轮目标域。
 *
 * ⚠️ **它不抛**（性质 ③）：任何内部异常都会变成 `outcome: 'transport_failed'`
 *    或 `'commit_failed'`，并如实带在 trace 里。
 */
export async function runGoalTurn(
  input: GoalTurnInput,
  ports: GoalTurnPorts,
): Promise<GoalTurnResult> {
  return (await prepareGoalTurn(input, ports))()
}

/** Read and understand now; validate/commit only when the caller resumes this turn. */
export async function prepareGoalTurn(
  input: GoalTurnInput,
  ports: GoalTurnPorts,
): Promise<() => Promise<GoalTurnResult>> {
  const trace = baseTrace()

  /* ---- ① 资格（省掉一次调用；结论是具名的，不是"没提目标"）---- */
  if (input.sourceQualification !== 'ESTABLISHED') {
    return async () => ({
      outcome: 'source_unusable',
      trace: {
        ...trace,
        eligibility: { outcome: 'source_unusable', candidateCount: 0, maskedCount: 0 },
      },
    })
  }
  if (input.currentInput.trim() === '') {
    return async () => ({ outcome: 'not_invoked', trace })
  }

  /* ---- ② 读候选（走遮蔽；同时给出"有多少项因已忘掉而不在"）---- */
  let read: Awaited<ReturnType<GoalCandidatePort['readCandidates']>>
  try {
    read = await ports.candidates.readCandidates(input.characterId)
  } catch (error) {
    /*
     * ⚠️ 读不到候选 ⇒ **不调用理解链**（它需要候选集）。结论具名，
     *    绝不退化成"她没提目标"。
     */
    const detail = error instanceof Error ? error.message : String(error)
    return async () => ({
      outcome: 'transport_failed',
      fact: { outcome: 'failed', operation: 'candidate_read', rejectionCodes: ['candidate_read_failed'] },
      trace: {
        ...trace,
        eligibility: { outcome: 'invoked', candidateCount: 0, maskedCount: 0 },
        proposal: { outcome: 'transport', transportReason: `candidate_read_failed: ${detail}` },
      },
    })
  }
  /* ---- ③ 理解（WP4；非法输出与传输失败**不合并**）---- */
  const understanding = await understandGoalProposal(
    input.provider,
    {
      characterId: input.characterId,
      currentInput: input.currentInput,
      sourceEventId: input.sourceEventId,
      sourceQualification: input.sourceQualification,
      candidates: read.candidates.map(candidate => ({
        ...candidate,
        successCriterionKind: read.goals.find(goal => String(goal.goalId) === candidate.goalId)?.successCriterion.kind,
        ...(read.commitments === undefined ? {} : {
          commitmentStatus: read.commitments.find(commitment => commitment.goalId === candidate.goalId)?.status ?? 'none',
        }),
      })),
      ...(input.recentConversation === undefined ? {} : { recentConversation: input.recentConversation }),
      ...(input.lastAssistantEventId !== undefined && input.lastAssistantText !== undefined
        ? { lastAssistantEventId: input.lastAssistantEventId, lastAssistantText: input.lastAssistantText }
        : {}),
    },
    input.runtime,
  )

  let finished: Promise<GoalTurnResult> | undefined
  return () => finished ??= finishGoalTurn(input, ports, read, understanding)
}

async function finishGoalTurn(
  input: GoalTurnInput,
  ports: GoalTurnPorts,
  read: Awaited<ReturnType<GoalCandidatePort['readCandidates']>>,
  understanding: GoalUnderstandingOutcome,
): Promise<GoalTurnResult> {
  const trace = baseTrace()
  const eligibility: GoalTraceReadings['eligibility'] = {
    outcome: 'invoked', candidateCount: read.candidates.length, maskedCount: read.maskedCount,
  }

  if (understanding.kind === 'source_unusable' || understanding.kind === 'not_invoked') {
    return {
      outcome: understanding.kind,
      trace: { ...trace, eligibility },
    }
  }
  if (understanding.kind === 'invalid') {
    return {
      outcome: 'invalid_output',
      fact: { outcome: 'failed', operation: 'understanding', rejectionCodes: [understanding.reason] },
      trace: {
        ...trace,
        eligibility,
        proposal: {
          outcome: 'invalid',
          rejectionReason: understanding.reason,
          elapsedMs: understanding.elapsedMs,
        },
      },
    }
  }
  if (understanding.kind === 'transport') {
    return {
      outcome: 'transport_failed',
      fact: { outcome: 'failed', operation: 'understanding', rejectionCodes: [understanding.reason] },
      trace: {
        ...trace,
        eligibility,
        proposal: {
          outcome: 'transport',
          transportReason: understanding.reason,
          elapsedMs: understanding.elapsedMs,
        },
      },
    }
  }

  let draft = understanding.draft
  // 已结清项的重复确认不重复写，也不让它阻挡同批其余项。
  if (draft.operation === 'report_complete') {
    const ids = draft.targetGoalIds ?? [draft.targetGoalId!]
    const pending = ids.filter(id => !(read.goals.find(goal => String(goal.goalId) === id)?.status === 'completed' &&
      !read.commitments?.some(commitment => commitment.goalId === id &&
        !['fulfilled', 'cancelled', 'superseded', 'expired'].includes(commitment.status))))
    if (pending.length === 0) draft = { schemaVersion: draft.schemaVersion, operation: 'query', span: draft.span, targetGoalIds: ids }
    else if (pending.length !== ids.length) draft = { schemaVersion: draft.schemaVersion, operation: 'report_complete', span: draft.span, targetGoalIds: pending }
  }
  const proposalTrace: GoalTraceReadings['proposal'] = {
    outcome: 'understood',
    operation: draft.operation,
    elapsedMs: understanding.elapsedMs,
  }

  /* ---- ④ 映射（三个"不写"操作在这里收口）---- */
  /*
   * ⚠️ **M10.1 / `L-M10.1-05` 装配第 ② 跳**：把"她上一轮那条回复"作为**提议侧证据**
   *    交给映射层（`character_proposed` 的 create 需要两组带 `span` 的引用，`D28`）。
   *    两件都齐才给 —— 缺一 ⇒ 不提供 ⇒ 放行口按 `D28` 拒（**失败关闭**）。
   *    **窄规则在映射层**：只有 `input.proposalEvidence.eventId === draft.proposedByAssistantEventId`
   *    时才会用它（`understanding.ts`）。
   */
  const proposalEvidence =
    input.lastAssistantEventId !== undefined && input.lastAssistantText !== undefined
      ? { eventId: input.lastAssistantEventId, text: input.lastAssistantText }
      : undefined
  const mapped = draftToProgramProposal(draft, {
    characterId: input.characterId,
    sourceEventId: input.sourceEventId,
    proposalId: `goal-turn:${input.sourceEventId}`,
    processor: 'm10-goal-turn',
    processorVersion: 'm10-goal-turn@1',
    candidates: read.candidates,
    sourceText: understanding.sourceText,
    now: input.now,
    ...(proposalEvidence === undefined ? {} : { proposalEvidence }),
    /* M10.1：兑现的生产者（缺省 ⇒ 映射层不补 —— 失败关闭） */
    ...(read.commitments === undefined ? {} : { targetCommitments: read.commitments }),
  })

  if (mapped.proposal === undefined) {
    /*
     * ⚠️ 三个"不写"操作**不是同一件事**（`D29`）：
     * ```text
     * none    ⇒ **不产事实块**（0 个 section）—— "她没提目标"不该在 prompt 里留痕
     * query   ⇒ 产事实块（她必须依据当前目标如实回答）
     * clarify ⇒ 产事实块（她必须先澄清，**不得**猜测后代为操作）
     * ```
     * 把 `none` 也映射成一个 `no_goal_operation` 事实块会让**普通对话的 prompt
     * 与基线不再逐字节相同** —— 那正是 `D29` 与 `O3` 检查要防的。
     */
    if (mapped.operation === 'none') {
      return {
        outcome: 'no_operation',
        trace: {
          ...trace,
          eligibility,
          proposal: proposalTrace,
          context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: read.maskedCount },
        },
      }
    }
    const factOutcome = mapped.operation === 'query' ? ('query' as const) : ('clarify' as const)
    const queriedIds = draft.targetGoalIds ?? (draft.targetGoalId === undefined ? [] : [draft.targetGoalId])
    const settledGoalCount = factOutcome === 'query' && queriedIds.length > 0 && queriedIds.every(id =>
      read.goals.find(goal => String(goal.goalId) === id)?.status === 'completed' &&
      !read.commitments?.some(commitment => commitment.goalId === id &&
        !['fulfilled', 'cancelled', 'superseded', 'expired'].includes(commitment.status))) ? queriedIds.length : 0
    return {
      outcome: factOutcome,
      fact: { outcome: factOutcome, operation: mapped.operation, maskedCount: read.maskedCount,
        ...(settledGoalCount === 0 ? {} : { settledGoalCount }),
        ...(draft.clarifyReason === undefined ? {} : { clarifyReason: draft.clarifyReason }) },
      trace: {
        ...trace,
        eligibility,
        proposal: proposalTrace,
        context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: read.maskedCount },
      },
    }
  }

  /* ---- ⑤ 放行口（**唯一**的"能不能写"）---- */
  let verdict: Awaited<ReturnType<GoalPassThroughPort['validate']>>
  try {
    verdict = await ports.passThrough.validate(mapped.proposal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      outcome: 'transport_failed',
      fact: { outcome: 'failed', operation: mapped.operation, rejectionCodes: ['pass_through_failed'] },
      trace: {
        ...trace,
        eligibility,
        proposal: proposalTrace,
        validation: { outcome: 'not_attempted', rejectionCodes: [`pass_through_failed: ${detail}`] },
      },
    }
  }

  if (!verdict.accepted) {
    return {
      outcome: 'rejected',
      fact: {
        outcome: 'rejected',
        operation: mapped.operation,
        rejectionCodes: verdict.rejectedCodes,
        maskedCount: read.maskedCount,
      },
      trace: {
        ...trace,
        eligibility,
        proposal: proposalTrace,
        validation: { outcome: 'rejected', rejectionCodes: verdict.rejectedCodes },
        context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: read.maskedCount },
      },
    }
  }

  /* ---- ⑥ 兑现路径的**证据裁决**（`report_complete` 才有）---- */
  if (mapped.operation === 'report_complete') {
    const targetIds = draft.targetGoalIds ?? [draft.targetGoalId!]
    for (const target of read.goals.filter(goal => targetIds.includes(String(goal.goalId)))) {
      const judged = await judgeGoalCompletion({
        ports: ports.completion,
        characterId: input.characterId,
        target: 'goal',
        goal: target,
        expectedRevision: target.revision,
        basis: 'user_report',
        evidenceRefs: [
          { conversationEventId: input.sourceEventId as never, fingerprint: 'turn' },
        ],
        turnUserEventId: input.sourceEventId,
      })
      if (!judged.ok) {
        /*
         * ⚠️ 判定不过 ⇒ **一个事件都不写**，并如实报拒绝码（不是"她说完成了"）。
         *    这是 WP6 与 WP3 的接缝：判定在**前**，放行口在**后**。
         */
        return {
          outcome: 'rejected',
          fact: {
            outcome: 'rejected',
            operation: mapped.operation,
            rejectionCodes: [judged.code],
            maskedCount: read.maskedCount,
          },
          trace: {
            ...trace,
            eligibility,
            proposal: proposalTrace,
            validation: { outcome: 'rejected', rejectionCodes: [judged.code] },
            context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: read.maskedCount },
          },
        }
      }
    }
  }

  /* ---- ⑦ 写（两个事务；分开报计数）---- */
  let commit: Awaited<ReturnType<GoalTurnWriter['commit']>>
  try {
    commit = await ports.writer.commit({
      characterId: input.characterId,
      proposal: mapped.proposal,
      now: input.now,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    /*
     * ⚠️ 提交失败**不是**"没提目标"：事件可能已落库而投影没跟上（`L-M10-05`）。
     *    结论具名，且**不**退回"她什么都没做"。
     */
    return {
      outcome: 'commit_failed',
      fact: {
        outcome: 'failed',
        operation: mapped.operation,
        rejectionCodes: ['commit_failed'],
        maskedCount: read.maskedCount,
      },
      trace: {
        ...trace,
        eligibility,
        proposal: proposalTrace,
        validation: { outcome: 'accepted', rejectionCodes: [] },
        event: {
          acceptedEventTypes: verdict.acceptedEventTypes,
          eventsCommitted: 0,
          rowsCommitted: 0,
        },
        context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: read.maskedCount },
      },
    }
  }

  const focusGoalId = read.goals.find((goal) => goal.status === 'active')?.goalId

  return {
    outcome: 'accepted',
    fact: {
      outcome: 'accepted',
      operation: mapped.operation,
      acceptedEventTypes: verdict.acceptedEventTypes,
      maskedCount: read.maskedCount,
    },
    ...(focusGoalId !== undefined ? { focusGoalId: String(focusGoalId) } : {}),
    trace: {
      ...trace,
      eligibility,
      proposal: proposalTrace,
      validation: { outcome: 'accepted', rejectionCodes: [] },
      event: {
        acceptedEventTypes: verdict.acceptedEventTypes,
        eventsCommitted: commit.eventsCommitted,
        rowsCommitted: commit.rowsCommitted,
      },
      context: {
        includedRowIds: focusGoalId !== undefined ? [`goal:${String(focusGoalId)}`] : [],
        renderedNextSteps: 0,
        maskedCount: read.maskedCount,
      },
    },
  }
}

/**
 * 把一串目标读成候选（**唯一的**候选构造点）。
 *
 * ⚠️ 它**复用** `goalContentMustBeMasked`（与聊天、开发者面同一函数），
 *    并把被遮蔽的项计成 `maskedCount` —— 于是事实块能说"另有 N 项"。
 */
export function candidatesFromGoals(input: {
  readonly goals: readonly GoalState[]
  readonly withdrawnEventIds: ReadonlySet<string>
  readonly labelOf: (goal: GoalState) => string
}): { readonly candidates: readonly GoalCandidateSummary[]; readonly goals: readonly GoalState[]; readonly maskedCount: number } {
  const visible: GoalState[] = []
  let maskedCount = 0
  for (const goal of input.goals) {
    const masking = goalContentMustBeMasked({
      goal,
      withdrawnEventIds: input.withdrawnEventIds,
    })
    if (masking.mask) {
      maskedCount += 1
      continue
    }
    visible.push(goal)
  }
  return {
    candidates: visible.map((goal) => ({
      goalId: String(goal.goalId),
      status: goal.status,
      priority: goal.priority,
      statement: input.labelOf(goal),
      revision: goal.revision,
    })),
    goals: visible,
    maskedCount,
  }
}

/** 供门引用（防"常量加了但没人用"） */
export const GOAL_TURN_DEADLINE_MS = GOAL_UNDERSTANDING_DEADLINE_MS

/**
 * 一个目标的**当前承诺**摘要（只读；给映射层判断"这一轮该不该补一条兑现"）。
 *
 * ⚠️ **M10.1 追加（兑现的生产者）**：`COMMITMENT_FULFILLED` 在 M10 里有完整的
 *    fork（契约 / 放行口 / 投影）却**没有生产者** —— 目标完成了，承诺还挂着
 *    （`GOAL_COMPLETED` 与 `COMMITMENT_FULFILLED` **各记各的**，`goal.ts:23` 明确
 *    禁止拿前者推算后者）。于是"结清"在生产里**不可达**，M10.1 的目标 ③ 也就落不了地。
 *    ⇒ 本摘要就是那个生产者的输入：`report_complete` 时按它**同提案**补一条兑现。
 * ⚠️ **只有 `criterionKind`，没有 `scope`**：正文不进这里（映射只需要判据与身份）。
 */
export interface GoalCommitmentSummary {
  readonly goalId: string
  readonly commitmentId: string
  readonly revision: number
  readonly criterionKind: GoalSuccessCriterion['kind']
  readonly status: CommitmentStatus
}

/**
 * 从投影行造承诺摘要（**只给可见目标**）。
 *
 * ⚠️ `visible` 必须传 `candidatesFromGoals(...).goals`（**已经过遮蔽**的那一份）：
 *    被遗忘的目标**不许**被兑现 —— 那是"拿一条已经撤销的承担去做结清"。
 */
export function commitmentSummariesOf(input: {
  readonly rows: readonly GoalRowState[]
  readonly visible: readonly GoalState[]
}): readonly GoalCommitmentSummary[] {
  const rowByGoalId = new Map(input.rows.map((row) => [String(row.goal.goalId), row]))
  const summaries: GoalCommitmentSummary[] = []
  for (const goal of input.visible) {
    const commitment = rowByGoalId.get(String(goal.goalId))?.commitment
    if (commitment === undefined || commitment === null) continue
    summaries.push({
      goalId: String(goal.goalId),
      commitmentId: String(commitment.commitmentId),
      revision: commitment.revision,
      criterionKind: commitment.criterion.kind,
      status: commitment.status,
    })
  }
  return summaries
}
