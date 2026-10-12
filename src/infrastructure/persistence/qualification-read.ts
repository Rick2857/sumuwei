/**
 * M5.1.1 / Phase 4b —— **根证据归因的读取**（唯一的读路径）。
 *
 * ============================================================================
 *  为什么它必须只有一处
 * ============================================================================
 * 现在有**两个**消费者需要"一条记忆今天的资格"：
 *
 * ```text
 *   召回（memory-retrieval-store）  逐命中候选带上资格 ⇒ 排序与 prompt 标签用它
 *   第二个只读探针（memory-store）  汇总"多少条用户事实的资格不是已确立"
 * ```
 *
 * 如果两处各写一份 SQL、各判一遍"什么算已确立"，它们会漂移；而漂移的表现是
 * **"召回里那条是已确立的、探针却说它没确立"** —— 一个不会报错、只会让人不信任数字的分歧。
 * 因此：**SQL 只有这一份**，判定只调用 `kernel/recall/qualification.ts` 的纯函数。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 它**不**自己解析归因列（R-59 的边界只有**一个**适配器）
 * ---------------------------------------------------------------------------
 * 第一版这里直接 select 那些归因列、自己拼三态 —— 结果被 `k17` 的「取代③
 * 全 `src/**` 只有 1 处派生 `trustedOrigin`」当场抓住：那是**第二个**适配边界，
 * 而 R-59（用户裁定）要求 `processorEventViewOf()` 是**唯一**允许读原始
 * `event.attribution` 与 Axis B 三列并派生 `trustedOrigin` 的边界。
 *
 * 正确做法是**复用它**，而不是并列它：
 *
 * ```text
 *   memory_evidence_links（哪些是**根**）
 *        └─ getConversationEvent()        ← 契约层的 row → ConversationEvent（唯一解码处）
 *             └─ processorEventViewOf()   ← **唯一**适配边界（唯一派生点）
 *                  └─ .trustedOrigin      ← 受信读数（无信封 / MIGRATED_LEGACY ⇒ undefined）
 * ```
 * 于是"三态怎么拼回来"与"什么算受信"都只有一处定义，本文件只负责**取哪几行**。
 *
 * ---------------------------------------------------------------------------
 *  它读什么、**不**读什么
 * ---------------------------------------------------------------------------
 * ```text
 * 读    memory_evidence_links（哪些是**根**证据）· conversation_events（经契约层解码）
 * 不读  memory_records.authority（那是**当时**的判定，不可变 —— ADR-043 DR-1）
 * 不写  任何表（纯 SELECT）
 * ```
 * 事件行**不存在**（悬挂 link）时按"读不到"处理 ⇒ 该根证据的读数 = `undefined`
 * ⇒ 失败关闭为 `UNCONFIRMED_ORIGIN`（`DR-7`）。这一条刻意与
 * `memoryIntegrityProblems()` 的分工区分开：那个探针回答"账本结构坏没坏"，
 * 这里回答"来源确立没确立"，两者都不许越界回答对方的问题。
 */

import { sql } from 'drizzle-orm'

import type { SourceQualification, TrustedOriginReading } from '../../kernel/contracts/attribution.ts'
import { COGNITIVE_QUALIFICATION_RULE_VERSION } from '../../kernel/contracts/attribution.ts'
import type { ConversationEvent } from '../../kernel/contracts/conversation-event.ts'
import type { EntityRef } from '../../kernel/contracts/entity.ts'
import type { MemoryType } from '../../kernel/contracts/memory.ts'
import { processorEventViewOf } from '../../kernel/app/memory/extractor.ts'
import {
  countQualifications,
  memoryQualificationOf,
  type QualificationCounts,
} from '../../kernel/recall/qualification.ts'
import { getConversationEventsByIds } from './conversation-store.ts'
import { exec, rowsOf, type RawDb } from './db.ts'

/**
 * 从一条**已经读出来的**事件取受信读数（唯一适配边界的**消费点**）。
 *
 * 导出它，是为了让别的只读面（M6 的会话摘要来源读取面）复用**同一份**
 * "取不到怎么办"的语义，而不是各自再写一遍 try/catch —— 两处各写一遍，
 * 迟早出现"一处失败关闭、另一处悄悄回落到 actor_type"这种分歧。
 */
export function originReadingOfEvent(event: ConversationEvent): TrustedOriginReading | undefined {
  try {
    return processorEventViewOf(event).trustedOrigin
  } catch {
    // `processorEventViewOf` 对 `tool` 事件**抛错**（那不是可抽取的来源）。
    // 在这里它是"这一条根证据读不出受信读数" ⇒ 不猜，失败关闭。
    return undefined
  }
}

/**
 * 一条**根证据**的受信读数 —— 语义定义（**批量版见 `rootReadingsByMemory()`**）。
 *
 * 全部判定都在 `processorEventViewOf()` 里（R-59 的唯一适配边界）；
 * 这一层只把"取哪一行"与"这一行不存在怎么办"处理掉。
 *
 * ⚠️ **2026-10-04（`R-48` 收口）**：原先这里是**逐条**调用（每条 1 次查询），
 *    在 `rootReadingsByMemory()` 的循环里就是 N+1。现在调用方**一次批量**取回事件
 *    （`getConversationEventsByIds()`，逐行仍走同一个 `rowToEvent()`），
 *    再用下面的 `originReadingOfEvent()` 逐行解码 ⇒ **语义逐条不变**，往返 O(n) → O(1)。
 */
function readingOfEvent(event: ConversationEvent | undefined): TrustedOriginReading | undefined {
  if (event === undefined) return undefined
  return originReadingOfEvent(event)
}

/** `memoryId → 该记忆各根证据的受信读数`（顺序稳定：按 link 插入顺序） */
export async function rootReadingsByMemory(
  db: RawDb,
  memoryIds: readonly string[]
): Promise<Map<string, (TrustedOriginReading | undefined)[]>> {
  const out = new Map<string, (TrustedOriginReading | undefined)[]>()
  if (memoryIds.length === 0) return out
  const list = memoryIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(', ')
  /*
   * ⚠️ **S8 / ADR-093 `D02`**：根证据的 `evidence_kind` 从"只认 conversation_event"
   * 扩到 **也认 `story_event`**。
   *
   * 为什么必须扩：不扩的话，一条**以故事经历为唯一来源**的记忆会得到
   * `rootReadings.length = 0` —— 而"没有根"与"有根但它不确立"在资格判定里
   * 走的是**同一条**分支（都 `UNCONFIRMED_ORIGIN`），于是**根数**在读数里永远是 0，
   * 连"这条记忆到底有没有来源"都答不出来（ADR-092 `D02` 记录的正是这个形状）。
   *
   * 为什么**不**给故事根编一个 trustedOrigin：`TrustedOriginReading` 的来源是
   * `processorEventViewOf(conversationEvent)` 的受信信封，而故事提交**不是对话事件**
   * （`INV-PL2-02`：不得伪装）。因此故事根一律映射成 `undefined`
   * ⇒ `sourceQualificationOf(undefined)` ⇒ **失败关闭**为 `UNCONFIRMED_ORIGIN`。
   * 即"故事来源**不能**支持用户事实"，与 M5.1.1 的既有语义**同向**（`L-PL2-01` 仍在册）。
   */
  const rows = rowsOf(
    await exec(
      db,
      sql.raw(`select l.memory_id as memory_id, l.evidence_kind as evidence_kind, l.evidence_id as evidence_id
                 from memory_evidence_links l
                where l.memory_id in (${list})
                  and l.is_root
                  and l.evidence_kind in ('conversation_event', 'story_event')
                order by l.memory_id asc`),
      '读取根证据的 id（归因由唯一适配边界处理器读出）'
    )
  ) as unknown as { memory_id: string; evidence_kind: string; evidence_id: string }[]

  /*
   * ⚠️ **批量读**（`R-48` 收口的第二处同形副本，2026-10-04）：原来在这个循环里逐条
   *    `readingOfEvidence()`（每条 1 次查询）。现在先把**对话事件**那一批 id 去重后
   *    一次取回（`getConversationEventsByIds()`，逐行仍走同一个 `rowToEvent()`），
   *    再按 id 查表 ⇒ **顺序与语义逐条不变**（输出仍按 `rows` 的 `memory_id asc` 顺序 push）。
   *    故事根仍然一律 `undefined`（失败关闭，见上面 `D02` 的说明）。
   */
  const conversationIds = [
    ...new Set(
      rows
        .filter((row) => String(row.evidence_kind) !== 'story_event')
        .map((row) => String(row.evidence_id))
    ),
  ]
  const events = await getConversationEventsByIds(db, conversationIds as never)
  const readingById = new Map<string, TrustedOriginReading | undefined>()
  conversationIds.forEach((id, index) => {
    readingById.set(id, readingOfEvent(events[index]))
  })

  for (const row of rows) {
    const key = String(row.memory_id)
    const list0 = out.get(key) ?? []
    list0.push(
      String(row.evidence_kind) === 'story_event'
        ? undefined // 故事根：没有对话侧受信信封 ⇒ 失败关闭（见上面的说明）
        : readingById.get(String(row.evidence_id))
    )
    out.set(key, list0)
  }
  return out
}

/** `memoryId → 资格`（只对 person_fact / preference 有值） */
export async function qualificationsForMemories(
  db: RawDb,
  memories: readonly { id: string; type: MemoryType }[],
  ruleVersion: number = COGNITIVE_QUALIFICATION_RULE_VERSION
): Promise<Map<string, SourceQualification | undefined>> {
  const readings = await rootReadingsByMemory(
    db,
    memories.map((memory) => memory.id)
  )
  const out = new Map<string, SourceQualification | undefined>()
  for (const memory of memories) {
    out.set(
      memory.id,
      memoryQualificationOf({
        memoryType: memory.type,
        rootReadings: readings.get(memory.id) ?? [],
        ruleVersion,
      })
    )
  }
  return out
}

/** 第二个只读探针的一行 */
export interface UnqualifiedUserFact {
  memoryId: string
  type: string
  /** **当时**的判定（不可变；这里只是原样带出来，**不**参与资格判断） */
  authority: string
  qualification: SourceQualification
  /** 该记忆有几条根证据 */
  rootCount: number
}

export interface QualificationReport {
  /** 资格不是 `ESTABLISHED` 的用户事实（**不是**"污染" —— 见下面的说明） */
  unqualified: UnqualifiedUserFact[]
  counts: QualificationCounts
  /** 扫过的用户事实条数（自检用：0 必须判 `MEASUREMENT INVALID`） */
  scanned: number
}

/**
 * **第二个只读探针**（ADR-043 `DR-9`：既有探针 `contaminatedMemories()` **一字不改**，
 * 在旁边**追加**这一个）。
 *
 * ⚠️ 它与 `contaminatedMemories()` 问的是**两个不同的问题**，不许互相替代：
 *
 * ```text
 * contaminatedMemories()   「这条用户事实的**记录权威**是不是不该是用户事实？」
 *                          判据：`authority not in (EXPLICIT_USER_STATEMENT, EXPLICIT_CORRECTION)`
 *                          引入 4b 之后它**必须仍然是 0**（ADR §4.2 `N-5`）
 * 本探针                    「这条用户事实**今天的来源资格**是已确立吗？」
 *                          判据：根证据的受信归因（`DR-6`：只认鉴证过的归因）
 *                          它**不是**污染：真库今天全部 2 条都会落在这里，
 *                          而那正是 D01 想要的**诚实**状态（`DR-12` 之前不许关闭 D01）
 * ```
 *
 * 把两者混成一个数字，会让"来源未确立"看起来像"被污染" ——
 * 那会让人去修一条其实没有坏的数据。
 */
export async function unqualifiedUserFacts(
  db: RawDb,
  owner: EntityRef,
  ruleVersion: number = COGNITIVE_QUALIFICATION_RULE_VERSION
): Promise<QualificationReport> {
  const memoryRows = rowsOf(
    await exec(
      db,
      sql`select id, memory_type, authority from memory_records
          where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
            and memory_type in ('person_fact', 'preference')
          order by id asc`,
      '读取用户事实（资格探针）'
    )
  ) as { id: string; memory_type: string; authority: string }[]

  const memories = memoryRows.map((row) => ({
    id: String(row.id),
    type: String(row.memory_type) as MemoryType,
    authority: String(row.authority),
  }))
  const readings = await rootReadingsByMemory(
    db,
    memories.map((memory) => memory.id)
  )

  const unqualified: UnqualifiedUserFact[] = []
  const all: (SourceQualification | undefined)[] = []
  for (const memory of memories) {
    const roots = readings.get(memory.id) ?? []
    const qualification = memoryQualificationOf({
      memoryType: memory.type,
      rootReadings: roots,
      ruleVersion,
    })
    all.push(qualification)
    if (qualification !== undefined && qualification !== 'ESTABLISHED') {
      unqualified.push({
        memoryId: memory.id,
        type: memory.type,
        authority: memory.authority,
        qualification,
        rootCount: roots.length,
      })
    }
  }

  return { unqualified, counts: countQualifications(all), scanned: memories.length }
}
