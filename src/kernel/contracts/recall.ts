/**
 * Recall —— **M5 召回与上下文装配的稳定数据契约**（计划书 WP1）。
 *
 * ============================================================================
 *  这个文件只回答一个问题："M5 各步之间交换什么"
 * ============================================================================
 * 它**不含**：检索实现、排序算法、Prompt 组装、任何数据库/向量/网络依赖。
 * 计划书 WP1 的 Forbidden 写得很明确：
 *
 *     不得：实现 vector search / 实现 ranking / 修改 Prompt / 修改 Memory lifecycle
 *
 * 因此这里只有类型、枚举、稳定的序列化、以及**失败关闭的校验**。
 *
 * ---------------------------------------------------------------------------
 *  三处命名决定（计划书允许"名称服从现有代码风格"，但决定必须写下来）
 * ---------------------------------------------------------------------------
 * 1. **`RecallCandidate`，不是 `MemoryCandidate`。**
 *    计划书要求契约里有一个 `MemoryCandidate`，但**那个名字已经被 M4 占用**
 *    （`contracts/memory.ts` 的 `MemoryCandidate` = **抽取候选**：还没进库、
 *    没有 status/revision）。检索候选与抽取候选是**两个不同阶段的对象**：
 *    前者有 status/authority/revision（是从投影读出来的），后者刻意没有。
 *    重名会让 `import { MemoryCandidate }` 变成一个随时会拿错类型的陷阱 ——
 *    因此 M5 用 `RecallCandidate`，并在集合类型上保持可区分。
 *
 * 2. **`ORPHANED_EVIDENCE` 与 `DELETED` 是两个值。**
 *    用户 2026-09-17 的裁定：`DELETED` **不**用来表示"事件流为空 / 证据缺失"，
 *    那是**状态完整性损坏**（M5-PRE 修掉的那一类），不是生命周期删除。
 *    今天 M4 的 `MemoryStatus` 里**没有** `deleted`，因此 `DELETED` 是**保留位**。
 *
 * 3. **枚举值必须能被数据触发，否则必须被"锁住"。**
 *    这是本项目最贵的一类缺陷的形状：一个永远不生效的开关（D3）、一个永远
 *    查不到的键、一个"看起来能表达但没有任何生产者"的枚举值。
 *    因此每个 `RecallExclusionReason` 都在 `RECALL_EXCLUSION_REASON_FACTS` 里
 *    登记 **生产者是谁**；今天没有生产者的（`DELETED` / `NOT_ACTIVE`）标成
 *    `reachable: false` + `blocker`，并由 `assertExclusionReasonReachable()`
 *    在运行期拒绝，由契约测试锁住集合本身（加一个值必须同时决定它可不可达）。
 *
 * ---------------------------------------------------------------------------
 *  它**不是** prompt（M5 最容易被做坏的地方）
 * ---------------------------------------------------------------------------
 * `ContextBundle.selected[].dataText` 是**数据**（MEMORY_DATA），不是指令。
 * WP6 必须把它当数据块注入，且不得让它升级成 system/policy 文本。
 * 本文件还提供 `serializeContextBundleForTrace()`：**进 trace 的形态里没有正文**，
 * 只有 id / 指纹 / 计数 —— 计划书 WP7 的隐私纪律在这里就落成代码。
 */

import {
  KernelError,
  asCharacterId,
  asTraceId,
  type CharacterId,
  type MemoryId,
  type Timestamp,
  type TraceId,
} from './ids.ts'
import { entityRef, entityLabel, type EntityRef } from './entity.ts'
import { memoryDigest, stableMaterial } from './memory.ts'
import {
  MEMORY_TYPES,
  isRecallEligible,
  type EvidenceRef,
  type MemoryAuthority,
  type MemoryEpistemicStatus,
  type MemoryStatus,
  type MemoryType,
} from './memory.ts'
import type { ConversationEventId, ConversationId } from './ids.ts'
import type { SourceQualification } from './attribution.ts'
import type { ScopeContext } from './scope.ts'
/*
 * M5.5（ADR-045 D-14）：外部证据的**引用**只有一个定义，住在
 * `contracts/external-evidence.ts`；这里**只** re-export 同一个名字，
 * 因此既有 import（`from './recall.ts'`）一个都不用改。
 */
import {
  assertExternalEvidenceRefs,
  type ExternalEvidenceRef,
} from './external-evidence.ts'
export type { ExternalEvidenceRef }

export const RECALL_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// RecallExclusionReason
// ---------------------------------------------------------------------------

/**
 * 一条候选**为什么没有进上下文**。
 *
 * 计划书 WP1 要求至少能表达九种语义；这里在它们之外**多了一个**
 * `BUDGET_EXHAUSTED`（WP5 的预算裁剪需要它，否则"被预算挤掉"只能伪装成
 * `POLICY` —— 而两者的修法完全不同：一个改预算，一个改策略）。
 *
 * ⚠️ 顺序即"判定优先级"的**声明**，不是实现：WP2 按 owner → subject → target →
 *    status → integrity → policy 的顺序判，命中第一个就停。把两者放一起看，
 *    才能回答"这条记忆是被哪一道闸拦下的"。
 */
export type RecallExclusionReason =
  /** Memory Space 隔离：这条记忆的 owner 不是当前角色 */
  | 'WRONG_NAMESPACE'
  /** 跨用户隔离：这条记忆的 subjects 不含本次请求的 user */
  | 'WRONG_USER'
  /** 目标解析不足以确定（`not_found` / `ambiguous`）—— ADR-032 的纪律：不确定就不选 */
  | 'INVALID_TARGET'
  /** 显式遗忘（`status === 'retracted'`） */
  | 'FORGOTTEN'
  /** 已被更合适的条取代（`status === 'superseded'`） */
  | 'SUPERSEDED'
  /** 兜底：不可召回状态里既不属于 FORGOTTEN 也不属于 SUPERSEDED 的那一类（**今天没有生产者**，见 facts） */
  | 'NOT_ACTIVE'
  /** 状态完整性损坏：没有任何活证据 / 没有活事件流 / 悬空引用（M5-PRE 的探针产出） */
  | 'ORPHANED_EVIDENCE'
  /** 词面相关性为 0 或低于阈值（M4.1 的相关性闸语义） */
  | 'LOW_RELEVANCE'
  /** 同槽位同取值已经被选过（去重第三层的"重复不浪费预算"） */
  | 'DUPLICATE'
  /** 策略禁止：权威不足、种类不被允许、被显式 policy 排除 */
  | 'POLICY'
  /** 资格通过、排序通过，但预算装不下（WP5） */
  | 'BUDGET_EXHAUSTED'
  /** Presentation item budget; does not assert low relevance or insufficient tokens. */
  | 'INJECTION_LIMIT'
  /** **保留位**：将来真的出现 `status === 'deleted'` 时才启用（今天没有生产者） */
  | 'DELETED'

export const RECALL_EXCLUSION_REASONS: readonly RecallExclusionReason[] = [
  'WRONG_NAMESPACE',
  'WRONG_USER',
  'INVALID_TARGET',
  'FORGOTTEN',
  'SUPERSEDED',
  'NOT_ACTIVE',
  'ORPHANED_EVIDENCE',
  'LOW_RELEVANCE',
  'DUPLICATE',
  'POLICY',
  'BUDGET_EXHAUSTED',
  'INJECTION_LIMIT',
  'DELETED',
]

export function isRecallExclusionReason(value: unknown): value is RecallExclusionReason {
  return typeof value === 'string' && (RECALL_EXCLUSION_REASONS as readonly string[]).includes(value)
}

export interface RecallExclusionReasonFact {
  /** 今天有没有**真实数据**能触发它 */
  reachable: boolean
  /**
   * 它属于**哪一道闸**。
   *
   * 这是这个契约里最省事的一处设计：阶段由理由**唯一决定**，
   * 因此决策对象里不再需要第二个字段，也不可能出现
   * "它说是资格问题、理由却是预算"这种自相矛盾。
   *
   *   eligibility —— P0 安全闸（不通过就绝不进上下文）
   *   ranking     —— 通过资格后在排序/去重里被淘汰
   *   budget      —— 通过资格与排序，但装不下
   */
  stage: 'eligibility' | 'ranking' | 'budget'
  /** 谁产出它（`reachable === false` 时写"（尚无生产者）"） */
  producer: string
  /** 它回答什么问题 —— 一句话，供 trace 与文档共用 */
  semantics: string
  /** `reachable === false` 时必填：为什么今天触发不了，以及什么条件下才解锁 */
  blocker?: string
}

/**
 * 每个理由的"能不能被触发"的**唯一登记处**。
 *
 * 它的作用不是文档，而是**拒绝死值**：一个新枚举值如果不在这里登记，
 * 契约测试会红；登记成 `reachable: true` 却又没有生产者，WP2/WP4/WP5 的
 * 负控会红。这样"表达得了"与"真的会发生"就不会再被混为一谈。
 */
export const RECALL_EXCLUSION_REASON_FACTS: Readonly<
  Record<RecallExclusionReason, RecallExclusionReasonFact>
> = {
  WRONG_NAMESPACE: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2 · owner 闸（owner ≠ 当前角色）',
    semantics: '这条记忆不属于当前角色的 Memory Space',
  },
  WRONG_USER: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2 · subject 作用域（subjects 不含本次 user）',
    semantics: '这条记忆讲的是别人 —— 它是跨用户泄漏面的唯一拦截面',
  },
  INVALID_TARGET: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2 · Target Resolver 三态（not_found / ambiguous）',
    semantics: '用户那句话不足以确定指的是谁/什么，因此不选（ADR-032）',
  },
  FORGOTTEN: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2 · exclusionReasonForStatus(retracted)',
    semantics: '用户明确要求忘掉（历史留痕，但不再作为现状生效）',
  },
  SUPERSEDED: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2 · exclusionReasonForStatus(superseded)',
    semantics: '曾经为真，但已有更合适描述当下的新条',
  },
  NOT_ACTIVE: {
    reachable: false,
    stage: 'eligibility',
    producer: '（尚无生产者）',
    semantics: '不可召回状态的兜底分类',
    blocker:
      'M4 的四个状态里，不可召回的只有 retracted（→FORGOTTEN）与 superseded（→SUPERSEDED），' +
      '其余两个（active / disputed）按 isRecallEligible 可召回 —— 因此今天没有任何数据会落到这里。' +
      '解锁条件：MemoryStatus 新增一个"不可召回且不属于上述两类"的状态。' +
      '在那之前 WP2 的映射保持**穷尽 switch（无 default）**，让新增状态先在编译期失败。',
  },
  ORPHANED_EVIDENCE: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2 · memoryIntegrityProblems()（M5-PRE 的探针）',
    semantics: '这条记忆的证据或事件流已不存在 —— 状态完整性损坏，不是生命周期删除',
  },
  LOW_RELEVANCE: {
    reachable: true,
    stage: 'ranking',
    producer: 'WP4 · 词面相关性为 0 / 低于阈值',
    semantics: '没有任何当前机制能把它与这句话联系起来',
  },
  DUPLICATE: {
    reachable: true,
    stage: 'ranking',
    producer: 'WP4 · 槽位/内容去重（同槽位同取值只留一条）',
    semantics: '同一件事实已经有一条进上下文了',
  },
  POLICY: {
    reachable: true,
    stage: 'eligibility',
    producer: 'WP2/WP4 · 策略判定（权威不足、种类不允许等）',
    semantics: '资格与相关性都没问题，但当前策略不允许',
  },
  BUDGET_EXHAUSTED: {
    reachable: true,
    stage: 'budget',
    producer: 'WP5 · Context Selector（预算装不下）',
    semantics: '它没被淘汰，只是没地方放了 —— 修法是改预算，不是改策略',
  },
  INJECTION_LIMIT: {
    reachable: true,
    stage: 'budget',
    producer: 'Context Selector · 每轮记忆注入条数上限',
    semantics: '资格与排序通过，但本轮已达到注入条数上限；不代表不相关或 token 不足',
  },
  DELETED: {
    reachable: false,
    stage: 'eligibility',
    producer: '（尚无生产者）',
    semantics: '生命周期意义上的删除（保留位）',
    blocker:
      'M4 没有 status="deleted"，写入路径也造不出来（用户 2026-09-17 裁定）。' +
      '证据缺失一律走 ORPHANED_EVIDENCE。' +
      '解锁条件：MemoryStatus 真的新增 deleted，并同时决定它的遗忘/删除语义与迁移。',
  },
}

/** 今天**没有真实数据能触发**的理由（保留位） */
export const RESERVED_EXCLUSION_REASONS: readonly RecallExclusionReason[] =
  RECALL_EXCLUSION_REASONS.filter((reason) => !RECALL_EXCLUSION_REASON_FACTS[reason].reachable)

/**
 * 运行期拒绝"用保留位当真实理由"。
 *
 * WP2/WP4/WP5 在构造 `RecallDecision.reason` 前调用它 —— 于是
 * "把证据缺失写成 DELETED"这类语义混淆**在运行期就写不出来**，
 * 而不是靠 code review 记得。
 */
export function assertExclusionReasonReachable(reason: RecallExclusionReason): void {
  const fact = RECALL_EXCLUSION_REASON_FACTS[reason]
  if (fact.reachable) return
  throw new KernelError(
    'validation_error',
    'exclusion_reason_not_reachable',
    `${reason} 今天没有生产者：${fact.blocker ?? '（未写明原因）'}`,
    { reason }
  )
}

export function describeExclusionReason(reason: RecallExclusionReason): string {
  const fact = RECALL_EXCLUSION_REASON_FACTS[reason]
  return `${reason}：${fact.semantics}（生产者：${fact.producer}）`
}

/**
 * M6.1 WP4 / ADR-055 `D-55e`：排除理由 → **记录状态原因** 的标签映射。
 *
 * ⚠️ 它是**纯标签映射，不是判定**：不决定谁能被召回（那是 `eligibility.ts`），
 *    只决定"这一条理由在状态行里怎么说"。
 * ⚠️ 为什么住在这里（而不是 `kernel/app/recall/record-status.ts`）：
 *    `m5:verify` 的静态锁（AT2.1 不散落）要求**排除理由的字面量**只出现在
 *    契约与纯召回层 —— 判定层若出现这些字符串，就是"第二套资格判定"的开端。
 *    把映射放在契约里，消费方（`app/recall/`）就一个理由字面量都不需要写。
 * ⚠️ 未映射的理由（`WRONG_USER` / `WRONG_NAMESPACE` / `INVALID_TARGET` /
 *    `POLICY` / `DUPLICATE` / `NOT_ACTIVE` / `DELETED`）返回 `undefined`：
 *    它们不构成用户可见的"记录状态"（例如跨用户隔离就不是"她没有记录"）。
 */
export function recordStatusReasonOfExclusion(
  reason: RecallExclusionReason
): 'no_relevant' | 'dropped_by_budget' | 'ineligible:forgotten' | 'ineligible:superseded' | 'ineligible:orphaned' | undefined {
  switch (reason) {
    case 'LOW_RELEVANCE':
      return 'no_relevant'
    case 'BUDGET_EXHAUSTED':
      return 'dropped_by_budget'
    case 'FORGOTTEN':
      return 'ineligible:forgotten'
    case 'SUPERSEDED':
      return 'ineligible:superseded'
    case 'ORPHANED_EVIDENCE':
      return 'ineligible:orphaned'
    default:
      return undefined
  }
}

/**
 * `MemoryStatus` → 排除理由。
 *
 * ⚠️ 这是 M5 与 M4 的**唯一**接缝，因此它必须**复用** `isRecallEligible()`
 *    而不是自己写一遍"哪些状态可召回" —— 两处定义迟早漂移，
 *    而漂移的表现是"她想起了不该想起的事"。
 *
 * ⚠️ 刻意**穷尽所有 status 且没有 default 分支**：M4 将来新增一个状态时，
 *    这里会**编译失败**，而不是静默落进一个兜底。那正是
 *    `NOT_ACTIVE` 今天被标成"无生产者"的原因。
 */
export function exclusionReasonForStatus(
  status: MemoryStatus
): RecallExclusionReason | undefined {
  if (isRecallEligible(status)) return undefined
  switch (status) {
    case 'retracted':
      return 'FORGOTTEN'
    case 'superseded':
      return 'SUPERSEDED'
    case 'active':
    case 'disputed':
      // isRecallEligible 已经把它们放行了，走到这里说明两个函数不再自洽
      throw new KernelError(
        'validation_error',
        'recall_eligibility_mismatch',
        `exclusionReasonForStatus 与 isRecallEligible 不一致：${status} 被判为可召回却也有排除理由`
      )
  }
}

// ---------------------------------------------------------------------------
// Intent / Channel / TimeScope
// ---------------------------------------------------------------------------

/**
 * 这一次召回**想回答哪一类问题**。
 *
 * 它是 WP2 资格判据的输入之一：问"现在"时 superseded 必须排除，
 * 问"以前"时它反而是**应该**被想起来的（计划书 WP4 的 Historical Query）。
 * 没有这个字段，那条要求就只能写死在代码里。
 */
export type RecallIntent =
  | 'current_fact'
  | 'historical'
  | 'identity'
  | 'experience'
  | 'unspecified'

export const RECALL_INTENTS: readonly RecallIntent[] = [
  'current_fact',
  'historical',
  'identity',
  'experience',
  'unspecified',
]

export function isRecallIntent(value: unknown): value is RecallIntent {
  return typeof value === 'string' && (RECALL_INTENTS as readonly string[]).includes(value)
}

/**
 * 一个候选是怎么被找到的（检索通道）。
 *
 * 它进 trace：回答"这条为什么会被送来筛"是排查召回质量的第一步 ——
 * "没召回"与"召回了但被筛掉"的修法完全不同。
 */
/**
 * M9.5 WP6（2026-09-28 · ADR-074 的 D25/D26）：`semantic` 成为**一等通道**。
 *
 * ⚠️ 这是**纯追加**：既有 5 个成员的含义与顺序一字未改（`off` 模式必须逐字节等价，
 *    D25 第 ③ 条）。但它的 `produced` 仍是 **false** —— 因为 WP6 的实现尚未接线，
 *    而登记表的职责恰恰是"如实回答今天有没有生产者"。缺什么写在 `blocker` 里。
 */
export type RecallChannel =
  | 'explicit_id'
  | 'canonical_key'
  | 'subject'
  | 'recency'
  | 'lexical'
  | 'semantic'

export const RECALL_CHANNELS: readonly RecallChannel[] = [
  'explicit_id',
  'canonical_key',
  'subject',
  'recency',
  'lexical',
  'semantic',
]

export function isRecallChannel(value: unknown): value is RecallChannel {
  return typeof value === 'string' && (RECALL_CHANNELS as readonly string[]).includes(value)
}

export interface RecallChannelFact {
  /** 今天有没有真实代码会产出这条通道 */
  produced: boolean
  /** 谁产出它 */
  producer: string
  semantics: string
  /** `produced === false` 时必填 */
  blocker?: string
}

/**
 * 检索通道的"有没有生产者"登记表（WP3 的 AT3.2 落点）。
 *
 * 计划书要求回答："现有项目能够**可靠**提供哪些检索维度"。
 * 答案不允许靠感觉写：每一条通道要么有一个真实的生产者，要么写明
 * 为什么今天产不出来。`semantic`（向量/嵌入）**不在**这张表里 ——
 * 它是"能力边界"而不是通道（见 `MemoryRetrievalCapabilities`）。
 */
export const RECALL_CHANNEL_FACTS: Readonly<Record<RecallChannel, RecallChannelFact>> = {
  explicit_id: {
    produced: false,
    producer: '（尚无生产者）',
    semantics: '调用方直接给出 memory id',
    blocker:
      'RecallRequest 今天不带 memory id —— 显式路径（"忘掉 mem:xxx"）走的是 M4 的显式服务，' +
      '不经过召回。未来若要让"她说出 id"触发召回，需要先决定"谁能构造带 id 的请求"。',
  },
  canonical_key: {
    produced: false,
    producer: '（尚无生产者）',
    semantics: '按事实槽位键精确召回',
    blocker:
      'RecallTarget.resolved 只带 subject 与 via，不携带 canonical key；' +
      '要产出这条通道，需要让目标解析把 key 一起交出来（那会改 M4 的解析器契约）。',
  },
  subject: {
    produced: true,
    producer: 'WP3 · memory-retrieval-store（listBySubject）',
    semantics: '这个用户相关的记忆（宽召回的主通道）',
  },
  recency: {
    produced: true,
    producer: 'WP3 · memory-retrieval-store（list 按 recordedAt 降序）',
    semantics: '最近记住的（没有词面命中时的兜底面）',
  },
  lexical: {
    produced: true,
    producer: 'WP3 · memory-retrieval-store（M4.1 的 lexicalOverlapHits）',
    semantics: '这句话的片段出现在记忆里（含登记表的中文说明）',
  },
  semantic: {
    produced: false,
    producer: '（WP6 未接线；见 blocker）',
    semantics: '语义相近（向量检索）—— 与词面命中**同权参与候选选择**（D25 第 ④ 条）',
    blocker:
      '派生索引与混合召回尚未接线（WP6）。⚠️ D25 第 ④ 条明令：**只**把本通道标成 available、' +
      '而分数不参与候选选择 ⇒ 视为**未实现**。接线时必须同时满足三件事：' +
      '① 真实语义分数进入排序（不是只有 capability 标志）；② `off` 模式下本通道**不出现**；' +
      '③ 相关性判定不得使用绝对余弦阈值（D26，见 `src/kernel/recall/semantic-signal.ts`）。',
  },
}

export const RESERVED_RECALL_CHANNELS: readonly RecallChannel[] = RECALL_CHANNELS.filter(
  (channel) => !RECALL_CHANNEL_FACTS[channel].produced
)

// ---------------------------------------------------------------------------
// M9.5 WP6（ADR-074 的 D25）—— 检索策略版本
// ---------------------------------------------------------------------------

/**
 * 检索策略版本。**兼容靠版本化，不靠就地改语义**（D25 第 ③ 条）。
 *
 * ```text
 * `lexical-recency@1` = **现状**：候选按新近度降序、再 `slice(0, limit)`。
 *                        `off` 模式**必须**逐字节等价于此。
 * `hybrid-relevance@1` = D25 的新策略：**先按相关性排序、再截断**。
 * ```
 *
 * ⚠️ 它放在**契约层**（这里）而不是 `kernel/app/**`：`MemoryRetrievalQuery` 要用它，
 *    而 `kernel/recall/**` 不许反向依赖 `kernel/app/**`（依赖方向单向）。
 */
export type RetrievalPolicyVersion = 'lexical-recency@1' | 'hybrid-relevance@1'

export const RETRIEVAL_POLICY_VERSIONS: readonly RetrievalPolicyVersion[] = [
  'lexical-recency@1',
  'hybrid-relevance@1',
]

/** 缺省 = 现状 ⇒ **不传这个字段的行为一字不变**（D25 第 ③ 条）。 */
export const DEFAULT_RETRIEVAL_POLICY_VERSION: RetrievalPolicyVersion = 'lexical-recency@1'

/** 未知值**必须**被拒（不得默认 `on`）。 */
export function isRetrievalPolicyVersion(value: unknown): value is RetrievalPolicyVersion {
  return typeof value === 'string' && (RETRIEVAL_POLICY_VERSIONS as readonly string[]).includes(value)
}

/** 本策略版本下，语义通道**是否参与**。 */
export function semanticParticipates(version: RetrievalPolicyVersion): boolean {
  return version === 'hybrid-relevance@1'
}

/**
 * **M9.5 / WP8（计划 §12 WP8 的权威要求）**：语义召回的三种模式。
 *
 * ```text
 * `off`    **不算、也不同**：探针一次都不被调用（S46：语义调用数 0）；
 *          候选/资格/选中与接入前**语义等价**。
 * `shadow` **算，但不进上下文**：真的算分并记下对照读数，
 *          而**实际使用的排序仍是旧路径**（S47：真实 prompt/回复输入不变）。
 *          ⚠️ 计划书逐字：「shadow 会使用额外计算、可能维护派生索引，
 *             **不能称"完全零副作用"**」—— 所以它只承诺"输出不变"，不承诺"零成本"。
 * `on`     算并用：语义分数参与候选排序（D25 的 hybrid-relevance）。
 * ```
 *
 * ⚠️ 缺省**由策略版本推导**（不传 = 旧行为）：`lexical-recency@1` ⇒ `off`；
 *    `hybrid-relevance@1` ⇒ `on`。这样"不传 mode"的调用方行为一字不变。
 */
export type SemanticMode = 'off' | 'shadow' | 'on'

export const SEMANTIC_MODES: readonly SemanticMode[] = ['off', 'shadow', 'on']

/** 未知值**必须**被拒（不得默认 `on`，也不得静默回落 `off`）。 */
export function isSemanticMode(value: unknown): value is SemanticMode {
  return typeof value === 'string' && (SEMANTIC_MODES as readonly string[]).includes(value)
}

/** 由策略版本推导缺省模式（`off`/`on` 两态；`shadow` 只能被**显式**要求）。 */
export function defaultSemanticModeFor(version: RetrievalPolicyVersion): SemanticMode {
  return version === 'hybrid-relevance@1' ? 'on' : 'off'
}

/**
 * **为什么这次拿不到语义分数**（每种原因必须**具名**，不许合成一个笼统的"不可用"）。
 *
 * ⚠️ 定义在契约层：语义探针端口（`kernel/recall/ports.ts`）要用它，
 *    而 `kernel/recall/**` 不许反向依赖 `kernel/app/**`（依赖方向单向）。
 */
export type SemanticUnavailableReason =
  | 'not_indexed'
  | 'model_missing'
  | 'dimension_mismatch'
  | 'timeout'
  | 'generation_mismatch'
  /**
   * ⚠️ 这一条是 **R3 / D26-④ 的要害**：能力标志说可用、却**没有真实分数**。
   * 必须判成**不可用**，而不是"分数等于 0" —— 否则
   * 「永不参与、却在 trace 里看起来已启用」的**伪启用**就测不出来了。
   */
  | 'missing_score'
  | 'non_finite_score'

export const SEMANTIC_UNAVAILABLE_REASONS: readonly SemanticUnavailableReason[] = [
  'not_indexed',
  'model_missing',
  'dimension_mismatch',
  'timeout',
  'generation_mismatch',
  'missing_score',
  'non_finite_score',
]

export type RecallTimeKind = 'any' | 'recent' | 'at' | 'range'

export interface RecallTimeScope {
  kind: RecallTimeKind
  from?: Timestamp
  to?: Timestamp
}

// ---------------------------------------------------------------------------
// RecallTarget
// ---------------------------------------------------------------------------

/**
 * 目标解析的结果 —— **与 M4 的 `target-resolver` 三态同形**。
 *
 * 复用形状而不是另发明一套：M4.1 的 D1 缺陷（"目标不明时随便挑一条"）就是
 * 目标解析与调用方之间语义不一致造成的。M5 直接把那个三态搬进来，
 * `ambiguous` 与 `not_found` 在类型上就是**不能当 resolved 用**。
 *
 * ⚠️ `ambiguous` 带的是**候选数**而不是候选本身：M5 不需要知道"是哪两条"，
 *    它只需要知道"判不出来 → 不选"。把候选塞进来会诱导实现去"挑一个更像的"。
 */
export type RecallTarget =
  | { status: 'resolved'; subject: EntityRef; via: string; confidence: 'exact' | 'strong' }
  | { status: 'ambiguous'; candidates: number; via: string }
  | { status: 'not_found'; via: string }
  | { status: 'none' }

export const RECALL_TARGET_NONE: RecallTarget = { status: 'none' }

// ---------------------------------------------------------------------------
// RecallRequest
// ---------------------------------------------------------------------------

export interface RecallQuery {
  /** 用户那句话（或它的等价文本）。召回的必要输入 */
  text: string
  /** 这句话从哪来：真实用户消息 / 合成轮次（`--dump-prompt` 之类） */
  source: 'user_message' | 'synthetic'
  /** 触发这一轮的对话事件（有则进 trace，让"为什么想起这些"可回查） */
  eventId?: ConversationEventId
}

export interface RecallSessionScope {
  conversationId?: ConversationId
  /** transport 侧会话（CLI/DM/未来平台）。可替换，不是身份 */
  sessionRef?: string
}

/**
 * 长期记忆的预算。
 *
 * ⚠️ 它是**记忆那一块**的预算，不是整个上下文的：整轮预算由 ContextCompiler
 *    的 `tokenBudget` 管。两者分开是因为"她想起了太多"与"上下文整体太长"
 *    是两个不同的问题，混用会让预算裁剪无法归因。
 */
export interface RecallBudget {
  memoryTokens: number
  /** 为未来 external evidence 预留（M5 恒为 0，M5.5 才会用） */
  reservedTokens?: number
}

export const RECALL_LIMITS = {
  /** 宽召回上限的硬边界：没有上界的召回等于没有召回 */
  minCandidateLimit: 1,
  maxCandidateLimit: 200,
  defaultCandidateLimit: 50,
  /** 记忆预算的硬边界：0 等于"不召回"，过大等于"没有预算" */
  minMemoryTokens: 1,
  maxMemoryTokens: 8192,
  defaultMemoryTokens: 800,
} as const

export interface RecallRequest {
  /** 贯穿一轮的 traceId —— WP7 用它把召回、上下文、模型调用串起来 */
  traceId: TraceId
  /** Memory Space（namespace）：必须是角色 */
  characterId: CharacterId
  /** 本次请求归属的用户（subject 作用域） */
  user: EntityRef
  session: RecallSessionScope
  /**
   * **U1 / `ADR-138`（`G18`）：本轮的作用域三元组**（谁 · 什么用途 · 哪个空间）——**可选**。
   *
   * ```text
   * 它存在的理由：召回适配器在**装配时**构造一次（`main.ts`），
   * 而"这一轮是谁在问、在哪个空间问"是**每一轮**的事实 ⇒ 必须随请求走到检索层。
   * 缺省 ⇒ 行为一字不变（授权接线未贯通身份之前，装配层不注入授权器）。
   * ⚠️ 它**由服务端装配层**给出（与 `user` 同一条信任边界），**不许**来自请求载荷。
   * ```
   */
  scope?: ScopeContext
  query: RecallQuery
  intent: RecallIntent
  target: RecallTarget
  timeScope: RecallTimeScope
  /** 只召回这些种类（缺省 = 全部四种）。空数组**不是**"全部"，是错误 */
  memoryKinds?: readonly MemoryType[]
  /** 宽召回上限（有界） */
  candidateLimit: number
  /** 记忆预算 */
  contextBudget: RecallBudget
  /**
   * **M9.5 / WP6（D25）**：检索策略版本。
   *
   * 缺省 = `lexical-recency@1`（现状）⇒ **不传它的行为一字不变**。
   * 传 `hybrid-relevance@1` ⇒ 候选先按相关性排序、再截断。
   */
  retrievalPolicyVersion?: RetrievalPolicyVersion
  /**
   * **M9.5 / WP8**：语义召回模式（`off` / `shadow` / `on`）。
   *
   * 不传 ⇒ 由 `retrievalPolicyVersion` 推导（旧行为一字不变）。
   * `shadow` 必须**显式**要求 —— 它是观察用状态，不该被任何缺省路径撞上。
   */
  semanticMode?: SemanticMode
}

export interface NewRecallRequest {
  traceId: string
  characterId: string
  user: EntityRef
  query: { text: string; source?: RecallQuery['source']; eventId?: ConversationEventId }
  intent?: RecallIntent
  target?: RecallTarget
  timeScope?: RecallTimeScope
  memoryKinds?: readonly MemoryType[]
  candidateLimit?: number
  contextBudget?: Partial<RecallBudget>
  session?: RecallSessionScope
  /**
   * **U1 / `ADR-138`**：本轮的作用域三元组（**程序化构造**用；见 `RecallRequest.scope` 的说明）。
   *
   * ⚠️ 它**只**能由装配层在**进程内**给出：`parseRecallRequest`（唯一接受外部形状的入口）
   *    **拒绝**载荷里的 `scope`（`recall_scope_from_payload`）——
   *    否则任何能喂进请求的地方都能自称"我是原主人"。
   */
  scope?: ScopeContext
  /** **M9.5 / WP6（D25）**：缺省 = 现状；未知值**拒绝**（不静默回落） */
  retrievalPolicyVersion?: string
  /** **M9.5 / WP8**：`off` / `shadow` / `on`；未知值**拒绝**；缺省由策略版本推导 */
  semanticMode?: string
}

function assertPositiveInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new KernelError(
      'validation_error',
      'recall_bad_number',
      `${name} 必须是 [${min}, ${max}] 内的整数，收到 ${String(value)}。` +
        '没有上界的候选数/预算等于没有约束 —— 它会让"召回质量"这件事无法被测量'
    )
  }
  return value
}

/** 作用域用途闭集（与 `contracts/scope.ts` 的 `Purpose` 同源；这里只用于**校验**） */
const RECALL_SCOPE_PURPOSES: readonly string[] = ['external_query', 'internal_cognition', 'admin_operation']

/**
 * 构造召回请求（**失败关闭**）。
 *
 * 它做四件事，每件都对应一个真实会出的错：
 *   1. `user` 必须是 user 实体（与 `ownerCharacterId()` 拒绝把 user 当 owner 同一条理由：
 *      来源伪造成本极高）
 *   2. `query.text` 非空 —— 没有问题的召回不是召回
 *   3. `candidateLimit` / `memoryTokens` 有界
 *   4. `memoryKinds` 若给出，必须非空且都已登记
 *   5. （U1 / `ADR-138`）`scope` 若给出，**形状必须成立**（principal / purpose / room id 都要能判）
 */
export function createRecallRequest(input: NewRecallRequest): RecallRequest {
  if (typeof input.traceId !== 'string' || input.traceId.trim() === '') {
    throw new KernelError('validation_error', 'recall_without_trace', 'RecallRequest 必须有 traceId')
  }
  const traceId = asTraceId(input.traceId)
  const characterId = asCharacterId(String(input.characterId))

  if (input.user.kind !== 'user') {
    throw new KernelError(
      'validation_error',
      'recall_user_not_user',
      `RecallRequest.user 必须是 user 实体，收到 ${entityLabel(input.user)}。` +
        '把角色或地点当成"请求归属的用户"，会让 subject 作用域（跨用户隔离的唯一拦截面）失去意义',
      { user: entityLabel(input.user) }
    )
  }

  const text = input.query.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw new KernelError(
      'validation_error',
      'recall_without_query',
      'RecallRequest.query.text 不能为空：没有"想找什么"的召回不是召回'
    )
  }

  const candidateLimit = assertPositiveInt(
    input.candidateLimit ?? RECALL_LIMITS.defaultCandidateLimit,
    'candidateLimit',
    RECALL_LIMITS.minCandidateLimit,
    RECALL_LIMITS.maxCandidateLimit
  )

  const memoryTokens = assertPositiveInt(
    input.contextBudget?.memoryTokens ?? RECALL_LIMITS.defaultMemoryTokens,
    'contextBudget.memoryTokens',
    RECALL_LIMITS.minMemoryTokens,
    RECALL_LIMITS.maxMemoryTokens
  )
  const reservedTokens = input.contextBudget?.reservedTokens ?? 0
  if (typeof reservedTokens !== 'number' || !Number.isSafeInteger(reservedTokens) || reservedTokens < 0) {
    throw new KernelError(
      'validation_error',
      'recall_bad_number',
      `contextBudget.reservedTokens 必须是非负整数，收到 ${String(reservedTokens)}`
    )
  }

  let memoryKinds: readonly MemoryType[] | undefined
  if (input.memoryKinds !== undefined) {
    if (!Array.isArray(input.memoryKinds) || input.memoryKinds.length === 0) {
      throw new KernelError(
        'validation_error',
        'recall_empty_memory_kinds',
        'memoryKinds 给了就必须非空：空数组不是"全部"，而是一个自相矛盾的请求'
      )
    }
    for (const kind of input.memoryKinds) {
      if (!(MEMORY_TYPES as readonly string[]).includes(kind)) {
        throw new KernelError(
          'validation_error',
          'recall_unknown_memory_kind',
          `未登记的 MemoryType：${String(kind)}`
        )
      }
    }
    memoryKinds = [...input.memoryKinds]
  }

  const timeScope: RecallTimeScope = input.timeScope ?? { kind: 'any' }
  assertTimeScope(timeScope)

  /*
   * U1 / ADR-138：作用域三元组**失败关闭**校验。
   * 只是"看起来像"一个 scope 不算 —— 空间叫不出名字、用途没登记，一律拒绝。
   * （它是授权输入：错的 scope 比没有 scope 更危险，因为读面会以为"已经授权过了"。）
   */
  let scope: ScopeContext | undefined
  if (input.scope !== undefined) {
    const candidate = input.scope
    /* 先取成 `string` 再判：直接反复比较 `kind` 会被 TS 收窄成 `never`（本仓库踩过多次） */
    const principalKind: string = candidate.principal.kind
    if (principalKind !== 'user' && principalKind !== 'owner' && principalKind !== 'system') {
      throw new KernelError('validation_error', 'recall_scope_bad_principal', `未登记的 principal.kind：${principalKind}`)
    }
    if (!RECALL_SCOPE_PURPOSES.includes(candidate.purpose)) {
      throw new KernelError('validation_error', 'recall_scope_bad_purpose', `未登记的 purpose：${String(candidate.purpose)}`)
    }
    const roomKind: string = candidate.room.kind
    if (roomKind !== 'private' && roomKind !== 'group') {
      throw new KernelError('validation_error', 'recall_scope_bad_room', `未登记的 room.kind：${roomKind}`)
    }
    const roomId = candidate.room.kind === 'private' ? candidate.room.userId : candidate.room.groupId
    if (typeof roomId !== 'string' || roomId.trim() === '') {
      throw new KernelError('validation_error', 'recall_scope_bad_room_id', '作用域的空间 id 不能为空（不给叫不出名字的空间授权）')
    }
    scope = candidate
  }

  return {
    traceId,
    characterId,
    user: entityRef(input.user.kind, String(input.user.id)),
    session: input.session ?? {},
    query: {
      text,
      source: input.query.source ?? 'user_message',
      ...(input.query.eventId !== undefined ? { eventId: input.query.eventId } : {}),
    },
    intent: input.intent ?? 'unspecified',
    target: input.target ?? RECALL_TARGET_NONE,
    timeScope,
    ...(memoryKinds !== undefined ? { memoryKinds } : {}),
    /* U1 / ADR-138：作用域三元组（**只由装配层给**；缺省 ⇒ 字段不出现 ⇒ 行为一字不变） */
    ...(scope !== undefined ? { scope } : {}),
    candidateLimit,
    /*
     * M9.5 / WP6（D25）：未知策略名**拒绝**（不静默回落、不默认 on）。
     * 不传 ⇒ 字段**不出现** ⇒ 下游走缺省（现状），行为一字不变。
     */
    ...(input.retrievalPolicyVersion !== undefined
      ? (() => {
          if (!isRetrievalPolicyVersion(input.retrievalPolicyVersion)) {
            throw new KernelError(
              'validation_error',
              'bad_retrieval_policy_version',
              `未知检索策略版本：${JSON.stringify(input.retrievalPolicyVersion)}；` +
                `合法值 ${RETRIEVAL_POLICY_VERSIONS.join(' / ')}（不得默认 on）`
            )
          }
          return { retrievalPolicyVersion: input.retrievalPolicyVersion }
        })()
      : {}),
    /*
     * M9.5 / WP8：模式同理 —— 未知值**拒绝**（不默认 on、也不静默回落 off）。
     * 不传 ⇒ 字段不出现 ⇒ 下游按策略版本推导缺省。
     */
    ...(input.semanticMode !== undefined
      ? (() => {
          if (!isSemanticMode(input.semanticMode)) {
            throw new KernelError(
              'validation_error',
              'bad_semantic_mode',
              `未知语义模式：${JSON.stringify(input.semanticMode)}；合法值 ${SEMANTIC_MODES.join(' / ')}（不得默认 on）`
            )
          }
          return { semanticMode: input.semanticMode }
        })()
      : {}),
    contextBudget: {
      memoryTokens,
      ...(reservedTokens > 0 ? { reservedTokens } : {}),
    },
  }
}

function assertTimeScope(scope: RecallTimeScope): void {
  if (!['any', 'recent', 'at', 'range'].includes(scope.kind)) {
    throw new KernelError(
      'validation_error',
      'recall_bad_time_scope',
      `timeScope.kind 未登记：${String(scope.kind)}`
    )
  }
  for (const key of ['from', 'to'] as const) {
    const value = scope[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new KernelError(
        'validation_error',
        'recall_bad_time_scope',
        `timeScope.${key} 必须是有限数字，收到 ${String(value)}`
      )
    }
  }
  if (scope.kind === 'range' && scope.from !== undefined && scope.to !== undefined && scope.from > scope.to) {
    throw new KernelError(
      'validation_error',
      'recall_bad_time_scope',
      `timeScope 的 from(${scope.from}) 晚于 to(${scope.to}) —— 一个空区间不是"没有约束"`
    )
  }
}

// ---------------------------------------------------------------------------
// 稳定序列化 / 反序列化（AT1.2）
// ---------------------------------------------------------------------------

/**
 * 规范化材料：**键排序**后输出。
 *
 * 不直接用 `JSON.stringify`：它按插入顺序输出键，于是"同一个请求的两份等价
 * 表示"会算出两个不同的字符串 —— 而 WP7 要用它做 trace 里的稳定指纹，
 * WP5 要凭它证明"同样的输入给同样的选择"。
 *
 * `undefined` 一律**省略**（与 JSON 一致），从而 `serialize → parse` 是幂等的。
 */
function canonicalMaterial(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(canonicalMaterial)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) continue
      out[key] = canonicalMaterial(item)
    }
    return out
  }
  return value
}

/**
 * 记录用的材料：**去掉 `scope`**。
 *
 * ```text
 * U1 / ADR-138：作用域三元组是**每一轮**的授权事实，不是请求的"内容"。
 *   ① 它若进记录/trace/摘要 ⇒ 一轮的作用域会被**固化**进另一轮（回放时用的是旧身份）
 *   ② `parseRecallRequest` 拒绝载荷里的 `scope`（提权防线）
 *      ⇒ 若序列化写它、反序列化丢它，往返就**不幂等** —— 那类"看起来存了其实没存"
 *         正是本仓库最贵的一类缺陷。
 * ⇒ 结论：序列化与摘要在**同一处**把它排除，往返因此仍然一致（且旧摘逐一字不变）。
 * ```
 */
function recallRecordMaterial(request: RecallRequest): unknown {
  const { scope: _scope, ...rest } = request
  void _scope
  return rest
}

/** 请求的规范 JSON 文本（进 trace / 进证据文件的形态） */
export function serializeRecallRequest(request: RecallRequest): string {
  return JSON.stringify(canonicalMaterial(recallRecordMaterial(request)))
}

/** 请求的稳定摘要（FNV-1a，见 `memoryDigest` 的局限说明：**不是**安全哈希） */
export function recallRequestDigest(request: RecallRequest): string {
  return memoryDigest(stableMaterial(canonicalMaterial(recallRecordMaterial(request))))
}

/**
 * 反序列化 + 校验（**唯一**接受外部形状的入口）。
 *
 * 它刻意不接受"看起来差不多"的对象：缺字段、类型错、越界都抛
 * `KernelError('validation_error', ...)`，并且错误码是可断言的字符串。
 * 这一层失败关闭的价值在于：WP3 的适配器、WP7 的证据回放、未来的
 * M5.5 外部证据都从同一个入口进来。
 */
export function parseRecallRequest(value: unknown): RecallRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelError('validation_error', 'recall_request_not_object', 'RecallRequest 必须是对象')
  }
  const raw = value as Record<string, unknown>

  /*
   * U1 / ADR-138：**载荷不许自带作用域**。
   *
   * `scope` 是授权输入（"我是谁 · 在哪个空间"）。本函数是**唯一**接受外部形状的入口，
   * 而 WP3 适配器 / WP7 证据回放 / 未来的外部证据都从这里进来 ——
   * 一旦接受载荷里的 `scope`，任何能喂进请求的地方都能自称原主人（**提权**）。
   * ⇒ 显式拒绝（不是"忽略"）：静默忽略会让攻击者以为成功、而我们以为没发生。
   */
  if (Object.hasOwn(raw, 'scope')) {
    throw new KernelError(
      'validation_error',
      'recall_scope_from_payload',
      '载荷不得自带 scope：作用域三元组只能由装配层在进程内给出'
    )
  }

  const query = raw.query
  if (typeof query !== 'object' || query === null) {
    throw new KernelError('validation_error', 'recall_request_missing_query', 'RecallRequest.query 缺失')
  }
  const queryRecord = query as Record<string, unknown>
  if (queryRecord.source !== 'user_message' && queryRecord.source !== 'synthetic') {
    throw new KernelError(
      'validation_error',
      'recall_request_bad_query_source',
      `query.source 必须是 user_message / synthetic，收到 ${String(queryRecord.source)}`
    )
  }

  const user = raw.user
  if (typeof user !== 'object' || user === null) {
    throw new KernelError('validation_error', 'recall_request_missing_user', 'RecallRequest.user 缺失')
  }
  const userRecord = user as Record<string, unknown>
  if (userRecord.kind !== 'user' || typeof userRecord.id !== 'string' || userRecord.id.trim() === '') {
    throw new KernelError(
      'validation_error',
      'recall_user_not_user',
      `RecallRequest.user 必须是 { kind: 'user', id }，收到 ${JSON.stringify(user)}`
    )
  }

  const target = raw.target
  if (target !== undefined) assertRecallTarget(target)

  const budget = raw.contextBudget
  if (typeof budget !== 'object' || budget === null) {
    throw new KernelError(
      'validation_error',
      'recall_request_missing_budget',
      'RecallRequest.contextBudget 缺失'
    )
  }
  const budgetRecord = budget as Record<string, unknown>

  const intent = raw.intent ?? 'unspecified'
  if (!isRecallIntent(intent)) {
    throw new KernelError('validation_error', 'recall_unknown_intent', `未登记的 intent：${String(intent)}`)
  }

  const kinds = raw.memoryKinds
  if (kinds !== undefined && !Array.isArray(kinds)) {
    throw new KernelError('validation_error', 'recall_bad_memory_kinds', 'memoryKinds 必须是数组')
  }

  const timeScope = (raw.timeScope ?? { kind: 'any' }) as RecallTimeScope

  return createRecallRequest({
    traceId: String(raw.traceId ?? ''),
    characterId: String(raw.characterId ?? ''),
    user: entityRef('user', String(userRecord.id)),
    query: {
      text: String(queryRecord.text ?? ''),
      source: queryRecord.source,
      ...(typeof queryRecord.eventId === 'string'
        ? { eventId: queryRecord.eventId as ConversationEventId }
        : {}),
    },
    intent,
    target: (target ?? RECALL_TARGET_NONE) as RecallTarget,
    timeScope,
    ...(kinds !== undefined ? { memoryKinds: kinds as readonly MemoryType[] } : {}),
    candidateLimit: raw.candidateLimit as number | undefined,
    contextBudget: {
      memoryTokens: Number(budgetRecord.memoryTokens),
      ...(budgetRecord.reservedTokens !== undefined
        ? { reservedTokens: Number(budgetRecord.reservedTokens) }
        : {}),
    },
    ...(typeof raw.session === 'object' && raw.session !== null
      ? { session: raw.session as RecallSessionScope }
      : {}),
  })
}

function assertRecallTarget(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new KernelError('validation_error', 'recall_bad_target', 'target 必须是对象')
  }
  const target = value as Record<string, unknown>
  if (!['resolved', 'ambiguous', 'not_found', 'none'].includes(String(target.status))) {
    throw new KernelError(
      'validation_error',
      'recall_bad_target',
      `target.status 未登记：${String(target.status)}`
    )
  }
  if (target.status === 'resolved') {
    const subject = target.subject
    if (typeof subject !== 'object' || subject === null) {
      throw new KernelError('validation_error', 'recall_bad_target', 'resolved 的 target 必须带 subject')
    }
    const subjectRecord = subject as Record<string, unknown>
    if (typeof subjectRecord.kind !== 'string' || typeof subjectRecord.id !== 'string') {
      throw new KernelError('validation_error', 'recall_bad_target', 'subject 必须是 EntityRef')
    }
  }
  if (target.status === 'ambiguous') {
    const candidates = Number(target.candidates ?? 0)
    if (!Number.isSafeInteger(candidates) || candidates < 2) {
      throw new KernelError(
        'validation_error',
        'recall_bad_target',
        'ambiguous 的候选数必须 ≥ 2 —— 否则那不是"判不出来"，而是"只有一条"'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// RecallCandidate / RecallDecision
// ---------------------------------------------------------------------------

/**
 * 一条**检索候选**（从投影读出来的记忆快照）。
 *
 * ⚠️ 它不是 `MemoryRecord` 的别名，刻意的差别有三处：
 *   · 只带召回**判定需要**的字段（不是整个投影行）
 *   · `dataText` 是给模型看的那一句话（数据块），由 WP3 从记录渲染
 *   · `retrievedBy` 记录它是被哪几条通道召回的（可解释性）
 *
 * ⚠️ 契约**不依赖具体数据库**（AT1.3）：
 *    这个类型里没有任何 SQL 行形状、没有连接句柄、没有 embedding。
 *    WP3 的适配器负责"行 → 这个类型"，M5 的其余部分只认它。
 */
export interface RecallCandidate {
  /** Trusted retrieval-port result, bound to the exact requester/audience. */
  authorization?: { readonly scope: ScopeContext; readonly allowed: boolean }
  memoryId: MemoryId
  owner: EntityRef
  type: MemoryType
  status: MemoryStatus
  authority: MemoryAuthority
  epistemicStatus: MemoryEpistemicStatus
  subjects: readonly EntityRef[]
  importance: number
  confidence: number
  recordedAt: Timestamp
  occurredAt?: Timestamp
  validFrom?: Timestamp
  validUntil?: Timestamp | null
  canonicalKey?: string
  /**
   * 槽位指纹（`canonicalKey + 规范化取值`）—— **由适配器用 M4 的 `slotOfRecord` 算好带上来**。
   *
   * 为什么它必须在候选上、而不是让 WP4 自己去算：
   * "两条记忆是不是同一个槽位、同一个取值"只能有**一处**定义（M4 的
   * `slotFingerprintOf`）。WP4 手里只有渲染后的文本、没有原始取值 ——
   * 用它去凑一个指纹会让去重与 M4 的冲突检测漂移，
   * 而漂移的表现是"她一会儿把它们当一条、一会儿当两条"。
   *
   * Episode 家族没有槽位 → `undefined`。
   */
  slotFingerprint?: string
  contentFingerprint: string
  /** Claim 型的槽位键（已规范化）；Episode 没有 */
  predicate?: string
  /** 取值或摘要的**可搜索文本**（词面相关性用；不是正文副本） */
  searchable: string
  /** 作为 MEMORY_DATA 注入的那一句话（**数据**，不是指令） */
  dataText: string
  sourceRefs: readonly EvidenceRef[]
  /** 它被哪几条通道找到（可解释性；进 trace） */
  retrievedBy: readonly RecallChannel[]
  /** 是否已被判定为"状态完整性损坏"（M5-PRE 探针的结论，由 WP2 填） */
  integrityOk: boolean
  /**
   * **M5.1.1 / Phase 4b（ADR-043 `DR-1` / `DR-3`）**：这条记忆的**当前认知资格**。
   *
   * ```text
   * ESTABLISHED          来源已确立（作者是用户，Axis B confirmed）
   * UNCONFIRMED_ORIGIN   来源**未确立**（历史行 / MIGRATED_LEGACY / 没有信封）
   * CONTRADICTED_ORIGIN  来源已确立，但作者**不是**用户
   * 缺失                  不适用（Episode 面不进本规则 —— ADR-043 `DR-5`）
   * ```
   *
   * ⚠️ 它是**读时派生量**，**不是**库里的列：
   *    · **不**重写 `authority`（那是"当时"的判定，不可变）
   *    · **不**参与"能不能入选"（ADR §3.3 ⑤：资格不足**不**把她的记忆踢出召回）
   *    · 只影响**排序里 authority 分量的档位**与 **prompt 标签的后缀**
   *
   * 取值类型复用 4a 的 `SourceQualification`（用户 `D-2 = ①`：一个概念一个名字）。
   */
  qualification?: SourceQualification
  /**
   * **后 Lv2 · 用户 2026-10-03（选项 a 步骤 2）**：这一条的**真实语义分数**（`0..1`）。
   *
   * ```text
   * 有值  本次后端**真的**为这一条算出了语义分数
   * 无值  没有语义分数（未启用 / 不可用 / 这一条不在语义索引里）
   * ```
   *
   * ⚠️ **读时派生量，不是库里的列**（与 `qualification` 同一条纪律）：它描述的是
   *    "这一次检索里语义通道给这条打了多少分"，不是记忆本身的属性。
   *
   * ⚠️ **为什么不能只看 `retrievedBy` 里的 `'semantic'` 标签**：那个标签的语义
   *    **只是"拿到了分数"** —— 一条被打 0.02 分的无关记忆与一条被打 0.95 分的相关记忆
   *    **标签完全相同**。因此"语义能否作为相关性证据"**必须**看这个**数值**，
   *    配一个**经校准的阈值**（见 `RecallRankingPolicy.semanticRelevanceFloor`）。
   */
  semanticScore?: number
}

export interface RecallScoreComponent {
  /** 因素名（semantic / entity / temporal / salience / authority / continuity …） */
  name: string
  value: number
  /**
   * 这个因素**这次真的算得出来吗**。
   *
   * 计划书 WP4：允许部分因素暂时为 `not available`，**但不得伪造数据**。
   * 把"算不出来"做成显式字段，才能让一个 0.0 分与"没这个维度"在 trace 上可区分 ——
   * 否则审计会把"缺维度"读成"这一维真的很低"。
   */
  available: boolean
  note?: string
}

export interface RecallScoreBreakdown {
  total: number
  components: readonly RecallScoreComponent[]
}

export interface RecallDecision {
  memoryId: MemoryId
  /** 是否通过 P0 资格闸（owner / subject / target / status / integrity / policy） */
  eligible: boolean
  /**
   * 未选中时**必有**：它是在哪一道闸、因为什么没进上下文。
   *
   * 阶段不用单独写：它由理由唯一决定（`RECALL_EXCLUSION_REASON_FACTS[reason].stage`）。
   * 于是"资格问题 / 排序淘汰 / 预算装不下"三分在类型上就不可能互相矛盾 ——
   * 而这三者的**修法完全不同**，混起来会让 trace 指向错的地方。
   */
  reason?: RecallExclusionReason
  /** 通过资格后才有分数 */
  score?: RecallScoreBreakdown
  /** 最终是否进上下文 */
  selected: boolean
}

/**
 * 一条决策的自洽性校验。
 *
 * 它拦的是三种"trace 失去可解释性"的形状：
 *   · 选中了却带着排除理由（两件事互斥）
 *   · 没选中却没有理由（trace 会出现"它被排除了，但没人知道为什么"）
 *   · 理由的阶段与 `eligible` 矛盾（把"排序淘汰"记成"资格拒绝"）
 */
export function assertRecallDecision(decision: RecallDecision): void {
  if (decision.selected) {
    if (decision.reason !== undefined) {
      throw new KernelError(
        'validation_error',
        'recall_decision_inconsistent',
        `selected=true 的决策不许带 reason（收到 ${decision.reason}）：` +
          '"进了上下文"与"被某道闸拦下"是互斥的两件事'
      )
    }
    if (!decision.eligible) {
      throw new KernelError(
        'validation_error',
        'recall_decision_inconsistent',
        `记忆 ${String(decision.memoryId)} 没有通过资格闸却被选中 —— ` +
          'P0 安全层的全部意义就是这件事不可能发生'
      )
    }
    return
  }

  if (decision.reason === undefined) {
    throw new KernelError(
      'validation_error',
      'recall_decision_missing_reason',
      `记忆 ${String(decision.memoryId)} 没进上下文，但没有理由：` +
        'trace 里会出现"它被排除了，但没人知道为什么"的行'
    )
  }
  assertExclusionReasonReachable(decision.reason)

  const stage = RECALL_EXCLUSION_REASON_FACTS[decision.reason].stage
  if (stage === 'eligibility' && decision.eligible) {
    throw new KernelError(
      'validation_error',
      'recall_decision_stage_mismatch',
      `${decision.reason} 是资格阶段的理由，但这条候选被标记为 eligible=true —— ` +
        '两者不能同时成立（否则"它被资格拦下了"与"它通过了资格"会同时被记录）'
    )
  }
  if (stage !== 'eligibility' && !decision.eligible) {
    throw new KernelError(
      'validation_error',
      'recall_decision_stage_mismatch',
      `${decision.reason} 属于 ${stage} 阶段，但它被标记为 eligible=false —— ` +
        '把"排序淘汰 / 装不下"记成"资格拒绝"会让 trace 指向错误的修法'
    )
  }
}

// ---------------------------------------------------------------------------
// ContextBundle
// ---------------------------------------------------------------------------

export interface RecallSelectedMemory {
  memoryId: MemoryId
  /** 作为数据块注入的文本（**数据**，不是指令） */
  dataText: string
  /** provenance / authority：进数据块的元数据，也进 trace 的引用 */
  type: MemoryType
  authority: MemoryAuthority
  epistemicStatus: MemoryEpistemicStatus
  subjects: readonly EntityRef[]
  sourceRefs: readonly EvidenceRef[]
  canonicalKey?: string
  contentFingerprint: string
  recordedAt: Timestamp
  estimatedTokens: number
  score?: RecallScoreBreakdown
  /** **M5.1.1 / Phase 4b**：本轮入选时这条记忆的当前资格（与预算估算用的是**同一份**文本，见 `render.ts`） */
  qualification?: SourceQualification
}

/**
 * 预算账 —— 计划书 WP5 要求能回答"上下文为什么这么长"。
 *
 * 四个数字分开，是因为它们的**修法不同**：
 *   记忆太长 → 改记忆预算 / 改排序；会话太长 → 改 recent limit；
 *   保留区太大 → 改预留策略；总预算太小 → 改配置。
 */
export interface RecallBudgetAccount {
  budgetTokens: number
  memoryTokens: number
  reservedTokens: number
  totalTokens: number
  /** 由 WP6 填（最近对话那一块）；WP5 只负责记忆那一块 */
  conversationTokens?: number
}

/**
 * `externalEvidence` 的位置（M5 恒为空数组；**M5.5 起由 M5.5 的验证器把关**）。
 *
 * 它在这里而不是在 M5.5 里，是为了让"证据有两个来源"这件事从第一天起
 * 就是**同一个数据结构**（计划书 NEXT MILESTONE 那张图的要求）：
 *
 *     Internal Memory ─┐
 *                      ├─→ ContextBundle → ContextCompiler
 *     External Evidence┘
 *
 * ⚠️ 类型本身住在 `contracts/external-evidence.ts`（ADR-045 D-14）——
 *    一个引用只能有一个定义，这里只保留 re-export（见文件头的 import 段）。
 *    M5.5 的字段比 M5 预留的多三个：`provider` / `contentFingerprint` / `citationLabel`，
 *    它们都是**必填**：缺指纹与标签的引用不可审计。
 */

export interface RecallIntegrityNotice {
  reason: Extract<RecallExclusionReason, 'ORPHANED_EVIDENCE' | 'POLICY'>
  memoryId?: MemoryId
  detail: string
}

export interface ContextBundle {
  traceId: TraceId
  characterId: CharacterId
  user: EntityRef
  generatedAt: Timestamp
  /** 本轮请求（可能为空：WP6 在召回未启用时也可能构造空 bundle） */
  request?: RecallRequest
  /** 宽召回到的候选（**只进 trace 用 id / 指纹**，正文不进 trace） */
  candidates: readonly RecallCandidate[]
  decisions: readonly RecallDecision[]
  selected: readonly RecallSelectedMemory[]
  budget: RecallBudgetAccount
  /** M5 恒为 `[]`；M5.5 复用同一个字段 */
  externalEvidence: readonly ExternalEvidenceRef[]
  integrityNotices: readonly RecallIntegrityNotice[]
}

/**
 * "判不出来 → 什么都不选"的 bundle（G2 的契约落点）。
 *
 * 用户 2026-09-17 的裁定：Scenario E 只验证
 * `not_found / ambiguous → selected = []`，**不**硬造第三人。
 * 这个构造函数让"空召回"成为**一等公民**：它有理由、有账、可进 trace，
 * 而不是"什么都没发生所以没有 bundle"。
 */
export function createEmptyContextBundle(input: {
  request: RecallRequest
  decisions: readonly RecallDecision[]
  integrityNotices?: readonly RecallIntegrityNotice[]
  now: Timestamp
}): ContextBundle {
  for (const decision of input.decisions) assertRecallDecision(decision)
  if (input.decisions.some((d) => d.selected)) {
    throw new KernelError(
      'validation_error',
      'recall_empty_bundle_with_selection',
      'createEmptyContextBundle 收到了 selected=true 的决策 —— 空 bundle 的定义就是"一条都没选"'
    )
  }
  return {
    traceId: input.request.traceId,
    characterId: input.request.characterId,
    user: input.request.user,
    generatedAt: input.now,
    request: input.request,
    candidates: [],
    decisions: input.decisions,
    selected: [],
    budget: {
      budgetTokens: input.request.contextBudget.memoryTokens,
      memoryTokens: 0,
      reservedTokens: input.request.contextBudget.reservedTokens ?? 0,
      totalTokens: 0,
    },
    externalEvidence: [],
    integrityNotices: input.integrityNotices ?? [],
  }
}

export function assertContextBundle(bundle: ContextBundle): void {
  for (const decision of bundle.decisions) assertRecallDecision(decision)

  const selectedIds = new Set(bundle.selected.map((item) => String(item.memoryId)))
  for (const decision of bundle.decisions) {
    if (decision.selected && !selectedIds.has(String(decision.memoryId))) {
      throw new KernelError(
        'validation_error',
        'recall_bundle_selection_mismatch',
        `决策说 selected=true，但它不在 selected 列表里：${String(decision.memoryId)}`
      )
    }
  }

  /*
   * M5.5 / COMPAT-1（ADR-045 附录 B）：这条判据**取代**了 M5 的"非空即拒"。
   *
   *   旧锁：`externalEvidence` 必须是空数组（M5 不实现外部证据）
   *   新锁：非空 ⇒ 必须通过 M5.5 的验证器（标签只能来自选择器 / HTTPS /
   *         有指纹 / 唯一 / 有上限）
   *
   * 方向没变（"绕过 M5.5 入口塞进来的东西仍然进不去"），收紧的是形状。
   * M5 的历史 PASS 一字未改 —— 这是一次**兼容判据取代**的登记，
   * 不是把过去的结论改写成别的样子。
   */
  if (bundle.externalEvidence.length > 0) {
    assertExternalEvidenceRefs(bundle.externalEvidence)
  }
  const sum = bundle.selected.reduce((total, item) => total + item.estimatedTokens, 0)
  if (sum > bundle.budget.budgetTokens) {
    throw new KernelError(
      'validation_error',
      'recall_budget_exceeded',
      `选中的记忆合计 ${sum} tokens 超过预算 ${bundle.budget.budgetTokens} —— ` +
        '预算的第一条用途就是"永远装得下"，装不下时该裁的是选择，不是预算'
    )
  }
}

/**
 * M5.5（ADR-045 `D-2`）：把**当轮外部证据的引用**挂到 bundle 上。
 *
 * 它是**唯一**允许做这件事的函数，而且挂完立刻重新过 `assertContextBundle` ——
 * 于是"绕过 M5.5 验证器往 bundle 里塞一条自造引用"在类型上可行、在运行期仍然失败关闭
 * （`assertContextBundle` 对非空 `externalEvidence` 会调 M5.5 的引用校验器）。
 *
 * ⚠️ 只在**已经有 bundle** 时才有意义（召回开着才有 bundle）。
 *    召回关闭时证据仍能进上下文（section 由轮次驱动），但**不进 bundle** ——
 *    那个差异会被如实记进 trace（`bundleAttached: false`），不假装一样。
 */
export function withExternalEvidence(
  bundle: ContextBundle,
  refs: readonly ExternalEvidenceRef[]
): ContextBundle {
  const next: ContextBundle = { ...bundle, externalEvidence: [...refs] }
  assertContextBundle(next)
  return next
}

// ---------------------------------------------------------------------------
// trace 形态（**隐私**：正文不进 trace）
// ---------------------------------------------------------------------------

export interface ContextBundleTraceView {
  traceId: TraceId
  characterId: CharacterId
  user: string
  generatedAt: Timestamp
  requestDigest?: string
  candidateIds: string[]
  candidateCount: number
  decisionCount: number
  /** 命中每个理由的候选数（WP7 的 retrieval metrics 直接从它来） */
  exclusionHistogram: Record<string, number>
  selectedIds: string[]
  selectedFingerprints: string[]
  budget: RecallBudgetAccount
  externalEvidenceCount: number
  integrityNotices: { reason: string; memoryId?: string }[]
}

/**
 * 把 bundle 压成**可以安全落库的形态**。
 *
 * 计划书 WP7 的隐私纪律：audit 可以引用 `memory id` / `hash` / `metadata`，
 * 但**不要**把完整敏感记忆正文复制进日志。因此这个函数**只**输出
 * id、指纹、计数、账目 —— 它连 `dataText` 字段都不认识。
 *
 * 它的位置在契约层而不是 WP7：让"哪一份是安全的"成为类型与函数的事实，
 * 而不是"写日志的时候记得别带正文"。
 */
export function serializeContextBundleForTrace(bundle: ContextBundle): ContextBundleTraceView {
  assertContextBundle(bundle)

  const exclusionHistogram: Record<string, number> = {}
  for (const decision of bundle.decisions) {
    if (decision.reason === undefined) continue
    exclusionHistogram[decision.reason] = (exclusionHistogram[decision.reason] ?? 0) + 1
  }

  return {
    traceId: bundle.traceId,
    characterId: bundle.characterId,
    user: entityLabel(bundle.user),
    generatedAt: bundle.generatedAt,
    ...(bundle.request !== undefined ? { requestDigest: recallRequestDigest(bundle.request) } : {}),
    candidateIds: bundle.candidates.map((item) => String(item.memoryId)).sort(),
    candidateCount: bundle.candidates.length,
    decisionCount: bundle.decisions.length,
    exclusionHistogram,
    selectedIds: bundle.selected.map((item) => String(item.memoryId)).sort(),
    selectedFingerprints: bundle.selected.map((item) => item.contentFingerprint).sort(),
    budget: bundle.budget,
    externalEvidenceCount: bundle.externalEvidence.length,
    integrityNotices: bundle.integrityNotices.map((notice) => ({
      reason: notice.reason,
      ...(notice.memoryId !== undefined ? { memoryId: String(notice.memoryId) } : {}),
    })),
  }
}

/** 便于诊断/日志：一条候选压成一行（**不含正文**） */
export function describeRecallCandidate(candidate: RecallCandidate): string {
  return (
    `${String(candidate.memoryId)} [${candidate.type}/${candidate.status}] ` +
    `authority=${candidate.authority} imp=${candidate.importance.toFixed(2)} ` +
    `channels=${candidate.retrievedBy.join('+') || '无'} integrity=${candidate.integrityOk ? 'ok' : 'broken'}`
  )
}
