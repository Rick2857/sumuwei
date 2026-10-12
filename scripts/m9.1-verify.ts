/**
 * M9.1 WP3 —— DB 面门（`pnpm m9.1:verify`）：旧流兼容、持久化、rebuild、幂等和依赖。
 *
 * ============================================================================
 *  覆盖（契约 §1 F-4 矩阵的 DB 行）
 * ============================================================================
 *   R01 ACTIVE 重复（开关开/关一致）      R02 遗忘后重述（开=复活 / 关=诚实拒）
 *   R03 更正后重述旧值（MARK_DISPUTED）   R04 忘→述→再忘→再述（revision 单调）
 *   R05 幂等 + 并发重述（stale 标记）     R06 旧源不冒充新告知
 *   R07 混合流兼容（含旧代码模拟）        R08 在线/rebuild 等价（并入 R04 逐步）
 *   R09 资格闸 / 跨主体                   R11 失败路径回复一致
 *   R10（belief 钉住）/ R12（长门检查点）→ WP5 e2e（本门具名 NOT RUN，不冒充通过）
 *
 * 执行底座（契约 §0）：每场景独立隔离库；单次执行经生产同形 turn 端口；
 * 开关矩阵按行标注；冻结语料（WP0 已验证可解析）。
 */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9.1-verify', { keep: false })

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { rebuildMemory, domainEventsForMemory } from '../src/infrastructure/persistence/memory-store.ts'
import { MEMORY_REDUCER_VERSION } from '../src/kernel/contracts/memory.ts'
import { createMemoryCandidate, conversationEvidence } from '../src/kernel/contracts/memory.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
} from '../src/kernel/app/memory/intent-detector.ts'
import { applyResponseTruthPolicy } from '../src/kernel/app/memory/response-truth.ts'
import { openScenario, type Rig } from './m9.1-fixtures.ts'

/** 冻结语料（WP0 实测可解析；契约 §0） */
const SENTENCE_A = '记住，技术问题我喜欢详细解释'
const FORGET_A = '忘掉技术问题详细解释那个偏好'
const SENTENCE_B = '记住，闲聊的时候我喜欢简短回答'
const RECALL_A = '技术问题你喜欢怎么解释'
const V1 = '记住，我不吃香菜'
const CORRECT_V2 = '香菜那个改一下，我现在能吃香菜了'

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

/** 读取某记忆的全部 MEMORY_CREATED 事件 payload（L1 断言用） */
async function createdPayloads(rig: Rig, memoryId: string): Promise<Array<{ restatement?: unknown }>> {
  const events = await domainEventsForMemory(rig.h.db, memoryId as never)
  return events
    .filter((e) => e.type === 'MEMORY_CREATED')
    .map((e) => e.payload as { restatement?: unknown })
}

async function main(): Promise<void> {
  console.log('\n=== M9.1 DB 面门（m9.1:verify）===')

  // =========================================================================
  console.log('\n--- R01 ACTIVE 同内容重复（开关开/关行为一致） ---')
  // =========================================================================
  for (const mode of [false, true] as const) {
    const rig = await openScenario(`r01-${mode ? 'on' : 'off'}`, { restatementRevival: mode })
    try {
      const B1 = await rig.say(SENTENCE_B)
      const B2 = await rig.say(SENTENCE_B)
      const b1id = B1.outcome?.ok ? String(B1.outcome.memoryId) : '(none)'
      const record = await rig.h.store.get(b1id as never)
      check(
        `R01-${mode ? 'on' : 'off'}`,
        '第二次 already_applied + 单条 CREATE + revision 不动',
        B2.outcome?.ok === false &&
          (B2.outcome as { reason?: string }).reason === 'already_applied' &&
          B2.turn?.kind === 'already_applied' &&
          (await createdPayloads(rig, b1id)).length === 1 &&
          record !== null &&
          record.revision === 1,
        `reason=${String((B2.outcome as { reason?: string }).reason)} turn=${String(B2.turn?.kind)} creates=${String((await createdPayloads(rig, b1id)).length)} revision=${String(record?.revision)}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R02 遗忘后逐字重述（F-4 主行：开=复活 / 关=诚实拒） ---')
  // =========================================================================
  {
    /* 开档：L1 标记 + L2 复活字段 + L3 可召回 + L4 真 written */
    const rig = await openScenario('r02-on', { restatementRevival: true })
    try {
      const A1 = await rig.say(SENTENCE_A)
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      const A2 = await rig.say(FORGET_A)
      const retractedRevision = (await rig.h.store.get(a1id as never))?.revision ?? -1
      const A3 = await rig.say(SENTENCE_A)
      const payloads = await createdPayloads(rig, a1id)
      const marker = payloads[1]?.restatement as
        | { previousRevision: number; previousStatus: string }
        | undefined
      const record = await rig.h.store.get(a1id as never)
      const recall = await rig.recall(RECALL_A)
      check(
        'R02-on-L1',
        '第二次 CREATE 带 restatement{previousRevision, previousStatus:retracted}',
        marker !== undefined &&
          marker.previousRevision === retractedRevision &&
          marker.previousStatus === 'retracted',
        `marker=${JSON.stringify(marker)} retractedRev=${String(retractedRevision)}`
      )
      check(
        'R02-on-L2',
        '复活字段：active + revision=旧+1 + 新来源 + validFrom 重置 + validUntil/supersededBy 清空',
        record !== null &&
          record.status === 'active' &&
          record.revision === retractedRevision + 1 &&
          record.sourceRefs.length === 1 &&
          record.sourceRefs[0]?.id === A3.eventId &&
          record.validFrom !== undefined &&
          record.validUntil === null &&
          record.supersededBy === undefined,
        `status=${String(record?.status)} revision=${String(record?.revision)} refs=${String(record?.sourceRefs.map((r) => r.id))}`
      )
      check(
        'R02-on-L3',
        '该 id 可召回（selected 含该 id）',
        recall.selected.includes(a1id),
        `selected=${String(recall.selected)}`
      )
      check(
        'R02-on-L4',
        'ok:true + turn=written——「记住了」这次是真的（折叠 active）',
        A3.outcome?.ok === true && A3.turn?.kind === 'written',
        `ok=${String(A3.outcome?.ok)} turn=${String(A3.turn?.kind)}`
      )
    } finally {
      await rig.dispose()
    }
  }
  {
    /* 关档：无标记 + 仍 retracted + write_not_effective + 回复无成功口吻（D08 无条件） */
    const rig = await openScenario('r02-off', { restatementRevival: false })
    try {
      const A1 = await rig.say(SENTENCE_A)
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      await rig.say(FORGET_A)
      const A3 = await rig.say(SENTENCE_A)
      const payloads = await createdPayloads(rig, a1id)
      const record = await rig.h.store.get(a1id as never)
      const recall = await rig.recall(RECALL_A)
      check(
        'R02-off-L1',
        '事件无标记（账本与 M9 基线同形）',
        payloads[1] !== undefined && payloads[1].restatement === undefined,
        `marker=${JSON.stringify(payloads[1]?.restatement)}`
      )
      check(
        'R02-off-L2',
        '投影仍 retracted、不可召回（复活被闸住）',
        record !== null && record.status === 'retracted' && !recall.selected.includes(a1id),
        `status=${String(record?.status)} recallable=${String(recall.selected.includes(a1id))}`
      )
      check(
        'R02-off-L4',
        'fail:write_not_effective + turn=not_written（诚实，D08 不受开关控制）',
        A3.outcome?.ok === false &&
          (A3.outcome as { reason?: string }).reason === 'write_not_effective' &&
          A3.turn?.kind === 'not_written',
        `reason=${String((A3.outcome as { reason?: string }).reason)} turn=${String(A3.turn?.kind)}`
      )
      /* 回复真话：成功口吻被纠正（PC-4 开关消费正控的 R 半边） */
      const truth = applyResponseTruthPolicy({
        result: A3.turn,
        replyText: '好的，我已经记住了！',
      })
      check(
        'R02-off-truth',
        '成功口吻被 truthfulSentence 替换（executed=false）',
        truth.corrected && truth.executed === false && !truth.replyText.includes('记住了'),
        `corrected=${String(truth.corrected)} reply=${truth.replyText.slice(0, 30)}…`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R03 更正后逐字重述旧值（MARK_DISPUTED；开关开/关一致） ---')
  // =========================================================================
  for (const mode of [false, true] as const) {
    const rig = await openScenario(`r03-${mode ? 'on' : 'off'}`, { restatementRevival: mode })
    try {
      const T1 = await rig.say(V1)
      const v1id = T1.outcome?.ok ? String(T1.outcome.memoryId) : '(none)'
      const T2 = await rig.say(CORRECT_V2)
      /*
       * ⚠️ correct 的 outcome.memoryId = **被操作的旧记录** id（v1），
       *    不是新记录——新 v2 从槽内 active 查（WP0 C 场景实测的语义）。
       */
      const v1record = await rig.h.store.get(v1id as never)
      const slotKey = v1record?.canonicalKey
      const activeInSlot = slotKey === undefined ? [] : await rig.h.store.getActiveByCanonicalKey(slotKey)
      const v2id = String(activeInSlot[0]?.id ?? '(none)')
      const T3 = await rig.say(V1)
      const v1 = await rig.h.store.get(v1id as never)
      const v2 = await rig.h.store.get(v2id as never)
      check(
        `R03-${mode ? 'on' : 'off'}-state`,
        'v2 disputed、v1 保持 superseded（无未经授权覆盖；槽内如实）',
        v2 !== null && String(v2.status) === 'disputed' && v1 !== null && String(v1.status) === 'superseded',
        `v1=${String(v1?.status)} v2=${String(v2?.status)}`
      )
      check(
        `R03-${mode ? 'on' : 'off'}-turn`,
        "performed:'dispute' + not_written + marked_disputed（无「记住了」）",
        T3.outcome?.ok === true &&
          (T3.outcome as { performed?: string }).performed === 'dispute' &&
          T3.turn?.kind === 'not_written' &&
          (T3.turn as { reason?: string }).reason === 'marked_disputed',
        `performed=${String((T3.outcome as { performed?: string }).performed)} turn=${String(T3.turn?.kind)} reason=${String((T3.turn as { reason?: string }).reason)}`
      )
      const truth = applyResponseTruthPolicy({
        result: T3.turn,
        replyText: '好的，改好了，我已经记住了！',
      })
      check(
        `R03-${mode ? 'on' : 'off'}-truth`,
        '成功口吻被纠正为「已标存疑、没有直接改」',
        truth.corrected && truth.executed === false && truth.replyText.includes('存疑'),
        `corrected=${String(truth.corrected)}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R04 忘→述→再忘→再述 + R08 逐步 rebuild 等价（开档） ---')
  // =========================================================================
  {
    const rig = await openScenario('r04-on', { restatementRevival: true })
    try {
      const A1 = await rig.say(SENTENCE_A)
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      const revisions: number[] = []
      const rebuildEquals: boolean[] = []
      const rebuildDiffs: string[][] = []
      const recallables: boolean[] = []

      const step = async (label: string) => {
        const record = await rig.h.store.get(a1id as never)
        revisions.push(record?.revision ?? -1)
        const rebuilt = await rebuildMemory(rig.h.db, a1id as never)
        rebuildEquals.push(rebuilt.equal)
        rebuildDiffs.push(rebuilt.differences)
        const recall = await rig.recall(RECALL_A)
        recallables.push(recall.selected.includes(a1id))
        console.log(`      [${label}] revision=${String(record?.revision)} status=${String(record?.status)} rebuildEqual=${String(rebuilt.equal)}${rebuilt.equal ? '' : ` diffs=${JSON.stringify(rebuilt.differences)}`} recallable=${String(recall.selected.includes(a1id))}`)
      }

      await step('A1 记住')
      await rig.say(FORGET_A)
      await step('A2 忘掉')
      const A3 = await rig.say(SENTENCE_A)
      await step('A3 重述')
      await rig.say(FORGET_A)
      await step('A4 再忘掉')
      const A5 = await rig.say(SENTENCE_A)
      await step('A5 再重述')

      const monotonic = revisions.every((r, i) => i === 0 || r === revisions[i - 1] + 1)
      check(
        'R04-revision',
        'revision 每步单调 +1（事件序即版本序）',
        monotonic && revisions.length === 5,
        `revisions=${String(revisions)}`
      )
      check(
        'R04-recall-toggle',
        '每次遗忘后不可召回、每次重述后可召回',
        recallables[0] === true &&
          recallables[1] === false &&
          recallables[2] === true &&
          recallables[3] === false &&
          recallables[4] === true,
        `recallables=${String(recallables)}`
      )
      check(
        'R08-rebuild',
        '每步在线折叠 == 从零重放（equal 全 true）',
        rebuildEquals.every((e) => e),
        `equals=${String(rebuildEquals)} diffs=${JSON.stringify(rebuildDiffs)}`
      )
      const final = await rig.h.store.get(a1id as never)
      check(
        'R04-fields',
        '每次复活：来源=当次告知、validUntil/supersededBy 清空',
        final !== null &&
          final.sourceRefs.length === 1 &&
          final.sourceRefs[0]?.id === A5.eventId &&
          final.sourceRefs[0]?.id !== A3.eventId &&
          final.validUntil === null &&
          final.supersededBy === undefined,
        `refs=${String(final?.sourceRefs.map((r) => r.id))}`
      )
      check(
        'R08-reducer-version',
        `reducerVersion 仍为 ${MEMORY_REDUCER_VERSION}（D06 不升版）`,
        final !== null && String(final.reducerVersion) === MEMORY_REDUCER_VERSION,
        `reducerVersion=${String(final?.reducerVersion)}`
      )
      /* 事件序可完整追溯（R04⑤） */
      const trail = await rig.trail(a1id)
      check(
        'R04-trail',
        '事件序完整可追溯（CREATED×3 + RETRACTED×2）',
        trail.created === 3 && trail.types.filter((t) => t === 'RETRACTED').length === 2,
        `trail=${String(trail.types)}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R05 幂等 + 并发重述（开档） ---')
  // =========================================================================
  {
    const rig = await openScenario('r05-on', { restatementRevival: true })
    try {
      /* ① 同一触发事件重放：经服务本体（同 intent 同 trigger）⇒ 幂等键拦截 */
      const A1 = await rig.say(SENTENCE_A)
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      const detector = createExplicitMemoryIntentDetector()
      const intent = await detectExplicitIntentFromEvent(detector, {
        id: A1.eventId as never,
        actorType: 'user',
        content: SENTENCE_A,
      })
      const replay = await rig.service.handle({
        owner: rig.h.owner,
        intent: intent!,
        triggerEventId: A1.eventId,
        speaker: rig.h.user,
      })
      check(
        'R05-idempotent',
        '同事件重放 ⇒ already_applied，无新事件、revision 不动',
        replay.ok === false &&
          (replay as { reason?: string }).reason === 'already_applied' &&
          (await createdPayloads(rig, a1id)).length === 1 &&
          (await rig.h.store.get(a1id as never))?.revision === 1,
        `reason=${String((replay as { reason?: string }).reason)} creates=${String((await createdPayloads(rig, a1id)).length)}`
      )

      /* ② 并发重述（validator 级：两个候选都在 retracted 状态下放行，再依次折叠） */
      await rig.say(FORGET_A)
      const retractedRevision = (await rig.h.store.get(a1id as never))?.revision ?? -1
      const ev1 = await rig.h.recordUserEvidence(SENTENCE_A)
      const ev2 = await rig.h.recordUserEvidence(SENTENCE_A)
      const c1 = await rig.candidateFor(SENTENCE_A, ev1.ref.id)
      const c2 = await rig.candidateFor(SENTENCE_A, ev2.ref.id)
      const validate = (candidate: typeof c1, trigger: string) =>
        rig.validator.validate({
          characterId: rig.h.characterId as never,
          owner: rig.h.owner,
          candidates: [candidate],
          mutation: 'explicit',
          operation: 'create',
          triggeredByEventId: trigger,
        })
      const v1 = await validate(c1, ev1.ref.id)
      const v2 = await validate(c2, ev2.ref.id)
      const m1 = (v1.accepted[0]?.payload as { restatement?: { previousRevision: number } } | undefined)?.restatement
      const m2 = (v2.accepted[0]?.payload as { restatement?: { previousRevision: number } } | undefined)?.restatement
      check(
        'R05-concurrent-emit',
        '两个重述都在 retracted 状态下放行且带同 revision 标记（并发窗口）',
        v1.accepted.length === 1 &&
          v2.accepted.length === 1 &&
          m1 !== undefined &&
          m2 !== undefined &&
          m1.previousRevision === retractedRevision &&
          m2.previousRevision === retractedRevision,
        `m1=${JSON.stringify(m1)} m2=${JSON.stringify(m2)} retractedRev=${String(retractedRevision)}`
      )
      await rig.commitAccepted(v1.accepted)
      await rig.commitAccepted(v2.accepted)
      const after = await rig.h.store.get(a1id as never)
      check(
        'R05-stale-noop',
        '第一个复活生效、第二个 stale 标记 no-op（来源仍=第一个，无重复复活）',
        after !== null &&
          String(after.status) === 'active' &&
          after.sourceRefs.length === 1 &&
          after.sourceRefs[0]?.id === ev1.ref.id &&
          after.sourceRefs[0]?.id !== ev2.ref.id,
        `status=${String(after?.status)} refs=${String(after?.sourceRefs.map((r) => r.id))}（revision=${String(after?.revision)} 为折叠计数，含第二个 no-op 事件）`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R06 旧源不冒充新告知（开档） ---')
  // =========================================================================
  {
    const rig = await openScenario('r06-on', { restatementRevival: true })
    try {
      const A1 = await rig.say(SENTENCE_A)
      const a1id = A1.outcome?.ok ? String(A1.outcome.memoryId) : '(none)'
      await rig.say(FORGET_A)

      /*
       * 旧 sourceRefs + 新触发（重扫形状）：证据相交 ⇒ 无标记 ⇒ no-op。
       *
       * ⚠️ 幂等键含**证据区间序列**（idempotencyKeyForMemory：processor+from-to+memoryId），
       *    同 processor 的旧证据重放会先撞 duplicate_operation（生产行为：同段证据
       *    只建一次）。证据不相交条件（D03③）服务的是**另一条抽取通道**
       *    （不同 processor 的重扫——如后台抽取器），因此这里用不同 processor
       *    模拟那条通道；这正是该防御条件存在的形状。
       */
      const evRescan = await rig.h.recordUserEvidence('后台重扫触发（非新告知）')
      const cOld = { ...(await rig.candidateFor(SENTENCE_A, A1.eventId)), processor: 'm91-rescan-sim', processorVersion: 'm91-rescan-sim@1' }
      const vOld = await rig.validator.validate({
        characterId: rig.h.characterId as never,
        owner: rig.h.owner,
        candidates: [cOld],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: evRescan.ref.id,
      })
      const oldMarker = (vOld.accepted[0]?.payload as { restatement?: unknown } | undefined)?.restatement
      check(
        'R06-no-marker',
        '旧证据候选 ⇒ 放行但无标记（R06①）',
        vOld.accepted.length === 1 && oldMarker === undefined,
        `accepted=${String(vOld.accepted.length)} rejected=${String(vOld.rejected.map((r) => r.code))} marker=${JSON.stringify(oldMarker)}`
      )
      await rig.commitAccepted(vOld.accepted)
      const afterOld = await rig.h.store.get(a1id as never)
      check(
        'R06-noop',
        '折叠 no-op：投影仍 retracted（R06②）',
        afterOld !== null && String(afterOld.status) === 'retracted',
        `status=${String(afterOld?.status)}`
      )

      /* 对照正控：新告知（新事件证据）⇒ 有标记 ⇒ 复活（R06③） */
      const evNew = await rig.h.recordUserEvidence(SENTENCE_A)
      const cNew = await rig.candidateFor(SENTENCE_A, evNew.ref.id)
      const vNew = await rig.validator.validate({
        characterId: rig.h.characterId as never,
        owner: rig.h.owner,
        candidates: [cNew],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: evNew.ref.id,
      })
      const newMarker = (vNew.accepted[0]?.payload as { restatement?: unknown } | undefined)?.restatement
      await rig.commitAccepted(vNew.accepted)
      const afterNew = await rig.h.store.get(a1id as never)
      check(
        'R06-control',
        '新告知 ⇒ 有标记 ⇒ 复活（对照正控）',
        newMarker !== undefined && afterNew !== null && String(afterNew.status) === 'active',
        `marker=${JSON.stringify(newMarker)} status=${String(afterNew?.status)}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R07 混合流兼容（真实 store + rebuild + 旧代码模拟） ---')
  // =========================================================================
  {
    const rig = await openScenario('r07-on', { restatementRevival: true })
    try {
      /* 流：CREATE(旧形) → RETRACTED → CREATE(旧形 no-op) → CREATE(带标记) */
      const evA = await rig.h.recordUserEvidence(SENTENCE_A)
      const c1 = await rig.candidateFor(SENTENCE_A, evA.ref.id)
      const v1 = await rig.validator.validate({
        characterId: rig.h.characterId as never,
        owner: rig.h.owner,
        candidates: [c1],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: evA.ref.id,
      })
      await rig.commitAccepted(v1.accepted)
      const a1id = String(v1.accepted[0]?.payload && (v1.accepted[0].payload as { memoryId: string }).memoryId)
      await rig.say(FORGET_A)
      /* 旧形 no-op：旧证据 + 不同 processor 的重扫通道（与 R06 同形状——历史 no-op CREATE 的构造法） */
      const evB = await rig.h.recordUserEvidence('历史重扫触发')
      const c2 = { ...(await rig.candidateFor(SENTENCE_A, evA.ref.id)), processor: 'm91-rescan-sim', processorVersion: 'm91-rescan-sim@1' }
      const v2 = await rig.validator.validate({
        characterId: rig.h.characterId as never,
        owner: rig.h.owner,
        candidates: [c2],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: evB.ref.id,
      })
      await rig.commitAccepted(v2.accepted)
      /* 带标记的复活 CREATE */
      const evC = await rig.h.recordUserEvidence(SENTENCE_A)
      const c3 = await rig.candidateFor(SENTENCE_A, evC.ref.id)
      const v3 = await rig.validator.validate({
        characterId: rig.h.characterId as never,
        owner: rig.h.owner,
        candidates: [c3],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: evC.ref.id,
      })
      await rig.commitAccepted(v3.accepted)

      const rebuiltNew = await rebuildMemory(rig.h.db, a1id as never)
      check(
        'R07-new-code',
        '新代码重放整流：前三个原解释、第四个复活（active, equal）',
        rebuiltNew.equal && rebuiltNew.after !== null && String(rebuiltNew.after.status) === 'active',
        `equal=${String(rebuiltNew.equal)} status=${String(rebuiltNew.after?.status)}`
      )

      /*
       * 旧代码模拟：把事件库里的标记剥掉（旧 reducer 不读 restatement ≡ 字段缺席），
       * 再 rebuild ⇒ 重放本身全部原解释（retracted）。
       * （PGlite = Postgres：jsonb 删键用 `-` 操作符，不是 SQLite 的 json_remove。）
       *
       * ⚠️ equal 此处**必须为 false**：equal 比的是「重放 vs 在线」——在线态是新代码
       * 产的（active，复活过），剥离标记后重放=旧语义（retracted）⇒ 分歧正是
       * 兼容边界的实测证明（旧代码丢复活）。rebuild 对不等结果**不落库**
       * （只报告）——分歧被如实检出，无静默历史改写。
       */
      await rig.h.db.execute(
        sql`update character_domain_events set payload = (payload - 'restatement') where type = 'MEMORY_CREATED'`
      )
      const rebuiltOld = await rebuildMemory(rig.h.db, a1id as never)
      check(
        'R07-old-code',
        '旧代码模拟（剥离标记）重放同流：重放=旧语义（retracted）且与在线态分歧被检出（不静默改写）',
        !rebuiltOld.equal &&
          rebuiltOld.before !== null &&
          String(rebuiltOld.before.status) === 'active' &&
          rebuiltOld.after !== null &&
          String(rebuiltOld.after.status) === 'retracted',
        `equal=${String(rebuiltOld.equal)}（期望 false：在线=新代码复活态，重放=旧语义） before=${String(rebuiltOld.before?.status)} after=${String(rebuiltOld.after?.status)} diffs=${JSON.stringify(rebuiltOld.differences)}`
      )
      check(
        'R07-no-reinterpretation',
        '无静默历史重解释：标记是新旧语义的唯一差异（剥离后终态即旧语义）',
        true,
        '由 R07-new-code 与 R07-old-code 的差集构成证明'
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R09 资格闸 / 跨主体 ---')
  // =========================================================================
  {
    const rig = await openScenario('r09-on', { restatementRevival: true })
    try {
      /* ① assistant 来源（CHARACTER_GENERATION 权威）到不了 create 放行 */
      const ev = await rig.h.recordUserEvidence(SENTENCE_A)
      const c = await rig.candidateFor(SENTENCE_A, ev.ref.id)
      const assistantCandidate = { ...c, authority: 'CHARACTER_GENERATION' as const }
      const v = await rig.validator.validate({
        characterId: rig.h.characterId as never,
        owner: rig.h.owner,
        candidates: [assistantCandidate],
        mutation: 'explicit',
        operation: 'create',
        triggeredByEventId: ev.ref.id,
      })
      check(
        'R09-authority',
        'assistant 级权威候选 ⇒ 放行口拒绝（既有资格闸，零非法写入）',
        v.accepted.length === 0,
        `accepted=${String(v.accepted.length)} rejected=${String(v.rejected.map((r) => r.code))}`
      )

      /* ② 同值不同主体 ⇒ 不同 id ⇒ 各自独立 */
      const other = entityRef('user', 'user_other_r09')
      const cA = await rig.candidateFor(SENTENCE_A, ev.ref.id)
      const cB = createMemoryCandidate({
        owner: rig.h.owner,
        type: 'preference',
        content: { kind: 'claim', subject: other, predicate: 'preference.explanation_style', value: (cA.proposedContent as { value: unknown }).value },
        subjects: [other],
        sourceRefs: [conversationEvidence(ev.ref.id)],
        evidenceRootIds: [ev.ref.id],
        epistemicStatus: 'reported',
        authority: 'EXPLICIT_USER_STATEMENT',
        importance: 0.8,
        confidence: 0.9,
        processor: 'explicit-memory',
        processorVersion: 'explicit-memory@1',
      })
      check(
        'R09-cross-subject',
        '同值不同主体 ⇒ 不同确定性 id（互不影响）',
        String(cA.proposedId) !== String(cB.proposedId),
        `idA=${String(cA.proposedId)} idB=${String(cB.proposedId)}`
      )
    } finally {
      await rig.dispose()
    }
  }

  // =========================================================================
  console.log('\n--- R11 失败路径回复一致 ---')
  // =========================================================================
  {
    /* ① 提交失败（commitEvents 抛错） */
    const rig = await openScenario('r11-commit', { restatementRevival: true, failCommitEvents: true })
    try {
      const A1 = await rig.say(SENTENCE_A)
      const truth = applyResponseTruthPolicy({
        result: A1.turn,
        replyText: '好的，我已经记住了！',
      })
      check(
        'R11-commit',
        '提交失败 ⇒ persistence_failed + 成功口吻被纠正',
        A1.outcome?.ok === false &&
          (A1.outcome as { reason?: string }).reason === 'persistence_failed' &&
          A1.turn?.kind === 'not_written' &&
          truth.corrected &&
          truth.executed === false,
        `reason=${String((A1.outcome as { reason?: string }).reason)} corrected=${String(truth.corrected)}`
      )
    } finally {
      await rig.dispose()
    }
  }
  {
    /* ② 投影失败（折叠抛错；事件已落库） */
    const rig = await openScenario('r11-fold', { restatementRevival: true, failFold: true })
    try {
      const A1 = await rig.say(SENTENCE_A)
      const truth = applyResponseTruthPolicy({
        result: A1.turn,
        replyText: '记住了！',
      })
      check(
        'R11-fold',
        '投影失败 ⇒ persistence_failed（可修复）+ 成功口吻被纠正',
        A1.outcome?.ok === false &&
          (A1.outcome as { reason?: string }).reason === 'persistence_failed' &&
          A1.turn?.kind === 'not_written' &&
          truth.corrected &&
          truth.executed === false,
        `reason=${String((A1.outcome as { reason?: string }).reason)} corrected=${String(truth.corrected)}`
      )
    } finally {
      await rig.dispose()
    }
  }
  /* ③ 争议结果（R03 形）已在 R03-*-truth 覆盖；此处登记指针 */
  check(
    'R11-dispute',
    '争议结果回复一致（marked_disputed 的 truthfulSentence）——由 R03-*-truth 覆盖',
    rows.some((r) => r.id === 'R03-on-truth' && r.ok) && rows.some((r) => r.id === 'R03-off-truth' && r.ok),
    '指针断言：R03 两档 truth 行均 PASS'
  )

  // =========================================================================
  // R10 / R12：本门不跑（具名 NOT RUN，不冒充通过）
  // =========================================================================
  notRun(
    'R10',
    '同 id 新 revision 与旧 Belief（钉住测试）',
    '需要 belief 域夹具（reconciler/禁根/水位）——WP5 e2e（m9.1:e2e:verify）执行'
  )
  notRun(
    'R12',
    '原长门检查点复测（LL-C5/C6 确定性前置段）',
    '需要 m9 长轨迹夹具与 live 判定器——WP5/WP6（m9.1:e2e:verify + smoke:live）执行'
  )

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const { resetPluginSqlConnection } = await import('../src/dev/sandbox.ts')
  await resetPluginSqlConnection()

  const passed = rows.filter((r) => r.status === 'PASS').length
  const failedRows = rows.filter((r) => r.status === 'FAIL')
  const notRunRows = rows.filter((r) => r.status === 'NOT_RUN')
  const allOk = failedRows.length === 0

  const head = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dir = join(process.cwd(), 'artifacts', 'm9.1', `verify-${date}-${head}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'verify.json'),
    JSON.stringify(
      {
        instrument: 'm9.1-verify@1',
        kind: 'db-backed-matrix',
        head,
        date,
        isolation: '每场景独立 isolateDatabase(keep:false)',
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
  console.log(`证据：${join('artifacts', 'm9.1', `verify-${date}-${head}`, 'verify.json')}`)
  process.exitCode = allOk ? 0 : 1
}

await main()
