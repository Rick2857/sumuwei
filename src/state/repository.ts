/**
 * CharacterState 的持久化层。
 *
 * ============================================================================
 *  为什么用原生 DDL，而不是 plugin-sql 的 schema 机制
 * ============================================================================
 * plugin-sql 的 `registerSchema()` 接收的是 Drizzle 的 `pgTable` 对象，
 * 而 drizzle-orm 只是插件的传递依赖（在本项目里无法直接 import，
 * Node 的 ESM 解析会拒绝）。与其去啃上游的 schema 内部约定，
 * 不如用原生 DDL 建我们自己的两张表：语义一眼可读，也不受插件小版本影响。
 *
 * 建表语句全部 `IF NOT EXISTS`，因此可重复执行，无需单独的迁移版本表。
 *
 * 表结构（对应 L1 方案的「三张自研表」，此处先落两张，Summary 留给 L1-M4）：
 *
 *   character_states  每个「角色 × 用户」一行，存当前状态快照
 *   state_events      每次状态变化一行，存 before / delta / after / reason
 */

import type { IAgentRuntime } from '@elizaos/core'
import { sql } from 'drizzle-orm'

import { KernelError } from '../kernel/contracts/index.ts'
/*
 * K-9 仍 DEFER：**不**扩大 contracts/index.ts 的 barrel，直接从具体模块导入
 * （与 `conversation-store.ts` 同一个做法）。
 *
 * ⚠️ 这里**刻意只 import**：canonical 的需要性/三态编码表（`ATTRIBUTION_SLOT_COLUMNS`）、
 * 受信标记守卫（`isTrustedAttribution`）、以及**唯一**的表无关读取器
 * （`storedAttributionOfRow`）。**不**新增第二个解码器、**不**新增第二张矩阵表。
 */
import {
  ATTRIBUTION_ORIGIN_COLUMN,
  ATTRIBUTION_SLOT_COLUMNS,
  isTrustedAttribution,
  storedAttributionOfRow,
  type AttributionValueSlot,
  type StoredAttributionReadback,
  type TrustedAttribution,
} from '../kernel/contracts/attribution.ts'
import type { AttributionValue } from '../kernel/contracts/actor.ts'

import {
  type CharacterState,
  type StateVariable,
  clampVariable,
  createInitialState,
} from './types.ts'

/** plugin-sql 暴露的底层句柄 */
interface RawDb {
  execute: (query: unknown) => Promise<unknown>
}

/**
 * 取底层数据库句柄。
 *
 * `IAgentRuntime` 自身继承自 `IDatabaseAdapter`，但真正的 PGlite/Drizzle 句柄
 * 只挂在具体实现（`AgentRuntime.adapter`）上，接口里没有暴露。
 * 这是本层唯一需要类型断言的地方——把不确定性收敛在这一个函数里，
 * 其余代码都按类型走。
 */
function getRawDb(runtime: IAgentRuntime): RawDb {
  const holder = runtime as unknown as {
    db?: unknown
    adapter?: { db?: RawDb; getDatabase?: () => RawDb | undefined }
  }
  const candidate =
    holder.adapter?.db ??
    holder.adapter?.getDatabase?.() ??
    (typeof holder.db === 'object' ? (holder.db as RawDb) : undefined)

  if (!candidate?.execute) {
    throw new Error('拿不到底层数据库句柄，无法读写 CharacterState')
  }
  return candidate
}

/** drizzle 的 execute 在不同驱动下返回形状不同，这里统一取行数组 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = (result as { rows?: unknown[] })?.rows ?? result
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
}

const DDL = [
  `create table if not exists character_states (
     character_id        text        not null,
     user_id             text        not null,
     valence             double precision not null default 0,
     arousal             double precision not null default 0,
     trust               double precision not null default 0,
     closeness           double precision not null default 0,
     version             integer     not null default 0,
     last_interaction_at bigint      not null,
     created_at          bigint      not null,
     updated_at          bigint      not null,
     primary key (character_id, user_id)
   )`,
  `create table if not exists state_events (
     id                text        primary key,
     character_id      text        not null,
     user_id           text        not null,
     before_state      jsonb       not null,
     delta             jsonb       not null,
     after_state       jsonb       not null,
     reason            text        not null,
     trigger           text        not null,
     state_version     integer     not null,
     message_id        text,
     created_at        bigint      not null
   )`,
  `create index if not exists state_events_lookup
     on state_events (character_id, user_id, created_at desc)`,
]

/** 建表（幂等） */
export async function ensureStateTables(runtime: IAgentRuntime): Promise<void> {
  const db = getRawDb(runtime)
  for (const statement of DDL) {
    await db.execute(sql.raw(statement))
  }
}

function rowToState(row: Record<string, unknown>): CharacterState {
  return {
    characterId: String(row.character_id),
    userId: String(row.user_id),
    valence: Number(row.valence),
    arousal: Number(row.arousal),
    trust: Number(row.trust),
    closeness: Number(row.closeness),
    version: Number(row.version),
    lastInteractionAt: Number(row.last_interaction_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * **纯读取**：状态不存在时返回 undefined，**不建档**。
 *
 * 与 loadState 的区别很关键：loadState 在查不到时会按初始值建档，
 * 因此用它做"重启后状态是否还在"的验证会**假通过**——
 * 读到的其实是刚刚现建出来的默认值。
 * 需要区分"状态真的存在"和"状态丢了"时必须用这个。
 */
export async function readStateIfExists(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string
): Promise<CharacterState | undefined> {
  const db = getRawDb(runtime)
  const result = await db.execute(
    sql`select * from character_states
        where character_id = ${characterId} and user_id = ${userId} limit 1`
  )
  const row = rowsOf(result)[0]
  return row ? rowToState(row) : undefined
}

/**
 * 读取状态；不存在则按初始值创建。
 *
 * 注意返回的是**上一次互动结束时的快照**，未结算挂钟衰减。
 * 衰减由调用方（StateProvider / Inspector）用 applyDecay 惰性结算，
 * 这样纯函数与持久化层职责分离，便于单独测试。
 */
export async function loadState(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  now = Date.now()
): Promise<CharacterState> {
  const db = getRawDb(runtime)
  const result = await db.execute(
    sql`select * from character_states
        where character_id = ${characterId} and user_id = ${userId} limit 1`
  )
  const row = rowsOf(result)[0]
  if (row) return rowToState(row)

  // 首次见面：按初始状态建档并落库，保证「状态真实存在」而不是每次现算
  const initial = createInitialState(characterId, userId, now)
  await saveState(runtime, initial, { touchInteraction: false })
  return initial
}

export interface SaveOptions {
  /**
   * 是否把 lastInteractionAt 推进到当前时间。
   * 真实互动（用户发消息）时为 true；
   * 仅结算衰减、或初始化建档时为 false，否则会把「分开时长」清零。
   */
  touchInteraction?: boolean
}

/** 写入状态（upsert） */
export async function saveState(
  runtime: IAgentRuntime,
  state: CharacterState,
  options: SaveOptions = {}
): Promise<void> {
  const db = getRawDb(runtime)
  const now = Date.now()
  const lastInteractionAt = options.touchInteraction ? now : state.lastInteractionAt

  await db.execute(
    sql`insert into character_states
          (character_id, user_id, valence, arousal, trust, closeness,
           version, last_interaction_at, created_at, updated_at)
        values (${state.characterId}, ${state.userId}, ${state.valence}, ${state.arousal},
                ${state.trust}, ${state.closeness}, ${state.version},
                ${lastInteractionAt}, ${state.createdAt}, ${now})
        on conflict (character_id, user_id) do update set
          valence             = excluded.valence,
          arousal             = excluded.arousal,
          trust               = excluded.trust,
          closeness           = excluded.closeness,
          version             = excluded.version,
          last_interaction_at = excluded.last_interaction_at,
          updated_at          = excluded.updated_at`
  )
}

// ---------------------------------------------------------------------------
// 变更日志
// ---------------------------------------------------------------------------

export interface StateEventInput {
  before: CharacterState
  delta: Partial<Record<StateVariable, number>>
  after: CharacterState
  reason: string
  /** 触发来源：manual(手工改库) / decay(挂钟衰减) / evaluator(L1-M3) / init */
  trigger: 'manual' | 'decay' | 'evaluator' | 'init'
  messageId?: string
  /**
   * **可选**的归因信封（M5.1.1 / WP9-B1，R-45）。
   *
   * ============================================================================
   *  为什么是"可选"，以及可选**不等于**"可以随手补一个"
   * ============================================================================
   *  · **不传**（历史与今天的所有调用点）：这一行**不带归因**。
   *    `attribution_origin` 保持 NULL ⇒ 读取器返回 `undefined`，语义是
   *    "**从未记录过**归因"。这**不是**"记录了、但每一格都是 Absent"——
   *    两者在库里长得像，在语义上是两件事（Proposed-Schema §0 / K-4）。
   *  · **传**：必须是**已受信**的信封（`TrustedAttribution`，带 `TRUSTED_INGRESS_MARK`），
   *    即由 `constructTrustedAttribution()` 构造、已过 canonical 必要性校验的那一个。
   *    一个手写的同形对象（或 `{...env}` / JSON 往返）在这里被**失败关闭**拒绝
   *    （`isTrustedAttribution` 是运行期守卫，不是结构判断）。
   *
   * ⚠️ 谁**不许**填它：任何"从事件长什么样反推"的路径 ——
   *    `trigger='init'`、`state_transition` 族名/表名、payload、`actor_type`、
   *    `requestedBy`、transport 都不是身份证据（见契约的
   *    `STATE_TRANSITION_SYSTEM_ORIGIN_RULE`）。B1 落地的是**能力 + 边界**；
   *    真正的 SYSTEM 生产者（把状态引导组件自己的身份装进受信证据）是 WP9-B2。
   */
  attribution?: TrustedAttribution
}

/**
 * 三态 → 三个物理格（K-4 编码；**没有**默认值）。
 *
 * ⚠️ **这是刻意的重复实现**（第三份）：`conversation-store.ts:401-410` 与
 * `action-ledger-store.ts:98-114` 各自持有一份**私有**同名函数。
 * 本轮 WP **不**把它导出成共享工具：新增一个公共导出 = 扩大契约面，超出 B1 的范围。
 * 一旦三者出现分歧，`pnpm m5.1.1:wp9b1:verify` 的 round-trip 会红（同值必须同编码）。
 */
function attributionCell(value: AttributionValue<unknown>): {
  kind: string | null
  id: string | null
  reason: string | null
} {
  if (value.state === 'KNOWN') {
    const principal = value.value as { kind?: string; id?: string; ref?: string }
    return { kind: principal.kind ?? null, id: principal.id ?? principal.ref ?? null, reason: null }
  }
  if (value.state === 'UNKNOWN') return { kind: null, id: null, reason: value.reason }
  return { kind: null, id: null, reason: null }
}

/** 列名与值的**同一份**展开（同一个 map、同一个顺序）—— 顺序是载荷，不许手写 */
const ATTRIBUTION_SLOT_ENTRIES = Object.entries(ATTRIBUTION_SLOT_COLUMNS) as [
  AttributionValueSlot,
  { kind: string; id: string; unknownReason: string },
][]

export async function recordStateEvent(
  runtime: IAgentRuntime,
  input: StateEventInput
): Promise<{ id: string }> {
  const db = getRawDb(runtime)
  const snapshot = (s: CharacterState) => ({
    valence: s.valence,
    arousal: s.arousal,
    trust: s.trust,
    closeness: s.closeness,
    version: s.version,
  })

  /*
   * 受信边界（B1 强制的那一半）：**只有**带 `TRUSTED_INGRESS_MARK` 的信封能进权威槽位。
   * 拒绝而不是忽略 —— "静默忽略调用方自报的值"与"信任它"在库里看起来一样。
   */
  const attribution = input.attribution
  if (attribution !== undefined && !isTrustedAttribution(attribution)) {
    throw new KernelError(
      'validation_error',
      'untrusted_state_event_attribution',
      'state_events 的归因信封必须是 trusted ingress 构造的那一个' +
        '（带 TRUSTED_INGRESS_MARK）；手写同形对象 / 结构克隆 / JSON 往返一律拒绝。' +
        'SYSTEM 只能来自状态引导组件自己的受信身份（R-45 / WP9-B1）'
    )
  }

  // 不带信封时这两段是**空片段** ⇒ SQL 与今天逐字段相同（legacy 路径零影响）
  const attributionColumns =
    attribution === undefined
      ? sql``
      : sql`, ${sql.raw(ATTRIBUTION_ORIGIN_COLUMN)}, ${sql.raw(
          ATTRIBUTION_SLOT_ENTRIES.flatMap(([, columns]) => [
            columns.kind,
            columns.id,
            columns.unknownReason,
          ]).join(', ')
        )}`
  const attributionValues =
    attribution === undefined
      ? sql``
      : sql`, ${attribution.attributionOrigin}, ${sql.join(
          ATTRIBUTION_SLOT_ENTRIES.flatMap(([slot]) => {
            const cell = attributionCell(attribution[slot])
            return [sql`${cell.kind}`, sql`${cell.id}`, sql`${cell.reason}`]
          }),
          sql`, `
        )}`

  const id = crypto.randomUUID()
  await db.execute(
    sql`insert into state_events
          (id, character_id, user_id, before_state, delta, after_state,
           reason, trigger, state_version, message_id, created_at${attributionColumns})
        values (${id}, ${input.after.characterId}, ${input.after.userId},
                ${JSON.stringify(snapshot(input.before))}::jsonb,
                ${JSON.stringify(input.delta)}::jsonb,
                ${JSON.stringify(snapshot(input.after))}::jsonb,
                ${input.reason}, ${input.trigger}, ${input.after.version},
                ${input.messageId ?? null}, ${Date.now()}${attributionValues})`
  )
  return { id }
}

/**
 * 一行 `state_events` → **存储归因读数**（WP9-B1 的受信回读）。
 *
 * 只是 canonical 读取器的**转调**：列名三张表完全相同（v7/v9 用同一个生成器），
 * 因此这里**不**写第二个解码器。没有 `attribution_origin` 的行 ⇒ `undefined`
 * （"从未记录过归因"，故意与"每格 Absent"不同）。
 *
 * ⚠️ `subject` **不在这里**：它是 canonical domain owner 的**派生**语义
 * （U-13，不落列）。状态行的派生规则是 `CHARACTER/<character_id>` ——
 * 与对话/行动信封同一条规则（`user_id` 是**关系维度**，留在行上，不进信封）。
 */
export function stateEventAttributionOfRow(
  row: Readonly<Record<string, unknown>>
): StoredAttributionReadback | undefined {
  return storedAttributionOfRow(row)
}

/** 回读结果：**"找不到这一行" 与 "这一行没有归因" 是两件事**，不许折叠成一个 `undefined` */
export interface StateEventAttributionReadback {
  readonly found: boolean
  readonly attribution: StoredAttributionReadback | undefined
}

/** 按 id 回读一条 state_event 的归因（只 select 归因列 + origin，不碰正文） */
export async function readStateEventAttribution(
  runtime: IAgentRuntime,
  id: string
): Promise<StateEventAttributionReadback> {
  const db = getRawDb(runtime)
  const columns = [
    ATTRIBUTION_ORIGIN_COLUMN,
    ...ATTRIBUTION_SLOT_ENTRIES.flatMap(([, columnNames]) => [
      columnNames.kind,
      columnNames.id,
      columnNames.unknownReason,
    ]),
  ]
  const result = await db.execute(
    sql`select ${sql.raw(columns.join(', '))} from state_events where id = ${id} limit 1`
  )
  const row = rowsOf(result)[0]
  if (row === undefined) return { found: false, attribution: undefined }
  return { found: true, attribution: storedAttributionOfRow(row) }
}

export interface StateEventRow {
  before: Record<string, number>
  delta: Record<string, number>
  after: Record<string, number>
  reason: string
  trigger: string
  createdAt: number
}

export async function recentStateEvents(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  limit = 10
): Promise<StateEventRow[]> {
  const db = getRawDb(runtime)
  const result = await db.execute(
    sql`select before_state, delta, after_state, reason, trigger, created_at
        from state_events
        where character_id = ${characterId} and user_id = ${userId}
        order by created_at desc limit ${limit}`
  )
  return rowsOf(result).map((r) => ({
    before: r.before_state as Record<string, number>,
    delta: r.delta as Record<string, number>,
    after: r.after_state as Record<string, number>,
    reason: String(r.reason),
    trigger: String(r.trigger),
    createdAt: Number(r.created_at),
  }))
}

/**
 * 重置状态：回到初始值（trust 0.85 / closeness 0.60 / 情绪中性），version 归零。
 *
 * 用途：验证脚本或测试留下的状态残渣，以及你想让她"重新开始"的时候。
 * 这是**唯一**会抹掉状态的操作，且会留下一条 trigger='manual' 的事件记录，
 * 所以"被重置过"本身也是可追溯的。
 */
export async function resetState(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  reason: string,
  now = Date.now()
): Promise<CharacterState> {
  const before = await loadState(runtime, characterId, userId, now)
  const after = createInitialState(characterId, userId, now)
  await saveState(runtime, after, { touchInteraction: false })
  await recordStateEvent(runtime, {
    before,
    delta: {
      valence: after.valence - before.valence,
      arousal: after.arousal - before.arousal,
      trust: after.trust - before.trust,
      closeness: after.closeness - before.closeness,
    },
    after,
    reason,
    trigger: 'manual',
  })
  return after
}

/**
 * 清空某个房间的全部对话消息（记忆）。
 *
 * 用途：抹掉测试残留，或你想让她忘掉这段对话重新开始。
 * 注意只删该房间的 messages，不影响状态、也不影响其他房间。
 */
export async function clearRoomMessages(
  runtime: IAgentRuntime,
  roomId: string
): Promise<number> {
  const db = getRawDb(runtime)
  const result = await db.execute(
    sql`delete from memories where room_id = ${roomId} and type = 'messages' returning id`
  )
  return rowsOf(result).length
}

/**
 * 标记一次真实互动：把「上次互动时间」推进到现在。
 *
 * 这是挂钟衰减的锚点。若不在互动时推进它，`now - lastInteractionAt` 会一直
 * 从建档时刻算起，「分开多久」就永远失真。
 *
 * 只动时间戳，不改任何数值 —— 状态变化必须来自事件（L1-M3 的 Evaluator）
 * 或时间（decay.ts），不能因为「说了句话」就凭空涨关系。
 */
export async function markInteraction(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  now = Date.now()
): Promise<CharacterState> {
  const current = await loadState(runtime, characterId, userId, now)
  const next: CharacterState = {
    ...current,
    lastInteractionAt: now,
    version: current.version + 1,
    updatedAt: now,
  }
  await saveState(runtime, next, { touchInteraction: true })
  return next
}

/** 直接按变量改值（L1-M2 的「手工改库」验收与 Inspector 都走这里） */
export async function setStateVariable(
  runtime: IAgentRuntime,
  characterId: string,
  userId: string,
  variable: StateVariable,
  value: number,
  reason: string
): Promise<{ before: CharacterState; after: CharacterState }> {
  const before = await loadState(runtime, characterId, userId)
  const next = clampVariable(variable, value)
  const after: CharacterState = {
    ...before,
    [variable]: next,
    version: before.version + 1,
    updatedAt: Date.now(),
  }
  await saveState(runtime, after)
  await recordStateEvent(runtime, {
    before,
    delta: { [variable]: next - before[variable] },
    after,
    reason,
    trigger: 'manual',
  })
  return { before, after }
}
