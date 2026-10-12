/**
 * AffectEvaluationJob —— 情绪评估的任务化编排（M8 WP3/WP4 / ADR-066）。
 *
 * ============================================================================
 *  复用 M2.5 的 Job 体系（与 memory / relationship job 同一条纪律）
 * ============================================================================
 *     triggerKind = conversation · 输入 = source event range
 *     不新建任务表：`character_jobs` / `processed_operations` /
 *     `processor_watermarks` 照用（零迁移前提已在 WP0 P4 实验证明）。
 *
 * 编排链（本文件只做装配，不做判断——判断在评估器与 Validator）：
 *
 *     窗口事件 → ProcessorEventView → 评估器提案（逐事件 touch + 主导 impact）
 *     → Validator 放行 → applyAcceptedEvents（事务：append + 幂等 + 纯折叠 + 乐观锁）
 *
 * 两条硬纪律：
 *   · **REJECT 是正常结果**（与 M7 同源）：被拒提案记录在案、不重试、
 *     不让整批失败——同一窗口里合法提案照常落库；
 *   · **证据查找用窗口内事件**（内存适配）：评估器只引用窗口内事件，
 *     引用窗外 = 查不到 = `source_event_missing` 失败关闭——这正是想要的行为。
 *
 * 与 M7 job 的差异：**单投影 reducer**（affect:character 不分片）——
 * reducers 数组恒为一个 `affectReducerFor(characterId)`，没有 per-target 装配。
 */
import {
  AFFECT_IMPACT,
  computeIdempotencyKey,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type DomainEventRegistry,
  type ProcessorContext,
  type ProcessorEventView,
} from '../../contracts/index.ts'
import type { ProjectionReducer } from '../../contracts/projection.ts'
import type { AffectState } from '../../contracts/affect.ts'
import { processorEventViewOf } from '../memory/extractor.ts'
import type { AcceptedDomainEvent } from '../../policies/validator.ts'
import { validateAffectProposal } from '../../policies/affect-validator.ts'
import { affectReducerFor } from '../../projections/affect.ts'
import {
  AFFECT_EVALUATOR_NAME,
  AFFECT_EVALUATOR_VERSION,
  RuleBasedAffectEvaluator,
  type AffectProposalAudit,
} from './evaluator.ts'
import type { DomainProposal } from '../../contracts/proposal.ts'

export const AFFECT_JOB_TRIGGER_KIND = 'conversation' as const

/** Job 级幂等键的操作分量（事件级键的领域推导在 Validator，不在 Job） */
export const AFFECT_JOB_OPERATION = 'affect-evaluation' as const

/**
 * 情绪评估任务的幂等键（**区间键**，与 relationship/memory 同构）：
 * 后台评估一次处理一段事件区间，整批是一个工作单元——
 * 重复排期同一区间被 `character_jobs` 的部分唯一索引挡住。
 * 事件级的键（touch/impact 按 sourceEventId）由 Validator 用
 * `idempotencyKeyForAffectEvent` 另行推导——两层键各管各的重复。
 */
export function affectEvaluationIdempotencyKey(input: {
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
    operation: AFFECT_JOB_OPERATION,
  })
}

// ---------------------------------------------------------------------------
// 端口（装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

export interface AffectApplyOutcome {
  /** 本次新建的域事件数（幂等命中时为 0） */
  createdCount: number
  /** 幂等命中数 */
  deduplicatedCount: number
  /** 因乱序被跳过的投影更新数（含"别的 Character 的事件"——own 判定的正常跳过） */
  skippedStale: number
  projectionChanges: { projectionType: string; fromRevision: number; toRevision: number }[]
}

export interface AffectJobPorts {
  registry: DomainEventRegistry
  /** 读窗口事件（含归因信封；按 sequence 升序） */
  loadWindowEvents(
    characterId: CharacterId,
    fromSequence: number,
    toSequence: number
  ): Promise<ConversationEvent[]>
  /** 读情绪投影状态（建档判断 + cutover 边界） */
  getAffectState(characterId: CharacterId): Promise<AffectState | undefined>
  /** 幂等查询 */
  hasProcessed(idempotencyKey: string): Promise<boolean>
  /**
   * M8.5 WP8：本装配注册的 affect 折叠器（版本是**注册级**决定——生产 @1；
   * WP13 激活 rebuild 后 @2。A==B 保证 @2 对非语义事件折叠结果与 @1 逐字段
   * 一致，因此切换注册不改变 rules 模式的落库结果）。
   */
  reducersFor(characterId: CharacterId): readonly ProjectionReducer<unknown>[]
  /** 落库（事务内：append + 幂等记录 + 纯折叠 + 乐观锁） */
  applyAccepted(
    characterId: CharacterId,
    accepted: readonly AcceptedDomainEvent[],
    reducers: readonly ProjectionReducer<unknown>[],
    now?: number
  ): Promise<AffectApplyOutcome>
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

export interface AffectEvaluationRunInput {
  characterId: CharacterId
  fromSequence: number
  toSequence: number
  /** 唯一 active user 的 id（M8-D11；生产 = resolveIds(userName).userId） */
  activeUserId: string
  now?: number
  /**
   * 试算模式：只跑评估器数提案，不验证、不落库、不产生任何副作用。
   *
   * 用途：`--dry-run` 开发者面与 WP6 的降级路径预判。评估器是确定性
   * 纯函数 ⇒ 试算与正式跑产出**相同**提案集。
   */
  dryRun?: boolean
  /** 审计用 traceId（写进 TOUCH/IMPACT payload；启动 catch-up 无则缺省） */
  traceId?: string
  /**
   * M8.5 WP8（计划 §4.2 单写入者）：`semantic` 模式下词形路径**让位 IMPACT**——
   * 评估器产出的 AFFECT_IMPACT 提案在进放行口之前被丢弃（计数进
   * `suppressedImpacts`），TOUCH/ORIGIN 照旧（结构性入口不动）。
   *
   * 缺省不传/`false` = M8 行为**逐字不变**（词形 IMPACT 照常提交）。
   * 丢弃发生在验证之前：被让位的提案不产生拒绝记录（它们不是"被拒"，
   * 是"让位"——放行口拒绝语义留给真违规）。
   */
  suppressImpacts?: boolean
}

export interface AffectEvaluationRejection {
  proposalId: string
  code: string
  message: string
}

export interface AffectEvaluationOutcome {
  window: { fromSequence: number; toSequence: number }
  /** 评估器产出的提案总数 */
  proposals: number
  /** 窗口内被跳过的 tool_event 数（M8-D04：永不是情绪证据；楔死防御，见 runAffectEvaluation） */
  skippedToolEvents: number
  /** 合格事件数（产出 touch 的事件——每合格事件恰 1 个 touch，M8-D08） */
  qualifiedEvents: number
  /** touch 提案数（= qualifiedEvents） */
  touchProposals: number
  /** impact 提案数（≤ touchProposals：只有主导规则命中才有） */
  impactProposals: number
  /** M8.5：被让位的词形 IMPACT 提案数（`suppressImpacts` 时 = impactProposals；缺省 0） */
  suppressedImpacts: number
  /** 命中的规则族 id（去重；**只有 id**——trace 纪律：不带正文） */
  matchedRuleIds: string[]
  acceptedProposals: number
  rejectedProposals: number
  /** 被拒明细（REJECT 是正常结果——记录在案，不重试不炸批） */
  rejections: AffectEvaluationRejection[]
  applied: AffectApplyOutcome
}

/**
 * 跑一次情绪评估窗口。
 *
 * 幂等性：同窗口重跑 → 评估器产出相同提案 → Validator 的领域幂等键命中
 * （touch/impact 按 sourceEventId）→ 全部 duplicate → `createdCount = 0`。
 * 跨窗口重覆盖（失败重试 / 启动 catch-up）同样撞键——range 恒置零
 * （见 affect-validator.ts 文件头）。
 */
export async function runAffectEvaluation(
  ports: AffectJobPorts,
  input: AffectEvaluationRunInput
): Promise<AffectEvaluationOutcome> {
  const now = input.now ?? Date.now()

  // ---- 窗口事件 → 视图（processorEventViewOf 是受信读数的唯一产出点，ADR-043 DR-6）----
  const events = await ports.loadWindowEvents(
    input.characterId,
    input.fromSequence,
    input.toSequence
  )
  /*
   * tool_event 在这里**跳过**（M8-D04：工具内容永远不是情绪证据）。
   *
   * `processorEventViewOf` 对 tool_event 失败关闭（M4 抽取器的输入边界——
   * 计划书第 154 节），那是**记忆抽取**的纪律；情绪评估复用该函数时必须
   * 自己处理第四种 actorType。若不跳过：窗口里出现一条 tool_event ⇒
   * 评估 failed ⇒ 水位冻结 ⇒ 之后每个窗口都还含它 ⇒ **永久楔死**
   * （ADR-066 §6.2 的失败是"逐窗可恢复"的，这里违背——WP7 e2e 的 A10
   * 实测到这个楔死）。跳过不放松任何保证：评估器本来就只认
   * user_message + ESTABLISHED + active user（M8-D11），tool 事件
   * 在任何情况下都不可能成为证据；账本里它原样可查。
   */
  const skippedToolEvents = events.filter((event) => event.actorType === 'tool').length
  const views: ProcessorEventView[] = events
    .filter((event) => event.actorType !== 'tool')
    .map((event) => processorEventViewOf(event))

  // ---- 投影状态（建档判断 + cutover 边界——资格判定的状态面）----
  const state = await ports.getAffectState(input.characterId)

  const evaluationInput = {
    characterId: input.characterId,
    views,
    policy: {
      activeUserId: input.activeUserId,
      cutoverSequence: state?.cutoverSequence ?? null,
    },
  }
  const context: ProcessorContext = {
    processorName: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  }
  const evaluator = new RuleBasedAffectEvaluator()
  const allProposals: DomainProposal<AffectProposalAudit>[] = await evaluator.process(
    evaluationInput,
    context
  )
  // M8.5 WP8：semantic 模式让位——词形 IMPACT 提案在放行口之前丢弃（TOUCH 照旧）。
  // 缺省不传 = 不过滤 = M8 逐字不变。
  const proposals: DomainProposal<AffectProposalAudit>[] =
    input.suppressImpacts === true
      ? allProposals.filter(
          (p) => !p.targetEvents.some((t) => t.type === AFFECT_IMPACT),
        )
      : allProposals
  const suppressedImpacts = allProposals.length - proposals.length

  // ---- 试算出口：到此为止，零副作用 ----
  if (input.dryRun === true) {
    return {
      window: { fromSequence: input.fromSequence, toSequence: input.toSequence },
      proposals: proposals.length,
      skippedToolEvents,
      suppressedImpacts,
      ...auditCountsOf(proposals),
      acceptedProposals: 0,
      rejectedProposals: 0,
      rejections: [],
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
    affect: { getAffectState: (characterId: CharacterId) => ports.getAffectState(characterId) },
    policy: { activeUserId: input.activeUserId },
  }

  const acceptedEvents: AcceptedDomainEvent[] = []
  const rejections: AffectEvaluationRejection[] = []
  let acceptedProposals = 0
  for (const proposal of proposals) {
    const outcome = await validateAffectProposal(validatorDeps, proposal)
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

  // ---- 落库：单投影 reducer（affect:character 不分片——与 M7 的 per-target 差异）----
  /*
   * M8.5 WP8：reducer 经端口注入（`ports.reducersFor`）——版本是**注册级**决定，
   * 不是模式级：生产注册 @1（M8 逐字不变）；WP13 激活时受控 rebuild 重盖 @2
   * 章后注册 @2（@2 对非语义事件与 @1 逐字段一致——A==B，M85-D19——因此
   * 激活后 rules 模式的折叠结果也不变）。投影行只许一个 reducer 版本
   * （event-store 版本守卫），混用会被如实拒绝。
   */
  const reducers = ports.reducersFor(input.characterId)

  const applied = await ports.applyAccepted(
    input.characterId,
    acceptedEvents,
    reducers,
    now
  )

  return {
    window: { fromSequence: input.fromSequence, toSequence: input.toSequence },
    proposals: proposals.length,
    skippedToolEvents,
    suppressedImpacts,
    ...auditCountsOf(proposals),
    acceptedProposals,
    rejectedProposals: proposals.length - acceptedProposals,
    rejections,
    applied,
  }
}

/** 从提案审计里提取 trace 友好的计数（合格事件数 / touch / impact / 规则族 id） */
function auditCountsOf(proposals: DomainProposal<AffectProposalAudit>[]): {
  qualifiedEvents: number
  touchProposals: number
  impactProposals: number
  matchedRuleIds: string[]
} {
  const sourceEvents = new Set<string>()
  const ruleIds = new Set<string>()
  let touch = 0
  let impact = 0
  for (const proposal of proposals) {
    const audit = proposal.payload
    if (audit.kind === 'touch') {
      touch += 1
      sourceEvents.add(String(audit.sourceEventId))
    } else {
      impact += 1
      if (audit.ruleId !== undefined) ruleIds.add(audit.ruleId)
    }
  }
  return {
    qualifiedEvents: sourceEvents.size,
    touchProposals: touch,
    impactProposals: impact,
    matchedRuleIds: [...ruleIds].sort(),
  }
}
