/**
 * Job / High Water Mark —— 后台处理的可靠性契约。
 *
 * ============================================================================
 *  Slow Path 必然引入乱序、重复与断点续跑
 * ============================================================================
 * M2.5 不实现完整任务调度器（如果 Runtime 已有 Job 系统就 Adapter），
 * 但**数据模型必须现在就支持**三件事：
 *
 *   1. 顺序：任务处理的是 `[sourceFromSequence, sourceToSequence]` 闭区间，
 *      而不是"最近一批消息"——否则断点续跑无法定义。
 *   2. 幂等：`idempotencyKey` 唯一，重试不产生第二份副作用。
 *   3. 水位：`processedThroughSequence` 让 Processor 知道"我做到哪了"，
 *      并让 M4 的 Memory Watermark / M11 的 Reflection Batch 有共同基准。
 */

import { KernelError, type CharacterId, type JobId, type ProcessorVersion, type Timestamp } from './ids.ts'

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

// ---------------------------------------------------------------------------
// TriggerKind（M3.5：计划书第 35–38 / 72 / 81 节）
// ---------------------------------------------------------------------------

/**
 * 任务**由什么触发**。
 *
 * 现状：后台任务全部由对话事件驱动（`conversation`）或系统维护触发（`system`）。
 * 未来会有：
 *
 *   schedule        定时（"每天凌晨整理一次记忆"）
 *   environment     环境（"下雪了"）
 *   external_event  外部事件（"她收到了一个包裹"）
 *
 * M3.5 **只登记**后三种，不实现任何调度器（计划书第 3 节明确禁止"复杂 Scheduler"）。
 *
 * 为什么现在就要有：`trigger_kind` 会进 `character_jobs` 这张表，
 * 而它是**运行历史**。今天用 `'conversation'` 冒充一次"定时任务"，
 * 明天就分不清"这条 job 是不是真的由对话触发" —— 与 `actor.ts` 里
 * `tool` 那条注释是同一个道理。
 */
export type TriggerKind = 'conversation' | 'system' | 'schedule' | 'environment' | 'external_event'

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'conversation',
  'system',
  'schedule',
  'environment',
  'external_event',
]

/** M3.5 真正启用的两种 */
export const M3_5_ENABLED_TRIGGER_KINDS: readonly TriggerKind[] = ['conversation', 'system']

/** M3.5 仅登记、不产出的三种 */
export const M3_5_RESERVED_TRIGGER_KINDS: readonly TriggerKind[] = [
  'schedule',
  'environment',
  'external_event',
]

export function isTriggerKind(value: unknown): value is TriggerKind {
  return typeof value === 'string' && (TRIGGER_KINDS as readonly string[]).includes(value)
}

export function isTriggerEnabledInM3_5(kind: TriggerKind): boolean {
  return (M3_5_ENABLED_TRIGGER_KINDS as readonly string[]).includes(kind)
}

/**
 * **具名许可表**（post-Lv2 / QQ 主动联系 · ADR-110 `D02`）。
 *
 * ============================================================================
 *  为什么是"按 processor 名作用域"而不是"按 kind 全局放行"
 * ============================================================================
 * ```text
 * ① 全局放行会让两道**已冻结**的门直接红：
 *    · `scripts/future-compat-tests.ts` 断言 M3_5_ENABLED_TRIGGER_KINDS 逐字为
 *      ['conversation','system']，且三种保留 kind 逐个抛 trigger_kind_not_enabled
 *    · `scripts/verify-m3.5-persistence.ts` 用 processor 'm35-verify' + 'schedule'
 *      断言**必须被拒**
 * ② 按 processor 名作用域则**天然兼容**：'m35-verify' 不在表里 ⇒ 仍然被拒。
 * ```
 *
 * ⚠️ 这张表**必须**保持**有界且具名**：只登记真正接线的那几个处理器名，
 *    不提供"按前缀/正则匹配"的形态（那等于把闸门换成一个模式串）。
 * ⚠️ 它**不**改写 `M3_5_ENABLED_TRIGGER_KINDS`：那三个保留 kind 作为**历史事实**留在原处。
 */
export const NAMED_TRIGGER_PERMITS: Readonly<Record<string, readonly TriggerKind[]>> = Object.freeze({
  /* 明确提醒（计划 §4.1） */
  'qq-proactive-reminder': Object.freeze(['schedule'] as const),
  /* 自主关心（计划 §4.1） */
  'qq-proactive-care': Object.freeze(['schedule'] as const),
})

/** 某个具名处理器是否被许可产出某种触发（闭集查询；未知处理器 ⇒ `false`） */
export function isTriggerPermittedForProcessor(processor: string, kind: TriggerKind): boolean {
  const permitted = NAMED_TRIGGER_PERMITS[processor]
  return permitted !== undefined && (permitted as readonly string[]).includes(kind)
}

/**
 * 运行期守卫：M3.5 只允许对话与系统两种触发。
 *
 * 与 `assertM3_5OutputInvariant` 同一个思路 —— 把"这个阶段不做 X"
 * 变成**跑得起来的断言**，而不是文档里的一句承诺。
 * 未来真的接调度器时，这里（且只有这里）需要放宽，
 * 而放宽的那一刻会被 review 看见。
 *
 * ---------------------------------------------------------------------------
 *  post-Lv2 / ADR-110 `D02`：**追加**具名许可，不改旧语义
 * ---------------------------------------------------------------------------
 * ```text
 * assertTriggerEnabledInM3_5(kind)                ← 单参调用**逐字节不变**（旧门就是这么调的）
 * assertTriggerEnabledInM3_5(kind, processor)     ← 第二参**可选**：
 *     · 先走旧判据（conversation/system ⇒ 直接放行，旧路径零影响）
 *     · 旧判据不过 ⇒ 才查`NAMED_TRIGGER_PERMITS`；命中且 kind 在该处理器的允许集里 ⇒ 放行
 *     · 否则仍抛 trigger_kind_not_enabled（**默认仍然是拒绝**）
 * ```
 * ⚠️ 第二参是**可选**的，因此既有单参调用点（含冻结门脚本）的行为一个字都没变。
 */
export function assertTriggerEnabledInM3_5(kind: TriggerKind, processor?: string): void {
  if (isTriggerEnabledInM3_5(kind)) return
  if (processor !== undefined && isTriggerPermittedForProcessor(processor, kind)) return
  throw new KernelError(
    'validation_error',
    'trigger_kind_not_enabled',
    `M3.5 只启用 ${M3_5_ENABLED_TRIGGER_KINDS.join('/')}，收到 ${kind}。` +
      '其它触发方式已经登记在枚举里，但还没有任何调度器能产出它们（计划书第 3 节）' +
      (processor === undefined
        ? '；本次没有给出处理器名，因此没有具名许可可用'
        : `；处理器 ${processor} 没有对 ${kind} 的具名许可`),
    { kind, ...(processor === undefined ? {} : { processor }) }
  )
}

/**
 * 任务的触发描述（计划书第 37 节）。
 *
 * 这是"将来的形状"，由 `triggerOf()` 从既有字段**派生**（计划书第 38 节：
 * Adapter，而不是删掉 `source_event_range`）。派生而不是并存两份，
 * 是为了不出现"trigger 说 system、序号却指向对话"的互相矛盾状态。
 */
export interface CharacterJobTrigger {
  kind: TriggerKind
  sourceRefs: string[]
}

export interface CharacterJob {
  id: JobId
  characterId: CharacterId

  processor: string
  processorVersion: ProcessorVersion

  /**
   * M3.5：由什么触发。
   *
   * **optional** 是刻意的（计划书第 38 节"保持向后兼容"）：
   * 迁移之前写入的 job 行没有这一列，读回来是 `undefined`。
   * 语义上的缺省值由 `triggerKindOf()` 统一给出（`'conversation'`）——
   * 旧行的含义本来就是"由对话触发"，因此这个缺省不是猜测，是事实。
   */
  triggerKind?: TriggerKind

  /** 处理范围（闭区间，按角色级 sequence） */
  sourceFromSequence: number
  sourceToSequence: number

  /** 幂等键：唯一索引，重试撞键 = 已经做过了 */
  idempotencyKey: string

  status: JobStatus
  retryCount: number

  /** 失败原因（人类可读），成功时为 undefined */
  lastError?: string

  createdAt: Timestamp
  startedAt?: Timestamp
  finishedAt?: Timestamp
}

/** 任务的触发种类（缺省 = 对话：这是迁移前旧行的真实含义，不是猜测） */
export function triggerKindOf(job: { triggerKind?: TriggerKind }): TriggerKind {
  const kind = job.triggerKind ?? 'conversation'
  if (!isTriggerKind(kind)) {
    throw new KernelError(
      'validation_error',
      'unknown_trigger_kind',
      `未登记的 TriggerKind：${String(kind)}`
    )
  }
  return kind
}

/**
 * 由既有字段派生触发描述（计划书第 38 节的 Adapter）。
 *
 * ⚠️ `sourceRefs` 记录的是**序号区间**而不是事件 id：
 * `character_jobs` 这一行本来就只存区间（`source_from_sequence` /
 * `source_to_sequence`），编造出具体事件 id 会让"这条 job 处理了哪些事件"
 * 有两种不一致的答案。要事件 id 时应当按区间去查账本 —— 那才是唯一真相。
 */
export function triggerOf(job: {
  triggerKind?: TriggerKind
  sourceFromSequence: number
  sourceToSequence: number
}): CharacterJobTrigger {
  return {
    kind: triggerKindOf(job),
    sourceRefs: [`sequence:${job.sourceFromSequence}..${job.sourceToSequence}`],
  }
}

/**
 * Processor 的水位。
 *
 * 例：`memory-extractor: processedThroughSequence = 120`
 * 意思是"第 120 号对话事件及其之前，都已经处理过了"。
 *
 * M2.5 不实现正式 Memory Processor，但这个表现在就建，
 * 否则 M4 会被迫改表（plan 第 37 节明确要求）。
 */
export interface ProcessorWatermark {
  characterId: CharacterId
  processor: string
  processorVersion: ProcessorVersion
  processedThroughSequence: number
  updatedAt: Timestamp
}

/** 水位只允许前进：回退会让已处理的事件被重复处理 */
export function assertWatermarkAdvances(
  current: ProcessorWatermark | undefined,
  next: number
): void {
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new KernelError(
      'validation_error',
      'bad_watermark',
      `水位必须是非负安全整数，收到 ${next}`
    )
  }
  if (current && next < current.processedThroughSequence) {
    throw new KernelError(
      'validation_error',
      'watermark_regression',
      `水位不允许回退：当前 ${current.processedThroughSequence}，试图写入 ${next}`
    )
  }
}

// ---------------------------------------------------------------------------
// 幂等键
// ---------------------------------------------------------------------------

/**
 * 幂等键的**唯一**计算处（plan 第 34 节）。
 *
 *     character_id + processor + processor_version + source_event_range + operation_type
 *
 * 刻意把 processor_version 编进键：改了 Prompt 或算法就是一次**新的**处理，
 * 旧的幂等记录不该拦住它（这正是 plan 第 38 节"精确重处理 v2 产物"的前提）。
 */
export function computeIdempotencyKey(parts: {
  characterId: CharacterId
  processor: string
  processorVersion: ProcessorVersion
  sourceFromSequence: number
  sourceToSequence: number
  operation: string
}): string {
  if (parts.processor.trim() === '') {
    throw new KernelError('validation_error', 'processor_missing', '幂等键缺少 processor')
  }
  if (parts.processorVersion.trim() === '') {
    throw new KernelError(
      'validation_error',
      'processor_version_missing',
      '幂等键缺少 processorVersion'
    )
  }
  if (parts.sourceFromSequence > parts.sourceToSequence) {
    throw new KernelError(
      'validation_error',
      'bad_source_range',
      `事件范围非法：[${parts.sourceFromSequence}, ${parts.sourceToSequence}]`
    )
  }
  const material = [
    parts.characterId,
    parts.processor,
    parts.processorVersion,
    `${parts.sourceFromSequence}-${parts.sourceToSequence}`,
    parts.operation,
  ].join('|')

  // FNV-1a 64 位风格的稳定摘要：确定性、无依赖、足够短。
  // 不用 crypto：它在这里只是"把长键压短"，不是安全用途；
  // 而且同步实现让 DomainEvent 的构造保持纯函数。
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < material.length; i += 1) {
    hash ^= BigInt(material.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return `idem:${hash.toString(16).padStart(16, '0')}`
}

/**
 * 由**一个提案**算出它的幂等键（每个 targetEvent 一个）。
 *
 * 这是幂等键的**唯一**入口：Validator、Processor、测试全部走这里，
 * 因此"重试时算出的键和第一次不同"这种 bug 在结构上不可能发生。
 *
 * `sourceFromSequence` / `sourceToSequence` 取提案引用事件的序号范围：
 * "同一批证据 + 同一 Processor + 同一版本 + 同一操作" = 同一件事。
 */
export function idempotencyKeyFor(proposal: {
  characterId: CharacterId
  processor: string
  processorVersion: ProcessorVersion
  sourceConversationEventIds: readonly { toString(): string }[]
  targetEvents: readonly { operation: string }[]
}): string[] {
  const sequences = proposal.sourceConversationEventIds.map((id) => sequenceFromEventId(String(id)))
  const valid = sequences.filter((n): n is number => n !== undefined)
  if (valid.length === 0) {
    throw new KernelError(
      'validation_error',
      'idempotency_without_source',
      '无法计算幂等键：提案没有任何可解析出序号的来源事件'
    )
  }
  const from = Math.min(...valid)
  const to = Math.max(...valid)

  return proposal.targetEvents.map((target) =>
    computeIdempotencyKey({
      characterId: proposal.characterId,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      sourceFromSequence: from,
      sourceToSequence: to,
      operation: target.operation,
    })
  )
}

/** 从 `cev:<characterId>:<conversationId>:<sequence>` 里取回序号 */
export function sequenceFromEventId(eventId: string): number | undefined {
  const parts = eventId.split(':')
  if (parts.length < 4 || parts[0] !== 'cev') return undefined
  const value = Number(parts[parts.length - 1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
