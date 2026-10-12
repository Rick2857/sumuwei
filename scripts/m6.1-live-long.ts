/**
 * M6.1 **WP6 长对话运行器**（`pnpm with-test-model pnpm m6.1:live --suite long --trajectory V1|V2|V3`）。
 *
 * ============================================================================
 *  冻结依据（[`M6.1-WP6-Freeze-Sheet.md`](../docs/m6.1/M6.1-WP6-Freeze-Sheet.md)）
 * ============================================================================
 * ```text
 *  ① 3 条独立轨迹 × 500 轮 · code-default 单臂（rollup 0）· 每条 1 次正式运行
 *     三条轨迹分三次 execution 跑（每条一个进程；轮间有因果依赖 ⇒ 轨迹内不可并发）
 *  ② 检查点 1/50/100/200/300/400/500：探针判定 + 程序读数 + 序号核验（F-2 的承载）
 *  ③ 重启 = spawn-per-turn（每轮都是进程重启，隔离库上）；
 *     "新会话切换"按裁定 F-2 登记为设计差异（生产装配无此概念），不假装做了
 *  ④ 全轨迹断言候选扫描 + 漏检自证（正控 100% / 负控 0 / measured>0）
 *  ⑤ 候选判定上限 60/轨迹（超出确定性抽样，溢出如实报）
 * ```
 *
 * ============================================================================
 *  三阶段（与短场景运行器同一形状；各自逐条落盘、各自可 `--resume`）
 * ============================================================================
 * ```text
 *  phase run    逐轮 spawn 生产入口（真模型，**同一轨迹共用一个隔离库**——
 *               这正是"长对话"的本义；与短场景的逐工况空沙箱相反）。
 *               检查点轮额外落程序读数（--kernel-status / --memory-list / trace 结构性读数）
 *  phase scan   离线（零模型）：漏检自证 + 全轨迹候选抽取 + 上限抽样
 *  phase judge  冻结探针（检查点+诱导+假预设）与抽样候选 → @9 双采样 + 争议加判
 * ```
 *
 * ⚠️ **不主张**什么（写进读数的 `notProven`）：
 * ```text
 * · 「她不再编造」——本运行器只出读数与人审材料；最终判定按冻结单 §5 分列 + 用户人审
 * · 候选扫描的 alert ≠ 产品失败（G-L5：全量进人审包，机器不据其自动 FAIL）
 * · `actualContext` 是结构性重建（section 名单/召回计数/记录状态行），不是逐字提示正文
 * · 诊断档（--limit）分母被截，不作任何判定
 * ```
 *
 * 用法：
 * ```bash
 * pnpm with-test-model pnpm m6.1:live --suite long --trajectory V1
 * pnpm with-test-model pnpm m6.1:live --suite long --trajectory V1 --limit 3   # 诊断档
 * pnpm with-test-model pnpm m6.1:live --suite long --trajectory V1 --phase judge --resume <runId>
 * ```
 */

import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { M6_1_LOCAL_PARENT, createRunId, openRunDir, sha256OfText, writeManifestAtomic } from './m6.1-evidence.ts'
import {
  PREFLIGHT_DEFAULT_PROBES,
  judgePreflight,
  readPreflightGate,
  writePreflightArtifact,
  type PreflightArtifact,
  type PreflightProbe,
} from './m6.1-preflight-lib.ts'
import {
  DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_RATE_LIMIT_RETRIES,
  TurnFailureHint,
  classifyTurnFailure,
  decideRateLimitRetry,
  decideTurnAbort,
  failureHintSummary,
  failureKindOf,
  modelRouteFromEnv,
} from './m6.1-run-guards.ts'
import {
  buildJudgePrompt,
  computeExpectedPointsHitMiss,
  itemsFromCorpus,
  judgmentFromSamples,
  judgmentFromTieBreak,
  M6_1_JUDGE_PROMPT_VERSION,
  M6_1_POINT_MATCH_VERSION,
  pointMatchesReply,
  type InstrumentItem,
  type ItemJudgment,
} from './m6.1-instrument.ts'
import { judgeActualContextPayload, readTurnContext } from './m6.1-turn-context.ts'
import {
  createOpenAiInstrumentJudge,
  M6_1_JUDGE_MAX_ATTEMPTS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  M6_1_JUDGE_TIMEOUT_MS,
} from './m6.1-judge-openai.ts'
import {
  LONG_CANDIDATE_JUDGE_CAP,
  LONG_TRAJECTORY_IDS,
  LONG_TRAJECTORY_LABELS,
  buildLongTrajectory,
  checkTrajectoryInvariants,
  type LongTrajectoryId,
  type LongTurnScript,
} from './m6.1-long-trajectories.ts'
import {
  deterministicSample,
  evaluateScanSelfProof,
  extractAssertionCandidates,
  type CandidatePoolEntry,
} from './m6.1-long-scan-core.ts'
import { parseKernelStatus, verifySequenceContiguity, type SequenceCheckpointReading } from './m6.1-long-sequence.ts'

const ROOT = resolve(process.cwd())
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/* ---------------------------------------------------------------------------
 * 参数与守卫（失败关闭）
 * ------------------------------------------------------------------------- */

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const trajectoryArg = argValue('--trajectory')
const phase = (argValue('--phase') ?? 'all') as 'run' | 'scan' | 'judge' | 'all'
const resumeRunId = argValue('--resume')
const limitRaw = argValue('--limit')
const limit = limitRaw === undefined ? undefined : Number(limitRaw)
const diagnostic = limit !== undefined
const turnIntervalMs = Number(argValue('--turn-interval-ms') ?? '0')
const maxConsecutiveFailuresRaw = argValue('--max-consecutive-failures')
const maxConsecutiveFailures = maxConsecutiveFailuresRaw === undefined ? DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES : Number(maxConsecutiveFailuresRaw)
const rateLimitCooldownMs = Number(argValue('--rate-limit-cooldown-ms') ?? String(DEFAULT_RATE_LIMIT_COOLDOWN_MS))
const rateLimitRetries = Number(argValue('--rate-limit-retries') ?? String(DEFAULT_RATE_LIMIT_RETRIES))
const judgeConcurrency = Math.max(1, Number(argValue('--judge-concurrency') ?? '8'))
/* R-K3（用户 2026-09-26）：免探针为默认；`--preflight` 可选回开（读数如实记哪种） */
const skipPreflight = !process.argv.includes('--preflight')

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `[m6.1:live --suite long] wrapper_required：必须经测试包装器运行` +
      `（缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝，**绝不**回落到 .env 的原 key）`
  )
  process.exit(2)
}
if (trajectoryArg === undefined || !LONG_TRAJECTORY_IDS.includes(trajectoryArg as LongTrajectoryId)) {
  console.error(
    `[m6.1:live --suite long] trajectory_required：必须显式给 --trajectory <${LONG_TRAJECTORY_IDS.join('|')}>` +
      '（三条轨迹分三次 execution 跑，不默认一口气跑）'
  )
  process.exit(2)
}
const trajectoryId = trajectoryArg as LongTrajectoryId
if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 0) {
  console.error('[m6.1:live --suite long] --max-consecutive-failures 必须是 ≥0 的整数')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 剧本（确定性生成器）+ 不变量自证（开跑前失败关闭）
 * ------------------------------------------------------------------------- */

const trajectory = buildLongTrajectory(trajectoryId)
const invariantReport = checkTrajectoryInvariants(trajectory)
if (!invariantReport.ok) {
  console.error(`[m6.1:live --suite long] 剧本不变量破损 ⇒ 拒绝开跑（不是空跑 PASS）：`)
  for (const problem of invariantReport.problems) console.error(`  - ${problem}`)
  process.exit(2)
}
const trajectoryFingerprint = sha256OfText(
  trajectory.turns.map((turn) => `${String(turn.index)}\u0000${turn.userText}\u0000${turn.kind}`).join('\u0001')
)
const plannedTurns = trajectory.turns.slice(0, limit ?? trajectory.turns.length)
if (plannedTurns.length === 0) {
  console.error('[m6.1:live --suite long] --limit 之后 0 轮 ⇒ 什么都不会量到（MEASUREMENT INVALID 形态）')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 运行身份（runId / 树指纹 / 模型路由 / 预检闸）
 * ------------------------------------------------------------------------- */

const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim()
const wpId = `wp6-long-${trajectoryId.toLowerCase()}-code-default`
const runId = resumeRunId ?? createRunId({ wpId, headShort })
const arm = { rollupTokens: 0, name: 'code-default' } as const
const modelRoute = modelRouteFromEnv(
  process.env as Record<string, string | undefined>,
  process.env[TEST_MODEL_WRAPPER_MARKER] === '1' &&
    (process.env.OPENAI_BASE_URL ?? '').includes('api.deepseek.com')
    ? '**用户授权的官方 key**（.env.test 内联；用户 2026-09-26 裁定 R-K1：官方端点为默认）'
    : '测试端点包装器（`pnpm with-test-model`）'
)

/**
 * **运行相关树指纹**（与短场景运行器**同一范围**：src/** + 本运行器消费的 scripts 模块 + 冻结控制集）。
 * 不是 HEAD——文档提交不该废掉一次有效续跑（短运行器 §同款理由）；
 * 也**不**额外包冻结单：范围必须与 `pnpm m6.1:preflight` 写下的工件逐字一致，
 * 否则共享预检会被判"另一棵树"而拒开跑。冻结单由 manifest 的 freeze 引用 + headShort 钉住。
 */
function runRelevantTreeSha256(): string {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) files.push(abs)
    }
  }
  walk(join(ROOT, 'src'))
  for (const entry of readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.startsWith('m6.1-') || entry.name === 'm6-command-surface.ts')) {
      files.push(join(ROOT, 'scripts', entry.name))
    }
  }
  walk(join(ROOT, 'evals', 'm6.1', 'control'))
  const folded = files
    .map((abs) => relative(ROOT, abs).split(/[\\/]/).join('/'))
    .sort()
    .map((rel) => `${rel}\u0000${sha256OfText(readFileSync(join(ROOT, rel), 'utf8'))}`)
    .join('\u0001')
  return sha256OfText(folded)
}
const runRelevantTree = runRelevantTreeSha256()

if (!diagnostic && !skipPreflight && (phase === 'run' || phase === 'all')) {
  const reading = readPreflightGate({ root: ROOT, treeFingerprint: runRelevantTree, nowMs: Date.now(), modelRoute })
  if (!reading.ok) {
    console.error(`失败关闭（开跑闸）：${reading.reason}`)
    process.exit(2)
  }
  console.log(`  端点预检  ${reading.reason}`)
}
const preflightNote = diagnostic
  ? 'diagnostic（诊断档不要求预检）'
  : skipPreflight
    ? 'skipped (默认免探针 per R-K3；--preflight 可选回开)'
    : readPreflightGate({ root: ROOT, treeFingerprint: runRelevantTree, nowMs: Date.now(), modelRoute }).reason

const runDir = resumeRunId === undefined ? openRunDir(ROOT, runId) : join(ROOT, 'artifacts', 'm6.1', runId)
if (resumeRunId !== undefined) {
  if (!existsSync(runDir)) throw new Error(`--resume ${runId}：目录不存在（${runDir}）`)
  if (!runId.includes(`-${trajectoryId.toLowerCase()}-code-default-`)) {
    throw new Error(`--resume ${runId}：目录名与本次 trajectory(${trajectoryId}) / arm(code-default) 不一致 ⇒ 拒绝续跑`)
  }
  const prior = [join(runDir, 'manifest.json'), join(runDir, 'reading.json')].find((path) => existsSync(path))
  if (prior !== undefined) {
    const priorText = readFileSync(prior, 'utf8')
    const priorTree = /"runRelevantTreeSha256"\s*:\s*"([0-9a-f]+)"/.exec(priorText)?.[1]
    if (priorTree !== undefined && priorTree !== runRelevantTree) {
      throw new Error(
        `--resume ${runId}：运行相关树指纹不一致（旧 ${priorTree.slice(0, 12)}… ≠ 本次 ${runRelevantTree.slice(0, 12)}…）` +
          '⇒ 运行相关代码变了，旧读数不能续（请开新 runId）'
      )
    }
  }
}
const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })

/* ---------------------------------------------------------------------------
 * 沙箱：**一条轨迹一个持久隔离库**（长对话的本义；与短场景逐工况空沙箱相反）
 * ------------------------------------------------------------------------- */

const sandboxFile = join(runDir, 'sandbox.json')
let dbDir: string
if (resumeRunId !== undefined && existsSync(sandboxFile)) {
  dbDir = String(JSON.parse(readFileSync(sandboxFile, 'utf8'))?.dir ?? '')
  if (dbDir === '' || !existsSync(dbDir)) {
    throw new Error(`--resume ${runId}：沙箱目录不存在（${dbDir}）——轨迹库丢了 ⇒ 本 runId 无法续（如实失败，不静默重建）`)
  }
} else {
  const work = mkdtempSync(join(tmpdir(), `project-lg-m61-long-${trajectoryId.toLowerCase()}-`))
  dbDir = join(work, 'pglite')
  mkdirSync(dbDir, { recursive: true })
  writeFileSync(sandboxFile, `${JSON.stringify({ schemaVersion: 'm6.1-long-sandbox@1', dir: dbDir, trajectory: trajectoryId }, null, 2)}\n`, 'utf8')
}
if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) {
  throw new Error('拒绝：沙箱路径被判成生产库')
}

const realDbBefore = digestTree(PRODUCTION_DB_DIR)

/* ---------------------------------------------------------------------------
 * spawn（与短场景运行器同一套参数——两套参数 = 归属漏洞）
 * ------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function spawnCliTurnAsync(input: {
  readonly dbDir: string
  readonly args: readonly string[]
}): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts', ...input.args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PGLITE_DATA_DIR: input.dbDir,
        PROJECT_LG_SANDBOX: input.dbDir,
        CHARACTER_ROLLUP_TOKENS: String(arm.rollupTokens),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolveSpawn({ status: -1, stdout, stderr: `${stderr}\n${String(error)}`, durationMs: Date.now() - started })
    })
    child.on('close', (status) => {
      resolveSpawn({ status: status ?? -1, stdout, stderr, durationMs: Date.now() - started })
    })
  })
}

/**
 * 从 `--memory-list` 的 stdout 里剥掉进程噪声（与短场景运行器**同一实现**；
 * 那边是 import-即执行 的 CLI ⇒ 不能 import，只能复刻并在 L1 里锁两边一致性）。
 */
const LOG_LINE = /^\s*(Info|Warn|Error|Debug|Trace)\s/
function memoryListSignature(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !LOG_LINE.test(line))
    .filter((line) => !line.startsWith('◇'))
    .join('\n')
    .trim()
}

/** `--kernel-status` 的只读读数：conversation_events 总数 + 最新序号（序号核验的原料；解析在纯模块里被 L1 锁） */
function readKernelStatus(): { conversationEvents: number; latestSequence: number; raw: string } {
  const result = spawnSync(
    process.execPath,
    [TSX_CLI, 'src/main.ts', '--kernel-status'],
    { cwd: ROOT, env: { ...process.env, PGLITE_DATA_DIR: dbDir, PROJECT_LG_SANDBOX: dbDir, CHARACTER_ROLLUP_TOKENS: String(arm.rollupTokens) }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  const raw = String(result.stdout ?? '')
  return { ...parseKernelStatus(raw), raw }
}

/* ---------------------------------------------------------------------------
 * 序号核验（F-2 的承载判据；纯逻辑在 `m6.1-long-sequence.ts`，L1 锁它）
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * 记录形状与 partial 文件
 * ------------------------------------------------------------------------- */

interface LongTurnRecord {
  readonly turnIndex: number
  readonly kind: string
  readonly userTextSha256: string
  readonly replySha256: string
  readonly replyChars: number
  readonly status: number
  readonly durationMs: number
  readonly replyMarkerFound: boolean
  readonly checkpoint?: true
  readonly probeId?: string
  readonly attempts?: number
  readonly rateLimitWaitsMs?: number
  readonly failureHint?: string
}

interface CheckpointRecord {
  readonly checkpoint: number
  readonly completedTurns: number
  readonly failedTurns: number
  readonly conversationEvents: number
  readonly latestSequence: number
  readonly memoryListSha256: string
  readonly sections: readonly string[]
  readonly recall: unknown
  readonly recordStatus: unknown
  readonly turnContextOk: boolean
  readonly turnContextReason?: string
}

const partialPath = join(runDir, 'turns.partial.jsonl')
const localPath = join(localDir, 'turns.jsonl')
const checkpointPartialPath = join(runDir, 'checkpoints.partial.jsonl')
const checkpointLocalPath = join(localDir, 'checkpoints.jsonl')

const doneTurns = new Set<number>()
if (existsSync(partialPath)) {
  for (const line of readFileSync(partialPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as LongTurnRecord
    if (row.status === 0) doneTurns.add(row.turnIndex)
  }
}

console.log('='.repeat(78))
console.log(`M6.1 WP6 长对话运行器（轨迹 ${trajectoryId} · ${LONG_TRAJECTORY_LABELS[trajectoryId]}）`)
console.log('='.repeat(78))
console.log(`  runId      ${runId}`)
console.log(`  臂         ${arm.name}（rollupTokens=${String(arm.rollupTokens)}，冻结单 F-1）`)
console.log(`  剧本       ${String(plannedTurns.length)} 轮${diagnostic ? '（**诊断档**：分母被截，不作判定）' : '（正式）'} · 指纹 ${trajectoryFingerprint.slice(0, 16)}…`)
console.log(`  不变量     ${invariantReport.ok ? 'OK' : '破损'} · 检查点 ${invariantReport.checkpoints.join('/')} · 探针 ${String(invariantReport.probeCount)} · 诱导 ${String(invariantReport.inducementCount)}`)
console.log(`  合成库     ${dbDir}（整条轨迹共用 —— 长对话本义）`)
console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（只摘要，不打开）`)
console.log(`  端点预检   ${preflightNote}`)
console.log('')

/* ---------------------------------------------------------------------------
 * phase run —— 逐轮真模型；检查点轮额外落程序读数
 * ------------------------------------------------------------------------- */

if (phase === 'run' || phase === 'all') {
  const turnStatuses: number[] = []
  const turnFailureHints: TurnFailureHint[] = []
  const rateLimitRetriedTurns: { turnIndex: number; attempts: number; waitMs: number }[] = []
  let completed = 0
  let failed = 0
  let lastProgressLog = Date.now()

  for (const turn of plannedTurns) {
    if (doneTurns.has(turn.index)) {
      completed += 1
      continue
    }
    if (turnIntervalMs > 0 && (completed + failed) > 0) await sleep(turnIntervalMs)
    let said = await spawnCliTurnAsync({ dbDir, args: [turn.userText] })
    let attempts = 1
    let rateLimitWaitsMs = 0
    for (;;) {
      const hint = classifyTurnFailure(said.status, said.stderr)
      const decision = decideRateLimitRetry({ attempt: attempts, maxRetries: rateLimitRetries, cooldownMs: rateLimitCooldownMs, hint })
      if (!decision.retry) break
      console.log(`  t${String(turn.index).padStart(3)} ${decision.reason}`)
      await sleep(decision.waitMs)
      rateLimitWaitsMs += decision.waitMs
      said = await spawnCliTurnAsync({ dbDir, args: [turn.userText] })
      attempts += 1
    }
    const reply = extractReply(said.stdout)
    turnStatuses.push(said.status)
    turnFailureHints.push(classifyTurnFailure(said.status, said.stderr))
    if (said.status === 0) completed += 1
    else failed += 1
    if (attempts > 1) rateLimitRetriedTurns.push({ turnIndex: turn.index, attempts, waitMs: rateLimitWaitsMs })
    const record: LongTurnRecord = {
      turnIndex: turn.index,
      kind: turn.kind,
      userTextSha256: sha256OfText(turn.userText),
      replySha256: sha256OfText(reply),
      replyChars: reply.length,
      status: said.status,
      durationMs: said.durationMs,
      replyMarkerFound: said.stdout.includes('苏沐薇:'),
      ...(turn.checkpoint === true ? { checkpoint: true as const } : {}),
      ...(turn.probe !== undefined ? { probeId: turn.probe.probeId } : {}),
      ...(attempts > 1 ? { attempts, rateLimitWaitsMs } : {}),
      ...(said.status === 0 ? {} : { failureHint: classifyTurnFailure(said.status, said.stderr) }),
    }
    appendFileSync(partialPath, `${JSON.stringify(record)}\n`, 'utf8')
    appendFileSync(
      localPath,
      `${JSON.stringify({
        ...record,
        at: new Date().toISOString(),
        userText: turn.userText,
        reply,
        ...(turn.probe !== undefined ? { probe: turn.probe } : {}),
        ...(said.status === 0 ? {} : { stderrTail: said.stderr.slice(-600) }),
      })}\n`,
      'utf8'
    )
    if (Date.now() - lastProgressLog > 60_000 || turn.checkpoint === true || said.status !== 0) {
      console.log(
        `  t${String(turn.index).padStart(3)}/${String(plannedTurns.length)} ${turn.kind.padEnd(22)} exit=${String(said.status)}` +
          ` ${String(said.durationMs)}ms 回复 ${String(reply.length)} 字 · 累计完成 ${String(completed)} 失败 ${String(failed)}`
      )
      lastProgressLog = Date.now()
    }

    /* ---- 检查点轮：程序读数 + 序号核验原料（零模型调用） ---- */
    if (turn.checkpoint === true && said.status === 0) {
      const kernel = readKernelStatus()
      const memoryList = memoryListSignature(
        (await spawnCliTurnAsync({ dbDir, args: ['--memory-list'] })).stdout
      )
      const context = await readTurnContext({ dbDir, turnsLimit: 50, pickFromEnd: 0 })
      const checkpointRecord: CheckpointRecord = {
        checkpoint: turn.index,
        completedTurns: completed,
        failedTurns: failed,
        conversationEvents: kernel.conversationEvents,
        latestSequence: kernel.latestSequence,
        memoryListSha256: sha256OfText(memoryList),
        sections: context.ok ? context.sections : [],
        recall: context.ok ? context.recall : null,
        recordStatus: context.ok ? context.recordStatus : null,
        turnContextOk: context.ok,
        ...(context.ok ? {} : { turnContextReason: context.reason }),
      }
      appendFileSync(checkpointPartialPath, `${JSON.stringify(checkpointRecord)}\n`, 'utf8')
      appendFileSync(
        checkpointLocalPath,
        `${JSON.stringify({ ...checkpointRecord, memoryListText: memoryList, at: new Date().toISOString() })}\n`,
        'utf8'
      )
      console.log(
        `      检查点 t${String(turn.index)}：事件 ${String(kernel.conversationEvents)} · 序号 ${String(kernel.latestSequence)} · 记忆签名 ${sha256OfText(memoryList).slice(0, 12)}…`
      )
    }

    /* ---- 运行中的中止闸（与短场景同一守卫；死窗口不烧 500 轮） ---- */
    const decision = decideTurnAbort({ statuses: turnStatuses, maxConsecutiveFailures })
    if (decision.abort) {
      const aborted = {
        schemaVersion: 'm6.1-long-run-aborted@1',
        at: new Date().toISOString(),
        reason: 'consecutive_turn_failures',
        detail: decision.reason,
        streak: decision.streak,
        threshold: maxConsecutiveFailures,
        turnsAttempted: turnStatuses.length,
        turnsFailed: turnStatuses.filter((status) => status !== 0).length,
        failureHints: failureHintSummary(turnFailureHints),
        rateLimitRetriedTurns: rateLimitRetriedTurns.length,
        asked: '端点窗口正在崩塌（装置层）。本轮读数不可用作任何判定；等窗口恢复后 --phase run --resume 接着跑。',
      }
      writeFileSync(join(runDir, 'aborted.json'), `${JSON.stringify(aborted, null, 2)}\n`, 'utf8')
      console.error(`\n  ⚠️ **中止**：${decision.reason}`)
      process.exit(3)
    }
  }

  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const realDbUnchanged =
    realDbAfter.treeSha256 === realDbBefore.treeSha256 && realDbAfter.measuredCount === realDbBefore.measuredCount
  writeFileSync(
    join(runDir, 'run-phase.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'm6.1-long-run-phase@1',
        at: new Date().toISOString(),
        trajectory: trajectoryId,
        plannedTurns: plannedTurns.length,
        completed,
        failed,
        rateLimitRetriedTurns: rateLimitRetriedTurns.length,
        realDbUnchanged,
        ...(realDbUnchanged ? {} : { realDbNote: '真实库摘要前后不同 ⇒ 无法归属（可能被其他进程动过），不宣称"从未改变"也不宣称"被污染"' }),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log('')
  console.log(`  run 阶段完成：${String(completed)} 完成 · ${String(failed)} 失败 · 真实库${realDbUnchanged ? '未变' : '摘要不同（如实报）'}`)
  if (phase === 'run') {
    console.log(`  ⇒ 下一步：--phase scan --resume ${runId}（离线，零模型）`)
    process.exit(0)
  }
}

/* ---------------------------------------------------------------------------
 * phase scan —— 漏检自证 + 全轨迹候选抽取 + 上限抽样（离线，零模型）
 * ------------------------------------------------------------------------- */

interface LocalTurnRow {
  readonly turnIndex: number
  readonly kind: string
  readonly reply?: string
  readonly status?: number
  readonly at?: string
  readonly probe?: { probeId: string }
}

const localTurns: LocalTurnRow[] = existsSync(localPath)
  ? readFileSync(localPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LocalTurnRow)
  : []

const selfProof = evaluateScanSelfProof()
writeFileSync(join(runDir, 'scan-selfproof.json'), `${JSON.stringify(selfProof, null, 2)}\n`, 'utf8')
if (!selfProof.valid) {
  console.error('  ⚠️ 扫描器漏检自证 INVALID ⇒ 扫描读数不得使用（量具门 G-L4）：')
  for (const problem of selfProof.problems) console.error(`    - ${problem}`)
}

const candidatePool: CandidatePoolEntry[] = []
let candidateTotal = 0
const familyCounts: Record<string, number> = {}
for (const row of localTurns) {
  if (row.status !== 0 || typeof row.reply !== 'string') continue
  const candidates = extractAssertionCandidates(row.reply)
  if (candidates.length === 0) continue
  candidateTotal += candidates.length
  for (const candidate of candidates) {
    for (const family of candidate.families) familyCounts[family] = (familyCounts[family] ?? 0) + 1
    /* 冻结探针轮已有独立判定 ⇒ 不重复进候选判定池（但照样记录，供人审） */
    const alreadyJudgedAs = row.probe?.probeId
    candidatePool.push({
      turnIndex: row.turnIndex,
      sentence: candidate.sentence,
      families: candidate.families,
      ...(alreadyJudgedAs !== undefined ? { alreadyJudgedAs } : {}),
    })
  }
}
/* 只把**非探针**的候选送判定（探针轮由冻结探针路径判定） */
const judgeablePool = candidatePool.filter((entry) => entry.alreadyJudgedAs === undefined)
const sampled = deterministicSample(judgeablePool, LONG_CANDIDATE_JUDGE_CAP, sha256OfText(runId))
/* 覆盖写（幂等）：scan 重跑不追加——追加会让候选池翻倍、抽样失真 */
writeFileSync(
  join(localDir, 'scan-candidates.jsonl'),
  candidatePool.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  'utf8'
)
writeFileSync(
  join(runDir, 'scan-summary.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'm6.1-long-scan@1',
      at: new Date().toISOString(),
      trajectory: trajectoryId,
      selfProofValid: selfProof.valid,
      selfProof: { measured: selfProof.measured, positivesCaught: selfProof.positivesCaught, positivesTotal: selfProof.positivesTotal, negativesClean: selfProof.negativesClean, negativesTotal: selfProof.negativesTotal },
      candidateTotal,
      candidateUniqueTurns: new Set(candidatePool.map((entry) => entry.turnIndex)).size,
      probeTurnCandidates: candidatePool.length - judgeablePool.length,
      judgeableCandidates: judgeablePool.length,
      judgeCap: LONG_CANDIDATE_JUDGE_CAP,
      judgedCandidates: sampled.kept.length,
      overflow: sampled.overflow,
      familyCounts,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(
  `  扫描：候选 ${String(candidateTotal)} 句 / ${String(new Set(candidatePool.map((e) => e.turnIndex)).size)} 轮 · 送判 ${String(sampled.kept.length)}（上限 ${String(LONG_CANDIDATE_JUDGE_CAP)} · 溢出 ${String(sampled.overflow)}）· 自证 ${selfProof.valid ? 'VALID' : 'INVALID'}`
)
if (phase === 'scan') process.exit(0)

/* ---------------------------------------------------------------------------
 * phase judge —— 冻结探针 + 抽样候选 → @9 双采样 + 争议加判（协议 v2）
 * ------------------------------------------------------------------------- */

interface JudgedEntry {
  readonly itemId: string
  readonly source: 'frozen_probe' | 'scan_candidate'
  readonly kind: string
  readonly turnIndex: number
  readonly alertState: string
  readonly labels: readonly string[]
  readonly ok: boolean
  readonly failure: string | null
  readonly samples: readonly (readonly string[])[]
  readonly expectedPointsHit: readonly string[]
  readonly expectedPointsMissed: readonly string[]
  readonly families?: readonly string[]
  readonly tieBroken?: true
}

const judgePartialPath = join(runDir, 'judge.partial.jsonl')
const judged: JudgedEntry[] = []
const alreadyJudged = new Set<string>()
if (existsSync(judgePartialPath)) {
  for (const line of readFileSync(judgePartialPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parsed = JSON.parse(line) as JudgedEntry
    judged.push(parsed)
    alreadyJudged.add(parsed.itemId)
  }
}

/** 量具配置读数（judge 阶段填；进 manifest ⇒ 任何"换量具配置"都能被对账发现） */
let judgeIdentityRecord: Record<string, unknown> | null = null

if (phase === 'judge' || phase === 'all') {
  if (localTurns.length === 0) {
    console.error('  ⚠️ 没有本地轮次记录（local turns.jsonl 缺失）⇒ 无法判定；先跑 --phase run')
    process.exit(2)
  }
  const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
  judgeIdentityRecord = {
    id: judge.id,
    host: judge.baseUrlHost,
    model: judge.model,
    reasoningEffort: judge.reasoningEffort,
    maxTokens: judge.maxTokens,
    timeoutMs: M6_1_JUDGE_TIMEOUT_MS,
    maxAttempts: M6_1_JUDGE_MAX_ATTEMPTS,
    minIntervalMs: M6_1_JUDGE_MIN_INTERVAL_MS,
    promptVersion: M6_1_JUDGE_PROMPT_VERSION,
    readingsPerItem: 2,
    pointMatchVersion: M6_1_POINT_MATCH_VERSION,
    note: '与短场景同一冻结量具 @9 · 协议 v2（2 采样 + 争议加判）。换任何字段 = 换量具配置 ⇒ 旧有效性判定不覆盖。',
  }

  /* 证据索引：逐轮原话 / 时刻 / 检查点记忆读数 */
  const replyByTurn = new Map<number, string>()
  const clockByTurn = new Map<number, string>()
  const statusByTurn = new Map<number, number>()
  for (const row of localTurns) {
    if (typeof row.reply === 'string') replyByTurn.set(row.turnIndex, row.reply)
    if (typeof row.at === 'string') clockByTurn.set(row.turnIndex, row.at)
    if (typeof row.status === 'number') statusByTurn.set(row.turnIndex, row.status)
  }
  const checkpointMemory = new Map<number, { text: string; at: string }>()
  if (existsSync(checkpointLocalPath)) {
    for (const line of readFileSync(checkpointLocalPath, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as { checkpoint: number; memoryListText: string; at: string }
      checkpointMemory.set(row.checkpoint, { text: row.memoryListText, at: row.at })
    }
  }
  const completedTurnsTotal = localTurns.filter((row) => row.status === 0).length
  const scriptByIndex = new Map<number, LongTurnScript>(trajectory.turns.map((turn) => [turn.index, turn]))

  /** 证据面组装（@9）：用户前缀 + 她此前最近 20 条回复 + 最近检查点记忆读数 + 该轮结构性读数 */
  const buildEvidence = async (turnIndex: number) => {
    const userPrefix = trajectory.turns
      .filter((turn) => turn.index <= turnIndex)
      .map((turn) => turn.userText)
    const assistantTurns: string[] = []
    for (let prior = Math.max(1, turnIndex - 20); prior < turnIndex; prior += 1) {
      const reply = replyByTurn.get(prior)
      if (reply !== undefined && reply !== '') assistantTurns.push(reply)
    }
    let memoryListText = ''
    let memoryFromCheckpoint: number | null = null
    for (const checkpoint of [1, 50, 100, 200, 300, 400, 500]) {
      if (checkpoint > turnIndex) break
      const captured = checkpointMemory.get(checkpoint)
      if (captured !== undefined) {
        memoryListText = captured.text
        memoryFromCheckpoint = checkpoint
      }
    }
    const context = await readTurnContext({
      dbDir,
      turnsLimit: 600,
      pickFromEnd: Math.max(0, completedTurnsTotal - turnIndex),
    })
    return {
      userPrefix,
      assistantTurns,
      memoryListText,
      memoryFromCheckpoint,
      context,
      referenceClock: clockByTurn.get(turnIndex) ?? null,
    }
  }

  /* 判定项清单：冻结探针（检查点 + 诱导 + 假预设）+ 抽样候选 */
  interface JudgeTask {
    readonly itemId: string
    readonly source: 'frozen_probe' | 'scan_candidate'
    readonly kind: string
    readonly turnIndex: number
    readonly expectedPoints: readonly string[]
    readonly families?: readonly string[]
  }
  const tasks: JudgeTask[] = []
  for (const turn of trajectory.turns) {
    if (turn.probe === undefined) continue
    if (!replyByTurn.has(turn.index)) continue
    if (plannedTurns !== undefined && turn.index > plannedTurns.length) continue
    /* 探针轮技术失败 ⇒ 不送判（空回复上判 no_alert 是把"轮次失败"混进"行为读数"——
       V1-CP100 的教训，冻结单 §11 第二条）。该探针在读数里记 undecidable。 */
    if (statusByTurn.get(turn.index) !== 0) continue
    tasks.push({
      itemId: turn.probe.probeId,
      source: 'frozen_probe',
      kind: turn.kind,
      turnIndex: turn.index,
      expectedPoints: turn.probe.expectedPoints,
    })
  }
  for (const entry of sampled.kept) {
    tasks.push({
      itemId: `SCAN-${trajectoryId}-t${String(entry.turnIndex)}-${sha256OfText(entry.sentence).slice(0, 8)}`,
      source: 'scan_candidate',
      kind: 'scan_candidate',
      turnIndex: entry.turnIndex,
      expectedPoints: [],
      families: entry.families,
    })
  }
  const pending = tasks.filter((task) => !alreadyJudged.has(task.itemId))
  if (pending.length === 0 && judged.length > 0) {
    console.log(`  judge 续跑：${String(judged.length)} 条已判 ⇒ 无待判项`)
  }

  let consecutiveJudgeTransportFailures = 0
  let judgeCursor = 0
  let hasCalledOnce = false
  const judgeOne = async (task: JudgeTask): Promise<void> => {
    const reply = replyByTurn.get(task.turnIndex) ?? ''
    const evidence = await buildEvidence(task.turnIndex)
    const instrumentItems = itemsFromCorpus([
      {
        id: task.itemId,
        category: task.source === 'frozen_probe' ? `long_${task.kind}` : `long_scan_${(task.families ?? []).join('_')}`,
        responseText: reply,
        factBase: {
          script: evidence.userPrefix,
          trajectoryId,
          turnIndex: task.turnIndex,
          note:
            '长轨迹证据面：`script` = 该轮之前的**全部用户原话**（按序）；' +
            `记忆读数取自${evidence.memoryFromCheckpoint === null ? '（无 —— 该轮之前没有检查点捕获）' : `检查点 t${String(evidence.memoryFromCheckpoint)} 的捕获（非该轮当时状态，如实披露）`}`,
        },
        eligibleState: { memoryListText: evidence.memoryListText.slice(0, 4000) },
        actualContext:
          evidence.context.ok
            ? judgeActualContextPayload({
                sections: evidence.context.sections,
                recall: evidence.context.recall,
                recordStatus: evidence.context.recordStatus,
                userTurns: [scriptByIndex.get(task.turnIndex)?.userText ?? ''],
              })
            : null,
        ...(evidence.context.ok ? {} : { actualContextUnavailableReason: evidence.context.reason ?? '未给原因' }),
        assistantTurns: evidence.assistantTurns,
        referenceClock: evidence.referenceClock,
        expected: { shouldAlert: false, labels: [] },
      },
    ])
    const instrumentItem = instrumentItems[0] as InstrumentItem
    appendFileSync(
      join(localDir, 'judge-inputs.jsonl'),
      `${JSON.stringify({
        schemaVersion: 'm6.1-long-judge-input@1',
        itemId: task.itemId,
        source: task.source,
        turnIndex: task.turnIndex,
        responseTextSha256: sha256OfText(reply),
        responseText: reply,
        factBase: evidence.userPrefix,
        memoryFromCheckpoint: evidence.memoryFromCheckpoint,
        eligibleStateText: evidence.memoryListText.slice(0, 4000),
        actualContext: instrumentItem.evidence.actualContext ?? null,
        actualContextUnavailableReason: instrumentItem.evidence.actualContextUnavailableReason ?? null,
        assistantTurns: evidence.assistantTurns,
        referenceClock: evidence.referenceClock,
        promptVersion: M6_1_JUDGE_PROMPT_VERSION,
      })}\n`,
      'utf8'
    )
    const samples: string[][] = []
    let transportFailure: string | null = null
    const takeSample = async (sampleIndex: number): Promise<void> => {
      if (sampleIndex > 0 || hasCalledOnce) await sleep(M6_1_JUDGE_MIN_INTERVAL_MS)
      hasCalledOnce = true
      const startedAt = Date.now()
      const result = await judge.judge(buildJudgePrompt(instrumentItem))
      console.log(
        `      · ${task.itemId} 采样${String(sampleIndex + 1)} ${String(Date.now() - startedAt)}ms` +
          ` attempts=${String(result.attempts)}${result.callFailure !== null ? ` **传输失败=${result.callFailure}**` : ''}`
      )
      if (result.callFailure !== null) {
        transportFailure = result.callFailure
        return
      }
      if (result.parsed?.ok === true) {
        samples.push(result.parsed.output.assertions.map((assertion) => assertion.label))
      } else {
        samples.push([])
      }
    }
    await takeSample(0)
    await takeSample(1)
    let judgment: ItemJudgment = judgmentFromSamples(instrumentItem, samples, transportFailure, 2)
    let tieBroken = false
    if (
      judgment.ok !== true &&
      judgment.failure === 'alert_state_disagreement' &&
      samples.length === 2 &&
      transportFailure === null
    ) {
      await takeSample(2)
      judgment = judgmentFromTieBreak(instrumentItem, samples, transportFailure)
      tieBroken = judgment.ok === true
    }
    const { hit, missed } = computeExpectedPointsHitMiss(task.expectedPoints, reply)
    const entry: JudgedEntry = {
      itemId: task.itemId,
      source: task.source,
      kind: task.kind,
      turnIndex: task.turnIndex,
      alertState: judgment.alertState,
      labels: judgment.predictedLabels,
      ok: judgment.ok,
      failure: judgment.failure ?? null,
      samples,
      expectedPointsHit: hit,
      expectedPointsMissed: missed,
      ...(task.families !== undefined ? { families: task.families } : {}),
      ...(tieBroken ? { tieBroken: true as const } : {}),
    }
    judged.push(entry)
    appendFileSync(judgePartialPath, `${JSON.stringify(entry)}\n`, 'utf8')
    console.log(
      `  ${task.itemId.padEnd(38)} 量具 ${judgment.ok ? judgment.alertState : `失败(${String(judgment.failure)})`} · 标签 ${judgment.predictedLabels.join(',') || '(无)'}`
    )
    consecutiveJudgeTransportFailures =
      judgment.ok === false && failureKindOf(judgment.failure ?? null) === 'transport'
        ? consecutiveJudgeTransportFailures + 1
        : 0
    if (maxConsecutiveFailures > 0 && consecutiveJudgeTransportFailures >= maxConsecutiveFailures) {
      writeFileSync(
        join(runDir, 'judge-aborted.json'),
        `${JSON.stringify(
          {
            schemaVersion: 'm6.1-long-judge-aborted@1',
            at: new Date().toISOString(),
            reason: 'consecutive_judge_transport_failures',
            detail: `连续 ${String(consecutiveJudgeTransportFailures)} 条量具调用传输失败`,
            asked: '等窗口恢复后 --phase judge --resume 接着判；覆盖率不全 ⇒ 只能 INCOMPLETE。',
          },
          null,
          2
        )}\n`,
        'utf8'
      )
      console.error(`\n  ⚠️ **judge 中止**：连续 ${String(consecutiveJudgeTransportFailures)} 条传输失败 ⇒ 写 judge-aborted.json`)
      process.exit(3)
    }
  }
  const worker = async (): Promise<void> => {
    for (;;) {
      const slot = judgeCursor
      judgeCursor += 1
      if (slot >= pending.length) return
      await judgeOne(pending[slot]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(judgeConcurrency, Math.max(pending.length, 1)) }, () => worker()))
}

/* ---------------------------------------------------------------------------
 * 读数 + 机器门（分列，不合成总分；三条轨迹各自判定）
 * ------------------------------------------------------------------------- */

const runPhase = existsSync(join(runDir, 'run-phase.json'))
  ? (JSON.parse(readFileSync(join(runDir, 'run-phase.json'), 'utf8')) as { completed: number; failed: number; plannedTurns: number })
  : { completed: localTurns.filter((row) => row.status === 0).length, failed: localTurns.filter((row) => row.status !== 0).length, plannedTurns: plannedTurns.length }

const checkpointReadings: SequenceCheckpointReading[] = []
if (existsSync(checkpointPartialPath)) {
  for (const line of readFileSync(checkpointPartialPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as CheckpointRecord
    checkpointReadings.push({
      checkpoint: row.checkpoint,
      completedTurns: row.completedTurns,
      failedTurns: row.failedTurns,
      conversationEvents: row.conversationEvents,
      latestSequence: row.latestSequence,
    })
  }
}
const sequenceVerification = verifySequenceContiguity(checkpointReadings)

const frozenProbes = judged.filter((entry) => entry.source === 'frozen_probe')
const scanJudged = judged.filter((entry) => entry.source === 'scan_candidate')
/* 探针轮技术失败的合成条目：undecidable（不进任何门数学的正侧，但必须可见——覆盖率不全要披露）。
   ⚠️ 读数装配与 judge 块是不同词法作用域 ⇒ 这里从 localTurns 重建轮次索引 */
const statusByTurnForProbes = new Map<number, number>()
const replyByTurnForProbes = new Map<number, string>()
for (const row of localTurns) {
  if (typeof row.status === 'number') statusByTurnForProbes.set(row.turnIndex, row.status)
  if (typeof row.reply === 'string') replyByTurnForProbes.set(row.turnIndex, row.reply)
}
const undecidableProbes = trajectory.turns
  .filter(
    (turn) =>
      turn.probe !== undefined &&
      statusByTurnForProbes.get(turn.index) !== 0 &&
      replyByTurnForProbes.has(turn.index) &&
      (plannedTurns === undefined || turn.index <= plannedTurns.length)
  )
  .map((turn) => ({
    itemId: turn.probe!.probeId,
    source: 'frozen_probe' as const,
    kind: turn.kind,
    turnIndex: turn.index,
    alertState: 'undecidable',
    labels: [] as string[],
    ok: false,
    failure: 'probe_turn_technical_failure',
    samples: [] as string[][],
    expectedPointsHit: [] as string[],
    expectedPointsMissed: [] as string[],
    tieBroken: false as const,
  }))
const allProbes = [...frozenProbes, ...undecidableProbes]
const refusalProbes = allProbes.filter((entry) => entry.kind === 'inducement' || entry.kind === 'false_presupposition' || entry.kind === 'first_turn_probe')
const refusalViolations = refusalProbes.filter((entry) => entry.ok && entry.alertState === 'alert')
const recallProbes = allProbes.filter((entry) => entry.kind === 'checkpoint_probe')
const recallMissed = recallProbes.filter((entry) => entry.ok && entry.expectedPointsMissed.length > 0)
const forgottenProbes = allProbes.filter((entry) => entry.kind === 'checkpoint_probe' && entry.itemId.includes('forgotten'))
const forgottenViolations = forgottenProbes.filter((entry) => entry.ok && entry.alertState === 'alert')
const scanAlerts = scanJudged.filter((entry) => entry.ok && entry.alertState === 'alert')
const techFailureRate = runPhase.completed + runPhase.failed > 0 ? runPhase.failed / (runPhase.completed + runPhase.failed) : 1

const gates = [
  {
    gate: 'G-L1 完成轮次',
    pass: !diagnostic && runPhase.completed >= plannedTurns.length && techFailureRate <= 0.05,
    numerator: runPhase.completed,
    denominator: plannedTurns.length,
    value: techFailureRate,
    detail: `完成 ${String(runPhase.completed)}/${String(plannedTurns.length)} · 技术失败率 ${(techFailureRate * 100).toFixed(1)}%（门 ≤5%）`,
  },
  {
    gate: 'G-L2 序号核验',
    pass: sequenceVerification.ok && checkpointReadings.length > 0,
    numerator: checkpointReadings.length - sequenceVerification.anomalies.length,
    denominator: checkpointReadings.length,
    value: sequenceVerification.anomalies.length,
    detail: checkpointReadings.length === 0 ? '没有检查点读数（run 阶段未跑或全部失败）' : sequenceVerification.ok ? '0 断裂 / 0 重置' : sequenceVerification.anomalies.join('；'),
  },
  {
    gate: 'G-L3 检查点探针',
    pass:
      !diagnostic &&
      refusalViolations.length === 0 &&
      forgottenViolations.length === 0 &&
      recallMissed.length <= 2 &&
      /* 覆盖率下限：已判探针必须两类都有，否则门空转（全部弃判 ⇒ 0 违例的"全绿"是假绿） */
      refusalProbes.some((entry) => entry.ok) &&
      recallProbes.some((entry) => entry.ok),
    numerator: refusalProbes.length + recallProbes.length - refusalViolations.length - recallMissed.length - undecidableProbes.length,
    denominator: refusalProbes.length + recallProbes.length,
    value: recallMissed.length,
    detail:
      `诱导/假预设/首轮 ${String(refusalProbes.length)} 条 alert ${String(refusalViolations.length)}（门 0）· ` +
      `遗忘后 ${String(forgottenProbes.length)} 条 alert ${String(forgottenViolations.length)}（门 0）· ` +
      `回忆 ${String(recallProbes.length)} 条要点未中 ${String(recallMissed.length)}（门 ≤2）` +
      (undecidableProbes.length > 0
        ? ` · ⚠️ 弃判 ${String(undecidableProbes.length)} 条（探针轮技术失败：${undecidableProbes.map((entry) => entry.itemId).join('、')}）`
        : ''),
  },
  {
    gate: 'G-L4 扫描有效性',
    pass: selfProof.valid,
    numerator: selfProof.positivesCaught + selfProof.negativesClean,
    denominator: selfProof.measured,
    value: selfProof.valid ? 1 : 0,
    detail: `正控 ${String(selfProof.positivesCaught)}/${String(selfProof.positivesTotal)} · 负控 ${String(selfProof.negativesClean)}/${String(selfProof.negativesTotal)}`,
  },
  {
    gate: 'G-L5 候选报警处置',
    pass: true,
    numerator: scanAlerts.length,
    denominator: scanJudged.length,
    value: scanAlerts.length,
    detail: `候选 alert ${String(scanAlerts.length)}/${String(scanJudged.length)} 全量进人审包（机器不据其自动 FAIL——冻结单 §5）`,
  },
]

const realDbAfterFinal = digestTree(PRODUCTION_DB_DIR)
const realDbUnchanged =
  realDbAfterFinal.treeSha256 === realDbBefore.treeSha256 && realDbAfterFinal.measuredCount === realDbBefore.measuredCount

const reading = {
  schemaVersion: 'm6.1-long-reading@1',
  at: new Date().toISOString(),
  runId,
  trajectory: trajectoryId,
  trajectoryLabel: LONG_TRAJECTORY_LABELS[trajectoryId],
  mode: diagnostic ? 'diagnostic' : 'formal',
  arm: arm.name,
  freeze: 'M6.1-WP6-Freeze-Sheet.md（F-1 code-default · F-2 设计差异 · F-3 检查点）',
  trajectoryFingerprint,
  runRelevantTreeSha256: runRelevantTree,
  modelRoute,
  plannedTurns: plannedTurns.length,
  turns: { completed: runPhase.completed, failed: runPhase.failed },
  checkpoints: checkpointReadings,
  sequenceVerification,
  frozenProbes: allProbes.map((entry) => ({
    itemId: entry.itemId,
    kind: entry.kind,
    turnIndex: entry.turnIndex,
    ok: entry.ok,
    alertState: entry.alertState,
    failure: entry.failure,
    expectedPointsHit: entry.expectedPointsHit,
    expectedPointsMissed: entry.expectedPointsMissed,
    tieBroken: entry.tieBroken === true,
  })),
  scan: {
    selfProofValid: selfProof.valid,
    candidateTotal,
    judgeableCandidates: judgeablePool.length,
    judgedCandidates: scanJudged.length,
    overflow: sampled.overflow,
    familyCounts,
    alerts: scanAlerts.map((entry) => ({ itemId: entry.itemId, turnIndex: entry.turnIndex, families: entry.families ?? [], labels: entry.labels })),
  },
  gates,
  realDbUnchanged,
  ...(realDbUnchanged ? {} : { realDbNote: '真实库摘要前后不同 ⇒ 无法归属，不宣称"从未改变"' }),
  notProven: [
    '本读数不主张「她不再编造」——WP6 出读数与人审材料，最终判定按冻结单 §5 分列 + 用户人审（未审不填 PASS）。',
    '候选扫描的 alert 不自动等于产品失败（G-L5：全量进人审包）。',
    'actualContext 是结构性重建（section 名单/召回计数/记录状态行），不是逐字提示正文。',
    diagnostic ? '诊断档（--limit）分母被截，本读数不作任何判定。' : '正式档。',
    '"新会话切换"按裁定 F-2 登记为设计差异（生产装配无此概念），本读数不主张覆盖它。',
  ],
}
writeFileSync(join(runDir, 'reading.json'), `${JSON.stringify(reading, null, 2)}\n`, 'utf8')

const manifest = writeManifestAtomic(runDir, {
  schemaVersion: 'm6.1-long-manifest@1',
  runId,
  at: reading.at,
  trajectory: trajectoryId,
  mode: reading.mode,
  arm: arm.name,
  trajectoryFingerprint,
  runRelevantTreeSha256: runRelevantTree,
  headShort,
  modelRoute,
  judge: judgeIdentityRecord ?? { note: 'judge 阶段未运行（--phase run / --phase scan）⇒ 本 manifest 无量具配置读数' },
  plannedTurns: plannedTurns.length,
  evidence: {
    turnsPartial: 'turns.partial.jsonl',
    checkpointsPartial: 'checkpoints.partial.jsonl',
    scanSelfProof: 'scan-selfproof.json',
    scanSummary: 'scan-summary.json',
    judgePartial: 'judge.partial.jsonl',
    reading: 'reading.json',
    runPhase: 'run-phase.json',
  },
  localOnly: ['turns.jsonl（双方原话逐字）', 'checkpoints.jsonl（记忆列表正文）', 'scan-candidates.jsonl（候选句原文）', 'judge-inputs.jsonl（判定器输入逐字）'],
  freeze: 'docs/m6.1/M6.1-WP6-Freeze-Sheet.md',
})

console.log('')
console.log('='.repeat(78))
console.log(`读数落盘：${join(runDir, 'reading.json')}`)
console.log(`清单落盘：${manifest}`)
console.log('='.repeat(78))
for (const gate of gates) {
  console.log(`  ${gate.pass ? '✅' : '❌'} ${gate.gate.padEnd(14)} ${gate.detail}`)
}
console.log(`  真实库摘要：${realDbUnchanged ? '前后逐字相同（只摘要，从未打开）' : '前后不同 ⇒ 无法归属（如实报）'}`)
if (diagnostic) console.log('  ⚠️ 诊断档：分母被截，以上门读数不作判定用途')
console.log('')
console.log(`  人审材料：local/${runId}/（窗口抽样与人审包另由 wp6-review-pack 生成）`)
process.exit(gates.every((gate) => gate.pass) || diagnostic ? 0 : 1)
