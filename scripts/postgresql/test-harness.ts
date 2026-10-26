/** Disposable PostgreSQL only. No .env, existing containers, volumes or fallback backend. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

const IMAGE = 'pgvector/pgvector:0.8.7-pg17-bookworm'
export interface PgTest {
  container: string
  database: string
  url: string
  pool: pg.Pool
  admin: pg.Pool
  /**
   * 管理连接串（超级用户，连 `postgres` 库）。
   *
   * ⚠️ 用来在**别的库**里装扩展（`vector` 不是 trusted 扩展 ⇒ 只有超级用户能装）。
   *    它**只**在本机一次性容器里有效，不指向任何共享实例。
   */
  adminUrl: string
}

/**
 * 隔离测试库的**实例内**形状（2026-10-21 新增 · serversim 仿真内执行）。
 *
 * ⚠️ 与 `PgTest` 的差别只有一个字段：没有 `container`。
 *    宿主模式里库住在"本脚本自己起的一次性容器"里；
 *    仿真模式里库住在**仿真里那台专用测试实例**（compose 服务 `pgtest`），
 *    本脚本只负责在里面造一个空白库、用完删掉。
 *    ⇒ 两种模式的**隔离判据完全一样**（库名带 `lg_test_` 前缀 + 显式迁移 + 身份核对）。
 */
export interface PgInstanceTest {
  database: string
  url: string
  pool: pg.Pool
  admin: pg.Pool
}

function docker(args: string[], env = process.env): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `isolated PostgreSQL: docker ${args[0]} failed (no fallback)`)
  return r.stdout.trim()
}

/** 解析连接串里的主机名（用于"允许的目标主机"闭集判定） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 允许作为隔离测试目标的主机名**闭集**。
 *
 * ⚠️ 缺省只有回环（`127.0.0.1` / `localhost`）—— 宿主模式逐字保留既有行为。
 *    仿真模式额外允许 compose 服务名 `pgtest`（**由调用方显式给出**，
 *    不是"放开成任意主机名"）。
 *    ⇒ 判据仍然是闭集，不是"看起来像测试库就行"。
 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

export function setPgTestEnvironment(
  url: string,
  options: { allowedHosts?: readonly string[]; productionTarget?: string } = {}
): void {
  const target = new URL(url)
  const database = decodeURIComponent(target.pathname.slice(1))
  assert.match(database, /^lg_test_[a-z0-9_]+$/)
  const allowedHosts = options.allowedHosts ?? LOOPBACK_HOSTS
  assert.ok(
    allowedHosts.includes(target.hostname),
    `隔离测试目标的主机名不在允许闭集内：${target.hostname}（允许：${allowedHosts.join('|')}）`
  )
  Object.assign(process.env, {
    CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: url, LG_TEST_PG_URL: url,
    LG_PG_EXPECT_DATABASE: database, LG_PG_EXPECT_USER: decodeURIComponent(target.username),
    LG_PG_EXPECT_DATABASE_PREFIX: 'lg_test_', LG_PG_EXPECT_USER_PREFIX: '',
    PGLITE_DATA_DIR: '', PROJECT_LG_SANDBOX: '', LG_PRODUCTION_POSTGRES_URL: options.productionTarget ?? '',
    PROJECT_LG_ALLOW_KERNEL_MIGRATION: '', DATABASE_URL: '',
    /*
     * ⚠️ **被祝福过的主机名**（闭集，显式给出）。
     *
     * 有些子进程会**自己**断言"我连的是测试库、不是生产库"（例：EBL 的
     * `--recover-probe` 探针：它必须在**一个本地测试库**上跑）。
     * 那条断言需要一个"哪些主机名算测试库主机"的名单 ⇒ 由**这里**给出
     * （它刚刚祝福过这个目标，所以它知道）。
     *
     * ⚠️ 是**闭集**（不是"任何主机名"）：缺省只有回环；仿真里额外含 `pgtest`。
     */
    LG_TEST_PG_ALLOWED_HOSTS: allowedHosts.join(','),
  })
}

/**
 * 在**一个已存在的实例**里造一个空白隔离库（角色 + 库 + 三个扩展）。
 *
 * ⚠️ 这个函数**不认识 docker**：它只用一个 admin 连接串。
 *    ⇒ 同一段准备逻辑既能用在"宿主自己起的一次性容器"上，
 *      也能用在"仿真里的专用测试实例"上（那里没有 docker CLI）。
 */
export async function prepareIsolatedDatabase(
  admin: pg.Pool,
  adminUrl: string,
  role: string,
  password: string,
  database: string
): Promise<{ url: string; pool: pg.Pool }> {
  await admin.query(`create role ${role} login password '${password}' nosuperuser nobypassrls;`)
  await admin.query(`create database ${database} owner ${role}`)
  const parsed = new URL(adminUrl)
  const ownerUrl = `postgresql://${role}:${password}@${parsed.hostname}:${parsed.port || '5432'}/${database}`
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 4 })
  /*
   * ⚠️ 扩展必须由**实例的超级用户**装，而且要装在**新库里**（扩展是库级对象）。
   *    `vector` 不是 trusted 扩展 ⇒ 非超级用户（`lg_test_owner`）装不上。
   *    ⇒ 这里用 admin 连接串里的账号连**新库**来装（宿主模式是 `postgres`，
   *      仿真模式是该实例的引导超级用户）。
   */
  const ext = new pg.Client({
    host: parsed.hostname,
    port: Number(parsed.port || '5432'),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  })
  await ext.connect()
  try { await ext.query('create extension vector; create extension fuzzystrmatch; create extension pgcrypto;') }
  finally { await ext.end() }
  const identity = (await pool.query('select current_database() as db, current_user as usr')).rows[0]
  assert.equal(identity.db, database)
  assert.equal(identity.usr, role)
  return { url: ownerUrl, pool }
}

/** 删掉一个测试库与它的角色（失败不抛出：清理失败不该改写测试结论） */
export async function dropIsolatedDatabase(admin: pg.Pool, database: string, role: string): Promise<void> {
  try {
    await admin.query(`drop database if exists ${database} with (force)`)
  } catch {
    /* 记在调用方日志里即可 */
  }
  try {
    await admin.query(`drop role if exists ${role}`)
  } catch {
    /* 同上 */
  }
}

/** 从 admin 连接串里取主机名（用于"允许的目标主机"闭集） */
export function pgAdminHost(url: string): string {
  return hostOf(url)
}

/** 从 admin 连接串里取端口（缺省 5432） */
export function pgAdminPort(url: string): number {
  try {
    return Number(new URL(url).port || '5432')
  } catch {
    return 5432
  }
}

/** admin 连接串里的账号与口令（装扩展时要用超级用户） */
export function pgAdminCredentials(url: string): { user: string; password: string } {
  try {
    const parsed = new URL(url)
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    }
  } catch {
    return { user: '', password: '' }
  }
}

export async function withPgTest<T>(label: string, run: (test: PgTest) => Promise<T>): Promise<T> {
  const id = randomBytes(6).toString('hex')
  const container = `lg-test-${label}-${id}`
  const volume = `${container}-data`
  const password = randomBytes(24).toString('hex')
  const database = `lg_test_${id}`
  const role = 'lg_test_owner'
  let created = false
  let pool: pg.Pool | undefined
  let admin: pg.Pool | undefined
  const inspect = () => JSON.parse(docker(['inspect', container]))[0]
  const assertOwned = () => {
    const info = inspect()
    assert.equal(info.Config.Labels['project-lg.test'], id)
    const mounts = info.Mounts.filter((m: { Destination: string }) => m.Destination === '/var/lib/postgresql/data')
    assert.equal(mounts.length, 1)
    assert.equal(mounts[0].Type, 'volume')
    assert.equal(mounts[0].Name, volume)
    assert.equal(info.HostConfig.PortBindings['5432/tcp'][0].HostIp, '127.0.0.1')
  }
  docker(['image', 'inspect', IMAGE]) // No automatic image pull.
  docker(['volume', 'create', '--label', `project-lg.test=${id}`, volume])
  try {
    docker(['create', '--name', container, '--label', `project-lg.test=${id}`,
      '-e', 'POSTGRES_PASSWORD', '--publish', '127.0.0.1::5432',
      '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`, IMAGE],
    { ...process.env, POSTGRES_PASSWORD: password })
    created = true
    assertOwned() // Actual resolved mount checked before the server can start.
    docker(['start', container])
    let ready = false
    /*
     * ⚠️⚠️ **就绪判据必须测 TCP，不能只测 Unix socket**（2026-10-19 实测修）。
     *
     * 旧判据：`pg_isready -U postgres`（**默认走容器内的 Unix socket**）。
     * 而下面 `admin` 连的是 **127.0.0.1:<HostPort>**（TCP）。
     * ⇒ socket 已经 ready、TCP 还没监听时，第一条 TCP 连接会被**当场断掉**
     *   ⇒ `Connection terminated unexpectedly`（实测在 `create role` 那一步）。
     * ⇒ 这个失败是**间歇性**的（看容器启动快慢）⇒ 会让门**时红时绿**，
     *   而"时红时绿的门"比"红的门"更坏：它会让人不再相信门。
     *
     * ⇒ 现在两个都测：socket **且** TCP。
     */
    for (let i = 0; i < 100; i++) {
      const sock = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { windowsHide: true, timeout: 2000 })
      const tcp = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'], { windowsHide: true, timeout: 2000 })
      if (sock.status === 0 && tcp.status === 0) { ready = true; break }
      await new Promise(done => setTimeout(done, 200))
    }
    assert.ok(ready, 'isolated PostgreSQL readiness timeout (socket AND TCP)')
    const port = Number(inspect().NetworkSettings.Ports['5432/tcp'][0].HostPort)
    admin = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 2 })
    /*
     * ⚠️ 连一次确认真的通了再继续 —— 连接池是**惰性**的，上面那条 `create role`
     *    才是第一次真正建连。若那一步被断，错误会伪装成"SQL 失败"。
     */
    await admin.query('select 1')
    const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${String(port)}/postgres`
    const prepared = await prepareIsolatedDatabase(admin, adminUrl, role, password, database)
    pool = prepared.pool
    setPgTestEnvironment(prepared.url)
    return await run({ container, database, url: prepared.url, pool, admin, adminUrl })
  } finally {
    await pool?.end()
    await admin?.end()
    if (created) { assertOwned(); docker(['rm', '--force', container]) }
    const info = JSON.parse(docker(['volume', 'inspect', volume]))[0]
    assert.equal(info.Labels['project-lg.test'], id)
    docker(['volume', 'rm', volume])
  }
}

/**
 * 在**已存在的隔离实例**里跑一段逻辑（2026-10-21 · serversim 仿真内执行）。
 *
 * ============================================================================
 *  为什么多这一条
 * ============================================================================
 *  仿真里没有 docker CLI ⇒ `withPgTest()` 的"自己起容器"那一步用不了。
 *  但**隔离的实质**不在"起容器"，而在三件事：
 *    ① 库在**另一个实例**里（与核心在用的 `sumuwei` 副本没有任何共享）；
 *    ② 库名带 `lg_test_` 前缀 ⇒ 失败关闭判据（`postgresIsolationDecision`）成立；
 *    ③ 准备阶段**显式应用 LG 迁移**并核对身份。
 *  这三件事本函数全都做 ⇒ 它与 `withPgTest()` 的隔离强度**同级**。
 *
 *  ⚠️ **不许**把它用来连"核心正在用的那个实例"：那会拿到真实数据副本。
 *    调用方必须给一个**专用**实例的 admin 连接串。
 */
export async function withPgTestInInstance<T>(
  adminUrl: string,
  label: string,
  run: (test: PgInstanceTest) => Promise<T>
): Promise<T> {
  const id = randomBytes(6).toString('hex')
  const database = `lg_test_${id}`
  /*
   * ⚠️ 角色名**必须逐次唯一**。
   *
   * 同一个隔离实例里可能**先后**跑两道门（实测：`ebl:postgres:verify` 是
   * "自举"的 —— 外层跑一遍发现自己不是子进程，就再起一个子进程跑真正的部分），
   * 而两个外层各带一个自己的外层 runner ⇒ 同一个实例里会**两次**建角色。
   * 固定名 ⇒ 第二次 `create role` 报 `CreateRole: role already exists` ⇒ 门看起来"坏了"。
   */
  const role = `lg_test_owner_${id}`
  const password = randomBytes(24).toString('hex')
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 })
  let prepared: { url: string; pool: pg.Pool } | undefined
  try {
    // 就绪等待：实例可能刚起（compose 里 pgtest 与 simhost 并行启动）
    let ready = false
    for (let i = 0; i < 60; i++) {
      try {
        await admin.query('select 1')
        ready = true
        break
      } catch {
        await new Promise(done => setTimeout(done, 500))
      }
    }
    assert.ok(ready, `isolated PostgreSQL instance not ready: ${hostOf(adminUrl)}`)
    prepared = await prepareIsolatedDatabase(admin, adminUrl, role, password, database)
    /*
     * ⚠️ 生产目标要**显式**给出来，隔离判据才是真的在工作：
     *    `postgresIsolationDecision()` 会比较"本次目标 vs 生产目标"。
     *    生产目标由调用方（仿真编排）给出 —— 它是**仿真里那个 sumuwei 副本**的地址。
     */
    const productionTarget = (process.env.LG_SIM_PRODUCTION_POSTGRES_URL ?? '').trim()
    setPgTestEnvironment(prepared.url, {
      allowedHosts: [...LOOPBACK_HOSTS, hostOf(adminUrl)],
      productionTarget,
    })
    return await run({ database, url: prepared.url, pool: prepared.pool, admin })
  } finally {
    await prepared?.pool.end()
    await dropIsolatedDatabase(admin, database, role)
    await admin.end()
  }
}

/** Existing gate body runs in its own process; preparation explicitly applies LG migrations. */
export async function runPreparedPgGate(label: string, script: string): Promise<void> {
  /*
   * ⚠️ 超时**可配置**（2026-10-20）：原来写死 120s，而 `m4.5:measurement:verify`
   *    这类门在一次性容器上会超过它 ⇒ 子进程被杀 ⇒ 报 `actual: null`，
   *    看起来像"门的断言失败"，其实是**超时**（很难认出来）。
   *    ⇒ 默认仍是 120s（既有行为逐字不变），调用方需要时用
   *      `LG_PG_GATE_TIMEOUT_MS` 放宽。
   */
  const timeoutMs = Number(process.env.LG_PG_GATE_TIMEOUT_MS ?? 120_000)
  /*
   * ⚠️ **一个进程只一个 PG 目标**（2026-10-20 实测确认的不变量）
   *
   *   有些门在一个进程里调**多次** `isolateDatabase()`，并假设每次拿到一个**全新空库**
   *   （PGlite 时代每次就是一个新目录，这个假设自然成立）。PG 下做不到：
   *   `src/db/index.ts` 有"本进程已打开过另一个 PostgreSQL 目标，不能再换一个"的守卫，
   *   而且库身份核对（`LG_PG_EXPECT_DATABASE`）也不会跟着换。
   *
   *   ⇒ 曾试过"准备阶段预建 N 个空库 + 门体依次取走"，**已撤回**：
   *     它会撞上那条守卫。那 4 道门（`eval:m3` · `m4:restore` ·
   *     `m4:mutation-safety` · `m4:nl-mutation`）要真正跑起来，
   *     得改成**逐场景子进程**（每个场景一个新容器/新库），那是另一件事。
   *
   *   ⚠️ 顺带一条：`runPreparedPgGate` 只给**主库**装了三个扩展；
   *     真要建额外库，必须自己补 `vector/pgcrypto/fuzzystrmatch`，
   *     否则迁移 #10 的 `vector(384)` 建不出来（实测踩过）。
   */
  await withPgTest(label, async test => {
    const { applyKernelMigrations } = await import('../../src/infrastructure/persistence/db.ts')
    await applyKernelMigrations(drizzle(test.pool) as never)

    const outcome = runGateBody(script, test.url, timeoutMs)
    assert.equal(outcome.status, 0, `${label}: PostgreSQL gate failed${outcome.failureTail}`)
  })
}

/**
 * 跑门体子进程：**捕获**输出（而不是 inherit），并把它**原样**打回去。
 *
 * ⚠️ 为什么要捕获：失败时**门自己**的报错才是可诊断的那一条
 *    （实测：`m3:migrate-gate` 失败的真实原因是
 *    `live_smoke_closed_source_required`（它需要真实生产库副本源），
 *    而外层若只报 "PostgreSQL gate failed"，那条信息就**丢了**）。
 *    ⇒ 捕获后：① 原样转发（读数不丢）；② 把尾部带进错误消息（分类能看见原因）。
 */
function runGateBody (
  script: string,
  url: string,
  timeoutMs: number
): { status: number | null; failureTail: string } {
  const child = spawnSync(
    process.execPath,
    ['--import', './node_modules/tsx/dist/loader.mjs', script, ...process.argv.slice(2)],
    {
      env: { ...process.env, LG_TEST_PG_URL: url },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: timeoutMs,
    }
  )
  const stdout = child.stdout ?? ''
  const stderr = child.stderr ?? ''
  if (stdout !== '') process.stdout.write(stdout)
  if (stderr !== '') process.stderr.write(stderr)
  if (child.status === 0) return { status: 0, failureTail: '' }
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).filter(line => line.trim() !== '')
  return { status: child.status, failureTail: `\n—— 门体输出尾部 ——\n${lines.slice(-12).join('\n')}` }
}

/**
 * 仿真内执行同一道门（2026-10-21 · 认知能力建设计划 P0）。
 *
 * 与 `runPreparedPgGate()` 的**唯一**差别：
 *   · 库住在仿真里的**专用隔离实例**（compose 服务 `pgtest`），不是本机起的一次性容器；
 *   · 门体子进程**在 simhost 里**跑（执行位置由调用方保证）。
 * 准备阶段做的事**逐条相同**：显式应用 LG 迁移 + 身份核对 + `lg_test_` 前缀失败关闭。
 */
export async function runPreparedPgGateInInstance(
  adminUrl: string,
  label: string,
  script: string
): Promise<void> {
  const timeoutMs = Number(process.env.LG_PG_GATE_TIMEOUT_MS ?? 120_000)
  await withPgTestInInstance(adminUrl, label, async test => {
    const { applyKernelMigrations } = await import('../../src/infrastructure/persistence/db.ts')
    await applyKernelMigrations(drizzle(test.pool) as never)

    const outcome = runGateBody(script, test.url, timeoutMs)
    assert.equal(outcome.status, 0, `${label}: PostgreSQL gate failed${outcome.failureTail}`)
  })
}
