/**
 * **S8 / `ADR-107` `R-1b`** —— 私有决策调用的**有界输入**（+ 一行消息渲染）。
 *
 * ============================================================================
 *  为什么要单独一层（而不是直接拼字符串）
 * ============================================================================
 * ```text
 * ① **有界**：候选数 / 候选键长度 / 剧情正文 / 本轮原话 / 最近对话行 **各自有上界**，
 *    超出一律**如实截断并登记**（`truncated`），不静默丢。
 * ② **不进主 prompt**：本层只生产"给那一次私有调用看的"文本 ⇒
 *    `evals/fixtures/m3.5/prompt-baseline.txt` 的逐字节基线**结构上碰不到**
 *    （`ADR-107` §2.5(3)：夹具从不传 `extraProviders`，且基线脚本不读任何 flag）。
 * ③ **正文只来自内容资产**：剧情正文由调用方用 `renderStoryVisibleEvents` 渲染好再传进来 ——
 *    本层**不** import 任何 `src/content/**`（与 `R-3` 同一条纪律）。
 * ```
 *
 * ⚠️ 纯逻辑：不 import 框架 / SQL / `node:*` / 内容资产。
 */

export const STORY_CHOICE_MAX_CANDIDATES = 12
export const STORY_CHOICE_MAX_CANDIDATE_CODEPOINTS = 64
export const STORY_CHOICE_MAX_NARRATIVE_CODEPOINTS = 1200
export const STORY_CHOICE_MAX_INPUT_CODEPOINTS = 500
export const STORY_CHOICE_MAX_RECENT_LINES = 6
export const STORY_CHOICE_MAX_RECENT_LINE_CODEPOINTS = 200

export interface StoryChoiceCandidate {
  /** 机器键（内容包定义的 `choices[]` 项，**逐字**） */
  readonly choiceId: string
  /** 它在作者定义的 `choices[]` 里的**序号**（从 0 起；给模型一个可复述的位置） */
  readonly index: number
}

export interface StoryChoiceInput {
  readonly runId: string
  readonly currentNodeId: string
  readonly stage: string
  readonly revision: number
  /** 已渲染的**可见**剧情正文（调用方用内容资产的渲染器产出） */
  readonly narrative: string
  readonly candidates: readonly StoryChoiceCandidate[]
  /** 用户本轮原话 */
  readonly currentInput: string
  /** 有界的最近对话行（**最旧在前**） */
  readonly recentLines: readonly string[]
  /** 哪几处被截断过（**具名**；空数组 = 没截断） */
  readonly truncated: readonly string[]
}

/** 按**码点**截断（不拆 Unicode 字符）。 */
const clampCodepoints = (text: string, max: number): { text: string; truncated: boolean } => {
  const codepoints = [...text]
  if (codepoints.length <= max) return { text, truncated: false }
  return { text: codepoints.slice(0, max).join(''), truncated: true }
}

export type StoryChoiceInputBuild =
  | { readonly ok: true; readonly input: StoryChoiceInput }
  /** 没有候选 ⇒ **不发那次调用**（"没有可选项"与"模型说没选"是两件事） */
  | { readonly ok: false; readonly code: string; readonly detail: string }

/**
 * 组装有界输入（**纯函数**）。
 *
 * ⚠️ `candidates` **为空** ⇒ 返回 `ok:false`：那不是"让模型去猜"，而是"本轮根本没有可选项"。
 *    调用方据此**一次调用都不发**（与 `R-3b` 的"没有活跃 run 就不发"同型）。
 */
export function buildStoryChoiceInput(input: {
  readonly runId: string
  readonly currentNodeId: string
  readonly stage: string
  readonly revision: number
  readonly narrative: string
  /** 该节点作者定义的 `choices[]`（**顺序即序号**） */
  readonly nodeChoices: readonly string[]
  readonly currentInput: string
  readonly recentLines: readonly string[]
}): StoryChoiceInputBuild {
  const truncated: string[] = []

  const choices = input.nodeChoices.slice(0, STORY_CHOICE_MAX_CANDIDATES)
  if (input.nodeChoices.length > choices.length) truncated.push('candidates')

  const candidates: StoryChoiceCandidate[] = []
  for (const [index, choiceId] of choices.entries()) {
    const clamped = clampCodepoints(choiceId, STORY_CHOICE_MAX_CANDIDATE_CODEPOINTS)
    if (clamped.truncated) truncated.push(`candidate:${String(index)}`)
    candidates.push({ choiceId: clamped.text, index })
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'story_choice_no_candidates',
      detail: `节点 ${input.currentNodeId} 没有声明任何选择 ⇒ 本轮**不发**私有决策调用`,
    }
  }

  const narrative = clampCodepoints(input.narrative, STORY_CHOICE_MAX_NARRATIVE_CODEPOINTS)
  if (narrative.truncated) truncated.push('narrative')
  const currentInput = clampCodepoints(input.currentInput, STORY_CHOICE_MAX_INPUT_CODEPOINTS)
  if (currentInput.truncated) truncated.push('currentInput')

  /* 最近对话行：只取**最后 N 行**（最旧在前），每行有界；被丢掉的行**具名**登记 */
  const tail = input.recentLines.slice(-STORY_CHOICE_MAX_RECENT_LINES)
  if (input.recentLines.length > tail.length) truncated.push('recentLines')
  const recentLines: string[] = []
  for (const [index, line] of tail.entries()) {
    const clamped = clampCodepoints(line, STORY_CHOICE_MAX_RECENT_LINE_CODEPOINTS)
    if (clamped.truncated) truncated.push(`recentLine:${String(index)}`)
    recentLines.push(clamped.text)
  }

  return {
    ok: true,
    input: {
      runId: input.runId,
      currentNodeId: input.currentNodeId,
      stage: input.stage,
      revision: input.revision,
      narrative: narrative.text,
      candidates,
      currentInput: currentInput.text,
      recentLines,
      truncated,
    },
  }
}

/**
 * 渲染给模型看的那条消息。
 *
 * ⚠️ 三条纪律写进**指令本身**（它们是给模型的约束，不是装饰）：
 * ```text
 * ① 只能**报**用户已经做出的选择，**不许替用户选**（`D02.4`）
 * ② 只在用户原话确实表达了某个选项时给机器键；否则 `choiceId: null`
 * ③ 机器键必须**逐字**来自候选列表（不许改写、不许猜）
 * ```
 */
export function buildStoryChoiceUserMessage(
  input: StoryChoiceInput,
  /**
   * ⚠️ `requireQuote: false` **只给量具用**（`L-S8-31` 的 A/B 对照要能造出"变更前的 prompt"）。
   *    生产路径**永远**走缺省 `true` —— 缺省值就是那个被验证过的形状。
   */
  options: { readonly requireQuote?: boolean } = {},
): string {
  const requireQuote = options.requireQuote ?? true
  const candidateLines = input.candidates
    .map((candidate) => `  ${String(candidate.index)}. ${JSON.stringify(candidate.choiceId)}`)
    .join('\n')
  const recent = input.recentLines.length === 0 ? '（无）' : input.recentLines.map((line) => `  ${line}`).join('\n')
  const quoteParagraph = requireQuote
    ? [
        '',
        '第四条（同样硬）：给了 `choiceId` 就**必须**同时给出 `quote` ——',
        '**用户在【用户本轮原话】里逐字写过的一段字符**（照抄，不许改写、不许拼接、不许跨段）。',
        '程序会做**机械包含检查**：`quote` 不是那段原话的子串 ⇒ 整条提案被拒收。',
        '指不出任何用户自己的字 ⇒ 必须给 `choiceId: null, quote: null`（**弃权是合法答案**）。',
      ]
    : []
  const shapeLine = requireQuote
    ? '{"schemaVersion":"story-choice-draft@1","choiceId":<候选里的某个机器键，或 null>,"quote":<用户原话里的逐字片段，或 null>}'
    : '{"schemaVersion":"story-choice-draft@1","choiceId":<候选里的某个机器键，或 null>}'
  return [
    '你在做一件很窄的事：把**用户这一轮原话**里已经表达出的"剧情选项"翻译成机器键。',
    '',
    '三条硬约束：',
    '1. 你**只能报告用户已经做出的选择**。用户没选、或你拿不准 ⇒ `choiceId: null`。',
    '2. **不许替用户选**：不要因为"某个选项更好/更合理"就报它。',
    '3. 机器键必须**逐字**来自下面的候选列表，不许改写、翻译、猜测或取近似。',
    ...quoteParagraph,
    '',
    `当前节点：${input.currentNodeId}（阶段 ${input.stage}，revision ${String(input.revision)}）`,
    '',
    '【她见到的剧情正文（有界）】',
    input.narrative === '' ? '（无）' : input.narrative,
    '',
    '【本轮候选（机器键）】',
    candidateLines,
    '',
    '【最近对话（最旧在前，有界）】',
    recent,
    '',
    `【用户本轮原话】${JSON.stringify(input.currentInput)}`,
    '',
    '只输出一个 JSON 对象，形状**恰好**是：',
    shapeLine,
    '多一个字段都不要。',
  ].join('\n')
}
