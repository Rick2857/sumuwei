/**
 * M4 Backup / Restore 往返验收（计划书第 200 / 202 / 203 节；附件 M4-T27 / T28 / T29）。
 *
 * ============================================================================
 *  它验证什么（四件事，缺一不可）
 * ============================================================================
 *   1. **T27 Backup**：语料库落盘 → 导出成一份**逻辑文档** → 文档可读
 *   2. **T28 Clean Restore**：把那份文档恢复进一个**全新的空库**，
 *      比较 `CanonicalSemanticSnapshot` 的 SHA256 + 全部分计数
 *   3. **恢复后的库仍然自洽**：`rebuildCharacterMemories` 给出 `A == B`
 *   4. **T29 恢复后继续可运行**：在恢复库上继续 create / correct / forget
 *
 * ============================================================================
 *  两条**负控**（没有负控的绿不算证据）
 * ============================================================================
 *   负控 A：一个**全新空库**的快照必须与语料库**不同**
 *   负控 B：在恢复库上改一个**语义字段**后哈希必须变
 *
 * ============================================================================
 *  ⚠️ 2026-10-21 改写：从"复制数据目录"改成"逻辑导出 + 逻辑恢复"
 * ============================================================================
 *  第一版（也是 PGlite 时代唯一可行的做法）是 `cpSync(source.dir, backupDir)`
 *  —— **复制整个数据目录**。
 *
 *  PostgreSQL **没有数据目录可复制** ⇒ 那条路在 PG 下**不存在**。
 *  ⇒ 改用**逻辑导出**（`scripts/cognitive/export-restore.ts` 的
 *    `lg-cognitive-export@1` 格式）：把相关表的内容导成一份带版本的 JSON，
 *    恢复时按外键顺序写回一个**空库**。
 *
 *  ⚠️ 而且**必须**逐场景跑：PG 下 `isolateDatabase()` **给不出空白库**
 *    （它只把 URL 再指一次）⇒ 「源库 / 空库负控 / 恢复目标」三个库必须是
 *    **三个不同的库**。
 *  ⇒ 拆成五个场景，**每个场景一个独立进程 + 一个独立空白库**
 *    （进程内 PG 目标**从不改变** ⇒ 产品那条「同进程只允许一个 PostgreSQL 目标」
 *    的不变量**一字未动、也不被触发**）。
 *    场景之间靠**文件**交换（导出文档 + 源侧读数）。
 *
 *  跑法：
 *   pnpm m4:restore:verify                              （逐场景执行器）
 *   pnpm gates:pg:scenario -- scripts/verify-m4-restore.ts
 */

import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import {
  cleanupSandbox,
  isolateDatabase,
  resetPluginSqlConnection,
} from '../src/dev/sandbox.ts'

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import {
  buildStandardCorpus,
  countsOf,
  createM4Harness,
  createReporter,
  snapshotOf,
  M4_T0,
} from './m4-harness.ts'
import {
  contaminatedMemories,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'
import {
  exportCognitiveState,
  restoreCognitiveState,
  type CognitiveExport,
} from './cognitive/export-restore.ts'

const report = createReporter()
const evidenceDir = join(process.cwd(), 'artifacts', 'm4-acceptance', 'restore')
const exportFile = join(evidenceDir, 'restore-export.json')
const sourceStateFile = join(evidenceDir, 'restore-source-state.json')

/*
 * ⚠️ `--list-cases` 必须在**隔离之前**：逐场景执行器直接读 stdout，
 *    `isolateDatabase()` 的横幅会被当成一个"场景"。
 */
const SCENARIO_IDS = [
  'source',
  'empty-control',
  'restore',
  'negative-mutate',
  'continue-after-restore',
] as const
type ScenarioId = (typeof SCENARIO_IDS)[number]

if (process.argv.includes('--list-cases')) {
  for (const id of SCENARIO_IDS) console.log(`${id}\t0`)
  process.exit(0)
}

isolateDatabase('m4-restore')
await resetPluginSqlConnection()

// ---------------------------------------------------------------------------
// 场景之间交换的两份文件
// ---------------------------------------------------------------------------

/** 源侧读数（快照哈希 · 计数 · 语料 id · 导出摘要） */
interface SourceState {
  snapshotA: string
  countsA: Record<string, number>
  corpus: { revisionPair: [string, string]; retractedId: string; disputedId: string; episodeId: string | null; personFactId: string }
  exportDigest: string
  exportTables: number
  exportRows: number
}

function readSourceState (): SourceState {
  return JSON.parse(readFileSync(sourceStateFile, 'utf8')) as SourceState
}

function readExport (): CognitiveExport {
  return JSON.parse(readFileSync(exportFile, 'utf8')) as CognitiveExport
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ id: ScenarioId; run: () => Promise<void> }> = [
  { id: 'source', run: scenarioSource },
  { id: 'empty-control', run: scenarioEmptyControl },
  { id: 'restore', run: scenarioRestore },
  { id: 'negative-mutate', run: scenarioNegativeMutate },
  { id: 'continue-after-restore', run: scenarioContinueAfterRestore },
]

const argv = process.argv.slice(2)
const caseIndex = argv.indexOf('--case')
const onlyCase = caseIndex >= 0 ? argv[caseIndex + 1] : undefined
if (onlyCase !== undefined && !(SCENARIO_IDS as readonly string[]).includes(onlyCase)) {
  console.error(`❌ 没有这个场景：${onlyCase}`)
  console.error(`   可用：${SCENARIO_IDS.join(' / ')}`)
  process.exit(2)
}
const selected = onlyCase === undefined ? SCENARIOS : SCENARIOS.filter(s => s.id === onlyCase)

// ---------------------------------------------------------------------------
// 证据（每个场景一份；聚合文件由**每个**场景各写一次 ⇒ 跑完就是完整的）
// ---------------------------------------------------------------------------

interface CaseEvidence {
  scenario: string
  passed: number
  failed: number
  failures: readonly string[]
  checks: Array<{ label: string; ok: boolean; detail: string }>
}

/** 本门自己的检查台账（`createReporter` 只给计数，这里补一份可留档的明细） */
const caseChecks: Array<{ label: string; ok: boolean; detail: string }> = []
const rawCheck = report.check.bind(report)
report.check = (label: string, ok: boolean, detail = '') => {
  caseChecks.push({ label, ok, detail })
  rawCheck(label, ok, detail)
}

for (const scenario of selected) {
  await scenario.run()
  writeEvidence(scenario.id)
}

function writeEvidence (scenario: string): void {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    join(evidenceDir, `restore-result.${scenario}.json`),
    `${JSON.stringify(
      {
        testId: 'M4-T27/T28/T29',
        scenario,
        status: report.failed === 0 ? 'PASS' : 'FAIL',
        checks: { passed: report.passed, failed: report.failed, failures: report.failures },
        detail: caseChecks,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  // 聚合：把**已经跑过**的场景证据合成一份（部分跑 ⇒ 如实说只覆盖了哪些）
  const cases: CaseEvidence[] = []
  for (const file of readdirSync(evidenceDir)) {
    if (!file.startsWith('restore-result.') || !file.endsWith('.json')) continue
    if (file === 'restore-result.json') continue
    try {
      cases.push(JSON.parse(readFileSync(join(evidenceDir, file), 'utf8')) as CaseEvidence)
    } catch {
      /* 读不出来就跳过（不猜） */
    }
  }
  const passed = cases.reduce((sum, item) => sum + item.passed, 0)
  const failed = cases.reduce((sum, item) => sum + item.failed, 0)
  writeFileSync(
    join(evidenceDir, 'restore-result.json'),
    `${JSON.stringify(
      {
        testId: 'M4-T27/T28/T29',
        name: 'Backup / Clean Restore / Application After Restore',
        priority: 'P0',
        status: failed === 0 && cases.length === SCENARIO_IDS.length ? 'PASS' : failed === 0 ? 'PARTIAL' : 'FAIL',
        mechanism: '逻辑导出 / 逻辑恢复（lg-cognitive-export@1）—— PostgreSQL 没有数据目录可复制',
        isolation: '每个场景一个独立进程 + 一个独立空白库（进程内 PG 目标从不改变）',
        scenariosRun: cases.map(item => item.scenario),
        scenariosTotal: SCENARIO_IDS.length,
        coverageComplete: cases.length === SCENARIO_IDS.length,
        checks: { passed, failed },
        perCase: cases,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

// ===========================================================================
// 场景实现
// ===========================================================================

/** ① T27：造语料 + **导出**（= 备份） */
async function scenarioSource (): Promise<void> {
  report.section('① T27 语料库（create / supersede / retract / dispute / episode）+ 导出')
  const harness = await createM4Harness({ label: 'm4-restore-source' })
  const owner = harness.owner
  const corpus = await buildStandardCorpus(harness)
  const snapshotA = await snapshotOf(harness.store, owner)
  const countsA = await countsOf(harness.db, owner)

  report.check('语料库有记忆', countsA.memories >= 5, `${String(countsA.memories)} 条`)
  report.check(
    '语料覆盖四种状态（active / superseded / retracted / disputed）',
    countsA.active > 0 &&
      countsA.superseded === 1 &&
      countsA.retracted === 1 &&
      countsA.disputed === 1,
    JSON.stringify({
      active: countsA.active,
      superseded: countsA.superseded,
      retracted: countsA.retracted,
      disputed: countsA.disputed,
    })
  )
  report.check('语料覆盖 revision 链（supersede 双向指针）', countsA.memories > countsA.active)
  report.check('语料覆盖证据链', countsA.evidenceRoots > 0, `${String(countsA.evidenceRoots)} 个 root`)
  const unsupportedA = await unsupportedMemories(harness.db, owner)
  report.check('语料库 unsupported = 0（MI-03）', unsupportedA.length === 0, `${String(unsupportedA.length)} 条`)

  const doc = await exportCognitiveState(harness.db)
  const rows = doc.tables.reduce((sum, table) => sum + table.rows.length, 0)
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(exportFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  writeFileSync(
    sourceStateFile,
    `${JSON.stringify(
      {
        snapshotA: snapshotA.hash,
        countsA,
        corpus,
        exportDigest: doc.digest,
        exportTables: doc.tables.length,
        exportRows: rows,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  report.check('导出（= 备份）已写出', doc.digest.length === 64, `${String(doc.tables.length)} 张表 / ${String(rows)} 行 · ${doc.digest.slice(0, 12)}…`)
  console.log(`  快照 A：${snapshotA.hash.slice(0, 16)}…（${String(snapshotA.entries.length)} 条）`)
  await harness.stop()
}

/** ② 负控 A：全新空库 ≠ 语料库 */
async function scenarioEmptyControl (): Promise<void> {
  report.section('② 负控 A（比较函数必须能失败：全新空库 ≠ 语料库）')
  const source = readSourceState()
  const harness = await createM4Harness({ label: 'm4-restore-empty' })
  const snapshotE = await snapshotOf(harness.store, harness.owner)
  const countsE = await countsOf(harness.db, harness.owner)
  report.check('负控 A：全新库确实没有记忆', countsE.memories === 0, `${String(countsE.memories)} 条`)
  const emptyDoc = await exportCognitiveState(harness.db)
  report.check(
    '负控 A：空库摘要 ≠ 语料库摘要（否则"相等"没有信息量）',
    emptyDoc.digest !== source.exportDigest,
    `${emptyDoc.digest.slice(0, 12)}… vs ${source.exportDigest.slice(0, 12)}…`
  )
  report.check(
    '负控 A：空库快照 ≠ 语料库快照',
    snapshotE.hash !== source.snapshotA,
    `${snapshotE.hash.slice(0, 12)}… vs ${source.snapshotA.slice(0, 12)}…`
  )
  await harness.stop()
}

/** ③ T28：恢复到本场景的**全新空库**并逐项比对 */
async function scenarioRestore (): Promise<void> {
  report.section('③ T28 Clean Restore（恢复到一个全新的空库）')
  const source = readSourceState()
  const doc = readExport()
  const harness = await createM4Harness({ label: 'm4-restore-target' })
  const owner = harness.owner

  const before = await countsOf(harness.db, owner)
  report.check('恢复目标在恢复前**没有记忆**（才算"全新空库"）', before.memories === 0, `${String(before.memories)} 条`)

  await restoreCognitiveState(harness.db, doc)

  const snapshotB = await snapshotOf(harness.store, owner)
  const countsB = await countsOf(harness.db, owner)
  console.log(`  快照 B：${snapshotB.hash.slice(0, 16)}…（${String(snapshotB.entries.length)} 条）`)

  report.check(
    '**CanonicalSemanticSnapshot 哈希一致**（A == B）',
    snapshotB.hash === source.snapshotA,
    `A=${source.snapshotA.slice(0, 12)}… B=${snapshotB.hash.slice(0, 12)}…`
  )
  report.check(
    '计数逐项一致（记忆 / 状态分布 / 索引 / 事件）',
    JSON.stringify(source.countsA) === JSON.stringify(countsB),
    JSON.stringify({ A: source.countsA, B: countsB })
  )

  report.section('④ 恢复后的库自洽（rebuild `A == B`）')
  const rebuild = await harness.store.rebuildCharacterMemories(owner)
  report.check(
    '每条恢复出来的记忆都能从自己的事件流重放出相同状态',
    rebuild.memories > 0 && rebuild.mismatched === 0,
    `重建 ${String(rebuild.rebuilt)}/${String(rebuild.memories)}，不一致 ${String(rebuild.mismatched)}`
  )
  const unsupportedB = await unsupportedMemories(harness.db, owner)
  report.check('恢复库 unsupported = 0', unsupportedB.length === 0, `${String(unsupportedB.length)} 条`)
  const contaminatedB = await contaminatedMemories(harness.db, owner)
  report.check('恢复库 contamination = 0', contaminatedB.length === 0, `${String(contaminatedB.length)} 条`)

  // 证据链反查必须仍然可用（provenance 真的被恢复了，而不是只恢复了计数）
  const withEvidence = snapshotB.entries.find(entry => entry.sourceRefs.length > 0)
  const evidenceId = withEvidence?.sourceRefs[0]?.split(':').slice(1).join(':') ?? ''
  const bySource = await harness.store.listBySource({
    kind: 'conversation_event',
    id: evidenceId,
  } as never)
  report.check(
    '恢复库能按来源反查（provenance 可追溯）',
    withEvidence !== undefined && bySource.length > 0,
    `${String(bySource.length)} 条`
  )

  // revision 链双向指针
  const [oldId, newId] = source.corpus.revisionPair
  const oldRecord = await harness.store.get(oldId as never)
  const newRecord = await harness.store.get(newId as never)
  report.check(
    '恢复后 supersede 双向指针仍成立',
    String(oldRecord?.supersededBy) === newId &&
      (newRecord?.supersedes ?? []).some((id) => String(id) === oldId),
    `old→${String(oldRecord?.supersededBy)} / new→${(newRecord?.supersedes ?? []).join(',')}`
  )

  // 逻辑遗忘 ≠ 物理删除：被忘掉的那条仍在库里
  const retractedRecord = await harness.store.get(source.corpus.retractedId as never)
  report.check(
    '恢复后 retracted 的记忆仍在库里（逻辑遗忘，不是物理删除）',
    retractedRecord !== null && retractedRecord.status === 'retracted',
    `status=${String(retractedRecord?.status)}`
  )

  // 被忘掉的记忆不得出现在「正常有效事实」集合里
  const activeSet = (await harness.store.list({ owner, status: 'active', limit: 500 })).map(record =>
    String(record.id)
  )
  report.check(
    'retracted 记忆不出现在 active 集合里（INV-04）',
    !activeSet.includes(source.corpus.retractedId)
  )
  await harness.stop()
}

/** ⑤ 负控 B：改一个语义字段后哈希必须变（且能改回来） */
async function scenarioNegativeMutate (): Promise<void> {
  report.section('⑤ 负控 B（比较函数必须对语义字段敏感）')
  const doc = readExport()
  const harness = await createM4Harness({ label: 'm4-restore-mutate' })
  const owner = harness.owner
  await restoreCognitiveState(harness.db, doc)
  const snapshotB = await snapshotOf(harness.store, owner)
  const probe = snapshotB.entries[0]
  if (probe === undefined) {
    report.check('负控 B：恢复库里至少有一条记忆可改', false, '快照为空')
    await harness.stop()
    return
  }
  await harness.db.execute(
    sql`update memory_records set confidence = confidence - 0.5 where id = ${probe.logicalId}`
  )
  const snapshotMutated = await snapshotOf(harness.store, owner)
  report.check(
    '负控 B：改动一个语义字段后哈希改变',
    snapshotMutated.hash !== snapshotB.hash,
    `${snapshotB.hash.slice(0, 12)}… → ${snapshotMutated.hash.slice(0, 12)}…`
  )
  await harness.db.execute(
    sql`update memory_records set confidence = ${probe.confidence} where id = ${probe.logicalId}`
  )
  const snapshotReverted = await snapshotOf(harness.store, owner)
  report.check(
    '负控 B：改回原值后哈希恢复一致（比较是确定性的）',
    snapshotReverted.hash === snapshotB.hash
  )
  await harness.stop()
}

/** ⑥ T29：恢复后继续可运行 */
async function scenarioContinueAfterRestore (): Promise<void> {
  report.section('⑥ T29 恢复后继续运行（create / correct / forget）')
  const doc = readExport()
  const harness = await createM4Harness({ label: 'm4-restore-continue' })
  const owner = harness.owner
  await restoreCognitiveState(harness.db, doc)

  const newEvidence = await harness.recordUserEvidence('我现在开始学钢琴了')
  const created = await harness.commitAndFold(
    harness.makeCandidate(
      'preference',
      { kind: 'claim', subject: harness.user, predicate: 'hobby.music', value: 'piano' },
      { sourceRefs: [newEvidence.ref] }
    ),
    M4_T0 + 10_000
  )
  report.check('恢复库上 create 成功', created !== null && created.status === 'active', String(created?.id))

  const correctEvidence = await harness.recordUserEvidence('说错了，我学的是小提琴')
  const corrected = await harness.commitAndFold(
    harness.makeCandidate(
      'preference',
      { kind: 'claim', subject: harness.user, predicate: 'hobby.music', value: 'violin' },
      { sourceRefs: [correctEvidence.ref] }
    ),
    M4_T0 + 11_000
  )
  await harness.applyStateChange(
    'supersede',
    correctEvidence.ref.id,
    {
      memoryId: created!.id,
      supersededBy: corrected!.id,
      validUntil: M4_T0 + 11_000,
      reason: '用户纠正为小提琴',
    },
    M4_T0 + 11_000
  )
  const afterSupersede = await harness.store.get(created!.id)
  report.check('恢复库上 correct（supersede）成功', afterSupersede?.status === 'superseded')

  const forgetEvidence2 = await harness.recordUserEvidence('忘掉我学小提琴这件事')
  await harness.applyStateChange(
    'retract',
    forgetEvidence2.ref.id,
    { memoryId: corrected!.id, reason: 'explicit_forget', note: '用户要求忘掉' },
    M4_T0 + 12_000
  )
  const afterForget = await harness.store.get(corrected!.id)
  report.check('恢复库上 forget（retract）成功', afterForget?.status === 'retracted')

  const rerestore = await harness.store.rebuildCharacterMemories(owner)
  report.check('继续写入之后仍满足 `A == B`', rerestore.mismatched === 0, `不一致 ${String(rerestore.mismatched)}`)
  await harness.stop()
}

report.finish(onlyCase === undefined ? 'M4 Backup / Restore' : `M4 Backup / Restore · ${onlyCase}`)
