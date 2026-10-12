/**
 * RelationshipEvaluationJob —— 关系评估的任务化编排（M7 WP4 / ADR-064）。
 *
 * ============================================================================
 *  复用 M2.5 的 Job 体系（与 memory job 同一条纪律）
 * ============================================================================
 *     triggerKind = conversation · 输入 = source event range
 *     不新建任务表：`character_jobs` / `processed_operations` /
 *     `processor_watermarks` 照用（WP4 交接单更正：**零新迁移**）。
 *
 * 编排链（本文件只做装配，不做判断——判断在评估器与 Validator）：
 *
 *     窗口事件 → ProcessorEventView → 评估器提案 → Validator 放行
 *     → applyAcceptedEvents（事务：append + 幂等 + 纯折叠 + 乐观锁）
 *
 * 两条硬纪律：
 *   · **REJECT 是正常结果**（计划书第 50 节）：被拒提案记录在案、不重试、
 *     不让整批失败——同一窗口里合法提案照常落库；
 *   · **证据查找用窗口内事件**（内存适配）：评估器只引用窗口内事件，
 *     引用窗外 = 查不到 = `source_event_missing` 失败关闭——这正是想要的行为。
 *
 * 水位推进（补洞不取最大值）与 memory job 同构：`advanceWatermarkToContiguous`
 * 的实现归装配层（job-store）；本层只声明端口形状。
 */
import {
  computeIdempotencyKey,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type DomainEventId,
  type DomainEventRegistry,
  type EntityRelationKey,
  type ProcessorContext,
  type ProcessorEventView,
} from '../../contracts/index.ts'
import { entityRef, type EntityRef } from '../../contracts/entity.ts'
import type { ProjectionReducer } from '../../contracts/projection.ts'
import type { RelationshipImpactPayload, RelationshipState } from '../../contracts/relationship.ts'
import { processorEventViewOf } from '../memory/extractor.ts'
import type { AcceptedDomainEvent } from '../../policies/validator.ts'
import { validateRelationshipProposal } from '../../policies/relationship-validator.ts'
import { relationshipReducerFor } from '../../projections/relationship.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
  RuleBasedRelationshipEvaluator,
  qualifiedEvidenceGroups,
  type RelationshipEvaluationInput,
  type RelationshipMilestoneCounters,
  type RelationshipProposalAudit,
} from './evaluator.ts'
import type { DomainProposal } from '../../contracts/proposal.ts'

export const RELATIONSHIP_JOB_TRIGGER_KIND = 'conversation' as const

/** Job 级幂等键的操作分量（事件级键的领域推导在 Validator，不在 Job） */
export const RELATIONSHIP_JOB_OPERATION = 'relationship-evaluation' as const

/**
 * 关系评估任务的幂等键（**区间键**，与 `memoryExtractionIdempotencyKey` 同构）：
 * 后台评估一次处理一段事件区间，整批是一个工作单元——
 * 重复排期同一区间被 `character_jobs` 的部分唯一索引挡住。
 * 事件级的键（r1 按日 / r2-r5 按窗口）由 Validator 用
 * `idempotencyKeyForRelationshipEvent` 另行推导——两层键各管各的重复。
 */
export function relationshipEvaluationIdempotencyKey(input: {
  characterId: CharacterId
  processor: string
  processorVersion: string
  sourceFromSequence: number
  sourceToSequence: number
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: input.sourceFromSequence,
    sourceToSequence: input.sourceToSequence,
    operation: RELATIONSHIP_JOB_OPERATION,
  })
}

// ---------------------------------------------------------------------------
// 端口（装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

export interface RelationshipApplyOutcome {
  /** 本次新建的域事件数（幂等命中时为 0） */
  createdCount: number
  /** 幂等命中数 */
  deduplicatedCount: number
  /** 因乱序被跳过的投影更新数（含"别的目标的事件"——per-target reducer 的正常跳过） */
  skippedStale: number
  projectionChanges: { projectionType: string; fromRevision: number; toRevision: number }[]
}

export interface RelationshipJobPorts {
  registry: DomainEventRegistry
  /** 读窗口事件（含归因信封；按 sequence 升序） */
  loadWindowEvents(
    characterId: CharacterId,
    fromSequence: number,
    toSequence: number
  ): Promise<ConversationEvent[]>
  /** 读关系投影状态（在案指控 + 建档判断） */
  getRelationshipState(
    characterId: CharacterId,
    key: EntityRelationKey
  ): Promise<RelationshipState | undefined>
  /** 读域事件（撤回链目标检查） */
  getDomainEvent(id: DomainEventId): Promise<{ id: DomainEventId; type: string } | undefined>
  /** 幂等查询 */
  hasProcessed(idempotencyKey: string): Promise<boolean>
  /** 落库（事务内：append + 幂等记录 + 纯折叠 + 乐观锁） */
  applyAccepted(
    characterId: CharacterId,
    accepted: readonly AcceptedDomainEvent[],
    reducers: readonly ProjectionReducer<unknown>[],
    now?: number
  ): Promise<RelationshipApplyOutcome>
  /** R-5 计数（账本派生；prior 用 from-1，after 用 to） */
  countQualifiedMessages(
    characterId: CharacterId,
    targetUserId: string,
    throughSequence: number
  ): Promise<number>
  countActiveDays(
    characterId: CharacterId,
    targetUserId: string,
    throughSequence: number
  ): Promise<number>
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

export interface RelationshipEvaluationRunInput {
  characterId: CharacterId
  /** 视角拥有者（关系键的 owner） */
  owner: EntityRef
  fromSequence: number
  toSequence: number
  now?: number
  /**
   * WP6 调度器的**试算模式**：只跑评估器数提案，不验证、不落库、不产生任何副作用。
   *
   * 用途："攒尾窗"策略需要先知道"这个窗口有没有规则会响"再决定是否消费
   * （零提案的小窗口若被消费，R-1 的 ≥10 条跨 2 日累积就永远攒不起来）。
   * 评估器是确定性纯函数 ⇒ 试算与正式跑产出**相同**提案集。
   */
  dryRun?: boolean
}

export interface RelationshipEvaluationRejection {
  proposalId: string
  code: string
  message: string
}

export interface RelationshipEvaluationOutcome {
  window: { fromSequence: number; toSequence: number }
  /** 评估器产出的提案总数 */
  proposals: number
  acceptedProposals: number
  rejectedProposals: number
  /** 被拒明细（REJECT 是正常结果——记录在案，不重试不炸批） */
  rejections: RelationshipEvaluationRejection[]
  /** 窗口内被跳过的 tool 事件数（L-M8-13 修复：跳过是可审计读数，不是静默丢弃） */
  skippedToolEvents: number
  applied: RelationshipApplyOutcome
}

/**
 * 跑一次关系评估窗口。
 *
 * 幂等性：同窗口重跑 → 评估器产出相同提案 → Validator 的领域幂等键命中
 * （r1 按日 / r2-r5 按窗口）→ 全部 duplicate → `createdCount = 0`。
 * 这是"重复失败关闭"的出口判据之一（ADR-064 §9）。
 */
export async function runRelationshipEvaluation(
  ports: RelationshipJobPorts,
  input: RelationshipEvaluationRunInput
): Promise<RelationshipEvaluationOutcome> {
  const now = input.now ?? Date.now()

  // ---- 窗口事件 → 视图（processorEventViewOf 是受信读数的唯一产出点，ADR-043 DR-6）----
  const events = await ports.loadWindowEvents(
    input.characterId,
    input.fromSequence,
    input.toSequence
  )
  /*
   * tool_event 在这里**跳过**（L-M8-13 修复，M9 WP0-R；形状 = M8 affect/job.ts 的同款修复）。
   *
   * `processorEventViewOf` 对 tool_event 失败关闭（M4 抽取器的输入边界），
   * 那是**记忆抽取**的纪律；关系评估复用该函数时必须自己处理第四种 actorType。
   * 若不跳过：窗口里出现一条 tool_event ⇒ 评估抛错 ⇒ 水位冻结 ⇒ 之后每个
   * 窗口都还含它 ⇒ **永久楔死**（M9 WP0 准入实验 E1b/E2a 复现；调度器侧
   * dry-run 在 try 之外，异常还会穿透"幂等且不抛"的契约——同文件调度器一并修）。
   * 跳过不放松任何保证：评估器本来就只认 user_message + ESTABLISHED +
   * KNOWN originator（M7-D 系），tool 事件在任何情况下都不可能成为证据；
   * 账本里它原样可查。
   */
  const skippedToolEvents = events.filter((event) => event.actorType === 'tool').length
  const views: ProcessorEventView[] = events
    .filter((event) => event.actorType !== 'tool')
    .map((event) => processorEventViewOf(event))

  // ---- 逐目标构建评估器输入（在案指控 + 里程碑计数，全部账本/投影派生）----
  const groups = qualifiedEvidenceGroups(views)
  const activeAccusations: Record<string, readonly DomainEventId[]> = {}
  const milestones: Record<string, RelationshipMilestoneCounters> = {}
  for (const group of groups) {
    const state = await ports.getRelationshipState(input.characterId, {
      owner: input.owner.id,
      target: group.targetUserId as EntityRelationKey['target'],
    })
    activeAccusations[group.targetUserId] =
      state !== undefined && state.originated
        ? state.accusationsInCase.map((a) => a.domainEventId)
        : []

    const [messagePrior, messageAfter, dayPrior, dayAfter] = await Promise.all([
      ports.countQualifiedMessages(input.characterId, group.targetUserId, input.fromSequence - 1),
      ports.countQualifiedMessages(input.characterId, group.targetUserId, input.toSequence),
      ports.countActiveDays(input.characterId, group.targetUserId, input.fromSequence - 1),
      ports.countActiveDays(input.characterId, group.targetUserId, input.toSequence),
    ])
    milestones[group.targetUserId] = {
      qualifiedMessageTotal: { prior: messagePrior, after: messageAfter },
      activeDayTotal: { prior: dayPrior, after: dayAfter },
    }
  }

  const evaluationInput: RelationshipEvaluationInput = {
    characterId: input.characterId,
    owner: input.owner,
    views,
    activeAccusations,
    milestones,
  }
  const context: ProcessorContext = {
    processorName: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
  }
  const evaluator = new RuleBasedRelationshipEvaluator()
  const proposals: DomainProposal<RelationshipProposalAudit>[] = await evaluator.process(
    evaluationInput,
    context
  )

  // ---- 试算出口（WP6 调度器）：到此为止，零副作用 ----
  if (input.dryRun === true) {
    return {
      window: { fromSequence: input.fromSequence, toSequence: input.toSequence },
      proposals: proposals.length,
      acceptedProposals: 0,
      rejectedProposals: 0,
      rejections: [],
      skippedToolEvents,
      applied: {
        createdCount: 0,
        deduplicatedCount: 0,
        skippedStale: 0,
        projectionChanges: [],
      },
    }
  }

  // ---- 逐提案放行（REJECT 是正常结果）----
  const evidenceLookup = {
    findEvents: async (ids: readonly ConversationEventId[]) => {
      const wanted = new Set(ids.map((id) => String(id)))
      return events
        .filter((event) => wanted.has(String(event.id)))
        .map((event) => {
          const view = processorEventViewOf(event)
          return {
            id: event.id,
            characterId: event.characterId,
            sequence: event.sequence,
            type: view.type,
            trustedOrigin: view.trustedOrigin,
          }
        })
    },
  }
  const validatorDeps = {
    registry: ports.registry,
    evidence: evidenceLookup,
    processed: { hasProcessed: (key: string) => ports.hasProcessed(key) },
    relationships: {
      getRelationshipState: (characterId: CharacterId, key: EntityRelationKey) =>
        ports.getRelationshipState(characterId, key),
    },
    events: { getDomainEvent: (id: DomainEventId) => ports.getDomainEvent(id) },
  }

  const acceptedEvents: AcceptedDomainEvent[] = []
  const rejections: RelationshipEvaluationRejection[] = []
  let acceptedProposals = 0
  for (const proposal of proposals) {
    const outcome = await validateRelationshipProposal(validatorDeps, proposal)
    if (outcome.accepted) {
      acceptedProposals += 1
      acceptedEvents.push(...outcome.acceptedEvents)
    } else {
      for (const rejected of outcome.rejected) {
        rejections.push({
          proposalId: proposal.proposalId,
          code: rejected.code,
          message: rejected.message,
        })
      }
    }
  }

  // ---- 落库：per-target reducer（isStale 跳过别人的事件——信封不前进）----
  const targetsById = new Map<string, EntityRef>()
  for (const accepted of acceptedEvents) {
    const payload = accepted.payload as RelationshipImpactPayload
    const targetId = String(payload.key.target)
    if (!targetsById.has(targetId)) {
      targetsById.set(targetId, entityRef('user', payload.key.target))
    }
  }
  const reducers = [...targetsById.values()].map((target) =>
    relationshipReducerFor(input.owner, target)
  )

  const applied = await ports.applyAccepted(
    input.characterId,
    acceptedEvents,
    reducers,
    now
  )

  return {
    window: { fromSequence: input.fromSequence, toSequence: input.toSequence },
    proposals: proposals.length,
    acceptedProposals,
    rejectedProposals: proposals.length - acceptedProposals,
    rejections,
    skippedToolEvents,
    applied,
  }
}
