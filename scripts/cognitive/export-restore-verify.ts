/**
 * 认知能力建设 · **最小导出/恢复样本**的门（2026-10-21 · 计划 P0.5）
 *
 * ============================================================================
 *  它验什么
 * ============================================================================
 *  计划 §3 P0.5 逐字要求：「在隔离合成角色上建立最小导出/恢复样本：身份、
 *  记忆资格、关系情绪、目标承诺、已撤回根和现有 EBL 状态。后续随新类型扩展。」
 *
 *  ⇒ 本门在**隔离测试库**里造一个**合成角色**，让它带上那六类状态，
 *    然后做一次**逻辑导出 → 恢复到另一个空库 → 再导出 → 逐字比对**。
 *
 *  ⚠️ **每个场景一个独立进程 + 一个独立空白库**
 *     （PostgreSQL 后端下 `isolateDatabase()` 给不出空白库 ⇒ 场景之间会互相污染；
 *      产品那条"同进程只允许一个 PostgreSQL 目标"的不变量**一字未动**）。
 *     场景之间靠**文件**交换（导出文档落在 `artifacts/cognitive/local/`）。
 *
 * ============================================================================
 *  场景
 * ============================================================================
 *  · `export`         —— 造合成角色 → 导出 → 落盘
 *  · `restore`        —— 读导出 → 恢复到**本场景的空白库** → 再导出 → 逐字比对
 *  · `negative-empty` —— 负控：空角色（只有 Seed）的摘要 **≠** 合成角色的摘要
 *  · `negative-mutate`—— 负控：改一个字段 ⇒ 摘要必须变（判据真的在测东西）
 *
 * ============================================================================
 *  ⚠️ 负控与收益任务分开（计划 §3 P2 末段的要求）
 * ============================================================================
 *  负控不证明"恢复是好的"，只证明"比较函数能失败" —— 没有负控的绿没有信息量。
 *
 *  用法：pnpm cognitive:export:restore:verify
 *        pnpm gates:pg:scenario -- scripts/cognitive/export-restore-verify.ts
 * ============================================================================
 */

import 'dotenv/config'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import { isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'

import { insertProjection } from '../../src/infrastructure/persistence/event-store.ts'
import { buildStandardCorpus, createM4Harness, createReporter } from '../m4-harness.ts'
import { AFFECT_PROJECTION_TYPE, type AffectState } from '../../src/kernel/contracts/affect.ts'
import {
  relationshipProjectionType,
  type RelationshipState,
} from '../../src/kernel/contracts/relationship.ts'
import {
  goalRowKeyOf,
  type CommitmentState,
  type GoalRowState,
  type GoalState,
} from '../../src/kernel/contracts/goal.ts'
import { EBL_POLICY, EBL_VERSION, type EblClaim, type EblObservation, type EblState } from '../../src/kernel/contracts/epistemic-belief.ts'
import { RELATIONSHIP_REDUCER_VERSION } from '../../src/kernel/projections/relationship.ts'
import { AFFECT_REDUCER_VERSION } from '../../src/kernel/projections/affect.ts'
import { GOAL_REDUCER_VERSION } from '../../src/kernel/projections/goal.ts'
import {
  EXPORT_FORMAT,
  exportCognitiveState,
  exportDigest,
  restoreCognitiveState,
  type CognitiveExport,
} from './export-restore.ts'

const report = createReporter()
const ARTIFACT_DIR = join(process.cwd(), 'artifacts', 'cognitive', 'local')
const EXPORT_FILE = join(ARTIFACT_DIR, 'export.json')
const RESTORE_FILE = join(ARTIFACT_DIR, 'restore-export.json')

/*
 * ⚠️ `--list-cases` 必须在**隔离之前**：逐场景 harness 直接读 stdout，
 *    `isolateDatabase()` 的横幅会被当成一个"场景"。
 */
if (process.argv.includes('--list-cases')) {
  console.log('export\t0')
  console.log('restore\t0')
  console.log('negative-empty\t0')
  console.log('negative-mutate\t0')
  process.exit(0)
}

isolateDatabase('cognitive-export-restore')
await resetPluginSqlConnection()

const SCENARIOS: Array<{ id: string; run: () => Promise<void> }> = [
  { id: 'export', run: scenarioExport },
  { id: 'restore', run: scenarioRestore },
  { id: 'negative-empty', run: scenarioNegativeEmpty },
  { id: 'negative-mutate', run: scenarioNegativeMutate },
]

const argv = process.argv.slice(2)
const caseIndex = argv.indexOf('--case')
const onlyCase = caseIndex >= 0 ? argv[caseIndex + 1] : undefined
const selected = onlyCase === undefined ? SCENARIOS : SCENARIOS.filter(s => s.id === onlyCase)
if (selected.length === 0) {
  console.error(`❌ 没有这个场景：${String(onlyCase)}`)
  console.error(`   可用：${SCENARIOS.map(s => s.id).join(' / ')}`)
  process.exit(2)
}

for (const scenario of selected) await scenario.run()

report.finish('认知能力建设 · 最小导出/恢复样本')

// ===========================================================================
// 场景实现
// ===========================================================================

/** 造一个带六类状态的**合成角色** */
async function buildSyntheticRole (): Promise<{ db: unknown; characterId: string; owner: unknown; user: unknown }> {
  const harness = await createM4Harness({ label: 'cognitive-export' })
  const { owner, user, db, characterId } = harness

  // ① **身份**：Seed 由 `initKernel` 建档（`createM4Harness` 内部）⇒
  //    `character_definitions` / `character_definition_versions` 里有行。
  // ② **记忆资格** + ⑤ **已撤回根**：
  //    M4 标准语料覆盖 create / supersede / retract / dispute / episode
  //    ⇒ `memory_records` 四种状态齐全，`memory_evidence_links` 里有根，
  //    被撤回的那条记忆的根就是"已撤回根"。
  await buildStandardCorpus(harness)

  const now = Date.now()

  // ③ **关系情绪**：关系投影（`relationship:user:<id>`）
  const relationshipState: RelationshipState = {
    originated: true,
    trust: 0.5,
    closeness: 0.4,
    originKind: 'INTERACTION_DERIVED',
    lastInteractionAt: now as never,
    accusationsInCase: [],
  }
  await insertProjection(
    db as never,
    {
      characterId: characterId as never,
      projectionType: relationshipProjectionType(user as never),
      revision: 1,
      reducerVersion: RELATIONSHIP_REDUCER_VERSION,
      state: relationshipState,
      updatedAt: now as never,
    },
    now
  )

  // ③ **关系情绪**（另一半）：情绪投影（`affect:character`）
  const affectState: AffectState = {
    originated: true,
    valence: 0.3,
    arousal: 0.2,
    originKind: 'TEST_FIXTURE',
    lastInteractionAt: now as never,
    lastAffectEventAt: now as never,
    lastDomainEventId: null,
    cutoverSequence: null,
  }
  await insertProjection(
    db as never,
    {
      characterId: characterId as never,
      projectionType: AFFECT_PROJECTION_TYPE,
      revision: 1,
      reducerVersion: AFFECT_REDUCER_VERSION,
      state: affectState,
      updatedAt: now as never,
    },
    now
  )

  // ④ **目标承诺**：目标投影行（`goal:<goalId>`，承诺住在行里）
  const goalId = `goal-cognitive-export-sample` as never
  const goalState: GoalState = {
    goalId,
    characterId: String(characterId),
    owner: owner as never,
    origin: 'user_requested',
    sourceRefs: [],
    revision: 1,
    statement: '把这份导出/恢复样本跑通一次',
    successCriterion: { kind: 'action_result', capability: 'sandbox.file.write', operation: 'write', require: 'executed_succeeded' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
    time: { recordedAt: now as never },
  }
  const commitmentState: CommitmentState = {
    commitmentId: `commitment-cognitive-export-sample` as never,
    goalId,
    actor: owner as never,
    beneficiary: user as never,
    scope: '把导出/恢复样本跑通一次',
    acceptedAt: now as never,
    acceptanceRefs: [],
    criterion: goalState.successCriterion,
    status: 'active',
    completionRefs: [],
    revision: 1,
  }
  const goalRow: GoalRowState = { goal: goalState, commitment: commitmentState }
  await insertProjection(
    db as never,
    {
      characterId: characterId as never,
      projectionType: goalRowKeyOf(String(goalId)),
      revision: 1,
      reducerVersion: GOAL_REDUCER_VERSION,
      state: goalRow,
      updatedAt: now as never,
    },
    now
  )

  // ⑥ **EBL 状态**：EBL 投影（`ebl:<claimId>`）
  const formation: EblObservation = {
    ref: { kind: 'conversation', id: 'cev:cognitive-export-sample' },
    characterId: String(characterId),
    subjectId: String((user as { id: unknown }).id),
    episodeId: 'episode-cognitive-export-sample',
    bindingKey: 'binding-cognitive-export-sample',
    environment: 'serversim',
    targetId: 'target-cognitive-export-sample',
    observedAt: now,
    independentKey: 'independent-cognitive-export-sample',
    revision: 'rev-1',
    rootIds: ['root-cognitive-export-sample'],
    usable: true,
    witnessed: true,
    executed: false,
    complete: true,
    value: 'execute',
    influencedBy: [],
  }
  const claim: EblClaim = {
    id: 'claim-cognitive-export-sample',
    characterId: String(characterId),
    subjectId: String((user as { id: unknown }).id),
    domain: 'tool',
    predicate: 'task_intent',
    expected: 'execute',
    scope: 'serversim',
    environment: 'serversim',
    conditions: {},
    formation: formation.ref,
    policy: EBL_POLICY,
  }
  const eblState: EblState = {
    claim,
    formation,
    status: 'pending',
    formedAt: now,
    tests: [],
    evidence: [],
    uses: [],
  }
  await insertProjection(
    db as never,
    {
      characterId: characterId as never,
      projectionType: `ebl:${claim.id}`,
      revision: 1,
      reducerVersion: EBL_VERSION,
      state: eblState,
      updatedAt: now as never,
    },
    now
  )

  return { db, characterId: String(characterId), owner, user }
}

async function scenarioExport (): Promise<void> {
  report.section('export｜造合成角色并导出')
  const { db } = await buildSyntheticRole()
  const doc = await exportCognitiveState(db as never)
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(EXPORT_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

  report.check('导出格式正确', doc.format === EXPORT_FORMAT, doc.format)
  report.check('摘要已算出', /^[0-9a-f]{64}$/.test(doc.digest), doc.digest)

  // 六类状态**逐项**在场（每类至少一行）
  const rowsOf = (table: string): number => doc.tables.find(t => t.name === table)?.rows.length ?? 0
  const projectionTypes = new Set(
    (doc.tables.find(t => t.name === 'character_projections')?.rows ?? []).map(row =>
      String(row.projection_type ?? '')
    )
  )
  report.check('① 身份：Seed 在案', rowsOf('character_definitions') > 0, `${String(rowsOf('character_definitions'))} 行`)
  report.check('② 记忆资格：记忆记录在案', rowsOf('memory_records') > 0, `${String(rowsOf('memory_records'))} 行`)
  report.check('③ 关系情绪：关系 + 情绪投影在案',
    [...projectionTypes].some(t => t.startsWith('relationship:')) && projectionTypes.has(AFFECT_PROJECTION_TYPE),
    [...projectionTypes].join(', '))
  report.check('④ 目标承诺：目标投影在案',
    [...projectionTypes].some(t => t.startsWith('goal:')),
    [...projectionTypes].filter(t => t.startsWith('goal:')).join(', '))
  report.check('⑤ 已撤回根：证据关联在案', rowsOf('memory_evidence_links') > 0, `${String(rowsOf('memory_evidence_links'))} 行`)
  report.check('⑥ EBL 状态：EBL 投影在案',
    [...projectionTypes].some(t => t.startsWith('ebl:')),
    [...projectionTypes].filter(t => t.startsWith('ebl:')).join(', '))
}

async function scenarioRestore (): Promise<void> {
  report.section('restore｜恢复到本场景的空白库并再导出比对')
  let doc: CognitiveExport
  try {
    doc = JSON.parse(readFileSync(EXPORT_FILE, 'utf8')) as CognitiveExport
  } catch (error) {
    report.check('读得到导出文档', false, error instanceof Error ? error.message : String(error))
    return
  }
  report.check('读得到导出文档', doc.format === EXPORT_FORMAT, doc.format)

  const harness = await createM4Harness({ label: 'cognitive-restore' })
  // ⚠️ 恢复前先确认这个库**是空的**（否则"恢复后一样"可能是"本来就一样"）
  const before = await exportCognitiveState(harness.db as never)
  const beforeRows = before.tables.reduce((sum, table) => sum + table.rows.length, 0)
  report.check('恢复目标是**空白库**（恢复前只有 Seed 一类行）', beforeRows <= 2, `${String(beforeRows)} 行`)

  await restoreCognitiveState(harness.db as never, doc)

  const after = await exportCognitiveState(harness.db as never)
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(RESTORE_FILE, `${JSON.stringify(after, null, 2)}\n`, 'utf8')

  report.check('恢复后的摘要 = 原来的摘要', after.digest === doc.digest, `${doc.digest.slice(0, 12)}… vs ${after.digest.slice(0, 12)}…`)
  const sameTables = JSON.stringify(after.tables.map(t => ({ name: t.name, columns: t.columns, rows: t.rows }))) ===
    JSON.stringify(doc.tables.map(t => ({ name: t.name, columns: t.columns, rows: t.rows })))
  report.check('恢复后逐表逐行与原来**一致**', sameTables, sameTables ? '逐字一致' : '有差异')
  await harness.stop()
}

async function scenarioNegativeEmpty (): Promise<void> {
  report.section('negative-empty｜负控：空角色的摘要必须不同')
  let doc: CognitiveExport
  try {
    doc = JSON.parse(readFileSync(EXPORT_FILE, 'utf8')) as CognitiveExport
  } catch (error) {
    report.check('读得到导出文档', false, error instanceof Error ? error.message : String(error))
    return
  }
  // 只有 Seed（`initKernel` 建档），没有语料、没有投影
  const harness = await createM4Harness({ label: 'cognitive-empty' })
  const empty = await exportCognitiveState(harness.db as never)
  report.check('负控：空角色的摘要 **≠** 合成角色的摘要', empty.digest !== doc.digest,
    `${empty.digest.slice(0, 12)}… vs ${doc.digest.slice(0, 12)}…`)
  await harness.stop()
}

async function scenarioNegativeMutate (): Promise<void> {
  report.section('negative-mutate｜负控：改一个字段 ⇒ 摘要必须变')
  let doc: CognitiveExport
  try {
    doc = JSON.parse(readFileSync(EXPORT_FILE, 'utf8')) as CognitiveExport
  } catch (error) {
    report.check('读得到导出文档', false, error instanceof Error ? error.message : String(error))
    return
  }
  const memoryTable = doc.tables.find(table => table.name === 'memory_records')
  if (memoryTable === undefined || memoryTable.rows.length === 0) {
    report.check('负控前提：导出里有记忆记录', false, 'memory_records 为空')
    return
  }
  const mutated: CognitiveExport = {
    ...doc,
    tables: doc.tables.map(table => {
      if (table.name !== 'memory_records') return table
      const rows = table.rows.map((row, index) => (index === 0 ? { ...row, status: 'tampered' } : row))
      return { ...table, rows }
    }),
  }
  const mutatedDigest = exportDigest(mutated.tables)
  report.check('负控：改一个字段后摘要**变了**', mutatedDigest !== doc.digest,
    `${doc.digest.slice(0, 12)}… → ${mutatedDigest.slice(0, 12)}…`)
}
