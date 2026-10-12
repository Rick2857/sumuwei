/**
 * M5.5 L1 —— **部件级测试**（`pnpm m5.5:test`）。
 *
 * ============================================================================
 *  它与 L0 量具门的分工（不要混）
 * ============================================================================
 *   `m5.5:measurement:verify`（L0）—— **判据自己可信吗**：每个检测器走
 *        正控 / 负控 / 恢复三段式，计数型判据自检 `measured_count > 0`。
 *   本文件（L1）              —— **部件本身对不对**：契约的失败关闭、
 *        引用投影的字段清单、开关的解析、适配器的三条出口、依赖方向。
 *
 * 判据**不共用代码**：这一层的期望值全部**独立写死**在文件里
 * （逐条理由码、字段清单、上界数字），实现改了而期望没改 ⇒ 这里会红。
 *
 * 💤 **完全离线**：不联网、不需要 key、**不碰数据库**、不调模型。
 * 🕒 证据里**没有时钟字段** ⇒ 重复运行逐字节相同。
 *
 * 跑法：pnpm m5.5:test
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  EVIDENCE_LIMITS,
  assertExternalEvidenceList,
  assertExternalEvidenceRef,
  buildExternalEvidenceList,
  toExternalEvidenceRef,
  toExternalEvidenceRefs,
  type ExternalEvidence,
  type SearchEvidenceItem,
} from '../src/kernel/contracts/external-evidence.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_LOCALE,
} from '../src/kernel/action/external-evidence-capability.ts'
import { validateSearchQuery } from '../src/kernel/action/search-port.ts'
import { ActionFailureError } from '../src/kernel/action/errors.ts'
import { readKernelFlags, describeKernelFlags } from '../src/kernel/app/flags.ts'
import {
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  createDefaultCapabilityRegistry,
} from '../src/kernel/action/capability-registry.ts'
import { createExternalEvidenceCapabilityDefinitions } from '../src/kernel/action/external-evidence-capability.ts'
import { createWebSearchAdapter } from '../src/infrastructure/action/adapters/web-search.ts'
import {
  FIXTURE_DEFAULT_ITEMS,
  createFixtureSearchProvider,
  fixtureEmptyOutcome,
  fixtureFailureOutcome,
  fixtureTimeoutOutcome,
} from '../src/infrastructure/search/fixture-search-provider.ts'
import { createSha256Fingerprinter } from '../src/infrastructure/search/fingerprint.ts'
import { newActionId } from '../src/kernel/contracts/ids.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.5')

// ---------------------------------------------------------------------------
// 报告器（与本仓库既有门的形状一致；本文件**不**依赖任何 harness）
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/** 去注释：判据量的是**代码**，不是关于历史的散文 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')
}

function sourceOf(relativePath: string): string {
  return stripComments(readFileSync(join(ROOT, relativePath), 'utf8'))
}

/** 确定性指纹（与基础设施的 sha256 无关：契约层只认"注入进来的函数"） */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fp${hash.toString(16).padStart(8, '0')}`
}

const NOW = 1_760_000_000_000

const LEGAL_ITEM: SearchEvidenceItem = {
  title: '合成条目一',
  url: 'https://example.com/a',
  snippet: '合成摘要一。',
}
const LEGAL_ITEM_2: SearchEvidenceItem = {
  title: '合成条目二',
  url: 'https://example.org/b',
  snippet: '合成摘要二。',
}

const build = (items: readonly SearchEvidenceItem[], provider = 'fixture') =>
  buildExternalEvidenceList({ provider, items, retrievedAt: NOW, fingerprint })

/** 逐条理由码的期望值（**独立写死**：不读实现里的 union） */
function rejectionReasonsOf(items: readonly SearchEvidenceItem[]): string[] {
  return build(items).rejections.map((item) => item.reason)
}

function rejectionReasonsWith(
  items: readonly SearchEvidenceItem[],
  custom: (text: string) => string
): string[] {
  return buildExternalEvidenceList({
    provider: 'fixture',
    items,
    retrievedAt: NOW,
    fingerprint: custom,
  }).rejections.map((item) => item.reason)
}

// ===========================================================================
section('§1 证据契约：合法输入被接受，非法输入**逐条**被拒（失败关闭 + 理由）')
// ===========================================================================

const legal = build([LEGAL_ITEM, LEGAL_ITEM_2])
check(
  '★ 正控：两条合法条目 ⇒ 0 处拒绝，标签按顺序是 E1 / E2',
  legal.rejections.length === 0 &&
    legal.evidence.map((item) => item.citationLabel).join(',') === 'E1,E2',
  `rejections=${legal.rejections.length} labels=${legal.evidence.map((item) => item.citationLabel).join(',')}`
)
check(
  '★ 确定性：同样的输入两次 ⇒ id / 标签 / 指纹逐字相同（可跨进程复核）',
  JSON.stringify(build([LEGAL_ITEM, LEGAL_ITEM_2]).evidence) === JSON.stringify(legal.evidence),
  legal.evidence[0]?.id ?? '(无)'
)
check(
  '★ id 由 provider + 指纹派生（不含时间）—— 因此"引用的是哪条"可复核',
  legal.evidence[0]?.id.includes('fixture') === true &&
    legal.evidence[0]?.id.includes(legal.evidence[0].contentFingerprint) === true,
  legal.evidence[0]?.id ?? '(无)'
)

const REJECTION_CASES: {
  label: string
  items: SearchEvidenceItem[]
  expect: string
  fingerprint?: (text: string) => string
}[] = [
  {
    label: '非 HTTPS 的来源',
    items: [{ ...LEGAL_ITEM, url: 'http://insecure.example/x' }],
    expect: 'invalid_source_uri',
  },
  { label: '空标题', items: [{ ...LEGAL_ITEM, title: '   ' }], expect: 'invalid_title' },
  {
    label: `标题超过 ${EVIDENCE_LIMITS.maxTitleLength} 字`,
    items: [{ ...LEGAL_ITEM, title: 'x'.repeat(EVIDENCE_LIMITS.maxTitleLength + 1) }],
    expect: 'title_too_long',
  },
  { label: '空摘要', items: [{ ...LEGAL_ITEM, snippet: '  ' }], expect: 'invalid_snippet' },
  {
    label: `摘要超过 ${EVIDENCE_LIMITS.maxSnippetLength} 字`,
    items: [{ ...LEGAL_ITEM, snippet: 'x'.repeat(EVIDENCE_LIMITS.maxSnippetLength + 1) }],
    expect: 'snippet_too_long',
  },
  {
    label: '重复来源（同一条 URL 两次）',
    items: [LEGAL_ITEM, { ...LEGAL_ITEM, title: '另一个标题' }],
    expect: 'duplicate_source',
  },
  /*
   * ⚠️ `duplicate_fingerprint` 这条闸要用**注入的**指纹函数才够得着：
   *    真实 sha256 指纹的输入是 `[title, url, snippet].join('\n')`（**含 URL**），
   *    所以"同标题同摘要、不同 URL"必然得到**不同**指纹 ⇒ 走的是 `duplicate_source` 一侧。
   *    第一版判据按"同标题同摘要"去撞它，于是必然报"没有被拒"——判据错了，实现是对的。
   *    这一条同时也**登记一个事实**：在真指纹下这条分支实际上只有哈希碰撞才够得着
   *    （防御性判据），它由契约**注入**的指纹函数保持可达。
   */
  {
    label: '重复指纹（注入一个常量指纹函数 ⇒ 两条不同 URL 的指纹相同）',
    items: [LEGAL_ITEM, { ...LEGAL_ITEM, url: 'https://example.com/other' }],
    expect: 'duplicate_fingerprint',
    fingerprint: () => 'constant-fingerprint',
  },
  {
    label: `条目数超过 ${EVIDENCE_LIMITS.maxEvidenceCount}`,
    items: [1, 2, 3, 4, 5, 6].map((index) => ({
      title: `条目 ${index}`,
      url: `https://example.com/${index}`,
      snippet: `摘要 ${index}`,
    })),
    expect: 'over_limit',
  },
]
for (const testCase of REJECTION_CASES) {
  const reasons =
    testCase.fingerprint === undefined
      ? rejectionReasonsOf(testCase.items)
      : rejectionReasonsWith(testCase.items, testCase.fingerprint)
  check(
    `★ 负控：${testCase.label} ⇒ 被拒且理由是 \`${testCase.expect}\``,
    reasons.includes(testCase.expect),
    reasons.join(',') || '**没有被拒**'
  )
}
check(
  '★ 被拒的条目**不静默修**：它只出现在 rejections 里，不进 evidence',
  (() => {
    const mixed = build([LEGAL_ITEM, { ...LEGAL_ITEM_2, url: 'http://insecure.example/y' }])
    return (
      mixed.evidence.length === 1 &&
      mixed.evidence[0]?.sourceUri === 'https://example.com/a' &&
      mixed.rejections.length === 1
    )
  })(),
  '合法的那条留下、非法的那条只计数'
)
check(
  '★ 非法的 provider 标识 ⇒ 整个批次被拒（不是"只丢这一条"）',
  (() => {
    const bad = build([LEGAL_ITEM], '')
    return bad.evidence.length === 0 && bad.rejections[0]?.reason === 'invalid_provider'
  })(),
  '证据为空 + invalid_provider'
)
check(
  '★ 非法的 retrievedAt（0 / 负数 / 非整数）⇒ `invalid_retrieved_at`',
  [0, -1, 1.5].every(
    (bad) =>
      buildExternalEvidenceList({
        provider: 'fixture',
        items: [LEGAL_ITEM],
        retrievedAt: bad,
        fingerprint,
      }).rejections[0]?.reason === 'invalid_retrieved_at'
  ),
  '三种非法时间都被拒'
)
check(
  '★ 空条目集合是一条**合法**结果（"查了但没有"不能被报成失败）',
  (() => {
    const empty = build([])
    return empty.evidence.length === 0 && empty.rejections.length === 0
  })(),
  '0 条证据 · 0 处拒绝'
)

// ===========================================================================
section('§2 引用投影：**唯一**的隐私边界（字段清单 + 失败关闭）')
// ===========================================================================

/**
 * 字段清单**独立写死**：这是 `D-8` 逐字要求的那几样
 * （URL / 来源 / 时间 / 指纹 / 标签 + id），**没有**标题、**没有**摘要。
 */
const REF_FIELDS = ['citationLabel', 'contentFingerprint', 'id', 'kind', 'provider', 'retrievedAt', 'source']
const ref = toExternalEvidenceRef(legal.evidence[0]!)
check(
  '★ 引用字段**恰好**是那七个 —— 没有 title、没有 snippet',
  Object.keys(ref).sort().join(',') === REF_FIELDS.join(','),
  Object.keys(ref).sort().join(',')
)
check(
  '★ 摘要正文与标题在投影里**一个字符都没有**（哨兵级）',
  !JSON.stringify(ref).includes('合成摘要') && !JSON.stringify(ref).includes('合成条目'),
  '两个都不在'
)
check(
  '★ 负控：`assertExternalEvidenceRef` 拒 http:// 来源 / 空指纹 / 非法标签',
  (() => {
    const cases: unknown[] = [
      { ...ref, source: 'http://insecure.example/x' },
      { ...ref, contentFingerprint: '' },
      { ...ref, citationLabel: 'E0' },
      { ...ref, citationLabel: 'X1' },
    ]
    return cases.every((candidate) => {
      try {
        assertExternalEvidenceRef(candidate as typeof ref)
        return false
      } catch {
        return true
      }
    })
  })(),
  '四种非法引用全被拒（失败关闭）'
)
check(
  '★ 负控：`assertExternalEvidenceList` 拒 >5 条 / 标签错序 / 标签重复',
  (() => {
    const five = build(
      [1, 2, 3, 4, 5].map((index) => ({
        title: `条目 ${index}`,
        url: `https://example.com/${index}`,
        snippet: `摘要 ${index}`,
      }))
    ).evidence
    const cases: ExternalEvidence[][] = [
      [...five, { ...five[0]!, citationLabel: 'E6' }],
      [{ ...five[0]!, citationLabel: 'E2' }],
      [five[0]!, { ...five[1]!, citationLabel: 'E1' }],
    ]
    return cases.every((candidate) => {
      try {
        assertExternalEvidenceList(candidate)
        return false
      } catch {
        return true
      }
    })
  })(),
  '三种非法列表全被拒'
)
check(
  '★ `toExternalEvidenceRefs` 是**纯映射**（保序、条数不变）',
  (() => {
    const refs = toExternalEvidenceRefs(legal.evidence)
    return (
      refs.length === legal.evidence.length &&
      refs.map((item) => item.citationLabel).join(',') === 'E1,E2'
    )
  })(),
  '2 → 2'
)

// ===========================================================================
section('§3 上界是**冻结数字**（改了这里就是改了契约）')
// ===========================================================================

const FROZEN_LIMITS = {
  maxQueryLength: 256,
  minResultLimit: 1,
  maxResultLimit: 5,
  defaultResultLimit: 5,
  maxEvidenceCount: 5,
  maxTitleLength: 200,
  maxSnippetLength: 600,
  maxSourceUriLength: 2048,
  maxFingerprintLength: 64,
} as const
check(
  '★ `EVIDENCE_LIMITS` 的九个数字逐条等于冻结值',
  Object.entries(FROZEN_LIMITS).every(
    ([key, value]) => (EVIDENCE_LIMITS as unknown as Record<string, number>)[key] === value
  ),
  Object.entries(FROZEN_LIMITS)
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ')
)
check(
  '★ 适配器的缺省 limit / locale 就是能力声明里那两个常量（只有一处定义）',
  DEFAULT_SEARCH_LIMIT === EVIDENCE_LIMITS.defaultResultLimit && DEFAULT_SEARCH_LOCALE === 'zh-CN',
  `${DEFAULT_SEARCH_LIMIT} / ${DEFAULT_SEARCH_LOCALE}`
)
check(
  '★ 追加登记后 **4 个能力**；M4.5 的默认集仍然恰好 3 个（`D-11` 没有被顺手破坏）',
  createDefaultCapabilityRegistry().list().length === 3 &&
    createCapabilityRegistry([
      ...createDefaultCapabilityDefinitions(),
      ...createExternalEvidenceCapabilityDefinitions(),
    ]).list().length === 4,
  '默认 3 · 追加后 4'
)

// ===========================================================================
section('§4 请求校验：三条都有正负两侧（它在**发请求之前**失败关闭）')
// ===========================================================================

check(
  '★ 正控：合法请求 ⇒ 0 处问题',
  validateSearchQuery({ query: '量子计算', limit: 5, locale: 'zh-CN' }).length === 0,
  '0 处'
)
const QUERY_CASES: { label: string; input: Parameters<typeof validateSearchQuery>[0]; }[] = [
  { label: '空查询', input: { query: '   ', limit: 5, locale: 'zh-CN' } },
  { label: `查询超过 ${EVIDENCE_LIMITS.maxQueryLength} 字`, input: { query: 'x'.repeat(257), limit: 5, locale: 'zh-CN' } },
  { label: 'limit = 0', input: { query: 'x', limit: 0, locale: 'zh-CN' } },
  { label: 'limit = 6（超过上限）', input: { query: 'x', limit: 6, locale: 'zh-CN' } },
  { label: 'limit 不是整数', input: { query: 'x', limit: 2.5, locale: 'zh-CN' } },
  { label: 'locale 形状不对（zh_CN）', input: { query: 'x', limit: 5, locale: 'zh_CN' } },
  { label: 'locale 形状不对（空串）', input: { query: 'x', limit: 5, locale: '' } },
]
for (const testCase of QUERY_CASES) {
  check(
    `★ 负控：${testCase.label} ⇒ 至少一个问题`,
    validateSearchQuery(testCase.input).length > 0,
    validateSearchQuery(testCase.input).join(' / ') || '**没有报问题**'
  )
}
/*
 * ⚠️ **特征化（如实登记，不是"测试通过"）**：端口文档写着"查询词**不接受 URL**"，
 *    但 `validateSearchQuery` 今天**只**校验"非空 + 长度" —— 一段 URL 形态的查询词
 *    会被照常接受并送出。这里把这个**实际行为**钉住，免得它被误读成"已经拦住了"。
 *    （它是不是缺陷取决于判据：查询词里出现 URL 只是"用户想搜这个字符串"，
 *      真正的 SSRF 面由 endpoint 是代码常量封住。登记给 WP10 的已知局限。）
 */
const urlLikeAccepted = validateSearchQuery({ query: 'https://example.com/a', limit: 5, locale: 'zh-CN' })
check(
  '★（特征化 · 已知局限）URL 形态的查询词**被接受** —— 端口文档里"不接受 URL"今天没有机器判据',
  urlLikeAccepted.length === 0,
  `validateSearchQuery 返回 ${urlLikeAccepted.length} 处问题（0 = 放行）`
)

// ===========================================================================
section('§5 适配器：三条出口 + 失败原样抛出 + 零调用（离线 fixture）')
// ===========================================================================

const adapterInput = {
  actionId: newActionId(),
  operation: 'search',
  target: { type: 'external_service' as const, canonicalId: 'fixture-offline', confidence: 'exact' as const },
  args: { query: '量子计算', limit: 5, locale: 'zh-CN' },
  now: () => NOW,
}
const adapterWith = (respond: Parameters<typeof createFixtureSearchProvider>[0]) =>
  createWebSearchAdapter({
    provider: createFixtureSearchProvider(respond),
    fingerprint: createSha256Fingerprinter(),
  })

const successOutcome = await adapterWith({ id: 'fixture-offline', items: FIXTURE_DEFAULT_ITEMS }).execute(adapterInput)
check(
  '★ 出口 ①：两条合法条目 ⇒ `content_read` + 2 条证据 + 3 行账本证据（头 + 每条一个引用）',
  successOutcome.effect?.kind === 'content_read' &&
    successOutcome.externalEvidence?.length === 2 &&
    successOutcome.evidence?.length === 3,
  `effect=${successOutcome.effect?.kind} evidence=${successOutcome.externalEvidence?.length} rows=${successOutcome.evidence?.length}`
)
check(
  '★ 账本行里只有**引用**（没有 snippet、没有 title、没有摘要正文）',
  (() => {
    const text = JSON.stringify(successOutcome.evidence ?? [])
    return !text.includes('snippet') && !text.includes('合成摘要') && !text.includes('示例文档')
  })(),
  '引用在、正文不在'
)
const partialOutcome = await adapterWith({
  id: 'fixture-offline',
  items: [{ title: '非 HTTPS', url: 'http://insecure.example/x', snippet: '摘要' }],
}).execute(adapterInput)
check(
  '★ 出口 ②：有条目但一条都没形成证据 ⇒ **partial**（不许压成 success）',
  partialOutcome.partial !== undefined &&
    partialOutcome.partial.completed === 0 &&
    partialOutcome.partial.total === 1 &&
    (partialOutcome.externalEvidence ?? []).length === 0,
  `completed=${partialOutcome.partial?.completed}/${partialOutcome.partial?.total}`
)
const emptyOutcome = await adapterWith({
  id: 'fixture-offline',
  respond: () => fixtureEmptyOutcome(),
}).execute(adapterInput)
check(
  '★ 出口 ③：0 条目 ⇒ `no_change`（"查了但没有结果"，不是失败、也不是 partial）',
  emptyOutcome.effect?.kind === 'no_change' &&
    emptyOutcome.partial === undefined &&
    (emptyOutcome.externalEvidence ?? []).length === 0 &&
    emptyOutcome.effect?.detail?.includes('无结果') === true,
  emptyOutcome.effect?.detail ?? '(无 effect)'
)

const failureCases: { label: string; respond: Parameters<typeof createFixtureSearchProvider>[0]; expect: string }[] = [
  { label: 'provider 超时', respond: { respond: () => fixtureTimeoutOutcome(20) }, expect: 'timeout' },
  { label: 'provider 执行失败', respond: { respond: () => fixtureFailureOutcome('上游 500') }, expect: 'execution_failed' },
]
for (const testCase of failureCases) {
  const code = await (async (): Promise<string> => {
    try {
      await adapterWith({ id: 'fixture-offline', ...testCase.respond }).execute(adapterInput)
      return 'no-throw'
    } catch (error) {
      return error instanceof ActionFailureError ? error.failure.code : `other:${String(error)}`
    }
  })()
  check(`★ ${testCase.label} ⇒ \`ActionFailureError\` 且码是 \`${testCase.expect}\``, code === testCase.expect, code)
}

const VALIDATION_CASES: { label: string; args: Record<string, unknown> }[] = [
  { label: '空查询', args: { query: '   ', limit: 5, locale: 'zh-CN' } },
  { label: 'locale 形状不对', args: { query: 'x', limit: 5, locale: 'zh_CN' } },
]
/*
 * ⚠️ **特征化**：`args.limit` 越界时适配器**夹住**（`readLimit` = Math.min/max 到 1..5），
 *    而不是失败关闭 —— 参数层夹取、请求层才失败关闭（`validateSearchQuery` 对 limit=9 会拒）。
 *    第一版判据期待它抛 `validation_failed`，于是必然报红：判据错了，实现是对的。
 *    这里把"provider 收到的是**夹住后**的 5"钉住。
 */
const clampedLimitCalls = await (async (): Promise<number | undefined> => {
  const provider = createFixtureSearchProvider({ id: 'fixture-offline', items: FIXTURE_DEFAULT_ITEMS })
  const adapter = createWebSearchAdapter({ provider, fingerprint: createSha256Fingerprinter() })
  await adapter.execute({ ...adapterInput, args: { query: '量子计算', limit: 9, locale: 'zh-CN' } })
  return provider.calls()[0]?.limit
})()
check(
  '★（特征化）`args.limit = 9` ⇒ 被**夹到** 5 再送出（参数层夹取，不是失败关闭）',
  clampedLimitCalls === EVIDENCE_LIMITS.maxResultLimit,
  `provider 收到的 limit = ${String(clampedLimitCalls)}`
)
for (const testCase of VALIDATION_CASES) {
  const probe = await (async (): Promise<{ code: string; calls: number }> => {
    const provider = createFixtureSearchProvider({ id: 'fixture-offline', items: FIXTURE_DEFAULT_ITEMS })
    const adapter = createWebSearchAdapter({ provider, fingerprint: createSha256Fingerprinter() })
    try {
      await adapter.execute({ ...adapterInput, args: testCase.args })
      return { code: 'no-throw', calls: provider.callCount() }
    } catch (error) {
      return {
        code: error instanceof ActionFailureError ? error.failure.code : 'other',
        calls: provider.callCount(),
      }
    }
  })()
  check(
    `★ ${testCase.label} ⇒ \`validation_failed\` 且 provider **零调用**（不合法就不发请求）`,
    probe.code === 'validation_failed' && probe.calls === 0,
    `code=${probe.code} calls=${probe.calls}`
  )
}

// ===========================================================================
section('§6 开关：env → flags 的解析逐条（缺省 / 真值词 / 夹取 / 坏值）')
// ===========================================================================

const flagsOf = (env: Record<string, string>) =>
  readKernelFlags(env as NodeJS.ProcessEnv)

check(
  '★ 缺省：`CHARACTER_WEB_SEARCH_ENABLED` 未设 ⇒ **false**（联网默认关闭）',
  flagsOf({}).webSearchEnabled === false,
  'false'
)
const TRUTHY = ['1', 'true', 'TRUE', ' yes ', 'on']
const FALSY = ['0', 'false', 'no', 'off', '  off  ']
check(
  '★ 真值词 5 个 ⇒ true；假值词 5 个 ⇒ false（大小写与空格都容忍）',
  TRUTHY.every((value) => flagsOf({ CHARACTER_WEB_SEARCH_ENABLED: value }).webSearchEnabled === true) &&
    FALSY.every((value) => flagsOf({ CHARACTER_WEB_SEARCH_ENABLED: value }).webSearchEnabled === false),
  `${TRUTHY.join('/')} → true · ${FALSY.join('/')} → false`
)
check(
  '★ 坏值（`yes please` / `2`）⇒ **退回缺省 false**（不猜、也不当成打开）',
  ['yes please', '2', 'enable'].every(
    (value) => flagsOf({ CHARACTER_WEB_SEARCH_ENABLED: value }).webSearchEnabled === false
  ),
  '三种坏值都退回 false'
)
check(
  '★ 额度缺省 = **800**（有界 0..2000）',
  flagsOf({}).webSearchEvidenceTokens === 800,
  String(flagsOf({}).webSearchEvidenceTokens)
)
check(
  '★ 额度上下界：`9999` ⇒ 夹到 **2000**；`-5` ⇒ 夹到 **0**（夹住而不是静默接受）',
  flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: '9999' }).webSearchEvidenceTokens === 2000 &&
    flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: '-5' }).webSearchEvidenceTokens === 0,
  `9999→${flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: '9999' }).webSearchEvidenceTokens} · -5→${flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: '-5' }).webSearchEvidenceTokens}`
)
check(
  '★ 额度坏值（`abc` / `3.5`）⇒ 退回缺省 800',
  ['abc', '3.5'].every(
    (value) => flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: value }).webSearchEvidenceTokens === 800
  ),
  '两种坏值都退回 800'
)
check(
  '★ 摘要里能一眼看出这个开关（排查入口）',
  describeKernelFlags(flagsOf({})).includes('web-search'),
  'web-search 出现在摘要里'
)
check(
  '★ 开关被 `main.ts` **真的消费**：flag off ⇒ 证据额度传 0（不是"传了但没人用"）',
  (() => {
    const main = sourceOf('src/main.ts')
    /*
     * 实际形状（2026-09-22 之后）：
     *   `recallBudget: { ...DEFAULT_CONTEXT_BUDGET, ...(this.flags.webSearchEnabled
     *      ? { externalEvidenceTokens: this.flags.webSearchEvidenceTokens } : {}), rollupTokens: … }`
     * —— 守卫是"`externalEvidenceTokens` 只在 `webSearchEnabled` 为真时才进了那个展开对象"。
     *
     * ⚠️ 这道锁 2026-09-22 修正过一次（TD 类）：M6 的 `19b394a` 把 `rollupTokens` 追加进
     *    `recallBudget` 之后，**三元式的字面形状变了**，而旧正则写死了
     *    `recallBudget:\s*this\.flags\.webSearchEnabled\s*\?` ⇒ 旧断言开始报红。
     *    那是**判据太脆**，不是"开关没被消费"（同一个 flag 仍在那一行上做守卫）。
     *    现在按"条件 + 展开 + 同一行上的额度"判，**不**规定展开里的字段顺序或个数，
     *    但仍然要求：① 守卫存在 ② 额度来自 flags ③ 两者在同一行上。
     */
    return /this\.flags\.webSearchEnabled\s*\?[\s\S]{0,200}?externalEvidenceTokens:\s*this\.flags\.webSearchEvidenceTokens/.test(
      main
    )
  })(),
  '`recallBudget: { … (this.flags.webSearchEnabled ? { externalEvidenceTokens: this.flags.webSearchEvidenceTokens } : {}) … }`'
)

// ===========================================================================
section('§7 依赖方向与静态锁（M5.5 的 kernel 文件不认识基础设施）')
// ===========================================================================

const KERNEL_M55_FILES = [
  'src/kernel/contracts/external-evidence.ts',
  'src/kernel/action/external-evidence-capability.ts',
  'src/kernel/action/external-evidence-intent.ts',
  'src/kernel/action/external-evidence-reply.ts',
  'src/kernel/action/search-port.ts',
]
const FORBIDDEN_IN_KERNEL = ['node:', 'drizzle-orm', '@elizaos/', 'infrastructure/', 'opentelemetry', 'phoenix']
for (const file of KERNEL_M55_FILES) {
  const text = sourceOf(file)
  const hits = FORBIDDEN_IN_KERNEL.filter((token) => text.includes(token))
  check(
    `★ 依赖方向：${file.split('/').pop()} 不 import 基础设施 / node:* / 框架`,
    hits.length === 0,
    hits.join(',') || '0 处'
  )
}
check(
  '★ 指纹由**基础设施注入**：契约层里没有 `node:crypto`（也没有自己实现 sha256）',
  !sourceOf('src/kernel/contracts/external-evidence.ts').includes('createHash') &&
    sourceOf('src/infrastructure/search/fingerprint.ts').includes('createHash'),
  '契约只声明 ContentFingerprinter'
)
const SEARCH_MODULES = [
  'src/infrastructure/search/fingerprint.ts',
  'src/infrastructure/search/fixture-search-provider.ts',
  'src/infrastructure/search/recording-fetch.ts',
  'src/infrastructure/search/tavily-config.ts',
  'src/infrastructure/search/tavily-search-provider.ts',
]
/*
 * ⚠️ 2026-09-22（ADR-054）：**唯一**允许读环境变量的是 `tavily-config.ts` ——
 *    Tavily 需要 key，而 key 只能从环境变量来（ADR-046 `D-25`/`D-27`）。
 *    provider / 记录器 / fixture / 指纹都**不许**碰 `process.env`：
 *    凭证由配置层读一次、注入给 provider，出站层因此没有第二个"读 env"的地方。
 *    判据不是"全都禁"，而是"**只有那一个，且只有那两个具名变量**"。
 */
const CONFIG_MODULE = 'src/infrastructure/search/tavily-config.ts'
check(
  '★ 出站层没有任何日志（日志最多报"有没有"，不报取值）；只有配置模块读 env',
  SEARCH_MODULES.every((file) => {
    const text = sourceOf(file)
    if (text.includes('console.') || text.includes('logger')) return false
    return file === CONFIG_MODULE ? text.includes('process.env') : !text.includes('process.env')
  }),
  `${SEARCH_MODULES.length} 个文件：0 处 console / logger · env 读取仅限 tavily-config.ts`
)
check(
  '★ 配置模块只读**两个具名**变量（不是"扫一遍 env"）',
  (() => {
    const text = sourceOf(CONFIG_MODULE)
    /*
     * 实现形状是**具名常量** + 唯一一次读取：
     *   `const envName = isTestMode ? TAVILY_TEST_API_KEY_ENV : TAVILY_API_KEY_ENV`
     *   `const apiKey = input.apiKey ?? (env[envName] ?? '').trim()`
     * ⚠️ 第一版这条判据只认字面量 `env['NAME']`（那正好是 SearXNG 时代的形状），
     *    于是它对**更好的**写法报假红。现在两面都断言：常量名**在**、字面量下标**不在**
     *    （后者才是"扫一遍 env"或"多读一个变量"的形态）。
     */
    const hasNamedConstants =
      text.includes("TAVILY_API_KEY_ENV = 'M55_TAVILY_SEARCH_API_KEY'") &&
      text.includes("TAVILY_TEST_API_KEY_ENV = 'M55_TAVILY_SEARCH_TEST_API_KEY'")
    const hasNoLiteralEnvSubscript = !/env\[['"]/.test(text)
    const singleNamedRead = (text.match(/env\[envName\]/g) ?? []).length === 1
    return hasNamedConstants && hasNoLiteralEnvSubscript && singleNamedRead
  })(),
  '两个具名常量在场 · 无字面量 env 下标 · 恰好一次 env[envName]'
)
check(
  '★ 静态清单：搜索层**恰好**这五个实现文件（没有第二个 provider 悄悄长出来）',
  readdirSync(join(ROOT, 'src', 'infrastructure', 'search')).sort().join(',') ===
    SEARCH_MODULES.map((file) => file.split('/').pop()).sort().join(','),
  readdirSync(join(ROOT, 'src', 'infrastructure', 'search')).sort().join(', ')
)
check(
  '★ 只有 `main.ts` 能构造真实 provider：其它 src 文件里没有 `createTavilySearchProvider`',
  (() => {
    /*
     * ⚠️ 两个坑：① `readdirSync(recursive)` 在 Windows 上给的是 `a\\b\\c.ts`，
     *    用 `/` 过滤会失败 ⇒ 必须先归一化；② `main.ts` 自己**应当**提到它
     *    （它就是装配层），provider 模块自己当然也提到 —— 两者要显式排除。
     */
    const offenders = readdirSync(join(ROOT, 'src'), { recursive: true })
      .map((entry) => String(entry).split('\\').join('/'))
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) => entry !== 'main.ts')
      .filter((entry) => !entry.endsWith('infrastructure/search/tavily-search-provider.ts'))
      .filter((entry) => sourceOf(join('src', entry)).includes('createTavilySearchProvider'))
    return offenders.length === 0
  })(),
  '装配层 + provider 自身之外 0 处'
)

// ===========================================================================
// 证据
// ===========================================================================

const evidence = {
  testId: 'M5.5 / L1 component tests (offline · no DB · no key · no model)',
  note:
    '判据的期望值全部**独立写死**在本文件里（逐条理由码 / 字段清单 / 上界数字 / env 真值词）。' +
    '证据里**没有时钟字段** ⇒ 重复运行逐字节相同。本门不碰数据库、不联网、不调模型。',
  passed,
  failed,
  failures,
  checks,
  contracts: {
    rejectionReasons: REJECTION_CASES.map((item) => item.expect),
    refFields: REF_FIELDS,
    frozenLimits: FROZEN_LIMITS,
  },
  flags: {
    defaultEnabled: flagsOf({}).webSearchEnabled,
    defaultTokens: flagsOf({}).webSearchEvidenceTokens,
    clampedHigh: flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: '9999' }).webSearchEvidenceTokens,
    clampedLow: flagsOf({ CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS: '-5' }).webSearchEvidenceTokens,
  },
  knownLimitations: [
    'URL 形态的查询词会被 validateSearchQuery 放行 —— 端口文档里"不接受 URL"今天没有机器判据（已特征化）。',
  ],
}
mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'component.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\nM5.5 L1 部件级测试：${passed} 通过 / ${failed} 失败`)
console.log(`  证据：artifacts/m5.5/component.json`)
process.exit(failed > 0 ? 1 : 0)
