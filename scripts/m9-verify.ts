/**
 * M9 WP4 门 —— Validator / Reducer / Store / 全量登记表接线（`m9:verify`）。
 *
 * ============================================================================
 *  四段判据（计划 §16.1；全部失败关闭）
 * ============================================================================
 * §1 三方折叠比对：生产 reducer（projections/belief.ts + foldBeliefRows 编排）
 *    × 独立 oracle（evals/fixtures/m9/belief-oracle.ts，WP2 冻结）× 手写预期。
 *    同一批事件喂三方，逐字段比对（status / roots / epistemicKind / origin /
 *    forbiddenRoots / 证据累计行）。**oracle 不 import 生产代码**（m9:test 静态锁）。
 * §2 Validator 正控/负控（33 例）：合成 deps + 真实 registry；每例断言
 *    accept 或具名拒绝码。接受的样本折进行内模型（与 §1 同一折叠核心）。
 * §3 Store 往返（隔离库）：append 30 事件 → 两批增量 apply → 快照 A →
 *    全量 rebuild → 快照 B ⇒ A==B（SC-005：投影是缓存）；forbiddenRootsForSlot
 *    与 oracle 逐项一致。
 * §4 接线与冻结面：全量登记表含 7 类 BELIEF 事件；拒绝码表 14 项无重复；
 *    资格四条与 M8 判据对同一夹具同判定（跨 ADR 防漂移）。
 *
 * 证据：`artifacts/m9/m9-wp4-verify-<date>-<head12>-<suffix4>/`（m9-manifest@1）。
 */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import {
  applyBeliefRows,
  forbiddenRootsForSlot,
  foldBeliefRows,
  getBelief,
  getBeliefOrigin,
  listBeliefRows,
  rebuildBeliefProjections,
  type RowCacheEntry,
} from '../src/infrastructure/persistence/belief-store.ts'
import {
  BELIEF_HANDLED_EVENT_TYPES,
  BELIEF_REDUCER_VERSION,
  beliefEvidenceRowKeyOf,
  beliefOriginRowKey,
  beliefRowKeyOf,
} from '../src/kernel/projections/belief.ts'
import {
  BELIEF_DISPUTED,
  BELIEF_EVIDENCE_NOTED,
  BELIEF_FORMED,
  BELIEF_ORIGIN,
  BELIEF_REINFORCED,
  BELIEF_RETRACTED,
  BELIEF_SUPERSEDED,
  DOMAIN_EVENT_SCOPE,
  createBeliefDomainEventRegistry,
  createFullDomainEventRegistry,
  type DomainEvent,
} from '../src/kernel/contracts/domain-event.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import type { DomainProposal } from '../src/kernel/contracts/proposal.ts'
import {
  BELIEF_INFERRED_MIN_CONVERSATIONS,
  BELIEF_INFERRED_MIN_ROOTS,
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_RULE_ID,
  BELIEF_INFERRED_RULE_VERSION,
  BELIEF_INFERRED_SCOPE,
  BELIEF_REJECTION_CODES,
  BELIEF_REPORTED_RULE_ID,
  BELIEF_REPORTED_RULE_VERSION,
  beliefEvidenceQualifies,
  beliefSlotKeyOf,
  makeBeliefId,
  validateBeliefDisputedPayload,
  validateBeliefEvidenceNotedPayload,
  validateBeliefFormedPayload,
  validateBeliefOriginPayload,
  validateBeliefReinforcedPayload,
  validateBeliefRetractedPayload,
  validateBeliefSupersededPayload,
  type BeliefDisputedPayload,
  type BeliefEvidenceNotedPayload,
  type BeliefFormedPayload,
  type BeliefOriginPayload,
  type BeliefOriginState,
  type BeliefReinforcedPayload,
  type BeliefRetractedPayload,
  type BeliefState,
  type BeliefSupersededPayload,
} from '../src/kernel/contracts/belief.ts'
import { affectEvidenceVerdictOf } from '../src/kernel/contracts/affect.ts'
import {
  beliefDisputedUnitOperation,
  beliefEvidenceUnitOperation,
  beliefFormedUnitOperation,
  beliefOriginUnitOperation,
  beliefReinforcedUnitOperation,
  beliefRetractedUnitOperation,
  beliefSupersededUnitOperation,
  idempotencyKeyForBeliefEvent,
  validateBeliefProposal,
  type BeliefStateLookup,
  type BeliefValidatorDeps,
} from '../src/kernel/policies/belief-validator.ts'
import { oracleFold, type OracleBeliefEvent } from '../evals/fixtures/m9/belief-oracle.ts'
import { asCharacterId, asConversationEventId, asEntityId, type CharacterId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
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
const PROCESSOR = 'm9-wp4-gate'
const PROCESSOR_VERSION = 'm9-wp4-gate@1'

// ---------------------------------------------------------------------------
// 检查框架（measured_count 纪律：分母 = checks.length，必须 > 0）
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
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// 夹具：事件构造（payload 全部过 WP2 结构校验器）
// ---------------------------------------------------------------------------

let domainSequence = 0
function nextDomainSequence(): number {
  domainSequence += 1
  return domainSequence
}

function domainEventOf(type: string, payload: unknown, unit: string): DomainEvent {
  return {
    id: `de:m9:${String(nextDomainSequence())}` as DomainEvent['id'],
    characterId: OWNER,
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

/**
 * 夹具 owner（可变）：§1/§2 用合成 id `char_sumuwei`（纯内存，自洽即可）；
 * §3 必须换 `kernel.characterId`（种子 UUID）——rebuild 的 owner 过滤比的是
 * payload.characterId，硬编码合成 id 会让全量重放把事件全滤掉（校准轮 2 抓出）。
 */
let OWNER: CharacterId = CHARACTER
let SLOT: string = SLOT_KEY
function useOwner(owner: CharacterId): void {
  OWNER = owner
  SLOT = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(owner)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: SCOPE,
  })
}

function originPayload(cutoverSequence: number): BeliefOriginPayload {
  const payload: BeliefOriginPayload = {
    characterId: OWNER,
    activationId: 'm9-wp4-gate-activation',
    cutoverSequence,
    cutoverAt: NOW,
    policyVersion: 'belief-evidence-policy@1',
  }
  validateBeliefOriginPayload(payload)
  return payload
}

function notedPayload(
  rootId: string,
  rootSequence: number,
  conversationId: string,
  value: 'detailed' | 'concise',
): BeliefEvidenceNotedPayload {
  const payload: BeliefEvidenceNotedPayload = {
    characterId: OWNER,
    perspectiveOwnerId: asEntityId(String(OWNER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: SCOPE,
    value,
    rootEventId: asConversationEventId(rootId),
    rootSequence,
    conversationId,
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
  validateBeliefEvidenceNotedPayload(payload)
  return payload
}

function formedPayload(
  beliefId: string,
  value: 'detailed' | 'concise',
  roots: string[],
  rootSequences: number[],
): BeliefFormedPayload {
  const formationKey = String(Math.max(...rootSequences))
  const derived = makeBeliefId(OWNER, SLOT, formationKey)
  const payload: BeliefFormedPayload = {
    characterId: OWNER,
    beliefId: beliefId === 'derive' ? derived : (beliefId as BeliefFormedPayload['beliefId']),
    perspectiveOwnerId: asEntityId(String(OWNER)),
    subject: SUBJECT,
    proposition: { predicate: PREDICATE, value, scopeKey: SCOPE },
    epistemicKind: 'inferred',
    supportLevel: 'tentative',
    evidenceRootIds: roots.map((r) => asConversationEventId(r)),
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
  validateBeliefFormedPayload(payload)
  return payload
}

function reinforcedPayload(beliefId: string, newRoots: string[]): BeliefReinforcedPayload {
  const payload: BeliefReinforcedPayload = {
    characterId: OWNER,
    beliefId: beliefId as BeliefReinforcedPayload['beliefId'],
    newRootIds: newRoots.map((r) => asConversationEventId(r)),
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
  validateBeliefReinforcedPayload(payload)
  return payload
}

function disputedPayload(beliefId: string): BeliefDisputedPayload {
  const payload: BeliefDisputedPayload = {
    characterId: OWNER,
    beliefId: beliefId as BeliefDisputedPayload['beliefId'],
    reason: 'user_correction',
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
  validateBeliefDisputedPayload(payload)
  return payload
}

function supersededPayload(oldBeliefId: string, newBeliefId: string): BeliefSupersededPayload {
  const payload: BeliefSupersededPayload = {
    characterId: OWNER,
    oldBeliefId: oldBeliefId as BeliefSupersededPayload['oldBeliefId'],
    newBeliefId: newBeliefId as BeliefSupersededPayload['newBeliefId'],
    reason: 'user_correction',
    validTo: NOW,
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
  validateBeliefSupersededPayload(payload)
  return payload
}

function retractedPayload(beliefId: string, forbiddenRoots: string[]): BeliefRetractedPayload {
  const payload: BeliefRetractedPayload = {
    characterId: OWNER,
    beliefId: beliefId as BeliefRetractedPayload['beliefId'],
    reason: 'user_forget_request',
    forbiddenRootIds: forbiddenRoots.map((r) => asConversationEventId(r)),
    ruleId: BELIEF_INFERRED_RULE_ID,
    ruleVersion: BELIEF_INFERRED_RULE_VERSION,
  }
  validateBeliefRetractedPayload(payload)
  return payload
}

// ---------------------------------------------------------------------------
// §1 事件剧本（30 条；覆盖 §4.2 全状态机 + §5.4 遗忘契约 + 合法重开）
// ---------------------------------------------------------------------------

function buildScriptEvents(): DomainEvent[] {
  const events: DomainEvent[] = []
  const push = (type: string, payload: unknown, unit: string): void => {
    events.push(domainEventOf(type, payload, unit))
  }

  push(BELIEF_ORIGIN, originPayload(100), 'origin')
  // b1（detailed）：3 根跨 2 会话 → 形成
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r1', 101, 'conv-a', 'detailed'), 'n-r1')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r2', 105, 'conv-a', 'detailed'), 'n-r2')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r3', 110, 'conv-b', 'detailed'), 'n-r3')
  const b1 = String(makeBeliefId(OWNER, SLOT, '110'))
  push(BELIEF_FORMED, formedPayload(b1, 'detailed', ['r1', 'r2', 'r3'], [101, 105, 110]), 'f-b1')
  // 强化 + 同根重放（去重 no-op）+ FORMED 重放（幂等 no-op）
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r4', 115, 'conv-b', 'detailed'), 'n-r4')
  push(BELIEF_REINFORCED, reinforcedPayload(b1, ['r4']), 'rein-b1-r4')
  push(BELIEF_REINFORCED, reinforcedPayload(b1, ['r4']), 'rein-b1-r4-replay')
  push(BELIEF_FORMED, formedPayload(b1, 'detailed', ['r1', 'r2', 'r3'], [101, 105, 110]), 'f-b1-replay')
  // b2（concise，冲突信号）：异值现存 ⇒ 照提照折，两个 active 并存
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r5', 120, 'conv-a', 'concise'), 'n-r5')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r6', 125, 'conv-b', 'concise'), 'n-r6')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r7', 130, 'conv-c', 'concise'), 'n-r7')
  const b2 = String(makeBeliefId(OWNER, SLOT, '130'))
  push(BELIEF_FORMED, formedPayload(b2, 'concise', ['r5', 'r6', 'r7'], [120, 125, 130]), 'f-b2')
  // 争议：active → disputed；再争议 no-op；争议后强化 no-op
  push(BELIEF_DISPUTED, disputedPayload(b1), 'd-b1')
  push(BELIEF_DISPUTED, disputedPayload(b1), 'd-b1-replay')
  push(BELIEF_REINFORCED, reinforcedPayload(b1, ['r4']), 'rein-b1-disputed')
  // 取代：b1 → b3（b3 先有自己的 FORMED）；重复取代 no-op；旧值证据行清零
  const b3 = String(makeBeliefId(OWNER, SLOT, '160'))
  push(BELIEF_SUPERSEDED, supersededPayload(b1, b3), 'sup-b1-b3')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r8', 150, 'conv-a', 'detailed'), 'n-r8')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r9', 155, 'conv-b', 'detailed'), 'n-r9')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r10', 160, 'conv-c', 'detailed'), 'n-r10')
  push(BELIEF_FORMED, formedPayload(b3, 'detailed', ['r8', 'r9', 'r10'], [150, 155, 160]), 'f-b3')
  push(BELIEF_SUPERSEDED, supersededPayload(b1, b3), 'sup-b1-b3-replay')
  // 撤回：b2 → retracted（终态）+ 禁用根 = 它自己的根；重复撤回 no-op
  push(BELIEF_RETRACTED, retractedPayload(b2, ['r5', 'r6', 'r7']), 'ret-b2')
  push(BELIEF_RETRACTED, retractedPayload(b2, ['r5', 'r6', 'r7']), 'ret-b2-replay')
  // b3 强化（新根 r11）+ b4 合法重开（concise，全新根，不交禁用集）
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r11', 165, 'conv-a', 'detailed'), 'n-r11')
  push(BELIEF_REINFORCED, reinforcedPayload(b3, ['r11']), 'rein-b3-r11')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r12', 170, 'conv-a', 'concise'), 'n-r12')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r13', 175, 'conv-b', 'concise'), 'n-r13')
  push(BELIEF_EVIDENCE_NOTED, notedPayload('r14', 180, 'conv-c', 'concise'), 'n-r14')
  const b4 = String(makeBeliefId(OWNER, SLOT, '180'))
  push(BELIEF_FORMED, formedPayload(b4, 'concise', ['r12', 'r13', 'r14'], [170, 175, 180]), 'f-b4')

  return events
}

/** 剧本 → oracle 事件（EVIDENCE_NOTED 不进 oracle——它不属于信念状态机） */
function oracleEventsOf(events: readonly DomainEvent[]): OracleBeliefEvent[] {
  const out: OracleBeliefEvent[] = []
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    switch (event.type) {
      case BELIEF_ORIGIN:
        out.push({
          kind: 'origin',
          activationId: String(payload.activationId),
          cutoverSequence: Number(payload.cutoverSequence),
        })
        break
      case BELIEF_FORMED:
        out.push({
          kind: 'formed',
          beliefId: String(payload.beliefId),
          slotKey: SLOT,
          epistemicKind: 'inferred',
          roots: (payload.evidenceRootIds as string[]).map(String),
        })
        break
      case BELIEF_REINFORCED:
        out.push({
          kind: 'reinforced',
          beliefId: String(payload.beliefId),
          newRoots: (payload.newRootIds as string[]).map(String),
        })
        break
      case BELIEF_DISPUTED:
        out.push({ kind: 'disputed', beliefId: String(payload.beliefId) })
        break
      case BELIEF_SUPERSEDED:
        out.push({
          kind: 'superseded',
          oldBeliefId: String(payload.oldBeliefId),
          newBeliefId: String(payload.newBeliefId),
        })
        break
      case BELIEF_RETRACTED:
        out.push({
          kind: 'retracted',
          beliefId: String(payload.beliefId),
          slotKey: SLOT,
          forbiddenRoots: (payload.forbiddenRootIds as string[]).map(String),
        })
        break
      default:
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // §1/§2 用合成 owner（纯内存自洽）；§3 换 kernel.characterId（见 useOwner 注释）
  useOwner(CHARACTER)
  const scriptEvents = buildScriptEvents()

  // =========================================================================
  // §1 三方折叠比对（生产 reducer × oracle × 手写预期）
  // =========================================================================
  section('§1 三方折叠比对（reducer × oracle × 手写）')

  const cache = new Map<string, RowCacheEntry>()
  foldBeliefRows(cache, scriptEvents)

  const productionBeliefs = new Map<string, BeliefState>()
  for (const [key, entry] of cache) {
    if (key.startsWith('belief:') && !key.startsWith('belief:evidence:') && key !== beliefOriginRowKey()) {
      productionBeliefs.set(key, entry.state as BeliefState)
    }
  }
  const b1 = String(makeBeliefId(OWNER, SLOT, '110'))
  const b2 = String(makeBeliefId(OWNER, SLOT, '130'))
  const b3 = String(makeBeliefId(OWNER, SLOT, '160'))
  const b4 = String(makeBeliefId(OWNER, SLOT, '180'))

  const oracle = oracleFold(oracleEventsOf(scriptEvents))

  // 手写预期（从 ADR-070 §4.2 状态转换表逐条推；不 import 任何被测代码）
  const expected: Record<string, { status: string; roots: string[] }> = {
    [b1]: { status: 'superseded', roots: ['r1', 'r2', 'r3', 'r4'] },
    [b2]: { status: 'retracted', roots: ['r5', 'r6', 'r7'] },
    [b3]: { status: 'active', roots: ['r8', 'r9', 'r10', 'r11'] },
    [b4]: { status: 'active', roots: ['r12', 'r13', 'r14'] },
  }

  check(
    's1-01',
    '生产 reducer 与手写预期逐信念一致（4 信念 × status/roots）',
    Object.keys(expected).length === 4 &&
      Object.entries(expected).every(([beliefId, exp]) => {
        const state = productionBeliefs.get(beliefRowKeyOf(beliefId))
        return (
          state !== undefined &&
          state.status === exp.status &&
          state.evidenceRootIds.map(String).join(',') === exp.roots.join(',')
        )
      }),
    `beliefs=${String(productionBeliefs.size)} · ` +
      [b1, b2, b3, b4]
        .map((id) => `${id.slice(-6)}:${productionBeliefs.get(beliefRowKeyOf(id))?.status ?? '??'}`)
        .join(' '),
  )

  check(
    's1-02',
    '生产 reducer 与独立 oracle 逐信念一致（status / roots / epistemicKind）',
    Object.keys(oracle.beliefs).length === productionBeliefs.size &&
      Object.entries(oracle.beliefs).every(([beliefId, oracleState]) => {
        const state = productionBeliefs.get(beliefRowKeyOf(beliefId))
        return (
          state !== undefined &&
          state.status === oracleState.status &&
          state.evidenceRootIds.map(String).join(',') === oracleState.roots.join(',') &&
          state.epistemicKind === oracleState.epistemicKind
        )
      }),
    `oracle=${String(Object.keys(oracle.beliefs).length)} · production=${String(productionBeliefs.size)}`,
  )

  const originEntry = cache.get(beliefOriginRowKey())
  const originState = originEntry?.state as BeliefOriginState | undefined
  check(
    's1-03',
    '建档行：originated + cutover=100（重复 ORIGIN 折叠为 no-op）',
    originState !== undefined &&
      originState.originated === true &&
      originState.cutoverSequence === 100 &&
      originState.originatedAt === NOW,
    `originated=${String(originState?.originated)} · cutover=${String(originState?.cutoverSequence)}`,
  )
  check('s1-04', 'oracle 同判 originated', oracle.originated, `originated=${String(oracle.originated)}`)

  // 证据累计行：SUPERSEDED/RETRACTED 命中值 ⇒ 清零重建
  const evidenceDetailedKey = beliefEvidenceRowKeyOf({
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: SCOPE,
    value: 'detailed',
  })
  const evidenceConciseKey = beliefEvidenceRowKeyOf({
    perspectiveOwnerId: asEntityId(String(CHARACTER)),
    subject: SUBJECT,
    predicate: PREDICATE,
    scopeKey: SCOPE,
    value: 'concise',
  })
  const detailedRow = cache.get(evidenceDetailedKey)?.state as
    | { rootIds: string[]; conversationIds: string[] }
    | undefined
  const conciseRow = cache.get(evidenceConciseKey)?.state as
    | { rootIds: string[]; conversationIds: string[] }
    | undefined
  check(
    's1-05',
    '证据累计行：取代/撤回清零后只含新根（detailed=[r8..r11] · concise=[r12..r14]）',
    detailedRow !== undefined &&
      conciseRow !== undefined &&
      detailedRow.rootIds.map(String).join(',') === 'r8,r9,r10,r11' &&
      conciseRow.rootIds.map(String).join(',') === 'r12,r13,r14' &&
      detailedRow.conversationIds.length === 3,
    `detailed=${detailedRow?.rootIds.map(String).join(',') ?? '?'} · concise=${conciseRow?.rootIds.map(String).join(',') ?? '?'}`,
  )

  // 禁用根（生产侧从 RETRACTED 事件推导，Set 去重——replay 事件的根并集不变；
  // 与 oracle.forbiddenRootsBySlot 一致）
  const productionForbiddenSet = new Set<string>()
  for (const event of scriptEvents) {
    if (event.type !== BELIEF_RETRACTED) continue
    const payload = event.payload as BeliefRetractedPayload
    if (String(payload.beliefId) !== b2) continue
    for (const root of payload.forbiddenRootIds ?? []) productionForbiddenSet.add(String(root))
  }
  const productionForbidden = [...productionForbiddenSet]
  check(
    's1-06',
    '禁用根与 oracle.forbiddenRootsBySlot 一致（[r5,r6,r7]；replay 不改并集）',
    oracle.forbiddenRootsBySlot[SLOT]?.join(',') === 'r5,r6,r7' &&
      productionForbidden.join(',') === 'r5,r6,r7',
    `oracle=${oracle.forbiddenRootsBySlot[SLOT]?.join(',') ?? '?'} · production=${productionForbidden.join(',')}`,
  )

  check(
    's1-07',
    'b4 合法重开：新根不交禁用集 ⇒ 形成（重放旧证据不复活 ≠ 禁止新证据）',
    productionBeliefs.get(beliefRowKeyOf(b4))?.status === 'active' &&
      !productionForbidden.some((f) => ['r12', 'r13', 'r14'].includes(f)),
    `b4=${productionBeliefs.get(beliefRowKeyOf(b4))?.status ?? '?'}`,
  )

  // =========================================================================
  // §2 Validator 正控/负控（合成 deps + 真实 registry）
  // =========================================================================
  section('§2 Validator 正控/负控')

  // 合格用户事件（ESTABLISHED + active user + 切换后）；变体见各用例
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
  // e1..e6：合格（3 会话）；e7：她的回复；e8：别的角色；e9：切换前；e10：无信封
  addUserEvent('e1', 101, 'conv-a')
  addUserEvent('e2', 105, 'conv-a')
  addUserEvent('e3', 110, 'conv-b')
  addUserEvent('e4', 115, 'conv-c')
  addUserEvent('e5', 120, 'conv-b')
  addUserEvent('e6', 125, 'conv-c')
  addUserEvent('e7', 130, 'conv-a', { type: 'assistant_message', actorId: String(CHARACTER) })
  addUserEvent('e8', 135, 'conv-a', { characterId: 'char_other' })
  addUserEvent('e9', 90, 'conv-a')
  addUserEvent('e10', 140, 'conv-a', { trustedOrigin: undefined })
  // e11/e12：conv-a 的额外合格根（负控样本要换新 formationKey 才不撞幂等键）
  addUserEvent('e11', 145, 'conv-a')
  addUserEvent('e12', 185, 'conv-a')

  // 行内信念模型：validator 接受的事件折进同一折叠核心（与 §1 同源）
  const validatorCache = new Map<string, RowCacheEntry>()
  const validatorProcessed = new Set<string>()
  const retractedEvents: DomainEvent[] = []

  const stateLookup: BeliefStateLookup = {
    async getBeliefOrigin(characterId) {
      void characterId
      return (validatorCache.get(beliefOriginRowKey())?.state as BeliefOriginState | undefined) ?? undefined
    },
    async getBelief(characterId, beliefId) {
      void characterId
      return (validatorCache.get(beliefRowKeyOf(String(beliefId)))?.state as BeliefState | undefined) ?? undefined
    },
    async listActiveBeliefsForSlot(characterId, slotKey) {
      void characterId
      const out: BeliefState[] = []
      for (const [key, entry] of validatorCache) {
        if (!key.startsWith('belief:') || key.startsWith('belief:evidence:')) continue
        const state = entry.state as BeliefState
        if (state.status !== 'active') continue
        const slot = beliefSlotKeyOf({
          perspectiveOwnerId: state.perspectiveOwnerId,
          subject: state.subject,
          predicate: state.proposition.predicate,
          scopeKey: state.proposition.scopeKey,
        })
        if (slot === slotKey) out.push(state)
      }
      return out
    },
    async forbiddenRootsForSlot(characterId, slotKey) {
      void characterId
      const roots: string[] = []
      for (const event of retractedEvents) {
        const payload = event.payload as BeliefRetractedPayload
        const belief = validatorCache.get(beliefRowKeyOf(String(payload.beliefId)))?.state as
          | BeliefState
          | undefined
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

  const registry = createBeliefDomainEventRegistry()
  const deps: BeliefValidatorDeps = {
    registry,
    evidence: {
      async findEvents(ids) {
        return ids
          .map((id) => evidenceRows.get(String(id)))
          .filter((r): r is EvidenceRow => r !== undefined)
          .map((r) => ({
            id: asConversationEventId(r.id),
            characterId: asCharacterId(r.characterId),
            sequence: r.sequence,
            type: r.type,
            actorId: r.actorId,
            conversationId: r.conversationId,
            trustedOrigin: r.trustedOrigin as never,
          }))
      },
    },
    processed: {
      async hasProcessed(key) {
        return validatorProcessed.has(key)
      },
    },
    belief: stateLookup,
    policy: { activeUserId: String(USER) },
  }

  let caseCounter = 0
  async function runCase(
    name: string,
    build: () => DomainProposal,
    expected: 'accept' | { code: string },
  ): Promise<void> {
    caseCounter += 1
    const proposal = build()
    const outcome = await validateBeliefProposal(deps, proposal)
    if (expected === 'accept') {
      check(
        `v-${String(caseCounter).padStart(2, '0')}`,
        name,
        outcome.accepted && outcome.acceptedEvents.length > 0,
        `accepted=${String(outcome.accepted)}${outcome.rejected.length > 0 ? ` · code=${outcome.rejected[0].code}` : ''}`,
      )
      if (outcome.accepted) {
        // 接受 ⇒ 折进行内模型（幂等键也记账——重复提案必须撞键）
        for (const acceptedEvent of outcome.acceptedEvents) {
          validatorProcessed.add(acceptedEvent.idempotencyKey)
        }
        const domainEvents: DomainEvent[] = outcome.acceptedEvents.map((accepted, index) => ({
          id: `de:v:${String(caseCounter)}:${String(index)}` as DomainEvent['id'],
          characterId: proposal.characterId,
          sequence: 1000 + caseCounter * 10 + index,
          type: accepted.type,
          sourceConversationEventIds: accepted.sourceConversationEventIds,
          payload: accepted.payload,
          processor: accepted.processor,
          processorVersion: accepted.processorVersion,
          idempotencyKey: accepted.idempotencyKey,
          schemaVersion: 1,
          createdAt: NOW,
        }))
        foldBeliefRows(validatorCache, domainEvents)
        for (const event of domainEvents) {
          if (event.type === BELIEF_RETRACTED) retractedEvents.push(event)
        }
      }
    } else {
      check(
        `v-${String(caseCounter).padStart(2, '0')}`,
        name,
        !outcome.accepted && outcome.rejected.some((r) => r.code === expected.code),
        `codes=${outcome.rejected.map((r) => r.code).join(',') || '(none)'}`,
      )
    }
  }

  function proposalOf(
    type: string,
    payload: unknown,
    sourceIds: string[] = [],
    processorOverride?: string,
  ): DomainProposal {
    return {
      proposalId: `p-${String(caseCounter + 1)}`,
      characterId: CHARACTER,
      processor: processorOverride ?? PROCESSOR,
      processorVersion: PROCESSOR_VERSION,
      sourceConversationEventIds: sourceIds.map((id) => asConversationEventId(id)),
      targetEvents: [
        {
          type,
          operation: 'create',
          payload,
        },
      ],
    } as unknown as DomainProposal
  }

  // —— ORIGIN ——
  await runCase('ORIGIN 正控：首次建档放行', () => proposalOf(BELIEF_ORIGIN, originPayload(100)), 'accept')
  await runCase(
    'ORIGIN 负控：重复建档拒绝（一角色一次；换 processor ⇒ 新幂等键，测到业务规则）',
    () => proposalOf(BELIEF_ORIGIN, originPayload(200), [], 'm9-wp4-gate-alt'),
    { code: 'belief_origin_duplicate' },
  )

  // —— EVIDENCE_NOTED ——
  await runCase(
    'EVIDENCE_NOTED 正控：合格根放行',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e1', 101, 'conv-a', 'detailed'), ['e1']),
    'accept',
  )
  await runCase(
    'EVIDENCE_NOTED 负控：同根同规则重复 ⇒ 幂等撞键',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e1', 101, 'conv-a', 'detailed'), ['e1']),
    { code: 'duplicate_operation' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：她的回复不采（user_message 才是证据）',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e7', 130, 'conv-a', 'detailed'), ['e7']),
    { code: 'belief_source_unqualified' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：别角色的事件拒绝',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e8', 135, 'conv-a', 'detailed'), ['e8']),
    { code: 'source_event_foreign' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：切换前历史不重评',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e9', 90, 'conv-a', 'detailed'), ['e9']),
    { code: 'belief_source_unqualified' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：无受信信封失败关闭',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e10', 140, 'conv-a', 'detailed'), ['e10']),
    { code: 'belief_source_unqualified' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：引用不存在的事件拒绝',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e-missing', 999, 'conv-a', 'detailed'), ['e-missing']),
    { code: 'source_event_missing' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：规则标识不符拒绝',
    () =>
      proposalOf(BELIEF_EVIDENCE_NOTED, {
        ...notedPayload('e2', 105, 'conv-a', 'detailed'),
        ruleId: 'some-other-rule',
      }, ['e2']),
    { code: 'belief_rule_version_unknown' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：owner 不符拒绝',
    () =>
      proposalOf(BELIEF_EVIDENCE_NOTED, {
        ...notedPayload('e2', 105, 'conv-a', 'detailed'),
        characterId: asCharacterId('char_other'),
      }, ['e2']),
    { code: 'belief_owner_mismatch' },
  )

  // —— FORMED ——
  const vb1 = String(makeBeliefId(OWNER, SLOT, '110'))
  await runCase(
    'FORMED 正控：3 根跨 2 会话 + 确定性 beliefId ⇒ 放行',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'detailed', ['e1', 'e2', 'e3'], [101, 105, 110]), ['e1', 'e2', 'e3']),
    'accept',
  )
  await runCase(
    'FORMED 负控：同 beliefId 重放 ⇒ 幂等撞键',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'detailed', ['e1', 'e2', 'e3'], [101, 105, 110]), ['e1', 'e2', 'e3']),
    { code: 'duplicate_operation' },
  )
  await runCase(
    'FORMED 负控：2 根不够阈值',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'detailed', ['e1', 'e2'], [101, 105]), ['e1', 'e2']),
    { code: 'belief_threshold_not_met' },
  )
  await runCase(
    'FORMED 负控：3 根但只 1 会话不够阈值（e11 同会话 ⇒ 新 formationKey 不撞键）',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'detailed', ['e1', 'e2', 'e11'], [101, 105, 145]), ['e1', 'e2', 'e11']),
    { code: 'belief_threshold_not_met' },
  )
  await runCase(
    'FORMED 负控：beliefId 不可复推（formationKey 不符）',
    () => proposalOf(BELIEF_FORMED, formedPayload('blf:fake:id:999', 'detailed', ['e1', 'e2', 'e3'], [101, 105, 110]), ['e1', 'e2', 'e3']),
    { code: 'belief_id_not_derivable' },
  )
  await runCase(
    'FORMED 负控：同值现存 ⇒ 拒绝（那是 REINFORCED 的事；换根 ⇒ 新 beliefId 不撞键）',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'detailed', ['e1', 'e3', 'e5'], [101, 110, 120]), ['e1', 'e3', 'e5']),
    { code: 'belief_slot_already_active' },
  )
  const vb2 = String(makeBeliefId(CHARACTER, SLOT_KEY, '125'))
  await runCase(
    'FORMED 正控：异值现存 ⇒ 照放（冲突是真实信号，DISPUTED 是显式事件）',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'concise', ['e4', 'e5', 'e6'], [115, 120, 125]), ['e4', 'e5', 'e6']),
    'accept',
  )
  await runCase(
    'FORMED 负控：规则标识不符拒绝（e12 ⇒ 新 beliefId 不撞键；规则检查先于业务规则）',
    () =>
      proposalOf(BELIEF_FORMED, {
        ...formedPayload('derive', 'concise', ['e4', 'e5', 'e12'], [115, 120, 185]),
        ruleVersion: 'belief-inferred-rules@2',
      }, ['e4', 'e5', 'e12']),
    { code: 'belief_rule_version_unknown' },
  )

  // —— REINFORCED ——
  await runCase(
    'REINFORCED 正控：active + 合格新根 ⇒ 放行',
    () => proposalOf(BELIEF_REINFORCED, reinforcedPayload(vb1, ['e4']), ['e4']),
    'accept',
  )
  await runCase(
    'REINFORCED 负控：不存在的信念拒绝',
    () => proposalOf(BELIEF_REINFORCED, reinforcedPayload('blf:missing:xx:1', ['e5']), ['e5']),
    { code: 'belief_belief_missing' },
  )
  await runCase(
    'REINFORCED 负控：不合格根拒绝',
    () => proposalOf(BELIEF_REINFORCED, reinforcedPayload(vb1, ['e7']), ['e7']),
    { code: 'belief_source_unqualified' },
  )

  // —— DISPUTED ——
  await runCase(
    'DISPUTED 正控：active → disputed 放行',
    () => proposalOf(BELIEF_DISPUTED, disputedPayload(vb1)),
    'accept',
  )
  await runCase(
    'DISPUTED 负控：不存在的信念拒绝（同单元重放会先撞幂等键，走新信念测业务规则）',
    () => proposalOf(BELIEF_DISPUTED, disputedPayload('blf:missing:xx:8')),
    { code: 'belief_belief_missing' },
  )
  await runCase(
    'REINFORCED 负控：disputed 不加支持',
    () => proposalOf(BELIEF_REINFORCED, reinforcedPayload(vb1, ['e5']), ['e5']),
    { code: 'belief_not_active' },
  )

  // —— SUPERSEDED ——
  const vb3 = String(makeBeliefId(OWNER, SLOT, '160'))
  await runCase(
    'SUPERSEDED 负控：old=new 自取代拒绝',
    () => proposalOf(BELIEF_SUPERSEDED, supersededPayload(vb2, vb2)),
    { code: 'belief_supersede_target_invalid' },
  )
  await runCase(
    'SUPERSEDED 正控：disputed old → 新 id 放行',
    () => proposalOf(BELIEF_SUPERSEDED, supersededPayload(vb1, vb3)),
    'accept',
  )
  await runCase(
    'SUPERSEDED 负控：已取代的 old 不可再迁移（终态；换新 newId ⇒ 新单元不撞键）',
    () => proposalOf(BELIEF_SUPERSEDED, supersededPayload(vb1, 'blf:m9:fresh:9')),
    { code: 'belief_supersede_target_invalid' },
  )

  // —— RETRACTED ——
  await runCase(
    'RETRACTED 负控：禁用根超出该信念自己的根 ⇒ 拒绝（过宽禁用错杀重开）',
    () => proposalOf(BELIEF_RETRACTED, retractedPayload(vb2, ['e4', 'e5', 'e6', 'e1'])),
    { code: 'belief_forbidden_roots_invalid' },
  )
  await runCase(
    'RETRACTED 正控：active + 自己的根 ⇒ 放行（禁用根生效）',
    () => proposalOf(BELIEF_RETRACTED, retractedPayload(vb2, ['e4', 'e5', 'e6'])),
    'accept',
  )
  await runCase(
    'RETRACTED 负控：不存在的信念拒绝（同单元重放会先撞幂等键，走新信念测业务规则）',
    () => proposalOf(BELIEF_RETRACTED, retractedPayload('blf:missing:xx:9', ['e4'])),
    { code: 'belief_belief_missing' },
  )
  await runCase(
    'FORMED 负控：形成根与禁用根相交 ⇒ 拒绝（§5.4/B28 重放旧证据不复活；e12 ⇒ 新 beliefId）',
    () => proposalOf(BELIEF_FORMED, formedPayload('derive', 'concise', ['e4', 'e5', 'e6', 'e12'], [115, 120, 125, 185]), ['e4', 'e5', 'e6', 'e12']),
    { code: 'belief_roots_forbidden' },
  )
  await runCase(
    'DISPUTED 负控：retracted 不进争议（终态；vb2 首次争议 ⇒ 新单元）',
    () => proposalOf(BELIEF_DISPUTED, disputedPayload(vb2)),
    { code: 'belief_not_active' },
  )
  await runCase(
    'EVIDENCE_NOTED 负控：禁用根不得再进累计',
    () => proposalOf(BELIEF_EVIDENCE_NOTED, notedPayload('e5', 120, 'conv-b', 'concise'), ['e5']),
    { code: 'belief_roots_forbidden' },
  )

  // —— 管线通用 ——
  await runCase(
    '类型负控：Belief 链只认七类',
    () => proposalOf('MEMORY_FACT_CREATED', { characterId: CHARACTER, memoryId: 'mem:x' }),
    { code: 'domain_event_type_not_allowed' },
  )
  await runCase(
    '结构负控：缺必填字段拒绝',
    () => proposalOf(BELIEF_DISPUTED, { characterId: CHARACTER, beliefId: vb3 }),
    { code: 'payload_schema_invalid' },
  )
  const noProcessorOutcome = await validateBeliefProposal(deps, {
    proposalId: 'p-np',
    characterId: CHARACTER,
    processor: '',
    processorVersion: '',
    sourceConversationEventIds: [],
    targetEvents: [{ type: BELIEF_ORIGIN, operation: 'create', payload: originPayload(300) }],
  } as unknown as DomainProposal)
  check(
    'v-39',
    '提案级负控：缺 processor/version 整体拒绝',
    !noProcessorOutcome.accepted &&
      noProcessorOutcome.rejected.some((r) => r.code === 'processor_version_presence'),
    `codes=${noProcessorOutcome.rejected.map((r) => r.code).join(',')}`,
  )

  // =========================================================================
  // §3 Store 往返（隔离库）：两批增量 apply == 全量 rebuild（SC-005）
  // =========================================================================
  section('§3 Store 往返（隔离库）')

  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db: RawDb = kernel.stores.db

  // 剧本按 kernel.characterId 重建：payload.characterId 必须与事件流 owner 一致，
  // 否则 rebuild 的 owner 过滤（beliefEventTargets）会把事件全部滤掉。
  useOwner(kernel.characterId)
  const dbScriptEvents = buildScriptEvents()
  const dbB3 = String(makeBeliefId(kernel.characterId, SLOT, '160'))
  const dbOracle = oracleFold(oracleEventsOf(dbScriptEvents))

  // 剧本事件落库（幂等键用领域单元——与生产同一推导）
  const appended: DomainEvent[] = []
  let deduped = 0
  for (const event of dbScriptEvents) {
    const payload = event.payload as Record<string, unknown>
    let unit = 'unknown'
    if (event.type === BELIEF_ORIGIN) unit = beliefOriginUnitOperation()
    else if (event.type === BELIEF_EVIDENCE_NOTED)
      unit = beliefEvidenceUnitOperation(
        payload.rootEventId as never,
        String(payload.ruleId),
      )
    else if (event.type === BELIEF_FORMED) unit = beliefFormedUnitOperation(payload.beliefId as never)
    else if (event.type === BELIEF_REINFORCED)
      unit = beliefReinforcedUnitOperation(
        payload.beliefId as never,
        (payload.newRootIds as string[]).map((r) => asConversationEventId(r)),
      )
    else if (event.type === BELIEF_DISPUTED) unit = beliefDisputedUnitOperation(payload.beliefId as never)
    else if (event.type === BELIEF_SUPERSEDED)
      unit = beliefSupersededUnitOperation(payload.oldBeliefId as never, payload.newBeliefId as never)
    else if (event.type === BELIEF_RETRACTED) unit = beliefRetractedUnitOperation(payload.beliefId as never)

    const accepted: AcceptedDomainEvent = {
      type: event.type,
      operation: 'create',
      payload: event.payload,
      sourceConversationEventIds: [],
      scope: DOMAIN_EVENT_SCOPE,
      idempotencyKey: idempotencyKeyForBeliefEvent({
        characterId: kernel.characterId,
        processor: event.processor,
        processorVersion: event.processorVersion,
        operation: 'create',
        unit,
      }),
      processor: event.processor,
      processorVersion: event.processorVersion,
    }
    const result = await appendDomainEvent(db, kernel.characterId, accepted)
    if (result.created) appended.push(result.event)
    else deduped += 1
  }
  check(
    's3-01',
    '落库幂等：30 提案中 6 个重放单元被唯一约束挡下（24 落库）——事件流里没有第二份同单元',
    appended.length === 24 && deduped === 6,
    `appended=${String(appended.length)} · deduped=${String(deduped)} · script=${String(scriptEvents.length)}`,
  )

  // 两批增量 apply：批界切在第一个 SUPERSEDED 之后——证据行"清零（批1）→
  // 再累计（批2）"的跨批路径正是 WP4 校准轮抓出的写回缺陷所在。
  const firstSuperseded = appended.findIndex((event) => event.type === BELIEF_SUPERSEDED)
  const batch1 = appended.slice(0, firstSuperseded + 1)
  const batch2 = appended.slice(firstSuperseded + 1)
  const apply1 = await applyBeliefRows(db, kernel.characterId, batch1)
  const apply2 = await applyBeliefRows(db, kernel.characterId, batch2)
  const rowsA = await listBeliefRows(db, kernel.characterId)
  check(
    's3-02',
    '两批增量 apply：行数 = 4 信念 + origin + 2 证据行；批1 删 1 行（取代清零）批2 再建',
    rowsA.length === 7 &&
      apply1.appliedEvents === batch1.length &&
      apply2.appliedEvents === batch2.length &&
      apply1.deletedRows === 1 &&
      apply2.deletedRows === 1,
    `rows=${String(rowsA.length)} · apply1=${String(apply1.appliedEvents)}(del ${String(apply1.deletedRows)}) · apply2=${String(apply2.appliedEvents)}(del ${String(apply2.deletedRows)})`,
  )

  const snapshotOf = (
    rows: Awaited<ReturnType<typeof listBeliefRows>>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      out[String(row.projectionType)] = {
        revision: row.revision,
        reducerVersion: row.reducerVersion,
        lastDomainEventId: row.lastDomainEventId ? String(row.lastDomainEventId) : null,
        lastDomainEventSequence: row.lastDomainEventSequence ?? null,
        state: row.state,
      }
    }
    return out
  }
  const snapshotA = snapshotOf(rowsA)

  const rebuild = await rebuildBeliefProjections(db, kernel.characterId)
  const rowsB = await listBeliefRows(db, kernel.characterId)
  const snapshotB = snapshotOf(rowsB)
  check(
    's3-03',
    'SC-005：删掉重放 ⇒ 逐字段一致（增量路径 == 重建路径；updatedAt 除外）',
    JSON.stringify(snapshotA) === JSON.stringify(snapshotB) &&
      rebuild.previousRowCount === rowsA.length,
    `A==B：${String(JSON.stringify(snapshotA) === JSON.stringify(snapshotB))} · rebuildEvents=${String(rebuild.appliedEvents)}`,
  )

  const dbForbidden = await forbiddenRootsForSlot(db, kernel.characterId, SLOT)
  check(
    's3-04',
    '库侧禁用根与 oracle 一致（RETRACTED 事件流推导）',
    dbForbidden.join(',') === 'r5,r6,r7' &&
      dbOracle.forbiddenRootsBySlot[SLOT]?.join(',') === 'r5,r6,r7',
    `db=[${dbForbidden.join(',')}] · oracle=[${dbOracle.forbiddenRootsBySlot[SLOT]?.join(',') ?? ''}]`,
  )

  const dbB3Row = await getBelief(db, kernel.characterId, dbB3)
  const dbOrigin = await getBeliefOrigin(db, kernel.characterId)
  check(
    's3-05',
    '读助手：b3 active + 4 根；origin cutover=100',
    dbB3Row?.state.status === 'active' &&
      dbB3Row.state.evidenceRootIds.length === 4 &&
      dbOrigin?.state.cutoverSequence === 100,
    `b3=${dbB3Row?.state.status ?? '?'} roots=${String(dbB3Row?.state.evidenceRootIds.length ?? -1)} · cutover=${String(dbOrigin?.state.cutoverSequence ?? -1)}`,
  )

  // =========================================================================
  // §4 接线与冻结面
  // =========================================================================
  section('§4 接线与冻结面')

  const fullRegistry = createFullDomainEventRegistry()
  const beliefTypesInFull = [
    BELIEF_ORIGIN,
    BELIEF_EVIDENCE_NOTED,
    BELIEF_FORMED,
    BELIEF_REINFORCED,
    BELIEF_DISPUTED,
    BELIEF_SUPERSEDED,
    BELIEF_RETRACTED,
  ].filter((type) => fullRegistry.get(type) !== undefined)
  check(
    's4-01',
    '全量登记表接线：七类 BELIEF 事件全部可解析（装配层用 createFullDomainEventRegistry）',
    beliefTypesInFull.length === 7,
    `wired=${String(beliefTypesInFull.length)}/7`,
  )

  check(
    's4-02',
    '拒绝码表冻结：14 项且无重复',
    BELIEF_REJECTION_CODES.length === 14 && new Set(BELIEF_REJECTION_CODES).size === 14,
    `codes=${String(BELIEF_REJECTION_CODES.length)}`,
  )

  check(
    's4-03',
    'reducer 版本冻结 belief-reducer@1 + 处理事件七类',
    BELIEF_REDUCER_VERSION === 'belief-reducer@1' && BELIEF_HANDLED_EVENT_TYPES.length === 7,
    `version=${BELIEF_REDUCER_VERSION} · handled=${String(BELIEF_HANDLED_EVENT_TYPES.length)}`,
  )

  // 资格四条 vs M8 判据：同一夹具同判定（跨 ADR 防漂移）
  const policy = { activeUserId: String(USER), cutoverSequence: 100 }
  const driftViews = ['e1', 'e7', 'e8', 'e9', 'e10'].map((id) => evidenceRows.get(id)!)
  const drift = driftViews.map((row) => {
    const beliefOk = beliefEvidenceQualifies(
      {
        id: asConversationEventId(row.id),
        sequence: row.sequence,
        type: row.type,
        actorId: row.actorId,
        trustedOrigin: row.trustedOrigin as never,
      },
      policy,
    )
    const affectOk = affectEvidenceVerdictOf(
      [
        {
          id: asConversationEventId(row.id),
          sequence: row.sequence,
          type: row.type,
          actorId: row.actorId,
          trustedOrigin: row.trustedOrigin as never,
        },
      ],
      policy,
    ).ok
    return { id: row.id, beliefOk, affectOk, agree: beliefOk === affectOk }
  })
  check(
    's4-04',
    '资格四条与 M8 affectEvidenceVerdictOf 对同一夹具同判定（5 夹具全一致）',
    drift.length === 5 && drift.every((d) => d.agree),
    drift.map((d) => `${d.id}:${d.beliefOk === d.affectOk ? '=' : '!'}`).join(' '),
  )

  check(
    's4-05',
    'B-REPORTED 规则常量在案（WP5 reconciler 的身份面）',
    BELIEF_REPORTED_RULE_ID === 'belief-reported-from-memory' &&
      BELIEF_REPORTED_RULE_VERSION === 'belief-reported-rules@1',
    `${BELIEF_REPORTED_RULE_ID}@${BELIEF_REPORTED_RULE_VERSION}`,
  )

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  console.log('\n---')
  console.log(`M9 verify：${String(checks.length)} 项 · 通过 ${String(passed)} · 失败 ${String(failed)}`)

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp4-verify', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'verify.json'),
    `${JSON.stringify(
      {
        schema: 'm9-wp4-verify@1',
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
    wp: 'wp4',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'verify',
    counts: { total: checks.length, passed, failed },
    phases: ['three-way-fold', 'validator-cases', 'store-roundtrip', 'wiring-frozen'],
    supersedes: null,
    notes:
      '三方折叠比对（reducer×oracle×手写）· Validator 39 例正负控 · 隔离库两批增量==全量重建（SC-005）· 全量登记表接线',
    mode: 'offline',
    databaseScope: 'isolated',
  })
  console.log(`runId: ${runId}`)

  process.exitCode = failed === 0 ? 0 : 1
}

await main()
