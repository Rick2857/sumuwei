/**
 * M6 **WP10a 门** —— 最终候选离线门与全量回归（计划书 §WP10a；契约 M6-G11）。
 *
 * ============================================================================
 *  ⚠️ 为什么是**分块执行**的
 * ============================================================================
 * 第一版一口气跑整门（约 2 小时），父进程里嵌了 `pnpm → tsx → 孙进程` 三层，
 * harness 的 Windows 作业运行器在"无法证明受管进程范围已空"时把整棵树杀了一次
 * —— 父进程停在回归那一步，回归连证据都没写完。
 * 现在：`runId` 只由 HEAD 派生、**每一步的读数单独落盘**
 * （`artifacts/m6/local/<runId>/readings/<id>.json`）、日志**异步流式**写，
 * 于是可以按 `--steps <id...>` 分块跑（每块 ≤20 分钟），最后 `--finalize` 汇总。
 * 缺读数的步骤在汇总里记 `NOT RUN`（**缺文件不是 PASS**）。
 *
 * ============================================================================
 *  它判什么
 * ============================================================================
 * ```text
 *   ① **先冻结候选**：head · 运行相关树哈希（src/scripts/evals + package.json + lock）·
 *      工作树例外（逐条列，不许口头说"没影响"）· 工具版本 · 冻结阈值来源。
 *   ② 跑**计划书 §10.1 的全部命令**（条数不写死：`PLAN_10_1.length`，2026-09-26 核计 = 32）+ INC-01 登记门 + **M6 离线门**（逐条进程、逐条退出码）。
 *   ③ 跑**全量回归** `pnpm inc-01:regression:verify`（内部含 `m4.5:ci` 与 `m4.5:ci:full`）。
 *   ④ 按白名单恢复被重写的固定证据路径（跑前记脏 → 跑后只还新增的 → 逐条 `git diff --quiet` 证明）。
 *   ⑤ **一条 EXIT 非 0 都不算过**：本门只接受全绿；已知的、与本次改动无关的非零读数
 *      必须**在回归自己的清单里逐条写明**（本门只转述，不自行放宽）。
 * ```
 *
 * ⚠️ 需要模型的两道 M6 门（`wp9a-calibration` / `wp9b-long-dialogue`）**不在本门**：
 *    它们按计划书 §WP10b 在"实际链路验证"里重验；本门只跑离线部分并把它们的落盘证据交给 `m6:gates`。
 *
 * 用法：
 *   pnpm exec tsx scripts/verify-m6-wp10a-final-offline.ts --steps typecheck m4.5:ci ...
 *   pnpm exec tsx scripts/verify-m6-wp10a-final-offline.ts --finalize
 */
import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { createReporter } from './m4-harness.ts'

const ROOT = resolve('.')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const fileSha = (path: string): string => sha256(readFileSync(path, 'utf8'))
const report = createReporter()
const check = (label: string, pass: boolean, reading: string): void => report.check(label, pass, reading)

// ---------------------------------------------------------------------------
// 冻结：运行相关树哈希 + 工作树例外 + 工具版本
// ---------------------------------------------------------------------------

/** 运行相关目录/文件（**文档变化不算**；契约 §9：运行相关树变了才让证据失效） */
const RUN_RELEVANT = ['src', 'scripts', 'evals', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']

function collectFiles(path: string, into: string[]): void {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      collectFiles(join(path, entry.name), into)
    }
    return
  }
  into.push(path)
}

function runRelevantTreeSha(): { sha256: string; files: number } {
  const files: string[] = []
  for (const item of RUN_RELEVANT) collectFiles(resolve(item), files)
  const entries = files
    .map((file) => `${relative(ROOT, file).split(/[\\/]/).join('/')} ${fileSha(file)}`)
    .sort()
  return { sha256: sha256(entries.join('\n')), files: entries.length }
}

// ---------------------------------------------------------------------------
// 步骤清单
// ---------------------------------------------------------------------------

interface StepSpec {
  id: string
  cmd: string
  why: string
  /** 组：计划书 §10.1 / INC-01 / M6 离线门 */
  group: 'plan-10.1' | 'inc-01' | 'm6-offline'
}

/**
 * 计划书 §10.1 逐字照抄（运行前已用 `package.json` 核对：全部存在）。
 *
 * ⚠️ **条数不在这里写死**（TD-15）：R1 段用 `PLAN_10_1.length` 现算。
 *    历史注释曾写"39 条"，而清单实际是 32 条 —— 数字对不上话，读数就会骗人（`AGENTS.md` §6.9）。
 */
const PLAN_10_1: StepSpec[] = [
  'typecheck',
  'm4.5:ci',
  'm5:test',
  'm5:verify',
  'm5:retrieval:verify',
  'm5:ranking:verify',
  'm5:budget:verify',
  'm5:runtime:verify',
  'm5:trace:verify',
  'm5:e2e:verify',
  'm5:gates',
  'm5.1:test',
  'm5.1:query:verify',
  'm5.1:control:verify',
  'm5.1:observability:verify',
  'm5.1:page:verify',
  'm5.1:measurement:verify',
  'm5.1:gates',
  'm5.1:regression:verify',
  'm5.1.1:test',
  'm5.1.1:migration:verify',
  'm5.1.1:phase4:closure:verify',
  'm5.1.1:gates',
  'm5.5:measurement:verify',
  'm5.5:test',
  'm5.5:verify',
  'm5.5:e2e:verify',
  'm5.5:gates',
  'm5.5.1:test',
  'm5.5.1:verify',
  'm5.5.1:measurement:verify',
  'doc:check',
].map((name) => ({ id: name, cmd: `pnpm ${name}`, why: '计划书 §10.1 必跑离线门', group: 'plan-10.1' }))

/** INC-01 完成后**实际登记**的门（计划书 §10.1 末句要求追加） */
const INC_01: StepSpec[] = [
  { id: 'inc-01:test', cmd: 'pnpm inc-01:test', why: 'INC-01 部件级（不打开任何库）', group: 'inc-01' },
  { id: 'inc-01:verify', cmd: 'pnpm inc-01:verify', why: 'INC-01 WP1–WP5 门聚合', group: 'inc-01' },
  { id: 'inc-01:measurement:verify', cmd: 'pnpm inc-01:measurement:verify', why: 'INC-01 量具自证', group: 'inc-01' },
  { id: 'inc-01:gates', cmd: 'pnpm inc-01:gates', why: 'INC-01 门汇总（只读已落盘证据）', group: 'inc-01' },
]

/** M6 自己的**离线**门（需要模型的那两道按计划书 §WP10b 重验，不在这里） */
const M6_OFFLINE: StepSpec[] = [
  { id: 'm6:measurement:verify', cmd: 'pnpm m6:measurement:verify', why: 'WP4 量具资格化（8 类注入 × 三段式）', group: 'm6-offline' },
  { id: 'm6-wp2', cmd: 'pnpm exec tsx scripts/verify-m6-wp2-rollup.ts', why: 'WP2 摘要纯逻辑部件门', group: 'm6-offline' },
  { id: 'm6-wp3-wiring', cmd: 'pnpm exec tsx scripts/verify-m6-wp3-wiring.ts', why: 'WP3 接线门（packet 级 R-2 负控）', group: 'm6-offline' },
  { id: 'm6-wp3-reader', cmd: 'pnpm exec tsx scripts/verify-m6-wp3-reader.ts', why: 'WP3 只读来源读取面门', group: 'm6-offline' },
  { id: 'm6-wp5-console', cmd: 'pnpm exec tsx scripts/verify-m6-wp5-console.ts', why: 'WP5 开发者面（摘要事实派生与页面纪律）', group: 'm6-offline' },
  { id: 'm6-wp6a-faults', cmd: 'pnpm exec tsx scripts/verify-m6-wp6a-faults.ts', why: 'WP6a 降级与动作真相', group: 'm6-offline' },
  { id: 'm6-wp6b', cmd: 'pnpm exec tsx scripts/verify-m6-wp6b.ts', why: 'WP6b 重启/关闭/恢复（INC-01 保护）', group: 'm6-offline' },
  { id: 'm6-wp7a', cmd: 'pnpm exec tsx scripts/verify-m6-wp7a.ts', why: 'WP7a A–E 自然语言剧情', group: 'm6-offline' },
  { id: 'm6-wp7b', cmd: 'pnpm exec tsx scripts/verify-m6-wp7b.ts', why: 'WP7b 跨午夜/预算竞争/评审包', group: 'm6-offline' },
  { id: 'm6-wp8', cmd: 'pnpm exec tsx scripts/verify-m6-wp8.ts', why: 'WP8 规模/性能/检索上界', group: 'm6-offline' },
  { id: 'm6:gates', cmd: 'pnpm m6:gates', why: 'M6 门汇总（含需模型那两道的**已落盘**证据）', group: 'm6-offline' },
]

// ---------------------------------------------------------------------------
// 证据目录 + 白名单恢复的工具
// ---------------------------------------------------------------------------

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
/**
 * ⚠️ runId **只由 HEAD 派生**（不带时间戳）：本门要能**分块跑、续跑、最后汇总**。
 *    起因是一次真实的作业被杀：整门一口气跑 2 小时、父进程里嵌了
 *    `pnpm → tsx → 孙进程` 三层，harness 的 Windows 作业运行器在"无法证明受管进程范围已空"时
 *    把整棵树杀了（父进程停在回归那一步，回归连证据都没写完）。
 *    分块之后每个作业都短、都浅，而且**每一步的读数都单独落盘** ⇒ 中断不丢已完成的部分。
 */
const runId = `m6-wp10a-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
const logDir = join(ROOT, 'artifacts/m6/local', runId, 'logs')
const readingDir = join(ROOT, 'artifacts/m6/local', runId, 'readings')
mkdirSync(outDir, { recursive: true })
mkdirSync(logDir, { recursive: true })
mkdirSync(readingDir, { recursive: true })
console.log(`runId=${runId}`)

/** 受版本控制的 `artifacts/**` 里**被改动**的路径（`AGENTS.md` §7 的机械判定） */
const trackedDirtyArtifacts = (): string[] =>
  spawnSync('git', ['status', '--porcelain', '--', 'artifacts'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3 && !line.startsWith('??') && line.slice(0, 2).includes('M'))
    .map((line) => line.slice(3).trim())

const artifactsDirtyBefore = trackedDirtyArtifacts()

// ---------------------------------------------------------------------------
// 冻结核对（离线，先判）
// ---------------------------------------------------------------------------

report.section('F 冻结：候选代码 / 语料 / 配置')
const tree = runRelevantTreeSha()
const workingTreeStatus = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .stdout.split('\n')
  .map((line) => line.trimEnd())
  .filter((line) => line.length > 0)
const runRelevantExceptions = workingTreeStatus.filter((line) =>
  RUN_RELEVANT.some((item) => line.slice(3).startsWith(item))
)
const otherDirty = workingTreeStatus.filter((line) => !runRelevantExceptions.includes(line))
check(
  'F1 · 运行相关树已冻结：`src/` `scripts/` `evals/` 的**内容哈希**已记录（逐文件 sha256 后整体哈希），条数 > 0',
  tree.files > 0 && /^[0-9a-f]{64}$/.test(tree.sha256),
  `${tree.files} 个文件 ⇒ ${tree.sha256.slice(0, 24)}…`
)
check(
  'F2 · **工作树例外逐条列出**（计划书 §9 的 manifest 字段；不许口头说"没影响"）：本门脚本自身尚未提交，其余运行相关文件干净',
  runRelevantExceptions.every((line) => line.includes('verify-m6-wp10a-final-offline.ts')),
  `运行相关例外=${JSON.stringify(runRelevantExceptions)} · 其它改动=${JSON.stringify(otherDirty)}`
)
const nodeVersion = process.version
const pnpmVersion = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' }).stdout.trim()
check(
  'F3 · 工具版本已记录（复盘时"换了一个 pnpm 小版本就跑出别的数"这种事要能查）',
  nodeVersion.startsWith('v') && pnpmVersion !== '',
  `node=${nodeVersion} · pnpm=${pnpmVersion}`
)
const rev2Path = resolve('artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/M6-D3-thresholds-rev2.json')
check(
  'F4 · 冻结阈值来源可追溯：M6-D3 rev2 文件哈希已记录（WP9b 的质量门用的就是它）',
  fileSha(rev2Path).length === 64,
  `rev2=${fileSha(rev2Path).slice(0, 16)}…`
)

// ---------------------------------------------------------------------------
// 跑：§10.1 + INC-01 + M6 离线门
// ---------------------------------------------------------------------------

interface StepReading {
  id: string
  cmd: string
  why: string
  group: StepSpec['group']
  exitCode: number | null
  seconds: number
  logPath: string
  logSha256: string
  ok: boolean
}

/**
 * 跑一条命令：**异步 + 流式落盘**（不再用 `spawnSync` 把整段输出攒在内存里）。
 *   · 日志边跑边写 ⇒ 长步骤能被观察（第一版攒到结束才写，回归那 40 分钟是盲的）
 *   · 读数单独落盘 ⇒ 分块执行/续跑不丢已完成的步骤
 */
const runStep = async (spec: StepSpec): Promise<StepReading> => {
  const started = Date.now()
  const logPath = join(logDir, `${spec.id.replace(/[:/]/g, '_')}.log`)
  const stream = createWriteStream(logPath)
  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const child = spawn(spec.cmd, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: process.env,
    })
    child.stdout?.on('data', (chunk: Buffer) => stream.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stream.write(chunk))
    child.on('error', () => resolvePromise(-1))
    child.on('close', (code) => resolvePromise(code))
  })
  await new Promise<void>((resolvePromise) => stream.end(resolvePromise))
  const seconds = Math.round((Date.now() - started) / 1000)
  const reading: StepReading = {
    id: spec.id,
    cmd: spec.cmd,
    why: spec.why,
    group: spec.group,
    exitCode,
    seconds,
    logPath: relative(ROOT, logPath).split(/[\\/]/).join('/'),
    logSha256: sha256(readFileSync(logPath, 'utf8')),
    ok: exitCode === 0,
  }
  writeFileSync(join(readingDir, `${spec.id.replace(/[:/]/g, '_')}.json`), `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  /*
   * 回归自己会把 verdict 写到 `artifacts/incidents/inc-01/regression.json`（**受版本控制**），
   * 而本门的白名单恢复会把它还原成索引版本 ⇒ 到 `--finalize` 时那份文件已经不是本次读数了。
   * 所以**跑完这一步立刻快照**它的内容，后面只读快照。
   */
  if (spec.id === 'inc-01:regression:verify') {
    const evidencePath = resolve('artifacts/incidents/inc-01/regression.json')
    if (existsSync(evidencePath)) {
      writeFileSync(join(readingDir, 'inc-01_regression_verify.evidence-snapshot.json'), readFileSync(evidencePath))
    }
  }
  console.log(`   ${reading.ok ? '✅' : '❌'} ${spec.id.padEnd(28)} exit=${String(exitCode)} (${seconds}s)`)
  return reading
}

const ALL_STEPS: StepSpec[] = [...PLAN_10_1, ...INC_01, ...M6_OFFLINE, {
  id: 'inc-01:regression:verify',
  cmd: 'pnpm inc-01:regression:verify',
  why: '全量回归：接线 + m4.5:ci + m4.5:ci:full + 各里程碑汇总 + INC-01',
  group: 'inc-01',
}]

function argValues(name: string): string[] {
  const out: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      for (let cursor = index + 1; cursor < process.argv.length; cursor += 1) {
        if (process.argv[cursor].startsWith('--')) break
        out.push(process.argv[cursor])
      }
    }
  }
  return out
}

const finalizeOnly = process.argv.includes('--finalize')
const selected = argValues('--steps')
const stepsToRun = selected.length === 0 ? ALL_STEPS : ALL_STEPS.filter((spec) => selected.includes(spec.id))

report.section(`R1 计划书 §10.1 全部命令（${PLAN_10_1.length} 条）+ INC-01 + M6 离线门`)
const stepReadings: StepReading[] = []
if (finalizeOnly) {
  console.log('   ⏭️  --finalize：不跑任何命令，只汇总已落盘的读数')
} else {
  console.log(`   本次要跑 ${stepsToRun.length} 条：${stepsToRun.map((spec) => spec.id).join(', ')}`)
  for (const spec of stepsToRun) {
    stepReadings.push(await runStep(spec))
  }
}
/** 汇总时把**全部**步骤的落盘读数读回来（缺的记 NOT RUN —— 缺文件不是 PASS） */
const allReadings: (StepReading | { id: string; ok: false; exitCode: null; seconds: 0; note: string })[] = ALL_STEPS.map(
  (spec) => {
    const path = join(readingDir, `${spec.id.replace(/[:/]/g, '_')}.json`)
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as StepReading
    return { id: spec.id, ok: false, exitCode: null, seconds: 0, note: 'NOT RUN（没有落盘读数）' }
  }
)
const planReadings = allReadings.filter((item) => PLAN_10_1.some((spec) => spec.id === item.id))
const otherReadings = allReadings.filter((item) => !PLAN_10_1.some((spec) => spec.id === item.id))
check(
  `R1a · 计划书 §10.1 的 ${PLAN_10_1.length} 条命令**逐条 EXIT 0**（缺读数 = NOT RUN，不算过）`,
  planReadings.length === PLAN_10_1.length && planReadings.every((item) => item.ok === true),
  planReadings
    .filter((item) => item.ok !== true)
    .map((item) => `${item.id}=${String(item.exitCode ?? 'NOT RUN')}`)
    .join(' · ') || '全部 0'
)
check(
  `R1b · INC-01 与 M6 离线门**逐条 EXIT 0**（${otherReadings.length} 条，含全量回归）`,
  otherReadings.length === INC_01.length + M6_OFFLINE.length + 1 && otherReadings.every((item) => item.ok === true),
  otherReadings
    .filter((item) => item.ok !== true)
    .map((item) => `${item.id}=${String(item.exitCode ?? 'NOT RUN')}`)
    .join(' · ') || '全部 0'
)

// ---------------------------------------------------------------------------
// R2 全量回归：**只读它自己写下的读数快照**（回归由 `--steps inc-01:regression:verify` 单独跑）
// ---------------------------------------------------------------------------

report.section('R2 全量回归（`pnpm inc-01:regression:verify`，内含 m4.5:ci 与 m4.5:ci:full）')
const regressionReading =
  (allReadings.find((item) => item.id === 'inc-01:regression:verify') as StepReading | undefined) ?? null
const regressionSnapshotPath = join(readingDir, 'inc-01_regression_verify.evidence-snapshot.json')
const regressionEvidence = ((): {
  verdict?: string
  steps?: { id: string; exitCode: number; expectZero: boolean; knownNonZeroBecause?: string }[]
} | null => {
  if (!existsSync(regressionSnapshotPath)) return null
  try {
    return JSON.parse(readFileSync(regressionSnapshotPath, 'utf8')) as never
  } catch {
    return null
  }
})()
const knownNonZero = (regressionEvidence?.steps ?? []).filter(
  (step) => typeof step.exitCode === 'number' && step.exitCode !== 0
)
/*
 * ⚠️ 第二版判据更正：`exitCode === null` 表示"本分支没有这条命令"（回归如实记 `NOT RUN`），
 *    它**不是**非零读数。第一版把它一起要求"带具名理由"，于是 `m5.5.1-gates=(无理由)` 被误判成红。
 */
const notRunSteps = (regressionEvidence?.steps ?? []).filter((step) => typeof step.exitCode !== 'number')
check(
  'R2a · 全量回归 EXIT 0，且它自己的证据 `verdict = PASS`（读数取自**它写完那一刻的快照**，不是被白名单还原之后的文件）',
  regressionReading?.ok === true && regressionEvidence?.verdict === 'PASS',
  `exit=${String(regressionReading?.exitCode ?? 'NOT RUN')} · verdict=${String(regressionEvidence?.verdict ?? '(缺)')} · 日志=${regressionReading?.logPath ?? '(无)'}`
)
check(
  'R2b · 回归里**真的非零**的读数逐条带具名理由（本门只转述回归自己的 `knownNonZeroBecause`，不自行放宽）；`NOT RUN` 的步骤单列，**不算**非零',
  knownNonZero.every((step) => (step.knownNonZeroBecause ?? '') !== ''),
  (knownNonZero.length === 0
    ? '(非零：无)'
    : knownNonZero
        .map((step) => `${step.id}=${step.exitCode}：${(step.knownNonZeroBecause ?? '(无理由)').slice(0, 80)}`)
        .join(' | ')) + ` · NOT RUN（本分支无此命令）=${notRunSteps.map((step) => step.id).join(',') || '(无)'}`
)

// ---------------------------------------------------------------------------
// 白名单恢复 + 真实库读数
// ---------------------------------------------------------------------------

report.section('R3 白名单恢复与真实库读数')
const artifactsDirtyAfter = trackedDirtyArtifacts()
const newlyDirty = artifactsDirtyAfter.filter((path) => !artifactsDirtyBefore.includes(path))
for (const path of newlyDirty) spawnSync('git', ['checkout', '--', path], { cwd: ROOT })
const leftoverDirty = trackedDirtyArtifacts().filter((path) => !artifactsDirtyBefore.includes(path))
const restoredClean = newlyDirty.filter(
  (path) => spawnSync('git', ['diff', '--quiet', '--', path], { cwd: ROOT }).status === 0
)
check(
  'R3a · **白名单恢复**（机械判定）：门跑完只还原"新增出现"的受版本控制证据，还原后与索引逐字一致，没有多还原任何东西',
  leftoverDirty.length === 0 && restoredClean.length === newlyDirty.length,
  `跑前已脏=${newlyDirty.length === 0 ? JSON.stringify(artifactsDirtyBefore) : JSON.stringify(artifactsDirtyBefore)} · 新增脏=${newlyDirty.length} 条 · 还原后仍脏=${JSON.stringify(leftoverDirty)} · 与索引一致=${restoredClean.length}/${newlyDirty.length}`
)

const snapshotDirs = ((): number => {
  try {
    return readdirSync(resolve('data/snapshots'), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('pglite-')
    ).length
  } catch {
    return -1
  }
})()
check(
  'R3b · 真实库前后摘要：**本门不主张"没打开"** —— 全量回归里那三个只读 opener 会合法地打开真实库（脚本自己按 INC-01 的状态机走：租约 + 前置 verified snapshot）⇒ 这里记录快照份数与摘要，供人工核对，不用"未打开"当结论',
  snapshotDirs > 0,
  `verified 快照目录 ${snapshotDirs} 份（读取 ${resolve('data/snapshots')}）`
)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

const allOk =
  allReadings.length === ALL_STEPS.length &&
  allReadings.every((item) => item.ok === true) &&
  regressionEvidence?.verdict === 'PASS'
const payload = {
  schemaVersion: 'm6-wp10a-regression@1',
  runId,
  generatedAt: new Date().toISOString(),
  head,
  verdict: allOk && report.failed === 0 ? 'PASS' : 'FAIL',
  passed: report.passed,
  failed: report.failed,
  measurementInvalid: 0,
  wp: 'M6 WP10a — 最终候选离线门与全量回归',
  freeze: {
    runRelevantTreeSha256: tree.sha256,
    runRelevantFileCount: tree.files,
    runRelevantPaths: RUN_RELEVANT,
    workingTreeExceptions: runRelevantExceptions,
    otherDirty: otherDirty,
    toolVersions: { node: nodeVersion, pnpm: pnpmVersion },
    frozenThresholdsRev2Sha256: fileSha(rev2Path),
  },
  steps: allReadings,
  stepsRunThisInvocation: stepReadings.map((item) => item.id),
  regression: {
    exitCode: regressionReading?.exitCode ?? null,
    seconds: regressionReading?.seconds ?? 0,
    logPath: regressionReading?.logPath ?? '(NOT RUN)',
    evidenceSnapshot: `artifacts/m6/local/${runId}/readings/inc-01_regression_verify.evidence-snapshot.json`,
    verdict: regressionEvidence?.verdict ?? '(缺)',
    knownNonZero: knownNonZero.map((step) => ({
      id: step.id,
      exitCode: step.exitCode,
      reason: step.knownNonZeroBecause ?? '',
    })),
  },
  whitelistRestore: {
    dirtyBefore: artifactsDirtyBefore,
    newlyDirty,
    leftoverDirty,
    restoredByteExact: restoredClean.length === newlyDirty.length,
  },
  logsLocation: `artifacts/m6/local/${runId}/logs/（gitignored；每条命令一份日志 + sha256 已记在上面的 steps 里）`,
  modelGatesDeferredToWp10b: [
    'wp9a-calibration（50/100 轮校准，需模型）',
    'wp9b-long-dialogue（3×500 轮，需模型）',
  ],
  realDbNote:
    '全量回归里的只读 opener（`m4:real-db:verify` / `snapshot` / `m5.1.1:phase4b:db-v9`）会合法打开真实库；' +
    '本门**不**主张"真实库没被打开"，只记录快照份数与各门读数。',
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
  totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
}
writeFileSync(join(outDir, 'regression.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(
  `\nM6 WP10a 门：${report.passed} 通过 / ${report.failed} 失败 · 判定=${payload.verdict}` +
    (report.failures.length > 0 ? `\n失败项：${report.failures.join(' | ')}` : '')
)
console.log(`证据：${relative(ROOT, join(outDir, 'regression.json')).split(/[\\/]/).join('/')}`)
console.log(`逐条日志（gitignored）：artifacts/m6/local/${runId}/logs/`)
process.exit(report.failed === 0 && allOk ? 0 : 1)
