/**
 * BeliefValidator —— **信念事件的唯一放行口**（M9 WP4 / ADR-070 §4.2/§5.4）。
 *
 * ============================================================================
 *  为什么不复用 `DomainPolicyValidator`（与 memory / relationship / affect 同一裁定）
 * ============================================================================
 * 通用验证器的幂等键第五分量只有 `operation`；信念提案的工作单元是
 * **每事件一个领域单元**（一根证据 / 一次形成 / 一次强化 / 一次生命周期迁移），
 * 同批多条会算出同一个键被静默去重。因此这里**刻意重复**通用检查
 * （payload 形状 / 大小 / scope），**不重复**的是幂等键推导（§幂等键）。
 *
 * 共用的一律共用：`computeIdempotencyKey()`、registry 的 `validatePayload` /
 * `maxPayloadBytes`、`assertCharacterInternalScope`、资格四条
 * （`beliefEvidenceVerdictOf`——contracts 单源，评估器同源）。
 *
 * ---------------------------------------------------------------------------
 *  检查分层（拒绝码两套词汇，各有归属）
 * ---------------------------------------------------------------------------
 *   · Belief 业务码 = `BELIEF_REJECTION_CODES`（14 个，WP4 冻结；
 *     新码必须先改那张表——可审计）；
 *   · 管线通用码 = processor_version_presence / source_event_missing /
 *     source_event_foreign / payload_schema_invalid / payload_too_large /
 *     duplicate_operation / domain_event_type_not_allowed / scope_not_character_internal
 *     （跨模块一致，不另造同义词）。
 *
 * 失败关闭：引用不存在的事件、未建档先采信、阈值不够、同值重复建档、
 * 禁用根复用、非 active 的生命周期迁移、beliefId 不可复推——一律 reject。
 *
 * ---------------------------------------------------------------------------
 *  幂等键（range 分量恒置零——与 M7/M8 同一形态，理由更强）
 * ---------------------------------------------------------------------------
 * 信念的幂等身份是 `(character, processor, version, <unit>)`：
 *   EVIDENCE_NOTED  `belief-evidence:<rootEventId>:<ruleId>`（同根同规则跨窗口必撞）
 *   FORMED          `belief-formed:<beliefId>`（同 formationKey 重放必撞）
 *   REINFORCED      `belief-reinforced:<beliefId>:<fnv1a(sorted newRootIds)>`
 *   ORIGIN          `belief-origin`（一角色一次）
 *   DISPUTED        `belief-disputed:<beliefId>`
 *   SUPERSEDED      `belief-superseded:<old>:<new>`
 *   RETRACTED       `belief-retracted:<beliefId>`
 * 同一来源可能被不相重叠的窗口重复覆盖（重试 / catch-up / 尾部补消费）；
 * range 进键会让同一单元被计两次。置零让跨窗口同单元提案必然撞键。
 *
 * ---------------------------------------------------------------------------
 *  冲突与生命周期（ADR-070 §4.2——Validator 不猜，只挡结构违规）
 * ---------------------------------------------------------------------------
 * 异值现存 + 新 FORMED ⇒ **照放**（冲突是真实信号；DISPUTED 是显式事件，
 * 由 WP5 的生命周期产出者发）。同值现存 + 新 FORMED ⇒ 拒绝
 * （`belief_slot_already_active`——那是 REINFORCED 的事，重复建档是违规）。
 * 自动 dispute 不存在：投影按 oracle 折叠，两个 active 并存直到显式 DISPUTED。
 */
import {
  DOMAIN_EVENT_SCOPE,
  BELIEF_DISPUTED,
  BELIEF_EVIDENCE_NOTED,
  BELIEF_FORMED,
  BELIEF_ORIGIN,
  BELIEF_REINFORCED,
  BELIEF_RETRACTED,
  BELIEF_SUPERSEDED,
  assertCharacterInternalScope,
  computeIdempotencyKey,
  type BeliefDisputedPayload,
  type BeliefEvidenceNotedPayload,
  type BeliefFormedPayload,
  type BeliefOriginPayload,
  type BeliefOriginState,
  type BeliefReinforcedPayload,
  type BeliefRetractedPayload,
  type BeliefState,
  type BeliefSupersededPayload,
  type BeliefEvidenceVerdict,
  type BeliefEvidencePolicy,
  type BeliefId,
  type BeliefSlotKeyInput,
  type CharacterId,
  type ConversationEventId,
  type DomainEventScope,
  type DomainEventRegistry,
  type DomainProposal,
  type MemoryId,
  type MemoryType,
  type MemoryAuthority,
  type ProposedDomainEvent,
} from '../contracts/index.ts'
import {
  BELIEF_INFERRED_MIN_CONVERSATIONS,
  BELIEF_INFERRED_MIN_ROOTS,
  BELIEF_INFERRED_RULE_ID as INFERRED_RULE_ID,
  BELIEF_INFERRED_RULE_VERSION as INFERRED_RULE_VERSION,
  BELIEF_REPORTED_RULE_ID as REPORTED_RULE_ID,
  BELIEF_REPORTED_RULE_VERSION as REPORTED_RULE_VERSION,
  beliefEvidenceVerdictOf,
  beliefReportedFormationKeyOf,
  beliefReportedDependencyTokenOf,
  beliefSlotKeyOf,
  fnv1aHex,
  isBeliefReportedEligible,
  makeBeliefId,
} from '../contracts/belief.ts'
import type { TrustedOriginReading } from '../contracts/attribution.ts'
import type { AcceptedDomainEvent, RejectedTarget, ValidatorOutcome } from './validator.ts'

// ---------------------------------------------------------------------------
// 幂等键（领域推导；memory / relationship / affect 先例：住在放行口）
// ---------------------------------------------------------------------------

export function beliefEvidenceUnitOperation(
  rootEventId: ConversationEventId,
  ruleId: string,
): string {
  return `belief-evidence:${String(rootEventId)}:${ruleId}`
}

export function beliefFormedUnitOperation(beliefId: BeliefId): string {
  return `belief-formed:${String(beliefId)}`
}

export function beliefReinforcedUnitOperation(
  beliefId: BeliefId,
  newRootIds: readonly ConversationEventId[],
): string {
  const sorted = [...newRootIds].map(String).sort()
  return `belief-reinforced:${String(beliefId)}:${fnv1aHex(sorted.join(','))}`
}

export function beliefOriginUnitOperation(): string {
  return 'belief-origin'
}

export function beliefDisputedUnitOperation(beliefId: BeliefId): string {
  return `belief-disputed:${String(beliefId)}`
}

export function beliefSupersededUnitOperation(
  oldBeliefId: BeliefId,
  newBeliefId: BeliefId,
): string {
  return `belief-superseded:${String(oldBeliefId)}:${String(newBeliefId)}`
}

export function beliefRetractedUnitOperation(beliefId: BeliefId): string {
  return `belief-retracted:${String(beliefId)}`
}

export function idempotencyKeyForBeliefEvent(input: {
  characterId: CharacterId
  processor: string
  processorVersion: string
  operation: string
  unit: string
}): string {
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: 0,
    sourceToSequence: 0,
    operation: input.unit,
  })
}

// ---------------------------------------------------------------------------
// 依赖端口（由装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

/** 证据查找：资格复核要读 type / actorId / trustedOrigin / conversationId */
export interface BeliefEvidenceLookup {
  findEvents(
    ids: readonly ConversationEventId[],
  ): Promise<
    {
      id: ConversationEventId
      characterId: CharacterId
      sequence: number
      type: string
      actorId?: string
      conversationId?: string
      trustedOrigin?: TrustedOriginReading
    }[]
  >
}

/** 信念状态查找（读投影；建档存在性 / 现存冲突 / 禁用根） */
export interface BeliefStateLookup {
  getBeliefOrigin(characterId: CharacterId): Promise<BeliefOriginState | undefined>
  getBelief(characterId: CharacterId, beliefId: BeliefId): Promise<BeliefState | undefined>
  /** 同槽位的全部 active 信念（冲突信号下可能 >1） */
  listActiveBeliefsForSlot(characterId: CharacterId, slotKey: string): Promise<BeliefState[]>
  /** §5.4：本槽位已禁用的根事件并集（来自 BELIEF_RETRACTED 事件流） */
  forbiddenRootsForSlot(characterId: CharacterId, slotKey: string): Promise<string[]>
}

/**
 * Memory 依赖查找（WP5：B-REPORTED 的资格复核）。
 *
 * 返回**当前状态**视图（不是事件快照）——B-REPORTED 的采信前提是依赖的
 * Memory **此刻**仍在白名单内（`isBeliefReportedEligible`：claim 家族 +
 * EXPLICIT 权威档 + reported + active）。撤回/降档过的 Memory 不能再背书。
 */
export interface BeliefMemoryLookup {
  findMemories(
    ids: readonly MemoryId[],
  ): Promise<
    {
      id: MemoryId
      /** 拥有者（memory 子系统约定：owner.id 即 characterId） */
      ownerId: string
      type: MemoryType
      authority: MemoryAuthority
      epistemicStatus: string
      status: string
      /** 记录 revision（M9.1 WP8 / F-5）：> 1 并入身份分量 ⇒ 复活产出新 beliefId；缺省 1 = 基线 */
      revision?: number
    }[]
  >
}

export interface BeliefValidatorDeps {
  registry: DomainEventRegistry
  evidence: BeliefEvidenceLookup
  processed: { hasProcessed(idempotencyKey: string): Promise<boolean> }
  belief: BeliefStateLookup
  /**
   * Memory 依赖查找（可选装配：只有 B-REPORTED 路径需要）。
   * **缺失 = 失败关闭**：reported FORMED 无端口即拒（`belief_source_missing`），
   * 不存在"没装配就放行"。
   */
  memory?: BeliefMemoryLookup
  /** 资格判定的配置面（active user；cutover 来自建档行，不在这里） */
  policy: { activeUserId: string }
}

// ---------------------------------------------------------------------------
// 结构判据（给出登记过的码，而不是笼统的 schema 错误）
// ---------------------------------------------------------------------------

/** UTF-8 字节数（与 validator.ts 的 byteLength 同一换算；领域层不引 node 内置对象） */
function byteLength(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 事件类型 → 领域单元串（幂等键第五分量） */
function unitOperationOf(target: ProposedDomainEvent): string | undefined {
  const payload = target.payload as Record<string, unknown> | undefined
  switch (target.type) {
    case BELIEF_ORIGIN:
      return beliefOriginUnitOperation()
    case BELIEF_EVIDENCE_NOTED: {
      const p = payload as Partial<BeliefEvidenceNotedPayload>
      if (p?.rootEventId === undefined || p?.ruleId === undefined) return undefined
      return beliefEvidenceUnitOperation(p.rootEventId, p.ruleId)
    }
    case BELIEF_FORMED: {
      const p = payload as Partial<BeliefFormedPayload>
      if (p?.beliefId === undefined) return undefined
      return beliefFormedUnitOperation(p.beliefId)
    }
    case BELIEF_REINFORCED: {
      const p = payload as Partial<BeliefReinforcedPayload>
      if (p?.beliefId === undefined || p?.newRootIds === undefined) return undefined
      return beliefReinforcedUnitOperation(p.beliefId, p.newRootIds)
    }
    case BELIEF_DISPUTED: {
      const p = payload as Partial<BeliefDisputedPayload>
      if (p?.beliefId === undefined) return undefined
      return beliefDisputedUnitOperation(p.beliefId)
    }
    case BELIEF_SUPERSEDED: {
      const p = payload as Partial<BeliefSupersededPayload>
      if (p?.oldBeliefId === undefined || p?.newBeliefId === undefined) return undefined
      return beliefSupersededUnitOperation(p.oldBeliefId, p.newBeliefId)
    }
    case BELIEF_RETRACTED: {
      const p = payload as Partial<BeliefRetractedPayload>
      if (p?.beliefId === undefined) return undefined
      return beliefRetractedUnitOperation(p.beliefId)
    }
    default:
      return undefined
  }
}

/** 槽位分量（EVIDENCE_NOTED 平铺；FORMED 的 predicate/scopeKey 在 proposition 里） */
function slotInputOf(
  payload: {
    perspectiveOwnerId: unknown
    subject: unknown
    predicate: unknown
    scopeKey: unknown
  },
  eventType: string,
): BeliefSlotKeyInput | undefined {
  if (
    typeof payload.perspectiveOwnerId !== 'string' ||
    typeof payload.subject !== 'object' ||
    payload.subject === null ||
    typeof payload.predicate !== 'string' ||
    typeof payload.scopeKey !== 'string'
  ) {
    void eventType
    return undefined
  }
  return payload as unknown as BeliefSlotKeyInput
}

// ---------------------------------------------------------------------------
// 验证
// ---------------------------------------------------------------------------

export async function validateBeliefProposal(
  deps: BeliefValidatorDeps,
  proposal: DomainProposal,
): Promise<ValidatorOutcome> {
  const rejected: RejectedTarget[] = []
  const acceptedEvents: AcceptedDomainEvent[] = []

  const BELIEF_TYPES = [
    BELIEF_ORIGIN,
    BELIEF_EVIDENCE_NOTED,
    BELIEF_FORMED,
    BELIEF_REINFORCED,
    BELIEF_DISPUTED,
    BELIEF_SUPERSEDED,
    BELIEF_RETRACTED,
  ] as readonly string[]

  // ---- 提案级：处理器身份 -------------------------------------------------
  if (!proposal.processor || !proposal.processorVersion) {
    for (const target of proposal.targetEvents) {
      rejected.push({
        type: target.type,
        code: 'processor_version_presence',
        message: '提案缺 processor / processorVersion（放行口不认匿名提案）',
      })
    }
    return {
      proposalId: proposal.proposalId,
      characterId: proposal.characterId,
      accepted: false,
      acceptedEvents,
      rejected,
    }
  }

  // ---- 目标级 -------------------------------------------------------------
  for (const target of proposal.targetEvents) {
    const reject = (code: string, message: string): void => {
      rejected.push({ type: target.type, code, message })
    }

    // ① 类型 allowlist（Belief 链只认这七类）
    if (!BELIEF_TYPES.includes(target.type)) {
      reject(
        'domain_event_type_not_allowed',
        `Belief 验证器只放行 BELIEF_* 七类，收到 ${target.type}`,
      )
      continue
    }

    // ② 结构判据（registry 兜底形状与大小）
    const spec = deps.registry.get(target.type)
    if (spec === undefined) {
      reject('domain_event_type_not_allowed', `类型 ${target.type} 未登记`)
      continue
    }
    try {
      spec.validatePayload(target.payload)
    } catch (error) {
      reject(
        'payload_schema_invalid',
        error instanceof Error ? error.message : 'payload 结构校验失败',
      )
      continue
    }
    const payloadBytes = byteLength(JSON.stringify(target.payload))
    if (payloadBytes > spec.maxPayloadBytes) {
      reject(
        'payload_too_large',
        `payload ${String(payloadBytes)} 字节超过 ${target.type} 上限 ${String(spec.maxPayloadBytes)}`,
      )
      continue
    }

    // ③ scope（D10：Belief 事件只描述 CHARACTER_INTERNAL；assert 违规即抛）
    try {
      assertCharacterInternalScope((target.scope ?? DOMAIN_EVENT_SCOPE) as DomainEventScope)
    } catch {
      reject(
        'scope_not_character_internal',
        `Belief 事件的 scope 必须是 CHARACTER_INTERNAL（D10），收到 ${String(target.scope)}`,
      )
      continue
    }

    // 结构校验已过 ⇒ payload 是七类已验证形状之一
    const payload = target.payload as Record<string, unknown>

    // ④ owner 一致（伪造跨角色信念——失败关闭）
    if (String(payload.characterId) !== String(proposal.characterId)) {
      reject(
        'belief_owner_mismatch',
        `payload.characterId=${String(payload.characterId)} ≠ characterId=${String(proposal.characterId)}`,
      )
      continue
    }

    // ⑤ 幂等键的领域单元（结构已过 ⇒ 必能推导；防御性兜底）
    const unit = unitOperationOf(target)
    if (unit === undefined) {
      reject('payload_schema_invalid', '无法从 payload 推导领域单元（防御性兜底）')
      continue
    }
    const idempotencyKey = idempotencyKeyForBeliefEvent({
      characterId: proposal.characterId,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      operation: target.operation,
      unit,
    })
    if (await deps.processed.hasProcessed(idempotencyKey)) {
      reject('duplicate_operation', `幂等键已处理过（${target.type} 单元 ${unit}）`)
      continue
    }

    // ---- ⑥ 类型专属业务规则 ---------------------------------------------
    if (target.type === BELIEF_ORIGIN) {
      const origin = await deps.belief.getBeliefOrigin(proposal.characterId)
      if (origin !== undefined && origin.originated) {
        reject(
          'belief_origin_duplicate',
          `Character ${String(proposal.characterId)} 的信念域已建档；ORIGIN 一角色一次（ADR-070 §4.2）`,
        )
        continue
      }
      acceptedEvents.push(accept(target, proposal, idempotencyKey))
      continue
    }

    // 其余六类：没有建档就没有可采信的信念生活史
    const origin = await deps.belief.getBeliefOrigin(proposal.characterId)
    if (origin === undefined || !origin.originated) {
      reject(
        'belief_not_originated',
        `Character ${String(proposal.characterId)} 的信念域尚未建档，${target.type} 不放行`,
      )
      continue
    }
    const evidencePolicy: BeliefEvidencePolicy = {
      activeUserId: deps.policy.activeUserId,
      cutoverSequence: origin.cutoverSequence,
    }

    if (target.type === BELIEF_EVIDENCE_NOTED) {
      const noted = payload as unknown as BeliefEvidenceNotedPayload
      const slotInput = slotInputOf(noted, target.type)
      if (slotInput === undefined) {
        reject('payload_schema_invalid', 'EVIDENCE_NOTED 缺槽位分量（防御性兜底）')
        continue
      }
      // 规则标识（B-INFERRED 专属事件——B-REPORTED 不走证据累计）
      if (
        noted.ruleId !== INFERRED_RULE_ID ||
        noted.ruleVersion !== INFERRED_RULE_VERSION
      ) {
        reject(
          'belief_rule_version_unknown',
          `EVIDENCE_NOTED 的规则标识必须是 ${INFERRED_RULE_ID}@${INFERRED_RULE_VERSION}，` +
            `收到 ${String(noted.ruleId)}@${String(noted.ruleVersion)}`,
        )
        continue
      }
      // 证据三层：存在性 → 归属 → 资格四条（根必须是合格用户事件）
      const verdict = await evidenceVerdict(
        deps,
        proposal.characterId,
        [noted.rootEventId],
        evidencePolicy,
        reject,
      )
      if (verdict === undefined) continue
      // §5.4 遗忘契约：禁用根不得再进累计
      const slotKey = beliefSlotKeyOf(slotInput)
      const forbidden = await deps.belief.forbiddenRootsForSlot(proposal.characterId, slotKey)
      if (forbidden.includes(String(noted.rootEventId))) {
        reject(
          'belief_roots_forbidden',
          `根 ${String(noted.rootEventId)} 已被本槽位的 RETRACTED 禁用（§5.4：重放旧证据不复活，B28）`,
        )
        continue
      }
      acceptedEvents.push(accept(target, proposal, idempotencyKey))
      continue
    }

    if (target.type === BELIEF_FORMED) {
      const formed = payload as unknown as BeliefFormedPayload
      const slotInput = slotInputOf(
        {
          perspectiveOwnerId: formed.perspectiveOwnerId,
          subject: formed.subject,
          predicate: formed.proposition?.predicate,
          scopeKey: formed.proposition?.scopeKey,
        },
        target.type,
      )
      if (slotInput === undefined) {
        reject('payload_schema_invalid', 'FORMED 缺槽位分量（防御性兜底）')
        continue
      }
      // 规则标识（两条产出路径各有其规则；inferred 走冻结词形，reported 走白名单）
      const ruleOk =
        (formed.epistemicKind === 'inferred' &&
          formed.ruleId === INFERRED_RULE_ID &&
          formed.ruleVersion === INFERRED_RULE_VERSION) ||
        (formed.epistemicKind === 'reported' &&
          formed.ruleId === REPORTED_RULE_ID &&
          formed.ruleVersion === REPORTED_RULE_VERSION)
      if (!ruleOk) {
        reject(
          'belief_rule_version_unknown',
          `FORMED(${String(formed.epistemicKind)}) 的规则标识不匹配：` +
            `收到 ${String(formed.ruleId)}@${String(formed.ruleVersion)}`,
        )
        continue
      }
      // 证据根：存在性 → 归属 → 资格（reported 的根是记忆的根——历史陈述，
      // 不施切换后条件；inferred 的根必须是切换后的合格互动）
      const roots = formed.evidenceRootIds
      const found = await deps.evidence.findEvents(roots)
      const foundIds = new Set(found.map((e) => String(e.id)))
      const missing = roots.filter((id) => !foundIds.has(String(id)))
      if (missing.length > 0) {
        reject(
          'source_event_missing',
          `引用的对话事件不存在：${missing.map((id) => String(id)).join(', ')}`,
        )
        continue
      }
      const foreign = found.filter((e) => String(e.characterId) !== String(proposal.characterId))
      if (foreign.length > 0) {
        reject(
          'source_event_foreign',
          `引用的对话事件属于别的角色：${foreign.map((e) => String(e.id)).join(', ')}`,
        )
        continue
      }
      if (formed.epistemicKind === 'inferred') {
        const verdict = beliefEvidenceVerdictOf(
          found.map((e) => ({
            id: e.id,
            sequence: e.sequence,
            type: e.type,
            actorId: e.actorId,
            trustedOrigin: e.trustedOrigin,
          })),
          evidencePolicy,
        )
        if (!verdict.ok) {
          reject(verdict.code, verdict.detail)
          continue
        }
        // 阈值复推（评估器算过一遍；放行口再算一遍——失败关闭双保险）
        const distinctRoots = new Set(roots.map(String))
        const conversations = new Set(
          found.map((e) => e.conversationId).filter((c): c is string => c !== undefined),
        )
        if (
          distinctRoots.size < BELIEF_INFERRED_MIN_ROOTS ||
          conversations.size < BELIEF_INFERRED_MIN_CONVERSATIONS
        ) {
          reject(
            'belief_threshold_not_met',
            `FORMED 阈值复推不过：${String(distinctRoots.size)} 根 / ` +
              `${String(conversations.size)} 会话（要求 ≥${String(BELIEF_INFERRED_MIN_ROOTS)} 根 · ` +
              `≥${String(BELIEF_INFERRED_MIN_CONVERSATIONS)} 会话；ADR-070 D06）`,
          )
          continue
        }
        // beliefId 确定性复推（formationKey = 合并根最大 sequence）
        const formationKey = String(Math.max(...found.map((e) => e.sequence)))
        const slotKey = beliefSlotKeyOf(slotInput)
        const expectedId = makeBeliefId(proposal.characterId, slotKey, formationKey)
        if (String(expectedId) !== String(formed.beliefId)) {
          reject(
            'belief_id_not_derivable',
            `beliefId 不可复推：期望 ${String(expectedId)}（formationKey=${formationKey}），` +
              `收到 ${String(formed.beliefId)}（INV-M9-11：修订 = 新 id，重放 = 同 id）`,
          )
          continue
        }
        // reported 必须挂 Memory 依赖（B-REPORTED 的来源是白名单记忆）
      } else if ((formed.dependsOnMemoryIds ?? []).length === 0) {
        reject(
          'payload_schema_invalid',
          'B-REPORTED 的 FORMED 必须带 dependsOnMemoryIds（来源是白名单 Memory；ADR-070 D04）',
        )
        continue
      } else {
        // —— B-REPORTED 资格复核（WP5；失败关闭，无例外）——
        const memoryIds = formed.dependsOnMemoryIds ?? []
        if (deps.memory === undefined) {
          reject(
            'belief_source_missing',
            'B-REPORTED 需要 Memory 查找端口复核依赖，端口未装配（失败关闭，不静默放行）',
          )
          continue
        }
        const memories = await deps.memory.findMemories(memoryIds)
        const foundMemIds = new Set(memories.map((m) => String(m.id)))
        const missingMem = memoryIds.filter((id) => !foundMemIds.has(String(id)))
        if (missingMem.length > 0) {
          reject(
            'belief_source_missing',
            `依赖的 Memory 不存在：${missingMem.map((id) => String(id)).join(', ')}（断链失败关闭，§7.5）`,
          )
          continue
        }
        const foreignMem = memories.filter((m) => String(m.ownerId) !== String(proposal.characterId))
        if (foreignMem.length > 0) {
          reject(
            'source_event_foreign',
            `依赖的 Memory 属于别的角色：${foreignMem.map((m) => String(m.id)).join(', ')}`,
          )
          continue
        }
        const ineligible = memories.filter((m) => !isBeliefReportedEligible(m))
        if (ineligible.length > 0) {
          reject(
            'belief_source_unqualified',
            `依赖的 Memory 不在 B-REPORTED 白名单内：${ineligible.map((m) => String(m.id)).join(', ')}` +
              '（claim 家族 + EXPLICIT 权威档 + reported + active；D04）',
          )
          continue
        }
        // beliefId 确定性复推（formationKey = 依赖 Memory 集合的身份分量哈希；与 reconciler 同源）
        // M9.1 WP8 / F-5：revision > 1（复活过）的依赖并入 revision ⇒ 与 reconciler 同源
        const revisionById = new Map(memories.map((m) => [String(m.id), m.revision]))
        const reportedKey = beliefReportedFormationKeyOf(
          memoryIds.map((id) =>
            beliefReportedDependencyTokenOf({
              memoryId: id,
              revision: revisionById.get(String(id)) ?? 1,
            }),
          ),
        )
        const expectedReportedId = makeBeliefId(
          proposal.characterId,
          beliefSlotKeyOf(slotInput),
          reportedKey,
        )
        if (String(expectedReportedId) !== String(formed.beliefId)) {
          reject(
            'belief_id_not_derivable',
            `beliefId 不可复推：期望 ${String(expectedReportedId)}（formationKey=${reportedKey}），` +
              `收到 ${String(formed.beliefId)}（INV-M9-11：修订 = 新 id，重放 = 同 id）`,
          )
          continue
        }
      }
      // 同值现存 ⇒ 拒绝（那是 REINFORCED 的事）；异值现存 ⇒ 照放（冲突信号）
      const slotKey = beliefSlotKeyOf(slotInput)
      const activeBeliefs = await deps.belief.listActiveBeliefsForSlot(
        proposal.characterId,
        slotKey,
      )
      const sameValue = activeBeliefs.find(
        (b) => String(b.proposition.value) === String(formed.proposition.value),
      )
      if (sameValue !== undefined) {
        reject(
          'belief_slot_already_active',
          `槽位已有同值 active 信念 ${String(sameValue.beliefId)}：` +
            '同值演进走 REINFORCED，重复建档是违规（ADR-070 §4.2）',
        )
        continue
      }
      // §5.4：禁用根不得参与新形成（相交即拒——raw-event 推断不能绕道复活）
      const forbidden = await deps.belief.forbiddenRootsForSlot(proposal.characterId, slotKey)
      const banned = roots.filter((id) => forbidden.includes(String(id)))
      if (banned.length > 0) {
        reject(
          'belief_roots_forbidden',
          `形成根与已禁用根相交：${banned.map((id) => String(id)).join(', ')}（§5.4/B28）`,
        )
        continue
      }
      acceptedEvents.push(accept(target, proposal, idempotencyKey))
      continue
    }

    if (target.type === BELIEF_REINFORCED) {
      const reinforced = payload as unknown as BeliefReinforcedPayload
      const belief = await deps.belief.getBelief(proposal.characterId, reinforced.beliefId)
      if (belief === undefined) {
        reject(
          'belief_belief_missing',
          `强化的信念 ${String(reinforced.beliefId)} 不存在（孤儿强化——失败关闭）`,
        )
        continue
      }
      if (belief.status !== 'active') {
        reject(
          'belief_not_active',
          `信念 ${String(reinforced.beliefId)} 状态是 ${String(belief.status)}：只有 active 接受强化（§4.2）`,
        )
        continue
      }
      // 新根必须是合格用户事件（存在 → 归属 → 资格四条）
      const verdict = await evidenceVerdict(
        deps,
        proposal.characterId,
        reinforced.newRootIds,
        evidencePolicy,
        reject,
      )
      if (verdict === undefined) continue
      // §5.4：禁用根不得强化进任何信念
      const slotKey = beliefSlotKeyOf({
        perspectiveOwnerId: belief.perspectiveOwnerId,
        subject: belief.subject,
        predicate: belief.proposition.predicate,
        scopeKey: belief.proposition.scopeKey,
      })
      const forbidden = await deps.belief.forbiddenRootsForSlot(proposal.characterId, slotKey)
      const banned = reinforced.newRootIds.filter((id) => forbidden.includes(String(id)))
      if (banned.length > 0) {
        reject(
          'belief_roots_forbidden',
          `强化根与已禁用根相交：${banned.map((id) => String(id)).join(', ')}（§5.4/B28）`,
        )
        continue
      }
      acceptedEvents.push(accept(target, proposal, idempotencyKey))
      continue
    }

    if (target.type === BELIEF_DISPUTED) {
      const disputed = payload as unknown as BeliefDisputedPayload
      const belief = await deps.belief.getBelief(proposal.characterId, disputed.beliefId)
      if (belief === undefined) {
        reject(
          'belief_belief_missing',
          `争议的信念 ${String(disputed.beliefId)} 不存在（失败关闭）`,
        )
        continue
      }
      if (belief.status !== 'active') {
        reject(
          'belief_not_active',
          `信念 ${String(disputed.beliefId)} 状态是 ${String(belief.status)}：只有 active 能进入 disputed（§4.2）`,
        )
        continue
      }
      acceptedEvents.push(accept(target, proposal, idempotencyKey))
      continue
    }

    if (target.type === BELIEF_SUPERSEDED) {
      const superseded = payload as unknown as BeliefSupersededPayload
      if (String(superseded.oldBeliefId) === String(superseded.newBeliefId)) {
        reject(
          'belief_supersede_target_invalid',
          'SUPERSEDED 的 old 与 new 不能是同一个 beliefId（自取代无意义）',
        )
        continue
      }
      const oldBelief = await deps.belief.getBelief(proposal.characterId, superseded.oldBeliefId)
      if (oldBelief === undefined) {
        reject(
          'belief_belief_missing',
          `被取代的信念 ${String(superseded.oldBeliefId)} 不存在（失败关闭）`,
        )
        continue
      }
      if (oldBelief.status !== 'active' && oldBelief.status !== 'disputed') {
        reject(
          'belief_supersede_target_invalid',
          `被取代的信念状态是 ${String(oldBelief.status)}：只有 active/disputed 能被取代（终态不可迁移，§4.2）`,
        )
        continue
      }
      // newBeliefId 的存在性不查：它的 FORMED 与本事件可在同一提案内（折叠按序）
      acceptedEvents.push(accept(target, proposal, idempotencyKey))
      continue
    }

    // BELIEF_RETRACTED
    const retracted = payload as unknown as BeliefRetractedPayload
    const belief = await deps.belief.getBelief(proposal.characterId, retracted.beliefId)
    if (belief === undefined) {
      reject(
        'belief_belief_missing',
        `撤回的信念 ${String(retracted.beliefId)} 不存在（失败关闭）`,
      )
      continue
    }
    if (belief.status === 'retracted') {
      reject(
        'belief_not_active',
        `信念 ${String(retracted.beliefId)} 已是 retracted：终态不可重复撤回（§4.2）`,
      )
      continue
    }
    // §5.4：禁用根必须是该信念自己的根（过宽禁用会错杀未来的合法重开）
    const beliefRoots = new Set(belief.evidenceRootIds.map(String))
    const forbiddenNow = retracted.forbiddenRootIds ?? []
    const overBroad = forbiddenNow.filter((id) => !beliefRoots.has(String(id)))
    if (overBroad.length > 0) {
      reject(
        'belief_forbidden_roots_invalid',
        `禁用根不属于该信念：${overBroad.map((id) => String(id)).join(', ')}（§5.4：只禁自己的根）`,
      )
      continue
    }
    // §5.4/B28：显式遗忘必携非空禁用根——不禁根 = 旧依据可绕道复活。
    // dependency_invalidated 不作此要求（Memory 撤回 ≠ 对话根作废，B31）。
    if (retracted.reason === 'user_forget_request' && forbiddenNow.length === 0) {
      reject(
        'belief_forbidden_roots_invalid',
        'user_forget_request 必须携带非空 forbiddenRootIds（§5.4：遗忘不禁根 = 复活后门，B28）',
      )
      continue
    }
    acceptedEvents.push(accept(target, proposal, idempotencyKey))
  }

  return {
    proposalId: proposal.proposalId,
    characterId: proposal.characterId,
    accepted: rejected.length === 0,
    acceptedEvents,
    rejected,
  }
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

function accept(
  target: ProposedDomainEvent,
  proposal: DomainProposal,
  idempotencyKey: string,
): AcceptedDomainEvent {
  return {
    type: target.type,
    operation: target.operation,
    payload: target.payload,
    sourceConversationEventIds: proposal.sourceConversationEventIds,
    idempotencyKey,
    processor: proposal.processor,
    processorVersion: proposal.processorVersion,
    scope: target.scope ?? DOMAIN_EVENT_SCOPE,
  }
}

/** 证据三层：存在性 → 归属 → 资格四条（返回 undefined = 已拒） */
async function evidenceVerdict(
  deps: BeliefValidatorDeps,
  characterId: CharacterId,
  ids: readonly ConversationEventId[],
  policy: BeliefEvidencePolicy,
  reject: (code: string, message: string) => void,
): Promise<BeliefEvidenceVerdict | undefined> {
  const found = await deps.evidence.findEvents(ids)
  const foundIds = new Set(found.map((e) => String(e.id)))
  const missing = ids.filter((id) => !foundIds.has(String(id)))
  if (missing.length > 0) {
    reject(
      'source_event_missing',
      `引用的对话事件不存在：${missing.map((id) => String(id)).join(', ')}`,
    )
    return undefined
  }
  const foreign = found.filter((e) => String(e.characterId) !== String(characterId))
  if (foreign.length > 0) {
    reject(
      'source_event_foreign',
      `引用的对话事件属于别的角色：${foreign.map((e) => String(e.id)).join(', ')}`,
    )
    return undefined
  }
  const verdict = beliefEvidenceVerdictOf(
    found.map((e) => ({
      id: e.id,
      sequence: e.sequence,
      type: e.type,
      actorId: e.actorId,
      trustedOrigin: e.trustedOrigin,
    })),
    policy,
  )
  if (!verdict.ok) {
    reject(verdict.code, verdict.detail)
    return undefined
  }
  return verdict
}
