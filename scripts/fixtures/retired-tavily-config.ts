/** ADR-141: historical offline fixture; not part of production configuration. */
/**
 * 搜索 provider 配置 —— **Tavily**（M5.5 / ADR-046 `D-20`…`D-30`，由 ADR-054 落地）。
 *
 * ============================================================================
 *  provider 的第四次换代：Brave（ADR-045）→ Tavily（ADR-046，冻结未激活）
 *  → 本地 SearXNG（ADR-047）→ **Tavily**（本文件，2026-09-22）
 * ============================================================================
 * ADR-046 的 `D-20`…`D-30` 在本文件里**逐条落地**；ADR-047 的 `D-31a`（本地 SearXNG 那套）
 * 随本次换代**退役**（provider 只有一个 —— ADR-046 的 `V-2` 否决了"两个 provider 并存"）。
 *
 * ADR-045 里与 provider 无关的部分（`D-1`…`D-18`：外部证据边界、能力形状、引用唯一性、
 * trace 映射、预算缺省 0、回复五态）**一个字都没变**。
 *
 * ---------------------------------------------------------------------------
 *  这个文件的全部意义是"不可能悄悄做错"
 * ---------------------------------------------------------------------------
 *  1. **endpoint 是代码常量**，不接受环境变量、不接受用户输入（做成可配 = 开一个
 *     能指向任意主机的口子）。
 *  2. **HTTPS 是硬要求**（与 SearXNG 的 loopback 例外不同：那条例外随 D-31a 一起退役）。
 *  3. **凭证只从环境变量读**，而且**按模式分开**：
 *     · 生产读 `M55_TAVILY_SEARCH_API_KEY`
 *     · 测试读 `M55_TAVILY_SEARCH_TEST_API_KEY`（`ADR-046 D-25`）
 *     一个模式只拼一个变量名、只读一次 ⇒ **测试缺失时结构上不可能回落到生产 key**。
 *     这是本仓库最坏的失败模式（"以为在跑测试、其实在烧生产额度"）的结构性防线。
 *  4. **成本只报告、不阻断**（`ADR-046 D-30`）：声明单价 / credit 数 / `recordedAt` /
 *     `source` 都在这里，但**没有任何"因为贵所以拒绝加载"的路径**，而且
 *     `costEnforcement: 'none'` 是**作为数据写下来的** —— 有人把闸装回来，量具看得见。
 *  5. **`search_depth: basic` + `auto_parameters: false`**（`D-23`）：官方文档明写
 *     `auto_parameters` 可能把 basic 悄悄升级成 advanced（2 credits = 成本翻倍）。
 */

import { KernelError } from '../../src/kernel/contracts/ids.ts'

// ---------------------------------------------------------------------------
// `D-20` 裁定（**作为数据**记录，供闸比对 —— 改裁定要改这里，改不了"悄悄改常量"）
// ---------------------------------------------------------------------------

export const TAVILY_ENDPOINT = 'https://api.tavily.com/search' as const
export const TAVILY_PROVIDER_ID = 'tavily' as const

/** 生产凭证的变量名（`D-25`：与测试名**不同名**，这是"不可能回落到生产 key"的机制） */
export const TAVILY_API_KEY_ENV = 'M55_TAVILY_SEARCH_API_KEY' as const
/** 测试凭证的变量名（`D-25`） */
export const TAVILY_TEST_API_KEY_ENV = 'M55_TAVILY_SEARCH_TEST_API_KEY' as const

/** 出站 body 里**允许**出现的字段名（多一个都不许；量具逐字断言） */
export const TAVILY_ALLOWED_BODY_FIELDS: readonly string[] = [
  'auto_parameters',
  'include_usage',
  'language',
  'max_results',
  'query',
  'search_depth',
]

/** 出站请求里**允许**出现的请求头名（小写；多一个都不许） */
export const TAVILY_ALLOWED_HEADER_NAMES: readonly string[] = [
  'accept',
  'authorization',
  'content-type',
]

/**
 * `D-30`：成本**只报告**。
 *
 * ⚠️ `enforced: false` 不是注释而是**数据**：量具有一条**反向**判据 ——
 *    把单价抬到 0.05/credit 时加载器必须**照常成功**。哪天有人把闸装回来，那条会红。
 */
export const PROVIDER_PRICE_FACTS = {
  provider: 'tavily',
  usdPerCredit: 0.008,
  creditsPerBasicSearch: 1,
  freeCreditsPerMonth: 1000,
  recordedAt: '2026-09-22',
  source: 'https://docs.tavily.com/documentation/api-credits',
  enforced: false,
} as const

/**
 * 硬超时（毫秒）—— **由用户 2026-09-22 重新裁定为 15000**。
 *
 * ⚠️ 为什么必须重新裁定（这是**实测**，不是小心）：
 *    Tavily 的时延分布实测为 min 2285ms · avg 4897ms · **max 8365ms**（4 发，1 发超 5000）。
 *    ADR-046 沿用 ADR-045 的 5000ms 会把约 1/4 的真实搜索判成 `timeout`
 *    ⇒ 用户仍会看到"没查到"。因此按 `ADR-045 D-19 §3`"先问后改"的规矩重新裁定。
 * ⚠️ 它与**判定器**的超时（`SEARCH_NEED_JUDGE_TIMEOUT_MS`，缺省 25000）是**两层**预算，
 *    不得混用一句话记录。
 */
export const TAVILY_HARD_TIMEOUT_MS = 15_000

/** 结果条数上限（ADR-045 沿用：最多 5 条） */
export const TAVILY_MAX_RESULTS = 5

/** 一次搜索**恰好一次**请求、**零**自动重试（`D-28`） */
export const TAVILY_REQUESTS_PER_SEARCH = 1
export const TAVILY_AUTOMATIC_RETRY = 0

/** 搜索深度（`D-23`：显式 basic，且关掉可能偷偷升级的 auto_parameters） */
export const TAVILY_SEARCH_DEPTH = 'basic' as const
export const TAVILY_AUTO_PARAMETERS = false as const
/** `include_usage: true` ⇒ provider 把**实际**消耗的 credit 报回来（成本用测量，不用假设） */
export const TAVILY_INCLUDE_USAGE = true as const

/** 全部冻结事实（量具逐条比对；改裁定要改这里，改不了常量） */
export const D20_RULING = {
  decision: 'ADR-046 D-20…D-30（由 ADR-054 落地）',
  supersedes: 'D-31a（ADR-047 / ADR-053，本地 SearXNG + 冻结引擎组）',
  providerClass: 'P-1 单一 JSON Search API',
  provider: 'Tavily',
  endpoint: TAVILY_ENDPOINT,
  method: 'POST',
  authentication: 'bearer-header-only',
  sdk: 'none',
  apiFeeUsd: 0,
  requestsPerSearchAtAdapterBoundary: TAVILY_REQUESTS_PER_SEARCH,
  automaticRetry: TAVILY_AUTOMATIC_RETRY,
  hardTimeoutMs: TAVILY_HARD_TIMEOUT_MS,
  maxResults: TAVILY_MAX_RESULTS,
  searchDepth: TAVILY_SEARCH_DEPTH,
  autoParameters: TAVILY_AUTO_PARAMETERS,
  includeUsage: TAVILY_INCLUDE_USAGE,
  /** `D-30`：**没有**价格闸。这个字段本身是可断言的证据。 */
  costEnforcement: 'none' as const,
  /** ⚠️ provider 出站：`query` 直接发给 Tavily 的服务器（不是本机代理） */
  queryLeavesHost: true,
  ruledAt: '2026-09-22',
} as const

export interface TavilyConfig {
  readonly providerId: typeof TAVILY_PROVIDER_ID
  readonly endpoint: string
  readonly method: 'POST'
  readonly hardTimeoutMs: number
  readonly maxResults: number
  readonly searchDepth: string
  readonly autoParameters: boolean
  readonly includeUsage: boolean
  readonly requestCountPerSearch: number
  readonly automaticRetry: number
  /**
   * 凭证。
   *
   * ⚠️ 它**只**允许出现在 `Authorization` 请求头里（`D-26`）。
   *    这个对象**不得**被序列化进 trace / 账本 / 日志 / 证据（有静态锁与量具）。
   */
  readonly apiKey: string
  /** 这个 key 是从哪个变量读来的（**只有名字，没有值**；进日志也只到这里） */
  readonly apiKeyEnvName: string
}

/** 可注入的"声明"（用于量具的三段式：把不合法的形状喂进来，闸必须响） */
export interface TavilyDeclarationInput {
  endpoint?: string
  hardTimeoutMs?: number
  requestsPerSearch?: number
  automaticRetry?: number
  maxResults?: number
  method?: string
  searchDepth?: string
  autoParameters?: boolean
  includeUsage?: boolean
  /** 直接给 key（量具用）；缺省时由 `loadTavilyConfig` 按模式从环境变量读 */
  apiKey?: string
}

export interface TavilyConfigFailure {
  ok: false
  problems: string[]
}

export type TavilyConfigResult = { ok: true; config: TavilyConfig } | TavilyConfigFailure

// ---------------------------------------------------------------------------
// 校验（失败关闭）
// ---------------------------------------------------------------------------

/** 解析并核对 endpoint 的**每一段**：scheme / host / path / 无凭证 / 无 fragment / 裸 URL */
export function validateTavilyEndpoint(endpoint: string): string[] {
  const problems: string[] = []
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return ['endpoint 不是合法 URL']
  }
  if (url.protocol !== 'https:') {
    problems.push(`endpoint 只允许 https（D-31c 的 loopback http 例外随 SearXNG 一起退役），实际是 ${url.protocol}`)
  }
  if (url.hostname !== 'api.tavily.com') {
    problems.push(`endpoint 只允许固定 host api.tavily.com（不演进为可配置 endpoint），实际是 ${url.hostname}`)
  }
  if (url.pathname !== '/search') {
    problems.push(`endpoint 路径必须是 /search，实际是 ${url.pathname}`)
  }
  if (url.port !== '') {
    problems.push(`endpoint 不允许显式端口，实际是 ${url.port}`)
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('endpoint 不允许带用户名或密码')
  }
  if (url.hash !== '') {
    problems.push('endpoint 不允许带 fragment')
  }
  if (url.search !== '') {
    problems.push('endpoint 必须是裸 URL（查询参数由请求构造函数生成，不写在 endpoint 里）')
  }
  return problems
}

/** key 的形状校验：非空、无空白、有 `tvly-` 前缀（**不校验长度以外的任何东西**） */
export function validateTavilyApiKey(apiKey: string): string[] {
  const problems: string[] = []
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return ['缺少 Tavily 凭证：未设置对应的环境变量（**不**回落任何其它凭证来源）']
  }
  if (/\s/.test(apiKey)) problems.push('凭证里不允许出现空白字符')
  if (!apiKey.startsWith('tvly-')) problems.push('凭证必须以 tvly- 开头（不是 Tavily 的 key 形状）')
  return problems
}

/**
 * 读配置。**只在这一个地方读环境变量**。
 *
 * ⚠️ `isTestMode` 由调用方（装配层）决定，而它决定读**哪个变量名** ——
 *    这不是"风格"，是 `D-25` 的机制：测试模式**只**读 `…_TEST_…`，
 *    于是测试缺失时结构上不存在"回落到生产 key"这条路。
 */
export function loadTavilyConfig(
  input: TavilyDeclarationInput = {},
  options: { isTestMode?: boolean; env?: NodeJS.ProcessEnv } = {}
): TavilyConfigResult {
  const env = options.env ?? process.env
  const isTestMode = options.isTestMode === true
  const endpoint = input.endpoint ?? TAVILY_ENDPOINT
  const method = input.method ?? D20_RULING.method
  const hardTimeoutMs = input.hardTimeoutMs ?? TAVILY_HARD_TIMEOUT_MS
  const requestsPerSearch = input.requestsPerSearch ?? TAVILY_REQUESTS_PER_SEARCH
  const automaticRetry = input.automaticRetry ?? TAVILY_AUTOMATIC_RETRY
  const maxResults = input.maxResults ?? TAVILY_MAX_RESULTS
  const searchDepth = input.searchDepth ?? TAVILY_SEARCH_DEPTH
  const autoParameters = input.autoParameters ?? TAVILY_AUTO_PARAMETERS
  const includeUsage = input.includeUsage ?? TAVILY_INCLUDE_USAGE

  const envName = isTestMode ? TAVILY_TEST_API_KEY_ENV : TAVILY_API_KEY_ENV
  const apiKey = input.apiKey ?? (env[envName] ?? '').trim()

  const problems: string[] = []
  problems.push(...validateTavilyEndpoint(endpoint))
  problems.push(...validateTavilyApiKey(apiKey))

  if (method !== 'POST') problems.push(`方法必须是 POST，实际是 ${String(method)}`)
  if (requestsPerSearch !== 1) {
    problems.push(`一次搜索的请求数必须是 1（D-28），实际是 ${String(requestsPerSearch)}`)
  }
  if (automaticRetry !== 0) {
    problems.push(`自动重试必须是 0（D-28），实际是 ${String(automaticRetry)}`)
  }
  /*
   * ⚠️ 上界由 **D-30 之后的现行裁定**决定：15000（用户 2026-09-22 重新裁定）。
   *    它不是"越大越好"：判定器与搜索是两层预算，各自有界。
   */
  if (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs <= 0 || hardTimeoutMs > 15_000) {
    problems.push(`硬超时必须落在 (0, 15000] ms（2026-09-22 裁定），实际是 ${String(hardTimeoutMs)}`)
  }
  if (maxResults !== TAVILY_MAX_RESULTS) {
    problems.push(`结果上限必须是 ${TAVILY_MAX_RESULTS}，实际是 ${String(maxResults)}`)
  }
  if (searchDepth !== 'basic') {
    problems.push(`search_depth 必须是 basic（advanced = 2 credits 且需重新裁定），实际是 ${String(searchDepth)}`)
  }
  if (autoParameters !== false) {
    problems.push('auto_parameters 必须是 false（官方文档明写它可能把 basic 悄悄升级成 advanced）')
  }
  if (includeUsage !== true) {
    problems.push('include_usage 必须是 true（成本靠测量，不靠假设）')
  }
  if (TAVILY_ENDPOINT !== D20_RULING.endpoint) {
    problems.push(`endpoint 常量与裁定不一致：${TAVILY_ENDPOINT} ≠ ${D20_RULING.endpoint}`)
  }
  /*
   * 形状自洽（`D-30` 保留的那一条）：声明的 credit 数必须与声明的深度一致。
   * ⚠️ 这里**没有**任何"单价超上限 ⇒ 拒绝加载"的路径 —— 那正是 `D-30` 取消的执行。
   */
  const declaredCredits = searchDepth === 'basic' ? 1 : 2
  if (declaredCredits !== PROVIDER_PRICE_FACTS.creditsPerBasicSearch) {
    problems.push(
      `声明的 credit 数与深度不一致：${searchDepth} 应是 1 credit，而 PROVIDER_PRICE_FACTS 声明 ${PROVIDER_PRICE_FACTS.creditsPerBasicSearch}`
    )
  }

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    config: {
      providerId: TAVILY_PROVIDER_ID,
      endpoint: TAVILY_ENDPOINT,
      method: 'POST',
      hardTimeoutMs,
      maxResults,
      searchDepth,
      autoParameters,
      includeUsage,
      requestCountPerSearch: TAVILY_REQUESTS_PER_SEARCH,
      automaticRetry: TAVILY_AUTOMATIC_RETRY,
      apiKey,
      apiKeyEnvName: envName,
    },
  }
}

/** 断言版本（装配层用）：不合法 ⇒ 抛（**失败关闭**，不静默降级） */
export function assertTavilyConfig(
  input: TavilyDeclarationInput = {},
  options: { isTestMode?: boolean; env?: NodeJS.ProcessEnv } = {}
): TavilyConfig {
  const result = loadTavilyConfig(input, options)
  if (result.ok) return result.config
  throw new KernelError(
    'validation_error',
    'tavily_search_config_invalid',
    `Tavily 搜索配置不可用（失败关闭）：\n` + result.problems.map((p) => `  - ${p}`).join('\n')
  )
}

/**
 * 诊断摘要：**没有 key 这一栏**（`D-27`：最多说"变量存在/不存在"，不给值、不给长度）。
 */
export function describeTavilyConfig(result: TavilyConfigResult): string {
  const keyEnv = `key-env=${TAVILY_API_KEY_ENV}(生产)/${TAVILY_TEST_API_KEY_ENV}(测试)`
  const price =
    `declared=${PROVIDER_PRICE_FACTS.usdPerCredit} USD/credit × ${PROVIDER_PRICE_FACTS.creditsPerBasicSearch} ` +
    `= ${(PROVIDER_PRICE_FACTS.usdPerCredit * PROVIDER_PRICE_FACTS.creditsPerBasicSearch).toFixed(3)} USD/次` +
    `（cost-enforcement=${D20_RULING.costEnforcement} · recordedAt=${PROVIDER_PRICE_FACTS.recordedAt} · source=${PROVIDER_PRICE_FACTS.source}）`
  const head =
    `search provider = ${D20_RULING.provider}（${D20_RULING.providerClass}）· ` +
    `${D20_RULING.method} ${D20_RULING.endpoint} · auth=${D20_RULING.authentication} · ` +
    `depth=${D20_RULING.searchDepth} · auto_parameters=${String(D20_RULING.autoParameters)} · ` +
    `include_usage=${String(D20_RULING.includeUsage)} · results ≤ ${D20_RULING.maxResults} · ` +
    `requests/search=${D20_RULING.requestsPerSearchAtAdapterBoundary} · retry=${D20_RULING.automaticRetry} · ` +
    `timeout=${D20_RULING.hardTimeoutMs}ms · sdk=${D20_RULING.sdk} · api_fee=${D20_RULING.apiFeeUsd} · ` +
    `q_leaves_host=${String(D20_RULING.queryLeavesHost)} · ${keyEnv} · ${price}`
  if (result.ok) return head
  return `${head} · problems=${result.problems.length}（${result.problems
    .map((p) => p.replace(/\s+/g, ' ').slice(0, 80))
    .join(' / ')}）`
}
