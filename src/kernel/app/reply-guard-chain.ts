/**
 * 后 Lv2 · WP1：**回复守卫链**（唯一的实现；`main.ts` 与桥的 host 都用它）。
 *
 * ============================================================================
 *  它为什么存在（这是一次**去重**，不是新能力）
 * ============================================================================
 * 五道守卫的**顺序**是一条真实契约，而且是被事故换来的：
 *
 * ```text
 *   记忆 → 承诺 → 动作 → 外部证据 → 搜索判定
 * ```
 *
 * `main.ts` 按这个顺序串联它们（每一道只认自己那一类口吻，词表互不共用）。
 * 之前的 WP1 门**自己抄了一遍**这条链 —— 而"抄一遍"正是最危险的那种重复：
 * 漏掉一道之后**行为看起来一样**（回复仍然是一句话），只是那句话**没被检查**。
 * 这不是假想的风险：R3 那版 host 就真的漏掉了**全部五道**，而门照旧 PASS。
 *
 * 因此本模块是**唯一**实现：两处调用点（生产 / 验收 host）不再各写一遍。
 *
 * ⚠️ 依赖方向：本模块在 `src/kernel/app/` 下，只 import kernel 内的纯策略
 * （`memory/response-truth`、`goal/claim-guard`、`action/claim-guard`、
 * `action/external-evidence-reply`、`action/search-need-reply`），
 * 不碰基础设施、数据库或模型。
 *
 * ⚠️ **本模块不做**的事：不调模型、不写账本、不改任何一道守卫的语义。
 * 它只是把五道守卫按既定顺序串起来，并把它们的读数翻译成 trace 的三态报告。
 */

import { KernelError } from '../contracts/ids.ts'
import { truthfulReminderReply, reminderPlanReplyMatches, reminderReplyConfirmsChannel, reminderReplyChangesChannel, claimsUnexecutedReminder, UNEXECUTED_REMINDER_REPLY, type ReminderTurnResult } from './reminder-turn.ts'
import type { ReplyGuardReport } from '../contracts/reply-guard.ts'
import type { ExternalEvidenceTurnReality } from '../contracts/external-evidence.ts'
import type { ExplicitMemoryTurnResult } from './memory/explicit-turn.ts'
import type { ActionTurnResult } from '../action/action-turn.ts'
import { applyResponseTruthPolicy } from './memory/response-truth.ts'
import { applyCommitmentClaimGuard, applySettlementConfirmationGuard, commitmentWriteFacts } from './goal/claim-guard.ts'
import { applyActionClaimGuard } from '../action/claim-guard.ts'
import {
  applyExternalEvidenceReplyPolicy,
  searchFactOf,
} from '../action/external-evidence-reply.ts'
import { applySearchNeedReplyPolicy, searchNeedDiagnosticsOf } from '../action/search-need-reply.ts'
import {
  applyTurnContentReplyPolicy,
  turnContentFactsOf,
} from '../action/turn-content-reply.ts'
import type { TurnContentContextReality } from '../contracts/turn-content.ts'

/**
 * 本轮**目标回合的写入读数**。
 *
 * ⚠️ 形状与 `IncomingTurn.goalWriteReality` **逐字相同**（它就是那个字段的类型）：
 * 承诺守卫的键必须是**程序事实**（放行口实际受理了什么、提交了几条），
 * 而不是"模型说它记下了"。
 */
export interface GoalWriteReality {
  /** 放行口实际受理的事件类型（原样） */
  readonly acceptedEventTypes: readonly string[]
  /** 实际提交的事件数（0 = 这一轮什么都没写） */
  readonly eventsCommitted: number
}

export interface ReplyGuardChainInput {
  /**
   * ★ A2（2026-10-10）：本轮用户原话**是不是在要求她记住/改动记忆** —— 由
   * `asksToRemember()`（`memory/remember-request.ts`）算出的**程序事实**。
   *
   * ⚠️ 与这条链的其余字段同一条纪律：**事实由调用方喂，判据在链里**。
   * ⚠️ 三态：`undefined` = 调用方还没接（保持既有行为）· `true` = 记忆轮 · `false` = 不归记忆域管。
   */
  userAskedToRemember?: boolean
  /** 逐句检查不要求每句话都重复整轮确认；完整回复仍必须核对确认内容。 */
  partialReply?: boolean
  reminderResult?: ReminderTurnResult
  goalFact?: import('../context/goal-sections.ts').GoalFactView
  /** 模型刚生成的**原始**正文（未检查） */
  replyText: string
  /** 本轮显式记忆写入结果（`undefined` = 这一轮没有显式记忆指令） */
  memoryWriteResult?: ExplicitMemoryTurnResult
  /** 本轮目标回合的写入读数（承诺守卫的键是**程序事实**） */
  goalWriteReality?: GoalWriteReality
  /** 本轮动作结果（动作守卫的键是**执行结果**） */
  actionResults?: readonly ActionTurnResult[]
  /** 本轮证据的真实结局（证据守卫的键是**实际入模集合**） */
  externalEvidenceInContext?: ExternalEvidenceTurnReality
  /**
   * 本轮**当轮内容**的真实结局（实用能力守卫的键同样是**实际入模集合**）。
   *
   * ⚠️ 与 `externalEvidenceInContext` 并列、互不顶替：搜索证据与
   *    "她自己读到的正文"是两件事（前者是摘要，后者是长正文或程序结果）。
   */
  turnContentInContext?: TurnContentContextReality
}

export interface ReplyGuardChainOutcome {
  /** 提醒纠错单列，避免把它读成承诺域写入/纠错。 */
  reminder?: { corrected: boolean; outcome: string }
  /** **检查后**的正文 —— 写账本、写 memories、回给用户、播出，全部用这一个 */
  replyText: string
  /** 进 `completeTurn` 的 trace 三态报告 */
  reports: ReplyGuardReport[]
  /** 哪些守卫真的改写了正文（**不是**产品失败，是"守卫在工作"） */
  corrected: {
    memoryTruth: boolean
    commitmentTruth: boolean
    actionTruth: boolean
    evidenceTruth: boolean
    searchNeed: boolean
  }
  /** 只放枚举标签与标记词（**不含正文**）—— 供日志与诊断 */
  markers: {
    memoryTruth: readonly string[]
    commitmentTruth: readonly string[]
    actionTruth: readonly string[]
    evidenceTruth: readonly string[]
    strippedCitationLabels: readonly string[]
    searchNeedState?: string
  }
  /** 证据守卫的结局态（五态之一）；调用方据此决定要不要报"本轮搜索=…" */
  evidenceState: string
  /** 证据来源附录（查到并形成证据时**非空**，由程序确定性追加） */
  evidenceAppendix: string
  /**
   * 实用能力守卫的结局（**它没有自己的 trace 名字**，见 `runReplyGuardChain` 第 ⑤ 步）。
   *
   * 三件读数与证据守卫同构：逐能力的态、程序追加的来源与范围附录、被剥离的自造标签。
   * ⚠️ `corrected` 为 true 有两种原因（剥离标签或顶替措辞），与证据守卫一致 ——
   *    这不是产品失败，是"守卫在工作"。
   */
  turnContent: {
    /** 逐能力的态（保序；空数组 = 这一轮没有实用能力动作） */
    readonly states: readonly { capability: string; state: string }[]
    /** 交付态时由程序追加的**来源与范围**附录（空串 = 没有附录） */
    readonly appendix: string
    readonly corrected: boolean
    readonly markers: readonly string[]
    readonly strippedLabels: readonly string[]
  }
  /**
   * 逐道守卫的原始读数。
   *
   * ⚠️ 它们是给**复查守卫**（`main.ts`）用的：后者要按自己那份更细的理由码
   * 构造 trace（例如"这一轮没有动作结果" ⇒ `['no_action_results']` 而不是空数组）。
   * 把细粒度读数暴露出来，才能既**只有一份链实现**、又**逐字保留**既有 trace。
   */
  readings: {
    /** 这一轮有没有**具体的**动作结果（`result !== undefined`） */
    hasConcreteActionResults: boolean
    /** 判定结论是否缺席（缺席 ⇒ `search_need` 记 `not_run`） */
    searchNeedAbsent: boolean
    /** 证据守卫是不是"这一轮没搜" */
    evidenceNoSearch: boolean
  }
}

/**
 * 按 `main.ts` 的**既定顺序**串联五道守卫。
 *
 * 失败关闭：五道守卫里的任何一道抛错都**直接抛出**（不吞、不降级）。
 * 吞掉它等于放一句**没被检查**的话出去 —— 那正是本模块要阻止的事。
 */
export function runReplyGuardChain(input: ReplyGuardChainInput): ReplyGuardChainOutcome {
  if (typeof input.replyText !== 'string') {
    throw new KernelError(
      'validation_error',
      'reply_guard_chain_without_text',
      '守卫链必须拿到一段待检查的正文：没有正文就没有可检查的东西'
    )
  }

  // ① 记忆写入真相
  const memoryTruth = applyResponseTruthPolicy({
    result: input.memoryWriteResult,
    replyText: input.replyText,
    /* ★ A2：不传就保持既有行为（三态语义见 `ResponseTruthInput`） */
    ...(input.userAskedToRemember === undefined
      ? {}
      : { userAskedToRemember: input.userAskedToRemember }),
  })

  // ② 目标 / 承诺真相（键是程序事实：目标回合的写入读数 + 记忆写入结论）
  let commitmentTruth = applyCommitmentClaimGuard({
    ...commitmentWriteFacts(input.goalWriteReality),
    anythingWritten:
      input.memoryWriteResult?.kind === 'written' ||
      input.memoryWriteResult?.kind === 'already_applied' ||
      (input.goalWriteReality?.eventsCommitted ?? 0) > 0 ||
      (input.reminderResult !== undefined && (['scheduled', 'updated', 'existing'].includes(input.reminderResult.kind)
        || (input.reminderResult.kind === 'planned' && input.reminderResult.items.some(item => ['created', 'updated', 'cancelled'].includes(item.status))))),
    replyText: memoryTruth.replyText,
  })
  const reminder = input.reminderResult
  let reminderCorrected = false
  if (input.goalFact?.outcome === 'failed' && /记|目标|约定|说清|再说一遍|没.*交代/u.test(commitmentTruth.replyText)) {
    const timeout = input.goalFact.rejectionCodes?.includes('timeout') === true
    commitmentTruth = { ...commitmentTruth, corrected: true, replyText: `这轮目标处理${timeout ? '超时' : '失败'}，尚未确认新增记录成功。已经交代的内容不需要重复。` }
  }
  const settledCount = input.goalFact?.outcome === 'query' ? input.goalFact.settledGoalCount ?? 0
    : input.goalFact?.outcome === 'accepted' && input.goalFact.operation === 'report_complete' &&
      (input.goalWriteReality?.eventsCommitted ?? 0) > 0
      ? input.goalWriteReality!.acceptedEventTypes.filter(type => type === 'GOAL_COMPLETED').length : 0
  const settlement = applySettlementConfirmationGuard(commitmentTruth.replyText, settledCount)
  if (settlement.corrected) commitmentTruth = { ...commitmentTruth, corrected: true, replyText: settlement.replyText,
    markers: [...commitmentTruth.markers, 'settlement_reconfirmation'] }
  let checkedRecordText = commitmentTruth.replyText
  if (reminder?.kind === 'none' && claimsUnexecutedReminder(checkedRecordText)) {
    checkedRecordText = UNEXECUTED_REMINDER_REPLY
    reminderCorrected = true
  }
  if (reminder !== undefined && reminder.kind !== 'none') {
    const success = 'text' in reminder
    // 通知结果优先于泛化的“没写记录”；正文仍允许角色自然措辞。
    if ((reminder.kind === 'planned' && input.partialReply !== true && !reminderPlanReplyMatches(reminder, commitmentTruth.replyText))
      || (!success && reminder.kind !== 'planned' && (claimsUnexecutedReminder(commitmentTruth.replyText) || /已(?:经)?设置|记下了|记这条|已取消|取消了|已改期|改好了/u.test(commitmentTruth.replyText)))
      || /没(?:真)?记|没找到.*记忆|没有.*记录|再说一遍|提醒什么|说清|默认.*哪|没有.*提醒能力|已经(?:发送|发消息)|发了.{0,8}消息/u.test(commitmentTruth.replyText)
      || (success && (reminderReplyChangesChannel(reminder, commitmentTruth.replyText)
        || (input.partialReply !== true && (!reminderReplyConfirmsChannel(reminder, commitmentTruth.replyText)
          || !commitmentTruth.replyText.includes(reminder.text.replace(/^记得/u, '').replace(/[。！!？?]$/u, ''))))))) {
      checkedRecordText = truthfulReminderReply(reminder)
      reminderCorrected = true
    }
  }

  // ③ 动作真相（键是执行结果）
  const actionTruth = applyActionClaimGuard({
    results: input.actionResults
      ?.map((result) => result.result)
      .filter((result) => result !== undefined),
    replyText: checkedRecordText,
  })

  // ④ 外部证据真相（剥离自造引用标签 + 查到就追加确定性附录）
  const searchFact = input.actionResults ? searchFactOf(input.actionResults) : undefined
  const evidenceTruth = applyExternalEvidenceReplyPolicy({
    ...(searchFact !== undefined ? { search: searchFact } : {}),
    ...(input.externalEvidenceInContext !== undefined
      ? { reality: input.externalEvidenceInContext }
      : {}),
    replyText: actionTruth.replyText,
  })

  // ⑤ 当轮内容真相（剥离自造引用标签 + 交付就追加确定性来源与范围附录）
  /*
   * ⚠️ **它没有自己的 trace 报告名字**（与承诺守卫同一个先例）：受控词汇表只有
   *    `memory_truth / action_truth / evidence_truth / search_need` 四个名字，
   *    扩 trace 白名单是另一件事（见 `buildGuardReports` 的文件头）。
   *    它的效果体现在它改写后的文本上，读数经 outcome 的独立字段暴露给调用方。
   */
  const turnContentFacts = turnContentFactsOf(input.actionResults)
  const turnContentTruth = applyTurnContentReplyPolicy({
    ...(turnContentFacts !== undefined ? { facts: turnContentFacts } : {}),
    ...(input.turnContentInContext !== undefined
      ? { reality: input.turnContentInContext }
      : {}),
    replyText: evidenceTruth.replyText,
  })

  // ⑥ 搜索判定结论绑定
  const needDiagnostics = searchNeedDiagnosticsOf(input.actionResults)
  const needReply = applySearchNeedReplyPolicy({
    ...needDiagnostics,
    searchState: evidenceTruth.state,
    replyText: turnContentTruth.replyText,
  })

  const hasConcreteActionResults =
    input.actionResults?.some((result) => result.result !== undefined) ?? false
  const searchNeedAbsent =
    needDiagnostics.code === undefined && needDiagnostics.decision === undefined

  return {
    replyText: needReply.replyText,
    ...(reminder !== undefined && (reminder.kind !== 'none' || reminderCorrected) ? { reminder: { corrected: reminderCorrected, outcome: reminder.kind } } : {}),
    reports: buildGuardReports({
      memoryTruthCorrected: memoryTruth.corrected,
      memoryMarkers: memoryTruth.markers,
      hasMemoryWriteResult: input.memoryWriteResult !== undefined,
      commitmentTruthCorrected: commitmentTruth.corrected,
      actionTruthCorrected: actionTruth.corrected,
      actionMarkers: actionTruth.markers,
      hasConcreteActionResults,
      evidenceMarkers: evidenceTruth.markers,
      strippedCitationLabels: evidenceTruth.strippedCitationLabels,
      evidenceState: evidenceTruth.state,
      searchNeedState: needReply.state,
      searchNeedAbsent,
      searchNeedReplaced: needReply.replaced,
    }),
    corrected: {
      memoryTruth: memoryTruth.corrected,
      commitmentTruth: commitmentTruth.corrected,
      actionTruth: actionTruth.corrected,
      evidenceTruth:
        evidenceTruth.markers.length > 0 || evidenceTruth.strippedCitationLabels.length > 0,
      searchNeed: needReply.replaced,
    },
    markers: {
      memoryTruth: memoryTruth.markers,
      commitmentTruth: commitmentTruth.markers,
      actionTruth: actionTruth.markers,
      evidenceTruth: evidenceTruth.markers,
      strippedCitationLabels: evidenceTruth.strippedCitationLabels,
      ...(needReply.state !== undefined ? { searchNeedState: String(needReply.state) } : {}),
    },
    evidenceState: evidenceTruth.state,
    evidenceAppendix: evidenceTruth.appendix,
    turnContent: {
      states: turnContentTruth.states.map((entry) => ({
        capability: entry.capability,
        state: entry.state,
      })),
      appendix: turnContentTruth.appendix,
      corrected: turnContentTruth.corrected,
      markers: turnContentTruth.markers,
      strippedLabels: turnContentTruth.strippedLabels,
    },
    readings: {
      hasConcreteActionResults,
      searchNeedAbsent,
      evidenceNoSearch: evidenceTruth.state === 'no_search',
    },
  }
}

/**
 * trace 三态（`ADR-055 D-55g`）。
 *
 * ⚠️ 受控词汇表只有**四个名字**（`memory_truth / action_truth / evidence_truth /
 * search_need`）：承诺守卫确实在文本链上运行，但它**没有**自己的名字 ——
 * 这是既有契约，本模块**不**擅自扩它（扩 trace 白名单是另一件事）。
 *
 * ⚠️ `reasons` 只放**枚举标签与标记词**（短词，不含正文）。
 */
function buildGuardReports(input: {
  hasMemoryWriteResult: boolean
  memoryTruthCorrected: boolean
  memoryMarkers: readonly string[]
  commitmentTruthCorrected: boolean
  actionTruthCorrected: boolean
  actionMarkers: readonly string[]
  hasConcreteActionResults: boolean
  evidenceState: string
  evidenceMarkers: readonly string[]
  strippedCitationLabels: readonly string[]
  searchNeedState: string | undefined
  searchNeedAbsent: boolean
  searchNeedReplaced: boolean
}): ReplyGuardReport[] {
  return [
    {
      name: 'memory_truth',
      state: !input.hasMemoryWriteResult
        ? 'not_run'
        : input.memoryTruthCorrected
          ? 'triggered'
          : 'passed',
      reasons: !input.hasMemoryWriteResult
        ? ['no_explicit_memory_instruction']
        : input.memoryTruthCorrected
          ? [...input.memoryMarkers]
          : [],
    },
    {
      /*
       * ⚠️ 承诺守卫**没有**自己的名字（见函数头）。它的效果体现在它改写后的文本上，
       * 并被记进 `action_truth` 那一步的输入。
       *
       * ⚠️ 这一条的 `not_run` 判据是"**有没有具体的动作结果**"
       * （`result !== undefined`），而不是"传没传 `actionResults`" ——
       * 与既有的 `main.ts` 逐字一致：契约上 `actionResults` 可以是空数组，
       * 那与"这一轮没有动作"是同义。
       */
      name: 'action_truth',
      state: !input.hasConcreteActionResults
        ? 'not_run'
        : input.actionTruthCorrected
          ? 'triggered'
          : 'passed',
      reasons: !input.hasConcreteActionResults
        ? ['no_action_results']
        : input.actionTruthCorrected
          ? [...input.actionMarkers]
          : [],
    },
    {
      name: 'evidence_truth',
      state:
        input.evidenceState === 'no_search'
          ? 'not_run'
          : input.evidenceMarkers.length > 0 || input.strippedCitationLabels.length > 0
            ? 'triggered'
            : 'passed',
      reasons:
        input.evidenceState === 'no_search'
          ? ['no_search_this_turn']
          : [
              input.evidenceState,
              ...(input.strippedCitationLabels.length > 0
                ? [`stripped_citation_labels:${String(input.strippedCitationLabels.length)}`]
                : []),
              ...input.evidenceMarkers,
            ],
    },
    {
      name: 'search_need',
      state: input.searchNeedAbsent ? 'not_run' : input.searchNeedReplaced ? 'triggered' : 'passed',
      reasons: input.searchNeedAbsent
        ? ['no_search_need_judgment']
        : input.searchNeedReplaced && input.searchNeedState !== undefined
          ? [input.searchNeedState]
          : [],
    },
  ]
}
