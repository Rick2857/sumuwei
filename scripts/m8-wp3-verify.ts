/**
 * M8 WP3 —— **提案器部件门**（`pnpm m8:wp3:verify`）。
 *
 * ============================================================================
 *  要测的命题（计划 §10 WP3 出口条件）
 * ============================================================================
 * ① 评估器：只有合格用户交互（user_message + ESTABLISHED + active user +
 *    切换后）能产生提案；每条合格事件 1 touch + 至多 1 主导 impact
 *    （M8-D07/D08）；无命中 ⇒ 只 touch（诚实中性）。
 * ② 冻结规则表行为：7 族触发 · 主导裁定全序 · delta 表值正确。
 * ③ 提案只提案不落库（本门不打开任何数据库；落库归 WP4 的装配）。
 * ④ Validator：唯一放行口的行为——owner/originKind/建档/规则/版本/界/
 *    证据三层（存在/归属/资格）/幂等，全部失败关闭。
 * ⑤ 幂等键：touch/impact 的领域键跨窗口同源必然撞键（range 恒置零）。
 *
 * 量具纪律：§6.7 三段式（正控/负控/恢复）+ §6.8 measured_count 自检。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { attributionKnown } from '../src/kernel/contracts/actor.ts'
import type { TrustedOriginReading } from '../src/kernel/contracts/attribution.ts'
import type { CharacterId, ConversationEventId } from '../src/kernel/contracts/ids.ts'
import type { ProcessorContext, ProcessorEventView } from '../src/kernel/contracts/processor.ts'
import type { DomainProposal } from '../src/kernel/contracts/proposal.ts'
import { createProposal } from '../src/kernel/contracts/proposal.ts'
import { AFFECT_ORIGIN, AFFECT_TOUCH, AFFECT_IMPACT } from '../src/kernel/contracts/domain-event.ts'
import { createAffectDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import {
  AFFECT_ORIGIN_PROPOSAL_TYPE,
  AFFECT_TOUCH_PROPOSAL_TYPE,
  AFFECT_IMPACT_PROPOSAL_TYPE,
  AFFECT_RULES_VERSION,
  type AffectImpactPayload,
  type AffectOriginPayload,
  type AffectState,
  type AffectTouchPayload,
} from '../src/kernel/contracts/affect.ts'
import {
  AFFECT_EVALUATOR_NAME,
  AFFECT_EVALUATOR_VERSION,
  RuleBasedAffectEvaluator,
  qualifiedAffectEvidence,
  type AffectEvaluationInput,
  type AffectProposalAudit,
} from '../src/kernel/app/affect/evaluator.ts'
import {
  idempotencyKeyForAffectEvent,
  validateAffectProposal,
  type AffectValidatorDeps,
} from '../src/kernel/policies/affect-validator.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CHARACTER_ID = 'char_sumuwei' as CharacterId
const ACTIVE_USER = 'user-1'
const CONTEXT: ProcessorContext = { processorName: 'wp3-verify', processorVersion: 'wp3-verify@1' }
const T0 = Date.UTC(2026, 8, 26, 2, 0, 0)

let eventCounter = 0

function userReading(userId: string, axisB = true): TrustedOriginReading {
  return {
    attributionOrigin: 'RECORDED',
    contentOriginator: attributionKnown({ kind: 'USER', id: userId }),
    axisBConfirmed: axisB,
  }
}

function userMessage(content: string, createdAt: number, userId = ACTIVE_USER): ProcessorEventView {
  eventCounter += 1
  return {
    id: `cev-${String(eventCounter).padStart(4, '0')}` as ConversationEventId,
    sequence: eventCounter,
    conversationSequence: eventCounter,
    type: 'user_message',
    actorType: 'user',
    content,
    createdAt,
    trustedOrigin: userReading(userId),
  }
}

function assistantMessage(content: string, createdAt: number): ProcessorEventView {
  eventCounter += 1
  return {
    id: `cev-${String(eventCounter).padStart(4, '0')}` as ConversationEventId,
    sequence: eventCounter,
    conversationSequence: eventCounter,
    type: 'assistant_message',
    actorType: 'character',
    content,
    createdAt,
  }
}

function systemEvent(createdAt: number): ProcessorEventView {
  eventCounter += 1
  return {
    id: `cev-${String(eventCounter).padStart(4, '0')}` as ConversationEventId,
    sequence: eventCounter,
    conversationSequence: eventCounter,
    type: 'system_event',
    actorType: 'system',
    content: '(tool output)',
    createdAt,
  }
}

function evaluationInput(
  views: readonly ProcessorEventView[],
  cutoverSequence: number | null = 0,
): AffectEvaluationInput {
  return {
    characterId: CHARACTER_ID,
    views,
    policy: { activeUserId: ACTIVE_USER, cutoverSequence },
  }
}

const ORIGINATED_STATE: AffectState = {
  originated: true,
  valence: 0.1,
  arousal: 0.2,
  originKind: 'ACTIVATION_BASELINE',
  lastInteractionAt: T0,
  lastAffectEventAt: T0,
  lastDomainEventId: 'de-o1' as never,
  cutoverSequence: 0,
}

/** 证据行（Validator 的 evidence.findEvents 返回形状） */
interface EvidenceRow {
  id: ConversationEventId
  characterId: CharacterId
  sequence: number
  type: string
  trustedOrigin?: TrustedOriginReading
}

function evidenceRowOf(view: ProcessorEventView, characterId: CharacterId = CHARACTER_ID): EvidenceRow {
  return {
    id: view.id,
    characterId,
    sequence: view.sequence,
    type: view.type,
    trustedOrigin: view.trustedOrigin,
  }
}

/** 内存版 Validator 依赖（processed 是可变 Set——负控/恢复控要操作它） */
function makeValidatorDeps(options: {
  evidenceRows: EvidenceRow[]
  state: AffectState | undefined
  processedKeys?: Set<string>
}): AffectValidatorDeps {
  const processed = options.processedKeys ?? new Set<string>()
  return {
    registry: createAffectDomainEventRegistry(),
    evidence: {
      findEvents: async (ids) =>
        options.evidenceRows.filter((row) => ids.some((id) => String(id) === String(row.id))),
    },
    processed: { hasProcessed: async (key: string) => processed.has(key) },
    affect: { getAffectState: async () => options.state },
    policy: { activeUserId: ACTIVE_USER },
  }
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []

function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

async function evaluate(
  views: readonly ProcessorEventView[],
  cutoverSequence: number | null = 0,
): Promise<DomainProposal<AffectProposalAudit>[]> {
  const evaluator = new RuleBasedAffectEvaluator()
  return evaluator.process(evaluationInput(views, cutoverSequence), CONTEXT)
}

function touchPayloadOf(proposal: DomainProposal): AffectTouchPayload {
  return proposal.targetEvents[0]!.payload as AffectTouchPayload
}

function impactPayloadOf(proposal: DomainProposal): AffectImpactPayload {
  return proposal.targetEvents[0]!.payload as AffectImpactPayload
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ===== 评估器：正控 =====

  const gratitudeViews = [userMessage('谢谢你，帮大忙了', T0)]
  const p1 = await evaluate(gratitudeViews)
  const p1Touch = p1.find((x) => x.proposalType === AFFECT_TOUCH_PROPOSAL_TYPE)
  const p1Impact = p1.find((x) => x.proposalType === AFFECT_IMPACT_PROPOSAL_TYPE)
  record(
    'P1',
    '感谢消息 → 1 touch + 1 impact（A-GRATITUDE，冻结 delta +0.08/-0.03）；来源绑定该事件',
    '2 提案 · A-GRATITUDE · Δ=(0.08,-0.03)',
    `${String(p1.length)} 提案${p1Impact !== undefined ? ` · ${impactPayloadOf(p1Impact).ruleId} · Δ=(${String(impactPayloadOf(p1Impact).delta.deltaValence)},${String(impactPayloadOf(p1Impact).delta.deltaArousal)})` : ''}`,
    p1.length === 2 &&
      p1Touch !== undefined &&
      p1Impact !== undefined &&
      impactPayloadOf(p1Impact).ruleId === 'A-GRATITUDE' &&
      impactPayloadOf(p1Impact).delta.deltaValence === 0.08 &&
      impactPayloadOf(p1Impact).delta.deltaArousal === -0.03 &&
      String(touchPayloadOf(p1Touch).sourceEventId) === String(gratitudeViews[0]!.id) &&
      p1Touch.sourceConversationEventIds.length === 1,
  )

  const neutralViews = [userMessage('今天聊聊那个方案吧', T0)]
  const p2 = await evaluate(neutralViews)
  record(
    'P2',
    '中性消息 → 只 1 touch、0 impact（M8-D07：中性交互消费锚点但不改轴）',
    '1 提案（touch）',
    `${String(p2.length)} 提案 · touch=${String(p2.filter((x) => x.proposalType === AFFECT_TOUCH_PROPOSAL_TYPE).length)} · impact=${String(p2.filter((x) => x.proposalType === AFFECT_IMPACT_PROPOSAL_TYPE).length)}`,
    p2.length === 1 && p2[0]!.proposalType === AFFECT_TOUCH_PROPOSAL_TYPE,
  )

  const hostileViews = [userMessage('我讨厌你，你真差劲', T0)]
  const p3 = await evaluate(hostileViews)
  const p3Impact = p3.find((x) => x.proposalType === AFFECT_IMPACT_PROPOSAL_TYPE)
  record(
    'P3',
    '敌意消息 → touch + A-HOSTILE impact（Δ=(-0.15,+0.12)；matchedPatternId 在 payload）',
    'A-HOSTILE · Δ=(-0.15,0.12) · pattern 非空',
    p3Impact !== undefined
      ? `${impactPayloadOf(p3Impact).ruleId} · Δ=(${String(impactPayloadOf(p3Impact).delta.deltaValence)},${String(impactPayloadOf(p3Impact).delta.deltaArousal)}) · pattern=${String(impactPayloadOf(p3Impact).matchedPatternId)}`
      : '(无 impact)',
    p3.length === 2 &&
      p3Impact !== undefined &&
      impactPayloadOf(p3Impact).ruleId === 'A-HOSTILE' &&
      impactPayloadOf(p3Impact).delta.deltaValence === -0.15 &&
      impactPayloadOf(p3Impact).delta.deltaArousal === 0.12 &&
      typeof impactPayloadOf(p3Impact).matchedPatternId === 'string',
  )

  const mixedViews = [userMessage('谢谢你。但是这事很紧急，快点处理', T0)]
  const p4 = await evaluate(mixedViews)
  const p4Impacts = p4.filter((x) => x.proposalType === AFFECT_IMPACT_PROPOSAL_TYPE)
  record(
    'P4',
    '感谢+紧急同现 → 只 1 条主导 impact = A-URGENT（M8-D08/D09 全序，不叠加）',
    '1 impact · A-URGENT',
    `${String(p4Impacts.length)} impact${p4Impacts.length === 1 ? ` · ${impactPayloadOf(p4Impacts[0]!).ruleId}` : ''}`,
    p4.length === 2 && p4Impacts.length === 1 && impactPayloadOf(p4Impacts[0]!).ruleId === 'A-URGENT',
  )

  const multiViews = [
    userMessage('谢谢你', T0),
    assistantMessage('不客气', T0 + 1000),
    userMessage('别难过，慢慢来', T0 + 2000),
    userMessage('嗯嗯', T0 + 3000),
  ]
  const p5 = await evaluate(multiViews)
  const p5Touches = p5.filter((x) => x.proposalType === AFFECT_TOUCH_PROPOSAL_TYPE)
  const p5Impacts = p5.filter((x) => x.proposalType === AFFECT_IMPACT_PROPOSAL_TYPE)
  record(
    'P5',
    '窗口 3 条合格用户消息（+1 条她的回复）→ 3 touch + 2 impact（逐事件，M8-D08）',
    '3 touch · 2 impact',
    `${String(p5Touches.length)} touch · ${String(p5Impacts.length)} impact`,
    p5Touches.length === 3 &&
      p5Impacts.length === 2 &&
      p5Impacts.every((x) => ['A-GRATITUDE', 'A-COMFORT'].includes(impactPayloadOf(x).ruleId)),
  )

  const p6a = await evaluate(gratitudeViews)
  const p6b = await evaluate(gratitudeViews)
  // 语义相同 = 除每实例关联字段（proposalId——ADR-066 §3 冻结在 payload 里的
  // correlation id，两次调用必然不同）外逐字节同形；幂等的机器保证在键（P10/N18）
  const semanticShapeOf = (proposals: readonly DomainProposal<AffectProposalAudit>[]) =>
    proposals.map((p) => ({
      type: p.targetEvents[0]!.type,
      sources: p.sourceConversationEventIds.map(String),
      payload: JSON.stringify(p.targetEvents[0]!.payload, (key, value) =>
        key === 'proposalId' ? '<per-instance>' : value,
      ),
    }))
  const p6Same =
    p6a.length === p6b.length &&
    JSON.stringify(semanticShapeOf(p6a)) === JSON.stringify(semanticShapeOf(p6b))
  record(
    'P6',
    '幂等性：同一窗口重复调用 → 语义相同的提案集（除 proposalId 关联字段外逐字节同形；单次落库由幂等键保证）',
    '两次语义一致',
    `一致=${String(p6Same)}`,
    p6Same,
  )

  // ===== 评估器：负控（不合格来源 0 提案）=====

  const n1 = await evaluate([assistantMessage('谢谢你', T0)])
  record(
    'N1',
    '负控：她的回复（assistant_message）即使含触发词也 0 提案',
    '0 提案',
    `${String(n1.length)} 提案`,
    n1.length === 0,
  )

  const unconfirmed = userMessage('谢谢你', T0)
  unconfirmed.trustedOrigin = userReading(ACTIVE_USER, false)
  const n2 = await evaluate([unconfirmed])
  record(
    'N2',
    '负控：Axis B 未确认（axisBConfirmed=false）→ 0 提案（失败关闭）',
    '0 提案',
    `${String(n2.length)} 提案`,
    n2.length === 0,
  )

  const n3 = await evaluate([userMessage('谢谢你', T0, 'user-other')])
  record(
    'N3',
    '负控：非 active user 的消息 → 0 提案（M8-D11）',
    '0 提案',
    `${String(n3.length)} 提案`,
    n3.length === 0,
  )

  const preCutover = userMessage('谢谢你', T0)
  const n4 = await evaluate([preCutover], 1000)
  record(
    'N4',
    '负控：切换前事件（sequence ≤ cutover）→ 0 提案（M8-D05 不重放）',
    '0 提案',
    `${String(n4.length)} 提案`,
    n4.length === 0,
  )

  const n5 = await evaluate([systemEvent(T0)])
  record(
    'N5',
    '负控：system_event（工具/系统）→ 0 提案',
    '0 提案',
    `${String(n5.length)} 提案`,
    n5.length === 0,
  )

  const noEnvelope = userMessage('谢谢你', T0)
  noEnvelope.trustedOrigin = undefined
  const n5b = await evaluate([noEnvelope])
  record(
    'N5b',
    '负控：无归因信封（trustedOrigin 缺失）→ 0 提案（未确立归因）',
    '0 提案',
    `${String(n5b.length)} 提案`,
    n5b.length === 0,
  )

  // ===== Validator：正控 =====

  const validEvidence = [evidenceRowOf(gratitudeViews[0]!)]
  const touchDeps = makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE })
  const p7 = await validateAffectProposal(touchDeps, p1Touch!)
  record(
    'P7',
    'Validator 正控：合法 touch 提案放行（建档在 + 证据合格 + 幂等键新鲜）',
    'accepted=true · 1 事件',
    `accepted=${String(p7.accepted)} · 事件=${String(p7.acceptedEvents.length)}${p7.acceptedEvents[0] ? ` · 键=${p7.acceptedEvents[0].idempotencyKey.slice(0, 24)}…` : ''}`,
    p7.accepted && p7.acceptedEvents.length === 1 && p7.acceptedEvents[0]!.type === AFFECT_TOUCH,
  )

  const impactDeps = makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE })
  const p8 = await validateAffectProposal(impactDeps, p1Impact!)
  record(
    'P8',
    'Validator 正控：合法 impact 提案放行（规则已知 + 版本匹配 + 界内）',
    'accepted=true · 1 事件',
    `accepted=${String(p8.accepted)} · 事件=${String(p8.acceptedEvents.length)}`,
    p8.accepted && p8.acceptedEvents.length === 1 && p8.acceptedEvents[0]!.type === AFFECT_IMPACT,
  )

  const originPayload: AffectOriginPayload = {
    characterId: CHARACTER_ID,
    initialValence: 0,
    initialArousal: 0,
    originKind: 'ACTIVATION_BASELINE',
    activationId: 'activation-test-001',
    cutoverAt: T0,
    cutoverSequence: 10,
    policyVersion: 'affect-policy@1',
  }
  const originProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_ORIGIN_PROPOSAL_TYPE,
    sourceConversationEventIds: [],
    payload: { activationId: 'activation-test-001' },
    targetEvents: [{ type: AFFECT_ORIGIN, operation: 'create', payload: originPayload }],
    processor: 'affect-origin-seeder',
    processorVersion: 'affect-origin-seeder@1',
  })
  const originDeps = makeValidatorDeps({ evidenceRows: [], state: undefined })
  const p9 = await validateAffectProposal(originDeps, originProposal)
  record(
    'P9',
    'Validator 正控：未建档时的 ORIGIN 提案放行（凭据是激活授权，不需要对话证据）',
    'accepted=true',
    `accepted=${String(p9.accepted)} · 事件=${String(p9.acceptedEvents.length)}`,
    p9.accepted && p9.acceptedEvents.length === 1,
  )

  // ===== Validator：负控（全部失败关闭）=====

  const rejectionOf = async (
    deps: AffectValidatorDeps,
    proposal: DomainProposal,
  ): Promise<{ code: string; message: string } | undefined> => {
    const outcome = await validateAffectProposal(deps, proposal)
    return outcome.rejected[0]
  }

  const n6 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: undefined }),
    p1Touch!,
  )
  record(
    'N6',
    'Validator 负控：未建档先 touch → affect_not_originated',
    'affect_not_originated',
    `${String(n6?.code)}`,
    n6?.code === 'affect_not_originated',
  )

  const badRuleProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'impact', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      {
        type: AFFECT_IMPACT,
        operation: 'update',
        payload: {
          ...impactPayloadOf(p1Impact!),
          ruleId: 'A-HACKED',
        },
      },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n7 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE }),
    badRuleProposal,
  )
  record(
    'N7',
    'Validator 负控：未知规则 → affect_rule_unknown（A-NEUTRAL-TOUCH/A-UNCERTAIN/未知名都不放行）',
    'affect_rule_unknown',
    `${String(n7?.code)}`,
    n7?.code === 'affect_rule_unknown',
  )

  const badVersionProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'impact', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      {
        type: AFFECT_IMPACT,
        operation: 'update',
        payload: {
          ...impactPayloadOf(p1Impact!),
          ruleVersion: 'affect-rules@0',
        },
      },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n8 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE }),
    badVersionProposal,
  )
  record(
    'N8',
    `Validator 负控：版本不匹配（affect-rules@0 ≠ ${AFFECT_RULES_VERSION}）→ affect_rule_version_mismatch`,
    'affect_rule_version_mismatch',
    `${String(n8?.code)}`,
    n8?.code === 'affect_rule_version_mismatch',
  )

  const badDeltaProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'impact', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      {
        type: AFFECT_IMPACT,
        operation: 'update',
        payload: {
          ...impactPayloadOf(p1Impact!),
          delta: { deltaValence: 0.3, deltaArousal: 0 },
        },
      },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n9 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE }),
    badDeltaProposal,
  )
  record(
    'N9',
    'Validator 负控：delta 超界（0.3 > 0.25）→ affect_delta_out_of_bounds（拒绝不夹取）',
    'affect_delta_out_of_bounds',
    `${String(n9?.code)}`,
    n9?.code === 'affect_delta_out_of_bounds',
  )

  const ownerMismatchProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_TOUCH_PROPOSAL_TYPE,
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'touch', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      {
        type: AFFECT_TOUCH,
        operation: 'update',
        payload: { ...touchPayloadOf(p1Touch!), characterId: 'char_other' as CharacterId },
      },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n10 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE }),
    ownerMismatchProposal,
  )
  record(
    'N10',
    'Validator 负控：payload.characterId ≠ characterId → affect_owner_mismatch（跨角色情绪）',
    'affect_owner_mismatch',
    `${String(n10?.code)}`,
    n10?.code === 'affect_owner_mismatch',
  )

  const injectionProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_ORIGIN_PROPOSAL_TYPE,
    sourceConversationEventIds: [],
    payload: { activationId: 'injection-test' },
    targetEvents: [
      {
        type: AFFECT_ORIGIN,
        operation: 'create',
        payload: { ...originPayload, originKind: 'MAINTENANCE_REPAIR' },
      },
    ],
    processor: 'affect-origin-seeder',
    processorVersion: 'affect-origin-seeder@1',
  })
  const n11 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [], state: undefined }),
    injectionProposal,
  )
  record(
    'N11',
    'Validator 负控：MAINTENANCE_REPAIR 注入 → affect_origin_injection_not_enabled（Cognitive Intervention 未开闸）',
    'affect_origin_injection_not_enabled',
    `${String(n11?.code)}`,
    n11?.code === 'affect_origin_injection_not_enabled',
  )

  const n12 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [], state: ORIGINATED_STATE }),
    originProposal,
  )
  record(
    'N12',
    'Validator 负控：已建档再 ORIGIN → affect_origin_duplicate',
    'affect_origin_duplicate',
    `${String(n12?.code)}`,
    n12?.code === 'affect_origin_duplicate',
  )

  const n13 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [], state: ORIGINATED_STATE }),
    p1Touch!,
  )
  record(
    'N13',
    'Validator 负控：引用事件不存在（窗外/已删）→ source_event_missing',
    'source_event_missing',
    `${String(n13?.code)}`,
    n13?.code === 'source_event_missing',
  )

  const foreignRow = evidenceRowOf(gratitudeViews[0]!, 'char_other' as CharacterId)
  const n14 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [foreignRow], state: ORIGINATED_STATE }),
    p1Touch!,
  )
  record(
    'N14',
    'Validator 负控：引用事件属于别的角色 → source_event_foreign',
    'source_event_foreign',
    `${String(n14?.code)}`,
    n14?.code === 'source_event_foreign',
  )

  const preCutoverRow: EvidenceRow = {
    ...evidenceRowOf(gratitudeViews[0]!),
    sequence: 5,
  }
  const preCutoverState: AffectState = { ...ORIGINATED_STATE, cutoverSequence: 100 }
  const n15 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [preCutoverRow], state: preCutoverState }),
    p1Touch!,
  )
  record(
    'N15',
    'Validator 负控：证据事件序号 ≤ cutover → affect_source_unqualified（M8-D05）',
    'affect_source_unqualified',
    `${String(n15?.code)}`,
    n15?.code === 'affect_source_unqualified',
  )

  const foreignUserRow = evidenceRowOf(userMessage('谢谢你', T0, 'user-other'))
  const n16 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [foreignUserRow], state: ORIGINATED_STATE }),
    createProposal({
      characterId: CHARACTER_ID,
      proposalType: AFFECT_TOUCH_PROPOSAL_TYPE,
      sourceConversationEventIds: [foreignUserRow.id],
      payload: { kind: 'touch', sourceEventId: String(foreignUserRow.id) },
      targetEvents: [
        {
          type: AFFECT_TOUCH,
          operation: 'update',
          payload: {
            characterId: CHARACTER_ID,
            sourceEventId: foreignUserRow.id,
            sourceSequence: foreignUserRow.sequence,
            originKind: 'INTERACTION_DERIVED',
            evaluatorVersion: AFFECT_EVALUATOR_VERSION,
            proposalId: 'prop-n16',
          },
        },
      ],
      processor: AFFECT_EVALUATOR_NAME,
      processorVersion: AFFECT_EVALUATOR_VERSION,
    }),
  )
  record(
    'N16',
    'Validator 负控：证据来自非 active user → affect_source_unqualified（M8-D11）',
    'affect_source_unqualified',
    `${String(n16?.code)}`,
    n16?.code === 'affect_source_unqualified',
  )

  const assistantRow = evidenceRowOf(assistantMessage('谢谢你', T0))
  const n17 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: [assistantRow], state: ORIGINATED_STATE }),
    createProposal({
      characterId: CHARACTER_ID,
      proposalType: AFFECT_TOUCH_PROPOSAL_TYPE,
      sourceConversationEventIds: [assistantRow.id],
      payload: { kind: 'touch', sourceEventId: String(assistantRow.id) },
      targetEvents: [
        {
          type: AFFECT_TOUCH,
          operation: 'update',
          payload: {
            characterId: CHARACTER_ID,
            sourceEventId: assistantRow.id,
            sourceSequence: assistantRow.sequence,
            originKind: 'INTERACTION_DERIVED',
            evaluatorVersion: AFFECT_EVALUATOR_VERSION,
            proposalId: 'prop-n17',
          },
        },
      ],
      processor: AFFECT_EVALUATOR_NAME,
      processorVersion: AFFECT_EVALUATOR_VERSION,
    }),
  )
  record(
    'N17',
    'Validator 负控：证据是她的回复（assistant_message）→ affect_source_unqualified',
    'affect_source_unqualified',
    `${String(n17?.code)}`,
    n17?.code === 'affect_source_unqualified',
  )

  const processedKeys = new Set<string>()
  const dupDeps = makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE, processedKeys })
  const firstPass = await validateAffectProposal(dupDeps, p1Touch!)
  processedKeys.add(firstPass.acceptedEvents[0]!.idempotencyKey)
  const secondPass = await validateAffectProposal(dupDeps, p1Touch!)
  record(
    'N18',
    'Validator 负控：同一 touch 提案重放（幂等键已处理）→ duplicate_operation（0 新建）',
    'first accepted · second duplicate_operation',
    `first=${String(firstPass.accepted)} · second=${String(secondPass.accepted)}${secondPass.rejected[0] ? ` · ${secondPass.rejected[0].code}` : ''}`,
    firstPass.accepted && !secondPass.accepted && secondPass.rejected[0]!.code === 'duplicate_operation',
  )

  const misalignedDeps = makeValidatorDeps({
    evidenceRows: [evidenceRowOf(gratitudeViews[0]!), evidenceRowOf(neutralViews[0]!)],
    state: ORIGINATED_STATE,
  })
  const misalignedProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_TOUCH_PROPOSAL_TYPE,
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'touch', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      {
        type: AFFECT_TOUCH,
        operation: 'update',
        payload: {
          characterId: CHARACTER_ID,
          // payload 声称的是另一条事件（装配错位模拟）
          sourceEventId: neutralViews[0]!.id,
          sourceSequence: neutralViews[0]!.sequence,
          originKind: 'INTERACTION_DERIVED',
          evaluatorVersion: AFFECT_EVALUATOR_VERSION,
          proposalId: 'prop-n19',
        },
      },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n19 = await rejectionOf(misalignedDeps, misalignedProposal)
  record(
    'N19',
    'Validator 负控：payload.sourceEventId 不在提案合格集合里 → affect_source_unqualified（防装配错位）',
    'affect_source_unqualified',
    `${String(n19?.code)}`,
    n19?.code === 'affect_source_unqualified',
  )

  const wrongTypeProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: 'affect-touch',
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'touch', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      { type: 'MEMORY_CREATED', operation: 'create', payload: { memoryId: 'x' } },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n20 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE }),
    wrongTypeProposal,
  )
  record(
    'N20',
    'Validator 负控：非 Affect 事件类型（MEMORY_CREATED）→ domain_event_type_not_allowed',
    'domain_event_type_not_allowed',
    `${String(n20?.code)}`,
    n20?.code === 'domain_event_type_not_allowed',
  )

  const nanProposal = createProposal({
    characterId: CHARACTER_ID,
    proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [gratitudeViews[0]!.id],
    payload: { kind: 'impact', sourceEventId: String(gratitudeViews[0]!.id) },
    targetEvents: [
      {
        type: AFFECT_IMPACT,
        operation: 'update',
        payload: {
          ...impactPayloadOf(p1Impact!),
          delta: { deltaValence: Number.NaN, deltaArousal: 0 },
        },
      },
    ],
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
  })
  const n21 = await rejectionOf(
    makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE }),
    nanProposal,
  )
  record(
    'N21',
    'Validator 负控：delta 含 NaN → affect_value_not_finite（结构判据给出登记过的码）',
    'affect_value_not_finite',
    `${String(n21?.code)}`,
    n21?.code === 'affect_value_not_finite',
  )

  // ===== 幂等键：跨窗口同源必然撞键（range 恒置零）=====

  const keyA = idempotencyKeyForAffectEvent({
    characterId: CHARACTER_ID,
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
    operation: 'update',
    sourceEventId: gratitudeViews[0]!.id,
  })
  const keyB = idempotencyKeyForAffectEvent({
    characterId: CHARACTER_ID,
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
    operation: 'update',
    sourceEventId: gratitudeViews[0]!.id,
  })
  const keyOtherEvent = idempotencyKeyForAffectEvent({
    characterId: CHARACTER_ID,
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
    operation: 'update',
    sourceEventId: neutralViews[0]!.id,
  })
  const keyImpact = idempotencyKeyForAffectEvent({
    characterId: CHARACTER_ID,
    processor: AFFECT_EVALUATOR_NAME,
    processorVersion: AFFECT_EVALUATOR_VERSION,
    operation: 'update',
    sourceEventId: gratitudeViews[0]!.id,
    ruleId: 'A-GRATITUDE',
  })
  record(
    'P10',
    '幂等键：同源事件跨窗口必然撞键（range 置零）；不同事件/不同规则 → 不同键',
    'touchA==touchB · touchA≠touchOther · touchA≠impact',
    `A==B=${String(keyA === keyB)} · A≠Other=${String(keyA !== keyOtherEvent)} · A≠Impact=${String(keyA !== keyImpact)}`,
    keyA === keyB && keyA !== keyOtherEvent && keyA !== keyImpact,
  )

  // ===== 恢复 =====

  const r1Deps = makeValidatorDeps({ evidenceRows: validEvidence, state: ORIGINATED_STATE })
  const r1Touch = await validateAffectProposal(r1Deps, p1Touch!)
  const r1Impact = await validateAffectProposal(r1Deps, p1Impact!)
  record(
    'R1',
    '恢复：全部负控之后，合法 touch + impact 提案在全新依赖上重新放行',
    '2 个 accepted',
    `touch=${String(r1Touch.accepted)} · impact=${String(r1Impact.accepted)}`,
    r1Touch.accepted && r1Impact.accepted,
  )

  const r2Views = [userMessage('谢谢你，最近辛苦了', T0 + 5000)]
  const r2 = await evaluate(r2Views)
  record(
    'R2',
    '恢复：全负控窗口之后，新的合格消息重新产出 touch + impact',
    '2 提案',
    `${String(r2.length)} 提案`,
    r2.length === 2,
  )

  const r3Qualified = qualifiedAffectEvidence([...multiViews], {
    activeUserId: ACTIVE_USER,
    cutoverSequence: 0,
  })
  record(
    'R3',
    '恢复：资格筛选在混合窗口上重新安静地只留合格集（3/4——她的回复被滤掉）',
    '3 条合格',
    `${String(r3Qualified.length)} 条合格`,
    r3Qualified.length === 3,
  )

  // ===== 收口 =====

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length
  const stagesValid = positive > 0 && negative > 0 && recovery > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const argOf = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const supersedes = argOf('--supersedes') ?? null
  const supersedesReason = argOf('--supersedes-reason')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM8RunId({ wpId: 'wp3-verify', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-wp3-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    propositions: {
      evaluator: '合格用户交互 → 逐事件 touch + 至多 1 主导 impact（M8-D07/D08/D09）',
      negative: '她的回复 / 未确立 / 非 active user / 切换前 / 系统事件 → 0 提案',
      validator: 'owner / originKind / 建档 / 规则 / 版本 / 界 / 证据三层 / 幂等——失败关闭',
      idempotency: 'touch/impact 领域键跨窗口同源必然撞键（range 恒置零）',
    },
    stages: { positive, negative, recovery },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'proposal-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
    runId,
    wp: 'wp3-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'proposal-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP3 提案器门（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : 'M8 WP3 提案器门：评估器 + Validator 三段式（内存依赖，不开数据库）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
