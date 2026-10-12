/**
 * M8.5 WP5 —— **provider 门**（`pnpm m8.5:wp5:verify`；离线：注入 fetch，零真实出站）。
 *
 * 要测的命题（计划 §15 WP5 出口：传输层 detached 可验）：
 * ① 静态：环境面 = 既有三变量（无新凭证来源）；无 console 输出；失败码只用 4 码闭集。
 * ② 出站形状（正控）：恰好一次 POST；单条 user 消息 = 完整出站文本；temperature 0；
 *    max_tokens 3,000；json_object；Authorization 头在场；usage 计数被抽出。
 * ③ 传输失败闭集（负控逐码）：429→rate_limited（Retry-After 解析 + 封顶）·
 *    5xx/4xx→server_error · fetch 层异常→network_error · 硬超时→timeout ·
 *    body 读挂住→timeout（读体与中止赛跑的证明）· 调用方取消→timeout ·
 *    无 key→不出站（requestCount 0）。
 * ④ 集成：HTTP 200 + 非 JSON body → 信封 content=null → WP4 解析归 missing_content；
 *    合法 completion → 信封 → WP4 解析 → 判定（两层接缝）。
 *
 * 量具纪律：§6.7 三段式；§6.8 measured_count > 0（四段各自非空）；
 * 本门零真实出站（fetchImpl 全部注入）、零数据库。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  AFFECT_SEMANTIC_MAX_TOKENS,
  AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS,
} from '../src/kernel/contracts/index.ts'
import {
  buildSemanticOutbound,
  parseSemanticJudgment,
} from '../src/kernel/app/affect/semantic-evaluator.ts'
import type { AffectSemanticEvaluationRequest } from '../src/kernel/contracts/index.ts'
import {
  createOpenAiAffectSemanticProvider,
  type AffectSemanticProviderCall,
  type AffectSemanticTransportOutcome,
} from '../src/infrastructure/model/affect-semantic-provider.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 量具（与前两门同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
const phaseCounts = { static: 0, positive: 0, negative: 0, recovery: 0 } as Record<string, number>

function check(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ id, label, expected, actual, pass })
  phaseCounts[phase] += 1
  if (!pass) console.error(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
}

function checkEqual(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  check(phase, id, label, JSON.stringify(expected), JSON.stringify(actual),
    JSON.stringify(expected) === JSON.stringify(actual))
}

function checkTrue(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  value: boolean,
): void {
  check(phase, id, label, 'true', String(value), value === true)
}

// ---------------------------------------------------------------------------
// 静态
// ---------------------------------------------------------------------------

const providerFile = readFileSync(
  join(REPO_ROOT, 'src/infrastructure/model/affect-semantic-provider.ts'),
  'utf8',
)
const envReads = [...providerFile.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1])
checkEqual('static', 'S1', '环境面 = 既有三变量（无新凭证来源）',
  ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_SMALL_MODEL'], [...new Set(envReads)])
checkTrue('static', 'S2', '无 console 输出（失败不带正文）', !providerFile.includes('console.'))
const failedCodes = [...providerFile.matchAll(/failed\('([a-z_]+)'/g)].map((m) => m[1])
checkTrue('static', 'S3', '失败码只用传输 4 码闭集',
  failedCodes.length > 0 && failedCodes.every((c) =>
    c === 'timeout' || c === 'rate_limited' || c === 'server_error' || c === 'network_error'))

// ---------------------------------------------------------------------------
// mock fetch 工具
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string
  init: RequestInit
}

function completionBody(overrides?: {
  content?: string | null
  finishReason?: string
  toolCalls?: unknown[]
  refusal?: string
}): string {
  const message: Record<string, unknown> = {
    content: overrides?.content ?? '{"decision":"NEUTRAL","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"ORDINARY_INTERACTION"}',
  }
  if (overrides?.toolCalls !== undefined) message.tool_calls = overrides.toolCalls
  if (overrides?.refusal !== undefined) message.refusal = overrides.refusal
  return JSON.stringify({
    choices: [{ message, finish_reason: overrides?.finishReason ?? 'stop' }],
    usage: {
      prompt_tokens: 1234,
      completion_tokens: 567,
      completion_tokens_details: { reasoning_tokens: 490 },
    },
  })
}

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const recorded: RecordedRequest[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    recorded.push({ url: String(url), init: init ?? ({} as RequestInit) })
    return new Response(body, { status, headers })
  }
  return { impl: impl as unknown as typeof fetch, recorded }
}

function hangingBodyFetch(): { impl: typeof fetch; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    recorded.push({ url: String(url), init: init ?? ({} as RequestInit) })
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      // 挂住的读体：不理会中止信号 —— 证明"读体与中止赛跑"必须存在
      json: () => new Promise<never>(() => {}),
    } as unknown as Response
  }
  return { impl: impl as unknown as typeof fetch, recorded }
}

function abortRespectingFetch(): { impl: typeof fetch; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = []
  const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      recorded.push({ url: String(url), init: init ?? ({} as RequestInit) })
      // 真实 fetch 语义：已中止的信号不再触发 abort 事件，必须先查 aborted
      if (init?.signal?.aborted === true) {
        reject(new DOMException('This operation was aborted', 'AbortError'))
        return
      }
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'))
      })
    })
  return { impl: impl as unknown as typeof fetch, recorded }
}

const ENV = { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://example.test/v1', OPENAI_SMALL_MODEL: 'test-model' }
const REQ: AffectSemanticEvaluationRequest = {
  characterAlias: '沐薇',
  currentMessage: '这回要是没有你，我真不知道怎么收场。',
  context: [],
}
const outbound = buildSemanticOutbound(REQ)
if (!outbound.ok) throw new Error('fixture outbound failed')
const CALL: AffectSemanticProviderCall = { outboundText: outbound.outbound.text }

async function callWith(impl: typeof fetch, timeoutMs?: number): Promise<AffectSemanticTransportOutcome> {
  const provider = createOpenAiAffectSemanticProvider({ fetchImpl: impl, env: ENV, timeoutMs })
  return provider.call(CALL)
}

// ---------------------------------------------------------------------------
// ② 出站形状（正控）
// ---------------------------------------------------------------------------

const ok200 = mockFetch(200, completionBody())
const okResult = await callWith(ok200.impl)
checkTrue('positive', 'P1', 'HTTP 200 → ok 信封', okResult.ok)
if (okResult.ok) {
  checkEqual('positive', 'P2', '信封：content + finishReason=stop + 无 tool_calls',
    { hasToolCalls: false, refusalPresent: false },
    { hasToolCalls: okResult.envelope.hasToolCalls, refusalPresent: okResult.envelope.refusalPresent ?? false })
  checkTrue('positive', 'P3', '信封 content 是合法 JSON 判定体',
    typeof okResult.envelope.content === 'string' && okResult.envelope.content.includes('ORDINARY_INTERACTION'))
  checkEqual('positive', 'P4', 'usage 计数抽出（prompt/completion/reasoning）',
    { promptTokens: 1234, completionTokens: 567, reasoningTokens: 490 },
    { promptTokens: okResult.shape.promptTokens, completionTokens: okResult.shape.completionTokens, reasoningTokens: okResult.shape.reasoningTokens })
  checkEqual('positive', 'P5', 'requestCount = 1（恰好一次）', 1, okResult.requestCount)
}
checkEqual('positive', 'P6', '恰好一次 POST', 1, ok200.recorded.length)
const sentUrl = ok200.recorded[0]?.url
checkTrue('positive', 'P7', 'URL = {base}/chat/completions', sentUrl === 'https://example.test/v1/chat/completions')
const sentBody = JSON.parse(String(ok200.recorded[0]?.init.body)) as Record<string, unknown>
checkEqual('positive', 'P8', '出站形状：单条 user 消息 = 完整出站文本',
  [{ role: 'user', content: outbound.outbound.text }], sentBody.messages)
checkEqual('positive', 'P9', '出站形状：model 来自 env', 'test-model', sentBody.model)
checkEqual('positive', 'P10', '出站形状：temperature 0 / max_tokens 3000 / stream false / json_object',
  { temperature: 0, max_tokens: AFFECT_SEMANTIC_MAX_TOKENS, stream: false, response_format: { type: 'json_object' } },
  { temperature: sentBody.temperature, max_tokens: sentBody.max_tokens, stream: sentBody.stream, response_format: sentBody.response_format })
const authHeader = (ok200.recorded[0]?.init.headers as Record<string, string>)?.Authorization
checkTrue('positive', 'P11', 'Authorization 头在场（不校验取值）', typeof authHeader === 'string' && authHeader.startsWith('Bearer '))

const providerMeta = createOpenAiAffectSemanticProvider({ env: ENV })
checkEqual('positive', 'P12', 'endpointHost 来自 env', 'example.test', providerMeta.endpointHost)
const providerDefaultModel = createOpenAiAffectSemanticProvider({ env: { OPENAI_API_KEY: 'k' } })
checkEqual('positive', 'P13', '缺省 host/model（无新出站目标）',
  { host: 'api.deepseek.com' }, { host: providerDefaultModel.endpointHost })

// finish_reason / tool_calls / refusal 透传（正控）
const lenResult = await callWith(mockFetch(200, completionBody({ finishReason: 'length', content: '{"decision":' })).impl)
checkTrue('positive', 'P14', 'finish_reason=length 透传信封',
  lenResult.ok && lenResult.envelope.finishReason === 'length')
const toolResult = await callWith(mockFetch(200, completionBody({ toolCalls: [{ id: 'x' }] })).impl)
checkTrue('positive', 'P15', 'tool_calls 在场 → hasToolCalls=true',
  toolResult.ok && toolResult.envelope.hasToolCalls)
const refusalResult = await callWith(mockFetch(200, completionBody({ refusal: '不' })).impl)
checkTrue('positive', 'P16', 'message.refusal 在场 → refusalPresent=true',
  refusalResult.ok && refusalResult.envelope.refusalPresent === true)
const weirdFinish = await callWith(mockFetch(200, completionBody({ finishReason: 'weird_new_reason' })).impl)
checkTrue('positive', 'P17', '未知 finish_reason 折闭集 other（不透传外部字符串）',
  weirdFinish.ok && weirdFinish.envelope.finishReason === 'other')

// ---------------------------------------------------------------------------
// ③ 传输失败闭集（负控逐码）
// ---------------------------------------------------------------------------

const r429 = await callWith(mockFetch(429, '{}', { 'Retry-After': '2' }).impl)
checkTrue('negative', 'N1', '429 → rate_limited + Retry-After 2000ms',
  !r429.ok && r429.failure === 'rate_limited' && r429.retryAfterMs === 2_000)
const r429cap = await callWith(mockFetch(429, '{}', { 'Retry-After': '120' }).impl)
checkTrue('negative', 'N2', `429 Retry-After 120s → 封顶 ${AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS}ms`,
  !r429cap.ok && r429cap.retryAfterMs === AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS)
const r500 = await callWith(mockFetch(500, 'oops').impl)
checkTrue('negative', 'N3', '5xx → server_error', !r500.ok && r500.failure === 'server_error')
const r400 = await callWith(mockFetch(400, 'bad request').impl)
checkTrue('negative', 'N4', '4xx（非 429）→ server_error（非重试友好，失败关闭）',
  !r400.ok && r400.failure === 'server_error')
const throwing = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
const rNet = await callWith(throwing)
checkTrue('negative', 'N5', 'fetch 层异常 → network_error', !rNet.ok && rNet.failure === 'network_error')
const rTimeout = await callWith(abortRespectingFetch().impl, 50)
checkTrue('negative', 'N6', '硬超时 → timeout（fetch 尊重中止）',
  !rTimeout.ok && rTimeout.failure === 'timeout')
const rBodyHang = await callWith(hangingBodyFetch().impl, 50)
checkTrue('negative', 'N7', 'body 读挂住 → timeout（读体与中止赛跑）',
  !rBodyHang.ok && rBodyHang.failure === 'timeout')
const callerAbort = new AbortController()
callerAbort.abort()
const rCaller = await createOpenAiAffectSemanticProvider({
  fetchImpl: abortRespectingFetch().impl,
  env: ENV,
}).call({ outboundText: outbound.outbound.text, signal: callerAbort.signal })
checkTrue('negative', 'N8', '调用方已取消 → timeout（取消不是独立授权结论）',
  !rCaller.ok && rCaller.failure === 'timeout')
const noKeyFetch = mockFetch(200, completionBody())
const rNoKey = await createOpenAiAffectSemanticProvider({
  fetchImpl: noKeyFetch.impl,
  env: { OPENAI_API_KEY: '' },
}).call(CALL)
checkTrue('negative', 'N9', '无 key → 不出站（requestCount 0，fetch 零调用）',
  !rNoKey.ok && rNoKey.requestCount === 0 && noKeyFetch.recorded.length === 0)

// ---------------------------------------------------------------------------
// ④ 两层接缝（负控 + 恢复）
// ---------------------------------------------------------------------------

const rBadBody = await callWith(mockFetch(200, '这不是 JSON').impl)
checkTrue('negative', 'N10', 'HTTP 200 + 非 JSON body → 信封 content=null',
  rBadBody.ok && rBadBody.envelope.content === null && rBadBody.shape.bodyWasJson === false)
if (rBadBody.ok) {
  const parsed = parseSemanticJudgment(rBadBody.envelope, REQ)
  checkTrue('negative', 'N11', '接缝：非 JSON body 经 WP4 解析归 missing_content',
    !parsed.ok && parsed.failure === 'missing_content')
}

const recover = await callWith(mockFetch(200, completionBody()).impl)
checkTrue('recovery', 'R1', '负控之后正常调用重新通过', recover.ok && recover.requestCount === 1)
if (recover.ok) {
  const parsed = parseSemanticJudgment(recover.envelope, REQ)
  checkTrue('recovery', 'R2', '接缝：合法 completion → WP4 解析出 NEUTRAL 判定',
    parsed.ok && parsed.judgment.decision === 'NEUTRAL')
}

// ---------------------------------------------------------------------------
// 汇总 + 量具自检（§6.8）
// ---------------------------------------------------------------------------

const allPhasesNonEmpty = Object.values(phaseCounts).every((n) => (n ?? 0) > 0)
const failed = checks.filter((c) => !c.pass)
const verdict = allPhasesNonEmpty && failed.length === 0 ? 'PASS' : 'FAIL'

const result = {
  verdict,
  measured_count: checks.length,
  phaseCounts,
  measuredSelfCheck: allPhasesNonEmpty ? 'OK（四段均非空）' : 'MEASUREMENT INVALID（存在空段）',
  failed: failed.map((c) => ({ id: c.id, label: c.label, expected: c.expected, actual: c.actual })),
  passedCount: checks.length - failed.length,
  checkedAt: new Date().toISOString(),
}

const runId = `wp5-verify-${result.checkedAt.replace(/[-:T.]/g, '').slice(0, 15)}`
const outDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wp5-verify.json')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

console.log(`verdict        : ${verdict}`)
console.log(`measured_count : ${checks.length} (pass ${result.passedCount} / fail ${failed.length})`)
console.log(`phases         : ${JSON.stringify(phaseCounts)}`)
console.log(`self-check     : ${result.measuredSelfCheck}`)
console.log(`evidence       : ${outPath}`)
process.exit(verdict === 'PASS' ? 0 : 1)
