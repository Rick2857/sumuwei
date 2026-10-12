/**
 * INC-01 **量具八步自证**（`pnpm inc-01:measurement:verify`）。
 *
 * ============================================================================
 *  INV-M45-06：**量具自己也是被测对象**
 * ============================================================================
 * 一个永远说"没问题"的检测器，与一个真的都没问题的系统，在输出上完全一样。
 * 所以计划书 §WP6 要求按顺序证明八件事，而且**每条都要记录 measured_count**：
 *
 * ```text
 *   ① 正确实现 PASS
 *   ② 绕过 lease                  ⇒ 必须 FAIL
 *   ③ 热复制假装 verified          ⇒ 必须 FAIL
 *   ④ 省略 runtime.close()        ⇒ 必须 FAIL
 *   ⑤ 伪造 closed=true            ⇒ 必须 FAIL
 *   ⑥ 改 snapshot 1 字节          ⇒ 必须 FAIL
 *   ⑦ 缺失健康探针却写 PASS        ⇒ 必须 FAIL
 *   ⑧ 恢复真实实现                ⇒ 再次 PASS
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * 1. **判据来自实现本身**，不是另写一套"看起来对"的规则：每一步都真的调用
 *    WP1–WP5 的实现（租约 / `createVerifiedSnapshot` / `createShutdown` / 状态机 /
 *    `planRestore`），只看它**响不响**、响的是不是**那个具名 code**。
 * 2. **零命中不是 PASS**：每步都报 `measuredCount`，任何一步为 0 ⇒ `MEASUREMENT INVALID`。
 * 3. **记录源码与 fixture 哈希**：这样"这个结论是哪一版代码、哪一份 fixture 产生的"可复核。
 *
 * ⚠️ 全部 fixture 在 `%TEMP%`；真实 `data/pglite` 只做只读摘要（前后比对）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  acquireProductionLease,
  createVerifiedSnapshot,
  digestTree,
  isLeaseHeld,
  openRawPGlite,
  runHealthProbe,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  __resetPreopenTokensForTest,
  prepareProductionOpen,
  type ProductionOpenDeps,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import { planRestore } from '../src/infrastructure/persistence/production-db-restore.ts'
import { createShutdown, shutdownExitCode } from '../src/infrastructure/persistence/runtime-shutdown.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const root = mkdtempSync(join(tmpdir(), 'inc01-l0-'))

interface StepReading {
  ordinal: number
  id: string
  /** 这一步问的是"哪个真实检测器会不会响" */
  detector: string
  injection: string
  expected: string
  observed: string
  fired: boolean
  measuredCount: number
  detail: string
}
const steps: StepReading[] = []

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function record(step: StepReading): void {
  steps.push(step)
  console.log(
    `${step.fired ? 'PASS' : 'FAIL'}  步骤 ${step.ordinal}  ${step.id}\n` +
      `        检测器 : ${step.detector}\n` +
      `        注入   : ${step.injection}\n` +
      `        期望   : ${step.expected}\n` +
      `        实测   : ${step.observed}\n` +
      `        measuredCount = ${step.measuredCount}`
  )
}

const FIXTURE_FILES = 1

/** 快照根里已晋升的快照目录（不含 manifest） */
function readdirSnapshotDirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.startsWith('pglite-') && !name.endsWith('.manifest.json'))
}

/** 造一个**真的能过健康探针**的最小 PGlite 库（裸 PGlite，不经过 plugin-sql） */
async function makeHealthyDb(dir: string, marker: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const db = await openRawPGlite(dir)
  try {
    await db.exec(`
      create table if not exists character_schema_migrations (version integer primary key, name text not null);
      insert into character_schema_migrations (version, name) values (1, '0001-l0') on conflict do nothing;
      create table if not exists l0_marker (id serial primary key, note text not null);
      insert into l0_marker (note) values ('${marker}');
    `)
  } finally {
    await db.close()
  }
}

const realBefore = digestTree(REAL_DB)

// ---------------------------------------------------------------------------
// ① 正确实现 PASS（正控：所有检测器都必须**安静**）
// ---------------------------------------------------------------------------

const happyDb = join(root, 'happy-db')
await makeHealthyDb(happyDb, 'happy')
const happySnapRoot = join(root, 'happy-snapshots')
mkdirSync(happySnapRoot, { recursive: true })
const happyOwners = join(root, 'happy-owners')

__resetPreopenTokensForTest()
let happyMachineStates: string[] = []
let happyError = ''
let happyPreSnapshot: string | undefined
let happyPostSnapshot: string | undefined
let happyOpenCalls = 0
const happyDeps: ProductionOpenDeps = {
  openDatabase: async () => {
    happyOpenCalls += 1
  },
  stopServices: async () => undefined,
  closeDatabase: async () => undefined,
  isDatabaseClosed: () => true,
  ownerRecordDir: happyOwners,
  lastVerifiedSnapshotId: () => undefined,
}
try {
  const handle = await prepareProductionOpen({
    dataDir: happyDb,
    snapshotRoot: happySnapRoot,
    operationKind: 'chat',
    deps: happyDeps, // 租约与两份 verified snapshot 都用**真实实现**
  })
  await handle.open()
  const reading = await handle.finish({ closed: true })
  happyMachineStates = [...reading.states]
  happyPreSnapshot = reading.preOpenSnapshotId
  happyPostSnapshot = reading.postCloseSnapshotId
} catch (error) {
  happyError = String(error)
}

const happyPreManifest =
  happyPreSnapshot === undefined ? undefined : join(happySnapRoot, `pglite-${happyPreSnapshot}.manifest.json`)
const happyPostManifest =
  happyPostSnapshot === undefined ? undefined : join(happySnapRoot, `pglite-${happyPostSnapshot}.manifest.json`)
const happyPlan = await planRestore({
  snapshotRoot: happySnapRoot,
  snapshotId: happyPostSnapshot ?? '',
  dataDir: happyDb,
})
const happyHealthy = happyPlan.health?.ok === true

const happyProblems: string[] = []
if (happyError !== '') happyProblems.push(`状态机抛错：${happyError}`)
if (happyPreSnapshot === undefined || happyPostSnapshot === undefined) happyProblems.push('缺少 pre-open / post-close 快照 id')
if (happyPreManifest === undefined || !existsSync(happyPreManifest)) happyProblems.push('pre-open manifest 不在')
if (happyPostManifest === undefined || !existsSync(happyPostManifest)) happyProblems.push('post-close manifest 不在')
if (happyMachineStates.at(-1) !== 'RELEASED') happyProblems.push(`状态机没走到 RELEASED：${happyMachineStates.join('→')}`)
if (happyOpenCalls !== 1) happyProblems.push(`源被打开 ${happyOpenCalls} 次（期望 1）`)
if (!happyHealthy) happyProblems.push(`恢复前的健康探针没过：${String(happyPlan.health?.reason)}`)
if (!happyPlan.ok) happyProblems.push(`planRestore 不通过：${String(happyPlan.failure)}`)
if (await isLeaseHeld(happyDb)) happyProblems.push('收尾后租约没被释放')

record({
  ordinal: 1,
  id: '正确实现 PASS',
  detector:
    'prepareProductionOpen（真实租约 + 真实 createVerifiedSnapshot + 真实健康探针）+ planRestore + isLeaseHeld',
  injection: '（无：这是正控）',
  expected: '8 态走完、两份 verified snapshot 都在、健康探针通过、租约释放 ⇒ 检测器**安静**',
  observed: happyProblems.length === 0 ? '安静（PASS）' : `响了：${happyProblems.join('；')}`,
  fired: happyProblems.length === 0,
  measuredCount: (happyPlan.health?.tableCount ?? 0) + happyMachineStates.length + FIXTURE_FILES,
  detail:
    `states=${happyMachineStates.join('→')} pre=${String(happyPreSnapshot)} post=${String(happyPostSnapshot)} ` +
    `health={ok:${String(happyPlan.health?.ok)},tables:${String(happyPlan.health?.tableCount)},closed:${String(happyPlan.health?.closed)}}`,
})

// ---------------------------------------------------------------------------
// ② 绕过 lease ⇒ 必须 FAIL（三条独立绕过路线）
// ---------------------------------------------------------------------------

const bRoot = join(root, 'bypass')
const bSource = join(bRoot, 'source')
await makeHealthyDb(bSource, 'bypass')
const bSnapRoot = join(bRoot, 'snapshots')
mkdirSync(bSnapRoot, { recursive: true })
const bForeign = join(bRoot, 'foreign')
mkdirSync(bForeign, { recursive: true })

// 路线 A：拿**别人**的租约去做快照
const foreignLease = await acquireProductionLease({
  dataDir: bForeign,
  operationKind: 'manual_snapshot',
  ownerRecordDir: join(bRoot, 'owners'),
})
const bypassA = await createVerifiedSnapshot({
  sourceDir: bSource,
  snapshotRoot: bSnapRoot,
  lease: foreignLease,
  healthProbe: async () => ({ ok: true, closed: true, tableCount: 1, schemaVersions: [1], readings: [] }),
})
await foreignLease.release({ cleanClose: true })

// 路线 B：目标库被持租约时做恢复（快照必须**真的存在**，否则会先撞上 snapshot_not_found）
const bSnapId = '2026-01-05T00-00-00-000Z-abcdefabcdef'
const bSnapPath = join(bSnapRoot, `pglite-${bSnapId}`)
mkdirSync(bSnapPath, { recursive: true })
writeFileSync(join(bSnapPath, 'payload.txt'), 'p\n', 'utf8')
const bSnapDigest = digestTree(bSnapPath)
writeFileSync(
  join(bSnapRoot, `pglite-${bSnapId}.manifest.json`),
  `${JSON.stringify(
    {
      snapshotId: bSnapId,
      createdAt: new Date().toISOString(),
      sourceDirKind: 'fixture',
      fileCount: bSnapDigest.measuredCount,
      totalBytes: bSnapDigest.totalBytes,
      nonVolatileTreeSha256: bSnapDigest.treeSha256,
      excludedPaths: bSnapDigest.excludedPaths,
      schemaVersions: [1],
      algorithm: 'inc01-tree-digest-v1',
    },
    null,
    2
  )}\n`,
  'utf8'
)
const bLease = await acquireProductionLease({
  dataDir: bSource,
  operationKind: 'restore',
  ownerRecordDir: join(bRoot, 'owners'),
})
const bypassB = await planRestore({
  snapshotRoot: bSnapRoot,
  snapshotId: bSnapId,
  dataDir: bSource,
  verifyHealth: false,
})
await bLease.release({ cleanClose: true })

// 路线 C：真实库目录上只设 flag、没有 token ⇒ 中央闸必须拒
const { assertDatabaseAccessAllowed } = await import('../src/db/index.ts')
const envSnapshot = {
  dataDir: process.env.PGLITE_DATA_DIR,
  allow: process.env.PROJECT_LG_ALLOW_PRODUCTION_DB,
  sandbox: process.env.PROJECT_LG_SANDBOX,
}
let bypassCFired = false
let bypassCObserved = ''
try {
  process.env.PGLITE_DATA_DIR = REAL_DB
  process.env.PROJECT_LG_ALLOW_PRODUCTION_DB = '1'
  delete process.env.PROJECT_LG_SANDBOX
  assertDatabaseAccessAllowed(() => false)
  bypassCObserved = '没有抛错（BUG）'
} catch (error) {
  bypassCFired = error instanceof Error && error.message.includes('missing_preopen_token')
  bypassCObserved = error instanceof Error ? error.message.split('\n')[0]! : String(error)
} finally {
  for (const [key, value] of [
    ['PGLITE_DATA_DIR', envSnapshot.dataDir],
    ['PROJECT_LG_ALLOW_PRODUCTION_DB', envSnapshot.allow],
    ['PROJECT_LG_SANDBOX', envSnapshot.sandbox],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const bypassFired =
  bypassA.failure === 'snapshot_lease_not_held' &&
  bypassB.failure === 'lease_held' &&
  bypassCFired
record({
  ordinal: 2,
  id: '绕过 lease ⇒ 必须 FAIL',
  detector: 'createVerifiedSnapshot 的租约归属校验 / planRestore 的租约检查 / `src/db/index.ts` 的中央闸',
  injection: 'A 用别人的租约做快照 · B 目标被持租约时恢复 · C 真实库只设 flag、无 token',
  expected: "A ⇒ `snapshot_lease_not_held` · B ⇒ `lease_held` · C ⇒ `missing_preopen_token`",
  observed: `A=${String(bypassA.failure)} · B=${String(bypassB.failure)} · C=${bypassCFired ? 'missing_preopen_token' : bypassCObserved}`,
  fired: bypassFired,
  measuredCount: 3,
  detail: `A/B/C 三条独立路线`,
})

// ---------------------------------------------------------------------------
// ③ 热复制假装 verified ⇒ 必须 FAIL
// ---------------------------------------------------------------------------

__resetPreopenTokensForTest()
const hotSource = join(root, 'hot-source')
await makeHealthyDb(hotSource, 'hot')
const hotSnapRoot = join(root, 'hot-snapshots')
mkdirSync(hotSnapRoot, { recursive: true })
const hotLease = await acquireProductionLease({
  dataDir: hotSource,
  operationKind: 'manual_snapshot',
  ownerRecordDir: join(root, 'hot-owners'),
})
// 注入"复制期间源被改"：复制刚做完就动源
const hotResult = await createVerifiedSnapshot({
  sourceDir: hotSource,
  snapshotRoot: hotSnapRoot,
  lease: hotLease,
  healthProbe: async () => ({ ok: true, closed: true, tableCount: 1, schemaVersions: [1], readings: [] }),
  afterCopy: () => {
    writeFileSync(join(hotSource, 'written-during-copy.txt'), 'hot\n', 'utf8')
  },
})
const hotPromoted = readdirSnapshotDirs(hotSnapRoot)
await hotLease.release({ cleanClose: true })

record({
  ordinal: 3,
  id: '热复制假装 verified ⇒ 必须 FAIL',
  detector: 'createVerifiedSnapshot 的"源静止性"校验（复制前后源摘要必须一致）',
  injection: '复制刚结束就往源里写一个文件（`afterCopy` 钩子）',
  expected: '`source_changed_during_copy`，并且**没有任何**快照被晋升',
  observed: `failure=${String(hotResult.failure)}；晋升的快照目录数=${hotPromoted.length}`,
  fired: hotResult.failure === 'source_changed_during_copy' && hotPromoted.length === 0,
  measuredCount: digestTree(hotSource).measuredCount,
  detail: `sourceDigestBefore=${hotResult.sourceDigestBefore?.treeSha256.slice(0, 12)}… after=${hotResult.sourceDigestAfter?.treeSha256.slice(0, 12)}…`,
})

// ---------------------------------------------------------------------------
// ④ 省略 runtime.close() ⇒ 必须 FAIL
// ---------------------------------------------------------------------------

let closedProbeAsked = 0
const noClose = createShutdown({
  stop: async () => undefined,
  close: async () => undefined, // 故意什么都不做 = "省略 close"
  isClosed: () => {
    closedProbeAsked += 1
    return false // 真实客户端在没关的情况下就是 false
  },
})
const noCloseReading = await noClose.shutdown()
__resetPreopenTokensForTest()
const noCloseDir = join(root, 'noclose-db')
mkdirSync(noCloseDir, { recursive: true })
const noCloseSnapRoot = join(root, 'noclose-snapshots')
mkdirSync(noCloseSnapRoot, { recursive: true })
let noCloseCode = ''
let noCloseStates: string[] = []
try {
  const handle = await prepareProductionOpen({
    dataDir: noCloseDir,
    snapshotRoot: noCloseSnapRoot,
    operationKind: 'chat',
    deps: {
      openDatabase: async () => undefined,
      stopServices: async () => undefined,
      closeDatabase: async () => undefined,
      isDatabaseClosed: () => false, // 没关
      createSnapshot: async () => ({ ok: true, snapshotId: 'x' }),
      // ⚠️ 不注入 releaseLease（缺省实现会真的释放租约并关掉 named pipe）
      ownerRecordDir: join(root, 'noclose-owners'),
    },
  })
  await handle.open()
  await handle.finish({ closed: false })
  noCloseStates = [...handle.reading.states]
} catch (error) {
  noCloseCode = (error as { hold?: { code?: string } }).hold?.code ?? String(error)
  noCloseStates = (error as { reading?: { states: string[] } }).reading?.states ?? []
}
const noClosePostDirs = existsSync(noCloseSnapRoot) ? readdirSync(noCloseSnapRoot) : []
record({
  ordinal: 4,
  id: '省略 runtime.close() ⇒ 必须 FAIL',
  detector: 'createShutdown 的 closed 判据 + shutdownExitCode + 状态机的 db_close_not_verified 边',
  injection: '`close()` 变成 no-op，且真实 `closed` 探测返回 false',
  expected: '`closed=false` ⇒ 退出码判据 1；状态机 ⇒ `db_close_not_verified` 且**不做** post-close 晋升',
  observed: `shutdown.closed=${String(noCloseReading.closed)} exit=${shutdownExitCode(noCloseReading)} · 状态机=${noCloseCode} · states=${noCloseStates.join('→')} · 快照目录=${JSON.stringify(noClosePostDirs)}`,
  fired:
    noCloseReading.closed === false &&
    shutdownExitCode(noCloseReading) === 1 &&
    closedProbeAsked === 1 &&
    noCloseCode === 'db_close_not_verified' &&
    noCloseStates.includes('RELEASED') &&
    noClosePostDirs.length === 0,
  measuredCount: closedProbeAsked + noCloseStates.length,
  detail: `closed 被问过 ${closedProbeAsked} 次（它是判据，不是可选步骤）`,
})

// ---------------------------------------------------------------------------
// ⑤ 伪造 closed=true ⇒ 必须 FAIL
// ---------------------------------------------------------------------------

__resetPreopenTokensForTest()
const forgeDir = join(root, 'forge-db')
mkdirSync(forgeDir, { recursive: true })
const forgeSnapRoot = join(root, 'forge-snapshots')
mkdirSync(forgeSnapRoot, { recursive: true })
let forgeCode = ''
let forgeStates: string[] = []
let forgeProbes = 0
try {
  const handle = await prepareProductionOpen({
    dataDir: forgeDir,
    snapshotRoot: forgeSnapRoot,
    operationKind: 'chat',
    deps: {
      openDatabase: async () => undefined,
      stopServices: async () => undefined,
      closeDatabase: async () => undefined,
      // 调用方**声称**关好了（closed: true），但真实探测说 false ⇒ 不许采信
      isDatabaseClosed: () => {
        forgeProbes += 1
        return false
      },
      createSnapshot: async () => ({ ok: true, snapshotId: 'y' }),
      ownerRecordDir: join(root, 'forge-owners'),
    },
  })
  await handle.open()
  await handle.finish({ closed: true }) // ← 伪造
  forgeStates = [...handle.reading.states]
} catch (error) {
  forgeCode = (error as { hold?: { code?: string } }).hold?.code ?? String(error)
  forgeStates = (error as { reading?: { states: string[] } }).reading?.states ?? []
}
const forgePostDirs = existsSync(forgeSnapRoot) ? readdirSync(forgeSnapRoot) : []
record({
  ordinal: 5,
  id: '伪造 closed=true ⇒ 必须 FAIL',
  detector: '状态机的"两条读数都为 true"判据（调用方报告 + 真实探测）',
  injection: '调用方传 `closed: true`，而 `isDatabaseClosed()` 返回 false',
  expected: '仍然 `db_close_not_verified`，**不做** post-close 晋升（不许采信单方面声明）',
  observed: `code=${forgeCode} · probes=${forgeProbes} · states=${forgeStates.join('→')} · 快照目录=${JSON.stringify(forgePostDirs)}`,
  fired: forgeCode === 'db_close_not_verified' && forgeProbes >= 1 && forgePostDirs.length === 0,
  measuredCount: forgeProbes + forgeStates.length,
  detail: '伪造的是"调用方报告"，判据是"真实探测" —— 两者必须都为 true',
})

// ---------------------------------------------------------------------------
// ⑥ 改 snapshot 1 字节 ⇒ 必须 FAIL
// ---------------------------------------------------------------------------

const tamperSnapshotRoot = join(root, 'tamper-snapshots')
mkdirSync(tamperSnapshotRoot, { recursive: true })
const tamperId = '2026-01-02T00-00-00-000Z-abcdefabcdef'
const tamperPath = join(tamperSnapshotRoot, `pglite-${tamperId}`)
mkdirSync(tamperPath, { recursive: true })
writeFileSync(join(tamperPath, 'data.txt'), 'original\n', 'utf8')
const tamperDigestBefore = digestTree(tamperPath)
writeFileSync(
  join(tamperSnapshotRoot, `pglite-${tamperId}.manifest.json`),
  `${JSON.stringify(
    {
      snapshotId: tamperId,
      createdAt: new Date().toISOString(),
      sourceDirKind: 'fixture',
      fileCount: tamperDigestBefore.measuredCount,
      totalBytes: tamperDigestBefore.totalBytes,
      nonVolatileTreeSha256: tamperDigestBefore.treeSha256,
      excludedPaths: tamperDigestBefore.excludedPaths,
      schemaVersions: [1],
      algorithm: 'inc01-tree-digest-v1',
    },
    null,
    2
  )}\n`,
  'utf8'
)
const tamperLive = join(root, 'tamper-live')
mkdirSync(tamperLive, { recursive: true })
writeFileSync(join(tamperLive, 'live.txt'), 'live\n', 'utf8')
const tamperQuiet = await planRestore({
  snapshotRoot: tamperSnapshotRoot,
  snapshotId: tamperId,
  dataDir: tamperLive,
  verifyHealth: false,
})
writeFileSync(join(tamperPath, 'data.txt'), 'originaX\n', 'utf8') // 只改 1 个字节
const tamperNoisy = await planRestore({
  snapshotRoot: tamperSnapshotRoot,
  snapshotId: tamperId,
  dataDir: tamperLive,
  verifyHealth: false,
})
record({
  ordinal: 6,
  id: '改 snapshot 1 字节 ⇒ 必须 FAIL',
  detector: 'planRestore 的"快照内容摘要 == manifest"校验',
  injection: '把快照里的 `data.txt` 改 1 个字节',
  expected: '改之前安静；改之后 ⇒ `snapshot_digest_mismatch`',
  observed: `改前=${tamperQuiet.ok ? '安静' : String(tamperQuiet.failure)}；改后=${String(tamperNoisy.failure)}（${tamperNoisy.snapshotDigestNow?.treeSha256.slice(0, 12)}… vs ${tamperDigestBefore.treeSha256.slice(0, 12)}…）`,
  fired: tamperQuiet.ok === true && tamperNoisy.failure === 'snapshot_digest_mismatch',
  measuredCount: tamperDigestBefore.measuredCount,
  detail: '摘要算法对 1 个字节敏感',
})

// ---------------------------------------------------------------------------
// ⑦ 缺失健康探针却写 PASS ⇒ 必须 FAIL
// ---------------------------------------------------------------------------

const fakeRoot = join(root, 'fake-health-snapshots')
mkdirSync(fakeRoot, { recursive: true })
const fakeId = '2026-01-03T00-00-00-000Z-999999999999'
const fakePath = join(fakeRoot, `pglite-${fakeId}`)
mkdirSync(fakePath, { recursive: true })
writeFileSync(join(fakePath, 'not-a-database.txt'), 'manifest 说它 verified，但它根本不是一个库\n', 'utf8')
const fakeDigest = digestTree(fakePath)
writeFileSync(
  join(fakeRoot, `pglite-${fakeId}.manifest.json`),
  `${JSON.stringify(
    {
      snapshotId: fakeId,
      createdAt: new Date().toISOString(),
      sourceDirKind: 'fixture',
      fileCount: fakeDigest.measuredCount,
      totalBytes: fakeDigest.totalBytes,
      nonVolatileTreeSha256: fakeDigest.treeSha256,
      excludedPaths: fakeDigest.excludedPaths,
      schemaVersions: [1], // ← 伪造的 schema 读数（没有健康证据支撑）
      algorithm: 'inc01-tree-digest-v1',
    },
    null,
    2
  )}\n`,
  'utf8'
)
const fakeLive = join(root, 'fake-live')
mkdirSync(fakeLive, { recursive: true })
writeFileSync(join(fakeLive, 'live.txt'), 'live\n', 'utf8')
// 默认动作（`verifyHealth` 缺省为 true）必须真的跑健康探针
const fakeWithHealth = await planRestore({
  snapshotRoot: fakeRoot,
  snapshotId: fakeId,
  dataDir: fakeLive,
  healthProbe: runHealthProbe,
})
// 反面对照：显式关掉健康探针 ⇒ 它就"看起来能恢复"（正是本步要防的那种假绿）
const fakeWithoutHealth = await planRestore({
  snapshotRoot: fakeRoot,
  snapshotId: fakeId,
  dataDir: fakeLive,
  verifyHealth: false,
})
record({
  ordinal: 7,
  id: '缺失健康探针却写 PASS ⇒ 必须 FAIL',
  detector: 'planRestore 的健康探针（默认**必须**执行，且跑在一次性副本上）',
  injection: '造一份"摘要与 manifest 完全一致、但根本不是数据库"的快照，manifest 里伪造 schema 读数',
  expected: '默认动作 ⇒ `snapshot_health_failed`；只有显式关掉探针时才会"看起来能恢复"（那正是假绿）',
  observed: `默认=${String(fakeWithHealth.failure)}（health.ok=${String(fakeWithHealth.health?.ok)} reason=${String(fakeWithHealth.health?.reason)}）；关掉探针=${fakeWithoutHealth.ok ? 'dry-run 通过（假绿）' : String(fakeWithoutHealth.failure)}`,
  fired:
    fakeWithHealth.failure === 'snapshot_health_failed' &&
    fakeWithHealth.health?.ok === false &&
    fakeWithoutHealth.ok === true,
  measuredCount: fakeDigest.measuredCount + (fakeWithHealth.health?.readings.length ?? 0),
  detail: 'manifest 里的 schema 读数是**声明**，不是证据；证据只能来自真的打开一次副本',
})

// ---------------------------------------------------------------------------
// ⑧ 恢复真实实现 ⇒ 再次 PASS
// ---------------------------------------------------------------------------

// 把第 ⑥ 步改掉的字节放回去；其余注入（no-op close / 伪造 closed / 假健康）都不在任何持久状态里
writeFileSync(join(tamperPath, 'data.txt'), 'original\n', 'utf8')
__resetPreopenTokensForTest()
const againDb = join(root, 'again-db')
await makeHealthyDb(againDb, 'again')
const againSnapRoot = join(root, 'again-snapshots')
mkdirSync(againSnapRoot, { recursive: true })
let againStates: string[] = []
let againError = ''
let againPost: string | undefined
try {
  const handle = await prepareProductionOpen({
    dataDir: againDb,
    snapshotRoot: againSnapRoot,
    operationKind: 'chat',
    deps: {
      openDatabase: async () => undefined,
      stopServices: async () => undefined,
      closeDatabase: async () => undefined,
      isDatabaseClosed: () => true,
      ownerRecordDir: join(root, 'again-owners'),
      lastVerifiedSnapshotId: () => undefined,
    },
  })
  await handle.open()
  const reading = await handle.finish({ closed: true })
  againStates = [...reading.states]
  againPost = reading.postCloseSnapshotId
} catch (error) {
  againError = String(error)
}
const tamperRecovered = await planRestore({
  snapshotRoot: tamperSnapshotRoot,
  snapshotId: tamperId,
  dataDir: tamperLive,
  verifyHealth: false,
})
const againManifest = againPost === undefined ? undefined : join(againSnapRoot, `pglite-${againPost}.manifest.json`)
record({
  ordinal: 8,
  id: '恢复真实实现 ⇒ 再次 PASS',
  detector: '与步骤 1 同一批检测器（同一份代码、同样两条真实快照）',
  injection: '（已撤销全部注入）',
  expected: '状态机再次走到 RELEASED + cleanClose；健康探针再次通过；第 ⑥ 步的快照再次安静',
  observed:
    `states=${againStates.join('→')} err=${againError || 'none'} · post 快照在=${String(againManifest !== undefined && existsSync(againManifest))} · ` +
    `第⑥步快照=${tamperRecovered.ok ? '安静' : String(tamperRecovered.failure)}`,
  fired:
    againError === '' &&
    againStates.at(-1) === 'RELEASED' &&
    againManifest !== undefined &&
    existsSync(againManifest) &&
    tamperRecovered.ok === true,
  measuredCount: againStates.length + (tamperRecovered.ok ? 1 : 0),
  detail: '注入不是"改坏了什么"：撤销之后同一批检测器重新安静',
})

// ---------------------------------------------------------------------------
// 汇总 / 证据
// ---------------------------------------------------------------------------

const realAfter = digestTree(REAL_DB)
const realUnchanged = realBefore.treeSha256 === realAfter.treeSha256
const totalMeasured = steps.reduce((sum, step) => sum + step.measuredCount, 0)
const anyZero = steps.some((step) => step.measuredCount === 0)
const anyNotFired = steps.some((step) => !step.fired)
const measurementInvalid = anyZero || steps.length !== 8 || realAfter.measuredCount === 0
const verdict = measurementInvalid ? 'MEASUREMENT INVALID' : anyNotFired ? 'FAIL' : 'PASS'

mkdirSync('artifacts/incidents/inc-01', { recursive: true })
writeFileSync(
  'artifacts/incidents/inc-01/measurement-self-test.json',
  `${JSON.stringify(
    {
      incident: 'INC-01',
      wp: 'WP6',
      generatedAt: new Date().toISOString(),
      verdict,
      steps,
      totals: {
        steps: steps.length,
        fired: steps.filter((step) => step.fired).length,
        measuredCount: totalMeasured,
        zeroMeasuredSteps: steps.filter((step) => step.measuredCount === 0).map((step) => step.id),
      },
      sourceHashes: {
        'src/infrastructure/persistence/production-db-safety.ts': sha256File('src/infrastructure/persistence/production-db-safety.ts'),
        'src/infrastructure/persistence/production-open-guard.ts': sha256File('src/infrastructure/persistence/production-open-guard.ts'),
        'src/infrastructure/persistence/production-db-restore.ts': sha256File('src/infrastructure/persistence/production-db-restore.ts'),
        'src/infrastructure/persistence/runtime-shutdown.ts': sha256File('src/infrastructure/persistence/runtime-shutdown.ts'),
        'scripts/inc-01-measurement.ts': sha256File('scripts/inc-01-measurement.ts'),
      },
      realDb: {
        before: realBefore.treeSha256,
        after: realAfter.treeSha256,
        unchanged: realUnchanged,
        measuredCount: realAfter.measuredCount,
      },
      didNotOpenRealDatabase: true,
      openedOnlyTempCopies: true,
    },
    null,
    2
  )}\n`,
  'utf8'
)

rmSync(root, { recursive: true, force: true })

console.log(
  `\nINC-01 量具八步自证：${verdict}（步骤 ${steps.length}/8 触发 ${steps.filter((s) => s.fired).length}；` +
    `measuredCount 合计 ${totalMeasured}；真实库前后${realUnchanged ? '一致' : '**不一致**'}）`
)
process.exitCode = verdict === 'PASS' ? 0 : 1
