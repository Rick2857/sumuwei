/**
 * Value Gate —— **"这件事值得长期记住吗？"**（计划书第 50–53 节）。
 *
 * ============================================================================
 *  计划书第 50 节把这一层存在的理由写成了一个**失败模式**
 * ============================================================================
 *     M4 最大错误之一就是：
 *         认为 Memory Extractor 每次必须产生东西。
 *     实际健康系统应该经常：REJECT
 *     大量普通对话：根本不值得长期记。
 *
 * 因此 `REJECT` 在本模块里是**正常返回值**，不是异常、不是告警、
 * 也不该让任何指标变红。它只进统计（"这一批 8 条候选里有 7 条被拒"
 * 是一个**健康**的信号）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 计划书第 52 节：**confidence ≠ importance**，必须分开
 * ---------------------------------------------------------------------------
 *     用户明确说："我今天午饭吃了面。"
 *     Confidence 很高。但长期 Value 很低。
 *     所以：confidence ≠ importance。必须分开。
 *
 * 这不是"两个分数更好看"。把两者合并的后果是**二选一**：
 *
 *   要么丢掉确定性 —— "他确定说过这句话"这个信息没了
 *   要么记住垃圾 —— 因为确定性高就给高 importance
 *
 * 因此本模块**读** `candidate.importance`（抽取器填的中性值）
 * 与 `candidate.confidence`（抽取器的自评），返回一个**新的**
 * importance，而 **confidence 原样不动**。
 *
 * ---------------------------------------------------------------------------
 *  计划书第 51 节：只综合四项，不要提前加未来的维度
 * ---------------------------------------------------------------------------
 *     M4 不需要加入：relationship relevance / emotional salience / goal relevance
 *     这些要等相应模块出现。
 *
 * 那三项一旦提前加进来，它们会**永远**停在"用今天的粗糙代理算出来的值"上，
 * 而等 M7/M9/M10 真的建好时，没人会记得回来重算历史记忆的 importance。
 */

import {
  isClaimContent,
  lookupPredicate,
  type MemoryCandidate,
  type MemoryType,
} from '../../contracts/index.ts'

// ---------------------------------------------------------------------------
// 默认阈值
// ---------------------------------------------------------------------------

/**
 * importance 阈值：低于它 → `REJECT`（计划书第 53 节的 Value Gate）。
 *
 * 计划书第 45 节对类似的参数给了明确态度：
 *
 *     不要硬编码一个数字成为领域规则。配置：MEMORY_EXTRACTION_WINDOW
 *     之后通过 Eval 调优。
 *
 * 阈值同理。因此它是**参数**（由 `readMemoryFlags()` 从环境读），
 * 这里的常量只是**缺省值**，且它的值必须能说出理由：
 *
 *   0.45 —— 位于"稳定偏好"（约 0.7）与"一次性状态"（约 0.3）之间。
 *   低于 0.45 的候选通常是一次性事实或低信息量的经历。
 */
export const DEFAULT_IMPORTANCE_THRESHOLD = 0.45

/**
 * 显式要求记住时的覆盖阈值。
 *
 * 计划书第 53 节：
 *
 *     除非 Explicit Remember：用户明确要求记住时，可以覆盖普通 importance policy。
 *
 * ⚠️ "覆盖"的是**阈值**，不是把 importance 写成 1.0。
 * 用户要求记，不等于"这条比所有其它记忆都重要" ——
 * 那是用户没说过的话。因此这里只是让它**免于被阈值拒绝**。
 */
export const EXPLICIT_IMPORTANCE_THRESHOLD = 0

// ---------------------------------------------------------------------------
// 四项因子（计划书第 51 节）
// ---------------------------------------------------------------------------

/**
 * 持久性：这条信息**几个月后**还有效的可能性。
 *
 * 按记忆类型取基线，而不是按内容猜 —— 因为"这句话是否稳定"
 * 恰恰是最需要模型判断的事，而模型判断恰恰是最不该进入
 * "值不值得记"这个 **policy** 的东西（policy 必须可解释、可复现）。
 */
const DURABILITY: Readonly<Record<MemoryType, number>> = {
  // 身份事实：几年都不变
  person_fact: 0.95,
  // 偏好：比较稳定，但会变（"我戒咖啡了"）
  preference: 0.8,
  // 共同经历：永久有效（发生过就是发生过）
  episode: 0.9,
  // 她自己的经历：同上
  self_experience: 0.9,
}

/**
 * 时间限定词的标记。
 *
 * ============================================================================
 *  ⚠️ 它们的作用不是"过滤"，而是**降低持久性**（实测踩到过）
 * ============================================================================
 * 计划书第 11 节明确列了 PERSON_FACT **不适合**的例子：
 *
 *     不适合：Alex 今天似乎心情不好。（后者是推断或短期状态）
 *
 * 而计划书第 52 节的例子更直接：
 *
 *     用户明确说："我今天午饭吃了面。"
 *     Confidence 很高。但长期 Value 很低。
 *
 * 第一版**没有处理这一类**，于是 `lunch.today` 作为 `person_fact`
 * 拿到了 0.95 的 durability 基线，总分约 0.78 —— **通过了值闸**。
 * 也就是说"我今天午饭吃了面"会被长期记住。那正是计划书第 52 节
 * 点名要避免的那件事。
 *
 * 修法：谓词里出现时间限定词 → durability 降到 0.2，
 * **同时**施加一个显式的时间域惩罚因子（让"为什么被拒"在 trace 里可解释）。
 *
 * 为什么用"降 durability + 惩罚因子"而不是"直接 REJECT"：
 * 时间限定**不等于**没价值。"我今天决定戒烟"就是一条带时间限定、
 * 但意义重大且会长期有效的事实。直接拒会丢掉它；
 * 降权则让"值不值得"由总分决定 —— 而那正是值闸该做的事。
 */
const TEMPORAL_MARKERS: readonly string[] = [
  'today',
  'yesterday',
  'tomorrow',
  'now',
  'currently',
  'right.now',
  'this.morning',
  'this.afternoon',
  'this.evening',
  'tonight',
  'moment',
  'temporarily',
]

/** 该谓词是否被时间限定（= 描述的是短期状态而不是稳定事实） */
export function isTimeScopedPredicate(predicate: string): boolean {
  const normalized = ` ${predicate.toLowerCase()} `
  return TEMPORAL_MARKERS.some((marker) => normalized.includes(marker))
}

/** 时间限定的事实**可能**是短暂的，因此持久性大幅降低 */
const TIME_SCOPED_DURABILITY = 0.2

/** 时间域惩罚因子（进 `factors`，让"为什么被拒"可解释） */
const TIME_SCOPED_PENALTY = 0.7

/**
 * 未来有用性：这条记忆在**未来的对话**里被用到的可能性。
 *
 * 已登记的槽位给更高分，理由是**可解释的**：
 * 已登记意味着"这类信息在设计时就被认为会反复出现"
 * （看 `memory-predicates.ts` 的收纳标准）。
 *
 * ⚠️ 但**不是**"未登记就低分"：未登记只说明"我们还没把它收进表"，
 * 而计划书第 19 节明确允许自由键。因此未登记给一个中性偏低的
 * 0.6 而不是 0.2 —— 否则"表没收录"会变成"不许记住"，
 * 而那正是计划书第 19 节反对的"严格封闭"。
 */
function futureUsefulness(candidate: MemoryCandidate): { score: number; registered: boolean } {
  if (!isClaimContent(candidate.proposedContent)) return { score: 0.7, registered: false }
  const lookup = lookupPredicate(candidate.proposedContent.predicate)
  return lookup.kind === 'registered' ? { score: 0.85, registered: true } : { score: 0.6, registered: false }
}

/**
 * 个人相关性：这条记忆**关于说话人本人**的程度。
 *
 * 计划书第 8 节：`subject` 不写死为 user。因此这里问的是
 * "它讲的这个人是不是参与者之一"，而不是"它讲的是不是 user"。
 */
function personalRelevance(candidate: MemoryCandidate): number {
  const subjectIds = new Set(candidate.subjects.map((s) => `${s.kind}:${String(s.id)}`))
  if (subjectIds.size === 0) return 0.3
  // 有多个 subject 说明它是一段"共享"的经历 → 相关性高
  return subjectIds.size >= 2 ? 0.9 : 0.8
}

/**
 * 经历显著性：只在 Episode 家族上有意义。
 *
 * ⚠️ **刻意不用长度、不用关键词**。"这段经历重要吗"是语义判断，
 * 而这里的任何代理（"摘要更长 = 更重要"）都会在真实数据上出错，
 * 且错误方向不可预测。因此 Episode 的显著性主要由
 * `durability` 与 `personalRelevance` 承担，本项**只做一个保守的修正**：
 * 有 topicTags 说明抽取器认为它有可命名的话题（略高）。
 */
function episodeSignificance(candidate: MemoryCandidate): number | undefined {
  if (candidate.proposedType !== 'episode' && candidate.proposedType !== 'self_experience') {
    return undefined
  }
  const tags = isClaimContent(candidate.proposedContent)
    ? undefined
    : candidate.proposedContent.topicTags
  return tags !== undefined && tags.length > 0 ? 0.85 : 0.7
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

export interface ValueEvaluation {
  /** 重算后的 importance（0..1） */
  importance: number
  /** 是否通过 Value Gate */
  passes: boolean
  /** 使用的阈值（进 trace，让"为什么被拒"可解释） */
  threshold: number
  /** 逐项因子（进 trace；让"这个分数怎么来的"可复核） */
  factors: Record<string, number>
  /**
   * 显式要求记住**覆盖**了阈值（计划书第 53 节）。
   *
   * 单独一个布尔字段而不是把阈值直接改成 0：
   * 审计时要能回答"这条低价值记忆为什么在库里"，
   * 而答案必须是"因为用户明确要求记"，不是"因为阈值恰好是 0"。
   */
  explicitOverride: boolean
}

export interface EvaluateValueOptions {
  /** 覆盖默认阈值（由配置读取，计划书第 45 节的态度） */
  threshold?: number
  /** 这一次抽取是显式要求（免于阈值）还是后台发现 */
  explicit?: boolean
  /**
   * 模型自评的 longTermValue（0..1，可选）。
   *
   * 它与规则因子**加权平均**，而不是取其一：
   *   · 只信规则 → 忽略模型对"这段话的重要性"的判断（它在语义上有优势）
   *   · 只信模型 → policy 变成不可解释、不可复现
   * 权重 0.5/0.5 是**刻意的中性**：任一方都不能单独决定。
   */
  modelLongTermValue?: number
}

/**
 * 求值：算出这条候选的 importance 并给出是否通过。
 *
 * **纯函数**：不读时间、不读数据库、不调模型。因此它可以在内存里穷举测试
 * （"什么输入会通过、什么不会"），而 policy 的行为因此是可审计的。
 */
export function evaluateValue(
  candidate: MemoryCandidate,
  options: EvaluateValueOptions = {}
): ValueEvaluation {
  const claimPredicate =
    isClaimContent(candidate.proposedContent) ? candidate.proposedContent.predicate : undefined
  const timeScoped = claimPredicate !== undefined && isTimeScopedPredicate(claimPredicate)

  const durability = timeScoped
    ? TIME_SCOPED_DURABILITY
    : DURABILITY[candidate.proposedType]
  const usefulness = futureUsefulness(candidate)
  const relevance = personalRelevance(candidate)
  const significance = episodeSignificance(candidate)

  const base =
    significance === undefined
      ? // Claim 家族：三项平均
        (durability + usefulness.score + relevance) / 3
      : // Episode 家族：四项平均（显著性只在这里有意义）
        (durability + usefulness.score + relevance + significance) / 4

  // 时间域惩罚：单独一项因子，而不是把它藏进 durability 里 ——
  // 这样 trace 里能回答"为什么这条被拒"，而不是只看到一个偏低的 durability
  const ruleScore = timeScoped ? base * TIME_SCOPED_PENALTY : base

  const modelScore =
    options.modelLongTermValue !== undefined && Number.isFinite(options.modelLongTermValue)
      ? Math.min(1, Math.max(0, options.modelLongTermValue))
      : undefined

  const importance =
    modelScore === undefined ? ruleScore : round(clamp01((ruleScore + modelScore) / 2))

  const explicitOverride = options.explicit === true
  const threshold = explicitOverride
    ? EXPLICIT_IMPORTANCE_THRESHOLD
    : (options.threshold ?? DEFAULT_IMPORTANCE_THRESHOLD)

  return {
    importance: round(importance),
    passes: importance >= threshold,
    threshold,
    factors: {
      durability: round(durability),
      futureUsefulness: round(usefulness.score),
      personalRelevance: round(relevance),
      ...(significance !== undefined ? { episodeSignificance: round(significance) } : {}),
      ...(timeScoped ? { timeScopedPenalty: TIME_SCOPED_PENALTY } : {}),
      ruleScore: round(ruleScore),
      ...(modelScore !== undefined ? { modelLongTermValue: round(modelScore) } : {}),
      ...(usefulness.registered ? { predicateRegistered: 1 } : {}),
    },
    explicitOverride,
  }
}

/**
 * 把求值结果写回候选。
 *
 * ⚠️ **`confidence` 原样保留**（计划书第 52 节）。
 * 这个函数只改 `importance`，且它由 `evaluateValue` 算出 ——
 * 因此"confidence 高但 importance 低"（"我今天午饭吃了面"）
 * 在数据上是可以表达的，而不是被合并成一个数。
 *
 * 返回**新对象**，不改调用方那份（与 `createMemoryCandidate` 复制内容的
 * 同一条理由：悄悄改调用方的对象是那种"只在特定调用顺序下出错"的缺陷）。
 */
export function withImportance(
  candidate: MemoryCandidate,
  evaluation: ValueEvaluation
): MemoryCandidate {
  return {
    ...candidate,
    importance: evaluation.importance,
    // confidence 不动 —— 见上
  }
}

/**
 * 一批候选的值评估结果。
 *
 * 与 `resolveCandidates` 的返回形状同构（判别联合），
 * 因为调用方对它们的处理方式一样：通过的拿去 Policy，未通过的记进 trace 的
 * `memory.rejected_count`。
 */
export type ValueGatedCandidate =
  | { ok: true; candidate: MemoryCandidate; evaluation: ValueEvaluation }
  | { ok: false; candidate: MemoryCandidate; evaluation: ValueEvaluation; reason: string; detail: string }

export function applyValueGate(
  candidates: readonly MemoryCandidate[],
  options: EvaluateValueOptions = {}
): ValueGatedCandidate[] {
  return candidates.map((candidate) => {
    const evaluation = evaluateValue(candidate, options)
    if (!evaluation.passes) {
      return {
        ok: false,
        candidate,
        evaluation,
        reason: 'low_value',
        detail:
          `importance ${evaluation.importance.toFixed(3)} < 阈值 ${evaluation.threshold}（计划书第 53 节）。` +
          'REJECT 是正常结果，不是故障 —— 大量普通对话本来就不值得长期记',
      }
    }
    return { ok: true, candidate: withImportance(candidate, evaluation), evaluation }
  })
}

/** 通过的候选（调用方的常见需求，单独给个便捷函数） */
export function acceptedByValueGate(
  gated: readonly ValueGatedCandidate[]
): MemoryCandidate[] {
  return gated.flatMap((entry) => (entry.ok ? [entry.candidate] : []))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
