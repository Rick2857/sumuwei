/**
 * **S8 / ADR-094 `D03`（裁定 = A）** —— 独立故事水位的 SQL 适配。
 *
 * 纪律（沿用 `story-ledger-store.ts`）：
 * ```text
 * ① 读不写：`readWatermark` 绝不凭空造记录
 * ② 只许前进、不许跳号：判定走**纯函数** `nextStoryWatermark`，本层只负责"照做或具名拒收"
 * ③ 不前进 ⇒ **一个字节都不写**（不是"静默成功"）
 * ④ 并发安全：用条件 UPDATE + `returning` 判"到底有没有动"，**不**用 `on conflict do nothing`
 *    （WP2 的教训：那会让"部分写入"看起来像成功）
 * ```
 */

import { sql } from 'drizzle-orm'

import { STORY_WATERMARK_SCHEMA_VERSION, nextStoryWatermark } from '../../../kernel/storyline/story-watermark.ts'
import type { StoryWatermarkPort } from '../../../kernel/storyline/story-watermark-port.ts'
import type {
  StoryConsumer,
  StoryConsumerWatermark,
  StoryWatermarkAdvance,
} from '../../../kernel/storyline/story-watermark.ts'
import { exec, rowsOf, type RawDb } from '../../persistence/db.ts'

export const STORY_WATERMARK_TABLE = 'storyline_consumer_watermarks'

const recordOf = (row: Record<string, unknown>): StoryConsumerWatermark => {
  const watermark: StoryConsumerWatermark = {
    consumer: String(row.consumer) as StoryConsumer,
    storyId: String(row.story_id),
    runId: String(row.run_id),
    lastConsumedRevision: Number(row.last_consumed_revision),
    consumedAt: Number(row.consumed_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_commit_id === null || row.last_commit_id === undefined
      ? {}
      : { lastCommitId: String(row.last_commit_id) }),
  }
  return watermark
}

export function createStoryWatermarkStore(db: RawDb): StoryWatermarkPort {
  return {
    async readWatermark(input): Promise<StoryConsumerWatermark | undefined> {
      const rows = rowsOf(
        await exec(
          db,
          sql`select consumer, story_id, run_id, last_consumed_revision, last_commit_id, consumed_at, updated_at
              from storyline_consumer_watermarks
              where consumer = ${input.consumer} and story_id = ${input.storyId} and run_id = ${input.runId}`,
          'S8 水位读取（只读）'
        )
      )
      const row = rows[0]
      return row === undefined ? undefined : recordOf(row as Record<string, unknown>)
    },

    async advanceWatermark(input): Promise<StoryWatermarkAdvance> {
      const current = (await this.readWatermark(input))?.lastConsumedRevision ?? 0
      const judged = nextStoryWatermark({ current, attempted: input.revision })
      if (!judged.ok) {
        /* ⚠️ 具名拒收 + **零写入**：不前进 / 跳号都不许落盘 */
        return { advanced: false, reason: judged.reason, current, attempted: input.revision }
      }
      /*
       * 条件写入：`where` 保证"只有在当前水位**确实**还是我们读到的那条时才写"
       * ⇒ 并发下第二个写者会写 0 行，我们据此如实报"没前进"，而不是假装成功。
       */
      const updated = rowsOf(
        await exec(
          db,
          sql`insert into storyline_consumer_watermarks
                (consumer, story_id, run_id, last_consumed_revision, last_commit_id, consumed_at, updated_at, schema_version)
              values (${input.consumer}, ${input.storyId}, ${input.runId}, ${input.revision}, ${input.commitId},
                      ${input.at}, ${input.at}, ${STORY_WATERMARK_SCHEMA_VERSION})
              on conflict (consumer, story_id, run_id) do update
                set last_consumed_revision = excluded.last_consumed_revision,
                    last_commit_id = excluded.last_commit_id,
                    consumed_at = excluded.consumed_at,
                    updated_at = excluded.updated_at,
                    schema_version = excluded.schema_version
                where storyline_consumer_watermarks.last_consumed_revision = ${current}
              returning consumer, story_id, run_id, last_consumed_revision, last_commit_id, consumed_at, updated_at`,
          'S8 水位推进（条件写）'
        )
      )
      const row = updated[0]
      if (row === undefined) {
        /* 并发竞争者先动了 ⇒ 如实报"没前进"（不重试、不覆盖） */
        return { advanced: false, reason: 'story_watermark_not_forward', current, attempted: input.revision }
      }
      return { advanced: true, watermark: recordOf(row as Record<string, unknown>) }
    },

    async listWatermarks(input): Promise<readonly StoryConsumerWatermark[]> {
      const rows = rowsOf(
        await exec(
          db,
          sql`select consumer, story_id, run_id, last_consumed_revision, last_commit_id, consumed_at, updated_at
              from storyline_consumer_watermarks
              where story_id = ${input.storyId} and run_id = ${input.runId}
              order by consumer asc`,
          'S8 水位列举（只读）'
        )
      )
      return rows.map((row) => recordOf(row as Record<string, unknown>))
    },
  }
}
