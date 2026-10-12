/**
 * M9 WP5 门 —— 生命周期、遗忘与失效传播（`m9:invalidation:verify`）。
 *
 * ============================================================================
 *  五段判据（计划 §16.1/WP5 出口；全部失败关闭）
 * ============================================================================
 * §1 B-REPORTED reconciler：白名单形成路径（合格 claim → FORMED(reported)
 *    提案 → 放行口接受）；不合格记忆零提案；同 Memory 重扫撞幂等键；
 *    放行口负控（端口缺失/记忆缺失/不在白名单/beliefId 不可复推）。
 * §2 依赖失效传播（Memory 撤回）：planMemoryInvalidation → RETRACTED
 *    (dependency_invalidated，**不禁根**)；读侧回查同判失效（零泄漏）；
 *    本轮 overlay 在写侧未收敛时同轮遮蔽（§7.1 双保险的读侧半边）。
 * §3 qualified→unqualified（根失效）：读侧回查排除 + planRootInvalidation
 *    → RETRACTED(forbidden=[该根]) → 旧根再喂新形成被拒（B28 机制）。
 * §4 显式遗忘/纠正/争议（B28/B29/B31）：唯一目标 → RETRACTED(forget,
 *    禁全部根)；空禁用根的 forget 被放行口拒（B28 硬规则）；重放旧根不复活；
 *    新根新 identity（B31）；歧义目标 → clarify 零提案零成功口吻（B29）；
 *    纠正 → SUPERSEDED old→new（新值先形成，不倒写旧源）。
 * §5 恢复快照 + 重复回放（B30，隔离库）：全生命周期落库 → 增量 apply →
 *    全量 rebuild ⇒ retracted 不复活、禁用根保留、A==B；事件重放 no-op。
 *
 * 证据：`artifacts/m9/m9-wp5-invalidation-<date>-<head12>-<suffix4>/`（m9-manifest@1）。
 */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9-invalidation-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import {
  applyBeliefRows,
  forbiddenRootsForSlot,
  foldBeliefRows,
  getBelief,
  listActiveBeliefs,
  rebuildBeliefProjections,
  type RowCacheEntry,
} from '../src/infrastructure/persistence/belief-store.ts'
import { beliefOriginRowKey, beliefRowKeyOf } from '../src/kernel/projections/belief.ts'
import {
  BELIEF_DISPUTED,
  BELIEF_EVIDENCE_NOTED,
  BELIEF_FORMED,
  BELIEF_ORIGIN,
  BELIEF_RETRACTED,
  BELIEF_SUPERSEDED,
  DOMAIN_EVENT_SCOPE,
  createBeliefDomainEventRegistry,
  type DomainEvent,
} from '../src/kernel/contracts/domain-event.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import type { DomainProposal } from '../src/kernel/contracts/proposal.ts'
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_RULE_ID,
  BELIEF_INFERRED_RULE_VERSION,
  BELIEF_INFERRED_SCOPE,
  BELIEF_REPORTED_RULE_ID,
  BELIEF_REPORTED_RULE_VERSION,
  BELIEF_REJECTION_CODES,
  BELIEF_REVISION_RULE_ID,
  beliefReportedFormationKeyOf,
  beliefReportedScopeKeyOf,
  beliefSlotKeyOf,
  makeBeliefId,
  type BeliefFormedPayload,
  type BeliefOriginPayload,
  type BeliefOriginState,
  type BeliefRetractedPayload,
  type BeliefState,
} from '../src/kernel/contracts/belief.ts'
import {
  beliefDisputedUnitOperation,
  beliefEvidenceUnitOperation,
  beliefFormedUnitOperation,
  beliefOriginUnitOperation,
  beliefRetractedUnitOperation,
  beliefSupersededUnitOperation,
  idempotencyKeyForBeliefEvent,
  validateBeliefProposal,
  type BeliefStateLookup,
  type BeliefValidatorDeps,
} from '../src/kernel/policies/belief-validator.ts'
import {
  reconcileMemoryWindow,
  type MemoryEventTrigger,
  type ReconcilerMemoryView,
} from '../src/kernel/app/belief/reconciler.ts'
import {
  planBeliefCorrection,
  planBeliefDispute,
  planBeliefForget,
  planMemoryInvalidation,
  planRootInvalidation,
  type BeliefRevisionDeps,
} from '../src/kernel/app/belief/revision.ts'
import {
  applyInvalidationOverlay,
  recheckBeliefDependencies,
  usableBeliefsOf,
  type BeliefEligibilityDeps,
} from '../src/kernel/app/belief/eligibility.ts'
import { asCharacterId, asConversationEventId, asEntityId, type CharacterId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import type { MemoryContent } from '../src/kernel/contracts/memory.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = process.cwd()
const NOW = 1_800_000_000_000
const CHARACTER = asCharacterId('char_sumuwei')
const USER = asEntityId('user_alex')
const SUBJECT = entityRef('user', 'user_alex')
const PREDICATE = BELIEF_INFERRED_PREDICATE
const SCOPE = BELIEF_INFERRED_SCOPE
const SLOT_KEY = beliefSlotKeyOf({
  perspectiveOwnerId: asEntityId(String(CHARACTER)),
  subject: SUBJECT,
  predicate: PREDICATE,
  scopeKey: SCOPE,
})
const PROCESSOR = 'm9-wp5-gate'
const PROCESSOR_VERSION = 'm9-wp5-gate@1'

// ---------------------------------------------------------------------------
// check 汇总（与 m9-verify 同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
function check(id: string, name: string, pass: boolean, detail: string): void {
  checks.push({ id, name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name} :: ${detail}`)
  if (!pass) process.exitCode = 1
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// 行内模型（validator 接受的事件折进生产折叠核心；与 m9-verify §2 同源）
// ---------------------------------------------------------------------------

const ESTABLISHED = {
  attributionOrigin: 'RECORDED',
  contentOriginator: { state: 'KNOWN', value: { kind: 'USER', id: USER } },
  axisBConfirmed: true,
}

interface EvidenceRow {
  id: string
  characterId: string
  sequence: number
  type: string
  actorId?: string
  conversationId?: string
  trustedOrigin?: unknown
}
const evidenceRows = new Map<string, EvidenceRow>()
const addUserEvent = (
  id: string,
  sequence: number,
  conversationId: string,
  overrides: Partial<EvidenceRow> = {},
): void => {
  evidenceRows.set(id, {
    id,
    characterId: String(CHARACTER),
    sequence,
    type: 'user_message',
    actorId: String(USER),
    conversationId,
    trustedOrigin: ESTABLISHED,
    ...overrides,
  })
}

interface MemoryFixture {
  id: string
  ownerId: string
  type: string
  authority: string
  epistemicStatus: string
  status: string
  content: MemoryContent
  evidenceRootIds: string[]
}
const memoryRows = new Map<string, MemoryFixture>()
function claimMemory(id: string, value: string, rootId: string, overrides: Partial<MemoryFixture> = {}): MemoryFixture {
  const fixture: MemoryFixture = {
    id,
    ownerId: String(CHARACTER),
    type: 'preference',
    authority: 'EXPLICIT_USER_STATEMENT',
    epistemicStatus: 'reported',
    status: 'active',
    content: {
      kind: 'claim',
      subject: SUBJECT,
      predicate: PREDICATE,
      value,
      qualifiers: { context: 'technical' },
    },
    evidenceRootIds: [rootId],
    ...overrides,
  }
  memoryRows.set(id, fixture)
  return fixture
}

const modelCache = new Map<string, RowCacheEntry>()
const modelProcessed = new Set<string>()
const modelRetracted: DomainEvent[] = []
let domainSequence = 0
function nextDomainSequence(): number {
  domainSequence += 1
  return domainSequence
}
function domainEventOf(type: string, payload: unknown, unit: string): DomainEvent {
  return {
    id: `de:m9i:${String(nextDomainSequence())}` as DomainEvent['id'],
    characterId: CHARACTER,
    sequence: nextDomainSequence(),
    type,
    sourceConversationEventIds: [],
    payload,
    processor: PROCESSOR,
    processorVersion: PROCESSOR_VERSION,
    idempotencyKey: `gate:${unit}`,
    schemaVersion: 1,
    createdAt: NOW,
  }
}

/** 提案 → 放行口 → 折进模型；返回 (accepted, codes) */
async function applyProposal(
  deps: BeliefValidatorDeps,
  proposal: DomainProposal,
): Promise<{ accepted: boolean; codes: string[]; events: DomainEvent[] }> {
  const outcome = await validateBeliefProposal(deps, proposal)
  const events: DomainEvent[] = []
  for (const accepted of outcome.acceptedEvents) {
    const unit = unitOf(accepted)
    const key = idempotencyKeyForBeliefEvent({
      characterId: CHARACTER,
      processor: accepted.processor,
      processorVersion: accepted.processorVersion,
      operation: 'create',
      unit,
    })
    modelProcessed.add(key)
    const event = domainEventOf(accepted.type, accepted.payload, unit)
    events.push(event)
    foldBeliefRows(modelCache, [event])
    if (event.type === BELIEF_RETRACTED) modelRetracted.push(event)
  }
  return {
    accepted: outcome.accepted,
    codes: outcome.rejected.map((r) => r.code),
    events,
  }
}

function unitOf(accepted: AcceptedDomainEvent): string {
  const payload = accepted.payload as Record<string, unknown>
  switch (accepted.type) {
    case BELIEF_ORIGIN:
      return beliefOriginUnitOperation()
    case BELIEF_EVIDENCE_NOTED:
      return beliefEvidenceUnitOperation(payload.rootEventId as never, String(payload.ruleId))
    case BELIEF_FORMED:
      return beliefFormedUnitOperation(payload.beliefId as never)
    case BELIEF_DISPUTED:
      return beliefDisputedUnitOperation(payload.beliefId as never)
    case BELIEF_SUPERSEDED:
      return beliefSupersededUnitOperation(payload.oldBeliefId as never, payload.newBeliefId as never)
    case BELIEF_RETRACTED:
      return beliefRetractedUnitOperation(payload.beliefId as never)
    default:
      return 'unknown'
  }
}

function proposalOf(type: string, payload: unknown, processor = PROCESSOR): DomainProposal {
  return {
    proposalId: `p-${String(checks.length + 1)}`,
    characterId: CHARACTER,
    processor,
    processorVersion: PROCESSOR_VERSION,
    sourceConversationEventIds: [],
    targetEvents: [{ type, operation: 'create', payload }],
  } as unknown as DomainProposal
}

function originPayload(cutoverSequence: number): BeliefOriginPayload {
  return {
    characterId: CHARACTER,
    activationId: 'm9-wp5-gate-activation',
    cutoverSequence,
    cutoverAt: NOW,
    policyVersion: 'belief-evidence-policy@1',
  }
}

function notedPayload(rootId: string, rootSequence: number, conversationId: string): Record<string, unknown> {
  return {
    characterId: CHARACTER,
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: SCOPE,
    value: 'detailed',
    rootEventId: asConversationEventId(rootId),
    rootSequence,
    conversationId,
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
}

function inferredFormedPayload(beliefId: string, roots: string[], rootSequences: number[]): Record<string, unknown> {
  return {
    characterId: CHARACTER,
    beliefId,
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    proposition: { predicate: PREDICATE, value: 'detailed', scopeKey: SCOPE },
    epistemicKind: 'inferred',
    supportLevel: 'tentative',
    evidenceRootIds: roots.map((r) => asConversationEventId(r)),
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
}

function modelBelief(beliefId: string): BeliefState | undefined {
  return modelCache.get(beliefRowKeyOf(beliefId))?.state as BeliefState | undefined
}

function modelBeliefs(): BeliefState[] {
  const out: BeliefState[] = []
  for (const [key, entry] of modelCache) {
    if (
      key.startsWith('belief:') &&
      !key.startsWith('belief:evidence:') &&
      key !== beliefOriginRowKey()
    ) {
      out.push(entry.state as BeliefState)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 合成 deps（validator / revision / eligibility / reconciler 四面同源读模型）
// ---------------------------------------------------------------------------

const stateLookup: BeliefStateLookup = {
  async getBeliefOrigin(characterId) {
    void characterId
    return (
      (modelCache.get(beliefOriginRowKey())?.state as BeliefOriginState | undefined) ?? undefined
    )
  },
  async getBelief(characterId, beliefId) {
    void characterId
    return modelBelief(String(beliefId))
  },
  async listActiveBeliefsForSlot(characterId, slotKey) {
    void characterId
    return modelBeliefs().filter(
      (b) =>
        b.status === 'active' &&
        beliefSlotKeyOf({
          perspectiveOwnerId: b.perspectiveOwnerId,
          subject: b.subject,
          predicate: b.proposition.predicate,
          scopeKey: b.proposition.scopeKey,
        }) === slotKey,
    )
  },
  async forbiddenRootsForSlot(characterId, slotKey) {
    void characterId
    const roots: string[] = []
    for (const event of modelRetracted) {
      const payload = event.payload as BeliefRetractedPayload
      const belief = modelBelief(String(payload.beliefId))
      if (belief === undefined) continue
      const slot = beliefSlotKeyOf({
        perspectiveOwnerId: belief.perspectiveOwnerId,
        subject: belief.subject,
        predicate: belief.proposition.predicate,
        scopeKey: belief.proposition.scopeKey,
      })
      if (slot !== slotKey) continue
      for (const root of payload.forbiddenRootIds ?? []) roots.push(String(root))
    }
    return roots
  },
}

const memoryLookup: BeliefValidatorDeps['memory'] = {
  async findMemories(ids: readonly string[]) {
    return [...memoryRows.values()]
      .filter((m) => ids.some((id) => String(id) === m.id))
      .map((m) => ({
        id: m.id as never,
        ownerId: m.ownerId,
        type: m.type as never,
        authority: m.authority as never,
        epistemicStatus: m.epistemicStatus,
        status: m.status,
      }))
  },
}

const evidenceLookup: BeliefValidatorDeps['evidence'] = {
  async findEvents(ids: readonly (string | number)[]) {
    return [...evidenceRows.values()]
      .filter((e) => ids.some((id) => String(id) === e.id))
      .map((e) => ({
        id: e.id as never,
        characterId: e.characterId as never,
        sequence: e.sequence,
        type: e.type,
        actorId: e.actorId,
        conversationId: e.conversationId,
        trustedOrigin: e.trustedOrigin as never,
      }))
  },
}

const validatorDeps: BeliefValidatorDeps = {
  registry: createBeliefDomainEventRegistry(),
  evidence: evidenceLookup,
  processed: {
    async hasProcessed(key: string) {
      return modelProcessed.has(key)
    },
  },
  belief: stateLookup,
  memory: memoryLookup,
  policy: { activeUserId: String(USER) },
}

const revisionDeps: BeliefRevisionDeps = {
  characterId: String(CHARACTER),
  processor: PROCESSOR,
  processorVersion: PROCESSOR_VERSION,
  now: () => NOW,
  belief: {
    async listActiveBeliefs(characterId) {
      void characterId
      return modelBeliefs().filter((b) => b.status === 'active')
    },
    async listActiveBeliefsForSlot(characterId, slotKey) {
      return stateLookup.listActiveBeliefsForSlot(characterId as never, slotKey)
    },
    async getBelief(characterId, beliefId) {
      return stateLookup.getBelief(characterId as never, beliefId as never)
    },
  },
}

const eligibilityDeps: BeliefEligibilityDeps = {
  characterId: String(CHARACTER),
  evidence: validatorDeps.evidence as never,
  memory: memoryLookup as never,
  origin: {
    async getBeliefOrigin(characterId: string) {
      return stateLookup.getBeliefOrigin(characterId as never)
    },
  },
  policy: { activeUserId: String(USER) },
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 证据根：m1..m3（reported 溯源）+ i1..i6（inferred 阈值）+ 新根 n1..n3（B31）
  addUserEvent('m1', 101, 'conv-a')
  addUserEvent('m2', 105, 'conv-b')
  addUserEvent('m3', 110, 'conv-c')
  addUserEvent('i1', 111, 'conv-a')
  addUserEvent('i2', 115, 'conv-b')
  addUserEvent('i3', 120, 'conv-c')
  addUserEvent('n1', 200, 'conv-x')
  addUserEvent('n2', 205, 'conv-y')
  addUserEvent('n3', 210, 'conv-z')

  // =========================================================================
  // §1 B-REPORTED reconciler（白名单形成路径）
  // =========================================================================
  section('§1 B-REPORTED reconciler')

  // 建档 + inferred 信念 i-b1（§3/§4 的被测对象）
  await applyProposal(validatorDeps, proposalOf(BELIEF_ORIGIN, originPayload(100)))
  for (const [root, seq, conv] of [
    ['i1', 111, 'conv-a'],
    ['i2', 115, 'conv-b'],
    ['i3', 120, 'conv-c'],
  ] as const) {
    await applyProposal(
      validatorDeps,
      proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload(root, seq, conv)),
    )
  }
  const inferredId = String(makeBeliefId(CHARACTER, SLOT_KEY, '120'))
  const formed1 = await applyProposal(
    validatorDeps,
    proposalOf(BELIEF_FORMED, inferredFormedPayload(inferredId, ['i1', 'i2', 'i3'], [111, 115, 120])),
  )
  check(
    's1-00',
    '前置：inferred 信念形成（§3/§4 的被测对象）',
    formed1.accepted && modelBelief(inferredId)?.status === 'active',
    `accepted=${String(formed1.accepted)} status=${String(modelBelief(inferredId)?.status)}`,
  )

  // 合格 claim 记忆 → reconciler 提案 → 放行口接受
  const memGood = claimMemory('mem:good', 'concise', 'm1')
  const reportedSlot = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: beliefReportedScopeKeyOf({ context: 'technical' }),
  })
  const rec1 = await reconcileMemoryWindow(
    {
      characterId: String(CHARACTER),
      processor: 'belief-memory-reconciler',
      processorVersion: 'belief-reconciler@1',
      memory: {
        async findMemories(ids) {
          return [...memoryRows.values()]
            .filter((m) => ids.some((id) => String(id) === m.id))
            .map((m) => m as unknown as ReconcilerMemoryView)
        },
      },
      belief: {
        async listActiveBeliefsForSlot(characterId, slotKey) {
          return stateLookup.listActiveBeliefsForSlot(characterId as never, slotKey)
        },
      },
    },
    [{ type: 'MEMORY_CREATED', memoryId: memGood.id, sequence: 1 }],
  )
  const reportedId = String(
    makeBeliefId(CHARACTER, reportedSlot, beliefReportedFormationKeyOf([memGood.id as never])),
  )
  check(
    's1-01',
    '合格 claim → 恰一条 FORMED(reported) 提案（beliefId = 依赖哈希复推）',
    rec1.formedProposals.length === 1 &&
      String(
        (rec1.formedProposals[0]?.targetEvents[0]?.payload as BeliefFormedPayload).beliefId,
      ) === reportedId,
    `proposals=${String(rec1.formedProposals.length)} id=${String(
      (rec1.formedProposals[0]?.targetEvents[0]?.payload as BeliefFormedPayload | undefined)?.beliefId,
    )}`,
  )
  const rep1 = await applyProposal(validatorDeps, rec1.formedProposals[0] as DomainProposal)
  check(
    's1-02',
    '放行口接受 reported FORMED（Memory 白名单复核通过）',
    rep1.accepted && modelBelief(reportedId)?.status === 'active',
    `accepted=${String(rep1.accepted)} codes=${rep1.codes.join(',')} status=${String(
      modelBelief(reportedId)?.status,
    )}`,
  )
  check(
    's1-03',
    'reported 信念携带 Memory 依赖 + 溯源根（dependsOnMemoryIds=[mem:good] · roots=[m1]）',
    modelBelief(reportedId)?.dependsOnMemoryIds.length === 1 &&
      String(modelBelief(reportedId)?.dependsOnMemoryIds[0]) === memGood.id &&
      modelBelief(reportedId)?.evidenceRootIds.length === 1,
    `deps=${String(modelBelief(reportedId)?.dependsOnMemoryIds.length)} roots=${String(
      modelBelief(reportedId)?.evidenceRootIds.length,
    )}`,
  )

  // 不合格变体：episode 家族 / 非白名单权威档 / 已撤回 —— 零提案
  const memEpisode = claimMemory('mem:episode', 'concise', 'm2', {
    type: 'episode',
    content: { kind: 'episode', summary: '经历', participants: [SUBJECT], eventRefs: ['m2'] },
  })
  const memObserved = claimMemory('mem:observed', 'concise', 'm3', {
    epistemicStatus: 'observed',
  })
  const memRetracted = claimMemory('mem:retracted', 'concise', 'm1', { status: 'retracted' })
  const rec2 = await reconcileMemoryWindow(
    {
      characterId: String(CHARACTER),
      processor: 'belief-memory-reconciler',
      processorVersion: 'belief-reconciler@1',
      memory: {
        async findMemories(ids) {
          return [...memoryRows.values()]
            .filter((m) => ids.some((id) => String(id) === m.id))
            .map((m) => m as unknown as ReconcilerMemoryView)
        },
      },
      belief: {
        async listActiveBeliefsForSlot(characterId, slotKey) {
          return stateLookup.listActiveBeliefsForSlot(characterId as never, slotKey)
        },
      },
    },
    [
      { type: 'MEMORY_CREATED', memoryId: memEpisode.id, sequence: 2 },
      { type: 'MEMORY_CREATED', memoryId: memObserved.id, sequence: 3 },
      { type: 'MEMORY_CREATED', memoryId: memRetracted.id, sequence: 4 },
    ],
  )
  check(
    's1-04',
    '白名单外（episode / observed / retracted）⇒ 零提案、逐条 skip 理由',
    rec2.formedProposals.length === 0 &&
      rec2.skipped.length === 3 &&
      rec2.skipped.every((s) => s.reason === 'not_eligible' || s.reason === 'not_claim_content'),
    `proposals=${String(rec2.formedProposals.length)} skipped=${rec2.skipped
      .map((s) => `${s.memoryId}:${s.reason}`)
      .join(' ')}`,
  )

  // 同 Memory 重扫：同 beliefId ⇒ 幂等键撞车（duplicate_operation）
  const rec3 = await reconcileMemoryWindow(
    {
      characterId: String(CHARACTER),
      processor: 'belief-memory-reconciler',
      processorVersion: 'belief-reconciler@1',
      memory: {
        async findMemories(ids) {
          return [...memoryRows.values()]
            .filter((m) => ids.some((id) => String(id) === m.id))
            .map((m) => m as unknown as ReconcilerMemoryView)
        },
      },
      belief: {
        async listActiveBeliefsForSlot(characterId, slotKey) {
          return stateLookup.listActiveBeliefsForSlot(characterId as never, slotKey)
        },
      },
    },
    [{ type: 'MEMORY_CREATED', memoryId: memGood.id, sequence: 5 }],
  )
  check(
    's1-05',
    '同 Memory 重扫 ⇒ reconciler 同值预检短路（零提案，skip slot_same_value_active）',
    rec3.formedProposals.length === 0 &&
      rec3.skipped.length === 1 &&
      rec3.skipped[0]?.reason === 'slot_same_value_active',
    `proposals=${String(rec3.formedProposals.length)} skipped=${rec3.skipped
      .map((s) => `${s.memoryId}:${s.reason}`)
      .join(' ')}`,
  )
  // 幂等层独立验证：绕过预检重交同一提案（同 processor 同单元）⇒ duplicate_operation
  const replayReported = await applyProposal(
    validatorDeps,
    rec1.formedProposals[0] as DomainProposal,
  )
  check(
    's1-05b',
    '同提案重交 ⇒ duplicate_operation（幂等键层与 reconciler 预检互为独立防线）',
    !replayReported.accepted && replayReported.codes.includes('duplicate_operation'),
    `codes=${replayReported.codes.join(',')}`,
  )

  // 放行口负控：端口缺失 / 记忆缺失 / 白名单外 / beliefId 不可复推
  const noPortDeps: BeliefValidatorDeps = { ...validatorDeps, memory: undefined }
  const memFresh = claimMemory('mem:fresh', 'concise', 'm2')
  const freshSlot = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: beliefReportedScopeKeyOf({ context: 'technical' }),
  })
  const freshId = String(
    makeBeliefId(CHARACTER, freshSlot, beliefReportedFormationKeyOf([memFresh.id as never])),
  )
  const reportedPayloadOf = (beliefId: string, memoryIds: string[]): unknown => ({
    characterId: CHARACTER,
    beliefId,
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    proposition: { predicate: PREDICATE, value: 'concise', scopeKey: 'q:deadbeef' },
    epistemicKind: 'reported',
    supportLevel: 'tentative',
    evidenceRootIds: [asConversationEventId('m2')],
    dependsOnMemoryIds: memoryIds,
    ruleId: BELIEF_REPORTED_RULE_ID,
    ruleVersion: BELIEF_REPORTED_RULE_VERSION,
  })
  const negPort = await applyProposal(
    noPortDeps,
    proposalOf(BELIEF_FORMED, reportedPayloadOf(freshId, [memFresh.id]), 'm9-wp5-alt'),
  )
  check(
    's1-06',
    '负控：Memory 端口缺失 ⇒ belief_source_missing（失败关闭，不静默放行）',
    !negPort.accepted && negPort.codes.includes('belief_source_missing'),
    `codes=${negPort.codes.join(',')}`,
  )
  const negMissing = await applyProposal(
    validatorDeps,
    proposalOf(BELIEF_FORMED, reportedPayloadOf(freshId, ['mem:ghost']), 'm9-wp5-alt2'),
  )
  check(
    's1-07',
    '负控：依赖的 Memory 不存在 ⇒ belief_source_missing（断链失败关闭）',
    !negMissing.accepted && negMissing.codes.includes('belief_source_missing'),
    `codes=${negMissing.codes.join(',')}`,
  )
  const negIneligible = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      reportedPayloadOf(freshId, [memObserved.id]),
      'm9-wp5-alt3',
    ),
  )
  check(
    's1-08',
    '负控：白名单外 Memory ⇒ belief_source_unqualified（observed 不是 reported）',
    !negIneligible.accepted && negIneligible.codes.includes('belief_source_unqualified'),
    `codes=${negIneligible.codes.join(',')}`,
  )
  const negDerive = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      reportedPayloadOf('blf:not-derivable', [memFresh.id]),
      'm9-wp5-alt4',
    ),
  )
  check(
    's1-09',
    '负控：reported beliefId 不可复推 ⇒ belief_id_not_derivable',
    !negDerive.accepted && negDerive.codes.includes('belief_id_not_derivable'),
    `codes=${negDerive.codes.join(',')}`,
  )

  // =========================================================================
  // §2 依赖失效传播（Memory 撤回 → 写侧收敛 + 读侧遮蔽）
  // =========================================================================
  section('§2 依赖失效传播（Memory 撤回）')

  // 读侧先证：撤回前 usable
  const preVerdicts = await recheckBeliefDependencies(eligibilityDeps, [
    modelBelief(reportedId) as BeliefState,
  ])
  check(
    's2-01',
    '前置：撤回前读侧回查 usable（依赖白名单内）',
    preVerdicts.get(reportedId)?.usable === true,
    `verdict=${String(preVerdicts.get(reportedId)?.reason)}`,
  )

  // Memory 撤回 → planMemoryInvalidation → RETRACTED(dependency_invalidated)
  memGood.status = 'retracted'
  const plan1 = await planMemoryInvalidation(revisionDeps, { memoryId: memGood.id })
  const plan1Payload = plan1.kind === 'proposals'
    ? (plan1.proposals[0]?.targetEvents[0]?.payload as BeliefRetractedPayload)
    : undefined
  check(
    's2-02',
    'Memory 撤回 ⇒ 恰一条 RETRACTED 规划（dependency_invalidated，不禁根——B31 通道保留）',
    plan1.kind === 'proposals' &&
      plan1.proposals.length === 1 &&
      plan1Payload?.reason === 'dependency_invalidated' &&
      (plan1Payload?.forbiddenRootIds ?? []).length === 0,
    `kind=${plan1.kind} n=${String(plan1.kind === 'proposals' ? plan1.proposals.length : -1)} forbidden=${String((plan1Payload?.forbiddenRootIds ?? []).length)}`,
  )
  const inv1 = await applyProposal(validatorDeps, plan1.kind === 'proposals' ? plan1.proposals[0] as DomainProposal : proposalOf(BELIEF_ORIGIN, originPayload(999)))
  check(
    's2-03',
    '放行口接受失效撤回；信念 retracted（写侧收敛）',
    inv1.accepted && modelBelief(reportedId)?.status === 'retracted',
    `accepted=${String(inv1.accepted)} status=${String(modelBelief(reportedId)?.status)}`,
  )

  // 读侧同判失效（写侧已收敛的场合）
  const postVerdicts = await recheckBeliefDependencies(eligibilityDeps, [
    modelBelief(reportedId) as BeliefState,
  ])
  check(
    's2-04',
    '读侧回查同判失效（memory_not_qualified——撤回的 Memory 不能背书）',
    postVerdicts.get(reportedId)?.usable === false &&
      postVerdicts.get(reportedId)?.reason === 'memory_not_qualified',
    `verdict=${String(postVerdicts.get(reportedId)?.reason)}`,
  )

  // overlay：写侧**未**收敛（不 apply）时同轮遮蔽
  const memSecond = claimMemory('mem:second', 'bulky', 'm3')
  const secondSlot = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: beliefReportedScopeKeyOf({ context: 'technical' }),
  })
  const secondId = String(
    makeBeliefId(CHARACTER, secondSlot, beliefReportedFormationKeyOf([memSecond.id as never])),
  )
  const recSecond = await reconcileMemoryWindow(
    {
      characterId: String(CHARACTER),
      processor: 'belief-memory-reconciler',
      processorVersion: 'belief-reconciler@1',
      memory: {
        async findMemories(ids) {
          return [...memoryRows.values()]
            .filter((m) => ids.some((id) => String(id) === m.id))
            .map((m) => m as unknown as ReconcilerMemoryView)
        },
      },
      belief: {
        async listActiveBeliefsForSlot(characterId, slotKey) {
          return stateLookup.listActiveBeliefsForSlot(characterId as never, slotKey)
        },
      },
    },
    [{ type: 'MEMORY_CREATED', memoryId: memSecond.id, sequence: 6 }],
  )
  const secondForm = await applyProposal(
    validatorDeps,
    recSecond.formedProposals[0] as DomainProposal,
  )
  // 注意：value 'bulky' 与 'concise' 异值 ⇒ 同槽位并存（冲突信号，照放）
  const beforeOverlay = await recheckBeliefDependencies(eligibilityDeps, [
    modelBelief(secondId) as BeliefState,
  ])
  const overlaid = applyInvalidationOverlay(
    beforeOverlay,
    [modelBelief(secondId) as BeliefState],
    { invalidatedMemoryIds: [memSecond.id] },
  )
  check(
    's2-05',
    '同轮 overlay：写侧修订未跑 ⇒ 读侧仍遮蔽（overlaid；零泄漏不依赖写侧成功）',
    secondForm.accepted &&
      beforeOverlay.get(secondId)?.usable === true &&
      overlaid.get(secondId)?.usable === false &&
      overlaid.get(secondId)?.reason === 'overlaid',
    `form=${String(secondForm.accepted)} before=${String(beforeOverlay.get(secondId)?.reason)} after=${String(overlaid.get(secondId)?.reason)}`,
  )

  // 查找抛错 ⇒ unavailable（失败关闭：读不到 = 不能用）
  const brokenDeps: BeliefEligibilityDeps = {
    ...eligibilityDeps,
    memory: {
      async findMemories() {
        throw new Error('storage down')
      },
    },
  }
  const unavailable = await recheckBeliefDependencies(brokenDeps, [
    modelBelief(secondId) as BeliefState,
  ])
  check(
    's2-06',
    '回查存储错误 ⇒ unavailable（失败关闭，不当 valid 也不当不存在）',
    unavailable.get(secondId)?.usable === false &&
      unavailable.get(secondId)?.reason === 'unavailable',
    `verdict=${String(unavailable.get(secondId)?.reason)}`,
  )

  // =========================================================================
  // §3 qualified→unqualified（根失效传播）
  // =========================================================================
  section('§3 qualified→unqualified（根失效）')

  // 归因重读降档：i2 的信封丢失 ⇒ 资格四条不过
  const i2 = evidenceRows.get('i2') as EvidenceRow
  i2.trustedOrigin = undefined
  const rootVerdicts = await recheckBeliefDependencies(eligibilityDeps, [
    modelBelief(inferredId) as BeliefState,
  ])
  check(
    's3-01',
    '根降档 ⇒ 读侧回查排除（root_unqualified）',
    rootVerdicts.get(inferredId)?.usable === false &&
      rootVerdicts.get(inferredId)?.reason === 'root_unqualified',
    `verdict=${String(rootVerdicts.get(inferredId)?.reason)}`,
  )

  // planRootInvalidation → RETRACTED(dependency_invalidated, forbidden=[i2])
  const plan2 = await planRootInvalidation(revisionDeps, { rootId: 'i2' })
  const rootRetractPayload = plan2.kind === 'proposals'
    ? (plan2.proposals[0]?.targetEvents[0]?.payload as BeliefRetractedPayload)
    : undefined
  check(
    's3-02',
    '根失效规划：RETRACTED(dependency_invalidated) + forbidden=[该根]（§5.4）',
    plan2.kind === 'proposals' &&
      plan2.proposals.length === 1 &&
      rootRetractPayload?.reason === 'dependency_invalidated' &&
      (rootRetractPayload?.forbiddenRootIds ?? []).length === 1 &&
      String(rootRetractPayload?.forbiddenRootIds?.[0]) === 'i2',
    `kind=${plan2.kind}`,
  )
  const inv2 = await applyProposal(
    validatorDeps,
    plan2.kind === 'proposals' ? plan2.proposals[0] as DomainProposal : proposalOf(BELIEF_ORIGIN, originPayload(998)),
  )
  check(
    's3-03',
    '放行口接受根失效撤回；inferred 信念 retracted',
    inv2.accepted && modelBelief(inferredId)?.status === 'retracted',
    `accepted=${String(inv2.accepted)} status=${String(modelBelief(inferredId)?.status)}`,
  )

  // 双层防御演示：失效根 i2 混新根再喂新形成
  // 第一层（资格四条）：i2 降档中 ⇒ belief_source_unqualified
  const forbiddenNow = await stateLookup.forbiddenRootsForSlot(CHARACTER, SLOT_KEY)
  const reformPayload = inferredFormedPayload(
    String(makeBeliefId(CHARACTER, SLOT_KEY, '205')),
    ['i2', 'n1', 'n2'],
    [115, 200, 205],
  )
  const reform = await applyProposal(
    validatorDeps,
    proposalOf(BELIEF_FORMED, reformPayload, 'm9-wp5-alt5'),
  )
  check(
    's3-04',
    '第一层：降档根再喂新形成 ⇒ belief_source_unqualified（资格四条先挡）',
    forbiddenNow.includes('i2') &&
      !reform.accepted &&
      reform.codes.includes('belief_source_unqualified'),
    `forbidden=[${forbiddenNow.join(',')}] codes=${reform.codes.join(',')}`,
  )
  // 第二层（§5.4 禁用承诺）：资格复评恢复（信封回来了）⇒ 禁用根仍拦
  i2.trustedOrigin = ESTABLISHED
  const reform2 = await applyProposal(
    validatorDeps,
    proposalOf(BELIEF_FORMED, reformPayload, 'm9-wp5-alt5b'),
  )
  check(
    's3-05',
    '第二层：资格复评恢复后 ⇒ belief_roots_forbidden（禁用是事件流承诺，不随资格波动）',
    !reform2.accepted && reform2.codes.includes('belief_roots_forbidden'),
    `codes=${reform2.codes.join(',')}`,
  )

  // =========================================================================
  // §4 显式遗忘 / 纠正 / 争议（B28/B29/B31）
  // =========================================================================
  section('§4 显式遗忘 / 纠正 / 争议')

  // 新 inferred 信念（新根 n1..n3，conv-x/y/z）——遗忘对象
  for (const [root, seq, conv] of [
    ['n1', 200, 'conv-x'],
    ['n2', 205, 'conv-y'],
    ['n3', 210, 'conv-z'],
  ] as const) {
    await applyProposal(
      validatorDeps,
      proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload(root, seq, conv)),
    )
  }
  const forgetTargetId = String(makeBeliefId(CHARACTER, SLOT_KEY, '210'))
  const formedTarget = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      inferredFormedPayload(forgetTargetId, ['n1', 'n2', 'n3'], [200, 205, 210]),
    ),
  )
  check(
    's4-00',
    '前置：新根新 inferred 信念形成（B31 的"新 identity"面）',
    formedTarget.accepted && modelBelief(forgetTargetId)?.status === 'active',
    `accepted=${String(formedTarget.accepted)}`,
  )

  // B28：唯一目标遗忘 → 禁全部根
  const forgetPlan = await planBeliefForget(revisionDeps, { slotKey: SLOT_KEY })
  const forgetPayload = forgetPlan.kind === 'proposals'
    ? (forgetPlan.proposals[0]?.targetEvents[0]?.payload as BeliefRetractedPayload)
    : undefined
  check(
    's4-01',
    '唯一目标遗忘 ⇒ RETRACTED(user_forget_request) + forbidden=全部根（B28）',
    forgetPlan.kind === 'proposals' &&
      forgetPayload?.reason === 'user_forget_request' &&
      (forgetPayload?.forbiddenRootIds ?? []).length === 3,
    `kind=${forgetPlan.kind} forbidden=${String((forgetPayload?.forbiddenRootIds ?? []).length)}`,
  )
  const forget1 = await applyProposal(
    validatorDeps,
    forgetPlan.kind === 'proposals' ? forgetPlan.proposals[0] as DomainProposal : proposalOf(BELIEF_ORIGIN, originPayload(997)),
  )
  check(
    's4-02',
    '放行口接受遗忘撤回；目标 retracted',
    forget1.accepted && modelBelief(forgetTargetId)?.status === 'retracted',
    `accepted=${String(forget1.accepted)} status=${String(modelBelief(forgetTargetId)?.status)}`,
  )

  // B28 硬规则：forget 不带禁用根 ⇒ 放行口拒
  const bareForget = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_RETRACTED,
      {
        characterId: CHARACTER,
        beliefId: secondId,
        reason: 'user_forget_request',
        ruleId: BELIEF_REVISION_RULE_ID,
        ruleVersion: 'belief-revision-rules@1',
      },
      'm9-wp5-alt6',
    ),
  )
  check(
    's4-03',
    '负控：forget 不带禁用根 ⇒ belief_forbidden_roots_invalid（遗忘不禁根 = 复活后门）',
    !bareForget.accepted && bareForget.codes.includes('belief_forbidden_roots_invalid'),
    `codes=${bareForget.codes.join(',')}`,
  )

  // B31 前置：新根 f1..f3 先记待累计（形成放复活尝试之后——同值 active 会
  // 先撞 belief_slot_already_active，遮住禁用根检查）
  addUserEvent('f1', 300, 'conv-p')
  addUserEvent('f2', 305, 'conv-q')
  addUserEvent('f3', 310, 'conv-r')
  for (const [root, seq, conv] of [
    ['f1', 300, 'conv-p'],
    ['f2', 305, 'conv-q'],
    ['f3', 310, 'conv-r'],
  ] as const) {
    await applyProposal(
      validatorDeps,
      proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload(root, seq, conv)),
    )
  }

  // B28：复活尝试——旧禁用根混新根（[n1,f1,f2]，beliefId 按 max seq '305' 复推，
  // 新 id ⇒ 新幂等单元 ⇒ 一路走到禁用根检查；此刻槽位无同值 active）
  const resurrect = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      inferredFormedPayload(
        String(makeBeliefId(CHARACTER, SLOT_KEY, '305')),
        ['n1', 'f1', 'f2'],
        [200, 300, 305],
      ),
      'm9-wp5-alt7',
    ),
  )
  check(
    's4-04',
    'B28：旧禁用根混新根的复活尝试 ⇒ belief_roots_forbidden（retracted ≠ 可再形成）',
    !resurrect.accepted && resurrect.codes.includes('belief_roots_forbidden'),
    `codes=${resurrect.codes.join(',')}`,
  )

  // B31：遗忘后新显式授权（新根 f1..f3，不交禁用集）⇒ 新 identity 形成
  const newIdentityId = String(makeBeliefId(CHARACTER, SLOT_KEY, '310'))
  const newIdentity = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      inferredFormedPayload(newIdentityId, ['f1', 'f2', 'f3'], [300, 305, 310]),
    ),
  )
  check(
    's4-05',
    'B31：新根新显式互动 ⇒ 新 belief identity 形成（旧根不补足阈值）',
    newIdentity.accepted &&
      newIdentityId !== forgetTargetId &&
      modelBelief(newIdentityId)?.status === 'active',
    `accepted=${String(newIdentity.accepted)} id=${newIdentityId}`,
  )

  // B29：歧义目标（同槽位两条 active：新 identity + second? second 是 reported 槽位不同）——
  // 构造歧义：再形成一条同槽位异值 inferred（f4..f6, value concise）
  addUserEvent('f4', 320, 'conv-p')
  addUserEvent('f5', 325, 'conv-q')
  addUserEvent('f6', 330, 'conv-r')
  for (const [root, seq, conv] of [
    ['f4', 320, 'conv-p'],
    ['f5', 325, 'conv-q'],
    ['f6', 330, 'conv-r'],
  ] as const) {
    await applyProposal(
      validatorDeps,
      proposalOf(BELIEF_EVIDENCE_NOTED, { ...notedPayload(root, seq, conv), value: 'concise' }),
    )
  }
  const conflictId = String(makeBeliefId(CHARACTER, SLOT_KEY, '330'))
  const conflictForm = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      {
        ...inferredFormedPayload(conflictId, ['f4', 'f5', 'f6'], [320, 325, 330]),
        proposition: { predicate: PREDICATE, value: 'concise', scopeKey: SCOPE },
      } as never,
    ),
  )
  const ambiguousForget = await planBeliefForget(revisionDeps, { slotKey: SLOT_KEY })
  check(
    's4-06',
    'B29：同槽位两条 active ⇒ clarify（零提案；调用方不得宣称已忘记）',
    conflictForm.accepted &&
      ambiguousForget.kind === 'clarify' &&
      ambiguousForget.reason === 'ambiguous_target' &&
      ambiguousForget.candidates.length === 2,
    `form=${String(conflictForm.accepted)} kind=${ambiguousForget.kind} candidates=${String(
      ambiguousForget.kind === 'clarify' ? ambiguousForget.candidates.length : -1,
    )}`,
  )

  // 争议登记：两条 active ⇒ 两条 DISPUTED（保留两侧）
  const disputePlan = await planBeliefDispute(revisionDeps, { slotKey: SLOT_KEY })
  const disputeResult =
    disputePlan.kind === 'proposals'
      ? await applyProposal(validatorDeps, disputePlan.proposals[0] as DomainProposal)
      : { accepted: false, codes: [], events: [] }
  const disputeResult2 =
    disputePlan.kind === 'proposals' && disputePlan.proposals[1] !== undefined
      ? await applyProposal(validatorDeps, disputePlan.proposals[1] as DomainProposal)
      : { accepted: false, codes: [], events: [] }
  check(
    's4-07',
    '争议登记：两条 DISPUTED 提案全过；两侧都 disputed（不猜谁对）',
    disputePlan.kind === 'proposals' &&
      disputePlan.proposals.length === 2 &&
      disputeResult.accepted &&
      disputeResult2.accepted &&
      modelBelief(newIdentityId)?.status === 'disputed' &&
      modelBelief(conflictId)?.status === 'disputed',
    `plan=${disputePlan.kind} a=${String(disputeResult.accepted)} b=${String(disputeResult2.accepted)}`,
  )

  // 纠正：disputed 的旧条被新值取代（新值先形成——reported second 仍在别的槽位，
  // 这里用 f7..f9 的 corrected 值先形成，再 supersede dispute 侧之一）
  addUserEvent('f7', 340, 'conv-p')
  addUserEvent('f8', 345, 'conv-q')
  addUserEvent('f9', 350, 'conv-r')
  for (const [root, seq, conv] of [
    ['f7', 340, 'conv-p'],
    ['f8', 345, 'conv-q'],
    ['f9', 350, 'conv-r'],
  ] as const) {
    await applyProposal(
      validatorDeps,
      proposalOf(BELIEF_EVIDENCE_NOTED, { ...notedPayload(root, seq, conv), value: 'concise' }),
    )
  }
  const correctedId = String(makeBeliefId(CHARACTER, SLOT_KEY, '350'))
  const correctedForm = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      {
        ...inferredFormedPayload(correctedId, ['f7', 'f8', 'f9'], [340, 345, 350]),
        proposition: { predicate: PREDICATE, value: 'concise', scopeKey: SCOPE },
      } as never,
    ),
  )
  const correctPlan = await planBeliefCorrection(revisionDeps, {
    slotKey: SLOT_KEY,
    newBeliefId: correctedId,
  })
  // 争议已把两条旧值标 disputed ⇒ 无 active 旧侧 ⇒ noop（诚实：没有可取代者；
  // disputed 侧的处置走下面的显式 SUPERSEDED——§6.3 的"对原项的显式处置"）
  check(
    's4-08',
    '纠正规划：旧侧全 disputed ⇒ noop（不猜、不抢跑；处置走显式链）',
    correctedForm.accepted && correctPlan.kind === 'noop',
    `form=${String(correctedForm.accepted)} plan=${correctPlan.kind} reason=${correctPlan.kind === 'noop' ? correctPlan.reason : '?'}`,
  )
  // 显式指定被取代者 ⇒ SUPERSEDED（disputed → superseded 合法迁移）
  const supersedeDirect = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_SUPERSEDED,
      {
        characterId: CHARACTER,
        oldBeliefId: conflictId,
        newBeliefId: correctedId,
        reason: 'user_correction',
        validTo: NOW,
        ruleId: BELIEF_REVISION_RULE_ID,
        ruleVersion: 'belief-revision-rules@1',
      },
      'm9-wp5-alt8',
    ),
  )
  check(
    's4-09',
    '显式取代：disputed 旧条 → superseded（保留因果链；不 newest-wins 覆盖）',
    supersedeDirect.accepted && modelBelief(conflictId)?.status === 'superseded',
    `accepted=${String(supersedeDirect.accepted)} status=${String(modelBelief(conflictId)?.status)}`,
  )

  // 纠正规划的 proposals 路径：唯一 active 旧侧 ⇒ SUPERSEDED 提案全链
  addUserEvent('g1', 360, 'conv-s')
  addUserEvent('g2', 365, 'conv-t')
  addUserEvent('g3', 370, 'conv-u')
  for (const [root, seq, conv] of [
    ['g1', 360, 'conv-s'],
    ['g2', 365, 'conv-t'],
    ['g3', 370, 'conv-u'],
  ] as const) {
    await applyProposal(
      validatorDeps,
      proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload(root, seq, conv)),
    )
  }
  const finalId = String(makeBeliefId(CHARACTER, SLOT_KEY, '370'))
  const finalForm = await applyProposal(
    validatorDeps,
    proposalOf(
      BELIEF_FORMED,
      inferredFormedPayload(finalId, ['g1', 'g2', 'g3'], [360, 365, 370]),
    ),
  )
  const correctPlan2 = await planBeliefCorrection(revisionDeps, {
    slotKey: SLOT_KEY,
    newBeliefId: finalId,
  })
  const correctApply =
    correctPlan2.kind === 'proposals'
      ? await applyProposal(validatorDeps, correctPlan2.proposals[0] as DomainProposal)
      : { accepted: false, codes: [], events: [] }
  check(
    's4-10',
    '纠正规划 proposals 路径：唯一 active 旧侧 ⇒ SUPERSEDED 全链（corrected → final）',
    finalForm.accepted &&
      correctPlan2.kind === 'proposals' &&
      correctApply.accepted &&
      modelBelief(correctedId)?.status === 'superseded' &&
      modelBelief(finalId)?.status === 'active',
    `form=${String(finalForm.accepted)} plan=${correctPlan2.kind} apply=${String(correctApply.accepted)} corrected=${String(modelBelief(correctedId)?.status)}`,
  )

  // =========================================================================
  // §5 恢复快照 + 重复回放（B30；隔离库）
  // =========================================================================
  section('§5 恢复快照 + 重复回放（隔离库）')

  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db

  // 用 kernel.characterId 重建一套最小生命周期事件落库：
  // origin → 3 notes → formed → forget-retract（禁全部根）
  const dbOwner = kernel.characterId
  const dbSlot = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(dbOwner)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: SCOPE,
  })
  const dbBeliefId = String(makeBeliefId(dbOwner, dbSlot, '210'))
  const dbEvents: DomainEvent[] = []
  const pushDb = (type: string, payload: unknown, unit: string): void => {
    dbEvents.push({
      id: `de:m9db:${String(nextDomainSequence())}` as DomainEvent['id'],
      characterId: dbOwner,
      sequence: nextDomainSequence(),
      type,
      sourceConversationEventIds: [],
      payload,
      processor: PROCESSOR,
      processorVersion: PROCESSOR_VERSION,
      idempotencyKey: `gate:${unit}`,
      schemaVersion: 1,
      createdAt: NOW,
    })
  }
  pushDb(BELIEF_ORIGIN, { ...originPayload(100), characterId: dbOwner }, 'origin')
  for (const [root, seq, conv] of [
    ['n1', 200, 'conv-x'],
    ['n2', 205, 'conv-y'],
    ['n3', 210, 'conv-z'],
  ] as const) {
    pushDb(
      BELIEF_EVIDENCE_NOTED,
      {
        ...notedPayload(root, seq, conv),
        characterId: dbOwner,
        perspectiveOwnerId: asEntityId(String(dbOwner)),
      },
      `n-${root}`,
    )
  }
  pushDb(
    BELIEF_FORMED,
    {
      ...inferredFormedPayload(dbBeliefId, ['n1', 'n2', 'n3'], [200, 205, 210]),
      characterId: dbOwner,
      perspectiveOwnerId: asEntityId(String(dbOwner)),
    },
    `f-${dbBeliefId}`,
  )
  pushDb(
    BELIEF_RETRACTED,
    {
      characterId: dbOwner,
      beliefId: dbBeliefId,
      reason: 'user_forget_request',
      forbiddenRootIds: [asConversationEventId('n1'), asConversationEventId('n2'), asConversationEventId('n3')],
      ruleId: BELIEF_REVISION_RULE_ID,
      ruleVersion: 'belief-revision-rules@1',
    },
    `ret-${dbBeliefId}`,
  )

  // 落库（幂等键用领域单元推导——与生产同一形态）
  let appendedCount = 0
  for (const event of dbEvents) {
    const payload = event.payload as Record<string, unknown>
    let unit = 'unknown'
    if (event.type === BELIEF_ORIGIN) unit = beliefOriginUnitOperation()
    else if (event.type === BELIEF_EVIDENCE_NOTED)
      unit = beliefEvidenceUnitOperation(payload.rootEventId as never, String(payload.ruleId))
    else if (event.type === BELIEF_FORMED) unit = beliefFormedUnitOperation(payload.beliefId as never)
    else if (event.type === BELIEF_RETRACTED)
      unit = beliefRetractedUnitOperation(payload.beliefId as never)
    const accepted: AcceptedDomainEvent = {
      type: event.type,
      operation: 'create',
      payload: event.payload,
      sourceConversationEventIds: [],
      scope: DOMAIN_EVENT_SCOPE,
      idempotencyKey: idempotencyKeyForBeliefEvent({
        characterId: dbOwner,
        processor: event.processor,
        processorVersion: event.processorVersion,
        operation: 'create',
        unit,
      }),
      processor: event.processor,
      processorVersion: event.processorVersion,
    }
    const { created } = await appendDomainEvent(db, dbOwner, accepted, NOW)
    if (created) appendedCount += 1
  }
  const applied = await applyBeliefRows(db, dbOwner, dbEvents, NOW)
  check(
    's5-01',
    '落库 + 增量 apply：6 事件全折（origin/3 notes/formed/retract）',
    appendedCount === 6 && applied.appliedEvents === 6,
    `appended=${String(appendedCount)} applied=${String(applied.appliedEvents)}`,
  )

  const before = await getBelief(db, dbOwner, dbBeliefId)
  const forbiddenBefore = await forbiddenRootsForSlot(db, dbOwner, dbSlot)
  check(
    's5-02',
    '增量路径：retracted 已终态 + 禁用根在案（[n1,n2,n3]）',
    before?.state.status === 'retracted' && forbiddenBefore.join(',') === 'n1,n2,n3',
    `status=${String(before?.state.status)} forbidden=[${forbiddenBefore.join(',')}]`,
  )

  // 全量重建 ⇒ retracted 不复活、禁用根保留（B30：rebuild ≠ 恢复被禁内容）
  const rebuild = await rebuildBeliefProjections(db, dbOwner, NOW)
  const after = await getBelief(db, dbOwner, dbBeliefId)
  const forbiddenAfter = await forbiddenRootsForSlot(db, dbOwner, dbSlot)
  const activesAfter = await listActiveBeliefs(db, dbOwner)
  check(
    's5-03',
    'B30：全量 rebuild ⇒ retracted 不复活 + 禁用根保留 + 零 active',
    rebuild.appliedEvents === 6 &&
      after?.state.status === 'retracted' &&
      forbiddenAfter.join(',') === 'n1,n2,n3' &&
      activesAfter.length === 0,
    `rebuildEvents=${String(rebuild.appliedEvents)} status=${String(after?.state.status)} forbidden=[${forbiddenAfter.join(',')}] actives=${String(activesAfter.length)}`,
  )

  // 重复回放：同单元 RETRACTED 再落 ⇒ created=false（幂等）；折叠重放 no-op
  const replayUnit = beliefRetractedUnitOperation(dbBeliefId as never)
  const replayAccepted: AcceptedDomainEvent = {
    type: BELIEF_RETRACTED,
    operation: 'create',
    payload: dbEvents[5]?.payload,
    sourceConversationEventIds: [],
    scope: DOMAIN_EVENT_SCOPE,
    idempotencyKey: idempotencyKeyForBeliefEvent({
      characterId: dbOwner,
      processor: PROCESSOR,
      processorVersion: PROCESSOR_VERSION,
      operation: 'create',
      unit: replayUnit,
    }),
    processor: PROCESSOR,
    processorVersion: PROCESSOR_VERSION,
  }
  const replayAppend = await appendDomainEvent(db, dbOwner, replayAccepted, NOW)
  const afterReplay = await getBelief(db, dbOwner, dbBeliefId)
  check(
    's5-04',
    '重复回放：同单元幂等拦截（created=false）+ 状态不被污染（仍 retracted）',
    replayAppend.created === false && afterReplay?.state.status === 'retracted',
    `created=${String(replayAppend.created)} status=${String(afterReplay?.state.status)}`,
  )

  // 读侧终态：usable 集合为空（对话与普通查询不得重新暴露遗忘内容）
  const dbVerdicts = await recheckBeliefDependencies(
    {
      characterId: String(dbOwner),
      evidence: {
        async findEvents(ids: readonly string[]) {
          // 隔离库里没有对话事件表夹具——直接如实报"根不存在"（失败关闭路径）
          return ids.length === 0 ? [] : []
        },
      },
      memory: memoryLookup as never,
      origin: {
        async getBeliefOrigin() {
          return undefined
        },
      },
      policy: { activeUserId: String(USER) },
    },
    activesAfter,
  )
  check(
    's5-05',
    '读侧终态：usable 集合为空（遗忘内容不进使用集合）',
    usableBeliefsOf(dbVerdicts).length === 0,
    `usable=${String(usableBeliefsOf(dbVerdicts).length)}`,
  )

  // 拒绝码表仍冻结 14 项（本门未加新码——reported 复用既有码）
  check(
    's5-06',
    '拒绝码表仍冻结 14 项（WP5 未加新码：reported 复用 belief_source_missing/unqualified）',
    BELIEF_REJECTION_CODES.length === 14 && new Set(BELIEF_REJECTION_CODES).size === 14,
    `codes=${String(BELIEF_REJECTION_CODES.length)}`,
  )

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  console.log('\n---')
  console.log(
    `M9 invalidation verify：${String(checks.length)} 项 · 通过 ${String(passed)} · 失败 ${String(failed)}`,
  )

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp5-invalidation', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'invalidation-verify.json'),
    `${JSON.stringify(
      {
        schema: 'm9-wp5-invalidation-verify@1',
        runId,
        head,
        checks,
        summary: { total: checks.length, passed, failed },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeM9Manifest(dir, {
    runId,
    wp: 'wp5',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'verify',
    counts: { total: checks.length, passed, failed },
    phases: ['reported-reconciler', 'memory-invalidation', 'root-invalidation', 'forget-correct-dispute', 'snapshot-replay'],
    supersedes: null,
    notes:
      'B-REPORTED 白名单形成 · Memory/根依赖失效传播（写侧收敛+读侧遮蔽+同轮 overlay）· B28/B29/B31 遗忘契约 · B30 rebuild 不复活 · 隔离库往返',
    mode: 'offline',
    databaseScope: 'isolated',
  })
  console.log(`runId: ${runId}`)

  process.exitCode = failed === 0 ? 0 : 1
}

await main()
