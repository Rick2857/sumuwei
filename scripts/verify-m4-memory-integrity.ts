/**
 * M5-PRE / State-Integrity Hotfix —— **回归门**（`pnpm m4:memory-integrity:verify`）。
 *
 * ============================================================================
 *  它测的是什么
 * ============================================================================
 * `resetKernelData`（`--reset-kernel`）删掉 `conversation_events` 与由它们派生的
 * `character_domain_events`，但**没有**清理记忆侧的关联行。于是会留下：
 *
 *     memory_records         行还在（status = active）
 *     memory_evidence_links  指向已不存在的对话事件
 *     memory_events          指向已不存在的领域事件
 *     → rebuildMemory()      得到 after = null / equal = false
 *     → unsupportedMemories() 仍然报 0（它只数 link 行）
 *
 * 这就是 WP0 之后查出的候选 BLOCKING DEFECT（用户 2026-09-17 裁定：**必须解决，
 * 且阻塞 M5**）。本文件是它的 reproduction + 回归锁。
 *
 * ---------------------------------------------------------------------------
 *  四条用例（正控 + 负控 + 量具自检）—— 缺一不可
 * ---------------------------------------------------------------------------
 *   ① 单证据记忆 + reset 该会话      → 记忆必须被**整条**清理，不许留悬空行
 *   ② 双证据（两个会话）+ 只 reset 一个 → 记忆必须**保留**，只删失效的那条 link
 *                                     （判据是 liveEvidenceCountAfterReset，
 *                                      不是 wasAnyEvidenceDeleted）
 *   ③ 量具负控：手工制造一条悬空 link → 新探针必须报出来，
 *                                     而旧探针 `unsupportedMemories` 报 0
 *                                     （证明"它量不到"这件事本身是可被测的）
 *   ④ 干净库                        → 两个探针都必须报 0（防"永远报警"的假阳性）
 *
 * 安全：全部在 `isolateDatabase()` 的一次性沙箱库上；不碰真实库、不调模型。
 *
 * 跑法：pnpm m4:memory-integrity:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import type { M4Harness } from './m4-harness.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { rebuildMemory, unsupportedMemories } from '../src/infrastructure/persistence/memory-store.ts'
import { resetKernelData } from '../src/infrastructure/persistence/event-store.ts'
import type { CharacterId, ConversationId } from '../src/kernel/contracts/index.ts'

/**
 * 探针（量具）的断言形状。
 *
 * ⚠️ 刻意**本地声明**而不是 import 生产类型：这份测试要能在"量具还不存在"的
 * 状态下跑出**行为红**（先写失败测试），因此探针用动态 import 获取 ——
 * 缺了它应该是一条**失败项**，不是 import 崩。
 * 而"我断言的是哪三个数字"本身就该写在测试里。
 */
interface Probe {
  danglingEvidenceLinks: unknown[]
  danglingMemoryEvents?: unknown[]
  memoriesWithoutLiveEvidence: { memoryId: string }[]
  memoriesWithoutLiveEvents: { memoryId: string }[]
}

async function probeOf(h: M4Harness): Promise<Probe | null> {
  const mod = (await import('../src/infrastructure/persistence/memory-integrity.ts')) as unknown as {
    memoryIntegrityProblems?: (db: unknown, owner: unknown) => Promise<Probe>
  }
  if (typeof mod.memoryIntegrityProblems !== 'function') return null
  return await mod.memoryIntegrityProblems(h.db, h.owner)
}

const report = createReporter()
const evidenceDir = join(process.cwd(), 'artifacts', 'm5', 'pre')

console.log('='.repeat(72))
console.log('M5-PRE / Memory State Integrity（resetKernelData 的孤儿记忆回归门）')
console.log('='.repeat(72))

interface Scenario {
  label: string
  sandbox: ReturnType<typeof isolateDatabase>
  h: M4Harness
  dispose: () => Promise<void>
}

async function openScenario(label: string): Promise<Scenario> {
  const sandbox = isolateDatabase(`m5pre-${label}`, { keep: false })
  await resetPluginSqlConnection()
  const h = await createM4Harness({ label: `m5pre-${label}` })
  return {
    label,
    sandbox,
    h,
    dispose: async () => {
      await h.stop()
      cleanupSandbox(sandbox.dir)
    },
  }
}

const num = async (h: M4Harness, query: ReturnType<typeof sql>): Promise<number> => {
  const rows = await exec(h.db, query, 'integrity count')
  return Number(rows[0]?.c ?? -1)
}

const conversationsOf = async (h: M4Harness): Promise<string[]> => {
  const rows = await exec(
    h.db,
    sql`select distinct conversation_id from conversation_events where character_id = ${h.characterId}`,
    '会话清单'
  )
  return rows.map((r) => String(r.conversation_id))
}

/** 某个会话里的对话事件总数 */
const eventCountOfConversation = async (h: M4Harness, conversationId: string): Promise<number> =>
  num(
    h,
    sql`select count(*)::int as c from conversation_events
        where character_id = ${h.characterId} and conversation_id = ${conversationId}`
  )

/** 证据 link 里指向"已不存在的对话事件"的行数（只读判据，与被测实现无关） */
const danglingLinkCount = async (h: M4Harness): Promise<number> =>
  num(
    h,
    sql`select count(*)::int as c
        from memory_evidence_links l
        left join conversation_events e on e.id = l.evidence_id
        where l.evidence_kind = 'conversation_event' and e.id is null`
  )

/** `memory_events` 里指向"已不存在的领域事件"的行数 */
const danglingEventRowCount = async (h: M4Harness): Promise<number> =>
  num(
    h,
    sql`select count(*)::int as c
        from memory_events me
        left join character_domain_events e on e.id = me.domain_event_id
        where e.id is null`
  )

const linkRowsFor = async (h: M4Harness, memoryId: string): Promise<number> =>
  num(
    h,
    sql`select count(*)::int as c from memory_evidence_links where memory_id = ${memoryId}`
  )

const subjectRowsFor = async (h: M4Harness, memoryId: string): Promise<number> =>
  num(h, sql`select count(*)::int as c from memory_subject_links where memory_id = ${memoryId}`)

const eventRowsFor = async (h: M4Harness, memoryId: string): Promise<number> =>
  num(h, sql`select count(*)::int as c from memory_events where memory_id = ${memoryId}`)

const cilantroCandidate = (h: M4Harness, evidenceIds: string[], value = 'dislike') =>
  h.makeCandidate(
    'preference',
    { kind: 'claim', subject: h.user, predicate: 'food.preference.cilantro', value },
    {
      sourceRefs: evidenceIds.map((id) => ({ kind: 'conversation_event' as const, id })),
    }
  )

const results: Record<string, unknown> = {}

// ===========================================================================
report.section('① 单证据记忆 + reset 该会话 → 记忆必须被整条清理')
// ===========================================================================
{
  const s = await openScenario('case1')
  const { h } = s
  const evidence = await h.recordUserEvidence('我不吃香菜')
  const record = await h.commitAndFold(cilantroCandidate(h, [evidence.ref.id]), M4_T0)
  if (record === null) throw new Error('场景① 失败：记忆没有建立')
  const memoryId = String(record.id)

  // 前置条件：reset 之前，这条记忆是自洽的（否则后面的红没有意义）
  const before = await rebuildMemory(h.db, record.id)
  report.check('前置：reset 前 rebuildMemory equal = true', before.equal === true,
    `equal=${before.equal} 差异=${before.differences.join(',') || '无'}`)

  const conversations = await conversationsOf(h)
  const reset = await resetKernelData(h.db, {
    characterId: h.characterId as unknown as CharacterId,
    conversationIds: conversations,
    projectionTypes: [],
  })

  const survivor = await h.store.get(record.id)
  report.check(
    '记忆行被整条清理（不是留下一条 active 的孤儿）',
    survivor === null,
    survivor === null ? '' : `仍然存在：status=${survivor.status}`
  )
  /*
   * 这条才是**不变量**的形状（用户的预期红之一：rebuildMemory.equal == false）：
   *    记忆行不存在            —— 允许（被 reset 清理掉了）
   *    或者 它仍然满足 A == B  —— 允许
   *    行还在、但事件流已空    —— **禁止**（那就是孤儿）
   */
  const replay = await rebuildMemory(h.db, record.id)
  report.check(
    '不变量：记忆行不存在，或者它仍然 A == B',
    survivor === null || replay.equal === true,
    `行存在=${survivor !== null} equal=${replay.equal} 差异=${replay.differences.join(',') || '无'}`
  )
  report.check('它的 evidence link 被清理', (await linkRowsFor(h, memoryId)) === 0)
  report.check('它的 subject link 被清理', (await subjectRowsFor(h, memoryId)) === 0)
  report.check('它的 memory_events 行被清理', (await eventRowsFor(h, memoryId)) === 0)
  report.check('全库 dangling_evidence_links = 0', (await danglingLinkCount(h)) === 0)
  report.check('全库 dangling_memory_events = 0', (await danglingEventRowCount(h)) === 0)
  const probe = await probeOf(h)
  report.check(
    '探针报告 0 孤儿 / 0 悬空',
    probe !== null &&
      probe.danglingEvidenceLinks.length === 0 &&
      probe.memoriesWithoutLiveEvidence.length === 0 &&
      probe.memoriesWithoutLiveEvents.length === 0,
    probe === null
      ? '探针尚未实现（memoryIntegrityProblems）'
      : JSON.stringify({
          dangling: probe.danglingEvidenceLinks.length,
          orphans: probe.memoriesWithoutLiveEvidence.length,
          noEvents: probe.memoriesWithoutLiveEvents.length,
        })
  )
  report.check(
    'reset 返回值报告了被清理的记忆数',
    typeof (reset as { memoryRecords?: number }).memoryRecords === 'number' &&
      Number((reset as { memoryRecords?: number }).memoryRecords) >= 1,
    `memoryRecords=${String((reset as { memoryRecords?: number }).memoryRecords)}`
  )

  results['case1'] = { memoryId, reset, survivor: survivor === null ? null : survivor.status }
  await s.dispose()
}

// ===========================================================================
report.section('②a 双证据 + 事件流存活 → 记忆保留（失效的 link **刻意保留**，见下）')
// ===========================================================================
{
  const s = await openScenario('case2a')
  const { h } = s

  /*
   * 形状很讲究（这正是"不能整条误删"的判据所在）：
   *
   *   sourceRefs[0] 决定领域事件的 primary_source_event_id
   *   → 把**会存活**的会话 B 放在第一位，把**会被 reset** 的会话 A 放在第二位
   *   → reset A 时：事件流不动，只有 A 那条证据失效
   *
   * 若顺序反过来，reset A 会连事件流一起删掉 —— 那是 ②b 的场景，必须整条清。
   */
  const secondConversation = 'dm-m5pre-second-a' as ConversationId
  const appendedB = await appendConversationEvent(h.db, {
    characterId: h.characterId as unknown as CharacterId,
    conversationId: secondConversation,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    content: '我不吃香菜（会话 B 的那次）',
  })

  // 会话 A：经由真实 recorder（它与真实对话同一条路）
  const evidenceA = await h.recordUserEvidence('我不吃香菜（会话 A 的那次）')
  const conversationA = (await conversationsOf(h)).find((id) => id !== secondConversation)!

  const record = await h.commitAndFold(
    cilantroCandidate(h, [String(appendedB.event.id), evidenceA.ref.id]),
    M4_T0
  )
  if (record === null) throw new Error('场景②a 失败：双证据记忆没有建立')
  const memoryId = String(record.id)

  report.check(
    '前置：建立了跨两个会话的双证据记忆',
    (await linkRowsFor(h, memoryId)) === 2,
    `link 行 = ${await linkRowsFor(h, memoryId)}`
  )

  await resetKernelData(h.db, {
    characterId: h.characterId as unknown as CharacterId,
    conversationIds: [conversationA],
    projectionTypes: [],
  })

  const survivor = await h.store.get(record.id)
  report.check(
    '记忆**保留**（仍有活证据与活事件流 —— 不许因为失效一条证据就整条删）',
    survivor !== null,
    survivor === null ? '被误删了' : `status=${survivor.status}`
  )
  report.check(
    '幸存记忆仍然 A == B（不能让步的那条 —— 比"悬空清零"更硬）',
    (await rebuildMemory(h.db, record.id)).equal === true
  )
  report.check(
    '会话 B 那条证据仍然在（记忆真的还站得住，不是空壳）',
    (await num(
      h,
      sql`select count(*)::int as c from memory_evidence_links
          where memory_id = ${memoryId} and evidence_id = ${String(appendedB.event.id)}`
    )) === 1,
    `link 行 = ${await linkRowsFor(h, memoryId)}`
  )
  /*
   * ⚠️ 这一条断言的是**一个刻意保留的缺点**，不是理想状态：
   *    指向已删会话的 evidence link 被**保留**了（因为删它会让 sourceRefs
   *    与事件 payload 不一致 → 破 MI-11）。探针必须把它报出来，
   *    但**不能**把这条记忆算成孤儿。要让它也归零，需要"为证据移除写事件"
   *    （新增事件类型 + reducer + 迁移），那超出本次 Hotfix 的 Scope —— 记为 D-9。
   */
  report.check(
    '指向已删会话的 evidence link 被**保留**（删它会破 A==B）—— 悬空数 = 1',
    (await danglingLinkCount(h)) === 1,
    `实际 dangling = ${await danglingLinkCount(h)}`
  )
  const probeAfter = await probeOf(h)
  report.check(
    '但它**不是孤儿**：探针不把它算进 memoriesWithoutLiveEvidence',
    probeAfter !== null &&
      probeAfter.danglingEvidenceLinks.length === 1 &&
      probeAfter.memoriesWithoutLiveEvidence.length === 0,
    probeAfter === null
      ? '探针尚未实现'
      : JSON.stringify({
          dangling: probeAfter.danglingEvidenceLinks.length,
          orphans: probeAfter.memoriesWithoutLiveEvidence.length,
        })
  )
  report.check('全库 dangling_memory_events = 0', (await danglingEventRowCount(h)) === 0)
  report.check(
    '被 reset 会话的事件确实没了（否则场景② 是空过）',
    (await eventCountOfConversation(h, conversationA)) === 0
  )

  results['case2a'] = {
    memoryId,
    survivor: survivor === null ? null : survivor.status,
    remainingLinks: await linkRowsFor(h, memoryId),
    danglingAfterReset: await danglingLinkCount(h),
  }
  await s.dispose()
}

// ===========================================================================
report.section('②b 证据还有活的、但**事件流被删** → 必须整条清（否则不可 replay）')
// ===========================================================================
{
  const s = await openScenario('case2b')
  const { h } = s

  // 与 ②a 同一个形状，但**顺序反过来**：primary 落在会被 reset 的会话 A 上
  const secondConversation = 'dm-m5pre-second-b' as ConversationId
  const appendedB = await appendConversationEvent(h.db, {
    characterId: h.characterId as unknown as CharacterId,
    conversationId: secondConversation,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    content: '我不吃香菜（会话 B 的那次）',
  })
  const evidenceA = await h.recordUserEvidence('我不吃香菜（会话 A 的那次）')
  const conversationA = (await conversationsOf(h)).find((id) => id !== secondConversation)!

  const record = await h.commitAndFold(
    cilantroCandidate(h, [evidenceA.ref.id, String(appendedB.event.id)]),
    M4_T0
  )
  if (record === null) throw new Error('场景②b 失败：双证据记忆没有建立')
  const memoryId = String(record.id)

  await resetKernelData(h.db, {
    characterId: h.characterId as unknown as CharacterId,
    conversationIds: [conversationA],
    projectionTypes: [],
  })

  const survivor = await h.store.get(record.id)
  report.check(
    '事件流被删的记忆被整条清（保留一条 live 证据也不够 —— MI-11 要求可 replay）',
    survivor === null,
    survivor === null ? '' : `仍然存在：status=${survivor.status}`
  )
  report.check('它不再留下任何悬空行', (await danglingLinkCount(h)) === 0 &&
    (await danglingEventRowCount(h)) === 0)
  report.check('全库没有"无活事件流"的记忆', (await num(
    h,
    sql`select count(*)::int as c from memory_records r
        where not exists (select 1 from memory_events me
                          join character_domain_events e on e.id = me.domain_event_id
                          where me.memory_id = r.id)`
  )) === 0)

  results['case2b'] = { memoryId, survivor: survivor === null ? null : survivor.status }
  await s.dispose()
}

// ===========================================================================
report.section('③ 量具负控：手工制造悬空 link → 新探针必须报出来')
// ===========================================================================
{
  const s = await openScenario('case3')
  const { h } = s

  const evidence = await h.recordUserEvidence('我不吃香菜')
  const record = await h.commitAndFold(cilantroCandidate(h, [evidence.ref.id]), M4_T0)
  if (record === null) throw new Error('场景③ 失败：记忆没有建立')

  /*
   * 绕过 resetKernelData，**直接删掉**那条对话事件 ——
   * 模拟"历史遗留的悬空引用"（也就是修复之前 reset 会留下的那种库）。
   * 这是负控，不是产品路径。
   */
  await exec(
    h.db,
    sql`delete from conversation_events where id = ${evidence.ref.id}`,
    '（负控）直接删掉证据事件'
  )

  report.check(
    '前置：悬空 link 确实被制造出来了',
    (await danglingLinkCount(h)) === 1,
    `dangling=${await danglingLinkCount(h)}`
  )

  const probe = await probeOf(h)
  report.check(
    '新探针报告 danglingEvidenceLinks = 1',
    probe !== null && probe.danglingEvidenceLinks.length === 1,
    probe === null ? '探针尚未实现' : `实际 ${probe.danglingEvidenceLinks.length}`
  )
  report.check(
    '新探针报告该记忆已无活证据（孤儿）',
    probe !== null && probe.memoriesWithoutLiveEvidence.some((m) => m.memoryId === String(record.id)),
    probe === null ? '探针尚未实现' : JSON.stringify(probe.memoriesWithoutLiveEvidence)
  )
  const legacy = await unsupportedMemories(h.db, h.owner)
  report.check(
    '旧探针 unsupportedMemories 仍然报 0 —— 它的盲区是**可复现**的',
    legacy.length === 0,
    `旧探针 = ${legacy.length}`
  )

  results['case3'] = {
    dangling: await danglingLinkCount(h),
    newProbe: probe === null ? null : probe.danglingEvidenceLinks.length,
    legacyProbe: legacy.length,
  }
  await s.dispose()
}

// ===========================================================================
report.section('④ 干净库：两个探针都必须报 0（防假阳性）')
// ===========================================================================
{
  const s = await openScenario('case4')
  const { h } = s
  const evidence = await h.recordUserEvidence('我现在上的大学是示例工程科技大学')
  const record = await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      {
        kind: 'claim',
        subject: h.user,
        predicate: 'education.institution',
        value: '示例工程科技大学',
      },
      { sourceRefs: [evidence.ref] }
    ),
    M4_T0
  )
  if (record === null) throw new Error('场景④ 失败：记忆没有建立')

  const probe = await probeOf(h)
  report.check(
    '新探针在干净库上报 0',
    probe !== null &&
      probe.danglingEvidenceLinks.length === 0 &&
      probe.memoriesWithoutLiveEvidence.length === 0 &&
      probe.memoriesWithoutLiveEvents.length === 0,
    probe === null ? '探针尚未实现' : JSON.stringify(probe)
  )
  report.check('旧探针在干净库上报 0', (await unsupportedMemories(h.db, h.owner)).length === 0)
  report.check('干净库的 A==B 成立', (await rebuildMemory(h.db, record.id)).equal === true)

  results['case4'] = { clean: true }
  await s.dispose()
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'memory-integrity.json'),
  `${JSON.stringify({ testId: 'M5-PRE / memory state integrity', results }, null, 2)}\n`,
  'utf8'
)
console.log(`\n证据已写入：artifacts/m5/pre/memory-integrity.json`)

report.finish('M5-PRE Memory State Integrity')
