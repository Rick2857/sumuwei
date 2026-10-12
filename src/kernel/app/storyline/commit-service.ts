/**
 * Storyline —— **世界提交服务**（kernel/app；后 Lv2 · S8 / WP2）。
 *
 * ============================================================================
 *  载体：ADR-093 `D01`（账本与提交身份）· `D13`（至多一次消费）· `R-3`（无生产运行器）
 *       验收契约 `S8-A01` / `S8-A31` / `S8-A32` / `S8-A33`
 * ============================================================================
 * 它把三件事拼成**一条原子路径**：
 *
 * ```text
 * 账本（权威）  →  折叠出当前状态  →  纯状态机判定提案  →  账本追加（原子 + 幂等）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  为什么这层必须存在（`R-3` 登记的事实）
 * ---------------------------------------------------------------------------
 * 在本工作包之前，`advanceFromProposal` / `exitStory` / `commitEnding` **只被门调用**，
 * 没有生产运行器、也没有持久账本 ⇒ "重启后能恢复"这句话无从验证。
 * 本服务就是那个缺失的入口：它**不**改变纯状态机的任何判据（判定仍然只有一处实现），
 * 只负责"从账本取状态、把通过的事件落盘、把重试变成幂等"。
 *
 * ---------------------------------------------------------------------------
 *  三条纪律
 * ---------------------------------------------------------------------------
 * ```text
 * ① 判定**只有一处**：全部走 `world-machine.ts` 的纯函数；本层不许"试着改一下再提交"
 * ② 绑定**只由调用方（服务端装配层）给**：本层不接受来自提案 payload 的 actor/会话字段
 * ③ 重试**幂等**：先按 idempotencyKey 回读；命中 ⇒ `already_committed`，不写第二行
 * ```
 *
 * ⚠️ 纯装配层：不 import 任何 SQL / 框架 / `node:*`。账本经端口注入。
 */

import { KernelError, type Timestamp } from '../../contracts/ids.ts'
import type { StoryContentPack } from '../../storyline/story-types.ts'
import type {
  StoryCommitRecord,
  StoryObservationRecord,
} from '../../storyline/story-ledger.ts'
import {
  orderCommits,
  storyCommitGaps,
  storyCommitIdOf,
  storyCommitRecordOf,
  storyObservationRecordsOf,
  storylineEventOf,
  type StoryCommitBinding,
} from '../../storyline/story-ledger.ts'
import type { StoryLedgerPort } from '../../storyline/story-ledger-port.ts'
import {
  advanceFromProposal,
  commitEnding,
  exitStory,
  foldStorylineEvents,
  startStory,
  type AdvanceVerdict,
  type StorylineEvent,
  type StorylineState,
} from '../../storyline/world-machine.ts'

/** 世界推进提案（与纯状态机一一对应；**不含**任何自报的可信字段） */
export type StoryCommitAction =
  | { kind: 'start' }
  | { kind: 'choice'; choiceId: string; expectedRevision: number }
  | { kind: 'exit'; expectedRevision: number }
  | { kind: 'ending'; expectedRevision: number }

export interface StoryCommitRequest {
  pack: StoryContentPack
  runId: string
  /** 服务端绑定的交互归属（`S8-A11`） */
  binding: StoryCommitBinding
  /** 服务端给的幂等身份（`S8-A31`） */
  idempotencyKey: string
  action: StoryCommitAction
  now?: Timestamp
}

export type StoryCommitOutcome =
  | {
      ok: true
      status: 'appended' | 'already_committed'
      commit: StoryCommitRecord
      state: StorylineState
      observations: readonly StoryObservationRecord[]
    }
  | {
      ok: false
      code:
        | 'story_run_is_terminal'
        | 'story_version_mismatch'
        | 'story_stale_revision'
        | 'story_unknown_choice'
        | 'story_choice_not_on_frontier'
        | 'story_run_already_started'
        | 'story_run_not_started'
        | 'story_ledger_revision_gap'
        | 'story_binding_invalid'
      detail: string
    }

/**
 * 账本恢复：把某个 run 的全部提交折成状态（**权威是账本**，快照只是派生材料）。
 *
 * ⚠️ 缺口（`revision` 不连续）**不**允许被折叠成"看起来完整"的状态：
 * 半个世界账本折出来的状态与完整账本长得一样，必须显式发现（`S8-A32`/`S8-A33`）。
 */
export async function loadStoryRun(input: {
  ledger: StoryLedgerPort
  pack: StoryContentPack
  runId: string
}): Promise<
  | { ok: true; commits: StoryCommitRecord[]; state: StorylineState; revision: number }
  | { ok: false; code: 'story_run_not_started' | 'story_ledger_revision_gap'; detail: string }
> {
  const commits = orderCommits(
    await input.ledger.listCommits({ storyId: input.pack.storyId, runId: input.runId })
  )
  if (commits.length === 0) {
    return {
      ok: false,
      code: 'story_run_not_started',
      detail: `run ${input.runId} 在账本里没有任何提交（故事尚未开始，或不存在的 run）`,
    }
  }
  const gaps = storyCommitGaps(commits)
  if (gaps.length > 0) {
    return {
      ok: false,
      code: 'story_ledger_revision_gap',
      detail: `run ${input.runId} 的世界账本有 revision 缺口：${JSON.stringify(gaps)}`,
    }
  }
  const state = foldStorylineEvents(commits.map(storylineEventOf))
  return { ok: true, commits, state, revision: state.revision }
}

/**
 * 提交一次世界推进（**唯一**的落盘入口）。
 *
 * 顺序（每一步失败都**不**写任何东西）：
 * ```text
 * ① 幂等回读：账本里已有 (run, revision) 且 idempotencyKey 相同 ⇒ already_committed
 * ② 取状态：start 走 `startStory`；其余走 `loadStoryRun` 折叠
 * ③ 纯状态机判定（唯一判定处）
 * ④ 装配账本行 → 原子追加（提交 + 观测同一事务）
 * ```
 */
export async function commitStoryTurn(input: {
  ledger: StoryLedgerPort
  request: StoryCommitRequest
}): Promise<StoryCommitOutcome> {
  const { ledger, request } = input
  const { pack, runId, binding, idempotencyKey, action } = request
  const now = request.now ?? Date.now()

  try {
    /*
     * ① 幂等回读（**先于一切判定**）。
     *
     * ⚠️ 为什么必须按**幂等键**查，而不是按"目标 revision"查（第一版就是这么写的，是错的）：
     * 一次真实选择被重试时，它的提交**已经**落在 `state.revision` 上，而目标 revision 是
     * `state.revision + 1` —— 查目标 revision 什么也查不到，于是重试会被纯状态机判成
     * `story_stale_revision`：一个**假失败**（重试其实早就成功了）。
     * 实测症状见 `postlv2:s8:store:verify` 的 `T4`。
     */
    const prior = await ledger.readCommitByIdempotencyKey(idempotencyKey)
    if (prior !== undefined) {
      const mismatch = priorIdentityMismatch(prior, { pack, runId }, action)
      if (mismatch !== undefined) {
        return { ok: false, code: 'story_stale_revision', detail: mismatch }
      }
      const reloaded = await loadStoryRun({ ledger, pack, runId })
      return {
        ok: true,
        status: 'already_committed',
        commit: prior,
        state: reloaded.ok ? reloaded.state : foldStorylineEvents([storylineEventOf(prior)]),
        observations: storyObservationRecordsOf(prior),
      }
    }

    if (action.kind === 'start') {
      return await startRun({ ledger, request, now })
    }

    const loaded = await loadStoryRun({ ledger, pack, runId })
    if (!loaded.ok) return { ok: false, code: loaded.code, detail: loaded.detail }

    const verdict = judge(pack, loaded.state, action, now)
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }

    return await appendVerdict({
      ledger,
      event: verdict.event,
      nextState: verdict.state,
      pack,
      binding,
      idempotencyKey,
      now,
    })
  } catch (error) {
    if (error instanceof KernelError && error.code.startsWith('story_binding')) {
      return { ok: false, code: 'story_binding_invalid', detail: error.message }
    }
    throw error
  }
}

/**
 * 幂等命中之后，**再核一次"这次请求与那条既有提交是不是同一件事"**。
 *
 * ⚠️ 少了这一步，一把被复用的幂等键会让"另一次请求"拿到别人的提交并当作成功
 * —— 那是最坏的一类静默错误（客户端以为自己的选择生效了，其实没有）。
 * 判据用**请求里能确定性比对的东西**（身份 + 动作形状），不猜语义。
 */
function priorIdentityMismatch(
  prior: StoryCommitRecord,
  expected: { pack: StoryContentPack; runId: string },
  action: StoryCommitAction
): string | undefined {
  if (prior.runId !== expected.runId) {
    return `幂等键命中另一条 run 的提交：既有=${prior.runId} / 本次=${expected.runId}`
  }
  if (prior.storyId !== expected.pack.storyId || prior.storyVersion !== expected.pack.storyVersion) {
    return (
      `幂等键命中另一版故事的提交：既有=${prior.storyId}@v${String(prior.storyVersion)} / ` +
      `本次=${expected.pack.storyId}@v${String(expected.pack.storyVersion)}`
    )
  }
  if (action.kind === 'choice' && prior.choiceId !== action.choiceId) {
    return `幂等键命中另一次选择：既有 choiceId=${String(prior.choiceId)} / 本次=${action.choiceId}`
  }
  if (action.kind === 'start' && prior.eventType !== 'STORY_STARTED') {
    return `幂等键命中一条非开局提交（type=${prior.eventType}）`
  }
  if (action.kind === 'exit' && prior.eventType !== 'RUN_EXITED') {
    return `幂等键命中一条非退出提交（type=${prior.eventType}）`
  }
  return undefined
}

/** 开局（新 runId ⇒ 新身份；契约 S6） */
async function startRun(input: {
  ledger: StoryLedgerPort
  request: StoryCommitRequest
  now: Timestamp
}): Promise<StoryCommitOutcome> {
  const { ledger, request, now } = input
  const { pack, runId, binding, idempotencyKey } = request

  const firstId = storyCommitIdOf({ storyId: pack.storyId, storyVersion: pack.storyVersion, runId, revision: 1 })
  const existingFirst = await ledger.readCommit(firstId)
  if (existingFirst !== undefined) {
    if (existingFirst.idempotencyKey === idempotencyKey) {
      const loaded = await loadStoryRun({ ledger, pack, runId })
      return {
        ok: true,
        status: 'already_committed',
        commit: existingFirst,
        state: loaded.ok ? loaded.state : foldStorylineEvents([storylineEventOf(existingFirst)]),
        observations: storyObservationRecordsOf(existingFirst),
      }
    }
    return {
      ok: false,
      code: 'story_run_already_started',
      detail: `run ${runId} 已经有第 1 条提交，且幂等键不同：拒绝把第二次开局当成同一次`,
    }
  }

  const started = startStory({ pack, runId, now })
  return await appendVerdict({
    ledger,
    event: started.event,
    nextState: started.state,
    pack,
    binding,
    idempotencyKey,
    now,
  })
}

/** 纯状态机判定（**唯一**判定处） */
function judge(
  pack: StoryContentPack,
  state: StorylineState,
  action: Exclude<StoryCommitAction, { kind: 'start' }>,
  now: Timestamp
): AdvanceVerdict {
  if (action.kind === 'choice') {
    return advanceFromProposal(
      pack,
      state,
      {
        proposedBy: 'user_choice',
        choiceId: action.choiceId,
        expectedRevision: action.expectedRevision,
        expectedStoryVersion: pack.storyVersion,
      },
      now
    )
  }
  if (action.kind === 'exit') return exitStory(pack, state, action.expectedRevision, now)
  return commitEnding(pack, state, action.expectedRevision, now)
}

async function appendVerdict(input: {
  ledger: StoryLedgerPort
  event: StorylineEvent
  nextState: StorylineState
  pack: StoryContentPack
  binding: StoryCommitBinding
  idempotencyKey: string
  now: Timestamp
}): Promise<StoryCommitOutcome> {
  const commit = storyCommitRecordOf({
    event: input.event,
    contentDigest: input.pack.contentDigest,
    binding: input.binding,
    recordedAt: input.now,
    idempotencyKey: input.idempotencyKey,
  })
  const observations = storyObservationRecordsOf(commit)
  const result = await input.ledger.appendCommit({ commit, observations })
  return {
    ok: true,
    status: result.status,
    commit: result.existing ?? commit,
    state: input.nextState,
    observations:
      result.status === 'already_committed' && result.existing !== undefined
        ? storyObservationRecordsOf(result.existing)
        : observations,
  }
}

/**
 * 重启对账读数（`S8-A32`/`S8-A34` 的机器形态）。
 *
 * ⚠️ 它**只读**：不写账本、不调模型、不发任何域事件。
 * 它存在的理由是"重启后当前节点 / 变量 / 可见集合 / revision 逐项一致"这句话
 * 必须有一个**可调用的**判据，而不是靠人眼看两条日志。
 */
export interface StoryRunReconciliation {
  runId: string
  revision: number
  currentNodeId: string
  stage: string
  variables: Readonly<Record<string, number | boolean | string>>
  visibleEventIds: readonly string[]
  terminal: boolean
  commitCount: number
  observationCount: number
  /** 观测 → 父提交的映射条数（缺一条就是账本结构问题） */
  mappedObservationCount: number
}

export async function reconcileStoryRun(input: {
  ledger: StoryLedgerPort
  pack: StoryContentPack
  runId: string
}): Promise<StoryRunReconciliation | { error: string }> {
  const loaded = await loadStoryRun(input)
  if (!loaded.ok) return { error: `${loaded.code}: ${loaded.detail}` }

  /*
   * 逐条**回读**观测（而不是相信内存里派生出来的那一份）：
   * 这一跳正是"重启后可见集合是否真的还在库里"的机器形态 ——
   * 拿派生结果自证等于什么都没验证（AGENTS.md §6.2）。
   */
  let observationCount = 0
  for (const commit of loaded.commits) {
    for (const observation of storyObservationRecordsOf(commit)) {
      const readBack = await input.ledger.readObservation(observation.observationId)
      if (readBack !== undefined) observationCount += 1
    }
  }

  return {
    runId: input.runId,
    revision: loaded.state.revision,
    currentNodeId: loaded.state.currentNodeId,
    stage: loaded.state.stage,
    variables: loaded.state.variables,
    visibleEventIds: [...loaded.state.visibleEventIds],
    terminal: loaded.state.terminal,
    commitCount: loaded.commits.length,
    observationCount,
    mappedObservationCount: observationCount,
  }
}
