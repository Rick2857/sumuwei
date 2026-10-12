/**
 * Memory 侧的状态完整性 —— **量具 + 修复**（M5-PRE / State-Integrity Hotfix）。
 *
 * ============================================================================
 *  它为什么存在（一次真实的、审计看不见的库损坏）
 * ============================================================================
 * `resetKernelData`（`--reset-kernel`）删掉 `conversation_events` 与由它们派生的
 * `character_domain_events`，但**没有**清理记忆侧的关联行，于是留下：
 *
 *     memory_records         行还在（status = active）
 *     memory_evidence_links  指向已不存在的对话事件
 *     memory_events          指向已不存在的领域事件
 *     → rebuildMemory()      得到 after = null / equal = false（MI-11 失效）
 *     → MI-03 的实质失效     "证据"指向不存在的行
 *     → unsupportedMemories() 仍然报 0 —— 它只数 link **行数**
 *
 * 用户 2026-09-17 的裁定：**必须解决，且阻塞 M5**。理由不是"用户马上会看到错误行为"，
 * 而是 **Audit Truth ≠ State Truth** —— 一个"状态已经不一致而审计说一切正常"的系统，
 * 会让之后每一个里程碑都在错误前提上开工。
 *
 * ============================================================================
 *  为什么单独一个文件（而不是塞进 memory-store.ts 或 event-store.ts）
 * ============================================================================
 *   · `memory-store.ts` 已经 import `event-store.ts`（`rowToDomainEvent`）。
 *     `resetKernelData` 在 `event-store.ts` 里，若反过来 import memory-store
 *     就形成**循环 import** —— 那种东西在 ESM 下"有时能跑"，正是最难查的一类。
 *   · 两个模块都需要这份逻辑（reset 要清理、audit 要报数），
 *     而"什么算悬空 / 什么算孤儿"只能有**一处**实现（两条实现迟早漂移）。
 *   · 仓库对同一形状已有先例：`memory-recovery.ts` 就是这么放的。
 *
 * 因此：本文件只依赖 `db.ts` 与契约，**谁都可以 import 它，它不 import 任何人**。
 */

import { sql } from 'drizzle-orm'

import { affectedRows, exec, type RawDb } from './db.ts'
import type { CharacterId, EntityRef } from '../../kernel/contracts/index.ts'

/** 目前只有这一种 evidence kind 有"真源表"可以校验存活 */
const VERIFIABLE_EVIDENCE_KIND = 'conversation_event'

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

export interface MemoryIntegrityProblems {
  /** evidence link 指向的对话事件已不存在 */
  danglingEvidenceLinks: { memoryId: string; evidenceId: string }[]
  /** memory_events 行指向的领域事件已不存在 */
  danglingMemoryEvents: { memoryId: string; domainEventId: string }[]
  /** 没有任何**活**证据的记忆（= 孤儿；reset 之后本该被一起清理掉的那种） */
  memoriesWithoutLiveEvidence: { memoryId: string; status: string }[]
  /** 行还在、但事件流已空的记忆 → `rebuildMemory()` 必然 `equal = false` */
  memoriesWithoutLiveEvents: { memoryId: string; status: string }[]
}

/**
 * 记忆完整性探针 —— **状态问题，不是行数问题**。
 *
 * 与 `unsupportedMemories()` 的分工：
 *
 *     unsupportedMemories()      这条记忆**有没有** evidence link 行
 *     memoryIntegrityProblems()  那些 link **还站不站得住**
 *
 * 两者都要报：前者是"从来没写全"，后者是"写全了但后来被删掉了"。
 *
 * ⚠️ "活"的判据是**内连接后计数**（`liveEvidenceCountAfterReset`），
 *    不是"有没有证据被删过"：一条记忆有两条证据、只失效其中一条**不算孤儿**。
 *
 * ⚠️ 只对 `conversation_event` 这类有真源表的 evidence 做存活判断。
 *    一条只持有"暂不可校验种类"证据的记忆**不会被误报**（见下）。
 */
export async function memoryIntegrityProblems(
  db: RawDb,
  owner: EntityRef
): Promise<MemoryIntegrityProblems> {
  const ownerKind = owner.kind
  const ownerId = String(owner.id)

  const danglingEvidence = await exec(
    db,
    sql`select l.memory_id, l.evidence_id
        from memory_evidence_links l
        join memory_records r on r.id = l.memory_id
        left join conversation_events e on e.id = l.evidence_id
        where r.owner_kind = ${ownerKind} and r.owner_id = ${ownerId}
          and l.evidence_kind = ${VERIFIABLE_EVIDENCE_KIND}
          and e.id is null
        order by l.memory_id`,
    '查悬空的 evidence link'
  )

  const danglingEvents = await exec(
    db,
    sql`select me.memory_id, me.domain_event_id
        from memory_events me
        join memory_records r on r.id = me.memory_id
        left join character_domain_events e on e.id = me.domain_event_id
        where r.owner_kind = ${ownerKind} and r.owner_id = ${ownerId}
          and e.id is null
        order by me.memory_id`,
    '查悬空的 memory_events 行'
  )

  /*
   * 孤儿 = "没有任何活证据"，但要**避免误报未来的其它 evidence 种类**：
   *   · 它至少有一条可校验种类的 link（说明它本来靠对话事件成立）→ 判
   *   · 它一条 link 都没有（从来没写全）→ 也判（那是 `unsupportedMemories` 的同类问题）
   *   · 它只有不可校验种类的 link → **不判**（我们无法知道那种证据还在不在）
   */
  const orphans = await exec(
    db,
    sql`select r.id, r.status
        from memory_records r
        where r.owner_kind = ${ownerKind} and r.owner_id = ${ownerId}
          and not exists (
            select 1 from memory_evidence_links l
            join conversation_events e on e.id = l.evidence_id
            where l.memory_id = r.id
              and l.evidence_kind = ${VERIFIABLE_EVIDENCE_KIND}
          )
          and (
            exists (select 1 from memory_evidence_links l2
                    where l2.memory_id = r.id
                      and l2.evidence_kind = ${VERIFIABLE_EVIDENCE_KIND})
            or not exists (select 1 from memory_evidence_links l3 where l3.memory_id = r.id)
          )
        order by r.id`,
    '查没有任何活证据的记忆'
  )

  const noEvents = await exec(
    db,
    sql`select r.id, r.status
        from memory_records r
        where r.owner_kind = ${ownerKind} and r.owner_id = ${ownerId}
          and not exists (
            select 1 from memory_events me
            join character_domain_events e on e.id = me.domain_event_id
            where me.memory_id = r.id
          )
        order by r.id`,
    '查事件流已空的记忆'
  )

  return {
    danglingEvidenceLinks: danglingEvidence.map((row) => ({
      memoryId: String(row.memory_id),
      evidenceId: String(row.evidence_id),
    })),
    danglingMemoryEvents: danglingEvents.map((row) => ({
      memoryId: String(row.memory_id),
      domainEventId: String(row.domain_event_id),
    })),
    memoriesWithoutLiveEvidence: orphans.map((row) => ({
      memoryId: String(row.id),
      status: String(row.status),
    })),
    memoriesWithoutLiveEvents: noEvents.map((row) => ({
      memoryId: String(row.id),
      status: String(row.status),
    })),
  }
}

// ---------------------------------------------------------------------------
// 修复：reset 时把记忆侧一起清干净
// ---------------------------------------------------------------------------

export interface MemorySideCleanup {
  /** 被整条删掉的记忆（reset 之后已无任何活证据 / 活事件流，或丢过自有事件） */
  memoryRecords: number
  memorySubjectLinks: number
  memoryEvidenceLinks: number
  memoryEventLinks: number
  orphanedMemoryIds: string[]
  /** 受影响但**被保留**的记忆（有活证据 + 活事件流 + 没丢过自有事件） */
  keptMemoryIds: string[]
}

export interface MemorySideCleanupInput {
  characterId: CharacterId
  /** 本次 reset 将要删除的**对话事件** id */
  deletedConversationEventIds: readonly string[]
}

/**
 * `resetKernelData` 在删事件**之前**调用它。
 *
 * ============================================================================
 *  判据（用户 2026-09-17 明确给出，这里补上第二个维度）
 * ============================================================================
 *    确定这次 Reset 将删除哪些 source events
 *            ↓
 *    找出所有"受影响"的记忆（两个来源，缺一不可）
 *        · 有 evidence link 指向将被删的**对话事件**
 *        · 有 memory_events 行指向将被删的**领域事件**
 *            ↓
 *    判断每条记忆"删掉这些之后"还剩不剩**活证据 + 活事件流**
 *        两者都还剩 → 只删失效的 evidence link，记忆保留
 *        任一为空   → 整条删（memory_records + subject links + evidence links + memory_events）
 *
 * ⚠️ 两条边界，都由 `verify-m4-memory-integrity.ts` 守着：
 *
 *   1. **不许**因为"有一条证据被删了"就整条删 —— 判据是
 *      `liveEvidenceCountAfterReset`，不是 `wasAnyEvidenceDeleted`。
 *      （用户原话：一条记忆有两条证据、只删掉其中一条，不能整条删。）
 *
 *   2. **事件流也必须计入**。用户给的判据是证据维度的；实现把事件流维度**并入同一条判据**，
 *      理由是：事件流没了的记忆 `rebuildMemory()` 必然 `equal = false`，
 *      保留它等于"把同一个缺陷换一个字段留着"（MI-11 仍然失效）。
 *      这不是扩大范围，而是把同一条不变量在一个 reset 里执行到底 ——
 *      最后那道德完整性闸会检查它。
 */
export async function cleanupMemorySideOfReset(
  db: RawDb,
  input: MemorySideCleanupInput
): Promise<MemorySideCleanup> {
  const empty: MemorySideCleanup = {
    memoryRecords: 0,
    memorySubjectLinks: 0,
    memoryEvidenceLinks: 0,
    memoryEventLinks: 0,
    orphanedMemoryIds: [],
    keptMemoryIds: [],
  }

  const deleted = [...new Set(input.deletedConversationEventIds)]
  if (deleted.length === 0) return empty

  const ownerKind = 'character'
  const ownerId = String(input.characterId)
  const deletedList = sql.join(
    deleted.map((id) => sql`${id}`),
    sql`, `
  )

  // --- 1. 本次会被删掉的领域事件 ------------------------------------------
  const domainRows = await exec(
    db,
    sql`select id from character_domain_events
        where character_id = ${ownerId} and primary_source_event_id in (${deletedList})`,
    '读取待删领域事件（记忆侧）'
  )
  const deletedDomainEventIds = domainRows.map((r) => String(r.id))

  // --- 2. 受影响的记忆（证据维度 ∪ 事件流维度）-----------------------------
  const affectedEvidenceRows = await exec(
    db,
    sql`select distinct l.memory_id
        from memory_evidence_links l
        join memory_records r on r.id = l.memory_id
        where r.owner_kind = ${ownerKind} and r.owner_id = ${ownerId}
          and l.evidence_kind = ${VERIFIABLE_EVIDENCE_KIND}
          and l.evidence_id in (${deletedList})`,
    '找出证据受损的记忆'
  )

  const affectedIds = new Set(affectedEvidenceRows.map((r) => String(r.memory_id)))

  if (deletedDomainEventIds.length > 0) {
    const domainList = sql.join(
      deletedDomainEventIds.map((id) => sql`${id}`),
      sql`, `
    )
    const affectedEventRows = await exec(
      db,
      sql`select distinct me.memory_id
          from memory_events me
          join memory_records r on r.id = me.memory_id
          where r.owner_kind = ${ownerKind} and r.owner_id = ${ownerId}
            and me.domain_event_id in (${domainList})`,
      '找出事件流受损的记忆'
    )
    for (const row of affectedEventRows) affectedIds.add(String(row.memory_id))
  }

  if (affectedIds.size === 0) return empty

  const affectedList = sql.join(
    [...affectedIds].map((id) => sql`${id}`),
    sql`, `
  )

  // --- 3. 分类：整条删 vs 保留 ----------------------------------------------
  const liveEvidence = new Set<string>()
  const liveEvents = new Set<string>()

  const liveEvidenceRows = await exec(
    db,
    sql`select l.memory_id, count(*)::int as live
        from memory_evidence_links l
        join conversation_events e on e.id = l.evidence_id
        where l.memory_id in (${affectedList})
          and l.evidence_kind = ${VERIFIABLE_EVIDENCE_KIND}
          and e.id not in (${deletedList})
        group by l.memory_id`,
    '找出仍持有活证据的记忆'
  )
  for (const row of liveEvidenceRows) {
    if (Number(row.live) > 0) liveEvidence.add(String(row.memory_id))
  }

  const liveEventRows = await exec(
    db,
    sql`select me.memory_id, count(*)::int as live
        from memory_events me
        join character_domain_events e on e.id = me.domain_event_id
        where me.memory_id in (${affectedList})
          and e.primary_source_event_id not in (${deletedList})
        group by me.memory_id`,
    '找出仍有活事件流的记忆'
  )
  for (const row of liveEventRows) {
    if (Number(row.live) > 0) liveEvents.add(String(row.memory_id))
  }

  /** 自有事件流被删掉过（哪怕只删了其中一条）—— replay 结果会变，必须整条删 */
  const lostEvents = new Set<string>()
  if (deletedDomainEventIds.length > 0) {
    const domainListForLoss = sql.join(
      deletedDomainEventIds.map((id) => sql`${id}`),
      sql`, `
    )
    const lostRows = await exec(
      db,
      sql`select distinct me.memory_id from memory_events me
          where me.memory_id in (${affectedList})
            and me.domain_event_id in (${domainListForLoss})`,
      '找出丢了自有事件流的记忆'
    )
    for (const row of lostRows) lostEvents.add(String(row.memory_id))
  }

  /*
   * ============================================================================
   *  什么该整条删 —— 三条，各自对应一条不变量
   * ============================================================================
   *   ① 已无任何活证据        → MI-03（"她凭什么记得"没有答案）
   *   ② 已无活事件流          → MI-11（rebuildMemory 必然 equal = false）
   *   ③ **丢过任何一条自有事件** → MI-11（replay 会得到另一个状态：
   *        例如在会话 B 建立、在会话 A 被 supersede，reset A 之后重放会变回 active）
   *
   * ⚠️ 第 ③ 条是"部分丢失"的情形，比"全丢"隐蔽得多 —— 它不留下空事件流，
   *    却让重放结果与投影不一致。判据必须按**丢过没有**，不是"还剩没剩"。
   */
  const orphanIds = [...affectedIds].filter(
    (id) => !liveEvidence.has(id) || !liveEvents.has(id) || lostEvents.has(id)
  )
  const survivors = [...affectedIds].filter((id) => !orphanIds.includes(id))

  const cleanup: MemorySideCleanup = { ...empty, orphanedMemoryIds: orphanIds }

  // --- 4. 孤儿：整条删除（四个表一起，顺序先引用方后被引用方）-------------
  if (orphanIds.length > 0) {
    const orphanList = sql.join(
      orphanIds.map((id) => sql`${id}`),
      sql`, `
    )
    cleanup.memoryEventLinks = await affectedRows(
      db,
      sql`delete from memory_events where memory_id in (${orphanList}) returning memory_id`,
      '删除孤儿记忆的事件流行'
    )
    cleanup.memoryEvidenceLinks = await affectedRows(
      db,
      sql`delete from memory_evidence_links where memory_id in (${orphanList}) returning memory_id`,
      '删除孤儿记忆的证据 link'
    )
    cleanup.memorySubjectLinks = await affectedRows(
      db,
      sql`delete from memory_subject_links where memory_id in (${orphanList}) returning memory_id`,
      '删除孤儿记忆的 subject link'
    )
    cleanup.memoryRecords = await affectedRows(
      db,
      sql`delete from memory_records where id in (${orphanList}) returning id`,
      '删除孤儿记忆本体'
    )
  }

  /*
   * ============================================================================
   *  幸存者：**刻意不动它的 evidence link** —— 这是一次"没有做某件事"的说明
   * ============================================================================
   * 用户 2026-09-17 的判据里写着"仍有 Evidence → 只删除失效 evidence"。
   * 实现**做不到**那一条而不破坏 MI-11，原因是查出来的：
   *
   *     `compareRecords()` 比对 `sourceRefs`（memory-store.ts:951，集合语义），
   *     而重放侧的 sourceRefs 来自 `MEMORY_CREATED` 的 **payload 快照**
   *     （`recordFromCandidate` 写进去的全量 record）——
   *     事件是 append-only 的，payload 里那条证据**永远在**。
   *
   * 于是"删掉失效 link"会让投影比事件流少一条证据：
   *
   *     投影 sourceRefs = [B]     事件重放 = [B, A]     → A ≠ B（MI-11 破）
   *
   * 两个选择都不好，而我们选了不破 MI-11 的那个：
   *
   *   · 删 link → 悬空清零，但**A == B 破**（M4 最硬的一条 Gate）
   *   · 留 link → A == B 成立，但库里留下一条"指向已删会话"的证据引用
   *               （它是**用户显式抹掉那段历史**的痕迹，可解释、可审计）
   *
   * 要让两者同时成立，正确做法是**为"证据被移除"写一条领域事件**
   * （append-only：改状态要靠追加事件，而不是改行）——那需要新增事件类型 +
   * reducer 分支 + 迁移，**超出本次 Hotfix 的 Scope**（用户明确要求"不允许顺便重构"）。
   * 因此它被记为 D-9，而不是在这里顺手做掉。
   *
   * 结果：幸存记忆的证据引用保留 → `danglingEvidenceLinks` 可能 > 0，
   * 但那**不是孤儿**（它有活证据、有活事件流、A == B 成立）。
   * 探针把两者分开报，`memory:stats` 也分开显示。
   */
  cleanup.keptMemoryIds = survivors

  return cleanup
}
