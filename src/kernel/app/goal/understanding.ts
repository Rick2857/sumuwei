/**
 * Goal **语义理解链**（M10 WP4 / ADR-076 §7.2 · §7.3 · `D07` · `D28`）。
 *
 * ============================================================================
 *  这条链的六步（计划 §7.2 逐条落地）
 * ============================================================================
 * ```text
 * ① 有界输入：只给"本轮原话 + 程序给定的候选目标 + 最小上下文"
 * ② provider 调用：**硬期限 8000ms、零隐式重试**（超时/抛错 ⇒ transport，不改旧状态）
 * ③ 严格结构校验：非法输出记 invalid（**不当 none** —— 那是这里最坏的失败模式）
 * ④ 来源资格：来源事件必须是本轮的**用户**话语且归因 ESTABLISHED
 * ⑤ span 是原话范围：文本一律由本模块从原话切，**不**接受草案自带文本
 * ⑥ 映射成程序侧 `GoalProposal` ⇒ 交给 `validateGoalProposal`（WP3 的唯一放行口）
 * ```
 *
 * ============================================================================
 *  三件事**刻意**不在这里做
 * ============================================================================
 *  · **不判授权**：那是放行口的事（本模块只把草案变成提案）。
 *  · **不写库**：本模块纯编排（端口进、结论出）。
 *  · **不碰模型 SDK**：provider 是一个**端口**。生产装配注入真实 provider；
 *    离线门注入固定 provider（"语义负控有有效分母"因此可以在**无模型**的情况下算出来）。
 *
 * ⚠️ **不猜读数**：`expectedRevision` 与 `recordedAt` 都必须由调用方给
 *    （见 `DraftToProgramInput`）。本模块**不**用"看起来合理"的默认值 ——
 *    一个 0 或一个当前时间冒充"库里那条目标的版本"，会让乐观锁静默失效。
 *
 * ⚠️ `kernel/app/` 的端口形状 + 纯编排：不 import SQL / 框架 / `node:*`。
 */

import {
  validateGoalProposalDraft,
  type GoalDraftRejectionReason,
  type GoalProposalDraft,
  type GoalProposalOperation,
} from '../../contracts/goal-proposal.ts'
import type { GoalOperation, GoalState } from '../../contracts/goal.ts'
import { COMMITMENT_TERMINAL_STATUSES, makeGoalId } from '../../contracts/goal.ts'
import type { GoalCommitmentSummary } from './turn.ts'
import { entityRef } from '../../contracts/entity.ts'
import type { SourceQualification } from '../../contracts/attribution.ts'
import {
  goalProposalOf,
  type GoalProposal,
  type GoalSourceQualification,
} from '../../policies/goal-validator.ts'

/**
 * 硬期限（计划 §7.3 的推荐值；改它 = 改契约并记录原因）。
 *
 * ⚠️ **2026-09-30 按实测上调 8s → 20s**（用户授权"按实际情况延长"）：
 *
 * ```text
 * 实测（`m10:semantic:eval` 全量：test split 140 条 × 3 轮 = 420 次真调用，测试端点）：
 *   · **13 次**（3.1%）撞到 8 秒期限被自己的超时闸掐掉（`transport`，`This operation was aborted`）
 *   · 而走完的那些，时延分布见同一次运行的证据档（早前探针实测 **1.3–7.7 秒**）
 *   ⇒ 8 秒**卡在分布尾部**：它不是"防无限等待"的护栏，而是**在正常调用上开火**。
 * ```
 *
 * ⇒ 当时取 **20 秒**（≈ 实测最大值的 2.6 倍）：既让正常的长尾走完，又仍然是**有界的**
 *    （"零隐式重试 + 硬期限"这条设计不变：超了就记 `transport`，不重问）。
 * ⚠️ 代价是**最坏情况的一轮会等更久** —— 这是延迟预算的权衡，由用户裁定（本行是它的落点）。
 *
 * 2026-10-05 用户授权「先限制异常长等待」：本轮改回 **8 秒**，优先限制语音轮次的长等待。
 * 慢调用会更常失败，目标/承诺可能漏记；不重试、不把失败说成 none，不改变成功路径。
 * 裁定与验证：docs/post-lv2/Goal-Understanding-Deadline-2026-10-05.md。
 */
export const GOAL_UNDERSTANDING_DEADLINE_MS = 8_000

/**
 * 一条**候选目标**的只读摘要（给模型的最小上下文）。
 *
 * ⚠️ 只给 id + 状态 + 优先级 + **有界描述**。不给依赖、不给承诺、不给证据
 *    —— 那些会把"这次要做什么"变成"把整个目标库塞进提示"。
 */
export interface GoalCandidateSummary {
  readonly goalId: string
  readonly status: string
  readonly priority: string
  readonly statement: string
  /** 当前 `revision`（**程序**读数；模型看不到也不需要它） */
  readonly revision: number
  /** 同一可见目标的当前承诺状态；仅程序读数，不暴露承诺正文。 */
  readonly commitmentStatus?: string
  readonly successCriterionKind?: string
}

/** 一次理解的**有界输入**（边界清单是判据的一部分） */
export interface GoalUnderstandingInput {
  readonly characterId: string
  /** 本轮原话（**唯一**的文本来源；span 相对它计算） */
  readonly currentInput: string
  /** 本轮那条已落库的用户事件 id */
  readonly sourceEventId: string
  /** 它的受信归因资格（程序给出；模型**不能**自报） */
  readonly sourceQualification: SourceQualification
  /** 程序给定、模型只能从中选的候选目标 */
  readonly candidates: readonly GoalCandidateSummary[]
  /** 上一轮她说过的那条 assistant 事件 id（采纳路径的定位依据；缺省 = 没有） */
  readonly lastAssistantEventId?: string
  /** 与 id 成对的未遮蔽原文；模型需要它来理解用户接受了什么。 */
  readonly lastAssistantText?: string
  /** 同会话、撤销遮蔽后的双方前文，只用于消解指代；本轮 span 仍相对 currentInput。 */
  readonly recentConversation?: readonly { readonly id: string; readonly actorType: 'user' | 'character'; readonly text: string }[]
}

/** provider 的原始产出（**未经校验**） */
export interface GoalUnderstandingCall {
  readonly input: GoalUnderstandingInput
  readonly deadlineMs: number
}

/** provider 端口 */
export interface GoalUnderstandingProvider {
  readonly name: string
  readonly version: string
  call(call: GoalUnderstandingCall): Promise<unknown>
}

// ---------------------------------------------------------------------------
// 结论（**五态**，不合并）
// ---------------------------------------------------------------------------

/**
 * 一次理解的结论。
 *
 * ⚠️ 五态**不得合并**（与 `memory-record-status.ts` 的"失败不得伪装成零结果"同一条纪律）：
 * ```text
 * understood       拿到合法草案（草案可能是 none / query / clarify —— 那也是**结论**）
 * invalid          模型给了东西，但结构不合法（**不是** none）
 * transport        超时 / provider 抛错（**不是** none，也**不是** invalid）
 * source_unusable  来源不是本轮的合格用户话语 ⇒ 不进入理解（省一次调用）
 * not_invoked      调用方决定不调用（本轮没有可理解的内容）
 * ```
 */
export type GoalUnderstandingOutcome =
  | {
      readonly kind: 'understood'
      readonly draft: GoalProposalDraft
      readonly provider: { readonly name: string; readonly version: string }
      /** 草案引用的**原话切片**（由本模块从原话切；不是模型给的文本） */
      readonly sourceText: string
      readonly elapsedMs: number
    }
  | {
      readonly kind: 'invalid'
      readonly reason: GoalDraftRejectionReason
      readonly detail: string
      readonly provider: { readonly name: string; readonly version: string }
      readonly elapsedMs: number
    }
  | {
      readonly kind: 'transport'
      readonly reason: 'timeout' | 'provider_error'
      readonly detail: string
      readonly provider: { readonly name: string; readonly version: string }
      readonly elapsedMs: number
    }
  | { readonly kind: 'source_unusable'; readonly reason: string }
  | { readonly kind: 'not_invoked'; readonly reason: string }

/**
 * 可注入的时钟与期限执行器。
 *
 * ⚠️ 本模块**不**自己调 `setTimeout`：那会让门依赖真实时间，
 *    而"期限到了会怎样"恰恰是要被**确定性**测到的一件事。
 */
export interface GoalUnderstandingRuntime {
  now(): number
  /** 把 provider 调用与期限赛跑；实现方负责真的取消 */
  withDeadline<T>(
    work: () => Promise<T>,
    deadlineMs: number,
  ): Promise<{ readonly kind: 'ok'; readonly value: T } | { readonly kind: 'timeout' }>
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function elapsedOf(runtime: GoalUnderstandingRuntime, startedAt: number): number {
  return Math.max(0, runtime.now() - startedAt)
}

/** 从原话里切出草案引用的那一段（**唯一**的文本来源） */
export function sliceSource(text: string, span: { start: number; end: number }): string {
  return [...text].slice(span.start, span.end).join('')
}

/**
 * 跑一次理解。
 *
 * ⚠️ **源不可用时根本不调用 provider**（省一次调用，且结论是
 *    `source_unusable` 而不是"她没提目标"）。
 */
export async function understandGoalProposal(
  provider: GoalUnderstandingProvider,
  input: GoalUnderstandingInput,
  runtime: GoalUnderstandingRuntime,
): Promise<GoalUnderstandingOutcome> {
  const providerId = { name: provider.name, version: provider.version }

  if (input.sourceQualification !== 'ESTABLISHED') {
    return {
      kind: 'source_unusable',
      reason: `来源归因不是 ESTABLISHED（收到 ${input.sourceQualification}）`,
    }
  }
  if (input.currentInput.trim() === '') {
    return { kind: 'not_invoked', reason: '本轮没有可理解的原话' }
  }

  const startedAt = runtime.now()
  let raced: Awaited<ReturnType<GoalUnderstandingRuntime['withDeadline']>>
  try {
    raced = await runtime.withDeadline(
      () => provider.call({ input, deadlineMs: GOAL_UNDERSTANDING_DEADLINE_MS }),
      GOAL_UNDERSTANDING_DEADLINE_MS,
    )
  } catch (error) {
    return {
      kind: 'transport',
      reason: 'provider_error',
      detail: error instanceof Error ? error.message : String(error),
      provider: providerId,
      elapsedMs: elapsedOf(runtime, startedAt),
    }
  }
  if (raced.kind === 'timeout') {
    return {
      kind: 'transport',
      reason: 'timeout',
      detail: `超过硬期限 ${String(GOAL_UNDERSTANDING_DEADLINE_MS)}ms（零隐式重试）`,
      provider: providerId,
      elapsedMs: elapsedOf(runtime, startedAt),
    }
  }

  const verdict = validateGoalProposalDraft(raced.value, {
    sourceText: input.currentInput,
    ...(input.lastAssistantText === undefined ? {} : { proposalSourceText: input.lastAssistantText }),
    candidateGoalIds: input.candidates.map((candidate) => candidate.goalId),
  })
  if (!verdict.ok) {
    return {
      kind: 'invalid',
      reason: verdict.reason,
      detail: verdict.detail,
      provider: providerId,
      elapsedMs: elapsedOf(runtime, startedAt),
    }
  }

  return {
    kind: 'understood',
    draft: verdict.draft,
    provider: providerId,
    sourceText: sliceSource(input.currentInput, verdict.draft.span),
    elapsedMs: elapsedOf(runtime, startedAt),
  }
}

// ---------------------------------------------------------------------------
// 草案 → 程序侧提案（**唯一**的映射点）
// ---------------------------------------------------------------------------

/** 不写领域事件的操作（它们仍然有结论，只是没有提案） */
export const GOAL_NON_WRITING_OPERATIONS: readonly GoalProposalOperation[] = [
  'none',
  'query',
  'clarify',
]

/** 草案操作 → 领域事件类型（**唯一**映射点） */
export function goalEventTypeOf(operation: GoalProposalOperation): string {
  switch (operation) {
    case 'create':
      return 'GOAL_CREATED'
    case 'revise':
      return 'GOAL_REVISED'
    case 'pause':
      return 'GOAL_PAUSED'
    case 'resume':
      return 'GOAL_RESUMED'
    case 'cancel':
      return 'GOAL_CANCELLED'
    case 'report_complete':
      return 'GOAL_COMPLETED'
    default:
      throw new Error(
        `操作 ${operation} 不产生领域事件（见 GOAL_NON_WRITING_OPERATIONS）—— 调用方必须先判这一条`,
      )
  }
}

/** 映射结论（给"程序事实块"与 trace 用；**不含**正文） */
export interface GoalDraftToProgramResult {
  readonly operation: GoalProposalOperation
  /** `undefined` = 这一轮**不写领域事件**（`none` / `query` / `clarify`） */
  readonly proposal?: GoalProposal
  readonly programOperation?: GoalOperation
  readonly fact: {
    readonly outcome: 'no_goal_operation' | 'query' | 'clarify' | 'proposed'
    readonly operation: GoalProposalOperation
    readonly candidateCount: number
  }
}

export interface DraftToProgramInput {
  readonly characterId: string
  readonly sourceEventId: string
  readonly proposalId: string
  readonly processor: string
  readonly processorVersion: string
  /** 程序给定候选（含**程序读数**的 revision） */
  readonly candidates: readonly GoalCandidateSummary[]
  /** 草案引用的原话切片（由 `understandGoalProposal` 给出） */
  readonly sourceText: string
  /** **程序**时钟（`recordedAt` 的唯一来源；本模块不读挂钟） */
  readonly now: number
  /**
   * **采纳路径的提议侧证据**（M10.1 / `L-M10.1-04`；可选）。
   *
   * ⚠️ 为什么需要它：`character_proposed` 的 create 必须给出**两组**带 `span` 的引用
   *    （**提议侧 + 采纳侧**，D28）—— 而"提议侧"的**指纹**要来自**那条提议原话的文本**，
   *    它**不在**本模块的输入形状里（`sourceText` 是**采纳侧**的原话）。
   * ⇒ 调用方把"那条消息的 id 与文本"一起给它；本模块**只在 id 相符时**才用它
   *    （不相符 ⇒ 不造这条引用 ⇒ 放行口按 D28 拒 —— **失败关闭**，不猜）。
   */
  readonly proposalEvidence?: { readonly eventId: string; readonly text: string }
  /** 程序侧约定窗口的两条真实原文；模型不能填此字段。 */
  readonly acceptanceEvidence?: readonly { readonly eventId: string; readonly text: string }[]
  /**
   * **M10.1 追加（兑现的生产者）**：可见目标的**当前承诺**摘要（可选）。
   *
   * ⚠️ 为什么需要它：`COMMITMENT_FULFILLED` 在 M10 里有完整 fork（契约 / 放行口 / 投影）
   *    却**没有生产者** —— 目标完成了，承诺还挂着（`goal.ts:23` 明确禁止拿
   *    `GOAL_COMPLETED` 推算 `COMMITMENT_FULFILLED`）⇒ "结清"在生产里**不可达**。
   *    本字段是那条断链的接入点：`report_complete` 时按它**同提案**补一条兑现。
   * ⚠️ 缺省 / 找不到那一项 ⇒ **不补**（**失败关闭**：不猜 `commitmentId`/`revision`）。
   */
  readonly targetCommitments?: readonly GoalCommitmentSummary[]
}

/**
 * 把合法草案映射成程序侧提案。
 *
 * ⚠️ 三个"不写"的操作在这里被**显式**处理：它们不是错误，也不是"什么都没发生"
 *    —— `query` 与 `clarify` 都有**用户可见**的结论（见 `fact`）。
 *    把三者压成一个 `undefined` 会让"她查了一下"与"她没听懂"看起来一样。
 *
 * ⚠️ `expectedRevision` 取自**候选摘要里的程序读数**（`revision`），不是猜的。
 *    候选摘要由调用方从 `createGoalStateLookup` 读出来，因此"乐观锁"在这里
 *    第一次真正接上；若候选里没有这个 goalId，映射**直接抛**（结构校验已保证
 *    它在候选集里，走到这里说明调用方的候选集与它给模型的不一致）。
 */
export function draftToProgramProposal(
  draft: GoalProposalDraft,
  input: DraftToProgramInput,
): GoalDraftToProgramResult {
  const fact = {
    outcome:
      draft.operation === 'none'
        ? ('no_goal_operation' as const)
        : draft.operation === 'query'
          ? ('query' as const)
          : draft.operation === 'clarify'
            ? ('clarify' as const)
            : ('proposed' as const),
    operation: draft.operation,
    candidateCount: input.candidates.length,
  } as const

  if (GOAL_NON_WRITING_OPERATIONS.includes(draft.operation)) {
    return { operation: draft.operation, fact }
  }

  const qualifications: GoalSourceQualification[] = [
    { eventId: input.sourceEventId, qualification: 'ESTABLISHED' },
  ]
  const proposalOf = (targets: Parameters<typeof goalProposalOf>[0]['targets'], operation: GoalOperation): GoalProposal =>
    goalProposalOf({
      proposalId: input.proposalId,
      operation,
      characterId: input.characterId,
      processor: input.processor,
      processorVersion: input.processorVersion,
      sourceConversationEventIds: [input.sourceEventId],
      sourceQualifications: qualifications,
      targets,
    })

  const sourceRef = {
    conversationEventId: input.sourceEventId as never,
    span: { start: draft.span.start, end: draft.span.end },
    fingerprint: goalSpanFingerprint(input.sourceText),
  }

  /*
   * ⚠️ **M10.1 / `L-M10.1-04`**：`character_proposed` 的 create 需要**提议侧**引用
   *    （D28：两组带 `span` 的引用，提议侧 + 采纳侧）。
   *    提议侧的**指纹**必须来自**那条提议原话的文本** —— 它只能由调用方给
   *    （`input.proposalEvidence`），且**id 必须与草案里那个相符**；
   *    不相符/没给 ⇒ **不造**这条引用 ⇒ 放行口按 D28 拒（**失败关闭**，不猜）。
   */
  const proposalRef =
    draft.origin === 'character_proposed' &&
    draft.proposedByAssistantEventId !== undefined &&
    draft.proposalSpan !== undefined &&
    input.proposalEvidence !== undefined &&
    input.proposalEvidence.eventId === draft.proposedByAssistantEventId
      ? {
          conversationEventId: draft.proposedByAssistantEventId as never,
          span: { start: draft.proposalSpan.start, end: draft.proposalSpan.end },
          fingerprint: goalSpanFingerprint(input.proposalEvidence.text),
        }
      : undefined
  const sourceRefsForCreate = proposalRef === undefined ? [sourceRef] : [proposalRef, sourceRef]

  if (draft.operation === 'report_complete' && draft.targetGoalIds !== undefined) {
    const { targetGoalIds, ...single } = draft
    const targets = targetGoalIds.flatMap(targetGoalId =>
      draftToProgramProposal({ ...single, targetGoalId }, input).proposal!.targetEvents)
    return { operation: draft.operation, programOperation: 'complete', proposal: proposalOf(targets, 'complete'), fact }
  }

  if (draft.operation === 'create') {
    /*
     * ⚠️ `goalId` 保持**占位**：放行口会用程序材料重算并重写它
     *    （`goal-validator.ts` 的阶段 C）。草案里根本没有 id 字段，
     *    所以这个占位不可能来自模型。
     *
     * ⚠️ **M10.1 追加**：若同一提案里还要接受一条**承诺**，承诺的 `payload.goalId`
     *    必须指向放行口**将要派生出的**那个 id（同提案回看按 `createdInProposal` 匹配）。
     *    ⇒ 承诺侧用 `makeGoalId` 按**同一份材料**算一次（两处一致 ⇒ 匹配得上）；
     *      而**目标侧一个字都不改**（占位仍是占位，M10 的 E1 判据因此不受影响）。
     */
    const owner = entityRef('character', input.characterId)
    const origin = draft.origin ?? ('user_requested' as const)
    const statement = draft.statement ?? ''
    const goalIdForCommitment = makeGoalId({
      characterId: input.characterId,
      owner: owner as never,
      origin,
      statement,
      acceptanceSourceEventId: input.sourceEventId,
      operation: 'create',
    })
    const target = {
      type: 'GOAL_CREATED',
      operation: 'create' as const,
      payload: {
        characterId: input.characterId,
        goal: {
          /*
           * ⚠️ 这个占位串**必须保持原样**（`m10:source:verify` 的 E1 逐字断言它）——
           *    M10 的既有判据把"占位 ≠ 派生"当作"放行口重写了 id"的证据。
           *    （承诺侧另有占位，那里用无括号的写法，因为 `entityRef` 会校验 id 字符。）
           */
          goalId: '(derived-by-validator)' as never,
          characterId: input.characterId,
          owner,
          origin,
          sourceRefs: sourceRefsForCreate,
          revision: 1,
          statement,
          successCriterion: { kind: 'user_report' as const },
          status: 'active' as const,
          priority: draft.priority ?? ('normal' as const),
          dependencies: [],
          ...(draft.nextStep !== undefined ? { nextStep: draft.nextStep } : {}),
          time: { recordedAt: input.now },
        } satisfies GoalState,
        mutation: 'explicit' as const,
      },
      scope: 'CHARACTER_INTERNAL' as const,
    }
    const targets: Parameters<typeof goalProposalOf>[0]['targets'][number][] = [target]
    /*
     * ⚠️ **M10.1 追加**：草案带 `commitment` ⇒ 在**同一提案**里追加 `COMMITMENT_ACCEPTED`。
     *    · `actor` / `beneficiary` 是**占位**：放行口会用程序事实（本角色 + 当前 active user）
     *      覆盖它们（`goal-validator.ts` 的 `identityOf`），入账的是覆盖后的 payload。
     *    · `acceptedAt` 用**程序时钟**（`input.now`），不是挂钟。
     *    · 判据必须落在放行口的闭集内（v1 只正式接受两类可观察承诺）—— 不在闭集内会在放行口被拒，
     *      因此**先在这里就把不在闭集内的挡掉**（见 `draft.commitment.criterion` 的调用方约束）。
     */
    if (draft.commitment !== undefined) {
      /*
       * ⚠️ **M10.1 / R-29**：`acceptanceEventIds` 是**程序侧**构造器（`buildAgreementProposal`）填的；
       *    **模型面**的草案闭集里没有它（模型编不了 id）⇒ 这里回落到**程序事实**：
       *    本轮那条用户事件（`sourceRef`，带**真** span 与**真**指纹）。
       *    ⚠️ 两条路的形状不同但都**有出处**：程序侧两条 id（提议 + 采纳），模型面一条（本轮的采纳）。
       *       这不是"缺一条"，而是"模型面只知道这一条"——**不猜**。
       */
      const acceptedIds = draft.commitment.acceptanceEventIds ?? []
      const acceptanceRefs =
        acceptedIds.length > 0
          ? acceptedIds.map((id) => ({
              conversationEventId: id as never,
              /*
               * ⚠️ **占位指纹**：真指纹应当来自**被引用那句话的文本**。本步只保证形状
               *    （放行口不校验指纹内容）；调用方（约定桥的构造器）会在把 `AcceptedAgreement`
               *    变成草案时用它手里的引用文本算真指纹。
               */
              fingerprint: goalSpanFingerprint(input.acceptanceEvidence?.find(entry => entry.eventId === id)?.text ?? String(id)),
            }))
          : [sourceRef]
      const commitmentTarget = {
        type: 'COMMITMENT_ACCEPTED',
        operation: 'create' as const,
        payload: {
          characterId: input.characterId,
          goalId: goalIdForCommitment,
          commitment: {
            commitmentId: 'derived-by-validator',
            goalId: goalIdForCommitment,
            actor: entityRef('character', input.characterId),
            beneficiary: entityRef('user', 'derived-by-validator'),
            scope: draft.commitment.scope,
            acceptedAt: input.now,
            acceptanceRefs,
            criterion: draft.commitment.criterion,
            status: 'active' as const,
            completionRefs: [],
            revision: 1,
          },
          expectedGoalRevision: 1,
        },
        scope: 'CHARACTER_INTERNAL' as const,
      }
      targets.push(commitmentTarget as never)
    }
    return {
      operation: draft.operation,
      programOperation: 'create',
      proposal: proposalOf(targets, 'create'),
      fact,
    }
  }

  /*
   * 其余五个"写"操作都作用于**候选集合里已存在的目标**。
   * 草案的结构校验已保证 `targetGoalId` 在候选集里；这里取它的**程序读数**
   * （`revision`）填 `expectedRevision` —— 乐观锁由此接上。
   */
  const candidate = input.candidates.find((item) => item.goalId === draft.targetGoalId)
  if (candidate === undefined) {
    throw new Error(
      `草案引用的目标 ${String(draft.targetGoalId)} 不在候选集里 —— ` +
        '结构校验本应拦住它；走到这里说明调用方给模型的候选集与给映射的候选集不一致',
    )
  }
  const base = {
    characterId: input.characterId,
    goalId: candidate.goalId,
    expectedRevision: candidate.revision,
  }

  let payload: Record<string, unknown>
  let programOperation: GoalOperation
  switch (draft.operation) {
    case 'revise':
      programOperation = 'revise'
      payload = {
        ...base,
        changed: draft.changed ?? ['statement'],
        ...(draft.statement !== undefined ? { statement: draft.statement } : {}),
        ...(draft.priority !== undefined ? { priority: draft.priority } : {}),
        ...(draft.nextStep !== undefined ? { nextStep: draft.nextStep } : {}),
        reason: '用户修订',
      }
      break
    case 'pause':
      programOperation = 'pause'
      payload = { ...base, reason: '用户暂停' }
      break
    case 'resume':
      programOperation = 'resume'
      /*
       * ⚠️ 恢复要求**依赖复核读数**（§4.6）。本模块**不**自己跑复核
       *    （那需要 WP2 的输入端口）—— 调用方必须在装配处先复核、
       *    再把读数写进这里。缺省给 `dropped: 1` 是**刻意的失败关闭**：
       *    没有复核读数就没法证明"可以恢复"，于是放行口会拒它。
       */
      payload = { ...base, recheck: { hard: 0, soft: 0, dropped: 1 } }
      break
    case 'cancel':
      programOperation = 'cancel'
      payload = {
        ...base,
        reason:
          draft.cancelKind === 'explicit_forget'
            ? 'explicit_forget'
            : draft.cancelKind === 'user_waived'
              ? 'user_waived'
              : 'user_cancel',
        ...(draft.cancelKind === 'explicit_forget'
          ? { forbiddenSourceEventIds: [input.sourceEventId] }
          : {}),
      }
      break
    case 'report_complete':
      programOperation = 'complete'
      payload = { ...base, basis: 'user_report', evidenceRefs: [sourceRef] }
      break
    default:
      throw new Error(`操作 ${draft.operation} 没有过渡 payload`)
  }

  /*
   * ⚠️ **M10.1 / 兑现的生产者**：`report_complete` 时，若这个目标身上挂着一条
   *    **未结清**、且**判据正是 `user_report`** 的承诺 ⇒ **同提案**补一条
   *    `COMMITMENT_FULFILLED`（`D26` 的"兑现补记"，自带确定性事件身份）。
   *
   * ```text
   * 三条**窄**规则（缺一不补 —— 失败关闭，不猜）：
   *   ① 只能从 `input.targetCommitments`（**已遮蔽的可见目标**）里找 ⇒ 被遗忘的目标不会被兑现；
   *   ② 承诺必须**非终态**（放行口还有一道同样的闸）；
   *   ③ 判据必须与**这次的依据同档**（`user_report` ↔ `user_report`）——
   *      `conversation_output` / `action_result` 的承诺要**程序可核对的结果**，
   *      一句"我到了"不许把它们判成兑现（`D13`：fulfilled 必须有真实结果）。
   * ```
   * ⚠️ 它**不**改 `GOAL_COMPLETED` 的那一条（目标那一半照旧）；两条事件**同生同死**
   *    （同一个提案：任一条被放行口拒 ⇒ 整批零事件）。
   */
  const pairedCommitment: GoalCommitmentSummary | undefined =
    (draft.operation === 'report_complete' || draft.operation === 'cancel') && draft.targetGoalId !== undefined
      ? input.targetCommitments?.find(
          (summary) =>
            summary.goalId === draft.targetGoalId &&
            !COMMITMENT_TERMINAL_STATUSES.includes(summary.status) &&
            (draft.operation === 'cancel' || summary.criterionKind === 'user_report'),
        )
      : undefined

  return {
    operation: draft.operation,
    programOperation,
    proposal: proposalOf(
      [
        {
          type: goalEventTypeOf(draft.operation),
          operation: draft.operation === 'cancel' ? ('retract' as const) : ('update' as const),
          payload,
          scope: 'CHARACTER_INTERNAL' as const,
        },
        ...(pairedCommitment === undefined
          ? []
          : [
              {
                type: draft.operation === 'cancel' ? 'COMMITMENT_CANCELLED' : 'COMMITMENT_FULFILLED',
                operation: draft.operation === 'cancel' ? 'retract' as const : 'update' as const,
                payload: {
                  characterId: input.characterId,
                  commitmentId: pairedCommitment.commitmentId as never,
                  goalId: pairedCommitment.goalId as never,
                  expectedRevision: pairedCommitment.revision,
                  ...(draft.operation === 'cancel' ? { reason: payload.reason } : {
                    /* 兑现的证据 = 本轮用户事件（真 span/真指纹） */
                    resultRefs: [sourceRef], basis: 'user_report' as const,
                  }),
                },
                scope: 'CHARACTER_INTERNAL' as const,
              },
            ]),
      ],
      programOperation,
    ),
    fact,
  }
}

/** 原话切片的稳定指纹（**不**把正文写进事件 —— 事件里只有坐标与指纹） */
export function goalSpanFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
