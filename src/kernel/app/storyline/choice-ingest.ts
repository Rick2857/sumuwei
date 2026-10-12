/**
 * **S8 / ADR-094 `D01` + `D02`** —— 生产故事入口：**提案 → 判定 → 提交**三段分离。
 *
 * ============================================================================
 *  三条硬约束（继承 ADR-091/093，不重开）
 * ============================================================================
 * ```text
 * ① 模型只能**提案**：本函数接受的 `proposedChoiceId` 是 `unknown` —— 它来自模型输出，
 *    不是可信输入。合法性判定归 `commitStoryTurn()`（内部走 `advanceFromProposal`）。
 * ② 绑定字段只能由**服务端**填：`interaction_ref` / `anchor_conversation_event_id` /
 *    `actor_id` 从 `server` 参数来，**不**经过提案那条路 —— 这一点由**函数签名**强制，
 *    不靠运行时检查（提案里根本没有这些字段可填）。
 * ③ 不做词形判据：本函数只看 `choiceId` 是不是合法选择，不看用户说了什么词
 *    （`L-M55-15`：词形判据会误触发）。
 * ```
 *
 * ⚠️ 本函数**不**改回复内容：提交与回复生成解耦。提交失败**不**影响回复；
 *    回复失败**不**回滚提交（ADR-094 `D02.3`）。
 * ⚠️ 纯 app 层：不 import 框架 / SQL / `node:*`。
 */

import type { Timestamp } from '../../contracts/ids.ts'
import type { StoryContentPack } from '../../storyline/story-types.ts'
import type { StoryLedgerPort } from '../../storyline/story-ledger-port.ts'
import { commitStoryTurn } from './commit-service.ts'

/** 服务端填的可信上下文（**提案无法影响**这些值） */
export interface StoryIngestServerContext {
  readonly runId: string
  /** 触发本轮的那条用户消息事件 id（服务端）—— 它同时是因果身份键与 `primary_source_event_id` 的来源 */
  readonly anchorConversationEventId: string
  /** 该会话 id（服务端） */
  readonly interactionRef: string
  readonly actorId: string
  /** 服务端读出的当前 revision（不读提案里的值） */
  readonly expectedRevision: number
}

export type StoryIngestOutcome =
  /** 开关关闭 ⇒ **什么都没做**（不是"拒收"：没启用与拒绝是两件事） */
  | { readonly kind: 'disabled' }
  /** 已提交（含幂等命中：同一次选择重复投递不会二次提交） */
  | { readonly kind: 'committed'; readonly commitId: string; readonly revision: number }
  /**
   * 具名拒收。`code` 来自世界判定或账本（`story_unknown_choice` / `story_stale_revision` /
   * `story_version_mismatch` / `story_run_is_terminal` / `story_choice_proposal_malformed` …）。
   * ⚠️ 拒收 ⇒ **零副作用**。
   */
  | { readonly kind: 'rejected'; readonly code: string; readonly detail: string }

/**
 * 幂等键由**服务端**拼：`story-commit:<runId>:r<revision>:<anchorEventId>`。
 *
 * ⚠️ anchor 进键是必要的：同一 run 的同一 revision 若被**两次不同的**真实选择触发，
 *    那是需要人工看的异常，不能靠幂等键把它们合并成一条。
 */
export function storyIngestIdempotencyKey(input: {
  runId: string
  revision: number
  anchorConversationEventId: string
}): string {
  return `story-commit:${input.runId}:r${String(input.revision)}:${input.anchorConversationEventId}`
}

export async function ingestStoryChoice(input: {
  /** `CHARACTER_STORY_COGNITION_ENABLED`（ADR-094 `D01`；代码缺省 false） */
  readonly enabled: boolean
  readonly ledger: StoryLedgerPort
  readonly pack: StoryContentPack
  readonly server: StoryIngestServerContext
  /** 模型提案（**不可信**）：必须是字符串；其余交给世界判定 */
  readonly proposedChoiceId: unknown
  readonly now: Timestamp
}): Promise<StoryIngestOutcome> {
  /* ① 开关：关着就**什么都不做**（不读库、不判定、不写） */
  if (input.enabled !== true) return { kind: 'disabled' }

  /* ② 提案**形状**检查（只查"是不是一个非空字符串"，合法性归世界判定） */
  if (typeof input.proposedChoiceId !== 'string' || input.proposedChoiceId.trim() === '') {
    return {
      kind: 'rejected',
      code: 'story_choice_proposal_malformed',
      detail: `模型提案不是一个非空的 choiceId：${JSON.stringify(input.proposedChoiceId)}`,
    }
  }

  /* ③ 判定 + 提交（一次调用完成；幂等由服务端键兜底） */
  const outcome = await commitStoryTurn({
    ledger: input.ledger,
    request: {
      pack: input.pack,
      runId: input.server.runId,
      binding: {
        interactionKind: 'user_choice',
        interactionRef: input.server.interactionRef,
        anchorConversationEventId: input.server.anchorConversationEventId,
        actorKind: 'user',
        actorId: input.server.actorId,
      },
      idempotencyKey: storyIngestIdempotencyKey({
        runId: input.server.runId,
        revision: input.server.expectedRevision,
        anchorConversationEventId: input.server.anchorConversationEventId,
      }),
      action: {
        kind: 'choice',
        choiceId: input.proposedChoiceId,
        expectedRevision: input.server.expectedRevision,
      },
      /*
       * ⚠️ **模型连"我基于哪一版剧情"都不许声明**：`commitStoryTurn` 内部用
       *    `pack.storyVersion` 填 `expectedStoryVersion`（服务端权威），
       *    提案里那个字段**根本进不来** —— 比"检查它是否相符"更强的失败关闭。
       */
      now: input.now,
    },
  })

  if (!outcome.ok) {
    /* 具名拒收：码与详情逐字来自世界判定 / 账本，**不**在这里改写 */
    return { kind: 'rejected', code: String(outcome.code), detail: String(outcome.detail ?? '') }
  }
  const commit = (outcome as { commit?: { commitId?: unknown; revision?: unknown } }).commit
  return {
    kind: 'committed',
    commitId: String(commit?.commitId ?? ''),
    revision: Number(commit?.revision ?? 0),
  }
}
