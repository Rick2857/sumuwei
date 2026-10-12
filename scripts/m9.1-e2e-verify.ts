/**
 * M9.1 WP4/WP5 —— F-1 生产装配门（`pnpm m9.1:e2e:verify`）。
 *
 * ============================================================================
 *  它判什么（契约 §2 P01–P12 的生产装配半边）
 * ============================================================================
 *  执行底座（契约 §2 开头）：每场景先完成「记住→（更正/遗忘）」再进入探针轮；
 *  探针轮用**生产装配**（真 TurnGateway → compiler.compile）断言最终 packet.text。
 *
 *   P01 原型探针（含 off 档对照）   P02 历史问法（三种）
 *   P03 assistant 复述行（派生面）  P04 摘要通道（rollup 开/关）
 *   P05 同行混合内容（误伤正控）    P06 同值不同主体（遮蔽不越界）
 *   P07 普通更正后问历史（T17）     P08 遗忘后重新告知（新旧行分断）
 *   P09 重启/跨会话/窗口滚出        P10 取候选后遗忘（同轮时序）
 *   P11 孤儿/读失败/裁剪（失败关闭）P12 四面断言（Recall/状态文本/trace 隐私）
 *
 *  R10（belief 钉住）/ R12（长门检查点）与 P12②（Belief 面）= **具名 NOT RUN**：
 *  需要 belief 域夹具与 m9 长轨迹——WP5 联合 e2e 的另一半（本门不冒充覆盖）。
 *
 * ⚠️ 离线：不调模型——「回复不复述」的语义判定属于 `m9.1:smoke:live`（真模型轮）。
 * ⚠️ 隔离：每场景独立 isolateDatabase(keep:false)；真实库摘要前后证明未动。
 */
import 'dotenv/config'

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9.1-e2e', { keep: false })

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import {
  appendConversationEvent,
  latestConversationSequence,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { computeWithdrawnEvidence } from '../src/infrastructure/persistence/withdrawn-evidence.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import {
  WITHDRAWN_PLACEHOLDER_ASSISTANT,
  WITHDRAWN_PLACEHOLDER_USER,
} from '../src/kernel/context/sections.ts'
import { recentContextLinesFrom } from '../src/infrastructure/runtime/adapters.ts'
import { asConversationEventId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { character } from '../src/character/index.ts'
import { openScenario, type Rig } from './m9.1-fixtures.ts'
import { conversationEvidence, createMemoryCandidate } from '../src/kernel/contracts/memory.ts'

/** 冻结语料（契约 §0；与 WP0/WP2 同集） */
const SENTENCE_A = '记住，技术问题我喜欢详细解释'
const FORGET_A = '忘掉技术问题详细解释那个偏好'
const VALUE_A = '技术问题我喜欢详细解释'
const PROBE = '让我忘的具体是什么？'
const V1 = '记住，我不吃香菜'
const CORRECT_V2 = '香菜那个改一下，我现在能吃香菜了'

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
function notRun(id: string, name: string, reason: string): void {
  rows.push({ id, name, ok: false, detail: reason, status: 'NOT_RUN', reason })
  console.log(`  ⏭️ ${id} ${name} :: NOT RUN（${reason}）`)
}

// ---------------------------------------------------------------------------
// P rig：openScenario（显式记忆面）+ 真 TurnGateway（生产装配面）
// ---------------------------------------------------------------------------
interface PRig {
  rig: Rig
  gateway: TurnGateway
  /** 一次生产形状探针轮：beginTurn → recentLines → compileTurn（可带遮蔽） */
  probe(
    text: string,
    options?: {
      masking?: boolean
      /** 传给 compileTurn 的 recentLines 窗口切片（缺省全量；P09③ 用） */
      recentSlice?: number
      /** 覆盖 compute（P11② 读失败注入用） */
      computeOverride?: () => Promise<import('../src/kernel/contracts/withdrawn-evidence.ts').WithdrawnSetResult>
    }
  ): Promise<{ packetText: string; sections: string[]; traceId: string; recentCount: number }>
  /** 直接写一条对话事件（P03 assistant 行 / P06 乙的行） */
  appendLine(input: {
    actorType: 'user' | 'character'
    actorId: string
    text: string
    replyToEventId?: string
  }): Promise<string>
  /** 从账本同步会话内序号（绕过 probe 直接调 gateway.beginTurn 前必须先调它） */
  syncSeq(): Promise<void>
  dispose(): Promise<void>
}

async function openPRig(
  label: string,
  options: { restatementRevival?: boolean; rollupTokens?: number } = {}
): Promise<PRig> {
  const rig = await openScenario(`e2e-${label}`, { restatementRevival: options.restatementRevival === true })
  const h = rig.h

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
  const rollupPort = createRollupTurnPort({ reader: createRollupSourceReader(h.db) })

  const conversationId = h.recorder.conversationId
  /*
   * 会话内序号：与 harness 的 recordUserEvidence **共享同一账本**——每次分配前
   * 从账本同步最大序号（快照会撞号：recorder 对「incoming ≤ max」按幂等命中
   * 返回**已存在**事件，探针就会拿到别人的原话当观测）。
   * 本 rig 不写 assistant 事件（不调 completeTurn），因此连续 +1（不跳号——
   * 跳号会触发 conversation_sequence_gap 失败关闭）。
   */
  let seq = 0
  const syncSeq = async (): Promise<void> => {
    seq = await latestConversationSequence(h.db, h.characterId as never, conversationId)
  }
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
    userId: h.userId,
    recall: recallPort,
    recallEnabled: true,
    rollup: rollupPort,
    recallBudget: { ...DEFAULT_CONTEXT_BUDGET, rollupTokens: options.rollupTokens ?? 0 },
  })

  return {
    rig,
    gateway,
    async probe(text, probeOptions = {}) {
      await syncSeq()
      const turn = await gateway.beginTurn(text)
      const allLines = await recentContextLinesFrom(h.runtime, {
        characterId: h.characterId as never,
        userName: 'Alex',
        characterName: character.name,
        limit: 18,
      })
      const recentLines =
        probeOptions.recentSlice !== undefined ? allLines.slice(-probeOptions.recentSlice) : allLines
      const withdrawnMasking =
        probeOptions.masking === true
          ? {
              compute:
                probeOptions.computeOverride !== undefined
                  ? probeOptions.computeOverride
                  : () => computeWithdrawnEvidence(h.db, h.store, h.owner),
            }
          : undefined
      const packet = await gateway.compileTurn({
        turn,
        currentInput: text,
        recentLines,
        ...(withdrawnMasking !== undefined ? { withdrawnMasking } : {}),
      })
      return {
        packetText: packet.text,
        sections: packet.sections.map((s) => s.id),
        traceId: String(turn.traceId),
        recentCount: recentLines.length,
      }
    },
    async appendLine(input) {
      await syncSeq()
      seq += 1
      const result = await appendConversationEvent(h.db, {
        characterId: h.characterId as never,
        conversationId,
        conversationSequence: seq,
        type: input.actorType === 'user' ? 'user_message' : 'assistant_message',
        actorType: input.actorType,
        actorId: input.actorId,
        content: input.text,
        ...(input.replyToEventId !== undefined
          ? { replyToEventId: asConversationEventId(input.replyToEventId) }
          : {}),
      })
      return String(result.event.id)
    },
    async syncSeq() {
      await syncSeq()
    },
    async dispose() {
      await rig.dispose()
    },
  }
}

/** 底座：记住槽A → 忘掉槽A（返回被撤事件 id） */
async function baseForgetA(p: PRig): Promise<string> {
  const A1 = await p.rig.say(SENTENCE_A)
  await p.rig.say(FORGET_A)
  return A1.eventId
}

async function main(): Promise<void> {
  const realDbBefore = digestTree(PRODUCTION_DB_DIR)
  console.log('\n=== M9.1 F-1 生产装配门（m9.1:e2e:verify）===')

  // =========================================================================
  console.log('\n--- P01 原型探针（on 档遮蔽 + off 档对照） ---')
  // =========================================================================
  {
    const p = await openPRig('p01')
    try {
      const withdrawnEventId = await baseForgetA(p)
      /* on 档：遮蔽后无被撤取值；被撤行=占位且行仍在 */
      const on = await p.probe(PROBE, { masking: true })
      check(
        'P01-on-leak',
        'on：最终 packet 无被撤取值',
        !on.packetText.includes(VALUE_A),
        `sections=[${on.sections.join(',')}]`
      )
      const traceOn = await getTrace(p.rig.h.db, on.traceId as never)
      const maskingStep = traceOn?.steps.find((s) => s.kind === 'withdrawn_masking')
      check(
        'P01-on-trace',
        'on：withdrawn_masking 步在场且 masked ≥ 1（D20）',
        maskingStep !== undefined && Number(maskingStep.attributes.masked_count ?? 0) >= 1,
        `step=${JSON.stringify(maskingStep?.attributes ?? null)}`
      )
      check(
        'P01-on-placeholder',
        'on：被撤行 = 占位文本（行仍在、不删除——D18）',
        on.packetText.includes(WITHDRAWN_PLACEHOLDER_USER),
        `占位在=${String(on.packetText.includes(WITHDRAWN_PLACEHOLDER_USER))}`
      )
      /* off 档：开关关 ⇒ 泄漏仍在（PC-4：开关真实消费的对照证明） */
      const off = await p.probe(PROBE, { masking: false })
      check(
        'P01-off-control',
        'off：packet 含被撤取值（WP0 D-1 基线对照——开关在工作的证明）',
        off.packetText.includes(VALUE_A),
        `含被撤取值=${String(off.packetText.includes(VALUE_A))}`
      )
      void withdrawnEventId
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P02 历史问法（三种） ---')
  // =========================================================================
  {
    const p = await openPRig('p02')
    try {
      await baseForgetA(p)
      const probes = ['我最早让你记的是什么？', '我们聊过几次这个？', '逐字引用一下']
      for (const [i, q] of probes.entries()) {
        const r = await p.probe(q, { masking: true })
        check(
          `P02-${['earliest', 'count', 'verbatim'][i]}`,
          `「${q}」packet 无被撤取值`,
          !r.packetText.includes(VALUE_A),
          `leak=${String(r.packetText.includes(VALUE_A))}`
        )
      }
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P03 assistant 复述行（派生面） ---')
  // =========================================================================
  {
    const p = await openPRig('p03')
    try {
      const A1 = await p.rig.say(SENTENCE_A)
      /* 她的旧回复复述了被撤取值，replyToEventId 指向用户行 */
      await p.appendLine({
        actorType: 'character',
        actorId: p.rig.h.characterId,
        text: `好的，我记住了：${VALUE_A}。`,
        replyToEventId: A1.eventId,
      })
      await p.rig.say(FORGET_A)
      const r = await p.probe(PROBE, { masking: true })
      check(
        'P03-assistant-masked',
        'assistant 复述行被占位（replyToEventId ∈ 撤销集）',
        r.packetText.includes(WITHDRAWN_PLACEHOLDER_ASSISTANT),
        `assistant占位在=${String(r.packetText.includes(WITHDRAWN_PLACEHOLDER_ASSISTANT))}`
      )
      check(
        'P03-user-masked',
        '用户行同时被占位（两类行分别断言，不以清除用户行冒充）',
        r.packetText.includes(WITHDRAWN_PLACEHOLDER_USER),
        `user占位在=${String(r.packetText.includes(WITHDRAWN_PLACEHOLDER_USER))}`
      )
      check(
        'P03-no-leak',
        '两面占位后 packet 无被撤取值',
        !r.packetText.includes(VALUE_A),
        `leak=${String(r.packetText.includes(VALUE_A))}`
      )
      /* 结构断言：recentContextLinesFrom 映射 actorType/replyToEventId（D18） */
      const lines = await recentContextLinesFrom(p.rig.h.runtime, {
        characterId: p.rig.h.characterId as never,
        userName: 'Alex',
        characterName: character.name,
        limit: 18,
      })
      const assistantLine = lines.find((l) => l.actorType === 'character')
      check(
        'P03-structure',
        'recentContextLinesFrom 映射 actorType + replyToEventId（结构断言）',
        assistantLine !== undefined && assistantLine.replyToEventId !== undefined,
        `assistantLine=${JSON.stringify(assistantLine?.replyToEventId ?? null)}`
      )
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P04 摘要通道（rollup 开 400 / 关 0） ---')
  // =========================================================================
  for (const mode of [400, 0] as const) {
    const p = await openPRig(`p04-${mode > 0 ? 'on' : 'off'}`, { rollupTokens: mode })
    try {
      /*
       * 底座后补 20 条填充行：被撤行必须落在 Recent 窗口**之前**，rollup reader
       * 才会真的扫到它（beforeSequence = 窗口最旧一条）——这是 P04① 的前置。
       */
      await baseForgetA(p)
      for (let i = 0; i < 20; i += 1) {
        await p.appendLine({ actorType: 'user', actorId: p.rig.h.userId, text: ` filler number ${String(i)} plain weather talk` })
      }
      const r = await p.probe(PROBE, { masking: true })
      check(
        `P04-${mode > 0 ? 'on' : 'off'}-no-leak`,
        `rollup ${mode > 0 ? '开(400)' : '关(0)'}：packet 无被撤取值（含摘要通道）`,
        !r.packetText.includes(VALUE_A),
        `leak=${String(r.packetText.includes(VALUE_A))} sections=[${r.sections.join(',')}]`
      )
      const trace = await getTrace(p.rig.h.db, r.traceId as never)
      const stepsJson = JSON.stringify(trace?.steps ?? [])
      if (mode > 0) {
        /* 开档：rollup 资格闸拒绝被撤行（invalidated_by_memory_state——真实 reader） */
        const m = /rollup_rejected_invalidated":(\d+)/.exec(stepsJson)
        const rejected = m === null ? 0 : Number(m[1])
        check(
          'P04-reader-gate',
          '开档：rollup 资格闸拒绝被撤行（invalidated_by_memory_state ≥ 1）',
          rejected >= 1,
          `rollup_rejected_invalidated=${String(rejected)}（rollup 读数在 compile 步属性里——DR-9 不加独立 step kind）`
        )
      } else {
        check(
          'P04-off-no-supply',
          '关档：无摘要供给（rollup_status 缺席 = 这一轮没摘要）',
          !stepsJson.includes('rollup_status'),
          `rollup_status在=${String(stepsJson.includes('rollup_status'))}`
        )
      }
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P05 同行混合内容（误伤正控） ---')
  // =========================================================================
  {
    const p = await openPRig('p05')
    try {
      /*
       * 冻结合同行（契约 §2）：含被撤内容 + 无关有效信息。规则抽取器是单句解析器
       * ——第二句（周三体检）不会被抽成独立记忆（实测如实登记，不硬凑）。
       * 无关有效信息用**真正异槽**且**与遗忘句零词面重叠**的告知承载
       * （就读院校——content-extractor cue「大学」可解析；登记描述「就读 / 毕业院校」
       * 不含遗忘句的任何 2 字片段）。
       * ⚠️ 两个实测教训（e2e 三/四轮）：
       *   · 槽B（闲聊简短）与槽A 是**同一 canonical slot**（WP0 结论）⇒ 撞槽 disputed；
       *   · 香菜槽的登记描述含「偏好」⇒ 遗忘句片段「偏好」同时命中两条候选 ⇒
       *     target_ambiguous（INV-M41-02 的诚实歧义——系统行为正确，场景构造错误）。
       */
      const M1 = await p.rig.say('记住，技术问题我喜欢详细解释，还有我周三体检')
      await p.rig.say('记住，我现在上的大学是示例工程科技大学')
      await p.rig.say(FORGET_A)
      const r = await p.probe(PROBE, { masking: true })
      check(
        'P05-masked',
        '被撤部分不进 packet（同行混合内容按行遮蔽）',
        !r.packetText.includes(VALUE_A),
        `leak=${String(r.packetText.includes(VALUE_A))}`
      )
      const recall = await p.rig.recall('我上的什么大学')
      const all = await p.rig.h.store.list({ owner: p.rig.h.owner, limit: 50 })
      const institution = all.find((m) => JSON.stringify(m.content).includes('education.institution'))
      check(
        'P05-no-collateral',
        '无关信息（就读院校）仍被记录且可召回（误伤正控——PC-2）',
        institution !== undefined &&
          String(institution.status) === 'active' &&
          recall.selected.includes(String(institution.id)),
        `institution=${institution === undefined ? '(none)' : String(institution.status)} selected=${String(recall.selected)}；注：冻结合行第二句（周三体检）不被单句规则抽取器解析为独立记忆——按实测登记`
      )
      void M1
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P06 同值不同主体（遮蔽不越界） ---')
  // =========================================================================
  {
    const p = await openPRig('p06')
    try {
      const A1 = await p.rig.say(SENTENCE_A)
      await p.rig.say(FORGET_A)
      /* 用户乙同值告知：直接写行 + validator 级候选（不同主体 ⇒ 不同 id） */
      const evB = await p.appendLine({ actorType: 'user', actorId: 'user-b-p06', text: SENTENCE_A })
      const cB = await p.rig.candidateFor(SENTENCE_A, evB)
      /*
       * 乙的候选：主体换成乙。必须用 createMemoryCandidate **重建**（R09② 同形）——
       * 确定性 id 从主体派生，spread 旧候选会带上甲的 proposedId ⇒ CREATE 折到
       * 甲的 retracted 记录上变 no-op（首轮实测踩过）。
       */
      const other = entityRef('user', 'user-b-p06')
      const cB2 = createMemoryCandidate({
        owner: p.rig.h.owner,
        type: 'preference',
        content: {
          kind: 'claim',
          subject: other,
          predicate: (cB.proposedContent as { predicate: string }).predicate,
          value: (cB.proposedContent as { value: unknown }).value,
        },
        subjects: [other],
        sourceRefs: [conversationEvidence(evB)],
        evidenceRootIds: [evB],
        epistemicStatus: 'reported',
        authority: 'EXPLICIT_USER_STATEMENT',
        importance: 0.8,
        confidence: 0.9,
        processor: 'explicit-memory',
        processorVersion: 'explicit-memory@1',
      })
      const vB = await p.rig.validator.validate({
        characterId: p.rig.h.characterId as never,
        owner: p.rig.h.owner,
        candidates: [cB2],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: evB,
      })
      await p.rig.commitAccepted(vB.accepted)
      const r = await p.probe(PROBE, { masking: true })
      /*
       * 甲乙两行同文本 ⇒ 计数判据（断言面 = 最终 packet；遮蔽不回写原始行）：
       * 甲行占位后，SENTENCE_A 在 packet 恰好剩 1 次（= 乙的行）。
       */
      const occurrences = r.packetText.split(SENTENCE_A).length - 1
      check(
        'P06-b-visible',
        '乙的行不被遮蔽（撤销集按 owner+subject 限定——D17/P06①）',
        occurrences === 1,
        `occurrences=${String(occurrences)}（0 = 乙也被误遮；2 = 甲未遮）`
      )
      check(
        'P06-a-masked',
        '甲的行仍被占位（对照）',
        r.packetText.includes(WITHDRAWN_PLACEHOLDER_USER),
        `user占位在=${String(r.packetText.includes(WITHDRAWN_PLACEHOLDER_USER))}`
      )
      /*
       * 乙的记录可召回的资格面：ACTIVE + 证据链完整（recall 资格 = ACTIVE-only +
       * integrity，二者都在场即成立）。rig.recall 按 Alex 作用域，不能直接断言
       * 乙的选中——那是作用域语义，不是遮蔽语义（如实登记，不硬凑）。
       */
      const bId = String((vB.accepted[0]?.payload as { memoryId?: string } | undefined)?.memoryId ?? '')
      const bRecord = bId === '' ? null : await p.rig.h.store.get(bId as never)
      check(
        'P06-b-recallable',
        '乙的记录 active 且证据链完整（遮蔽不越界——PC-2）',
        bRecord !== null &&
          String(bRecord.status) === 'active' &&
          bRecord.sourceRefs.length > 0 &&
          bRecord.sourceRefs.every((s) => String(s.id) === evB),
        `bRecord=${bRecord === null ? '(none)' : `${String(bRecord.status)} sources=${String(bRecord.sourceRefs.length)}`}`
      )
      void A1
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P07 普通更正后问历史（T17：更正史保留） ---')
  // =========================================================================
  {
    const p = await openPRig('p07')
    try {
      const T1 = await p.rig.say(V1)
      await p.rig.say(CORRECT_V2)
      /* v1 是 superseded（更正），不是 retracted ⇒ 不进撤销集（D17：correction 仅自身） */
      const withdrawn = await computeWithdrawnEvidence(p.rig.h.db, p.rig.h.store, p.rig.h.owner)
      const v1Sources = (await p.rig.h.store.get(T1.outcome?.ok ? (T1.outcome.memoryId as never) : ('' as never)))?.sourceRefs ?? []
      const v1InSet = v1Sources.some((s) => withdrawn.withdrawnEventIds.includes(s.id))
      check(
        'P07-not-in-set',
        'v1 的来源不在撤销集（explicit_correction 仅自身——与 forget 分轮处理）',
        !v1InSet && withdrawn.measuredCount === 0,
        `v1InSet=${String(v1InSet)} retractedCount=${String(withdrawn.measuredCount)}`
      )
      const r = await p.probe('我以前不吃香菜吗？', { masking: true })
      check(
        'P07-history-visible',
        '更正史可讲：v1 原话仍在 Recent（历史沿原政策保留——T17）',
        r.packetText.includes(V1),
        `v1原话在=${String(r.packetText.includes(V1))}`
      )
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P08 遗忘后重新告知（新旧行分断；与 R02 复活衔接） ---')
  // =========================================================================
  {
    const p = await openPRig('p08', { restatementRevival: true })
    try {
      const A1 = await p.rig.say(SENTENCE_A)
      await p.rig.say(FORGET_A)
      const A3 = await p.rig.say(SENTENCE_A) /* 新告知 ⇒ 复活（R02） */
      const r = await p.probe(PROBE, { masking: true })
      /*
       * 断言面 = **最终 packet**（遮蔽发生在 compileTurn 内部的行副本上，
       * 不回写库/原始行——读回原始行永远是原文，量不到遮蔽）。
       * 新旧行同文本 ⇒ 计数判据：旧行被占位后，SENTENCE_A 在 packet 里
       * 恰好剩 1 次（= 新告知那次），且占位文本在场。
       */
      const occurrences = r.packetText.split(SENTENCE_A).length - 1
      check(
        'P08-new-visible',
        '新告知行不占位（新来源可用——PC-3）',
        r.packetText.includes(SENTENCE_A),
        `newValue在=${String(r.packetText.includes(SENTENCE_A))} occurrences=${String(occurrences)}`
      )
      check(
        'P08-old-masked',
        '旧来源行仍占位（判据基于来源与时序，非全局字符串）',
        occurrences === 1 && r.packetText.includes(WITHDRAWN_PLACEHOLDER_USER),
        `occurrences=${String(occurrences)}（>1 = 旧行未遮蔽；0 = 新行也被误遮）placeholder=${String(r.packetText.includes(WITHDRAWN_PLACEHOLDER_USER))}`
      )
      const recall = await p.rig.recall('技术问题你喜欢怎么解释')
      const record = await p.rig.h.store.get(A1.outcome?.ok ? (A1.outcome.memoryId as never) : ('' as never))
      check(
        'P08-recallable',
        '复活记忆可召回（与 R02 衔接）',
        record !== null && String(record.status) === 'active' && recall.selected.includes(String(record?.id)),
        `status=${String(record?.status)} selected=${String(recall.selected)}`
      )
      void A3
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P09 重启/跨会话/窗口滚出 ---')
  // =========================================================================
  {
    /*
     * 窗口滚出半边：写 30 条填充行，把被撤行挤出 Recent 窗口。
     * 重启半边：第二个独立装配（新隔离库、新进程内实例）重做同构底座——
     * 端口读的是持久账本，不是进程缓存；两半各自独立断言。
     */
    const p = await openPRig('p09')
    try {
      const A1 = await p.rig.say(SENTENCE_A)
      await p.rig.say(FORGET_A)
      for (let i = 0; i < 30; i += 1) {
        await p.appendLine({ actorType: 'user', actorId: p.rig.h.userId, text: ` filler number ${String(i)} plain weather talk` })
      }
      const rolled = await p.probe(PROBE, { masking: true, recentSlice: 5 })
      check(
        'P09-rolled-out',
        '窗口滚出后无泄漏（负控：本来就不在窗口）',
        !rolled.packetText.includes(VALUE_A),
        `leak=${String(rolled.packetText.includes(VALUE_A))} recentSlice=5`
      )
      /* 撤销集不依赖窗口：来自持久账本，被撤事件仍在集合里 */
      const withdrawn = await computeWithdrawnEvidence(p.rig.h.db, p.rig.h.store, p.rig.h.owner)
      check(
        'P09-set-from-ledger',
        '撤销集来自持久账本（与 Recent 窗口无关）',
        withdrawn.ok && withdrawn.withdrawnEventIds.includes(A1.eventId),
        `set含被撤事件=${String(withdrawn.withdrawnEventIds.includes(A1.eventId))} count=${String(withdrawn.withdrawnEventIds.length)}`
      )
    } finally {
      await p.dispose()
    }
    /* 跨装配半边：全新装配实例 + 同构底座 ⇒ 遮蔽照常（无进程缓存可依赖） */
    const p2 = await openPRig('p09-restart')
    try {
      await baseForgetA(p2)
      const r2 = await p2.probe(PROBE, { masking: true })
      check(
        'P09-restart',
        '新装配实例（新库同构底座）遮蔽照常生效（端口无进程缓存）',
        !r2.packetText.includes(VALUE_A) && r2.packetText.includes(WITHDRAWN_PLACEHOLDER_USER),
        `leak=${String(r2.packetText.includes(VALUE_A))} 占位=${String(r2.packetText.includes(WITHDRAWN_PLACEHOLDER_USER))}`
      )
    } finally {
      await p2.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P10 取候选后遗忘（同轮时序） ---')
  // =========================================================================
  {
    const p = await openPRig('p10')
    try {
      await p.rig.say(SENTENCE_A)
      /* 时序：beginTurn（探针轮开始）→ 遗忘发生 → compileTurn（判定点在编译前） */
      await p.syncSeq()
      const turn = await p.gateway.beginTurn(PROBE)
      await p.rig.say(FORGET_A)
      const allLines = await recentContextLinesFrom(p.rig.h.runtime, {
        characterId: p.rig.h.characterId as never,
        userName: 'Alex',
        characterName: character.name,
        limit: 18,
      })
      const packet = await p.gateway.compileTurn({
        turn,
        currentInput: PROBE,
        recentLines: allLines,
        withdrawnMasking: { compute: () => computeWithdrawnEvidence(p.rig.h.db, p.rig.h.store, p.rig.h.owner) },
      })
      check(
        'P10-same-turn',
        '同轮遗忘天然覆盖：编译前发生的遗忘在本次编译就被遮蔽',
        !packet.text.includes(VALUE_A) && packet.text.includes(WITHDRAWN_PLACEHOLDER_USER),
        `leak=${String(packet.text.includes(VALUE_A))} 占位=${String(packet.text.includes(WITHDRAWN_PLACEHOLDER_USER))}`
      )
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P11 孤儿/读失败/裁剪（失败关闭） ---')
  // =========================================================================
  {
    /* ① 孤儿撤回：删掉 retracted 记录的证据链接 ⇒ ok:false ⇒ 整段 Recent 压制 */
    const p = await openPRig('p11')
    try {
      const A1 = await p.rig.say(SENTENCE_A)
      await p.rig.say(FORGET_A)
      await p.rig.h.db.execute(
        sql`delete from memory_evidence_links where memory_id = ${String(A1.outcome?.ok ? A1.outcome.memoryId : '')}`
      )
      const r = await p.probe(PROBE, { masking: true })
      const trace = await getTrace(p.rig.h.db, r.traceId as never)
      const step = trace?.steps.find((s) => s.kind === 'withdrawn_masking')
      check(
        'P11-orphan',
        '孤儿撤回 ⇒ 整段 Recent 压制 + trace 具名缺口（不伪装覆盖）',
        !r.packetText.includes(VALUE_A) &&
          !r.sections.includes('recent-conversation') &&
          step !== undefined &&
          step.attributes.suppressed === 1 &&
          String(step.attributes.gaps ?? '').includes('orphan_no_sources'),
        `recent被压制=${String(!r.sections.includes('recent-conversation'))} gaps=${String(step?.attributes.gaps ?? '')}`
      )
    } finally {
      await p.dispose()
    }
  }
  {
    /* ② 端口读失败注入：compute 抛错 ⇒ 压制 + 具名原因 */
    const p = await openPRig('p11-readfail')
    try {
      await baseForgetA(p)
      const r = await p.probe(PROBE, {
        masking: true,
        computeOverride: async () => {
          throw new Error('P11 注入：撤销端口读取失败')
        },
      })
      const trace = await getTrace(p.rig.h.db, r.traceId as never)
      const step = trace?.steps.find((s) => s.kind === 'withdrawn_masking')
      check(
        'P11-read-failed',
        '读失败 ⇒ 整段 Recent 不供给 + trace 具名原因（D19，不伪装零结果）',
        !r.packetText.includes(VALUE_A) &&
          !r.sections.includes('recent-conversation') &&
          step !== undefined &&
          step.attributes.suppress_reason === 'withdrawn_read_failed',
        `recent被压制=${String(!r.sections.includes('recent-conversation'))} reason=${String(step?.attributes.suppress_reason ?? '')}`
      )
    } finally {
      await p.dispose()
    }
  }
  {
    /* ③ 预算裁剪：Recent 是 droppable——极小预算下被裁 ⇒ 无泄漏（不静默放行） */
    const p = await openPRig('p11-budget')
    try {
      await baseForgetA(p)
      await p.syncSeq()
      const turn = await p.gateway.beginTurn(PROBE)
      const allLines = await recentContextLinesFrom(p.rig.h.runtime, {
        characterId: p.rig.h.characterId as never,
        userName: 'Alex',
        characterName: character.name,
        limit: 18,
      })
      const packet = await p.gateway.compileTurn({
        turn,
        currentInput: PROBE,
        recentLines: allLines,
        withdrawnMasking: { compute: () => computeWithdrawnEvidence(p.rig.h.db, p.rig.h.store, p.rig.h.owner) },
      })
      const recentSurvived = packet.sections.some((s) => s.id === 'recent-conversation')
      check(
        'P11-budget-cut',
        '裁剪路径无泄漏（Recent 被裁 ⇒ 取值不进 packet；不静默放行被撤行）',
        !packet.text.includes(VALUE_A),
        `recentSurvived=${String(recentSurvived)}（无论裁否，被撤取值都不在 packet）`
      )
      /* ④ 正控指针：未退化成全量禁用（P05/P06 同轮通过） */
      check(
        'P11-no-global-suppression',
        '正控：失败关闭未退化成全量禁用（P05/P06 误伤正控同轮通过）',
        rows.some((x) => x.id === 'P05-no-collateral' && x.ok) && rows.some((x) => x.id === 'P06-b-recallable' && x.ok),
        '指针断言：P05-no-collateral 与 P06-b-recallable 均 PASS'
      )
    } finally {
      await p.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- P12 其余读取面（Recall/状态文本/trace 隐私） ---')
  // =========================================================================
  {
    const p = await openPRig('p12')
    try {
      const A1 = await p.rig.say(SENTENCE_A)
      await p.rig.say(FORGET_A)
      /* ① Recall：ACTIVE-only（retracted 不可召回——WP0 A-L3 同构） */
      const recall = await p.rig.recall('技术问题你喜欢怎么解释')
      check(
        'P12-recall-active-only',
        'Recall 面：retracted 不进召回（ACTIVE-only 资格）',
        !recall.selected.includes(String(A1.outcome?.ok ? A1.outcome.memoryId : '')),
        `selected=${String(recall.selected)}`
      )
      /* ③④ 探针轮：状态文本无被撤取值；trace 无被撤正文（隐私断言） */
      const r = await p.probe(PROBE, { masking: true })
      check(
        'P12-state-text',
        '状态/其余 section 无被撤取值、无「我从来不知道」式虚构占位',
        !r.packetText.includes(VALUE_A) && !r.packetText.includes('我从来不知道'),
        `leak=${String(r.packetText.includes(VALUE_A))}`
      )
      const trace = await getTrace(p.rig.h.db, r.traceId as never)
      const stepsJson = JSON.stringify(trace?.steps ?? [])
      check(
        'P12-trace-privacy',
        'trace 只有引用/计数/原因——无被撤正文（隐私断言）',
        !stepsJson.includes(VALUE_A),
        `trace含被撤取值=${String(stepsJson.includes(VALUE_A))} steps=${String(trace?.steps.length ?? 0)}`
      )
    } finally {
      await p.dispose()
    }
  }
  notRun(
    'P12-belief',
    'Belief 面（失效+禁根+同轮 overlay）',
    '需要 belief 域夹具与 reconciler 装配——与 R10 同属 WP5 联合 e2e 的 belief 半边'
  )

  // =========================================================================
  // R10 / R12：具名 NOT RUN（WP5 联合 e2e 的另两行）
  // =========================================================================
  notRun('R10', '同 id 新 revision 与旧 Belief（钉住测试）', '需要 belief 域夹具（reconciler/禁根/水位）——WP5 联合 e2e')
  notRun('R12', '原长门检查点复测（LL-C5/C6）', '需要 m9 长轨迹夹具与 live 判定器——WP5/WP6')

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const { resetPluginSqlConnection } = await import('../src/dev/sandbox.ts')
  await resetPluginSqlConnection()
  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const realDbUntouched = realDbBefore.treeSha256 === realDbAfter.treeSha256

  const passed = rows.filter((r) => r.status === 'PASS').length
  const failedRows = rows.filter((r) => r.status === 'FAIL')
  const notRunRows = rows.filter((r) => r.status === 'NOT_RUN')
  const allOk = failedRows.length === 0 && realDbUntouched

  const head = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dir = join(process.cwd(), 'artifacts', 'm9.1', `e2e-${date}-${head}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'e2e.json'),
    JSON.stringify(
      {
        instrument: 'm9.1-e2e@1',
        kind: 'production-assembly-f1-matrix',
        head,
        date,
        isolation: '每场景独立 isolateDatabase(keep:false)；真实库 digestTree 前后摘要证明未动',
        realDbUntouched,
        rows,
        passed,
        failed: failedRows.length,
        notRun: notRunRows.map((r) => ({ id: r.id, reason: r.reason })),
        verdict: allOk ? 'PASS' : 'FAIL',
      },
      null,
      2
    ),
    'utf8'
  )

  console.log(`\n=== 汇总：${String(passed)} 通过 / ${String(failedRows.length)} 失败 / ${String(notRunRows.length)} 未运行（具名） ===`)
  for (const f of failedRows) console.log(`  ❌ ${f.id} ${f.name} :: ${f.detail}`)
  for (const n of notRunRows) console.log(`  ⏭️ ${n.id} ${n.reason}`)
  console.log(`真实库未动=${String(realDbUntouched)}`)
  console.log(`证据：${join('artifacts', 'm9.1', `e2e-${date}-${head}`, 'e2e.json')}`)
  process.exitCode = allOk ? 0 : 1
}

await main()
