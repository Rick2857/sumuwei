/**
 * Storyline —— **持久世界账本的端口**（后 Lv2 · S8 / WP2）。
 *
 * ============================================================================
 *  载体：ADR-093 `D01` · `D13`（消费一致性）· 验收契约 `S8-A02` / `S8-A31` / `S8-A32`
 * ============================================================================
 * Kernel 只能看见这个接口；SQL 在 `src/infrastructure/storyline/store/**`。
 * 这样依赖方向仍是 `infrastructure → domain`（AGENTS.md §2）。
 *
 * ---------------------------------------------------------------------------
 *  三条端口纪律
 * ---------------------------------------------------------------------------
 * ```text
 * ① `appendCommit` 是**幂等**的：同 (storyId, storyVersion, runId, revision) 重复追加
 *    ⇒ 返回 `already_committed` + 既有行，**不抛错、不写第二行**（S8-A31）
 * ② 提交与它的观测在**同一事务**里落盘（要么都在，要么都不在）—— 不许有"半条世界记录"
 * ③ 读口对**不存在**的 id 返回 `undefined`（绝不编造），由调用方按失败关闭处理
 * ```
 */

import type { StoryCommitRecord, StoryObservationRecord } from './story-ledger.ts'

export interface StoryCommitAppendInput {
  commit: StoryCommitRecord
  /** 本次提交新引入的可见条目（由 `storyObservationRecordsOf` 派生） */
  observations: readonly StoryObservationRecord[]
}

export interface StoryCommitAppendResult {
  status: 'appended' | 'already_committed'
  commitId: string
  /** 本次实际写入的观测 id（`already_committed` 时为既有集合） */
  observationIds: readonly string[]
  /** `already_committed` 时给出现有行的原样读数（供恢复对账，**不是**新写的内容） */
  existing?: StoryCommitRecord
}

export interface StoryLedgerPort {
  /**
   * 原子追加一条提交及其新可见观测。
   *
   * ⚠️ 幂等判据是**两条唯一约束**：`(storyId, storyVersion, runId, revision)` 与
   * `idempotencyKey`。命中任一条 ⇒ `already_committed`（既有行原样返回）。
   */
  appendCommit(input: StoryCommitAppendInput): Promise<StoryCommitAppendResult>

  /** 按提交身份读一行（不存在 ⇒ `undefined`） */
  readCommit(commitId: string): Promise<StoryCommitRecord | undefined>

  /**
   * 按**幂等键**读一行（不存在 ⇒ `undefined`）。
   *
   * ⚠️ 重试判定的**唯一正确入口**：重试可能发生在任意 revision 上
   * （"上一次提交成功了但客户端没收到"），因此不能靠"目标 revision 上有没有行"来判断。
   * 与 `findDomainEventByIdempotencyKey` 同一条纪律。
   */
  readCommitByIdempotencyKey(idempotencyKey: string): Promise<StoryCommitRecord | undefined>

  /** 按观测 id 读"它属于哪次提交"（不存在 ⇒ `undefined` ⇒ 调用方按 `story_root_unconfirmed` 拒收） */
  readObservation(observationId: string): Promise<StoryObservationRecord | undefined>

  /** 某个 run 的全部提交（按 revision 升序） */
  listCommits(input: { storyId: string; runId: string }): Promise<readonly StoryCommitRecord[]>

  /** 某个故事的已知 run（升序，稳定） */
  listRuns(storyId: string): Promise<readonly string[]>

  /** 某个 run 的当前最高 revision（无提交 ⇒ 0） */
  latestRevision(input: { storyId: string; storyVersion: number; runId: string }): Promise<number>
}
