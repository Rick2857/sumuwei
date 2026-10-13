/**
 * 数据库**后端选择**与**目标身份核对**（WP1）。
 *
 * ============================================================================
 *  为什么需要这个模块（一条事故的形状）
 * ============================================================================
 *  `@elizaos/plugin-sql@1.7.2` 选后端只有一条判据：
 *
 *      runtime.getSetting('POSTGRES_URL') 有值 → PgDatabaseAdapter
 *                                          无值 → PgliteDatabaseAdapter
 *
 *  于是"换库"会变成**任何**继承到 `POSTGRES_URL` 的子进程都能悄悄做的事 ——
 *  和 INC-01 的同一形状（一个环境变量就能把保护打开）。
 *
 *  WP1 的裁定（ADR-132 `D01`/`D02`）：换后端必须是**一个显式动作**，
 *  且规范化只发生**一处**：
 *
 *      CHARACTER_DB_BACKEND = 'pglite' | 'postgres'      ← 闭集，非法值拒绝
 *      POSTGRES_URL                                       ← 沿用插件唯一认的那个名字
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 纯追加：**不设** `CHARACTER_DB_BACKEND` 时行为逐字节不变
 * ---------------------------------------------------------------------------
 *  `resolveDatabaseBackend({})`（或字段缺席）⇒ `backend='pglite'`、`problems=[]`
 *  ⇒ 既有入口**一行都不用改**就会走今天的老路。
 *  这是刻意的：`m4.5:ci` 等既有门在未设该字段时必须**不受影响**。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 这个模块**不许**碰数据库、不许读盘、不许打印环境
 * ---------------------------------------------------------------------------
 *  它只做"从环境变量算出一个结果 + 具名问题清单"。真正的身份核对在
 *  `verifyDatabaseIdentity()`（要一个已打开的连接句柄）。
 *  `POSTGRES_URL` 允许带密码 ⇒ **任何**日志/错误/证据都不许整体打印它，
 *  只能用 `redactPostgresUrl()`。
 */

import { KernelError } from '../../kernel/contracts/index.ts'

/** 闭集后端标识。只此两个值。 */
export type DatabaseBackend = 'pglite' | 'postgres'

/** 配置解析问题的**具名**码（供门断言与日志聚合，不靠字符串匹配） */
export type DatabaseBackendProblem =
  /** 显式选了 postgres，但没有连接串 */
  | 'postgres_url_missing'
  /** 字段值不在闭集里（**不**做拼写纠正） */
  | 'backend_unknown'
  /** 有连接串，却没显式选 postgres（防止"设了 URL 以为切了"） */
  | 'postgres_url_without_backend'
  /** 连接串不是合法的 postgres URL */
  | 'postgres_url_invalid'

export interface DatabaseBackendResolution {
  /** 原始字段值（trim 后；未设则 undefined） */
  requested: string | undefined
  /** 解析结果。`problems` 非空时**不可**用于开库 */
  backend: DatabaseBackend
  /** 仅 `backend === 'postgres'` 时有值 */
  postgresUrl: string | undefined
  /** 仅 `backend === 'pglite'` 时有值（插件 `resolvePgliteDir` 的同一来源） */
  dataDir: string | undefined
  /** 非空 ⇒ 调用方必须**拒绝启动**（失败关闭；禁止回落 PGlite） */
  problems: DatabaseBackendProblem[]
}

/** 只读一样东西：环境。注入以便纯函数测试。 */
export type DatabaseBackendEnvironment = {
  CHARACTER_DB_BACKEND?: string | undefined
  POSTGRES_URL?: string | undefined
  DATABASE_URL?: string | undefined
  PGLITE_DATA_DIR?: string | undefined
  /** 测试隔离标记（`isolateDatabase()` 设置） */
  PROJECT_LG_SANDBOX?: string | undefined
}

/** 从 `process.env` 取本模块关心的那几项（**不**展开、不打印） */
export function databaseBackendEnvironmentFrom(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): DatabaseBackendEnvironment {
  return {
    CHARACTER_DB_BACKEND: env.CHARACTER_DB_BACKEND,
    POSTGRES_URL: env.POSTGRES_URL,
    DATABASE_URL: env.DATABASE_URL,
    PGLITE_DATA_DIR: env.PGLITE_DATA_DIR,
    PROJECT_LG_SANDBOX: env.PROJECT_LG_SANDBOX,
  }
}

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === ''

/**
 * **唯一**的规范化点。
 *
 * `DATABASE_URL` 只参与"检测到冲突"（`postgres_url_without_backend` 的兜底），
 * **不**参与后端选择 —— 在 plugin-sql 1.7.2 里它只进 `migrate()` 的
 * advisory lock 判定。这一条与实践里"设了 DATABASE_URL 就是 PG 后端"的误传相反，
 * 因此单独留了诊断字段（见下），让误传能被**读出来**而不是靠记忆。
 */
export function resolveDatabaseBackend(
  env: DatabaseBackendEnvironment
): DatabaseBackendResolution {
  const requested = blank(env.CHARACTER_DB_BACKEND) ? undefined : env.CHARACTER_DB_BACKEND!.trim()
  const postgresUrl = blank(env.POSTGRES_URL) ? undefined : env.POSTGRES_URL!.trim()
  const databaseUrl = blank(env.DATABASE_URL) ? undefined : env.DATABASE_URL!.trim()
  const dataDir = blank(env.PGLITE_DATA_DIR) ? undefined : env.PGLITE_DATA_DIR!.trim()

  const problems: DatabaseBackendProblem[] = []

  if (requested !== undefined && requested !== 'pglite' && requested !== 'postgres') {
    // 刻意不纠错：'postgresl' / 'pg' / '' 一律拒绝，避免"看起来像就当它是"
    problems.push('backend_unknown')
    return { requested, backend: 'pglite', postgresUrl: undefined, dataDir, problems }
  }

  const backend: DatabaseBackend = requested === 'postgres' ? 'postgres' : 'pglite'

  if (backend === 'postgres') {
    if (postgresUrl === undefined) {
      problems.push('postgres_url_missing')
      return { requested, backend, postgresUrl: undefined, dataDir, problems }
    }
    if (!isPostgresUrl(postgresUrl)) {
      problems.push('postgres_url_invalid')
      return { requested, backend, postgresUrl: undefined, dataDir, problems }
    }
    return { requested, backend, postgresUrl, dataDir, problems }
  }

  // backend === 'pglite'：有连接串但没显式选 ⇒ 拒绝（不静默按 pglite 跑）
  if (postgresUrl !== undefined || databaseUrl !== undefined) {
    problems.push('postgres_url_without_backend')
  }
  return { requested, backend, postgresUrl: undefined, dataDir, problems }
}

/**
 * 连接串是不是 PostgreSQL。
 *
 * 与 plugin-sql 自己的 `isRealPostgresDatabase()` **同形**（它只在 `migrate()`
 * 的 advisory lock 判定里用）：先排除非 PG scheme 与 `:memory:`，再看 PG scheme。
 * 这里**不**引入额外的"猜测"规则 —— 判据要与插件一致，否则会出现
 * "我们以为它在用 PG 池、其实插件走了 PGlite"的分叉。
 */
export function isPostgresUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  if (lower === '') return false
  if (lower.includes(':memory:')) return false
  const nonPg = ['mysql://', 'mysqli://', 'mariadb://', 'mongodb://', 'mongodb+srv://']
  if (nonPg.some((s) => lower.startsWith(s))) return false
  const pg = [
    'postgres://',
    'postgresql://',
    'postgis://',
    'pgbouncer://',
    'pgpool://',
    'cockroach://',
    'cockroachdb://',
    'redshift://',
    'timescaledb://',
    'yugabyte://',
  ]
  return pg.some((s) => lower.startsWith(s))
}

/** 脱敏的 URL 形状（**唯一**允许出现在日志/错误/证据里的形式） */
export function redactPostgresUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const hasPassword = parsed.password !== ''
    return `${parsed.protocol}//${parsed.username === '' ? '' : '<user>'}@${parsed.host}${parsed.pathname}${
      hasPassword ? ' (password: <redacted>)' : ''
    }`
  } catch {
    return '<unparseable postgres url>'
  }
}

/**
 * 规范化目标三元组，用于"两个目标是不是同一个"的比较。
 *
 * ⚠️ 刻意**不按字符串比**：`localhost` / `127.0.0.1` / 尾部斜杠 / 大小写 /
 * 默认端口显式写出来，都会让字符串比得出错误结论 ——
 * 而"隔离目标 ≠ 生产目标"这条断言一旦比错，就是**放行**。
 * 比不出来时（解析失败）返回 `undefined`，调用方必须**失败关闭**。
 */
export interface DatabaseTarget {
  protocol: string
  host: string
  port: string
  database: string
}

export function parseDatabaseTarget(url: string): DatabaseTarget | undefined {
  try {
    const parsed = new URL(url)
    // ⚠️ 两侧都要去斜杠：`.../db/` 与 `.../db` 是同一个库。
    //    只去开头会漏掉尾斜杠 ⇒ 同一个库被判成不同目标 ⇒ 隔离判定放行。
    const database = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    return {
      protocol: parsed.protocol.toLowerCase(),
      host: parsed.hostname.toLowerCase(),
      // 不显式写端口时留空串：比较阶段再用"默认端口"补齐，避免 5432 vs '' 的假不等
      port: parsed.port === '' ? '' : parsed.port,
      database,
    }
  } catch {
    return undefined
  }
}

const DEFAULT_PORTS: Record<string, string> = {
  'postgres:': '5432',
  'postgresql:': '5432',
  'postgis:': '5432',
  'pgbouncer:': '5432',
  'pgpool:': '5432',
  'cockroach:': '26257',
  'cockroachdb:': '26257',
  'redshift:': '5439',
  'timescaledb:': '5432',
  'yugabyte:': '5433',
}

/**
 * 回环地址的**别名归一**（WP1，实际加固：不归一会漏判）。
 *
 * ```text
 * 生产目标：postgres://u@127.0.0.1:5432/lg_prod
 * 隔离目标：postgres://u@localhost:5432/lg_prod    ← 同一个库，字面不同
 * ```
 * 不归一 ⇒ `isSameDatabaseTarget` 判"不同" ⇒ **放行** ⇒ 隔离实验连上生产库。
 * 这正是 `D03` 要防的形状，所以三个 loopback 写法必须折叠成同一个。
 *
 * ⚠️ 这里**只**折叠回环别名。刻意**不**做 DNS 解析、不折叠任意主机名 ——
 *    那会引入"网络依赖 + 解析歧义"两个新变量，而它们都会让判据变得不可测。
 *    代价如实登记：`db.internal` 与它的 IP 形式仍会被判为不同（见 Known-Limitations）。
 */
const LOOPBACK_ALIASES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0000:0000:0000:0000:0000:0000:0000:0001'])

function canonicalHost(host: string): string {
  const lower = host.toLowerCase()
  return LOOPBACK_ALIASES.has(lower) ? 'loopback' : lower
}

/**
 * scheme 别名归一。
 *
 * 与主机名同理：`postgres://` 与 `postgresql://` 是**同一个东西的两种写法**，
 * 拿它们当区分会导致"同一个库被判成不同目标" ⇒ 隔离判定放行。
 * 折叠到 `postgres`。`postgis://` 等其它 PG 家族 scheme 保留原样（它们的默认端口不同）。
 */
function canonicalProtocol(protocol: string): string {
  const lower = protocol.toLowerCase()
  return lower === 'postgresql:' ? 'postgres:' : lower
}

/** 补齐默认端口后的比较键（用于"是不是同一个目标"） */
export function databaseTargetKey(target: DatabaseTarget): string {
  const protocol = canonicalProtocol(target.protocol)
  const port = target.port !== '' ? target.port : (DEFAULT_PORTS[protocol] ?? DEFAULT_PORTS[target.protocol] ?? '')
  return `${protocol}//${canonicalHost(target.host)}:${port}/${target.database}`
}

/**
 * 两个连接串是否指向**同一个**数据库目标。
 *
 * 两侧任一侧解析不了 ⇒ 返回 `true`（**失败关闭**：证明不了"不是同一个"就按"是"处理）。
 */
export function isSameDatabaseTarget(a: string, b: string): boolean {
  const ta = parseDatabaseTarget(a)
  const tb = parseDatabaseTarget(b)
  if (ta === undefined || tb === undefined) return true
  return databaseTargetKey(ta) === databaseTargetKey(tb)
}

// ---------------------------------------------------------------------------
// 启动期放行（把 problems 变成具名拒绝）
// ---------------------------------------------------------------------------

/** 后端配置/身份类失败的**具名**码（与 ADR-132 `D02` 一一对应） */
export type DatabaseStartupDenial =
  | DatabaseBackendProblem
  /** 已连上，但实际 database/user 与期望不符 */
  | 'db_identity_mismatch'
  /** 连不上 / 池建不起来 */
  | 'db_connect_failed'

/** 隔离路径的**具名**拒绝（另起一组：它不是"配置错"，而是"隔离没做到"） */
export type DatabaseIsolationDenial =
  /** postgres 后端下走了"只应给 PGlite 用"的目录隔离路径 */
  | 'postgres_isolation_not_provided'
  /** 隔离目标与生产目标解析为同一个（比对失败 ⇒ 拒绝） */
  | 'postgres_isolation_targets_production'
  /** 隔离目标缺少测试库命名（无法证明它不是生产库） */
  | 'postgres_isolation_target_unnamed'

/**
 * 开库前的**纯函数**判据。
 *
 * 刻意抽成纯函数不是为了好看，而是因为这是**唯一能把它测全**的办法：
 * 真环境里不可能为了测一条闸去构造一个错的 PG 目标。
 *
 * 形状 `(解析结果, 隔离信息) → 该不该拒、为什么` —— 于是每个分支都能直接断言。
 * ⚠️ 它**不读环境**：生产目标由调用方以参数给出（`productionTarget`）。
 *    纯函数里偷偷读 `process.env` 会让"负控"变成测不准的东西。
 */
export function databaseStartupDecision(input: {
  resolution: DatabaseBackendResolution
  /** 是否已 `isolateDatabase()` 到沙箱 */
  isolated: boolean
  /** 生产 PG 目标（`LG_PRODUCTION_POSTGRES_URL`）；未配置则 undefined */
  productionTarget?: string | undefined
  /** 测试库命名前缀（`LG_TEST_DATABASE_PREFIX`）；未配置则用缺省 */
  testDatabasePrefix?: string | undefined
}): { allowed: boolean; denial?: DatabaseStartupDenial | DatabaseIsolationDenial } {
  const { resolution } = input
  if (resolution.problems.length > 0) {
    return { allowed: false, denial: resolution.problems[0] }
  }
  // PGlite 侧的目录闸不在这里判（由既有的 productionOpenDecision 负责，语义不变）
  if (resolution.backend !== 'postgres') return { allowed: true }

  const url = resolution.postgresUrl
  if (url === undefined) return { allowed: false, denial: 'postgres_url_missing' }
  return { allowed: true }
}

/**
 * 隔离实验的 PG 目标判据（**纯函数**）。
 *
 * 三条，全部失败关闭；任一条过不去都**不**允许开库：
 *   ① 给出了目标（没给 ⇒ `postgres_isolation_not_provided`）
 *   ② 解析得出目标三元组（解析不了 ⇒ 同上，因为"证明不了它不是生产库"）
 *   ③ 目标 ≠ 生产目标 **且** database 名带测试前缀
 */
export function postgresIsolationDecision(input: {
  postgresUrl: string | undefined
  productionTarget?: string | undefined
  testDatabasePrefix?: string | undefined
  /**
   * "两个连接串是不是同一个目标"的判据。**注入点**：
   * 门要把"比较器失效"这件事真的做出来（换成恒 false 的假实现），
   * 否则"我们比过了"这句话没有任何东西支撑。
   */
  compareTargets?: (a: string, b: string) => boolean
}): { allowed: boolean; denial?: DatabaseIsolationDenial } {
  const compare = input.compareTargets ?? isSameDatabaseTarget
  const url = input.postgresUrl
  if (url === undefined || url.trim() === '') {
    return { allowed: false, denial: 'postgres_isolation_not_provided' }
  }
  const target = parseDatabaseTarget(url)
  if (target === undefined) {
    // 解析不了就证明不了"它不是生产库" ⇒ 拒绝（不"先跑跑看"）
    return { allowed: false, denial: 'postgres_isolation_not_provided' }
  }
  // ⚠️ 顺序要紧：**先**比"是不是生产目标"，**再**看测试前缀。
  //    反过来的话，一个指向生产库、又恰好没带测试前缀的目标会被报成
  //    `target_unnamed`（"名字不对"）而不是 `targets_production`（"这就是生产库"）——
  //    两者都拒绝，但后者才是运维真正需要看到的那句话。
  const production = input.productionTarget
  if (production !== undefined && production.trim() !== '' && compare(url, production)) {
    return { allowed: false, denial: 'postgres_isolation_targets_production' }
  }
  const prefix = input.testDatabasePrefix ?? DEFAULT_TEST_DATABASE_PREFIX
  if (!target.database.startsWith(prefix)) {
    return { allowed: false, denial: 'postgres_isolation_target_unnamed' }
  }
  return { allowed: true }
}

/** 隔离测试库的缺省命名前缀（`ADR-132 D03`；可被 `LG_TEST_DATABASE_PREFIX` 覆盖） */
export const DEFAULT_TEST_DATABASE_PREFIX = 'lg_test_'

// ---------------------------------------------------------------------------
// "同进程第二个 PostgreSQL 目标"的守卫（`PG-G01` 的 G01.7）
// ---------------------------------------------------------------------------

/** 同进程换目标被拒的具名原因 */
export type SecondTargetDenial = 'second_postgres_target_in_process'

/**
 * 同进程**只允许一个** PostgreSQL 目标。
 *
 * ============================================================================
 *  为什么必须拒绝（插件的一个实测形状）
 * ============================================================================
 *  `@elizaos/plugin-sql@1.7.2` 的连接池全局键是：
 *
 * ```text
 *   fullManagerKey = `${managerKey}:${useNeonDriver ? 'neon' : 'pg'}`
 *   managerKey 缺省 = 'default'
 *   ⇒ **键里没有连接地址**
 * ```
 *
 *  ⇒ 同一个进程里先打开目标 A、再打开目标 B，`createDatabaseAdapter()` 会**复用 A 的池**
 *    ⇒ 所有对 B 的查询**实际落在 A 上**，而调用方从配置上"以为"自己连的是 B。
 *
 *  这不是理论风险：计划 §3.2 逐字点名了它，并给出首期裁定 ——
 *  **"首期隔离库采用独立进程，显式关闭池；同进程多目标路径必须拒绝或有已验证的隔离实现"**。
 *
 *  ⇒ 本函数实现"**拒绝**"那一支：同一个目标重复打开是幂等的（允许），
 *    换一个目标就**具名拒绝**（不"先跑跑看"）。
 *
 *  ⚠️ 刻意**不**做"清掉缓存再连"：那正是计划 §3.2 禁止的
 *     "直接清空缓存掩盖悬空连接" —— 旧池里的连接仍然活着。
 *
 *  判据用**规范化后的目标三元组**（`databaseTargetKey`），不按字符串比 ——
 *  否则 `localhost` / `127.0.0.1` 这种"同一目标的两种写法"会被误判成"换目标"。
 */
export function postgresTargetGuard(input: {
  /** 上一次**成功打开**的目标 URL（从未打开过则 undefined） */
  alreadyOpened: string | undefined
  /** 本次请求的目标 URL */
  requested: string
}): { allowed: boolean; denial?: SecondTargetDenial; targetKey: string | undefined } {
  const requestedTarget = parseDatabaseTarget(input.requested)
  if (requestedTarget === undefined) {
    // 解析不了 ⇒ 证明不了"它与已打开的那个是同一个" ⇒ 失败关闭
    return { allowed: false, denial: 'second_postgres_target_in_process', targetKey: undefined }
  }
  const requestedKey = databaseTargetKey(requestedTarget)

  if (input.alreadyOpened === undefined) {
    return { allowed: true, targetKey: requestedKey }
  }
  const openedTarget = parseDatabaseTarget(input.alreadyOpened)
  if (openedTarget === undefined) {
    return { allowed: false, denial: 'second_postgres_target_in_process', targetKey: requestedKey }
  }
  if (databaseTargetKey(openedTarget) !== requestedKey) {
    return { allowed: false, denial: 'second_postgres_target_in_process', targetKey: requestedKey }
  }
  return { allowed: true, targetKey: requestedKey }
}

// ---------------------------------------------------------------------------
// 开库放行的**合并判据**（后端配置 ⊕ PGlite 目录闸）
// ---------------------------------------------------------------------------

/**
 * PGlite 目录闸的结论（由 `src/db/index.ts` 的既有纯函数给出，这里只做形状约定）。
 *
 * ⚠️ 本模块**不**实现它 —— 它的实现留在 `src/db/index.ts`（`productionOpenDecision`），
 * 因为那条闸的语义（租约、pre-open token）属 INC-01 的既有裁量，一个字都不许改。
 * 这里只约定"它输出什么形状"，好把两条判据并起来。
 */
export type PgliteDirectoryDenial = 'missing_production_allowance' | 'missing_preopen_token'

export interface DatabaseAccessDecision {
  allowed: boolean
  /** PGlite 目录闸的拒绝（语义逐字沿用 INC-01） */
  denial?: PgliteDirectoryDenial
  /** 后端配置的拒绝（WP1 新增） */
  backendDenial?: DatabaseBackendProblem
}

/**
 * 把**两类**判据并起来，且各自保留具名拒绝：
 *
 * ```text
 *   ① 后端配置（CHARACTER_DB_BACKEND / POSTGRES_URL）   → backendDenial
 *   ② PGlite 目录闸（放行旗标 + pre-open token）        → denial（语义逐字不变）
 * ```
 *
 * 顺序是刻意的：**错配置优先**。它必须在碰任何库之前拒绝 ——
 * 否则就会出现"先按错配置连上去、再回头说配置不对"。
 *
 * ⚠️ **不设** `CHARACTER_DB_BACKEND` 时 `resolution.problems` 为空、`backend='pglite'`
 *    ⇒ 本函数**逐字**退化成原 `productionOpenDecision` 的那条分支。
 */
export function databaseAccessDecision(input: {
  resolution: DatabaseBackendResolution
  /** PGlite 目录闸的结论（由调用方用 `productionOpenDecision` 算出） */
  pgliteDecision: { allowed: boolean; denial?: PgliteDirectoryDenial }
}): DatabaseAccessDecision {
  // ① 后端配置问题优先：错配置必须在碰任何库之前就拒绝
  if (input.resolution.problems.length > 0) {
    return { allowed: false, backendDenial: input.resolution.problems[0] }
  }
  // ② 选定了 postgres ⇒ PGlite 目录闸**不适用**
  //    （它守的是"数据目录"，而 PostgreSQL 的数据在服务端，应用这边没有目录可守）。
  //    后端身份核对在连接之后、迁移之前做（见 `src/db/index.ts`）。
  if (input.resolution.backend === 'postgres') return { allowed: true }
  // ③ PGlite：原判据的结论原样透传
  return input.pgliteDecision.allowed
    ? { allowed: true }
    : { allowed: false, ...(input.pgliteDecision.denial !== undefined ? { denial: input.pgliteDecision.denial } : {}) }
}

/** 把拒绝原因翻成**人读**的两段文案（先讲怎么改对，再给事实） */
export function databaseStartupDenialMessage(
  denial: DatabaseStartupDenial | DatabaseIsolationDenial | SecondTargetDenial,
  detail: { resolution: DatabaseBackendResolution; redactedTarget?: string }
): string {
  const target = detail.redactedTarget ?? '(未配置)'
  switch (denial) {
    case 'second_postgres_target_in_process':
      return (
        '拒绝：本进程**已经打开过另一个** PostgreSQL 目标，不能再换一个。\n' +
        `  本次请求：${target}\n` +
        '\n' +
        '为什么必须拒绝（不是保守，是插件的一个实测形状）：\n' +
        '  plugin-sql 的连接池全局键是 `default:pg` —— **里面没有连接地址**。\n' +
        '  同进程换目标会**复用旧池** ⇒ 对 B 的查询实际落在 A 上，而你以为连的是 B。\n' +
        '\n' +
        '计划 §3.2 的首期裁定是"隔离库用**独立进程**，显式关闭池"。\n' +
        '⇒ 要换目标，请**另起一个进程**。（刻意不做"清掉缓存再连"：那会掩盖悬空连接。）'
      )
    case 'postgres_url_missing':
      return (
        '数据库后端已显式选为 postgres，但没有连接串。\n' +
        '\n' +
        'CHARACTER_DB_BACKEND=postgres 需要 POSTGRES_URL 一起给出。\n' +
        '（本次没有改动任何数据；**不会**回落到 PGlite —— 静默回落会让"以为切了"变成事实。）'
      )
    case 'backend_unknown':
      return (
        `CHARACTER_DB_BACKEND 的值不在闭集里：${JSON.stringify(detail.resolution.requested)}\n` +
        '只接受 pglite 或 postgres。刻意不做拼写纠正：\n' +
        '把 postgresl / pg 猜成 postgres，等于让一个笔误决定生产后端。'
      )
    case 'postgres_url_without_backend':
      return (
        '检测到 PostgreSQL 连接串，但 CHARACTER_DB_BACKEND 没有显式选 postgres。\n' +
        '\n' +
        '这是刻意的失败关闭：仅"环境里有 URL"不足以换后端（继承到该变量的子进程会跟着换）。\n' +
        '要么显式写 CHARACTER_DB_BACKEND=postgres，要么把连接串去掉。'
      )
    case 'postgres_url_invalid':
      return `POSTGRES_URL 不是合法的 PostgreSQL 连接串（目标：${target}）`
    case 'postgres_isolation_targets_production':
      return (
        '拒绝：本次已声明为隔离实验，但解析后的 PostgreSQL 目标等于生产目标。\n' +
        `  隔离目标：${target}\n` +
        '隔离实验不得连生产库。请把 POSTGRES_URL 指向测试库（命名规则见 ADR-132 D03）。'
      )
    case 'postgres_isolation_target_unnamed':
      return (
        '拒绝：隔离实验的 PostgreSQL 目标无法证明它不是生产库（database 名不带测试前缀）。\n' +
        `  隔离目标：${target}\n` +
        `测试库命名必须以 ${DEFAULT_TEST_DATABASE_PREFIX} 开头（可用 LG_TEST_DATABASE_PREFIX 覆盖）。`
      )
    case 'postgres_isolation_not_provided':
      return (
        '拒绝：后端是 postgres，但本次实验没有给出**测试目标**。\n' +
        '\n' +
        '`isolateDatabase()` 只能隔离 PGlite 的数据目录；对 PostgreSQL 它做不到隔离，\n' +
        '因此默认失败关闭（而不是"继续跑，反正看起来像隔离了"）。\n' +
        '要做 PG 实验，请显式给出测试库目标。'
      )
    case 'db_identity_mismatch':
      return (
        '拒绝：连上的数据库身份与期望不符。\n' +
        `  实际目标：${target}\n` +
        '身份核对发生在插件迁移、建档和任何业务写入**之前**。'
      )
    case 'db_connect_failed':
      return `拒绝：PostgreSQL 连接失败（目标：${target}）`
  }
}

// ---------------------------------------------------------------------------
// 连接后的身份核对
// ---------------------------------------------------------------------------

/** 一行读回的**实际**身份（全部来自 SQL，不来自配置） */
export interface DatabaseIdentityReading {
  /** `select current_database()` */
  database: string | undefined
  /** `select current_user` */
  user: string | undefined
  /** `select inet_server_addr()::text`；服务端可空（本地 socket） */
  serverAddr: string | undefined
  /** `select inet_server_port()::int` */
  serverPort: number | undefined
  /** `select version()` */
  serverVersion: string | undefined
}

/** 期望的身份。**未给的项不参与核对**（只核对该给的）。 */
export interface DatabaseIdentityExpectation {
  database?: string
  /** 允许的用户名集合；单值也写成数组 */
  users?: string[]
  /** 额外的部署身份标记（如 `lg_test` 前缀），逐项在 `database`/`user` 上匹配 */
  deploymentIdentity?: { databasePrefix?: string; userPrefix?: string }
}

export interface DatabaseIdentityVerdict {
  ok: boolean
  /** 具名的不符项（空数组 = 全部相符） */
  mismatches: string[]
  reading: DatabaseIdentityReading
}

/**
 * 纯函数版本：给一行读数与期望，判相符与否。
 *
 * `expectation` 里**没给**的维度不判 —— 否则会退化成"猜一个默认值再拿它当判据"。
 * 但**没有任何一项期望**时判 `ok=false`：身份核对必须有东西可核。
 */
export function verifyDatabaseIdentityReading(
  reading: DatabaseIdentityReading,
  expectation: DatabaseIdentityExpectation
): DatabaseIdentityVerdict {
  const mismatches: string[] = []

  if (expectation.database !== undefined && reading.database !== expectation.database) {
    mismatches.push(`database: 期望 ${expectation.database}，实际 ${reading.database ?? '(读不到)'}`)
  }
  if (expectation.users !== undefined && expectation.users.length > 0) {
    if (reading.user === undefined || !expectation.users.includes(reading.user)) {
      mismatches.push(`user: 期望 ${expectation.users.join('|')}，实际 ${reading.user ?? '(读不到)'}`)
    }
  }
  const prefix = expectation.deploymentIdentity
  if (prefix?.databasePrefix !== undefined) {
    if (reading.database === undefined || !reading.database.startsWith(prefix.databasePrefix)) {
      mismatches.push(
        `database 前缀: 期望以 ${prefix.databasePrefix} 开头，实际 ${reading.database ?? '(读不到)'}`
      )
    }
  }
  if (prefix?.userPrefix !== undefined) {
    if (reading.user === undefined || !reading.user.startsWith(prefix.userPrefix)) {
      mismatches.push(`user 前缀: 期望以 ${prefix.userPrefix} 开头，实际 ${reading.user ?? '(读不到)'}`)
    }
  }

  const anyExpectation =
    expectation.database !== undefined ||
    (expectation.users !== undefined && expectation.users.length > 0) ||
    prefix?.databasePrefix !== undefined ||
    prefix?.userPrefix !== undefined

  return { ok: anyExpectation && mismatches.length === 0, mismatches, reading }
}

/** 期望身份从环境里取的形状（连接后核对用） */
export function databaseIdentityExpectationFrom(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): DatabaseIdentityExpectation {
  const trimmed = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined
    const t = v.trim()
    return t === '' ? undefined : t
  }
  const database = trimmed(env.LG_PG_EXPECT_DATABASE)
  const databasePrefix = trimmed(env.LG_PG_EXPECT_DATABASE_PREFIX)
  const userPrefix = trimmed(env.LG_PG_EXPECT_USER_PREFIX)
  const users = ((): string[] | undefined => {
    const raw = trimmed(env.LG_PG_EXPECT_USER)
    if (raw === undefined) return undefined
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    return list.length === 0 ? undefined : list
  })()

  // 部署身份：两个前缀各自独立可选；两个都没有时**不**造一个空对象
  const deploymentIdentity: { databasePrefix?: string; userPrefix?: string } = {}
  if (databasePrefix !== undefined) deploymentIdentity.databasePrefix = databasePrefix
  if (userPrefix !== undefined) deploymentIdentity.userPrefix = userPrefix
  const hasDeploymentIdentity =
    deploymentIdentity.databasePrefix !== undefined || deploymentIdentity.userPrefix !== undefined

  const expectation: DatabaseIdentityExpectation = {}
  if (database !== undefined) expectation.database = database
  if (users !== undefined) expectation.users = users
  if (hasDeploymentIdentity) expectation.deploymentIdentity = deploymentIdentity
  return expectation
}

/** 身份核对失败时抛的 KernelError（`persistence_error` 家族，具名 code） */
export function databaseIdentityError(verdict: DatabaseIdentityVerdict): KernelError {
  return new KernelError(
    'persistence_error',
    'db_identity_mismatch',
    '拒绝：连上的数据库身份与期望不符（在任何迁移与业务写入之前）：\n' +
      verdict.mismatches.map((m) => `  · ${m}`).join('\n') +
      '\n\n（本次没有改动任何数据。）',
    { mismatches: verdict.mismatches, reading: verdict.reading }
  )
}
