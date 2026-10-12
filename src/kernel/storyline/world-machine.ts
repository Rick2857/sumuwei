/**
 * Storyline —— **世界状态机**（纯函数，后 Lv2 · S1 / Lv2.5）。
 *
 * ============================================================================
 *  载体：ADR-091 §1（权威分层）· §2（世界边界）· 契约 S1–S6 / INV-PL2-01…07
 * ============================================================================
 * 这个模块**只做一件事**：给定"已发生的故事事实"与一个**提案**，算出"能不能接受"。
 *
 * ---------------------------------------------------------------------------
 *  为什么世界推进必须在这里判定，而不是在 inkjs 里
 * ---------------------------------------------------------------------------
 * inkjs 是**表现/叙事引擎**，它不认识 LG 的认知边界：它不会拦住"模型跳过剧情"、
 * 不会拦住"变量越界"、也不会区分"用户真的选了"与"文本里说门开了"。
 * 因此本模块把**权威**留在 LG 这一侧：
 *
 *     模型 / 运行器只能**提案**（proposal）
 *     世界状态机**确定性**判定并产生事件（event）
 *
 * 这与 M4.5 行动协议、M10.1 约定桥是同一条纪律：**提案 ≠ 事实**。
 *
 * ---------------------------------------------------------------------------
 *  负控清单（契约 S3，全部分母保留）
 * ---------------------------------------------------------------------------
 *   未知 choice · 越界变量 · 穿越指令 · 跳阶段 · 重复投递 · 过期 revision
 *   · 非 frontier 选择 · 版本不匹配 · 终局后继续推进
 * 以上**全部不改变故事**，且**不产生**所请求的虚构进展对应的体验记忆或认知副作用。
 * 注意：**实际提出请求的那一轮对话仍按正常轮次记录和反应**（记录的请求不是虚构进展）。
 */

import { KernelError } from '../contracts/ids.ts'
import type { Timestamp } from '../contracts/ids.ts'
import {
  STORY_ENDING_IDS,
  assertStoryContentPack,
  nodeDefinitionOf,
  parseStorySourceId,
  variableDefinitionOf,
  variableValueInRange,
  type StoryContentPack,
  type StoryEndingId,
  type StoryEndingTransition,
  type StoryStageId,
  type StoryVariableDefinition,
  type StorylineEventType,
} from './story-types.ts'

// ---------------------------------------------------------------------------
// 事实（已发生的故事事件）
// ---------------------------------------------------------------------------

/** 变量快照（**可重建**；权威是事件流，快照只是它的折叠结果） */
export type StoryVariableValues = Readonly<Record<string, number | boolean | string>>

/**
 * 一条已提交的故事事件。
 *
 * `revision` 是**单调递增**的提交序号：它是"过期 revision 拒收"（契约 S3）与
 * "重复投递不重复写入"（契约 S11）两件事的共同依据。
 */
export interface StorylineEvent {
  eventId: string
  storyId: string
  storyVersion: number
  runId: string
  /** 提交序号：1, 2, 3…（**单调**，不跳号） */
  revision: number
  type: StorylineEventType
  /** 该步的用户选择（仅 `CHOICE_COMMITTED`） */
  choiceId?: string
  fromNodeId: string
  toNodeId: string
  stage: StoryStageId
  variablesAfter: StoryVariableValues
  /** 该步进入可见集合的剧情事件（**只有她见得到的**） */
  visibleEvents: readonly string[]
  ending?: StoryEndingId
  committedAt: Timestamp
  /** 审计用元数据（例如"为什么是这个结局"的判据名） */
  metadata?: Readonly<Record<string, unknown>>
}

/** 世界状态（**由事件流折叠**；`Ink 状态` 只是它的一种快照形态） */
export interface StorylineState {
  storyId: string
  storyVersion: number
  runId: string
  /** `= revision`：最后一个已提交事件的序号；0 = 刚创建、还没提交任何事件 */
  revision: number
  currentNodeId: string
  stage: StoryStageId
  variables: StoryVariableValues
  /**
   * 已提交的剧情事件（`expression/event` 的 id），**只增不减**。
   * ⚠️ INV-PL2-07：`visible ⊆ committed`；回放**永不**把不可见事件变成亲历。
   */
  visibleEventIds: readonly string[]
  /** 她可感知的"经历"条目（进上下文与认知来源；**不是**世界真相） */
  experiencedEventIds: readonly string[]
  ending?: StoryEndingId
  /** 终局或退出后为 true：**不再**接受任何推进 */
  terminal: boolean
  /** 全部已提交事件的 revision 集合（**幂等**判据：同一 revision 不重复写入） */
  committedRevisions: readonly number[]
  startedAt: Timestamp
  updatedAt: Timestamp
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export interface StartStoryInput {
  pack: StoryContentPack
  runId: string
  now?: Timestamp
}

export interface StartStoryResult {
  state: StorylineState
  event: StorylineEvent
}

/**
 * 开始一次故事运行（**新 runId** ⇒ 新身份）。
 *
 * ⚠️ 契约 S6：重开使用**新 runId**，旧经历保留原范围，不被改写。
 * 因此本函数不接受"已有 runId 继续跑"——续跑走 `advanceFromEvents()` 的折叠路径。
 */
export function startStory(input: StartStoryInput): StartStoryResult {
  assertStoryContentPack(input.pack)
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(input.runId)) {
    throw new KernelError('validation_error', 'bad_run_id', `runId 形状非法：${JSON.stringify(input.runId)}`)
  }
  const now = input.now ?? Date.now()
  const entry = nodeDefinitionOf(input.pack, input.pack.entryNodeId)
  if (!entry) {
    throw new KernelError('validation_error', 'story_entry_node_missing', `起点节点不在图中：${input.pack.entryNodeId}`)
  }
  const variables = initialVariables(input.pack.variables)

  const event: StorylineEvent = {
    eventId: 'e1',
    storyId: input.pack.storyId,
    storyVersion: input.pack.storyVersion,
    runId: input.runId,
    revision: 1,
    type: 'STORY_STARTED',
    fromNodeId: entry.id,
    toNodeId: entry.id,
    stage: entry.stage,
    variablesAfter: variables,
    visibleEvents: [...entry.visibleEvents],
    committedAt: now,
  }

  return {
    state: {
      storyId: input.pack.storyId,
      storyVersion: input.pack.storyVersion,
      runId: input.runId,
      revision: 1,
      currentNodeId: entry.id,
      stage: entry.stage,
      variables,
      visibleEventIds: [...entry.visibleEvents],
      experiencedEventIds: [...entry.visibleEvents],
      terminal: false,
      committedRevisions: [1],
      startedAt: now,
      updatedAt: now,
    },
    event,
  }
}

// ---------------------------------------------------------------------------
// 推进（提案 → 判定 → 事件）
// ---------------------------------------------------------------------------

export interface AdvanceProposal {
  /** 谁提的（模型/按钮/自然语言理解器）——**只用于审计，不影响判定** */
  proposedBy: 'user_choice' | 'nlu' | 'rules'
  choiceId: string
  /** 提案者**认为**的当前 revision（过期即拒收；契约 S3） */
  expectedRevision: number
  /** 提案者**认为**的故事版本（不匹配即拒收；契约 S6） */
  expectedStoryVersion: number
}

export type AdvanceVerdict =
  | { ok: true; state: StorylineState; event: StorylineEvent }
  | {
      ok: false
      code:
        | 'story_run_is_terminal'
        | 'story_version_mismatch'
        | 'story_stale_revision'
        | 'story_unknown_choice'
        | 'story_choice_not_on_frontier'
      detail: string
    }

/**
 * 判定一次推进提案（**纯函数**，不抛错 —— 拒收是**正常结果**，不是故障）。
 *
 * 六道闸（顺序即优先级；每一道都对应契约里的一条负控）：
 * ```text
 * ① 终局/已退出     ⇒ 拒（不再接受任何推进）
 * ② 版本不匹配      ⇒ 拒（**明确拒绝**，绝不默默换剧情）
 * ③ revision 过期   ⇒ 拒（重复投递/乱序投递都落在这里）
 * ④ choice 未登记   ⇒ 拒（模型不能新增节点/选择）
 * ⑤ choice 不在 frontier ⇒ 拒（**不能跳过剧情**）
 * ⑥ 迁移表查不到    ⇒ 拒（图有界：没有声明的路走不通）
 * ```
 */
export function advanceFromProposal(
  pack: StoryContentPack,
  state: StorylineState,
  proposal: AdvanceProposal,
  now: Timestamp = Date.now()
): AdvanceVerdict {
  if (state.terminal) {
    return {
      ok: false,
      code: 'story_run_is_terminal',
      detail: `run ${state.runId} 已结束（ending=${state.ending ?? 'exited'}）：终局后不生成无限补考`,
    }
  }
  if (proposal.expectedStoryVersion !== pack.storyVersion) {
    return {
      ok: false,
      code: 'story_version_mismatch',
      detail:
        `提案携带版本 v${proposal.expectedStoryVersion}，内容包是 v${pack.storyVersion}：` +
        '版本不匹配必须明确拒绝，不能默默换剧情（契约 S6）',
    }
  }
  if (proposal.expectedRevision !== state.revision) {
    return {
      ok: false,
      code: 'story_stale_revision',
      detail:
        `提案基于 revision ${proposal.expectedRevision}，当前是 ${state.revision}：` +
        '重复投递与乱序投递都在这里被拒（契约 S3 / S11）',
    }
  }

  const current = nodeDefinitionOf(pack, state.currentNodeId)
  if (!current) {
    return {
      ok: false,
      code: 'story_unknown_choice',
      detail: `当前节点 ${state.currentNodeId} 不在图上：状态已损坏，拒绝推进（失败关闭）`,
    }
  }

  const declared = pack.transitions.find(
    (transition) => transition.from === state.currentNodeId && transition.choice === proposal.choiceId
  )
  if (!declared) {
    return {
      ok: false,
      code: 'story_unknown_choice',
      detail:
        `选择 ${proposal.choiceId} 不在图上的任何 (${state.currentNodeId}, choice) 迁移里：` +
        '模型不能新增地点/节点/人物/变量/结局（契约 S4）',
    }
  }
  if (!current.choices.includes(proposal.choiceId)) {
    return {
      ok: false,
      code: 'story_choice_not_on_frontier',
      detail: `选择 ${proposal.choiceId} 不属于节点 ${current.id} 的合法 frontier：${JSON.stringify(current.choices)}`,
    }
  }

  const target = nodeDefinitionOf(pack, declared.to)
  if (!target) {
    return { ok: false, code: 'story_unknown_choice', detail: `迁移终点 ${declared.to} 不在图上` }
  }

  // 迁移的变量改写已由 `assertStoryContentPack` 在构造期校验过范围；
  // 这里再独立核算一次"应用后的值仍在值域内"——**不变量必须在运行期也成立**。
  const variablesAfter: Record<string, number | boolean | string> = { ...state.variables }
  for (const [name, value] of Object.entries(declared.setVariables ?? {})) {
    const definition = variableDefinitionOf(pack, name)
    if (!definition || !variableValueInRange(definition.range, value)) {
      return {
        ok: false,
        code: 'story_unknown_choice',
        detail: `迁移把未声明或越界的变量写进来：${name}=${JSON.stringify(value)}`,
      }
    }
    variablesAfter[name] = value
  }

  /*
   * 这一步进入可见集合的剧情事件 = **迁移声明** ∪ **目标节点声明**（去重，保持作者顺序）。
   *
   * ⚠️ 为什么要并上目标节点（2026-10-03 S8/WP2 实测发现，ADR-093 §10.2 `R-5`）：
   *   · `story-types.ts` 对 `StoryNodeDefinition.visibleEvents` 的原文是"进可见集合"；
   *   · `JICHUANG_PACK` 的迁移**故意不声明** `visibleEvents`（那里逐字写着
   *     "可见事件由**节点**承载：到达该节点即进入可见集合，迁移不重复声明"）；
   *   · `.ink` 也确实在**每个节点**上发 `# visible:<id>`，而 `ink-runtime.ts` 会累积它们；
   *   · 同文件的 `commitEnding()` **本来就是**按目标节点取的。
   * 只有这一处按迁移取 ⇒ 实测后果是"她只经历了序章那一条，后面每一步都不进可见集合"，
   * 而纯状态机与 ink 运行器对**同一张图**给出不同的经历集合 —— 那是来源安全面的分歧
   * （`S8-A03`/`S8-A09` 依赖可见性），必须按**文档化语义**补齐，而不是让账本忠实记录一个退化集合。
   */
  const declaredVisible = [...(declared.visibleEvents ?? []), ...target.visibleEvents]
  const newlyVisible = declaredVisible
    .filter((event, index) => declaredVisible.indexOf(event) === index)
    .filter((event) => !state.visibleEventIds.includes(event))
  const revision = state.revision + 1
  const eventId = `e${revision}`

  const event: StorylineEvent = {
    eventId,
    storyId: state.storyId,
    storyVersion: state.storyVersion,
    runId: state.runId,
    revision,
    type: declared.ending ? 'ENDING_REACHED' : 'CHOICE_COMMITTED',
    choiceId: proposal.choiceId,
    fromNodeId: state.currentNodeId,
    toNodeId: declared.to,
    stage: target.stage,
    variablesAfter,
    visibleEvents: [...newlyVisible],
    ...(declared.ending ? { ending: declared.ending } : {}),
    committedAt: now,
  }

  return {
    ok: true,
    event,
    state: {
      ...state,
      revision,
      currentNodeId: declared.to,
      stage: target.stage,
      variables: variablesAfter,
      visibleEventIds: [...state.visibleEventIds, ...newlyVisible],
      experiencedEventIds: [...state.experiencedEventIds, ...newlyVisible],
      ...(declared.ending ? { ending: declared.ending } : {}),
      terminal: declared.ending !== undefined,
      committedRevisions: [...state.committedRevisions, revision],
      updatedAt: now,
    },
  }
}

/**
 * 用户明确退出（契约 S2 / 计划书 §5.1）。
 *
 * ⚠️ **退出 ≠ 被极创判定未通过**：终局记 `exited_by_user`，与
 * `not_passed_this_time` 是两个不同的结局，不得互相代替。
 */
export function exitStory(
  pack: StoryContentPack,
  state: StorylineState,
  expectedRevision: number,
  now: Timestamp = Date.now()
): AdvanceVerdict {
  if (state.terminal) {
    return { ok: false, code: 'story_run_is_terminal', detail: `run ${state.runId} 已结束` }
  }
  if (expectedRevision !== state.revision) {
    return {
      ok: false,
      code: 'story_stale_revision',
      detail: `退出提案基于 revision ${expectedRevision}，当前是 ${state.revision}`,
    }
  }
  if (!pack.exitNodes.includes(state.currentNodeId)) {
    return {
      ok: false,
      code: 'story_choice_not_on_frontier',
      detail: `节点 ${state.currentNodeId} 不是已声明的可退出节点：${JSON.stringify(pack.exitNodes)}`,
    }
  }
  const revision = state.revision + 1
  const event: StorylineEvent = {
    eventId: `e${revision}`,
    storyId: state.storyId,
    storyVersion: state.storyVersion,
    runId: state.runId,
    revision,
    type: 'RUN_EXITED',
    fromNodeId: state.currentNodeId,
    toNodeId: state.currentNodeId,
    stage: state.stage,
    variablesAfter: state.variables,
    visibleEvents: [],
    ending: 'exited_by_user',
    committedAt: now,
  }
  return {
    ok: true,
    event,
    state: {
      ...state,
      revision,
      ending: 'exited_by_user',
      terminal: true,
      committedRevisions: [...state.committedRevisions, revision],
      updatedAt: now,
    },
  }
}

/**
 * **确定性**结局判定（契约 S4：结局由变量与已提交事件算出，**不可由模型挑选**）。
 *
 * 与 `.ink` 的 `s4_result` 条件分支必须一致；`postlv2:story:verify` 会核对
 * "纯函数判定结果"与"ink 走出来的节点"在**全部可达变量组合**上一致。
 */
export function resolveEnding(
  pack: StoryContentPack,
  state: StorylineState
): { transition: StoryEndingTransition } | { error: string } {
  const candidates = pack.endingTransitions.filter((transition) => transition.from === state.currentNodeId)
  if (candidates.length === 0) {
    return { error: `节点 ${state.currentNodeId} 没有声明任何确定性结局迁移` }
  }
  const matched = candidates.find((transition) => endingRuleSatisfied(transition.rule, state.variables))
  if (!matched) {
    return {
      error:
        `节点 ${state.currentNodeId} 在变量 ${JSON.stringify(state.variables)} 下没有匹配的结局判据：` +
        `${JSON.stringify(candidates.map((c) => c.rule))}（图不完备 —— 失败关闭，不猜一个结局）`,
    }
  }
  return { transition: matched }
}

/**
 * 结局判据求值（**受控小语言**）。
 *
 * 刻意只支持 `&&` 连接的原子比较，且比较对象只能是**已声明变量**与常量：
 * 不支持函数、索引、括号嵌套或任意表达式求值 —— 那会变成一个可注入的求值器。
 */
export function endingRuleSatisfied(
  rule: string,
  variables: Readonly<Record<string, number | boolean | string>>
): boolean {
  if (rule === 'otherwise') return true
  return rule.split('&&').every((atom) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)\s*$/.exec(atom)
    if (!match) return false
    const [, name, operator, literal] = match
    const left = Number(variables[name] ?? Number.NaN)
    const right = Number(literal)
    if (!Number.isFinite(left)) return false
    switch (operator) {
      case '>=':
        return left >= right
      case '<=':
        return left <= right
      case '==':
        return left === right
      case '!=':
        return left !== right
      case '>':
        return left > right
      case '<':
        return left < right
      default:
        return false
    }
  })
}

/**
 * 提交一个**确定性**结局（`resolveEnding` 通过之后才调用）。
 */
export function commitEnding(
  pack: StoryContentPack,
  state: StorylineState,
  expectedRevision: number,
  now: Timestamp = Date.now()
): AdvanceVerdict {
  if (state.terminal) {
    return { ok: false, code: 'story_run_is_terminal', detail: `run ${state.runId} 已结束` }
  }
  if (expectedRevision !== state.revision) {
    return {
      ok: false,
      code: 'story_stale_revision',
      detail: `结局提交基于 revision ${expectedRevision}，当前是 ${state.revision}`,
    }
  }
  const resolved = resolveEnding(pack, state)
  if ('error' in resolved) {
    return { ok: false, code: 'story_unknown_choice', detail: resolved.error }
  }
  const target = nodeDefinitionOf(pack, resolved.transition.to)
  if (!target) {
    return { ok: false, code: 'story_unknown_choice', detail: `结局节点不在图上：${resolved.transition.to}` }
  }
  const newlyVisible = target.visibleEvents.filter((event) => !state.visibleEventIds.includes(event))
  const revision = state.revision + 1
  const event: StorylineEvent = {
    eventId: `e${revision}`,
    storyId: state.storyId,
    storyVersion: state.storyVersion,
    runId: state.runId,
    revision,
    type: 'ENDING_REACHED',
    fromNodeId: state.currentNodeId,
    toNodeId: target.id,
    stage: target.stage,
    variablesAfter: state.variables,
    visibleEvents: [...newlyVisible],
    ending: resolved.transition.ending,
    committedAt: now,
    metadata: { endingRule: resolved.transition.rule },
  }
  return {
    ok: true,
    event,
    state: {
      ...state,
      revision,
      currentNodeId: target.id,
      stage: target.stage,
      visibleEventIds: [...state.visibleEventIds, ...newlyVisible],
      experiencedEventIds: [...state.experiencedEventIds, ...newlyVisible],
      ending: resolved.transition.ending,
      terminal: true,
      committedRevisions: [...state.committedRevisions, revision],
      updatedAt: now,
    },
  }
}

// ---------------------------------------------------------------------------
// 折叠（事件流 → 状态）—— **重放不产生第二次副作用**
// ---------------------------------------------------------------------------

/**
 * 从事件流**折叠**出状态（确定性的、幂等的）。
 *
 * ⚠️ 契约 S5 / S11：快照重建与回放**不**重发世界观测、**不**重复写记忆、
 * **不**重复推动情绪/关系。因此这个函数是**纯**的：它不调用任何写口，
 * 只按 `revision` 顺序折叠；重复的 revision **跳过**（幂等）。
 */
export function foldStorylineEvents(events: readonly StorylineEvent[]): StorylineState {
  if (events.length === 0) {
    throw new KernelError('validation_error', 'empty_storyline_events', '折叠需要至少一条事件')
  }
  const ordered = [...events].sort((a, b) => a.revision - b.revision)
  const first = ordered[0]
  const seen = new Set<number>()
  let state: StorylineState | undefined

  for (const event of ordered) {
    if (event.storyId !== first.storyId || event.runId !== first.runId) {
      throw new KernelError(
        'validation_error',
        'storyline_fold_mixed_run',
        '折叠的输入混了不同 storyId/runId 的事件：世界事实不允许跨运行折叠'
      )
    }
    if (seen.has(event.revision)) continue // 幂等：重复投递不重复写入
    seen.add(event.revision)

    const newlyVisible = event.visibleEvents.filter((id) => !(state?.visibleEventIds ?? []).includes(id))
    state = {
      storyId: event.storyId,
      storyVersion: event.storyVersion,
      runId: event.runId,
      revision: event.revision,
      currentNodeId: event.toNodeId,
      stage: event.stage,
      variables: event.variablesAfter,
      visibleEventIds: [...(state?.visibleEventIds ?? []), ...newlyVisible],
      experiencedEventIds: [...(state?.experiencedEventIds ?? []), ...newlyVisible],
      ...(event.ending ? { ending: event.ending } : {}),
      terminal: event.type === 'ENDING_REACHED' || event.type === 'RUN_EXITED',
      committedRevisions: [...(state?.committedRevisions ?? []), event.revision],
      startedAt: state?.startedAt ?? event.committedAt,
      updatedAt: event.committedAt,
    }
  }

  return state!
}

/** 该状态是否已结束 */
export function isTerminal(state: StorylineState): boolean {
  return state.terminal
}

/** 当前 frontier（合法选择）——**只**来自作者定义，不来自模型 */
export function frontierOf(pack: StoryContentPack, state: StorylineState): readonly string[] {
  if (state.terminal) return []
  return nodeDefinitionOf(pack, state.currentNodeId)?.choices ?? []
}

// ---------------------------------------------------------------------------
// 来源身份 → 认知来源（契约 S9：`canSupportExternalFact` 必须为 false）
// ---------------------------------------------------------------------------

/** 故事来源的三元标签（D04 的新增词汇在 WP2 落库时启用；此处给出**运行期**形态） */
export interface StoryProvenance {
  storyId: string
  storyVersion: number
  runId: string
  storylineEventId: string
  /** 确定性来源 id（进 `EvidenceRef.id`，`kind` 用既有的 `'observation'`） */
  sourceId: string
  /** 这条经历的体验范围（**用户陈述** vs **模拟经历** 必须区分；契约 S10） */
  experienceScope: 'story_experience' | 'user_report'
}

export function storyProvenanceOf(input: {
  storyId: string
  storyVersion: number
  runId: string
  eventId: string
  experienceScope: StoryProvenance['experienceScope']
}): StoryProvenance {
  const sourceId = makeStorySource(input)
  return {
    storyId: input.storyId,
    storyVersion: input.storyVersion,
    runId: input.runId,
    storylineEventId: input.eventId,
    sourceId,
    experienceScope: input.experienceScope,
  }
}

function makeStorySource(input: {
  storyId: string
  storyVersion: number
  runId: string
  eventId: string
}): string {
  return `story:${input.storyId}@v${input.storyVersion}#${input.runId}.${input.eventId}`
}

/** 读回校验：来源 id 必须能解析，且四个分量必须**逐字**等于声明值（契约 S7 的读回对账） */
export function assertStoryProvenanceReadback(provenance: StoryProvenance): void {
  const parsed = parseStorySourceId(provenance.sourceId)
  if (!parsed) {
    throw new KernelError('validation_error', 'bad_story_source_id', `来源 id 不可解析：${provenance.sourceId}`)
  }
  if (
    parsed.storyId !== provenance.storyId ||
    parsed.storyVersion !== provenance.storyVersion ||
    parsed.runId !== provenance.runId ||
    parsed.eventId !== provenance.storylineEventId
  ) {
    throw new KernelError(
      'validation_error',
      'story_provenance_readback_mismatch',
      `来源读回不一致：声明=${JSON.stringify(provenance)} 读回=${JSON.stringify(parsed)}`
    )
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function initialVariables(
  definitions: readonly StoryVariableDefinition[]
): Readonly<Record<string, number | boolean | string>> {
  const values: Record<string, number | boolean | string> = {}
  for (const definition of definitions) values[definition.name] = definition.initial
  return values
}

/** 供门使用：登记表完整性自检（`measured_count > 0` 的其中一项） */
export function storylineVocabularySize(): number {
  return STORY_ENDING_IDS.length
}
