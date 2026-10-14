/**
 * ConversationEvent 仓储 —— 事实账本的持久化。
 *
 * 三条必须由持久层保证、不能被上层"注意一下"的事情：
 *
 *   1. **append-only**：本文件**没有** update / delete 导出。
 *      不是"我们约定不改"，而是根本没有那个函数。
 *   2. **序号来自可信持久层**：`sequence` 只能在 `appendConversationEvent`
 *      内部由原子分配器给出，调用方拿不到决定权（`NewConversationEvent`
 *      里根本没有这个字段）。
 *   3. **幂等**：同一 (character, conversation, conversationSequence)
 *      重复写入不会被当成新事件——这是 SC-003 / SC-004 的基础。
 */

import { sql } from 'drizzle-orm'

import {
  CONVERSATION_EVENT_M3_SCHEMA_VERSION,
  CONVERSATION_EVENT_SCHEMA_VERSION,
  KernelError,
  classifyRecordedAxisB,
  createConversationEvent,
  deriveSourceForLegacyRow,
  type ActorType,
  type CharacterId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationEventType,
  type ConversationId,
  type DeliveryStatus,
  type EpistemicSource,
  type SourceAuthority,
  type SourceKind,
  asCharacterId,
  asConversationEventId,
  asConversationId,
} from '../../kernel/contracts/index.ts'
// K-9 仍是 DEFER：**不**扩大 contracts/index.ts 的 barrel，直接从具体模块导入
// （第一个真实消费者不必顺带改 barrel 的可见面）。
import {
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_VALUE_SLOTS,
  decodeAttributionSlots,
  storedAttributionOfRow,
  type AttributionSlotCells,
  type AttributionValueSlot,
  type StoredAttributionReadback,
  type TrustedAttributionContext,
} from '../../kernel/contracts/attribution.ts'
import type { AttributionValue } from '../../kernel/contracts/actor.ts'
import { asRows, exec, firstRow, type RawDb } from './db.ts'
import { conversationReadPredicate, currentReadScope, scopedReadDb } from './read-scope.ts'

interface EventRow {
  id: string
  character_id: string
  conversation_id: string
  sequence: number
  conversation_sequence: number
  type: string
  actor_type: string
  actor_id: string | null
  content: string
  reply_to_event_id: string | null
  metadata: unknown
  schema_version: number
  created_at: number
  // --- M3（迁移 0003）：结构化 provenance。旧行这些列是 null ---------------
  source_kind?: string | null
  source_authority?: string | null
  epistemic_source?: string | null
  delivery_status?: string | null
  event_schema_version?: number | null
  // --- M3.5（迁移 0004）：时间模型。旧行与"当前对话"这两列通常是 null -------
  occurred_at?: number | null
  logical_time?: string | null
  // --- WP4 / 迁移 0007：归因信封（18 个槽位列 + origin）。旧行这些列是 null ---
  attribution_origin?: string | null
  initiator_kind?: string | null
  initiator_id?: string | null
  initiator_unknown_reason?: string | null
  actor_kind?: string | null
  actor_ref_id?: string | null
  actor_unknown_reason?: string | null
  executor_kind?: string | null
  executor_id?: string | null
  executor_unknown_reason?: string | null
  authority_kind?: string | null
  authority_ref?: string | null
  authority_unknown_reason?: string | null
  recorded_by_kind?: string | null
  recorded_by_id?: string | null
  recorded_by_unknown_reason?: string | null
  content_originator_kind?: string | null
  content_originator_id?: string | null
  content_originator_unknown_reason?: string | null
}

/**
 * 行 → **RECORDED 归因信封**（六个槽位三态；**只读那 18 个槽位列**）。
 *
 * 这是 WP4 step 3/3-fix 补上的读路径：写路径从 step 2/3 起就把信封落库了，
 * 但 `rowToEvent` 一直没把它读回来 —— 于是"写入时的值"与"立即回读的值"
 * 在 `event.attribution` 上永远不相等（AT-W4-8 的读半边不成立）。
 *
 * ⚠️ 它**不**推断任何槽位：没有 `actor_type` 兜底、没有默认位次、没有
 * `source_kind` 旁证。三态解码交给契约层的 `decodeAttributionSlots()`，
 * 落不进三态之一的行在那里 fail closed。
 */
function recordedAttributionOf(row: EventRow): {
  attributionOrigin: 'RECORDED'
  slots: Record<AttributionValueSlot, AttributionValue<unknown>>
} {
  const raw = row as unknown as Record<string, unknown>
  const cells = {} as Record<AttributionValueSlot, AttributionSlotCells>
  for (const slot of ATTRIBUTION_VALUE_SLOTS) {
    const columns = ATTRIBUTION_SLOT_COLUMNS[slot]
    cells[slot] = {
      kind: (raw[columns.kind] ?? null) as string | null,
      id: (raw[columns.id] ?? null) as string | null,
      unknownReason: (raw[columns.unknownReason] ?? null) as string | null,
    }
  }
  return { attributionOrigin: 'RECORDED', slots: decodeAttributionSlots(cells) }
}

/**
 * 行 → 事件。
 *
 * ⚠️ provenance 的处理是**推导优先于留空**：
 * 迁移 0003 之前的行（本项目真实库里有 4 条）没有那三列。
 * 对它们我们按 `actorType` 推导来源（规则与 `createConversationEvent`
 * 完全一致），而不是返回 `undefined`。
 *
 * 理由：账本里**不允许存在来源未知的事件**。一条来源为 null 的事实，
 * 对 M4 的 Memory 来说比一条"来源正确推导"的事实危险得多 ——
 * 前者会被当成"可能是什么都行"，后者至少与写入路径同源。
 *
 * ============================================================================
 *  WP4 step 3/3-fix：**RECORDED 行独占权威路径**（两条路严格分开）
 * ============================================================================
 *
 *     attribution_origin = 'RECORDED'
 *         → 六个槽位由 `recordedAttributionOf()` 按物理列逐字重建；
 *           Axis B 用**存储值**并复核 R-21 的合法分支（拒绝而不改写）
 *
 *     legacy（`MIGRATED_LEGACY` / 无 origin）
 *         → 与今天**逐字相同**的兼容路径（`row.X ?? deriveSourceForLegacyRow(actorType).X`）
 *
 * 两条纪律：
 *   · legacy 兼容路径**永远不能**覆盖一个已有的 RECORDED 信封 ——
 *     因为 RECORDED 行根本不走那条路（不是"先走了再判断"）。
 *   · 历史行不会因为"没有 RECORDED 归因"而读失败。
 */
function rowToEvent(row: EventRow | undefined): ConversationEvent | undefined {
  if (!row) return undefined
  const actorType = String(row.actor_type) as ActorType
  const recorded = (row.attribution_origin ?? null) === 'RECORDED'

  let sourceKind: SourceKind
  let sourceAuthority: SourceAuthority
  let epistemicSource: EpistemicSource

  if (recorded) {
    /*
     * 权威路径：**只读存储值**。`axis_b_complete`（v7 的 CHECK）保证
     * 声明了 origin 的行三列齐全；缺失是数据完整性问题 ⇒ 读失败关闭，
     * 而不是"顺手推导一个看起来合理的值"（那正是 D01 的手感）。
     */
    if (
      row.source_kind === null ||
      row.source_kind === undefined ||
      row.source_authority === null ||
      row.source_authority === undefined ||
      row.epistemic_source === null ||
      row.epistemic_source === undefined
    ) {
      throw new KernelError(
        'persistence_error',
        'recorded_axisb_missing',
        `RECORDED 行的 Axis B 三列不齐（source_kind=${String(row.source_kind)} ` +
          `source_authority=${String(row.source_authority)} ` +
          `epistemic_source=${String(row.epistemic_source)}）—— ` +
          '读取期不推导、不补默认值'
      )
    }
    sourceKind = String(row.source_kind) as SourceKind
    sourceAuthority = String(row.source_authority) as SourceAuthority
    epistemicSource = String(row.epistemic_source) as EpistemicSource

    // R-21：RECORDED 的 Axis B 只能是两个合法分支之一（混合形态读失败关闭）
    const verdict = classifyRecordedAxisB({ sourceKind, sourceAuthority, epistemicSource })
    if (!verdict.ok) {
      throw new KernelError(
        'persistence_error',
        'recorded_axisb_invalid',
        `RECORDED 行的 Axis B 不是 R-21 的两个合法分支之一（${verdict.code}）：` +
          `${verdict.detail}。读取期**不重写**存储值 —— 这一行需要人来看。`
      )
    }
  } else {
    // legacy / MIGRATED_LEGACY 兼容路径：与今天逐字相同
    const derived = deriveSourceForLegacyRow(actorType)
    sourceKind = (row.source_kind ?? derived.sourceKind) as SourceKind
    sourceAuthority = (row.source_authority ?? derived.sourceAuthority) as SourceAuthority
    epistemicSource = (row.epistemic_source ?? derived.epistemicSource) as EpistemicSource
  }

  return {
    id: asConversationEventId(String(row.id)),
    characterId: asCharacterId(String(row.character_id)),
    conversationId: asConversationId(String(row.conversation_id)),
    sequence: Number(row.sequence),
    conversationSequence: Number(row.conversation_sequence),
    type: String(row.type) as ConversationEventType,
    actorType,
    actorId: row.actor_id ?? undefined,
    content: String(row.content),
    sourceKind,
    sourceAuthority,
    epistemicSource,
    // 只有 RECORDED 行才有权威归因信封；历史行保持"没有信封"这个事实
    ...(recorded ? { attribution: recordedAttributionOf(row) } : {}),
    deliveryStatus: (row.delivery_status ?? undefined) as DeliveryStatus | undefined,
    replyToEventId: row.reply_to_event_id
      ? asConversationEventId(String(row.reply_to_event_id))
      : undefined,
    metadata:
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : undefined,
    schemaVersion: Number(row.schema_version),
    createdAt: Number(row.created_at),
    // M3.5：NULL → undefined（"不知道它什么时候发生"是一个真实的状态，
    // 不能悄悄变成"就是现在"；见 time.ts 的 eventTimeFromRecorded）
    ...(row.occurred_at !== null && row.occurred_at !== undefined
      ? { occurredAt: Number(row.occurred_at) }
      : {}),
    ...(row.logical_time !== null && row.logical_time !== undefined
      ? { logicalTime: String(row.logical_time) }
      : {}),
  }
}

export interface AppendEventInput {
  characterId: CharacterId
  conversationId: ConversationId
  conversationSequence: number
  type: ConversationEventType
  actorType: ActorType
  actorId?: string
  content: string
  replyToEventId?: ConversationEventId
  metadata?: Record<string, unknown>
  createdAt?: number
  /**
   * 由调用方**预先分配**的角色级序号（可选）。
   *
   * 用途：一次交互要同时写"用户消息"和"助手回复"，先分配区间
   * （[n, n+1]）能让两者严格相邻，从而在数据上就看得出来它们属于同一轮。
   * 仍然来自可信持久层（`sequence.ts` 的原子分配器）——
   * 这里只是把"分配"与"写入"两步分开，而不是把决定权交给上层。
   */
  characterSequence?: number
  /**
   * WP4（step 2/3）：**受信归因上下文**（只能由 `buildTrustedAttributionContext()` 产出）。
   * 不传 ⇒ 本函数的 SQL 与今天逐字段相同（legacy 路径零影响）。
   */
  trustedAttribution?: TrustedAttributionContext
  // --- M3：结构化 provenance（可选，缺省由 actorType 推导）----------------
  /** 调用方可显式声明来源类别；与 actorType 不一致时**抛错**（失败关闭） */
  sourceKind?: SourceKind
  /** 生成 / 已送达 / 失败（计划书第 37 节） */
  deliveryStatus?: DeliveryStatus
  /** 被回复事件的来源类别（用于把用户确认提升为 USER_REPLY_CONFIRMATION） */
  repliedToSourceKind?: SourceKind
  // --- M3.5：时间模型（计划书第 29–34 节，均可选）------------------------
  /**
   * 这件事**什么时候发生**。
   *
   * 缺省 = 不写（NULL）—— 当前对话里"发生时间"通常就等于记录时间，
   * 但那是**调用方**要说的事，持久层不替它猜。需要"二者相等"的语义时
   * 由调用方显式传同一个值。
   */
  occurredAt?: number
  /** 模拟时间槽位；当前必须留空（`assertEventTime` 会拒绝非空值） */
  logicalTime?: string
}

export interface AppendResult {
  event: ConversationEvent
  /** true = 这次真的写进去了；false = 已存在相同事件，本次是空操作（幂等命中） */
  appended: boolean
  /**
   * true = 本次写入在会话内序号上留下了一个**空洞**（"上一条"不是 incoming - 1）。
   *
   * 正常情况下它应当是 false —— 只有历史回填（显式传 `allowSequenceGap: true`）
   * 会写出空洞。把它作为**返回值**而不是只当输入开关，是为了让调用方能
   * 在报告里写出"我制造了几处空洞"，而不是事后去库里捞。
   */
  sequenceGap?: boolean
}

/**
 * 追加一个对话事件。
 *
 * ============================================================================
 *  ⚠️ 这是**低层原语**，业务代码不应当直接调它
 * ============================================================================
 * 真实对话的写入必须经：
 *
 *      ConversationRecorder  →  ConversationLedgerPort  →  （本函数）
 *
 * 因为本函数只保证"行级正确"（append-only / 幂等 / 竞态兜底），
 * **不保证**会话内序号的连续性。
 *
 * M3 自查时实测到的一件事：直接调本函数可以让会话内序号跳号
 * （1 → 50 写入成功）。当时 `ConversationRecorder` 就是直调它的，
 * 于是"序号必须是连续的可读账"这条规则**在运行期没有生效** ——
 * 而测试全绿，因为测试测的是那个从未被调用的完整性服务。
 *
 * 现在连续性由 `ConversationRecorder.assertSequenceContiguous` 守着。
 * 本函数通过下面这个显式开关，把"允许空隙"变成调用方**必须写明**的决定：
 * 只有历史回填（它按区间写已有的旧事件）需要它。
 *
 * 顺序很讲究：
 *   1. 先按"会话内序号"做幂等探测（同一个 `conversationSequence` 已经写过就返回旧的）
 *   2. 再原子分配角色级序号
 *   3. 插入，并处理"并发下另一个进程刚插了同一个 conversationSequence"的竞态
 *
 * 第 3 步的兜底是必要的：幂等探测与插入之间存在窗口，而 Windows 上跑单进程
 * 不代表以后不会并发（QQ 网关 / 定时任务 / 多个 CLI 窗口都会）。
 */
export async function appendConversationEvent(
  db: RawDb,
  input: AppendEventInput,
  options: {
    /**
     * 显式允许会话内序号出现空隙。
     *
     * 只有**历史回填**该传 true：它按时间区间补写早年的对话，
     * 而那些事件的会话内序号本来就与今天的账本不连续。
     *
     * 默认 false 的含义：调用方**必须承认**自己在做一件会留下空洞的事。
     * 这不是安全边界（原语本来就只保证行级正确），
     * 而是让"空隙"在代码里可见 —— 一次 grep `allowSequenceGap: true`
     * 就能列出所有会制造空洞的地方。
     */
    allowSequenceGap?: boolean
  } = {}
): Promise<AppendResult> {
  void options
  const existing = await findByConversationSequence(
    db,
    input.characterId,
    input.conversationId,
    input.conversationSequence
  )
  if (existing) return { event: existing, appended: false }

  /*
   * 会话内序号的连续性：**只有历史回填**可以留空洞。
   *
   * 这里做的是"让空隙可见"而不是安全边界 —— 原语本来就只保证行级正确。
   * 但把默认设成"必须显式承认"，一次 `grep allowSequenceGap` 就能列出
   * 全部会制造空洞的路径；而默认静默允许时，一个直调本函数的模块
   * 可以让序号永久跳号，事后无从分辨是有意还是 bug（M3 自查实测到过）。
   */
  const maxBefore = await latestConversationSequence(
    db,
    input.characterId,
    input.conversationId
  )
  const createsGap = maxBefore > 0 && input.conversationSequence > maxBefore + 1
  if (createsGap && options.allowSequenceGap !== true) {
    throw new KernelError(
      'validation_error',
      'conversation_sequence_gap',
      `会话内序号出现空洞：当前最大 ${maxBefore}，收到 ${input.conversationSequence}。` +
        '真实对话的会话内序号必须是连续的可读账；' +
        '只有历史回填可以显式传 { allowSequenceGap: true }。'
    )
  }

  const sequence =
    input.characterSequence ?? (await nextCharacterSequence(db, input.characterId))
  const event = createConversationEvent({
    ...input,
    sequence,
    createdAt: input.createdAt ?? Date.now(),
  })

  /*
   * WP4 step 2/3：携带**受信归因**时，把 18 个槽位列 + `attribution_origin` 一并落库。
   * **不携带时这两段是空片段** ⇒ SQL 与今天逐字段相同（legacy 路径零影响）。
   *
   * 三态 → 列的映射（Proposed-Schema §0 / K-4）：
   *   KNOWN   → kind = <受控值>，id = <位次>，reason = NULL
   *   UNKNOWN → kind/id = NULL，reason = <理由>
   *   ABSENT  → 三列全 NULL
   */
  const attributionCell = (
    value: AttributionValue<unknown>
  ): { kind: string | null; id: string | null; reason: string | null } => {
    if (value.state === 'KNOWN') {
      const principal = value.value as { kind?: string; id?: string; ref?: string }
      return { kind: principal.kind ?? null, id: principal.id ?? principal.ref ?? null, reason: null }
    }
    if (value.state === 'UNKNOWN') return { kind: null, id: null, reason: value.reason }
    return { kind: null, id: null, reason: null }
  }
  const attributionSlotEntries = Object.entries(ATTRIBUTION_SLOT_COLUMNS) as [
    AttributionValueSlot,
    { kind: string; id: string; unknownReason: string },
  ][]
  const attributionColumns = event.attribution
    ? sql`, attribution_origin, ${sql.raw(
        attributionSlotEntries
          .flatMap(([, columns]) => [columns.kind, columns.id, columns.unknownReason])
          .join(', ')
      )}`
    : sql``
  const attributionValues = event.attribution
    ? sql`, ${event.attribution.attributionOrigin}, ${sql.join(
        attributionSlotEntries.flatMap(([slot, columns]) => {
          const cell = attributionCell(event.attribution!.slots[slot])
          void columns
          return [sql`${cell.kind}`, sql`${cell.id}`, sql`${cell.reason}`]
        }),
        sql`, `
      )}`
    : sql``

  const inserted = await exec(
    db,
    sql`insert into conversation_events
          (id, character_id, conversation_id, sequence, conversation_sequence,
           type, actor_type, actor_id, content, reply_to_event_id, metadata,
           schema_version, created_at,
           source_kind, source_authority, epistemic_source, delivery_status, event_schema_version,
           occurred_at, logical_time${attributionColumns})
        values (${event.id}, ${event.characterId}, ${event.conversationId}, ${event.sequence},
                ${event.conversationSequence}, ${event.type}, ${event.actorType},
                ${event.actorId ?? null}, ${event.content},
                ${event.replyToEventId ?? null},
                ${JSON.stringify(event.metadata ?? null)}::jsonb,
                ${event.schemaVersion}, ${event.createdAt},
                ${event.sourceKind}, ${event.sourceAuthority}, ${event.epistemicSource},
                ${event.deliveryStatus ?? null}, ${CONVERSATION_EVENT_M3_SCHEMA_VERSION},
                ${event.occurredAt ?? null}, ${event.logicalTime ?? null}${attributionValues})
        on conflict (character_id, sequence) do nothing
        returning *`,
    '写入 ConversationEvent'
  )

  if (inserted.length > 0) {
    return {
      event: rowToEvent(firstRow<EventRow>(inserted))!,
      appended: true,
      // 如实上报"这次写入留下了空洞" —— 只有显式 allowSequenceGap 的路径
      // 会走到这里，而调用方应当在报告里写出它制造了几处。
      ...(createsGap ? { sequenceGap: true } : {}),
    }
  }

  // 竞态兜底：别人先写了。回读那条已经存在的事件，本次仍视为幂等命中。
  const raced = await findByConversationSequence(
    db,
    input.characterId,
    input.conversationId,
    input.conversationSequence
  )
  if (raced) return { event: raced, appended: false }

  throw new KernelError(
    'persistence_error',
    'event_append_conflict',
    `ConversationEvent 写入冲突且无法回读：character=${input.characterId} ` +
      `conversation=${input.conversationId} conversationSequence=${input.conversationSequence}`
  )
}

/**
 * 取角色级下一个序号。
 *
 * 与 `sequence.ts` 的分配器同源，但这里额外做一件事：当计数器还是 0 时，
 * 用已存在的最大序号兜底 —— 兼容"迁移前已有事件、计数器未初始化"的情形。
 */
async function nextCharacterSequence(db: RawDb, characterId: CharacterId): Promise<number> {
  const rows = await exec(
    db,
    sql`insert into character_sequence_counters (character_id, next_sequence)
        values (
          ${characterId},
          coalesce((select max(sequence) from conversation_events where character_id = ${characterId}), 0) + 1
        )
        on conflict (character_id)
          do update set next_sequence = character_sequence_counters.next_sequence + 1
        returning next_sequence`,
    '分配角色级序号'
  )
  const next = Number(rows[0]?.next_sequence)
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new KernelError(
      'persistence_error',
      'sequence_allocation_failed',
      `序号分配返回非法值：${String(rows[0]?.next_sequence)}`
    )
  }
  return next
}

export async function findByConversationSequence(
  db: RawDb,
  characterId: CharacterId,
  conversationId: ConversationId,
  conversationSequence: number
): Promise<ConversationEvent | undefined> {
  const rows = await exec(
    db,
    sql`select * from conversation_events
        where character_id = ${characterId}
          and conversation_id = ${conversationId}
          and conversation_sequence = ${conversationSequence}
        limit 1`,
    '按会话内序号读取事件'
  )
  return rowToEvent(firstRow<EventRow>(rows))
}

export async function getConversationEvent(
  db: RawDb,
  id: ConversationEventId
): Promise<ConversationEvent | undefined> {
  const rows = await exec(
    scopedReadDb(db),
    sql`select * from conversation_events where id = ${id} and (${conversationReadPredicate()}) limit 1`,
    '读取事件'
  )
  return rowToEvent(firstRow<EventRow>(rows))
}

/**
 * **按 id 集合批量取完整事件**（M9 线 N+1 收口；登记册 §0p `R-48`）。
 *
 * ⚠️ 逐行走的还是**同一个私有** `rowToEvent()` —— 这不是顺手，是**边界纪律**：
 *    `trustedOrigin` 的解码全仓只允许有这一处（`m5.1.1:k17` 以字面量计数守着），
 *    批量版绝不另起第二个 row mapper（`goal-input-store.ts:16-19` 登记过那次漂移教训）。
 *
 * 返回顺序 = **入参顺序**；不存在的 id 给 `undefined`（与 `getConversationEvent()` 同）。
 */
export async function getConversationEventsByIds(
  db: RawDb,
  ids: readonly ConversationEventId[]
): Promise<(ConversationEvent | undefined)[]> {
  if (ids.length === 0) return []
  const unique = [...new Set(ids.map((id) => String(id)))]
  const idList = sql.join(
    unique.map((id) => sql`${id}`),
    sql`, `
  )
  const rows = await exec(
    scopedReadDb(db),
    sql`select * from conversation_events where id in (${idList}) and (${conversationReadPredicate()})`,
    '批量读取事件'
  )
  const byId = new Map<string, ConversationEvent>()
  for (const row of rows) {
    const event = rowToEvent(row as unknown as EventRow)
    if (event !== undefined) byId.set(String(event.id), event)
  }
  return ids.map((id) => byId.get(String(id)))
}

/**
 * WP6-1 / WP6-2：**查询/审计读侧**的存储归因（RECORDED 与 MIGRATED_LEGACY 都解码）。
 *
 * ⚠️ 与 `rowToEvent` 的分工是**刻意**的：后者是**事件对象**的语义（WP4：只有
 * RECORDED 才有 `event.attribution`，历史行走兼容路径）；本函数是**读侧表示**的
 * 语义 —— 历史行也要如实展示成 `MIGRATED_LEGACY`（三态逐字），既不许被静默升格成
 * RECORDED，也不许把 `Unknown` 折叠成 `Absent`。
 *
 * 没有 `attribution_origin` 的行 ⇒ `undefined`（"这条行没有记录过归因"）。
 */
export async function readConversationEventAttribution(
  db: RawDb,
  id: ConversationEventId
): Promise<StoredAttributionReadback | undefined> {
  const rows = await exec(
    scopedReadDb(db),
    sql`select * from conversation_events where id = ${id} and (${conversationReadPredicate()}) limit 1`,
    '读取事件的存储归因'
  )
  const row = firstRow<EventRow>(rows)
  if (row === undefined) return undefined
  return storedAttributionOfRow(row as unknown as Record<string, unknown>)
}

/**
 * 批量读取（Validator 的存在性/归属检查走这里）。
 *
 * 返回的是**精简视图**：Validator 不需要正文，少给一点它就少一份责任。
 */
export async function findEventRefs(
  db: RawDb,
  ids: readonly ConversationEventId[]
): Promise<{ id: ConversationEventId; characterId: CharacterId; sequence: number }[]> {
  if (ids.length === 0) return []
  const rows = await exec(
    db,
    sql`select id, character_id, sequence from conversation_events
        where id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})`,
    '批量读取事件引用'
  )
  return rows.map((r) => ({
    id: asConversationEventId(String(r.id)),
    characterId: asCharacterId(String(r.character_id)),
    sequence: Number(r.sequence),
  }))
}

export interface RecentEventsQuery {
  characterId: CharacterId
  /** 只看某个会话（不传 = 该角色的全部会话，按角色级序号合并） */
  conversationId?: ConversationId
  limit: number
  /** 只看序号 <= before 的事件（用于 Replay / 历史窗口） */
  beforeSequence?: number
}

/** 取最近事件，**返回按序号升序**（调用方不需要再排） */
export async function recentConversationEvents(
  db: RawDb,
  query: RecentEventsQuery
): Promise<ConversationEvent[]> {
  const limit = Math.max(1, Math.min(1000, Math.floor(query.limit)))
  const rows = await exec(
    scopedReadDb(db),
    query.conversationId && currentReadScope()?.context.room.kind !== 'group'
      ? sql`select * from conversation_events
            where character_id = ${query.characterId}
              and conversation_id = ${query.conversationId}
              and (${conversationReadPredicate()})
              ${query.beforeSequence === undefined ? sql`` : sql`and sequence <= ${query.beforeSequence}`}
            order by sequence desc
            limit ${limit}`
      : sql`select * from conversation_events
            where character_id = ${query.characterId}
              and (${conversationReadPredicate()})
              ${query.beforeSequence === undefined ? sql`` : sql`and sequence <= ${query.beforeSequence}`}
            order by sequence desc
            limit ${limit}`,
    '读取最近事件'
  )
  return asRows<EventRow>(rows)
    .map((r) => rowToEvent(r)!)
    .reverse()
}

/** 取序号区间内的事件（Processor / Job 的输入） */
export async function conversationEventsInRange(
  db: RawDb,
  characterId: CharacterId,
  fromSequence: number,
  toSequence: number,
  limit = 200
): Promise<ConversationEvent[]> {
  const rows = await exec(
    db,
    sql`select * from conversation_events
        where character_id = ${characterId}
          and sequence >= ${fromSequence}
          and sequence <= ${toSequence}
        order by sequence asc
        limit ${Math.max(1, Math.min(2000, limit))}`,
    '读取事件区间'
  )
  return asRows<EventRow>(rows).map((r) => rowToEvent(r)!)
}

/** 各会话的当前最大会话内序号（用于推导下一条该用几号） */
export async function latestConversationSequence(
  db: RawDb,
  characterId: CharacterId,
  conversationId: ConversationId
): Promise<number> {
  const rows = await exec(
    db,
    sql`select coalesce(max(conversation_sequence), 0) as v from conversation_events
        where character_id = ${characterId} and conversation_id = ${conversationId}`,
    '读取会话最大序号'
  )
  return Number(rows[0]?.v ?? 0)
}

/**
 * 角色级最大事件序号（M7 关系评估的水位基准）。
 *
 * ⚠️ 读的是 `conversation_events.sequence` 的实际最大值，**不是**
 * `character_sequence_counters.next_sequence`：计数器会被非账本路径消耗
 * （M6.1 冻结单 §11 的"空洞"），计数器领先 ≠ 有事件可处理。
 * 水位语义是"账本里 ≤ N 的事件都已处理"，所以基准必须是账本自己的最大值。
 */
export async function latestCharacterEventSequence(
  db: RawDb,
  characterId: CharacterId
): Promise<number> {
  const rows = await exec(
    db,
    sql`select coalesce(max(sequence), 0) as v from conversation_events
        where character_id = ${characterId}`,
    '读取角色最大事件序号'
  )
  return Number(rows[0]?.v ?? 0)
}

/** 统计（诊断 / 快照用） */
export async function countConversationEvents(
  db: RawDb,
  characterId: CharacterId
): Promise<number> {
  const rows = await exec(
    db,
    sql`select count(*)::int as c from conversation_events where character_id = ${characterId}`,
    '统计事件数'
  )
  return Number(rows[0]?.c ?? 0)
}

/**
 * 标记投递状态（计划书第 37 节）。
 *
 * ⚠️ 这是**唯一**允许 UPDATE `conversation_events` 的地方，而且它只改
 * `delivery_status` 一列。内容的 append-only 语义不受影响：
 * 正文、来源、序号、时间都不在这个函数的 SQL 里出现。
 *
 * 为什么不能"另写一条事件表示送达失败"：那会把"她说了什么"
 * 与"它有没有送到"混进同一个序列，于是"第 7 条是谁说的"这个问题的
 * 答案会依赖网络状况。
 *
 * 返回 false 表示事件不存在（调用方决定是忽略还是报警）。
 */
export async function markDeliveryStatus(
  db: RawDb,
  eventId: ConversationEventId,
  status: DeliveryStatus
): Promise<boolean> {
  const updated = await exec(
    db,
    sql`update conversation_events set delivery_status = ${status}
        where id = ${eventId} returning id`,
    '标记投递状态'
  )
  return updated.length > 0
}

/** 统计（诊断用）：某个角色的各来源类别各有多少条 */
export async function countBySourceKind(
  db: RawDb,
  characterId: CharacterId
): Promise<Record<string, number>> {
  const rows = await exec(
    db,
    sql`select coalesce(source_kind, '(legacy)') as kind, count(*)::int as c
        from conversation_events where character_id = ${characterId}
        group by 1 order by 1`,
    '按来源统计事件'
  )
  const out: Record<string, number> = {}
  for (const row of rows) out[String(row.kind)] = Number(row.c)
  return out
}

export {
  CONVERSATION_EVENT_SCHEMA_VERSION,
  CONVERSATION_EVENT_M3_SCHEMA_VERSION,
  type ConversationEvent,
  type ConversationEventId,
}
