/**
 * M9.1 WP3 —— 纯函数与状态机门（`pnpm m9.1:test`）。
 *
 * ============================================================================
 *  覆盖范围（契约 §4：R01–R12 / P01–P12 的**纯函数与状态机部分**）
 * ============================================================================
 *   §1 reducer 三分支（D05）：首次创建 / 复活采纳 / no-op——含全部守卫
 *   §2 复活快照字段语义（D04，`revivalRecordFromCandidate`）
 *   §3 registry 放行（D02：标记逐字段保留 + 非法形状拒绝）
 *   §4 translate 新映射（D09：`performed:'dispute'` → not_written + marked_disputed）
 *   §5 response-truth（D08/D09 的 truthfulSentence 新条目 + executed=false）
 *   §6 混合流重放兼容（R07 纯函数半边：标记是新旧语义的**唯一**差异）
 *   §7 撤销遮蔽纯函数（F-1 / D18：maskWithdrawnLines 命中/派生面/不误伤/保守面）
 *
 * 本门**不碰数据库**（DB 面在 `m9.1:verify`），因此不需要 isolateDatabase；
 * 事件用 registry 的 validatePayload 构造（与生产同一处契约校验）。
 */
import 'dotenv/config'

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MEMORY_CREATED,
  createFullDomainEventRegistry,
  type DomainEvent,
  type MemoryCreatedPayload,
} from '../src/kernel/contracts/domain-event.ts'
import {
  MEMORY_REDUCER_VERSION,
  conversationEvidence,
  createMemoryCandidate,
  recordFromCandidate,
  revivalRecordFromCandidate,
  type ClaimMemoryContent,
  type MemoryCandidate,
  type MemoryRecord,
} from '../src/kernel/contracts/memory.ts'
import { entityRef, type EntityRef } from '../src/kernel/contracts/entity.ts'
import type { Timestamp } from '../src/kernel/contracts/ids.ts'
import { reduceMemory } from '../src/kernel/projections/memory.ts'
import {
  maskWithdrawnLines,
  WITHDRAWN_PLACEHOLDER_ASSISTANT,
  WITHDRAWN_PLACEHOLDER_USER,
  type ConversationLine,
} from '../src/kernel/context/sections.ts'
import { translate } from '../src/kernel/app/memory/explicit-turn.ts'
import type { ExplicitMemoryOutcome } from '../src/kernel/app/memory/explicit-service.ts'
import { applyResponseTruthPolicy } from '../src/kernel/app/memory/response-truth.ts'
import type { ExplicitMemoryTurnResult } from '../src/kernel/app/memory/explicit-turn.ts'

// ---------------------------------------------------------------------------
// 断言底座
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
const failures: string[] = []
function check(id: string, name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${id} ${name}`)
  } else {
    failed += 1
    failures.push(`${id} ${name}${detail === '' ? '' : ` :: ${detail}`}`)
    console.log(`  ❌ ${id} ${name} :: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// 合成底座：候选 / 内容 / 事件
// ---------------------------------------------------------------------------
const OWNER: EntityRef = entityRef('character', 'char_m91test')
const SUBJECT: EntityRef = entityRef('user', 'user_m91test')
const T0: Timestamp = 1_800_000_000_000
const registry = createFullDomainEventRegistry()

function claimContent(value: string): ClaimMemoryContent {
  return { kind: 'claim', subject: SUBJECT, predicate: 'preference.explanation_style', value }
}

function candidate(eventId: string, value = 'detailed', validFrom?: Timestamp): MemoryCandidate {
  const evidence = conversationEvidence(eventId)
  return createMemoryCandidate({
    owner: OWNER,
    type: 'preference',
    content: claimContent(value),
    subjects: [SUBJECT],
    sourceRefs: [evidence],
    evidenceRootIds: [evidence.id],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.8,
    confidence: 0.9,
    ...(validFrom !== undefined ? { proposedValidFrom: validFrom } : {}),
    processor: 'm91-test',
    processorVersion: 'm91-test@1',
  })
}

/** 首版记录（作为 reducer 测试的 state 基底） */
function firstRecord(eventId: string): MemoryRecord {
  return recordFromCandidate({
    candidate: candidate(eventId),
    content: claimContent('detailed'),
    recordedAt: T0,
  })
}

/** 最小事件信封（reducer 只读 type/payload/createdAt/sequence） */
function mkEvent(
  payload: MemoryCreatedPayload,
  sequence: number,
  createdAt: Timestamp
): DomainEvent {
  return {
    id: `dev_m91_${String(sequence)}` as never,
    characterId: 'char_m91test' as never,
    sequence,
    type: MEMORY_CREATED,
    sourceConversationEventIds: [`cev_${String(sequence)}` as never],
    payload,
    processor: 'm91-test',
    processorVersion: 'm91-test@1',
    idempotencyKey: `m91-test:${String(sequence)}`,
    schemaVersion: 1,
    createdAt,
    scope: 'CHARACTER_INTERNAL',
  } as unknown as DomainEvent
}

/** 经 registry 契约校验构造合法 CREATE payload（与生产同一处） */
function createdPayload(input: {
  record: MemoryRecord
  restatement?: { previousRevision: number; previousStatus: 'retracted' | 'superseded' }
}): MemoryCreatedPayload {
  const spec = registry.get(MEMORY_CREATED)
  if (spec === undefined) throw new Error('MEMORY_CREATED 未登记')
  return spec.validatePayload({
    memoryId: String(input.record.id),
    record: input.record,
    mutation: 'explicit',
    ...(input.restatement !== undefined ? { restatement: input.restatement } : {}),
  }) as MemoryCreatedPayload
}

// ===========================================================================
console.log('\n=== M9.1 纯函数与状态机门（m9.1:test） ===')

// ---------------------------------------------------------------------------
console.log('\n--- §1 reducer 三分支（D05，reduceMemory 纯函数） ---')
// ---------------------------------------------------------------------------
{
  const base = firstRecord('cev_a1')
  const retracted: MemoryRecord = { ...base, status: 'retracted', revision: 2 }
  const superseded: MemoryRecord = {
    ...base,
    status: 'superseded',
    revision: 3,
    validUntil: T0 + 100,
    supersededBy: 'mem:other:xyz' as never,
  }
  const disputed: MemoryRecord = { ...base, status: 'disputed', revision: 2 }
  const active: MemoryRecord = { ...base, status: 'active', revision: 1 }

  /* T1.1 null + 无标记 → 首次创建 */
  const p11 = createdPayload({ record: base })
  const r11 = reduceMemory(null, mkEvent(p11, 1, T0))
  check(
    'T1.1',
    'null + 无标记 → 首次创建（revision=1, changed）',
    r11.record !== null && r11.record.status === 'active' && r11.record.revision === 1 && r11.changed,
    `status=${String(r11.record?.status)} revision=${String(r11.record?.revision)} changed=${String(r11.changed)}`
  )

  /* T1.2 retracted + 匹配标记 → 复活采纳 */
  const revival = revivalRecordFromCandidate({
    candidate: candidate('cev_a3', 'detailed', T0 + 300),
    content: claimContent('detailed'),
    recordedAt: T0 + 300,
    previousRevision: 2,
  })
  const p12 = createdPayload({
    record: revival,
    restatement: { previousRevision: 2, previousStatus: 'retracted' },
  })
  const r12 = reduceMemory(retracted, mkEvent(p12, 3, T0 + 300))
  check(
    'T1.2',
    'retracted + 匹配标记 → 复活（active, revision=prev+1, updatedAt=事件时刻）',
    r12.changed &&
      r12.record !== null &&
      r12.record.status === 'active' &&
      r12.record.revision === 3 &&
      r12.record.updatedAt === T0 + 300,
    `status=${String(r12.record?.status)} revision=${String(r12.record?.revision)} changed=${String(r12.changed)}`
  )
  /* 时间字段纪律（R08 第二处修正）：recordedAt/createdAt 是记录身份的最初时刻，
     复活保留原值（store 更新路径不写这两列——A==B 要求）；新告知时刻由 validFrom 承载 */
  check(
    'T1.2c',
    '复活保留 recordedAt/createdAt 原值（身份时刻不可变）；validFrom=新告知时刻',
    r12.record !== null &&
      r12.record.recordedAt === base.recordedAt &&
      r12.record.createdAt === base.createdAt &&
      r12.record.validFrom === T0 + 300,
    `recordedAt=${String(r12.record?.recordedAt)}（原=${String(base.recordedAt)}） validFrom=${String(r12.record?.validFrom)}`
  )
  /* 复活快照的来源是新的（R06 半边：不携带旧来源） */
  check(
    'T1.2b',
    '复活态 sourceRefs = 新告知（cev_a3），validUntil/supersededBy 清空',
    r12.record !== null &&
      r12.record.sourceRefs.length === 1 &&
      r12.record.sourceRefs[0]?.id === 'cev_a3' &&
      r12.record.validUntil === null &&
      r12.record.supersededBy === undefined,
    `refs=${String(r12.record?.sourceRefs.map((r) => r.id))} validUntil=${String(r12.record?.validUntil)} supersededBy=${String(r12.record?.supersededBy)}`
  )

  /* T1.3 revision 是复活基数，不是守卫（R08 实现期修正）：
     过期 previousRevision + 状态匹配 ⇒ 仍复活，revision 以标记为基。
     （在线侧 store 会以 current.revision+1 覆盖；重放侧用标记值——revision 不参与 A==B 比对。） */
  const p13 = createdPayload({
    record: revival,
    restatement: { previousRevision: 7, previousStatus: 'retracted' },
  })
  const r13 = reduceMemory(retracted, mkEvent(p13, 3, T0 + 300))
  check(
    'T1.3',
    'retracted + 状态匹配标记（previousRevision=7≠2）→ 仍复活（revision=标记基+1）',
    r13.changed &&
      r13.record !== null &&
      r13.record.status === 'active' &&
      r13.record.revision === 8,
    `changed=${String(r13.changed)} revision=${String(r13.record?.revision)}`
  )

  /* T1.4 retracted + 无标记 → no-op（旧语义逐字节不变） */
  const p14 = createdPayload({ record: base })
  const r14 = reduceMemory(retracted, mkEvent(p14, 3, T0 + 300))
  check(
    'T1.4',
    'retracted + 无标记 → no-op（旧语义）',
    !r14.changed && r14.record === retracted,
    `changed=${String(r14.changed)}`
  )

  /* T1.5 superseded + 匹配标记 → 复活（D11） */
  const revivalS = revivalRecordFromCandidate({
    candidate: candidate('cev_a4', 'detailed', T0 + 400),
    content: claimContent('detailed'),
    recordedAt: T0 + 400,
    previousRevision: 3,
  })
  const p15 = createdPayload({
    record: revivalS,
    restatement: { previousRevision: 3, previousStatus: 'superseded' },
  })
  const r15 = reduceMemory(superseded, mkEvent(p15, 4, T0 + 400))
  check(
    'T1.5',
    'superseded + 匹配标记 → 复活（validUntil/supersededBy 清空）',
    r15.changed &&
      r15.record !== null &&
      r15.record.status === 'active' &&
      r15.record.revision === 4 &&
      r15.record.validUntil === null &&
      r15.record.supersededBy === undefined,
    `status=${String(r15.record?.status)} revision=${String(r15.record?.revision)}`
  )

  /* T1.6 disputed + 伪造标记 → no-op（D10：DISPUTED 不自动复活） */
  const p16 = createdPayload({
    record: revival,
    restatement: { previousRevision: 2, previousStatus: 'retracted' },
  })
  const r16 = reduceMemory(disputed, mkEvent(p16, 3, T0 + 300))
  check(
    'T1.6',
    'disputed + 伪造标记 → no-op（D10）',
    !r16.changed && r16.record === disputed,
    `changed=${String(r16.changed)}`
  )

  /* T1.7 active + 伪造标记 → no-op（D14：第二个重述落在 active 上不重复复活） */
  const r17 = reduceMemory(active, mkEvent(p16, 3, T0 + 300))
  check(
    'T1.7',
    'active + 标记（previousStatus=retracted 不匹配）→ no-op（D14）',
    !r17.changed && r17.record === active,
    `changed=${String(r17.changed)}`
  )

  /* T1.8 previousStatus 与状态不一致 → no-op（形状守卫，双保险） */
  const p18 = createdPayload({
    record: revival,
    restatement: { previousRevision: 2, previousStatus: 'superseded' },
  })
  const r18 = reduceMemory(retracted, mkEvent(p18, 3, T0 + 300))
  check(
    'T1.8',
    'retracted + previousStatus=superseded（不一致）→ no-op',
    !r18.changed && r18.record === retracted,
    `changed=${String(r18.changed)}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n--- §2 复活快照字段语义（D04，revivalRecordFromCandidate） ---')
// ---------------------------------------------------------------------------
{
  const c = candidate('cev_new_telling', 'detailed', T0 + 500)
  const record = revivalRecordFromCandidate({
    candidate: c,
    content: claimContent('detailed'),
    recordedAt: T0 + 500,
    previousRevision: 5,
  })
  check(
    'T2.1',
    'revision=previous+1；validFrom=告知时刻；validUntil=null；supersededBy 缺席；status=active',
    record.revision === 6 &&
      record.validFrom === T0 + 500 &&
      record.validUntil === null &&
      record.supersededBy === undefined &&
      record.status === 'active' &&
      record.sourceRefs[0]?.id === 'cev_new_telling' &&
      record.reducerVersion === MEMORY_REDUCER_VERSION,
    `revision=${String(record.revision)} validFrom=${String(record.validFrom)} reducer=${String(record.reducerVersion)}`
  )
  /* 对照：首版快照 revision=1（两构造器只差这一个字段——D04 的最小性） */
  const first = recordFromCandidate({ candidate: c, content: claimContent('detailed'), recordedAt: T0 + 500 })
  const { revision: _r, ...firstWithoutRevision } = first
  const { revision: _r2, ...revivalWithoutRevision } = record
  check(
    'T2.2',
    '与首版快照逐字段一致（除 revision）——复活不引入半新半旧合并态',
    JSON.stringify(firstWithoutRevision) === JSON.stringify(revivalWithoutRevision),
    'diff 应为空'
  )
}

// ---------------------------------------------------------------------------
console.log('\n--- §3 registry 放行（D02：标记逐字段保留 + 非法形状拒绝） ---')
// ---------------------------------------------------------------------------
{
  const base = firstRecord('cev_b1')
  const revival = revivalRecordFromCandidate({
    candidate: candidate('cev_b2'),
    content: claimContent('detailed'),
    recordedAt: T0,
    previousRevision: 2,
  })

  /* T3.1 带标记 → 放行且逐字段保留 */
  const p31 = createdPayload({
    record: revival,
    restatement: { previousRevision: 2, previousStatus: 'retracted' },
  })
  check(
    'T3.1',
    '带标记 → 放行且标记逐字段保留',
    p31.restatement !== undefined &&
      p31.restatement.previousRevision === 2 &&
      p31.restatement.previousStatus === 'retracted',
    `restatement=${JSON.stringify(p31.restatement)}`
  )

  /* T3.2 无标记 → 无标记（缺席语义） */
  const p32 = createdPayload({ record: base })
  check('T3.2', '无标记 → 放行且无标记', p32.restatement === undefined, `restatement=${JSON.stringify(p32.restatement)}`)

  /* T3.3-T3.5 非法形状拒绝 */
  const spec = registry.get(MEMORY_CREATED)
  if (spec === undefined) throw new Error('MEMORY_CREATED 未登记')
  const rejects: Array<[string, unknown, string]> = [
    ['T3.3', { previousRevision: 0, previousStatus: 'retracted' }, 'previousRevision=0'],
    ['T3.4', { previousRevision: 2, previousStatus: 'disputed' }, "previousStatus='disputed'（D10）"],
    ['T3.5', { previousRevision: 2, previousStatus: 'active' }, "previousStatus='active'"],
  ]
  for (const [id, bad, why] of rejects) {
    let threw = false
    try {
      spec.validatePayload({
        memoryId: String(base.id),
        record: revival,
        mutation: 'explicit',
        restatement: bad,
      })
    } catch {
      threw = true
    }
    check(id, `非法标记（${why}）→ 拒绝`, threw, threw ? '' : '未拒绝')
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- §4 translate 新映射（D09） ---')
// ---------------------------------------------------------------------------
{
  const okDispute: ExplicitMemoryOutcome = {
    ok: true,
    intent: 'remember',
    memoryId: 'mem:x:1' as never,
    record: firstRecord('cev_c1'),
    domainEventId: 'dev_c1',
    authoritative: true,
    performed: 'dispute',
  }
  const t41 = translate(okDispute, '记住，技术问题我喜欢详细解释')
  check(
    'T4.1',
    "ok + performed:'dispute' → not_written + marked_disputed（无成功口吻）",
    t41.kind === 'not_written' && t41.reason === 'marked_disputed' && !t41.summary.includes('已经完成'),
    `kind=${String(t41.kind)} reason=${String((t41 as { reason?: string }).reason)}`
  )

  const okPlain: ExplicitMemoryOutcome = {
    ok: true,
    intent: 'remember',
    memoryId: 'mem:x:2' as never,
    record: firstRecord('cev_c2'),
    domainEventId: 'dev_c2',
    authoritative: true,
  }
  const t42 = translate(okPlain, '记住，技术问题我喜欢详细解释')
  check(
    'T4.2',
    'ok（无 performed）→ written（既有语义不变）',
    t42.kind === 'written',
    `kind=${String(t42.kind)}`
  )

  const failWne: ExplicitMemoryOutcome = {
    ok: false,
    intent: 'remember',
    reason: 'write_not_effective',
    detail: '…',
  }
  const t43 = translate(failWne, '记住，技术问题我喜欢详细解释')
  check(
    'T4.3',
    'fail:write_not_effective → not_written + 原因透传',
    t43.kind === 'not_written' && t43.reason === 'write_not_effective',
    `kind=${String(t43.kind)} reason=${String((t43 as { reason?: string }).reason)}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n--- §5 response-truth（D08/D09 的 truthfulSentence + executed） ---')
// ---------------------------------------------------------------------------
{
  const notWrittenDisputed: ExplicitMemoryTurnResult = {
    kind: 'not_written',
    intent: 'remember',
    reason: 'marked_disputed',
    summary: '…',
  }
  const o51 = applyResponseTruthPolicy({
    result: notWrittenDisputed,
    replyText: '好的，我已经记住了！',
  })
  check(
    'T5.1',
    'marked_disputed + 成功口吻 → 纠正 + executed=false + 新如实句',
    o51.corrected &&
      o51.executed === false &&
      o51.replyText.includes('存疑') &&
      !o51.replyText.includes('记住了'),
    `corrected=${String(o51.corrected)} executed=${String(o51.executed)} reply=${o51.replyText.slice(0, 40)}…`
  )

  const notWrittenWne: ExplicitMemoryTurnResult = {
    kind: 'not_written',
    intent: 'remember',
    reason: 'write_not_effective',
    summary: '…',
  }
  const o52 = applyResponseTruthPolicy({
    result: notWrittenWne,
    replyText: '记住了，放心吧',
  })
  check(
    'T5.2',
    'write_not_effective + 成功口吻 → 纠正 + executed=false + 新如实句',
    o52.corrected &&
      o52.executed === false &&
      o52.replyText.includes('没能') &&
      !o52.replyText.includes('记住了'),
    `corrected=${String(o52.corrected)} executed=${String(o52.executed)}`
  )

  const o53 = applyResponseTruthPolicy({
    result: notWrittenDisputed,
    replyText: '这条和已有的说法对不上，我先标成存疑了。',
  })
  check(
    'T5.3',
    'marked_disputed + 无成功口吻 → 不替换（如实回复原样通过）',
    !o53.corrected && o53.executed === false,
    `corrected=${String(o53.corrected)}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n--- §6 混合流重放兼容（R07 纯函数半边） ---')
// ---------------------------------------------------------------------------
{
  /*
   * 流：CREATE(旧形, rev1) → RETRACTED → CREATE(旧形, 历史 no-op) → CREATE(带标记)
   * 新代码：前三个事件原解释（retracted），第四个复活（active）。
   * 旧代码模拟 = 同流去掉标记（旧 reducer 不读 restatement ⇒ 与剥离标记等价）：
   * 四个事件全部原解释（retracted）——兼容边界的可执行证明。
   */
  const base = firstRecord('cev_d1')
  const retracted: MemoryRecord = { ...base, status: 'retracted', revision: 2 }
  const revival = revivalRecordFromCandidate({
    candidate: candidate('cev_d4', 'detailed', T0 + 400),
    content: claimContent('detailed'),
    recordedAt: T0 + 400,
    previousRevision: 2,
  })

  const pOld1 = createdPayload({ record: base })
  const pOld2 = createdPayload({ record: base })
  const pNew = createdPayload({
    record: revival,
    restatement: { previousRevision: 2, previousStatus: 'retracted' },
  })

  /* 新代码：整流重放（从 null 开始，模拟 rebuild） */
  let state: MemoryRecord | null = null
  state = reduceMemory(state, mkEvent(pOld1, 1, T0)).record
  const afterCreate = state
  state = reduceMemory(state, mkEvent(pOld2, 2, T0 + 100)).record // RETRACTED 用状态近似
  // 直接构造 retracted 态（RETRACTED 事件由生产路径产出；这里用字段近似其效果）
  const retractedState: MemoryRecord = { ...(afterCreate ?? base), status: 'retracted', revision: 2 }
  const rNew = reduceMemory(retractedState, mkEvent(pOld2, 3, T0 + 200))
  const rNewFinal = reduceMemory(rNew.record ?? retractedState, mkEvent(pNew, 4, T0 + 400))
  check(
    'T6.1',
    '新代码：旧形 CREATE 在 retracted 上 → no-op（历史不被重解释）',
    !rNew.changed && rNew.record === retractedState,
    `changed=${String(rNew.changed)}`
  )
  check(
    'T6.2',
    '新代码：带标记 CREATE → 复活（active, revision=prev+1）',
    rNewFinal.changed &&
      rNewFinal.record !== null &&
      rNewFinal.record.status === 'active' &&
      rNewFinal.record.revision === 3,
    `status=${String(rNewFinal.record?.status)} revision=${String(rNewFinal.record?.revision)}`
  )

  /* 旧代码模拟：剥离标记后同流重放 → 全部原解释（retracted 终态） */
  const stripped = { ...pNew, restatement: undefined } as MemoryCreatedPayload
  const rOld = reduceMemory(retractedState, mkEvent(stripped, 4, T0 + 400))
  check(
    'T6.3',
    '旧代码模拟（剥离标记）：同流 → no-op，终态 retracted（兼容边界）',
    !rOld.changed && rOld.record === retractedState,
    `changed=${String(rOld.changed)} status=${String(rOld.record?.status)}`
  )
}

// ---------------------------------------------------------------------------
// §7 撤销遮蔽纯函数（F-1 / ADR-072 D18；契约 §4 的 m9.1:test 半边）
// ---------------------------------------------------------------------------
{
  const line = (over: Record<string, unknown> & { id: string; sequence: number }): ConversationLine =>
    ({ speaker: '用户', text: '占位前原话', ...over }) as ConversationLine

  /* T7.1 user 行命中：id ∈ 撤销集 ⇒ 换占位；id/sequence/actorType 不变（占位不删除） */
  const u1 = line({ id: 'cev_1', sequence: 1, actorType: 'user', text: '记住，技术问题我喜欢详细解释' })
  const u2 = line({ id: 'cev_2', sequence: 2, actorType: 'user', text: '忘掉技术问题详细解释那个偏好' })
  const m1 = maskWithdrawnLines([u1, u2], new Set(['cev_1']))
  check(
    'T7.1',
    'user 行命中 ⇒ 文本换占位，结构字段（id/sequence/actorType）不变',
    m1.maskedCount === 1 &&
      m1.lines.length === 2 &&
      m1.lines[0]!.text === WITHDRAWN_PLACEHOLDER_USER &&
      m1.lines[0]!.id === 'cev_1' &&
      m1.lines[0]!.sequence === 1 &&
      m1.lines[0]!.actorType === 'user' &&
      m1.lines[1]!.text === '忘掉技术问题详细解释那个偏好',
    `masked=${String(m1.maskedCount)} first=${JSON.stringify(m1.lines[0]?.text)}`
  )

  /* T7.2 占位文本不含被撤取值（程序生成，无任何用户内容） */
  check(
    'T7.2',
    '占位文本程序生成：不含被撤取值、不宣称「从未说过」（不伪装历史）',
    !WITHDRAWN_PLACEHOLDER_USER.includes('技术问题') &&
      !WITHDRAWN_PLACEHOLDER_ASSISTANT.includes('技术问题') &&
      !WITHDRAWN_PLACEHOLDER_USER.includes('从未') &&
      !WITHDRAWN_PLACEHOLDER_ASSISTANT.includes('从未'),
    `user占位=${WITHDRAWN_PLACEHOLDER_USER} assistant占位=${WITHDRAWN_PLACEHOLDER_ASSISTANT}`
  )

  /* T7.3 assistant 派生行：replyToEventId ∈ 撤销集 ⇒ 换占位（P03 判定核心） */
  const a1 = line({
    id: 'cev_3',
    sequence: 3,
    actorType: 'character',
    text: '好的，我记住了：技术问题我喜欢详细解释。',
    replyToEventId: 'cev_1' as never,
  })
  const a2 = line({
    id: 'cev_4',
    sequence: 4,
    actorType: 'character',
    text: '这条回复引用的是未被撤的内容。',
    replyToEventId: 'cev_2' as never,
  })
  const m2 = maskWithdrawnLines([a1, a2], new Set(['cev_1']))
  check(
    'T7.3',
    'assistant 行按 replyToEventId 命中 ⇒ 换占位；指向未撤行的 assistant 行原样',
    m2.maskedCount === 1 &&
      m2.lines[0]!.text === WITHDRAWN_PLACEHOLDER_ASSISTANT &&
      m2.lines[1]!.text === '这条回复引用的是未被撤的内容。',
    `masked=${String(m2.maskedCount)} a1=${JSON.stringify(m2.lines[0]?.text)}`
  )

  /* T7.4 不命中：空集 / 无 replyTo 的 assistant 行 / 集合外 id ⇒ 全部原样 */
  const m3 = maskWithdrawnLines([u1, u2, a1, a2], new Set())
  const aNoReply = line({ id: 'cev_5', sequence: 5, actorType: 'character', text: '没有指向的旧回复' })
  const m4 = maskWithdrawnLines([u1, aNoReply], new Set(['cev_9']))
  check(
    'T7.4',
    '空集/集合外 id/无 replyTo 的 assistant 行 ⇒ 原样通过（不误伤）',
    m3.maskedCount === 0 && m3.lines.every((l, i) => l.text === [u1, u2, a1, a2][i]!.text) &&
      m4.maskedCount === 0 && m4.lines[0]!.text === u1.text && m4.lines[1]!.text === aNoReply.text,
    `m3masked=${String(m3.maskedCount)} m4masked=${String(m4.maskedCount)}`
  )

  /* T7.5 缺席字段保守面：无 actorType 的行不按 user 命中（不遮 assistant 冒充） */
  const legacy = line({ id: 'cev_1', sequence: 1, text: '旧格式行（无 actorType）' })
  const m5 = maskWithdrawnLines([legacy], new Set(['cev_1']))
  check(
    'T7.5',
    '无 actorType 的行不命中（保守面：字段缺席 ⇒ 不遮，不猜）',
    m5.maskedCount === 0 && m5.lines[0]!.text === legacy.text,
    `masked=${String(m5.maskedCount)}`
  )
}

// ---------------------------------------------------------------------------
// 汇总 + 证据
// ---------------------------------------------------------------------------
const head = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const dir = join(process.cwd(), 'artifacts', 'm9.1', `test-${date}-${head}`)
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'test.json'),
  JSON.stringify(
    {
      instrument: 'm9.1-test@2',
      kind: 'pure-function-state-machine',
      head,
      date,
      passed,
      failed,
      failures,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
    null,
    2
  ),
  'utf8'
)

console.log(`\n=== 汇总：${String(passed)} 通过 / ${String(failed)} 失败 ===`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log(`证据：${join('artifacts', 'm9.1', `test-${date}-${head}`, 'test.json')}`)
process.exitCode = failed === 0 ? 0 : 1
