/**
 * M10.1 WP2b —— **约定窗口的输入源**（慢路径从哪里读）。
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ```text
 * ① **有界**：只读 `[from, to]` 区间里**最近** `limit` 条（上限由调用方给，
 *    `AGREEMENT_MAX_WINDOW_INPUTS`）。**窗口截断**这件事由装配层如实报出（`windowTruncated`）。
 * ② **遮蔽先于注入**：被撤销（遗忘 / 更正）的正文在这里就换成 `AGREEMENT_MASKED_TEXT`
 *    并标 `contentUnavailable` —— 与聊天链的 `maskWithdrawnLines` 同一条纪律（D16/D18）。
 *    ⚠️ 不在这里判"该不该遮蔽"，只**执行**调用方给的撤销集（判定在 M9.1 的读侧）。
 * ③ **只认 用户 / 角色 两类**：别的（system / tool）由装配层丢弃 —— 这里照旧只做搬运。
 * ```
 */

import { sql } from 'drizzle-orm'

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import type { AgreementRawEntry } from '../../kernel/app/agreement/inputs.ts'
import { exec } from './db.ts'
import type { RawDb } from './db.ts'

/** 账本里**角色级**最大事件序号（水位语义："账本里 ≤ N 的事件都已处理"） */
export async function latestAgreementSequence(
  db: RawDb,
  characterId: CharacterId
): Promise<number> {
  const rows = await exec(
    db,
    sql`select coalesce(max(sequence), 0) as v from conversation_events
        where character_id = ${characterId}`,
    '读取约定窗口的账本边界'
  )
  return Number(rows[0]?.v ?? 0)
}

interface WindowRow {
  id: string
  actor_type: string
  sequence: number | string
  content: string | null
}

/**
 * 读一段**有界**窗口（`sequence ∈ [from, to]`；按序号升序；**取最近 limit 条**）。
 *
 * ⚠️ **"取最近 limit 条"必须在有界化之前**（与装配层同一条理由）：先截断再取最近，
 *    会让长正文把窗口挤空、读数失真。本读法：**倒序取 limit 条 → 再升序归还**。
 */
export async function readAgreementWindowEntries(
  db: RawDb,
  characterId: CharacterId,
  fromSequence: number,
  toSequence: number,
  limit: number,
  withdrawnEventIds: ReadonlySet<string>
): Promise<readonly AgreementRawEntry[]> {
  const rows = await exec(
    db,
    sql`select id, actor_type, sequence, content from conversation_events
        where character_id = ${characterId}
          and sequence >= ${fromSequence}
          and sequence <= ${toSequence}
          and actor_type in ('user', 'character', 'assistant')
        order by sequence desc
        limit ${Math.max(1, Math.min(1000, Math.floor(limit)))}`,
    '读取约定窗口事件'
  )
  const ordered = (rows as unknown as WindowRow[]).slice().reverse()
  return ordered.map((row): AgreementRawEntry => {
    const text = row.content ?? ''
    const forgotten = withdrawnEventIds.has(String(row.id))
    return {
      id: String(row.id),
      actorType: String(row.actor_type),
      sequence: Number(row.sequence),
      text: forgotten ? '' : text,
      /* 撤销 ⇒ 正文不可用 ⇒ 装配层换占位并标 `masked`（**不**把被忘的内容送进模型） */
      ...(forgotten || text.trim() === '' ? { contentUnavailable: true } : {}),
    }
  })
}
