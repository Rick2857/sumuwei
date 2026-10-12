/**
 * Lv4.5 / ADR-131 `D04` · `D18` —— 皮套入口**主动开口**的**生成侧**（契约 + 纯函数）。
 *
 * ============================================================================
 *  与邻居的分工（**不要在这里越界**）
 * ============================================================================
 * ```text
 * `contracts/proactive-opening.ts`   机会预检（15 条具名拒绝）—— 纯 contracts，无 app 依赖
 * **本文件**                        提示词 · 严格解析 · 候选构造 · 表达信封
 * `character-output.ts`             话权仲裁与出站（**唯一的**长度/来源/版本判据在那儿）
 * `infrastructure/**`               真的调模型（本文件**不**调）
 * 装配根                            落账 / 投递 / trace（本文件不碰）
 * ```
 *
 * ============================================================================
 *  ⚠️ 三处刻意的"不重复实现"（`L-QQP-09` 那条纪律）
 * ============================================================================
 * ```text
 * ① 上限**从契约派生**：提示词里写的句数/字数直接引 `CHARACTER_OUTPUT_LIMITS`，
 *    本文件**不**另写一份数字（写两份迟早漂移）。
 * ② 解析器**只判形状**，不判长度：长度/来源/版本的执行**只有一处** ——
 *    `arbitrateCharacterOutput`。若解析器也判一遍，就变成"两处判同一件事"，
 *    而且会让"太长"这件事从**读数**（`output_too_long`）退化成**解析失败**。
 * ③ 依据集**不自己拼**：直接复用 ADR-111 的 `boundProactiveSources` 与
 *    `renderSystemOpportunitySection`（后者"空集 ⇒ undefined"就是 `S06` 的失败关闭）。
 * ```
 */

import { type ExpressionCue } from '../../contracts/expressive-speech.ts'
import {
  type ProactiveSourceCandidate,
  boundProactiveSources,
  renderSystemOpportunitySection,
} from '../../contracts/proactive-proposal.ts'
import {
  CHARACTER_OUTPUT_LIMITS,
  arbitrateCharacterOutput,
  type CharacterOutputCandidate,
  type FloorState,
} from './character-output.ts'
/*
 * ⚠️ 守卫链**直接 import**（不做注入）：它本身是纯函数，而且"五道守卫只有一份实现"
 *    正是 `postlv2:bridge:verify` 的 B11 在守的事 —— 再包一层注入反而多一处可能的漂移。
 */
import { runReplyGuardChain } from '../reply-guard-chain.ts'

/**
 * 本条通道的**程序既定**表达提示（cue）。
 *
 * ⚠️ v1 **不让模型挑 cue**：与既有三类来源（`wake_response` / `mid_turn_correction` /
 *    `authorized_lookup_notice`）**同一条纪律** —— 它们的 cue 都是程序常量。
 *    若将来要模型挑 cue，那是一次**独立修订**（会引入"未知 cue 怎么办"这个新面）。
 */
export const PROACTIVE_OPENING_CUE: ExpressionCue = 'natural'

/** 上限**与出站仲裁同源**（本文件不另写一份） */
export const OPENING_MAX_SENTENCES = CHARACTER_OUTPUT_LIMITS.maxSentences
export const OPENING_MAX_CHARACTERS = CHARACTER_OUTPUT_LIMITS.maxCharacters

/**
 * 提示词（**从契约派生**，见文件头 ①）。
 *
 * ⚠️ 它刻意**不说**"用户让你主动找他"：那会诱导模型把这次调用当成一次入站对话。
 *    这与 ADR-110 `D04` 的同一条纪律（"只说这是一次机会"）。
 */
export function buildOpeningInstruction(): string {
  return [
    '现在是**一次机会**：对方就在电脑前，页面连着，但他没有说话。',
    '你可以选择主动说一句，也可以什么都不说。',
    '',
    '硬规则：',
    '1. **只输出 JSON**：不要解释、不要 markdown 代码围栏、不要在 JSON 前后写任何字。',
    '2. 只能有一个字段 `text`。**多一个字段整条作废**。',
    '3. `text` 最多 ' +
      String(OPENING_MAX_SENTENCES) +
      ' 句、最多 ' +
      String(OPENING_MAX_CHARACTERS) +
      ' 个字（含标点）。**超一个字整条作废**（程序不截断、不改写）。',
    '4. 说**你自己**的话，不要复述上面的依据条目，也不要提"根据…资料"。',
    '5. 不要宣称任何你**没有做过**的事（没有查过、没有记过、没有发过）。',
    '',
    '什么时候**不要**说（这些情况下宁可不输出、也不要硬凑）：',
    '· 依据里的东西不值得打断他；',
    '· 你只是想寒暄；',
    '· 你不确定他要不要听。',
  ].join('\n')
}

/** 一次机会的**有界依据面**（ADR-111 `S01`–`S03`）：空集 ⇒ `undefined`（`S06` 失败关闭） */
export interface OpeningEvidence {
  readonly section: { readonly text: string; readonly sourceRefs: readonly string[] } | undefined
  readonly sourceRefs: readonly string[]
}

/**
 * 把候选来源**有界化**并渲染成机会依据面。
 *
 * ⚠️ 它**只**转发 ADR-111 的两个既有函数 —— 本文件**不**再筛一遍、**不**再截一次。
 *    `sourceRefs` 为空的含义是"这一轮没有可采信的凭据"⇒ 调用方**必须**
 *    在调模型之前就拒（预检的 `opening_without_evidence`）。
 */
export function buildOpeningEvidence(candidates: readonly ProactiveSourceCandidate[]): OpeningEvidence {
  const section = renderSystemOpportunitySection(candidates)
  if (section === undefined) return { section: undefined, sourceRefs: [] }
  return { section: { text: section.text, sourceRefs: [...section.sourceRefs] }, sourceRefs: [...section.sourceRefs] }
}

/** 有界读取器（闭集：只有一个 `text`）—— 与 `readReminderTextResponse` 同一条纪律 */
export type OpeningTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string }

/**
 * 读模型输出。**只判形状**（见文件头 ②）：对象 / 恰一个键 `text` / 非空字符串。
 */
export function readOpeningResponse(raw: unknown): OpeningTextResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'opening_text_not_object' }
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'text') {
    return { ok: false, code: 'opening_text_unknown_field' }
  }
  const value = (raw as { text?: unknown }).text
  if (typeof value !== 'string') return { ok: false, code: 'opening_text_not_string' }
  const text = value.trim()
  if (text === '') return { ok: false, code: 'opening_text_empty' }
  return { ok: true, text }
}

/**
 * 造一条 `proactive_opening` 候选。
 *
 * ⚠️ 长度 / 来源非空 / 版本 **都不在这里判**（见文件头 ②）——
 *    它们由 `arbitrateCharacterOutput` 一处执行，并在那里留下具名读数。
 */
export function buildOpeningCandidate(input: {
  readonly text: string
  readonly sourceRefs: readonly string[]
  readonly turnRevision: number
}): CharacterOutputCandidate {
  return {
    text: input.text,
    source: 'proactive_opening',
    turnRevision: input.turnRevision,
    sourceRefs: [...input.sourceRefs],
  }
}

/**
 * 表达信封：`<lg-speech>{...}</lg-speech>`。
 *
 * ⚠️ 形状**逐字照抄**既有三类来源的写法（`turn-bridge.ts` 里三处同形）：
 *    交付链（`deliver_character_output`）**要求** payload 带 `expression` 且 `segments` 非空，
 *    否则记 `character_output_without_expression` 而**根本播不出来**（ADR-131 §7-U4 的硬前置）。
 * ⚠️ `replyId` 由调用方给：插话的 `requestId` 恒为空字符串，但表达需要一个稳定 id
 *    （既有三类用的是 `replyId` 概念，本函数只负责拼装）。
 */
export function renderOpeningExpressionEnvelope(input: {
  readonly replyId: string
  readonly text: string
  readonly cue?: ExpressionCue
}): string {
  const cue = input.cue ?? PROACTIVE_OPENING_CUE
  return `<lg-speech>${JSON.stringify({ segments: [{ text: input.text, cue }] })}</lg-speech>`
}

/**
 * 依据面里**最多**能出现几条（转发 ADR-111 的上限常量，便于装配层与门引同一个数）。
 * ⚠️ **不**在这里重新计算：真正的有界化在 `boundProactiveSources`。
 */
export function boundOpeningSourceRefs(candidates: readonly ProactiveSourceCandidate[]): string[] {
  return boundProactiveSources(candidates).map((option) => option.ref)
}

/* ==========================================================================
 *  编排：一次机会从"够格"走到"造出一条候选"
 * ========================================================================== */

/** 模型端口（**由基础设施实现**；本文件不碰 key / 网络 / fetch） */
export interface OpeningModelPort {
  readonly id: string
  readonly endpointHost: string
  invoke(input: { readonly instruction: string; readonly briefing: string; readonly timeoutMs: number }): Promise<OpeningModelResult>
}

export type OpeningModelResult =
  | { readonly ok: true; readonly raw: string }
  /* ⚠️ 三个失败桶**必须分开**（照抄 `openai-proactive-care.ts` 的实测判据）：
   *    "没调成功" ≠ "调成功了但它没给可解析的东西" */
  | { readonly ok: false; readonly failure: 'call_failed' | 'timeout' | 'invalid_output' }

export interface OpeningRunInput {
  /** **必须是**已 `eligible` 的预检结果：编排层不重判闸，只消费它 */
  readonly precheck: {
    readonly eligible: true
    readonly opportunityKey: string
    readonly idleMs: number
    readonly deadlineMs: number
  }
  /** 依据候选（本模块自己 `boundProactiveSources` 有界化） */
  readonly candidates: readonly ProactiveSourceCandidate[]
  readonly model: OpeningModelPort
  /* 她这次开口属于哪一版（话权协调的键；由装配层给，本模块不自己造） */
  readonly turnRevision: number
  /**
   * 用户当前的话权读数。
   *
   * ⚠️ 由装配层按**真实读数**填（与预检里那几个读数同一条纪律：本模块不猜）。
   *    它传给 `arbitrateCharacterOutput` —— 于是"用户在说话就不说"这条
   *    **不会**在本模块里被实现第二遍。
   */
  readonly floor: FloorState
  /**
   * **发送前**再读一次依据面（ADR-111 `S04`）。
   *
   * ⚠️ 它是**异步**的：真实的复核要**读库**（`buildProactiveSourceCandidates`）。
   *    第一版写成了同步的 `() => readonly …[]` —— 那是一处**会卡住接线**的类型错
   *    （WP5b 接线时才发现：装配层拿不出同步的复核）。
   *
   * ⚠️ 给它是为了让"两次核对的是**同一个函数**"在结构上成立（`S04` 的原话）；
   *    不给 ⇒ 记 `opening_recheck_not_wired` 并**拒**（宁可不发，也不发一条没复核过的）。
   */
  readonly recheckEvidence?: () => Promise<readonly ProactiveSourceCandidate[]>
}

export type OpeningRunOutcome =
  | {
      readonly kind: 'spoken'
      readonly candidate: CharacterOutputCandidate
      readonly text: string
      /**
       * **回复守卫改写前**的正文。
       *
       * ⚠️ 为什么要把它也交出来：`bindSpeechExpression(replyId, checkedText, draft)` 靠
       *    `checkedText !== draft.text` 判断"守卫改写过了"，改写时它会**回落 natural cue**
       *    并标上 `fallback: 'guard_rewrite'`。若装配层把改写后的正文**同时**当 draft 传，
       *    那个诚实的标记就**永远不会出现**（看起来像"从没被改写"）。
       */
      readonly draftText: string
      readonly sourceRefs: readonly string[]
      readonly cue: ExpressionCue
      readonly idleMs: number
      readonly deadlineMs: number
      /** 守卫是否改写过正文（**不是**失败，是"守卫在工作"） */
      readonly guardCorrected: boolean
      readonly guardMarkers: readonly string[]
    }
  | { readonly kind: 'silenced'; readonly code: string; readonly detail: string }

/**
 * 跑完一次主动开口机会。
 *
 * ============================================================================
 *  判据顺序（顺序即判据；每一步失败都**不往下走**）
 * ============================================================================
 * ```text
 * ① 依据集有界化（空 ⇒ 拒，**不花模型调用**）        ← S06
 * ② 造提示词 + 简报（都是**程序渲染**，不是"最近几轮对话"）
 * ③ **一次**模型调用（不重试、不降级重问）
 * ④ 失败按桶分开：call_failed / timeout / invalid_output
 * ⑤ JSON 解析（不是 JSON ⇒ 具名拒）
 * ⑥ 形状读取（闭集字段；**不判长度**）
 * ⑦ **过回复守卫**（`runReplyGuardChain`；只喂 `replyText`，其余域事实缺席）
 * ⑧ **发送前再核对一次依据面**（`S04`；给了 `recheckEvidence` 才做）
 * ⑨ 造候选 → **既有仲裁**（长度 / 来源 / 版本 / 话权**只有那一处执行**）
 * ```
 * ⚠️ ⑦ 在 ⑨ **之前**：守卫可能改写正文，而被改写后的正文**也必须**守住长度上限 ——
 *    仲裁在更下游做这件事，于是"守卫改长了"会如实落成 `output_too_long`，而不是偷偷放过。
 */
export async function runOpeningOpportunity(input: OpeningRunInput): Promise<OpeningRunOutcome> {
  const silence = (code: string, detail: string): OpeningRunOutcome => ({ kind: 'silenced', code, detail })

  /* ① 依据集（空 ⇒ 不花模型） */
  const evidence = buildOpeningEvidence(input.candidates)
  if (evidence.section === undefined || evidence.sourceRefs.length === 0) {
    return silence('opening_without_evidence', '有界依据集为空 ⇒ 不说，且不花模型调用（ADR-111 S06）')
  }

  /* ② 提示词 + 简报 */
  const instruction = buildOpeningInstruction()
  const briefing = evidence.section.text

  /* ③ 一次调用（不重试） */
  let result: OpeningModelResult
  try {
    result = await input.model.invoke({ instruction, briefing, timeoutMs: input.precheck.deadlineMs })
  } catch {
    /* 端口**抛错**也归 `call_failed`：绝不把异常当"她决定不说话" */
    result = { ok: false, failure: 'call_failed' }
  }
  if (!result.ok) return silence(result.failure, `模型这一轮没有可用的决策（${result.failure}）`)

  /* ⑤ JSON */
  let parsed: unknown
  try {
    parsed = JSON.parse(result.raw)
  } catch {
    return silence('opening_text_not_json', '模型给的正文不是 JSON')
  }

  /* ⑥ 形状（不判长度） */
  const shaped = readOpeningResponse(parsed)
  if (!shaped.ok) return silence(shaped.code, '模型输出形状非法（闭集字段）')

  /* ⑦ 回复守卫（只喂 replyText；其余域事实缺席 = 她确实没有那些事实） */
  const guarded = runReplyGuardChain({ replyText: shaped.text })
  const checked = guarded.replyText

  /* ⑧ 发送前再核对依据面（S04） */
  if (input.recheckEvidence === undefined) {
    return silence('opening_recheck_not_wired', '没有接"发送前再核对依据面" ⇒ 宁可不发（ADR-111 S04）')
  }
  const after = buildOpeningEvidence(await input.recheckEvidence())
  if (after.section === undefined || after.sourceRefs.length === 0) {
    return silence('opening_evidence_expired', '发送前复核：依据集已空 ⇒ 整条作废，不修补（S04）')
  }
  const before = [...evidence.sourceRefs].join('\u0000')
  const now = [...after.sourceRefs].join('\u0000')
  if (before !== now) {
    return silence('opening_evidence_changed', '发送前复核：依据集变了 ⇒ 整条作废，不修补（S04）')
  }

  /* ⑨ 造候选 → **交给既有仲裁**（长度 / 来源 / 版本 / 话权只有那一处执行） */
  const candidate = buildOpeningCandidate({
    text: checked,
    sourceRefs: evidence.sourceRefs,
    turnRevision: input.turnRevision,
  })
  const decision = arbitrateCharacterOutput({ candidate, floor: input.floor })
  if (decision.action !== 'speak') {
    return silence(
      decision.code,
      `既有仲裁没有放行（${decision.action}）：长度 / 来源 / 版本 / 话权之一不成立`
    )
  }
  const correctedFlag =
    guarded.corrected.memoryTruth ||
    guarded.corrected.commitmentTruth ||
    guarded.corrected.actionTruth ||
    guarded.corrected.evidenceTruth ||
    guarded.corrected.searchNeed
  return {
    kind: 'spoken',
    candidate,
    text: decision.text,
    draftText: shaped.text,
    sourceRefs: evidence.sourceRefs,
    cue: PROACTIVE_OPENING_CUE,
    idleMs: input.precheck.idleMs,
    deadlineMs: input.precheck.deadlineMs,
    guardCorrected: correctedFlag,
    guardMarkers: [...guarded.markers.memoryTruth],
  }
}
