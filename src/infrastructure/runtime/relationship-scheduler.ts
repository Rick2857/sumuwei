/**
 * RelationshipScheduler —— M7 关系评估的**生产调度装配**（WP6 / ADR-064）。
 *
 * ============================================================================
 *  为什么需要"策略"而不只是"每轮跑一次"
 * ============================================================================
 * 冻结规则集（ADR-064 附录 A）对窗口形状有两个方向相反的要求：
 *
 *   · R-2/R-3/R-4（语义规则）要**即时**：指控必须影响下一轮的行为
 *     （Level 1 出口条件），不能等窗口攒够。
 *   · R-1（陪伴累积）要**攒**：触发条件是"窗口内 ≥10 条 ESTABLISHED
 *     用户消息 · 跨 ≥2 自然日"。若每轮消费一个小窗口，这个条件永远
 *     不成立，R-1 在生产里就是死规则。
 *
 * 且幂等键的冻结形态（Validator §幂等键）决定了窗口**必须不相交**：
 * r2/r3/r4 的键含 range 分量 ⇒ 重叠窗口 = 同一次指控被计两次。
 *
 * ⇒ 策略：**攒尾窗（hold-to-accumulate）**
 *
 *   尾窗 = [水位+1 .. 账本最大序号]（不相交；水位只在消费时前进）
 *   每次先 dry-run 试算尾窗（评估器是确定性纯函数，零副作用）：
 *     · 提案 > 0（语义命中 / R-1 攒够 / R-5 里程碑跨过）⇒ **消费**：
 *       job 记录 → 正式跑 → 水位前进到尾窗上沿
 *     · 提案 = 0 ⇒ **持有**：不消费、不前进——这批事件留给未来的
 *       R-1 累积（"陪伴"本来就要跨天才有意义）
 *     · 尾窗实事件数 ≥ 上限（2000，loadWindowEvents 的钳制值）⇒
 *       强制消费（可加载性边界；正常情况下 R-5 每 100 条合格消息
 *       就会触发提案，零提案尾窗到不了这个量级——这是安全网）
 *
 *   自证：零提案尾窗天然有界——100 条合格用户消息必跨 R-5 里程碑
 *   ⇒ 提案 > 0 ⇒ 消费。所以"持有"不会无限堆积。
 *
 * ============================================================================
 *  纪律（与 memory job 同源）
 * ============================================================================
 *   · job 记录走 `character_jobs`（区间幂等键，部分唯一索引挡重复排期）；
 *   · 失败**不抛**：写进 job 的 failed + lastError，水位不前进，
 *     下一轮 / 下次 open 的尾窗自然覆盖未处理事件（补洞语义）；
 *     调用方（main.ts）在"用户刚说完话"的链路上，不该被后台故障打断。
 *   · 水位基准是**账本最大序号**（latestCharacterEventSequence），
 *     不是角色计数器——计数器会被非账本路径消耗出空洞（M6.1 §11）。
 *   · R-5 计数端口从**账本分页派生**（与评估器同一套资格判据
 *     processorEventViewOf + sourceQualificationOf，单一语义源）；
 *     不在 SQL 里复写资格语义（漂移风险）。量级边界见 WP6 交接单。
 */
import {
  asCharacterId,
  asEntityId,
  entityRef,
  type CharacterId,
  type EntityRef,
  type JobId,
} from '../../kernel/contracts/index.ts'
import { processorEventViewOf } from '../../kernel/app/memory/extractor.ts'
import { sourceQualificationOf } from '../../kernel/contracts/attribution.ts'
import { relationshipDayOf } from '../../kernel/contracts/relationship.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import {
  relationshipEvaluationIdempotencyKey,
  runRelationshipEvaluation,
  RELATIONSHIP_JOB_TRIGGER_KIND,
  type RelationshipJobPorts,
} from '../../kernel/app/relationship/job.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
} from '../../kernel/app/relationship/evaluator.ts'
import {
  conversationEventsInRange,
  latestCharacterEventSequence,
} from '../persistence/conversation-store.ts'
import {
  applyAcceptedEvents,
  getDomainEvent,
} from '../persistence/event-store.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  getWatermark,
  hasProcessedOperation,
  markJobRunning,
} from '../persistence/job-store.ts'
import { getRelationshipProjection } from '../persistence/relationship-store.ts'
import type { RawDb } from '../persistence/db.ts'

/** 零提案尾窗的强制消费上限（= loadWindowEvents 的钳制值；安全网，正常到不了） */
export const RELATIONSHIP_TAIL_EVENT_CAP = 2000

/** 分页读账本的页大小（钳制上限内取满） */
const PAGE_SIZE = 2000

// ---------------------------------------------------------------------------
// 端口工厂（真存储；R-5 计数从账本分页派生）
// ---------------------------------------------------------------------------

/** 分页读 [1 .. through] 的全部事件（覆盖钳制上限；无缺口） */
async function allEventsThrough(
  db: RawDb,
  characterId: CharacterId,
  throughSequence: number
): Promise<Parameters<typeof processorEventViewOf>[0][]> {
  const events: Parameters<typeof processorEventViewOf>[0][] = []
  let from = 1
  for (;;) {
    const page = await conversationEventsInRange(db, characterId, from, throughSequence, PAGE_SIZE)
    events.push(...page)
    if (page.length < PAGE_SIZE) break
    from = page[page.length - 1]!.sequence + 1
  }
  return events
}

/**
 * R-5 计数端口（账本派生）：合格消息 = `user_message` + ESTABLISHED 资格 +
 * KNOWN originator + originator.id == target —— 与评估器的
 * `qualifiedEvidenceGroups` 同一套判据（同一函数族），不在 SQL 里复写。
 */
export function createRelationshipJobPorts(db: RawDb): RelationshipJobPorts {
  const registry = createFullDomainEventRegistry()

  const qualifiedUserEvents = async (
    characterId: CharacterId,
    targetUserId: string,
    throughSequence: number
  ) => {
    const events = await allEventsThrough(db, characterId, throughSequence)
    const qualified: { createdAt: number }[] = []
    for (const event of events) {
      /*
       * tool_event 先跳过再转视图（L-M8-13 修复，M9 WP0-R；与 job.ts 的
       * 窗口过滤同一形状）：`processorEventViewOf` 对 tool_event 失败关闭，
       * 账本里出现任何一条 tool 事件都会让 R-5 计数端口抛错——判据上
       * tool 事件本来就不可能是合格消息（type ≠ user_message 第一关就挡），
       * 跳过不放松任何保证。
       */
      if (event.actorType === 'tool') continue
      const view = processorEventViewOf(event)
      if (view.type !== 'user_message') continue
      if (sourceQualificationOf(view.trustedOrigin) !== 'ESTABLISHED') continue
      const originator = view.trustedOrigin?.contentOriginator
      if (originator === undefined || originator.state !== 'KNOWN') continue
      if (String(originator.value.id) !== targetUserId) continue
      qualified.push({ createdAt: event.createdAt })
    }
    return qualified
  }

  return {
    registry,
    loadWindowEvents: (cid, from, to) =>
      conversationEventsInRange(db, cid, from, to, PAGE_SIZE),
    getRelationshipState: async (cid, key) =>
      (await getRelationshipProjection(db, cid, entityRef('user', key.target)))?.state,
    getDomainEvent: async (id) => {
      const event = await getDomainEvent(db, id)
      return event === undefined ? undefined : { id: event.id, type: event.type }
    },
    hasProcessed: (key) => hasProcessedOperation(db, key),
    applyAccepted: (cid, accepted, reducers, now) =>
      applyAcceptedEvents(db, cid, accepted, reducers, now),
    countQualifiedMessages: async (cid, targetUserId, through) =>
      (await qualifiedUserEvents(cid, targetUserId, through)).length,
    countActiveDays: async (cid, targetUserId, through) => {
      const qualified = await qualifiedUserEvents(cid, targetUserId, through)
      return new Set(qualified.map((e) => relationshipDayOf(e.createdAt))).size
    },
  }
}

// ---------------------------------------------------------------------------
// 调度（攒尾窗策略）
// ---------------------------------------------------------------------------

export type RelationshipSchedulerOutcome =
  | { kind: 'no_tail'; watermark: number; latest: number }
  | {
      kind: 'held'
      reason: string
      watermark: number
      latest: number
      tailEvents: number
    }
  | {
      kind: 'flushed'
      watermark: number
      latest: number
      jobId: string
      created: boolean
      proposals: number
      acceptedProposals: number
      rejectedProposals: number
      createdEvents: number
    }
  | { kind: 'failed'; watermark: number; latest: number; error: string }

/**
 * 跑一次调度决策：试算尾窗 → 消费或持有。
 *
 * 幂等且**不抛**（失败进 `kind: 'failed'`，调用方照常聊天）。
 * 重复调用安全：job 区间幂等键 + Validator 领域键双层挡重复。
 */
export async function maybeRunRelationshipEvaluation(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    owner: EntityRef
    now?: number
  }
): Promise<RelationshipSchedulerOutcome> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string'
      ? asCharacterId(input.characterId)
      : input.characterId

  const watermarkRow = await getWatermark(
    db,
    characterId,
    RELATIONSHIP_EVALUATOR_NAME,
    RELATIONSHIP_EVALUATOR_VERSION
  )
  const watermark = watermarkRow?.processedThroughSequence ?? 0
  const latest = await latestCharacterEventSequence(db, characterId)
  if (latest <= watermark) {
    return { kind: 'no_tail', watermark, latest }
  }

  const ports = createRelationshipJobPorts(db)
  const from = watermark + 1
  const to = latest

  // ---- 消费段整体入 try（含试算）："幂等且不抛"由结构保证（L-M8-13 修复，M9 WP0-R）----
  // 旧形状的试算在 try 之外：窗口里一条 tool 事件（或任何试算期异常）会
  // 直接穿透本函数——违反自己的契约，且 main.ts 的调用点在聊天链路上。
  // 新形状与 affect-scheduler 对齐：job 变量提升，catch 里对已建任务行如实落 failed。
  const idempotencyKey = relationshipEvaluationIdempotencyKey({
    characterId,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    sourceFromSequence: from,
    sourceToSequence: to,
  })
  let job: { id: JobId } | undefined
  try {
    // ---- 试算（零副作用）：这个窗口有没有规则会响？----
    const dry = await runRelationshipEvaluation(ports, {
      characterId,
      owner: input.owner,
      fromSequence: from,
      toSequence: to,
      now,
      dryRun: true,
    })
    const tailEvents = await conversationEventsInRange(db, characterId, from, to, PAGE_SIZE)

    if (dry.proposals === 0 && tailEvents.length < RELATIONSHIP_TAIL_EVENT_CAP) {
      return {
        kind: 'held',
        reason: '零提案——留给 R-1 跨日累积（持有不消费）',
        watermark,
        latest,
        tailEvents: tailEvents.length,
      }
    }

    // ---- 消费：job 记录 → 正式跑 → 水位前进（失败不前进，补洞语义）----
    const { job: enqueued, created } = await enqueueJob(db, {
      characterId,
      processor: RELATIONSHIP_EVALUATOR_NAME,
      processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
      sourceFromSequence: from,
      sourceToSequence: to,
      idempotencyKey,
      triggerKind: RELATIONSHIP_JOB_TRIGGER_KIND,
      now,
    })
    job = enqueued
    await markJobRunning(db, enqueued.id, now)
    const outcome = await runRelationshipEvaluation(ports, {
      characterId,
      owner: input.owner,
      fromSequence: from,
      toSequence: to,
      now,
    })
    await finishJob(db, enqueued.id, 'completed', { now })
    await advanceWatermark(
      db,
      characterId,
      RELATIONSHIP_EVALUATOR_NAME,
      RELATIONSHIP_EVALUATOR_VERSION,
      to,
      now
    )
    return {
      kind: 'flushed',
      watermark,
      latest,
      jobId: String(enqueued.id),
      created,
      proposals: outcome.proposals,
      acceptedProposals: outcome.acceptedProposals,
      rejectedProposals: outcome.rejectedProposals,
      createdEvents: outcome.applied.createdCount,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    /*
     * 失败不抛：水位不前进 ⇒ 下一轮尾窗覆盖同一批事件（补洞）。
     *
     * 任务行**如实落 failed**（L-M8-13 修复 (b)；形状 = affect-scheduler
     * WP7 A13 修）：job-store 的部分唯一索引只挡 pending/running/completed，
     * failed 的幂等键允许重建——同窗重试才有活路。旧形状把行留在 running：
     * 下一次同窗重试撞 `job_not_pending`，"补洞"永远走不通（M9 WP0 准入
     * 实验 E2b/E2c 复现的永久楔死）。finishJob 自己失败（库已坏）则吞掉：
     * 主错误才是要报的。
     */
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

/** main.ts 装配用：owner 引用的推导（与播种路径同一形状） */
export function relationshipOwnerOf(characterId: CharacterId | string): EntityRef {
  return entityRef('character', asEntityId(String(characterId)))
}
