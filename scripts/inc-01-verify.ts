/**
 * INC-01 **聚合门**（`pnpm inc-01:verify`）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * 把 WP1–WP5 五道门收成一个读数，并回答一个单独看每道门都答不了的问题：
 *
 * ```text
 *   这五道门现在**同时**是绿的吗？它们读的是**同一份实现**吗？
 * ```
 *
 * 跑法（每一条都是独立进程，退出码被逐条记录）：
 * ```text
 *   verify-inc-01-wp2.ts   静默快照        → wp2-snapshot.json
 *   verify-inc-01-wp3.ts   收尾            → wp3-close.json
 *   verify-inc-01-wp4.ts   状态机 / 闸      → wp4-integration.json
 *   verify-inc-01-wp5.ts   恢复演练        → wp5-restore-drill.json
 * ```
 *
 * ⚠️ **刻意不重跑 `verify-inc-01-wp1.ts`**：它会重写
 *    `artifacts/incidents/inc-01/wp1-lease.json` —— 而那个文件是**用户既有的、
 *    未提交的 diff**（WP0/WP3 都登记过）。本门改为**读已落盘证据**并在读数里
 *    标明来源是 `landed-evidence（未重跑）`，而不是假装它是本次跑出来的。
 *
 * ⚠️ 本门**不碰真实库**：四道子门的判据里各自包含"真实库本门运行前后逐字不变"。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const ART = join(ROOT, 'artifacts/incidents/inc-01')
const TSX_CLI = resolve('node_modules/tsx/dist/cli.mjs')

interface GateResult {
  id: string
  script: string
  command: string
  mode: 'ran-now' | 'landed-evidence（未重跑）'
  exitCode: number | null
  verdict: string
  checks: number
  failed: number
  evidence: string
  scriptSha256: string | null
  note?: string
}

function sha256Of(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readVerdict(evidence: string): { verdict: string; checks: number; failed: number } {
  const path = join(ART, evidence)
  if (!existsSync(path)) return { verdict: 'NOT RUN', checks: 0, failed: 0 }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const measurements = (parsed.measurements ?? {}) as Record<string, unknown>
    const totals = (parsed.totals ?? {}) as Record<string, unknown>
    return {
      verdict: typeof parsed.verdict === 'string' ? parsed.verdict : 'NOT RUN',
      checks:
        typeof measurements.checks === 'number'
          ? measurements.checks
          : Array.isArray(parsed.checks)
            ? parsed.checks.length
            : typeof totals.checks === 'number'
              ? totals.checks
              : 0,
      failed:
        typeof parsed.failed === 'number'
          ? parsed.failed
          : typeof measurements.failed === 'number'
            ? measurements.failed
            : typeof totals.failed === 'number'
              ? totals.failed
              : 0,
    }
  } catch {
    return { verdict: 'UNREADABLE', checks: 0, failed: 0 }
  }
}

function runGate(script: string, evidence: string): GateResult {
  const scriptPath = join(ROOT, script)
  let exitCode: number | null = null
  let note: string | undefined
  try {
    execFileSync(process.execPath, [TSX_CLI, scriptPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    exitCode = 0
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    exitCode = failed.status ?? -1
    note = (failed.stdout ?? '').split('\n').filter((line) => line.startsWith('FAIL')).slice(0, 3).join(' | ')
  }
  const landed = readVerdict(evidence)
  return {
    id: script.replace(/^.*verify-inc-01-/, '').replace(/\.ts$/, ''),
    script,
    command: `pnpm exec tsx ${script}`,
    mode: 'ran-now',
    exitCode,
    verdict: landed.verdict,
    checks: landed.checks,
    failed: landed.failed,
    evidence,
    scriptSha256: sha256Of(scriptPath),
    ...(note !== undefined && note !== '' ? { note } : {}),
  }
}

// ---------------------------------------------------------------------------
// WP1：**读**已落盘证据（不重跑；见文件头）
// ---------------------------------------------------------------------------

const wp1Evidence = 'wp1-lease.json'
const wp1Landed = readVerdict(wp1Evidence)
const wp1: GateResult = {
  id: 'wp1',
  script: 'scripts/verify-inc-01-wp1.ts',
  command: 'pnpm exec tsx scripts/verify-inc-01-wp1.ts',
  mode: 'landed-evidence（未重跑）',
  exitCode: null,
  verdict: wp1Landed.verdict,
  checks: wp1Landed.checks,
  failed: wp1Landed.failed,
  evidence: wp1Evidence,
  scriptSha256: sha256Of(join(ROOT, 'scripts/verify-inc-01-wp1.ts')),
  note: '它会把**用户既有、未提交的** wp1-lease.json 重写掉 ⇒ 本门只读已落盘证据（WP3/WP4 都登记过这条纪律）',
}

// ---------------------------------------------------------------------------
// WP2–WP5：逐条真的跑（各自写自己的证据）
// ---------------------------------------------------------------------------

console.log('INC-01 聚合门：逐条运行 WP2–WP5（每条独立进程，退出码逐条记录）\n')
const ran: GateResult[] = [
  runGate('scripts/verify-inc-01-wp2.ts', 'wp2-snapshot.json'),
  runGate('scripts/verify-inc-01-wp3.ts', 'wp3-close.json'),
  runGate('scripts/verify-inc-01-wp4.ts', 'wp4-integration.json'),
  runGate('scripts/verify-inc-01-wp5.ts', 'wp5-restore-drill.json'),
]

const gates = [wp1, ...ran]
for (const gate of gates) {
  const mark = gate.exitCode === 0 && gate.verdict === 'PASS' ? '✅' : gate.exitCode === null ? '📄' : '❌'
  console.log(
    `  ${mark} ${gate.id.padEnd(4)} ${String(gate.mode).padEnd(26)} exit=${String(gate.exitCode ?? '(未跑)').padEnd(6)} ` +
      `verdict=${gate.verdict.padEnd(6)} checks=${gate.checks} failed=${gate.failed}`
  )
  if (gate.note !== undefined) console.log(`       ${gate.note}`)
}

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

const problems: string[] = []
if (wp1.verdict !== 'PASS') problems.push(`WP1 的已落盘 verdict = ${wp1.verdict}（期望 PASS）`)
for (const gate of ran) {
  if (gate.exitCode !== 0) problems.push(`${gate.id} 退出码 ${String(gate.exitCode)}（期望 0）`)
  if (gate.verdict !== 'PASS') problems.push(`${gate.id} 的落地 verdict = ${gate.verdict}（期望 PASS）`)
  if (gate.failed !== 0) problems.push(`${gate.id} 有 ${gate.failed} 条断言失败`)
  if (gate.scriptSha256 === null) problems.push(`${gate.id} 的脚本不存在（无法记录源码哈希）`)
}

/*
 * "同一份实现"：把本门跑动过的实现文件哈希记下来 ——
 * 这样"这个结论是由哪一版代码产生的"是可复核的，而不是靠时间戳猜。
 */
const implementationFiles = [
  'src/infrastructure/persistence/production-db-safety.ts',
  'src/infrastructure/persistence/production-open-guard.ts',
  'src/infrastructure/persistence/production-db-restore.ts',
  'src/infrastructure/persistence/runtime-shutdown.ts',
  'src/db/index.ts',
  'src/main.ts',
  'scripts/inc-01-real-db-drift.ts',
  'scripts/text-scan.ts',
]
const implementationHashes = Object.fromEntries(
  implementationFiles.map((file) => [file, sha256Of(join(ROOT, file))])
)
const missingHashes = implementationFiles.filter((file) => implementationHashes[file] === null)
if (missingHashes.length > 0) problems.push(`实现文件缺失：${missingHashes.join(', ')}`)

const verdict = problems.length === 0 ? 'PASS' : 'FAIL'
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

mkdirSync(ART, { recursive: true })
writeFileSync(
  join(ART, 'verify-aggregate.json'),
  `${JSON.stringify(
    {
      incident: 'INC-01',
      wp: 'WP6',
      generatedAt: new Date().toISOString(),
      head,
      verdict,
      gates,
      implementationHashes,
      refreshedEvidence: ran.map((gate) => gate.evidence),
      problems,
      scope: {
        reranWp1: false,
        reason: 'WP1 的门会重写用户既有、未提交的 wp1-lease.json ⇒ 只读已落盘证据',
        touchesRealDatabase: false,
        childGatesEachAssertRealDbUnchanged: true,
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(
  `\nINC-01 聚合门：${verdict}（${gates.length} 道门；问题 ${problems.length} 条）` +
    `${problems.length > 0 ? `\n  ${problems.join('\n  ')}` : ''}`
)
console.log(`证据：artifacts/incidents/inc-01/verify-aggregate.json`)
console.log(
  `  已刷新证据（子门各自写入）：${ran.map((gate) => gate.evidence).join(', ')}\n` +
    `  （这些是**本轮**的读数；wp1-lease.json 一个字节未动。）\n`
)
process.exitCode = verdict === 'PASS' ? 0 : 1
