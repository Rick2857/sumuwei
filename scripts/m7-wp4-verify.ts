/**
 * M7 WP4 —— **验证器 / Reducer / 投影 部件门**（`pnpm m7:wp4:verify`）。
 *
 * ============================================================================
 *  要证明的命题（ADR-064 §9 出口判据）
 * ============================================================================
 * ① 放行口失败关闭：未建档先变化 / 超界 delta / 注入来源 / 证据不合格 /
 *    双重建档 / 撤回不在案 / owner 伪造 —— 全部 reject 且**零事件落库**。
 * ② 折叠语义：ORIGIN 建档 · IMPACT 有界变化 · **撤回反扣**
 *    （"supersede 后旧事件不再驱动投影"的字面验证：trust 精确回到
 *    指控前 + 修复量）· 指进入案登记表。
 * ③ 重复失败关闭：同窗口重跑 → 领域幂等键全命中 → createdCount=0、状态不动。
 * ④ 多目标隔离：user-2 的事件只动 user-2 的行；user-1 的行**逐字段不动**
 *    （per-target 信封不前进）。
 * ⑤ 投影是缓存：删行 → `rebuildRelationshipProjection` → **逐字段一致**（A==B）。
 * ⑥ 真链路：真实 store + 真实入口归因（`appendUserStatement` 的受信信封 →
 *    ESTABLISHED 资格全链路成立）+ R-5 里程碑计数从账本派生跨过 100 条。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库（本文件顶部），
 * 真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m7-wp4-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  appendConversationEvent,
  conversationEventsInRange,
} from '../src/infrastructure/persistence/conversation-store.ts'
import {
  applyAcceptedEvents,
  countDomainEvents,
  deleteProjection,
  getDomainEvent,
} from '../src/infrastructure/persistence/event-store.ts'
import { hasProcessedOperation } from '../src/infrastructure/persistence/job-store.ts'
import {
  getRelationshipProjection,
  rebuildRelationshipProjection,
} from '../src/infrastructure/persistence/relationship-store.ts'
import {
  asConversationId,
  asEntityId,
  createProposal,
  entityRef,
  relationshipDayOf,
  relationshipProjectionType,
  type ConversationEvent,
  type ConversationEventId,
  type DomainProposal,
} from '../src/kernel/contracts/index.ts'
import { sourceQualificationOf } from '../src/kernel/contracts/attribution.ts'
import { createFullDomainEventRegistry, RELATIONSHIP_IMPACT, RELATIONSHIP_ORIGIN } from '../src/kernel/contracts/domain-event.ts'
import {
  RELATIONSHIP_ORIGIN_PROPOSAL_TYPE,
  type RelationshipImpactPayload,
  type RelationshipOriginPayload,
  type RelationshipState,
} from '../src/kernel/contracts/relationship.ts'
import { validateRelationshipProposal } from '../src/kernel/policies/relationship-validator.ts'
import { relationshipReducerFor } from '../src/kernel/projections/relationship.ts'
import { processorEventViewOf } from '../src/kernel/app/memory/extractor.ts'
import {
  runRelationshipEvaluation,
  type RelationshipJobPorts,
} from '../src/kernel/app/relationship/job.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

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
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const owner = entityRef('character', asEntityId(String(characterId)))
  const registry = createFullDomainEventRegistry()
  // 受信归因的生产 ingress（human-console 族）：没有它，appendUserStatement 走
  // legacy 路径（无信封）→ 资格永远不是 ESTABLISHED → 评估器看不到任何合格证据
  const ledger = createConversationLedger({
    db,
    attribution: [createHumanConsoleUserTurnIngress()],
  })
  const conversationId = asConversationId('m7-wp4-verify-conversation')

  // ---- 固定时间线（UTC+8 口径：DAY1=09-25 · DAY2=09-26 · DAY3=09-27）----
  const DAY1 = Date.UTC(2026, 8, 25, 2, 0, 0)
  const DAY2 = Date.UTC(2026, 8, 26, 2, 0, 0)
  const DAY3 = Date.UTC(2026, 8, 27, 2, 0, 0)

  // ---- 种子：受信入口的用户直接互动（appendUserStatement 自带受信归因信封）----
  const seeded: ConversationEvent[] = []
  let convSeq = 0
  const appendUser = async (userId: string, content: string, createdAt: number): Promise<void> => {
    convSeq += 1
    const outcome = await ledger.appendUserStatement({
      characterId,
      conversationId,
      userId,
      content,
      createdAt,
      conversationSequence: convSeq,
    })
    seeded.push(outcome.event)
  }

  // W1 素材（seq 1..12，user-1，跨两日 + 一句感谢）
  for (let i = 1; i <= 6; i += 1) await appendUser('m7-user-1', `day1 日常 ${String(i)}`, DAY1)
  await appendUser('m7-user-1', '谢谢你昨晚陪我聊到那么晚', DAY1)
  for (let i = 1; i <= 5; i += 1) await appendUser('m7-user-1', `day2 日常 ${String(i)}`, DAY2)
  // W2 素材（seq 13，指控）
  await appendUser('m7-user-1', '你骗我，你明明说过今天陪我的', DAY3)
  // W3 素材（seq 14，撤回）
  await appendUser('m7-user-1', '对不起，我错怪你了', DAY3)
  // W4 素材（seq 15，user-2 的感谢）
  await appendUser('m7-user-2', '谢谢你听我说', DAY3)
  // N4 素材（她的生成——legacy 无信封 → 未确立；也进 seeded 供证据查找命中）
  convSeq += 1
  const assistantAppend = await appendConversationEvent(db, {
    characterId,
    conversationId,
    conversationSequence: convSeq,
    type: 'assistant_message',
    actorType: 'character',
    actorId: String(characterId),
    content: '谢谢你陪我聊这么久',
    createdAt: DAY3,
  })
  seeded.push(assistantAppend.event)
  // W5 素材（seq 17，修复后的新感谢——恢复段用）
  await appendUser('m7-user-1', '辛苦了，今天忙完了吧', DAY3)
  // W6 素材（seq 18..117，100 条平淡消息——R-5 里程碑跨过用）
  for (let i = 18; i <= 117; i += 1) await appendUser('m7-user-1', `mile ${String(i)}`, DAY3)

  const eventBySeq = new Map(seeded.map((e) => [e.sequence, e]))
  const firstUserId = eventBySeq.get(1)!.id

  // ---- Job 端口（真存储；计数端口从账本内存派生）----
  const qualifiedCount = (targetUserId: string, throughSequence: number): number => {
    let count = 0
    for (const event of seeded) {
      if (event.sequence > throughSequence) continue
      const view = processorEventViewOf(event)
      if (view.type !== 'user_message') continue
      if (sourceQualificationOf(view.trustedOrigin) !== 'ESTABLISHED') continue
      const originator = view.trustedOrigin?.contentOriginator
      if (originator === undefined || originator.state !== 'KNOWN') continue
      if (String(originator.value.id) !== targetUserId) continue
      count += 1
    }
    return count
  }
  const activeDayCount = (targetUserId: string, throughSequence: number): number => {
    const days = new Set<string>()
    for (const event of seeded) {
      if (event.sequence > throughSequence) continue
      const view = processorEventViewOf(event)
      if (view.type !== 'user_message') continue
      if (sourceQualificationOf(view.trustedOrigin) !== 'ESTABLISHED') continue
      const originator = view.trustedOrigin?.contentOriginator
      if (originator === undefined || originator.state !== 'KNOWN') continue
      if (String(originator.value.id) !== targetUserId) continue
      days.add(relationshipDayOf(event.createdAt))
    }
    return days.size
  }

  const ports: RelationshipJobPorts = {
    registry,
    loadWindowEvents: (cid, from, to) => conversationEventsInRange(db, cid, from, to, 2000),
    getRelationshipState: async (cid, key) =>
      (await getRelationshipProjection(db, cid, entityRef('user', key.target)))?.state,
    getDomainEvent: async (id) => {
      const event = await getDomainEvent(db, id)
      return event === undefined ? undefined : { id: event.id, type: event.type }
    },
    hasProcessed: (key) => hasProcessedOperation(db, key),
    applyAccepted: (cid, accepted, reducers, now) =>
      applyAcceptedEvents(db, cid, accepted, reducers, now),
    countQualifiedMessages: async (_cid, targetUserId, through) =>
      qualifiedCount(targetUserId, through),
    countActiveDays: async (_cid, targetUserId, through) => activeDayCount(targetUserId, through),
  }
  const validatorDeps = {
    registry,
    evidence: {
      findEvents: async (ids: readonly ConversationEventId[]) => {
        const wanted = new Set(ids.map((id) => String(id)))
        return seeded
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
    relationships: {
      getRelationshipState: async (cid: typeof characterId, key: Parameters<RelationshipJobPorts['getRelationshipState']>[1]) =>
        (await getRelationshipProjection(db, cid, entityRef('user', key.target)))?.state,
    },
    events: {
      getDomainEvent: async (id: Parameters<RelationshipJobPorts['getDomainEvent']>[0]) => {
        const event = await getDomainEvent(db, id)
        return event === undefined ? undefined : { id: event.id, type: event.type }
      },
    },
  }

  // ---- ORIGIN 建档助手 ----
  const NOW = Date.now()
  let originEvents = 0
  async function seedOrigin(targetUserId: string): Promise<void> {
    const payload: RelationshipOriginPayload = {
      key: { owner: asEntityId(String(characterId)), target: targetUserId as never },
      targetKind: 'user',
      trust: 0.85,
      closeness: 0.6,
      originKind: 'SETTING_BASELINE',
      basis: '用户 2026-09 授权的角色设定（M7 WP4 验证门种子，ADR-064 U-M7-02）',
    }
    const proposal = createProposal({
      characterId,
      proposalType: RELATIONSHIP_ORIGIN_PROPOSAL_TYPE,
      sourceConversationEventIds: [],
      payload: { targetUserId, basis: payload.basis },
      targetEvents: [{ type: RELATIONSHIP_ORIGIN, operation: 'create', payload }],
      processor: 'relationship-origin-seeder',
      processorVersion: 'relationship-origin-seeder@1',
    })
    const outcome = await validateRelationshipProposal(validatorDeps, proposal)
    if (!outcome.accepted) {
      throw new Error(`ORIGIN 建档被拒：${outcome.rejected.map((r) => r.code).join(', ')}`)
    }
    const applied = await applyAcceptedEvents(
      db,
      characterId,
      outcome.acceptedEvents,
      [relationshipReducerFor(owner, entityRef('user', targetUserId))],
      NOW
    )
    originEvents += applied.createdCount
  }

  const stateOf = async (targetUserId: string): Promise<RelationshipState | undefined> =>
    (await getRelationshipProjection(db, characterId, entityRef('user', targetUserId)))?.state
  const revisionOf = async (targetUserId: string): Promise<number | undefined> =>
    (await getRelationshipProjection(db, characterId, entityRef('user', targetUserId)))?.revision

  // ===========================================================================
  // 正控
  // ===========================================================================

  // P1：ORIGIN 建档 → 基线状态 + 信封
  await seedOrigin('m7-user-1')
  const p1State = await stateOf('m7-user-1')
  record(
    'P1',
    'ORIGIN 建档：基线 {0.85, 0.6} · SETTING_BASELINE · 锚=事件时间 · 在案空',
    'originated · trust=0.85 · closeness=0.6 · accusations=0',
    p1State !== undefined
      ? `originated=${String(p1State.originated)} · trust=${String(p1State.trust)} · closeness=${String(p1State.closeness)} · accusations=${String(p1State.accusationsInCase.length)}`
      : '无投影行',
    p1State !== undefined &&
      p1State.originated &&
      near(p1State.trust, 0.85) &&
      near(p1State.closeness, 0.6) &&
      p1State.originKind === 'SETTING_BASELINE' &&
      p1State.accusationsInCase.length === 0 &&
      p1State.lastInteractionAt === NOW,
  )

  // P2：W1（两日 12 条 + 感谢）→ r2×1 + r1×2 落库，状态精确推进
  const p2 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 1,
    toSequence: 12,
    now: NOW,
  })
  const p2State = await stateOf('m7-user-1')
  record(
    'P2',
    'W1 陪伴窗口：r2×1 + r1×2（按日）→ trust 0.85→0.87 · closeness 0.6→0.66',
    'proposals=3 · created=3 · trust=0.87 · closeness=0.66',
    `proposals=${String(p2.proposals)} · created=${String(p2.applied.createdCount)} · trust=${String(p2State?.trust)} · closeness=${String(p2State?.closeness)}`,
    p2.proposals === 3 &&
      p2.applied.createdCount === 3 &&
      p2State !== undefined &&
      near(p2State.trust, 0.87) &&
      near(p2State.closeness, 0.66),
  )
  const p2Revision = await revisionOf('m7-user-1')
  record(
    'P2b',
    '投影信封：revision = ORIGIN(1) + 3 次 IMPACT 折叠 = 4',
    'revision=4',
    `revision=${String(p2Revision)}`,
    p2Revision === 4,
  )

  // P3（重复失败关闭）：同窗口重跑 → 领域幂等键全命中 → 零新建、状态不动
  const p3 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 1,
    toSequence: 12,
    now: NOW,
  })
  const p3State = await stateOf('m7-user-1')
  record(
    'P3',
    '同窗口重跑：提案相同 → 幂等键命中 → created=0 · 全部 duplicate_operation · 状态不动',
    'created=0 · rejected=3 · trust=0.87 不变',
    `created=${String(p3.applied.createdCount)} · rejected=${String(p3.rejectedProposals)} · codes=${p3.rejections.map((r) => r.code).join('/')}`,
    p3.applied.createdCount === 0 &&
      p3.rejectedProposals === 3 &&
      p3.rejections.every((r) => r.code === 'duplicate_operation') &&
      p3State !== undefined &&
      near(p3State.trust, 0.87) &&
      near(p3State.closeness, 0.66),
  )

  // P4：W2 指控 → r3 落库 · 指进入案登记表
  const p4 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 13,
    toSequence: 13,
    now: NOW,
  })
  const p4State = await stateOf('m7-user-1')
  record(
    'P4',
    'W2 指控：r3 → trust 0.87→0.82 · closeness 0.66→0.64 · 在案登记 +1',
    'created=1 · trust=0.82 · closeness=0.64 · accusations=1',
    `created=${String(p4.applied.createdCount)} · trust=${String(p4State?.trust)} · closeness=${String(p4State?.closeness)} · accusations=${String(p4State?.accusationsInCase.length)}`,
    p4.applied.createdCount === 1 &&
      p4State !== undefined &&
      near(p4State.trust, 0.82) &&
      near(p4State.closeness, 0.64) &&
      p4State.accusationsInCase.length === 1,
  )
  const accusationEventId = p4State?.accusationsInCase[0]?.domainEventId

  // P5：W3 撤回 → supersede · **反扣**（旧事件不再驱动投影）
  const p5 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 14,
    toSequence: 14,
    now: NOW,
  })
  const p5State = await stateOf('m7-user-1')
  record(
    'P5',
    'W3 撤回（R-4b）：反扣指控（+0.05/+0.02）再修复（+0.03）→ trust=0.90 · closeness=0.66 · 在案清空',
    'created=1 · operation=supersede · trust=0.90 · accusations=0',
    `created=${String(p5.applied.createdCount)} · trust=${String(p5State?.trust)} · closeness=${String(p5State?.closeness)} · accusations=${String(p5State?.accusationsInCase.length)}`,
    p5.applied.createdCount === 1 &&
      p5State !== undefined &&
      near(p5State.trust, 0.9) &&
      near(p5State.closeness, 0.66) &&
      p5State.accusationsInCase.length === 0,
  )
  record(
    'P5b',
    '"旧事件不再驱动投影"的字面验证：0.82 −(−0.05) +0.03 = 0.90（不是 0.82+0.03=0.85）',
    'trust 精确 = 指控前(0.87) + 修复(+0.03)',
    `trust=${String(p5State?.trust)}（若未反扣应为 0.85）`,
    p5State !== undefined && near(p5State.trust, 0.9) && !near(p5State.trust, 0.85),
  )

  // P6：多目标隔离——user-2 建档 + 感谢 → 只动 user-2 的行
  await seedOrigin('m7-user-2')
  const user1Before = await getRelationshipProjection(db, characterId, entityRef('user', 'm7-user-1'))
  const p6 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 15,
    toSequence: 15,
    now: NOW,
  })
  const p6User2 = await stateOf('m7-user-2')
  const user1After = await getRelationshipProjection(db, characterId, entityRef('user', 'm7-user-1'))
  const user1Untouched =
    user1Before !== undefined &&
    user1After !== undefined &&
    JSON.stringify(user1Before.state) === JSON.stringify(user1After.state) &&
    user1Before.revision === user1After.revision &&
    user1Before.lastDomainEventSequence === user1After.lastDomainEventSequence
  record(
    'P6',
    '多目标隔离：user-2 的感谢只动 user-2 行（0.85→0.87/0.6→0.62）；user-1 行逐字段不动',
    'user2 trust=0.87 · user1 行不动（state+revision+lastSeq）',
    `user2 trust=${String(p6User2?.trust)} · user1 不动=${String(user1Untouched)} · created=${String(p6.applied.createdCount)}`,
    p6.applied.createdCount === 1 &&
      p6User2 !== undefined &&
      near(p6User2.trust, 0.87) &&
      near(p6User2.closeness, 0.62) &&
      user1Untouched,
  )

  // ===========================================================================
  // 负控（全部零事件落库）
  // ===========================================================================

  const eventsBefore = await countDomainEvents(db, characterId)

  function craftedImpact(overrides: {
    target: string
    delta?: { trust: number; closeness: number }
    originKind?: 'INTERACTION_DERIVED' | 'MAINTENANCE_INJECTION'
    supersedes?: { domainEventId: string; reason: string }
    owner?: string
    sourceId?: ConversationEventId
  }): DomainProposal {
    const payload: RelationshipImpactPayload = {
      key: { owner: (overrides.owner ?? String(characterId)) as never, target: overrides.target as never },
      targetKind: 'user',
      delta: overrides.delta ?? { trust: 0.02, closeness: 0.02 },
      ruleId: 'r2',
      unit: 'window',
      originKind: overrides.originKind ?? 'INTERACTION_DERIVED',
      ...(overrides.supersedes !== undefined
        ? { supersedes: { domainEventId: overrides.supersedes.domainEventId as never, reason: overrides.supersedes.reason } }
        : {}),
    }
    return createProposal({
      characterId,
      proposalType: 'relationship-impact',
      sourceConversationEventIds: [overrides.sourceId ?? firstUserId],
      payload: { note: 'crafted negative' },
      targetEvents: [{ type: RELATIONSHIP_IMPACT, operation: 'update', payload }],
      processor: 'wp4-verify-crafter',
      processorVersion: 'wp4-verify-crafter@1',
    })
  }

  const expectReject = async (
    id: string,
    label: string,
    proposal: DomainProposal,
    code: string
  ): Promise<void> => {
    const outcome = await validateRelationshipProposal(validatorDeps, proposal)
    const codes = outcome.rejected.map((r) => r.code)
    record(
      id,
      label,
      `reject: ${code}`,
      outcome.accepted ? 'ACCEPTED（缺陷！）' : `reject: ${codes.join('/')}`,
      !outcome.accepted && codes.includes(code),
    )
  }

  // N1：未建档先变化
  await expectReject(
    'N1',
    '负控：IMPACT 指向从未建档的 user-9 → relationship_origin_missing',
    craftedImpact({ target: 'm7-user-9' }),
    'relationship_origin_missing',
  )
  // N2：超界 delta（拒绝，不静默夹）
  await expectReject(
    'N2',
    '负控：delta.trust=0.06 超出单事件上限 → relationship_delta_out_of_bounds',
    craftedImpact({ target: 'm7-user-1', delta: { trust: 0.06, closeness: 0 } }),
    'relationship_delta_out_of_bounds',
  )
  // N3：注入来源失败关闭
  const injectionPayload: RelationshipOriginPayload = {
    key: { owner: asEntityId(String(characterId)), target: 'm7-user-9' as never },
    targetKind: 'user',
    trust: 0.9,
    closeness: 0.9,
    originKind: 'MAINTENANCE_INJECTION',
    basis: 'crafted injection',
  }
  await expectReject(
    'N3',
    '负控：MAINTENANCE_INJECTION 建档 → relationship_origin_injection_not_enabled（登记但不开闸）',
    createProposal({
      characterId,
      proposalType: RELATIONSHIP_ORIGIN_PROPOSAL_TYPE,
      sourceConversationEventIds: [],
      payload: {},
      targetEvents: [{ type: RELATIONSHIP_ORIGIN, operation: 'create', payload: injectionPayload }],
      processor: 'wp4-verify-crafter',
      processorVersion: 'wp4-verify-crafter@1',
    }),
    'relationship_origin_injection_not_enabled',
  )
  // N4：证据不合格（她的生成）
  await expectReject(
    'N4',
    '负控：引用她的生成（assistant_message，无受信信封）→ relationship_evidence_not_qualified',
    craftedImpact({ target: 'm7-user-1', sourceId: assistantAppend.event.id }),
    'relationship_evidence_not_qualified',
  )
  // N5：双重建档
  await expectReject(
    'N5',
    '负控：user-1 二次 ORIGIN → relationship_origin_already_exists',
    createProposal({
      characterId,
      proposalType: RELATIONSHIP_ORIGIN_PROPOSAL_TYPE,
      sourceConversationEventIds: [],
      payload: {},
      targetEvents: [
        {
          type: RELATIONSHIP_ORIGIN,
          operation: 'create',
          payload: {
            key: { owner: asEntityId(String(characterId)), target: 'm7-user-1' as never },
            targetKind: 'user',
            trust: 0.5,
            closeness: 0.5,
            originKind: 'SETTING_BASELINE',
            basis: 'crafted double origin',
          } satisfies RelationshipOriginPayload,
        },
      ],
      processor: 'wp4-verify-crafter',
      processorVersion: 'wp4-verify-crafter@1',
    }),
    'relationship_origin_already_exists',
  )
  // N6：撤回不在案的目标（已被 P5 撤回过）
  await expectReject(
    'N6',
    '负控：撤回指向已撤回过的指控 → relationship_supersedes_invalid（防双撤回）',
    craftedImpact({
      target: 'm7-user-1',
      supersedes: { domainEventId: String(accusationEventId), reason: 'crafted double retraction' },
    }),
    'relationship_supersedes_invalid',
  )
  // N7：owner 伪造
  await expectReject(
    'N7',
    '负控：payload.key.owner=别的角色 → relationship_owner_mismatch',
    craftedImpact({ target: 'm7-user-1', owner: 'char_other' }),
    'relationship_owner_mismatch',
  )

  const eventsAfter = await countDomainEvents(db, characterId)
  record(
    'N8',
    '负控汇总：七条负控全部 reject 且**零事件落库**（count 不变）',
    `events ${String(eventsBefore)} → ${String(eventsBefore)}`,
    `events ${String(eventsBefore)} → ${String(eventsAfter)}`,
    eventsAfter === eventsBefore,
  )

  // ===========================================================================
  // 恢复
  // ===========================================================================

  // R1：负控之后，新正控窗口照常落库（检测器重新安静且灵敏）
  const r1 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 17,
    toSequence: 17,
    now: NOW,
  })
  const r1State = await stateOf('m7-user-1')
  record(
    'R1',
    '恢复：W5 新感谢 → r2 落库 · trust 0.90→0.92 · closeness 0.66→0.68',
    'created=1 · trust=0.92 · closeness=0.68',
    `created=${String(r1.applied.createdCount)} · trust=${String(r1State?.trust)} · closeness=${String(r1State?.closeness)}`,
    r1.applied.createdCount === 1 &&
      r1State !== undefined &&
      near(r1State.trust, 0.92) &&
      near(r1State.closeness, 0.68),
  )

  // R2：R-5 里程碑跨过（账本派生计数 prior=15 → after=115）
  const r2 = await runRelationshipEvaluation(ports, {
    characterId,
    owner,
    fromSequence: 18,
    toSequence: 117,
    now: NOW,
  })
  const r2State = await stateOf('m7-user-1')
  record(
    'R2',
    '恢复：W6 100 条平淡消息 → R-5 跨过 messages-100 → closeness 0.68→0.71（trust 不动）',
    'created=1 · closeness=0.71 · trust=0.92',
    `created=${String(r2.applied.createdCount)} · closeness=${String(r2State?.closeness)} · trust=${String(r2State?.trust)}`,
    r2.applied.createdCount === 1 &&
      r2State !== undefined &&
      near(r2State.closeness, 0.71) &&
      near(r2State.trust, 0.92),
  )

  // R3：删投影 → rebuild → 逐字段一致（A==B；两个目标都验）
  // ⚠️ 比较必须**键序无关**：PG jsonb 会把对象的键重排成规范化顺序，
  // 库里读回的 state 与重建的内存 state 键序不同——逐字 stringify 比较
  // 会在语义相等时假阴性。canonical() 递归排序键后再比。
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  for (const targetUserId of ['m7-user-1', 'm7-user-2']) {
    const target = entityRef('user', targetUserId)
    const before = await getRelationshipProjection(db, characterId, target)
    await deleteProjection(db, characterId, relationshipProjectionType(target))
    const rebuilt = await rebuildRelationshipProjection(db, characterId, owner, target, NOW)
    const after = await getRelationshipProjection(db, characterId, target)
    const fieldsEqual =
      before !== undefined &&
      after !== undefined &&
      canonical(before.state) === canonical(after.state) &&
      canonical(before.state) === canonical(rebuilt.projection.state) &&
      before.revision === after.revision &&
      before.revision === rebuilt.projection.revision &&
      String(before.lastDomainEventId) === String(after.lastDomainEventId) &&
      before.lastDomainEventSequence === after.lastDomainEventSequence &&
      before.reducerVersion === after.reducerVersion
    record(
      targetUserId === 'm7-user-1' ? 'R3' : 'R3b',
      `投影是缓存：${targetUserId} 删行 → rebuild → 逐字段一致（state/revision/lastEvent/reducerVersion；键序无关比较）`,
      'A == B',
      fieldsEqual
        ? `A == B（revision=${String(rebuilt.projection.revision)} · applied=${String(rebuilt.appliedEvents)}）`
        : `A != B（before rev=${String(before?.revision)} rebuilt rev=${String(rebuilt.projection.revision)}）`,
      fieldsEqual,
    )
  }

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length
  const totalCreated =
    originEvents +
    p2.applied.createdCount +
    p4.applied.createdCount +
    p5.applied.createdCount +
    p6.applied.createdCount +
    r1.applied.createdCount +
    r2.applied.createdCount

  const stagesValid = positive > 0 && negative > 0 && recovery > 0 && totalCreated > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp4-verify', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp4-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    propositions: {
      failClosed: '七类非法提案全部 reject 且零事件落库',
      fold: 'ORIGIN 建档 · IMPACT 有界 · 撤回反扣（旧事件不再驱动投影）· 指进入案登记表',
      duplicate: '同窗口重跑 → 领域幂等键全命中 → created=0 状态不动',
      isolation: 'per-target 信封不前进（user-2 的事件不碰 user-1 的行）',
      replay: '删投影 → rebuild → 逐字段一致（两个目标）',
      realChain: '真实 store + appendUserStatement 受信归因 → ESTABLISHED 全链路 + R-5 账本派生计数',
    },
    stages: { positive, negative, recovery },
    measured: { eventsCreated: totalCreated, checks: checks.length },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp4-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'component-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'M7 WP4 部件门：验证器失败关闭 + reducer 折叠/反扣 + 幂等 + 多目标隔离 + rebuild A==B（隔离库）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)} · 事件落库=${String(totalCreated)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

await main()
