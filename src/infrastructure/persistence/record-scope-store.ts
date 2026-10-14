/**
 * Record Scope Labels —— **记录的归属与披露**（多用户补充计划 U1 / WP4）。
 *
 * ============================================================================
 *  ADR-137 **方案 B**（2026-10-14 原主人裁定）
 * ============================================================================
 * 标签放在 `memory_records` **之外**（表的形状见迁移 `0019`）：
 *
 * ```text
 * 记录/事件 payload 一字不改  ⇒ rebuildMemory() **不**重算标签
 * 迁移只建表                ⇒ **不**给旧记录回填 origin
 * 缺标签                    ⇒ 按 **private_to_origin** 处理（最保守，X0 `VL-01`）
 *                              并**如实**出现在完整性报告里（不静默、也不提升为公共）
 * ```
 *
 * ⚠️ 本文件**只**负责标签的读写与保守缺省判定；**读侧过滤**（把标签接进召回/候选/输出）
 *    是 WP5 的事 —— 今天还没有任何读取面按它过滤（那正是 U1 尚未完成的部分）。
 */

import { sql } from 'drizzle-orm'

import { decideRecordVisibility, type RecordVisibilityDecision } from '../../kernel/contracts/record-visibility.ts'
import type { DisclosureClass, Principal, Room, ScopeContext } from '../../kernel/contracts/scope.ts'
import { DISCLOSURE_CLASSES } from '../../kernel/contracts/scope.ts'
import { exec, firstRow, type RawDb } from './db.ts'

/** 首版只有 `'memory'`（留种类，便于日后扩到附件/日志） */
export type RecordKind = 'memory'

export const RECORD_KINDS: readonly RecordKind[] = ['memory']

export interface RecordScopeLabel {
  readonly recordKind: RecordKind
  readonly recordId: string
  readonly originRoom: Room
  readonly disclosure: DisclosureClass
  readonly labeledAt: number
  /** 程序来源（如 `memory-write-path@1`）——**不许**为空 */
  readonly labeledBy: string
}

export interface LabelRecordScopeInput {
  readonly recordKind: RecordKind
  readonly recordId: string
  readonly originRoom: Room
  readonly disclosure: DisclosureClass
  readonly labeledBy: string
  readonly now?: number
}

/** 记录 id 不许为空（空 id 的标签没有意义，只会掩盖调用点的错误） */
function assertNonEmpty(value: string, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} 不能为空（失败的标签行比没有标签更糟：它看起来"已授权"）`)
  }
}

/**
 * 写一行标签（**写一次**：`on conflict do nothing`）。
 *
 * ⚠️ 它**不覆盖**已存在的标签：披露类别的**变更**（例如日后授予"显式分享"）
 *    必须是**另一个显式动作 + 审计**，不能靠重写这一行悄悄发生（`ADR-137` §4.2）。
 *    返回值 `created=false` 表示"原本就有标签，本次没改任何东西"。
 */
export async function labelRecordScope(
  db: RawDb,
  input: LabelRecordScopeInput
): Promise<{ created: boolean }> {
  assertNonEmpty(input.recordId, 'recordId')
  assertNonEmpty(input.labeledBy, 'labeledBy')
  if (!RECORD_KINDS.includes(input.recordKind)) {
    throw new Error(`未登记的 recordKind：${String(input.recordKind)}`)
  }
  if (!DISCLOSURE_CLASSES.includes(input.disclosure)) {
    throw new Error(`未登记的 disclosure：${String(input.disclosure)}`)
  }
  const room = input.originRoom
  const roomId = room.kind === 'private' ? room.userId : room.groupId
  assertNonEmpty(roomId, 'originRoom 的 id')

  const before = await readRecordScopeLabel(db, input.recordKind, input.recordId)
  if (before !== undefined) return { created: false }

  await exec(
    db,
    sql`insert into record_scope_labels
          (record_kind, record_id, origin_room_kind, origin_room_id, disclosure, labeled_at, labeled_by)
        values (${input.recordKind}, ${input.recordId}, ${room.kind}, ${roomId},
                ${input.disclosure}, ${input.now ?? Date.now()}, ${input.labeledBy})
        on conflict (record_kind, record_id) do nothing`,
    '写入记录作用域标签'
  )
  const after = await readRecordScopeLabel(db, input.recordKind, input.recordId)
  return { created: after !== undefined && before === undefined }
}

export async function readRecordScopeLabel(
  db: RawDb,
  recordKind: RecordKind,
  recordId: string
): Promise<RecordScopeLabel | undefined> {
  const rows = await exec(
    db,
    sql`select * from record_scope_labels
        where record_kind = ${recordKind} and record_id = ${recordId} limit 1`,
    '读取记录作用域标签'
  )
  const row = firstRow<{
    record_kind: string
    record_id: string
    origin_room_kind: string
    origin_room_id: string
    disclosure: string
    labeled_at: number
    labeled_by: string
  }>(rows)
  if (!row) return undefined
  const originRoom: Room =
    row.origin_room_kind === 'group'
      ? { kind: 'group', groupId: String(row.origin_room_id) }
      : { kind: 'private', userId: String(row.origin_room_id) }
  return {
    recordKind: String(row.record_kind) as RecordKind,
    recordId: String(row.record_id),
    originRoom,
    disclosure: String(row.disclosure) as DisclosureClass,
    labeledAt: Number(row.labeled_at),
    labeledBy: String(row.labeled_by),
  }
}

/**
 * **保守缺省判定**（`ADR-137` `R-WP4-3` / X0 `VL-01`）。
 *
 * ```text
 * 有标签 ⇒ 用它
 * 缺标签 ⇒ private_to_origin（**最保守**）+ labelMissing=true（如实报告，不静默）
 *          ⚠️ **绝不**退化成"公共"或"同群可见"
 * ```
 */
export function effectiveDisclosure(label: RecordScopeLabel | undefined): {
  readonly disclosure: DisclosureClass
  readonly labelMissing: boolean
} {
  if (label === undefined) return { disclosure: 'private_to_origin', labelMissing: true }
  return { disclosure: label.disclosure, labelMissing: false }
}

/**
 * 完整性报告的一部分：**没有标签**的活记录（有界）。
 *
 * ⚠️ 它**不**修数据、**不**回填 origin：只如实列出（`ADR-137` §4.3/§4.4）。
 * ⚠️ 那正是 U1 未完成时应当看到的读数：迁移植建表 ⇒ 旧记录**全部**落在这里。
 */
export async function listMemoryRecordsMissingScopeLabels(
  db: RawDb,
  limit = 20
): Promise<{ readonly total: number; readonly sample: readonly string[] }> {
  const rows = await exec(
    db,
    sql`select m.id as id
        from memory_records m
        left join record_scope_labels l
          on l.record_kind = 'memory' and l.record_id = m.id
        where l.record_id is null
        order by m.id asc
        limit ${limit}`,
    '列出缺作用域标签的记忆'
  )
  const sample = rows.map((row) => String(row.id))
  const countRows = await exec(
    db,
    sql`select count(*)::int as c
        from memory_records m
        left join record_scope_labels l
          on l.record_kind = 'memory' and l.record_id = m.id
        where l.record_id is null`,
    '统计缺作用域标签的记忆'
  )
  return { total: Number(firstRow<{ c: number }>(countRows)?.c ?? 0), sample }
}

/**
 * ============================================================================
 *  **授权前置过滤**（`G18`：授权过滤必须**早于**候选截断）
 * ============================================================================
 *
 * ```text
 * 现状（`G18` 登记的缺口）：`memory-retrieval-store.ts:345-348` 先 `slice(0, limit)`，
 * 资格层在**下游**才跑 ⇒ 越权候选会**占掉名额**，把有权看的挤出去（结果缩水），
 * 而且缩水是**静默**的（调用方只看到"命中少了"）。
 * 本函数把授权判定提到截断**之前**：调用方先拿它过滤候选，**再**截断。
 * ```
 *
 * ⚠️ **缺标签的保守缺省 = 原主人私聊**（`defaultOriginRoom` 由调用方给，通常就是原主人）。
 *    理由：档案在单用户时期**只属于原主人** ⇒ 旧记录对普通用户默认**不可见**、对原主人默认可见，
 *    而且**不需要回填** origin（那是 `ADR-137` `R-WP4-3` 明令不做的事）。
 *    ⚠️ 它**不是**"把缺标签当成提问者的私聊" —— 那等于给每个陌生人生成一条"你的旧记录"。
 *
 * ⚠️ 它**只做授权**：不做相关性排序、不做资格（established evidence）判定、不改任何记录。
 *    顺序保持不变（返回的 id 与传入候选同序），所以"先过滤后截断"与既有排序无冲突。
 */
export interface AuthorizedCandidateInput {
  readonly context: ScopeContext
  /** 已按相关性排好序的候选 id（**截断前**的那一批） */
  readonly candidateIds: readonly string[]
  /** 缺标签时按哪个来源域保守处理（通常是原主人私聊） */
  readonly defaultOriginRoom: Room
  readonly roomAuthorized?: boolean
  readonly askerRelationshipConditionMet?: boolean
}

export interface AuthorizedCandidateOutcome {
  /** 有权读的 id，**与传入候选同序** */
  readonly authorized: readonly string[]
  readonly denied: number
  /** 其中因为**没有标签**而被保守处理掉的数量（如实报告，便于驱动打标进度） */
  readonly deniedForMissingLabel: number
  /** 逐条的判定留痕（只记 id 与否决码，**不记正文**） */
  readonly reasons: readonly { readonly recordId: string; readonly allowed: boolean; readonly scopeCode: string }[]
}

export async function filterAuthorizedMemoryCandidates(
  db: RawDb,
  input: AuthorizedCandidateInput
): Promise<AuthorizedCandidateOutcome> {
  const ids = [...input.candidateIds]
  if (ids.length === 0) {
    return { authorized: [], denied: 0, deniedForMissingLabel: 0, reasons: [] }
  }

  /* 一次批量读标签（不做 N+1）；缺行 = 没有标签 */
  const labels = new Map<string, { originRoom: Room; disclosure: DisclosureClass }>()
  const placeholders = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )
  const rows = await exec(
    db,
    sql`select record_id, origin_room_kind, origin_room_id, disclosure
        from record_scope_labels
        where record_kind = 'memory' and record_id in (${placeholders})`,
    '批量读取记录作用域标签'
  )
  for (const row of rows) {
    labels.set(String(row.record_id), {
      originRoom:
        String(row.origin_room_kind) === 'group'
          ? { kind: 'group', groupId: String(row.origin_room_id) }
          : { kind: 'private', userId: String(row.origin_room_id) },
      disclosure: String(row.disclosure) as DisclosureClass,
    })
  }

  const authorized: string[] = []
  const reasons: { recordId: string; allowed: boolean; scopeCode: string }[] = []
  let denied = 0
  let deniedForMissingLabel = 0

  for (const recordId of ids) {
    const label = labels.get(recordId)
    const originRoom = label?.originRoom ?? input.defaultOriginRoom
    const decision: RecordVisibilityDecision = decideRecordVisibility({
      context: input.context,
      label: label === undefined ? undefined : { originRoom: label.originRoom, disclosure: label.disclosure },
      originRoom,
      ...(input.roomAuthorized === undefined ? {} : { roomAuthorized: input.roomAuthorized }),
      ...(input.askerRelationshipConditionMet === undefined
        ? {}
        : { askerRelationshipConditionMet: input.askerRelationshipConditionMet }),
    })
    reasons.push({ recordId, allowed: decision.allowed, scopeCode: decision.scopeCode })
    if (decision.allowed) {
      authorized.push(recordId)
    } else {
      denied += 1
      if (decision.labelMissing) deniedForMissingLabel += 1
    }
  }

  return { authorized, denied, deniedForMissingLabel, reasons }
}

/** 只给需要"缺标签缺省 = 原主人私聊"的调用方用；把这条规则**写成一处** */
export function ownerPrivateOriginRoom(ownerUserId: string): Room {
  return { kind: 'private', userId: ownerUserId }
}

/** 便捷：`Principal` + purpose + room ⇒ `ScopeContext`（避免各调用点各拼一次） */
export function scopeContextOf(input: {
  readonly principal: Principal
  readonly purpose: ScopeContext['purpose']
  readonly room: Room
}): ScopeContext {
  return { principal: input.principal, purpose: input.purpose, room: input.room }
}
