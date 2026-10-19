/**
 * M8.5 WP6 门 · 第一批 + 第二批 —— **reducer@2 + 终结闸持久化 + 语义 worker**
 * （`pnpm m8.5:wp6:verify`）。
 *
 * ============================================================================
 *  要证明的命题（计划 §15 WP6 出口判据）
 * ============================================================================
 * ① reducer@2 SOURCE_ANCHORED 分支（M85-D19）：衰减结算到 `sourceAt`；
 *    `lastInteractionAt` **不推进**；情绪轴锚前进到 `max(sourceAt, 旧锚)`（不后退）。
 * ② @1 折叠拒绝语义负载（注册面不一致 = 硬错误，不静默错折）。
 * ③ 历史 A==B：无 timingKind 的事件流在 @1/@2 下**逐字段一致**（混合重放基础）。
 * ④ `recordProcessedOperation` 写侧幂等（键已存在 ⇒ recorded:false）。
 * ⑤ `applyAcceptedEvents` extras：缺省**零行**（M8 行为不变）；带 extras 时
 *    与事件**同事务**落库（M85-D20：闸缺失+重评+判定漂移=双重 IMPACT）。
 * ⑥ 无事件终态路径：accepted=[] + extras ⇒ 闸行照落、零事件。
 * ⑦ @2 工厂在真实 apply 链里注册成功（投影行 reducer_version = affect-reducer@2）。
 * ⑧ worker（第二批）：发现扫描（不合格跳过/过期终态/入队）、水位间隙补发现
 *    （崩溃恢复）、传输失败可重试（间隔+预算）、解析失败立即终态、
 *    NO_IMPACT/COMMITTED 原子终态 + 三水位推进、rules 模式零读零写。
 *    模型为注入脚本（耗尽即抛 = 计划外出站负控）；真放行口在 WP7 接线。
 *
 * 不主张（归 WP7/WP8）：放行口判据、模式开关消费、main.ts 接线、shadow 采集面。
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-wp6-verify', { keep: false })



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
  latestCharacterEventSequence,
  latestConversationSequence,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { getAffectProjection } from '../src/infrastructure/persistence/affect-store.ts'
import {
  applyAcceptedEvents,
  countDomainEvents,
  domainEventsFor,
  getProjection,
} from '../src/infrastructure/persistence/event-store.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  findJobByIdempotencyKey,
  getWatermark,
  hasProcessedOperation,
  listJobs,
  listProcessedOperations,
  markJobRunning,
  recordProcessedOperation,
} from '../src/infrastructure/persistence/job-store.ts'
import {
  runAffectSemanticWorkerTick,
  AFFECT_SEMANTIC_SCANNER_NAME,
  AFFECT_SEMANTIC_WORKER_NAME,
  AFFECT_SEMANTIC_IMPACT_NAME,
  affectSemanticTaskIdempotencyKey,
  AFFECT_SEMANTIC_TASK_TRIGGER_KIND,
  type AffectSemanticCommitInput,
  type AffectSemanticCommitOutcome,
  type AffectSemanticWorkerPorts,
  type AffectSemanticModelCallOutcome,
} from '../src/kernel/app/affect/semantic-worker.ts'
import { computeIdempotencyKey } from '../src/kernel/contracts/job.ts'
import {
  AFFECT_ORIGIN,
  AFFECT_TOUCH,
  AFFECT_IMPACT,
} from '../src/kernel/contracts/domain-event.ts'
import {
  AFFECT_DECAY,
  AFFECT_RULES_VERSION,
  UNORIGINATED_AFFECT_STATE,
  decayAffectTowardNeutral,
  type AffectImpactPayload,
  type AffectState,
} from '../src/kernel/contracts/affect.ts'
import {
  AFFECT_SEMANTIC_EVALUATOR_NAME,
  AFFECT_SEMANTIC_EVALUATOR_VERSION,
  AFFECT_SEMANTIC_FINALIZED_PREFIX,
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_SCANNER_PROCESSOR,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  AFFECT_SEMANTIC_IMPACT_PROCESSOR,
  affectSemanticFinalizedGateKey,
  affectSemanticImpactIdempotencyOperation,
  encodeAffectSemanticCommittedReceipt,
  encodeAffectSemanticNoImpactReceipt,
  encodeAffectSemanticTerminalReceipt,
  type AffectSemanticImpactPayload,
  type AffectSemanticTransportFailureCode,
} from '../src/kernel/contracts/affect-semantic.ts'
import {
  AFFECT_REDUCER_VERSION,
  AFFECT_REDUCER_V2_VERSION,
  affectReducerFor,
  affectReducerV2For,
  reduceAffectState,
  reduceAffectStateV2,
} from '../src/kernel/projections/affect.ts'
import { KernelError, asConversationEventId, asConversationId, asJobId, type CharacterId, type DomainEvent } from '../src/kernel/contracts/index.ts'
import { maybeRunAffectEvaluation } from '../src/infrastructure/runtime/affect-scheduler.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 量具（与 WP4/WP5 门同一形状）
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
async function checkThrows(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expectedCode: string,
  fn: () => unknown,
): Promise<void> {
  try {
    fn()
    check(phase, id, label, `KernelError(${expectedCode})`, '未抛出', false)
  } catch (error) {
    const code = error instanceof KernelError ? error.code : String(error)
    check(phase, id, label, expectedCode, code, code === expectedCode)
  }
}

// ---------------------------------------------------------------------------
// ①–③ reducer@2（纯函数段，无数据库）
// ---------------------------------------------------------------------------

const OWNER = 'char-m85-wp6-gate' as CharacterId
const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 3_600_000

function fixtureEvent(
  seq: number,
  type: string,
  payload: unknown,
  createdAt: number,
): DomainEvent {
  return {
    id: `de-gate-${seq}` as never,
    characterId: OWNER,
    sequence: seq,
    type: type as never,
    sourceConversationEventIds: [asConversationEventId('cev-gate')],
    payload,
    processor: 'affect-evaluator',
    processorVersion: 'affect-evaluator@1',
    idempotencyKey: `gate-${seq}`,
    schemaVersion: 1 as never,
    createdAt: createdAt as never,
  } as unknown as DomainEvent
}

const originPayload = {
  characterId: OWNER,
  initialValence: 0,
  initialArousal: 0.5,
  originKind: 'ACTIVATION_BASELINE',
  activationId: 'm85-wp6-gate',
  cutoverAt: T0,
  cutoverSequence: 0,
  policyVersion: 'affect-policy@1',
}
const touchPayload = {
  characterId: OWNER,
  sourceEventId: asConversationEventId('cev-gate-1'),
  sourceSequence: 1,
  originKind: 'ACTIVATION_BASELINE',
  evaluatorVersion: 'affect-evaluator@1',
  proposalId: 'gate-touch',
}
const hostilePayload = {
  characterId: OWNER,
  sourceEventId: asConversationEventId('cev-gate-2'),
  sourceSequence: 2,
  ruleId: 'A-HOSTILE',
  ruleVersion: 'affect-rules@1',
  delta: { deltaValence: -0.15, deltaArousal: 0.12 },
  originKind: 'ACTIVATION_BASELINE' as const,
  evaluatorVersion: 'affect-evaluator@1',
  proposalId: 'gate-impact-1',
}
/** 语义 IMPACT（GRATITUDE 增量 +0.08/-0.03），锚到 sourceAt，晚到 1h40m */
function semanticPayload(sourceAt: number): AffectSemanticImpactPayload {
  return {
    ...hostilePayload,
    ruleId: 'A-GRATITUDE',
    sourceEventId: asConversationEventId('cev-gate-3'),
    sourceSequence: 3,
    delta: { deltaValence: 0.08, deltaArousal: -0.03 },
    sourceAt: sourceAt as never,
    timingKind: 'SOURCE_ANCHORED',
  }
}

const ORIGIN_EV = fixtureEvent(1, AFFECT_ORIGIN, originPayload, T0)
const TOUCH_EV = fixtureEvent(2, AFFECT_TOUCH, touchPayload, T0 + 5 * MIN)
const HOSTILE_EV = fixtureEvent(3, AFFECT_IMPACT, hostilePayload, T0 + 10 * MIN)
const SEMANTIC_EV = fixtureEvent(
  4, AFFECT_IMPACT, semanticPayload(T0 + 20 * MIN), T0 + 2 * HOUR,
)

// —— 正控：V2 SOURCE_ANCHORED 折叠 ——
{
  const afterOrigin = reduceAffectStateV2({ ...UNORIGINATED_AFFECT_STATE }, ORIGIN_EV, OWNER)
  const afterHostile = reduceAffectStateV2(afterOrigin, HOSTILE_EV, OWNER)
  const afterSemantic = reduceAffectStateV2(afterHostile, SEMANTIC_EV, OWNER)

  // 期望值逐步用契约冻结的衰减函数推导（本门断言的是"分支接线"：
  // 哪个时间喂进衰减、哪个锚前进/不动——衰减公式本身是 M8 冻结面，另有门守）
  const arousalAfterHostile =
    decayAffectTowardNeutral(0.5, AFFECT_DECAY.arousalNeutral, AFFECT_DECAY.arousalHalfLifeHours, (10 * MIN) / HOUR) + 0.12
  const valenceDecayedToSource =
    decayAffectTowardNeutral(-0.15, AFFECT_DECAY.valenceNeutral, AFFECT_DECAY.valenceHalfLifeHours, (10 * MIN) / HOUR)
  const arousalDecayedToSource =
    decayAffectTowardNeutral(arousalAfterHostile, AFFECT_DECAY.arousalNeutral, AFFECT_DECAY.arousalHalfLifeHours, (10 * MIN) / HOUR)

  checkEqual('positive', 'R1a', '衰减结算到 sourceAt（valence）',
    valenceDecayedToSource + 0.08, afterSemantic.valence)
  checkEqual('positive', 'R1b', '衰减结算到 sourceAt（arousal）',
    arousalDecayedToSource - 0.03, afterSemantic.arousal)
  checkEqual('positive', 'R1c', 'lastInteractionAt 不推进（M85-D19 核心）',
    T0 + 10 * MIN, afterSemantic.lastInteractionAt)
  checkEqual('positive', 'R1d', '情绪轴锚前进到 sourceAt（不是 event.createdAt）',
    T0 + 20 * MIN, afterSemantic.lastAffectEventAt)
  checkTrue('positive', 'R1e', '锚未被晚到的 createdAt（T0+2h）拉动',
    afterSemantic.lastAffectEventAt !== T0 + 2 * HOUR)
}
// —— 负控：@1 拒绝语义负载 ——
{
  const afterOrigin = reduceAffectState({ ...UNORIGINATED_AFFECT_STATE }, ORIGIN_EV, OWNER)
  const afterHostile = reduceAffectState(afterOrigin, HOSTILE_EV, OWNER)
  await checkThrows('negative', 'R2', '@1 折叠语义负载 = 硬错误（不静默错折）',
    'affect_semantic_payload_requires_reducer_v2',
    () => reduceAffectState(afterHostile, SEMANTIC_EV, OWNER))
}
// —— 正控：历史 A==B ——
{
  const v1Final = [ORIGIN_EV, TOUCH_EV, HOSTILE_EV].reduce<AffectState>(
    (s, e) => reduceAffectState(s, e, OWNER), { ...UNORIGINATED_AFFECT_STATE })
  const v2Final = [ORIGIN_EV, TOUCH_EV, HOSTILE_EV].reduce<AffectState>(
    (s, e) => reduceAffectStateV2(s, e, OWNER), { ...UNORIGINATED_AFFECT_STATE })
  checkEqual('positive', 'R3', '历史事件流 @1/@2 逐字段一致（混合重放 A==B）', v1Final, v2Final)
}
// —— 负控：sourceAt 早于现有锚（不衰减、锚不后退） ——
{
  const afterOrigin = reduceAffectStateV2({ ...UNORIGINATED_AFFECT_STATE }, ORIGIN_EV, OWNER)
  const afterHostile = reduceAffectStateV2(afterOrigin, HOSTILE_EV, OWNER)
  const earlier = fixtureEvent(5, AFFECT_IMPACT, semanticPayload(T0 + 5 * MIN), T0 + 2 * HOUR)
  const folded = reduceAffectStateV2(afterHostile, earlier, OWNER)
  checkEqual('negative', 'R4a', 'sourceAt 早于锚 ⇒ 不衰减（原值 + delta）',
    -0.15 + 0.08, folded.valence)
  checkEqual('negative', 'R4b', '锚不后退（保持 T0+10min）', T0 + 10 * MIN, folded.lastAffectEventAt)
}
// —— 负控：未建档 / 非法 sourceAt ——
{
  await checkThrows('negative', 'R7', 'V2 语义 IMPACT 未建档 = 硬错误',
    'affect_not_originated', () => reduceAffectStateV2({ ...UNORIGINATED_AFFECT_STATE }, SEMANTIC_EV, OWNER))
  const afterOrigin = reduceAffectStateV2({ ...UNORIGINATED_AFFECT_STATE }, ORIGIN_EV, OWNER)
  const badSourceAt = fixtureEvent(6, AFFECT_IMPACT,
    { ...semanticPayload(Number.NaN) }, T0 + 2 * HOUR)
  await checkThrows('negative', 'R8', 'sourceAt 非法 = 硬错误',
    'affect_semantic_source_at_invalid',
    () => reduceAffectStateV2(afterOrigin, badSourceAt, OWNER))
}
// —— 恢复：重放确定性 + 工厂元数据 ——
{
  const run = (): AffectState =>
    [ORIGIN_EV, TOUCH_EV, HOSTILE_EV, SEMANTIC_EV].reduce<AffectState>(
      (s, e) => reduceAffectStateV2(s, e, OWNER), { ...UNORIGINATED_AFFECT_STATE })
  checkEqual('recovery', 'R5', '重放确定性（两次折叠逐字段一致）', run(), run())
  checkEqual('recovery', 'R6a', '@1 工厂版本不变（注册面不动）',
    AFFECT_REDUCER_VERSION, affectReducerFor(OWNER).version)
  checkEqual('recovery', 'R6b', '@2 工厂版本 = affect-reducer@2',
    AFFECT_REDUCER_V2_VERSION, affectReducerV2For(OWNER).version)
  checkEqual('recovery', 'R6c', '终结闸键前缀稳定（跨处理器版本）',
    `${AFFECT_SEMANTIC_FINALIZED_PREFIX}cev-gate-9`,
    affectSemanticFinalizedGateKey(asConversationEventId('cev-gate-9')))
}

// ---------------------------------------------------------------------------
// ④–⑦ 持久化段（隔离库；真实库不打开；引导按 m8-wp6-verify 既有范式）
// ---------------------------------------------------------------------------

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(runtime)
await runtime.initialize()
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
})
const characterId = kernel.characterId
const db = kernel.stores.db

// —— 正控：recordProcessedOperation 写侧 ——
const GATE_OP_KEY = 'm85-wp6-gate-op-1'
const first = await recordProcessedOperation(db, {
  idempotencyKey: GATE_OP_KEY,
  characterId,
  processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
  processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
  operation: 'gate-write-side',
})
checkTrue('positive', 'P1a', 'recordProcessedOperation 首写 recorded=true', first.recorded)
checkTrue('positive', 'P1b', 'hasProcessedOperation 读回 true',
  await hasProcessedOperation(db, GATE_OP_KEY))
const listed = await listProcessedOperations(db, characterId, 50)
checkTrue('positive', 'P1c', 'listProcessedOperations 可见该行',
  listed.some((r) => r.idempotencyKey === GATE_OP_KEY && r.operation === 'gate-write-side'))

// —— 负控：重复写 = 幂等命中 ——
const dup = await recordProcessedOperation(db, {
  idempotencyKey: GATE_OP_KEY,
  characterId,
  processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
  processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
  operation: 'gate-write-side',
})
checkTrue('negative', 'P2', '重复写 recorded=false（on conflict do nothing）', !dup.recorded)

// —— 正控：applyAcceptedEvents 缺省零 extras（M8 行为不变） ——
const originAccepted: AcceptedDomainEvent = {
  type: AFFECT_ORIGIN,
  operation: 'affect-origin:m85-wp6-gate',
  payload: {
    characterId,
    initialValence: 0,
    initialArousal: 0.5,
    originKind: 'ACTIVATION_BASELINE',
    activationId: 'm85-wp6-gate',
    cutoverAt: T0,
    cutoverSequence: 0,
    policyVersion: 'affect-policy@1',
  },
  sourceConversationEventIds: [asConversationEventId('cev-m85-wp6-origin')],
  idempotencyKey: 'affect-origin:m85-wp6-gate',
  processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
  processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
  scope: 'CHARACTER_INTERNAL',
}
const v2Reducer = affectReducerV2For(characterId)
const plain = await applyAcceptedEvents(db, characterId, [originAccepted], [v2Reducer], T0)
checkEqual('positive', 'P3a', '缺省 extras：extraRecordedCount=0（M8 行为不变）', 0, plain.extraRecordedCount)
checkEqual('positive', 'P3b', '事件照常创建', 1, plain.createdCount)
const projectionV2 = await getProjection<AffectState>(db, characterId, v2Reducer.projectionType)
checkEqual('positive', 'P3c', '@2 工厂在真实 apply 链注册成功（reducer_version=affect-reducer@2）',
  AFFECT_REDUCER_V2_VERSION, projectionV2?.reducerVersion)

// —— 正控：带 extras 的事件提交（闸与事件同事务） ——
const touchAccepted: AcceptedDomainEvent = {
  type: AFFECT_TOUCH,
  operation: 'affect-touch:m85-wp6-gate',
  payload: {
    characterId,
    sourceEventId: asConversationEventId('cev-m85-wp6-1'),
    sourceSequence: 1,
    originKind: 'ACTIVATION_BASELINE',
    evaluatorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
    proposalId: 'm85-wp6-gate-touch',
  },
  sourceConversationEventIds: [asConversationEventId('cev-m85-wp6-1')],
  idempotencyKey: 'affect-touch:m85-wp6-gate',
  processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
  processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
  scope: 'CHARACTER_INTERNAL',
}
const FP = '0123456789abcdef'
const gateKey = affectSemanticFinalizedGateKey(asConversationEventId('cev-m85-wp6-1'))
const receipt = encodeAffectSemanticNoImpactReceipt('NEUTRAL', FP)
const withExtras = await applyAcceptedEvents(db, characterId, [touchAccepted], [v2Reducer], T0 + MIN, {
  extraProcessedOperations: [
    {
      idempotencyKey: gateKey,
      processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
      processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
      operation: receipt,
    },
  ],
})
checkEqual('positive', 'P4a', 'extras 与事件同事务落库（extraRecordedCount=1）', 1, withExtras.extraRecordedCount)
checkTrue('positive', 'P4b', '终结闸行可读回（hasProcessedOperation）',
  await hasProcessedOperation(db, gateKey))
const gateRows = await listProcessedOperations(db, characterId, 500)
checkTrue('positive', 'P4c', '闸行携带紧凑回执编码（闭集，无正文）',
  gateRows.some((r) => r.idempotencyKey === gateKey && r.operation === receipt))

// —— 负控：重放同一提交 = 全幂等 ——
const replay = await applyAcceptedEvents(db, characterId, [touchAccepted], [v2Reducer], T0 + MIN, {
  extraProcessedOperations: [
    {
      idempotencyKey: gateKey,
      processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
      processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
      operation: receipt,
    },
  ],
})
checkEqual('negative', 'P5a', '重放：事件幂等命中（createdCount=0）', 0, replay.createdCount)
checkEqual('negative', 'P5b', '重放：闸行幂等命中（extraRecordedCount=0）', 0, replay.extraRecordedCount)

// —— 正控：无事件终态路径（accepted=[] + extras） ——
const eventsBefore = await countDomainEvents(db, characterId)
const gateKey2 = affectSemanticFinalizedGateKey(asConversationEventId('cev-m85-wp6-2'))
const terminalOnly = await applyAcceptedEvents(db, characterId, [], [v2Reducer], T0 + 2 * MIN, {
  extraProcessedOperations: [
    {
      idempotencyKey: gateKey2,
      processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
      processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
      operation: encodeAffectSemanticNoImpactReceipt('UNCERTAIN', FP),
    },
  ],
})
checkEqual('positive', 'P6a', '无事件终态：零事件（createdCount=0）', 0, terminalOnly.createdCount)
checkEqual('positive', 'P6b', '无事件终态：闸行照落（extraRecordedCount=1）', 1, terminalOnly.extraRecordedCount)
checkEqual('positive', 'P6c', '领域事件总数不变', eventsBefore, await countDomainEvents(db, characterId))
checkTrue('positive', 'P6d', '第二条闸行可读回', await hasProcessedOperation(db, gateKey2))

// —— 恢复：水位推进与回退拒绝（既有行为在新链路上复验；用探针身份，不占 worker 水位） ——
const WM_PROC = 'wp6-wm-probe'
const WM_VER = 'wp6-wm-probe@1'
await advanceWatermark(db, characterId, WM_PROC, WM_VER, 1, T0)
checkTrue('recovery', 'P7a', '水位推进成功', true)
let rejected = false
try {
  await advanceWatermark(db, characterId, WM_PROC, WM_VER, 0, T0 + 1)
} catch {
  rejected = true
}
checkTrue('recovery', 'P7b', '水位回退被拒（只许前进）', rejected)

// ---------------------------------------------------------------------------
// ⑧ worker 段（WP6 第二批）：发现 / 生命周期 / 重试 / 终态 / 水位
//    隔离库 + 真持久化端口 + 注入模型（零真实出站）。
//    commitOutcome 端口在门里直接构造语义 IMPACT 事件（WP7 才接真放行口——
//    本段证明的是 worker 的编排不变量，不是放行口判据）。
// ---------------------------------------------------------------------------

const USER = 'm85-wp6-user'
const CONV = asConversationId('m85-wp6-worker-conv')
const recorder = new ConversationRecorder({
  db,
  characterId,
  conversationId: CONV,
  dryRun: false,
  userName: USER,
  characterName: character.name,
  transport: 'm8.5-wp6-verify',
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
  userId: USER,
  userRef: USER,
})

// —— 注入模型：脚本化结果队列（耗尽即抛 = 负控：不许有计划外出站） ——
type ScriptedCall =
  | { ok: true; content: string }
  | { ok: false; failure: AffectSemanticTransportFailureCode }
const script: ScriptedCall[] = []
let modelCalls = 0
const callModelImpl = async (_outboundText: string): Promise<AffectSemanticModelCallOutcome> => {
  modelCalls += 1
  const next = script.shift()
  if (next === undefined) throw new Error('script exhausted: 计划外的模型调用')
  if (!next.ok) return { ok: false, failure: next.failure, requestCount: 1 }
  return {
    ok: true,
    envelope: { content: next.content, finishReason: 'stop', hasToolCalls: false },
    requestCount: 1,
  }
}

const NEUTRAL_JSON =
  '{"decision":"NEUTRAL","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"ORDINARY_INTERACTION"}'
const GRATITUDE_JSON =
  '{"decision":"IMPACT","target":"CHARACTER","candidates":[{"family":"A-GRATITUDE","span":{"start":0,"end":2}}],"contextRefs":[],"reasonCode":"DIRECT_APPRECIATION"}'

// —— commitOutcome 端口：真 applyAcceptedEvents（事件 + 终结闸同事务） ——
const commitOutcomeImpl = async (
  input: AffectSemanticCommitInput,
): Promise<AffectSemanticCommitOutcome> => {
  const gateKey = affectSemanticFinalizedGateKey(input.source.sourceEventId)
  const extra = {
    idempotencyKey: gateKey,
    processor: AFFECT_SEMANTIC_WORKER_NAME,
    processorVersion: AFFECT_SEMANTIC_WORKER_PROCESSOR,
    operation: input.receipt,
  }
  if (input.impact !== undefined) {
    const operation = affectSemanticImpactIdempotencyOperation(
      input.impact.family,
      input.source.sourceEventId,
    )
    const accepted: AcceptedDomainEvent = {
      type: AFFECT_IMPACT,
      operation,
      payload: {
        characterId,
        sourceEventId: input.source.sourceEventId,
        sourceSequence: input.source.sourceSequence,
        ruleId: input.impact.family,
        ruleVersion: AFFECT_SEMANTIC_POLICY_VERSION,
        delta: input.impact.delta,
        originKind: 'ACTIVATION_BASELINE',
        evaluatorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
        proposalId: `affect-semantic:${String(input.source.sourceEventId)}`,
        sourceAt: input.impact.sourceAt,
        timingKind: 'SOURCE_ANCHORED',
      } satisfies AffectSemanticImpactPayload,
      sourceConversationEventIds: [input.source.sourceEventId],
      idempotencyKey: computeIdempotencyKey({
        characterId,
        processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
        processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
        sourceFromSequence: 0,
        sourceToSequence: 0,
        operation,
      }),
      processor: AFFECT_SEMANTIC_EVALUATOR_NAME,
      processorVersion: AFFECT_SEMANTIC_EVALUATOR_VERSION,
      scope: 'CHARACTER_INTERNAL',
    }
    const applied = await applyAcceptedEvents(
      db, characterId, [accepted], [affectReducerV2For(characterId)], input.now,
      { extraProcessedOperations: [extra] },
    )
    return {
      kind: 'committed',
      createdCount: applied.createdCount,
      deduplicatedCount: applied.deduplicatedCount,
      extraRecordedCount: applied.extraRecordedCount,
    }
  }
  const applied = await applyAcceptedEvents(
    db, characterId, [], [affectReducerV2For(characterId)], input.now,
    { extraProcessedOperations: [extra] },
  )
  return { kind: 'no_impact', extraRecordedCount: applied.extraRecordedCount }
}

// —— 真持久化端口（生产装配的形状；WP8 才进 main.ts） ——
const ports: AffectSemanticWorkerPorts = {
  characterAlias: character.name,
  latestSequence: () => latestCharacterEventSequence(db, characterId),
  loadEventsInRange: (_cid, from, to) => conversationEventsInRange(db, characterId, from, to, 2000),
  getAffectState: async () => (await getAffectProjection(db, characterId))?.state,
  hasProcessed: (key) => hasProcessedOperation(db, key),
  keywordImpactedSourceIds: async () => {
    const events = await domainEventsFor(db, characterId)
    const ids = new Set<string>()
    for (const event of events) {
      if (event.type !== AFFECT_IMPACT) continue
      const payload = event.payload as Partial<AffectImpactPayload> | undefined
      if (payload?.ruleVersion !== AFFECT_RULES_VERSION) continue
      if (payload.sourceEventId !== undefined) ids.add(String(payload.sourceEventId))
    }
    return ids
  },
  getWatermark: (processor, version) =>
    getWatermark(db, characterId, processor, version).then((w) => w?.processedThroughSequence),
  advanceWatermark: (processor, version, through, now) =>
    advanceWatermark(db, characterId, processor, version, through, now).then(() => undefined),
  enqueueTask: async (source, now) => {
    const key = affectSemanticTaskIdempotencyKey(source.sourceEventId)
    const existing = await findJobByIdempotencyKey(db, key)
    const result = await enqueueJob(db, {
      characterId,
      processor: AFFECT_SEMANTIC_WORKER_NAME,
      processorVersion: AFFECT_SEMANTIC_WORKER_PROCESSOR,
      sourceFromSequence: source.sourceSequence,
      sourceToSequence: source.sourceSequence,
      idempotencyKey: key,
      triggerKind: AFFECT_SEMANTIC_TASK_TRIGGER_KIND,
      now,
    })
    return {
      jobId: String(result.job.id),
      created: result.created,
      retryCount: result.job.retryCount,
      lastAttemptAt: existing?.createdAt ?? result.job.createdAt,
    }
  },
  markTaskRunning: (jobId, now) => markJobRunning(db, asJobId(jobId), now).then(() => undefined),
  finishTask: (jobId, status, opts, now) =>
    finishJob(db, asJobId(jobId), status, { error: opts?.error, now }).then(() => undefined),
  commitOutcome: commitOutcomeImpl,
  callModel: callModelImpl,
}

const wmOf = (processor: string, version: string) =>
  getWatermark(db, characterId, processor, version).then((w) => w?.processedThroughSequence)
const gateRowOf = async (sourceEventId: ReturnType<typeof asConversationEventId>) => {
  const rows = await listProcessedOperations(db, characterId, 500)
  return rows.find((r) => r.idempotencyKey === affectSemanticFinalizedGateKey(sourceEventId))
}

// —— W1（负控）：rules 模式 = 具名 no-op，零读零写 ——
const w1 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'rules', now: Date.now(),
})
checkEqual('negative', 'W1', 'rules 模式具名 no-op（单写入者：词形路径独占）',
  JSON.stringify({ kind: 'mode_not_semantic', mode: 'rules' }), JSON.stringify(w1))

// —— 记录夹具：用户A（NEUTRAL）→ 助手（不合格）→ 用户B（GRATITUDE） ——
// 会话内序号是连续账：助手事件没录就不占号，因此每次从账本推导下一号。
const nextConvSeq = async (): Promise<number> =>
  (await latestConversationSequence(db, characterId, CONV)) + 1
const recA = await recorder.recordUserMessage('今天先这样，回头再说。', await nextConvSeq())
const recAssistant = await recorder.recordAssistantMessage({
  text: '好的，随时找我。',
  conversationSequence: await nextConvSeq(),
  characterSequence: recA.assistantSequence!,
  replyToEventId: recA.event!.id,
})
const recB = await recorder.recordUserMessage('这回要是没有你，我真不知道怎么收场。', await nextConvSeq())
const seqA = recA.event!.sequence
const seqB = recB.event!.sequence
const stateBeforeW2 = (await getAffectProjection(db, characterId))?.state

// —— W2（正控）：一个 tick 完成 发现→入队→评估→终态→水位 ——
script.push({ ok: true, content: NEUTRAL_JSON })
script.push({ ok: true, content: GRATITUDE_JSON })
const w2 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: Date.now(),
})
checkTrue('positive', 'W2a', 'tick 完成（ran）', w2.kind === 'ran')
if (w2.kind === 'ran') {
  checkEqual('positive', 'W2b', '扫描 3 条（2 用户 + 1 助手）', 3, w2.scanned)
  checkEqual('positive', 'W2c', '助手事件不合格跳过（非 user_message）', 1, w2.skippedNotUserMessage)
  checkEqual('positive', 'W2d', '合格 source 全部入队', 2, w2.enqueued)
  checkEqual('positive', 'W2e', '模型调用 = 2（每 source 恰一次）', 2, w2.modelCalls)
  checkEqual('positive', 'W2f', 'NEUTRAL → NO_IMPACT 终态', 1, w2.noImpact)
  checkEqual('positive', 'W2g', 'GRATITUDE → COMMITTED 终态', 1, w2.committed)
  checkEqual('positive', 'W2h', '完成水位越过两个 source（=B 序号）', seqB, w2.workerWatermark)
}
checkEqual('positive', 'W2i', '扫描水位 = 账本最新', seqB,
  (await wmOf(AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)) ?? -1)
checkEqual('positive', 'W2j', '完成水位持久化（=B 序号）', seqB,
  (await wmOf(AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR)) ?? -1)
checkEqual('positive', 'W2k', '影响水位 = 最后成功 IMPACT 的 source', seqB,
  (await wmOf(AFFECT_SEMANTIC_IMPACT_NAME, AFFECT_SEMANTIC_IMPACT_PROCESSOR)) ?? -1)
const gateA = await gateRowOf(recA.event!.id)
checkTrue('positive', 'W2l', 'A 的终结闸行存在', gateA !== undefined)
checkTrue('positive', 'W2m', 'A 闸行 = NO_IMPACT 紧凑回执（闭集，无正文）',
  (gateA?.operation ?? '').startsWith('affect-semantic@1|NO_IMPACT|NEUTRAL|fp='))
const gateB = await gateRowOf(recB.event!.id)
checkTrue('positive', 'W2n', 'B 的终结闸行存在', gateB !== undefined)
checkTrue('positive', 'W2o', 'B 闸行 = COMMITTED 紧凑回执（族 + 16hex 指纹）',
  /^affect-semantic@1\|COMMITTED\|A-GRATITUDE\|fp=[0-9a-f]{16}$/.test(gateB?.operation ?? ''))
const impactEvents = (await domainEventsFor(db, characterId)).filter(
  (e) => e.type === AFFECT_IMPACT && (e.payload as AffectSemanticImpactPayload).timingKind === 'SOURCE_ANCHORED',
)
checkEqual('positive', 'W2p', '语义 IMPACT 事件恰一条（SOURCE_ANCHORED）', 1, impactEvents.length)
const stateAfterW2 = (await getAffectProjection(db, characterId))?.state
checkTrue('positive', 'W2q', '投影 valence 收到 GRATITUDE 增量（>0.07）',
  (stateAfterW2?.valence ?? -1) > 0.07)
checkEqual('positive', 'W2r', 'lastInteractionAt 不被语义 IMPACT 推进（M85-D19）',
  stateBeforeW2?.lastInteractionAt ?? -1, stateAfterW2?.lastInteractionAt ?? -2)
const workerJobs = await listJobs(db, characterId)
const semanticJobs = workerJobs.filter((j) => j.processor === AFFECT_SEMANTIC_WORKER_NAME)
checkEqual('positive', 'W2s', '任务行 2 条且全部 completed', 2,
  semanticJobs.filter((j) => j.status === 'completed').length)

// —— W3（负控→恢复）：传输失败可重试；间隔未到不烧模型；重试成功 ——
const recC = await recorder.recordUserMessage('帮我看看这个思路行不行。', await nextConvSeq())
const seqC = recC.event!.sequence
script.push({ ok: false, failure: 'rate_limited' })
const w3now = Date.now()
const w3 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: w3now,
})
checkTrue('negative', 'W3a', '传输失败 tick 完成（ran）', w3.kind === 'ran')
if (w3.kind === 'ran') {
  checkEqual('negative', 'W3b', 'rate_limited 按闭集码计数', 1, w3.transportFailures.rate_limited ?? 0)
  checkEqual('negative', 'W3c', '可重试：本轮不再试（deferred）', 1, w3.retryableDeferred)
  checkEqual('negative', 'W3d', '完成水位楔在未终结 source 之下（不越过）', seqB, w3.workerWatermark)
}
checkTrue('negative', 'W3e', '失败 source 无终结闸（未终结，不许有终态）',
  (await gateRowOf(recC.event!.id)) === undefined)
const cTask = await findJobByIdempotencyKey(db, affectSemanticTaskIdempotencyKey(recC.event!.id))
checkEqual('negative', 'W3f', '任务行落 failed（部分唯一索引允许重建）', 'failed', cTask?.status ?? '')
script.push({ ok: true, content: NEUTRAL_JSON })
const w3b = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: w3now + 3000,
})
checkTrue('recovery', 'W3g', '间隔已到：重试 tick 完成（ran）', w3b.kind === 'ran')
if (w3b.kind === 'ran') {
  checkEqual('recovery', 'W3h', '重试成功 → NO_IMPACT 终态', 1, w3b.noImpact)
  checkEqual('recovery', 'W3i', '完成水位越过重试成功的 source', seqC, w3b.workerWatermark)
}
checkTrue('recovery', 'W3j', '重试后终结闸存在', (await gateRowOf(recC.event!.id)) !== undefined)

// —— W4（负控）：尝试预算烧尽（2 次传输失败）⇒ TERMINAL_FAILED ——
const recD = await recorder.recordUserMessage('再来一题试试。', await nextConvSeq())
const seqD = recD.event!.sequence
script.push({ ok: false, failure: 'network_error' })
const w4now = Date.now()
await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: w4now,
})
script.push({ ok: false, failure: 'timeout' })
const w4b = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: w4now + 10000,
})
checkTrue('negative', 'W4a', '预算烧尽 tick 完成（ran）', w4b.kind === 'ran')
if (w4b.kind === 'ran') {
  checkEqual('negative', 'W4b', '第二次失败 ⇒ retryExhausted', 1, w4b.retryExhausted)
  checkEqual('negative', 'W4c', '完成水位越过 TERMINAL_FAILED source', seqD, w4b.workerWatermark)
}
const gateD = await gateRowOf(recD.event!.id)
checkTrue('negative', 'W4d', 'TERMINAL_FAILED 终结闸存在',
  (gateD?.operation ?? '') === encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'))

// —— W5（负控）：解析失败（确定性）⇒ 立即终态，不重试 ——
const recE = await recorder.recordUserMessage('这条会触发解析失败。', await nextConvSeq())
const seqE = recE.event!.sequence
script.push({ ok: true, content: '{"decision":' })
const w5 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: Date.now(),
})
checkTrue('negative', 'W5a', '解析失败 tick 完成（ran）', w5.kind === 'ran')
if (w5.kind === 'ran') {
  checkEqual('negative', 'W5b', '解析失败按闭集码计数（11 码集）', 1,
    Object.values(w5.parseFailures).reduce((a, b) => a + b, 0))
  checkEqual('negative', 'W5c', '解析失败不重试（单次模型调用后终态）', 1, w5.terminalFailed)
  checkEqual('negative', 'W5d', '完成水位越过解析失败 source', seqE, w5.workerWatermark)
}
checkTrue('negative', 'W5e', '解析失败 ⇒ TERMINAL_FAILED 终结闸',
  ((await gateRowOf(recE.event!.id))?.operation ?? '') === encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'))

// —— W6（负控）：时龄超限 ⇒ EXPIRED（不出站、不重试） ——
const recF = await recorder.recordUserMessage('这条会过期的。', await nextConvSeq())
const seqF = recF.event!.sequence
const scriptLenBeforeW6 = script.length
const w6 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: Date.now() + 200_000,
})
checkTrue('negative', 'W6a', '过期 tick 完成（ran）', w6.kind === 'ran')
if (w6.kind === 'ran') {
  checkEqual('negative', 'W6b', '扫描期即 EXPIRED（未入队未出站）', 1, w6.expiredAtScan)
  checkEqual('negative', 'W6c', '过期 source 零模型调用', 0, w6.modelCalls)
  checkEqual('negative', 'W6d', '完成水位越过过期 source', seqF, w6.workerWatermark)
}
checkEqual('negative', 'W6e', '注入脚本未被消耗（无计划外出站）',
  scriptLenBeforeW6, script.length)
checkTrue('negative', 'W6f', 'EXPIRED 终结闸（紧凑回执）',
  ((await gateRowOf(recF.event!.id))?.operation ?? '') === encodeAffectSemanticTerminalReceipt('EXPIRED'))

// —— W7（恢复）：崩溃后从水位间隙补发现（内存队列不是真相） ——
const recG = await recorder.recordUserMessage('崩溃后恢复的。', await nextConvSeq())
const seqG = recG.event!.sequence
// 模拟崩溃：扫描+入队已完成，处理前进程死掉（扫描水位手动推进到 G）
await ports.enqueueTask({ sourceEventId: recG.event!.id, sourceSequence: seqG }, Date.now())
await advanceWatermark(db, characterId, AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR, seqG, Date.now())
script.push({ ok: true, content: NEUTRAL_JSON })
const w7 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: Date.now(),
})
checkTrue('recovery', 'W7a', '崩溃恢复 tick 完成（ran）', w7.kind === 'ran')
if (w7.kind === 'ran') {
  checkEqual('recovery', 'W7b', '扫描段无新发现（enqueued=0）', 0, w7.enqueued)
  checkEqual('recovery', 'W7c', '间隙补发现处理了崩溃遗留 source', 1, w7.noImpact)
  checkEqual('recovery', 'W7d', '完成水位越过恢复的 source', seqG, w7.workerWatermark)
}
checkTrue('recovery', 'W7e', '恢复后终结闸存在', (await gateRowOf(recG.event!.id)) !== undefined)

// —— W8（恢复）：队列清空后再 tick = no_tail（幂等，零出站） ——
const w8 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: Date.now(),
})
checkEqual('recovery', 'W8a', '空转 tick = no_tail', 'no_tail', w8.kind)
checkEqual('recovery', 'W8b', '空转零模型调用（脚本已空未耗尽）', 0, script.length)
checkEqual('recovery', 'W8c', '全部 source 终结后三水位一致（scanner=worker）',
  (await wmOf(AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)) ?? -1,
  (await wmOf(AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR)) ?? -2)

// —— W9（负控 · §24 ③ WP11 补）：词形已落 IMPACT 的 source 语义永不重评 ——
// 场景 = 回滚间隙：semantic 时代之后切走（rules），间隙里词形写入者对 H 落了
// IMPACT，再切回 semantic —— 语义发现必须把 H 当"另一写入者的终态处置"跳过
// （不重评、不写闸、不烧模型、不楔水位）。没有这个跳过 = 同一 source 双 IMPACT。
const recH = await recorder.recordUserMessage('谢谢你，这回帮了大忙。', await nextConvSeq())
const seqH = recH.event!.sequence
const keywordRun = await maybeRunAffectEvaluation(db, {
  characterId, activeUserId: USER, affectReducerVersion: 2,
})
checkTrue('negative', 'W9a', '词形评估器消费间隙 source（@2 行上 @2 折叠——回滚路径的写入者活着）',
  keywordRun.kind === 'flushed')
const keywordImpacts = (await domainEventsFor(db, characterId))
  .filter((e) => e.type === AFFECT_IMPACT)
  .map((e) => e.payload as Partial<AffectImpactPayload>)
const impactForH = keywordImpacts.find((p) => String(p.sourceEventId) === String(recH.event!.id))
checkTrue('negative', 'W9b', '词形 IMPACT 在场且判别字段正确（ruleVersion=affect-rules@1——端口判据的实锚）',
  impactForH !== undefined && impactForH.ruleVersion === AFFECT_RULES_VERSION)
const semanticImpactCountBefore = keywordImpacts.filter(
  (p) => p.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION
).length
const w9 = await runAffectSemanticWorkerTick(ports, {
  characterId, activeUserId: USER, mode: 'semantic', now: Date.now(),
})
checkEqual('negative', 'W9c', '语义 tick 跳过词形已终结 source（skippedKeywordFinalized=1）',
  1, w9.kind === 'ran' ? w9.skippedKeywordFinalized : -1)
checkEqual('negative', 'W9d', '跳过 = 零模型调用（注入脚本原封未动）',
  0, script.length)
checkEqual('negative', 'W9e', '跳过 = 零语义闸行（H 不是"被取消的语义工作"，不写谎账）',
  undefined,
  (await listProcessedOperations(db, characterId, 500))
    .find((r) => r.idempotencyKey === affectSemanticFinalizedGateKey(recH.event!.id as never)))
checkEqual('negative', 'W9f', '跳过 = 零语义 IMPACT（同一 source 不双计）',
  semanticImpactCountBefore,
  (await domainEventsFor(db, characterId))
    .filter((e) => e.type === AFFECT_IMPACT)
    .map((e) => e.payload as Partial<AffectImpactPayload>)
    .filter((p) => p.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION).length)
checkEqual('negative', 'W9g', '跳过不楔水位（worker 越过词形已终结 source）',
  seqH, w9.kind === 'ran' ? w9.workerWatermark : -1)

// ---------------------------------------------------------------------------
// 量具自检前的静态段：注册面与缺省行为的源码级断言
// ---------------------------------------------------------------------------

const reducerSource = readFileSync(
  join(REPO_ROOT, 'src/kernel/projections/affect.ts'), 'utf8')
checkTrue('static', 'S1a', "@1 版本常量未动（affect-reducer@1）",
  reducerSource.includes("AFFECT_REDUCER_VERSION = 'affect-reducer@1'"))
checkTrue('static', 'S1b', "@2 版本常量存在（affect-reducer@2）",
  reducerSource.includes("AFFECT_REDUCER_V2_VERSION = 'affect-reducer@2'"))
checkTrue('static', 'S1c', '@1 工厂仍由 @1 常量注册（注册面不静默切换）',
  reducerSource.includes('version: AFFECT_REDUCER_VERSION,'))
const jobStoreSource = readFileSync(
  join(REPO_ROOT, 'src/infrastructure/persistence/job-store.ts'), 'utf8')
checkTrue('static', 'S2', 'recordProcessedOperation 幂等写入（on conflict do nothing）',
  jobStoreSource.includes('on conflict (idempotency_key) do nothing'))
const eventStoreSource = readFileSync(
  join(REPO_ROOT, 'src/infrastructure/persistence/event-store.ts'), 'utf8')
checkTrue('static', 'S3a', 'applyAcceptedEvents extras 为可选参数（缺省 {}）',
  eventStoreSource.includes('options: ApplyAcceptedEventsOptions = {}'))
checkTrue('static', 'S3b', 'extras 缺省零行（?? []）',
  eventStoreSource.includes('options.extraProcessedOperations ?? []'))

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
  scope: 'WP6 第一批+第二批：reducer@2 + 终结闸持久化 + 语义 worker（发现/生命周期/重试/终态/水位；注入模型，真放行口归 WP7）',
}

const runId = `wp6-verify-${result.checkedAt.replace(/[-:T.]/g, '').slice(0, 15)}`
const outDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wp6-verify.json')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

console.log(`verdict        : ${verdict}`)
console.log(`measured_count : ${checks.length} (pass ${result.passedCount} / fail ${failedChecks.length})`)
console.log(`phases         : ${JSON.stringify(phaseCounts)}`)
console.log(`self-check     : ${result.measuredSelfCheck}`)
console.log(`evidence       : ${outPath}`)
process.exit(verdict === 'PASS' ? 0 : 1)
