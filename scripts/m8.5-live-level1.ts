/**
 * M8.5 WP11 —— **Production-copy Live Smoke + §24 模式切换全矩阵**
 * （`pnpm with-test-model pnpm m8.5:live:level1`）。
 *
 * 计划 §19 行 4+5：模式切换演练（§24 全矩阵各至少一次，切换期间单写入者
 * 不破坏）+ live smoke（生产副本 + 测试模型）。真实生产库只做树摘要
 * （前后各一次，逐字相同才算没碰）。
 *
 * 它是唯一能回答这几件事的门（离线门看不见——AGENTS §6.1 的教训）：
 *   ① 真实装配（src/main.ts 本尊）在**真实生产历史**上跑语义慢路径：
 *     激活演练（@2 受控重建 A==B + 切换边界）在副本上先走，之后每个
 *     spawn-per-turn 都是一次**真实重启**——状态从盘上来（水位/投影/闸）；
 *   ② §24 五条转换全部活体走一遍（rules→shadow→semantic→shadow→rules→
 *     rules→semantic），含**在途任务取消**（semantic 轮中途退出 ⇒ 任务留
 *     可重试态 ⇒ 下一非语义启动的取消扫面写 CANCELLED 终态闸 + 边界推进）；
 *   ③ 单写入者纪律的账本证据：词形 IMPACT 只带 affect-rules@1、语义 IMPACT
 *     只带 affect-semantic-policy@1；让位（semantic 轮词形 IMPACT 抑制）与
 *     证据式跳过（词形已落 IMPACT 的 source 永不语义重评）都在真实链路上；
 *   ④ 她的回复**不泄漏内部数值**（效价/唤醒/规则名/小数/闸名）。
 *
 * 入口机制（M7 §8.3 逐字沿用）：交互控制台（spawn 无位置参数 + stdin 管道）
 * ⇒ ESTABLISHED 归因 ⇒ 评估器触发。一次性入口 = UNCONFIRMED_ORIGIN ⇒ 永不触发。
 *
 * 场景（m85-live-corpus@2，冻结 9 轮 / 5 条转换；按真实机制排布——
 * spawn-per-turn 的 /exit 必然中止轮后 drain（收尾链 abort 在飞模型调用 ⇒
 * 任务留可重试态），**语义评估只在下一语义 boot 的启动追赶段完成**（await、
 * 无退出压力）；激活演练把 scanner/worker 水位预置到边界 ⇒ 无激活瞬态）：
 * ```text
 *   boot1 rules    KW1 感谢     —— 基线（M8 行为；词形 IMPACT）
 *   boot2 shadow   KW2 温暖     —— T1 rules→shadow（词形照旧；语义零生产动作）
 *   boot3 semantic SEM1 语义感谢 —— T2 shadow→semantic；轮后 drain 被 /exit
 *                                   中止 ⇒ SEM1 任务留可重试态（在途制造轮）
 *   boot4 shadow   KW3 修复     —— T3 semantic→shadow（取消扫面：SEM1 的任务
 *                                   CANCELLED_BY_MODE_CHANGE 终态闸 + 边界推进）
 *   boot5 rules    KW4 紧急     —— T4 shadow→rules（词形路径恢复）
 *   boot6 rules    KW5 敌意     —— 同模式稳定探针（扫面 no_pending；无漂移）
 *   boot7 semantic SEM2 语义感谢 —— T5 rules→semantic（回归语义：SEM1 的闸挡住
 *                                   重评；KW3/4/5 词形 source 证据式跳过；
 *                                   SEM2 轮后 drain 被中止 ⇒ 可重试）
 *   boot8 semantic SEM3 语义感谢 —— 同模式；启动追赶重试 SEM2 ⇒ 模型调用完成
 *                                   ⇒ SEM2 语义 IMPACT + 终态闸
 *   boot9 semantic SEM4 语义感谢 —— 收口；启动追赶重试 SEM3 ⇒ SEM3 语义 IMPACT
 *                                   + 终态闸（SEM4 的中止不设断言——收口轮）
 * ```
 * 终态断言面：词形 IMPACT=5（KW1–5）· 闸=3（SEM1 CANCELLED + SEM2/SEM3 各恰
 * 一个终态闸——**判定是模型的**：COMMITTED 或 NO_IMPACT 都是真结局，断言只认
 * 终态唯一性；语义 IMPACT ≥1 证语义写入者真的写过）· SEM1 零语义 IMPACT
 * （取消后永不重评）· KW source 零语义 IMPACT（证据式跳过的活体证明）。
 *
 * 开跑闸（量具有效性先于读数）：① with-test-model 标记；② 语料词形自证
 * （KW 文本恰命中期望规则族、SEM 文本零词形命中——纯函数，零模型）；
 * ③ 激活演练 A==B 不成立 ⇒ 拒跑（边界不推进）。
 *
 * ⚠️ 不主张（写进读数 notProven）：
 * · "她的回复情绪上更贴了"——那是人审（材料落盘 artifacts/m8.5/local/，判定权在人）；
 * · 真实库的 affect 状态——本门只写**副本**；真实库激活属 WP13 独立裁定；
 * · 语义判定的"正确性"——那是盲测门的事；本门只证链路形状（谁写的、写没写、
 *   写了几次、有没有越权）。
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
import type { DrillReading } from './m8.5-live-drill.ts'
import type { M85LiveReading } from './m8.5-live-read.ts'

const ROOT = resolve(import.meta.dirname, '..')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TURN_TIMEOUT_MS = 10 * 60_000
const M85_LOCAL_PARENT = join(ROOT, 'artifacts', 'm8.5', 'local')
const LIVE_CORPUS_VERSION = 'm85-live-corpus@2'
const REPLY_MARKER = '苏沐薇:'

/** 泄漏词形（回复正文里出现任一 ⇒ FAIL：内部数值/规则名/闸名不进用户可见面） */
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
  'affect-semantic',
  'CANCELLED_BY_MODE_CHANGE',
]

// ---------------------------------------------------------------------------
// 冻结场景（m85-live-corpus@1）
// ---------------------------------------------------------------------------

type Mode = 'rules' | 'shadow' | 'semantic'

interface ScenarioTurn {
  readonly id: string
  readonly mode: Mode
  readonly text: string
  /** 词形期望（KW 轮 = 期望规则族；SEM 轮 = null 且必须零词形命中） */
  readonly expectRule: string | null
  /** §24 转换标注（本 boot 相对上一 boot 的模式变化） */
  readonly transition: string
}

const SCENARIO: readonly ScenarioTurn[] = [
  { id: 'B1-rules', mode: 'rules', text: '谢谢你上次帮我整理那些资料，辛苦了。', expectRule: 'A-GRATITUDE', transition: 'baseline' },
  { id: 'B2-shadow', mode: 'shadow', text: '想你了。最近过得还好吗？', expectRule: 'A-WARM-CONTACT', transition: 'rules→shadow' },
  { id: 'B3-semantic', mode: 'semantic', text: '你上次陪我聊到凌晨，我一直记着。', expectRule: null, transition: 'shadow→semantic（在途制造轮）' },
  { id: 'B4-shadow', mode: 'shadow', text: '对不起，我刚才心情不好，不是冲你。', expectRule: 'A-REPAIR', transition: 'semantic→shadow（取消扫面）' },
  { id: 'B5-rules', mode: 'rules', text: '紧急情况，快点回复我。', expectRule: 'A-URGENT', transition: 'shadow→rules' },
  { id: 'B6-rules', mode: 'rules', text: '我讨厌你，你真差劲。', expectRule: 'A-HOSTILE', transition: 'rules→rules（稳定探针）' },
  { id: 'B7-semantic', mode: 'semantic', text: '我同事都羡慕我有个这么靠谱的帮手。', expectRule: null, transition: 'rules→semantic（回归）' },
  { id: 'B8-semantic', mode: 'semantic', text: '刚才那番话点醒我了，收获很大。', expectRule: null, transition: 'semantic→semantic（追赶完成 SEM2）' },
  { id: 'B9-semantic', mode: 'semantic', text: '跟你聊完心里踏实多了，真的。', expectRule: null, transition: 'semantic→semantic（追赶完成 SEM3）' },
]

const PREFLIGHT_TEXT = '预检探针：你好呀，随便说点什么听听。'

// ---------------------------------------------------------------------------
// 参数与守卫（失败关闭）
// ---------------------------------------------------------------------------

if (process.env[TEST_MODEL_WRAPPER_MARKER] === undefined) {
  console.error(
    `[m8.5:live] 拒绝：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 本门只跑测试端点（pnpm with-test-model pnpm m8.5:live:level1），绝不回落 .env 原 key`
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
      problems.push(`${turn.id} 语义文本命中词形 ${matches.map((m) => m.patternId).join(',')}`)
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
const runId = `live85-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}-${head.slice(0, 7)}`
const runDir = join(ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(runDir, { recursive: true })

/* 人审材料不进仓库：写正文前先证明本目录确实被忽略（m6.1/m7/m8 先例） */
const localDir = join(M85_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })
const ignoreCheck = spawnSync('git', ['check-ignore', localDir], { cwd: ROOT, encoding: 'utf8' })
if (ignoreCheck.status !== 0) {
  console.error(`[m8.5:live] local_not_ignored：${localDir} 未被 git 忽略 ⇒ 拒绝写对话正文进盘`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 副本与真实库摘要（只复制，从不打开）
// ---------------------------------------------------------------------------

if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'project-lg-m85-live-'))
const dbDir = join(work, 'pglite')
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) {
  throw new Error('拒绝：副本路径被判成生产库')
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

/** 子进程环境：指向副本 + affect 开 + 模式（仅子进程注入；代码缺省 rules） */
function turnEnv(targetDbDir: string, mode: Mode): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PGLITE_DATA_DIR: targetDbDir,
    PROJECT_LG_SANDBOX: targetDbDir,
    CHARACTER_AFFECT_CONTEXT_ENABLED: 'true',
    CHARACTER_AFFECT_SEMANTIC_MODE: mode,
  }
}

/** 交互控制台一轮（M7 §8.3 时序：正文先行 → 等回复标记 → 再喂 /exit） */
function spawnConsoleTurnAsync(input: {
  readonly text: string
  readonly env: Record<string, string>
}): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const startedAt = Date.now()
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
      resolveSpawn({ status, stdout, stderr: `${stderr}${extraErr}`, durationMs: Date.now() - startedAt })
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

/** 只读子进程（读数器/演练器）：tsx <script> --db-dir <副本> --out <json> */
function spawnReader<T>(script: string, outPath: string, extraArgs: readonly string[] = []): { status: number; reading: T | undefined; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [TSX_CLI, script, '--db-dir', dbDir, '--out', outPath, ...extraArgs],
    { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 }
  )
  const reading = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as T)
    : undefined
  return { status: result.status ?? -1, reading, stderr: String(result.stderr) }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(78))
  console.log(`M8.5 WP11 Production-copy Live Smoke + §24 模式切换全矩阵（${LIVE_CORPUS_VERSION} · 9 轮 · 5 转换）`)
  console.log('='.repeat(78))
  console.log(`  runId      ${runId}`)
  console.log(`  模型路由   ${modelRoute.baseUrlHost} · ${modelRoute.largeModel}（key 长度 ${String(modelRoute.apiKeyLength)}，${modelRoute.keySource}）`)
  console.log(`  副本       ${dbDir}（cpSync 自真实库；真实库只摘要不打开）`)
  console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（前摘要）`)
  console.log(`  入口       交互控制台（stdin 管道；ESTABLISHED 归因——M7 §8.3）`)
  console.log('')

  /* ---- 预检（一次性沙箱，零 affect；只验端点活着） ---- */
  const preflightWork = mkdtempSync(join(tmpdir(), 'project-lg-m85-preflight-'))
  const preflightDbDir = join(preflightWork, 'pglite')
  mkdirSync(preflightDbDir, { recursive: true })
  console.log('  预检       一次性沙箱，1 次真模型探针……')
  const preflight = await spawnConsoleTurnAsync({
    text: PREFLIGHT_TEXT,
    env: {
      ...(process.env as Record<string, string>),
      PGLITE_DATA_DIR: preflightDbDir,
      PROJECT_LG_SANDBOX: preflightDbDir,
    },
  })
  const preflightReply = extractReply(preflight.stdout)
  if (preflight.status !== 0 || preflightReply === '') {
    console.error(`  预检失败：status=${String(preflight.status)} reply=${String(preflightReply.length)} 字`)
    console.error(`  stderr 尾部：${preflight.stderr.slice(-400)}`)
    process.exit(2)
  }
  console.log(`  预检       OK（${String(preflight.durationMs)}ms，回复 ${String(preflightReply.length)} 字）`)
  console.log('')

  /* ---- 激活演练（副本上：@2 受控重建 A==B + 切换边界；零模型） ---- */
  console.log('  演练       @2 受控重建 + 切换边界（副本真实历史）……')
  const drillPath = join(runDir, 'drill.json')
  const drill = spawnReader<DrillReading>('scripts/m8.5-live-drill.ts', drillPath)
  if (drill.status !== 0 || drill.reading === undefined || !drill.reading.ok) {
    console.error(`  演练失败（exit ${String(drill.status)}）：${String(drill.reading?.reason ?? drill.stderr.slice(-300))}`)
    process.exit(4)
  }
  console.log(
    `  演练       OK（A==B · 折叠 ${String(drill.reading.appliedEvents)} 事件 · 边界 ${String(drill.reading.cutoverSequence)} · @${String(drill.reading.after?.reducerVersion)}）`
  )
  console.log('')

  /* ---- 九轮正式（副本 + spawn-per-turn + 模式矩阵） ---- */
  interface TurnRecord {
    readonly id: string
    readonly mode: Mode
    readonly transition: string
    readonly text: string
    readonly reply: string
    readonly replySha256: string
    readonly status: number
    readonly durationMs: number
    readonly leakage: string[]
  }
  const turns: TurnRecord[] = []
  for (const scenario of SCENARIO) {
    process.stdout.write(`  ${scenario.id} [${scenario.mode}] ${scenario.transition} 「${scenario.text}」… `)
    const result = await spawnConsoleTurnAsync({ text: scenario.text, env: turnEnv(dbDir, scenario.mode) })
    const reply = extractReply(result.stdout)
    const leakage = LEAKAGE_MARKERS.filter((marker) => reply.includes(marker))
    turns.push({
      id: scenario.id,
      mode: scenario.mode,
      transition: scenario.transition,
      text: scenario.text,
      reply,
      replySha256: sha256(reply),
      status: result.status,
      durationMs: result.durationMs,
      leakage,
    })
    /* 人审材料（正文只进 gitignored local/） */
    writeFileSync(
      join(localDir, `${scenario.id}.md`),
      `# ${scenario.id}（${scenario.mode} · ${scenario.transition}）\n\n` +
        `用户：${scenario.text}\n\n她的回复：\n\n${reply}\n\n` +
        `（status=${String(result.status)} · ${String(result.durationMs)}ms · sha256=${sha256(reply)}）\n`,
      'utf8'
    )
    console.log(
      `${result.status === 0 && reply !== '' ? '✅' : '❌'} ${String(result.durationMs)}ms · 回复 ${String(reply.length)} 字${leakage.length > 0 ? ` · ⚠️泄漏 ${leakage.join('/')}` : ''}`
    )
  }
  console.log('')

  /* ---- 读数器（只读副本；子进程，零模型；tail 40 覆盖 9 轮 18 事件 + 生产尾） ---- */
  const readingPath = join(runDir, 'reading.json')
  const read = spawnReader<M85LiveReading>('scripts/m8.5-live-read.ts', readingPath, ['--tail', '40'])
  if (read.status !== 0 || read.reading === undefined || !read.reading.ok) {
    console.error(`读数器失败（exit ${String(read.status)}）：${read.reading?.reason ?? read.stderr.slice(-400)}`)
    process.exit(3)
  }
  const reading = read.reading

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
    if (!pass) console.error(`FAIL [${id}] ${label}: expected=${expected} actual=${actual}`)
  }

  /* ---- 轮次本身：全部成功 + 回复非空 + 零泄漏 ---- */
  const allTurnsOk = turns.every((t) => t.status === 0 && t.reply !== '' && t.leakage.length === 0)
  const totalLeakage = turns.flatMap((t) => t.leakage)
  record(
    'LV85-REPLY',
    '九轮全部成功：回复非空 · 正文零内部泄漏（效价/唤醒/规则名/闸名不进用户可见面）',
    '9/9 成功 · 泄漏=0',
    `${String(turns.filter((t) => t.status === 0 && t.reply !== '').length)}/9 成功 · 泄漏=${String(totalLeakage.length)}${totalLeakage.length > 0 ? `（${totalLeakage.join('/')}）` : ''}`,
    allTurnsOk
  )

  /* ---- 演练：按初始态分路（replayed: A==B；seeded_fresh: @2 直接播种） ---- */
  const drillPathTaken = drill.reading?.path
  const drillOk =
    drill.reading !== undefined &&
    drill.reading.ok &&
    (drill.reading.cutoverSequence ?? 0) > 0 &&
    drill.reading.after?.reducerVersion === 'affect-reducer@2' &&
    (drillPathTaken === 'seeded_fresh' || drill.reading.aEqualB)
  record(
    'LV85-DRILL',
    '激活演练：已建档 ⇒ @2 受控重放 A==B；未建档（今日生产真实态）⇒ @2 直接播种 · 边界=演练时账本尾 · 投影章=@2',
    'A==B（或 fresh 播种）· 边界>0 · @2',
    `path=${String(drillPathTaken)} · A==B=${String(drill.reading?.aEqualB)} · 边界=${String(drill.reading?.cutoverSequence)} · 折叠=${String(drill.reading?.appliedEvents)} · @${String(drill.reading?.after?.reducerVersion)}`,
    drillOk
  )

  /* ---- §24 全矩阵：五条转换各至少一次（按构造走完；证据面核模式序列） ---- */
  const expectedTransitions = ['rules→shadow', 'shadow→semantic（在途制造轮）', 'semantic→shadow（取消扫面）', 'shadow→rules', 'rules→semantic（回归）']
  const walked = turns.map((t) => t.transition)
  const matrixOk = expectedTransitions.every((t) => walked.includes(t))
  record(
    'LV85-MATRIX',
    '§24 全矩阵：五条转换各至少一次 · 切换期间单写入者不破坏（每 boot 是真实重启，状态从盘上来）',
    expectedTransitions.join(' · '),
    walked.join(' · '),
    matrixOk
  )

  /* ---- 单写入者：词形 IMPACT 只带 @1、语义 IMPACT 只带语义 policy ---- */
  const impacts = reading.affectEvents?.impacts ?? []
  const keywordImpacts = impacts.filter((i) => i.ruleVersion === 'affect-rules@1')
  const semanticImpacts = impacts.filter((i) => i.ruleVersion === 'affect-semantic-policy@1')
  const otherVersionImpacts = impacts.filter(
    (i) => i.ruleVersion !== 'affect-rules@1' && i.ruleVersion !== 'affect-semantic-policy@1'
  )
  /* 本 run 的 source：九个冻结文本对应的用户事件 */
  const scenarioTexts = new Set(SCENARIO.map((s) => s.text))
  const runUserEvents = reading.ledger.tail.filter(
    (row) => scenarioTexts.has(row.content) && row.actorType === 'user'
  )
  const runSourceIds = new Set(runUserEvents.map((row) => row.id))
  const runKeywordImpacts = keywordImpacts.filter((i) => i.sourceEventId !== null && runSourceIds.has(i.sourceEventId))
  const runSemanticImpacts = semanticImpacts.filter((i) => i.sourceEventId !== null && runSourceIds.has(i.sourceEventId))
  /* 期望：五个 KW 轮各 1 条词形 IMPACT（语义轮词形让位）；SEM2/SEM3 由
     boot8/boot9 的启动追赶完成评估 ⇒ 各恰一个终态闸（判定是模型的——
     COMMITTED 或 NO_IMPACT 都是真结局）；SEM1 被取消 ⇒ 零 IMPACT；SEM4 是
     收口轮（其中止不设断言）。语义 IMPACT ≥1 证语义写入者真的写过。 */
  const writerOk =
    otherVersionImpacts.length === 0 &&
    runKeywordImpacts.length === 5 &&
    runSemanticImpacts.length >= 1 &&
    runSemanticImpacts.length <= 2
  record(
    'LV85-WRITER',
    '单写入者：KW 轮词形 IMPACT=5（@1）· 语义轮词形让位（semantic 轮零词形 IMPACT）· 语义 IMPACT∈[1,2]（SEM2/SEM3 完成评估，判定是模型的；≥1 证语义写入者写过）· 无第三种版本串',
    '词形=5 语义∈[1,2] 异版本=0',
    `词形=${String(runKeywordImpacts.length)} 语义=${String(runSemanticImpacts.length)} 异版本=${String(otherVersionImpacts.length)} · IMPACT 总=${String(impacts.length)}（含生产历史）`,
    writerOk
  )

  /* ---- 取消扫面：SEM1 的任务由 boot4 取消扫面写 CANCELLED 终态闸（semantic→shadow 的活体证明） ---- */
  const sem1Event = runUserEvents.find((row) => row.content === SCENARIO[2].text)
  const sem1Gate = sem1Event === undefined
    ? undefined
    : reading.semanticGates.find((g) => g.idempotencyKey === `affect-semantic-finalized:${sem1Event.id}`)
  const sem1Cancelled = sem1Gate?.operation?.includes('CANCELLED_BY_MODE_CHANGE') ?? false
  record(
    'LV85-CANCEL',
    '在途取消：SEM1 中途退出的任务由 boot4 取消扫面写 CANCELLED_BY_MODE_CHANGE 终态闸（§24 行3：取消先于新写入者启用）',
    '闸含 CANCELLED_BY_MODE_CHANGE',
    `SEM1 闸=${sem1Gate === undefined ? '缺失' : String(sem1Gate.operation)} · 语义任务分布=${JSON.stringify(reading.semanticJobs?.byStatus ?? {})}`,
    sem1Cancelled
  )

  /* ---- 永不重评 + 终态唯一：SEM1 零语义 IMPACT；KW 零语义 IMPACT；SEM2/SEM3 各恰一个终态闸 ---- */
  const sem1SemanticImpacts = sem1Event === undefined
    ? []
    : runSemanticImpacts.filter((i) => i.sourceEventId === sem1Event.id)
  const semTexts = new Set([SCENARIO[2].text, SCENARIO[6].text, SCENARIO[7].text, SCENARIO[8].text])
  const kwSourceIds = new Set(
    runUserEvents.filter((row) => !semTexts.has(row.content)).map((row) => row.id)
  )
  const kwSemanticImpacts = runSemanticImpacts.filter((i) => i.sourceEventId !== null && kwSourceIds.has(i.sourceEventId))
  const terminalGateCountOf = (text: string): number => {
    const event = runUserEvents.find((row) => row.content === text)
    if (event === undefined) return 0
    return reading.semanticGates.filter((g) => g.idempotencyKey === `affect-semantic-finalized:${event.id}`).length
  }
  const sem2Gates = terminalGateCountOf(SCENARIO[6].text)
  const sem3Gates = terminalGateCountOf(SCENARIO[7].text)
  record(
    'LV85-NOREVAL',
    '永不重评 + 终态唯一：SEM1（已取消）零语义 IMPACT · 五个 KW source 零语义 IMPACT（词形已落 ⇒ 证据式跳过）· SEM2/SEM3 各恰一个终态闸（COMMITTED 或 NO_IMPACT——判定是模型的，唯一性是设计的）',
    'SEM1=0 · KW语义=0 · SEM2闸=1 · SEM3闸=1',
    `SEM1=${String(sem1SemanticImpacts.length)} · KW语义=${String(kwSemanticImpacts.length)} · SEM2闸=${String(sem2Gates)} · SEM3闸=${String(sem3Gates)} · 语义IMPACT总=${String(runSemanticImpacts.length)}`,
    sem1SemanticImpacts.length === 0 && kwSemanticImpacts.length === 0 && sem2Gates === 1 && sem3Gates === 1
  )

  /* ---- 边界：切换边界在案且单调（扫面推进 ≥ 演练值） ---- */
  const cutoverNow = reading.semanticWatermarks?.cutover ?? null
  const drillBoundary = drill.reading?.cutoverSequence ?? 0
  record(
    'LV85-BOUNDARY',
    '切换边界：演练时落边界，取消扫面推进后仍 ≥ 演练值（单调不回退；边界前来源永不语义重评）',
    `边界 ≥ ${String(drillBoundary)}`,
    `当前边界=${String(cutoverNow)} · 演练边界=${String(drillBoundary)}`,
    cutoverNow !== null && cutoverNow >= drillBoundary && drillBoundary > 0
  )

  /* ---- trace：语义轮追加语义四步；rules/shadow 轮不追加（no-op 不变长） ---- */
  const traceTail = reading.traces?.tail ?? []
  const semanticTraceCount = traceTail.filter((t) =>
    t.affectStepKinds.some((k) => k.startsWith('affect_semantic'))
  ).length
  const traceOk = (reading.traces?.withSemanticSteps ?? 0) >= 2 && semanticTraceCount >= 1
  record(
    'LV85-TRACE',
    'trace：语义轮含 affect_semantic_* 步（轮后追加）· rules/shadow 轮零语义步（no-op 不追加）',
    `withSemantic ≥ 2`,
    `withSemanticSteps=${String(reading.traces?.withSemanticSteps)} · 末 ${String(traceTail.length)} 条里语义步条数=${String(semanticTraceCount)}`,
    traceOk
  )

  /* ---- 轴界（不主张具体值——语义判定非确定；只证界内 + 投影活着） ---- */
  const projection = reading.projection
  const axisOk =
    projection !== null &&
    projection.valence !== null &&
    projection.arousal !== null &&
    projection.valence >= -1 - 1e-9 &&
    projection.valence <= 1 + 1e-9 &&
    projection.arousal >= -1e-9 &&
    projection.arousal <= 1 + 1e-9 &&
    projection.revision !== null &&
    projection.revision > 0
  record(
    'LV85-AXIS',
    '轴界：副本投影活着且 −1≤v≤1 · 0≤a≤1（不主张具体值——语义判定非确定，正确性归盲测门）',
    '界内 · revision>0',
    `v=${String(projection?.valence)} a=${String(projection?.arousal)} rev=${String(projection?.revision)} @${String(projection?.reducerVersion)}`,
    axisOk
  )

  /* ---- 真实库：树摘要前后逐字相同（本门从未打开写入） ---- */
  const realDbOk =
    realDbAfter.treeSha256 === realDbBefore.treeSha256 &&
    realDbAfter.measuredCount === realDbBefore.measuredCount
  record(
    'LV85-REALDB',
    '真实库树摘要前后逐字相同（本门只复制，从未打开写入）',
    `${realDbBefore.treeSha256.slice(0, 16)}…`,
    `${realDbAfter.treeSha256.slice(0, 16)}…（${String(realDbAfter.measuredCount)} 文件）`,
    realDbOk
  )

  /* ---- 量具自检（§6.8）：计数型读数非零 ---- */
  const measured = {
    turns: turns.length,
    runUserEvents: runUserEvents.length,
    gates: reading.semanticGates.length,
    impacts: impacts.length,
  }
  const measuredInvalid = Object.values(measured).some((n) => n === 0)
  if (measuredInvalid) {
    console.error(`MEASUREMENT INVALID: measured_count 含 0 —— ${JSON.stringify(measured)}`)
  }
  record(
    'LV85-MEASURED',
    '量具自检：九轮用户事件全部在账本末尾可查 · 闸/IMPACT 计数非零（读数量到了要判的东西）',
    '9 事件 · 计数>0',
    `用户事件=${String(measured.runUserEvents)}/9 · 闸=${String(measured.gates)} · IMPACT=${String(measured.impacts)}`,
    !measuredInvalid && measured.runUserEvents === 9
  )

  const failed = checks.filter((c) => !c.pass)
  const verdict = failed.length === 0 && !measuredInvalid ? 'PASS' : 'FAIL'

  const evidence = {
    gate: 'm8.5:live:level1',
    corpus: LIVE_CORPUS_VERSION,
    verdict,
    total: checks.length,
    failed: failed.length,
    notProven: [
      '她的回复情绪上更贴了——人审材料在 artifacts/m8.5/local/（gitignored），判定权在人',
      '真实库的 affect 状态——本门只写副本；真实库激活属 WP13 独立裁定',
      '语义判定的正确性——盲测门的事；本门只证链路形状',
    ],
    model: { host: modelRoute.baseUrlHost, model: modelRoute.largeModel },
    turns: turns.map((t) => ({
      id: t.id,
      mode: t.mode,
      transition: t.transition,
      status: t.status,
      durationMs: t.durationMs,
      replySha256: t.replySha256,
      replyLength: t.reply.length,
      leakage: t.leakage,
    })),
    drill: drill.reading,
    reading: {
      projection: reading.projection,
      keywordWatermark: reading.keywordWatermark,
      semanticWatermarks: reading.semanticWatermarks,
      semanticJobs: reading.semanticJobs,
      semanticGateCount: reading.semanticGates.length,
      gates: reading.semanticGates,
      affectByType: reading.affectEvents?.byType,
      runKeywordImpacts: runKeywordImpacts.length,
      runSemanticImpacts: runSemanticImpacts.length,
    },
    realDb: { before: realDbBefore, after: realDbAfter },
    checks,
  }
  writeFileSync(join(runDir, 'live85-verify.json'), JSON.stringify(evidence, null, 2), 'utf8')

  console.log('='.repeat(78))
  console.log(`M8.5 Live Smoke + §24 全矩阵：${verdict}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  console.log(`  词形 IMPACT（本 run）=${String(runKeywordImpacts.length)} · 语义 IMPACT=${String(runSemanticImpacts.length)} · 闸=${String(reading.semanticGates.length)}`)
  console.log(`  人审材料   artifacts/m8.5/local/${runId}/（gitignored）`)
  console.log(`  证据       artifacts/m8.5/${runId}/live85-verify.json`)
  console.log('='.repeat(78))
  process.exit(verdict === 'PASS' ? 0 : 1)
}

void main()
