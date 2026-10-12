/**
 * **S8 / ADR-093 `D13` · ADR-094 `D03`（裁定 = A）** —— 故事消费回路。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  把"**每个消费者各自**按自己的水位消费已提交的故事结果"这件事写成**一个**可测的回路：
 *
 * ```text
 * for 每个消费者（互相独立）:
 *     待消费 = storyCommitsToConsume(该 run 的全部提交, 该消费者的水位)   // 单调、幂等
 *     for 每条待消费（**按 revision 升序**）:
 *         交给消费者（情绪 / 关系 / 反思）
 *         成功 ⇒ 把水位推到这条的 revision        // 逐条推进 ⇒ 永不跳号
 *         失败 ⇒ **停下这个消费者**，水位**停在原地**  // 下次从同一条继续，不丢也不重复
 * ```
 *
 * ⚠️ **为什么"失败就停"而不是"跳过继续"**：跳过 = 那条**永远不会**被这个消费者消费，
 *    而 `D13` 要求"每个已提交结果对每个消费者**至多一次**"——
 *    "至多一次"允许漏（停住重来），**不允许**跳（永久丢）。
 * ⚠️ **为什么消费者之间互不影响**：这正是 `D13` 要独立水位的原因 ——
 *    关系消费失败不该让情绪也停住（各走各的）。
 * ⚠️ 纯 app 层：不 import 框架 / SQL / `node:*`。
 */

import type { Timestamp } from '../../contracts/ids.ts'
import type { StoryLedgerPort } from '../../storyline/story-ledger-port.ts'
import type { StoryCommitRecord } from '../../storyline/story-ledger.ts'
import { storyCommitsToConsume, type StoryConsumer } from '../../storyline/story-watermark.ts'
import type { StoryWatermarkPort } from '../../storyline/story-watermark-port.ts'

export interface StoryConsumerStep {
  readonly consumer: StoryConsumer
  /**
   * 消费一条已提交的故事结果。
   *
   * ⚠️ 实现方**必须**是幂等的：回路在崩溃后会**从同一条重新开始**
   *    （水位只在成功之后才推进）。幂等单元 = **提交身份**。
   */
  readonly consume: (input: {
    readonly commit: StoryCommitRecord
    readonly commits: readonly StoryCommitRecord[]
    readonly at: Timestamp
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>
}

export interface StoryConsumerProgress {
  readonly consumer: StoryConsumer
  /** 这一次真正消费掉的 revision（升序） */
  readonly consumed: readonly number[]
  /** 消费后的水位（失败时 = 失败前的水位） */
  readonly advancedTo: number
  /** 具名失败（`undefined` = 这一轮全清） */
  readonly failedAt?: { readonly revision: number; readonly code: string }
}

export interface StoryConsumeOutcome {
  readonly progress: readonly StoryConsumerProgress[]
  /** 全部消费者都清空了待消费项 */
  readonly drained: boolean
}

/**
 * 跑一圈消费回路。
 *
 * ⚠️ 本函数**不**决定"要不要消费"（那是开关与调度的事），只保证**按水位、逐条、独立**。
 */
export async function consumeStoryCommits(input: {
  readonly ledger: StoryLedgerPort
  readonly watermarks: StoryWatermarkPort
  readonly storyId: string
  readonly runId: string
  readonly steps: readonly StoryConsumerStep[]
  readonly now: () => Timestamp
}): Promise<StoryConsumeOutcome> {
  const commits = await input.ledger.listCommits({ storyId: input.storyId, runId: input.runId })
  const progress: StoryConsumerProgress[] = []

  for (const step of input.steps) {
    const scope = { consumer: step.consumer, storyId: input.storyId, runId: input.runId }
    const watermark = (await input.watermarks.readWatermark(scope))?.lastConsumedRevision ?? 0
    const pending = storyCommitsToConsume(commits, watermark)
    const consumed: number[] = []
    let advancedTo = watermark
    let failedAt: StoryConsumerProgress['failedAt']

    for (const commit of pending) {
      const at = input.now()
      const outcome = await step.consume({ commit, commits, at })
      if (!outcome.ok) {
        /* 失败 ⇒ **停在这里**，水位不动（下次从同一条继续；不跳过、不重复） */
        failedAt = { revision: commit.revision, code: outcome.code }
        break
      }
      const advanced = await input.watermarks.advanceWatermark({
        ...scope,
        revision: commit.revision,
        commitId: commit.commitId,
        at,
      })
      if (!advanced.advanced) {
        /*
         * 推进被拒（并发竞争者先动了 / 跳号）⇒ 如实停住。
         * ⚠️ **不**重试、**不**覆盖：那是"这一轮没做成"，不是"做成了"。
         */
        failedAt = { revision: commit.revision, code: advanced.reason }
        break
      }
      consumed.push(commit.revision)
      advancedTo = commit.revision
    }

    progress.push({
      consumer: step.consumer,
      consumed,
      advancedTo,
      ...(failedAt === undefined ? {} : { failedAt }),
    })
  }

  return { progress, drained: progress.every((row) => row.failedAt === undefined) }
}
