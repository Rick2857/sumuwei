/**
 * Projection / Reducer —— **当前状态是缓存，不是事实本体**。
 *
 * ============================================================================
 *  铁律 6 & 7：Projection 必须可重放，Reducer 必须确定性
 * ============================================================================
 *
 *     Domain Events ──reduce──► Projection(revision, state)
 *                        ▲
 *                        └── rebuild 可以从头算出同一个结果
 *
 * 所以数据库里那个 `trust = 0.63` **不是**真相，它只是"到目前为止所有
 * Domain Event 折叠出来的结果"。reducer 改进以后 rebuild 一遍即可，
 * 不需要丢掉旧人格（plan 第 23 节）。
 *
 * 三条硬约束：
 *   1. Reducer 纯函数：`state + event → new state`，禁止任何副作用。
 *   2. Reducer 必须版本化：`projection.reducerVersion` 记录它当时是用哪个
 *      版本算出来的；改了算法不许偷偷继续更新旧状态（plan 第 24/29 节）。
 *   3. 同一 (projectionType, domainEventType) 只允许一个 Reducer 处理。
 */

import { KernelError, type CharacterId, type DomainEventId, type Timestamp } from './ids.ts'
import type { DomainEvent } from './domain-event.ts'

export interface CharacterProjection<TState> {
  characterId: CharacterId

  /**
   * 投影类型。它同时是**作用域标识**：
   * 需要按用户区分的投影把 userId 编进来，例如
   * `relationship:user:<uuid>`；不需要区分的就是 `character:self`。
   * 因此 `(characterId, projectionType)` 全局唯一即可，无需旁路字段。
   */
  projectionType: string

  /** 每更新一次 +1。写入必须带 expectedRevision（乐观锁） */
  revision: number

  /** 算出当前 state 的 reducer 版本（如 `character-state@1`） */
  reducerVersion: string

  /** 最后一个被 reduce 的领域事件（可追溯"我算到哪了"） */
  lastDomainEventId?: DomainEventId

  /** 最后一个被 reduce 的领域事件序号（用于乱序检测与 watermark） */
  lastDomainEventSequence?: number

  state: TState

  updatedAt: Timestamp
}

/**
 * Reducer 契约。
 *
 * `projectionType` 与 `version` 都是**只读常量**，因为它们要落进 Projection 行；
 * 若允许运行时变化，"这一行是用哪个版本算的"就不可知了。
 */
export interface ProjectionReducer<TState, TEvent extends DomainEvent = DomainEvent> {
  readonly projectionType: string
  readonly version: string

  /** 该 reducer 消费哪些 Domain Event 类型（用于冲突检测与文档生成） */
  readonly handledEventTypes: readonly string[]

  /** 空投影的初始状态。必须是**纯函数**：不读时间、不读配置 */
  initialState(): TState

  /**
   * 折叠一个事件。
   *
   * 禁止（这些会让 Replay 失效，plan 第 25 节）：
   *   调用 LLM、网络请求、读当前时间、随机数、写数据库、发消息
   */
  reduce(state: TState, event: TEvent): TState

  /**
   * 乱序保护：判断一个事件是否**已经过时**（不该再覆盖当前状态）。
   *
   * 默认实现按 `sequence` 单调递增判断。返回 true 表示应当跳过。
   * 有这个钩子，Phase G 的"旧 Worker 不覆盖新 Worker"才有单一定义处。
   */
  isStale?(projection: CharacterProjection<TState>, event: TEvent): boolean
}

/** Projection 的默认乱序判定：只接受比当前更大的 sequence */
export function defaultIsStale<TState>(
  projection: CharacterProjection<TState>,
  event: DomainEvent
): boolean {
  const last = projection.lastDomainEventSequence
  if (last === undefined) return false
  return event.sequence <= last
}

/**
 * ReducerRegistry —— 登记并**检测冲突**。
 *
 * 同一 (projectionType, eventType) 被两个 reducer 认领会抛错。
 * 这条检查很便宜，但它把"某个新模块悄悄也处理了 MEMORY_CREATED"
 * 从"运行期诡异行为"变成"启动即失败"。
 */
export class ReducerRegistry {
  private readonly reducers = new Map<string, ProjectionReducer<unknown>>()
  private readonly eventOwners = new Map<string, string>() // `${projectionType}::${eventType}` -> version

  register<TState>(reducer: ProjectionReducer<TState>): void {
    if (this.reducers.has(reducer.projectionType)) {
      throw new KernelError(
        'validation_error',
        'reducer_duplicate',
        `projectionType 重复登记：${reducer.projectionType}`
      )
    }
    if (reducer.handledEventTypes.length === 0) {
      throw new KernelError(
        'validation_error',
        'reducer_without_events',
        `reducer ${reducer.projectionType} 没有声明任何 handledEventTypes`
      )
    }
    for (const eventType of reducer.handledEventTypes) {
      const key = `${reducer.projectionType}::${eventType}`
      const owner = this.eventOwners.get(key)
      if (owner !== undefined) {
        throw new KernelError(
          'validation_error',
          'reducer_event_conflict',
          `Domain Event 类型 ${eventType} 已被 ${owner} 处理，${reducer.version} 不能重复认领`
        )
      }
      this.eventOwners.set(key, reducer.version)
    }
    this.reducers.set(reducer.projectionType, reducer as ProjectionReducer<unknown>)
  }

  get(projectionType: string): ProjectionReducer<unknown> | undefined {
    return this.reducers.get(projectionType)
  }

  all(): ProjectionReducer<unknown>[] {
    return [...this.reducers.values()]
  }

  /** 给定一个 Domain Event 类型，找出所有会消费它的投影 */
  projectionsFor(eventType: string): string[] {
    return this.all()
      .filter((r) => r.handledEventTypes.includes(eventType))
      .map((r) => r.projectionType)
      .sort()
  }
}

/** 空投影的构造（供 Replay 与首次访问时使用） */
export function emptyProjection<TState>(
  reducer: ProjectionReducer<TState>,
  characterId: CharacterId,
  now: Timestamp = Date.now()
): CharacterProjection<TState> {
  return {
    characterId,
    projectionType: reducer.projectionType,
    revision: 0,
    reducerVersion: reducer.version,
    state: reducer.initialState(),
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayResult<TState> {
  projection: CharacterProjection<TState>
  /** 实际折叠了多少个事件 */
  appliedEvents: number
  /** 因乱序被跳过的事件数（正常回放应为 0） */
  skippedEvents: number
}

/**
 * 从零重建投影。
 *
 * **纯计算**：不写库。持久化由调用方（ReplayService）负责，
 * 这样"重建出来的结果对不对"可以在内存里独立测试（SC-005 的判定核心）。
 */
export function replayProjection<TState>(
  reducer: ProjectionReducer<TState>,
  characterId: CharacterId,
  events: readonly DomainEvent[],
  now: Timestamp = Date.now()
): ReplayResult<TState> {
  let state = reducer.initialState()
  let revision = 0
  let lastId: DomainEventId | undefined
  let lastSequence: number | undefined
  let skipped = 0

  // 按序号升序折叠：Replay 的正确性依赖顺序，不能指望传入顺序
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)

  for (const event of ordered) {
    if (lastSequence !== undefined && event.sequence <= lastSequence) {
      skipped += 1
      continue
    }
    state = reducer.reduce(state, event)
    revision += 1
    lastId = event.id
    lastSequence = event.sequence
  }

  return {
    projection: {
      characterId,
      projectionType: reducer.projectionType,
      revision,
      reducerVersion: reducer.version,
      lastDomainEventId: lastId,
      lastDomainEventSequence: lastSequence,
      state,
      updatedAt: now,
    },
    appliedEvents: revision,
    skippedEvents: skipped,
  }
}

/**
 * 在已有投影上追加一个事件（**不写库**，返回新对象）。
 *
 * 返回 `stale: true` 表示该事件已被历史覆盖：调用方应当**静默跳过**，
 * 而不是报错——乱序后台任务是正常现象，不是故障（plan 第 21 节）。
 */
export function applyEvent<TState>(
  reducer: ProjectionReducer<TState>,
  projection: CharacterProjection<TState>,
  event: DomainEvent,
  now: Timestamp = Date.now()
): { projection: CharacterProjection<TState>; stale: boolean } {
  if (reducer.version !== projection.reducerVersion) {
    throw new KernelError(
      'validation_error',
      'reducer_version_mismatch',
      `投影 ${projection.projectionType} 是 ${projection.reducerVersion} 算出来的，` +
        `不能用 ${reducer.version} 继续追加。请改走 projection rebuild（plan 第 24/29 节）。`
    )
  }
  const stale = reducer.isStale
    ? reducer.isStale(projection, event)
    : defaultIsStale(projection, event)
  if (stale) return { projection, stale: true }

  return {
    projection: {
      ...projection,
      revision: projection.revision + 1,
      lastDomainEventId: event.id,
      lastDomainEventSequence: event.sequence,
      state: reducer.reduce(projection.state, event),
      updatedAt: now,
    },
    stale: false,
  }
}
