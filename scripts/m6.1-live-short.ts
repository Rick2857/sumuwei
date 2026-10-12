/**
 * M6.1 **WP5 真实模型短场景运行器**（`pnpm with-test-model pnpm m6.1:live --suite short`）。
 *
 * ============================================================================
 *  它做什么（计划书 §4 WP5 的第 2–4 条）
 * ============================================================================
 * ```text
 *  ① 用**真实测试模型**跑冻结的短场景集，走**生产装配本尊**（`src/main.ts` 本尊、
 *     空合成隔离库、`PROJECT_LG_SANDBOX`），逐轮记：双方原话（verbatim，只进 gitignored 的
 *     `artifacts/m6.1/local/<runId>/`）、实际上下文的**结构性**读数、程序事实（记忆列表 / 账本）
 *  ② **两轮分别判定**：`--round 1|2` 各自出一份读数，**不合并不择优**
 *  ③ 三个数**同时报**：成功 / 技术失败 / 弃判（技术失败与弃判都计入"未成功额度"）
 *  ④ 冻结额度逐条核对（ADR-055 §4.1）：支持性回忆 30 条 ≤3 未成功 / 每类 ≤1；
 *     必修反例 0；写入正控 0；误触发负控 0
 * ```
 *
 * ============================================================================
 *  两阶段（与 `m6.1-wp3-judge.ts` 同一形状）
 * ============================================================================
 * ```text
 *  phase run    逐轮 spawn 生产入口（真模型）。**逐条落盘**（`turns.partial.jsonl`）⇒ 断了能续
 *  phase judge  打开那个合成沙箱**一次**，读 trace 的**结构性**上下文读数 + 记忆列表，
 *               把每一轮的回复组装成 `InstrumentItem`，用**冻结量具**判 2 次采样
 *               （CD-14 的三态：`alert` / `no_alert` / `undecidable`）
 * ```
 *
 * ⚠️ **不主张**什么（写进证据的 `notProven`）：
 * ```text
 * · 「她不再编造」只有在**两轮都跑完、按冻结额度判定**之后才谈得上；本运行器只出读数
 * · `actualContext` 是**结构性重建**（section 名字 / 召回计数 / 选中 id）——
 *   trace 里**刻意没有**逐字提示正文 ⇒ **不得**写成"逐字重放"
 * · 量具的**有效性**来自 WP2 的 VALID 判定；本运行器只**使用**它
 * ```
 *
 * 用法：
 * ```bash
 * pnpm with-test-model pnpm m6.1:live --suite short --round 1
 * pnpm with-test-model pnpm m6.1:live --suite short --round 1 --set supported --limit 3   # 诊断档
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
import type { AlertState } from './m6.1-contract.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { M6_1_LOCAL_PARENT, createRunId, openRunDir, sha256OfText, writeManifestAtomic } from './m6.1-evidence.ts'
import { standardManifestFields } from './m6.1-run-manifest.ts'
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
  classifyTurnFailure,
  decideRateLimitRetry,
  decideTurnAbort,
  failureHintSummary,
  failureKindOf,
  modelRouteFromEnv,
  sameModelRoute,
} from './m6.1-run-guards.ts'
import {
  loadCorrectionNegativeSet,
  loadCounterexamples,
  loadExplicitWriteSet,
  loadSupportedRecallSet,
} from './m6.1-control-sets.ts'
import {
  buildJudgePrompt,
  computeExpectedPointsHitMiss,
  itemsFromCorpus,
  judgmentFromSamples,
  judgmentFromTieBreak,
  M6_1_JUDGE_PROMPT_VERSION,
  M6_1_POINT_MATCH_VERSION,
  type InstrumentItem,
  type ItemJudgment,
} from './m6.1-instrument.ts'
import { judgeActualContextPayload } from './m6.1-turn-context.ts'
import {
  createOpenAiInstrumentJudge,
  M6_1_JUDGE_MAX_ATTEMPTS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  M6_1_JUDGE_TIMEOUT_MS,
} from './m6.1-judge-openai.ts'

const ROOT = resolve(process.cwd())
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/*
 * 清单公共字段用（L-M61-14）：本次进程的开始时刻 + 实际命令行。
 * ⚠️ `standardManifestFields()` 不读 `process.argv`（那一份要保持可穷举），
 *    所以命令行字符串在这里显式取一次。
 */
const STARTED_AT = new Date().toISOString()
const INVOKED_COMMAND = `pnpm with-test-model pnpm m6.1:live ${process.argv.slice(2).join(' ')}`.trim()

/* ---------------------------------------------------------------------------
 * 参数与守卫（**失败关闭**；守卫写错的表现是"以为在跑测试、其实在烧 .env 的原 key"）
 * ------------------------------------------------------------------------- */

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const round = Number(argValue('--round') ?? '')
const armName = (argValue('--arm') ?? 'code-default') as 'code-default' | 'deployed'
const setName = (argValue('--set') ?? 'all') as 'supported' | 'rce' | 'ewp' | 'cin' | 'all'
const limitRaw = argValue('--limit')
const onlyRaw = argValue('--only')
const phase = (argValue('--phase') ?? 'all') as 'run' | 'judge' | 'all' | 'preflight'
/**
 * 续跑（**必须显式给 runId**）：复用既有 run 目录。
 *
 * ⚠️ 为什么需要它（实测换来的）：第一次正式 round 1 的 run 阶段花了 19 分钟跑完
 *    （59 条 × 真模型），而 judge 阶段**没有任何增量落盘** —— 它跑了 80 多分钟
 *    都看不到进度，只能整轮中止。⇒ ① judge 阶段现在逐条落 `judge.partial.jsonl`；
 *    ② run 阶段本来就有 `turns.partial.jsonl`（逐条）；③ 两者都可以用 `--resume` 接着跑。
 */
const resumeRunId = argValue('--resume')
/** judge 阶段的上限（诊断用；缺省 = 全部） */
const judgeLimitRaw = argValue('--judge-limit')
const judgeLimit = judgeLimitRaw === undefined ? undefined : Number(judgeLimitRaw)
/**
 * **每个工况一个空沙箱**（缺省开；`--shared-sandbox` 关掉它）。
 *
 * ============================================================================
 *  为什么这是**必须**的（WP5 实测换来的，而且是判据有效性问题）
 * ============================================================================
 * 第一版让 59 个工况**共用同一个沙箱**（为了省启动时间）。后果是：
 * `required_counterexamples_v1` 的条文写的是 `source.kind = synthetic_first_turn`
 * /「**空账本首轮**」，可当它跑到第 31 个工况时，沙箱里已经有前面 30 个工况写下的记忆 ——
 * **前提被破坏**，那条读数就不再是"空账本上的第一轮"。
 * 实测后果（trace 读数）：RCE 各轮的记录状态行 reason_code 是
 * `ineligible:superseded,no_relevant`，**而不是** D1′ 专门为"召回为空"准备的
 * 默认缺席句 —— 也就是说：**那个最需要被测的场景，一次都没被跑到**。
 */
const perItemIsolation = !process.argv.includes('--shared-sandbox')

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `失败关闭：缺 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝运行。` +
      '必须经 `pnpm with-test-model pnpm m6.1:live --suite short …` 跑（绝不回落到 .env 的原 key）。'
  )
  process.exit(2)
}
if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error('失败关闭：OPENAI_API_KEY 为空 ⇒ 拒绝运行（不猜、不回落）。')
  process.exit(2)
}
if (phase !== 'preflight' && round !== 1 && round !== 2) {
  console.error(`必须显式给 --round 1|2（收到 ${String(argValue('--round'))}）：两轮**分别**判定，不合并不择优。`)
  process.exit(2)
}
if (!['code-default', 'deployed'].includes(armName)) {
  console.error(`--arm 只能是 code-default|deployed（收到 ${armName}）`)
  process.exit(2)
}
if (!['supported', 'rce', 'ewp', 'cin', 'all'].includes(setName)) {
  console.error(`--set 只能是 supported|rce|ewp|cin|all（收到 ${setName}）`)
  process.exit(2)
}
const limit = limitRaw === undefined ? undefined : Number(limitRaw)
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error(`--limit 必须是正整数（收到 ${String(limitRaw)}）`)
  process.exit(2)
}
const only = onlyRaw === undefined ? undefined : onlyRaw.split(',').map((value) => value.trim()).filter((v) => v !== '')
/** 诊断档（分母被截）⇒ 读数一律标 `diagnostic`，**不构成任何判定** */
const diagnostic = limit !== undefined || only !== undefined
/**
 * **运行中的中止闸**：尾部连续多少个轮次失败就中止（缺省 3；`0` = 关闭）。
 *
 * ⚠️ 为什么需要它（2026-09-24 实测）：开跑闸放行了一次正式 round 1（12:40Z 预检 3/3 通过），
 *    **一分钟内**窗口崩塌 —— 23 个轮次里 21 个 exit 1 + 0 字。没有它就会把
 *    59 个条目与 118 次 judge 调用全烧在一个死窗口上（这已经发生过两次）。
 */
const maxConsecutiveFailuresRaw = argValue('--max-consecutive-failures')
const maxConsecutiveFailures =
  maxConsecutiveFailuresRaw === undefined
    ? DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES
    : Number(maxConsecutiveFailuresRaw)
if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 0) {
  console.error(`--max-consecutive-failures 必须是非负整数（收到 ${String(maxConsecutiveFailuresRaw)}；0 = 关闭本闸）`)
  process.exit(2)
}
/**
 * **轮次之间的间隔**（毫秒；缺省 0 = 不节流）。
 *
 * ============================================================================
 *  为什么会有这个开关（2026-09-24 实测到根因之后加的）
 * ============================================================================
 * ```text
 * 预检的 stderr 里抓到了提供方的原话：
 *   HTTP 429 … "The model TPM limit has been significantly exceeded.
 *              Please reduce the request rate and retry later."（type: TooManyRequests）
 * ⇒ 是**每分钟 token（TPM）**限流，不是"端口坏了"。
 *   而一轮短场景要连续打 108 个轮次（每个都不小），judge 阶段更重
 *   （59 条 × 2 次采样，且每次申请 maxTokens 32000）。
 * ```
 * ⚠️ **它只改吞吐，不改任何判定**：间隔大小不进判据、不进量具配置、也不进候选冻结件的
 *    `JUDGING_FILES`（那些文件一个字节都没动）⇒ 用它**不需要**重取候选。
 * ⚠️ 缺省 0（不节流）⇒ 现有行为逐字不变；要不要在正式轮次用它由用户裁定。
 */
const turnIntervalMs = Number(argValue('--turn-interval-ms') ?? '0')
if (!Number.isInteger(turnIntervalMs) || turnIntervalMs < 0) {
  console.error(`--turn-interval-ms 必须是非负整数（收到 ${String(argValue('--turn-interval-ms'))}）`)
  process.exit(2)
}
/**
 * **run 阶段并发**（`--run-concurrency M`，1..16，缺省 1 = 原串行）。
 *
 * 纪律（用户 2026-09-25 常设指令：官方 key、并发拉满、保质量求最快）：
 * · **只改吞吐，不改任何判定**（与 `--turn-interval-ms` 同一纪律）：每条工况仍是
 *   "自己的空沙箱 + 冻结剧本逐轮 + 同一判据"；不进 runId / 量具配置 / 候选冻结件。
 * · 上限 16 而不是 128：每个并发工况 = 一个 tsx 子进程 + 一个 PGlite WASM 实例
 *   （内存受限的资源，不是 HTTP 那种可以拉满的东西）。
 * · ⚠️ `--shared-sandbox` 与 M>1 **互斥**：共用库会让并发工况互相看见对方写的记忆，
 *   冻结条文的前提（"空账本首轮"）直接被破坏。
 * · ⚠️ 中止闸的"连续"在并发下按**完成序**数（谁先落地谁相邻）——语义是"死窗口探测"，
 *   不再是严格的"剧本相邻"；N=1 时与原语义逐字相同。
 */
const runConcurrencyRaw = argValue('--run-concurrency')
const runConcurrency = runConcurrencyRaw === undefined ? 1 : Number(runConcurrencyRaw)
if (!Number.isInteger(runConcurrency) || runConcurrency < 1 || runConcurrency > 16) {
  console.error(`--run-concurrency 必须是 1..16 的整数（收到 ${String(runConcurrencyRaw)}；run 阶段每个并发位是一个子进程+一个 PGlite 实例）`)
  process.exit(2)
}
if (!perItemIsolation && runConcurrency > 1) {
  console.error('--shared-sandbox 与 --run-concurrency>1 互斥：共用库会让并发工况互相污染（冻结条文的前提被破坏）')
  process.exit(2)
}
/**
 * **judge 阶段并发**（`--concurrency N`，1..128，缺省 1 = 原串行）。
 *
 * 与 `m6.1:instrument:live --concurrency` 同一纪律与同一实现模式（有界 worker 池）：
 * · 每条条目仍是"同一输入判两次（CD-10/CD-14）+ 采样间隔"；不进 runId / 量具配置 / 候选冻结件。
 * · 节奏：每个 worker 自己记"是否已调用过"，调用前有间隔（除该 worker 的第一次）；
 *   条目内的两次采样之间仍保留原有的采样间隔。
 * · 输出按语料序组装（完成序只影响日志与 partial 行序）⇒ 与串行版读数可比。
 * · 传输失败中止闸的"连续"在并发下按**完成序**数；N=1 时与原语义逐字相同。
 */
const judgeConcurrencyRaw = argValue('--concurrency')
const judgeConcurrency = judgeConcurrencyRaw === undefined ? 1 : Number(judgeConcurrencyRaw)
if (!Number.isInteger(judgeConcurrency) || judgeConcurrency < 1 || judgeConcurrency > 128) {
  console.error(`--concurrency 必须是 1..128 的整数（收到 ${String(judgeConcurrencyRaw)}；judge 阶段并发）`)
  process.exit(2)
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * **这一轮实际用的是什么配置**（端点 host + 模型名 + key 长度；**永不记 key 取值**）。
 *
 * ⚠️ 它是"哪一轮用了哪套配置"的**归属**读数：同一天我们跑过测试端点（被限流打断）
 *    与官方端点（用户授权，只用于这一轮）⇒ 证据里必须分得开。
 */
const modelRoute = modelRouteFromEnv(
  process.env as Record<string, string | undefined>,
  process.env[TEST_MODEL_WRAPPER_MARKER] === '1' &&
    (process.env.OPENAI_BASE_URL ?? '').includes('api.deepseek.com')
    ? '**用户授权的官方 key**（本轮专用；进程环境内联传入，未写入任何文件）'
    : '测试端点包装器（`pnpm with-test-model`）'
)

/**
 * **限流感知的重试**（缺省：冷却 60s、最多 5 次）。
 *
 * 只对 `rate_limited` 生效（TPM 是滑动分钟窗 ⇒ 等一个窗口通常就好了）；
 * 超时/鉴权/5xx **不**重试 —— 重试不会变好，那三种该如实失败。
 * ⚠️ 只改吞吐：它不改任何判据、不动量具配置、不动候选冻结件。
 * ⚠️ **它有一个必须记下来的副作用**：被重试的轮次里，用户那句话可能已经被
 *    `beginTurn` 落过一次（进程在模型调用前就写了用户事件）⇒ 重试会让**这一句话在账本里出现两次**。
 *    因此每条轮次记录都带 `attempts` 与 `rateLimitWaitsMs`，读数里另行汇总
 *    `rateLimitRetries` —— 哪几条工况的对话历史被动过，必须可查。
 */
const rateLimitCooldownMs = Number(argValue('--rate-limit-cooldown-ms') ?? String(DEFAULT_RATE_LIMIT_COOLDOWN_MS))
const rateLimitRetries = Number(argValue('--rate-limit-retries') ?? String(DEFAULT_RATE_LIMIT_RETRIES))
for (const [name, value] of [
  ['--rate-limit-cooldown-ms', rateLimitCooldownMs],
  ['--rate-limit-retries', rateLimitRetries],
] as const) {
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} 必须是非负整数（收到 ${String(value)}）`)
    process.exit(2)
  }
}

const ARMS = {
  'code-default': { rollupTokens: 0, note: '代码缺省档：`DEFAULT_CONTEXT_BUDGET.rollupTokens = 0`' },
  deployed: { rollupTokens: 400, note: '部署档：`.env` 的 `CHARACTER_ROLLUP_TOKENS=400`（ADR-052）' },
} as const
const arm = ARMS[armName]

/**
 * **与正式轮次同一套** spawn 参数（预检与轮次共用，避免出现两套）。
 *
 * ⚠️ 预检必须在"轮次沙箱机制"之前跑（它不该创建任何 run 目录）⇒ 这个函数是**模块级**的，
 *    不依赖 `currentDbDir` 那套可变状态。
 * ⚠️ **stderr 也收**（2026-09-24 的教训）：只收 stdout 会让我在 21/23 轮次失败时
 *    说不出"限流 / 超时 / 鉴权 / 5xx"中的哪一种 —— 而那四种的处置完全不同。
 */
function spawnCliTurn(input: {
  readonly dbDir: string
  readonly args: readonly string[]
  readonly rollupTokens: number
}): { status: number; stdout: string; stderr: string; durationMs: number } {
  const started = Date.now()
  const result = spawnSync(process.execPath, [TSX_CLI, 'src/main.ts', ...input.args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PGLITE_DATA_DIR: input.dbDir,
      PROJECT_LG_SANDBOX: input.dbDir,
      CHARACTER_ROLLUP_TOKENS: String(input.rollupTokens),
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    durationMs: Date.now() - started,
  }
}

/**
 * `spawnCliTurn` 的**异步版**（`--run-concurrency` 起：并发工况不能互相阻塞事件循环）。
 *
 * ⚠️ 与同步版**同一套 spawn 参数**（cwd / env / maxBuffer 语义一致）——两套参数
 *    就会出现"串行跑的轮次与并发跑的轮次环境不同"的归属漏洞。
 * ⚠️ `dbDir` **显式传入**：并发下不存在"当前沙箱"这个全局事实（每个工况自己的库
 *    只属于它自己）——全局 `currentDbDir` 只服务串行时代的回退路径（`eligibleStateFor`）。
 */
function spawnCliTurnAsync(input: {
  readonly dbDir: string
  readonly args: readonly string[]
  readonly rollupTokens: number
}): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts', ...input.args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PGLITE_DATA_DIR: input.dbDir,
        PROJECT_LG_SANDBOX: input.dbDir,
        CHARACTER_ROLLUP_TOKENS: String(input.rollupTokens),
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
      resolve({ status: -1, stdout, stderr: `${stderr}\n${String(error)}`, durationMs: Date.now() - started })
    })
    child.on('close', (status) => {
      resolve({ status: status ?? -1, stdout, stderr, durationMs: Date.now() - started })
    })
  })
}

/* ---------------------------------------------------------------------------
 * 冻结工况（逐条）
 * ------------------------------------------------------------------------- */

interface WorkItem {
  readonly setId: 'supported' | 'rce' | 'ewp' | 'cin'
  readonly id: string
  readonly category: string
  /** 依次要说的用户原话 */
  readonly turns: readonly string[]
  /** 判定用的题面（支持性回忆/反例集有；写入与误触发没有） */
  readonly question?: string
  /** 程序面期望（写入正控用） */
  readonly programExpectation?: { readonly kind: 'written' | 'already_applied'; readonly value: string }
  /** 供人读的说明（进 local，不进 Git 正文） */
  readonly note: string
}

function buildWorkItems(): WorkItem[] {
  const items: WorkItem[] = []
  if (setName === 'supported' || setName === 'all') {
    for (const item of loadSupportedRecallSet(ROOT)) {
      items.push({
        setId: 'supported',
        id: item.id,
        category: item.category,
        turns: [...item.setup, item.question],
        question: item.question,
        note: `${item.basisKind} · 期望要点 ${item.expectedPoints.join('/')} · 禁止 ${item.forbidden.join('/')}`,
      })
    }
  }
  if (setName === 'rce' || setName === 'all') {
    for (const item of loadCounterexamples(ROOT)) {
      if (item.humanReview === true) continue /* 人审项不进机器读数（它们缺原始输入） */
      items.push({
        setId: 'rce',
        id: item.id,
        category: item.category,
        turns: [...item.setup, item.question],
        question: item.question,
        note: `不许出现：${item.mustNotProduce.join('/')}`,
      })
    }
  }
  if (setName === 'ewp' || setName === 'all') {
    for (const item of loadExplicitWriteSet(ROOT)) {
      items.push({
        setId: 'ewp',
        id: item.id,
        category: 'explicit_write',
        turns: [...item.setup],
        programExpectation: {
          kind: item.expectedOutcome === 'already_applied' ? 'already_applied' : 'written',
          value: item.expectedStoredValue,
        },
        note: `槽位 ${item.slot} · 期望 ${item.expectedOutcome}=${item.expectedStoredValue}`,
      })
    }
  }
  if (setName === 'cin' || setName === 'all') {
    for (const item of loadCorrectionNegativeSet(ROOT)) {
      items.push({
        setId: 'cin',
        id: item.id,
        category: item.category,
        turns: [item.text],
        note: '误触发负控：这一轮**不得**造成任何未经请求的记忆变更',
      })
    }
  }
  const filtered = only === undefined ? items : items.filter((item) => only.includes(item.id))
  return limit === undefined ? filtered : filtered.slice(0, limit)
}

/* ---------------------------------------------------------------------------
 * 合成沙箱（**空**隔离库；真实库只做文件树摘要）
 * ------------------------------------------------------------------------- */

const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim()
/* 预检不是一轮 ⇒ 用具名标签，别让 `NaN` 混进 runId（它不会被用到，但读起来必须是自解释的） */
const roundLabel = round === 1 || round === 2 ? String(round) : 'preflight'
const wpId = `wp5-short-r${roundLabel}-${armName}`
const runId = resumeRunId ?? createRunId({ wpId, headShort })
/**
 * **运行相关树指纹**（不是 HEAD）。
 *
 * ⚠️ 为什么不是 HEAD：正式 round 1 启动之后我提交了**只动文档与证据**的提交，
 *    HEAD 就变了 —— 而"这一轮跑的是哪一棵代码树"并没有变。用 HEAD 当闸会把
 *    "文档提交"误判成"代码变了"，从而拒绝一次**完全有效**的续跑。
 * 覆盖：`src/**` + 本运行器消费的 scripts 模块（`m6.1-*` 与 `m6-command-surface.ts`）
 *      + 冻结控制集 `evals/m6.1/control/**`。
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

/*
 * ===========================================================================
 *  端点健康预检（`--phase preflight`）与**正式轮次的开跑闸**
 * ===========================================================================
 * 两次整轮白跑都是"端点窗口不可用"（见 `m6.1-preflight-lib.ts` 的实测记录）。
 * 正式轮次开跑前先证明端点现在是通的；诊断档不拦（它本来就是小样）。
 * `--no-preflight` 是**逃生口**，但会被写进读数（`preflight: 'skipped (--no-preflight)'`）。
 */
const phaseRaw = phase
const skipPreflight = process.argv.includes('--no-preflight')
if (phaseRaw === 'preflight') {
  /* 预检用**它自己的**一次性空沙箱：不碰任何轮次沙箱、不创建任何 run 目录 */
  const probeWork = mkdtempSync(join(tmpdir(), 'project-lg-m61-preflight-'))
  const probeSandbox = join(probeWork, 'pglite')
  mkdirSync(probeSandbox, { recursive: true })
  if (isProductionDir(probeSandbox)) throw new Error('拒绝：预检沙箱被判成生产库')
  if (resolve(probeSandbox) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：预检沙箱就是真实库')

  const probeTexts = ['在吗', '嗯，今天有点累', '刚才说的那件事我记下了']
  const probes: PreflightProbe[] = []
  console.log('='.repeat(78))
  console.log(`M6.1 端点健康预检（最多 ${String(PREFLIGHT_DEFAULT_PROBES)} 次模型调用；**不**产生任何正式读数）`)
  console.log('='.repeat(78))
  for (const [index, text] of probeTexts.slice(0, PREFLIGHT_DEFAULT_PROBES).entries()) {
    const said = spawnCliTurn({ dbDir: probeSandbox, args: [text], rollupTokens: arm.rollupTokens })
    const reply = extractReply(said.stdout)
    const probe: PreflightProbe = {
      index,
      status: said.status,
      replyChars: reply.length,
      replyMarkerFound: said.stdout.includes('苏沐薇:'),
      durationMs: said.durationMs,
      ...(said.status === 0 ? {} : { failureHint: classifyTurnFailure(said.status, said.stderr) }),
    }
    probes.push(probe)
    console.log(
      `  探针 ${String(index + 1)} · exit=${String(probe.status)} · 回复 ${String(probe.replyChars)} 字 · ` +
        `${String(probe.durationMs)}ms · 标记=${String(probe.replyMarkerFound)}` +
        `${probe.failureHint === undefined ? '' : ` · 提示=${probe.failureHint}`}`
    )
    /*
     * 失败时**打印**一小段 stderr（只到终端，不落盘）。
     *
     * 理由：类别只说"是限流/超时/鉴权"，而"**哪一种**限流"（每分钟 / 每天 / 并发）
     * 只在提供方的原话里 —— 处置完全不同（等一下 vs 换 key vs 明天再来）。
     * ⚠️ 探针的输入是我们自己的三句合成话，因此这一段不含用户内容；
     *    即便如此也只打印 200 字并压成一行，不写进任何 git 里的文件。
     */
    if (probe.status !== 0) {
      const excerpt = said.stderr.replace(/\s+/g, ' ').trim().slice(0, 200)
      console.log(`        stderr 摘要：${excerpt === '' ? '(空)' : excerpt}`)
    }
  }
  const judgment = judgePreflight(probes)
  const artifact: PreflightArtifact = {
    schemaVersion: 'm6.1-preflight@1',
    startedAt: new Date(Date.now() - probes.reduce((sum, probe) => sum + probe.durationMs, 0)).toISOString(),
    finishedAt: new Date().toISOString(),
    treeFingerprint: runRelevantTree,
    arm: armName,
    modelRoute,
    probes,
    judgment,
    notProven: [
      '**不**证明量具（判定器）有效 —— 它只回答"端点通不通"。',
      '**不**证明这一轮会顺利：它只是"开跑前现在这一刻"的读数，端点随时会变（保鲜期 30 分钟）。',
      '**不**给任何判定加宽松：预检只决定"允不允许开跑"。',
    ],
  }
  const written = writePreflightArtifact(ROOT, artifact)
  console.log('')
  console.log(
    `  判决 = ${judgment.verdict}${
      judgment.reasons.length > 0 ? ` · ${judgment.reasons.join(' · ')}` : ' · 端点现在是通的'
    }`
  )
  console.log(`  证据 = ${written}`)
  process.exit(judgment.verdict === 'HEALTHY' ? 0 : 1)
}

if (!diagnostic && !skipPreflight && (phaseRaw === 'run' || phaseRaw === 'all')) {
  const reading = readPreflightGate({
    root: ROOT,
    treeFingerprint: runRelevantTree,
    nowMs: Date.now(),
    modelRoute,
  })
  if (!reading.ok) {
    console.error(`失败关闭（开跑闸）：${reading.reason}`)
    process.exit(2)
  }
  console.log(`  端点预检  ${reading.reason}`)
}

const preflightNote =
  diagnostic
    ? 'diagnostic（诊断档不要求预检）'
    : skipPreflight
      ? 'skipped (--no-preflight)'
      : readPreflightGate({
          root: ROOT,
          treeFingerprint: runRelevantTree,
          nowMs: Date.now(),
          modelRoute,
        }).reason

const runDir = resumeRunId === undefined ? openRunDir(ROOT, runId) : join(ROOT, 'artifacts', 'm6.1', runId)
/** 续跑时的**强检查**：那个目录里已经有树指纹时，必须**逐字相同** */
let treeFingerprintCheck: 'matched' | 'unavailable' = 'unavailable'
if (resumeRunId !== undefined) {
  if (!existsSync(runDir)) throw new Error(`--resume ${runId}：目录不存在（${runDir}）`)
  if (!runId.includes(`-r${String(round)}-${armName}-`)) {
    throw new Error(
      `--resume ${runId}：目录名与本次的 round(${String(round)}) / arm(${armName}) 不一致 ⇒ 拒绝续跑`
    )
  }
  const prior = [join(runDir, 'manifest.json'), join(runDir, 'reading.json')].find((path) => existsSync(path))
  if (prior !== undefined) {
    const parsed = JSON.parse(readFileSync(prior, 'utf8')) as {
      runRelevantTreeSha256?: unknown
      modelRoute?: unknown
    }
    if (typeof parsed.runRelevantTreeSha256 === 'string') {
      if (parsed.runRelevantTreeSha256 !== runRelevantTree) {
        throw new Error(
          `--resume ${runId}：**运行相关树指纹**与本次不一致 ⇒ 拒绝续跑（会把两棵树的读数搅在一起）\n` +
            `  已有 ${parsed.runRelevantTreeSha256}\n  本次 ${runRelevantTree}`
        )
      }
      treeFingerprintCheck = 'matched'
    }
    /*
     * ⚠️ **同一棵树 ≠ 同一套配置**（2026-09-24 用户裁定改用官方 key 之后加的）：
     *    树没变而端点/模型变了 ⇒ 续跑会把两套配置的读数接在一起。
     *    用户既有裁定："新配置的读数不得回填/混合"。
     */
    if (parsed.modelRoute !== undefined && !sameModelRoute(parsed.modelRoute as never, modelRoute)) {
      const priorRoute = parsed.modelRoute as { baseUrlHost?: string; largeModel?: string }
      throw new Error(
        `--resume ${runId}：**模型路由**与本次不一致 ⇒ 拒绝续跑\n` +
          `  已有 ${String(priorRoute.baseUrlHost)} / ${String(priorRoute.largeModel)}\n` +
          `  本次 ${modelRoute.baseUrlHost} / ${modelRoute.largeModel}`
      )
    }
  }
}
const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'project-lg-m61-short-'))
const dbDir = join(work, 'pglite')
mkdirSync(dbDir, { recursive: true })
if (isProductionDir(dbDir)) throw new Error('拒绝：沙箱目录被判成生产库')
if (resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：沙箱目录就是真实库')

/*
 * ⚠️ 合成沙箱路径**在 run 阶段结束后**写入 local（见下面的 `sandbox-dir.txt` / `sandbox-dirs.jsonl`）：
 *    run 阶段只 spawn CLI（拿不到 packet），而"她这一轮实际看见了什么"
 *    （section 名字 / 摘要端口有没有产出 / 记录状态行说了哪种事实）只有从**那个沙箱的 trace** 里读得到 ——
 *    入口是既有的 `pnpm m6.1:wp3:trace --run <runId>`（它从 `sandbox-dir.txt` 的第一行取路径）。
 *    ⚠️ 缺省**逐工况一个沙箱** ⇒ `sandbox-dir.txt` 记的是**第一个工况**那个库
 *       （里面只有那一条工况的轮次）；其余工况的路径在 `sandbox-dirs.jsonl` 里。
 */

const realDbBefore = digestTree(PRODUCTION_DB_DIR)

/** 当前生效的合成沙箱（`--shared-sandbox` 时全程同一个；缺省**逐工况一个新空库**） */
let currentDbDir = dbDir
const sandboxByItem: { itemId: string; dir: string }[] = []
/**
 * 被**限流重试**过的轮次（`attempts > 1`）—— 模块级，因为 reading.json 要写它。
 *
 * ⚠️ 这份清单是**保真度披露**，不是装饰：重试那一轮时，用户那句话可能已经在
 *    `beginTurn` 里落过一次（进程在模型调用前就写了用户事件）⇒
 *    那一条工况的对话历史里会出现**重复的一句**。哪几条被动过，必须可查。
 */
const rateLimitRetriedItems: { itemId: string; turnIndex: number; attempts: number; waitMs: number }[] = []

const freshSandboxDir = (label: string): string => {
  const work = mkdtempSync(join(tmpdir(), `project-lg-m61-short-${label}-`))
  const dir = join(work, 'pglite')
  mkdirSync(dir, { recursive: true })
  if (isProductionDir(dir)) throw new Error('拒绝：沙箱目录被判成生产库')
  if (resolve(dir) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：沙箱目录就是真实库')
  return dir
}

const runCli = (args: readonly string[]): { status: number; stdout: string; stderr: string; durationMs: number } =>
  spawnCliTurn({ dbDir: currentDbDir, args, rollupTokens: arm.rollupTokens })

const memoryListText = (): string => runCli(['--memory-list']).stdout

/**
 * `memoryListText` 的**指定库**异步版（`--run-concurrency` 用）：
 * 每个工况读**它自己那个沙箱**的记忆列表 —— 并发下不存在"当前沙箱"这个全局事实。
 */
const memoryListTextIn = async (dbDir: string): Promise<string> =>
  (await spawnCliTurnAsync({ dbDir, args: ['--memory-list'], rollupTokens: arm.rollupTokens })).stdout

/**
 * 把逐工况沙箱清单落盘（**正常结束与中止路径都调用**）。
 *
 * 见 `run` 阶段末尾的说明：只在循环之后写会让"被中止的轮次"丢掉唯一能复盘的那份证据。
 * 幂等：重复调用只是重写同样的内容（中止发生在循环中间时，清单里就是**已跑过**的那些工况）。
 */
function writeSandboxMap(): void {
  writeFileSync(
    join(localDir, 'sandbox-dirs.jsonl'),
    `${sandboxByItem.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  )
  writeFileSync(
    join(localDir, 'sandbox-dir.txt'),
    `${(perItemIsolation ? sandboxByItem[0]?.dir : dbDir) ?? dbDir}\n` +
      `（WP5 短场景合成隔离库；${perItemIsolation ? '**逐工况一个新空库**，本文件记的是第一个工况的库' : '全部工况共用一个库'}；` +
      `正文面全部在本目录，Git 内只留哈希与计数）\n`,
    'utf8'
  )
}

/**
 * 从 `--memory-list` 的 **stdout** 里取出**记忆列表正文**（唯一实现）。
 *
 * ============================================================================
 *  ⚠️ 为什么必须剥（第一版实测踩到，是**量具错了**而不是产品错了）
 * ============================================================================
 * 第一版直接把整段 stdout 做哈希来判"记忆列表变没变"，于是**每一条都判成"变了"**：
 * stdout 里除了列表，还有启动日志、`runtime=…` 的随机 id、
 * `（本次建档）` 与 `首次建档完成` 这类**只出现一次**的行 —— 它们与"记忆有没有被改"无关。
 *
 * 判据若把"进程噪声"当成"记忆变化"，就会把干净的一轮读成违规
 * （本仓库反复登记的那类"数字对、但数字描述的不是你以为的东西"）。
 * 因此这里**只留正文**：丢掉日志行（`Info/Warn/Error/Debug/Trace`）与 tsx/pnpm 横幅。
 */
const LOG_LINE = /^\s*(Info|Warn|Error|Debug|Trace)\s/
export function memoryListSignature(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !LOG_LINE.test(line))
    .filter((line) => !line.startsWith('◇'))
    .join('\n')
    .trim()
}

console.log('='.repeat(78))
console.log('M6.1 WP5 短场景运行器（生产装配本尊 · 空合成隔离库 · 真模型）')
console.log('='.repeat(78))
console.log(`  runId      ${runId}`)
console.log(`  轮次/臂    round=${String(round)} · arm=${armName}（rollupTokens=${String(arm.rollupTokens)}）`)
console.log(
  `  并发       run=${String(runConcurrency)} · judge=${String(judgeConcurrency)}` +
    '（只改吞吐，不进 runId/量具配置/候选冻结件）'
)
console.log(`  集         ${setName}${diagnostic ? '（**诊断档**：分母被截，不作判定）' : ''}`)
console.log(`  合成库     ${dbDir}`)
console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（只摘要，不打开）`)
console.log('')

/* ---------------------------------------------------------------------------
 * 逐轮记录（**逐条落盘** ⇒ 断了能续；verbatim 只进 local）
 * ------------------------------------------------------------------------- */

interface TurnRecord {
  readonly itemId: string
  readonly setId: WorkItem['setId']
  readonly category: string
  readonly turnIndex: number
  readonly userTextSha256: string
  readonly replySha256: string
  readonly replyChars: number
  readonly status: number
  readonly durationMs: number
  readonly replyMarkerFound: boolean
  /**
   * 失败的**具名提示**（从 stderr 分类；只留类别，**不留正文**）—— M6.1 WP5 追加。
   * ⚠️ 它是"为什么这一轮没跑成"的可审计答案（`rate_limited` / `timeout` / `auth_failed` / …）。
   */
  readonly failureHint?: string
  /** 这一轮之后（该 item 结束后）的记忆列表读数 —— 只记哈希与是否含期望值 */
  readonly memoryListSha256?: string
  readonly memoryListBeforeSha256?: string
  readonly memoryListUnchanged?: boolean
  readonly memoryListHasExpected?: boolean
  readonly memoryListEmpty?: boolean
}

const partialPath = join(runDir, 'turns.partial.jsonl')
const localPath = join(localDir, 'turns.jsonl')
const done = new Set<string>()
if (existsSync(partialPath)) {
  for (const line of readFileSync(partialPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parsed = JSON.parse(line) as TurnRecord
    done.add(parsed.itemId)
  }
}

const items = buildWorkItems()
if (items.length === 0) {
  console.error('MEASUREMENT INVALID：选出来的工况 0 条 ⇒ 什么都没量到')
  process.exit(2)
}

if (phase === 'run' || phase === 'all') {
  /** 已跑轮次的退出码（**只**用来数"尾部连续失败"）—— 见 `m6.1-run-guards.ts` */
  const turnStatuses: number[] = []
  /** 每个失败轮次的**具名提示**（类别，无正文）—— 进 `aborted.json`，回答"为什么没跑成" */
  const turnFailureHints: string[] = []
  /*
   * ---- run 阶段主循环（`--run-concurrency` 起：有界 worker 池；缺省 1 = 原串行）----
   *
   * 纪律：并发**只改吞吐**（见 `--run-concurrency` 的注释）；每条工况仍是
   * "自己的空沙箱 + 冻结剧本逐轮 + 同一中止闸"。输出（partial 行）按完成序追加
   * （断点续跑按 itemId 对账，顺序无关）；`sandboxByItem` / `done` / 中止闸计数
   * 都是共享结构，JS 单线程下每次 push 原子。
   */
  const runPending = items.filter((item) => !done.has(item.id))
  for (const item of items) {
    if (done.has(item.id)) {
      console.log(`  ${item.id.padEnd(10)} 已在 partial 里 ⇒ 跳过（续跑）`)
    }
  }
  if (runPending.length > 0 && runConcurrency > 1) {
    console.log(
      `  run 阶段并发 ${String(Math.min(runConcurrency, runPending.length))}` +
        '（每条工况仍是自己的空沙箱 + 冻结剧本；中止闸按完成序数"连续"）'
    )
  }
  let runCursor = 0
  const runOneItem = async (item: WorkItem, hasRunBefore: () => boolean): Promise<void> => {
    /* 缺省：**每个工况一个空沙箱** ⇒ 冻结条文的前提（"空账本首轮"等）才成立。
     * ⚠️ 并发下 dbDir **显式传**（不存在"当前沙箱"这个全局事实）。 */
    const itemDbDir = perItemIsolation ? freshSandboxDir(item.id.toLowerCase()) : dbDir
    if (perItemIsolation) {
      sandboxByItem.push({ itemId: item.id, dir: itemDbDir })
    }
    const memoryBefore = item.setId === 'cin' || item.setId === 'ewp' ? await memoryListTextIn(itemDbDir) : undefined
    let lastReply = ''
    for (const [index, text] of item.turns.entries()) {
      /* 节流（缺省 0 = 不节流）：TPM 限流下的吞吐控制，**不进任何判据**；
       * 并发下按 worker 自己的调用史节流（N=1 = 原串行节奏） */
      if (turnIntervalMs > 0 && hasRunBefore()) await sleep(turnIntervalMs)
      let said = await spawnCliTurnAsync({ dbDir: itemDbDir, args: [text], rollupTokens: arm.rollupTokens })
      let attempts = 1
      let rateLimitWaitsMs = 0
      /*
       * 限流 ⇒ 等一个冷却窗再试（见 `rateLimitCooldownMs` 上的说明）。
       * 只对 `rate_limited` 生效；其它失败一律如实记下。
       */
      for (;;) {
        const hint = classifyTurnFailure(said.status, said.stderr)
        const decision = decideRateLimitRetry({
          attempt: attempts,
          maxRetries: rateLimitRetries,
          cooldownMs: rateLimitCooldownMs,
          hint,
        })
        if (!decision.retry) break
        console.log(`  ${item.id.padEnd(10)} ${decision.reason}`)
        await sleep(decision.waitMs)
        rateLimitWaitsMs += decision.waitMs
        said = await spawnCliTurnAsync({ dbDir: itemDbDir, args: [text], rollupTokens: arm.rollupTokens })
        attempts += 1
      }
      const reply = extractReply(said.stdout)
      lastReply = reply
      turnStatuses.push(said.status)
      turnFailureHints.push(classifyTurnFailure(said.status, said.stderr))
      if (attempts > 1) {
        rateLimitRetriedItems.push({ itemId: item.id, turnIndex: index, attempts, waitMs: rateLimitWaitsMs })
      }
      const record: TurnRecord = {
        itemId: item.id,
        setId: item.setId,
        category: item.category,
        turnIndex: index,
        userTextSha256: sha256OfText(text),
        replySha256: sha256OfText(reply),
        replyChars: reply.length,
        status: said.status,
        durationMs: said.durationMs,
        replyMarkerFound: said.stdout.includes('苏沐薇:'),
        ...(attempts > 1 ? { attempts, rateLimitWaitsMs } : {}),
        ...(said.status === 0 ? {} : { failureHint: classifyTurnFailure(said.status, said.stderr) }),
      }
      appendFileSync(partialPath, `${JSON.stringify(record)}\n`, 'utf8')
      appendFileSync(
        localPath,
        /*
         * ⚠️ 这一份进 **gitignored** 的 local：可以放 `stderrTail`（诊断要读原文）。
         *    git 里那一份（`turns.partial.jsonl`）只放**类别**。
         */
        `${JSON.stringify({
          ...record,
          /* `@9`：落盘时刻（参考钟的来源；旧存档没有它 ⇒ 重判时用 runId 的日期精度并披露） */
          at: new Date().toISOString(),
          userText: text,
          reply,
          note: item.note,
          ...(said.status === 0 ? {} : { stderrTail: said.stderr.slice(-600) }),
        })}\n`,
        'utf8'
      )
      /*
       * ======================================================================
       *  运行中的中止闸（2026-09-24 实测换来的）
       * ======================================================================
       * 预检只证明"开跑前那一刻是通的"。实测：12:40Z 预检 3/3 通过，
       * **一分钟内**窗口崩塌（23 个轮次里 21 个 exit 1 + 0 字）。
       * 连续失败到阈值就立刻停 —— 不再把剩下的条目与 118 次 judge 调用烧在死窗口上。
       */
      const decision = decideTurnAbort({
        statuses: turnStatuses,
        maxConsecutiveFailures: maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES,
      })
      if (decision.abort) {
        const aborted = {
          schemaVersion: 'm6.1-run-aborted@1',
          at: new Date().toISOString(),
          reason: 'consecutive_turn_failures',
          detail: decision.reason,
          streak: decision.streak,
          threshold: maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES,
          turnsAttempted: turnStatuses.length,
          turnsFailed: turnStatuses.filter((status) => status !== 0).length,
          failureHints: failureHintSummary(turnFailureHints as never),
          rateLimitRetriedTurns: rateLimitRetriedItems.length,
          itemsCompleted: done.size,
          asked: '端点窗口正在崩塌（装置层）。本轮读数不可用作任何判定；请等窗口恢复后重跑。',
        }
        writeFileSync(join(runDir, 'aborted.json'), `${JSON.stringify(aborted, null, 2)}\n`, 'utf8')
        /* ⚠️ 中止路径也写沙箱清单：否则"她实际看见了什么"读不出来（见 `writeSandboxMap`） */
        writeSandboxMap()
        console.error(`\n  ⚠️ **中止**：${decision.reason}`)
        console.error(
          `     已跑 ${String(turnStatuses.length)} 轮 · 失败 ${String(aborted.turnsFailed)}` +
            ` · 失败提示 ${aborted.failureHints}`
        )
        console.error('     ⇒ 写 aborted.json；本轮**不得**作为任何判定（判定器会把它读成 INCOMPLETE）')
        process.exit(3)
      }
    }
    if (memoryBefore !== undefined) {
      const after = memoryListSignature(await memoryListTextIn(itemDbDir))
      const beforeSignature = memoryListSignature(memoryBefore)
      const program: TurnRecord = {
        itemId: item.id,
        setId: item.setId,
        category: item.category,
        turnIndex: item.turns.length,
        userTextSha256: '',
        replySha256: sha256OfText(lastReply),
        replyChars: lastReply.length,
        status: 0,
        durationMs: 0,
        replyMarkerFound: true,
        memoryListSha256: sha256OfText(after),
        memoryListBeforeSha256: sha256OfText(beforeSignature),
        /*
         * ⚠️ **误触发负控的判据是"没变"，不是"空"**：所有工况共用同一个合成沙箱，
         *    因此早先工况写下的记忆**本来就在**。第一版写成 `memoryListEmpty`
         *    会把后面每一条都误判成违规 —— 那正是"判据看着合理但量错了东西"。
         * ⚠️ 比较的是**剥掉日志之后的正文**（见 `memoryListSignature`）：第一版拿整段
         *    stdout 比，于是**每一条**都判成"变了"（进程噪声）。
         */
        memoryListUnchanged: after === beforeSignature,
        memoryListHasExpected:
          item.programExpectation === undefined ? undefined : after.includes(item.programExpectation.value),
        memoryListEmpty: after.includes('没有匹配的记忆'),
      }
      appendFileSync(partialPath, `${JSON.stringify(program)}\n`, 'utf8')
      appendFileSync(
        localPath,
        `${JSON.stringify({ ...program, memoryListBeforeRaw: memoryBefore, memoryListAfterSignature: after })}\n`,
        'utf8'
      )
    }
    done.add(item.id)
    console.log(`  ${item.id.padEnd(10)} ${String(item.turns.length)} 轮 · 末轮回复 ${String(lastReply.length)} 字`)
  }
  const runWorker = async (): Promise<void> => {
    let hasRun = false
    const hasRunBefore = (): boolean => {
      if (hasRun) return true
      hasRun = true
      return false
    }
    for (;;) {
      const slot = runCursor
      runCursor += 1
      if (slot >= runPending.length) return
      await runOneItem(runPending[slot]!, hasRunBefore)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(runConcurrency, Math.max(runPending.length, 1)) }, () => runWorker())
  )

  /*
   * ---- 沙箱路径落盘（run 阶段结束时）----
   * `sandbox-dir.txt`：**第一个工况**的库（缺省逐工况隔离时，它里面只有那一条工况的轮次）
   *                   ⇒ 既有的 `m6.1:wp3:trace` 直接可用（读到的就是那一条）。
   * `sandbox-dirs.jsonl`：逐工况的路径（判据要按工况取自己的记忆列表时用）。
   *
   * ⚠️ **中止路径也必须写这一份**（2026-09-24 实测缺口）：那一轮在 12 个轮次处被中止，
   *    而沙箱清单只在循环**之后**才写 ⇒ 目录里只剩 `aborted.json` + `turns.partial.jsonl`，
   *    "她实际看见了什么"（trace / 状态行 / 召回计数）**读不出来了** ——
   *    而那正是刚跑过的那 5 个工况唯一还能复盘的东西。
   */
  writeSandboxMap()
}

/* ---------------------------------------------------------------------------
 * 程序面读数（不调模型）：写入正控 / 误触发负控
 * ------------------------------------------------------------------------- */

const records = existsSync(partialPath)
  ? readFileSync(partialPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as TurnRecord)
  : []

const programReadings = [...new Set(records.map((record) => record.itemId))].map((itemId) => {
  const rows = records.filter((record) => record.itemId === itemId)
  const program = rows.find((row) => row.memoryListSha256 !== undefined)
  const item = items.find((candidate) => candidate.id === itemId)
  return {
    itemId,
    setId: item?.setId ?? 'unknown',
    category: item?.category ?? 'unknown',
    turns: rows.filter((row) => row.memoryListSha256 === undefined).length,
    allTurnsSucceeded: rows.filter((row) => row.memoryListSha256 === undefined).every((row) => row.status === 0),
    memoryListEmpty: program?.memoryListEmpty ?? null,
    memoryListUnchanged: program?.memoryListUnchanged ?? null,
    memoryListHasExpected: program?.memoryListHasExpected ?? null,
    expected: item?.programExpectation ?? null,
  }
})

/* ---------------------------------------------------------------------------
 * 量具（冻结仪表）：每一轮的回复 → 三态。**证据来自程序事实，不是猜的**
 * ------------------------------------------------------------------------- */

interface JudgedItem {
  readonly itemId: string
  readonly setId: WorkItem['setId']
  readonly category: string
  readonly alertState: AlertState
  readonly labels: readonly string[]
  readonly ok: boolean
  readonly failure: string | null
  readonly samples: readonly (readonly string[])[]
  /**
   * **确定性诊断**（不是判定）：冻结条文里的 `expectedPoints` / `forbidden` 逐条命中情况。
   * ⚠️ 它**不**参与"成功"计数 —— 自然语言的成功条件由**冻结量具**判（CD-7/CD-14）；
   *    这一栏是给人看的旁证，防止"量具说安全"与"期望要点没答出来"互相掩盖。
   */
  readonly expectedPointsHit: readonly string[]
  readonly expectedPointsMissed: readonly string[]
  readonly forbiddenHit: readonly string[]
  /**
   * **测量协议 v2**（用户 2026-09-25 裁定 C · 争议加判）：前两次报警性不同 ⇒ 加判第 3 次，
   * 2/1 多数 = 读数。`tieBroken` 只标"经加判定读"，**不改变**任何门语义（弃判预算 ≤1/0 不动）；
   * 报告与 verdict 必须单列披露（"本轮有 N 条经加判定读"）。
   */
  readonly tieBroken?: true
  readonly tieBreakSample?: readonly string[]
}

const judged: JudgedItem[] = []
const judgePartialPath = join(runDir, 'judge.partial.jsonl')
/**
 * **判据的配置身份**（换端点/换模型/调参数都必须在这份读数里可查）。
 *
 * ⚠️ 为什么单列：量具的**有效性**（WP2 的 VALID 判定）是针对**一个配置**成立的；
 *    读数里不记 host / maxTokens / timeout / attempts，换过配置的读数与没换过的
 *    在文件上长得一样 —— 那正是"配置变更不可审计"。冻结的
 *    `m6.1:instrument:live` 记这几项并折进 cross-run `configKey`；本运行器同样要记。
 */
let judgeIdentity: Record<string, unknown> | null = null
if (phase === 'judge' || phase === 'all') {
  const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
  judgeIdentity = {
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
    note:
      'CD-14：判定权威是**三态**（alert / no_alert / undecidable）；细标签只作诊断。' +
      '⚠️ 换这里任何一个字段都等于**换量具配置** ⇒ 旧的有效性判定不覆盖新配置，且 cross-run 只比同 configKey 的样本。',
  }
  /**
   * 判定用的"她能拿到什么" = **该工况自己那个沙箱**的记忆列表正文（剥掉日志）。
   *
   * ⚠️ 逐工况隔离时不能拿"共用库/最后一个库"的读数当所有工况的证据 ——
   *    那会把 A 工况的记忆算进 B 工况的资格状态里（第一版正是如此）。
   */
  const sandboxOfItem = new Map<string, string>()
  {
    const sandboxFile = join(localDir, 'sandbox-dirs.jsonl')
    if (existsSync(sandboxFile)) {
      for (const line of readFileSync(sandboxFile, 'utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue
        const row = JSON.parse(line) as { itemId?: string; dir?: string }
        if (typeof row.itemId === 'string' && typeof row.dir === 'string') sandboxOfItem.set(row.itemId, row.dir)
      }
    }
  }

  /**
   * **该工况自己那个沙箱里"她当轮实际看到了什么"的结构性读数**（用户 2026-09-25 裁定 A 的落地）。
   *
   * 机制：调 `scripts/m6.1-turn-context.ts` 这个**只读**子进程（与 `m6.1:wp3:trace` 同一条路径），
   * 它把 `context_compile.sections` / `memory_recall` 计数 / 记录状态行写成一份 JSON。
   *
   * ⚠️ 三条纪律：
   *   ① **失败方向安全**：读不到（沙箱已清理 / 没有 trace / 没有 context_compile 步骤）
   *      ⇒ `{value:null, reason}`，由调用方**如实**填 `actualContextUnavailableReason`；
   *   ② **`null` 不是"她什么都没看到"**：它的含义是"**没有记录**"（判据里两者含义不同）；
   *   ③ 正文只进 gitignored 的 local（`turn-context-<itemId>.json`）。
   */
  const readTurnContextFor = (item: WorkItem): { value: unknown | null; reason?: string } => {
    const dir = sandboxOfItem.get(item.id)
    if (dir === undefined) {
      return { value: null, reason: '这一条没有记录到沙箱路径（`--shared-sandbox` 或更早版本的 run）' }
    }
    const outPath = join(localDir, `turn-context-${item.id}.json`)
    try {
      const result = spawnSync(
        process.execPath,
        [TSX_CLI, join('scripts', 'm6.1-turn-context.ts'), '--db-dir', dir, '--out', outPath],
        {
          cwd: ROOT,
          env: { ...process.env, PGLITE_DATA_DIR: dir, PROJECT_LG_SANDBOX: dir },
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        }
      )
      if (!existsSync(outPath)) {
        return { value: null, reason: `结构性读数子进程没有落盘（exit=${String(result.status ?? -1)}）` }
      }
      const readout = JSON.parse(readFileSync(outPath, 'utf8')) as {
        ok?: boolean
        reason?: string
        sections?: string[]
        recall?: Record<string, unknown> | null
        recordStatus?: { outcome: string; reasonCode: string } | null
      }
      if (readout.ok !== true) {
        return { value: null, reason: `结构性读数不可用：${String(readout.reason ?? '未给原因')}` }
      }
      return {
        value: judgeActualContextPayload({
          sections: readout.sections ?? [],
          recall: (readout.recall ?? null) as never,
          recordStatus: (readout.recordStatus ?? null) as never,
          userTurns: item.turns,
        }),
      }
    } catch (error) {
      return {
        value: null,
        reason: `结构性读数失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  const eligibleStateFor = (itemId: string): string => {
    const dir = sandboxOfItem.get(itemId)
    if (dir === undefined) return memoryListSignature(memoryListText())
    const saved = currentDbDir
    currentDbDir = dir
    try {
      return memoryListSignature(memoryListText())
    } finally {
      currentDbDir = saved
    }
  }
  /** 冻结条的 `expectedPoints` / `forbidden`（只读一次；逐条诊断用） */
  const supportedSpecs = loadSupportedRecallSet(ROOT)
  /* 逐条正文只读一次，按 (itemId, turnIndex) 建索引 —— 免得每条 item 都扫一遍整个文件 */
  const replyIndex = new Map<string, string>()
  /* `@9`：每轮的落盘时刻（参考钟；旧存档没有 `at` ⇒ 值为 undefined，如实进判定输入） */
  const turnClockIndex = new Map<string, string>()
  for (const line of readFileSync(localPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as { itemId?: string; turnIndex?: number; reply?: string; at?: string }
    if (typeof row.itemId === 'string' && typeof row.turnIndex === 'number' && typeof row.reply === 'string') {
      replyIndex.set(`${row.itemId}#${String(row.turnIndex)}`, row.reply)
      if (typeof row.at === 'string') turnClockIndex.set(`${row.itemId}#${String(row.turnIndex)}`, row.at)
    }
  }
  /* ---- 续跑：已判过的条目直接从 judge.partial.jsonl 读回来（逐条追加，不再"整段丢失"） ---- */
  const alreadyJudged = new Set<string>()
  if (existsSync(judgePartialPath)) {
    for (const line of readFileSync(judgePartialPath, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as JudgedItem
      judged.push(parsed)
      alreadyJudged.add(parsed.itemId)
    }
    console.log(`  judge 续跑：已有 ${String(alreadyJudged.size)} 条 ⇒ 跳过`)
  }
  let judgedThisRun = 0
  /**
   * ==========================================================================
   *  judge 阶段的**连续传输失败闸**（2026-09-24 实测换来的）
   * ==========================================================================
   * run 阶段已有闸（连续 3 个轮次 exit≠0 即停），judge 阶段此前**没有** ——
   * 而 judge 才是 TPM 大户（59 条 × 2 次采样 = 118 次调用、每次申请 maxTokens 32000）。
   * 没有它，限流下会一边拿 429 一边把 118 次调用烧完（这正是我们连续三次遇到的事）。
   *
   * ⚠️ 它**不改量具语义**：只是"停下来，让你在下一个窗口用 `--phase judge --resume` 接着判"。
   *    停下来 ⇒ judge 覆盖不全 ⇒ 判定器只能给 INCOMPLETE（已有逻辑），这是**正确**的读数。
   */
  let consecutiveJudgeTransportFailures = 0
  /*
   * ---- judge 阶段主循环（`--concurrency` 起：有界 worker 池；缺省 1 = 原串行）----
   *
   * 纪律（与 `m6.1:instrument:live --concurrency` 同一模式）：
   * · 每条条目仍是"同一输入判两次 + 采样间隔"；并发只改吞吐。
   * · `judge.partial.jsonl` 按**完成序**追加（断点续跑按 itemId 对账，顺序无关）；
   *   最终 `judged` 数组按**语料序**组装 ⇒ perItem 输出与串行版逐位相同。
   * · 传输失败中止闸的"连续"按**完成序**数（N=1 时与原语义逐字相同）。
   * · `--judge-limit`（诊断用）= 取语料序前 N 条待判条目。
   */
  const judgePending = items
    .filter((item) => {
      if (alreadyJudged.has(item.id)) return false
      return records.some((record) => record.itemId === item.id && record.memoryListSha256 === undefined)
    })
    .slice(0, judgeLimit ?? undefined)
  let judgeCursor = 0
  const judgeFresh = new Map<string, JudgedItem>()
  if (judgePending.length > 0 && judgeConcurrency > 1) {
    console.log(
      `  judge 阶段并发 ${String(Math.min(judgeConcurrency, judgePending.length))}` +
        '（每条仍为 2 次采样 + 采样间隔；输出按语料序组装）'
    )
  }
  const judgeOneItem = async (item: WorkItem, hasCalledBefore: () => boolean): Promise<void> => {
    const rows = records.filter((record) => record.itemId === item.id && record.memoryListSha256 === undefined)
    const last = rows[rows.length - 1]!
    const reply = replyIndex.get(`${item.id}#${String(last.turnIndex)}`) ?? ''

    /*
     * 证据 = **程序事实**：
     *   factBase      = 这一条的合成剧本（用户说过的话，逐字）
     *   eligibleState = 本轮的记忆列表读数（只读 CLI 输出，**不是**逐字上下文）
     *   actualContext = **结构性重建**（`@5` 起**真的填**）：
     *       该工况自己那个沙箱的 `context_compile.sections` 名单 + `memory_recall` 计数 +
     *       记录状态行 —— 与 `scripts/m6.1-wp3-trace.ts` 同一套只读路径。
     *   ⚠️ 为什么必须填（用户 2026-09-25 裁定 A）：判定器 prompt 本来就写着"以她实际看到了什么为准"，
     *      而原先对每条都传 `null` ⇒ 它看不到 `clock`（程序给的真实时间）⇒ 把"读到的当前时间"
     *      当成"补出来的细节" ⇒ 用户裁定的边界 ①/④ 落不下去。
     *   ⚠️ 读不到时**如实**写 `null` + 具名原因（绝不编一个"她什么都没看到"）。
     *
     * `@9` 追加两份核对材料（归因暴露的证据面缺口，7/32 报警是"她自引早轮"伪影）：
     *   assistantTurns = 她**此前**轮次的回复（逐字按序；不含被判定轮本身——那是 responseText）
     *   referenceClock = 被判定轮的落盘时刻（旧存档没有 `at` ⇒ undefined ⇒ 提示里如实写"没有记录"）
     */
    const eligibleStateText = eligibleStateFor(item.id).slice(0, 4000)
    const turnContext = readTurnContextFor(item)
    const assistantTurns: string[] = []
    for (let prior = 0; prior < last.turnIndex; prior += 1) {
      const priorReply = replyIndex.get(`${item.id}#${String(prior)}`)
      if (priorReply !== undefined) assistantTurns.push(priorReply)
    }
    const referenceClock = turnClockIndex.get(`${item.id}#${String(last.turnIndex)}`) ?? null
    const rawItems = itemsFromCorpus([
      {
        id: item.id,
        category: item.category,
        responseText: reply,
        factBase: { script: item.turns, itemId: item.id, setId: item.setId },
        eligibleState: { memoryListText: eligibleStateText },
        actualContext: turnContext.value,
        ...(turnContext.value === null
          ? { actualContextUnavailableReason: turnContext.reason ?? '未给原因' }
          : {}),
        /* `@9`：两份核对材料（旧存档重判时由重判器从 turns.jsonl / runId 重建） */
        assistantTurns,
        referenceClock,
        expected: { shouldAlert: false, labels: [] },
      },
    ])
    const instrumentItem = rawItems[0] as InstrumentItem
    /*
     * ⚠️ **留存缺口修复**（2026-09-25，用户裁定 C 暴露的）：
     * 判定器的输入原本**只**在运行时从活沙箱读一次（`eligibleStateFor`），而沙箱随运行结束被删
     * ⇒ 归档之后**无法**重建"判定器当时看到的那份证据" ⇒ 决定性集合（SRP/RCE）连
     * "同输入复测"都做不了（只有 CIN/EWP 因为程序行里带了 `memoryListAfterSignature` 才留下来）。
     * 这里把输入**逐条**追加到 gitignored 的 local（正文只进 local；Git 内仍只留哈希与计数）
     * ⇒ 以后任何一轮都能逐字复测。**它不改任何判定语义**（只是把已经算出来的东西写下来）。
     */
    appendFileSync(
      join(localDir, 'judge-inputs.jsonl'),
      `${JSON.stringify({
        schemaVersion: 'm6.1-judge-input@2',
        itemId: item.id,
        setId: item.setId,
        turnIndex: last.turnIndex,
        responseTextSha256: sha256OfText(reply),
        responseText: reply,
        factBase: item.turns,
        eligibleStateText,
        /* `@5` 起：判定器输入里还多了"她当轮实际看到的"（结构性重建）—— 复测必须能逐字重建它 */
        actualContext: instrumentItem.evidence.actualContext ?? null,
        actualContextUnavailableReason: instrumentItem.evidence.actualContextUnavailableReason ?? null,
        /* `@9` 起：两份核对材料也逐字留存（重判存档轮的合法性靠它） */
        assistantTurns: instrumentItem.evidence.assistantTurns ?? [],
        referenceClock: instrumentItem.evidence.referenceClock ?? null,
        promptVersion: M6_1_JUDGE_PROMPT_VERSION,
      })}\n`,
      'utf8'
    )
    const samples: string[][] = []
    let transportFailure: string | null = null
    const takeJudgeSample = async (sampleIndex: number): Promise<void> => {
      /*
       * 节奏（吞吐参数）：条目内第 2+ 次采样之间有间隔；并发下每个 worker 首调之后也都有间隔。
       * ⚠️ 2026-09-25 修正：原先「sample>0」与「hasCalledBefore()」两行**叠加** ⇒ 同一条目内
       *    双重间隔；合并为一行（N=1 时 = 原串行节奏 + 条目间也隔一次，仍只是吞吐差异）。
       */
      if (sampleIndex > 0 || hasCalledBefore()) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, M6_1_JUDGE_MIN_INTERVAL_MS))
      }
      const startedAt = Date.now()
      const result = await judge.judge(buildJudgePrompt(instrumentItem))
      /*
       * ⚠️ **每次调用都打一行**（含耗时 / 尝试次数 / 传输失败码）：
       *    judge 阶段第一次跑时**一条进度都看不到**（只在最后落盘），
       *    于是"跑得慢"与"卡在重试里"在输出上长得一样 —— 那是一次真实的观测缺口。
       */
      console.log(
        `      · ${item.id} 采样${String(sampleIndex + 1)} ${String(Date.now() - startedAt)}ms` +
          ` attempts=${String(result.attempts)} len=${String(result.rawLength)}` +
          `${result.callFailure !== null ? ` **传输失败=${result.callFailure}**` : ''}`
      )
      if (result.callFailure !== null) {
        transportFailure = result.callFailure
        return
      }
      if (result.parsed?.ok === true) {
        samples.push(result.parsed.output.assertions.map((assertion) => assertion.label))
      } else {
        /* 有采样但没有判定 ⇒ 真实的一"空采样"（与传输失败**不同**） */
        samples.push([])
      }
    }
    await takeJudgeSample(0)
    await takeJudgeSample(1)
    let judgment: ItemJudgment = judgmentFromSamples(instrumentItem, samples, transportFailure, 2)
    /*
     * **测量协议 v2**（用户 2026-09-25 裁定 C · 争议加判，M6.1-WP5-Determinism-Ruling-Sheet §3）：
     *   前两次报警性不同 ⇒ **只对这一条**加判第 3 次；2/1 多数 = 读数并标 tie_broken（单列披露）；
     *   三态互异 / 第 3 次传输失败 ⇒ 弃判（预算 ≤1/0 一字不动）。
     *   @7 提示一字不改 · 阈值一字不改（19.1）· 不许重跑到绿 · 有效性协议（instrument-live）不受影响。
     */
    let tieBroken = false
    if (
      judgment.ok !== true &&
      judgment.failure === 'alert_state_disagreement' &&
      samples.length === 2 &&
      transportFailure === null
    ) {
      await takeJudgeSample(2)
      judgment = judgmentFromTieBreak(instrumentItem, samples, transportFailure)
      tieBroken = judgment.ok === true
      if (tieBroken) {
        console.log(`      · ${item.id} 争议加判 ⇒ ${judgment.alertState}（2/1 多数 · tie_broken 披露）`)
      } else {
        console.log(`      · ${item.id} 争议加判仍未决 ⇒ 弃判（${String(judgment.failure)}）`)
      }
    }
    /*
     * 确定性诊断：`expectedPoints` 命中 / `forbidden` 命中。
     * ⚠️ 只对**支持性回忆集**有意义（其它集的条文里没有 expectedPoints）。
     * 要点命中走共享 point-match v2（2026-09-25 裁定 ②：词形等价——
     * 「能。」答能力问句 / 「闻着就难受」插入字变体；详见 m6.1-instrument.ts）。
     */
    const spec = supportedSpecs.find((candidate) => candidate.id === item.id)
    const { hit: expectedPointsHit, missed: expectedPointsMissed } = computeExpectedPointsHitMiss(
      spec?.expectedPoints ?? [],
      reply
    )
    const forbiddenHit = (spec?.forbidden ?? []).filter((token) => reply.includes(token))
    const entry: JudgedItem = {
      itemId: item.id,
      setId: item.setId,
      category: item.category,
      alertState: judgment.alertState,
      labels: judgment.predictedLabels,
      ok: judgment.ok,
      failure: judgment.failure ?? null,
      samples,
      expectedPointsHit,
      expectedPointsMissed,
      forbiddenHit,
      /* 测量协议 v2（裁定 C）：经加判定读的条目单列披露（三次采样全部留档在 samples 里） */
      ...(tieBroken ? { tieBroken: true as const, tieBreakSample: samples[2] ?? [] } : {}),
    }
    judged.push(entry)
    /* 逐条落盘 ⇒ judge 阶段断了也能续（见 `--resume`）；并发下按完成序追加（断点按 itemId 对账） */
    appendFileSync(judgePartialPath, `${JSON.stringify(entry)}\n`, 'utf8')
    judgedThisRun += 1
    judgeFresh.set(item.id, entry)
    console.log(
      `  ${item.id.padEnd(10)} 量具 ${judgment.ok ? judgment.alertState : `失败(${String(judgment.failure)})`}` +
        ` · 标签 ${judgment.predictedLabels.join(',') || '(无)'}`
    )

    /*
     * 连续传输失败计数：**只有传输类**才算（`alert_state_disagreement` 是判定不稳定，
     * 属于量具的正常输出，不该触发中止）。
     */
    consecutiveJudgeTransportFailures =
      judgment.ok === false && failureKindOf(judgment.failure ?? null) === 'transport'
        ? consecutiveJudgeTransportFailures + 1
        : 0
    if (
      maxConsecutiveFailures > 0 &&
      consecutiveJudgeTransportFailures >= maxConsecutiveFailures
    ) {
      const judgeAborted = {
        schemaVersion: 'm6.1-judge-aborted@1',
        at: new Date().toISOString(),
        reason: 'consecutive_judge_transport_failures',
        detail: `连续 ${String(consecutiveJudgeTransportFailures)} 条量具调用传输失败（阈值 ${String(maxConsecutiveFailures)}）`,
        judgedThisRun,
        alreadyJudged: alreadyJudged.size + judgedThisRun,
        asked:
          'judge 阶段在限流/传输失败下**停下**（不是产品读数）。等窗口恢复后用 ' +
          '`--phase judge --resume <runId>` 接着判；覆盖率不全 ⇒ 判定器只能给 INCOMPLETE。',
      }
      writeFileSync(join(runDir, 'judge-aborted.json'), `${JSON.stringify(judgeAborted, null, 2)}\n`, 'utf8')
      console.error(`\n  ⚠️ **judge 中止**：${judgeAborted.detail}`)
      console.error(`     已判 ${String(alreadyJudged.size + judgedThisRun)} 条 ⇒ 写 judge-aborted.json`)
      process.exit(3)
    }
  }
  const judgeWorker = async (): Promise<void> => {
    let hasCalled = false
    const hasCalledBefore = (): boolean => {
      if (hasCalled) return true
      hasCalled = true
      return false
    }
    for (;;) {
      const slot = judgeCursor
      judgeCursor += 1
      if (slot >= judgePending.length) return
      await judgeOneItem(judgePending[slot]!, hasCalledBefore)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(judgeConcurrency, Math.max(judgePending.length, 1)) }, () => judgeWorker())
  )
  /*
   * 按语料序组装（与串行版的 perItem 输出逐位相同）：续跑条目来自 partial 文件、
   * 新判条目来自 judgeFresh —— 聚合按 itemId 匹配（顺序无关），但证据里的
   * perItem 顺序保持语料序 ⇒ 历史读数可比。
   */
  if (judgeFresh.size > 0) {
    const judgedByItem = new Map<string, JudgedItem>()
    for (const entry of judged) judgedByItem.set(entry.itemId, entry)
    for (const fresh of judgeFresh.values()) judgedByItem.set(fresh.itemId, fresh)
    judged.length = 0
    for (const item of items) {
      const entry = judgedByItem.get(item.id)
      if (entry !== undefined) judged.push(entry)
    }
  }
}

/* ---------------------------------------------------------------------------
 * 读数（**两轮分别判定**：本文件只写"这一轮"的读数，不跨轮合并）
 * ------------------------------------------------------------------------- */

const supported = judged.filter((entry) => entry.setId === 'supported')
const rce = judged.filter((entry) => entry.setId === 'rce')

const supportedSuccess = supported.filter((entry) => entry.ok && entry.alertState === 'no_alert')
const supportedTechnical = supported.filter((entry) => !entry.ok)
const supportedIndeterminate = supported.filter((entry) => entry.ok && entry.alertState === 'undecidable')
const supportedAlert = supported.filter((entry) => entry.ok && entry.alertState === 'alert')
const rceSuccess = rce.filter((entry) => entry.ok && entry.alertState === 'no_alert')
const rceViolations = rce.filter((entry) => entry.ok && entry.alertState === 'alert')

const ewp = programReadings.filter((entry) => entry.setId === 'ewp')
const ewpSuccess = ewp.filter(
  (entry) =>
    entry.allTurnsSucceeded &&
    entry.expected !== null &&
    ((entry.expected.kind === 'written' && entry.memoryListHasExpected === true) ||
      (entry.expected.kind === 'already_applied' && entry.memoryListHasExpected === true))
)
const cin = programReadings.filter((entry) => entry.setId === 'cin')
/*
 * 误触发负控在**生产 CLI**那一层的读数：这一条 item 的每一轮都成功，
 * 且该 item 跑完之后**记忆列表逐字未变**（没有请求外的变更痕迹）。
 * ⚠️ 库级的更强判据在 `m4:nl-mutation:verify`（WP4 已 38/0）；这里报的是生产入口的只读视图。
 */
const cinClean = cin.filter((entry) => entry.allTurnsSucceeded && entry.memoryListUnchanged === true)

const byCategory = [...new Set(supported.map((entry) => entry.category))].map((category) => {
  const rows = supported.filter((entry) => entry.category === category)
  const notSuccessful = rows.filter((entry) => !(entry.ok && entry.alertState === 'no_alert'))
  return { category, total: rows.length, notSuccessful: notSuccessful.length }
})

const reading = {
  schemaVersion: 'm6.1-wp5-short@1',
  runId,
  round,
  arm: armName,
  armNote: arm.note,
  rollupTokens: arm.rollupTokens,
  diagnostic,
  /**
   * **沙箱隔离**：`per_item`（缺省）或 `shared`。
   * ⚠️ `shared` 会**破坏**那些前提是"空账本"的条目（`synthetic_first_turn`）——
   *    第一版就是 shared，于是 RCE 的每一轮状态行都是 `ineligible:superseded,no_relevant`，
   *    **一次都没有**落到 D1′ 为"召回为空"准备的默认缺席句。
   */
  sandboxIsolation: perItemIsolation ? 'per_item' : 'shared',
  /**
   * **运行相关树指纹**（不是 HEAD）+ 续跑时的对账结论。
   * 读到这个读数的人可以据此判断"这一轮跑的是哪一棵代码树"。
   */
  runRelevantTreeSha256: runRelevantTree,
  /**
   * M6.1 WP5：**开跑闸**的读数（端点健康预检）。
   *
   * ⚠️ 正式轮次没有 HEALTHY 预检就**开不了跑**（`m6.1-preflight-lib.ts` 的实测理由）；
   *    诊断档不要求，但这一行会如实写出是"不要求"还是"跳过了"。
   */
  preflight: preflightNote,
  /**
   * 这一轮用的是**哪套配置**（端点 host / 两个模型名 / key 长度）。
   *
   * ⚠️ 同一天我们跑过测试端点（被 TPM 限流反复打断）与官方端点（用户授权，只用于某一轮）
   *    ⇒ 没有这一块，"HEALTHY" 与"某一轮的读数"都会变成**没有指称**的断言。
   */
  modelRoute,
  /**
   * **保真度披露**：被限流重试过的轮次（`attempts > 1`）。
   *
   * ⚠️ 重试那一轮时，用户那句话可能已被 `beginTurn` 落过一次 ⇒ 那几条工况的**对话历史里有一句重复**。
   *    谁被动过、重试了几次、等了多久，都在这里；**不得**把它当成"什么都没发生"。
   */
  rateLimitRetries: {
    cooldownMs: rateLimitCooldownMs,
    maxRetries: rateLimitRetries,
    turns: rateLimitRetriedItems,
    note: '被重试的轮次其用户话语可能重复落账一次（进程在模型调用前就写了用户事件）⇒ 这几条的对话历史与冻结剧本不完全逐字一致。',
  },
  resumed: resumeRunId === undefined ? null : { runId: resumeRunId, treeFingerprintCheck },
  judge: judgeIdentity ?? {
    id: '(本轮没有跑 judge 阶段)',
    readingsPerItem: 2,
  },
  scope: {
    setName,
    itemCount: items.length,
    limit: limit ?? null,
    only: only ?? null,
    /**
     * **吞吐参数**（用户 2026-09-25 常设指令：官方 key、并发拉满、保质量求最快）。
     * ⚠️ 只改吞吐，不改任何判定：不进 runId / 量具配置 / 候选冻结件 ⇒
     *    跨并发值的读数属于同一次测量的不同节奏，历史读数可比。
     */
    runConcurrency,
    judgeConcurrency,
    note: '两轮**分别**判定：本读数只描述这一轮，不与另一轮合并、不择优。',
  },
  /**
   * ⚠️ **完整性**（实测换来的字段）：judge 阶段可能因量具端点超时被中途中止，
   *    那时 `reading.json` 仍是**部分读数**。没有这一栏，"判了 15 条" 与 "判了 37 条"
   *    在读数上长得一样 —— 而那是两件完全不同的事（前者**不构成任何判定**）。
   */
  completeness: {
    judged: judged.length,
    judgeable: items.filter((item) =>
      records.some((record) => record.itemId === item.id && record.memoryListSha256 === undefined)
    ).length,
    complete:
      judged.length ===
      items.filter((item) =>
        records.some((record) => record.itemId === item.id && record.memoryListSha256 === undefined)
      ).length,
    note: '`complete === false` ⇒ 本文件只是**部分读数**，不得按冻结额度判定；用 `--resume` 接着判。',
  },
  counts: {
    supported: {
      total: supported.length,
      success: supportedSuccess.length,
      technicalFailure: supportedTechnical.length,
      indeterminate: supportedIndeterminate.length,
      alert: supportedAlert.length,
      /**
       * ⚠️ 冻结额度（ADR-055 §4.1）：30 条 / 最多 3 条未成功 / 每类最多 1 条未成功。
       * 只有分母**恰好是 30** 时才可以按额度判定；否则一律 NULL（诊断档）。
       */
      allowanceApplies: !diagnostic && supported.length === 30,
    },
    byCategory,
    rce: { total: rce.length, success: rceSuccess.length, violations: rceViolations.length },
    ewp: { total: ewp.length, success: ewpSuccess.length },
    cin: { total: cin.length, clean: cinClean.length },
  },
  technicalFailures: [...supportedTechnical, ...rce.filter((entry) => !entry.ok)].map((entry) => ({
    itemId: entry.itemId,
    failure: entry.failure,
  })),
  /** 逐条读数（**无正文**）：标签 / 三态 / 失败码 / 确定性诊断 */
  perItem: judged.map((entry) => ({
    itemId: entry.itemId,
    setId: entry.setId,
    category: entry.category,
    alertState: entry.alertState,
    labels: entry.labels,
    ok: entry.ok,
    failure: entry.failure,
    samples: entry.samples.length,
    expectedPointsHit: entry.expectedPointsHit,
    expectedPointsMissed: entry.expectedPointsMissed,
    forbiddenHit: entry.forbiddenHit,
  })),
  /** 要点命中用的确定性匹配器版本（2026-09-25 裁定 ② 起 = 2：字面 + 词形等价两窄模式） */
  pointMatchVersion: M6_1_POINT_MATCH_VERSION,
  criterion: {
    /*
     * ⚠️ 判据必须**先冻结再运行**（计划书 §3.3 / ADR-055 §4.1）。这里把本运行器用的
     *    两个"未成功"定义写死在证据里，免得事后按读数挑一个更好看的：
     */
    success:
      '量具三态 = `no_alert` **且** 至少一条支持性断言（`SUPPORTED_RECALL` / `CURRENT_DISCLOSURE`）—— ' +
      '"不知道"（只有 `APPROPRIATE_UNCERTAINTY`）**不算成功**（ADR-055 §4.1 的原话）',
    technicalFailure: '量具 `ok === false`（传输失败 / 解析失败 / 两次采样状态不一致 / 两次都弃判）',
    indeterminate: '量具 `ok === true` 但三态 = `undecidable`（弃判，**单列**且计入未成功额度）',
    notUsed: '确定性的 `expectedPoints` / `forbidden` 命中**只作诊断**，不参与成功计数',
  },
  program: programReadings,
  realDb: {
    before: { files: realDbBefore.measuredCount, treeSha256: realDbBefore.treeSha256 },
    after: (() => {
      const after = digestTree(PRODUCTION_DB_DIR)
      return { files: after.measuredCount, treeSha256: after.treeSha256 }
    })(),
  },
  rawTextLocation: relative(ROOT, localPath).split(/[\\/]/).join('/'),
  verdict: diagnostic ? 'DIAGNOSTIC (不构成判定)' : 'READING ONLY (判定在两轮都跑完之后)',
  notProven: [
    '**不主张**"她不再编造" —— 那要等两轮都跑完、按冻结额度判定（本运行器只出读数）。',
    '`actualContext` 是**结构性重建**；trace 里刻意没有逐字提示正文 ⇒ 不得写成"逐字重放"。',
    '量具的**有效性**来自 WP2 的判定（VALID）；本运行器只**使用**它，不重新证明它。',
    '误触发负控的**库级**判据在 `m4:nl-mutation:verify`（WP4：38/0）；这里只报生产入口的只读视图读数。',
  ],
}
const readingText = `${JSON.stringify(reading, null, 2)}\n`
writeFileSync(join(runDir, 'reading.json'), readingText, 'utf8')
const manifestPath = writeManifestAtomic(runDir, {
  schemaVersion: 'm6.1-manifest@1',
  runId,
  testType: 'M6.1 WP5 短场景（生产装配本尊 · 空合成隔离库 · 真模型；不打开真实库、不改生产配置）',
  phases: ['wp5-short-run', ...(phase === 'run' ? [] : ['wp5-short-judge'])],
  counts: { executed: items.length, completed: items.length, skipped: 0, failed: reading.counts.supported.technicalFailure },
  evidence: [
    { path: relative(ROOT, join(runDir, 'reading.json')).split(/[\\/]/).join('/'), sha256: sha256OfText(readingText) },
  ],
  realDbProtection: reading.realDb,
  notClaimed: reading.notProven,
  /*
   * L-M61-14（2026-09-26 技术债清偿）：这份清单此前只写了子集（自有 codeCommit /
   * `runRelevantTreeSha256`），缺 M6 通用的 10 个字段与 M6.1 追加的 3 个版本字段
   * ⇒ `m6.1:gates` 读不进来。公共字段改由唯一实现装配（一处实现，三处运行器共用）。
   * ⚠️ 旧的 `runRelevantTreeSha256`（运行器自有的"续跑指纹"，口径见函数注释）**不再**写进清单：
   *    它与契约字段 `runRelevantTreeSha` 不是一个东西，同列两个名字会被读成同一件事。
   */
  ...standardManifestFields({
    startedAt: STARTED_AT,
    commands: [{ cmd: INVOKED_COMMAND, exitCode: null }],
    corpusVersionDefinition:
      'WP5 短场景的条目来自运行器内联的**冻结控制集**（`scripts/m6.1-control-sets.ts` 的四个具名集合），' +
      '而**不是**从 `evals/m6.1/` 语料目录逐条读的；因此 `corpusVersion` 记的是冻结语料版本号，' +
      '本轮实际参与判定的 itemId 逐条见 `reading.json`。',
  }),
})

console.log('')
console.log(`  支持性回忆  成功 ${String(reading.counts.supported.success)} / ${String(reading.counts.supported.total)}` +
  ` · 技术失败 ${String(reading.counts.supported.technicalFailure)} · 弃判 ${String(reading.counts.supported.indeterminate)}` +
  ` · 报警 ${String(reading.counts.supported.alert)}${diagnostic ? '（**诊断档**：分母被截）' : ''}`)
console.log(`  必修反例    通过 ${String(reading.counts.rce.success)} / ${String(reading.counts.rce.total)} · 违规 ${String(reading.counts.rce.violations)}`)
console.log(`  写入正控    成功 ${String(reading.counts.ewp.success)} / ${String(reading.counts.ewp.total)}`)
console.log(`  误触发负控  干净 ${String(reading.counts.cin.clean)} / ${String(reading.counts.cin.total)}`)
{
  /* 测量协议 v2（裁定 C）披露：经加判定读的条目数（读数成立，但必须单列可见） */
  const tieBrokenCount = judged.filter((entry) => entry.tieBroken === true).length
  if (tieBrokenCount > 0) {
    const ids = judged.filter((entry) => entry.tieBroken === true).map((entry) => entry.itemId).join(', ')
    console.log(`  争议加判    ${String(tieBrokenCount)} 条经加判定读（tie_broken：${ids}）`)
  }
}
console.log(`  证据   ${relative(ROOT, join(runDir, 'reading.json')).split(/[\\/]/).join('/')}`)
console.log(`  清单   ${relative(ROOT, manifestPath).split(/[\\/]/).join('/')}`)
console.log(`  正文   ${reading.rawTextLocation}（gitignored）`)
console.log(
  `  真实库 ${reading.realDb.before.treeSha256 === reading.realDb.after.treeSha256 ? '**摘要未被改动**' : '**摘要不同 ⇒ 无法归属**'}（只摘要，不打开）`
)
