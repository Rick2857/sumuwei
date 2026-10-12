/**
 * 自主关心的**私有模型调用**适配器（post-Lv2 / ADR-110 `D03`/`D04`）。
 *
 * ============================================================================
 *  它与 `openai-tool-decision.ts` 同形（照抄那两条实测逼出来的判据）
 * ============================================================================
 * ```text
 * ① 提示词**从契约派生**：`buildProactiveInstruction()` / `renderProactiveBriefing()`
 *    都在 `contracts/proactive-proposal.ts` 里现算 ⇒ 契约改了，提示词同一次改动跟着变。
 * ② 失败要**分对桶**：
 *    没有 key / 网络 / HTTP 非 2xx  ⇒ `call_failed`（这一轮**没有**决策可用）
 *    超时                          ⇒ `timeout`
 *    模型给了东西但不是 JSON        ⇒ 把**原文**交回内核（内核判 `invalid_output`）
 *    ⚠️ 把"不是 JSON"报成 `call_failed` 会说"这次调用失败了"，而它其实**成功了**。
 * ```
 *
 * ============================================================================
 *  ⚠️ 它**不是**一次对话（`D04` 的三条禁令在这里落地）
 * ============================================================================
 * ```text
 * · 系统提示是**程序渲染的指令**，用户消息是**程序渲染的简报**（不是"最近几轮对话"）
 * · 这一条链**不写** `user_message`、**不写** `assistant_message`（那是轮次的事）
 * · 它**不**产生任何记忆事件
 * · 它**不**重试、**不**降级重问、**不**决定用哪个分支 —— 判据全在内核那一处
 * ```
 * ⚠️ 凭证**只**从 `env.OPENAI_API_KEY` 取，**不回落**任何其它来源。
 */
import type {
  CareEvaluationPort,
  CareEvaluationResult,
} from '../../kernel/app/proactive-care.ts'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
/** 与其它私有调用同一档；`readProactivePolicy().evaluationTimeoutMs` 是**策略**那一侧的读数 */
const DEFAULT_TIMEOUT_MS = 15_000

export const OPENAI_PROACTIVE_CARE_ID = 'openai-compatible-proactive-care@1'

export interface OpenAiProactiveCareOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export function createOpenAiProactiveCarePort(
  options: OpenAiProactiveCareOptions = {}
): CareEvaluationPort & { readonly id: string; readonly endpointHost: string } {
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const apiKey = (env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((env.OPENAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = (env.OPENAI_SMALL_MODEL ?? '').trim() || DEFAULT_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: OPENAI_PROACTIVE_CARE_ID,
    endpointHost: (() => {
      try {
        return new URL(baseURL).host
      } catch {
        return baseURL
      }
    })(),

    async evaluate(input: {
      instruction: string
      briefing: string
    }): Promise<CareEvaluationResult> {
      /* ⚠️ 没有凭证 ⇒ `call_failed`（**不是**"她决定不说话"）—— 两种读数必须分开 */
      if (apiKey === '') return { ok: false, failure: 'call_failed' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
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
        /*
         * ⚠️ 拿不到正文 ⇒ `invalid_output`（**不是** `call_failed`）：
         *    "调用成功了、但它没给可以解析的东西"与"调用没成功"是两件事。
         */
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
