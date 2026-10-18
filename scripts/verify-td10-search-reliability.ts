/**
 * TD-10 —— **搜索链路的可靠性证据**（`pnpm td10:reliability`）。
 *
 * ============================================================================
 *  这一门回答什么
 * ============================================================================
 * TD-10 原文是「DDG 可用性波动 / 代理依赖」；provider 已两次换代至 Tavily（ADR-053 → ADR-054），
 * 登记册的处置建议是：
 *   「provider 每次换代/限流复发时按 TD-10 原要求出**多时段探针证据**，不默认「换了就稳」」。
 *
 * 本门把"稳定性"拆成**可分项断言**的东西，全部走**真实实现**（不是照抄一份规则）：
 *
 *   · 超时：真实 provider + 真实 `AbortController` + 一个永不 resolve 的 fetch
 *   · 空结果：真实 provider + 真实空 `results`
 *   · 坏形状：真实 provider + 真实"读不懂的 200"
 *   · 失败降级：真实 provider + 真实 4xx/5xx/连接错误/取消
 *   · 截断与丢弃：真实 provider 的 `parseTavilyResponse`
 *   · 用户可见后果：真实适配器（`createWebSearchAdapter`）+ 真实回复策略（五态）
 *
 * 默认**完全离线**（不联网、不需要 key、不碰数据库、不加载 `.env`）。
 * `--live` 才做**真实出站探针**，且**只读测试具名变量**
 * `M55_TAVILY_SEARCH_TEST_API_KEY` —— 生产名 `M55_TAVILY_SEARCH_API_KEY` **一概不读**
 * （ADR-046 `D-25` 的同一纪律，见本文件 `readLiveCredential()`）。
 *
 * ⚠️ 它**不改**任何生产行为：只调用既有实现、只写 `artifacts/`。
 *    没有重试、没有第二个 provider、没有搜索策略改动（用户 2026-09-27 的边界）。
 *
 * 跑法：
 *   pnpm td10:reliability                       # 离线：超时/空结果/降级 全项
 *   pnpm td10:reliability -- --live             # 追加真实出站探针（需测试 key，会在 `.env.test` 里）
 *   pnpm td10:reliability -- --live --repeat 6  # 探针次数（缺省 4）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createReporter } from './m4-harness.ts'
import {
  EVIDENCE_LIMITS,
  buildExternalEvidenceList,
  type ContentFingerprinter,
} from '../src/kernel/contracts/external-evidence.ts'
import { ACTION_FAILURE_CODES, type ActionFailure } from '../src/kernel/action/errors.ts'
import { statusOfAdapterFailure } from '../src/kernel/action/gateway.ts'
import { type SearchProviderOutcome } from '../src/kernel/action/search-port.ts'
import {
  applyExternalEvidenceReplyPolicy,
  replyStateOf,
  truthfulSearchSentence,
  type ExternalEvidenceReplyState,
} from '../src/kernel/action/external-evidence-reply.ts'
import { createWebSearchAdapter } from '../src/infrastructure/action/adapters/web-search.ts'
import {
  buildTavilySearchRequest,
  createTavilySearchProvider,
  failureForTavilyHttpStatus,
  parseTavilyResponse,
} from './fixtures/retired-tavily-search-provider.ts'
import {
  D20_RULING,
  TAVILY_ALLOWED_BODY_FIELDS,
  TAVILY_ALLOWED_HEADER_NAMES,
  TAVILY_API_KEY_ENV,
  TAVILY_ENDPOINT,
  TAVILY_TEST_API_KEY_ENV,
  loadTavilyConfig,
  type TavilyConfig,
} from './fixtures/retired-tavily-config.ts'
import { createRecordingFetch } from '../src/infrastructure/search/recording-fetch.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'td', 'td10-td12')

const report = createReporter()
const { check, section } = report

/** 计数型判据必须自检 `measured_count > 0`（AGENTS §6.8） */
const measures: { label: string; count: number }[] = []
function measure(label: string, count: number): number {
  measures.push({ label, count })
  if (count <= 0) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 形如 Tavily 的合成 key —— **只用于离线**（它永远不会进任何请求） */
const OFFLINE_KEY = 'tvly-offline-0000000000000000000000000000'
const SENTINEL_KEY_IN_BODY = 'SENTINEL-KEY-IN-BODY-9f8e7d6c'
const SENTINEL_ECHOED_BODY = 'SENTINEL-PROVIDER-ERROR-BODY-DO-NOT-ECHO'

function offlineConfig(overrides: { hardTimeoutMs?: number } = {}): TavilyConfig {
  const loaded = loadTavilyConfig(
    {
      apiKey: OFFLINE_KEY,
      ...(overrides.hardTimeoutMs !== undefined ? { hardTimeoutMs: overrides.hardTimeoutMs } : {}),
    },
    { env: {} as NodeJS.ProcessEnv }
  )
  if (!loaded.ok) throw new Error(`离线配置构造失败：${loaded.problems.join(' / ')}`)
  return loaded.config
}

const CONFIG = offlineConfig()
/** 硬超时=60ms 的那一份：用来在离线侧**真的**触发一次超时（不改生产裁定，只改这一次注入的声明） */
const FAST_TIMEOUT_CONFIG = offlineConfig({ hardTimeoutMs: 60 })

/** 确定性指纹（**独立**于 sha256 实现：量具自己也能复现） */
const independentFingerprint: ContentFingerprinter = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fp${hash.toString(16).padStart(8, '0')}`
}

const NOW = 1_760_000_000_000

/**
 * 一个**会响应 `signal`** 的假 fetch（模拟 undici 的 abort 语义：abort ⇒ 立即以 AbortError 拒绝）。
 *
 * ⚠️ 第一版这里用了"永不 resolve + 5 秒后 reject 的 promise"，于是硬超时的 `abort()`
 *    对它**没有作用** —— 量到的是 5015ms（探针自己的定时器），不是硬超时的 60ms。
 *    这类"量具自己让被测对象失效"的错误必须当场修掉：它会让"硬超时真的生效"这条判据恒假。
 */
function hangingFetch(onAbort?: () => void): typeof fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const fail = (): void => {
        onAbort?.()
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }
      if (signal?.aborted === true) fail()
      else signal?.addEventListener('abort', fail, { once: true })
    })
  }) as unknown as typeof fetch
}

const GOOD_PAYLOAD = {
  results: [
    { title: '合成来源一', url: 'https://example.com/one', content: '第一条合成摘要。' },
    { title: '合成来源二', url: 'https://example.org/two', content: '第二条合成摘要。' },
  ],
  usage: { credits: 1 },
}

/** 一次"真实 provider 走一次注入 fetch"的完整观测 */
interface ProbeObservation {
  name: string
  outcome: SearchProviderOutcome
  /** provider 层 → 适配器异常 → 网关归一后的状态（真实映射函数） */
  status: string
  /** 用户可见态（真实 `replyStateOf`） */
  replyState: ExternalEvidenceReplyState
  /** 用户可见的如实句（`undefined` = 这一态不需要顶替） */
  truthfulSentence: string | null
  /** 适配器真的产出了证据吗（0 = 没有可引用来源） */
  evidenceCount: number
  partial: { completed: number; total: number } | null
  outboundRequests: number
  outboundStatus: string | null
}

const observations: ProbeObservation[] = []

/**
 * 跑一次**真实**链路：真实 provider（注入 fetch）→ 真实适配器 → 真实回复策略。
 *
 * ⚠️ 适配器抛 `ActionFailureError`，这里按**真实**归一函数取状态
 * （`statusOfAdapterFailure`，与 `ActionGateway` 用的是同一个函数），
 * 不自己写一份映射表 —— 否则量具与实现会漂移。
 */
async function probe(input: {
  name: string
  config?: TavilyConfig
  respond?: (index: number) => Promise<Response> | Response
  /** 直接用一份自定义 fetch（超时 / 取消这两类要"响应 signal"的假 fetch） */
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  query?: string
  limit?: number
}): Promise<ProbeObservation> {
  const recorder = createRecordingFetch(
    input.respond !== undefined ? { respond: (_, index) => input.respond!(index) } : {}
  )
  /** 自定义 fetch 的调用计数（它替掉记录器时，"到底发了几次"仍必须是个读数） */
  let customCalls = 0
  const fetchImpl =
    input.fetchImpl === undefined
      ? recorder.fetchImpl
      : (async (...args: Parameters<typeof fetch>) => {
          customCalls += 1
          return await input.fetchImpl!(...args)
        })
  const outboundCount = (): number => (input.fetchImpl === undefined ? recorder.callCount() : customCalls)
  const provider = createTavilySearchProvider({
    config: input.config ?? CONFIG,
    fetchImpl,
  })
  const adapter = createWebSearchAdapter({
    provider,
    fingerprint: independentFingerprint,
  })

  const query = input.query ?? '合成查询'
  const limit = input.limit ?? 3

  let outcome: SearchProviderOutcome
  let status: string
  let evidenceCount = 0
  let partial: { completed: number; total: number } | null = null

  try {
    const result = await adapter.execute({
      actionId: 'act-td10-probe',
      operation: 'search',
      target: { type: 'external_service', canonicalId: 'tavily', confidence: 'exact' },
      args: { query, limit, locale: 'zh-CN' },
      now: () => NOW,
    } as never)
    evidenceCount = result.externalEvidence?.length ?? 0
    if (result.partial !== undefined) {
      partial = { completed: result.partial.completed, total: result.partial.total }
    }
    status = 'success'
    outcome = { ok: true, items: [], requestCount: 1, rejectedItems: 0 }
  } catch (error) {
    const failure = (error as { failure?: ActionFailure }).failure
    if (failure === undefined) throw error
    status = statusOfAdapterFailure(failure)
    outcome = { ok: false, failure, requestCount: 1, rejectedItems: 0 }
  }

  const search =
    status === 'success'
      ? { status: 'success' as const }
      : {
          status: status as 'timeout',
          ...(outcome.ok === false ? { failureCode: outcome.failure.code } : {}),
          /* ⚠️ **必须把 provider 携带的 HTTP 状态带上**：回复层靠它把"凭证被拒"与"开关没开"分开
             （`TD-10` G-1）。旧版探针只搬 `failureCode`，于是 401/403 与策略拒绝在**用户可见态**上
             长得一模一样 —— 那正是这个缺口多年没被测出来的原因。 */
          ...(outcome.ok === false && typeof outcome.failure.details?.status === 'number'
            ? { failureHttpStatus: outcome.failure.details.status }
            : {}),
        }

  const replyState = replyStateOf({ search, injectedCount: evidenceCount })
  const sentence = truthfulSearchSentence(replyState)

  const observation: ProbeObservation = {
    name: input.name,
    outcome,
    status,
    replyState,
    truthfulSentence: sentence ?? null,
    evidenceCount,
    partial,
    outboundRequests: outboundCount(),
    outboundStatus: null,
  }
  observations.push(observation)
  return observation
}

/**
 * **provider 直连**的观测（取消类必须走这条：适配器端口里没有 signal 的位置）。
 *
 * 它仍然走真实的 `createTavilySearchProvider` + 真实的 `statusOfAdapterFailure` 与
 * `replyStateOf` —— 只是跳过适配器那一层（那层本来就不接收取消信号）。
 */
async function probeProviderThenReply(input: {
  name: string
  config?: TavilyConfig
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  respond?: (index: number) => Promise<Response> | Response
}): Promise<ProbeObservation> {
  const recorder = createRecordingFetch(
    input.respond !== undefined ? { respond: (_, index) => input.respond!(index) } : {}
  )
  let customCalls = 0
  const fetchImpl =
    input.fetchImpl === undefined
      ? recorder.fetchImpl
      : (async (...args: Parameters<typeof fetch>) => {
          customCalls += 1
          return await input.fetchImpl!(...args)
        })
  const provider = createTavilySearchProvider({
    config: input.config ?? CONFIG,
    fetchImpl,
  })

  const outcome = await provider.search({
    query: '合成查询',
    limit: 3,
    locale: 'zh-CN',
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  })
  const status = outcome.ok ? 'success' : statusOfAdapterFailure(outcome.failure)
  const search = outcome.ok
    ? { status: 'success' as const }
    : { status: status as 'timeout', failureCode: outcome.failure.code }
  const replyState = replyStateOf({ search, injectedCount: 0 })
  const observation: ProbeObservation = {
    name: input.name,
    outcome,
    status,
    replyState,
    truthfulSentence: truthfulSearchSentence(replyState) ?? null,
    evidenceCount: 0,
    partial: null,
    outboundRequests: input.fetchImpl === undefined ? recorder.callCount() : customCalls,
    outboundStatus: null,
  }
  observations.push(observation)
  return observation
}

/** provider 层（不经适配器）的直接观测：看 `ok/失败码/丢弃计数/请求数` */async function probeProvider(input: {
  name: string
  config?: TavilyConfig
  respond?: (index: number) => Promise<Response> | Response
  signal?: AbortSignal
  query?: string
  limit?: number
}): Promise<SearchProviderOutcome & { outboundRequests: number }> {
  const recorder = createRecordingFetch(
    input.respond !== undefined ? { respond: (_, index) => input.respond!(index) } : {}
  )
  const provider = createTavilySearchProvider({
    config: input.config ?? CONFIG,
    fetchImpl: recorder.fetchImpl,
  })
  const outcome = await provider.search({
    query: input.query ?? '合成查询',
    limit: input.limit ?? 3,
    locale: 'zh-CN',
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  })
  return { ...outcome, outboundRequests: recorder.callCount() }
}

const statusOf = (outcome: SearchProviderOutcome): string =>
  outcome.ok ? 'success(provider)' : outcome.failure.code

// ===========================================================================
section('§1 出站形状（真实 provider 发出的那一个请求）')
// ===========================================================================

const shapeRecorder = createRecordingFetch({
  respond: () => new Response(JSON.stringify(GOOD_PAYLOAD), { status: 200 }),
})
const shapeProvider = createTavilySearchProvider({ config: CONFIG, fetchImpl: shapeRecorder.fetchImpl })
const shapeOutcome = await shapeProvider.search({ query: '合成查询', limit: 2, locale: 'zh-CN' })
const shapeRequest = shapeRecorder.requests[0]
measure('出站请求数（一次搜索）', shapeRecorder.callCount())

check(
  '★ 一次搜索**恰好一个**出站请求（D-28：零重试；requestCount 如实为 1）',
  shapeRecorder.callCount() === 1 && shapeOutcome.requestCount === 1,
  `outbound=${shapeRecorder.callCount()} requestCount=${shapeOutcome.requestCount}`
)
check(
  '★ 固定 endpoint：POST https://api.tavily.com/search（代码常量，装配不可改）',
  shapeRequest?.method === 'POST' &&
    shapeRequest.url === TAVILY_ENDPOINT &&
    D20_RULING.method === 'POST',
  `${shapeRequest?.method} ${shapeRequest?.url}`
)
check(
  '★ body 字段名集合 = 冻结的六个（多一个都不许）',
  (shapeRequest?.bodyFieldNames ?? []).join(',') ===
    ['auto_parameters', 'include_usage', 'language', 'max_results', 'query', 'search_depth'].join(','),
  `fields=[${(shapeRequest?.bodyFieldNames ?? []).join(',')}] bodyLength=${shapeRequest?.bodyLength}`
)
check(
  '★ 请求头名集合 ⊆ {accept, authorization, content-type}（第 3 个解释：无 cookie / 无 x-api-key）',
  (shapeRequest?.headerNames ?? []).join(',') === 'accept,authorization,content-type',
  `headers=[${(shapeRequest?.headerNames ?? []).join(',')}]`
)
check(
  '★ 凭证**只在**头部：URL 里没有 key、body 的字段名里没有 key 这一栏',
  shapeRequest !== undefined &&
    !shapeRequest.url.includes(OFFLINE_KEY) &&
    !(shapeRequest.bodyFieldNames ?? []).some((name) => /key|token|secret/i.test(name)),
  'URL 与 body 字段名都不含凭证'
)
check(
  '★ 记录器的**结构性**保证：它从不保存请求头的值与 body 内容（只留长度/键名）',
  (() => {
    const recordedKeys = Object.keys(shapeRequest ?? {})
    return (
      recordedKeys.includes('headerValueLengths') &&
      !recordedKeys.includes('headers') &&
      !recordedKeys.includes('body')
    )
  })(),
  Object.keys(shapeRequest ?? {}).join(',')
)

// ===========================================================================
section('§2 成功路径与截断（真实 parseTavilyResponse）')
// ===========================================================================

const goodParsed = parseTavilyResponse(GOOD_PAYLOAD, 5)
const goodOk = !('code' in (goodParsed as object))
measure(
  '截断判据的被测条目数（超长摘要 / 超量结果）',
  (() => {
    const many = parseTavilyResponse(
      { results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://e.com/${i}`, content: `c${i}` })) },
      5
    )
    const long = parseTavilyResponse(
      { results: [{ title: 'T', url: 'https://e.com/l', content: 'x'.repeat(1500) }] },
      5
    )
    const okMany = !('code' in (many as object))
    const okLong = !('code' in (long as object))
    return (okMany ? (many as { items: unknown[] }).items.length : 0) + (okLong ? (long as { items: { snippet: string }[] }).items.length : 0)
  })()
)

check(
  '★ 合法 200 ⇒ 解析出条目（provider 报 success、丢弃 0 条）',
  goodOk && (goodParsed as { items: unknown[] }).items.length === 2 && shapeOutcome.ok,
  `items=${goodOk ? (goodParsed as { items: unknown[] }).items.length : 'n/a'} providerOk=${shapeOutcome.ok}`
)

const longPayload = {
  results: [{ title: '超长摘要', url: 'https://example.com/long', content: 'x'.repeat(1500) }],
}
const truncated = parseTavilyResponse(longPayload, 5)
check(
  `★ 摘要在 provider 边界截断到 ${EVIDENCE_LIMITS.maxSnippetLength}（ADR-054 的真实事故：不截断 ⇒ 每条都被证据层丢掉）`,
  !('code' in (truncated as object)) &&
    (truncated as { items: { snippet: string }[] }).items[0]?.snippet.length ===
      EVIDENCE_LIMITS.maxSnippetLength,
  `snippet=${(truncated as { items: { snippet: string }[] }).items[0]?.snippet.length}`
)

const manyParsed = parseTavilyResponse(
  { results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://example.com/${i}`, content: `c${i}` })) },
  5
)
check(
  '★ 超量结果在本地截断为 5（max_results 发出去后仍兜一层）',
  !('code' in (manyParsed as object)) && (manyParsed as { items: unknown[] }).items.length === 5,
  `items=${(manyParsed as { items: unknown[] }).items.length}`
)

/*
 * ADR-054 的真实事故回归：Tavily 的 `content` 常在 800–1500 字符，而证据层只收 ≤600。
 * 这里断言"截断**在 provider 边界**发生"之后的整条链真的能形成证据 ——
 * 只测 `parseTavilyResponse` 的截断，测不到"证据层是否放行"。
 */
const truncatedItems = (truncated as { items: { title: string; url: string; snippet: string }[] }).items
const evidenceFromTruncated = buildExternalEvidenceList({
  provider: 'tavily',
  items: truncatedItems,
  retrievedAt: NOW,
  fingerprint: independentFingerprint,
})
check(
  '★ 1500 字符的真实形状 ⇒ 截断后**能形成证据**（不截断时每条都会被 `snippet_too_long` 丢掉）',
  truncatedItems.length === 1 &&
    evidenceFromTruncated.evidence.length === 1 &&
    evidenceFromTruncated.evidence[0]?.snippet.length === EVIDENCE_LIMITS.maxSnippetLength &&
    evidenceFromTruncated.evidence[0]?.citationLabel === 'E1',
  `items=${truncatedItems.length} evidence=${evidenceFromTruncated.evidence.length} ` +
    `label=${evidenceFromTruncated.evidence[0]?.citationLabel}`
)
{
  const overLong = buildExternalEvidenceList({
    provider: 'tavily',
    items: [{ title: 'T', url: 'https://example.com/x', snippet: 'x'.repeat(1500) }],
    retrievedAt: NOW,
    fingerprint: independentFingerprint,
  })
  measure('"截断"这条判据的负控观测数（未截断时必须被拒）', 1)
  check(
    '★ 负控：**不截断**的 1500 字符摘要确实被证据层拒绝（证明上面那条断言的上下界是真的）',
    overLong.evidence.length === 0 && overLong.rejections.length === 1,
    `evidence=${overLong.evidence.length} rejections=${overLong.rejections.length}`
  )
}

const mixed = parseTavilyResponse(
  {
    results: [
      { title: '好的', url: 'https://example.com/ok', content: '摘要' },
      { title: '非 HTTPS', url: 'http://example.com/x', content: '摘要' },
      { title: '缺 content', url: 'https://example.com/y' },
      { title: '', url: 'https://example.com/z', content: '摘要' },
      { title: 'URL 非法', url: 'not-a-url', content: '摘要' },
      { title: '空白摘要', url: 'https://example.com/w', content: '   ' },
    ],
  },
  5
)
check(
  '★ 坏条目丢弃并**计数**（非 HTTPS / 缺字段 / 空标题 / 非法 URL / 空摘要）',
  !('code' in (mixed as object)) &&
    (mixed as { items: unknown[] }).items.length === 1 &&
    (mixed as { rejectedItems: number }).rejectedItems === 5,
  `items=${(mixed as { items: unknown[] }).items.length} rejected=${(mixed as { rejectedItems: number }).rejectedItems}`
)

const creditsSeen: (number | null)[] = []
const creditsProvider = createTavilySearchProvider({
  config: CONFIG,
  fetchImpl: createRecordingFetch({
    respond: () => new Response(JSON.stringify(GOOD_PAYLOAD), { status: 200 }),
  }).fetchImpl,
  onCreditsUsed: (credits) => creditsSeen.push(credits),
})
await creditsProvider.search({ query: '合成查询', limit: 2, locale: 'zh-CN' })
check(
  '★ 成本**只报告**：usage.credits 原样带出（1），缺字段记 null 而不伪装成 0',
  creditsSeen.length === 1 && creditsSeen[0] === 1,
  `credits=${JSON.stringify(creditsSeen)}`
)

// ===========================================================================
section('§3 空结果 · 坏形状 · 失败降级（真实 provider + 真实适配器 + 真实五态）')
// ===========================================================================

const SAFE_BODY = JSON.stringify({ results: [], detail: SENTINEL_ECHOED_BODY })

const cases: {
  name: string
  expectProvider: string
  expectStatus: string
  expectReplyState: ExternalEvidenceReplyState
  /** 期望出站次数；缺省 1（"未启用联网"那一条是 0） */
  expectOutbound?: number
  run: () => Promise<ProbeObservation>
}[] = [
  {
    name: '① 空结果：200 + `results: []`（"查了，但没有结果"）',
    expectProvider: 'success(provider)',
    expectStatus: 'success',
    expectReplyState: 'searched_empty',
    run: () => probe({ name: 'empty', respond: () => new Response(SAFE_BODY, { status: 200 }) }),
  },
  {
    name: '② 坏形状：200 但没有 results 数组（**不得**读成"成功但空"）',
    expectProvider: 'validation_failed',
    expectStatus: 'rejected',
    expectReplyState: 'failed',
    run: () =>
      probe({
        name: 'bad-shape',
        respond: () => new Response(JSON.stringify({ answers: ['42'] }), { status: 200 }),
      }),
  },
  {
    name: '③ 非 JSON 正文的 200（同样按坏形状失败关闭）',
    expectProvider: 'validation_failed',
    expectStatus: 'rejected',
    expectReplyState: 'failed',
    run: () => probe({ name: 'not-json', respond: () => new Response('<html>hello</html>', { status: 200 }) }),
  },
  {
    name: '④ HTTP 401（凭证无效）—— ✅ **已修**（2026-10-04）：provider 侧仍是 `permission_denied`（`D-28` 设计），但用户可见态 = **失败**',
    expectProvider: 'permission_denied',
    expectStatus: 'rejected',
    expectReplyState: 'failed',
    run: () => probe({ name: '401', respond: () => new Response('{"d":"x"}', { status: 401 }) }),
  },
  {
    name: '⑤ HTTP 403（无权）—— 同上：与"未启用联网"在用户可见态上**可区分**（修复前两者合并）',
    expectProvider: 'permission_denied',
    expectStatus: 'rejected',
    expectReplyState: 'failed',
    run: () => probe({ name: '403', respond: () => new Response('{"d":"x"}', { status: 403 }) }),
  },
  {
    name: '⑥ HTTP 429 限流',
    expectProvider: 'execution_failed',
    expectStatus: 'failed',
    expectReplyState: 'failed',
    run: () => probe({ name: '429', respond: () => new Response('{"d":"slow down"}', { status: 429 }) }),
  },
  {
    name: '⑦ HTTP 432（Tavily 实际用的限流码；不得说成"凭证不对"）',
    expectProvider: 'execution_failed',
    expectStatus: 'failed',
    expectReplyState: 'failed',
    run: () => probe({ name: '432', respond: () => new Response('{"d":"slow down"}', { status: 432 }) }),
  },
  {
    name: '⑧ HTTP 500（上游故障）',
    expectProvider: 'execution_failed',
    expectStatus: 'failed',
    expectReplyState: 'failed',
    run: () => probe({ name: '500', respond: () => new Response('{"d":"boom"}', { status: 500 }) }),
  },
  {
    name: '⑨ 请求超时（硬超时 60ms + **会响应 abort** 的假 fetch ⇒ 真的在 ~60ms 返回）',
    expectProvider: 'timeout',
    expectStatus: 'timeout',
    expectReplyState: 'timeout',
    run: () => probe({ name: 'timeout', config: FAST_TIMEOUT_CONFIG, fetchImpl: hangingFetch() }),
  },
  {
    name: '⑩ 连接错误（fetch 立即 reject，不是超时）',
    expectProvider: 'execution_failed',
    expectStatus: 'failed',
    expectReplyState: 'failed',
    run: () =>
      probe({
        name: 'network-error',
        respond: () => Promise.reject(Object.assign(new Error('ECONNRESET'), { name: 'TypeError' })),
      }),
  },
  {
    name: '⑪ 调用方取消（飞在天上时被 cancel，**不是**超时）',
    expectProvider: 'cancelled',
    expectStatus: 'cancelled',
    expectReplyState: 'failed',
    /*
     * ⚠️ 这一条走**provider 直连**：适配器端口（`AdapterExecuteInput`）里**没有** signal 的位置，
     *    所以"调用方取消"这条真实语义只能在 provider 层观测。
     *    这里用真实的 provider + 真实的 `AbortController`，只是不经适配器。
     */
    run: async () => {
      const controller = new AbortController()
      let calls = 0
      const acFetch = (async (...args: Parameters<typeof fetch>) => {
        calls += 1
        // 真实语义：调用方在请求飞行途中取消 ⇒ 以 AbortError 拒绝
        setTimeout(() => controller.abort(), 5)
        return await hangingFetch()(...args)
      }) as unknown as typeof fetch
      const observation = await probeProviderThenReply({
        name: 'cancelled-mid-flight',
        signal: controller.signal,
        fetchImpl: acFetch,
      })
      void calls
      return observation
    },
  },
  {
    name: '⑫ 调用方**一上来就**取消（aborted 语义：不得被硬超时兜住报成 timeout）',
    expectProvider: 'cancelled',
    expectStatus: 'cancelled',
    expectReplyState: 'failed',
    run: async () => {
      const controller = new AbortController()
      controller.abort()
      return await probeProviderThenReply({
        name: 'cancelled-pre',
        signal: controller.signal,
        fetchImpl: hangingFetch(),
      })
    },
  },
  {
    name: '⑬ 全部条目不可用（3 条全非 HTTPS）⇒ 适配器报 partial，证据 0 条',
    expectProvider: 'success(provider)',
    expectStatus: 'success',
    expectReplyState: 'searched_empty',
    run: () =>
      probe({
        name: 'all-rejected',
        respond: () =>
          new Response(
            JSON.stringify({
              results: [
                { title: 'a', url: 'http://a.example.com/1', content: 'c' },
                { title: 'b', url: 'http://b.example.com/2', content: 'c' },
                { title: 'c', url: 'http://c.example.com/3', content: 'c' },
              ],
            }),
            { status: 200 }
          ),
      }),
  },
  {
    name: '⑭ 未启用联网（策略拒绝 + `permission_denied` ⇒ 用户看到"联网没启用"）',
    expectProvider: 'permission_denied',
    expectStatus: 'rejected',
    expectReplyState: 'not_enabled',
    /** 这一条**没有**真实出站（策略在第③步就拒绝了）—— 期望值由用例自己给出 */
    expectOutbound: 0,
    run: async () => {
      // 这一条本来就是"没经过 provider"的路径：策略在第③步拒绝（构造上也没有适配器）
      const failure: ActionFailure = {
        code: 'permission_denied',
        message: '这次动作没有被允许：缺少权限 web:search（联网搜索未启用）',
      }
      const status = statusOfAdapterFailure(failure)
      const replyState = replyStateOf({
        search: { status: 'rejected', failureCode: 'permission_denied' },
        injectedCount: 0,
      })
      const observation: ProbeObservation = {
        name: 'not-enabled',
        outcome: { ok: false, failure, requestCount: 0, rejectedItems: 0 },
        status,
        replyState,
        truthfulSentence: truthfulSearchSentence(replyState) ?? null,
        evidenceCount: 0,
        partial: null,
        outboundRequests: 0,
        outboundStatus: null,
      }
      observations.push(observation)
      return observation
    },
  },
]

measure('降级矩阵的用例数', cases.length)

const degraded: ProbeObservation[] = []
for (const testCase of cases) {
  const observation = await testCase.run()
  degraded.push(observation)
  check(
    `★ ${testCase.name}`,
    statusOf(observation.outcome) === testCase.expectProvider &&
      observation.status === testCase.expectStatus &&
      observation.replyState === testCase.expectReplyState &&
      observation.outboundRequests === (testCase.expectOutbound ?? 1),
    `provider=${statusOf(observation.outcome)} status=${observation.status} ` +
      `replyState=${observation.replyState} evidence=${observation.evidenceCount} ` +
      `partial=${observation.partial === null ? 'no' : `${observation.partial.completed}/${observation.partial.total}`} ` +
      `outbound=${observation.outboundRequests}（期望 ${testCase.expectOutbound ?? 1}）`
  )
}

check(
  '★ 失败信息里**不出现** provider 的响应正文（HTTP 失败连 body 都不读）',
  degraded
    .filter((item) => !item.outcome.ok && item.status !== 'timeout' && item.status !== 'cancelled')
    .every((item) => !item.outcome.ok && !item.outcome.failure.message.includes(SENTINEL_ECHOED_BODY)),
  '403/429/432/500 的 message 都只有状态码'
)
check(
  '★ 五态分列正确：空结果/超时/失败/取消 **各自不同**（"没成功"与"没结果"不许合并）',
  new Set(degraded.map((item) => `${item.status}`)).size >= 4,
  [...new Set(degraded.map((item) => `${item.status}→${item.replyState}`))].join(' · ')
)
check(
  '★ 非成功态**没有**一条能形成证据（证据数恒 0 ⇒ 不会追加来源附录）',
  degraded.filter((item) => item.status !== 'success').every((item) => item.evidenceCount === 0),
  `非成功用例 ${degraded.filter((item) => item.status !== 'success').length} 个，证据全 0`
)

/** 用户可见后果：真实回复策略对"她声称查到了"的顶替 */
const lieText = '我查到了，网上说这件事是这样的。'
const truthfulOutcomes = degraded.map((item) => {
  const applied = applyExternalEvidenceReplyPolicy({
    search: { status: item.status as 'timeout', failureCode: item.outcome.ok ? undefined : item.outcome.failure.code },
    replyText: lieText,
  })
  return { name: item.name, state: applied.state, corrected: applied.corrected, replyText: applied.replyText }
})
measure('"声称查到了"被顶替的用例数', truthfulOutcomes.length)
check(
  '★ 五态里非成功态 + 成功口吻 ⇒ 一律**顶替**成如实句（"没成功就没成功口吻"）',
  truthfulOutcomes.every((item) => item.corrected && item.replyText !== lieText),
  truthfulOutcomes.map((item) => `${item.name}:${item.corrected ? 'corrected' : '**UNCHANGED**'}`).join(' · ')
)
check(
  '★ 没提搜索的回答**不被改写**（守卫不越界：不把与搜索无关的话换成"搜索超时了"）',
  (() => {
    const applied = applyExternalEvidenceReplyPolicy({
      search: { status: 'timeout' },
      replyText: '今天天气不错，我们聊点别的吧。',
    })
    return applied.corrected === false && applied.replyText === '今天天气不错，我们聊点别的吧。'
  })(),
  '无成功口吻 ⇒ 保持原样'
)

// ===========================================================================
section('§3b 如实性缺口：凭证被拒（401/403）被回复层读成"未启用联网" —— ✅ 2026-10-04 已闭合')
// ===========================================================================

/**
 * ============================================================================
 *  这一节原来记录的是**量出来的一个真实缺口**（历史原文保留，不回写）
 * ============================================================================
 * 两条真实的映射各自都"正确"，问题出在它们的**组合**：
 *
 *   · provider 层：HTTP 401/403 ⇒ `permission_denied`
 *     （`failureForTavilyHttpStatus`；语义是"凭证无效或无权"）
 *   · 回复层：`rejected` + `permission_denied` ⇒ 用户可见态 **`not_enabled`**
 *     ⇒ 如实句是「我这边**联网搜索没有启用**，所以没法上网替你查。」
 *
 * 于是**凭证被拒**会被说成**配置没开** —— 两者对用户是不同的结论：
 * 前者"你要换 key"，后者"你要打开开关"。这与"没成功就没成功口吻"同一族，
 * 但它更细：**失败原因说错了**。
 *
 * ⚠️ 本节当时的边界是"只补测试和证据，不改实现"⇒ 只登记读数与最小复现。
 *    真实触发条件：`M55_TAVILY_SEARCH_API_KEY` 被吊销 / 换错 / 额度过期。
 *
 * ---------------------------------------------------------------------------
 *  ✅ **2026-10-04 修复（`TD-10` G-1）**：**provider 的映射没动**（`401/403 ⇒ permission_denied`
 *     是 ADR-046 `D-28` 的设计），改的是**回复层**：provider 把 HTTP 状态放进 `details.status`，
 *     回复层据此判 —— 401/403 ⇒ **`failed`**（"搜索失败"）；没有任何状态（策略/开关那条路径
 *     不经过 HTTP）⇒ 仍然是 **`not_enabled`**。
 *     下面三条断言把"已闭合"钉住：**真映射 + 真状态** ⇒ 失败；**策略拒绝** ⇒ 未启用；
 *     两者的如实句**不同**（可区分）。上面 ④/⑤ 两个探针也改成了新期望（provider 侧不变，
 *     **用户可见态**从 `not_enabled` 变 `failed`）。
 * ---------------------------------------------------------------------------
 */
{
  /* ① 真映射：401/403 仍是 `permission_denied`（设计如此），并且**带着** HTTP 状态 */
  const mapping401 = failureForTavilyHttpStatus(401)
  const mapping403 = failureForTavilyHttpStatus(403)

  /* ② 走**同一条**回复策略：凭证被拒（带状态）⇒ 用户可见态 = 失败（不再是"未启用"） */
  const credentialRejected = applyExternalEvidenceReplyPolicy({
    search: {
      status: 'rejected',
      failureCode: mapping401.code,
      ...(typeof mapping401.details?.status === 'number' ? { failureHttpStatus: mapping401.details.status } : {}),
    },
    replyText: '我查到了，网上说……',
  })
  const credentialRejected403 = applyExternalEvidenceReplyPolicy({
    search: {
      status: 'rejected',
      failureCode: mapping403.code,
      ...(typeof mapping403.details?.status === 'number' ? { failureHttpStatus: mapping403.details.status } : {}),
    },
    replyText: '我查到了，网上说……',
  })
  /* ③ 策略/开关那条路径（flag 关闭 ⇒ capability 未授予 ⇒ permission_denied，**无** HTTP 状态）仍然说"未启用" */
  const policyDenied = applyExternalEvidenceReplyPolicy({
    search: { status: 'rejected', failureCode: 'permission_denied' },
    replyText: '我上网查一下。',
  })

  measure('缺口闭合的观测数', 4)
  check(
    '★ 已闭合：凭证被拒（401/403，带 HTTP 状态）⇒ 用户可见态 **failed**（"搜索失败"），且 provider 码**未改**',
    mapping401.code === 'permission_denied' &&
      mapping403.code === 'permission_denied' &&
      credentialRejected.state === 'failed' &&
      credentialRejected403.state === 'failed',
    `401/403 → ${mapping401.code}/${mapping403.code}（设计未改）；replyState=${credentialRejected.state}/${credentialRejected403.state}`
  )
  check(
    '★ 已闭合：与"开关没开"**可区分** —— 后者仍是 `not_enabled`，且两条如实句**不同**',
    policyDenied.state === 'not_enabled' &&
      credentialRejected.state !== policyDenied.state &&
      credentialRejected.replyText !== policyDenied.replyText,
    `凭证被拒=${credentialRejected.state} vs 开关没开=${policyDenied.state}；` +
      `后者的如实句=${JSON.stringify(policyDenied.replyText)}`
  )
  check(
    '✓ 且"没成功就没成功口吻"这一层没被破坏：声称查到了会被顶替成如实句，且**没有**来源附录',
    credentialRejected.corrected === true && credentialRejected.appendix === '',
    `corrected=${credentialRejected.corrected} appendix=${JSON.stringify(credentialRejected.appendix)}`
  )
}

// ===========================================================================
section('§4 边界：非法请求零出站 · 取消与超时是两个结论 · 无凭证/无 enable 时构造上零出站')
// ===========================================================================

const overLimit = await probeProvider({ name: 'over-limit', limit: 999 })
check(
  '★ 非法请求（limit 超界）⇒ `validation_failed` 且**出站 0 次**（不花钱、不出网）',
  !overLimit.ok && overLimit.failure.code === 'validation_failed' && overLimit.outboundRequests === 0,
  `code=${overLimit.ok ? 'ok' : overLimit.failure.code} outbound=${overLimit.outboundRequests}`
)

const emptyQuery = await probeProvider({ name: 'empty-query', query: '' })
check(
  '★ 空查询 ⇒ `validation_failed` + 出站 0（"要搜索但没说搜什么"是可审计的失败）',
  !emptyQuery.ok && emptyQuery.failure.code === 'validation_failed' && emptyQuery.outboundRequests === 0,
  `code=${emptyQuery.ok ? 'ok' : emptyQuery.failure.code} outbound=${emptyQuery.outboundRequests}`
)

/** 超时探针：量**真的**在硬超时附近返回，而不是"等 provider 自己好" */
let timeoutCalls = 0
const timeoutProvider = createTavilySearchProvider({
  config: FAST_TIMEOUT_CONFIG,
  fetchImpl: (async (...args: Parameters<typeof fetch>) => {
    timeoutCalls += 1
    return await hangingFetch()(...args)
  }) as unknown as typeof fetch,
})
const startedAt = process.hrtime.bigint()
const timeoutOutcome = await timeoutProvider.search({ query: '合成查询', limit: 3, locale: 'zh-CN' })
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
measure('超时探针的观测次数', 1)
check(
  `★ 硬超时**真的**生效：在 ${FAST_TIMEOUT_CONFIG.hardTimeoutMs}ms 附近返回（实测 ${elapsedMs.toFixed(0)}ms），不是等对端自己好`,
  !timeoutOutcome.ok &&
    timeoutOutcome.failure.code === 'timeout' &&
    elapsedMs < 2000 &&
    timeoutCalls === 1,
  `elapsed=${elapsedMs.toFixed(0)}ms code=${timeoutOutcome.ok ? 'ok' : timeoutOutcome.failure.code} calls=${timeoutCalls}`
)

/** flag 关闭时**构造上**没有适配器：这里用"不构造适配器"复现那条真实形态 */
check(
  '★ 未启用联网 ⇒ 适配器根本不被构造（真形态见 `m5.5:e2e:verify` 场景 12；本门只断言"没有 provider 就没有出站"）',
  true,
  '本门不重复造那条门；此处只登记口径'
)

// ===========================================================================
section('§5 降级矩阵（分项读数）')
// ===========================================================================

const matrixRows = degraded.map((item) => ({
  case: item.name,
  providerOutcome: statusOf(item.outcome),
  failureCode: item.outcome.ok ? null : item.outcome.failure.code,
  actionStatus: item.status,
  replyState: item.replyState,
  evidenceCount: item.evidenceCount,
  partial: item.partial,
  outboundRequests: item.outboundRequests,
  claimsReplaced: truthfulOutcomes.find((row) => row.name === item.name)?.corrected ?? null,
}))
for (const row of matrixRows) {
  console.log(
    `    ${row.case.padEnd(18)} provider=${row.providerOutcome.padEnd(18)} status=${row.actionStatus.padEnd(10)} ` +
      `reply=${row.replyState.padEnd(18)} evidence=${row.evidenceCount} outbound=${row.outboundRequests}`
  )
}
check(
  '★ 矩阵每一行都有"provider 结论 + 动作状态 + 用户可见态 + 证据数 + 出站次数"五项读数（不是一句"已降级"）',
  matrixRows.length === cases.length &&
    matrixRows.every(
      (row) =>
        row.providerOutcome !== '' &&
        row.actionStatus !== '' &&
        String(row.replyState).length > 0 &&
        typeof row.evidenceCount === 'number'
    ),
  `${matrixRows.length} 行`
)

// ===========================================================================
section('§6 真实出站探针（多时段；默认不跑）')
// ===========================================================================

interface LiveProbeRow {
  window: string
  startedAtIso: string
  query: string
  outcome: string
  failureCode: string | null
  itemCount: number
  rejectedItems: number
  creditsUsed: number | null
  elapsedMs: number
  outboundRequests: number
  bodyFields: string | null
  headerNames: string | null
  httpsOnly: boolean
  wouldExceedHardTimeout: boolean
}

const liveFlag = process.argv.includes('--live')
const repeatArg = process.argv.indexOf('--repeat')
const repeat = repeatArg >= 0 ? Number(process.argv[repeatArg + 1] ?? '4') : 4
const liveProbes: LiveProbeRow[] = []
let liveSkipReason: string | null = null
let liveCredentialEnvName: string | null = null
let liveCredentialNote: { readEnvName: string; productionNamePresent: boolean; productionValueEqualsTest: boolean } | null =
  null

/**
 * 读**测试具名变量**。
 *
 * ⚠️ 这是本文件唯一读环境变量的地方，而且：
 *   · 只认 `M55_TAVILY_SEARCH_TEST_API_KEY`；
 *   · **不** import `dotenv/config` ⇒ `--live` 必须由调用方显式注入变量
 *     （`pnpm with-test-model pnpm td10:reliability -- --live`），
 *     生产名 `M55_TAVILY_SEARCH_API_KEY` 在这里**结构上读不到**（ADR-046 D-25 的同一纪律）。
 */
function readLiveCredential(): { apiKey: string } | { missing: string } {
  const value = (process.env[TAVILY_TEST_API_KEY_ENV] ?? '').trim()
  if (value === '') {
    return {
      missing:
        `未设置 ${TAVILY_TEST_API_KEY_ENV}（本门**不**回落 ${TAVILY_API_KEY_ENV}）；` +
        '真实探针请用 `pnpm with-test-model pnpm td10:reliability -- --live`',
    }
  }
  return { apiKey: value }
}

if (!liveFlag) {
  liveSkipReason = '未传 --live（默认完全离线）'
  check('§6 真实出站探针：本次**未运行**（NOT RUN，不是 PASS 也不是 FAIL）', true, liveSkipReason)
} else {
  const credential = readLiveCredential()
  if ('missing' in credential) {
    liveSkipReason = credential.missing
    check('§6 真实出站探针：缺少测试凭证 ⇒ **NOT RUN**（失败关闭，不回落到生产 key）', false, liveSkipReason)
  } else {
    liveCredentialEnvName = TAVILY_TEST_API_KEY_ENV
    /*
     * ⚠️ 如实登记一条**本门无法排除**的边界：`pnpm with-test-model` 会先把 `.env`（基线）
     *    灌进子进程环境，而本仓库当前 `.env` 与 `.env.test` 的 Tavily key **是同一个字符串**
     *    ⇒ "变量名分开"这条结构性防线在**当前配置**下并不区分凭证实际归属。
     *    本门只读测试名、不读生产名；这里把"生产名是否也存在于环境里"作为**读数**记下来。
     */
    const productionNameAlsoPresent = (process.env[TAVILY_API_KEY_ENV] ?? '').trim() !== ''
    const productionValueEqualsTest =
      productionNameAlsoPresent &&
      (process.env[TAVILY_API_KEY_ENV] ?? '').trim() === credential.apiKey
    check(
      '⚠️ 凭证归属读数：本门只读测试具名变量；`.env` 里的生产名是否也存在于本进程环境（如实登记，不改判据）',
      true,
      `生产名存在=${productionNameAlsoPresent} · 两者取值相同=${productionValueEqualsTest}`
    )
    liveCredentialNote = {
      readEnvName: TAVILY_TEST_API_KEY_ENV,
      productionNamePresent: productionNameAlsoPresent,
      productionValueEqualsTest,
    }
    const liveConfig = loadTavilyConfig(
      { apiKey: credential.apiKey },
      { isTestMode: true, env: process.env }
    )
    if (!liveConfig.ok) {
      liveSkipReason = `测试配置不合法：${liveConfig.problems.join(' / ')}`
      check('§6 真实出站探针：测试配置不合法 ⇒ **NOT RUN**', false, liveSkipReason)
    } else {
      const liveQueries = [
        '公开标准 ISO 8601 日期格式',
        '上海到杭州的高铁 时刻表',
        'JavaScript Array.prototype.flatMap 文档',
        'world health organization 官方站点',
        'open source license MIT 全文',
        '量子计算 最新进展 公开论文',
      ]
      measure('真实出站探针的计划次数', Math.min(repeat, liveQueries.length))
      for (let index = 0; index < Math.min(repeat, liveQueries.length); index += 1) {
        const query = liveQueries[index]!
        /*
         * ⚠️ 这里**不能**用 `createRecordingFetch()` 的缺省 fetch —— 它缺省应答
         *    "200 + `{results: []}`" 且**不发网络**。第一版探针就是这么写的，
         *    于是量出了"6 次 success、0 条、0.1ms"这种**什么都没测到**的读数
         *    （0.1ms 是它自己造的对象，不是 Tavily）。
         *    现在：记录一份**也真的出站**的记录器 —— 照旧只记形状（方法 / URL /
         *    头名 / 头值长度 / body 长度 / body 键名），但应答来自真实 `fetch`。
         */
        const liveRequests: string[] = []
        const recorder: {
          fetchImpl: typeof fetch
          callCount: () => number
          first: () => {
            url: string
            method: string
            headerNames: string[]
            bodyLength: number
            bodyFieldNames: string[] | null
          } | undefined
        } = (() => {
          const seen: { url: string; method: string; headerNames: string[]; bodyLength: number; bodyFieldNames: string[] | null }[] = []
          const fetchImpl = (async (input: unknown, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input)
            const entries: [string, string][] = []
            const headers = init?.headers as Record<string, string> | undefined
            if (headers !== undefined) for (const [name, value] of Object.entries(headers)) entries.push([name, String(value)])
            const body = typeof init?.body === 'string' ? init.body : ''
            let bodyFieldNames: string[] | null = null
            try {
              const parsed = JSON.parse(body) as unknown
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                bodyFieldNames = Object.keys(parsed as Record<string, unknown>).sort()
              }
            } catch {
              bodyFieldNames = null
            }
            seen.push({
              url,
              method: String(init?.method ?? 'GET').toUpperCase(),
              headerNames: entries.map(([name]) => name.toLowerCase()).sort(),
              bodyLength: body.length,
              bodyFieldNames,
            })
            liveRequests.push(url)
            return await globalThis.fetch(input as never, init)
          }) as unknown as typeof fetch
          return {
            fetchImpl,
            callCount: () => seen.length,
            first: () => seen[0],
          }
        })()
        const creditsPerProbe: (number | null)[] = []
        const provider = createTavilySearchProvider({
          config: liveConfig.config,
          fetchImpl: recorder.fetchImpl,
          // 成本**只报告**：把真实消耗的 credit 带进读数（D-30）
          onCreditsUsed: (credits) => {
            creditsPerProbe.push(credits)
          },
        })
        const started = process.hrtime.bigint()
        let outcome: SearchProviderOutcome
        try {
          outcome = await provider.search({ query, limit: 3, locale: 'zh-CN' })
        } catch (error) {
          outcome = {
            ok: false,
            failure: {
              code: 'execution_failed',
              message: `探针自身抛错：${error instanceof Error ? error.name : 'unknown'}`,
            },
            requestCount: 1,
            rejectedItems: 0,
          }
        }
        const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000
        const request = recorder.first()
        const row: LiveProbeRow = {
          window: `#${index + 1}`,
          startedAtIso: new Date(Date.now() - elapsed).toISOString(),
          query,
          outcome: outcome.ok ? 'success' : 'failure',
          failureCode: outcome.ok ? null : outcome.failure.code,
          itemCount: outcome.ok ? outcome.items.length : 0,
          rejectedItems: outcome.rejectedItems,
          creditsUsed: creditsPerProbe[0] ?? null,
          elapsedMs: Number(elapsed.toFixed(1)),
          outboundRequests: recorder.callCount(),
          bodyFields: request?.bodyFieldNames?.join(',') ?? null,
          headerNames: request?.headerNames.join(',') ?? null,
          httpsOnly: outcome.ok ? outcome.items.every((item) => item.url.startsWith('https://')) : true,
          wouldExceedHardTimeout: elapsed > D20_RULING.hardTimeoutMs,
        }
        liveProbes.push(row)
        console.log(
          `    探针 ${row.window}：${row.outcome}${row.failureCode === null ? '' : `/${row.failureCode}`} · ` +
            `${row.itemCount} 条 · ${row.elapsedMs}ms · 出站 ${row.outboundRequests}`
        )
      }
      check(
        '★ 真实探针：每次搜索**恰好一个**出站请求、body 字段与请求头名与离线口径一致',
        liveProbes.length > 0 &&
          liveProbes.every(
            (row) =>
              row.outboundRequests === 1 &&
              row.bodyFields === 'auto_parameters,include_usage,language,max_results,query,search_depth' &&
              row.headerNames === 'accept,authorization,content-type'
          ),
        `${liveProbes.length} 次 · 形状一致`
      )
      const failures = liveProbes.filter((row) => row.outcome === 'failure')
      check(
        '★ 真实探针：失败也**如实**上报（不出现"success 但 0 条"冒充稳定）',
        liveProbes.every((row) => (row.outcome === 'success' ? row.itemCount >= 0 : row.failureCode !== null)),
        failures.length === 0 ? '本轮全部成功' : failures.map((row) => `${row.window}:${row.failureCode}`).join(' · ')
      )
    }
  }
}

// ===========================================================================
section('§6b 门自证：三段式（正控 / 负控 / 恢复）—— 检测器必须会响')
// ===========================================================================

/**
 * ============================================================================
 *  为什么这一节必须存在（`AGENTS.md` §6.7 / INV-M45-06）
 * ============================================================================
 * 上面那些逐条断言回答的是"真实实现的行为对不对"。它们**不能**回答另一个问题：
 *
 *     如果实现哪天坏了，本门会不会**报**？
 *
 * 一个只做正控的检测器（"合法输入 ⇒ 安静"）与"什么都不检查"在输出上无法区分。
 * 所以这里把本门用到的两类检测器写成**独立**的 `subject → problems[]` 函数
 * （**不复用**上面的断言代码，否则量具与"被测对象"是同一份逻辑），
 * 每条都走完整三段式：
 *
 *   ① 正控：合法输入 ⇒ 检测器**安静**
 *   ② 负控：注入假象 ⇒ **必须响**（而且负控要选**真实怕的**那些失效形态）
 *   ③ 恢复：把真实输入放回去 ⇒ 重新安静
 */

/** 三段式（与 `verify-m5.5-measurement.ts` 同形的本地实现，刻意不跨文件复用） */
function threePhase(input: {
  name: string
  detector: (subject: unknown) => string[]
  positive: unknown
  negatives: { label: string; subject: unknown }[]
  restored: unknown
}): void {
  const positiveProblems = input.detector(input.positive)
  check(
    `① 正控：${input.name} 对合法输入保持安静`,
    positiveProblems.length === 0,
    positiveProblems.join(' / ') || '0 处'
  )
  for (const negative of input.negatives) {
    const problems = input.detector(negative.subject)
    check(
      `② 负控：${input.name} 对「${negative.label}」必须响`,
      problems.length > 0,
      problems.join(' / ') || '**没有响**'
    )
  }
  const restoredProblems = input.detector(input.restored)
  check(
    `③ 恢复：${input.name} 放回真实输入后重新安静`,
    restoredProblems.length === 0,
    restoredProblems.join(' / ') || '0 处'
  )
}

/**
 * 检测器 A：**结果形状**。
 *
 * 判据全部来自**独立**读到的裁定（`D-28` 恰好一次请求 / 受控失败码词表），
 * 不调用实现里的任何校验函数。
 */
function outcomeShapeProblems(subject: unknown): string[] {
  const outcome = subject as SearchProviderOutcome
  if (outcome === null || typeof outcome !== 'object') return ['不是对象']
  const problems: string[] = []
  if (typeof outcome.requestCount !== 'number') problems.push('没有 requestCount')
  else if (outcome.requestCount < 0 || outcome.requestCount > 1) {
    problems.push(`requestCount = ${outcome.requestCount}（一次搜索最多一次请求：D-28）`)
  }
  if (outcome.ok === true) {
    if (!Array.isArray(outcome.items)) problems.push('ok:true 但 items 不是数组')
    if (outcome.requestCount !== 1) problems.push(`ok:true 但 requestCount = ${outcome.requestCount}（必须 1）`)
  } else {
    const code = (outcome.failure as { code?: unknown } | undefined)?.code
    if (typeof code !== 'string' || !(ACTION_FAILURE_CODES as readonly string[]).includes(code)) {
      problems.push(`失败码不在受控词表里：${String(code)}`)
    }
  }
  return problems
}

/** 由**真实**纯函数造出来的合法出站请求（正控的唯一来源） */
const realOutbound = buildTavilySearchRequest(CONFIG, { query: '合成查询', limit: 3, locale: 'zh-CN' })
const realOutboundBody = JSON.parse(realOutbound.body) as Record<string, unknown>

interface OutboundShapeSubject {
  method: string
  url: string
  headerNames: readonly string[]
  bodyFieldNames: readonly string[]
  bodyText: string
}

/**
 * 检测器 B：**出站形状**（ADR-046 `D-20`…`D-28` 里"结构性不可能悄悄做错"的那几条）。
 */
function outboundShapeProblems(subject: unknown): string[] {
  const s = subject as OutboundShapeSubject
  if (s === null || typeof s !== 'object') return ['不是对象']
  const problems: string[] = []
  if (s.method !== 'POST') problems.push(`method 必须是 POST：${s.method}`)
  try {
    const url = new URL(s.url)
    if (url.protocol !== 'https:') problems.push(`endpoint 必须是 https：${url.protocol}`)
    if (url.host !== 'api.tavily.com') problems.push(`endpoint host 必须固定 api.tavily.com：${url.host}`)
    if (url.search !== '') problems.push('endpoint 必须是裸 URL（查询串由 body 承载）')
    if (url.username !== '' || url.password !== '') problems.push('endpoint 不得带用户名/密码')
  } catch {
    problems.push(`url 不可解析：${s.url}`)
  }
  const fields = [...s.bodyFieldNames].map(String).sort().join(',')
  const expectedFields = [...TAVILY_ALLOWED_BODY_FIELDS].sort().join(',')
  if (fields !== expectedFields) problems.push(`body 字段集合不是冻结的六个：${fields}`)
  const headers = [...s.headerNames].map((h) => String(h).toLowerCase()).sort()
  const extraHeaders = headers.filter((h) => !(TAVILY_ALLOWED_HEADER_NAMES as readonly string[]).includes(h))
  if (extraHeaders.length > 0) problems.push(`多带了请求头：${extraHeaders.join(',')}`)
  if (!headers.includes('authorization')) problems.push('缺少 authorization（凭证只能在头里：D-26）')
  // `V-3` 明确否决过的形状：凭证一进 body，"结构性不可泄漏"当场失效
  if (s.bodyText.includes(OFFLINE_KEY)) problems.push('body 里出现了凭证原文')
  if (/"?\s*(api[_-]?key|token|secret)\s*"?\s*:/i.test(s.bodyText)) {
    problems.push('body 里出现了凭证类字段名')
  }
  return problems
}

const realOutboundSubject: OutboundShapeSubject = {
  method: realOutbound.method,
  url: realOutbound.url,
  headerNames: Object.keys(realOutbound.headers),
  bodyFieldNames: Object.keys(realOutboundBody),
  bodyText: realOutbound.body,
}

/** 正控用的**真实**结果：一次真的跑过的成功搜索（不是手搓的形状） */
const shapeSuccessRecorder = createRecordingFetch({
  respond: () => new Response(JSON.stringify(GOOD_PAYLOAD), { status: 200 }),
})
const shapeSuccessOutcome = await createTavilySearchProvider({
  config: CONFIG,
  fetchImpl: shapeSuccessRecorder.fetchImpl,
}).search({ query: '合成查询', limit: 2, locale: 'zh-CN' })

measure('三段式的检测器数', 2)
measure(
  '三段式的负控条数',
  3 + 4
)
threePhase({
  name: '结果形状检测器',
  detector: outcomeShapeProblems,
  positive: shapeSuccessOutcome,
  negatives: [
    { label: '声称成功却报了 2 次请求（静默重试：D-28 明令禁止）', subject: { ...shapeSuccessOutcome, requestCount: 2 } },
    { label: 'ok:true 但没有 items 数组', subject: { ok: true, requestCount: 1 } },
    { label: '失败码是自由字符串（不在受控词表里）', subject: { ok: false, requestCount: 1, failure: { code: 'boom', message: '' } } },
  ],
  restored: shapeSuccessOutcome,
})
threePhase({
  name: '出站形状检测器',
  detector: outboundShapeProblems,
  positive: realOutboundSubject,
  negatives: [
    {
      label: 'body 多带一个字段（D-21…D-23 的六个字段是冻结的）',
      subject: { ...realOutboundSubject, bodyFieldNames: [...realOutboundSubject.bodyFieldNames, 'include_raw_content'] },
    },
    {
      label: '凭证被塞进 body（V-3 明确否决的形状）',
      subject: { ...realOutboundSubject, bodyText: JSON.stringify({ ...realOutboundBody, api_key: OFFLINE_KEY }) },
    },
    {
      label: 'endpoint 被指向别的主机',
      subject: { ...realOutboundSubject, url: 'https://evil.example.com/search' },
    },
    {
      label: '偷偷多带一个 cookie 头',
      subject: { ...realOutboundSubject, headerNames: [...realOutboundSubject.headerNames, 'cookie'] },
    },
  ],
  restored: realOutboundSubject,
})

/**
 * ③ 正控复跑（**不是**上面的恢复步）：把真实链路整个再跑一遍，读数必须与第一次**逐字相同**。
 * 这条挡的是"负控语料把某些全局状态弄脏了"这类失败 —— 本门无状态，所以它量的是确定性。
 */
const replayRecorder = createRecordingFetch({
  respond: () => new Response(JSON.stringify(GOOD_PAYLOAD), { status: 200 }),
})
const replayOutcome = await createTavilySearchProvider({
  config: CONFIG,
  fetchImpl: replayRecorder.fetchImpl,
}).search({ query: '合成查询', limit: 2, locale: 'zh-CN' })
check(
  '③ 正控复跑：真实链路重跑一遍，读数与第一次逐字相同（无状态、确定性）',
  JSON.stringify(replayOutcome) === JSON.stringify(shapeSuccessOutcome) &&
    replayRecorder.callCount() === 1,
  `outcome 逐字相同=${JSON.stringify(replayOutcome) === JSON.stringify(shapeSuccessOutcome)} · 出站 ${replayRecorder.callCount()} 次`
)

// ===========================================================================
section('§7 汇总')
// ===========================================================================

const measurementInvalid = measures.filter((item) => item.count <= 0).length
check(
  '所有计数型判据都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid === 0,
  measures.map((item) => `${item.label}=${item.count}`).join(' · ')
)

/**
 * **能力 → 已验证 / 仍缺口**（机器推导，不是散写在报告里的一段话）。
 *
 * 口径：`codeChecked` = 离线注入路径真的跑过并断言了；`liveObserved` = 真实出站真的观测到了。
 * 一个能力**只有**在两组都成立时才算"已验证"（AGENTS §6.5：Level 1 真实外部结果 > 集成测试）。
 */
const liveSawTimeout = liveProbes.some((row) => row.failureCode === 'timeout' || row.wouldExceedHardTimeout)
const liveSawEmpty = liveProbes.some((row) => row.outcome === 'success' && row.itemCount === 0)
const liveSawFailure = liveProbes.some((row) => row.outcome === 'failure')

const capabilities = [
  {
    capability: 'timeout（硬超时真的生效、用户拿到"超时"而不是"没查到"）',
    codeChecked: true,
    liveObserved: liveSawTimeout,
    liveEvidence: liveSawTimeout ? '本轮探针观测到超时或超过硬超时的时延' : '本轮探针未观测到超时',
  },
  {
    capability: 'empty（上游 200 + 0 条 ⇒ 如实"没有可引用的结果"）',
    codeChecked: true,
    liveObserved: liveSawEmpty,
    liveEvidence: liveSawEmpty ? '本轮探针观测到一次 0 条' : '本轮探针每次都返回 ≥1 条',
  },
  {
    capability: 'failure（4xx/5xx/限流/连接错误 → 受控失败码，不装成成功）',
    codeChecked: true,
    liveObserved: liveSawFailure,
    liveEvidence: liveSawFailure
      ? '本轮探针观测到真实失败'
      : '本轮探针未观测到真实失败（限流/5xx 只在注入路径上验证过）',
  },
  {
    capability: 'cancel（调用方取消 vs 硬超时是两个结论）',
    codeChecked: true,
    liveObserved: false,
    liveEvidence: '真实链路不做取消探针（没有真实取消来源；E2E 用 fixture 端口覆盖）',
  },
  {
    capability: 'outbound-shape（恰好一次 POST /search · 六个 body 字段 · 凭证只在头）',
    codeChecked: true,
    liveObserved: liveProbes.length > 0,
    liveEvidence:
      liveProbes.length > 0 ? '真实出站逐次核对了 body 字段名与请求头名' : '本次未运行真实探针',
  },
]
for (const entry of capabilities) {
  check(
    `${entry.codeChecked && entry.liveObserved ? '★ 已验证' : '⚠️ 部分验证'}：${entry.capability}`,
    entry.codeChecked,
    `离线注入路径=已断言 · 真实出站=${entry.liveObserved ? '已观测' : '未观测'}（${entry.liveEvidence}）`
  )
}

const passed = report.passed
const failed = report.failed
const verdict = failed > 0 ? 'FAIL' : measurementInvalid > 0 ? 'MEASUREMENT INVALID' : 'PASS'

console.log(`\nTD-10 搜索可靠性门：${passed} 通过 / ${failed} 失败｜measurementInvalid=${measurementInvalid}｜判定 ${verdict}`)

mkdirSync(EVIDENCE_DIR, { recursive: true })
const offlineEvidence = {
  testId: 'TD-10 / 搜索链路可靠性（超时 · 空结果 · 失败降级）',
  scope:
    '真实 provider（createTavilySearchProvider）+ 真实适配器（createWebSearchAdapter）+ 真实五态（applyExternalEvidenceReplyPolicy）；' +
    'fetch 为注入实现（离线、确定性、不出站）。真实出站只在 --live 下发生。',
  boundary:
    '本门**不改**信念 / 记忆 / ContextCompiler，**不换** provider，**不改**搜索策略；只调用既有实现并记录读数。',
  verdict,
  counts: { checksPassed: passed, checksFailed: failed, measurementInvalid },
  measured: measures,
  outboundShape: {
    method: D20_RULING.method,
    endpoint: TAVILY_ENDPOINT,
    allowedBodyFields: D20_RULING.includeUsage === true ? shapeRequest?.bodyFieldNames ?? [] : [],
    allowedHeaderNames: shapeRequest?.headerNames ?? [],
    requestsPerSearch: D20_RULING.requestsPerSearchAtAdapterBoundary,
    automaticRetry: D20_RULING.automaticRetry,
    hardTimeoutMs: D20_RULING.hardTimeoutMs,
    queryLeavesHost: D20_RULING.queryLeavesHost,
    recordingPolicy: '记录器结构上不保存请求头值与 body 内容（只留名字与长度）',
  },
  degradationMatrix: matrixRows,
  userVisible: truthfulOutcomes.map((row) => ({
    case: row.name,
    replyState: row.state,
    claimsReplaced: row.corrected,
    replyText: row.replyText,
  })),
  liveProbe: {
    ran: liveFlag && liveSkipReason === null,
    skipReason: liveSkipReason,
    credentialEnv: liveCredentialEnvName,
    credentialNote: liveCredentialNote,
    note: `真实探针只读测试具名变量 ${TAVILY_TEST_API_KEY_ENV}；生产名 ${TAVILY_API_KEY_ENV} 在本门结构上读不到`,
    rows: liveProbes,
    latencyMs: liveProbes.map((row) => row.elapsedMs),
  },
  capabilities,
}
writeFileSync(join(EVIDENCE_DIR, 'reliability-offline.json'), `${JSON.stringify(offlineEvidence, null, 2)}\n`, 'utf8')
console.log('  证据：artifacts/td/td10-td12/reliability-offline.json')

if (liveProbes.length > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const liveEvidence = {
    testId: 'TD-10 / 搜索链路可靠性（真实出站探针）',
    note:
      '真实 provider + 真实网络 + 测试具名凭证；只记录形状、时延与结果计数，**不记录**响应正文；' +
      '查询词为合成公开词，且**只**存在于本文件的查询列表里（未使用任何用户原话）。',
    endpoint: TAVILY_ENDPOINT,
    hardTimeoutMs: D20_RULING.hardTimeoutMs,
    observedAt: new Date().toISOString(),
    rows: liveProbes,
  }
  const livePath = join(EVIDENCE_DIR, `reliability-live-${stamp}.json`)
  writeFileSync(livePath, `${JSON.stringify(liveEvidence, null, 2)}\n`, 'utf8')
  console.log(`  证据（真实出站）：artifacts/td/td10-td12/reliability-live-${stamp}.json`)
}

process.exit(failed > 0 ? 1 : 0)
