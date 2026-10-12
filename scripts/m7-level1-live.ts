/**
 * M7 WP6-B · Level 1 —— **短场景运行器**（`pnpm with-test-model pnpm m7:live:level1`）。
 *
 * 计划 §7.2 Level 1：关系状态 × 探针的真模型回复。每场景：
 * ```text
 *   空沙箱 → 离线铺状态（播种器子进程；放行链本尊，零模型）
 *   → 1 次真探针轮（交互控制台 spawn；relationship flag ON——与生产激活形态一致）
 *   → 机器面：终态算式（±1e-9）+ relationship section 在场
 *   → 人审面：四查材料落 local/（未审不填）
 * ```
 *
 * 四个场景（工程参数，非冻结单——冻结单只冻了长轨迹；此处如实登记）：
 * ```text
 * L1-S1 基线     ORIGIN 0.85/0.60（探针轮开机自播——生产形状本尊）
 * L1-S2 受伤     +3×R-3（三窗口）⇒ 0.70/0.54/rev4/在案3
 * L1-S3 修复     +3×(R-3→R-4b supersede)（三窗口对）⇒ 0.94/0.60/rev7/在案0
 * L1-S4 久疏     +1×R-2 落在 10 天前 ⇒ 原始 0.87/0.62/rev2 · 读时侵蚀 ≈0.18
 * ```
 *
 * ⚠️ 不主张：语义面（回复口吻是否与状态相称）归人审四查，机器不判；
 * S4 的侵蚀**显示**由 WP5 离线门证过，此处只验状态原始值 + section 在场。
 */
import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const ROOT = resolve(process.cwd())
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const M7_LOCAL_PARENT = join(ROOT, 'artifacts', 'm7', 'local')
const TURN_TIMEOUT_MS = 10 * 60_000

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const resumeRunId = argValue('--resume')

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error('[m7:live:level1] wrapper_required：必须经测试包装器运行')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 场景表（期望终态 = 播种后 + 探针轮；探针文本中性、零关系词形）
 * ------------------------------------------------------------------------- */

interface Level1Scenario {
  readonly id: string
  readonly label: string
  readonly seed: boolean
  readonly probe: string
  readonly expected: {
    readonly trust: number
    readonly closeness: number
    readonly revision: number
    readonly accusationsInCase: number
  }
  /** 人审四查的侧重问题（材料里带出；判定权在人） */
  readonly reviewQuestion: string
}

const SCENARIOS: readonly Level1Scenario[] = [
  {
    id: 'L1-S1',
    label: '基线（ORIGIN 0.85/0.60）',
    seed: false,
    probe: '今天过得怎么样？',
    expected: { trust: 0.85, closeness: 0.6, revision: 1, accusationsInCase: 0 },
    reviewQuestion: '查三：基线口吻是否与"信赖但未拉满"的两维一致（不混谈）？',
  },
  {
    id: 'L1-S2',
    label: '受伤（+3×R-3 ⇒ 0.70/0.54/在案3）',
    seed: true,
    probe: '今天过得怎么样？',
    expected: { trust: 0.7, closeness: 0.54, revision: 4, accusationsInCase: 3 },
    reviewQuestion: '查四：指控在案期间，回复是否避免"我们一直很好"式表述？',
  },
  {
    id: 'L1-S3',
    label: '修复（3×supersede ⇒ 0.94/0.60/在案0）',
    seed: true,
    probe: '今天过得怎么样？',
    expected: { trust: 0.94, closeness: 0.6, revision: 7, accusationsInCase: 0 },
    reviewQuestion: '查四：撤回清账后，回复是否避免延续受伤口吻（既不记仇也不谄媚）？',
  },
  {
    id: 'L1-S4',
    label: '久疏（R-2 落 10 天前 ⇒ 原始 0.87/0.62 · 读时侵蚀 ≈0.18）',
    seed: true,
    probe: '今天过得怎么样？',
    expected: { trust: 0.87, closeness: 0.62, revision: 2, accusationsInCase: 0 },
    reviewQuestion: '查二/查三：久疏的回复是否如实反映距离（不假装昨天才见过）？',
  },
]

/* ---------------------------------------------------------------------------
 * 运行身份
 * ------------------------------------------------------------------------- */

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const runId = resumeRunId ?? createM7RunId({ wpId: 'wp6b-level1', headShort })
const modelRoute = modelRouteFromEnv(process.env as Record<string, string | undefined>, '测试端点包装器（pnpm with-test-model）')
const runDir = resumeRunId === undefined ? openM7RunDir(ROOT, runId) : join(ROOT, 'artifacts', 'm7', runId)
if (resumeRunId !== undefined && !existsSync(runDir)) throw new Error(`--resume ${runId}：目录不存在`)
const localDir = join(M7_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })
if (spawnSync('git', ['check-ignore', localDir], { cwd: ROOT, encoding: 'utf8' }).status !== 0) {
  console.error(`[m7:live:level1] local_not_ignored：${localDir} 未被忽略 ⇒ 拒绝写正文`)
  process.exit(2)
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

console.log('='.repeat(78))
console.log('M7 WP6-B · Level 1 短场景（4 状态 × 1 探针 · relationship ON）')
console.log('='.repeat(78))
console.log(`  runId      ${runId}`)
console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（只摘要）`)
console.log('')

/* ---------------------------------------------------------------------------
 * 探针轮（交互控制台；flag ON——与生产激活形态一致）
 * ------------------------------------------------------------------------- */

function spawnProbeTurn(dbDir: string, text: string): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PGLITE_DATA_DIR: dbDir,
      PROJECT_LG_SANDBOX: dbDir,
      CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
      USER_NAME: 'Alex',
    }
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let exitSent = false
    const finish = (status: number, extraErr = ''): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(hardTimer)
      resolveSpawn({ status, stdout, stderr: `${stderr}${extraErr}`, durationMs: Date.now() - started })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('error', (e) => finish(-1, `\n${String(e)}`))
    child.on('close', (s) => finish(s ?? -1))
    const hardTimer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } finish(-1, '\n(hard timeout ⇒ killed)') }, TURN_TIMEOUT_MS)
    child.stdin?.write(`${text}\n`)
    const pollTimer = setInterval(() => {
      if (!exitSent && stdout.includes('苏沐薇:')) {
        exitSent = true
        child.stdin?.write('/exit\n')
      }
    }, 200)
  })
}

/** 读数（复用轨迹读数器子进程） */
function readState(dbDir: string, out: string): { ok: boolean; reading?: unknown; reason?: string } {
  const result = spawnSync(
    process.execPath,
    [TSX_CLI, 'scripts/m7-trajectory-read.ts', '--db-dir', dbDir, '--out', out, '--from-end', '0', '--user-name', 'Alex'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 }
  )
  if (result.status !== 0 || !existsSync(out)) {
    return { ok: false, reason: `读数器退出码 ${String(result.status)}：${String(result.stderr).slice(-200)}` }
  }
  return { ok: true, reading: JSON.parse(readFileSync(out, 'utf8')) as unknown }
}

/* ---------------------------------------------------------------------------
 * 逐场景执行
 * ------------------------------------------------------------------------- */

interface ScenarioRow {
  readonly id: string
  readonly seedOk: boolean
  readonly probeStatus: number
  readonly replyChars: number
  readonly relationshipSectionPresent: boolean
  readonly stateMatches: boolean
  readonly stateActual: string
  readonly problems: readonly string[]
}

let rows: ScenarioRow[] = []
const partialPath = join(runDir, 'scenarios.partial.jsonl')
if (existsSync(partialPath)) {
  for (const line of readFileSync(partialPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() !== '') rows.push(JSON.parse(line) as ScenarioRow)
  }
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

/* 续跑纪律：有问题的行**重试**（新沙箱重铺），干净的行跳过 */
const retryIds = new Set(rows.filter((r) => r.problems.length > 0).map((r) => r.id))
rows = rows.filter((r) => !retryIds.has(r.id))

for (const scenario of SCENARIOS) {
  if (rows.some((r) => r.id === scenario.id && r.problems.length === 0)) continue
  const work = mkdtempSync(join(tmpdir(), `project-lg-m7-l1-${scenario.id.toLowerCase()}-`))
  const dbDir = join(work, 'pglite')
  mkdirSync(dbDir, { recursive: true })
  if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：沙箱被判成生产库')
  const problems: string[] = []

  /* ① 离线铺状态（S1 跳过——探针轮开机自播） */
  let seedOk = true
  if (scenario.seed) {
    const seedOut = join(runDir, `${scenario.id}-seed.json`)
    const seeded = spawnSync(
      process.execPath,
      [TSX_CLI, 'scripts/m7-level1-seed.ts', '--db-dir', dbDir, '--scenario', scenario.id, '--out', seedOut, '--user-name', 'Alex'],
      { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60_000 }
    )
    seedOk = seeded.status === 0 && existsSync(seedOut)
    if (!seedOk) problems.push(`播种失败（exit ${String(seeded.status)}）：${String(seeded.stderr).slice(-200)}`)
  }

  /* ② 真探针轮 */
  const said = await spawnProbeTurn(dbDir, scenario.probe)
  const reply = extractReply(said.stdout)
  if (said.status !== 0) problems.push(`探针轮 exit ${String(said.status)}`)
  if (reply === '') problems.push('回复未捕获')

  /* ③ 机器面读数 */
  const readOut = join(runDir, `${scenario.id}-reading.json`)
  const reading = readState(dbDir, readOut)
  let relationshipSectionPresent = false
  let stateMatches = false
  let stateActual = '(无读数)'
  if (reading.ok) {
    const r = reading.reading as {
      projection: { trust: number | null; closeness: number | null; revision: number | null; accusationsInCase: number } | null
      traces: { picked: { sections: readonly string[] } | null } | null
    }
    relationshipSectionPresent = r.traces?.picked?.sections.includes('relationship') ?? false
    if (!relationshipSectionPresent) problems.push('末轮 trace 缺 relationship section')
    if (r.projection === null) {
      problems.push('投影未建档')
    } else {
      stateActual = `t=${String(r.projection.trust)} c=${String(r.projection.closeness)} r${String(r.projection.revision)} 在案${String(r.projection.accusationsInCase)}`
      stateMatches =
        r.projection.trust !== null &&
        near(r.projection.trust, scenario.expected.trust) &&
        r.projection.closeness !== null &&
        near(r.projection.closeness, scenario.expected.closeness) &&
        r.projection.revision === scenario.expected.revision &&
        r.projection.accusationsInCase === scenario.expected.accusationsInCase
      if (!stateMatches) {
        problems.push(
          `终态不符：期望 t=${String(scenario.expected.trust)} c=${String(scenario.expected.closeness)} r${String(scenario.expected.revision)} 在案${String(scenario.expected.accusationsInCase)}`
        )
      }
    }
  } else {
    problems.push(`读数失败：${String(reading.reason).slice(0, 150)}`)
  }

  const row: ScenarioRow = {
    id: scenario.id,
    seedOk,
    probeStatus: said.status,
    replyChars: reply.length,
    relationshipSectionPresent,
    stateMatches,
    stateActual,
    problems,
  }
  rows.push(row)
  writeFileSync(partialPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  /* 人审材料（local/；正文不进仓库） */
  writeFileSync(
    join(localDir, `${scenario.id}.md`),
    [
      `# ${scenario.id} · ${scenario.label}`,
      '',
      `> runId：${runId} · 探针：${scenario.probe}`,
      `> 机器读数：${stateActual} · relationship section：${relationshipSectionPresent ? '在场' : '缺失'}`,
      '',
      `**苏沐薇**：${reply === '' ? '（未捕获）' : reply}`,
      '',
      `**人审问题**：${scenario.reviewQuestion}`,
      '',
    ].join('\n'),
    'utf8'
  )
  console.log(
    `  ${scenario.id} ${scenario.label}：exit=${String(said.status)} · ${stateActual} · section ${relationshipSectionPresent ? '✓' : '✗'} · ${problems.length === 0 ? '机器面全过' : `${String(problems.length)} 问题`}`
  )
}

/* ---------------------------------------------------------------------------
 * 汇总 + manifest
 * ------------------------------------------------------------------------- */

const checks = [
  {
    id: 'L1-STATE',
    label: '四场景终态算式（±1e-9）+ relationship section 在场',
    actual: rows.map((r) => `${r.id}:${r.stateMatches && r.relationshipSectionPresent ? '✓' : '✗'}`).join(' '),
    pass: rows.length === SCENARIOS.length && rows.every((r) => r.stateMatches && r.relationshipSectionPresent && r.probeStatus === 0 && r.seedOk),
  },
]
const realDbAfter = digestTree(PRODUCTION_DB_DIR)
const realDbUnchanged = realDbAfter.treeSha256 === realDbBefore.treeSha256 && realDbAfter.measuredCount === realDbBefore.measuredCount
const verdict = checks.every((c) => c.pass) ? 'PASS' : 'FAIL'

const payload = {
  schema: 'm7-level1-verify@1',
  runId,
  capturedAt: new Date().toISOString(),
  head,
  modelRoute,
  scenarios: rows,
  checks,
  notProven: [
    '语义面（口吻与状态相称）归人审四查——材料已落 local/，未审不填',
    'S4 的侵蚀显示语义由 WP5 离线门证过；此处只验原始值 + section 在场',
    '场景参数是工程参数（冻结单只冻了长轨迹），已在运行器头如实登记',
  ],
  realDbUnchanged,
  verdict,
}
writeFileSync(join(runDir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM7Manifest(runDir, {
  runId,
  wp: 'wp6b-level1',
  head,
  headShort,
  branch: 'feature/m7-relationship',
  date: payload.capturedAt.slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'live-level1-shorts',
  counts: { total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length },
  phases: ['run', 'verify'],
  supersedes: null,
  notes: `4 状态 × 1 探针 · ${rows.map((r) => `${r.id}:${r.stateMatches ? 'ok' : 'MISMATCH'}`).join(' ')}`,
})

console.log('')
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} → ${c.actual}`)
}
console.log(`verdict: ${verdict} · 真实库${realDbUnchanged ? '未变' : '摘要不同（如实报）'}`)
process.exitCode = verdict === 'PASS' ? 0 : 1
