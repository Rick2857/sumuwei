/**
 * M8 WP6 —— **同轮应用 + 降级 + trace 六步 部件门**（`pnpm m8:wp6:verify`）。
 *
 * ============================================================================
 *  要证明的命题（计划 §11 WP6 出口判据，逐条对应）
 * ============================================================================
 * ① 有界评估器在模型调用之前跑完（同轮时序：beginTurn → 评估 → 渲染 → compile）。
 * ② Affect 注入块只在提交成功之后编译——section 的 sourceRefs revision
 *    === 评估后的投影 revision（本轮影响已折进投影，不是上一轮的旧数）。
 * ③ 提交失败 ⇒ 编译上一份有效状态 + appliedThisTurn=false + 如实边界行；
 *    聊天不被打断（completeTurn 照常成功）。
 * ④ 轮后追赶消费网关事件：她的回复 0 提案（assistant 永远不是情绪证据），
 *    水位照常前进——不重复影响。
 * ⑤ 重启从水位出发（不是从最后一条文本重放）：水位持久 ⇒ 新调度 no_tail。
 * ⑥ 失败注入走**现有**失败分类法：调度器 catch → failed（不抛、不重试、
 *    不新增阻塞等待）——本门的 N2 就是"失败不挡聊天"的机器证明。
 * ⑦ trace 六步可区分：affect_eligibility / affect_proposal / affect_validation /
 *    affect_event / affect_projection（轮内五步，先于 context_compile）+
 *    affect_context（编译后事实）；属性只有 id/计数/拒码/布尔，无正文无数值。
 * ⑧ reply-truth 绑定：affect_context.applied_this_turn 与 affect_event /
 *    affect_projection 的计数**同一条 trace 树**——"她说情绪变了"能对上
 *    "程序真的写进去了"（true/false/unknown 三态都有机器读数）。
 *
 * 不主张（归 WP7）：真模型回复、长轨迹、Level 1 读数。本门全部离线。
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8-wp6-verify', { keep: false })



import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  affectTurnObservationOf,
  maybeRunAffectEvaluation,
  seedAffectOrigin,
} from '../src/infrastructure/runtime/affect-scheduler.ts'
import {
  renderAffectSection,
  renderCriticalStateSection,
} from '../src/infrastructure/runtime/adapters.ts'
import { getAffectProjection } from '../src/infrastructure/persistence/affect-store.ts'
import { countDomainEvents, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { getWatermark } from '../src/infrastructure/persistence/job-store.ts'
import { getTrace, countTraces } from '../src/infrastructure/persistence/trace-store.ts'
import { latestConversationSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import { SECTION_IDS } from '../src/kernel/context/sections.ts'
import {
  AFFECT_EVALUATOR_NAME,
  AFFECT_EVALUATOR_VERSION,
} from '../src/kernel/app/affect/evaluator.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
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
function near(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) < tolerance
}

/**
 * drizzle `sql` 模块的字符串块不是裸字符串：是 `StringChunk`，其 `value`
 * 是 **字符串数组**（实测：`{ value: ['insert into character_domain_events …'] }`）。
 * 按裸字符串或 `.value: string` 过滤都会静默匹配零条——本门前两次运行的
 * 真实踩坑：注入不生效 ⇒ N2/R1 双红（负控失效是最危险的量具缺陷）。
 */
function sqlTextOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (chunk !== null && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value
        if (typeof value === 'string') return value
        if (Array.isArray(value)) {
          return value.filter((v): v is string => typeof v === 'string').join('')
        }
      }
      return ''
    })
    .join('\n')
}

/**
 * 失败注入（N2/R1 的量具）：拦下 `insert into character_domain_events`，
 * 其余一切照旧。这是**有界的注入**——只打 store 的写入口，
 * 不碰 job/水位/投影读取，失败因此发生在"评估完成、落库开始"的精确边界上。
 */
function withFailingDomainEventInserts(real: RawDb): RawDb {
  const guard = (handle: RawDb): RawDb => ({
    execute: async (query: unknown) => {
      if (/insert\s+into\s+character_domain_events/.test(sqlTextOf(query))) {
        throw new Error('wp6-injected-store-failure')
      }
      return handle.execute(query)
    },
  })
  return {
    ...guard(real),
    ...(real.transaction !== undefined
      ? {
          transaction: <T>(fn: (tx: RawDb) => Promise<T>) =>
            real.transaction!((tx) => fn(guard(tx))),
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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
  const USER = 'm8-wp6-user'
  const conversationId = asConversationId('m8-wp6-gateway-conv')

  const T0 = Date.UTC(2026, 8, 26, 4, 0, 0)

  // ---- 建档（cutover=0：此后每一条账本事件都是切换后事件）----
  const seed = await seedAffectOrigin(db, {
    characterId,
    activationId: 'wp6-verify-act-1',
    now: T0,
  })
  record(
    'P0',
    '前置：播种建档（cutover=0，此后事件全部可评估）',
    'seeded',
    seed.kind,
    seed.kind === 'seeded',
  )

  // ---- 真网关（生产聊天循环的形状：真 ingress + 真 trace 写入）----
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: USER,
    characterName: character.name,
    transport: 'm8-wp6-verify',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId: USER,
    userRef: USER,
  })
  let gatewaySeq = (await latestConversationSequence(db, characterId, conversationId)) + 1
  const gateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    identity: kernel.identitySnapshot,
    recorder,
    conversationSequence: () => gatewaySeq,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: USER,
  })

  // ===========================================================================
  // G 段（正控）：同轮链路 + trace 六步 + reply-truth 绑定
  // ===========================================================================

  // G1：同轮时序——beginTurn → 评估（flushed）→ 渲染 → compileTurn
  const g1Text = '谢谢你，这个方案帮大忙了'
  const turn1 = await gateway.beginTurn(g1Text)
  gatewaySeq = turn1.conversationSequence + 2
  const g1Scheduling = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 1000,
  })
  const g1Applied = g1Scheduling.kind === 'failed' ? false : true
  const g1Observation = affectTurnObservationOf(g1Scheduling, g1Applied)
  const g1Projection = await getAffectProjection(db, characterId)
  const g1Section = await renderAffectSection(
    runtime,
    String(characterId),
    T0 + 1500,
    g1Applied
  )
  const packet1 = await gateway.compileTurn({
    turn: turn1,
    currentInput: g1Text,
    recentLines: [],
    stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
    ...(g1Section !== undefined ? { affectSection: g1Section } : {}),
    ...(g1Observation !== undefined ? { affectEvaluation: g1Observation } : {}),
    clockEpochMs: T0 + 1500,
  })
  await gateway.completeTurn({ turn: turn1, replyText: '不客气，我也很开心' })

  const trace1 = await getTrace(db, turn1.traceId)
  const stepKinds = (trace1?.steps ?? []).map((s) => String(s.kind))
  const idxOf = (kind: string): number => stepKinds.indexOf(kind)
  const affectSteps = [
    'affect_eligibility',
    'affect_proposal',
    'affect_validation',
    'affect_event',
    'affect_projection',
  ]
  const allPresent = ['affect_context', ...affectSteps].every((k) => idxOf(k) >= 0)
  const orderOk =
    allPresent &&
    idxOf('affect_eligibility') < idxOf('affect_proposal') &&
    idxOf('affect_proposal') < idxOf('affect_validation') &&
    idxOf('affect_validation') < idxOf('affect_event') &&
    idxOf('affect_event') < idxOf('affect_projection') &&
    idxOf('affect_projection') < idxOf('context_compile') &&
    idxOf('context_compile') < idxOf('affect_context')
  const packetAffect1 = packet1.sections.find((s) => s.id === SECTION_IDS.affect)
  record(
    'G1',
    '同轮时序 + trace 六步：评估在 compile 之前跑完；五步轮内观测先于 context_compile，affect_context 是编译后事实；注入块在 packet',
    'flushed · 六步在且有序 · section 在 packet',
    `${g1Scheduling.kind} · steps=[${stepKinds.filter((k) => k.startsWith('affect_')).join(' < ')}] · 有序=${String(orderOk)} · section=${packetAffect1 !== undefined ? '在' : '缺'}`,
    g1Scheduling.kind === 'flushed' && allPresent && orderOk && packetAffect1 !== undefined,
  )

  // G2：提交后编译 + reply-truth 绑定（revision / 计数 / applied 三面一致）
  const step1 = (kind: string) => (trace1?.steps ?? []).find((s) => String(s.kind) === kind)
  const eligibility1 = step1('affect_eligibility')
  const proposal1 = step1('affect_proposal')
  const event1 = step1('affect_event')
  const projectionStep1 = step1('affect_projection')
  const context1 = step1('affect_context')
  const revisionBinding =
    g1Projection !== undefined &&
    context1 !== undefined &&
    Number(context1.attributes.revision_to) === g1Projection.revision &&
    g1Section !== undefined &&
    (g1Section.sourceRefs[0] ?? '') === `projection:affect:r${String(g1Projection.revision)}`
  record(
    'G2',
    '提交后编译 + 绑定：section sourceRefs revision === 投影 revision（本轮影响已折进）；trace 计数与调度一致（合格 1 · 提案 2 · 新建 2）；applied_this_turn=1',
    'revision 绑定 · 合格=1 · 提案=2 · 新建=2 · applied=1 · 规则族含 A-GRATITUDE',
    `绑定=${String(revisionBinding)} · 合格=${String(eligibility1?.attributes.qualified_event_count)} · 提案=${String(proposal1?.attributes.proposal_count)} · 新建=${String(event1?.attributes.created_event_count)} · applied=${String(context1?.attributes.applied_this_turn)} · 规则=${String(proposal1?.attributes.matched_rule_ids)}`,
    revisionBinding &&
      Number(eligibility1?.attributes.qualified_event_count) === 1 &&
      Number(proposal1?.attributes.proposal_count) === 2 &&
      Number(event1?.attributes.created_event_count) === 2 &&
      Number(context1?.attributes.applied_this_turn) === 1 &&
      String(proposal1?.attributes.matched_rule_ids ?? '').includes('A-GRATITUDE') &&
      Number(projectionStep1?.attributes.revision_moved) === 1 &&
      g1Projection !== undefined &&
      near(g1Projection.state.valence, 0.08, 1e-6),
  )

  // G3：轮后追赶——她的回复 0 提案，水位前进，投影不动（不重复影响）
  const g3Scheduling = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 2000,
  })
  const g3Projection = await getAffectProjection(db, characterId)
  record(
    'G3',
    '轮后追赶：completeTurn 的助手回复被消费但 0 提案（assistant 永远不是情绪证据）；水位前进；轴不动',
    'flushed · 提案=0 · 新建=0 · v=0.08 保持',
    `${g3Scheduling.kind}${g3Scheduling.kind === 'flushed' ? ` · 提案=${String(g3Scheduling.proposals)} · 新建=${String(g3Scheduling.createdEvents)}` : ''} · v=${String(g3Projection?.state.valence)}`,
    g3Scheduling.kind === 'flushed' &&
      g3Scheduling.proposals === 0 &&
      g3Scheduling.createdEvents === 0 &&
      g3Projection !== undefined &&
      near(g3Projection.state.valence, 0.08, 1e-6),
  )

  // G4：重启从水位出发——新一次调度读的是持久水位，不是最后文本
  const g4Scheduling = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 3000,
  })
  const g4Watermark = await getWatermark(
    db,
    characterId,
    AFFECT_EVALUATOR_NAME,
    AFFECT_EVALUATOR_VERSION
  )
  const g4Latest = g3Scheduling.kind === 'flushed' ? g3Scheduling.latest : -1
  record(
    'G4',
    '重启从水位出发：水位持久（=账本最大序号）⇒ 再调度 no_tail（不重放最后文本）',
    'no_tail · 水位 = 账本最大序号',
    `${g4Scheduling.kind} · 水位=${String(g4Watermark?.processedThroughSequence ?? '无行')} · 账本=${String(g4Latest)}`,
    g4Scheduling.kind === 'no_tail' &&
      (g4Watermark?.processedThroughSequence ?? -1) === g4Latest &&
      g4Latest > 0,
  )

  // ===========================================================================
  // N 段（负控）：开关关闭形状 · store 失败注入 · 干跑边界
  // ===========================================================================

  // N1：不带 affect 输入的 compileTurn —— trace 无任何 affect 步（安静机制）
  const n1Text = '今天聊聊那个方案吧'
  const turn2 = await gateway.beginTurn(n1Text)
  gatewaySeq = turn2.conversationSequence + 2
  const packet2 = await gateway.compileTurn({
    turn: turn2,
    currentInput: n1Text,
    recentLines: [],
    stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
    clockEpochMs: T0 + 4000,
  })
  await gateway.completeTurn({ turn: turn2, replyText: '好呀，我们聊聊' })
  const trace2 = await getTrace(db, turn2.traceId)
  const n1AffectSteps = (trace2?.steps ?? []).filter((s) => String(s.kind).startsWith('affect_'))
  const packetAffect2 = packet2.sections.find((s) => s.id === SECTION_IDS.affect)
  // 收尾：把这轮的尾窗吃掉（中性消息 → 只 touch），让 N2 的窗口干净
  const n1Cleanup = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 4500,
  })
  record(
    'N1',
    '开关关闭形状：不带 affectEvaluation/affectSection 的轮次 ⇒ trace 零 affect 步、packet 无 affect section（M3.5 基线不受影响的机制）；随后的追赶只产 1 touch（中性消息）',
    'affect 步=0 · section 缺 · 追赶新建=1',
    `affect 步=${String(n1AffectSteps.length)} · section=${packetAffect2 !== undefined ? '在' : '缺'} · 追赶=${n1Cleanup.kind}${n1Cleanup.kind === 'flushed' ? `（新建=${String(n1Cleanup.createdEvents)}）` : ''}`,
    n1AffectSteps.length === 0 &&
      packetAffect2 === undefined &&
      n1Cleanup.kind === 'flushed' &&
      n1Cleanup.createdEvents === 1,
  )

  // N2：store 失败注入 —— failed（现有分类法：不抛不等待）+ 旧投影 + 边界行 + trace failed
  const injectedDb = withFailingDomainEventInserts(db)
  const preN2Watermark = await getWatermark(
    db,
    characterId,
    AFFECT_EVALUATOR_NAME,
    AFFECT_EVALUATOR_VERSION
  )
  const n2Text = '辛苦了，连夜帮我改完'
  const turn3 = await gateway.beginTurn(n2Text)
  gatewaySeq = turn3.conversationSequence + 2
  const n2Scheduling = await maybeRunAffectEvaluation(injectedDb, {
    characterId,
    activeUserId: USER,
    now: T0 + 5000,
  })
  const n2Applied = n2Scheduling.kind === 'failed' ? false : true
  const n2Observation = affectTurnObservationOf(n2Scheduling, n2Applied)
  const n2Projection = await getAffectProjection(db, characterId)
  const n2Watermark = await getWatermark(
    db,
    characterId,
    AFFECT_EVALUATOR_NAME,
    AFFECT_EVALUATOR_VERSION
  )
  const n2Section = await renderAffectSection(
    runtime,
    String(characterId),
    T0 + 5500,
    n2Applied
  )
  const boundaryLine =
    '（本轮情绪处理未完成——以上是上一份有效状态，不要声称你的情绪因对方刚才的话而改变。）'
  const packet3 = await gateway.compileTurn({
    turn: turn3,
    currentInput: n2Text,
    recentLines: [],
    stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
    ...(n2Section !== undefined ? { affectSection: n2Section } : {}),
    ...(n2Observation !== undefined ? { affectEvaluation: n2Observation } : {}),
    clockEpochMs: T0 + 5500,
  })
  await gateway.completeTurn({ turn: turn3, replyText: '没事，不客气' })
  const trace3 = await getTrace(db, turn3.traceId)
  const n2FailedSteps = (trace3?.steps ?? []).filter(
    (s) => affectSteps.includes(String(s.kind)) && s.status === 'failed'
  )
  const n2ContextStep = (trace3?.steps ?? []).find((s) => String(s.kind) === 'affect_context')
  const n2ErrorOk =
    n2Scheduling.kind === 'failed' && n2Scheduling.error.includes('wp6-injected-store-failure')
  record(
    'N2',
    'store 失败注入：调度 failed（现有分类法，不抛不阻塞）· 投影保持旧值 · 水位不动 · 注入块带如实边界行 · trace 五步 status=failed · applied_this_turn=0 · 聊天不被打断（completeTurn 成功）',
    'failed · v=0.08 保持 · 边界行在 · 五步 failed · applied=0',
    `${n2Scheduling.kind}（错误含注入标记=${String(n2ErrorOk)}）· v=${String(n2Projection?.state.valence)} · 水位=${String(n2Watermark?.processedThroughSequence ?? '无行')} · 边界行=${String(n2Section?.text.includes(boundaryLine))} · failed步=${String(n2FailedSteps.length)} · applied=${String(n2ContextStep?.attributes.applied_this_turn)} · outcome=${String(n2ContextStep?.attributes.outcome)}`,
    n2ErrorOk &&
      n2Projection !== undefined &&
      near(n2Projection.state.valence, 0.08, 1e-6) &&
      (n2Watermark?.processedThroughSequence ?? -1) ===
        (preN2Watermark?.processedThroughSequence ?? -2) &&
      (n2Section?.text.includes(boundaryLine) ?? false) &&
      n2FailedSteps.length === affectSteps.length &&
      Number(n2ContextStep?.attributes.applied_this_turn) === 0 &&
      String(n2ContextStep?.attributes.outcome) === 'included',
  )

  // N3：干跑边界——干跑网关不写任何 trace（affect 步自然也不落库）
  const tracesBeforeDry = await countTraces(db, characterId)
  const dryRecorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: true,
    userName: USER,
    characterName: character.name,
  })
  const dryGateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    identity: kernel.identitySnapshot,
    recorder: dryRecorder,
    conversationSequence: () => gatewaySeq,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: true,
    userId: USER,
  })
  const dryTurn = await dryGateway.beginTurn('（干跑）谢谢你')
  const drySection = await renderAffectSection(
    runtime,
    String(characterId),
    T0 + 6000,
    'unknown'
  )
  const dryObservation = affectTurnObservationOf(undefined, 'unknown')
  const dryPacket = await dryGateway.compileTurn({
    turn: dryTurn,
    currentInput: '（干跑）谢谢你',
    recentLines: [],
    stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
    ...(drySection !== undefined ? { affectSection: drySection } : {}),
    clockEpochMs: T0 + 6000,
  })
  await dryGateway.completeTurn({ turn: dryTurn, replyText: '（干跑回复）' })
  const tracesAfterDry = await countTraces(db, characterId)
  const dryTrace = await getTrace(db, dryTurn.traceId)
  const dryAffect = dryPacket.sections.find((s) => s.id === SECTION_IDS.affect)
  record(
    'N3',
    '干跑边界：dryRun 网关带 affectSection 编译（packet 有块，形状与 --test 一致）但零 trace 落库（affect 步无从写入）；观测缺位时 appliedThisTurn=unknown',
    'trace 计数不变 · dry trace 无行 · packet 有块',
    `traces ${String(tracesBeforeDry)}→${String(tracesAfterDry)} · getTrace=${dryTrace === undefined ? '无行' : '有行'} · packet块=${dryAffect !== undefined ? '在' : '缺'} · 观测=${String(dryObservation)}`,
    tracesAfterDry === tracesBeforeDry &&
      dryTrace === undefined &&
      dryAffect !== undefined &&
      dryObservation === undefined,
  )

  // ===========================================================================
  // R 段（恢复）：失败后补洞 + 幂等 + 水位续走
  // ===========================================================================

  // R1：去掉注入 ⇒ 同一批事件被补洞消费（失败没有丢事件），投影前进，无重复
  const domainBeforeR1 = await countDomainEvents(db, characterId)
  const r1Scheduling = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 7000,
  })
  const r1Projection = await getAffectProjection(db, characterId)
  const domainAfterR1 = await countDomainEvents(db, characterId)
  record(
    'R1',
    '恢复（补洞）：去掉注入 ⇒ 失败轮的窗口连同后续事件一次消费（辛苦了 → 1 touch + 1 A-GRATITUDE impact）；域事件恰 +2（无重复）；v 0.08→≈0.16',
    'flushed · 新建=2 · 域事件恰+2 · v≈0.16',
    `${r1Scheduling.kind}${r1Scheduling.kind === 'flushed' ? ` · 新建=${String(r1Scheduling.createdEvents)} · 幂等命中=${String(r1Scheduling.deduplicated)}` : ''} · 域事件 ${String(domainBeforeR1)}→${String(domainAfterR1)} · v=${String(r1Projection?.state.valence)}`,
    r1Scheduling.kind === 'flushed' &&
      r1Scheduling.createdEvents === 2 &&
      domainAfterR1 - domainBeforeR1 === 2 &&
      r1Projection !== undefined &&
      Math.abs(r1Projection.state.valence - 0.16) < 1e-3,
  )

  // R2：恢复后再调度 ⇒ no_tail；域事件不再增长（不会二次消费）
  const r2Scheduling = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 8000,
  })
  const domainAfterR2 = await countDomainEvents(db, characterId)
  const affectEventsFinal = (await domainEventsFor(db, characterId)).filter((e) =>
    String(e.type).startsWith('AFFECT_')
  )
  record(
    'R2',
    '恢复后水位续走：再调度 no_tail；域事件不再增长；账本 affect 事件全部可数（measured_count 自检）',
    'no_tail · 域事件不变 · affect 事件 > 0',
    `${r2Scheduling.kind} · 域事件 ${String(domainAfterR1)}→${String(domainAfterR2)} · affect事件=${String(affectEventsFinal.length)}`,
    r2Scheduling.kind === 'no_tail' &&
      domainAfterR2 === domainAfterR1 &&
      affectEventsFinal.length > 0,
  )

  // ===========================================================================
  // S 段（静态锁）：契约字面量 + 阶段映射 + main.ts 装配在位
  // ===========================================================================

  const traceContract = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/trace.ts'), 'utf8')
  const observabilityContract = readFileSync(
    join(REPO_ROOT, 'src/kernel/contracts/observability.ts'),
    'utf8'
  )
  const mainSource = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
  const sixKinds = [
    'affect_eligibility',
    'affect_proposal',
    'affect_validation',
    'affect_event',
    'affect_projection',
    'affect_context',
  ]
  const kindsInContract = sixKinds.filter((k) => traceContract.includes(`'${k}'`)).length
  const kindsInStages = sixKinds.filter((k) => observabilityContract.includes(`${k}: `)).length
  record(
    'S1',
    '静态锁：六个 step kind 字面量在 trace.ts 契约 + observability.ts 阶段映射（不新开第 13 阶段）',
    '6/6 在契约 · 6/6 在阶段映射',
    `契约=${String(kindsInContract)}/6 · 阶段映射=${String(kindsInStages)}/6`,
    kindsInContract === 6 && kindsInStages === 6,
  )

  const mainWiring = mainSource.split('affectEvaluation').length - 1
  const mainObservationCall = mainSource.includes('affectTurnObservationOf(')
  record(
    'S2',
    '静态锁：main.ts 同轮装配在位（affectTurnObservationOf 生产映射 + affectEvaluation 传入 compileTurn）',
    'observation 调用在 · affectEvaluation ≥2 处',
    `调用=${String(mainObservationCall)} · affectEvaluation 出现=${String(mainWiring)}`,
    mainObservationCall && mainWiring >= 2,
  )

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => c.id.startsWith('G') || c.id.startsWith('P')).length
  const negative = checks.filter((c) => c.id.startsWith('N')).length
  const recovery = checks.filter((c) => c.id.startsWith('R')).length
  const staticLocks = checks.filter((c) => c.id.startsWith('S')).length
  const affectStepTotal = sixKinds.reduce(
    (sum, k) => sum + stepKinds.filter((x) => x === k).length,
    0
  )
  const stagesValid =
    positive > 0 && negative > 0 && recovery > 0 && staticLocks > 0 && affectStepTotal > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const argOf = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const supersedes = argOf('--supersedes') ?? null
  const supersedesReason = argOf('--supersedes-reason')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM8RunId({ wpId: 'wp6-verify', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-wp6-verify@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    propositions: {
      same_turn: '有界评估在模型之前跑完；注入块只在提交成功后编译（revision 绑定）',
      degradation: 'store 失败 ⇒ 旧投影 + appliedThisTurn=false + 边界行 + 聊天不中断',
      tail_catchup: '轮后追赶消费助手回复：0 提案、水位前进、不重复影响',
      restart: '重启从持久水位出发（no_tail），不从最后文本重放',
      trace_six_steps: '六类 affect step 可区分且有序；属性无正文无情绪数值',
      reply_truth: 'applied_this_turn 与 event/projection 计数同树绑定（true/false/unknown）',
      failure_taxonomy: '复用现有 failed 分类法：不抛、不重试、不新增阻塞等待',
    },
    stages: { positive, negative, recovery, staticLocks },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'same-turn-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
    runId,
    wp: 'wp6-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'same-turn-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP6 同轮应用/降级/trace 门（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : 'M8 WP6 同轮应用/降级/trace 门：隔离库 + 真 TurnGateway + 失败注入',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(
    `stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)} · 静态=${String(staticLocks)}`
  )
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
