/**
 * INC-01 **WP2 门** —— 已验证快照流水线（`AT2.1`…`AT2.5`）。
 *
 * 用法：`node_modules\.bin\tsx scripts/verify-inc-01-wp2.ts`
 *
 * 判据：
 *   P  正控：复制→校验→晋升成功；manifest 可独立复算；retention 保留最近 3 份
 *   N1 复制中源被改      ⇒ `source_changed_during_copy`，不晋升
 *   N2 staging 被改 1 字节 ⇒ `copy_digest_mismatch`，不晋升
 *   N3 验证副本不可启动    ⇒ `snapshot_health_failed`，**旧 verified snapshot 保持不变**
 *   N4 空源               ⇒ `MEASUREMENT INVALID`（不返回"全部一致"）
 *   N5 快照路径与源重叠    ⇒ 拒绝
 *   N6 retention 目标逃出 root ⇒ 拒绝且零删除
 *   N7 close 后 `closed=false` ⇒ 验证失败，不晋升
 *   N8 租约与源不一致      ⇒ `snapshot_lease_not_held`
 *
 * **本门不打开真实库、不运行真实 `db:snapshot`**；所有 fixture 都在 `%TEMP%`。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  acquireProductionLease,
  assertInsideRoot,
  createVerifiedSnapshot,
  digestTree,
  openRawPGlite,
  pruneSnapshots,
  type HealthProbeResult,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import { measureRealDbDrift } from './inc-01-real-db-drift.ts'

const REAL_DB = resolve('data/pglite')
const WP0_REAL_DB_NONVOLATILE =
  'be957694b8a1173aa3da49e8b942fc1e69ddaab1cb5971a6bd5c00863555c500'

interface Check {
  id: string
  desc: string
  pass: boolean
  reading: string
}
const checks: Check[] = []
let failed = 0
function check(id: string, desc: string, pass: boolean, reading: string): void {
  checks.push({ id, desc, pass, reading })
  if (!pass) failed += 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}\n        ${reading}`)
}

const root = mkdtempSync(join(tmpdir(), 'inc01-wp2-'))
const ownerDir = join(root, 'owners')
const template = join(root, 'template-db')
mkdirSync(ownerDir, { recursive: true })

/** 造一个**合成**的有效库：有 public 表，且 character_schema_migrations 版本连续 */
async function buildFixtureDb(dir: string, versions: number[]): Promise<void> {
  const db = await openRawPGlite(dir)
  await db.exec(
    `create table if not exists character_schema_migrations (
       version integer primary key,
       name text not null,
       applied_at bigint not null
     )`
  )
  await db.exec(`create table if not exists conversation_events (id text primary key, content text not null)`)
  for (const version of versions) {
    await db.query(
      `insert into character_schema_migrations (version, name, applied_at) values (${version}, 'm${version}', 1)`
    )
  }
  await db.close()
}

function freshSource(name: string): string {
  const dir = join(root, name, 'source')
  mkdirSync(dirnameOf(dir), { recursive: true })
  cpSync(template, dir, { recursive: true })
  return dir
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf(separator()))
}
function separator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function listSnapshots(snapshotRoot: string): string[] {
  if (!existsSync(snapshotRoot)) return []
  return readdirSync(snapshotRoot)
    .filter((name) => name.startsWith('pglite-') && !name.endsWith('.manifest.json'))
    .sort()
}

const realDbBefore = digestTree(REAL_DB)
const evidence: Record<string, unknown> = {
  incident: 'INC-01',
  wp: 'WP2',
  generatedAt: new Date().toISOString(),
  fixtureKind: 'synthetic（直接 PGlite initdb + 建表；不使用生产库副本）',
  realDbBefore: { nonVolatileTreeSha256: realDbBefore.treeSha256, measuredCount: realDbBefore.measuredCount },
  tests: {},
}

try {
  await buildFixtureDb(template, [1, 2, 3])

  // -------------------------------------------------------------------------
  // P 正控
  // -------------------------------------------------------------------------
  const pSource = freshSource('p')
  const pRoot = join(root, 'p', 'snapshots')
  const pLease = await acquireProductionLease({
    dataDir: pSource,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const pResult = await createVerifiedSnapshot({
    sourceDir: pSource,
    snapshotRoot: pRoot,
    lease: pLease,
    disposableRoot: join(root, 'p', 'probe'),
    keep: 3,
  })
  const pManifest = pResult.manifest
  const recomputed =
    pResult.snapshotPath !== undefined ? digestTree(pResult.snapshotPath).treeSha256 : 'NO SNAPSHOT'
  check('P1', '正控：快照晋升成功', pResult.ok, `ok=${pResult.ok} failure=${String(pResult.failure)} id=${String(pResult.snapshotId)}`)
  check(
    'P2',
    'manifest 可独立复算：快照目录摘要 == manifest 记录值 == 源摘要',
    pManifest !== undefined &&
      recomputed === pManifest.nonVolatileTreeSha256 &&
      pManifest.nonVolatileTreeSha256 === pResult.sourceDigestBefore?.treeSha256,
    `manifest=${pManifest?.nonVolatileTreeSha256.slice(0, 16)}… recomputed=${recomputed.slice(0, 16)}… source=${pResult.sourceDigestBefore?.treeSha256.slice(0, 16)}…`
  )
  check(
    'P3',
    '健康探针读到连续迁移版本（证明是"有内容的库"，不是 initdb 出来的空库）',
    pResult.health?.ok === true && JSON.stringify(pResult.health.schemaVersions) === '[1,2,3]',
    `health=${JSON.stringify(pResult.health?.schemaVersions)} readings=${JSON.stringify(pResult.health?.readings)}`
  )
  check(
    'P4',
    'manifest 写在快照目录**之外**（写进去会改变快照自身摘要）',
    pResult.manifestPath !== undefined &&
      existsSync(pResult.manifestPath) &&
      !existsSync(join(pResult.snapshotPath ?? '', 'manifest.json')),
    `manifestPath=${String(pResult.manifestPath)}`
  )
  await pLease.release({ cleanClose: true })

  // retention：再晋升 3 份（共 4 份），keep=3 ⇒ 最旧那份被清
  const retentionIds: string[] = [String(pResult.snapshotId)]
  for (let i = 0; i < 3; i += 1) {
    const lease = await acquireProductionLease({
      dataDir: pSource,
      operationKind: 'manual_snapshot',
      ownerRecordDir: ownerDir,
    })
    const result = await createVerifiedSnapshot({
      sourceDir: pSource,
      snapshotRoot: pRoot,
      lease,
      disposableRoot: join(root, 'p', 'probe'),
      keep: 3,
      now: () => new Date(Date.now() + (i + 1) * 1000),
    })
    if (result.snapshotId !== undefined) retentionIds.push(result.snapshotId)
    await lease.release({ cleanClose: true })
  }
  const remaining = listSnapshots(pRoot)
  check(
    'P5',
    'retention：保留最近 3 份（第 4 份及更早被清），且新晋升的那份一定还在',
    remaining.length === 3 && remaining.includes(`pglite-${retentionIds[retentionIds.length - 1]}`),
    `剩余=${JSON.stringify(remaining)} 共晋升=${retentionIds.length}`
  )

  // -------------------------------------------------------------------------
  // N1 复制中源被改
  // -------------------------------------------------------------------------
  const n1Source = freshSource('n1')
  const n1Root = join(root, 'n1', 'snapshots')
  const n1Lease = await acquireProductionLease({
    dataDir: n1Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const n1 = await createVerifiedSnapshot({
    sourceDir: n1Source,
    snapshotRoot: n1Root,
    lease: n1Lease,
    disposableRoot: join(root, 'n1', 'probe'),
    afterCopy: ({ sourceDir }) => {
      writeFileSync(join(sourceDir, 'PG_VERSION'), '17-changed-during-copy\n', 'utf8')
    },
  })
  check(
    'N1',
    '复制中源被改 ⇒ source_changed_during_copy，且不晋升',
    n1.ok === false && n1.failure === 'source_changed_during_copy' && listSnapshots(n1Root).length === 0,
    `failure=${String(n1.failure)} 已晋升=${listSnapshots(n1Root).length}`
  )
  await n1Lease.release({ cleanClose: true })

  // -------------------------------------------------------------------------
  // N2 staging 被改 1 字节
  // -------------------------------------------------------------------------
  const n2Source = freshSource('n2')
  const n2Root = join(root, 'n2', 'snapshots')
  const n2Lease = await acquireProductionLease({
    dataDir: n2Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const n2 = await createVerifiedSnapshot({
    sourceDir: n2Source,
    snapshotRoot: n2Root,
    lease: n2Lease,
    disposableRoot: join(root, 'n2', 'probe'),
    afterCopy: ({ stagingDir }) => {
      const target = join(stagingDir, 'PG_VERSION')
      const original = readFileSync(target)
      const mutated = Buffer.from(original)
      mutated[0] = mutated[0] === 0x31 ? 0x32 : 0x31 // 同长度、改 1 字节
      writeFileSync(target, mutated)
    },
  })
  check(
    'N2',
    'staging 被改 1 字节 ⇒ copy_digest_mismatch，且不晋升',
    n2.ok === false && n2.failure === 'copy_digest_mismatch' && listSnapshots(n2Root).length === 0,
    `failure=${String(n2.failure)} 已晋升=${listSnapshots(n2Root).length}`
  )
  await n2Lease.release({ cleanClose: true })

  // -------------------------------------------------------------------------
  // N3 验证副本不可启动 ⇒ 旧 verified snapshot 保持不变
  // -------------------------------------------------------------------------
  const n3Source = freshSource('n3')
  const n3Root = join(root, 'n3', 'snapshots')
  const n3Lease = await acquireProductionLease({
    dataDir: n3Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const good = await createVerifiedSnapshot({
    sourceDir: n3Source,
    snapshotRoot: n3Root,
    lease: n3Lease,
    disposableRoot: join(root, 'n3', 'probe'),
  })
  await n3Lease.release({ cleanClose: true })
  const beforeN3 = listSnapshots(n3Root)
  const n3Lease2 = await acquireProductionLease({
    dataDir: n3Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const badHealth: HealthProbeResult = {
    ok: false,
    reason: 'health_probe_open_failed',
    closed: false,
    tableCount: 0,
    schemaVersions: [],
    readings: ['injected: unstartable copy'],
  }
  const n3 = await createVerifiedSnapshot({
    sourceDir: n3Source,
    snapshotRoot: n3Root,
    lease: n3Lease2,
    disposableRoot: join(root, 'n3', 'probe'),
    healthProbe: async () => badHealth,
  })
  const afterN3 = listSnapshots(n3Root)
  check(
    'N3',
    '健康验证失败 ⇒ snapshot_health_failed，且旧 verified snapshot 原样保留',
    good.ok &&
      n3.ok === false &&
      n3.failure === 'snapshot_health_failed' &&
      JSON.stringify(beforeN3) === JSON.stringify(afterN3),
    `failure=${String(n3.failure)} 旧快照 ${JSON.stringify(beforeN3)} → ${JSON.stringify(afterN3)}`
  )
  await n3Lease2.release({ cleanClose: true })

  // -------------------------------------------------------------------------
  // N4 空源 ⇒ MEASUREMENT INVALID
  // -------------------------------------------------------------------------
  const n4Source = join(root, 'n4', 'source')
  mkdirSync(n4Source, { recursive: true })
  const n4Lease = await acquireProductionLease({
    dataDir: n4Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const n4 = await createVerifiedSnapshot({
    sourceDir: n4Source,
    snapshotRoot: join(root, 'n4', 'snapshots'),
    lease: n4Lease,
    disposableRoot: join(root, 'n4', 'probe'),
  })
  check(
    'N4',
    '空源 ⇒ measured_count_zero（MEASUREMENT INVALID，不是 PASS）',
    n4.ok === false && n4.failure === 'measured_count_zero' && (n4.detail ?? '').includes('MEASUREMENT INVALID'),
    `failure=${String(n4.failure)} detail=${String(n4.detail)}`
  )
  await n4Lease.release({ cleanClose: true })

  // -------------------------------------------------------------------------
  // N5 快照路径与源重叠
  // -------------------------------------------------------------------------
  const n5Source = freshSource('n5')
  const n5Lease = await acquireProductionLease({
    dataDir: n5Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const n5 = await createVerifiedSnapshot({
    sourceDir: n5Source,
    snapshotRoot: join(n5Source, 'snapshots-inside-source'),
    lease: n5Lease,
    disposableRoot: join(root, 'n5', 'probe'),
  })
  check(
    'N5',
    '快照根位于源之内 ⇒ source_overlaps_snapshot_root（拒绝）',
    n5.ok === false && n5.failure === 'source_overlaps_snapshot_root',
    `failure=${String(n5.failure)} detail=${String(n5.detail)}`
  )
  await n5Lease.release({ cleanClose: true })

  // -------------------------------------------------------------------------
  // N6 retention 目标逃出 root ⇒ 拒绝且零删除
  // -------------------------------------------------------------------------
  let n6aPass = false
  let n6aReading = 'NO ERROR'
  try {
    assertInsideRoot(join(root, 'n6'), join(root, 'n6', '..', 'outside-please'))
  } catch (error) {
    n6aPass = true
    n6aReading = (error as Error).message
  }
  const n6Root = join(root, 'n6-root')
  mkdirSync(n6Root, { recursive: true })
  const n6Pruned = pruneSnapshots(n6Root, 3)
  check(
    'N6',
    'retention 逃逸路径被拒 + 不足 keep 份时零删除',
    n6aPass && n6Pruned.length === 0,
    `assertInsideRoot 拒绝=${n6aPass}（${n6aReading}）；pruneSnapshots(空 root, keep=3) 删除=${JSON.stringify(n6Pruned)}`
  )

  // -------------------------------------------------------------------------
  // N7 close 后 closed=false ⇒ 不晋升
  // -------------------------------------------------------------------------
  const n7Source = freshSource('n7')
  const n7Root = join(root, 'n7', 'snapshots')
  const n7Lease = await acquireProductionLease({
    dataDir: n7Source,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const n7 = await createVerifiedSnapshot({
    sourceDir: n7Source,
    snapshotRoot: n7Root,
    lease: n7Lease,
    disposableRoot: join(root, 'n7', 'probe'),
    healthProbe: async () => ({
      ok: false,
      reason: 'health_close_not_verified',
      closed: false,
      tableCount: 2,
      schemaVersions: [1, 2, 3],
      readings: ['injected: closed=false'],
    }),
  })
  check(
    'N7',
    'close 后 closed=false ⇒ 验证失败（health_close_not_verified），不晋升',
    n7.ok === false && n7.failure === 'snapshot_health_failed' && n7.detail === 'health_close_not_verified' && listSnapshots(n7Root).length === 0,
    `failure=${String(n7.failure)} detail=${String(n7.detail)} 已晋升=${listSnapshots(n7Root).length}`
  )
  await n7Lease.release({ cleanClose: true })

  // -------------------------------------------------------------------------
  // N8 租约与源不一致
  // -------------------------------------------------------------------------
  const n8Source = freshSource('n8')
  const n8Other = freshSource('n8').replace('source', 'source-other')
  mkdirSync(dirnameOf(n8Other), { recursive: true })
  cpSync(template, n8Other, { recursive: true })
  const n8Lease = await acquireProductionLease({
    dataDir: n8Other,
    operationKind: 'manual_snapshot',
    ownerRecordDir: ownerDir,
  })
  const n8 = await createVerifiedSnapshot({
    sourceDir: n8Source,
    snapshotRoot: join(root, 'n8', 'snapshots'),
    lease: n8Lease,
    disposableRoot: join(root, 'n8', 'probe'),
  })
  check(
    'N8',
    '租约指向的 dataDir 与源不一致 ⇒ snapshot_lease_not_held（不允许"无租约快照"）',
    n8.ok === false && n8.failure === 'snapshot_lease_not_held',
    `failure=${String(n8.failure)} detail=${String(n8.detail)}`
  )
  await n8Lease.release({ cleanClose: true })

  evidence.tests = Object.fromEntries(checks.map((c) => [c.id, { desc: c.desc, pass: c.pass, reading: c.reading }]))
} finally {
  rmSync(root, { recursive: true, force: true })
}

const realDbAfter = digestTree(REAL_DB)
/*
 * ⚠️ **2026-09-21 由 INC-01 WP6 更正判据（原文保留在上一条注释与 handoff 里）**：
 * 原来的判据是"前后相同 **且等于 WP0 冻结基线**"。后半句**当时就写错了** ——
 * 她的库是**会被合法打开**的（用户每聊一次都会改 `pg_control` / WAL），
 * 所以"永远等于基线"不是一个可持续的判据：合法使用一次之后它就永久变红。
 *
 * 现在拆成两条（与 WP4/WP5 共用 `scripts/inc-01-real-db-drift.ts` 的同一份实现）：
 *   ① 本门运行前后**逐字不变**（这才是"本门有没有碰真库"的判据）
 *   ② 与基线的关系按"**漂移有据**"判：必须有一份 captures 了改动前状态的 verified 快照
 *      + 一次 `cleanClose=true` 的 owner record
 * 判据**没有变松**：它从"一个会误报的红"换成了"能区分合法使用与静默改动的判据"。
 */
const drift = measureRealDbDrift(realDbBefore, realDbAfter)
check(
  'T-REAL',
  '本门未触碰真实库：前后非易失树摘要**逐字相同**（与 WP0 基线的关系按"漂移有据"判）',
  drift.unchangedDuringRun && (drift.matchesWp0Baseline || drift.driftExplained),
  drift.reading
)

const summary = {
  ...evidence,
  realDbAfter: { nonVolatileTreeSha256: realDbAfter.treeSha256, measuredCount: realDbAfter.measuredCount },
  realDbBaseline: {
    wp0Baseline: WP0_REAL_DB_NONVOLATILE,
    unchangedDuringRun: drift.unchangedDuringRun,
    matchesWp0Baseline: drift.matchesWp0Baseline,
    baselineCapturedBySnapshot: drift.baselineCapturedBySnapshotId ?? null,
    cleanOwnerRecords: drift.cleanOwnerRecords,
    driftExplained: drift.driftExplained,
  },
  checks,
  totals: { checks: checks.length, failed },
  verdict: failed === 0 ? 'PASS' : 'FAIL',
}
mkdirSync('artifacts/incidents/inc-01', { recursive: true })
writeFileSync('artifacts/incidents/inc-01/wp2-snapshot.json', JSON.stringify(summary, null, 2) + '\n', 'utf8')
console.log(`\nWP2 门：${summary.verdict}（${checks.length} 项断言，${failed} 失败）；证据 artifacts/incidents/inc-01/wp2-snapshot.json`)
process.exitCode = failed === 0 ? 0 : 1
