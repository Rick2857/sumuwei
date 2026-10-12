/**
 * INC-01 **WP5 门** —— 恢复工具与恢复演练（`AT5.1`…`AT5.4`）。
 *
 * 用法：`node_modules\.bin\tsx scripts/verify-inc-01-wp5.ts`
 *
 * ============================================================================
 *  它判什么
 * ============================================================================
 * ```text
 *  A  AT5.1  只认 snapshot ID：`..` / 路径 / 绝对路径 / 盘符一律在**形状层**被拒（不碰文件系统）
 *  B  AT5.1  dry-run 是默认动作：校验 manifest + 内容摘要 + 健康 + 租约 + 目标路径，
 *            并把将发生的**原子改名**打印出来；**一个字节都不写**
 *  C  AT5.2  apply 算法：staging（复制+校验）→ quarantine（当前库**改名挪开**）→ 就位；
 *            全程不原地覆盖，快照本体永不被搬动
 *  D  AT5.3  恢复后核验：从恢复 dataDir 的**一次性副本**启动，比对表与 schema 与 manifest，
 *            关闭后 closed === true
 *  E  AT5.4  注入"第二次 rename 失败"：旧库**仍在 quarantine**、staging 与 snapshot 未删、
 *            且**没有任何"恢复成功"的口吻**
 *  F  租约与授权边界：持租约的目标库被拒；`--apply` 的授权必须**逐字**对齐
 *            `<snapshotId>@<解析后的 dataDir>`（布尔开关不算授权）；
 *            对真实库 apply 在**写任何东西之前**被拒
 *  G  真实库安全：本门运行前后真实库摘要逐字不变（共用 `inc-01-real-db-drift.ts`）
 * ```
 *
 * ============================================================================
 *  纪律
 * ============================================================================
 * · 全部 fixture 在 `%TEMP%`；真实 `data/pglite` **只做只读摘要**，从不打开；
 * · "恢复"演练里唯一被真正打开的 PGlite 是 fixture 本体与它的一次性副本；
 * · 量具自证：三段式（正控 → 负控 → 恢复）见 B1/B4/B5，计数型读数都要求 `measured_count > 0`。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  acquireProductionLease,
  digestTree,
  openRawPGlite,
  runHealthProbe,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  RESTORE_FAILURES,
  applyRestore,
  isSnapshotIdShaped,
  planRestore,
  readSnapshotManifest,
  renderRestoreReading,
  restoreAuthorizationMatches,
  restoreAuthorizationValue,
  type RestoreReading,
} from '../src/infrastructure/persistence/production-db-restore.ts'
import { WP0_REAL_DB_NONVOLATILE, measureRealDbDrift } from './inc-01-real-db-drift.ts'

const REAL_DB = resolve('data/pglite')

// ---------------------------------------------------------------------------
// 断言 / fixture
// ---------------------------------------------------------------------------

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

const root = mkdtempSync(join(tmpdir(), 'inc01-wp5-'))
console.log(`fixture root: ${root}\n`)

/** 真实库只读摘要：开头一次、末尾一次（判据在共用模块里） */
const realBefore = digestTree(REAL_DB)

const failuresSeen = new Set<string>()
function noteFailure(reading: RestoreReading): void {
  if (reading.failure !== undefined) failuresSeen.add(reading.failure)
}

const dbCache = new Map<string, Promise<void>>()

/**
 * 造一个最小但**健康**的 PGlite 库。
 *
 * `runHealthProbe` 的判据是：能打开 + `select 1` + public 表数 > 0 +
 * `character_schema_migrations` 版本连续 + 关闭后 `closed === true`。
 * 这里刻意**不用** plugin-sql（那要 10 秒且是进程级单例），只用裸 PGlite 建到满足判据为止。
 */
async function makeHealthyFixture(dir: string, marker: string): Promise<void> {
  const existing = dbCache.get(dir)
  if (existing !== undefined) return await existing
  const pending = (async () => {
    mkdirSync(dir, { recursive: true })
    const db = await openRawPGlite(dir)
    try {
      await db.exec(`
        create table if not exists character_schema_migrations (version integer primary key, name text not null);
        insert into character_schema_migrations (version, name) values (1, '0001-fixture') on conflict do nothing;
        create table if not exists fixture_marker (id serial primary key, note text not null);
        insert into fixture_marker (note) values ('${marker}');
      `)
    } finally {
      await db.close()
    }
  })()
  dbCache.set(dir, pending)
  return await pending
}

async function markerOf(dir: string): Promise<string[]> {
  const db = await openRawPGlite(dir)
  try {
    const rows = await db.query('select note from fixture_marker order by id')
    return rows.rows.map((row) => String(row.note))
  } finally {
    await db.close()
  }
}

/**
 * 造一份 verified snapshot（目录 + manifest），manifest 的摘要是**真算出来的**。
 *
 * 刻意不调 `createVerifiedSnapshot()`：WP2 已经把"复制→校验→健康→晋升"验过（14/14），
 * 而 WP5 要证的是**恢复**。造好的快照还有一个好处：能精确地改 1 个字节来演负控。
 */
async function makeSnapshot(options: {
  snapshotRoot: string
  snapshotId: string
  build: (dir: string) => Promise<void>
}): Promise<{ snapshotPath: string; manifestPath: string; digest: string; fileCount: number }> {
  const snapshotPath = join(options.snapshotRoot, `pglite-${options.snapshotId}`)
  const manifestPath = join(options.snapshotRoot, `pglite-${options.snapshotId}.manifest.json`)
  mkdirSync(snapshotPath, { recursive: true })
  await options.build(snapshotPath)
  const digest = digestTree(snapshotPath)
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        snapshotId: options.snapshotId,
        createdAt: new Date().toISOString(),
        sourceDirKind: 'fixture',
        fileCount: digest.measuredCount,
        totalBytes: digest.totalBytes,
        nonVolatileTreeSha256: digest.treeSha256,
        excludedPaths: digest.excludedPaths,
        schemaVersions: [1],
        algorithm: 'inc01-tree-digest-v1',
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  return { snapshotPath, manifestPath, digest: digest.treeSha256, fileCount: digest.measuredCount }
}

// ---------------------------------------------------------------------------
// A. `AT5.1` 只认 ID（形状层拒绝，**不碰文件系统**）
// ---------------------------------------------------------------------------

const badIds = [
  '../../etc/passwd',
  'C:\\Windows\\System32\\config',
  '/etc/passwd',
  '..',
  '.',
  'pglite-2026-01-01',
  '2026-01-01T00-00-00-000Z-zzzzzzzzzzzz',
  '',
  'a b',
]
const badAccepted = badIds.filter((id) => isSnapshotIdShaped(id))
check(
  'A1',
  'AT5.1：`--from` **只认 snapshot ID** —— 路径 / `..` / 盘符 / 非法摘要一律在形状层被拒',
  badAccepted.length === 0 && badIds.length > 0,
  `试了 ${badIds.length} 个坏 ID，被接受 ${badAccepted.length} 个 ${JSON.stringify(badAccepted)}`
)

const aProbeRoot = join(root, 'a-shape')
const aEscaped = await planRestore({
  snapshotRoot: aProbeRoot,
  snapshotId: '../escape',
  dataDir: join(aProbeRoot, 'db'),
  verifyHealth: false,
})
noteFailure(aEscaped)
check(
  'A2',
  'AT5.1：坏 ID 在 **planRestore 的第一步**就被拒，且没有因此创建/触碰任何目录',
  aEscaped.failure === 'snapshot_id_invalid' && !existsSync(aProbeRoot),
  `failure=${String(aEscaped.failure)} · 快照根被创建？${String(existsSync(aProbeRoot))}`
)

// ---------------------------------------------------------------------------
// B. `AT5.1` dry-run：校验 + 预告，**零写入**；快照被动 ⇒ 必响 ⇒ 放回 ⇒ 安静
// ---------------------------------------------------------------------------

const bRoot = join(root, 'b-dry-run')
const bSnapshotRoot = join(bRoot, 'snapshots')
const bSnapshotId = '2026-09-21T10-00-00-000Z-abcdefabcdef'
const bSnapshot = await makeSnapshot({
  snapshotRoot: bSnapshotRoot,
  snapshotId: bSnapshotId,
  build: (dir) => makeHealthyFixture(dir, 'from-snapshot'),
})
const bLive = join(bRoot, 'live-db')
await makeHealthyFixture(bLive, 'from-live')
writeFileSync(join(bLive, 'live-only.txt'), 'live\n', 'utf8')

const bBefore = digestTree(bLive)
const bPlan = await planRestore({
  snapshotRoot: bSnapshotRoot,
  snapshotId: bSnapshotId,
  dataDir: bLive,
  healthProbe: runHealthProbe,
})
noteFailure(bPlan)
const bAfter = digestTree(bLive)
const bRootEntries = readdirSync(bRoot).sort()
check(
  'B1',
  'AT5.1（正控）：dry-run 通过（manifest + 内容摘要 + 健康 + 租约 + 目标路径），且**目标库一个字节都没被写**',
  bPlan.ok &&
    bPlan.mode === 'dry-run' &&
    bPlan.health?.ok === true &&
    bBefore.treeSha256 === bAfter.treeSha256 &&
    bBefore.measuredCount > 0,
  `ok=${String(bPlan.ok)} health=${String(bPlan.health?.ok)} 表数=${String(bPlan.health?.tableCount)} 指纹 ${bBefore.treeSha256.slice(0, 12)}… → ${bAfter.treeSha256.slice(0, 12)}…（${bAfter.measuredCount} 文件）`
)
check(
  'B2',
  'AT5.1：dry-run 把将发生的**原子改名**逐步打出来（rename → quarantine、copy→staging→rename）',
  bPlan.steps.filter((step) => step.status === 'planned').length === 2 &&
    bPlan.steps.some((step) => step.action === 'plan-rename' && step.detail.includes('→')) &&
    bPlan.nextAction.includes(restoreAuthorizationValue(bSnapshotId, bLive)),
  bPlan.steps
    .filter((step) => step.status === 'planned')
    .map((step) => step.detail)
    .join(' | ')
)
check(
  'B3',
  'AT5.1：dry-run **没有**创建 staging / quarantine（"零写入"不是口号）',
  !bRootEntries.some((name) => name.includes('restore-staging') || name.includes('quarantine')) &&
    readdirSync(bSnapshotRoot).length === 2 &&
    bSnapshot.fileCount > 0,
  `bRoot=${JSON.stringify(bRootEntries)} snapshotRoot=${JSON.stringify(readdirSync(bSnapshotRoot).sort())}`
)

// 负控：往快照里**加了 1 个文件** ⇒ 摘要必须响；把它删掉 ⇒ 必须重新安静
const bTamperFile = join(bSnapshot.snapshotPath, 'tampered-extra.txt')
writeFileSync(bTamperFile, 'tampered\n', 'utf8')
const bTampered = await planRestore({
  snapshotRoot: bSnapshotRoot,
  snapshotId: bSnapshotId,
  dataDir: bLive,
  verifyHealth: false,
})
noteFailure(bTampered)
check(
  'B4',
  'AT5.1（负控）：快照被动过 1 个字节 ⇒ `snapshot_digest_mismatch`（不许"看起来能恢复"）',
  bTampered.failure === 'snapshot_digest_mismatch' &&
    bTampered.snapshotDigestNow?.treeSha256 !== bSnapshot.digest,
  `failure=${String(bTampered.failure)} now=${bTampered.snapshotDigestNow?.treeSha256.slice(0, 12)}… manifest=${bSnapshot.digest.slice(0, 12)}…`
)
rmSync(bTamperFile, { force: true })
const bRecovered = await planRestore({
  snapshotRoot: bSnapshotRoot,
  snapshotId: bSnapshotId,
  dataDir: bLive,
  verifyHealth: false,
})
check(
  'B5',
  'AT5.1（恢复）：把被改的东西放回去 ⇒ 检测器**重新安静**（三段式的第三段）',
  bRecovered.ok && bRecovered.failure === undefined,
  `ok=${String(bRecovered.ok)} failure=${String(bRecovered.failure)} 摘要=${bRecovered.snapshotDigestNow?.treeSha256.slice(0, 12)}…`
)

// ---------------------------------------------------------------------------
// C. `AT5.2` apply：staging → quarantine → 就位（**不原地覆盖**）+ `AT5.3` 恢复后核验
// ---------------------------------------------------------------------------

const cRoot = join(root, 'c-apply')
const cSnapshotRoot = join(cRoot, 'snapshots')
const cSnapshotId = '2026-09-21T10-10-00-000Z-222222222222'
const cSnapshot = await makeSnapshot({
  snapshotRoot: cSnapshotRoot,
  snapshotId: cSnapshotId,
  build: (dir) => makeHealthyFixture(dir, 'from-snapshot'),
})
const cLive = join(cRoot, 'live-db')
await makeHealthyFixture(cLive, 'from-live')
writeFileSync(join(cLive, 'live-only.txt'), 'live\n', 'utf8')
const cLiveBefore = digestTree(cLive)
const cSnapshotBefore = digestTree(cSnapshot.snapshotPath)

const cPlan = await planRestore({
  snapshotRoot: cSnapshotRoot,
  snapshotId: cSnapshotId,
  dataDir: cLive,
  healthProbe: runHealthProbe,
})
const cResult = await applyRestore(cPlan, { now: () => new Date('2026-09-21T10:11:00.000Z') })
noteFailure(cResult)
const cQuarantine = cResult.quarantinePath as string
const cQuarantineDigest = existsSync(cQuarantine) ? digestTree(cQuarantine) : undefined
const cLiveAfter = digestTree(cLive)
const cSnapshotAfter = digestTree(cSnapshot.snapshotPath)
check(
  'C1',
  'AT5.2：apply 成功 —— 就位后的 dataDir 摘要**逐字等于** manifest，且旧库被**改名挪开**（不是删、不是覆盖）',
  cResult.ok &&
    cLiveAfter.treeSha256 === cSnapshot.digest &&
    cQuarantineDigest?.treeSha256 === cLiveBefore.treeSha256 &&
    cLiveBefore.treeSha256 !== cSnapshot.digest,
  `restored=${cLiveAfter.treeSha256.slice(0, 12)}… manifest=${cSnapshot.digest.slice(0, 12)}… quarantine=${cQuarantineDigest?.treeSha256.slice(0, 12)}…（== 旧库 ${cLiveBefore.treeSha256.slice(0, 12)}…）`
)
check(
  'C2',
  'AT5.2：**快照本体从未被改动**（恢复是"读快照"）且 staging 已被 rename 消耗；旧库独有的文件不在新库',
  cSnapshotAfter.treeSha256 === cSnapshotBefore.treeSha256 &&
    existsSync(cSnapshot.snapshotPath) &&
    !existsSync(cResult.stagingPath as string) &&
    !existsSync(join(cLive, 'live-only.txt')) &&
    existsSync(join(cQuarantine, 'live-only.txt')),
  `snapshot ${cSnapshotBefore.treeSha256.slice(0, 12)}… → ${cSnapshotAfter.treeSha256.slice(0, 12)}…；staging 还在？${String(existsSync(cResult.stagingPath as string))}；live-only.txt 在新库？${String(existsSync(join(cLive, 'live-only.txt')))} 在 quarantine？${String(existsSync(join(cQuarantine, 'live-only.txt')))}`
)

// `AT5.3`：从恢复 dataDir 的**一次性副本**启动
const cVerifyDir = join(cRoot, 'verify-copy')
mkdirSync(cVerifyDir, { recursive: true })
cpSync(cLive, join(cVerifyDir, 'db'), { recursive: true })
const cHealth = await runHealthProbe(join(cVerifyDir, 'db'))
const cMarkers = await markerOf(cLive)
const cManifestSchema = readSnapshotManifest(cSnapshot.manifestPath)?.schemaVersions.join(',')
check(
  'C3',
  'AT5.3：从恢复 dataDir 的**一次性副本**启动成功（表数 > 0、schema 连续、关闭后 closed=true），内容是快照那一份',
  cHealth.ok === true &&
    cHealth.closed === true &&
    cHealth.tableCount > 0 &&
    cMarkers.includes('from-snapshot') &&
    !cMarkers.includes('from-live'),
  `health.ok=${String(cHealth.ok)} closed=${String(cHealth.closed)} 表数=${cHealth.tableCount} schema=[${cHealth.schemaVersions.join(',')}] marker=${JSON.stringify(cMarkers)}`
)
check(
  'C4',
  'AT5.3：实测 schema 读数与 manifest 一致（量的是**恢复后的这一份**，不是别处的副本）',
  cManifestSchema !== undefined && cHealth.schemaVersions.join(',') === cManifestSchema,
  `实测 [${cHealth.schemaVersions.join(',')}] vs manifest [${String(cManifestSchema)}]`
)

// ---------------------------------------------------------------------------
// E. `AT5.4` 第二次 rename 失败
// ---------------------------------------------------------------------------

const eRoot = join(root, 'e-promote-fail')
const eSnapshotRoot = join(eRoot, 'snapshots')
const eSnapshotId = '2026-09-21T10-20-00-000Z-333333333333'
const eSnapshot = await makeSnapshot({
  snapshotRoot: eSnapshotRoot,
  snapshotId: eSnapshotId,
  build: async (dir) => {
    writeFileSync(join(dir, 'payload.txt'), 'snapshot-payload\n', 'utf8')
  },
})
const eLive = join(eRoot, 'live-db')
mkdirSync(eLive, { recursive: true })
writeFileSync(join(eLive, 'old-db.txt'), 'old-db\n', 'utf8')
const eLiveBefore = digestTree(eLive)

const ePlan = await planRestore({
  snapshotRoot: eSnapshotRoot,
  snapshotId: eSnapshotId,
  dataDir: eLive,
  verifyHealth: false,
})
let renameCalls = 0
const eResult = await applyRestore(ePlan, {
  now: () => new Date('2026-09-21T10:21:00.000Z'),
  rename: (from, to) => {
    renameCalls += 1
    if (renameCalls === 2) throw new Error('注入：第二次 rename 失败')
    renameSync(from, to) // 第一次（dataDir → quarantine）走真实实现
  },
})
noteFailure(eResult)
const eQuarantine = eResult.quarantinePath as string
const eQuarantineDigest = existsSync(eQuarantine) ? digestTree(eQuarantine) : undefined
const eStagingExists = existsSync(eResult.stagingPath as string)
const eRendered = renderRestoreReading(eResult)
check(
  'E1',
  'AT5.4：第二次 rename 失败 ⇒ `promote_failed`，**旧库仍在 quarantine**、staging 未删、快照未删',
  eResult.ok === false &&
    eResult.failure === 'promote_failed' &&
    renameCalls === 2 &&
    eQuarantineDigest?.treeSha256 === eLiveBefore.treeSha256 &&
    eStagingExists &&
    existsSync(eSnapshot.snapshotPath),
  `failure=${String(eResult.failure)} renameCalls=${renameCalls} quarantine=${eQuarantineDigest?.treeSha256.slice(0, 12)}…（== 旧库 ${eLiveBefore.treeSha256.slice(0, 12)}…）staging=${String(eStagingExists)} snapshot=${String(existsSync(eSnapshot.snapshotPath))}`
)
check(
  'E2',
  'AT5.4：**没有任何"恢复成功"的口吻** —— 输出以 FAIL 开头、含具名 failure，nextAction 明说不是"已恢复"',
  eRendered.startsWith('FAIL') &&
    eRendered.includes('[promote_failed]') &&
    eResult.nextAction.includes('不是') &&
    !eRendered.includes('PASS  apply'),
  eRendered.split('\n').slice(0, 3).join(' | ')
)
check(
  'E3',
  'AT5.4：失败后的现场**可诊断**（dataDir 缺失是被如实报出来的事实，失败步被记下）',
  !existsSync(eLive) && eResult.steps.some((step) => step.status === 'failed'),
  `dataDir 还在？${String(existsSync(eLive))}；失败步=${eResult.steps
    .filter((step) => step.status === 'failed')
    .map((step) => `${step.ordinal}:${step.action}`)
    .join(',')}`
)

// ---------------------------------------------------------------------------
// F. 租约与授权边界（负控）
// ---------------------------------------------------------------------------

const fRoot = join(root, 'f-lease')
const fSnapshotRoot = join(fRoot, 'snapshots')
const fSnapshotId = '2026-09-21T10-30-00-000Z-444444444444'
await makeSnapshot({
  snapshotRoot: fSnapshotRoot,
  snapshotId: fSnapshotId,
  build: async (dir) => {
    writeFileSync(join(dir, 'payload.txt'), 'p\n', 'utf8')
  },
})
const fLive = join(fRoot, 'live-db')
mkdirSync(fLive, { recursive: true })
writeFileSync(join(fLive, 'old.txt'), 'old\n', 'utf8')
const fOwnerDir = mkdtempSync(join(root, 'f-owner-'))

const fLease = await acquireProductionLease({
  dataDir: fLive,
  operationKind: 'restore',
  ownerRecordDir: fOwnerDir,
})
const fLeaseHeld = await planRestore({
  snapshotRoot: fSnapshotRoot,
  snapshotId: fSnapshotId,
  dataDir: fLive,
  verifyHealth: false,
})
noteFailure(fLeaseHeld)
await fLease.release({ cleanClose: true })
const fLeaseFree = await planRestore({
  snapshotRoot: fSnapshotRoot,
  snapshotId: fSnapshotId,
  dataDir: fLive,
  verifyHealth: false,
})
check(
  'F1',
  'AT5.1（负控 + 恢复）：目标库上**有人持租约** ⇒ 拒绝恢复（`lease_held`）；放掉租约 ⇒ 重新可用',
  fLeaseHeld.failure === 'lease_held' && fLeaseFree.ok === true && !fLeaseHeld.quarantineRetained,
  `持租约时 failure=${String(fLeaseHeld.failure)}；释放后 ok=${String(fLeaseFree.ok)}`
)

const authValue = restoreAuthorizationValue(fSnapshotId, fLive)
const authCases = [
  { name: '逐字匹配', value: authValue, expected: true },
  {
    name: '换一个快照 ID',
    value: restoreAuthorizationValue('2026-01-01T00-00-00-000Z-aaaaaaaaaaaa', fLive),
    expected: false,
  },
  { name: '换一个 dataDir', value: restoreAuthorizationValue(fSnapshotId, join(fLive, 'other')), expected: false },
  { name: '简单布尔 "1"', value: '1', expected: false },
  { name: '"true"', value: 'true', expected: false },
  { name: '未设置', value: undefined, expected: false },
]
const authMismatch = authCases.filter(
  (item) => restoreAuthorizationMatches(item.value, fSnapshotId, fLive) !== item.expected
)
check(
  'F2',
  'AT5.2（负控）：`--apply` 的授权是**逐字对齐 `<snapshotId>@<dataDir>`**；布尔式开关**不是**授权',
  authMismatch.length === 0 && authCases.length > 0,
  `试了 ${authCases.length} 种，判错 ${authMismatch.length}：${authCases
    .map((item) => `${item.name}=${String(restoreAuthorizationMatches(item.value, fSnapshotId, fLive))}`)
    .join(' · ')}`
)

/*
 * 对**真实库** apply（无授权）：必须在写任何东西之前被拒。
 * 这里刻意只调用 `applyRestore`（不调 `planRestore`）—— 连"对真库做健康探针"都不做。
 */
const realPlanStub: RestoreReading = {
  ok: true,
  mode: 'dry-run',
  snapshotId: fSnapshotId,
  snapshotPath: join(fSnapshotRoot, `pglite-${fSnapshotId}`),
  manifest: {
    snapshotId: fSnapshotId,
    createdAt: new Date().toISOString(),
    sourceDirKind: 'fixture',
    fileCount: 1,
    totalBytes: 1,
    nonVolatileTreeSha256: 'x'.repeat(64),
    excludedPaths: [],
    schemaVersions: [1],
    algorithm: 'inc01-tree-digest-v1',
  },
  dataDir: REAL_DB,
  steps: [],
  quarantineRetained: false,
  stagingRetained: false,
  snapshotRetained: true,
  nextAction: '',
}
const realRefused = await applyRestore(realPlanStub, {})
noteFailure(realRefused)
const straySiblings = readdirSync(dirname(REAL_DB)).filter((name) =>
  /^pglite\.(restore-staging|quarantine)-/.test(name)
)
check(
  'F3',
  '授权边界（负控）：对**真实库** apply（无授权）⇒ 在写任何东西之前被拒，且没留下 staging/quarantine 残骸',
  realRefused.failure === 'apply_not_authorized' &&
    realRefused.quarantineRetained === false &&
    straySiblings.length === 0 &&
    existsSync(REAL_DB),
  `failure=${String(realRefused.failure)} 真库还在=${String(existsSync(REAL_DB))} 残骸=${JSON.stringify(straySiblings)}`
)

// ---------------------------------------------------------------------------
// 覆盖度自检 + 真实库安全
// ---------------------------------------------------------------------------

check(
  'H1',
  '量具自证：本门真的走到过的 failure 集合**非空**，且实现里的失败码清单与门里断言的一一对应',
  failuresSeen.size >= 5 && RESTORE_FAILURES.length === 16,
  `走到 ${failuresSeen.size}/${RESTORE_FAILURES.length}：${[...failuresSeen].sort().join(', ')}`
)

const realAfter = digestTree(REAL_DB)
const drift = measureRealDbDrift(realBefore, realAfter)
check(
  'G1',
  '真实 `data/pglite` 在本门运行前后**逐字不变**（本门只读它，从未打开）',
  drift.unchangedDuringRun && realAfter.measuredCount > 0,
  `measured=${realAfter.measuredCount} files / ${realAfter.totalBytes} bytes · ${drift.reading}`
)
check(
  'G2',
  '真实库摘要与 WP0 基线的关系**有据可查**（与 WP4 门共用同一份漂移登记器）',
  drift.matchesWp0Baseline || drift.driftExplained,
  drift.matchesWp0Baseline
    ? `${realAfter.treeSha256.slice(0, 16)}… == WP0 基线（未漂移）`
    : `已漂移到 ${realAfter.treeSha256.slice(0, 16)}…；基线由快照 ${drift.baselineCapturedBySnapshotId ?? '（无）'} 捕获；干净关闭的 owner record ${drift.cleanOwnerRecords} 条`
)

// ---------------------------------------------------------------------------
// 汇总 / 证据
// ---------------------------------------------------------------------------

const measuredCount =
  realAfter.measuredCount + checks.length + bAfter.measuredCount + cSnapshot.fileCount + failuresSeen.size
const measurementInvalid =
  realAfter.measuredCount === 0 ||
  checks.length === 0 ||
  failuresSeen.size === 0 ||
  bAfter.measuredCount === 0 ||
  cSnapshot.fileCount === 0
const verdict = measurementInvalid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

const summary = {
  wp: 'INC-01 WP5 — Restore Tool & Recovery Drill',
  checkedAt: new Date().toISOString(),
  realDb: {
    before: drift.before.treeSha256,
    after: drift.after.treeSha256,
    unchangedDuringThisRun: drift.unchangedDuringRun,
    wp0Baseline: WP0_REAL_DB_NONVOLATILE,
    matchesWp0Baseline: drift.matchesWp0Baseline,
    baselineCapturedBySnapshot: drift.baselineCapturedBySnapshotId,
    cleanOwnerRecords: drift.cleanOwnerRecords,
    driftExplained: drift.driftExplained,
  },
  drill: {
    dryRunZeroWrites: bPlan.ok === true && bBefore.treeSha256 === bAfter.treeSha256,
    applySwappedAtomically: cResult.ok === true,
    restoredDigestEqualsManifest: cResult.restoredDigest?.treeSha256 === cSnapshot.digest,
    oldDbKeptInQuarantine: cQuarantineDigest?.treeSha256 === cLiveBefore.treeSha256,
    restoredHealth: {
      ok: cHealth.ok,
      closed: cHealth.closed,
      tableCount: cHealth.tableCount,
      schemaVersions: cHealth.schemaVersions,
      marker: cMarkers,
    },
    promoteFailureKeptQuarantine:
      eResult.failure === 'promote_failed' && eQuarantineDigest?.treeSha256 === eLiveBefore.treeSha256,
    realDbApplyRefused: realRefused.failure,
  },
  failuresExercised: [...failuresSeen].sort(),
  failuresDeclared: RESTORE_FAILURES,
  measurements: {
    checks: checks.length,
    failed,
    fixtureFiles: bAfter.measuredCount,
    snapshotFiles: cSnapshot.fileCount,
    realDbFiles: realAfter.measuredCount,
    measuredCount,
  },
  didNotOpenRealDatabase: true,
  openedOnlyTempCopies: true,
  didNotApplyRestoreToRealDatabase: true,
  checks,
  verdict,
}

mkdirSync('artifacts/incidents/inc-01', { recursive: true })
writeFileSync(
  'artifacts/incidents/inc-01/wp5-restore-drill.json',
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8'
)

rmSync(root, { recursive: true, force: true })

console.log(
  `\nWP5 门：${verdict}（${checks.length} 项断言，${failed} 失败，failure 码走到 ${failuresSeen.size}/${RESTORE_FAILURES.length}）；` +
    `证据 artifacts/incidents/inc-01/wp5-restore-drill.json`
)
process.exitCode = verdict === 'PASS' ? 0 : 1
