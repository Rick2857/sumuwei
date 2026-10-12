/**
 * BeliefScheduler —— M9 信念双流的**生产调度装配**（WP6 / ADR-070 §6.3）。
 *
 * ============================================================================
 *  双流水位（两条独立输入流，各自水位，互不阻塞）
 * ============================================================================
 *   流 1 `belief-interaction-evaluator`：水位空间 = conversation_events.sequence
 *     （与 affect 同源：基准是账本最大序号，不是角色计数器——M6.1 §11）。
 *   流 2 `belief-memory-reconciler`：水位空间 = character_domain_events.sequence
 *     （消费 MEMORY_* 域事件；BELIEF_* 事件在同空间落库但被过滤——
 *     两条 belief 流互不消费对方的产出，防自反馈环）。
 *
 * ============================================================================
 *  建档（cutover seeding）与中断恢复（与 affect-scheduler 同构）
 * ============================================================================
 *   · **播种**：未建档 ⇒ 以"当前账本最大序号"为 cutoverSequence 建
 *     BELIEF_ORIGIN（切换前历史不重放——B-INFERRED 只采切换后的互动）⇒
 *     走唯一放行口 ⇒ 落库 ⇒ 流 1 水位推进到 cutover。
 *   · **中断恢复**：ORIGIN 已落库但流 1 水位还没推进（播种在 apply 与
 *     advanceWatermark 之间崩溃）⇒ 从投影状态重读 cutoverSequence，补推进。
 *   · **失败不抛**：播种/消费失败 ⇒ 水位不前进 ⇒ 下一轮尾窗覆盖同一批
 *     事件（补洞语义）；调用方（main.ts 的 open/send 链路）不被后台故障打断。
 *
 * ============================================================================
 *  尾窗策略（与 M8 同款：尾窗非空即消费）
 * ============================================================================
 *   全不合格尾窗（只有她的回复/系统事件/tool 事件）⇒ 0 提案 ⇒ 照常消费
 *   （这些事件永远不会变成合格证据，持有只会让尾窗无界生长）。
 *
 * ============================================================================
 *  ⚠️ turn hook ≠ 自主后台任务（计划 WP6 出口原文）
 * ============================================================================
 *   本调度只挂在 main.ts 的 open（追赶）/ send（同轮）两个既有钩子上；
 *   没有新建任何定时器、轮询或常驻 worker。开关关闭时零新增认知。
 *
 * 纪律：job 记录走 `character_jobs`（区间幂等键）；事件级幂等在 Validator
 * （领域键 range 恒置零——跨窗口同源必然撞键）；belief 投影走 belief-store
 * 的专用折叠（分片行 + 证据行清零语义），不走通用 applyAcceptedEvents。
 */
import {
  asCharacterId,
  asEntityId,
  computeIdempotencyKey,
  entityRef,
  type CharacterId,
  type ConversationEventId,
  type DomainEvent,
  type JobId,
} from '../../kernel/contracts/index.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import type { AcceptedDomainEvent } from '../../kernel/policies/validator.ts'
import { validateBeliefProposal, type BeliefValidatorDeps } from '../../kernel/policies/belief-validator.ts'
import {
  beliefEvidenceProjectionTypeOf,
  beliefSlotKeyOf,
  type BeliefOriginState,
  type BeliefState,
} from '../../kernel/contracts/belief.ts'
import { processorEventViewOf } from '../../kernel/app/memory/extractor.ts'
import {
  BELIEF_INTERACTION_EVALUATOR_NAME,
  BELIEF_INTERACTION_EVALUATOR_VERSION,
} from '../../kernel/app/belief/evaluator.ts'
import {
  BELIEF_INTERACTION_JOB_OPERATION,
  BELIEF_JOB_TRIGGER_KIND,
  BELIEF_MEMORY_JOB_OPERATION,
  BELIEF_MEMORY_RECONCILER_NAME,
  BELIEF_MEMORY_RECONCILER_VERSION,
  runBeliefInteractionWindow,
  runBeliefMemoryWindow,
  type BeliefApplyOutcome,
  type BeliefInteractionOutcome,
  type BeliefJobPorts,
  type BeliefMemoryOutcome,
} from '../../kernel/app/belief/job.ts'
import {
  conversationEventsInRange,
  findEventRefs,
  getConversationEvent,
  getConversationEventsByIds,
  latestCharacterEventSequence,
} from '../persistence/conversation-store.ts'
import { appendDomainEvent, domainEventsFor } from '../persistence/event-store.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  getJob,
  getWatermark,
  hasProcessedOperation,
  markJobRunning,
} from '../persistence/job-store.ts'
import {
  forbiddenRootsForSlot,
  getBelief,
  getBeliefEvidence,
  getBeliefOrigin,
  listActiveBeliefs,
} from '../persistence/belief-store.ts'
import { applyBeliefRows } from '../persistence/belief-store.ts'
import { createNativeMemoryStore } from '../persistence/memory-store.ts'
import { exec, type RawDb } from '../persistence/db.ts'
import { sql } from 'drizzle-orm'
import type { TrustedOriginReading } from '../../kernel/contracts/attribution.ts'
import type { ReconcilerMemoryView } from '../../kernel/app/belief/reconciler.ts'

/** 播种者的处理器身份（审计：ORIGIN 是谁建的） */
export const BELIEF_ORIGIN_SEEDER_NAME = 'belief-origin-seeder'
export const BELIEF_ORIGIN_SEEDER_VERSION = 'belief-origin-seeder@1'

/** ORIGIN payload 的 policyVersion（WP4 冻结口径） */
export const BELIEF_POLICY_VERSION = 'belief-evidence-policy@1'

/** 分页读账本的页大小（与 M7/M8 调度同值） */
export const BELIEF_PAGE_SIZE = 2000

/** Memory 域事件的前缀过滤面（流 2 只认这六类；其余域事件跳过） */
const MEMORY_EVENT_TYPES = new Set([
  'MEMORY_CREATED',
  'MEMORY_MERGED',
  'MEMORY_SUPERSEDED',
  'MEMORY_RETRACTED',
  'MEMORY_DISPUTED',
  'MEMORY_RESTORED',
])

// ---------------------------------------------------------------------------
// 基础助手
// ---------------------------------------------------------------------------

/** 域事件最大序号（流 2 的水位基准） */
export async function latestDomainEventSequence(
  db: RawDb,
  characterId: CharacterId,
): Promise<number> {
  const rows = await exec(
    db,
    sql`select coalesce(max(sequence), 0) as v from character_domain_events
        where character_id = ${characterId}`,
    '读取域事件最大序号',
  )
  return Number((rows[0] as { v: number | string } | undefined)?.v ?? 0)
}

/**
 * 落库：逐事件 appendDomainEvent（领域幂等键撞车 = deduplicated，**返回库中
 * 既有事件**）→ applyBeliefRows 折叠**全部返回事件**（新建 + 幂等命中）。
 *
 * 为什么幂等命中的事件也要折叠：折叠是收敛的（INV-M9-04 同根 no-op、
 * 终态守卫、FORMED 同 id no-op）⇒ 重折已折事件 = no-op；而"append 成功、
 * fold 失败"的断点（apply 断点）留下的投影滞后，恰好被重试窗口里的
 * 重折修复——不修复的话，重试会因全撞键而零折叠，滞后成为永久。
 */
export async function appendAndApplyBeliefEvents(
  db: RawDb,
  characterId: CharacterId,
  accepted: readonly AcceptedDomainEvent[],
  now = Date.now(),
): Promise<BeliefApplyOutcome> {
  const toFold: DomainEvent[] = []
  let deduplicated = 0
  for (const event of accepted) {
    const result = await appendDomainEvent(db, characterId, event, now)
    if (result.created) toFold.push(result.event)
    else {
      deduplicated += 1
      toFold.push(result.event)
    }
  }
  if (toFold.length > 0) {
    await applyBeliefRows(db, characterId, toFold, now)
  }
  return {
    createdEvents: toFold.length - deduplicated,
    deduplicated,
    appliedEvents: toFold.length,
  }
}

/** Job 级区间幂等键（与 affect/memory/relationship 同构；事件级键在 Validator） */
export function beliefInteractionJobKey(input: {
  characterId: CharacterId
  sourceFromSequence: number
  sourceToSequence: number
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: BELIEF_INTERACTION_EVALUATOR_NAME,
    processorVersion: BELIEF_INTERACTION_EVALUATOR_VERSION,
    sourceFromSequence: input.sourceFromSequence,
    sourceToSequence: input.sourceToSequence,
    operation: BELIEF_INTERACTION_JOB_OPERATION,
  })
}

export function beliefMemoryJobKey(input: {
  characterId: CharacterId
  sourceFromSequence: number
  sourceToSequence: number
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: BELIEF_MEMORY_RECONCILER_NAME,
    processorVersion: BELIEF_MEMORY_RECONCILER_VERSION,
    sourceFromSequence: input.sourceFromSequence,
    sourceToSequence: input.sourceToSequence,
    operation: BELIEF_MEMORY_JOB_OPERATION,
  })
}

// ---------------------------------------------------------------------------
// 端口工厂（真存储）
// ---------------------------------------------------------------------------

export function createBeliefJobPorts(db: RawDb): BeliefJobPorts {
  const memoryStore = createNativeMemoryStore(db)
  return {
    registry: createFullDomainEventRegistry(),
    loadWindowEvents: (characterId, fromSequence, toSequence) =>
      conversationEventsInRange(db, characterId, fromSequence, toSequence, BELIEF_PAGE_SIZE),
    loadMemoryEvents: async (characterId, fromSequence, toSequence) => {
      const events = await domainEventsFor(db, characterId, {
        afterSequence: fromSequence - 1,
        beforeSequence: toSequence,
        // 防御性配额：调度层已把窗口钳位到 ≤BELIEF_PAGE_SIZE 宽（区间内
        // 事件数必 ≤ 页大小），这里再显式给 limit——两层保证"读了 = 全读"
        limit: BELIEF_PAGE_SIZE,
      })
      return events.filter((event) => MEMORY_EVENT_TYPES.has(event.type))
    },
    findMemories: async (ids: readonly string[]): Promise<ReconcilerMemoryView[]> => {
      /*
       * ⚠️ **批量读**（`R-48`）：这里原先逐条 `memoryStore.get()`（4 次查询/条），
       *    而端口契约（`job.ts`「按 id 批量读 Memory 当前状态」）本来就要求批量。
       *    `getMany()` 与逐个 `get()` **逐条等价**（同一条 hydrate 路径），只是 4 次往返封顶。
       */
      const records = await memoryStore.getMany(ids as never)
      const out: ReconcilerMemoryView[] = []
      for (const record of records) {
        if (record === null) continue
        out.push({
          id: record.id,
          ownerId: String(record.owner.id),
          type: record.type,
          authority: record.authority,
          epistemicStatus: String(record.epistemicStatus),
          status: String(record.status),
          content: record.content,
          evidenceRootIds: record.evidenceRootIds,
          revision: record.revision,
        })
      }
      return out
    },
    findConversationEvents: async (ids: readonly ConversationEventId[]) => {
      const refs = await findEventRefs(db, ids)
      /*
       * ⚠️ **批量取回完整事件**（`R-48`）：原来逐 ref `getConversationEvent()`（1 次查询/条）。
       *    批量版走**同一个** `rowToEvent()` ⇒ `trustedOrigin` 的解码边界不变（`m5.1.1:k17`）。
       */
      const events = await getConversationEventsByIds(
        db,
        refs.map((ref) => ref.id)
      )
      const out: {
        id: ConversationEventId
        characterId: CharacterId
        sequence: number
        type: string
        actorId?: string
        conversationId?: string
        trustedOrigin?: TrustedOriginReading | undefined
      }[] = []
      refs.forEach((ref, index) => {
        // reported 的证据根 = Memory 的根（历史陈述）：放行口只查存在性/归属，
        // 但逐条取回完整事件以保真（type/actorId/trustedOrigin 如实带出，不伪造）
        const event = events[index]
        // tool 事件不能进 processorEventViewOf（楔死防御）——如实带原始 type、
        // 无信封（reported 分支不消费这些字段；存在性/归属检查照常生效）
        const view =
          event !== undefined && event.actorType !== 'tool'
            ? processorEventViewOf(event)
            : undefined
        out.push({
          id: ref.id,
          characterId: ref.characterId,
          sequence: ref.sequence,
          type: view?.type ?? event?.type ?? 'unknown',
          ...(view?.actorId !== undefined ? { actorId: view.actorId } : {}),
          ...(view?.conversationId !== undefined ? { conversationId: view.conversationId } : {}),
          trustedOrigin: view?.trustedOrigin,
        })
      })
      return out
    },
    belief: {
      getBeliefOrigin: (cid) =>
        getBeliefOrigin(db, cid).then((row) => row?.state as BeliefOriginState | undefined),
      getBelief: (cid, beliefId) =>
        getBelief(db, cid, beliefId).then((row) => row?.state as BeliefState | undefined),
      listActiveBeliefs: (cid) => listActiveBeliefs(db, cid),
      listActiveBeliefsForSlot: async (cid, slotKey) => {
        const actives = await listActiveBeliefs(db, cid)
        return actives.filter(
          (b) =>
            String(b.perspectiveOwnerId) === String(cid) &&
            String(b.subject?.id ?? '') !== '' &&
            slotKeyOfBelief(b) === slotKey,
        )
      },
      forbiddenRootsForSlot: (cid, slotKey) => forbiddenRootsForSlot(db, cid, slotKey),
      // 端口契约传的是**证据键**（`slotKey|value`，evaluator/job 的口径）；
      // belief-store 的行键是 `belief:evidence:<fnv1aHex(证据键)>`（写侧 =
      // projections/belief.ts:119 同一函数）。适配层的职责就是这层翻译——
      // 第一版漏了它：累计行永远读不到 ⇒ 跨窗口阈值永不满足 ⇒ 生产路径
      // BELIEF_FORMED 永不触发（WP6 门 r2-04 抓出的真缺陷）。
      getBeliefEvidence: (cid, evidenceKey) =>
        getBeliefEvidence(db, cid, beliefEvidenceProjectionTypeOf(evidenceKey)).then(
          (row) => row?.state ?? undefined,
        ),
    },
    hasProcessed: (key: string) => hasProcessedOperation(db, key),
    applyAccepted: (cid, accepted, now) => appendAndApplyBeliefEvents(db, cid, accepted, now),
  }
}

/** 信念行的槽位键（beliefs 行内分量复推——belief-store 无按槽位列，行内推导） */
function slotKeyOfBelief(belief: BeliefState): string {
  // 与 contracts.beliefSlotKeyOf 同一口径；这里从行内分量复推（读侧过滤用）
  return beliefSlotKeyOf({
    perspectiveOwnerId: belief.perspectiveOwnerId,
    subject: belief.subject,
    predicate: belief.proposition.predicate,
    scopeKey: belief.proposition.scopeKey,
  })
}

/** 调度器内部的 Validator deps（播种与门共用同一放行口） */
function beliefValidatorDepsOf(
  db: RawDb,
  options: { activeUserId: string },
): BeliefValidatorDeps {
  const ports = createBeliefJobPorts(db)
  return {
    registry: ports.registry,
    evidence: { findEvents: (ids: readonly ConversationEventId[]) => ports.findConversationEvents(ids) },
    processed: { hasProcessed: (key: string) => ports.hasProcessed(key) },
    belief: {
      getBeliefOrigin: (cid) => ports.belief.getBeliefOrigin(cid),
      getBelief: (cid, beliefId) => ports.belief.getBelief(cid, String(beliefId)),
      listActiveBeliefsForSlot: (cid, slotKey) => ports.belief.listActiveBeliefsForSlot(cid, slotKey),
      forbiddenRootsForSlot: (cid, slotKey) => ports.belief.forbiddenRootsForSlot(cid, slotKey),
    },
    policy: { activeUserId: options.activeUserId },
  }
}

// ---------------------------------------------------------------------------
// 建档（cutover seeding）与中断恢复
// ---------------------------------------------------------------------------

export type BeliefSeedOutcome =
  | { kind: 'seeded'; cutoverSequence: number }
  | { kind: 'already'; cutoverSequence: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; error: string }

export async function seedBeliefOrigin(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    activationId?: string
    now?: number
  },
): Promise<BeliefSeedOutcome> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId

  const existing = await getBeliefOrigin(db, characterId)
  if (existing !== undefined && existing.state.originated) {
    return { kind: 'already', cutoverSequence: existing.state.cutoverSequence }
  }

  const cutoverSequence = await latestCharacterEventSequence(db, characterId)
  const proposal = {
    proposalId: `belief-origin:${String(characterId)}:${String(cutoverSequence)}`,
    characterId,
    processor: BELIEF_ORIGIN_SEEDER_NAME,
    processorVersion: BELIEF_ORIGIN_SEEDER_VERSION,
    sourceConversationEventIds: [],
    targetEvents: [
      {
        type: 'BELIEF_ORIGIN',
        operation: 'create' as const,
        payload: {
          characterId,
          activationId: input.activationId ?? 'open-catchup',
          cutoverSequence,
          cutoverAt: now,
          policyVersion: BELIEF_POLICY_VERSION,
        },
      },
    ],
  }
  const deps = beliefValidatorDepsOf(db, { activeUserId: '' })
  const outcome = await validateBeliefProposal(deps, proposal as never)
  if (!outcome.accepted || outcome.acceptedEvents.length === 0) {
    return {
      kind: 'rejected',
      reason: outcome.rejected.map((r) => `${r.code}:${r.message}`).join('; '),
    }
  }
  try {
    const applied = await appendAndApplyBeliefEvents(db, characterId, outcome.acceptedEvents, now)
    if (applied.createdEvents === 0) {
      // 并发播种：另一路已建（append 撞幂等键）——读回 cutover 如实报告
      const row = await getBeliefOrigin(db, characterId)
      return { kind: 'already', cutoverSequence: row?.state.cutoverSequence ?? cutoverSequence }
    }
    // 流 1 水位推进到 cutover（切换前历史不重放）
    await advanceWatermark(
      db,
      characterId,
      BELIEF_INTERACTION_EVALUATOR_NAME,
      BELIEF_INTERACTION_EVALUATOR_VERSION,
      cutoverSequence,
      now,
    )
    return { kind: 'seeded', cutoverSequence }
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** 中断播种恢复：ORIGIN 在库但流 1 水位落后于 cutover ⇒ 补推进（不重放） */
export async function recoverBeliefCutoverWatermark(
  db: RawDb,
  input: { characterId: CharacterId | string; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId
  const origin = await getBeliefOrigin(db, characterId)
  if (origin === undefined || !origin.state.originated) return
  const watermarkRow = await getWatermark(
    db,
    characterId,
    BELIEF_INTERACTION_EVALUATOR_NAME,
    BELIEF_INTERACTION_EVALUATOR_VERSION,
  )
  const watermark = watermarkRow?.processedThroughSequence ?? 0
  if (watermark < origin.state.cutoverSequence) {
    await advanceWatermark(
      db,
      characterId,
      BELIEF_INTERACTION_EVALUATOR_NAME,
      BELIEF_INTERACTION_EVALUATOR_VERSION,
      origin.state.cutoverSequence,
      now,
    )
  }
}

// ---------------------------------------------------------------------------
// 流 1：交互评估调度（conversation 水位）
// ---------------------------------------------------------------------------

export type BeliefSchedulerOutcome =
  | { kind: 'no_tail'; watermark: number; latest: number }
  | {
      kind: 'flushed'
      watermark: number
      latest: number
      jobId: string
      jobCreated: boolean | undefined
      window: { from: number; to: number }
      outcome: BeliefInteractionOutcome
    }
  | {
      /** 水位断点恢复：同窗口 job 已 completed（活干完了），只补水位，不重跑 */
      kind: 'recovered'
      watermark: number
      latest: number
      jobId: string
      window: { from: number; to: number }
    }
  | { kind: 'failed'; watermark: number; latest: number; error: string }

export async function maybeRunBeliefEvaluation(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    /** 唯一 active user（资格四条之一；也是 v1 信念主体） */
    activeUserId: string
    activationId?: string
    now?: number
  },
): Promise<BeliefSchedulerOutcome> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId

  // ---- 建档检查：未建档先播种（失败 ⇒ 不消费，尾窗留给下一轮）----
  const origin = await getBeliefOrigin(db, characterId)
  if (origin === undefined || !origin.state.originated) {
    const seed = await seedBeliefOrigin(db, {
      characterId,
      activationId: input.activationId ?? 'open-catchup',
      now,
    })
    if (seed.kind !== 'seeded' && seed.kind !== 'already') {
      const latest = await latestCharacterEventSequence(db, characterId)
      const watermarkRow = await getWatermark(
        db,
        characterId,
        BELIEF_INTERACTION_EVALUATOR_NAME,
        BELIEF_INTERACTION_EVALUATOR_VERSION,
      )
      return {
        kind: 'failed',
        watermark: watermarkRow?.processedThroughSequence ?? 0,
        latest,
        error: `建档失败（${seed.kind}）：${seed.kind === 'rejected' ? seed.reason : seed.kind === 'failed' ? seed.error : ''}`,
      }
    }
  }
  await recoverBeliefCutoverWatermark(db, { characterId, now })

  const watermarkRow = await getWatermark(
    db,
    characterId,
    BELIEF_INTERACTION_EVALUATOR_NAME,
    BELIEF_INTERACTION_EVALUATOR_VERSION,
  )
  const watermark = watermarkRow?.processedThroughSequence ?? 0
  const latest = await latestCharacterEventSequence(db, characterId)
  if (latest <= watermark) {
    return { kind: 'no_tail', watermark, latest }
  }

  // ---- 消费：job 记录 → 正式跑 → 水位前进（失败不前进，补洞语义）----
  const ports = createBeliefJobPorts(db)
  const from = watermark + 1
  /*
   * 页边界钳位（计划 §728 的 2000/2001/4001 判据）：窗口宽度 ≤ 页大小 ⇒
   * 区间读永不截断 ⇒ "读了 = 全读"。超出部分留在尾窗，下一轮继续——
   * 水位只前进到本页页脚，绝不越过没读过的事件（跳读 = 永久丢失）。
   */
  const to = Math.min(latest, from + BELIEF_PAGE_SIZE - 1)
  const idempotencyKey = beliefInteractionJobKey({ characterId, sourceFromSequence: from, sourceToSequence: to })
  let job: { id: JobId } | undefined
  let jobCreated: boolean | undefined
  try {
    const { job: enqueued, created } = await enqueueJob(db, {
      characterId,
      processor: BELIEF_INTERACTION_EVALUATOR_NAME,
      processorVersion: BELIEF_INTERACTION_EVALUATOR_VERSION,
      sourceFromSequence: from,
      sourceToSequence: to,
      idempotencyKey,
      triggerKind: BELIEF_JOB_TRIGGER_KIND,
      now,
    })
    job = enqueued
    jobCreated = created
    if (!created) {
      const existing = await getJob(db, enqueued.id)
      if (existing !== undefined && existing.status === 'completed') {
        /*
         * 水位断点恢复（finishJob 与 advanceWatermark 之间崩溃）：同窗口
         * job 已完成——活干完了（事件在库、job 行是证据），重跑只会全撞
         * 领域幂等键；更不许把 completed 改写成 failed（成功了也别撒谎）。
         * 只补水位。
         */
        await advanceWatermark(
          db,
          characterId,
          BELIEF_INTERACTION_EVALUATOR_NAME,
          BELIEF_INTERACTION_EVALUATOR_VERSION,
          to,
          now,
        )
        return {
          kind: 'recovered',
          watermark,
          latest,
          jobId: String(enqueued.id),
          window: { from, to },
        }
      }
    }
    await markJobRunning(db, enqueued.id, now)
    const outcome = await runBeliefInteractionWindow(ports, {
      characterId,
      perspectiveOwnerId: asEntityId(String(characterId)),
      subject: entityRef('user', input.activeUserId),
      fromSequence: from,
      toSequence: to,
      activeUserId: input.activeUserId,
      now,
    })
    await finishJob(db, enqueued.id, 'completed', { now })
    await advanceWatermark(
      db,
      characterId,
      BELIEF_INTERACTION_EVALUATOR_NAME,
      BELIEF_INTERACTION_EVALUATOR_VERSION,
      to,
      now,
    )
    return {
      kind: 'flushed',
      watermark,
      latest,
      jobId: String(enqueued.id),
      jobCreated,
      window: { from, to },
      outcome,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 失败不抛：水位不前进 ⇒ 下一轮尾窗覆盖同一批（补洞）。
    // job 如实落 failed（部分唯一索引允许失败键重建——重试才有活路）。
    if (job !== undefined) {
      try {
        await finishJob(db, job.id, 'failed', { error: message, now })
      } catch {
        // 任务行留原状——不因记录失败而掩盖评估失败
      }
    }
    return { kind: 'failed', watermark, latest, error: message }
  }
}

// ---------------------------------------------------------------------------
// 流 2：Memory reconcile 调度（domain 水位）
// ---------------------------------------------------------------------------

export type BeliefMemorySchedulerOutcome =
  | { kind: 'no_tail'; watermark: number; latest: number }
  | {
      kind: 'flushed'
      watermark: number
      latest: number
      jobId: string
      jobCreated: boolean | undefined
      window: { from: number; to: number }
      outcome: BeliefMemoryOutcome
    }
  | {
      /** 水位断点恢复：同窗口 job 已 completed（活干完了），只补水位，不重跑 */
      kind: 'recovered'
      watermark: number
      latest: number
      jobId: string
      window: { from: number; to: number }
    }
  | { kind: 'failed'; watermark: number; latest: number; error: string }

export async function maybeRunBeliefMemoryReconciliation(
  db: RawDb,
  input: { characterId: CharacterId | string; now?: number },
): Promise<BeliefMemorySchedulerOutcome> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId

  /*
   * 流 2 不建档（BELIEF_ORIGIN 是交互流的切换边界；Memory 是既有域）。
   * 未建档时仍可消费：B-REPORTED 的形成不依赖 cutover（历史陈述）——
   * 但失效传播产 RETRACTED 会撞 belief_not_originated ⇒ 如实拒绝、
   * 播种后同窗口重跑即可补上（补洞语义）。
   */
  const watermarkRow = await getWatermark(
    db,
    characterId,
    BELIEF_MEMORY_RECONCILER_NAME,
    BELIEF_MEMORY_RECONCILER_VERSION,
  )
  const watermark = watermarkRow?.processedThroughSequence ?? 0
  const latest = await latestDomainEventSequence(db, characterId)
  if (latest <= watermark) {
    return { kind: 'no_tail', watermark, latest }
  }

  const ports = createBeliefJobPorts(db)
  const from = watermark + 1
  // 页边界钳位（同流 1：窗口宽度 ≤ 页大小，"读了 = 全读"，余量留尾窗）
  const to = Math.min(latest, from + BELIEF_PAGE_SIZE - 1)
  const idempotencyKey = beliefMemoryJobKey({ characterId, sourceFromSequence: from, sourceToSequence: to })
  let job: { id: JobId } | undefined
  let jobCreated: boolean | undefined
  try {
    const { job: enqueued, created } = await enqueueJob(db, {
      characterId,
      processor: BELIEF_MEMORY_RECONCILER_NAME,
      processorVersion: BELIEF_MEMORY_RECONCILER_VERSION,
      sourceFromSequence: from,
      sourceToSequence: to,
      idempotencyKey,
      triggerKind: BELIEF_JOB_TRIGGER_KIND,
      now,
    })
    job = enqueued
    jobCreated = created
    if (!created) {
      const existing = await getJob(db, enqueued.id)
      if (existing !== undefined && existing.status === 'completed') {
        // 水位断点恢复（同流 1）：活干完了，只补水位，不重跑、不改写 completed
        await advanceWatermark(
          db,
          characterId,
          BELIEF_MEMORY_RECONCILER_NAME,
          BELIEF_MEMORY_RECONCILER_VERSION,
          to,
          now,
        )
        return {
          kind: 'recovered',
          watermark,
          latest,
          jobId: String(enqueued.id),
          window: { from, to },
        }
      }
    }
    await markJobRunning(db, enqueued.id, now)
    const outcome = await runBeliefMemoryWindow(ports, {
      characterId,
      fromSequence: from,
      toSequence: to,
      now,
    })
    await finishJob(db, enqueued.id, 'completed', { now })
    await advanceWatermark(
      db,
      characterId,
      BELIEF_MEMORY_RECONCILER_NAME,
      BELIEF_MEMORY_RECONCILER_VERSION,
      to,
      now,
    )
    return {
      kind: 'flushed',
      watermark,
      latest,
      jobId: String(enqueued.id),
      jobCreated,
      window: { from, to },
      outcome,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (job !== undefined) {
      try {
        await finishJob(db, job.id, 'failed', { error: message, now })
      } catch {
        // 任务行留原状——不因记录失败而掩盖评估失败
      }
    }
    return { kind: 'failed', watermark, latest, error: message }
  }
}

// ---------------------------------------------------------------------------
// 观测（main.ts 日志与 WP6 门共用同一份——门测的不是副本）
// ---------------------------------------------------------------------------

export function describeBeliefScheduling(outcome: BeliefSchedulerOutcome): string {
  if (outcome.kind === 'no_tail') {
    return `无尾窗（水位 ${String(outcome.watermark)} = 账本 ${String(outcome.latest)}）`
  }
  if (outcome.kind === 'recovered') {
    return (
      `水位断点恢复：窗口 [${String(outcome.window.from)}, ${String(outcome.window.to)}] 的任务` +
      `已完成（job ${outcome.jobId}），补推进水位（不重跑、不改写 completed）`
    )
  }
  if (outcome.kind === 'failed') {
    return `失败（水位停在 ${String(outcome.watermark)}；补洞语义，下一轮重覆盖）—— ${outcome.error}`
  }
  const o = outcome.outcome
  return (
    `窗口 [${String(outcome.window.from)}, ${String(outcome.window.to)}] ` +
    `提案 ${String(o.proposals)}（记根 ${String(o.notedCount)}）· ` +
    `放行 ${String(o.acceptedProposals)} 拒 ${String(o.rejectedProposals)} · ` +
    `落库 ${String(o.applied.createdEvents)}（幂等命中 ${String(o.applied.deduplicated)}）` +
    (o.skippedToolEvents > 0 ? ` · tool 跳过 ${String(o.skippedToolEvents)}` : '')
  )
}

export function describeBeliefMemoryScheduling(outcome: BeliefMemorySchedulerOutcome): string {
  if (outcome.kind === 'no_tail') {
    return `无尾窗（水位 ${String(outcome.watermark)} = 域事件 ${String(outcome.latest)}）`
  }
  if (outcome.kind === 'recovered') {
    return (
      `水位断点恢复：窗口 [${String(outcome.window.from)}, ${String(outcome.window.to)}] 的任务` +
      `已完成（job ${outcome.jobId}），补推进水位（不重跑、不改写 completed）`
    )
  }
  if (outcome.kind === 'failed') {
    return `失败（水位停在 ${String(outcome.watermark)}；补洞语义，下一轮重覆盖）—— ${outcome.error}`
  }
  const o = outcome.outcome
  return (
    `窗口 [${String(outcome.window.from)}, ${String(outcome.window.to)}] ` +
    `Memory 事件 ${String(o.memoryEvents)} · 形成 ${String(o.formedProposals)} · ` +
    `失效 ${String(o.invalidationProposals)} · ` +
    `放行 ${String(o.acceptedProposals)} 拒 ${String(o.rejectedProposals)} · ` +
    `落库 ${String(o.applied.createdEvents)}（幂等命中 ${String(o.applied.deduplicated)}）`
  )
}
