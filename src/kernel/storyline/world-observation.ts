/**
 * Storyline —— **世界观测适配器**（纯函数；后 Lv2 · S1 / ADR-091 §3）。
 *
 * ============================================================================
 *  载体：ADR-091 `D05`–`D09` · 故事世界来源契约 `S9`/`S10`/`S11` · INV-PL2-07
 * ============================================================================
 * 它把"**已提交且她感知到**的故事事件"变成"一条可以进上下文的观测"。
 *
 * ---------------------------------------------------------------------------
 *  它守的四条线（每一条都有对应的负控）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 只认**已提交**事件（不是模型说发生了什么）
 * ② 只认**可见**事件（visibleEventIds ⊆ committed；未选分支 / 隐藏节点 / 未达结局
 *    在数据上就不在那个集合里，因此**出不来**）
 * ③ **确定性**来源身份 ⇒ 同一条故事事件永远得到同一条观测（幂等）
 * ④ 不同 (storyId, version, runId, eventId) 得到**不同**来源 id
 *    —— 少了 runId 就无法区分两次重开；少了 version 就无法回答"读的是哪一版剧情"
 * ```
 *
 * ⚠️ 本模块**不做**认知写入：它只产出观测形状。
 * 记忆 / 情绪 / 关系 / 信念 / 目标 / 反思一律走**各域既有**的放行口（ADR-091 `D05`）。
 */

import { KernelError } from '../contracts/ids.ts'
import { assertStoryProvenanceReadback, storyProvenanceOf, type StorylineState } from './world-machine.ts'

/** 一条"她感知到的世界事件"（kernel 侧形状；`WorldTurnObservation` 与它同源） */
export interface StoryWorldObservation {
  /** 剧情事件 id（作者定义里的那个稳定名字，例如 `s1_scope_known`） */
  eventId: string
  /**
   * 给模型看的那一句。
   *
   * ⚠️ 由**程序**按作者定义渲染，不是模型续写；本适配器**原样**传出去，
   * 不做任何语义改写（改写会让"她感知到的"变成"我们替她理解的"）。
   */
  text: string
  /** 确定性来源 id：`story:<storyId>@v<version>#<runId>.<eventId>` */
  storySourceId: string
  storyId: string
  storyVersion: number
  runId: string
}

export interface WorldObservationInput {
  state: StorylineState
  /**
   * 事件文本的渲染口。
   *
   * ⚠️ 它是**必填**的：没有它就只能编一句 —— 而编出来的文本会以"她感知到的世界"
   * 的身份进上下文，那是最不该由适配器决定的东西。
   */
  renderText: (eventId: string, provenance: string) => string
}

/**
 * 把故事状态折叠成观测集（**确定性、幂等**）。
 *
 * ⚠️ 输入是 `StorylineState`（由**已提交事件流**折叠而来），而不是"运行器的当前内存态"：
 * 重放与补送都必须得到与首次相同的观测集，否则"回放不产生第二次副作用"就是空话。
 */
export function worldObservationsOf(input: WorldObservationInput): StoryWorldObservation[] {
  const { state } = input
  const visible = new Set(state.visibleEventIds)

  /*
   * 契约 `S11` / INV-PL2-07：`visible ⊆ committed`。
   * 这条在类型上表达不出来（两个都是 `readonly string[]`），因此在这里**显式**校验：
   * 一旦某个来源把不可见事件塞进 `visibleEventIds`，本适配器必须**当场**拒绝，
   * 而不是把它渲染成"她亲眼看见的"。
   */
  const phantom = state.visibleEventIds.filter((eventId) => !state.experiencedEventIds.includes(eventId))
  if (phantom.length > 0) {
    throw new KernelError(
      'validation_error',
      'world_observation_phantom_visibility',
      `可见集合里有**未经历**的事件：${JSON.stringify(phantom)}。` +
        '可见集合必须等于已提交且她感知到的集合（INV-PL2-07）',
      { phantom }
    )
  }

  const seen = new Set<string>()
  const result: StoryWorldObservation[] = []
  for (const eventId of state.experiencedEventIds) {
    // 幂等：同一事件只产出一条观测（去重按**剧情事件 id**）
    if (seen.has(eventId)) continue
    seen.add(eventId)
    if (!visible.has(eventId)) {
      /*
       * ⚠️ 这一支**不是**"过滤掉"而是**拒绝**：`experiencedEventIds ⊆ visibleEventIds`
       * 是数据不变量。悄悄跳过会让"她其实没看见"变成"我们没渲染"，
       * 两者在证据上完全不同。
       */
      throw new KernelError(
        'validation_error',
        'world_observation_not_visible',
        `事件 ${eventId} 在经历集合里但不在可见集合里：数据不变量被破坏，拒绝渲染`,
        { eventId }
      )
    }
    const provenance = storyProvenanceOf({
      storyId: state.storyId,
      storyVersion: state.storyVersion,
      runId: state.runId,
      eventId,
      experienceScope: 'story_experience',
    })
    // 读回自检：来源 id 的四个分量必须能解析回原样（"可审计"不是口号）
    assertStoryProvenanceReadback(provenance)
    result.push({
      eventId,
      text: input.renderText(eventId, provenance.sourceId),
      storySourceId: provenance.sourceId,
      storyId: state.storyId,
      storyVersion: state.storyVersion,
      runId: state.runId,
    })
  }
  return result
}

/**
 * 两条观测是不是**同一次经历**。
 *
 * ⚠️ 判据是**来源身份**而不是事件 id 文本：`s1_intro_met` 在两次重开（不同 `runId`）
 * 里是**两次不同的经历**。用事件 id 当身份会把"第二次一起参加二面"折进第一次。
 */
export function sameWorldExperience(
  a: StoryWorldObservation,
  b: StoryWorldObservation
): boolean {
  return a.storySourceId === b.storySourceId
}

/**
 * 去重（按来源身份；保持**首次出现顺序**）。
 *
 * 崩溃后补送、重放、以及"同一轮里被两条路径各带一次"都要靠它收敛成一次经历。
 */
export function dedupeWorldObservations(
  items: readonly StoryWorldObservation[]
): StoryWorldObservation[] {
  const seen = new Set<string>()
  const out: StoryWorldObservation[] = []
  for (const item of items) {
    if (seen.has(item.storySourceId)) continue
    seen.add(item.storySourceId)
    out.push(item)
  }
  return out
}

// ---------------------------------------------------------------------------
// 边界自检（`PL2-SR-01` 的裁定载体，ADR-092）
// ---------------------------------------------------------------------------

/**
 * **故事来源不得冒充成对话事件**（`INV-PL2-02` / `PL2-SR-01` 裁定的机器形态）。
 *
 * ============================================================================
 *  它守的是一条**结构性不可能**，而不是一个约定
 * ============================================================================
 * `createConversationEvent()` 经 `buildProvenance()` → `assertSourceConsistency()`
 * 推导 `sourceKind`，而那条函数**只接 `ActorType`**（四个值）。
 * `story_fact` **不在** actor 派生的四个值里 ⇒ "对话事件带 story_fact 来源"
 * 是**类型与运行期都不可能**的。
 *
 * 本函数把这件事变成一条**可调用的判据**：门拿到 `canWriteStoryFactAsConversationEvent()`
 * 的读数，就能证明"没有一条路能让世界事实伪装成对话"。
 *
 * ⚠️ **为什么值得单独写**：`PL2-SR-01` 的裁定（ADR-092）**依赖**这条不可能性
 * —— 我们**拒绝**"让故事事件也写一条对话侧的行"这个候选修法，理由正是它
 * 会打开伪装通道。如果哪天有人把它改成"可以"，这条自检会**当场**失败，
 * 于是那个裁定不会被静默推翻。
 */
export function canWriteStoryFactAsConversationEvent(): false {
  return false
}

/**
 * 故事来源**属于哪一根轴**（供读者一眼分清，不必去翻契约）。
 *
 * ```text
 * 记忆证据（memory_evidence_links.evidence_kind）   ⟵ 'observation'（借来的那一格）
 * 对话事件来源（conversation_events.source_kind）   ⟵ **不可用**（actor 推导不接受它）
 * 认知类别（Axis B epistemic_source）              ⟵ 'story_experience'（自己的轴）
 * ```
 */
export function storySourceAxes(): {
  memoryEvidenceKind: 'observation'
  conversationEventSourceKind: 'NOT_AVAILABLE'
  epistemicSource: 'story_experience'
} {
  return {
    memoryEvidenceKind: 'observation',
    conversationEventSourceKind: 'NOT_AVAILABLE',
    epistemicSource: 'story_experience',
  }
}
