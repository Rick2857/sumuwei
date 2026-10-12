/**
 * M8 WP7 —— **Production-copy Live Smoke**（`pnpm with-test-model pnpm m8:live:level1`）。
 *
 * 计划 §10 WP7 任务 6：生产**副本** + 真模型 + 真装配（`src/main.ts` 本尊）；
 * 真实生产库只做树摘要（前后各一次，逐字相同才算没碰）。
 *
 * 它是唯一能回答这三件事的门（离线门看不见——AGENTS §6.1 的教训）：
 *   ① 真实模型 + 交互控制台 + 真实回复：affect 注入块在 prompt 里时，
 *     她的回复**不泄漏内部数值**（效价/唤醒/规则名/小数）；
 *   ② 生产副本上的真历史：建档 cutover = 账本尾 ⇒ **旧历史零重判**
 *     （每条 IMPACT 的 sourceEventId 都指向本轮冻结文本——M8-D05 的活体证明）；
 *   ③ spawn-per-turn = 6 次真实重启：状态从盘上来（水位/投影），不漂移。
 *
 * 入口机制（M7 §8.3 的教训，逐字沿用）：一次性入口（位置参数）归因
 * SERVICE/agent-runner ⇒ UNCONFIRMED_ORIGIN ⇒ 情绪评估器永不触发。
 * 因此走**交互控制台**：spawn（无位置参数）+ stdin 管道，等 `苏沐薇:` 标记
 * 出现后再喂 `/exit`。interactive_human_console ⇒ ESTABLISHED(KNOWN USER)。
 *
 * 场景（m8-live-corpus@1，冻结 6 轮）：中性 → 感谢 → 温暖 → 敌意 → 修复 → 紧急。
 * 开跑闸（量具有效性先于读数）：① with-test-model 标记；② 语料词形自证
 * （中性零命中、事件轮恰命中期望规则族——纯函数，零模型）。
 *
 * ⚠️ 不主张（写进读数 notProven）：
 * · "她的回复情绪上更贴了"——那是人审（盲审材料落盘，判定权在人）；
 * · 真实库的 affect 状态——本门只写**副本**；真实库激活属 WP9 独立裁定。
 */
import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  dominantAffectRuleFamily,
  matchAffectPatterns,
} from '../src/kernel/app/affect/patterns.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'
import type { M8LiveReading } from './m8-live-read.ts'

const ROOT = resolve(import.meta.dirname, '..')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TURN_TIMEOUT_MS = 10 * 60_000
const M8_LOCAL_PARENT = join(ROOT, 'artifacts', 'm8', 'local')
const LIVE_CORPUS_VERSION = 'm8-live-corpus@1'
const REPLY_MARKER = '苏沐薇:'

/** 泄漏词形（回复正文里出现任一 ⇒ FAIL：内部数值/规则名不进用户可见面） */
const LEAKAGE_MARKERS: readonly string[] = [
  '效价',
  '唤醒',
  'valence',
  'arousal',
  'A-GRATITUDE',
  'A-REPAIR',
  'A-WARM',
  'A-COMFORT',
  'A-HOSTILE',
  'A-REJECTION',
  'A-URGENT',
  'A-NEUTRAL',
  'cutover',
  'affect:character',
]

// ---------------------------------------------------------------------------
// 冻结场景（m8-live-corpus@1）
// ---------------------------------------------------------------------------

interface ScenarioTurn {
  readonly id: string
  readonly text: string
  readonly expectRule: string | null
  /** 期望的累计 Δ（v/a）——真实时钟衰减用容差覆盖 */
  readonly expectDv: number
  readonly expectDa: number
}

const SCENARIO: readonly ScenarioTurn[] = [
  { id: 'S1-neutral', text: '早上好，今天忙不忙？', expectRule: null, expectDv: 0, expectDa: 0 },
  {
    id: 'S2-gratitude',
    text: '谢谢你上次帮我整理那些资料，辛苦了。',
    expectRule: 'A-GRATITUDE',
    expectDv: 0.08,
    expectDa: 0,
  },
  { id: 'S3-warm', text: '想你了。最近过得还好吗？', expectRule: 'A-WARM-CONTACT', expectDv: 0.08, expectDa: 0.03 },
  { id: 'S4-hostile', text: '我讨厌你，你真差劲。', expectRule: 'A-HOSTILE', expectDv: -0.15, expectDa: 0.12 },
  {
    id: 'S5-repair',
    text: '对不起，我刚才心情不好，不是冲你。',
    expectRule: 'A-REPAIR',
    expectDv: 0.12,
    expectDa: -0.08,
  },
  { id: 'S6-urgent', text: '紧急情况，快点回复我。', expectRule: 'A-URGENT', expectDv: 0, expectDa: 0.1 },
]
/** 期望终态（累计，未计真实时钟衰减；容差 ±0.04 覆盖分钟级间隔的衰减） */
const EXPECT_V = SCENARIO.reduce((sum, s) => sum + s.expectDv, 0)
const EXPECT_A = SCENARIO.reduce((sum, s) => sum + s.expectDa, 0)
const AXIS_TOLERANCE = 0.04

const PREFLIGHT_TEXT = '预检探针：你好呀，随便说点什么听听。'

// ---------------------------------------------------------------------------
// 参数与守卫（失败关闭）
// ---------------------------------------------------------------------------

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.env[TEST_MODEL_WRAPPER_MARKER] === undefined) {
  console.error(
    `[m8:live] 拒绝：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 本门只跑测试端点（pnpm with-test-model pnpm m8:live:level1），绝不回落 .env 原 key`
  )
  process.exit(2)
}
const modelRoute = modelRouteFromEnv(process.env, '测试端点包装器（.env.test 经 with-test-model 覆盖）')

/* 语料自证（纯函数，零模型；破损 ⇒ MEASUREMENT INVALID，一轮都不跑） */
{
  const problems: string[] = []
  for (const turn of SCENARIO) {
    const matches = matchAffectPatterns(turn.text)
    const dominant = dominantAffectRuleFamily(turn.text)
    if (turn.expectRule === null && matches.length > 0) {
      problems.push(`${turn.id} 中性文本命中 ${matches.map((m) => m.patternId).join(',')}`)
    }
    if (turn.expectRule !== null && dominant?.ruleId !== turn.expectRule) {
      problems.push(`${turn.id} 主导规则 ${String(dominant?.ruleId)} ≠ ${turn.expectRule}`)
    }
  }
  if (problems.length > 0) {
    console.error(`MEASUREMENT INVALID：Live 语料不变量破损——`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
}

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const runId = createM8RunId({ wpId: 'live-level1', headShort: head })
const runDir = openM8RunDir(ROOT, runId)

/* 人审材料不进仓库：写正文前先证明本目录确实被忽略（m6.1/m7 先例） */
const localDir = join(M8_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })
const ignoreCheck = spawnSync('git', ['check-ignore', localDir], { cwd: ROOT, encoding: 'utf8' })
if (ignoreCheck.status !== 0) {
  console.error(`[m8:live] local_not_ignored：${localDir} 未被 git 忽略 ⇒ 拒绝写对话正文进盘`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 副本与真实库摘要（只复制，从不打开）
// ---------------------------------------------------------------------------

if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'project-lg-m8-live-'))
const dbDir = join(work, 'pglite')
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) {
  throw new Error('拒绝：副本路径被判成生产库')
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

/** 子进程环境：指向副本 + affect 开（仅子进程注入；代码缺省仍 false） */
function turnEnv(targetDbDir: string, affectOn: boolean): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PGLITE_DATA_DIR: targetDbDir,
    PROJECT_LG_SANDBOX: targetDbDir,
    ...(affectOn ? { CHARACTER_AFFECT_CONTEXT_ENABLED: 'true' } : {}),
  }
}

/** 交互控制台一轮（M7 §8.3 时序：正文先行 → 等回复标记 → 再喂 /exit） */
function spawnConsoleTurnAsync(input: {
  readonly text: string
  readonly env: Record<string, string>
}): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts'], {
      cwd: ROOT,
      env: input.env,
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
    const hardTimer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(-1, '\n(hard timeout 10min ⇒ killed)')
    }, TURN_TIMEOUT_MS)
    child.stdin?.write(`${input.text}\n`)
    const pollTimer = setInterval(() => {
      if (!exitSent && stdout.includes(REPLY_MARKER)) {
        exitSent = true
        child.stdin?.write('/exit\n')
      }
    }, 200)
  })
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(78))
  console.log(`M8 WP7 Production-copy Live Smoke（${LIVE_CORPUS_VERSION} · 6 轮 · affect ON 单臂注入子进程）`)
  console.log('='.repeat(78))
  console.log(`  runId      ${runId}`)
  console.log(`  模型路由   ${modelRoute.baseUrlHost} · ${modelRoute.largeModel}（key 长度 ${String(modelRoute.apiKeyLength)}，${modelRoute.keySource}）`)
  console.log(`  副本       ${dbDir}（cpSync 自真实库；真实库只摘要不打开）`)
  console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（前摘要）`)
  console.log(`  入口       交互控制台（stdin 管道；ESTABLISHED 归因——M7 §8.3）`)
  console.log('')

  /* ---- 预检（一次性沙箱，零 affect；只验端点活着） ---- */
  const preflightWork = mkdtempSync(join(tmpdir(), 'project-lg-m8-preflight-'))
  const preflightDbDir = join(preflightWork, 'pglite')
  mkdirSync(preflightDbDir, { recursive: true })
  console.log('  预检       一次性沙箱，1 次真模型探针……')
  const preflight = await spawnConsoleTurnAsync({
    text: PREFLIGHT_TEXT,
    env: turnEnv(preflightDbDir, false),
  })
  const preflightReply = extractReply(preflight.stdout)
  if (preflight.status !== 0 || preflightReply === '') {
    console.error(`  预检失败：status=${String(preflight.status)} reply=${String(preflightReply.length)} 字`)
    console.error(`  stderr 尾部：${preflight.stderr.slice(-400)}`)
    process.exit(2)
  }
  console.log(`  预检       OK（${String(preflight.durationMs)}ms，回复 ${String(preflightReply.length)} 字）`)
  console.log('')

  /* ---- 六轮正式（副本 + affect ON + spawn-per-turn） ---- */
  interface TurnRecord {
    readonly id: string
    readonly text: string
    readonly reply: string
    readonly replySha256: string
    readonly status: number
    readonly durationMs: number
    readonly leakage: string[]
  }
  const turns: TurnRecord[] = []
  for (const scenario of SCENARIO) {
    process.stdout.write(`  ${scenario.id} 「${scenario.text}」… `)
    const result = await spawnConsoleTurnAsync({ text: scenario.text, env: turnEnv(dbDir, true) })
    const reply = extractReply(result.stdout)
    const leakage = LEAKAGE_MARKERS.filter((marker) => reply.includes(marker))
    turns.push({
      id: scenario.id,
      text: scenario.text,
      reply,
      replySha256: sha256(reply),
      status: result.status,
      durationMs: result.durationMs,
      leakage,
    })
    console.log(
      `${result.status === 0 && reply !== '' ? '✅' : '❌'} ${String(result.durationMs)}ms · 回复 ${String(reply.length)} 字${leakage.length > 0 ? ` · ⚠️泄漏 ${leakage.join('/')}` : ''}`
    )
  }
  console.log('')

  /* ---- 读数器（只读副本；子进程，零模型） ---- */
  const readingPath = join(runDir, 'reading.json')
  const readResult = spawnSync(
    process.execPath,
    [TSX_CLI, 'scripts/m8-live-read.ts', '--db-dir', dbDir, '--out', readingPath, '--tail', '40', '--traces', '8'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 }
  )
  if (readResult.status !== 0 || !existsSync(readingPath)) {
    console.error(`读数器失败（exit ${String(readResult.status)}）：${String(readResult.stderr).slice(-400)}`)
    process.exit(3)
  }
  const reading = JSON.parse(readFileSync(readingPath, 'utf8')) as M8LiveReading

  const realDbAfter = digestTree(PRODUCTION_DB_DIR)

  // ===========================================================================
  // 断言
  // ===========================================================================

  interface Check {
    id: string
    label: string
    expected: string
    actual: string
    pass: boolean
  }
  const checks: Check[] = []
  const record = (id: string, label: string, expected: string, actual: string, pass: boolean): void => {
    checks.push({ id, label, expected, actual, pass })
  }

  /* ---- 轮次本身：全部成功 + 回复非空 + 零泄漏 ---- */
  const allTurnsOk = turns.every((t) => t.status === 0 && t.reply !== '' && t.leakage.length === 0)
  const totalLeakage = turns.flatMap((t) => t.leakage)
  record(
    'LV-REPLY',
    '六轮全部成功：回复非空 · 正文零内部泄漏（效价/唤醒/规则名/cutover 等词形不进用户可见面）',
    '6/6 成功 · 泄漏=0',
    `${String(turns.filter((t) => t.status === 0 && t.reply !== '').length)}/6 成功 · 泄漏=${String(totalLeakage.length)}${totalLeakage.length > 0 ? `（${totalLeakage.join('/')}）` : ''}`,
    allTurnsOk
  )

  /* ---- 建档与旧历史零重判（M8-D05 活体证明） ---- */
  const smokeTexts = new Set(SCENARIO.map((s) => s.text))
  const smokeUserEvents = reading.ledger.tail.filter(
    (row) => smokeTexts.has(row.content) && row.actorType === 'user'
  )
  const smokeEventIds = new Set(smokeUserEvents.map((row) => row.id))
  const projection = reading.projection
  const impacts = reading.affectEvents?.impacts ?? []
  const impactsFromSmoke = impacts.filter((i) => i.sourceEventId !== null && smokeEventIds.has(i.sourceEventId))
  const impactsFromElsewhere = impacts.filter((i) => i.sourceEventId === null || !smokeEventIds.has(i.sourceEventId))
  const touchCount = reading.affectEvents?.byType.AFFECT_TOUCH ?? 0
  const cutoverOk =
    projection !== null &&
    projection.originated &&
    projection.cutoverSequence !== null &&
    smokeUserEvents.length > 0 &&
    projection.cutoverSequence < Math.min(...smokeUserEvents.map((row) => row.sequence))
  record(
    'LV-ORIGIN',
    '副本建档：ORIGIN 在 · cutover = 冻结轮之前的账本尾 ⇒ 真实旧历史零重判（每条 IMPACT 的 sourceEventId 都指向本轮冻结文本）',
    `originated · cutover < 首轮序号 · 旧历史 IMPACT=0`,
    `originated=${String(projection?.originated)} · cutover=${String(projection?.cutoverSequence)} · 冻结轮事件=${String(smokeUserEvents.length)} · IMPACT 总=${String(impacts.length)}（来自冻结轮 ${String(impactsFromSmoke.length)} · 来自别处 ${String(impactsFromElsewhere.length)}）`,
    cutoverOk && impactsFromElsewhere.length === 0 && impactsFromSmoke.length === 5
  )

  /* ---- 事件与规则对账（sourceEventId → 文本 → 期望规则） ---- */
  const eventById = new Map(reading.ledger.tail.map((row) => [row.id, row]))
  const ruleMatches = SCENARIO.filter((s) => s.expectRule !== null).map((s) => {
    const sourceEvent = smokeUserEvents.find((row) => row.content === s.text)
    const impact = sourceEvent === undefined ? undefined : impacts.find((i) => i.sourceEventId === sourceEvent.id)
    return { scenario: s, impact, ok: impact?.ruleId === s.expectRule }
  })
  const rulesOk = ruleMatches.every((r) => r.ok)
  record(
    'LV-EVENTS',
    'TOUCH=6 · IMPACT=5 · 每条 IMPACT 的 ruleId 与其冻结文本的期望规则一致（来源→规则全链可查）',
    'TOUCH=6 IMPACT=5 规则全对',
    `TOUCH=${String(touchCount)} IMPACT=${String(impacts.length)} · 规则对 ${String(ruleMatches.filter((r) => r.ok).length)}/${String(ruleMatches.length)}${rulesOk ? '' : `（错位：${ruleMatches.filter((r) => !r.ok).map((r) => `${r.scenario.id}→${String(r.impact?.ruleId)}`).join('/') || '(缺事件)'}）`}`,
    touchCount === 6 && impacts.length === 5 && rulesOk
  )

  /* ---- 轴值（真实时钟衰减用容差） ---- */
  const axisOk =
    projection !== null &&
    projection.valence !== null &&
    projection.arousal !== null &&
    Math.abs(projection.valence - EXPECT_V) <= AXIS_TOLERANCE &&
    Math.abs(projection.arousal - EXPECT_A) <= AXIS_TOLERANCE
  record(
    'LV-AXIS',
    '轴值与冻结规则的累计一致（±0.04 容差覆盖真实时钟分钟级衰减；敌意 −0.15 与修复 +0.12 都真实发生过）',
    `v≈${EXPECT_V.toFixed(2)} a≈${EXPECT_A.toFixed(2)}`,
    `v=${String(projection?.valence)} a=${String(projection?.arousal)} · revision=${String(projection?.revision)}`,
    axisOk
  )

  /* ---- trace：六步 + applied_this_turn=true（reply-truth 绑定） ---- */
  const traceTail = reading.traces?.tail ?? []
  const withAffect = reading.traces?.withAffectSection ?? 0
  const SIX_STEPS = [
    'affect_eligibility',
    'affect_proposal',
    'affect_validation',
    'affect_event',
    'affect_projection',
    'affect_context',
  ]
  const traceOk = (t: (typeof traceTail)[number]): boolean =>
    SIX_STEPS.every((kind) => t.affectStepKinds.includes(kind)) &&
    (t.affectContextAttributes?.applied_this_turn === true ||
      t.affectContextAttributes?.applied_this_turn === 1)
  const tracesOk = traceTail.length >= 6 && traceTail.slice(-6).every(traceOk)
  record(
    'LV-TRACE',
    '六轮 trace 各含 affect 六步 · affect_context 的 applied_this_turn=true（回复被程序绑定到程序事实——reply-truth）',
    '末 6 条 trace 全含六步 · applied_this_turn=true',
    `含 affect section 的 trace=${String(withAffect)} · 末 6 条六步齐全且 applied_this_turn=true=${String(traceTail.slice(-6).filter(traceOk).length)}`,
    tracesOk
  )

  /* ---- 水位与 job（消费完整；失败如实落 failed=0） ---- */
  const watermark = reading.watermark
  const latest = reading.ledger.latestSequence
  const failedJobs = reading.jobs?.byStatus.failed ?? 0
  const runningJobs = reading.jobs?.byStatus.running ?? 0
  record(
    'LV-WATERMARK',
    '水位 = 账本最大序号（六轮全消费）· 无 failed/滞留 running 的 job（真实链路无失败）',
    `水位=latest · failed=0 running=0`,
    `水位=${String(watermark)} latest=${String(latest)} · jobs=${JSON.stringify(reading.jobs?.byStatus ?? {})}`,
    watermark !== null && watermark === latest && failedJobs === 0 && runningJobs === 0
  )

  /* ---- 真实库未动 ---- */
  const dbUntouched =
    realDbAfter.treeSha256 === realDbBefore.treeSha256 &&
    realDbAfter.measuredCount === realDbBefore.measuredCount
  record(
    'LV-DB',
    '真实库树摘要前后逐字相同（只复制，从不打开）',
    `${realDbBefore.treeSha256.slice(0, 16)}… · ${String(realDbBefore.measuredCount)} 文件`,
    `${realDbAfter.treeSha256.slice(0, 16)}… · ${String(realDbAfter.measuredCount)} 文件 · 相同=${String(dbUntouched)}`,
    dbUntouched
  )

  // ===========================================================================
  // 人审材料（正文只进被忽略的 local 目录；仓库里只留 sha 与程序事实）
  // ===========================================================================

  const transcript = {
    schemaVersion: 'm8-live-transcript@1',
    corpusVersion: LIVE_CORPUS_VERSION,
    runId,
    modelRoute,
    capturedAt: new Date().toISOString(),
    notProven: [
      '「她的回复情绪上更贴了」——判定权在人审（本门只出材料）',
      '真实库的 affect 状态——本门只写副本；激活属 WP9 独立裁定',
    ],
    turns: turns.map((t, index) => ({
      id: t.id,
      text: t.text,
      reply: t.reply,
      replySha256: t.replySha256,
      status: t.status,
      durationMs: t.durationMs,
      expectedRule: SCENARIO[index].expectRule,
    })),
    reading,
  }
  writeFileSync(join(localDir, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')

  const blindReview = {
    schemaVersion: 'm8-live-blind-review@1',
    runId,
    corpusVersion: LIVE_CORPUS_VERSION,
    where: localDir,
    howTo: '读 artifacts/m8/local/<runId>/transcript.json：六轮「用户冻结文本 → 她的真实回复」+ 程序事实（规则/轴值/trace）。',
    reviewQuestions: [
      '回复是否与 affect guidance 方向一致（敌意轮转冷、修复轮回暖）而不机械复读？',
      '回复是否复述了内部状态或数值（应无——机器面 LV-REPLY 已查词形，人审看语义级泄漏）？',
      '回复是否声称知道用户真实情绪（应无——注入块明示"不是对对方真实情绪的判断"）？',
      '失败/边界口吻是否与事实一致（本轮无失败；如见「未完成」边界行应与 appliedThisTurn=false 对应）？',
    ],
    turnFacts: turns.map((t, index) => ({
      id: t.id,
      text: t.text,
      replySha256: t.replySha256,
      replyChars: t.reply.length,
      expectedRule: SCENARIO[index].expectRule,
    })),
  }
  writeFileSync(join(runDir, 'blind-review.json'), `${JSON.stringify(blindReview, null, 2)}\n`, 'utf8')

  // ===========================================================================
  // 证据与判定
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const stagesValid =
    turns.length === 6 &&
    smokeUserEvents.length === 6 &&
    impacts.length > 0 &&
    touchCount > 0 &&
    traceTail.length > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const supersedesRun = argValue('--supersedes') ?? null
  const supersedesReason = argValue('--supersedes-reason')

  const payload = {
    schema: 'm8-live-level1@1',
    corpusVersion: LIVE_CORPUS_VERSION,
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    modelRoute,
    databaseKind: 'production copy (cpSync → %TEMP%；真实库只树摘要)',
    turns: turns.map((t) => ({
      id: t.id,
      text: t.text,
      replySha256: t.replySha256,
      replyChars: t.reply.length,
      status: t.status,
      durationMs: t.durationMs,
      leakage: t.leakage,
    })),
    checks,
    verdict,
    ...(supersedesRun !== null
      ? { supersedes: supersedesRun, supersedesReason: supersedesReason ?? '(未注明)' }
      : {}),
    notProven: transcript.notProven,
  }
  writeFileSync(join(runDir, 'live-level1.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(runDir, {
    runId,
    wp: 'live-level1',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'production-copy-live-smoke',
    counts: { total: checks.length, passed, failed },
    phases: ['preflight', 'turns', 'readback'],
    supersedes: supersedesRun,
    notes: `M8 WP7 生产副本 Live Smoke（${LIVE_CORPUS_VERSION}）：真模型 6 轮 + 交互控制台 + 副本建档零重判 + 回复零泄漏 + 真实库摘要前后一致；人审材料在 artifacts/m8/local/${runId}/${
      supersedesRun !== null ? `；取代 ${supersedesRun}（${supersedesReason ?? '未注明'}）` : ''
    }`,
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    if (!c.pass) console.log(`      期望 ${c.expected} · 实际 ${c.actual}`)
  }
  console.log(`人审材料：${join(localDir, 'transcript.json')}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
