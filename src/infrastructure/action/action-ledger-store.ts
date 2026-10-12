/**
 * ActionLedgerStore —— `ExecutionLedgerPort` 的 SQL 实现（M4.5 §18 / ADR-034）。
 *
 * ============================================================================
 *  一条纪律：**按状态过滤必须发生在 SQL 里**
 * ============================================================================
 * M4.1 的 `activeValues()` 出过一次真实的量具事故：
 * 函数名叫 active，实际用 `--memory-list`（**全部状态**），
 * 于是"她已经忘掉的那条"仍被算成当前有效事实，测试假红。
 *
 * 所以这里的选择是：`listRecords({ status })` 的过滤写进 `where` 子句，
 * **不是**读回来再 `filter`。CLI、`action:audit`、L0 门全部走这一个实现 ——
 * 量具不可能与系统分叉（ADR-035）。
 *
 * ⚠️ append-only：本文件里没有 update / delete 语句，端口上也没有这两个方法。
 */

import { sql } from 'drizzle-orm'

import type { ActionId, CharacterId, TraceId, Timestamp } from '../../kernel/contracts/ids.ts'
import { asActionId, asCharacterId, asTraceId } from '../../kernel/contracts/ids.ts'
import { KernelError } from '../../kernel/contracts/index.ts'
import type { ActionStatus } from '../../kernel/action/action-result.ts'
import type { ActionTarget } from '../../kernel/action/action-request.ts'
import type { ActionFailure } from '../../kernel/action/errors.ts'
import type { PolicyDecision } from '../../kernel/action/policy.ts'
import type {
  ActionEventType,
  ActionLedgerEvent,
  ActionLedgerQuery,
  AppendActionRequestedInput,
  AppendAuthorizedInput,
  AppendCancelledInput,
  AppendFailedInput,
  AppendPartialInput,
  AppendRejectedInput,
  AppendStartedInput,
  AppendSucceededInput,
  AppendTargetResolvedInput,
  ExecutionLedgerPort,
  ExecutionRecordView,
} from '../../kernel/action/execution-ledger.ts'
import { fnv1a64Hex } from '../../kernel/action/idempotency.ts'
import {
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_VALUE_SLOTS,
  actionAttributionEnvelopeOf,
  actionAttributionFamilyOf,
  assertActionAttributionMatchesEvent,
  assertActionAxisBNotApplicable,
  assertAttributionNecessity,
  decodeAttributionSlots,
  storedAttributionOfRow,
  type AttributionSlotCells,
  type AttributionValueSlot,
  type TrustedActionAttributionContext,
} from '../../kernel/contracts/attribution.ts'
import type { AttributionValue } from '../../kernel/contracts/actor.ts'
import { exec, rowsOf, type RawDb } from '../persistence/db.ts'

interface ActionEventRow {
  action_id: string
  sequence: number
  character_id: string
  trace_id: string | null
  event_type: string
  status: string | null
  capability: string
  operation: string
  idempotency_key: string | null
  payload: unknown
  created_at: string | number
  // --- WP5 / 迁移 0007：归因槽位（18 列）+ Axis B 三列 + origin。旧行全是 null ---
  attribution_origin?: string | null
  source_kind?: string | null
  source_authority?: string | null
  epistemic_source?: string | null
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

/** 三态 → 三个物理格（WP5 与 conversation-store 同一套编码，**没有**默认值） */
function attributionCell(value: AttributionValue<unknown>): {
  kind: string | null
  id: string | null
  reason: string | null
} {
  if (value.state === 'KNOWN') {
    const principal = value.value as { kind?: string; id?: string; ref?: string }
    return {
      kind: principal.kind ?? null,
      id: principal.id ?? principal.ref ?? null,
      reason: null,
    }
  }
  if (value.state === 'UNKNOWN') return { kind: null, id: null, reason: value.reason }
  return { kind: null, id: null, reason: null }
}

const ATTRIBUTION_SLOT_ENTRIES = Object.entries(ATTRIBUTION_SLOT_COLUMNS) as [
  AttributionValueSlot,
  { kind: string; id: string; unknownReason: string },
][]

/**
 * 行 → **RECORDED 行动归因**（WP5 §WP5-8）。
 *
 * 只读那 18 个槽位列 + origin；三态逐字解码（`decodeAttributionSlots`，落不进
 * Known / Unknown / Absent 之一就 fail closed）。**不**从 `character_id` / payload 的
 * `requestedBy` / `status` / 事件类型 / trace id / transport 推断任何槽位。
 *
 * 唯一一处"派生"是 `subject`（U-13：canonical domain owner 的派生语义，不落列），
 * 以及 `family`（由**事件类型**查冻结表得到 —— 那是分类桥，不是归因推断）。
 */
function decodeActionAttribution(row: ActionEventRow): {
  attributionOrigin: 'RECORDED'
  eventType: string
  family: ReturnType<typeof actionAttributionFamilyOf>
  subject: { kind: 'CHARACTER'; id: string }
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
  const eventType = String(row.event_type)
  return {
    attributionOrigin: 'RECORDED',
    eventType,
    family: actionAttributionFamilyOf(eventType),
    subject: { kind: 'CHARACTER', id: String(row.character_id) },
    slots: decodeAttributionSlots(cells),
  }
}

/**
 * WP6-1 / WP6-2 / WP6-4：**查询/审计读侧**的存储归因（一条 action 的**全部**带归因事件）。
 *
 * ⚠️ 与 `toEvent`/`decodeActionAttribution` 的分工是**刻意**的：后者是**事件对象**的
 * 语义（WP5：`RECORDED` 才有 `event.attribution`）；本函数是**读侧表示**的语义 ——
 * 历史行（`MIGRATED_LEGACY`）也要如实展示，**不**允许被升格成 RECORDED，
 * 也**不**允许把 `Unknown` 折叠成 `Absent`。
 *
 * 返回**按 sequence 升序**的、**只有带信封的行**；调用方据此选择要展示哪一条
 * （阶段快照，不跨阶段合并 —— WP5-5）。
 */
export async function readActionStoredAttributions(
  db: RawDb,
  characterId: CharacterId,
  actionId: ActionId
): Promise<
  {
    sequence: number
    eventType: string
    attribution: NonNullable<ReturnType<typeof storedAttributionOfRow>>
  }[]
> {
  const rows = rowsOf(
    await db.execute(
      sql`select * from character_action_events
          where character_id = ${String(characterId)} and action_id = ${String(actionId)}
          order by sequence asc`
    )
  ) as unknown as Record<string, unknown>[]
  const out: {
    sequence: number
    eventType: string
    attribution: NonNullable<ReturnType<typeof storedAttributionOfRow>>
  }[] = []
  for (const row of rows) {
    const attribution = storedAttributionOfRow(row)
    if (attribution === undefined) continue
    out.push({
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      attribution,
    })
  }
  return out
}

export function createActionLedgerStore(db: RawDb): ExecutionLedgerPort {
  /**
   * 这次写入该记哪个幂等键。
   *
   * Gateway 推导出来的键优先（请求方没给键时），否则用请求里的那个。
   * 两者都没有 → 不写这一列（`NULL`）。
   */
  function keyOf(input: {
    request: { idempotencyKey?: string }
    effectiveIdempotencyKey?: string
  }): { idempotencyKey?: string } {
    const key = input.effectiveIdempotencyKey ?? input.request.idempotencyKey
    return key === undefined ? {} : { idempotencyKey: key }
  }
  /**
   * 原子分配一个动作序号。
   *
   * 单条 `insert ... on conflict do update ... returning` —— 与
   * `sequence.ts` 同一条做法（读改写会撞号，而 (action_id, sequence)
   * 是主键，撞号等于丢事件）。
   */
  async function nextSequence(characterId: CharacterId): Promise<number> {
    const rows = await exec(
      db,
      sql`insert into character_action_sequence_counters (character_id, next_sequence)
          values (${characterId}, 2)
          on conflict (character_id)
            do update set next_sequence = character_action_sequence_counters.next_sequence + 1
          returning next_sequence`,
      '分配动作序号'
    )
    const next = Number(rows[0]?.next_sequence)
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new KernelError(
        'persistence_error',
        'action_sequence_allocation_failed',
        `动作序号分配返回了非法值：${String(rows[0]?.next_sequence)}`
      )
    }
    return next - 1
  }

  async function append(input: {
    characterId: CharacterId
    actionId: ActionId
    traceId: TraceId
    type: ActionEventType
    status?: ActionStatus
    capability: string
    operation: string
    idempotencyKey?: string
    payload: Record<string, unknown>
    createdAt?: Timestamp
    attribution?: TrustedActionAttributionContext
  }): Promise<ActionLedgerEvent> {
    const sequence = await nextSequence(input.characterId)
    const createdAt = input.createdAt ?? Date.now()

    /*
     * WP5 §WP5-7：带**受信归因**的事件在 INSERT **之前**必须过三关。
     *
     *   ① 上下文是受信构造器产出的、而且描述的就是这条事件（WP5-2 / WP5-5）
     *   ② 冻结的必要性矩阵（`NECESSITY_MATRIX`）——**唯一**判据（WP5-6）
     *   ③ 行动侧 Cognitive Axis B 恒不适用（K-22；写进去的三格就是这里的 null）
     *
     * 任一关不过 ⇒ 抛（这条事件一个字都不写）。
     */
    const attribution = input.attribution
    let axisBCells: { sourceKind: null; sourceAuthority: null; epistemicSource: null } | null = null
    if (attribution !== undefined) {
      assertActionAttributionMatchesEvent(attribution, {
        eventType: input.type,
        characterId: String(input.characterId),
      })
      assertAttributionNecessity({
        family: attribution.family,
        envelope: actionAttributionEnvelopeOf(attribution),
      })
      // 行动行的 Axis B **没有**第二种合法形状 —— 这里断言的就是即将写入的三格
      axisBCells = { sourceKind: null, sourceAuthority: null, epistemicSource: null }
      assertActionAxisBNotApplicable(axisBCells)
    }

    const attributionColumns =
      attribution === undefined
        ? sql``
        : sql`, attribution_origin, source_kind, source_authority, epistemic_source, ${sql.raw(
            ATTRIBUTION_SLOT_ENTRIES.flatMap(([, columns]) => [
              columns.kind,
              columns.id,
              columns.unknownReason,
            ]).join(', ')
          )}`
    const attributionValues =
      attribution === undefined || axisBCells === null
        ? sql``
        : sql`, ${attribution.attributionOrigin}, ${axisBCells.sourceKind}, ${axisBCells.sourceAuthority}, ${axisBCells.epistemicSource}, ${sql.join(
            ATTRIBUTION_SLOT_ENTRIES.flatMap(([slot, columns]) => {
              const cell = attributionCell(attribution[slot])
              void columns
              return [sql`${cell.kind}`, sql`${cell.id}`, sql`${cell.reason}`]
            }),
            sql`, `
          )}`

    await exec(
      db,
      sql`insert into character_action_events
            (action_id, sequence, character_id, trace_id, event_type, status,
             capability, operation, idempotency_key, payload, schema_version, created_at${attributionColumns})
          values (
            ${String(input.actionId)}, ${sequence}, ${String(input.characterId)},
            ${String(input.traceId)}, ${input.type}, ${input.status ?? null},
            ${input.capability}, ${input.operation}, ${input.idempotencyKey ?? null},
            ${JSON.stringify(input.payload)}::jsonb, 1, ${createdAt}${attributionValues}
          )`,
      `写入动作事件 ${input.type}`
    )

    return {
      actionId: input.actionId,
      traceId: input.traceId,
      characterId: input.characterId,
      sequence,
      type: input.type,
      ...(input.status !== undefined ? { status: input.status } : {}),
      capability: input.capability,
      operation: input.operation,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      payload: input.payload,
      createdAt,
      /*
       * ⚠️ 这里**不**顺手回读 DB：返回值与持久层读出来的形状必须**同一份实现**
       *    （否则"写路径自证"与"读路径"会分叉）。因此带归因时按同一套三态编码
       *    回放信封的**形状**，槽位值直接取自受信上下文 —— 而"库里真的是这样"由
       *    门对**同一行**做 DB 回读断言（`pnpm m5.1.1:wp5:verify`）。
       */
      ...(attribution !== undefined
        ? {
            attribution: {
              attributionOrigin: 'RECORDED' as const,
              eventType: attribution.eventType,
              family: attribution.family,
              subject: attribution.subject,
              slots: {
                initiator: attribution.initiator as AttributionValue<unknown>,
                actor: attribution.actor as AttributionValue<unknown>,
                executor: attribution.executor as AttributionValue<unknown>,
                authority: attribution.authority as AttributionValue<unknown>,
                recordedBy: attribution.recordedBy as AttributionValue<unknown>,
                contentOriginator: attribution.contentOriginator as AttributionValue<unknown>,
              },
            },
          }
        : {}),
    }
  }

  function payloadOf(row: ActionEventRow): Record<string, unknown> {
    const raw = row.payload
    if (raw !== null && typeof raw === 'object') return raw as Record<string, unknown>
    return {}
  }

  function toEvent(row: ActionEventRow): ActionLedgerEvent {
    const status = row.status === null || row.status === undefined ? undefined : String(row.status)
    const recorded = (row.attribution_origin ?? null) === 'RECORDED'
    return {
      actionId: asActionId(String(row.action_id)),
      traceId: asTraceId(String(row.trace_id ?? '')),
      characterId: asCharacterId(String(row.character_id)),
      sequence: Number(row.sequence),
      type: String(row.event_type) as ActionEventType,
      ...(status !== undefined ? { status: status as ActionStatus } : {}),
      capability: String(row.capability),
      operation: String(row.operation),
      ...(row.idempotency_key !== null && row.idempotency_key !== undefined
        ? { idempotencyKey: String(row.idempotency_key) }
        : {}),
      payload: payloadOf(row),
      createdAt: Number(row.created_at),
      /*
       * WP5 §WP5-8：**只有 RECORDED 行**才有权威归因信封。
       * 历史行（origin 为 NULL / MIGRATED_LEGACY）**不**凭空补一个 ——
       * "这条行没有记录过归因"本身就是要如实表达的读结果。
       */
      ...(recorded ? { attribution: decodeActionAttribution(row) } : {}),
    }
  }

  async function loadEvents(predicate: unknown): Promise<ActionLedgerEvent[]> {
    const rows = rowsOf(
      await db.execute(
        sql`select * from character_action_events where ${predicate} order by sequence asc`
      )
    ) as unknown as ActionEventRow[]
    return rows.map(toEvent)
  }

  async function readRows(query: unknown): Promise<ActionEventRow[]> {
    return rowsOf(await db.execute(query)) as unknown as ActionEventRow[]
  }

  return {
    async appendRequested(input: AppendActionRequestedInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_REQUESTED',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: {
          requestedBy: input.request.requestedBy,
          sideEffect: input.request.sideEffect,
          arguments: summarizeArguments(input.request.arguments),
          ...(input.request.target !== undefined ? { declaredTarget: input.request.target } : {}),
        },
        createdAt: input.request.createdAt,
      })
    },

    async appendTargetResolved(input: AppendTargetResolvedInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_TARGET_RESOLVED',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: { target: input.target, scopeViolation: input.scopeViolation },
      })
    },

    async appendAuthorized(input: AppendAuthorizedInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_AUTHORIZED',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: { target: input.target, decision: summarizeDecision(input.decision) },
      })
    },

    async appendRejected(input: AppendRejectedInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_REJECTED',
        status: input.status,
        capability: input.request.capability,
        operation: input.request.operation,
        payload: {
          ...(input.target !== undefined ? { target: input.target } : {}),
          decision: summarizeDecision(input.decision),
          failure: input.failure,
        },
      })
    },

    async appendStarted(input: AppendStartedInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_STARTED',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: { ...(input.target !== undefined ? { target: input.target } : {}) },
      })
    },

    async appendSucceeded(input: AppendSucceededInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_SUCCEEDED',
        status: 'success',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: {
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.effect !== undefined ? { effect: input.effect } : {}),
          evidence: input.evidence,
          ...(input.idempotentReplay === true ? { idempotentReplay: true } : {}),
        },
      })
    },

    async appendPartial(input: AppendPartialInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_PARTIAL',
        status: 'partial',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: {
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.effect !== undefined ? { effect: input.effect } : {}),
          evidence: input.evidence,
          progress: input.progress,
        },
      })
    },

    async appendFailed(input: AppendFailedInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_FAILED',
        status: input.status,
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: {
          ...(input.target !== undefined ? { target: input.target } : {}),
          failure: input.failure,
        },
      })
    },

    async appendCancelled(input: AppendCancelledInput) {
      return append({
        characterId: input.characterId,
        ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
        actionId: input.request.actionId,
        traceId: input.request.traceId,
        type: 'ACTION_CANCELLED',
        status: 'cancelled',
        capability: input.request.capability,
        operation: input.request.operation,
        ...keyOf(input),
        payload: {
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.failure !== undefined ? { failure: input.failure } : {}),
        },
      })
    },

    async getEventsByActionId(characterId: CharacterId, actionId: ActionId) {
      return loadEvents(
        sql`character_id = ${String(characterId)} and action_id = ${String(actionId)}`
      )
    },

    async getEventsByTraceId(traceId: TraceId) {
      const rows = await readRows(
        sql`select * from character_action_events where trace_id = ${String(traceId)}
            order by sequence asc`
      )
      return rows.map(toEvent)
    },

    async listEvents(characterId: CharacterId, limit: number) {
      const rows = await readRows(
        sql`select * from character_action_events
            where character_id = ${String(characterId)}
            order by sequence desc limit ${boundedLimit(limit)}`
      )
      return rows.map(toEvent)
    },

    async listRecords(query: ActionLedgerQuery) {
      /*
       * ⚠️ 过滤在 SQL 里。
       *
       * `status is not null` 限定"终态行"；`status = ?` 是这次调用真正要的
       * 状态过滤。两条都必须在 where 子句里 —— 读回来再 filter 会把
       * "量具"与"系统"分成两份实现（ADR-035 明令禁止）。
       */
      const statusClause = query.status === undefined ? sql`` : sql` and status = ${query.status}`
      const capabilityClause =
        query.capability === undefined ? sql`` : sql` and capability = ${query.capability}`

      const rows = await readRows(
        sql`select action_id from character_action_events
            where character_id = ${String(query.characterId)}
              and status is not null${statusClause}${capabilityClause}
            order by created_at desc, sequence desc
            limit ${boundedLimit(query.limit)}`
      )

      const records: ExecutionRecordView[] = []
      for (const row of rows) {
        const events = await loadEvents(
          sql`character_id = ${String(query.characterId)} and action_id = ${String(row.action_id)}`
        )
        const record = foldRecord(events)
        if (record !== undefined) records.push(record)
      }
      return records
    },

    async findByIdempotencyKey(characterId: CharacterId, idempotencyKey: string) {
      const rows = await readRows(
        sql`select action_id from character_action_events
            where character_id = ${String(characterId)}
              and idempotency_key = ${idempotencyKey}
              and status is not null
            order by created_at desc, sequence desc limit 1`
      )
      const first = rows[0]
      if (first === undefined) return undefined
      const events = await loadEvents(
        sql`character_id = ${String(characterId)} and action_id = ${String(first.action_id)}`
      )
      return foldRecord(events)
    },
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20
  return Math.min(1000, limit)
}

/**
 * 参数摘要。
 *
 * ⚠️ **不把参数原文整段写进账本**：动作参数里可能有文件内容，
 *    而账本是长期留存的数据。这里保留"能不能审计"所需的最小信息：
 *    键名、字节数、指纹，以及**很短**的字符串前缀。
 *    "内容对不对"由 Level 1 证据（真实文件）回答，不是由账本回答。
 */
export function summarizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(args).sort()) {
    const value = args[key]
    if (typeof value === 'string') {
      out[key] = {
        bytes: Buffer.byteLength(value, 'utf8'),
        fingerprint: fnv1a64Hex(value),
        ...(value.length <= 40 ? { value } : { preview: `${value.slice(0, 40)}…` }),
      }
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    } else {
      out[key] = { kind: typeof value }
    }
  }
  return out
}

function summarizeDecision(decision: PolicyDecision): Record<string, unknown> {
  return {
    allowed: decision.allowed,
    code: decision.code,
    message: decision.message,
    ...(decision.riskLevel !== undefined ? { riskLevel: decision.riskLevel } : {}),
    checks: decision.checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'fail'}`),
  }
}

/**
 * 事件流 → `ExecutionRecordView`（纯函数，**无 IO**）。
 *
 * 与 Memory 的 reducer 同一种做法：折叠是纯的，因此可以在离线
 * 对同一事件流重放两次比对（"账本能自证"）。
 */
export function foldRecord(events: readonly ActionLedgerEvent[]): ExecutionRecordView | undefined {
  if (events.length === 0) return undefined
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const requested = ordered.find((e) => e.type === 'ACTION_REQUESTED')
  const first = requested ?? ordered[0]!

  let target: ActionTarget | undefined
  let status: ActionStatus | undefined
  let failure: ActionFailure | undefined
  let effect: ExecutionRecordView['effect']
  let progress: ExecutionRecordView['progress']
  let evidence: ExecutionRecordView['evidence'] = []
  let executed = false
  let accepted = false
  let startedAt: number | undefined
  let finishedAt: number | undefined
  let idempotentReplay = false
  let sideEffect: ExecutionRecordView['sideEffect'] = 'none'
  /**
   * 幂等键可能挂在**任何一个**事件上：`ACTION_REQUESTED` 写在目标解析之前，
   * 而推导键依赖已解析的目标，因此它只能出现在后面的事件上。
   * 折叠时从任一事件取第一个出现的值。
   */
  let idempotencyKey: string | undefined

  for (const event of ordered) {
    const payload = event.payload
    if (idempotencyKey === undefined && event.idempotencyKey !== undefined) {
      idempotencyKey = event.idempotencyKey
    }
    switch (event.type) {
      case 'ACTION_REQUESTED':
        if (payload.declaredTarget !== undefined) {
          target = payload.declaredTarget as ActionTarget
        }
        // 副作用等级由**声明**决定（审计不变量用它，而不是适配器自报的 effect）
        if (typeof payload.sideEffect === 'string') {
          sideEffect = payload.sideEffect as ExecutionRecordView['sideEffect']
        }
        break
      case 'ACTION_TARGET_RESOLVED':
        if (payload.target !== undefined) target = payload.target as ActionTarget
        break
      case 'ACTION_AUTHORIZED':
        accepted = true
        if (payload.target !== undefined) target = payload.target as ActionTarget
        break
      case 'ACTION_STARTED':
        executed = true
        startedAt = event.createdAt
        if (payload.target !== undefined) target = payload.target as ActionTarget
        break
      case 'ACTION_REJECTED':
      case 'ACTION_FAILED':
      case 'ACTION_SUCCEEDED':
      case 'ACTION_PARTIAL':
      case 'ACTION_CANCELLED':
        status = (event.status ?? status) as ActionStatus
        finishedAt = event.createdAt
        if (payload.failure !== undefined) failure = payload.failure as ActionFailure
        if (payload.effect !== undefined) effect = payload.effect as ExecutionRecordView['effect']
        if (payload.progress !== undefined) {
          progress = payload.progress as ExecutionRecordView['progress']
        }
        if (Array.isArray(payload.evidence)) {
          evidence = payload.evidence as ExecutionRecordView['evidence']
        }
        if (payload.idempotentReplay === true) idempotentReplay = true
        break
    }
  }

  if (status === undefined) return undefined

  return {
    actionId: first.actionId,
    traceId: first.traceId,
    capability: first.capability,
    operation: first.operation,
    status,
    executed,
    accepted,
    sideEffect,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    idempotentReplay,
    ...(target !== undefined ? { target } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(effect !== undefined ? { effect } : {}),
    ...(progress !== undefined ? { progress } : {}),
    evidence,
    requestedAt: first.createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  }
}
