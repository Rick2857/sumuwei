/**
 * **S8 / `ADR-107` `R-1b`** —— 私有决策调用的**端口与读数**（与 `tool-decision.ts` 同型）。
 *
 * ============================================================================
 *  分工（与 ADR-104 的角色工具决策逐条同构）
 * ============================================================================
 * ```text
 * 端口（infrastructure）  ：**只发一次请求并返回原始输出** —— 它**不**判定形状
 *                            （"provider 不做判定"是刻意的：判定只有一处）
 * 本模块（kernel）        ：超时 / 调用失败 / 输出形状坏 ⇒ **三个具名桶**，绝不重试、不回落
 * 草稿契约（contracts）   ：闭集判定（`recognizeStoryChoiceDraft`）
 * ```
 *
 * ⚠️ **不重试、不回落**：超时就是"这一轮没提成"，不是"再试一次"。
 *    与 `tool-decision.ts:381` 的立场一致（"它**不重试**、**不回落**"）。
 *
 * ⚠️ 纯逻辑：不 import 框架 / SQL / `node:*`。
 */

import {
  recognizeStoryChoiceDraft,
  type StoryChoiceDecisionPort,
} from '../../contracts/story-choice-draft.ts'

export type { StoryChoiceDecisionPort }

/** 失败桶（**闭集**；与 `tool-decision.ts` 的 `tool_decision_*` 同型） */
export const STORY_CHOICE_DECISION_FAILURE_KINDS = ['timeout', 'call_failed', 'invalid_output'] as const
export type StoryChoiceDecisionFailureKind = (typeof STORY_CHOICE_DECISION_FAILURE_KINDS)[number]

export type StoryChoiceDecisionReading =
  /** 模型给了一个**在闭集里**的机器键 */
  | { readonly kind: 'proposed'; readonly choiceId: string }
  /** 模型说"这一轮用户没有做选择"（**结论**，不是失败） */
  | { readonly kind: 'none' }
  /** 具名失败（超时 / 调用失败 / 形状坏）——**都没有提交任何东西** */
  | {
      readonly kind: StoryChoiceDecisionFailureKind
      /** `invalid_output` 时给出**闭集**里的解析码 */
      readonly code?: string
      readonly detail: string
    }

/** 把任意异常归到闭集里的桶（超时 vs 其它失败）。 */
const classifyThrow = (error: unknown): { kind: 'timeout' | 'call_failed'; detail: string } => {
  const name = (error as { name?: unknown } | null)?.name
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'timeout', detail: message }
  return { kind: 'call_failed', detail: message }
}

/**
 * 发一次、判一次形状。**永不抛**（失败也返回具名读数）。
 */
export async function readStoryChoiceDecision(
  port: StoryChoiceDecisionPort,
  input: {
    readonly userMessage: string
    readonly deadlineMs: number
    /** 本轮合法的候选机器键（闭集） */
    readonly candidates: readonly string[]
    /** **触发本轮的用户原话**（`quote` 的机械包含检查只能对它做） */
    readonly userText: string
  },
): Promise<StoryChoiceDecisionReading> {
  let raw: unknown
  try {
    raw = await port.call({ userMessage: input.userMessage, deadlineMs: input.deadlineMs })
  } catch (error) {
    const bucket = classifyThrow(error)
    return { kind: bucket.kind, detail: bucket.detail }
  }
  const parsed = recognizeStoryChoiceDraft({
    raw,
    candidates: input.candidates,
    userText: input.userText,
  })
  if (!parsed.ok) {
    return { kind: 'invalid_output', code: parsed.code, detail: parsed.detail }
  }
  return parsed.choiceId === null ? { kind: 'none' } : { kind: 'proposed', choiceId: parsed.choiceId }
}
