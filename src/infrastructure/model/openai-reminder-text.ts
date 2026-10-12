import { REMINDER_RESOLUTION_INSTRUCTION, readReminderDraft, type ReminderResolution, type ReminderResolutionInput } from '../../kernel/app/reminder-turn.ts'
export interface OpenAiReminderTextOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/** 一次有界解析；只产候选，不决定时间、收件人或写入。 */
export function createOpenAiReminderResolver(options: OpenAiReminderTextOptions = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return async (input: ReminderResolutionInput): Promise<ReminderResolution> => {
    const key = (env.OPENAI_API_KEY ?? '').trim()
    if (key === '') return { ok: false, failure: 'call_failed' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
    try {
      const response = await fetchImpl(`${(env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: env.OPENAI_SMALL_MODEL ?? 'deepseek-flash', temperature: 0, response_format: { type: 'json_object' }, messages: [
          { role: 'system', content: REMINDER_RESOLUTION_INSTRUCTION }, { role: 'user', content: JSON.stringify(input) },
        ] }),
      })
      if (!response.ok) return { ok: false, failure: 'call_failed' }
      const payload = await response.json() as { choices?: { message?: { content?: string } }[] }
      let parsed: unknown
      try { parsed = JSON.parse((payload.choices?.[0]?.message?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) }
      catch { return { ok: false, failure: 'invalid_output' } }
      const draft = readReminderDraft(parsed)
      return draft === undefined ? { ok: false, failure: 'invalid_output' } : { ok: true, draft }
    } catch (error) {
      return { ok: false, failure: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'call_failed' }
    } finally { clearTimeout(timer) }
  }
}
