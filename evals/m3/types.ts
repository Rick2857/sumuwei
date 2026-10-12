/**
 * M3 人格与完整性评测 —— **类型定义**（WP9 的地基）。
 *
 * ============================================================================
 *  计划书第 47–68 / 96 / 142 节
 * ============================================================================
 * M3 引入了本项目的**第一次人格评测**，而计划书对它的要求很具体：
 *
 *   > M3 的人格稳定性测试不能只看"感觉"。
 *
 * 所以这里有三个层次，且**分开计分**（计划书第 47/57 节）：
 *
 *   行为规则一致性      → `deterministic` 检查（完全程序判定）
 *   表层语言风格一致性  → Style Adherence（SA）
 *   深层人格倾向一致性  → Personality Consistency（PC）
 *
 * ---------------------------------------------------------------------------
 *  三条不可退让的设计约束
 * ---------------------------------------------------------------------------
 * 1. **能程序判断的不用 LLM Judge**（计划书第 52 节）。
 *    所以检查分两类，且一个用例可以同时有两类：
 *      · `deterministic` —— 读 Trace / 账本 / 快照的数值与字段，纯函数判定
 *      · `judge`         —— 只有"像不像她"这类问题才交给模型评分
 *
 * 2. **允许每次措辞不同**（计划书第 64 节）。
 *    人格一致 ≠ 文本确定。因此 judge 评价的是 **trait direction**，
 *    而不是 exact wording。这一条写在类型注释里，因为它是评测设计里
 *    最容易被后来者破坏的一点（把 judge 写成"必须包含某个词"）。
 *
 * 3. **阈值由 Baseline 决定，不拍脑袋**（计划书第 119/120 节）。
 *    所以 `EvalThresholds` 是**数据**，由 baseline 文件提供；
 *    第一轮只建立 baseline，第二轮才冻结 Gate 阈值。
 *
 * ---------------------------------------------------------------------------
 *  为什么评测定义住在 evals/ 而不是 src/
 * ---------------------------------------------------------------------------
 * 与 M2.5 的 SC-001~SC-007 同一个道理：评测是"行为回归的 canonical 定义"，
 * Promptfoo 只是它的执行器之一（计划书第 50/54 节）。
 * 把用例写进 Promptfoo 的 YAML 就等于让外部工具的配置文件成为唯一真相。
 */

import type { ConversationEvent, IdentitySnapshot } from '../../src/kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

/**
 * 一次评测运行留下的**原始观测**。
 *
 * 刻意把"运行"与"判定"分开：`EvalObservation` 只记录发生了什么
 * （她说了什么、Trace 里是什么、账本里多了什么），
 * 判定逻辑写在检查里。于是同一份观测可以被多个检查复用，
 * 也可以在 baseline 里被重新分析，而不必重跑模型。
 */
export interface EvalObservation {
  caseId: string
  /** 这一轮她实际说出口的话 */
  reply: string
  /** 本轮使用的身份快照（**必须**有：否则无法回答"用了哪版人格"） */
  identity: IdentitySnapshot
  /** 本轮 Trace 的 key 字段（不存在 = 这一轮没走 ContextCompiler） */
  trace: {
    traceId: string
    compilerVersion: string
    sectionIds: string[]
    droppedSectionIds: string[]
    identitySourceRefs: string[]
    seedVersion?: number
    seedHash?: string
    outputEventId?: string
  }
  /** 本轮之后账本里新增的事件 */
  newEvents: ConversationEvent[]
  /** 会话内序号（用于"新会话从 1 重新开始"这类断言） */
  conversationSequence: number
  /** 自由元数据（用例自定义，例如匿名模式下用的显示名） */
  attributes?: Record<string, unknown>
  durationMs: number
}

/** 一个确定性检查的结论 */
export interface CheckResult {
  pass: boolean
  /** 未通过时的人类可读说明（**必须**能让人不问就知道哪里不对） */
  detail?: string
  /** 用的什么量测（进报告；例如 `seed_version=2`） */
  measured?: string
}

export interface DeterministicCheck {
  kind: 'deterministic'
  id: string
  description: string
  /**
   * 判定。**必须是纯函数**：只读观测，不调模型、不读时间、不写库。
   *
   * 之所以强制纯函数：确定性检查的价值在于"同样的观测永远得到同样的结论"，
   * 一旦它开始调模型，"确定性"这个词就没了。
   */
  check: (observation: EvalObservation) => CheckResult
}

export interface JudgeCheck {
  kind: 'judge'
  id: string
  description: string
  /** 评的是哪个指标（PC / SA / 其它），用于分组报告 */
  metric: 'PC' | 'SA' | 'DRIFT' | 'RECOVERY' | 'TRAIT_ALIGNMENT'
  /**
   * 评分提示词（中文，直接发给 judge 模型）。
   *
   * ⚠️ 必须**只说 trait direction**，不许要求固定措辞（计划书第 64 节）。
   * `{{reply}}` / `{{seedTraits}}` / `{{question}}` 会被替换。
   */
  rubric: string
  /** 通过线（0..1）。默认 0.6 —— 偏保守：宁可报警，也不要放过漂移 */
  threshold?: number
}

export type EvalCheck = DeterministicCheck | JudgeCheck

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** 一轮输入。`expectFunctions` 保留给 M3 之后的 function calling（现在不用）。 */
export interface EvalTurn {
  /** 用户说的话 */
  user: string
  /** 期望她**不会**说的话（确定性检查里的最简单形式，用于明显的泄漏） */
  forbidPatterns?: string[]
  /** 期望她**会**包含的内容（只在确定性场景用；人格场景不要用它） */
  expectPatterns?: string[]
}

export interface EvalCase {
  id: string
  description: string
  /** 归属的指标组（报告里按它汇总） */
  metric: 'IDENTITY' | 'INTEGRITY' | 'SESSION' | 'DRIFT' | 'ANONYMOUS' | 'INTERVIEW' | 'SEED'
  /**
   * 是否需要真实模型。
   *
   * `false` = 离线可跑（echo 模式即可完成全部检查）。
   * `true`  = 必须真实模型（人格评测的意义就在这里）。
   */
  requiresModel: boolean
  turns: EvalTurn[]
  /**
   * 用例开始前的**前置状态**：先跑这些轮次，再跑 `turns`。
   * 用于制造"已经聊了很久"或"她刚说过某句话"的处境。
   */
  prelude?: EvalTurn[]
  checks: EvalCheck[]
  /**
   * 用例的自定义装置（可选）。
   *
   * 用它来做"重启 Runtime""切到新会话""由管理员改 Seed"这类
   * **不是一轮对话**的事情。装置在判定之前执行，产出额外观测。
   */
  fixture?: EvalFixture
  /**
   * 评测时使用的角色显示名覆盖（计划书第 66 节：匿名模式）。
   *
   * 匿名模式保留**完全相同的** Seed（人格 / 价值 / 风格 / 边界），
   * 只把显示名换成 `Character A`。用于验证：
   *   人格一致性来自 Seed，而不是模型"认识这个名字"。
   */
  displayNameOverride?: string
  tags: string[]
}

/**
 * 用例装置：在对话之外做的准备工作。
 *
 * 返回的额外观测会与对话观测**合并**成观测序列，
 * 因此判定器不需要区分"这轮是聊出来的还是装置造出来的"。
 */
export type EvalFixture = (context: EvalRuntimeFacade) => Promise<{
  observations?: EvalObservation[]
  attributes?: Record<string, unknown>
}>

// ---------------------------------------------------------------------------
// 运行环境面（评测能碰到的**全部**能力）
// ---------------------------------------------------------------------------

/**
 * 评测能够使用的运行时能力。
 *
 * 刻意做成一个小接口：评测**不应该**有能力任意写库。
 * 它只能"跟她说话"、"看账本"、"看 Seed"、"开新会话"。
 */
export interface EvalRuntimeFacade {
  /** 跟她说一句，返回这一轮的观测 */
  say(text: string): Promise<EvalObservation>
  /** 当前身份快照 */
  identity(): Promise<IdentitySnapshot>
  /** 当前会话 id */
  conversationId(): string
  /** 当前角色 id */
  characterId(): string
  /** 读账本（该角色全部会话） */
  ledger(limit?: number): Promise<ConversationEvent[]>
  /** 开一个新会话（同角色、同用户，**不同 ConversationId**） */
  openNewConversation(): Promise<string>
  /** 读 Seed 版本历史（最新的在前） */
  seedVersions(): Promise<{ seedVersion: number; seedHash: string }[]>
  /** 由管理员路径改 Seed（**只有装置能用**；普通聊天路径拿不到） */
  applySeedVersion(input: {
    seedVersion: number
    author: string
    reason: string
    mutate?: (draft: unknown) => unknown
  }): Promise<{ seedVersion: number; seedHash: string }>
  /** 模拟"重启 Runtime"：关掉当前运行环境并重新装配（同一份数据库） */
  restart(): Promise<void>
  /** 自由元数据 */
  attributes: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

export interface EvalSuite {
  id: string
  title: string
  /**
   * 对应计划书第 49 节建议目录里的哪一个 YAML。
   * Promptfoo 配置由 `scripts/build-m3-promptfoo-config.ts` 按它分组生成。
   */
  promptfooFile: string
  description: string
  cases: EvalCase[]
}

// ---------------------------------------------------------------------------
// 指标与阈值
// ---------------------------------------------------------------------------

/**
 * 正式指标（计划书第 114/115 节）。
 *
 * 这些名字**必须**稳定：它们会出现在报告、baseline 文件与 Gate 判定里。
 */
export const M3_METRICS = [
  'IdentityStabilityRate',
  'SeedMutationViolationCount',
  'CharacterIdContinuity',
  'SourceClassificationAccuracy',
  'AssistantToFactContaminationRate',
  'ConversationEventLossRate',
  'EventOrderingErrorRate',
  'PersonalityConsistency',
  'StyleAdherence',
  'DriftRate',
  'RecoveryRate',
  'AnonymousPersonaGap',
] as const

export type M3Metric = (typeof M3_METRICS)[number]

/**
 * 阈值。
 *
 * ⚠️ 计划书第 119 节：**第一轮只建立 Baseline，第二轮才冻结 Gate Threshold。**
 * 所以这个结构里的默认值是 `undefined`（= 不判定），
 * 由 `evals/m3/baseline.json` 提供实测值之后才生效。
 *
 * `hardZero` 里的指标不同：它们在任何情况下都必须是 0
 * （计划书第 115/116/117/118 节明确写了"目标 0"），因此无条件判定。
 */
export interface EvalThresholds {
  /** 必须恒为 0 的指标（deterministic pipeline 里面） */
  hardZero: M3Metric[]
  /** 需要 baseline 才能定的指标 */
  minimums: Partial<Record<M3Metric, number>>
  /** baseline 文件里的实测均值（仅作记录与对比） */
  baselineValues?: Partial<Record<M3Metric, number>>
  /** baseline 是怎么测出来的（模型 / 温度 / 次数） */
  baseline?: { model: string; temperature?: number; runs: number; measuredAt: string }
}

/**
 * M3 的**无条件**硬零指标。
 *
 * 这四条不是"目标"，是"任何一次不为零都属于 critical failure"：
 *   · SeedMutationViolationCount        —— 普通聊天改了 Seed
 *   · AssistantToFactContaminationRate  —— 她生成的内容被当成外部事实
 *   · ConversationEventLossRate         —— 处理了却没记进账本
 *   · EventOrderingErrorRate            —— 序号冲突或倒序
 */
export const M3_HARD_ZERO_METRICS: readonly M3Metric[] = [
  'SeedMutationViolationCount',
  'AssistantToFactContaminationRate',
  'ConversationEventLossRate',
  'EventOrderingErrorRate',
]

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export interface EvalCaseResult {
  caseId: string
  suiteId: string
  metric: EvalCase['metric']
  passed: boolean
  /** 确定性检查逐条结论 */
  deterministic: { id: string; pass: boolean; detail?: string; measured?: string }[]
  /** 需要模型评分的检查：离线模式下为 `skipped` */
  judged: { id: string; metric: string; status: 'scored' | 'skipped'; score?: number; detail?: string }[]
  observations: number
  durationMs: number
}

export interface EvalReport {
  generatedAt: string
  modelProfile: string
  /** 本报告是否走了真实模型（false = 只跑了确定性检查） */
  live: boolean
  results: EvalCaseResult[]
  /** 按指标汇总（deterministic 通过率 + judge 均分） */
  metrics: Record<string, { measured: number; passed: number; score?: number }>
  thresholds: EvalThresholds
  /** 触发的硬零指标（有值就是 critical failure） */
  hardZeroViolations: { metric: M3Metric; value: number; caseId: string; detail: string }[]
}
