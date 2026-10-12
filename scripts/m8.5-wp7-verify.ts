/**
 * M8.5 WP7 门 —— **放行口语义策略分支 + worker commit 端口生产实现**
 * （`pnpm m8.5:wp7:verify`）。
 *
 * ============================================================================
 *  要证明的命题（计划 §7.3 / §15 WP7）
 * ============================================================================
 * ① 放行口按策略版本分叉：旧词形路径**保留旧校验含义**（范围界——
 *    "在 ±0.25 内但非精确值"在 rules@1 下仍被接受，M8 语义不被悄悄收紧）；
 *    语义策略 `affect-semantic-policy@1` 追加独立 allowlist。
 * ② 语义分支的**精确增量**判据：delta 与该族冻结表逐字段相等；
 *    范围内的漂移值（+0.09）必须以 `affect_delta_not_exact` 拒绝——
 *    不许被范围界放行或冒充 `affect_delta_out_of_bounds`。
 * ③ 时间形状双向失败关闭：语义策略缺 SOURCE_ANCHORED/有限 sourceAt ⇒ 拒；
 *    词形策略携带语义字段 ⇒ 拒（防"语义负载走私词形版本"）。
 * ④ worker commit 端口生产实现：提案 → **真放行口**（不绕过）→
 *    事件 + 终结闸同事务；放行口拒绝 ⇒ 零事件 + 闸行照落（TERMINAL_FAILED
 *    回执）+ 拒码闭集回传——source 永不悬空。
 * ⑤ 重放安全：同输入重放 ⇒ duplicate_operation + 零事件 + 闸行不被改写
 *    （无双重 IMPACT）。
 *
 * 不主张（归 WP8+）：模式开关消费、main.ts 接线、trace 步、shadow 采集。
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-wp7-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  conversationEventsInRange,
  latestConversationSequence,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { getAffectProjection } from '../src/infrastructure/persistence/affect-store.ts'
import {
  applyAcceptedEvents,
  domainEventsFor,
  getProjection,
} from '../src/infrastructure/persistence/event-store.ts'
import {
  hasProcessedOperation,
  listProcessedOperations,
} from '../src/infrastructure/persistence/job-store.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import { validateAffectProposal } from '../src/kernel/policies/affect-validator.ts'
import {
  createAffectSemanticCommitPort,
} from '../src/kernel/app/affect/semantic-commit.ts'
import type { AffectSemanticCommitInput } from '../src/kernel/app/affect/semantic-worker.ts'
import { processorEventViewOf } from '../src/kernel/app/memory/extractor.ts'
import {
  AFFECT_ORIGIN,
  AFFECT_IMPACT,
  createFullDomainEventRegistry,
  createProposal,
  AFFECT_IMPACT_PROPOSAL_TYPE,
  DOMAIN_EVENT_SCOPE,
  computeIdempotencyKey,
  type AffectState,
  type CharacterId,
} from '../src/kernel/contracts/index.ts'
import {
  AFFECT_RULES_VERSION,
  AFFECT_RULE_DELTAS,
  AFFECT_REJECTION_CODE_SET,
} from '../src/kernel/contracts/affect.ts'
import {
  AFFECT_SEMANTIC_EVALUATOR_NAME,
  AFFECT_SEMANTIC_EVALUATOR_VERSION,
  AFFECT_SEMANTIC_POLICY_VERSION,
  affectSemanticFinalizedGateKey,
  encodeAffectSemanticCommittedReceipt,
  encodeAffectSemanticTerminalReceipt,
  type AffectSemanticImpactPayload,
} from '../src/kernel/contracts/affect-semantic.ts'
import { affectReducerV2For } from '../src/kernel/projections/affect.ts'
import { asConversationEventId, asConversationId } from '../src/kernel/contracts/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 量具（与 WP4–WP6 门同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
const phaseCounts: Record<string, number> = { static: 0, positive: 0, negative: 0, recovery: 0 }

function check(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ id, label, expected, actual, pass })
  phaseCounts[phase] += 1
  if (!pass) console.error(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
}
function checkEqual(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  check(phase, id, label, JSON.stringify(expected), JSON.stringify(actual),
    JSON.stringify(expected) === JSON.stringify(actual))
}
function checkTrue(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  value: boolean,
): void {
  check(phase, id, label, 'true', String(value), value === true)
}

// ---------------------------------------------------------------------------
// ① 静态段：登记面与实现面的源码级断言
// ---------------------------------------------------------------------------

const contractsSource = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/affect.ts'), 'utf8')
checkTrue('static', 'S1a', '新拒码 affect_delta_not_exact 已登记（可审计闭集）',
  AFFECT_REJECTION_CODE_SET.has('affect_delta_not_exact'))
checkTrue('static', 'S1b', '新拒码 affect_timing_shape_invalid 已登记',
  AFFECT_REJECTION_CODE_SET.has('affect_timing_shape_invalid'))
checkTrue('static', 'S1c', '冻结增量表上移 contracts（单一实现，双策略共用）',
  contractsSource.includes('export const AFFECT_RULE_DELTAS'))
const patternsSource = readFileSync(join(REPO_ROOT, 'src/kernel/app/affect/patterns.ts'), 'utf8')
checkTrue('static', 'S1d', 'patterns.ts 以 re-export 保持既有导入面（零漂移）',
  patternsSource.includes("export { AFFECT_RULE_DELTAS } from '../../contracts/affect.ts'"))
const validatorSource = readFileSync(join(REPO_ROOT, 'src/kernel/policies/affect-validator.ts'), 'utf8')
checkTrue('static', 'S2a', '放行口含语义策略分支（精确增量判据在唯一放行口）',
  validatorSource.includes('affect_delta_not_exact'))
checkTrue('static', 'S2b', '放行口含时间形状双向失败关闭',
  validatorSource.includes('affect_timing_shape_invalid') &&
  validatorSource.includes('AFFECT_SEMANTIC_POLICY_VERSION'))
checkTrue('static', 'S2c', '旧词形分支保留范围界（M8 语义原样）',
  validatorSource.includes('affectDeltaWithinBounds(impactPayload.delta)'))
const commitSource = readFileSync(join(REPO_ROOT, 'src/kernel/app/affect/semantic-commit.ts'), 'utf8')
checkTrue('static', 'S3a', 'commit 端口走唯一放行口（不绕过）',
  commitSource.includes('validateAffectProposal'))
checkTrue('static', 'S3b', 'commit 端口拒绝时闸行照落（fallbackReceipt——source 不悬空）',
  commitSource.includes('input.fallbackReceipt'))

// ---------------------------------------------------------------------------
// ② 隔离库引导（真实库不打开；按 WP6 门既有范式）
// ---------------------------------------------------------------------------

const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
await initDatabase(runtime, sqlPlugin)
await runtime.initialize()
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
})
const characterId = kernel.characterId
const db = kernel.stores.db
const T0 = 1_700_000_000_000

// 建档（@2 reducer 注册链——WP6 P3 已证；此处只为给 TOUCH/IMPACT 一个起点）
const originAccepted: AcceptedDomainEvent = {
  type: AFFECT_ORIGIN,
  operation: 'affect-origin:m85-wp7-gate',
  payload: {
    characterId,
    initialValence: 0,
    initialArousal: 0.5,
    originKind: 'ACTIVATION_BASELINE',
    activationId: 'm85-wp7-gate',
    cutoverAt: T0,
    cutoverSequence: 0,
    policyVersion: 'affect-policy@1',
  },
  sourceConversationEventIds: [asConversationEventId('cev-m85-wp7-origin')],
  idempotencyKey: 'affect-origin:m85-wp7-gate',
  processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
  processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
  scope: 'CHARACTER_INTERNAL',
}
const v2Reducer = affectReducerV2For(characterId)
await applyAcceptedEvents(db, characterId, [originAccepted], [v2Reducer], T0)

// 合格用户事件（真 ingress 归因——ESTABLISHED + active user）
const USER = 'm85-wp7-user'
const CONV = asConversationId('m85-wp7-conv')
const recorder = new ConversationRecorder({
  db,
  characterId,
  conversationId: CONV,
  dryRun: false,
  userName: USER,
  characterName: character.name,
  transport: 'm8.5-wp7-verify',
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
  userId: USER,
  userRef: USER,
})
const recUser = await recorder.recordUserMessage(
  '这回要是没有你，我真不知道怎么收场。',
  (await latestConversationSequence(db, characterId, CONV)) + 1,
)
const recAssistant = await recorder.recordAssistantMessage({
  text: '能帮上就好。',
  conversationSequence: (await latestConversationSequence(db, characterId, CONV)) + 1,
  characterSequence: recUser.assistantSequence!,
  replyToEventId: recUser.event!.id,
})
const sourceEvent = recUser.event!
const assistantEvent = recAssistant!

// ---------------------------------------------------------------------------
// ③ commit 端口生产装配（真函数注入；WP8 进 main.ts 时同一形状）
// ---------------------------------------------------------------------------

const registry = createFullDomainEventRegistry()
const commit = createAffectSemanticCommitPort({
  characterId,
  activeUserId: USER,
  registry,
  evidence: {
    findEvents: async (ids) => {
      const wanted = new Set(ids.map((id) => String(id)))
      const events = await conversationEventsInRange(db, characterId, 1, 1_000_000, 2000)
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
  },
  processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
  affect: {
    getAffectState: async (cid: CharacterId) => (await getAffectProjection(db, cid))?.state,
  },
  apply: async (accepted, extras, now) => {
    const applied = await applyAcceptedEvents(
      db, characterId, accepted, [affectReducerV2For(characterId)], now,
      { extraProcessedOperations: extras },
    )
    return {
      createdCount: applied.createdCount,
      deduplicatedCount: applied.deduplicatedCount,
      extraRecordedCount: applied.extraRecordedCount,
    }
  },
})

const baseInput = (): AffectSemanticCommitInput => ({
  source: {
    sourceEventId: sourceEvent.id,
    sourceSequence: sourceEvent.sequence,
    conversationId: String(sourceEvent.conversationId),
    sourceAt: Number(sourceEvent.createdAt),
    content: sourceEvent.content,
  },
  impact: {
    family: 'A-GRATITUDE',
    delta: { ...AFFECT_RULE_DELTAS['A-GRATITUDE'] },
    sourceAt: Number(sourceEvent.createdAt),
  },
  receipt: encodeAffectSemanticCommittedReceipt(
    'A-GRATITUDE',
    '0123456789abcdef' as never,
  ),
  fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
  now: Date.now(),
})

// ---------------------------------------------------------------------------
// ④ 正控：真放行口接受语义 IMPACT；事件 + 闸行同事务
// ---------------------------------------------------------------------------

const stateBefore = (await getAffectProjection(db, characterId))?.state
const eventsBefore = (await domainEventsFor(db, characterId)).length
const p1 = await commit(baseInput())
checkEqual('positive', 'P1a', '放行口接受语义 IMPACT（精确增量 + SOURCE_ANCHORED）',
  'committed', p1.kind)
if (p1.kind === 'committed') {
  checkEqual('positive', 'P1b', '事件创建恰一条', 1, p1.createdCount)
  checkEqual('positive', 'P1c', '终结闸行同事务落库', 1, p1.extraRecordedCount)
}
const semanticEvents = (await domainEventsFor(db, characterId)).filter(
  (e) => e.type === AFFECT_IMPACT &&
    (e.payload as AffectSemanticImpactPayload).timingKind === 'SOURCE_ANCHORED',
)
checkEqual('positive', 'P1d', '语义 IMPACT 事件恰一条（SOURCE_ANCHORED）', 1, semanticEvents.length)
const semanticEvent = semanticEvents[0]
checkEqual('positive', 'P1e', '事件携带语义策略版本（独立于 affect-rules@1）',
  AFFECT_SEMANTIC_POLICY_VERSION,
  (semanticEvent?.payload as AffectSemanticImpactPayload | undefined)?.ruleVersion)
checkEqual('positive', 'P1f', '来源类别 = INTERACTION_DERIVED（与 M8 词形 IMPACT 同一来源事实）',
  'INTERACTION_DERIVED',
  (semanticEvent?.payload as AffectSemanticImpactPayload | undefined)?.originKind)
checkEqual('positive', 'P1g', '幂等键 = 冻结推导（processor=语义评估器 + 语义领域串）',
  computeIdempotencyKey({
    characterId,
    processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
    processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
    sourceFromSequence: 0,
    sourceToSequence: 0,
    operation: `affect-semantic-impact:A-GRATITUDE:${String(sourceEvent.id)}`,
  }),
  semanticEvent?.idempotencyKey)
const gateRow = (await listProcessedOperations(db, characterId, 500))
  .find((r) => r.idempotencyKey === affectSemanticFinalizedGateKey(sourceEvent.id))
checkTrue('positive', 'P1h', '闸行 = COMMITTED 紧凑回执（族 + 16hex 指纹）',
  /^affect-semantic@1\|COMMITTED\|A-GRATITUDE\|fp=[0-9a-f]{16}$/.test(gateRow?.operation ?? ''))
const stateAfter = (await getAffectProjection(db, characterId))?.state
checkTrue('positive', 'P1i', '投影 valence 收到精确增量（>0.07）',
  (stateAfter?.valence ?? -1) > 0.07)
checkEqual('positive', 'P1j', 'lastInteractionAt 不被语义 IMPACT 推进（M85-D19）',
  stateBefore?.lastInteractionAt ?? -1, stateAfter?.lastInteractionAt ?? -2)

// 无 IMPACT 输入 → no_impact 闸行（复用既有机制，端口面完整）
const p2 = await commit({
  source: baseInput().source,
  receipt: 'affect-semantic@1|NO_IMPACT|NEUTRAL|fp=0123456789abcdef',
  fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
  now: Date.now(),
})
checkEqual('positive', 'P2a', '无 IMPACT 输入 → no_impact', 'no_impact', p2.kind)
checkEqual('positive', 'P2b', 'no_impact 零事件（总数不变）',
  eventsBefore + 1, (await domainEventsFor(db, characterId)).length)

// ---------------------------------------------------------------------------
// ⑤ 负控：放行口语义分支逐码拒绝（直接调 validateAffectProposal——判据归属）
// ---------------------------------------------------------------------------

/** 造一个单目标语义 IMPACT 提案（可篡改任意字段；'OMIT' = 该字段缺席） */
function semanticProposal(overrides: {
  delta?: { deltaValence: number; deltaArousal: number }
  ruleVersion?: string
  ruleId?: string
  timingKind?: 'SOURCE_ANCHORED' | 'OMIT'
  sourceAt?: number | 'OMIT'
  sourceEventId?: typeof sourceEvent.id
}): ReturnType<typeof createProposal> {
  // 负控夹具**有意**产出违反契约形状的负载（缺 timingKind / 缺 sourceAt）——
  // 那正是要测的拒绝路径；因此这里用 as 收窄，而不是让 TS 替我们"补齐"。
  const payload = {
    characterId,
    sourceEventId: overrides.sourceEventId ?? sourceEvent.id,
    sourceSequence: sourceEvent.sequence,
    ruleId: overrides.ruleId ?? 'A-GRATITUDE',
    ruleVersion: overrides.ruleVersion ?? AFFECT_SEMANTIC_POLICY_VERSION,
    delta: overrides.delta ?? { ...AFFECT_RULE_DELTAS['A-GRATITUDE'] },
    originKind: 'INTERACTION_DERIVED',
    evaluatorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
    proposalId: '',
    ...(overrides.timingKind === 'OMIT' ? {} : { timingKind: 'SOURCE_ANCHORED' as const }),
    ...(overrides.sourceAt === 'OMIT'
      ? {}
      : { sourceAt: overrides.sourceAt ?? Number(sourceEvent.createdAt) }),
  } as AffectSemanticImpactPayload
  const proposal = createProposal({
    characterId,
    proposalType: AFFECT_IMPACT_PROPOSAL_TYPE,
    sourceConversationEventIds: [payload.sourceEventId],
    payload: { kind: 'semantic-impact', sourceEventId: payload.sourceEventId },
    targetEvents: [{ type: AFFECT_IMPACT, operation: 'update', payload, scope: DOMAIN_EVENT_SCOPE }],
    processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
    processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
  })
  ;(payload as { proposalId: string }).proposalId = proposal.proposalId
  return proposal
}

const validatorDeps = {
  registry,
  evidence: {
    findEvents: async (ids: readonly (typeof sourceEvent.id)[]) => {
      const wanted = new Set(ids.map((id) => String(id)))
      const events = await conversationEventsInRange(db, characterId, 1, 1_000_000, 2000)
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
  },
  processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
  affect: {
    getAffectState: async (cid: CharacterId) => (await getAffectProjection(db, cid))?.state,
  },
  policy: { activeUserId: USER },
}

const codesOf = async (proposal: ReturnType<typeof createProposal>): Promise<string[]> => {
  const outcome = await validateAffectProposal(validatorDeps, proposal as never)
  return outcome.rejected.map((r) => r.code)
}

// N1：范围内漂移（+0.09 在 ±0.25 内）必须以精确判据拒绝——不许范围界放行
const n1 = await codesOf(semanticProposal({
  delta: { deltaValence: 0.09, deltaArousal: -0.03 },
}))
checkTrue('negative', 'N1', '范围内漂移 ⇒ affect_delta_not_exact（不是范围界）',
  n1.includes('affect_delta_not_exact') && !n1.includes('affect_delta_out_of_bounds'))

// N2：语义策略缺 timingKind ⇒ 时间形状拒绝
const n2 = await codesOf(semanticProposal({ timingKind: 'OMIT' }))
checkTrue('negative', 'N2', '语义策略缺 SOURCE_ANCHORED ⇒ affect_timing_shape_invalid',
  n2.includes('affect_timing_shape_invalid'))

// N3：sourceAt 非有限 ⇒ 时间形状拒绝
const n3 = await codesOf(semanticProposal({ sourceAt: Number.NaN }))
checkTrue('negative', 'N3', 'sourceAt=NaN ⇒ affect_timing_shape_invalid',
  n3.includes('affect_timing_shape_invalid'))

// N4：词形版本走私语义负载 ⇒ 失败关闭（旧路径不放松也不收编语义形状）
const n4 = await codesOf(semanticProposal({
  ruleVersion: AFFECT_RULES_VERSION,
  delta: { deltaValence: 0.08, deltaArousal: -0.03 },
}))
checkTrue('negative', 'N4', 'rules@1 携带语义时间字段 ⇒ affect_timing_shape_invalid',
  n4.includes('affect_timing_shape_invalid'))

// N5：未知策略版本 ⇒ 版本不匹配
const n5 = await codesOf(semanticProposal({ ruleVersion: 'affect-semantic-policy@9' }))
checkTrue('negative', 'N5', '未知策略版本 ⇒ affect_rule_version_mismatch',
  n5.includes('affect_rule_version_mismatch'))

// N6：未知族 ⇒ 规则未知（七族闭集对两个策略共同生效）
const n6 = await codesOf(semanticProposal({ ruleId: 'A-MADE-UP' }))
checkTrue('negative', 'N6', '未知族 ⇒ affect_rule_unknown', n6.includes('affect_rule_unknown'))

// N7：不合格 source（助手事件）⇒ 资格拒绝（真放行口的资格三层在语义路径同样生效）
const n7 = await codesOf(semanticProposal({ sourceEventId: assistantEvent.id }))
checkTrue('negative', 'N7', '助手事件作 source ⇒ 资格拒绝（affect_source_unqualified）',
  n7.includes('affect_source_unqualified'))

// N8：worker 集成负控——映射漂移经 commit 端口 ⇒ 拒绝 + 闸行照落（source 不悬空）
//（用独立 source：P1 的 source 闸行已被 COMMITTED 占住，fallback 落不上）
const recN8 = await recorder.recordUserMessage(
  '第二条独立消息，用于映射漂移负控。',
  (await latestConversationSequence(db, characterId, CONV)) + 1,
)
const n8Source = recN8.event!
const n8 = await commit({
  source: {
    sourceEventId: n8Source.id,
    sourceSequence: n8Source.sequence,
    conversationId: String(n8Source.conversationId),
    sourceAt: Number(n8Source.createdAt),
    content: n8Source.content,
  },
  impact: {
    family: 'A-GRATITUDE',
    delta: { deltaValence: 0.09, deltaArousal: -0.03 }, // 篡改：模拟映射漂移
    sourceAt: Number(n8Source.createdAt),
  },
  receipt: 'affect-semantic@1|COMMITTED|A-GRATITUDE|fp=ffffffffffffffff',
  fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
  now: Date.now(),
})
checkEqual('negative', 'N8a', '映射漂移经端口 ⇒ rejected', 'rejected', n8.kind)
if (n8.kind === 'rejected') {
  checkTrue('negative', 'N8b', '拒码闭集回传（精确增量码）',
    n8.rejectionCodes.includes('affect_delta_not_exact'))
}
const eventsAfterN8 = (await domainEventsFor(db, characterId)).length
checkEqual('negative', 'N8c', '拒绝 ⇒ 零事件（无第二条 IMPACT）',
  eventsBefore + 1, eventsAfterN8)
const n8Gate = (await listProcessedOperations(db, characterId, 500))
  .find((r) => r.idempotencyKey === affectSemanticFinalizedGateKey(n8Source.id))
checkEqual('negative', 'N8d', '拒绝 ⇒ 闸行照落（TERMINAL_FAILED 回执——source 不悬空）',
  encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'), n8Gate?.operation ?? '(missing)')

// ---------------------------------------------------------------------------
// ⑥ 恢复段：重放安全 + 旧词形路径原样
// ---------------------------------------------------------------------------

// R1：同输入重放 ⇒ duplicate_operation + 零事件 + 闸行不被改写
const r1 = await commit(baseInput())
checkEqual('recovery', 'R1a', '重放 ⇒ rejected（duplicate_operation）', 'rejected', r1.kind)
if (r1.kind === 'rejected') {
  checkTrue('recovery', 'R1b', '重放拒码 = duplicate_operation（幂等键命中）',
    r1.rejectionCodes.includes('duplicate_operation'))
}
checkEqual('recovery', 'R1c', '重放零新事件（无双重 IMPACT）',
  eventsAfterN8, (await domainEventsFor(db, characterId)).length)
const r1Gate = (await listProcessedOperations(db, characterId, 500))
  .find((r) => r.idempotencyKey === affectSemanticFinalizedGateKey(sourceEvent.id))
checkTrue('recovery', 'R1d', '闸行保持 COMMITTED（不被 fallback 改写）',
  /^affect-semantic@1\|COMMITTED\|A-GRATITUDE\|fp=[0-9a-f]{16}$/.test(r1Gate?.operation ?? ''))

// R2：旧词形路径原样——精确值通过（M8 evaluator 产的就是表值）
const r2a = await codesOf(semanticProposal({
  ruleVersion: AFFECT_RULES_VERSION,
  timingKind: 'OMIT',
  sourceAt: 'OMIT',
  delta: { ...AFFECT_RULE_DELTAS['A-GRATITUDE'] },
}))
checkTrue('recovery', 'R2a', 'rules@1 精确表值照常通过（旧路径未收紧）', r2a.length === 0)

// R3：旧词形路径原样——**范围内非精确值也通过**（范围界语义 = M8 字节不变）
const r3 = await codesOf(semanticProposal({
  ruleVersion: AFFECT_RULES_VERSION,
  timingKind: 'OMIT',
  sourceAt: 'OMIT',
  delta: { deltaValence: 0.05, deltaArousal: -0.02 },
}))
checkTrue('recovery', 'R3', 'rules@1 范围内非精确值仍通过（M8 范围界语义原样保留）',
  r3.length === 0)

// ---------------------------------------------------------------------------
// 汇总 + 量具自检（§6.8）
// ---------------------------------------------------------------------------

const allPhasesNonEmpty = Object.values(phaseCounts).every((n) => (n ?? 0) > 0)
const failedChecks = checks.filter((c) => !c.pass)
const verdict = allPhasesNonEmpty && failedChecks.length === 0 ? 'PASS' : 'FAIL'

const result = {
  verdict,
  measured_count: checks.length,
  phaseCounts,
  measuredSelfCheck: allPhasesNonEmpty ? 'OK（四段均非空）' : 'MEASUREMENT INVALID（存在空段）',
  failed: failedChecks.map((c) => ({ id: c.id, label: c.label, expected: c.expected, actual: c.actual })),
  passedCount: checks.length - failedChecks.length,
  checkedAt: new Date().toISOString(),
  scope: 'WP7：放行口 affect-semantic-policy@1 精确增量 + SOURCE_ANCHORED 形状 + 旧词形语义原样 + worker commit 端口生产实现（真放行口，拒绝⇒闸行照落）',
}

const runId = `wp7-verify-${result.checkedAt.replace(/[-:T.]/g, '').slice(0, 15)}`
const outDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wp7-verify.json')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

console.log(`verdict        : ${verdict}`)
console.log(`measured_count : ${checks.length} (pass ${result.passedCount} / fail ${failedChecks.length})`)
console.log(`phases         : ${JSON.stringify(phaseCounts)}`)
console.log(`self-check     : ${result.measuredSelfCheck}`)
console.log(`evidence       : ${outPath}`)
process.exit(verdict === 'PASS' ? 0 : 1)
