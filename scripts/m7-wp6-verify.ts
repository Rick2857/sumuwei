/**
 * M7 WP6 —— **生产调度 + 端到端 Level 2 部件门**（`pnpm m7:wp6:verify`）。
 *
 * ============================================================================
 *  要证明的命题（计划 §5 WP6 出口 + WP4 交接单 §6 留给 WP6 的装配工作）
 * ============================================================================
 * ① 生产调度（攒尾窗策略）：语义规则**即时**消费（指控影响下一轮）；
 *    零提案窗口**持有**（R-1 的 ≥10 条跨 2 日累积才可能成立）；
 *    R-5 里程碑兜底 ⇒ 零提案尾窗天然有界。
 * ② 全链 Level 2 关联：同一条 conversationEventId 从账本 → 提案 → 域事件
 *    （sourceConversationEventIds）→ 投影 revision → 关系注入块 sourceRefs
 *    → 读回，逐环可对上（计划 §7.2 Level 2）。
 * ③ 规则链值语义（真存储、真放行口、真折叠）：R-2/R-3/R-4b 反扣/R-1/R-5
 *    的期望值逐项验证（含撤回反扣的"净 = 指控前 + 0.03"）。
 * ④ 联合行为跨档：规则驱动的状态走到"很亲近但不信"档 ⇒ 注入块措辞
 *    切到"被辜负"（两维不合并，经生产渲染路径）。
 * ⑤ 负控：她的生成不驱动 · 未确立归因不驱动 · 多目标隔离（未建档目标
 *    IMPACT 被拒且不碰别人的行）· 同窗重跑领域键全命中。
 * ⑥ 恢复：重启追赶（缺口被后续窗口覆盖）· job 失败后同键重建 ·
 *    水位持久（新实例 no_tail）。
 * ⑦ 真 TurnGateway 全链：beginTurn（真 ingress）→ compileTurn（关系注入块
 *    经 WP5 接线进 packet）→ completeTurn → 轮后调度消费网关事件——
 *    计划 §7.2 Level 2 的"真网关"形状，Level 2 关联在网关写的事件上复验。
 *
 * 不主张（Live 归 WP6-B，另需用户授权）：Level 1 真模型回复、长轨迹、
 * TD-06 行为基线。本门全部离线（无模型调用）。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m7-wp6-verify', { keep: false })



import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  renderCriticalStateSection,
  renderRelationshipReadback,
  renderRelationshipSection,
  seedRelationshipOrigin,
} from '../src/infrastructure/runtime/adapters.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  createRelationshipJobPorts,
  maybeRunRelationshipEvaluation,
  relationshipOwnerOf,
  type RelationshipSchedulerOutcome,
} from '../src/infrastructure/runtime/relationship-scheduler.ts'
import { runRelationshipEvaluation } from '../src/kernel/app/relationship/job.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import {
  appendConversationEvent,
  latestCharacterEventSequence,
  latestConversationSequence,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { countDomainEvents, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import {
  enqueueJob,
  finishJob,
  getWatermark,
} from '../src/infrastructure/persistence/job-store.ts'
import { getRelationshipProjection } from '../src/infrastructure/persistence/relationship-store.ts'
import { asConversationId, type CharacterId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  RELATIONSHIP_EVALUATOR_NAME,
  RELATIONSHIP_EVALUATOR_VERSION,
} from '../src/kernel/app/relationship/evaluator.ts'
import { relationshipEvaluationIdempotencyKey } from '../src/kernel/app/relationship/job.ts'
import { buildContextCompilerV2, SECTION_IDS } from '../src/kernel/context/sections.ts'
import { baselineIdentity } from './m3.5-prompt-baseline.ts'
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
  // ---- 固定时间线（UTC+8 自然日：DAY1=09-25 … DAY7=10-01）----
  const day = (n: number) => Date.UTC(2026, 8, 24 + n, 2, 0, 0)
  const DAY1 = day(1)
  const DAY4 = day(4)
  const DAY5 = day(5)
  const DAY6 = day(6)
  const DAY7 = day(7)

  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const owner = relationshipOwnerOf(characterId)
  const USER1 = 'm7-wp6-user-1'
  const USER2 = 'm7-wp6-user-2'

  const ledger = createConversationLedger({
    db,
    attribution: [createHumanConsoleUserTurnIngress()],
  })
  const conversationId = asConversationId('m7-wp6-verify-conversation')
  let convSeq = 0
  const appendUser = async (userId: string, content: string, createdAt: number) => {
    convSeq += 1
    return ledger.appendUserStatement({
      characterId,
      conversationId,
      userId,
      content,
      createdAt,
      conversationSequence: convSeq,
    })
  }

  // ---- 播种（WP5 的生产入口）----
  const seeded = await seedRelationshipOrigin(runtime, String(characterId), USER1, DAY1)
  const target1 = entityRef('user', USER1)
  const projectionOf = () => getRelationshipProjection(db, characterId, target1)

  // ===========================================================================
  // 正控：生产调度链（攒尾窗策略 + 值语义 + Level 2 关联）
  // ===========================================================================

  // P1：播种后无尾窗
  const p1 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY1 })
  record(
    'P1',
    '播种后调度：无账本事件 ⇒ no_tail（水位 0 = 账本 0）',
    'kind=no_tail',
    `kind=${p1.kind}`,
    p1.kind === 'no_tail',
  )

  // P2：R-2 感谢 → 即时消费（语义规则不等窗口攒够）
  const thanks = await appendUser(USER1, '谢谢你昨晚陪我聊到那么晚', DAY1)
  const p2 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY1 })
  const p2State = (await projectionOf())?.state
  const p2ok =
    p2.kind === 'flushed' &&
    p2.proposals === 1 &&
    p2.acceptedProposals === 1 &&
    p2.createdEvents === 1 &&
    p2State !== undefined &&
    near(p2State.trust, 0.87) &&
    near(p2State.closeness, 0.62)
  record(
    'P2',
    'R-2 即时消费：感谢 → 提案1/放行1/域事件1 · trust 0.85→0.87 · closeness 0.60→0.62',
    'flushed(1/1/1) · 0.87/0.62',
    `${p2.kind === 'flushed' ? `flushed(${String(p2.proposals)}/${String(p2.acceptedProposals)}/${String(p2.createdEvents)})` : p2.kind} · ${p2State ? `${p2State.trust.toFixed(2)}/${p2State.closeness.toFixed(2)}` : '无投影'}`,
    p2ok,
  )

  // P3：R-3 指控 → 即时消费 · 在案登记
  const accusation = await appendUser(USER1, '你骗我，你明明说过今天陪我的', DAY1)
  const p3 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY1 })
  const p3Projection = await projectionOf()
  const p3State = p3Projection?.state
  const p3ok =
    p3.kind === 'flushed' &&
    p3State !== undefined &&
    near(p3State.trust, 0.82) &&
    near(p3State.closeness, 0.6) &&
    p3State.accusationsInCase.length === 1 &&
    p3Projection?.revision === 3
  record(
    'P3',
    'R-3 指控即时消费：trust 0.87→0.82 · closeness 0.62→0.60 · 在案 1 · revision 3',
    '0.82/0.60 · 在案1 · r3',
    `${p3State ? `${p3State.trust.toFixed(2)}/${p3State.closeness.toFixed(2)}` : '无投影'} · 在案${String(p3State?.accusationsInCase.length ?? -1)} · r${String(p3Projection?.revision ?? -1)}`,
    p3ok,
  )

  // P3b：Level 2 关联（指控在案时）——事件 id → 域事件 → 投影 → 注入块 → 读回
  const p3DomainEvents = await domainEventsFor(db, characterId)
  const r3Event = p3DomainEvents.find(
    (e) => e.type === 'RELATIONSHIP_IMPACT' && JSON.stringify(e.payload).includes('"r3"'),
  )
  const p3Section = await renderRelationshipSection(runtime, String(characterId), USER1, DAY1)
  const p3Readback = await renderRelationshipReadback(runtime, String(characterId), USER1, DAY1)
  const p3bok =
    r3Event !== undefined &&
    r3Event.sourceConversationEventIds.map(String).includes(String(accusation.event.id)) &&
    p3Section !== undefined &&
    p3Section.sourceRefs.includes('projection:relationship:r3') &&
    p3Readback.includes('在案指控') &&
    p3Readback.includes('1 条')
  record(
    'P3b',
    'Level 2 关联：指控事件 id ∈ 域事件来源 · 注入块 sourceRefs=r3 · 读回在案 1 条',
    '逐环可对上',
    `域事件来源含指控=${String(r3Event?.sourceConversationEventIds.map(String).includes(String(accusation.event.id)))} · sourceRefs r3=${String(p3Section?.sourceRefs.includes('projection:relationship:r3'))} · 读回在案=${p3Readback.includes('在案指控') && p3Readback.includes('1 条')}`,
    p3bok,
  )

  // P4：R-4b 撤回 → supersede 反扣（净 = 指控前 + 0.03）
  await appendUser(USER1, '对不起，我错怪你了', DAY1)
  const p4 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY1 })
  const p4Projection = await projectionOf()
  const p4State = p4Projection?.state
  const p4ok =
    p4.kind === 'flushed' &&
    p4State !== undefined &&
    near(p4State.trust, 0.9) &&
    near(p4State.closeness, 0.62) &&
    p4State.accusationsInCase.length === 0 &&
    p4Projection?.revision === 4
  record(
    'P4',
    'R-4b 撤回反扣：un-apply(−0.05) 再 +0.03 ⇒ trust 0.90（净=指控前+0.03）· 在案清空 · r4',
    '0.90/0.62 · 在案0 · r4',
    `${p4State ? `${p4State.trust.toFixed(2)}/${p4State.closeness.toFixed(2)}` : '无投影'} · 在案${String(p4State?.accusationsInCase.length ?? -1)} · r${String(p4Projection?.revision ?? -1)}`,
    p4ok,
  )

  // P5：R-1 攒尾窗——6 条单日 ⇒ 持有；补 4 条跨日 ⇒ 消费 2 个日单元
  for (let i = 1; i <= 6; i += 1) await appendUser(USER1, `day2 日常 ${String(i)}`, DAY4)
  const p5a = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY4 })
  const p4Latest = p4.kind === 'flushed' ? p4.latest : -1
  const watermarkAfterP5a = (
    await getWatermark(db, characterId, RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION)
  )?.processedThroughSequence
  const p5aok = p5a.kind === 'held' && p5a.tailEvents === 6 && watermarkAfterP5a === p4Latest
  record(
    'P5a',
    '攒尾窗（持有）：6 条单日零提案 ⇒ 不消费、水位不动（R-1 需 ≥10 条跨 2 日）',
    `held(6) · 水位停在 ${String(p4Latest)}`,
    `${p5a.kind}${p5a.kind === 'held' ? `(${String(p5a.tailEvents)})` : ''} · 水位=${String(watermarkAfterP5a ?? -1)}`,
    p5aok,
  )
  for (let i = 1; i <= 4; i += 1) await appendUser(USER1, `day3 日常 ${String(i)}`, DAY5)
  const p5b = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY5 })
  const p5State = (await projectionOf())?.state
  // 期望值含 §5.1 事件间侵蚀：首个 r1 事件在 DAY5 应用 ⇒ 先结 DAY1→DAY5
  // 的净蚀 3 天 ×0.02 = −0.06，再 +0.02×2 ⇒ 0.62−0.06+0.04 = 0.60
  const p5bok =
    p5b.kind === 'flushed' &&
    p5b.proposals === 2 &&
    p5b.createdEvents === 2 &&
    p5State !== undefined &&
    near(p5State.closeness, 0.6)
  record(
    'P5b',
    '攒尾窗（消费）：累计 10 条跨 2 日 ⇒ 2 个日单元；含事件间侵蚀（DAY1→DAY5 净蚀 −0.06）⇒ closeness 0.62→0.60',
    'flushed(2) · 0.60（侵蚀感知）',
    `${p5b.kind === 'flushed' ? `flushed(${String(p5b.proposals)})` : p5b.kind} · ${p5State ? p5State.closeness.toFixed(4) : '无投影'}`,
    p5bok,
  )

  // P6：R-5 里程碑——补 87 条跨过第 100 条合格消息（锚点已在 DAY5 ⇒ 无侵蚀）
  for (let i = 1; i <= 87; i += 1) await appendUser(USER1, `mile ${String(i)}`, DAY5)
  const p6 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY5 })
  const p6State = (await projectionOf())?.state
  const p6ok =
    p6.kind === 'flushed' &&
    p6.proposals === 1 &&
    p6State !== undefined &&
    near(p6State.closeness, 0.63)
  record(
    'P6',
    'R-5 里程碑：第 100 条合格消息跨过 ⇒ closeness 0.60→0.63（里程碑幂等键；锚点同日无侵蚀）',
    'flushed(1) · 0.63',
    `${p6.kind === 'flushed' ? `flushed(${String(p6.proposals)})` : p6.kind} · ${p6State ? p6State.closeness.toFixed(4) : '无投影'}`,
    p6ok,
  )

  // P7a：联合行为前置——单日块持有（第二例持有读数）+ 跨日块消费，
  //     再 8 个连续 R-1 窗口攒亲近（每窗净 +0.02：侵蚀 −0.02 + 双日单元 +0.04）
  for (let i = 1; i <= 10; i += 1) await appendUser(USER1, `day5 陪伴 ${String(i)}`, DAY6)
  const p7aHeld = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY6 })
  const p7aHeldOk = p7aHeld.kind === 'held'
  record(
    'P7a-1',
    '持有第二例：10 条单日（DAY6）⇒ 零提案持有（minDays=2 不满足）',
    'held',
    p7aHeld.kind,
    p7aHeldOk,
  )
  for (let i = 1; i <= 10; i += 1) await appendUser(USER1, `day6 陪伴 ${String(i)}`, DAY7)
  const p7aFlush = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: DAY7 })
  const p7aFlushState = (await projectionOf())?.state
  // 期望：锚点 DAY5→DAY7 净蚀 1 天（−0.02）+ day6/day7 两单元（+0.04）⇒ 0.63+0.02=0.65
  const p7aFlushOk =
    p7aFlush.kind === 'flushed' &&
    p7aFlush.proposals === 2 &&
    p7aFlushState !== undefined &&
    near(p7aFlushState.closeness, 0.65)
  record(
    'P7a-2',
    '跨日消费：DAY6+DAY7 共 20 条 ⇒ day6/day7 两单元；含净蚀 −0.02 ⇒ closeness 0.63→0.65',
    'flushed(2) · 0.65',
    `${p7aFlush.kind === 'flushed' ? `flushed(${String(p7aFlush.proposals)})` : p7aFlush.kind} · ${p7aFlushState ? p7aFlushState.closeness.toFixed(4) : '无投影'}`,
    p7aFlushOk,
  )
  // 8 个连续 R-1 窗口（days 8–23，每窗 5+5 条跨两日）：每窗净 +0.02（侵蚀 −0.02
  // + 双日单元 +0.04）；第 8 窗合格消息累计到 200 ⇒ R-5 第 2 里程碑同窗触发（+0.03）
  const windowOutcomes: { kind: string; proposals: number }[] = []
  for (let w = 1; w <= 8; w += 1) {
    const dayA = day(6 + 2 * w)
    const dayB = day(7 + 2 * w)
    for (let i = 1; i <= 5; i += 1) await appendUser(USER1, `w${String(w)}a 陪伴 ${String(i)}`, dayA)
    for (let i = 1; i <= 5; i += 1) await appendUser(USER1, `w${String(w)}b 陪伴 ${String(i)}`, dayB)
    const outcome = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: dayB })
    windowOutcomes.push({
      kind: outcome.kind,
      proposals: outcome.kind === 'flushed' ? outcome.proposals : -1,
    })
  }
  const p7a3State = (await projectionOf())?.state
  // 期望：窗 1–7 各 2 个日单元；窗 8 = 2 日单元 + R-5 里程碑 2（第 200 条）= 3；
  // closeness = 0.65 + 7×0.02 + (−0.02+0.04+0.03) = 0.84
  const p7a3ok =
    p7a3State !== undefined &&
    near(p7a3State.closeness, 0.84) &&
    windowOutcomes.length === 8 &&
    windowOutcomes.slice(0, 7).every((o) => o.kind === 'flushed' && o.proposals === 2) &&
    windowOutcomes[7]!.kind === 'flushed' &&
    windowOutcomes[7]!.proposals === 3
  record(
    'P7a-3',
    '连续 8 个 R-1 窗口（days 8–23）：窗 1–7 各 2 日单元；窗 8 叠加 R-5 里程碑 2（第 200 条合格消息）⇒ closeness 0.65→0.84',
    '7×flushed(2) + flushed(3) · 0.84',
    `${windowOutcomes.map((o) => `${o.kind}${o.kind === 'flushed' ? `(${String(o.proposals)})` : ''}`).join(' ')} · ${p7a3State ? p7a3State.closeness.toFixed(4) : '无投影'}`,
    p7a3ok,
  )

  // P7b：联合行为跨档——12 连指控（同日，无侵蚀）⇒ trust 0.30 / closeness 0.60
  //     ⇒ "很亲近但不信"（closeness ≥0.5）⇒ 注入块切到"被辜负"
  const ACCUSE_DAY = day(23)
  for (let i = 1; i <= 12; i += 1) {
    await appendUser(USER1, '你骗我，你明明说过今天陪我的', ACCUSE_DAY)
    await maybeRunRelationshipEvaluation(db, { characterId, owner, now: ACCUSE_DAY })
  }
  const p7State = (await projectionOf())?.state
  const p7Section = await renderRelationshipSection(runtime, String(characterId), USER1, ACCUSE_DAY)
  const p7bok =
    p7State !== undefined &&
    near(p7State.trust, 0.3) &&
    near(p7State.closeness, 0.6) &&
    p7State.accusationsInCase.length === 12 &&
    p7Section !== undefined &&
    p7Section.text.includes('被辜负')
  record(
    'P7b',
    '联合行为跨档：12 连指控 ⇒ trust 0.90→0.30 / closeness 0.84→0.60（很亲近但不信）⇒ 注入块措辞切到"被辜负"',
    '0.30/0.60 · 在案12 · 含被辜负',
    `${p7State ? `${p7State.trust.toFixed(2)}/${p7State.closeness.toFixed(2)} · 在案${String(p7State.accusationsInCase.length)}` : '无投影'} · 被辜负=${String(p7Section?.text.includes('被辜负'))}`,
    p7bok,
  )

  // ===========================================================================
  // 负控 + 恢复（时间线前移到 day24：P7 已把锚点推到 day23，不造倒退事件）
  // ===========================================================================
  const LATE = day(24)

  // N1：她的生成不驱动（assistant 事件进尾窗 ⇒ 零提案 ⇒ 持有）
  convSeq += 1
  await appendConversationEvent(db, {
    characterId,
    conversationId,
    conversationSequence: convSeq,
    type: 'assistant_message',
    actorType: 'character',
    actorId: String(characterId),
    content: '谢谢你陪我聊这么久',
    createdAt: LATE,
  })
  const n1 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  record(
    'N1',
    '她的生成不驱动：assistant 事件（含感谢词形）⇒ 零提案持有',
    'held',
    n1.kind,
    n1.kind === 'held',
  )

  // N2：多目标隔离——user-2 的感谢：提案被拒（未建档）且 user-1 的行不动
  const beforeN2 = await projectionOf()
  await appendUser(USER2, '谢谢你听我说', LATE)
  const n2 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  const afterN2 = await projectionOf()
  const user2Projection = await getRelationshipProjection(
    db,
    characterId,
    entityRef('user', USER2),
  )
  const n2ok =
    n2.kind === 'flushed' &&
    n2.acceptedProposals === 0 &&
    n2.rejectedProposals === 1 &&
    afterN2 !== undefined &&
    beforeN2 !== undefined &&
    afterN2.revision === beforeN2.revision &&
    near(afterN2.state.trust, beforeN2.state.trust) &&
    user2Projection === undefined
  record(
    'N2',
    '多目标隔离：user-2 感谢 ⇒ 放行 0/拒 1（origin_missing）· user-1 投影逐字不动 · user-2 无投影行',
    '拒1 · user-1 不动 · user-2 无行',
    `${n2.kind === 'flushed' ? `放行${String(n2.acceptedProposals)}/拒${String(n2.rejectedProposals)}` : n2.kind} · user-1 r${String(beforeN2?.revision)}→r${String(afterN2?.revision)} · user-2 行=${user2Projection === undefined ? '无' : '有（缺陷）'}`,
    n2ok,
  )

  // N3：未确立归因不驱动（无信封的 user_message ⇒ 零提案持有）
  convSeq += 1
  await appendConversationEvent(db, {
    characterId,
    conversationId,
    conversationSequence: convSeq,
    type: 'user_message',
    actorType: 'user',
    actorId: 'm7-wp6-user-1',
    content: '谢谢你，我很信任你',
    createdAt: LATE,
  })
  const n3 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  record(
    'N3',
    '未确立归因不驱动：无信封 user_message（含感谢/信任词形）⇒ 零提案持有',
    'held',
    n3.kind,
    n3.kind === 'held',
  )

  // N4：同窗重跑幂等——对 P2 的窗口手动重跑 ⇒ Validator 领域键检查命中
  //     duplicate_operation 拒绝（不到 append 层）⇒ 零新建、零落库
  const p2Window = p2.kind === 'flushed' ? { from: p2.watermark + 1, to: p2.latest } : undefined
  const n4Outcome = p2Window
    ? await runRelationshipEvaluation(createRelationshipJobPorts(db), {
        characterId,
        owner,
        fromSequence: p2Window.from,
        toSequence: p2Window.to,
        now: LATE,
      })
    : undefined
  const n4ok =
    n4Outcome !== undefined &&
    n4Outcome.acceptedProposals === 0 &&
    n4Outcome.applied.createdCount === 0 &&
    n4Outcome.rejections.some((r) => r.code === 'duplicate_operation')
  record(
    'N4',
    '同窗重跑幂等：P2 窗口重跑 ⇒ Validator 领域键命中 duplicate_operation（放行 0 · 零新建）· 状态不动',
    '拒 duplicate_operation · created=0',
    n4Outcome
      ? `放行${String(n4Outcome.acceptedProposals)} · created=${String(n4Outcome.applied.createdCount)} · 拒码=${n4Outcome.rejections.map((r) => r.code).join(',') || '无'}`
      : '窗口不可用',
    n4ok,
  )

  // ===========================================================================
  // 恢复
  // ===========================================================================

  // R1：重启追赶——追加事件不跑调度（模拟崩溃），新实例的窗口覆盖缺口
  const watermarkBeforeCrash =
    (await getWatermark(db, characterId, RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION))
      ?.processedThroughSequence ?? 0
  for (let i = 1; i <= 3; i += 1) await appendUser(USER1, `崩溃后残留 ${String(i)}`, LATE)
  // （不跑调度 = 模拟评估前进程终止）
  await appendUser(USER1, '谢谢你还在', LATE)
  const r1 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  const r1ok =
    r1.kind === 'flushed' &&
    r1.watermark === watermarkBeforeCrash &&
    r1.acceptedProposals >= 1
  record(
    'R1',
    '重启追赶：崩溃残留 4 条不被丢——新实例窗口从水位+1 起覆盖缺口（感谢在缺口尾部仍放行）',
    `flushed · 水位起点=${String(watermarkBeforeCrash)}`,
    `${r1.kind === 'flushed' ? `flushed · 水位 ${String(r1.watermark)}→${String(r1.latest)} · 放行${String(r1.acceptedProposals)}` : r1.kind}`,
    r1ok,
  )

  // R2：job 失败后同键重建——手动把下一窗口的 job 标 failed ⇒ 调度重跑成功
  const watermarkBeforeR2 =
    (await getWatermark(db, characterId, RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION))
      ?.processedThroughSequence ?? 0
  await appendUser(USER1, '多亏有你', LATE)
  const r2Latest = await latestCharacterEventSequence(db, characterId)
  const r2Key = relationshipEvaluationIdempotencyKey({
    characterId,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    sourceFromSequence: watermarkBeforeR2 + 1,
    sourceToSequence: r2Latest,
  })
  const r2Job = await enqueueJob(db, {
    characterId,
    processor: RELATIONSHIP_EVALUATOR_NAME,
    processorVersion: RELATIONSHIP_EVALUATOR_VERSION,
    sourceFromSequence: watermarkBeforeR2 + 1,
    sourceToSequence: r2Latest,
    idempotencyKey: r2Key,
    now: LATE,
  })
  await finishJob(db, r2Job.job.id, 'failed', { error: '模拟失败：验证 failed 允许同键重建', now: LATE })
  const r2 = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  const r2ok = r2.kind === 'flushed' && r2.created === true && r2.acceptedProposals >= 1
  record(
    'R2',
    '失败后补洞：job 标 failed ⇒ 调度同键重建（created=true）→ completed · 水位前进',
    'flushed · created=true',
    `${r2.kind === 'flushed' ? `flushed · created=${String(r2.created)} · 放行${String(r2.acceptedProposals)}` : r2.kind}`,
    r2ok,
  )

  // R3：水位持久——flush 后直读水位 = 账本最大序号；再跑 ⇒ no_tail
  const r3Watermark =
    (await getWatermark(db, characterId, RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION))
      ?.processedThroughSequence ?? -1
  const r3Latest = await latestCharacterEventSequence(db, characterId)
  const r3Second = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  const r3ok = r3Watermark === r3Latest && r3Second.kind === 'no_tail'
  record(
    'R3',
    '水位持久：processor_watermarks = 账本最大序号；新一次调度 ⇒ no_tail（不重复消费）',
    `水位=${String(r3Latest)} · no_tail`,
    `水位=${String(r3Watermark)} · 二跑=${r3Second.kind}`,
    r3ok,
  )

  // ===========================================================================
  // G 段：真 TurnGateway 全链（计划 §7.2 Level 2 的"真网关"形状）
  // ===========================================================================
  // 生产聊天循环的完整形状：beginTurn（真 ingress 写用户事件）→ compileTurn
  // （关系注入块经 WP5 网关接线进 packet）→ completeTurn（写助手事件与 trace）
  // → 轮后调度（网关写的事件就是评估器的证据）。
  const gatewayConversationId = asConversationId('m7-wp6-gateway-conv')
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId: gatewayConversationId,
    dryRun: false,
    userName: USER1,
    characterName: character.name,
    transport: 'm7-wp6-verify',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId: USER1,
    userRef: USER1,
  })
  let gatewaySeq =
    (await latestConversationSequence(db, characterId, gatewayConversationId)) + 1
  const gateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    identity: kernel.identitySnapshot,
    recorder,
    conversationSequence: () => gatewaySeq,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: USER1,
  })
  const gatewayText = '谢谢你陪我聊这么久'
  const incoming = await gateway.beginTurn(gatewayText)
  gatewaySeq = incoming.conversationSequence + 2
  const gatewayRelationshipSection = await renderRelationshipSection(
    runtime,
    String(characterId),
    USER1,
    LATE,
  )
  const gatewayStateSection = await renderCriticalStateSection(
    runtime,
    String(characterId),
    USER1,
  )
  const packet = await gateway.compileTurn({
    turn: incoming,
    currentInput: gatewayText,
    recentLines: [],
    ...(gatewayStateSection !== undefined ? { stateSection: gatewayStateSection } : {}),
    ...(gatewayRelationshipSection !== undefined
      ? { relationshipSection: gatewayRelationshipSection }
      : {}),
    clockEpochMs: LATE,
  })
  await gateway.completeTurn({ turn: incoming, replyText: '不客气，我也很开心' })

  const packetRelationship = packet.sections.find((x) => x.id === SECTION_IDS.relationship)
  const g1ok =
    incoming.userEvent !== undefined &&
    packetRelationship !== undefined &&
    (packetRelationship.sourceRefs?.length ?? 0) > 0
  record(
    'G1',
    '真网关全链：beginTurn 写用户事件（真 ingress）· compileTurn 的 packet 含 relationship section（WP5 接线被真网关消费）',
    'userEvent 在 · section 在 packet',
    `userEvent=${incoming.userEvent !== undefined ? '在' : '缺'} · section=${packetRelationship !== undefined ? '在' : '缺'} · sourceRefs=${packetRelationship?.sourceRefs?.join(',') ?? '无'}`,
    g1ok,
  )

  const gFlush = await maybeRunRelationshipEvaluation(db, { characterId, owner, now: LATE })
  const gDomainEvents = await domainEventsFor(db, characterId)
  const gR2Event = gDomainEvents.find(
    (e) =>
      e.type === 'RELATIONSHIP_IMPACT' &&
      JSON.stringify(e.payload).includes('"r2"') &&
      incoming.userEvent !== undefined &&
      e.sourceConversationEventIds.map(String).includes(String(incoming.userEvent.id)),
  )
  const g2ok =
    gFlush.kind === 'flushed' &&
    gFlush.acceptedProposals >= 1 &&
    gR2Event !== undefined
  record(
    'G2',
    '轮后调度消费网关事件：感谢经真 ingress 落账 ⇒ R-2 放行 · Level 2 关联（网关用户事件 id ∈ 域事件来源）',
    'flushed · r2 域事件来源含网关用户事件',
    `${gFlush.kind === 'flushed' ? `flushed(放行${String(gFlush.acceptedProposals)})` : gFlush.kind} · 关联=${String(gR2Event !== undefined)}`,
    g2ok,
  )

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length
  const gatewayStage = checks.filter((c) => c.id.startsWith('G')).length
  const domainEventsTotal = await countDomainEvents(db, characterId)
  const finalState = (await projectionOf())?.state
  const stagesValid =
    positive > 0 && negative > 0 && recovery > 0 && gatewayStage > 0 && domainEventsTotal > 0 && seeded.seeded
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp6-verify', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp6-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    propositions: {
      scheduling: '攒尾窗：语义即时消费 · 零提案持有（R-1 累积）· R-5 兜底有界',
      level2: 'conversationEventId → 域事件来源 → 投影 revision → 注入块 sourceRefs → 读回，逐环关联',
      valueSemantics: 'R-2/R-3/R-4b 反扣/R-1/R-5 期望值逐项（净=指控前+0.03）',
      jointBands: '规则驱动跨档：亲近攒够 + 12 连指控 ⇒ 被辜负（两维不合并）',
      negatives: '她的生成/未确立归因/未建档目标/同窗重跑 全部不产生有效变化',
      recovery: '重启追赶覆盖缺口 · failed 同键重建 · 水位持久',
    },
    stages: { positive, negative, recovery, gateway: gatewayStage },
    measured: { domainEvents: domainEventsTotal, checks: checks.length },
    finalProjection: finalState
      ? {
          trust: finalState.trust,
          closeness: finalState.closeness,
          accusationsInCase: finalState.accusationsInCase.length,
        }
      : null,
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp6-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'component-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'M7 WP6 离线门：生产调度（攒尾窗）+ Level 2 关联 + 规则值语义 + 联合行为跨档 + 负控 + 恢复（隔离库，零模型调用；Live 归 WP6-B）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(`stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)} · 网关=${String(gatewayStage)} · 域事件=${String(domainEventsTotal)}`)
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

await main()
