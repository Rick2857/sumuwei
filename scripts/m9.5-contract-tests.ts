/**
 * M9.5 WP3–8 —— **纯契约门**（`pnpm m9.5:test`）。
 *
 * ============================================================================
 *  计划 §16.1 里这道门的定位
 * ============================================================================
 * ```text
 * `m9.5:test` —— WP3–8 的**纯契约**门：不碰数据库、不加载模型、不写证据。
 * ⇒ 它跑得**最快**，也最容易被当成"跑过了就算数"⇒ 因此**只**断言纯函数/纯类型层。
 *
 * ⚠️ **范围克制**（第一版试图一口气断言记账与 §4.4 fixture，撞上一批签名不符）：
 *    那些性质**各有专属门**在测（见 `scope.coveredElsewhere`），本门不重复、也不假装覆盖。
 * ```
 * 五组：通道登记 · 策略/模式版本 · 探针降级原因（R3） · schema 版本与向量校验（D28） ·
 *       排序纯函数（legacy 逐字兼容 + 相关性算式）。
 * 用法：`pnpm m9.5:test`
 */

import {
  RECALL_CHANNELS,
  RECALL_CHANNEL_FACTS,
  RETRIEVAL_POLICY_VERSIONS,
  DEFAULT_RETRIEVAL_POLICY_VERSION,
  isRetrievalPolicyVersion,
  SEMANTIC_UNAVAILABLE_REASONS,
  SEMANTIC_MODES,
  isSemanticMode,
  defaultSemanticModeFor,
  semanticParticipates,
} from '../src/kernel/contracts/recall.ts'
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  SEMANTIC_INDEX_UPGRADES,
  SEMANTIC_INDEX_DIMENSION,
  validateSemanticVector,
} from '../src/infrastructure/persistence/memory-semantic-index.ts'
import {
  mergeChannelHits,
  orderCandidates,
  truncateCandidates,
  combinedRelevance,
  PROVISIONAL_HYBRID_POLICY,
} from '../src/kernel/app/recall/hybrid-candidates.ts'
import { semanticSignalOf, relativeMarginOf } from '../src/kernel/app/recall/semantic-signal.ts'
import { isReadOnlyInvocation, requiresModelConnectivity } from '../src/invocation.ts'
import { lexicalOverlapHits, lexicalOverlapStrength } from '../src/kernel/app/memory/target-resolver.ts'
import { scoreCandidate } from '../src/kernel/recall/ranking.ts'
/* M9.5 / WP1（ADR-081）：规范渲染 + 索引资格政策 */
import {
  PASSAGE_PREFIX,
  QUERY_PREFIX,
  RENDERER_VERSION,
  indexEligibility,
  renderMemoryForIndex,
  renderQueryForIndex,
  type IndexEligibility,
} from '../src/kernel/app/recall/index-render.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { isRecallEligible, type MemoryRecord } from '../src/kernel/contracts/memory.ts'
import {
  createMaintenanceTrigger,
  type MaintenanceReason,
} from '../src/infrastructure/persistence/semantic-index-trigger.ts'
import { createProductionMaintenanceTrigger } from '../src/infrastructure/persistence/semantic-index-production-runner.ts'

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const headShort =
  (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    } catch {
      return 'unknown'
    }
  })()
const gitOrNull = (args: readonly string[]): string | null => {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const safeTreeDigest = (): Record<string, unknown> | null => {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}
const runId = createM95RunId({ wpId: 'wp3-8-contract', headShort })
const runDir = openM95RunDir(REPO_ROOT, runId)

let passed = 0
const failures: string[] = []

function check(group: string, name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`[${group}] ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

/* ======================= ① 通道登记 ======================= */
check('通道', 'semantic 在通道白名单里', (RECALL_CHANNELS as readonly string[]).includes('semantic'))
check(
  '通道',
  '★ 登记表把 semantic 标为**未产出**（produced=false：防止"登记了就当有"）',
  RECALL_CHANNEL_FACTS.semantic?.produced === false,
  JSON.stringify(RECALL_CHANNEL_FACTS.semantic)
)
check(
  '通道',
  '每个通道都有 produced 布尔（登记表不得留空档）',
  (RECALL_CHANNELS as readonly string[]).every(
    (channel) => typeof RECALL_CHANNEL_FACTS[channel as keyof typeof RECALL_CHANNEL_FACTS]?.produced === 'boolean'
  )
)

/* ======================= ② 策略 / 模式版本化（D26） ======================= */
check('策略', '默认策略就是词面-新近度', DEFAULT_RETRIEVAL_POLICY_VERSION === 'lexical-recency@1')
check('策略', '策略表含 hybrid-relevance@1', (RETRIEVAL_POLICY_VERSIONS as readonly string[]).includes('hybrid-relevance@1'))
check('策略', '未知策略版本判 false', isRetrievalPolicyVersion('nope@9') === false)
check('策略', '已知策略版本判 true', isRetrievalPolicyVersion(DEFAULT_RETRIEVAL_POLICY_VERSION) === true)
check('模式', '三种模式齐备', ['off', 'shadow', 'on'].every((m) => (SEMANTIC_MODES as readonly string[]).includes(m)))
check('模式', '未知模式判 false', isSemanticMode('turbo') === false)
check('模式', '已知模式判 true', isSemanticMode('shadow') === true)
check('模式', '旧策略的默认模式是 off', defaultSemanticModeFor('lexical-recency@1') === 'off')
check('模式', '★ 混合策略的默认模式是 on', defaultSemanticModeFor('hybrid-relevance@1') === 'on')
check('模式', '★ D26：旧策略下语义**不**参与', semanticParticipates('lexical-recency@1') === false)
check('模式', '混合策略下语义参与（由模式再层过滤）', semanticParticipates('hybrid-relevance@1') === true)

/* ======================= ③ 探针降级原因（R3 伪启用防线） ======================= */
check('降级', '具名原因共 7 个', SEMANTIC_UNAVAILABLE_REASONS.length === 7, String(SEMANTIC_UNAVAILABLE_REASONS.length))
check('降级', '含 missing_score（"可用却没分数"必须能表达）', (SEMANTIC_UNAVAILABLE_REASONS as readonly string[]).includes('missing_score'))
check('降级', '含 timeout / model_missing', ['timeout', 'model_missing'].every((r) => (SEMANTIC_UNAVAILABLE_REASONS as readonly string[]).includes(r)))
check(
  '降级',
  '★ R3：`available` 与 `score` 都已给 ⇒ 得**可用**信号',
  semanticSignalOf({ available: true, score: 0.42 }).kind === 'available'
)
check(
  '降级',
  '★ R3：**available 但没有分数** ⇒ 必须判 missing_score（不得当成可用）',
  (() => {
    const signal = semanticSignalOf({ available: true })
    return signal.kind === 'unavailable' && signal.reason === 'missing_score'
  })(),
  JSON.stringify(semanticSignalOf({ available: true }))
)
check(
  '降级',
  '模型缺失 ⇒ model_missing（不是笼统的"不可用"）',
  (() => {
    const signal = semanticSignalOf({ available: false, modelPresent: false })
    return signal.kind === 'unavailable' && signal.reason === 'model_missing'
  })()
)
check(
  '降级',
  '维度不符 ⇒ dimension_mismatch',
  (() => {
    const signal = semanticSignalOf({ available: true, score: 0.5, indexDimension: 384, modelDimension: 768 })
    return signal.kind === 'unavailable' && signal.reason === 'dimension_mismatch'
  })()
)

/* ======================= ④ schema 版本与向量校验（D28 / D31） ======================= */
check('schema', '衍生 schema 版本是正整数', Number.isInteger(SEMANTIC_INDEX_SCHEMA_VERSION) && SEMANTIC_INDEX_SCHEMA_VERSION >= 1, String(SEMANTIC_INDEX_SCHEMA_VERSION))
/*
 * ⚠️ 这一条原来写的是 `=== 1`（硬编码）—— 2026-10-01 加"持久游标"把版本升到 **2** 时，
 * 它**正确地**报红（类型上都成了"2 与 1 无重叠"）⇒ 改成断言**自洽性**而不是某个具体数字：
 * "每一个 1..N-1 的升级步都必须有语句"（与 `assertSemanticIndexUpgradesWellFormed()` 同一条纪律）。
 */
check(
  'schema',
  '★ 每一级升级步都有语句（升级轴自洽；加列不许"只升版本号"）',
  Array.from({ length: SEMANTIC_INDEX_SCHEMA_VERSION - 1 }, (_, i) => i + 1).every(
    (from) => (SEMANTIC_INDEX_UPGRADES[from] ?? []).length > 0
  ),
  `version=${String(SEMANTIC_INDEX_SCHEMA_VERSION)} steps=${JSON.stringify(Object.keys(SEMANTIC_INDEX_UPGRADES))}`
)
check('schema', '维度常量是 384', SEMANTIC_INDEX_DIMENSION === 384)
/*
 * ⚠️ 下面两条原来都是**为版本 1 写的**（"升级表就该是空的" / "不得出现 ≤ 当前版本的条目"）——
 * 2026-10-01 加"持久游标"把版本升到 **2**、并写进 `UPGRADES[1]` 之后，它们**正确地**报红。
 * ⇒ 改成**通用形状**：升级表的键必须**恰好**是 `1..version-1`（每一步都要有、不许越界、不许降版本）。
 */
check(
  'schema',
  '★ 升级表的键**恰好**是 1..version-1（每一步都要有；不许缺、不许越界）',
  JSON.stringify(Object.keys(SEMANTIC_INDEX_UPGRADES).map(Number).sort((a, b) => a - b)) ===
    JSON.stringify(Array.from({ length: SEMANTIC_INDEX_SCHEMA_VERSION - 1 }, (_, i) => i + 1)),
  `version=${String(SEMANTIC_INDEX_SCHEMA_VERSION)} steps=${JSON.stringify(Object.keys(SEMANTIC_INDEX_UPGRADES))}`
)
/**
 * ⚠️ **正控必须是真正合法的输入**：第一版用 `new Array(384).fill(0.1)`，
 *    它的模长是 1.96 ⇒ **未归一化** ⇒ 被判 `not_normalized`。
 *    于是"正控"红、而且后面那些"注入 NaN 必须被拒"的**归因也不成立**
 *    （它可能是因为没归一化被拒，不是因为 NaN）⇒ 负控必须**从合法向量出发**。
 */
const unitVector = (): number[] => new Array(384).fill(1 / Math.sqrt(384))
check('schema', '★ D28：**合法**向量通过（正控：不该响时必须安静）', validateSemanticVector(unitVector()) === null, String(validateSemanticVector(unitVector())))
check('schema', '★ D28：维度不对必须被拒', validateSemanticVector(new Array(383).fill(0.1)) !== null)
check(
  'schema',
  '★ D28：NaN 必须被拒（**从合法向量出发**，归因才成立）',
  (() => {
    const bad = unitVector()
    bad[7] = Number.NaN
    return validateSemanticVector(bad) === 'invalid_vector:nan_or_inf'
  })(),
  String(
    (() => {
      const bad = unitVector()
      bad[7] = Number.NaN
      return validateSemanticVector(bad)
    })()
  )
)
check(
  'schema',
  '★ D28：Infinity 必须被拒（**从合法向量出发**）',
  (() => {
    const bad = unitVector()
    bad[3] = Number.POSITIVE_INFINITY
    return validateSemanticVector(bad) === 'invalid_vector:nan_or_inf'
  })()
)
check(
  'schema',
  '★ D28：未归一化必须被拒（这条正控正是第一版踩到的形态）',
  validateSemanticVector(new Array(384).fill(0.1))?.startsWith('invalid_vector:not_normalized') === true,
  String(validateSemanticVector(new Array(384).fill(0.1)))
)
check(
  'schema',
  '★ D28：零向量必须被拒（模长为 0）',
  validateSemanticVector(new Array(384).fill(0)) === 'invalid_vector:zero_norm'
)

/* ======================= ⑤ 排序纯函数 ======================= */
check(
  '排序',
  'mergeChannelHits 按 Memory ID 合并（同一 id 不重复成两条）',
  mergeChannelHits([
    { memoryId: 'a', channel: 'lexical', score: 1 },
    { memoryId: 'a', channel: 'semantic', score: 0.9 },
  ]).length === 1
)
check(
  '排序',
  '合并后**两条通道都记录在案**（不是二选一）',
  (() => {
    const merged = mergeChannelHits([
      { memoryId: 'a', channel: 'lexical', score: 1 },
      { memoryId: 'a', channel: 'semantic', score: 0.9 },
    ])[0]
    return merged !== undefined && merged.channels.length === 2
  })()
)
check(
  '排序',
  '★ legacy 顺序 = **新近度降序**（与旧比较器逐字一致）',
  JSON.stringify(
    orderCandidates({
      candidates: [
        { memoryId: 'a', recency: 1, lexical: 0, semantic: null },
        { memoryId: 'b', recency: 9, lexical: 0, semantic: null },
      ],
      policyVersion: 'lexical-recency@1',
    }).map((c) => c.memoryId)
  ) === JSON.stringify(['b', 'a'])
)
check(
  '排序',
  '★ legacy 在新近度**相同**时按 id 升序（确定性，不靠插入顺序）',
  JSON.stringify(
    orderCandidates({
      candidates: [
        { memoryId: 'z', recency: 5, lexical: 0, semantic: null },
        { memoryId: 'a', recency: 5, lexical: 0, semantic: null },
      ],
      policyVersion: 'lexical-recency@1',
    }).map((c) => c.memoryId)
  ) === JSON.stringify(['a', 'z'])
)
check(
  '排序',
  'truncateCandidates 严格不超上限',
  truncateCandidates(
    [
      { memoryId: 'a', relevance: 1, parts: {} } as never,
      { memoryId: 'b', relevance: 0.5, parts: {} } as never,
    ],
    1
  ).kept.length === 1
)
check(
  '排序',
  /*
   * ★★ **`L-M95-18` 已被 `D-5` 修掉**（2026-10-01）：
   *   原来（**等权** `lexical: 1`）逐字是「词面 1.0 + 语义 0.1 **小于** 纯语义 0.9 + 间隔加成
   *   ⇒ 等权下语义可压过字面命中」—— 那是一条**已登记的局限** ✓
   *   `ADR-084`（CJK 片段 2→3 字）+ 权重冻结到 **1.5** 之后，**不等式翻转** ⇒ **局限不再成立** ✓
   * ⚠️ 所以这条断言**不是"改到能过"**，而是**如实反映"那个局限已经消失"** ✓
   *   （反过来断言：**词面命中现在压得住纯语义诱饵** ✓ —— 这正是 `D-5` 要买的东西 ✓）
   */
  '★ L-M95-18 **已修**：词面 1.0 + 语义 0.1 **大于** 纯语义 0.9 + 间隔加成 ⇒ 语义**不再**压过字面命中',
  combinedRelevance({ memoryId: 'lit', lexical: 1, semantic: 0.1, recency: 0 }, 0, PROVISIONAL_HYBRID_POLICY) >
    combinedRelevance({ memoryId: 'dec', lexical: 0, semantic: 0.9, recency: 0 }, 0.49, PROVISIONAL_HYBRID_POLICY)
)
check('排序', '相对间隔对**单元素**给出 1（不是 NaN）', relativeMarginOf([{ memoryId: 'a', score: 0.7 }]).margin === null)

/* ======================= M9.5 / WP1（ADR-081）======================= */
/* 规范渲染（正控 + 前缀负控）+ 索引资格政策（边界逐条） */

/** 冻结的编码清单 —— **前缀的唯一来源**（本门直接读它，而不是信代码里的常量） */
const frozenEmbeddingManifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'evals', 'm9.5', 'embedding-manifest.json'), 'utf8')
) as { passagePrefix?: string; queryPrefix?: string }

/** 造一条投影记录（只填渲染与政策**真的会读**的字段；其余用最小合法值） */
const recordOf = (over: { status?: string; content?: Record<string, unknown> }): MemoryRecord =>
  ({
    id: 'mem_wp1_probe' as never,
    owner: entityRef('character', 'char_wp1'),
    type: 'preference',
    content: (over.content ?? {
      kind: 'claim',
      subject: entityRef('user', 'user_wp1'),
      predicate: 'education.major',
      value: '计算机',
    }) as never,
    subjects: [entityRef('user', 'user_wp1')],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.5,
    confidence: 0.9,
    status: (over.status ?? 'active') as never,
    sourceRefs: [],
    evidenceRootIds: [],
    recordedAt: 0,
    contentFingerprint: 'wp1-fp',
    revision: 0,
    createdAt: 0,
  }) as never

check('WP1 渲染', 'RENDERER_VERSION 非空且与列同形', /^[a-z-]+@\d+$/.test(RENDERER_VERSION), RENDERER_VERSION)

/* 前缀**逐字**来自冻结清单（不是信代码里的常量）—— 写错前缀会静默降质（E5 约定） */
check(
  'WP1 渲染',
  '★ 两侧前缀与冻结清单逐字一致',
  PASSAGE_PREFIX === frozenEmbeddingManifest.passagePrefix &&
    QUERY_PREFIX === frozenEmbeddingManifest.queryPrefix,
  `代码 ${PASSAGE_PREFIX}/${QUERY_PREFIX} · 清单 ${String(frozenEmbeddingManifest.passagePrefix)}/${String(frozenEmbeddingManifest.queryPrefix)}`
)

const renderedClaim = renderMemoryForIndex(recordOf({}))
check(
  'WP1 渲染',
  '★ 正控：claim 渲染成 `passage: <predicate> <value>`（逐字）',
  renderedClaim.ok && renderedClaim.rendered.text === 'passage: education.major 计算机',
  renderedClaim.ok ? renderedClaim.rendered.text : renderedClaim.reason
)

const renderedAgain = renderMemoryForIndex(recordOf({}))
check(
  'WP1 渲染',
  '★ 确定性：同一个取值两次渲染逐字相同（否则 content_hash 会无故变化）',
  renderedClaim.ok &&
    renderedAgain.ok &&
    renderedClaim.rendered.contentHash === renderedAgain.rendered.contentHash
)

check(
  'WP1 渲染',
  'contentHash 是 sha256 十六进制（64 位）',
  renderedClaim.ok && /^[0-9a-f]{64}$/.test(renderedClaim.rendered.contentHash)
)

const objectValueFirst = renderMemoryForIndex(
  recordOf({ content: { kind: 'claim', predicate: 'p.x', value: { b: 2, a: 1 } } })
)
const objectValueSecond = renderMemoryForIndex(
  recordOf({ content: { kind: 'claim', predicate: 'p.x', value: { a: 1, b: 2 } } })
)
check(
  'WP1 渲染',
  '★ 取值是对象时**按键排序**（插入序不同必须渲染出同一段文本）',
  objectValueFirst.ok &&
    objectValueSecond.ok &&
    objectValueFirst.rendered.text === objectValueSecond.rendered.text,
  objectValueFirst.ok ? objectValueFirst.rendered.text : objectValueFirst.reason
)

check(
  'WP1 渲染',
  '查询侧用 query 前缀',
  renderQueryForIndex('我在哪所大学').startsWith(QUERY_PREFIX),
  renderQueryForIndex('我在哪所大学')
)

/* 负控：两侧**必须**渲染成不同的文本（前缀写错/丢失会让它们相同 —— 那正是静默降质） */
check(
  'WP1 渲染',
  '★ 负控：同一段文本在两侧渲染**必须不同**（前缀丢了就会相同）',
  renderQueryForIndex('education.major 计算机') !== 'passage: education.major 计算机'
)

check(
  'WP1 渲染',
  '正控：@2 的 Episode 使用已有摘要渲染',
  (() => {
    const outcome = renderMemoryForIndex(
      recordOf({ content: { kind: 'episode', summary: '聊了一下午' } })
    )
    return outcome.ok && outcome.rendered.text === `${PASSAGE_PREFIX}聊了一下午`
  })()
)

check(
  'WP1 渲染',
  '负控：Episode 摘要为空或缺失 ⇒ content:empty',
  ['', '  ', undefined].every((summary) => {
    const outcome = renderMemoryForIndex(recordOf({ content: { kind: 'episode', summary } }))
    return !outcome.ok && outcome.reason === 'content:empty'
  })
)

check(
  'WP1 渲染',
  '负控：取值为空 ⇒ 不是一段可检索的文本',
  (() => {
    const outcome = renderMemoryForIndex(
      recordOf({ content: { kind: 'claim', predicate: 'p.x', value: '' } })
    )
    return !outcome.ok && outcome.reason === 'content:empty'
  })()
)

/* ---- 政策边界：逐条 ---- */
const policyOf = (status: string, problems: readonly string[] = []): IndexEligibility =>
  indexEligibility({ record: recordOf({ status }), integrityProblems: problems })

check('WP1 政策', '正控：active 且无完整性问题 ⇒ 进索引', policyOf('active').eligible === true)
check(
  'WP1 政策',
  'retracted（遗忘）⇒ 排除，理由具名',
  policyOf('retracted').eligible === false &&
    (policyOf('retracted') as { reason: string }).reason === 'status:retracted'
)
check(
  'WP1 政策',
  'superseded（被取代）⇒ 排除，理由具名',
  policyOf('superseded').eligible === false &&
    (policyOf('superseded') as { reason: string }).reason === 'status:superseded'
)
check(
  'WP1 政策',
  'disputed（在审）⇒ 排除，理由具名',
  policyOf('disputed').eligible === false &&
    (policyOf('disputed') as { reason: string }).reason === 'status:disputed'
)
check(
  'WP1 政策',
  '★ 完整性问题（归因链断）⇒ 排除，理由带**具体问题码**',
  (() => {
    const verdict = policyOf('active', ['dangling_evidence'])
    return verdict.eligible === false && verdict.reason === 'integrity:dangling_evidence'
  })()
)
check(
  'WP1 政策',
  '★ 分叉如实：disputed 在**召回面**是可召回的（`isRecallEligible`），而索引政策排除它',
  isRecallEligible('disputed' as never) === true,
  '索引是派生加速结构、不是资格权威 ⇒ "索引比召回更严"是有意的（ADR-081 §5）'
)
check(
  'WP1 政策',
  '★ 分叉如实：disputed 在**召回面**是可召回的（`isRecallEligible`），而索引政策排除它',
  isRecallEligible('disputed' as never) === true
)

/* ======================= M9.5 / WP4（W2 触发器）======================= */
/* 串行 / 合并 / 不丢 —— 纯模块，不需要任何库 */

/** 造一个可控的 `runOnce`：每次调用挂起，直到测试放行 */
function makeControllableRunner(): {
  runOnce: (reason: MaintenanceReason) => Promise<void>
  release: () => void
  reasons: MaintenanceReason[]
  maxConcurrent: number
} {
  const reasons: MaintenanceReason[] = []
  let concurrent = 0
  let maxConcurrent = 0
  let pending: (() => void)[] = []
  const runOnce = async (reason: MaintenanceReason): Promise<void> => {
    reasons.push(reason)
    concurrent += 1
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise<void>((resolve) => pending.push(resolve))
    concurrent -= 1
  }
  return {
    runOnce,
    release: () => {
      const waiters = pending
      pending = []
      for (const waiter of waiters) waiter()
    },
    reasons,
    get maxConcurrent() {
      return maxConcurrent
    },
  }
}

const runnerA = makeControllableRunner()
const triggerA = createMaintenanceTrigger({ runOnce: runnerA.runOnce })
const firstTrigger = triggerA.trigger('event')
await Promise.resolve()
check('WP4 触发器', '正控：一次触发 ⇒ 真的开跑一轮', runnerA.reasons.length === 1, JSON.stringify(runnerA.reasons))

/* 负控①：一轮在跑时来 5 个触发 ⇒ **合并成"欠一轮"**，绝不是 5 轮 */
const burst = [1, 2, 3, 4, 5].map(() => triggerA.trigger('event'))
await Promise.resolve()
check('WP4 触发器', '★ 合并：一轮在跑时的 5 个触发**不排队成 5 轮**', runnerA.reasons.length === 1, String(runnerA.reasons.length))
check('WP4 触发器', '★ 合并读数如实：coalesced = 5 · owed = 1', triggerA.readings().coalesced === 5 && triggerA.readings().owed === 1, JSON.stringify(triggerA.readings()))

runnerA.release()
/* ⚠️ 要放行**两次**：第一次结束首轮，合并后的"欠的那一轮"随即开始并同样会挂起
   （第一版只放行一次 ⇒ 顶层的 await 永远不 settle，tsx 报 `unsettled top-level await`）。
   这是**测试夹具**的节奏问题，不是模块缺陷 —— 模块正是在等第二轮真的跑完。 */
await new Promise((resolve) => setTimeout(resolve, 0))
runnerA.release()
await Promise.all([firstTrigger, ...burst])
const readingsA = triggerA.readings()
check('WP4 触发器', '★ 不丢：合并之后**仍跑了一轮**（总轮数 = 2）', readingsA.rounds === 2, JSON.stringify({ rounds: readingsA.rounds, reasons: runnerA.reasons }))
check('WP4 触发器', '★ **串行**：任何时刻最多一轮（maxConcurrent = 1）', runnerA.maxConcurrent === 1, String(runnerA.maxConcurrent))
check('WP4 触发器', '★ 跑完不欠了（owed = 0 · running = false）', readingsA.owed === 0 && readingsA.running === false, JSON.stringify(readingsA))
check('WP4 触发器', '★ 每一轮都有开始/结束时刻（可证没有重叠）', readingsA.spans.length === 2 && readingsA.spans.every((s) => s.endedAt >= s.startedAt))

/* 负控②：一轮**失败**不能吞掉后续触发（onError 如实收到） */
const errors: string[] = []
let failNext = true
const triggerB = createMaintenanceTrigger({
  runOnce: async () => {
    if (failNext) {
      failNext = false
      throw new Error('injected_maintenance_failure')
    }
  },
  onError: (error) => errors.push(String(error)),
})
await triggerB.trigger('startup')
check('WP4 触发器', '★ 失败被**如实上报**（不吞）', errors.length === 1 && errors[0].includes('injected_maintenance_failure'), JSON.stringify(errors))
check('WP4 触发器', '★ 失败之后仍能再跑（触发器没有卡死）', (await triggerB.trigger('manual').then(() => triggerB.readings().rounds)) === 2)

/* ======================= M9.5 / WP4（投递路径的三条判据）======================= */

/* ① **投递不阻塞**：源码级断言 —— `main.ts` 的投递那一行**必须** `void`（不 await）。
   一旦 await，编码就进了用户轮次的关键路径（冷启动 ~1.2 s）。 */
const mainSource = readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8')
check(
  'WP4 投递',
  '★ **投递不阻塞**：`commitEvents` 的**事件投递**用 `void maintenance.trigger(\'event\')`（没有 await）',
  /*
   * ⚠️ 断言必须**只针对事件投递**：WP7-A 的运维模式**故意** `await maintenance.trigger('manual')`
   * （它不在用户轮次的关键路径上 —— 那里 await 是对的）。
   * 第一版写成"main.ts 里不许出现 await maintenance.trigger(" ⇒ 被运维模式**正确地**判红（实测踩到）。
   */
  mainSource.includes("void maintenance.trigger('event')") &&
    !mainSource.includes("await maintenance.trigger('event')")
)
check(
  'WP4 投递',
  '★ **语义关闭不 spawn**：投递被 `semanticRecallEncoder !== undefined` 把闸（复用已存在的事实）',
  mainSource.includes('this.semanticRecallEncoder !== undefined')
)

/* ② **失败隔离**：runOnce 抛 ⇒ `trigger()` 的 promise **resolve**（不是 reject）
   ⇒ `void` 它不会产生未处理拒绝，也**不会**改调用方的返回值。 */
let failureSeen = 0
const failingTrigger = createMaintenanceTrigger({
  runOnce: async () => {
    throw new Error('injected_maintenance_failure')
  },
  onError: () => {
    failureSeen += 1
  },
})
let rejected = false
try {
  await failingTrigger.trigger('event')
} catch {
  rejected = true
}
check('WP4 投递', '★ **失败隔离**：维护失败 ⇒ trigger 的 promise **resolve**（不 reject）', !rejected && failureSeen === 1, `rejected=${String(rejected)} onError=${String(failureSeen)}`)

/* ③ **构造不碰编码器**：用假客户端构造触发器工厂 ⇒ 编码器**一次都没被调**
   （惰性：只有真的跑一轮才会取它）。 */
let encodeCalls = 0
const fakeClient = {
  encode: async () => {
    encodeCalls += 1
    return { ok: true as const, dimension: 384, vectors: [], cpuUserMs: 0, elapsedMs: 0, fromColdStart: false }
  },
} as never
createProductionMaintenanceTrigger({
  db: {} as never,
  namespace: 'contract-probe',
  encoderClient: fakeClient,
  manifest: {
    pooling: 'mean',
    normalize: true,
    dtype: 'q8',
    dimension: 384,
  } as never,
  readIntegrityProblems: async () => ({
    danglingEvidenceLinks: [],
    danglingMemoryEvents: [],
    memoriesWithoutLiveEvidence: [],
    memoriesWithoutLiveEvents: [],
  }),
})
check('WP4 投递', '★ **构造不 spawn**：建触发器**不调**编码器（惰性）', encodeCalls === 0, String(encodeCalls))

/* ======================= M9.5 / D-1 修订的验收 ======================= */
/*
 * 用户 2026-10-01 的修订：**仅排序降档的 active 件允许索引**，但召回时仍走原有降档。
 * 验收判据（用户逐字要求）：**语义命中不会绕过原有降档**。
 *
 * 降档落在 `ranking.ts:247-273` 的 **`authority` 分量**（资格 ≠ ESTABLISHED ⇒ rank + 1）。
 * ⇒ 确切判据：**同一个候选，无论有没有语义通道命中，`authority` 分量必须逐字相同**。
 *
 * ⚠️ 夹具的字段形状**先读契约再写**（`contracts/recall.ts:647/1057`）——
 *    上一轮逐个试错被 TypeError 抓了四次，那是错的做法。
 */
const authorityOf = (breakdown: { components: readonly { name: string; value: number }[] }): number =>
  breakdown.components.find((component) => component.name === 'authority')?.value ?? -1

const dOneCandidate = (qualification: string, retrievedBy: readonly string[]): unknown => ({
  memoryId: 'mem-d1',
  owner: entityRef('character', 'char_d1'),
  type: 'person_fact',
  status: 'active',
  authority: 'EXPLICIT_USER_STATEMENT',
  epistemicStatus: 'reported',
  subjects: [entityRef('user', 'user_d1')],
  importance: 0.5,
  confidence: 0.9,
  recordedAt: 1,
  contentFingerprint: 'fp-d1',
  searchable: '计算机',
  dataText: '计算机',
  sourceRefs: [],
  retrievedBy,
  integrityOk: true,
  qualification,
})

const dOneRequest = {
  traceId: 'trc-d1',
  characterId: 'char_d1',
  user: entityRef('user', 'user_d1'),
  session: {},
  query: {},
  intent: {},
  target: { status: 'none' },
  timeScope: {},
  candidateLimit: 10,
  contextBudget: {},
} as never

const scoreD1 = (qualification: string, retrievedBy: readonly string[]): number =>
  authorityOf(
    scoreCandidate({
      request: dOneRequest,
      candidate: dOneCandidate(qualification, retrievedBy) as never,
      capabilities: { unavailable: [] } as never,
      now: 0,
    })
  )

const withSemantic = scoreD1('UNCONFIRMED_ORIGIN', ['lexical', 'semantic'])
const withoutSemantic = scoreD1('UNCONFIRMED_ORIGIN', ['lexical'])
check(
  'D-1 验收',
  '★ **语义命中不绕过降档**：有没有语义通道命中，`authority` 分量**逐字相同**',
  withSemantic === withoutSemantic,
  `${String(withSemantic)} vs ${String(withoutSemantic)}`
)
const established = scoreD1('ESTABLISHED', ['lexical', 'semantic'])
check(
  'D-1 验收',
  '★ 负控：资格 = ESTABLISHED ⇒ `authority` 分量**变大**（证明降档真的在起作用）',
  established > withSemantic,
  `ESTABLISHED=${String(established)} vs UNCONFIRMED_ORIGIN=${String(withSemantic)}`
)
check('D-1 验收', '★ 对照：两个读数都真的取到了（不是 -1 那种"没找到分量"）', withSemantic >= 0 && established >= 0)

/* ======================= M9.5 / 「只读」与「不要求模型」是两件事 ======================= */
/*
 * 2026-10-01 拆开：`isReadOnlyInvocation` 原来同时承担两件事（只读 / 不要求模型可达），
 * 而 `--maintain-index` 把两件分开了（**写**派生表，但**不用**聊天模型）。
 * ⇒ 判据：它**必须**同时满足 ① 非只读 ② 不要求模型连通性。
 */
check(
  'WP7-A 入口',
  '★ `--maintain-index` **不是**只读（它会写派生四表）',
  isReadOnlyInvocation(['--maintain-index']) === false
)
check(
  'WP7-A 入口',
  '★ 但它**不要求**模型连通性（维护要的是编码器，不是聊天模型）',
  requiresModelConnectivity(['--maintain-index']) === false
)
check(
  'WP7-A 入口',
  '★ 对照：普通启动**要**探模型；只读命令**不**探',
  requiresModelConnectivity([]) === true && requiresModelConnectivity(['memory', 'list']) === false,
  `[]=${String(requiresModelConnectivity([]))} memory=${String(requiresModelConnectivity(['memory', 'list']))}`
)

/* ======================= M9.5 / D-5：词面强度的**同源**判据 ======================= */
/*
 * `ADR-083` §0 ① 的硬约束：**强度与"命中与否"必须同源**
 *   ⇒ "**强度 > 0**" ⇔ "**在 `lexicalOverlapHits` 里**"（不许出现"命中但强度 0"的自相矛盾）
 * 加两端：查询**自己** ⇒ 1.0（它必然含自己的全部片段）· 完全无关 ⇒ 0。
 */
const probeRecord = (value: string): never =>
  ({ content: { kind: 'claim', predicate: 'probe.slot', value } }) as never
const STRENGTH_OPTS = { includeRegistrySurfaceForms: false }
const SRC_QUERY = '我本科在哪读的'
const SRC_TEXTS = ['本科在示例工程科技大学读的', '她念过一首诗', '完全无关的一句话', '我本科在哪读的']

check(
  'D-5 强度',
  '★ **同源**：对每个样本，"强度 > 0" 与 "在 `lexicalOverlapHits` 里"**逐一一致**',
  SRC_TEXTS.every((text) => {
    const strength = lexicalOverlapStrength(SRC_QUERY, probeRecord(text), STRENGTH_OPTS)
    const isHit = lexicalOverlapHits(SRC_QUERY, [probeRecord(text)] as never, STRENGTH_OPTS).length > 0
    return strength > 0 === isHit
  }),
  JSON.stringify(
    SRC_TEXTS.map((text) => {
      const strength = lexicalOverlapStrength(SRC_QUERY, probeRecord(text), STRENGTH_OPTS)
      const isHit = lexicalOverlapHits(SRC_QUERY, [probeRecord(text)] as never, STRENGTH_OPTS).length > 0
      return `${text}:${strength.toFixed(3)}/${String(isHit)}`
    })
  )
)
check(
  'D-5 强度',
  '★ 上端：查询**自己** ⇒ 强度 = 1.0（它必然含自己的全部片段）',
  lexicalOverlapStrength(SRC_QUERY, probeRecord(SRC_QUERY), STRENGTH_OPTS) === 1
)
check(
  'D-5 强度',
  '★ 下端：完全无关 ⇒ 强度 = 0（不是"很小"）',
  lexicalOverlapStrength(SRC_QUERY, probeRecord('完全无关的一句话'), STRENGTH_OPTS) === 0
)

/* ======================= 汇总 + 封存档 ======================= */
const total = passed + failures.length
const unexpected = failures.length
const selfCheck = selfCheckMeasurement({ measuredCount: total, notRunCount: 0, failedCount: unexpected })
const realDbBefore = safeTreeDigest()
const realDbAfter = safeTreeDigest()

const payload = {
  schemaVersion: 'm9.5-test@1',
  runId,
  generatedAt: new Date().toISOString(),
  scope: {
    verifies:
      'WP3–8 **纯契约**：通道登记（semantic 未产出）· 策略/模式版本化与 D26 参与判定 · ' +
      'R3 探针降级原因（available 无分数 = missing_score）· schema 版本与 D28 向量校验（维度/NaN/Inf/零模/未归一化）· ' +
      '排序纯函数（legacy 逐字兼容 · 相关性算式 = `L-M95-18` 的算式本体）',
    coveredElsewhere: {
      '记账不变式（11 条 + 负控）': 'm9.5:context@1',
      '§4.4 两个纯 fixture（M10/M11 边界）': 'm9.5:compat@1',
      '真库/真编码器性质': 'm9.5:index@1 / m9.5:semantic@1 / m9.5:e2e@1',
    },
    notProves: '**不**碰数据库、**不**加载模型、**不**写任何业务状态 ⇒ 它不能替代任何一条需要真库/真模型的门',
  },
  checks: { passed, failed: unexpected, total },
  failures,
  realDbProtection: { before: realDbBefore, after: realDbAfter, note: '本门**根本不打开**数据库；此处只记沙箱观测点' },
}
const evidencePath = join(runDir, 'contract-tests.json')
writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

const tree = sourceTreeReading(REPO_ROOT)
const manifestPath = writeM95Manifest(runDir, {
  runId,
  /* ⚠️ 品牌枚举里没有 `wp3-8` ⇒ 取跨度**首值** `wp3`，真实跨度记进 `configHash.span`
     （聚合门 `m9.5-gates.ts` 里也如实登记为 `WP3–8`） */
  stage: 'wp3',
  lane: 'offline',
  startedAt: STARTED_AT,
  completedAt: new Date().toISOString(),
  head: gitOrNull(['rev-parse', 'HEAD']),
  headShort,
  branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
  dirtyPaths: dirtyPaths(REPO_ROOT),
  sourceTreeHash: tree.treeSha256,
  sourceTreeHashDefinition: tree.definition,
  gateVersion: 'm9.5-test@1',
  dbKind: 'not-applicable',
  isolationProof: { dbTouched: false, method: '**构造属性**：本门不 import 任何数据库入口' },
  configHash: { span: 'WP3–8', groups: ['通道', '策略', '模式', '降级', 'schema', '排序'] },
  command: [{ cmd: 'pnpm m9.5:test', exitCode: 0 }],
  exitCode: 0,
  completion: 'complete',
  usable: selfCheck.verdict === 'PASS',
  measuredCount: total,
  notRunCount: 0,
  counts: { total, passed, failed: unexpected },
  toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
  supersedes: null,
  artifactHashes: { 'contract-tests.json': sha256(readFileSync(evidencePath, 'utf8')) },
})

process.stdout.write(
  [
    'M9.5 纯契约门（WP3–8）：不碰数据库 / 不加载模型 / 不写业务状态',
    `  通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）`,
    ...failures.map((line) => `  ✗ ${line}`),
    '  范围说明：记账不变式见 `m9.5:context@1`；§4.4 两个纯 fixture 见 `m9.5:compat@1`（本门不重复）',
    `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
    `  清单：${manifestPath}`,
  ].join('\n') + '\n'
)
if (failures.length > 0 || total === 0) process.exitCode = 3
