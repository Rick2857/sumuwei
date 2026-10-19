/**
 * M9 WP8 门 3/3：规模门（计划 §14.4 的 B42 / B43 信念半 / B45 / B47，审计修订范围）。
 *
 * 范围裁定（M9-M95-Overlap-Audit.md，2026-09-27）：
 *   · B42（2000/2001/4001 分页/水位）→ 本门。BELIEF_PAGE_SIZE=2000，三个规模
 *     恰好落在页边界上：2000=整页、2001=页脚+1、4001=两整页+1。
 *   · B43 信念半边（核心依赖 ID 回查完整）→ 本门；Recall 候选范围半边
 *     = CANCELLED（M9.5 TD-08/S31/S32 接收，审计 §3.1 裁定二）。
 *   · B45（投影删除重建逐字段一致）→ 本门（2000+ 规模版；小样已由 e2e B30
 *     在真链覆盖）。
 *   · B47（同一修订跨 session/process 稳定）→ 本门。可测主张 = 规划是事件流
 *     的纯函数：两套独立依赖图（不同 processor 身份）产出同一目标/同一因果
 *     载荷；真跨进程部署性质由确定性 + 事件溯源重建（B45）承载。
 *   · m9:long:verify（B32 长轨迹）= CANCELLED，不建（审计 §3.1 裁定一）。
 *
 * 运行：pnpm m9:scale:verify（隔离库；不碰真实库；无模型）
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'



import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  maybeRunBeliefEvaluation,
  maybeRunBeliefMemoryReconciliation,
  createBeliefJobPorts,
  seedBeliefOrigin,
} from '../src/infrastructure/runtime/belief-scheduler.ts'
import {
  planBeliefForget,
  type BeliefRevisionDeps,
} from '../src/kernel/app/belief/revision.ts'
import {
  recheckBeliefDependencies,
  type BeliefEligibilityDeps,
} from '../src/kernel/app/belief/eligibility.ts'
import {
  validateBeliefProposal,
  type BeliefValidatorDeps,
} from '../src/kernel/policies/belief-validator.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { applyMemoryEvent } from '../src/infrastructure/persistence/memory-store.ts'
import { appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import {
  listBeliefsByStatus,
  forbiddenRootsForSlot,
  rebuildBeliefProjections,
} from '../src/infrastructure/persistence/belief-store.ts'
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_SCOPE,
  beliefSlotKeyOf,
} from '../src/kernel/contracts/belief.ts'
import {
  MEMORY_REDUCER_VERSION,
  MEMORY_SCHEMA_VERSION,
  conversationEvidence,
  type MemoryRecord,
} from '../src/kernel/contracts/memory.ts'
import {
  asCharacterId,
  asConversationId,
  asEntityId,
  entityRef,
} from '../src/kernel/contracts/index.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import { DOMAIN_EVENT_SCOPE } from '../src/kernel/contracts/domain-event.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = process.cwd()

interface ScenarioRecord {
  id: string
  label: string
  status: 'pass' | 'fail' | 'deferred' | 'na' | 'cancelled'
  detail: string
  evidence?: { sourceIds?: string[]; eventIds?: string[]; counts?: Record<string, number> }
}
const records: ScenarioRecord[] = []

function scenario(
  id: string,
  label: string,
  status: ScenarioRecord['status'],
  detail: string,
  evidence?: ScenarioRecord['evidence'],
): boolean {
  records.push({ id, label, status, detail, evidence })
  const mark =
    status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'deferred' ? '⏭' : status === 'cancelled' ? '🚫' : '➖'
  console.log(`  ${mark} ${id} ${label} :: ${detail}`)
  return status === 'pass'
}

// ===========================================================================
// 主流程
// ===========================================================================

async function main(): Promise<void> {
  console.log('\n=== M9 scale：B42/B43(信念半)/B45/B47（页边界规模 + 重建 + 修订稳定） ===')

  isolateDatabase('m9-scale-verify', { keep: false })
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
  const USER = 'm9-scale-user'
  const USER_ENTITY = entityRef('user', USER)
  const CONV_A = asConversationId('m9-scale-conv-a')
  const CONV_B = asConversationId('m9-scale-conv-b')
  const T0 = Date.UTC(2026, 8, 27, 9, 0, 0)
  let tickMs = 0
  const tick = (): number => T0 + (tickMs += 500)

  const originSeed = await seedBeliefOrigin(db, {
    characterId,
    activationId: 'm9-wp8-scale-act-1',
    now: tick(),
  })
  if (originSeed.kind !== 'seeded' && originSeed.kind !== 'already') {
    scenario('S00', '建档', 'fail', `建档失败：${String(originSeed.kind)}`)
    finish()
    return
  }

  // ---- 事件夹具（与 e2e 同构：RECORDED 信封用户事件）----------------------
  const convCounters = new Map<string, number>()
  const nextSeq = (conversationId: string): number => {
    const seq = (convCounters.get(conversationId) ?? 0) + 1
    convCounters.set(conversationId, seq)
    return seq
  }
  const userIngress = createHumanConsoleUserTurnIngress()
  const appendEvent = async (input: {
    conversationId: string
    content: string
  }): Promise<{ id: string; sequence: number }> => {
    const seq = nextSeq(input.conversationId)
    const { event } = await appendConversationEvent(db, {
      characterId,
      conversationId: asConversationId(input.conversationId),
      conversationSequence: seq,
      type: 'user_message',
      actorType: 'user',
      actorId: USER,
      content: input.content,
      createdAt: tick(),
      trustedAttribution: userIngress.attest({
        characterId: String(characterId),
        presenterActorId: USER,
        userId: USER,
      }),
    })
    return { id: String(event.id), sequence: event.sequence }
  }

  // ---- Memory 夹具（reported 白名单形状；id 一律走变量，禁止硬编码）-------
  let memSeq = 0
  const anchorMemories: { memoryId: string; rootEventId: string; value: string }[] = []
  const createAnchorMemory = async (rootEventId: string, value: string): Promise<string> => {
    memSeq += 1
    const memoryId = `mem-m9-scale-${String(memSeq).padStart(3, '0')}`
    const record: MemoryRecord = {
      id: memoryId as never,
      owner: entityRef('character', String(characterId)),
      type: 'preference',
      content: {
        kind: 'claim',
        subject: USER_ENTITY,
        predicate: 'preference.answer_length',
        value,
        qualifiers: { context: 'technical' },
      } as never,
      subjects: [USER_ENTITY],
      epistemicStatus: 'reported',
      authority: 'EXPLICIT_USER_STATEMENT',
      importance: 0.8,
      confidence: 0.9,
      status: 'active',
      sourceRefs: [conversationEvidence(rootEventId)],
      evidenceRootIds: [rootEventId as never],
      recordedAt: tick(),
      contentFingerprint: `m9-scale-fp-${String(memSeq)}`,
      revision: 0,
      reducerVersion: MEMORY_REDUCER_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      createdAt: tick(),
    } as never
    const accepted: AcceptedDomainEvent = {
      type: 'MEMORY_CREATED',
      operation: 'create',
      payload: { memoryId, mutation: 'explicit', record },
      sourceConversationEventIds: [rootEventId as never],
      idempotencyKey: `m9-scale:memory:${String(memSeq)}`,
      processor: 'm9-scale-gate',
      processorVersion: 'm9-scale-gate@1',
      scope: DOMAIN_EVENT_SCOPE,
    }
    const appended = await appendDomainEvent(db, characterId, accepted, tick())
    await applyMemoryEvent(db, appended.event, tick())
    anchorMemories.push({ memoryId, rootEventId, value })
    return memoryId
  }

  // ---- 双流运行器（记录每个窗口：B42 的判据载体）--------------------------
  interface WindowRecord {
    from: number
    to: number
    watermark: number
    latest: number
    noted: number
    proposals: number
    applied: number
  }
  const runInteractionRecording = async (baseNow: number, cap = 30): Promise<WindowRecord[]> => {
    const windows: WindowRecord[] = []
    for (let i = 0; i < cap; i += 1) {
      const run = await maybeRunBeliefEvaluation(db, {
        characterId,
        activeUserId: USER,
        now: baseNow + i * 500,
      })
      if (run.kind === 'flushed') {
        windows.push({
          from: run.window.from,
          to: run.window.to,
          // 调度器 flushed 结果的 watermark 字段是**推进前**旧值（belief-scheduler.ts
          // :522 读入、:598 原样返回）；advanceWatermark 落到的是窗口 to ⇒ 记 to。
          watermark: run.window.to,
          latest: run.latest,
          noted: run.outcome.notedCount,
          proposals: run.outcome.proposals,
          applied: run.outcome.applied.createdEvents,
        })
      }
      if (run.kind === 'no_tail') break
    }
    return windows
  }
  const runMemory = async (baseNow: number, cap = 20): Promise<number> => {
    let formed = 0
    for (let i = 0; i < cap; i += 1) {
      const run = await maybeRunBeliefMemoryReconciliation(db, { characterId, now: baseNow + i * 500 })
      if (run.kind === 'flushed') formed += run.outcome.formedProposals
      if (run.kind === 'no_tail') break
    }
    return formed
  }

  const allBeliefs = () => listBeliefsByStatus(db, characterId, ['active', 'disputed', 'retracted', 'superseded'])
  const inferredSlotKey = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(characterId)),
    subject: USER_ENTITY,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
  })

  // =========================================================================
  // B42：2000 / 2001 / 4001 —— 页边界分页、水位、测量计数
  // =========================================================================
  // 结构（第 1 轮实测教训：域事件与对话事件**共享** character_sequence_counters，
  // 锚点 MEMORY_CREATED 与评估器自己的 EVIDENCE_NOTED 都会推高 latest，
  // 窗口形状因此不是干净三页）：
  //   ① 先**纯灌** 4000 条对话事件（此前只有 BELIEF_ORIGIN@1 占 1）⇒ 对话
  //      seq 2..4001，页边界精确落在 2000/2001/4001；
  //   ② 交互流追赶循环一次跑完：前两页恰为 2000 宽（页钳位真实吃满），
  //      评估产生的域尾由后续小窗口诚实消费到 no_tail；
  //   ③ 锚点 Memory 在交互流收敛**之后**创建（域尾追加，不再扰动页边界）。
  // 锚点（B43 用）：对话 seq 2(最老)/50/51/500/501/2001/4000；
  // 词形根（让含词形的页 notedCount 非零）：1500/2000/2001/3500/4001。
  // 其余为不命中任何冻结词形的中性填充（'闲聊填充'——评估器具名弃权）。
  const anchorSeqs = new Set([2, 50, 51, 500, 501, 2001, 4000])
  const patternSeqs = new Set([1500, 2000, 2001, 3500, 4001])
  const patternText: Record<number, string> = {
    1500: '以后都长话短说',
    2000: '以后都简单点说',
    2001: '以后都长话短说',
    3500: '太啰嗦了，重点就行',
    4001: '以后都直接给结论',
  }
  let appended = 0
  const anchorRoots: { seq: number; eventId: string }[] = []
  const appendOne = async (seq: number): Promise<void> => {
    const conv = seq % 2 === 0 ? String(CONV_A) : String(CONV_B)
    const content = patternSeqs.has(seq) ? (patternText[seq] ?? '闲聊填充') : '闲聊填充'
    const ev = await appendEvent({ conversationId: conv, content })
    appended += 1
    if (anchorSeqs.has(seq)) anchorRoots.push({ seq, eventId: ev.id })
  }

  // ① 纯对话流：seq 2..4001（appended=4000）
  while (appended < 4000) await appendOne(appended + 2)
  // ② 交互流追赶（记录窗口）
  const windows = await runInteractionRecording(tick())
  {
    const first = windows[0]
    const second = windows[1]
    const contiguous =
      windows.length > 0 &&
      first !== undefined &&
      first.from === 1 &&
      windows.every((w, i) => i === 0 || w.from === (windows[i - 1]?.to ?? -1) + 1)
    const widthsOk = windows.every((w) => w.to - w.from + 1 <= 2000)
    const pageClampEngaged =
      first !== undefined &&
      second !== undefined &&
      first.to - first.from + 1 === 2000 &&
      second.to - second.from + 1 === 2000
    const noOvershoot = windows.every((w) => w.watermark <= w.latest)
    const finalWatermark = windows.length > 0 ? (windows[windows.length - 1]?.watermark ?? 0) : 0
    const allConvCovered = finalWatermark >= 4001
    const notedPerPage = windows.map((w) => w.noted)
    // 含词形根的页（页1:1500+2000；页2:2001+3500；页3:4001）记根必须非零
    const patternPagesNoted =
      (windows[0]?.noted ?? 0) > 0 && (windows[1]?.noted ?? 0) > 0 && (windows[2]?.noted ?? 0) > 0
    const settled = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: tick() })
    scenario(
      'B42',
      '2000/2001/4001 条源事件 → 分页无跳过、无水位超前、测量计数非零',
      contiguous &&
        widthsOk &&
        pageClampEngaged &&
        noOvershoot &&
        allConvCovered &&
        patternPagesNoted &&
        settled.kind === 'no_tail'
        ? 'pass'
        : 'fail',
      `窗口=[${windows.map((w) => `${String(w.from)}..${String(w.to)}`).join(' | ')}] 连续无缝=${String(contiguous)} 页宽≤2000=${String(widthsOk)} 整页钳位=${String(pageClampEngaged)} 水位终=${String(finalWatermark)} 无超前=${String(noOvershoot)} 对话全覆盖=${String(allConvCovered)} 各页记根=[${notedPerPage.join(',')}] 收敛no_tail=${String(settled.kind === 'no_tail')}（域尾=评估自身事件，由后续窗口消费——共享计数器的生产真相）`,
      {
        counts: {
          windows: windows.length,
          eventsAppended: appended,
          finalWatermark,
          notedTotal: notedPerPage.reduce((a, b) => a + b, 0),
        },
      },
    )
  }

  // ③ 锚点 Memory（交互流收敛后创建；域尾追加不扰动页边界）
  for (const a of anchorRoots) {
    await createAnchorMemory(a.eventId, `pos-${String(a.seq)}`)
  }

  // =========================================================================
  // B43（信念半）：锚点 Memory 位于 2/50/51/500/501/2001/4000 → 依赖 ID 回查完整
  // =========================================================================
  {
    const formed = await runMemory(tick())
    const beliefs = await allBeliefs()
    const posBeliefs = beliefs.filter(
      (b) => b.epistemicKind === 'reported' && String(b.proposition.value).startsWith('pos-'),
    )
    const ports = createBeliefJobPorts(db)
    const eligibilityDeps: BeliefEligibilityDeps = {
      characterId: String(characterId),
      evidence: { findEvents: (ids) => ports.findConversationEvents(ids as never[] as readonly never[]) },
      memory: { findMemories: (ids) => ports.findMemories(ids) },
      origin: { getBeliefOrigin: (c) => ports.belief.getBeliefOrigin(asCharacterId(c)) },
      policy: { activeUserId: USER },
    }
    const verdicts = await recheckBeliefDependencies(eligibilityDeps, beliefs)
    const posUsable = posBeliefs.map((b) => verdicts.get(String(b.beliefId))?.usable === true)
    const allUsable = posUsable.length === anchorMemories.length && posUsable.every(Boolean)
    const depIds = new Set(posBeliefs.flatMap((b) => (b.dependsOnMemoryIds ?? []).map(String)))
    const memIdsCovered = anchorMemories.every((m) => depIds.has(m.memoryId))
    scenario(
      'B43',
      'Memory 位于 2/50/51/500/501/2001/4000 → 核心依赖 ID 回查完整（信念半）',
      allUsable && memIdsCovered && posBeliefs.length === anchorMemories.length
        ? 'pass'
        : 'fail',
      `锚点信念=${String(posBeliefs.length)}/${String(anchorMemories.length)} 全部usable=${String(allUsable)} 依赖覆盖=${String(memIdsCovered)} memory流形成=${String(formed)}（Recall 候选范围半边=CANCELLED：M9.5 TD-08 接收，审计 §3.1）`,
      {
        counts: { anchorMemories: anchorMemories.length, posBeliefs: posBeliefs.length },
        sourceIds: anchorMemories.map((m) => m.rootEventId),
      },
    )
  }

  // =========================================================================
  // B47：同一修订跨 session/process → 对象/版本/因果链稳定
  // =========================================================================
  let b47BeliefId = ''
  {
    const target = (await allBeliefs()).find(
      (b) => b.epistemicKind === 'reported' && String(b.proposition.value) === 'pos-501' && b.status === 'active',
    )
    const makeDeps = (processor: string): BeliefRevisionDeps => {
      const ports = createBeliefJobPorts(db)
      return {
        characterId: String(characterId),
        processor,
        processorVersion: `${processor}@1`,
        now: () => tick(),
        belief: {
          listActiveBeliefs: (cid) => ports.belief.listActiveBeliefs(cid as never),
          listActiveBeliefsForSlot: (cid, slotKey) => ports.belief.listActiveBeliefsForSlot(cid as never, slotKey),
          getBelief: (cid, beliefId) => ports.belief.getBelief(cid as never, beliefId),
        },
      }
    }
    const planA = target !== undefined ? await planBeliefForget(makeDeps('m9-scale-rev-a'), { beliefId: String(target.beliefId) }) : undefined
    const planB = target !== undefined ? await planBeliefForget(makeDeps('m9-scale-rev-b'), { beliefId: String(target.beliefId) }) : undefined
    const sameKind = planA !== undefined && planB !== undefined && planA.kind === planB.kind
    const payloadOf = (plan: typeof planA): string =>
      plan !== undefined && plan.kind === 'proposals'
        ? JSON.stringify(plan.proposals.map((p) => (p as { targetEvents?: unknown }).targetEvents))
        : ''
    const samePayload = sameKind && payloadOf(planA) === payloadOf(planB) && payloadOf(planA) !== ''
    // 应用 planA（真放行链：validateBeliefProposal → applyAccepted）
    let applied = 0
    if (planA !== undefined && planA.kind === 'proposals') {
      const ports = createBeliefJobPorts(db)
      const validatorDeps: BeliefValidatorDeps = {
        registry: ports.registry,
        evidence: { findEvents: (ids) => ports.findConversationEvents(ids) },
        processed: { hasProcessed: (key: string) => ports.hasProcessed(key) },
        belief: {
          getBeliefOrigin: (cid) => ports.belief.getBeliefOrigin(cid),
          getBelief: (cid, beliefId) => ports.belief.getBelief(cid, beliefId),
          listActiveBeliefsForSlot: (cid, slotKey) => ports.belief.listActiveBeliefsForSlot(cid, slotKey),
          forbiddenRootsForSlot: (cid, slotKey) => ports.belief.forbiddenRootsForSlot(cid, slotKey),
        },
        memory: { findMemories: (ids) => ports.findMemories(ids) },
        policy: { activeUserId: USER },
      }
      for (const proposal of planA.proposals) {
        const outcome = await validateBeliefProposal(validatorDeps, proposal)
        if (outcome.accepted) {
          const res = await ports.applyAccepted(characterId, outcome.acceptedEvents, tick())
          applied += res.createdEvents
        }
      }
    }
    const retractedRow = (await allBeliefs()).find((b) => String(b.proposition.value) === 'pos-501')
    const retracted = retractedRow !== undefined && retractedRow.status === 'retracted'
    // 第三套依赖图：对已撤回目标重规划 → clarify（不猜、不抢跑）——确定性下游
    const planC = target !== undefined ? await planBeliefForget(makeDeps('m9-scale-rev-c'), { beliefId: String(target.beliefId) }) : undefined
    const downstreamDeterministic = planC !== undefined && planC.kind === 'clarify' && planC.reason === 'belief_not_active'
    b47BeliefId = target !== undefined ? String(target.beliefId) : ''
    scenario(
      'B47',
      '同一修订跨 session/process → 对象/版本/因果链稳定',
      sameKind && samePayload && applied >= 1 && retracted && downstreamDeterministic ? 'pass' : 'fail',
      `双图同kind=${String(sameKind)} 同目标载荷=${String(samePayload)} 应用事件=${String(applied)} 已撤回=${String(retracted)} 重规划=clarify:${String(downstreamDeterministic)}（可测主张=规划是事件流纯函数；真跨进程由确定性+事件溯源重建承载）`,
      { eventIds: b47BeliefId !== '' ? [b47BeliefId] : [] },
    )
  }

  // =========================================================================
  // B45：删除派生投影再重建 → canonical state 逐字段一致（4001 事件规模）
  // =========================================================================
  {
    const snapshot = async (): Promise<string> => {
      const rows = await allBeliefs()
      return JSON.stringify(
        rows
          .map((b) => JSON.parse(JSON.stringify(b)))
          .sort((a: { beliefId?: unknown }, c: { beliefId?: unknown }) => String(a.beliefId).localeCompare(String(c.beliefId))),
      )
    }
    const before = await snapshot()
    const forbiddenBefore = [...(await forbiddenRootsForSlot(db, characterId, inferredSlotKey))].sort()
    const rebuilt = await rebuildBeliefProjections(db, characterId, tick())
    const after = await snapshot()
    const forbiddenAfter = [...(await forbiddenRootsForSlot(db, characterId, inferredSlotKey))].sort()
    const identical = before === after && before !== '[]'
    const forbiddenIdentical = forbiddenBefore.join('|') === forbiddenAfter.join('|')
    // B47 的撤回行（含因果链）必须在重建后逐字段存活
    const retractedSurvives =
      b47BeliefId !== '' &&
      (await allBeliefs()).some((b) => String(b.beliefId) === b47BeliefId && b.status === 'retracted')
    scenario(
      'B45',
      '删除派生投影再重建 → canonical state 逐字段一致，无 LLM 重判',
      identical && forbiddenIdentical && rebuilt.appliedEvents > 0 && retractedSurvives ? 'pass' : 'fail',
      `逐字段一致=${String(identical)} 禁根一致=${String(forbiddenIdentical)} 重放事件=${String(rebuilt.appliedEvents)} B47撤回链存活=${String(retractedSurvives)}（4001 事件规模；无模型参与——fold 是纯函数）`,
      { counts: { replayedEvents: rebuilt.appliedEvents } },
    )
  }

  // =========================================================================
  // 自检（B48 纪律：measured_count > 0，空样本 = INVALID 不是 PASS）
  // =========================================================================
  {
    const measured = records.filter((r) => r.status === 'pass' || r.status === 'fail').length
    const ids = records.map((r) => r.id)
    const unique = new Set(ids).size === ids.length
    const countsNonZero =
      anchorMemories.length > 0 &&
      appended >= 4000 &&
      records.some((r) => r.id === 'B42' && (r.evidence?.counts?.finalWatermark ?? 0) >= 4001)
    scenario(
      'S48',
      '量具自检：measured_count>0、id 唯一、计数非零',
      records.length > 0 && measured > 0 && unique && countsNonZero ? 'pass' : 'fail',
      `记录=${String(records.length)} 实测=${String(measured)} id唯一=${String(unique)} 锚点=${String(anchorMemories.length)} 对话事件=${String(appended)}（水位≥4001 因域尾共享计数器）`,
    )
  }

  finish()
}

function finish(): void {
  const byStatus = (s: ScenarioRecord['status']) => records.filter((r) => r.status === s).length
  const passed = byStatus('pass')
  const failed = byStatus('fail')
  console.log('\n---')
  console.log(
    `M9 scale verify：${String(records.length)} 场景 · pass=${String(passed)} fail=${String(failed)}`,
  )
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp8-scale', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'scale-verify.json'),
    `${JSON.stringify(
      {
        schema: 'm9-wp8-scale-verify@1',
        runId,
        head,
        scenarios: records,
        summary: { total: records.length, passed, failed },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeM9Manifest(dir, {
    runId,
    wp: 'wp8',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'verify',
    counts: { total: records.length, passed, failed },
    phases: ['14.4-scale-B42', '14.4-scale-B43-belief-half', '14.4-scale-B45', '14.4-scale-B47'],
    supersedes: null,
    notes:
      '审计修订范围：B42 页边界分页/水位；B43 信念半（依赖 ID 回查；Recall 半=CANCELLED 归 M9.5 TD-08）；' +
      'B45 规模重建逐字段一致；B47 双依赖图修订稳定；m9:long:verify（B32）=CANCELLED 不建（M9-M95-Overlap-Audit.md）',
    mode: 'offline',
    databaseScope: 'isolated',
  })
  if (failed > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error('[m9-scale-verify] 未捕获失败：', error)
  process.exitCode = 1
})
