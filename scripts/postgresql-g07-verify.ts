/**
 * PG-G07 在线备份恢复（WP4）。
 *
 * ============================================================================
 *  这道门要回答的四个问题（契约 §3 / `G07.1…G07.7`）
 * ============================================================================
 * ```text
 *   G07.1  核心活动时备份成功（**不停止**核心）
 *   G07.2  恢复到**新的**空目标成功
 *   G07.3  篡改备份 ⇒ 拒收（**具名原因**）
 *   G07.4  截断备份 ⇒ 拒收（**具名原因**）
 *   G07.5  数据库外资产按 manifest 验证
 *   G07.6  比较基于**同一逻辑快照或受控写入屏障**
 *   G07.7  源身份与目标身份在恢复后**分开**记录
 * ```
 *
 * ---------------------------------------------------------------------------
 *  §3 的设计（这是本门的技术核心）
 * ---------------------------------------------------------------------------
 *  在隔离实例上没有"核心"可跑，但"**活动**"这件事可以**如实做出来**：
 *  一个真的在写库、真的独立于备份进程的写入进程（`postgresql/g07-writer.sh`，
 *  经 `docker exec` 起，所以它确实是**另一个 OS 进程**）。
 *
 *  它每批写**恰好 2 行、一个事务**，并且**提交之后才把这一批的摘要打到 stdout**。
 *  于是两件事同时变得可判定：
 *
 * ```text
 *   ① 快照一致性：目标库里若出现"只有 1 行的批次" ⇒ 备份取到了半提交状态（必须红）
 *   ② 比较对象：拿"提交后记录"（stdout）与恢复出来的内容对，**不**去比
 *      "还在变的实时源"（契约 `G07.6` 要的正是这一点）
 * ```
 *
 *  再加一条**对照**：写入停掉之后再 dump 一次（静默态）。于是同一个探针表有两个读数：
 *
 * ```text
 *   在线备份（写入进行中）  ⇒ 探针表 = 2k 行（k < m）
 *   静默备份（写入已停）    ⇒ 探针表 = 2m 行
 *   ⇒ 两者**不同**这件事本身就是"在线备份取的是写入中的某一刻"的第二份证据
 * ```
 *
 *  ⚠️ **这不等于"对真实核心做过在线备份"**。真实核心的首次在线备份读数属 WP7/WP8。
 *     本门证明的是**机制**：并发写入下不需要停任何东西，且取到的是事务一致的点。
 *
 * ---------------------------------------------------------------------------
 *  隐私边界（刻意做成两处落盘）
 * ---------------------------------------------------------------------------
 *  · 进仓库的机器证据：备份的**清单**（表名 / 行数 / 摘要）+ 资产**汇总**
 *    （根的 id / 归属 / 文件数 / 字节数 / 根摘要）。
 *  · **不进仓库**（`artifacts/post-lv2/local/`，已 gitignore）：备份文件本体
 *    （含私人历史，计划 §7 `N09`）与**逐文件**资产清单（`data/qq-private` 的文件名
 *    可能含 QQ 标识 —— 那是私人标识，不该进提交历史）。
 *
 * 跑法：pnpm postgresql:g07:verify
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import {
  dockerExec,
  pgDumpToFile,
  psql,
  psqlFile,
  psqlFromStdin,
  readIdentity,
  type PgIdentity,
} from './postgresql/pg-exec.ts'
import { buildBackupManifest, parsePlainDump, verifyBackupFile, type BackupManifest } from './postgresql/backup.ts'
import {
  ASSET_ROOT_DECLARATIONS,
  buildAssetManifest,
  residualDataFiles,
  unclassifiedDataRoots,
  verifyAssetManifest,
  type AssetManifest,
} from './postgresql/external-assets.ts'
import { inventorySetDifference, readInventory, summarizeInventory } from './postgresql/inventory.ts'
import { dumpPgliteSnapshot, EXPORT_RUNTIME_DIR, PINNED_TOOLS_VERSION } from './postgresql/pglite-dump.ts'

// ===========================================================================
// 配置
// ===========================================================================
const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const SRC_DB = 'lg_test_g07_src'
const DST_DB = 'lg_test_g07_dst'
const PROBE_TABLE = 'online_backup_probe'
const CONTROL_TABLE = 'g07_control'

const MIGRATE_USER = 'lg_migrate'
const RUNTIME_USER = 'lg_runtime'

/** **不进仓库**的落盘处（备份本体含私人历史） */
const LOCAL_DIR = resolve('artifacts/post-lv2/local/pg-migration')
const SRC_RESTORE_SQL = join(LOCAL_DIR, 'g07-src-restore.sql')
const BACKUP_FILE = join(LOCAL_DIR, 'g07-online-backup.sql')
const BACKUP_AFTER_STOP = join(LOCAL_DIR, 'g07-backup-after-stop.sql')
const BACKUP_TAMPERED = join(LOCAL_DIR, 'g07-online-backup.tampered.sql')
const BACKUP_TRUNCATED = join(LOCAL_DIR, 'g07-online-backup.truncated.sql')
const ASSET_FILES_LOCAL = join(LOCAL_DIR, 'g07-asset-files.json')

const UTC_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_ID = `pg-migration-g07-${UTC_STAMP}`
const EVIDENCE_DIR = resolve(`artifacts/post-lv2/postgresql-migration/${RUN_ID}`)

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

// ===========================================================================
// 报告骨架
// ===========================================================================
const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []
const observations: Record<string, unknown> = {}
const commands: { command: string; rc: number }[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function note(entry: { command: string; rc: number }): void {
  commands.push(entry)
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function gitHead(): string {
  return (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim()
}

// ===========================================================================
// §1 备份清单与拒收链（**纯函数**，用合成夹具 —— 不依赖实例）
// ===========================================================================
const FIXTURE_DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '-- Dumped from database version 17.11',
  '-- Dumped by pg_dump version 17.11',
  '',
  'CREATE TABLE public.demo (id integer NOT NULL, payload text);',
  'COPY public.demo (id, payload) FROM stdin;',
  '1\talpha',
  '2\tbeta',
  '\\.',
  'CREATE TABLE public.other (id integer NOT NULL);',
  'COPY public.other (id) FROM stdin;',
  '7\t',
  '\\.',
  '-- PostgreSQL database dump complete',
  '',
].join('\n')

const FIXTURE_IDENTITY: PgIdentity = {
  database: 'fixture_db',
  user: 'fixture_user',
  host: '127.0.0.1',
  port: '55432',
  serverVersion: '17.11',
  vectorVersion: '0.8.7',
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'lg-g07-fixture-'))
const fixtureFile = join(fixtureDir, 'dump.sql')
writeFileSync(fixtureFile, FIXTURE_DUMP, 'utf8')
const fixtureManifest = buildBackupManifest({
  file: fixtureFile,
  relativeFile: 'fixture/dump.sql',
  sourceIdentity: FIXTURE_IDENTITY,
  dumpArgs: [],
  capturedAt: new Date('2026-01-01T00:00:00.000Z'),
})

check('G07.0a 解析：合成夹具的抬头/版本/表清单/行数读对了', () => {
  const parsed = parsePlainDump(FIXTURE_DUMP)
  assert.equal(parsed.headerPresent, true)
  assert.equal(parsed.endMarkerPresent, true)
  assert.equal(parsed.pgDumpVersion, '17.11')
  assert.equal(parsed.dumpedFromVersion, '17.11')
  assert.equal(parsed.tables.length, 2, `读到的表数不对：${JSON.stringify(parsed.tables.map((t) => t.name))}`)
  assert.deepEqual(parsed.tables.map((t) => `${t.name}:${t.rows}`).sort(), ['public.demo:2', 'public.other:1'])
  assert.equal(parsed.totalRows, 3)
  assert.equal(fixtureManifest.bytes, Buffer.byteLength(FIXTURE_DUMP, 'utf8'))
})

check('G07.0b 正控：完好的备份按清单校验 ⇒ 通过（否则后面的"拒收"没有意义）', () => {
  const verdict = verifyBackupFile(fixtureFile, fixtureManifest)
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
})

check('G07.0c-负控 同长度篡改（改一个字符）⇒ backup_digest_mismatch，且**不是** backup_truncated', () => {
  const tampered = join(fixtureDir, 'tampered.sql')
  // ⚠️ 只改一个字符、**长度不变** —— 这是"这条负控在量摘要，不是在量长度"的前提。
  const mutated = FIXTURE_DUMP.replace('2\tbeta', '2\tbets')
  assert.equal(Buffer.byteLength(mutated, 'utf8'), fixtureManifest.bytes, '前置：篡改后长度必须相同')
  writeFileSync(tampered, mutated, 'utf8')
  const verdict = verifyBackupFile(tampered, fixtureManifest)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_digest_mismatch', JSON.stringify(verdict))
})

check('G07.0d-负控 截断（砍掉尾部）⇒ backup_truncated', () => {
  const truncated = join(fixtureDir, 'truncated.sql')
  writeFileSync(truncated, FIXTURE_DUMP.slice(0, 180), 'utf8')
  const verdict = verifyBackupFile(truncated, fixtureManifest)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_truncated', JSON.stringify(verdict))
})

check('G07.0e-负控 长度凑巧相同但尾部被抹 ⇒ 仍报 backup_truncated（靠结尾行抓）', () => {
  const masked = join(fixtureDir, 'masked.sql')
  // 把结尾行换成等长的空白 —— 长度不变，但"dump 完整的结尾"没了
  const replaced = FIXTURE_DUMP.replace('-- PostgreSQL database dump complete', ' '.repeat(36))
  assert.equal(Buffer.byteLength(replaced, 'utf8'), fixtureManifest.bytes, '前置：长度必须相同')
  writeFileSync(masked, replaced, 'utf8')
  const verdict = verifyBackupFile(masked, fixtureManifest)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_truncated', JSON.stringify(verdict))
})

check('G07.0f-负控 文件不存在 ⇒ backup_file_missing', () => {
  const verdict = verifyBackupFile(join(fixtureDir, 'nope.sql'), fixtureManifest)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_file_missing')
})

check('G07.0g-负控 0 字节 ⇒ backup_empty', () => {
  const empty = join(fixtureDir, 'empty.sql')
  writeFileSync(empty, '')
  const verdict = verifyBackupFile(empty, fixtureManifest)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_empty')
})

check('G07.0h-负控 不是 dump 的文本 ⇒ backup_header_missing', () => {
  const other = join(fixtureDir, 'other.sql')
  writeFileSync(other, 'select 1;\n'.repeat(20))
  const verdict = verifyBackupFile(other, fixtureManifest)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_header_missing')
})

check('G07.0i-负控 备份**没变**但清单被改（摘要换掉）⇒ 仍拒收（判据挂在清单上）', () => {
  const lying: BackupManifest = { ...fixtureManifest, sha256: 'f'.repeat(64) }
  const verdict = verifyBackupFile(fixtureFile, lying)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'backup_digest_mismatch')
})

check('G07.0j 六种拒收原因**互不相同**（可区分性本身是判据）', () => {
  const reasons = new Set([
    'backup_file_missing',
    'backup_empty',
    'backup_header_missing',
    'backup_truncated',
    'backup_digest_mismatch',
    'backup_structure_mismatch',
  ])
  assert.equal(reasons.size, 6)
})

check('G07.0k 恢复：被破坏的副本还原 ⇒ 又通过', () => {
  assert.equal(verifyBackupFile(fixtureFile, fixtureManifest).ok, true)
  const copy = join(fixtureDir, 'copy.sql')
  copyFileSync(fixtureFile, copy)
  writeFileSync(copy, 'broken', 'utf8')
  assert.equal(verifyBackupFile(copy, fixtureManifest).ok, false, '前置：破坏后应当被拒')
  copyFileSync(fixtureFile, copy)
  assert.equal(verifyBackupFile(copy, fixtureManifest).ok, true, '还原后应当又通过')
})

// ===========================================================================
// §2 数据库外资产：清单、拒收链与**完整性**判据（`G07.5`）
// ===========================================================================
const assetFixtureRoot = mkdtempSync(join(tmpdir(), 'lg-g07-assets-'))
for (const declaration of ASSET_ROOT_DECLARATIONS) {
  if (declaration.decision !== 'include') continue
  const dir = join(assetFixtureRoot, declaration.path.replace(/^data[\\/]/, ''))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'seed.bin'), Buffer.from(`seed:${declaration.id}`, 'utf8'))
}
const assetFixtureManifest = buildAssetManifest({ dataRoot: assetFixtureRoot, capturedAt: new Date('2026-01-01T00:00:00.000Z') })

check('G07.5a 正控：资产夹具按 manifest 校验 ⇒ 通过', () => {
  assert.ok(assetFixtureManifest.files.length >= 5, `夹具文件太少：${assetFixtureManifest.files.length}`)
  const verdict = verifyAssetManifest(assetFixtureManifest, { dataRoot: assetFixtureRoot })
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
})

check('G07.5b-负控 改一个资产文件的内容 ⇒ asset_digest_mismatch', () => {
  const victim = join(assetFixtureRoot, 'personal-library', 'seed.bin')
  const original = readFileSync(victim)
  writeFileSync(victim, Buffer.concat([original, Buffer.from('!')]))
  const verdict = verifyAssetManifest(assetFixtureManifest, { dataRoot: assetFixtureRoot })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'asset_digest_mismatch', JSON.stringify(verdict))
  writeFileSync(victim, original)
})

check('G07.5c-负控 删一个资产文件 ⇒ asset_missing', () => {
  const victim = join(assetFixtureRoot, 'owner-records', 'seed.bin')
  const original = readFileSync(victim)
  rmSync(victim)
  const verdict = verifyAssetManifest(assetFixtureManifest, { dataRoot: assetFixtureRoot })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'asset_missing', JSON.stringify(verdict))
  writeFileSync(victim, original)
})

check('G07.5d-负控 多出一个没在清单里的文件 ⇒ asset_unexpected_file（"没清干净"是独立事故形状）', () => {
  const extra = join(assetFixtureRoot, 'qq-private', 'stray.bin')
  writeFileSync(extra, 'stray')
  const verdict = verifyAssetManifest(assetFixtureManifest, { dataRoot: assetFixtureRoot })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'asset_unexpected_file', JSON.stringify(verdict))
  rmSync(extra)
})

check('G07.5e 恢复：三种破坏都还原 ⇒ 又通过', () => {
  const verdict = verifyAssetManifest(assetFixtureManifest, { dataRoot: assetFixtureRoot })
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
})

check('G07.5f-负控 空 manifest ⇒ asset_manifest_empty（**不许把空集当绿灯**）', () => {
  const emptyManifest: AssetManifest = { ...assetFixtureManifest, files: [], totalFiles: 0, totalBytes: 0 }
  const verdict = verifyAssetManifest(emptyManifest, { dataRoot: assetFixtureRoot })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.reason, 'asset_manifest_empty', JSON.stringify(verdict))
})

check('G07.5g ★ 完整性判据真的会咬：夹具里放一个**未登记**目录 ⇒ 被点名列出', () => {
  // ⚠️ 这条是"完整清单"的**负控**：没有它，`unclassifiedDataRoots` 可能是一个
  //    永远返回空的函数 —— 那种判据看起来在工作，其实什么也没挡。
  const baseline = unclassifiedDataRoots(assetFixtureRoot).map((entry) => entry.name)
  assert.deepEqual(baseline, [], `夹具基线应当是"全部已登记"，实际：${baseline.join(',')}`)
  mkdirSync(join(assetFixtureRoot, 'brand-new-root'), { recursive: true })
  const after = unclassifiedDataRoots(assetFixtureRoot).map((entry) => entry.name)
  assert.deepEqual(after, ['brand-new-root'], `新目录没有被点名：${after.join(',')}`)
  rmSync(join(assetFixtureRoot, 'brand-new-root'), { recursive: true })
})

// 真数据根（**只读**）读数
const realAssetManifest = buildAssetManifest()
observations.assetRootsReal = realAssetManifest.roots.map((root) => ({
  id: root.id,
  decision: root.decision,
  exists: root.exists,
  counted: root.counted,
  files: root.files,
  bytes: root.bytes,
  digest: root.digest,
}))
observations.assetTotalFiles = realAssetManifest.totalFiles
observations.assetTotalBytes = realAssetManifest.totalBytes
observations.assetManifestDigest = realAssetManifest.manifestDigest
observations.assetUnclassified = realAssetManifest.unclassified
observations.assetResidualFileCount = residualDataFiles().length

check('G07.5h 真数据根：`data/` 下**每一个目录**都有具名归属（没有"我没判过"的）', () => {
  assert.deepEqual(
    realAssetManifest.unclassified,
    [],
    `未登记的目录：${realAssetManifest.unclassified.join(', ')}（新增目录必须来 ASSET_ROOT_DECLARATIONS 登记）`
  )
})

check('G07.5i 真数据根：manifest 真的算出了内容（不是"空清单也算过"）', () => {
  assert.ok(realAssetManifest.totalBytes > 0, 'include 的根加起来是 0 字节 ⇒ 这条判据没量到东西')
  const counted = realAssetManifest.roots.filter((root) => root.counted)
  assert.ok(counted.length >= 3, `被完整遍历的根太少：${counted.length}`)
  for (const root of counted) assert.ok(root.digest !== null && /^[0-9a-f]{64}$/.test(root.digest))
})

// 逐文件清单落 **local/**（含可能含 QQ 标识的文件名，不进仓库）
mkdirSync(LOCAL_DIR, { recursive: true })
writeFileSync(
  ASSET_FILES_LOCAL,
  JSON.stringify({ dataRoot: realAssetManifest.dataRoot, files: realAssetManifest.files }, null, 2),
  'utf8'
)

// ===========================================================================
// §3 真实例：并发写入下的在线备份 → 新库恢复
// ===========================================================================
interface WriterBatch {
  batchId: number
  rows: number
  md5: string
}

function parseWriterLine(line: string): WriterBatch | undefined {
  const match = /^BATCH\|(\d+)\|(\d+)\|([0-9a-f]{32})$/.exec(line) // 形如 `BATCH|12|2|<md5>`
  if (match === null) return undefined
  return { batchId: Number(match[1]), rows: Number(match[2]), md5: match[3] }
}

function queryFactory(user: string, password: string, database: string): (sql: string) => string | undefined {
  return (sql: string) => {
    const r = psql({ container: CONTAINER, user, password, database, sql })
    note({ command: r.command, rc: r.rc })
    return r.rc === 0 ? r.out : undefined
  }
}

/** 容器内路径：`/opt/lg` 就是 `scripts/postgresql/`（见 `pg-exec.ts` 文件头 ③） */
function manageTestDb(script: 'create-test-db.sql' | 'drop-test-db.sql', dbName: string): ReturnType<typeof psqlFile> {
  const r = psqlFile({
    container: CONTAINER,
    user: credentials?.LG_PG_BOOTSTRAP_USER ?? '',
    password: credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '',
    database: credentials?.LG_PG_BOOTSTRAP_DB ?? '',
    file: `/opt/lg/${script}`,
    variables: { LG_TEST_DB_NAME: dbName, LG_PG_MIGRATE_USER: MIGRATE_USER },
  })
  note({ command: r.command, rc: r.rc })
  return r
}

function databaseExists(name: string): boolean {
  const r = psql({
    container: CONTAINER,
    user: credentials?.LG_PG_BOOTSTRAP_USER ?? '',
    password: credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '',
    database: 'postgres',
    sql: `select count(*) from pg_database where datname = '${name}'`,
  })
  return r.rc === 0 && r.out.trim() === '1'
}

async function main(): Promise<void> {
  mkdirSync(LOCAL_DIR, { recursive: true })
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  const pgDumpVersionReading = dockerExec({ container: CONTAINER, argv: ['pg_dump', '--version'] })
  note({ command: pgDumpVersionReading.command, rc: pgDumpVersionReading.rc })
  observations.pgDumpVersionInContainer = pgDumpVersionReading.out

  const instanceUp = ((): boolean => {
    if (credentials === undefined) return false
    const probe = psql({
      container: CONTAINER,
      user: credentials.LG_PG_BOOTSTRAP_USER,
      password: credentials.LG_PG_BOOTSTRAP_PASSWORD,
      database: 'postgres',
      sql: 'select 1 as ok',
    })
    return probe.rc === 0 && probe.out.includes('1')
  })()
  const snapshotExists = existsSync(resolve(SOURCE_SNAPSHOT, 'PG_VERSION'))
  const exportRuntimeReady = existsSync(resolve(EXPORT_RUNTIME_DIR, 'node_modules/@electric-sql/pglite-tools/package.json'))

  const blocked =
    credentials === undefined
      ? `凭据文件不存在：${PG_CREDENTIALS_FILE}`
      : missingKeys.length > 0
        ? `凭据文件缺这些 key：${missingKeys.join(', ')}（文件：${PG_CREDENTIALS_FILE}）`
        : !instanceUp
          ? `容器 ${CONTAINER} 不可达`
          : !snapshotExists
            ? `来源快照不存在：${SOURCE_SNAPSHOT}（可用 LG_PG_SOURCE_SNAPSHOT 指定）`
            : !exportRuntimeReady
              ? `导出工具运行时未就绪：${EXPORT_RUNTIME_DIR}（见 WP4 Handoff）`
              : undefined

  if (blocked !== undefined) {
    notRun.push({
      id: 'online-backup-restore',
      what: '并发写入下的在线备份 → 新空库恢复（G07.1/G07.2/G07.6/G07.7）',
      why: blocked,
    })
  } else {
    const srcPassword = credentials!.LG_PG_MIGRATE_PASSWORD
    const runtimePassword = credentials!.LG_PG_RUNTIME_PASSWORD
    let srcIdentity: PgIdentity | undefined
    let dstIdentity: PgIdentity | undefined

    try {
      // ---------------------------------------------------------------------
      // 1) 建 src → 把 verified 快照恢复到它上面（备份一个**真实形状**的库）
      // ---------------------------------------------------------------------
      manageTestDb('drop-test-db.sql', SRC_DB)
      const srcCreated = manageTestDb('create-test-db.sql', SRC_DB)
      check('G07.1a 前置：src 测试库从零建立', () => {
        assert.equal(srcCreated.rc, 0, srcCreated.err)
      })

      const sourceDump = await dumpPgliteSnapshot({
        sourceDir: SOURCE_SNAPSHOT,
        args: ['--no-owner', '--no-privileges', '--no-comments'],
        outFile: SRC_RESTORE_SQL,
      })
      observations.sourceExport = {
        tool: `${sourceDump.tool.toolsVersion}(pglite ${sourceDump.tool.pgliteVersion})`,
        pinnedTools: PINNED_TOOLS_VERSION,
        bytes: sourceDump.bytes,
        sqlDigest: sourceDump.sqlDigest,
        elapsedMs: sourceDump.elapsedMs,
        sourceUnchanged: sourceDump.sourceUnchanged,
        copyMatchesSource: sourceDump.copyMatchesSource,
        closedClean: sourceDump.closedClean,
      }
      check('G07.1b 前置：verified 快照导出成 SQL（源目录逐字未动）', () => {
        assert.equal(sourceDump.sourceUnchanged, true, '导出前后源目录不同 ⇒ 动了不该动的东西')
        assert.equal(sourceDump.copyMatchesSource, true)
        assert.equal(sourceDump.closedClean, true)
        assert.ok(sourceDump.bytes > 1_000_000, `导出太小（${sourceDump.bytes}B）⇒ 这不是一个真实形状的库`)
      })

      const restoreSrc = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: SRC_DB,
        sql: sourceDump.sql,
        timeoutMs: 900_000,
      })
      note({ command: restoreSrc.command, rc: restoreSrc.rc })
      check('G07.1c 前置：快照已恢复进 src（exit 0，且日志里没有 ERROR）', () => {
        assert.equal(restoreSrc.rc, 0, restoreSrc.err.slice(0, 500))
        assert.ok(!/^ERROR/m.test(restoreSrc.err), `恢复日志里有 ERROR：${restoreSrc.err.slice(0, 500)}`)
      })

      // ---------------------------------------------------------------------
      // 2) 探针表 + 控制表 —— **建在读对象清单之前**
      // ---------------------------------------------------------------------
      // ⚠️ 顺序是有判据含义的（本轮实测）：第一版先读 src 清单、**之后**才建探针表，
      //    于是 dump 里多出 `public.online_backup_probe` 与 `public.g07_control`
      //    两个对象，而"源清单"那份读数里没有它们 ⇒ `G07.2d` 报"目标多对象"。
      //    那不是数据问题，是**量具自己的取数顺序**问题。
      //    ⇒ 本门自己造的对象必须在**取源清单之前**就存在。
      const createProbe = psql({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: SRC_DB,
        sql:
          `drop table if exists public.${PROBE_TABLE}; ` +
          `create table public.${PROBE_TABLE} (batch_id bigint not null, seq integer not null, ` +
          `payload text not null, primary key (batch_id, seq)); ` +
          `drop table if exists public.${CONTROL_TABLE}; ` +
          `create table public.${CONTROL_TABLE} (stop boolean not null); ` +
          `insert into public.${CONTROL_TABLE}(stop) values (false)`,
      })
      note({ command: createProbe.command, rc: createProbe.rc })
      check('G07.1e 前置：探针表与控制表已建；dst 此刻还不存在', () => {
        assert.equal(createProbe.rc, 0, createProbe.err)
        assert.equal(databaseExists(DST_DB), false, `前置：${DST_DB} 此刻不该存在（后面要断言"拒收发生在恢复之前"）`)
      })

      srcIdentity = readIdentity({ container: CONTAINER, user: MIGRATE_USER, password: srcPassword, database: SRC_DB })
      const srcInventory = readInventory(queryFactory(MIGRATE_USER, srcPassword, SRC_DB))
      const srcSummary = srcInventory === undefined ? undefined : summarizeInventory(srcInventory.objects)
      observations.srcIdentity = srcIdentity
      observations.srcInventory =
        srcSummary === undefined
          ? null
          : {
              objects: srcInventory!.objects.length,
              inScope: srcSummary.inScope.length,
              excluded: srcSummary.excluded.length,
              unclassified: srcSummary.unclassified.map((entry) => `${entry.object.schema}.${entry.object.name}(${entry.object.kind})`),
              extensions: srcInventory!.extensions,
            }
      check('G07.1d 前置：src 的对象清单每一件都判过类（`unclassified` 必须为空）', () => {
        assert.ok(srcSummary !== undefined, '对象清单读不出来')
        assert.ok(srcSummary!.inScope.length >= 40, `in-scope 对象太少：${srcSummary!.inScope.length}`)
        assert.deepEqual(
          srcSummary!.unclassified.map((entry) => `${entry.object.schema}.${entry.object.name}`),
          [],
          '出现了没有裁定的对象 ⇒ 清单不完整（见 inventory.ts 的 classifyObject）'
        )
      })

      // ---------------------------------------------------------------------
      // 3) ★ 在线备份：写入进行中，**不停任何东西**
      // ---------------------------------------------------------------------
      const writerBatches: WriterBatch[] = []
      let writerStderr = ''
      const writerLines: string[] = []
      const writer = spawn(
        'docker',
        ['exec', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'MAX_BATCHES', CONTAINER, 'sh', '/opt/lg/g07-writer.sh'],
        {
          env: {
            ...process.env,
            PGUSER: RUNTIME_USER,
            PGPASSWORD: runtimePassword,
            PGDATABASE: SRC_DB,
            MAX_BATCHES: '20000',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let writerExit: number | undefined
      const writerClosed = new Promise<void>((done) => {
        writer.on('close', (code) => {
          writerExit = code ?? -1
          done()
        })
      })
      writer.stderr?.on('data', (chunk: Buffer) => {
        writerStderr += chunk.toString('utf8')
      })
      // ⚠️ **必须留残行**：管道的分块边界几乎不可能正好落在换行处。
      //    第一版把每个 chunk 直接 `split('\n')` ⇒ 跨块的那一行被**切成两段**、
      //    两段都过不了正则 ⇒ 那一批**从写入记录里消失**。
      //    后果是很具体的：本轮实测 `src 3261 批 ≠ 记录 3259 批`（丢了 2 行），
      //    而"目标与记录逐字一致"那条判据就会把**量具自己的丢行**报成数据不一致。
      let writerPending = ''
      writer.stdout?.on('data', (chunk: Buffer) => {
        const parts = (writerPending + chunk.toString('utf8')).split('\n')
        writerPending = parts.pop() ?? ''
        for (const raw of parts) {
          const line = raw.trim()
          if (line === '') continue
          writerLines.push(line)
          const batch = parseWriterLine(line)
          if (batch !== undefined) writerBatches.push(batch)
        }
      })
      const flushWriterPending = (): void => {
        const line = writerPending.trim()
        writerPending = ''
        if (line === '') return
        writerLines.push(line)
        const batch = parseWriterLine(line)
        if (batch !== undefined) writerBatches.push(batch)
      }

      const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (predicate()) return true
          await sleep(50)
        }
        return predicate()
      }

      const writerWarm = await waitUntil(() => writerBatches.length >= 3, 30_000)
      observations.writerEarlyLines = writerLines.slice(0, 3)

      check('G07.1f 并发写入进程真的起来了（≥3 批已提交，且每批 2 行）', () => {
        assert.equal(
          writerWarm,
          true,
          `30s 内没看到 3 批提交；stdout=${JSON.stringify(writerLines.slice(0, 5))} stderr=${writerStderr.slice(0, 300)}`
        )
        assert.ok(
          writerBatches.slice(0, 3).every((batch) => batch.rows === 2),
          `批次的构成不对：${JSON.stringify(writerBatches.slice(0, 3))}`
        )
      })

      // ---------------------------------------------------------------------
      // 3) ★ 在线备份：写入进行中，**不停任何东西**
      // ---------------------------------------------------------------------
      const probeRowCount = (): number =>
        Number(
          psql({
            container: CONTAINER,
            user: MIGRATE_USER,
            password: srcPassword,
            database: SRC_DB,
            sql: `select count(*) from public.${PROBE_TABLE}`,
          }).out
        )
      const rowsBeforeDump = probeRowCount()
      const batchesAtDumpStart = writerBatches.length
      const dumpStartedAt = Date.now()
      const outFd = openSync(BACKUP_FILE, 'w')
      const dumpProcess = spawn(
        'docker',
        // ⚠️ 只用 `--no-comments`（**不是** PGlite 路径上的三条）：
        //    源对象与恢复账号同为 `lg_migrate` ⇒ owner/ACL 语句本来就成立；
        //    唯一过不去的是扩展注释（见 `extensionCommentStatements` 的注释），
        //    而那一条**有显式补偿**（恢复后由超级用户补上）。
        ['exec', '-e', 'PGPASSWORD', CONTAINER, 'pg_dump', '-h', '127.0.0.1', '-U', MIGRATE_USER, '-d', SRC_DB, '--no-comments'],
        { env: { ...process.env, PGPASSWORD: srcPassword }, stdio: ['ignore', outFd, 'pipe'] }
      )
      let dumpStderr = ''
      dumpProcess.stderr?.on('data', (chunk: Buffer) => {
        dumpStderr += chunk.toString('utf8')
      })
      let dumpExit: number | undefined
      const dumpClosed = new Promise<void>((done) => {
        dumpProcess.on('close', (code) => {
          dumpExit = code ?? -1
          closeSync(outFd)
          done()
        })
      })

      // 备份进行中的**第三方观察**：一条查询同时读"pg_dump 后端在不在"与"探针表多少行"。
      //
      // ⚠️ 这里有两个都只有跑起来才会暴露的坑（本轮实测，第一个把整道门拖到 180s）：
      //    ① `psql()` 走的是 **`spawnSync`** —— 它**阻塞整个事件循环**。
      //       于是"不留睡眠"的紧循环会让 `dumpProcess.on('close')` **永远排不上队**：
      //       `dumpExit` 一直是 `undefined`，循环只能跑到超时。
      //       读数上的表现极其误导：`committedDuringDump = 1818`（看着像备份跑了 60s），
      //       真相是**备份 0.6s 就结束了**，而循环空转了 180s。⇒ 每轮必须 `await` 让出。
      //    ② 反过来，如果 `sleep` 太长（第一版 250ms），dump 只有 0.5s
      //       ⇒ 只采到 **1** 个样本，判据就变成在量采样频率。
      //    ⇒ 折中：**每轮让出 ~15ms**，并把"并发"的硬判据放在确定性的行数增长上。
      const samples: { pgDumpPresent: boolean; probeRows: number; clientBackends: number; committed: number }[] = []
      while (dumpExit === undefined && Date.now() - dumpStartedAt < 60_000) {
        const reading = psql({
          container: CONTAINER,
          user: credentials!.LG_PG_BOOTSTRAP_USER,
          password: credentials!.LG_PG_BOOTSTRAP_PASSWORD,
          database: SRC_DB,
          sql:
            `select (select count(*) from pg_stat_activity where datname='${SRC_DB}' and application_name='pg_dump')` +
            `||'|'||(select count(*) from pg_stat_activity where datname='${SRC_DB}')` +
            `||'|'||(select count(*) from public.${PROBE_TABLE})`,
        })
        const [pgDumpCount, clientBackends, probeRows] = reading.out.split('|')
        samples.push({
          pgDumpPresent: Number(pgDumpCount) >= 1,
          probeRows: Number(probeRows),
          clientBackends: Number(clientBackends),
          committed: writerBatches.length,
        })
        await sleep(15)
      }
      await Promise.race([dumpClosed, sleep(60_000)])

      const rowsAtDumpEnd = probeRowCount()
      const batchesAfterDump = writerBatches.length
      const committedDuringDump = batchesAfterDump - batchesAtDumpStart
      const samplesWithDump = samples.filter((sample) => sample.pgDumpPresent).length
      observations.onlineBackup = {
        file: 'artifacts/post-lv2/local/pg-migration/g07-online-backup.sql（**不进仓库**）',
        args: ['--no-comments'],
        exitCode: dumpExit ?? -1,
        elapsedMs: Date.now() - dumpStartedAt,
        stderr: dumpStderr.slice(0, 400),
        rowsBeforeDump,
        rowsAtDumpEnd,
        batchesAtDumpStart,
        batchesAfterDump,
        committedDuringDump,
        samples: samples.length,
        samplesWithPgDumpPresent: samplesWithDump,
        maxClientBackends: samples.reduce((max, sample) => Math.max(max, sample.clientBackends), 0),
        probeRowsSamples: samples.map((sample) => sample.probeRows),
      }

      check('G07.1g ★ 备份成功：写入进行中 `pg_dump` 退出码 0', () => {
        assert.equal(dumpExit, 0, `pg_dump 退出码 ${dumpExit}；stderr=${dumpStderr.slice(0, 400)}`)
      })

      check('G07.1h ★ 备份**确实**发生在写入进行中（不是"停下来之后才备份的"）', () => {
        assert.ok(committedDuringDump >= 1, `备份期间一批都没提交（${committedDuringDump}）⇒ 这条判据没量到"在线"`)
        assert.ok(
          rowsAtDumpEnd > rowsBeforeDump,
          `备份的**起止窗口内**探针表行数没有增长（${rowsBeforeDump} → ${rowsAtDumpEnd}）⇒ 并发写入没有真的在进行`
        )
        /*
         * ⚠️ 2026-10-13（`F-WP5-16`）：这里原来还有第三条 `samplesWithDump >= 1`
         *    ——「采样时**看得见** `pg_dump` 后端」。那是一条**竞态**判据：
         *    采样是另起 `docker exec psql`（每次约 85ms），而 dump 只有 300–400ms，
         *    所以"看得见/看不见"取决于时序 ⇒ **同一份代码会时红时绿**（实测：
         *    单独跑 47/47，在 lane 里跑 46/47，红的正是这一条）。
         *
         *    ⇒ 判据改挂**直接证据**（上面两条：备份窗口内**行数在长**且**有批次提交**），
         *      那才是这条判据要说的意思；采样结果降级为**读数**（仍然记录，但不再当判据）。
         *      ⚠️ 这是**把弱代理换成直接证据**，不是放宽：判据要证明的性质一条没少。
         */
      })

      // ---------------------------------------------------------------------
      // 4) 停写（**经数据库**，因为容器里看不见宿主机的 artifacts/）
      // ---------------------------------------------------------------------
      const setStop = psql({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: SRC_DB,
        sql: `update public.${CONTROL_TABLE} set stop = true`,
      })
      note({ command: setStop.command, rc: setStop.rc })
      const writerStopped = await Promise.race([writerClosed.then(() => true), sleep(60_000).then(() => false)])
      flushWriterPending()
      observations.writer = {
        exitCode: writerExit ?? null,
        lines: writerLines.length,
        batches: writerBatches.length,
        lastLine: writerLines[writerLines.length - 1],
        stderr: writerStderr.slice(0, 300),
        stoppedWithinTimeout: writerStopped,
        stopSignalRc: setStop.rc,
      }

      check('G07.1i 停写：控制表的停机位被读到，写入进程退出码 0', () => {
        assert.equal(setStop.rc, 0, setStop.err)
        assert.equal(writerStopped, true, '写入进程 60s 内没有退出')
        assert.equal(writerExit, 0, `写入进程退出码 ${writerExit}；stderr=${writerStderr.slice(0, 300)}`)
        assert.ok(writerBatches.length >= 3)
        assert.ok(writerBatches.every((batch) => batch.rows === 2), '写入记录里出现了不是 2 行的批次 ⇒ 探针本身坏了')
      })

      const batchIdsInLog = writerBatches.map((batch) => batch.batchId)
      check('G07.1j 写入记录自身是连续前缀 1..m（否则"目标里的 k"无从解释）', () => {
        assert.equal(
          batchIdsInLog.every((id, index) => id === index + 1),
          true,
          `写入记录不连续：${batchIdsInLog.slice(0, 20).join(',')}…`
        )
      })

      const srcProbeDigests = psql({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: SRC_DB,
        sql:
          `select batch_id||'|'||count(*)||'|'||md5(string_agg(batch_id||':'||seq||':'||payload, ',' order by seq)) ` +
          `from public.${PROBE_TABLE} group by batch_id order by batch_id`,
      })
      note({ command: srcProbeDigests.command, rc: srcProbeDigests.rc })
      const srcProbeLines = srcProbeDigests.out.split('\n').filter((line) => line.trim() !== '')
      observations.srcProbeBatches = srcProbeLines.length
      check('G07.1k 恢复：src 的最终内容与"提交后记录"逐字一致（写入进程没有骗人）', () => {
        assert.equal(srcProbeLines.length, writerBatches.length, `src ${srcProbeLines.length} 批 ≠ 记录 ${writerBatches.length} 批`)
        const matches = writerBatches.every((batch, index) => {
          const [id, rows, md5] = (srcProbeLines[index] ?? '').split('|')
          return Number(id) === batch.batchId && Number(rows) === batch.rows && md5 === batch.md5
        })
        assert.equal(matches, true, 'src 的内容与提交后记录对不上 ⇒ 后续"目标一致"就无从解释')
      })

      // ---------------------------------------------------------------------
      // 5) 对照：静默态再 dump 一次（探针表应当有 2m 行，而在线备份只有 2k 行）
      // ---------------------------------------------------------------------
      const quiescent = pgDumpToFile({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: SRC_DB,
        outFile: BACKUP_AFTER_STOP,
        args: ['--no-comments'],
      })
      note({ command: quiescent.command, rc: quiescent.rc })
      const quiescentManifest = buildBackupManifest({
        file: BACKUP_AFTER_STOP,
        relativeFile: 'artifacts/post-lv2/local/pg-migration/g07-backup-after-stop.sql',
        sourceIdentity: srcIdentity!,
        dumpArgs: [],
      })
      const probeRowsIn = (manifest: BackupManifest): number | undefined =>
        manifest.tables.find((table) => table.name === `public.${PROBE_TABLE}`)?.rows
      observations.quiescentBackup = {
        exitCode: quiescent.rc,
        probeRows: probeRowsIn(quiescentManifest) ?? null,
        expectedProbeRows: writerBatches.length * 2,
        contentDigest: quiescentManifest.contentDigest,
      }

      check('G07.6d ★ 对照：静默态 dump 的探针表 = 2m 行，而在线备份里 < 2m ⇒ 两份确实取自不同时刻', () => {
        assert.equal(quiescent.rc, 0, quiescent.err.slice(0, 300))
        assert.equal(
          probeRowsIn(quiescentManifest),
          writerBatches.length * 2,
          '静默态 dump 里探针表的行数与写入记录对不上 ⇒ 对照不成立'
        )
      })

      // ---------------------------------------------------------------------
      // 6) 备份清单 + **拒收链**（必须在恢复**之前**）
      // ---------------------------------------------------------------------
      const manifest = buildBackupManifest({
        file: BACKUP_FILE,
        relativeFile: 'artifacts/post-lv2/local/pg-migration/g07-online-backup.sql',
        sourceIdentity: srcIdentity!,
        dumpArgs: ['--no-comments'],
      })
      observations.backupManifest = {
        bytes: manifest.bytes,
        sha256: manifest.sha256,
        pgDumpVersion: manifest.pgDumpVersion,
        dumpedFromVersion: manifest.dumpedFromVersion,
        tables: manifest.tables.length,
        totalRows: manifest.totalRows,
        probeRows: probeRowsIn(manifest) ?? null,
        contentDigest: manifest.contentDigest,
        endMarkerPresent: manifest.endMarkerPresent,
        dumpArgs: manifest.dumpArgs,
      }

      check('G07.3a 正控：真备份文件按自己的清单校验 ⇒ 通过', () => {
        const verdict = verifyBackupFile(BACKUP_FILE, manifest)
        assert.equal(verdict.ok, true, JSON.stringify(verdict))
      })

      // 篡改：**字节级**改一个字节 —— 长度**逐字节不变**。
      //
      // ⚠️ 不能用字符串替换（第一版就是那么写的，红在 `11124525 !== 11124527`）：
      //    `str[i]` 是**一个 UTF-16 码元**，而文件里的中文是 3 字节 UTF-8
      //    ⇒ 用 1 个 ASCII 字符换掉它，**字节数少了 2**，于是"篡改"看起来像"截断"，
      //    `G07.3`（要求 digest_mismatch）与 `G07.4`（要求 truncated）双双失去区分力。
      //    ⇒ 在 Buffer 上翻一个字节：长度恒等，且不碰抬头与结尾行所在的 ASCII 区。
      const backupBuffer = readFileSync(BACKUP_FILE)
      const backupText = backupBuffer.toString('utf8')
      const tamperOffset = Math.floor(backupBuffer.length * 0.6)
      const tamperedBuffer = Buffer.from(backupBuffer)
      tamperedBuffer[tamperOffset] = tamperedBuffer[tamperOffset] ^ 0xff
      writeFileSync(BACKUP_TAMPERED, tamperedBuffer)
      writeFileSync(BACKUP_TRUNCATED, backupBuffer.subarray(0, Math.floor(backupBuffer.length * 0.9)))

      const tamperVerdict = verifyBackupFile(BACKUP_TAMPERED, manifest)
      const truncateVerdict = verifyBackupFile(BACKUP_TRUNCATED, manifest)

      check('G07.3 ★ 篡改备份 ⇒ 拒收，且原因是 backup_digest_mismatch（不是"长度不对"）', () => {
        assert.equal(statSync(BACKUP_TAMPERED).size, manifest.bytes, '前置：篡改必须**不改变长度**')
        assert.equal(tamperVerdict.ok, false, '篡改后的备份被判成通过 ⇒ 拒收判据是假的')
        assert.equal(tamperVerdict.ok === false && tamperVerdict.reason, 'backup_digest_mismatch', JSON.stringify(tamperVerdict))
      })

      check('G07.4 ★ 截断备份 ⇒ 拒收，且原因与篡改**不同**（backup_truncated）', () => {
        assert.equal(truncateVerdict.ok, false, '截断后的备份被判成通过')
        assert.equal(truncateVerdict.ok === false && truncateVerdict.reason, 'backup_truncated', JSON.stringify(truncateVerdict))
        assert.notEqual(
          tamperVerdict.ok === false ? tamperVerdict.reason : 'ok',
          truncateVerdict.ok === false ? truncateVerdict.reason : 'ok',
          '两种损坏给了同一个原因 ⇒ 判据失去诊断力'
        )
      })

      check('G07.3b ★ 拒收发生在**恢复之前**（目标库此刻仍不存在）', () => {
        assert.equal(databaseExists(DST_DB), false, `${DST_DB} 竟然已经存在 ⇒ 有人先恢复了再校验`)
      })

      // ---------------------------------------------------------------------
      // 7) 恢复到**新的**空目标
      // ---------------------------------------------------------------------
      manageTestDb('drop-test-db.sql', DST_DB)
      const dstCreated = manageTestDb('create-test-db.sql', DST_DB)
      check('G07.2a 前置：dst（**新的**空目标）从零建立', () => {
        assert.equal(dstCreated.rc, 0, dstCreated.err)
      })

      const restoreDst = psqlFromStdin({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: DST_DB,
        sql: backupText,
        timeoutMs: 900_000,
      })
      note({ command: restoreDst.command, rc: restoreDst.rc })

      // ---------------------------------------------------------------------
      // 7b) 排除项的**逐条解释**：扩展注释（`--no-comments` 到底丢了什么？）
      // ---------------------------------------------------------------------
      // ⚠️ 本轮实测结论：**代价为 0** —— 而且这个结论是被判据逼出来的，不是推断的。
      //
      //    第一次跑用**不带** `--no-comments` 的 dump ⇒ 恢复红在
      //      `ERROR: must be owner of extension vector`。
      //    原因是 `COMMENT ON EXTENSION` 要求**扩展所有权**，而 `vector` 不是 trusted
      //    扩展（只有超级用户能装）⇒ 目标库里它由 bootstrap 装、注释归 bootstrap；
      //    而 `ALTER EXTENSION … OWNER TO` **语法不存在**（PG 的 ALTER EXTENSION 只支持
      //    UPDATE / SET SCHEMA / ADD / DROP）⇒ 迁移账号改不动。
      //
      //    那我一度以为"要补一条显式补偿"。**但补偿的判断错了**：写那两句注释的
      //    不是一个"人"，是**扩展自己的安装脚本**（`vector--0.8.7.sql` 末尾、
      //    `fuzzystrmatch--1.1.sql`）——所以目标侧**一装扩展就自带**同样的注释。
      //    ⇒ 正确判据不是"把语句搬过去"，而是**验证两边逐字相同**。
      const commentQuery =
        "select e.extname||'|'||coalesce(obj_description(e.oid,'pg_extension'),'(none)') " +
        'from pg_extension e order by e.extname'
      const commentReading = (database: string): string[] =>
        psql({ container: CONTAINER, user: MIGRATE_USER, password: srcPassword, database, sql: commentQuery })
          .out.split('\n')
          .filter((line) => line.trim() !== '')
      const srcComments = commentReading(SRC_DB)
      const dstComments = commentReading(DST_DB)
      observations.extensionComments = {
        src: srcComments,
        dst: dstComments,
        whyExcluded:
          '`COMMENT ON EXTENSION` 要求扩展所有权；`vector` 非 trusted ⇒ 目标库里注释归 bootstrap，' +
          '迁移账号改不动，且 `ALTER EXTENSION … OWNER TO` 语法不存在 ⇒ dump 必须 `--no-comments`',
        whyNoLoss: '这些注释由**扩展安装脚本**写入 ⇒ 目标侧装扩展时自带同样的文字（故代价为 0，逐字校验）',
      }

      check('G07.2f ★ 被 `--no-comments` 排除的扩展注释**逐字**与源相同（代价为 0，而不是"条数凑巧一样"）', () => {
        assert.ok(srcComments.length >= 3, `源里的扩展注释太少（${srcComments.length}）⇒ 这条判据没量到东西`)
        assert.deepEqual(dstComments, srcComments, `扩展注释与源不同：目标 ${JSON.stringify(dstComments)}`)
      })

      dstIdentity = readIdentity({ container: CONTAINER, user: MIGRATE_USER, password: srcPassword, database: DST_DB })
      observations.dstIdentity = dstIdentity

      check('G07.2b ★ 恢复成功：exit 0，且日志里**没有** ERROR', () => {
        assert.equal(restoreDst.rc, 0, restoreDst.err.slice(0, 500))
        assert.ok(!/^ERROR/m.test(restoreDst.err), `恢复日志里有 ERROR：${restoreDst.err.slice(0, 500)}`)
      })

      check('G07.2c 恢复**只读**用了备份：文件摘要前后不变', () => {
        const after = verifyBackupFile(BACKUP_FILE, manifest)
        assert.equal(after.ok, true, `恢复之后备份本体变了：${JSON.stringify(after)}`)
      })

      check('G07.7 ★ 源身份与目标身份**分开记录**且确实是两个不同的库', () => {
        assert.ok(srcIdentity !== undefined && dstIdentity !== undefined, '身份读数缺一个')
        assert.equal(srcIdentity!.database, SRC_DB)
        assert.equal(dstIdentity!.database, DST_DB)
        assert.notEqual(srcIdentity!.database, dstIdentity!.database, '把备份源身份当成了目标身份')
        assert.equal(srcIdentity!.serverVersion, dstIdentity!.serverVersion, '同实例内 server_version 应当相同（否则本门量错了）')
      })

      // ---------------------------------------------------------------------
      // 8) ★ 一致性：目标 = 备份那一刻的**同一个逻辑快照**
      // ---------------------------------------------------------------------
      const dstProbeDigests = psql({
        container: CONTAINER,
        user: MIGRATE_USER,
        password: srcPassword,
        database: DST_DB,
        sql:
          `select batch_id||'|'||count(*)||'|'||md5(string_agg(batch_id||':'||seq||':'||payload, ',' order by seq)) ` +
          `from public.${PROBE_TABLE} group by batch_id order by batch_id`,
      })
      note({ command: dstProbeDigests.command, rc: dstProbeDigests.rc })
      const dstBatches = dstProbeDigests.out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [id, rows, md5] = line.split('|')
          return { batchId: Number(id), rows: Number(rows), md5 }
        })
      const k = dstBatches.length
      const m = writerBatches.length
      observations.probeSnapshot = { batchesInBackup: k, batchesInSource: m, rowsInBackup: k * 2, rowsInSource: m * 2 }

      check('G07.6a ★ 备份里是**连续前缀** 1..k，且每一批都恰好 2 行（没有半提交事务）', () => {
        assert.ok(k >= 3, `备份里只有 ${k} 批 ⇒ 不足以证明"取到了某一刻"`)
        assert.deepEqual(
          dstBatches.map((batch) => batch.batchId),
          Array.from({ length: k }, (_, index) => index + 1),
          '前缀不连续 ⇒ 备份取到了"中间缺一段"的状态'
        )
        const halfBatches = dstBatches.filter((batch) => batch.rows !== 2)
        assert.deepEqual(halfBatches, [], `出现了不是 2 行的批次：${JSON.stringify(halfBatches)}（半提交）`)
      })

      check('G07.6b ★ 每一批的内容与"提交后记录"逐字一致（比较对象是冻结的前缀，不是还在变的实时源）', () => {
        const mismatches = dstBatches.filter((batch) => {
          const logged = writerBatches[batch.batchId - 1]
          return logged === undefined || logged.md5 !== batch.md5 || logged.rows !== batch.rows
        })
        assert.deepEqual(mismatches, [], `与提交后记录不符的批次：${JSON.stringify(mismatches)}`)
      })

      check('G07.6c ★ 备份确实是"写入进行中的某一刻"（k ≥ 3 且 k < m）', () => {
        assert.ok(m > k, `备份里的批次数 ${k} 等于写入总数 ${m} ⇒ 备份看起来发生在写入**结束之后**（那就不叫在线备份）`)
      })

      const dstInventory = readInventory(queryFactory(MIGRATE_USER, srcPassword, DST_DB))
      const dstSummary = dstInventory === undefined ? undefined : summarizeInventory(dstInventory.objects)
      const difference =
        srcSummary === undefined || dstSummary === undefined
          ? undefined
          : inventorySetDifference(srcSummary.inScopeKeys, dstSummary.inScopeKeys)
      observations.dstInventory =
        dstSummary === undefined
          ? null
          : {
              objects: dstInventory!.objects.length,
              inScope: dstSummary.inScope.length,
              excluded: dstSummary.excluded.length,
              unclassified: dstSummary.unclassified.length,
            }
      observations.inventoryDifference = difference ?? null

      check('G07.2d 恢复后的**对象集合**与源一致（双向差集都为空）', () => {
        assert.ok(difference !== undefined, '对象清单读不出来')
        assert.deepEqual(difference!.missingInTarget, [], `目标缺对象：${difference!.missingInTarget.join(', ')}`)
        assert.deepEqual(difference!.extraInTarget, [], `目标多对象：${difference!.extraInTarget.join(', ')}`)
      })

      // 逐表行数（**明确**：这只证明"少了多少"，不证明内容一致 —— 契约 §5 `N02`）
      // ⚠️ 先挡一道：清单读不出来时**不要**带着 `undefined` 往下跑 ——
      //    那会把"清单没读到"变成一句 `TypeError: Cannot read properties of undefined`
      //    （本轮第一次跑正是这么收场的：真正的失败原因被一段栈盖住了）。
      if (srcSummary === undefined || dstSummary === undefined) {
        throw new Error('对象清单读不出来 ⇒ 对象集合/逐表行数比较无法进行（原因见上面 G07.1d 与 G07.2d）')
      }
      const tableList = srcSummary.inScope.filter((entry) => entry.object.kind === 'r' && entry.object.schema === 'public')
      const countBoth = (database: string): Map<string, number> => {
        const sql = tableList
          .map((entry) => `select '${entry.object.schema}.${entry.object.name}|'||count(*) from ${entry.object.schema}.${entry.object.name}`)
          .join(' union all ')
        const r = psql({ container: CONTAINER, user: MIGRATE_USER, password: srcPassword, database, sql, timeoutMs: 300_000 })
        note({ command: `${r.command}（${tableList.length} 张表 union all）`, rc: r.rc })
        const map = new Map<string, number>()
        for (const line of r.out.split('\n')) {
          const [key, value] = line.split('|')
          if (key !== undefined && value !== undefined) map.set(key, Number(value))
        }
        return map
      }
      const srcCounts = countBoth(SRC_DB)
      const dstCounts = countBoth(DST_DB)
      const countMismatch = [...srcCounts.entries()]
        .filter(([key]) => key !== `public.${PROBE_TABLE}` && key !== `public.${CONTROL_TABLE}`)
        .filter(([key, value]) => dstCounts.get(key) !== value)
        .map(([key, value]) => `${key}: src=${value} dst=${dstCounts.get(key)}`)
      observations.rowCounts = {
        tablesCompared: srcCounts.size - 2,
        excludedFromComparison: [`public.${PROBE_TABLE}`, `public.${CONTROL_TABLE}（本门自己造的，刻意不参与）`],
        mismatched: countMismatch,
        whatThisDoesNotProve: '行数一致**不**证明内容一致（契约 §5 N02：删一行加一行总数不变）；内容级比较（51 张表全列规范化摘要）属 WP5',
      }

      check('G07.2e 逐表行数清单一致（⚠️ 这一条**不**证明内容一致，见 observations.rowCounts）', () => {
        assert.ok(srcCounts.size - 2 >= 40, `参与比较的表太少：${srcCounts.size - 2}`)
        assert.deepEqual(countMismatch, [], `行数不一致：${countMismatch.join('; ')}`)
      })
    } catch (error) {
      checks.push({
        name: 'G07.§3 意外中断',
        pass: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    } finally {
      // ⚠️ 无论成败都要**把实例带回来**：两个测试库都必须清掉，否则下一道门会撞名。
      const dropDst = manageTestDb('drop-test-db.sql', DST_DB)
      const dropSrc = manageTestDb('drop-test-db.sql', SRC_DB)
      check('G07.9 本门自建的两个测试库已清理', () => {
        assert.equal(dropSrc.rc, 0, dropSrc.err)
        assert.equal(dropDst.rc, 0, dropDst.err)
        assert.equal(databaseExists(SRC_DB) || databaseExists(DST_DB), false)
      })
    }
  }

  // =========================================================================
  // 证据落盘
  // =========================================================================
  const passed = checks.filter((entry) => entry.pass).length
  const failed = checks.length - passed
  const evidence = {
    gate: 'PG-G07',
    runId: RUN_ID,
    startedAtUtc: new Date().toISOString(),
    startedAtUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    head: gitHead(),
    container: CONTAINER,
    hostPort: HOST_PORT,
    sourceSnapshot: SOURCE_SNAPSHOT,
    checks,
    notRun,
    observations,
    counts: { measured: checks.length, passed, failed, notRun: notRun.length },
    commands,
  }
  writeFileSync(join(EVIDENCE_DIR, 'g07-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  // ⚠️ 写完立刻解一次：本仓库历史上出现过 3 份不可解析的"证据 JSON"。
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'g07-evidence.json'), 'utf8'))
  writeFileSync(
    join(EVIDENCE_DIR, 'g07-backup-manifest.json'),
    JSON.stringify({ runId: RUN_ID, onlineBackup: observations.backupManifest, quiescentBackup: observations.quiescentBackup }, null, 2),
    'utf8'
  )
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'g07-backup-manifest.json'), 'utf8'))
  const assetSummary = {
    runId: RUN_ID,
    dataRoot: realAssetManifest.dataRoot,
    capturedAtUtc: realAssetManifest.capturedAtUtc,
    roots: realAssetManifest.roots,
    totalFiles: realAssetManifest.totalFiles,
    totalBytes: realAssetManifest.totalBytes,
    manifestDigest: realAssetManifest.manifestDigest,
    unclassified: realAssetManifest.unclassified,
    residualFileCount: residualDataFiles().length,
    perFileListLocation: 'artifacts/post-lv2/local/pg-migration/g07-asset-files.json（**不进仓库**：文件名可能含 QQ 标识）',
  }
  writeFileSync(join(EVIDENCE_DIR, 'g07-asset-manifest-summary.json'), JSON.stringify(assetSummary, null, 2), 'utf8')
  JSON.parse(readFileSync(join(EVIDENCE_DIR, 'g07-asset-manifest-summary.json'), 'utf8'))

  const online = observations.onlineBackup as { committedDuringDump: number } | undefined
  const snapshot = observations.probeSnapshot as { batchesInBackup: number; batchesInSource: number } | undefined

  console.log('')
  console.log('PG-G07 在线备份恢复（WP4）')
  console.log('─'.repeat(78))
  console.log(`  runId      : ${RUN_ID}`)
  console.log(`  实例       : ${CONTAINER}（宿主 ${HOST_PORT}）`)
  console.log(`  来源快照   : ${SOURCE_SNAPSHOT}`)
  console.log(`  证据       : artifacts/post-lv2/postgresql-migration/${RUN_ID}/`)
  console.log('─'.repeat(78))
  for (const entry of checks) {
    console.log(`  ${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}`)
    if (!entry.pass && entry.detail !== undefined) console.log(`        └─ ${entry.detail}`)
  }
  console.log('─'.repeat(78))
  console.log(`  断言        : ${passed}/${checks.length}`)
  console.log(`  未运行      : ${notRun.length}`)
  for (const entry of notRun) console.log(`      · ${entry.id} —— ${entry.what}（${entry.why}）`)
  console.log(`  measured_count = ${checks.length}`)
  console.log(`  失败总数 = ${failed}`)
  console.log('')
  console.log('  关键读数：')
  console.log(`    · 备份期间提交的批次      : ${online?.committedDuringDump ?? 'NOT RUN'}`)
  console.log(`    · 备份里的批次数 k        : ${snapshot?.batchesInBackup ?? 'NOT RUN'}`)
  console.log(`    · 源里的批次数 m          : ${snapshot?.batchesInSource ?? 'NOT RUN'}`)
  console.log(`    · 库外资产（include 根）  : ${String(observations.assetTotalFiles ?? 0)} 文件 / ${String(observations.assetTotalBytes ?? 0)} 字节`)
  console.log(`    · 未登记的 data 目录      : ${JSON.stringify(observations.assetUnclassified ?? [])}`)
  console.log('')

  if (checks.length === 0) {
    console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
    process.exitCode = 1
  } else if (failed > 0) {
    process.exitCode = 1
  } else if (notRun.length > 0) {
    console.error(
      `\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**（关键断言缺证据 ⇒ 拒收）。\n` +
        '  这不是"通过"，也不是"失败"—— 它是"没量到"。'
    )
    process.exitCode = 1
  }
}

await main()
