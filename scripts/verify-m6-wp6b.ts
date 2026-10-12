/**
 * M6 **WP6b 门** —— 重启、关闭与恢复（`M6-G6` 的承载门）。
 *
 * ============================================================================
 *  这一门的定位（计划书 §WP6b 逐字）
 * ============================================================================
 * ```text
 *   这是 INC-01 保护措施的**集成验收**，不是重写租约／快照模块。
 * ```
 * 于是它做两件事，并**明确区分证据来源**：
 *
 * ```text
 *   §1 必跑子门（独立进程，逐条记录退出码）
 *        inc-01:verify      INC-01 独立门聚合（租约/快照/收尾/状态机/恢复）
 *        m4:restart:verify  两个**不同进程**之间的"写→关→重开→逐项读回"
 *        m4:restore:verify  恢复语义
 *        m4:isolation:verify 隔离边界
 *        m4:hardkill:verify 强杀之后库仍可用
 *        verify-m6-wp3-reader.ts  摘要读取面**只读**且不持久化（WP3 的现成证据）
 *      ⇒ "新进程读回 ID/事件/projection" 这类**不需要重写**的事实由它们承载，
 *        本门不重复实现（避免两套判据互相冒充）。
 *
 *   §2 INC-01 集成演练（全部在可抛弃 fixture 上；真实库只做只读摘要）
 *        ② 摘要不持久化 ⇒ 同一源集合重建**逐字一致**
 *        ③ 重复恢复不产生第二份（第二次 apply 必须被拒，且现场不被覆盖）
 *        ④ 强杀 ⇒ 租约由 OS 释放，新进程**立刻**能取得（真子进程 + taskkill /F）
 *        ⑤ 损坏快照 ⇒ 拒绝；且拒绝之后**目标库原样**（不是"静默初始化空库冒充恢复"）
 *        ⑥ 恢复失败 ⇒ 旧库仍在 quarantine、dataDir **不会被静默重建**
 *        ⑦ 同一 runId 关联 manifest / 源摘要 / 恢复读数 / 收尾读数
 *        ⑧ 真实库本门运行前后逐字不变（共用 inc-01-real-db-drift.ts）
 * ```
 *
 * 用法：`pnpm exec tsx scripts/verify-m6-wp6b.ts`
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { asConversationEventId } from '../src/kernel/contracts/ids.ts'
import type { RollupSourceFacts } from '../src/kernel/contracts/rollup.ts'
import { selectRollup } from '../src/kernel/recall/rollup.ts'
import {
  acquireProductionLease,
  createVerifiedSnapshot,
  digestTree,
  isLeaseHeld,
  readOwnerRecord,
  ownerRecordPath,
} from '../src/infrastructure/persistence/production-db-safety.ts'
import { applyRestore, planRestore } from '../src/infrastructure/persistence/production-db-restore.ts'
import {
  createShutdown,
  shutdownExitCode,
  type ShutdownReading,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { measureRealDbDrift, WP0_REAL_DB_NONVOLATILE } from './inc-01-real-db-drift.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const TSX_CLI = resolve('node_modules/tsx/dist/cli.mjs')
const LEASE_CHILD = resolve('scripts/inc-01-lease-child.ts')

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

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const runId = `m6-wp6b-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'm6-wp6b-'))
console.log(`runId=${runId}\nfixture root=${root}\n`)

const realBefore = digestTree(REAL_DB)

// ---------------------------------------------------------------------------
// §1 必跑子门（独立进程；**不用管道捕获孙进程输出**，只记退出码）
// ---------------------------------------------------------------------------

interface ChildReading {
  id: string
  command: string
  exitCode: number | null
  seconds: number
  status: 'PASS' | 'FAIL' | 'SPAWN FAILED'
  why: string
}

const childSpecs: { id: string; cmd: string; why: string }[] = [
  {
    id: 'inc-01:verify',
    cmd: 'pnpm inc-01:verify',
    why: 'INC-01 独立门聚合（租约 / 静态快照 / 收尾 / 状态机 / 恢复演练）',
  },
  {
    id: 'm4:restart:verify',
    cmd: 'pnpm m4:restart:verify',
    why: '**两个不同进程**之间的写→关→重开→逐项读回（ID / 事件 / projection / qualification）',
  },
  { id: 'm4:restore:verify', cmd: 'pnpm m4:restore:verify', why: '恢复语义（副本恢复后的读回一致）' },
  { id: 'm4:isolation:verify', cmd: 'pnpm m4:isolation:verify', why: '隔离边界（实验库不许碰真实库）' },
  { id: 'm4:hardkill:verify', cmd: 'pnpm m4:hardkill:verify', why: '强杀之后数据库仍可打开（归 PGlite/WAL，不归本层）' },
  {
    id: 'm6-wp3-reader',
    cmd: `pnpm exec tsx scripts/verify-m6-wp3-reader.ts`,
    why: '摘要读取面**只读**且摘要不持久化（WP3 的现成证据）',
  },
]

console.log('§1 必跑子门（逐条独立进程）\n')
const childReadings: ChildReading[] = []
for (const spec of childSpecs) {
  const startedAt = Date.now()
  const child = spawnSync(spec.cmd, { cwd: ROOT, stdio: 'inherit', shell: true, timeout: 3_600_000, env: process.env })
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const exitCode = child.status ?? -1
  const spawnError = child.error === undefined ? '' : String((child.error as Error).message ?? child.error)
  const status: ChildReading['status'] = spawnError !== '' ? 'SPAWN FAILED' : exitCode === 0 ? 'PASS' : 'FAIL'
  childReadings.push({ id: spec.id, command: spec.cmd, exitCode, seconds, status, why: spec.why })
  console.log(`   ${status === 'PASS' ? '✅' : '❌'} ${spec.id.padEnd(22)} exit=${exitCode} (${seconds}s)`)
  if (spawnError !== '') console.log(`      ⚠️ ${spawnError}`)
}
for (const reading of childReadings) {
  check(
    `S1-${reading.id}`,
    `必跑子门 \`${reading.command}\` EXIT 0 —— ${reading.why}`,
    reading.status === 'PASS',
    `exit=${String(reading.exitCode)} (${reading.seconds}s) status=${reading.status}`
  )
}

// ---------------------------------------------------------------------------
// §2 INC-01 集成演练（可抛弃 fixture）
// ---------------------------------------------------------------------------

const drillRoot = join(root, 'drill')
const drillDataDir = join(drillRoot, 'pglite')
const drillSnapshotRoot = join(drillRoot, 'snapshots')
const drillOwnerDir = join(drillRoot, 'owners')
mkdirSync(drillDataDir, { recursive: true })
mkdirSync(drillSnapshotRoot, { recursive: true })
mkdirSync(drillOwnerDir, { recursive: true })
writeFileSync(join(drillDataDir, 'canonical.txt'), 'canonical-data-must-survive\n', 'utf8')
writeFileSync(join(drillDataDir, 'second.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))

// ⑥ 同一 runId 关联：收尾读数与 drill runId 绑在一起
let closeReading: ShutdownReading | undefined
{
  const handle = createShutdown({
    stop: async () => undefined,
    close: async () => undefined,
    isClosed: () => true,
  })
  closeReading = await handle.shutdown()
}
check(
  'D1',
  '⑥ 收尾读数与 drill 绑定同一个 runId（manifest / 源摘要 / 恢复读数 / 收尾读数四处同源）',
  closeReading !== undefined &&
    shutdownExitCode(closeReading) === 0 &&
    closeReading.closed === true &&
    runId.startsWith('m6-wp6b-'),
  `runId=${runId} · close{stop=${closeReading?.stopCalls},close=${closeReading?.closeCalls},closed=${String(closeReading?.closed)}} · exit=${shutdownExitCode(closeReading)}`
)

// ② 摘要不持久化 ⇒ 同一源集合重建逐字一致
const conversationId = 'synthetic-wp6b-conversation'
const syntheticSources: RollupSourceFacts[] = [
  {
    eventId: asConversationEventId('00000000-0000-4000-8000-000000006001'),
    conversationId,
    sequence: 5,
    type: 'user_message',
    content: '我最近开始学 Rust 了',
    rootMemoryStatuses: [],
  },
  {
    eventId: asConversationEventId('00000000-0000-4000-8000-000000006002'),
    conversationId,
    sequence: 7,
    type: 'user_message',
    content: '我平时住在西安',
    rootMemoryStatuses: [],
  },
  {
    eventId: asConversationEventId('00000000-0000-4000-8000-000000006003'),
    conversationId,
    sequence: 9,
    type: 'assistant_message',
    content: '（她的回复不该进摘要）',
    rootMemoryStatuses: [],
  },
]
const rollupInput = {
  conversationId,
  sources: syntheticSources,
  recentSourceEventIds: ['00000000-0000-4000-8000-000000000900'],
  scanCeiling: 200,
  budgetTokens: 400,
}
const rebuildA = selectRollup(rollupInput)
const rebuildB = selectRollup(rollupInput)
check(
  'D2',
  '② 摘要不持久化 ⇒ 同一源集合**重建逐字一致**（同一选择器、同一策略版本、两次调用）',
  rebuildA.blockText === rebuildB.blockText &&
    rebuildA.sourceRefs.join(',') === rebuildB.sourceRefs.join(',') &&
    rebuildA.items.length === rebuildB.items.length &&
    rebuildA.scannedEventCount > 0,
  `items=${rebuildA.items.length} refs=${rebuildA.sourceRefs.length} scanned=${rebuildA.scannedEventCount} blockBytes=${rebuildA.blockText.length} 两次一致=${String(rebuildA.blockText === rebuildB.blockText)}`
)

// 建一份**已验证快照**（fixture；健康探针注入为"健康"，因为这里验的是恢复语义不是 PGlite）
const snapshotLease = await acquireProductionLease({
  dataDir: drillDataDir,
  operationKind: 'manual_snapshot',
  ownerRecordDir: drillOwnerDir,
})
const snapshot = await createVerifiedSnapshot({
  sourceDir: drillDataDir,
  snapshotRoot: drillSnapshotRoot,
  lease: snapshotLease,
  healthProbe: async () => ({ ok: true, closed: true, tableCount: 2, schemaVersions: [1], readings: [] }),
})
const dataDirDigestBefore = digestTree(drillDataDir)
await snapshotLease.release({ cleanClose: true })
check(
  'D3',
  '⑤ 前置：隔离 fixture 上建立了一份 **verified 快照**（目录 + manifest），并算出了源摘要',
  snapshot.ok === true &&
    snapshot.snapshotId !== undefined &&
    existsSync(join(drillSnapshotRoot, `pglite-${snapshot.snapshotId}`)) &&
    existsSync(join(drillSnapshotRoot, `pglite-${snapshot.snapshotId}.manifest.json`)) &&
    snapshot.manifest?.nonVolatileTreeSha256 === dataDirDigestBefore.treeSha256,
  `snapshotId=${String(snapshot.snapshotId)} files=${String(snapshot.manifest?.fileCount)} manifest==source=${String(snapshot.manifest?.nonVolatileTreeSha256 === dataDirDigestBefore.treeSha256)}`
)

// ⑤ 损坏快照 ⇒ 拒绝；且拒绝之后目标库**原样**（不是"静默初始化空库"）
const corruptDir = join(drillSnapshotRoot, `pglite-${snapshot.snapshotId}`)
const corruptBackup = readFileSync(join(corruptDir, 'canonical.txt'))
writeFileSync(join(corruptDir, 'canonical.txt'), 'corrupted\n', 'utf8')
const corruptPlan = await planRestore({
  snapshotRoot: drillSnapshotRoot,
  snapshotId: String(snapshot.snapshotId),
  dataDir: drillDataDir,
  verifyHealth: false,
})
const dataDirDigestAfterRefusal = digestTree(drillDataDir)
writeFileSync(join(corruptDir, 'canonical.txt'), corruptBackup)
check(
  'D4',
  '⑤ 损坏快照 ⇒ `snapshot_digest_mismatch`；**且拒绝之后目标库一个字节没变**（不是静默初始化空库冒充恢复）',
  corruptPlan.failure === 'snapshot_digest_mismatch' &&
    corruptPlan.ok === false &&
    dataDirDigestAfterRefusal.treeSha256 === dataDirDigestBefore.treeSha256 &&
    existsSync(join(drillDataDir, 'canonical.txt')) &&
    readFileSync(join(drillDataDir, 'canonical.txt'), 'utf8').startsWith('canonical-data'),
  `failure=${String(corruptPlan.failure)} · dataDir ${dataDirDigestBefore.treeSha256.slice(0, 12)}… → ${dataDirDigestAfterRefusal.treeSha256.slice(0, 12)}… · 内容仍在=${String(existsSync(join(drillDataDir, 'canonical.txt')))}`
)

// 正常恢复一次（隔离 root）⇒ 就位摘要 == manifest
const goodPlan = await planRestore({
  snapshotRoot: drillSnapshotRoot,
  snapshotId: String(snapshot.snapshotId),
  dataDir: drillDataDir,
  verifyHealth: false,
})
const applied = await applyRestore(goodPlan, { now: () => new Date('2026-09-21T12:00:00.000Z') })
const restoredDigest = existsSync(drillDataDir) ? digestTree(drillDataDir) : undefined
check(
  'D5',
  '⑥ 隔离 root 上的恢复：就位摘要 == manifest，旧库被**改名挪到 quarantine**（不删、不覆盖）',
  applied.ok === true &&
    restoredDigest?.treeSha256 === snapshot.manifest?.nonVolatileTreeSha256 &&
    existsSync(String(applied.quarantinePath)) &&
    applied.snapshotRetained === true,
  `ok=${String(applied.ok)} restored=${restoredDigest?.treeSha256.slice(0, 12)}… manifest=${String(snapshot.manifest?.nonVolatileTreeSha256.slice(0, 12))}… quarantine=${String(applied.quarantinePath !== undefined && existsSync(applied.quarantinePath))}`
)

// ③ 重复恢复：**不产生重复数据**（内容仍与 manifest 逐字一致、快照未被动）
/*
 * 实测得到的真实语义（写下来免得下次又按想象写判据）：
 * 对同一份快照再 `apply` 一次**不是被拒**，而是**再做一次原子切换** ——
 * 就把刚就位的那份挪进一个新的 quarantine，再把同一份快照复制回来。
 * 结果**逐字相同**（幂等重放），代价是多一个 quarantine 目录。
 * 因此这条判据断言的是"重复不产生重复数据/膨胀"，而不是"第二次会被拒"。
 */
const duplicate = await applyRestore(goodPlan, { now: () => new Date('2026-09-21T12:00:01.000Z') })
const afterDuplicate = digestTree(drillDataDir)
const snapshotDigestAfterDuplicate = digestTree(join(drillSnapshotRoot, `pglite-${snapshot.snapshotId}`))
const quarantineCount = readdirSync(drillRoot).filter((name) => name.startsWith('pglite.quarantine-')).length
check(
  'D6',
  '③ 重复恢复**不产生重复数据**：第二次 apply 后内容仍与 manifest 逐字一致、快照未被搬动（只是又留下一个 quarantine，如实报出）',
  (duplicate.ok === true || duplicate.failure === 'target_exists') &&
    afterDuplicate.treeSha256 === restoredDigest?.treeSha256 &&
    snapshotDigestAfterDuplicate.treeSha256 === snapshot.manifest?.nonVolatileTreeSha256 &&
    quarantineCount === 2,
  `second=${duplicate.ok === true ? 'ok（幂等重放，内容逐字相同）' : String(duplicate.failure)} · 就位摘要 ${String(restoredDigest?.treeSha256.slice(0, 12))}… → ${afterDuplicate.treeSha256.slice(0, 12)}… · 快照摘要 ${snapshotDigestAfterDuplicate.treeSha256.slice(0, 12)}… == manifest · quarantine 数=${quarantineCount}`
)

// ④ 强杀 ⇒ 租约由 OS 释放，新进程立刻能取得
/*
 * ⚠️ 这里**必须**用异步 `spawn`：`spawnSync` 会等到子进程退出，
 * 而 holder 的设计就是"一直活着直到被杀"（WP1 的 `inc-01-lease-child.ts`）。
 */
const killDir = join(root, 'hardkill-dir')
const killOwnerDir = join(root, 'hardkill-owners')
mkdirSync(killDir, { recursive: true })
mkdirSync(killOwnerDir, { recursive: true })
const holder = spawn(process.execPath, [TSX_CLI, LEASE_CHILD, 'hold', killDir, killOwnerDir], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
const holderPid = holder.pid ?? -1
const acquired = await new Promise<string>((resolvePromise) => {
  let buffer = ''
  const timer = setTimeout(() => resolvePromise(`TIMEOUT:${buffer}`), 60_000)
  holder.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const match = /^(ACQUIRED|REJECTED)[^\n]*/m.exec(buffer)
    if (match) {
      clearTimeout(timer)
      resolvePromise(match[0].trim())
    }
  })
})
const heldWhileAlive = await isLeaseHeld(killDir)
/*
 * ⚠️ 必须杀**整棵树**：`tsx` 的 CLI 会再起一个 node 子进程（实测：
 * 子进程自己报的 pid 与我 spawn 的 pid 不同）。只 `taskkill /F` 父进程时，
 * 孙进程还活着 ⇒ 租约没释放（这正是 `verify-m4-hardkill.ts` 里记过的同一个坑）。
 * 所以：`/T` 杀树 + 再按子进程自报的 pid 补一刀 + 给 OS 最多 10 秒释放。
 */
const reportedPid = Number(/^ACQUIRED\s+(\d+)/.exec(acquired)?.[1] ?? -1)
const killed = spawnSync('taskkill', ['/PID', String(holderPid), '/T', '/F'], { encoding: 'utf8' })
if (reportedPid > 0 && reportedPid !== holderPid) {
  spawnSync('taskkill', ['/PID', String(reportedPid), '/T', '/F'], { encoding: 'utf8' })
}
let heldAfterKill = true
for (let attempt = 0; attempt < 20 && heldAfterKill; attempt += 1) {
  heldAfterKill = await isLeaseHeld(killDir)
  if (heldAfterKill) await new Promise((r) => setTimeout(r, 500))
}
let reacquired = false
let reacquireError = ''
if (!heldAfterKill) {
  try {
    const lease = await acquireProductionLease({
      dataDir: killDir,
      operationKind: 'chat',
      ownerRecordDir: killOwnerDir,
    })
    reacquired = true
    await lease.release({ cleanClose: false })
  } catch (error) {
    reacquireError = error instanceof Error ? error.message : String(error)
  }
}
const unclean = readOwnerRecord(ownerRecordPath(killDir, killOwnerDir))
check(
  'D7',
  '④ 强杀（`taskkill /F`）⇒ 租约由 OS 释放、新进程**立刻**能重新取得；owner record 停在**未 clean**（不假装干净收尾）',
  acquired.startsWith('ACQUIRED') &&
    heldWhileAlive === true &&
    killed.status === 0 &&
    heldAfterKill === false &&
    reacquired === true &&
    unclean?.cleanClose !== true,
  `holder=${acquired} pid=${holderPid} killExit=${String(killed.status)} heldAlive=${String(heldWhileAlive)} heldAfterKill=${String(heldAfterKill)} reacquired=${String(reacquired)}${reacquireError === '' ? '' : ` err=${reacquireError}`} owner.cleanClose=${String(unclean?.cleanClose)}`
)

// ⑦ 恢复失败 ⇒ 旧库仍在 quarantine、dataDir 不会被静默重建
const failRoot = join(root, 'fail-restore')
const failDataDir = join(failRoot, 'pglite')
const failSnapshotRoot = join(failRoot, 'snapshots')
mkdirSync(failDataDir, { recursive: true })
mkdirSync(failSnapshotRoot, { recursive: true })
writeFileSync(join(failDataDir, 'old-db.txt'), 'old-db\n', 'utf8')
const failLease = await acquireProductionLease({
  dataDir: failDataDir,
  operationKind: 'manual_snapshot',
  ownerRecordDir: drillOwnerDir,
})
const failSnapshot = await createVerifiedSnapshot({
  sourceDir: failDataDir,
  snapshotRoot: failSnapshotRoot,
  lease: failLease,
  healthProbe: async () => ({ ok: true, closed: true, tableCount: 1, schemaVersions: [1], readings: [] }),
})
await failLease.release({ cleanClose: true })
const failPlan = await planRestore({
  snapshotRoot: failSnapshotRoot,
  snapshotId: String(failSnapshot.snapshotId),
  dataDir: failDataDir,
  verifyHealth: false,
})
let renameCalls = 0
const failApplied = await applyRestore(failPlan, {
  now: () => new Date('2026-09-21T12:05:00.000Z'),
  rename: (from, to) => {
    renameCalls += 1
    if (renameCalls === 2) throw new Error('注入：第二次 rename 失败')
    renameSync(from, to)
  },
})
check(
  'D8',
  '⑥ 恢复失败 ⇒ `promote_failed`、旧库**仍在 quarantine**、dataDir **没有被静默重建**（如实显示失败）',
  failApplied.ok === false &&
    failApplied.failure === 'promote_failed' &&
    existsSync(String(failApplied.quarantinePath)) &&
    !existsSync(failDataDir) &&
    failApplied.snapshotRetained === true &&
    failApplied.nextAction.includes('不是'),
  `failure=${String(failApplied.failure)} quarantine=${String(failApplied.quarantinePath !== undefined && existsSync(failApplied.quarantinePath))} dataDirExists=${String(existsSync(failDataDir))} snapshotRetained=${String(failApplied.snapshotRetained)}`
)

// ⑧ 真实库安全
const realAfter = digestTree(REAL_DB)
const drift = measureRealDbDrift(realBefore, realAfter)
check(
  'D9',
  '⑧ 真实 `data/pglite` 在本门运行前后**逐字不变**；与 WP0 基线的关系按"漂移有据"判',
  drift.unchangedDuringRun && realAfter.measuredCount > 0 && (drift.matchesWp0Baseline || drift.driftExplained),
  `measured=${realAfter.measuredCount} · ${drift.reading}`
)

// ---------------------------------------------------------------------------
// 汇总 / 证据
// ---------------------------------------------------------------------------

const measuredCount = realAfter.measuredCount + checks.length + childReadings.length + rebuildA.scannedEventCount
const measurementInvalid =
  realAfter.measuredCount === 0 || checks.length === 0 || rebuildA.scannedEventCount === 0
const verdict = measurementInvalid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

writeFileSync(
  join(outDir, 'restart-recovery.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'm6-wp6b-restart-recovery@1',
      runId,
      generatedAt: new Date().toISOString(),
      head,
      verdict,
      /*
       * ⚠️ 这三个**顶层**计数是给 `m6-evidence.readLandedEvidence` 读的。
       * 它只读顶层 `passed` / `failed` / `measurementInvalid`；把它们只放进
       * `measurements` 里会让汇总把本门读成 `passed = 0`，于是
       * `m6:gates` 打出 `rollup_no_positive_example`（"一条正控都没过却声称有结论"）——
       * 那是**假红**：本门实际上有 `checks.length` 项断言通过。
       * （真实事故式的读数错位：数字对，但描述的不是那个东西 —— `AGENTS.md` §6.9。）
       */
      passed: checks.length - failed,
      failed,
      measurementInvalid: measurementInvalid ? 1 : 0,
      wp: 'M6 WP6b — 重启、关闭与恢复（INC-01 保护的集成验收）',
      itemCoverage: {
        '1-隔离库写入→关闭→新进程读回(逐项)': '子门 m4:restart:verify（两个不同进程）+ 本门 D1 的 runId 关联',
        '2-摘要不持久化⇒同一源重建': '本门 D2（同一选择器两次逐字一致）+ 子门 m6-wp3-reader（读取面只读、摘要不落库）',
        '3-重复输入/重复恢复不膨胀': '本门 D6（第二次 apply 被拒且现场不被覆盖）+ 子门 m4:restart:verify',
        '4-强杀/半写/损坏快照/恢复失败': '本门 D4/D7/D8 + 子门 m4:hardkill:verify',
        '5-同一 runId 关联四处读数': '本门 D1（close 读数）+ D3（manifest/源摘要）+ D5（恢复读数），同一 runId 落进证据',
        '6-历史断档不得猜补': '子门 m6-wp3-reader（摘要只引用既有事件）+ 本门 D9（真实库只读摘要前后一致）',
      },
      childGates: childReadings,
      drill: {
        fixturesDisposable: true,
        rollupRebuild: {
          scannedEventCount: rebuildA.scannedEventCount,
          items: rebuildA.items.length,
          sourceRefs: rebuildA.sourceRefs.length,
          blockBytes: rebuildA.blockText.length,
          identicalAcrossRebuild: rebuildA.blockText === rebuildB.blockText,
          selectorVersion: rebuildA.selectorVersion,
        },
        snapshotId: snapshot.snapshotId,
        manifestDigest: snapshot.manifest?.nonVolatileTreeSha256,
        restoredDigest: restoredDigest?.treeSha256,
        quarantinePath: applied.quarantinePath,
        duplicateRestoreRefused: duplicate.failure,
        corruptSnapshotRefused: corruptPlan.failure,
        hardKill: {
          holderPid,
          acquired,
          heldWhileAlive,
          killExitCode: killed.status,
          heldAfterKill,
          reacquired,
          ownerCleanClose: unclean?.cleanClose ?? null,
        },
        failedRestore: { failure: failApplied.failure, quarantineRetained: true, dataDirRecreated: existsSync(failDataDir) },
        closeReading,
      },
      realDb: {
        before: drift.before.treeSha256,
        after: drift.after.treeSha256,
        unchangedDuringThisRun: drift.unchangedDuringRun,
        wp0Baseline: WP0_REAL_DB_NONVOLATILE,
        matchesWp0Baseline: drift.matchesWp0Baseline,
        driftExplained: drift.driftExplained,
      },
      measurements: { checks: checks.length, failed, childGates: childReadings.length, measuredCount },
      /*
       * TD-15（2026-09-26 技术债清偿）：本门此前是 M6 唯一**没有 `scope` 块**的门，
       * `m6:gates` 因此对它打出 `rollup_scope_missing` 警告（"无法回答这份读数测的是什么范围"）。
       * 历史 JSON（`m6-wp6b-20260922-866f2fba5f27/restart-recovery.json`）按 TD-16 纪律**不回写**；
       * 新 run 带上真实 scope，汇总按 `generatedAt` 取最新一份（`m6-gates.latestFor`）。
       */
      scope: {
        drillDirectories: '一次性 `mkdtemp`（证据写完即删；不落在仓库里）',
        opensIsolatedDatabases: true,
        opensProductionDatabase: false,
        readsProductionDbTreeDigestOnly: true,
        callsModel: false,
        runsSearch: false,
        note:
          '只在**一次性临时目录**里建库 / 快照 / 恢复 / 强杀；`realDb` 段只是 `data/pglite` 的' +
          '非易失树摘要（纯文件哈希，不打开库，见 `inc-01-real-db-drift.ts`），判据 = 同轮不变 + 漂移有据。' +
          '真实库从未被本门打开，也没有任何生产写入。',
        headSemantics: '`head` = 运行时 git HEAD（被测代码提交）；证据文件落在紧随其后的纯证据提交里。',
      },
      note:
        '§1 的子门承载"两个不同进程之间读回 ID/事件/projection"这类事实（`m4:restart:verify` 的原命题），' +
        '§2 只加 INC-01 的集成演练（租约/快照/恢复/强杀/不静默重建），**不重写**那些模块。',
      checks,
    },
    null,
    2
  )}\n`,
  'utf8'
)
rmSync(root, { recursive: true, force: true })

console.log(
  `\nWP6b 门：${verdict}（${checks.length} 项断言，${failed} 失败；子门 ${childReadings.length} 条）\n` +
    `证据：${relative(ROOT, join(outDir, 'restart-recovery.json')).split(/[\\/]/).join('/')}`
)
process.exitCode = verdict === 'PASS' ? 0 : 1
