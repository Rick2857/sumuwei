/**
 * 实用能力验收脚本（精确计算 / 文档阅读 / 网页深读 / OCR）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * `docs/post-lv2/Utility-Skills-Execution-Plan-2026-10-04.md`
 *   · §3  WP0「基线和测试入口 —— 建立一个验收脚本」
 *   · §4A 开发中短测：**一个脚本，按能力选择**（`--only math|document|web|ocr`）
 *   · §4A 首批固定 **32 组**：公共 8 组 + 每项 6 组
 *   · §4B 组合离线验收：运行**真实组件**和**实际 `TurnGateway`**，离线 provider 只替换模型服务
 *   · §4C 真模型短链：`--live`，八个固定场景，一次集中执行
 *   · §5  公开证据目录 `artifacts/post-lv2/utility-skills/<runId>/`，一份 `run.json`
 *
 * ============================================================================
 *  三条纪律（与仓库既有门同形）
 * ============================================================================
 * ① **未运行 = `NOT RUN`，不是 PASS**（AGENTS.md §6.4）：
 *    本脚本只为"真的跑过并真的判过"的组写 `PASS`/`FAIL`。缺 fixture manifest、
 *    缺 OCR 语言资产、缺 openssl ⇒ 如实 `NOT RUN` 并给出原因 ——
 *    于是"计划里有 32 组"与"实际跑了几组"在输出上**永远分得开**。
 *
 * ② **计数型判据必须自检 `measured_count > 0`**（AGENTS.md §6.8）：
 *    每个组都报它**实际执行了几条参数化输入**；`0 条输入 / 0 失败` 的结论是
 *    `MEASUREMENT INVALID`，不是 PASS。
 *
 * ③ **正控 / 负控 / 恢复三段式**（AGENTS.md §6.7）：公共第 ⑧ 组专测它。
 *
 * ============================================================================
 *  它测的是什么
 * ============================================================================
 * 计划书 §4B 逐字：运行**真实组件**与**实际 `TurnGateway`**，离线 provider 只替换
 * 模型服务；不能只测一个直接调用函数就宣称"聊天已接入"。
 *
 * ```bash
 * node node_modules/tsx/dist/cli.mjs scripts/utility-skills-verify.ts --only math
 * node node_modules/tsx/dist/cli.mjs scripts/utility-skills-verify.ts            # 32 组
 * node node_modules/tsx/dist/cli.mjs scripts/utility-skills-verify.ts --list     # 只打印形状
 * pnpm with-test-model pnpm utility:verify --live                                 # 八轮真模型短链
 * ```
 *
 * ⚠️ 真实库 `data/pglite` **一次都不打开**：所有轮次跑在 `isolateDatabase()` 的
 *    独立副本上（AGENTS.md §3/§5.1 的硬约束）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/utility-skills'
/** raw 内容（fixture、全文、模型输入输出）只放这里 —— 已 gitignore */
const LOCAL_PARENT = 'artifacts/post-lv2/local/utility-skills-preparation'
const DEFAULT_FIXTURES = `${LOCAL_PARENT}/fixtures`

/** 本批冻结的**相关源文件**（摘要进 run.json ⇒ 证据可追到执行源版本；只许追加） */
const SOURCE_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'src/main.ts',
  'src/kernel/app/flags.ts',
  'src/kernel/app/reply-guard-chain.ts',
  'src/kernel/action/action-result.ts',
  'src/kernel/action/executor-port.ts',
  'src/kernel/action/intent-detector.ts',
  'src/kernel/action/target-resolver.ts',
  'src/kernel/action/gateway.ts',
  'src/kernel/action/capability-registry.ts',
  'src/kernel/action/action-turn.ts',
  'src/kernel/action/restricted-math.ts',
  'src/kernel/action/utility-capabilities.ts',
  'src/kernel/action/utility-intent.ts',
  'src/kernel/action/turn-content-reply.ts',
  'src/kernel/app/turn-gateway.ts',
  'src/kernel/context/sections.ts',
  'src/kernel/recall/selector.ts',
  'src/kernel/contracts/context.ts',
  'src/kernel/contracts/turn-content.ts',
  'src/infrastructure/action/adapters/math-calculate.ts',
  'src/infrastructure/action/adapters/math-calculate-worker.ts',
  'src/infrastructure/action/adapters/document-read.ts',
  'src/infrastructure/action/adapters/web-read.ts',
  'src/infrastructure/action/adapters/image-ocr.ts',
  'src/infrastructure/action/adapters/image-ocr-worker.mjs',
  'src/infrastructure/action/adapters/image-ocr-worker.py',
  'src/infrastructure/action/adapters/rapid-ocr-assets.ts',
  'scripts/utility-skills/setup-rapidocr.ts',
  'scripts/utility-skills/rapidocr-requirements.lock.txt',
  'scripts/utility-skills/probe-rapidocr.ts',
  'src/infrastructure/action/adapters/sandbox-filesystem.ts',
  'scripts/utility-skills-verify.ts',
  'scripts/utility-skills/assembly.ts',
  'scripts/utility-skills/fixtures.ts',
  'scripts/utility-skills/groups.ts',
  'scripts/utility-skills/groups-document.ts',
  'scripts/utility-skills/groups-web.ts',
  'scripts/utility-skills/groups-ocr.ts',
  'scripts/utility-skills/transport.ts',
  'scripts/utility-skills/doc-runner.py',
]

// ---------------------------------------------------------------------------
// 计划与读数（形状在 `scripts/utility-skills/groups.ts` 里，与计划书表格一一对应）
// ---------------------------------------------------------------------------

import type { CaseReading, CaseStatus, Capability, GroupReading, GroupRunner, LiveScenario, VerifyContext } from './utility-skills/groups.ts'
import { GROUP_PLAN, LIVE_PLAN, RUNNERS, Suite } from './utility-skills/groups.ts'
import { runLive } from './utility-skills/live.ts'

export type { Capability, CaseReading, CaseStatus, GroupReading, GroupRunner, LiveScenario, VerifyContext }
export { GROUP_PLAN, LIVE_PLAN }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  only: Capability[]
  live: boolean
  list: boolean
  fixturesDir: string
  label: string
}

const ALL_CAPABILITIES: readonly Capability[] = ['math', 'document', 'web', 'ocr']

export function parseArgv(argv: readonly string[]): Cli {
  let only: Capability[] = [...ALL_CAPABILITIES]
  let live = false
  let list = false
  let fixturesDir = DEFAULT_FIXTURES
  let label = 'utility'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--only') {
      const raw = argv[i + 1]
      if (raw === undefined) throw new Error('--only 需要一个能力名（math|document|web|ocr，逗号分隔）')
      const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
      for (const part of parts) {
        if (!ALL_CAPABILITIES.includes(part as Capability)) {
          throw new Error(`--only 不认识 ${part}（只接受 ${ALL_CAPABILITIES.join('|')}）`)
        }
      }
      only = parts as Capability[]
      i += 1
      continue
    }
    if (arg === '--live') {
      live = true
      label = 'utility-live'
      continue
    }
    if (arg === '--list') {
      list = true
      continue
    }
    if (arg === '--fixtures') {
      const raw = argv[i + 1]
      if (raw === undefined) throw new Error('--fixtures 需要一个目录')
      fixturesDir = raw
      i += 1
      continue
    }
    if (arg === '--label') {
      const raw = argv[i + 1]
      if (raw === undefined) throw new Error('--label 需要一个标签')
      label = raw
      i += 1
      continue
    }
    throw new Error(`不认识的参数：${arg}`)
  }
  return { only, live, list, fixturesDir, label }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sha256File(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function runIdOf(label: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
  const head = git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'
  const suffix = createHash('sha256').update(`${label}${stamp}${process.pid}`).digest('hex').slice(0, 4)
  return `${label}-${stamp}-${head}-${suffix}`
}

function openRunDir(parent: string, runId: string): string {
  const dir = join(REPO_ROOT, parent, runId)
  if (existsSync(dir)) throw new Error(`runId 目录已存在，拒绝覆盖：${dir}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly runId: string
  readonly runDir: string
  readonly exitCode: number
  readonly groups: readonly GroupReading[]
}

export async function runVerify(cli: Cli): Promise<RunResult> {
  const startedAt = nowIso()
  const runId = runIdOf(cli.label)
  const runDir = openRunDir(EVIDENCE_PARENT, runId)
  const localDir = join(REPO_ROOT, LOCAL_PARENT, runId)
  mkdirSync(localDir, { recursive: true })

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`)
  }

  const selected = new Set<string>(
    GROUP_PLAN.filter((plan) => plan.capability === 'common' || cli.only.includes(plan.capability)).map(
      (plan) => plan.id
    )
  )

  const ctx: VerifyContext = {
    only: cli.only,
    live: cli.live,
    fixturesDir: resolve(REPO_ROOT, cli.fixturesDir),
    runDir,
    localDir,
    log,
  }

  const suite = new Suite(ctx)

  log(
    `[utility:verify] fixtures=${cli.fixturesDir}` +
      `（manifest ${suite.fixtures.manifestExists ? '在' : '**缺**'}，` +
      `${String(suite.fixtures.measuredCount)} 条，校验问题 ${String(suite.fixtures.problems.length)} 条）`
  )

  const groups: GroupReading[] = []
  let fatal: string | undefined
  try {
    for (const plan of GROUP_PLAN) {
      if (!selected.has(plan.id)) continue
      const runner: GroupRunner | undefined = RUNNERS.find((item) => item.id === plan.id)
      if (runner === undefined) {
        groups.push({
          id: plan.id,
          title: plan.title,
          status: 'NOT RUN',
          measuredCount: 0,
          cases: [],
          reason: '本组尚未实现（没有任何运行器注册到这张表）',
        })
        log(`[utility:verify] ${plan.id} NOT RUN（没有运行器）`)
        continue
      }
      const startedMs = Date.now()
      let reading: GroupReading
      try {
        reading = await runner.run(ctx, suite)
      } catch (error) {
        /*
         * ⚠️ 抛错的组**不吞**：它变成一条 FAIL 读数并带着错误消息 ——
         *    于是"缺失证据"（NOT RUN）与"跑了但炸了"（FAIL）在 run.json 里分得开，
         *    而且**后面各组与 run.json 都不会因此丢掉**。
         */
        reading = {
          id: plan.id,
          title: plan.title,
          status: 'FAIL',
          measuredCount: 0,
          cases: [],
          reason: `运行器抛错：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        }
      }
      groups.push({ ...reading, ms: Date.now() - startedMs })
      log(
        `[utility:verify] ${reading.id.padEnd(12)} ${reading.status.padEnd(20)} ` +
          `（${String(reading.measuredCount)} 条输入 · ${String(Date.now() - startedMs)}ms）` +
          (reading.reason !== undefined ? ` — ${reading.reason}` : '')
      )
    }
  } catch (error) {
    /* 保底：即使编排层自己炸了，也要把**已经拿到的**读数写盘 */
    fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log(`[utility:verify] **FATAL**：${fatal}`)
  }

  try {
    await suite.dispose()
  } catch (error) {
    log(`[utility:verify] 收尾失败（不影响读数）：${(error as Error).message}`)
  }

  const fixtureManifest = join(ctx.fixturesDir, 'manifest.json')
  const sourceHashes: Record<string, string> = {}
  for (const file of SOURCE_FILES) {
    const hash = sha256File(join(REPO_ROOT, file))
    if (hash !== undefined) sourceHashes[file] = hash
  }

  const counts = {
    pass: groups.filter((group) => group.status === 'PASS').length,
    fail: groups.filter((group) => group.status === 'FAIL').length,
    notRun: groups.filter((group) => group.status === 'NOT RUN').length,
    invalid: groups.filter((group) => group.status === 'MEASUREMENT INVALID').length,
    total: groups.length,
    measuredInputs: groups.reduce((sum, group) => sum + group.measuredCount, 0),
  }

  const run = {
    schemaVersion: 'utility-skills-run@1',
    runId,
    label: cli.label,
    mode: cli.live ? 'live' : 'offline',
    only: cli.only,
    head: git(['rev-parse', 'HEAD']),
    headShort: git(['rev-parse', '--short=12', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyEntries: git(['status', '--porcelain']).split('\n').filter((line) => line !== '').length,
    startedAt,
    endedAt: nowIso(),
    node: process.version,
    pnpm: safeVersion('pnpm', ['--version']),
    python: safeVersion('python', ['--version']),
    fixturesDir: cli.fixturesDir,
    fixturesManifest: existsSync(fixtureManifest) ? sha256File(fixtureManifest) : null,
    fixturesMeasured: suite.fixtures.measuredCount,
    fixturesProblems: suite.fixtures.problems,
    sourceHashes,
    counts,
    ...(fatal !== undefined ? { fatal } : {}),
    groups,
  }

  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8')

  log('')
  log(`[utility:verify] runId = ${runId}`)
  log(`[utility:verify] 证据 = ${EVIDENCE_PARENT}/${runId}/run.json`)
  log(
    `[utility:verify] 组：${String(counts.total)}（PASS ${String(counts.pass)} · FAIL ${String(counts.fail)} · ` +
      `NOT RUN ${String(counts.notRun)} · MEASUREMENT INVALID ${String(counts.invalid)}）· ` +
      `参数化输入 ${String(counts.measuredInputs)} 条`
  )
  for (const group of groups) {
    if (group.status === 'PASS') continue
    log(`[utility:verify] ${group.id} ${group.status}：${group.reason ?? '(无原因)'}`)
    for (const item of group.cases) {
      if (item.status !== 'FAIL') continue
      log(`[utility:verify]   · ${item.caseId} ${item.title}`)
      if (item.observed !== undefined) {
        log(`[utility:verify]     observed = ${JSON.stringify(item.observed).slice(0, 300)}`)
      }
    }
  }
  if (fatal !== undefined) log(`[utility:verify] fatal = ${fatal}`)

  const clean = counts.fail === 0 && counts.invalid === 0 && counts.notRun === 0 && counts.total > 0
  log(`[utility:verify] overall = ${clean ? 'PASS' : 'NOT PASS'}`)
  return { runId, runDir, exitCode: clean ? 0 : 1, groups }
}

function safeVersion(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], { encoding: 'utf8', shell: command === 'pnpm' }).trim()
  } catch {
    return ''
  }
}

/** `--list`：只打印形状，不跑任何东西、不写任何证据 */
export function listPlan(): void {
  process.stdout.write(`32 组计划（计划书 §4A）：\n`)
  for (const group of GROUP_PLAN) {
    process.stdout.write(`  ${group.id.padEnd(12)} [${group.capability.padEnd(8)}] ${group.title}\n`)
  }
  process.stdout.write(`\n--live 八轮场景（计划书 §4C）：\n`)
  for (const scenario of LIVE_PLAN) {
    process.stdout.write(
      `  ${scenario.id.padEnd(26)} [${scenario.capability}/${scenario.kind}] ${scenario.title}\n`
    )
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined && /utility-skills-verify\.ts$/.test(process.argv[1].replace(/\\/g, '/'))

if (isMain) {
  try {
    const cli = parseArgv(process.argv.slice(2))
    if (cli.list) {
      listPlan()
      process.exit(0)
    }
    if (cli.live) {
      const result = await runLive(cli)
      process.exit(result.exitCode)
    }
    const result = await runVerify(cli)
    process.exit(result.exitCode)
  } catch (error) {
    process.stderr.write(`[utility:verify] 失败：${(error as Error).message}\n`)
    process.exit(2)
  }
}

export { sha256File, statSync }
