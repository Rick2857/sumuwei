import { RELAY_INSTRUCTION, readRelayDraft, type RelayInput, type RelayResolution } from '../../kernel/app/relay-turn.ts'

/** Model owns intent and wording; program owns identity, storage and delivery. */
export function createOpenAiRelayResolver(options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
  const env = options.env ?? process.env
  return async (input: RelayInput): Promise<RelayResolution> => {
    const key = env.OPENAI_API_KEY?.trim()
    if (!key) return { ok: false, failure: 'relay_model_unavailable' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000)
    try {
      const response = await (options.fetchImpl ?? fetch)(`${(env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OPENAI_SMALL_MODEL ?? 'deepseek-flash', max_tokens: 4096,
          response_format: { type: 'json_object' }, messages: [
            { role: 'system', content: RELAY_INSTRUCTION }, { role: 'user', content: JSON.stringify(input) },
          ] }),
      })
      if (!response.ok) return { ok: false, failure: 'relay_model_call_failed' }
      const payload = await response.json() as { choices?: { finish_reason?: string; message?: { content?: string } }[] }
      if (payload.choices?.[0]?.finish_reason === 'length') return { ok: false, failure: 'relay_model_output_truncated' }
      const draft = readRelayDraft(JSON.parse(payload.choices?.[0]?.message?.content ?? ''))
      return draft ? { ok: true, draft } : { ok: false, failure: 'relay_model_invalid_output' }
    } catch { return { ok: false, failure: controller.signal.aborted ? 'relay_model_timeout' : 'relay_model_call_failed' } }
    finally { clearTimeout(timer) }
  }
}
