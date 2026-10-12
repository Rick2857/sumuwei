/**
 * NativeMemoryStore —— **M4 的 MemoryStorePort 默认实现**（计划书第 87–93 / 155–159 节）。
 *
 * ============================================================================
 *  为什么必须先有 Native Baseline（计划书第 92–93 节）
 * ============================================================================
 * 计划书把这条写得很直接：
 *
 *     否则使用 MemOS 以后得到一个结果："好像能记住"
 *     无法判断：是 MemOS 真的改善了，还是我们根本没有自己的基线。
 *
 * 因此这个文件的定位是 **Baseline**：最可控、最好调试、最容易验证语义。
 * 外部后端（MemOS）只允许通过 `MemoryStorePort` 接进来做 PoC，
 * 而且必须在它之后（计划书第 138 节）。
 *
 * ---------------------------------------------------------------------------
 *  接口边界（计划书第 88–91 节）
 * ---------------------------------------------------------------------------
 * `MemoryStorePort` 负责：持久化、按 id 查、按 canonical key 查、
 * 按 subject 查、按 source 反查、应用 mutation。
 *
 * 它**不**负责："根据这句话找到最相关的五条"。那是 M5 的 `MemoryRetrievalPort`。
 * 因此这里**没有** `search(query)` —— 见计划书第 89–90 节。
 *
 * ---------------------------------------------------------------------------
 *  事务纪律（计划书第 159–160 节）
 * ---------------------------------------------------------------------------
 * `apply()` 的单个事务里只有：
 *
 *     序号分配 → 插入领域事件 → 写索引表 → 纯 reduce → 乐观锁写投影
 *
 * **没有 LLM、没有网络、没有遥测**。计划书第 160 节把这条与 M2.5 对齐。
 */

import { sql } from 'drizzle-orm'

import {
  KernelError,
  MEMORY_REDUCER_VERSION,
  asMemoryId,
  entityRef,
  evidenceRef,
  isMemoryType,
  type DomainEvent,
  type EntityRef,
  type EvidenceRef,
  type EvidenceKind,
  type MemoryAuthority,
  type MemoryEpistemicStatus,
  type MemoryId,
  type MemoryRecord,
  type MemoryStatus,
  type MemoryType,
  type ClaimMemoryContent,
  type EpisodicMemoryContent,
} from '../../kernel/contracts/index.ts'
import {
  memoryIdOfEvent,
  reduceMemory,
  replayMemory,
} from '../../kernel/projections/memory.ts'
import { rowToDomainEvent } from './event-store.ts'
import { affectedRows, asRows, exec, firstRow, inTransaction, type RawDb } from './db.ts'

// ---------------------------------------------------------------------------
// 行收窄（与 db.ts 的 asRows 同一条规矩，但针对我们的 row 类型）
// ---------------------------------------------------------------------------

/**
 * `exec()` 的返回类型刻意是 `Record<string, unknown>[]`（数据库不知道
 * 我们的表形状），收窄只能靠调用方。这里收敛成两个具名函数，
 * 好处是"哪里有断言"一眼可查（与 `db.ts` 的 `asRows` / `firstRow` 同一个理由）。
 */
function memoryRows(rows: Record<string, unknown>[]): MemoryRow[] {
  return rows as unknown as MemoryRow[]
}

function firstMemoryRow(rows: Record<string, unknown>[]): MemoryRow | undefined {
  return rows.length > 0 ? (rows[0] as unknown as MemoryRow) : undefined
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface MemoryQueryScope {
  owner: EntityRef
  status?: MemoryStatus
  type?: MemoryType
  limit?: number
}

/**
 * 计划书第 89 节的接口形状。
 *
 * ⚠️ 刻意**没有** `search()`。M2.5 若存在那种 placeholder，M4 可以保留兼容
 * Adapter，但新业务层必须明确：`Storage lookup` 与 `Semantic retrieval`
 * 不是同一问题（计划书第 90 节）。
 */
export interface MemoryStorePort {
  get(id: MemoryId): Promise<MemoryRecord | null>

  /**
   * **按 id 集合批量读**（M9 线 N+1 收口；登记册 §0p `R-48`）。
   *
   * ============================================================================
   *  为什么必须真的批量（不是"逐个 `get()` 包一层"）
   * ============================================================================
   * ```text
   * 逐个 `get()` 的代价是 `1 + 3` 次查询/条（records + subject + evidence + supersedes）。
   * M9 的**资格回查**与 M9.5 的**目标输入**本来就在端口契约里写着"按 id 批量读"
   * （`job.ts` · `eligibility.ts:13` · M9 执行计划 §22.4"去重批量读取，避免逐 Belief N+1"），
   * 而实现却逐条调用 ⇒ 实测 23 条信念 = **119 次 DB 调用 / 54.6ms**
   * （`m9:perf:baseline` 的读数）。本方法把同一批读压成 **4 次**。
   * ```
   *
   * ⚠️ **语义与逐个 `get()` 逐条等价**：同一条 `hydrate()` 路径（同一个 `rowToRecordBase`
   * 守卫、同一批索引表、同一种排序），只是把 N 次往返换成 4 次。
   * 返回顺序 = **入参顺序**；不存在的 id 给 `null`（与 `get()` 同）。
   * 失败语义不变：任何一条守卫抛错仍然向上抛（调用方原有的"整块放弃"catch 照旧生效）。
   */
  getMany(ids: readonly MemoryId[]): Promise<(MemoryRecord | null)[]>

  getActiveByCanonicalKey(key: string): Promise<MemoryRecord[]>

  /**
   * 该槽位上的**全部**记录（含 SUPERSEDED / RETRACTED / DISPUTED），
   * 按 `recordedAt` 升序。
   *
   * ============================================================================
   *  计划书第 132 节的 WP6 Gate 需要它
   * ============================================================================
   *    能够完整展示 Memory History：
   *      2026-09-01 喜欢咖啡
   *      2026-09-16 戒咖啡
   *      Current: 戒咖啡
   *    同时历史不丢失。
   *
   * 与 `getActiveByCanonicalKey` 的区别就是"含不含非当前状态"：
   *   · 判冲突时只要 ACTIVE（+ DISPUTED）—— 那是"当前可能为真的"
   *   · 展示历史时要**全部** —— 否则"历史不丢失"只在事件流里成立，
   *     而事件流不是给人看的
   */
  listByCanonicalKey(key: string): Promise<MemoryRecord[]>

  listBySubject(owner: EntityRef, subject: EntityRef): Promise<MemoryRecord[]>

  listBySource(ref: EvidenceRef): Promise<MemoryRecord[]>

  list(scope: MemoryQueryScope): Promise<MemoryRecord[]>

  /** 按内容指纹找 ACTIVE 的那一条（去重第一层的查询口） */
  getActiveByFingerprint(owner: EntityRef, fingerprint: string): Promise<MemoryRecord | null>

  /** 这条记忆的全部领域事件（升序）—— 审计与重放的输入 */
  history(id: MemoryId): Promise<DomainEvent[]>

  /** 应用一个已经被放行口校验过的领域事件 */
  apply(event: DomainEvent): Promise<MemoryApplyResult>

  /** 从事件重建单条记忆（计划书第 73 节） */
  rebuildMemory(id: MemoryId): Promise<MemoryRebuildResult>

  /** 重建整个 Memory Space（计划书第 73 节） */
  rebuildCharacterMemories(owner: EntityRef): Promise<MemoryRebuildSummary>
}

export interface MemoryApplyResult {
  event: DomainEvent
  /** false = 幂等命中（这个事件之前已经生效过），本次没有改变状态 */
  created: boolean
  record: MemoryRecord | null
}

export interface MemoryRebuildResult {
  memoryId: MemoryId
  before: MemoryRecord | null
  after: MemoryRecord | null
  appliedEvents: number
  /** 计划书第 74 节的 `A == B` 判定 */
  equal: boolean
  /** 差异字段（`equal === false` 时非空，用于定位是哪一步重放不一致） */
  differences: string[]
}

export interface MemoryRebuildSummary {
  owner: EntityRef
  memories: number
  rebuilt: number
  mismatched: number
  details: MemoryRebuildResult[]
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string
  owner_kind: string
  owner_id: string
  memory_type: string
  content_kind: string
  content: unknown
  epistemic_status: string
  authority: string
  importance: number
  confidence: number
  status: string
  canonical_key: string | null
  content_fingerprint: string
  valid_from: number | null
  valid_until: number | string | null
  occurred_at: number | null
  recorded_at: number
  superseded_by: string | null
  processor: string | null
  processor_version: string | null
  reducer_version: string
  revision: number
  schema_version: number
  created_at: number
  updated_at: number
}

type Timestamp = number

/**
 * `validUntil` 的 SQL 哨兵。
 *
 * 用 `'none'` 而**不是** `''` 或 `'-'`：它必须在日志里一眼可读，
 * 且必须不可能与一个真实时间戳的字符串形式混淆
 * （真实值是纯数字串，`'none'` 永远不是）。
 */
export const VALID_UNTIL_OPEN_SENTINEL = 'none'

/**
 * ============================================================================
 *  `validUntil` 需要表达**三种**状态，而 SQL 的 NULL 只有两种
 * ============================================================================
 * 契约（`memory.ts`）刻意区分：
 *
 *     undefined —— 不知道 / 不适用
 *     null      —— **明确地"没有终点"**（当前有效，且预期继续有效）
 *     number    —— 失效于这个时刻
 *
 * 若把 `null`（没有终点）与 `undefined`（不知道）都写成 NULL，那么：
 *   · `MEMORY_RESTORED` 之后"应该没有终点"与"压根不知道"
 *     在数据上同形，reducer 无法判断该不该清 `validUntil`
 *   · 重放一条被 restore 过的记忆会得到与首次写入**不同的**结果 ——
 *     而 `A == B` 是 M4 的 Gate（计划书第 74 节）
 *
 * 因此 `valid_until` 列是 **text**，承载三态：
 *
 *     NULL      ← undefined（不知道）
 *     'none'    ← null（没有终点）
 *     '1756...' ← number（那个时刻）
 *
 * ⚠️ 第一版这里写成 `bigint` + 字符串哨兵，插入时直接类型报错
 * （"sentinel 是字符串、列是 bigint"）。改用 text 之后三态才真的可表达 ——
 * 这不是权宜，而是"契约里有两个非时间值"的必然对应物。
 * 时间比较在应用层做；这个列只负责**无歧义地存下三态**。
 */
function validUntilToSql(value: Timestamp | null | undefined): string | null {
  if (value === undefined) return null
  if (value === null) return VALID_UNTIL_OPEN_SENTINEL
  return String(value)
}

function validUntilFromSql(
  value: number | string | null | undefined
): Timestamp | null | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    if (value === VALID_UNTIL_OPEN_SENTINEL) return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      throw new KernelError(
        'persistence_error',
        'bad_valid_until_in_row',
        `memory_records.valid_until 的值无法解释：${JSON.stringify(value)}。` +
          '合法值是 NULL（不知道）、\'none\'（没有终点）或一个数字串（那个时刻）'
      )
    }
    return parsed
  }
  return Number(value)
}

function rowToRecordBase(
  row: MemoryRow
): Omit<MemoryRecord, 'subjects' | 'sourceRefs' | 'evidenceRootIds' | 'supersedes'> {
  const type = String(row.memory_type)
  if (!isMemoryType(type)) {
    throw new KernelError(
      'persistence_error',
      'unknown_memory_type_in_row',
      `memory_records 里存着未登记的 memory_type：${type}。` +
        '这通常意味着有人绕过契约直接写了库，或者登记表被改过却没迁移数据'
    )
  }

  const contentRaw = row.content
  if (typeof contentRaw !== 'object' || contentRaw === null) {
    throw new KernelError(
      'persistence_error',
      'bad_memory_content_row',
      `记忆 ${String(row.id)} 的 content 不是对象`
    )
  }
  const content = contentRaw as ClaimMemoryContent | EpisodicMemoryContent

  const validUntil = validUntilFromSql(row.valid_until)

  return {
    id: asMemoryId(String(row.id)),
    owner: entityRef(
      // owner_kind 是受控枚举；entity 层会拒绝未登记的值
      String(row.owner_kind) as EntityRef['kind'],
      String(row.owner_id)
    ),
    type,
    content,
    epistemicStatus: String(row.epistemic_status) as MemoryEpistemicStatus,
    authority: String(row.authority) as MemoryAuthority,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    status: String(row.status) as MemoryStatus,
    ...(row.canonical_key !== null && row.canonical_key !== undefined
      ? { canonicalKey: String(row.canonical_key) }
      : {}),
    contentFingerprint: String(row.content_fingerprint),
    ...(row.valid_from !== null && row.valid_from !== undefined
      ? { validFrom: Number(row.valid_from) }
      : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    ...(row.occurred_at !== null && row.occurred_at !== undefined
      ? { occurredAt: Number(row.occurred_at) }
      : {}),
    recordedAt: Number(row.recorded_at),
    ...(row.superseded_by !== null && row.superseded_by !== undefined
      ? { supersededBy: asMemoryId(String(row.superseded_by)) }
      : {}),
    ...(row.processor !== null && row.processor !== undefined
      ? { processor: String(row.processor) }
      : {}),
    ...(row.processor_version !== null && row.processor_version !== undefined
      ? { processorVersion: String(row.processor_version) }
      : {}),
    reducerVersion: String(row.reducer_version),
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

async function insertRecord(db: RawDb, record: MemoryRecord, now: number): Promise<void> {
  await exec(
    db,
    sql`insert into memory_records
          (id, owner_kind, owner_id, memory_type, content_kind, content,
           epistemic_status, authority, importance, confidence, status,
           canonical_key, content_fingerprint, valid_from, valid_until, occurred_at,
           recorded_at, superseded_by, processor, processor_version,
           reducer_version, revision, schema_version, created_at, updated_at)
        values (${String(record.id)}, ${record.owner.kind}, ${String(record.owner.id)},
                ${record.type}, ${record.content.kind}, ${JSON.stringify(record.content)}::jsonb,
                ${record.epistemicStatus}, ${record.authority}, ${record.importance},
                ${record.confidence}, ${record.status},
                ${record.canonicalKey ?? null}, ${record.contentFingerprint},
                ${record.validFrom ?? null}, ${validUntilToSql(record.validUntil)},
                ${record.occurredAt ?? null},
                ${record.recordedAt}, ${record.supersededBy ? String(record.supersededBy) : null},
                ${record.processor ?? null}, ${record.processorVersion ?? null},
                ${record.reducerVersion}, ${record.revision}, ${record.schemaVersion},
                ${record.createdAt}, ${now})`,
    `写入 Memory ${String(record.id)}`
  )
}

/**
 * 乐观锁写入。
 *
 * **照抄 `saveProjection()` 的形状**（先读 → 带 `revision` 条件写 →
 * `returning` 确认影响行数），这是 M4 审计 §5 F1 的明确要求：
 * 不复用那张表，但**乐观锁的语义必须一致**，否则两套投影的行为会分叉。
 *
 * 失败时抛 `revision_conflict`（沿用 `KernelErrorKind`，不发明新的错误种类）。
 *
 * ⚠️ 导出它是为了让 `verify-m4-persistence.ts` 能**直接测这条闸**。
 * 从 `applyMemoryEvent` 走是测不到的：它会先读当前 revision，
 * 因此永远不会构造出"过期 revision"那个输入 ——
 * 而"过期 revision 必须被拒绝"恰恰是乐观锁的全部意义。
 * 这也是与 `saveProjection()` 一致的做法（它同样被验证脚本直接调用）。
 */
export async function updateRecordWithLock(
  db: RawDb,
  record: MemoryRecord,
  expectedRevision: number,
  now: number
): Promise<void> {
  const affected = await affectedRows(
    db,
    sql`update memory_records set
          memory_type = ${record.type},
          content_kind = ${record.content.kind},
          content = ${JSON.stringify(record.content)}::jsonb,
          epistemic_status = ${record.epistemicStatus},
          authority = ${record.authority},
          importance = ${record.importance},
          confidence = ${record.confidence},
          status = ${record.status},
          canonical_key = ${record.canonicalKey ?? null},
          content_fingerprint = ${record.contentFingerprint},
          valid_from = ${record.validFrom ?? null},
          valid_until = ${validUntilToSql(record.validUntil)},
          occurred_at = ${record.occurredAt ?? null},
          superseded_by = ${record.supersededBy ? String(record.supersededBy) : null},
          reducer_version = ${record.reducerVersion},
          revision = ${record.revision},
          updated_at = ${now}
        where id = ${String(record.id)} and revision = ${expectedRevision}
        returning revision`,
    `更新 Memory ${String(record.id)}（乐观锁）`
  )

  if (affected > 0) return

  // 走到这里说明读取之后被别人抢先更新了。
  const current = await rawGet(db, record.id)
  throw new KernelError(
    'revision_conflict',
    'memory_revision_conflict',
    `记忆 ${String(record.id)} 在写入瞬间版本冲突：期望基于 revision=${expectedRevision} 更新，` +
      `库里当前是 revision=${current?.revision ?? '(不存在)'}。` +
      '旧任务不允许覆盖新状态（与投影乐观锁同一条规矩）。',
    {
      memoryId: String(record.id),
      expectedRevision,
      actualRevision: current?.revision ?? null,
    }
  )
}

/** 写索引表（subject / evidence）。全删全建：这些表是纯索引，没有独立历史 */
async function replaceLinks(db: RawDb, record: MemoryRecord): Promise<void> {
  const memoryId = String(record.id)

  await exec(
    db,
    sql`delete from memory_subject_links where memory_id = ${memoryId}`,
    '清理 subject 索引'
  )
  for (const subject of record.subjects) {
    await exec(
      db,
      sql`insert into memory_subject_links (memory_id, subject_kind, subject_id)
          values (${memoryId}, ${subject.kind}, ${String(subject.id)})
          on conflict (memory_id, subject_kind, subject_id) do nothing`,
      '写入 subject 索引'
    )
  }

  await exec(
    db,
    sql`delete from memory_evidence_links where memory_id = ${memoryId}`,
    '清理 evidence 索引'
  )
  const roots = new Set(record.evidenceRootIds)
  for (const ref of record.sourceRefs) {
    await exec(
      db,
      sql`insert into memory_evidence_links (memory_id, evidence_kind, evidence_id, is_root)
          values (${memoryId}, ${ref.kind}, ${ref.id}, ${roots.has(ref.id)})
          on conflict (memory_id, evidence_kind, evidence_id) do update
            set is_root = excluded.is_root`,
      '写入 evidence 索引'
    )
  }
}

/**
 * 登记"这条领域事件已经折叠过"的索引行。
 *
 * ⚠️ 导出它的理由与 `updateRecordWithLock` 同一条：**有第二个调用方**。
 * `memory-recovery.ts` 需要一种"只登记、不改投影"的形状 ——
 * 当纯 reducer 预览给出 `changed === false`（投影已经反映过这条事件、
 * 只是索引行缺失）时，无脑走 `applyMemoryEvent` 会把 revision 推一格
 * 而状态不变，那会让 revision 与事件流的关系不可解释。
 */
export async function appendMemoryEventLink(
  db: RawDb,
  memoryId: MemoryId,
  event: DomainEvent
): Promise<void> {
  await exec(
    db,
    sql`insert into memory_events (memory_id, domain_event_id, sequence, kind, created_at)
        values (${String(memoryId)}, ${String(event.id)}, ${event.sequence},
                ${event.type}, ${event.createdAt})
        on conflict (memory_id, sequence) do nothing`,
    '登记 Memory 事件索引'
  )
}

/**
 * `supersedes`：哪些记忆的 SUPERSEDED 事件指向了这一条。
 *
 * ⚠️ 它**必须由这个函数统一推导**，不能只在读路径算。
 *
 * 实测踩到过：`hydrate()` 从领域事件算出 `supersedes`，而重放路径没有算，
 * 于是 `rebuildMemory()` 报 `A != B`，差异字段就是 `supersedes` ——
 * 那正是计划书第 74 节那条 Gate 存在的意义：**它抓出了一个真实的不一致**。
 * 修法不是"比对时忽略这个字段"（那会让 Gate 变松），
 * 而是让重放也算出同一个值。
 *
 * 不从 `memory_records` 的冗余列推导，是因为"谁取代了它"这个关系的事实本体
 * 在领域事件里（计划书第 71 节）。
 */
async function supersedesOf(db: RawDb, memoryId: string): Promise<MemoryId[]> {
  const rows = await exec(
    db,
    sql`select l.memory_id from memory_events l
        join character_domain_events e on e.id = l.domain_event_id
        where e.type = 'MEMORY_SUPERSEDED'
          and e.payload->>'supersededBy' = ${memoryId}
        order by l.memory_id`,
    '读取 supersedes 关系'
  )
  return rows
    .map((r) => String(r.memory_id))
    .filter((id) => id !== memoryId)
    .map((id) => asMemoryId(id))
}

/**
 * 读出索引表并拼成完整记录。
 *
 * 在**事务外**调用没有并发问题：这些表只在 `apply()` 的事务里被改，
 * 而单进程内的读写不会交错（M4 的写入是同步的，后台 Job 也串行）。
 */
async function hydrate(db: RawDb, row: MemoryRow): Promise<MemoryRecord> {
  const base = rowToRecordBase(row)
  const memoryId = String(row.id)

  const subjectRows = await exec(
    db,
    sql`select subject_kind, subject_id from memory_subject_links
        where memory_id = ${memoryId} order by subject_kind, subject_id`,
    '读取 subject 索引'
  )
  const subjects: EntityRef[] = subjectRows.map((r) =>
    entityRef(String(r.subject_kind) as EntityRef['kind'], String(r.subject_id))
  )

  const evidenceRows = await exec(
    db,
    sql`select evidence_kind, evidence_id, is_root from memory_evidence_links
        where memory_id = ${memoryId} order by evidence_id`,
    '读取 evidence 索引'
  )
  const sourceRefs: EvidenceRef[] = evidenceRows.map((r) =>
    evidenceRef(String(r.evidence_kind) as EvidenceKind, String(r.evidence_id))
  )
  const evidenceRootIds = evidenceRows
    .filter((r) => r.is_root === true || r.is_root === 'true')
    .map((r) => String(r.evidence_id))

  const supersedes = await supersedesOf(db, memoryId)

  return {
    ...base,
    subjects,
    sourceRefs,
    evidenceRootIds,
    ...(supersedes.length > 0 ? { supersedes } : {}),
  }
}

async function rawGet(db: RawDb, id: MemoryId): Promise<MemoryRecord | null> {
  const rows = await exec(
    db,
    sql`select * from memory_records where id = ${String(id)} limit 1`,
    `读取 Memory ${String(id)}`
  )
  const raw = firstMemoryRow(rows)
  return raw ? hydrate(db, raw) : null
}

/**
 * **批量版 `hydrate`**（M9 线 N+1 收口；登记册 §0p `R-48`）。
 *
 * ⚠️ 与逐个 `hydrate()` **逐条等价**：同一个 `rowToRecordBase`（因此同一条守卫）、
 *    同样三张索引表、同一种排序，只是把 `3n` 次查询压成 **3 次**。
 *    `supersedes` 的关联条件与 `supersedesOf()` 一致（按 `payload->>'supersededBy'`
 *    反查、排除自身、按 `memory_id` 升序）。
 */
async function hydrateMany(db: RawDb, rows: readonly MemoryRow[]): Promise<Map<string, MemoryRecord>> {
  const hydrated = new Map<string, MemoryRecord>()
  if (rows.length === 0) return hydrated
  const ids = rows.map((row) => String(row.id))
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )

  const subjectRows = await exec(
    db,
    sql`select memory_id, subject_kind, subject_id from memory_subject_links
        where memory_id in (${idList}) order by memory_id, subject_kind, subject_id`,
    '批量读取 subject 索引'
  )
  const evidenceRows = await exec(
    db,
    sql`select memory_id, evidence_kind, evidence_id, is_root from memory_evidence_links
        where memory_id in (${idList}) order by memory_id, evidence_id`,
    '批量读取 evidence 索引'
  )
  const supersedesRows = await exec(
    db,
    sql`select l.memory_id, e.payload->>'supersededBy' as superseded_by from memory_events l
        join character_domain_events e on e.id = l.domain_event_id
        where e.type = 'MEMORY_SUPERSEDED'
          and e.payload->>'supersededBy' in (${idList})
        order by l.memory_id`,
    '批量读取 supersedes 关系'
  )

  const subjectsOf = new Map<string, EntityRef[]>()
  for (const row of subjectRows) {
    const key = String(row.memory_id)
    const list = subjectsOf.get(key) ?? []
    list.push(entityRef(String(row.subject_kind) as EntityRef['kind'], String(row.subject_id)))
    subjectsOf.set(key, list)
  }
  const sourceRefsOf = new Map<string, EvidenceRef[]>()
  const rootsOf = new Map<string, string[]>()
  for (const row of evidenceRows) {
    const key = String(row.memory_id)
    const refs = sourceRefsOf.get(key) ?? []
    refs.push(evidenceRef(String(row.evidence_kind) as EvidenceKind, String(row.evidence_id)))
    sourceRefsOf.set(key, refs)
    if (row.is_root === true || row.is_root === 'true') {
      const roots = rootsOf.get(key) ?? []
      roots.push(String(row.evidence_id))
      rootsOf.set(key, roots)
    }
  }
  const supersedesByOwner = new Map<string, MemoryId[]>()
  for (const row of supersedesRows) {
    const owner = String(row.memory_id)
    const supersededBy = String(row.superseded_by ?? '')
    if (supersededBy === '' || supersededBy === owner) continue
    const list = supersedesByOwner.get(supersededBy) ?? []
    list.push(asMemoryId(owner))
    supersedesByOwner.set(supersededBy, list)
  }

  for (const row of rows) {
    const key = String(row.id)
    const supersedes = supersedesByOwner.get(key) ?? []
    hydrated.set(key, {
      ...rowToRecordBase(row),
      subjects: subjectsOf.get(key) ?? [],
      sourceRefs: sourceRefsOf.get(key) ?? [],
      evidenceRootIds: rootsOf.get(key) ?? [],
      ...(supersedes.length > 0 ? { supersedes } : {}),
    })
  }
  return hydrated
}

/** 批量读（返回顺序 = 入参顺序；不存在的 id 给 `null`，与 `get()` 同） */
async function rawGetMany(db: RawDb, ids: readonly MemoryId[]): Promise<(MemoryRecord | null)[]> {
  if (ids.length === 0) return []
  const unique = [...new Set(ids.map((id) => String(id)))]
  const idList = sql.join(
    unique.map((id) => sql`${id}`),
    sql`, `
  )
  const rows = await exec(
    db,
    sql`select * from memory_records where id in (${idList})`,
    '批量读取 Memory'
  )
  const parsedRows = rows
    .map((row) => firstMemoryRow([row]))
    .filter((row): row is MemoryRow => row !== undefined)
  const hydrated = await hydrateMany(db, parsedRows)
  return ids.map((id) => hydrated.get(String(id)) ?? null)
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createNativeMemoryStore(db: RawDb): MemoryStorePort {
  return {
    async get(id) {
      return rawGet(db, id)
    },

    async getMany(ids) {
      return rawGetMany(db, ids)
    },

    async getActiveByCanonicalKey(key) {
      const rows = await exec(
        db,
        sql`select * from memory_records
            where canonical_key = ${key} and status = 'active'
            order by recorded_at asc`,
        '按 canonical key 查当前记忆'
      )
      return Promise.all(asRows<MemoryRow>(rows).map((row) => hydrate(db, row)))
    },

    async getActiveByFingerprint(owner, fingerprint) {
      const rows = await exec(
        db,
        sql`select * from memory_records
            where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
              and content_fingerprint = ${fingerprint} and status = 'active'
            limit 1`,
        '按内容指纹查当前记忆'
      )
      const raw = firstMemoryRow(rows)
      return raw ? hydrate(db, raw) : null
    },

    async listByCanonicalKey(key) {
      const rows = await exec(
        db,
        sql`select * from memory_records
            where canonical_key = ${key}
            order by recorded_at asc`,
        '按 canonical key 列出全部记忆（含历史）'
      )
      return Promise.all(memoryRows(rows).map((row) => hydrate(db, row)))
    },

    async listBySubject(owner, subject) {
      const rows = await exec(
        db,
        sql`select r.* from memory_records r
            join memory_subject_links l on l.memory_id = r.id
            where r.owner_kind = ${owner.kind} and r.owner_id = ${String(owner.id)}
              and l.subject_kind = ${subject.kind} and l.subject_id = ${String(subject.id)}
            order by r.recorded_at asc`,
        '按 subject 查记忆'
      )
      return Promise.all(memoryRows(rows).map((row) => hydrate(db, row)))
    },

    async listBySource(ref) {
      const rows = await exec(
        db,
        sql`select r.* from memory_records r
            join memory_evidence_links l on l.memory_id = r.id
            where l.evidence_kind = ${ref.kind} and l.evidence_id = ${ref.id}
            order by r.recorded_at asc`,
        '按来源反查记忆'
      )
      return Promise.all(memoryRows(rows).map((row) => hydrate(db, row)))
    },

    async list(scope) {
      const limit = Math.max(1, Math.min(500, scope.limit ?? 50))
      const rows = await exec(
        db,
        sql`select * from memory_records
            where owner_kind = ${scope.owner.kind} and owner_id = ${String(scope.owner.id)}
              ${scope.status === undefined ? sql`` : sql`and status = ${scope.status}`}
              ${scope.type === undefined ? sql`` : sql`and memory_type = ${scope.type}`}
            order by recorded_at desc
            limit ${limit}`,
        '列出记忆'
      )
      return Promise.all(memoryRows(rows).map((row) => hydrate(db, row)))
    },

    async history(id) {
      return domainEventsForMemory(db, id)
    },

    async apply(event) {
      return applyMemoryEvent(db, event)
    },

    async rebuildMemory(id) {
      return rebuildMemory(db, id)
    },

    async rebuildCharacterMemories(owner) {
      const rows = await exec(
        db,
        sql`select id from memory_records
            where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
            order by recorded_at asc`,
        '列出待重建的记忆'
      )
      const details: MemoryRebuildResult[] = []
      for (const row of rows) {
        details.push(await rebuildMemory(db, asMemoryId(String(row.id))))
      }
      return {
        owner,
        memories: rows.length,
        rebuilt: details.length,
        mismatched: details.filter((d) => !d.equal).length,
        details,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 只读追加查询（M6.1 WP5 / B① / ADR-058）—— reducer 语义一个字未动
// ---------------------------------------------------------------------------

/**
 * **会话内该用户最近的显式写入**（correct 目标层兜底的读取口）。
 *
 * 契约（与 `ExplicitMemoryServiceDeps.recentExplicitWrites` 逐字对应）：
 *   · "同一会话" = 候选的证据对话事件与 `triggerEventId` 的 `conversation_id` 相同；
 *   · "显式写入" = `processor = 'explicit-memory'`（`buildCandidate` 的固定值；
 *     后台管线是 `memory-extractor`，**不进**候选）；
 *   · 只取 **ACTIVE**（superseded / retracted 不是"现在的值"）；
 *   · 只取 `subjects` 含 `speaker` 的（"这个用户"的写入）；
 *   · 按 `recorded_at` **降序**（最近的在前），上限 `limit`（缺省 50）。
 *
 * ⚠️ 纯只读：本函数不写任何表；`triggerEventId` 查不到时返回**空数组**
 *    （诚实：没有候选，由上层维持 `target_not_found`，而不是放宽范围）。
 */
export async function listRecentExplicitWrites(
  db: RawDb,
  input: {
    owner: EntityRef
    speaker: EntityRef
    triggerEventId: string
    limit?: number
  }
): Promise<MemoryRecord[]> {
  const limit = Math.max(1, Math.min(500, input.limit ?? 50))
  const rows = await exec(
    db,
    sql`select distinct r.* from memory_records r
        join memory_evidence_links l on l.memory_id = r.id
        join conversation_events e on e.id = l.evidence_id
        where l.evidence_kind = 'conversation_event'
          and e.conversation_id = (
            select ce.conversation_id from conversation_events ce
            where ce.id = ${input.triggerEventId} limit 1
          )
          and r.owner_kind = ${input.owner.kind} and r.owner_id = ${String(input.owner.id)}
          and r.processor = 'explicit-memory'
          and r.status = 'active'
        order by r.recorded_at desc
        limit ${limit}`,
    '按会话列出该用户最近的显式写入（B① 兜底读取口）'
  )
  const records = await Promise.all(memoryRows(rows).map((row) => hydrate(db, row)))
  return records.filter((record) =>
    record.subjects.some(
      (subject) =>
        subject.kind === input.speaker.kind && String(subject.id) === String(input.speaker.id)
    )
  )
}

// ---------------------------------------------------------------------------
// apply —— 唯一的状态变更入口（计划书第 71 / 159 节）
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 *  为什么 `apply` 收的是**已经落库的领域事件**而不是一个"待写入的变更"
 * ============================================================================
 * 计划书第 71 节禁止应用层做：
 *
 *     repository.update(memory)     ← 绕过事件
 *
 * 因此这个函数的形状被刻意设计成"事件已经存在，我把它折叠进投影"。
 * 事件的写入由调用方经 `appendDomainEvent()` 完成（与诊断链路**同一个**函数），
 * 于是"MEMORY_* 进 character_domain_events"与其它领域事件走同一条路，
 * 不可能是"另一套写法"。
 *
 * `apply` 对同一个事件调用第二次时行为是：不改变状态、返回 `created: false`。
 * 这就是计划书第 68–69 / 186 节要的幂等（Duplicate Worker 场景）。
 */
export async function applyMemoryEvent(
  db: RawDb,
  event: DomainEvent,
  now: number = Date.now()
): Promise<MemoryApplyResult> {
  const memoryId = memoryIdOfEvent(event)
  if (memoryId === undefined) {
    throw new KernelError(
      'validation_error',
      'memory_event_without_memory_id',
      `${event.type} 的 payload 里没有 memoryId / winnerId —— ` +
        '不知道它改哪条记忆的事件无法被折叠进任何投影',
      { domainEventId: String(event.id), type: event.type }
    )
  }

  return inTransaction(db, async (tx) => {
    // --- ① 这条事件是否已经折叠过（幂等的快路径）-------------------------
    const existing = await exec(
      tx,
      sql`select 1 as one from memory_events
          where memory_id = ${String(memoryId)} and domain_event_id = ${String(event.id)}
          limit 1`,
      '检查事件是否已折叠'
    )

    await appendMemoryEventLink(tx, memoryId, event)

    const current = await rawGet(tx, memoryId)

    if (existing.length > 0) {
      // 已经折叠过：不重复 reduce（否则 revision 会叠加，而 Replay 会算不出来）
      return { event, created: false, record: current }
    }

    if (current !== null && current.reducerVersion !== MEMORY_REDUCER_VERSION) {
      throw new KernelError(
        'validation_error',
        'memory_reducer_version_mismatch',
        `记忆 ${String(memoryId)} 是用 ${current.reducerVersion} 算的，` +
          `当前 reducer 是 ${MEMORY_REDUCER_VERSION}。请先 rebuildMemory（计划书第 24 / 29 节）`
      )
    }

    // --- ② 纯 reduce（事务里只有计算，没有 LLM / 网络 / 遥测）------------
    const result = reduceMemory(current, event)
    const next = result.record

    if (next === null) {
      // reducer 把它变成了"不存在"。M4 没有这种事件，但保留这条分支：
      // 未来若加"物理删除"类事件，它会从这里走，而不是静默什么都不做。
      return { event, created: true, record: null }
    }

    // --- ③ 乐观锁写投影 + 索引 ------------------------------------------
    const persisted: MemoryRecord = {
      ...next,
      revision: current === null ? 1 : current.revision + 1,
    }

    if (current === null) {
      await insertRecord(tx, persisted, now)
    } else {
      await updateRecordWithLock(tx, persisted, current.revision, now)
    }
    await replaceLinks(tx, persisted)

    const saved = await rawGet(tx, memoryId)
    return { event, created: true, record: saved }
  })
}

/**
 * 按 memoryId 取它的全部领域事件（升序）。
 *
 * 走 `memory_events` 索引表 join `character_domain_events` ——
 * 这是"只取一条记忆的事件"的**唯一**实现，也是 `rebuildMemory` 的前提
 * （审计 §5 F1 里 `memory_events` 存在的理由）。
 *
 * 行映射复用 `event-store.ts` 导出的 `rowToDomainEvent`：不另写一份，
 * 否则两处的 NULL / 缺列处理会有一天分叉。
 */
export async function domainEventsForMemory(
  db: RawDb,
  memoryId: MemoryId
): Promise<DomainEvent[]> {
  const rows = await exec(
    db,
    sql`select e.* from memory_events l
        join character_domain_events e on e.id = l.domain_event_id
        where l.memory_id = ${String(memoryId)}
        order by e.sequence asc`,
    `读取 Memory ${String(memoryId)} 的事件流`
  )
  return rows
    .map((row) => rowToDomainEvent(row as unknown as Parameters<typeof rowToDomainEvent>[0]))
    .filter((e): e is DomainEvent => e !== undefined)
}

// ---------------------------------------------------------------------------
// Replay（计划书第 73–74 节）
// ---------------------------------------------------------------------------

/**
 * 重建单条记忆并断言 `A == B`。
 *
 * ============================================================================
 *  计划书第 74 节的验收步骤，逐条落地
 * ============================================================================
 *     创建 Memory → 修正 → supersede → 记录最终状态 A
 *     ↓ 删除 Memory Projection
 *     ↓ replay Domain Events
 *     得到状态 B
 *     A == B
 *
 * 实现上**不真的删行再插**（那样中途失败会丢数据），而是：
 *   1. 读出当前投影 → A
 *   2. 用同一份事件流从零重算 → B
 *   3. 若 A ≠ B：说明某次写入与事件流不一致（有人绕过事件改了库，
 *      或者 reducer 的某个分支不是纯函数）—— **报出差异字段**
 *   4. A == B 时用 B 覆盖投影
 *
 * 差异比对会**逐字段**列出不一致的字段名。只报"不相等"是不够的：
 * M4 的 Gate 要求能回答"是哪一步重放不一致"，而不是"它不一致"。
 */
export async function rebuildMemory(
  db: RawDb,
  memoryId: MemoryId,
  now: number = Date.now()
): Promise<MemoryRebuildResult> {
  const before = await rawGet(db, memoryId)
  const events = await domainEventsForMemory(db, memoryId)
  const replayed = replayMemory(events, memoryId)

  /*
   * ⚠️ `supersedes` 在**事件流之外**：它来自**别的**记忆的 SUPERSEDED 事件
   * （"谁的 supersededBy 指着我"）。因此重放要把它补上，否则重放结果
   * 会永远比读路径少一个字段 —— 而那正是 `A == B` 这条 Gate 抓到的东西。
   */
  const supersedes = await supersedesOf(db, String(memoryId))
  const replayedRecord = replayed.record
  const after: MemoryRecord | null =
    replayedRecord === null
      ? null
      : {
          ...replayedRecord,
          ...(supersedes.length > 0 ? { supersedes } : { supersedes: undefined }),
        }

  const differences = compareRecords(before, after)

  if (differences.length === 0 && after !== null) {
    await inTransaction(db, async (tx) => {
      const current = await rawGet(tx, memoryId)
      // 重放出的 revision 起点与写入不同（见 compareRecords 的说明），
      // 因此这里**保留库里当前的 revision**，只把状态对齐到重放结果。
      const aligned: MemoryRecord = { ...after, revision: current?.revision ?? after.revision }
      if (current === null) {
        await insertRecord(tx, aligned, now)
      } else {
        await updateRecordWithLock(tx, aligned, current.revision, now)
      }
      await replaceLinks(tx, aligned)
    })
  }

  return {
    memoryId,
    before,
    after,
    appliedEvents: replayed.appliedEvents,
    equal: differences.length === 0,
    differences,
  }
}

/**
 * 逐字段比对两条记录（`null` 表示"不存在"）。
 *
 * 比对的字段集合覆盖**契约里的全部持久化字段**：少比一个字段就会让
 * "某个字段的重建是错的"悄悄通过 Gate。
 *
 * 刻意**不比** `revision`：它由"折叠了几个事件"决定，
 * 而重算时的起点是 0、写入时是 1 —— 两者的语义起点不同
 * （`applyCreated` 把新建的 revision 显式设为 1），
 * 那个差别不是缺陷，而是"投影被写过几次"与"事件流有多长"的区别。
 */
function compareRecords(a: MemoryRecord | null, b: MemoryRecord | null): string[] {
  if (a === null && b === null) return []
  if (a === null || b === null) return ['存在性（一条不存在）']

  const differences: string[] = []
  const scalar = (name: keyof MemoryRecord, normalize?: (v: unknown) => unknown) => {
    const va = normalize ? normalize(a[name]) : a[name]
    const vb = normalize ? normalize(b[name]) : b[name]
    if (JSON.stringify(va) !== JSON.stringify(vb)) differences.push(String(name))
  }

  scalar('id')
  scalar('type')
  scalar('status')
  scalar('epistemicStatus')
  scalar('authority')
  scalar('importance')
  scalar('confidence')
  scalar('canonicalKey')
  scalar('contentFingerprint')
  scalar('validFrom')
  // undefined 与 null 在契约里是**不同状态**，因此归一化时保持它们可区分
  scalar('validUntil', (v) => (v === undefined ? '__undefined__' : v === null ? '__null__' : v))
  scalar('occurredAt')
  scalar('recordedAt')
  scalar('supersededBy')
  scalar('reducerVersion')
  scalar('content')
  scalar('processor')
  scalar('processorVersion')

  // 集合语义的字段：排序后比对（顺序不是语义）
  const setLike = (name: 'subjects' | 'sourceRefs' | 'evidenceRootIds' | 'supersedes') => {
    const norm = (v: unknown) =>
      Array.isArray(v)
        ? [...v]
            .map((item) =>
              typeof item === 'object' && item !== null
                ? `${(item as EntityRef).kind}:${
                    (item as EntityRef).id ?? (item as EvidenceRef).id
                  }`
                : String(item)
            )
            .sort()
        : []
    if (JSON.stringify(norm(a[name])) !== JSON.stringify(norm(b[name]))) {
      differences.push(String(name))
    }
  }
  setLike('subjects')
  setLike('sourceRefs')
  setLike('evidenceRootIds')
  setLike('supersedes')

  return differences
}

// ---------------------------------------------------------------------------
// 统计（计划书第 164 节）
// ---------------------------------------------------------------------------

export interface MemoryCounts {
  total: number
  active: number
  superseded: number
  retracted: number
  disputed: number
}

export async function memoryCounts(db: RawDb, owner: EntityRef): Promise<MemoryCounts> {
  const rows = await exec(
    db,
    sql`select status, count(*)::int as c from memory_records
        where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
        group by status`,
    '统计记忆状态'
  )
  const byStatus = new Map<string, number>()
  for (const row of rows) byStatus.set(String(row.status), Number(row.c))

  const total = [...byStatus.values()].reduce((sum, n) => sum + n, 0)
  return {
    total,
    active: byStatus.get('active') ?? 0,
    superseded: byStatus.get('superseded') ?? 0,
    retracted: byStatus.get('retracted') ?? 0,
    disputed: byStatus.get('disputed') ?? 0,
  }
}

/** 按 processor 版本计数（计划书第 67 节的 audit / reprocess 入口） */
export async function countByProcessorVersion(
  db: RawDb,
  owner: EntityRef
): Promise<{ processor: string; version: string; count: number }[]> {
  const rows = await exec(
    db,
    sql`select coalesce(processor, '(none)') as processor,
                coalesce(processor_version, '(none)') as version,
                count(*)::int as c
         from memory_records
         where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
         group by processor, processor_version
         order by c desc`,
    '按 processor 版本统计'
  )
  return rows.map((r) => ({
    processor: String(r.processor),
    version: String(r.version),
    count: Number(r.c),
  }))
}

// ---------------------------------------------------------------------------
// 审计探针（计划书第 169–170 节）
// ---------------------------------------------------------------------------

/**
 * 每条正式 Memory 至少有一个合法 Evidence root（MI-03 / 计划书第 170 节）。
 *
 * 计划书第 170 节把这条列成**非常重要的 Gate**：
 *
 *     随机抽查正式 Memory：是否能找到合法 Evidence。
 *     目标：0 unsupported memories
 *
 * 因此它不只写在测试里，而是作为一个可被反复调用的查询：
 * `pnpm memory:audit` 与 `m4:verify` 都用它。
 */
export async function unsupportedMemories(
  db: RawDb,
  owner: EntityRef
): Promise<{ memoryId: string; reason: string }[]> {
  const rows = await exec(
    db,
    sql`select r.id,
               (select count(*)::int from memory_evidence_links l
                 where l.memory_id = r.id and l.is_root) as root_count,
               (select count(*)::int from memory_evidence_links l
                 where l.memory_id = r.id) as link_count
        from memory_records r
        where r.owner_kind = ${owner.kind} and r.owner_id = ${String(owner.id)}`,
    '抽查没有证据的记忆'
  )

  const problems: { memoryId: string; reason: string }[] = []
  for (const row of rows) {
    const memoryId = String(row.id)
    if (Number(row.link_count) === 0) {
      problems.push({ memoryId, reason: '没有任何 evidence link' })
    } else if (Number(row.root_count) === 0) {
      problems.push({ memoryId, reason: '有证据但没有一个被标记为 root（计划书第 40 节）' })
    }
  }
  return problems
}

/**
 * 反污染抽查（计划书第 169 节）。
 *
 *     核心指标：Assistant-generated claims incorrectly promoted to user facts
 *     目标：0
 *
 * 这条**不靠 LLM 判断**，而是靠数据本身：一条 `person_fact` / `preference`
 * 若它的 authority 不是 `EXPLICIT_USER_STATEMENT` / `EXPLICIT_CORRECTION`，
 * 那它就是一次污染 —— 而写入路径的断言本该拦住它。
 * 因此这里的作用是**第二道探针**：万一有人绕过断言写了库，
 * 这个查询会让它出现在审计报告里，而不是静静躺在那。
 */
/**
 * M5.1.1 / Phase 4b（ADR-043 `DR-9`）—— **第二个只读探针**。
 *
 * ⚠️ 既有探针 `contaminatedMemories()` 的判据**一个字节都没改**（`N-5` 要求它仍为 0）。
 *    新探针问的是**另一个问题**："这条用户事实**今天的来源资格**是已确立吗？"
 *    —— 它**不是污染**：真库今天全部 2 条都会落在这里，
 *    而那正是 D01 想要的**诚实**状态（`DR-12` 之前不许关闭 D01）。
 *
 * 实现住在 `qualification-read.ts`（读路径只有一处，避免与召回各判一套）；
 * 这里只做**转出**，让"新增的探针"与既有探针在**同一个入口**可见。
 */
export {
  unqualifiedUserFacts,
  qualificationsForMemories,
  rootReadingsByMemory,
  type UnqualifiedUserFact,
  type QualificationReport,
} from './qualification-read.ts'

export async function contaminatedMemories(
  db: RawDb,
  owner: EntityRef
): Promise<{ memoryId: string; authority: string; type: string }[]> {
  const rows = await exec(
    db,
    sql`select id, authority, memory_type from memory_records
        where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
          and memory_type in ('person_fact', 'preference')
          and authority not in ('EXPLICIT_USER_STATEMENT', 'EXPLICIT_CORRECTION')`,
    '抽查被污染的用户事实'
  )
  return rows.map((r) => ({
    memoryId: String(r.id),
    authority: String(r.authority),
    type: String(r.memory_type),
  }))
}

/**
 * 便于诊断：把一条记录压成一行摘要（**不含正文**，可以安全进 trace）。
 *
 * 用途是 `kernel:status` 与 `memory list` 这类"一眼看全局"的入口 ——
 * 计划书第 110 节要求 trace 里只发计数、类型、状态、id，
 * **不默认发 Memory 正文**。这个函数就是那条规矩的落地点之一。
 */
export function summarizeRecord(record: MemoryRecord): string {
  return (
    `${String(record.id)} [${record.type}/${record.status}] ` +
    `authority=${record.authority} imp=${record.importance.toFixed(2)} ` +
    `conf=${record.confidence.toFixed(2)} subjects=${record.subjects.length} ` +
    `evidence=${record.sourceRefs.length}`
  )
}
