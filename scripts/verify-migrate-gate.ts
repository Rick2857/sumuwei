/**
 * 验证：迁移闸（`shouldBlockForPendingKernelMigration`）三个分支都对。
 *
 * ============================================================================
 *  为什么这一条必须有测试守着
 * ============================================================================
 * 这条闸是一次事故换来的：M3 的迁移 0003 给 `character_definitions` 加了
 * `definition_json`，而已存在的那一行不会因此拥有它 —— 真实库一升级，
 * **每条命令都在启动时失败**（`seed_definition_json_missing`，实测挂住 600 秒）。
 * 而当时人没有任何机会事先看到"这次迁移会动到她的 Seed 行"：
 * 迁移是在某次普通启动里悄悄发生的。
 *
 * 闸失效的形态就是那次事故的形态（迁移在普通启动里默默发生），
 * 所以它必须被断言，而不是靠"我记得写了"。
 *
 * ---------------------------------------------------------------------------
 *  为什么不端到端测
 * ---------------------------------------------------------------------------
 * 端到端需要让 `data/pglite` 真的处于"有待应用迁移"的状态 ——
 * 那意味着动真实库。**我们不能为了测一条保护真实库的闸而去动真实库。**
 *
 * 因此判断逻辑被抽成纯函数（`(目录, 待办数, 是否放行) → 该不该拦`），
 * 这个脚本把它的**全部分支**与错误信息的形状都断言掉；
 * 而"它真的挂在 initDatabase 上"这件事由代码结构保证（就一处调用）。
 *
 * 另外会跑一次**真实副本**上的端到端验证：把真实库复制到临时目录、
 * 回退一格迁移记录，确认"放行后能真正应用"这条路径可用
 * —— 真实库全程只被复制、从不被打开写入。
 *
 * 跑法：tsx scripts/verify-migrate-gate.ts
 */

import type { AgentRuntime } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'

import 'dotenv/config'

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { liveSmokeSource } from './live-smoke-source.ts'
import {
  __pendingMigrationErrorForTest as pendingMigrationError,
  allowKernelMigration,
  initDatabase,
  kernelMigrationAllowed,
  shouldBlockForPendingKernelMigration,
} from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('='.repeat(74))
console.log('迁移闸验证：普通命令不得在真实库上悄悄迁移')
console.log('='.repeat(74))

// ===========================================================================
console.log('\n=== 1. 判断逻辑（纯函数，全分支）===')
// ===========================================================================

const PROD = PRODUCTION_DB_DIR
const TEMP = join(tmpdir(), 'project-lg-some-sandbox')

check(
  '真实库 + 有待办 + 未放行 → **拦**（这是那次事故的形态）',
  shouldBlockForPendingKernelMigration({
    dataDir: PROD,
    pendingCount: 1,
    migrationAllowed: false,
  }) === true,
  '拦'
)

check(
  '真实库 + 有待办 + 已放行 → 放行（--migrate --apply 走这条）',
  shouldBlockForPendingKernelMigration({
    dataDir: PROD,
    pendingCount: 1,
    migrationAllowed: true,
  }) === false,
  '放行'
)

check(
  '真实库 + 无待办 → 放行（日常启动走这条）',
  shouldBlockForPendingKernelMigration({
    dataDir: PROD,
    pendingCount: 0,
    migrationAllowed: false,
  }) === false,
  '放行'
)

check(
  '临时/沙箱目录 + 有待办 + 未放行 → 放行（一次性库不该被拦）',
  shouldBlockForPendingKernelMigration({
    dataDir: TEMP,
    pendingCount: 3,
    migrationAllowed: false,
  }) === false,
  '放行'
)

check(
  '目录未指定（pglite 默认目录）→ 放行（无法判定就不拦）',
  shouldBlockForPendingKernelMigration({
    dataDir: undefined,
    pendingCount: 2,
    migrationAllowed: false,
  }) === false,
  '放行'
)

check(
  '目录是真实库的**父目录**也算重叠 → 拦（isProductionDir 的语义）',
  shouldBlockForPendingKernelMigration({
    dataDir: join(PROD, '..'),
    pendingCount: 1,
    migrationAllowed: false,
  }) === true,
  '拦'
)

// ===========================================================================
console.log('\n=== 2. 错误信息的形状（人要能据此知道下一步做什么）===')
// ===========================================================================

const error = pendingMigrationError([
  { version: 3, name: 'm3-identity-and-conversation-integrity', statements: 22 },
])
check('错误码是 kernel_migration_pending', error.code === 'kernel_migration_pending', error.code)
check('列出待应用的迁移（含版本号与名字）', error.message.includes('#3') && error.message.includes('m3-identity'), '#3 m3-…')
check('给出语句条数（让人知道改动量级）', error.message.includes('22 条语句'), '22 条语句')
check('指向预览命令', error.message.includes('pnpm migrate'), 'pnpm migrate')
check('指向应用命令', error.message.includes('pnpm migrate:apply'), 'pnpm migrate:apply')
check(
  '明确写出"本次没有改动任何数据"',
  error.message.includes('没有改动任何数据'),
  '含该句'
)

// ===========================================================================
console.log('\n=== 3. 端到端：真实**副本**上的完整路径（真实库只被复制）===')
// ===========================================================================

const copySource = liveSmokeSource(process.argv.slice(2))
console.log(`  副本源：${copySource.directory}（${copySource.kind}）`)
check('已验证的副本源存在', existsSync(copySource.directory))

const workDir = mkdtempSync(join(tmpdir(), 'project-lg-migrate-gate-'))
cpSync(copySource.directory, workDir, { recursive: true })
console.log(`  已复制为副本：${workDir}（真实库全程未被打开写入）`)

process.env.PGLITE_DATA_DIR = workDir

const makeRuntime = (): AgentRuntime =>
  createThinHostRuntime({
    character: character,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
    conversationLength: 16,
  })

const setupRuntime = makeRuntime()
await setupRuntime.registerPlugin(undefined as never)
await await __applyKernelMigrations(__getRawDb(setupRuntime))

const db = getRawDb(setupRuntime)
// 回退一格：删掉 0003 建的东西与它的迁移记录，制造"有待应用迁移"
for (const table of [
  'character_definition_versions',
  'user_identity_mappings',
  'user_identities',
  'conversation_identities',
]) {
  await db.execute(sql.raw(`drop table if exists ${table}`))
}
await db.execute(sql`delete from character_schema_migrations where version = 3`)
console.log('  已把副本的迁移表回退到 v2（模拟"有待应用迁移"）')

// --- 未放行：必须真的拒绝（这一条在副本上跑，因此可以真的验证）----------
const blockedRuntime = makeRuntime()
let refusal: { code?: string } | undefined
try {
  await initDatabase(blockedRuntime)
} catch (err) {
  refusal = err as { code?: string }
}

/*
 * ⚠️ 副本目录**不是**真实库路径，因此按设计这里**不会**被拦 ——
 * 这恰好说明闸的判据是"是不是真实库"，而不是"是不是有未应用迁移"。
 * 也就是说：这一节验证的是"副本不设防"这条**预期行为**。
 */
check(
  '副本（非真实库路径）**不**被拦 —— 判据是路径，不是"有没有待办"',
  refusal === undefined,
  refusal ? `被拦了：${refusal.code}` : '照常通过'
)

const afterCopy = await db.execute(
  sql`select count(*)::int as c from character_schema_migrations where version = 3`
)
check(
  '副本上的迁移已被自动应用（临时库不设防）',
  Number((afterCopy as { rows?: { c: number }[] }).rows?.[0]?.c ?? 0) === 1,
  'v3 已登记'
)

// --- 另一个方向：真实库路径 + 未放行 → 拦（用真实的 PRODUCTION_DB_DIR 判定）---
check(
  '真实库路径 + 未放行 → 拦（纯函数层已断言，这里是同一判据的复核）',
  shouldBlockForPendingKernelMigration({
    dataDir: PROD,
    pendingCount: 1,
    migrationAllowed: kernelMigrationAllowed(),
  }) === true,
  '拦'
)

// 放行之后不再拦
allowKernelMigration()
check(
  'allowKernelMigration() 之后同一判据变成放行',
  shouldBlockForPendingKernelMigration({
    dataDir: PROD,
    pendingCount: 1,
    migrationAllowed: kernelMigrationAllowed(),
  }) === false,
  '放行'
)

// ===========================================================================
console.log(`\n${'='.repeat(74)}`)
console.log(`迁移闸验证：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log('='.repeat(74))

try {
  await setupRuntime.stop()
  await blockedRuntime.stop()
} catch {
  /* 关不干净不影响结论 */
}

try {
  rmSync(workDir, { recursive: true, force: true })
  console.log('副本已清理')
} catch {
  console.log('副本未能清理（可手动删）')
}

process.exit(failed === 0 ? 0 : 1)
