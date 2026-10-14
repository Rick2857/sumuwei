/**
 * Write-Path Scope Labeling —— **新记忆写下来时顺手打上归属标签**（U1 / `ADR-137` 的写侧）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * ```text
 * `ADR-137` 方案 B 把标签放在记录**之外**（表 `record_scope_labels`），并且**不回填**旧记录
 * ⇒ 迁移之后**每一条记录都没有标签**，读面一律走"缺标签 ⇒ 原主人私聊"的保守缺省。
 * 那条缺省是**安全**的，但它是**兜底**，不是**事实**：只要写入侧一直不打标，
 * 归属就永远只是"猜"（而且是偏保守的猜）。
 * 本模块就是那条**写侧**：一次写入成功 ⇒ 用**本轮的作用域**给这条记录打上它的来源域。
 * ```
 *
 * ⚠️ 两条纪律：
 * ```text
 * ① **写一次**：标签由 `labelRecordScope` 写，已存在 ⇒ 不改（披露变更必须是另一个显式动作）
 * ② **没有作用域就不打**（`no_scope` ⇒ 完全 no-op）—— 与"未接线时逐字不变"同一条要求；
 *    绝不为了"有标签"而**编**一个来源域（那是把兜底伪装成事实）
 * ```
 */

import type { RawDb } from '../persistence/db.ts'
import { labelRecordScope } from '../persistence/record-scope-store.ts'
import type { ScopeContext } from '../../kernel/contracts/scope.ts'

/** 写侧标记（进 `labeled_by`；它是"谁写的标签"，不是"谁说的"） */
export const MEMORY_WRITE_PATH_LABELER = 'memory-write-path@1'

export interface LabelWrittenMemoryInput {
  readonly db: RawDb
  /** 本轮作用域；`undefined` ⇒ **不打标**（未接线/身份未贯通） */
  readonly scope: ScopeContext | undefined
  /** 刚写下来的那条记忆（来自 `ExplicitMemoryTurnResult` 的 `written.memoryId`） */
  readonly memoryId: string
  readonly now?: number
}

export type LabelWrittenMemoryOutcome =
  | { readonly labeled: true; readonly reason: 'labeled' }
  | { readonly labeled: false; readonly reason: 'no_scope' | 'already_labeled' | 'empty_memory_id' }

/**
 * 给一条**刚写下**的记忆打上本轮作用域的来源域。
 *
 * 来源域 = 本轮所在的房间（私聊 = 那个人；群 = 那个群）；披露类别恒为 `private_to_origin`
 * （**首版范围**：`ADR-137` `R-WP4-2` 明确不做 `explicit_shared`）。
 */
export async function labelWrittenMemory(input: LabelWrittenMemoryInput): Promise<LabelWrittenMemoryOutcome> {
  if (typeof input.memoryId !== 'string' || input.memoryId.trim() === '') {
    return { labeled: false, reason: 'empty_memory_id' }
  }
  if (input.scope === undefined) {
    return { labeled: false, reason: 'no_scope' }
  }
  const created = await labelRecordScope(input.db, {
    recordKind: 'memory',
    recordId: input.memoryId,
    originRoom: input.scope.room,
    disclosure: 'private_to_origin',
    labeledBy: MEMORY_WRITE_PATH_LABELER,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return created.created ? { labeled: true, reason: 'labeled' } : { labeled: false, reason: 'already_labeled' }
}

export interface LabelReadingMemoriesInput {
  readonly db: RawDb
  readonly scope: ScopeContext | undefined
  /**
   * 后台消费者这一拍**新建**的记忆 id（`AutomaticMemoryReading.createdMemoryIds`）。
   *
   * ⚠️ `undefined` = 这条读数**没有**带 id（老形状 / 别的状态）⇒ **一条都不打**，
   *    而不是"按计数瞎猜" —— 计数不知道是**哪几条**。
   */
  readonly memoryIds: readonly string[] | undefined
  readonly now?: number
}

export interface LabelReadingMemoriesOutcome {
  readonly labeled: number
  readonly alreadyLabeled: number
  readonly skipped: number
  readonly reason: 'labeled' | 'no_scope' | 'no_ids'
}

/**
 * 把**后台消费者一拍**新建的记忆逐条打标（自动记忆 / 后处理记忆两条路径共用）。
 *
 * ⚠️ 没有作用域 ⇒ `skipped = 全部`、`reason = 'no_scope'`（不编来源域）；
 *    读数没带 id ⇒ `reason = 'no_ids'`（**不按计数猜**）。
 */
export async function labelReadingCreatedMemories(
  input: LabelReadingMemoriesInput
): Promise<LabelReadingMemoriesOutcome> {
  const ids = input.memoryIds
  if (ids === undefined || ids.length === 0) {
    return { labeled: 0, alreadyLabeled: 0, skipped: 0, reason: 'no_ids' }
  }
  if (input.scope === undefined) {
    return { labeled: 0, alreadyLabeled: 0, skipped: ids.length, reason: 'no_scope' }
  }
  let labeled = 0
  let alreadyLabeled = 0
  for (const memoryId of ids) {
    const outcome = await labelWrittenMemory({
      db: input.db,
      scope: input.scope,
      memoryId,
      ...(input.now === undefined ? {} : { now: input.now }),
    })
    if (outcome.labeled) labeled += 1
    else if (outcome.reason === 'already_labeled') alreadyLabeled += 1
  }
  return { labeled, alreadyLabeled, skipped: 0, reason: 'labeled' }
}
