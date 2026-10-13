/**
 * PG-G02 schema 与权限（WP2/WP3 的门）。
 *
 * ============================================================================
 *  这道门回答什么
 * ============================================================================
 *  验收契约 `PG-G02` 的九条 + 一条负控：
 *
 *    G02.1 全新隔离 PG 从零可运行
 *    G02.2 待迁移而未放行 ⇒ 拒绝启动（沿用既有 kernel 迁移闸语义）
 *    G02.3 并发两个迁移执行者 ⇒ 只有一个执行（advisory lock 互斥）
 *    G02.4 普通启动**不**自动应用 kernel 迁移
 *    G02.5 lg_runtime 执行 DDL ⇒ 拒
 *    G02.6 lg_readonly 执行 INSERT/UPDATE/DELETE/CREATE ⇒ 全拒（**靠 GRANT**）
 *    G02.7 lg_readonly 执行插件迁移 ⇒ 拒
 *    G02.8 lg_test 连生产库 ⇒ 拒
 *    G02.9 事务失败回滚 ⇒ 不留半个 schema
 *    +负控：把 lg_readonly 临时提权 ⇒ G02.6 **必须变红**（否则这条量的是别的东西）
 *
 * ---------------------------------------------------------------------------
 *  它与"真 PG 实例"的关系（失败关闭）
 * ---------------------------------------------------------------------------
 *  本门**需要**一个在跑的隔离 PG 实例。拿不到时：
 *    · 不报 PASS，也不静默跳过 ⇒ 全部 PG 相关项进 `notRun` 并**具名原因**
 *    · 静态项（不依赖实例的）照跑
 *  ⇒ "实例不在"是一个**可读的结论**，不是"门绿了"。
 *
 *  实例与凭据：
 *    · 容器名：`LG_PG_CONTAINER`（缺省 `lg-postgresql-trial`）
 *    · 凭据文件：`artifacts/post-lv2/local/pg-migration/pg-trial.env`（gitignore）
 *
 *  本门**自建自删**自己的测试库（`lg_test_g02*`），不污染别的门。
 *
 * ---------------------------------------------------------------------------
 *  为什么不直接用 `init-probe.ts` 而是再起子进程
 * ---------------------------------------------------------------------------
 *  需要"**以不同账号**跑真实 initDatabase"（lg_migrate 建 schema、lg_runtime 试着启动）。
 *  `init-probe.ts` 已经把这个形状做好了（含 `LG_TEST_PG_URL` 与 `LG_PG_EXPECT_*`），
 *  所以本门把它当**子进程**驱动，读它的 JSON 输出 —— 而不是在本门里重复那套引导逻辑。
 *
 * 跑法：pnpm postgresql:g02:verify
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'

// ===========================================================================
// 配置
// ===========================================================================
// ⚠️ 凭据读取走**共用模块**（`scripts/postgresql/credentials.ts`）：
//    本文件原来自己读一遍 —— 那一版**没有剥 UTF-8 BOM**，于是第一个 key 变成
//    `"\uFEFFLG_PG_BOOTSTRAP_USER"`。当时靠 `?? 'lg_bootstrap'` 兜底才没炸，
//    但"读到了配置"这件事其实没发生。现在**只读一处**、且**不给 key 兜底**。
const CONTAINER = PG_CONTAINER
const TSX = resolve('node_modules/tsx/dist/cli.mjs')
const PROBE = resolve('scripts/postgresql/init-probe.ts')
const HOST_PORT = PG_HOST_PORT

const credentials = loadPgCredentials()
/** 缺了哪些 key（空 = 齐备）；用它当 notRun 的原因，而不是拿默认值盖过去 */
const missingKeys = missingCredentialKeys(credentials)

// ===========================================================================
// 报告骨架
// ===========================================================================
const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

// ===========================================================================
// 驱动 psql / 建库 / 子进程
// ===========================================================================
interface PsqlResult {
  rc: number
  out: string
  err: string
}

/**
 * 在容器里跑一条 SQL。
 *
 * ⚠️ 密码走 `docker exec -e PGPASSWORD`（**从 docker CLI 自己的环境继承**）：
 *    这样密码既不出现在我拼的命令行里，也不需要 `bash -c` 那层引号
 *    （PowerShell 与 bash 的双重引号是本轮之前踩过的坑）。
 */
function psql(user: string, password: string, database: string, sql: string): PsqlResult {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD',
      CONTAINER,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      user,
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-tAc',
      sql,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password }, timeout: 60_000 }
  )
  return {
    rc: result.status ?? -1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  }
}

/** 以 bootstrap 超级用户跑一条 SQL。`database` 缺省 `postgres`。 */
function admin(sql: string, database = 'postgres'): PsqlResult {
  return psql(
    credentials?.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap',
    credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '',
    database,
    sql
  )
}

/** 跑 `create-test-db.sql` / `drop-test-db.sql`（容器内已挂 `/opt/lg`） */
function manageTestDb(script: 'create-test-db.sql' | 'drop-test-db.sql', dbName: string): PsqlResult {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD',
      '-e',
      `LG_TEST_DB_NAME=${dbName}`,
      '-e',
      'LG_PG_MIGRATE_USER=lg_migrate',
      CONTAINER,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      credentials?.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap',
      '-d',
      credentials?.LG_PG_BOOTSTRAP_DB ?? 'lg_trial',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      `/opt/lg/${script}`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '' },
      timeout: 120_000,
    }
  )
  return {
    rc: result.status ?? -1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  }
}

interface ProbeReading {
  ok: boolean
  steps: { step: string; ok: boolean; detail?: string }[]
  notRun: { id: string; what: string; why: string }[]
  adapterName?: string
  tableCount?: number
  kernelSchemaVersion?: number
  pgSpecific?: { currentDatabase?: string; vectorExtension?: string | null }
  error?: { name: string; code?: string; message: string }
}

/** 以某个账号把真实 initDatabase 跑起来（复用 init-probe.ts） */
function runProbe(options: {
  user: string
  password: string
  database: string
  expectDatabase: string
  expectUser: string
}): ProbeReading {
  const url = `postgres://${options.user}:${options.password}@127.0.0.1:${HOST_PORT}/${options.database}`
  const result = spawnSync(process.execPath, [TSX, PROBE], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      CHARACTER_DB_BACKEND: 'postgres',
      POSTGRES_URL: url,
      LG_TEST_PG_URL: url,
      LG_PRODUCTION_POSTGRES_URL: `postgres://lg_runtime:x@127.0.0.1:${HOST_PORT}/lg_prod`,
      LG_TEST_DATABASE_PREFIX: 'lg_test_',
      LG_PG_EXPECT_DATABASE: options.expectDatabase,
      LG_PG_EXPECT_USER: options.expectUser,
      // 探针自己的负控需要"未放行"这一步 ⇒ 这里**不**给放行标记
    },
  })
  const stdout = result.stdout ?? ''
  /*
   * 提取探针的 JSON。
   *
   * ⚠️ 不能"筛出所有以 `{` 开头的行再拼起来" —— 探针的 JSON 是 **pretty** 打印的，
   *    嵌套对象的行缩进后 trim 起来也以 `{` 开头 ⇒ 那样拼出来不是合法 JSON。
   *    （第一版就是这么写的，于是 rc=0 却被判 `probe_unreadable`。）
   *
   * 正确的做法：JSON 是**最后**打印的东西，而它的顶层 `{` 在**第 0 列**，
   * 嵌套的都在缩进里 ⇒ 取"最后一个第 0 列的 `{`"到结尾。
   */
  const start = stdout.startsWith('{') ? 0 : stdout.lastIndexOf('\n{') + 1
  const jsonText = start > 0 ? stdout.slice(start) : stdout
  try {
    return JSON.parse(jsonText) as ProbeReading
  } catch {
    return {
      ok: false,
      steps: [],
      notRun: [],
      error: {
        name: 'probe_unreadable',
        message: `无法解析 init-probe 输出（rc=${result.status}）：${(result.stderr ?? '').slice(-400)}`,
      },
    }
  }
}

// ===========================================================================
// §0 前置：实例与凭据
// ===========================================================================
const instanceUp = ((): boolean => {
  if (credentials === undefined) return false
  const probe = admin('select 1 as ok')
  return probe.rc === 0 && probe.out.includes('1')
})()

if (credentials === undefined) {
  notRun.push({
    id: 'all-pg-cases',
    what: '全部需要真 PG 实例的断言',
    why: `凭据文件不存在：${PG_CREDENTIALS_FILE}（它按 .gitignore 不入库；见 WP2 Handoff §2）`,
  })
} else if (missingKeys.length > 0) {
  // ⚠️ 缺 key 就是缺 key —— **不**拿默认值把它盖过去（见 credentials.ts 的文件头注释）
  notRun.push({
    id: 'all-pg-cases',
    what: '全部需要真 PG 实例的断言',
    why: `凭据文件缺这些 key：${missingKeys.join(', ')}（文件：${PG_CREDENTIALS_FILE}）`,
  })
} else if (!instanceUp) {
  notRun.push({
    id: 'all-pg-cases',
    what: '全部需要真 PG 实例的断言',
    why:
      `容器 ${CONTAINER} 不可达（或库未就绪）。起实例：` +
      `docker compose -f scripts/postgresql/compose.yml --env-file <凭据> up -d`,
  })
}

// ===========================================================================
// §1 静态断言（不依赖实例）
// ===========================================================================
check('G02.9b 静态：applyKernelMigrations 在驱动支持时**走事务**（原子性的机制）', () => {
  const source = readFileSync(
    resolve('src/infrastructure/persistence/db.ts'),
    'utf8'
  )
  assert.ok(
    /typeof db\.transaction === 'function'/.test(source),
    'db.ts 里找不到"驱动支持事务就走事务"的判据'
  )
  assert.ok(
    /return db\.transaction\(async \(tx\) => run\(tx\)\)/.test(source),
    'db.ts 里找不到"整批迁移在一个事务里"的那一行'
  )
})

check('G02.6b 静态：010-roles.sql 里 lg_readonly 的写权限是**靠 GRANT 不给**的（不是靠设置）', () => {
  const source = readFileSync(resolve('scripts/postgresql/init/010-roles.sql'), 'utf8')
  assert.ok(
    /GRANT SELECT ON TABLES TO lg_readonly/.test(source),
    '找不到只读账号只拿 SELECT 的那一行'
  )
  assert.ok(
    /ALTER ROLE lg_readonly SET default_transaction_read_only = on/.test(source),
    '找不到只读账号的第二层设置（它应当**存在**，但只是第二层）'
  )
})

if (credentials !== undefined && instanceUp) {
  const adminUser = credentials.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap'
  const pws = {
    migrate: credentials.LG_PG_MIGRATE_PASSWORD ?? '',
    runtime: credentials.LG_PG_RUNTIME_PASSWORD ?? '',
    readonly: credentials.LG_PG_READONLY_PASSWORD ?? '',
    test: credentials.LG_PG_TEST_PASSWORD ?? '',
  }

  // =========================================================================
  // §2 G02.1 / G02.2 / G02.4：全新库 + 迁移闸
  // =========================================================================
  const freshDb = 'lg_test_g02'
  manageTestDb('drop-test-db.sql', freshDb)
  const created = manageTestDb('create-test-db.sql', freshDb)

  check('G02.1a 全新隔离库可从零建立（建库 + pgvector + 授权重放）', () => {
    assert.equal(created.rc, 0, created.err)
    assert.ok(created.out.includes('就绪'), created.out)
  })

  check('G02.1b 全新库的基线是 0 张表（"从零"是可判定的）', () => {
    const r = psql('lg_migrate', pws.migrate, freshDb, 'select count(*)::int from information_schema.tables where table_schema = $tag$public$tag$')
    assert.equal(r.rc, 0, r.err)
    assert.equal(r.out, '0', `期望 0，实际 ${r.out}`)
  })

  // G02.2 + G02.4：未放行 ⇒ 拒绝（探针的第一步负控就是这个）
  const freshRun = runProbe({
    user: 'lg_migrate',
    password: pws.migrate,
    database: freshDb,
    expectDatabase: freshDb,
    expectUser: 'lg_migrate',
  })

  check('G02.2/G02.4 待迁移而未放行 ⇒ 拒绝启动（kernel_migration_pending）', () => {
    const gateStep = freshRun.steps.find((s) => s.step.includes('未放行时 Kernel 迁移闸拦住'))
    assert.ok(gateStep !== undefined, `探针没有报告迁移闸那一步：${JSON.stringify(freshRun.steps)}`)
    assert.ok(gateStep.ok, `迁移闸没有拦住：${gateStep.detail ?? ''}`)
  })

  check('G02.1c 显式放行后从零可运行：PgDatabaseAdapter + 51 表 + kernel v18 + pgvector 0.8.7', () => {
    assert.ok(freshRun.ok, `探针整体未通过：${JSON.stringify(freshRun.error ?? freshRun.steps)}`)
    assert.equal(freshRun.adapterName, 'PgDatabaseAdapter')
    assert.equal(freshRun.tableCount, 18, '插件表数')
    assert.equal(freshRun.kernelSchemaVersion, 18, 'kernel schema 版本')
    assert.equal(freshRun.pgSpecific?.vectorExtension, '0.8.7')
  })

  check('G02.1d 建完 schema 后 public 表 = 51（与来源库逐项对上的那一项）', () => {
    const r = psql('lg_migrate', pws.migrate, freshDb, 'select count(*)::int from information_schema.tables where table_schema = $tag$public$tag$ and table_type = $tag$BASE TABLE$tag$')
    assert.equal(r.rc, 0, r.err)
    assert.equal(r.out, '51', `期望 51，实际 ${r.out}`)
  })

  // =========================================================================
  // §3 G02.5 / G02.6 / G02.7 / G02.8：权限负控（真 psql，不同账号）
  // =========================================================================
  // 先由 lg_migrate 建一张探针表，供后面的写权限测试用
  const seed = psql(
    'lg_migrate',
    pws.migrate,
    freshDb,
    'create table if not exists g02_probe(id int primary key, v text); insert into g02_probe values (1,$tag$a$tag$) on conflict do nothing'
  )
  check('G02.6a 前置：lg_migrate 能建表并写入（迁移账号的正当工作）', () => {
    assert.equal(seed.rc, 0, seed.err)
  })

  check('G02.5 lg_runtime 执行 DDL（CREATE TABLE）⇒ 拒', () => {
    const r = psql('lg_runtime', pws.runtime, freshDb, 'create table g02_rt(a int)')
    assert.notEqual(r.rc, 0, '竟然成功了')
    assert.match(r.err, /permission denied/i, r.err)
  })

  check('G02.5b lg_runtime 执行 DDL（ALTER TABLE）⇒ 拒', () => {
    const r = psql('lg_runtime', pws.runtime, freshDb, 'alter table g02_probe add column z int')
    assert.notEqual(r.rc, 0, '竟然成功了')
    assert.match(r.err, /must be owner|permission denied/i, r.err)
  })

  check('G02.6b lg_runtime 的 DML 是允许的（INSERT/UPDATE/DELETE）—— 对照，证明拒的不是"一切"', () => {
    const ins = psql('lg_runtime', pws.runtime, freshDb, 'insert into g02_probe values (2,$tag$b$tag$)')
    assert.equal(ins.rc, 0, ins.err)
    const upd = psql('lg_runtime', pws.runtime, freshDb, 'update g02_probe set v=$tag$b2$tag$ where id=2')
    assert.equal(upd.rc, 0, upd.err)
    const del = psql('lg_runtime', pws.runtime, freshDb, 'delete from g02_probe where id=2')
    assert.equal(del.rc, 0, del.err)
  })

  // ★ 关键：把"第二层"（只读事务）关掉，单独考"第一层"（GRANT）
  for (const [label, sql] of [
    ['INSERT', 'set transaction_read_only=off; insert into g02_probe values (9,$tag$x$tag$)'],
    ['UPDATE', 'set transaction_read_only=off; update g02_probe set v=$tag$x$tag$ where id=1'],
    ['DELETE', 'set transaction_read_only=off; delete from g02_probe where id=1'],
  ] as const) {
    check(`G02.6c lg_readonly 的 ${label}（**把只读事务关掉后**）⇒ 仍拒（靠 GRANT）`, () => {
      const r = psql('lg_readonly', pws.readonly, freshDb, sql)
      assert.notEqual(r.rc, 0, `${label} 竟然成功了 ⇒ 写权限是设置挡的，不是 GRANT 挡的`)
      assert.match(r.err, /permission denied/i, r.err)
    })
  }

  check('G02.6d lg_readonly 的 SELECT 是允许的（对照，证明它不是"什么都拒"）', () => {
    const r = psql('lg_readonly', pws.readonly, freshDb, 'select count(*)::int from g02_probe')
    assert.equal(r.rc, 0, r.err)
  })

  check('G02.6c2 lg_readonly 的 CREATE TABLE（**把只读事务关掉后**）⇒ 拒（补上契约里的 CREATE 那一项）', () => {
    const r = psql('lg_readonly', pws.readonly, freshDb, 'set transaction_read_only=off; create table g02_ro(a int)')
    assert.notEqual(r.rc, 0, '竟然成功了')
    assert.match(r.err, /permission denied/i, r.err)
  })

  check('G02.7 lg_readonly 执行 bootstrap/迁移类操作（CREATE SCHEMA，**把只读事务关掉后**）⇒ 拒', () => {
    // 与 G02.6c 同一个道理：先关掉"第二层"（只读事务），单独考"第一层"（GRANT）。
    // 不关的话会被 read-only transaction 挡下 —— 那证明的是设置，不是权限。
    //
    // ⚠️ 这里刻意用 **CREATE SCHEMA** 而不是 `CREATE EXTENSION IF NOT EXISTS vector`：
    //    后者是**已在的扩展** ⇒ `IF NOT EXISTS` 让它变成**空操作**，
    //    而空操作**不触发权限检查**（实测：lg_readonly 竟然"成功"了）。
    //    ⇒ 与 WP0 记的 `add column if not exists` 同一类陷阱：
    //      **带 IF NOT EXISTS 的语句不能当权限探针**（它可能什么都没做）。
    const r = psql(
      'lg_readonly',
      pws.readonly,
      freshDb,
      'set transaction_read_only=off; create schema g02_ro_schema'
    )
    assert.notEqual(r.rc, 0, '竟然成功了')
    assert.match(r.err, /permission denied|must be owner/i, r.err)
  })

  check('G02.7b 记录在案的陷阱：对**已安装**的扩展，两种写法都**不能**当权限探针', () => {
    // 这条**不是**在断言"它应当被拒" —— 它如实记录一个反直觉行为，
    // 让"为什么 G02.7 用 CREATE SCHEMA 而不是 CREATE EXTENSION"这件事**可复核**，
    // 而不是只留一句注释。
    //
    // 实测（两种写法都量不到权限）：
    //   ① 带 `IF NOT EXISTS` ⇒ **静默空操作**，rc=0（根本不触发权限检查）
    //   ② 不带           ⇒ 报 `already exists` —— **也不是**权限拒绝：
    //                        "已存在"这条短路发生在权限检查**之前**
    // ⇒ 与 WP0 记的 `add column if not exists` 同一类陷阱：
    //   **"已存在就短路"的语句形状不能当权限探针**（它可能什么都没做就"成功"了）。
    const withGuard = psql(
      'lg_readonly',
      pws.readonly,
      freshDb,
      'set transaction_read_only=off; create extension if not exists vector'
    )
    const withoutGuard = psql(
      'lg_readonly',
      pws.readonly,
      freshDb,
      'set transaction_read_only=off; create extension vector'
    )
    assert.equal(
      withGuard.rc,
      0,
      `带 IF NOT EXISTS 的版本这次被拒了（${withGuard.err}）⇒ 本条的记录前提变了，需要重新核对`
    )
    assert.notEqual(withoutGuard.rc, 0, '去掉 IF NOT EXISTS 竟然成功 ⇒ 与预期不符')
    assert.match(
      withoutGuard.err,
      /already exists/i,
      `期望"already exists"（说明它在权限检查**之前**就短路了），实际：${withoutGuard.err}`
    )
  })

  check('G02.8 lg_test 连这个库 ⇒ 拒（**连接层**拒绝）', () => {
    const r = psql('lg_test', pws.test, freshDb, 'select 1')
    assert.notEqual(r.rc, 0, '竟然连上了')
    assert.match(r.err, /permission denied for database/i, r.err)
  })

  // -------------------------------------------------------------------------
  // ★ 敏感性对照：把 lg_readonly 临时提权 ⇒ 写**必须变成允许**
  // -------------------------------------------------------------------------
  // 这条不是"负控"，而是**证明 G02.6 量的是 GRANT** 的对照：
  // 如果提权之后写**仍然**被拒，那 G02.6 挡住的就不是权限，而是别的东西
  // （只读事务设置、或者一个恒为真的拒绝）—— 那种"绿"是没有意义的。
  // 做完**必须**恢复。
  // ⚠️ 这两条**必须**在 `freshDb` 里执行 —— `admin()` 缺省连的是 `postgres` 库，
  //    而 `g02_probe` 建在 `freshDb` 里。第一版漏了库名，于是 grant 报
  //    `relation "g02_probe" does not exist` ⇒ 提权根本没发生 ⇒ 后面两条对照连锁失败。
  const grantTemp = admin('grant all on table g02_probe to lg_readonly', freshDb)
  check('G02.6e-前置：能把 lg_readonly 临时提权（否则这条对照无从谈起）', () => {
    assert.equal(grantTemp.rc, 0, grantTemp.err)
  })

  check('G02.6e 敏感性对照：提权后 lg_readonly 的写**变成允许**（⇒ G02.6 量的是 GRANT）', () => {
    const r = psql(
      'lg_readonly',
      pws.readonly,
      freshDb,
      'set transaction_read_only=off; insert into g02_probe values (77,$tag$promoted$tag$)'
    )
    assert.equal(
      r.rc,
      0,
      `提权后写**仍然**被拒 ⇒ G02.6 可能量的是别的东西（不是 GRANT）：${r.err}`
    )
  })

  // 恢复（**必须**执行，无论对照结果如何）
  const revert = admin('revoke all on table g02_probe from lg_readonly', freshDb)
  check('G02.6f 对照后已恢复 lg_readonly 的权限（不留后患）', () => {
    assert.equal(revert.rc, 0, revert.err)
    const r = psql(
      'lg_readonly',
      pws.readonly,
      freshDb,
      'set transaction_read_only=off; insert into g02_probe values (78,$tag$after$tag$)'
    )
    assert.notEqual(r.rc, 0, '恢复后竟然还能写 ⇒ 没恢复干净')
    assert.match(r.err, /permission denied/i, r.err)
  })

  // =========================================================================
  // §4 G02.9：事务失败回滚（DB 层语义，真 PG）
  // =========================================================================
  check('G02.9a 事务里失败 ⇒ 之前建的对象**回滚**（不留半个 schema）', () => {
    const r = psql(
      'lg_migrate',
      pws.migrate,
      freshDb,
      'begin; create table g02_rollback(a int); select 1/0; commit'
    )
    assert.notEqual(r.rc, 0, '那一步竟然没报错')
    const after = psql(
      'lg_migrate',
      pws.migrate,
      freshDb,
      "select count(*)::int from information_schema.tables where table_name = $tag$g02_rollback$tag$"
    )
    assert.equal(after.out, '0', `回滚失败：表还在（count=${after.out}）`)
  })

  // =========================================================================
  // §5 G02.3：并发两个迁移执行者
  // =========================================================================
  const raceDb = 'lg_test_g02_race'
  manageTestDb('drop-test-db.sql', raceDb)
  const raceCreated = manageTestDb('create-test-db.sql', raceDb)
  check('G02.3a 前置：并发用的全新库已建立', () => {
    assert.equal(raceCreated.rc, 0, raceCreated.err)
  })

  // 两个进程同时对着同一个全新库跑 initDatabase（都用 lg_migrate，都放行迁移）。
  // 期望：**都成功**（plugin-sql 的 advisory lock 让后到者等前者），
  //       且迁移登记表**每条恰好一次**（幂等，不是各写一遍）。
  const raceUrl = `postgres://lg_migrate:${pws.migrate}@127.0.0.1:${HOST_PORT}/${raceDb}`
  const raceEnv = {
    ...process.env,
    CHARACTER_DB_BACKEND: 'postgres',
    POSTGRES_URL: raceUrl,
    LG_TEST_PG_URL: raceUrl,
    LG_PRODUCTION_POSTGRES_URL: `postgres://lg_runtime:x@127.0.0.1:${HOST_PORT}/lg_prod`,
    LG_TEST_DATABASE_PREFIX: 'lg_test_',
    LG_PG_EXPECT_DATABASE: raceDb,
    LG_PG_EXPECT_USER: 'lg_migrate',
    PROJECT_LG_ALLOW_KERNEL_MIGRATION: '1',
  }
  const racers = [
    spawnSync(process.execPath, [TSX, PROBE], { encoding: 'utf8', env: raceEnv, timeout: 180_000 }),
    spawnSync(process.execPath, [TSX, PROBE], { encoding: 'utf8', env: raceEnv, timeout: 180_000 }),
  ]

  check('G02.3b 两个并发迁移执行者都能完成（后到者等锁，不互相破坏）', () => {
    for (const [index, racer] of racers.entries()) {
      assert.equal(racer.status, 0, `第 ${index + 1} 个执行者退出码 ${racer.status}：${(racer.stderr ?? '').slice(-300)}`)
    }
  })

  check('G02.3c 迁移登记表**每条恰好一次**（并发下没有重复登记）', () => {
    const r = psql(
      'lg_migrate',
      pws.migrate,
      raceDb,
      'select count(*)::int || $tag$/$tag$ || count(distinct version)::int from character_schema_migrations'
    )
    assert.equal(r.rc, 0, r.err)
    const [rows, distinct] = r.out.split('/')
    assert.equal(rows, distinct, `总行数 ${rows} ≠ 去重后 ${distinct} ⇒ 有重复登记`)
    assert.equal(Number(rows), 18, `期望 18 条，实际 ${rows}`)
  })

  // =========================================================================
  // §5b G01.7-real-pg：同进程第二个 PostgreSQL 目标（**行为面**）
  // =========================================================================
  /*
   * 为什么放在这道门而不是 `PG-G01`：它**需要真 PG 实例 + 两个真库**。
   * `PG-G01` 在 `offline` lane（不依赖实例）⇒ 那边只留纯函数真值表（G01.7a–e），
   * 行为面在这里跑。契约里这一条仍编号 `G01.7`。
   *
   * 判据来自插件的一个实测形状：连接池全局键是 `default:pg`（**不含地址**）
   * ⇒ 同进程换目标会复用旧池。计划 §3.2 的裁定是"同进程多目标路径必须**拒绝**"。
   */
  const secondTargetProbe = resolve('scripts/postgresql/second-target-probe.ts')
  const secondTargetRun = spawnSync(process.execPath, [TSX, secondTargetProbe], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      LG_TARGET_A: `postgres://lg_migrate:${pws.migrate}@127.0.0.1:${HOST_PORT}/${freshDb}`,
      LG_TARGET_B: `postgres://lg_migrate:${pws.migrate}@127.0.0.1:${HOST_PORT}/${raceDb}`,
      LG_TARGET_A_DB: freshDb,
      LG_TARGET_B_DB: raceDb,
    },
  })
  const secondTargetReading = ((): Record<string, unknown> | undefined => {
    const line = (secondTargetRun.stdout ?? '')
      .split(/\r?\n/)
      .find((value) => value.startsWith('__SECOND_TARGET_JSON__'))
    if (line === undefined) return undefined
    try {
      return JSON.parse(line.slice('__SECOND_TARGET_JSON__'.length).trim()) as Record<string, unknown>
    } catch {
      return undefined
    }
  })()

  check('G01.7-real-pg 同进程：首次打开目标 A ⇒ 成功（前置）', () => {
    assert.ok(secondTargetReading !== undefined, `探针没有输出：${(secondTargetRun.stderr ?? '').slice(-400)}`)
    const firstA = secondTargetReading.firstA as { ok?: boolean; database?: string } | undefined
    assert.equal(firstA?.ok, true, JSON.stringify(firstA))
    assert.equal(firstA?.database, freshDb)
  })

  check('G01.7-real-pg 同进程：**重复打开同一个** A ⇒ 仍成功（幂等，守卫不误伤）', () => {
    const secondA = secondTargetReading?.secondA as { ok?: boolean; database?: string } | undefined
    assert.equal(
      secondA?.ok,
      true,
      `重复打开同一目标被误拒 ⇒ 守卫过严：${JSON.stringify(secondA)}`
    )
    assert.equal(secondA?.database, freshDb)
  })

  check('G01.7-real-pg 同进程：**换到目标 B** ⇒ 具名拒绝 second_postgres_target_in_process', () => {
    const thenB = secondTargetReading?.thenB as { ok?: boolean; code?: string } | undefined
    assert.equal(thenB?.ok, false, `换目标竟然成功了 ⇒ 查询会落在 A 上：${JSON.stringify(thenB)}`)
    assert.equal(thenB?.code, 'second_postgres_target_in_process', JSON.stringify(thenB))
  })

  check('G01.7-real-pg 探针收尾把池关掉了（否则进程会挂着不退出）', () => {
    assert.equal(secondTargetReading?.closedClean, true, '探针没有报告 closedClean')
  })

  // =========================================================================
  // §6 清理（自建自删）
  // =========================================================================
  const droppedA = manageTestDb('drop-test-db.sql', freshDb)
  const droppedB = manageTestDb('drop-test-db.sql', raceDb)
  check('G02.10 本门自建的测试库已清理（不污染别的门）', () => {
    assert.equal(droppedA.rc, 0, droppedA.err)
    assert.equal(droppedB.rc, 0, droppedB.err)
  })
}

// ===========================================================================
// 报告
// ===========================================================================
const passed = checks.filter((c) => c.pass).length
const failed = checks.length - passed
const measured = checks.length

console.log('')
console.log('PG-G02 schema 与权限')
console.log('─'.repeat(72))
console.log(`  实例：${CONTAINER} · 可达=${instanceUp} · 凭据文件=${credentials === undefined ? '缺失' : '在'}`)
console.log('─'.repeat(72))
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
}
console.log('─'.repeat(72))
console.log(`  断言        : ${passed}/${checks.length}`)
console.log(`  未运行      : ${notRun.length}`)
for (const n of notRun) console.log(`      · ${n.id} —— ${n.what}（${n.why}）`)
console.log(`  measured_count = ${measured}`)
console.log(`  失败总数 = ${failed}`)
console.log('')

/*
 * 退出码的三条纪律（第一条是本门差点放过去的一个**假绿**）。
 *
 * ⚠️ 第一版：实例不可达时只跑那 2 条静态断言、把其余全部记进 `notRun`，
 *    然后**以 0 退出**。那意味着 CI 会把"根本没有数据库"当成绿 ——
 *    正是验收契约 §2「缺证据、错误后端…均拒收」与 §9「任一关键门 FAIL / NOT RUN
 *    不能汇成 PASS」要挡的东西。
 *
 * ⇒ 现在的判据：**只要有关键断言未运行，本门就不报 PASS**。
 *    本门的 `notRun` 只有一种来源（实例不可达）⇒ 它一律意味着"缺证据"。
 *    （如果将来加了"不适用"类的 notRun，要把它与"缺证据"分开记，别共用这个出口。）
 */
if (measured === 0) {
  console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
  process.exitCode = 1
} else if (failed > 0) {
  process.exitCode = 1
} else if (notRun.length > 0) {
  console.error(
    `\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**（关键断言缺证据 ⇒ 拒收）。\n` +
      '  这不是"通过"，也不是"失败"—— 它是"没量到"。要取得读数，先让前置条件成立。'
  )
  process.exitCode = 1
}
