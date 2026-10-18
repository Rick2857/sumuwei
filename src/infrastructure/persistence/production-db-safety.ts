/**
 * INC-01 防复发 —— 真实库安全基础设施。
 *
 * ============================================================================
 *  这个模块存在的理由
 * ============================================================================
 *  2026-09-20 真实库 `data/pglite` 进入不可恢复坏态（见 `docs/incidents/INC-01-*.md`）。
 *  当时有**三个**结构性缺口：
 *
 *    ① 没有任何机制保证"同一真实库同时只有一个进程在打开"；
 *    ② 打开前没有可靠的快照，恢复只能碰运气找 `%TEMP%` 里的热复制残留；
 *    ③ `runtime.stop()` 只停 services，**不关**数据库连接，于是每次退出都留脏状态。
 *
 *  本文件负责 ①②③ 里可复用的纯基础设施（WP1：租约 + owner 取证 + 内容树摘要）。
 *  它**不打开 PGlite**，也不 import 任何数据库依赖 —— 这样它才能在"库已经坏了、
 *  不敢打开"的场景下仍然可用。
 *
 *  ---------------------------------------------------------------------------
 *  纪律（这些是判据，不是注释）
 *  ---------------------------------------------------------------------------
 *  · 摘要算法只有这一份实现（`AT2.1`）：报告、verifier、快照流水线都复用它，
 *    禁止在别处再写一套"近似算法"。
 *  · `measuredCount === 0` ⇒ 抛 `MEASUREMENT INVALID`，**绝不**返回"全部一致"。
 *  · 租约失败一律**失败关闭**：拿不到就是拿不到，不回落到"无锁继续"。
 *  · owner record 是**取证**用的，不是锁；陈旧文件永远不授权打开库。
 *  · owner record **绝不写进 dataDir 内部**（那会改变被保护对象的内容树摘要）。
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 易失运行态文件：内容随每次打开而变，不代表数据内容（排除理由见事故报告附录 C.2） */
export const VOLATILE_EXCLUDED_PATHS: readonly string[] = ['postmaster.pid']

/** 允许的操作类别（冻结枚举；`AT1.3`；M8.5 追加 `affect_semantic_activate`——追加不回写） */
export const OPERATION_KINDS = [
  'chat',
  'read_only_cli',
  'migrate',
  'state_snapshot',
  'real_db_verify',
  'manual_snapshot',
  'restore',
  'affect_semantic_activate',
  /*
   * PostgreSQL 迁移线（2026-10-13）追加：**受控重建目标投影**。
   *
   * 为什么必须**追加一个新类别**而不是复用 `migrate`：这次操作**不是** schema 迁移，
   * 它是对**投影行**的一次有界重写（删行重插，`goal:%` 19 行）。枚举存在的意义就是
   * 让 owner record 里"这次打开干了什么"是**真话**；复用 `migrate` 会让审计面撒谎。
   * ⚠️ 追加不回写（与 M8.5 那次同一条纪律）：既有值一个字节都不动。
   */
  'goal_projection_rebuild',
] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

/** 第二个进程拿不到租约时抛这个（`AT1.2`：不得等待、不得覆盖、不得"试着打开看看"） */
export class ProductionDbInUseError extends Error {
  readonly code = 'production_db_in_use'
  constructor(message: string) {
    super(message)
    this.name = 'ProductionDbInUseError'
  }
}

/** 租约机制本身失败（管道建不起来等）——同样是失败关闭，不回落 */
export class ProductionDbLeaseError extends Error {
  readonly code = 'production_db_lease_failed'
  constructor(message: string) {
    super(message)
    this.name = 'ProductionDbLeaseError'
  }
}

/** 计数量具测到 0 项：结论必须是"量具无效"，不是 PASS */
export class MeasurementInvalidError extends Error {
  readonly code = 'measurement_invalid'
  constructor(message: string) {
    super(message)
    this.name = 'MeasurementInvalidError'
  }
}

// ---------------------------------------------------------------------------
// 内容树摘要（冻结算法，见事故报告附录 C；唯一实现）
// ---------------------------------------------------------------------------

export interface TreeDigest {
  measuredCount: number
  totalBytes: number
  treeSha256: string
  excludedPaths: string[]
}

interface TreeNode {
  rel: string
  size: number
  abs: string
}

/** 递归枚举常规文件（不跟随符号链接内容），相对路径统一 '/' 分隔 */
function walkFiles(root: string): TreeNode[] {
  const out: TreeNode[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(abs)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(root, abs).split(/[\\/]/).join('/')
      out.push({ rel, size: readFileSync(abs).length, abs })
    }
  }
  visit(root)
  return out
}

/**
 * 完整内容树摘要。
 *
 * 算法（冻结）：相对路径按 ordinal 升序 → 每行 `${rel}\t${size}\t${sha256(content)}\n`
 * → 对整段 UTF-8 求 sha256(hex)。详见 `docs/incidents/INC-01-*.md` 附录 C。
 */
export function digestTree(root: string, exclude: readonly string[] = VOLATILE_EXCLUDED_PATHS): TreeDigest {
  if (!existsSync(root)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：目录不存在 ${root}`)
  }
  const all = walkFiles(root)
  const nodes = all.filter((n) => !exclude.includes(n.rel))
  if (nodes.length === 0) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：${root} 未测到任何文件（measured_count = 0）`
    )
  }
  nodes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const lines: string[] = []
  let totalBytes = 0
  for (const node of nodes) {
    const contentHash = createHash('sha256').update(readFileSync(node.abs)).digest('hex')
    lines.push(`${node.rel}\t${node.size}\t${contentHash}\n`)
    totalBytes += node.size
  }
  return {
    measuredCount: nodes.length,
    totalBytes,
    treeSha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'),
    excludedPaths: all.filter((n) => exclude.includes(n.rel)).map((n) => n.rel),
  }
}

// ---------------------------------------------------------------------------
// 跨进程独占租约（Windows named pipe / Linux abstract socket；由 OS 自动释放）
// ---------------------------------------------------------------------------

/** dataDir → 规范形式（resolve + 去尾分隔符 + Windows 下小写，因为路径大小写不敏感） */
export function normalizeDataDir(dataDir: string): string {
  const trimmed = resolve(dataDir).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** 租约管道名：由规范化后的 dataDir 派生 ⇒ 同一目录必然同一个管道 */
export function leasePipeName(dataDir: string): string {
  const hash = createHash('sha256').update(normalizeDataDir(dataDir), 'utf8').digest('hex').slice(0, 32)
  if (process.platform === 'win32') return `\\\\.\\pipe\\project-lg-pglite-${hash}`
  // 不落到文件系统：异常退出不会留下 socket，systemd PrivateTmp 也不会分裂租约。
  if (process.platform === 'linux') return `\0project-lg-pglite-${hash}`
  throw new ProductionDbLeaseError(`production_db_lease_failed：未支持的租约平台 ${process.platform}（失败关闭）`)
}

/**
 * 绑定租约管道。成功 = 本进程持有该 dataDir 的独占权。
 * `EADDRINUSE` ⇒ 已有人持有 ⇒ `ProductionDbInUseError`；其它错误 ⇒ `ProductionDbLeaseError`。
 * **任何失败都不返回 Server**（不回落）。
 */
export async function bindLeasePipe(pipeName: string): Promise<Server> {
  const server = createServer()
  return await new Promise<Server>((resolvePromise, rejectPromise) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (error.code === 'EADDRINUSE') {
        rejectPromise(
          new ProductionDbInUseError(
            `production_db_in_use：${pipeName} 已被另一个进程持有（真实库同一时刻只允许一个访问者）`
          )
        )
        return
      }
      rejectPromise(
        new ProductionDbLeaseError(
          `production_db_lease_failed：无法建立租约管道 ${pipeName}（${error.code ?? 'unknown'}：${error.message}）——失败关闭，不回落`
        )
      )
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolvePromise(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(pipeName)
  })
}

/**
 * 只探测"是否有人持有"：能绑上说明没人持有（立刻释放并返回 false）。
 * 仅用于测试与只读诊断；**不能**用它代替 acquire（探测与获取之间必然有竞态）。
 */
export async function isLeaseHeld(dataDir: string): Promise<boolean> {
  try {
    const server = await bindLeasePipe(leasePipeName(dataDir))
    await new Promise<void>((done) => server.close(() => done()))
    return false
  } catch (error) {
    if (error instanceof ProductionDbInUseError) return true
    throw error
  }
}

// ---------------------------------------------------------------------------
// owner record（取证，不是锁）
// ---------------------------------------------------------------------------

export interface OwnerRecord {
  pid: number
  startedAt: string
  operationKind: OperationKind
  runtimeId: string
  cleanClose?: boolean
  endedAt?: string
}

/** 允许写入的字段白名单；任何额外字段一律拒绝（`AT1.4`：不得把用户正文/argv 写进去） */
const OWNER_FIELDS: readonly string[] = [
  'pid',
  'startedAt',
  'operationKind',
  'runtimeId',
  'cleanClose',
  'endedAt',
]

export function ownerRecordPath(dataDir: string, ownerRecordDir?: string): string {
  const hash = createHash('sha256').update(normalizeDataDir(dataDir), 'utf8').digest('hex').slice(0, 16)
  const dir = resolve(ownerRecordDir ?? join(process.cwd(), 'data', 'owner-records'))
  // 绝不写进 dataDir 内部：那会改变被保护目录的内容树摘要
  if (normalizeDataDir(dir).startsWith(normalizeDataDir(dataDir) + require_sep())) {
    throw new ProductionDbLeaseError(`owner record 目录不得位于 dataDir 内部：${dir}`)
  }
  return join(dir, `production-db-owner-${hash}.json`)
}

function require_sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

export function writeOwnerRecord(path: string, record: OwnerRecord): void {
  for (const key of Object.keys(record)) {
    if (!OWNER_FIELDS.includes(key)) {
      throw new ProductionDbLeaseError(
        `owner record 含不允许的字段 "${key}"（允许：${OWNER_FIELDS.join(' / ')}）`
      )
    }
  }
  if (!OPERATION_KINDS.includes(record.operationKind)) {
    throw new ProductionDbLeaseError(`owner record 的 operationKind 非法：${String(record.operationKind)}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8')
  renameSync(tmp, path) // 原子替换
}

export function readOwnerRecord(path: string): OwnerRecord | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OwnerRecord
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 租约对象
// ---------------------------------------------------------------------------

export interface ProductionLease {
  pipeName: string
  dataDir: string
  ownerRecordPath: string
  runtimeId: string
  /**
   * 上一次持有者**没有干净关闭**留下的记录（若有）。
   *
   * 为什么需要它：owner record 每个 dataDir 只有一个槽位，新的持有者会覆盖它。
   * 若不做保留，"上一个进程是被强杀的"这条诊断事实会在下次启动时**永久消失** ——
   * 而那正是 WP4 `AT4.5` 要求展示的东西。因此 acquire 时把未 clean 的旧记录
   * 改名隔离成 `<record>.unclean-<ts>.json` 并在此暴露。
   */
  previousUncleanExit?: OwnerRecord
  /** 释放租约；`cleanClose` 会写进 owner record（强杀时不会走到这里 ⇒ 留下未 clean 的证据） */
  release(options?: { cleanClose?: boolean; detail?: string }): Promise<void>
}

let runtimeCounter = 0

export function newRuntimeId(): string {
  runtimeCounter += 1
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const random = createHash('sha256')
    .update(`${process.pid}-${Date.now()}-${runtimeCounter}`)
    .digest('hex')
    .slice(0, 6)
  return `runtime_${stamp}_${random}`
}

export interface AcquireLeaseOptions {
  dataDir: string
  operationKind: OperationKind
  runtimeId?: string
  /** 仅测试用：把 owner record 放到别处（生产调用不要传） */
  ownerRecordDir?: string
}

export async function acquireProductionLease(options: AcquireLeaseOptions): Promise<ProductionLease> {
  if (!OPERATION_KINDS.includes(options.operationKind)) {
    throw new ProductionDbLeaseError(`operationKind 非法：${String(options.operationKind)}`)
  }
  const dataDir = resolve(options.dataDir)
  const pipeName = leasePipeName(dataDir)
  const server = await bindLeasePipe(pipeName) // 失败即抛，不回落
  const runtimeId = options.runtimeId ?? newRuntimeId()
  const recordPath = ownerRecordPath(dataDir, options.ownerRecordDir)
  /*
   * 取证保留：上一份记录若**没有干净关闭**，先改名隔离再写新记录。
   * 不做这一步的话，"上一个进程被强杀过"这条事实会被本次 acquire 直接覆盖掉。
   */
  let previousUncleanExit: OwnerRecord | undefined
  const existing = readOwnerRecord(recordPath)
  if (existing !== undefined && existing.cleanClose !== true) {
    previousUncleanExit = existing
    try {
      renameSync(recordPath, `${recordPath}.unclean-${Date.now()}.json`)
    } catch {
      /* 取证尽力而为：失败也不能阻止拿租约 */
    }
  }
  try {
    writeOwnerRecord(recordPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      operationKind: options.operationKind,
      runtimeId,
    })
  } catch (error) {
    // 取证失败不该留下"没人持有"的假象：先释放管道再抛
    await new Promise<void>((done) => server.close(() => done()))
    throw error
  }
  let released = false
  return {
    pipeName,
    dataDir,
    ownerRecordPath: recordPath,
    runtimeId,
    ...(previousUncleanExit !== undefined ? { previousUncleanExit } : {}),
    async release(releaseOptions = {}): Promise<void> {
      if (released) return
      released = true
      const existing = readOwnerRecord(recordPath)
      try {
        writeOwnerRecord(recordPath, {
          ...(existing ?? {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            operationKind: options.operationKind,
            runtimeId,
          }),
          cleanClose: releaseOptions.cleanClose === true,
          endedAt: new Date().toISOString(),
        })
      } catch {
        /* 取证写失败不影响释放；但不能因此假装 clean */
      }
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

/** 清理某个 owner record（测试用；生产不要删，它是历史证据） */
export function removeOwnerRecord(path: string): void {
  rmSync(path, { force: true })
}

// ---------------------------------------------------------------------------
// WP2：已验证快照流水线（复制 → 校验 → 晋升）
// ---------------------------------------------------------------------------

/**
 * 健康探针读数。
 *
 * ⚠️ 为什么"能打开"还不够：PGlite 对一个**空目录**会**新建**一个库（initdb），
 *    于是"打开成功"会把"拿错了一个空目录"判成健康。所以这里要求
 *    `character_schema_migrations` 存在且版本连续 —— 新建的空库没有这张表，必然失败。
 */
export interface HealthProbeResult {
  ok: boolean
  reason?: string
  closed: boolean
  tableCount: number
  schemaVersions: number[]
  readings: string[]
}

export type RawPGlite = {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
  exec: (sql: string) => Promise<unknown>
  close: () => Promise<void>
  closed?: boolean
}

/** 仅供**测试与诊断**：直接打开一个 PGlite 实例（用来造 fixture 库）。生产路径不要用它。 */
export async function openRawPGlite(dir: string): Promise<RawPGlite> {
  const Ctor = await loadPGliteCtor()
  return new Ctor({ dataDir: dir })
}

/**
 * 解析 `@electric-sql/pglite`。
 *
 * ⚠️ 它**不是**本仓库的直接依赖（只在 `.pnpm` 里，被 `@elizaos/plugin-sql` 依赖），
 *    所以不能直接 `import '@electric-sql/pglite'`。这里从 plugin-sql 的安装位置去解析，
 *    **不写死版本号**，也不为此改动 `package.json` / lockfile（计划的 Non-goals 禁止升级依赖）。
 */
async function loadPGliteCtor(): Promise<new (options: { dataDir: string }) => RawPGlite> {
  const resolved = resolvePgliteEntry()
  const mod = (await import(pathToFileURL(resolved).href)) as {
    PGlite?: new (options: { dataDir: string }) => RawPGlite
    default?: { PGlite?: new (options: { dataDir: string }) => RawPGlite }
  }
  const ctor = mod.PGlite ?? mod.default?.PGlite
  if (typeof ctor !== 'function') {
    throw new ProductionDbLeaseError(`health_probe_unavailable：${resolved} 没有导出 PGlite 构造器`)
  }
  return ctor
}

function resolvePgliteEntry(): string {
  const requireFromHere = createRequire(import.meta.url)
  try {
    return requireFromHere.resolve('@electric-sql/pglite')
  } catch {
    /* 未提升到顶层，继续从 plugin-sql 出发 */
  }
  const pluginSqlEntry = requireFromHere.resolve('@elizaos/plugin-sql')
  const requireFromPluginSql = createRequire(pluginSqlEntry)
  return requireFromPluginSql.resolve('@electric-sql/pglite')
}

/** 对**一次性副本**做健康探针；永远不要对"要保留的快照本体"跑它（打开会改 pg_control） */
export async function runHealthProbe(dir: string): Promise<HealthProbeResult> {
  const readings: string[] = []
  const fail = (reason: string, extra: Partial<HealthProbeResult> = {}): HealthProbeResult => ({
    ok: false,
    reason,
    closed: false,
    tableCount: 0,
    schemaVersions: [],
    readings,
    ...extra,
  })
  let db: RawPGlite
  try {
    const Ctor = await loadPGliteCtor()
    db = new Ctor({ dataDir: dir })
  } catch (error) {
    readings.push(`open failed: ${error instanceof Error ? error.message : String(error)}`)
    return fail('health_probe_open_failed')
  }
  let tableCount = 0
  let schemaVersions: number[] = []
  let queryReason: string | undefined
  try {
    await db.query('select 1')
    readings.push('select 1 → ok')
    const tables = await db.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`
    )
    tableCount = Number(tables.rows[0]?.n ?? 0)
    readings.push(`public 表数 = ${tableCount}`)
    if (tableCount <= 0) queryReason = 'health_no_public_tables'
    if (queryReason === undefined) {
      const versions = await db.query('select version from character_schema_migrations order by version')
      schemaVersions = versions.rows.map((row) => Number(row.version))
      readings.push(`character_schema_migrations = [${schemaVersions.join(',')}]`)
      const contiguous =
        schemaVersions.length > 0 && schemaVersions.every((value, index) => value === index + 1)
      if (!contiguous) queryReason = 'health_migration_versions_not_contiguous'
    }
  } catch (error) {
    readings.push(`query failed: ${error instanceof Error ? error.message : String(error)}`)
    queryReason = 'health_probe_query_failed'
  }
  try {
    await db.close()
  } catch (error) {
    readings.push(`close threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  const closed = db.closed === true
  readings.push(`closed = ${closed}`)
  if (queryReason !== undefined) return fail(queryReason, { closed, tableCount, schemaVersions })
  if (!closed) return fail('health_close_not_verified', { closed, tableCount, schemaVersions })
  return { ok: true, closed: true, tableCount, schemaVersions, readings }
}

export interface SnapshotManifest {
  snapshotId: string
  createdAt: string
  sourceDirKind: 'production-data-dir' | 'fixture'
  fileCount: number
  totalBytes: number
  nonVolatileTreeSha256: string
  excludedPaths: string[]
  schemaVersions: number[]
  algorithm: 'inc01-tree-digest-v1'
}

export type SnapshotFailure =
  | 'snapshot_lease_not_held'
  | 'source_overlaps_snapshot_root'
  | 'source_missing'
  | 'measured_count_zero'
  | 'source_changed_during_copy'
  | 'copy_digest_mismatch'
  | 'snapshot_health_failed'

export interface SnapshotResult {
  ok: boolean
  failure?: SnapshotFailure
  detail?: string
  snapshotId?: string
  snapshotPath?: string
  manifestPath?: string
  manifest?: SnapshotManifest
  sourceDigestBefore?: TreeDigest
  sourceDigestAfter?: TreeDigest
  stagingDigest?: TreeDigest
  health?: HealthProbeResult
  prunedSnapshots?: string[]
}

export interface CreateSnapshotOptions {
  sourceDir: string
  snapshotRoot: string
  /** 必须是为**同一个** dataDir 取得的租约（`INC01-D2`：只允许来自静止源） */
  lease: Pick<ProductionLease, 'dataDir' | 'pipeName'>
  /** 保留份数（缺省 3；`INC01-D4`：不足 3 份不得清理） */
  keep?: number
  /** 一次性副本的父目录（缺省系统 %TEMP%） */
  disposableRoot?: string
  /** 测试注入点：健康探针实现 */
  healthProbe?: (dir: string) => Promise<HealthProbeResult>
  /** 测试注入点：复制刚做完、还没校验时触发（用于制造"复制中源被改"/"staging 被改"） */
  afterCopy?: (context: { sourceDir: string; stagingDir: string }) => void | Promise<void>
  now?: () => Date
}

const STAGING_PREFIX = '.staging-'
const SNAPSHOT_PREFIX = 'pglite-'

/** 目标路径必须位于 snapshot root 之内（防逃逸；`INC01-D4`） */
export function assertInsideRoot(root: string, candidate: string): void {
  const normalizedRoot = normalizeDataDir(root)
  const normalizedCandidate = normalizeDataDir(candidate)
  const sep = process.platform === 'win32' ? '\\' : '/'
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(normalizedRoot + sep)) {
    throw new ProductionDbLeaseError(`拒绝操作 snapshot root 之外的路径：${candidate}`)
  }
}

export async function createVerifiedSnapshot(options: CreateSnapshotOptions): Promise<SnapshotResult> {
  const now = options.now ?? ((): Date => new Date())
  const sourceDir = resolve(options.sourceDir)
  const snapshotRoot = resolve(options.snapshotRoot)
  const keep = options.keep ?? 3
  const healthProbe = options.healthProbe ?? runHealthProbe

  // ① 租约校验：必须是同一个 dataDir 的持有者
  if (
    normalizeDataDir(options.lease.dataDir) !== normalizeDataDir(sourceDir) ||
    options.lease.pipeName !== leasePipeName(sourceDir)
  ) {
    return { ok: false, failure: 'snapshot_lease_not_held', detail: '租约与源 dataDir 不一致' }
  }
  if (!existsSync(sourceDir)) return { ok: false, failure: 'source_missing', detail: sourceDir }

  // ② 路径重叠校验：快照根不得在源之内、源也不得在快照根之内
  try {
    assertInsideRootNotOverlapping(snapshotRoot, sourceDir)
  } catch (error) {
    return {
      ok: false,
      failure: 'source_overlaps_snapshot_root',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  // ③ 源静止性：复制前后摘要必须一致
  let sourceDigestBefore: TreeDigest
  try {
    sourceDigestBefore = digestTree(sourceDir)
  } catch (error) {
    return {
      ok: false,
      failure: 'measured_count_zero',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const snapshotId = `${now().toISOString().replace(/[:.]/g, '-')}-${sourceDigestBefore.treeSha256.slice(0, 12)}`
  const staging = join(snapshotRoot, `${STAGING_PREFIX}${snapshotId}`)
  mkdirSync(snapshotRoot, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  cpSync(sourceDir, staging, { recursive: true })

  if (options.afterCopy !== undefined) await options.afterCopy({ sourceDir, stagingDir: staging })

  const sourceDigestAfter = digestTree(sourceDir)
  const stagingDigest = digestTree(staging)
  const cleanup = (): void => rmSync(staging, { recursive: true, force: true })

  if (sourceDigestBefore.treeSha256 !== sourceDigestAfter.treeSha256) {
    cleanup()
    return {
      ok: false,
      failure: 'source_changed_during_copy',
      detail: '复制期间源发生变化：拒绝晋升',
      sourceDigestBefore,
      sourceDigestAfter,
    }
  }
  if (sourceDigestBefore.treeSha256 !== stagingDigest.treeSha256) {
    cleanup()
    return {
      ok: false,
      failure: 'copy_digest_mismatch',
      detail: 'staging 摘要 != 源摘要：拒绝晋升',
      sourceDigestBefore,
      stagingDigest,
    }
  }

  // ④ 健康验证：**只**打开一次性副本
  const disposableRoot = options.disposableRoot ?? tmpdir()
  const disposable = join(disposableRoot, `inc01-snapshot-probe-${snapshotId}`)
  rmSync(disposable, { recursive: true, force: true })
  cpSync(staging, disposable, { recursive: true })
  let health: HealthProbeResult
  try {
    health = await healthProbe(disposable)
  } catch (error) {
    health = {
      ok: false,
      reason: `health_probe_threw: ${error instanceof Error ? error.message : String(error)}`,
      closed: false,
      tableCount: 0,
      schemaVersions: [],
      readings: [],
    }
  } finally {
    rmSync(disposable, { recursive: true, force: true })
  }
  if (!health.ok) {
    cleanup()
    return {
      ok: false,
      failure: 'snapshot_health_failed',
      detail: health.reason ?? 'unknown',
      sourceDigestBefore,
      stagingDigest,
      health,
    }
  }

  // ⑤ 原子晋升（改名），manifest 写在**目录之外**（写进去会改变快照自身摘要）
  const finalPath = join(snapshotRoot, `${SNAPSHOT_PREFIX}${snapshotId}`)
  try {
    assertInsideRoot(snapshotRoot, finalPath)
  } catch (error) {
    cleanup()
    return {
      ok: false,
      failure: 'source_overlaps_snapshot_root',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  renameSync(staging, finalPath)
  const manifest: SnapshotManifest = {
    snapshotId,
    createdAt: now().toISOString(),
    sourceDirKind: isProductionDataDir(sourceDir) ? 'production-data-dir' : 'fixture',
    fileCount: stagingDigest.measuredCount,
    totalBytes: stagingDigest.totalBytes,
    nonVolatileTreeSha256: stagingDigest.treeSha256,
    excludedPaths: stagingDigest.excludedPaths,
    schemaVersions: health.schemaVersions,
    algorithm: 'inc01-tree-digest-v1',
  }
  const manifestPath = join(snapshotRoot, `${SNAPSHOT_PREFIX}${snapshotId}.manifest.json`)
  const tmpManifest = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  renameSync(tmpManifest, manifestPath)

  // ⑥ retention：晋升成功之后才清理，且只清 snapshotRoot 内的 pglite-* 目录
  const pruned = pruneSnapshots(snapshotRoot, keep)

  return {
    ok: true,
    snapshotId,
    snapshotPath: finalPath,
    manifestPath,
    manifest,
    sourceDigestBefore,
    sourceDigestAfter,
    stagingDigest,
    health,
    prunedSnapshots: pruned,
  }
}

/** 判定是不是"真实库目录"（只用于 manifest 标注，不参与任何授权判断） */
function isProductionDataDir(dir: string): boolean {
  return normalizeDataDir(dir) === normalizeDataDir(join(process.cwd(), 'data', 'pglite'))
}

function assertInsideRootNotOverlapping(snapshotRoot: string, sourceDir: string): void {
  const root = normalizeDataDir(snapshotRoot)
  const source = normalizeDataDir(sourceDir)
  const sep = process.platform === 'win32' ? '\\' : '/'
  if (source === root || source.startsWith(root + sep) || root.startsWith(source + sep)) {
    throw new ProductionDbLeaseError(`快照根与源重叠：root=${snapshotRoot} source=${sourceDir}`)
  }
}

/**
 * 保留最近 `keep` 份已验证快照（按目录名排序，名字里含 ISO 时间戳）。
 * 只删除 snapshotRoot 内、以 `pglite-` 开头、且**没有** staging 前缀的目录；
 * 目标必须通过 `assertInsideRoot` 校验；任何一项不满足即拒绝删除（返回已删列表，可能为空）。
 */
export function pruneSnapshots(snapshotRoot: string, keep: number): string[] {
  if (keep < 1) return []
  const root = resolve(snapshotRoot)
  if (!existsSync(root)) return []
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SNAPSHOT_PREFIX))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  const pruned: string[] = []
  for (const name of candidates.slice(keep)) {
    const target = join(root, name)
    try {
      assertInsideRoot(root, target)
    } catch {
      continue // 逃逸目标：拒绝删除（零删除原则）
    }
    try {
      rmSync(target, { recursive: true, force: true })
      pruned.push(name)
    } catch {
      /* 清理失败只告警，不回滚刚晋升的快照 */
    }
  }
  return pruned
}
