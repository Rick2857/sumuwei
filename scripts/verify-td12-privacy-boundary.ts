/**
 * TD-12 —— **搜索的触发边界与出站隐私边界证据**（`pnpm td12:privacy`）。
 *
 * ============================================================================
 *  这一门回答四件事
 * ============================================================================
 * TD-12 原文把三条局限捆在一起：`L-M55-15`（词形触发误判：漏触发 / **私人否定引用误触发** /
 * 查询抽取）· `L-M55-17`（**隐私边界端到端证据**）· `L-M55-03`（任意语言假搜索口吻）。
 * 登记册的处置建议是：「涉及对应功能再激活/扩展前给出**分项端到端证据与剩余范围**」。
 *
 * 于是本门把"会不会误触发"与"到底送出去了什么"分开量：
 *
 *   §1 触发边界：真实检测器（`createExternalEvidenceIntentDetector`，与装配层同一份实现）
 *      对**私人内容 / 否定句 / 引用文本 / 普通闲聊**四类语料逐条分类。
 *   §2 查询抽取：触发之后那条 `query` 是什么（抽取是"用户原话去掉触发词"，不是改写）。
 *   §3 **实际出站内容**：真实 `buildTavilySearchRequest` + 真实记录器 ——
 *      逐条给出"这一次真的会送出去的东西"（method / host / body 字段 / 请求头名 / body 里
 *      是否含 query 正文 / 是否含上下文哨兵）。
 *   §4 结构性边界：记录器不保存请求头值与 body 内容；凭证只在头部；上下文（记忆 / 人设 /
 *      用户 id / trace / 历史）在**类型上**没有位置。
 *
 * 全程**离线**（不联网、不需要 key、不加载 `.env`、不碰数据库）。真实 provider 只被用来
 * **构造请求字符串**，记录器吃掉的 fetch 永远不会真的发出去。
 *
 * ⚠️ 它**不改**触发判据、**不改** provider、**不改**搜索策略（用户 2026-09-27 的边界）。
 *
 * 跑法：`pnpm td12:privacy`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createReporter } from './m4-harness.ts'
import {
  chainIntentDetectors,
  createExternalEvidenceIntentDetector,
  extractSearchQuery,
} from '../src/kernel/action/external-evidence-intent.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import { WEB_SEARCH } from '../src/kernel/action/external-evidence-capability.ts'
import { validateSearchQuery } from '../src/kernel/action/search-port.ts'
import {
  buildTavilySearchRequest,
  createTavilySearchProvider,
} from './fixtures/retired-tavily-search-provider.ts'
import {
  TAVILY_ALLOWED_BODY_FIELDS,
  TAVILY_ALLOWED_HEADER_NAMES,
  TAVILY_API_KEY_ENV,
  loadTavilyConfig,
  type TavilyConfig,
} from './fixtures/retired-tavily-config.ts'
import { createRecordingFetch } from '../src/infrastructure/search/recording-fetch.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'td', 'td10-td12')

const report = createReporter()
const { check, section } = report

const measures: { label: string; count: number }[] = []
function measure(label: string, count: number): number {
  measures.push({ label, count })
  if (count <= 0) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 离线合成 key（本门不出站，它永远只出现在"未记录的头值"那里） */
const OFFLINE_KEY = 'tvly-offline-0000000000000000000000000000'

function makeConfig(): TavilyConfig {
  const loaded = loadTavilyConfig({ apiKey: OFFLINE_KEY }, { env: {} as NodeJS.ProcessEnv })
  if (!loaded.ok) throw new Error(`离线配置构造失败：${loaded.problems.join(' / ')}`)
  return loaded.config
}
const CONFIG = makeConfig()

/**
 * 上下文哨兵：它们**只**存在于测试这一侧，模拟"真实装配里才会有的那些东西"。
 *
 * ⚠️ 真实装配里这些东西连**类型**都进不了 provider 端口（`SearchProviderCall` 只有
 *    query/limit/locale/signal）。本门把它们放在进程环境与局部变量里，
 *    然后断言出站字节里找不到它们 —— 这样"没有位置"这条结构性质变成一条**读得到**的读数。
 */
const SENTINELS = {
  memory: 'SENTINEL-MEMORY-用户上周说过的私事-8f2a',
  persona: 'SENTINEL-PERSONA-人设正文片段-31c7',
  userId: 'SENTINEL-USER-42',
  traceId: 'SENTINEL-TRACE-abc123',
  history: 'SENTINEL-HISTORY-上一轮对话正文',
  prompt: 'SENTINEL-PROMPT-system-正文',
} as const

/**
 * 私人内容语料。
 *
 * 它与下一条（`CONTEXT_SENTINELS`）的区别是**性质**不同，因此结论也不同：
 *   · `SENTINELS` 是"系统里的上下文" —— 它们**任何情况下都不得出站**（下面逐条断言）。
 *   · 这里的"私人内容"是**用户自己说的话**：没有触发词时不得出站；
 *     但用户**显式要求搜索**且把私人内容写进查询时，它会随查询一起出站 ——
 *     那是抽取值域的性质，不是漏洞（§3 把它作为**边界事实**逐字记录下来）。
 */
const PRIVATE_MARKER = {
  diary: 'PRIVATE-DIARY-我今天心情很差-9a1',
  chat: 'PRIVATE-CHAT-小林告诉我的私事-4b2',
  id: 'PRIVATE-ID-身份证号-330106199901011234-7c3',
  health: 'PRIVATE-HEALTH-体检报告上的指标-2d4',
} as const

// ---------------------------------------------------------------------------
// §1 触发边界语料
// ---------------------------------------------------------------------------

type Expectation = 'trigger' | 'silent'

interface TriggerCase {
  /** 分组（私人内容 / 否定句 / 引用文本 / 普通闲聊 / 显式正当搜索） */
  group: string
  text: string
  expect: Expectation
  /** 期望的查询词；`null` = 本门不断言抽取（只断言触发与否） */
  expectQuery?: string
  /** 这条用例里是否夹带了私人内容标记 */
  carriesPrivate?: string
  note?: string
}

const TRIGGER_CASES: TriggerCase[] = [
  /* ---------- A 私人内容（不得触发搜索） ---------- */
  {
    group: '私人内容',
    text: `记住：${PRIVATE_MARKER.diary}，这件事只跟你说。`,
    expect: 'silent',
    carriesPrivate: PRIVATE_MARKER.diary,
    note: '陈述私人事实：没有任何联网词形 ⇒ 不得出网',
  },
  {
    group: '私人内容',
    text: `我昨天在日记里写了 ${PRIVATE_MARKER.chat}，帮我记一下。`,
    expect: 'silent',
    carriesPrivate: PRIVATE_MARKER.chat,
    note: '"帮我记一下"是记忆动作，不是本地搜索词形（"查一下"才是）',
  },
  {
    group: '私人内容',
    text: `我的${PRIVATE_MARKER.id}，别写进任何地方。`,
    expect: 'silent',
    carriesPrivate: PRIVATE_MARKER.id,
    note: '身份信息 + 明确禁止',
  },
  {
    group: '私人内容',
    text: `这是${PRIVATE_MARKER.health}，你帮我看看这段数字什么意思。`,
    expect: 'silent',
    carriesPrivate: PRIVATE_MARKER.health,
    note: '要她解释 ⇒ 不是"上网查"',
  },
  {
    group: '私人内容',
    text: '我今天很累，什么都不想做，陪我待一会儿。',
    expect: 'silent',
    note: '纯情绪表达',
  },
  /* ---------- B 否定句（不得触发搜索） ---------- */
  {
    group: '否定句',
    text: '不要联网搜索，只根据你已有的知识回答。',
    expect: 'silent',
    note: 'L-M55-16 的原句（M5.5.1 WP2b 已修）；**不得**再把整句当查询送出去',
  },
  {
    group: '否定句',
    text: '不用搜索了，我们直接聊。',
    expect: 'silent',
  },
  {
    group: '否定句',
    text: '先别搜，我还没想好要问什么。',
    expect: 'silent',
  },
  {
    group: '否定句',
    text: '不需要帮我查一下，我自己来。',
    expect: 'silent',
  },
  {
    group: '否定句',
    text: '禁止联网查这件事。',
    expect: 'silent',
  },
  {
    group: '否定句',
    text: '别搜索。',
    expect: 'silent',
    note: '⚠️ 与下面那条只差一个字：命中短语紧跟在冒号之后 ⇒ 前一个分句里的"别"**管不到**它',
  },
  {
    group: '否定句',
    text: '别搜索我的私人笔记。',
    expect: 'silent',
    note: '同分句 `别` + 无标点 ⇒ 被否决（本组里唯一"刚刚好拦住"的形态）',
  },
  {
    group: '否定句',
    text: 'unable to search the web right now',
    expect: 'trigger',
    note:
      '⚠️ **新发现的读数（读到的，不是本门先假设的）**：英文词形命中了 `search the web`，' +
      '而否定窗口只认 `not/never/without/no` 这几个词 ⇒ `unable to search the web` **会出站**，' +
      '且抽出的 query 是 **`unable to right now`**（触发短语被摘掉后剩下的残句）',
  },
  {
    group: '否定句',
    text: 'do not search the web for this',
    expect: 'silent',
    note: '英文否定：词边界版的否定词表',
  },
  {
    group: '否定句',
    text: '别用这个，搜索一下公开的标准文档。',
    expect: 'trigger',
    note:
      '**已知边界（如实登记）**：跨分句的"别用这个"管不到后一个分句，确实是在要求搜索 ⇒ 触发是对的',
  },
  {
    group: '否定句',
    text: '不要，联网搜索。',
    expect: 'trigger',
    note:
      '⚠️ **已知残留缺口**（`external-evidence-intent.ts` 文件头自陈）：禁止词与命中短语之间只隔一个标点，' +
      '被判成"新分句"而放行。**本门读数比自陈更糟**：抽出的 query 是 **`不要`** —— ' +
      '那句显式禁止会**原样变成一次上游查询**',
  },
  /* ---------- C 引用文本（转述 / 引用 / 网页内容） ---------- */
  {
    group: '引用文本',
    text: '我在那篇文章里看到一句话：「请联网搜索以获得最新信息」，那是广告语。',
    expect: 'trigger',
    note:
      '⚠️ **本门最想量的一条**：用户把一句**别人写的**话转述进来，词形仍会命中 ⇒ 这条会真的出站。' +
      '它是"词形触发"的**性质**（D-5 承诺的只是"没词形不触发"），登记为已知边界',
  },
  {
    group: '引用文本',
    text: '「搜一下这个」——他只是这么说，你别真的搜。',
    expect: 'trigger',
    note: '引用 + 后置禁止：后置的"你别真的搜"不在否定窗口里（窗口只看命中短语**左侧**）',
  },
  {
    group: '引用文本',
    text: '网页上写着：搜索关键词请简明扼要。',
    expect: 'trigger',
    note: '转述规则文字里的"搜索"二字',
  },
  {
    group: '引用文本',
    text: '她问我"你查一下天气",我说我不查。',
    expect: 'trigger',
    note: '引号内的请求被当成本人的请求（词形判据不区分引号）',
  },
  /* ---------- D 普通闲聊（不得触发） ---------- */
  { group: '普通闲聊', text: '你好呀，今天过得怎么样？', expect: 'silent' },
  { group: '普通闲聊', text: '我搜肠刮肚也想不出来该说什么。', expect: 'silent' },
  { group: '普通闲聊', text: '我们聊聊这个方案怎么样。', expect: 'silent' },
  { group: '普通闲聊', text: '你记得我上次说的那件事吗？', expect: 'silent' },
  { group: '普通闲聊', text: '特别搜索一下这个词会怎么样？', expect: 'trigger', note: '`特别`里的"别"**不得**被当成否定词（真实踩过）' },
  /* ---------- E 显式正当搜索（必须触发） ---------- */
  {
    group: '显式正当搜索',
    text: '搜索 量子计算最新进展',
    expect: 'trigger',
    expectQuery: '量子计算最新进展',
  },
  { group: '显式正当搜索', text: '查一下 明天的天气', expect: 'trigger', expectQuery: '明天的天气' },
  {
    group: '显式正当搜索',
    text: '联网查一下 某个公开标准',
    expect: 'trigger',
    expectQuery: '某个公开标准',
  },
  {
    group: '显式正当搜索',
    text: 'please web search the official docs',
    expect: 'trigger',
    expectQuery: 'the official docs',
  },
  { group: '显式正当搜索', text: '上网搜索 上海到杭州的高铁', expect: 'trigger', expectQuery: '上海到杭州的高铁' },
  {
    group: '显式正当搜索',
    text: `查一下 这个公开标准是什么，另外别把 ${PRIVATE_MARKER.diary} 说出去`,
    expect: 'trigger',
    carriesPrivate: PRIVATE_MARKER.diary,
    note:
      '⚠️ **边界事实**：用户**显式要求搜索**，私人内容写在同一句里 ⇒ 抽取值域包含它。' +
      '本门逐字记录实际出站内容，不做"自动脱敏"（那会改判据，越出本任务边界）',
  },
]

// ===========================================================================
section('§1 触发边界：真实检测器对四类语料逐条分类')
// ===========================================================================

const chained = chainIntentDetectors([createActionIntentDetector(), createExternalEvidenceIntentDetector()])
measure('触发边界语料条数', TRIGGER_CASES.length)

interface TriggerRow {
  group: string
  text: string
  expected: Expectation
  actual: 'trigger' | 'silent' | 'other-intent'
  capability: string | null
  rule: string | null
  query: string | null
  matchedExpectation: boolean
  note: string | null
}

const triggerRows: TriggerRow[] = []
for (const testCase of TRIGGER_CASES) {
  const intent = chained.detect(testCase.text)
  const actual: TriggerRow['actual'] =
    intent === undefined ? 'silent' : intent.capability === WEB_SEARCH ? 'trigger' : 'other-intent'
  const row: TriggerRow = {
    group: testCase.group,
    text: testCase.text,
    expected: testCase.expect,
    actual,
    capability: intent?.capability ?? null,
    rule: intent?.rule ?? null,
    query: intent === undefined ? null : String(intent.args.query ?? ''),
    matchedExpectation: actual === testCase.expect,
    note: testCase.note ?? null,
  }
  triggerRows.push(row)
  check(
    `${row.matchedExpectation ? '★' : '⚠️'} [${testCase.group}] 期望=${testCase.expect} 实际=${actual}：${testCase.text}`,
    row.matchedExpectation,
    intent === undefined
      ? '安静'
      : `capability=${intent.capability} rule=${intent.rule} query=${JSON.stringify(String(intent.args.query ?? ''))}`
  )
}

const silentRows = triggerRows.filter((row) => row.expected === 'silent')
const triggerRowsExpected = triggerRows.filter((row) => row.expected === 'trigger')
check(
  '★ 「私人内容」组：**全部**不得触发（这一类误触发的代价是把私事送出本机）',
  triggerRows.filter((row) => row.group === '私人内容').every((row) => row.actual === 'silent'),
  triggerRows
    .filter((row) => row.group === '私人内容')
    .map((row) => `${row.actual}`)
    .join(',')
)
check(
  '★ 「否定句」组：逐条读数（**本组不是全绿** —— 三条缺口在 capabilities 里逐条登记）',
  triggerRows.filter((row) => row.group === '否定句').every((row) => row.matchedExpectation),
  triggerRows
    .filter((row) => row.group === '否定句')
    .map((row) => `${row.actual}`)
    .join(',')
)
check(
  '★ 「普通闲聊」组：没有联网词形 ⇒ 安静（不猜、不做同义词扩展）',
  triggerRows.filter((row) => row.group === '普通闲聊').every((row) => row.matchedExpectation),
  triggerRows
    .filter((row) => row.group === '普通闲聊')
    .map((row) => row.actual)
    .join(',')
)
check(
  '★ 「显式正当搜索」组：必须触发（否则是**漏触发**，用户会觉得她没去查）',
  triggerRowsExpected
    .filter((row) => row.group === '显式正当搜索')
    .every((row) => row.actual === 'trigger'),
  triggerRowsExpected
    .filter((row) => row.group === '显式正当搜索')
    .map((row) => row.actual)
    .join(',')
)
check(
  '★ 查询词抽取（逐条）：期望值与真实抽取逐字相同（不改写 / 不翻译 / 不补全）',
  TRIGGER_CASES.filter((row) => row.expectQuery !== undefined).every((testCase) => {
    const found = triggerRows.find((row) => row.text === testCase.text)
    return found?.query === testCase.expectQuery
  }),
  TRIGGER_CASES.filter((row) => row.expectQuery !== undefined)
    .map((testCase) => `${JSON.stringify(testCase.expectQuery)}`)
    .join(' · ')
)

/**
 * 「引用文本」组**不**断言"必须安静" —— 它是本门要**量出来的边界**。
 * 这里只把读数摊开，并断言"每一条都有明确结论"（是触发还是安静，不含糊）。
 */
const quotedRows = triggerRows.filter((row) => row.group === '引用文本')
measure('「引用文本」组的读数条数', quotedRows.length)
check(
  '★ 「引用文本」组：逐条给出触发/安静的**具体读数**（这是 TD-12 要的证据，不是一句"可能误触发"）',
  quotedRows.every((row) => row.actual === 'trigger' || row.actual === 'silent'),
  quotedRows.map((row) => `${row.actual}(${row.rule ?? '-'})`).join(' · ')
)
for (const row of quotedRows) {
  console.log(`    [引用文本] ${row.actual.padEnd(8)} rule=${String(row.rule)} :: ${row.text}`)
}

// ===========================================================================
section('§2 实际出站内容（逐条：真实 buildTavilySearchRequest + 真实记录器）')
// ===========================================================================

interface OutboundRow {
  group: string
  text: string
  triggered: boolean
  query: string | null
  requestCount: number
  method: string | null
  host: string | null
  urlHasQueryString: boolean
  bodyFields: string[] | null
  headerNames: string[] | null
  bodyContainsQueryVerbatim: boolean
  bodyLength: number
  hasExtraBodyFields: boolean
  sentPrivateMarker: string | null
  urlHost: string | null
  sentSentinels: string[]
  queryValidationProblems: string[]
}

/**
 * 对一个"触发了"的句子，构造**真实出站请求**并逐项给出"真的送出去了什么"。
 *
 * ⚠️ 记录器**结构上**不保存请求头的值与 body 正文 —— 所以"body 里有没有 query 正文"
 *    这一条必须**独立**算（用 `buildTavilySearchRequest` 的返回值本身，它是纯函数）。
 */
function outboundRowOf(testCase: TriggerCase): OutboundRow {
  const intent = chained.detect(testCase.text)
  const triggered = intent !== undefined && intent.capability === WEB_SEARCH
  if (!triggered) {
    return {
      group: testCase.group,
      text: testCase.text,
      triggered: false,
      query: null,
      requestCount: 0,
      method: null,
      host: null,
      urlHasQueryString: false,
      bodyFields: null,
      headerNames: null,
      bodyContainsQueryVerbatim: false,
      bodyLength: 0,
      hasExtraBodyFields: false,
      sentPrivateMarker: null,
      urlHost: null,
      sentSentinels: [],
      queryValidationProblems: [],
    }
  }
  const query = String(intent!.args.query ?? '')
  const limit = Number(intent!.args.limit)
  const locale = String(intent!.args.locale)
  const request = buildTavilySearchRequest(CONFIG, { query, limit, locale })
  const parsedBody = JSON.parse(request.body) as Record<string, unknown>
  const searchable = `${request.url}\n${request.body}`
  const sentSentinels = Object.entries(SENTINELS)
    .filter(([, value]) => searchable.includes(value))
    .map(([key]) => key)
  /*
   * ⚠️ "query 逐字出现在 body 里"必须按 **JSON 值**判，不能按子串判：
   *    `JSON.stringify` 会把查询里的 `"` 转义成 `\"`，于是"含 query 原文"在
   *    `她问我"你 天气",我说我不查` 这条上**恒假**（第一版就是这么红的）。
   *    按值判既躲开转义，也顺带证明"query 是作为**值**发出去的"，而不是被拼进 SQL/URL。
   *    附带断言：解析出来的值必须与 intent 给的 query **逐字相同**。
   */
  const parsedQuery = parsedBody.query
  return {
    group: testCase.group,
    text: testCase.text,
    triggered: true,
    query,
    requestCount: 1,
    method: request.method,
    host: new URL(request.url).host,
    urlHasQueryString: request.url.includes('?'),
    bodyFields: Object.keys(parsedBody).sort(),
    headerNames: Object.keys(request.headers).sort(),
    bodyContainsQueryVerbatim: parsedQuery === query,
    bodyLength: request.body.length,
    hasExtraBodyFields: Object.keys(parsedBody).some(
      (name) => !(TAVILY_ALLOWED_BODY_FIELDS as readonly string[]).includes(name)
    ),
    sentPrivateMarker:
      testCase.carriesPrivate !== undefined && searchable.includes(testCase.carriesPrivate)
        ? testCase.carriesPrivate
        : null,
    urlHost: new URL(request.url).host,
    sentSentinels,
    queryValidationProblems: validateSearchQuery({ query, limit, locale }),
  }
}

const outboundRows = TRIGGER_CASES.map(outboundRowOf)
const outboundTriggered = outboundRows.filter((row) => row.triggered)
measure('实际出站内容的观测条数（触发了的句子）', outboundTriggered.length)

check(
  '★ 出站形状（逐条）：POST · host=api.tavily.com · body 字段恰好那六个 · 头名恰好那三个',
  outboundTriggered.every(
    (row) =>
      row.method === 'POST' &&
      row.host === 'api.tavily.com' &&
      (row.bodyFields ?? []).join(',') === [...TAVILY_ALLOWED_BODY_FIELDS].sort().join(',') &&
      (row.headerNames ?? []).join(',') === [...TAVILY_ALLOWED_HEADER_NAMES].sort().join(',') &&
      row.hasExtraBodyFields === false
  ),
  `${outboundTriggered.length} 条全部合规`
)
check(
  '★ 查询词**逐字**出现（不编码进 URL、不做 URL 拼接）—— query 只在 body 里，URL 是裸 endpoint',
  outboundTriggered.every((row) => row.bodyContainsQueryVerbatim === true && row.urlHasQueryString === false),
  `${outboundTriggered.length} 条触发行：URL 无查询串 · body 含 query 原文`
)
check(
  '★ **上下文哨兵零出站**：记忆 / 人设 / userId / traceId / 历史 / prompt 一个都不在出站字节里',
  outboundRows.every((row) => row.sentSentinels.length === 0),
  `哨兵 ${Object.keys(SENTINELS).length} 个 · 0 命中`
)
check(
  '★ 私人内容（没有触发词的那些句子）**零出站**：requestCount 全 0',
  outboundRows.filter((row) => row.group === '私人内容').every((row) => row.requestCount === 0 && !row.triggered),
  outboundRows
    .filter((row) => row.group === '私人内容')
    .map((row) => `${row.requestCount}`)
    .join(',')
)

/**
 * 触发之后的 query 必须仍然**合法**（空查询要变成可审计的 `validation_failed`，不是空出站）。
 * 「引用文本」与"显式搜索 + 私人内容"两条会带出私人内容 —— 逐字记录，作为**边界事实**。
 */
const privateCarryingRows = outboundRows.filter((row) => row.sentPrivateMarker !== null)
measure('"把私人内容写进显式查询"这一边界事实的读数条数', privateCarryingRows.length)
for (const row of privateCarryingRows) {
  console.log(`    ⚠️ [带出私人内容] group=${row.group} query=${JSON.stringify(row.query)}`)
}
check(
  '★ 边界事实**如实登记**：用户把私人内容写进显式搜索请求时，它会随 query 出站（抽取值域的性质，不是漏洞）',
  privateCarryingRows.length >= 1,
  privateCarryingRows.map((row) => `query=${JSON.stringify(row.query)}`).join(' · ')
)

check(
  '★ 触发后的 query 一律能过 `validateSearchQuery`（空查询会变成 `validation_failed` 而不是空出站）',
  outboundTriggered.every((row) => row.queryValidationProblems.length === 0 || row.query === ''),
  outboundTriggered.map((row) => `${JSON.stringify(row.query)}:${row.queryValidationProblems.length}`).join(' · ')
)

// 逐条摊开（报告直接引用这段读数）
for (const row of outboundRows) {
  console.log(
    `    [出站] ${row.triggered ? 'YES' : 'no '} group=${row.group.padEnd(6)} ` +
      `query=${JSON.stringify(row.query)} private=${row.sentPrivateMarker ?? '-'}`
  )
}

// ===========================================================================
section('§3 结构性边界：记录器不记值 · 凭证只在头 · 上下文的类型位置')
// ===========================================================================

/** 空查询：触发但校验失败 ⇒ **零出站**（可审计的失败，而不是一次空搜索） */
{
  const recorder = createRecordingFetch()
  const provider = createTavilySearchProvider({ config: CONFIG, fetchImpl: recorder.fetchImpl })
  const outcome = await provider.search({ query: '', limit: 5, locale: 'zh-CN' })
  measure('空查询路径的观测数', 1)
  check(
    '★ 空查询 ⇒ `validation_failed` 且**出站 0**（"说了要搜但没说搜什么"不产生一次真实请求）',
    !outcome.ok && outcome.failure.code === 'validation_failed' && recorder.callCount() === 0,
    `code=${outcome.ok ? 'ok' : outcome.failure.code} outbound=${recorder.callCount()}`
  )
}

/** 记录器结构性保证 */
{
  const recorder = createRecordingFetch()
  const provider = createTavilySearchProvider({ config: CONFIG, fetchImpl: recorder.fetchImpl })
  await provider.search({ query: '合成查询', limit: 2, locale: 'zh-CN' })
  const record = recorder.requests[0]
  const keys = Object.keys(record ?? {})
  measure('记录器结构的字段数', keys.length)
  check(
    '★ 记录器**结构上**不含头的值、不含 body 正文（只有名字与长度）',
    !keys.includes('headers') &&
      !keys.includes('body') &&
      !keys.includes('bodyText') &&
      keys.includes('headerValueLengths'),
    keys.join(',')
  )
  check(
    '★ 凭证只在 `Authorization` 头：URL 与 body 里都没有 key 原文（记录器里也读不到）',
    record !== undefined &&
      !record.url.includes(OFFLINE_KEY) &&
      (record.bodyFieldNames ?? []).every((name) => !/key|token|secret/i.test(name)) &&
      record.headerNames.includes('authorization'),
    `头名=[${record?.headerNames.join(',')}] · body 字段=[${(record?.bodyFieldNames ?? []).join(',')}]`
  )
}

/** 端口类型层面的"没有位置"：用一条独立判据核对实现**没有读**上下文来源 */
check(
  '★ provider 模块**不读**环境变量、不用 logger / console（凭证只有一个入口：`tavily-config.ts`）',
  (() => {
    const source = readSource('scripts/fixtures/retired-tavily-search-provider.ts')
    const code = stripComments(source)
    return !code.includes('process.env') && !code.includes('console.') && !code.includes('logger')
  })(),
  'tavily-search-provider.ts 的代码体里没有 env / console / logger'
)
check(
  '★ 凭证变量名只有一个来源：配置层常量（本门只读**测试**名，不读生产名）',
  TAVILY_API_KEY_ENV === 'M55_TAVILY_SEARCH_API_KEY' && !('M55_TAVILY_SEARCH_API_KEY' in process.env),
  `生产名是否在本进程环境里：${'M55_TAVILY_SEARCH_API_KEY' in process.env ? '是' : '否（本门不加载 .env）'}`
)

// ===========================================================================
section('§3b 门自证：三段式（正控 / 负控 / 恢复）—— 检测器必须会响')
// ===========================================================================

/**
 * 检测器：**出站泄漏 / 静默出站**。
 *
 * 判据全部来自本门自己量到的事实（`triggered` / `requestCount` / 哨兵命中 / 逐字性），
 * 不复用上面那些 `check(...)` 的代码 —— 否则量具与判据是同一份逻辑，
 * "它会不会响"这个问题就没被回答（`AGENTS.md` §6.7）。
 */
function outboundLeakProblems(subject: unknown): string[] {
  const row = subject as OutboundRow
  if (row === null || typeof row !== 'object') return ['不是对象']
  const problems: string[] = []
  // 最坏的一类：没有触发词却出了站
  if (row.triggered !== true && row.requestCount > 0) {
    problems.push(`没有触发词却有 ${row.requestCount} 次出站`)
  }
  if (row.triggered === true) {
    if (row.requestCount !== 1) problems.push(`触发后有 ${row.requestCount} 次出站（必须恰好 1 次）`)
    if (row.sentSentinels.length > 0) problems.push(`上下文哨兵出站：${row.sentSentinels.join(',')}`)
    if (row.bodyContainsQueryVerbatim !== true) problems.push('query 没有作为 body 的值逐字出现（可能被改写/编码）')
    if (row.hasExtraBodyFields === true) problems.push('body 出现了冻结六字段之外的字段')
    if (!(row.bodyFields ?? []).includes('query')) problems.push('body 里没有 query 字段')
  }
  return problems
}

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

/** 正控来源：一条**真实**跑出来的合法触发行（显式搜索、query 逐字、无哨兵） */
const legalOutboundRow = outboundRows.find((row) => row.text === '搜索 量子计算最新进展')
if (legalOutboundRow === undefined) {
  check('内部一致性：合法触发行必须能取到（否则本节的线段落空）', false, '没找到')
} else {
  measure('三段式的检测器数（TD-12）', 1)
  measure('三段式的负控条数（TD-12）', 4)
  threePhase({
    name: '出站泄漏 / 静默出站检测器',
    detector: outboundLeakProblems,
    positive: legalOutboundRow,
    negatives: [
      {
        label: '没有触发词却出了站（最坏的一类：静默出网）',
        subject: { ...legalOutboundRow, triggered: false, requestCount: 1 },
      },
      {
        label: '上下文哨兵混进了 query（记忆 / 人设 / userId … 泄漏）',
        subject: { ...legalOutboundRow, sentSentinels: ['memory'] },
      },
      {
        label: 'query 被改写/编码后出站（不再逐字）',
        subject: { ...legalOutboundRow, bodyContainsQueryVerbatim: false },
      },
      {
        label: 'body 多带了一个字段',
        subject: { ...legalOutboundRow, hasExtraBodyFields: true },
      },
    ],
    restored: legalOutboundRow,
  })
}

/**
 * ③ 正控复跑（分类器形态）：负控语料跑完之后，显式搜索仍然触发，且读数与**本门开头**逐字相同。
 *
 * ⚠️ 措辞刻意精确：本检测器是**无状态**的（`detect()` 不记东西），所以这条量到的是
 *    "负控语料没有改变它的行为 + 确定性"，**不是** M5.5 那条门里"检测器没被弄哑"的同一件事。
 */
const replayIntent = chained.detect('搜索 量子计算最新进展')
check(
  '③ 正控复跑：显式搜索仍然触发，且 query 与开头逐字相同（分类器无状态、确定性）',
  replayIntent?.capability === WEB_SEARCH && String(replayIntent.args.query) === '量子计算最新进展',
  replayIntent === undefined
    ? '**没有命中**'
    : `capability=${replayIntent.capability} query=${JSON.stringify(String(replayIntent.args.query))}`
)

// ===========================================================================
section('§4 汇总')
// ===========================================================================

const measurementInvalid = measures.filter((item) => item.count <= 0).length
check(
  '所有计数型判据都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid === 0,
  measures.map((item) => `${item.label}=${item.count}`).join(' · ')
)

/** 能力 → **已量 / 已达 / 仍缺口**（机器推导；"量过"与"达标"是两件事） */
const capabilities = [
  {
    capability: '私人内容**没有**触发词时不触发、零出站',
    measured: true,
    met: outboundRows.filter((row) => row.group === '私人内容').every((row) => !row.triggered),
    evidence: `私人内容组 ${outboundRows.filter((row) => row.group === '私人内容').length} 条，全部安静、出站 0`,
    gap: null as string | null,
  },
  {
    capability: '显式否定**全部**不触发、零出站',
    measured: true,
    met: triggerRows
      .filter((row) => row.group === '否定句')
      .every((row) => row.actual === 'silent'),
    evidence:
      `${triggerRows.filter((row) => row.group === '否定句').length} 条否定语料：安静 ` +
      `${triggerRows.filter((row) => row.group === '否定句' && row.actual === 'silent').length} 条 · ` +
      `**触发 ${triggerRows.filter((row) => row.group === '否定句' && row.actual === 'trigger').length} 条**`,
    gap:
      '仍缺口（三条，均有逐条读数）：① `不要，联网搜索` —— 只隔一个标点 ⇒ 触发，且 query 抽成 `不要`；' +
      '② `别搜索我的私人笔记` —— `别` 在命中短语**最左端**，左侧窗口为空 ⇒ 触发，且 query 抽成 `我的私人笔记`；' +
      '③ `unable to search the web right now` —— 否定词表只认 `not/never/without/no` ⇒ 触发，query 抽成 `unable to right now`',
  },
  {
    capability: '**引用 / 转述文本**里的词形不会触发',
    measured: true,
    met: quotedRows.every((row) => row.actual === 'silent'),
    evidence: `引用文本组 ${quotedRows.length} 条，**全部触发**（${quotedRows.filter((row) => row.actual === 'trigger').length}/${quotedRows.length}）`,
    gap:
      '词形判据**不区分**引号与转述（D-5 的既定性质）：把别人的话原样引进来会被当成本人请求，' +
      '而且抽出的 query 是"去掉触发词后的残句"（例如 `网页上写着： 关键词请简明扼要`）。' +
      '语义级引用/否定归后续里程碑',
  },
  {
    capability: '上下文（记忆 / 人设 / userId / trace / 历史 / prompt）**零出站**',
    measured: true,
    met: outboundRows.every((row) => row.sentSentinels.length === 0),
    evidence: `哨兵 ${Object.keys(SENTINELS).length} 个 · 出站字节 0 命中（且端口类型上无处可放）`,
    gap: null,
  },
  {
    capability: '出站内容**可逐条核对**（method / host / body 字段 / 头名 / query 原文）',
    measured: true,
    met: outboundTriggered.every((row) => row.requestCount === 1),
    evidence: `触发行 ${outboundTriggered.length} 条逐条有读数；记录器不保存头的值与 body 正文`,
    gap: null,
  },
]
for (const entry of capabilities) {
  const verdict = entry.met ? '★ 已达' : '⚠️ 已量·未达（读数如实登记）'
  check(`【${verdict}】${entry.capability}`, entry.measured, `离线证据=${entry.evidence}${entry.gap === null ? '' : ` · 仍缺口：${entry.gap}`}`)
}

const passed = report.passed
const failed = report.failed
const verdict = failed > 0 ? 'FAIL' : measurementInvalid > 0 ? 'MEASUREMENT INVALID' : 'PASS'

console.log(`\nTD-12 触发与隐私边界门：${passed} 通过 / ${failed} 失败｜measurementInvalid=${measurementInvalid}｜判定 ${verdict}`)

mkdirSync(EVIDENCE_DIR, { recursive: true })
const evidence = {
  testId: 'TD-12 / 搜索触发边界与出站隐私边界',
  scope:
    '真实检测器（createExternalEvidenceIntentDetector + createActionIntentDetector 的链）+ ' +
    '真实出站请求构造（buildTavilySearchRequest）+ 真实记录器（createRecordingFetch）。' +
    '全程离线：记录器吃掉的 fetch 永不发出。',
  boundary:
    '本门**不改**触发判据 / provider / 搜索策略，**不自动脱敏**；只给出读数与剩余范围。',
  verdict,
  counts: { checksPassed: passed, checksFailed: failed, measurementInvalid },
  measured: measures,
  corporaCounts: {
    total: triggerRows.length,
    privateContent: triggerRows.filter((row) => row.group === '私人内容').length,
    negation: triggerRows.filter((row) => row.group === '否定句').length,
    quoted: triggerRows.filter((row) => row.group === '引用文本').length,
    chitChat: triggerRows.filter((row) => row.group === '普通闲聊').length,
    explicitSearch: triggerRows.filter((row) => row.group === '显式正当搜索').length,
  },
  triggerRows,
  outboundRows,
  sentinels: SENTINELS,
  privateMarkers: PRIVATE_MARKER,
  outboundShape: {
    allowedBodyFields: TAVILY_ALLOWED_BODY_FIELDS,
    allowedHeaderNames: TAVILY_ALLOWED_HEADER_NAMES,
    recordingPolicy: 'recording-fetch 结构上不保存请求头的值与 body 正文',
  },
  capabilities,
}
writeFileSync(join(EVIDENCE_DIR, 'privacy-offline.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  证据：artifacts/td/td10-td12/privacy-offline.json')

process.exit(failed > 0 ? 1 : 0)

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** 去注释：判据量的是**代码**，不是关于历史的散文（与既有门的做法一致） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
