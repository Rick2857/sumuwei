/**
 * M5 WP3 —— **Retrieval Port**（检索端口）。
 *
 * ============================================================================
 *  计划书的设计规则
 * ============================================================================
 *     M5 不应直接绑定：specific vector DB / specific SQL / specific third-party
 *     memory system。应通过现有架构建立 Adapter / Port。
 *
 * 因此这个文件里**只有形状**：一个请求（`MemoryRetrievalQuery`）、一个结果
 * （`MemoryRetrievalResult`）、一个端口（`MemoryRetrievalPort`）。
 * 没有任何 SQL、没有表名、没有 embedding、没有连接句柄 ——
 * 适配器（`src/infrastructure/persistence/memory-retrieval-store.ts`）负责把它们实现出来。
 *
 * ---------------------------------------------------------------------------
 *  为什么"宽召回"是端口契约的一部分（而不是实现细节）
 * ---------------------------------------------------------------------------
 * 计划书 WP3 的测试要求写得很直白：
 *
 *     Candidate Retrieval 可以**宽召回**；但 Eligibility 后非法候选全部消失。
 *
 * 这意味着一件事：**适配器不许自己做资格过滤**。
 * 在适配器里顺手把 retracted / 别人的记忆滤掉，会让 WP2 的三个零泄漏判据
 * （forgotten / wrong-user / invalid-target）**失去可测性** ——
 * 因为那些非法候选根本到不了资格层，计数器就永远是 0，
 * 而"永远是 0"与"真的没有泄漏"在输出上完全一样。
 *
 * 隔离由 `kernel/recall/eligibility.ts` 负责，且它有 768 例矩阵与
 * 泄漏计数守着（见 `artifacts/m5/wp2-eligibility.json`）。
 */

import type { CharacterId, MemoryId, Timestamp, TraceId } from '../contracts/ids.ts'
import type { EntityRef } from '../contracts/entity.ts'
import type { MemoryRecord, MemoryType } from '../contracts/memory.ts'
import type {
  RecallChannel,
  RecallTimeScope,
  RetrievalPolicyVersion,
  SemanticMode,
  SemanticUnavailableReason,
} from '../contracts/recall.ts'
import type { TrustedOriginReading } from '../contracts/attribution.ts'
import type { ScopeContext } from '../contracts/scope.ts'
import type { RollupSourceFacts } from '../contracts/rollup.ts'

/**
 * 后端能如实提供的检索维度。
 *
 * `semantic`（向量/嵌入）**当前不可用**：M4 的记忆表没有嵌入列，
 * 项目也不允许为 M5 引入向量库（计划书 WP3 Forbidden）。
 * 因此适配器必须把它**如实报出来**，而不是悄悄当成 0 分 ——
 * 一个"看起来存在、其实是空的"维度会让 WP4 的分档目标变成自欺欺人的 95%
 * （用户 2026-09-17 对 G3 的裁定：接受边界，但必须如实测量）。
 */
export type MemoryRetrievalDimension = 'subject' | 'recency' | 'lexical' | 'time' | 'kind' | 'semantic'

/** 一次检索的**能力报告** */
export interface MemoryRetrievalCapabilities {
  /** 这次真的能提供的维度 */
  available: readonly MemoryRetrievalDimension[]
  /** 这次提供不了的维度（必须写明，不许静默变成 0 分） */
  unavailable: readonly { dimension: MemoryRetrievalDimension; reason: string }[]
}

/**
 * 译成后端能执行的维度（AT3.1 的产物）。
 *
 * ⚠️ 它**不是** SQL：任何后端都能读它。字段就是计划书 AT3.2 点名的那些
 *    （user scope / target / time / memory kind / lexical）。
 */
export interface MemoryRetrievalQuery {
  traceId: TraceId
  /** Memory Space（namespace）—— 唯一允许的跨用户边界 */
  characterId: CharacterId
  /** 本次请求归属的用户（subject 通道的输入） */
  user: EntityRef
  /**
   * 目标解析出的实体（有则用它做 subject 通道）。
   *
   * 没有它时仍然可以按"请求归属的用户"召回 —— 那不是猜，而是这个系统的
   * 长期事实几乎都以用户为 subject（M4 的 subject 域只有 USER / CHARACTER）。
   */
  targetSubject?: EntityRef
  /** 用户那句话（词面通道的输入） */
  text: string
  memoryKinds?: readonly MemoryType[]
  timeScope: RecallTimeScope
  /**
   * **U1 / `ADR-138`（`G18`）：本轮的作用域三元组**（谁 · 什么用途 · 哪个空间）——**可选**。
   *
   * 由 `RecallRequest.scope` 透传；装配层注入的授权器**读它**来决定候选的可读性。
   * 缺省 ⇒ 字段不出现 ⇒ 既有行为一字不变。
   */
  scope?: ScopeContext
  /** 宽召回上限（有界；资格过滤之后还会再裁一次，见 WP5） */
  limit: number
  /** 只要这些 memory id（**目前没有生产者**：见 RECALL_CHANNEL_FACTS.explicit_id） */
  explicitIds?: readonly MemoryId[]
  /**
   * **M9.5 / WP6（ADR-074 的 D25）**：检索策略版本。
   *
   * ```text
   * 缺省（不传）= `lexical-recency@1` = 现状 ⇒ **行为一字不变**。
   * 传 `hybrid-relevance@1` ⇒ 候选**先按相关性排序、再截断**（D25 第 ①② 条）。
   * ```
   *
   * ⚠️ 未知值必须由调用方**拒绝**（`isRetrievalPolicyVersion`），不得静默回落或默认开启。
   */
  retrievalPolicyVersion?: RetrievalPolicyVersion
  /**
   * **M9.5 / WP8**：语义模式（`off` / `shadow` / `on`）。
   *
   * 缺省 ⇒ 由 `retrievalPolicyVersion` 推导（旧行为一字不变）。
   * `shadow` = 算分并记下对照读数，但**实际使用的排序仍是旧路径**（S47）。
   */
  semanticMode?: SemanticMode
}

/**
 * **M9.5 / WP6（D26-④ + R3）**：语义探针端口。
 *
 * ```text
 * 它做两件事，而且**必须**分成两个结果分支：
 *   ① 把**用户那句话**编码成查询向量（本地模型；超时/模型缺失都要**具名**失败）
 *   ② 在**指定 namespace 与 generation** 的派生索引里做**精确检索**，返回 memoryId → 分数
 * 拿不到就**具名**返回原因（`SemanticUnavailableReason`）—— **不许**返回空 map 冒充"分数都是 0"。
 * ```
 *
 * ⚠️ 为什么它必须能"具名失败"而不是抛异常：计划 §9.3 要求
 *    「`degraded_lexical`（语义路径不可用，旧路径仍有效）不宣称本次完成了语义检索」。
 *    抛异常会让调用方只能整体失败；具名原因才能让这一轮**如实降级**并写进 trace。
 *
 * ⚠️ 端口**仍然不做资格过滤**（与本文件开头同一条纪律）：它只给分数，不给"能不能用"。
 */
export interface MemorySemanticProbe {
  /** 适配器名（进 trace：换检索面时能看出是哪一次） */
  readonly name: string
  /**
   * 为**这批候选**取语义分数。
   *
   * 实现约定：
   *   · 只查 `characterId` 这个 namespace、且属于**当前 generation** 的向量；
   *   · 只算 `memoryIds` 里的那些（有界；调用方给的上限就是候选上限）；
   *   · 返回的 map **只含真的算出来的**条目 —— 缺的键表示"这条没有向量"；
   *     若**一条都没算出来**，返回 `{ ok: false, reason: 'missing_score' }`（R3）。
   */
  readonly score: (input: {
    readonly characterId: CharacterId
    readonly text: string
    readonly memoryIds: readonly MemoryId[]
  }) => Promise<
    | { readonly ok: true; readonly scores: ReadonlyMap<string, number> }
    | { readonly ok: false; readonly reason: SemanticUnavailableReason }
  >
}

/** 一条命中的候选行 */
export interface MemoryRetrievalHit {
  authorization?: { readonly scope: ScopeContext; readonly allowed: boolean }
  /** 投影行（还**没有**变成 RecallCandidate —— 那一步由应用层渲染） */
  record: MemoryRecord
  /** 它被哪几条通道找到（进 trace；也告诉 WP4 "这条是不是词面命中过"） */
  channels: readonly RecallChannel[]
  /**
   * **后 Lv2 · 用户 2026-10-03（选项 a 步骤 2）**：这一条的**真实语义分数**。
   *
   * ```text
   * 有值  本次后端**真的**为这一条算出了语义分数（0..1）
   * 无值  没有语义分数（未启用 / 不可用 / 这一条不在索引里）
   * ```
   *
   * ⚠️ **它必须与 `channels` 里的 `'semantic'` 标签同源同时出现**。
   *    `'semantic'` 标签只说明"**拿到了分数**"，**不是**"内容相关" ——
   *    把标签当相关性证据放行，就是拿"有分数"冒充"有关系"（用户点名的那条）。
   *    要让相关性闸认可语义，**必须**看这个**数值**与一个**经校准的阈值**。
   */
  semanticScore?: number
  /**
   * **M5.1.1 / Phase 4b（ADR-043 §3.2）**：这条记忆**根证据**各自的受信来源读数。
   *
   * ```text
   * 有值   该根证据带 `attribution_origin = 'RECORDED'` 的**受信**信封
   * 无值   该根证据**没有**受信信封（历史行 / MIGRATED_LEGACY / 形状坏 / 行不存在）
   * ```
   *
   * ⚠️ 它由**适配器**从 `memory_evidence_links.is_root` + 事件行的归因列上取
   *    （与 4a 的 `processorEventViewOf()` 同源：只有**受信**行才产生读数）。
   *    端口**仍然不做资格过滤**（计划书 WP3：宽召回，资格由 `eligibility.ts` 与
   *    4b 的资格派生分别负责）—— 这里只是把**原始读数**如实带上来。
   */
  rootReadings: readonly (TrustedOriginReading | undefined)[]
}

export interface MemoryRetrievalResult {
  hits: readonly MemoryRetrievalHit[]
  capabilities: MemoryRetrievalCapabilities
  /** 后端实际取回的行数（含未被任何通道确认相关的那些）—— 用于解释"召回为什么这么宽" */
  scanned: number
  /**
   * **M9.5 / WP7（D25 第 ④ 条的配套）**：本次**真的拿到语义分数**的那些 memoryId。
   *
   * ```text
   * 为什么是**列表**而不是一个数：trace 要回答的不只是"用了几条语义"，
   * 还有"**哪几条**语义候选真的入了模、哪几条算了分却没进上下文"。
   * 计数由 `length` 派生 —— 一份事实、两处投影，避免"计数与名单漂移"。
   *
   * 为什么它必须独立于 `capabilities.available`：
   * "能力报告说可用"与"这一轮真的用了语义"是两件事，而它们**必须可分辨** ——
   * 否则「available=true 但一条都没参与」这种伪启用会与正常情况长得一模一样。
   * 不可用 / 未启用时是 **空数组**（不是 undefined：空表示"量过了，结果是没有"）。
   * ```
   */
  semanticScoredIds: readonly string[]
  /**
   * **U1 / `ADR-138`（`G18`）`D05`：授权前置过滤的读数**（**可选**）。
   *
   * ```text
   * 只有装配层**注入**了授权器时才会出现（`createMemoryRetrievalStore({ authorizeCandidates })`）。
   * 缺省**不出现**在对象上 ⇒ 既有调用点与 trace 的形状逐字不变。
   *
   * 为什么必须可观测：`G18` 的第二个后果是**静默** —— 调用方只看到 `hits` 变少，
   * 分不清"本来就没有"与"被越权候选挤掉了"。这三个数把后者变成可读的事实。
   * ⚠️ 只记**计数**，不记 id、不记正文（隐私边界与 `shadow` 同一条）。
   * ```
   */
  authorization?: {
    readonly authorized: number
    readonly denied: number
    readonly deniedForMissingLabel: number
  }
  /**
   * **M9.5 / WP8（`shadow` 模式）**：新旧检索的**对照读数**。
   *
   * ```text
   * 只在 `semanticMode === 'shadow'` 且真的拿到分数时出现。
   * 它回答"如果开启，顺序会变成什么" —— 而**实际使用的顺序不受它影响**
   * （计划书逐字：shadow「实际回复只使用旧路径」）。
   * ⚠️ 只记 memoryId 与布尔，**不记任何正文**（隐私边界）。
   * ```
   */
  shadow?: {
    readonly legacyOrderIds: readonly string[]
    readonly hybridOrderIds: readonly string[]
    readonly topChanged: boolean
  }
  /**
   * 探针报出的"状态完整性损坏"的记忆 id。
   *
   * ⚠️ 它**必须**来自 M5-PRE 的探针（`memoryIntegrityProblems()`），
   *    不许在适配器里另写一套"证据还在不在"的判断 ——
   *    两处判断漂移的表现是"她引用了一份已经不存在的证据"，
   *    而那不会报错，只会让 provenance 指向空。
   *
   * 破损的判据（与 M5-PRE 一致）：
   *   · 没有任何活证据
   *   · 没有任何活事件流（`rebuildMemory` 必然 `equal = false`）
   * 而"证据指向已删会话、但仍有活证据"**不算**破损 —— 那是被显式抹掉的
   * 历史痕迹（见 `memory-integrity.ts` 里"幸存者"那一节的说明）。
   */
  brokenMemoryIds: readonly string[]
}

export interface MemoryRetrievalPort {
  /** 适配器名（进 trace：换后端时能看出是哪一次） */
  readonly name: string
  /**
   * 取候选。
   *
   * **只读**：端口契约要求实现不得写任何表（计划书 WP3 Forbidden：
   * 不换 backend、不加基础设施；M5 的召回是纯粹读取）。
   */
  retrieve(query: MemoryRetrievalQuery): Promise<MemoryRetrievalResult>
}

/**
 * 一次检索的完整结果（应用层加工后交给资格层）。
 *
 * 刻意把 `capabilities` 一起带出来：WP4 要用它把"算不出来的维度"
 * 标成 `available: false`，而不是给一个 0 分（那会把边界伪装成低分）。
 */
export interface RetrievedCandidates<TCandidate> {
  candidates: readonly TCandidate[]
  capabilities: MemoryRetrievalCapabilities
  /** 后端扫描过的行数（诊断用：回答"宽召回到底有多宽"） */
  scanned: number
}

export const SEMANTIC_UNAVAILABLE_REASON =
  'M4 的记忆表没有嵌入列，且计划书 WP3 禁止为召回引入向量库 —— 语义相似度当前不可用（不得伪造成 0 分）'

/** 便于诊断/证据：一次检索的能力报告压成一行 */
export function describeRetrievalCapabilities(capabilities: MemoryRetrievalCapabilities): string {
  const available = capabilities.available.join('+') || '无'
  const unavailable = capabilities.unavailable
    .map((item) => `${item.dimension}(${item.reason})`)
    .join('; ')
  return `available=[${available}] unavailable=[${unavailable || '无'}]`
}

/** 时间过滤的**纯**判定（适配器与测试共用同一份，避免两处边界不一致） */
export function isWithinTimeScope(input: {
  timeScope: RecallTimeScope
  recordedAt: Timestamp
  occurredAt?: Timestamp
}): boolean {
  const scope = input.timeScope
  if (scope.kind === 'any') return true
  // 事件时间优先（"这件事什么时候发生"），没有则退回"系统什么时候记下"
  const at = input.occurredAt ?? input.recordedAt
  if (scope.kind === 'recent') {
    return scope.from === undefined ? true : at >= scope.from
  }
  if (scope.kind === 'at') {
    const target = scope.from ?? scope.to
    if (target === undefined) return true
    return at === target
  }
  if (scope.from !== undefined && at < scope.from) return false
  if (scope.to !== undefined && at > scope.to) return false
  return true
}

// ---------------------------------------------------------------------------
// M6 / ADR-050 —— 会话摘要的**只读来源端口**
// ---------------------------------------------------------------------------

/**
 * 摘要来源的**有界、只读**读取面。
 *
 * ============================================================================
 *  三条契约（都由 gate 断言，不靠注释自律）
 * ============================================================================
 * 1. **只读**：实现**不得写任何表**。摘要是派生上下文（ADR-050 `DR-1`），
 *    它零写入 —— 这一条与 `MemoryRetrievalPort` 的同一句话是同一条纪律。
 * 2. **有界**：`scanCeiling` 是**硬上限**。实现要么取到不超过它，要么如实告知取不满；
 *    绝不允许"先读全表再截断"（那等于把无界成本藏进一次看起来有界的调用）。
 * 3. **不猜**：读不到来源 / 读不到归因 / 形状坏 ⇒ 该条**照实**返回
 *    （`originReading` 缺席、`rootMemoryStatuses` 为空数组），由选择器失败关闭。
 *    实现**不得**回落到 `actor_type`、不得补一个默认位次、不得把 `MIGRATED_LEGACY`
 *    洗成 `RECORDED`（那正是 `M5.1-D01` 的形态）。
 *
 * ⚠️ 归因读数**只能**由唯一适配边界 `processorEventViewOf()` 产出（用户裁定 `R-59`）：
 *    实现必须**消费**它的输出，不得自己解析那几个物理列。
 */
export interface RollupSourceReader {
  /** 适配器名（进 trace：换读取面时能看出是哪一次） */
  readonly name: string
  /**
   * 取**本会话**在指定序列之前的候选来源，**按序列升序**返回。
   *
   * `beforeSequence` 是**排他**下界：只要 `sequence < beforeSequence` 的事件。
   * 为什么是"早于"而不是"晚于"：要保留的是**已经离开 Recent 窗口**的早期发言
   * （近期对话本来就有原文进上下文，摘要是它的**替代品**，不是它的重复）。
   */
  read(input: {
    readonly characterId: CharacterId
    readonly conversationId: string
    /** 排他上界：只取 `sequence < beforeSequence` */
    readonly beforeSequence: number
    /** 硬上限（调用方给；实现必须如实遵守） */
    readonly scanCeiling: number
  }): Promise<readonly RollupSourceFacts[]>
}
