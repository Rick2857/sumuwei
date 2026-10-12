/**
 * M6.1 WP5 / B② —— **词面覆盖的离线复现/核验器**（`pnpm m6.1:recall-coverage --label pre|post`）。
 *
 * ============================================================================
 *  它测什么（用户 2026-09-25 裁定 B②）
 * ============================================================================
 * ```text
 * 只修**词面覆盖**：不加语义/向量通道、**不降**全局相关性阈值 `minTotal`；
 * 先为"已证实问法"（如「我现在在写什么？」）设计**槽位相关**匹配，
 * 再用**无关问题负控**证明不会乱召回。
 * ```
 *
 * 三条受影响的冻结工况（四轮归因里逐条相同 ⇒ 确定性）：
 * ```text
 * SRP-A-08 / SRP-C-08   槽位 project.background.active · 问句「我现在在写什么？」
 * SRP-C-03              槽位 education.institution        · 问句「我在哪个学校读书？」
 * 实测形态（**修前**，`m6.1:recall-probe@1`）：候选 1–2 · 合格 1 · **选中 0** · 排除 `LOW_RELEVANCE`
 *       （ADR-059 修完后该探针升 `@2`：默认档断言"选中 ≥1 且取值正确"，修前形态走 `--expect found`）
 * 机制：相关性闸是**词面**的，而问句的 2 字片段与"槽位登记说明/例子"零重叠；
 *       语义通道**按既有裁定不存在**（M4 无嵌入列）。
 * ```
 *
 * ============================================================================
 *  判据（三段式 · 负控是主角）
 * ============================================================================
 * ```text
 * 正控  education.institution「我在哪个学校读书？」⇒ **必须选中 ≥1**（这条链本身是活的）
 * 负控  同上库、**无关问题**（午饭 / 运动 / 天气 / 问一个没存过的槽位）⇒ **必须选中 0**
 *       ⇒ 它守的是"扩词面之后不许乱召回"
 * 读数  B② 那三条（A-08 / C-08 / C-03 形状）今天是否选中 —— **不**作通过条件：
 *       修前应为"选中 0"（复现缺口），修后应翻成"选中 ≥1"（覆盖生效）
 * 恢复  正控那一条重跑 ⇒ 逐字段相同
 * ```
 *
 * ⚠️ 用法：`--label pre` 写 `artifacts/m6.1/recall-coverage-pre.json`，`--label post` 写 `-post.json`
 *    ⇒ **修前基线不会被修后覆盖**（B① 那份被覆盖的教训）。
 * ⚠️ 不调模型；开隔离库；真实库只做树摘要。
 * 退出码：`0` = 自证通过（读数在 verdict）· `3` = 自证失败（读数不可用）。
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  createTargetMemoryResolver,
  LexicalSemanticJudge,
  lexicalFragments,
  lexicalOverlapHits,
} from '../src/kernel/app/memory/target-resolver.ts'
import { registeredPredicates } from '../src/kernel/contracts/memory-predicates.ts'
import { entityRef, type EntityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { DEFAULT_RECALL_RANKING_POLICY } from '../src/kernel/recall/ranking.ts'
import { createM55Harness } from './m5.5-harness.ts'

const ROOT = resolve(process.cwd())
const PRODUCTION_DB_DIR = join(ROOT, 'data', 'pglite')

interface Case {
  readonly id: string
  readonly kind: 'positive' | 'reading' | 'negative'
  readonly slot: string
  readonly origin: string
  readonly setup: readonly string[]
  readonly question: string
}

/** ⚠️ 逐字来自冻结条文或其形状；负控是**同库**的无关问题 */
const CASES: readonly Case[] = [
  {
    id: 'ctl-institution',
    kind: 'positive',
    slot: 'education.institution',
    origin: '正控：SRP-A-01 的问句（这条链是活的）',
    setup: ['记住：我在江城大学读书。'],
    question: '我在哪个学校读书？',
  },
  {
    id: 'b2-project',
    kind: 'reading',
    slot: 'project.background.active',
    origin: 'B② 读数：SRP-A-08 的形状（问句与库里取值零词面重叠）',
    setup: ['记住：我在写毕业论文。'],
    question: '我现在在写什么？',
  },
  {
    id: 'b2-institution-updated',
    kind: 'reading',
    slot: 'education.institution',
    origin: 'B② 读数：SRP-C-03 的形状（更正后问同一句）',
    setup: ['记住：我在江城大学读书。', '更正一下，我转学到明德大学了。'],
    question: '我在哪个学校读书？',
  },
  {
    id: 'neg-lunch',
    kind: 'negative',
    slot: 'project.background.active',
    origin: '负控：同库问午饭（与论文/学校无关）',
    setup: ['记住：我在写毕业论文。'],
    question: '今天午饭吃什么？',
  },
  {
    id: 'neg-sport',
    kind: 'negative',
    slot: 'project.background.active',
    origin: '负控：同库问运动（无关）',
    setup: ['记住：我在写毕业论文。'],
    question: '我平时喜欢什么运动？',
  },
  {
    id: 'neg-weather',
    kind: 'negative',
    slot: 'education.institution',
    origin: '负控：同库问天气（无关）',
    setup: ['记住：我在江城大学读书。'],
    question: '外面下雨了吗？',
  },
  {
    id: 'neg-absent-slot',
    kind: 'negative',
    slot: 'device.primary',
    origin: '负控：问一个**没存过**的槽位（不许拿学校那条顶上）',
    setup: ['记住：我在江城大学读书。'],
    question: '我平时用什么电脑？',
  },
  {
    id: 'near-miss-homework',
    kind: 'reading',
    slot: 'project.background.active',
    origin:
      '★ 边界读数（与修复同批加入 ⇒ **只有修后读数**）：问的是**她**写作业，而库里是**用户的**项目 ⇒ 词面会命中，属于本次扩词面的已知边界',
    setup: ['记住：我在写毕业论文。'],
    question: '你在写作业吗？',
  },
]

interface Reading {
  readonly id: string
  readonly kind: Case['kind']
  readonly slot: string
  readonly origin: string
  readonly question: string
  readonly storedValues: readonly string[]
  readonly queryFragments: readonly string[]
  readonly lexicalHitCount: number
  readonly candidates: number
  readonly eligible: number
  readonly selected: number
  readonly selectedValues: readonly string[]
  readonly exclusionHistogram: Readonly<Record<string, number>>
  readonly policyMinTotal: number
  readonly ok: boolean
}

async function openCase(label: string): Promise<Awaited<ReturnType<typeof createM55Harness>>> {
  await resetPluginSqlConnection()
  isolateDatabase(`m61-b2-${label}`, { keep: false })
  return createM55Harness({ label: `m61-b2-${label}` })
}

async function runCase(
  bed: Awaited<ReturnType<typeof createM55Harness>>,
  testCase: Case
): Promise<Reading> {
  const h = bed.h
  const { owner, user, db, store } = h
  const service = createExplicitMemoryService({
    store,
    validator: h.validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      createTargetMemoryResolver({
        get: (id) => store.get(id),
        getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
        listBySubject: (o: EntityRef, s: EntityRef) => store.listBySubject(o, s),
        semanticJudge: new LexicalSemanticJudge(),
      }).resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents: async (accepted, now) =>
      (await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)).domainEvents,
    conflict: {
      recordsInCanonicalSlot: async ({ canonicalKey }) => {
        const active = await store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
          (record) => record.canonicalKey === canonicalKey
        )
        return [...active, ...disputed]
      },
    },
  })
  const detector = createExplicitMemoryIntentDetector()
  for (const text of testCase.setup) {
    const recorded = await h.recordUserEvidence(text)
    const intent = await detectExplicitIntentFromEvent(detector, {
      id: recorded.ref.id as never,
      actorType: 'user',
      content: text,
    })
    if (intent === undefined) continue
    await service.handle({
      owner,
      speaker: user,
      intent,
      triggerEventId: recorded.ref.id,
      hints: targetHintsFrom(intent),
    })
  }

  const retrievalStore = createMemoryRetrievalStore({
    store,
    integrity: (o) => memoryIntegrityProblems(db, o),
    rootReadings: (ids) => rootReadingsByMemory(db, ids),
  })
  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({ port: retrievalStore }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => Date.now(),
  })
  const outcome = await recallPort.run(
    createRecallRequest({
      traceId: newTraceId(),
      characterId: String(h.characterId),
      user: entityRef('user', String(h.user.id)),
      query: { text: testCase.question, source: 'user_message' },
      intent: 'current_fact',
      contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
    })
  )

  const all = await store.list({ owner, limit: 500 })
  const storedValues = all
    .filter((row) => (row.content as { predicate?: string }).predicate === testCase.slot)
    .map((row) => `${String(row.status)}:${String((row.content as { value?: unknown }).value ?? '')}`)
  const selectedValues = outcome.record.selectedIds.map((id) => {
    const row = all.find((candidate) => String(candidate.id) === String(id))
    return row === undefined ? String(id) : `${String((row.content as { value?: unknown }).value ?? '')}`
  })

  const scanned = all.filter((row) => (row.content as { predicate?: string }).predicate === testCase.slot)
  const fragments = lexicalFragments(testCase.question)
  const hits = lexicalOverlapHits(testCase.question, scanned)

  const selected = outcome.record.metrics.selectedCount
  const ok = testCase.kind === 'positive' ? selected >= 1 : testCase.kind === 'negative' ? selected === 0 : true

  return {
    id: testCase.id,
    kind: testCase.kind,
    slot: testCase.slot,
    origin: testCase.origin,
    question: testCase.question,
    storedValues,
    queryFragments: fragments,
    lexicalHitCount: hits.length,
    candidates: outcome.record.metrics.candidateCount,
    eligible: outcome.record.metrics.eligibleCount,
    selected,
    selectedValues,
    exclusionHistogram: { ...outcome.trace.exclusionHistogram },
    policyMinTotal: DEFAULT_RECALL_RANKING_POLICY.minTotal,
    ok,
  }
}

const labelIndex = process.argv.indexOf('--label')
const label = labelIndex === -1 ? 'current' : String(process.argv[labelIndex + 1] ?? 'current')
if (!/^[a-z0-9-]+$/.test(label)) {
  console.error(`--label 只允许 [a-z0-9-]（收到 ${JSON.stringify(label)}）`)
  process.exit(2)
}

const realDbBefore = digestTree(PRODUCTION_DB_DIR)
const readings: Reading[] = []
for (const testCase of CASES) {
  const bed = await openCase(testCase.id)
  try {
    readings.push(await runCase(bed, testCase))
  } finally {
    await bed.dispose()
  }
}
/* 恢复：正控那条重跑 */
const replayBed = await openCase('ctl-replay')
let replay: Reading | undefined
try {
  replay = await runCase(replayBed, CASES[0]!)
} finally {
  await replayBed.dispose()
}
await resetPluginSqlConnection()
const realDbAfter = digestTree(PRODUCTION_DB_DIR)

const positives = readings.filter((row) => row.kind === 'positive')
const negatives = readings.filter((row) => row.kind === 'negative')
const reading = readings.filter((row) => row.kind === 'reading')
const original = readings.find((row) => row.id === CASES[0]!.id)
const restoreOk =
  original !== undefined &&
  replay !== undefined &&
  original.selected === replay.selected &&
  JSON.stringify(original.exclusionHistogram) === JSON.stringify(replay.exclusionHistogram)

const failures: string[] = []
if (readings.length === 0) failures.push('MEASUREMENT INVALID：0 条读数')
if (positives.length === 0) failures.push('计数自检：正控 0 条')
if (negatives.length === 0) failures.push('计数自检：负控 0 条（没有负控的"覆盖扩了"读数不可用）')
if (!positives.every((row) => row.ok)) {
  failures.push('正控未成立：「我在哪个学校读书？」必须选中 ≥1 ⇒ 否则这条链本身有问题，下面的读数不可用')
}
if (!negatives.every((row) => row.ok)) {
  failures.push('★ 负控被打破：无关问题也召回了 ⇒ 词面覆盖扩过头（用户明令：不许乱召回）')
}
if (!restoreOk) failures.push('恢复失败：正控两次读数不同 / 真实库摘要变了')

const readingSelected = reading.filter((row) => row.selected >= 1).length
const verdict =
  failures.length > 0
    ? 'SELF_PROOF_FAILED'
    : readingSelected === reading.length && reading.length > 0
      ? 'COVERED'
      : readingSelected === 0
        ? 'GAP_REPRODUCED'
        : 'PARTIAL'

console.log('='.repeat(96))
console.log(`M6.1 WP5 / B② · 词面覆盖复现/核验（label=${label} · 隔离库 · 零模型调用）`)
console.log('='.repeat(96))
for (const row of readings) {
  const mark = row.kind === 'positive' ? '正控' : row.kind === 'negative' ? '负控' : '读数'
  console.log(`  [${mark}] ${row.id.padEnd(22)} ${row.kind === 'reading' ? row.origin : row.question}`)
  console.log(
    `         库[${row.slot}] = ${row.storedValues.join(' / ') || '(空)'} · 问句片段 ${JSON.stringify([...row.queryFragments])}` +
      ` · 词面命中 ${String(row.lexicalHitCount)}`
  )
  console.log(
    `         候选 ${String(row.candidates)} · 合格 ${String(row.eligible)} · **选中 ${String(row.selected)}**` +
      ` ${row.selectedValues.length > 0 ? `(${row.selectedValues.join(',')})` : ''}` +
      ` · 排除 ${Object.entries(row.exclusionHistogram).map(([k, v]) => `${k}:${String(v)}`).join(' ') || '(空)'}` +
      ` · 阈值 minTotal=${String(row.policyMinTotal)} · ${row.ok ? 'OK' : '**不符**'}`
  )
}
console.log('')
console.log(
  `  正控 ${positives.filter((r) => r.ok).length}/${positives.length} · ` +
    `负控 ${negatives.filter((r) => r.ok).length}/${negatives.length} · ` +
    `读数命中 ${readingSelected}/${reading.length} · 恢复 ${restoreOk ? 'PASS' : '**FAIL**'}`
)
console.log(
  `  真实库树摘要：${realDbBefore.treeSha256.slice(0, 16)}… → ${realDbAfter.treeSha256.slice(0, 16)}… ` +
    `${realDbBefore.treeSha256 === realDbAfter.treeSha256 ? '未变' : '**变了**'}`
)
console.log(`  结论 verdict = ${verdict}`)

const evidence = {
  schemaVersion: 'm6.1-recall-coverage@1',
  testId: 'M6.1 WP5 / B② 词面覆盖（槽位相关匹配）复现/核验',
  label,
  what: '在隔离库里按生产路径写入冻结条文的 setup，再用生产同形的召回请求，读出词面命中/候选/合格/选中与排除理由。',
  why:
    '用户裁定 B②：只修词面覆盖（不加语义/向量通道、不降 minTotal），且必须用无关问题负控证明不会乱召回。',
  verdict,
  cases: readings,
  realDb: {
    before: realDbBefore.treeSha256,
    after: realDbAfter.treeSha256,
    unchanged: realDbBefore.treeSha256 === realDbAfter.treeSha256,
  },
  selfProof: {
    positiveControls: positives.map((row) => ({ id: row.id, ok: row.ok, selected: row.selected })),
    negatives: negatives.map((row) => ({ id: row.id, ok: row.ok, selected: row.selected })),
    restore: restoreOk,
    countCheck: { cases: readings.length, positives: positives.length, negatives: negatives.length, readings: reading.length },
  },
  failures,
  notProven: [
    '它只测**词面/相关性闸**这一层；"她最终答得对不对"由短场景与量具负责。',
    '负控只覆盖本脚本这 4 条无关问题；**扩词面之后必须重跑**它们（本脚本就是为此写成 pre/post 两档）。',
    '它不证明"扩了词面就万事大吉"：反例违规与量具不稳定是另外两组问题（用户 19.5 已写明）。',
  ],
}
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
const outPath = join(ROOT, 'artifacts', 'm6.1', `recall-coverage-${label}.json`)
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`  证据：artifacts/m6.1/recall-coverage-${label}.json`)

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证失败 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
