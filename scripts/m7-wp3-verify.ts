/**
 * M7 WP3 —— **提案器部件门**（`pnpm m7:wp3:verify`）。
 *
 * ============================================================================
 *  要测的命题（计划 §5 WP3 出口条件）
 * ============================================================================
 * ① 只有 confirmed 用户直接互动能产生关系提案（正控 + 负控：
 *    她的生成 / 未确立归因 / Axis B 未确认 = 0 提案——ADR-064 D-3 Tier 1）。
 * ② 冻结规则集的行为正确：R-1 窗口判据与按日单元 · R-2/R-3 窗口聚合 ·
 *    R-4 无指控在案不触发 + 撤回形带 supersede 链 · R-5 里程碑跨过才计。
 * ③ 提案只提案不落库（本门不打开任何数据库；落库归 WP4 的 Validator）。
 * ④ 幂等键：R-1 的日上限有机器保证（跨窗口同日必然撞键）。
 *
 * 量具纪律：§6.7 三段式（正控/负控/恢复）+ §6.8 measured_count 自检。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { attributionKnown } from '../src/kernel/contracts/actor.ts'
import type { TrustedOriginReading } from '../src/kernel/contracts/attribution.ts'
import type { ConversationEventId, DomainEventId, EntityId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import type { ProcessorContext, ProcessorEventView } from '../src/kernel/contracts/processor.ts'
import type { DomainProposal } from '../src/kernel/contracts/proposal.ts'
import type { RelationshipImpactPayload } from '../src/kernel/contracts/relationship.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
  RuleBasedRelationshipEvaluator,
  type RelationshipEvaluationInput,
  type RelationshipProposalAudit,
} from '../src/kernel/app/relationship/evaluator.ts'
import { idempotencyKeyForRelationshipEvent } from '../src/kernel/policies/relationship-validator.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const OWNER_ID = 'char_sumuwei' as EntityId
const CHARACTER_ID = OWNER_ID as never // CharacterId 与 EntityId 同为品牌字符串；夹具内直转
const CONTEXT: ProcessorContext = { processorName: 'wp3-verify', processorVersion: 'wp3-verify@1' }

/** UTC+8 自然日：2026-09-25（t=0）与 2026-09-26（t=+16h） */
const DAY1_MS = Date.UTC(2026, 8, 25, 2, 0, 0) // UTC 02:00 = UTC+8 10:00 → 2026-09-25
const DAY2_MS = Date.UTC(2026, 8, 26, 2, 0, 0) // → 2026-09-26

let eventCounter = 0

function userReading(userId: string, axisB = true): TrustedOriginReading {
  return {
    attributionOrigin: 'RECORDED',
    contentOriginator: attributionKnown({ kind: 'USER', id: userId }),
    axisBConfirmed: axisB,
  }
}

function userMessage(content: string, createdAt: number, userId = 'user-1'): ProcessorEventView {
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

function input(
  views: readonly ProcessorEventView[],
  overrides: Partial<Pick<RelationshipEvaluationInput, 'activeAccusations' | 'milestones'>> = {},
): RelationshipEvaluationInput {
  return {
    characterId: CHARACTER_ID,
    owner: entityRef('character', OWNER_ID),
    views,
    activeAccusations: {},
    milestones: {},
    ...overrides,
  }
}

const evaluator = new RuleBasedRelationshipEvaluator()

async function evaluate(
  evaluationInput: RelationshipEvaluationInput,
): Promise<DomainProposal<RelationshipProposalAudit>[]> {
  return evaluator.process(evaluationInput, CONTEXT)
}

function impactPayloadOf(proposal: DomainProposal<RelationshipProposalAudit>): RelationshipImpactPayload {
  return proposal.targetEvents[0].payload as RelationshipImpactPayload
}

function proposalsByRule(
  proposals: readonly DomainProposal<RelationshipProposalAudit>[],
  ruleId: string,
): DomainProposal<RelationshipProposalAudit>[] {
  return proposals.filter((p) => p.payload.ruleId === ruleId)
}

// ---------------------------------------------------------------------------
// 检查条目
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

// ---------------------------------------------------------------------------
// 正控
// ---------------------------------------------------------------------------

async function positiveControls(): Promise<void> {
  // P1：12 条合格消息跨 2 日，其中一条含谢谢你 → r2 ×1 + r1 ×2（按日单元）
  const p1Views = [
    userMessage('早上好呀', DAY1_MS),
    userMessage('今天有点忙，晚点聊', DAY1_MS),
    userMessage('谢谢你昨晚陪我聊到那么晚', DAY1_MS),
    userMessage('中午吃了吗', DAY1_MS),
    userMessage('下午开了三个会，累死了', DAY1_MS),
    userMessage('晚上一起打游戏？', DAY1_MS),
    userMessage('早', DAY2_MS),
    userMessage('昨天睡得不错', DAY2_MS),
    userMessage('今天天气真好', DAY2_MS),
    userMessage('中午吃了面', DAY2_MS),
    userMessage('下午继续忙', DAY2_MS),
    userMessage('晚安，明天见', DAY2_MS),
  ]
  const p1 = await evaluate(input(p1Views))
  const p1R2 = proposalsByRule(p1, 'r2')
  const p1R1 = proposalsByRule(p1, 'r1')
  const p1R2Payload = p1R2.length === 1 ? impactPayloadOf(p1R2[0]) : undefined
  record(
    'P1',
    '陪伴+感谢窗口：r2 一条（+0.02/+0.02）· r1 按日两条（{0,+0.02}）',
    'r2×1 + r1×2，delta 与冻结规则一致',
    `r2×${String(p1R2.length)} + r1×${String(p1R1.length)}${p1R2Payload !== undefined ? ` · r2Δ=(${String(p1R2Payload.delta.trust)},${String(p1R2Payload.delta.closeness)})` : ''}`,
    p1R2.length === 1 &&
      p1R1.length === 2 &&
      p1R2Payload !== undefined &&
      p1R2Payload.delta.trust === 0.02 &&
      p1R2Payload.delta.closeness === 0.02 &&
      p1R1.every((p) => {
        const delta = impactPayloadOf(p).delta
        return delta.trust === 0 && delta.closeness === 0.02
      }),
  )
  const p1R1Units = p1R1.map((p) => p.payload.unit).sort()
  record(
    'P1b',
    'r1 的幂等单元是自然日 ISO（2026-09-25 / 2026-09-26，UTC+8）',
    '2026-09-25 · 2026-09-26',
    p1R1Units.join(' · '),
    p1R1Units.length === 2 && p1R1Units[0] === '2026-09-25' && p1R1Units[1] === '2026-09-26',
  )
  const p1R2Sources = p1R2.length === 1 ? p1R2[0].sourceConversationEventIds : []
  record(
    'P1c',
    'r2 提案引用的来源 = 命中消息（证据绑定），payload 形状完整（key/originKind/ruleId）',
    '来源非空 · key={owner,target} · INTERACTION_DERIVED',
    `来源${String(p1R2Sources.length)}条${p1R2Payload !== undefined ? ` · key.target=${String(p1R2Payload.key.target)} · ${p1R2Payload.originKind}` : ''}`,
    p1R2Sources.length === 1 &&
      p1R2Payload !== undefined &&
      String(p1R2Payload.key.owner) === 'char_sumuwei' &&
      String(p1R2Payload.key.target) === 'user-1' &&
      p1R2Payload.originKind === 'INTERACTION_DERIVED',
  )

  // P2：指控窗口 → r3 一条；r1 停计；无 r2
  const p2Views = [
    userMessage('你骗我，你明明说过今天陪我的', DAY1_MS),
    ...Array.from({ length: 11 }, (_, i) => userMessage(`日常消息${String(i)}`, i < 6 ? DAY1_MS : DAY2_MS)),
  ]
  const p2 = await evaluate(input(p2Views))
  const p2R3 = proposalsByRule(p2, 'r3')
  const p2R3Payload = p2R3.length === 1 ? impactPayloadOf(p2R3[0]) : undefined
  record(
    'P2',
    '指控窗口：r3 一条（−0.05/−0.02，closeness 不清零）· r1 停计 · 无 r2',
    'r3×1 + r1×0 + r2×0',
    `r3×${String(p2R3.length)} + r1×${String(proposalsByRule(p2, 'r1').length)} + r2×${String(proposalsByRule(p2, 'r2').length)}${p2R3Payload !== undefined ? ` · Δ=(${String(p2R3Payload.delta.trust)},${String(p2R3Payload.delta.closeness)})` : ''}`,
    p2R3.length === 1 &&
      p2R3Payload !== undefined &&
      p2R3Payload.delta.trust === -0.05 &&
      p2R3Payload.delta.closeness === -0.02 &&
      proposalsByRule(p2, 'r1').length === 0 &&
      proposalsByRule(p2, 'r2').length === 0,
  )

  // P3：撤回形（r4b）+ 在案指控 → supersede + supersedes 链
  const p3 = await evaluate(
    input([userMessage('对不起，我错怪你了', DAY1_MS)], {
      activeAccusations: { 'user-1': ['de-acc-001', 'de-acc-002'] as DomainEventId[] },
    }),
  )
  const p3R4 = proposalsByRule(p3, 'r4')
  const p3Payload = p3R4.length === 1 ? impactPayloadOf(p3R4[0]) : undefined
  record(
    'P3',
    '撤回指控（r4b）+ 在案指控 → operation=supersede · supersedes 指向最新在案 · +0.03 部分恢复',
    'supersede · de-acc-002 · Δtrust=+0.03',
    p3Payload !== undefined
      ? `${String(p3R4[0].targetEvents[0].operation)} · ${String(p3Payload.supersedes?.domainEventId)} · Δtrust=${String(p3Payload.delta.trust)}`
      : `r4×${String(p3R4.length)}`,
    p3R4.length === 1 &&
      p3Payload !== undefined &&
      p3R4[0].targetEvents[0].operation === 'supersede' &&
      p3Payload.supersedes?.domainEventId === 'de-acc-002' &&
      p3Payload.delta.trust === 0.03,
  )

  // P4：修复形（r4a）+ 在案指控 → update（无 supersedes）
  const p4 = await evaluate(
    input([userMessage('没关系，我原谅你了', DAY1_MS)], {
      activeAccusations: { 'user-1': ['de-acc-001'] as DomainEventId[] },
    }),
  )
  const p4R4 = proposalsByRule(p4, 'r4')
  const p4Payload = p4R4.length === 1 ? impactPayloadOf(p4R4[0]) : undefined
  record(
    'P4',
    '纯修复（r4a）+ 在案指控 → operation=update · 无 supersedes · +0.03',
    'update · 无 supersedes',
    p4Payload !== undefined
      ? `${String(p4R4[0].targetEvents[0].operation)} · supersedes=${p4Payload.supersedes === undefined ? '无' : '有'}`
      : `r4×${String(p4R4.length)}`,
    p4R4.length === 1 &&
      p4Payload !== undefined &&
      p4R4[0].targetEvents[0].operation === 'update' &&
      p4Payload.supersedes === undefined,
  )

  // P5：R-5 消息里程碑跨过（prior 95 → after 105）→ r5-messages 一条
  const p5Views = Array.from({ length: 10 }, (_, i) => userMessage(`消息${String(i)}`, i < 5 ? DAY1_MS : DAY2_MS))
  const p5 = await evaluate(
    input(p5Views, {
      milestones: { 'user-1': { qualifiedMessageTotal: { prior: 95, after: 105 }, activeDayTotal: { prior: 10, after: 12 } } },
    }),
  )
  const p5R5 = proposalsByRule(p5, 'r5-messages')
  record(
    'P5',
    'R-5 消息里程碑跨过（95→105）→ r5-messages 一条（unit=messages-100，+0.03 closeness）',
    'r5-messages×1 · unit=messages-100',
    p5R5.length === 1
      ? `r5-messages×1 · unit=${p5R5[0].payload.unit} · Δcloseness=${String(impactPayloadOf(p5R5[0]).delta.closeness)}`
      : `r5-messages×${String(p5R5.length)}`,
    p5R5.length === 1 &&
      p5R5[0].payload.unit === 'messages-100' &&
      impactPayloadOf(p5R5[0]).delta.closeness === 0.03,
  )

  // P6：多目标分组——两个用户的合格消息各自成提案
  const p6Views = [
    userMessage('谢谢你陪我', DAY1_MS, 'user-1'),
    userMessage('谢谢你听我说', DAY1_MS, 'user-2'),
  ]
  const p6 = await evaluate(input(p6Views))
  const p6Targets = proposalsByRule(p6, 'r2').map((p) => String(impactPayloadOf(p).key.target)).sort()
  record(
    'P6',
    '多用户各自成组：user-1 / user-2 的感谢分别产出 key.target 正确的提案',
    'targets = user-1 · user-2',
    `targets = ${p6Targets.join(' · ')}`,
    p6Targets.length === 2 && p6Targets[0] === 'user-1' && p6Targets[1] === 'user-2',
  )

  // P7：幂等键——同参同键；异日异键；r1 跨窗口同日**必然撞键**（日上限的机器保证）
  const keyBase = {
    characterId: CHARACTER_ID,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    operation: 'update' as const,
  }
  const r1KeyA = idempotencyKeyForRelationshipEvent({ ...keyBase, sourceFromSequence: 10, sourceToSequence: 20, ruleId: 'r1', unit: '2026-09-25' })
  const r1KeyB = idempotencyKeyForRelationshipEvent({ ...keyBase, sourceFromSequence: 300, sourceToSequence: 400, ruleId: 'r1', unit: '2026-09-25' })
  const r1KeyC = idempotencyKeyForRelationshipEvent({ ...keyBase, sourceFromSequence: 10, sourceToSequence: 20, ruleId: 'r1', unit: '2026-09-26' })
  const r2KeyA = idempotencyKeyForRelationshipEvent({ ...keyBase, sourceFromSequence: 10, sourceToSequence: 20, ruleId: 'r2', unit: 'window' })
  const r2KeyB = idempotencyKeyForRelationshipEvent({ ...keyBase, sourceFromSequence: 30, sourceToSequence: 40, ruleId: 'r2', unit: 'window' })
  record(
    'P7',
    '幂等键：r1 跨窗口同日撞键（日上限）· 异日异键 · r2 异窗口异键',
    'sameDay=same · diffDay=diff · diffRange=diff',
    `sameDay=${String(r1KeyA === r1KeyB)} · diffDay=${String(r1KeyA !== r1KeyC)} · diffRange=${String(r2KeyA !== r2KeyB)}`,
    r1KeyA === r1KeyB && r1KeyA !== r1KeyC && r2KeyA !== r2KeyB,
  )
}

// ---------------------------------------------------------------------------
// 负控
// ---------------------------------------------------------------------------

async function negativeControls(): Promise<void> {
  // N1：她的生成带感谢模式 → 0 提案（Tier 0）
  const n1 = await evaluate(input([assistantMessage('谢谢你陪我聊这么久', DAY1_MS)]))
  record(
    'N1',
    '负控：她的生成（assistant_message）即使含感谢模式 → 0 提案',
    '0 提案',
    `${String(n1.length)} 提案`,
    n1.length === 0,
  )

  // N2：用户消息但来源未确立（无受信读数）→ 0 提案
  const n2View = userMessage('谢谢你陪我', DAY1_MS)
  const n2 = await evaluate(input([{ ...n2View, trustedOrigin: undefined }]))
  record(
    'N2',
    '负控：用户消息但无受信读数（UNCONFIRMED_ORIGIN）→ 0 提案',
    '0 提案',
    `${String(n2.length)} 提案`,
    n2.length === 0,
  )

  // N3：Axis B 未确认 → 0 提案
  const n3View = userMessage('谢谢你陪我', DAY1_MS)
  const n3 = await evaluate(input([{ ...n3View, trustedOrigin: userReading('user-1', false) }]))
  record(
    'N3',
    '负控：Axis B 未确认（axisBConfirmed=false）→ 0 提案（失败关闭）',
    '0 提案',
    `${String(n3.length)} 提案`,
    n3.length === 0,
  )

  // N4：修复模式但无在案指控 → 不触发（冻结规则：无 R-3 在案不触发）
  const n4 = await evaluate(input([userMessage('没关系，我原谅你了', DAY1_MS)]))
  record(
    'N4',
    '负控：修复模式但无在案指控（也无窗口内指控）→ 0 提案',
    '0 提案',
    `${String(n4.length)} 提案`,
    n4.length === 0,
  )

  // N5：R-1 门槛——9 条（不足 10）→ 无 r1；12 条但单日 → 无 r1
  const n5aViews = Array.from({ length: 9 }, (_, i) => userMessage(`消息${String(i)}`, i < 5 ? DAY1_MS : DAY2_MS))
  const n5a = await evaluate(input(n5aViews))
  const n5bViews = Array.from({ length: 12 }, (_, i) => userMessage(`消息${String(i)}`, DAY1_MS))
  const n5b = await evaluate(input(n5bViews))
  record(
    'N5',
    '负控：9 条跨 2 日 → 无 r1；12 条但单日 → 无 r1（门槛是程序判据）',
    'r1×0 · r1×0',
    `9条→r1×${String(proposalsByRule(n5a, 'r1').length)} · 单日12条→r1×${String(proposalsByRule(n5b, 'r1').length)}`,
    proposalsByRule(n5a, 'r1').length === 0 && proposalsByRule(n5b, 'r1').length === 0,
  )

  // N6：里程碑未跨过（50→60）→ 无 r5
  const n6Views = Array.from({ length: 10 }, (_, i) => userMessage(`消息${String(i)}`, i < 5 ? DAY1_MS : DAY2_MS))
  const n6 = await evaluate(
    input(n6Views, {
      milestones: { 'user-1': { qualifiedMessageTotal: { prior: 50, after: 60 }, activeDayTotal: { prior: 5, after: 7 } } },
    }),
  )
  record(
    'N6',
    '负控：里程碑未跨过（50→60 / 5→7）→ 无 r5',
    'r5×0',
    `r5-messages×${String(proposalsByRule(n6, 'r5-messages').length)} · r5-days×${String(proposalsByRule(n6, 'r5-days').length)}`,
    proposalsByRule(n6, 'r5-messages').length === 0 && proposalsByRule(n6, 'r5-days').length === 0,
  )

  // N7：空窗口 → 0 提案（正常结论）
  const n7 = await evaluate(input([]))
  record(
    'N7',
    '负控：空窗口 → 0 提案（"这批不推动关系"是正常结论）',
    '0 提案',
    `${String(n7.length)} 提案`,
    n7.length === 0,
  )
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

async function recoveryControls(): Promise<void> {
  // R1：负控全部安静之后，正控窗口重新产出正确提案
  const views = [
    userMessage('谢谢你陪我', DAY1_MS),
    ...Array.from({ length: 11 }, (_, i) => userMessage(`日常${String(i)}`, i < 6 ? DAY1_MS : DAY2_MS)),
  ]
  const recovered = await evaluate(input(views))
  const r2 = proposalsByRule(recovered, 'r2')
  const r1 = proposalsByRule(recovered, 'r1')
  record(
    'R1',
    '恢复：负控之后，正控窗口重新产出 r2×1 + r1×2（检测器响过之后重新安静且灵敏）',
    'r2×1 + r1×2',
    `r2×${String(r2.length)} + r1×${String(r1.length)}`,
    r2.length === 1 && r1.length === 2,
  )

  // R2：确定性自证——同一输入两次评估，提案语义逐字一致（proposalId/createdAt 除外）
  const again = await evaluate(input(views))
  const strip = (p: DomainProposal<RelationshipProposalAudit>) => ({
    type: p.targetEvents[0].type,
    operation: p.targetEvents[0].operation,
    payload: p.targetEvents[0].payload,
    sources: p.sourceConversationEventIds,
    audit: p.payload,
  })
  const same = JSON.stringify(recovered.map(strip)) === JSON.stringify(again.map(strip))
  record(
    'R2',
    '恢复：同一输入两次评估，提案语义逐字一致（幂等性的部件级证明）',
    '逐字一致',
    same ? '逐字一致' : '不一致（缺陷！）',
    same,
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await positiveControls()
  await negativeControls()
  await recoveryControls()

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length

  const stagesValid = positive > 0 && negative > 0 && recovery > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp3-verify', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp3-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    evaluator: { name: RELATIONSHIP_EVALUATOR_NAME, version: RELATIONSHIP_EVALUATOR_VERSION },
    propositions: {
      tier1: '只有 ESTABLISHED 用户直接互动产生提案（她的生成/未确立/AxisB未确认 = 0）',
      rules: 'R-1 窗口判据+按日单元 · R-2/R-3 窗口聚合 · R-4 在案前置+supersede 链 · R-5 里程碑',
      noDirectWrite: '本门不打开任何数据库；提案不落库（放行归 WP4 Validator）',
      idempotency: 'r1 日上限跨窗口撞键；r2/r3/r4/r5 按证据批次',
    },
    stages: { positive, negative, recovery },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp3-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'component-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'M7 WP3 提案器部件门：Tier 1 证据 + 冻结规则行为 + 幂等键日上限',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

await main()
