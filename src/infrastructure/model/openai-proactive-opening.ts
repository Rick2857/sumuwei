/**
 * 皮套入口**主动开口**的私有模型调用适配器（Lv4.5 / ADR-131 `D04` · `D17`）。
 *
 * ============================================================================
 *  它与 `openai-proactive-care.ts` **同形**（照抄那两条实测逼出来的判据）
 * ============================================================================
 * ```text
 * ① 提示词**从契约派生**：`buildOpeningInstruction()` 在 `app/bridge/proactive-opening.ts`
 *    里现算 ⇒ 契约改了，提示词同一次改动跟着变（本文件**不**内联任何提示词文本）。
 * ② 失败要**分对桶**：
 *    没有 key / 网络 / HTTP 非 2xx  ⇒ `call_failed`
 *    超时                          ⇒ `timeout`
 *    拿到东西但不是正文             ⇒ `invalid_output`
 *    ⚠️ 把"没有正文"报成 `call_failed` 会说"这次调用失败了"，而它其实**成功了**。
 * ```
 *
 * ============================================================================
 *  与 care 那一档的**两处刻意差异**
 * ============================================================================
 * ```text
 * ① 期限：**不是** care 的 15000ms，而是 `policy.openingDeadlineMs`（8000ms）。
 *    理由（ADR-131 `D17`）：主动开口发生在**用户在线**时，他能直接感到卡；
 *    而 8000ms 有实测支撑 —— 与 ADR-104 的 role-tool 决策调用同一档
 *    （24 次 min 974 / avg 1725 / p90 2400 / **max 3941ms**，越 8000ms 期限 **0 次**）。
 * ② 期限**由调用方按策略传入**（`invoke({ timeoutMs })`），不在这里读环境 ——
 *    策略值要**随策略版本落库**，不能散成适配器常量。
 * ```
 *
 * ⚠️ 它**不**重试、**不**降级重问、**不**决定用哪个分支（判据全在编排层一处）。
 * ⚠️ 凭证**只**从 `env.OPENAI_API_KEY` 取，**不回落**任何其它来源。
 */

import type { OpeningModelPort, OpeningModelResult } from '../../kernel/app/bridge/proactive-opening.ts'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
/** 兜底期限；正常路径由调用方按 `policy.openingDeadlineMs` 传入 */
const DEFAULT_TIMEOUT_MS = 8_000

export const OPENAI_PROACTIVE_OPENING_ID = 'openai-compatible-proactive-opening@1'

export interface OpenAiProactiveOpeningOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  /** 兜底值；`invoke` 的 `timeoutMs` 优先 */
  readonly timeoutMs?: number
}

export function createOpenAiProactiveOpeningPort(
  options: OpenAiProactiveOpeningOptions = {}
): OpeningModelPort {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_MODEL

  return {
    id: OPENAI_PROACTIVE_OPENING_ID,
    endpointHost: (() => {
      try {
        return new URL(baseURL).host
      } catch {
        return baseURL
      }
    })(),

    async invoke(input: {
      readonly instruction: string
      readonly briefing: string
      readonly timeoutMs: number
    }): Promise<OpeningModelResult> {
      /* ⚠️ 没有凭证 ⇒ `call_failed`（**不是**"她决定不说话"）—— 两种读数必须分开 */
      if (apiKey === '') return { ok: false, failure: 'call_failed' }
      const timeoutMs = Math.max(1, input.timeoutMs > 0 ? input.timeoutMs : options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
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
            messages: [
              { role: 'system', content: input.instruction },
              { role: 'user', content: input.briefing },
            ],
          }),
          signal: controller.signal,
        })
        if (!response.ok) return { ok: false, failure: 'call_failed' }
        const payload = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const content = payload.choices?.[0]?.message?.content
        /* ⚠️ 拿不到正文 ⇒ `invalid_output`（**不是** `call_failed`） */
        if (typeof content !== 'string' || content.trim() === '') {
          return { ok: false, failure: 'invalid_output' }
        }
        return { ok: true, raw: content }
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        return { ok: false, failure: aborted ? 'timeout' : 'call_failed' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
