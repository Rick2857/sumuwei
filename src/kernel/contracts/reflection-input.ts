/**
 * M11 WP3 —— **反思输入契约**（ADR-085 §4.1 · §6.2 · §7.1 · `D14` · `D15` · `D30`）。
 *
 * ============================================================================
 *  这个文件回答两个问题
 * ============================================================================
 * ```text
 * ① "这一轮**该不该**反思？"      —— 触发是**确定性**的（`D15`）：没有这些输入就不调模型。
 * ② "反思**能看到**什么？"        —— 一个**有界**窗口 + **程序提供**的 handle 集合
 *                                    + 每个来源的**真实版本与资格**（`D06` / `M11-D07`）。
 * ```
 *
 * ============================================================================
 *  三条硬边界（判据，不是注释）
 * ============================================================================
 * ① **触发靠领域事实，不靠词形**：映射表的左边是**既有领域事件类型**（更正 → `MEMORY_RETRACTED`
 *    的 `explicit_correction`；目标结果 → `GOAL_COMPLETED` / `GOAL_BLOCKED` / …）。
 *    不在表里的事件 ⇒ **不触发**（不是"猜一猜"）。`user_feedback` 这一条 v1 **没有**
 *    确定性检测器 ⇒ 它登记在案但**不可达**，由 `REFLECTION_TRIGGER_FACTS` 逐条写明。
 * ② **窗口有界**：≤ `REFLECTION_MAX_WINDOW_INPUTS`（`D30` 的 50）；超出的留在下一次触发，
 *    **不**截断后假装看全了。
 * ③ **标签分列**：五类来源标签（草案契约里那五类）在输入里就分好，**不让模型自己归类**
 *    （`D14`：`user_report` 与 `program_result` 混成一个"事实"就是把 M10 的边界吃掉）。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import {
  BELIEF_DISPUTED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_FULFILLED,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  MEMORY_DISPUTED,
  MEMORY_RETRACTED,
} from './domain-event.ts'
import {
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_NODES,
  type LineageHandleKind,
  type LineageSourceClass,
} from './reflection-lineage.ts'

// ---------------------------------------------------------------------------
// 触发（`D15`：确定性、有限）
// ---------------------------------------------------------------------------

export type ReflectionTriggerKind =
  | 'user_correction'
  | 'user_feedback'
  | 'goal_outcome'
  | 'commitment_outcome'
  | 'registered_conflict'
  | 'safety_invalidation'
  /** **S8 / ADR-093 `D10`**：一条**已提交**的故事结果（真实用户交互产生的世界变更） */
  | 'story_outcome'

export const REFLECTION_TRIGGER_KINDS: readonly ReflectionTriggerKind[] = [
  'user_correction',
  'user_feedback',
  'goal_outcome',
  'commitment_outcome',
  'registered_conflict',
  'safety_invalidation',
  'story_outcome',
]

/** 触发检测器读到的**最小**领域事件形状（只读；不要 payload 正文）。 */
export interface ReflectionTriggerEventReading {
  readonly id: string
  readonly type: string
  readonly sequence: number
  /** 只有 `MEMORY_RETRACTED` 需要它（`explicit_correction` / `explicit_forget` / `audit`） */
  readonly reason?: string
  /**
   * 这条领域事件引用的**真实对话事件**（原话）。
   *
   * ⚠️ 它进窗口是因为"触发事件的原话"是反思最直接的一手材料；
   *    它**不是**可选的装饰 —— 缺了它，窗口里就只剩派生节点。
   */
  readonly sourceConversationEventIds: readonly string[]
}

/** 对话事件的最小读数（**不含正文**）。 */
export interface ReflectionConversationReading {
  readonly id: string
  readonly actorType: string
  /** 实际来源会话；缺失时不推定会话归属。 */
  readonly conversationId?: string
  /** 角色级全局序号（真实值，不是占位） */
  readonly sequence: number
  /**
   * **有界正文**（≤ `REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS`）。
   *
   * ⚠️ WP3 第一版**没有**这个字段（当时写的是"不要正文"）—— 那是一个**真缺陷**：
   *    模型只拿到 id / 版本 / 来源类，**根本无从反思**（`L-M11-14`）。
   *    计划 §7.2 的上限是"候选模型输入最多 6000 **token**"，而 token 度量的是**文本**。
   *    ⇒ 补上有界正文；遮蔽由**装配层**在进窗口之前完成（见 `maskedIds`）。
   */
  readonly text: string
}

export interface ReflectionTrigger {
  readonly kind: ReflectionTriggerKind
  /** 触发它的**真实**领域事件 id（可追溯） */
  readonly eventId: string
  readonly sequence: number
}

/**
 * 每个触发种类的**可达性事实**（沿用 `memory-record-status.ts` 的纪律）。
 *
 * ⚠️ `user_feedback` 的 `v1Detectable = false` 是**如实登记**，不是待办装饰：
 *    它意味着"这一条今天不会被触发"，因此它**不会**出现在任何一次输入里 ——
 *    谁要统计"反馈类触发有多少"，必须先看这一行。
 */
export interface ReflectionTriggerFact {
  readonly v1Detectable: boolean
  readonly detector: string
  readonly howToReach: string
}

export const REFLECTION_TRIGGER_FACTS: Readonly<Record<ReflectionTriggerKind, ReflectionTriggerFact>> = {
  user_correction: {
    v1Detectable: true,
    detector: 'detectReflectionTriggers · MEMORY_RETRACTED(reason=explicit_correction)',
    howToReach: '用户显式更正之后，M4 的撤回事件落在窗口里',
  },
  user_feedback: {
    v1Detectable: false,
    detector: '（v1 无确定性检测器）',
    howToReach:
      '**v1 不可达**：显式反馈的识别是语义问题（词形判据会误触发，M5.5.1 的 L-M55-15 已登记）；本里程碑不猜',
  },
  goal_outcome: {
    v1Detectable: true,
    detector: 'detectReflectionTriggers · GOAL_COMPLETED / GOAL_BLOCKED / GOAL_CANCELLED',
    howToReach: '目标有了明确结果（完成 / 受阻 / 取消）',
  },
  commitment_outcome: {
    v1Detectable: true,
    detector:
      'detectReflectionTriggers · COMMITMENT_FULFILLED / COMMITMENT_BROKEN / COMMITMENT_CANCELLED',
    howToReach: '承诺有了明确结果',
  },
  registered_conflict: {
    v1Detectable: true,
    detector: 'detectReflectionTriggers · MEMORY_DISPUTED / BELIEF_DISPUTED',
    howToReach: '已有登记的矛盾证据（M4 / M9 的 disputed）',
  },
  safety_invalidation: {
    v1Detectable: true,
    detector: 'detectReflectionTriggers · MEMORY_RETRACTED(reason=explicit_forget)',
    howToReach: '显式遗忘 —— 这一步**不需要模型**（`D12`：先阻断上下文，再补落账）',
  },
  story_outcome: {
    v1Detectable: true,
    detector: 'buildReflectionInput · storyOutcomes（已提交且合格的世界账本提交）',
    howToReach:
      '真实用户提交了一次故事选择，而世界账本里**已经有**那条提交（ADR-093 `D10`）。' +
      '⚠️ 它**不是**词形检测器：合格性来自程序事实（`interaction_kind = user_choice` + 服务端绑定的真实会话），' +
      '因此 `user_feedback` 的 `v1Detectable = false` **不被它推翻**（ADR-093 §0.3）。',
  },
}

/** 事件类型 → 触发的**确定性映射**（不在表里的类型不产生任何触发）。 */
export const REFLECTION_TRIGGER_BY_EVENT_TYPE: Readonly<Record<string, ReflectionTriggerKind>> = {
  [GOAL_COMPLETED]: 'goal_outcome',
  [GOAL_BLOCKED]: 'goal_outcome',
  [GOAL_CANCELLED]: 'goal_outcome',
  [COMMITMENT_FULFILLED]: 'commitment_outcome',
  [COMMITMENT_BROKEN]: 'commitment_outcome',
  [COMMITMENT_CANCELLED]: 'commitment_outcome',
  [MEMORY_DISPUTED]: 'registered_conflict',
  [BELIEF_DISPUTED]: 'registered_conflict',
}

/**
 * 从一批领域事件里检测触发（**纯函数**）。
 *
 * 顺序：先按序号升序，再逐条查表；`MEMORY_RETRACTED` 按 `reason` **细分**
 * （`explicit_correction` ⇒ 更正 · `explicit_forget` ⇒ 失效 · `audit` ⇒ 不触发）。
 *
 * ⚠️ 之所以把 `audit` 排除：审计性撤回**不是**用户给她的信号，把它读成"反馈"
 *    会让反思凭空多出一个来源（`D14` 要防的正是"把不同来源混成一个"）。
 */
export function detectReflectionTriggers(
  events: readonly ReflectionTriggerEventReading[]
): readonly ReflectionTrigger[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  const triggers: ReflectionTrigger[] = []
  for (const event of sorted) {
    if (event.type === MEMORY_RETRACTED) {
      if (event.reason === 'explicit_correction') {
        triggers.push({ kind: 'user_correction', eventId: event.id, sequence: event.sequence })
      } else if (event.reason === 'explicit_forget') {
        triggers.push({ kind: 'safety_invalidation', eventId: event.id, sequence: event.sequence })
      }
      continue
    }
    const kind = REFLECTION_TRIGGER_BY_EVENT_TYPE[event.type]
    if (kind !== undefined) triggers.push({ kind, eventId: event.id, sequence: event.sequence })
  }
  return triggers
}

// ---------------------------------------------------------------------------
// 输入窗口与 handle
// ---------------------------------------------------------------------------

/** `D30` 冻结的容量上限。 */
export const REFLECTION_MAX_WINDOW_INPUTS = 50
/**
 * 每条窗口条目的正文上界（码点）。
 *
 * ⚠️ 它是**每条**的上界，不是总量上界；总量由 `D30` 的 6000 token 约束，
 *    由适配器按条渲染时的既有形状保证（`m11:inputs:verify` 断言每条不超）。
 */
export const REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS = 300
/**
 * 被遮蔽条目的**唯一**正文形态。
 *
 * ⚠️ 用**常量**而不是空串：空串与"这条本来就是空的"无法区分，而遮蔽是**一个事实**。
 */
export const REFLECTION_WINDOW_MASKED_TEXT = '（已遮蔽：来源被遗忘或撤回）'

/** 窗口里的一条**合格输入**（只带程序事实，不带正文）。 */
export interface ReflectionWindowEntry {
  /** 稳定 id（`<kind>:<id>` 的形状由装配层决定） */
  readonly id: string
  readonly kind: LineageHandleKind
  /** 真实版本（记忆 / 信念 / 目标各自的 revision；对话事件用它的序号） */
  readonly revision: number
  /** 程序给的来源类标签（`D14`：五类分列，模型不得自己归类） */
  readonly sourceClass: LineageSourceClass
  /** 只传播已读取的来源会话，渲染时使用窗口内别名。 */
  readonly conversationId?: string
  /** 它是不是本次触发的一部分 */
  readonly fromTrigger: boolean
  /**
   * **有界正文**（≤ `REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS`）。
   *
   * ⚠️ 被遮蔽的条目在这里**只能是** `REFLECTION_WINDOW_MASKED_TEXT` 这个常量标记
   *    —— 原文**不得**出现在这个字段里（§6.3：遮蔽先于注入）。
   */
  readonly text: string
}

/** 交给模型的 handle（**只有**程序担保的这些）。 */
export interface ReflectionInputHandle {
  readonly kind: LineageHandleKind
  readonly id: string
  readonly sourceClass: LineageSourceClass
}

export interface ReflectionInput {
  readonly characterId: string
  /** 首次建立的结构性边界（`D33`：不是投影字段） */
  readonly cutoverSequence: number
  /** 本窗口读到的领域事件水位下界（下一次触发的起点） */
  readonly watermarkFrom: number
  /** 本窗口读到的领域事件水位上界 */
  readonly watermarkTo: number
  readonly triggers: readonly ReflectionTrigger[]
  readonly window: readonly ReflectionWindowEntry[]
  readonly handles: readonly ReflectionInputHandle[]
  /** 窗口被容量上限截过没有（`D30`；截了就是"还有没看的"，不是"看全了"） */
  readonly windowTruncated: boolean
  /** 本次真的读了几条记录（`measured_count` 自检的输入） */
  readonly measuredCount: number
}

/** 输入装配的**只读**端口（唯一取数边界；实现里才有 SQL）。 */
export interface ReflectionInputSource {
  /** 自 `afterSequence`（不含）之后的领域事件，按序号升序，至多 `limit` 条 */
  domainEventsSince(
    afterSequence: number,
    limit: number
  ): Promise<readonly ReflectionTriggerEventReading[]>
  /** 按 id 取对话事件的最小信息（**不要正文**） */
  conversationActors(
    ids: readonly string[]
  ): Promise<readonly ReflectionConversationReading[]>
}

/** 派生的来源类：对话事件按 `actorType`，其余按调用方给的程序事实。 */
export function sourceClassOfActor(actorType: string): LineageSourceClass {
  if (actorType === 'character' || actorType === 'assistant') return 'assistant_speech'
  if (actorType === 'tool') return 'program_result'
  if (actorType === 'user') return 'user_statement'
  return 'internal_interpretation'
}

/** 遍历上限（与根解析共用 `D30` 的冻结值）。 */
export const REFLECTION_INPUT_MAX_DEPTH = LINEAGE_MAX_DEPTH
export const REFLECTION_INPUT_MAX_NODES = LINEAGE_MAX_NODES
