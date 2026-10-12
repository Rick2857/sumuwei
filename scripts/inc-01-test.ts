/**
 * INC-01 **部件级门**（`pnpm inc-01:test`）。
 *
 * ============================================================================
 *  它测什么
 * ============================================================================
 * WP1–WP5 的五道门各自测了一条**链路**（租约 / 快照 / 收尾 / 状态机 / 恢复），
 * 但"每一个部件单独看是不是对的"没有一处集中回答。这个门就是那处：
 *
 * ```text
 *   摘要    digestTree：算法冻结、measured_count>0、改 1 字节就变、易失文件被排除、空目录 ⇒ MEASUREMENT INVALID
 *   租约    normalizeDataDir / leasePipeName / ownerRecordPath（拒绝写进 dataDir 内部）
 *   快照    必须持有**同一个** dataDir 的租约；晋升后目录 + manifest 都在；prune 不越界
 *   收尾    shutdownExitCode 真值表、幂等、永不抛、afterRun 不得改变判据
 *   状态机  八态逐字、五个 incident code 逐字、token 只能问不能给
 *   恢复    只认 ID 的形状表、授权逐字串对照、失败码清单完备
 *   静态    "同一件事只有一处实现"的机器判据（裸 stop / exit-越过关闭 / 闸的位置）
 * ```
 *
 * ⚠️ 这个门**不打开任何数据库**、**不碰真实库**；全部 fixture 在 `%TEMP%` 且是普通文件。
 *    它跑得快（秒级），因此适合在改任何 INC-01 代码之后第一时间跑。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { execFileSync } from 'node:child_process'
import {
  MeasurementInvalidError,
  acquireProductionLease,
  createVerifiedSnapshot,
  digestTree,
  isLeaseHeld,
  leasePipeName,
  normalizeDataDir,
  ownerRecordPath,
  pruneSnapshots,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  PRODUCTION_INCIDENT_CODES,
  PRODUCTION_OPEN_STATES,
  ProductionOpenGuardError,
  __resetPreopenTokensForTest,
  hasPreopenToken,
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  type ProductionOpenDeps,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  RESTORE_FAILURES,
  isSnapshotIdShaped,
  planRestore,
  restoreAuthorizationMatches,
  restoreAuthorizationValue,
  snapshotPathsOf,
} from '../src/infrastructure/persistence/production-db-restore.ts'
import { createShutdown, shutdownExitCode, type ShutdownReading } from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { stripComments, hasBareRuntimeStop } from './text-scan.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const root = mkdtempSync(join(tmpdir(), 'inc01-l1-'))

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

function dir(name: string, files: Record<string, string>): string {
  const target = join(root, name)
  mkdirSync(target, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const path = join(target, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  return target
}

// ---------------------------------------------------------------------------
// ① 摘要（算法冻结 + 计数真相）
// ---------------------------------------------------------------------------

const d1 = dir('d1', { 'a.txt': 'alpha\n', 'sub/b.txt': 'beta\n' })
const d1Digest = digestTree(d1)
const d1Again = digestTree(d1)
check(
  'T1',
  'digestTree：同一棵树两次摘要逐字相同，且 measured_count > 0',
  d1Digest.treeSha256 === d1Again.treeSha256 && d1Digest.measuredCount === 2 && d1Digest.totalBytes > 0,
  `measured=${d1Digest.measuredCount} bytes=${d1Digest.totalBytes} sha=${d1Digest.treeSha256.slice(0, 16)}…`
)

writeFileSync(join(d1, 'a.txt'), 'alphb\n', 'utf8') // 只改 1 个字节
const d1Changed = digestTree(d1)
check(
  'T2',
  'digestTree：**改 1 个字节**摘要必须变（"内容树"不是"文件名清单"）',
  d1Changed.treeSha256 !== d1Digest.treeSha256 && d1Changed.measuredCount === d1Digest.measuredCount,
  `${d1Digest.treeSha256.slice(0, 12)}… → ${d1Changed.treeSha256.slice(0, 12)}…`
)

const d3 = dir('d3', { 'keep.txt': 'k\n', 'postmaster.pid': 'volatile\n' })
const d3Digest = digestTree(d3)
check(
  'T3',
  'digestTree：`postmaster.pid`（易失运行态）被排除并**如实列出**，其余文件照常计入',
  d3Digest.measuredCount === 1 &&
    d3Digest.excludedPaths.includes('postmaster.pid') &&
    d3Digest.treeSha256 !== digestTree(d3, []).treeSha256,
  `measured=${d3Digest.measuredCount} excluded=${JSON.stringify(d3Digest.excludedPaths)}`
)

const d4 = join(root, 'd4-empty')
mkdirSync(d4, { recursive: true })
let emptyThrew = ''
try {
  digestTree(d4)
} catch (error) {
  emptyThrew = error instanceof MeasurementInvalidError ? error.name : `WRONG:${String(error)}`
}
check(
  'T4',
  'digestTree：空目录 ⇒ **MEASUREMENT INVALID**（"检查了 0 项"绝不是 PASS）',
  emptyThrew === 'MeasurementInvalidError',
  `threw=${emptyThrew}`
)

// ---------------------------------------------------------------------------
// ② 租约的确定性与路径纪律
// ---------------------------------------------------------------------------

check(
  'T5',
  'normalizeDataDir / leasePipeName：同一目录不同写法 ⇒ 同一个管道名；不同目录 ⇒ 不同管道名',
  leasePipeName('./data/pglite') === leasePipeName(resolve('data/pglite')) &&
    leasePipeName(resolve('data/pglite')) !== leasePipeName(resolve('data/pglite-copy')) &&
    normalizeDataDir(join(root, 'x')) === normalizeDataDir(join(root, 'x', '')),
  `same=${leasePipeName(resolve('data/pglite')).slice(-12)} diff=${leasePipeName(resolve('data/pglite-copy')).slice(-12)}`
)

let ownerInside = ''
try {
  ownerRecordPath(d1, join(d1, 'owner-records'))
} catch (error) {
  ownerInside = error instanceof Error ? error.message : String(error)
}
check(
  'T6',
  'ownerRecordPath：**拒绝**把 owner record 写进 dataDir 内部（那会改变被保护目录的内容树）',
  ownerInside.includes('不得位于 dataDir 内部'),
  ownerInside || '（没有抛错 —— BUG）'
)

const l1Dir = join(root, 'lease-a')
mkdirSync(l1Dir, { recursive: true })
const l1 = await acquireProductionLease({ dataDir: l1Dir, operationKind: 'chat', ownerRecordDir: join(root, 'owners') })
const heldWhileHeld = await isLeaseHeld(l1Dir)
await l1.release({ cleanClose: true })
const heldAfter = await isLeaseHeld(l1Dir)
check(
  'T7',
  '租约：持有期间 `isLeaseHeld` = true；释放后 = false（"进程还在"与"锁还在"是两件事）',
  heldWhileHeld === true && heldAfter === false,
  `held=${String(heldWhileHeld)} → ${String(heldAfter)}`
)

// ---------------------------------------------------------------------------
// ③ 快照：必须来自静止源 + 晋升后目录与 manifest 都在 + prune 不越界
// ---------------------------------------------------------------------------

const s1Source = dir('s1-source', { 'pg.txt': 'pg\n' })
const s1Root = join(root, 's1-snapshots')
mkdirSync(s1Root, { recursive: true })
const foreignDir = join(root, 'lease-foreign')
mkdirSync(foreignDir, { recursive: true })
const foreignLease = await acquireProductionLease({
  dataDir: foreignDir,
  operationKind: 'manual_snapshot',
  ownerRecordDir: join(root, 'owners'),
})
const wrongLease = await createVerifiedSnapshot({
  sourceDir: s1Source,
  snapshotRoot: s1Root,
  lease: foreignLease,
  healthProbe: async () => ({ ok: true, closed: true, tableCount: 1, schemaVersions: [1], readings: [] }),
})
await foreignLease.release({ cleanClose: true })
check(
  'T8',
  'createVerifiedSnapshot：**租约不属于这个 dataDir** ⇒ 拒绝（`snapshot_lease_not_held`）',
  wrongLease.ok === false && wrongLease.failure === 'snapshot_lease_not_held',
  `failure=${String(wrongLease.failure)}`
)

const s1Lease = await acquireProductionLease({
  dataDir: s1Source,
  operationKind: 'manual_snapshot',
  ownerRecordDir: join(root, 'owners'),
})
const good = await createVerifiedSnapshot({
  sourceDir: s1Source,
  snapshotRoot: s1Root,
  lease: s1Lease,
  healthProbe: async () => ({ ok: true, closed: true, tableCount: 1, schemaVersions: [1], readings: [] }),
})
await s1Lease.release({ cleanClose: true })
const promotedManifest = good.snapshotId === undefined ? undefined : `${join(s1Root, `pglite-${good.snapshotId}.manifest.json`)}`
check(
  'T9',
  'createVerifiedSnapshot：晋升后**目录 + manifest 都在**，manifest 摘要 == 源摘要，且 `lastVerifiedSnapshotId` 能认出它',
  good.ok === true &&
    good.snapshotPath !== undefined &&
    promotedManifest !== undefined &&
    existsSync(good.snapshotPath) &&
    existsSync(promotedManifest) &&
    good.manifest?.nonVolatileTreeSha256 === digestTree(s1Source).treeSha256 &&
    lastVerifiedSnapshotId(s1Root) === good.snapshotId,
  `id=${String(good.snapshotId)} files=${String(good.manifest?.fileCount)} manifest==source=${String(good.manifest?.nonVolatileTreeSha256 === digestTree(s1Source).treeSha256)}`
)

const outsideRoot = join(root, 'outside')
mkdirSync(outsideRoot, { recursive: true })
writeFileSync(join(outsideRoot, 'keep.txt'), 'k\n', 'utf8')
const pruned = pruneSnapshots(s1Root, 1)
check(
  'T10',
  'pruneSnapshots：只动**快照根内部**、以 `pglite-` 开头的目录；根外的目录一个字都不碰',
  existsSync(join(outsideRoot, 'keep.txt')) && Array.isArray(pruned) && good.snapshotPath !== undefined && existsSync(good.snapshotPath),
  `pruned=${JSON.stringify(pruned)} outsideKept=${String(existsSync(join(outsideRoot, 'keep.txt')))}`
)

// ---------------------------------------------------------------------------
// ④ 收尾：判据真值表 + 幂等 + 永不抛 + afterRun 不得改变判据
// ---------------------------------------------------------------------------

const shutdownCases: { name: string; input: Partial<ShutdownReading>; expected: 0 | 1 }[] = [
  { name: '全好', input: {}, expected: 0 },
  { name: 'stop 失败', input: { stopFailed: true }, expected: 1 },
  { name: 'close 失败', input: { closeFailed: true }, expected: 1 },
  { name: 'closed=false', input: { closed: false }, expected: 1 },
]
const shutdownMismatch = shutdownCases.filter((item) => {
  const reading: ShutdownReading = {
    stopCalls: 1,
    closeCalls: 1,
    closedCheckCalls: 1,
    stopFailed: false,
    closeFailed: false,
    closed: true,
    note: '',
    ...item.input,
  }
  return shutdownExitCode(reading) !== item.expected
})
check(
  'T11',
  'shutdownExitCode 真值表：`stopFailed || closeFailed || !closed ⇒ 1`，其余 0（单一策略）',
  shutdownMismatch.length === 0 && shutdownCases.length === 4 && shutdownExitCode(undefined) === 0,
  `measured=${shutdownCases.length} mismatch=${shutdownMismatch.length}`
)

let stopCalls = 0
let closeCalls = 0
let probeCalls = 0
const handle = createShutdown({
  stop: async () => {
    stopCalls += 1
  },
  close: async () => {
    closeCalls += 1
    throw new Error('注入：close 失败')
  },
  isClosed: () => {
    probeCalls += 1
    return false
  },
  afterRun: (reading) => {
    // 钩子**不许**改变已经定稿的判据
    reading.closed = true
  },
})
const r1 = await handle.shutdown()
const r2 = await handle.shutdown()
check(
  'T12',
  'createShutdown：幂等（只 stop/close 一次）、close 失败仍然问 closed、**永不抛**、返回同一个对象',
  stopCalls === 1 &&
    closeCalls === 1 &&
    probeCalls === 1 &&
    r1 === r2 &&
    r1.closeFailed === true &&
    r1.closed === false &&
    shutdownExitCode(r1) === 1,
  `stop=${stopCalls} close=${closeCalls} probe=${probeCalls} closed=${String(r1.closed)} exit=${shutdownExitCode(r1)}`
)

// ---------------------------------------------------------------------------
// ⑤ 状态机：八态 / 五个 code / token 只能问不能给
// ---------------------------------------------------------------------------

const canonicalStates = [
  'IDLE',
  'LEASED',
  'PREOPEN_SNAPSHOT_VERIFIED',
  'DB_OPEN',
  'SERVICES_STOPPED',
  'DB_CLOSED_VERIFIED',
  'POSTCLOSE_SNAPSHOT_VERIFIED',
  'RELEASED',
]
check(
  'T13',
  '状态机：八个状态与计划书 §WP4 的 Required State Machine **逐字**一致',
  PRODUCTION_OPEN_STATES.join(',') === canonicalStates.join(','),
  PRODUCTION_OPEN_STATES.join(' → ')
)
check(
  'T14',
  'incident code：五个失败边各有具名 code（逐字）',
  PRODUCTION_INCIDENT_CODES.join(',') ===
    ['lease_failed', 'preopen_verify_failed', 'db_open_failed', 'db_close_not_verified', 'postclose_snapshot_failed'].join(','),
  PRODUCTION_INCIDENT_CODES.join(', ')
)

const guardSource = readFileSync('src/infrastructure/persistence/production-open-guard.ts', 'utf8')
const dbSource = readFileSync('src/db/index.ts', 'utf8')
check(
  'T15',
  'token 纪律：授予**没有导出**（`grantPreopenToken` 不是 export），闸只"问"（`hasPreopenToken` 是 export）',
  /function grantPreopenToken\(/.test(guardSource) &&
    !/export function grantPreopenToken/.test(guardSource) &&
    /export function hasPreopenToken/.test(guardSource) &&
    !stripComments(dbSource).includes('grantPreopenToken'),
  `grantExported=${String(/export function grantPreopenToken/.test(guardSource))} hasExported=${String(/export function hasPreopenToken/.test(guardSource))}`
)

// 状态机的一次真实（注入依赖）成功路径，顺带证明 token 生命周期
__resetPreopenTokensForTest()
const gDir = join(root, 'guard-live')
mkdirSync(gDir, { recursive: true })
const gRoot = join(root, 'guard-snapshots')
mkdirSync(gRoot, { recursive: true })
let gTokenDuringOpen: boolean = false
let gTokenAfterFinish: boolean = true
let gError = ''
const gDeps: ProductionOpenDeps = {
  openDatabase: async () => {
    gTokenDuringOpen = hasPreopenToken(gDir)
  },
  stopServices: async () => undefined,
  closeDatabase: async () => undefined,
  isDatabaseClosed: () => true,
  createSnapshot: async () => ({ ok: true, snapshotId: 'l1-pre' }),
  /*
   * ⚠️ 这里**不注入** `releaseLease`：缺省实现走 `lease.release()`，
   * 它会**关掉 named pipe 的 server**。注入一个纯 no-op 会让管道一直挂着，
   * 于是门跑完进程都退不出去（WP4 门踩过同一个坑）。
   */
  ownerRecordDir: join(root, 'guard-owners'),
  lastVerifiedSnapshotId: () => undefined,
}
try {
  const gHandle = await prepareProductionOpen({
    dataDir: gDir,
    snapshotRoot: gRoot,
    operationKind: 'chat',
    deps: gDeps,
  })
  await gHandle.open()
  await gHandle.finish({ closed: true })
  gTokenAfterFinish = hasPreopenToken(gDir)
} catch (error) {
  gError = error instanceof ProductionOpenGuardError ? `${error.hold.code}: ${error.hold.detail}` : String(error)
}
check(
  'T16',
  '状态机 + token 生命周期：打开**之前**必须有 token，收尾后**必须撤销**（下一次打开要重走）',
  (gTokenDuringOpen as boolean) === true && (gTokenAfterFinish as boolean) === false && gError === '',
  `duringOpen=${String(gTokenDuringOpen)} afterFinish=${String(gTokenAfterFinish)} error=${gError || 'none'}`
)

// ---------------------------------------------------------------------------
// ⑥ 恢复：只认 ID / 授权逐字 / 失败码完备
// ---------------------------------------------------------------------------

const idCases: { id: string; ok: boolean }[] = [
  { id: '2026-09-21T02-54-51-322Z-be957694b8a1', ok: true },
  { id: '../escape', ok: false },
  { id: 'C:\\db', ok: false },
  { id: '/etc/db', ok: false },
  { id: 'pglite-2026-01-01', ok: false },
  { id: '2026-01-01T00-00-00-000Z-abcdefabcdef', ok: true },
  { id: '2026-01-01T00-00-00-000Z-ABCDEFABCDEF', ok: false },
]
const idMismatch = idCases.filter((item) => isSnapshotIdShaped(item.id) !== item.ok)
check(
  'T17',
  '`isSnapshotIdShaped`：白名单形状（只允许 `[0-9A-Za-z-]` 且以 12 位小写十六进制结尾）⇒ 路径类输入**结构上**不可能通过',
  idMismatch.length === 0 && idCases.length > 0,
  `measured=${idCases.length} mismatch=${idMismatch.length}`
)

const authTarget = join(root, 'auth-db')
const authOk = restoreAuthorizationValue('2026-01-01T00-00-00-000Z-abcdefabcdef', authTarget)
const authMismatch = [
  restoreAuthorizationMatches(authOk, '2026-01-01T00-00-00-000Z-abcdefabcdef', authTarget) === true,
  restoreAuthorizationMatches('1', '2026-01-01T00-00-00-000Z-abcdefabcdef', authTarget) === false,
  restoreAuthorizationMatches('true', '2026-01-01T00-00-00-000Z-abcdefabcdef', authTarget) === false,
  restoreAuthorizationMatches(authOk, '2026-01-01T00-00-00-000Z-999999999999', authTarget) === false,
  restoreAuthorizationMatches(authOk, '2026-01-01T00-00-00-000Z-abcdefabcdef', join(root, 'other')) === false,
].filter((ok) => !ok).length
check(
  'T18',
  '恢复授权：只有**逐字** `<snapshotId>@<解析后的 dataDir>` 才算授权；布尔开关/换 ID/换目录一律不算',
  authMismatch === 0,
  `value=${authOk.replace(ROOT, '<root>')} mismatch=${authMismatch}`
)

const rPlanRoot = join(root, 'r-plan')
mkdirSync(rPlanRoot, { recursive: true })
const rLive = dir('r-live', { 'x.txt': 'x\n' })
const rBadPlan = await planRestore({
  snapshotRoot: rPlanRoot,
  snapshotId: '../escape',
  dataDir: rLive,
  verifyHealth: false,
})
const rMissingPlan = await planRestore({
  snapshotRoot: rPlanRoot,
  snapshotId: '2026-01-01T00-00-00-000Z-abcdefabcdef',
  dataDir: rLive,
  verifyHealth: false,
})
const rPaths = snapshotPathsOf(rPlanRoot, '2026-01-01T00-00-00-000Z-abcdefabcdef')
check(
  'T19',
  '`planRestore` 的失败码可判且**可区分**：坏 ID ⇒ `snapshot_id_invalid`；查无此快照 ⇒ `snapshot_not_found`',
  rBadPlan.failure === 'snapshot_id_invalid' &&
    rMissingPlan.failure === 'snapshot_not_found' &&
    rPaths.snapshotPath.endsWith('pglite-2026-01-01T00-00-00-000Z-abcdefabcdef'),
  `${String(rBadPlan.failure)} / ${String(rMissingPlan.failure)}`
)

check(
  'T20',
  '恢复失败码清单是**闭集且完备**（16 条，且与 WP5 门断言的数量一致）',
  RESTORE_FAILURES.length === 16 && new Set(RESTORE_FAILURES).size === 16,
  `${RESTORE_FAILURES.length} 条：${RESTORE_FAILURES.join(', ')}`
)

// ---------------------------------------------------------------------------
// ⑦ 静态：同一件事只有一处实现
// ---------------------------------------------------------------------------

const openers = ['src/main.ts', 'scripts/snapshot-state.ts', 'scripts/verify-m4-real-db.ts', 'scripts/verify-m5.1.1-phase4b-db-v9.ts']
const bareStop: string[] = []
const exitBeforeClose: string[] = []
for (const file of openers) {
  const text = stripComments(readFileSync(file, 'utf8'))
  if (hasBareRuntimeStop(text)) bareStop.push(file)
  const shutdownIndex = text.indexOf('createRuntimeShutdown(')
  const exitIndex = text.indexOf('process.exit(')
  if (exitIndex !== -1 && (shutdownIndex === -1 || exitIndex < shutdownIndex)) exitBeforeClose.push(file)
}
check(
  'T21',
  '静态：真实 opener 里**没有**裸 `.stop()`（停服务只有 `stopRuntimeServices()` 一处实现）',
  bareStop.length === 0,
  bareStop.join(',') || '（干净）'
)
check('T21a', '收尾扫描区分 runtime 与组件，包含可选调用和嵌套接收者',
  ['await runtime.stop()', 'await runtime?.stop()', 'await state.runtime.stop()'].every(hasBareRuntimeStop)
    && !hasBareRuntimeStop('scheduler?.stop(); browserSidecar.stop(); /* runtime.stop() */'),
  '真实 runtime 调用必须报警；组件停止与注释保持安静')
check(
  'T22',
  '静态：没有任何 `process.exit()` 出现在收尾调用**之前**（不许越过关闭）',
  exitBeforeClose.length === 0,
  exitBeforeClose.join(',') || '（干净）'
)

const restoreCli = readFileSync('scripts/restore-db.ts', 'utf8')
check(
  'T23',
  '静态：恢复 CLI **不 import `initDatabase`**（它从不打开库；健康探针只对 `%TEMP%` 副本做）',
  !restoreCli.includes('initDatabase') && restoreCli.includes('planRestore') && restoreCli.includes('applyRestore'),
  `mentionsInitDatabase=${String(restoreCli.includes('initDatabase'))}`
)

const dbCode = stripComments(dbSource)
const initIndex = dbCode.indexOf('export async function initDatabase(')
check(
  'T24',
  '静态：中央闸在 `initDatabase()` 里且**先于** `runtime.registerPlugin(sqlPlugin)`；闸判据包含真实库重叠判定',
  initIndex >= 0 &&
    dbCode.indexOf('assertDatabaseAccessAllowed()', initIndex) > initIndex &&
    dbCode.indexOf('await runtime.registerPlugin(sqlPlugin)', initIndex) >
      dbCode.indexOf('assertDatabaseAccessAllowed()', initIndex) &&
    /isProductionDir\(/.test(dbCode) &&
    isProductionDir(PRODUCTION_DB_DIR) &&
    !isProductionDir(root),
  `gateBeforeRegister=true realIsProduction=${String(isProductionDir(PRODUCTION_DB_DIR))} tempIsProduction=${String(isProductionDir(root))}`
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const measuredCount = d1Digest.measuredCount + d3Digest.measuredCount + checks.length
const measurementInvalid = d1Digest.measuredCount === 0 || checks.length === 0
const verdict = measurementInvalid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

mkdirSync('artifacts/incidents/inc-01', { recursive: true })
writeFileSync(
  'artifacts/incidents/inc-01/inc-01-test.json',
  `${JSON.stringify(
    {
      incident: 'INC-01',
      wp: 'WP6',
      checkedAt: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      scope: {
        opensDatabase: false,
        touchesRealDatabase: false,
        fixtureRoot: root.replace(/\\/g, '/'),
        note: '部件级静态 + 纯函数 + 最小 fs fixture；不打开任何 PGlite。',
      },
      measurements: { checks: checks.length, failed, measuredCount },
      checks,
      verdict,
    },
    null,
    2
  )}\n`,
  'utf8'
)

rmSync(root, { recursive: true, force: true })
console.log(`\nINC-01 部件级门：${verdict}（${checks.length} 项断言，${failed} 失败）`)
process.exitCode = verdict === 'PASS' ? 0 : 1
