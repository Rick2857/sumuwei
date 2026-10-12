/**
 * M7 WP7 —— **量具与负控集中门**（`pnpm m7:measurement:verify`）。
 *
 * ============================================================================
 *  这一门的灵魂是一句话：**检测器必须会响**（INV-M45-06 / AGENTS §6.7）
 * ============================================================================
 * M7 的各 WP 门（wp3/wp4/wp5/wp6/td06/td07）各自带正负控，但分散在六个
 * 脚本里，谁也没法一眼回答"**这些检测器是不是都会响**"。本门用**最小
 * 夹具**（全部内存对象，零数据库、零模型）驱动同一批检测器，只回答
 * "它们会不会响"——不重跑各 WP 的真实链路（那些门已跑过并落了证据）。
 *
 *  四个检测器 × 三段式（正控安静 → 注入必响 → 恢复重新安静）：
 * ```text
 *  A 关系放行口 validateRelationshipProposal
 *      合法 r2 提案 → 放行；注入：delta 超界 / 来源事件缺位 / 建档缺位 /
 *      幂等键已处理 → 具名拒绝码；恢复 → 重新放行
 *  B 证据资格 qualifiedEvidenceGroups + RuleBasedRelationshipEvaluator
 *      ESTABLISHED 用户消息（感谢词形）→ r2 提案；注入：assistant_message /
 *      无受信信封 / originator Unknown → 零提案；恢复 → 重新触发
 *  C 联合行为档位 renderRelationshipGuidance
 *      {0.85, 0.6} → 非常信任+很亲近；注入 {0.25, 0.7}（很亲近但不信）
 *      → 被辜负措辞；恢复 → 回到基线档
 *  D 证据契约 validateM7Manifest（m7:gates 的接受逻辑）
 *      合法清单 → 0 问题；注入：缺字段 / counts.total=0 / 摘要被改
 *      → 具名问题；恢复 → 0 问题
 * ```
 *
 *  ⚠️ 不在本门（各自已有专属门）：调度 hold/flush（wp6 门 G 段前的 P5/P7）·
 *  TD-06 语料判定核心（td06 门 D 段已自证）· 幂等键推导（wp4 门 P3）。
 *
 * 跑法：pnpm m7:measurement:verify
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  asCharacterId,
  asConversationEventId,
  asEntityId,
  createProposal,
  effectiveRelationship,
  entityRef,
  renderRelationshipGuidance,
  type DomainProposal,
  type ProcessorContext,
  type ProcessorEventView,
  type RelationshipState,
} from '../src/kernel/contracts/index.ts'
import { validateRelationshipProposal } from '../src/kernel/policies/relationship-validator.ts'
import {
  createFullDomainEventRegistry,
  RELATIONSHIP_IMPACT,
} from '../src/kernel/contracts/domain-event.ts'
import {
  RELATIONSHIP_IMPACT_PROPOSAL_TYPE,
  type RelationshipImpactPayload,
} from '../src/kernel/contracts/relationship.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
  RELATIONSHIP_RULES,
  RuleBasedRelationshipEvaluator,
} from '../src/kernel/app/relationship/evaluator.ts'
import { createM7RunId, openM7RunDir, validateM7Manifest, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

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
// 公共夹具
// ---------------------------------------------------------------------------

const CHARACTER = asCharacterId('m7-measurement-character')
const OWNER = asEntityId(String(CHARACTER))
const USER = 'm7-measurement-user'
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0)

function originatedState(overrides: Partial<RelationshipState>): RelationshipState {
  return {
    originated: true,
    trust: 0.85,
    closeness: 0.6,
    originKind: 'SETTING_BASELINE',
    lastInteractionAt: NOW,
    accusationsInCase: [],
    ...overrides,
  }
}

const BASE_STATE = originatedState({})

// ---------------------------------------------------------------------------
// 检测器 A：关系放行口（内存端口，零数据库）
// ---------------------------------------------------------------------------

interface ValidatorFixture {
  readonly eventsById: Map<
    string,
    {
      id: ReturnType<typeof asConversationEventId>
      type: string
      trustedOrigin?: ProcessorEventView['trustedOrigin']
    }
  >
  readonly processedKeys: Set<string>
  readonly state: RelationshipState | undefined
}

function validatorDepsOf(fixture: ValidatorFixture) {
  const registry = createFullDomainEventRegistry()
  return {
    registry,
    evidence: {
      findEvents: async (ids: readonly ReturnType<typeof asConversationEventId>[]) =>
        ids
          .map((id) => fixture.eventsById.get(String(id)))
          .filter((e): e is NonNullable<typeof e> => e !== undefined)
          .map((e) => ({
            id: e.id,
            characterId: CHARACTER,
            sequence: 1,
            type: e.type,
            ...(e.trustedOrigin !== undefined ? { trustedOrigin: e.trustedOrigin } : {}),
          })),
    },
    processed: { hasProcessed: async (key: string) => fixture.processedKeys.has(key) },
    relationships: {
      getRelationshipState: async () => fixture.state,
    },
    events: { getDomainEvent: async () => undefined },
  }
}

function r2Proposal(deltaTrust: number = RELATIONSHIP_RULES.r2.trustDelta): DomainProposal {
  const payload: RelationshipImpactPayload = {
    key: { owner: OWNER, target: USER as never },
    targetKind: 'user',
    delta: { trust: deltaTrust, closeness: RELATIONSHIP_RULES.r2.closenessDelta },
    ruleId: 'r2',
    unit: 'window',
    originKind: 'INTERACTION_DERIVED',
  }
  return createProposal({
    characterId: CHARACTER,
    proposalType: RELATIONSHIP_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [asConversationEventId('m7-measurement-evt-1')],
    payload: { targetUserId: USER },
    targetEvents: [{ type: RELATIONSHIP_IMPACT, operation: 'create', payload }],
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
  })
}

async function detectorA(): Promise<void> {
  const evidenceRow = {
    id: asConversationEventId('m7-measurement-evt-1'),
    type: 'user_message',
    trustedOrigin: ESTABLISHED_ORIGIN,
  }
  const legal: ValidatorFixture = {
    eventsById: new Map([[String(evidenceRow.id), evidenceRow]]),
    processedKeys: new Set(),
    state: BASE_STATE,
  }

  // A1 正控：合法 r2 提案 → 放行（检测器安静 = 它不是噪音源）
  const a1 = await validateRelationshipProposal(validatorDepsOf(legal), r2Proposal())
  record(
    'A1',
    '放行口正控：合法 r2 提案（证据在场且合格 · 建档在场 · delta 界内）⇒ 放行 1',
    'accepted=1',
    `accepted=${String(a1.acceptedEvents.length)} · rejected=${String(a1.rejected.length)}${a1.rejected.length > 0 ? ` · code=${String(a1.rejected[0]?.code)}` : ''}`,
    a1.acceptedEvents.length === 1 && a1.rejected.length === 0,
  )

  // A2 负控①：delta 超界（0.5 > |Δtrust|≤0.05）⇒ relationship_delta_out_of_bounds
  const a2 = await validateRelationshipProposal(validatorDepsOf(legal), r2Proposal(0.5))
  const a2code = a2.rejected[0]?.code
  record(
    'A2',
    '注入①：delta 超界（Δtrust=0.5）⇒ 具名拒绝 relationship_delta_out_of_bounds',
    'relationship_delta_out_of_bounds',
    a2code ?? '没有拒绝',
    a2.acceptedEvents.length === 0 && a2code === 'relationship_delta_out_of_bounds',
  )

  // A3 负控②：来源事件缺位 ⇒ source_event_missing（提案级：来源必须真实存在）
  const noEvidence: ValidatorFixture = {
    eventsById: new Map(),
    processedKeys: new Set(),
    state: BASE_STATE,
  }
  const a3 = await validateRelationshipProposal(validatorDepsOf(noEvidence), r2Proposal())
  const a3code = a3.rejected[0]?.code
  record(
    'A3',
    '注入②：来源事件缺位（查找口返回空）⇒ 具名拒绝 source_event_missing',
    'source_event_missing',
    a3code ?? '没有拒绝',
    a3.acceptedEvents.length === 0 && a3code === 'source_event_missing',
  )

  // A3b 负控③：建档缺位（无 ORIGIN 行）⇒ relationship_origin_missing（IMPACT 无基线可影响）
  const noOrigin: ValidatorFixture = {
    eventsById: legal.eventsById,
    processedKeys: new Set(),
    state: undefined,
  }
  const a3b = await validateRelationshipProposal(validatorDepsOf(noOrigin), r2Proposal())
  const a3bcode = a3b.rejected[0]?.code
  record(
    'A3b',
    '注入③：建档缺位（投影无 ORIGIN 行）⇒ 具名拒绝 relationship_origin_missing',
    'relationship_origin_missing',
    a3bcode ?? '没有拒绝',
    a3b.acceptedEvents.length === 0 && a3bcode === 'relationship_origin_missing',
  )

  // A4 负控④：幂等键已处理 ⇒ duplicate_operation
  const alreadyProcessed: ValidatorFixture = {
    eventsById: legal.eventsById,
    processedKeys: new Set(['placeholder']),
    state: BASE_STATE,
  }
  // 先放行一次拿真实键，再标记已处理
  const firstPass = await validateRelationshipProposal(validatorDepsOf(legal), r2Proposal())
  const realKey = firstPass.acceptedEvents[0]?.idempotencyKey
  alreadyProcessed.processedKeys.add(realKey ?? '')
  const a4 = await validateRelationshipProposal(validatorDepsOf(alreadyProcessed), r2Proposal())
  const a4code = a4.rejected[0]?.code
  record(
    'A4',
    '注入④：幂等键已处理（真实键命中）⇒ 具名拒绝 duplicate_operation',
    'duplicate_operation',
    a4code ?? '没有拒绝',
    a4.acceptedEvents.length === 0 && a4code === 'duplicate_operation',
  )

  // A5 恢复：放回合法夹具 ⇒ 重新放行
  const a5 = await validateRelationshipProposal(validatorDepsOf(legal), r2Proposal())
  record(
    'A5',
    '恢复：放回合法夹具（新键）⇒ 重新放行（注入没有改坏检测器）',
    'accepted=1',
    `accepted=${String(a5.acceptedEvents.length)}`,
    a5.acceptedEvents.length === 1,
  )
}

// ---------------------------------------------------------------------------
// 检测器 B：证据资格 + 规则评估器（内存视图，零数据库）
// ---------------------------------------------------------------------------

function userView(
  id: string,
  content: string,
  trustedOrigin: ProcessorEventView['trustedOrigin'],
): ProcessorEventView {
  return {
    id: asConversationEventId(id),
    sequence: 1,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: USER,
    content,
    createdAt: NOW,
    ...(trustedOrigin !== undefined ? { trustedOrigin } : {}),
  }
}

const ESTABLISHED_ORIGIN = {
  attributionOrigin: 'RECORDED',
  contentOriginator: { state: 'KNOWN', value: { kind: 'USER', id: USER } },
  axisBConfirmed: true,
} as const

async function detectorB(): Promise<void> {
  const evaluator = new RuleBasedRelationshipEvaluator()
  const ctx: ProcessorContext = { processorName: 'm7-measurement', processorVersion: 'm7-measurement@1' }
  const baseInput = (views: readonly ProcessorEventView[]) => ({
    characterId: CHARACTER,
    owner: entityRef('character', String(CHARACTER)),
    views,
    activeAccusations: {},
    milestones: {},
  })
  const THANKS = '谢谢你昨晚陪我聊到那么晚'

  // B1 正控：ESTABLISHED 用户消息（感谢）⇒ r2 提案触发
  const b1 = await evaluator.process(
    baseInput([userView('m7-evt-b1', THANKS, ESTABLISHED_ORIGIN)]),
    ctx,
  )
  record(
    'B1',
    '资格正控：ESTABLISHED 用户消息（感谢词形）⇒ r2 提案触发',
    'proposals=1 · ruleId=r2',
    `proposals=${String(b1.length)}${b1.length > 0 ? ` · ruleId=${String((b1[0].payload as { ruleId?: string }).ruleId)}` : ''}`,
    b1.length === 1 && (b1[0].payload as { ruleId?: string }).ruleId === 'r2',
  )

  // B2 负控①：她的生成（assistant_message，同词形）⇒ 零提案
  const assistantView: ProcessorEventView = {
    ...userView('m7-evt-b2', THANKS, ESTABLISHED_ORIGIN),
    type: 'assistant_message',
    actorType: 'character',
  }
  const b2 = await evaluator.process(baseInput([assistantView]), ctx)
  record(
    'B2',
    '注入①：assistant_message（她的生成含感谢词形）⇒ 零提案（生成不驱动关系）',
    'proposals=0',
    `proposals=${String(b2.length)}`,
    b2.length === 0,
  )

  // B3 负控②：无受信信封（未确立来源）⇒ 零提案
  const b3 = await evaluator.process(
    baseInput([userView('m7-evt-b3', THANKS, undefined)]),
    ctx,
  )
  record(
    'B3',
    '注入②：无受信信封的 user_message（来源未确立）⇒ 零提案（失败关闭）',
    'proposals=0',
    `proposals=${String(b3.length)}`,
    b3.length === 0,
  )

  // B4 负控③：originator Unknown ⇒ 零提案
  const unknownOrigin = {
    attributionOrigin: 'RECORDED',
    contentOriginator: { state: 'UNKNOWN', reason: 'RUNTIME_UNRESOLVED' },
    axisBConfirmed: true,
  } as const
  const b4 = await evaluator.process(
    baseInput([userView('m7-evt-b4', THANKS, unknownOrigin)]),
    ctx,
  )
  record(
    'B4',
    '注入③：originator Unknown（信封在但人未解析）⇒ 零提案（不猜一个人）',
    'proposals=0',
    `proposals=${String(b4.length)}`,
    b4.length === 0,
  )

  // B5 恢复：放回 ESTABLISHED 视图 ⇒ 重新触发
  const b5 = await evaluator.process(
    baseInput([userView('m7-evt-b5', THANKS, ESTABLISHED_ORIGIN)]),
    ctx,
  )
  record(
    'B5',
    '恢复：放回 ESTABLISHED 视图 ⇒ r2 重新触发',
    'proposals=1 · ruleId=r2',
    `proposals=${String(b5.length)}`,
    b5.length === 1 && (b5[0].payload as { ruleId?: string }).ruleId === 'r2',
  )
}

// ---------------------------------------------------------------------------
// 检测器 C：联合行为档位（纯函数）
// ---------------------------------------------------------------------------

function detectorC(): void {
  const guidanceOf = (state: RelationshipState) =>
    renderRelationshipGuidance({
      effective: effectiveRelationship(state, NOW),
      now: NOW,
      projection: { revision: 1, updatedAt: NOW },
    })

  // C1 正控：基线 {0.85, 0.6} ⇒ 非常信任 + 很亲近
  const c1 = guidanceOf(BASE_STATE)
  record(
    'C1',
    '档位正控：{0.85, 0.6} ⇒ 非常信任 + 很亲近',
    '两段语义都在',
    c1 !== undefined && c1.includes('非常信任') && c1.includes('很亲近') ? '都在' : `缺：${(c1 ?? '').slice(0, 60)}`,
    c1 !== undefined && c1.includes('非常信任') && c1.includes('很亲近'),
  )

  // C2 负控：{0.25, 0.7}（很亲近但不信）⇒ 被辜负措辞（两维不合并）
  const c2 = guidanceOf(originatedState({ trust: 0.25, closeness: 0.7 }))
  record(
    'C2',
    '注入：{0.25, 0.7}（很亲近但不信）⇒ 被辜负措辞（trust 与 closeness 不混谈）',
    '含 被辜负',
    c2 !== undefined && c2.includes('被辜负') ? '被辜负在场' : `缺：${(c2 ?? '').slice(0, 60)}`,
    c2 !== undefined && c2.includes('被辜负'),
  )

  // C3 恢复：放回基线 ⇒ 回到基线档
  const c3 = guidanceOf(BASE_STATE)
  record(
    'C3',
    '恢复：放回 {0.85, 0.6} ⇒ 回到非常信任 + 很亲近',
    '两段语义都在',
    c3 !== undefined && c3.includes('非常信任') && c3.includes('很亲近') ? '都在' : '缺',
    c3 !== undefined && c3.includes('非常信任') && c3.includes('很亲近'),
  )
}

// ---------------------------------------------------------------------------
// 检测器 D：证据契约（m7:gates 的接受逻辑）
// ---------------------------------------------------------------------------

function detectorD(): void {
  const legalManifest = {
    schemaVersion: 'm7-manifest@1',
    runId: 'm7-measurement-20260926-000000000000-0000',
    wp: 'measurement',
    head: '0'.repeat(40),
    headShort: '0'.repeat(12),
    branch: 'feature/m7-relationship',
    date: '2026-09-26',
    toolVersions: { node: process.version },
    testType: 'measurement-verify',
    counts: { total: 1, passed: 1, failed: 0 },
    phases: ['single'],
    supersedes: null,
    payloadSha256: '',
  }

  // D1 正控：合法清单 ⇒ 0 问题（除摘要——sealManifest 才算；这里只测字段面）
  const d1 = validateM7Manifest({ ...legalManifest, payloadSha256: undefined })
  const d1problems = d1.filter((p) => p.field !== 'payloadSha256')
  record(
    'D1',
    '契约正控：全字段清单 ⇒ 0 问题（字段面）',
    '0 问题',
    `${String(d1problems.length)} 问题${d1problems.length > 0 ? `：${d1problems.map((p) => p.field).join(',')}` : ''}`,
    d1problems.length === 0,
  )

  // D2 负控①：缺必填字段 ⇒ 具名问题
  const d2 = validateM7Manifest({ ...legalManifest, payloadSha256: undefined, supersedes: undefined })
  const d2fields = d2.map((p) => p.field)
  record(
    'D2',
    '注入①：删掉 supersedes 字段 ⇒ 具名问题（缺字段不静默）',
    '点名 supersedes',
    d2fields.join(',') || '没有问题',
    d2fields.includes('supersedes'),
  )

  // D3 负控②：counts.total = 0 ⇒ MEASUREMENT INVALID 语义的机器面
  const d3 = validateM7Manifest({
    ...legalManifest,
    payloadSha256: undefined,
    counts: { total: 0, passed: 0, failed: 0 },
  })
  const d3fields = d3.map((p) => p.field)
  record(
    'D3',
    '注入②：counts.total=0（0 检查 0 失败 ≠ 合格）⇒ 具名问题',
    '点名 counts.total',
    d3fields.join(',') || '没有问题',
    d3fields.includes('counts.total'),
  )

  // D4 负控③：摘要被改 ⇒ 具名问题
  const d4 = validateM7Manifest({ ...legalManifest, payloadSha256: 'deadbeef'.repeat(8) })
  const d4fields = d4.map((p) => p.field)
  record(
    'D4',
    '注入③：payloadSha256 与内容不符（清单被事后改过）⇒ 具名问题',
    '点名 payloadSha256',
    d4fields.join(',') || '没有问题',
    d4fields.includes('payloadSha256'),
  )

  // D5 恢复：放回合法清单 ⇒ 0 问题
  const d5 = validateM7Manifest({ ...legalManifest, payloadSha256: undefined })
  const d5problems = d5.filter((p) => p.field !== 'payloadSha256')
  record(
    'D5',
    '恢复：放回全字段清单 ⇒ 0 问题',
    '0 问题',
    `${String(d5problems.length)} 问题`,
    d5problems.length === 0,
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await detectorA()
  await detectorB()
  detectorC()
  detectorD()

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const detectors = 4
  const stagesValid = checks.length >= detectors * 3 && passed > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'measurement', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-measurement-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    detectors: {
      validator: 'validateRelationshipProposal（内存端口）',
      qualification: 'qualifiedEvidenceGroups + RuleBasedRelationshipEvaluator（内存视图）',
      guidance: 'renderRelationshipGuidance + effectiveRelationship（纯函数）',
      manifest: 'validateM7Manifest（m7-manifest@1 契约）',
    },
    notCovered: [
      '调度 hold/flush（wp6 门 P5/P7 已覆盖）',
      'TD-06 语料判定核心（td06 门 D 段已自证）',
      '幂等键推导（wp4 门 P3 已覆盖）',
    ],
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'measurement',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'measurement-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: '四个检测器 × 三段式（正控安静/注入必响/恢复安静）；最小夹具零数据库零模型',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

await main()
