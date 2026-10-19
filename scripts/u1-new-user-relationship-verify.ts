/**
 * U1 · 新用户初始关系门（`u1:new-user-relationship:verify`）—— WP3 / `ADR-136` 方案 A
 *
 * 归属：多用户补充计划 U1（[ADR-136](../../docs/adr/ADR-136-new-user-initial-relationship.md)，2026-10-14 原主人裁定采用方案 A）。
 *
 * 隔离库 + 零模型 / 零出网。判据围绕四件事：
 *   ① **值**：新用户 = 0.2 / 0.2（来自 `NEW_USER_INITIAL_RELATIONSHIP`，一处定义）
 *   ② **来源**：`originKind = NEW_USER_BASELINE`（不是 SETTING_BASELINE，也不是 INTERACTION_DERIVED）
 *   ③ **不继承 / 不重置**：原主人仍是 0.85/0.60；新用户各自的投影互不影响；重复播种 ⇒ no-op
 *   ④ **契约闭集**：五值具名闭集；`MAINTENANCE_INJECTION` 仍失败关闭
 *
 * 三段式：正控（两条路径各自的值与来源）· 负控（**用错播种函数会被读数抓住**）· 恢复。
 */

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

// ---------------------------------------------------------------------------
// 后端闸：目录沙箱要求 PGlite（与其它 U1/S1 隔离门同形）
// ---------------------------------------------------------------------------
{
  const { config: loadDotenv } = await import('dotenv')
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  let envDir = process.cwd()
  while (!existsSync(join(envDir, '.env')) && dirname(envDir) !== envDir) envDir = dirname(envDir)
  loadDotenv({ path: join(envDir, '.env'), quiet: true })
  const { databaseBackendEnvironmentFrom, resolveDatabaseBackend } = await import(
    '../src/infrastructure/persistence/database-backend.ts'
  )
  if (resolveDatabaseBackend(databaseBackendEnvironmentFrom()).backend === 'postgres') {
    console.log('')
    console.log('  [NOT RUN] u1:new-user-relationship:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     本门用目录沙箱（PGlite）；.env 的 CHARACTER_DB_BACKEND=postgres 会让 initDatabase 重读 .env。')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

// 隔离必须在任何会碰数据库的 import 之前
const runId = `u1-new-user-rel-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-new-user-relationship', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
type Character = import('../src/infrastructure/runtime/eliza-types.ts').Character

const { character } = await import('../src/character/index.ts')
const { initDatabase } = await import('../src/db/index.ts')
const { initKernel } = await import('../src/kernel/app/kernel.ts')
const { characterDefinitionFromCharacter } = await import('../src/infrastructure/runtime/seed-projection.ts')
const {
  seedRelationshipOrigin,
  seedRelationshipOriginForNewUser,
} = await import('../src/infrastructure/runtime/adapters.ts')
const { getRelationshipProjection } = await import('../src/infrastructure/persistence/relationship-store.ts')
const { RELATIONSHIP_ORIGIN_KINDS, originKindAcceptedByM7, NEW_USER_INITIAL_RELATIONSHIP } = await import(
  '../src/kernel/contracts/index.ts'
)
const { entityRef } = await import('../src/kernel/contracts/entity.ts')

interface Check {
  readonly id: string
  readonly label: string
  readonly pass: boolean
  readonly detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const runtime = createThinHostRuntime({
      character: character,
      settings: {},
    })
await initDatabase(runtime)
await runtime.initialize()
const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
const db = kernel.stores.db
const characterId = String(kernel.characterId)

const NEW_USER = 'u1-new-user-fixture'
const OWNER = 'u1-owner-fixture'

const projectionOf = (userId: string) =>
  getRelationshipProjection(db, kernel.characterId, entityRef('user', userId))

// ===========================================================================
// T1 正控 · 新用户：值 0.2/0.2 + 来源 NEW_USER_BASELINE
// ===========================================================================
{
  const outcome = await seedRelationshipOriginForNewUser(runtime, characterId, NEW_USER)
  const projection = await projectionOf(NEW_USER)
  record(
    'T1.1',
    '新用户播种成功，且理由里写明来源是 NEW_USER_BASELINE',
    outcome.seeded === true && outcome.reason.includes('NEW_USER_BASELINE'),
    `seeded=${String(outcome.seeded)} · reason=${outcome.reason}`
  )
  record(
    'T1.2',
    `值是 0.2 / 0.2（来自 NEW_USER_INITIAL_RELATIONSHIP = ${String(NEW_USER_INITIAL_RELATIONSHIP.trust)}/${String(NEW_USER_INITIAL_RELATIONSHIP.closeness)}）`,
    projection?.state.trust === NEW_USER_INITIAL_RELATIONSHIP.trust &&
      projection?.state.closeness === NEW_USER_INITIAL_RELATIONSHIP.closeness,
    `trust=${String(projection?.state.trust)} · closeness=${String(projection?.state.closeness)}`
  )
  record(
    'T1.3',
    '来源种类是 NEW_USER_BASELINE（不是 SETTING_BASELINE / INTERACTION_DERIVED）',
    projection?.state.originKind === 'NEW_USER_BASELINE',
    `originKind=${String(projection?.state.originKind)}`
  )
  record(
    'T1.4',
    '已建档（originated=true）⇒ 后续 IMPACT 才有得可折叠（reducer 的硬闸）',
    projection?.state.originated === true,
    `originated=${String(projection?.state.originated)}`
  )
}

// ===========================================================================
// T2 正控 · 原主人路径**未变**：仍是 0.85/0.60 + SETTING_BASELINE
// ===========================================================================
{
  const outcome = await seedRelationshipOrigin(runtime, characterId, OWNER)
  const projection = await projectionOf(OWNER)
  record(
    'T2.1',
    '原主人仍是 0.85 / 0.60 + SETTING_BASELINE（U1 的引入没有改这条路径）',
    outcome.seeded === true &&
      projection?.state.trust === 0.85 &&
      projection?.state.closeness === 0.6 &&
      projection?.state.originKind === 'SETTING_BASELINE',
    `trust=${String(projection?.state.trust)} · closeness=${String(projection?.state.closeness)} · kind=${String(projection?.state.originKind)}`
  )
  record(
    'T2.2',
    '两个用户各自一份投影，互不影响（新用户没被写成 0.85/0.60）',
    (await projectionOf(NEW_USER))?.state.trust === 0.2 && (await projectionOf(NEW_USER))?.state.closeness === 0.2,
    `新用户 trust=${String((await projectionOf(NEW_USER))?.state.trust)}`
  )
}

// ===========================================================================
// T3 负控 · 幂等：重复播种 no-op，值**不被重置**
// ===========================================================================
{
  const before = (await projectionOf(NEW_USER))?.revision
  const again = await seedRelationshipOriginForNewUser(runtime, characterId, NEW_USER)
  const after = (await projectionOf(NEW_USER))?.revision
  record(
    'T3.1',
    '重复播种 ⇒ no-op（投影已存在），revision 不变、值不被重置',
    again.seeded === false && after === before,
    `seeded=${String(again.seeded)} · reason=${again.reason} · revision ${String(before)}→${String(after)}`
  )
}

// ===========================================================================
// T4 负控（拆防线）· **用错播种函数会被读数抓住**
// ===========================================================================
{
  const wrong = 'u1-wrong-seed-fixture'
  // 故意用"原主人播种器"给一个新用户建档 —— 这正是"忘了分叉来源/值"的形状
  await seedRelationshipOrigin(runtime, characterId, wrong)
  const projection = await projectionOf(wrong)
  record(
    'T4.1',
    '拆防线 · 用原主人播种器建新用户 ⇒ 值/来源**真的**会错成 0.85/0.60 + SETTING_BASELINE（证明分叉在被量）',
    projection?.state.trust === 0.85 && projection?.state.originKind === 'SETTING_BASELINE',
    `trust=${String(projection?.state.trust)} · kind=${String(projection?.state.originKind)}`
  )
  // 恢复：用正确的播种器 ⇒ 新用户拿到 0.2/0.2 + NEW_USER_BASELINE
  const restored = 'u1-restored-fixture'
  await seedRelationshipOriginForNewUser(runtime, characterId, restored)
  const restoredProjection = await projectionOf(restored)
  record(
    'T4.2',
    '恢复 · 正确的播种器给出 0.2/0.2 + NEW_USER_BASELINE',
    restoredProjection?.state.trust === 0.2 && restoredProjection?.state.originKind === 'NEW_USER_BASELINE',
    `trust=${String(restoredProjection?.state.trust)} · kind=${String(restoredProjection?.state.originKind)}`
  )
}

// ===========================================================================
// T5 契约闭集（与 m7:wp2:contracts 同源，但这里再自检一次）
// ===========================================================================
{
  const expected = ['SETTING_BASELINE', 'INTERACTION_DERIVED', 'MAINTENANCE_INJECTION', 'STORY_DERIVED', 'NEW_USER_BASELINE']
  const exact =
    RELATIONSHIP_ORIGIN_KINDS.length === expected.length &&
    expected.every((kind) => (RELATIONSHIP_ORIGIN_KINDS as readonly string[]).includes(kind))
  record('T5.1', 'originKind 是五值**具名**闭集', exact, `${String(RELATIONSHIP_ORIGIN_KINDS.length)} 值`)
  record(
    'T5.2',
    'NEW_USER_BASELINE 被放行口接受；MAINTENANCE_INJECTION 仍失败关闭',
    originKindAcceptedByM7('NEW_USER_BASELINE') === true && originKindAcceptedByM7('MAINTENANCE_INJECTION') === false,
    `newUser=${String(originKindAcceptedByM7('NEW_USER_BASELINE'))} · injection=${String(originKindAcceptedByM7('MAINTENANCE_INJECTION'))}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:new-user-relationship:verify = ${passed ? 'PASS' : 'FAIL'}`)
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
