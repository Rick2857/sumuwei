/**
 * **S8 / ADR-094 `D03`（裁定 = A）** —— 独立故事水位的**端口**。
 *
 * 与 `story-ledger-port.ts` 同一条纪律：端口只给形状，实现归基础设施。
 */

import type { StoryConsumer, StoryConsumerWatermark, StoryWatermarkAdvance } from './story-watermark.ts'

export interface StoryWatermarkPort {
  /**
   * 读某消费者在某 run 上的水位。**没有记录**时返回 `undefined`（= 还没消费过，
   * 与"水位 0"是同一语义，但**不**凭空造一条记录 —— 读不写）。
   */
  readWatermark(input: {
    consumer: StoryConsumer
    storyId: string
    runId: string
  }): Promise<StoryConsumerWatermark | undefined>

  /**
   * 推进水位（**只许前进、不许跳号**；见 `nextStoryWatermark`）。
   *
   * ⚠️ 不前进时返回**具名拒收**并且**一个字节都不写**（不是"静默成功"）。
   */
  advanceWatermark(input: {
    consumer: StoryConsumer
    storyId: string
    runId: string
    revision: number
    commitId: string
    at: number
  }): Promise<StoryWatermarkAdvance>

  /** 列出全部消费者在某 run 上的水位（门与对账用） */
  listWatermarks(input: { storyId: string; runId: string }): Promise<readonly StoryConsumerWatermark[]>
}
