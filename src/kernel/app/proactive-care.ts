/**
 * 「一次**自主关心**机会：从『够不够格』走到『说 / 不说 / 改期』」
 * （post-Lv2 / ADR-110 `D03`/`D04`/`D14`）。
 *
 * ============================================================================
 *  它与 `deliverReminder` 是**两条路**（`D03` 的权限差在这里落地）
 * ============================================================================
 * ```text
 * 提醒：到点了 ⇒ 她只决定**措辞**；`silence` **不构成**取消（程序模板兜底）
 * 关心：**沉默是合法结局**；她可以 defer（改期）；模型失败 ⇒ **放弃本次机会**（不硬发）
 * ```
 * ⚠️ 所以这两个 `programActionOnModelFailure` / `programActionFor` 的分岔
 *    **不是**在这里各写一遍 if，而是调用那两条**冻结的纯函数** —— 判据只有一处权威。
 *
 * ============================================================================
 *  四道闸，缺一条都不发
 * ============================================================================
 * ```text
 * ① 私有调用失败（timeout / call_failed / invalid_output）⇒ 放弃（**不**用模板假装是她说的话）
 * ② 严格解析失败（`多一个字段整条作废`）⇒ 放弃
 * ③ 来源复核（引用不在程序给的可选集里 / 可用集为空）⇒ 放弃
 * ④ `shadow` 档（`dryRun`）⇒ **完整产生选择与审计**，但**不**真的发（`D14`）
 * ```
 * ⚠️ 关心的候选正文**只活在实例行上**（意图里没有正文 —— 表级 CHECK 挡着）：
 *    所以"她说的话"落库的唯一位置是实例行的 `candidate_text`。
 */
import type { NotificationOccurrenceState } from '../contracts/notification.ts'
import type { Timestamp } from '../contracts/ids.ts'
import {
  buildProactiveInstruction,
  extractProactiveJson,
  parseProactiveProposal,
  programActionFor,
  programActionOnModelFailure,
  renderProactiveBriefing,
  verifyProactiveSources,
  type ProactiveBriefing,
  type ProactiveCallFailure,
} from '../contracts/proactive-proposal.ts'
import {
  dispatchProactiveText,
  type ProactiveActionPort,
  type ProactiveDispatchPort,
} from './proactive-delivery.ts'

/** 一次**私有**调用的结果（只有它自己知道原文；正文不进任何日志） */
export type CareEvaluationResult =
  | { readonly ok: true; readonly raw: string }
  | { readonly ok: false; readonly failure: ProactiveCallFailure }

/**
 * ⚠️ 这是**主动联系里唯一一处**会调模型的地方，而它：
 * ```text
 * · **不**产生 `user_message`（`D11` 的第一条禁令）
 * · **不**产生任何记忆事件（`D04`：程序只负责把机会摆出来）
 * · 输入是**程序渲染**的简报与指令（不是"最近几轮对话"）
 * ```
 */
export interface CareEvaluationPort {
  evaluate(input: { instruction: string; briefing: string }): Promise<CareEvaluationResult>
}

/** 持久层端口（权威在 `notification-store`） */
export interface CareStorePort {
  reserveOccurrence(input: { occurrenceKey: string }): Promise<{
    created: boolean
    state?: NotificationOccurrenceState
  }>
  advanceCare(input: {
    occurrenceKey: string
    to: NotificationOccurrenceState
    text?: string
  }): Promise<{ ok: boolean; code?: string; state?: NotificationOccurrenceState }>
  /** `defer`：把这次机会排到 `until`（**不**改意图 —— 关心没有意图） */
  deferOpportunity(input: { occurrenceKey: string; until: Timestamp }): Promise<{ ok: boolean; code?: string }>
}

export type CareOutcome =
  /** 她选择说了，而且真的交给了外壳 */
  | { readonly outcome: 'sent'; readonly occurrenceCreated: boolean; readonly actionId?: string }
  /** `shadow` 档：选择与审计都产生了，但**没有**发（`D14`） */
  | { readonly outcome: 'shadowed'; readonly decision: string; readonly occurrenceCreated: boolean }
  /** 合法的沉默（**不是**失败，也**不是**"完成了"） */
  | { readonly outcome: 'stayed_silent'; readonly code: string }
  | { readonly outcome: 'deferred'; readonly until: Timestamp }
  /** 放弃本次机会（模型失败 / 解析失败 / 来源复核不过） */
  | { readonly outcome: 'abandoned'; readonly code: string }
  /** 连"走到模型"都没走到（占用被拒 / 没有投递连接 / 网关拒） */
  | { readonly outcome: 'refused'; readonly code: string; readonly state?: NotificationOccurrenceState }

export const CARE_OPPORTUNITY_PROCESSOR = 'qq-proactive-care-opportunity'

export async function runCareOpportunity(input: {
  readonly occurrenceKey: string
  /** `shadow` 档 ⇒ 只产生选择与审计（`D14`） */
  readonly dryRun: boolean
  readonly briefing: Omit<ProactiveBriefing, 'kind'> & { kind?: 'care' }
  readonly evaluate: CareEvaluationPort
  readonly store: CareStorePort
  readonly dispatch: ProactiveDispatchPort
  readonly action: ProactiveActionPort
  readonly generation: number | null
  readonly now: Timestamp
}): Promise<CareOutcome> {
  const occurrenceKey = String(input.occurrenceKey ?? '').trim()
  if (occurrenceKey === '') return { outcome: 'refused', code: 'care_without_occurrence_key' }

  /* ---- ① 私有调用（程序渲染的指令与简报；不产生任何用户事件） -------------- */
  const evaluated = await input.evaluate.evaluate({
    instruction: buildProactiveInstruction(),
    briefing: renderProactiveBriefing({ ...input.briefing, kind: 'care' }),
  })
  if (!evaluated.ok) {
    /*
     * ⚠️ 关心这一条**没有模板兜底**（与提醒不同）：模型失败 ⇒ 放弃本次机会。
     *    用模板硬发就等于"替她说了一句她没说出口的话"。
     */
    const fallback = programActionOnModelFailure({ kind: 'care', failure: evaluated.failure })
    return { outcome: 'abandoned', code: `care_${fallback.action}_${evaluated.failure}` }
  }

  /* ---- ② 严格解析（多一个字段整条作废） ---------------------------------- */
  let parsed: ReturnType<typeof parseProactiveProposal>
  try {
    parsed = parseProactiveProposal(extractProactiveJson(evaluated.raw), {
      allowSend: true,
      allowDefer: true,
    })
  } catch {
    return { outcome: 'abandoned', code: 'care_proposal_unparsable' }
  }
  if (!parsed.ok) return { outcome: 'abandoned', code: parsed.code }

  const proposal = parsed.proposal

  /* ---- ③ 来源复核（闭集 + 空集即拒） ------------------------------------ */
  const available = new Set(input.briefing.sources.map((source) => source.ref))
  const verified = verifyProactiveSources({ sourceRefs: proposal.sourceRefs, available })
  if (!verified.ok) return { outcome: 'abandoned', code: verified.code ?? 'care_source_unverified' }

  /* ---- ④ 翻译成程序动作（**唯一**权威那两条纯函数） --------------------- */
  const programAction = programActionFor({ kind: 'care', proposal, now: input.now })
  if (programAction.action === 'stay_silent') {
    /* 合法结局：记读数，**不**发、**不**记成完成 */
    return { outcome: 'stayed_silent', code: programAction.code }
  }
  if (programAction.action === 'defer') {
    const deferred = await input.store.deferOpportunity({
      occurrenceKey,
      until: programAction.until,
    })
    return deferred.ok
      ? { outcome: 'deferred', until: programAction.until }
      : { outcome: 'refused', code: deferred.code ?? 'care_defer_refused' }
  }
  if (programAction.action !== 'deliver') {
    /* `deliver_template` / `blocked` 都**不适用于**关心（那是提醒那一条的分支） */
    return { outcome: 'abandoned', code: `care_unexpected_program_action_${programAction.action}` }
  }

  /* ---- ⑤ 占用 + 候选正文落库（**她说的话**只存在实例行上） -------------- */
  const reserved = await input.store.reserveOccurrence({ occurrenceKey })
  if (!reserved.created && reserved.state !== undefined) {
    const resumable: readonly NotificationOccurrenceState[] = ['pending', 'evaluating', 'prepared']
    if (!resumable.includes(reserved.state)) {
      return { outcome: 'refused', code: `care_occurrence_${reserved.state}`, state: reserved.state }
    }
  }
  if (reserved.state === undefined || reserved.state === 'pending') {
    const evaluating = await input.store.advanceCare({ occurrenceKey, to: 'evaluating' })
    if (!evaluating.ok) {
      return { outcome: 'refused', code: evaluating.code ?? 'care_evaluating_refused', ...(evaluating.state === undefined ? {} : { state: evaluating.state }) }
    }
  }
  if (reserved.state !== 'prepared') {
    const prepared = await input.store.advanceCare({
      occurrenceKey,
      to: 'prepared',
      text: programAction.text,
    })
    if (!prepared.ok) {
      return { outcome: 'refused', code: prepared.code ?? 'care_prepared_refused', ...(prepared.state === undefined ? {} : { state: prepared.state }) }
    }
  }

  /* ---- ⑥ `shadow` 档：走到这里就够（完整选择 + 审计，**不**发） --------- */
  if (input.dryRun) {
    return { outcome: 'shadowed', decision: proposal.decision, occurrenceCreated: reserved.created }
  }

  /* ---- ⑦ 交给外壳（先 dispatching 再执行） ------------------------------ */
  const dispatched = await dispatchProactiveText({
    occurrenceKey,
    text: programAction.text,
    kind: 'care',
    generation: input.generation,
    dispatch: input.dispatch,
    action: input.action,
  })
  return dispatched.dispatched
    ? {
        outcome: 'sent',
        occurrenceCreated: reserved.created,
        ...(dispatched.actionId === undefined ? {} : { actionId: dispatched.actionId }),
      }
    : {
        outcome: 'refused',
        code: dispatched.code ?? 'care_dispatch_refused',
        ...(dispatched.state === undefined ? {} : { state: dispatched.state }),
      }
}
