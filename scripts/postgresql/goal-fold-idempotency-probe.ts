/**
 * `F-WP5-10` 的**行为级证明**：增量折叠的幂等闸真的把膨胀堵住了。
 *
 * ============================================================================
 *  它复现的是生产调用点造成的那个场景（**只读、快、不需要真 PG**）
 * ============================================================================
 *  三个生产调用点（`src/main.ts:1591-1597` · `agreement-runner.ts:131/137` 与 `:206/209`）
 *  的形状都是：
 *
 * ```text
 *   读回**本域全部已落库事件** → 交给 `applyGoalRows`（**增量**折叠）
 * ```
 *
 *  而 `applyGoalRows` 把**已存在的行**读进 cache（带着它当前的 `revision` 与
 *  `lastDomainEventSequence`），再折"你给的那批"。⇒ 喂全部历史时，每个历史事件
 *  **每次提交**都会被重折一次 ⇒ `revision` 变成"提交次数的函数"。
 *
 *  本探针就照这个形状做一遍，然后报：
 *
 * ```text
 *   ① 带闸（**当前代码**）：逐行 revision 前后差 —— 期望**全为 0**
 *   ② 不带闸（本文件里**另写一份**去掉闸的折叠，只用于对照）：期望出现正差
 *      ⇒ 两条读数放在一起，"闸有没有用"就是可判定的，而不是我说了算
 * ```
 *
 *  ⚠️ 只读：源目录只被 `cpSync`，只在 `%TEMP%` 副本上打开。
 *  ⚠️ 只打印**行键尾 12 位与计数**，不打印任何 state 正文。
 *
 * 跑法：pnpm tsx scripts/postgresql/goal-fold-idempotency-probe.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { rowToDomainEvent } from '../../src/infrastructure/persistence/event-store.ts'
import {
  GOAL_HANDLED_EVENT_TYPES,
  foldGoalRowsInMemory,
  goalEventTargets,
  goalRowKeyFromEvent,
  reduceGoalRow,
} from '../../src/kernel/projections/goal.ts'
import type { DomainEvent } from '../../src/kernel/contracts/index.ts'

import { openPgliteSnapshot } from './pglite-reader.ts'

const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'
const OUT_FILE = resolve('artifacts/post-lv2/local/pg-migration/goal-fold-idempotency.json')

/** 与 `applyGoalRows` 播种 cache 时**同形**的条目 */
interface SeedEntry {
  projectionType: string
  revision: number
  state: unknown
  lastDomainEventId?: string
  lastDomainEventSequence?: number
  changed: boolean
}

/**
 * **对照实现**：与 `foldGoalRowsInMemory` 逐行相同，**只去掉幂等闸**。
 * ⚠️ 它存在的唯一理由是"把闸拿掉会怎样"这件事本身需要读数，而不是推理。
 */
function foldWithoutGuard(cache: Map<string, SeedEntry>, events: readonly DomainEvent[]): void {
  for (const event of events) {
    const key = goalRowKeyFromEvent(event)
    if (key === undefined) continue
    const entry = cache.get(key)
    const next = reduceGoalRow(entry?.state as never, event)
    if (next === undefined) continue
    if (entry === undefined) {
      cache.set(key, {
        projectionType: key,
        revision: 1,
        state: next,
        lastDomainEventId: String(event.id),
        lastDomainEventSequence: event.sequence,
        changed: true,
      })
    } else {
      entry.state = next
      entry.revision += 1
      entry.lastDomainEventId = String(event.id)
      entry.lastDomainEventSequence = event.sequence
      entry.changed = true
    }
  }
}

async function main(): Promise<void> {
  const session = await openPgliteSnapshot({ sourceDir: SOURCE_SNAPSHOT })
  try {
    const eventRows = await session.readTable('public', 'character_domain_events')
    const projectionRows = await session.readTable('public', 'character_projections')

    const events = eventRows.rows
      .map((row) => rowToDomainEvent(row as never))
      .filter((event): event is DomainEvent => event !== undefined)
    const characterId = String(events[0]?.characterId ?? '')
    const relevant = events.filter(
      (event) =>
        (GOAL_HANDLED_EVENT_TYPES as readonly string[]).includes(event.type) &&
        goalEventTargets(event, characterId)
    )

    /** 按 `applyGoalRows` 的形状播种：带着**库里存的** revision 与 lastSeq */
    const seedOf = (): Map<string, SeedEntry> => {
      const cache = new Map<string, SeedEntry>()
      for (const row of projectionRows.rows) {
        const key = String(row.projection_type)
        if (!key.startsWith('goal:')) continue
        cache.set(key, {
          projectionType: key,
          revision: Number(row.revision),
          state: row.state,
          lastDomainEventId: row.last_domain_event_id === null ? undefined : String(row.last_domain_event_id),
          lastDomainEventSequence:
            row.last_domain_event_sequence === null ? undefined : Number(row.last_domain_event_sequence),
          changed: false,
        })
      }
      return cache
    }

    const withGuard = seedOf()
    const beforeWithGuard = new Map([...withGuard].map(([key, entry]) => [key, entry.revision]))
    foldGoalRowsInMemory(withGuard as never, relevant)

    const withoutGuard = seedOf()
    const beforeWithoutGuard = new Map([...withoutGuard].map(([key, entry]) => [key, entry.revision]))
    foldWithoutGuard(withoutGuard, relevant)

    const rows = [...beforeWithGuard.keys()].sort().map((key) => ({
      rowKeyTail: key.slice(-12),
      storedRevision: beforeWithGuard.get(key) ?? 0,
      afterWithGuard: withGuard.get(key)?.revision ?? 0,
      deltaWithGuard: (withGuard.get(key)?.revision ?? 0) - (beforeWithGuard.get(key) ?? 0),
      afterWithoutGuard: withoutGuard.get(key)?.revision ?? 0,
      deltaWithoutGuard: (withoutGuard.get(key)?.revision ?? 0) - (beforeWithoutGuard.get(key) ?? 0),
    }))

    const summary = {
      goalRows: rows.length,
      relevantEvents: relevant.length,
      rowsChangedWithGuard: rows.filter((row) => row.deltaWithGuard !== 0).length,
      deltaSumWithGuard: rows.reduce((sum, row) => sum + row.deltaWithGuard, 0),
      rowsChangedWithoutGuard: rows.filter((row) => row.deltaWithoutGuard !== 0).length,
      deltaSumWithoutGuard: rows.reduce((sum, row) => sum + row.deltaWithoutGuard, 0),
    }
    const attestation = await session.close()

    mkdirSync(resolve(OUT_FILE, '..'), { recursive: true })
    writeFileSync(OUT_FILE, JSON.stringify({ summary, rows, attestation }, null, 2), 'utf8')

    console.log('`F-WP5-10` 行为级证明：把**全部历史**喂进增量折叠（生产调用点的形状）')
    console.log('─'.repeat(88))
    console.log(`  目标域事件 = ${relevant.length} · goal 投影行 = ${rows.length}`)
    console.log('')
    console.log('  行键尾        存的 revision   带闸后   差      不带闸后   差')
    for (const row of rows) {
      console.log(
        `  ${String(row.rowKeyTail).padEnd(14)}${String(row.storedRevision).padStart(8)}` +
          `${String(row.afterWithGuard).padStart(10)}${String(row.deltaWithGuard).padStart(6)}` +
          `${String(row.afterWithoutGuard).padStart(12)}${String(row.deltaWithoutGuard).padStart(7)}`
      )
    }
    console.log('')
    console.log(`  带闸（当前代码）：变化行 ${summary.rowsChangedWithGuard} · Δ合计 **${summary.deltaSumWithGuard}**`)
    console.log(`  不带闸（对照）  ：变化行 ${summary.rowsChangedWithoutGuard} · Δ合计 **${summary.deltaSumWithoutGuard}**`)
    console.log('')
    console.log(
      summary.deltaSumWithGuard === 0 && summary.deltaSumWithoutGuard > 0
        ? '✅ 闸有效：喂全部历史**不再**改变任何一行的 revision（而拿掉闸就会出现膨胀）'
        : '❌ 读数不符合预期 —— 见上面的逐行表'
    )
    console.log(`报告：${OUT_FILE}`)
    console.log(`自证：${JSON.stringify(attestation)}`)
    if (!(summary.deltaSumWithGuard === 0 && summary.deltaSumWithoutGuard > 0)) process.exitCode = 1
  } finally {
    try {
      await session.close()
    } catch {
      /* 已关过 */
    }
  }
}

await main()
