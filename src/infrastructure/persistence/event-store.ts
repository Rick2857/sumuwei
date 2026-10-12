/**
 * DomainEvent + Projection 仓储，以及**唯一**的变更链执行处。
 *
 * ============================================================================
 *  plan 第 66/67 节：事务边界
 * ============================================================================
 * 以下三件事必须原子完成（要么全成、要么全不成）：
 *
 *     接受 Proposal  →  创建 DomainEvent  →  更新对应 Projection
 *
 * 推荐实现是单事务：validate → insert domain event → reduce → update projection → commit。
 * 前提是 Reducer 是**纯本地计算**（plan 第 25 节），因此事务里没有 LLM、没有网络。
 *
 * LLM 调用与事务严格分离：
 *
 *     LLM → Proposal
 *     ─────────── transaction ───────────
 *     Validator → DomainEvent → Projection
 *     ─────────── commit ───────────────
 *
 * 禁止 `BEGIN → 调用 LLM 20 秒 → 写库 → COMMIT`。
 */

import { sql } from 'drizzle-orm'

import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  DOMAIN_EVENT_SCOPE,
  KernelError,
  applyEvent,
  defaultIsStale,
  emptyProjection,
  type CharacterId,
  type CharacterProjection,
  type DomainEvent,
  type DomainEventId,
  type ProjectionReducer,
  type Timestamp,
  asCharacterId,
  asDomainEventId,
  asConversationEventId,
  entityRef,
  makeDomainEventId,
} from '../../kernel/contracts/index.ts'
import type { AcceptedDomainEvent } from '../../kernel/policies/validator.ts'
import { affectedRows, asRows, exec, firstRow, inTransaction, type RawDb } from './db.ts'
import { allocateSequence } from './sequence.ts'
import { recordProcessedOperation } from './job-store.ts'
/*
 * M5-PRE：`resetKernelData` 必须把**记忆侧**一起清干净（详见 memory-integrity.ts 的文件头）。
 * 放在单独一个模块是为了避开 `memory-store.ts → event-store.ts` 这条既有依赖的**反向**
 * 引用（循环 import 在 ESM 下"有时能跑"，是最难查的一类）。
 */
import {
  cleanupMemorySideOfReset,
  memoryIntegrityProblems,
} from './memory-integrity.ts'

// ---------------------------------------------------------------------------
// DomainEvent
// ---------------------------------------------------------------------------

interface DomainEventRow {
  id: string
  character_id: string
  sequence: number
  type: string
  source_conversation_event_ids: unknown
  primary_source_event_id: string
  caused_by_domain_event_ids: unknown
  payload: unknown
  processor: string
  processor_version: string
  idempotency_key: string
  schema_version: number
  created_at: number
  // --- M3.5（迁移 0004）：时间模型。旧行为 null -----------------------------
  occurred_at?: number | null
  logical_time?: string | null
}

/**
 * 行 → `DomainEvent`。
 *
 * M4 起被 `memory-store.ts` 复用（`domainEventsForMemory` 的 join 结果
 * 与这里的行形状完全一致）。**刻意导出而不是让 M4 另写一份**：
 * 两处的 NULL / 缺列处理（尤其是 0004 加的 `occurred_at` / `logical_time`
 * 与"旧行为 null"）一旦分叉，就会出现"同一行按两条路读出来不一样"的缺陷，
 * 而那种缺陷在 trace 上看起来完全正常。
 */
export function rowToDomainEvent(row: DomainEventRow | undefined): DomainEvent | undefined {
  if (!row) return undefined
  const sources = Array.isArray(row.source_conversation_event_ids)
    ? (row.source_conversation_event_ids as string[])
    : []
  const causedBy = Array.isArray(row.caused_by_domain_event_ids)
    ? (row.caused_by_domain_event_ids as string[])
    : undefined

  return {
    id: asDomainEventId(String(row.id)),
    characterId: asCharacterId(String(row.character_id)),
    sequence: Number(row.sequence),
    type: String(row.type),
    sourceConversationEventIds: sources.map((s) => asConversationEventId(s)),
    causedByDomainEventIds: causedBy?.map((s) => asDomainEventId(s)),
    payload: row.payload,
    processor: String(row.processor),
    processorVersion: String(row.processor_version),
    idempotencyKey: String(row.idempotency_key),
    schemaVersion: Number(row.schema_version),
    createdAt: Number(row.created_at),
    // M3.5：scope 是**派生常量**而不是列 —— 能进这张表的领域事件
    // 都已经被 Validator 用 `assertCharacterInternalScope` 校验过
    // （`policies/validator.ts` 是唯一受理点），因此这里不需要再问一次。
    scope: DOMAIN_EVENT_SCOPE,
    ...(row.occurred_at !== null && row.occurred_at !== undefined
      ? { occurredAt: Number(row.occurred_at) }
      : {}),
    ...(row.logical_time !== null && row.logical_time !== undefined
      ? { logicalTime: String(row.logical_time) }
      : {}),
  }
}

export interface AppendDomainResult {
  event: DomainEvent
  /** false = 幂等命中，本次没有新建 */
  created: boolean
}

/**
 * 写入一条已被 Validator 接受的领域事件。
 *
 * 幂等策略是**双保险**：
 *   1. 写入前按 idempotency_key 探测（快路径，避免消耗序号）
 *   2. 依赖 `character_domain_events_idempotency_unique` 唯一约束兜底并发
 *
 * 之所以还要第 2 层：探测与插入之间有窗口。plan 第 22 节说得很清楚——
 * "网络断开后重跑不能生成两份完全相同的记忆"，而重跑恰恰最可能与
 * 原任务并发（用户重开了进程）。
 */
export async function appendDomainEvent(
  db: RawDb,
  characterId: CharacterId,
  accepted: AcceptedDomainEvent,
  now: number = Date.now()
): Promise<AppendDomainResult> {
  const existing = await findDomainEventByIdempotencyKey(db, accepted.idempotencyKey)
  if (existing) return { event: existing, created: false }

  const sequence = await allocateSequence(db, characterId)
  const id = makeDomainEventId(characterId, sequence)

  /*
   * M11（ADR-085 `D25`）：派生链落盘。
   *
   * 在 M11 之前这一列**恒为 null**（字段预留、链路未通）。现在：
   *   · 调用者没给 ⇒ 仍然写 **null**（旧调用者行为逐字不变，不补写历史事件）；
   *   · 调用者给了（已被 Validator 校验过父事件存在且同角色）⇒ 写 id 数组。
   *
   * ⚠️ 传 `null` 而不是 `undefined` 是**必须的**：drizzle 会把 `undefined` 渲染成
   *    空表达式，SQL 直接语法错误（本文件 `primary_source_event_id` 那条注释记着同款坑）。
   */
  const causedByJson =
    accepted.causedByDomainEventIds === undefined
      ? null
      : JSON.stringify(accepted.causedByDomainEventIds)

  const inserted = await exec(
    db,
    sql`insert into character_domain_events
          (id, character_id, sequence, type, source_conversation_event_ids,
           primary_source_event_id, caused_by_domain_event_ids, payload,
           processor, processor_version, idempotency_key, schema_version, created_at,
           occurred_at, logical_time)
        values (${id}, ${characterId}, ${sequence}, ${accepted.type},
                ${JSON.stringify(accepted.sourceConversationEventIds)}::jsonb,
                -- M7 集成发现：无来源事件（RELATIONSHIP_ORIGIN 的凭据是授权不是对话，
                -- ADR-064 冻结形状 = 空 sourceConversationEventIds）必须落 '' 而不是
                -- undefined——drizzle 会把 undefined 渲染成空表达式，SQL 直接语法错误。
                -- 该列是纯索引列（rowToDomainEvent 不读它），'' = "无主来源"。
                ${accepted.sourceConversationEventIds[0] ?? ''},
                ${causedByJson}::jsonb,
                ${JSON.stringify(accepted.payload)}::jsonb,
                ${accepted.processor}, ${accepted.processorVersion},
                ${accepted.idempotencyKey}, ${DOMAIN_EVENT_SCHEMA_VERSION}, ${now},
                ${accepted.occurredAt ?? null}, ${accepted.logicalTime ?? null})
        on conflict (idempotency_key) do nothing
        returning *`,
    '写入 DomainEvent'
  )

  if (inserted.length > 0) {
    return { event: rowToDomainEvent(firstRow<DomainEventRow>(inserted))!, created: true }
  }

  const raced = await findDomainEventByIdempotencyKey(db, accepted.idempotencyKey)
  if (raced) return { event: raced, created: false }

  throw new KernelError(
    'persistence_error',
    'domain_event_append_conflict',
    `DomainEvent 写入冲突且无法回读：idempotencyKey=${accepted.idempotencyKey}`
  )
}

export async function findDomainEventByIdempotencyKey(
  db: RawDb,
  key: string
): Promise<DomainEvent | undefined> {
  const rows = await exec(
    db,
    sql`select * from character_domain_events where idempotency_key = ${key} limit 1`,
    '按幂等键读取 DomainEvent'
  )
  return rowToDomainEvent(firstRow<DomainEventRow>(rows))
}

export async function getDomainEvent(
  db: RawDb,
  id: DomainEventId
): Promise<DomainEvent | undefined> {
  const rows = await exec(
    db,
    sql`select * from character_domain_events where id = ${id} limit 1`,
    '读取 DomainEvent'
  )
  return rowToDomainEvent(firstRow<DomainEventRow>(rows))
}

/**
 * 按类型读取某角色的全部领域事件（Replay 的输入），按序号升序。
 *
 * `beforeSequence` 用于"重放到某一刻"——这是 M11 排查
 * "她是在哪一轮开始变成这样的"时最有用的一个能力。
 *
 * `afterSequence`（M9 WP3 追加，**严格大于**）用于变更流增量读：
 * belief-memory 回查协调器（WP5）按"上次看过的最大序号"拉新事件，
 * 不重扫全量。与 `beforeSequence` 可同时给出（开区间）。
 */
export async function domainEventsFor(
  db: RawDb,
  characterId: CharacterId,
  options: {
    type?: string
    beforeSequence?: number
    afterSequence?: number
    limit?: number
  } = {}
): Promise<DomainEvent[]> {
  const limit = Math.max(1, Math.min(100000, options.limit ?? 100000))
  const rows = await exec(
    db,
    sql`select * from character_domain_events
        where character_id = ${characterId}
          ${options.type === undefined ? sql`` : sql`and type = ${options.type}`}
          ${options.beforeSequence === undefined ? sql`` : sql`and sequence <= ${options.beforeSequence}`}
          ${options.afterSequence === undefined ? sql`` : sql`and sequence > ${options.afterSequence}`}
        order by sequence asc
        limit ${limit}`,
    '读取领域事件'
  )
  return asRows<DomainEventRow>(rows).map((r) => rowToDomainEvent(r)!)
}

export async function countDomainEvents(
  db: RawDb,
  characterId: CharacterId,
  type?: string
): Promise<number> {
  const rows = await exec(
    db,
    sql`select count(*)::int as c from character_domain_events
        where character_id = ${characterId}
          ${type === undefined ? sql`` : sql`and type = ${type}`}`,
    '统计领域事件'
  )
  return Number(rows[0]?.c ?? 0)
}

export interface DomainEventSourceLink {
  domainEventId: DomainEventId
  conversationEventId: string
  domainEventType: string
  processor: string
  processorVersion: string
  createdAt: number
}

/** 反查：某个对话事件引起过哪些角色变化（审计链的第二跳） */
export async function domainEventsFromConversationEvent(
  db: RawDb,
  conversationEventId: string
): Promise<DomainEventSourceLink[]> {
  const rows = await exec(
    db,
    sql`select id, primary_source_event_id, type, processor, processor_version, created_at
        from character_domain_events
        where primary_source_event_id = ${conversationEventId}
        order by sequence asc`,
    '反查领域事件来源'
  )
  return rows.map((r) => ({
    domainEventId: asDomainEventId(String(r.id)),
    conversationEventId: String(r.primary_source_event_id),
    domainEventType: String(r.type),
    processor: String(r.processor),
    processorVersion: String(r.processor_version),
    createdAt: Number(r.created_at),
  }))
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface ProjectionRow {
  character_id: string
  projection_type: string
  revision: number
  reducer_version: string
  last_domain_event_id: string | null
  last_domain_event_sequence: number | null
  state: unknown
  updated_at: number
}

function rowToProjection<TState>(row: ProjectionRow | undefined): CharacterProjection<TState> | undefined {
  if (!row) return undefined
  return {
    characterId: asCharacterId(String(row.character_id)),
    projectionType: String(row.projection_type),
    revision: Number(row.revision),
    reducerVersion: String(row.reducer_version),
    lastDomainEventId: row.last_domain_event_id
      ? asDomainEventId(String(row.last_domain_event_id))
      : undefined,
    lastDomainEventSequence:
      row.last_domain_event_sequence === null || row.last_domain_event_sequence === undefined
        ? undefined
        : Number(row.last_domain_event_sequence),
    state: row.state as TState,
    updatedAt: Number(row.updated_at),
  }
}

export async function getProjection<TState>(
  db: RawDb,
  characterId: CharacterId,
  projectionType: string
): Promise<CharacterProjection<TState> | undefined> {
  const rows = await exec(
    db,
    sql`select * from character_projections
        where character_id = ${characterId} and projection_type = ${projectionType}
        limit 1`,
    '读取 Projection'
  )
  return rowToProjection<TState>(firstRow<ProjectionRow>(rows))
}

/**
 * 乐观锁写入。
 *
 * `expectedRevision` 必须与库里当前值一致，否则抛 `revision_conflict`。
 * 这就是"旧 Worker 不能覆盖新 Worker"的落地（plan 第 26 节）：
 * 竞争失败的一方会明确失败，而不是静默覆盖。
 *
 * 实现上先读、后带条件写、再用 `returning` 确认影响行数 —— 不依赖驱动的
 * `affectedRows` 语义（见 db.ts 的说明）。
 */
export async function saveProjection<TState>(
  db: RawDb,
  projection: CharacterProjection<TState>,
  expectedRevision: number,
  now: number = Date.now()
): Promise<void> {
  const current = await getProjection<TState>(db, projection.characterId, projection.projectionType)
  if (!current) {
    throw new KernelError(
      'revision_conflict',
      'projection_missing',
      `Projection ${projection.projectionType} 不存在，无法在其上执行更新（应当走 insert 路径）`,
      { projectionType: projection.projectionType, expectedRevision }
    )
  }
  if (current.revision !== expectedRevision) {
    throw new KernelError(
      'revision_conflict',
      'projection_revision_conflict',
      `Projection ${projection.projectionType} 版本冲突：期望基于 revision=${expectedRevision} 更新，` +
        `库里当前是 revision=${current.revision}。旧任务不允许覆盖新状态（plan 第 26 节）。`,
      {
        projectionType: projection.projectionType,
        expectedRevision,
        actualRevision: current.revision,
      }
    )
  }

  const affected = await affectedRows(
    db,
    sql`update character_projections
        set revision = ${projection.revision},
            reducer_version = ${projection.reducerVersion},
            last_domain_event_id = ${projection.lastDomainEventId ?? null},
            last_domain_event_sequence = ${projection.lastDomainEventSequence ?? null},
            state = ${JSON.stringify(projection.state)}::jsonb,
            updated_at = ${now}
        where character_id = ${projection.characterId}
          and projection_type = ${projection.projectionType}
          and revision = ${expectedRevision}
        returning revision`,
    '更新 Projection'
  )

  if (affected > 0) return

  // 走到这里说明读取之后被别人抢先更新了（同一事务内的并发场景）
  const after = await getProjection<TState>(db, projection.characterId, projection.projectionType)
  throw new KernelError(
    'revision_conflict',
    'projection_revision_conflict',
    `Projection ${projection.projectionType} 在写入瞬间被其它任务更新（revision=${after?.revision ?? '?'}）`,
    {
      projectionType: projection.projectionType,
      expectedRevision,
      actualRevision: after?.revision ?? null,
    }
  )
}

/** 首次写入（revision 0 -> N）。已存在则抛冲突，交给调用方决定是否改走追加。 */
export async function insertProjection<TState>(
  db: RawDb,
  projection: CharacterProjection<TState>,
  now: number = Date.now()
): Promise<void> {
  const rows = await exec(
    db,
    sql`insert into character_projections
          (character_id, projection_type, revision, reducer_version,
           last_domain_event_id, last_domain_event_sequence, state, updated_at)
        values (${projection.characterId}, ${projection.projectionType}, ${projection.revision},
                ${projection.reducerVersion}, ${projection.lastDomainEventId ?? null},
                ${projection.lastDomainEventSequence ?? null},
                ${JSON.stringify(projection.state)}::jsonb, ${now})
        on conflict (character_id, projection_type) do nothing
        returning revision`,
    '插入 Projection'
  )
  if (rows.length === 0) {
    throw new KernelError(
      'revision_conflict',
      'projection_already_exists',
      `Projection ${projection.projectionType} 已存在（并发写入？），请改用乐观锁更新路径`
    )
  }
}

/** 删除投影（仅 Replay 验收使用：SC-005 要求"删掉再重建得到同一个结果"） */
export async function deleteProjection(
  db: RawDb,
  characterId: CharacterId,
  projectionType: string
): Promise<number> {
  return affectedRows(
    db,
    sql`delete from character_projections
        where character_id = ${characterId} and projection_type = ${projectionType}
        returning revision`,
    '删除 Projection'
  )
}

export async function listProjections(
  db: RawDb,
  characterId: CharacterId
): Promise<CharacterProjection<unknown>[]> {
  const rows = await exec(
    db,
    sql`select * from character_projections where character_id = ${characterId}
        order by projection_type asc`,
    '列出 Projection'
  )
  return asRows<ProjectionRow>(rows).map((r) => rowToProjection<unknown>(r)!)
}

/** 读取各投影当前 revision（Trace 的 projectionRevisionsAtStart/End 用它） */
export async function projectionRevisions(
  db: RawDb,
  characterId: CharacterId
): Promise<Record<string, number>> {
  const rows = await exec(
    db,
    sql`select projection_type, revision from character_projections where character_id = ${characterId}`,
    '读取投影版本'
  )
  const out: Record<string, number> = {}
  for (const row of rows) out[String(row.projection_type)] = Number(row.revision)
  return out
}

// ---------------------------------------------------------------------------
// 唯一变更链：accepted → DomainEvent → Reducer → Projection
// ---------------------------------------------------------------------------

export interface ApplyOutcome {
  domainEvents: DomainEvent[]
  /** 本次新建的（幂等命中时为 0） */
  createdCount: number
  /** 幂等命中数 */
  deduplicatedCount: number
  /** 因乱序被跳过的投影更新数 */
  skippedStale: number
  projectionChanges: { projectionType: string; fromRevision: number; toRevision: number }[]
  /** extras 实际新写入的行数（键已存在 = 0；M8.5 终结闸审计） */
  extraRecordedCount: number
}

/** 与事件同事务写入的额外幂等行（M8.5 WP6：终结闸与事件原子落库——M85-D20） */
export interface ExtraProcessedOperation {
  idempotencyKey: string
  processor: string
  processorVersion: string
  operation: string
  domainEventId?: string
}

export interface ApplyAcceptedEventsOptions {
  /**
   * 缺省缺省**零行**——不传本参数时行为与 M8 逐字一致（无任何额外写入）。
   * M8.5 worker 用它把终结闸行塞进事件提交的同一事务：
   * 闸缺失 + 重评 + 判定漂移 = 同一来源双重 IMPACT，闸必须与终态原子。
   */
  extraProcessedOperations?: readonly ExtraProcessedOperation[]
}

/**
 * 把 Validator 接受的事件**原子地**落进系统。
 *
 * 事务里只有：序号分配、插入、纯函数 reduce、乐观锁更新
 * （以及可选的 extras 幂等行——M8.5）。
 * **没有 LLM、没有网络、没有遥测**（plan 第 67/68 节）。
 */
export async function applyAcceptedEvents(
  db: RawDb,
  characterId: CharacterId,
  accepted: readonly AcceptedDomainEvent[],
  reducers: readonly ProjectionReducer<unknown>[],
  now: number = Date.now(),
  options: ApplyAcceptedEventsOptions = {},
): Promise<ApplyOutcome> {
  return inTransaction(db, async (tx) => {
    const domainEvents: DomainEvent[] = []
    let createdCount = 0
    let deduplicatedCount = 0
    let skippedStale = 0
    let extraRecordedCount = 0
    const projectionChanges: ApplyOutcome['projectionChanges'] = []

    for (const item of accepted) {
      const { event, created } = await appendDomainEvent(tx, characterId, item, now)
      domainEvents.push(event)
      if (created) createdCount += 1
      else deduplicatedCount += 1

      // 记幂等（已经存在时无需再记，靠唯一键天然幂等）
      await exec(
        tx,
        sql`insert into processed_operations
              (idempotency_key, character_id, processor, processor_version, operation,
               domain_event_id, processed_at)
            values (${item.idempotencyKey}, ${characterId}, ${item.processor},
                    ${item.processorVersion}, ${item.operation}, ${event.id}, ${now})
            on conflict (idempotency_key) do nothing`,
        '记录已处理操作'
      )

      // 只有真正新建的事件才折叠进投影：
      // 重复事件若再折叠一次，"计数器 +1"就会 +2（SC-004 要检的正是这个）。
      if (!created) continue

      for (const reducer of reducers) {
        if (!reducer.handledEventTypes.includes(event.type)) continue

        const existing = await getProjection<unknown>(tx, characterId, reducer.projectionType)
        const base = existing ?? emptyProjection(reducer, characterId, now)

        if (existing && existing.reducerVersion !== reducer.version) {
          throw new KernelError(
            'validation_error',
            'reducer_version_mismatch',
            `投影 ${existing.projectionType} 是用 ${existing.reducerVersion} 算的，` +
              `当前 reducer 是 ${reducer.version}。请先 projection rebuild（plan 第 24/29 节）。`
          )
        }

        const stale = reducer.isStale
          ? reducer.isStale(base, event)
          : defaultIsStale(base, event)
        if (stale) {
          skippedStale += 1
          continue
        }

        const { projection } = applyEvent(reducer, base, event, now)

        if (existing) {
          await saveProjection(tx, projection, existing.revision, now)
          projectionChanges.push({
            projectionType: projection.projectionType,
            fromRevision: existing.revision,
            toRevision: projection.revision,
          })
        } else {
          await insertProjection(tx, projection, now)
          projectionChanges.push({
            projectionType: projection.projectionType,
            fromRevision: 0,
            toRevision: projection.revision,
          })
        }
      }
    }

    // M8.5：终结闸等额外幂等行与事件**同事务**落库（缺省零行 = M8 行为不变）。
    // 无事件的终态（NO_IMPACT/EXPIRED/…）也走这里：accepted 为空数组时事务
    // 仍然成立，extras 就是本次提交的全部持久效果。
    for (const extra of options.extraProcessedOperations ?? []) {
      const { recorded } = await recordProcessedOperation(
        tx,
        {
          idempotencyKey: extra.idempotencyKey,
          characterId,
          processor: extra.processor,
          processorVersion: extra.processorVersion,
          operation: extra.operation,
          ...(extra.domainEventId !== undefined ? { domainEventId: extra.domainEventId } : {}),
        },
        now
      )
      if (recorded) extraRecordedCount += 1
    }

    return { domainEvents, createdCount, deduplicatedCount, skippedStale, projectionChanges, extraRecordedCount }
  })
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface RebuildResult<TState> {
  projection: CharacterProjection<TState>
  appliedEvents: number
  skippedEvents: number
  previousRevision: number | undefined
}

/**
 * 投影重建（plan 第 27 节）。
 *
 *    删掉当前快照 → 读取全部领域事件 → 按序 reduce → 写回
 *
 * 这是"Projection 是缓存而不是事实本体"的**可执行证明**：
 * 任何时刻都能把当前状态从事件重新算一遍，结果必须一致（SC-005）。
 */
export async function rebuildProjection<TState>(
  db: RawDb,
  characterId: CharacterId,
  reducer: ProjectionReducer<TState>,
  now: number = Date.now()
): Promise<RebuildResult<TState>> {
  const previous = await getProjection<TState>(db, characterId, reducer.projectionType)

  const events = await domainEventsFor(db, characterId)
  const relevant = events.filter((e) => reducer.handledEventTypes.includes(e.type))

  let state = reducer.initialState()
  let revision = 0
  let lastId: DomainEventId | undefined
  let lastSequence: number | undefined
  let skipped = 0

  for (const event of relevant) {
    if (lastSequence !== undefined && event.sequence <= lastSequence) {
      skipped += 1
      continue
    }
    state = reducer.reduce(state, event)
    revision += 1
    lastId = event.id
    lastSequence = event.sequence
  }

  const projection: CharacterProjection<TState> = {
    characterId,
    projectionType: reducer.projectionType,
    revision,
    reducerVersion: reducer.version,
    lastDomainEventId: lastId,
    lastDomainEventSequence: lastSequence,
    state,
    updatedAt: now,
  }

  await inTransaction(db, async (tx) => {
    await deleteProjection(tx, characterId, reducer.projectionType)
    await insertProjection(tx, projection, now)
  })

  return {
    projection,
    appliedEvents: revision,
    skippedEvents: skipped,
    previousRevision: previous?.revision,
  }
}

export type { ProjectionReducer }

// ---------------------------------------------------------------------------
// 重置 kernel 数据（用户显式要求"重开"时用）
// ---------------------------------------------------------------------------

export interface ResetKernelScope {
  characterId: CharacterId
  /** 要清掉的会话（对应 M1/M2 的"房间"） */
  conversationIds: readonly string[]
  /** 要清掉的投影（投影类型里带 userId 的那些） */
  projectionTypes: readonly string[]
}

export interface ResetKernelResult {
  conversationEvents: number
  domainEvents: number
  projections: number
  traces: number
  processedOperations: number
  jobs: number
  /**
   * M5-PRE：被整条删掉的记忆（reset 之后已无任何活证据的）。
   *
   * 它们与 `conversationEvents` **不是同一件事**：前者是"她与用户之间发生过什么"，
   * 这里是"她因此记住了什么"。分开报数才能让"重置真的是干净的重置"可被复核。
   */
  memoryRecords: number
  memorySubjectLinks: number
  memoryEvidenceLinks: number
  memoryEventLinks: number
}

/**
 * 删除该角色（可限定到某些会话/投影）的 kernel 数据。
 *
 * ============================================================================
 *  这与"append-only"冲突吗？不冲突。
 * ============================================================================
 * append-only 约束的是**系统**：系统不能因为后来理解改变而改写历史。
 * 而"用户主动要求从头开始"是一个**显式的、可审计的用户动作**——
 * 它和 M4 的"显式遗忘"是同一类操作，区别只是范围。
 *
 * 真正需要守住的两条：
 *   1. 只在用户显式调用（`--reset-kernel`）时发生，**不允许**任何自动流程调用；
 *   2. 删了什么必须**逐项打印**，而不是静默清空。
 *
 * 顺序说明：先删引用方（领域事件 / trace 引用事件 id），再删被引用方
 * （对话事件），最后清投影与幂等记录。
 */
export async function resetKernelData(
  db: RawDb,
  scope: ResetKernelScope,
  now: number = Date.now()
): Promise<ResetKernelResult> {
  return inTransaction(db, async (tx) => {
    const conversationIds = [...scope.conversationIds]
    const projectionTypes = [...scope.projectionTypes]

    let conversationEvents = 0
    let domainEvents = 0
    // M5-PRE：记忆侧的清理计数（与上面两组分开报，见 ResetKernelResult 的说明）
    let memoryRecords = 0
    let memorySubjectLinks = 0
    let memoryEvidenceLinks = 0
    let memoryEventLinks = 0

    if (conversationIds.length > 0) {
      // 收集本次要删的事件 id（用于反查引用它们的领域事件）
      const rows = await exec(
        tx,
        sql`select id from conversation_events
            where character_id = ${scope.characterId}
              and conversation_id in (${sql.join(
                conversationIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
        '读取待删对话事件'
      )
      const eventIds = rows.map((r) => String(r.id))

      if (eventIds.length > 0) {
        /*
         * ==========================================================================
         *  M5-PRE：**先**清记忆侧，再删事件（顺序不能反）
         * ==========================================================================
         * 清理要判断"删掉这些证据/事件之后，这条记忆还剩不剩活证据 + 活事件流"，
         * 而那必须在被删的行**还在**的时候算（内连接才成立）。
         *
         * 漏掉这一步的后果是实测出来的（WP0 之后查实的候选 BLOCKING DEFECT）：
         * 留下 status=active 但事件流为空、evidence link 指向不存在事件的
         * "孤儿记忆"，`rebuildMemory()` 必然 `equal = false`（MI-11 失效），
         * 而 `unsupportedMemories()`（只数 link 行数）看不见它 —— 审计说一切正常。
         */
        const memoryCleanup = await cleanupMemorySideOfReset(tx, {
          characterId: scope.characterId,
          deletedConversationEventIds: eventIds,
        })
        memoryRecords = memoryCleanup.memoryRecords
        memorySubjectLinks = memoryCleanup.memorySubjectLinks
        memoryEvidenceLinks = memoryCleanup.memoryEvidenceLinks
        memoryEventLinks = memoryCleanup.memoryEventLinks

        domainEvents = await affectedRows(
          tx,
          sql`delete from character_domain_events
              where character_id = ${scope.characterId}
                and primary_source_event_id in (${sql.join(
                  eventIds.map((id) => sql`${id}`),
                  sql`, `,
                )})
              returning id`,
          '删除领域事件'
        )
      }

      conversationEvents = await affectedRows(
        tx,
        sql`delete from conversation_events
            where character_id = ${scope.characterId}
              and conversation_id in (${sql.join(
                conversationIds.map((id) => sql`${id}`),
                sql`, `,
              )})
            returning id`,
        '删除对话事件'
      )
    }

    // 投影：本次要清的投影类型
    const projections =
      projectionTypes.length === 0
        ? 0
        : await affectedRows(
            tx,
            sql`delete from character_projections
                where character_id = ${scope.characterId}
                  and projection_type in (${sql.join(
                    projectionTypes.map((t) => sql`${t}`),
                    sql`, `,
                  )})
                returning projection_type`,
            '删除投影'
          )

    // trace 引用 input/output 事件 id：按会话前缀能识别的部分删掉。
    // 保守做法：删掉该角色全部 trace（trace 是运行证据，不是她的经历；
    // 重置后旧的运行证据也没有对照意义了）。
    const traces = await affectedRows(
      tx,
      sql`delete from character_traces
          where character_id = ${scope.characterId}
          returning trace_id`,
      '删除 Trace'
    )

    // 幂等记录与任务：不清掉的话，重置后重新聊第一句会撞上旧幂等键，
    // 表现为"慢路径什么都不做"（诊断投影永远不前进）。这正是必须一起清的原因。
    const processedOperations = await affectedRows(
      tx,
      sql`delete from processed_operations
          where character_id = ${scope.characterId}
          returning idempotency_key`,
      '删除幂等记录'
    )
    const jobs = await affectedRows(
      tx,
      sql`delete from character_jobs
          where character_id = ${scope.characterId}
          returning id`,
      '删除任务'
    )

    /*
     * 判据说明（M5-PRE）：
     *   · `memoriesWithoutLiveEvidence` / `memoriesWithoutLiveEvents` / `danglingMemoryEvents`
     *     → **失败关闭**：它们是"状态已经不成立"，绝不能留在库里。
     *   · `danglingEvidenceLinks` → **报告，不失败**：幸存记忆的证据引用**刻意保留**
     *     （删它会让 sourceRefs 与事件 payload 不一致，破 MI-11 的 A == B）。
     *     那是"用户显式抹掉那段历史"的痕迹，可解释、可审计，但**不是孤儿**。
     *     详见 `memory-integrity.ts` 里"幸存者：刻意不动它的 evidence link"那一节。
     */
    const integrity = await memoryIntegrityProblems(
      tx,
      entityRef('character', String(scope.characterId))
    )
    const remainingProblems =
      integrity.danglingMemoryEvents.length +
      integrity.memoriesWithoutLiveEvidence.length +
      integrity.memoriesWithoutLiveEvents.length

    if (remainingProblems > 0) {
      throw new KernelError(
        'persistence_error',
        'reset_memory_integrity_violated',
        `重置之后记忆完整性仍然不成立：` +
          `悬空 memory_events 行 ${integrity.danglingMemoryEvents.length}、` +
          `无活证据的记忆 ${integrity.memoriesWithoutLiveEvidence.length}、` +
          `无活事件流的记忆 ${integrity.memoriesWithoutLiveEvents.length}` +
          `（另有指向已删会话的 evidence link ${integrity.danglingEvidenceLinks.length} 条，` +
          `那是被显式抹掉的历史痕迹，不算失败）。` +
          `本次已清理：memory_records=${memoryRecords}、subject links=${memorySubjectLinks}、` +
          `evidence links=${memoryEvidenceLinks}、memory_events=${memoryEventLinks}。` +
          `整个重置已回滚 —— 留下半干净的状态比失败更糟（先用 memory:stats 看 remaining）`
      )
    }

    void now
    return {
      conversationEvents,
      domainEvents,
      projections,
      traces,
      processedOperations,
      jobs,
      memoryRecords,
      memorySubjectLinks,
      memoryEvidenceLinks,
      memoryEventLinks,
    }
  })
}
