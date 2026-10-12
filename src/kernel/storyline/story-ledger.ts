/**
 * Storyline —— **持久世界账本的纯契约与派生**（后 Lv2 · S8 / WP2）。
 *
 * ============================================================================
 *  载体：ADR-093 `D01`（世界账本与观测身份）· `D05`（因果去重键，含 `R-4`）
 *        · `D06`（真实会话映射）· `D15`（迁移取号纪律）
 *        验收契约 `S8-A01` / `S8-A02` / `S8-A03` / `S8-A11` / `S8-A14`
 * ============================================================================
 * 这个模块是**纯契约 + 纯函数**：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 * 真正的落盘在 `src/infrastructure/storyline/store/**`，Kernel 只经端口取数。
 *
 * ---------------------------------------------------------------------------
 *  它守的四条线（每条都有负控）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 提交身份**确定性**：story:<storyId>@v<ver>#<runId>.e<revision>
 * ② 一次提交的 N 个可见条目只产出 N 条观测，它们**全部**指向**同一条**父提交
 *    ⇒ 根数不会因为"条目多"而变多（ADR-093 D01 / S8-A03）
 * ③ 可信字段（interactionKind / interactionRef / actor）**只能由服务端给**，
 *    且形状非法时**当场拒收**（S8-A11）—— 这个模块不认识任何"调用方自报"的路径
 * ④ 因果身份键落在**真实触发对话事件**上（`D05` 的 `R-4`）⇒ 同一次选择的
 *    对话根与故事根**同键**，`S8-C02` 构造上成立
 * ```
 */

import { KernelError, type Timestamp } from '../contracts/ids.ts'
import { makeStorySourceId, parseStorySourceId } from './story-types.ts'
import type { StorylineEvent, StoryVariableValues } from './world-machine.ts'
import type { StoryEndingId, StorylineEventType, StoryStageId } from './story-types.ts'

/** 账本 schema 版本（进行；将来形状变化时靠它分辨"当时写的是什么"） */
export const STORY_LEDGER_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// 提交身份
// ---------------------------------------------------------------------------

/** 提交身份的四个分量 */
export interface StoryCommitIdentity {
  storyId: string
  storyVersion: number
  runId: string
  revision: number
}

/**
 * 提交身份（**确定性**）。
 *
 * 形如 `story:<storyId>@v<storyVersion>#<runId>.e<revision>`。
 *
 * ⚠️ 它与观测身份**共用同一套语法**（`makeStorySourceId`），区别只在 `eventId` 这一格：
 * 提交用 `e<revision>`（`StorylineEvent.eventId` 的原样），观测用作者定义的条目名。
 * 复用同一个构造函数（而不是自己拼字符串）是为了让"可解析"这件事**只有一处实现**。
 */
export function storyCommitIdOf(identity: StoryCommitIdentity): string {
  if (!Number.isSafeInteger(identity.revision) || identity.revision < 1) {
    throw new KernelError(
      'validation_error',
      'bad_story_revision',
      `revision 必须是 >= 1 的安全整数，收到 ${String(identity.revision)}`
    )
  }
  return makeStorySourceId({
    storyId: identity.storyId,
    storyVersion: identity.storyVersion,
    runId: identity.runId,
    eventId: `e${identity.revision}`,
  })
}

/** 从提交身份 id 读回四个分量；不是提交形状（例如观测 id）时返回 `undefined` */
export function parseStoryCommitId(value: string): StoryCommitIdentity | undefined {
  const parsed = parseStorySourceId(value)
  if (!parsed) return undefined
  const match = /^e(\d{1,9})$/.exec(parsed.eventId)
  if (!match) return undefined
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined
  return {
    storyId: parsed.storyId,
    storyVersion: parsed.storyVersion,
    runId: parsed.runId,
    revision,
  }
}

export function isStoryCommitId(value: unknown): value is string {
  return typeof value === 'string' && parseStoryCommitId(value) !== undefined
}

/**
 * 读回自检（`S8-A01`）：`id → 分量 → id` 必须逐字回到原样。
 *
 * ⚠️ 只做单向解析是不够的：`e007` 能解析成 revision 7，但 `storyCommitIdOf` 产出的
 * 是 `e7` ⇒ 两个字符串指向同一条提交。凡是"从库里读出来的 id"都要过这一关。
 */
export function assertStoryCommitIdReadback(commitId: string): StoryCommitIdentity {
  const identity = parseStoryCommitId(commitId)
  if (!identity) {
    throw new KernelError(
      'validation_error',
      'bad_story_commit_id',
      `提交身份不可解析：${JSON.stringify(commitId)}（形状应为 story:<storyId>@v<n>#<runId>.e<revision>）`
    )
  }
  if (storyCommitIdOf(identity) !== commitId) {
    throw new KernelError(
      'validation_error',
      'story_commit_id_not_canonical',
      `提交身份不是规范形：读回得到 ${storyCommitIdOf(identity)}，原文是 ${commitId}`
    )
  }
  return identity
}

// ---------------------------------------------------------------------------
// 可信绑定（**只能由服务端给**）
// ---------------------------------------------------------------------------

/**
 * 一次提交的**交互归属**。
 *
 * ⚠️ 这个类型里**没有**"调用方说自己是谁"的位置：`actorKind` / `interactionRef` /
 * `anchorConversationEventId` 全部由**服务端装配层**填（`S8-A11`）。
 * 账本端口不接受来自提案 payload 的这三个字段。
 */
export interface StoryCommitBinding {
  /**
   * `user_choice` = 真实用户提交的选择（**唯一**能成为习惯根的形态）
   * `system`      = 开场 / 确定性结局提交 / 后台推进（可成为经历，**不**合格为习惯根）
   */
  interactionKind: 'user_choice' | 'system'
  /** 真实会话 id（`user_choice` 必填；来自当轮运行上下文，**不**来自提案 payload） */
  interactionRef?: string
  /**
   * 触发这次提交的**真实对话事件 id**（`user_choice` 必填）。
   *
   * ⚠️ 它同时是 `D05` 的因果身份键来源（故事根与对话根**同键**）与
   * `character_domain_events.primary_source_event_id` 的**语义正确**来源（`R-2`）。
   */
  anchorConversationEventId?: string
  actorKind: 'user' | 'system'
  actorId?: string
}

/** 可以带 `user_choice` 绑定的事件类型（**封闭**；其余一律 `system`） */
export const STORY_USER_CHOICE_EVENT_TYPES: readonly StorylineEventType[] = [
  'CHOICE_COMMITTED',
  'ENDING_REACHED',
  'RUN_EXITED',
]

/**
 * 绑定形状校验（**失败关闭**）。
 *
 * 非法形状**当场抛错**，而不是"悄悄降级成 system" —— 降级会让一次真实交互
 * 静默地不再计入门槛，那正是最难查的一类偏差。
 */
export function assertStoryCommitBinding(
  binding: StoryCommitBinding,
  eventType: StorylineEventType
): void {
  const fail = (code: string, message: string): never => {
    throw new KernelError('validation_error', code, message)
  }

  if (binding.interactionKind === 'user_choice') {
    if (!STORY_USER_CHOICE_EVENT_TYPES.includes(eventType)) {
      fail(
        'story_binding_kind_not_allowed',
        `事件类型 ${eventType} **不允许**声明 user_choice：只有 ${JSON.stringify(
          STORY_USER_CHOICE_EVENT_TYPES
        )} 可以由真实用户提交（ADR-093 D01）`
      )
    }
    if (binding.actorKind !== 'user') {
      fail('story_binding_actor_mismatch', `user_choice 的 actorKind 必须是 'user'，收到 ${binding.actorKind}`)
    }
    if (typeof binding.interactionRef !== 'string' || binding.interactionRef.trim() === '') {
      fail(
        'story_binding_without_interaction_ref',
        'user_choice 必须带服务端绑定的 interactionRef（真实会话 id）：没有它就无法回答"这是不是两个真实会话"'
      )
    }
    if (
      typeof binding.anchorConversationEventId !== 'string' ||
      binding.anchorConversationEventId.trim() === ''
    ) {
      fail(
        'story_binding_without_anchor',
        'user_choice 必须带 anchorConversationEventId（真实触发对话事件）：它既是因果身份键（D05/R-4），' +
          '也是域事件 primary_source_event_id 的来源（R-2）'
      )
    }
    return
  }

  // system：不许夹带"看起来像真实交互"的字段（否则前端可以自报一次会话）
  if (binding.actorKind !== 'system') {
    fail('story_binding_actor_mismatch', `system 的 actorKind 必须是 'system'，收到 ${binding.actorKind}`)
  }
  if (binding.interactionRef !== undefined) {
    fail(
      'story_binding_system_with_session',
      'system 提交不得声明 interactionRef：那会让"后台推进"看起来像一次真实会话（违反 S8-A14）'
    )
  }
}

// ---------------------------------------------------------------------------
// 账本行（持久形状）
// ---------------------------------------------------------------------------

/** 一条**已提交**的世界变更（持久形状；`storyline_commits` 一行） */
export interface StoryCommitRecord {
  /** `story:<storyId>@v<ver>#<runId>.e<revision>` */
  commitId: string
  storyId: string
  storyVersion: number
  runId: string
  revision: number
  /** `e<revision>`（`StorylineEvent.eventId` 原样） */
  eventId: string
  eventType: StorylineEventType
  choiceId?: string
  fromNodeId: string
  toNodeId: string
  stage: StoryStageId
  variablesAfter: StoryVariableValues
  /** 本次提交**新**进入可见集合的条目（不是累积集合） */
  newVisibleEvents: readonly string[]
  ending?: StoryEndingId
  endingRule?: string
  /** 该 run 读的是哪一版剧情 */
  contentDigest: string
  committedAt: Timestamp
  recordedAt: Timestamp
  binding: StoryCommitBinding
  /**
   * 幂等身份（**服务端给**；唯一约束）。
   *
   * ⚠️ 它与 `(storyId, storyVersion, runId, revision)` 的唯一约束**互补**：
   * 前者挡"同一次提交被重试"，后者挡"同一 revision 被写成两条"。
   * 两个都要有 —— 只留一个都会在某一类重试下漏。
   */
  idempotencyKey: string
  schemaVersion: number
}

/** 一条可见条目 → 承载它的那次提交（`storyline_observations` 一行） */
export interface StoryObservationRecord {
  /** `story:<storyId>@v<ver>#<runId>.<eventId>`（沿用既有来源 id 格式，不改） */
  observationId: string
  parentCommitId: string
  storyId: string
  storyVersion: number
  runId: string
  eventId: string
  createdAt: Timestamp
}

/** 由一条**已判定通过**的事件装配账本行（纯函数） */
export function storyCommitRecordOf(input: {
  event: StorylineEvent
  contentDigest: string
  binding: StoryCommitBinding
  recordedAt: Timestamp
  idempotencyKey: string
}): StoryCommitRecord {
  const { event, binding } = input
  assertStoryCommitBinding(binding, event.type)
  if (input.idempotencyKey.trim() === '') {
    throw new KernelError(
      'validation_error',
      'story_commit_without_idempotency_key',
      '提交必须带服务端给的 idempotencyKey：没有它，重试就会变成第二次提交'
    )
  }
  const identity: StoryCommitIdentity = {
    storyId: event.storyId,
    storyVersion: event.storyVersion,
    runId: event.runId,
    revision: event.revision,
  }
  const commitId = storyCommitIdOf(identity)
  return {
    commitId,
    ...identity,
    eventId: event.eventId,
    eventType: event.type,
    ...(event.choiceId !== undefined ? { choiceId: event.choiceId } : {}),
    fromNodeId: event.fromNodeId,
    toNodeId: event.toNodeId,
    stage: event.stage,
    variablesAfter: event.variablesAfter,
    newVisibleEvents: [...event.visibleEvents],
    ...(event.ending !== undefined ? { ending: event.ending } : {}),
    ...(typeof event.metadata?.endingRule === 'string' ? { endingRule: event.metadata.endingRule } : {}),
    contentDigest: input.contentDigest,
    committedAt: event.committedAt,
    recordedAt: input.recordedAt,
    binding,
    idempotencyKey: input.idempotencyKey,
    schemaVersion: STORY_LEDGER_SCHEMA_VERSION,
  }
}

/**
 * 一条提交**新引入**的可见条目 → 观测行（纯函数，顺序稳定）。
 *
 * ⚠️ 这里只落**这一次提交新引入**的条目：`StorylineEvent.visibleEvents` 在
 * `world-machine.ts` 里本来就是 `newlyVisible`（不是累积集合）—— 本函数不改写它，
 * 只把它翻译成观测行。重复引入同一个条目（例如对同一事件再提一次）**不会**产生第二行：
 * 由 `(storyId, storyVersion, runId, eventId)` 的唯一约束兜底。
 */
export function storyObservationRecordsOf(commit: StoryCommitRecord): StoryObservationRecord[] {
  const seen = new Set<string>()
  const records: StoryObservationRecord[] = []
  for (const eventId of commit.newVisibleEvents) {
    const observationId = makeStorySourceId({
      storyId: commit.storyId,
      storyVersion: commit.storyVersion,
      runId: commit.runId,
      eventId,
    })
    if (seen.has(observationId)) continue
    seen.add(observationId)
    records.push({
      observationId,
      parentCommitId: commit.commitId,
      storyId: commit.storyId,
      storyVersion: commit.storyVersion,
      runId: commit.runId,
      eventId,
      createdAt: commit.recordedAt,
    })
  }
  return records
}

// ---------------------------------------------------------------------------
// 因果身份键（ADR-093 D05 + R-4）
// ---------------------------------------------------------------------------

/** 对话事件根的因果键 */
export function conversationRootKey(conversationEventId: string): string {
  return `conversation:${conversationEventId}`
}

/** `system` 提交的因果键（**不合格**为习惯根） */
export function systemStoryRootKey(commitId: string): string {
  return `story-system:${commitId}`
}

/**
 * 一条故事提交的**因果身份键**。
 *
 * ```text
 * user_choice ⇒ 'conversation:' + anchorConversationEventId   ← 与对话根同键（S8-C02 构造上成立）
 * system      ⇒ 'story-system:' + commitId                   ← 是经历，不合格为习惯根
 * ```
 *
 * ⚠️ 这个函数**不认识**"提交 id 本身"这个键：如果哪天有人把故事根键退回 `commitId`，
 * `S8-C02` 会当场失败（同一次选择会得到两把键）—— 那是 `R-4` 记录的那个缺陷。
 */
export function storyRootKeyOf(commit: StoryCommitRecord): string {
  if (commit.binding.interactionKind === 'user_choice') {
    return conversationRootKey(requireAnchor(commit))
  }
  return systemStoryRootKey(commit.commitId)
}

/**
 * 一条故事提交**是否合格**成为习惯/关系的采纳根。
 *
 * 判据只有一条（`D06`）：`interactionKind === 'user_choice'`。
 * 纯后台推进 / 作者设定 / NPC 评价 ⇒ `false`，且**不**贡献真实会话数。
 */
export function isHabitEligibleStoryCommit(commit: StoryCommitRecord): boolean {
  return commit.binding.interactionKind === 'user_choice'
}

/** 一条故事提交归属的真实会话（`system` ⇒ `undefined`，**不**计入会话数） */
export function storySessionKeyOf(commit: StoryCommitRecord): string | undefined {
  return commit.binding.interactionKind === 'user_choice' ? commit.binding.interactionRef : undefined
}

// ---------------------------------------------------------------------------
// 折叠（账本行 → 事件流 → 状态）—— 权威是账本，状态是派生的
// ---------------------------------------------------------------------------

/**
 * 账本行 → `StorylineEvent`（供既有 `foldStorylineEvents` 复用）。
 *
 * ⚠️ 它存在的理由是**不**在账本层再实现一遍折叠：
 * `foldStorylineEvents` 已经是纯函数且被 `postlv2:story:verify` 的 12 个负控守着，
 * 复用它等于"重启恢复后状态逐字段一致"这件事**不需要新证据**就有保障。
 */
export function storylineEventOf(commit: StoryCommitRecord): StorylineEvent {
  return {
    eventId: commit.eventId,
    storyId: commit.storyId,
    storyVersion: commit.storyVersion,
    runId: commit.runId,
    revision: commit.revision,
    type: commit.eventType,
    ...(commit.choiceId !== undefined ? { choiceId: commit.choiceId } : {}),
    fromNodeId: commit.fromNodeId,
    toNodeId: commit.toNodeId,
    stage: commit.stage,
    variablesAfter: commit.variablesAfter,
    visibleEvents: [...commit.newVisibleEvents],
    ...(commit.ending !== undefined ? { ending: commit.ending } : {}),
    committedAt: commit.committedAt,
    ...(commit.endingRule !== undefined ? { metadata: { endingRule: commit.endingRule } } : {}),
  }
}

/** 按 `revision` 升序（折叠前唯一允许的排序口径） */
export function orderCommits(commits: readonly StoryCommitRecord[]): StoryCommitRecord[] {
  return [...commits].sort((a, b) => a.revision - b.revision)
}

/**
 * 提交序列的**连续性自检**（`S8-A33`/恢复对账用）。
 *
 * 返回缺口（`revision` 应连续 1..N）。有缺口 ⇒ 调用方**不得**折叠出"看起来完整"的状态
 * —— 半个世界账本折出来的状态与完整账本长得一样，这是必须显式发现的形态。
 */
export function storyCommitGaps(commits: readonly StoryCommitRecord[]): number[] {
  const ordered = orderCommits(commits)
  const gaps: number[] = []
  let expected = 1
  for (const commit of ordered) {
    if (commit.revision !== expected) {
      for (let missing = expected; missing < commit.revision; missing += 1) gaps.push(missing)
    }
    expected = commit.revision + 1
  }
  return gaps
}

function requireAnchor(commit: StoryCommitRecord): string {
  const anchor = commit.binding.anchorConversationEventId
  if (typeof anchor !== 'string' || anchor.trim() === '') {
    throw new KernelError(
      'validation_error',
      'story_commit_without_anchor',
      `提交 ${commit.commitId} 声明为 user_choice 但没有 anchorConversationEventId：` +
        '账本行已损坏，拒绝派生因果身份（失败关闭）'
    )
  }
  return anchor
}
