/**
 * A1 / **WP1c 的可运营入口**：`init`（初始化管理员口令）与 `serve`（起认证入口）。
 *
 * ```text
 * pnpm a1:admin:init  --dir <仓库外目录> [--password-file <文件>] [--force]
 * pnpm a1:admin:serve [--dir <仓库外目录>] [--port <端口>]
 * ```
 *
 * 三条刻意的设计（都能被门判红）：
 * ```text
 * ① **不接受 `--password <值>`**：命令行会进进程列表与 shell 历史 ⇒ 只接受
 *    交互输入（TTY）或 `--password-file <文件>`；非交互又没给文件 ⇒ 具名拒绝。
 * ② **`init` 不打印口令、不打印哈希**：只打印路径与 adminId。
 * ③ **`serve` 没有凭证就不起**（具名拒绝），且**只**绑 loopback —— 它不连核心、不开库。
 * ```
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminAuthError } from '../src/infrastructure/admin/auth.ts'
import {
  MIN_ADMIN_PASSWORD_LENGTH,
  defaultCredentialsDir,
  describeCredentialsDir,
  initAdminCredentials,
  readAdminCredentials,
} from '../src/infrastructure/admin/credentials.ts'
import { createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { createEffectiveConfigPort } from '../src/infrastructure/admin-ports/effective-config.ts'
import { createSafetyQuotaPort } from '../src/infrastructure/admin-ports/safety-quota.ts'
import { createJobsPort } from '../src/infrastructure/admin-ports/jobs.ts'
import { createGoalsCommitmentsPort } from '../src/infrastructure/admin-ports/goals-commitments.ts'
import { createCognitionPort } from '../src/infrastructure/admin-ports/cognition.ts'
import { createGoalsCommitmentsReader } from '../src/infrastructure/admin-readers/goals-commitments.ts'
import { createCognitionReader } from '../src/infrastructure/admin-readers/cognition.ts'
import { createAdminJobsStore } from '../src/infrastructure/admin-readers/admin-jobs-store.ts'
import { readCorePresence } from '../src/infrastructure/admin-readers/core-presence.ts'
import { createCoreStatusPort } from '../src/infrastructure/admin-ports/core-status.ts'
import { createCapabilityRegistry } from '../src/kernel/action/capability-registry.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { ADMIN_JOBS_ADMIT, ADMIN_JOBS_ADMIT_PERMISSION, createAdminJobsCapabilities } from '../src/kernel/action/admin-jobs-capability.ts'
import { createAdminJobsAdmitAdapter } from '../src/infrastructure/action/adapters/admin-jobs-admit.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { ADMIN_JOBS_REGISTER_OPERATION } from '../src/infrastructure/action/adapters/admin-jobs-admit.ts'
import type { AdminWritePorts } from '../src/infrastructure/admin/query-ports.ts'
import { AdminWriteError } from '../src/infrastructure/admin-ports/jobs-admit.ts'
import { parameterFingerprint } from '../src/infrastructure/admin-ports/jobs.ts'
import { attestActionInitiatorFromNamedExemption } from '../src/kernel/contracts/attribution.ts'
import { newActionId, newTraceId } from '../src/kernel/contracts/ids.ts'
import { isSuccessResult } from '../src/kernel/action/action-result.ts'
import { createJobsAdmitWritePort } from '../src/infrastructure/admin-ports/jobs-admit.ts'
import { corePresenceLabel } from '../src/infrastructure/admin/query-ports.ts'
import { createSafetyQuotaLedgerReader } from '../src/infrastructure/admin-readers/safety-quota.ts'
import { countQuotaUsage } from '../src/infrastructure/persistence/notification-store.ts'
import { readProactivePolicy } from '../src/kernel/app/flags.ts'
import type { AdminQueryPorts } from '../src/infrastructure/admin/query-ports.ts'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const usage = (): string =>
  [
    'A1 管理后台认证入口（WP1c）',
    '',
    '  init  --dir <仓库外目录> [--password-file <文件>] [--force]',
    '  serve [--dir <仓库外目录>] [--port <端口>]',
    '',
    `⚠️ 口令**不**接受命令行取值；口令至少 ${String(MIN_ADMIN_PASSWORD_LENGTH)} 个字符；凭证目录必须在仓库外。`,
  ].join('\n')

const argOf = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const readPasswordFromStdin = async (prompt: string): Promise<string> => {
  if (process.stdin.isTTY !== true) {
    throw new AdminAuthError(
      'admin_init_requires_tty',
      '拒绝：非交互终端下不接收口令。请在有 TTY 的终端跑，或用 --password-file <文件>（并自行确保该文件已删除）。'
    )
  }
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const ask = (question: string): Promise<string> => new Promise((done) => rl.question(question, done))
  try {
    const first = await ask(`${prompt}：`)
    const second = await ask('再输一次：')
    if (first !== second) throw new AdminAuthError('admin_init_mismatch', '拒绝：两次输入不一致。')
    return first
  } finally {
    rl.close()
  }
}

const runInit = async (argv: string[]): Promise<number> => {
  const dir = argOf(argv, '--dir') ?? defaultCredentialsDir()
  const passwordFile = argOf(argv, '--password-file')
  let password: string
  if (passwordFile !== undefined) {
    const path = resolve(passwordFile)
    if (!existsSync(path)) {
      console.error(`拒绝：口令文件不存在（${path}）`)
      return 2
    }
    password = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  } else {
    password = await readPasswordFromStdin('设置管理后台口令')
  }
  const reading = initAdminCredentials({
    location: { dir, repoRoot: REPO_ROOT },
    password,
    force: argv.includes('--force'),
  })
  /* ⚠️ 只打印路径与 adminId（不打印口令、不打印哈希） */
  console.log(`✅ 已写入凭证：${reading.path}`)
  console.log(`   adminId=${reading.adminId} · 替换了旧文件=${String(reading.replacedExisting)} · 明文入库=false`)
  console.log('   ⚠️ 若用了 --password-file，请**现在**删除那个文件。')
  return 0
}

/**
 * **`--with-db`：把真 `db` 注入装配根**（`WP2` 交接单 §1bis）。
 *
 * ```text
 * 开库顺序**抄现成的只读探针** `scripts/postgresql-cutover-probe.ts`：
 *   new AgentRuntime({character, plugins: [], settings: {POSTGRES_URL}})
 *   → initDatabase(runtime, sqlPlugin) → runtime.initialize()
 *   → initKernel(runtime, {definition}) → kernel.characterId / kernel.stores.db
 *   → 收尾 closeDatabaseConnection(runtime)
 * ⚠️ **默认不接**：不带 `--with-db` 时本函数**一次都不调用** ⇒ 今天的 `serve` 行为逐字不变
 *    （这也让离线门 `a1:serve:verify` 继续成立：它跑的是"没接 db"那条路）。
 * ⚠️ 它会**真的打开生产库**（读为主）：按 §4② 的规矩，跑之前要确认没有第二个 PG 目标、
 *    且真核心在跑时会撞单认知执行者资格锁（那是保护）。
 * ```
 */
const openAdminReadDb = async (): Promise<{
  db: unknown
  characterId: unknown
  close: () => Promise<void>
}> => {
  const { AgentRuntime } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { initKernel } = await import('../src/kernel/app/kernel.ts')
  const { characterDefinitionFromCharacter } = await import('../src/infrastructure/runtime/seed-projection.ts')
  const { closeDatabaseConnection } = await import('../src/infrastructure/persistence/runtime-shutdown.ts')
  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [],
    settings: { POSTGRES_URL: process.env.POSTGRES_URL ?? '' },
  })
  await initDatabase(runtime, sqlPlugin as never)
  await runtime.initialize()
  const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character as never) })
  return {
    db: kernel.stores.db,
    characterId: kernel.characterId,
    close: async () => {
      await closeDatabaseConnection(runtime)
    },
  }
}

/**
 * 装配根：**把只读端口接上**（`WP2`）。
 *
 * ```text
 * 默认只接 `effective_config`（真读数）+ `safety_quota`（配置侧真读）；其余如实 `unavailable`。
 * `--with-db` 时额外把三个 **reader** 接上（`goals_commitments` / `safety_quota` 账本侧 / `cognition`）。
 * ⚠️ 端口的实现放在 `src/infrastructure/admin-ports/**`：HTTP/认证/契约层因此仍然
 *    **零持久层 import**（门 `a1:query:verify` 的依赖边界判据继续成立）。
 * ```
 */
const buildQueryPorts = (readDb?: { db: unknown; characterId: unknown } | undefined): AdminQueryPorts => {
  const flagsPath = resolve(REPO_ROOT, 'src/kernel/app/flags.ts')
  const flagKeys = existsSync(flagsPath)
    ? [...readFileSync(flagsPath, 'utf8').matchAll(/env\.(CHARACTER_[A-Z0-9_]+)/g)].map((match) => match[1]!)
    : []
  const envPath = resolve(REPO_ROOT, '.env')
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : undefined
  /*
   * `--with-db` 时的三个真 reader（**只读**）。缺 `readDb` ⇒ 全是 `undefined` ⇒ 各面如实 `unavailable`。
   * ⚠️ reader 工厂是**静态 import**（脚本层允许认识持久层；被守的边界是 `admin/**` 与 `admin-ports/**`）。
   *    真正"开库"那一步只在 `--with-db` 时发生（见 `openAdminReadDb`）。
   */
  const goalsReader =
    readDb === undefined
      ? undefined
      : createGoalsCommitmentsReader({ db: readDb.db as never, characterId: readDb.characterId as never })
  /*
   * `safety_quota` 的**账本侧**（`§1ter ②`）：组合已过门（`a1:safety-quota-reader:verify` **28/0**），
   * 这里只是把它接上真 `db`：
   *   · `used()`      ← `countQuotaUsage`（`notification-store.ts:894`）+ `zonedDayWindow`（按**策略时区**）
   *   · `recentDenials` ← `createActionLedgerStore(db).listRecords({status:'rejected'})`（过滤交给 SQL）
   * ⚠️ 装配根上的 `as never` 是**刻意的**：这些端口/品牌类型在脚本层做一次窄化，
   *    免得把 kernel 的品牌类型一路拖进这个 CLI（语义没有变化，行为由门守）。
   */
  const ledgerReader =
    readDb === undefined
      ? undefined
      : createSafetyQuotaLedgerReader({
          characterId: readDb.characterId as never,
          timeZone: readProactivePolicy().timeZone,
          now: () => Date.now(),
          countUsage: async (query) => await countQuotaUsage(readDb.db as never, query as never),
          ledger: createActionLedgerStore(readDb.db as never) as never,
        })
  const cognitionReader =
    readDb === undefined
      ? undefined
      : createCognitionReader({ db: readDb.db as never, characterId: readDb.characterId as never })
  const jobsStore = readDb === undefined ? undefined : createAdminJobsStore(readDb.db as never)
  return {
    effectiveConfig: createEffectiveConfigPort({
      env: process.env,
      ...(envText === undefined ? {} : { envText }),
      defaultKeys: [...new Set(flagKeys)].sort(),
    }),
    /*
     * `safety_quota`：**配置侧现在就真读**；账本侧（用量/最近拒绝）**未接线** ⇒
     * 那两个字段如实进 `unavailable`（**不**用 0 冒充"没用过额度"）。
     */
    safetyQuota: createSafetyQuotaPort({ config: process.env, ...(ledgerReader === undefined ? {} : { ledger: ledgerReader }) }),
    /*
     * `jobs`：`--with-db` 时接**真任务来源**（`admin_jobs` 表 + 仓储，WP4 已过门 12/0）；
     * 不带旗标 ⇒ 该面如实 `unavailable: ['jobs']`（空数组不冒充"没有任务"）。
     *
     * ⚠️ `failureReason` 这一格**故意不给**：表里只有 `result_ref`（**引用**），
     *    把引用当"失败原因"就是编造 ⇒ 要么如实缺格，要么将来加一列（那要改迁移 + 冻结清单）。
     */
    jobs:
      readDb === undefined
        ? createJobsPort({})
        : createJobsPort({
            reader: {
              list: async ({ cursor, limit }) => {
                const page = await jobsStore!.list({
                  ...(cursor === undefined ? {} : { cursor }),
                  limit,
                })
                return {
                  items: page.items.map((row) => {
                    const terminal = row.state === 'succeeded' || row.state === 'failed' || row.state === 'interrupted'
                    return {
                      jobId: row.jobId,
                      kind: row.kind,
                      state: row.state,
                      startedAt: new Date(row.createdAt).toISOString(),
                      ...(terminal ? { finishedAt: new Date(row.updatedAt).toISOString() } : {}),
                    }
                  }),
                  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
                }
              },
            },
          }),
    /*
     * `goals_commitments`：**没接 reader** ⇒ 四个计数如实 `null` + `unavailable`
     * （生产 reader 复用既有投影，尚未接线）。
     */
    goalsCommitments:
      readDb === undefined ? createGoalsCommitmentsPort({}) : createGoalsCommitmentsPort({ reader: goalsReader }),
    /*
     * `cognition`：没接 reader ⇒ 五格如实 `null` + `unavailable`；`--with-db` 时接真 reader。
     * ⇒ 至此**五个面全部接线**（端口层）。
     */
    cognition: readDb === undefined ? createCognitionPort({}) : createCognitionPort({ reader: cognitionReader }),
    /*
     * 第六个面（用户 2026-10-14 裁定「核心状态加进页面，加第六个面」；`R-A1-5`）。
     * `--with-db` ⇒ 接**只读**探针（查 `pg_locks` 里的资格锁）；不带旗标 ⇒ 如实 `unavailable:['presence']`。
     * ⚠️ 探针**只信 `postgres` 后端**：别的后端回答不了这个问题（PGlite 上会静默返回 0 行）
     *    ⇒ 那种情况如实报"未知"，**不**报"离线"。
     */
    coreStatus:
      readDb === undefined
        ? createCoreStatusPort({})
        : createCoreStatusPort({
            reader: {
              read: async () =>
                await readCorePresence({
                  db: readDb.db,
                  characterId: readDb.characterId as string,
                  backend: process.env.CHARACTER_DB_BACKEND,
                }),
            },
          }),
  } as unknown as AdminQueryPorts
}

/**
 * ⚠️ 返回值有两态：`number` = 该退出的退出码；`'serving'` = 服务已经起来、**不许**在这里退出
 *    （第一版用 `process.argv[2] !== 'serve'` 判断，于是 `serve` 的**拒绝路径**也被吞掉、
 *     以退出码 0 结束 —— 门当场判红）。
 */
const runServe = async (argv: string[]): Promise<number | 'serving'> => {
  const dir = argOf(argv, '--dir') ?? defaultCredentialsDir()
  const credentials = readAdminCredentials(dir)
  if (credentials === undefined) {
    console.error(
      `拒绝：没有可用的凭证（${describeCredentialsDir(dir)}）。\n` +
        '  先跑：pnpm a1:admin:init --dir <仓库外目录>'
    )
    return 2
  }
  const portArg = argOf(argv, '--port')
  const port = portArg === undefined ? 0 : Number(portArg)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    console.error(`拒绝：端口非法（${String(portArg)}）`)
    return 2
  }
  /*
   * `--with-db`：把**真 `db`** 注入装配根（交接单 §1bis）。
   * ⚠️ 默认**不接** ⇒ 不带这个旗标时 `buildQueryPorts()` 收到的 `readDb` 是 `undefined`，
   *    各面如实 `unavailable`，行为与接线前**逐字相同**（离线门 `a1:serve:verify` 跑的就是这条路）。
   */
  const withDb = argv.includes('--with-db')
  let readDb: { db: unknown; characterId: unknown; close: () => Promise<void> } | undefined
  if (withDb) {
    /*
     * ⚠️ **必须先把 `.env` 读进来**（探针第 15 行就是这么做的）：
     *    不带它时 `process.env.POSTGRES_URL` 是空的 ⇒ 适配器回落到默认 PG 目标，
     *    而 `<cwd>/.env` 里的 `LG_PG_EXPECT_DATABASE=sumuwei` 又被 `src/db/index.ts` 重读进环境
     *    ⇒ 身份核对当场拒绝（实测读数：`期望 sumuwei，实际 template1`）。
     * ⚠️ 只在 `--with-db` 分支里加载：缺省路径的 `effective_config` 行为因此**逐字不变**
     *    （否则 `.env` 的值会从 `source:'file'` 变成 `source:'env'`）。
     */
    await import('dotenv/config')
    try {
      readDb = await openAdminReadDb()
      console.log('   已开库（--with-db）：三个只读 reader 接上（goals_commitments / cognition；safety_quota 账本侧仍如实 unavailable）')
      /*
       * `R-A1-5`（用户 2026-10-14 裁定「可以」）：**只读**探核心在线/离线 = 资格锁是否被持有。
       * ⚠️ **只打印在控制台**：`R-A1-2` 冻结了"恰好五个只读面"的清单 ⇒
       *    要把它放到**页面上**必须先有一次独立裁定（加面/加字段都会动冻结清单）。
       * ⚠️ 查不出来 ⇒ 如实说"未知"，**绝不**说"离线"。
       */
      const presence = await readCorePresence({
        db: readDb.db,
        characterId: readDb.characterId as string,
        backend: process.env.CHARACTER_DB_BACKEND,
      })
      console.log(
        `   ${corePresenceLabel(presence.presence)}` +
          (presence.unavailableReason === undefined ? '' : `（原因：${presence.unavailableReason}）`)
      )
    } catch (error) {
      console.error(
        `拒绝：--with-db 开库失败：${error instanceof Error ? error.message : String(error)}\n` +
          '  （真核心在跑时会撞单认知执行者资格锁 —— 那是保护；也可能 PG 目标/身份核对不通过）'
      )
      return 2
    }
  }
  /*
   * ========================================================================
   *  WP4：受控写面 `jobs.admit` 的**真接线**（走 ActionGateway；用户 2026-10-14 裁定）
   * ========================================================================
   * ```text
   * 这条路是**契约指定**的：控制面按 STOP 条件 14 只收只读命令，会写的动作**必须**
   *   走 Validation → Policy → ActionGateway → Event Ledger（`developer-control.ts:536-541`）。
   * ⚠️ `riskBudgetOverride: 'R2'` 只给**这一次调用**，**不**抬全局 `CHARACTER_ACTION_MAX_RISK`。
   * ⚠️ `requestedBy` 是**自报的输入证据**（`action-request.ts:187` 逐字）；
   *    权威 `initiator` 由具名豁免证据承担 = `SERVICE/admin-console`。
   * ⚠️ **动作落不进账本 ⇒ 抛 ⇒ 任务不登记**（失败关闭，`D09`）：这里**没有**"先审计再执行"
   *    的两步 —— 网关**自己**把动作记进账本，记不进就抛，两步是同一件事。
   * ⚠️ jobId 取自 `result.effect?.fingerprint`（`ActionResult.effect` 是**已定义**字段，不是猜的）；
   *    取不到 ⇒ 失败关闭，**不**回一个编出来的 id。
   * ⚠️ 不带 `--with-db` ⇒ **不接**（该写面如实 501 `write_not_wired`）。
   */
  let writePorts: AdminWritePorts | undefined
  const adminStore = readDb === undefined ? undefined : createAdminJobsStore(readDb.db as never)
  if (readDb !== undefined && adminStore !== undefined) {
    let jobSeq = 0
    const newJobIdOf = (): string => `admin-job-${String(Date.now())}-${String((jobSeq += 1))}`
    const registry = createCapabilityRegistry([...createAdminJobsCapabilities()])
    const gateway = createActionGateway({
      registry,
      ledger: createActionLedgerStore(readDb.db as never),
      adapters: [
        createAdminJobsAdmitAdapter({
          newJobIdOf,
          operatorOf: () => 'admin-console',
          admit: async (input) => await adminStore.admit(input),
        }),
      ],
      /* ⚠️ 权限**只授这一条**（不借用任何别处的授权集） */
      grantedPermissions: [ADMIN_JOBS_ADMIT_PERMISSION],
      /* ⚠️ 本次动作的风险上限（**不**抬全局 `CHARACTER_ACTION_MAX_RISK`） */
      maxRiskLevel: 'R2',
      now: () => Date.now(),
      /*
       * ⚠️⚠️ **这一步是 WP3 最后一格的关键**（2026-10-14 真读数查出来的）：
       *   `attribution` **不配 = 逐字段 legacy**（`gateway.ts:94-98` 逐字）⇒ 动作**照记**，
       *   但权威 `initiator` 落库成 `UNKNOWN`。
       *   实测：第一次跑完 `POST /api/jobs` 201 成功、动作账本里 `ACTION_SUCCEEDED` 在、
       *   `initiator_kind` 是空 —— 豁免被**接受**了却**没被记下**。
       *   ⚠️ 配上之后网关会**失败关闭**：拿不到受信 invocation 上下文就抛（WP5-3），
       *   这正是我们要的（不许退回 payload 自报）。
       */
      attribution: { decisionPointAdapterId: 'admin-console' },
      /*
       * 目标 = **管理控制台自己**（与用户输入无关 ⇒ `exact` 是如实的）。
       * ⚠️ 少这一支会落到沙箱梯子，被读成"目标不合法"—— 那不是"没接线"（`main.ts:3121` 的教训）。
       */
      resolveTarget: async () => ({
        target: { type: 'admin_console', canonicalId: 'admin-console', displayName: '管理控制台', confidence: 'exact' },
        scopeViolation: false,
      }),
    })
    const characterId = readDb.characterId as never
    writePorts = {
      jobsAdmit: async (input) => {
        /* ① 幂等键必填在路由层已判；这里再判一次（**不**依赖上层守规矩） */
        if (input.idempotencyKey.trim() === '') {
          throw new AdminWriteError('idempotency_key_required', '登记任务必须有幂等键')
        }
        /*
         * ② **同键的判定必须在我们这一层做**（2026-10-14 live 门抓到的真缺陷）：
         *    网关按**幂等键**重放（`gateway.ts:536-538`）而**不比较参数指纹**
         *    ⇒ "同键不同参数"会被**静默重放**，违反契约"同键不同参数明确拒绝"。
         *    ⇒ 有数据的那一层（`admin_jobs`）先判：同指纹 ⇒ 直接 `replayed`（**不产生第二次副作用**），
         *      不同指纹 ⇒ 抛 `idempotency_conflict`（⇒ 409）。
         */
        const fingerprint = parameterFingerprint(input.params)
        const priorJob = await adminStore.findByIdempotencyKey(input.idempotencyKey)
        if (priorJob !== undefined) {
          if (priorJob.paramsFingerprint !== fingerprint) {
            throw new AdminWriteError('idempotency_conflict', '同一幂等键、不同参数 ⇒ 拒绝（不静默重放）')
          }
          return { admission: 'replayed' as const, jobId: priorJob.jobId, state: priorJob.state }
        }
        /* ③ 风险级别**读声明**，不自己写（没登记 ⇒ 具名拒绝，不猜一个级别去执行） */
        const operation = registry.getOperation(ADMIN_JOBS_ADMIT, ADMIN_JOBS_REGISTER_OPERATION)
        if (operation === undefined) {
          throw new AdminWriteError('capability_not_registered', `${ADMIN_JOBS_ADMIT} 未登记`)
        }
        /* ④ 走**真网关**（动作自己进账本；记不进 ⇒ 抛 ⇒ 失败关闭） */
        const request = createActionRequest({
          actionId: newActionId(),
          /* ⚠️ 它**不属于任何一轮对话**（操作者在控制台点了一次）⇒ 新起一个 traceId */
          traceId: newTraceId(),
          capability: ADMIN_JOBS_ADMIT,
          operation: ADMIN_JOBS_REGISTER_OPERATION,
          requestedBy: { kind: 'system', id: 'admin-console' },
          arguments: { idempotencyKey: input.idempotencyKey, params: input.params },
          sideEffect: operation.sideEffect,
          idempotencyKey: input.idempotencyKey,
        })
        const result = await gateway.execute(characterId, request, {
          /* 权威 initiator = `SERVICE/admin-console`（**有据**：已认证会话） */
          initiatorEvidence: attestActionInitiatorFromNamedExemption({
            adapterId: 'admin-jobs-admit',
            exemption: 'admin_job_admission',
          }),
          riskBudgetOverride: 'R2',
        })
        /* ⑤ 只有 `isSuccessResult` 允许出现成功口吻（`partial`/非 success 不算） */
        if (!isSuccessResult(result)) {
          throw new AdminWriteError('admit_refused', `网关未受理：${result.status}`)
        }
        const jobId = result.effect?.fingerprint
        if (jobId === undefined || jobId === '') {
          throw new AdminWriteError('effect_missing', '动作成功但没有 effect 指纹（jobId）—— 失败关闭，不回一个编出来的 id')
        }
        const stored = await adminStore.read(jobId)
        return {
          /* ② 的重放判定已经走过 ⇒ 到这里的 `idempotentReplay` 只可能是**网关**的重放
             （例如上一轮进程崩了但任务已登记）⇒ 如实报 replayed */
          admission: result.idempotentReplay === true ? ('replayed' as const) : ('created' as const),
          jobId,
          state: stored?.state ?? 'pending',
        }
      },
    }
  }
  const server = createAdminAuthServer({
    passwordHash: credentials.passwordHash, host: '127.0.0.1', port,
    ports: buildQueryPorts(readDb),
    ...(writePorts === undefined ? {} : { writePorts }),
  })
  await server.start()
  console.log(`✅ 认证入口已起：${server.url}（只 loopback · 零数据库 · 零核心依赖）`)
  console.log(`   凭证：${describeCredentialsDir(dir)} · adminId=${credentials.adminId}`)
  /*
   * ⚠️ 横幅必须**随 `--with-db` 变**：第一版是无条件那句"数据源未接线 ⇒ 如实 unavailable"，
   *    与上一行"三个只读 reader 接上"**自相矛盾**（同一次启动里两句话互相打脸）。
   */
  console.log(
    withDb
      ? '   已接面（五个）：effective_config · goals_commitments · cognition（**真读数**，--with-db）· safety_quota / jobs（部分/全部如实 unavailable）'
      : '   已接面（五个）：effective_config（真读数）· safety_quota / jobs / goals_commitments / cognition（数据源未接线 ⇒ 如实 unavailable）'
  )
  console.log('   未接面（501）：无（五个面都已在端口层接线）')
  const stop = async (): Promise<void> => {
    await server.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  return 'serving'
}

const main = async (): Promise<number | 'serving'> => {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === 'init') return await runInit(argv)
  if (command === 'serve') return await runServe(argv)
  console.log(usage())
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2
}

try {
  const result = await main()
  /* ⚠️ 只有 `serve` **成功**时才不退出（否则刚起来的服务会被自己关掉） */
  if (result !== 'serving') process.exit(result)
} catch (error) {
  const code = error instanceof AdminAuthError ? error.code : 'admin_entry_failed'
  console.error(`[${code}] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
