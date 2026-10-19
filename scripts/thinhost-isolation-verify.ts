/**
 * 门：隔离判据 `isolationDecisionFor` 的**行为级**自检（M12 · W0a）。
 *
 * ============================================================================
 *  它守的是什么
 * ============================================================================
 * `assertDatabaseAccessAllowed` 的"已隔离"判据此前**完全依赖 `PGLITE_DATA_DIR`**，
 * 于是 PostgreSQL 后端下**隔离库也必须用"我承认要开生产库"的旗标**
 * （`PROJECT_LG_ALLOW_PRODUCTION_DB=1`）才能打开 ⇒ 隔离与生产共用一个开关。
 *
 * `isolationDecisionFor` 把这条判据做成**后端无关**的"目标身份"判定。
 * ⇒ 本门必须证明两件事：
 *   ① 它**对目标身份敏感**：给生产库名 ⇒ 必须拒绝（否则等于没闸）
 *   ② 它**对缺失依据敏感**：读不到身份 ⇒ 必须拒绝（失败关闭）
 *
 * ⚠️ 判据纪律（`L-QQP-09`，本仓库已复发多次）：
 *   每条断言都走"**只改一处**"，并配**负控**与**恢复** ——
 *   只有正控的话，一个恒真的函数也能全绿。
 */

import { isolationDecisionFor } from '../src/infrastructure/persistence/isolation-decision.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const PROD_URL_TARGET = { database: 'sumuwei', user: 'lg_migrate', host: '127.0.0.1', port: '55432' }

// ---------------------------------------------------------------------------
// A · PostgreSQL 隔离库：应当放行（正控）
// ---------------------------------------------------------------------------
{
  const d = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: { database: 'lg_test_w0a', user: 'lg_migrate' },
    pgExpectation: { database: 'lg_test_w0a', users: ['lg_migrate'] },
  })
  check('A-allow-isolated', d.allowed === true, `隔离库被放行（denial=${d.denial ?? 'none'}）`)
}

// ---------------------------------------------------------------------------
// B · 指向生产库：必须拒绝（**这是本门最重要的断言**）
// ---------------------------------------------------------------------------
{
  const d = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: PROD_URL_TARGET,
    pgExpectation: { database: 'lg_test_w0a', users: ['lg_migrate'] },
  })
  check(
    'B-deny-production',
    d.allowed === false && d.denial === 'isolation_pg_database_not_test',
    `生产库被拒（allowed=${d.allowed} · denial=${d.denial ?? 'none'}）`
  )
}

// ---------------------------------------------------------------------------
// C · 负控：把期望值也改成生产库名 ⇒ **仍必须拒绝**
//     （证明它不是"只要两边写一样就放行"）
//
// ⚠️ 这条在**第一版实现上真的失败了**（allowed=true）：当时只做"期望 == 实际"，
//   于是 `expectation: { database: 'sumuwei' }` 就能打开生产库 ——
//   "隔离成立"取决于调用方自己写了什么。⇒ 判据必须是两个**独立**条件：
//   ① 期望库名逐字相同  ② 该库名**本身就是测试库**。
// ---------------------------------------------------------------------------
{
  const d = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: PROD_URL_TARGET,
    pgExpectation: { database: 'sumuwei', users: ['lg_migrate'] },
  })
  check(
    'C-deny-self-consistent-production',
    d.allowed === false,
    `期望与实际都写成生产库时**仍拒绝**（allowed=${d.allowed} · denial=${d.denial ?? 'none'}）` +
      ' —— 靠数据库名前缀，而不是"两边一致"'
  )
}

// ---------------------------------------------------------------------------
// D · 用户不符：必须拒绝（证明它不只看库名）
// ---------------------------------------------------------------------------
{
  const d = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: { database: 'lg_test_w0a', user: 'postgres' },
    pgExpectation: { database: 'lg_test_w0a', users: ['lg_migrate'] },
  })
  check(
    'D-deny-wrong-user',
    d.allowed === false && d.denial === 'isolation_pg_user_not_expected',
    `用户不符被拒（denial=${d.denial ?? 'none'}）`
  )
}

// ---------------------------------------------------------------------------
// E · 缺失依据 → 失败关闭（读不到目标 / 没有期望）
// ---------------------------------------------------------------------------
{
  const noTarget = isolationDecisionFor({
    backend: 'postgres',
    pgExpectation: { database: 'lg_test_w0a' },
  })
  check(
    'E-fail-closed-no-target',
    noTarget.allowed === false && noTarget.denial === 'isolation_pg_target_missing',
    `缺目标身份 ⇒ 拒绝（denial=${noTarget.denial ?? 'none'}）`
  )

  const noExpect = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: { database: 'lg_test_w0a', user: 'lg_migrate' },
    pgExpectation: {},
  })
  check(
    'E-fail-closed-no-expectation',
    noExpect.allowed === false && noExpect.denial === 'isolation_pg_expectation_missing',
    `缺期望身份 ⇒ 拒绝（denial=${noExpect.denial ?? 'none'}）`
  )
}

// ---------------------------------------------------------------------------
// F · PGlite 分支：语义逐字沿用既有目录闸
// ---------------------------------------------------------------------------
{
  const on = isolationDecisionFor({ backend: 'pglite', pgliteIsolated: true })
  check('F-pglite-passthrough-allow', on.allowed === true, 'PGlite 且目录闸放行 ⇒ 放行（语义不变）')

  const off = isolationDecisionFor({ backend: 'pglite', pgliteIsolated: false })
  check('F-pglite-passthrough-deny', off.allowed === false, 'PGlite 且目录闸不放行 ⇒ 拒绝（语义不变）')
}

// ---------------------------------------------------------------------------
// G · 无期望库名时退化为前缀判据（显式前缀仍能拦生产库）
// ---------------------------------------------------------------------------
{
  const d = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: PROD_URL_TARGET,
    pgExpectation: { users: ['lg_migrate'] },
    testDatabasePrefix: 'lg_test_',
  })
  check(
    'G-prefix-deny-production',
    d.allowed === false && d.denial === 'isolation_pg_database_not_test',
    `只给用户期望时，生产库仍被前缀判据拒绝（denial=${d.denial ?? 'none'}）`
  )

  const ok = isolationDecisionFor({
    backend: 'postgres',
    pgTarget: { database: 'lg_test_g09', user: 'lg_migrate' },
    pgExpectation: { users: ['lg_migrate'] },
    testDatabasePrefix: 'lg_test_',
  })
  check('G-prefix-allow-isolated', ok.allowed === true, '只给用户期望时，隔离库放行')
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== 隔离判据门: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
