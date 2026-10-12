/**
 * Belief 推断规则表 —— **冻结词形**（M9 WP3 / ADR-070 D05·D06·D07）。
 *
 * ============================================================================
 *  这不是"情绪词表"的翻版：B-INFERRED 的判据是**详略选择的明确性**
 * ============================================================================
 * v1 唯一推断槽位 = `interaction.explanation_detail`（detailed | concise）。
 * 合格信号 = 用户对**解释方式**的明确选择/反馈（长期倾向标记 + 详略线索，
 * 或自述偏好声明）；不合格近邻形 = 单次任务要求 / 提问 / 引用 / 假设 /
 * 代述 / 中立比较 / 命令式信念注入 / 反讽。
 *
 * 判据的**权威源是冻结语料**（`evals/fixtures/m9/belief-rule-corpus.json`，
 * 41 条 inferred 样本）：`m9:source:verify` 逐条断言正控召回 100% ·
 * 近邻负控误触发 0%。改任何词形 = 改判据，须回 ADR-070 §13 变更程序
 * 并升 `BELIEF_INFERRED_RULE_VERSION`（不清空 processed 表）。
 *
 * 结构（与 M7/M8 patterns 同族，差异来自判据性质）：
 *   · **守卫先行**：任一守卫命中 ⇒ silent（具名 reason，可审计）——
 *     "他说你讲得太啰嗦"里的"啰嗦"不是她的证据（INV-M9-04 反污染）。
 *   · **守卫优先于正控**：同一条文本既命中守卫又命中正控 ⇒ silent
 *     （负控 bi-n03/n04/n12/n13/n20 的设计意图）。
 *   · **首个正控命中即停**（同值内多模式命中只记一个 patternId；
 *     detailed 与 concise 同时命中 ⇒ 具名回退 `conflicting`，不猜）。
 *
 * 依赖方向：app → contracts（纯函数、无基础设施、无模型调用——D07：
 * LLM evaluator 是未来版本位，输出仍是 proposal、过同一 Validator）。
 */

import { BELIEF_INFERRED_VALUES, type BeliefInferredValue } from '../../contracts/belief.ts'

/** 规则表版本（变更 = 升版本；与 contracts/belief.ts 的冻结常量同源） */
export const BELIEF_INFERRED_RULES_VERSION = 'belief-inferred-rules@1' as const

// ---------------------------------------------------------------------------
// 守卫（负控近邻形；任一命中 ⇒ silent，具名 reason）
// ---------------------------------------------------------------------------

export type BeliefAbstainReason =
  | 'not_user_message' // 非用户直接发言（资格层已挡；此处兜底）
  | 'no_style_signal' // 无任何详略线索（最常见：普通对话）
  | 'single_task_reference' // 单次/任务指涉（这题、这次、这段……）
  | 'quoted_mention' // 引用提及（「说重点」三个字……）
  | 'hypothetical' // 假设/条件句（如果你讲得太细……）
  | 'third_party_report' // 代述/转告/转述（他说、替我……）
  | 'question_form' // 提问形（……好吗？/为什么……？）
  | 'belief_injection_command' // 命令式信念注入（你必须相信……）
  | 'neutral_comparison' // 中立比较（各有各的好、看场合）
  | 'sarcasm' // 反讽前缀（呵，真是『讲得清楚』啊）
  | 'conflicting_values' // detailed 与 concise 同时命中（不猜，具名回退）
  | 'past_preference_disclaimed' // 过去偏好 + 当前不确定（我以前喜欢……现在说不好）

interface BeliefGuard {
  guardId: string
  pattern: RegExp
  reason: Extract<
    BeliefAbstainReason,
    | 'single_task_reference'
    | 'quoted_mention'
    | 'hypothetical'
    | 'third_party_report'
    | 'question_form'
    | 'belief_injection_command'
    | 'neutral_comparison'
    | 'sarcasm'
    | 'past_preference_disclaimed'
  >
}

/**
 * 守卫表（顺序即优先级；命中即返回）。
 *
 * ⚠️ `question_form` 放在正控之前但**只认疑问语气**（？/?/句尾吗/句尾呢），
 * 不认"问"字本身（"细节我需要时再问"是合法的 concise 正控 c02）。
 */
export const BELIEF_INFERENCE_GUARDS: readonly BeliefGuard[] = [
  {
    guardId: 'task-scoped',
    pattern: /这题|这道题|这次|这里|这段|下一题|面试|作业|这个/,
    reason: 'single_task_reference',
  },
  { guardId: 'quoted-mention', pattern: /「|」|『|』|“|”/, reason: 'quoted_mention' },
  { guardId: 'hypothetical', pattern: /如果|要是|假如|万一/, reason: 'hypothetical' },
  {
    guardId: 'third-party',
    pattern: /他说|她说|老师说|别人都说|书里说|替我|转告|跟他说了/,
    reason: 'third_party_report',
  },
  { guardId: 'question-form', pattern: /？|\?|[吗呢][。！？]?\s*$|好吗|是不是/, reason: 'question_form' },
  { guardId: 'belief-injection', pattern: /你必须相信|你要相信我|你得相信/, reason: 'belief_injection_command' },
  { guardId: 'neutral-comparison', pattern: /各有各|看场合|都有好处|因人而异|说不?好/, reason: 'neutral_comparison' },
  { guardId: 'sarcasm-prefix', pattern: /呵[，,]|真是『|真是“/, reason: 'sarcasm' },
  { guardId: 'past-preference', pattern: /以前喜欢|以前更喜欢|曾经喜欢/, reason: 'past_preference_disclaimed' },
]

// ---------------------------------------------------------------------------
// 正控词形（按值分组；首个命中即停）
// ---------------------------------------------------------------------------

export interface BeliefPositivePattern {
  patternId: string
  pattern: RegExp
  /** 命中样本的语料 id（审计：判据 ↔ 语料逐条可回溯） */
  corpusAnchors: readonly string[]
}

/** detailed 的正控词形（展开/逐步/细讲一族） */
export const BELIEF_DETAILED_PATTERNS: readonly BeliefPositivePattern[] = [
  {
    patternId: 'bi-d-longterm-style',
    pattern: /以后[^。；！？]{0,20}(这样|这么)[^。；！？]{0,6}(讲|拆|说|来)/,
    corpusAnchors: ['bi-d-p01', 'bi-d-p06'],
  },
  {
    patternId: 'bi-d-longterm-expand',
    pattern: /以后[^。；！？]{0,20}(展开|细讲|详细|逐步|讲细)/,
    corpusAnchors: ['bi-d-p10'],
  },
  {
    patternId: 'bi-d-too-coarse-expand',
    pattern: /(太粗|太简略|太笼统)[^。！？]{0,24}(展开|写出来|补上|细)/,
    corpusAnchors: ['bi-d-p02', 'bi-d-p07'],
  },
  {
    patternId: 'bi-d-no-skip-steps',
    pattern: /别(跳步|省步骤|跳过步骤|省略步骤)/,
    corpusAnchors: ['bi-d-p03', 'bi-d-p09'],
  },
  {
    patternId: 'bi-d-like-detail',
    pattern: /我喜欢[^。！？]{0,14}(细|详细|展开|一步步)/,
    corpusAnchors: ['bi-d-p04'],
  },
  {
    patternId: 'bi-d-everytime-detail',
    pattern: /每次[^。；！？]{0,18}(展开|细讲|详细|一步步|细)/,
    corpusAnchors: ['bi-d-p05'],
  },
  {
    patternId: 'bi-d-speak-finer',
    pattern: /讲(得)?细一点|讲细点|细一点我才|再细一点/,
    corpusAnchors: ['bi-d-p08'],
  },
  {
    patternId: 'bi-d-step-by-step',
    pattern: /(一步步|逐步)[^。！？]{0,12}(拆|讲|来)/,
    corpusAnchors: ['bi-d-p01', 'bi-d-p06', 'bi-d-p09'],
  },
  {
    patternId: 'bi-d-explain-clearly',
    pattern: /(讲|说)(得|得)?清楚/,
    corpusAnchors: ['bi-d-p03'],
  },
  {
    patternId: 'bi-d-every-step-out',
    pattern: /每(一)?步[^。！？]{0,10}(都)?(写|讲|说|列)/,
    corpusAnchors: ['bi-d-p03', 'bi-d-p07'],
  },
  {
    patternId: 'bi-d-fits-me-detail',
    pattern: /(讲法|说法|讲法|方式)适合我[^。！？]{0,14}(拆|细|逐步)|适合我[^。！？]{0,8}(逐步|拆|细)/,
    corpusAnchors: ['bi-d-p09'],
  },
]

/** concise 的正控词形（重点/结论/短一族） */
export const BELIEF_CONCISE_PATTERNS: readonly BeliefPositivePattern[] = [
  {
    patternId: 'bi-c-verbose',
    pattern: /太?啰嗦|铺垫太?多|写这么长|长篇/,
    corpusAnchors: ['bi-c-p01', 'bi-c-p06', 'bi-c-p08'],
  },
  {
    patternId: 'bi-c-short-speak',
    pattern: /长话短说|简单说|简短说|简单点说/,
    corpusAnchors: ['bi-c-p02', 'bi-c-p07'],
  },
  {
    patternId: 'bi-c-like-concise',
    pattern: /我喜欢[^。！？]{0,10}(简洁|简短|精简)/,
    corpusAnchors: ['bi-c-p03'],
  },
  {
    patternId: 'bi-c-conclusion-first',
    pattern: /(先|直接|只要)给?(出)?结论/,
    corpusAnchors: ['bi-c-p02', 'bi-c-p04', 'bi-c-p07'],
  },
  {
    patternId: 'bi-c-point-first',
    pattern: /(说?重点就行|讲重点|抓重点|说重点|重点先)/,
    corpusAnchors: ['bi-c-p01', 'bi-c-p05'],
  },
  {
    patternId: 'bi-c-direct-tell',
    pattern: /直接(告诉|说|给)/,
    corpusAnchors: ['bi-c-p01', 'bi-c-p06'],
  },
  {
    patternId: 'bi-c-few-lines',
    pattern: /几行以内|三句话|两三句|控制在几行/,
    corpusAnchors: ['bi-c-p03', 'bi-c-p08'],
  },
  {
    patternId: 'bi-c-summary-just-right',
    pattern: /概括(刚好|正好|合适)|简短就好/,
    corpusAnchors: ['bi-c-p09'],
  },
  {
    patternId: 'bi-c-no-expansion',
    pattern: /别(展开|从背景讲起)|不用(展开|这么细|那么细)/,
    corpusAnchors: ['bi-c-p10'],
  },
  {
    patternId: 'bi-c-concise-style',
    pattern: /简洁的?(讲法|说法|风格|解释)/,
    corpusAnchors: ['bi-c-p03'],
  },
]

// ---------------------------------------------------------------------------
// 判定入口（守卫先行 → 正控首中即停 → 双值冲突具名回退）
// ---------------------------------------------------------------------------

export interface BeliefPatternVerdict {
  /** 命中值；silent 时为 undefined */
  value: BeliefInferredValue | undefined
  /** 命中的正控模式（审计） */
  patternId?: string
  /** silent 的具名理由（可审计；undefined = 有命中） */
  abstainReason?: BeliefAbstainReason
  /** 命中的守卫（审计） */
  guardId?: string
}

/**
 * 单条用户文本的推断判定（纯函数）。
 *
 * 判序（冻结）：
 *   1. 守卫表顺序扫描——首中即 silent（守卫优先于正控）；
 *   2. detailed 与 concise 正控各扫一遍（首中即停，记 patternId）；
 *   3. 双值同时命中 ⇒ `conflicting_values`（不猜——D09 同族纪律：
 *      无法判定就不形成，绝不投票）；
 *   4. 单值命中 ⇒ 该值；都未命中 ⇒ `no_style_signal`。
 */
export function judgeExplanationDetail(text: string): BeliefPatternVerdict {
  for (const guard of BELIEF_INFERENCE_GUARDS) {
    if (guard.pattern.test(text)) {
      return { value: undefined, abstainReason: guard.reason, guardId: guard.guardId }
    }
  }

  const detailed = firstMatch(BELIEF_DETAILED_PATTERNS, text)
  const concise = firstMatch(BELIEF_CONCISE_PATTERNS, text)

  if (detailed !== undefined && concise !== undefined) {
    return { value: undefined, abstainReason: 'conflicting_values' }
  }
  if (detailed !== undefined) {
    return { value: 'detailed', patternId: detailed.patternId }
  }
  if (concise !== undefined) {
    return { value: 'concise', patternId: concise.patternId }
  }
  return { value: undefined, abstainReason: 'no_style_signal' }
}

function firstMatch(
  patterns: readonly BeliefPositivePattern[],
  text: string,
): BeliefPositivePattern | undefined {
  for (const p of patterns) {
    if (p.pattern.test(text)) return p
  }
  return undefined
}

/** 取值闭集重导出（判据单一语义源） */
export const BELIEF_INFERRED_VALUE_SET: readonly BeliefInferredValue[] = BELIEF_INFERRED_VALUES
