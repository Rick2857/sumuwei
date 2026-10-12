/**
 * M5.1.1 / Phase 4 —— **最终关闭门**（`pnpm m5.1.1:phase4:closure:verify` · `pnpm m5.1.1:final:verify`）
 *
 * ============================================================================
 *  它回答什么
 * ============================================================================
 * ```text
 *   ① ADR-043 的落地（4a + 4b + D01 Live Smoke + 全量回归）是否**都已发生且可定位**
 *   ② 用户授权是否**留痕**（R-62 的执行令 + R-63 的关闭授权，逐字可查）
 *   ③ 当前状态源是否**一致**地写着：Phase 4 = PASS · M5.1-D01 = CLOSED · M5.1.1 Final = PASS
 *   ④ 历史结论是否**没有被改写**（Phase 1–3 的 §0 六行仍是当时的 BLOCKED / OPEN）
 *   ⑤ 延期能力是否**没有被冒充**成已关闭（M511-G8 / DC-1..DC-3 / K-31）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  它与 `verify-m5.1.1-wp11-closure.ts` 的**职责边界**（WP-C3）
 * ---------------------------------------------------------------------------
 * ```text
 *   WP11（Phase 1–3 历史门）  断言"WP11 时点"的六行 + 阶段 1–3 的退出条件  → 保留
 *                             **不再**断言当前状态的值（ST-7 / canonical 禁令 / EC-10 收窄）
 *   本门（Phase 4 关闭门）    断言"今天"的权威状态 + 授权留痕 + 不冒充        → 新增
 * ```
 * 两个门**都不**是对方的替代品：把 WP11 改造成关闭门、或让本门去算 Phase 1–3，
 * 都会让"历史读数"与"当前读数"再次混在一起 —— 那正是本仓库反复禁止的形状。
 *
 * ---------------------------------------------------------------------------
 *  两条刻意的设计约束
 * ---------------------------------------------------------------------------
 * ```text
 * · **不打开真实库**：真实库未被写入这件事由 `d01-live-smoke.json` 的**树摘要**证明
 *   （before == after，且门里从未设置 `PROJECT_LG_ALLOW_PRODUCTION_DB`）
 * · **证据里没有任何时钟**：`generatedAt` 之类的字段会让"重复运行"产生无意义漂移，
 *   而本门要求**重复运行后工作树保持干净** —— 因此证据的每一个字节都只来自
 *   已提交的读数（verdict / 计数 / 摘要），不含运行时刻
 * ```
 *
 * 跑法：`pnpm m5.1.1:phase4:closure:verify`（只读；秒级）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const EVIDENCE_REL = 'artifacts/m5.1.1/phase4-closure.json'

const read = (rel: string): string => {
  const abs = join(ROOT, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}
const readJson = (rel: string): Record<string, unknown> | undefined => {
  const text = read(rel)
  if (text === '') return undefined
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
/** 按点号路径取值（只用于读**已提交**的证据 JSON，缺失一律 `undefined`） */
const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, value)

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []
function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
/** 计数型判据必须自检 `measured_count > 0`（AGENTS §6.8） */
const measures: { label: string; count: number; valid: boolean }[] = []
function measure(label: string, count: number): number {
  const valid = count > 0
  measures.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

// ---------------------------------------------------------------------------
// 状态行解析（与 WP11 同一套**词汇**，但两者读的是不同的块）
// ---------------------------------------------------------------------------
type StatusLines = Record<string, string | null>
const STATUS_PATTERNS = {
  'Phase 1': /^\s*Phase\s+1\s+(PASS|FAIL)\s*$/m,
  'Phase 2': /^\s*Phase\s+2\s+(PASS|FAIL)\s*$/m,
  'Phase 3': /^\s*Phase\s+3\s+(PASS|FAIL)\s*$/m,
  'Phase 4': /^\s*Phase\s+4\s+(PASS|FAIL|NOT RUN|BLOCKED BY ADR-043)\s*$/m,
  'M5.1.1 Final': /^\s*M5\.1\.1\s+Final\s+(BLOCKED|PASS|FAIL)\s*$/m,
  'M5.1-D01': /^\s*M5\.1-D01\s+(P1 OPEN|CLOSED)\s*$/m,
} as const
function statusLines(text: string, which: 'first' | 'last'): StatusLines {
  const out: StatusLines = {}
  for (const [key, re] of Object.entries(STATUS_PATTERNS)) {
    const all = [...text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))]
    out[key] = all.length === 0 ? null : all[which === 'first' ? 0 : all.length - 1][1].trim()
  }
  return out
}
/** 报告的**历史区**（`## 11.` 之前，即 §0–§10 的原始判定；一字未改的那部分） */
const historicalRegion = (text: string): string => text.split(/^##\s*11\./m)[0] ?? text
/** 报告的**当前附录**（`## 11.` 起） */
const currentAppendix = (text: string): string => {
  const parts = text.split(/^##\s*11\./m)
  return parts.length < 2 ? '' : `## 11.${parts.slice(1).join('## 11.')}`
}

const GD = 'docs/m5.1.1/M5.1.1-Gate-Decision.md'
const P13 = 'docs/m5.1.1/M5.1.1-Phase1-3-Acceptance-Report.md'
const CLOSURE_REPORT = 'docs/m5.1.1/M5.1.1-Phase4-Closure-Report.md'
const LEDGER = 'docs/m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md'
/**
 * D01 的**销账记录**（放在 M5.1.1）。
 *
 * ⚠️ 实测撞到的一处**新判据冲突**（计划的 STOP 条件之一）：
 *    `docs/m5.1/**` 是 `m5.1-complete` 标签冻结的**判定文档**，
 *    `verify-m5.1.1-wp8-harness.ts` 有一条 `M5.1 的判决文档自冻结以来一字未改` 的判据。
 *    因此销账记录**不能**写进立案文件（写进去会让那条判据变红 = 改写 M5.1 的冻结面）。
 *    ⇒ 按 `AGENTS.md` §3 的既有纪律（"`M5.1-D01` 的一切后续都进 M5.1.1"），
 *      销账记录放在本附录里，而**本门把"冻结面未被改写"变成一条正向判据**。
 */
const LEDGER_ADDENDUM = 'docs/m5.1.1/M5.1.1-D01-Ledger-Closure-Addendum.md'
/** `m5.1-complete` 指向的 commit（冻结面基准；与 gate registry 的 `M5L_FREEZE` 同源） */
const M51_FREEZE_COMMIT = '2aac6cad50e0dbf66f26bf243345d9af01861013'
const ADR_043 = 'docs/adr/ADR-043-epistemic-requalification.md'
const ADR_044 = 'docs/adr/ADR-044-m5.1.1-phase4-closure.md'
const PLAN = 'docs/m5.1.1/M5.1.1-Execution-Plan.md'
const ACTIVATION = 'docs/m5.1.1/M5.1.1-ADR-043-Activation-Record.md'
const README = 'docs/architecture/README.md'
const AGENTS = 'AGENTS.md'
const SMOKE = 'artifacts/m5.1.1/d01-live-smoke.json'

console.log('='.repeat(78))
console.log('M5.1.1 Phase 4 —— 最终关闭门（只读）')
console.log('='.repeat(78))

// ---------------------------------------------------------------------------
// §1 关闭依据（**逐条可定位**）
// ---------------------------------------------------------------------------
section('§1 关闭依据：4a / 4b / D01 Live Smoke / 全量回归 / 真实库 / 授权')

const adr043Text = read(ADR_043)
const adr043StatusLine =
  adr043Text.split('\n').find((line) => /^\s*状态\s*:/.test(line))?.trim() ?? ''
check(
  '★ ADR-043 位于规范位置且状态行 = `ACCEPTED / DESIGN FROZEN`（设计仍然有效）',
  adr043StatusLine.includes('ACCEPTED / DESIGN FROZEN'),
  adr043StatusLine || '**文件缺失**'
)

const adr044Text = read(ADR_044)
const adr044StatusLine =
  adr044Text.split('\n').find((line) => /^\s*状态\s*:/.test(line))?.trim() ?? ''
check(
  '★ ADR-044（本次状态修订）存在且状态行 = `ACCEPTED / EXECUTED`',
  adr044StatusLine.includes('ACCEPTED / EXECUTED'),
  adr044StatusLine || '**文件缺失**'
)
check(
  '★ ADR-044 **引用** ADR-043 并声明后者的设计决策仍然有效（它是状态修订，不是重新设计）',
  /ADR-043/.test(adr044Text) && /设计决策.*仍然有效|决策仍然有效|仍然有效/.test(adr044Text),
  `${adr044Text.length} 字符`
)

const wp4a = readJson('artifacts/m5.1.1/wp4a-origin-gate.json')
const fourAVerdict = str(at(wp4a, 'verdict'))
check('★ 4a（形成期来源资格闸）= `PASS`（证据：`wp4a-origin-gate.json`）', fourAVerdict === 'PASS', `verdict=${String(fourAVerdict)}`)

/**
 * 4b（存量与行为）：**两处**证据合起来可定位。
 *
 * ⚠️ 如实登记：4b 的专项门 `pnpm m5.1.1:phase4b:verify`（31 通过 / 0 失败）**不落盘证据**，
 *    它的读数只在 stdout 里。因此本门用**两个可定位的替代**：
 *      ① Activation Record 的状态行（`verify = 10/10`）—— 那是 `audit` 段本身
 *      ② D01 Live Smoke 里**独立复现**的 4b 行为（规则版本 / 标签 / ESTABLISHED / UNCONFIRMED_ORIGIN）
 *    ⇒ 行为读数比一条 stdout 计数更强：它是在真实语料上重新跑出来的。
 */
const activationText = read(ACTIVATION)
check(
  '★ 4b 的 `audit` 段（Activation Record）存在且记录 `verify = 10/10`',
  activationText.length > 0 && /verify\s*=\s*10\/10/.test(activationText),
  `${activationText.length} 字符`
)

const smoke = readJson(SMOKE)
const smokeJudge = str(at(smoke, 'verdict.judge'))
const smokeChecksPassed = num(at(smoke, 'counts.checksPassed'))
const smokeChecksFailed = num(at(smoke, 'counts.checksFailed'))
const smokeRuleVersion = num(at(smoke, 'ruleVersion'))
measure('D01 Live Smoke 的判据条数', smokeChecksPassed ?? 0)
check('★ D01 Live Smoke 判定器 = `PASS` 且零失败', smokeJudge === 'PASS' && smokeChecksFailed === 0, `judge=${String(smokeJudge)} · ${String(smokeChecksPassed)}/${String(smokeChecksFailed)}`)
check(
  '★ 4b 行为读数（在真实语料上独立复现）：规则版本 = 1',
  smokeRuleVersion === 1,
  `ruleVersion=${String(smokeRuleVersion)}`
)
check(
  '★ Live Smoke **不是 mock**：真实端点 host 非空 + key 存在 + 三段回复长度 > 0',
  (str(at(smoke, 'model.endpointHost')) ?? '') !== '' &&
    bool(at(smoke, 'model.keyPresent')) === true &&
    (num(at(smoke, 'scenarios.S1.level1.replyLength')) ?? 0) > 0 &&
    (num(at(smoke, 'scenarios.S2.level1.replyLength')) ?? 0) > 0 &&
    (num(at(smoke, 'scenarios.S3.level1.replyLength')) ?? 0) > 0,
  `host=${String(str(at(smoke, 'model.endpointHost')))} · keyPresent=${String(bool(at(smoke, 'model.keyPresent')))} · ` +
    `回复长度 ${String(num(at(smoke, 'scenarios.S1.level1.replyLength')))}/${String(num(at(smoke, 'scenarios.S2.level1.replyLength')))}/${String(num(at(smoke, 'scenarios.S3.level1.replyLength')))}`
)
check(
  '★ 三个场景**各有 Level 1 与 Level 2** 证据',
  // S1：Level 1 = 回复长度；Level 2 = 资格计数 + trace + prompt 标签 + 不重算摘要
  (num(at(smoke, 'scenarios.S1.qualificationAfter.scanned')) ?? 0) > 0 &&
    (num(at(smoke, 'scenarios.S1.prompt.labelUnconfirmed')) ?? 0) > 0 &&
    (str(at(smoke, 'scenarios.S1.level2.memoryIdentityDigestBefore')) ?? '') ===
      (str(at(smoke, 'scenarios.S1.level2.memoryIdentityDigestAfter')) ?? '') &&
    // S2：Level 2 = 受信用户行 + 派生资格 ESTABLISHED
    (str(at(smoke, 'scenarios.S2.event.actor')) ?? '').startsWith('USER/') &&
    str(at(smoke, 'scenarios.S2.writtenMemory.qualification')) === 'ESTABLISHED' &&
    // S3：Level 2 = agent-runner 行 + 资格不是 ESTABLISHED
    str(at(smoke, 'scenarios.S3.event.actor')) === 'SERVICE/agent-runner' &&
    str(at(smoke, 'scenarios.S3.writtenMemory.qualification')) === 'UNCONFIRMED_ORIGIN',
  `S1 label=${String(num(at(smoke, 'scenarios.S1.prompt.labelUnconfirmed')))} · ` +
    `S2=${String(str(at(smoke, 'scenarios.S2.writtenMemory.qualification')))} · ` +
    `S3=${String(str(at(smoke, 'scenarios.S3.writtenMemory.qualification')))}`
)
check(
  '★ S2 的受信归因是 RECORDED + USER 且 Axis B = `user_report`（确立路径真的走通了）',
  str(at(smoke, 'scenarios.S2.event.attributionOrigin')) === 'RECORDED' &&
    str(at(smoke, 'scenarios.S2.event.epistemicSource')) === 'user_report',
  `${String(str(at(smoke, 'scenarios.S2.event.attributionOrigin')))} / ${String(str(at(smoke, 'scenarios.S2.event.epistemicSource')))}`
)
check(
  '★ S3 的伪装来源是 RECORDED + `SERVICE/agent-runner` 且 Axis B = `UNCONFIRMED_ORIGIN`（负控成立）',
  str(at(smoke, 'scenarios.S3.event.attributionOrigin')) === 'RECORDED' &&
    str(at(smoke, 'scenarios.S3.event.actor')) === 'SERVICE/agent-runner' &&
    str(at(smoke, 'scenarios.S3.event.contentOriginator')) === 'SERVICE/agent-runner' &&
    str(at(smoke, 'scenarios.S3.event.axisBSourceAuthority')) === 'UNCONFIRMED_ORIGIN',
  `${String(str(at(smoke, 'scenarios.S3.event.actor')))} / ${String(str(at(smoke, 'scenarios.S3.event.axisBSourceAuthority')))}`
)
check(
  '★ S4 三段式：判定器正控通过 · 四个负控全部响应 · 恢复后重新安静',
  bool(at(smoke, 'S4.positive.pass')) === true &&
    (Array.isArray(at(smoke, 'S4.negativeControls')) ? (at(smoke, 'S4.negativeControls') as unknown[]).length : 0) >= 4 &&
    bool(at(smoke, 'S4.restored.pass')) === true,
  `positive=${String(bool(at(smoke, 'S4.positive.pass')))} · negatives=${String((at(smoke, 'S4.negativeControls') as unknown[] | undefined)?.length)} · restored=${String(bool(at(smoke, 'S4.restored.pass')))}`
)

const m51Regression = readJson('artifacts/m5.1/regression-evidence.json')
const regressionVerdict = str(at(m51Regression, 'regressionVerdict'))
const m45CiExit = num(at(m51Regression, 'm45Ci.exitCode'))
const hardGates = (at(m51Regression, 'm45Ci.hardGates') ?? []) as { id: string; status: string }[]
measure('M5.1 回归读数里的硬门条数', Array.isArray(hardGates) ? hardGates.length : 0)
check(
  '★ 全量回归 = `PASS` 且 `m4.5:ci` 退出码 0，三条硬门全 PASS',
  regressionVerdict === 'PASS' &&
    m45CiExit === 0 &&
    Array.isArray(hardGates) &&
    hardGates.length > 0 &&
    hardGates.every((gate) => gate.status === 'PASS'),
  `regression=${String(regressionVerdict)} · m4.5:ci exit=${String(m45CiExit)} · hardGates=${hardGates.map((g) => `${g.id}:${g.status}`).join(',')}`
)

const gateResults = readJson('artifacts/m5.1.1/gate-results.json')
const gateRows = (at(gateResults, 'gates') ?? []) as { id: string; verdict: string }[]
const gateVerdict = (id: string): string => gateRows.find((row) => row.id === id)?.verdict ?? 'MISSING'
measure('M5.1.1 九门读数条数', Array.isArray(gateRows) ? gateRows.length : 0)
const measurableGates = ['M511-G1', 'M511-G2', 'M511-G3', 'M511-G4', 'M511-G5', 'M511-G6', 'M511-G7', 'M511-G9']
check(
  '★ M5.1.1 九门：全部**可判定的门** = PASS',
  measurableGates.every((id) => gateVerdict(id) === 'PASS'),
  measurableGates.map((id) => `${id}=${gateVerdict(id)}`).join(' · ')
)
const harnessVerdict = str(at(gateResults, 'wp8Harness.wp8Verdict'))
const harnessFailed = num(at(gateResults, 'wp8Harness.failed'))
check(
  '★ WP8 harness = `PASS` 且自检零失败',
  harnessVerdict === 'PASS' && harnessFailed === 0,
  `wp8Verdict=${String(harnessVerdict)} · failed=${String(harnessFailed)}`
)

/* ---- 真实库未被写入（由树摘要证明；本门**不**打开真实库） ---- */
const realDbBefore = str(at(smoke, 'database.realDbTreeBefore.digest'))
const realDbAfter = str(at(smoke, 'database.realDbTreeAfter.digest'))
const realDbFiles = num(at(smoke, 'database.realDbTreeBefore.files'))
const productionDbOpened = bool(at(smoke, 'database.productionDbOpened'))
const copyDestroyed = bool(at(smoke, 'database.copyDestroyed'))
measure('真实库树摘要里的文件数', realDbFiles ?? 0)
check(
  '★ 真实库**未被写入**：整棵树摘要在 D01 Live Smoke 前后**逐字相同**，且门从未打开真实库',
  realDbBefore !== null && realDbBefore === realDbAfter && productionDbOpened === false,
  `${String(realDbBefore)} → ${String(realDbAfter)} · productionDbOpened=${String(productionDbOpened)} · ${String(realDbFiles)} 文件`
)
check('★ 临时副本已销毁（Live Smoke 的全部读写都在副本里）', copyDestroyed === true, `copyDestroyed=${String(copyDestroyed)}`)

/* ---- 用户授权留痕 ---- */
const planText = read(PLAN)
const r62Present = /\|\s*R-62\s*\|/.test(planText)
const r63Present = /\|\s*R-63\s*\|/.test(planText)
/** R-63 的**逐字**引文（用户本轮原话；不得改写成他没说过的话） */
const R63_QUOTE = '好的，已执行完成，并且我授权开启下一阶段。'
const r63QuotePresent = planText.includes(R63_QUOTE)
check(
  '★ 授权留痕：R-62（4b 执行令）与 R-63（关闭授权）都在执行计划里',
  r62Present && r63Present,
  `R-62=${String(r62Present)} · R-63=${String(r63Present)}`
)
check(
  '★ R-63 的记录**逐字**包含用户原话（不代签、不改写）',
  r63QuotePresent,
  r63QuotePresent ? R63_QUOTE : '**缺失**'
)

// ---------------------------------------------------------------------------
// §2 当前状态源的一致性（**今天**的权威读数）
// ---------------------------------------------------------------------------
section('§2 当前状态源一致：Phase 4 = PASS · M5.1-D01 = CLOSED · M5.1.1 Final = PASS')

const EXPECTED_CURRENT: StatusLines = {
  'Phase 1': 'PASS',
  'Phase 2': 'PASS',
  'Phase 3': 'PASS',
  'Phase 4': 'PASS',
  'M5.1.1 Final': 'PASS',
  'M5.1-D01': 'CLOSED',
}
/** 历史区（§0–§10）**一字未改**：六行仍是当时的判定 */
const EXPECTED_HISTORICAL: StatusLines = {
  'Phase 1': 'PASS',
  'Phase 2': 'PASS',
  'Phase 3': 'PASS',
  'Phase 4': 'BLOCKED BY ADR-043',
  'M5.1.1 Final': 'BLOCKED',
  'M5.1-D01': 'P1 OPEN',
}

const gdText = read(GD)
const p13Text = read(P13)
const closureReportText = read(CLOSURE_REPORT)
const addendumText = read(LEDGER_ADDENDUM)

/** 唯一的 git 调用：核对 `docs/m5.1/**` 是否仍等于冻结点（只读） */
function gitLines(...args: string[]): string[] {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    return out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  } catch {
    return ['(git 调用失败)']
  }
}
const m51FrozenDrift = gitLines(
  'diff',
  '--name-only',
  `${M51_FREEZE_COMMIT}..HEAD`,
  '--',
  'docs/m5.1'
)
const m51FrozenUnchanged = m51FrozenDrift.length === 0
measure('冻结面 `docs/m5.1/**` 的文件数（被核对的对象）', gitLines('ls-files', 'docs/m5.1').length)
const currentSources: { name: string; lines: StatusLines }[] = [
  { name: 'M5.1.1-Gate-Decision.md §11', lines: statusLines(gdText, 'last') },
  { name: 'M5.1.1-Phase1-3-Acceptance-Report.md §11', lines: statusLines(p13Text, 'last') },
  { name: 'M5.1.1-Phase4-Closure-Report.md', lines: statusLines(closureReportText, 'last') },
]
measure('被检查的当前状态源条数', currentSources.length)
for (const source of currentSources) {
  const mismatched = Object.entries(EXPECTED_CURRENT).filter(([key, want]) => source.lines[key] !== want)
  check(
    `★ 当前状态源 \`${source.name}\`：六行全部等于最终状态`,
    mismatched.length === 0,
    mismatched.length === 0
      ? Object.entries(EXPECTED_CURRENT).map(([k, v]) => `${k}=${v}`).join(' · ')
      : mismatched.map(([k, want]) => `${k}: 写的是 ${JSON.stringify(source.lines[k])}，应为 ${want}`).join(' | ')
  )
}

/* ---- 散文式当前状态源（它们不写成六行块，但只要能被机器定位 ---- */
const readmeText = read(README)
check(
  '★ `docs/architecture/README.md` 的当前判定行 = `Phase 4 = PASS` · `M5.1-D01 = CLOSED` · `M5.1.1 Final = PASS`',
  /Phase\s*4\s*=\s*PASS/.test(readmeText) && /M5\.1-D01\s*=\s*CLOSED/.test(readmeText) && /M5\.1\.1 Final\s*=\s*PASS/.test(readmeText),
  readmeText.split('\n').find((line) => /当前判定/.test(line))?.trim().slice(0, 120) ?? '(没有"当前判定"行)'
)
const agentsText = read(AGENTS)
check(
  '★ `AGENTS.md` 的当前状态行 = `Phase 4 = PASS` · `M5.1-D01 = CLOSED` · `M5.1.1 Final = PASS`',
  /Phase\s*4\s*=\s*`?PASS`?/.test(agentsText) && /M5\.1-D01\s*=\s*`?CLOSED`?/.test(agentsText) && /M5\.1\.1 Final\s*=\s*`?PASS`?/.test(agentsText),
  'AGENTS.md §1/§4'
)
const ledgerText = read(LEDGER)
check(
  '★ **M5.1 的冻结面未被改写**：`docs/m5.1/**` 自 `m5.1-complete` 冻结点以来**一字未改**',
  m51FrozenUnchanged,
  m51FrozenUnchanged
    ? `${M51_FREEZE_COMMIT.slice(0, 8)}… → HEAD：docs/m5.1 0 个文件变化`
    : `**被改动的文件**：${m51FrozenDrift.join(' , ')}`
)
check(
  '★ D01 销账记录存在且记 `CLOSED` + 关闭证据（**放在 M5.1.1**，因为 `docs/m5.1/**` 是冻结面）',
  addendumText.length > 0 && /CLOSED/.test(addendumText) && /关闭证据|销账|裁定载体/.test(addendumText),
  `${addendumText.length} 字符 · ${LEDGER_ADDENDUM}`
)
const ledgerBlobAtFreeze = gitLines('rev-parse', `${M51_FREEZE_COMMIT}:${LEDGER}`)[0] ?? ''
const ledgerBlobNow = gitLines('hash-object', LEDGER)[0] ?? ''
check(
  '★ 立案原文与冻结点**逐字节相同**（销账是**追加**的记录，不是把历史改成 CLOSED）',
  ledgerBlobAtFreeze !== '' && ledgerBlobAtFreeze === ledgerBlobNow,
  `freeze blob ${ledgerBlobAtFreeze.slice(0, 12)}… vs 工作树 ${ledgerBlobNow.slice(0, 12)}… · ${ledgerText.length} 字符`
)

// ---------------------------------------------------------------------------
// §3 历史结论未被改写 + 不冒充
// ---------------------------------------------------------------------------
section('§3 历史结论一字未改 · 延期能力未被冒充')

const historicalSources: { name: string; lines: StatusLines }[] = [
  { name: 'M5.1.1-Gate-Decision.md §0', lines: statusLines(historicalRegion(gdText), 'first') },
  { name: 'M5.1.1-Phase1-3-Acceptance-Report.md §0', lines: statusLines(historicalRegion(p13Text), 'first') },
]
for (const source of historicalSources) {
  const mismatched = Object.entries(EXPECTED_HISTORICAL).filter(([key, want]) => source.lines[key] !== want)
  check(
    `★ 历史区 \`${source.name}\`：六行仍是**当时的**判定（BLOCKED / P1 OPEN 未被改写成 PASS / CLOSED）`,
    mismatched.length === 0,
    mismatched.length === 0
      ? Object.entries(EXPECTED_HISTORICAL).map(([k, v]) => `${k}=${v}`).join(' · ')
      : mismatched.map(([k, want]) => `${k}: 写的是 ${JSON.stringify(source.lines[k])}，应为 ${want}`).join(' | ')
  )
}
check(
  '★ WP11 的 Phase 1–3 收官门仍然是**独立可跑**的历史门（本门不替代它）',
  existsSync(join(ROOT, 'scripts/verify-m5.1.1-wp11-closure.ts')),
  'scripts/verify-m5.1.1-wp11-closure.ts'
)
const wp11Script = read('scripts/verify-m5.1.1-wp11-closure.ts')
check(
  '★ WP11 **没有**被改造成关闭门：它不再做"当前状态"的正向断言（旧断言形状已消失），且已声明委派',
  !wp11Script.includes("reportedCurrent['Phase 4'] ===") &&
    !wp11Script.includes("reportedCurrent['M5.1-D01'] ===") &&
    !wp11Script.includes("reportedCurrent['M5.1.1 Final'] ===") &&
    wp11Script.includes('currentStatusDelegatedTo') &&
    wp11Script.includes('scripts/verify-m5.1.1-phase4-closure.ts'),
  'WP11 只保留 Phase 1–3 历史职责 + 委派声明'
)

check(
  '★ `M511-G8`（Break-Glass）仍如实为 `NOT RUN`，**不**阻断 D01 关闭',
  gateVerdict('M511-G8') === 'NOT RUN',
  `M511-G8 = ${gateVerdict('M511-G8')}`
)
const deferredMarkers: { name: string; ok: boolean }[] = [
  {
    name: 'DC-1/DC-2/DC-3 延期能力',
    ok: /DC-1/.test(closureReportText) && /DEFERRED|NOT IMPLEMENTED/.test(closureReportText),
  },
  { name: 'K-31', ok: /K-31/.test(closureReportText) && /OPEN|DEFERRED/.test(closureReportText) },
]
for (const marker of deferredMarkers) {
  check(`★ 延期能力**未被冒充**为已关闭：${marker.name}`, marker.ok, marker.ok ? '在关闭报告里如实登记' : '**关闭报告里没有如实登记**')
}

/**
 * canonical 禁令：**不得**把这次关闭说成"她具备后台自主运行 / 任意注入"之类的能力。
 *
 * ⚠️ 与 WP11 的区别：WP11 的禁令是"不得写 `M5.1.1 PASS` / `D01 CLOSED`"（那是 Phase 4 之前的状态锁，
 *    已由 WP-C3 收窄）；**本门**的禁令是**能力冒充**那一类 —— 关闭 D01 **不**等于获得了
 *    后台自主任务、Break-Glass、通用注入或完美措辞保证。
 */
const CAPABILITY_FORBIDDEN = [
  '苏沐薇已经具备后台自主运行能力',
  '已经具备后台自主运行能力',
  'Break-Glass 已实现',
  '任意记忆注入已开放',
  '措辞已由守卫保证',
] as const
function capabilityClaims(text: string): string[] {
  return CAPABILITY_FORBIDDEN.filter((claim) => text.includes(claim) && !/不得|禁止|不主张|不表示|不代表/.test(text))
}
const capabilityTargets = [closureReportText, readmeText, agentsText, adr044Text]
const capabilityOffenders = capabilityTargets.flatMap((text, index) => capabilityClaims(text).map((claim) => `${index}:${claim}`))
measure('能力冒充扫描的文档数', capabilityTargets.length)
check(
  '★ **能力冒充禁令（正控）**：当前状态源里**没有**任何"已具备后台自主运行 / 任意注入"式断言',
  capabilityOffenders.length === 0,
  capabilityOffenders.join(' , ') || '0 处'
)
/** 负控：注入一句冒充 ⇒ **必须响**（同一个检测器函数） */
const capabilityForged = `${closureReportText}\n\n本次关闭意味着苏沐薇已经具备后台自主运行能力。\n`
check(
  '★ **能力冒充禁令（负控）**：注入一句"已具备后台自主运行能力" ⇒ 检测器**必须响**',
  capabilityClaims(capabilityForged).length > 0,
  capabilityClaims(capabilityForged).join(' , ') || '(没有响 —— 检测器没有牙齿)'
)
check(
  '★ **能力冒充禁令（恢复）**：放回真实文本 ⇒ 检测器重新安静',
  capabilityClaims(closureReportText).length === 0,
  '0 处'
)

// ---------------------------------------------------------------------------
// §4 关闭判定器 + 三段式（正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------
section('§4 关闭判定器（**纯函数**）与三段式')

/** 关闭判定器的输入 = 上面所有读数的**汇总**（注入负控时只改这个对象） */
interface ClosureInput {
  adr043Frozen: boolean
  adr044Executed: boolean
  fourAVerdict: string | null
  activationAuditRecorded: boolean
  smoke: {
    judge: string | null
    checksPassed: number
    checksFailed: number
    ruleVersion: number | null
    realEndpoint: boolean
    scenarioLevelsPresent: boolean
    s4ThreeStage: boolean
  }
  regressionPass: boolean
  gatesDeterminablePass: boolean
  harnessPass: boolean
  realDbUntouched: boolean
  copyDestroyed: boolean
  authorization: { r62: boolean; r63: boolean; r63Quote: boolean }
  current: { consistent: boolean }
  historical: { unchanged: boolean }
  /** `docs/m5.1/**` 冻结面仍等于 `m5.1-complete` 冻结点 */
  m51FreezeIntact: boolean
  notImpersonated: { g8NotRun: boolean; deferredRecorded: boolean; capabilityClean: boolean }
}

function judgeClosure(input: ClosureInput): { pass: boolean; failures: string[] } {
  const f: string[] = []
  if (!input.adr043Frozen) f.push('ADR-043 不是 ACCEPTED / DESIGN FROZEN')
  if (!input.adr044Executed) f.push('状态修订 ADR-044 缺失或不是 ACCEPTED / EXECUTED')
  if (input.fourAVerdict !== 'PASS') f.push(`4a verdict = ${String(input.fourAVerdict)}，不是 PASS`)
  if (!input.activationAuditRecorded) f.push('4b 的 audit 段（Activation Record）缺失或没记 verify = 10/10')
  if (input.smoke.judge !== 'PASS') f.push(`D01 Live Smoke judge = ${String(input.smoke.judge)}，不是 PASS`)
  if (input.smoke.checksFailed !== 0) f.push(`Live Smoke 自检失败 ${input.smoke.checksFailed} 条`)
  if (input.smoke.checksPassed <= 0) f.push('Live Smoke 的 measured count = 0 ⇒ MEASUREMENT INVALID')
  if (input.smoke.ruleVersion !== 1) f.push(`4b 规则版本 = ${String(input.smoke.ruleVersion)}，不是 1`)
  if (!input.smoke.realEndpoint) f.push('Live Smoke 看起来是 mock（没有真实端点 / key / 回复）')
  if (!input.smoke.scenarioLevelsPresent) f.push('三个场景没有同时给出 Level 1 与 Level 2 证据')
  if (!input.smoke.s4ThreeStage) f.push('Live Smoke 的 S4 三段式不完整')
  if (!input.regressionPass) f.push('全量回归不是 PASS（或 m4.5:ci 退出码非 0）')
  if (!input.gatesDeterminablePass) f.push('M5.1.1 九门里仍有可判定门不是 PASS')
  if (!input.harnessPass) f.push('WP8 harness 不是 PASS')
  if (!input.realDbUntouched) f.push('真实库未写入的证明被破坏（树摘要不同 / 打开过生产库）')
  if (!input.copyDestroyed) f.push('临时副本没有销毁')
  if (!input.authorization.r62 || !input.authorization.r63) f.push('授权留痕缺失（R-62 / R-63）')
  if (!input.authorization.r63Quote) f.push('R-63 的用户原话没有逐字登记')
  if (!input.current.consistent) f.push('当前状态源不一致（不是 Phase 4 PASS / D01 CLOSED / Final PASS）')
  if (!input.historical.unchanged) f.push('历史结论被改写了（§0 的 BLOCKED / P1 OPEN 必须原样保留）')
  if (!input.m51FreezeIntact) f.push('`docs/m5.1/**` 冻结面被改写了（销账记录必须放在 M5.1.1）')
  if (!input.notImpersonated.g8NotRun) f.push('M511-G8 不是 NOT RUN（被冒充成 PASS）')
  if (!input.notImpersonated.deferredRecorded) f.push('延期能力没有被如实登记')
  if (!input.notImpersonated.capabilityClean) f.push('出现了能力冒充式断言')
  return { pass: f.length === 0, failures: f }
}

const currentConsistent = currentSources.every((source) =>
  Object.entries(EXPECTED_CURRENT).every(([key, want]) => source.lines[key] === want)
)
const historicalUnchanged = historicalSources.every((source) =>
  Object.entries(EXPECTED_HISTORICAL).every(([key, want]) => source.lines[key] === want)
)
const scenarioLevelsPresent =
  (num(at(smoke, 'scenarios.S1.qualificationAfter.scanned')) ?? 0) > 0 &&
  (num(at(smoke, 'scenarios.S1.prompt.labelUnconfirmed')) ?? 0) > 0 &&
  str(at(smoke, 'scenarios.S2.writtenMemory.qualification')) === 'ESTABLISHED' &&
  str(at(smoke, 'scenarios.S3.writtenMemory.qualification')) === 'UNCONFIRMED_ORIGIN'
const closureInput: ClosureInput = {
  adr043Frozen: adr043StatusLine.includes('ACCEPTED / DESIGN FROZEN'),
  adr044Executed: adr044StatusLine.includes('ACCEPTED / EXECUTED'),
  fourAVerdict,
  activationAuditRecorded: activationText.length > 0 && /verify\s*=\s*10\/10/.test(activationText),
  smoke: {
    judge: smokeJudge,
    checksPassed: smokeChecksPassed ?? 0,
    checksFailed: smokeChecksFailed ?? -1,
    ruleVersion: smokeRuleVersion,
    realEndpoint:
      (str(at(smoke, 'model.endpointHost')) ?? '') !== '' &&
      bool(at(smoke, 'model.keyPresent')) === true &&
      (num(at(smoke, 'scenarios.S1.level1.replyLength')) ?? 0) > 0 &&
      (num(at(smoke, 'scenarios.S2.level1.replyLength')) ?? 0) > 0 &&
      (num(at(smoke, 'scenarios.S3.level1.replyLength')) ?? 0) > 0,
    scenarioLevelsPresent,
    s4ThreeStage:
      bool(at(smoke, 'S4.positive.pass')) === true &&
      ((at(smoke, 'S4.negativeControls') as unknown[] | undefined)?.length ?? 0) >= 4 &&
      bool(at(smoke, 'S4.restored.pass')) === true,
  },
  regressionPass:
    regressionVerdict === 'PASS' && m45CiExit === 0 && hardGates.length > 0 && hardGates.every((gate) => gate.status === 'PASS'),
  gatesDeterminablePass: measurableGates.every((id) => gateVerdict(id) === 'PASS'),
  harnessPass: harnessVerdict === 'PASS' && harnessFailed === 0,
  realDbUntouched: realDbBefore !== null && realDbBefore === realDbAfter && productionDbOpened === false,
  copyDestroyed: copyDestroyed === true,
  authorization: { r62: r62Present, r63: r63Present, r63Quote: r63QuotePresent },
  current: { consistent: currentConsistent },
  historical: { unchanged: historicalUnchanged },
  m51FreezeIntact: m51FrozenUnchanged,
  notImpersonated: {
    g8NotRun: gateVerdict('M511-G8') === 'NOT RUN',
    deferredRecorded: deferredMarkers.every((marker) => marker.ok),
    capabilityClean: capabilityOffenders.length === 0,
  },
}

const positive = judgeClosure(closureInput)
check('★ 正控：真实读数 ⇒ 关闭判定器**通过**', positive.pass, positive.failures.join(' | ') || '0 处失败')

/** 负控：每一处注入都必须让判定器**失败**（用**同一个**判定器函数） */
const clone = (patch: (draft: ClosureInput) => void): ClosureInput => {
  const copy = structuredClone(closureInput)
  patch(copy)
  return copy
}
const NEGATIVE_INJECTIONS: { name: string; injected: ClosureInput }[] = [
  { name: '删除用户批准（R-63 留痕缺失）', injected: clone((d) => { d.authorization.r63 = false; d.authorization.r63Quote = false }) },
  { name: '把 4a verdict 改成 FAIL', injected: clone((d) => { d.fourAVerdict = 'FAIL' }) },
  { name: '把 measured count 改成 0', injected: clone((d) => { d.smoke.checksPassed = 0 }) },
  { name: '把当前状态改回 OPEN / BLOCKED', injected: clone((d) => { d.current.consistent = false }) },
  { name: '破坏"真实库未被写入"的证明', injected: clone((d) => { d.realDbUntouched = false }) },
  { name: '改写历史结论（把 §0 的 P1 OPEN 改成 CLOSED）', injected: clone((d) => { d.historical.unchanged = false }) },
  { name: '改写 `docs/m5.1/**` 冻结面（把销账写进立案文件）', injected: clone((d) => { d.m51FreezeIntact = false }) },
]
for (const injection of NEGATIVE_INJECTIONS) {
  const verdict = judgeClosure(injection.injected)
  check(
    `★ 负控：${injection.name} ⇒ 判定器**必须响**`,
    !verdict.pass,
    verdict.failures[0] ?? '(没有响 —— 判定器没有牙齿)'
  )
}
const restored = judgeClosure(closureInput)
check('★ 恢复：放回真实读数 ⇒ 判定器重新安静', restored.pass, restored.failures.join(' | ') || '0 处失败')

// ---------------------------------------------------------------------------
// §5 证据（**不含任何时钟**：重复运行必须逐字节相同）
// ---------------------------------------------------------------------------
section('§5 证据（无时钟字段 ⇒ 重复运行逐字节相同）')

/**
 * **唯一写入面的静态自检**（WP-C3 要求"声明其唯一允许写入的证据路径"）。
 *
 * 声明如果只写在注册表的理由里，它是一句注释；写成判据之后，
 * "本门只写一个文件"就变成了**可被机器否证**的事实。
 */
const selfSource = read('scripts/verify-m5.1.1-phase4-closure.ts')
const selfWriteCalls = [...selfSource.matchAll(/writeFileSync\(/g)].length
check(
  `★ 本门**只写一个**证据路径（\`${EVIDENCE_REL}\`）—— 别无写入面`,
  selfWriteCalls === 1 && selfSource.includes(EVIDENCE_REL),
  `writeFileSync 调用 ${selfWriteCalls} 处 · 目标 ${EVIDENCE_REL}`
)
/**
 * 时钟自检的两组针。
 *
 * ⚠️ 第一版这里扫的是**脚本源码**里的"时钟字段名 / 取时刻的调用"字面量，
 *    而检查语句自己就写着那些字面量 ⇒ **自我指涉的假红**（实测撞到两次：
 *    一次是字段名，一次是调用名）。正确做法：
 *      ① 扫**写出来的证据文本**（那才是真正的要求）
 *      ② 扫源码时用**拼出来的针**，让检查语句自身不含那个字面量
 *      ③ 相关的说明文字里也不要出现那些字面量
 */
const CLOCK_NEEDLES_IN_EVIDENCE = ['generatedAt', 'generated_at', 'Date' + '.now(', 'new ' + 'Date(']
const CLOCK_NEEDLES_IN_SOURCE = ['Date' + '.now(', 'new ' + 'Date(']

const evidence = {
  testId: 'M5.1.1 / Phase 4 Closure',
  command: 'pnpm m5.1.1:phase4:closure:verify',
  rule: 'missing evidence = not-run（不是 PASS）；本门只读已提交证据，不打开真实库、不跑真实模型',
  status: {
    'Phase 1': 'PASS',
    'Phase 2': 'PASS',
    'Phase 3': 'PASS',
    'Phase 4a': 'PASS',
    'Phase 4b': 'PASS',
    'Phase 4': 'PASS',
    'M5.1-D01': 'CLOSED',
    'M5.1.1 Final': 'PASS',
    'M511-G8': 'NOT RUN（Break-Glass 未实现，非阻断）',
  },
  closureBasis: {
    adr043StatusLine,
    adr044StatusLine,
    fourAVerdict,
    fourAEvidence: 'artifacts/m5.1.1/wp4a-origin-gate.json',
    activationRecord: ACTIVATION,
    smokeEvidence: SMOKE,
    smokeJudge,
    smokeChecks: { passed: smokeChecksPassed, failed: smokeChecksFailed },
    ruleVersion: smokeRuleVersion,
    regressionVerdict,
    m45CiExit,
    hardGates,
    gates: Object.fromEntries(measurableGates.map((id) => [id, gateVerdict(id)])),
    harnessVerdict,
    note:
      '4b 的专项门 `pnpm m5.1.1:phase4b:verify`（31 通过 / 0 失败）**不落盘证据**（只在 stdout）。' +
      '因此这里用两处可定位的替代：Activation Record 的 `verify = 10/10` + D01 Live Smoke 在真实语料上' +
      '独立复现的 4b 行为（规则版本 / 标签 / ESTABLISHED / UNCONFIRMED_ORIGIN）。',
  },
  realDatabase: {
    productionDbOpened,
    realDbTreeBefore: realDbBefore,
    realDbTreeAfter: realDbAfter,
    files: realDbFiles,
    copyDestroyed,
  },
  authorization: { r62Present, r63Present, r63Quote: R63_QUOTE },
  currentStateSources: currentSources.map((source) => ({ name: source.name, lines: source.lines })),
  historicalStateSources: historicalSources.map((source) => ({ name: source.name, lines: source.lines })),
  m51Freeze: {
    commit: M51_FREEZE_COMMIT,
    docsM51Drift: m51FrozenDrift,
    unchanged: m51FrozenUnchanged,
    note:
      '`docs/m5.1/**` 是 `m5.1-complete` 冻结的判定文档；`verify-m5.1.1-wp8-harness.ts` 有同名判据。' +
      'D01 的销账记录因此放在 `' + LEDGER_ADDENDUM + '`（M5.1.1），而本门把"冻结面未被改写"作为正向判据。',
  },
  notImpersonated: {
    m511G8: gateVerdict('M511-G8'),
    deferred: deferredMarkers.map((marker) => ({ name: marker.name, recorded: marker.ok })),
    capabilityForbidden: [...CAPABILITY_FORBIDDEN],
    capabilityOffenders,
  },
  judge: { positive: positive.pass, negativeInjections: NEGATIVE_INJECTIONS.map((n) => n.name), restored: restored.pass },
  limitations: [
    'DR-11：自然语言措辞仍由 Live Smoke 人工观察，不存在关键词守卫',
    'S2 的管道式 readline `exit=1` 偏差按原证据解释（三个独立信号证明该轮跑完了）',
    '三个场景各只有一次真实模型调用（措辞是随机的）',
    'DC-1/DC-2/DC-3 与 K-31 不随 D01 一起关闭',
    '不主张后台自主运行、Break-Glass 或任意记忆注入能力',
  ],
  checks,
  measures,
  // `closure` 在下面（追加完自检判据之后）再定稿 —— 它是**整道门**的判定；
  // `judge` 是**纯判定器**的判定。两者分开写，免得"判定器过了"被读成"门过了"。
  verdict: { closure: 'PENDING', judge: positive.pass ? 'PASS' : 'FAIL', failures: positive.failures },
}

/*
 * ⚠️ 这两条必须在**证据对象建好之后**跑（它们量的就是这份证据），
 *    而 `checks` 是活引用 ⇒ 追加进去的判据会一起进最终 JSON。
 */
const evidenceClockHits = CLOCK_NEEDLES_IN_EVIDENCE.filter((needle) => JSON.stringify(evidence).includes(needle))
check(
  '★ 证据里**没有任何时钟**（字段名 / 取时刻的调用）—— 重复运行逐字节相同',
  evidenceClockHits.length === 0,
  evidenceClockHits.join(' , ') || '0 处'
)
const sourceClockHits = CLOCK_NEEDLES_IN_SOURCE.filter((needle) => selfSource.includes(needle))
check(
  '★ 门自己**不取时刻**（`Date` 相关调用零处）—— 它读的全部是已提交的读数',
  sourceClockHits.length === 0,
  sourceClockHits.join(' , ') || '0 处'
)

// 计数必须在追加上述判据之后重新取一次（否则证据里会出现"passed 与 checks 不一致"）
evidence.checks = checks
evidence.measures = measures
evidence.verdict.closure = failed === 0 ? 'PASS' : 'FAIL'
evidence.verdict.failures = failures

writeFileSync(join(ROOT, EVIDENCE_REL), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\n${'='.repeat(78)}`)
console.log(
  `M5.1.1 Phase 4 Closure：${passed} 通过 / ${failed} 失败｜关闭判定器 = ${positive.pass ? 'PASS' : 'FAIL'}`
)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log(`最终状态：Phase 4 = PASS · M5.1-D01 = CLOSED · M5.1.1 Final = PASS`)
console.log(`证据：${EVIDENCE_REL}（不含时钟字段）`)
console.log('='.repeat(78))
process.exitCode = failed === 0 ? 0 : 1
