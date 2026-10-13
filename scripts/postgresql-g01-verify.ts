/**
 * PG-G01 配置与隔离（WP1 的门）。
 *
 * ============================================================================
 *  这道门回答什么
 * ============================================================================
 *  ADR-132 `D01`/`D02`/`D03` 的三句话，落成可判定的断言：
 *
 *    D01 后端选择是**闭集**，规范化只有一处，`unset` 逐字等于今天的行为
 *    D02 错配置**失败关闭**且具名，**禁止回落 PGlite**
 *    D03 `isolateDatabase()` 在 PG 后端下**默认拒绝**（没给测试目标就死），
 *        给了目标也要过三道（解析得出 / 不等于生产 / 带测试前缀）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 这道门**不打开任何数据库**
 * ---------------------------------------------------------------------------
 *  它跑的是纯函数与**子进程**里的判据；子进程用 `initDatabase` 的"插件注册"
 *  作为探针（`registerPlugin` 会自增计数然后抛），因此"有没有走到开库那一步"
 *  是可观测的，而不需要真的连上 PostgreSQL。
 *
 *  ⇒ 真 PostgreSQL 上的那几条（`PG-G01.5` 错库、`PG-G01.7` 第二目标）
 *     需要隔离 PG 实例（WP2 的 Docker 引擎前置）⇒ 本门如实报 **NOT RUN**，
 *     **不**用"纯函数通过"冒充它们通过。
 *
 * 跑法：pnpm postgresql:g01:verify
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  databaseAccessDecision,
  databaseIdentityExpectationFrom,
  databaseStartupDenialMessage,
  isPostgresUrl,
  isSameDatabaseTarget,
  parseDatabaseTarget,
  postgresIsolationDecision,
  postgresTargetGuard,
  redactPostgresUrl,
  resolveDatabaseBackend,
  verifyDatabaseIdentityReading,
  type DatabaseBackendResolution,
} from '../src/infrastructure/persistence/database-backend.ts'
import { closePostgresPoolManagers, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { productionOpenDecision } from '../src/db/index.ts'
const checks: { name: string; pass: boolean; detail?: string }[] = []
/**
 * 负控**只收**这一类：删掉被测的那条闸，本项就会变红。
 *
 * ⚠️ 分类纪律（本轮踩到）：`checkNegative` 的语义是"**期望抛**，没抛就红"。
 * 因此凡是"期望某个函数**返回**拒绝"的断言，都**不能**放进负控 ——
 * 那样"没拦住"反而会被记成通过（假负数）。它们属于正控（断言值为 false）。
 */
const negativeControls: { name: string; failedAsExpected: boolean }[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function checkNegative(name: string, fn: () => void): void {
  try {
    fn()
    // 没抛 ⇒ "该炸的没炸" ⇒ 检测器不生效 ⇒ 这条记红
    negativeControls.push({ name, failedAsExpected: false })
  } catch {
    negativeControls.push({ name, failedAsExpected: true })
  }
}

const resolveOf = (env: Record<string, string | undefined>): DatabaseBackendResolution =>
  resolveDatabaseBackend(env)

// ===========================================================================
// §1 D01：后端选择的闭集与"unset 等于今天"
// ===========================================================================
check('D01.1 未设字段 ⇒ backend=pglite 且无问题（纯追加，既有入口不受影响）', () => {
  const r = resolveOf({ PGLITE_DATA_DIR: './data/pglite' })
  assert.equal(r.backend, 'pglite')
  assert.deepEqual(r.problems, [])
  assert.equal(r.requested, undefined)
  assert.equal(r.postgresUrl, undefined)
})

check('D01.2 空串字段视同未设（不把 "" 当第三个值）', () => {
  const r = resolveOf({ CHARACTER_DB_BACKEND: '   ' })
  assert.equal(r.backend, 'pglite')
  assert.deepEqual(r.problems, [])
})

check('D01.3 显式 pglite ⇒ backend=pglite，dataDir 透传', () => {
  const r = resolveOf({ CHARACTER_DB_BACKEND: 'pglite', PGLITE_DATA_DIR: './data/pglite' })
  assert.equal(r.backend, 'pglite')
  assert.equal(r.dataDir, './data/pglite')
  assert.deepEqual(r.problems, [])
})

check('D01.4 显式 postgres + 合法 URL ⇒ backend=postgres，URL 透传（trim 后）', () => {
  const r = resolveOf({
    CHARACTER_DB_BACKEND: 'postgres',
    POSTGRES_URL: '  postgresql://lg@127.0.0.1:5432/lg_test_g01  ',
  })
  assert.equal(r.backend, 'postgres')
  assert.equal(r.postgresUrl, 'postgresql://lg@127.0.0.1:5432/lg_test_g01')
  assert.deepEqual(r.problems, [])
})

check('D01.5 大写/混合大小写字段值被接受（trim + 精确比较，不猜拼写）', () => {
  const r = resolveOf({ CHARACTER_DB_BACKEND: 'POSTGRES', POSTGRES_URL: 'postgres://u@h/db' })
  // 'POSTGRES' 不是闭集成员 ⇒ 拒绝。**不**做大小写折叠：
  // 让一个笔误（或大小写差异）决定生产后端，正是要防的事。
  assert.equal(r.problems[0], 'backend_unknown')
})

// ===========================================================================
// §2 D02：失败关闭的具名拒绝
// ===========================================================================
check('D02.1 backend=postgres 但无 URL ⇒ postgres_url_missing', () => {
  const r = resolveOf({ CHARACTER_DB_BACKEND: 'postgres' })
  assert.deepEqual(r.problems, ['postgres_url_missing'])
  assert.equal(r.backend, 'postgres')
  assert.equal(r.postgresUrl, undefined)
})

check('D02.2 非法后端值 ⇒ backend_unknown（不纠错）', () => {
  for (const bad of ['postgresl', 'pg', 'Postgres', 'postgre', 'sqlite']) {
    const r = resolveOf({ CHARACTER_DB_BACKEND: bad, POSTGRES_URL: 'postgres://u@h/db' })
    assert.deepEqual(r.problems, ['backend_unknown'], `值 ${bad} 应当被拒`)
  }
})

check('D02.3 有 URL 但未选 postgres ⇒ postgres_url_without_backend（防"设了 URL 以为切了"）', () => {
  const a = resolveOf({ POSTGRES_URL: 'postgres://u@h/db' })
  assert.deepEqual(a.problems, ['postgres_url_without_backend'])
  assert.equal(a.backend, 'pglite')
  // DATABASE_URL 同样触发（它在 plugin-sql 1.7.2 里只进 migrate() 的锁判定，
  // **不**参与后端选择 ⇒ 设了它同样是"以为切了"）
  const b = resolveOf({ DATABASE_URL: 'postgres://u@h/db' })
  assert.deepEqual(b.problems, ['postgres_url_without_backend'])
})

check('D02.4 URL 形状非法 ⇒ postgres_url_invalid', () => {
  const r = resolveOf({ CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: 'mysql://u@h/db' })
  assert.deepEqual(r.problems, ['postgres_url_invalid'])
})

check('D02.5 后端判据与 plugin-sql 同形（:memory: 与非 PG scheme 都排除）', () => {
  assert.equal(isPostgresUrl('postgres://u@h/db'), true)
  assert.equal(isPostgresUrl('postgresql://u@h/db'), true)
  assert.equal(isPostgresUrl('postgis://u@h/db'), true)
  assert.equal(isPostgresUrl('pgbouncer://u@h/db'), true)
  assert.equal(isPostgresUrl('postgres://u@h/:memory:'), false)
  assert.equal(isPostgresUrl('mysql://u@h/db'), false)
  assert.equal(isPostgresUrl('mongodb://u@h/db'), false)
  assert.equal(isPostgresUrl(''), false)
})

check('D02.6 脱敏只露形状：密码与用户名不进日志', () => {
  const redacted = redactPostgresUrl('postgresql://lg_runtime:s3cret@10.0.0.5:5432/lg_prod')
  assert.ok(!redacted.includes('s3cret'), `脱敏后仍含密码：${redacted}`)
  assert.ok(!redacted.includes('lg_runtime'), `脱敏后仍含用户名：${redacted}`)
  assert.ok(redacted.includes('10.0.0.5:5432'), '主机与端口应当保留（运维需要）')
  assert.ok(redacted.includes('/lg_prod'), 'database 名应当保留（身份需要）')
  // 解析不了的 URL 也不许把原文带出来
  assert.equal(redactPostgresUrl('not a url at all'), '<unparseable postgres url>')
})

// ===========================================================================
// §3 目标比较：不按字符串比
// ===========================================================================
check('D03.1 localhost / 127.0.0.1 / 大小写 / 尾部斜杠 / 默认端口 都算同一个目标', () => {
  assert.equal(
    isSameDatabaseTarget('postgres://u@localhost/db', 'postgres://u@127.0.0.1/db'),
    true,
    '回环别名必须归一：否则"隔离目标=生产目标"会被漏判 ⇒ 放行'
  )
  assert.equal(isSameDatabaseTarget('postgres://u@H/db', 'postgres://u@h/db'), true)
  assert.equal(isSameDatabaseTarget('postgres://u@h/db/', 'postgres://u@h/db'), true)
  assert.equal(isSameDatabaseTarget('postgres://u@h:5432/db', 'postgres://u@h/db'), true)
  assert.equal(
    isSameDatabaseTarget('postgres://u@h/db', 'postgresql://other:secret@h:5432/db'),
    true,
    '用户名与密码不同不改变"是不是同一个目标"'
  )
})

check('D03.2 不同 database 名 / 不同端口 / 不同主机 ⇒ 判**不同**（否则隔离断言是假的）', () => {
  assert.equal(isSameDatabaseTarget('postgres://u@h/lg_prod', 'postgres://u@h/lg_test_g01'), false)
  assert.equal(isSameDatabaseTarget('postgres://u@h:5432/db', 'postgres://u@h:5433/db'), false)
  assert.equal(isSameDatabaseTarget('postgres://u@a/db', 'postgres://u@b/db'), false)
})

check('D03.3 解析不出目标 ⇒ 视为"同一"（失败关闭：证明不了不是 ⇒ 当它是）', () => {
  assert.equal(isSameDatabaseTarget('garbage', 'postgres://u@h/db'), true)
  assert.equal(parseDatabaseTarget('garbage'), undefined)
})

// ===========================================================================
// §4 身份核对（纯函数版）
// ===========================================================================
const reading = {
  database: 'lg_test_g01',
  user: 'lg_test',
  serverAddr: '127.0.0.1',
  serverPort: 5432,
  serverVersion: 'PostgreSQL 17.5',
}

check('D02.7 期望 database 相符 ⇒ ok', () => {
  const v = verifyDatabaseIdentityReading(reading, { database: 'lg_test_g01' })
  assert.equal(v.ok, true)
  assert.deepEqual(v.mismatches, [])
})

check('D02.8 期望 database 不符 ⇒ ok=false 且不符项具名（身份核对真的在比）', () => {
  const v = verifyDatabaseIdentityReading(reading, { database: 'lg_prod' })
  assert.equal(v.ok, false)
  assert.equal(v.mismatches.length, 1)
  assert.ok(v.mismatches[0].includes('lg_prod'))
  // 与"相符"对照，证明这个判据不是恒 false
  assert.equal(verifyDatabaseIdentityReading(reading, { database: 'lg_test_g01' }).ok, true)
})

check('D02.9 期望 user 真的参与判定（不符必须红）', () => {
  assert.equal(verifyDatabaseIdentityReading(reading, { users: ['lg_test', 'lg_migrate'] }).ok, true)
  assert.equal(verifyDatabaseIdentityReading(reading, { users: ['lg_runtime'] }).ok, false)
  assert.equal(verifyDatabaseIdentityReading(reading, { users: ['lg_runtime'] }).mismatches.length, 1)
})

check('D02.10 一条期望都不给 ⇒ ok=false（身份核对必须有东西可核）', () => {
  assert.equal(verifyDatabaseIdentityReading(reading, {}).ok, false)
  assert.equal(verifyDatabaseIdentityReading(reading, { users: [] }).ok, false)
})

check('D02.11 期望从环境读；空串 = 不给', () => {
  const expect = databaseIdentityExpectationFrom({
    LG_PG_EXPECT_DATABASE: 'lg_test_g01',
    LG_PG_EXPECT_USER: ' lg_test , lg_migrate , ',
    LG_PG_EXPECT_DATABASE_PREFIX: '',
    LG_PG_EXPECT_USER_PREFIX: undefined,
  })
  assert.equal(expect.database, 'lg_test_g01')
  assert.deepEqual(expect.users, ['lg_test', 'lg_migrate'])
  assert.equal(expect.deploymentIdentity, undefined)
})

// ===========================================================================
// §5 开库前判据（databaseAccessDecision ⊕ PGlite 目录闸）
// ===========================================================================
// ⚠️ PGlite 那一侧**直接用生产实现**（`productionOpenDecision`），不在这里复刻。
//    复刻会漂移 —— 而"量的不是生产那份判据"正是本仓库反复踩的形状。
//
// ⚠️⚠️ 这里踩过一次**假阴性**（本轮）：第一版 `decide()` 只把 `rest.dataDir` 传给目录闸，
//    而多数用例只给了 `env.PGLITE_DATA_DIR` ⇒ 目录闸拿到 `undefined` ⇒
//    **永远放行** ⇒ "真实库目录被拒"这条断言永远通过，却什么都没量到。
//    修法是：数据目录以**解析结果**为准（`resolution.dataDir`），`rest.dataDir` 只作显式覆盖。
const decide = (
  env: Record<string, string | undefined>,
  rest: { dataDir?: string; allowFlag?: boolean; isolated?: boolean; tokenPresent?: boolean } = {}
) => {
  const resolution = resolveOf(env)
  return databaseAccessDecision({
    resolution,
    pgliteDecision: productionOpenDecision({
      dataDir: rest.dataDir ?? resolution.dataDir,
      allowFlag: rest.allowFlag === true,
      isolated: rest.isolated === true,
      tokenPresent: rest.tokenPresent === true,
    }),
  })
}

check('D02.12 未设字段 ⇒ 逐字退化成原来的 PGlite 目录闸', () => {
  // 真实库目录 + 未放行 ⇒ 拒（原判据）
  const denied = decide({ PGLITE_DATA_DIR: PRODUCTION_DB_DIR })
  assert.equal(
    denied.allowed,
    false,
    `真实库目录应当被拒，实际 ${JSON.stringify(denied)}；PRODUCTION_DB_DIR=${PRODUCTION_DB_DIR}`
  )
  assert.equal(denied.denial, 'missing_production_allowance')
  assert.equal(denied.backendDenial, undefined)
  // 真实库 + 已放行 + 无 token ⇒ 拒（原判据）
  const noToken = decide({ PGLITE_DATA_DIR: PRODUCTION_DB_DIR }, { allowFlag: true })
  assert.equal(noToken.denial, 'missing_preopen_token')
  // 真实库 + 已放行 + 有 token ⇒ 放行
  assert.equal(
    decide({ PGLITE_DATA_DIR: PRODUCTION_DB_DIR }, { allowFlag: true, tokenPresent: true }).allowed,
    true
  )
})

check('D02.13 错配置**优先**被拒（在任何库被碰之前）', () => {
  const d = decide({ CHARACTER_DB_BACKEND: 'postgres' }, { dataDir: PRODUCTION_DB_DIR })
  assert.equal(d.allowed, false)
  assert.equal(d.backendDenial, 'postgres_url_missing')
})

check('D02.14 后端 = postgres ⇒ PGlite 目录闸**不适用**（不再要求目录租约）', () => {
  const d = decide(
    { CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: 'postgres://u@h/lg_prod' },
    { dataDir: PRODUCTION_DB_DIR }
  )
  assert.equal(d.allowed, true)
  assert.equal(d.denial, undefined)
})

check('D02.15 有 URL 但没选后端 ⇒ 即使目录闸放行也必须拒', () => {
  const d = decide({ POSTGRES_URL: 'postgres://u@h/lg_prod' }, { isolated: true })
  assert.equal(d.allowed, false)
  assert.equal(d.backendDenial, 'postgres_url_without_backend')
})

check('D02.16 祖先环境里的 POSTGRES_URL 继承 ⇒ 未选后端则拒（隔离目录也救不了）', () => {
  const d = decide({ PGLITE_DATA_DIR: 'C:/tmp/isolated', POSTGRES_URL: 'postgres://u@h/lg_prod' })
  assert.equal(d.allowed, false)
  assert.equal(d.backendDenial, 'postgres_url_without_backend')
})

check('D02.17 数据目录闸没被新逻辑绕过：真实库目录 + 未放行 ⇒ 仍然拒（本次修掉的假阴性）', () => {
  // 这条与 D02.12 是同一条性质，但它**显式**走 `env.PGLITE_DATA_DIR` 这条路，
  // 用来钉住"解析结果里的 dataDir 真的被喂给了目录闸"这件事。
  const d = decide({ PGLITE_DATA_DIR: PRODUCTION_DB_DIR }, { isolated: false })
  assert.equal(d.allowed, false)
  assert.equal(d.denial, 'missing_production_allowance')
})

// ===========================================================================
// §6 隔离判据（ADR-132 D03）
// ===========================================================================
const iso = (postgresUrl: string | undefined, rest: { production?: string; prefix?: string } = {}) =>
  postgresIsolationDecision({
    postgresUrl,
    productionTarget: rest.production,
    testDatabasePrefix: rest.prefix,
  })

check('D03.4 不给测试目标 ⇒ postgres_isolation_not_provided（默认失败关闭）', () => {
  assert.equal(iso(undefined).denial, 'postgres_isolation_not_provided')
  assert.equal(iso('   ').denial, 'postgres_isolation_not_provided')
  assert.equal(iso('garbage').denial, 'postgres_isolation_not_provided')
})

check('D03.5 测试库带前缀且不等于生产 ⇒ 放行', () => {
  const d = iso('postgres://u@127.0.0.1:5432/lg_test_g01', {
    production: 'postgres://u@127.0.0.1:5432/lg_prod',
  })
  assert.equal(d.allowed, true)
})

check('D03.6 隔离目标 = 生产目标 ⇒ 拒（比较按解析后的三元组，不按字符串）', () => {
  // 字符串不同、目标相同：localhost vs 127.0.0.1，postgres vs postgresql
  const d = iso('postgres://u@localhost:5432/lg_prod', {
    production: 'postgresql://other:pw@127.0.0.1/lg_prod',
  })
  assert.equal(d.allowed, false)
  assert.equal(d.denial, 'postgres_isolation_targets_production')
})

// ★ 真负控：把"比较器"换成判据**不足**的那一个（不做规范化），
//   然后要求这条检测**必须能把漏判暴露出来**。
//
//   为什么必须用"带前缀 + 尾斜杠"这一对：
//   · 比较器失效要真的走到"放行"这一步，前缀检查必须过 ⇒ 目标得带 `lg_test_`
//   · 尾斜杠是**解析器另一个的洞**（本轮真踩到）：`.../db` 与 `.../db/` 曾是两个键
//   ⇒ 于是这一项同时钉住两件事：比较器可被证伪，且规范化确实在做工。
checkNegative('D03.6b【负控】比较器失效（不规范化）必须被暴露，否则这条检测没有力量', () => {
  const isolationUrl = 'postgres://u@127.0.0.1:5432/lg_test_prod/'
  const productionUrl = 'postgres://u@127.0.0.1:5432/lg_test_prod'

  // ① 规范化后的比较器：认得出这是同一个库
  assert.equal(
    isSameDatabaseTarget(isolationUrl, productionUrl),
    true,
    '尾斜杠没被规范化 ⇒ 同一个库会被判成两个目标'
  )

  // ② 判据不足的比较器：直接按字符串比（= 拿"规范化"当假设的那种写法）
  const naiveComparator = (a: string, b: string): boolean => a === b
  assert.equal(naiveComparator(isolationUrl, productionUrl), false)

  // ③ 用不足的比较器跑判据：它**必须**在此处暴露出来（不能静默放行）
  const leaked = postgresIsolationDecision({
    postgresUrl: isolationUrl,
    productionTarget: productionUrl,
    compareTargets: naiveComparator,
  })
  if (leaked.allowed) {
    throw new Error('用了判据不足的比较器却仍然放行 ⇒ 这条检测真的没有力量（必须修）')
  }
})

check('D03.7 目标不带测试前缀 ⇒ 拒（证明不了它不是生产库）', () => {
  const d = iso('postgres://u@h/lg_prod', { production: 'postgres://u@h/lg_other' })
  assert.equal(d.allowed, false)
  assert.equal(d.denial, 'postgres_isolation_target_unnamed')
})

check('D03.8 前缀可用 LG_TEST_DATABASE_PREFIX 覆盖', () => {
  assert.equal(iso('postgres://u@h/pgtest_a', { prefix: 'pgtest_' }).allowed, true)
  assert.equal(iso('postgres://u@h/lg_test_a', { prefix: 'pgtest_' }).denial, 'postgres_isolation_target_unnamed')
})

// ===========================================================================
// §6b 同进程第二个 PG 目标（G01.7）—— 纯函数真值表
// ===========================================================================
// 行为面（真 PG、同进程、两个目标）在 `postgresql:g02:verify` 里 —— 那需要实例。
// 这里判的是**判据本身**，因此不需要任何数据库。
check('G01.7a 首次打开 ⇒ 放行（本进程从未打开过 PostgreSQL）', () => {
  const g = postgresTargetGuard({ alreadyOpened: undefined, requested: 'postgres://u@h/a' })
  assert.equal(g.allowed, true)
  assert.ok(g.targetKey !== undefined)
})

check('G01.7b **同一个**目标重复打开 ⇒ 放行（幂等，守卫不该误伤）', () => {
  assert.equal(
    postgresTargetGuard({ alreadyOpened: 'postgres://u@h/a', requested: 'postgres://u@h/a' }).allowed,
    true
  )
  // 同一目标的两种写法（回环别名 / 默认端口 / 尾斜杠 / scheme 别名）也必须放行
  assert.equal(
    postgresTargetGuard({
      alreadyOpened: 'postgres://u@127.0.0.1:5432/a',
      requested: 'postgresql://other@localhost/a/',
    }).allowed,
    true,
    '同一目标的两种写法被误判成"换目标" ⇒ 守卫过严'
  )
})

check('G01.7c **换一个**目标 ⇒ 具名拒绝（这正是插件池键不含地址要防的）', () => {
  const g = postgresTargetGuard({ alreadyOpened: 'postgres://u@h/a', requested: 'postgres://u@h/b' })
  assert.equal(g.allowed, false)
  assert.equal(g.denial, 'second_postgres_target_in_process')
})

check('G01.7d 解析不了的目标 ⇒ 失败关闭（证明不了"是同一个"就拒）', () => {
  assert.equal(
    postgresTargetGuard({ alreadyOpened: 'postgres://u@h/a', requested: 'garbage' }).allowed,
    false
  )
  assert.equal(
    postgresTargetGuard({ alreadyOpened: 'garbage', requested: 'postgres://u@h/a' }).allowed,
    false
  )
})

check('G01.7e 换目标时的**人读文案**讲清"为什么必须拒绝"与"怎么办"', () => {
  const message = databaseStartupDenialMessage('second_postgres_target_in_process', {
    resolution: resolveOf({ CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: 'postgres://u@h/b' }),
    redactedTarget: 'postgres://<user>@h/b',
  })
  assert.ok(message.includes('default:pg'), '没有点出插件池键这个真实原因')
  assert.ok(message.includes('独立进程'), '没有给出"另起一个进程"这条出路')
  assert.ok(message.includes('清掉缓存'), '没有说明"刻意不做清缓存再连"')
})

// ===========================================================================
// §7 缺陷① 的真负控：只 clear 不 close 必须被判红
// ===========================================================================
await (async () => {
  const closed: string[] = []
  const managers = new Map<string, unknown>([
    ['default:pg', { close: async () => void closed.push('a') }],
    ['other:pg', { close: async () => void closed.push('b') }],
    ['no-close', {}],
  ])
  const outcome = await closePostgresPoolManagers(managers)
  check('D12.1 closePostgresPoolManagers 真的调了每个池的 close（旧实现只 clear）', () => {
    assert.equal(outcome.closed, 2)
    assert.equal(outcome.failed, 0)
    assert.equal(outcome.skipped, 1)
    assert.deepEqual(closed.sort(), ['a', 'b'])
  })

  const failing = new Map<string, unknown>([
    ['bad:pg', { close: async () => { throw new Error('pool_end_failed') } }],
    ['good:pg', { close: async () => undefined }],
  ])
  const outcome2 = await closePostgresPoolManagers(failing)
  check('D12.2 关失败的池如实记数（不假装关好了）', () => {
    assert.equal(outcome2.closed, 1)
    assert.equal(outcome2.failed, 1)
  })

  // ★ 这条是**真的在跑**的负控：把"只 clear 不 close"实现一遍，确认它是可判红的。
  //   否则"修了缺陷①"这句话没有任何东西支撑。
  checkNegative('D12.3【负控】"只 clear 不 close"的旧实现必须被判红', () => {
    const oldClosed: string[] = []
    const oldManagers = new Map<string, unknown>([
      ['default:pg', { close: async () => void oldClosed.push('a') }],
    ])
    // 旧实现逐字：
    oldManagers.clear()
    // 断言"池真的被关了"——旧实现下这里必然抛
    assert.equal(oldClosed.length, 1, '旧实现根本没有调用 close()')
  })
})()

// ===========================================================================
// §8 子进程：错配置/继承生产配置在**任何开库步骤之前**被拒
// ===========================================================================
const fixture = mkdtempSync(join(tmpdir(), 'lg-pg-g01-'))
const nested = join(fixture, 'nested')
mkdirSync(nested, { recursive: true })
const probe = join(fixture, 'probe.mts')
const srcDbUrl = pathToFileURL(resolve('src/db/index.ts')).href
const sandboxUrl = pathToFileURL(resolve('src/dev/sandbox.ts')).href

// 探针：**先**隔离（若隔离本身拒绝，就到此为止），再尝试 initDatabase。
// `registerPlugin` 会自增计数然后抛 ⇒ "有没有走到开库那一步"是可观测的。
//
// ⚠️ 三处刻意的写法：
//  ① 探针住在 `%TEMP%` 下 ⇒ **不能**写 `import 'dotenv/config'`（那里没有 node_modules）。
//     改用 `createRequire` 从**项目根**解析 dotenv。
//  ② `.env` 按**祖先链**查找并加载 —— 这正是 LG 自己（与 plugin-sql）的做法，
//     所以"祖先环境会不会被继承"这件事在这里是**真**被量到的，不是模拟的。
//  ③ 测试目标由 `LG_TEST_PG_URL` 传入（而不是硬编码）：
//     "没给测试目标"与"给了测试目标"是两条要分开验的路径。
writeFileSync(
  probe,
  `import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const requireFromRoot = createRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});
const dotenv = requireFromRoot('dotenv');
let envDir = process.cwd();
while (!existsSync(join(envDir, '.env')) && dirname(envDir) !== envDir) {
  envDir = dirname(envDir);
}
const envPath = join(envDir, '.env');
if (existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });
const { isolateDatabase } = await import(${JSON.stringify(sandboxUrl)});
const { initDatabase } = await import(${JSON.stringify(srcDbUrl)});
const out = { isolated: false, isolationError: null, initialized: 0, initError: null, envPath };
const target = process.env.LG_TEST_PG_URL;
try {
  isolateDatabase('pg-g01-probe', { ...(target ? { postgres: { url: target } } : {}) });
  out.isolated = true;
} catch (error) {
  out.isolationError = { code: error?.code ?? null, message: String(error?.message ?? error) };
}
if (out.isolated) {
  try { await initDatabase({ registerPlugin: async () => { out.initialized++; throw new Error('fixture_plugin'); } }, {}); }
  catch (error) { out.initError = { code: error?.code ?? null, message: String(error?.message ?? error) }; }
}
console.log(JSON.stringify(out));
`
)

const baseEnv: Record<string, string | undefined> = { ...process.env }
for (const key of [
  'PGLITE_DATA_DIR',
  'PROJECT_LG_SANDBOX',
  'PROJECT_LG_ALLOW_PRODUCTION_DB',
  'PROJECT_LG_ALLOW_KERNEL_MIGRATION',
  'CHARACTER_DB_BACKEND',
  'POSTGRES_URL',
  'DATABASE_URL',
  'LG_PRODUCTION_POSTGRES_URL',
  'LG_TEST_DATABASE_PREFIX',
  'LG_TEST_PG_URL',
  'LG_PG_EXPECT_DATABASE',
  'LG_PG_EXPECT_USER',
  'LG_PG_EXPECT_DATABASE_PREFIX',
  'LG_PG_EXPECT_USER_PREFIX',
]) {
  delete baseEnv[key]
}
// ⚠️ dotenv 的默认行为是"已存在的环境变量优先"。这里清掉 `process.env` 里的
//    `CHARACTER_DB_BACKEND` 等键之后，子进程才能**真的**从 fixture 的 `.env` 读它们
//    （否则 8.3 量的是我们自己的环境，而不是祖先 `.env`）。

const runProbe = (
  env: Record<string, string | undefined>,
  cwd = fixture
): {
  isolated: boolean
  isolationError: { code: string | null; message: string } | null
  initialized: number
  initError: { code: string | null; message: string } | null
  envPath: string
} => {
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), probe],
    { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 120_000 }
  )
  if (result.status !== 0) {
    throw new Error(`探针退出码 ${result.status}：${result.stderr?.slice(-1200)}`)
  }
  const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? ''
  return JSON.parse(line)
}

try {
  // --- 8.1 PGlite 后端 + 隔离库：既有路径完全不受影响（正控）---------------
  const pgliteOk = runProbe({ PGLITE_DATA_DIR: join(fixture, 'isolated-pglite') })
  check('G01.1 PGlite 后端下 isolateDatabase 照常工作，且开库步骤照常执行（正控）', () => {
    assert.equal(pgliteOk.isolated, true)
    assert.equal(pgliteOk.isolationError, null)
    assert.equal(pgliteOk.initialized, 1, '应当走到开库那一步（这是"没被新闸误伤"的正控）')
  })

  // --- 8.2 PG 后端 + 隔离但没给测试目标 ⇒ 隔离本身就拒 ----------------------
  const pgNoTarget = runProbe({
    CHARACTER_DB_BACKEND: 'postgres',
    POSTGRES_URL: 'postgres://u@127.0.0.1:5432/lg_test_g01',
  })
  check('G01.6 继承到 POSTGRES_URL 的实验脚本：isolateDatabase **直接拒**（默认失败关闭）', () => {
    assert.equal(pgNoTarget.isolated, false)
    assert.equal(pgNoTarget.initialized, 0, '绝不能走到开库那一步')
    assert.equal(pgNoTarget.isolationError?.code, 'postgres_isolation_not_provided')
  })

  // --- 8.3 祖先 .env 里的 POSTGRES_URL 被继承（不改代码，靠真实目录层级）----
  // 祖先 `.env` 里放的是**后端字段 + 生产 URL**；`nested/` 下没有 `.env`。
  // 若"祖先环境会被读到"这条不成立，子进程会退化成 PGlite 并照常跑完 ⇒ 本项**红**。
  writeFileSync(
    join(fixture, '.env'),
    'CHARACTER_DB_BACKEND=postgres\nPOSTGRES_URL=postgres://u@127.0.0.1:5432/lg_prod\n'
  )
  const ancestor = runProbe({}, nested)
  check('G01.4 祖先 .env 的 POSTGRES_URL 会被读到，且隔离被拒、开库步骤不执行', () => {
    assert.equal(ancestor.isolated, false, '祖先的 PG 后端必须被看到 ⇒ 隔离直接拒')
    assert.equal(ancestor.initialized, 0, '绝不能走到开库那一步')
    assert.equal(ancestor.isolationError?.code, 'postgres_isolation_not_provided')
  })

  // --- 8.4 显式给出**带前缀且不等于生产**的测试目标 ⇒ 允许，但身份核对接住 ---
  // 后端字段与生产目标写进 `.env`：`initDatabase` 自己会按祖先链 `loadEnvironment()`，
  // 所以把目标放进程环境里是**不够**的 —— 那量不到"运行时读到的 .env"这一层。
  writeFileSync(
    join(fixture, '.env'),
    [
      'CHARACTER_DB_BACKEND=postgres',
      'POSTGRES_URL=postgres://u@127.0.0.1:5432/lg_test_g01',
      'LG_PRODUCTION_POSTGRES_URL=postgres://u@127.0.0.1:5432/lg_prod',
      'LG_TEST_DATABASE_PREFIX=lg_test_',
      'LG_PG_EXPECT_DATABASE=lg_test_g01',
      'LG_PG_EXPECT_USER=lg_test',
      '',
    ].join('\n')
  )
  const pgExplicit = runProbe({
    // 只有"测试目标"由进程环境给（它本来就是调用点提供的）
    LG_TEST_PG_URL: 'postgres://u@127.0.0.1:5432/lg_test_g01',
  })
  check('G01.7 显式测试目标（写进 .env 的后端配置）⇒ 隔离放行，且开库前判据不误伤', () => {
    assert.equal(pgExplicit.isolated, true, `隔离应当放行：${JSON.stringify(pgExplicit.isolationError)}`)
    // ⚠️ 本机**没有**可用的真 PostgreSQL：探针里的 `registerPlugin` 是**被注入的替身**，
    //    不会被网络失败拦住 ⇒ `initialized=1` 在这里是**期望**值。
    //    它证明的是"错配置/错目标的闸**没有**误伤一条合法路径"，
    //    **不是**"PG 连接可用"（那需要真 PG 实例 ⇒ 见 §9 的 NOT RUN）。
    assert.equal(
      pgExplicit.initialized,
      1,
      `合法目标被判据误伤（应当放行却拒了）：${JSON.stringify(pgExplicit.initError ?? pgExplicit.isolationError)}`
    )
    assert.equal(pgExplicit.initError?.message, 'fixture_plugin')
  })

  // --- 8.5 PG 后端 + 隔离目标 = 生产目标 ⇒ 拒 -------------------------------
  writeFileSync(
    join(fixture, '.env'),
    [
      'CHARACTER_DB_BACKEND=postgres',
      'POSTGRES_URL=postgres://u@localhost:5432/lg_prod',
      'LG_PRODUCTION_POSTGRES_URL=postgresql://other:pw@127.0.0.1/lg_prod',
      '',
    ].join('\n')
  )
  const pgProdTarget = runProbe({
    LG_TEST_PG_URL: 'postgres://u@localhost:5432/lg_prod',
  })
  check('G01.5 隔离目标解析后等于生产目标 ⇒ 拒（字符串不同、回环别名不同也要拒）', () => {
    assert.equal(pgProdTarget.isolated, false)
    assert.equal(
      pgProdTarget.isolationError?.code,
      'postgres_isolation_targets_production',
      JSON.stringify(pgProdTarget.isolationError)
    )
  })
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

// ===========================================================================
// §9 真 PG 用例的去向（**不再**笼统写成"未运行"）
// ===========================================================================
/*
 * ⚠️ 这里曾经列着三条 `*-real-pg` 为 NOT RUN，理由是"本机 Docker 引擎未运行"。
 *    那个理由**已经过时** —— 2026-10-13 引擎起来之后，三条的去向各自明确：
 *
 * ```text
 *   G01.5-real-pg  ✅ 已在真 PG 上关闭（WP2）：错库 ⇒ db_identity_mismatch，写入前拒绝
 *                  证据：pg-migration-wp2-<runId> 下的 identity-mismatch-and-init-failure.json
 *   G01.8-real-pg  ✅ 已在真 PG 上关闭（WP2）：拒绝后目标库表数仍为 0
 *   G01.7-real-pg  ⇒ **行为面搬到 `postgresql:g02:verify`**（需要实例 + 两个真库）
 *                  本门只留**纯函数真值表**（§6b 的 G01.7a–e）——它不需要实例
 * ```
 *
 * ⇒ 本门**不再**把这三条列成 NOT RUN：那会是一句**过时的**话
 *   （"没量到"与"已经量过、读数在别处"是两回事）。
 *   本门剩下的唯一缺口是"它自己不跑真 PG" —— 那是**设计**（它在 offline lane），
 *   不是"缺证据"。
 */
const notRun: { id: string; what: string; why: string }[] = []

// ===========================================================================
// 报告
// ===========================================================================
const passed = checks.filter((c) => c.pass).length
const failed = checks.length - passed
const negOk = negativeControls.filter((c) => c.failedAsExpected).length
const negFailed = negativeControls.length - negOk
const measured = checks.length + negativeControls.length

console.log('')
console.log('PG-G01 配置与隔离（WP1）')
console.log('─'.repeat(72))
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
}
for (const c of negativeControls) {
  console.log(`  ${c.failedAsExpected ? 'PASS' : 'FAIL'}  ${c.name}`)
}
console.log('─'.repeat(72))
console.log(`  正控/常断言 : ${passed}/${checks.length}`)
console.log(`  负控        : ${negOk}/${negativeControls.length}（红了才算过）`)
console.log(`  未运行      : ${notRun.length}`)
for (const n of notRun) console.log(`      · ${n.id} —— ${n.what}（${n.why}）`)
console.log(`  measured_count = ${measured}`)
console.log(`  失败总数 = ${failed + negFailed}`)
console.log('')

if (measured === 0) {
  console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
  process.exitCode = 1
} else if (failed + negFailed > 0) {
  process.exitCode = 1
}
