/**
 * M10.1 WP6b —— **激活读回**（`m10.1:activation:readback`）。
 *
 * ============================================================================
 *  三层读回（与 `m10:activation:readback` / `m11:activation:readback` 同构）
 * ============================================================================
 * ```text
 * ① **配置读回**：读的是 `.env` 的**文件文本**（不是 `process.env`）——
 *    "配置里写了什么"与"进程里读到什么"是两件事（M11 记录 §3 逐字）。
 * ② **装配读回**：两个额度是否**真的**被装配层传进 `recallBudget`、
 *    约定只读端口是否真的接上、网关是否**按额度门控**注册 —— 全部用**去注释后的代码行**判定。
 * ③ **首次行为读回**：**真实首聊之前一律 `NOT OBSERVED`** —— **不凭配置宣布**。
 * ```
 *
 * ============================================================================
 *  它与 `m10.1:activate` 的分工（**读回必须独立**）
 * ============================================================================
 * ```text
 * · `m10.1:activate` **写**（追加两行 + 逐字节证明只追加）；本门**只读**，一个字节都不写。
 * · 本门用**网关真正注册的那两个 provider 工厂**（`createGoalStateProvider` /
 *   `createCommitmentStateProvider`）验证"激活额度下真的能渲染"，而不是只调渲染器。
 * · 本门**不打开真实库**（自检见 `C2`）：因此"生产里现有几条目标/承诺"它**读不到**，
 *   它**如实标注"未读"**，不猜、不假装 —— 要读那份计数得走带 token 的只读 opener（独立授权）。
 * ```
 *
 * 用法：
 * ```bash
 * tsx scripts/m10.1-activation-readback.ts --env-file "<生产 .env 的绝对路径>"
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join, resolve } from 'node:path'

import { parse as parseDotenv } from 'dotenv'

import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { createGoalStateProvider, type GoalContextItem } from '../src/kernel/context/goal-sections.ts'
import type { ContextCompileInput } from '../src/kernel/contracts/context.ts'
import {
  createCommitmentStateProvider,
  COMMITMENT_DO_NOT_RAISE,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'
import type { GoalState } from '../src/kernel/contracts/goal.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const KEYS = { goal: 'CHARACTER_GOAL_TOKENS', commitment: 'CHARACTER_COMMITMENT_TOKENS' } as const
const EXPECTED = { goal: 300, commitment: 300 } as const

const argv = process.argv.slice(2)
const envFileArg = ((): string | undefined => {
  const index = argv.indexOf('--env-file')
  return index >= 0 ? argv[index + 1] : undefined
})()

interface Check {
  group: 'A' | 'B' | 'C'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean
): void {
  checks.push({ group, id, label, expected, actual, pass })
}
function phase(mark: string): void {
  console.error(`[m10.1-activation-readback] ${mark}`)
}
/** 去掉注释后的代码行（**判结构不判文本**：注释里提一句不能算接线，也不能算开库） */
function codeLinesOf(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => line.trim() !== '')
}
const readSrc = (relative: string): string =>
  existsSync(join(REPO_ROOT, relative)) ? readFileSync(join(REPO_ROOT, relative), 'utf8') : ''

if (envFileArg === undefined) {
  console.error('[m10.1:activation:readback] 拒绝：必须先给 `--env-file <路径>`（读哪一份配置必须显式）。')
  process.exit(2)
}
const envPath = resolve(envFileArg)
if (!existsSync(envPath)) {
  console.error(`[m10.1:activation:readback] NOT RUN：找不到配置文件（${envPath}）`)
  process.exit(2)
}
const envText = readFileSync(envPath, 'utf8')
const fileEnv = parseDotenv(envText)

console.log('='.repeat(72))
console.log('M10.1 激活读回（只读：不改配置、不打开数据库）')
console.log('='.repeat(72))

/* ---------------------------------------------------------------------------
 * ① 配置读回（**文件文本是权威**）
 * ------------------------------------------------------------------------- */
phase('layer 1: config readback (file text is the authority)')
const goalLines = envText.split(/\r?\n/).filter((line) => /^\s*CHARACTER_GOAL_TOKENS\s*=/.test(line))
const commitmentLines = envText.split(/\r?\n/).filter((line) => /^\s*CHARACTER_COMMITMENT_TOKENS\s*=/.test(line))
record(
  'A',
  'A1',
  '**配置读回**：`.env` 文本里两个额度键都在，且取值 = 300 / 300',
  '300 / 300',
  `${KEYS.goal}=${fileEnv[KEYS.goal] ?? '（未设）'} · ${KEYS.commitment}=${fileEnv[KEYS.commitment] ?? '（未设）'} · 文件=${basename(envPath)}`,
  fileEnv[KEYS.goal] === String(EXPECTED.goal) && fileEnv[KEYS.commitment] === String(EXPECTED.commitment)
)
record(
  'A',
  'A2',
  '**唯一性**：每个键在文件里**只出现一次**（重复键会让"配置里写了什么"含混 ⇒ 拒绝）',
  '各 1 行',
  `${KEYS.goal} ${String(goalLines.length)} 行 · ${KEYS.commitment} ${String(commitmentLines.length)} 行`,
  goalLines.length === 1 && commitmentLines.length === 1
)
const flags = readKernelFlags({ ...fileEnv })
record(
  'A',
  'A3',
  '**解析读回**：用**文件文本**解析出的 flags 与文件一致，且目标域总开关 on（域关着时额度是死配置）',
  'goal=300 · commitment=300 · goals=on',
  `goalTokens=${String(flags.goalTokens)} · commitmentTokens=${String(flags.commitmentTokens)} · goalsEnabled=${String(flags.goalsEnabled)}`,
  flags.goalTokens === EXPECTED.goal && flags.commitmentTokens === EXPECTED.commitment && flags.goalsEnabled
)
/** 与基础设施缺省一致的字符级量化器（3 字符 ≈ 1 token） */
const quantify = (text: string): number => Math.ceil(text.length / 3)
const CHARACTER = 'char:su-mu-wei'
const goalFixture: GoalState = {
  goalId: 'gol:m10-1-readback' as GoalState['goalId'],
  characterId: CHARACTER,
  owner: entityRef('character', CHARACTER),
  origin: 'user_requested',
  sourceRefs: [{ conversationEventId: 'cev:m10-1-readback' as never, fingerprint: 'fp-readback' }],
  revision: 1,
  statement: '把提纲写完',
  successCriterion: { kind: 'user_report' },
  status: 'active',
  priority: 'normal',
  dependencies: [],
  time: { recordedAt: 1_760_000_000_000 },
}
const goalItem: GoalContextItem = { goal: goalFixture, rowKey: `goal:${goalFixture.goalId}` }
const rowsFixture: readonly CommitmentFactRow[] = [
  { goalId: 'gol:met', scope: '下次继续时给你三个步骤', status: 'fulfilled', criterionKind: 'conversation_output' },
]
const compileInput: ContextCompileInput = {
  characterId: CHARACTER as never,
  currentInput: '我们接着上次的来',
  now: 1_760_000_000_000,
}
const goalSections = await createGoalStateProvider({
  maxTokens: flags.goalTokens,
  quantify,
  select: () => ({ ordered: [goalItem], withdrawnEventIds: new Set<string>() }),
}).provide(compileInput)
const commitmentSections = await createCommitmentStateProvider({
  rows: async () => rowsFixture,
  maxTokens: flags.commitmentTokens,
  quantify,
}).provide(compileInput)
const commitmentText = commitmentSections.map((section) => section.content).join('\n')
record(
  'A',
  'A4',
  '**激活额度下真的能渲染**（用**网关注册的那两个工厂**）：`goal-state` ≥1 个 section · 约定块 ≥1 个 section 且终态行含「不要再提」',
  '两个块各 ≥1',
  `goal=${String(goalSections.length)} · commitment=${String(commitmentSections.length)} · 含「不要再提」=${String(commitmentText.includes(COMMITMENT_DO_NOT_RAISE))}`,
  goalSections.length >= 1 &&
    goalSections.some((section) => section.content.includes(goalFixture.statement)) &&
    commitmentSections.length >= 1 &&
    commitmentText.includes(COMMITMENT_DO_NOT_RAISE)
)
let offSelectCalls = 0
const offGoal = await createGoalStateProvider({
  maxTokens: 0,
  quantify,
  select: () => {
    offSelectCalls += 1
    return { ordered: [goalItem], withdrawnEventIds: new Set<string>() }
  },
}).provide(compileInput)
const offCommitment = await createCommitmentStateProvider({
  rows: async () => rowsFixture,
  maxTokens: 0,
  quantify,
}).provide(compileInput)
record(
  'A',
  'A5',
  '**回滚档可表达**（"删两行即回滚"的判据）：额度 0 ⇒ 两个块都产 **0 个 section**，且目标侧连候选都不取',
  '0 / 0 且不取候选',
  `sections=${String(offGoal.length)}/${String(offCommitment.length)} · 取候选次数=${String(offSelectCalls)}`,
  offGoal.length === 0 && offCommitment.length === 0 && offSelectCalls === 0
)

/* ---------------------------------------------------------------------------
 * ② 装配读回
 * ------------------------------------------------------------------------- */
phase('layer 2: assembly readback')
const mainCode = codeLinesOf(readSrc('src/main.ts')).join('\n')
const gatewayCode = codeLinesOf(readSrc('src/kernel/app/turn-gateway.ts')).join('\n')
const budgetWired =
  /goalTokens:\s*this\.flags\.goalTokens/.test(mainCode) &&
  /commitmentTokens:\s*this\.flags\.commitmentTokens/.test(mainCode)
record(
  'B',
  'B1',
  '**额度接线在场**：`main.ts` 的**代码**里把两个额度真的传进 `recallBudget`（否则额度是死配置）',
  '两条都在场',
  `goalTokens=${String(/goalTokens:\s*this\.flags\.goalTokens/.test(mainCode))} · commitmentTokens=${String(/commitmentTokens:\s*this\.flags\.commitmentTokens/.test(mainCode))}`,
  budgetWired
)
const portWired = /commitmentFactRows:/.test(mainCode)
record(
  'B',
  'B2',
  '**只读端口在场**：装配层真的传了 `commitmentFactRows:`（光有额度与渲染器不够 —— `L-M11-10` 的形状）',
  '端口在场',
  portWired ? '在场' : '**不在场**',
  portWired
)
const gatewayGated = /commitmentTokens\s*>\s*0/.test(gatewayCode)
const gatewayRegisters = /createCommitmentStateProvider\s*\(/.test(gatewayCode)
record(
  'B',
  'B3',
  '**网关门控**：约定 provider 真的被注册，且**按额度门控**（额度 0 ⇒ 连一次只读查询都不发生）',
  '注册 + 门控',
  `注册=${String(gatewayRegisters)} · 门控=${String(gatewayGated)}`,
  gatewayRegisters && gatewayGated
)
const noShadowGoalBudget = /\(this\.options\.recallBudget\s*\?\?\s*DEFAULT_CONTEXT_BUDGET\)\.goalTokens/.test(
  gatewayCode
)
record(
  'B',
  'B4',
  '**无影子默认**（`D27`）：目标状态块的额度取自**那一个** `ContextBudget`，网关里没有第二处硬编码额度',
  '取自那一个 ContextBudget',
  noShadowGoalBudget ? '取自那一个' : '**未取到**',
  noShadowGoalBudget
)

/* ---------------------------------------------------------------------------
 * ③ 首次行为读回
 * ------------------------------------------------------------------------- */
phase('layer 3: first-use readback')
/*
 * ⚠️ **未观察到就写 `NOT OBSERVED`**（M10 计划 §18.2 逐字）：配置开着**不等于**行为被观测过。
 *    本门**没有**任何声称 OBSERVED 的分支 —— 这是判据，不是措辞。
 */
const firstUseObserved = false
record(
  'C',
  'C1',
  '**首次行为读回**：真实首聊之前一律 `NOT OBSERVED`（**不凭配置宣布**；本门没有任何声称 OBSERVED 的分支）',
  'NOT OBSERVED',
  '**NOT OBSERVED**（待真实首聊：接受事件 → 投影 → context → 可见回复对账）',
  !firstUseObserved
)
/*
 * ⚠️ **判据不许自匹配**：本段源码里就写着这些名字与那个包名字符串 ⇒ 包名拆开拼，
 *    否则 `includes('plugin-sql')` 会把**写判据的这一行**当成违规（`m10.1:activate` 的 `A1` 踩过一次）。
 */
const ownCode = codeLinesOf(readFileSync(join(REPO_ROOT, 'scripts/m10.1-activation-readback.ts'), 'utf8')).join('\n')
const sqlPluginName = `plugin${'-'}sql`
const opensDatabase =
  /\b(initDatabase|getRawDb|prepareProductionOpen|allowProductionDatabase)\s*\(/.test(ownCode) ||
  ownCode.includes(sqlPluginName)
record(
  'C',
  'C2',
  '**本门不开数据库**：源码（去注释后）里没有任何开库 / 生产放行调用 ⇒ 第三层不可能靠"顺手开一下真实库"得来',
  '0 处开库调用',
  opensDatabase ? '**出现了开库调用**' : '0 处（只有配置文本与源码文本）',
  !opensDatabase
)
record(
  'C',
  'C3',
  '**不假装读到库**：本门读不到"生产里现有几条目标/承诺"，于是**如实标注未读**（要读那份计数须走带 token 的只读 opener，独立授权）',
  '如实标注未读',
  '生产投影计数 = **未读**（本门不开库）',
  true
)

const denominators = {
  configKeys: Object.keys(KEYS).length,
  checks: checks.length,
  layers: 3,
  sectionsAtActivatedBudget: goalSections.length + commitmentSections.length,
}
record(
  'C',
  'C4',
  '**非零分母**：四类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  '全部 > 0',
  JSON.stringify(denominators),
  Object.values(denominators).every((value) => value > 0)
)

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
phase('done')
const finalPassed = checks.filter((check) => check.pass).length
const finalFailed = checks.length - finalPassed
const finalVerdict: 'PASS' | 'FAIL' = finalFailed === 0 ? 'PASS' : 'FAIL'
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-activation-readback', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-activation-readback@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  envFile: envPath,
  mode: 'read-only' as const,
  opensDatabase: false,
  activated: flags.goalTokens > 0 || flags.commitmentTokens > 0,
  flags: { goalTokens: flags.goalTokens, commitmentTokens: flags.commitmentTokens, goalsEnabled: flags.goalsEnabled },
  layers: {
    config: { [KEYS.goal]: fileEnv[KEYS.goal] ?? null, [KEYS.commitment]: fileEnv[KEYS.commitment] ?? null },
    assembly: { budgetWired, portWired, gatewayGated, gatewayRegisters, noShadowGoalBudget },
    firstUse: 'NOT OBSERVED',
    productionCounts: 'NOT READ（本门不开库 ⇒ 不假装读到）',
  },
  denominators,
  checks,
  summary: { total: checks.length, passed: finalPassed, failed: finalFailed },
  verdict: finalVerdict,
  disclaimer:
    '本门只做**配置 / 装配 / 首次行为**三层读回，且**不打开真实库**。' +
    '它**不**主张行为已被观测（FIRST-USE = NOT OBSERVED），也**不**主张生产里现有多少目标/承诺（未读）。',
}
writeFileSync(join(dir, 'activation-readback.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-activation-readback',
  head,
  headShort: head.slice(0, 12),
  branch,
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'activation-readback',
  counts: { total: checks.length, passed: finalPassed, failed: finalFailed },
  phases: ['config', 'assembly', 'first-use'],
  supersedes: null,
  notes:
    `m10.1:activation:readback（goal=${String(flags.goalTokens)} · commitment=${String(flags.commitmentTokens)}` +
    ` · goals=${String(flags.goalsEnabled)} · FIRST-USE=NOT OBSERVED · **本门不开真实库**）`,
})
for (const check of checks) {
  console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label.slice(0, 78)}`)
  console.log(`        期望 ${check.expected} · 实测 ${check.actual}`)
}
console.log(`runId: ${runId}`)
console.log(`verdict: ${finalVerdict}（${String(finalPassed)}/${String(checks.length)}）`)
if (finalVerdict === 'FAIL') process.exitCode = 1
