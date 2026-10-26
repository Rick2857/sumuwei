/**
 * 逐场景子进程门执行器（2026-10-21 · 认知能力建设计划 P0.4）
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 *  有些门在一个进程里跑**多个场景**，并假设**每个场景从空白库开始**：
 *
 *   · `scripts/verify-m4-mutation-safety.ts` · `scripts/verify-m4-nl-mutation.ts`
 *     —— 每条用例开头 `isolateDatabase()`，期望"上一条撤掉的东西不会让下一条空过"。
 *   · `scripts/eval-m3.ts`
 *     —— 126 条用例，每条用例装配一次运行环境（`evals/m3/runtime/host.ts` 的 `assemble`）。
 *
 *  PGlite 时代这个前提**天然成立**：`isolateDatabase()` 每次换一个**数据目录**。
 *  PostgreSQL 下不成立 —— `isolateDatabase()` 的 PG 分支只是把 `POSTGRES_URL`
 *  再指一次 ⇒ **第二个场景看到的是第一个场景写下的数据**。
 *
 *  实测症状（2026-10-21，仿真内隔离实例）：
 *   · `m4:mutation-safety` → `提案被拒：duplicate_content`
 *   · `m4:nl-mutation`      → `提案被拒：duplicate_content`
 *   · `eval:m3`             → `Seed 版本不允许回退：库里是 v4，代码里是 v3`
 *     （`M3-ID-004` 故意把 Seed 升到 v4；它之后的用例继承了那个库）
 *
 * ============================================================================
 *  本模块的处置：**逐场景子进程**
 * ============================================================================
 *  每个场景 = 一个**独立进程** + 一个**独立的空白库**。
 *
 *  ⚠️ 这样做**没有**放松"同进程只允许一个 PostgreSQL 目标"这条产品不变量
 *     （`src/db/index.ts` 的 `postgresTargetGuard` 一字未动）：
 *     进程内目标**从不改变**，所以那条守卫**根本不会被触发**。
 *     隔离的强度来自"**进程**边界 + **库**边界"，不是来自放松守卫。
 *
 *  两个模式：
 *   · **仿真模式**（给了 `LG_SIM_PGTEST_ADMIN_URL`）：门体跑在 simhost 内，
 *     库住在仿真的**专用隔离实例**里。
 *   · **宿主模式**：每个场景一个**一次性容器**（既有 `withPgTest` 行为）。
 *
 * ============================================================================
 *  快车道：模板库
 * ============================================================================
 *  逐场景 = 逐场景建库 + 逐场景跑迁移，那是**最贵**的部分（126 条用例会变成几十分钟）。
 *  PostgreSQL 有原生手段：`CREATE DATABASE <新库> TEMPLATE <模板库>`
 *  —— 一次文件级拷贝，**秒级**，且 schema 与迁移记录都带过去。
 *
 *  ⇒ 准备阶段做**一次**（建模板库 + 装扩展 + 显式应用 LG 迁移），
 *    每个场景只做"从模板拷一个空库"。
 *  ⇒ 模板库里**没有**任何场景数据 ⇒ 拷出来的库**确实是空白**的。
 * ============================================================================
 */

import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import pg from 'pg'

import {
  dropIsolatedDatabase,
  pgAdminCredentials,
  pgAdminHost,
  pgAdminPort,
  prepareIsolatedDatabase,
  setPgTestEnvironment,
} from './test-harness.ts'

export interface PgScenario {
  /** 场景 id（唯一；会出现在报告与日志里） */
  id: string
  /** 传给门体子进程的额外参数 */
  argv: string[]
  /**
   * 这个场景**额外需要**几个独立的空白库。
   *
   * ⚠️ 为什么要"额外"：有的场景本身要在**两个独立库**上各跑一次
   *    （例：`verify-m4-nl-mutation.ts` 的 L3-07「两个独立库上得到同一个结论」）。
   *    单库做不到 ⇒ harness 额外准备 N 个空白库，把 URL 依次放在
   *    `LG_TEST_PG_URL_ALT_1` … `LG_TEST_PG_URL_ALT_N` 里给门体。
   */
  extraDatabases?: number
}

export interface ScenarioOutcome {
  id: string
  ok: boolean
  exitCode: number | null
  /** 门体输出（尾部若干行，便于定位） */
  tail: string
  /** 门体输出里的**一行摘要**（通常是"…：N 通过 / M 失败"） */
  summary: string
  detail?: string
}

export interface ScenarioGateOptions {
  /** 人读标签 */
  label: string
  /** 门体脚本（相对仓库根） */
  script: string
  /** 场景清单 */
  scenarios: PgScenario[]
  /** 单个场景的超时（毫秒） */
  timeoutMs?: number
  /** 隔离实例的 admin 连接串（仿真模式）；不给 ⇒ 宿主模式 */
  adminUrl?: string
}

/** 门体输出尾部保留多少行（够定位，又不至于把日志撑爆） */
const TAIL_LINES = 40

function tailOf (output: string): string {
  const lines = output.split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.slice(-TAIL_LINES).join('\n')
}

/**
 * 从门体输出里取**一行摘要**（通常是门自己的"…：N 通过 / M 失败"）。
 *
 * ⚠️ 为什么要有它：逐场景执行时门体的 stdout 是被**捕获**的（不是 inherit），
 *    ⇒ 成功场景的读数**不会**出现在宿主日志里。
 *    ⇒ 这一行摘要补上"每个场景都留下读数"，否则日志里只剩 PASS/FAIL 两个字母。
 */
function summaryOf (output: string): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (/\d+\s*通过\s*\/\s*\d+\s*失败/.test(line)) return line
  }
  return lines.at(-1) ?? ''
}

/** 跑一次门体子进程；返回退出码与输出 */
function spawnGateBody (
  script: string,
  argv: string[],
  url: string,
  timeoutMs: number,
  altUrls: string[] = []
): { status: number | null; output: string } {
  const env: Record<string, string> = { ...process.env, LG_TEST_PG_URL: url }
  altUrls.forEach((alt, index) => {
    env[`LG_TEST_PG_URL_ALT_${String(index + 1)}`] = alt
  })
  const child = spawnSync(
    process.execPath,
    ['--import', './node_modules/tsx/dist/loader.mjs', script, ...argv],
    {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    }
  )
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  return { status: child.status, output }
}

/**
 * 从**模板库**拷一个空库出来。
 *
 * ⚠️ 扩展是**库级**对象；模板拷贝是否把它们带过去**不靠猜** ——
 *    这里用 `CREATE EXTENSION IF NOT EXISTS` **幂等**补一次。
 */
async function createDatabaseFromTemplate (
  admin: pg.Pool,
  template: string,
  database: string,
  credentials: { user: string; password: string },
  host: string,
  port: number,
  owner: string
): Promise<void> {
  await admin.query(`create database ${database} template ${template} owner ${owner}`)
  const ext = new pg.Client({
    host, port, user: credentials.user, password: credentials.password, database,
  })
  await ext.connect()
  try {
    await ext.query(
      'create extension if not exists vector; create extension if not exists fuzzystrmatch; create extension if not exists pgcrypto;'
    )
  } finally { await ext.end() }
}

/**
 * 列出门自己声明的场景清单。
 *
 * 约定：门体支持 `--list-cases`，每行一个场景，格式 `id<TAB>额外独立库数`。
 * ⇒ 场景清单的**唯一事实源在门里**（不在这儿复述第二份）。
 */
export function listPgScenarios (
  script: string,
  listFlag = '--list-cases'
): Array<{ id: string; extraDatabases: number }> {
  const child = spawnSync(
    process.execPath,
    ['--import', './node_modules/tsx/dist/loader.mjs', script, listFlag],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }
  )
  if (child.status !== 0) {
    throw new Error(`${script} ${listFlag} 退出码 ${String(child.status)}：${tailOf(`${child.stdout ?? ''}${child.stderr ?? ''}`)}`)
  }
  return (child.stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [id, extra] = line.split('\t')
      return { id: (id ?? '').trim(), extraDatabases: Number(extra ?? '0') || 0 }
    })
    .filter(entry => entry.id !== '')
}

/** 在**宿主模式**下逐场景跑（每个场景一个一次性容器） */
async function runScenariosOnDisposableContainer (
  options: ScenarioGateOptions
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = []
  const { withPgTest } = await import('./test-harness.ts')
  for (const scenario of options.scenarios) {
    try {
      await withPgTest(`${options.label}-${scenario.id}`, async test => {
        const { applyKernelMigrations } = await import('../../src/infrastructure/persistence/db.ts')
        const { drizzle } = await import('drizzle-orm/node-postgres')
        await applyKernelMigrations(drizzle(test.pool) as never)

        /*
         * ⚠️ 额外库：从**已迁移好的主库**拷（模板库）。
         *    拷贝要求模板**没有连接** ⇒ 先把池关掉（门体自己会重连）。
         */
        const extraUrls: string[] = []
        const extraCount = scenario.extraDatabases ?? 0
        if (extraCount > 0) {
          const target = new URL(test.url)
          const role = decodeURIComponent(target.username)
          const password = decodeURIComponent(target.password)
          const host = target.hostname
          const port = Number(target.port || '5432')
          const adminCredentials = pgAdminCredentials(test.adminUrl)
          await test.pool.end()
          for (let index = 0; index < extraCount; index += 1) {
            const database = `lg_test_${randomBytes(6).toString('hex')}`
            await createDatabaseFromTemplate(test.admin, test.database, database, adminCredentials, host, port, role)
            extraUrls.push(
              `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}`
            )
          }
        }

        const child = spawnGateBody(options.script, scenario.argv, test.url, options.timeoutMs ?? 600_000, extraUrls)
        outcomes.push({
          id: scenario.id,
          ok: child.status === 0,
          exitCode: child.status,
          tail: tailOf(child.output),
          summary: summaryOf(child.output),
          ...(child.status === 0 ? {} : { detail: `退出码 ${String(child.status)}` }),
        })
      })
    } catch (error) {
      outcomes.push({
        id: scenario.id,
        ok: false,
        exitCode: null,
        tail: '',
        summary: '',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}

/**
 * 在**已隔离的实例**里逐场景跑（仿真模式）。
 *
 * 准备阶段只做**一次**：建角色 + 建**模板库** + 装扩展 + **显式应用 LG 迁移**。
 * 每个场景：从模板拷一个空库 → 跑门体 → 删库。
 */
async function runScenariosInInstance (
  options: ScenarioGateOptions,
  adminUrl: string
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = []
  const id = randomBytes(6).toString('hex')
  // 共享 pgtest 实例允许多组门同时运行，角色与模板必须属于同一轮。
  const role = `lg_test_owner_${id}`
  const password = randomBytes(24).toString('hex')
  const template = `lg_test_tpl_${id}`
  const host = pgAdminHost(adminUrl)
  const port = pgAdminPort(adminUrl)
  const credentials = pgAdminCredentials(adminUrl)
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 })

  const productionTarget = (process.env.LG_SIM_PRODUCTION_POSTGRES_URL ?? '').trim()

  const freshDatabaseUrl = (database: string): string =>
    `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}`

  try {
    // --- 准备：角色 + 模板库（显式迁移）-----------------------------------
    await admin.query(`create role ${role} login password '${password}' nosuperuser nobypassrls;`)
    await admin.query(`create database ${template} owner ${role}`)
    const templateUrl = freshDatabaseUrl(template)
    const templatePool = new pg.Pool({ connectionString: templateUrl, max: 2 })
    try {
      // 扩展必须由**超级用户**装（`vector` 不是 trusted 扩展），且装在**本库**里。
      const ext = new pg.Client({
        host, port, user: credentials.user, password: credentials.password, database: template,
      })
      await ext.connect()
      try { await ext.query('create extension vector; create extension fuzzystrmatch; create extension pgcrypto;') }
      finally { await ext.end() }

      const { applyKernelMigrations } = await import('../../src/infrastructure/persistence/db.ts')
      const { drizzle } = await import('drizzle-orm/node-postgres')
      await applyKernelMigrations(drizzle(templatePool) as never)
    } finally {
      // ⚠️ 模板库必须**没有连接**才能被 `CREATE DATABASE ... TEMPLATE` 拷贝。
      await templatePool.end()
    }

    // --- 逐场景 ----------------------------------------------------------
    for (const scenario of options.scenarios) {
      const database = `lg_test_${randomBytes(6).toString('hex')}`
      const extraDatabases: string[] = []
      let pool: pg.Pool | undefined
      try {
        await createDatabaseFromTemplate(admin, template, database, credentials, host, port, role)
        const url = freshDatabaseUrl(database)
        pool = new pg.Pool({ connectionString: url, max: 4 })

        // 场景自己要的**额外独立库**（例：L3-07 要在两个库上各跑一次）
        for (let index = 0; index < (scenario.extraDatabases ?? 0); index += 1) {
          const alt = `lg_test_${randomBytes(6).toString('hex')}`
          await createDatabaseFromTemplate(admin, template, alt, credentials, host, port, role)
          extraDatabases.push(freshDatabaseUrl(alt))
        }

        setPgTestEnvironment(url, {
          allowedHosts: ['127.0.0.1', 'localhost', host],
          productionTarget,
        })

        const child = spawnGateBody(options.script, scenario.argv, url, options.timeoutMs ?? 600_000, extraDatabases)
        outcomes.push({
          id: scenario.id,
          ok: child.status === 0,
          exitCode: child.status,
          tail: tailOf(child.output),
          summary: summaryOf(child.output),
          ...(child.status === 0 ? {} : { detail: `退出码 ${String(child.status)}` }),
        })
      } catch (error) {
        outcomes.push({
          id: scenario.id,
          ok: false,
          exitCode: null,
          tail: '',
          summary: '',
          detail: error instanceof Error ? error.message : String(error),
        })
      } finally {
        await pool?.end()
        await admin.query(`drop database if exists ${database} with (force)`).catch(() => undefined)
        for (const alt of extraDatabases) {
          const name = decodeURIComponent(new URL(alt).pathname.replace(/^\/+/, ''))
          await admin.query(`drop database if exists ${name} with (force)`).catch(() => undefined)
        }
      }
    }
  } finally {
    await admin.query(`drop database if exists ${template} with (force)`).catch(() => undefined)
    await dropIsolatedDatabase(admin, template, role)
    await admin.end()
  }
  return outcomes
}

/**
 * 逐场景跑一道门。
 *
 * 宿主模式（不给 `adminUrl`）与仿真模式（给 `adminUrl`）**语义相同**：
 * 每个场景一个独立进程 + 一个独立空白库。
 */
export async function runPgScenarioGate (options: ScenarioGateOptions): Promise<ScenarioOutcome[]> {
  const adminUrl = (options.adminUrl ?? process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  if (adminUrl !== '') {
    return await runScenariosInInstance(options, adminUrl)
  }
  return await runScenariosOnDisposableContainer(options)
}
