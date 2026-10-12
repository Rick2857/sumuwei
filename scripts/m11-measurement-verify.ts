/**
 * M11 WP9 —— **量具有效性门**（`m11:measurement:verify`）。
 *
 * ============================================================================
 *  它为什么必须存在（AGENTS §6.2/§6.3 逐字）
 * ============================================================================
 * ```text
 * 「任何 Hard Gate 都要同时证明"测量范围正确"与"测量结果正确"」
 * 「正控 + 负控必须同时存在。只测"不该写的时候不写"，系统可以靠"什么都不做"通过」
 * ```
 * ⇒ 本门对 M11 的**四个核心判定器**各做三段式：
 *     正控（合法输入 ⇒ 判定器安静且与独立参照一致）
 *     负控（**对抗输入**：一个朴素/有缺陷的实现会给出**不同**答案 ⇒ 判定器必须抓住它）
 *     恢复（回到合法输入 ⇒ 重新安静）
 *
 * ============================================================================
 *  ⚠️ 负控怎么写才不是"装样子"
 * ============================================================================
 * 对**纯函数**判定器，"注入缺陷"不能靠改源文件（那会让门依赖真实工作树的字节）。
 * 本门的做法是**差分**：把**朴素实现**（naive）与**被测判定器**放在同一输入上比：
 * ```text
 *   朴素实现 = "数节点" / "≥1 根就算" / "有状态就渲染" / "永不遮蔽"
 *   ⇒ 负控断言：**朴素实现给出的答案与被测判定器不同**，且被测判定器给出的是**正确**那一个。
 *   ⇒ 如果哪天被测判定器退化成朴素实现，负控立刻红（因为两者答案变得相同）。
 * ```
 * 这比"人工植入缺陷再还原"更稳（不碰工作树），而且**可证伪**：断言里写明了
 * "朴素实现应当给出什么"，读证据的人能自己验算。
 *
 * ⚠️ 零模型调用、零出网、零数据库（全部是纯函数）。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import { expandLineage } from '../src/kernel/app/reflection/lineage.ts'
import { meetsStabilityThreshold } from '../src/kernel/app/reflection/inputs.ts'
import { renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import { reflectionContentMustBeMasked } from '../src/kernel/app/reflection/masking.ts'
import { baselineAdaptiveSelfState } from '../src/kernel/contracts/adaptive-self.ts'
import type {
  LineageConversationReading,
  LineageHandle,
  LineageLookup,
  LineageMemoryReading,
} from '../src/kernel/contracts/reflection-lineage.ts'
import {
  M11_SCENARIOS,
  checkScenarioRegistry,
  scenarioCoverage,
} from '../evals/m11/scenario-registry.ts'
import {
  REFLECTION_CORPUS_FAMILIES,
  REFLECTION_CORPUS_PLAN,
  REFLECTION_CORPUS_SPLITS,
  buildReflectionCorpus,
  buildReflectionCorpusManifest,
} from '../evals/m11/reflection-corpus.ts'
import { REFLECTION_DRAFT_REJECTION_REASONS } from '../src/kernel/contracts/reflection.ts'
import { createHash } from 'node:crypto'

const REPO_ROOT = resolve(process.cwd())
const CH = 'char_m11_measurement'

interface Check {
  id: string
  judge: string
  part: 'positive' | 'negative' | 'recovery' | 'self'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(
  id: string,
  judge: string,
  part: Check['part'],
  label: string,
  pass: boolean,
  detail: string
): void {
  checks.push({ id, judge, part, label, pass, detail })
}

// ---------------------------------------------------------------------------
// 判定器 1：派生链去重（`D05`）
// ---------------------------------------------------------------------------

const conversations: LineageConversationReading[] = [
  { id: 'ce:1', characterId: CH, conversationId: 'conv-A', actorType: 'user' },
  { id: 'ce:2', characterId: CH, conversationId: 'conv-B', actorType: 'user' },
]
const memories: LineageMemoryReading[] = [
  { id: 'mem:A', characterId: CH, evidenceConversationEventIds: ['ce:1'] },
]
const lookup: LineageLookup = {
  async findConversationEvents(ids) {
    return conversations.filter((row) => ids.includes(row.id))
  },
  async findDomainEvents() {
    return []
  },
  async findMemories(ids) {
    return memories.filter((row) => ids.includes(row.id))
  },
  async findBeliefs(ids) {
    return ids.includes('bel:1')
      ? [{ id: 'bel:1', characterId: CH, evidenceRootIds: ['ce:1'], dependsOnMemoryIds: [] }]
      : []
  },
}

/** **朴素实现**：把每个节点都当成一个根（这正是 `D05` 要防的退化） */
function naiveRootCount(handles: readonly LineageHandle[]): number {
  return handles.length
}

// ---------------------------------------------------------------------------
// 判定器 2：稳定门槛（`D10`）
// ---------------------------------------------------------------------------

/** **朴素实现**：有根就算达标 */
function naiveThreshold(rootCount: number): boolean {
  return rootCount >= 1
}

// ---------------------------------------------------------------------------
// 判定器 3：额度 0 ⇒ 不渲染（`D20`）
// ---------------------------------------------------------------------------

const enhancedState = {
  ...baselineAdaptiveSelfState('clarify_when_ambiguous'),
  level: 'enhanced' as const,
  revision: 1,
}
const quantify = (text: string): number => text.length

/** **朴素实现**：有状态就渲染（忽略额度） */
function naiveRenderCount(maxTokens: number): number {
  void maxTokens
  return 1
}

// ---------------------------------------------------------------------------
// 判定器 4：遮蔽（§6.3）
// ---------------------------------------------------------------------------

/** **朴素实现**：永不遮蔽 */
function naiveMasked(): boolean {
  return false
}

/** 稳定序列化（键排序）—— 指纹可复算的前提 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  // -------------------------------------------------------------------------
  // 判定器 1：去重
  // -------------------------------------------------------------------------
  const legalHandles: LineageHandle[] = [
    { kind: 'memory', id: 'mem:A' },
    { kind: 'belief', id: 'bel:1' },
  ]
  const legalLineage = await expandLineage(lookup, legalHandles, { characterId: CH })
  record(
    'M1',
    'lineage-dedup',
    'positive',
    '【正控】合法输入：`mem:A(ce:1)` + `bel:1(ce:1)` ⇒ 有效根 **1**（派生节点 2 不算根）',
    legalLineage.rootCount === 1 && legalLineage.derivedNodeCount === 2,
    `rootCount=${String(legalLineage.rootCount)} · derived=${String(legalLineage.derivedNodeCount)}`
  )
  record(
    'M2',
    'lineage-dedup',
    'negative',
    '【负控·差分】同一输入上**朴素实现**（数节点）会给出 **2** —— 与被测判定器的 1 **不同**（若判定器退化成朴素实现，这条立刻红）',
    naiveRootCount(legalHandles) === 2 && legalLineage.rootCount === 1,
    `朴素=${String(naiveRootCount(legalHandles))} · 被测=${String(legalLineage.rootCount)}`
  )
  const recoveredLineage = await expandLineage(
    lookup,
    [{ kind: 'conversation_event', id: 'ce:1' }],
    { characterId: CH }
  )
  record(
    'M3',
    'lineage-dedup',
    'recovery',
    '【恢复】回到单根合法输入 ⇒ 判定器安静且与朴素实现**一致**（1 = 1）',
    recoveredLineage.rootCount === 1 && naiveRootCount([{ kind: 'conversation_event', id: 'ce:1' }]) === 1,
    `被测=${String(recoveredLineage.rootCount)} · 朴素=1`
  )

  // -------------------------------------------------------------------------
  // 判定器 2：稳定门槛
  // -------------------------------------------------------------------------
  const legalVerdict = meetsStabilityThreshold({
    rootCount: 3,
    conversationCount: 2,
    unresolvedConflict: false,
  })
  record(
    'M4',
    'stability-threshold',
    'positive',
    '【正控】3 根 / 2 会话 / 无冲突 ⇒ 达标',
    legalVerdict.met === true,
    `met=${String(legalVerdict.met)}`
  )
  const adversarialVerdict = meetsStabilityThreshold({
    rootCount: 2,
    conversationCount: 5,
    unresolvedConflict: false,
  })
  record(
    'M5',
    'stability-threshold',
    'negative',
    '【负控·差分】2 根输入：**朴素实现**（≥1 根就算）会说达标，被测判定器**拒绝**（`threshold_not_met`）',
    naiveThreshold(2) === true &&
      adversarialVerdict.met === false &&
      adversarialVerdict.reason === 'threshold_not_met',
    `朴素=${String(naiveThreshold(2))} · 被测=${adversarialVerdict.met ? 'met' : adversarialVerdict.reason}`
  )
  const recoveredVerdict = meetsStabilityThreshold({
    rootCount: 3,
    conversationCount: 2,
    unresolvedConflict: false,
  })
  record(
    'M6',
    'stability-threshold',
    'recovery',
    '【恢复】回到 3 根 / 2 会话 ⇒ 重新达标（与正控同值）',
    recoveredVerdict.met === true,
    `met=${String(recoveredVerdict.met)}`
  )

  // -------------------------------------------------------------------------
  // 判定器 3：额度 0
  // -------------------------------------------------------------------------
  const zeroBudget = renderAdaptiveSelfSection({
    states: [enhancedState],
    maxTokens: 0,
    quantify,
  })
  record(
    'M7',
    'adaptive-section-budget',
    'positive',
    '【正控】额度 0 ⇒ **0 个 section**（`D20`）',
    zeroBudget.length === 0,
    `sections=${String(zeroBudget.length)}`
  )
  record(
    'M8',
    'adaptive-section-budget',
    'negative',
    '【负控·差分】同一输入上**朴素实现**（有状态就渲染）会给 **1** —— 与被测判定器的 0 不同',
    naiveRenderCount(0) === 1 && zeroBudget.length === 0,
    `朴素=${String(naiveRenderCount(0))} · 被测=${String(zeroBudget.length)}`
  )
  const recoveredBudget = renderAdaptiveSelfSection({
    states: [enhancedState],
    maxTokens: 300,
    quantify,
  })
  record(
    'M9',
    'adaptive-section-budget',
    'recovery',
    '【恢复】额度 300 ⇒ 重新渲染 1 个 section（与朴素实现一致）',
    recoveredBudget.length === 1,
    `sections=${String(recoveredBudget.length)}`
  )

  // -------------------------------------------------------------------------
  // 判定器 4：遮蔽
  // -------------------------------------------------------------------------
  const cleanMask = reflectionContentMustBeMasked({
    status: 'accepted',
    roots: ['ce:1'],
    rootVerdicts: [{ rootId: 'ce:1', usable: true }],
  })
  record(
    'M10',
    'masking',
    'positive',
    '【正控】来源都可用 ⇒ **不**遮蔽（判定器安静）',
    cleanMask.mask === false,
    `mask=${String(cleanMask.mask)}`
  )
  const adversarialMask = reflectionContentMustBeMasked({
    status: 'accepted',
    roots: ['ce:1', 'ce:2'],
    rootVerdicts: [
      { rootId: 'ce:1', usable: true },
      { rootId: 'ce:2', usable: false, reason: 'source_forgotten' },
    ],
  })
  record(
    'M11',
    'masking',
    'negative',
    '【负控·差分】有根被忘：**朴素实现**（永不遮蔽）说 `false`，被测判定器说 `true`（`withdrawn_source`）',
    naiveMasked() === false && adversarialMask.mask === true && adversarialMask.reason === 'withdrawn_source',
    `朴素=${String(naiveMasked())} · 被测=${adversarialMask.mask ? adversarialMask.reason : 'false'}`
  )
  const recoveredMask = reflectionContentMustBeMasked({
    status: 'accepted',
    roots: ['ce:1'],
    rootVerdicts: [{ rootId: 'ce:1', usable: true }],
  })
  record(
    'M12',
    'masking',
    'recovery',
    '【恢复】回到可用来源 ⇒ 重新安静（与朴素实现一致，都是 `false`）',
    recoveredMask.mask === false,
    `mask=${String(recoveredMask.mask)}`
  )

  // -------------------------------------------------------------------------
  // 恒空实现必须 FAIL（S50）
  // -------------------------------------------------------------------------
  const constantEmpty = { rootCount: 0, derivedNodeCount: 0 }
  record(
    'M13',
    'constant-empty',
    'negative',
    '【负控·恒空】"恒空实现"（永远 0 根）在**合法正例**上给出 0 —— 而正控要求 **1** ⇒ 它必然 FAIL',
    constantEmpty.rootCount !== legalLineage.rootCount && legalLineage.rootCount === 1,
    `恒空=${String(constantEmpty.rootCount)} · 正控=${String(legalLineage.rootCount)}`
  )

  // -------------------------------------------------------------------------
  // 场景登记册（WP9 的 64 场景覆盖）
  // -------------------------------------------------------------------------
  const registryChecks = checkScenarioRegistry()
  const coverage = scenarioCoverage()
  record(
    'M14',
    'scenario-registry',
    'self',
    '【登记册】S01–S64 齐全、分组正确、**未跑必有具名理由**、标了实现的必有证据',
    registryChecks.every((check) => check.ok),
    registryChecks.map((check) => check.detail).join(' · ')
  )
  record(
    'M15',
    'scenario-registry',
    'self',
    '【覆盖读数】实现 / 未跑**分列**（不合成一个"通过率"），且未跑的都**归因到后续包或人审/真模型/长链/激活**',
    coverage.implemented.length > 0 &&
      coverage.notRun.length > 0 &&
      M11_SCENARIOS.filter((entry) => entry.disposition === 'not_run').every((entry) =>
        /*
         * ⚠️ 判据作用域（第一版漏了 WP9）：这条的意图是"未跑必须归因到**后面的**包或
         *    人/模型门"，而第一版的枚举只写了 WP10/WP12 —— 于是 S59（离线长轨迹，
         *    归 **WP9 的下一步**）被误判成"没有归因"。⇒ 枚举补齐 WP9–WP12。
         */
        /WP9|WP10|WP11|WP12|人审|真模型|长链|激活/.test(entry.notRunReason ?? '')
      ),
    `实现=${String(coverage.implemented.length)} · 未跑=${String(coverage.notRun.length)} · 分组=${JSON.stringify(coverage.byFamily)}`
  )

  // -------------------------------------------------------------------------
  // 语料（WP9 的最后一件）：规模 / 防泄漏 / 标注覆盖 / **冻结指纹**
  // -------------------------------------------------------------------------
  const corpus = buildReflectionCorpus()
  const manifest = buildReflectionCorpusManifest(corpus)
  const corpusFingerprint = createHash('sha256')
    .update(canonicalJson(corpus))
    .digest('hex')
  const secondBuildFingerprint = createHash('sha256')
    .update(canonicalJson(buildReflectionCorpus()))
    .digest('hex')

  record(
    'M18',
    'corpus',
    'self',
    '【规模】dev 100 / val 60 / blind 160 = **320**（与计划 §11.1 的冻结值一致）',
    manifest.total === 320 &&
      manifest.bySplit.dev === REFLECTION_CORPUS_PLAN.dev &&
      manifest.bySplit.val === REFLECTION_CORPUS_PLAN.val &&
      manifest.bySplit.blind === REFLECTION_CORPUS_PLAN.blind,
    `total=${String(manifest.total)} · bySplit=${JSON.stringify(manifest.bySplit)}`
  )
  record(
    'M19',
    'corpus',
    'self',
    '【防泄漏】**没有任何来源簇跨 split**（拆分的最小单位是簇 ⇒ 改述不可能泄漏到盲测）',
    manifest.clustersSpanningSplits.length === 0 && manifest.clusters > 0,
    `簇数=${String(manifest.clusters)} · 跨 split 的簇=${JSON.stringify(manifest.clustersSpanningSplits)}`
  )
  record(
    'M20',
    'corpus',
    'self',
    '【六类覆盖】六个类在**每个** split 里都有条目（不会出现"某一类只在盲测里"）',
    REFLECTION_CORPUS_FAMILIES.every((family) =>
      REFLECTION_CORPUS_SPLITS.every(
        (split) => corpus.filter((item) => item.family === family && item.split === split).length > 0
      )
    ),
    `byFamily=${JSON.stringify(manifest.byFamily)}`
  )
  record(
    'M21',
    'corpus',
    'self',
    '【危险类下界】三个高风险类在 blind 里各自 ≥26 条（计划 §11.1：危险类最低样本数要登记）',
    (['direct_conflict', 'fact_confusion', 'overreach_revision'] as const).every(
      (family) =>
        corpus.filter((item) => item.split === 'blind' && item.family === family).length >= 26
    ),
    `highRiskInBlind=${String(manifest.highRiskInBlind)}`
  )
  const knownReasons = new Set<string>(REFLECTION_DRAFT_REJECTION_REASONS)
  const unknownCorpusReasons = [
    ...new Set(corpus.flatMap((item) => item.gold.expectedReasons)),
  ].filter(
    (reason) =>
      !knownReasons.has(reason as never) &&
      ![
        'threshold_not_met',
        'single_root_only',
        'single_session_only',
        'conflicting_support',
        'not_fact_authority',
        'slot_out_of_scope',
        'seed_change_requested',
        'personality_axis_requested',
        'source_forgotten',
        'source_retracted',
        'source_version_changed',
      ].includes(reason)
  )
  record(
    'M22',
    'corpus',
    'self',
    '【标注闭集】金标理由码**全部**落在验收契约 §3.3 的闭集里（没有自造码）',
    unknownCorpusReasons.length === 0,
    `未知码=${JSON.stringify(unknownCorpusReasons)}`
  )
  record(
    'M23',
    'corpus',
    'self',
    '【金标自洽】`shouldAdjust=true` ⇒ 无理由码；`shouldAdjust=false` ⇒ **必有**理由码；越界类的 scope 是 `out_of_scope`',
    corpus.every(
      (item) =>
        (item.gold.shouldAdjust ? item.gold.expectedReasons.length === 0 : item.gold.expectedReasons.length > 0) &&
        (item.family === 'overreach_revision'
          ? item.gold.scope === 'out_of_scope'
          : item.gold.scope === 'current_character_user')
    ),
    `条目=${String(corpus.length)}`
  )
  record(
    'M24',
    'corpus',
    'self',
    '【冻结】语料指纹可复算且**两次构造一致**（确定性）—— 这就是"跑之前冻结"的机器判据',
    corpusFingerprint === secondBuildFingerprint && corpusFingerprint.length === 64,
    `fingerprint=${corpusFingerprint.slice(0, 16)}… · 两次一致=${String(corpusFingerprint === secondBuildFingerprint)}`
  )

  // -------------------------------------------------------------------------
  // 自检：三段式结构与非零分母
  // -------------------------------------------------------------------------
  const judges = [...new Set(checks.map((check) => check.judge))].filter(
    (judge) => judge !== 'scenario-registry' && judge !== 'constant-empty' && judge !== 'corpus'
  )
  const partsComplete = judges.every((judge) =>
    (['positive', 'negative', 'recovery'] as const).every((part) =>
      checks.some((check) => check.judge === judge && check.part === part)
    )
  )
  record(
    'M16',
    'self-check',
    'self',
    '【三段式结构】四个判定器**各自**都有 positive / negative / recovery 三段（缺一段就等于没验）',
    partsComplete && judges.length === 4,
    `判定器=${JSON.stringify(judges)} · 结构完整=${String(partsComplete)}`
  )
  const partCounts = {
    positive: checks.filter((check) => check.part === 'positive').length,
    negative: checks.filter((check) => check.part === 'negative').length,
    recovery: checks.filter((check) => check.part === 'recovery').length,
  }
  record(
    'M17',
    'self-check',
    'self',
    '【measured_count > 0】三段各有**非零**条目（0 检查 0 失败 = MEASUREMENT INVALID，不是 PASS）',
    Object.values(partCounts).every((count) => count > 0),
    `positive=${String(partCounts.positive)} · negative=${String(partCounts.negative)} · recovery=${String(partCounts.recovery)}`
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined
      ? createM11RunId({ wpId: 'wp9-measurement', headShort: head })
      : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-measurement-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    modelCalls: 0,
    databaseScope: 'none',
    measuredCount: checks.length,
    judges,
    scenarioCoverage: {
      implemented: coverage.implemented.length,
      notRun: coverage.notRun.length,
      byFamily: coverage.byFamily,
    },
    corpus: {
      total: manifest.total,
      bySplit: manifest.bySplit,
      byFamily: manifest.byFamily,
      clusters: manifest.clusters,
      clustersSpanningSplits: manifest.clustersSpanningSplits.length,
      highRiskInBlind: manifest.highRiskInBlind,
      fingerprint: corpusFingerprint,
      frozen: true,
    },
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'measurement-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp9-measurement',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'measurement',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:measurement:verify（四判定器三段式 + 差分负控 + 场景登记册）',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.judge}/${check.part}] ${check.label} —— ${check.detail}`)
  }
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:measurement:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
