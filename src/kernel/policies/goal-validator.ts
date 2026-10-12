/**
 * Goal / Commitment **唯一放行口**（M10 WP3 / ADR-076 §4.4 · §4.7 · §4.8）。
 *
 * ============================================================================
 *  它保证什么（每一条都有对应的门检查）
 * ============================================================================
 * ① **唯一写路径**（§4.7）：任何 Goal 状态变化都得先过这里；应用层禁止绕过事件
 *    直接 UPDATE 投影行。
 * ② **合法边全集**（§4.4）：不在转换表里的边一律**拒绝且零事件**。
 * ③ **expectedRevision 乐观锁**：goal 与 commitment **各自独立**，不符即
 *    `goal_revision_conflict`。
 * ④ **幂等**：同一 `unitOperation` 重复投递 ⇒ `goal_duplicate_operation`
 *    （第五分量由 `unitOperationOf` 按事件类型推导，与 belief 同形 —— `D21`）。
 * ⑤ **身份由程序算**：`GOAL_CREATED` / `COMMITMENT_ACCEPTED` 的 id **一律重写**为
 *    程序按材料算出的值 ⇒ "模型编造 goalId / commitmentId"在结构上不可能
 *    （计划 §7.2 的硬要求）。
 * ⑥ **来源资格**（§7.1）：所有来源事件必须带 `ESTABLISHED` 读数；读数由**程序**给出，
 *    提案不能自报（叫 `sourceQualifications` 而不是 `payload.qualification` 就是这个意思）。
 * ⑦ **遗忘的禁用根**（§5）：新 `create` 的来源命中任何既有 `forbiddenSourceEventIds`
 *    ⇒ `goal_source_forbidden`（M9 的 B28 机制逐字复用）。
 * ⑧ **关联原子性**（`G13`）：取消一个**有 active 承诺**的目标，同一提案里必须
 *    同时给出 `COMMITMENT_CANCELLED`，否则 `goal_orphan_commitment`；
 *    `GOAL_SUPERSEDED` 必须与新目标的 `GOAL_CREATED` 在同提案。
 * ⑨ **字段上界**：`statement` ≤500 码点等（第一道防线）。payload 上限是第二道，
 *    因此"字段不合法"与"payload 太大"是两个可区分的拒绝码。
 *
 * ⚠️ **提案级原子性**：只要有一个 target 被拒，**整个提案零事件**
 *    （`ValidatorOutcome.accepted` 的既有语义："提案是一个整体工作单元"）。
 *    这与 belief 的逐 target 接受**刻意不同** —— 目标域的关联操作
 *    （supersede+create / cancel+cancel）必须同生同死，而"非法边拒绝且零事件"
 *    正是 WP3 的出口判据。
 *
 * ⚠️ 本层是 `kernel/policies/`：不 import SQL / 框架 / `node:*`；读状态经**端口**。
 */

import { DOMAIN_EVENT_SCOPE, type DomainEventRegistry } from '../contracts/domain-event.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_EXPIRED,
  COMMITMENT_FULFILLED,
  COMMITMENT_SUPERSEDED,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_PAUSED,
  GOAL_REVISED,
  GOAL_RESUMED,
  GOAL_SUPERSEDED,
  GOAL_DOMAIN_EVENT_TYPES,
} from '../contracts/domain-event.ts'
import {
  COMMITMENT_SCOPE_MAX_CODEPOINTS,
  GOAL_DEPENDENCIES_MAX,
  GOAL_STATEMENT_MAX_CODEPOINTS,
  codePointLength,
  isCommitmentTerminal,
  isGoalTerminal,
  makeCommitmentId,
  makeGoalId,
  type CommitmentAcceptedPayload,
  type CommitmentState,
  type GoalCreatedPayload,
  type GoalRowState,
  type GoalState,
} from '../contracts/goal.ts'
import { computeIdempotencyKey } from '../contracts/job.ts'
import type { AcceptedDomainEvent, RejectedTarget, ValidatorOutcome } from './validator.ts'
import type { ProposalId } from '../contracts/ids.ts'
import type { GoalOperation } from '../contracts/goal.ts'
import type { SourceQualification } from '../contracts/attribution.ts'
import type { DomainProposal, ProposedDomainEvent } from '../contracts/proposal.ts'
import { commitmentNeedsCancellation } from '../projections/goal.ts'

// ---------------------------------------------------------------------------
// 端口与提案
// ---------------------------------------------------------------------------

/** 目标状态的**只读**端口（放行口不写库；写由 store 的事务做） */
export interface GoalStateLookupPort {
  /** 一个目标的当前行（不存在 = undefined） */
  getGoal(characterId: string, goalId: string): Promise<GoalRowState | undefined>
  /**
   * 本角色的**全部**目标行。
   *
   * ⚠️ 它必须存在，因为"遗忘的禁用根"是**全局**判据：一条 `GOAL_CREATED` 的
   *    来源可能命中**另一个**目标曾经 `explicit_forget` 过的根集合。
   *    只看自己那一行会漏掉这条（`goal_source_forbidden` 因此会是死码）。
   */
  listGoals(characterId: string): Promise<GoalRowState[]>
}

/** 来源资格读数（**程序**给出；提案不能自报） */
export interface GoalSourceQualification {
  eventId: string
  qualification: SourceQualification
}

export interface GoalProposal extends DomainProposal {
  /**
   * 每个来源事件的资格读数。
   *
   * ⚠️ 它在**顶级字段**而不是 `payload` 里（`payload` 是 Processor 的自由产出）：
   *    资格必须来自鉴证过的归因，不能由提案方随 payload 一起自报（ADR-076 §7.1）。
   */
  sourceQualifications: readonly GoalSourceQualification[]
}

export interface GoalValidatorDeps {
  registry: DomainEventRegistry
  processed: { hasProcessed(idempotencyKey: string): Promise<boolean> }
  state: GoalStateLookupPort
  policy: { characterId: string; activeUserId: string }
}

// ---------------------------------------------------------------------------
// 幂等键（领域推导；memory / belief 先例：住在放行口）
// ---------------------------------------------------------------------------

/**
 * 幂等键的第五分量（领域单元串）。
 *
 * 形状照抄 belief：**每个事件类型一个确定性的 unit**，而不是复用
 * `ProposalOperation`（`D21`）。
 *
 * ⚠️ `GOAL_COMPLETED` / `COMMITMENT_FULFILLED` 的 unit 含 `expectedRevision` 与
 *    结果引用（`D26`）：兑现补记**不得**依赖内容去重（WP0 的 E4b 证明内容去重闸
 *    会先命中），所以补记必须自带确定性事件身份。
 */
export function goalUnitOperationOf(target: ProposedDomainEvent): string | undefined {
  const payload = target.payload as Record<string, unknown> | undefined
  if (payload === undefined) return undefined
  const goalId = typeof payload.goalId === 'string' ? payload.goalId : undefined
  const revision =
    typeof payload.expectedRevision === 'number' ? String(payload.expectedRevision) : undefined

  switch (target.type) {
    case GOAL_CREATED: {
      const goal = payload.goal as { goalId?: string } | undefined
      if (goal?.goalId === undefined) return undefined
      return `goal-created:${String(goal.goalId)}`
    }
    case GOAL_REVISED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-revised:${goalId}:${revision}`
    case GOAL_PAUSED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-paused:${goalId}:${revision}`
    case GOAL_RESUMED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-resumed:${goalId}:${revision}`
    case GOAL_BLOCKED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-blocked:${goalId}:${revision}:${String(payload.reasonCode)}`
    case GOAL_COMPLETED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-completed:${goalId}:${revision}`
    case GOAL_CANCELLED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-cancelled:${goalId}:${revision}:${String(payload.reason)}`
    case GOAL_SUPERSEDED:
      if (goalId === undefined || revision === undefined) return undefined
      return `goal-superseded:${goalId}:${revision}`
    case COMMITMENT_ACCEPTED: {
      const commitment = payload.commitment as { commitmentId?: string } | undefined
      if (commitment?.commitmentId === undefined) return undefined
      return `commitment-accepted:${String(commitment.commitmentId)}`
    }
    case COMMITMENT_FULFILLED: {
      const commitmentId = typeof payload.commitmentId === 'string' ? payload.commitmentId : undefined
      if (commitmentId === undefined || revision === undefined) return undefined
      const refs = Array.isArray(payload.resultRefs) ? payload.resultRefs : []
      const first = refs[0] as { conversationEventId?: string } | undefined
      return `commitment-fulfilled:${commitmentId}:${revision}:${String(first?.conversationEventId ?? '')}`
    }
    case COMMITMENT_BROKEN: {
      const commitmentId = typeof payload.commitmentId === 'string' ? payload.commitmentId : undefined
      if (commitmentId === undefined || revision === undefined) return undefined
      return `commitment-broken:${commitmentId}:${revision}:${String(payload.ruleId)}`
    }
    case COMMITMENT_CANCELLED: {
      const commitmentId = typeof payload.commitmentId === 'string' ? payload.commitmentId : undefined
      if (commitmentId === undefined || revision === undefined) return undefined
      return `commitment-cancelled:${commitmentId}:${revision}:${String(payload.reason)}`
    }
    case COMMITMENT_SUPERSEDED: {
      const commitmentId = typeof payload.commitmentId === 'string' ? payload.commitmentId : undefined
      if (commitmentId === undefined || revision === undefined) return undefined
      return `commitment-superseded:${commitmentId}:${revision}`
    }
    /*
     * ⚠️ **M10.1 追加**：到期的幂等单元串**只**含 `commitmentId` 与 `revision`
     *    —— **不含** `expiredAt`：同一个截止时间只应当到期**一次**，
     *    把时刻编进单元串会让"重跑扫描"每次都算成新事件（幂等就失效了）。
     */
    case COMMITMENT_EXPIRED: {
      const commitmentId = typeof payload.commitmentId === 'string' ? payload.commitmentId : undefined
      if (commitmentId === undefined || revision === undefined) return undefined
      return `commitment-expired:${commitmentId}:${revision}`
    }
    default:
      return undefined
  }
}

export function idempotencyKeyForGoalEvent(input: {
  characterId: string
  processor: string
  processorVersion: string
  unit: string
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId as never,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: 0,
    sourceToSequence: 0,
    operation: input.unit,
  })
}

// ---------------------------------------------------------------------------
// 拒绝码（ADR-076 §4.8 + WP3 追加的六条，见 WP3 交接单 §2）
// ---------------------------------------------------------------------------

/** `GOAL_REVISED` 允许的字段（**小改**）——其余字段属"实质改"，必须走 supersede */
export const GOAL_REVISABLE_FIELDS: readonly string[] = [
  'statement',
  'priority',
  'nextStep',
  'dependencies',
]

/**
 * **正式接受**的承诺 criterion（ADR-076 §4.2 `D11`）。
 *
 * ⚠️ **2026-10-02 按用户裁定 `(U-03-a)` 扩了一类**：加入 **`user_report`**。
 *    依据与语义（逐字记录在 [`ADR-076`](../../../docs/adr/ADR-076-m10-goals-and-commitments.md) 的修订节）：
 *    · 需要它的场景：**双方约定**（"明天十点二十五楼下见"）的判据是"**他到没到**"，
 *      而这件事**只能由用户报告** ⇒ 原闭集（只有两类**程序可观察**的）把它挡在门外，
 *      于是"约定桥"记不下这类约定。
 *    · **不破防火墙**：`judgeGoalCompletion` 的 `user_report` 分支要求
 *      ①依据事件必须是**用户**发的（**她的输出永远不能当 user_report**）；
 *      ②归因必须是 `ESTABLISHED`。⇒ 她依然不能自己把承诺"说"成完成。
 *    · 所以这一类的准确说法是"**由对方报告结清**"，不是"程序观测到"。
 */
export const COMMITMENT_ACCEPTABLE_CRITERIA: readonly string[] = [
  'conversation_output',
  'action_result',
  'user_report',
]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function reject(
  rejected: RejectedTarget[],
  type: string,
  code: string,
  message: string,
): void {
  rejected.push({ type, code, message })
}

function payloadObject(target: ProposedDomainEvent): Record<string, unknown> {
  const payload = target.payload
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`${target.type} payload 必须是对象`)
  }
  return payload as Record<string, unknown>
}

function accept(target: ProposedDomainEvent, proposal: GoalProposal, unit: string): AcceptedDomainEvent {
  return {
    type: target.type,
    /*
     * ⚠️ `operation` 记的是**领域单元串**，不是提案上那个共享的
     *    `ProposalOperation`（`D21`：本域的操作词表自持）。
     *    后果是 `processed_operations.operation` 直接告诉你"哪一个领域操作"，
     *    而不是一个被压扁的通用词 —— 排查"这条为什么被判重"时不需要再翻译。
     */
    operation: unit,
    payload: target.payload,
    sourceConversationEventIds: proposal.sourceConversationEventIds,
    idempotencyKey: idempotencyKeyForGoalEvent({
      characterId: String(proposal.characterId),
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      unit,
    }),
    processor: proposal.processor,
    processorVersion: proposal.processorVersion,
    scope: target.scope ?? DOMAIN_EVENT_SCOPE,
  }
}

/** 该目标是否已被某个**更早**的目标 `explicit_forget` 禁用了这个根 */
function forbiddenByExistingGoals(
  rows: readonly GoalRowState[],
  sourceEventIds: readonly string[],
): boolean {
  const forbidden = new Set<string>()
  for (const row of rows) {
    for (const id of row.goal.forbiddenSourceEventIds ?? []) forbidden.add(String(id))
  }
  return sourceEventIds.some((id) => forbidden.has(String(id)))
}

/**
 * 提案里有没有**配对**的承诺作废事件（`G13` / `L-M10-08`）。
 *
 * 取消目标与实质替代目标**都**要求它：两者的共同点是"这个目标不再作数了"，
 * 而挂在它上面的正式承诺不能留成孤儿。
 */
function hasPairedCommitmentCancellation(
  proposal: GoalProposal,
  current: GoalRowState,
): boolean {
  if (!commitmentNeedsCancellation(current.commitment)) return true
  const expectedId = String(current.commitment?.commitmentId)
  return proposal.targetEvents.some(
    (other) =>
      other.type === COMMITMENT_CANCELLED &&
      String((other.payload as { commitmentId?: string }).commitmentId) === expectedId,
  )
}

/** 身份推导的结论（`payload` 是**规范化后**的，id 由程序算） */
interface GoalIdentity {
  unit: string
  payload: unknown
}

/**
 * 推导一个 target 的**身份**：领域单元串 + 规范化 payload。
 *
 * 对 `GOAL_CREATED` / `COMMITMENT_ACCEPTED` 而言，这包括**算 id**
 * （计划 §7.2："不得让模型编造 goalId / commitmentId" 的结构性落点）。
 * 其余 11 种事件的 id 由提案引用既有对象，规范化就是原 payload。
 *
 * ⚠️ 它**不读状态**（纯函数），因此可以在"读库"之前跑 —— 这正是幂等检查能
 *    排在语义检查**之前**的原因（见 `validateGoalProposal` 的阶段说明）。
 */
function identityOf(
  target: ProposedDomainEvent,
  characterId: string,
  sourceEventIds: readonly string[],
  activeUserId?: string,
): GoalIdentity {
  const payload = payloadObject(target)

  if (target.type === GOAL_CREATED) {
    const goal = payload.goal as GoalState
    const derived = makeGoalId({
      characterId,
      owner: goal.owner,
      ...(goal.targetEntity !== undefined ? { targetEntity: goal.targetEntity } : {}),
      ...(goal.contextRef !== undefined ? { contextRef: goal.contextRef } : {}),
      origin: goal.origin,
      statement: goal.statement,
      acceptanceSourceEventId: sourceEventIds[0]!,
      operation: 'create',
    })
    const normalized: GoalCreatedPayload = {
      characterId,
      goal: { ...goal, goalId: derived, characterId, revision: 1 },
      mutation: 'explicit',
    }
    return { unit: `goal-created:${String(derived)}`, payload: normalized }
  }

  if (target.type === COMMITMENT_ACCEPTED) {
    const commitment = payload.commitment as CommitmentState
    const goalId = String(payload.goalId)
    /*
     * ⚠️ **M10.1 追加**：`actor` / `beneficiary` 是**程序事实**，不是提案方给的
     *    —— 提案里那两个字段是**占位**（草案刻意不含 userId，见 `goal-proposal.ts` 的说明）。
     *    在这里统一改写成"本角色承诺给**当前 active user**"，然后用改写后的值算 `commitmentId`
     *    （`makeCommitmentId` 用 actor/beneficiary 的标签 ⇒ 必须先归一化再算，否则 id 会随占位符漂）。
     *    ⚠️ 入账用的是本函数返回的 `payload`（`:902-904`）⇒ 占位值**不会**进账本。
     */
    const normalizedActor = { kind: 'character', id: characterId } as CommitmentState['actor']
    const normalizedBeneficiary = (
      activeUserId === undefined || activeUserId === ''
        ? commitment.beneficiary
        : { kind: 'user', id: activeUserId }
    ) as CommitmentState['beneficiary']
    const derived = makeCommitmentId({
      characterId,
      goalId,
      actor: normalizedActor,
      beneficiary: normalizedBeneficiary,
      scope: commitment.scope,
      acceptanceSourceEventId: sourceEventIds[0]!,
    })
    const normalized: CommitmentAcceptedPayload = {
      characterId,
      goalId,
      commitment: {
        ...commitment,
        actor: normalizedActor,
        beneficiary: normalizedBeneficiary,
        commitmentId: derived,
        goalId: goalId as never,
        revision: 1,
        status: 'active',
      },
      expectedGoalRevision: Number(payload.expectedGoalRevision),
    }
    return { unit: `commitment-accepted:${String(derived)}`, payload: normalized }
  }

  const unit = goalUnitOperationOf(target)
  if (unit === undefined) throw new Error(`${target.type} 无法推导幂等单元串`)
  return { unit, payload: target.payload }
}

// ---------------------------------------------------------------------------
// 放行口
// ---------------------------------------------------------------------------

/**
 * 校验一个 Goal 提案。
 *
 * ⚠️ **提案级原子性**：任一 target 被拒 ⇒ `accepted: false` 且
 *    `acceptedEvents: []`（零事件）。关联操作因此同生同死。
 */
export async function validateGoalProposal(
  deps: GoalValidatorDeps,
  proposal: GoalProposal,
): Promise<ValidatorOutcome> {
  const rejected: RejectedTarget[] = []
  const characterId = String(proposal.characterId)

  const finishRejected = (): ValidatorOutcome => ({
    proposalId: String(proposal.proposalId),
    characterId: proposal.characterId,
    accepted: false,
    acceptedEvents: [],
    rejected,
  })

  // ---- 提案级 ------------------------------------------------------------
  if (!proposal.processor || !proposal.processorVersion) {
    for (const target of proposal.targetEvents) {
      reject(rejected, target.type, 'processor_version_presence', '提案缺 processor / processorVersion')
    }
    return finishRejected()
  }
  if (characterId !== deps.policy.characterId) {
    for (const target of proposal.targetEvents) {
      reject(
        rejected,
        target.type,
        'goal_dependency_foreign',
        `提案的 characterId=${characterId} 不是本角色 ${deps.policy.characterId}`,
      )
    }
    return finishRejected()
  }
  if (proposal.targetEvents.length === 0) {
    return finishRejected()
  }

  // ---- 来源资格（§7.1）--------------------------------------------------
  const sourceEventIds = proposal.sourceConversationEventIds.map(String)
  if (sourceEventIds.length === 0) {
    for (const target of proposal.targetEvents) {
      reject(rejected, target.type, 'goal_source_missing', 'Goal / Commitment 事件必须带来源对话事件')
    }
    return finishRejected()
  }
  const qualificationByEvent = new Map(
    proposal.sourceQualifications.map((entry) => [String(entry.eventId), entry.qualification]),
  )
  const unqualified = sourceEventIds.filter(
    (id) => qualificationByEvent.get(id) !== 'ESTABLISHED',
  )
  if (unqualified.length > 0) {
    for (const target of proposal.targetEvents) {
      reject(
        rejected,
        target.type,
        'goal_proposal_source_unqualified',
        `来源事件的受信归因不是 ESTABLISHED：${unqualified.join(', ')}`,
      )
    }
    return finishRejected()
  }

  // ---- 目标类型登记 ------------------------------------------------------
  for (const target of proposal.targetEvents) {
    if (!(GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(target.type)) {
      reject(rejected, target.type, 'goal_proposal_unknown_operation', `${target.type} 不是本域登记的事件类型`)
      continue
    }
    if (deps.registry.get(target.type) === undefined) {
      reject(rejected, target.type, 'goal_proposal_invalid_shape', `${target.type} 未在 registry 登记`)
      continue
    }
    /*
     * 结构校验走 registry（一个概念一处实现）：形状 / 枚举 / 上界都在那里。
     * 失败 ⇒ 记 `goal_proposal_invalid_shape`，**不当** none。
     */
    try {
      deps.registry.get(target.type)!.validatePayload(target.payload)
    } catch (error) {
      reject(
        rejected,
        target.type,
        'goal_proposal_invalid_shape',
        `${target.type} payload 结构不合法：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (rejected.length > 0) return finishRejected()

  // ---- 阶段 C：身份与幂等（**在语义之前**）-------------------------------
  /*
   * ⚠️ 顺序是判据的一部分（WP3 的门 `S3` 把它钉住）：
   *
   * ```text
   * 结构（registry） → **身份与幂等** → 语义（读状态、合法边、revision）
   * ```
   *
   * 为什么幂等必须排在语义**之前**：一次真实的**重试**会带着**原来的**
   * expectedRevision 再来一遍，而第一次投递已经把状态推进了 —— 若先判语义，
   * 这次重试会得到 `goal_revision_conflict`（"并发写者"的形状），
   * 而幂等键本来就是为了让这种情况被认成"同一次操作"。
   * 排在后面 ⇒ 幂等保证在真实重试下**永远观测不到** ⇒ 它是一句空话。
   */
  const identities: GoalIdentity[] = []
  for (const target of proposal.targetEvents) {
    let identity: GoalIdentity
    try {
      identity = identityOf(target, characterId, sourceEventIds, deps.policy.activeUserId)
    } catch (error) {
      reject(
        rejected,
        target.type,
        'goal_proposal_invalid_shape',
        `${target.type} 身份推导失败：${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    const key = idempotencyKeyForGoalEvent({
      characterId,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      unit: identity.unit,
    })
    if (await deps.processed.hasProcessed(key)) {
      reject(
        rejected,
        target.type,
        'goal_duplicate_operation',
        `幂等键 ${key} 已处理过：同一个操作只允许生效一次（重试是安静的成功，不是新操作）`,
      )
      continue
    }
    identities.push(identity)
  }
  if (rejected.length > 0) return finishRejected()

  // ---- 阶段 D：逐 target 的**语义** --------------------------------------
  const existing = await deps.state.listGoals(characterId)
  const rowByGoalId = new Map(existing.map((row) => [String(row.goal.goalId), row]))
  /** 本提案内新建立的 goalId（供 supersede 的原子性判定） */
  const createdInProposal = new Set<string>()

  for (const [index, target] of proposal.targetEvents.entries()) {
    /* 语义阶段一律看**规范化后**的 payload（id 是程序算的） */
    const payload = payloadObject({ ...target, payload: identities[index]!.payload })

    switch (target.type) {
      case GOAL_CREATED: {
        const goal = payload.goal as GoalState
        if (goal.status !== 'active') {
          reject(rejected, target.type, 'goal_illegal_transition', '新建目标的状态必须是 active')
          break
        }
        if (codePointLength(goal.statement) > GOAL_STATEMENT_MAX_CODEPOINTS) {
          reject(
            rejected,
            target.type,
            'goal_statement_too_long',
            `statement 超过 ${GOAL_STATEMENT_MAX_CODEPOINTS} 码点`,
          )
          break
        }
        if ((goal.dependencies ?? []).length > GOAL_DEPENDENCIES_MAX) {
          reject(rejected, target.type, 'goal_criterion_param_invalid', 'dependencies 超过上界')
          break
        }
        /*
         * 身份已在阶段 C 算好（`goalId` 是程序派生的）。
         * 这里只判**语义**：这个 id 现在能不能建、来源有没有被禁用。
         */
        const derived = String(goal.goalId)
        if (rowByGoalId.has(derived) || createdInProposal.has(derived)) {
          reject(
            rejected,
            target.type,
            'goal_id_conflict',
            `目标 ${derived} 已存在（同来源 + 同内容 + 同操作应当幂等命中，而不是再建一次）`,
          )
          break
        }
        if (forbiddenByExistingGoals(existing, sourceEventIds)) {
          reject(
            rejected,
            target.type,
            'goal_source_forbidden',
            '来源事件命中既有的"忘掉这项目标"禁用根集合 ⇒ 旧根禁用不因内容再次出现而解除',
          )
          break
        }
        if (goal.origin === 'character_proposed') {
          /* 采纳路径必须能定位**具体提议**（§7.1）；v1 用来源 span + 指纹表达 */
          const adoption = goal.sourceRefs.filter((ref) => ref.span !== undefined)
          if (adoption.length < 2) {
            reject(
              rejected,
              target.type,
              'goal_proposal_ambiguous_target',
              'character_proposed 必须同时给出「提议侧」与「采纳侧」两组带 span 的引用' +
                '（D28：跨轮无法唯一定位时必须澄清，不得猜）',
            )
            break
          }
        }
        createdInProposal.add(derived)
        break
      }

      case GOAL_REVISED: {
        const goalId = String(payload.goalId)
        const current = rowByGoalId.get(goalId)
        if (current === undefined) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (isGoalTerminal(current.goal.status)) {
          reject(rejected, target.type, 'goal_terminal_state', `目标处于终态 ${current.goal.status}，不可修订`)
          break
        }
        if (Number(payload.expectedRevision) !== current.goal.revision) {
          reject(
            rejected,
            target.type,
            'goal_revision_conflict',
            `期望 revision=${String(payload.expectedRevision)}，当前 ${String(current.goal.revision)}`,
          )
          break
        }
        const changed = (payload.changed as string[]) ?? []
        const substantive = changed.filter((field) => !GOAL_REVISABLE_FIELDS.includes(field))
        if (substantive.length > 0) {
          reject(
            rejected,
            target.type,
            'goal_revision_requires_supersede',
            `字段 [${substantive.join(', ')}] 属"实质改"（对象 / 成功条件），必须走 GOAL_SUPERSEDED + 新身份`,
          )
          break
        }
        if (payload.statement !== undefined && codePointLength(String(payload.statement)) > GOAL_STATEMENT_MAX_CODEPOINTS) {
          reject(rejected, target.type, 'goal_statement_too_long', 'statement 超过上界')
          break
        }
        break
      }

      case GOAL_PAUSED:
      case GOAL_BLOCKED:
      case GOAL_RESUMED: {
        const goalId = String(payload.goalId)
        const current = rowByGoalId.get(goalId)
        if (current === undefined) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (isGoalTerminal(current.goal.status)) {
          reject(rejected, target.type, 'goal_terminal_state', `目标处于终态 ${current.goal.status}`)
          break
        }
        if (Number(payload.expectedRevision) !== current.goal.revision) {
          reject(rejected, target.type, 'goal_revision_conflict', 'revision 不符')
          break
        }
        const from = current.goal.status
        if (target.type === GOAL_PAUSED && from !== 'active') {
          reject(rejected, target.type, 'goal_illegal_transition', `只有 active 可以暂停（当前 ${from}）`)
          break
        }
        if (target.type === GOAL_BLOCKED && from !== 'active' && from !== 'paused') {
          reject(rejected, target.type, 'goal_illegal_transition', `只有 active / paused 可以转 blocked（当前 ${from}）`)
          break
        }
        if (target.type === GOAL_RESUMED) {
          if (from !== 'paused' && from !== 'blocked') {
            reject(rejected, target.type, 'goal_illegal_transition', `只有 paused / blocked 可以恢复（当前 ${from}）`)
            break
          }
          /*
           * 恢复**必须**带复核读数，且**不得**有被丢弃的必要依赖
           * （§4.6："不得因索引恢复就静默继续"）。
           */
          const recheck = payload.recheck as { dropped?: number } | undefined
          if (recheck === undefined || Number(recheck.dropped) > 0) {
            reject(
              rejected,
              target.type,
              'goal_operation_dependency_unavailable',
              `恢复要求依赖复核通过（dropped=${String(recheck?.dropped ?? '未给出')}）`,
            )
            break
          }
        }
        break
      }

      case GOAL_COMPLETED: {
        const goalId = String(payload.goalId)
        const current = rowByGoalId.get(goalId)
        if (current === undefined) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (isGoalTerminal(current.goal.status)) {
          reject(rejected, target.type, 'goal_terminal_state', `目标已是终态 ${current.goal.status}`)
          break
        }
        if (Number(payload.expectedRevision) !== current.goal.revision) {
          reject(rejected, target.type, 'goal_revision_conflict', 'revision 不符（迟到结果不得完成新约定的新版本）')
          break
        }
        const basis = String(payload.basis)
        if (basis !== current.goal.successCriterion.kind) {
          reject(
            rejected,
            target.type,
            'completion_evidence_kind_mismatch',
            `依据 ${basis} 与 criterion ${current.goal.successCriterion.kind} 不匹配（一对一，无例外）`,
          )
          break
        }
        if (
          (current.goal.status === 'paused' || current.goal.status === 'blocked') &&
          basis !== 'user_report'
        ) {
          reject(
            rejected,
            target.type,
            'goal_illegal_transition',
            `paused / blocked 只接受 user_report 完成（收到 ${basis}）—— 机器证据不得把暂停/受阻的目标判完成`,
          )
          break
        }
        break
      }

      case GOAL_CANCELLED: {
        const goalId = String(payload.goalId)
        const current = rowByGoalId.get(goalId)
        if (current === undefined) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (isGoalTerminal(current.goal.status)) {
          reject(rejected, target.type, 'goal_terminal_state', `目标已是终态 ${current.goal.status}`)
          break
        }
        if (Number(payload.expectedRevision) !== current.goal.revision) {
          reject(rejected, target.type, 'goal_revision_conflict', 'revision 不符')
          break
        }
        /*
         * §4.2：取消一个**有 active 承诺**的目标，必须在**同一提案**里把承诺也取消
         * —— 不得留下"已取消目标仍被履行"的孤儿约定。
         */
        if (!hasPairedCommitmentCancellation(proposal, current)) {
          reject(
            rejected,
            target.type,
            'goal_orphan_commitment',
            '该目标有 active 承诺：取消目标必须在同一提案里同时取消它（COMMITMENT_CANCELLED）',
          )
          break
        }
        break
      }

      case GOAL_SUPERSEDED: {
        const goalId = String(payload.goalId)
        const current = rowByGoalId.get(goalId)
        if (current === undefined) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (isGoalTerminal(current.goal.status)) {
          reject(rejected, target.type, 'goal_terminal_state', `目标已是终态 ${current.goal.status}`)
          break
        }
        if (Number(payload.expectedRevision) !== current.goal.revision) {
          reject(rejected, target.type, 'goal_revision_conflict', 'revision 不符')
          break
        }
        const successor = String(payload.supersededByGoalId)
        if (!createdInProposal.has(successor)) {
          reject(
            rejected,
            target.type,
            'goal_supersede_target_missing',
            `supersede 的新目标 ${successor} 必须与它在**同一提案**里创建（关联操作原子提交）`,
          )
          break
        }
        /*
         * ⚠️ **WP5 关闭 `L-M10-08`**：被实质替代的目标，其 active 承诺必须
         *    在**同一提案**里作废（`COMMITMENT_CANCELLED(reason='goal_superseded')`）。
         *
         * 为什么不"顺延到新目标"：承诺是对**旧对象 / 旧成功条件**答应的。顺延等于
         * 在用户没有重新同意的情况下重新划定一个正式义务（§4.2 禁止）。
         * 新目标若需要承诺，双方**重新** `COMMITMENT_ACCEPTED`（新身份）。
         */
        if (!hasPairedCommitmentCancellation(proposal, current)) {
          reject(
            rejected,
            target.type,
            'goal_orphan_commitment',
            '该目标有 active 承诺：实质替代它必须在同一提案里同时作废该承诺' +
              '（COMMITMENT_CANCELLED，reason=goal_superseded）—— 承诺不顺延到新目标',
          )
          break
        }
        break
      }

      case COMMITMENT_ACCEPTED: {
        const goalId = String(payload.goalId)
        const current = rowByGoalId.get(goalId)
        /*
         * ⚠️ **M10.1 追加（同提案 create+commit）**：`GOAL_CREATED` 与 `COMMITMENT_ACCEPTED`
         *    出现在**同一个提案**里时（"约定桥"就是这种形状），目标还没落库 ⇒
         *    `rowByGoalId` 查不到。这里**只追加**一条回看：若该 goalId 是本提案内刚建立的
         *    （`createdInProposal`），就按"刚建立的目标"判（`revision = 1`、非终态）。
         *    ⚠️ 既有行为**不变**：落库目标仍走原来的 `rowByGoalId` 分支。
         */
        const createdHere = current === undefined && createdInProposal.has(goalId)
        if (current === undefined && !createdHere) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (current !== undefined && isGoalTerminal(current.goal.status)) {
          reject(rejected, target.type, 'goal_terminal_state', `目标处于终态，不接受新承诺`)
          break
        }
        const currentRevision = createdHere ? 1 : current!.goal.revision
        if (Number(payload.expectedGoalRevision) !== currentRevision) {
          reject(rejected, target.type, 'goal_revision_conflict', 'expectedGoalRevision 不符')
          break
        }
        /* 身份已在阶段 C 算好；这里只判语义 */
        if (current !== undefined && current.commitment !== null && !isCommitmentTerminal(current.commitment.status)) {
          reject(
            rejected,
            target.type,
            'commitment_already_active',
            `该目标已有非终态承诺 ${String(current.commitment.commitmentId)}（重新约定必须走 supersede）`,
          )
          break
        }
        const commitment = payload.commitment as CommitmentState
        if (codePointLength(commitment.scope) > COMMITMENT_SCOPE_MAX_CODEPOINTS) {
          reject(rejected, target.type, 'commitment_scope_exceeds_proposal', '承诺范围超过上界')
          break
        }
        if (!COMMITMENT_ACCEPTABLE_CRITERIA.includes(commitment.criterion.kind)) {
          reject(
            rejected,
            target.type,
            'commitment_criterion_unacceptable',
            `正式接受的承诺判据是 ${COMMITMENT_ACCEPTABLE_CRITERIA.join(' / ')}` +
              `（收到 ${commitment.criterion.kind}）—— 长期维护型承诺不假装覆盖`,
          )
          break
        }
        break
      }

      case COMMITMENT_FULFILLED:
      case COMMITMENT_BROKEN:
      case COMMITMENT_CANCELLED:
      case COMMITMENT_SUPERSEDED:
      /* ⚠️ **M10.1 追加**：到期走**同一组**结构性判据（目标在 · 承诺在 · 非终态 · revision 相符） */
      case COMMITMENT_EXPIRED: {
        const goalId = String(payload.goalId)
        const commitmentId = String(payload.commitmentId)
        const current = rowByGoalId.get(goalId)
        if (current === undefined) {
          reject(rejected, target.type, 'goal_not_found', `目标 ${goalId} 不存在`)
          break
        }
        if (current.commitment === null) {
          reject(rejected, target.type, 'commitment_not_found', `目标 ${goalId} 没有承诺`)
          break
        }
        if (String(current.commitment.commitmentId) !== commitmentId) {
          reject(
            rejected,
            target.type,
            'commitment_not_found',
            `承诺 ${commitmentId} 不属于目标 ${goalId}（当前是 ${String(current.commitment.commitmentId)}）`,
          )
          break
        }
        if (isCommitmentTerminal(current.commitment.status)) {
          reject(
            rejected,
            target.type,
            'goal_terminal_state',
            `承诺已是终态 ${current.commitment.status}（幂等由 processed_operations 负责，不靠再发一次）`,
          )
          break
        }
        if (Number(payload.expectedRevision) !== current.commitment.revision) {
          reject(rejected, target.type, 'goal_revision_conflict', '承诺 revision 不符')
          break
        }
        if (target.type === COMMITMENT_BROKEN && !payload.ruleId) {
          reject(rejected, target.type, 'completion_evidence_missing', 'broken 必须给出可判定的规则 id')
          break
        }
        /*
         * ⚠️ **到期的三条专属判据**（M10.1 / ADR-086 `D07`）：
         *    ⚠️ **截止时间在目标上，不在承诺上**（实测：`CommitmentState` 没有 `dueAt`；
         *       截止时间只存在于 `GoalState.time.dueAt`。M10 里目标与承诺 1:1 ⇒
         *       "承诺到期"= **它所属目标的截止时间过去了**）。
         *    ① 目标**必须有** `time.dueAt`（没有截止就谈不上到期 —— 不得凭空到期）；
         *    ② 报上来的 `dueAt` 必须**等于**目标的 `time.dueAt`（防止拿别的时点充当依据）；
         *    ③ `expiredAt` 必须**不早于** `dueAt`（时间不能倒着走）。
         *    ⇒ "到期"因此是**可核对的时间事实**，不是调用方一句话。
         */
        if (target.type === COMMITMENT_EXPIRED) {
          const goalDueAt = current.goal.time?.dueAt
          if (goalDueAt === undefined) {
            reject(
              rejected,
              target.type,
              'completion_evidence_missing',
              `目标 ${goalId} 没有截止时间（\`time.dueAt\`）⇒ 谈不上到期`,
            )
            break
          }
          if (Number(payload.dueAt) !== Number(goalDueAt)) {
            reject(
              rejected,
              target.type,
              'goal_revision_conflict',
              `报上来的 dueAt=${String(payload.dueAt)} 与目标的 dueAt=${String(goalDueAt)} 不一致`,
            )
            break
          }
          if (Number(payload.expiredAt) < Number(payload.dueAt)) {
            reject(
              rejected,
              target.type,
              'goal_revision_conflict',
              `expiredAt=${String(payload.expiredAt)} 早于 dueAt=${String(payload.dueAt)}（时间不能倒着走）`,
            )
            break
          }
        }
        break
      }

      default:
        reject(rejected, target.type, 'goal_proposal_unknown_operation', `未处理的类型 ${target.type}`)
        break
    }
  }

  if (rejected.length > 0) return finishRejected()

  /*
   * 语义全部通过 ⇒ 按阶段 C 已经算好的身份逐个接受（**不再重算**：
   * 重算一次就有第二个推导点，而两个推导点迟早不一致）。
   */
  const acceptedEvents: AcceptedDomainEvent[] = proposal.targetEvents.map((target, index) =>
    accept({ ...target, payload: identities[index]!.payload }, proposal, identities[index]!.unit),
  )

  return {
    proposalId: String(proposal.proposalId) as ProposalId,
    characterId: proposal.characterId,
    accepted: true,
    acceptedEvents,
    rejected: [],
  }
}

// ---------------------------------------------------------------------------
// 便捷：构造一个目标创建提案（装配层 / 门用；不复制业务规则）
// ---------------------------------------------------------------------------

export interface NewGoalProposalInput {
  proposalId: string
  operation: GoalOperation
  characterId: string
  processor: string
  processorVersion: string
  sourceConversationEventIds: readonly string[]
  sourceQualifications: readonly GoalSourceQualification[]
  targets: readonly ProposedDomainEvent[]
}

/** 只是把调用方给的东西装成 `GoalProposal`（**不做**任何校验/推断） */
export function goalProposalOf(input: NewGoalProposalInput): GoalProposal {
  return {
    proposalId: input.proposalId as ProposalId,
    characterId: input.characterId as never,
    proposalType: 'goal-operation',
    sourceConversationEventIds: input.sourceConversationEventIds as never,
    payload: { operation: input.operation },
    targetEvents: [...input.targets],
    processor: input.processor,
    processorVersion: input.processorVersion,
    status: 'created',
    createdAt: 0,
    sourceQualifications: [...input.sourceQualifications],
  }
}
