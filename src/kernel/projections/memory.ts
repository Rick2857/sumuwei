/**
 * Memory Reducer —— **把 `MEMORY_*` 事件折叠成一条记忆的当前状态**。
 *
 * ============================================================================
 *  计划书第 72–74 节：MemoryRecord 是投影，Domain Event 是"为什么变成这样"
 * ============================================================================
 * 计划书第 72 节的定义：
 *
 *     MemoryRecord          = 当前 Memory Projection
 *     Memory Domain Events  = Memory 为什么变成现在这样
 *
 * 因此这个文件必须是**纯函数**，且**必须能从头重算出同一结果**：
 *
 *     创建 Memory → 修正 → supersede → 记录最终状态 A
 *     ↓ 删除 Memory Projection
 *     ↓ replay Domain Events
 *     得到状态 B
 *     A == B        （计划书第 74 节）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 为什么**不**套用 `ProjectionReducer` / `character_projections`
 * ---------------------------------------------------------------------------
 * 见 `docs/m4/compatibility-audit.md` §5 F1。一句话：
 * `character_projections` 的前提是"一个角色一种投影一行"，
 * 而 Memory 需要"每条记忆各自一行、各自独立乐观锁、各自独立重放"。
 * 强行塞进去有两种写法，**两种都不成立**：
 *
 *   · `projectionType = 'memory:'+memoryId` —— 可行但绕
 *   · `projectionType = 'memory'`（一个角色一行，state 是 Record<id, record>）
 *     —— **毁掉 M4 最重要的性质**：所有记忆共享一个 revision，
 *     于是改 A 会让 B 的重放基准失效，而 `defaultIsStale()` 的
 *     角色级 sequence 单调判定会把多条记忆的写入互相判成"过时"
 *
 * 因此这里是一个**独立的纯函数**，`memory-store.ts` 在事务里调它、
 * `rebuildMemory()` 在重放时调它 —— 同一条代码路径，同一个结果。
 *
 * 这个 reducer 的版本进 `memory_records.reducer_version`，
 * 写路径会失败关闭（见 `assertReducerVersion`）。
 */

import {
  KernelError,
  MEMORY_CREATED,
  MEMORY_DISPUTED,
  MEMORY_MERGED,
  MEMORY_RESTORED,
  MEMORY_RETRACTED,
  MEMORY_SUPERSEDED,
  MEMORY_REDUCER_VERSION,
  type DomainEvent,
  type MemoryId,
  type MemoryRecord,
  type MemoryCreatedPayload,
  type MemoryDisputedPayload,
  type MemoryMergedPayload,
  type MemoryRestoredPayload,
  type MemoryRetractedPayload,
  type MemorySupersededPayload,
  asMemoryId,
} from '../contracts/index.ts'

/** M4 的 reducer 会处理的全部事件类型 */
export const MEMORY_HANDLED_EVENT_TYPES: readonly string[] = [
  MEMORY_CREATED,
  MEMORY_SUPERSEDED,
  MEMORY_RETRACTED,
  MEMORY_DISPUTED,
  MEMORY_MERGED,
  MEMORY_RESTORED,
]

export interface MemoryReduceResult {
  /** 折叠后的状态。`null` 表示"这条记忆还不存在"（或已被重建为不存在） */
  record: MemoryRecord | null
  /** 这次折叠是否真的改变了状态（用于统计与断言） */
  changed: boolean
}

/**
 * 折叠一个事件。
 *
 * ============================================================================
 *  ⚠️ 三条禁令（计划书第 72 节列得很明确）
 * ============================================================================
 * reducer 里**禁止**：调用 LLM、网络请求、读当前时间、随机数、写数据库。
 * 它们会让 Replay 失效 —— 而 Replay 是"投影不是真相"的唯一可执行证明。
 *
 * 具体到实现上，这意味着：
 *   · 时间一律从 `event.createdAt` 取，**不取 `Date.now()`**
 *   · 不生成新的 id
 *   · 不读 registry、不读配置
 *
 * 唯一的例外是 `revision`：它由"折叠了几个事件"决定，
 * 因此仍然是**输入的纯函数**（同样的事件序列永远得到同样的 revision）。
 */
export function reduceMemory(
  state: MemoryRecord | null,
  event: DomainEvent
): MemoryReduceResult {
  if (!MEMORY_HANDLED_EVENT_TYPES.includes(event.type)) {
    return { record: state, changed: false }
  }

  switch (event.type) {
    case MEMORY_CREATED:
      return applyCreated(state, event)

    case MEMORY_SUPERSEDED:
      return applySuperseded(state, event)

    case MEMORY_RETRACTED:
      return applyRetracted(state, event)

    case MEMORY_DISPUTED:
      return applyDisputed(state, event)

    case MEMORY_MERGED:
      return applyMerged(state, event)

    case MEMORY_RESTORED:
      return applyRestored(state, event)

    default:
      // 事件类型在 handledEventTypes 里但没实现 —— 这**必须**是硬错误，
      // 否则"声明了 handled 却不处理"会静默跳过状态变化，而 trace 上看起来一切正常。
      throw new KernelError(
        'validation_error',
        'memory_event_type_unhandled',
        `MEMORY_HANDLED_EVENT_TYPES 声明了 ${event.type}，但 reduceMemory 没有它的分支。` +
          '声明与实现不一致会让那条状态变化被静默跳过（SC 层面看不出来）',
        { type: event.type }
      )
  }
}

// ---------------------------------------------------------------------------
// 各个事件的折叠
// ---------------------------------------------------------------------------

/**
 * `MEMORY_CREATED` —— 从 payload 里的**首版完整快照**建立记录。
 *
 * 为什么 payload 必须带完整快照而不是只带 id：
 * `rebuildMemory()` 要从零重算出记录，而第一条事件是唯一的起点。
 * 若只带 id，重建就只能去读当前的 `memory_records` 行 ——
 * 那等于"用结果证明结果"，Replay 不再是独立验证（计划书第 74 节）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 三条时间字段的语义（实测踩到过不一致）
 * ---------------------------------------------------------------------------
 * `payload.record` 是**校验时刻**造出来的快照，它的 `recordedAt` 是
 * `Date.now()`（`recordFromCandidate` 的入参）。而事件的 `createdAt` 是
 * **落库时刻**（`applyAcceptedEvents` 的 `now`）。两者可以不同。
 *
 * 第一版直接 `...payload.record` 展开，于是 `recordedAt` 用的是校验时刻、
 * `createdAt`/`updatedAt` 用的是事件时刻 —— 同一行里出现
 * `recordedAt > createdAt`，自相矛盾，而且**重放永不报错**（两边都这么算）。
 *
 * 计划书第 37 节把 `recordedAt` 定义为"系统什么时候创建这条 Memory"，
 * 那正是事件被写入的时刻。因此这里**显式覆盖**它。
 *
 * ---------------------------------------------------------------------------
 *  首次创建 vs 重复创建（D2 追查发现的第二处）
 * ---------------------------------------------------------------------------
 * 同一条事实从**不同证据**被抽到两次时，两次都会产出 `MEMORY_CREATED`
 * （两份证据各自成立，见 `memory-validator.ts` 的说明）。此时：
 *
 *   · **不能**用第二条的快照去覆盖既有记录 —— 那会把证据换成第二条的，
 *     而第一条的证据仍在库里，两边对不上
 *   · **也不该**用第一条的快照覆盖第二条事件 —— 那会让"这条事件凭什么成立"
 *     指向别的证据，事件流不再是可信的 provenance
 *
 * 因此第二次（及以后）的 `MEMORY_CREATED` **只做记录、不改状态**：
 * 状态变化（revision 前进）由 `applyMemoryEvent` 在事务里单独施加。
 * "把新证据并进这条记忆"是**显式的证据增强**（`reinforce`），
 * 计划书第 49 节把它排在 M4 之后（见审计 §6 F3）。
 */
function applyCreated(state: MemoryRecord | null, event: DomainEvent): MemoryReduceResult {
  const payload = event.payload as MemoryCreatedPayload

  // id 不一致时不可能是"同一条的重复创建" —— 由调用方保证只传本记忆的事件，
  // 走到这里说明事件被喂错了，静默忽略会让缺状态的真事故意看不见。
  if (state !== null && String(state.id) !== String(payload.memoryId)) {
    throw new KernelError(
      'validation_error',
      'memory_created_id_mismatch',
      `MEMORY_CREATED 的 memoryId（${payload.memoryId}）与当前状态（${String(state.id)}）不一致：` +
        '事件流被喂给了错误的记忆，静默忽略会让真实的状态缺失看不见',
      { payloadMemoryId: payload.memoryId, stateId: String(state.id) }
    )
  }

  if (state !== null) {
    /*
     * ── 复活形（M9.1 / ADR-072 D05）─────────────────────────────────────
     * 标记的 previousStatus 与当前状态一致 ⇒ 这条 CREATE 是
     * 「忘掉/更正后**新的合格重述**」：采纳事件携带的复活快照为新状态。
     *
     * ⚠️ 守卫为什么是 **status 而不是 revision**（R08 实现期修正）：
     *   revision 的在线/重放语义**不同**——store 对每次折叠 +1
     *   （create=1, retract=2, …），而纯 reducer 只在创建/复活时设置它
     *   （applyRetracted 等不改 revision）。用 `previousRevision ===
     *   state.revision` 做守卫在重放里必然失配（2 ≠ 1）⇒ 复活只在在线
     *   发生 ⇒ A==B 破。`status` 是两侧一致的投影事实，因此守卫用它。
     *
     * D14（并发/第二次重述不重复复活）仍被保证：第一个复活后状态是
     * ACTIVE，第二个标记（previousStatus ∈ {retracted, superseded}）
     * 折在 active 上 ⇒ 状态不匹配 ⇒ no-op。DISPUTED 同理由 D10 排除。
     *
     * `previousRevision` 保留两个职责：复活后 revision = 该值 + 1（D04），
     * 以及发射时刻的审计快照；它**不是**守卫。
     *
     * 无标记 ⇒ 走下面的原 no-op 分支——**旧事件流重放语义逐字节不变**
     * （R07 兼容边界；这也是 `MEMORY_REDUCER_VERSION` 不升版的根据）。
     */
    const restatement = payload.restatement
    if (restatement !== undefined && restatement.previousStatus === state.status) {
      return {
        record: {
          ...payload.record,
          // revision 用发射侧算好的 previous+1（不信任快照里的其他 revision 来源）
          revision: restatement.previousRevision + 1,
          /*
           * 时间字段的纪律（R08 第二处实现期修正）：
           * `recordedAt`/`createdAt` 是**记录身份**的最初时刻——M4 起
           * store 的更新路径（updateRecordWithLock）就不写这两列，
           * 兄弟分支（applyRetracted/applySuperseded）也从不动它们。
           * 复活延续同一条记忆身份 ⇒ 保留 state 上的值；否则在线
           * （DB 行保留旧值）与重放（reducer 算出新值）必然分叉 ⇒ A==B 破。
           * **新告知的时刻由快照的 `validFrom` 承载**（D04：validFrom=now），
           * `updatedAt` 记录本次状态变化（与兄弟分支同款：event.createdAt）。
           */
          recordedAt: state.recordedAt,
          createdAt: state.createdAt,
          updatedAt: event.createdAt,
        },
        changed: true,
      }
    }

    // 已经存在（且无复活标记 / 守卫不匹配）：只记录事件（事件流已经由 store 落下），
    // 状态保持不变。
    return { record: state, changed: false }
  }

  return {
    record: {
      ...payload.record,
      revision: 1,
      // 时间三件套统一以**事件**为准（见上面的说明）
      recordedAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    },
    changed: true,
  }
}

/**
 * `MEMORY_SUPERSEDED` —— 旧事实让位于新状态（计划书第 31 / 36 / 84 节）。
 *
 * 三条同时发生，缺一不可：
 *   1. `status = 'superseded'`
 *   2. `validUntil = payload.validUntil`（**事实层面的失效时刻**，计划书第 36 节）
 *   3. `supersededBy = payload.supersededBy`（MI-07：必须能追溯旧 Memory）
 */
function applySuperseded(state: MemoryRecord | null, event: DomainEvent): MemoryReduceResult {
  const payload = event.payload as MemorySupersededPayload
  if (state === null) {
    throw missingState(event, payload.memoryId)
  }
  if (state.status === 'superseded') {
    return {
      record: {
        ...state,
        supersededBy: asMemoryId(payload.supersededBy),
        validUntil: payload.validUntil,
        updatedAt: state.updatedAt,
      },
      changed: false,
    }
  }

  return {
    record: {
      ...state,
      status: 'superseded',
      supersededBy: asMemoryId(payload.supersededBy),
      validUntil: payload.validUntil,
      updatedAt: event.createdAt,
    },
    changed: true,
  }
}

/**
 * `MEMORY_RETRACTED` —— 这条认知本身被判定错误或不应保留（计划书第 32 / 58 节）。
 *
 * 与 `SUPERSEDED` 的关键区别（计划书第 84 节）：
 * `VALID_UNTIL` **不动** —— 撤回不是在说"它曾经有效到某个时刻"，
 * 而是在说"它根本就不该被当成认知"。把两者写成同一个形状
 * 会让"她曾经真的相信过这件事"与"那是系统的一次误解"再也分不开。
 */
function applyRetracted(state: MemoryRecord | null, event: DomainEvent): MemoryReduceResult {
  const payload = event.payload as MemoryRetractedPayload
  if (state === null) {
    throw missingState(event, payload.memoryId)
  }
  if (state.status === 'retracted') {
    return { record: state, changed: false }
  }
  return {
    record: {
      ...state,
      status: 'retracted',
      updatedAt: event.createdAt,
    },
    changed: true,
  }
}

/**
 * `MEMORY_DISPUTED` —— 存在矛盾证据而系统还判不了（计划书第 33 / 82 节）。
 *
 * 计划书第 82 节的要求是"不要擅自选一个"。落到实现上就是：
 * 只改状态，**不动内容、不动 validUntil、不删任何东西** ——
 * 因为此刻任何进一步的动作都是"擅自选一个"。
 */
function applyDisputed(state: MemoryRecord | null, event: DomainEvent): MemoryReduceResult {
  const payload = event.payload as MemoryDisputedPayload
  if (state === null) {
    throw missingState(event, payload.memoryId)
  }
  if (state.status === 'disputed') {
    return { record: state, changed: false }
  }
  return {
    record: {
      ...state,
      status: 'disputed',
      updatedAt: event.createdAt,
    },
    changed: true,
  }
}

/**
 * `MEMORY_MERGED` —— 多条同义记忆合成一条（计划书第 75–78 节）。
 *
 * ============================================================================
 *  ⚠️ 这条事件**不改变胜者的状态**，而这是刻意的
 * ============================================================================
 * 一次合并实际上是**一串**事件：
 *
 *     MEMORY_MERGED      { winnerId, loserIds }     ← 记录"合并"这个事实
 *     MEMORY_SUPERSEDED  { memoryId: loser1, ... }   ← 每个败者各一条
 *     MEMORY_SUPERSEDED  { memoryId: loser2, ... }
 *
 * 为什么不在这一条里同时改败者：
 * **一条领域事件只能改变一个投影行**。若 `MEMORY_MERGED` 同时改多条记忆，
 * 那么 `rebuildMemory(败者)` 就必须读到"别人的"事件才能重建自己 ——
 * 而那条事件不属于它的 stream，重建结果会取决于**折叠顺序**，
 * `A == B` 就不再成立（计划书第 74 节）。
 *
 * 因此合并的语义落在 `MEMORY_SUPERSEDED` 上（它本来就表达
 * "旧条留痕、不再是现状"，正是败者该有的下场），而 `MEMORY_MERGED`
 * 负责**留下"这次合并发生过"这件事**与"胜者是谁"。
 *
 * 计划书第 70 节把它列为六种类型之一，因此它必须存在且必须真的被写 ——
 * 但它不是"状态的搬运工"，它是**那次决策的记录**。
 *
 * 证据的合并也遵循同一条规矩：不在这里做。
 * 若将来要"胜者吸收败者的证据"，那是一次显式的证据增强
 * （`reinforce`，M4 不实现，见审计 §6 F3），而不是合并的副作用。
 */
function applyMerged(state: MemoryRecord | null, event: DomainEvent): MemoryReduceResult {
  const payload = event.payload as MemoryMergedPayload
  if (state === null) {
    throw missingState(event, payload.winnerId)
  }

  // 只有胜者会走到这里（败者由 store 各发一条 MEMORY_SUPERSEDED）。
  // 不改变状态：这条事件的信息（谁与谁合并了）在事件流里，
  // 而"当前状态"（谁是 ACTIVE、谁被 SUPERSEDED）由 SUPERSEDED 决定。
  if (state.id !== asMemoryId(payload.winnerId)) {
    return { record: state, changed: false }
  }

  return { record: state, changed: false }
}

/**
 * `MEMORY_RESTORED` —— 把一条记忆恢复到 ACTIVE（计划书第 70 节）。
 *
 * 恢复的两条硬规定：
 *   1. `status = 'active'`
 *   2. **清掉 `validUntil`**（回到"没有终点"）。若不清，
 *      一条被 restore 的事实会带着上一次的失效时刻继续存在，
 *      而那个时刻正是它**被推翻**的证据 —— 留着它自相矛盾。
 *
 * `supersededBy` 也一并清掉：恢复之后它不再被谁取代。
 * `supersedes`/`supersededBy` 的**历史**不丢 —— 它们在领域事件里。
 */
function applyRestored(state: MemoryRecord | null, event: DomainEvent): MemoryReduceResult {
  const payload = event.payload as MemoryRestoredPayload
  if (state === null) {
    throw missingState(event, payload.memoryId)
  }
  if (state.status === 'active' && state.validUntil === null) {
    return { record: state, changed: false }
  }

  const { supersededBy: _drop, ...rest } = state
  void _drop
  return {
    record: {
      ...rest,
      status: 'active',
      validUntil: null,
      updatedAt: event.createdAt,
    },
    changed: true,
  }
}

// ---------------------------------------------------------------------------
// 从零重放（计划书第 73–74 节）
// ---------------------------------------------------------------------------

export interface MemoryReplayResult {
  record: MemoryRecord | null
  appliedEvents: number
  /** 被跳过的事件（不属于 Memory reducer 处理的类型） */
  skippedEvents: number
  /** 折叠过的领域事件 id，按序 */
  eventIds: string[]
}

/**
 * 从事件流重算一条记忆。
 *
 * **纯计算、不写库** —— 持久化由 `memory-store.rebuildMemory()` 负责。
 * 这样"重建出来的结果对不对"可以在内存里独立测试
 * （与 `replayProjection()` 同一个设计，SC-005 的判定核心）。
 *
 * 事件按 `sequence` 升序折叠：Replay 的正确性依赖顺序，
 * **不能指望传入顺序**（乱序 Job 是正常现象，不是故障）。
 */
export function replayMemory(
  events: readonly DomainEvent[],
  memoryId: MemoryId
): MemoryReplayResult {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  let state: MemoryRecord | null = null
  let applied = 0
  let skipped = 0
  const eventIds: string[] = []

  for (const event of ordered) {
    if (!MEMORY_HANDLED_EVENT_TYPES.includes(event.type)) {
      skipped += 1
      continue
    }
    // 只折叠属于这条记忆的事件。`MEMORY_MERGED` 的胜者判定也在 reducer 里做，
    // 因此这里不需要额外的 id 筛选逻辑 —— 由 reducer 自己拒绝不相干的事件。
    const eventMemoryId = memoryIdOfEvent(event)
    if (eventMemoryId !== undefined && String(eventMemoryId) !== String(memoryId)) {
      // 合并类事件同时涉及胜者与败者：只有胜者那一条会真正改变状态，
      // 由 reducer 的 `state.id !== winnerId` 分支处理。
      if (event.type !== MEMORY_MERGED) {
        skipped += 1
        continue
      }
    }

    const result = reduceMemory(state, event)
    state = result.record
    applied += 1
    eventIds.push(String(event.id))
  }

  return { record: state, appliedEvents: applied, skippedEvents: skipped, eventIds }
}

/**
 * 从事件 payload 里取出它指向哪个 memoryId。
 *
 * 全部六个类型的 payload 都带 `memoryId`（`MEMORY_MERGED` 用 `winnerId`），
 * 因此这里可以统一取；取不到返回 `undefined`（调用方按"不相干"处理）。
 */
export function memoryIdOfEvent(event: DomainEvent): MemoryId | undefined {
  const payload = event.payload as Record<string, unknown> | null
  if (payload === null || typeof payload !== 'object') return undefined

  const direct = payload.memoryId
  if (typeof direct === 'string' && direct.trim() !== '') return asMemoryId(direct)

  const winner = payload.winnerId
  if (typeof winner === 'string' && winner.trim() !== '') return asMemoryId(winner)

  return undefined
}

// ---------------------------------------------------------------------------
// 便捷入口（供诊断与测试）
// ---------------------------------------------------------------------------

/**
 * 把 reducer 的元信息与折叠函数打成一包（供诊断与测试）。
 *
 * ⚠️ 它**不是** `ProjectionReducer`，也**不能**喂给 `applyEvent()` /
 * `rebuildProjection()` —— 那些函数要求 `projectionType` 是编译期常量，
 * 而 Memory 的投影是按 memoryId 分的（见
 * `docs/m4/compatibility-audit.md` §5 F1）。
 *
 * 它的名字是一个**误命名风险**：看起来像 `ProjectionReducer` 的工厂，
 * 实际只是"版本 + 处理的事件类型 + 纯函数"的三件套。
 * 若将来有第二个调用点，应当先改名（例如 `memoryReducerInfo`），
 * 而不是让它继续被当成投影 reducer 用。
 *
 * 之所以保留它：`version` 与 `handledEventTypes` 是**会被读到**的
 * （`kernel-tests-memory.ts` 断言"声明与实现一致"），
 * 而把这两个常量散在 import 里比打一包更难审阅。
 */
export function createMemoryReducer(): {
  version: string
  handledEventTypes: readonly string[]
  reduce: (state: MemoryRecord | null, event: DomainEvent) => MemoryReduceResult
} {
  return {
    version: MEMORY_REDUCER_VERSION,
    handledEventTypes: MEMORY_HANDLED_EVENT_TYPES,
    reduce: reduceMemory,
  }
}

// ---------------------------------------------------------------------------
// 版本守卫
// ---------------------------------------------------------------------------

function missingState(event: DomainEvent, memoryId: string): KernelError {
  return new KernelError(
    'validation_error',
    'memory_record_missing',
    `${event.type} 指向的记忆 ${memoryId} 不存在（或还没有被 MEMORY_CREATED 建立）。` +
      '这类事件**不允许**凭空创建记录：状态变化必须有一条被创建的历史',
    { type: event.type, memoryId }
  )
}
