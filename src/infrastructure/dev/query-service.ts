/**
 * Developer Query Service —— **只读查询面的实现**（M5.1 WP2 / AT2.1–AT2.5）。
 *
 * ============================================================================
 *  它只做一件事：把既有权威**投影**成 DTO
 * ============================================================================
 * 计划书 AT2.1 写得很直接：
 *
 *     通过现有 repositories / ledger readers / trace readers / integrity probes 聚合查询。
 *     不得在 HTTP handler 内编写 arbitrary SQL。
 *
 * 因此这个文件里的每一条数据都有**已有出处**，而且出处是**唯一**的：
 *
 *   getHealth           → currentSchemaVersion + memoryIntegrityProblems + 装配层注入的身份快照
 *   getCapabilities     → createDefaultCapabilityRegistry()（M4.5）+ 召回通道的如实可用性
 *   listTraces/getTrace → trace-store 的 listTracePage / getTrace
 *   getMemoryStats      → memoryCounts + countByProcessorVersion + unsupportedMemories
 *                         + contaminatedMemories + store.list（未登记 predicate）+ memoryIntegrityProblems
 *   getMemoryIntegrity  → memoryIntegrityProblems（**M5-PRE 的状态级探针**）
 *   listExecutions      → ExecutionLedgerPort.listRecords（status / capability 在 SQL 里过滤）
 *   getExecution        → getEventsByActionId + foldExecutionRecord（**唯一**的折叠实现）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 与 `src/main.ts` 的 `memory stats` 分支**逐条一致**
 * ---------------------------------------------------------------------------
 * `MemoryStatsDto` 的九个数就是 CLI `pnpm memory:stats` 打的那九个数，用的是
 * **同一批函数**。AT2.4 明令"不得重新实现一套 Memory 状态判断" ——
 * 这里不是"尽量少写"，而是**根本不允许**出现第二个 `where status = 'active'`。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 它**不**过滤、**不**判断资格、**不**解释状态
 * ---------------------------------------------------------------------------
 *   · 不做召回资格判断（那是 `exclusionReasonForStatus` 的唯一职责，M5 WP2）
 *   · 不判断"这条记忆该不该被想起"（那是 recall 的事）
 *   · 不解释执行状态（那是 `foldExecutionRecord` 的事）
 * 它只搬运。任何"顺手算一下"都会造出第二个真相。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 只读（G-03）
 * ---------------------------------------------------------------------------
 * 本文件里没有 `insert` / `update` / `delete` / `apply` / `append`。
 * AT2.7 的 Hard Test 会在**真实 HTTP 面**上把这一点量出来（前后快照必须逐字段相同），
 * 而不是靠"看代码觉得没有"。
 */

import { sql } from 'drizzle-orm'

import { rowsOf } from '../persistence/db.ts'
import {
  AVAILABLE,
  DEVELOPER_QUERY_CAPABILITY_FACTS,
  DEVELOPER_QUERY_CAPABILITY_IDS,
  DEVELOPER_QUERY_LIMITS,
  DEVELOPER_QUERY_SCHEMA_VERSION,
  decodeDeveloperCursor,
  developerAuthorityAttributionDto,
  developerDurationMs,
  developerPrincipalAttributionDto,
  developerRollupSummaryOf,
  attributionCountsOf,
  encodeDeveloperCursor,
  found,
  notFound,
  unavailable,
  type CapabilitiesDto,
  type DeveloperAttributionCountsDto,
  type DeveloperAttributionDto,
  type DeveloperAxisBDto,
  type DeveloperExecutionDecisionDto,
  type DeveloperExecutionDetailDto,
  type DeveloperExecutionIntentDto,
  type DeveloperExecutionSummaryDto,
  type DeveloperExecutionVerificationDto,
  type DeveloperHealthDetailDto,
  type DeveloperHealthStatus,
  type DeveloperLookup,
  type DeveloperPage,
  type DeveloperQueryService,
  type DeveloperRuntimeCapabilityDto,
  type DeveloperTraceListDto,
  type ExecutionGetQuery,
  type ExecutionListQuery,
  type HealthDto,
  type HealthQuery,
  type MemoryIntegrityDto,
  type MemoryIntegrityQuery,
  type MemoryStatsDto,
  type MemoryStatsQuery,
  type TraceDetailDto,
  type TraceGetQuery,
  type TraceListQuery,
  type TraceSummaryDto,
} from '../../kernel/contracts/developer-query.ts'
import {
  KernelError,
  isClaimContent,
  isRegisteredPredicate,
  type CharacterId,
  type CharacterRunTrace,
  type ConversationEventId,
  type EntityRef,
  type IdentitySnapshot,
} from '../../kernel/contracts/index.ts'
import { classifyRecordedAxisB } from '../../kernel/contracts/source-authority.ts'
// K-9 仍是 DEFER：**不**扩大 contracts/index.ts 的 barrel，直接从具体模块导入
import type { StoredAttributionReadback } from '../../kernel/contracts/attribution.ts'
import { ACTION_STATUSES } from '../../kernel/action/action-result.ts'
import { createDefaultCapabilityRegistry } from '../../kernel/action/capability-registry.ts'
import { foldExecutionRecord } from '../../kernel/action/execution-record.ts'
import type { ActionLedgerEvent, ExecutionRecordView } from '../../kernel/action/execution-ledger.ts'
import {
  contaminatedMemories,
  // M5.1.1 / Phase 4b：**第二个**只读探针（既有探针一字未改 —— DR-9）
  unqualifiedUserFacts,
  countByProcessorVersion,
  createNativeMemoryStore,
  memoryCounts,
  unsupportedMemories,
  type MemoryStorePort,
} from '../persistence/memory-store.ts'
import { memoryIntegrityProblems } from '../persistence/memory-integrity.ts'
import { currentSchemaVersion, type RawDb } from '../persistence/db.ts'
import { getTrace as readTrace, listTracePage } from '../persistence/trace-store.ts'
import {
  getConversationEvent as readConversationEvent,
  readConversationEventAttribution,
} from '../persistence/conversation-store.ts'
import {
  createActionLedgerStore,
  readActionStoredAttributions,
} from '../action/action-ledger-store.ts'

/**
 * 装配层注入的运行时事实。
 *
 * ⚠️ 刻意**不**让本文件自己去读 `character_definitions` 或环境变量：
 *    身份快照的唯一来源是 `KernelHandle.identitySnapshot`（M3 的 WP3 Gate），
 *    在这里再读一遍就是第二个来源。
 */
export interface DeveloperQueryServiceOptions {
  db: RawDb
  characterId: CharacterId
  /** Memory Space 的 owner（必须是角色；与 `MemoryRecord.owner` 同源） */
  owner: EntityRef
  runtimeId?: string
  /** `KernelHandle.identitySnapshot`（Seed 版本 / 指纹） */
  identitySnapshot?: IdentitySnapshot
  /** 运行时能力（如召回通道可用性）；缺省时由本文件给出**如实的**默认值 */
  runtimeCapabilities?: readonly DeveloperRuntimeCapabilityDto[]
  /** 时间源（测试注入确定性时钟用；缺省 `Date.now`） */
  now?: () => number
}

/**
 * 召回通道与模型档的**如实**可用性。
 *
 * ⚠️ **2026-09-30（M9.5 WP0）更正理由，不改结论**：`semantic` 仍恒 `not_available`，
 *   但**旧理由已过时**——原文写"`memory_records` 没有嵌入列 + G-05 禁止向量库
 *   ⇒ 语义通道**今天不存在**"，那是错的：
 *     · 通道**存在**：`MIGRATION_0010` 的派生四表已建在真实库上，`embedding` 列确为真 `vector`，
 *       探针也已接进生产装配（`src/main.ts`）
 *     · 缺的是**索引**：真实库读数 = `memory_semantic_generations` **0 行**（已发布代 0）·
 *       `memory_semantic_index` **0 行** ⇒ 探针逐轮返回 `not_indexed`（连编码模型都不加载）
 *   ⇒ 正确表述是"**通道在、索引没建**"，而**不是**"没有这个通道"；`not_available` 的**结论**
 *     因此仍然正确（拿不到分数，不是一个 0 分）。
 *   TODO（M9.5 启用计划 WP5 ③）：本条目前是**硬编码**；索引建好后要改成**如实动态**，
 *   否则启用之后它会变成**主动错误**。
 * 与 M5 的 `RecallScoreComponent.available` 是同一条纪律：**不是 0 分，是没有可用的分数**。
 * 谎报一个"语义相似度 0.0"会被当成证据，而"拿不到分数"不会。
 */
/**
 * M9.5 启用计划 **WP5 ③** —— 把 `semantic_retrieval` 的可用性从**硬编码**改成**如实动态**。
 *
 * ```text
 * 为什么必须改：`defaultRuntimeCapabilities()` 里那条理由是**写死**的。索引一旦真的建起来，
 * 它就会变成**主动错误**（开发者面会一直说"没建"，而它其实建了）——
 * 而 M5.1 的整套价值就是"开发者面不说谎"。
 * ⇒ 这个函数**读真实状态**（`memory_semantic_generations` 里有没有 `published` 的代），
 *   把结论与**读数**一起给出来（`not_indexed` 时带上"已发布代 = 0"这类硬数字）。
 * ```
 *
 * ⚠️ **只读**：一条 `select`，不写任何东西、不打开别的库（调用方决定在哪个库上问）。
 * ⚠️ **不注入**（`runtimeCapabilities` 的缺省值仍是那份**诚实但保守**的静态说明）：
 *    接线点在生产装配（`src/main.ts` 的 dev 面），**本轮未接**（如实登记，见 WP5 交接单）。
 */
export async function semanticRetrievalCapability(
  db: RawDb
): Promise<DeveloperRuntimeCapabilityDto> {
  const authority =
    'infrastructure/persistence/memory-retrieval-store.ts（语义探针）+ 派生四表（MIGRATION_0010）'
  const rows = rowsOf(
    await db.execute(sql`
      select build_state, count(*)::int as c from memory_semantic_generations
       group by build_state`)
  ).map((raw) => {
    const row = raw as Record<string, unknown>
    return { state: String(row.build_state), count: Number(row.c) }
  })
  const published = rows.find((row) => row.state === 'published')?.count ?? 0
  if (published > 0) {
    return {
      id: 'semantic_retrieval',
      authority,
      availability: { state: 'available', reason: `已发布代 = ${String(published)}` } as never,
    }
  }
  const states = rows.map((row) => `${row.state}=${String(row.count)}`).join(' · ') || '(无任何代)'
  return {
    id: 'semantic_retrieval',
    authority,
    availability: unavailable(
      `语义通道**在**（派生四表已建、\`embedding\` 为真 \`vector\` 列、探针已接生产装配），` +
        `但**已发布代 = 0**（各状态：${states}）⇒ 探针返回 \`not_indexed\`；` +
        '这是"拿不到分数"，不是一个 0 分'
    ),
  }
}

function defaultRuntimeCapabilities(): readonly DeveloperRuntimeCapabilityDto[] {
  const hasKey = (process.env.OPENAI_API_KEY ?? '').trim() !== ''
  return [
    {
      id: 'semantic_retrieval',
      authority:
        'infrastructure/persistence/memory-retrieval-store.ts（语义探针）+ 派生四表（MIGRATION_0010）',
      availability: unavailable(
        '语义通道**在**（派生四表已建、`embedding` 为真 `vector` 列、探针已接生产装配），' +
          '但真实库上**已发布代 = 0 / 索引 0 行**（从未建过索引）⇒ 探针返回 `not_indexed`；' +
          '这是"拿不到分数"，不是一个 0 分'
      ),
    },
    {
      id: 'lexical_recall',
      authority: 'kernel/recall/ranking.ts + contracts/memory-predicates.ts',
      availability: AVAILABLE,
    },
    {
      id: 'live_smoke',
      authority: 'scripts/verify-m5-smoke-live.ts',
      availability: hasKey
        ? AVAILABLE
        : unavailable(
            'OPENAI_API_KEY 未设置：真实模型档在本环境为 not-run（M5.1 Repository Map F-2）'
          ),
    },
  ]
}

export function createDeveloperQueryService(
  options: DeveloperQueryServiceOptions
): DeveloperQueryService {
  const { db, characterId, owner } = options
  const now = options.now ?? (() => Date.now())
  const store: MemoryStorePort = createNativeMemoryStore(db)
  const ledger = createActionLedgerStore(db)
  const runtimeCapabilities = options.runtimeCapabilities ?? defaultRuntimeCapabilities()

  function assertOwnCharacter(value: CharacterId | undefined, what: string): void {
    if (value === undefined) return
    if (String(value) !== String(characterId)) {
      throw new KernelError(
        'validation_error',
        'developer_query_character_mismatch',
        `${what}：这个查询面绑定在角色 ${String(characterId)} 上，收到 ${String(value)}`
      )
    }
  }

  // -------------------------------------------------------------------------
  // AT2.2：health / capabilities
  // -------------------------------------------------------------------------

  async function getHealth(query: HealthQuery = {}): Promise<HealthDto> {
    assertOwnCharacter(query.characterId, 'getHealth')

    const details: DeveloperHealthDetailDto[] = []

    let migrationVersion: number | undefined
    try {
      migrationVersion = await currentSchemaVersion(db)
      details.push({ name: 'schema', status: 'ok', detail: `migration v${migrationVersion}` })
    } catch (error) {
      details.push({
        name: 'schema',
        status: 'failed',
        detail: String((error as Error).message ?? error).slice(0, 200),
      })
    }

    /*
     * 完整性**只能**来自 M5-PRE 的状态级探针。
     * 用 `unsupportedMemories()` 的行数来代替会重演 D-7 那次事故：
     * 库已经不一致了，而审计报的是 "0 unsupported"。
     */
    const integrity = await memoryIntegrityProblems(db, owner)
    const integrityOk =
      integrity.danglingEvidenceLinks.length === 0 &&
      integrity.danglingMemoryEvents.length === 0 &&
      integrity.memoriesWithoutLiveEvidence.length === 0 &&
      integrity.memoriesWithoutLiveEvents.length === 0
    details.push({
      name: 'memory_integrity',
      status: integrityOk ? 'ok' : 'degraded',
      detail: integrityOk
        ? 'dangling=0 / orphan=0'
        : `dangling_evidence=${integrity.danglingEvidenceLinks.length} ` +
          `dangling_events=${integrity.danglingMemoryEvents.length} ` +
          `orphan=${integrity.memoriesWithoutLiveEvidence.length} ` +
          `no_live_events=${integrity.memoriesWithoutLiveEvents.length}`,
    })

    const snapshot = options.identitySnapshot
    details.push({
      name: 'identity',
      status: snapshot === undefined ? 'degraded' : 'ok',
      detail:
        snapshot === undefined
          ? 'identitySnapshot 未注入（装配层没有传）—— 身份快照的唯一来源是 KernelHandle'
          : `seed=v${snapshot.seedVersion}`,
    })

    const status: DeveloperHealthStatus = details.some((d) => d.status === 'failed')
      ? 'failed'
      : details.some((d) => d.status === 'degraded')
        ? 'degraded'
        : 'ok'

    return {
      status,
      generatedAt: now(),
      schemaVersion: DEVELOPER_QUERY_SCHEMA_VERSION,
      ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
      ...(snapshot !== undefined
        ? { seedVersion: snapshot.seedVersion, seedHash: snapshot.snapshotHash }
        : {}),
      ...(migrationVersion !== undefined ? { migrationVersion } : {}),
      integrityOk,
      details,
    }
  }

  async function getCapabilities(): Promise<CapabilitiesDto> {
    /*
     * 查询侧能力：**登记表就是权威**（`DEVELOPER_QUERY_CAPABILITY_FACTS`）。
     * 这里刻意不"动态探测" —— 探测出来的可用性会随环境漂移，
     * 而"这个端点由谁负责"是一个不变的事实。
     */
    const query = DEVELOPER_QUERY_CAPABILITY_IDS.map((id) => ({
      ...DEVELOPER_QUERY_CAPABILITY_FACTS[id],
    }))

    /*
     * 运行时能力：动作能力来自 M4.5 的登记表（**唯一**的能力权威），
     * 这里只做搬运；召回/模型相关的可用性由装配层注入。
     */
    const actionCapabilities: DeveloperRuntimeCapabilityDto[] = createDefaultCapabilityRegistry()
      .list()
      .map((definition) => ({
        id: definition.id,
        authority: 'kernel/action/capability-registry.ts',
        availability: AVAILABLE,
        note: `${definition.operations.length} operations / risk=${definition.riskLevel}`,
      }))

    return {
      schemaVersion: DEVELOPER_QUERY_SCHEMA_VERSION,
      query,
      runtime: [...actionCapabilities, ...runtimeCapabilities],
    }
  }

  // -------------------------------------------------------------------------
  // AT2.3：trace 查询（有界）
  // -------------------------------------------------------------------------

  /**
   * `CharacterRunTrace → TraceSummaryDto`。
   *
   * 派生字段只有三个（`durationMs` / `stepCount` / `hasError`），
   * 其余**逐字段**来自权威形状 —— 契约层的编译期接地证明就是靠这一点。
   */
  /**
   * WP6-3 / WP6-4 / WP6-5：存储归因 → DTO（**读取期唯一**映射）。
   *
   * 接地逐字段见 `DeveloperAttributionDto` 的注释；这里不做任何推导
   * （subject 是 U-13 的**派生**语义：canonical domain owner）。
   */
  function toAttributionDto(input: {
    readback: StoredAttributionReadback
    subjectId: string
    basisEventType: string
    basisSequence: number
    table: 'conversation' | 'action'
  }): DeveloperAttributionDto {
    const { readback } = input
    let axisB: DeveloperAxisBDto
    if (input.table === 'action') {
      // K-22：行动表的 Cognitive Axis B **不适用**（那三列恒为 NULL）
      axisB = { availability: 'NOT_APPLICABLE' }
    } else {
      const { sourceKind, sourceAuthority, epistemicSource } = readback.axisB
      if (sourceKind === null || sourceAuthority === null || epistemicSource === null) {
        /*
         * 对话表上"声明了 origin 就必须三列齐"是库级 CHECK（`axis_b_complete`）。
         * 真走到这里说明数据完整性坏了 ⇒ 失败关闭，**不**替它编一个分支。
         */
        throw new KernelError(
          'persistence_error',
          'developer_query_axis_b_missing',
          `conversation 事件的 Axis B 三列不齐（id/seq=${input.basisEventType}/${input.basisSequence}）——` +
            '读取期不推导、不补默认值'
        )
      }
      const branch =
        readback.attributionOrigin === 'RECORDED'
          ? (() => {
              const verdict = classifyRecordedAxisB({
                sourceKind: sourceKind as never,
                sourceAuthority: sourceAuthority as never,
                epistemicSource: epistemicSource as never,
              })
              return verdict.ok ? verdict.branch : null
            })()
          : null
      axisB = {
        availability: 'APPLICABLE',
        sourceKind,
        sourceAuthority,
        epistemicSource,
        branch,
      }
    }
    return {
      attributionOrigin: readback.attributionOrigin,
      subject: { kind: 'CHARACTER', id: input.subjectId },
      initiator: developerPrincipalAttributionDto(readback.slots.initiator),
      actor: developerPrincipalAttributionDto(readback.slots.actor),
      executor: developerPrincipalAttributionDto(readback.slots.executor),
      authority: developerAuthorityAttributionDto(readback.slots.authority),
      recordedBy: developerPrincipalAttributionDto(readback.slots.recordedBy),
      contentOriginator: developerPrincipalAttributionDto(readback.slots.contentOriginator),
      axisB,
      basisEventType: input.basisEventType,
      basisSequence: input.basisSequence,
    }
  }

  /**
   * WP6-6：trace 的归因**不是**第二份存储 ——
   * `input_event_id` → 那条 conversation event → **它落库时的归因列**。
   *
   * 读不到 / 没有信封 ⇒ `undefined`（"没有记录过"要如实表达）。
   */
  async function traceAttributionOf(
    inputEventId: ConversationEventId
  ): Promise<DeveloperAttributionDto | undefined> {
    const event = await readConversationEvent(db, inputEventId)
    if (event === undefined) return undefined
    const readback = await readConversationEventAttribution(db, inputEventId)
    if (readback === undefined) return undefined
    return toAttributionDto({
      readback,
      subjectId: String(event.characterId),
      basisEventType: String(event.type),
      basisSequence: event.sequence,
      table: 'conversation',
    })
  }

  function toTraceSummary(
    trace: CharacterRunTrace,
    attribution: DeveloperAttributionDto | undefined
  ): TraceSummaryDto {
    // `durationMs` 用契约层的**唯一**算法（未结束 / 时间倒退 → 缺省，而不是一个负数）
    const durationMs = developerDurationMs(trace.startedAt, trace.finishedAt)
    return {
      traceId: trace.traceId,
      characterId: trace.characterId,
      status: trace.status,
      startedAt: trace.startedAt,
      ...(trace.finishedAt !== undefined ? { finishedAt: trace.finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(trace.runtimeId !== undefined ? { runtimeId: trace.runtimeId } : {}),
      ...(trace.userId !== undefined ? { userId: trace.userId } : {}),
      ...(trace.conversationId !== undefined ? { conversationId: trace.conversationId } : {}),
      inputEventId: trace.inputEventId,
      ...(trace.outputEventId !== undefined ? { outputEventId: trace.outputEventId } : {}),
      ...(trace.modelProfile !== undefined ? { modelProfile: trace.modelProfile } : {}),
      ...(trace.seedVersion !== undefined ? { seedVersion: trace.seedVersion } : {}),
      ...(trace.seedHash !== undefined ? { seedHash: trace.seedHash } : {}),
      ...(trace.contextCompilerVersion !== undefined
        ? { contextCompilerVersion: trace.contextCompilerVersion }
        : {}),
      contextSectionIds: [...trace.contextSectionIds],
      droppedSectionIds: [...trace.droppedSectionIds],
      sourceConversationEventIds: [...trace.sourceConversationEventIds],
      selectedMemoryIds: [...trace.selectedMemoryIds],
      actionIds: [...trace.actionIds],
      stepCount: trace.steps.length,
      hasError: (trace.error ?? '').trim() !== '',
      ...(attribution !== undefined ? { attribution } : {}),
    }
  }

  async function listTraces(query: TraceListQuery): Promise<DeveloperTraceListDto> {
    assertOwnCharacter(query.characterId, 'listTraces')
    const limit = query.limit ?? DEVELOPER_QUERY_LIMITS.defaultLimit
    const page = await listTracePage(db, {
      characterId,
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit,
      // 游标解析**只有一处**（契约层）；这里不重新实现
      ...(query.cursor !== undefined ? { after: decodeDeveloperCursor(query.cursor) } : {}),
    })
    const items: TraceSummaryDto[] = []
    for (const row of page.rows) {
      items.push(toTraceSummary(row, await traceAttributionOf(row.inputEventId)))
    }
    const last = items[items.length - 1]
    return {
      items,
      limit,
      hasMore: page.hasMore,
      /*
       * WP7（U-14 / K-30）：**当前结果集**的 unknown 计数由查询面算，
       * 页面只渲染它 —— 语义只有一处（`attributionCountsOf`），
       * 且"这个数字"与"这一页 items"必然同源（同一批 DTO）。
       */
      counts: attributionCountsOf(items.map((item) => item.attribution)),
      ...(page.hasMore && last !== undefined
        ? {
            nextCursor: encodeDeveloperCursor({
              startedAt: last.startedAt,
              id: String(last.traceId),
            }),
          }
        : {}),
    }
  }

  async function getTraceDetail(query: TraceGetQuery): Promise<DeveloperLookup<TraceDetailDto>> {
    assertOwnCharacter(query.characterId, 'getTrace')
    const trace = await readTrace(db, query.traceId)
    if (trace === undefined) {
      return notFound('not_found', `trace ${String(query.traceId)} 不存在`)
    }
    if (String(trace.characterId) !== String(characterId)) {
      /*
       * 存在、但不属于这个角色。**刻意**与"不存在"用不同的理由码：
       * 两者在排查时的处置完全不同，而后者被答成前者会让
       * "跨角色读到了吗"这个问题永远查不出答案。
       */
      return notFound(
        'character_mismatch',
        `trace ${String(query.traceId)} 属于角色 ${String(trace.characterId)}`
      )
    }
    if (trace.steps.length > DEVELOPER_QUERY_LIMITS.maxStepsInDetail) {
      throw new KernelError(
        'validation_error',
        'developer_trace_too_many_steps',
        `trace ${String(query.traceId)} 有 ${trace.steps.length} 个 step，超过 ` +
          `${DEVELOPER_QUERY_LIMITS.maxStepsInDetail} 上限。` +
          '静默截断会让人以为这就是全部 —— 因此这里抛错'
      )
    }

    const traceAttribution = await traceAttributionOf(trace.inputEventId)
    /*
     * M6 / WP5：会话摘要事实 —— **从 `context_compile` 那一步的属性和出来**。
     *
     * 三条刻意的行为：
     *   1. 来源只有一处：那一步的属性（不新开查询、不读第二张表）
     *   2. `developerRollupSummaryOf()` 是契约里的**纯函数**：派生逻辑只有一份，
     *      页面/CLI/门读到的必然是同一个东西
     *   3. 没有 `rollup_status` ⇒ **不给这个字段**（缺席 ≠ 全 0）：那一轮没启用摘要
     *      与"启用了但没选中"是两件事，页面必须能分辨
     */
    const contextCompileStep = trace.steps.find((step) => step.kind === 'context_compile')
    const rollup =
      contextCompileStep === undefined
        ? undefined
        : developerRollupSummaryOf(contextCompileStep.attributes)
    return found({
      ...toTraceSummary(trace, traceAttribution),
      ...(trace.error !== undefined ? { error: trace.error } : {}),
      ...(rollup !== undefined ? { rollup } : {}),
      steps: trace.steps.map((step) => {
        const stepDuration = developerDurationMs(step.startedAt, step.finishedAt)
        return {
          kind: step.kind,
          label: step.label,
          status: step.status,
          startedAt: step.startedAt,
          ...(step.finishedAt !== undefined ? { finishedAt: step.finishedAt } : {}),
          ...(stepDuration !== undefined ? { durationMs: stepDuration } : {}),
          attributes: { ...step.attributes },
        }
      }),
      projectionRevisionsAtStart: { ...trace.projectionRevisionsAtStart },
      projectionRevisionsAtEnd: { ...trace.projectionRevisionsAtEnd },
      domainEventIds: trace.domainEventIds.map(String),
      identitySourceRefs: [...trace.identitySourceRefs],
      postTurnJobIds: trace.postTurnJobIds.map(String),
      processorVersions: { ...trace.processorVersions },
      // WP7：单条结果集的计数（与列表面**同一个**定义）
      counts: attributionCountsOf([traceAttribution]),
    })
  }

  // -------------------------------------------------------------------------
  // AT2.4：Memory 诊断（**同一批既有探针**，不重新实现）
  // -------------------------------------------------------------------------

  function toIntegrityDto(problems: {
    danglingEvidenceLinks: readonly { memoryId: string; evidenceId: string }[]
    danglingMemoryEvents: readonly { memoryId: string; domainEventId: string }[]
    memoriesWithoutLiveEvidence: readonly { memoryId: string; status: string }[]
    memoriesWithoutLiveEvents: readonly { memoryId: string; status: string }[]
  }): MemoryIntegrityDto {
    const cap = DEVELOPER_QUERY_LIMITS.maxIntegrityRows
    return {
      danglingEvidenceLinks: problems.danglingEvidenceLinks.slice(0, cap).map((row) => ({ ...row })),
      danglingMemoryEvents: problems.danglingMemoryEvents.slice(0, cap).map((row) => ({ ...row })),
      memoriesWithoutLiveEvidence: problems.memoriesWithoutLiveEvidence
        .slice(0, cap)
        .map((row) => ({ ...row })),
      memoriesWithoutLiveEvents: problems.memoriesWithoutLiveEvents
        .slice(0, cap)
        .map((row) => ({ ...row })),
      integrityOk:
        problems.danglingEvidenceLinks.length === 0 &&
        problems.danglingMemoryEvents.length === 0 &&
        problems.memoriesWithoutLiveEvidence.length === 0 &&
        problems.memoriesWithoutLiveEvents.length === 0,
    }
  }

  async function getMemoryStats(query: MemoryStatsQuery): Promise<MemoryStatsDto> {
    assertOwnCharacter(query.characterId, 'getMemoryStats')
    // ⚠️ 与 `src/main.ts` 的 `case 'stats'` 逐条一致（AT2.4）—— 同一批函数、同一批参数
    const counts = await memoryCounts(db, owner)
    const byProcessor = await countByProcessorVersion(db, owner)
    const unsupported = await unsupportedMemories(db, owner)
    const contaminated = await contaminatedMemories(db, owner)
    /*
     * M5.1.1 / Phase 4b（ADR-043 §4.1「developer-query DTO 暴露资格」）：
     * **第二个**只读探针。它与 `contaminated` 是**两个不同的问题**（见 `DR-9` 的说明），
     * 因此分字段如实给出，**不合并**成一个数字。
     */
    const qualification = await unqualifiedUserFacts(db, owner)
    const integrity = await memoryIntegrityProblems(db, owner)
    const all = await store.list({ owner, limit: 500 })
    const unregistered = all.filter(
      (record) => isClaimContent(record.content) && !isRegisteredPredicate(record.content.predicate)
    ).length

    return {
      ...counts,
      byProcessor,
      unsupported: unsupported.length,
      contaminated: contaminated.length,
      unqualifiedUserFacts: qualification.unqualified.length,
      qualificationCounts: qualification.counts,
      unregisteredPredicate: unregistered,
      integrity: toIntegrityDto(integrity),
    }
  }

  async function getMemoryIntegrity(query: MemoryIntegrityQuery): Promise<MemoryIntegrityDto> {
    assertOwnCharacter(query.characterId, 'getMemoryIntegrity')
    return toIntegrityDto(await memoryIntegrityProblems(db, owner))
  }

  // -------------------------------------------------------------------------
  // AT2.5：执行查询（intent / target / request / attempt / result / verification / trace）
  // -------------------------------------------------------------------------

  /**
   * `ExecutionRecordView → DeveloperExecutionSummaryDto`。
   *
   * `attempted` 的来源只有一个：账本里 `ACTION_STARTED` 的**存在性**。
   * 契约层的 `assertDeveloperExecutionSummary` 会拒绝 `executed ⇒ ¬attempted`
   * 与 `attempted ⇒ ¬accepted` 这类组合 —— 因此这里不是"顺手填个 true"。
   */
  function toExecutionSummary(record: ExecutionRecordView): DeveloperExecutionSummaryDto {
    /*
     * `ExecutionRecordView` 上没有 `attempted` 字段（Repository Map F-4），
     * 而 `startedAt` 与 `ACTION_STARTED` 是同一条证据：
     * `foldRecord` / `foldExecutionRecord` 只在见到 `ACTION_STARTED` 时才写 `startedAt`。
     * 因此用它的存在性表达"执行路径被进入过"。
     */
    const attempted = record.startedAt !== undefined || record.executed
    // 与 trace 侧同一个算法：时间倒退 → 缺省（负数会让"耗时"变成一个荒谬的数）
    const durationMs = developerDurationMs(record.requestedAt, record.finishedAt)
    return {
      actionId: record.actionId,
      traceId: record.traceId,
      capability: record.capability,
      operation: record.operation,
      accepted: record.accepted,
      executed: record.executed,
      attempted,
      status: record.status,
      sideEffect: record.sideEffect,
      idempotentReplay: record.idempotentReplay,
      ...(record.target !== undefined
        ? {
            targetType: record.target.type,
            targetConfidence: record.target.confidence,
            ...(record.target.canonicalId !== undefined
              ? { targetCanonicalId: record.target.canonicalId }
              : {}),
          }
        : {}),
      requestedAt: record.requestedAt,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(record.failure !== undefined ? { failureCode: record.failure.code } : {}),
    }
  }

  async function listExecutions(
    query: ExecutionListQuery
  ): Promise<DeveloperPage<DeveloperExecutionSummaryDto>> {
    assertOwnCharacter(query.characterId, 'listExecutions')
    const limit = query.limit ?? DEVELOPER_QUERY_LIMITS.defaultLimit
    if (query.status !== undefined && !(ACTION_STATUSES as readonly string[]).includes(query.status)) {
      throw new KernelError(
        'validation_error',
        'developer_query_bad_execution_status',
        `ExecutionListQuery.status 必须是受控终态之一（${ACTION_STATUSES.join(' / ')}），` +
          `收到 ${query.status}`
      )
    }
    const records = await ledger.listRecords({
      characterId,
      limit,
      ...(query.status !== undefined ? { status: query.status as never } : {}),
      ...(query.capability !== undefined ? { capability: query.capability } : {}),
    })
    /*
     * ⚠️ 执行账本的查询口今天**只有 limit、没有 cursor**（`ActionLedgerQuery`）。
     *    因此这里如实回 `hasMore: false`，而不是编一个游标 ——
     *    编出来的游标会在下一页悄悄跳过记录。
     *    （AT2.3 的"有界分页"要求落在 trace 上；执行侧的 keyset 分页记在本 WP 的
     *     Known Issues 里，属"要么有界、要么如实说没有"的那一类。）
     */
    /*
     * ⚠️ 执行列表面（`listExecutions`）**刻意不带归因**（WP6-4：逐行读事件流是 N+1），
     *    因此它**不报** unknown 计数 —— 见 `DeveloperTraceListDto` 的注释。
     *    "这个响应不携带归因"与"没有未知"是两件事，不得用一个 0 混掉。
     */
    return { items: records.map(toExecutionSummary), limit, hasMore: false }
  }

  async function getExecutionDetail(
    query: ExecutionGetQuery
  ): Promise<DeveloperLookup<DeveloperExecutionDetailDto>> {
    assertOwnCharacter(query.characterId, 'getExecution')
    const events: ActionLedgerEvent[] = await ledger.getEventsByActionId(characterId, query.actionId)
    if (events.length === 0) {
      return notFound('not_found', `action ${String(query.actionId)} 不存在`)
    }
    const folded = foldExecutionRecord(events)
    if (folded === undefined) {
      return notFound(
        'not_found',
        `action ${String(query.actionId)} 还没有终态，无法投影为执行记录`
      )
    }

    // 摘要走**同一份**投影（先在有终态的视图里找，找不到才用折叠结果兜底）
    const records = await ledger.listRecords({ characterId, limit: 500 })
    const view = records.find((record) => String(record.actionId) === String(query.actionId))
    const summary: DeveloperExecutionSummaryDto =
      view !== undefined
        ? toExecutionSummary(view)
        : toExecutionSummary({
            actionId: folded.actionId,
            traceId: folded.traceId,
            capability: folded.capability,
            operation: folded.operation,
            status: folded.result?.status ?? 'rejected',
            executed: folded.result?.executed ?? false,
            accepted: folded.result?.accepted ?? false,
            sideEffect: folded.request.sideEffect,
            idempotentReplay: folded.result?.idempotentReplay === true,
            ...(folded.request.target !== undefined ? { target: folded.request.target } : {}),
            ...(folded.result?.error !== undefined ? { failure: folded.result.error } : {}),
            evidence: folded.evidence,
            requestedAt: folded.timestamps.requested,
            ...(folded.timestamps.started !== undefined
              ? { startedAt: folded.timestamps.started }
              : {}),
            ...(folded.timestamps.finished !== undefined
              ? { finishedAt: folded.timestamps.finished }
              : {}),
          })

    /*
     * ⚠️ AT2.5 的三个投影里，**两个今天填不出来**，而它们被如实标出来：
     *   · `intent`       —— 运行时还没有意图分类器（M5 局限 1）→ `not_available`
     *   · `verification` —— 账本里没有"后置条件被核验"的独立事件（F-4）→ `not_attempted`
     * 编一个 `{ kind: 'current_fact' }` 看起来很像真的，但那是**猜**的。
     */
    const intent: DeveloperExecutionIntentDto = {
      availability: unavailable(
        '运行时没有意图分类器：intent 恒为 current_fact、target 恒为 none（M5 已知局限 1；' +
          'G-05 / STOP 条件 7 禁止在 M5.1 里顺手实现它）'
      ),
    }
    const verification: DeveloperExecutionVerificationDto = {
      state: 'not_attempted',
      evidence:
        '账本里没有"后置条件被核验"的独立事件（Repository Map F-4）；' +
        '这里是 not_attempted 而不是 failed —— 没核验过与核验失败是两件事',
    }

    /*
     * WP6-4：这个 action 的**权威归因**来自 `character_action_events` 的物理列。
     *
     * 取**最后一条带归因信封的事件**当时记录的快照（阶段快照，不跨阶段合并 —— WP5-5）。
     * 整条 action 都没有信封 ⇒ 字段缺席（"没有记录过"要如实表达）。
     *
     * ⚠️ 执行真相与它无关：`accepted` / `attempted` / `executed` / `verification`
     *    仍来自上面那套既有派生规则，归因可见**不**升级执行状态（WP6-4 / WP5-9）。
     */
    const storedAttributions = await readActionStoredAttributions(db, characterId, query.actionId)
    const basis = storedAttributions[storedAttributions.length - 1]
    const attribution: DeveloperAttributionDto | undefined =
      basis === undefined
        ? undefined
        : toAttributionDto({
            readback: basis.attribution,
            subjectId: String(characterId),
            basisEventType: basis.eventType,
            basisSequence: basis.sequence,
            table: 'action',
          })

    const decision: DeveloperExecutionDecisionDto | undefined =
      folded.decision !== undefined
        ? {
            allowed: folded.decision.allowed,
            code: folded.decision.code,
            message: folded.decision.message,
            ...(folded.decision.riskLevel !== undefined
              ? { riskLevel: folded.decision.riskLevel }
              : {}),
            ...(folded.decision.checks !== undefined ? { checks: [...folded.decision.checks] } : {}),
          }
        : undefined

    return found({
      ...summary,
      intent,
      // WP7：单条结果集的计数（与列表面**同一个**定义；无信封 ⇒ 两个 0）
      counts: attributionCountsOf([attribution]),
      request: {
        capability: folded.request.capability,
        operation: folded.request.operation,
        /*
         * WP5-3：请求方是**兼容/输入证据**，可以缺席（历史行没记）。
         * `null` 的含义是"这条行没有记录请求方" —— 不是 `system`。
         */
        requestedByKind: folded.request.requestedBy?.kind ?? null,
        sideEffect: folded.request.sideEffect,
        ...(folded.request.idempotencyKey !== undefined
          ? { idempotencyKey: folded.request.idempotencyKey }
          : {}),
        /*
         * ⚠️ 参数只回**键名**，不回取值。
         *    `ActionRequest.arguments` 可能含用户提供的文本（例如要写的文件内容），
         *    而这条路径是**外发**的（HTTP → 浏览器）。只回键名让
         *    "她带了哪些参数"仍然可回答，而正文一步都不出库。
         */
        argumentKeys: Object.keys(folded.request.arguments).sort(),
        ...(folded.request.target !== undefined
          ? { declaredTargetType: folded.request.target.type }
          : {}),
        ...(folded.request.target?.canonicalId !== undefined
          ? { declaredTargetCanonicalId: folded.request.target.canonicalId }
          : {}),
        createdAt: folded.request.createdAt,
      },
      ...(decision !== undefined ? { decision } : {}),
      attempt: {
        attempted: summary.attempted,
        ...(folded.timestamps.started !== undefined
          ? { startedAt: folded.timestamps.started }
          : {}),
        evidenceRef: summary.attempted
          ? 'character_action_events:ACTION_STARTED'
          : 'character_action_events:（没有 ACTION_STARTED）',
      },
      result: {
        status: folded.result?.status ?? 'rejected',
        executed: folded.result?.executed ?? false,
        ...(folded.result?.effect !== undefined ? { effectKind: folded.result.effect.kind } : {}),
        ...(folded.result?.effect?.detail !== undefined
          ? { effectDetail: folded.result.effect.detail }
          : {}),
        ...(folded.result?.effect?.fingerprint !== undefined
          ? { effectFingerprint: folded.result.effect.fingerprint }
          : {}),
        ...(folded.result?.effect?.bytes !== undefined
          ? { effectBytes: folded.result.effect.bytes }
          : {}),
        ...(folded.result?.progress !== undefined
          ? {
              progress: {
                completed: folded.result.progress.completed,
                total: folded.result.progress.total,
                ...(folded.result.progress.detail !== undefined
                  ? { detail: folded.result.progress.detail }
                  : {}),
              },
            }
          : {}),
        ...(folded.result?.error !== undefined ? { errorCode: folded.result.error.code } : {}),
        ...(folded.result?.startedAt !== undefined ? { startedAt: folded.result.startedAt } : {}),
        ...(folded.result?.finishedAt !== undefined
          ? { finishedAt: folded.result.finishedAt }
          : {}),
      },
      verification,
      evidence: folded.evidence.map((item) => ({
        kind: item.kind,
        detail: item.detail,
        ...(item.ref !== undefined ? { ref: item.ref } : {}),
      })),
      ...(attribution !== undefined ? { attribution } : {}),
    })
  }

  return {
    getHealth,
    getCapabilities,
    listTraces,
    getTrace: getTraceDetail,
    getMemoryStats,
    getMemoryIntegrity,
    listExecutions,
    getExecution: getExecutionDetail,
  }
}
