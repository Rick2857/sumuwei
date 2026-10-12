/**
 * 剧情选择解析的 **OpenAI 兼容适配器**（`ADR-107` `R-1b`）。
 *
 * ============================================================================
 *  它与 `openai-tool-decision.ts` / `openai-agreement-understanding.ts` 同形
 * ============================================================================
 * ```text
 * 有界 userMessage → **恰好一次** POST {base}/chat/completions
 *   → choices[0].message.content → 解析成 JSON 对象
 *   → 把**原始对象**交给内核（严格校验在 `kernel/contracts/story-choice-draft.ts`）
 * ```
 * 它**不**做：结构校验、闭集判定、提交、重试、降级重问、替用户选。
 * **一次调用就是一次调用。**
 *
 * ============================================================================
 *  两条设计判据（照抄工具决策那两条）
 * ============================================================================
 * ```text
 * ① 提示词**从契约派生**：形状与 schemaVersion 从 `story-choice-draft.ts` 现算
 *    （手写会漂移）。候选与正文由内核的 `choice-input.ts` 有界组装后传进来。
 * ② 失败要分对桶：网络 / HTTP / 没有 key ⇒ **抛**（内核映射成 `call_failed` / `timeout`）；
 *    模型给了东西但不是 JSON ⇒ **返回原文**（内核判 `invalid_output`）。
 *    把"不是 JSON"抛成 transport 会说"这次调用失败了"，而它其实**成功了**。
 * ```
 *
 * ⚠️ 凭证**只**从 `env.OPENAI_API_KEY` 取，**不回落**任何其它来源。
 * ⚠️ 这里发的提示词里**没有**人设正文、记忆、检索结果 —— 只有本轮原话、有界的最近对话行、
 *    有界的剧情正文与**程序算出**的候选机器键（`ADR-107` §2.5(3)：它**不进主 prompt**）。
 * ⚠️ 它是**私有**调用：本文件不写账本、不写 trace 正文、不碰 prompt 组装。
 */

import type { StoryChoiceDecisionPort } from '../../kernel/contracts/story-choice-draft.ts'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
export const STORY_CHOICE_DEFAULT_TIMEOUT_MS = 8_000

export const OPENAI_STORY_CHOICE_ID = 'openai-compatible-story-choice@1'

export interface OpenAiStoryChoiceOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * 造一个真模型端口。
 *
 * ⚠️ **没有 key 时抛错**（不是返回 `null`）—— "没有凭证"与"用户这一轮没做选择"
 *    在读数上必须不一样：前者是 `call_failed`，后者是"一个结论"。
 */
export function createOpenAiStoryChoicePort(
  options: OpenAiStoryChoiceOptions = {},
): StoryChoiceDecisionPort {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_MODEL
  const configuredTimeout = options.timeoutMs ?? STORY_CHOICE_DEFAULT_TIMEOUT_MS

  return {
    id: OPENAI_STORY_CHOICE_ID,
    endpointHost: (() => {
      try {
        return new URL(baseURL).host
      } catch {
        return baseURL
      }
    })(),

    async call(input: { userMessage: string; deadlineMs: number }): Promise<unknown> {
      if (apiKey === '') {
        throw new Error('OPENAI_API_KEY 未配置：私有决策调用**没有**凭证（这不是"用户没做选择"）')
      }
      const deadlineMs = Math.max(1, Math.min(configuredTimeout, input.deadlineMs))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deadlineMs)
      try {
        const response = await doFetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: input.userMessage }],
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          /* HTTP 层失败 ⇒ **抛**（内核记 `call_failed`，零写入） */
          throw new Error(`私有决策调用 HTTP ${String(response.status)}`)
        }
        const payload = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const content = payload.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          throw new Error('私有决策调用的响应里没有 choices[0].message.content')
        }
        /*
         * ⚠️ **解析失败 ⇒ 把原文交回内核**（不在这里下结论）：
         *    "模型给了东西但不是 JSON"属于 `invalid_output`，与传输失败是两件事。
         *    严格校验只有内核那一处。
         */
        const stripped = content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
        try {
          return JSON.parse(stripped) as unknown
        } catch {
          return content
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
