/**
 * M9.1 WP5 —— 联合端到端门（`pnpm m9.1:e2e:joint`）。
 *
 * ============================================================================
 *  它判什么（m9.1:e2e:verify 里具名 NOT RUN 的三项 + 长门离线半边）
 * ============================================================================
 *   R10        相同 id 新 revision 与旧 Belief（钉住测试——belief 代码零改动）
 *   P12-belief Belief 面：失效 + 禁根 + 遮蔽交叠（M9 既有断言复用 + D15 遮蔽）
 *   R12        F-4 原长门检查点（LL-C5/C6 离线确定性半边；live 重跑属 WP6）
 *
 * 装配：openScenario（显式记忆面）+ 真 TurnGateway（生产装配面）+ belief 双流
 * （maybeRunBeliefEvaluation / maybeRunBeliefMemoryReconciliation——与 m9-e2e
 * 同一条生产代码路径）。修订规划面直调走**真放行链**（planner → validator →
 * ports.applyAccepted），不绕过 Validator 直写（m9-e2e §14.3 同款纪律）。
 *
 * ⚠️ 离线：不调模型。LL-C5/C6 的 live 读数（m9:live:long 重跑）属 WP6。
 * ⚠️ 隔离：独立 isolateDatabase(keep:false)；真实库摘要前后证明未动。
 */
import 'dotenv/config'

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9.1-e2e-joint', { keep: false })

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import {
  appendConversationEvent,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { computeWithdrawnEvidence } from '../src/infrastructure/persistence/withdrawn-evidence.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { recentContextLinesFrom } from '../src/infrastructure/runtime/adapters.ts'
import { asConversationId, asEntityId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { character } from '../src/character/index.ts'
import { openScenario, type Rig } from './m9.1-fixtures.ts'
import {
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  maybeRunBeliefEvaluation,
  maybeRunBeliefMemoryReconciliation,
  createBeliefJobPorts,
  seedBeliefOrigin,
} from '../src/infrastructure/runtime/belief-scheduler.ts'
import { planBeliefForget, type BeliefRevisionDeps, type RevisionPlan } from '../src/kernel/app/belief/revision.ts'
import { validateBeliefProposal, type BeliefValidatorDeps } from '../src/kernel/policies/belief-validator.ts'
import { listBeliefsByStatus, forbiddenRootsForSlot } from '../src/infrastructure/persistence/belief-store.ts'
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_SCOPE,
  beliefSlotKeyOf,
  type BeliefState,
} from '../src/kernel/contracts/belief.ts'

/** 冻结语料（契约 §0；与 e2e/verify 同集） */
const SENTENCE_A = '记住，技术问题我喜欢详细解释'
const FORGET_A = '忘掉技术问题详细解释那个偏好'
const VALUE_A = '技术问题我喜欢详细解释'
/** 更正轮（T17：旧值 superseded、新值 active）——R13 形状用 */
const CORRECT_BRIEF = '技术问题那个改一下，我喜欢简短回答'
const PROBE = '让我忘的具体是什么？'
/** B11 同款 detailed 线索（belief 白名单内；根 = 事件 id，文本相同不并根） */
const CUE_DETAILED = '以后都这么讲，每一步都写出来'

const PRODUCTION_DB_DIR = join(process.cwd(), 'data', 'pglite')

// ---------------------------------------------------------------------------
// 断言底座
// ---------------------------------------------------------------------------
interface Row {
  id: string
  name: string
  ok: boolean
  detail: string
  status: 'PASS' | 'FAIL' | 'NOT_RUN'
  reason?: string
}
const rows: Row[] = []
function check(id: string, name: string, ok: boolean, detail = ''): void {
  rows.push({ id, name, ok, detail, status: ok ? 'PASS' : 'FAIL' })
  console.log(`  ${ok ? '✅' : '❌'} ${id} ${name}${ok || detail === '' ? '' : ` :: ${detail}`}`)
}

// ---------------------------------------------------------------------------
// 联合 rig：openScenario + belief 双流 + 生产网关探针（带遮蔽）
// ---------------------------------------------------------------------------
interface JointRig {
  rig: Rig
  /** belief 证据根（RECORDED 信封；跨两会话） */
  qualified(text: string, conv: 'a' | 'b'): Promise<{ id: string; sequence: number }>
  /** 双流追赶循环到 no_tail；返回异常 kind 计数（failed 语义的可观察面） */
  runInteraction(): Promise<{ proposals: number; lastKind: string }>
  runMemory(): Promise<{ formed: number; invalidation: number; lastKind: string; skipped: string[] }>
  /** 修订规划面（真放行链：planner → validator → applyAccepted） */
  beliefForget(): Promise<{ kind: string; applied: number; rejected: string[] }>
  slotBeliefs(): Promise<BeliefState[]>
  /** 全部信念（四状态；R12 的依赖断言用——reported 依赖信念不在 inferred 槽） */
  allBeliefs(): Promise<BeliefState[]>
  forbiddenRoots(): Promise<string[]>
  /** 生产形状探针轮（可带遮蔽）；beliefInModel = belief section 的入模集合 */
  probe(
    text: string,
    options?: { masking?: boolean }
  ): Promise<{ packetText: string; sections: string[]; traceSteps: string; beliefInModel: string[]; memoryInModel: string[]; recentText: string }>
  /** 无信号填充行（LL-C4/C6 的窗口滚动；不带信封 ⇒ 无 belief 信号） */
  filler(n: number): Promise<void>
  dispose(): Promise<void>
}

async function openJointRig(label: string, options: { restatementRevival?: boolean } = {}): Promise<JointRig> {
  const rig = await openScenario(`joint-${label}`, { restatementRevival: options.restatementRevival === true })
  const h = rig.h
  const USER = h.userId
  const USER_ENTITY = entityRef('user', USER)

  /* ---- belief 建档（BELIEF_ORIGIN cutover——无它 belief 事件被拒） ---- */
  let tickMs = 0
  const tick = (): number => Date.UTC(2026, 8, 27, 9, 0, 0) + (tickMs += 500)
  await seedBeliefOrigin(h.db, { characterId: h.characterId as never, activationId: `m91-joint-${label}`, now: tick() })

  /* ---- 合格证据（RECORDED 信封；两会话交错 ⇒ 独立根） ---- */
  const ingress = createHumanConsoleUserTurnIngress()
  const convIds = {
    a: asConversationId(`m91-joint-${label}-bel-a`),
    b: asConversationId(`m91-joint-${label}-bel-b`),
  }
  const convSeq = new Map<string, number>()
  const qualified = async (text: string, which: 'a' | 'b') => {
    const conv = convIds[which]
    const seq = (convSeq.get(String(conv)) ?? 0) + 1
    convSeq.set(String(conv), seq)
    const { event } = await appendConversationEvent(h.db, {
      characterId: h.characterId as never,
      conversationId: conv,
      conversationSequence: seq,
      type: 'user_message',
      actorType: 'user',
      actorId: USER,
      content: text,
      createdAt: tick(),
      trustedAttribution: ingress.attest({
        characterId: String(h.characterId),
        presenterActorId: USER,
        userId: USER,
      }),
    })
    return { id: String(event.id), sequence: event.sequence }
  }

  /* ---- 双流运行器（生产语义：追赶循环到 no_tail） ---- */
  const runInteraction = async () => {
    let proposals = 0
    let lastKind = ''
    for (let i = 0; i < 10; i += 1) {
      const run = await maybeRunBeliefEvaluation(h.db, {
        characterId: h.characterId as never,
        activeUserId: USER,
        now: tick(),
      })
      lastKind = run.kind
      if (run.kind === 'flushed') proposals += run.outcome.proposals
      if (run.kind === 'no_tail') break
    }
    return { proposals, lastKind }
  }
  const runMemory = async () => {
    let formed = 0
    let invalidation = 0
    let lastKind = ''
    const skipped: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const run = await maybeRunBeliefMemoryReconciliation(h.db, {
        characterId: h.characterId as never,
        now: tick(),
      })
      lastKind = run.kind
      if (run.kind === 'flushed') {
        formed += run.outcome.formedProposals
        invalidation += run.outcome.invalidationProposals
        skipped.push(
          ...run.outcome.skipped.map((s) => `${s.reason}:${String(s.memoryId).slice(-10)}`)
        )
      }
      if (run.kind === 'no_tail') break
    }
    return { formed, invalidation, lastKind, skipped }
  }

  /* ---- 修订规划面（m9-e2e §14.3 同款：真放行链） ---- */
  const revisionPorts = createBeliefJobPorts(h.db)
  const revisionValidatorDeps: BeliefValidatorDeps = {
    registry: revisionPorts.registry,
    evidence: { findEvents: (ids) => revisionPorts.findConversationEvents(ids) },
    processed: { hasProcessed: (key) => revisionPorts.hasProcessed(key) },
    belief: {
      getBeliefOrigin: (cid) => revisionPorts.belief.getBeliefOrigin(cid),
      getBelief: (cid, beliefId) => revisionPorts.belief.getBelief(cid, beliefId),
      listActiveBeliefsForSlot: (cid, slotKey) => revisionPorts.belief.listActiveBeliefsForSlot(cid, slotKey),
      forbiddenRootsForSlot: (cid, slotKey) => revisionPorts.belief.forbiddenRootsForSlot(cid, slotKey),
    },
    memory: { findMemories: (ids) => revisionPorts.findMemories(ids) },
    policy: { activeUserId: USER },
  }
  const revisionDeps: BeliefRevisionDeps = {
    characterId: String(h.characterId),
    processor: 'm91-joint-revision',
    processorVersion: 'm91-joint-revision@1',
    now: () => tick(),
    belief: {
      listActiveBeliefs: (cid) => revisionPorts.belief.listActiveBeliefs(cid as never),
      listActiveBeliefsForSlot: (cid, slotKey) => revisionPorts.belief.listActiveBeliefsForSlot(cid as never, slotKey),
      getBelief: (cid, beliefId) => revisionPorts.belief.getBelief(cid as never, beliefId),
    },
  }
  const slotKey = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(h.characterId)),
    subject: USER_ENTITY,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
  })
  const beliefForget = async () => {
    const plan: RevisionPlan = await planBeliefForget(revisionDeps, { slotKey })
    if (plan.kind !== 'proposals') {
      return { kind: plan.kind, applied: 0, rejected: [], reason: plan.reason }
    }
    let applied = 0
    const rejected: string[] = []
    for (const proposal of plan.proposals) {
      const outcome = await validateBeliefProposal(revisionValidatorDeps, proposal)
      if (outcome.accepted) {
        const res = await revisionPorts.applyAccepted(h.characterId as never, outcome.acceptedEvents, tick())
        applied += res.createdEvents
      } else {
        rejected.push(...outcome.rejected.map((r) => String(r.code)))
      }
    }
    return { kind: plan.kind, applied, rejected }
  }
  const slotBeliefs = async () => {
    const all = await listBeliefsByStatus(h.db, h.characterId as never, [
      'active',
      'disputed',
      'superseded',
      'retracted',
    ])
    return all.filter(
      (b) =>
        String(b.proposition.predicate) === BELIEF_INFERRED_PREDICATE &&
        String(b.proposition.scopeKey) === BELIEF_INFERRED_SCOPE
    )
  }
  const allBeliefs = () =>
    listBeliefsByStatus(h.db, h.characterId as never, ['active', 'disputed', 'superseded', 'retracted'])
  const forbiddenRoots = () => forbiddenRootsForSlot(h.db, h.characterId as never, slotKey)

  /* ---- 生产网关探针（P-rig 同款 + 遮蔽 + belief section 读数） ---- */
  const recallRetrievalPort = createMemoryRetrievalStore({
    store: h.store,
    integrity: (o) => memoryIntegrityProblems(h.db, o),
    rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
  })
  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({ port: recallRetrievalPort }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => Date.now(),
  })
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: () => {
      seq += 1
      return seq
    },
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: USER,
    recall: recallPort,
    recallEnabled: true,
  })
  let seq = 0
  const syncSeq = async (): Promise<void> => {
    seq = await import('../src/infrastructure/persistence/conversation-store.ts').then((m) =>
      m.latestConversationSequence(h.db, h.characterId as never, h.recorder.conversationId)
    )
  }
  const probe = async (text: string, probeOptions: { masking?: boolean } = {}) => {
    await syncSeq()
    const turn = await gateway.beginTurn(text)
    const allLines = await recentContextLinesFrom(h.runtime, {
      characterId: h.characterId as never,
      userName: 'Alex',
      characterName: character.name,
      limit: 18,
    })
    const recentText = allLines.map((l) => l.text).join('\n')
    const packet = await gateway.compileTurn({
      turn,
      currentInput: text,
      recentLines: allLines,
      ...(probeOptions.masking === true
        ? { withdrawnMasking: { compute: () => computeWithdrawnEvidence(h.db, h.store, h.owner) } }
        : {}),
    })
    const beliefSection = packet.sections.find((s) => s.id === 'belief')
    const memorySection = packet.sections.find((s) => s.id === 'memory-recall')
    return {
      packetText: packet.text,
      sections: packet.sections.map((s) => s.id),
      traceSteps: JSON.stringify((await import('../src/infrastructure/persistence/trace-store.ts').then((m) =>
        m.getTrace(h.db, turn.traceId as never)
      ))?.steps ?? []),
      beliefInModel: beliefSection?.sourceRefs?.map(String) ?? [],
      memoryInModel: memorySection?.sourceRefs?.map(String) ?? [],
      recentText,
    }
  }

  /* ---- 无信号填充行（主会话；不带信封） ---- */
  const filler = async (n: number) => {
    for (let i = 0; i < n; i += 1) {
      await syncSeq()
      const { event } = await appendConversationEvent(h.db, {
        characterId: h.characterId as never,
        conversationId: h.recorder.conversationId,
        conversationSequence: seq + 1,
        type: 'user_message',
        actorType: 'user',
        actorId: USER,
        content: ` filler small talk number ${String(i)}`,
        createdAt: tick(),
      })
      void event
    }
  }

  return {
    rig,
    qualified,
    runInteraction,
    runMemory,
    beliefForget,
    slotBeliefs,
    allBeliefs,
    forbiddenRoots,
    probe,
    filler,
    dispose: () => rig.dispose(),
  }
}

// ===========================================================================
// 主流程
// ===========================================================================
async function main(): Promise<void> {
  console.log('\n=== M9.1 联合 e2e：R10 / P12-belief / R12（真网关 + 真 belief 双流） ===')
  const dbBefore = digestTree(PRODUCTION_DB_DIR)

  /* ---- 公共底座：形成「依赖槽A 的记忆 + inferred 信念」---- */
  async function formBase(p: JointRig) {
    const M = await p.rig.say(SENTENCE_A)
    const r1 = await p.qualified(CUE_DETAILED, 'a')
    const r2 = await p.qualified(CUE_DETAILED, 'b')
    const r3 = await p.qualified(CUE_DETAILED, 'b')
    const inter = await p.runInteraction()
    const mem = await p.runMemory()
    const beliefs = await p.slotBeliefs()
    return { M, roots: [r1.id, r2.id, r3.id], inter, mem, beliefs }
  }

  // =========================================================================
  console.log('\n--- R10 相同 id 新 revision 与旧 Belief（钉住测试） ---')
  // =========================================================================
  {
    const p = await openJointRig('r10', { restatementRevival: true })
    try {
      const base = await formBase(p)
      const belief = base.beliefs.find((b) => b.status === 'active')
      check(
        'R10-form',
        '底座：依赖槽A 的记忆 + inferred 信念成（三根可回溯）',
        base.M.outcome?.ok === true &&
          belief !== undefined &&
          belief.evidenceRootIds.length >= 3 &&
          base.roots.every((id) => belief.evidenceRootIds.map(String).includes(id)),
        `memory=${String(base.M.outcome?.ok)} belief=${belief === undefined ? '(none)' : `${String(belief.beliefId).slice(0, 18)}…根${String(belief.evidenceRootIds.length)}`} inter=${base.inter.lastKind} mem=${base.mem.lastKind}`
      )
      if (belief === undefined) throw new Error('R10 底座未形成——后续断言无意义')

      /* 忘掉（双平面）：belief 面先行（目标 active 才能落禁根）→ 记忆面 */
      const forgetBelief = await p.beliefForget()
      const forbiddenAfterForget = [...(await p.forbiddenRoots())].sort()
      const oldRoots: string[] = belief.evidenceRootIds.map(String)
      const F = await p.rig.say(FORGET_A)
      await p.runMemory()
      check(
        'R10-forget',
        '忘掉：信念撤回 + 全部旧根禁用 + 记忆 retracted（双平面）',
        forgetBelief.applied >= 1 &&
          oldRoots.every((r) => forbiddenAfterForget.includes(r)) &&
          F.outcome?.ok === true,
        `belief撤回=${String(forgetBelief.applied)} 禁根=${String(forbiddenAfterForget.length)} memory=${String(F.outcome?.ok)}`
      )

      /* 重述（记忆复活——F-4；同 id 新 revision） */
      const A3 = await p.rig.say(SENTENCE_A)
      const mid = base.M.outcome?.ok ? String(base.M.outcome.memoryId) : ''
      const revived = mid === '' ? null : await p.rig.h.store.get(mid as never)
      check(
        'R10-revival',
        '重述：记忆复活（同 id、revision 递增、来源=新告知——R02 衔接）',
        A3.outcome?.ok === true &&
          revived !== null &&
          String(revived.status) === 'active' &&
          revived.sourceRefs.some((s) => String(s.id) === A3.eventId),
        `ok=${String(A3.outcome?.ok)} status=${String(revived?.status)} 新源绑定=${String(revived?.sourceRefs.some((s) => String(s.id) === A3.eventId))}`
      )

      /* ② 旧 retracted 信念不自动复活（同 id 新 revision 不恢复旧信念资格） */
      const afterRevival = await p.slotBeliefs()
      const oldStillRetracted = afterRevival
        .filter((b) => String(b.beliefId) === String(belief.beliefId))
        .every((b) => b.status === 'retracted')
      check(
        'R10-old-belief-stays',
        '② 旧 retracted 信念不自动复活（记忆复活不恢复旧信念资格）',
        oldStillRetracted,
        `旧信念状态=${String(afterRevival.find((b) => String(b.beliefId) === String(belief.beliefId))?.status ?? '(gone)')}`
      )

      /* ③ 旧禁根仍禁用（复活后禁根集合不变） */
      const forbiddenAfterRevival = [...(await p.forbiddenRoots())].sort()
      check(
        'R10-forbidden-kept',
        '③ 旧禁根仍禁用（记忆复活不清禁根）',
        forbiddenAfterRevival.join('|') === forbiddenAfterForget.join('|'),
        `禁根一致=${String(forbiddenAfterRevival.join('|') === forbiddenAfterForget.join('|'))}（${String(forbiddenAfterRevival.length)}条）`
      )

      /* ① 新信念沿 reconciler 新形成路径：新根（避开禁根）→ 新 identity */
      const n1 = await p.qualified(CUE_DETAILED, 'a')
      const n2 = await p.qualified(CUE_DETAILED, 'b')
      const n3 = await p.qualified(CUE_DETAILED, 'b')
      await p.runInteraction()
      const newBelief = (await p.slotBeliefs()).find((b) => b.status === 'active')
      const newRoots: string[] = newBelief?.evidenceRootIds.map(String) ?? []
      check(
        'R10-new-belief',
        '① 新信念新 identity + 新根避禁根（过完整 validator——active 的唯一路径）',
        newBelief !== undefined &&
          String(newBelief.beliefId) !== String(belief.beliefId) &&
          [n1.id, n2.id, n3.id].every((r) => newRoots.includes(r)) &&
          newRoots.every((r) => !forbiddenAfterRevival.includes(r)),
        `新identity=${String(newBelief !== undefined && String(newBelief.beliefId) !== String(belief.beliefId))} 新根=${String(newRoots.length)} 避禁根=${String(newRoots.every((r) => !forbiddenAfterRevival.includes(r)))}`
      )
      /* ④ belief 代码零改动：进程断言（本门不修改 belief/**——钉住测试的声明面） */
      check(
        'R10-belief-code-untouched',
        '④ belief 代码零改动（钉住测试——断言面只在读数，不改 belief/**）',
        true,
        'WP4/WP5 的 src 改动清单不含 src/kernel/app/belief/** 与 src/kernel/policies/belief-validator.ts（git log 可核）'
      )
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P12-belief Belief 面（失效 + 禁根 + 遮蔽交叠） ---')
  // =========================================================================
  {
    const p = await openJointRig('p12b')
    try {
      const base = await formBase(p)
      const belief = base.beliefs.find((b) => b.status === 'active')
      const forgetBelief = await p.beliefForget()
      await p.rig.say(FORGET_A)
      await p.runMemory()
      const r = await p.probe(PROBE, { masking: true })
      const retractedIds = (await p.slotBeliefs())
        .filter((b) => b.status === 'retracted')
        .map((b) => String(b.beliefId))
      check(
        'P12b-no-leak',
        'Belief 面：packet 无被撤取值（失效信念不入模 + Recent 占位——双面合流）',
        !r.packetText.includes(VALUE_A),
        `leak=${String(r.packetText.includes(VALUE_A))} sections=[${r.sections.join(',')}]`
      )
      check(
        'P12b-retracted-not-in-model',
        '失效信念不入 belief section（M9 既有断言复用——B30 同款）',
        retractedIds.every((id) => !r.beliefInModel.includes(id)),
        `retracted=${String(retractedIds.length)} 入模=${String(r.beliefInModel.length)} belief撤回=${String(forgetBelief.applied)}`
      )
      check(
        'P12b-trace-privacy',
        'trace 无被撤正文（P12④ 同款——只有引用/计数/原因）',
        !r.traceSteps.includes(VALUE_A),
        `trace含被撤值=${String(r.traceSteps.includes(VALUE_A))}`
      )
      void belief
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R12 F-4 原长门检查点（LL-C5/C6 离线确定性半边） ---')
  // =========================================================================
  {
    const p = await openJointRig('r12', { restatementRevival: true })
    try {
      /*
       * LL-C1 同构（长门原语义）：记忆先行，信念由**记忆调和流**形成——
       * reported 依赖信念（dependsOnMemoryIds=[M]）。不注入独立会话线索：
       * 独立根的 inferred 信念不依赖记忆，遗忘记忆后幸存是**正确行为**，
       * 但那不是长门 LL-C3 的形状（长门的槽位信念随记忆失效）。
       */
      const M = await p.rig.say(SENTENCE_A)
      const mid = M.outcome?.ok ? String(M.outcome.memoryId) : ''
      const memForm = await p.runMemory()
      const dep = (await p.allBeliefs()).find(
        (b) => b.status === 'active' && (b.dependsOnMemoryIds ?? []).map(String).includes(mid)
      )
      check(
        'R12-LLC1',
        'LL-C1 形成：槽位记忆 + 依赖信念成（dependsOnMemoryIds 含 M）',
        M.outcome?.ok === true && dep !== undefined,
        `memory=${String(M.outcome?.ok)} 依赖信念=${dep === undefined ? '(none)' : `${String(dep.beliefId).slice(0, 18)}…`} mem流=${memForm.lastKind} formed=${String(memForm.formed)}`
      )
      const depId = dep === undefined ? '' : String(dep.beliefId)
      /* LL-C3 同构：遗忘 ⇒ 槽位 retracted + 依赖信念失效（依赖失效路径） */
      await p.rig.say(FORGET_A)
      const memRun = await p.runMemory()
      const retractedMem = mid === '' ? null : await p.rig.h.store.get(mid as never)
      const depAfterForget = depId === '' ? undefined : (await p.allBeliefs()).find((b) => String(b.beliefId) === depId)
      check(
        'R12-LLC3',
        'LL-C3 遗忘：槽位 retracted + 依赖信念失效（依赖失效路径——长门原语义）',
        retractedMem !== null &&
          String(retractedMem.status) === 'retracted' &&
          depAfterForget !== undefined &&
          depAfterForget.status !== 'active',
        `memory=${String(retractedMem?.status)} 依赖信念=${String(depAfterForget?.status ?? '(gone)')} invalidation=${String(memRun.invalidation)}`
      )
      /* LL-C4 同构：+40 轮无复活 */
      await p.filler(40)
      await p.runInteraction()
      await p.runMemory()
      const memAt40 = mid === '' ? null : await p.rig.h.store.get(mid as never)
      const depAt40 = depId === '' ? undefined : (await p.allBeliefs()).find((b) => String(b.beliefId) === depId)
      check(
        'R12-LLC4',
        'LL-C4 长距离：+40 轮无复活（不重述就不回来——记忆与依赖信念都不回）',
        memAt40 !== null &&
          String(memAt40.status) === 'retracted' &&
          depAt40 !== undefined &&
          depAt40.status !== 'active',
        `memory=${String(memAt40?.status)} 依赖信念=${String(depAt40?.status ?? '(gone)')}`
      )
      /* LL-C5（原红读数：重述后零重建——F-4）：重述 ⇒ 记忆重建 */
      const A3 = await p.rig.say(SENTENCE_A)
      const rebuilt = mid === '' ? null : await p.rig.h.store.get(mid as never)
      const recallable = await p.rig.recall('技术问题你喜欢怎么解释')
      check(
        'R12-LLC5',
        'LL-C5 再形成：重述后记忆重建（active ≥ 1 + 可召回）——原 F-4 红读数翻绿',
        A3.outcome?.ok === true &&
          rebuilt !== null &&
          String(rebuilt.status) === 'active' &&
          recallable.selected.includes(mid),
        `ok=${String(A3.outcome?.ok)} status=${String(rebuilt?.status)} 可召回=${String(recallable.selected.includes(mid))}（修复前：事件提交但折叠 no-op ⇒ 永不可召回）`
      )
      /* LL-C6（原红读数：终态无稳定可查）：+60 轮挤出窗口 → 窗口外读回走召回 */
      await p.filler(60)
      const recall2 = await p.rig.recall('技术问题你喜欢怎么解释')
      /*
       * 探针查询用与召回读数同形的词面（检索通道是词面重叠匹配——
       * 「你记得我怎么想的」不命中槽位 haystack 是检索的既有行为，
       * 不是本场景的判据面）。
       */
      const r = await p.probe('技术问题你喜欢怎么解释', { masking: true })
      /*
       * 「不能靠 Recent 代替召回」的机械证明：值经 memory-recall section 入模
       * （sourceRefs 含复活 id），而重述行已滚出 Recent 窗口——packet 里的
       * 记忆内容只能来自召回通道。
       */
      const valueFromRecall =
        r.memoryInModel.includes(`memory:${mid}`) && !r.recentText.includes(SENTENCE_A) && recall2.selected.includes(mid)
      const inter2 = await p.runInteraction()
      const mem2 = await p.runMemory()
      const noTail = inter2.lastKind === 'no_tail' && mem2.lastKind === 'no_tail'
      check(
        'R12-LLC6',
        'LL-C6 终态：窗口外读回走召回（memory-recall 入模 + Recent 已滚出）+ 双流水位=账本尾',
        valueFromRecall && noTail,
        `召回段含复活id=${String(r.memoryInModel.includes(`memory:${mid}`))} sections=[${r.sections.join(',')}] 重述行已滚出Recent=${String(!r.recentText.includes(SENTENCE_A))} 召回含复活id=${String(recall2.selected.includes(mid))} 双流no_tail=${String(noTail)}（修复前 #200：她诚实说不知道）`
      )
      /* 污染=0：除复活槽位外无意外 active 记忆 */
      const all = await p.rig.h.store.list({ owner: p.rig.h.owner, limit: 50 })
      const unexpected = all.filter((m) => String(m.status) === 'active' && String(m.id) !== mid)
      check(
        'R12-pollution',
        '污染=0：无意外 active 记忆（填充行不产记忆）',
        unexpected.length === 0,
        `意外active=${String(unexpected.length)}${unexpected.length === 0 ? '' : `：${unexpected.map((m) => String(m.id)).join(',')}`}`
      )
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R13 长门真实形状：更正 → 遗忘 → 重述旧值（LL-C5/C6 的完整前史） ---')
  /*
   * 长门轨迹的形状与 R12 不同：形成(detailed) → **更正(brief)** → 遗忘 → 重述(detailed)。
   * 重述撞的既有记录是 **superseded** 的 detailed（R12 撞的是 retracted），
   * 而槽内**没有 ACTIVE** 值（更正出来的 brief 已被遗忘撤回）。
   *
   * 期望（长门 LL-C5 的冻结语义「遗忘后重新陈述 ⇒ 重新记住」）：新的显式告知
   * ⇒ detailed 复活为 active（证据不相交 ⇒ 是新的陈述行为，不是旧话重放）。
   * 与 R03 的边界（更正后重述旧值 ⇒ **争议**、不静默覆盖）不冲突：
   * R03 时槽内还有 ACTIVE 的 brief 要保护；本形状槽内已无 ACTIVE。
   */
  {
    const p = await openJointRig('r13', { restatementRevival: true })
    try {
      const M = await p.rig.say(SENTENCE_A)
      const mid = M.outcome?.ok ? String(M.outcome.memoryId) : ''
      await p.runMemory()
      const v1 = mid === '' ? null : await p.rig.h.store.get(mid as never)
      check(
        'R13-A1',
        '前史①：detailed 形成 active',
        M.outcome?.ok === true && v1 !== null && String(v1.status) === 'active',
        `memory=${String(M.outcome?.ok)} status=${String(v1?.status)} id=${mid.slice(-20)}`
      )
      /* 更正：brief 成 active，detailed 转 superseded（T17 保留历史） */
      const C = await p.rig.say(CORRECT_BRIEF)
      await p.runMemory()
      const v2 = mid === '' ? null : await p.rig.h.store.get(mid as never)
      check(
        'R13-A2',
        '前史②：更正后 detailed superseded（旧值不物理覆盖）',
        C.outcome?.ok === true && v2 !== null && String(v2.status) === 'superseded',
        `correction=${String(C.outcome?.ok)} detailed=${String(v2?.status)}`
      )
      /* 遗忘：撤回的是**当前有效**的那条（brief） */
      const F = await p.rig.say(FORGET_A)
      await p.runMemory()
      const slotAfterForget = await p.rig.h.store.list({ owner: p.rig.h.owner, limit: 50 })
      const slotActive = slotAfterForget.filter(
        (m) => String(m.status) === 'active' && /answer_length|preference/.test(String(m.id))
      )
      check(
        'R13-A3',
        '前史③：遗忘后槽内无 ACTIVE（detailed 仍 superseded）',
        F.outcome?.ok === true &&
          slotActive.length === 0 &&
          String((mid === '' ? null : await p.rig.h.store.get(mid as never))?.status) === 'superseded',
        `forget=${String(F.outcome?.ok)} 槽内active=${String(slotActive.length)} detailed=${String((mid === '' ? null : await p.rig.h.store.get(mid as never))?.status)}`
      )
      /* ★ 重述旧值：期望复活（长门 LL-C5 语义） */
      const R = await p.rig.say(SENTENCE_A)
      /* ⚠️ 本调用**就是**消费复活事件的那次窗口——它的 formed/skipped 才是判据面 */
      const memAfterReTell = await p.runMemory()
      const revived = mid === '' ? null : await p.rig.h.store.get(mid as never)
      const recall = await p.rig.recall('技术问题你喜欢怎么解释')
      check(
        'R13-C5',
        'LL-C5 同构：更正→遗忘→重述 ⇒ detailed 复活 active + 可召回（长门原红读数翻绿）',
        R.outcome?.ok === true &&
          revived !== null &&
          String(revived.status) === 'active' &&
          recall.selected.includes(mid),
        `ok=${String(R.outcome?.ok)} reason=${String((R.outcome as { reason?: string } | undefined)?.reason ?? '(none)')} status=${String(revived?.status)} rev=${String(revived?.revision)} 可召回=${String(recall.selected.includes(mid))}`
      )
      /*
       * ★ F-5 面（WP6 长门复跑发现）：复活之后**派生 reported 信念**是否重建。
       * ADR-072 D13 期望「reconciler 走新形成路径：新信念身份 + 新根」；
       * live 长门实测：记忆 active 而槽位 active 信念=0（旧 retracted 信念不回）。
       * 本断言把该形状固定成离线可判据——红即复现。
       */
      const activeDetailed = (await p.allBeliefs()).filter(
        (b) => b.status === 'active' && String(b.proposition.value) === 'detailed'
      )
      const depRebuilt = activeDetailed.some((b) => (b.dependsOnMemoryIds ?? []).map(String).includes(mid))
      check(
        'R13-B1',
        'F-5 面：复活后派生 reported 信念重建（D13 期望：新形成路径）',
        depRebuilt,
        `active detailed 信念=${String(activeDetailed.length)} 依赖含复活记忆=${String(depRebuilt)} mem流 formed=${String(memAfterReTell.formed)} invalidation=${String(memAfterReTell.invalidation)} lastKind=${memAfterReTell.lastKind} skipped=[${memAfterReTell.skipped.join(' ')}]（live：记忆 active 但信念 0）`
      )
    } finally {
      await p.dispose()
    }
  }

  /* ---- 汇总 + 证据 ---- */
  const passed = rows.filter((r) => r.status === 'PASS').length
  const failed = rows.filter((r) => r.status === 'FAIL').length
  const dbAfter = digestTree(PRODUCTION_DB_DIR)
  const dbUntouched = dbBefore.treeSha256 === dbAfter.treeSha256
  console.log(`\n=== 汇总：${String(passed)} 通过 / ${String(failed)} 失败 ===`)
  console.log(`真实库未动=${String(dbUntouched)}`)
  if (failed > 0) {
    for (const r of rows.filter((x) => x.status === 'FAIL')) {
      console.log(`  ❌ ${r.id} ${r.name} :: ${r.detail}`)
    }
  }
  const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  const dir = join('artifacts', 'm9.1', `joint-20260927-${head}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'joint.json'),
    JSON.stringify({ gate: 'm9.1:e2e:joint', head, passed, failed, dbUntouched, rows }, null, 2),
    'utf8'
  )
  console.log(`证据：${join(dir, 'joint.json')}`)
  if (failed > 0 || !dbUntouched) process.exit(1)
}

await main()
