/**
 * INC-01 **WP1 门** —— 跨进程独占租约 + owner 取证（`AT1.1`…`AT1.4`）。
 *
 * 用法：`node_modules\.bin\tsx scripts/verify-inc-01-wp1.ts`
 *
 * 判据（对应计划 §WP1 的 Tests / Negative Controls）：
 *   T1 相同 dataDir：第二个进程必须被拒，且**失败前没有创建/修改目标 dataDir 内任何文件**
 *   T2 不同 dataDir：两个进程可**同时**持有（租约是 per-path 的，不是全局锁）
 *   T3 owner record 字段注入（用户正文 / argv）⇒ schema **拒绝**
 *   T4 强杀释放：`taskkill /F` 后无需删任何锁文件即可重新取得租约，且 owner record 留下"未 clean"证据
 *   T5 管道建立失败 ⇒ **失败关闭**，绝不回落到"无锁继续"
 *   T6 真实库安全：整个门运行前后 `data/pglite` 非易失树摘要逐字相同，且等于 WP0 冻结基线
 *
 * 所有 fixture 都在 `%TEMP%`；本门**不打开真实库**，只对它做只读哈希（`AT1` 明文要求）。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  ProductionDbInUseError,
  ProductionDbLeaseError,
  acquireProductionLease,
  bindLeasePipe,
  digestTree,
  isLeaseHeld,
  leasePipeName,
  normalizeDataDir,
  ownerRecordPath,
  readOwnerRecord,
  writeOwnerRecord,
  type OwnerRecord,
} from '../src/infrastructure/persistence/production-db-safety.ts'

const TSX_CLI = resolve('node_modules/tsx/dist/cli.mjs')
const CHILD = resolve('scripts/inc-01-lease-child.ts')
const REAL_DB = resolve('data/pglite')
/** WP0 冻结的 `data/pglite` 非易失树摘要（见 incident 报告附录 A） */
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

const children: ChildProcess[] = []

interface ChildResult {
  pid: number
  line: string
  exitCode: number | null
}

function spawnLeaseChild(
  mode: 'hold' | 'try',
  dataDir: string,
  ownerDir: string
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_CLI, CHILD, mode, dataDir, ownerDir], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: process.cwd(),
    })
    children.push(child)
    let buffer = ''
    let settled = false
    const finish = (line: string, exitCode: number | null): void => {
      if (settled) return
      settled = true
      resolvePromise({ pid: child.pid ?? -1, line, exitCode })
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        rejectPromise(new Error(`子进程 ${mode} 超时（60s）未给出协议行；buffer=${JSON.stringify(buffer)}`))
      }
    }, 60_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const match = /^(ACQUIRED|REJECTED)[^\n]*/m.exec(buffer)
      if (match) {
        clearTimeout(timer)
        finish(match[0].trim(), null)
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        rejectPromise(error)
      }
    })
    child.on('exit', (code) => {
      if (!settled) {
        clearTimeout(timer)
        finish(buffer.trim(), code)
      }
    })
  })
}

async function stopChildCleanly(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
  try {
    child.send?.('shutdown')
  } catch {
    child.kill()
  }
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, 5_000))])
  if (child.exitCode === null && child.signalCode === null) child.kill()
}

function hardKill(pid: number): void {
  execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
}

function fileStamp(path: string): string {
  if (!statExists(path)) return 'MISSING'
  const s = statSync(path)
  return `${s.size}@${s.mtime.toISOString()}`
}
function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

const root = mkdtempSync(join(tmpdir(), 'inc01-wp1-'))
const dirA = join(root, 'db-a')
const dirB = join(root, 'db-b')
const ownerDir = join(root, 'owners')
for (const dir of [dirA, dirB]) {
  mkdirSync(join(dir, 'base'), { recursive: true })
  writeFileSync(join(dir, 'PG_VERSION'), '17\n', 'utf8')
  writeFileSync(join(dir, 'base', 'rel.bin'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
}
mkdirSync(ownerDir, { recursive: true })

const realDbBefore = digestTree(REAL_DB)
const realDbStampsBefore = {
  pgControl: fileStamp(join(REAL_DB, 'global', 'pg_control')),
  postmasterPid: fileStamp(join(REAL_DB, 'postmaster.pid')),
}

const evidence: Record<string, unknown> = {
  incident: 'INC-01',
  wp: 'WP1',
  generatedAt: new Date().toISOString(),
  pipePrefixSample: leasePipeName(dirA),
  normalizedDirASample: normalizeDataDir(dirA),
  realDb: {
    path: 'data/pglite',
    nonVolatileTreeBefore: realDbBefore.treeSha256,
    measuredCount: realDbBefore.measuredCount,
    stampsBefore: realDbStampsBefore,
  },
  tests: {},
}

try {
  // -------------------------------------------------------------------------
  // T1 相同 dataDir：第二个进程被拒，且失败前未动目标目录
  // -------------------------------------------------------------------------
  const holderA = await spawnLeaseChild('hold', dirA, ownerDir)
  const dirADigestBeforeReject = digestTree(dirA)
  let t1Error: string = 'NO ERROR'
  let t1Rejected = false
  try {
    const lease = await acquireProductionLease({
      dataDir: dirA,
      operationKind: 'read_only_cli',
      ownerRecordDir: ownerDir,
    })
    await lease.release({ cleanClose: true })
  } catch (error) {
    t1Rejected = error instanceof ProductionDbInUseError
    t1Error = `${(error as { code?: string }).code}: ${(error as Error).message}`
  }
  const dirADigestAfterReject = digestTree(dirA)
  check('T1a', '相同 dataDir：第二个持有者被拒（production_db_in_use）', t1Rejected, t1Error)
  check(
    'T1b',
    '失败关闭：被拒之前没有创建/修改目标 dataDir 内任何文件',
    dirADigestBeforeReject.treeSha256 === dirADigestAfterReject.treeSha256,
    `digest ${dirADigestBeforeReject.treeSha256.slice(0, 16)}… → ${dirADigestAfterReject.treeSha256.slice(0, 16)}… (n=${dirADigestAfterReject.measuredCount})`
  )
  check('T1c', '子进程确实持有租约（isLeaseHeld 探测为真）', await isLeaseHeld(dirA), 'isLeaseHeld(dirA)=true')

  // -------------------------------------------------------------------------
  // T2 不同 dataDir：可同时持有
  // -------------------------------------------------------------------------
  let t2Pass = false
  let t2Reading = 'NO ACQUIRE'
  try {
    const leaseB = await acquireProductionLease({
      dataDir: dirB,
      operationKind: 'read_only_cli',
      ownerRecordDir: ownerDir,
    })
    t2Pass = true
    t2Reading = `dirA 由子进程(pid=${holderA.pid})持有；本进程同时取得 dirB：${leaseB.pipeName.slice(-12)}`
    await leaseB.release({ cleanClose: true })
  } catch (error) {
    t2Reading = `${(error as { code?: string }).code}: ${(error as Error).message}`
  }
  check('T2', '不同 dataDir：两进程可同时持有（租约 per-path，不是全局锁）', t2Pass, t2Reading)

  await stopChildCleanly(children[0] as ChildProcess)

  // -------------------------------------------------------------------------
  // T3 owner record 字段注入必须被拒
  // -------------------------------------------------------------------------
  const injectPath = ownerRecordPath(dirA, ownerDir)
  let t3aPass = false
  let t3aReading = 'NO ERROR'
  try {
    writeOwnerRecord(injectPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      operationKind: 'chat',
      runtimeId: 'runtime_test_inject',
      // @ts-expect-error 故意注入不在白名单里的字段（模拟"把用户正文/argv 写进取证"）
      question: '用户原话不应该出现在取证文件里',
    })
  } catch (error) {
    t3aPass = error instanceof ProductionDbLeaseError
    t3aReading = (error as Error).message
  }
  check('T3a', 'owner record 注入额外字段被 schema 拒绝', t3aPass, t3aReading)

  let t3bPass = false
  let t3bReading = 'NO ERROR'
  try {
    writeOwnerRecord(injectPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      // @ts-expect-error 非法 operationKind
      operationKind: 'not_a_frozen_kind',
      runtimeId: 'runtime_test_inject',
    })
  } catch (error) {
    t3bPass = error instanceof ProductionDbLeaseError
    t3bReading = (error as Error).message
  }
  check('T3b', 'owner record 非法 operationKind 被拒（冻结枚举）', t3bPass, t3bReading)

  // -------------------------------------------------------------------------
  // T4 强杀释放（taskkill /F）—— 不需要删任何锁文件
  // -------------------------------------------------------------------------
  const hardHolder = await spawnLeaseChild('hold', dirB, ownerDir)
  const secondTry = await spawnLeaseChild('try', dirB, ownerDir)
  const secondRejected = secondTry.line.startsWith('REJECTED')
  hardKill(hardHolder.pid)
  await new Promise<void>((r) => setTimeout(r, 1_500))
  let t4Pass = false
  let t4Reading = 'NO ACQUIRE'
  let t4Unclean: OwnerRecord | undefined
  try {
    const lease = await acquireProductionLease({
      dataDir: dirB,
      operationKind: 'manual_snapshot',
      ownerRecordDir: ownerDir,
    })
    t4Pass = true
    t4Unclean = lease.previousUncleanExit
    t4Reading = `强杀后重新取得租约 OK（${lease.pipeName.slice(-12)}）；previousUncleanExit=${t4Unclean ? 'present' : 'absent'}`
    await lease.release({ cleanClose: true })
  } catch (error) {
    t4Reading = `${(error as { code?: string }).code}: ${(error as Error).message}`
  }
  const hardOwner = readOwnerRecord(ownerRecordPath(dirB, ownerDir))
  check('T4a', '强杀前：第二个子进程被拒', secondRejected, `line=${secondTry.line}`)
  check('T4b', 'taskkill /F 之后无需删锁文件即可重新取得租约', t4Pass, t4Reading)
  check(
    'T4c',
    '强杀留下的"未 clean 关闭"记录被隔离保留（下次启动仍能看到这条诊断事实）',
    t4Unclean !== undefined && t4Unclean.cleanClose !== true,
    `previousUncleanExit=${JSON.stringify(t4Unclean)}；当前持有者记录=${JSON.stringify(hardOwner)}`
  )

  // -------------------------------------------------------------------------
  // T5 管道建立失败 ⇒ 失败关闭（不回落为无锁继续）
  // -------------------------------------------------------------------------
  let t5Pass = false
  let t5Reading = 'NO ERROR'
  try {
    const server = await bindLeasePipe(`\\\\.\\pipe\\${'x'.repeat(300)}`)
    await new Promise<void>((r) => server.close(() => r()))
    t5Reading = '意外成功（BUG：坏管道名竟然绑上了）'
  } catch (error) {
    t5Pass =
      error instanceof ProductionDbLeaseError ||
      (error as { code?: string }).code === 'production_db_lease_failed'
    t5Reading = `${(error as { code?: string }).code}: ${(error as Error).message}`
  }
  check('T5', '租约管道建立失败 ⇒ 抛错失败关闭，不回落', t5Pass, t5Reading)

  evidence.tests = Object.fromEntries(checks.map((c) => [c.id, { desc: c.desc, pass: c.pass, reading: c.reading }]))
} finally {
  for (const child of children) await stopChildCleanly(child)
}

// ---------------------------------------------------------------------------
// T6 真实库安全：前后摘要逐字相同 + 等于 WP0 基线
// ---------------------------------------------------------------------------
const realDbAfter = digestTree(REAL_DB)
const stampsAfter = {
  pgControl: fileStamp(join(REAL_DB, 'global', 'pg_control')),
  postmasterPid: fileStamp(join(REAL_DB, 'postmaster.pid')),
}
const unchanged = realDbBefore.treeSha256 === realDbAfter.treeSha256
const matchesWp0 = realDbAfter.treeSha256 === WP0_REAL_DB_NONVOLATILE
check(
  'T6a',
  '本门运行前后 data/pglite 非易失树摘要逐字相同',
  unchanged,
  `${realDbBefore.treeSha256.slice(0, 16)}… → ${realDbAfter.treeSha256.slice(0, 16)}… (stamps ${JSON.stringify(realDbStampsBefore)} → ${JSON.stringify(stampsAfter)})`
)
check(
  'T6b',
  '模块实现复算出的真实库摘要 == WP0 冻结基线（跨 WP 一致性 + 真实库未被改动）',
  matchesWp0,
  `module=${realDbAfter.treeSha256} vs WP0=${WP0_REAL_DB_NONVOLATILE}`
)

const summary = {
  ...evidence,
  realDb: {
    ...(evidence.realDb as Record<string, unknown>),
    nonVolatileTreeAfter: realDbAfter.treeSha256,
    stampsAfter,
    unchanged,
    matchesWp0Baseline: matchesWp0,
  },
  checks,
  totals: { checks: checks.length, failed, measuredCount: realDbAfter.measuredCount },
  verdict: failed === 0 ? 'PASS' : 'FAIL',
}

mkdirSync('artifacts/incidents/inc-01', { recursive: true })
writeFileSync('artifacts/incidents/inc-01/wp1-lease.json', JSON.stringify(summary, null, 2) + '\n', 'utf8')
rmSync(root, { recursive: true, force: true })

console.log(
  `\nWP1 门：${summary.verdict}（${checks.length} 项断言，${failed} 失败）；证据 artifacts/incidents/inc-01/wp1-lease.json`
)
process.exitCode = failed === 0 ? 0 : 1
