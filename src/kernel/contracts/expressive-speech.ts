/** LG-owned presentation metadata. It never creates a second intent or changes checked text. */
import { KernelError } from './ids.ts'

export const EXPRESSION_VERSION = 'lg-expression@1'
export const EXPRESSION_CUES = ['natural', 'reassuring', 'playful', 'firm', 'subdued', 'surprised'] as const
export type ExpressionCue = (typeof EXPRESSION_CUES)[number]

export interface ExpressionDraft {
  text: string
  segments: { text: string; cue: ExpressionCue }[]
  fallback?: 'missing_metadata' | 'unknown_cue'
}

export interface SpeechExpression {
  version: typeof EXPRESSION_VERSION
  replyId: string
  segments: { segmentId: string; text: string; cue: ExpressionCue }[]
  fallback?: ExpressionDraft['fallback'] | 'guard_rewrite'
}

export function isExpressionCue(value: unknown): value is ExpressionCue {
  return typeof value === 'string' && (EXPRESSION_CUES as readonly string[]).includes(value)
}

/** Only the whole reserved envelope is decoded. Literal brackets/XML inside speech remain intact. */
export function decodeExpressiveSpeech(raw: string): ExpressionDraft {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('<lg-speech>')) {
    return { text: raw, segments: [{ text: raw, cue: 'natural' }], fallback: 'missing_metadata' }
  }
  const match = /^<lg-speech>([\s\S]*)<\/lg-speech>$/.exec(trimmed)
  let value: unknown
  try {
    value = match ? JSON.parse(match[1]) : undefined
  } catch {
    value = undefined
  }
  const segments = (value as { segments?: unknown } | undefined)?.segments
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 32 ||
      segments.some((segment) => !segment || typeof segment.text !== 'string' || !segment.text.trim())) {
    throw new KernelError('validation_error', 'expression_invalid_envelope', '表达元数据格式非法，拒绝把协议内容当作正文')
  }
  const unknownCue = segments.some((segment) => !isExpressionCue(segment.cue))
  const decoded = segments.map((segment) => ({
    text: String(segment.text),
    cue: isExpressionCue(segment.cue) ? segment.cue : 'natural' as const,
  }))
  return {
    text: decoded.map((segment) => segment.text).join(''),
    segments: decoded,
    ...(unknownCue ? { fallback: 'unknown_cue' as const } : {}),
  }
}

export function splitSpeechText(text: string): string[] {
  return text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/g) ?? []
}

/**
 * Lv4.5 / `P1`：**把"程序追加的附录"从**要说的**文本里去掉**（不是从账本里去掉）。
 *
 * ============================================================================
 *  为什么需要它（一条实测到的用户可见缺陷）
 * ============================================================================
 * 来源附录（`来源：` + `[E1] …https://…`）与实用能力的范围附录都是**程序**追加的，
 * 它们是给**眼睛**看的。但它们和正文拼在同一份 `replyText` 里，于是：
 *
 * ```text
 * replyText ⇒ bindSpeechExpression ⇒ 分句 ⇒ TTS ⇒ 她会把 URL 与经纬度**念出来**
 * ```
 * 实测原话（2026-10-04 真实链路日志）：
 * ```
 * Queuing TTS task for: '''[E1] 7-day forecast — https://www.kxan.com/7-day-forecast'''
 * Queuing TTS task for: '''lat=30.26759000000004&lon=-97.74298999999996'''
 * ```
 *
 * ⚠️ 这一条**只改"说什么"**，不改"记什么"：
 * ```text
 * 账本（conversation_events）仍然逐字保留带附录的正文 —— 那是"她生成过什么"的记录
 * 交付（字幕 / 语音 / 外壳聊天）拿到的是去掉附录的文本 —— 那是"她说过什么"
 * ```
 * ⚠️ 判据是**后缀且逐字**：只有当一个附录**真的**出现在文本结尾（前面隔一个空行或换行）
 *    时才去掉它。附录没出现 ⇒ 原样返回（**不**做任何模糊匹配、不猜）。
 *
 * 为什么必须成对使用：外壳会校验 `join(分句) === replyText`，
 * 因此调用方必须把**同一个**返回值同时用于分句与 `replyText`，否则那次校验会红。
 */
export function withoutAppendices(text: string, appendices: readonly string[]): string {
  let result = text
  /* 长的先剥：短附录若是长附录的后缀，先剥短的会把长的留半截 */
  const ordered = [...appendices].filter((item) => item.trim() !== '').sort((a, b) => b.length - a.length)
  /*
   * ⚠️ 必须**反复扫到不动为止**，不能只扫一轮。
   *
   * 一轮只够剥掉**一个**附录，而长度降序只保证"嵌套时不被短的挡"，**不**保证
   * "一次就命中每个附录"：
   * ```text
   * 正文 = 句子 \n\n 证据附录 \n\n 当轮内容附录      （证据附录更长）
   * 第一轮：证据附录不是后缀（此刻后缀是内容附录）⇒ 略过
   *         内容附录是后缀 ⇒ 剥掉
   *         一轮结束 ⇒ 证据附录**再也没被回头看** ⇒ 留在正文里
   * ```
   * 这不是理论情形：2026-10-05 真实链路里"联网查 + 浏览器读同一页"正好同时产生
   * 这两个附录（证据附录 3 条 / 内容附录 1 条），后果有两条且都用户可见：
   * ```text
   * ① 她真的把 `来源：\n[E1] …https://…` **念了出来**（P1 要修的就是这件事）；
   * ② 分句拼不回 `replyText`（主链路少剥一层、分句多带一层）⇒ 外壳按
   *    `join(分句) === replyText` 判定失败，整轮以 `ValueError` 被丢弃。
   * ```
   * 每剥掉一次正文都**严格变短** ⇒ 外层循环必然终止。
   */
  let changed = true
  while (changed) {
    changed = false
    for (const appendix of ordered) {
      if (!result.endsWith(appendix)) continue
      const before = result.slice(0, result.length - appendix.length)
      /* 只接受"前面是空行/换行/文本开头"的形态 —— 精确到格式，不靠模糊匹配 */
      if (before === '') {
        result = ''
        changed = true
        break
      }
      if (before.endsWith('\n\n')) {
        result = before.slice(0, -2)
        changed = true
        break
      }
      if (before.endsWith('\n')) {
        result = before.slice(0, -1)
        changed = true
        break
      }
    }
  }
  return result
}

/** A guard rewrite invalidates the old cue alignment; only final checked text leaves LG. */
export function bindSpeechExpression(replyId: string, checkedText: string, draft: ExpressionDraft): SpeechExpression {
  const rewritten = checkedText !== draft.text
  const source = rewritten ? [{ text: checkedText, cue: 'natural' as const }] : draft.segments
  const segments = source.flatMap((segment) => splitSpeechText(segment.text).map((text) => ({ text, cue: segment.cue })))
  return {
    version: EXPRESSION_VERSION,
    replyId,
    segments: segments.map((segment, index) => ({ segmentId: `${replyId}#${index}`, ...segment })),
    ...(rewritten ? { fallback: 'guard_rewrite' as const } : draft.fallback ? { fallback: draft.fallback } : {}),
  }
}
