/**
 * **S8 / `ADR-107` `R-2a′`** —— 故事 run 的**生命周期**（"活跃 run"从账本算出来）。
 *
 * ============================================================================
 *  它补的是什么（`L-S8-30`）
 * ============================================================================
 * `ADR-094` `D02.2①` 要求："该会话存在一个**用户显式开始**的活跃 run（`runId` 由服务端
 * 生成并**持久化**）。**不自动开始任何故事**。" —— 而全仓此前**没有任何调用者**会写第一条提交
 * ⇒ `storyline_commits` 永远 0 行 ⇒ 消费回路每次都是"无可消费项"。
 *
 * ============================================================================
 *  ⚠️ 为什么**不**新增一张 runs 表（`ADR-107` §0.2 的更正）
 * ============================================================================
 * ```text
 * ① 开局**已经**是一条提交：`commitStoryTurn({action:{kind:'start'}})` → `startRun()`
 *    （commit-service.ts:252-281）⇒ `runId` **本来就**持久化在 `storyline_commits.run_id` 里
 * ② "活跃"可以由账本**折出来**：`loadStoryRun()`（:108-136）+ `StorylineState.terminal`
 *    （world-machine.ts:100-101，"终局或退出后为 true"）
 * ③ `D02.4` 是**单用户单 run** ⇒ "该会话的活跃 run" = "该故事**恰好一个非终局 run**"
 *    ⇒ 会话↔run 的绑定**也不需要**第三个位置
 * ⇒ 新增 DDL 买不到任何新东西，却要动冻结的迁移面（`AGENTS §3`）。**故不新增。**
 * ```
 *
 * ============================================================================
 *  🔒 认知完整性审查（`Privileged Cognitive Operation`，`AGENTS §4`）
 * ============================================================================
 * ```text
 * 它改变什么认知？   开启一个故事 run ⇒ 后续用户选择可以被提交 ⇒ 经三个消费者变成
 *                   情绪 / 关系 / 反思状态。**它本身不写任何认知状态**，只写**第一条世界提交**。
 * 有没有绕过放行口？ **没有**：走 `commitStoryTurn()`（唯一落盘入口），
 *                   绑定形状由 `assertStoryCommitBinding()` 失败关闭校验。
 * 为什么是 system？  `STORY_STARTED` **不在** `STORY_USER_CHOICE_EVENT_TYPES` 里
 *                   （story-ledger.ts:147-151）⇒ 声明 `user_choice` 会当场抛错。
 *                   这正好满足 `INV-CI-03`（"维护不得冒充经历"）：**开局不是一次用户选择**。
 *                   字段由**函数签名**强制（本模块只传 system 绑定，不接受任何自报字段）。
 * 失败关闭面？       已有活跃 run ⇒ 拒收；runId 形状非法 ⇒ 在 CLI 解析层拒收；
 *                   重复 start 同一 runId ⇒ 走既有开局的**幂等**路径，不写第二行。
 * 可查 / 可审计？     开局进世界账本（`STORY_STARTED` @ revision 1）；`actor_kind='system'` 如实。
 * 顺序硬约束？       归因（`M5.1-D01 = CLOSED`）早于本入口，满足。
 * ```
 *
 * ⚠️ 纯 app 层：不 import 任何 SQL / 框架 / `node:*`。账本经端口注入。
 */

import type { Timestamp } from '../../contracts/ids.ts'
import type { StoryContentPack } from '../../storyline/story-types.ts'
import type { StoryLedgerPort } from '../../storyline/story-ledger-port.ts'
import type { StoryCommitBinding } from '../../storyline/story-ledger.ts'
import { storyStartIdempotencyKey } from './admin.ts'
import { commitStoryTurn, loadStoryRun } from './commit-service.ts'
import type { StorylineState } from '../../storyline/world-machine.ts'

/**
 * 开局提交的绑定 = **`system`**。
 *
 * ⚠️ 这不是"两可之间挑了一个"：`STORY_STARTED` 不在 `STORY_USER_CHOICE_EVENT_TYPES` 里
 *    （`story-ledger.ts:147-151`），声明 `user_choice` 会被 `assertStoryCommitBinding`
 *    当场抛错（`:167-175`）。所以 `system` 是**唯一合法**的形状，也诚实地表达了
 *    "这不是一次会话里的用户选择"。
 * ⚠️ 因此**不**带 `interactionRef` / `anchorConversationEventId` ——
 *    带了就等于伪造一次真实交互（`system` 分支明确禁止，`:198-207`）。
 */
export const STORY_START_BINDING: StoryCommitBinding = {
  interactionKind: 'system',
  actorKind: 'system',
}

/**
 * **CLI 的会话引用**（`ADR-107` §6.6 复核项 ②）。
 *
 * ```text
 * 单用户 CLI 只有**一条**对话流 ⇒ `cli:<userId>` 是一个**诚实**的会话引用。
 * ```
 * ⚠️ **边界（复核结论，机器判不到，只能登记）**：`ADR-093 D01` 要的 `interactionRef` 是
 *    "**真实**会话 id —— 没有它就无法回答'这是不是两个真实会话'"。
 *    换 HTTP / QQ 等多会话入口时，**那一层**必须提供自己的真实会话 id；
 *    直接复用本函数 = 让两个真实会话在账本里长得**一模一样**（那正是 `D01` 要防的）。
 *    ⇒ 本函数**只**给 CLI 用；名字里带 `cli` 是为了让这种复用一眼可见。
 * ⚠️ 现在**没有**机器判据能挡住"多会话入口偷偷用它" —— 因为多会话入口还不存在，
 *    没有可判的对象。⇒ 这条留作**触发式**复核项（多会话入口落地时必须回答）。
 */
export function cliStoryInteractionRef(userId: string): string {
  return `cli:${userId}`
}

export interface StoryRunStatus {
  readonly runId: string
  readonly commits: number
  /**
   * 折出来的终局标志。`folded === false` 时它**无意义**（见 `folded`）。
   */
  readonly terminal: boolean
  /**
   * 账本**折得出来**吗（revision 连续）。
   *
   * ⚠️ `false` ⇒ 这个 run 的"是否终局"**未知**。**失败关闭**：`activeStoryRunOf` 把它
   *    当作**非终局**（即"可能还活跃"）⇒ 宁可拒绝开新局，也不冒着开第二个 run 的风险。
   *    （"折不出来"与"已结束"在输出上长得一样 —— 那正是要防的一族。）
   */
  readonly folded: boolean
  /** `folded === false` 时的缺口（revision 列表） */
  readonly gaps: readonly number[]
  readonly revision: number
}

/**
 * 某个故事**全部已知 run** 的状态（按 `runId` 升序，与 `listRuns` 同序）。
 *
 * ⚠️ "已知 run"是 `listRuns`（`select distinct run_id from storyline_commits`）给的投影 ——
 *    **还没有任何提交的 run 不在其中**（那种 run 在本设计里不存在：开局即第一条提交）。
 */
export async function storyRunStatusesOf(input: {
  readonly ledger: StoryLedgerPort
  readonly pack: StoryContentPack
}): Promise<readonly StoryRunStatus[]> {
  const runIds = await input.ledger.listRuns(input.pack.storyId)
  const statuses: StoryRunStatus[] = []
  for (const runId of runIds) {
    const loaded = await loadStoryRun({ ledger: input.ledger, pack: input.pack, runId })
    if (loaded.ok) {
      statuses.push({
        runId,
        commits: loaded.commits.length,
        terminal: loaded.state.terminal,
        folded: true,
        gaps: [],
        revision: loaded.revision,
      })
      continue
    }
    const commits = await input.ledger.listCommits({ storyId: input.pack.storyId, runId })
    if (loaded.code === 'story_run_not_started') {
      /* 理论上不会发生（listRuns 就是从提交里取的）——但如实登记，不假装它终局 */
      statuses.push({ runId, commits: 0, terminal: false, folded: false, gaps: [], revision: 0 })
      continue
    }
    const gaps = (loaded.detail.match(/\d+/g) ?? []).map((value) => Number(value)).filter((value) => Number.isInteger(value))
    statuses.push({
      runId,
      commits: commits.length,
      terminal: false,
      folded: false,
      gaps,
      revision: 0,
    })
  }
  return statuses
}

/**
 * 该故事**当前活跃**（或"可能还活跃"）的 run。没有 ⇒ `undefined`。
 *
 * ⚠️ 折不出来的 run 视作"可能还活跃"（见 `StoryRunStatus.folded` 的说明）。
 */
export async function activeStoryRunOf(input: {
  readonly ledger: StoryLedgerPort
  readonly pack: StoryContentPack
}): Promise<StoryRunStatus | undefined> {
  const statuses = await storyRunStatusesOf(input)
  return statuses.find((status) => !status.terminal || !status.folded)
}

export type StoryStartOutcome =
  | {
      readonly ok: true
      readonly runId: string
      readonly commitId: string
      readonly revision: number
      /** `appended` = 这次真的开了局；`already_committed` = 同一 runId 的重复调用（幂等） */
      readonly status: 'appended' | 'already_committed'
      readonly state: StorylineState
    }
  | { readonly ok: false; readonly code: string; readonly detail: string }

/**
 * **显式开始**一次故事 run（走既有开局路径；`ADR-107` `R-2a′`）。
 *
 * 判据顺序（每一步失败都**不**写任何东西）：
 * ```text
 * ① 该故事已有活跃 run 且**不是**本 runId ⇒ 拒收 `story_start_run_already_active`
 *    （`D02.4` 单用户单 run；`ADR-107` `Q6`）
 * ② 否则走 `commitStoryTurn({action:{kind:'start'}})`：开局 + 幂等 + 绑定校验都在那里
 * ```
 * ⚠️ **同一个 runId 重复 start** 是**幂等**的（既有开局那条 idempotencyKey 相同 ⇒
 *    `already_committed`）。想开一次**新**故事必须换一个 `runId` —— runId 是身份，不能复用第二遍。
 */
export async function startStoryRun(input: {
  readonly ledger: StoryLedgerPort
  readonly pack: StoryContentPack
  readonly runId: string
  readonly now: Timestamp
}): Promise<StoryStartOutcome> {
  const active = await activeStoryRunOf({ ledger: input.ledger, pack: input.pack })
  if (active !== undefined && active.runId !== input.runId) {
    return {
      ok: false,
      code: 'story_start_run_already_active',
      detail:
        `故事 ${input.pack.storyId} 已有活跃 run ${active.runId}` +
        `（${String(active.commits)} 条提交${active.folded ? '' : '，**账本有缺口、终局未知**'}）：` +
        'D02.4 是单用户单 run ⇒ 拒绝开第二个（先把它走到终局，或换用它的 runId）',
    }
  }

  const outcome = await commitStoryTurn({
    ledger: input.ledger,
    request: {
      pack: input.pack,
      runId: input.runId,
      binding: STORY_START_BINDING,
      idempotencyKey: storyStartIdempotencyKey(input.runId),
      action: { kind: 'start' },
      now: input.now,
    },
  })
  if (!outcome.ok) return { ok: false, code: outcome.code, detail: outcome.detail }
  return {
    ok: true,
    runId: input.runId,
    commitId: outcome.commit.commitId,
    revision: outcome.commit.revision,
    status: outcome.status,
    state: outcome.state,
  }
}
