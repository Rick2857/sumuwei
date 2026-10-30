/**
 * **F2 六单元序列编排（真实路径的父进程）**。
 *
 * ```text
 * 父进程（本模块）：started.lock → 逐单元 spawn 子进程 → 读回单元报告 + 请求账本
 *                  → **累计** 已用请求/token（跨单元）→ 用剩余额度给下一个单元设上限
 *                  → 账本不可读 / 有未确认成本 / 预算耗尽 ⇒ 停止整个序列（如实标 STOPPED）
 * 子进程（`--unit`）：isolateDatabase（一次性库，库名必须 lg_test_）→ 单元编排 → 账本/任务账本落盘
 * ```
 * ⚠️ 为什么必须子进程：同一进程里 db 连接池只认第一份连接串 ⇒ 六单元会串到同一个库。
 * ⚠️ 本模块**不发请求**：物理请求只发生在子进程的规划器 fetch 边界（并计量）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as guards from './f2-live-runner-guards.ts'

/** 一次性库的建库结果（每单元一个 `lg_test_*` 库 + 唯一角色）。 */
export interface F2ProvisionedUnit {
  readonly database: string
  readonly role: string
  readonly url: string
  readonly pool: { end: () => Promise<void> }
}

/** **真实建库路径**（父进程侧）：`prepareIsolatedDatabase` 建库+角色+扩展；返回只连该库的池。 */
export async function provisionF2UnitDatabase (
  admin: import('pg').Pool, adminUrl: string, label: string,
): Promise<F2ProvisionedUnit> {
  const harness = await import('../postgresql/test-harness.ts')
  const pgModule = (await import('pg')).default
  /* ⚠️ 标识符必须**全小写**：未加引号的 `create database` 会被 PG 小写化，URL 用原名会连不上。 */
  const database = `lg_test_f2_${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Math.random().toString(16).slice(2, 10)}`
  const role = `lg_test_owner_${Math.random().toString(16).slice(2, 10)}`
  const password = `pw${Math.random().toString(16).slice(2, 10)}`
  const prepared = await harness.prepareIsolatedDatabase(admin, adminUrl, role, password, database)
  /*
   * ⚠️ 真实产品启动前要求 Kernel schema 已就绪（否则子进程拒绝启动）。
   *    这里在**建库之后、交给子进程之前**应用迁移（与 test-harness 的准备阶段同源）。
   */
  const unitPool = new pgModule.Pool({ connectionString: prepared.url, max: 2 })
  try {
    const { applyKernelMigrations } = await import('../../src/infrastructure/persistence/db.ts')
    const { drizzle } = await import('drizzle-orm/node-postgres')
    await applyKernelMigrations(drizzle(unitPool) as never)
  } finally {
    await unitPool.end().catch(() => undefined)
  }
  return { database, role, url: prepared.url, pool: { end: async () => { await prepared.pool.end() } } }
}

/**
 * **清理并验证**：删除库+角色后**查系统目录**确认真的没了（不靠函数返回；错误不吞）。
 * 返回 `dbRemaining/roleRemaining`（0 = 已删）。
 */
export async function cleanupF2UnitDatabase (
  admin: import('pg').Pool, database: string, role: string,
): Promise<{ readonly dbRemaining: number | null, readonly roleRemaining: number | null, readonly error?: string }> {
  const harness = await import('../postgresql/test-harness.ts')
  let error: string | undefined
  try { await harness.dropIsolatedDatabase(admin, database, role) } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 160) : String(caught).slice(0, 160)
  }
  let dbRemaining: number | null = null
  let roleRemaining: number | null = null
  try {
    const dbRows = await admin.query('select count(*)::int as count from pg_database where datname = $1', [database])
    const roleRows = await admin.query('select count(*)::int as c from pg_roles where rolname = $1', [role])
    dbRemaining = Number(dbRows.rows[0]?.count ?? -1)
    roleRemaining = Number(roleRows.rows[0]?.c ?? -1)
  } catch (caught) {
    error = (error === undefined ? '' : error + '; ') + (caught instanceof Error ? caught.message.slice(0, 120) : String(caught).slice(0, 120))
  }
  return { dbRemaining, roleRemaining, ...(error === undefined ? {} : { error }) }
}

export interface F2SequenceUnit {
  readonly unit: string
  readonly arm: 'A' | 'B' | 'C'
  readonly order: 'cached-first' | 'authoritative-first'
}

export interface F2SequenceOptions {
  readonly units: readonly F2SequenceUnit[]
  readonly sequenceId: string
  readonly adminUrl: string
  readonly filesRoot: string
  /** 运行目录（账本 / 任务账本 / 单元报告）。 */
  readonly out: string
  /** ⚠️ 锁的**固定**基目录：锁按 `<lockBase>/locks/<startMarker>.lock` 落，换运行目录也拦得住。 */
  readonly lockBase: string
  /** 正式测量对象 id：用于"36 题完整分母"的恢复与在途/未运行标注。 */
  readonly measurementObjects: readonly string[]
  /** ⚠️ 诊断模式：**按单元**给测量对象（每单元 1 题），覆盖全局列表。 */
  readonly measurementObjectsOf?: (unit: string) => readonly string[]
  readonly startMarker: string
  readonly requestsCap: number
  readonly tokensCap: number
  readonly perTaskRequests: number
  /** `per-unit-admin`=真实路径（每单元建库）；`reuse-instance`=仅门用（复用实例库、每单元独立子进程）。 */
  readonly provisioning?: 'per-unit-admin' | 'reuse-instance'
  /** ⚠️ 门用：子进程完成 N 题后模拟崩溃。 */
  readonly crashAfterTasks?: number
  /**
   * ⚠️ 门用：把**指定单元的清理结果**注入为失败（模拟"删不掉"），用来验证"清理失败 ⇒ 立刻停止、不启动下一单元"。
   *    reuse-instance 模式下没有真实库可删 ⇒ 不存在泄漏；真实清理由建库门/simhost 组合门验证。
   */
  readonly gateSimulateCleanupFailureOnUnit?: string
  /** 子进程入口（默认本 CLI 自身）。 */
  readonly childScript: string
}

export interface F2SequenceUnitOutcome {
  readonly unit: string
  readonly arm: string
  readonly order: string
  /** 本单元**专属**的一次性库名（跑完删除）。 */
  readonly provisionedDb: string
  /** 本单元**专属**的一次性角色名（跑完删除；reuse-instance 模式为 null）。 */
  readonly provisionedRole: string | null
  readonly childExitCode: number | null
  readonly childSignal: string | null
  readonly report: undefined | {
    readonly db: { readonly name: string, readonly user: string }
    readonly stopCode?: string
    readonly costConfirmed: boolean
    readonly realModelRequests: number
    readonly recoveredTaskIds: readonly string[]
    readonly totals: { readonly requests: number, readonly tokens: number, readonly achieved: number, readonly tasks: number, readonly physicalRequests: number, readonly plannerCalls: number }
    readonly meter: { readonly requests: number, readonly tokens: number, readonly costVerifiable: boolean, readonly stopCode?: string }
  }
  readonly ledger: { readonly readable: boolean, readonly requests: number, readonly tokens: number, readonly unconfirmed: number, readonly inFlight: number }
  readonly journal: { readonly readable: boolean, readonly finished: number, readonly inFlight: number }
  /** 一次性库/角色清理的**验证结果**（查系统目录，不靠函数返回）。 */
  readonly cleanup: { readonly required: boolean, readonly dbRemaining: number | null, readonly roleRemaining: number | null, readonly error?: string }
  /** 该单元正式测量题：已完成（含崩溃前恢复）/在途/未运行。 */
  readonly tasks: { readonly expected: number, readonly finished: number, readonly inFlight: readonly string[], readonly notRun: readonly string[] }
}

export interface F2SequenceReport {
  readonly schema: 'f2-sequence-report@1'
  readonly status: 'COMPLETE' | 'STOPPED' | 'REFUSED'
  readonly code?: string
  readonly startMarker: string
  readonly units: readonly F2SequenceUnitOutcome[]
  readonly totals: {
    readonly units: number
    readonly tasks: number
    readonly achieved: number
    readonly physicalRequests: number
    readonly plannerCalls: number
    readonly tokens: number
    readonly recoveredTasks: number
    /** 正式测量完整分母（6 单元 × 6 题 = 36）；崩溃**不缩分母**。 */
    readonly expectedTasks: number
    readonly finishedTasks: number
    readonly inFlightTasks: number
    readonly notRunTasks: number
  }
  readonly budget: { readonly requestsCap: number, readonly tokensCap: number, readonly usedRequests: number, readonly usedTokens: number }
  readonly boundaries: readonly string[]
}

const STOP_CODES = new Set(['cost_unverifiable', 'budget_requests', 'budget_tokens', 'ledger_unreadable', 'journal_unreadable', 'task_request_cap', 'db_cleanup_failed', 'db_prepare_failed'])

export async function runF2Sequence (options: F2SequenceOptions): Promise<F2SequenceReport> {
  mkdirSync(options.out, { recursive: true })
  const lock = guards.acquireF2StartedLock(options.lockBase, options.startMarker)
  if ('code' in lock) {
    const refused: F2SequenceReport = {
      schema: 'f2-sequence-report@1', status: 'REFUSED', code: 'already_started', startMarker: options.startMarker,
      units: [],
      totals: {
        units: 0, tasks: 0, achieved: 0, physicalRequests: 0, plannerCalls: 0, tokens: 0, recoveredTasks: 0,
        expectedTasks: options.units.reduce((sum, unit) => sum
        + (options.measurementObjectsOf === undefined ? options.measurementObjects : options.measurementObjectsOf(unit.unit)).length, 0),
        finishedTasks: 0, inFlightTasks: 0, notRunTasks: options.units.length * options.measurementObjects.length,
      },
      budget: { requestsCap: options.requestsCap, tokensCap: options.tokensCap, usedRequests: 0, usedTokens: 0 },
      boundaries: [`started.lock 已在场 ⇒ **拒绝重跑**（锁固定在 <lockBase>/locks/${options.startMarker}.lock，换运行目录也拦得住）`],
    }
    writeFileSync(resolve(options.out, 'sequence-refused.json'), JSON.stringify(refused, null, 2) + '\n', 'utf8')
    return refused
  }
  const journalPath = resolve(options.out, 'tasks.jsonl')
  if (existsSync(journalPath) && !guards.readF2TaskJournal(journalPath).readable) {
    const refused = refusedReport(options, 'journal_unreadable')
    writeFileSync(resolve(options.out, 'sequence-refused.json'), JSON.stringify(refused, null, 2) + '\n', 'utf8')
    return refused
  }

  const outcomes: F2SequenceUnitOutcome[] = []
  let usedRequests = 0
  let usedTokens = 0
  let stopCode: string | undefined
  /*
   * ⚠️ **每单元真的建一个库**：`isolateDatabase` 只做"目标合法性校验"，**不**建库。
   *    这里用 admin 连接串建 `lg_test_*` 库 + 专属角色，跑完删除（一次性 PostgreSQL）。
   */
  const pg = (await import('pg')).default
  const harness = await import('../postgresql/test-harness.ts')
  const admin = new pg.Pool({ connectionString: options.adminUrl, max: 2 })
  try {
  for (const unit of options.units) {
    const remainingRequests = options.requestsCap - usedRequests
    const remainingTokens = options.tokensCap - usedTokens
    if (remainingRequests <= 0) { stopCode = 'budget_requests'; break }
    if (remainingTokens <= 0) { stopCode = 'budget_tokens'; break }
    const childReportPath = resolve(options.out, `child-${unit.unit}.json`)
    /* 一次性库：每单元一个 `lg_test_*` 库 + 专属角色；跑完删除。 */
    const reuse = (options.provisioning ?? 'per-unit-admin') === 'reuse-instance'
    let provisioned: F2ProvisionedUnit | undefined
    if (!reuse) {
      try {
        provisioned = await provisionF2UnitDatabase(admin, options.adminUrl, unit.unit)
      } catch (error) {
        console.error(`db_prepare_failed：${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`)
        stopCode = 'db_prepare_failed'
        break
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      F2_UNIT_CHILD: '1',
      F2_UNIT_ID: unit.unit, F2_UNIT_ARM: unit.arm, F2_UNIT_ORDER: unit.order,
      F2_RUN_DIR: options.out, F2_SEQUENCE_ID: options.sequenceId,
      /* ⚠️ 子进程只连**本单元的新库**（`isolateDatabase` 会校验 lg_test_ 前缀与 ≠ 生产目标）。 */
      LG_TEST_PG_URL: reuse ? options.adminUrl : (provisioned as F2ProvisionedUnit).url,
      /* ⚠️ thin-host 契约：只给 LG_TEST_PG_URL 不够，必须同时给后端与连接串（否则子进程无库可用）。 */
      CHARACTER_DB_BACKEND: 'postgres',
      POSTGRES_URL: reuse ? options.adminUrl : (provisioned as F2ProvisionedUnit).url,
      /* ⚠️ 产品启动会核对"连上的库/角色 == 期望身份"：期望必须**显式**是本单元的一次性库/角色。 */
      ...(reuse ? {} : {
        LG_PG_EXPECT_DATABASE: (provisioned as F2ProvisionedUnit).database,
        LG_PG_EXPECT_USER: (provisioned as F2ProvisionedUnit).role,
      }),
      /* ⚠️ **每单元独立文件根**：同根会让六单元互相看到彼此写入 ⇒ 不是隔离。 */
      F2_FILES_ROOT: resolve(options.filesRoot, unit.unit),
      F2_UNIT_REQUESTS_CAP: String(remainingRequests),
      F2_UNIT_TOKENS_CAP: String(remainingTokens),
      F2_PER_TASK_REQUESTS: String(options.perTaskRequests),
      ...(options.crashAfterTasks === undefined ? {} : { F2_GATE_CRASH_AFTER_TASKS: String(options.crashAfterTasks) }),
    }
    const child = spawnSync(process.execPath,
      ['--import', './node_modules/tsx/dist/loader.mjs', options.childScript, '--unit', unit.unit], {
        env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      })
    let cleanup: F2SequenceUnitOutcome['cleanup'] = { required: provisioned !== undefined, dbRemaining: null, roleRemaining: null }
    /* ⚠️ 门用：模拟"清理失败"——**与 provisioning 模式无关**，用来验证停止逻辑。 */
    if (options.gateSimulateCleanupFailureOnUnit === unit.unit) {
      cleanup = { required: true, dbRemaining: 1, roleRemaining: 0, error: 'gate_simulated_cleanup_failure' }
      console.error('db_cleanup_failed：gate_simulated_cleanup_failure（注入）')
      if (stopCode === undefined) stopCode = 'db_cleanup_failed'
    }
    /* ⚠️ 子进程的 stdout/stderr 必须留痕（否则失败原因只剩退出码）。 */
    writeFileSync(resolve(options.out, `child-${unit.unit}.log`),
      `# exit=${String(child.status)} signal=${String(child.signal)}\n--- stdout ---\n${String(child.stdout ?? '')}\n--- stderr ---\n${String(child.stderr ?? '')}\n`, 'utf8')
    if (provisioned !== undefined) {
      await provisioned.pool.end().catch(() => undefined)
      const verified = await cleanupF2UnitDatabase(admin, provisioned.database, provisioned.role)
      cleanup = { required: true, ...verified }
      if (verified.error !== undefined || verified.dbRemaining !== 0 || verified.roleRemaining !== 0) {
        cleanup = { required: true, dbRemaining: verified.dbRemaining, roleRemaining: verified.roleRemaining, ...(verified.error === undefined ? {} : { error: verified.error }) }
        console.error(`db_cleanup_failed：db=${String(cleanup.dbRemaining)} role=${String(cleanup.roleRemaining)} ${cleanup.error ?? ''}`)
        if (stopCode === undefined) stopCode = 'db_cleanup_failed'
      }
    }
    const report = existsSync(childReportPath)
      ? JSON.parse(readFileSync(childReportPath, 'utf8').replace(/^\uFEFF/, '')) as NonNullable<F2SequenceUnitOutcome['report']>
      : undefined
    const ledger = guards.readF2AttemptLedger(resolve(options.out, `ledger-${unit.unit}.jsonl`))
    const journal = guards.readF2TaskJournal(journalPath)
    /* ⚠️ 崩溃时单元报告缺失 ⇒ 用**任务账本**恢复该单元已完成的题（不缩分母、标出在途/未运行）。 */
    const unitObjects = options.measurementObjectsOf === undefined ? options.measurementObjects : options.measurementObjectsOf(unit.unit)
    const expectedIds = unitObjects.map(object => `${unit.unit}:${object}`)
    const finishedIds = new Set(journal.finished.map(entry => entry.taskId))
    const inFlightIds = expectedIds.filter(id => journal.inFlightTaskIds.includes(id))
    const notRunIds = expectedIds.filter(id => !finishedIds.has(id) && !inFlightIds.includes(id))
    const finishedInUnit = expectedIds.filter(id => finishedIds.has(id))
    outcomes.push({
      unit: unit.unit, arm: unit.arm, order: unit.order,
      provisionedDb: reuse ? `reused-instance:${options.adminUrl.includes('/') ? options.adminUrl.split('/').pop() : 'instance'}` : (provisioned as F2ProvisionedUnit).database,
      provisionedRole: reuse ? null : (provisioned as F2ProvisionedUnit).role,
      childExitCode: child.status, childSignal: child.signal,
      report,
      ledger: { readable: ledger.readable, requests: ledger.requests, tokens: ledger.tokens, unconfirmed: ledger.unconfirmed, inFlight: ledger.inFlight },
      journal: { readable: journal.readable, finished: journal.finished.length, inFlight: journal.inFlightTaskIds.length },
      cleanup,
      tasks: {
        expected: expectedIds.length,
        finished: finishedInUnit.length,
        inFlight: inFlightIds,
        notRun: notRunIds,
      },
    })
    /* ⚠️ 清理失败 ⇒ **立刻停止整个序列**（保留本单元账本/题行；不启动下一单元、不再发请求）。 */
    if (stopCode !== undefined) break
    /* 累计口径：**以账本为准**（请求账本就是成本对账的唯一来源）。 */
    if (!ledger.readable) { stopCode = 'ledger_unreadable'; break }
    usedRequests += ledger.requests
    usedTokens += ledger.tokens
    if (ledger.unconfirmed > 0) { stopCode = 'cost_unverifiable'; break }
    const unitStop = report?.stopCode ?? report?.meter?.stopCode
    if (unitStop !== undefined && STOP_CODES.has(unitStop)) { stopCode = unitStop; break }
    if (child.status !== 0) { stopCode = report?.stopCode ?? (child.status === 137 ? 'crash_simulated' : 'child_failed'); break }
  }
  } finally {
    await admin.end().catch(() => undefined)
  }

  const report: F2SequenceReport = {
    schema: 'f2-sequence-report@1',
    status: stopCode === undefined ? 'COMPLETE' : 'STOPPED',
    ...(stopCode === undefined ? {} : { code: stopCode }),
    startMarker: options.startMarker,
    units: outcomes,
    totals: {
      units: outcomes.length,
      tasks: outcomes.reduce((total, item) => total + (item.report?.totals.tasks ?? 0), 0),
      achieved: outcomes.reduce((total, item) => total + (item.report?.totals.achieved ?? 0), 0),
      physicalRequests: outcomes.reduce((total, item) => total + item.ledger.requests, 0),
      plannerCalls: outcomes.reduce((total, item) => total + (item.report?.totals.plannerCalls ?? 0), 0),
      tokens: usedTokens,
      recoveredTasks: outcomes.reduce((total, item) => total + (item.report?.recoveredTaskIds.length ?? 0), 0),
      expectedTasks: options.units.reduce((sum, unit) => sum
        + (options.measurementObjectsOf === undefined ? options.measurementObjects : options.measurementObjectsOf(unit.unit)).length, 0),
      finishedTasks: outcomes.reduce((total, item) => total + item.tasks.finished, 0),
      inFlightTasks: outcomes.reduce((total, item) => total + item.tasks.inFlight.length, 0),
      /* ⚠️ 未运行 = 分母 − 完成 − 在途：**从未启动的单元**也计入（不是只统计跑过的单元）。 */
      notRunTasks: options.units.reduce((sum, unit) => sum
        + (options.measurementObjectsOf === undefined ? options.measurementObjects : options.measurementObjectsOf(unit.unit)).length, 0)
        - outcomes.reduce((total, item) => total + item.tasks.finished, 0)
        - outcomes.reduce((total, item) => total + item.tasks.inFlight.length, 0),
    },
    budget: { requestsCap: options.requestsCap, tokensCap: options.tokensCap, usedRequests, usedTokens },
    boundaries: [
      '父进程只编排：**不发请求**；物理请求只在子进程的规划器 fetch 边界发出并计量',
      '六单元**累计**额度：每个子进程拿到的剩余额度 = 全局上限 − 已用（以请求账本为唯一口径）',
      '账本**即时落盘**（fetch 前 started / 结算后 finished）：有 started 没 finished ⇒ 在途 ⇒ 成本未知 ⇒ STOPPED',
      '账本不可读 / 有未确认成本 / 预算耗尽 / 建库或清理失败 ⇒ 整个序列 **STOPPED**（不续跑、不补采）',
      '崩溃后在途/未运行题按**任务账本**标注，正式测量分母固定为 6 × 6 = 36（不缩分母）',
      'started.lock 一次性：同一封存**拒绝重跑**；崩溃后恢复必须重新授权 + 重新封存',
    ],
  }
  writeFileSync(resolve(options.out, 'sequence-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  return report
}

function refusedReport (options: F2SequenceOptions, code: string): F2SequenceReport {
  return {
    schema: 'f2-sequence-report@1', status: 'REFUSED', code, startMarker: options.startMarker,
    units: [],
    totals: {
      units: 0, tasks: 0, achieved: 0, physicalRequests: 0, plannerCalls: 0, tokens: 0, recoveredTasks: 0,
      expectedTasks: options.units.reduce((sum, unit) => sum
        + (options.measurementObjectsOf === undefined ? options.measurementObjects : options.measurementObjectsOf(unit.unit)).length, 0),
      finishedTasks: 0, inFlightTasks: 0, notRunTasks: options.units.length * options.measurementObjects.length,
    },
    budget: { requestsCap: options.requestsCap, tokensCap: options.tokensCap, usedRequests: 0, usedTokens: 0 },
    boundaries: [`拒绝：${code}`],
  }
}
