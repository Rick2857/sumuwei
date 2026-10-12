/**
 * M7 WP6-B —— **长轨迹运行器**（`pnpm with-test-model pnpm m7:live --suite long`）。
 *
 * ============================================================================
 *  冻结依据（freeze sheet §1/§3/§4/§5 + §8 勘误）
 * ============================================================================
 * ```text
 * ① 1×500 轮 · relationship ON 单臂（CHARACTER_RELATIONSHIP_CONTEXT_ENABLED=true
 *    显式注入；代码缺省仍 off）· 生产装配本尊 · spawn-per-turn；
 * ② 检查点 1/50/100/200/300/400/500：程序读数（零模型）+ 算式核验（§8.1 表）；
 * ③ 预检开跑闸：3 探针文本 × 3 次 execution = 9 次真模型调用（judgePreflight）；
 * ④ 机器门 G-M7-L1..L4（§5 + §8.2 修正后的水位判据）；L5 = 人审材料，未审不填。
 * ```
 *
 * ============================================================================
 *  入口机制（§8.3：与 M6.1 的关键差异）
 * ============================================================================
 * 一次性入口（`src/main.ts "<text>"`）的归因是 SERVICE/agent-runner ⇒
 * UNCONFIRMED_ORIGIN ⇒ 关系评估器永不触发。因此本运行器走**交互控制台**：
 * `spawn(tsx src/main.ts)`（无位置参数）+ stdin 管道喂 `<text>\n/exit\n`，
 * stdout 收 `苏沐薇:` 回复。interactive_human_console ⇒ ESTABLISHED(KNOWN USER)。
 * spawn-per-turn 语义不变：每轮独立进程、独立开机追赶（500 次恢复演练）。
 *
 * ⚠️ 不主张（写进读数 notProven）：
 * · 日基规则（R-1 / >24h 侵蚀）——真实时钟单日不可触发（§2）；
 * · "她不复读/不挟持"——那是 TD-06 判定轮的事，本运行器只出关系读数与人审材料；
 * · 人审四查的结论——材料落盘，判定权在人（G-M7-L5 未审不填）。
 *
 * 用法：
 * ```bash
 * pnpm with-test-model pnpm m7:live --suite long                # 全流程（预检→run→verify）
 * pnpm with-test-model pnpm m7:live --suite long --phase run    # 只跑轮次（可 --resume）
 * pnpm with-test-model pnpm m7:live --suite long --phase verify --resume <runId>
 * ```
 */
import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import {
  DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_RATE_LIMIT_RETRIES,
  classifyTurnFailure,
  decideRateLimitRetry,
  decideTurnAbort,
  failureHintSummary,
  modelRouteFromEnv,
  type TurnFailureHint,
} from './m6.1-run-guards.ts'
import {
  judgePreflight,
  type PreflightProbe,
} from './m6.1-preflight-lib.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'
import {
  M7_CHECKPOINTS,
  M7_EXPECTED_CHECKPOINTS,
  M7_TRAJECTORY_ID,
  M7_TRAJECTORY_TURNS,
  buildM7Trajectory,
  checkM7TrajectoryInvariants,
} from './m7-long-trajectory.ts'

const ROOT = resolve(process.cwd())
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const M7_LOCAL_PARENT = join(ROOT, 'artifacts', 'm7', 'local')
const TURN_TIMEOUT_MS = 10 * 60_000
const PREFLIGHT_TEXTS: readonly string[] = [
  '预检探针一：今天天气怎么样？',
  '预检探针二：随便说点什么听听。',
  '预检探针三：你好呀。',
]

/* ---------------------------------------------------------------------------
 * 参数与守卫（失败关闭）
 * ------------------------------------------------------------------------- */

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const phase = (argValue('--phase') ?? 'all') as 'run' | 'verify' | 'all'
const resumeRunId = argValue('--resume')
const limitRaw = argValue('--limit')
const limit = limitRaw === undefined ? undefined : Number(limitRaw)
const diagnostic = limit !== undefined
const turnIntervalMs = Number(argValue('--turn-interval-ms') ?? '1000')
const maxConsecutiveFailures =
  argValue('--max-consecutive-failures') === undefined
    ? DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES
    : Number(argValue('--max-consecutive-failures'))
const rateLimitCooldownMs = Number(argValue('--rate-limit-cooldown-ms') ?? String(DEFAULT_RATE_LIMIT_COOLDOWN_MS))
const rateLimitRetries = Number(argValue('--rate-limit-retries') ?? String(DEFAULT_RATE_LIMIT_RETRIES))

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `[m7:live] wrapper_required：必须经测试包装器运行（pnpm with-test-model pnpm m7:live --suite long）` +
      `—— 缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝，绝不回落 .env 原 key`
  )
  process.exit(2)
}
if (argValue('--suite') !== 'long') {
  console.error('[m7:live] suite_required：必须显式 --suite long（M7 只有一条冻结轨迹）')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 剧本 + 不变量（开跑前失败关闭）
 * ------------------------------------------------------------------------- */

const trajectory = buildM7Trajectory()
const invariantReport = checkM7TrajectoryInvariants(trajectory.turns)
if (!invariantReport.ok) {
  console.error('[m7:live] 剧本不变量破损 ⇒ 拒绝开跑（不是空跑 PASS）：')
  for (const problem of invariantReport.problems) console.error(`  - ${problem}`)
  process.exit(2)
}
const plannedTurns = trajectory.turns.slice(0, limit ?? trajectory.turns.length)
if (plannedTurns.length === 0) {
  console.error('[m7:live] --limit 之后 0 轮 ⇒ 什么都不会量到（MEASUREMENT INVALID 形态）')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 运行身份
 * ------------------------------------------------------------------------- */

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const runId = resumeRunId ?? createM7RunId({ wpId: 'wp6b-long', headShort })
const modelRoute = modelRouteFromEnv(process.env as Record<string, string | undefined>, '测试端点包装器（pnpm with-test-model）')

/** 运行相关树指纹（src/** + 本运行器消费的 scripts/m7-* 模块） */
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
    if (entry.isFile() && (entry.name.startsWith('m7-') || entry.name.startsWith('m6.1-'))) {
      files.push(join(ROOT, 'scripts', entry.name))
    }
  }
  const folded = files
    .map((abs) => relative(ROOT, abs).split(/[\\/]/).join('/'))
    .sort()
    .map((rel) => `${rel}\u0000${sha256OfFile(join(ROOT, rel))}`)
    .join('\u0001')
  return sha256OfText(folded)
}
function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex')
}
function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
const runRelevantTree = runRelevantTreeSha256()

const runDir = resumeRunId === undefined ? openM7RunDir(ROOT, runId) : join(ROOT, 'artifacts', 'm7', runId)
if (resumeRunId !== undefined) {
  if (!existsSync(runDir)) throw new Error(`--resume ${runId}：目录不存在（${runDir}）`)
  const prior = [join(runDir, 'manifest.json'), join(runDir, 'verify.json')].find((path) => existsSync(path))
  if (prior !== undefined) {
    const priorTree = /"runRelevantTreeSha256"\s*:\s*"([0-9a-f]+)"/.exec(readFileSync(prior, 'utf8'))?.[1]
    if (priorTree !== undefined && priorTree !== runRelevantTree) {
      throw new Error(
        `--resume ${runId}：运行相关树指纹不一致（旧 ${priorTree.slice(0, 12)}… ≠ 本次 ${runRelevantTree.slice(0, 12)}…）` +
          '⇒ 运行相关代码变了，旧读数不能续（请开新 runId）'
      )
    }
  }
}
const localDir = join(M7_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })
/* 人审材料不进仓库：写正文前先证明本目录确实被忽略（m6.1 先例） */
const ignoreCheck = spawnSync('git', ['check-ignore', localDir], { cwd: ROOT, encoding: 'utf8' })
if (ignoreCheck.status !== 0) {
  console.error(`[m7:live] local_not_ignored：${localDir} 未被 git 忽略 ⇒ 拒绝写对话正文进盘`)
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 沙箱：一条轨迹一个持久隔离库
 * ------------------------------------------------------------------------- */

const sandboxFile = join(runDir, 'sandbox.json')
let dbDir: string
if (resumeRunId !== undefined && existsSync(sandboxFile)) {
  dbDir = String(JSON.parse(readFileSync(sandboxFile, 'utf8'))?.dir ?? '')
  if (dbDir === '' || !existsSync(dbDir)) {
    throw new Error(`--resume ${runId}：沙箱目录不存在（${dbDir}）—— 轨迹库丢失 ⇒ 本 runId 无法续（如实失败）`)
  }
} else {
  const work = mkdtempSync(join(tmpdir(), 'project-lg-m7-long-'))
  dbDir = join(work, 'pglite')
  mkdirSync(dbDir, { recursive: true })
  writeFileSync(sandboxFile, `${JSON.stringify({ schemaVersion: 'm7-long-sandbox@1', dir: dbDir, trajectory: M7_TRAJECTORY_ID }, null, 2)}\n`, 'utf8')
}
if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) {
  throw new Error('拒绝：沙箱路径被判成生产库')
}

const realDbBefore = digestTree(PRODUCTION_DB_DIR)

/* ---------------------------------------------------------------------------
 * spawn：交互控制台路径（§8.3）
 * ------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function turnEnv(targetDbDir: string = dbDir): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PGLITE_DATA_DIR: targetDbDir,
    PROJECT_LG_SANDBOX: targetDbDir,
    CHARACTER_RELATIONSHIP_CONTEXT_ENABLED: 'true',
    USER_NAME: 'Alex',
  }
}

/** 交互控制台一轮：spawn（无位置参数）→ 喂正文 → **等回复标记** → 喂 /exit → 收退出码。
 *
 * ⚠️ 实测坑（诊断档 t1 换来的）：不能把 `<text>\n/exit\n` 一次写完——readline 在
 * 第一次 question() 挂起期间就把两行都解析了，`/exit` 的 line 事件无人接 ⇒ 丢失；
 * stdin EOF 后第二次 question() 以 "readline was closed" 拒绝 ⇒ exit 1。
 * 正确时序：正文先行，stdout 里出现 `苏沐薇:` 标记（回复已打印）之后再写 `/exit`。 */
function spawnConsoleTurnAsync(input: {
  readonly text: string
  /** 预检用一次性沙箱；缺省 = 轨迹库（正式轮） */
  readonly env?: Record<string, string>
}): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts'], {
      cwd: ROOT,
      env: input.env ?? turnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
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
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(-1, `\n${String(error)}`))
    child.on('close', (status) => finish(status ?? -1))
    /* 硬超时：卡死的轮杀掉（模型客户端自己的超时之外的第二道闸） */
    const hardTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(-1, '\n(hard timeout 10min ⇒ killed)')
    }, TURN_TIMEOUT_MS)
    /* 正文先行；回复标记出现后再写 /exit（时序见函数头注释） */
    child.stdin?.write(`${input.text}\n`)
    const pollTimer = setInterval(() => {
      if (!exitSent && stdout.includes('苏沐薇:')) {
        exitSent = true
        child.stdin?.write('/exit\n')
      }
    }, 200)
  })
}

/** 检查点读数（spawn 读数器子进程；零模型） */
function readCheckpoint(fromEnd: number): { ok: boolean; reading?: unknown; reason?: string } {
  const out = join(runDir, `checkpoint-reading-${String(fromEnd)}.json`)
  const result = spawnSync(
    process.execPath,
    [TSX_CLI, 'scripts/m7-trajectory-read.ts', '--db-dir', dbDir, '--out', out, '--from-end', String(fromEnd), '--user-name', 'Alex'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 }
  )
  if (result.status !== 0 || !existsSync(out)) {
    return { ok: false, reason: `读数器退出码 ${String(result.status)}：${String(result.stderr).slice(-300)}` }
  }
  return { ok: true, reading: JSON.parse(readFileSync(out, 'utf8')) as unknown }
}

/* ---------------------------------------------------------------------------
 * 记录形状与 partial 文件（--resume 的原料）
 * ------------------------------------------------------------------------- */

interface M7TurnRecord {
  readonly turnIndex: number
  readonly kind: string
  readonly userTextSha256: string
  readonly replySha256: string
  readonly replyChars: number
  readonly status: number
  readonly durationMs: number
  readonly replyMarkerFound: boolean
  readonly checkpoint?: true
  readonly attempts?: number
  readonly rateLimitWaitsMs?: number
  readonly failureHint?: string
}

const partialPath = join(runDir, 'turns.partial.jsonl')
const localTurnsPath = join(localDir, 'turns.jsonl')
const checkpointPartialPath = join(runDir, 'checkpoints.partial.jsonl')
const checkpointLocalPath = join(localDir, 'checkpoints.jsonl')

const doneTurns = new Set<number>()
if (existsSync(partialPath)) {
  for (const line of readFileSync(partialPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as M7TurnRecord
    if (row.status === 0) doneTurns.add(row.turnIndex)
  }
}

console.log('='.repeat(78))
console.log(`M7 WP6-B 长轨迹运行器（${M7_TRAJECTORY_ID} · 1×${String(M7_TRAJECTORY_TURNS)} · relationship ON 单臂）`)
console.log('='.repeat(78))
console.log(`  runId      ${runId}`)
console.log(`  剧本       ${String(plannedTurns.length)} 轮${diagnostic ? '（**诊断档**：分母被截，不作判定）' : '（正式）'} · 指纹 ${invariantReport.fingerprint.slice(0, 16)}…`)
console.log(`  不变量     ${invariantReport.ok ? 'OK' : '破损'} · 检查点 ${invariantReport.checkpoints.join('/')}`)
console.log(`  期望终态   trust 0.97 · closeness 0.81 · revision 13（freeze sheet §8.1 勘误后）`)
console.log(`  合成库     ${dbDir}（整条轨迹共用）`)
console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（只摘要，不打开）`)
console.log(`  入口       交互控制台（stdin 管道；ESTABLISHED 归因——§8.3）`)
console.log('')

/* ---------------------------------------------------------------------------
 * 预检开跑闸（3 文本 × 3 次 = 9 次真模型；UNHEALTHY ⇒ 拒绝开跑）
 * ------------------------------------------------------------------------- */

async function runPreflight(): Promise<void> {
  /* ⚠️ 预检探针是**真对话轮**——会写账本（含每轮的 TEST_CHARACTER_SIGNAL 域事件）。
   * 绝不能落进轨迹库：第一次全量跑（runId …-9b10）就是被这 9 轮污染的（cp1 账本
   * 20 事件/10 trace ⇒ L2 账本断言全错位）。预检用独立一次性沙箱，用完即弃。 */
  const preflightWork = mkdtempSync(join(tmpdir(), 'project-lg-m7-preflight-'))
  const preflightDbDir = join(preflightWork, 'pglite')
  mkdirSync(preflightDbDir, { recursive: true })
  if (isProductionDir(preflightDbDir) || resolve(preflightDbDir) === resolve(PRODUCTION_DB_DIR)) {
    throw new Error('拒绝：预检沙箱路径被判成生产库')
  }
  const preflightEnv = turnEnv(preflightDbDir)
  console.log(`  预检（3 文本 × 3 次 execution = 9 次真模型调用 · 独立沙箱 ${preflightDbDir}）…`)
  const probes: PreflightProbe[] = []
  let index = 0
  for (const text of PREFLIGHT_TEXTS) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      index += 1
      const said = await spawnConsoleTurnAsync({ text: `${text}（第${String(repetition)}次）`, env: preflightEnv })
      const reply = extractReply(said.stdout)
      probes.push({
        index,
        status: said.status,
        replyChars: reply.length,
        replyMarkerFound: said.stdout.includes('苏沐薇:'),
        durationMs: said.durationMs,
        ...(said.status !== 0 ? { failureHint: classifyTurnFailure(said.status, said.stderr) } : {}),
      })
      console.log(`    探针 ${String(index)}/9：exit=${String(said.status)} · ${String(said.durationMs)}ms · 回复 ${String(reply.length)} 字`)
    }
  }
  const judgment = judgePreflight(probes)
  writeFileSync(
    join(runDir, 'preflight.json'),
    `${JSON.stringify({ schemaVersion: 'm7-long-preflight@1', at: new Date().toISOString(), modelRoute, probes, judgment }, null, 2)}\n`,
    'utf8'
  )
  console.log(`  预检判定：${judgment.verdict}${judgment.reasons.length > 0 ? ` —— ${judgment.reasons.join('；')}` : ''}`)
  if (judgment.verdict !== 'HEALTHY') {
    console.error('失败关闭（开跑闸）：端点预检不健康 ⇒ 不开跑（读数已落 preflight.json）')
    process.exit(2)
  }
}

/* ---------------------------------------------------------------------------
 * phase run —— 逐轮真模型；检查点轮额外落程序读数
 * ------------------------------------------------------------------------- */

if (phase === 'run' || phase === 'all') {
  if (!diagnostic) await runPreflight()

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
    let said = await spawnConsoleTurnAsync({ text: turn.userText })
    let attempts = 1
    let rateLimitWaitsMs = 0
    for (;;) {
      const hint = classifyTurnFailure(said.status, said.stderr)
      const decision = decideRateLimitRetry({ attempt: attempts, maxRetries: rateLimitRetries, cooldownMs: rateLimitCooldownMs, hint })
      if (!decision.retry) break
      console.log(`  t${String(turn.index).padStart(3)} ${decision.reason}`)
      await sleep(decision.waitMs)
      rateLimitWaitsMs += decision.waitMs
      said = await spawnConsoleTurnAsync({ text: turn.userText })
      attempts += 1
    }
    const reply = extractReply(said.stdout)
    turnStatuses.push(said.status)
    turnFailureHints.push(classifyTurnFailure(said.status, said.stderr))
    if (said.status === 0) completed += 1
    else failed += 1
    if (attempts > 1) rateLimitRetriedTurns.push({ turnIndex: turn.index, attempts, waitMs: rateLimitWaitsMs })
    const record: M7TurnRecord = {
      turnIndex: turn.index,
      kind: turn.kind,
      userTextSha256: sha256OfText(turn.userText),
      replySha256: sha256OfText(reply),
      replyChars: reply.length,
      status: said.status,
      durationMs: said.durationMs,
      replyMarkerFound: said.stdout.includes('苏沐薇:'),
      ...(turn.checkpoint === true ? { checkpoint: true as const } : {}),
      ...(attempts > 1 ? { attempts, rateLimitWaitsMs } : {}),
      ...(said.status === 0 ? {} : { failureHint: classifyTurnFailure(said.status, said.stderr) }),
    }
    appendFileSync(partialPath, `${JSON.stringify(record)}\n`, 'utf8')
    appendFileSync(
      localTurnsPath,
      `${JSON.stringify({ ...record, at: new Date().toISOString(), userText: turn.userText, reply, expectedRules: turn.expectedRules, ...(said.status === 0 ? {} : { stderrTail: said.stderr.slice(-600) }) })}\n`,
      'utf8'
    )
    if (Date.now() - lastProgressLog > 60_000 || turn.checkpoint === true || said.status !== 0 || turn.expectedRules.length > 0) {
      console.log(
        `  t${String(turn.index).padStart(3)}/${String(plannedTurns.length)} ${turn.kind.padEnd(22)} exit=${String(said.status)}` +
          ` ${String(said.durationMs)}ms 回复 ${String(reply.length)} 字 · 累计完成 ${String(completed)} 失败 ${String(failed)}`
      )
      lastProgressLog = Date.now()
    }

    /* ---- 检查点轮：程序读数（零模型；spawn 读数器子进程） ---- */
    if (turn.checkpoint === true && said.status === 0) {
      const fromEnd = plannedTurns.length - turn.index
      const reading = readCheckpoint(fromEnd)
      const checkpointRecord = {
        checkpoint: turn.index,
        completedTurns: completed,
        failedTurns: failed,
        readingOk: reading.ok,
        ...(reading.ok ? { reading: reading.reading } : { readingReason: reading.reason }),
      }
      appendFileSync(checkpointPartialPath, `${JSON.stringify(checkpointRecord)}\n`, 'utf8')
      appendFileSync(checkpointLocalPath, `${JSON.stringify({ ...checkpointRecord, at: new Date().toISOString(), userText: turn.userText, reply })}\n`, 'utf8')
      if (reading.ok) {
        const r = reading.reading as { projection?: { trust: number | null; closeness: number | null; revision: number | null } | null; watermark?: number | null; ledger?: { latestSequence?: number | null } }
        console.log(
          `      检查点 t${String(turn.index)}：投影 t=${String(r.projection?.trust)} c=${String(r.projection?.closeness)} r${String(r.projection?.revision)} · 水位 ${String(r.watermark)} · 账本max ${String(r.ledger?.latestSequence)}`
        )
      } else {
        console.log(`      检查点 t${String(turn.index)}：读数失败（${String(reading.reason).slice(0, 120)}）`)
      }
    }

    /* ---- 运行中的中止闸（死窗口不烧 500 轮） ---- */
    const decision = decideTurnAbort({ statuses: turnStatuses, maxConsecutiveFailures })
    if (decision.abort) {
      writeFileSync(
        join(runDir, 'aborted.json'),
        `${JSON.stringify(
          {
            schemaVersion: 'm7-long-run-aborted@1',
            at: new Date().toISOString(),
            reason: 'consecutive_turn_failures',
            detail: decision.reason,
            streak: decision.streak,
            threshold: maxConsecutiveFailures,
            turnsAttempted: turnStatuses.length,
            turnsFailed: turnStatuses.filter((status) => status !== 0).length,
            failureHints: failureHintSummary(turnFailureHints),
            rateLimitRetriedTurns: rateLimitRetriedTurns.length,
            asked: '端点窗口正在崩塌。本轮读数不可用作判定；等窗口恢复后 --phase run --resume 接着跑。',
          },
          null,
          2
        )}\n`,
        'utf8'
      )
      console.error(`\n  ⚠️ **中止**：${decision.reason}`)
      process.exit(3)
    }
  }

  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const realDbUnchanged = realDbAfter.treeSha256 === realDbBefore.treeSha256 && realDbAfter.measuredCount === realDbBefore.measuredCount
  writeFileSync(
    join(runDir, 'run-phase.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'm7-long-run-phase@1',
        at: new Date().toISOString(),
        trajectory: M7_TRAJECTORY_ID,
        plannedTurns: plannedTurns.length,
        completed,
        failed,
        rateLimitRetriedTurns: rateLimitRetriedTurns.length,
        realDbUnchanged,
        ...(realDbUnchanged ? {} : { realDbNote: '真实库摘要前后不同 ⇒ 无法归属，不宣称"从未改变"也不宣称"被污染"' }),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log('')
  console.log(`  run 阶段完成：${String(completed)} 完成 · ${String(failed)} 失败 · 真实库${realDbUnchanged ? '未变' : '摘要不同（如实报）'}`)
  if (phase === 'run') {
    console.log(`  ⇒ 下一步：--phase verify --resume ${runId}`)
    process.exit(0)
  }
}

/* ---------------------------------------------------------------------------
 * phase verify —— G-M7-L1..L4（零模型）+ 人审材料落盘
 * ------------------------------------------------------------------------- */

if (phase === 'verify' || phase === 'all') {
  const turnRecords: M7TurnRecord[] = (existsSync(partialPath) ? readFileSync(partialPath, 'utf8') : '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as M7TurnRecord)
  const checkpointRecords: { checkpoint: number; readingOk: boolean; reading?: unknown; readingReason?: string }[] = (
    existsSync(checkpointPartialPath) ? readFileSync(checkpointPartialPath, 'utf8') : ''
  )
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { checkpoint: number; readingOk: boolean; reading?: unknown; readingReason?: string })

  const checks: { id: string; label: string; expected: string; actual: string; pass: boolean }[] = []
  const record = (id: string, label: string, expected: string, actual: string, pass: boolean): void => {
    checks.push({ id, label, expected, actual, pass })
  }
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

  /* G-M7-L1 完成轮次 */
  const completedTotal = turnRecords.filter((t) => t.status === 0).length
  const failedTotal = turnRecords.length - completedTotal
  const failRate = turnRecords.length > 0 ? failedTotal / turnRecords.length : 1
  const l1ok = !diagnostic && completedTotal >= M7_TRAJECTORY_TURNS && failRate <= 0.05
  record(
    'G-M7-L1',
    `完成轮次 ≥${String(M7_TRAJECTORY_TURNS)} 且技术失败率 ≤5%`,
    `≥${String(M7_TRAJECTORY_TURNS)} 完成 · ≤5%`,
    `${String(completedTotal)} 完成 · ${String(failedTotal)} 失败（${(failRate * 100).toFixed(1)}%）${diagnostic ? '（诊断档分母被截）' : ''}`,
    l1ok,
  )

  /* G-M7-L2 序号与水位（§8.2 修正判据） */
  const l2Problems: string[] = []
  const checkpointReadings = new Map<number, { reading?: unknown; readingOk: boolean }>()
  for (const cp of checkpointRecords) checkpointReadings.set(cp.checkpoint, { reading: cp.reading, readingOk: cp.readingOk })
  for (const expected of M7_EXPECTED_CHECKPOINTS) {
    const cpRecord = checkpointReadings.get(expected.checkpoint)
    if (cpRecord === undefined) {
      l2Problems.push(`cp${String(expected.checkpoint)}：无检查点读数`)
      continue
    }
    if (!cpRecord.readingOk) {
      l2Problems.push(`cp${String(expected.checkpoint)}：读数失败`)
      continue
    }
    const r = cpRecord.reading as {
      watermark: number | null
      ledger: { conversationEvents: number | null; latestSequence: number | null }
      domainEvents: { total: number | null; latestSequence: number | null } | null
    }
    /* ① 不变式：水位 ≤ 账本最大序号 */
    if (r.watermark === null || r.ledger.latestSequence === null) {
      l2Problems.push(`cp${String(expected.checkpoint)}：水位或账本读数为 null`)
      continue
    }
    if (r.watermark > r.ledger.latestSequence) {
      l2Problems.push(`cp${String(expected.checkpoint)}：水位 ${String(r.watermark)} > 账本max ${String(r.ledger.latestSequence)}（超前）`)
    }
    /* ②/③ 消费点相等 / 持有点分列 + 账本形状（计数 == 2×N；最大序号 == 期望值
       ——后者是"无意外域事件"的机器闸，freeze sheet §8.4） */
    if (expected.watermarkExpectation === 'flushed') {
      if (r.watermark !== r.ledger.latestSequence) {
        l2Problems.push(`cp${String(expected.checkpoint)}：应消费（水位 ${String(r.watermark)} ≠ 账本max ${String(r.ledger.latestSequence)}）`)
      }
    } else if (r.watermark !== expected.watermarkHeldAt) {
      l2Problems.push(`cp${String(expected.checkpoint)}：应持有于 ${String(expected.watermarkHeldAt)}（实际 ${String(r.watermark)}）`)
    }
    const expectedEvents = 2 * expected.checkpoint
    if (r.ledger.conversationEvents !== expectedEvents) {
      l2Problems.push(`cp${String(expected.checkpoint)}：账本总数 ${String(r.ledger.conversationEvents)} ≠ 2×${String(expected.checkpoint)}`)
    }
    if (r.ledger.latestSequence !== expected.ledgerMax) {
      l2Problems.push(
        `cp${String(expected.checkpoint)}：账本max ${String(r.ledger.latestSequence)} ≠ 期望 ${String(expected.ledgerMax)}` +
          '（计划外序号消费 ⇒ 意外域事件？）'
      )
    }
    /* ④ 域事件形状（§8.5）：总数 = ORIGIN + N×signal + flush；最大序号 = 末轮 signal/flush。
       这是"无意外域事件"的第二道机器闸（第一道是账本 max）。 */
    if (r.domainEvents === null || r.domainEvents.total === null || r.domainEvents.latestSequence === null) {
      l2Problems.push(`cp${String(expected.checkpoint)}：域事件读数缺失（旧读数器？）`)
    } else {
      if (r.domainEvents.total !== expected.domainEventsTotal) {
        l2Problems.push(
          `cp${String(expected.checkpoint)}：域事件总数 ${String(r.domainEvents.total)} ≠ 期望 ${String(expected.domainEventsTotal)}（ORIGIN+signal+flush）`
        )
      }
      if (r.domainEvents.latestSequence !== expected.domainEventsMax) {
        l2Problems.push(
          `cp${String(expected.checkpoint)}：域事件max ${String(r.domainEvents.latestSequence)} ≠ 期望 ${String(expected.domainEventsMax)}`
        )
      }
    }
  }
  record(
    'G-M7-L2',
    '序号与水位：水位≤账本max 恒成立 · 消费点水位=账本max · 持有点水位=上次消费位 · 账本=2×轮次 · 域事件=ORIGIN+N×signal+flush（§8.5）',
    '0 异常',
    l2Problems.length === 0 ? '0 异常' : `${String(l2Problems.length)} 异常：${l2Problems.slice(0, 3).join('；')}`,
    l2Problems.length === 0,
  )

  /* G-M7-L3 关系算式（§8.1 表，±1e-9） */
  const l3Problems: string[] = []
  for (const expected of M7_EXPECTED_CHECKPOINTS) {
    const cpRecord = checkpointReadings.get(expected.checkpoint)
    if (cpRecord === undefined || !cpRecord.readingOk) {
      l3Problems.push(`cp${String(expected.checkpoint)}：无有效读数`)
      continue
    }
    const r = cpRecord.reading as { projection: { trust: number | null; closeness: number | null; revision: number | null; accusationsInCase: number } | null }
    if (r.projection === null) {
      l3Problems.push(`cp${String(expected.checkpoint)}：未建档`)
      continue
    }
    if (r.projection.trust === null || !near(r.projection.trust, expected.trust)) {
      l3Problems.push(`cp${String(expected.checkpoint)}：trust ${String(r.projection.trust)} ≠ ${String(expected.trust)}`)
    }
    if (r.projection.closeness === null || !near(r.projection.closeness, expected.closeness)) {
      l3Problems.push(`cp${String(expected.checkpoint)}：closeness ${String(r.projection.closeness)} ≠ ${String(expected.closeness)}`)
    }
    if (r.projection.revision === null || r.projection.revision !== expected.revision) {
      l3Problems.push(`cp${String(expected.checkpoint)}：revision ${String(r.projection.revision)} ≠ ${String(expected.revision)}`)
    }
    if (r.projection.accusationsInCase !== expected.accusationsInCase) {
      l3Problems.push(`cp${String(expected.checkpoint)}：在案 ${String(r.projection.accusationsInCase)} ≠ ${String(expected.accusationsInCase)}`)
    }
  }
  record(
    'G-M7-L3',
    '关系算式：7 检查点投影值 == §8.1 期望表（±1e-9）',
    '0 偏差',
    l3Problems.length === 0 ? '0 偏差' : `${String(l3Problems.length)} 偏差：${l3Problems.slice(0, 3).join('；')}`,
    l3Problems.length === 0,
  )

  /* G-M7-L4 注入块在场（终读数：trace 总数 == 完成轮次 · 全部含 relationship） */
  const finalReading = readCheckpoint(0) /* fromEnd 0 = 末条 */
  const l4ok = (() => {
    if (!finalReading.ok) return false
    const r = finalReading.reading as { traces: { total: number; withRelationshipSection: number } | null }
    if (r.traces === null) return false
    return r.traces.total === completedTotal && r.traces.withRelationshipSection === r.traces.total
  })()
  record(
    'G-M7-L4',
    '注入块在场：flag ON 每轮 trace sections 含 relationship（终读数全量计数）',
    `trace ${String(completedTotal)}/${String(completedTotal)} 含 relationship`,
    finalReading.ok
      ? `${String((finalReading.reading as { traces: { withRelationshipSection: number } }).traces.withRelationshipSection)}/${String((finalReading.reading as { traces: { total: number } }).traces.total)}`
      : `终读数失败：${String(finalReading.reason).slice(0, 100)}`,
    l4ok,
  )

  /* G-M7-L5：人审材料落盘（未审不填 PASS） */
  const reviewPackPath = writeReviewPack(turnRecords)
  record(
    'G-M7-L5',
    '人审四查材料（检查点 + 事件位 + 抽样）已落盘；判定权在人（未审不填）',
    '材料落盘',
    reviewPackPath === undefined ? '材料缺失' : `${reviewPackPath}（人审前不填 PASS）`,
    reviewPackPath !== undefined,
  )

  const passed = checks.filter((c) => c.pass).length
  const failedCount = checks.length - passed
  const verdict = diagnostic ? 'PARTIAL（诊断档，不作判定）' : failedCount === 0 ? 'PASS' : 'FAIL'
  const realDbAfterVerify = digestTree(PRODUCTION_DB_DIR)
  const realDbUnchanged =
    realDbAfterVerify.treeSha256 === realDbBefore.treeSha256 && realDbAfterVerify.measuredCount === realDbBefore.measuredCount

  const payload = {
    schema: 'm7-long-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    trajectory: M7_TRAJECTORY_ID,
    trajectoryFingerprint: invariantReport.fingerprint,
    runRelevantTreeSha256: runRelevantTree,
    modelRoute,
    expectedFinal: { trust: 0.97, closeness: 0.81, revision: 13, source: 'freeze sheet §8.1（勘误后）' },
    turns: { planned: plannedTurns.length, completed: completedTotal, failed: failedTotal },
    checkpoints: checkpointRecords,
    checks,
    notProven: [
      '日基规则（R-1 / >24h 侵蚀）——真实时钟单日不可触发（freeze sheet §2）',
      '她不复读/不挟持——TD-06 判定轮的事，本读数不含',
      '人审四查结论——材料已落盘，判定权在人（G-M7-L5 未审不填）',
    ],
    realDbUnchanged,
    verdict,
    counts: { total: checks.length, passed, failed: failedCount },
  }
  writeFileSync(join(runDir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(join(runDir), {
    runId,
    wp: 'wp6b-long',
    head,
    headShort,
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'live-long-trajectory',
    counts: { total: checks.length, passed, failed: failedCount },
    phases: ['run', 'verify'],
    supersedes: null,
    notes: `1×500 relationship ON；交互控制台入口（ESTABLISHED）；期望终态 0.97/0.81/13（§8.1 勘误后）；剧本指纹 ${invariantReport.fingerprint.slice(0, 16)}`,
  })

  console.log('')
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} → ${c.actual}`)
  }
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）· 真实库${realDbUnchanged ? '未变' : '摘要不同（如实报）'}`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

/* ---------------------------------------------------------------------------
 * 人审材料包（local/；Git 只进摘要——正文不进仓库）
 * ------------------------------------------------------------------------- */

function writeReviewPack(turnRecords: readonly M7TurnRecord[]): string | undefined {
  const localTurnsPathForPack = join(localDir, 'turns.jsonl')
  if (!existsSync(localTurnsPathForPack)) return undefined
  const verbatim = readFileSync(localTurnsPathForPack, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { turnIndex: number; kind: string; userText: string; reply: string; status: number })
  const byIndex = new Map(verbatim.map((row) => [row.turnIndex, row]))
  const interesting = new Set<number>([...M7_CHECKPOINTS, 30, 80, 120, 150, 250, 280, 450])
  /* 确定性抽样：每 25 轮抽 1（固定步长，不随机） */
  for (let i = 25; i <= M7_TRAJECTORY_TURNS; i += 25) interesting.add(i)
  const lines: string[] = [
    '# M7 长轨迹人审材料（四查）',
    '',
    `> runId：${runId} · 轨迹 ${M7_TRAJECTORY_ID} · 生成于 ${new Date().toISOString()}`,
    '> 本文件在 artifacts/m7/local/（不进仓库）。四查判据见 freeze sheet §6。',
    '',
  ]
  for (const turn of plannedTurns) {
    if (!interesting.has(turn.index)) continue
    const row = byIndex.get(turn.index)
    if (row === undefined) continue
    lines.push(`## t${String(turn.index)}（${turn.kind}${turn.checkpoint === true ? ' · 检查点' : ''}）`)
    lines.push('')
    lines.push(`**用户**：${row.userText}`)
    lines.push('')
    lines.push(`**苏沐薇**：${row.reply === '' ? '（回复未捕获）' : row.reply}`)
    lines.push('')
    if (turn.checkpoint === true) {
      lines.push('- 四查③：关系措辞与 trust/closeness 两维不混谈？')
      lines.push('- 四查④：在案非空时无全然信任口吻；撤回后无延续受伤口吻？')
    }
    if (turn.kind === 'accusation') lines.push('- 查四：指控在案期间，回复是否避免"我们一直很好"式表述？')
    if (turn.kind === 'retraction') lines.push('- 查四：撤回后，回复是否避免延续受伤口吻？')
    if (turn.kind === 'thanks') lines.push('- 查一：本次 trust/closeness 变动可指到放行的域事件？')
    lines.push('')
  }
  const packPath = join(localDir, 'review-pack.md')
  writeFileSync(packPath, lines.join('\n'), 'utf8')
  /* 摘要（进仓库的是这份） */
  const summary = {
    schemaVersion: 'm7-review-pack-summary@1',
    runId,
    packPath: relative(ROOT, packPath),
    verbatimTurns: verbatim.length,
    reviewTurns: [...interesting].sort((a, b) => a - b),
    fourChecks: ['关系变化符合事件事实', '不把助手自述当共同经历', 'trust/closeness 不混谈', '失败后不用成功口吻'],
    status: 'AWAITING HUMAN REVIEW',
  }
  writeFileSync(join(runDir, 'review-pack-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return packPath
}
