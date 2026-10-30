/** Explicit bounded P3 probes. Credentials are read from a separately mounted private file, never .env. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { startCoexistHost, EntryShell, ROOT } from '../coexist/harness.ts'
import { isolateDatabase } from '../../src/dev/sandbox.ts'
import { createHttpQqVoiceSynthesizer } from '../../src/infrastructure/qq/tts-executor.ts'
import { inspectWav, wavDeliveryProblem } from '../../src/infrastructure/qq/voice-reply.ts'

const mode = process.argv.find(arg => arg === '--tts' || arg === '--reply') ?? process.env.LG_QQ_VOICE_PROBE_MODE
assert.ok(['--tts', '--reply'].includes(mode!) && (process.argv[3] === '--run' || process.env.LG_QQ_VOICE_PROBE_RUN === '1'), 'probe_requires_explicit_mode_and_run')
assert.ok(process.env.LG_QQ_VOICE_PROBE_ENV, 'probe_private_env_missing')
const credentials = parse(readFileSync(process.env.LG_QQ_VOICE_PROBE_ENV!, 'utf8'))
const out = resolve(ROOT, 'artifacts/post-lv2/local', `qq-voice-p3-${mode!.slice(2)}-${Date.now()}`)
mkdirSync(out, { recursive: true })
const rows: Record<string, unknown>[] = []
const journal = (event: Record<string, unknown>) => appendFileSync(resolve(out, 'requests.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { flush: true, mode: 0o600 })
let requests = 0, status = 'FAIL'
try {
  if (mode === '--tts') {
    assert.ok(credentials.DASHSCOPE_API_KEY && /^[\w-]+$/.test(credentials.DASHSCOPE_WORKSPACE_ID ?? ''), 'probe_tts_credentials_missing')
    assert.equal(credentials.DASHSCOPE_REGION ?? 'cn-beijing', 'cn-beijing')
    const model = 'qwen3-tts-flash'
    const voice = 'Chelsie'
    const samples = ['我在呢。今天过得怎么样？不用着急，慢慢跟我说就好。',
      '这个提醒还没有设置成功。我会如实告诉你结果。PostgreSQL 和 QQ 的连接现在正常，答案是四十二。']
    for (const [index, text] of samples.entries()) {
      assert.ok(requests < 2); requests++; journal({ kind: 'started', request: requests, model, voice, characters: [...text].length })
      const started = Date.now()
      const synth = createHttpQqVoiceSynthesizer({
        url: `https://${credentials.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`,
        apiKey: credentials.DASHSCOPE_API_KEY!, model, voice, protocol: 'qwen-tts',
      })
      const result = await synth.synthesize({ text, deadlineMs: 30000 })
      assert.equal(wavDeliveryProblem(result.audio), undefined)
      writeFileSync(resolve(out, `${voice}-${index + 1}.wav`), result.audio, { mode: 0o600 })
      const row = { model, voice, text, elapsedMs: Date.now() - started, audio: inspectWav(result.audio),
        providerRequestId: result.providerRequestId, usage: result.usage ?? null, usageKnown: result.usage !== undefined }
      rows.push(row); journal({ kind: 'finished', request: requests, ...row })
      if (result.usage === undefined) throw new Error('probe_usage_unavailable_stop')
    }
  } else {
    assert.equal(process.env.CHARACTER_DB_BACKEND, 'postgres')
    assert.match(new URL(process.env.LG_TEST_PG_URL!).pathname, /^\/lg_test_/)
    assert.ok(credentials.OPENAI_API_KEY && credentials.OPENAI_BASE_URL && credentials.OPENAI_LARGE_MODEL, 'probe_test_model_missing')
    const sandbox = isolateDatabase('qq-voice-p3', { postgres: { url: process.env.LG_TEST_PG_URL! } })
    let stopped = false, tokens = 0
    const proxy = createServer(async (req, res) => {
      if (stopped || requests >= 16 || tokens >= 40000) { res.writeHead(503).end(); return }
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      body.model = credentials.OPENAI_LARGE_MODEL; body.max_tokens = 1024
      requests++; journal({ kind: 'started', request: requests, model: body.model,
        qqProtocolPresent: JSON.stringify(body.messages).includes('【本轮 QQ 出站媒介】') })
      try {
        const response = await fetch(`${credentials.OPENAI_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.OPENAI_API_KEY}` },
          body: JSON.stringify(body), signal: AbortSignal.timeout(45000), redirect: 'error',
        })
        if (!response.ok) throw new Error(`probe_model_http_${response.status}`)
        const data = await response.json() as { usage?: { total_tokens?: number }; choices?: { finish_reason?: string; message?: { content?: string } }[] }
        const count = data.usage?.total_tokens
        if (!Number.isSafeInteger(count) || count! < 0) { stopped = true; journal({ kind: 'usage_unknown', request: requests }) }
        else { tokens += count!; journal({ kind: 'finished', request: requests, usage: data.usage,
          finishReason: data.choices?.[0]?.finish_reason,
          mediaEnvelope: data.choices?.[0]?.message?.content?.includes('<lg-qq-media>') ?? false }) }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data))
      } catch (error) {
        stopped = true; journal({ kind: 'unconfirmed', request: requests, reason: error instanceof Error && error.message.startsWith('probe_') ? error.message : 'probe_model_failed' })
        res.writeHead(503).end()
      }
    })
    await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done))
    const host = await startCoexistHost({ dbDir: sandbox.dir, modelPort: (proxy.address() as { port: number }).port, env: {
      CHARACTER_CONTEXT_COMPILER_V1: 'true', CHARACTER_QQ_VOICE_REPLY: 'true', CHARACTER_QQ_VOICE_OUTPUT: 'true',
      CHARACTER_MEMORY_EXPLICIT_ENABLED: 'false', CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
    } })
    let shell: EntryShell | undefined
    try {
      await host.ready; shell = new EntryShell(host.qqPort, host.qqToken); await shell.ready
      for (const user of ['今天终于把事情忙完了，想和你随便聊聊。', '我现在不方便听声音，这一条请打字就好。',
        '现在方便听了，这句话我想听你亲口说，跟我说声晚安吧。', '刚才只是引用别人说的“发语音”，我现在还是想看文字。']) {
        const result = await shell.submit(`p3-${rows.length}`, user)
        rows.push({ user, outcome: result.outcome, code: result.code, media: result.media, replyText: result.replyText, traceId: result.traceId })
        assert.equal(result.outcome, 'replied')
        assert.ok(result.media && typeof result.replyText === 'string' && !result.replyText.includes('<lg-qq-media>'))
        if (stopped) throw new Error('probe_model_usage_or_response_unconfirmed')
      }
    } finally {
      shell?.close(); await host.stop().catch(() => host.kill())
      proxy.closeAllConnections(); await new Promise<void>(done => proxy.close(() => done()))
    }
  }
  status = 'PASS'
} finally {
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status, requests, rows,
    limits: mode === '--tts' ? { requests: 2, charactersPerRequest: 100, synthesisMs: 30000 } : { requests: 16, formalTurns: 4, outputTokensPerRequest: 1024, stopAfterReportedTokens: 40000 },
    qq: 'NOT_CONNECTED', production: 'UNCHANGED', hearing: 'USER_REVIEW_REQUIRED' }, null, 2))
  console.log(`QQ voice P3 ${status}: ${out}`)
}
