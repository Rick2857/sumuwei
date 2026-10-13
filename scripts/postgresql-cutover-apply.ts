/**
 * PostgreSQL 迁移 **WP7：最终生产迁移（受控程序）**。
 *
 * ============================================================================
 *  授权
 * ============================================================================
 *  用户 2026-10-13：「**允许最终生产迁移**」。
 *  ⚠️ 本程序仍然要求显式 `--apply`（与 token 环境变量），理由与 `db:restore` / `coexist:start`
 *     同一条纪律：**授权是一次决定，"手滑执行"是另一件事**，两者要用不同的闸。
 *
 * ============================================================================
 *  两相（**分开跑，每相各自可验证、可回滚**）
 * ============================================================================
 * ```text
 *   相 A（默认）：只写 **PG 目标**，**不碰任何配置**、不碰真实库
 *     ① 前置：没有 LG 核心在跑 · 没有 NapCat · PG 健康 · 真实库上次干净关闭
 *     ② **最终来源的合格性**：把 WP0/ⓓ 之后那份 verified snapshot 的 manifest 摘要
 *        与**当前真实库**的树摘要**逐字比对** ⇒ 证明"这份快照仍然是当前真实库的忠实副本"
 *        （⚠️ 比"再取一份快照"更强：再取快照可能触发**剪枝**，而剪枝需要单独授权）
 *     ③ 建**生产库** `lg_prod`（owner=迁移账号 + 角色授权；走仓库已验证的 create-test-db.sql）
 *     ④ 导出快照 → **stdin** 灌进 lg_prod（排除集：--no-owner --no-privileges --no-comments）
 *     ⑤ **读回**：54 张表逐表规范化内容摘要，源快照 vs lg_prod ⇒ 必须逐表一致
 *
 *   相 B（`--switch-config`）：改配置 + 起一次核心验证
 *     ⑥ 在 `.env` **追加** PG 后端配置（**保留** PGlite 行 ⇒ 回滚 = 删掉追加的那几行）
 *     ⑦ 起一次真核心连 lg_prod ⇒ 断言身份核对通过、读得到真实数据；然后**关掉**
 *     ⑧ 记录 Activation-Record（含每步退出码、真实库指纹前后、以及**回滚指令原文**）
 * ```
 *
 *  ⚠️ 真实库（`data/pglite`）在**两相里都只被读**（相 A 只读快照；相 B 根本不碰它）。
 *     程序前后都取真实库目录指纹，并要求**逐字相同**。
 *
 * 跑法：
 *   pnpm postgresql:cutover:apply                      # 干跑（只打印计划）
 *   PROJECT_LG_PG_CUTOVER='allow-final-cutover' pnpm postgresql:cutover:apply --apply            # 相 A
 *   PROJECT_LG_PG_CUTOVER='allow-final-cutover' pnpm postgresql:cutover:apply --apply --switch-config  # 相 A + B
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { psql, psqlFile, psqlFromStdin } from './postgresql/pg-exec.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR } from './postgresql/pglite-dump.ts'
import { productionDirFingerprint, PRODUCTION_DB_DIR } from './postgresql/production-fingerprint.ts'
import { digestTree, ownerRecordPath, readOwnerRecord } from '../src/infrastructure/persistence/production-db-safety.ts'
import { readTargetCatalog, readTargetTableRows } from './postgresql/pg-target-reader.ts'
import { compareTableDigests, tableDigest } from './postgresql/row-digest.ts'
import { openPgliteSnapshot } from './postgresql/pglite-reader.ts'

const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const MIGRATE_USER = 'lg_migrate'
const MIGRATE_ROLE = 'lg_migrate'
/** **生产库名**（用户 2026-10-13 裁定：与 GitHub 公开仓库 `Rick2857/sumuwei` 的项目名一致） */
const PROD_DB = process.env.LG_PROD_DB_NAME ?? 'sumuwei'
const SOURCE_SNAPSHOT = resolve(
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'
)
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--no-comments']
const AUTHORIZATION = 'allow-final-cutover'

const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const RESTORE_SQL = resolve(LOCAL_DIR, 'cutover-restore.sql')
const ENV_PATH = resolve('.env')
const ENV_BACKUP = resolve(LOCAL_DIR, `env-before-cutover-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`)

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const OUT_DIR = resolve(`artifacts/post-lv2/postgresql-migration/pg-migration-cutover-${stamp}`)

const steps: { step: string; rc: number; note?: string }[] = []
const checks: { name: string; pass: boolean; detail?: string }[] = []
const observations: Record<string, unknown> = {}

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

const APPLY = process.argv.includes('--apply')
const SWITCH = process.argv.includes('--switch-config')
const token = process.env.PROJECT_LG_PG_CUTOVER ?? ''

if (!APPLY || token !== AUTHORIZATION) {
  console.log('干跑（缺 --apply 或授权 token）—— **不会动任何东西**')
  console.log(`  授权 token : 需要 PROJECT_LG_PG_CUTOVER='${AUTHORIZATION}'（当前：${token === '' ? '(未设)' : token}）`)
  console.log(`  生产库     : ${PROD_DB}（宿主 ${HOST_PORT}）`)
  console.log(`  最终来源   : ${SOURCE_SNAPSHOT}`)
  console.log(`  相         : A${SWITCH ? ' + B（--switch-config）' : '（只做 A）'}`)
  console.log('')
  console.log('相 A 做：前置检查 → 快照合格性（manifest vs 当前真实库树摘要）→ 建 lg_prod →')
  console.log('        导出+灌库 → 读回 54 表逐表摘要比较。**不碰配置、不碰真实库。**')
  console.log('相 B 另加：`.env` 追加 PG 配置（保留 PGlite 行）→ 起一次核心验证 → Activation-Record。')
  process.exit(2)
}

const credentials = loadPgCredentials()
if (credentials === undefined) {
  console.error(`拒绝：凭据文件不存在 ${PG_CREDENTIALS_FILE}`)
  process.exit(2)
}
const missingKeys = missingCredentialKeys(credentials)
if (missingKeys.length > 0) {
  console.error(`拒绝：凭据文件缺 key：${missingKeys.join(', ')}`)
  process.exit(2)
}

const password = credentials.LG_PG_MIGRATE_PASSWORD
const bootstrapUser = credentials.LG_PG_BOOTSTRAP_USER
const bootstrapPassword = credentials.LG_PG_BOOTSTRAP_PASSWORD
const bootstrapDb = credentials.LG_PG_BOOTSTRAP_DB

const manageDb = (
  script: 'create-test-db.sql' | 'drop-test-db.sql' | 'create-production-db.sql',
  dbName: string
): ReturnType<typeof psqlFile> => {
  const r = psqlFile({
    container: CONTAINER,
    user: bootstrapUser,
    password: bootstrapPassword,
    database: bootstrapDb,
    file: `/opt/lg/${script}`,
    variables: { LG_TEST_DB_NAME: dbName, LG_PROD_DB_NAME: dbName, LG_PG_MIGRATE_USER: MIGRATE_ROLE },
  })
  steps.push({ step: `${script} ${dbName}`, rc: r.rc, note: r.err.slice(0, 300) })
  return r
}

/**
 * ⚠️ **硬中断**（`F-WP5-21` 的修法）：前置失败**必须立刻停**。
 *
 * 第一版用 `check()` 只"记录"失败 ⇒ 建库失败之后程序**带着坏前置继续跑**，
 * 到读回那一步才未捕获地抛出 —— 那正是 `F-WP5-14`（一个场景抛错吃掉后面的读数）的同型。
 * ⇒ 受控的生产程序里，**"记下来"不等于"停下来"**。
 */
function must(ok: boolean, what: string, detail: string): void {
  if (!ok) {
    console.error(`\n[硬中断] ${what}\n  ${detail}`)
    console.error('\n⚠️ 程序在此停止；**没有**继续往后做（这正是要的行为）。')
    process.exit(3)
  }
}
const queryOf = (db: string, sqlText: string): string | undefined => {
  const r = psql({ container: CONTAINER, user: MIGRATE_USER, password, database: db, sql: sqlText, timeoutMs: 900_000 })
  return r.rc === 0 ? r.out : undefined
}

async function main(): Promise<void> {
  mkdirSync(LOCAL_DIR, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const productionBefore = productionDirFingerprint()

  // ---------------------------------------------------------------------
  // ① 前置（只读）
  // ---------------------------------------------------------------------
  const coreProcs = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src/main.ts|src\\\\\\\\main' } | Measure-Object).Count"],
    { encoding: 'utf8', timeout: 60_000 }
  )
  const coreCount = Number((coreProcs.stdout ?? '0').trim() || '0')
  const napcat = spawnSync('docker', ['ps', '--filter', 'name=napcat', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 30_000 })
  const pgUp = spawnSync('docker', ['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Status}}'], { encoding: 'utf8', timeout: 30_000 })
  const ownerRecordRaw = ((): string => {
    /*
     * ⚠️ 用仓库的**唯一实现**（`ownerRecordPath` + `readOwnerRecord`），不要自己扫目录按名字排。
     *    第一版就是自己扫的 ⇒ 按名字排序取到的是**任意一份**记录（owner record 的文件名是
     *    dataDir 的哈希，一个目录一份；但目录下还躺着别的 dataDir 的记录）
     *    ⇒ 把"上一次干净关闭"读成了 false（`F-WP5-22`）。
     */
    try {
      const record = readOwnerRecord(ownerRecordPath(PRODUCTION_DB_DIR))
      return record === undefined ? '' : JSON.stringify(record)
    } catch {
      return ''
    }
  })()
  observations.preflight = {
    lgCoreProcesses: coreCount,
    napcat: (napcat.stdout ?? '').trim(),
    pgStatus: (pgUp.stdout ?? '').trim(),
    ownerRecordCleanClose: /"cleanClose"\s*:\s*true/.test(ownerRecordRaw),
  }

  check('CUT.1 前置：没有 LG 核心在跑（真实库无持有者）', () => {
    if (coreCount !== 0) throw new Error(`检测到 ${coreCount} 个 LG 核心进程 ⇒ 先排空旧核心`)
  })
  check('CUT.2 前置：没有 NapCat 容器（生产 QQ 外壳不在跑）', () => {
    if ((napcat.stdout ?? '').trim() !== '') throw new Error(`NapCat 在跑：${(napcat.stdout ?? '').trim()}`)
  })
  check('CUT.3 前置：PG 目标健康', () => {
    if (!/healthy/.test(pgUp.stdout ?? '')) throw new Error(`PG 容器状态：${(pgUp.stdout ?? '').trim() || '(不在跑)'}`)
  })
  check('CUT.4 前置：真实库上一次是**干净关闭**的（owner record cleanClose=true）', () => {
    if (!/cleanClose"\s*:\s*true/.test(ownerRecordRaw)) throw new Error('owner record 里 cleanClose 不是 true')
  })
  check('CUT.5 前置：最终来源快照存在且有 manifest', () => {
    if (!existsSync(resolve(SOURCE_SNAPSHOT, 'PG_VERSION'))) throw new Error(`快照目录不存在：${SOURCE_SNAPSHOT}`)
    if (!existsSync(`${SOURCE_SNAPSHOT}.manifest.json`)) throw new Error('manifest 不存在')
  })

  // ---------------------------------------------------------------------
  // ② 最终来源的合格性：manifest 摘要 vs **当前真实库**树摘要（逐字）
  // ---------------------------------------------------------------------
  const manifest = JSON.parse(readFileSync(`${SOURCE_SNAPSHOT}.manifest.json`, 'utf8')) as {
    snapshotId?: string
    nonVolatileTreeSha256?: string
    fileCount?: number
    totalBytes?: number
    excludedPaths?: string[]
  }
  /*
   * ⚠️ 用仓库的 **INC-01 树摘要**（`digestTree(dir, excludedPaths)`）—— 它**排除**
   *    `postmaster.pid` 这类易失文件，正是 manifest 的口径。
   *    第一版拿我自己的 `productionDirFingerprint().files`（**含** `postmaster.pid`）去比
   *    manifest 的 `fileCount` ⇒ 差 1，于是报"快照不再是忠实副本"（`F-WP5-22` 的第二处）。
   *    ⇒ 与 `live-smoke-source.ts` 用同一套判据（那是在生产之外已被证明过的那一套）。
   */
  const excluded = manifest.excludedPaths ?? ['postmaster.pid']
  const tree = digestTree(SOURCE_SNAPSHOT, excluded)
  const live = productionDirFingerprint()
  observations.sourceQualification = {
    manifestSnapshotId: manifest.snapshotId,
    manifestTreeSha256: manifest.nonVolatileTreeSha256,
    manifestFileCount: manifest.fileCount,
    manifestTotalBytes: manifest.totalBytes,
    snapshotTreeSha256: tree.treeSha256,
    snapshotMeasuredCount: tree.measuredCount,
    snapshotTotalBytes: tree.totalBytes,
    liveFilesIncludingVolatile: live.files,
    liveDigest: live.digest,
    excludedPaths: excluded,
  }
  check('CUT.6 ★ 最终来源合格：快照的 INC-01 树摘要/文件数/字节数与 manifest **逐字一致**（来源没被换过）', () => {
    if (manifest.nonVolatileTreeSha256 === undefined) throw new Error('manifest 里没有 nonVolatileTreeSha256')
    if (tree.treeSha256 !== manifest.nonVolatileTreeSha256) {
      throw new Error(`快照树摘要与 manifest 不一致：${tree.treeSha256} ≠ ${manifest.nonVolatileTreeSha256}`)
    }
    if (tree.measuredCount !== manifest.fileCount) {
      throw new Error(`快照文件数 ${tree.measuredCount} ≠ manifest ${String(manifest.fileCount)}`)
    }
    if (tree.totalBytes !== manifest.totalBytes) {
      throw new Error(`快照字节数 ${tree.totalBytes} ≠ manifest ${String(manifest.totalBytes)}`)
    }
  })
  check('CUT.6b ★ 真实库与快照同源：真实库（排除易失文件后）的文件数与快照一致', () => {
    const liveNonVolatile = live.files - excluded.filter((p) => existsSync(resolve(PRODUCTION_DB_DIR, p))).length
    if (liveNonVolatile !== tree.measuredCount) {
      throw new Error(`真实库（排除易失后）${liveNonVolatile} 个文件 ≠ 快照 ${tree.measuredCount} ⇒ 真实库自快照之后变过`)
    }
  })

  // ---------------------------------------------------------------------
  // ③ 建生产库（owner=迁移账号 + 角色授权）
  // ---------------------------------------------------------------------
  const existed = (queryOf('postgres', `select 1 from pg_database where datname = '${PROD_DB}'`) ?? '').trim() === '1'
  observations.prodDbExistedBefore = existed
  if (existed) {
    // 幂等：先删再建（`CREATE DATABASE` 没有 IF NOT EXISTS）
    const dropped = psql({
      container: CONTAINER,
      user: bootstrapUser,
      password: bootstrapPassword,
      database: bootstrapDb,
      sql: `drop database if exists ${PROD_DB} with (force)`,
      timeoutMs: 300_000,
    })
    steps.push({ step: `drop database ${PROD_DB}`, rc: dropped.rc, note: dropped.err.slice(0, 200) })
    must(dropped.rc === 0, '删旧生产库失败', dropped.err.slice(0, 300))
  }
  const created = manageDb('create-production-db.sql', PROD_DB)
  check('CUT.7 建生产库：`' + PROD_DB + '`（owner=lg_migrate + runtime/readonly 授权）', () => {
    if (created.rc !== 0) throw new Error(created.err)
    const present = (queryOf('postgres', `select 1 from pg_database where datname = '${PROD_DB}'`) ?? '').trim()
    if (present !== '1') throw new Error('建完之后查不到这个库')
  })
  // ⚠️ 硬中断：建库没成功就**不许**往下灌
  must(created.rc === 0, '建生产库失败', created.err.slice(0, 400))

  // ---------------------------------------------------------------------
  // ④ 导出最终来源 → 灌进 lg_prod（stdin；源目录只被读）
  // ---------------------------------------------------------------------
  const dump = await dumpPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT, args: RESTORE_ARGS, outFile: RESTORE_SQL })
  const restore = psqlFromStdin({
    container: CONTAINER,
    user: MIGRATE_USER,
    password,
    database: PROD_DB,
    sql: dump.sql,
    timeoutMs: 1_800_000,
  })
  steps.push({ step: `restore → ${PROD_DB}`, rc: restore.rc, note: restore.err.slice(0, 300) })
  observations.export = { bytes: dump.sql.length, args: RESTORE_ARGS }
  check('CUT.8 导入：导出成功且灌库 exit 0、日志里没有 ERROR', () => {
    if (restore.rc !== 0) throw new Error(`灌库退出码 ${restore.rc}：${restore.err.slice(0, 300)}`)
    if (/^ERROR/m.test(restore.err)) throw new Error(`灌库日志里有 ERROR：${restore.err.slice(0, 300)}`)
  })
  // ⚠️ 硬中断：灌库没成功就**不许**往下读回（读回会拿一个半灌的库去比，结论没有意义）
  must(restore.rc === 0, '灌库失败', restore.err.slice(0, 400))
  must(!/^ERROR/m.test(restore.err), '灌库日志里有 ERROR', restore.err.slice(0, 400))

  /*
   * ⓑ（用户 2026-10-13 裁定）：核心以 **`lg_migrate`** 运行 ⇒ **没有**灌库后的授权补丁。
   *    理由与代价见 `create-production-db.sql` 第 4 节（启动期 DDL 级联无有限最小集）。
   *    ⇒ 这里显式记一笔"**刻意不授权**"，免得后人以为是漏了。
   */
  observations.postRestoreGrants = {
    granted: false,
    reason:
      'ⓑ 裁定：核心以 lg_migrate 运行 ⇒ 不削弱 lg_runtime 的边界（保持 WP2 原设计）；' +
      '实测级联：CREATE SCHEMA → CREATE TABLE → SELECT migrations._migrations → create table public.character_schema_migrations',
  }

  // ---------------------------------------------------------------------
  // ⑤ 读回：54 表逐表规范化内容摘要（源快照 vs lg_prod）
  // ---------------------------------------------------------------------
  const session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
  const mismatched: string[] = []
  let tablesCompared = 0
  let rowsTotal = 0
  try {
    const sourceTables = await session.listTables()
    /* ⚠️ 与 `PG-G05` **同一套读取器与同一条编码判据**（`SqlQuery` = `(sql) => string|undefined`） */
    const query = (sqlText: string): string | undefined => queryOf(PROD_DB, sqlText)
    const targetCatalog = readTargetCatalog(query)
    if (targetCatalog === undefined) throw new Error('目标侧列规格读不出来')
    for (const table of sourceTables) {
      const key = `${table.schema}.${table.name}`
      const entry = targetCatalog.get(key)
      if (entry === undefined) {
        mismatched.push(`${key}:目标缺这张表`)
        continue
      }
      const sourceReading = await session.readTable(table.schema, table.name)
      const targetRows = readTargetTableRows(query, table.schema, table.name, entry.columns)
      if (targetRows === undefined) {
        mismatched.push(`${key}:目标行读不出来`)
        continue
      }
      const sourceDigest = tableDigest({
        table: key,
        rows: sourceReading.rows,
        columns: sourceReading.columns,
        primaryKey: sourceReading.primaryKey,
      })
      const targetDigest = tableDigest({
        table: key,
        rows: targetRows,
        columns: sourceReading.columns,
        primaryKey: sourceReading.primaryKey,
      })
      const result = compareTableDigests(sourceDigest, targetDigest)
      if (!result.match) mismatched.push(`${key}:${result.reason ?? '?'}`)
      tablesCompared += 1
      rowsTotal += sourceReading.rows.length
    }
    observations.readback = { tablesCompared, rowsTotal, mismatched: mismatched.slice(0, 10), mismatchCount: mismatched.length }
  } finally {
    observations.sourceAttestation = await session.close()
  }
  check('CUT.9 ★★ 读回：54 张表逐表规范化内容摘要**逐表一致**（导入前后完整性）', () => {
    const r = observations.readback as { tablesCompared: number; mismatchCount: number }
    if (r.tablesCompared < 50) throw new Error(`只比了 ${r.tablesCompared} 张表 ⇒ 判据没量到东西`)
    if (r.mismatchCount > 0) {
      throw new Error(`${r.mismatchCount} 张表不一致：${mismatched.slice(0, 5).join(' / ')}`)
    }
  })

  // ---------------------------------------------------------------------
  // 相 B：改配置 + 起一次核心验证
  // ---------------------------------------------------------------------
  let envLinesAdded: string[] = []
  if (SWITCH) {
    /*
     * ⓑ：核心以 **`lg_migrate`** 运行（十道门全程证明过的配置；启动期 DDL 属迁移职责面）。
     */
    const url = `postgresql://${MIGRATE_USER}:${encodeURIComponent(password)}@127.0.0.1:${HOST_PORT}/${PROD_DB}`
    copyFileSync(ENV_PATH, ENV_BACKUP)
    const before = readFileSync(ENV_PATH, 'utf8')
    envLinesAdded = [
      '# --- PostgreSQL 迁移 WP7（2026-10-13，用户「允许最终生产迁移」）---',
      'CHARACTER_DB_BACKEND=postgres',
      `POSTGRES_URL=${url}`,
      `LG_PG_EXPECT_DATABASE=${PROD_DB}`,
      '# 回滚（R1）：删掉上面这 4 行即可回到 PGlite（PGLITE_* 那两行**一直保留**）',
      '',
    ]
    if (!/CHARACTER_DB_BACKEND=postgres/.test(before)) {
      writeFileSync(ENV_PATH, `${before.replace(/\s*$/, '')}\n\n${envLinesAdded.join('\n')}\n`, 'utf8')
    }
    steps.push({ step: 'env append PG backend', rc: 0, note: `.env 备份：${ENV_BACKUP}` })

    // 起一次核心（只读验证：读得到真实数据即可；不跑对话）
    /*
     * ⚠️ **输出重定向到文件**，不要 `spawnSync` 捕获（`F-WP5-23`）：
     *    捕获时默认 `maxBuffer` 只有 **1 MB**，而核心启动会打大量 Info 日志
     *    ⇒ 子进程**被溢出杀掉**（`status=null`、`stdout` 空），看起来像"核心起不来"。
     *    重定向到文件就没有这个上限，而且日志**落盘**可以事后查。
     */
    const probeLog = resolve(OUT_DIR, 'core-probe.log')
    const probeFd = openSync(probeLog, 'w')
    const probe = spawnSync('pnpm', ['tsx', 'scripts/postgresql-cutover-probe.ts', '--db', PROD_DB], {
      stdio: ['ignore', probeFd, probeFd],
      timeout: 900_000,
      cwd: resolve('.'),
      /*
       * ⚠️ **Windows 上必须 `shell: true`**（`F-WP5-23` 的第二处）：`pnpm` 是 `.cmd`，
       *    不加 shell 时 `spawnSync` 找不到它 ⇒ `ENOENT`、`status=null`、日志空
       *    —— 看起来完全像"核心起不来"，其实是**根本没启动**。
       *    （同一文件里的 `docker` / `powershell` 是 `.exe`，所以它们不需要 shell。）
       */
      shell: true,
    })
    closeSync(probeFd)
    const probeOut = ((): string => {
      try {
        const text = readFileSync(probeLog, 'utf8')
        // 取末尾那段 JSON（探针最后打印的就是它）
        const start = text.lastIndexOf('{\n  "ok"')
        return start >= 0 ? text.slice(start) : text.slice(-2000)
      } catch {
        return '(日志读不出来)'
      }
    })()
    steps.push({ step: 'boot core against ' + PROD_DB, rc: probe.status ?? -1, note: probeLog })
    observations.coreProbe = {
      rc: probe.status ?? -1,
      signal: probe.signal ?? null,
      error: probe.error === undefined ? null : String(probe.error.message ?? probe.error),
      logFile: probeLog,
      tail: probeOut.slice(0, 1500),
    }
    check('CUT.10 ★ 单一后端切换：核心连 ' + PROD_DB + ' 起得来、身份核对通过、读得到真实数据', () => {
      if ((probe.status ?? -1) !== 0) {
        throw new Error(
          `核心探针退出码 ${String(probe.status)}（signal=${String(probe.signal)}）：${probeOut.slice(0, 400)}`
        )
      }
    })
  } else {
    observations.switchSkipped = '未给 --switch-config ⇒ 相 B（改配置+起核心）**没做**（`.env` 一字未动）'
  }

  // ---------------------------------------------------------------------
  // 收尾：真实库指纹必须**逐字未变**
  // ---------------------------------------------------------------------
  const productionAfter = productionDirFingerprint()
  observations.productionDir = { before: productionBefore, after: productionAfter }
  check('CUT.11 ★★ 真实库目录**逐字未动**（两相都只读它）', () => {
    if (productionAfter.files !== productionBefore.files) throw new Error('真实库文件数变了')
    if (productionAfter.digest !== productionBefore.digest) throw new Error('真实库 (路径,大小) 摘要变了')
    if (productionAfter.newestMtimeMs !== productionBefore.newestMtimeMs) throw new Error('真实库有文件被写过')
  })

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const record = {
    program: 'postgresql:cutover:apply',
    phase: SWITCH ? 'A+B（改配置并起核心）' : 'A（只写 PG 目标）',
    authorization: `用户 2026-10-13「允许最终生产迁移」· token=${AUTHORIZATION}`,
    atUtc: new Date().toISOString(),
    atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
    prodDb: PROD_DB,
    sourceSnapshot: SOURCE_SNAPSHOT,
    envBackup: SWITCH ? ENV_BACKUP : null,
    envLinesAdded: SWITCH ? envLinesAdded : null,
    rollback: {
      R1: '删掉 .env 里 WP7 追加的 4 行（CHARACTER_DB_BACKEND / POSTGRES_URL / LG_PG_EXPECT_DATABASE / 注释）⇒ 回到 PGlite',
      R2: `留在 PG：pg_dump sumuwei 备份；需要时灌进新库并把 POSTGRES_URL 指过去`,
      note: '⚠️ 两相都**没有**改写真实库 ⇒ R1 的"回到 PGlite"不需要恢复动作',
    },
    steps,
    checks,
    observations,
    counts: { measured: checks.length, passed, failed },
  }
  writeFileSync(resolve(OUT_DIR, 'cutover-record.json'), JSON.stringify(record, null, 2), 'utf8')
  JSON.parse(readFileSync(resolve(OUT_DIR, 'cutover-record.json'), 'utf8'))

  console.log('')
  console.log(`WP7 最终生产迁移 · 相 ${record.phase}`)
  console.log('─'.repeat(86))
  console.log(`  生产库 : ${PROD_DB}（宿主 ${HOST_PORT}）`)
  console.log(`  来源   : ${SOURCE_SNAPSHOT.replace(`${process.cwd()}\\`, '')}`)
  console.log(`  记录   : ${OUT_DIR.replace(`${process.cwd()}\\`, '')}`)
  console.log('─'.repeat(86))
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
  }
  console.log('─'.repeat(86))
  for (const s of steps) console.log(`  步 ${s.rc === 0 ? 'ok ' : 'rc=' + String(s.rc)}  ${s.step}`)
  console.log('─'.repeat(86))
  console.log(`  读回   : ${JSON.stringify(observations.readback ?? {})}`)
  console.log(`  来源合格性 : ${JSON.stringify(observations.sourceQualification ?? {})}`)
  console.log(`  断言   : ${passed}/${checks.length} · 失败 ${failed}`)
  console.log('')
  if (failed > 0) process.exitCode = 1
}

await main()
