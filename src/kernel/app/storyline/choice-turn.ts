/**
 * **S8 / `ADR-107` `R-1b`** —— 一轮里的**剧情选择解析**（私有决策调用 → 世界提交）。
 *
 * ============================================================================
 *  它把四件已经有的东西串成一条**可判定**的链
 * ============================================================================
 * ```text
 * 活跃 run（账本折出来） → 有界输入（frontier 机器键 + 剧情正文） → 私有调用（一次）
 *                        → 闭集判定 → `ingestStoryChoice()`（服务端绑定 + 幂等 + 世界判定）
 * ```
 *
 * ============================================================================
 *  五种结果**分列**（不许合成一个"成功/失败"）
 * ============================================================================
 * ```text
 * ① `disabled`        开关关闭 ⇒ **连端口都不碰**（"没启用"与"拒绝"是两件事）
 * ② `no_active_run`   没有活跃 run ⇒ **一次调用都不发**（`ADR-107` `Q3` 的机器判据）
 *                        ⚠️ 这一条是**省钱的硬闸**：没有它，每轮白付一次模型调用
 * ③ `no_candidates`   当前节点没有声明选择 ⇒ **一次调用都不发**（`choice-input` 的 ok:false）
 * ④ `no_choice`       模型说"用户这轮没做选择" ⇒ **零写入**（一个**结论**，不是失败）
 * ⑤ `committed`       闭集通过 + 世界判定通过 ⇒ 落账本（**服务端绑定**，锚在本轮用户消息上）
 * ⑥ `rejected`        具名拒收（闭集外 / 世界判定拒 / 绑定形状非法）⇒ **零副作用**
 * ⑦ `failed`          具名失败（超时 / 调用失败 / 形状坏）⇒ **零副作用**
 * ```
 *
 * ============================================================================
 *  🔒 认知完整性审查（`Privileged Cognitive Operation`，`AGENTS §4`）
 * ============================================================================
 * ```text
 * 它改变什么认知？   把用户的选择提交成**世界变更** ⇒ 经三个消费者变成情绪 / 关系 / 反思状态。
 * 有没有绕过放行口？ **没有**：走 `ingestStoryChoice()`（`D02` 的既有入口）→ `commitStoryTurn()`。
 * 谁在提案？         **模型**只产出候选机器键；判定在**世界状态机**（`advanceFromProposal`），
 *                    闭集在**草稿契约**（`recognizeStoryChoiceDraft`）。两层各自失败关闭。
 * 为什么能是         `ADR-094` `D02.2④` **冻结**了这条路径的绑定是 `user_choice`
 * `user_choice`？    （锚 = 触发本轮的用户消息）：模型**不是**在替用户选，它是在**解析**
 *                    用户已经用自然语言做出的选择。⚠️ **但解析会错** ⇒ 见下面的边界。
 * 失败关闭面？       无活跃 run / 无候选 ⇒ 不发调用；闭集外 / 世界拒 / 绑定非法 ⇒ 零写入。
 * 可查 / 可审计？     提交进世界账本（`choice_id` 如实落库）；结果码具名返回给调用方记 trace。
 * 顺序硬约束？       归因（`M5.1-D01 = CLOSED`）早于本入口，满足。
 * ```
 *
 * ⚠️ **本条主张的边界（必须与实现同批登记）**：模型**可能把用户没做的选择解析出来**
 *    （"解析错误"），而 `D02.2④` 的绑定是 `user_choice` —— 那是 `ADR-093` `D01` 里
 *    "**唯一**能成为习惯根的形态"。⇒ 这个错误会**冒充一次真实用户选择**。
 *    本模块**不**声称解决了它；缓解只有"闭集 + 世界判定 + 锚定本轮用户消息"，
 *    以及把失败**具名**。⇒ 登记为 `L-S8-31`（见 `ADR-107` §6.4 与登记册）。
 *
 * ⚠️ 纯 app 层：不 import 任何 SQL / 框架 / `node:*` ；账本与端口都注入。
 */

import type { Timestamp } from '../../contracts/ids.ts'
import type { StoryContentPack } from '../../storyline/story-types.ts'
import type { StorylineState } from '../../storyline/world-machine.ts'
import type { StoryLedgerPort } from '../../storyline/story-ledger-port.ts'
import { STORY_CHOICE_PROPOSAL_TYPE } from '../../contracts/story-choice-draft.ts'
import { ingestStoryChoice, type StoryIngestOutcome, type StoryIngestServerContext } from './choice-ingest.ts'
import { buildStoryChoiceInput, buildStoryChoiceUserMessage } from './choice-input.ts'
import { readStoryChoiceDecision, type StoryChoiceDecisionPort } from './choice-decision.ts'
import { activeStoryRunOf } from './run-lifecycle.ts'
import { loadStoryRun } from './commit-service.ts'

/** 私有调用期限的缺省值（有界；调用方按 flag 覆盖） */
export const STORY_CHOICE_DEFAULT_DEADLINE_MS = 8_000

export type StoryChoiceTurnOutcome =  /** 开关关闭 ⇒ 端口都没碰 */
  | { readonly kind: 'disabled' }
  /** 没有活跃（或"可能还活跃"）的 run ⇒ **一次调用都没发** */
  | { readonly kind: 'no_active_run'; readonly detail: string }
  /** 当前节点没有可选分支 ⇒ **一次调用都没发** */
  | { readonly kind: 'no_candidates'; readonly detail: string }
  /** 模型说"本轮用户没做选择" */
  | { readonly kind: 'no_choice'; readonly truncated: readonly string[] }
  /** 闭集 + 世界判定都通过，已落账本 */
  | {
      readonly kind: 'committed'
      readonly runId: string
      readonly commitId: string
      readonly revision: number
      readonly choiceId: string
      readonly proposalType: string
      readonly truncated: readonly string[]
    }
  /** 具名拒收（**零副作用**） */
  | { readonly kind: 'rejected'; readonly code: string; readonly detail: string }
  /** 具名失败（**零副作用**）：超时 / 调用失败 / 形状坏 */
  | { readonly kind: 'failed'; readonly code: string; readonly detail: string }

export interface StoryChoiceTurnInput {
  /** `CHARACTER_STORY_CHOICE_DECISION_ENABLED`（代码缺省 **false**） */
  readonly enabled: boolean
  readonly ledger: StoryLedgerPort
  readonly pack: StoryContentPack
  /** 服务端绑定的可信上下文（**提案与模型都碰不到**） */
  readonly server: StoryIngestServerContext
  readonly currentInput: string
  readonly recentLines: readonly string[]
  /**
   * **可见剧情正文的渲染器**（`R-3`：正文**只能**来自内容资产的渲染器）。
   *
   * ⚠️ 它是**注入**的，不是 import 的：kernel 不许依赖 `src/content/**`。
   *    调用方传 `(state) => renderStoryVisibleEvents(state.visibleEventIds)`。
   * ⚠️ 用回调而不是"先把正文算好再传进来"，是为了**不重复折账本**：
   *    这里已经在第 ③ 步折过一次状态，正文就在那一刻现算。
   */
  readonly narrativeOf: (state: StorylineState) => string
  /**
   * 私有决策端口。**开关关闭时它应当是 `undefined`** ——
   * 那样"会不会发模型请求"在装配层就是显式的（与 `reflectionStep` 的 provider 注入同一条纪律）。
   */
  readonly port?: StoryChoiceDecisionPort
  /**
   * 私有调用的硬期限（毫秒）。缺省 = `STORY_CHOICE_DEFAULT_DEADLINE_MS`。
   * ⚠️ 只有在**开关打开且真的有活跃 run** 时才会被用到；关着的时候它根本不参与。
   */
  readonly deadlineMs?: number
  readonly now: Timestamp
}

/**
 * 跑一轮"选择解析"。
 *
 * ⚠️ **顺序即判据**：开关 → 活跃 run → 候选 → 调用 → 闭集 → 世界提交。
 *    任何一步失败都**不**进入下一步（不发生"先写再判"）。
 */
export async function runStoryChoiceTurn(
  input: StoryChoiceTurnInput,
): Promise<StoryChoiceTurnOutcome> {
  /* ① 开关：关闭 ⇒ 什么都不做（连端口都不问） */
  if (input.enabled !== true) return { kind: 'disabled' }

  /* ② 活跃 run：没有 ⇒ **一次调用都不发**（这是省钱的硬闸，也是 `Q3` 的机器判据） */
  const active = await activeStoryRunOf({ ledger: input.ledger, pack: input.pack })
  if (active === undefined) {
    return {
      kind: 'no_active_run',
      detail: `故事 ${input.pack.storyId} 当前没有活跃 run ⇒ 不发私有决策调用（也不写任何东西）`,
    }
  }

  /* ③ 折出当前状态（frontier 与正文都从**账本**来，不从调用方自报） */
  const loaded = await loadStoryRun({ ledger: input.ledger, pack: input.pack, runId: active.runId })
  if (!loaded.ok) {
    return { kind: 'rejected', code: loaded.code, detail: loaded.detail }
  }
  const node = input.pack.nodes.find((candidate) => candidate.id === loaded.state.currentNodeId)
  if (node === undefined) {
    /* 折出来的节点不在包里 ⇒ 账本与内容包不一致，**具名**拒收（不猜、不回落） */
    return {
      kind: 'rejected',
      code: 'story_choice_node_not_in_pack',
      detail: `折出的当前节点 ${loaded.state.currentNodeId} 不在内容包里（账本与内容包不一致）`,
    }
  }

  const built = buildStoryChoiceInput({
    runId: active.runId,
    currentNodeId: node.id,
    stage: String(loaded.state.stage),
    revision: loaded.state.revision,
    narrative: input.narrativeOf(loaded.state),
    nodeChoices: node.choices,
    currentInput: input.currentInput,
    recentLines: input.recentLines,
  })
  if (!built.ok) return { kind: 'no_candidates', detail: built.detail }

  /* ④ 端口缺失 = 装配层没接（**配置错误**，不是"模型说没有"）⇒ 具名失败，零写入 */
  if (input.port === undefined) {
    return {
      kind: 'failed',
      code: 'story_choice_port_missing',
      detail: '开关已打开且存在活跃 run，但装配层没有注入私有决策端口（配置错误）',
    }
  }

  /* ⑤ 一次调用 + 闭集判定 */
  const reading = await readStoryChoiceDecision(input.port, {
    userMessage: buildStoryChoiceUserMessage(built.input),
    deadlineMs: input.deadlineMs ?? STORY_CHOICE_DEFAULT_DEADLINE_MS,
    candidates: built.input.candidates.map((candidate) => candidate.choiceId),
    /* ⚠️ 逐字引用的包含检查只能对**触发本轮的用户原话**做（`L-S8-31`） */
    userText: built.input.currentInput,
  })
  if (reading.kind === 'none') return { kind: 'no_choice', truncated: built.input.truncated }
  if (reading.kind !== 'proposed') {
    return {
      kind: 'failed',
      code: reading.code === undefined ? `story_choice_${reading.kind}` : `story_choice_${reading.code}`,
      detail: reading.detail,
    }
  }

  /* ⑥ 走**既有**入口（服务端绑定 + 幂等 + 世界判定都在那里） */
  const outcome: StoryIngestOutcome = await ingestStoryChoice({
    enabled: true,
    ledger: input.ledger,
    pack: input.pack,
    server: { ...input.server, runId: active.runId, expectedRevision: loaded.state.revision },
    proposedChoiceId: reading.choiceId,
    now: input.now,
  })
  if (outcome.kind === 'disabled') {
    /* `enabled:true` 传进去了还回 disabled ⇒ 逻辑上不该发生；如实报成失败，不假装成功 */
    return {
      kind: 'failed',
      code: 'story_choice_entry_disabled',
      detail: '入口在 enabled:true 下返回 disabled（不可能的形状，如实登记）',
    }
  }
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', code: outcome.code, detail: outcome.detail }
  }
  return {
    kind: 'committed',
    runId: active.runId,
    commitId: outcome.commitId,
    revision: outcome.revision,
    choiceId: reading.choiceId,
    proposalType: STORY_CHOICE_PROPOSAL_TYPE,
    truncated: built.input.truncated,
  }
}
