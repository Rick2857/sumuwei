/**
 * M6.1 WP4 / ADR-055 §4.2–§4.3：**验收用的两套集**的常量与校验。
 *
 * ⚠️ 为什么要有这个模块（而不是让门各自去读 JSONL）
 * ```text
 * ① 集名、类别 ID、样本编号区间是**冻结规范**（用户给定）⇒ 写在一处，门只消费。
 * ② 校验必须是**纯函数**，才能被 L1 直接调、也才能对"注入坏形态"做负控。
 * ③ 计数型自检：条目数 / 每类条数 / id 与区间一致性 —— 任何一项为 0 或对不上都必须是
 *    "MEASUREMENT INVALID"，**不是**"全过"（本仓库反复登记的那类损失）。
 * ```
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 产品正控集（支持性回忆）—— 用户给定的冻结规范。 */
export const SUPPORTED_RECALL_SET = {
  name: 'supported_recall_positive_v1',
  path: 'evals/m6.1/control/supported-recall-positive-v1.jsonl',
  perCategory: 10,
  categories: [
    {
      id: 'explicit_fact_recall',
      letter: 'A',
      label: '用户显式事实回忆',
      successCondition: '正确回答用户明确提供的事实',
    },
    {
      id: 'grounded_detail_recall',
      letter: 'B',
      label: '有据细节回忆',
      successCondition: '正确回答已有依据的细节，不添加无依据内容',
    },
    {
      id: 'updated_value_recall',
      letter: 'C',
      label: '更正后有效值回忆',
      successCondition: '使用更正后的有效值；涉及历史时正确区分新旧',
    },
  ],
} as const

/** 具名必修反例集 —— 用户给定的冻结规范（条目**待落库**）。 */
export const REQUIRED_COUNTEREXAMPLES_SET = {
  name: 'required_counterexamples_v1',
  path: 'evals/m6.1/control/required-counterexamples-v1.jsonl',
  categories: [
    { id: 'unsupported_shared_experience', label: '无依据共同经历断言', from: ['P1-a', 'P1-b'] },
    { id: 'unsupported_detail', label: '无依据细节补造', from: ['P2', 'P2′'] },
    { id: 'correction_not_applied', label: '显式更正未执行', from: ['P3-a'] },
    { id: 'update_not_superseded', label: '状态更新未取代旧值', from: ['P3-a′'] },
    { id: 'forgotten_value_reuse', label: '遗忘后旧值被当作有效事实使用', from: ['P3-b', 'P3-b′'] },
  ],
} as const

export interface SupportedRecallItem {
  readonly id: string
  readonly category: string
  readonly basisKind: 'memory_slot' | 'dialogue_recent'
  readonly setup: readonly string[]
  readonly question: string
  readonly expectedPoints: readonly string[]
  readonly forbidden: readonly string[]
  readonly source: { readonly kind: string; readonly slot: string | null; readonly ref: string }
  readonly successCondition: string
}

export function loadSupportedRecallSet(root: string): SupportedRecallItem[] {
  const abs = join(root, SUPPORTED_RECALL_SET.path)
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.map((line) => JSON.parse(line) as SupportedRecallItem)
}

const nonEmpty = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 && value.every((v) => String(v).trim() !== '') : String(value ?? '').trim() !== ''

/**
 * 校验一套正控集。返回**具名问题**列表（空 = 合格）。
 *
 * ⚠️ 计数型自检写死在第一段：条目数为 0 时**不返回空**，而是返回一条具名问题 ——
 *    "检查了 0 条、发现 0 处问题"与"全部合格"在输出上长得一样。
 */
export function validateSupportedRecallSet(items: readonly SupportedRecallItem[]): string[] {
  const problems: string[] = []
  if (items.length === 0) {
    return ['MEASUREMENT INVALID：集里 0 条 ⇒ "没测到"不能算合格']
  }

  const expectedTotal = SUPPORTED_RECALL_SET.perCategory * SUPPORTED_RECALL_SET.categories.length
  if (items.length !== expectedTotal) {
    problems.push(`条目数 ${String(items.length)} ≠ 冻结的 ${String(expectedTotal)}`)
  }

  const byCategory = new Map<string, number>()
  const seen = new Set<string>()
  for (const item of items) {
    const category = SUPPORTED_RECALL_SET.categories.find((c) => c.id === item.category)
    if (category === undefined) {
      problems.push(`${item.id}：类别 "${item.category}" 不在冻结集里`)
      continue
    }
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1)

    if (seen.has(item.id)) problems.push(`id 重复：${item.id}`)
    seen.add(item.id)

    const match = /^SRP-([ABC])-(\d{2})$/.exec(item.id)
    if (match === null) {
      problems.push(`${item.id}：id 形状不是 SRP-<A|B|C>-NN`)
    } else if (match[1] !== category.letter) {
      problems.push(`${item.id}：id 字母 ${String(match[1])} 与类别 ${item.category} 不符`)
    } else if (Number(match[2]) < 1 || Number(match[2]) > SUPPORTED_RECALL_SET.perCategory) {
      problems.push(`${item.id}：编号超出 01..${String(SUPPORTED_RECALL_SET.perCategory)}`)
    }

    /* 逐条必备字段（用户要求：依据 / 来源 / 预期答案要点 / 不允许添加的内容） */
    if (!nonEmpty(item.setup)) problems.push(`${item.id}：setup 为空 ⇒ 没有"足够回答问题的依据"`)
    if (!nonEmpty(item.question)) problems.push(`${item.id}：question 为空`)
    if (!nonEmpty(item.expectedPoints)) problems.push(`${item.id}：expectedPoints 为空 ⇒ "不知道"会被算成成功`)
    if (!nonEmpty(item.forbidden)) problems.push(`${item.id}：forbidden 为空 ⇒ 未登记"不允许添加的内容"`)
    if (!nonEmpty(item.successCondition)) problems.push(`${item.id}：successCondition 为空`)
    if (item.successCondition.includes('不知道') && !item.successCondition.includes('不')) {
      problems.push(`${item.id}：successCondition 把"不知道"算成了成功`)
    }

    /* 依据路径与来源必须自洽：宣称走记忆槽位就必须给得出槽位 */
    if (item.basisKind === 'memory_slot' && (item.source?.slot ?? null) === null) {
      problems.push(`${item.id}：basisKind=memory_slot 但 source.slot 为空 ⇒ 依据路径标注不可信`)
    }
    if (item.basisKind === 'dialogue_recent' && (item.source?.slot ?? null) !== null) {
      problems.push(`${item.id}：basisKind=dialogue_recent 却写了槽位`)
    }
    if (!['memory_slot', 'dialogue_recent'].includes(item.basisKind)) {
      problems.push(`${item.id}：basisKind 非法（${String(item.basisKind)}）`)
    }
  }

  for (const category of SUPPORTED_RECALL_SET.categories) {
    const count = byCategory.get(category.id) ?? 0
    if (count !== SUPPORTED_RECALL_SET.perCategory) {
      problems.push(`类别 ${category.id} 有 ${String(count)} 条 ≠ ${String(SUPPORTED_RECALL_SET.perCategory)}`)
    }
  }

  return problems
}

/* ===========================================================================
 * ② 具名必修反例集 required_counterexamples_v1（零容忍）
 * =========================================================================== */

export interface CounterexampleItem {
  readonly id: string
  readonly category: string
  readonly basisKind: string
  readonly setup: readonly string[]
  readonly question: string
  readonly mustNotProduce: readonly string[]
  readonly requiredBehaviour: string
  readonly source: { readonly kind: string; readonly ref: string }
  readonly humanReview: boolean
}

function readJsonl<T>(root: string, relPath: string): T[] {
  const lines = readFileSync(join(root, relPath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  return lines.map((line) => JSON.parse(line) as T)
}

export const loadCounterexamples = (root: string): CounterexampleItem[] =>
  readJsonl<CounterexampleItem>(root, REQUIRED_COUNTEREXAMPLES_SET.path)

export function validateCounterexamples(items: readonly CounterexampleItem[]): string[] {
  const problems: string[] = []
  if (items.length === 0) return ['MEASUREMENT INVALID：反例集 0 条 ⇒ "没测到"不能算合格']

  const seen = new Set<string>()
  const byCategory = new Map<string, number>()
  for (const item of items) {
    const known = REQUIRED_COUNTEREXAMPLES_SET.categories.find((c) => c.id === item.category)
    if (known === undefined) problems.push(`${item.id}：类别不在冻结的 5 类里（${item.category}）`)
    else byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1)

    if (seen.has(item.id)) problems.push(`id 重复：${item.id}`)
    seen.add(item.id)
    if (!/^RCE-\d{2}$/.test(item.id)) problems.push(`${item.id}：id 形状不是 RCE-NN`)
    if (!nonEmpty(item.question)) problems.push(`${item.id}：question 为空`)
    if (!nonEmpty(item.mustNotProduce)) problems.push(`${item.id}：mustNotProduce 为空 ⇒ 没登记"不许出现什么"`)
    if (!nonEmpty(item.requiredBehaviour)) problems.push(`${item.id}：requiredBehaviour 为空`)
    /* 自洽：要做人审的，必须是"原始输入未保留"那一类 */
    if (item.humanReview && item.basisKind !== 'real_trajectory') {
      problems.push(`${item.id}：标了 humanReview 但 basisKind 不是 real_trajectory`)
    }
  }
  for (const category of REQUIRED_COUNTEREXAMPLES_SET.categories) {
    if ((byCategory.get(category.id) ?? 0) === 0) problems.push(`类别 ${category.id} 一条都没有`)
  }
  /* 计数型自检：全是人审项 ⇒ 门里没有任何可跑项，那不是"全过" */
  if (items.every((item) => item.humanReview)) {
    problems.push('全部条目都要人审 ⇒ 门里没有可跑的项（不是"全部通过"）')
  }
  return problems
}

/* ===========================================================================
 * ③ 正常写入正控 explicit_write_positive_v1（10 条 · 零容忍）
 * =========================================================================== */

export const EXPLICIT_WRITE_SET = {
  name: 'explicit_write_positive_v1',
  path: 'evals/m6.1/control/explicit-write-positive-v1.jsonl',
  expected: 10,
} as const

export interface ExplicitWriteItem {
  readonly id: string
  readonly slot: string
  readonly setup: readonly string[]
  readonly expectedOutcome: string
  readonly expectedStoredValue: string
  readonly forbidden: readonly string[]
  readonly source: { readonly kind: string; readonly ref: string }
  readonly note: string
}

export const loadExplicitWriteSet = (root: string): ExplicitWriteItem[] =>
  readJsonl<ExplicitWriteItem>(root, EXPLICIT_WRITE_SET.path)

export function validateExplicitWriteSet(items: readonly ExplicitWriteItem[]): string[] {
  const problems: string[] = []
  if (items.length === 0) return ['MEASUREMENT INVALID：写入正控 0 条 ⇒ "没测到"不能算合格']
  if (items.length !== EXPLICIT_WRITE_SET.expected) {
    problems.push(`条目数 ${String(items.length)} ≠ 冻结的 ${String(EXPLICIT_WRITE_SET.expected)}`)
  }
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) problems.push(`id 重复：${item.id}`)
    seen.add(item.id)
    if (!/^EWP-\d{2}$/.test(item.id)) problems.push(`${item.id}：id 形状不是 EWP-NN`)
    if (!nonEmpty(item.slot)) problems.push(`${item.id}：slot 为空 ⇒ 写不进任何槽位，做不成正控`)
    if (!nonEmpty(item.expectedStoredValue)) problems.push(`${item.id}：expectedStoredValue 为空`)
    if (!nonEmpty(item.forbidden)) problems.push(`${item.id}：forbidden 为空`)
    if (!['written', 'already_applied'].includes(item.expectedOutcome)) {
      problems.push(`${item.id}：expectedOutcome 非法（${item.expectedOutcome}）`)
    }
    /* 幂等只能靠"重复同一句"证明 ⇒ 期望 already_applied 的条目必须至少两轮 setup */
    if (item.expectedOutcome === 'already_applied' && item.setup.length < 2) {
      problems.push(`${item.id}：期望 already_applied 但 setup 只有 ${String(item.setup.length)} 轮`)
    }
    if (!nonEmpty(item.setup)) problems.push(`${item.id}：setup 为空`)
  }
  return problems
}

/* ===========================================================================
 * ④ 更正意图误触发负控 correction_intent_negative_v1（12 条 = 6 类 × 2 · 零容忍）
 * =========================================================================== */

export const CORRECTION_NEGATIVE_SET = {
  name: 'correction_intent_negative_v1',
  path: 'evals/m6.1/control/correction-intent-negative-v1.jsonl',
  perCategory: 2,
  categories: ['quotation', 'negation', 'hypothesis', 'word_discussion', 'plain_text_edit', 'non_memory_object'],
} as const

export interface CorrectionNegativeItem {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly mustNotChangeMemory: boolean
  readonly note: string
}

export const loadCorrectionNegativeSet = (root: string): CorrectionNegativeItem[] =>
  readJsonl<CorrectionNegativeItem>(root, CORRECTION_NEGATIVE_SET.path)

export function validateCorrectionNegativeSet(items: readonly CorrectionNegativeItem[]): string[] {
  const problems: string[] = []
  if (items.length === 0) return ['MEASUREMENT INVALID：误触发负控 0 条 ⇒ "没测到"不能算合格']
  const expected = CORRECTION_NEGATIVE_SET.perCategory * CORRECTION_NEGATIVE_SET.categories.length
  if (items.length !== expected) {
    problems.push(`条目数 ${String(items.length)} ≠ 冻结的 ${String(expected)}（6 类 × 2）`)
  }
  const byCategory = new Map<string, number>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) problems.push(`id 重复：${item.id}`)
    seen.add(item.id)
    if (!/^CIN-\d{2}$/.test(item.id)) problems.push(`${item.id}：id 形状不是 CIN-NN`)
    if (!(CORRECTION_NEGATIVE_SET.categories as readonly string[]).includes(item.category)) {
      problems.push(`${item.id}：类别不在冻结的 6 类里（${item.category}）`)
    } else {
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1)
    }
    if (!nonEmpty(item.text)) problems.push(`${item.id}：text 为空`)
    /* 判据是 mutation 级：每条都必须声明"不许改库" —— 漏了就等于没判据 */
    if (item.mustNotChangeMemory !== true) problems.push(`${item.id}：没声明 mustNotChangeMemory`)
  }
  for (const category of CORRECTION_NEGATIVE_SET.categories) {
    const count = byCategory.get(category) ?? 0
    if (count !== CORRECTION_NEGATIVE_SET.perCategory) {
      problems.push(`类别 ${category} 有 ${String(count)} 条 ≠ ${String(CORRECTION_NEGATIVE_SET.perCategory)}`)
    }
  }
  return problems
}
