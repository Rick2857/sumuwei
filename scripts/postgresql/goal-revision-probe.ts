/**
 * PostgreSQL 迁移 WP5：**`goal:` 投影 revision 差异的定向探针**（只读、快、不需要真 PG）。
 *
 * ============================================================================
 *  它回答的问题（`PG-G06` 的 `G06.1f` 那 18 行到底差在哪）
 * ============================================================================
 *  `PG-G06` 报出：29 行投影里 18 行（全部 `goal:`）重建后 **`revision` 不同**，
 *  而 `last_domain_event_sequence` / `last_domain_event_id` / `state` **相同**。
 *
 *  这个探针在**源快照**上（不恢复、不起核心）做同一件事的**最小版本**：
 *
 * ```text
 *   ① 读 character_domain_events → 用**真实的** rowToDomainEvent 映射
 *   ② 用**真实的** GOAL_HANDLED_EVENT_TYPES + goalEventTargets 过滤（与重建路径同一判据）
 *   ③ 用**真实的** foldGoalRowsInMemory 从零折叠
 *   ④ 与库里**存的** goal 投影逐行比 revision / lastDomainEventId / lastDomainEventSequence
 *   ⇒ 报出方向与量级：存的是偏大、偏小、还是相等
 * ```
 *
 *  ⚠️ 只说结论需要的话：**只打印事件类型与序号，不打印 payload**（可能含私人正文）。
 *
 * 跑法：pnpm tsx scripts/postgresql/goal-revision-probe.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { rowToDomainEvent } from '../../src/infrastructure/persistence/event-store.ts'
import { GOAL_HANDLED_EVENT_TYPES, foldGoalRowsInMemory, goalEventTargets } from '../../src/kernel/projections/goal.ts'
import type { DomainEvent } from '../../src/kernel/contracts/index.ts'

import { openPgliteSnapshot } from './pglite-reader.ts'

const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'

const OUT_FILE = resolve('artifacts/post-lv2/local/pg-migration/goal-revision.json')

/** 规范化 JSON（键排序）—— 只用来比较两侧 state，不打印 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 12)

async function main(): Promise<void> {
  const session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
  try {
    const eventRows = await session.readTable('public', 'character_domain_events')
    const projectionRows = await session.readTable('public', 'character_projections')

    const events = eventRows.rows
      .map((row) => rowToDomainEvent(row as never))
      .filter((event): event is DomainEvent => event !== undefined)
    const characterIds = [...new Set(events.map((event) => String(event.characterId)))]
    if (characterIds.length !== 1) throw new Error(`领域事件里的 character_id 不唯一：${characterIds.join(',')}`)
    const characterId = characterIds[0]

    const relevant = events.filter(
      (event) =>
        (GOAL_HANDLED_EVENT_TYPES as readonly string[]).includes(event.type) && goalEventTargets(event, characterId)
    )
    const skippedByFilter = events.filter((event) => event.type.startsWith('GOAL_') || event.type.startsWith('COMMITMENT_'))
      .filter((event) => !relevant.includes(event))

    const cache = new Map<string, { revision: number; state?: unknown; lastDomainEventId?: string; lastDomainEventSequence?: number }>()
    foldGoalRowsInMemory(cache as never, relevant)

    const stored = new Map(
      projectionRows.rows
        .filter((row) => String(row.projection_type).startsWith('goal:'))
        .map((row) => [
          String(row.projection_type),
          {
            revision: Number(row.revision),
            state: row.state,
            lastDomainEventId: row.last_domain_event_id === null ? undefined : String(row.last_domain_event_id),
            lastDomainEventSequence:
              row.last_domain_event_sequence === null ? undefined : Number(row.last_domain_event_sequence),
          },
        ])
    )

    const rows = [...new Set([...stored.keys(), ...cache.keys()])].sort().map((key) => {
      const a = stored.get(key)
      const b = cache.get(key)
      return {
        rowKeyTail: key.slice(-12),
        storedRevision: a?.revision ?? null,
        foldedRevision: b?.revision ?? null,
        delta: (a?.revision ?? 0) - (b?.revision ?? 0),
        revisionEqual: a?.revision === b?.revision,
        sequenceEqual: a?.lastDomainEventSequence === b?.lastDomainEventSequence,
        stotedSequence: a?.lastDomainEventSequence ?? null,
        foldedSequence: b?.lastDomainEventSequence ?? null,
        lastEventIdEqual: a?.lastDomainEventId === b?.lastDomainEventId,
        stateEqual: digest(a?.state) === digest(b?.state),
        storedOnly: a !== undefined && b === undefined,
        foldedOnly: a === undefined && b !== undefined,
      }
    })

    const histogram = {
      rows: rows.length,
      revisionEqual: rows.filter((row) => row.revisionEqual).length,
      storedGreater: rows.filter((row) => row.delta > 0).length,
      storedSmaller: rows.filter((row) => row.delta < 0).length,
      deltaSum: rows.reduce((sum, row) => sum + row.delta, 0),
      sequenceEqual: rows.filter((row) => row.sequenceEqual).length,
      lastEventIdEqual: rows.filter((row) => row.lastEventIdEqual).length,
      stateEqual: rows.filter((row) => row.stateEqual).length,
      storedOnly: rows.filter((row) => row.storedOnly).length,
      foldedOnly: rows.filter((row) => row.foldedOnly).length,
    }

    const report = {
      source: SOURCE_SNAPSHOT,
      characterId,
      totalDomainEvents: events.length,
      goalHandledTypes: GOAL_HANDLED_EVENT_TYPES,
      relevantGoalEvents: relevant.length,
      /** 看起来像目标域、却被过滤掉的事件（**只报类型与序号**） */
      filteredOutButGoalLike: skippedByFilter.map((event) => ({ type: event.type, sequence: event.sequence })),
      relevantEventTypes: [...new Set(relevant.map((event) => event.type))].sort(),
      histogram,
      rows,
    }
    const attestation = await session.close()
    mkdirSync(resolve(OUT_FILE, '..'), { recursive: true })
    writeFileSync(OUT_FILE, JSON.stringify({ ...report, attestation }, null, 2), 'utf8')

    console.log(`characterId = ${characterId}`)
    console.log(`领域事件总数 = ${events.length} · 目标域相关（按重建路径同一判据过滤后）= ${relevant.length}`)
    console.log(`目标域事件类型 = ${report.relevantEventTypes.join(', ')}`)
    console.log(`像目标域但被过滤掉的事件 = ${skippedByFilter.length}` +
      (skippedByFilter.length ? `：${skippedByFilter.map((e) => `${e.type}#${e.sequence}`).join(' ')}` : ''))
    console.log('')
    console.log('逐行（只报行键尾 12 位与计数）：')
    console.log('  行键尾        存 revision   折叠 revision   差    seq同  lastId同  state同')
    for (const row of rows) {
      console.log(
        `  ${String(row.rowKeyTail).padEnd(14)}${String(row.storedRevision).padStart(6)}` +
          `${String(row.foldedRevision).padStart(14)}${String(row.delta).padStart(7)}` +
          `   ${row.sequenceEqual ? '是' : '否'}     ${row.lastEventIdEqual ? '是' : '否'}      ${row.stateEqual ? '是' : '否'}`
      )
    }
    console.log('')
    console.log(`直方图 = ${JSON.stringify(histogram)}`)
    console.log(`自证 = ${JSON.stringify(attestation)}`)
    console.log(`报告：${OUT_FILE}`)
  } finally {
    try {
      await session.close()
    } catch {
      /* 已关过 */
    }
  }
}

await main()
