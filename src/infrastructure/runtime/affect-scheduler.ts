/**
 * AffectScheduler —— M8 情绪评估的**生产调度装配**（WP4 / ADR-066 §6.3）。
 *
 * ============================================================================
 *  为什么没有"攒尾窗"（与 M7 调度策略的关键差异）
 * ============================================================================
 * M7 的 R-1（陪伴累积）要跨日攒窗口，所以零提案尾窗要**持有**。
 * M8 的全部规则都是**逐事件即时**的（M8-D08：每条合格用户事件 1 touch +
 * 至多 1 主导 impact）——不存在"攒够才触发"的规则，持有只会让尾窗无界生长。
 *
 * ⇒ 策略：**尾窗非空即消费**。
 *   尾窗 = [水位+1 .. 账本最大序号]（不相交；水位只在消费后前进）
 *   · 全不合格尾窗（只有她的回复/系统事件）⇒ 0 提案 ⇒ 照常消费
 *     （这些事件永远不会变成合格证据，持有无意义）；
 *   · 有合格事件 ⇒ touch/impact 提案 ⇒ Validator 放行 ⇒ 落库。
 *
 * ============================================================================
 *  建档（cutover seeding）与中断恢复（ADR-066 §6.3）
 * ============================================================================
 *   · **播种**：未建档 ⇒ 以"当前账本最大序号"为 cutoverSequence 建 ORIGIN
 *     （M8-D05：切换前历史不重放）⇒ 走唯一放行口 ⇒ 落库 ⇒ 水位推进到 cutover。
 *   · **中断恢复**：ORIGIN 已落库但水位还没推进（播种在 apply 与
 *     advanceWatermark 之间崩溃）⇒ 从投影状态重读 cutoverSequence，
 *     把水位补推进到那里。切换前的事件按设计不重放，直接跳过。
 *   · **失败不抛**：播种/消费失败 ⇒ 水位不前进 ⇒ 下一轮尾窗覆盖同一批事件
 *     （补洞语义）；调用方（main.ts 的 open/send 链路）不被后台故障打断。
 *
 * ============================================================================
 *  纪律（与 memory / relationship job 同源）
 * ============================================================================
 *   · job 记录走 `character_jobs`（区间幂等键，部分唯一索引挡重复排期）；
 *   · 事件级幂等在 Validator（领域键 range 恒置零——跨窗口同源必然撞键）；
 *   · 水位基准是**账本最大序号**（latestCharacterEventSequence），
 *     不是角色计数器——计数器会被非账本路径消耗出空洞（M6.1 §11）。
 */
import {
  asCharacterId,
  createProposal,
  type CharacterId,
  type ConversationEventId,
  type JobId,
} from '../../kernel/contracts/index.ts'
import { AFFECT_ORIGIN } from '../../kernel/contracts/domain-event.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import type { AffectTurnObservation } from '../../kernel/app/turn-gateway.ts'
import {
  AFFECT_ORIGIN_PROPOSAL_TYPE,
  type AffectOriginPayload,
  type AffectState,
} from '../../kernel/contracts/affect.ts'
import {
  AFFECT_EVALUATOR_NAME,
  AFFECT_EVALUATOR_VERSION,
} from '../../kernel/app/affect/evaluator.ts'
import {
  AFFECT_JOB_TRIGGER_KIND,
  affectEvaluationIdempotencyKey,
  runAffectEvaluation,
  type AffectJobPorts,
} from '../../kernel/app/affect/job.ts'
import { validateAffectProposal } from '../../kernel/policies/affect-validator.ts'
import { affectReducerFor, affectReducerV2For } from '../../kernel/projections/affect.ts'
import {
  conversationEventsInRange,
  latestCharacterEventSequence,
} from '../persistence/conversation-store.ts'
import { applyAcceptedEvents } from '../persistence/event-store.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  getWatermark,
  hasProcessedOperation,
  markJobRunning,
} from '../persistence/job-store.ts'
import { getAffectProjection } from '../persistence/affect-store.ts'
import type { RawDb } from '../persistence/db.ts'

/** 播种者的处理器身份（审计：ORIGIN 是谁建的） */
export const AFFECT_ORIGIN_SEEDER_NAME = 'affect-origin-seeder'
export const AFFECT_ORIGIN_SEEDER_VERSION = 'affect-origin-seeder@1'

/** ORIGIN payload 的 policyVersion（ADR-066 §2.3 冻结值） */
export const AFFECT_POLICY_VERSION = 'affect-policy@1'

/** 分页读账本的页大小（与 M7 调度同值） */
const PAGE_SIZE = 2000

// ---------------------------------------------------------------------------
// 端口工厂（真存储）
// ---------------------------------------------------------------------------

export function createAffectJobPorts(
  db: RawDb,
  options: {
    /**
     * M8.5 WP8：注册哪一版 affect 折叠器。缺省 1（生产现状——M8 逐字不变）；
     * 2 只在 WP13 激活（受控 rebuild 重盖 @2 章之后）由装配层显式传入。
     * 隔离门传 2 以端到端演练语义模式（A==B：非语义事件折叠结果两版一致）。
     */
    affectReducerVersion?: 1 | 2
  } = {},
): AffectJobPorts {
  return {
    registry: createFullDomainEventRegistry(),
    loadWindowEvents: (cid, from, to) =>
      conversationEventsInRange(db, cid, from, to, PAGE_SIZE),
    getAffectState: async (cid) => (await getAffectProjection(db, cid))?.state,
    hasProcessed: (key) => hasProcessedOperation(db, key),
    reducersFor: (cid: CharacterId) =>
      [options.affectReducerVersion === 2 ? affectReducerV2For(cid) : affectReducerFor(cid)],
    applyAccepted: (cid, accepted, reducers, now) =>
      applyAcceptedEvents(db, cid, accepted, reducers, now),
  }
}

// ---------------------------------------------------------------------------
// 建档（cutover seeding）与中断恢复
// ---------------------------------------------------------------------------

export type AffectSeedOutcome =
  | { kind: 'seeded'; cutoverSequence: number; domainEventId: string }
  | { kind: 'already'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; error: string }

/**
 * 情绪建档播种：中性起点（0/0）+ cutoverSequence = 当前账本最大序号。
 *
 * 走**唯一放行口**（validateAffectProposal）——播种被拒 = 不播种（不绕过），
 * 如实报告。幂等：已建档 ⇒ `already`；ORIGIN 幂等键撞库 ⇒ 放行口拒绝（如实报）。
 *
 * ⚠️ apply 与 advanceWatermark 是两步：中途崩溃 ⇒ 投影已建档但水位还在 0
 * ⇒ `recoverAffectCutoverWatermark` 补推进（这正是恢复路径存在的原因）。
 */
export async function seedAffectOrigin(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    /** 激活标识（审计：哪次激活建的档） */
    activationId: string
    /**
     * M8.5 WP8：注册哪一版折叠器（与 `createAffectJobPorts` 同一口径——
     * 版本守卫要求同一投影行全程同一版本；缺省 1 = 生产现状）。
     */
    affectReducerVersion?: 1 | 2
    now?: number
  }
): Promise<AffectSeedOutcome> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId

  const existing = await getAffectProjection(db, characterId)
  if (existing !== undefined && existing.state.originated) {
    return {
      kind: 'already',
      reason: `情绪投影已建档（r${String(existing.revision)}；cutover=${String(existing.state.cutoverSequence)}）`,
    }
  }

  const cutoverSequence = await latestCharacterEventSequence(db, characterId)
  const payload: AffectOriginPayload = {
    characterId,
    initialValence: 0,
    initialArousal: 0,
    originKind: 'ACTIVATION_BASELINE',
    activationId: input.activationId,
    cutoverAt: now,
    cutoverSequence,
    policyVersion: AFFECT_POLICY_VERSION,
  }
  const proposal = createProposal({
    characterId,
    proposalType: AFFECT_ORIGIN_PROPOSAL_TYPE,
    // ORIGIN 无对话来源（凭据是激活授权不是对话）：证据查找恒空，诚实留空
    sourceConversationEventIds: [],
    payload: { activationId: input.activationId, cutoverSequence },
    targetEvents: [{ type: AFFECT_ORIGIN, operation: 'create', payload }],
    processor: AFFECT_ORIGIN_SEEDER_NAME,
    processorVersion: AFFECT_ORIGIN_SEEDER_VERSION,
  })

  try {
    const deps = {
      registry: createFullDomainEventRegistry(),
      evidence: { findEvents: async (_ids: readonly ConversationEventId[]) => [] },
      processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
      affect: { getAffectState: async (cid: CharacterId) => (await getAffectProjection(db, cid))?.state },
      policy: { activeUserId: '' }, // ORIGIN 不查证据（P9）；active user 与建档无关
    }
    const outcome = await validateAffectProposal(deps, proposal)
    if (!outcome.accepted) {
      const codes = outcome.rejected.map((r) => r.code).join(', ')
      return { kind: 'rejected', reason: `放行口拒绝：${codes}` }
    }
    const applied = await applyAcceptedEvents(
      db,
      characterId,
      outcome.acceptedEvents,
      [input.affectReducerVersion === 2 ? affectReducerV2For(characterId) : affectReducerFor(characterId)],
      now
    )
    // 水位推进到 cutover（切换前事件按设计不重放——M8-D05）
    await advanceWatermark(
      db,
      characterId,
      AFFECT_EVALUATOR_NAME,
      AFFECT_EVALUATOR_VERSION,
      cutoverSequence,
      now
    )
    return {
      kind: 'seeded',
      cutoverSequence,
      domainEventId: String(applied.domainEvents[0]?.id ?? ''),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', error: message }
  }
}

/**
 * 中断播种恢复：ORIGIN 已落库（投影已建档）但水位 < cutoverSequence
 * ⇒ 把水位补推进到 cutover（切换前事件不重放，直接跳过）。
 *
 * 幂等：水位 ≥ cutover ⇒ no-op。不抛。
 */
export async function recoverAffectCutoverWatermark(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    now?: number
  }
): Promise<{ recovered: boolean; watermark: number; cutoverSequence: number | undefined }> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId

  const state: AffectState | undefined = (await getAffectProjection(db, characterId))?.state
  const watermarkRow = await getWatermark(
    db,
    characterId,
    AFFECT_EVALUATOR_NAME,
    AFFECT_EVALUATOR_VERSION
  )
  const watermark = watermarkRow?.processedThroughSequence ?? 0
  if (state === undefined || !state.originated) {
    return { recovered: false, watermark, cutoverSequence: undefined }
  }
  // 类型收窄：originated 状态的 cutoverSequence 必为数字（UNORIGINATED 才是 null）；
  // 防御性兜底——万一读到 null，如实报告不推进
  if (state.cutoverSequence === null) {
    return { recovered: false, watermark, cutoverSequence: undefined }
  }
  if (watermark >= state.cutoverSequence) {
    return { recovered: false, watermark, cutoverSequence: state.cutoverSequence }
  }
  await advanceWatermark(
    db,
    characterId,
    AFFECT_EVALUATOR_NAME,
    AFFECT_EVALUATOR_VERSION,
    state.cutoverSequence,
    now
  )
  return { recovered: true, watermark: state.cutoverSequence, cutoverSequence: state.cutoverSequence }
}

// ---------------------------------------------------------------------------
// 调度（尾窗非空即消费）
// ---------------------------------------------------------------------------

export type AffectSchedulerOutcome =
  | { kind: 'no_tail'; watermark: number; latest: number }
  | {
      kind: 'flushed'
      watermark: number
      latest: number
      jobId: string
      created: boolean
      /** 消费窗口（watermark+1 .. latest） */
      window: { from: number; to: number }
      proposals: number
      /** 合格事件数（= touch 提案数，M8-D08） */
      qualifiedEvents: number
      touchProposals: number
      impactProposals: number
      /** 命中的规则族 id（去重；只有 id——trace 纪律） */
      matchedRuleIds: string[]
      acceptedProposals: number
      rejectedProposals: number
      createdEvents: number
      /** 幂等命中数（同窗重跑/跨窗重叠 ⇒ >0 ⇒ 零新建） */
      deduplicated: number
      /** M8.5：被让位的词形 IMPACT 提案数（semantic 模式；缺省 0） */
      suppressedImpacts: number
      /** 投影 revision 迁移（空 = 本次没有新建事件 ⇒ revision 不动） */
      projectionChanges: { projectionType: string; fromRevision: number; toRevision: number }[]
      rejections: { proposalId: string; code: string; message: string }[]
    }
  | { kind: 'failed'; watermark: number; latest: number; error: string }

/**
 * 跑一次调度决策：建档检查（含播种/恢复）→ 尾窗非空即消费。
 *
 * 幂等且**不抛**（失败进 `kind: 'failed'`，调用方照常聊天）。
 * 重复调用安全：job 区间幂等键 + Validator 领域键（range 置零）双层挡重复。
 */
export async function maybeRunAffectEvaluation(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    /** 唯一 active user 的 id（M8-D11；生产 = resolveIds(userName).userId） */
    activeUserId: string
    /** 播种用的激活标识（缺省 = 'open-catchup'） */
    activationId?: string
    /**
     * M8.5 WP8：`semantic` 模式下词形路径让位 IMPACT（单写入者）。
     * 缺省不传 = M8 行为逐字不变。
     */
    suppressImpacts?: boolean
    /**
     * M8.5 WP8：注册哪一版 affect 折叠器（缺省 1 = 生产现状；2 = WP13
     * 激活后 / 隔离门演练语义模式）。与 `suppressImpacts` **相互独立**：
     * 版本是注册级决定，不随模式切换。
     */
    affectReducerVersion?: 1 | 2
    now?: number
  }
): Promise<AffectSchedulerOutcome> {
  const now = input.now ?? Date.now()
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId

  // ---- 建档检查：未建档先播种（失败 ⇒ 不消费，尾窗留给下一轮）----
  const projection = await getAffectProjection(db, characterId)
  if (projection === undefined || !projection.state.originated) {
    const seed = await seedAffectOrigin(db, {
      characterId,
      activationId: input.activationId ?? 'open-catchup',
      affectReducerVersion: input.affectReducerVersion,
      now,
    })
    if (seed.kind !== 'seeded' && seed.kind !== 'already') {
      // 播种被拒/失败：如实报告，不消费（消费了也全是 affect_not_originated 拒，
      // 且水位前进会让这批交互的 touch 永久丢失——失败关闭）
      const latest = await latestCharacterEventSequence(db, characterId)
      const watermarkRow = await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION)
      return {
        kind: 'failed',
        watermark: watermarkRow?.processedThroughSequence ?? 0,
        latest,
        error: `建档失败（${seed.kind}）：${seed.kind === 'rejected' ? seed.reason : seed.kind === 'failed' ? seed.error : ''}`,
      }
    }
  }

  // ---- 中断播种恢复：投影已建档但水位落后于 cutover ⇒ 补推进 ----
  await recoverAffectCutoverWatermark(db, { characterId, now })

  const watermarkRow = await getWatermark(
    db,
    characterId,
    AFFECT_EVALUATOR_NAME,
    AFFECT_EVALUATOR_VERSION
  )
  const watermark = watermarkRow?.processedThroughSequence ?? 0
  const latest = await latestCharacterEventSequence(db, characterId)
  if (latest <= watermark) {
    return { kind: 'no_tail', watermark, latest }
  }

  // ---- 消费：job 记录 → 正式跑 → 水位前进（失败不前进，补洞语义）----
  const ports = createAffectJobPorts(db, { affectReducerVersion: input.affectReducerVersion })
  const from = watermark + 1
  const to = latest
  const idempotencyKey = affectEvaluationIdempotencyKey({
    characterId,
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
    sourceFromSequence: from,
    sourceToSequence: to,
  })
  let job: { id: JobId } | undefined
  let jobCreated: boolean | undefined
  try {
    const { job: enqueued, created } = await enqueueJob(db, {
      characterId,
      processor: AFFECT_EVALUATOR_NAME,
      processorVersion: AFFECT_EVALUATOR_VERSION,
      sourceFromSequence: from,
      sourceToSequence: to,
      idempotencyKey,
      triggerKind: AFFECT_JOB_TRIGGER_KIND,
      now,
    })
    job = enqueued
    jobCreated = created
    await markJobRunning(db, enqueued.id, now)
    const outcome = await runAffectEvaluation(ports, {
      characterId,
      fromSequence: from,
      toSequence: to,
      activeUserId: input.activeUserId,
      suppressImpacts: input.suppressImpacts,
      now,
    })
    await finishJob(db, enqueued.id, 'completed', { now })
    await advanceWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION, to, now)
    return {
      kind: 'flushed',
      watermark,
      latest,
      jobId: String(enqueued.id),
      created: jobCreated,
      window: { from, to },
      proposals: outcome.proposals,
      qualifiedEvents: outcome.qualifiedEvents,
      touchProposals: outcome.touchProposals,
      impactProposals: outcome.impactProposals,
      matchedRuleIds: outcome.matchedRuleIds,
      acceptedProposals: outcome.acceptedProposals,
      rejectedProposals: outcome.rejectedProposals,
      createdEvents: outcome.applied.createdCount,
      deduplicated: outcome.applied.deduplicatedCount,
      suppressedImpacts: outcome.suppressedImpacts,
      projectionChanges: outcome.applied.projectionChanges,
      rejections: outcome.rejections,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    /*
     * 失败不抛：水位不前进 ⇒ 下一轮尾窗覆盖同一批事件（补洞）。
     *
     * 任务行**如实落 failed**（WP7 e2e A13 修）：job-store 的部分唯一索引
     * 就是为此设计的——failed 的幂等键允许重建，重试才有活路；若留
     * running，下一次同窗重试会撞 `job_not_pending`，"补洞"永远走不通
     * （且审计面上躺着一条永不结束的 running——违背"没成功就没成功
     * 口吻"）。finishJob 自己失败（库已坏）则吞掉：主错误才是要报的。
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

/**
 * M8 / WP6 任务 7/8：调度结局 → 网关观测（`AffectTurnObservation`）。
 *
 * 这是**生产映射**（main.ts 与 WP6 门共用同一份——门测的不是副本）。
 * kernel 不认识调度器（依赖方向），只认识观测形状；先例：reply_guard 的
 * observations 由装配层组装、网关落 trace。
 *
 * 属性纪律在这里就开始执行：拒码只留 code（message 正文不进 trace），
 * 投影迁移只取 affect:character 那一行（M8-D03：单投影，不分片）。
 */
export function affectTurnObservationOf(
  scheduling: AffectSchedulerOutcome | undefined,
  appliedThisTurn: boolean | 'unknown'
): AffectTurnObservation | undefined {
  if (scheduling === undefined) return undefined
  if (scheduling.kind === 'no_tail') {
    return { outcome: 'no_tail', appliedThisTurn }
  }
  if (scheduling.kind === 'failed') {
    return {
      outcome: 'failed',
      appliedThisTurn,
      window: { from: scheduling.watermark + 1, to: scheduling.latest },
      tailEvents: scheduling.latest - scheduling.watermark,
      error: scheduling.error,
    }
  }
  /*
   * 投影迁移取 affect:character 的**最后一条**变化：每条落库事件各推一次
   * revision（touch 与 impact 是两条事件 ⇒ 1→2→3），最后一条的 toRevision
   * 才等于渲染时读到的最终 revision——取第一条会把"半程 revision"当终态。
   */
  const affectChanges = scheduling.projectionChanges.filter(
    (change) => change.projectionType === 'affect:character'
  )
  const lastChange = affectChanges[affectChanges.length - 1]
  return {
    outcome: 'flushed',
    appliedThisTurn,
    window: scheduling.window,
    tailEvents: scheduling.window.to - scheduling.window.from + 1,
    qualifiedEvents: scheduling.qualifiedEvents,
    proposals: scheduling.proposals,
    touchProposals: scheduling.touchProposals,
    impactProposals: scheduling.impactProposals,
    matchedRuleIds: scheduling.matchedRuleIds,
    acceptedProposals: scheduling.acceptedProposals,
    rejectedProposals: scheduling.rejectedProposals,
    rejectionCodes: [...new Set(scheduling.rejections.map((r) => r.code))].sort(),
    createdEvents: scheduling.createdEvents,
    deduplicated: scheduling.deduplicated,
    ...(scheduling.suppressedImpacts > 0
      ? { suppressedImpacts: scheduling.suppressedImpacts }
      : {}),
    ...(lastChange !== undefined
      ? {
          projectionRevision: {
            from: lastChange.fromRevision,
            to: lastChange.toRevision,
          },
        }
      : {}),
  }
}
