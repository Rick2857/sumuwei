/**
 * M6.1 / WP3 **出口门**（只读 · 不碰数据库 · 不联网 · 不调模型）。
 *
 * ⚠️ 为什么要有它
 * ```text
 * 用户 2026-09-24 判「WP3 完成」。这句判定若只写在散文里，它与"没人核对过"在输出上
 * 长得一样（本仓库反复登记的那类损失）。本门把 WP3 的**出口条件**逐条变成读数：
 *   每条出口条件 → 具名交付物 + 必须出现的小节 + **测到几条**（分母必须 > 0）。
 * 任何一项的分母为 0 ⇒ MEASUREMENT INVALID，**不是** PASS（AGENTS §6.8）。
 * ```
 *
 * ⚠️ 本门**不判**什么（边界，写在证据里，不许拿它冒充）
 * ```text
 * ① 不判"根因结论对不对"——那是真人裁定（用户 2026-09-24 已裁定）。
 *    本门只判：那份裁定**有没有落到具名文档里**、章节齐不齐。
 * ② 不判四套验收集"跑过没有"——**它们一个场景都还没跑**。本门只判条目落库且校验通过。
 *    冻结数字（30 / ≤3 / 每类 ≤1 / 10→0 / 12→0）目前仍是**门上的期望值，不是读数**。
 * ③ 不判"生产装配 ≡ 受测装配"的运行期三读数——那是 WP4 的事。
 * ```
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadCorrectionNegativeSet,
  loadCounterexamples,
  loadExplicitWriteSet,
  loadSupportedRecallSet,
  validateCorrectionNegativeSet,
  validateCounterexamples,
  validateExplicitWriteSet,
  validateSupportedRecallSet,
  type CorrectionNegativeItem,
  type CounterexampleItem,
  type ExplicitWriteItem,
  type SupportedRecallItem,
} from './m6.1-control-sets.ts'

const ROOT = process.cwd()

/* ---------------------------------------------------------------------------
 * 出口条件 → 具名交付物。markers 是**必须出现的小节标题**（完整性检查，
 * 不是语义判定：本门判"那一节在不在"，判"那一节说得对不对"的是人）。
 * ------------------------------------------------------------------------- */

export interface DeliverableSpec {
  readonly id: string
  readonly requirement: string
  readonly path: string
  readonly markers: readonly string[]
}

export const WP3_DELIVERABLES: readonly DeliverableSpec[] = [
  {
    id: 'root_cause_design',
    requirement: '交付 M6.1-Root-Cause-and-Design.md，含已证根因/待证假设/最小修复/否决方案/受影响门/认知完整性审查/允许主张',
    path: 'docs/m6.1/M6.1-Root-Cause-and-Design.md',
    markers: [
      '## 2. 已证机制',
      '## 3. 待证假设',
      '## 4. 裁定的最小修复',
      '## 5. 否决方案',
      '## 6. 受影响门',
      '## 7. 认知完整性审查',
      '## 8. 允许主张',
    ],
  },
  {
    id: 'adr_055',
    requirement: '修复设计分配新 ADR（不占用 ADR-051），状态为已接受',
    path: 'docs/adr/ADR-055-m6.1-wp4-explicit-memory-correction-and-context-facts.md',
    markers: ['ADR-055', 'ACCEPTED'],
  },
  {
    id: 'adjudication_log',
    requirement: 'WP3 的裁定与登记留痕（含用户逐条裁定）',
    path: 'evals/m6.1/acceptance/ADJUDICATION-LOG.md',
    markers: ['### 17.', '### 18.'],
  },
  {
    id: 'judgment_contract',
    requirement: 'WP1/WP2 的契约与量具有效性报告必须在（WP3 的读数建立在它们之上）',
    path: 'docs/m6.1/M6.1-Judgment-Contract.md',
    markers: [],
  },
  {
    id: 'instrument_validity',
    requirement: '同上：量具有效性自证（VALID 才允许下一步）',
    path: 'docs/m6.1/M6.1-Instrument-Validity-Report.md',
    markers: [],
  },
]

/* ---------------------------------------------------------------------------
 * 运行事实（从 artifacts/m6.1 下的 m6.1-baseline-&lt;...&gt; / baseline.json 读出，只读）
 * ------------------------------------------------------------------------- */

export interface BaselineRunFacts {
  readonly runId: string
  readonly arm: string
  readonly scenario: string
  /** before/after 两棵树的摘要都记了 */
  readonly digestOk: boolean
  /** 前后摘要逐字相同（内容证据，强） */
  readonly beforeAfterSame: boolean | null
  /** realDb.unchanged（脚本自己的判定） */
  readonly treeUnchanged: boolean | null
  /** realDb.mtimeUnchanged（独立信号；老运行没记 ⇒ null） */
  readonly mtimeUnchanged: boolean | null
  readonly hasManifest: boolean
}

export function readBaselineRuns(dir: string): BaselineRunFacts[] {
  if (!existsSync(dir)) return []
  const runs: BaselineRunFacts[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('m6.1-baseline-')) continue
    const runDir = join(dir, entry.name)
    const file = join(runDir, 'baseline.json')
    if (!existsSync(file)) continue
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      scenarioName?: unknown
      realDb?: {
        before?: { treeSha256?: unknown } | null
        after?: { treeSha256?: unknown } | null
        unchanged?: unknown
        mtimeUnchanged?: unknown
      } | null
    }
    const before = parsed.realDb?.before?.treeSha256
    const after = parsed.realDb?.after?.treeSha256
    const arm = entry.name.includes('-code-default-')
      ? 'code-default'
      : entry.name.includes('-deployed-')
        ? 'deployed'
        : 'unknown'
    runs.push({
      runId: entry.name,
      arm,
      scenario: typeof parsed.scenarioName === 'string' ? parsed.scenarioName : 'unknown',
      digestOk: typeof before === 'string' && before.length > 0 && typeof after === 'string' && after.length > 0,
      beforeAfterSame: typeof before === 'string' && typeof after === 'string' ? before === after : null,
      treeUnchanged: typeof parsed.realDb?.unchanged === 'boolean' ? parsed.realDb.unchanged : null,
      mtimeUnchanged: typeof parsed.realDb?.mtimeUnchanged === 'boolean' ? parsed.realDb.mtimeUnchanged : null,
      hasManifest: existsSync(join(runDir, 'manifest.json')),
    })
  }
  return runs.sort((a, b) => a.runId.localeCompare(b.runId))
}

/* ---------------------------------------------------------------------------
 * 判据（**纯函数**，可注入坏形态做负控）
 * ------------------------------------------------------------------------- */

export interface Wp3ClosureInput {
  /** 交付物正文；null = 文件缺失 */
  readonly deliverables: Readonly<Record<string, string | null>>
  readonly runs: readonly BaselineRunFacts[]
  readonly sets: {
    readonly supportedRecall: readonly SupportedRecallItem[]
    readonly counterexamples: readonly CounterexampleItem[]
    readonly explicitWrite: readonly ExplicitWriteItem[]
    readonly correctionNegative: readonly CorrectionNegativeItem[]
  }
  readonly l1: { readonly passed: number; readonly failed: number } | null
}

export interface Wp3ClosureItem {
  readonly id: string
  readonly requirement: string
  readonly ok: boolean
  readonly measured: number
  readonly detail: string
}

export interface Wp3ClosureResult {
  readonly verdict: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID'
  readonly items: readonly Wp3ClosureItem[]
  readonly invalidReasons: readonly string[]
}

export function checkWp3Closure(input: Wp3ClosureInput): Wp3ClosureResult {
  const items: Wp3ClosureItem[] = []

  /* ① 交付物齐备 + 必备小节在 */
  for (const spec of WP3_DELIVERABLES) {
    const text = input.deliverables[spec.id] ?? null
    const missing = text === null ? spec.markers.length + 1 : spec.markers.filter((m) => !text.includes(m)).length
    const measured = text === null ? 0 : text.length
    items.push({
      id: `deliverable:${spec.id}`,
      requirement: spec.requirement,
      ok: text !== null && text.trim() !== '' && missing === 0,
      measured,
      detail:
        text === null
          ? '文件缺失'
          : missing === 0
            ? `${String(text.length)} 字符 · 必备小节 ${String(spec.markers.length)}/${String(spec.markers.length)} 在`
            : `缺 ${String(missing)} 个必备小节：${spec.markers.filter((m) => !text.includes(m)).join(' · ')}`,
    })
  }

  /* ② 未修复候选上的基线：跑过、每次都记了真实库前后摘要、且**从未**记到真实库被动过 */
  const digestMissing = input.runs.filter((r) => !r.digestOk)
  const treeChanged = input.runs.filter((r) => r.treeUnchanged === false)
  const mtimeChanged = input.runs.filter((r) => r.mtimeUnchanged === false)
  const digestDiffers = input.runs.filter((r) => r.beforeAfterSame === false)
  const arms = new Set(input.runs.map((r) => r.arm)).size
  items.push({
    id: 'baseline',
    requirement: '在未修复候选上跑过基线；每次运行都记真实库前后摘要；真实库从未被记为被动过',
    ok:
      input.runs.length > 0 &&
      digestMissing.length === 0 &&
      digestDiffers.length === 0 &&
      treeChanged.length === 0 &&
      mtimeChanged.length === 0,
    measured: input.runs.length,
    detail:
      `${String(input.runs.length)} 个运行 · 记了前后摘要 ${String(input.runs.length - digestMissing.length)}/${String(input.runs.length)}` +
      ` · 前后摘要不同=${String(digestDiffers.length)} · 树有变化=${String(treeChanged.length)} · mtimeChanged=${String(mtimeChanged.length)}` +
      ` · 摘要档位 ${String(arms)} 种（老运行未记 mtimeUnchanged 的有 ${String(input.runs.filter((r) => r.mtimeUnchanged === null).length)} 个）`,
  })

  /* ③ 单因素比较的两个档位都要有运行（摘要 0 / 非零） */
  const hasCodeDefault = input.runs.some((r) => r.arm === 'code-default')
  const hasDeployed = input.runs.some((r) => r.arm === 'deployed')
  items.push({
    id: 'two_arms',
    requirement: '摘要档位比较：代码缺省档（0）与部署档（400）**都**跑过',
    ok: hasCodeDefault && hasDeployed,
    measured: arms,
    detail: `code-default=${String(hasCodeDefault)} · deployed=${String(hasDeployed)}`,
  })

  /* ④ 四套验收集：条目落库且校验器全部通过 */
  const setChecks: readonly { id: string; count: number; problems: readonly string[] }[] = [
    { id: 'supported_recall_positive_v1', count: input.sets.supportedRecall.length, problems: validateSupportedRecallSet(input.sets.supportedRecall) },
    { id: 'required_counterexamples_v1', count: input.sets.counterexamples.length, problems: validateCounterexamples(input.sets.counterexamples) },
    { id: 'explicit_write_positive_v1', count: input.sets.explicitWrite.length, problems: validateExplicitWriteSet(input.sets.explicitWrite) },
    { id: 'correction_intent_negative_v1', count: input.sets.correctionNegative.length, problems: validateCorrectionNegativeSet(input.sets.correctionNegative) },
  ]
  items.push({
    id: 'four_sets_landed',
    requirement: 'WP3 冻结的四套集：条目已落库且机器校验通过',
    ok: setChecks.every((s) => s.count > 0 && s.problems.length === 0),
    measured: setChecks.reduce((sum, s) => sum + s.count, 0),
    detail: setChecks.map((s) => `${s.id}=${String(s.count)}${s.problems.length === 0 ? '' : `(${s.problems[0] ?? ''})`}`).join(' · '),
  })

  /* ⑤ 判据层读数（L1）必须是"测过且没有失败"，不是"没测到" */
  items.push({
    id: 'l1_reading',
    requirement: '判据层（L1）读数存在且 failed = 0，passed > 0',
    ok: input.l1 !== null && input.l1.passed > 0 && input.l1.failed === 0,
    measured: input.l1?.passed ?? 0,
    detail: input.l1 === null ? '没有读数' : `${String(input.l1.passed)} 通过 / ${String(input.l1.failed)} 失败`,
  })

  /* 分母自检：任何一项 measured = 0 ⇒ 这一项根本没测到 */
  const invalidReasons = items.filter((i) => i.measured === 0).map((i) => `${i.id}：measured=0 ⇒ MEASUREMENT INVALID`)
  const verdict: Wp3ClosureResult['verdict'] =
    invalidReasons.length > 0 ? 'MEASUREMENT INVALID' : items.every((i) => i.ok) ? 'PASS' : 'FAIL'
  return { verdict, items, invalidReasons }
}

/* ---------------------------------------------------------------------------
 * 从磁盘组装入参 + 三态自证
 * ------------------------------------------------------------------------- */

function readDeliverables(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const spec of WP3_DELIVERABLES) {
    const abs = join(ROOT, spec.path)
    out[spec.id] = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  }
  return out
}

function readL1(): { passed: number; failed: number } | null {
  const abs = join(ROOT, 'artifacts/m6.1/component.json')
  if (!existsSync(abs)) return null
  const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { passed?: unknown; failed?: unknown }
  return {
    passed: typeof parsed.passed === 'number' ? parsed.passed : 0,
    failed: typeof parsed.failed === 'number' ? parsed.failed : 0,
  }
}

function readInput(): Wp3ClosureInput {
  return {
    deliverables: readDeliverables(),
    runs: readBaselineRuns(join(ROOT, 'artifacts/m6.1')),
    sets: {
      supportedRecall: loadSupportedRecallSet(ROOT),
      counterexamples: loadCounterexamples(ROOT),
      explicitWrite: loadExplicitWriteSet(ROOT),
      correctionNegative: loadCorrectionNegativeSet(ROOT),
    },
    l1: readL1(),
  }
}

const positive = checkWp3Closure(readInput())

/* 负控①：抽掉一份交付物（把 ADR 正文置 null） */
const nc1Input = readInput()
const nc1 = checkWp3Closure({
  ...nc1Input,
  deliverables: { ...nc1Input.deliverables, adr_055: null },
})
const nc1Hit = nc1.verdict !== 'PASS' && nc1.items.some((i) => i.id === 'deliverable:adr_055' && !i.ok)

/* 负控②：交付物在、但必备小节被删掉 ⇒ 必须报缺哪一节 */
const nc2Input = readInput()
const nc2 = checkWp3Closure({
  ...nc2Input,
  deliverables: {
    ...nc2Input.deliverables,
    root_cause_design: (nc2Input.deliverables.root_cause_design ?? '').replace('## 7. 认知完整性审查', '## 7. （被删）'),
  },
})
const nc2Hit = nc2.verdict !== 'PASS' && nc2.items.some((i) => i.detail.includes('认知完整性'))

/* 负控③：真实库被记为被动过 ⇒ 必须红（这条是"不打开真实库"的负控） */
const nc3Input = readInput()
const nc3 = checkWp3Closure({
  ...nc3Input,
  runs: nc3Input.runs.map((r, i) => (i === 0 ? { ...r, mtimeUnchanged: false } : r)),
})
const nc3Hit = nc3.verdict !== 'PASS' && nc3.items.some((i) => i.id === 'baseline' && !i.ok && i.detail.includes('mtimeChanged=1'))

/* 负控④：四套集**全部**清空 ⇒ 必须是 MEASUREMENT INVALID，不是"校验通过"
   ⚠️ 只清空一套不算：本项的分母是四套之和，清一套会让它 FAIL 而不是 INVALID ——
      这正是第一版负控④写错、被门自己抓出来的地方（登记在 §19）。 */
const nc4Input = readInput()
const nc4 = checkWp3Closure({
  ...nc4Input,
  sets: { supportedRecall: [], counterexamples: [], explicitWrite: [], correctionNegative: [] },
})
const nc4Hit = nc4.verdict === 'MEASUREMENT INVALID' && nc4.invalidReasons.some((r) => r.includes('four_sets_landed'))

/* 恢复：放回真实入参 ⇒ 必须重新 PASS（与正控同一函数、同一入参） */
const restored = checkWp3Closure(readInput())
const restoreOk = restored.verdict === positive.verdict && positive.verdict === 'PASS'

const failures: string[] = []
if (positive.verdict !== 'PASS') failures.push(`正控未通过：${positive.verdict} ${positive.invalidReasons.join('|')}`)
if (!nc1Hit) failures.push('负控①未触发：抽掉交付物必须红')
if (!nc2Hit) failures.push('负控②未触发：删掉必备小节必须红')
if (!nc3Hit) failures.push('负控③未触发：真实库被记为被动过必须红')
if (!nc4Hit) failures.push('负控④未触发：清空集合必须是 MEASUREMENT INVALID')
if (!restoreOk) failures.push('恢复未回到正控读数')

for (const item of positive.items) {
  console.log(`  ${item.ok ? '✅' : '❌'} ${item.requirement}\n       [${item.detail}]`)
}
console.log(`\n负控①抽掉交付物=${nc1Hit ? '红' : '未触发'} · 负控②删小节=${nc2Hit ? '红' : '未触发'} · 负控③真实库被动过=${nc3Hit ? '红' : '未触发'} · 负控④清空集合=${nc4 ? nc4.verdict : '?'} · 恢复=${restoreOk ? 'PASS' : '失败'}`)

const evidence = {
  schemaVersion: 'm6.1-wp3-closure@1',
  gateId: 'M6.1 / WP3 出口门（只读）',
  scope: 'WP3 出口条件的**可复算**读数：交付物齐备性 + 基线运行事实 + 四套集校验 + L1 读数',
  note:
    '本门不判根因结论对不对（那是真人裁定），也不判四套集跑过没有（它们一个场景都还没跑；' +
    '冻结数字仍是门上的期望值，不是读数）。判据期望值独立写死在脚本里。证据里没有时钟字段 ⇒ 重复运行逐字节相同。',
  verdict: failures.length > 0 ? 'FAIL' : 'PASS',
  wp3Verdict: positive.verdict,
  items: positive.items,
  invalidReasons: positive.invalidReasons,
  negativeControls: [
    { id: 'nc1_deliverable_removed', fired: nc1Hit, verdict: nc1.verdict },
    { id: 'nc2_marker_removed', fired: nc2Hit, verdict: nc2.verdict },
    { id: 'nc3_real_db_touched', fired: nc3Hit, verdict: nc3.verdict },
    { id: 'nc4_set_emptied', fired: nc4Hit, verdict: nc4.verdict },
  ],
  restore: restoreOk,
  counters: {
    deliverablesChecked: WP3_DELIVERABLES.length,
    baselineRunsChecked: positive.items.find((i) => i.id === 'baseline')?.measured ?? 0,
    setItemsChecked: positive.items.find((i) => i.id === 'four_sets_landed')?.measured ?? 0,
    l1Passed: positive.items.find((i) => i.id === 'l1_reading')?.measured ?? 0,
  },
  failures,
}

mkdirSync(join(ROOT, 'artifacts/m6.1'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts/m6.1/wp3-closure.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM6.1 WP3 出口门：${evidence.verdict}（WP3 判定 = ${positive.verdict}）`)
console.log('  证据：artifacts/m6.1/wp3-closure.json')
process.exitCode = evidence.verdict === 'PASS' ? 0 : 1
