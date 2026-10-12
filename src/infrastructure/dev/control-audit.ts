/**
 * M5.1.1 / WP9-A —— **Developer Control 的 durable authoritative audit writer + reader**
 *
 * ============================================================================
 *  为什么这个文件存在（U-03 / ADR D9 / K-23）
 * ============================================================================
 * U-03（`docs/m5.1.1/M5.1.1-Unresolved-Decisions.md`，STATUS = DECIDED）原文：
 *
 *   · Privileged Developer Control **必须最终**进入 durable authoritative audit ledger；
 *   · **不得**永久选择"控制面不参与 attribution authority"；
 *   · **不得**为了省事把 Control Command 假装成普通 Character Action。
 *
 * ADR D9 给了正确模型：控制面的 `initiator` / `actor` / `authority` 必须进入**独立的** authoritative
 * audit 语义，transport 只是 observational；控制命令**不**伪装成 Character Action（所以本文件只写
 * `developer_control_events`，绝不写 `character_action_events`）。
 *
 * ============================================================================
 *  归因取值口径（**冻结矩阵**，不在这里新造判据）
 * ============================================================================
 * `src/kernel/contracts/attribution.ts` 的矩阵行为
 *   `developer_control: row('REQUIRED', 'REQUIRED', 'ABSENT', 'REQUIRED', 'REQUIRED', 'ABSENT')`
 *   （顺序：initiator / actor / executor / authority / recordedBy / contentOriginator；subject = DERIVED，不落库）
 * 于是本 writer 只填四格、把另外两格**如实写 Absent**：
 *
 *   initiator  ← 真实 developer identity 证据；**解析不出来就 Unknown(RUNTIME_UNRESOLVED)**
 *                （U-02：`developer` 是上下文角色、不是位次种类；能确认身份的是 `USER/<id>`，
 *                  确认不了就是 Unknown。绝不从 `requestedBy.kind='developer'` 或 surface 推导位次）
 *   actor      ← 控制面自己，`SERVICE/control-service`
 *   authority  ← 真实策略/能力面：**白名单本身**（`CONTROL_COMMAND_FACTS` / `CONTROL_COMMAND_TYPES`）
 *                就是"哪些控制命令被允许"的权威面 ⇒ 统一记 `CAPABILITY/developer.control`。
 *                **绝不**把请求里的 `surface`（cli/http/page）或调用方自报的字段变成 authority。
 *   recordedBy ← K-23 的既有规则：`CANONICAL_LEDGER_RECORDER = Known(SYSTEM, 'kernel')`
 *                （**不**沿用迁移门探针里的 `SYSTEM/control-service` —— 那是约束探针的取值，
 *                  不是约定；要新增 recorder 必须显式登记进 `TRUSTED_LEDGER_WRITERS`，本 WP 不扩大它）
 *   executor / contentOriginator ← Absent（矩阵要求；填任何值都会被 canonical 判据拒绝）
 *
 * 写入前过 **canonical** `assertAttributionNecessity({ family: 'developer_control', envelope })`，
 * 与三态 CHECK（`developer_control_events_<slot>_tri_state`）双重兜底。
 *
 * ============================================================================
 *  只写 `developer_control_events`；表本身没有 Axis B / origin 列（设计如此，无 v9）
 * ============================================================================
 */

import { sql } from 'drizzle-orm'

import { exec, rowsOf, type RawDb } from '../persistence/db.ts'
import {
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  type AttributionValue,
  type PrincipalRef,
} from '../../kernel/contracts/actor.ts'
import {
  ATTRIBUTION_SLOT_COLUMNS,
  CANONICAL_LEDGER_RECORDER,
  assertAttributionNecessity,
  type AuthorityRef,
  type AttributionEnvelope,
  type AttributionValueSlot,
} from '../../kernel/contracts/attribution.ts'
import {
  CONTROL_COMMAND_FACTS,
  isControlCommandType,
  type ControlCommand,
  type ControlReasonCode,
  type ControlResult,
} from '../../kernel/contracts/developer-control.ts'

/** 控制面的权威：**白名单本身**就是"哪些命令被允许"的权威面 ⇒ 统一一个 capability 位次 */
export const DEVELOPER_CONTROL_AUTHORITY: AuthorityRef = Object.freeze({
  kind: 'CAPABILITY' as const,
  ref: 'developer.control',
})

/**
 * 控制面的 actor：**做这件事的是控制面自己**（不是请求方、不是页面）。
 * ⚠️ transport（cli / http / page）只进 `transport` 列，**永远**不参与任何 principal 或 authority。
 */
export const DEVELOPER_CONTROL_ACTOR: PrincipalRef = Object.freeze({
  kind: 'SERVICE' as const,
  id: 'control-service',
})

/** audit 行的序列号：一条命令一行（重放不追加第二行） */
const CONTROL_AUDIT_SEQUENCE = 1

export interface ControlAuditRecordInput {
  /** 权威命令身份：来自**已解析的** `ControlCommand`（没有它的形状非法命令无法被审计） */
  command: ControlCommand
  /** 真实执行结果（outcome / disposition / verification / reasonCode 全部照抄，不解释、不改写） */
  result: ControlResult
  characterId: string
  /** 真实 trace（L-02：控制命令目前不写 trace ⇒ 通常是 undefined ⇒ 列保持 NULL） */
  traceId?: string
}

export interface DeveloperControlAuditWriter {
  record: (input: ControlAuditRecordInput) => Promise<{ commandId: string; sequence: number }>
  /** 本 writer 的位次口径（证据用：让门能断言"authority 不随 surface 变化"） */
  readonly attributionModel: {
    authority: AuthorityRef
    actor: PrincipalRef
    recordedBy: PrincipalRef
    initiatorSource: 'developer-identity-evidence' | 'unknown-runtime-unresolved'
  }
}

export interface DeveloperControlAuditWriterOptions {
  db: RawDb
  now?: () => number
  /**
   * **真实 developer identity 证据**：只允许由装配根（`src/main.ts` 一类）注入的受信位次。
   * ⚠️ 它**不是**请求字段：任何来自 HTTP/CLI/Page 载荷的值都不得进入这里。
   * 缺省（今天的运行时就是这样：HTTP 面没有任何身份/认证）= 无法解析 ⇒ 如实 Unknown(RUNTIME_UNRESOLVED)。
   */
  developerIdentity?: PrincipalRef
}

interface Cell {
  kind: string | null
  id: string | null
  reason: string | null
}

/** 三态 → 物理三格（与 conversation-store 同一套编码；表上的 tri_state CHECK 会再兜一次） */
function cellOf(value: AttributionValue<PrincipalRef> | AttributionValue<AuthorityRef>, isAuthority = false): Cell {
  if (value.state === 'KNOWN') {
    const raw = value.value as { kind?: string; id?: string; ref?: string }
    return { kind: raw.kind ?? null, id: isAuthority ? (raw.ref ?? null) : (raw.id ?? null), reason: null }
  }
  if (value.state === 'UNKNOWN') return { kind: null, id: null, reason: value.reason }
  return { kind: null, id: null, reason: null }
}

/**
 * 建一个 audit writer。**每个控制命令调一次 `record()`**（成功 verified 与失败 rejected 都调），
 * 由 `control-service.ts` 在**权威执行链**上调用 —— 绝不在 HTTP handler / 页面层调用。
 */
export function createDeveloperControlAuditWriter(options: DeveloperControlAuditWriterOptions): DeveloperControlAuditWriter {
  const now = options.now ?? (() => Date.now())
  const db = options.db
  const identity = options.developerIdentity

  const initiator: AttributionValue<PrincipalRef> =
    identity === undefined ? attributionUnknown<PrincipalRef>('RUNTIME_UNRESOLVED') : attributionKnown<PrincipalRef>(identity)

  const authority: AttributionValue<AuthorityRef> = attributionKnown<AuthorityRef>(DEVELOPER_CONTROL_AUTHORITY)
  const actor: AttributionValue<PrincipalRef> = attributionKnown<PrincipalRef>(DEVELOPER_CONTROL_ACTOR)
  const recordedBy: AttributionValue<PrincipalRef> = attributionKnown<PrincipalRef>({
    kind: CANONICAL_LEDGER_RECORDER.kind as PrincipalRef['kind'],
    id: CANONICAL_LEDGER_RECORDER.id,
  })

  const envelope: AttributionEnvelope = {
    // subject = DERIVED（canonical owner）；本表不落该列，这里给的是矩阵要求的那份信封形态
    subject: { kind: 'CHARACTER', id: 'control-plane' } as PrincipalRef,
    initiator,
    actor,
    executor: attributionAbsent<PrincipalRef>(),
    authority,
    recordedBy,
    contentOriginator: attributionAbsent<PrincipalRef>(),
    attributionOrigin: 'RECORDED' as const,
  }

  return {
    attributionModel: {
      authority: DEVELOPER_CONTROL_AUTHORITY,
      actor: DEVELOPER_CONTROL_ACTOR,
      recordedBy: { kind: CANONICAL_LEDGER_RECORDER.kind as PrincipalRef['kind'], id: CANONICAL_LEDGER_RECORDER.id },
      initiatorSource: identity === undefined ? 'unknown-runtime-unresolved' : 'developer-identity-evidence',
    },
    record: async (input: ControlAuditRecordInput) => {
      const { command, result } = input
      if (!isControlCommandType(command.type)) {
        // fail closed：白名单之外的控制命令不该有权威身份，更不该被写进权威审计面
        throw new Error(`developer_control_audit: 拒绝审计白名单外的命令类型 ${String(command.type)}`)
      }
      // ① canonical 必要性判据（与消费边界**同一份**实现；executor/contentOriginator 必须是 Absent）
      assertAttributionNecessity({ family: 'developer_control', envelope })

      const fact = CONTROL_COMMAND_FACTS[command.type]
      const cells: Record<string, Cell> = {
        initiator: cellOf(initiator),
        actor: cellOf(actor),
        executor: cellOf(envelope.executor),
        authority: cellOf(authority, true),
        recordedBy: cellOf(recordedBy),
        contentOriginator: cellOf(envelope.contentOriginator),
      }
      const columnValues = (Object.keys(ATTRIBUTION_SLOT_COLUMNS) as AttributionValueSlot[]).flatMap((slot) => {
        const c = ATTRIBUTION_SLOT_COLUMNS[slot]
        const cell = cells[slot] as Cell
        return [cell.kind, cell.id, cell.reason]
      })
      /*
       * ⚠️ 列名与值必须来自**同一个**映射、按**同一个**顺序展开 —— 手写列顺序迟早与
       * `ATTRIBUTION_SLOT_COLUMNS` 的键顺序不一致（本 WP 实测踩到：authority 的值被写进
       * `recorded_by_*`、`content_originator_*` 收到 CAPABILITY ⇒ kind 词表 CHECK 直接报错）。
       * 与 `conversation-store.ts` 的 `sql.raw(attributionSlotEntries.flatMap(...).join(', '))` 同一纪律。
       */
      const slotColumnNames = (Object.keys(ATTRIBUTION_SLOT_COLUMNS) as AttributionValueSlot[]).flatMap((slot) => {
        const c = ATTRIBUTION_SLOT_COLUMNS[slot]
        return [c.kind, c.id, c.unknownReason]
      })

      // payload = 该命令的**声明式出处**（producer / authority 的散文描述、是否改领域、是否支持 dryRun），
      // 观测性材料；principal / authority 位次一律来自上面的受信口径，绝不由 payload 提供。
      const payload = {
        fact: {
          type: fact.type,
          kind: fact.kind,
          mutatesDomain: fact.mutatesDomain,
          supportsDryRun: fact.supportsDryRun,
          producer: fact.producer,
          authority: fact.authority,
        },
        reasonCode: result.reasonCode ?? null,
        requestedBy: command.requestedBy,
        auditWriter: 'developer-control-audit',
      }

      await exec(
        db,
        sql`insert into developer_control_events
              (command_id, sequence, character_id, trace_id, command_type,
               outcome, disposition, verification, reason_code, transport,
               ${sql.raw(slotColumnNames.join(', '))},
               payload, schema_version, created_at)
            values (${command.commandId}, ${CONTROL_AUDIT_SEQUENCE}, ${input.characterId},
                    ${input.traceId ?? null}, ${command.type},
                    ${result.outcome}, ${result.disposition}, ${result.verification},
                    ${result.reasonCode ?? null}, ${command.requestedBy.surface},
                    ${sql.join(
                      columnValues.map((v) => sql`${v ?? null}`),
                      sql`, `,
                    )},
                    ${JSON.stringify(payload)}::jsonb, 1, ${now()})
            on conflict (command_id, sequence) do nothing`,
        '写入 Developer Control 权威审计行',
      )
      return { commandId: command.commandId, sequence: CONTROL_AUDIT_SEQUENCE }
    },
  }
}

export interface DeveloperControlAuditRow {
  commandId: string
  sequence: number
  commandType: string
  outcome: string | null
  disposition: string | null
  verification: string | null
  reasonCode: ControlReasonCode | null
  transport: string | null
  slots: Record<AttributionValueSlot, string>
  payload: Record<string, unknown>
  createdAt: number
}

const cellTriple = (row: Record<string, unknown>, slot: AttributionValueSlot): string => {
  const c = ATTRIBUTION_SLOT_COLUMNS[slot]
  const kind = row[c.kind]
  const id = row[c.id]
  const reason = row[c.unknownReason]
  if (kind === null || kind === undefined) {
    return reason === null || reason === undefined ? 'ABSENT|-|-|-' : `UNKNOWN|-|-|${String(reason)}`
  }
  return `KNOWN|${String(kind)}|${String(id)}|-`
}

/** 权威审计行的读回（仓库此前没有这个查询）。按 `command_id` 升序返回该命令的审计行。 */
export async function readDeveloperControlAudit(db: RawDb, commandId: string): Promise<DeveloperControlAuditRow[]> {
  const rows = rowsOf(
    (await db.execute(sql`select * from developer_control_events where command_id = ${commandId} order by sequence asc`)) as never,
  ) as Record<string, unknown>[]
  return rows.map((row) => ({
    commandId: String(row.command_id),
    sequence: Number(row.sequence),
    commandType: String(row.command_type),
    outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
    disposition: row.disposition === null || row.disposition === undefined ? null : String(row.disposition),
    verification: row.verification === null || row.verification === undefined ? null : String(row.verification),
    reasonCode: (row.reason_code ?? null) as ControlReasonCode | null,
    transport: row.transport === null || row.transport === undefined ? null : String(row.transport),
    slots: Object.fromEntries(
      (Object.keys(ATTRIBUTION_SLOT_COLUMNS) as AttributionValueSlot[]).map((slot) => [slot, cellTriple(row, slot)]),
    ) as Record<AttributionValueSlot, string>,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: Number(row.created_at),
  }))
}

/** 审计面的行数（门与回归用；`table` 为空时返回 0） */
export async function developerControlAuditCount(db: RawDb): Promise<number> {
  const rows = rowsOf((await db.execute(sql`select count(*)::int as c from developer_control_events`)) as never) as {
    c: number
  }[]
  return Number(rows[0]?.c ?? 0)
}
