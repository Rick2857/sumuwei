/**
 * M10.1 WP6b —— **受控生产激活**（`m10.1:activate`）。
 *
 * ============================================================================
 *  用户授权（逐字）
 * ============================================================================
 * ```text
 * 2026-10-02：用户裁定「**A. 现在两个额度一起开**」+「**goal 300 / commitment 300**」。
 *   授权依据：[`ADR-086`](../docs/adr/ADR-086-m10.1-agreement-bridge.md) `D09`（两个额度）
 *   与 §4 第 ④ 项（"缺省 0 与**激活值**"是送审冻结项）。
 * ```
 *
 * ============================================================================
 *  它做什么（**与 `m11:activate` 的关键差别：不打开数据库**）
 * ============================================================================
 * ```text
 * 唯一改动：目标 `.env` **只追加两行**（+ 一行来历注释）：
 *     CHARACTER_GOAL_TOKENS=300          ← 销账 `L-M11-10`（目标状态块从未被装配层赋过额度）
 *     CHARACTER_COMMITMENT_TOKENS=300    ← M10.1 的约定与结清块（`D08`/`D09`）
 *
 * ⚠️ **为什么不需要开库**：`m11:activate` 必须开库是因为它要**先钉水位**（不回判历史，`D33`）；
 *    而这两个额度只决定"渲染时给不给预算"，**没有任何要预置的状态**、没有水位、没有 cutover、
 *    也不可能回判历史（事实块渲染的是**当前**投影）。
 *    ⇒ 于是本脚本**一个数据库连接都不建**（有自检，见 `A1`），真实库在本轮**连租约都不需要**。
 * ```
 *
 * ============================================================================
 *  五条硬边界
 * ============================================================================
 * ```text
 * ① **不开库**：源码里没有开库/装配放行调用（`A1` 去注释后判定）。
 * ② **有消费者才写开关**（`D3` 的教训）：代码里真的消费这两个名字才追加，否则就是"惰性开关"（`A2`）。
 * ③ **前置条件**：目标域总开关必须是 `true`（域关着时这两个额度是**死配置**，`A3`）。
 * ④ **一次性 / 幂等**：两键不存在 ⇒ 追加；已存在且**值一致** ⇒ 不重复追加；值不同 ⇒ **拒绝**（exit 2，`A4`）。
 * ⑤ **只追加**：改完的文本必须以改前的文本**逐字节**为前缀，且既有键的取值一个都没变（`A5`）。
 * ```
 *
 * 用法：
 * ```bash
 * tsx scripts/m10.1-activate.ts --env-file "<生产 .env 的绝对路径>" [--dry-run]
 * ```
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join, resolve } from 'node:path'

import { parse as parseDotenv } from 'dotenv'

import { readKernelFlags } from '../src/kernel/app/flags.ts'
import {
  createGoalStateProvider,
  renderGoalStateBlock,
  type GoalContextItem,
} from '../src/kernel/context/goal-sections.ts'
import type { ContextCompileInput } from '../src/kernel/contracts/context.ts'
import {
  createCommitmentStateProvider,
  renderCommitmentStateBlock,
  COMMITMENT_DO_NOT_RAISE,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'
import type { GoalState } from '../src/kernel/contracts/goal.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

const REPO_ROOT = resolve(process.cwd())

/* ---------------------------------------------------------------------------
 * 本轮要追加的两行（**值** = 用户 2026-10-02 裁定的 300 / 300）
 * ------------------------------------------------------------------------- */
const ENV_LINES = ['CHARACTER_GOAL_TOKENS=300', 'CHARACTER_COMMITMENT_TOKENS=300'] as const
const ENV_COMMENT = '# M10.1 / ADR-086 D09：目标状态块 + 约定与结清块额度（2026-10-02 用户授权激活）'
const EXPECTED_TOKENS = { goal: 300, commitment: 300 } as const

/* ---------------------------------------------------------------------------
 * 参数
 * ------------------------------------------------------------------------- */
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const envFileArg = ((): string | undefined => {
  const index = argv.indexOf('--env-file')
  return index >= 0 ? argv[index + 1] : undefined
})()

const checks: { id: string; label: string; pass: boolean; detail: string }[] = []
function check(id: string, label: string, pass: boolean, detail = ''): void {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

/** 去掉注释后的代码行（**判结构不判文本**：注释里提一句不能算"有消费者"，也不能算"开了库"） */
function codeLinesOf(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => line.trim() !== '')
}
const readSrc = (relative: string): string =>
  existsSync(join(REPO_ROOT, relative)) ? readFileSync(join(REPO_ROOT, relative), 'utf8') : ''

console.log('='.repeat(72))
console.log(`M10.1 受控生产激活${dryRun ? '（**干跑**：不改 .env）' : ''}`)
console.log('='.repeat(72))

/* ---------------------------------------------------------------------------
 * A1 —— 本脚本**不开数据库**（先证明自己的边界，再谈别的）
 * ------------------------------------------------------------------------- */
/*
 * ⚠️ **判据本身不许自匹配**：这段源码里就写着这些名字（还有那个包名字符串），
 *    直接 `includes` 会把**写判据的这一行**当成违规。于是包名拆开拼、调用形态用正则。
 *    （真实事故的形状：`m10-context-verify` 的 `C2`/`C3` 把注释里引用的禁令当成违规。）
 */
const ownCode = codeLinesOf(readFileSync(join(REPO_ROOT, 'scripts/m10.1-activate.ts'), 'utf8')).join('\n')
const dbCallPattern = /\b(initDatabase|getRawDb|prepareProductionOpen|allowProductionDatabase|resetPluginSqlConnection)\s*\(/
const sqlPluginName = `plugin${'-'}sql`
check(
  'A1',
  '【本脚本不开库】源码（去注释后）里**没有**任何开库 / 生产放行调用 ⇒ 真实库在本轮连租约都不需要',
  !dbCallPattern.test(ownCode) && !ownCode.includes(sqlPluginName),
  dbCallPattern.test(ownCode) || ownCode.includes(sqlPluginName) ? '**出现了开库调用**' : '0 处'
)

/* ---------------------------------------------------------------------------
 * A2 —— 有消费者才写开关（`D3`）
 * ------------------------------------------------------------------------- */
const mainCode = codeLinesOf(readSrc('src/main.ts')).join('\n')
const gatewayCode = codeLinesOf(readSrc('src/kernel/app/turn-gateway.ts')).join('\n')
const mainConsumesGoal = /goalTokens:\s*this\.flags\.goalTokens/.test(mainCode)
const mainConsumesCommitment = /commitmentTokens:\s*this\.flags\.commitmentTokens/.test(mainCode)
const mainWiresPort = /commitmentFactRows:/.test(mainCode)
const gatewayGatesOnBudget = /commitmentTokens\s*>\s*0/.test(gatewayCode)
const gatewayRegisters = /createCommitmentStateProvider\s*\(/.test(gatewayCode)
check(
  'A2',
  '【有消费者才写开关】两个额度**都**被装配层真的传进 `recallBudget`，约定端口真的接上，网关真的注册并按额度门控',
  mainConsumesGoal && mainConsumesCommitment && mainWiresPort && gatewayGatesOnBudget && gatewayRegisters,
  `goal=${
    String(mainConsumesGoal)
  } · commitment=${String(mainConsumesCommitment)} · 端口=${String(mainWiresPort)} · 门控=${String(gatewayGatesOnBudget)} · 注册=${String(gatewayRegisters)}`
)

/* ---------------------------------------------------------------------------
 * A3 —— 前置条件：目标域总开关
 * ------------------------------------------------------------------------- */
if (envFileArg === undefined) {
  console.error('[m10.1:activate] 拒绝：必须先给 `--env-file <路径>` —— 激活要写的是**哪一份** .env 必须显式。')
  process.exit(2)
}
const envPath = resolve(envFileArg)
if (!existsSync(envPath)) {
  console.error(`[m10.1:activate] 拒绝：找不到目标 .env（${envPath}）`)
  process.exit(2)
}
const beforeText = readFileSync(envPath, 'utf8')
const beforeEnv = parseDotenv(beforeText)
check(
  'A3',
  '【前置条件】目标域总开关已是 `true`（域关着时这两个额度是**死配置**，不该写进去）',
  (beforeEnv.CHARACTER_GOALS_ENABLED ?? '').trim().toLowerCase() === 'true',
  `CHARACTER_GOALS_ENABLED=${beforeEnv.CHARACTER_GOALS_ENABLED ?? '（未设）'} · 文件=${basename(envPath)}`
)

/* ---------------------------------------------------------------------------
 * A4 —— 一次性 / 幂等 / 值冲突拒绝
 * ------------------------------------------------------------------------- */
const keyOf = (line: string): string => line.split('=')[0]!
const expectedValueOf = (line: string): string => line.split('=')[1]!
/** ⚠️ 读数里写的是**文件里的取值**（不是"我们期望的那一行"）—— 两者混同正是 M5.1 量具事故的形状 */
const asRead = (line: string): string => `${keyOf(line)}=${beforeEnv[keyOf(line)] ?? '（未设）'}`
const presentKeys = ENV_LINES.filter((line) => beforeEnv[keyOf(line)] !== undefined)
const conflicting = presentKeys.filter((line) => beforeEnv[keyOf(line)] !== expectedValueOf(line))
check(
  'A4',
  '【一次性 / 幂等】两键要么**不存在**（追加），要么已存在且**值一致**（幂等）；值不同 ⇒ 拒绝',
  conflicting.length === 0,
  `已存在=${JSON.stringify(presentKeys.map(asRead))} · 值冲突=${JSON.stringify(
    conflicting.map((line) => `${asRead(line)}（期望 ${expectedValueOf(line)}）`)
  )}`
)
if (conflicting.length > 0) {
  console.error('[m10.1:activate] 拒绝：`.env` 里已有同名键但值不同 ⇒ 不静默改写既有配置。')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * A5 —— **只追加**（写入 + 前后逐字节对照）
 * ------------------------------------------------------------------------- */
const toAppend = ENV_LINES.filter((line) => beforeEnv[keyOf(line)] === undefined)
const prefix = beforeText.endsWith('\n') || beforeText === '' ? '' : '\n'
const projectedTail = `${prefix}${ENV_COMMENT}\n${toAppend.join('\n')}${toAppend.length > 0 ? '\n' : ''}`
/*
 * ⚠️ **干跑也跑全套**：它不写盘，而是把"将要写的内容"**投影**成新文本，再从这份文本上读数 ——
 *    否则干跑会在 A6/A7/A8 上（额度还是 0）必然红，"预演整条路径"就变成了一句空话。
 *    差别只有一处：干跑档**没有真的 append**（`appended = 0`，文件字节未变）。
 */
let appended = 0
if (!dryRun && toAppend.length > 0) {
  appendFileSync(envPath, projectedTail, 'utf8')
  appended = toAppend.length
}
const afterText = dryRun ? `${beforeText}${projectedTail}` : readFileSync(envPath, 'utf8')
const beforeKeys = Object.keys(beforeEnv)
const afterEnv = parseDotenv(afterText)
const keysUnchanged = beforeKeys.every((key) => afterEnv[key] === beforeEnv[key])
const onlyAppended = afterText.startsWith(beforeText)
const tailLines = onlyAppended
  ? afterText
      .slice(beforeText.length)
      .split('\n')
      .filter((line) => line.trim() !== '')
  : []
check(
  'A5',
  '【⭐ 只追加】新文本以旧文本**逐字节**为前缀 · 既有键的取值**一个都没变** · 新增行只有"注释 + 两行"',
  onlyAppended &&
    keysUnchanged &&
    tailLines.length <= ENV_LINES.length + 1 &&
    ENV_LINES.every((line) => afterText.includes(line)),
  `前缀成立=${String(onlyAppended)} · 既有键逐一相同=${String(keysUnchanged)} · 追加行数=${String(
    dryRun ? `(干跑未写；投影 ${String(toAppend.length)} 行)` : appended
  )}`
)

/* ---------------------------------------------------------------------------
 * A6 —— flags 解析（从**文件文本**构造 env，不读 `process.env`）
 * ------------------------------------------------------------------------- */
const afterFlags = readKernelFlags({ ...afterEnv })
check(
  'A6',
  '【配置读回】用**文件文本**解析出的 flags：两个额度 = 300 / 300（关掉的是 `process.env` 的影响面）',
  afterFlags.goalTokens === EXPECTED_TOKENS.goal && afterFlags.commitmentTokens === EXPECTED_TOKENS.commitment,
  `goalTokens=${String(afterFlags.goalTokens)} · commitmentTokens=${String(afterFlags.commitmentTokens)}`
)

/* ---------------------------------------------------------------------------
 * A7 —— 两个块在**激活额度**下真的渲染（离线；零数据库、零模型）
 * ------------------------------------------------------------------------- */
/** 与基础设施缺省一致的字符级量化器（3 字符 ≈ 1 token） */
const quantify = (text: string): number => Math.ceil(text.length / 3)
const CHARACTER = 'char:su-mu-wei'
const goalFixture: GoalState = {
  goalId: 'gol:m10-1-activation' as GoalState['goalId'],
  characterId: CHARACTER,
  owner: entityRef('character', CHARACTER),
  origin: 'user_requested',
  sourceRefs: [
    { conversationEventId: 'cev:m10-1-activation' as never, fingerprint: 'fp-activation' },
  ],
  revision: 1,
  statement: '把提纲写完',
  successCriterion: { kind: 'user_report' },
  status: 'active',
  priority: 'normal',
  dependencies: [],
  time: { recordedAt: 1_760_000_000_000 },
}
const goalItem: GoalContextItem = { goal: goalFixture, rowKey: `goal:${goalFixture.goalId}` }
const compileInput: ContextCompileInput = {
  characterId: CHARACTER as never,
  currentInput: '我们接着上次的来',
  now: 1_760_000_000_000,
}
const rowsFixture: readonly CommitmentFactRow[] = [
  { goalId: 'gol:met', scope: '下次继续时给你三个步骤', status: 'fulfilled', criterionKind: 'conversation_output' },
  { goalId: 'gol:pending', scope: '投稿前先把稿子发给她看', status: 'active', criterionKind: 'action_result' },
]

const goalSections = await createGoalStateProvider({
  maxTokens: afterFlags.goalTokens,
  quantify,
  select: () => ({ ordered: [goalItem], withdrawnEventIds: new Set<string>() }),
}).provide(compileInput)
const commitmentSections = await createCommitmentStateProvider({
  rows: async () => rowsFixture,
  maxTokens: afterFlags.commitmentTokens,
  quantify,
}).provide(compileInput)
const commitmentText = commitmentSections.map((section) => section.content).join('\n')
check(
  'A7',
  '【⭐ 两个块真的能渲染】在激活额度下：`goal-state` 产 ≥1 个 section（含目标正文）· 约定块产 ≥1 个 section 且终态行含「不要再提」',
  goalSections.length >= 1 &&
    goalSections.some((section) => section.content.includes(goalFixture.statement)) &&
    commitmentSections.length >= 1 &&
    commitmentText.includes(COMMITMENT_DO_NOT_RAISE),
  `goal sections=${String(goalSections.length)} · commitment sections=${String(commitmentSections.length)} · 含「不要再提」=${String(commitmentText.includes(COMMITMENT_DO_NOT_RAISE))}`
)

/* 失败关闭 / 回滚档：额度 0 ⇒ 两个块都产 0 个 section */
let goalSelectCalls = 0
const offGoal = await createGoalStateProvider({
  maxTokens: 0,
  quantify,
  select: () => {
    goalSelectCalls += 1
    return { ordered: [goalItem], withdrawnEventIds: new Set<string>() }
  },
}).provide(compileInput)
const offCommitment = await createCommitmentStateProvider({
  rows: async () => rowsFixture,
  maxTokens: 0,
  quantify,
}).provide(compileInput)
check(
  'A8',
  '【回滚档】额度 0 ⇒ 两块都产 **0 个 section**，且目标侧**连候选都不取**（`D27`：0 是一个真实配置）',
  offGoal.length === 0 && offCommitment.length === 0 && goalSelectCalls === 0,
  `sections=${String(offGoal.length)}/${String(offCommitment.length)} · 取候选次数=${String(goalSelectCalls)}`
)
/*
 * ⚠️ 断言"正文真的由**这两个渲染器**产出"（而不是"工厂返回了非空"）：工厂与渲染器是同一批导出，
 *    但两处实现若漂了，只断长度是看不出来的（M5.1 的 `INV-M45-06` 教训）。
 */
const renderedGoals = renderGoalStateBlock([goalItem])
const renderedCommitments = renderCommitmentStateBlock({ rows: rowsFixture, maxTokens: 300, quantify })
check(
  'A9',
  '【渲染器与工厂一致】`renderGoalStateBlock` / `renderCommitmentStateBlock` 产出的正文确实出现在 provider 的 section 里',
  goalSections.some((section) => section.content.includes(renderedGoals.trim())) &&
    commitmentSections.some((section) => section.content.includes(renderedCommitments[0]?.content ?? '\u0000')),
  `goal 一致=${String(goalSections.some((section) => section.content.includes(renderedGoals.trim())))} · commitment 一致=${String(commitmentSections.some((section) => section.content.includes(renderedCommitments[0]?.content ?? '\u0000')))}`
)


/* ---------------------------------------------------------------------------
 * 证据
 * ------------------------------------------------------------------------- */
const failed = checks.filter((item) => !item.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp6b-activate', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-activate@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  dryRun,
  authorizedBy: 'R-M10.1-01（用户 2026-10-02 逐字：「生产激活」+ 选项 A + goal 300 / commitment 300）',
  envFile: envPath,
  envLines: ENV_LINES,
  appendedLines: appended,
  opensDatabase: false,
  flagsAfter: { goalTokens: afterFlags.goalTokens, commitmentTokens: afterFlags.commitmentTokens },
  preexistingKeys: presentKeys,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  rollback: '删除 .env 里那两行（+ 注释行）即可：两个事实块当月即不再注入；已写事件与投影保留（回滚 ≠ 删数据）',
  firstUse: 'NOT OBSERVED（真实首聊之后才允许改；**不凭配置宣布**）',
  notClaimed: [
    '不主张"她不会再重复"（ADR-086 D12）',
    '不主张"她能判断他有没有真的到场"',
    '不主张"到期=失约"',
    '不主张"约定一定被识别"',
    '不主张"她提出的约定在生产里已能记下" —— 装配三跳 L-M10.1-05 仍未接线',
  ],
}
writeFileSync(join(dir, 'activate.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp6b-activate',
  head,
  headShort: head.slice(0, 12),
  branch,
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'activation',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: dryRun ? ['dry-run'] : ['env-append', 'offline-render'],
  supersedes: null,
  notes: `m10.1:activate（.env 追加 ${String(appended)} 行 · goal/commitment = 300/300 · **零开库** · 干跑=${String(dryRun)}）`,
})
console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
