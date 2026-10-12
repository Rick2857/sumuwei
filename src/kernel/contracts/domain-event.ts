/**
 * DomainEvent —— **角色变化历史**。
 *
 * ============================================================================
 *  铁律 3：Domain Event 是"她因此如何变化"
 * ============================================================================
 * 必须引用 `sourceConversationEventIds`，因此永远能回答：
 *
 *     "为什么她现在 trust=0.61？"
 *            ↓
 *     Domain Event #820
 *            ↓
 *     Conversation Event #471
 *            ↓
 *     具体那次对话
 *
 * 这是"可追溯"这一条要求的落地点：没有 source 的 DomainEvent 不允许写入
 * （Validator 会 `source_event_missing` 直接拒绝，见 plan 第 22 节"失败关闭"）。
 */

import {
  KernelError,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
  type ProcessorVersion,
  type SchemaVersion,
  type Timestamp,
} from './ids.ts'

/**
 * M4：`MEMORY_CREATED` 的 payload 携带**首版完整快照**，因此这里需要 `MemoryRecord`。
 *
 * ⚠️ 依赖方向是 `domain-event.ts → memory.ts`，**单向**。
 * `memory.ts` 不 import 本文件（它只依赖 ids / entity / memory-predicates /
 * source-authority），因此不存在循环依赖。
 * 这条要守住：一旦 memory.ts 反过来 import domain-event.ts，
 * 类型检查会过，但运行时可能拿到半初始化的模块。
 */
import type { MemoryRecord } from './memory.ts'

/**
 * M7：Relationship 的 payload 契约与结构校验（一个概念一处实现）。
 * 依赖方向 `domain-event.ts → relationship.ts` **单向**——relationship.ts
 * 只依赖 ids / entity / attribution，不反向到达本文件（无循环）。
 */
import {
  validateRelationshipImpactPayload,
  validateRelationshipOriginPayload,
  type RelationshipImpactPayload,
  type RelationshipOriginPayload,
} from './relationship.ts'

/**
 * M8：Affect 的 payload 契约与结构校验（一个概念一处实现）。
 * 依赖方向 `domain-event.ts → affect.ts` **单向**——affect.ts 只依赖
 * ids / attribution，不反向到达本文件（无循环；与 relationship 同构）。
 */
import {
  validateAffectImpactPayload,
  validateAffectOriginPayload,
  validateAffectTouchPayload,
  type AffectImpactPayload,
  type AffectOriginPayload,
  type AffectTouchPayload,
} from './affect.ts'

/**
 * M9：Belief 的 payload 契约与结构校验（一个概念一处实现）。
 * 依赖方向 `domain-event.ts → belief.ts` **单向**——belief.ts 只依赖
 * ids / entity / memory（均为叶子），不反向到达本文件（无循环；
 * 与 relationship / affect 同构）。
 */
import {
  validateBeliefDisputedPayload,
  validateBeliefEvidenceNotedPayload,
  validateBeliefFormedPayload,
  validateBeliefOriginPayload,
  validateBeliefReinforcedPayload,
  validateBeliefRetractedPayload,
  validateBeliefSupersededPayload,
  type BeliefDisputedPayload,
  type BeliefEvidenceNotedPayload,
  type BeliefFormedPayload,
  type BeliefOriginPayload,
  type BeliefReinforcedPayload,
  type BeliefRetractedPayload,
  type BeliefSupersededPayload,
} from './belief.ts'

/**
 * M10：Goal / Commitment 的 payload 契约与结构校验（一个概念一处实现）。
 * 依赖方向 `domain-event.ts → goal.ts` **单向**——goal.ts 只依赖
 * ids / entity / memory / belief / attribution，不反向到达本文件（无循环；
 * 与 relationship / affect / belief 同构）。
 */
import {
  validateCommitmentAcceptedPayload,
  validateCommitmentBrokenPayload,
  validateCommitmentCancelledPayload,
  validateCommitmentFulfilledPayload,
  validateCommitmentExpiredPayload,
  validateCommitmentSupersededPayload,
  validateGoalBlockedPayload,
  validateGoalCancelledPayload,
  validateGoalCompletedPayload,
  validateGoalCreatedPayload,
  validateGoalPausedPayload,
  validateGoalRevisedPayload,
  validateGoalResumedPayload,
  validateGoalSupersededPayload,
  type CommitmentAcceptedPayload,
  type CommitmentBrokenPayload,
  type CommitmentCancelledPayload,
  type CommitmentFulfilledPayload,
  type CommitmentExpiredPayload,
  type CommitmentSupersededPayload,
  type GoalBlockedPayload,
  type GoalCancelledPayload,
  type GoalCompletedPayload,
  type GoalCreatedPayload,
  type GoalPausedPayload,
  type GoalRevisedPayload,
  type GoalResumedPayload,
  type GoalSupersededPayload,
} from './goal.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_ORIGIN,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
  validateAdaptiveSelfRevisedPayload,
  validateReflectionInvalidatedPayload,
  validateReflectionOriginPayload,
  validateReflectionProposedPayload,
  validateReflectionReviewedPayload,
  type AdaptiveSelfRevisedPayload,
  type ReflectionInvalidatedPayload,
  type ReflectionOriginPayload,
  type ReflectionProposedPayload,
  type ReflectionReviewedPayload,
} from './reflection-events.ts'
import {
  STORY_EXPERIENCE_RETRACTED,
  validateStoryExperienceRetractedPayload,
  type StoryExperienceRetractedPayload,
} from './story-events.ts'

export const DOMAIN_EVENT_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// scope —— 角色内部 vs 世界（计划书第 39–42 节）
// ---------------------------------------------------------------------------

/**
 * CharacterDomainEvent 的**职责范围**：永远只描述"角色内部发生了什么"。
 *
 * FC-04（计划书第 5 / 42 / 97 节）：
 *
 *   > CharacterDomainEvent 永远只描述角色内部发生的变化，
 *   > 不得在未来同时承担"世界事实"的职责。
 *
 * `'WORLD'` **登记在这里但永不启用** —— 登记的理由是让"世界的那个东西"
 * 有一个明确的名字（未来真的建 WorldEvent 时不必再发明一个词），
 * 不启用的理由是那条边界一旦模糊就再也收不回来了（append-only）。
 *
 * `assertCharacterInternalScope()` 是唯一的守卫，它插在
 * `policies/validator.ts` 的**唯一**受理点：即使某天有人写了
 * `targetEvents: [{ scope: 'WORLD' }]`，提案也会被**整体拒绝**，
 * 而不是悄悄写进 `character_domain_events`。
 *
 * ⚠️ 为什么它是**常量 + 校验**而不是一个数据库列（审计决策 D2）：
 * M3 给 provenance 加列的理由是"字典一定会漏写 / 写错键名"。
 * 但那条理由在这里不成立 —— 这个值**恒为同一个常量**，不是数据。
 * 给常量建列只会得到一个"永远同一个值、但理论上可以被写错"的列。
 */
export type DomainEventScope = 'CHARACTER_INTERNAL' | 'WORLD'

/** M3.5（以及在此之前）唯一允许的 scope */
export const DOMAIN_EVENT_SCOPE = 'CHARACTER_INTERNAL' as const

export function assertCharacterInternalScope(scope: DomainEventScope): void {
  if (scope !== DOMAIN_EVENT_SCOPE) {
    throw new KernelError(
      'validation_error',
      'domain_event_scope_not_character_internal',
      `CharacterDomainEvent 只能描述角色内部的变化，收到 scope=${String(scope)}。` +
        '世界事实必须走 WorldEvent（M3.5 不建这张表）—— ' +
        '把世界事实塞进角色变化历史，会让"她以为"与"世界是"永久混在一起（FC-04）',
      { scope: String(scope) }
    )
  }
}

/**
 * Domain Event 的类型名。
 *
 * M2.5 **只登记一个**测试用类型（`TEST_CHARACTER_SIGNAL`），
 * M4–M11 再逐个登记 `MEMORY_CREATED` / `RELATIONSHIP_IMPACT` / …
 *
 * 这里不是 `string` 的自由类型别名，而是一个**受控登记表**：
 * Validator 只接受登记表里存在的类型（plan 第 21 节 allowlist 要求），
 * 这样"某个 Processor 手滑写出一个新类型、悄悄改变了系统语义"不可能发生。
 */
export const DIAGNOSTIC_SIGNAL = 'TEST_CHARACTER_SIGNAL' as const

/** 已登记的 Domain Event 类型（M2.5 的全部合法值） */
export const REGISTERED_DOMAIN_EVENT_TYPES: readonly string[] = [DIAGNOSTIC_SIGNAL]

export type DomainEventType = string

export interface DomainEvent<TPayload = unknown> {
  id: DomainEventId

  characterId: CharacterId

  /** 角色级单调序号（与 ConversationEvent 各自的序列，互不共用） */
  sequence: number

  type: DomainEventType

  /**
   * 本事件由哪些**真实对话**引起。**不得为空**。
   *
   * 允许复数是因为 M4+ 的许多变化确实来自多轮对话（例如"长期一致表现"
   * 需要多轮证据），而不是单轮。
   */
  sourceConversationEventIds: ConversationEventId[]

  /**
   * 由哪些**其它 Domain Event** 引起（派生链）。
   *
   * 这是 M11 防"Reflection 自我强化"的基础：派生结论必须能追到源头，
   * 而不能被当成独立证据重复计票（plan 第 34 节 / 铁律 11）。
   * M2.5 不产生派生事件，但字段必须先存在，否则 M11 会被迫改表。
   */
  causedByDomainEventIds?: DomainEventId[]

  payload: TPayload

  /** 产生这个事件的组件名（如 `diagnostic-processor`） */
  processor: string

  /** 产生这个事件的组件版本（如 `diagnostic-processor@1`） */
  processorVersion: ProcessorVersion

  /**
   * 幂等键：同一 (processor, version, source, operation) 只允许产生一个事件。
   * 持久层对它建唯一索引——后台任务重试不会写第二份（SC-004）。
   */
  idempotencyKey: string

  schemaVersion: SchemaVersion
  createdAt: Timestamp

  /**
   * M3.5：职责范围。
   *
   * 类型是**字面量**，因此"造出一条 scope 不是 CHARACTER_INTERNAL 的
   * DomainEvent"在**编译期就写不出来**（写 `'WORLD'` 直接类型错误）。
   *
   * 为什么是 optional 而不是必填：M2.5 已有的构造点（包括 `kernel-tests.ts`
   * 里喂给 `applyEvent` 的字面量）不该因为 M3.5 而被迫改动 ——
   * 计划书第 82 节要求 M2.5/M3 的测试保持不动。
   * 语义上"未声明"只有一种可能的值，`rowToDomainEvent` 读取时一律填
   * `CHARACTER_INTERNAL`，因此 optional 不会带来任何歧义。
   *
   * 运行期那道闸在 Validator（`assertCharacterInternalScope`）：
   * 提案声称 `scope: 'WORLD'` 会被**整体拒绝**，而不是悄悄写进表里。
   */
  scope?: typeof DOMAIN_EVENT_SCOPE

  /** M3.5：这件事什么时候发生（缺省 = 不知道，见 `time.ts`） */
  occurredAt?: Timestamp

  /** M3.5 预留的模拟时间槽位（当前必须为空） */
  logicalTime?: string
}

/**
 * Processor 提交给 Validator 的"待落库领域事件"。
 *
 * 与 `DomainEvent` 的区别：还没有 id 与 sequence——**它们由持久层分配**，
 * 和 ConversationEvent 同一个道理：领域层无权决定序号。
 */
export interface NewDomainEvent<TPayload = unknown> {
  characterId: CharacterId
  type: DomainEventType
  sourceConversationEventIds: ConversationEventId[]
  causedByDomainEventIds?: DomainEventId[]
  payload: TPayload
  processor: string
  processorVersion: ProcessorVersion
  idempotencyKey: string
  createdAt?: Timestamp
  /** M3.5：发生时间（缺省 = 不知道） */
  occurredAt?: Timestamp
  /** M3.5：模拟时间槽位（当前必须留空） */
  logicalTime?: string
}

// ---------------------------------------------------------------------------
// 类型登记表
// ---------------------------------------------------------------------------

export interface DomainEventTypeSpec<TPayload = unknown> {
  type: DomainEventType
  /** 该类型的 payload 校验器：不合法直接抛 KernelError(validation_error) */
  validatePayload: (payload: unknown) => TPayload
  /** payload 序列化后的最大字节数（plan 第 21 节 maximum payload size） */
  maxPayloadBytes: number
  /** 人类可读说明，会进 architecture 文档与 trace */
  description: string
}

/**
 * 类型登记表。
 *
 * Reducer 与 Validator 都从这里取"这个类型合法吗、payload 长什么样"，
 * 因此新增认知模块时**只有一处需要改**。
 */
export class DomainEventRegistry {
  private readonly specs = new Map<DomainEventType, DomainEventTypeSpec>()

  register<TPayload>(spec: DomainEventTypeSpec<TPayload>): void {
    if (this.specs.has(spec.type)) {
      throw new Error(`Domain Event 类型重复登记：${spec.type}`)
    }
    this.specs.set(spec.type, spec as DomainEventTypeSpec)
  }

  get(type: DomainEventType): DomainEventTypeSpec | undefined {
    return this.specs.get(type)
  }

  has(type: DomainEventType): boolean {
    return this.specs.has(type)
  }

  types(): DomainEventType[] {
    return [...this.specs.keys()].sort()
  }
}

/**
 * 允许被脚本注册的**默认**登记表：只含 M2.5 的诊断链路。
 *
 * 刻意做成"每次新建一份"的工厂而不是全局单例：
 * 测试可以拿到干净的表，生产代码也不会因为某处误注册而全局被污染。
 */
export function createDefaultDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()
  registry.register<DiagnosticSignalPayload>({
    type: DIAGNOSTIC_SIGNAL,
    description:
      'M2.5 诊断信号：只用于验证 Proposal→Validator→DomainEvent→Reducer→Projection 整条链。生产行为不得依赖它。',
    maxPayloadBytes: 1024,
    validatePayload: (payload) => {
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('诊断信号 payload 必须是对象')
      }
      const delta = (payload as { counterDelta?: unknown }).counterDelta
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        throw new Error('诊断信号 payload.counterDelta 必须是有限数字')
      }
      // 只取**契约内**的字段：多出来的字段由 Validator 的 payload 上限拦截，
      // 而不是在这里当成 schema 错误 —— 这样"太大"与"不合法"是两个可区分的拒绝码。
      return { counterDelta: delta }
    },
  })
  return registry
}

/** M2.5 唯一的诊断 payload */
export interface DiagnosticSignalPayload {
  counterDelta: number
}

// ---------------------------------------------------------------------------
// M4：Memory Domain Events（计划书第 70–71 节）
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 *  为什么 Memory 的变化**必须**是领域事件，而不是直接 UPDATE 那张表
 * ============================================================================
 * 计划书第 71 节把这条写成了硬规定：
 *
 *     应用层禁止 repository.update(memory) 绕过事件。
 *
 * 原因是计划书第 72 节那句定义：
 *
 *     MemoryRecord = 当前 Memory Projection
 *     Memory Domain Events = "Memory 为什么变成现在这样"
 *
 * 少了事件这一半，"她上个月认为什么、为什么改"就永久丢失，
 * 而那份历史是**用户与苏沐薇共同产生的、不可重复的**（计划书第 201 节）。
 *
 * 因此六种类型在这里登记，payload 契约在这里定义 ——
 * 与诊断信号同一个模式（`DomainEventRegistry` + `validatePayload`），
 * 于是"某个处理器手滑写一个新类型、悄悄改变系统语义"仍然不可能发生。
 */
export const MEMORY_CREATED = 'MEMORY_CREATED' as const
export const MEMORY_MERGED = 'MEMORY_MERGED' as const
export const MEMORY_SUPERSEDED = 'MEMORY_SUPERSEDED' as const
export const MEMORY_RETRACTED = 'MEMORY_RETRACTED' as const
export const MEMORY_DISPUTED = 'MEMORY_DISPUTED' as const
export const MEMORY_RESTORED = 'MEMORY_RESTORED' as const

/** M4 登记的全部 Memory 领域事件类型 */
export const MEMORY_DOMAIN_EVENT_TYPES: readonly string[] = [
  MEMORY_CREATED,
  MEMORY_MERGED,
  MEMORY_SUPERSEDED,
  MEMORY_RETRACTED,
  MEMORY_DISPUTED,
  MEMORY_RESTORED,
]

/**
 * 这条变化来自**哪条路径**（计划书第 61–64 节的"两速记忆"）。
 *
 * 进 payload 的理由不是统计好看，而是审计与治理：
 * 半年后要回答"这条记忆是用户要求记的，还是后台自己抽的"，
 * 而那个答案决定了"记错了该怪谁"以及"重处理时该不该动它"。
 */
export type MemoryMutationSource = 'explicit' | 'background'

/** `MEMORY_CREATED` 的 payload */
export interface MemoryCreatedPayload {
  memoryId: string
  /**
   * 首版完整快照。
   *
   * 为什么把整条记录塞进事件而不是只存 id：
   * `rebuildMemory(memoryId)` 要从事件重算出记录，而
   * **第一条事件必须携带足够信息从零建出它**。
   * 若只存 id，重建就只能去读当前的 `memory_records` 行 ——
   * 那等于"用结果证明结果"，Replay 就不再是独立验证（计划书第 74 节 A==B）。
   */
  record: MemoryRecord
  mutation: MemoryMutationSource
  /**
   * **复活形标记**（M9.1 / ADR-072 D02，可选）。
   *
   * 缺席 = 首次创建或历史 no-op 事件（旧语义逐字节不变）；
   * 存在 = 这条 CREATE 是「忘掉/更正后**新的合格重述**」的复活写入：
   * 折叠器据此把 `record`（复活快照，revision = previousRevision + 1）
   * 采纳为新状态——而不是按 D2 的重复创建语义 no-op。
   *
   * 为什么是「标记 + revision 守卫」而不是「非 ACTIVE 一律复活」：
   *   · 旧事件流里没有这个字段 ⇒ 重放语义逐字节不变（R07 兼容边界）；
   *   · `previousRevision` 必须与折叠时状态一致 ⇒ 并发/过期重述确定性 no-op（D14）；
   *   · DISPUTED 不在 `previousStatus` 里 ⇒ 不因泛化分支自动恢复（D10）。
   */
  restatement?: MemoryCreatedRestatement
}

/**
 * `MEMORY_CREATED` 复活形的版本化标记（ADR-072 D02/D03/D05）。
 *
 * 由**唯一放行口**（`memory-validator.ts` 的 create 路径）在发射时附加：
 * 既有记录状态 ∈ {retracted, superseded} + 开关开 + 新证据与旧来源不相交（R06）。
 * reducer（`applyCreated`）只在 `previousRevision` 与当前状态一致时采纳复活快照。
 */
export interface MemoryCreatedRestatement {
  /** 被复活记录在发射时的 revision（reducer 的一致性守卫；复活后 = 该值 + 1） */
  previousRevision: number
  /** 被复活前的状态（只有这两种可复活——DISPUTED 不自动恢复，ADR-072 D10） */
  previousStatus: 'retracted' | 'superseded'
}

/** `MEMORY_SUPERSEDED` 的 payload（计划书第 31 / 35 / 36 节） */
export interface MemorySupersededPayload {
  memoryId: string
  /** 取代它的那条 */
  supersededBy: string
  /** 旧条事实层面的失效时刻（计划书第 36 节） */
  validUntil: number
  reason: string
}

/** `MEMORY_RETRACTED` 的 payload（计划书第 32 / 58–59 节） */
export interface MemoryRetractedPayload {
  memoryId: string
  /**
   * 撤回的**原因分类**。
   *
   * 为什么不是自由文本：`explicit_forget`（用户要求忘掉）与
   * `explicit_correction`（用户说之前记错了）在后续治理里处理方式不同 ——
   * 前者不许再记，后者可以重新提案正确的版本。
   * 而 `audit` 表示"系统自己发现这条不该存在"（例如 processor@1 的已知缺陷）。
   */
  reason: 'explicit_forget' | 'explicit_correction' | 'audit'
  note?: string
}

/** `MEMORY_DISPUTED` 的 payload（计划书第 33 / 82 节） */
export interface MemoryDisputedPayload {
  memoryId: string
  /** 与它矛盾的对侧（可能还没进库，因此允许为空数组） */
  conflictingMemoryIds: string[]
  /** 判不了的原因（进 trace 与审计） */
  reason: string
}

/** `MEMORY_MERGED` 的 payload（计划书第 75–78 节的合并结果） */
export interface MemoryMergedPayload {
  winnerId: string
  loserIds: string[]
  reason: string
}

/** `MEMORY_RESTORED` 的 payload（计划书第 70 节：先定义，M4 也实现） */
export interface MemoryRestoredPayload {
  memoryId: string
  reason: string
}

function requireString(payload: unknown, field: string): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`payload 必须是对象（缺 ${field}）`)
  }
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`)
  }
  return value
}

function requireFiniteNumber(payload: unknown, field: string): number {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`payload 必须是对象（缺 ${field}）`)
  }
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数字`)
  }
  return value
}

function requireStringArray(payload: unknown, field: string): string[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`payload 必须是对象（缺 ${field}）`)
  }
  const value = (payload as Record<string, unknown>)[field]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${field} 必须是字符串数组`)
  }
  return value as string[]
}

/**
 * 校验 `MEMORY_CREATED` 的 record 快照。
 *
 * 只检查**重建所必需**的字段（id / owner / type / content / subjects /
 * status / 时间 / 指纹）。刻意不做全字段深度校验：
 * 那是 `MemoryMutationValidator` 的职责，而它跑在**事务之前**；
 * 放在这里会让"payload 不合法"与"业务规则不通过"变成同一个错误码，
 * 而这两件事一个该重试、一个不该。
 */
function validateMemoryRecordSnapshot(value: unknown): MemoryRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error('MEMORY_CREATED 的 record 必须是对象')
  }
  const record = value as Record<string, unknown>
  // ⚠️ 字段名必须与 `MemoryRecord` 契约一致（这里是 `type`，不是 `memoryType`）。
  // 第一版写错了一次，症状是**每一条候选都被拒**、错误信息说
  // "record.memoryType 必须是非空字符串" —— 而那个字段在契约里压根不存在。
  // 这类缺陷的危险之处在于它"看起来像业务规则拒绝"，很容易被误读成
  // "策略太严"，从而去调策略而不是修字段名。
  for (const field of ['id', 'type', 'status', 'contentFingerprint'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      throw new Error(`record.${field} 必须是非空字符串`)
    }
  }
  if (typeof record.owner !== 'object' || record.owner === null) {
    throw new Error('record.owner 必须是 EntityRef')
  }
  if (!Array.isArray(record.subjects) || record.subjects.length === 0) {
    throw new Error('record.subjects 必须是非空数组（一条记忆至少讲一件事）')
  }
  if (!Array.isArray(record.sourceRefs) || record.sourceRefs.length === 0) {
    throw new Error('record.sourceRefs 必须非空（MI-03：Memory 必须存在 Evidence）')
  }
  if (!Array.isArray(record.evidenceRootIds) || record.evidenceRootIds.length === 0) {
    throw new Error('record.evidenceRootIds 必须非空（计划书第 40 节）')
  }
  if (typeof record.revision !== 'number' || !Number.isFinite(record.revision)) {
    throw new Error('record.revision 必须是有限数字')
  }
  return value as MemoryRecord
}

/**
 * Memory 领域事件的登记表。
 *
 * ============================================================================
 *  为什么是**独立的**工厂，而不是往 createDefaultDomainEventRegistry() 里塞
 * ============================================================================
 * `scripts/kernel-tests.ts` 的断言建立在"默认表 = M2.5 最小诊断集"这个语义上
 * （它拿默认 registry 验"未登记的类型被拒"）。
 * 往默认表里加六个类型**不改变那条断言的真值**，但会让那个语义漂移 ——
 * 而 M2.5/M3 的回归套件正建立在它上面。
 *
 * 因此 M4 提供自己的工厂，装配层按需组合
 * （`initKernel` 的 `registry` 选项，见 `docs/m4/compatibility-audit.md` §3 A1）。
 * 好处是"默认行为逐字节不变"变成结构上的事实，而不是一句承诺。
 */
export function createMemoryDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()

  registry.register<MemoryCreatedPayload>({
    type: MEMORY_CREATED,
    description:
      '一条长期记忆被建立。payload 携带首版完整快照，因为 rebuildMemory 必须能从事件从零建出记录',
    // 带完整快照，因此上限刻意放大到 32 KiB（其余类型沿用 4 KiB 兜底）
    maxPayloadBytes: 32768,
    validatePayload: (payload) => {
      const memoryId = requireString(payload, 'memoryId')
      const mutation = requireString(payload, 'mutation')
      if (mutation !== 'explicit' && mutation !== 'background') {
        throw new Error(`memoryId 的 mutation 必须是 explicit / background，收到 ${mutation}`)
      }
      const record = validateMemoryRecordSnapshot((payload as Record<string, unknown>).record)
      /*
       * 复活形标记（M9.1 / ADR-072 D02）：可选字段，存在即校验形状并**放行**。
       * ⚠️ 这里历史上只重建契约内字段（未知字段被剥离）——放行必须显式写；
       *    旧代码没有这段 ⇒ 同一 payload 在旧代码下剥离标记 ⇒ 重放为 no-op
       *    （回滚兼容的发射侧半边；存储侧半边见 appendDomainEvent 原样落库）。
       */
      const rawRestatement = (payload as Record<string, unknown>).restatement
      if (rawRestatement === undefined) {
        // 只取契约内的字段：多出来的由 payload 上限拦截，
        // 这样"太大"与"不合法"是两个可区分的拒绝码（沿用诊断信号的做法）。
        return { memoryId, record, mutation: mutation as MemoryMutationSource } satisfies MemoryCreatedPayload
      }
      if (typeof rawRestatement !== 'object' || rawRestatement === null) {
        throw new Error('restatement 必须是对象（M9.1 复活标记）')
      }
      const previousRevision = requireFiniteNumber(rawRestatement, 'previousRevision')
      if (!Number.isInteger(previousRevision) || previousRevision < 1) {
        throw new Error(`restatement.previousRevision 必须是 ≥1 的整数，收到 ${String(previousRevision)}`)
      }
      const previousStatus = requireString(rawRestatement, 'previousStatus')
      if (previousStatus !== 'retracted' && previousStatus !== 'superseded') {
        throw new Error(`restatement.previousStatus 必须是 retracted / superseded，收到 ${previousStatus}（DISPUTED 不自动复活——ADR-072 D10）`)
      }
      return {
        memoryId,
        record,
        mutation: mutation as MemoryMutationSource,
        restatement: { previousRevision, previousStatus: previousStatus as MemoryCreatedRestatement['previousStatus'] },
      } satisfies MemoryCreatedPayload
    },
  })

  registry.register<MemorySupersededPayload>({
    type: MEMORY_SUPERSEDED,
    description:
      '旧事实被新状态取代（当时可能是真的）。与 RETRACTED 的区别见计划书第 84 节',
    maxPayloadBytes: 4096,
    validatePayload: (payload) =>
      ({
        memoryId: requireString(payload, 'memoryId'),
        supersededBy: requireString(payload, 'supersededBy'),
        validUntil: requireFiniteNumber(payload, 'validUntil'),
        reason: requireString(payload, 'reason'),
      }) satisfies MemorySupersededPayload,
  })

  registry.register<MemoryRetractedPayload>({
    type: MEMORY_RETRACTED,
    description:
      '这条认知本身被判定错误或不应保留。默认不得再进入 M5 Recall（计划书第 32 节）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => {
      const memoryId = requireString(payload, 'memoryId')
      const reason = requireString(payload, 'reason')
      const allowed = ['explicit_forget', 'explicit_correction', 'audit']
      if (!allowed.includes(reason)) {
        throw new Error(`MEMORY_RETRACTED 的 reason 必须是 ${allowed.join(' / ')}，收到 ${reason}`)
      }
      const note = (payload as Record<string, unknown>).note
      return {
        memoryId,
        reason: reason as MemoryRetractedPayload['reason'],
        ...(typeof note === 'string' ? { note } : {}),
      } satisfies MemoryRetractedPayload
    },
  })

  registry.register<MemoryDisputedPayload>({
    type: MEMORY_DISPUTED,
    description:
      '存在矛盾证据而系统还判不了（计划书第 33 / 82 节）。不擅自选一个，也不粗暴覆盖',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => ({
      memoryId: requireString(payload, 'memoryId'),
      conflictingMemoryIds: requireStringArray(payload, 'conflictingMemoryIds'),
      reason: requireString(payload, 'reason'),
    }) satisfies MemoryDisputedPayload,
  })

  registry.register<MemoryMergedPayload>({
    type: MEMORY_MERGED,
    description: '多条同义记忆合成一条。败者留痕（SUPERSEDED）而不是删除（MI-06）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => {
      const winnerId = requireString(payload, 'winnerId')
      const loserIds = requireStringArray(payload, 'loserIds')
      if (loserIds.length === 0) {
        throw new Error('MEMORY_MERGED 必须至少有一个 loser：没有败者的"合并"其实是创建')
      }
      return {
        winnerId,
        loserIds,
        reason: requireString(payload, 'reason'),
      } satisfies MemoryMergedPayload
    },
  })

  registry.register<MemoryRestoredPayload>({
    type: MEMORY_RESTORED,
    description:
      '把一条 SUPERSEDED / RETRACTED / DISPUTED 的记忆恢复到 ACTIVE（计划书第 70 节）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => ({
      memoryId: requireString(payload, 'memoryId'),
      reason: requireString(payload, 'reason'),
    }) satisfies MemoryRestoredPayload,
  })

  return registry
}

/**
 * 诊断 + Memory + Relationship 的组合登记表（**装配层用**）。
 *
 * 生产代码走这个；测试按需选择"只要诊断"（复现 M2.5 行为）、
 * "只要 Memory"（M4 链路）或"只要 Relationship"（M7 链路）。
 *
 * WP4 起关系类型进全量登记表（此前 WP2 只登记不接线——Reducer/Validator
 * 落地后才有产出者，装配在本步完成）。M8 同序：AFFECT_* 已有独立工厂
 * `createAffectDomainEventRegistry()`，**WP4 起接入本表**（WP2 只登记不接线，
 * 与 M7 的可审计分步同构——判据在 WP4 证据里翻转）。M9 同序：BELIEF_*
 * 的独立工厂 `createBeliefDomainEventRegistry()`（WP2 登记）**WP4 起接入
 * 本表**（Reducer/Validator/Store 本步落地）。
 */
export function createFullDomainEventRegistry(): DomainEventRegistry {
  const registry = createDefaultDomainEventRegistry()
  const memory = createMemoryDomainEventRegistry()
  for (const type of memory.types()) {
    registry.register(memory.get(type)!)
  }
  const relationship = createRelationshipDomainEventRegistry()
  for (const type of relationship.types()) {
    registry.register(relationship.get(type)!)
  }
  const affect = createAffectDomainEventRegistry()
  for (const type of affect.types()) {
    registry.register(affect.get(type)!)
  }
  const belief = createBeliefDomainEventRegistry()
  for (const type of belief.types()) {
    registry.register(belief.get(type)!)
  }
  const goal = createGoalDomainEventRegistry()
  for (const type of goal.types()) {
    registry.register(goal.get(type)!)
  }
  /*
   * M11 / WP4（ADR-085 §4.2）：反思域**接线**。
   *
   * ⚠️ 与 M7/M8/M9 的注释同一条纪律：WP2 只登记形状，**WP4 起接入本表**
   *    （现在 Reducer 与放行口都落地了，装配在本步完成）。
   */
  const reflection = createReflectionDomainEventRegistry()
  for (const type of reflection.types()) {
    registry.register(reflection.get(type)!)
  }
  /*
   * S8 / ADR-093 `D12`：故事体验的**认知使用资格撤回**（内部事件）。
   *
   * ⚠️ 它**不**碰世界账本：撤回是**读时**判定（`findStoryEvents` 每次查撤回集合），
   *    因此 replay / rebuild / 换进程都绕不过去 —— 删行做不到这一点。
   */
  const story = createStoryDomainEventRegistry()
  for (const type of story.types()) {
    registry.register(story.get(type)!)
  }
  return registry
}

/**
 * **S8 / ADR-093 `D12`**：故事域的独立工厂（与反思域逐字同构）。
 *
 * payload 的结构校验在 `story-events.ts`（一个概念一处实现）。
 */
export function createStoryDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()
  registry.register<StoryExperienceRetractedPayload>({
    type: STORY_EXPERIENCE_RETRACTED,
    description:
      '撤回一段已提交故事经历的**认知使用资格**（ADR-093 D12）：读时判定、不物理删除世界历史、replay 不能绕过。',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateStoryExperienceRetractedPayload(payload),
  })
  return registry
}

// ---------------------------------------------------------------------------
// M11：Reflection Domain Events（ADR-085 §4.2；WP4 接线）
// ---------------------------------------------------------------------------

/**
 * 反思域的独立工厂（与 Belief / Goal 逐字同构）。
 *
 * payload 的结构校验在 `reflection-events.ts`（一个概念一处实现）；
 * 业务规则（门槛 / 来源资格 / 重复审查 / 状态机）在
 * `policies/reflection-validator.ts`（**唯一**放行口）。
 */
export function createReflectionDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()

  registry.register<ReflectionOriginPayload>({
    type: REFLECTION_ORIGIN,
    description:
      '反思域首次建立的 cutover 标记（ADR-085 D33：结构性，**不回填历史**）。payload 只有激活标识、序号边界与策略版本。',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateReflectionOriginPayload(payload),
  })
  registry.register<ReflectionProposedPayload>({
    type: REFLECTION_PROPOSED,
    description:
      '一条反思**候选**落库（状态 pending —— 候选不等于采纳，ADR-085 D03/D28）。payload 携带草案内容、**程序解析**的原始根与生成版本。',
    maxPayloadBytes: 16384,
    validatePayload: (payload) => validateReflectionProposedPayload(payload),
  })
  registry.register<ReflectionReviewedPayload>({
    type: REFLECTION_REVIEWED,
    description:
      '审查结论（accepted / rejected + 具名理由码）。一条结论一条事件，**不**拆成两套并行生命周期。',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateReflectionReviewedPayload(payload),
  })
  registry.register<ReflectionInvalidatedPayload>({
    type: REFLECTION_INVALIDATED,
    description:
      '反思失效（源被遗忘 / 撤回 / 版本漂移）。append-only：旧记录保留，因果可查（ADR-085 D11）。',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateReflectionInvalidatedPayload(payload),
  })
  registry.register<AdaptiveSelfRevisedPayload>({
    type: ADAPTIVE_SELF_REVISED,
    description:
      '行为槽版本变化（WP5 接线）。只承载通过放行的合法变化：slot / level / revision / 根 / 理由。',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateAdaptiveSelfRevisedPayload(payload),
  })

  return registry
}

// ---------------------------------------------------------------------------
// M7：Relationship Domain Events（ADR-064；本文件头注释预告过的登记位）
// ---------------------------------------------------------------------------

/**
 * 与 Memory 同一个模式：类型常量 + payload 契约 + 独立工厂。
 *
 * WP2 只登记不接线；**WP4 起接入 `createFullDomainEventRegistry()`**
 * （Reducer/Validator 落地、评估器成为产出者之后，装配在本步完成）。
 *
 * payload 的结构校验在 `relationship.ts`（一个概念一处实现）；
 * 业务规则（证据资格 / 界 / 建档存在性 / 取代链）在
 * `policies/relationship-validator.ts`（WP4 的唯一放行口）。
 */
export const RELATIONSHIP_ORIGIN = 'RELATIONSHIP_ORIGIN' as const
export const RELATIONSHIP_IMPACT = 'RELATIONSHIP_IMPACT' as const

/** M7 登记的全部 Relationship 领域事件类型 */
export const RELATIONSHIP_DOMAIN_EVENT_TYPES: readonly string[] = [RELATIONSHIP_ORIGIN, RELATIONSHIP_IMPACT]

/** Relationship 领域事件的登记表（独立工厂——理由与 Memory 的完全同构） */
export function createRelationshipDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()

  registry.register<RelationshipOriginPayload>({
    type: RELATIONSHIP_ORIGIN,
    description:
      '关系建档：为一条 owner→target 关系建立带来源的基线（ADR-064 D-2/U-M7-02）。' +
      '一条关系只允许一个 ORIGIN；基线值必须带 basis 说明（是设定/推导，不是经历）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateRelationshipOriginPayload(payload),
  })

  registry.register<RelationshipImpactPayload>({
    type: RELATIONSHIP_IMPACT,
    description:
      '一次有界的关系变化（|Δtrust|≤0.05 · |Δcloseness|≤0.03；ADR-064 D-2）。' +
      '必须引用 ESTABLISHED 资格的用户直接互动事件（D-3 Tier 1）；' +
      '纠正/撤回经 supersedes 链接旧 IMPACT（计划 §6 场景 11），旧事件不物理删除',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateRelationshipImpactPayload(payload),
  })

  return registry
}

// ---------------------------------------------------------------------------
// M8：Affect Domain Events（ADR-066；与 Memory/Relationship 同一个模式）
// ---------------------------------------------------------------------------

/**
 * 类型常量 + payload 契约 + 独立工厂（与 Memory / Relationship 完全同构）。
 *
 * WP2 登记；**WP4 起接入 `createFullDomainEventRegistry()`**。
 *
 * payload 的结构校验在 `affect.ts`（一个概念一处实现）；
 * 业务规则（证据资格 / 界 / 建档存在性 / cutover）在
 * `policies/affect-validator.ts`（WP3 的唯一放行口）。
 */
export const AFFECT_ORIGIN = 'AFFECT_ORIGIN' as const
export const AFFECT_TOUCH = 'AFFECT_TOUCH' as const
export const AFFECT_IMPACT = 'AFFECT_IMPACT' as const

/** M8 登记的全部 Affect 领域事件类型 */
export const AFFECT_DOMAIN_EVENT_TYPES: readonly string[] = [
  AFFECT_ORIGIN,
  AFFECT_TOUCH,
  AFFECT_IMPACT,
]

/** Affect 领域事件的登记表（独立工厂——理由与 Memory 的完全同构） */
export function createAffectDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()

  registry.register<AffectOriginPayload>({
    type: AFFECT_ORIGIN,
    description:
      '情绪建档：为 Character 建立中性起点（valence=0/arousal=0；ADR-066 M8-D06）' +
      '并记录切换边界 cutoverSequence（M8-D05：切换前历史不重放）。' +
      '一个 Character 只允许一个 ORIGIN',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateAffectOriginPayload(payload),
  })

  registry.register<AffectTouchPayload>({
    type: AFFECT_TOUCH,
    description:
      '合格用户交互已消费：刷新交互锚点，delta 恒为零（ADR-066 M8-D07）。' +
      '中性对话不应被误判成未处理；read-time decay 需要明确的锚点',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateAffectTouchPayload(payload),
  })

  registry.register<AffectImpactPayload>({
    type: AFFECT_IMPACT,
    description:
      '一次有界的主导情绪变化（|Δ|≤0.25；ADR-066 §4.1 冻结规则表 affect-rules@1）。' +
      '必须引用 ESTABLISHED 资格的 active user 直接互动事件（§3）；' +
      '一次用户事件至多一条主导 IMPACT，不做多规则叠加（M8-D08）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateAffectImpactPayload(payload),
  })

  return registry
}

// ---------------------------------------------------------------------------
// M9：Belief Domain Events（ADR-070；与 Memory/Relationship/Affect 同一个模式）
// ---------------------------------------------------------------------------

/**
 * 类型常量 + payload 契约 + 独立工厂（与 Memory / Relationship / Affect 完全同构）。
 *
 * WP2 登记；**WP4 起接入 `createFullDomainEventRegistry()`**（Reducer/Validator
 * 落地、评估器/协调器成为产出者之后，装配在本步完成——M7/M8 的可审计分步）。
 *
 * payload 的结构校验在 `belief.ts`（一个概念一处实现）；
 * 业务规则（证据资格 / 槽位冲突 / 建档存在性 / forbiddenRootIds /
 * cutover / supersedes 链）在 `policies/belief-validator.ts`（WP4 的唯一放行口）。
 *
 * INV-M9-07 结构性继承：`DomainEvent.scope` 是 `'CHARACTER_INTERNAL'` 字面量
 * 类型——BELIEF_* 事件在编译期就写不出 WORLD scope。
 */
export const BELIEF_ORIGIN = 'BELIEF_ORIGIN' as const
export const BELIEF_EVIDENCE_NOTED = 'BELIEF_EVIDENCE_NOTED' as const
export const BELIEF_FORMED = 'BELIEF_FORMED' as const
export const BELIEF_REINFORCED = 'BELIEF_REINFORCED' as const
export const BELIEF_DISPUTED = 'BELIEF_DISPUTED' as const
export const BELIEF_SUPERSEDED = 'BELIEF_SUPERSEDED' as const
export const BELIEF_RETRACTED = 'BELIEF_RETRACTED' as const

/** M9 登记的全部 Belief 领域事件类型 */
export const BELIEF_DOMAIN_EVENT_TYPES: readonly string[] = [
  BELIEF_ORIGIN,
  BELIEF_EVIDENCE_NOTED,
  BELIEF_FORMED,
  BELIEF_REINFORCED,
  BELIEF_DISPUTED,
  BELIEF_SUPERSEDED,
  BELIEF_RETRACTED,
]

/** Belief 领域事件的登记表（独立工厂——理由与 Memory 的完全同构） */
export function createBeliefDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()

  registry.register<BeliefOriginPayload>({
    type: BELIEF_ORIGIN,
    description:
      '信念建档：为 Character 建立空起点与切换边界（ADR-070 D12：不复制旧人格/' +
      '旧情绪为初始信念，不回扫旧对话）。一个 Character 只允许一个 ORIGIN；' +
      'cutoverSequence 之前的输入不合格（D05 不重放历史的 Belief 版）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateBeliefOriginPayload(payload),
  })

  registry.register<BeliefEvidenceNotedPayload>({
    type: BELIEF_EVIDENCE_NOTED,
    description:
      '一个合格的待累计互动证据引用（ADR-070 §4.2）：只表示"这根线索被看见"，' +
      '不表示已形成信念；冻结为真实事件（可重放、跨页累计零丢失）。' +
      '同根重复/摘要复述不能多计（INV-M9-04/08）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateBeliefEvidenceNotedPayload(payload),
  })

  registry.register<BeliefFormedPayload>({
    type: BELIEF_FORMED,
    description:
      '依据满足形成条件，新建一条带来源判断（ADR-070 §4.2）。' +
      'B-REPORTED 从白名单 Memory（D04）；B-INFERRED 达冻结阈值（D06：' +
      '≥3 独立根 · 跨 ≥2 会话）且永远 tentative（D05/D08）。' +
      'epistemicKind 由程序推导，提案不能自报提升（INV-M9-03）',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateBeliefFormedPayload(payload),
  })

  registry.register<BeliefReinforcedPayload>({
    type: BELIEF_REINFORCED,
    description:
      '增加真正独立的合格支持（ADR-070 §4.2）：去重后必须非空——' +
      '同一输入重复处理不能增加支持（INV-M9-08）；类型上限不变（不升级 reported）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateBeliefReinforcedPayload(payload),
  })

  registry.register<BeliefDisputedPayload>({
    type: BELIEF_DISPUTED,
    description:
      '同槽位同时间互斥且无法排序 ⇒ 争议态，保留冲突两侧（ADR-070 §4.2）。' +
      '不投票、不用亲密度/情绪决胜（D09/D11）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateBeliefDisputedPayload(payload),
  })

  registry.register<BeliefSupersededPayload>({
    type: BELIEF_SUPERSEDED,
    description:
      '用新的当前判断取代旧条（ADR-070 §4.2）：old/new 因果链完整，' +
      '旧事件不物理删除、不 UPDATE 历史 payload（INV-M9-11）；' +
      '保留过去有效期（时间三分离）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateBeliefSupersededPayload(payload),
  })

  registry.register<BeliefRetractedPayload>({
    type: BELIEF_RETRACTED,
    description:
      '撤回/失效/遗忘引起的停止采信（ADR-070 §4.2 + §5.4 遗忘契约）。' +
      'forbiddenRootIds = 本次失效禁止再用的根集合：同槽位新提案根集合' +
      '与之相交即被拒绝——raw-event 推断不能绕道复活（B28）；' +
      '重放旧证据不复活（retracted 保持）',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateBeliefRetractedPayload(payload),
  })

  return registry
}

// ---------------------------------------------------------------------------
// M10：Goal / Commitment Domain Events（ADR-076；与 Memory/Relationship/Affect/Belief 同一个模式）
// ---------------------------------------------------------------------------

/**
 * 类型常量 + payload 契约 + 独立工厂（与前四域完全同构）。
 *
 * ⚠️ **没有 `GOAL_ORIGIN`**（ADR-076 `D23`）：cutover 在本域是**结构性**的
 *    ——Goal 只在当轮合法请求上创建，v1 没有任何按窗口扫描会话历史的路径。
 *    绊线：若某个 WP 引入窗口扫描，必须同时追加 `GOAL_ORIGIN` + 重放守卫 + 新 ADR。
 *
 * payload 的结构校验在 `goal.ts`（一个概念一处实现）；
 * 业务规则（身份派生 / 转换表 / expectedRevision / 幂等 / 来源资格）在
 * `policies/goal-validator.ts`（WP3 的唯一放行口）。
 */
export const GOAL_CREATED = 'GOAL_CREATED' as const
export const GOAL_REVISED = 'GOAL_REVISED' as const
export const GOAL_PAUSED = 'GOAL_PAUSED' as const
export const GOAL_RESUMED = 'GOAL_RESUMED' as const
export const GOAL_BLOCKED = 'GOAL_BLOCKED' as const
export const GOAL_COMPLETED = 'GOAL_COMPLETED' as const
export const GOAL_CANCELLED = 'GOAL_CANCELLED' as const
export const GOAL_SUPERSEDED = 'GOAL_SUPERSEDED' as const
export const COMMITMENT_ACCEPTED = 'COMMITMENT_ACCEPTED' as const
export const COMMITMENT_FULFILLED = 'COMMITMENT_FULFILLED' as const
export const COMMITMENT_BROKEN = 'COMMITMENT_BROKEN' as const
export const COMMITMENT_CANCELLED = 'COMMITMENT_CANCELLED' as const
export const COMMITMENT_SUPERSEDED = 'COMMITMENT_SUPERSEDED' as const
/** M10.1 追加（ADR-086 `D07`）：**到期** —— 时间事实，不是失约指控 */
export const COMMITMENT_EXPIRED = 'COMMITMENT_EXPIRED' as const

/** M10 登记的全部 Goal / Commitment 领域事件类型（14 个：8 目标 + 6 承诺；`COMMITMENT_EXPIRED` 是 M10.1 追加） */
export const GOAL_DOMAIN_EVENT_TYPES: readonly string[] = [
  GOAL_CREATED,
  GOAL_REVISED,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_BLOCKED,
  GOAL_COMPLETED,
  GOAL_CANCELLED,
  GOAL_SUPERSEDED,
  COMMITMENT_ACCEPTED,
  COMMITMENT_FULFILLED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_SUPERSEDED,
  COMMITMENT_EXPIRED,
]

/** Goal 事件的登记表（独立工厂——理由与 Memory/Belief 的完全同构） */
export function createGoalDomainEventRegistry(): DomainEventRegistry {
  const registry = new DomainEventRegistry()

  registry.register<GoalCreatedPayload>({
    type: GOAL_CREATED,
    description:
      '一个协作目标被受理并建立（ADR-076 §4.1）。payload 携带**首版完整快照**，' +
      '因为 rebuild 必须能从事件从零建出记录；`mutation` v1 恒为 explicit',
    maxPayloadBytes: 16384,
    validatePayload: (payload) => validateGoalCreatedPayload(payload),
  })

  registry.register<GoalRevisedPayload>({
    type: GOAL_REVISED,
    description:
      '小改（措辞 / 优先级 / 当前步骤 / 依赖背景）——**不改**对象与成功条件，' +
      '因此 revision +1 而身份不变（ADR-076 §4.4）。' +
      '改对象 / 截止义务 / 成功条件必须走 GOAL_SUPERSEDED + 新身份',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateGoalRevisedPayload(payload),
  })

  registry.register<GoalPausedPayload>({
    type: GOAL_PAUSED,
    description: '用户明确暂停（ADR-076 §4.4）。暂停期不得继续执行该目标的步骤',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateGoalPausedPayload(payload),
  })

  registry.register<GoalResumedPayload>({
    type: GOAL_RESUMED,
    description:
      '用户明确恢复**且**依赖复核通过（ADR-076 §4.4）。' +
      'payload 必须带复核读数（hard/soft/dropped 计数）——' +
      '"不得因索引恢复就静默继续"这一点因此可被事后核对',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateGoalResumedPayload(payload),
  })

  registry.register<GoalBlockedPayload>({
    type: GOAL_BLOCKED,
    description:
      '必要前提失效 / 能力不满足 / 需要修订（ADR-076 §4.6）。' +
      '保留原状态与具名原因；原因**不得**含被忘取值（§5 第 1 条）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateGoalBlockedPayload(payload),
  })

  registry.register<GoalCompletedPayload>({
    type: GOAL_COMPLETED,
    description:
      '合格完成证据满足当前 revision 的 criterion（ADR-076 §4.5）。' +
      '依据准入是**一对一**（basis === criterion.kind）；' +
      '`user_report` 可以结束用户自己的目标，但**不**证明角色外部履约',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateGoalCompletedPayload(payload),
  })

  registry.register<GoalCancelledPayload>({
    type: GOAL_CANCELLED,
    description:
      '用户取消 / 免除（user_waived）/ 明确遗忘 / 根证据被撤（ADR-076 §4.4 + §5）。' +
      '`explicit_forget` 时 `forbiddenSourceEventIds` 必须非空：' +
      '旧根禁用不因内容再次出现而解除（复用 M9 的 B28 机制）',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateGoalCancelledPayload(payload),
  })

  registry.register<GoalSupersededPayload>({
    type: GOAL_SUPERSEDED,
    description:
      '实质改变目标（对象 / 截止义务 / 成功条件）⇒ 旧项终态 + 新身份，' +
      '关联操作原子提交（ADR-076 §4.4）。' +
      '不得用自由文本覆盖抹掉"曾经答应过什么"',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateGoalSupersededPayload(payload),
  })

  registry.register<CommitmentAcceptedPayload>({
    type: COMMITMENT_ACCEPTED,
    description:
      '一次**正式承担**被受理（ADR-076 §4.2）：必须有受理证据与能力检查。' +
      '一个 Goal 当前至多一个非终态承诺——再来一次普通 accept 由放行口拒绝',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateCommitmentAcceptedPayload(payload),
  })

  registry.register<CommitmentFulfilledPayload>({
    type: COMMITMENT_FULFILLED,
    description:
      '当前 revision 的**可验证**兑现证据（ADR-076 §4.5）。' +
      '`resultRefs` 必须非空；`partial` / `timeout` / `accepted=true` **都不能**代替它',
    maxPayloadBytes: 8192,
    validatePayload: (payload) => validateCommitmentFulfilledPayload(payload),
  })

  registry.register<CommitmentBrokenPayload>({
    type: COMMITMENT_BROKEN,
    description:
      '有可判定的承诺规则**且**有违反证据（ADR-076 §4.2）。' +
      '禁止把 timeout / unknown / 用户暂未回复自动等同 broken —— ' +
      '`violationRefs` 与 `ruleId` 因此都是必填',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateCommitmentBrokenPayload(payload),
  })

  registry.register<CommitmentCancelledPayload>({
    type: COMMITMENT_CANCELLED,
    description:
      '明确撤销约定；Goal 被取消时其 active 承诺在**同一操作**中取消' +
      '（ADR-076 §4.2：不得留下"已取消目标仍被履行"的孤儿约定）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateCommitmentCancelledPayload(payload),
  })

  registry.register<CommitmentSupersededPayload>({
    type: COMMITMENT_SUPERSEDED,
    description:
      '双方明确重新约定，旧约定被替代（ADR-076 §4.2）：旧项终态 + 新身份，' +
      '拒绝"就地改写"（那样会抹掉曾经承担过什么）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateCommitmentSupersededPayload(payload),
  })

  /*
   * ⚠️ **M10.1 追加**（ADR-086 `D07`）：到期。
   *    description 里**刻意不写**"失约/违约"这类词 —— 到期是**时间事实**；
   *    要指控必须走 `COMMITMENT_BROKEN`（它要求可判定规则 + 违反证据）。
   */
  registry.register<CommitmentExpiredPayload>({
    type: COMMITMENT_EXPIRED,
    description:
      '约定**到期**：截止时间已过而未见达成（M10.1 / ADR-086 D07）。' +
      '这是**时间事实**、**不是**失约指控——载荷里没有 reason / violationRuleId，' +
      '`basis` 是闭集（只有 `due_at_passed`）',
    maxPayloadBytes: 4096,
    validatePayload: (payload) => validateCommitmentExpiredPayload(payload),
  })

  return registry
}
