/**
 * Storyline —— 有限故事线的**受控词汇与来源身份**（后 Lv2 · S1 / Lv2.5）。
 *
 * ============================================================================
 *  载体：ADR-091 §2（世界边界）· §3（故事来源进入认知）
 *        计划书 §5（S1/Lv2.5）· 故事世界来源契约 S1–S12
 * ============================================================================
 * 这个模块是**纯契约**：不 import 框架、不碰 SQL、不碰文件系统
 * （与 `src/kernel/contracts/**`、`src/kernel/action/**`、`src/kernel/recall/**` 同纪律）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 铁律（INV-PL2-01…07）
 * ---------------------------------------------------------------------------
 *  · `storyline_events` **只由** Storyline 运行器追加；Character 从不写它（INV-PL2-01）。
 *  · 世界/剧情事实**永不**进入 `conversation_events` —— 不得伪装 `user_message`（INV-PL2-02）。
 *  · 来源身份是 `story:<storyId>@v<version>#<runId>.<eventId>`：
 *    可读、可人肉核对、**确定性**（同一条故事事件永远得到同一个来源 id），
 *    因此幂等与"这条记忆从哪来"不需要额外对照表。
 *  · 可见集合（`visibleEventIds`）**只增不减**，且 `visible ⊆ committed`：
 *    未选分支 / 作者后台设定 / 她未见到的事件 / 模型续写 **永不**因回放变成亲历（INV-PL2-07）。
 */

import { KernelError } from '../contracts/ids.ts'

// ---------------------------------------------------------------------------
// 受控词汇
// ---------------------------------------------------------------------------

/**
 * 故事事件种类（**受控登记表**，与 `ObservationType` / `DomainEventType` 同一个模式）。
 *
 * 为什么封闭而不是 `string`：这份清单就是"故事运行器允许写哪些事实"的唯一答案。
 * 开放成 string 之后，"某个模块手滑写了一种新故事事件、悄悄改变了世界语义"
 * 就不再可能被拦住 —— 而世界语义是最不该被悄悄改的东西。
 */
export type StorylineEventType =
  /** 故事开始（序章建立；引用已有 Seed 背景与用户陈述） */
  | 'STORY_STARTED'
  /** 阶段迁移（4 个阶段：确认目标 → 准备演练 → 参加合作 → 结果复盘） */
  | 'STAGE_ENTERED'
  /** 用户合法选择被提交（**唯一**推进剧情的方式之一） */
  | 'CHOICE_COMMITTED'
  /** 有限变量被确定性规则改写（范围由作者定义冻结） */
  | 'VARIABLE_CHANGED'
  /** 她可感知的剧情事件（进可见集合） */
  | 'EXPERIENCE_OBSERVED'
  /** 终局（三个候选结局之一） */
  | 'ENDING_REACHED'
  /** 用户明确退出（**不等于**被极创判定未通过） */
  | 'RUN_EXITED'

export const STORYLINE_EVENT_TYPES: readonly StorylineEventType[] = [
  'STORY_STARTED',
  'STAGE_ENTERED',
  'CHOICE_COMMITTED',
  'VARIABLE_CHANGED',
  'EXPERIENCE_OBSERVED',
  'ENDING_REACHED',
  'RUN_EXITED',
]

/** 阶段（计划书 §5.1：4 个阶段；本类型名进内容包，运行器只认登记值） */
export type StoryStageId = 'confirm_goal' | 'prepare_and_drill' | 'attend_interview' | 'result_and_review'

export const STORY_STAGE_IDS: readonly StoryStageId[] = [
  'confirm_goal',
  'prepare_and_drill',
  'attend_interview',
  'result_and_review',
]

/** 结局（计划书 §5.1 的三个候选 + 明确退出） */
export type StoryEndingId = 'passed_together' | 'pending_further_review' | 'not_passed_this_time' | 'exited_by_user'

export const STORY_ENDING_IDS: readonly StoryEndingId[] = [
  'passed_together',
  'pending_further_review',
  'not_passed_this_time',
  'exited_by_user',
]

/** 变量的值域（作者定义冻结；越界一律拒绝，不给"夹紧"） */
export type StoryVariableRange =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] }

export interface StoryVariableDefinition {
  name: string
  range: StoryVariableRange
  /** 初始值（必须落在 range 内；构造内容包时校验） */
  initial: number | boolean | string
}

// ---------------------------------------------------------------------------
// 来源身份
// ---------------------------------------------------------------------------

/**
 * 来源身份（**确定性**）的**语法定义已上移到契约层**（`contracts/source-authority.ts`）。
 *
 * ⚠️ 为什么搬走（2026-10-03 · S8/WP3，FC-T04 的模块边界锁**当场抓住**）：
 * 只读适配器 `src/infrastructure/persistence/reflection-lineage-read.ts` 需要解析
 * `story:<id>@v<n>#<run>.<event>` 来核对引用版本，而**白名单之外的模块不得直接 import
 * `kernel/storyline/**`**。来源 id 的语法本来就是**契约级事实**（它进 `EvidenceRef.id`），
 * 不是世界实现细节 ⇒ 它属于 `contracts/`，世界实现反过来引用它。
 *
 * 这里的重导出保留旧导入路径（`world-machine.ts` / `story-ledger.ts` / 各门都不用改）。
 */
export {
  makeStorySourceId,
  parseStorySourceId,
  isStorySourceId,
  type StorySourceIdParts as StorySourceIdentity,
  type StorySourceIdParts,
} from '../contracts/source-authority.ts'

function assertStorySlug(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(value)) {
    throw new KernelError(
      'validation_error',
      'bad_story_slug',
      `${label} 只允许字母数字与 _ -（长度 1..60），收到 ${JSON.stringify(value)}：` +
        '来源身份要能一眼读懂，不能靠转义'
    )
  }
}

// ---------------------------------------------------------------------------
// 作者定义的内容包（**世界边界**的机器可读形态）
// ---------------------------------------------------------------------------

export interface StoryNodeDefinition {
  id: string
  stage: StoryStageId
  /** 该节点的合法选择（frontier 的来源；运行器**只**接受这里的 id） */
  choices: readonly string[]
  /**
   * 该节点在她可感知范围内的剧情事件（进可见集合）。
   *
   * ⚠️ 这里**只列她见得到的**。隐藏节点、未选分支、结局条件**不得**出现在此。
   */
  visibleEvents: readonly string[]
}

/**
 * 一条**显式**迁移（契约 S4：模型不能新增地点、节点、人物、变量或结局，
 * 不能以任意 `ChoosePathString` 跳过剧情）。
 *
 * ⚠️ 这就是"不能跳过剧情"的机器形态：`from` + `choice` → `to` 由作者定义冻结，
 * **运行器与模型都只能提出**，最终由世界状态机按这张表判定。
 */
export interface StoryTransitionDefinition {
  from: string
  choice: string
  to: string
  /** 该步发生的变量改写（确定性；越界一律拒绝） */
  setVariables?: Readonly<Record<string, number | boolean | string>>
  /** 该步进入可见集合的剧情事件（**只列她见得到的**） */
  visibleEvents?: readonly string[]
  /** 该步达成的结局（没有就是没结束） */
  ending?: StoryEndingId
}

export interface StoryEndingDefinition {
  id: StoryEndingId
  /** 达成该结局的节点（图遍历的出口集合） */
  nodeId: string
}

/**
 * **确定性**结局迁移（契约 S4：模型不能新增结局，也不能挑结局）。
 *
 * ⚠️ 它与 `transitions` 分开是**故意**的：`transitions` 由**玩家选择**驱动，
 * `endingTransitions` 由 `resolveEnding()`（纯函数，按变量与已提交事件）驱动。
 * 混在一起就等于把"结局"降级成一个可以随便挑的选项 ——
 * 于是"模型说我们通过了"就成了合法推进。
 */
export interface StoryEndingTransition {
  from: string
  to: string
  ending: StoryEndingId
  /** 确定性判据名（进事件，便于审计"为什么是这个结局"） */
  rule: string
}

export interface StoryContentPack {
  storyId: string
  storyVersion: number
  /** 内容摘要（`sha256` 的十六进制；由编译/冻结步骤产生） */
  contentDigest: string
  title: string
  variables: readonly StoryVariableDefinition[]
  nodes: readonly StoryNodeDefinition[]
  /** 显式迁移表（**唯一**的剧情推进方式） */
  transitions: readonly StoryTransitionDefinition[]
  /** **确定性**结局迁移（由变量与已提交事件算出；不可由模型挑选） */
  endingTransitions: readonly StoryEndingTransition[]
  /** 起点节点 id */
  entryNodeId: string
  endings: readonly StoryEndingDefinition[]
  /** 可退出的节点（明确退出路径；**退出 ≠ 被判定未通过**） */
  exitNodes: readonly string[]
}

/**
 * 校验内容包（**失败关闭**）。
 *
 * 这是"世界边界"的机器判据本体：图有界、无未声明出口、变量值域合法、
 * 三结局齐全、起点与退出路径都在图里。任何一条不成立都**在构造期**就拒绝，
 * 而不是等到运行时发现"剧情可以走到一张没有声明的图上"。
 */
export function assertStoryContentPack(pack: StoryContentPack): void {
  assertStorySlug(pack.storyId, 'storyId')
  if (!Number.isSafeInteger(pack.storyVersion) || pack.storyVersion < 1) {
    throw new KernelError('validation_error', 'bad_story_version', 'storyVersion 必须是 >= 1 的安全整数')
  }
  if (!/^[0-9a-f]{8,64}$/.test(pack.contentDigest)) {
    throw new KernelError(
      'validation_error',
      'bad_content_digest',
      `contentDigest 必须是十六进制摘要（收到 ${JSON.stringify(pack.contentDigest)}）：` +
        '没有内容摘要就无法回答"这条经历读的是哪一版剧情"'
    )
  }

  const nodeIds = new Set<string>()
  for (const node of pack.nodes) {
    assertStorySlug(node.id, 'node.id')
    if (nodeIds.has(node.id)) {
      throw new KernelError('validation_error', 'duplicate_story_node', `节点 id 重复：${node.id}`)
    }
    nodeIds.add(node.id)
    if (!STORY_STAGE_IDS.includes(node.stage)) {
      throw new KernelError('validation_error', 'unknown_story_stage', `未登记的阶段：${String(node.stage)}`)
    }
    for (const choice of node.choices) assertStorySlug(choice, 'choice')
    for (const event of node.visibleEvents) assertStorySlug(event, 'visibleEvent')
  }

  if (!nodeIds.has(pack.entryNodeId)) {
    throw new KernelError('validation_error', 'story_entry_node_missing', `起点节点不在图中：${pack.entryNodeId}`)
  }
  for (const exit of pack.exitNodes) {
    if (!nodeIds.has(exit)) {
      throw new KernelError('validation_error', 'story_exit_node_missing', `退出节点不在图中：${exit}`)
    }
  }

  // 三个候选结局 + 显式退出 = 四个出口，一个都不能少（计划书 §5.1 / 契约 S2）
  for (const ending of STORY_ENDING_IDS) {
    if (!pack.endings.some((item) => item.id === ending)) {
      throw new KernelError(
        'validation_error',
        'story_ending_missing',
        `结局缺失：${ending}。三个候选结局与明确退出路径都要可达（契约 S2）`
      )
    }
  }
  for (const ending of pack.endings) {
    if (!nodeIds.has(ending.nodeId)) {
      throw new KernelError('validation_error', 'story_ending_node_missing', `结局节点不在图中：${ending.nodeId}`)
    }
  }

  // --- 确定性结局迁移：from 在图上、to 恰等于该结局的节点 -----------------------
  const endingNodes = new Map(pack.endings.map((ending) => [ending.id, ending.nodeId]))
  for (const transition of pack.endingTransitions) {
    if (!nodeIds.has(transition.from)) {
      throw new KernelError(
        'validation_error',
        'story_ending_transition_from_missing',
        `结局迁移起点不在图上：${transition.from}`
      )
    }
    const expectedNode = endingNodes.get(transition.ending)
    if (expectedNode === undefined) {
      throw new KernelError(
        'validation_error',
        'story_ending_transition_unknown_ending',
        `结局迁移用了未登记的结局：${String(transition.ending)}`
      )
    }
    if (transition.to !== expectedNode) {
      throw new KernelError(
        'validation_error',
        'story_ending_transition_node_mismatch',
        `结局 ${transition.ending} 的节点应是 ${expectedNode}，迁移却指向 ${transition.to}`
      )
    }
    if (transition.rule.trim() === '') {
      throw new KernelError('validation_error', 'story_ending_transition_without_rule', '结局迁移必须带确定性判据名')
    }
  }
  // 每个结局都必须有**至少一条**确定性迁移（否则那个结局是写不出来的死结局）
  for (const ending of pack.endings) {
    if (ending.id === 'exited_by_user') continue // 退出走 RUN_EXITED，不靠变量判定
    if (!pack.endingTransitions.some((transition) => transition.ending === ending.id)) {
      throw new KernelError(
        'validation_error',
        'story_ending_unreachable',
        `结局 ${ending.id} 没有任何确定性迁移（契约 S2：三个候选结局都要可达）`
      )
    }
  }
  // 退出路径必须有节点（退出 ≠ 被判定未通过）
  if (pack.exitNodes.length === 0) {
    throw new KernelError('validation_error', 'story_no_exit_node', '必须至少声明一个可退出节点（契约 S2）')
  }

  const names = new Set<string>()
  for (const variable of pack.variables) {
    assertStorySlug(variable.name, 'variable.name')
    if (names.has(variable.name)) {
      throw new KernelError('validation_error', 'duplicate_story_variable', `变量重名：${variable.name}`)
    }
    names.add(variable.name)
    if (!variableValueInRange(variable.range, variable.initial)) {
      throw new KernelError(
        'validation_error',
        'story_variable_initial_out_of_range',
        `变量 ${variable.name} 的初值越界：${JSON.stringify(variable.initial)}`
      )
    }
  }

  // --- 迁移表：键唯一、两端在图上、不指向终局之外、变量与可见事件合法 -------------
  const byNode = new Map(pack.nodes.map((node) => [node.id, node]))
  const transitionKeys = new Set<string>()
  for (const transition of pack.transitions) {
    const key = `${transition.from}\u0000${transition.choice}`
    if (transitionKeys.has(key)) {
      throw new KernelError(
        'validation_error',
        'duplicate_story_transition',
        `同一 (from, choice) 有两条迁移：${transition.from} + ${transition.choice}`
      )
    }
    transitionKeys.add(key)

    if (!nodeIds.has(transition.from)) {
      throw new KernelError('validation_error', 'story_transition_from_missing', `迁移起点不在图上：${transition.from}`)
    }
    if (!nodeIds.has(transition.to)) {
      throw new KernelError('validation_error', 'story_transition_to_missing', `迁移终点不在图上：${transition.to}`)
    }
    if (!byNode.get(transition.from)!.choices.includes(transition.choice)) {
      throw new KernelError(
        'validation_error',
        'story_transition_choice_undeclared',
        `迁移用了节点 ${transition.from} 未声明的选择：${transition.choice}`
      )
    }
    for (const [name, value] of Object.entries(transition.setVariables ?? {})) {
      const definition = variableDefinitionOf(pack, name)
      if (!definition) {
        throw new KernelError(
          'validation_error',
          'story_transition_variable_undeclared',
          `迁移写入了未声明的变量：${name}（INV-PL2-06：模型不能新增变量）`
        )
      }
      if (!variableValueInRange(definition.range, value)) {
        throw new KernelError(
          'validation_error',
          'story_transition_variable_out_of_range',
          `迁移把 ${name} 写成越界值：${JSON.stringify(value)}（值域由作者定义冻结，不做夹紧）`
        )
      }
    }
    for (const event of transition.visibleEvents ?? []) {
      assertStorySlug(event, 'transition.visibleEvent')
      if (!byNode.get(transition.to)!.visibleEvents.includes(event)) {
        throw new KernelError(
          'validation_error',
          'story_transition_event_not_visible_at_target',
          `迁移声明的可见事件 ${event} 不在目标节点 ${transition.to} 的可见集合里`
        )
      }
    }
    if (transition.ending !== undefined && !STORY_ENDING_IDS.includes(transition.ending)) {
      throw new KernelError('validation_error', 'unknown_story_ending', `未登记的结局：${String(transition.ending)}`)
    }
  }

  // --- 每个非终局节点的每个选择都必须有迁移（否则会出现"声明了但走不通"的死边） ---
  const endingNodeIds = new Set(pack.endings.map((ending) => ending.nodeId))
  const exitNodeIds = new Set(pack.exitNodes)
  for (const node of pack.nodes) {
    const terminal = endingNodeIds.has(node.id) || exitNodeIds.has(node.id)
    if (terminal && node.choices.length > 0 && !node.choices.every((choice) => transitionKeys.has(`${node.id}\u0000${choice}`))) {
      const dead = node.choices.filter((choice) => !transitionKeys.has(`${node.id}\u0000${choice}`))
      throw new KernelError(
        'validation_error',
        'story_dead_choice',
        `终局/退出节点 ${node.id} 有走不通的选择：${JSON.stringify(dead)}`
      )
    }
    if (!terminal) {
      const dead = node.choices.filter((choice) => !transitionKeys.has(`${node.id}\u0000${choice}`))
      if (dead.length > 0) {
        throw new KernelError(
          'validation_error',
          'story_dead_choice',
          `节点 ${node.id} 有走不通的选择：${JSON.stringify(dead)}（契约 S1：不存在未声明主线出口）`
        )
      }
    }
  }
}

/**
 * 全图可达性（契约 `S1`：不存在未声明主线出口）。
 *
 * 从 `entryNodeId` 出发沿迁移表遍历，返回**可达**节点集合。
 * 不可达的节点是"作者以为存在但玩家永远到不了"的死重 —— 门会把它报出来。
 */
export function reachableNodeIds(pack: StoryContentPack): Set<string> {
  const reachable = new Set<string>([pack.entryNodeId])
  const queue = [pack.entryNodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const neighbours: string[] = []
    for (const transition of pack.transitions) if (transition.from === current) neighbours.push(transition.to)
    for (const transition of pack.endingTransitions) if (transition.from === current) neighbours.push(transition.to)
    for (const node of neighbours) {
      if (reachable.has(node)) continue
      reachable.add(node)
      queue.push(node)
    }
  }
  return reachable
}

export function variableValueInRange(
  range: StoryVariableRange,
  value: number | boolean | string
): boolean {
  switch (range.kind) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max
    case 'bool':
      return typeof value === 'boolean'
    case 'enum':
      return typeof value === 'string' && range.values.includes(value)
    default: {
      const exhaustive: never = range
      throw new KernelError('validation_error', 'unknown_variable_range', String(exhaustive))
    }
  }
}

export function variableDefinitionOf(
  pack: StoryContentPack,
  name: string
): StoryVariableDefinition | undefined {
  return pack.variables.find((variable) => variable.name === name)
}

export function nodeDefinitionOf(
  pack: StoryContentPack,
  nodeId: string
): StoryNodeDefinition | undefined {
  return pack.nodes.find((node) => node.id === nodeId)
}
