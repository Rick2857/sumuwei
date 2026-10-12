/**
 * M5.1.1 / Phase 4b 前置 —— **迁移前提的两态与 post-migration 不变量**（共享）。
 *
 * ============================================================================
 *  为什么需要这个文件（用户 2026-09-19 裁定）
 * ============================================================================
 * 有一族门（`prod-copy` / `k16` / `wp3` / `wp5`）的判据曾经是：
 *
 * ```text
 *   在**真实库的副本**上彩排 v6 → v9，验证迁移安全
 * ```
 *
 * 它们的**前提**是"真实库还没迁移"。用户 `D-1 = ②` 授权把真库迁到 v9 之后，
 * 这个前提**不存在了** —— 副本也已经是 v9，"待应用迁移 = 空"，
 * 那几条检测器**正确地**报 `MEASUREMENT INVALID`（AGENTS §6.8）。
 *
 * 用户随后批准了**取代**，并明确一条硬约束：**不得删除保证**。
 * 因此本文件的做法是：
 *
 * ```text
 *   迁移前（副本 = 6）  → 走原来的**彩排**路径（一个字不改）
 *   已应用（副本 ≥ 9）  → 前提不成立 ⇒ 改为断言 **post-migration 不变量**：
 *                          · 既有业务行的**身份摘要**与迁移前的记录逐字相同
 *                          · **0 行**携带伪造归因（`attribution_origin` 全 NULL）
 *   其它（1..5, 7, 8）  → **红**（既不是彩排前提，也不是已应用状态 ⇒ 不认识的处境）
 * ```
 *
 * ⚠️ "rehearsal 的断言"**没有被删掉**：它在迁移前分支里原样存在。
 *    删除它等于删除"下一次若真库还是旧版本时的彩排能力"，那正是要保住的保证。
 *
 * 摘要算法与 `verify-m5.1.1-wp10b-production-copy.ts:222-244` **逐字相同**
 * （身份列 → `String(row[c] ?? '')` → 制表符/换行连接 → sha256）——
 * 口径不同的话，"前后一致"就只是"两个不同的量恰好都没变"。
 */

import { createHash } from 'node:crypto'

import { sql } from 'drizzle-orm'

import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'

/** 迁移链已全部应用时的 schema 版本（0001–0009 的最后一条） */
export const MIGRATION_APPLIED_SCHEMA = 9

export type MigrationPremise = 'pre-migration' | 'already-applied' | 'unrecognized'

export function migrationPremiseOf(version: number, expectedPre = 6): MigrationPremise {
  if (version === expectedPre) return 'pre-migration'
  if (version >= MIGRATION_APPLIED_SCHEMA) return 'already-applied'
  return 'unrecognized'
}

/** WP10-B 记录在案的**迁移前**身份摘要（canonical：真库与它的副本同源） */
export const RECORDED_PRE_MIGRATION_IDENTITY = {
  conversation_events: {
    rows: 28,
    digest: 'd5277b5979060751191672e19feb573a08682ac8ed0153aaea647bc27d2ff1d3',
  },
} as const

interface PostMigrationReading {
  ok: boolean
  detail: string
  rows: number
  digest: string
  rowsWithAttributionOrigin: number
}

/**
 * 在**已迁移**的库（真库或它的副本）上断言 post-migration 不变量。
 *
 * 它承接的正是彩排曾经承接的那个保证："把冻结的迁移链应用到真实数据上，
 * **没有丢数据、没有编来源**"——只是从"事前彩排"改成了"事后核对"。
 */
export async function postMigrationInvariants(
  db: RawDb,
  table = 'conversation_events'
): Promise<PostMigrationReading> {
  const expected = RECORDED_PRE_MIGRATION_IDENTITY[table as 'conversation_events']
  const identityColumns: Record<string, string[]> = {
    conversation_events: ['id', 'conversation_id', 'conversation_sequence', 'type', 'actor_type'],
  }
  const columns = identityColumns[table] ?? ['id']

  const rows = rowsOf(
    await exec(
      db,
      sql.raw(
        `select ${columns.join(', ')} from ${table} order by ${columns.join(', ')}`
      ),
      'post-migration：既有行身份摘要'
    )
  ) as Record<string, unknown>[]
  const digest = createHash('sha256')
    .update(rows.map((row) => columns.map((c) => String(row[c] ?? '')).join('\t')).join('\n'))
    .digest('hex')

  const withOrigin = rowsOf(
    await exec(
      db,
      sql.raw(`select count(*)::int as c from ${table} where attribution_origin is not null`),
      'post-migration：伪造归因计数'
    )
  )[0]?.c

  const rowsOk = expected === undefined || rows.length === expected.rows
  const digestOk = expected === undefined || digest === expected.digest
  const noFabrication = Number(withOrigin ?? 0) === 0
  const ok = rowsOk && digestOk && noFabrication

  return {
    ok,
    rows: rows.length,
    digest,
    rowsWithAttributionOrigin: Number(withOrigin ?? 0),
    detail:
      `${table}: ${rows.length} 行 / ${digest.slice(0, 12)}` +
      `（记录值 ${String(expected?.rows)} 行 / ${String(expected?.digest).slice(0, 12)}）· ` +
      `伪造归因 ${String(withOrigin)} 行`,
  }
}
