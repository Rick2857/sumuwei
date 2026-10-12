/**
 * M5.1.1 WP2.3 —— **K-19 证据完整性门**（`pnpm m5.1.1:k19:verify`）。
 *
 * ============================================================================
 *  它防的是什么
 * ============================================================================
 * `pnpm m5.1.1:test` 产出的两个 artifact
 *
 *     artifacts/m5.1.1/wp1-contracts.json
 *     artifacts/m5.1.1/wp1-axis-b-closure.json
 *
 * 是**已完成的 WP1 / WP1.1 的权威证据**（注册门 `M511-G1` 的证据文件）。
 *
 * 修好之前，**每一次**跑 `m5.1.1:test` 都会无条件重写它们。于是"顺手重跑一次"
 * 就把里面的真实退出码 `0` 改写成 `null` —— 而两次运行的 stdout 都打印
 * `证据已写入：…`，**从输出上完全看不出证据被降级了**。
 *
 * 修好之后（`scripts/kernel-tests-m5.1.1.ts`）：
 *
 *   普通 test execution                                → **一个字节都不写**
 *   显式 `M511_AUTHORITATIVE_EVIDENCE=1` 且四路测量输入齐全 → 才允许写
 *   输入缺失 / 会把已量到的值写成 null                    → **拒绝写 + 非 0 退出**
 *
 * ============================================================================
 *  三段式（量具自己也要被验证，AGENTS §6.7）
 * ============================================================================
 *   正控：裸跑 ⇒ 两个 artifact 的 sha256 **逐字节不变**
 *   负控：不给测量输入 ⇒ 必须**拒绝写**（两种原因各测一次）
 *   恢复：把合法输入放回去 ⇒ **授权写入重新工作**（在临时目录里，不碰仓库证据）
 *
 * ⚠️ 两件"看起来过了其实是空转"的事，本门专门防：
 *
 *   ① 若裸跑**根本没跑起来**（编译错 / 崩了），artifact 当然也不会变 —— 那不叫正控。
 *      所以必须同时断言裸跑 `exit 0` **且** `M511_TEST_SUMMARY` 里 `passed > 0`。
 *   ② 若哈希比较器**永远说"相同"**，正控恒过。所以要用**真实文件**做一次注入式负控：
 *      把 artifact 复制到临时目录、追加一个字节，比较器必须报"不同"。
 *
 * ⚠️ 本门**不**用仓库目录做"拒绝写入"的负控：那要求"守卫一定是对的"才安全，
 *    而这正是本门要验证的东西。所有注入都在临时目录里做。
 *
 * 跑法：pnpm m5.1.1:k19:verify
 */

import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []
const transcript: Record<string, unknown>[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const AUTHORITATIVE_ARTIFACTS = ['wp1-contracts.json', 'wp1-axis-b-closure.json'] as const
const MEASUREMENT_INPUT_KEYS = ['typecheck', 'kernelTest', 'conversation', 'frozenAreaRegressionM4Ci'] as const

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// 哈希快照与比较器
// ---------------------------------------------------------------------------

type Snapshot = { file: string; exists: boolean; sha256: string; bytes: number }

function snapshotOne(dir: string, fileName: string): Snapshot {
  const path = join(dir, fileName)
  if (!existsSync(path)) return { file: fileName, exists: false, sha256: '', bytes: 0 }
  const buffer = readFileSync(path)
  return {
    file: fileName,
    exists: true,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
  }
}

function snapshotAll(dir: string): Snapshot[] {
  return AUTHORITATIVE_ARTIFACTS.map((fileName) => snapshotOne(dir, fileName))
}

function sameSnapshots(a: readonly Snapshot[], b: readonly Snapshot[]): boolean {
  return a.every((left, index) => {
    const right = b[index]
    return (
      right !== undefined &&
      left.file === right.file &&
      left.exists === right.exists &&
      left.sha256 === right.sha256 &&
      left.bytes === right.bytes
    )
  })
}

function describe(a: readonly Snapshot[], b: readonly Snapshot[]): string {
  return a
    .map((left, index) => {
      const right = b[index]
      if (left.sha256 === right?.sha256 && left.exists === right?.exists) return `${left.file}=同`
      return `${left.file}=变(${left.exists ? left.sha256.slice(0, 10) : '缺'}→${right?.exists ? right.sha256.slice(0, 10) : '缺'})`
    })
    .join(' | ')
}

// ---------------------------------------------------------------------------
// 跑 m5.1.1:test（真·pnpm 脚本，等价于"裸跑"）
// ---------------------------------------------------------------------------

type RunResult = {
  command: string
  status: number
  summary: Record<string, unknown> | null
  stdoutTail: string
  combined: string
}

function runTest(env: NodeJS.ProcessEnv, note: string): RunResult {
  const result = spawnSync('pnpm', ['m5.1.1:test'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const combined = `${stdout}\n${stderr}`
  const matched = combined.match(/M511_TEST_SUMMARY (\{[^\n]*\})/)
  let summary: Record<string, unknown> | null = null
  if (matched?.[1] !== undefined) {
    try {
      summary = JSON.parse(matched[1]) as Record<string, unknown>
    } catch {
      summary = null
    }
  }
  const record: RunResult = {
    command: note,
    status: result.status ?? -1,
    summary,
    stdoutTail: stdout.trim().split('\n').slice(-12).join('\n'),
    combined,
  }
  transcript.push({
    note,
    status: record.status,
    summary: record.summary,
    authoritativeRequested: env.M511_AUTHORITATIVE_EVIDENCE === '1',
    evidenceDirOverridden: env.M511_EVIDENCE_DIR !== undefined,
  })
  return record
}

/** 裸跑环境：显式抹掉可能从外面带进来的授权开关 */
const nakedEnv: NodeJS.ProcessEnv = { ...process.env }
delete nakedEnv.M511_AUTHORITATIVE_EVIDENCE
delete nakedEnv.M511_EVIDENCE_DIR
delete nakedEnv.M511_TYPECHECK_EXIT
delete nakedEnv.M511_KERNEL_TEST_EXIT
delete nakedEnv.M511_CONVERSATION_EXIT
delete nakedEnv.M511_M4_CI_EXIT

console.log('='.repeat(74))
console.log('M5.1.1 WP2.3 —— K-19 证据完整性门（权威 artifact 不得被顺手重写）')
console.log('='.repeat(74))
console.log(`ROOT = ${ROOT}`)
console.log(`tsx  = ${existsSync(tsxCli) ? 'found' : 'MISSING'}`)

// ===========================================================================
section('0. 量具自检：哈希与比较器本身（不做这一步，正控可能是空转）')
// ===========================================================================

const probeDir = makeTempDir('k19-probe-')
cpSync(join(EVIDENCE_DIR, 'wp1-contracts.json'), join(probeDir, 'wp1-contracts.json'))
cpSync(join(EVIDENCE_DIR, 'wp1-axis-b-closure.json'), join(probeDir, 'wp1-axis-b-closure.json'))

const probePristine = snapshotAll(probeDir)
{
  const bytes = probePristine.reduce((sum, item) => sum + item.bytes, 0)
  measure('自检里被哈希的真实文件数', probePristine.filter((item) => item.exists).length)
  measure('自检里被哈希的真实字节数', bytes)
  check(
    '同两份文件自比 ⇒ 判定"未变"（比较器不会恒报"变"）',
    sameSnapshots(probePristine, snapshotAll(probeDir)),
    describe(probePristine, snapshotAll(probeDir))
  )

  // 注入：往**真实文件的副本**追加一个字节
  const target = join(probeDir, 'wp1-contracts.json')
  writeFileSync(target, `${readFileSync(target, 'utf8')} `, 'utf8')
  const mutated = snapshotAll(probeDir)
  const detected = sameSnapshots(probePristine, mutated) ? 0 : 1
  measure('比较器在真实文件上检出的注入次数', detected)
  check(
    '真实文件被追加一个字节 ⇒ 判定"已变"（比较器不是橡皮图章）',
    detected === 1,
    describe(probePristine, mutated)
  )
}

// ===========================================================================
section('1. 正控：裸跑 m5.1.1:test ⇒ 权威证据逐字节不变')
// ===========================================================================

const before = snapshotAll(EVIDENCE_DIR)
measure('被哈希的权威 artifact 数', before.filter((item) => item.exists).length)
measure('被哈希的权威 artifact 字节总数', before.reduce((sum, item) => sum + item.bytes, 0))
check(
  '两个权威 artifact 都在（缺一个就不是有效测量）',
  before.every((item) => item.exists),
  before.map((item) => `${item.file}:${item.exists ? item.bytes : 'MISSING'}`).join(' | ')
)

const naked = runTest(nakedEnv, 'naked（无授权开关、无测量输入）')
check('裸跑 m5.1.1:test exit = 0', naked.status === 0, `status=${naked.status}`)
const nakedSummary = naked.summary
check(
  '裸跑**真的跑了测试**（passed > 0 且 failed = 0）—— 防"没跑起来所以文件没变"的空转',
  nakedSummary !== null &&
    typeof nakedSummary.passed === 'number' &&
    nakedSummary.passed > 0 &&
    nakedSummary.failed === 0,
  nakedSummary ? `passed=${String(nakedSummary.passed)} failed=${String(nakedSummary.failed)}` : 'M511_TEST_SUMMARY 未找到'
)
measure('裸跑实际通过的测试数', typeof nakedSummary?.passed === 'number' ? nakedSummary.passed : 0)
check(
  '裸跑自述：未授权写入、evidenceWritten 为空',
  nakedSummary?.authoritativeWriteAllowed === false &&
    Array.isArray(nakedSummary?.evidenceWritten) &&
    (nakedSummary.evidenceWritten as unknown[]).length === 0,
  JSON.stringify(nakedSummary?.evidenceWritten ?? null)
)

const afterNaked = snapshotAll(EVIDENCE_DIR)
const nakedUnchanged = sameSnapshots(before, afterNaked)
check('★ 裸跑后两个权威 artifact 的 sha256 **逐字节不变**', nakedUnchanged, describe(before, afterNaked))

// ===========================================================================
section('2. 负控：不给测量输入 ⇒ 必须拒绝写（fail closed）')
// ===========================================================================

// 2a：既有证据里已量到 0，若允许写就会变成 null ⇒ 必须被拒（measured-downgrade）
const refusalDir = makeTempDir('k19-refusal-')
cpSync(join(EVIDENCE_DIR, 'wp1-contracts.json'), join(refusalDir, 'wp1-contracts.json'))
const refusalBefore = snapshotAll(refusalDir)
const downgradeRun = runTest(
  { ...nakedEnv, M511_AUTHORITATIVE_EVIDENCE: '1', M511_EVIDENCE_DIR: refusalDir },
  'authoritative=1 + 无测量输入 + 既有 0（应拒绝：measured-downgrade）'
)
check('2a exit != 0（fail closed）', downgradeRun.status !== 0, `status=${downgradeRun.status}`)
check(
  '2a 拒绝原因 = measured-downgrade（**禁止 existing 0 → null**）',
  downgradeRun.combined.includes('reason=measured-downgrade'),
  'K19_REFUSED_AUTHORITATIVE_WRITE reason=measured-downgrade'
)
check(
  '2a 被拒后 seeded artifact 逐字节不变（拒绝真的意味着不写）',
  sameSnapshots(refusalBefore, snapshotAll(refusalDir)),
  describe(refusalBefore, snapshotAll(refusalDir))
)

// 2b：没有既有证据、且测量输入缺失 ⇒ 必须被拒（missing-measurement-input），且不建目录
const emptyBase = makeTempDir('k19-empty-')
const emptyDir = join(emptyBase, 'artifacts', 'm5.1.1')
const missingRun = runTest(
  { ...nakedEnv, M511_AUTHORITATIVE_EVIDENCE: '1', M511_EVIDENCE_DIR: emptyDir },
  'authoritative=1 + 无测量输入 + 无既有证据（应拒绝：missing-measurement-input）'
)
check('2b exit != 0（fail closed）', missingRun.status !== 0, `status=${missingRun.status}`)
check(
  '2b 拒绝原因 = missing-measurement-input（四路必须齐全）',
  missingRun.combined.includes('reason=missing-measurement-input'),
  'K19_REFUSED_AUTHORITATIVE_WRITE reason=missing-measurement-input'
)
check(
  '2b 被拒后没有创建任何 artifact（连证据目录都不建）',
  !existsSync(emptyDir),
  emptyDir
)

const refusalsObserved = [downgradeRun, missingRun].filter((run) => run.status !== 0).length
measure('观察到的 fail-closed 拒绝次数', refusalsObserved)

// ===========================================================================
section('3. 恢复：给全四路测量输入 ⇒ 授权写入重新工作（临时目录）')
// ===========================================================================

const restoreDir = makeTempDir('k19-authorized-')
// 种一份**被标记过**的既有证据：若授权写入真的发生，字节必然不同
const seed = JSON.parse(readFileSync(join(EVIDENCE_DIR, 'wp1-contracts.json'), 'utf8')) as Record<string, unknown>
seed.testId = 'K19-RESTORE-SEED'
const restoreSeed = join(restoreDir, 'wp1-contracts.json')
writeFileSync(restoreSeed, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')
const restoreBefore = snapshotAll(restoreDir)

const authorized = runTest(
  {
    ...nakedEnv,
    M511_AUTHORITATIVE_EVIDENCE: '1',
    M511_EVIDENCE_DIR: restoreDir,
    M511_TYPECHECK_EXIT: '0',
    M511_KERNEL_TEST_EXIT: '0',
    M511_CONVERSATION_EXIT: '0',
    M511_M4_CI_EXIT: '0',
  },
  'authoritative=1 + 四路测量输入齐全（应真正写入）'
)
check('3 exit = 0（授权写入不是"一律拒绝"）', authorized.status === 0, `status=${authorized.status}`)
check(
  '3 自述：授权写入、两个 artifact 都写了',
  authorized.summary?.authoritativeWriteAllowed === true &&
    Array.isArray(authorized.summary?.evidenceWritten) &&
    (authorized.summary.evidenceWritten as unknown[]).length === 2,
  JSON.stringify(authorized.summary?.evidenceWritten ?? null)
)

const restoreAfter = snapshotAll(restoreDir)
measure('临时目录里成功的授权写入文件数', restoreAfter.filter((item) => item.exists).length)
check('3 两个 artifact 都落盘了', restoreAfter.every((item) => item.exists))
check(
  '3 既有证据**确实被改写**（证明恢复了写入能力，不是靠"不写"通过）',
  !sameSnapshots(restoreBefore, restoreAfter),
  describe(restoreBefore, restoreAfter)
)

const written = JSON.parse(readFileSync(join(restoreDir, 'wp1-contracts.json'), 'utf8')) as {
  suiteExits?: Record<string, unknown>
}
const writtenExits = written.suiteExits ?? {}
check(
  '3 写进去的是**量到的 0**，不是 null（existing 0 → null 被禁止，新写也必须是实数）',
  MEASUREMENT_INPUT_KEYS.every((key) => writtenExits[key] === 0),
  JSON.stringify(writtenExits)
)

// ===========================================================================
section('4. 恢复：全部门跑完后，仓库里的权威证据仍是最初那份')
// ===========================================================================

const final = snapshotAll(EVIDENCE_DIR)
const repoUntouched = sameSnapshots(before, final)
check('★ 仓库权威证据与门开始时逐字节一致', repoUntouched, describe(before, final))

// ===========================================================================
// 收尾
// ===========================================================================

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
console.log(`\n（临时目录已清理：${tempDirs.length} 个）`)

const measurementInvalid = measurements.filter((item) => !item.valid).length
const k19Verdict = failed === 0 ? 'PASS' : 'FAIL'

const evidence = {
  testId: 'M5.1.1 / WP2.3 K-19 evidence integrity',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:k19:verify',
  verdict: k19Verdict,
  k19: k19Verdict,
  passed,
  failed,
  failures,
  /** 用户指定的负控判据：裸跑后 WP1/WP1.1 artifact hash **有任何变化**即 FAIL */
  acceptanceCriterion: 'hash completed evidence → naked pnpm m5.1.1:test → hashes unchanged',
  authoritativeArtifacts: AUTHORITATIVE_ARTIFACTS.map((fileName) => ({
    path: `artifacts/m5.1.1/${fileName}`,
    ...snapshotOne(EVIDENCE_DIR, fileName),
  })),
  before,
  afterNaked,
  final,
  nakedRunUnchanged: nakedUnchanged,
  repoUntouched,
  refusals: [
    {
      case: 'measured-downgrade',
      status: downgradeRun.status,
      refused: downgradeRun.combined.includes('reason=measured-downgrade'),
      artifactUnchanged: sameSnapshots(refusalBefore, snapshotAll(refusalDir)),
    },
    {
      case: 'missing-measurement-input',
      status: missingRun.status,
      refused: missingRun.combined.includes('reason=missing-measurement-input'),
      createdNothing: !existsSync(emptyDir),
    },
  ],
  authorizedWriteWorks: {
    status: authorized.status,
    filesWritten: restoreAfter.filter((item) => item.exists).length,
    exitsRecorded: writtenExits,
  },
  transcript,
  measurements,
  measurementInvalid,
  scope: {
    readOnlyOnRepoEvidence: true,
    injectionsDoneInTempDirOnly: true,
    usedVerificationSeam: 'M511_EVIDENCE_DIR（只影响**授权**写入的落点）',
    startedWp3: false,
  },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(
  join(EVIDENCE_DIR, 'wp2.3-k19-evidence-integrity.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`WP2.3 K-19 证据完整性门：${passed} 通过 / ${failed} 失败｜K-19 = ${k19Verdict}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp2.3-k19-evidence-integrity.json')

process.exit(failed === 0 ? 0 : 1)
