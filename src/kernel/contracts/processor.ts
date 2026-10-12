/**
 * Processor —— "从事实中产生解释或 Proposal 的组件"。
 *
 * ============================================================================
 *  这一层是**唯一**允许调用 LLM 的地方（Slow Path）
 * ============================================================================
 * Fast Path（用户在等回复）里不允许出现 Processor；Processor 全部在后台跑，
 * 它们的输出只能是 Proposal，永远不能直接写 canonical state。
 *
 * M2.5 只定义接口，并提供一个诊断实现（DiagnosticProcessor）。
 * 未来实现：memory-extractor / relationship-evaluator / affect-evaluator /
 *          belief-evaluator / goal-extractor / reflection-engine。
 */

import type {
  CharacterId,
  ConversationEventId,
  ConversationId,
  ProcessorVersion,
  Timestamp,
} from './ids.ts'
import type { DomainProposal } from './proposal.ts'
import type { TrustedOriginReading } from './attribution.ts'

/**
 * Processor 的输入。
 *
 * 刻意是**一段事件范围**而不是一条消息：大多数认知判断需要上下文窗口
 * （"他这几次都这样"），而不是单句。范围由 `sourceFromSequence` /
 * `sourceToSequence` 界定，与 Job 的幂等键天然对齐。
 */
export interface ProcessorInput {
  characterId: CharacterId
  /** 本次处理的事件（已按 sequence 升序） */
  events: readonly ProcessorEventView[]
  sourceFromSequence: number
  sourceToSequence: number
}

/**
 * Processor 看到的事件视图。
 *
 * 注意这不是 `ConversationEvent` 本身：Processor 不需要（也不该）看到
 * 数据库 row 的全部字段。少即是安全——它看不到 `metadata` 里的内部键，
 * 也就不可能把它们写进 Memory。
 */
export interface ProcessorEventView {
  id: ConversationEventId
  sequence: number
  conversationSequence: number
  type: 'user_message' | 'assistant_message' | 'system_event'
  actorType: 'user' | 'character' | 'system'
  actorId?: string
  content: string
  createdAt: Timestamp
  /**
   * **M5.1.1 / Phase 4a（ADR-043 `DR-6` / `DR-7`）**：该事件的**受信来源读数**。
   *
   * ```text
   * 有值   ⇒ 该事件带 `attribution_origin = 'RECORDED'` 的**受信**归因信封
   *          （由 `processorEventViewOf()` 从真实事件上取，全仓库唯一产出点）
   * 无值   ⇒ 来源**未确立**：没有信封 / MIGRATED_LEGACY / 形状坏了
   * ```
   *
   * ⚠️ **它不是"调用方声明"**：`attribution_origin = 'RECORDED'` 只能由
   *    `buildTrustedAttributionContext()` 产出的上下文写出来（类型层 + 运行期 WeakSet 双重守卫），
   *    因此这个字段在**生产**里只可能来自真实受信 ingress。
   *    ⚠️ 单位测试**构造**一个带它的视图字面量，那是"夹具声明自己的输入前提"，
   *    **不是**运行期后门 —— 后门的定义是"不可信调用方能自报来源"，
   *    而这里没有任何运行期路径能让不可信调用方填它。
   */
  /**
   * **M9 WP3（追加，可选）**：该事件所属会话。
   *
   * B-INFERRED 的"跨 ≥2 会话"判据需要会话维度（ADR-070 §3.4 冻结值）。
   * 可选是为了**不破坏既有构造点**：M4/M7/M8 的夹具与调用方不填它也照旧
   * 合法；belief 评估器把"缺失会话维度"按失败关闭处理（不形成，不累计）。
   */
  conversationId?: ConversationId

  trustedOrigin?: TrustedOriginReading
}

export interface ProcessorContext {
  /** 供 Processor 记录到提案里的自身版本（不许自己硬编码字符串） */
  readonly processorName: string
  readonly processorVersion: ProcessorVersion
  /**
   * 可选的模型调用入口。
   *
   * 由基础设施注入，**不进领域层**：Processor 只声明"我需要一次模型调用"，
   * 具体走哪个 provider / 哪次 trace 由外层决定。
   * 没有注入时（纯规则 Processor、测试环境）为 undefined。
   */
  readonly invokeModel?: (prompt: string, options?: { purpose?: string }) => Promise<string>
  /**
   * 依赖注入的服务读取口（只在需要时用）。
   *
   * 有意的极简设计：`get('x')` 返回 unknown，由调用方自己收窄类型。
   * 这样领域契约层不需要知道任何具体服务的形状。
   */
  readonly getService?: (name: string) => unknown
}

export interface CharacterProcessor<TInput = ProcessorInput> {
  /** 组件名，进 DomainEvent.processor 与幂等键 */
  readonly name: string

  /** 组件版本，**独立于应用版本**（`diagnostic-processor@1`） */
  readonly version: ProcessorVersion

  /**
   * 处理一批事件，产出零到多个提案。
   *
   * 约定：
   *   · **必须幂等**：同一 (input 范围, processor, version) 重复调用
   *     产出的提案语义必须相同（幂等键由调用方按契约计算，见 idempotency.ts）。
   *   · 允许返回空数组（"这批事件里没有值得记住的东西"是正常结论）。
   *   · 抛错 = 任务失败，由 Job 层决定重试；不要用异常表达"没有提案"。
   */
  process(
    input: TInput,
    context: ProcessorContext
  ): Promise<DomainProposal[]>
}
