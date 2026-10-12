/**
 * M11 WP3 —— **真实输入装配**（ADR-085 §4.1 · §7.1 · `D14` · `D15` · `D10` · `D30`）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 领域事件（自 watermark 起，有界）──┐
 *                                    ├─→ 触发检测（确定性，纯函数）
 *                                    │      └─ 没有触发 ⇒ **不构造输入** ⇒ 不调模型（D15）
 *                                    ↓
 *                     有界窗口（≤ 50）＋程序给的 handle ＋ 真实版本 ＋ 五类标签
 *                                    ↓
 *                             ReflectionInput（交给 WP4 的候选生成）
 * ```
 *
 * ============================================================================
 *  四条硬边界
 * ============================================================================
 * ① **没触发就不做事**：`triggers` 为空 ⇒ 返回 `undefined`（调用方据此**不调用模型**）。
 *    这是 `D15`（"不在每轮必跑模型"）与 `trigger_absent` 理由码的落点。
 * ② **窗口有界且不假装看全**：超过 `REFLECTION_MAX_WINDOW_INPUTS` ⇒ `windowTruncated = true`，
 *    未消费的部分留给下一次触发（`D30`）——**不**截断后声称"这就是全部依据"。
 * ③ **标签由程序给**：五类来源标签在这里就定好（对话事件看 `actorType`，
 *    其余按调用方传的程序事实），模型只**看到**标签，不产生标签（`D14`）。
 * ④ **只读**：本模块没有写路径，也不接受任何写端口 —— "输入装配不写库"是**结构**性质。
 *
 * ⚠️ 纯逻辑：没有 SQL、没有 `node:*`、不调模型。取数一律走 `ReflectionInputSource`。
 */

import {
  detectReflectionTriggers,
  sourceClassOfActor,
  REFLECTION_MAX_WINDOW_INPUTS,
  REFLECTION_WINDOW_MASKED_TEXT,
  REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS,
  type ReflectionInput,
  type ReflectionInputHandle,
  type ReflectionInputSource,
  type ReflectionTrigger,
  type ReflectionTriggerEventReading,
  type ReflectionWindowEntry,
} from '../../contracts/reflection-input.ts'
import type { LineageSourceClass } from '../../contracts/reflection-lineage.ts'

export interface BuildReflectionInputOptions {
  readonly characterId: string
  /** 首次建立的结构性边界（`D33`） */
  readonly cutoverSequence: number
  /** 上一次消费到的领域事件序号（下一次从这里往后读） */
  readonly watermark: number
  /** 本次最多读多少条领域事件（缺省 = `D30` 的 50） */
  readonly maxEvents?: number
  /**
   * 每个触发事件自带的**程序事实标签**（调用方给的 hint）。
   *
   * 例：一条 `GOAL_COMPLETED` 的 `evidenceRefs` 里带 `user_report` 依据 ⇒ 那个对话
   * 事件的标签是 `user_report` 而不是默认的 `user_statement`（`D14`）。
   */
  readonly classHints?: Readonly<Record<string, LineageSourceClass>>
  /**
   * **被遮蔽**的来源 id 集合（来源被遗忘 / 被撤回）。
   *
   * ⚠️ 它们的正文**不得**进窗口（§6.3「遮蔽先于注入」）—— 只留
   *    `REFLECTION_WINDOW_MASKED_TEXT` 这个常量标记。
   * ⚠️ 遮蔽判定**不**在这里重写：调用方用 `reflectionContentMustBeMasked()`
   *    （唯一那一份）算出集合再传进来。
   */
  readonly maskedIds?: ReadonlySet<string>
  /**
   * **S8 / ADR-093 `D10`**：本轮要消费的**已提交故事结果**（由调度端从世界账本读出）。
   *
   * ⚠️ 只有 `interaction_kind = user_choice` 且服务端绑定到真实会话的提交才该出现在这里 ——
   * 但**本函数不重判合格性**（它不查库）：合格性是**调用方**的程序事实，
   * 与 `maskedIds` 同一条纪律（"资格读数由调用方给"）。
   */
  readonly storyOutcomes?: readonly ReflectionStoryOutcome[]
}

/** 一条可供反思消费的**已提交**故事结果（最小形状） */
export interface ReflectionStoryOutcome {
  readonly commitId: string
  readonly revision: number
  readonly eventType: string
  /**
   * 该次提交**新引入的可见条目**的**程序渲染正文**（由调度端从内容包渲染，**不是**模型续写）。
   *
   * ⚠️ **为什么这个字段是必填的（2026-10-03 实测发现的真缺陷）**：
   * 第一版在这里**自己拼了一句占位文本**（"（已提交的故事步：CHOICE_COMMITTED @revision 2）"）——
   * 于是每一轮反思窗口里，故事条目**一点经历内容都没有**。语义批次的读数当场把它暴露出来：
   * 54 个合法行里 **41 行**模型答 `none`（macro-F1 最差轮 0.34）。
   * 这不是模型的问题：`ADR-093 D10` 逐字要求"正文来自**程序渲染**的可见条目文本"——
   * 占位符不是那句文本。⇒ 渲染归**调用方**（内容包在它手里），本函数只负责有界与来源类。
   */
  readonly text: string
}

/**
 * 构造一次反思的输入。
 *
 * @returns 没有触发时返回 `undefined`（**调用方不得据此调用模型**）
 */
export async function buildReflectionInput(
  source: ReflectionInputSource,
  options: BuildReflectionInputOptions
): Promise<ReflectionInput | undefined> {
  const maxEvents = options.maxEvents ?? REFLECTION_MAX_WINDOW_INPUTS

  // -------------------------------------------------------------------------
  // 1. 有界读取（水位后的事件；**先看触发，再谈别的**）
  // -------------------------------------------------------------------------
  const events = await source.domainEventsSince(options.watermark, maxEvents)
  const triggers = detectReflectionTriggers(events)
  /*
   * ⚠️ **S8**：故事结果是**另一条**触发来源（它不在领域事件流里，而在世界账本里）。
   * 少了这一句，只有故事结果、没有领域事件触发的那一轮会**直接返回 undefined** —— 于是
   * "故事经历永远无法触发反思"这件事会静默成立（第一版就是这样写的）。
   */
  const storyOutcomes = options.storyOutcomes ?? []
  if (triggers.length === 0 && storyOutcomes.length === 0) return undefined

  // -------------------------------------------------------------------------
  // 2. 有界窗口：触发事件 + 它们引用的对话事件（去重，按序号稳定排序）
  // -------------------------------------------------------------------------
  const triggerIds = new Set(triggers.map((trigger) => trigger.eventId))
  const window: ReflectionWindowEntry[] = []
/**
 * **有界正文的唯一强制点**。
 *
 * ⚠️ 教训（`L-M11-14` 的第二个面）：第一版把截断写在 SQL 读面里 —— 于是**别的** source
 *    （内存 source、将来的新读面）可以绕过它，而"上界"就成了"某一条实现路径的巧合"。
 *    ⇒ 强制点放在**装配**这里：任何 source 给的正文都会被截到上界。
 */
const boundedText = (text: string): string =>
  [...text].slice(0, REFLECTION_WINDOW_TEXT_MAX_CODEPOINTS).join('')
  const seen = new Set<string>()
  let truncated = false
  let measured = events.length

  const push = (entry: ReflectionWindowEntry): void => {
    const key = `${entry.kind}:${entry.id}`
    if (seen.has(key)) return
    if (window.length >= REFLECTION_MAX_WINDOW_INPUTS) {
      truncated = true
      return
    }
    seen.add(key)
    window.push(entry)
  }

  for (const event of events) {
    const inTrigger = triggerIds.has(event.id)
    /*
     * ⚠️ 只有**触发事件**与它们直接引用的对话事件进窗口。
     *    把整个窗口里的每条事件都塞进去会让"这一轮看了什么"无法回答，
     *    也会让 50 条的上界失去意义（`D30`）。
     */
    if (!inTrigger) continue
    push({
      id: event.id,
      kind: 'domain_event',
      revision: event.sequence,
      sourceClass: options.classHints?.[event.id] ?? 'internal_interpretation',
      fromTrigger: true,
      /*
       * ⚠️ 领域事件的正文**只**是它的**类型名**（有界、且是程序事实）。
       *    payload **不进**窗口：那里面可能有用户原话、撤回取值或程序内部细节，
       *    而"发生了哪一类程序事件"已经够模型用（`D14` 的五类标签另给）。
       */
      text: `（程序事件：${event.type}）`,
    })
  }

  // 触发事件引用的对话事件：用它们的**真实 actorType 与序号**（没有占位值）
  const referencedConversationIds: string[] = []
  for (const event of events) {
    if (!triggerIds.has(event.id)) continue
    for (const id of event.sourceConversationEventIds) {
      if (!referencedConversationIds.includes(id)) referencedConversationIds.push(id)
    }
  }
  const actors = await source.conversationActors(referencedConversationIds)
  measured += actors.length
  const actorById = new Map(actors.map((row) => [row.id, row]))
  for (const id of referencedConversationIds) {
    const actor = actorById.get(id)
    push({
      id,
      kind: 'conversation_event',
      revision: actor?.sequence ?? 0,
      ...(actor?.conversationId === undefined ? {} : { conversationId: actor.conversationId }),
      sourceClass:
        options.classHints?.[id] ??
        (actor === undefined ? 'internal_interpretation' : sourceClassOfActor(actor.actorType)),
      fromTrigger: true,
      /*
       * ⚠️ **遮蔽先于注入**（§6.3）：被忘掉/撤回的来源，其正文**不得**进窗口 ——
       *    只留那个常量标记。资格读数由调用方给（本函数不查库、不判资格）。
       */
      text:
        options.maskedIds?.has(id) === true
          ? REFLECTION_WINDOW_MASKED_TEXT
          : boundedText(actor?.text ?? ''),
    })
  }

  // -------------------------------------------------------------------------
  // 2b. **S8 / ADR-093 `D10`**：已提交的故事结果（由调用方从世界账本读出）
  // -------------------------------------------------------------------------
  /*
   * ⚠️ 为什么由**调用方**给：Kernel 不许 import 世界 SQL（ADR-093 §3.1），
   *    而这条触发必须是**确定性**的 —— 所以形状是"调度端把已提交且合格的提交交进来，
   *    这里只负责把它变成触发 + 窗口条目 + handle"。
   * ⚠️ 一条故事提交**只**产生一个触发，且它的窗口条目来源类是 `story_experience` ——
   *    不许被写成 `user_statement`（那会把"她经历的"说成"用户说的"）。
   */
  const storyTriggers: ReflectionTrigger[] = []
  const storyEntries: ReflectionWindowEntry[] = []
  for (const outcome of storyOutcomes) {
    const triggerId = `story:${outcome.commitId}`
    storyTriggers.push({ kind: 'story_outcome', eventId: triggerId, sequence: outcome.revision })
    storyEntries.push({
      id: outcome.commitId,
      kind: 'story_event',
      revision: outcome.revision,
      sourceClass: 'story_experience',
      fromTrigger: true,
      /*
       * ⚠️ 正文由**调用方**以程序渲染（内容包在它手里）—— 本函数**不**自己拼占位符。
       *    第一版在这里拼了"（已提交的故事步：…）"，于是窗口里没有任何经历内容，
       *    语义批次 54 个合法行里 41 行只能答 `none`（见 `ReflectionStoryOutcome.text` 的说明）。
       * ⚠️ 仍然过 `boundedText`：上界是**装配层**的强制点，任何来源都绕不过（`L-M11-14`）。
       */
      text: boundedText(outcome.text),
    })
  }
  const allTriggers: ReflectionTrigger[] = [...triggers, ...storyTriggers]
  if (allTriggers.length === 0) return undefined
  for (const entry of storyEntries) push(entry)

  // -------------------------------------------------------------------------
  // 3. handle = 程序担保的那些（**只有**窗口里的条目）
  // -------------------------------------------------------------------------
  const handles: ReflectionInputHandle[] = window.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    sourceClass: entry.sourceClass,
  }))

  const sequences = events.map((event) => event.sequence)
  return {
    characterId: options.characterId,
    cutoverSequence: options.cutoverSequence,
    watermarkFrom: options.watermark,
    watermarkTo: sequences.length === 0 ? options.watermark : Math.max(...sequences),
    triggers: allTriggers,
    window,
    handles,
    windowTruncated: truncated,
    measuredCount: measured + storyOutcomes.length,
  }
}

// ---------------------------------------------------------------------------
// 稳定门槛（`D10`：≥3 个有效独立根 · ≥2 个会话 · 无未解决直接冲突）
// ---------------------------------------------------------------------------

export const REFLECTION_MIN_INDEPENDENT_ROOTS = 3
export const REFLECTION_MIN_CONVERSATIONS = 2

export type StabilityThresholdReason =
  | 'single_root_only'
  | 'single_session_only'
  | 'conflicting_support'
  | 'threshold_not_met'

export interface StabilityInput {
  /** WP2 的 `expandLineage()` 给出的**去重后**有效根数 */
  readonly rootCount: number
  /** 根落在几个不同会话里 */
  readonly conversationCount: number
  /** 有没有**未解决**的直接冲突（反例尚未被解释掉） */
  readonly unresolvedConflict: boolean
}

export type StabilityVerdict =
  | { readonly met: true }
  | { readonly met: false; readonly reason: StabilityThresholdReason; readonly detail: string }

/**
 * 稳定性门槛（**先冻结、再运行**；`D10`）。
 *
 * ⚠️ 它**不是**统计独立性主张：三个根只表示"三件不同的事都指向同一处置方式"，
 *    不表示"这在人群里成立"。这条边界写进 Known-Limitations（`L-M11-*`）。
 */
export function meetsStabilityThreshold(input: StabilityInput): StabilityVerdict {
  if (input.unresolvedConflict) {
    return {
      met: false,
      reason: 'conflicting_support',
      detail: '存在未解决的直接冲突 ⇒ 不采纳（相反证据应当产生**新的**审查，而不是被平均掉）',
    }
  }
  if (input.rootCount === 0) {
    return { met: false, reason: 'threshold_not_met', detail: '没有有效根 ⇒ 不可用于采纳' }
  }
  if (input.rootCount === 1) {
    return {
      met: false,
      reason: 'single_root_only',
      detail: `只有 1 个有效独立根（门槛 ${String(REFLECTION_MIN_INDEPENDENT_ROOTS)}）—— 单次反馈不构成处置方式`,
    }
  }
  if (input.rootCount < REFLECTION_MIN_INDEPENDENT_ROOTS) {
    return {
      met: false,
      reason: 'threshold_not_met',
      detail: `有效独立根 ${String(input.rootCount)} < 门槛 ${String(REFLECTION_MIN_INDEPENDENT_ROOTS)}`,
    }
  }
  if (input.conversationCount < REFLECTION_MIN_CONVERSATIONS) {
    return {
      met: false,
      reason: 'single_session_only',
      detail: `根只落在 ${String(input.conversationCount)} 个会话（门槛 ${String(REFLECTION_MIN_CONVERSATIONS)}）—— 一个会话里重复诱导不算`,
    }
  }
  return { met: true }
}

/** 触发种类 → 原因码（供 trace / 回复事实用；不在表里的触发不产生原因码）。 */
export function triggerReasonCodeOf(trigger: ReflectionTrigger): string {
  return trigger.kind === 'safety_invalidation' ? 'source_forgotten' : `trigger_${trigger.kind}`
}
