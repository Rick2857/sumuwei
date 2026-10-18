/**
 * 门：薄宿主与 `initDatabase()` 的**装配闭环**。
 *
 * ⚠️ 这道门补的是一个真实漏检：第一次启用薄宿主时，核心报
 *    「拿不到底层数据库句柄：plugin-sql 尚未注册适配器」⇒ `no_db_handle`。
 *    根因：`buildRuntime` 里写成 `if (thinHostEnabled()) { … return thin }`，
 *    **提前 return** ⇒ 后面的 `initDatabase` / 生产状态机 / `buildKernel` 全被跳过。
 *
 *    前两道门都没抓到它：
 *      · 语义等价门**直接 new ThinHostRuntime**，不走 buildRuntime
 *      · 接线门**只检查工厂产出**，不检查 buildRuntime 的控制流
 *    ⇒ 这道门断言的是**真实控制流**：薄宿主下 initDatabase 必须跑通、
 *      且必须注册出带 `db.execute` 的 adapter。
 *
 * 断言：
 *   I1  `initDatabase(薄宿主)` 成功返回，且 `adapter` 有可用的 db.execute
 *   I2  返回后 `getRawDb(薄宿主)` 能取到句柄（这正是崩溃点）
 *   I3  已就绪 schema 下不触发 runPluginMigrations（薄宿主不会因此抛错）
 *   I4  `buildRuntime` 的薄宿主分支**不提前 return**（静态结构判据：
 *       薄宿主分支里不得出现 `return thin`）
 *
 * ⚠️ 全程隔离：只用隔离测试库（lg_test_ 前缀）。
 */

import { stringToUuid } from '@elizaos/core'
import pg from 'pg'

import { ThinHostRuntime, thinLogger } from '../src/infrastructure/runtime/thin-host.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

// --- 安全轨 ---
const pgUrl = (() => {
  const a = process.argv.find((x) => x.startsWith('--pg-url='))
  return a === undefined ? '' : a.slice('--pg-url='.length)
})()
if (pgUrl === '') { console.error('必须提供 --pg-url=<隔离测试库 URL>'); process.exit(2) }
const dbName = decodeURIComponent(new URL(pgUrl).pathname.replace(/^\//, ''))
if (!dbName.startsWith('lg_test_') || dbName === 'sumuwei') {
  console.error(`拒绝：目标库 "${dbName}" 不是隔离测试库`); process.exit(3)
}

// --- I4 静态结构判据：薄宿主分支不得在函数体里提前 return ---
//
// ⚠️⚠️ **这是本仓库 `L-QQP-09` 同型坑的第 N 次复发**：判据被**我自己写的注释**打败。
//    补丁里的说明文字正是 `` `if (thinHostEnabled()) { … return thin }` ``，
//    而判据正则 `/if\s*\(\s*thinHostEnabled\(\)\s*\)\s*\{[^}]*return\s+thin/`
//    会把**这行注释**当成真代码命中 ⇒ 第一版门在这里报了假失败。
//
//    ⇒ 修法（也是本仓库的既定纪律）：**判据只落在非注释行上**。
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  // 剥掉块注释与行注释，再判。
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n')
  const start = codeOnly.indexOf('async function buildRuntime')
  const end = codeOnly.indexOf('\nasync function ', start + 10)
  const fnBody = start === -1 ? '' : codeOnly.slice(start, end === -1 ? undefined : end)
  const earlyReturn = /if\s*\(\s*thinHostEnabled\(\)\s*\)\s*\{[^}]*return\s+thin/.test(fnBody)
  check(
    'I4-no-early-return',
    fnBody !== '' && earlyReturn === false,
    'buildRuntime 的**代码行**里没有 `if (thinHostEnabled()) { … return thin }` 提前返回（注释已剥离）'
  )
}

// --- I1/I2/I3 装配闭环 ---
const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })
const { character } = await import('../src/character/index.ts')
const { initDatabase, allowKernelMigration } = await import('../src/db/index.ts')
const { closeDatabaseConnection } = await import('../src/infrastructure/persistence/runtime-shutdown.ts')

allowKernelMigration()
const thin = new ThinHostRuntime({
  character: { name: character.name, id: character.id },
  agentId: stringToUuid('agent-thinhost-initdb'),
  settings: { POSTGRES_URL: pgUrl, CHARACTER_DB_BACKEND: 'postgres' },
  pool: pool as never,
  logger: thinLogger(),
})

let initOk = false
let initErr = ''
let ddlRan = false
try {
  const original = thin.runPluginMigrations.bind(thin)
  ;(thin as unknown as { runPluginMigrations: () => Promise<never> }).runPluginMigrations =
    async () => { ddlRan = true; return original() }
  const ready = await initDatabase(thin as never, {} as never)
  initOk = true
  check('I1-initDatabase-ok', ready.tables.length > 0, `initDatabase 返回 ${String(ready.tables.length)} 张表`)
} catch (error) {
  initErr = error instanceof Error ? error.message : String(error)
  check('I1-initDatabase-ok', false, `initDatabase 失败：${initErr.slice(0, 160)}`)
}

if (initOk) {
  let handleOk = false
  let handleErr = ''
  try {
    const db = getRawDb(thin)
    handleOk = typeof db.execute === 'function'
  } catch (error) {
    handleErr = error instanceof Error ? error.message : String(error)
  }
  check(
    'I2-getRawDb-works',
    handleOk,
    handleOk ? 'getRawDb(薄宿主) 取到 db.execute（崩溃点已闭合）' : `getRawDb 仍失败：${handleErr.slice(0, 120)}`
  )
  check('I3-no-startup-ddl', ddlRan === false, `已就绪 schema 下未触发 runPluginMigrations（ran=${String(ddlRan)}）`)
}

try { await closeDatabaseConnection(thin) } catch { /* 收尾失败不影响断言 */ }
try { await pool.end() } catch { /* 同上 */ }

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== thinhost 装配闭环: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
