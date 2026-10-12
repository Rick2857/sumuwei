/**
 * M4 Backup / Restore 往返验收（计划书第 200 / 202 / 203 节；附件 M4-T27 / T28 / T29）。
 *
 * ============================================================================
 *  这条 Gate 之前**根本没有实现**
 * ============================================================================
 * `m4:backup:verify` 证明的是"备份**打得开**"，它**没有**回答：
 *
 *     把备份恢复到一个全新库之后，苏沐薇的长期记忆是不是**一模一样**？
 *     恢复出来的库还能不能继续用（create / correct / forget）？
 *
 * 而计划书第 216 节的 Exit Criteria 把 `backup/restore PASS` 写成了
 * Reliability 的必达项，第 200 节明确要求"至少开发环境必须验证 export / restore"。
 * 只验证"打得开"是把**备份可读性**当成了**恢复正确性** ——
 * 那时本项目反复记录过的那类错误：测量工具量的是错的东西。
 *
 * ---------------------------------------------------------------------------
 *  它验证什么（四件事，缺一不可）
 * ---------------------------------------------------------------------------
 *   1. **T27 Backup**：语料库落盘 → 关闭连接 → 整体复制成备份 → 备份可打开
 *   2. **T28 Clean Restore**：把备份恢复进一个**全新**数据目录，
 *      比较 `CanonicalSemanticSnapshot` 的 SHA256 + 全部分计数
 *   3. **恢复后的库仍然自洽**：`rebuildCharacterMemories` 给出 `A == B`
 *   4. **T29 恢复后继续可运行**：在恢复库上继续 create / correct / forget
 *
 * ---------------------------------------------------------------------------
 *  两条**负控**（没有负控的绿不算证据）
 * ---------------------------------------------------------------------------
 *   负控 A：一个**全新空库**的快照必须与语料库**不同**
 *   负控 B：在恢复库上改一个**语义字段**后哈希必须变
 *
 * 两条负控都是断言：负控不成立 → 本脚本自己失败。
 *
 * 安全：全部在 `isolateDatabase()` 的临时副本上，**绝不打开真实库**。
 *
 * 跑法：pnpm m4:restore:verify
 */

import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import {
  cleanupSandbox,
  isolateDatabase,
  resetPluginSqlConnection,
} from '../src/dev/sandbox.ts'

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import {
  buildStandardCorpus,
  countsOf,
  createM4Harness,
  createReporter,
  snapshotOf,
  stableStringify,
  M4_T0,
} from './m4-harness.ts'
import {
  contaminatedMemories,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'

const report = createReporter()

const source = isolateDatabase('m4-restore-source', { keep: true })
const backupDir = mkdtempSync(join(tmpdir(), 'project-lg-m4-restore-backup-'))
const evidenceDir = join(process.cwd(), 'artifacts', 'm4-acceptance', 'restore')

console.log('='.repeat(72))
console.log('M4 Backup / Restore 往返验收（计划书第 200 / 202 / 203 节）')
console.log('='.repeat(72))
console.log(`语料库（沙箱来源）：${source.dir}`)
console.log(`备份目录          ：${backupDir}`)

await resetPluginSqlConnection()

// ---------------------------------------------------------------------------
// 1. T27：造语料
// ---------------------------------------------------------------------------
report.section('1. T27 语料库（create / supersede / retract / dispute / episode）')
const sourceHarness = await createM4Harness({ label: 'restore-source' })
const corpus = await buildStandardCorpus(sourceHarness)
const owner = sourceHarness.owner
const snapshotA = await snapshotOf(sourceHarness.store, owner)
const countsA = await countsOf(sourceHarness.db, owner)

report.check('语料库有记忆', countsA.memories >= 5, `${countsA.memories} 条`)
report.check(
  '语料覆盖四种状态（active / superseded / retracted / disputed）',
  countsA.active > 0 &&
    countsA.superseded === 1 &&
    countsA.retracted === 1 &&
    countsA.disputed === 1,
  stableStringify({
    active: countsA.active,
    superseded: countsA.superseded,
    retracted: countsA.retracted,
    disputed: countsA.disputed,
  })
)
report.check('语料覆盖 revision 链（supersede 双向指针）', countsA.memories > countsA.active)
report.check('语料覆盖证据链', countsA.evidenceRoots > 0, `${countsA.evidenceRoots} 个 root`)
const unsupportedA = await unsupportedMemories(sourceHarness.db, owner)
report.check('语料库 unsupported = 0（MI-03）', unsupportedA.length === 0, `${unsupportedA.length} 条`)
console.log(`  快照 A：${snapshotA.hash.slice(0, 16)}…（${snapshotA.entries.length} 条）`)

// 关闭连接后才复制 —— 运行期间复制会得到"字节正确但打不开"的备份
await sourceHarness.stop()
await resetPluginSqlConnection()

// ---------------------------------------------------------------------------
// 2. T27：Backup
// ---------------------------------------------------------------------------
report.section('2. T27 Backup（关闭连接后整体复制）')
cpSync(source.dir, backupDir, { recursive: true })
report.check('备份目录已生成', existsSync(backupDir), backupDir)

// ---------------------------------------------------------------------------
// 3. 负控 A：全新空库的快照必须与语料库不同
// ---------------------------------------------------------------------------
report.section('3. 负控 A（比较函数必须能失败：全新空库 ≠ 语料库）')
const emptyTarget = isolateDatabase('m4-restore-empty', { keep: true })
await resetPluginSqlConnection()
const emptyHarness = await createM4Harness({ label: 'empty-control' })
const snapshotE = await snapshotOf(emptyHarness.store, owner)
const countsE = await countsOf(emptyHarness.db, owner)
report.check('负控 A：全新库确实没有记忆', countsE.memories === 0, `${countsE.memories} 条`)
report.check(
  '负控 A：空库哈希 ≠ 语料库哈希（否则"相等"没有信息量）',
  snapshotE.hash !== snapshotA.hash,
  `${snapshotE.hash.slice(0, 12)}… vs ${snapshotA.hash.slice(0, 12)}…`
)
await emptyHarness.stop()
await resetPluginSqlConnection()
cleanupSandbox(emptyTarget.dir)

// ---------------------------------------------------------------------------
// 4. T28：Clean Restore
// ---------------------------------------------------------------------------
report.section('4. T28 Clean Restore（恢复到一个全新数据目录）')
const target = isolateDatabase('m4-restore-target', { keep: true })
rmSync(target.dir, { recursive: true, force: true })
report.check('目标目录在恢复前**不存在**（才算"全新库"）', !existsSync(target.dir))
cpSync(backupDir, target.dir, { recursive: true })

await resetPluginSqlConnection()
const targetHarness = await createM4Harness({ label: 'restored' })
const snapshotB = await snapshotOf(targetHarness.store, owner)
const countsB = await countsOf(targetHarness.db, owner)
console.log(`  快照 B：${snapshotB.hash.slice(0, 16)}…（${snapshotB.entries.length} 条）`)

report.check(
  '**CanonicalSemanticSnapshot 哈希一致**（A == B）',
  snapshotA.hash === snapshotB.hash,
  `A=${snapshotA.hash.slice(0, 12)}… B=${snapshotB.hash.slice(0, 12)}…`
)
report.check(
  '计数逐项一致（记忆 / 状态分布 / 索引 / 事件）',
  JSON.stringify(countsA) === JSON.stringify(countsB),
  JSON.stringify({ A: countsA, B: countsB })
)

// 哈希不一致时，人要能立刻知道是**哪个字段**不同
if (snapshotA.hash !== snapshotB.hash) {
  const byId = new Map(snapshotB.entries.map((e) => [e.logicalId, e]))
  for (const a of snapshotA.entries) {
    const b = byId.get(a.logicalId)
    if (b === undefined) {
      console.log(`     · ${a.logicalId} 在恢复库里**不存在**`)
      continue
    }
    const aj = a as unknown as Record<string, unknown>
    const bj = b as unknown as Record<string, unknown>
    const keys = Object.keys(aj).filter((k) => stableStringify(aj[k]) !== stableStringify(bj[k]))
    if (keys.length > 0) console.log(`     · ${a.logicalId} 差异字段：${keys.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// 5. 恢复后的库必须自洽
// ---------------------------------------------------------------------------
report.section('5. 恢复后的库自洽（rebuild `A == B`）')
const rebuild = await targetHarness.store.rebuildCharacterMemories(owner)
report.check(
  '每条恢复出来的记忆都能从自己的事件流重放出相同状态',
  rebuild.memories > 0 && rebuild.mismatched === 0,
  `重建 ${rebuild.rebuilt}/${rebuild.memories}，不一致 ${rebuild.mismatched}`
)
const unsupportedB = await unsupportedMemories(targetHarness.db, owner)
report.check('恢复库 unsupported = 0', unsupportedB.length === 0, `${unsupportedB.length} 条`)
const contaminatedB = await contaminatedMemories(targetHarness.db, owner)
report.check('恢复库 contamination = 0', contaminatedB.length === 0, `${contaminatedB.length} 条`)

// 证据链反查必须仍然可用（provenance 真的被恢复了，而不是只恢复了计数）
const withEvidence = snapshotB.entries.find((e) => e.sourceRefs.length > 0)
const evidenceId = withEvidence?.sourceRefs[0]?.split(':').slice(1).join(':') ?? ''
const bySource = await targetHarness.store.listBySource({
  kind: 'conversation_event',
  id: evidenceId,
} as never)
report.check(
  '恢复库能按来源反查（provenance 可追溯）',
  withEvidence !== undefined && bySource.length > 0,
  `${bySource.length} 条`
)

// revision 链双向指针
const [oldId, newId] = corpus.revisionPair
const oldRecord = await targetHarness.store.get(oldId as never)
const newRecord = await targetHarness.store.get(newId as never)
report.check(
  '恢复后 supersede 双向指针仍成立',
  String(oldRecord?.supersededBy) === newId &&
    (newRecord?.supersedes ?? []).some((id) => String(id) === oldId),
  `old→${String(oldRecord?.supersededBy)} / new→${(newRecord?.supersedes ?? []).join(',')}`
)

// 逻辑遗忘 ≠ 物理删除：被忘掉的那条仍在库里
const retractedRecord = await targetHarness.store.get(corpus.retractedId as never)
report.check(
  '恢复后 retracted 的记忆仍在库里（逻辑遗忘，不是物理删除）',
  retractedRecord !== null && retractedRecord.status === 'retracted',
  `status=${String(retractedRecord?.status)}`
)

// 被忘掉的记忆不得出现在「正常有效事实」集合里
const activeSet = (await targetHarness.store.list({ owner, status: 'active', limit: 500 })).map(
  (r) => String(r.id)
)
report.check(
  'retracted 记忆不出现在 active 集合里（INV-04）',
  !activeSet.includes(corpus.retractedId)
)

// ---------------------------------------------------------------------------
// 6. 负控 B：改一个语义字段后哈希必须变
// ---------------------------------------------------------------------------
report.section('6. 负控 B（比较函数必须对语义字段敏感）')
const probe = snapshotB.entries[0]
await targetHarness.db.execute(
  sql`update memory_records set confidence = confidence - 0.5 where id = ${probe.logicalId}`
)
const snapshotMutated = await snapshotOf(targetHarness.store, owner)
report.check(
  '负控 B：改动一个语义字段后哈希改变',
  snapshotMutated.hash !== snapshotB.hash,
  `${snapshotB.hash.slice(0, 12)}… → ${snapshotMutated.hash.slice(0, 12)}…`
)
await targetHarness.db.execute(
  sql`update memory_records set confidence = ${probe.confidence} where id = ${probe.logicalId}`
)
const snapshotReverted = await snapshotOf(targetHarness.store, owner)
report.check(
  '负控 B：改回原值后哈希恢复一致（比较是确定性的）',
  snapshotReverted.hash === snapshotB.hash
)

// ---------------------------------------------------------------------------
// 7. T29：恢复后继续可运行
// ---------------------------------------------------------------------------
report.section('7. T29 恢复后继续运行（create / correct / forget）')
const newEvidence = await targetHarness.recordUserEvidence('我现在开始学钢琴了')
const created = await targetHarness.commitAndFold(
  targetHarness.makeCandidate(
    'preference',
    { kind: 'claim', subject: targetHarness.user, predicate: 'hobby.music', value: 'piano' },
    { sourceRefs: [newEvidence.ref] }
  ),
  M4_T0 + 10_000
)
report.check('恢复库上 create 成功', created !== null && created.status === 'active', String(created?.id))

const correctEvidence = await targetHarness.recordUserEvidence('说错了，我学的是小提琴')
const corrected = await targetHarness.commitAndFold(
  targetHarness.makeCandidate(
    'preference',
    { kind: 'claim', subject: targetHarness.user, predicate: 'hobby.music', value: 'violin' },
    { sourceRefs: [correctEvidence.ref] }
  ),
  M4_T0 + 11_000
)
await targetHarness.applyStateChange(
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
const afterSupersede = await targetHarness.store.get(created!.id)
report.check('恢复库上 correct（supersede）成功', afterSupersede?.status === 'superseded')

const forgetEvidence2 = await targetHarness.recordUserEvidence('忘掉我学小提琴这件事')
await targetHarness.applyStateChange(
  'retract',
  forgetEvidence2.ref.id,
  { memoryId: corrected!.id, reason: 'explicit_forget', note: '用户要求忘掉' },
  M4_T0 + 12_000
)
const afterForget = await targetHarness.store.get(corrected!.id)
report.check('恢复库上 forget（retract）成功', afterForget?.status === 'retracted')

const rerestore = await targetHarness.store.rebuildCharacterMemories(owner)
report.check('继续写入之后仍满足 `A == B`', rerestore.mismatched === 0, `不一致 ${rerestore.mismatched}`)

// ---------------------------------------------------------------------------
// 8. 落证据
// ---------------------------------------------------------------------------
const finalCounts = await countsOf(targetHarness.db, owner)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'restore-result.json'),
  `${JSON.stringify(
    {
      testId: 'M4-T27/T28/T29',
      name: 'Backup / Clean Restore / Application After Restore',
      priority: 'P0',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      sourceDir: source.dir,
      backupDir,
      restoredDir: target.dir,
      snapshotA: snapshotA.hash,
      snapshotB: snapshotB.hash,
      snapshotEmptyControl: snapshotE.hash,
      countsSource: countsA,
      countsRestored: countsB,
      countsAfterContinue: finalCounts,
      rebuild: { memories: rebuild.memories, mismatched: rebuild.mismatched },
      checks: {
        passed: report.passed,
        failed: report.failed,
        failures: report.failures,
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

await targetHarness.stop()
await resetPluginSqlConnection()
cleanupSandbox(source.dir)
cleanupSandbox(target.dir)
try {
  rmSync(backupDir, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

report.finish('M4 Backup / Restore')
