/**
 * M8 WP4 —— **持久化 / 调度 / 接线 部件门**（`pnpm m8:wp4:verify`）。
 *
 * ============================================================================
 *  要证明的命题（计划 §10 WP4 出口判据）
 * ============================================================================
 * ① 播种：seedAffectOrigin 建档（0/0 + cutover=当时账本最大序号）· 幂等
 *    （已建档 ⇒ already）· 走唯一放行口。
 * ② 尾窗消费：合格消息 → touch + 主导 impact 落库 · 投影轴按冻结 delta 移动 ·
 *    交互锚推进；全不合格尾窗 → 0 提案但水位照常前进（无"攒尾窗"）。
 * ③ M8-D05 不重放：切换前的合格消息（含触发词）永远不产生 touch/impact。
 * ④ 中断播种恢复：ORIGIN 已落库但水位未推进 ⇒ recoverAffectCutoverWatermark
 *    补推进；重复调用 no-op。
 * ⑤ 两层幂等：同窗口重跑 / 跨窗口重叠 ⇒ 领域键全命中 ⇒ createdCount=0、
 *    状态逐字不动。
 * ⑥ 目标过滤 + 事务重建：payload 指向别的 Character 的事件不折进本行；
 *    删行 → rebuildAffectProjection → 逐字段一致（投影是缓存）。
 * ⑦ 接线：createFullDomainEventRegistry() 含全部 AFFECT 类型（S3 翻转证据）。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库（本文件顶部），
 * 真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8-wp4-verify', { keep: false })

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
  domainEventsFor,
} from '../src/infrastructure/persistence/event-store.ts'
import {
  getAffectProjection,
  rebuildAffectProjection,
} from '../src/infrastructure/persistence/affect-store.ts'
import { getWatermark } from '../src/infrastructure/persistence/job-store.ts'
import {
  maybeRunAffectEvaluation,
  recoverAffectCutoverWatermark,
  seedAffectOrigin,
} from '../src/infrastructure/runtime/affect-scheduler.ts'
import {
  asCharacterId,
  asConversationId,
  type ConversationEvent,
} from '../src/kernel/contracts/index.ts'
import {
  AFFECT_DOMAIN_EVENT_TYPES,
  AFFECT_IMPACT,
  AFFECT_ORIGIN,
  AFFECT_TOUCH,
  createAffectDomainEventRegistry,
  createFullDomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import { AFFECT_PROJECTION_TYPE, type AffectState } from '../src/kernel/contracts/affect.ts'
import { affectReducerFor } from '../src/kernel/projections/affect.ts'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'

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
  const ACTIVE_USER = 'm8-user-1'
  // 受信归因的生产 ingress（human-console 族）：没有它，appendUserStatement 走
  // legacy 路径（无信封）→ 资格永远不是 ESTABLISHED → 评估器看不到任何合格证据
  const ledger = createConversationLedger({
    db,
    attribution: [createHumanConsoleUserTurnIngress()],
  })
  const conversationId = asConversationId('m8-wp4-verify-conversation')

  const T0 = Date.UTC(2026, 8, 26, 2, 0, 0)
  let convSeq = 0
  const appendUser = async (userId: string, content: string, createdAt: number): Promise<ConversationEvent> => {
    convSeq += 1
    const outcome = await ledger.appendUserStatement({
      characterId,
      conversationId,
      userId,
      content,
      createdAt,
      conversationSequence: convSeq,
    })
    return outcome.event
  }
  const appendAssistant = async (content: string, createdAt: number, replyTo: ConversationEvent): Promise<ConversationEvent> => {
    convSeq += 1
    const outcome = await ledger.appendCharacterOutput({
      characterId,
      characterIdAsActor: characterId,
      conversationId,
      content,
      createdAt,
      conversationSequence: convSeq,
      replyToEventId: replyTo.id,
    })
    return outcome.event
  }

  // ===== 正控：播种 =====

  // 素材：3 条含触发词的合格消息（切换前——它们永远不该被重放）
  const pre1 = await appendUser(ACTIVE_USER, '谢谢你，帮大忙了', T0)
  const pre2 = await appendUser(ACTIVE_USER, '真的很感谢你', T0 + 1000)
  const pre3 = await appendUser(ACTIVE_USER, '多谢你陪我', T0 + 2000)

  const seed1 = await seedAffectOrigin(db, { characterId, activationId: 'wp4-verify-act-1', now: T0 + 3000 })
  const projection1 = await getAffectProjection(db, characterId)
  record(
    'P1',
    '播种：建档成功，0/0 中性起点 + cutover = 当时账本最大序号（3）+ ACTIVATION_BASELINE',
    'seeded · valence=0 · arousal=0 · cutover=3',
    `${seed1.kind}${seed1.kind === 'seeded' ? ` · valence=${String(projection1?.state.valence)} · arousal=${String(projection1?.state.arousal)} · cutover=${String(seed1.cutoverSequence)}` : ` · ${seed1.kind === 'already' ? seed1.reason : seed1.kind === 'rejected' ? seed1.reason : seed1.error}`}`,
    seed1.kind === 'seeded' &&
      seed1.cutoverSequence === 3 &&
      projection1 !== undefined &&
      projection1.state.originated &&
      projection1.state.valence === 0 &&
      projection1.state.arousal === 0 &&
      projection1.state.originKind === 'ACTIVATION_BASELINE' &&
      projection1.projectionType === AFFECT_PROJECTION_TYPE,
  )

  const seed2 = await seedAffectOrigin(db, { characterId, activationId: 'wp4-verify-act-2', now: T0 + 4000 })
  record(
    'P2',
    '播种幂等：已建档再播种 ⇒ already（不产生第二个 ORIGIN）',
    'already',
    seed2.kind,
    seed2.kind === 'already',
  )

  const originCount = (await domainEventsFor(db, characterId)).filter((e) => e.type === AFFECT_ORIGIN).length
  record(
    'P3',
    '账本里 ORIGIN 恰好 1 条（播种走唯一放行口，不绕过）',
    '1 条',
    `${String(originCount)} 条`,
    originCount === 1,
  )

  // ===== 正控：M8-D05 不重放（切换前 3 条含触发词消息永远不产生事件）=====

  const run1 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: ACTIVE_USER, now: T0 + 5000 })
  const eventsAfterRun1 = await domainEventsFor(db, characterId)
  record(
    'P4',
    'M8-D05：播种后首跑无尾窗（水位=cutover=3）⇒ no_tail；切换前 3 条感谢消息不产生任何 touch/impact',
    'no_tail · 域事件仍只有 ORIGIN 1 条',
    `${run1.kind} · 域事件 ${String(eventsAfterRun1.length)} 条（touch=${String(eventsAfterRun1.filter((e) => e.type === AFFECT_TOUCH).length)} · impact=${String(eventsAfterRun1.filter((e) => e.type === AFFECT_IMPACT).length)}）`,
    run1.kind === 'no_tail' &&
      eventsAfterRun1.length === 1 &&
      eventsAfterRun1.every((e) => e.type === AFFECT_ORIGIN),
  )

  // ===== 正控：尾窗消费（合格消息 → touch + impact；轴按冻结 delta 移动）=====

  const post1 = await appendUser(ACTIVE_USER, '谢谢你，这个方案帮大忙了', T0 + 6000)
  const run2 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: ACTIVE_USER, now: T0 + 7000 })
  const projection2 = await getAffectProjection(db, characterId)
  const touchEvents = (await domainEventsFor(db, characterId)).filter((e) => e.type === AFFECT_TOUCH)
  const impactEvents = (await domainEventsFor(db, characterId)).filter((e) => e.type === AFFECT_IMPACT)
  record(
    'P5',
    '切换后感谢消息 → flushed：1 touch + 1 A-GRATITUDE impact 落库；valence +0.08；arousal −0.03 从 0 起**钳在下界 0**（arousal ∈ [0,1]）',
    'flushed · touch=1 · impact=1 · v=0.08 · a=0（钳取）',
    `${run2.kind}${run2.kind === 'flushed' ? ` · 提案=${String(run2.proposals)} · 接受=${String(run2.acceptedProposals)} · 新建=${String(run2.createdEvents)}` : ''} · touch=${String(touchEvents.length)} · impact=${String(impactEvents.length)} · v=${String(projection2?.state.valence)} · a=${String(projection2?.state.arousal)}`,
    run2.kind === 'flushed' &&
      run2.createdEvents === 2 &&
      touchEvents.length === 1 &&
      impactEvents.length === 1 &&
      projection2 !== undefined &&
      near(projection2.state.valence, 0.08) &&
      near(projection2.state.arousal, 0),
  )

  const run3 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: ACTIVE_USER, now: T0 + 8000 })
  record(
    'P6',
    '消费后水位前进 ⇒ 再跑 no_tail（尾窗不相交）',
    'no_tail',
    run3.kind,
    run3.kind === 'no_tail',
  )

  // ===== 正控：中性消息只 touch；她的回复全不合格 =====

  const neutralMsg = await appendUser(ACTIVE_USER, '今天聊聊那个方案吧', T0 + 9000)
  await appendAssistant('好的，我们聊聊', T0 + 9500, neutralMsg)
  const run4 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: ACTIVE_USER, now: T0 + 10000 })
  const projection3 = await getAffectProjection(db, characterId)
  const touchCount4 = (await domainEventsFor(db, characterId)).filter((e) => e.type === AFFECT_TOUCH).length
  record(
    'P7',
    '中性消息 + 她的回复 → 只 1 touch（她的回复 0 提案）；轴不动（v=0.08/a=0 保持）',
    'flushed · 新建=1 · 轴不动',
    `${run4.kind}${run4.kind === 'flushed' ? ` · 提案=${String(run4.proposals)} · 新建=${String(run4.createdEvents)}` : ''} · touch 累计=${String(touchCount4)} · v=${String(projection3?.state.valence)} · a=${String(projection3?.state.arousal)}`,
    run4.kind === 'flushed' &&
      run4.createdEvents === 1 &&
      touchCount4 === 2 &&
      projection3 !== undefined &&
      near(projection3.state.valence, 0.08) &&
      near(projection3.state.arousal, 0),
  )

  // ===== 正控：接线（S3 翻转证据）=====

  const fullTypes = createFullDomainEventRegistry().types()
  const affectInFull = fullTypes.filter((t) => (AFFECT_DOMAIN_EVENT_TYPES as readonly string[]).includes(t))
  record(
    'P8',
    '接线：createFullDomainEventRegistry() 含全部 AFFECT 类型（WP2 S3 判据已按 WP4 翻转）',
    `全部 ${String(AFFECT_DOMAIN_EVENT_TYPES.length)} 类`,
    `${String(affectInFull.length)}/${String(AFFECT_DOMAIN_EVENT_TYPES.length)}（full 共 ${String(fullTypes.length)} 类）`,
    affectInFull.length === AFFECT_DOMAIN_EVENT_TYPES.length,
  )

  // ===== 负控 =====

  // N1：同窗口重跑（跨窗口重叠模拟：手动用旧区间再跑一次 runAffectEvaluation 层）
  // —— 通过再次调用调度无法构造重叠（水位已前进），这里直接用 job 层函数
  const { runAffectEvaluation } = await import('../src/kernel/app/affect/job.ts')
  const { createAffectJobPorts } = await import('../src/infrastructure/runtime/affect-scheduler.ts')
  const ports = createAffectJobPorts(db)
  const overlapRun = await runAffectEvaluation(ports, {
    characterId,
    fromSequence: 4, // 已消费过的区间（含 post1）
    toSequence: 5,
    activeUserId: ACTIVE_USER,
    now: T0 + 11000,
  })
  const projectionAfterOverlap = await getAffectProjection(db, characterId)
  record(
    'N1',
    '两层幂等：已消费区间重跑 → 领域键全命中 duplicate → createdCount=0、投影逐字不动',
    '新建=0 · 轴不动',
    `提案=${String(overlapRun.proposals)} · 接受=${String(overlapRun.acceptedProposals)} · 拒=${String(overlapRun.rejectedProposals)} · 新建=${String(overlapRun.applied.createdCount)} · v=${String(projectionAfterOverlap?.state.valence)}`,
    overlapRun.applied.createdCount === 0 &&
      overlapRun.rejectedProposals === overlapRun.proposals &&
      projectionAfterOverlap !== undefined &&
      near(projectionAfterOverlap.state.valence, 0.08),
  )

  // N2：非 active user 的消息 → 0 提案（调度消费但无事件）
  await appendUser('m8-user-other', '谢谢你', T0 + 12000)
  const run5 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: ACTIVE_USER, now: T0 + 13000 })
  const eventsAfterN2 = await countDomainEvents(db, characterId)
  record(
    'N2',
    '非 active user 的消息（M8-D11）→ 0 提案 0 新建；水位照常前进（无攒尾窗）',
    'flushed · 新建=0',
    `${run5.kind}${run5.kind === 'flushed' ? ` · 提案=${String(run5.proposals)} · 新建=${String(run5.createdEvents)}` : ''} · 域事件累计=${String(eventsAfterN2)}`,
    run5.kind === 'flushed' && run5.proposals === 0 && run5.createdEvents === 0,
  )

  // N3：目标过滤——payload 指向别的 Character 的事件不折进本行
  //（绕过放行口直接落一条"伪造跨角色"事件，测 reducer/rebuild 的过滤面）
  const foreignAccepted = [
    {
      type: AFFECT_TOUCH,
      operation: 'update' as const,
      payload: {
        characterId: asCharacterId('char_foreign_wp4'),
        sourceEventId: pre1.id,
        sourceSequence: pre1.sequence,
        originKind: 'INTERACTION_DERIVED' as const,
        evaluatorVersion: 'affect-evaluator@1',
        proposalId: 'prop-foreign-n3',
      },
      sourceConversationEventIds: [pre1.id],
      idempotencyKey: 'm8-wp4-verify-foreign-touch-0001',
      processor: 'm8-wp4-verify',
      processorVersion: 'm8-wp4-verify@1',
      scope: 'CHARACTER_INTERNAL' as const,
    },
  ]
  await applyAcceptedEvents(db, characterId, foreignAccepted, [affectReducerFor(characterId)], T0 + 14000)
  const projectionAfterForeign = await getAffectProjection(db, characterId)
  record(
    'N3',
    '目标过滤：payload.characterId=别人的 TOUCH 落进账本也不折进本行投影（own 判定跳过）',
    '轴与锚不动',
    `v=${String(projectionAfterForeign?.state.valence)} · lastDomainEventSequence=${String(projectionAfterForeign?.lastDomainEventSequence)}`,
    projectionAfterForeign !== undefined &&
      near(projectionAfterForeign.state.valence, 0.08) &&
      projectionAfterForeign.lastDomainEventSequence === projectionAfterOverlap!.lastDomainEventSequence,
  )

  // ===== 恢复控 =====

  // R1：中断播种恢复（新 Character 模拟：直接 apply ORIGIN 不推进水位）
  const otherCharacterId = asCharacterId('char_m8_wp4_recovery')
  const { createProposal } = await import('../src/kernel/contracts/index.ts')
  const { AFFECT_ORIGIN_PROPOSAL_TYPE } = await import('../src/kernel/contracts/affect.ts')
  const { validateAffectProposal } = await import('../src/kernel/policies/affect-validator.ts')
  const { hasProcessedOperation } = await import('../src/infrastructure/persistence/job-store.ts')
  const recoveryOriginPayload = {
    characterId: otherCharacterId,
    initialValence: 0,
    initialArousal: 0,
    originKind: 'ACTIVATION_BASELINE' as const,
    activationId: 'wp4-verify-recovery',
    cutoverAt: T0 + 15000,
    // 模拟"播种时账本已有 5 条事件"的现场（cutover=5）；本角色无真实事件，
    // 直接把边界写进 payload——恢复逻辑只读这个值
    cutoverSequence: 5,
    policyVersion: 'affect-policy@1',
  }
  const recoveryProposal = createProposal({
    characterId: otherCharacterId,
    proposalType: AFFECT_ORIGIN_PROPOSAL_TYPE,
    sourceConversationEventIds: [],
    payload: { activationId: 'wp4-verify-recovery' },
    targetEvents: [{ type: AFFECT_ORIGIN, operation: 'create', payload: recoveryOriginPayload }],
    processor: 'affect-origin-seeder',
    processorVersion: 'affect-origin-seeder@1',
  })
  const recoveryDeps = {
    registry: createAffectDomainEventRegistry(),
    evidence: { findEvents: async () => [] },
    processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
    affect: { getAffectState: async () => undefined },
    policy: { activeUserId: ACTIVE_USER },
  }
  const recoveryOutcome = await validateAffectProposal(recoveryDeps, recoveryProposal)
  await applyAcceptedEvents(
    db,
    otherCharacterId,
    recoveryOutcome.acceptedEvents,
    [affectReducerFor(otherCharacterId)],
    T0 + 15000
  )
  // 此刻：投影已建档（cutover=0），但水位行不存在（=0）——中断播种的现场
  const watermarkBeforeRecovery = await getWatermark(db, otherCharacterId, 'affect-evaluator', 'affect-evaluator@1')
  const recovery1 = await recoverAffectCutoverWatermark(db, { characterId: otherCharacterId, now: T0 + 16000 })
  const recovery2 = await recoverAffectCutoverWatermark(db, { characterId: otherCharacterId, now: T0 + 17000 })
  record(
    'R1',
    '中断播种恢复：ORIGIN 已落库但水位未推进（无行=0）⇒ recover 补推进到 cutover=5；重复调用 no-op',
    '先 recovered=true（→5）· 后 recovered=false',
    `前水位=${String(watermarkBeforeRecovery?.processedThroughSequence ?? '无行')} · 第一次=${String(recovery1.recovered)}（→${String(recovery1.watermark)}）· 第二次=${String(recovery2.recovered)}`,
    recovery1.recovered && !recovery2.recovered && recovery1.watermark === 5,
  )

  // R2：投影是缓存——删行 → rebuild → 逐字段一致（外来事件被目标过滤排除）
  const before = await getAffectProjection(db, characterId)
  const affectEventsInLedger = (await domainEventsFor(db, characterId)).filter((e) =>
    (AFFECT_DOMAIN_EVENT_TYPES as readonly string[]).includes(e.type)
  )
  await deleteProjection(db, characterId, AFFECT_PROJECTION_TYPE)
  const deleted = await getAffectProjection(db, characterId)
  const rebuild = await rebuildAffectProjection(db, characterId, T0 + 18000)
  const after = await getAffectProjection(db, characterId)
  const stateEqual =
    before !== undefined &&
    after !== undefined &&
    JSON.stringify(before.state) === JSON.stringify(after.state) &&
    before.revision === after.revision &&
    before.lastDomainEventSequence === after.lastDomainEventSequence
  const filteredForeign = affectEventsInLedger.length - rebuild.appliedEvents
  record(
    'R2',
    '投影是缓存：删行（确认 undefined）→ rebuildAffectProjection（事务包装）→ 逐字段一致；外来事件（payload 指向别人）被目标过滤排除',
    '删后 undefined · 重建一致 · 账本 affect 事件 − applied = 1（外来）',
    `删后=${String(deleted === undefined)} · 状态一致=${String(stateEqual)} · applied=${String(rebuild.appliedEvents)} · 账本affect=${String(affectEventsInLedger.length)} · 过滤掉=${String(filteredForeign)}`,
    deleted === undefined && stateEqual === true && filteredForeign === 1,
  )

  // R3：全部负控之后，新的合格消息重新产出 touch + impact（调度复原）
  await appendUser(ACTIVE_USER, '谢谢你，救急了', T0 + 19000)
  const run6 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: ACTIVE_USER, now: T0 + 20000 })
  const projectionFinal = await getAffectProjection(db, characterId)
  record(
    'R3',
    '恢复：负控之后新的感谢消息 → touch + A-GRATITUDE impact；valence 0.08→≈0.16（衰减窗口 10s，近似直接叠加）',
    'flushed · 新建=2 · v≈0.16',
    `${run6.kind}${run6.kind === 'flushed' ? ` · 新建=${String(run6.createdEvents)}` : ''} · v=${String(projectionFinal?.state.valence)}`,
    run6.kind === 'flushed' &&
      run6.createdEvents === 2 &&
      projectionFinal !== undefined &&
      Math.abs(projectionFinal.state.valence - 0.16) < 1e-3,
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
  const runId = createM8RunId({ wpId: 'wp4-verify', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-wp4-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    propositions: {
      seeding: '建档 0/0 + cutover=账本最大序号 · 幂等 · 走唯一放行口',
      consumption: '尾窗非空即消费（无攒尾窗——M8 规则全部逐事件即时）',
      no_replay: 'M8-D05：切换前合格消息（含触发词）永不产生事件',
      recovery_path: '中断播种 ⇒ 从投影状态重读 cutover 补推进水位',
      idempotency: '同窗口重跑/跨窗口重叠 ⇒ 领域键命中 ⇒ 零新建零状态变化',
      rebuild: '目标过滤 + 事务包装重建 ⇒ 删行重放逐字段一致',
      wiring: 'full registry 含全部 AFFECT 类型（S3 翻转）',
    },
    stages: { positive, negative, recovery },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'persistence-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
    runId,
    wp: 'wp4-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'persistence-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP4 持久化/调度/接线门（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : 'M8 WP4 持久化/调度/接线门：隔离库 + 真实 store/scheduler/ledger',
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
