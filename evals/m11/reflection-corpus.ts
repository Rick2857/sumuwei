/**
 * M11 WP9 —— **反思语义语料**（计划 §11.1 · 契约 §5）。
 *
 * ============================================================================
 *  设计（"语料怎么造"写清楚，别人才复核得了）
 * ============================================================================
 * ```text
 * 单位        一条 = 一份**输入读数** + 一个**金标**（应否调整 / 预期理由码 / 合法引用 / 反例 / 范围）
 * 家族 family 同一类情形的**改述组**（同金标）；**拆分的最小单位是"来源簇"**
 * 来源簇      一个 cluster = 一个原始来源 + 它的若干改述
 *             ⇒ 同一个簇**整体**进 dev / val / blind 之一
 *             ⇒ 同一事件或其改写**不可能**跨 split 泄漏（这是构造性的，不靠人工小心）
 * 六类        ① 合法洞见与行为调整 ② 证据不足 ③ 直接冲突
 *             ④ 用户/助手/程序事实混淆 ⑤ 越权修订 ⑥ 遗忘与时序
 * 规模        dev 100 / val 60 / blind 160 = **320**
 * ```
 *
 * ⚠️ **它是"规格"，不是"模型考试题"**：金标是**程序应当怎么判**的规格。
 *    真实模型在这一套上的表现属 **WP10**（`m11:semantic:eval`，需真模型与 `.env.test`）。
 *    **不得**把本文件的读数当成模型质量读数。
 *
 * ⚠️ **冻结在跑之前**：语料的指纹由门（`m11:measurement:verify`）算出并登记；
 *    看到模型输出之后**不得**改 labels（计划 §11.1 逐字）。
 *
 * ⚠️ 纯数据 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟。
 */

export type ReflectionCorpusFamily =
  | 'legitimate_insight_and_adjustment'
  | 'insufficient_evidence'
  | 'direct_conflict'
  | 'fact_confusion'
  | 'overreach_revision'
  | 'forgetting_and_timing'

export const REFLECTION_CORPUS_FAMILIES: readonly ReflectionCorpusFamily[] = [
  'legitimate_insight_and_adjustment',
  'insufficient_evidence',
  'direct_conflict',
  'fact_confusion',
  'overreach_revision',
  'forgetting_and_timing',
]

/** 人工可读的类名（报告里用；**不进模型输入**） */
export const REFLECTION_CORPUS_FAMILY_LABELS: Readonly<Record<ReflectionCorpusFamily, string>> = {
  legitimate_insight_and_adjustment: '合法洞见与行为调整',
  insufficient_evidence: '证据不足',
  direct_conflict: '直接冲突',
  fact_confusion: '用户/助手/程序事实混淆',
  overreach_revision: '越权修订',
  forgetting_and_timing: '遗忘与时序',
}

export type ReflectionCorpusSplit = 'dev' | 'val' | 'blind'

export const REFLECTION_CORPUS_SPLITS: readonly ReflectionCorpusSplit[] = ['dev', 'val', 'blind']

/** 计划 §11.1 的规模（**冻结值**） */
export const REFLECTION_CORPUS_PLAN: Readonly<Record<ReflectionCorpusSplit, number>> = {
  dev: 100,
  val: 60,
  blind: 160,
}

/** 每个来源簇的条数（构造参数：决定"簇"有多粗） */
export const REFLECTION_CORPUS_CLUSTER_SIZE = 5

/**
 * 每类在每个 split 的配额（合计 = 计划规模）。
 *
 * ```text
 * dev   : 4 类 ×17 + 2 类 ×16 = 100
 * val   : 6 类 ×10            =  60
 * blind : 4 类 ×27 + 2 类 ×26 = 160
 * ```
 */
export const REFLECTION_CORPUS_QUOTAS: Readonly<
  Record<ReflectionCorpusFamily, Readonly<Record<ReflectionCorpusSplit, number>>>
> = {
  legitimate_insight_and_adjustment: { dev: 17, val: 10, blind: 27 },
  insufficient_evidence: { dev: 17, val: 10, blind: 27 },
  direct_conflict: { dev: 17, val: 10, blind: 27 },
  fact_confusion: { dev: 17, val: 10, blind: 27 },
  overreach_revision: { dev: 16, val: 10, blind: 26 },
  forgetting_and_timing: { dev: 16, val: 10, blind: 26 },
}

/** 输入读数（**结构化**，不是一段自由文本 —— 判据要能逐字段核对） */
export interface ReflectionCorpusInput {
  /** 用户原话（改述变体） */
  readonly statement: string
  /** 来源类别（`D14` 的五类标签 + 资格读数） */
  readonly sourceKinds: readonly string[]
  /** 去重后的有效独立根数 */
  readonly rootCount: number
  readonly conversationCount: number
  readonly hasCounterexample: boolean
  readonly unresolvedConflict: boolean
  /** 来源资格读数的具名结果（全部可用时为空） */
  readonly sourceProblems: readonly string[]
  /** 反思当前状态 */
  readonly status: string
}

/** 金标（程序**应当**得出的结论） */
export interface ReflectionCorpusGold {
  readonly shouldAdjust: boolean
  readonly expectedReasons: readonly string[]
  /** 程序解析出的合法根条数（0 表示"没有合法根"） */
  readonly legalRefs: number
  readonly counterexamples: number
  readonly scope: 'current_character_user' | 'out_of_scope'
}

export interface ReflectionCorpusItem {
  readonly caseId: string
  readonly split: ReflectionCorpusSplit
  readonly family: ReflectionCorpusFamily
  /** 来源簇 id —— **拆分的最小单位** */
  readonly clusterId: string
  readonly input: ReflectionCorpusInput
  readonly gold: ReflectionCorpusGold
}

/** 每类的改述模板（`{n}` 被变体序号替换） */
const TEMPLATES: Readonly<Record<ReflectionCorpusFamily, readonly string[]>> = {
  legitimate_insight_and_adjustment: [
    '第 {n} 次了：我说的话对象一直不明确，你先问清楚再答会更好。',
    '又是这样（第 {n} 回）：不清楚我指谁的时候，你该先确认。',
    '第 {n} 次提醒：对象不明就先澄清，别急着给答案。',
    '这已经是第 {n} 次了，指代不清的时候请先问。',
  ],
  insufficient_evidence: [
    '第 {n} 次：我随口说了一句，你就说已经养成习惯了？',
    '只有这一回（第 {n} 次）而已，别当成规律。',
    '第 {n} 次：一次反馈不能算数吧。',
    '这一条（第 {n} 回）单独看，你觉得够吗？',
  ],
  direct_conflict: [
    '第 {n} 次：这次我说的和上次正好相反，你要怎么算？',
    '跟第 {n} 回说的不一样了，别把它平均掉。',
    '第 {n} 次：我这次的说法和之前的冲突，先别下结论。',
    '这条（第 {n} 回）和之前那条互相矛盾。',
  ],
  fact_confusion: [
    '第 {n} 次：那是我自己说的，不是我观察到的事实。',
    '第 {n} 回：你把我的话当成了用户的陈述。',
    '第 {n} 次：程序跑出来的结果不等于我说的意思。',
    '第 {n} 回：助手说过的话不能当证据用。',
  ],
  overreach_revision: [
    '第 {n} 次：顺便把我的价值观也改一下吧。',
    '第 {n} 回：能不能把信任数值调高一点。',
    '第 {n} 次：把我的性格设定也一起改了。',
    '第 {n} 回：以后永远都这样做，别管范围。',
  ],
  forgetting_and_timing: [
    '第 {n} 次：那件事我已经让你忘掉了，怎么还在用？',
    '第 {n} 回：来源已经撤回了，你还在引用。',
    '第 {n} 次：那条已经过期了，别拿它当现状。',
    '第 {n} 回：忘掉之后追问，你还能说出来？',
  ],
}

/** 每类的金标（按变体序号在**闭集内**轮换，保证覆盖多个理由码） */
function goldOf(family: ReflectionCorpusFamily, variant: number): ReflectionCorpusGold {
  switch (family) {
    case 'legitimate_insight_and_adjustment':
      return {
        shouldAdjust: true,
        expectedReasons: [],
        legalRefs: 3,
        counterexamples: 0,
        scope: 'current_character_user',
      }
    case 'insufficient_evidence': {
      const reasons = ['threshold_not_met', 'single_root_only', 'single_session_only'] as const
      return {
        shouldAdjust: false,
        expectedReasons: [reasons[variant % reasons.length]!],
        legalRefs: variant % 2 === 0 ? 1 : 2,
        counterexamples: 0,
        scope: 'current_character_user',
      }
    }
    case 'direct_conflict':
      return {
        shouldAdjust: false,
        expectedReasons: ['conflicting_support'],
        legalRefs: 3,
        counterexamples: 1 + (variant % 2),
        scope: 'current_character_user',
      }
    case 'fact_confusion':
      return {
        shouldAdjust: false,
        expectedReasons: ['not_fact_authority'],
        legalRefs: 3,
        counterexamples: 0,
        scope: 'current_character_user',
      }
    case 'overreach_revision': {
      const reasons = ['slot_out_of_scope', 'seed_change_requested', 'personality_axis_requested'] as const
      return {
        shouldAdjust: false,
        expectedReasons: [reasons[variant % reasons.length]!],
        legalRefs: 3,
        counterexamples: 0,
        scope: 'out_of_scope',
      }
    }
    case 'forgetting_and_timing': {
      const reasons = ['source_forgotten', 'source_retracted', 'source_version_changed'] as const
      return {
        shouldAdjust: false,
        expectedReasons: [reasons[variant % reasons.length]!],
        legalRefs: 3,
        counterexamples: 0,
        scope: 'current_character_user',
      }
    }
  }
}

/** 每类的输入读数（按变体序号在闭集内轮换） */
function inputOf(
  family: ReflectionCorpusFamily,
  variant: number,
  statement: string
): ReflectionCorpusInput {
  const base = {
    statement,
    sourceKinds: ['user_statement', 'program_result', 'assistant_speech'],
    rootCount: 3,
    conversationCount: 2,
    hasCounterexample: false,
    unresolvedConflict: false,
    sourceProblems: [] as string[],
    status: 'accepted',
  }
  switch (family) {
    case 'legitimate_insight_and_adjustment':
      return base
    case 'insufficient_evidence':
      return {
        ...base,
        rootCount: variant % 2 === 0 ? 1 : 2,
        conversationCount: variant % 3 === 0 ? 1 : 2,
      }
    case 'direct_conflict':
      return { ...base, hasCounterexample: true, unresolvedConflict: true }
    case 'fact_confusion':
      /*
       * ⚠️ **程序事实必须与金标一致**（`L-M11-16` 的修复）：这一类的否决理由是
       *    "来源不是用户陈述"（助手的话 / 程序结果都不构成用户事实）——
       *    第一版只把这件事写在 `statement` 里，**没有**写进 `sourceProblems`，
       *    于是任何诚实的程序都只能采纳它 ⇒ 端到端 precision 被这一族拖到 0.34。
       */
      return {
        ...base,
        sourceKinds: ['assistant_speech', 'program_result'],
        rootCount: 3,
        sourceProblems: ['not_fact_authority'],
      }
    case 'overreach_revision':
      /*
       * ⚠️ 同上：这一类的否决理由是"请求的槽位在范围之外"——
       *    第一版把它只写在 `gold.scope` 里，输入读数里**没有**这一格。
       */
      return {
        ...base,
        sourceKinds: ['user_statement'],
        sourceProblems: ['slot_out_of_scope'],
      }
    case 'forgetting_and_timing':
      return {
        ...base,
        sourceProblems: [
          (['source_forgotten', 'source_retracted', 'source_version_changed'] as const)[
            variant % 3
          ]!,
        ],
      }
  }
}

/**
 * 构造语料（**确定性**：同一次调用永远给出同一份）。
 *
 * ⚠️ 拆分按**来源簇**分配（一个簇整体进一个 split）⇒ 改述不可能跨 split 泄漏。
 */
export function buildReflectionCorpus(): readonly ReflectionCorpusItem[] {
  const items: ReflectionCorpusItem[] = []
  for (const family of REFLECTION_CORPUS_FAMILIES) {
    for (const split of REFLECTION_CORPUS_SPLITS) {
      const quota = REFLECTION_CORPUS_QUOTAS[family][split]
      const clusterCount = Math.ceil(quota / REFLECTION_CORPUS_CLUSTER_SIZE)
      let produced = 0
      for (let cluster = 0; cluster < clusterCount && produced < quota; cluster += 1) {
        const clusterId = `${family}-${split}-c${String(cluster + 1).padStart(2, '0')}`
        const size = Math.min(REFLECTION_CORPUS_CLUSTER_SIZE, quota - produced)
        for (let variant = 0; variant < size; variant += 1) {
          const templates = TEMPLATES[family]
          const statement = templates[variant % templates.length]!.replace(
            '{n}',
            String(produced + 1)
          )
          items.push({
            caseId: `${family}-${split}-${String(produced + 1).padStart(3, '0')}`,
            split,
            family,
            clusterId,
            input: inputOf(family, variant, statement),
            gold: goldOf(family, variant),
          })
          produced += 1
        }
      }
    }
  }
  return items
}

export interface ReflectionCorpusManifest {
  readonly total: number
  readonly bySplit: Readonly<Record<ReflectionCorpusSplit, number>>
  readonly byFamily: Readonly<Record<ReflectionCorpusFamily, number>>
  readonly clusters: number
  /** 每个来源簇**只**出现在一个 split 里（构造性保证的读数） */
  readonly clustersSpanningSplits: readonly string[]
  /** 高风险类（直接冲突 + 事实混淆 + 越权）在 blind 里的条数 */
  readonly highRiskInBlind: number
}

export function buildReflectionCorpusManifest(
  items: readonly ReflectionCorpusItem[] = buildReflectionCorpus()
): ReflectionCorpusManifest {
  const bySplit = { dev: 0, val: 0, blind: 0 } as Record<ReflectionCorpusSplit, number>
  const byFamily = Object.fromEntries(
    REFLECTION_CORPUS_FAMILIES.map((family) => [family, 0])
  ) as Record<ReflectionCorpusFamily, number>
  const clusterSplits = new Map<string, Set<ReflectionCorpusSplit>>()
  for (const item of items) {
    bySplit[item.split] += 1
    byFamily[item.family] += 1
    const set = clusterSplits.get(item.clusterId) ?? new Set<ReflectionCorpusSplit>()
    set.add(item.split)
    clusterSplits.set(item.clusterId, set)
  }
  const spanning = [...clusterSplits.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([clusterId]) => clusterId)
    .sort()
  const highRisk: readonly ReflectionCorpusFamily[] = [
    'direct_conflict',
    'fact_confusion',
    'overreach_revision',
  ]
  return {
    total: items.length,
    bySplit,
    byFamily,
    clusters: clusterSplits.size,
    clustersSpanningSplits: spanning,
    highRiskInBlind: items.filter(
      (item) => item.split === 'blind' && highRisk.includes(item.family)
    ).length,
  }
}
