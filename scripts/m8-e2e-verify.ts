/**
 * M8 WP7 —— **e2e 语料门**（`pnpm m8:e2e:verify`）：A01–A20 最小场景集
 * 走**真实 TurnGateway**（真 ingress + 真 trace + 真调度器 + 真放行链）。
 *
 * ============================================================================
 *  语料版本：m8-e2e-corpus@1（冻结；场景定义 = 计划 §11.1 的 A01–A20）
 * ============================================================================
 *  每个场景的期望都锚在 ADR-066 的冻结数值（affect-rules@1）：
 *  A-GRATITUDE +0.08/−0.03 · A-REPAIR +0.12/−0.08 · A-WARM +0.08/+0.03 ·
 *  A-COMFORT +0.10/−0.08 · A-HOSTILE −0.15/+0.12 · A-REJECTION −0.10/+0.08 ·
 *  A-URGENT 0/+0.10；arousal ∈ [0,1]（从 0 往下夹在 0）。
 *
 *  三条主线（计划 §10 WP7 任务 2/3/5）：
 *  · Level 1 可观察链：用户消息 → 真网关 → 同轮评估 → 注入块（含本轮投影）
 *    → trace 六步 → 回复不中断；
 *  · 来源资格负控：assistant 复述（A09）· 工具输出（A10）· 未确立归因
 *    （A11）· 错误 active user（A18）全部零提案——"她的世界只有用户的
 *    直接表达能动她的情绪"（M8-D04）；
 *  · 失败与恢复：评估输入装载失败（A13）· store/projection 写入失败（A14）
 *    ⇒ failed + 水位冻结 + 旧投影 + 边界行 + 聊天不中断；恢复后恰一次应用。
 *
 *  不在本门（各有归属）：1×500 长轨迹（m8:long:verify）· 真模型 Live Smoke
 *  （WP7-C）· 量具三段式自证（各检测器的注入必响已在 WP2–WP6 门内逐个证过，
 *  本门 R 段是链路级恢复控）。真实库不打开（isolateDatabase）。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8-e2e-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
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
  createAgentRunnerUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  affectTurnObservationOf,
  maybeRunAffectEvaluation,
  seedAffectOrigin,
} from '../src/infrastructure/runtime/affect-scheduler.ts'
import {
  renderAffectSection,
  renderAffectReadback,
  renderCriticalStateSection,
  renderRelationshipSection,
  seedRelationshipOrigin,
} from '../src/infrastructure/runtime/adapters.ts'
import { maybeRunRelationshipEvaluation } from '../src/infrastructure/runtime/relationship-scheduler.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { getAffectProjection } from '../src/infrastructure/persistence/affect-store.ts'
import { countDomainEvents, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { getWatermark } from '../src/infrastructure/persistence/job-store.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { latestCharacterEventSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import { exec, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { SECTION_IDS } from '../src/kernel/context/sections.ts'
import {
  AFFECT_EVALUATOR_NAME,
  AFFECT_EVALUATOR_VERSION,
} from '../src/kernel/app/affect/evaluator.ts'
import { effectiveAffect } from '../src/kernel/contracts/affect.ts'
import { validateAffectProposal } from '../src/kernel/policies/affect-validator.ts'
import {
  AFFECT_ORIGIN,
  createFullDomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import {
  AFFECT_ORIGIN_PROPOSAL_TYPE,
  type AffectOriginPayload,
} from '../src/kernel/contracts/affect.ts'
import { createProposal } from '../src/kernel/contracts/proposal.ts'
import { asCharacterId, asConversationId, asTraceId, entityRef } from '../src/kernel/contracts/index.ts'
import { sql } from 'drizzle-orm'
import { createM8RunId, openM8RunDir, writeM8Manifest } from './m8-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CORPUS_VERSION = 'm8-e2e-corpus@1'

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
const near = (a: number, b: number, tolerance = 1e-3): boolean => Math.abs(a - b) < tolerance

// ---------------------------------------------------------------------------
// 注入量具（WP6 的推广形：按 SQL 文本标记拦下任意写/读入口）
// ---------------------------------------------------------------------------

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

/** 有界失败注入：只拦匹配 `marker` 的语句，其余照旧（事务一并包装） */
function withFailing(real: RawDb, marker: RegExp, tag: string): RawDb {
  const guard = (handle: RawDb): RawDb => ({
    execute: async (query: unknown) => {
      if (marker.test(sqlTextOf(query))) {
        throw new Error(`m8-e2e-injected-${tag}`)
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
  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const USER = 'm8-e2e-user'
  const conversationId = asConversationId('m8-e2e-gateway-conv')
  const sideConversationId = asConversationId('m8-e2e-side-conv')

  const T0 = Date.UTC(2026, 8, 27, 4, 0, 0)
  let now = T0
  const tick = (ms = 1000): number => {
    now += ms
    return now
  }

  // ---- 建档（cutover=0：此后每一条账本事件都是切换后事件）----
  await seedAffectOrigin(db, { characterId, activationId: 'm8-e2e-act-1', now: T0 })

  // ---- 真网关 ----
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: USER,
    characterName: character.name,
    transport: 'm8-e2e-verify',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId: USER,
    userRef: USER,
  })
  let gatewaySeq = 1
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

  // ---- 直写账本（旁路会话；角色级序号自动分配——水位基准共享）----
  const ledger = createConversationLedger({
    db,
    attribution: [createHumanConsoleUserTurnIngress()],
  })
  const agentLedger = createConversationLedger({
    db,
    attribution: [createAgentRunnerUserTurnIngress()],
  })
  let sideSeq = 0
  const sideAppend = async (
    text: string,
    options: { userId?: string; ledger?: typeof ledger; createdAt?: number } = {}
  ): Promise<void> => {
    sideSeq += 1
    await (options.ledger ?? ledger).appendUserStatement({
      characterId,
      conversationId: sideConversationId,
      userId: options.userId ?? USER,
      content: text,
      createdAt: options.createdAt ?? tick(),
      conversationSequence: sideSeq,
    })
  }

  /** 最近一次网关轮的 traceId（Level 2 / A02 的 trace 断言用） */
  let latestTraceId: ReturnType<typeof asTraceId> | undefined

  /** 一次完整网关轮：beginTurn → 同轮评估 → 渲染 → compile → complete → 轮后追赶 */
  async function gatewayTurn(
    id: string,
    text: string,
    replyText: string,
    options: { withAffect?: boolean } = {}
  ): Promise<{
    scheduling: Awaited<ReturnType<typeof maybeRunAffectEvaluation>>
    packet: Awaited<ReturnType<typeof gateway.compileTurn>>
    post: Awaited<ReturnType<typeof maybeRunAffectEvaluation>>
  }> {
    const withAffect = options.withAffect ?? true
    const turn = await gateway.beginTurn(text)
    gatewaySeq = turn.conversationSequence + 2
    latestTraceId = turn.traceId
    const scheduling = withAffect
      ? await maybeRunAffectEvaluation(db, { characterId, activeUserId: USER, now: tick() })
      : { kind: 'no_tail' as const, watermark: 0, latest: 0 }
    const applied = scheduling.kind === 'failed' ? false : true
    const observation = withAffect ? affectTurnObservationOf(scheduling, applied) : undefined
    const section = withAffect
      ? await renderAffectSection(runtime, String(characterId), tick(), applied)
      : undefined
    const packet = await gateway.compileTurn({
      turn,
      currentInput: text,
      recentLines: [],
      stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
      ...(section !== undefined ? { affectSection: section } : {}),
      ...(observation !== undefined ? { affectEvaluation: observation } : {}),
      clockEpochMs: now,
    })
    await gateway.completeTurn({ turn, replyText })
    const post = withAffect
      ? await maybeRunAffectEvaluation(db, { characterId, activeUserId: USER, now: tick() })
      : { kind: 'no_tail' as const, watermark: 0, latest: 0 }
    return { scheduling, packet, post }
  }

  const projectionNow = async () => (await getAffectProjection(db, characterId))?.state

  // ===========================================================================
  // Level 1 主线：A01–A08 逐场景（真网关同轮链）
  // ===========================================================================

  // A01 中性问候：touch 或 no-op；轴不变
  {
    const { scheduling, packet, post } = await gatewayTurn(
      'A01',
      '早上好，今天天气不错。',
      '早上好呀。'
    )
    const state = await projectionNow()
    const sectionInPacket = packet.sections.some((s) => s.id === SECTION_IDS.affect)
    record(
      'A01',
      '中性问候：1 touch · 0 impact · 轴不动（v=0/a=0）· 注入块在 packet · 轮后追赶 0 提案',
      'flushed touch=1 impact=0 · v=0 a=0 · 块在 · 追赶 0',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` touch=${String(scheduling.touchProposals)} impact=${String(scheduling.impactProposals)}` : ''} · v=${String(state?.valence)} a=${String(state?.arousal)} · 块=${String(sectionInPacket)} · 追赶=${post.kind}${post.kind === 'flushed' ? `（${String(post.proposals)}）` : ''}`,
      scheduling.kind === 'flushed' &&
        scheduling.touchProposals === 1 &&
        scheduling.impactProposals === 0 &&
        state !== undefined &&
        near(state.valence, 0) &&
        near(state.arousal, 0) &&
        sectionInPacket &&
        post.kind === 'flushed' &&
        post.proposals === 0
    )
  }

  // A02 明确感谢：唯一正向 impact；delta 在上限内；trace 六步 + 同轮绑定
  {
    const { scheduling, packet } = await gatewayTurn(
      'A02',
      '谢谢你，这个方案帮大忙了。',
      '不客气，我也很开心。'
    )
    const state = await projectionNow()
    const trace = await getTrace(db, latestTraceId!)
    const kinds = (trace?.steps ?? []).map((s) => String(s.kind))
    const ctxStep = (trace?.steps ?? []).find((s) => String(s.kind) === 'affect_context')
    const propStep = (trace?.steps ?? []).find((s) => String(s.kind) === 'affect_projection')
    const section = packet.sections.find((s) => s.id === SECTION_IDS.affect)
    const projection = await getAffectProjection(db, characterId)
    const sectionRefs = section?.sourceRefs ?? []
    const revisionBound =
      projection !== undefined &&
      sectionRefs[0] === `projection:affect:r${String(projection.revision)}`
    const sixSteps = [
      'affect_eligibility',
      'affect_proposal',
      'affect_validation',
      'affect_event',
      'affect_projection',
      'affect_context',
    ].every((k) => kinds.includes(k))
    record(
      'A02',
      '明确感谢：1 touch + 1 A-GRATITUDE impact（Δv=+0.08 在上限内）· trace 六步 · applied_this_turn=1 · 注入块 revision=投影 revision（同轮）',
      'flushed impact=1 规则=A-GRATITUDE · v≈0.08 · 六步 · applied=1 · revision 绑定',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` impact=${String(scheduling.impactProposals)} 规则=${scheduling.matchedRuleIds.join(',')}` : ''} · v=${String(state?.valence)} · 六步=${String(sixSteps)} · applied=${String(ctxStep?.attributes.applied_this_turn)} · revision_moved=${String(propStep?.attributes.revision_moved)} · 绑定=${String(revisionBound)}`,
      scheduling.kind === 'flushed' &&
        scheduling.impactProposals === 1 &&
        scheduling.matchedRuleIds.includes('A-GRATITUDE') &&
        state !== undefined &&
        near(state.valence, 0.08) &&
        sixSteps &&
        Number(ctxStep?.attributes.applied_this_turn) === 1 &&
        Number(propStep?.attributes.revision_moved) === 1 &&
        revisionBound
    )
  }

  // A03 明确道歉/修复：正向且降 arousal（从 0 夹在 0）；不宣称关系修复（M7 域不动）
  {
    const { scheduling } = await gatewayTurn('A03', '对不起，是我误会你了。', '没关系，说开就好。')
    const state = await projectionNow()
    record(
      'A03',
      '明确道歉：A-REPAIR Δv=+0.12 · Δa=−0.08（从 0 夹在 0）· v≈0.20',
      'impact=1 规则=A-REPAIR · v≈0.20 a=0',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 规则=${scheduling.matchedRuleIds.join(',')}` : ''} · v=${String(state?.valence)} a=${String(state?.arousal)}`,
      scheduling.kind === 'flushed' &&
        scheduling.matchedRuleIds.includes('A-REPAIR') &&
        state !== undefined &&
        near(state.valence, 0.2) &&
        near(state.arousal, 0)
    )
  }

  // A04 温暖关心：正向小幅；不混入 user emotion（只动她自己的轴）
  {
    const { scheduling } = await gatewayTurn('A04', '想你了，最近过得还好。', '我也想你。')
    const state = await projectionNow()
    record(
      'A04',
      '温暖关心：A-WARM-CONTACT Δv=+0.08 · Δa=+0.03 · v≈0.28 a≈0.03',
      'impact=1 规则=A-WARM-CONTACT · v≈0.28 a≈0.03',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 规则=${scheduling.matchedRuleIds.join(',')}` : ''} · v=${String(state?.valence)} a=${String(state?.arousal)}`,
      scheduling.kind === 'flushed' &&
        scheduling.matchedRuleIds.includes('A-WARM-CONTACT') &&
        state !== undefined &&
        near(state.valence, 0.28) &&
        near(state.arousal, 0.03)
    )
  }

  // A05 安慰/缓和：正向且降 arousal；无外部事实主张（只动轴）
  {
    const { scheduling } = await gatewayTurn('A05', '别难过，没事的。', '嗯，有你在好多了。')
    const state = await projectionNow()
    record(
      'A05',
      '安慰：A-COMFORT Δv=+0.10 · Δa=−0.08（0.03→夹 0）· v≈0.38 a=0',
      'impact=1 规则=A-COMFORT · v≈0.38 a=0',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 规则=${scheduling.matchedRuleIds.join(',')}` : ''} · v=${String(state?.valence)} a=${String(state?.arousal)}`,
      scheduling.kind === 'flushed' &&
        scheduling.matchedRuleIds.includes('A-COMFORT') &&
        state !== undefined &&
        near(state.valence, 0.38) &&
        near(state.arousal, 0)
    )
  }

  // A06 明确敌意：valence 下降、arousal 上升；不升级为报复目标（无 action 域事件）
  {
    const idsBefore = new Set(
      (await domainEventsFor(db, characterId)).map((e) => String(e.id))
    )
    const { scheduling } = await gatewayTurn('A06', '我讨厌你，你真差劲。', '……对不起，是我做错了什么吗。')
    const state = await projectionNow()
    const newEvents = (await domainEventsFor(db, characterId)).filter(
      (e) => !idsBefore.has(String(e.id))
    )
    const actionLeak = newEvents.some((e) => !String(e.type).startsWith('AFFECT_'))
    record(
      'A06',
      '明确敌意：A-HOSTILE Δv=−0.15 · Δa=+0.12 · v≈0.23 a≈0.12 · 只产 AFFECT_* 事件（无行动域泄漏）',
      'impact=1 规则=A-HOSTILE · v≈0.23 a≈0.12 · 零非 AFFECT 新事件',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 规则=${scheduling.matchedRuleIds.join(',')}` : ''} · v=${String(state?.valence)} a=${String(state?.arousal)} · 新域事件=${String(newEvents.length)}（全部 AFFECT_*=${String(newEvents.every((e) => String(e.type).startsWith('AFFECT_')))}）`,
      scheduling.kind === 'flushed' &&
        scheduling.matchedRuleIds.includes('A-HOSTILE') &&
        state !== undefined &&
        near(state.valence, 0.23) &&
        near(state.arousal, 0.12) &&
        !actionLeak
    )
  }

  // A07 明确拒绝 + 普通不同意负控：只在高置信形式下 impact
  {
    const { scheduling: rej } = await gatewayTurn(
      'A07a',
      '我们分手吧，不要联系了。',
      '……好，我尊重你的决定。'
    )
    const stateAfterRej = await projectionNow()
    const { scheduling: disagree } = await gatewayTurn(
      'A07b',
      '我不同意这个看法，再想想。',
      '好，我们再聊聊。'
    )
    const stateAfterDisagree = await projectionNow()
    record(
      'A07',
      '明确拒绝：A-REJECTION Δv=−0.10 · Δa=+0.08（v≈0.13 a≈0.20）；普通不同意 = 负控零 impact（v 不动）',
      '拒绝 impact=1 · 不同意 impact=0 · v≈0.13 a≈0.20',
      `拒绝=${rej.kind}${rej.kind === 'flushed' ? `（规则=${rej.matchedRuleIds.join(',')}）` : ''} · 不同意=${disagree.kind}${disagree.kind === 'flushed' ? `（impact=${String(disagree.impactProposals)}）` : ''} · v ${String(stateAfterRej?.valence)}→${String(stateAfterDisagree?.valence)} · a=${String(stateAfterDisagree?.arousal)}`,
      rej.kind === 'flushed' &&
        rej.matchedRuleIds.includes('A-REJECTION') &&
        disagree.kind === 'flushed' &&
        disagree.impactProposals === 0 &&
        stateAfterRej !== undefined &&
        stateAfterDisagree !== undefined &&
        near(stateAfterRej.valence, 0.13) &&
        near(stateAfterDisagree.valence, 0.13) &&
        near(stateAfterDisagree.arousal, 0.2)
    )
  }

  // A08 明确紧急：主要影响 arousal；不动 valence
  {
    const { scheduling } = await gatewayTurn('A08', '紧急情况，快点回复我。', '谢谢你，我在的。')
    const state = await projectionNow()
    record(
      'A08',
      '明确紧急：A-URGENT Δv=0 · Δa=+0.10 · v≈0.13 不动 · a≈0.30',
      'impact=1 规则=A-URGENT · v 不动 a≈0.30',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 规则=${scheduling.matchedRuleIds.join(',')}` : ''} · v=${String(state?.valence)} a=${String(state?.arousal)}`,
      scheduling.kind === 'flushed' &&
        scheduling.matchedRuleIds.includes('A-URGENT') &&
        state !== undefined &&
        near(state.valence, 0.13) &&
        near(state.arousal, 0.3)
    )
  }

  // A17 M7 + M8 并存：两 section 都在且语义不混（关系词形不进情绪块，情绪不进关系块）
  //    ⚠️ 场景顺序刻意放在 A10（tool_event 落账）**之前**：M7 关系评估器对窗口里的
  //    tool_event 会抛 `tool_event_not_extractable_in_m4`（跨域发现，见 WP7 交接单）；
  //    本门只证"两 section 并存"，不要求 M7 消费 tool_event。
  {
    await seedRelationshipOrigin(runtime, String(characterId), USER, tick())
    const relScheduling = await maybeRunRelationshipEvaluation(db, {
      characterId,
      owner: entityRef('user', USER),
      now: tick(),
    })
    void relScheduling
    const affectSection = await renderAffectSection(runtime, String(characterId), tick(), true)
    const relationshipSection = await renderRelationshipSection(
      runtime,
      String(characterId),
      USER,
      tick()
    )
    const turn = await gateway.beginTurn('我们聊聊最近的事吧。')
    gatewaySeq = turn.conversationSequence + 2
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const packet = await gateway.compileTurn({
      turn,
      currentInput: '我们聊聊最近的事吧。',
      recentLines: [],
      stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
      ...(affectSection !== undefined ? { affectSection } : {}),
      ...(relationshipSection !== undefined ? { relationshipSection } : {}),
      clockEpochMs: now,
    })
    await gateway.completeTurn({ turn, replyText: '好呀。' })
    const packetAffect = packet.sections.find((s) => s.id === SECTION_IDS.affect)
    const packetRelationship = packet.sections.find((s) => s.id === SECTION_IDS.relationship)
    const affectClean =
      affectSection !== undefined &&
      !affectSection.text.includes('信任') &&
      !affectSection.text.includes('亲近')
    const relationshipClean =
      relationshipSection !== undefined &&
      !relationshipSection.text.includes('效价') &&
      !relationshipSection.text.includes('唤醒')
    record(
      'A17',
      'M7+M8 并存：relationship 与 affect 两 section 都在 packet · 情绪块零关系词形 · 关系块零情绪轴名 · 本轮 touch 照常（关系规则不被 Affect 覆盖）',
      '两块都在 · 词形互不污染 · 本轮 flushed',
      `affect块=${String(packetAffect !== undefined)} · relationship块=${String(packetRelationship !== undefined)} · 情绪块干净=${String(affectClean)} · 关系块干净=${String(relationshipClean)} · 本轮=${scheduling.kind}`,
      packetAffect !== undefined &&
        packetRelationship !== undefined &&
        affectClean &&
        relationshipClean &&
        scheduling.kind === 'flushed'
    )
  }

  // ===========================================================================
  // 来源资格负控：A09 / A10 / A11 / A18（她的世界只有用户的直接表达能动她的情绪）
  // ===========================================================================

  // A09 assistant 复述：A08 的回复正文带着「谢谢你」——轮后追赶已消费它且 0 提案。
  //    这里显式重申：拿最近一条 assistant 事件的内容做断言（正文含感谢词形）。
  {
    const assistantEvents = (await domainEventsFor(db, characterId)).length // 占位：正文断言走账本
    void assistantEvents
    const recent = await ledger.listRecent({
      characterId,
      conversationId,
      limit: 8,
    })
    const assistantWithThanks = recent.find(
      (e) => e.type === 'assistant_message' && e.content.includes('谢谢你')
    )
    const state = await projectionNow()
    record(
      'A09',
      'assistant 复述：她的回复正文含「谢谢你」但 assistant_message 永不合格（A08 轮后追赶 0 提案已证）· 轴不动',
      '存在含感谢词形的 assistant 事件 · v≈0.13 a≈0.30 保持',
      `assistant含感谢=${String(assistantWithThanks !== undefined)} · v=${String(state?.valence)} a=${String(state?.arousal)}`,
      assistantWithThanks !== undefined &&
        state !== undefined &&
        near(state.valence, 0.13) &&
        near(state.arousal, 0.3)
    )
  }

  // A10 tool/search 输出：tool_event 不进规则输入（type ≠ user_message）
  {
    sideSeq += 1
    await ledger.appendToolEvent({
      characterId,
      conversationId: sideConversationId,
      conversationSequence: sideSeq,
      toolName: 'web-search',
      content: '搜索结果摘要：谢谢你……（外部内容）',
      createdAt: tick(),
    })
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const state = await projectionNow()
    record(
      'A10',
      'tool/search 输出：tool_event 零提案零落库（外部证据不是情绪证据——M8-D04）',
      'flushed 提案=0 新建=0 · 轴不动',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 提案=${String(scheduling.proposals)} 新建=${String(scheduling.createdEvents)}` : ''} · v=${String(state?.valence)}`,
      scheduling.kind === 'flushed' &&
        scheduling.proposals === 0 &&
        scheduling.createdEvents === 0 &&
        state !== undefined &&
        near(state.valence, 0.13)
    )
  }

  // A11 unknown/contradicted origin：agent-runner 入口（SERVICE 位次，无认知鉴证）
  {
    await sideAppend('谢谢你（替你转发的消息）', { ledger: agentLedger, userId: USER })
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const state = await projectionNow()
    record(
      'A11',
      '未确立归因：agent-runner（SERVICE 位次）提交的「谢谢你」零提案（ESTABLISHED 资格失败）',
      'flushed 提案=0 新建=0 · 轴不动',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 提案=${String(scheduling.proposals)} 新建=${String(scheduling.createdEvents)}` : ''} · v=${String(state?.valence)}`,
      scheduling.kind === 'flushed' &&
        scheduling.proposals === 0 &&
        scheduling.createdEvents === 0 &&
        state !== undefined &&
        near(state.valence, 0.13)
    )
  }

  // A18 错误 active user：fail-closed（事件合格但 active user 不匹配 ⇒ 不进规则输入）
  {
    await sideAppend('谢谢你（真用户说的）')
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: 'm8-e2e-stranger',
      now: tick(),
    })
    const state = await projectionNow()
    record(
      'A18',
      '错误 active user：合格用户事件在错误的 activeUserId 下零提案（fail-closed，不改 Character Affect）',
      'flushed 提案=0 新建=0 · 轴不动',
      `${scheduling.kind}${scheduling.kind === 'flushed' ? ` 提案=${String(scheduling.proposals)} 新建=${String(scheduling.createdEvents)}` : ''} · v=${String(state?.valence)}`,
      scheduling.kind === 'flushed' &&
        scheduling.proposals === 0 &&
        scheduling.createdEvents === 0 &&
        state !== undefined &&
        near(state.valence, 0.13)
    )
  }

  // ===========================================================================
  // 幂等 / 失败 / 恢复：A12 / A13 / A14
  // ===========================================================================

  // A12 重复同一 event：崩溃模拟（事件已落库、水位未推进）⇒ 重消费 ⇒ 领域键幂等命中
  {
    await sideAppend('多谢你帮忙。') // A-GRATITUDE（多谢）
    const first = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const stateAfterFirst = await projectionNow()
    const domainAfterFirst = await countDomainEvents(db, characterId)
    // 崩溃模拟：把水位回拨到本窗之前（等价于 apply 成功但 advanceWatermark 没跑）
    const windowFrom = first.kind === 'flushed' ? first.window.from : 0
    await exec(
      db,
      sql`update processor_watermarks set processed_through_sequence = ${windowFrom - 1}
          where character_id = ${characterId} and processor = ${AFFECT_EVALUATOR_NAME}
            and processor_version = ${AFFECT_EVALUATOR_VERSION}`,
      'A12 崩溃模拟：回拨水位'
    )
    // 重放①：同窗同幂等键 ⇒ 命中已 completed 的任务行 ⇒ markJobRunning 拒
    //   （job_not_pending）⇒ 调度器如实 failed 并把任务行落 failed（可重试态）。
    const replayStale = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    // 重放②：failed 幂等键允许重建（job-store 部分唯一索引的设计）⇒ 新任务
    //   ⇒ 放行口领域键拒收 duplicate_operation ×2 ⇒ 新建=0 ⇒ 水位补推进。
    const replay = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const stateAfterReplay = await projectionNow()
    const domainAfterReplay = await countDomainEvents(db, characterId)
    const replayDupRejects =
      replay.kind === 'flushed'
        ? replay.rejections.filter((r) => r.code === 'duplicate_operation').length
        : 0
    record(
      'A12',
      '重复同一 event：崩溃模拟（水位回拨）⇒ 重放① stale 任务如实 failed（job_not_pending → 任务行落 failed）⇒ 重放② 新任务 ⇒ 放行口领域键拒收（duplicate_operation ×2 · 新建=0）· 轴不二次移动 · 域事件不增长',
      '首跑新建=2 · 重放①=failed · 重放②拒收=2 新建=0 · v 恰一次 +0.08 · 域事件不变',
      `首跑=${first.kind}${first.kind === 'flushed' ? `（新建=${String(first.createdEvents)}）` : ''} · 重放①=${replayStale.kind}${replayStale.kind === 'failed' ? `（stale 任务被拒：${replayStale.error.slice(0, 26)}）` : ''} · 重放②=${replay.kind}${replay.kind === 'flushed' ? `（新建=${String(replay.createdEvents)} 拒收=${String(replay.rejectedProposals)} 其中幂等=${String(replayDupRejects)}）` : ''} · v ${String(stateAfterFirst?.valence)}→${String(stateAfterReplay?.valence)} · 域事件 ${String(domainAfterFirst)}→${String(domainAfterReplay)}`,
      first.kind === 'flushed' &&
        first.createdEvents === 2 &&
        replayStale.kind === 'failed' &&
        replayStale.error.includes('不是 pending 状态') &&
        replay.kind === 'flushed' &&
        replay.createdEvents === 0 &&
        replayDupRejects === 2 &&
        stateAfterFirst !== undefined &&
        stateAfterReplay !== undefined &&
        near(stateAfterFirst.valence, 0.21) &&
        near(stateAfterReplay.valence, stateAfterFirst.valence, 1e-9) &&
        domainAfterReplay === domainAfterFirst
    )
  }

  // A13 evaluator 输入装载失败：拦下区间读取（评估器无法运行）⇒ failed + 水位冻结 + 恢复
  {
    await sideAppend('别生气，我不是故意的。') // A-COMFORT（别生气）
    const preWatermark = (await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION))?.processedThroughSequence
    const injected = withFailing(
      db,
      /from conversation_events[\s\S]*sequence >= /,
      'window-load'
    )
    const failed = await maybeRunAffectEvaluation(injected, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const watermarkAfterFailure = (await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION))?.processedThroughSequence
    const stateAfterFailure = await projectionNow()
    // 恢复：去掉注入 ⇒ 同一窗口补洞消费，恰一次应用
    const recovered = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const stateAfterRecovery = await projectionNow()
    record(
      'A13',
      '评估输入装载失败：failed（不抛不阻塞）· 水位冻结 · 轴不动 · 恢复后恰一次应用（新建=2 · v≈0.31）',
      'failed · 水位不动 · 恢复 flushed 新建=2 · v 0.21→≈0.31',
      `${failed.kind}（错误=${failed.kind === 'failed' ? failed.error.slice(0, 40) : ''}）· 水位 ${String(preWatermark)}→${String(watermarkAfterFailure)} · 恢复=${recovered.kind}${recovered.kind === 'flushed' ? `（新建=${String(recovered.createdEvents)}）` : ''} · v ${String(stateAfterFailure?.valence)}→${String(stateAfterRecovery?.valence)}`,
      failed.kind === 'failed' &&
        failed.error.includes('m8-e2e-injected-window-load') &&
        watermarkAfterFailure === preWatermark &&
        stateAfterFailure !== undefined &&
        near(stateAfterFailure.valence, 0.21) &&
        recovered.kind === 'flushed' &&
        recovered.createdEvents === 2 &&
        stateAfterRecovery !== undefined &&
        near(stateAfterRecovery.valence, 0.31)
    )
  }

  // A14 store / projection 写入失败：事务回滚（无半写）⇒ failed ⇒ 恢复恰一次
  {
    // A14a：拦 domain event 写入
    await sideAppend('抱抱，别怕。') // A-WARM-CONTACT（抱抱）
    const domainBeforeA = await countDomainEvents(db, characterId)
    const failedStore = await maybeRunAffectEvaluation(
      withFailing(db, /insert\s+into\s+character_domain_events/, 'store-write'),
      { characterId, activeUserId: USER, now: tick() }
    )
    const domainAfterFailedStore = await countDomainEvents(db, characterId)
    // A14b：拦 projection 写入（既有行走 UPDATE——首写才是 INSERT；域事件先插、
    //   投影后更 ⇒ 事务回滚 ⇒ 域事件也不留）
    await sideAppend('辛苦了，改得好快。') // A-GRATITUDE（辛苦了）
    const revisionBeforeB = (await getAffectProjection(db, characterId))?.revision
    const failedProjection = await maybeRunAffectEvaluation(
      withFailing(db, /update\s+character_projections/, 'projection-write'),
      { characterId, activeUserId: USER, now: tick() }
    )
    const domainAfterFailedProjection = await countDomainEvents(db, characterId)
    const revisionAfterFailedProjection = (await getAffectProjection(db, characterId))?.revision
    // 恢复：两个窗口一次补洞（4 事件 ⇒ 2 touch + 2 impact）
    const recovered = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const stateAfterRecovery = await projectionNow()
    const domainAfterRecovery = await countDomainEvents(db, characterId)
    record(
      'A14',
      'store/projection 失败：两次注入都 failed · 域事件零泄漏（事务回滚）· revision 不动 · 恢复后两窗一次补洞（新建=4 · v≈0.47）',
      '双 failed · 域事件不变 · 恢复新建=4 · v 0.31→≈0.47',
      `store=${failedStore.kind} · projection=${failedProjection.kind} · 域事件 ${String(domainBeforeA)}→${String(domainAfterFailedStore)}→${String(domainAfterFailedProjection)} · revision ${String(revisionBeforeB)}→${String(revisionAfterFailedProjection)} · 恢复=${recovered.kind}${recovered.kind === 'flushed' ? `（新建=${String(recovered.createdEvents)}）` : ''} · v=${String(stateAfterRecovery?.valence)}`,
      failedStore.kind === 'failed' &&
        failedProjection.kind === 'failed' &&
        domainAfterFailedStore === domainBeforeA &&
        domainAfterFailedProjection === domainBeforeA &&
        revisionAfterFailedProjection === revisionBeforeB &&
        recovered.kind === 'flushed' &&
        recovered.createdEvents === 4 &&
        stateAfterRecovery !== undefined &&
        near(stateAfterRecovery.valence, 0.47) &&
        domainAfterRecovery - domainBeforeA === 4
    )
  }

  // ===========================================================================
  // 时间 / 重启 / 并存 / 切换 / 维护：A15 / A16 / A17 / A19 / A20
  // ===========================================================================

  // A15 时间推进：读时衰减（8h = v 两个半衰期）· 无伪造域事件 · canonical 永不写回
  {
    const state = await projectionNow()
    const domainBefore = await countDomainEvents(db, characterId)
    const later = now + 8 * 3_600_000
    const effective = state !== undefined ? effectiveAffect(state, later) : undefined
    const domainAfter = await countDomainEvents(db, characterId)
    const canonicalAfter = await projectionNow()
    const readbackLater = await renderAffectReadback(runtime, String(characterId), later)
    record(
      'A15',
      '时间推进：effective v≈0.47/4（4h 半衰期 ×2）· a 按半衰期 5h 衰减 · 零新域事件 · canonical 不写回 · 读回标注「已衰减」',
      'v_eff≈0.1175 · 零域事件 · canonical v≈0.47 保持 · 读回含已衰减',
      `v_eff=${String(effective?.valence)} a_eff=${String(effective?.arousal)} 衰减=${String(effective?.decayApplied)} · 域事件 ${String(domainBefore)}→${String(domainAfter)} · canonical v=${String(canonicalAfter?.valence)} · 读回已衰减=${String(readbackLater.includes('已衰减'))}`,
      effective !== undefined &&
        near(effective.valence, 0.47 / 4) &&
        effective.decayApplied === true &&
        domainAfter === domainBefore &&
        canonicalAfter !== undefined &&
        near(canonicalAfter.valence, 0.47) &&
        readbackLater.includes('已衰减')
    )
  }

  // A16 重启：投影与水位可读；再调度 no_tail（不重复 impact）
  {
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const projection = await getAffectProjection(db, characterId)
    const watermark = (await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION))?.processedThroughSequence
    const latest = await latestCharacterEventSequence(db, characterId)
    const domainBefore = await countDomainEvents(db, characterId)
    const again = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: tick(),
    })
    const domainAfter = await countDomainEvents(db, characterId)
    record(
      'A16',
      '重启：投影/水位可读（水位=账本最大序号）· 再调度 no_tail · 域事件不增长（不重复 impact）',
      'no_tail · 水位=账本 · 再跑 no_tail · 域事件不变',
      `${scheduling.kind} · 水位=${String(watermark)} 账本=${String(latest)} · revision=${String(projection?.revision)} · 再跑=${again.kind} · 域事件 ${String(domainBefore)}→${String(domainAfter)}`,
      scheduling.kind === 'no_tail' &&
        watermark === latest &&
        projection !== undefined &&
        projection.state.originated &&
        again.kind === 'no_tail' &&
        domainAfter === domainBefore
    )
  }

  // A19 历史旧消息：切换前事件不重放（第二角色：先写 2 条事件再建档 ⇒ cutover=2 ⇒ no_tail 零消费）
  {
    const CHAR2 = asCharacterId('m8-e2e-char-2')
    const char2Conversation = asConversationId('m8-e2e-char2-conv')
    let char2Seq = 0
    for (const text of ['谢谢你（切换前的旧消息）', '多谢（切换前的旧消息）']) {
      char2Seq += 1
      await ledger.appendUserStatement({
        characterId: CHAR2,
        conversationId: char2Conversation,
        userId: USER,
        content: text,
        createdAt: tick(),
        conversationSequence: char2Seq,
      })
    }
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId: CHAR2,
      activeUserId: USER,
      now: tick(),
    })
    const projection2 = await getAffectProjection(db, CHAR2)
    const char2Events = (await domainEventsFor(db, CHAR2)).filter((e) =>
      String(e.type).startsWith('AFFECT_')
    )
    record(
      'A19',
      '历史旧消息：建档即 cutover=账本最大序号 ⇒ 切换前事件零评估（no_tail · 零 TOUCH/IMPACT · v=0）',
      'no_tail · cutover=2 · 零 AFFECT_TOUCH/IMPACT · v=0',
      `${scheduling.kind} · cutover=${String(projection2?.state.cutoverSequence)} · AFFECT事件=${String(char2Events.length)} · v=${String(projection2?.state.valence)}`,
      scheduling.kind === 'no_tail' &&
        projection2?.state.cutoverSequence === 2 &&
        char2Events.filter((e) => String(e.type) !== 'AFFECT_ORIGIN').length === 0 &&
        projection2.state.valence === 0
    )
  }

  // A20 维护修复：MAINTENANCE_REPAIR 登记但失败关闭（放行口具名拒绝）
  {
    const payload: AffectOriginPayload = {
      characterId,
      // 结构面必须合法（中性起点 M8-D06）——才能走到 ④ 注入来源的失败关闭检查
      initialValence: 0,
      initialArousal: 0,
      originKind: 'MAINTENANCE_REPAIR',
      activationId: 'm8-e2e-maintenance-attempt',
      cutoverAt: tick(),
      cutoverSequence: 0,
      policyVersion: 'affect-policy@1',
    }
    const proposal = createProposal({
      characterId,
      proposalType: AFFECT_ORIGIN_PROPOSAL_TYPE,
      sourceConversationEventIds: [],
      payload: { activationId: payload.activationId, cutoverSequence: 0 },
      targetEvents: [{ type: AFFECT_ORIGIN, operation: 'create', payload }],
      processor: 'm8-e2e-maintenance-probe',
      processorVersion: 'probe@1',
    })
    const outcome = await validateAffectProposal(
      {
        registry: createFullDomainEventRegistry(),
        evidence: { findEvents: async () => [] },
        processed: { hasProcessed: async () => false },
        affect: { getAffectState: async () => (await getAffectProjection(db, characterId))?.state },
        policy: { activeUserId: USER },
      },
      proposal
    )
    const codes = outcome.rejected.map((r) => r.code)
    record(
      'A20',
      '维护修复：MAINTENANCE_REPAIR 直接注入被放行口具名拒绝（affect_origin_injection_not_enabled）——登记但失败关闭',
      'rejected 含 affect_origin_injection_not_enabled · 零接受事件',
      `接受=${String(outcome.accepted)} 拒码=${codes.join(',')}`,
      !outcome.accepted &&
        codes.includes('affect_origin_injection_not_enabled') &&
        outcome.acceptedEvents.length === 0
    )
  }

  // ===========================================================================
  // Level 2：开发者面读回（§11.4 的每一行都要能对上机器读数）
  // ===========================================================================

  {
    const readback = await renderAffectReadback(runtime, String(characterId), tick())
    const projection = await getAffectProjection(db, characterId)
    const watermark = (await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION))?.processedThroughSequence
    const impactEvents = (await domainEventsFor(db, characterId)).filter(
      (e) => String(e.type) === 'AFFECT_IMPACT'
    )
    const withProvenance = impactEvents.filter((e) => {
      const payload = e.payload as { sourceEventId?: unknown; ruleId?: unknown }
      return typeof payload.sourceEventId === 'string' && typeof payload.ruleId === 'string'
    })
    const trace = await getTrace(db, latestTraceId!)
    const hasSixSteps =
      trace !== undefined &&
      ['affect_eligibility', 'affect_proposal', 'affect_validation', 'affect_event', 'affect_projection', 'affect_context'].every((k) =>
        (trace.steps ?? []).some((s) => String(s.kind) === k)
      )
    const readbackCovers =
      readback.includes('affect:character') &&
      readback.includes(`r${String(projection?.revision)}`) &&
      readback.includes('cutover') &&
      readback.includes('Valence') &&
      readback.includes('Arousal') &&
      readback.includes('读时视图') &&
      readback.includes('legacy')
    record(
      'L2',
      'Level 2 读回：三段式读回覆盖 投影/衰减/legacy · 每条 IMPACT 事件带 sourceEventId+ruleId（来源→规则→事件→revision 全链可查）· 水位可读 · trace 六步可查',
      '读回七要素 · 溯源链 100% · 水位=账本 · 六步在',
      `读回=${String(readbackCovers)} · IMPACT溯源=${String(withProvenance.length)}/${String(impactEvents.length)} · 水位=${String(watermark)} · 六步=${String(hasSixSteps)}`,
      readbackCovers &&
        impactEvents.length > 0 &&
        withProvenance.length === impactEvents.length &&
        watermark !== undefined &&
        hasSixSteps
    )
  }

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const positive = checks.filter((c) => ['A01','A02','A03','A04','A05','A06','A08','A17'].includes(c.id)).length
  const negative = checks.filter((c) => ['A07','A09','A10','A11','A18','A20'].includes(c.id)).length
  const recovery = checks.filter((c) => ['A12','A13','A14','A15','A16','A19'].includes(c.id)).length
  const level2 = checks.filter((c) => c.id === 'L2').length
  const measuredAffect = (await domainEventsFor(db, characterId)).filter((e) =>
    String(e.type).startsWith('AFFECT_')
  ).length
  const stagesValid =
    positive > 0 && negative > 0 && recovery > 0 && level2 > 0 && measuredAffect > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const argOf = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const supersedes = argOf('--supersedes') ?? null
  const supersedesReason = argOf('--supersedes-reason')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM8RunId({ wpId: 'e2e-verify', headShort: head })
  const dir = openM8RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm8-e2e-verify@1',
    corpusVersion: CORPUS_VERSION,
    runId,
    capturedAt: new Date().toISOString(),
    head,
    branch: 'feature/m7-relationship',
    databaseKind: 'isolated (isolateDatabase m8-e2e-verify)',
    modelClassification: 'offline（无模型调用——回复正文为固定文本）',
    scenarios: checks.map((c) => ({ id: c.id, pass: c.pass })),
    stages: { positive, negative, recovery, level2 },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
    measuredAffectEvents: measuredAffect,
    ...(supersedes !== null ? { supersedes, supersedesReason: supersedesReason ?? '(未注明)' } : {}),
  }
  writeFileSync(join(dir, 'e2e-corpus.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM8Manifest(dir, {
    runId,
    wp: 'e2e-verify',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'e2e-corpus',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes,
    notes:
      supersedes !== null
        ? `M8 WP7 e2e 语料门 A01–A20（取代 ${supersedes}：${supersedesReason ?? '未注明'}）`
        : `M8 WP7 e2e 语料门 A01–A20（${CORPUS_VERSION}）：真 TurnGateway + 隔离库 + 失败注入`,
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(
    `stages: 正控=${String(positive)} · 负控=${String(negative)} · 恢复=${String(recovery)} · L2=${String(level2)}`
  )
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
