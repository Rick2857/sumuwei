/**
 * **S8 / ADR-093 `D13` · ADR-094 `D03`（裁定 = A）** —— 故事消费的**独立水位**。
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 *  `D13` 逐字：**每个消费者各有一条独立的故事水位**，保证"每个已提交的故事结果对每个消费者
 *  **至多一次**已提交影响"。
 *
 *  为什么不能共用一个水位：三个消费者（情绪 / 关系 / 反思）的**推进速度不同**，
 *  且各自的失败是独立的 —— 共用一条水位时，最慢的那个会把其他人挡住，
 *  而最先失败的那个会让别人**跳过**它没消费的部分。
 *
 * ```text
 * 共用水位（错）              独立水位（对）
 * A 消费到 7 ⇒ 水位 7         A 水位 7 · B 水位 5 · C 水位 7
 * B 崩了 ⇒ 6 被跳过           B 重启后从 6 继续；A/C 不受影响
 * ```
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`。
 */

import { KernelError } from '../contracts/ids.ts'

/** `D13` 的消费者闭集（新增消费者 = 改这条 + 迁移里的 CHECK，两者必须同时动） */
export const STORY_CONSUMERS = ['affect', 'relationship', 'reflection'] as const
export type StoryConsumer = (typeof STORY_CONSUMERS)[number]

export const STORY_WATERMARK_SCHEMA_VERSION = 1

export interface StoryConsumerWatermark {
  readonly consumer: StoryConsumer
  readonly storyId: string
  readonly runId: string
  /** 已消费到的**最大 revision**；`0` = 还没消费任何一条 */
  readonly lastConsumedRevision: number
  /** 该 revision 对应的提交身份（审计用；`0` 时为 `undefined`） */
  readonly lastCommitId?: string
  readonly consumedAt: number
  readonly updatedAt: number
}

/** 水位推进的结果（**不**用"静默成功"表示"没动"） */
export type StoryWatermarkAdvance =
  | { readonly advanced: true; readonly watermark: StoryConsumerWatermark }
  /** 目标 revision **不前进** ⇒ 具名拒绝，且**不写任何东西** */
  | { readonly advanced: false; readonly reason: 'story_watermark_not_forward'; readonly current: number; readonly attempted: number }
  /** 跳号：`attempted > current + 1` ⇒ 具名拒绝（吞掉空隙 = 静默丢消费） */
  | { readonly advanced: false; readonly reason: 'story_watermark_gap'; readonly current: number; readonly attempted: number }

/** 水位形状自检（存储层与门都用它，失败关闭） */
export function assertStoryWatermarkWellFormed(watermark: StoryConsumerWatermark): void {
  if (!(STORY_CONSUMERS as readonly string[]).includes(watermark.consumer)) {
    throw new KernelError('validation_error', 'story_watermark_unknown_consumer', `未知消费者：${watermark.consumer}`)
  }
  if (!Number.isInteger(watermark.lastConsumedRevision) || watermark.lastConsumedRevision < 0) {
    throw new KernelError(
      'validation_error',
      'story_watermark_revision_invalid',
      `水位必须是 ≥ 0 的整数，收到 ${String(watermark.lastConsumedRevision)}`
    )
  }
  if (watermark.lastConsumedRevision === 0 && watermark.lastCommitId !== undefined) {
    throw new KernelError('validation_error', 'story_watermark_commit_without_revision', '水位为 0 时不得带提交身份')
  }
}

/**
 * **至多一次**的原语：给定一批已提交与某消费者的水位，返回**该消费者还没消费**的提交。
 *
 * ```text
 * 单调性：只按 revision 升序返回 > 水位的那些
 * 幂等性：同一批 + 同一水位 ⇒ 结果逐字相同（重放不会多消费）
 * 不猜：revision 有空洞时**不**静默跳过 —— 由调用方看到"下一个应消费的 revision"与
 *       实际存在的最大 revision 之间的差，再决定（缺口 = 世界账本不完整，不是消费问题）
 * ```
 */
export function storyCommitsToConsume<T extends { readonly revision: number }>(
  commits: readonly T[],
  watermark: number
): readonly T[] {
  return commits
    .filter((commit) => commit.revision > watermark)
    .slice()
    .sort((left, right) => left.revision - right.revision)
}

/**
 * 推进判定的**纯函数**（存储层照它执行；门照它断言）。
 *
 * ⚠️ **只许前进**：`attempted <= current` ⇒ `story_watermark_not_forward`。
 * ⚠️ **不许跳号**：`attempted > current + 1` ⇒ `story_watermark_gap`
 *    —— 跳号意味着中间那条**永远不会被这个消费者消费**，那正是 `D13` 要防的事。
 *    重放 / 补扫必须**逐条**推进，不能"直接设成最新"。
 */
export function nextStoryWatermark(input: {
  current: number
  attempted: number
}): { readonly ok: true } | { readonly ok: false; readonly reason: 'story_watermark_not_forward' | 'story_watermark_gap' } {
  if (input.attempted <= input.current) return { ok: false, reason: 'story_watermark_not_forward' }
  if (input.attempted > input.current + 1) return { ok: false, reason: 'story_watermark_gap' }
  return { ok: true }
}

/** 供门使用：消费者闭集大小（`measured_count > 0` 的一项） */
export function storyConsumerCount(): number {
  return STORY_CONSUMERS.length
}
