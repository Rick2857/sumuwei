/**
 * RelationshipValidator —— **关系变化的唯一放行口**（M7 WP4 / ADR-064）。
 *
 * ============================================================================
 *  为什么不复用 `DomainPolicyValidator`（与 memory-validator 同一裁定，审计 §6 F4）
 * ============================================================================
 * 通用验证器的幂等键由 `idempotencyKeyFor()` 推导，第五分量只有 `operation`。
 * 而关系提案的形状是：
 *
 *     一个窗口 → **N 个独立的工作单元**（r2 一条 · r1 每日一条 · r5 每里程碑一条）
 *
 * 同一批提案交给它，r2 与 r1 会算出**同一个键**：第一条落库、其余全部
 * 被判 duplicate 静默丢弃——"她的关系少长了一截"比"她记错了"更难发现。
 * 因此这里**刻意重复**通用检查（来源存在性 / 归属 / payload / scope），
 * **不重复**的是幂等键推导：领域判别分量 `${operation}:${ruleId}:${unit}`
 * （与 `idempotencyKeyForMemory` 同一手法，见本文件实现）。
 *
 * 共用的一律共用：`computeIdempotencyKey()`、registry 的 `validatePayload` /
 * `maxPayloadBytes`、`assertCharacterInternalScope`、
 * `relationshipEvidenceVerdictOf`（证据资格——ADR-043 的唯一判据，不另造）。
 *
 * ---------------------------------------------------------------------------
 *  检查分层（拒绝码两套词汇，各有归属）
 * ---------------------------------------------------------------------------
 *   · 关系业务码 = `RELATIONSHIP_REJECTION_CODES`（12 个，WP2 冻结；
 *     新码必须先改那张表——可审计）；
 *   · 管线通用码 = processor_version_presence / source_event_missing /
 *     source_event_foreign / payload_schema_invalid / duplicate_operation /
 *     domain_event_type_not_allowed / scope_not_character_internal
 *     （与 `DomainPolicyValidator` 同词表——跨模块一致，不另造同义词）。
 *
 * 失败关闭（fail closed）：引用不存在的事件、未建档先变化、超界 delta、
 * 撤回不在案的目标——一律 reject，不静默夹、不静默跳。
 */

import {
  DOMAIN_EVENT_SCOPE,
  ENTITY_KINDS,
  KernelError,
  RELATIONSHIP_ORIGIN,
  RELATIONSHIP_IMPACT,
  assertCharacterInternalScope,
  computeIdempotencyKey,
  isRelationshipOriginKind,
  originKindAcceptedByM7,
  relationshipDeltaWithinBounds,
  relationshipEvidenceVerdictOf,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
  type DomainEventRegistry,
  type DomainProposal,
  type EntityRelationKey,
  type ProposedDomainEvent,
  type RelationshipImpactPayload,
  type RelationshipOriginPayload,
  type RelationshipState,
} from '../contracts/index.ts'
import {
  STORY_RELATIONSHIP_RULES_VERSION,
  STORY_RELATIONSHIP_RULE_DELTAS,
  STORY_RELATIONSHIP_RULE_IDS,
  isStoryRelationshipRuleId,
} from '../contracts/story-appraisal.ts'
import type { TrustedOriginReading } from '../contracts/attribution.ts'
import type { AcceptedDomainEvent, RejectedTarget, ValidatorOutcome } from './validator.ts'

// ---------------------------------------------------------------------------
// 幂等键（领域推导；memory 先例：住在放行口）
// ---------------------------------------------------------------------------

/**
 * 关系域事件的幂等键。
 *
 * `computeIdempotencyKey()` 的第五分量是自由字符串，这里拼
 * `${operation}:${ruleId}:${unit}`——同一逻辑工作单元必然同键。
 *
 * ⚠️ **range 分量的两种刻意形态**（与 memory 的"区间进键"不同，各有其理）：
 *   · r1 / origin → **置零**：陪伴单元的幂等身份是
 *     `(character, processor, version, rule, 自然日)`——**不是**证据批次。
 *     两个不相重叠的窗口可以都包含同一个自然日（窗口切在日中），
 *     range 进键会让同一天被计两次。置零让跨窗口同日提案**必然撞键**
 *     （"同一天最多计一次"的机器保证）。
 *   · r2/r3/r4/r5 → **保留**：这些规则的单元是窗口/里程碑本身，
 *     range 进键让"同一窗口被重复处理"被识别为重复（正常幂等）。
 */
export function idempotencyKeyForRelationshipEvent(input: {
  characterId: CharacterId
  processor: string
  processorVersion: string
  sourceFromSequence: number
  sourceToSequence: number
  operation: string
  ruleId: string
  unit: string
}): string {
  const neutralizeRange = input.ruleId === 'r1' || input.ruleId === 'origin'
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: neutralizeRange ? 0 : input.sourceFromSequence,
    sourceToSequence: neutralizeRange ? 0 : input.sourceToSequence,
    operation: `${input.operation}:${input.ruleId}:${input.unit}`,
  })
}

// ---------------------------------------------------------------------------
// 依赖端口（由装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

/** 证据查找：比通用 ProposalSourceLookup 多要 type / trustedOrigin / createdAt（资格与 unit 复核要读它们） */
export interface RelationshipEvidenceLookup {
  findEvents(
    ids: readonly ConversationEventId[]
  ): Promise<
    {
      id: ConversationEventId
      characterId: CharacterId
      sequence: number
      type: string
      trustedOrigin?: TrustedOriginReading
    }[]
  >
}

/** 关系状态查找（读投影；建档存在性与在案检查） */
export interface RelationshipStateLookup {
  getRelationshipState(
    characterId: CharacterId,
    key: EntityRelationKey
  ): Promise<RelationshipState | undefined>
}

/** 域事件查找（撤回链目标的存在性与类型） */
export interface RelationshipEventLookup {
  getDomainEvent(id: DomainEventId): Promise<{ id: DomainEventId; type: string } | undefined>
}

export interface RelationshipValidatorDeps {
  registry: DomainEventRegistry
  evidence: RelationshipEvidenceLookup
  processed: { hasProcessed(idempotencyKey: string): Promise<boolean> }
  relationships: RelationshipStateLookup
  events: RelationshipEventLookup
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

function structuralRejectionOf(
  target: ProposedDomainEvent,
  proposal: DomainProposal
): RejectedTarget | undefined {
  const payload = target.payload
  if (typeof payload !== 'object' || payload === null) {
    return { type: target.type, code: 'payload_schema_invalid', message: 'payload 必须是对象' }
  }
  const object = payload as Record<string, unknown>
  const eventType = target.type

  if (eventType === RELATIONSHIP_ORIGIN) {
    const origin = object as Partial<RelationshipOriginPayload>
    if (
      typeof origin.targetKind === 'string' &&
      !(ENTITY_KINDS as readonly string[]).includes(origin.targetKind)
    ) {
      return {
        type: eventType,
        code: 'relationship_target_kind_invalid',
        message: `targetKind=${String(origin.targetKind)} 未登记于 ENTITY_KINDS`,
      }
    }
    if (!isRelationshipOriginKind(origin.originKind)) {
      return {
        type: eventType,
        code: 'relationship_origin_kind_invalid',
        message: `originKind=${String(origin.originKind)} 不在三值枚举里`,
      }
    }
    for (const field of ['trust', 'closeness'] as const) {
      const value = origin[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          type: eventType,
          code: 'relationship_delta_not_finite',
          message: `ORIGIN 基线 ${field} 必须是有限数字，收到 ${String(value)}`,
        }
      }
      if (value < 0 || value > 1) {
        return {
          type: eventType,
          code: 'relationship_origin_values_out_of_range',
          message: `ORIGIN 基线 ${field} 必须在 [0,1]，收到 ${String(value)}`,
        }
      }
    }
    return undefined
  }

  if (eventType === RELATIONSHIP_IMPACT) {
    const impact = object as Partial<RelationshipImpactPayload>
    if (
      typeof impact.targetKind === 'string' &&
      !(ENTITY_KINDS as readonly string[]).includes(impact.targetKind)
    ) {
      return {
        type: eventType,
        code: 'relationship_target_kind_invalid',
        message: `targetKind=${String(impact.targetKind)} 未登记于 ENTITY_KINDS`,
      }
    }
    if (!isRelationshipOriginKind(impact.originKind)) {
      return {
        type: eventType,
        code: 'relationship_origin_kind_invalid',
        message: `originKind=${String(impact.originKind)} 不在三值枚举里`,
      }
    }
    const delta = impact.delta as Partial<{ trust: unknown; closeness: unknown }> | undefined
    for (const axis of ['trust', 'closeness'] as const) {
      const value = delta?.[axis]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          type: eventType,
          code: 'relationship_delta_not_finite',
          message: `delta.${axis} 必须是有限数字，收到 ${String(value)}`,
        }
      }
    }
    return undefined
  }

  return undefined
}

// ---------------------------------------------------------------------------
// 验证
// ---------------------------------------------------------------------------

export async function validateRelationshipProposal(
  deps: RelationshipValidatorDeps,
  proposal: DomainProposal
): Promise<ValidatorOutcome> {
  const rejected: RejectedTarget[] = []
  const acceptedEvents: AcceptedDomainEvent[] = []

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

  // ---- 提案级：来源存在性 / 归属 / 资格（IMPACT 才需要；ORIGIN 的凭据是 basis）----
  const isImpactProposal = proposal.targetEvents.some((t) => t.type === RELATIONSHIP_IMPACT)
  let evidenceVerdict: { ok: true; qualifiedEventIds: ConversationEventId[] } | { ok: false; code: string; detail: string } | undefined
  let sourceRange = { from: 0, to: 0 }
  if (isImpactProposal) {
    if (proposal.sourceConversationEventIds.length === 0) {
      evidenceVerdict = {
        ok: false,
        code: 'relationship_evidence_missing',
        detail: 'IMPACT 必须引用至少一条真实对话事件（ADR-064 D-3：无证据不变化）',
      }
    } else {
      const found = await deps.evidence.findEvents(proposal.sourceConversationEventIds)
      const foundIds = new Set(found.map((e) => String(e.id)))
      const missing = proposal.sourceConversationEventIds.filter((id) => !foundIds.has(String(id)))
      if (missing.length > 0) {
        evidenceVerdict = {
          ok: false,
          code: 'source_event_missing',
          detail: `引用的对话事件不存在：${missing.map((id) => String(id)).join(', ')}`,
        }
      } else {
        const foreign = found.filter((e) => String(e.characterId) !== String(proposal.characterId))
        if (foreign.length > 0) {
          evidenceVerdict = {
            ok: false,
            code: 'source_event_foreign',
            detail: `引用的对话事件属于别的角色：${foreign.map((e) => String(e.id)).join(', ')}`,
          }
        } else {
          evidenceVerdict = relationshipEvidenceVerdictOf(
            found.map((e) => ({ id: e.id, type: e.type, trustedOrigin: e.trustedOrigin }))
          )
          const sequences = found.map((e) => e.sequence)
          sourceRange = {
            from: Math.min(...sequences),
            to: Math.max(...sequences),
          }
        }
      }
    }
  }

  // ---- 目标级 -------------------------------------------------------------
  for (const target of proposal.targetEvents) {
    const reject = (code: string, message: string): void => {
      rejected.push({ type: target.type, code, message })
    }

    // ① 类型 allowlist（关系链只认这两类）
    if (target.type !== RELATIONSHIP_ORIGIN && target.type !== RELATIONSHIP_IMPACT) {
      reject(
        'domain_event_type_not_allowed',
        `关系验证器只放行 ${RELATIONSHIP_ORIGIN} / ${RELATIONSHIP_IMPACT}，收到 ${target.type}`,
      )
      continue
    }

    // ② 结构判据（登记过的码优先；然后 registry 兜底形状与大小）
    const structural = structuralRejectionOf(target, proposal)
    if (structural !== undefined) {
      rejected.push(structural)
      continue
    }
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

    const payload =
      target.type === RELATIONSHIP_ORIGIN
        ? (target.payload as RelationshipOriginPayload)
        : (target.payload as RelationshipImpactPayload)

    // ③ owner 一致（伪造跨角色关系——失败关闭）
    if (String(payload.key.owner) !== String(proposal.characterId)) {
      reject(
        'relationship_owner_mismatch',
        `payload.key.owner=${String(payload.key.owner)} ≠ characterId=${String(proposal.characterId)}`,
      )
      continue
    }

    // ④ 注入来源：登记但失败关闭（Cognitive Intervention 未开闸）
    if (!originKindAcceptedByM7(payload.originKind)) {
      reject(
        'relationship_origin_injection_not_enabled',
        `originKind=${payload.originKind}：M7 只放行 INTERACTION_DERIVED（ADR-064 D-2）`,
      )
      continue
    }

    const state = await deps.relationships.getRelationshipState(proposal.characterId, payload.key)

    if (target.type === RELATIONSHIP_ORIGIN) {
      // ⑤a ORIGIN：一条关系只建一次档
      if (state !== undefined && state.originated) {
        reject(
          'relationship_origin_already_exists',
          `关系 ${String(payload.key.owner)}→${String(payload.key.target)} 已建档；后续变化走 IMPACT`,
        )
        continue
      }
    } else {
      const impact = payload as RelationshipImpactPayload
      // ⑤b IMPACT：没有基线就没有可影响的状态
      if (state === undefined || !state.originated) {
        reject(
          'relationship_origin_missing',
          `关系 ${String(payload.key.owner)}→${String(payload.key.target)} 尚未建档，IMPACT 不放行`,
        )
        continue
      }
      // ⑥ delta 界（拒绝，不静默夹——D-2 分层：reducer 的夹是兜底不是放行）
      if (!relationshipDeltaWithinBounds(impact.delta)) {
        reject(
          'relationship_delta_out_of_bounds',
          `delta=(${String(impact.delta.trust)},${String(impact.delta.closeness)}) 超出单事件上限（|Δtrust|≤0.05 · |Δcloseness|≤0.03）`,
        )
        continue
      }

      /*
       * ⑥b **S8 / ADR-093 `D09`**：故事规则表分支。
       *
       * 判据与词形/语义表**并列**（按 `ruleVersion` 选表，不是并成允许集合）：
       * ```text
       * payload.ruleVersion = 'story-relationship@1'
       *   ① ruleId 必须在故事表里          （否则 relationship_rule_unknown）
       *   ② originKind 必须是 STORY_DERIVED（否则 relationship_origin_kind_mismatch）
       *   ③ delta 必须与该规则的冻结值**逐字段相等**（不是范围界）
       * ```
       * 缺 `ruleVersion` ⇒ 走既有路径，判据**逐字不变**。
       */
      if (impact.ruleVersion === STORY_RELATIONSHIP_RULES_VERSION) {
        if (!isStoryRelationshipRuleId(impact.ruleId)) {
          reject(
            'relationship_rule_unknown',
            `ruleId=${impact.ruleId} 不在故事关系表（${STORY_RELATIONSHIP_RULES_VERSION} 的 ` +
              `${String(STORY_RELATIONSHIP_RULE_IDS.length)} 条）`,
          )
          continue
        }
        if (impact.originKind !== 'STORY_DERIVED') {
          reject(
            'relationship_origin_kind_mismatch',
            `${STORY_RELATIONSHIP_RULES_VERSION} 的 IMPACT 必须 originKind=STORY_DERIVED，` +
              `收到 ${String(impact.originKind)}`,
          )
          continue
        }
        const expectedStory = STORY_RELATIONSHIP_RULE_DELTAS[impact.ruleId]
        if (
          impact.delta.trust !== expectedStory.deltaTrust ||
          impact.delta.closeness !== expectedStory.deltaCloseness
        ) {
          reject(
            'relationship_delta_not_exact',
            `delta=(${String(impact.delta.trust)},${String(impact.delta.closeness)}) ` +
              `≠ 故事规则 ${impact.ruleId} 的冻结增量 ` +
              `(${String(expectedStory.deltaTrust)},${String(expectedStory.deltaCloseness)})——` +
              '故事规则要求精确一致（ADR-093 D09）',
          )
          continue
        }
      } else if (impact.originKind === 'STORY_DERIVED') {
        /*
         * 反向闸：**没有** story 版本却声明 `STORY_DERIVED` ⇒ 拒收。
         * 少了这一条，"故事来源"会变成一条可以绕过规则表版本判据的自由标签。
         */
        reject(
          'relationship_origin_kind_mismatch',
          `originKind=STORY_DERIVED 必须配 ruleVersion=${STORY_RELATIONSHIP_RULES_VERSION}，` +
            `收到 ${String(impact.ruleVersion ?? '（缺省）')}`,
        )
        continue
      }
      // ⑦ 证据资格（提案级已算；这里落到目标级拒绝）
      if (evidenceVerdict !== undefined && !evidenceVerdict.ok) {
        reject(evidenceVerdict.code, evidenceVerdict.detail)
        continue
      }
      // ⑧ 撤回链：目标必须存在、必须是 IMPACT、必须在案（防双撤回）
      if (impact.supersedes !== undefined) {
        const superseded = await deps.events.getDomainEvent(impact.supersedes.domainEventId)
        const inCase =
          state.accusationsInCase.some(
            (a) => String(a.domainEventId) === String(impact.supersedes?.domainEventId)
          )
        if (superseded === undefined || superseded.type !== RELATIONSHIP_IMPACT || !inCase) {
          reject(
            'relationship_supersedes_invalid',
            `supersedes 指向 ${String(impact.supersedes.domainEventId)}：` +
              `${superseded === undefined ? '不存在' : superseded.type !== RELATIONSHIP_IMPACT ? '不是 RELATIONSHIP_IMPACT' : '不在在案登记表（已被撤回或从未在案）'}`,
          )
          continue
        }
      }
    }

    // ⑨ 作用域（放行口必须记录它放行了什么范围）
    try {
      assertCharacterInternalScope(target.scope ?? DOMAIN_EVENT_SCOPE)
    } catch (error) {
      reject(
        'scope_not_character_internal',
        error instanceof Error ? error.message : 'scope 必须是 CHARACTER_INTERNAL',
      )
      continue
    }

    // ⑩ 幂等（领域键推导 + 已处理检查）
    const ruleId = target.type === RELATIONSHIP_ORIGIN ? 'origin' : (target.payload as RelationshipImpactPayload).ruleId
    const unit = target.type === RELATIONSHIP_ORIGIN ? String(payload.key.target) : (target.payload as RelationshipImpactPayload).unit
    const idempotencyKey = idempotencyKeyForRelationshipEvent({
      characterId: proposal.characterId,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      sourceFromSequence: sourceRange.from,
      sourceToSequence: sourceRange.to,
      operation: target.operation,
      ruleId,
      unit,
    })
    if (await deps.processed.hasProcessed(idempotencyKey)) {
      reject(
        'duplicate_operation',
        `幂等键 ${idempotencyKey} 已处理过（${ruleId} 单元 ${unit}）`,
      )
      continue
    }

    acceptedEvents.push({
      type: target.type,
      operation: target.operation,
      payload: target.payload,
      sourceConversationEventIds: proposal.sourceConversationEventIds,
      idempotencyKey,
      processor: proposal.processor,
      processorVersion: proposal.processorVersion,
      scope: target.scope ?? DOMAIN_EVENT_SCOPE,
    })
  }

  return {
    proposalId: proposal.proposalId,
    characterId: proposal.characterId,
    accepted: rejected.length === 0,
    acceptedEvents,
    rejected,
  }
}
