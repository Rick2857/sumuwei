/**
 * BeliefEvaluationJob —— 信念双流的任务化编排（M9 WP6 / ADR-070 §6.3）。
 *
 * ============================================================================
 *  双流（ADR-070 §6.3：两条独立输入流，各自水位，互不阻塞）
 * ============================================================================
 *   流 1 `belief-interaction-evaluator`（对话事件 → B-INFERRED）：
 *     窗口事件 → ProcessorEventView → 评估器提案（EVIDENCE_NOTED/FORMED/
 *     REINFORCED）→ Validator 放行 → append + applyBeliefRows。
 *     与 affect job 同构：tool_event 跳过（楔死防御，M8-D04 同源）；
 *     证据查找用窗口内事件（引用窗外 = source_event_missing 失败关闭）。
 *
 *   流 2 `belief-memory-reconciler`（Memory 域事件 → B-REPORTED + 失效传播）：
 *     MEMORY_* 域事件窗口 → reconcileMemoryWindow（形成提案 + 失效触发）→
 *     planMemoryInvalidation（失效提案）→ Validator 放行 → append + fold。
 *     ⚠️ reported 的证据根是 Memory 的根（历史陈述，可在任何窗口之外）——
 *     这条流的 evidence 查找必须**按 id 查账本**，不是窗口内查找。
 *
 * ============================================================================
 *  两条硬纪律（与 memory / relationship / affect job 同源）
 * ============================================================================
 *   · **REJECT 是正常结果**：被拒提案记录在案、不重试、不让整批失败——
 *     同一窗口里合法提案照常落库；
 *   · **只产提案不写投影**：本层到 Validator 的 accepted 为止；
 *     append + applyBeliefRows 是装配层端口（belief 投影分片 + 证据行
 *     清零语义，走 belief-store 的专用折叠，不走通用 applyAcceptedEvents）。
 *
 * 依赖方向：app → contracts（本文件不 import 基础设施；端口由装配层注入）。
 */
import type {
  CharacterId,
  ConversationEvent,
  ConversationEventId,
  DomainEvent,
  DomainEventRegistry,
} from '../../contracts/index.ts'
import { processorEventViewOf } from '../memory/extractor.ts'
import type { AcceptedDomainEvent } from '../../policies/validator.ts'
import type { DomainProposal } from '../../contracts/proposal.ts'
import type { BeliefEvidenceAccumulation } from '../../contracts/belief.ts'
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_SCOPE,
  beliefSlotKeyOf,
  type BeliefOriginState,
  type BeliefState,
} from '../../contracts/belief.ts'
import type { EntityRef, PerspectiveOwnerId } from '../../contracts/entity.ts'
import type { TrustedOriginReading } from '../../contracts/attribution.ts'
import { validateBeliefProposal, type BeliefValidatorDeps } from '../../policies/belief-validator.ts'
import {
  BELIEF_INTERACTION_EVALUATOR_NAME,
  BELIEF_INTERACTION_EVALUATOR_VERSION,
  RuleBasedBeliefEvaluator,
  beliefEvidenceKeyOf,
  type BeliefAbstention,
} from './evaluator.ts'
import { reconcileMemoryWindow, type ReconcilerMemoryView } from './reconciler.ts'
import { planMemoryInvalidation, type BeliefRevisionDeps } from './revision.ts'

export const BELIEF_JOB_TRIGGER_KIND = 'conversation' as const

/** Job 级幂等键的操作分量（事件级键的领域推导在 Validator，不在 Job） */
export const BELIEF_INTERACTION_JOB_OPERATION = 'belief-interaction-evaluation' as const
export const BELIEF_MEMORY_JOB_OPERATION = 'belief-memory-reconciliation' as const

/** 流 2 的处理器身份（与 reconciler/revision 提案的 processor 同源——幂等键分量） */
export const BELIEF_MEMORY_RECONCILER_NAME = 'belief-memory-reconciler'
export const BELIEF_MEMORY_RECONCILER_VERSION = 'belief-memory-reconciler@1'

/** v1 冻结值域（评估器 patterns 的两条详略信号；扩大值域 = 新规则版本） */
const INFERRED_VALUES = ['detailed', 'concise'] as const

// ---------------------------------------------------------------------------
// 端口（装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

/** 信念域读侧（Validator deps + 评估器 slotState 的共同面） */
export interface BeliefStateLookupPort {
  getBeliefOrigin(characterId: CharacterId): Promise<BeliefOriginState | undefined>
  getBelief(characterId: CharacterId, beliefId: string): Promise<BeliefState | undefined>
  listActiveBeliefs(characterId: CharacterId): Promise<BeliefState[]>
  listActiveBeliefsForSlot(characterId: CharacterId, slotKey: string): Promise<BeliefState[]>
  forbiddenRootsForSlot(characterId: CharacterId, slotKey: string): Promise<string[]>
  getBeliefEvidence(
    characterId: CharacterId,
    evidenceKey: string,
  ): Promise<BeliefEvidenceAccumulation | undefined>
}

export interface BeliefApplyOutcome {
  /** 新建域事件数（幂等命中不计） */
  createdEvents: number
  /** append 幂等命中数（同单元重放） */
  deduplicated: number
  /** applyBeliefRows 折叠的事件数（= createdEvents） */
  appliedEvents: number
}

export interface BeliefJobPorts {
  registry: DomainEventRegistry
  /** 流 1：读对话事件窗口（含归因信封；按 sequence 升序） */
  loadWindowEvents(
    characterId: CharacterId,
    fromSequence: number,
    toSequence: number,
  ): Promise<ConversationEvent[]>
  /** 流 2：读 Memory 域事件窗口（按 domain sequence 升序；只含 MEMORY_*） */
  loadMemoryEvents(
    characterId: CharacterId,
    fromSequence: number,
    toSequence: number,
  ): Promise<DomainEvent[]>
  /** 流 2：按 id 批量读 Memory 当前状态（reconciler + validator 共用） */
  findMemories(ids: readonly string[]): Promise<ReconcilerMemoryView[]>
  /** 流 2：按 id 查对话账本（reported 的证据根 = Memory 的根，可在窗外） */
  findConversationEvents(
    ids: readonly ConversationEventId[],
  ): Promise<
    {
      id: ConversationEventId
      characterId: CharacterId
      sequence: number
      type: string
      actorId?: string
      conversationId?: string
      trustedOrigin?: TrustedOriginReading | undefined
    }[]
  >
  /** 信念域读侧 */
  belief: BeliefStateLookupPort
  /** 幂等查询（processed_operations） */
  hasProcessed(idempotencyKey: string): Promise<boolean>
  /**
   * 落库（装配层：逐事件 appendDomainEvent → applyBeliefRows(created)）。
   * accepted 携带 Validator 算好的领域幂等键——append 撞键 = deduplicated。
   */
  applyAccepted(
    characterId: CharacterId,
    accepted: readonly AcceptedDomainEvent[],
    now?: number,
  ): Promise<BeliefApplyOutcome>
}

// ---------------------------------------------------------------------------
// 共用：逐提案放行（REJECT 是正常结果）
// ---------------------------------------------------------------------------

export interface BeliefWindowRejection {
  proposalId: string
  code: string
  message: string
}

async function validateAll(
  deps: BeliefValidatorDeps,
  proposals: readonly DomainProposal[],
): Promise<{
  accepted: AcceptedDomainEvent[]
  acceptedProposals: number
  rejections: BeliefWindowRejection[]
}> {
  const accepted: AcceptedDomainEvent[] = []
  const rejections: BeliefWindowRejection[] = []
  let acceptedProposals = 0
  for (const proposal of proposals) {
    const outcome = await validateBeliefProposal(deps, proposal)
    if (outcome.accepted) {
      acceptedProposals += 1
      accepted.push(...outcome.acceptedEvents)
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
  return { accepted, acceptedProposals, rejections }
}

/** 信念状态查找端口 → Validator deps 的 belief 分量（同一端口两用） */
function beliefLookupOf(ports: BeliefJobPorts): BeliefValidatorDeps['belief'] {
  return {
    getBeliefOrigin: (cid) => ports.belief.getBeliefOrigin(cid),
    getBelief: (cid, beliefId) => ports.belief.getBelief(cid, String(beliefId)),
    listActiveBeliefsForSlot: (cid, slotKey) => ports.belief.listActiveBeliefsForSlot(cid, slotKey),
    forbiddenRootsForSlot: (cid, slotKey) => ports.belief.forbiddenRootsForSlot(cid, slotKey),
  }
}

// ---------------------------------------------------------------------------
// 流 1：交互评估窗口（对话事件 → B-INFERRED）
// ---------------------------------------------------------------------------

export interface BeliefInteractionRunInput {
  characterId: CharacterId
  /** 视角所有者（v1 恒 = characterId） */
  perspectiveOwnerId: PerspectiveOwnerId
  /** 信念主体（v1 恒 = active user） */
  subject: EntityRef
  fromSequence: number
  toSequence: number
  /** 唯一 active user 的 id（资格四条之一） */
  activeUserId: string
  now?: number
  traceId?: string
}

export interface BeliefInteractionOutcome {
  window: { fromSequence: number; toSequence: number }
  /** 评估器产出提案总数（evidence/formed/reinforced） */
  proposals: number
  /** 本窗口记下的新证据根数 */
  notedCount: number
  /** 合格但未命中的具名弃权（审计面） */
  abstentions: BeliefAbstention[]
  /** 窗口内被跳过的 tool_event 数（楔死防御） */
  skippedToolEvents: number
  acceptedProposals: number
  rejectedProposals: number
  rejections: BeliefWindowRejection[]
  applied: BeliefApplyOutcome
}

/**
 * 跑一次交互评估窗口。
 *
 * 幂等性：同窗口重跑 → 评估器产出相同提案 → Validator 领域幂等键命中
 * （evidence 按 rootEventId+rule；formed 按 beliefId）→ append 全部
 * deduplicated → createdEvents = 0。跨窗口重覆盖（失败重试 / catch-up）
 * 同样撞键（range 分量置零，见 belief-validator 文件头）。
 */
export async function runBeliefInteractionWindow(
  ports: BeliefJobPorts,
  input: BeliefInteractionRunInput,
): Promise<BeliefInteractionOutcome> {
  const now = input.now ?? Date.now()

  const events = await ports.loadWindowEvents(
    input.characterId,
    input.fromSequence,
    input.toSequence,
  )
  // tool_event 跳过（M8-D04 同源：工具内容永远不是信念证据；不跳过会楔死水位）
  const skippedToolEvents = events.filter((event) => event.actorType === 'tool').length
  const views = events
    .filter((event) => event.actorType !== 'tool')
    .map((event) => processorEventViewOf(event))

  // ---- 状态面：origin（cutover 边界）+ 槽位累计 + 现存信念 --------------
  const origin = await ports.belief.getBeliefOrigin(input.characterId)
  const slotKey = beliefSlotKeyOf({
    perspectiveOwnerId: input.perspectiveOwnerId,
    subject: input.subject,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
  })
  const activeBeliefs = await ports.belief.listActiveBeliefsForSlot(input.characterId, slotKey)

  /*
   * 按值分别跑评估器：评估器的 slotState 是单值面（accumulation 匹配
   * value 才参与合并）——冻结值域两条各喂一次，提案自然分属两条累计线。
   * 评估器是纯函数 ⇒ 同窗口重跑产出相同提案集（幂等的前提）。
   */
  const evaluator = new RuleBasedBeliefEvaluator()
  const proposals: DomainProposal[] = []
  const abstentions: BeliefAbstention[] = []
  let notedCount = 0
  for (const value of INFERRED_VALUES) {
    const accumulation = await ports.belief.getBeliefEvidence(
      input.characterId,
      beliefEvidenceKeyOf(slotKey, value),
    )
    const activeBelief = activeBeliefs.find((b) => String(b.proposition.value) === value)
    const result = await evaluator.process(
      {
        characterId: input.characterId,
        perspectiveOwnerId: input.perspectiveOwnerId,
        subject: input.subject,
        views,
        policy: {
          activeUserId: input.activeUserId,
          cutoverSequence: origin?.cutoverSequence ?? null,
        },
        slotState: {
          ...(activeBelief !== undefined
            ? {
                activeBelief: {
                  beliefId: activeBelief.beliefId,
                  value,
                  rootIds: activeBelief.evidenceRootIds,
                },
              }
            : {}),
          ...(accumulation !== undefined && accumulation.value === value
            ? { accumulation }
            : {}),
        },
      },
      {
        processorName: BELIEF_INTERACTION_EVALUATOR_NAME,
        processorVersion: BELIEF_INTERACTION_EVALUATOR_VERSION,
      },
    )
    proposals.push(...result.proposals)
    abstentions.push(...result.abstentions)
    notedCount += result.notedCount
  }

  // ---- 逐提案放行（证据查找 = 账本权威，与流 2 同一口径）----------------
  // ⚠️ 不能限制在"窗口内事件"：FORMED 的根**按设计跨窗口**（累计语义，
  // ADR-070 D06——生产里每个尾窗通常只有一两条事件，3 根/2 会话的阈值
  // 几乎总要跨窗达成）。窗口是评估器的**输入范围**，不是放行口的**证据
  // 范围；存在性/归属/资格四条都是账本问题，查账本比查窗口更正确。
  // （第一版用了窗口内查找：跨窗 FORMED 全被 source_event_missing 拒掉，
  // 且窗口视图缺 conversationId/actorId 分量，阈值复推也过不去——
  // WP6 门 r2-04 抓出的装配缺陷。资格四条里的 cutover 条件仍然守着
  // "切换前历史不重放"：窗外旧根过不了资格检查，失败关闭语义不变。）
  const validatorDeps: BeliefValidatorDeps = {
    registry: ports.registry,
    evidence: { findEvents: (ids) => ports.findConversationEvents(ids) },
    processed: { hasProcessed: (key: string) => ports.hasProcessed(key) },
    belief: beliefLookupOf(ports),
    // 流 1 只产 inferred 提案（无 Memory 依赖）——memory 端口不装配
    policy: { activeUserId: input.activeUserId },
  }
  const { accepted, acceptedProposals, rejections } = await validateAll(validatorDeps, proposals)

  const applied = await ports.applyAccepted(input.characterId, accepted, now)
  return {
    window: { fromSequence: input.fromSequence, toSequence: input.toSequence },
    proposals: proposals.length,
    notedCount,
    abstentions,
    skippedToolEvents,
    acceptedProposals,
    rejectedProposals: proposals.length - acceptedProposals,
    rejections,
    applied,
  }
}

// ---------------------------------------------------------------------------
// 流 2：Memory reconcile 窗口（Memory 域事件 → B-REPORTED + 失效传播）
// ---------------------------------------------------------------------------

export interface BeliefMemoryRunInput {
  characterId: CharacterId
  /** Memory 域事件的 sequence 窗口（水位空间 = character_domain_events.sequence） */
  fromSequence: number
  toSequence: number
  now?: number
}

export interface BeliefMemoryOutcome {
  window: { fromSequence: number; toSequence: number }
  /** 窗口内 Memory 域事件数 */
  memoryEvents: number
  /** 形成提案数（B-REPORTED） */
  formedProposals: number
  /** 失效传播提案数（dependency_invalidated） */
  invalidationProposals: number
  /** reconciler 跳过统计（审计面） */
  skipped: { reason: string; memoryId: string }[]
  acceptedProposals: number
  rejectedProposals: number
  rejections: BeliefWindowRejection[]
  applied: BeliefApplyOutcome
}

/**
 * 跑一次 Memory reconcile 窗口。
 *
 * 幂等性：同窗口重跑 → 同 Memory 集合 → 同 beliefId → 领域幂等键命中 →
 * createdEvents = 0。失效提案按 beliefId 撞键（belief-retracted:<id>）。
 *
 * 失效传播的收敛保证：planMemoryInvalidation 扫描的是**当前** active 信念
 * ——重放窗口里早已失效的 Memory 时 noop（信念已 retracted），不重复提案。
 */
export async function runBeliefMemoryWindow(
  ports: BeliefJobPorts,
  input: BeliefMemoryRunInput,
): Promise<BeliefMemoryOutcome> {
  const now = input.now ?? Date.now()

  const memoryEvents = await ports.loadMemoryEvents(
    input.characterId,
    input.fromSequence,
    input.toSequence,
  )
  /*
   * 触发面：MEMORY_* 事件 → 平铺 (type, memoryId) 对。
   * · CREATED/RESTORED/RETRACTED/SUPERSEDED：payload.memoryId（DISPUTED
   *   进来也会被 triggersOf 的 default 分支忽略——争议中的 Memory 仍是
   *   active，读侧回查按当前资格处理，不抢写侧裁定）；
   * · MERGED：payload = {winnerId, loserIds}（契约无 memoryId 字段）——
   *   **每个 loser 展平成一条 MEMORY_MERGED 触发**（M4 合并 = loser
   *   生命终止；winner 不触发，它自己的 CREATED 已处理过）。
   */
  const triggers: { type: string; memoryId: string; sequence: number }[] = []
  for (const event of memoryEvents) {
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'MEMORY_MERGED') {
      const loserIds = Array.isArray(payload.loserIds) ? payload.loserIds : []
      for (const loser of loserIds) {
        triggers.push({ type: event.type, memoryId: String(loser), sequence: event.sequence })
      }
      continue
    }
    const memoryId = String(payload.memoryId ?? '')
    if (memoryId !== '') {
      triggers.push({ type: event.type, memoryId, sequence: event.sequence })
    }
  }

  // ---- 形成路径（reconciler：白名单 + 同值预检）--------------------------
  const reconcilerDeps = {
    characterId: String(input.characterId),
    processor: BELIEF_MEMORY_RECONCILER_NAME,
    processorVersion: BELIEF_MEMORY_RECONCILER_VERSION,
    memory: { findMemories: (ids: readonly string[]) => ports.findMemories(ids) },
    belief: {
      listActiveBeliefsForSlot: (cid: string, slotKey: string) =>
        ports.belief.listActiveBeliefsForSlot(cid as never, slotKey),
    },
  }
  const reconciled = await reconcileMemoryWindow(reconcilerDeps, triggers)

  // ---- 失效路径（revision 规划器：dependency_invalidated，不禁根）--------
  const revisionDeps: BeliefRevisionDeps = {
    characterId: String(input.characterId),
    processor: BELIEF_MEMORY_RECONCILER_NAME,
    processorVersion: BELIEF_MEMORY_RECONCILER_VERSION,
    now: () => now,
    belief: {
      listActiveBeliefs: (cid: string) => ports.belief.listActiveBeliefs(cid as never),
      listActiveBeliefsForSlot: (cid: string, slotKey: string) =>
        ports.belief.listActiveBeliefsForSlot(cid as never, slotKey),
      getBelief: (cid: string, beliefId: string) => ports.belief.getBelief(cid as never, beliefId),
    },
  }
  const invalidationProposals: DomainProposal[] = []
  for (const memoryId of reconciled.invalidatedMemoryIds) {
    const plan = await planMemoryInvalidation(revisionDeps, { memoryId })
    if (plan.kind === 'proposals') invalidationProposals.push(...plan.proposals)
  }

  // ---- 逐提案放行（reported 的证据根按 id 查账本——历史陈述可在窗外）----
  const validatorDeps: BeliefValidatorDeps = {
    registry: ports.registry,
    evidence: { findEvents: (ids) => ports.findConversationEvents(ids) },
    processed: { hasProcessed: (key: string) => ports.hasProcessed(key) },
    belief: beliefLookupOf(ports),
    memory: { findMemories: (ids: readonly string[]) => ports.findMemories(ids) },
    // reported 不施 active-user 条件（历史陈述）；RETRACTED 不查证据
    policy: { activeUserId: '' },
  }
  const allProposals = [...reconciled.formedProposals, ...invalidationProposals]
  const { accepted, acceptedProposals, rejections } = await validateAll(validatorDeps, allProposals)

  const applied = await ports.applyAccepted(input.characterId, accepted, now)
  return {
    window: { fromSequence: input.fromSequence, toSequence: input.toSequence },
    memoryEvents: memoryEvents.length,
    formedProposals: reconciled.formedProposals.length,
    invalidationProposals: invalidationProposals.length,
    skipped: reconciled.skipped,
    acceptedProposals,
    rejectedProposals: allProposals.length - acceptedProposals,
    rejections,
    applied,
  }
}
