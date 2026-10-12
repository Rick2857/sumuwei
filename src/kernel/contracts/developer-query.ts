/**
 * Developer Query Contract —— **开发者平面的只读查询契约**（M5.1 WP1 / AT1.1）。
 *
 * ============================================================================
 *  它是什么，以及它**不是**什么
 * ============================================================================
 * 这条契约回答的是："把已经存在的事实以**只读**方式摊给开发者看，要看哪些东西？"
 *
 *   它是：  一个 **port**（`DeveloperQueryService`）＋ 一组 **DTO** ＋ 一组失败关闭的入参解析器
 *   它不是：一次查询实现（WP2）、一个 HTTP 服务（WP2）、一个页面（WP5）、
 *          一套新的状态判断（AT2.4 明令：Memory 诊断必须复用既有探针）
 *
 * ---------------------------------------------------------------------------
 *  四条硬约束（每条都对应一个真实会犯的错）
 * ---------------------------------------------------------------------------
 * ① **DTO，不是 persistence entity**（AT1.1）
 *    `CharacterRunTrace` / `ExecutionRecordView` / `MemoryStatsView` 都是**权威形状**，
 *    但它们各自带层级（`request` / `decision` / `result` 嵌套、`steps[]`、`evidence[]`）。
 *    直接把它们丢给 API 会让"开发者面需要什么"与"业务内部长什么样"永久绑死 ——
 *    于是任何一次内部重构都变成一次 API 破坏。DTO 是**显式的最小投影**。
 *
 * ② **只读**（G-03）
 *    本文件里**没有任何写操作**，也没有任何 IO。适配器（WP2）只允许调既有 readers。
 *    这不是"我们约定不写"，而是这条契约上根本没有能写的方法。
 *
 * ③ **有界**（AT2.3）
 *    没有上界的列表查询等于没有查询。`DEVELOPER_QUERY_LIMITS` 是硬边界，
 *    越界一律抛错（而不是"静默截断成 500 行" —— 那会让人以为看到的是全部）。
 *
 * ④ **如实**（AT2.5 / G-05）
 *    真实链路里 `intent` 恒为 `current_fact`、`target` 恒为 `none`（M5 局限 1），
 *    账本里也**没有** `attempted` / `verified` 的独立证据。
 *    于是本契约把"这个字段今天填不出来"做成了**一等公民**
 *    （`DeveloperQueryAvailability`），而不是用一个看起来像真的假值糊过去。
 *    `verified: true` 只能来自真实的核验证据 —— **绝不由 `executed` 推导**。
 *
 * ---------------------------------------------------------------------------
 *  权威来源（每一个 DTO 字段都必须能落到下表某一行）
 * ---------------------------------------------------------------------------
 *  DTO                      权威形状                                     位置
 *  HealthDto                身份快照 + 迁移版本 + 完整性探针             见各字段注释
 *  CapabilitiesDto          CapabilityRegistry（M4.5）+ 召回能力报告      kernel/action/capability-registry.ts
 *  TraceSummaryDto          CharacterRunTrace                           kernel/contracts/trace.ts:121
 *  TraceDetailDto           CharacterRunTrace（全字段）                 同上
 *  MemoryStatsDto           MemoryStatsView                             kernel/app/memory/admin.ts:387
 *  MemoryIntegrityDto       MemoryIntegrityProblems                     infrastructure/persistence/memory-integrity.ts:46
 *  ExecutionSummaryDto      ExecutionRecordView                          kernel/action/execution-ledger.ts:201
 *  ExecutionDetailDto       ExecutionRecordView + ActionLedgerEvent[]   + kernel/action/execution-ledger.ts:76
 *
 *  派生字段（不来自权威、由契约显式声明）只有三个：
 *  `durationMs`（= finishedAt - startedAt）、`stepCount`、`hasError`。
 *  `scripts/kernel-tests-dev-plane.ts` 有一条**编译期**断言锁住这件事：
 *  DTO 的每个键要么在权威形状里存在，要么在这个派生清单里。
 */

import {
  KernelError,
  asActionId,
  asCharacterId,
  asTraceId,
  type ActionId,
  type CharacterId,
  type ConversationEventId,
  type Timestamp,
  type TraceId,
} from './ids.ts'
import type { CharacterRunTrace, TraceStatus, TraceStep } from './trace.ts'
import type { AttributionValue } from './actor.ts'

export const DEVELOPER_QUERY_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// 硬边界
// ---------------------------------------------------------------------------

export const DEVELOPER_QUERY_LIMITS = {
  /** 列表查询的下限/上限/缺省。上限不是"性能调优"，是"不许无界扫描" */
  minLimit: 1,
  maxLimit: 100,
  defaultLimit: 20,
  /**
   * cursor 的字符上限。
   *
   * 有界是**契约**的一部分：没有它，一个 10 MB 的 cursor 会先被解码再被拒绝，
   * 于是"防无界"这件事在解析层就已经失效了。
   */
  maxCursorLength: 256,
  /** 单条 trace 详情里允许回传的 step 数（超出 → 抛错而不是静默截断） */
  maxStepsInDetail: 500,
  /** 单个 step 的 attributes 键数上限（`TraceStep.attributes` 是受控形状） */
  maxAttributesPerStep: 64,
  /** 完整性明细里每类最多回传多少行（只回 id，不回正文） */
  maxIntegrityRows: 200,
} as const

// ---------------------------------------------------------------------------
// 失败关闭的共用形状
// ---------------------------------------------------------------------------

/**
 * 查不到 / 不许看时用的理由码。
 *
 * 与 M5 的 `RecallExclusionReason` 同一条纪律：**值是受控枚举，不是自由文本**。
 * 自由文本会让人写 `"not found"` / `"notfound"` / `"没找到"` 三种，
 * 于是"为什么看不到"这件事无法被统计。
 */
export type DeveloperQueryReasonCode =
  /** 这个 id 确实不存在 */
  | 'not_found'
  /** 存在，但不属于当前角色 / 不在本次开发者面的作用域内 */
  | 'out_of_scope'
  /** 存在，但属于另一个角色（未来多角色时与 out_of_scope 区分开） */
  | 'character_mismatch'
  /** 该字段/能力今天没有真实值（见文件头 ④）—— **这不是错误** */
  | 'not_available'

export const DEVELOPER_QUERY_REASON_CODES: readonly DeveloperQueryReasonCode[] = [
  'not_found',
  'out_of_scope',
  'character_mismatch',
  'not_available',
]

export function isDeveloperQueryReasonCode(
  value: unknown
): value is DeveloperQueryReasonCode {
  return (
    typeof value === 'string' &&
    (DEVELOPER_QUERY_REASON_CODES as readonly string[]).includes(value)
  )
}

/**
 * "看得到 / 看不到"的**唯一**结果形状。
 *
 * ⚠️ 刻意**不用** `T | undefined`：调用方无法回答"是没找到，还是不许看，还是今天填不出来"，
 *    而这三件事在排查时的处置完全不同（前者翻库、中者查作用域、后者查局限清单）。
 */
/**
 * "看不到"的那一支。
 *
 * 单独抽出来（而不是内联进 `DeveloperLookup` 的联合）是为了让它**可被命名**：
 * 适配器与 HTTP 层都要能写 `DeveloperMiss` 这个类型，而不是每次都从联合里 `Extract`。
 */
export interface DeveloperMiss {
  found: false
  reasonCode: DeveloperQueryReasonCode
  reason: string
}

export type DeveloperLookup<T> = { found: true; value: T } | DeveloperMiss

export function found<T>(value: T): DeveloperLookup<T> {
  return { found: true, value }
}

export function notFound(reasonCode: DeveloperQueryReasonCode, reason: string): DeveloperMiss {
  if (reason.trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_lookup_reason_required',
      'not_found 结果必须写清楚原因：只回一个 reasonCode 等于把"为什么看不到"留给调用方猜'
    )
  }
  return { found: false, reasonCode, reason }
}

/**
 * 一致性断言。
 *
 * 它守的是"`found: true` 与 `reasonCode` 不能同时出现"这类**结构上本不该发生**的组合 ——
 * 一旦发生，说明某个 adapter 手工拼了结果而不是走 `found()/notFound()`。
 */
export function assertDeveloperLookup(value: DeveloperLookup<unknown>): void {
  const raw = value as Record<string, unknown>
  if (raw.found === true) {
    if (!('value' in raw)) {
      throw new KernelError(
        'validation_error',
        'developer_lookup_missing_value',
        'found=true 的结果必须带 value'
      )
    }
    if (raw.reasonCode !== undefined || raw.reason !== undefined) {
      throw new KernelError(
        'validation_error',
        'developer_lookup_found_with_reason',
        'found=true 与 reasonCode/reason 不能同时出现：那会让"找到了一条但理由是 not_found"成为可能'
      )
    }
    return
  }
  if (raw.found === false) {
    if ('value' in raw) {
      throw new KernelError(
        'validation_error',
        'developer_lookup_notfound_with_value',
        'found=false 的结果不许带 value'
      )
    }
    if (!isDeveloperQueryReasonCode(raw.reasonCode)) {
      throw new KernelError(
        'validation_error',
        'developer_lookup_bad_reason',
        `reasonCode 必须是受控枚举之一，收到 ${String(raw.reasonCode)}`
      )
    }
    return
  }
  throw new KernelError(
    'validation_error',
    'developer_lookup_missing_found',
    'DeveloperLookup 必须有 found 布尔'
  )
}

// ---------------------------------------------------------------------------
// 有界分页（AT2.3）
// ---------------------------------------------------------------------------

/**
 * 游标键。
 *
 * 与既有索引对齐：`character_traces_recent (character_id, started_at desc)`
 * （`migrations.ts:224`）—— 所以游标就是 `(startedAt, id)`，一次 where 就能接着往下读。
 */
export interface DeveloperCursorKey {
  startedAt: Timestamp
  id: string
}

/** 游标形态前缀（带版本号：形态变了能被识别出来，而不是被解成一个看似合法的错键） */
export const DEVELOPER_CURSOR_PREFIX = 'v1'

/**
 * 编码游标。
 *
 * ⚠️ 刻意**不用** base64：
 *   · `src/kernel/**` 不许 import `node:Buffer`（依赖方向静态锁会拦）；
 *   · 用全局 `btoa` 会把"纯函数"变成"依赖运行时全局"；
 *   · 手写 base64 是为了**不透明**，而不透明在这里不是安全属性 ——
 *     这个面本来就只有 loopback + dev-only（见 Authority Map 的 F-1 裁定）。
 * 于是取一个更诚实的做法：可读、可校验、有界、纯函数。
 */
export function encodeDeveloperCursor(key: DeveloperCursorKey): string {
  if (!Number.isSafeInteger(key.startedAt) || key.startedAt < 0) {
    throw new KernelError(
      'validation_error',
      'developer_cursor_bad_started_at',
      `cursor.startedAt 必须是安全的非负整型毫秒时间戳，收到 ${String(key.startedAt)}`
    )
  }
  if (key.id.trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_cursor_bad_id',
      'cursor.id 不能为空：空 id 会让下一页从"某条同时间的记录"开始，于是分页会重复或跳过'
    )
  }
  const cursor = `${DEVELOPER_CURSOR_PREFIX}.${key.startedAt}.${encodeURIComponent(key.id)}`
  if (cursor.length > DEVELOPER_QUERY_LIMITS.maxCursorLength) {
    throw new KernelError(
      'validation_error',
      'developer_cursor_too_long',
      `cursor 超过 ${DEVELOPER_QUERY_LIMITS.maxCursorLength} 字符上限（收到 ${cursor.length}）`
    )
  }
  return cursor
}

/** 解码 + 校验（**唯一**接受外部 cursor 的入口；任何不合格形状都抛错，不"尽力而为"） */
export function decodeDeveloperCursor(cursor: string): DeveloperCursorKey {
  assertDeveloperCursor(cursor)
  const parts = cursor.split('.')
  const startedAt = Number(parts[1])
  const id = decodeURIComponent(parts.slice(2).join('.'))
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new KernelError(
      'validation_error',
      'developer_cursor_bad_started_at',
      `cursor 里的时间戳不合法：${String(parts[1])}`
    )
  }
  if (id.trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_cursor_bad_id',
      'cursor 里的 id 为空'
    )
  }
  return { startedAt, id }
}

export function assertDeveloperCursor(cursor: unknown): asserts cursor is string {
  if (typeof cursor !== 'string' || cursor.trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_cursor_not_string',
      'cursor 必须是字符串'
    )
  }
  if (cursor.length > DEVELOPER_QUERY_LIMITS.maxCursorLength) {
    throw new KernelError(
      'validation_error',
      'developer_cursor_too_long',
      `cursor 超过 ${DEVELOPER_QUERY_LIMITS.maxCursorLength} 字符上限（收到 ${cursor.length}）`
    )
  }
  const parts = cursor.split('.')
  if (parts[0] !== DEVELOPER_CURSOR_PREFIX || parts.length < 3) {
    throw new KernelError(
      'validation_error',
      'developer_cursor_malformed',
      `cursor 形态必须是 "${DEVELOPER_CURSOR_PREFIX}.<startedAt>.<id>"，收到 ${JSON.stringify(
        cursor.slice(0, 40)
      )}`
    )
  }
}

export interface DeveloperPageRequest {
  limit?: number
  cursor?: string
}

/**
 * 一页结果。
 *
 * `hasMore` 是**必须**的：只给 `nextCursor` 会让调用方用"cursor 是不是 undefined"
 * 来推断还有没有下一页，而"恰好读完最后一页"与"下一页是空的"是两件事。
 */
export interface DeveloperPage<T> {
  items: T[]
  limit: number
  hasMore: boolean
  nextCursor?: string
}

/**
 * WP7（U-14 / K-30）：**带归因的**一页结果 —— 于是它带 unknown 计数。
 *
 * ⚠️ 计数**不能**挂在泛型 `DeveloperPage<T>` 上：执行侧的列表面
 * （`listExecutions`）**刻意不带归因**（WP6-4：每行都去读一次事件流就是 N+1），
 * 因此它的"当前结果集"里**没有归因数据**。给它一个 `counts: 0` 会把
 * "这个响应不携带归因"说成"没有未知" —— 那正是 U-14 要防的"未知消失在别的状态里"。
 *
 * 所以：**谁携带归因，谁才报计数**；不携带的响应让字段**缺席**（与"无信封"同一条纪律）。
 * 范围就是这一页 `items`，与"你眼前看到的这些行"永远同源。
 */
export interface DeveloperTraceListDto extends DeveloperPage<TraceSummaryDto> {
  counts: DeveloperAttributionCountsDto
}

/** 校验 limit（唯一入口；越界抛错而不是夹住 —— 夹住会让调用方以为它要的 500 条被满足了） */
export function assertDeveloperLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit)) {
    throw new KernelError(
      'validation_error',
      'developer_bad_limit',
      `limit 必须是整数，收到 ${String(limit)}`
    )
  }
  const { minLimit, maxLimit } = DEVELOPER_QUERY_LIMITS
  if (limit < minLimit || limit > maxLimit) {
    throw new KernelError(
      'validation_error',
      'developer_limit_out_of_range',
      `limit 必须在 [${minLimit}, ${maxLimit}] 内，收到 ${limit}。` +
        '没有上界的列表查询等于没有查询 —— 它会让人以为自己看到的是全部'
    )
  }
  return limit
}

/** 从可选的 `DeveloperPageRequest` 解析出**已校验**的 limit（缺省 → defaultLimit） */
export function resolveDeveloperLimit(request: DeveloperPageRequest = {}): number {
  if (request.limit === undefined) return DEVELOPER_QUERY_LIMITS.defaultLimit
  return assertDeveloperLimit(request.limit)
}

// ---------------------------------------------------------------------------
// "今天有没有真实值" —— 一等公民
// ---------------------------------------------------------------------------

/**
 * 某个字段/能力的可用性。
 *
 * ⚠️ 它与 M5 的 `available: false` 是同一条纪律
 *    （`RecallScoreComponent.available`：**不是 0 分，是没有这个通道**）：
 *    谎报一个可用值比报"不可用"危险得多，因为前者会被当成证据。
 */
export type DeveloperQueryAvailability =
  | { status: 'available' }
  | { status: 'not_available'; reason: string }
  | { status: 'degraded'; reason: string }

export function isDeveloperQueryAvailability(value: unknown): value is DeveloperQueryAvailability {
  if (value === null || typeof value !== 'object') return false
  const status = (value as { status?: unknown }).status
  return status === 'available' || status === 'not_available' || status === 'degraded'
}

/** 构造一个"不可用"（理由必填 —— 没有理由的 not_available 等于没交代） */
export function unavailable(reason: string): DeveloperQueryAvailability {
  if (reason.trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_availability_reason_required',
      'not_available 必须写明理由：否则它只是把"我不知道"换了个说法'
    )
  }
  return { status: 'not_available', reason }
}

export const AVAILABLE: DeveloperQueryAvailability = { status: 'available' }

// ---------------------------------------------------------------------------
// Health / Capabilities
// ---------------------------------------------------------------------------

export type DeveloperHealthStatus = 'ok' | 'degraded' | 'failed'

/** 一条健康明细。**只允许计数 / 状态 / 错误码** —— 不许有正文（AT1.4） */
export interface DeveloperHealthDetailDto {
  name: string
  status: DeveloperHealthStatus
  detail?: string
}

export interface HealthQuery {
  characterId?: CharacterId
}

export interface HealthDto {
  status: DeveloperHealthStatus
  generatedAt: Timestamp
  schemaVersion: number
  /** 本次程序运行 id（**不是**角色身份，`contracts/trace.ts:131` 的理由同样适用） */
  runtimeId?: string
  /** 本轮/最近一轮用的 Seed 版本与指纹（"她答错了是不是因为用错版本"） */
  seedVersion?: number
  seedHash?: string
  /** 当前库的迁移版本（`MIGRATIONS` 的长度） */
  migrationVersion?: number
  /**
   * 记忆完整性是否干净。
   *
   * ⚠️ 它**只能**来自 M5-PRE 的状态级探针 `memoryIntegrityProblems()`
   *    （`infrastructure/persistence/memory-integrity.ts:73`），
   *    **不许**由 `unsupportedMemories()` 的行数推导 —— 后者在
   *    D-7 那个真实事故里报的是 0，而库已经不一致了。
   */
  integrityOk?: boolean
  details: DeveloperHealthDetailDto[]
}

export type DeveloperQueryCapabilityId =
  | 'health'
  | 'capabilities'
  | 'traces'
  | 'trace_detail'
  | 'memory_stats'
  | 'memory_integrity'
  | 'executions'
  | 'execution_detail'

export const DEVELOPER_QUERY_CAPABILITY_IDS: readonly DeveloperQueryCapabilityId[] = [
  'health',
  'capabilities',
  'traces',
  'trace_detail',
  'memory_stats',
  'memory_integrity',
  'executions',
  'execution_detail',
]

export interface DeveloperQueryCapabilityFact {
  id: DeveloperQueryCapabilityId
  kind: 'runtime' | 'trace' | 'memory' | 'execution'
  /** 权威模块（"这个数字是谁说的"）。**空字符串被拒绝** —— 没有权威的能力不该存在 */
  authority: string
  availability: DeveloperQueryAvailability
}

/**
 * 查询能力的登记表。
 *
 * 与 M5 的 `RECALL_EXCLUSION_REASON_FACTS` / `RECALL_CHANNEL_FACTS` 同一个模式：
 * **每登记一个值，就必须说清它由谁产出**。
 * 本项目最贵的缺陷形状之一是"看起来能表达、永远触发不了"的值 ——
 * 这里用"authority 必填 + 测试逐条断言非空"把它挡在契约层。
 */
export const DEVELOPER_QUERY_CAPABILITY_FACTS: Readonly<
  Record<DeveloperQueryCapabilityId, DeveloperQueryCapabilityFact>
> = {
  health: { id: 'health', kind: 'runtime', authority: 'identity_snapshots + MIGRATIONS + memoryIntegrityProblems()', availability: AVAILABLE },
  capabilities: { id: 'capabilities', kind: 'runtime', authority: 'kernel/action/capability-registry.ts', availability: AVAILABLE },
  traces: { id: 'traces', kind: 'trace', authority: 'character_traces（character_traces_recent 索引）', availability: AVAILABLE },
  trace_detail: { id: 'trace_detail', kind: 'trace', authority: 'character_traces（getTrace）', availability: AVAILABLE },
  memory_stats: { id: 'memory_stats', kind: 'memory', authority: 'MemoryStatsView（kernel/app/memory/admin.ts:387）+ 第二个只读探针 unqualifiedUserFacts()（M5.1.1 / Phase 4b，ADR-043 DR-9）', availability: AVAILABLE },
  memory_integrity: { id: 'memory_integrity', kind: 'memory', authority: 'memoryIntegrityProblems()（M5-PRE 状态级探针）', availability: AVAILABLE },
  executions: { id: 'executions', kind: 'execution', authority: 'ExecutionRecordView / ExecutionLedgerPort', availability: AVAILABLE },
  execution_detail: { id: 'execution_detail', kind: 'execution', authority: 'ExecutionRecordView + ActionLedgerEvent[]', availability: AVAILABLE },
}

export function assertDeveloperCapabilityFact(fact: DeveloperQueryCapabilityFact): void {
  if (fact.authority.trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_capability_without_authority',
      `查询能力 ${fact.id} 没有登记 authority：那它就是一个"看起来存在、说不出谁负责"的能力`
    )
  }
  if (!isDeveloperQueryAvailability(fact.availability)) {
    throw new KernelError(
      'validation_error',
      'developer_capability_bad_availability',
      `查询能力 ${fact.id} 的 availability 形状不合法`
    )
  }
}

export interface CapabilitiesQuery {
  characterId?: CharacterId
}

/**
 * 运行时能力报告中的一条。
 *
 * 它与 `DeveloperQueryCapabilityFact` 的区别是刻意的：
 *   · 前者描述"**这次进程**里某个能力/通道今天可不可用"（如语义召回不可用）
 *   · 后者描述"开发者面的 8 个端点分别由谁负责"
 * 把两者合成一个表会让"端点存在"与"底层通道可用"混为一谈。
 */
export interface DeveloperRuntimeCapabilityDto {
  id: string
  authority: string
  availability: DeveloperQueryAvailability
  note?: string
}

export interface CapabilitiesDto {
  schemaVersion: number
  query: DeveloperQueryCapabilityFact[]
  runtime: DeveloperRuntimeCapabilityDto[]
}

// ---------------------------------------------------------------------------
// Trace DTO
// ---------------------------------------------------------------------------

export interface DeveloperTraceStepDto {
  kind: TraceStep['kind']
  label: string
  status: TraceStep['status']
  startedAt: Timestamp
  finishedAt?: Timestamp
  /** **派生**：finishedAt - startedAt（未结束 → 缺省）。它不是一个独立事实 */
  durationMs?: number
  attributes: Readonly<Record<string, string | number | boolean>>
}

export interface TraceListQuery extends DeveloperPageRequest {
  characterId: CharacterId
  /** 只回这些终态（缺省 = 全部）。过滤**必须发生在 SQL 里**，不是读回来再 filter */
  status?: TraceStatus
}

export interface TraceGetQuery {
  characterId: CharacterId
  traceId: TraceId
}

export interface TraceSummaryDto {
  traceId: TraceId
  characterId: CharacterId
  status: TraceStatus
  startedAt: Timestamp
  finishedAt?: Timestamp
  /** **派生** */
  durationMs?: number
  runtimeId?: string
  userId?: string
  conversationId?: string
  inputEventId: ConversationEventId
  outputEventId?: ConversationEventId
  modelProfile?: string
  seedVersion?: number
  seedHash?: string
  contextCompilerVersion?: string
  contextSectionIds: string[]
  droppedSectionIds: string[]
  sourceConversationEventIds: string[]
  selectedMemoryIds: string[]
  actionIds: string[]
  /** **派生**（摘要不回传 `steps[]`：那是详情的职责，也是体积的主要来源） */
  stepCount: number
  /** **派生**（摘要只回"有没有错"，错误文本属详情） */
  hasError: boolean
  /**
   * WP6-6：这一轮**输入事件**的**存储归因**（不是第二份存储）。
   *
   * 传播路径：`trace.input_event_id` → 那条 conversation event → **它落库时的归因列**。
   *   · 输入事件没有归因信封（历史行 / 没记）⇒ 本字段**缺席**（不是"三态全 Absent"）
   *   · `MIGRATED_LEGACY` 行 ⇒ `attributionOrigin` **原样**是 `MIGRATED_LEGACY`
   *   · `Unknown(reason)` 原样是 `UNKNOWN`（**不**折叠成 `ABSENT` / `null` / `-`）
   *
   * ⚠️ 它是**派生**的（因此出现在下面的接地清单里）：`character_traces` 上
   * **没有**、也**不允许有**任何归因列。写进清单的理由见 WP6-5 / WP6-6。
   */
  attribution?: DeveloperAttributionDto
}

export interface TraceDetailDto extends TraceSummaryDto {
  /** 人类可读、**不含正文**（`contracts/trace.ts:218` 的同一条纪律） */
  error?: string
  steps: DeveloperTraceStepDto[]
  projectionRevisionsAtStart: Record<string, number>
  projectionRevisionsAtEnd: Record<string, number>
  domainEventIds: string[]
  identitySourceRefs: string[]
  postTurnJobIds: string[]
  processorVersions: Record<string, string>
  /** WP7：**本条记录**（单条结果集）的 unknown 计数 */
  counts: DeveloperAttributionCountsDto
  /**
   * M6 / WP5（ADR-050）：**这一轮的会话摘要事实**（派生）。
   *
   * 接地面 = `character_traces.steps[]` 里 `kind: 'context_compile'` 那一步的
   * `rollup_*` 属性（由 `turn-gateway` 写入；M6 的接线门 §③-5 断言那个属性块
   * **不含正文**）。因此它不是"凭空造的键"：可机检的链条是
   * `trace.steps[] → context_compile → rollup_* → developerRollupSummaryOf()`。
   *
   * ⚠️ **缺席 ≠ 全 0**（这是本字段最重要的语义）：
   *   · 那一轮**没启用摘要**（额度 0 / 没接端口）⇒ 本字段**不存在**
   *   · 启用了、但窗口内没有合格来源      ⇒ 本字段存在，且 `itemCount = 0`
   * 把前者渲染成"0 条"就是把"不知道"伪装成"确定"（与本仓库已登记的
   * "token 不可得记 null，不伪装成 0"是同一条纪律）。
   */
  rollup?: DeveloperRollupSummaryDto
}

// ---------------------------------------------------------------------------
// M6 / WP5：会话摘要的开发者面 DTO
// ---------------------------------------------------------------------------

/**
 * `turn-gateway` 写进 `context_compile` step 的**全部**属性名。
 *
 * 逐字登记的理由：`developerRollupSummaryOf()` 只认这些键 —— 少一个就当
 * "这一轮没记过摘要"（缺席），而**不是**补一个 0。多出来的键一律忽略
 * （step 属性是开放字典，别的东西也在里面）。
 */
export const DEVELOPER_ROLLUP_ATTRIBUTE_KEYS = [
  'rollup_status',
  'rollup_selector_version',
  'rollup_scanned',
  'rollup_items',
  'rollup_source_refs',
  'rollup_covered_from',
  'rollup_covered_to',
  'rollup_omitted_eligible',
  'rollup_skipped_by_recent',
  'rollup_coverage_truncated',
  'rollup_rejected_unconfirmed',
  'rollup_rejected_contradicted',
  'rollup_rejected_non_user',
  'rollup_rejected_invalidated',
  'rollup_rejected_out_of_scope',
  'rollup_section_survived',
] as const

/**
 * 一轮会话摘要的**开发者面视图**。
 *
 * 它只装"引用与计数"（ADR-050 `DR-9`）：`sourceRefs` 是 `cev:<id>`，
 * **没有任何正文**。每个数字都能回到那一步的属性上。
 */
export interface DeveloperRollupSummaryDto {
  /** `evaluated` = 真的求值过；`read_failed` = 读取面失败（当轮失败关闭、不注入） */
  status: 'evaluated' | 'read_failed'
  selectorVersion: string
  /** 实际进入判定的来源条数（0 与"没扫到"是两件事） */
  scannedEventCount: number
  itemCount: number
  sourceRefs: string[]
  /** 覆盖的序列范围；空选择时**缺席**（不是 0..0） */
  coveredSequenceRange?: { from: number; to: number }
  omittedEligibleCount: number
  skippedByRecentWindow: number
  coverageTruncated: boolean
  /** 每类拒绝理由的计数（**闭集**，与选择器的 `RollupRejectionCode` 一一对应） */
  rejections: {
    unconfirmedOrigin: number
    contradictedOrigin: number
    nonUserSource: number
    invalidatedByMemoryState: number
    outOfScope: number
  }
  /**
   * 这一段的 section 是否**活过了编译器裁剪**。
   *
   * ⚠️ 它是"选了 ≠ 入模"这条区分的落点：`itemCount > 0 && !sectionSurvived`
   *    表示**选择器选了、但模型没看到**。
   */
  sectionSurvived: boolean
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 从 `context_compile` step 的属性和出摘要视图（**纯函数、失败关闭**）。
 *
 * ```text
 *   没有 `rollup_status`            → undefined（这一轮没启用摘要；**不是** 0）
 *   有 `rollup_status` 但形状不完整  → undefined（记了一半的属性不可信，不猜）
 *   形状完整                        → 视图（`itemCount` 可以是 0，那是"启用过但没选中"）
 * ```
 *
 * ⚠️ 第二条刻意**严格**：属性是一张开放字典，读到一半的键就拼一半的数，
 * 会让"0 条入选"与"属性没写完"在页面上长得一样 —— 那正是本仓库反复登记的
 * "数字对 ≠ 数字描述的是你以为的那个东西"。
 */
export function developerRollupSummaryOf(
  attributes: Readonly<Record<string, unknown>>
): DeveloperRollupSummaryDto | undefined {
  const status = stringOf(attributes.rollup_status)
  if (status !== 'evaluated' && status !== 'read_failed') return undefined

  const selectorVersion = stringOf(attributes.rollup_selector_version)
  const scanned = numberOf(attributes.rollup_scanned)
  const items = numberOf(attributes.rollup_items)
  const omitted = numberOf(attributes.rollup_omitted_eligible)
  const skipped = numberOf(attributes.rollup_skipped_by_recent)
  const truncated = booleanOf(attributes.rollup_coverage_truncated)
  const survived = booleanOf(attributes.rollup_section_survived)
  const unconfirmed = numberOf(attributes.rollup_rejected_unconfirmed)
  const contradicted = numberOf(attributes.rollup_rejected_contradicted)
  const nonUser = numberOf(attributes.rollup_rejected_non_user)
  const invalidated = numberOf(attributes.rollup_rejected_invalidated)
  const outOfScope = numberOf(attributes.rollup_rejected_out_of_scope)

  // 失败关闭：任何一项读不出来 ⇒ 整条不作数（不猜、不补 0）
  if (
    selectorVersion === undefined ||
    scanned === undefined ||
    items === undefined ||
    omitted === undefined ||
    skipped === undefined ||
    truncated === undefined ||
    survived === undefined ||
    unconfirmed === undefined ||
    contradicted === undefined ||
    nonUser === undefined ||
    invalidated === undefined ||
    outOfScope === undefined
  ) {
    return undefined
  }

  const refsText = stringOf(attributes.rollup_source_refs) ?? ''
  const from = numberOf(attributes.rollup_covered_from)
  const to = numberOf(attributes.rollup_covered_to)

  return {
    status,
    selectorVersion,
    scannedEventCount: scanned,
    itemCount: items,
    sourceRefs: refsText === '' ? [] : refsText.split(',').filter((ref) => ref.trim() !== ''),
    // `-1` 是 turn-gateway 写"没有覆盖范围"的哨兵值 ⇒ 在这里翻成**缺席**
    ...(from !== undefined && to !== undefined && from >= 0 && to >= 0
      ? { coveredSequenceRange: { from, to } }
      : {}),
    omittedEligibleCount: omitted,
    skippedByRecentWindow: skipped,
    coverageTruncated: truncated,
    rejections: {
      unconfirmedOrigin: unconfirmed,
      contradictedOrigin: contradicted,
      nonUserSource: nonUser,
      invalidatedByMemoryState: invalidated,
      outOfScope,
    },
    sectionSurvived: survived,
  }
}

/**
 * 编译期"字段接地"证明。
 *
 * 每个 DTO 键要么在权威形状 `CharacterRunTrace` 里存在，要么在上面那个
 * 显式派生清单里。多出一个凭空造的键 → **typecheck 直接失败**。
 * （`[X] extends [never]` 而不是 `X extends never`：后者对 `never` 会分配成 `never`。）
 */
type DeveloperTraceSummaryDerivedKeys =
  | 'durationMs'
  | 'stepCount'
  | 'hasError'
  /*
   * WP6-5 的**最小 F4 兼容调整**：`attribution` 是**派生**的，它不属于
   * `CharacterRunTrace`（那是 `character_traces` 的权威形状，而那张表
   * **没有也不允许有**归因列 —— WP6-6 明令不得在 trace 上存第二份归因）。
   *
   * 它的**接地**是冻结的、可机检的：
   *     trace.input_event_id → conversation_events 的那一行 → 它落库的归因列
   * 因此它不是"凭空造的键"：`m5.1.1:wp6:verify` 会逐字段把它与
   * `conversation_events` 的物理列比对（并断言 trace 表里没有归因列）。
   */
  | 'attribution'
type UngroundedTraceSummaryKeys = Exclude<
  keyof TraceSummaryDto,
  keyof CharacterRunTrace | DeveloperTraceSummaryDerivedKeys
>
export const DEVELOPER_TRACE_SUMMARY_IS_GROUNDED: [UngroundedTraceSummaryKeys] extends [never]
  ? true
  : never = true

/**
 * 详情**独有**的派生键（WP7）：`counts`。
 *
 * 它不是 `CharacterRunTrace` 的列，也不是 summary 的字段 —— 它是**由本条记录的
 * 归因槽位算出来的聚合**（U-14 / K-30 裁定的那两个数字）。接地面与 `attribution`
 * 相同：`trace.input_event_id → conversation_events` 的那一行 → 它的归因列。
 */
type DeveloperTraceDetailDerivedKeys =
  | 'counts'
  /*
   * M6 / WP5（ADR-050）：`rollup` 是**派生**的 —— `character_traces` 上没有、
   * 也不允许有"摘要"这一列（同 `attribution` 的理由：trace 不是第二份存储）。
   *
   * 它的**接地**是冻结的、可机检的：
   *   trace.steps[] → kind = 'context_compile' 的那一步 → `rollup_*` 属性
   *     → `developerRollupSummaryOf()`（契约里的纯函数，**唯一**实现处）
   * 因此它不是"凭空造的键"：M6 的接线门断言那批属性只含引用与计数，
   * 而 `pnpm m6:measurement:verify` / WP5 的门逐字段把它与属性比对。
   */
  | 'rollup'
type UngroundedTraceDetailKeys = Exclude<
  keyof TraceDetailDto,
  keyof TraceSummaryDto | keyof CharacterRunTrace | DeveloperTraceDetailDerivedKeys
>
export const DEVELOPER_TRACE_DETAIL_IS_GROUNDED: [UngroundedTraceDetailKeys] extends [never]
  ? true
  : never = true

// ---------------------------------------------------------------------------
// Memory 诊断 DTO
// ---------------------------------------------------------------------------

export interface MemoryStatsQuery {
  characterId: CharacterId
}

/**
 * `MemoryStatsView`（`kernel/app/memory/admin.ts:387`）的只读投影。
 *
 * ⚠️ 字段**逐条对应**，刻意不重命名、不合并：AT2.4 明令不得重新实现一套 Memory 状态判断。
 *    这个 DTO 只做搬运。
 */
export interface MemoryStatsDto {
  total: number
  active: number
  superseded: number
  retracted: number
  disputed: number
  byProcessor: { processor: string; version: string; count: number }[]
  /** 没有合法证据根的（目标 0） */
  unsupported: number
  /** 被污染的用户事实（目标 0） */
  contaminated: number
  /**
   * **M5.1.1 / Phase 4b（ADR-043 `DR-9`）**：当前**来源资格**不是 `ESTABLISHED`
   * 的用户事实条数 —— 由**第二个**只读探针（`unqualifiedUserFacts()`）产出。
   *
   * ⚠️ 它**不是**"污染"（不要与上面的 `contaminated` 相加）：
   * ```text
   * contaminated  「这条用户事实的**记录权威**是不是不该是用户事实？」—— 目标 0
   * 本字段         「这条用户事实**今天的来源资格**是已确立吗？」—— 真库今天全部 2 条都在这
   * ```
   * 把两者合并会让"来源未确立"看起来像"被污染"，从而让人去修一条其实没坏的数据。
   */
  unqualifiedUserFacts: number
  /** 按三档汇总（Episode 面"不适用"的**不计数** —— 避免与"不知道"混在一起） */
  qualificationCounts: {
    established: number
    unconfirmedOrigin: number
    contradictedOrigin: number
  }
  /** 未登记 predicate 的条数 */
  unregisteredPredicate: number
  /** M5-PRE 的状态级探针结果（**只有**它能回答 integrityOk） */
  integrity: MemoryIntegrityDto
}

export interface MemoryIntegrityQuery {
  characterId: CharacterId
  /** 每类明细的行数上限（有界；只回 id 与状态，不回正文） */
  maxRows?: number
}

/** `MemoryIntegrityProblems`（`memory-integrity.ts:46`）的只读投影。只含 id / 状态 / 计数 */
export interface MemoryIntegrityDto {
  /** evidence link 指向的对话事件已不存在 */
  danglingEvidenceLinks: { memoryId: string; evidenceId: string }[]
  /** `memory_events` 行指向的领域事件已不存在 */
  danglingMemoryEvents: { memoryId: string; domainEventId: string }[]
  /** 没有任何**活**证据的记忆（= 孤儿） */
  memoriesWithoutLiveEvidence: { memoryId: string; status: string }[]
  /** 行还在、但事件流已空的记忆（`rebuildMemory()` 必然 `equal = false`） */
  memoriesWithoutLiveEvents: { memoryId: string; status: string }[]
  /** 四类合计是否为 0 —— **唯一**允许回答"记忆状态干净吗"的字段 */
  integrityOk: boolean
}

// ---------------------------------------------------------------------------
// Execution DTO（AT2.5：intent / target / request / attempt / result / verification / trace）
// ---------------------------------------------------------------------------

/**
 * 核验状态。
 *
 * ⚠️ **四态，不是 boolean。** 这是本契约里最容易被做错的一处：
 *    `verified: false` 在今天无法区分"核验了但失败"与"根本没核验"，
 *    而把后者读成前者会让"没验证过"看起来像"验证过是坏的"。
 *    账本里今天**没有**核验事件的独立证据（见 Authority Map F-4），
 *    所以默认是 `not_attempted` —— 如实，而不是讨好。
 */
export type DeveloperVerificationState = 'verified' | 'failed' | 'not_attempted' | 'not_applicable'

export const DEVELOPER_VERIFICATION_STATES: readonly DeveloperVerificationState[] = [
  'verified',
  'failed',
  'not_attempted',
  'not_applicable',
]

export function isDeveloperVerificationState(
  value: unknown
): value is DeveloperVerificationState {
  return (
    typeof value === 'string' &&
    (DEVELOPER_VERIFICATION_STATES as readonly string[]).includes(value)
  )
}

/**
 * 执行摘要 DTO。
 *
 * **派生字段清单**（不来自 `ExecutionRecordView`，由本契约声明）：
 *   · `attempted` —— 由账本的 `ACTION_STARTED` 派生（Authority Map F-4）
 *   · `durationMs` —— `finishedAt - startedAt`（未结束 → 缺省）
 *   · `targetType` / `targetCanonicalId` / `targetConfidence` —— **扁平化** `view.target`
 *   · `failureCode` —— **扁平化** `view.failure.code`（只回码，**不回 message**：
 *     失败消息里可能带路径等细节）
 *
 * 扁平化是刻意的：HTTP/JSON 消费方要的是"这一次执行的目标是什么"，
 * 而不是三轮嵌套。`scripts/kernel-tests-dev-plane.ts` 有一条接地断言逐字锁住这份清单。
 */
export interface DeveloperExecutionSummaryDto {
  actionId: ActionId
  traceId: TraceId
  capability: string
  operation: string
  /** 策略是否允许（`ActionResult.accepted`） */
  accepted: boolean
  /**
   * 适配器是否真的被调用过。
   *
   * 与 `accepted` **必须**是两个独立布尔：策略拒绝时两者都是 false，
   * 而"允许了但适配器抛错"是 `accepted=true, executed=true, status='failed'`。
   */
  executed: boolean
  /** 执行路径是否被真正进入过（账本里存在 `ACTION_STARTED`）。`executed ⇒ attempted` */
  attempted: boolean
  status: string
  /** 能力声明的副作用等级（来自 `ACTION_REQUESTED`；**不是**适配器自报的 effect） */
  sideEffect: string
  idempotentReplay: boolean
  targetType?: string
  targetCanonicalId?: string
  targetConfidence?: string
  requestedAt: Timestamp
  startedAt?: Timestamp
  finishedAt?: Timestamp
  /** **派生** */
  durationMs?: number
  /** 失败码（受控枚举；`kernel/action/errors.ts:31`）。不回传 message（可能含路径细节） */
  failureCode?: string
}

/** 请求参数摘要（**不**回传原始 arguments 全文 —— 它们可能含内容） */
export interface DeveloperExecutionRequestDto {
  capability: string
  operation: string
  /** WP5-3：`null` = 这条行**没有记录**请求方（**不是** `system`） */
  requestedByKind: string | null
  sideEffect: string
  idempotencyKey?: string
  /** `summarizeArguments()` 的结果（计数与键名，不含取值） */
  argumentKeys: string[]
  declaredTargetType?: string
  declaredTargetCanonicalId?: string
  createdAt: Timestamp
}

export interface DeveloperExecutionDecisionDto {
  allowed: boolean
  code: string
  message: string
  riskLevel?: string
  checks?: string[]
}

/** `intent` 在真实链路上今天恒为 `current_fact`（M5 局限 1）→ 用 availability 如实表达 */
export interface DeveloperExecutionIntentDto {
  kind?: string
  availability: DeveloperQueryAvailability
}

/** `attempt`：执行路径被进入的证据（今天来自 `ACTION_STARTED`） */
export interface DeveloperExecutionAttemptDto {
  attempted: boolean
  startedAt?: Timestamp
  evidenceRef?: string
}

export interface DeveloperExecutionResultDto {
  status: string
  executed: boolean
  effectKind?: string
  effectDetail?: string
  effectFingerprint?: string
  effectBytes?: number
  progress?: { completed: number; total: number; detail?: string }
  errorCode?: string
  startedAt?: Timestamp
  finishedAt?: Timestamp
}

export interface DeveloperExecutionVerificationDto {
  state: DeveloperVerificationState
  /** 凭什么这么说（"没有证据"就写没有证据，不许留空让人猜） */
  evidence?: string
}

export interface DeveloperEvidenceRefDto {
  kind: string
  detail: string
  ref?: string
}

export interface ExecutionListQuery extends DeveloperPageRequest {
  characterId: CharacterId
  status?: string
  capability?: string
}

export interface ExecutionGetQuery {
  characterId: CharacterId
  actionId: ActionId
}

/** AT2.5 要求的七个面（intent / target / request / attempt / result / verification / trace）逐条落地 */
export interface DeveloperExecutionDetailDto extends DeveloperExecutionSummaryDto {
  intent: DeveloperExecutionIntentDto
  request: DeveloperExecutionRequestDto
  decision?: DeveloperExecutionDecisionDto
  attempt: DeveloperExecutionAttemptDto
  result: DeveloperExecutionResultDto
  verification: DeveloperExecutionVerificationDto
  evidence: DeveloperEvidenceRefDto[]
  /**
   * WP6-4：这个 action 的**权威归因**（来自 `character_action_events` 的物理列）。
   *
   *   · 取**最后一条带归因信封的事件**当时记录的快照（阶段快照，
   *     **不**跨阶段合并 —— WP5-5）；`basisEventType` / `basisSequence` 说明来自哪一条。
   *     `MIGRATED_LEGACY` 行原样是 `MIGRATED_LEGACY`
   *   · 整条 action 都没有归因信封（历史行）⇒ 字段**缺席**
   *   · `Axis B` 恒为 `NOT_APPLICABLE`（K-22）
   *   · **执行真相与它无关**：`accepted` / `attempted` / `executed` / `verification`
   *     仍只由事件类型与既有派生规则决定（WP6-4 / WP5-9）—— 归因可见**不**升级执行状态
   *   · **不得**用 legacy `requestedBy` 当权威 `initiator`（那是兼容/输入证据）
   */
  attribution?: DeveloperAttributionDto
  /** WP7：**本条 action 的记录集**（单条）的 unknown 计数 */
  counts: DeveloperAttributionCountsDto
}

// ---------------------------------------------------------------------------
// WP6 —— 归因三态 DTO（读取期**唯一**表示；三态不可折叠）
// ---------------------------------------------------------------------------

/**
 * 一个 **principal 槽位**的只读表示（initiator / actor / executor / recordedBy /
 * contentOriginator）。
 *
 * 三态**必须**在表示层可区分（WP6-3 / R6）：
 *
 * ```text
 *   KNOWN   有具体位次            { state:'KNOWN', kind, id }
 *   UNKNOWN 概念适用但不知道      { state:'UNKNOWN', reason }     ← 绝不折叠成 null / '-' / ABSENT
 *   ABSENT  概念对此事件不适用    { state:'ABSENT' }
 * ```
 */
export type DeveloperPrincipalAttributionDto =
  | { readonly state: 'KNOWN'; readonly kind: string; readonly id: string }
  | { readonly state: 'UNKNOWN'; readonly reason: string }
  | { readonly state: 'ABSENT' }

/** `authority` 槽位：它指向**一条许可**（policy / capability / …），不是一个位次 */
export type DeveloperAuthorityAttributionDto =
  | { readonly state: 'KNOWN'; readonly kind: string; readonly ref: string }
  | { readonly state: 'UNKNOWN'; readonly reason: string }
  | { readonly state: 'ABSENT' }

/**
 * Axis B（认知轴）。
 *
 *   · 对话事件：**适用** —— 三列逐字来自存储（K-24 / R-21 的两个分支）
 *   · 行动事件：**不适用**（K-22）—— 行动表那三列恒为 NULL
 *
 * `branch`：RECORDED 行才有 R-21 的分支结论；`MIGRATED_LEGACY` 行给 `null`
 * （回填行**刻意不**满足那个等式，不得声称它是推导出来的）。
 */
export type DeveloperAxisBDto =
  | {
      readonly availability: 'APPLICABLE'
      readonly sourceKind: string
      readonly sourceAuthority: string
      readonly epistemicSource: string
      readonly branch: 'confirmed' | 'unconfirmed' | null
    }
  | { readonly availability: 'NOT_APPLICABLE' }

/**
 * 归因信封的只读投影（对话事件与行动事件**同一形状**，差别只在 `axisB`）。
 *
 * **接地**（WP6-5：不许落到 metadata / payload / transport / actor_type /
 * `requestedBy` 兼容字段）：
 *
 * ```text
 *   subject             ← canonical domain owner（conversation_events.character_id /
 *                          character_action_events.character_id）——**派生**，不是第二份存储（U-13）
 *   initiator/actor/executor/recordedBy/contentOriginator ← 同名物理列（三态逐字解码）
 *   authority           ← authority_kind / authority_ref / authority_unknown_reason
 *   attributionOrigin   ← attribution_origin
 *   axisB               ← source_kind / source_authority / epistemic_source
 *   basisEventType/     ← 这份快照来自**哪一条事件**（阶段快照，不跨阶段合并 —— WP5-5）
 *   basisSequence
 * ```
 */
export interface DeveloperAttributionDto {
  readonly attributionOrigin: 'RECORDED' | 'MIGRATED_LEGACY'
  /** 由 canonical domain owner 派生（U-13）：**不是**第二份存储 */
  readonly subject: { readonly kind: 'CHARACTER'; readonly id: string }
  readonly initiator: DeveloperPrincipalAttributionDto
  readonly actor: DeveloperPrincipalAttributionDto
  readonly executor: DeveloperPrincipalAttributionDto
  readonly authority: DeveloperAuthorityAttributionDto
  readonly recordedBy: DeveloperPrincipalAttributionDto
  readonly contentOriginator: DeveloperPrincipalAttributionDto
  readonly axisB: DeveloperAxisBDto
  /** 这份快照来自哪一条事件的类型（对话：事件类型；行动：`ACTION_*`） */
  readonly basisEventType: string
  readonly basisSequence: number
}

/**
 * WP6-5 的**编译期接地证明**：归因 DTO 的每个键都必须落在下面这个**冻结**集合里
 * —— 即"七个槽位 + origin + Axis B + 基事件"。多出一个凭空造的键 → typecheck 直接失败。
 */
type DeveloperAttributionDtoGroundingKeys =
  | 'attributionOrigin'
  | 'subject'
  | 'initiator'
  | 'actor'
  | 'executor'
  | 'authority'
  | 'recordedBy'
  | 'contentOriginator'
  | 'axisB'
  | 'basisEventType'
  | 'basisSequence'
type UngroundedAttributionDtoKeys = Exclude<
  keyof DeveloperAttributionDto,
  DeveloperAttributionDtoGroundingKeys
>
export const DEVELOPER_ATTRIBUTION_IS_GROUNDED: [UngroundedAttributionDtoKeys] extends [never]
  ? true
  : never = true

// ---------------------------------------------------------------------------
// WP7 —— unknown count（U-14 / K-30 裁定；**两个**规范字段）
// ---------------------------------------------------------------------------

/**
 * **当前结果集**的 unknown 计数（U-14 的"响应提供 unknown count"，K-30 裁定其单位）。
 *
 * ```text
 *   unknownSlotCount         逐槽位计数（U-1）
 *   recordsWithUnknownCount  含 ≥1 个 UNKNOWN 的记录数（U-2）
 * ```
 *
 * ⚠️ 单位不是我们选的：用户 2026-09-18 裁定**两个都给** —— 它们回答两个不同问题
 * （"哪些槽位不知道" vs "多少条记录受影响"），单给一个都会丢掉一类审计信息。
 * 裁定原文与边界逐条见 `docs/m5.1.1/M5.1.1-Unresolved-Decisions.md` 的 U-14 LANDING（第二段）。
 *
 * **`0` 也必须是显式值**：字段是必填的，"0 条未知"是一个**要被断言**的结论，
 * 而不是"没有这个字段"（否则"未知"又会消失在"没给"里 —— U-14 的原始动机）。
 */
export interface DeveloperAttributionCountsDto {
  readonly unknownSlotCount: number
  readonly recordsWithUnknownCount: number
}

/** 六个**槽位**（`unknownSlotCount` 逐个数过去的那六个；`subject` 是派生的、不是槽位） */
export const ATTRIBUTION_COUNTED_SLOTS = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
] as const

/**
 * 计数规则（**唯一实现处**；纯函数，无 I/O）。
 *
 * 裁定逐条落地（`K-30`）：
 *
 * ```text
 * 计入    ：AttributionValue.state === 'UNKNOWN'
 *           含 UNKNOWN(RUNTIME_UNRESOLVED) 与 UNKNOWN(LEGACY_UNRECORDED)
 *           —— `MIGRATED_LEGACY` 行上的 Unknown **计入**
 * 不计入  ：KNOWN · ABSENT · 整个 envelope 缺席（无信封的 legacy 记录）
 *           · Axis B 的 UNCONFIRMED_ORIGIN（它是 Axis B，不是槽位三态）
 *           · 行动侧 Axis B 的 NOT_APPLICABLE（同理）
 * 范围    ：传进来的这个**结果集**（列表页的一页 / 详情页的一条）
 * ```
 *
 * 注意"无信封"是用 `undefined` 表达**字段缺席**的 —— 那与"三态里的 ABSENT"
 * 是两件事（WP6 已冻结），因此这里对 `undefined` **不计入**，但也不报错。
 */
export function attributionCountsOf(
  records: readonly (DeveloperAttributionDto | undefined)[]
): DeveloperAttributionCountsDto {
  let unknownSlotCount = 0
  let recordsWithUnknownCount = 0
  for (const record of records) {
    if (record === undefined) continue
    let unknownInThisRecord = 0
    for (const slot of ATTRIBUTION_COUNTED_SLOTS) {
      const value = record[slot]
      if (value.state === 'UNKNOWN') unknownInThisRecord += 1
    }
    unknownSlotCount += unknownInThisRecord
    if (unknownInThisRecord > 0) recordsWithUnknownCount += 1
  }
  return { unknownSlotCount, recordsWithUnknownCount }
}

/**
 * 三态映射（**读取期唯一**入口）：`AttributionValue` → DTO。
 *
 * ⚠️ "这一行**没有**归因信封"由**调用方**用 `undefined` 表达（那与 `ABSENT`
 * ——概念不适用——是**两件事**）；因此这两个函数**只**接受一个真实的三态值，
 * 不会替调用方把"没有信封"伪造成 `ABSENT`。
 */
export function developerPrincipalAttributionDto(
  value: AttributionValue<unknown>
): DeveloperPrincipalAttributionDto {
  if (value.state === 'KNOWN') {
    const principal = value.value as { kind?: unknown; id?: unknown }
    return {
      state: 'KNOWN',
      kind: String(principal.kind),
      id: String(principal.id),
    }
  }
  if (value.state === 'UNKNOWN') return { state: 'UNKNOWN', reason: value.reason }
  return { state: 'ABSENT' }
}

/** `authority` 槽位的三态映射（`ref` 而不是 `id`：它指向许可，不是位次） */
export function developerAuthorityAttributionDto(
  value: AttributionValue<unknown>
): DeveloperAuthorityAttributionDto {
  if (value.state === 'KNOWN') {
    const authority = value.value as { kind?: unknown; ref?: unknown }
    return { state: 'KNOWN', kind: String(authority.kind), ref: String(authority.ref) }
  }
  if (value.state === 'UNKNOWN') return { state: 'UNKNOWN', reason: value.reason }
  return { state: 'ABSENT' }
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * **唯一**开发者查询面（AT2.1）。
 *
 * 它是 port，不是实现：契约在 domain 层，实现（读 SQL / 读探针）在 infrastructure 层
 * —— 与 `ConversationLedgerPort` / `TraceWriter` / `TelemetryPort` 同一条纪律。
 *
 * ⚠️ 这 8 个方法全部是**只读**的。任何"顺便写一下"的方法都不属于这里（G-03）。
 *    实现方必须复用既有 readers / probes，**不得在 handler 里写 arbitrary SQL**（AT2.1）。
 */
export interface DeveloperQueryService {
  getHealth(query?: HealthQuery): Promise<HealthDto>
  getCapabilities(query?: CapabilitiesQuery): Promise<CapabilitiesDto>
  listTraces(query: TraceListQuery): Promise<DeveloperTraceListDto>
  getTrace(query: TraceGetQuery): Promise<DeveloperLookup<TraceDetailDto>>
  getMemoryStats(query: MemoryStatsQuery): Promise<MemoryStatsDto>
  getMemoryIntegrity(query: MemoryIntegrityQuery): Promise<MemoryIntegrityDto>
  listExecutions(query: ExecutionListQuery): Promise<DeveloperPage<DeveloperExecutionSummaryDto>>
  getExecution(query: ExecutionGetQuery): Promise<DeveloperLookup<DeveloperExecutionDetailDto>>
}

// ---------------------------------------------------------------------------
// 入参解析（**唯一**接受外部形状的入口；失败关闭）
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError(
      'validation_error',
      'developer_query_not_object',
      `${what} 必须是对象`
    )
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, what: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError('validation_error', code, `${what} 必须是非空字符串`)
  }
  return value
}

/** 未知字段一律拒绝：静默忽略会让"我传了 status=success 但没生效"变成一个查不出来的 bug */
function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new KernelError(
      'validation_error',
      'developer_query_unknown_field',
      `${what} 收到未声明字段：${unknown.join(', ')}。允许的字段：${allowed.join(', ')}`
    )
  }
}

const PAGE_FIELDS = ['limit', 'cursor'] as const

function parsePage(raw: Record<string, unknown>): DeveloperPageRequest {
  const out: DeveloperPageRequest = {}
  if (raw.limit !== undefined) out.limit = assertDeveloperLimit(raw.limit)
  if (raw.cursor !== undefined) {
    assertDeveloperCursor(raw.cursor)
    out.cursor = raw.cursor
  }
  return out
}

function requireCharacterId(value: unknown, what: string): CharacterId {
  return asCharacterId(requireString(value, what, 'developer_query_missing_character_id'))
}

export function parseTraceListQuery(value: unknown): TraceListQuery {
  const raw = asRecord(value, 'TraceListQuery')
  rejectUnknownKeys(raw, [...PAGE_FIELDS, 'characterId', 'status'], 'TraceListQuery')
  const query: TraceListQuery = {
    characterId: requireCharacterId(raw.characterId, 'TraceListQuery.characterId'),
    ...parsePage(raw),
  }
  if (raw.status !== undefined) {
    if (raw.status !== 'running' && raw.status !== 'completed' && raw.status !== 'failed') {
      throw new KernelError(
        'validation_error',
        'developer_query_bad_trace_status',
        `TraceListQuery.status 必须是 running / completed / failed，收到 ${String(raw.status)}`
      )
    }
    query.status = raw.status
  }
  return query
}

export function parseTraceGetQuery(value: unknown): TraceGetQuery {
  const raw = asRecord(value, 'TraceGetQuery')
  rejectUnknownKeys(raw, ['characterId', 'traceId'], 'TraceGetQuery')
  return {
    characterId: requireCharacterId(raw.characterId, 'TraceGetQuery.characterId'),
    traceId: asTraceId(
      requireString(raw.traceId, 'TraceGetQuery.traceId', 'developer_query_missing_trace_id')
    ),
  }
}

export function parseMemoryStatsQuery(value: unknown): MemoryStatsQuery {
  const raw = asRecord(value ?? {}, 'MemoryStatsQuery')
  rejectUnknownKeys(raw, ['characterId'], 'MemoryStatsQuery')
  return {
    characterId: requireCharacterId(raw.characterId, 'MemoryStatsQuery.characterId'),
  }
}

export function parseMemoryIntegrityQuery(value: unknown): MemoryIntegrityQuery {
  const raw = asRecord(value ?? {}, 'MemoryIntegrityQuery')
  rejectUnknownKeys(raw, ['characterId', 'maxRows'], 'MemoryIntegrityQuery')
  const query: MemoryIntegrityQuery = {
    characterId: requireCharacterId(raw.characterId, 'MemoryIntegrityQuery.characterId'),
  }
  if (raw.maxRows !== undefined) {
    if (
      typeof raw.maxRows !== 'number' ||
      !Number.isSafeInteger(raw.maxRows) ||
      raw.maxRows < 1 ||
      raw.maxRows > DEVELOPER_QUERY_LIMITS.maxIntegrityRows
    ) {
      throw new KernelError(
        'validation_error',
        'developer_query_bad_max_rows',
        `MemoryIntegrityQuery.maxRows 必须在 [1, ${DEVELOPER_QUERY_LIMITS.maxIntegrityRows}] 内，收到 ${String(raw.maxRows)}`
      )
    }
    query.maxRows = raw.maxRows
  }
  return query
}

export function parseExecutionListQuery(value: unknown): ExecutionListQuery {
  const raw = asRecord(value, 'ExecutionListQuery')
  rejectUnknownKeys(raw, [...PAGE_FIELDS, 'characterId', 'status', 'capability'], 'ExecutionListQuery')
  const query: ExecutionListQuery = {
    characterId: requireCharacterId(raw.characterId, 'ExecutionListQuery.characterId'),
    ...parsePage(raw),
  }
  if (raw.status !== undefined) {
    query.status = requireString(
      raw.status,
      'ExecutionListQuery.status',
      'developer_query_bad_execution_status'
    )
  }
  if (raw.capability !== undefined) {
    query.capability = requireString(
      raw.capability,
      'ExecutionListQuery.capability',
      'developer_query_bad_capability'
    )
  }
  return query
}

export function parseExecutionGetQuery(value: unknown): ExecutionGetQuery {
  const raw = asRecord(value, 'ExecutionGetQuery')
  rejectUnknownKeys(raw, ['characterId', 'actionId'], 'ExecutionGetQuery')
  return {
    characterId: requireCharacterId(raw.characterId, 'ExecutionGetQuery.characterId'),
    actionId: asActionId(
      requireString(
        raw.actionId,
        'ExecutionGetQuery.actionId',
        'developer_query_missing_action_id'
      )
    ),
  }
}

// ---------------------------------------------------------------------------
// 派生字段的**唯一**算法（放在契约层：两处实现迟早漂移）
// ---------------------------------------------------------------------------

/** `durationMs` 只有一个算法。未结束 / 时间倒退 → 缺省（而不是一个负数或 0） */
export function developerDurationMs(startedAt: number, finishedAt?: number): number | undefined {
  if (finishedAt === undefined) return undefined
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return undefined
  if (finishedAt < startedAt) return undefined
  return finishedAt - startedAt
}

/** 从 trace 的 steps 派生摘要字段（**唯一**处；WP2 的适配器必须调它，不许自己算） */
export function summarizeTraceDerived(
  trace: Pick<CharacterRunTrace, 'startedAt' | 'finishedAt' | 'steps' | 'error'>
): { durationMs?: number; stepCount: number; hasError: boolean } {
  return {
    durationMs: developerDurationMs(trace.startedAt, trace.finishedAt),
    stepCount: Array.isArray(trace.steps) ? trace.steps.length : 0,
    hasError: (trace.error ?? '').trim() !== '',
  }
}

/**
 * 执行阶梯的**一致性断言**（AT1.1 的 execution-state distinction）。
 *
 * 它守的是四件事：
 *   ① `executed ⇒ attempted ⇒ accepted`（不能"执行了但没被允许"）
 *   ② `attempted` 必须有开始时间或证据引用（否则"attempted"只是嘴上说的）
 *   ③ `verification === 'verified'` ⇒ `executed === true`（**核验不是执行**）
 *   ④ `status === 'rejected'` ⇒ 三个布尔全 false（被拒了就不可能 attempted）
 */
export function assertDeveloperExecutionSummary(summary: DeveloperExecutionSummaryDto): void {
  if (summary.executed && !summary.attempted) {
    throw new KernelError(
      'validation_error',
      'developer_execution_executed_without_attempt',
      `action ${summary.actionId}：executed=true 但 attempted=false —— ` +
        '适配器不可能在"没进入执行路径"的情况下被调用'
    )
  }
  if (summary.attempted && !summary.accepted) {
    throw new KernelError(
      'validation_error',
      'developer_execution_attempted_without_accept',
      `action ${summary.actionId}：attempted=true 但 accepted=false —— 未被允许就进入执行路径`
    )
  }
  if (summary.attempted && summary.startedAt === undefined) {
    throw new KernelError(
      'validation_error',
      'developer_execution_attempt_without_start',
      `action ${summary.actionId}：attempted=true 却没有 startedAt —— ` +
        '"进入过执行路径"必须有时间证据（账本里的 ACTION_STARTED）'
    )
  }
  if (summary.status === 'rejected' && (summary.accepted || summary.attempted || summary.executed)) {
    throw new KernelError(
      'validation_error',
      'developer_execution_rejected_but_ran',
      `action ${summary.actionId}：status=rejected 却带着 accepted/attempted/executed=true`
    )
  }
}

export function assertDeveloperExecutionDetail(detail: DeveloperExecutionDetailDto): void {
  assertDeveloperExecutionSummary(detail)
  if (!isDeveloperVerificationState(detail.verification.state)) {
    throw new KernelError(
      'validation_error',
      'developer_execution_bad_verification',
      `verification.state 必须是四态之一，收到 ${String(detail.verification.state)}`
    )
  }
  if (detail.verification.state === 'verified' && !detail.executed) {
    throw new KernelError(
      'validation_error',
      'developer_execution_verified_without_execution',
      `action ${detail.actionId}：verification=verified 但 executed=false —— ` +
        '核验的是"某件事真的发生了"，没执行过就不可能有可核验的后置状态'
    )
  }
  if (detail.verification.state === 'verified' && (detail.verification.evidence ?? '').trim() === '') {
    throw new KernelError(
      'validation_error',
      'developer_execution_verified_without_evidence',
      `action ${detail.actionId}：verification=verified 却没有 evidence —— ` +
        '没有证据的"已核验"就是自报（ADR-033 的同一纪律）'
    )
  }
  /*
   * WP7（U-14 / K-30）：计数**必须**是那条唯一规则（`attributionCountsOf`）的结果。
   *
   * 这条把"计数从哪来"变成**契约不变量**（失败关闭），而不是一条约定：
   * 生产者（本查询面 / 将来任何调用方）自己算一个数、或把别的状态也算进去，
   * 都会在这里被拒 —— 数字对不上就是错的，不允许"看起来差不多"。
   */
  const expectedCounts = attributionCountsOf([detail.attribution])
  if (
    detail.counts.unknownSlotCount !== expectedCounts.unknownSlotCount ||
    detail.counts.recordsWithUnknownCount !== expectedCounts.recordsWithUnknownCount
  ) {
    throw new KernelError(
      'validation_error',
      'developer_attribution_counts_mismatch',
      `action ${detail.actionId}：counts 与 attributionCountsOf(attribution) 不一致 —— ` +
        `收到 {unknownSlotCount:${detail.counts.unknownSlotCount}, ` +
        `recordsWithUnknownCount:${detail.counts.recordsWithUnknownCount}}，` +
        `按裁定应为 {unknownSlotCount:${expectedCounts.unknownSlotCount}, ` +
        `recordsWithUnknownCount:${expectedCounts.recordsWithUnknownCount}}`
    )
  }
}

/** 一行式摘要（进日志 / 证据文件用；**不含参数与正文**） */
export function describeDeveloperExecution(summary: DeveloperExecutionSummaryDto): string {
  return (
    `${summary.capability}.${summary.operation} ${summary.status}` +
    `${summary.accepted ? '' : ' (未授权)'}` +
    `${summary.attempted ? '' : ' (未尝试)'}` +
    `${summary.executed ? '' : ' (未执行)'}` +
    `${summary.idempotentReplay ? ' [idempotent-replay]' : ''}` +
    `${summary.failureCode !== undefined ? ` [${summary.failureCode}]` : ''}`
  )
}
