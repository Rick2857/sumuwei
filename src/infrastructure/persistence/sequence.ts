/**
 * 序号分配器 —— **可信持久层**。
 *
 * ============================================================================
 *  为什么不能 `SELECT MAX(sequence) + 1`
 * ============================================================================
 * 无事务保护时并发写会撞号，而序号是 Watermark / Replay / 乱序 Worker 判定的
 * **唯一依据**（plan 第 14 节）。撞号意味着"她的一段经历被覆盖"。
 *
 * 做法：`character_sequence_counters` 一行一个角色，用
 * `insert ... on conflict do update set next_sequence = next_sequence + n
 *  returning next_sequence` —— 单条语句、原子、无需读改写。
 *
 * 这条路径同时服务两类序列：
 *   · ConversationEvent 的**角色级全局序号**（跨会话单调）
 *   · DomainEvent 的角色级序号（独立计数器，避免与对话互相干扰）
 * 两者共用一个计数器以保证"角色级单调"这一语义只有一个实现。
 */

import { sql } from 'drizzle-orm'

import { KernelError, type CharacterId } from '../../kernel/contracts/index.ts'
import { exec, type RawDb } from './db.ts'

/** 分配区间 [start, start + count - 1] */
export interface SequenceRange {
  start: number
  end: number
}

/**
 * 原子分配 `count` 个连续序号。
 *
 * 用区间分配而不是"分配一个"，是因为一次交互常常需要同时分配
 * "用户事件 + 助手事件"两个号；区间分配能保证两者严格相邻，
 * 也让 Replay 时"这一对属于同一轮"这一点在数据上可见。
 */
export async function allocateSequenceRange(
  db: RawDb,
  characterId: CharacterId,
  count: number
): Promise<SequenceRange> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new KernelError(
      'validation_error',
      'bad_allocation_count',
      `分配序号的数量必须是 >= 1 的安全整数，收到 ${count}`
    )
  }

  const rows = await exec(
    db,
    sql`insert into character_sequence_counters (character_id, next_sequence)
        values (${characterId}, ${count})
        on conflict (character_id)
          do update set next_sequence = character_sequence_counters.next_sequence + ${count}
        returning next_sequence`,
    '分配角色序号'
  )

  const next = Number(rows[0]?.next_sequence)
  if (!Number.isSafeInteger(next) || next < count) {
    throw new KernelError(
      'persistence_error',
      'sequence_allocation_failed',
      `序号分配返回了非法值：${String(rows[0]?.next_sequence)}`
    )
  }

  return { start: next - count + 1, end: next }
}

/** 分配单个序号（常用简写） */
export async function allocateSequence(
  db: RawDb,
  characterId: CharacterId
): Promise<number> {
  const range = await allocateSequenceRange(db, characterId, 1)
  return range.start
}

/** 只读：下一个将被分配的序号（诊断用，不推进计数器） */
export async function peekNextSequence(
  db: RawDb,
  characterId: CharacterId
): Promise<number> {
  const rows = await exec(
    db,
    sql`select next_sequence from character_sequence_counters where character_id = ${characterId}`,
    '读取序号计数器'
  )
  const next = rows[0]?.next_sequence
  return next === undefined ? 1 : Number(next)
}
