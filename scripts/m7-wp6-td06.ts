/**
 * M7 WP6 —— **TD-06 量具自检门**（`pnpm m7:wp6:td06`）。
 *
 * ============================================================================
 *  它验证什么、不验证什么
 * ============================================================================
 * 定义已冻结（`docs/m7/M7-WP6-TD06-Definition.md`，判定契约式四界）。
 * 本门验证**量具的材料**在离线上自洽；判定器（LLM judge）的有效性
 * 验证与读数归 **WP6-B**（需用户授权的真模型轮），本门零模型调用。
 *
 *  · **A 段（语料形状与平衡）**：场景语料 12 条（正控 6 = C-1/C-2/C-3
 *    各 2；负控诱导 6 = 复读 3 + 挟持 3）；每条有探针、uptake 令牌、
 *    通过/失败条件。计数为 0 ⇒ MEASUREMENT INVALID（§6.8）。
 *  · **B 段（有效性集的契约可导性质）**：每条合成回复样本的标签必须
 *    能从冻结契约的操作化判别**机器推导**出来——
 *    正控：uptake 令牌在回复里在场（care 族还必须**同时**有词形重复，
 *    即"词形重复 + uptake 在场 = 合格"的样本真的存在）；
 *    复读：施压短语在场 + uptake 令牌**全部**缺席；
 *    挟持：回涌令牌在场（uptakeMode=partial 的允许部分接住）。
 *  · **C 段（"不以关键词去重"的机器证明）**：一个**天真的词形去重
 *    检测器**（回复与往轮共享 ≥2 字短语 ⇒ 报复读）跑过有效性集——
 *    它必须把 care 族正控**误报**（≥2 条），证明词形去重按构造不可用；
 *    同时它对复读负控的命中被如实登记（它不是没用，是不够）。
 *  · **D 段（量具自证 · §6.7 三段式的量具版）**：本门自己也是新量具
 *    ⇒ 注入已知坏形态（抽走 uptake 令牌 / 塞进接住痕迹 / 抽走语料条目）
 *    判定核心必须逐条点名；放回真语料必须重新安静。判定核心与 B 段
 *    共用同一纯函数，两边不可能走偏。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；纯离线，无库无模型。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 集合冻结规范（与 M6.1 control-sets 同款纪律：写在一处，门只消费）
// ---------------------------------------------------------------------------

const SCENARIO_SET = {
  name: 'td06_current_input_v1',
  path: 'evals/m7/td06-current-input-v1.jsonl',
  total: 12,
  families: {
    continuity_care: 2,
    continuity_callback: 2,
    continuity_followup: 2,
    repetition_eliciting: 3,
    hijack_eliciting: 3,
  },
} as const

const VALIDITY_SET = {
  name: 'td06_validity_v1',
  path: 'evals/m7/td06-validity-v1.jsonl',
  total: 14,
  labels: {
    responds_to_current: 2,
    normal_continuity_care: 2,
    normal_continuity_callback: 2,
    normal_continuity_followup: 2,
    repetition_pressure: 3,
    topic_hijack: 3,
  },
} as const

interface ScenarioItem {
  readonly id: string
  readonly family: string
  readonly kind: 'positive' | 'negative_eliciting'
  readonly setup: readonly { readonly role: string; readonly text: string }[]
  readonly probe: string
  readonly uptakeTokens: readonly string[]
  readonly passCondition: string
  readonly failCondition: string
}

interface ValidityItem {
  readonly id: string
  readonly label: string
  readonly expectedVerdict: string
  readonly kind: 'positive' | 'negative'
  readonly context: readonly { readonly role: string; readonly text: string }[]
  readonly currentInput: string
  readonly reply: string
  readonly uptakeTokens: readonly string[]
  readonly repeatedPhrase: string | null
  readonly hijackToken?: string
  readonly uptakeMode?: 'none' | 'partial'
  readonly rationale: string
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(join(REPO_ROOT, path), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)

// ---------------------------------------------------------------------------
// 检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const scenarios = readJsonl<ScenarioItem>(SCENARIO_SET.path)
const validity = readJsonl<ValidityItem>(VALIDITY_SET.path)

// ---------------------------------------------------------------------------
// 判定核心（纯函数）——B 段与 D 段（量具自证）共用同一实现，两边不可能走偏
// ---------------------------------------------------------------------------

/** 正控样本的 uptake 缺席清单（契约 1.1/1.2 轴 A 的机器面） */
const positiveUptakeMissing = (items: readonly ValidityItem[]): readonly ValidityItem[] =>
  items.filter((v) => v.kind === 'positive' && !v.uptakeTokens.some((t) => v.reply.includes(t)))

/** care 族缺词形重复的清单（B2 的机器面） */
const careRepetitionMissing = (items: readonly ValidityItem[]): readonly ValidityItem[] =>
  items.filter(
    (v) =>
      v.label === 'normal_continuity_care' &&
      !(v.repeatedPhrase !== null && v.reply.includes(v.repeatedPhrase)),
  )

/** 复读负控的双条件违例清单（契约 1.3 (a)+(b) 的机器面） */
const repetitionViolations = (items: readonly ValidityItem[]): readonly ValidityItem[] =>
  items.filter(
    (v) =>
      v.label === 'repetition_pressure' &&
      (!(v.repeatedPhrase !== null && v.reply.includes(v.repeatedPhrase)) ||
        v.uptakeTokens.some((t) => v.reply.includes(t))),
  )

/** 挟持负控的回涌缺席清单（契约 1.4 的机器面） */
const hijackSurgeMissing = (items: readonly ValidityItem[]): readonly ValidityItem[] =>
  items.filter(
    (v) => v.label === 'topic_hijack' && !(v.hijackToken !== undefined && v.reply.includes(v.hijackToken)),
  )

/** 场景语料的平衡问题清单（A1 的机器面） */
const scenarioBalanceProblems = (items: readonly ScenarioItem[]): readonly string[] => {
  const problems: string[] = []
  if (items.length !== SCENARIO_SET.total) {
    problems.push(`条目数 ${String(items.length)} ≠ ${String(SCENARIO_SET.total)}`)
  }
  for (const [family, expected] of Object.entries(SCENARIO_SET.families)) {
    const actual = items.filter((s) => s.family === family).length
    if (actual !== expected) problems.push(`${family}=${String(actual)} ≠ ${String(expected)}`)
  }
  return problems
}

// ===========================================================================
// A 段：语料形状与平衡
// ===========================================================================

const a1problems = scenarioBalanceProblems(scenarios)
record(
  'A1',
  '场景语料平衡：12 条 = C-1/C-2/C-3 各 2 + 复读诱导 3 + 挟持诱导 3',
  '12 条五族齐',
  a1problems.length === 0
    ? `${String(scenarios.length)} 条五族齐`
    : a1problems.join(' · '),
  a1problems.length === 0,
)
const a2ok =
  scenarios.every(
    (s) =>
      s.probe.trim() !== '' &&
      s.uptakeTokens.length > 0 &&
      s.setup.length >= 1 &&
      s.passCondition.trim() !== '' &&
      (s.kind === 'positive' || s.failCondition.trim() !== ''),
  ) && scenarios.some((s) => s.kind === 'negative_eliciting' && s.failCondition.includes('必须抓'))
record(
  'A2',
  '场景要素齐：每条有探针 + uptake 令牌 + 通过条件；负控诱导必须带"判定器必须抓到"的失败条件',
  '全齐',
  `缺项=${String(scenarios.filter((s) => s.probe.trim() === '' || s.uptakeTokens.length === 0 || s.passCondition.trim() === '').length)}`,
  a2ok,
)

const b0ok =
  validity.length === VALIDITY_SET.total &&
  Object.entries(VALIDITY_SET.labels).every(([label, expected]) => {
    const actual = validity.filter((v) => v.label === label).length
    return actual === expected
  })
record(
  'B0',
  '有效性集平衡：14 条 = 回应 2 + 连续性三族各 2 + 复读 3 + 挟持 3',
  '14 条六标齐',
  `${String(validity.length)} 条 · ${Object.entries(VALIDITY_SET.labels)
    .map(([l, n]) => `${l}=${String(validity.filter((v) => v.label === l).length)}/${String(n)}`)
    .join(' · ')}`,
  b0ok,
)

// ===========================================================================
// B 段：契约可导性质（每条样本的标签必须能从冻结契约机器推导）
// ===========================================================================

const positiveItems = validity.filter((v) => v.kind === 'positive')
const careItems = validity.filter((v) => v.label === 'normal_continuity_care')
const repetitionItems = validity.filter((v) => v.label === 'repetition_pressure')
const hijackItems = validity.filter((v) => v.label === 'topic_hijack')

// B1：正控样本的 uptake 在场（契约 1.1/1.2 的轴 A）
const b1Bad = positiveUptakeMissing(validity)
record(
  'B1',
  '正控样本 uptake 在场：8 条合格样本的回复都接住了本轮输入的令牌（轴 A 成立）',
  '8/8 在场',
  `${String(positiveItems.length - b1Bad.length)}/${String(positiveItems.length)} 在场${b1Bad.length > 0 ? ` · 缺：${b1Bad.map((v) => v.id).join(',')}` : ''}`,
  b1Bad.length === 0 && positiveItems.length === 8,
)

// B2：care 族必须同时有词形重复（"词形重复 + uptake = 合格"的样本存在性）
const b2Bad = careRepetitionMissing(validity)
record(
  'B2',
  'care 族样本自带词形重复：回复里真的复现了往轮的关心句式（给关键词去重埋误报素材）',
  '2/2 有重复短语',
  `${String(careItems.length - b2Bad.length)}/${String(careItems.length)}${b2Bad.length > 0 ? ` · 缺：${b2Bad.map((v) => v.id).join(',')}` : ''}`,
  b2Bad.length === 0 && careItems.length === 2,
)

// B3：复读负控 = 施压短语在场 + uptake 全缺席（契约 1.3 的 (a)+(b)）
const b3Bad = repetitionViolations(validity)
record(
  'B3',
  '复读负控双条件：施压短语在回复在场 且 uptake 令牌全部缺席（(a) 同构施压 + (b) 零接住）',
  '3/3 双条件成立',
  `${String(repetitionItems.length - b3Bad.length)}/${String(repetitionItems.length)}${b3Bad.length > 0 ? ` · 违：${b3Bad.map((v) => v.id).join(',')}` : ''}`,
  b3Bad.length === 0 && repetitionItems.length === 3,
)

// B4：挟持负控 = 回涌令牌在场；partial 的允许部分接住（契约 1.4/1.5）
const b4Bad = hijackSurgeMissing(validity)
const partialCount = hijackItems.filter((v) => v.uptakeMode === 'partial').length
record(
  'B4',
  '挟持负控：回涌令牌在场；含 partial 样本（部分接住按主导动作判——裁决表末行的素材）',
  '3/3 回涌在场 · partial≥2',
  `${String(hijackItems.length - b4Bad.length)}/${String(hijackItems.length)} 回涌在场 · partial=${String(partialCount)}`,
  b4Bad.length === 0 && hijackItems.length === 3 && partialCount >= 2,
)

// ===========================================================================
// C 段：天真词形去重检测器的不可行性证明（"不以关键词去重"约束的机器化）
// ===========================================================================

/**
 * 天真检测器（故意造的坏量具）：回复与**她的往轮**共享任何 ≥2 字的
 * 连续片段 ⇒ 报"复读"。这是"关键词去重"的最简实现。
 */
function naiveKeywordDedup(item: ValidityItem): boolean {
  const assistantTurns = item.context
    .filter((c) => c.role === 'assistant')
    .map((c) => c.text)
  for (const turn of assistantTurns) {
    for (let i = 0; i < turn.length - 1; i += 1) {
      const bigram = turn.slice(i, i + 2)
      if (item.reply.includes(bigram)) return true
    }
  }
  return false
}

const naiveFlags = validity.filter((v) => naiveKeywordDedup(v))
const naiveFalsePositives = naiveFlags.filter((v) => v.kind === 'positive')
const naiveTrueCatches = naiveFlags.filter((v) => v.label === 'repetition_pressure')
const c1ok =
  naiveFalsePositives.length >= 2 &&
  naiveFalsePositives.some((v) => v.label === 'normal_continuity_care')
record(
  'C1',
  '天真词形去重会误报连续性：≥2 条正控（含 care 族）被它标成复读 ⇒ 词形去重按构造不可用',
  `误报 ≥2（含 care）`,
  `误报 ${String(naiveFalsePositives.length)} 条（${naiveFalsePositives.map((v) => v.id).join(',') || '无'}）`,
  c1ok,
)
const c2ok = naiveTrueCatches.length >= 1
record(
  'C2',
  '如实登记：天真检测器对复读负控也有命中（它不是没用，是不够——语义判别不可替代）',
  '命中 ≥1',
  `命中 ${String(naiveTrueCatches.length)} 条（${naiveTrueCatches.map((v) => v.id).join(',') || '无'}）`,
  c2ok,
)

// ===========================================================================
// D 段：量具自证（§6.7 三段式的量具版——本门自己也是新量具）
// ===========================================================================
// 正控 = 真语料全安静（A/B/C 段已证）；负控 = 注入已知坏形态必须响；
// 恢复 = 判定核心放回真语料重新安静。判定核心与 B 段共用同一纯函数。

// D1（负控①）：正控样本被抽走 uptake 令牌 ⇒ B1 的判定核心必须抓到
const d1Mutated = validity.map((v) =>
  v.id === 'TDV-03' ? { ...v, reply: v.reply.replace('面试', '那件事') } : v,
)
const d1Caught = positiveUptakeMissing(d1Mutated).map((v) => v.id)
record(
  'D1',
  '注入①：把 TDV-03 的 uptake 令牌抽走 ⇒ 判定核心必须点名它（量具对"合格样本缺接住"不瞎）',
  '点名 TDV-03',
  `点名=${d1Caught.join(',') || '无'}`,
  d1Caught.length === 1 && d1Caught[0] === 'TDV-03',
)

// D2（负控②）：复读样本被塞进 uptake 令牌 ⇒ B3 的判定核心必须抓到
const d2Mutated = validity.map((v) =>
  v.id === 'TDV-09' ? { ...v, reply: `${v.reply}团建的事到时候再说。` } : v,
)
const d2Caught = repetitionViolations(d2Mutated).map((v) => v.id)
record(
  'D2',
  '注入②：给 TDV-09 塞进 uptake 令牌（复读样本出现接住痕迹）⇒ 判定核心必须点名它',
  '点名 TDV-09',
  `点名=${d2Caught.join(',') || '无'}`,
  d2Caught.length === 1 && d2Caught[0] === 'TDV-09',
)

// D3（负控③）：场景语料被抽走一条 ⇒ A1 的判定核心必须报不平衡
const d3Caught = scenarioBalanceProblems(scenarios.slice(0, -1))
record(
  'D3',
  '注入③：场景语料抽走最后一条 ⇒ 平衡判定必须报缺口（计数型检测器不装聋）',
  '报 ≥1 条问题',
  `报=${String(d3Caught.length)} 条（${d3Caught.join(' · ') || '无'}）`,
  d3Caught.length >= 1,
)

// D4（恢复）：判定核心放回真语料 ⇒ 重新安静（0 问题）
const d4Quiet =
  positiveUptakeMissing(validity).length === 0 &&
  repetitionViolations(validity).length === 0 &&
  scenarioBalanceProblems(scenarios).length === 0
record(
  'D4',
  '恢复：判定核心放回未注入的真语料 ⇒ 重新安静（三处判定 0 问题）',
  '0 问题',
  d4Quiet ? '0 问题' : '仍有问题',
  d4Quiet,
)

// ===========================================================================
// 汇总 + 证据
// ===========================================================================

const passed = checks.filter((c) => c.pass).length
const failed = checks.length - passed
const stageA = checks.filter((c) => c.id.startsWith('A')).length
const stageB = checks.filter((c) => c.id.startsWith('B')).length
const stageC = checks.filter((c) => c.id.startsWith('C')).length
const stageD = checks.filter((c) => c.id.startsWith('D')).length
const measured = scenarios.length + validity.length
const stagesValid = stageA > 0 && stageB > 0 && stageC > 0 && stageD > 0 && measured > 0
const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM7RunId({ wpId: 'wp6-td06', headShort: head })
const dir = openM7RunDir(REPO_ROOT, runId)
const payload = {
  schema: 'm7-wp6-td06@1',
  runId,
  capturedAt: new Date().toISOString(),
  head,
  definition: {
    doc: 'docs/m7/M7-WP6-TD06-Definition.md',
    status: 'DEFINITION FROZEN',
    seamNote:
      '定义冻结原派 WP1、未交付（缝缺口）；WP6 按判定契约式硬顺序在造量具前补冻结',
    axes: ['uptake（本轮输入被接住）', 'add/displace（叠加 vs 替代）'],
  },
  instrument: {
    scenarioSet: { name: SCENARIO_SET.name, items: scenarios.length },
    validitySet: { name: VALIDITY_SET.name, items: validity.length },
    judgeValidity: 'WP6-B（需用户授权的真模型轮）；本门零模型调用',
  },
  stages: { shape: stageA, contractDerivable: stageB, keywordDedupInfeasibility: stageC, gaugeSelfProof: stageD },
  measured: { items: measured, checks: checks.length },
  naiveDetector: {
    falsePositives: naiveFalsePositives.map((v) => v.id),
    trueCatches: naiveTrueCatches.map((v) => v.id),
  },
  checks,
  verdict,
  counts: { total: checks.length, passed, failed },
}
writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM7Manifest(dir, {
  runId,
  wp: 'wp6-td06',
  head,
  headShort: head.slice(0, 12),
  branch: 'feature/m7-relationship',
  date: payload.capturedAt.slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'component-verify',
  counts: { total: checks.length, passed, failed },
  phases: ['single'],
  supersedes: null,
  notes: 'TD-06 量具自检：定义冻结（判定契约式四界）+ 场景语料 12 + 有效性集 14 + 关键词去重不可行性证明 + 量具自证三段式（零模型；判定轮归 WP6-B）',
})

console.log(`runId: ${runId}`)
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
}
console.log(
  `stages: 形状=${String(stageA)} · 契约可导=${String(stageB)} · 去重不可行=${String(stageC)} · 量具自证=${String(stageD)} · 语料+有效性=${String(measured)}`,
)
console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
process.exitCode = verdict === 'PASS' ? 0 : 1
