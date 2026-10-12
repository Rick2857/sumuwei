/**
 * 第二批实用能力验收（本机文件域 / 任务执行环 / 天气 / 办公 / 资讯 / 浏览器）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * `docs/post-lv2/Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md`
 *   · §5  WP0–WP6
 *   · §6A **28 组**：公共 8 + 文件/任务 4 + 天气 4 + 办公 4 + 资讯 4 + 浏览器 4
 *   · §6B 必要继承回归（`pnpm m4.5:ci` 一次 + `m5.1:measurement:verify` + 收尾门）
 *   · §6C 八场景真模型短链
 *
 * ```bash
 * pnpm productivity:verify --only files,weather,office   # 开发中短测
 * pnpm productivity:verify                               # 28 组完整组合
 * pnpm productivity:verify --list                        # 只打印形状
 * pnpm with-test-model pnpm productivity:verify --live    # 八场景真模型短链
 * ```
 *
 * ⚠️ **未运行 = `NOT RUN`，不是 PASS**；计数型判据 0 条输入 ⇒ `MEASUREMENT INVALID`。
 * ⚠️ 真实库 `data/pglite` **一次都不打开**（所有轮次跑在 `isolateDatabase()` 的副本上）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())
/** 公开证据（进仓库） */
const EVIDENCE_PARENT = 'artifacts/post-lv2/productivity-skills'
/** raw 内容（合成树、日志）只放这里 —— 已 gitignore */
const LOCAL_PARENT = 'artifacts/post-lv2/local/productivity-skills-preparation'

const SOURCE_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'src/main.ts',
  'src/kernel/app/flags.ts',
  'src/kernel/app/turn-gateway.ts',
  'src/kernel/app/reply-guard-chain.ts',
  'src/kernel/contracts/turn-content.ts',
  'src/kernel/action/action-turn.ts',
  'src/kernel/action/gateway.ts',
  'src/kernel/action/policy.ts',
  'src/kernel/action/capability-registry.ts',
  'src/kernel/action/local-path.ts',
  'src/kernel/action/local-target.ts',
  'src/kernel/action/local-file-capabilities.ts',
  'src/kernel/action/local-file-intent.ts',
  'src/kernel/action/payload-staging.ts',
  'src/kernel/action/task-authorization.ts',
  'src/kernel/action/task-plan.ts',
  'src/kernel/action/task-loop.ts',
  'src/kernel/action/task-intent.ts',
  'src/kernel/action/turn-content-capabilities.ts',
  'src/kernel/action/turn-content-reply.ts',
  'src/kernel/action/weather-capability.ts',
  'src/kernel/action/weather-news-intent.ts',
  'src/kernel/action/office-capability.ts',
  'src/kernel/action/news-capability.ts',
  'src/kernel/action/browser-capability.ts',
  'src/kernel/action/browser-operations.ts',
  'src/infrastructure/action/adapters/local-filesystem.ts',
  'src/infrastructure/action/adapters/office-generate.ts',
  'src/infrastructure/action/adapters/weather.ts',
  'src/infrastructure/action/adapters/news-read.ts',
  'src/infrastructure/action/adapters/browser.ts',
  'src/infrastructure/action/adapters/document-read.ts',
  'src/infrastructure/action/adapters/image-ocr.ts',
  'src/infrastructure/model/openai-task-planner.ts',
  'scripts/productivity-skills-verify.ts',
  'scripts/productivity-skills/assembly.ts',
  'scripts/productivity-skills/reading.ts',
  'scripts/productivity-skills/groups.ts',
  'scripts/productivity-skills/groups-common.ts',
  'scripts/productivity-skills/groups-files.ts',
  'scripts/productivity-skills/groups-weather.ts',
  'scripts/productivity-skills/groups-office.ts',
  'scripts/productivity-skills/groups-news.ts',
  'scripts/productivity-skills/groups-browser.ts',
  'scripts/productivity-skills/browser-fixture.ts',
  'scripts/productivity-skills/fixtures.ts',
  'scripts/productivity-skills/office-generate.py',
]

import {
  GROUP_PLAN,
  LIVE_PLAN,
  RUNNERS,
  Suite,
  type Capability,
  type GroupRunner,
} from './productivity-skills/groups.ts'
import type { GroupReading, VerifyContext } from './productivity-skills/reading.ts'

export type { Capability, GroupReading, VerifyContext }
export { GROUP_PLAN, LIVE_PLAN }

interface Cli {
  only: Capability[]
  live: boolean
  list: boolean
  label: string
}

const ALL_CAPABILITIES: readonly Capability[] = [
  'common',
  'files',
  'weather',
  'office',
  'news',
  'browser',
]

export function parseArgv(argv: readonly string[]): Cli {
  let only: Capability[] = [...ALL_CAPABILITIES]
  let live = false
  let list = false
  let label = 'productivity'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--only') {
      const raw = argv[index + 1]
      if (raw === undefined) throw new Error('--only 需要一个能力名（逗号分隔）')
      const parts = raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
      for (const part of parts) {
        if (!ALL_CAPABILITIES.includes(part as Capability)) {
          throw new Error(`--only 不认识 ${part}（只接受 ${ALL_CAPABILITIES.join('|')}）`)
        }
      }
      only = parts as Capability[]
      index += 1
      continue
    }
    if (arg === '--live') {
      live = true
      label = 'productivity-live'
      continue
    }
    if (arg === '--list') {
      list = true
      continue
    }
    if (arg === '--label') {
      const raw = argv[index + 1]
      if (raw === undefined) throw new Error('--label 需要一个标签')
      label = raw
      index += 1
      continue
    }
    throw new Error(`不认识的参数：${arg}`)
  }
  return { only, live, list, label }
}

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

function nowIso(): string {
  return new Date().toISOString()
}

function runIdOf(label: string): string {
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\..+$/, '')
  const head = git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'
  const suffix = createHash('sha256').update(`${label}${stamp}${String(process.pid)}`).digest('hex').slice(0, 4)
  return `${label}-${stamp}-${head}-${suffix}`
}

function safeVersion(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      shell: process.platform === 'win32' && !command.includes(' '),
    }).trim()
  } catch {
    return ''
  }
}

export interface RunResult {
  readonly runId: string
  readonly runDir: string
  readonly exitCode: number
  readonly groups: readonly GroupReading[]
}

export async function runVerify(cli: Cli): Promise<RunResult> {
  const startedAt = nowIso()
  const runId = runIdOf(cli.label)
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  if (existsSync(runDir)) throw new Error(`runId 目录已存在，拒绝覆盖：${runDir}`)
  mkdirSync(runDir, { recursive: true })
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
    fixturesDir: join(REPO_ROOT, LOCAL_PARENT, 'fixtures'),
    runDir,
    localDir,
    log,
  }

  const suite = new Suite(ctx)
  log(`[productivity:verify] 合成 fixture 树在 %TEMP%（沙箱外）· 本地目录 ${localDir}`)

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
        log(`[productivity:verify] ${plan.id} NOT RUN（没有运行器）`)
        continue
      }
      const startedMs = Date.now()
      let reading: GroupReading
      try {
        reading = await runner.run(ctx, suite)
      } catch (error) {
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
        `[productivity:verify] ${reading.id.padEnd(12)} ${reading.status.padEnd(20)} ` +
          `（${String(reading.measuredCount)} 条输入 · ${String(Date.now() - startedMs)}ms）` +
          (reading.reason !== undefined ? ` — ${reading.reason}` : '')
      )
    }
  } catch (error) {
    fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log(`[productivity:verify] **FATAL**：${fatal}`)
  }

  try {
    await suite.dispose()
  } catch (error) {
    log(`[productivity:verify] 收尾失败（不影响读数）：${(error as Error).message}`)
  }

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
    schemaVersion: 'productivity-skills-run@1',
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
    sourceHashes,
    counts,
    ...(fatal !== undefined ? { fatal } : {}),
    groups,
  }

  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8')

  log('')
  log(`[productivity:verify] runId = ${runId}`)
  log(`[productivity:verify] 证据 = ${EVIDENCE_PARENT}/${runId}/run.json`)
  log(
    `[productivity:verify] 组：${String(counts.total)}（PASS ${String(counts.pass)} · FAIL ${String(counts.fail)} · ` +
      `NOT RUN ${String(counts.notRun)} · MEASUREMENT INVALID ${String(counts.invalid)}）· ` +
      `参数化输入 ${String(counts.measuredInputs)} 条`
  )
  for (const group of groups) {
    if (group.status === 'PASS') continue
    log(`[productivity:verify] ${group.id} ${group.status}：${group.reason ?? '(无原因)'}`)
    for (const item of group.cases) {
      if (item.status !== 'FAIL') continue
      log(`[productivity:verify]   · ${item.caseId} ${item.title}`)
      if (item.observed !== undefined) {
        log(`[productivity:verify]     observed = ${JSON.stringify(item.observed).slice(0, 300)}`)
      }
    }
  }
  if (fatal !== undefined) log(`[productivity:verify] fatal = ${fatal}`)

  /*
   * ⚠️ **判定口径**：`NOT RUN` **不算过**（AGENTS.md §6.4）。
   *    但浏览器第 ④ 组与办公三组在缺前置时会是 NOT RUN —— 那是**如实**的。
   *
   * ★ 2026-10-09（ADR-125 收尾，把本门纳入门表）：退出码把"不干净"**分成两档**，
   *   因为门表只能按退出码接受，而"有断言失败"与"有东西没跑"必须能被分开：
   * ```text
   * 0  全干净（fail=0 · invalid=0 · notRun=0）
   * 1  **只有** NOT RUN（没有 FAIL / MEASUREMENT INVALID / total=0）
   *    —— 仍是"不算过"（所以它照旧非零），但它与"真失败"是两件事。
   *    门表用 `acceptExitCodes: [1]` 显式接受这一档，并在 `why` 里写明**为什么**。
   * 3  有 FAIL 或 MEASUREMENT INVALID，或一组都没跑 ⇒ **任何档都不接受**
   * 2  门自己抛错（`isMain` 的 catch，既有语义不变）
   * ```
   * ⚠️ 没有把两种情形合成一个非零码，是刻意的：合成之后门表要么接受 red、要么永远进不了表
   *    （那正是 2026-10-09 之前"这道门谁都没引用"的成因之一）。
   */
  const hasFailure = counts.fail > 0 || counts.invalid > 0 || counts.total === 0
  const clean = !hasFailure && counts.notRun === 0
  const exitCode = clean ? 0 : hasFailure ? 3 : 1
  log(
    `[productivity:verify] overall = ${clean ? 'PASS' : 'NOT PASS'}` +
      (clean
        ? ''
        : hasFailure
          ? '（有 FAIL / MEASUREMENT INVALID ⇒ exit 3）'
          : '（只有 NOT RUN ⇒ exit 1）')
  )
  return { runId, runDir, exitCode, groups }
}

/** `--list`：只打印形状，不跑任何东西、不写任何证据 */
export function listPlan(): void {
  process.stdout.write(
    `${String(GROUP_PLAN.length)} 组计划（计划书 §6A 的 28 组 + 2026-10-09 追加的 browser-06）：\n`
  )
  for (const group of GROUP_PLAN) {
    process.stdout.write(`  ${group.id.padEnd(12)} [${group.capability.padEnd(8)}] ${group.title}\n`)
  }
  process.stdout.write('\n--live 八场景（计划书 §6C）：\n')
  for (const scenario of LIVE_PLAN) {
    process.stdout.write(
      `  ${scenario.id.padEnd(28)} [${scenario.capability}/${scenario.kind}] ${scenario.title}\n`
    )
  }
}

const isMain =
  process.argv[1] !== undefined &&
  /productivity-skills-verify\.ts$/.test(process.argv[1].replace(/\\/g, '/'))

if (isMain) {
  try {
    const cli = parseArgv(process.argv.slice(2))
    if (cli.list) {
      listPlan()
      process.exit(0)
    }
    if (cli.live) {
      const { runLive } = await import('./productivity-skills/live.ts')
      const result = await runLive(cli)
      process.exit(result.exitCode)
    }
    const result = await runVerify(cli)
    process.exit(result.exitCode)
  } catch (error) {
    process.stderr.write(`[productivity:verify] 失败：${(error as Error).message}\n`)
    process.exit(2)
  }
}

export { sha256File, statSync }
