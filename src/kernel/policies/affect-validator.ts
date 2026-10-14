/**
 * AffectValidator —— **情绪变化的唯一放行口**（M8 WP3 / ADR-066）。
 *
 * ============================================================================
 *  为什么不复用 `DomainPolicyValidator`（与 memory / relationship 同一裁定）
 * ============================================================================
 * 通用验证器的幂等键由 `idempotencyKeyFor()` 推导，第五分量只有 `operation`。
 * 而 Affect 提案的形状是：
 *
 *     一个窗口 → **N 个独立的工作单元**（每条合格用户事件一个 touch +
 *     至多一个主导 impact——M8-D08）
 *
 * 同一批提案交给它，多条 touch 会算出**同一个键**：第一条落库、其余全部
 * 被判 duplicate 静默丢弃——"她的情绪少动了一次"比"她记错了"更难发现。
 * 因此这里**刻意重复**通用检查（来源存在性 / 归属 / payload / scope），
 * **不重复**的是幂等键推导：领域判别分量
 * `affect-touch:<sourceEventId>` / `affect-impact:<ruleId>:<sourceEventId>`
 * （合同助手，见 contracts/affect.ts——评估器与 Validator 共用同一推导）。
 *
 * 共用的一律共用：`computeIdempotencyKey()`、registry 的 `validatePayload` /
 * `maxPayloadBytes`、`assertCharacterInternalScope`、`affectEvidenceVerdictOf`
 * （证据资格——ADR-043 的唯一判据 + ADR-066 §3 的 active user / cutover 扩展）。
 *
 * ---------------------------------------------------------------------------
 *  检查分层（拒绝码两套词汇，各有归属）
 * ---------------------------------------------------------------------------
 *   · Affect 业务码 = `AFFECT_REJECTION_CODES`（12 个，WP2 冻结；
 *     新码必须先改那张表——可审计）；
 *   · 管线通用码 = processor_version_presence / source_event_missing /
 *     source_event_foreign / payload_schema_invalid / payload_too_large /
 *     duplicate_operation / domain_event_type_not_allowed / scope_not_character_internal
 *     （与 `DomainPolicyValidator` 同词表——跨模块一致，不另造同义词）。
 *
 * 失败关闭（fail closed）：引用不存在的事件、未建档先变化、超界 delta、
 * 未知规则、版本不匹配、切换前事件、非 active user——一律 reject，
 * 不静默夹、不静默跳。
 *
 * ---------------------------------------------------------------------------
 *  幂等键的 range 分量：**恒置零**（与 M7 的 r1/origin 同一形态，理由更强）
 * ---------------------------------------------------------------------------
 * Affect 的幂等身份是 `(character, processor, version, <unit>)`，unit =
 * sourceEventId（touch）/ ruleId+sourceEventId（impact）——**不是**证据批次。
 * 同一来源事件可能被不相重叠的窗口重复覆盖（失败重试 / 启动 catch-up /
 * 尾部补消费），range 进键会让同一事件被计两次。置零让跨窗口同源提案
 * **必然撞键**（"一次交互至多一次 touch / 一次主导 impact"的机器保证）。
 */

import {
  DOMAIN_EVENT_SCOPE,
  KernelError,
  AFFECT_IMPACT,
  AFFECT_ORIGIN,
  AFFECT_TOUCH,
  AFFECT_RULES_VERSION,
  AFFECT_RULE_DELTAS,
  assertCharacterInternalScope,
  computeIdempotencyKey,
  affectDeltaWithinBounds,
  affectEvidenceVerdictOf,
  affectImpactIdempotencyOperation,
  affectTouchIdempotencyOperation,
  isAffectImpactRuleId,
  isAffectOriginKind,
  originKindAcceptedByM8,
  type AffectImpactPayload,
  type AffectOriginPayload,
  type AffectRuleFamily,
  type AffectState,
  type AffectTouchPayload,
  type CharacterId,
  type ConversationEventId,
  type DomainEventRegistry,
  type DomainProposal,
  type ProposedDomainEvent,
} from '../contracts/index.ts'
import {
  AFFECT_SEMANTIC_POLICY_VERSION,
  affectSemanticImpactIdempotencyOperation,
  type AffectSemanticImpactPayload,
} from '../contracts/affect-semantic.ts'
import {
  STORY_APPRAISAL_RULES_VERSION,
  STORY_APPRAISAL_RULE_DELTAS,
  STORY_APPRAISAL_RULE_IDS,
  isStoryAppraisalRuleId,
} from '../contracts/story-appraisal.ts'
import type { TrustedOriginReading } from '../contracts/attribution.ts'
import type { AcceptedDomainEvent, RejectedTarget, ValidatorOutcome } from './validator.ts'

// ---------------------------------------------------------------------------
// 幂等键（领域推导；memory / relationship 先例：住在放行口）
// ---------------------------------------------------------------------------

/**
 * Affect 域事件的幂等键。
 *
 * `computeIdempotencyKey()` 的第五分量是自由字符串，这里用合同助手拼
 * unit 语义（touch = 源事件；impact = 规则 + 源事件）；range 分量恒置零
 * （见文件头——跨窗口同源提案必然撞键）。
 *
 * M8.5（WP7）：语义策略的 IMPACT 由调用方传 `unitOperation`
 * （`affectSemanticImpactIdempotencyOperation` 的产出——`affect-semantic-impact:…`）；
 * 缺省仍按词形路径推导（`affect-impact:…`）。键的其余分量（processor/version）
 * 已区分两条路径，unit 串各自稳定 ⇒ 各路径内同源同族必然撞键。
 */
export function idempotencyKeyForAffectEvent(input: {
  characterId: CharacterId
  processor: string
  processorVersion: string
  operation: string
  sourceEventId: ConversationEventId
  ruleId?: string
  /** 语义策略 IMPACT 的领域串（覆盖默认推导——一个概念一处实现不破） */
  unitOperation?: string
}): string {
  const unit =
    input.unitOperation !== undefined
      ? input.unitOperation
      : input.ruleId !== undefined
        ? affectImpactIdempotencyOperation(input.ruleId, input.sourceEventId)
        : affectTouchIdempotencyOperation(input.sourceEventId)
  return computeIdempotencyKey({
    characterId: input.characterId,
    processor: input.processor,
    processorVersion: input.processorVersion,
    sourceFromSequence: 0,
    sourceToSequence: 0,
    operation: unit,
  })
}

// ---------------------------------------------------------------------------
// 依赖端口（由装配层注入；本层不认识 SQL）
// ---------------------------------------------------------------------------

/** 证据查找：比通用 ProposalSourceLookup 多要 type / trustedOrigin（资格复核要读它们） */
export interface AffectEvidenceLookup {
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

/** Affect 状态查找（读投影；建档存在性 + cutover 边界） */
export interface AffectStateLookup {
  getAffectState(characterId: CharacterId): Promise<AffectState | undefined>
}

export interface AffectValidatorDeps {
  registry: DomainEventRegistry
  evidence: AffectEvidenceLookup
  processed: { hasProcessed(idempotencyKey: string): Promise<boolean> }
  affect: AffectStateLookup
  /** 资格判定的配置面（active user——M8-D11；cutover 来自状态，不在这里） */
  policy: { activeUserId: string; allowedUserIds?: readonly string[] }
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

function structuralRejectionOf(target: ProposedDomainEvent): RejectedTarget | undefined {
  const payload = target.payload
  if (typeof payload !== 'object' || payload === null) {
    return { type: target.type, code: 'payload_schema_invalid', message: 'payload 必须是对象' }
  }
  const object = payload as Record<string, unknown>
  const eventType = target.type

  if (eventType === AFFECT_ORIGIN) {
    const origin = object as Partial<AffectOriginPayload>
    if (!isAffectOriginKind(origin.originKind)) {
      return {
        type: eventType,
        code: 'affect_payload_invalid',
        message: `originKind=${String(origin.originKind)} 不在五值枚举里`,
      }
    }
    for (const field of ['initialValence', 'initialArousal'] as const) {
      const value = origin[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          type: eventType,
          code: 'affect_value_not_finite',
          message: `ORIGIN ${field} 必须是有限数字，收到 ${String(value)}`,
        }
      }
    }
    return undefined
  }

  if (eventType === AFFECT_IMPACT) {
    const impact = object as { originKind?: unknown; delta?: { deltaValence?: unknown; deltaArousal?: unknown } }
    if (!isAffectOriginKind(impact.originKind)) {
      return {
        type: eventType,
        code: 'affect_payload_invalid',
        message: `originKind=${String(impact.originKind)} 不在五值枚举里`,
      }
    }
    for (const axis of ['deltaValence', 'deltaArousal'] as const) {
      const value = impact.delta?.[axis]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          type: eventType,
          code: 'affect_value_not_finite',
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

export async function validateAffectProposal(
  deps: AffectValidatorDeps,
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

  // ---- 提案级：来源检查在目标级做（TOUCH/IMPACT 才需要；ORIGIN 的凭据是激活授权）----
  //（M7 在提案级预查 missing/foreign；Affect 的 touch/impact 提案恒单源，
  //  目标级一次 findEvents 即可覆盖存在性/归属/资格三层——少一次重复查找）

  // ---- 目标级 -------------------------------------------------------------
  for (const target of proposal.targetEvents) {
    const reject = (code: string, message: string): void => {
      rejected.push({ type: target.type, code, message })
    }

    // ① 类型 allowlist（Affect 链只认这三类）
    if (target.type !== AFFECT_ORIGIN && target.type !== AFFECT_TOUCH && target.type !== AFFECT_IMPACT) {
      reject(
        'domain_event_type_not_allowed',
        `Affect 验证器只放行 ${AFFECT_ORIGIN} / ${AFFECT_TOUCH} / ${AFFECT_IMPACT}，收到 ${target.type}`,
      )
      continue
    }

    // ② 结构判据（登记过的码优先；然后 registry 兜底形状与大小）
    const structural = structuralRejectionOf(target)
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

    // 结构校验已过 ⇒ payload 是三类已验证形状之一（registry 的 validatePayload
    // 已做结构收窄；这里按事件类型取判别引用，避免联合类型上误访字段）
    const originPayload = target.type === AFFECT_ORIGIN ? (target.payload as AffectOriginPayload) : undefined
    const touchPayload = target.type === AFFECT_TOUCH ? (target.payload as AffectTouchPayload) : undefined
    const impactPayload = target.type === AFFECT_IMPACT ? (target.payload as AffectImpactPayload) : undefined
    const payload = (originPayload ?? touchPayload ?? impactPayload) as AffectOriginPayload & {
      sourceEventId?: ConversationEventId
      ruleId?: string
      ruleVersion?: string
      delta?: { deltaValence: number; deltaArousal: number }
    }
    // ⑦ 的闭集守卫（isAffectImpactRuleId + continue）之后 IMPACT 的 ruleId 必是
    // 七族之一；这里提前收窄供 ⑦/⑨ 共用（`!` 断言会丢失属性窄化，故用本地）。
    const impactRuleId = impactPayload?.ruleId as AffectRuleFamily | undefined

    // ③ owner 一致（伪造跨角色情绪——失败关闭）
    if (String(payload.characterId) !== String(proposal.characterId)) {
      reject(
        'affect_owner_mismatch',
        `payload.characterId=${String(payload.characterId)} ≠ characterId=${String(proposal.characterId)}`,
      )
      continue
    }

    // ④ 注入来源：登记但失败关闭（Cognitive Intervention 未开闸——ADR-066 §2.2）
    if (!originKindAcceptedByM8(payload.originKind)) {
      reject(
        'affect_origin_injection_not_enabled',
        `originKind=${payload.originKind}：M8 只放行 ACTIVATION_BASELINE / INTERACTION_DERIVED` +
          '（MAINTENANCE_REPAIR / TEST_FIXTURE / HISTORICAL_IMPORT 登记但失败关闭）',
      )
      continue
    }

    const state = await deps.affect.getAffectState(proposal.characterId)

    if (target.type === AFFECT_ORIGIN) {
      // ⑤a ORIGIN：一个 Character 只建一次档
      if (state !== undefined && state.originated) {
        reject(
          'affect_origin_duplicate',
          `Character ${String(proposal.characterId)} 的情绪投影已建档；后续变化走 TOUCH/IMPACT`,
        )
        continue
      }
    } else {
      // ⑤b TOUCH/IMPACT：没有中性起点就没有可采信的情绪生活史
      if (state === undefined || !state.originated) {
        reject(
          'affect_not_originated',
          `Character ${String(proposal.characterId)} 的情绪投影尚未建档，${target.type} 不放行`,
        )
        continue
      }

      // ⑥ 证据三层：存在性 → 归属 → 资格四条（cutover 来自状态）
      if (proposal.sourceConversationEventIds.length === 0) {
        reject(
          'affect_source_missing',
          'TOUCH/IMPACT 必须引用至少一条真实对话事件（ADR-066 §3：无证据不变化）',
        )
        continue
      }
      const found = await deps.evidence.findEvents(proposal.sourceConversationEventIds)
      const foundIds = new Set(found.map((e) => String(e.id)))
      const missing = proposal.sourceConversationEventIds.filter((id) => !foundIds.has(String(id)))
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
      const verdict = affectEvidenceVerdictOf(
        found.map((e) => ({
          id: e.id,
          sequence: e.sequence,
          type: e.type,
          trustedOrigin: e.trustedOrigin,
        })),
        { ...deps.policy, cutoverSequence: state.cutoverSequence },
      )
      if (!verdict.ok) {
        reject(verdict.code, verdict.detail)
        continue
      }
      // ⑥b payload 声称的 sourceEventId 必须在合格集合里
      //（防"因果集合格但 payload 指向别的事件"的装配错位）
      const claimedSourceId = (touchPayload ?? impactPayload)!.sourceEventId
      if (!verdict.qualifiedEventIds.some((id) => String(id) === String(claimedSourceId))) {
        reject(
          'affect_source_unqualified',
          `payload.sourceEventId=${String(claimedSourceId)} 不在提案的合格证据集合里`,
        )
        continue
      }

      // ⑦ IMPACT 专属：规则已知 + 策略版本分叉 + 增量判据（拒绝，不静默夹）
      //    M8.5 WP7（计划 §7.3）：旧词形路径**保留旧校验含义**（范围界）；
      //    语义策略 `affect-semantic-policy@1` 追加独立 allowlist——
      //    **精确增量**（与该族冻结表逐字段相等，不是"在 ±0.25 内"）+
      //    SOURCE_ANCHORED 时间形状。两套判据互不放松：词形版本走私语义
      //    负载、语义版本缺时间形状，都失败关闭。
      if (impactPayload !== undefined) {
        /*
         * **S8 / ADR-093 `D08`**：`story-appraisal@1` 是**第三张**策略表，
         * 与词形（`affect-rules@1`）和语义（`affect-semantic-policy@1`）**并列**。
         *
         * ⚠️ 这里按 `ruleVersion` **选表**，不是把三张表并成一个"允许集合"——
         * 并集会让"用词形版本走私一条故事规则"变成合法，而三张表的判据本来就不同
         * （词形=范围界 · 语义=精确增量+时间形状 · 故事=精确增量+来源必须是 STORY_DERIVED）。
         */
        const isStoryImpact = impactPayload.ruleVersion === STORY_APPRAISAL_RULES_VERSION
        if (isStoryImpact) {
          if (!isStoryAppraisalRuleId(impactPayload.ruleId)) {
            reject(
              'affect_rule_unknown',
              `ruleId=${impactPayload.ruleId} 不在故事规则表（${STORY_APPRAISAL_RULES_VERSION} 的 ` +
                `${String(STORY_APPRAISAL_RULE_IDS.length)} 条）`,
            )
            continue
          }
          /*
           * 来源必须是 `STORY_DERIVED`：故事规则**不得**挂在"用户交互"名下，
           * 否则"模拟里一起通过了"会与她真实的用户交互在来源轴上不可区分（`D08`）。
           */
          if (impactPayload.originKind !== 'STORY_DERIVED') {
            reject(
              'affect_origin_kind_mismatch',
              `${STORY_APPRAISAL_RULES_VERSION} 的 IMPACT 必须 originKind=STORY_DERIVED，` +
                `收到 ${String(impactPayload.originKind)}`,
            )
            continue
          }
          const expectedStory = STORY_APPRAISAL_RULE_DELTAS[impactPayload.ruleId]
          if (
            impactPayload.delta.deltaValence !== expectedStory.deltaValence ||
            impactPayload.delta.deltaArousal !== expectedStory.deltaArousal
          ) {
            reject(
              'affect_delta_not_exact',
              `delta=(${String(impactPayload.delta.deltaValence)},${String(impactPayload.delta.deltaArousal)}) ` +
                `≠ 故事规则 ${impactPayload.ruleId} 的冻结增量 ` +
                `(${String(expectedStory.deltaValence)},${String(expectedStory.deltaArousal)})——` +
                '故事规则要求精确一致，不是范围界（ADR-093 D08）',
            )
            continue
          }
        } else if (!isAffectImpactRuleId(impactPayload.ruleId)) {
          reject(
            'affect_rule_unknown',
            `ruleId=${impactPayload.ruleId} 不在冻结规则表（affect-rules@1 的 7 个模式族；` +
              'A-NEUTRAL-TOUCH / A-UNCERTAIN 恒不产生 impact）',
          )
          continue
        }
        // 语义时间形状探测（AffectSemanticImpactPayload 的两个扩展字段；
        // 原始 payload 直读——registry 校验不拒未知字段，accepted 事件带原样 payload）
        const semanticShape = target.payload as Partial<AffectSemanticImpactPayload>
        const carriesSemanticTiming =
          semanticShape.timingKind !== undefined || semanticShape.sourceAt !== undefined
        if (impactPayload.ruleVersion === AFFECT_RULES_VERSION) {
          // —— 旧词形分支（M8 语义原样）——
          if (carriesSemanticTiming) {
            reject(
              'affect_timing_shape_invalid',
              `词形策略 ${AFFECT_RULES_VERSION} 不携带时间形状（timingKind/sourceAt）；` +
                `语义负载必须走 ${AFFECT_SEMANTIC_POLICY_VERSION}`,
            )
            continue
          }
          if (!affectDeltaWithinBounds(impactPayload.delta)) {
            reject(
              'affect_delta_out_of_bounds',
              `delta=(${String(impactPayload.delta.deltaValence)},${String(impactPayload.delta.deltaArousal)}) ` +
                `超出单事件上限（|Δ|≤0.25——拒绝，不静默夹）`,
            )
            continue
          }
        } else if (impactPayload.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION) {
          // —— 语义分支（M8.5 / WP7）——
          if (
            semanticShape.timingKind !== 'SOURCE_ANCHORED' ||
            typeof semanticShape.sourceAt !== 'number' ||
            !Number.isFinite(semanticShape.sourceAt)
          ) {
            reject(
              'affect_timing_shape_invalid',
              `语义策略 ${AFFECT_SEMANTIC_POLICY_VERSION} 的 IMPACT 必须 ` +
                'timingKind=SOURCE_ANCHORED 且 sourceAt 为有限数字（M85-D19 慢路径时间语义）',
            )
            continue
          }
          /*
           * 显式再收窄一次：`ruleId` 在故事分支里被窄化成 `StoryAppraisalRuleId`，
           * 汇合之后类型是并集。这里落回旧表**必须**再过一次旧表的登记判据 ——
           * 顺便让"语义策略只查 affect-rules@1 的族"这件事在代码里看得见。
           */
          if (!isAffectImpactRuleId(impactPayload.ruleId)) {
            reject(
              'affect_rule_unknown',
              `ruleId=${impactPayload.ruleId} 不在词形规则表（${AFFECT_RULES_VERSION}）：` +
                `语义策略 ${AFFECT_SEMANTIC_POLICY_VERSION} 复用同一数值表`,
            )
            continue
          }
          const expected = AFFECT_RULE_DELTAS[impactPayload.ruleId]
          if (
            impactPayload.delta.deltaValence !== expected.deltaValence ||
            impactPayload.delta.deltaArousal !== expected.deltaArousal
          ) {
            reject(
              'affect_delta_not_exact',
              `delta=(${String(impactPayload.delta.deltaValence)},${String(impactPayload.delta.deltaArousal)}) ` +
                `≠ 族 ${impactPayload.ruleId} 的冻结增量 ` +
                `(${String(expected.deltaValence)},${String(expected.deltaArousal)})——` +
                '语义策略要求精确一致（计划 §7.3），不是范围界',
            )
            continue
          }
        } else if (impactPayload.ruleVersion === STORY_APPRAISAL_RULES_VERSION) {
          /*
           * 故事分支：**判据已在上面"选表"那一段判完**（ruleId ∈ 故事表 ·
           * originKind = STORY_DERIVED · delta 与该规则的冻结值精确一致）。
           * 这里刻意**不重复**判一遍：一个概念一处实现。
           */
        } else {
          reject(
            'affect_rule_version_mismatch',
            `ruleVersion=${impactPayload.ruleVersion} 不在已登记策略表 ` +
              `（${AFFECT_RULES_VERSION} / ${AFFECT_SEMANTIC_POLICY_VERSION} / ${STORY_APPRAISAL_RULES_VERSION}）`,
          )
          continue
        }
      }
    }

    // ⑧ 作用域（放行口必须记录它放行了什么范围）
    try {
      assertCharacterInternalScope(target.scope ?? DOMAIN_EVENT_SCOPE)
    } catch (error) {
      reject(
        'scope_not_character_internal',
        error instanceof Error ? error.message : 'scope 必须是 CHARACTER_INTERNAL',
      )
      continue
    }

    // ⑨ 幂等（领域键推导 + 已处理检查；range 恒置零——见文件头）
    const idempotencyKey =
      target.type === AFFECT_ORIGIN
        ? computeIdempotencyKey({
            characterId: proposal.characterId,
            processor: proposal.processor,
            processorVersion: proposal.processorVersion,
            sourceFromSequence: 0,
            sourceToSequence: 0,
            operation: 'affect-origin',
          })
        : idempotencyKeyForAffectEvent({
            characterId: proposal.characterId,
            processor: proposal.processor,
            processorVersion: proposal.processorVersion,
            operation: target.operation,
            sourceEventId:
              target.type === AFFECT_TOUCH
                ? touchPayload!.sourceEventId
                : impactPayload!.sourceEventId,
            ...(target.type === AFFECT_IMPACT ? { ruleId: impactPayload!.ruleId } : {}),
            // M8.5 WP7：语义策略 IMPACT 用冻结的语义领域串（affect-semantic-impact:…）
            ...(target.type === AFFECT_IMPACT &&
              impactRuleId !== undefined &&
              impactPayload!.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION
              ? {
                  unitOperation: affectSemanticImpactIdempotencyOperation(
                    impactRuleId,
                    impactPayload!.sourceEventId,
                  ),
                }
              : {}),
          })
    if (await deps.processed.hasProcessed(idempotencyKey)) {
      reject(
        'duplicate_operation',
        `幂等键已处理过（${target.type} 单元 ` +
          `${target.type === AFFECT_IMPACT ? `${impactPayload!.ruleId}:` : ''}` +
          `${String(target.type === AFFECT_TOUCH ? touchPayload!.sourceEventId : impactPayload!.sourceEventId)}`,
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
