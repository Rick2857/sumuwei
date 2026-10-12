/**
 * **S8 / ADR-094 `R-3`** —— 故事可见条目的**生产渲染器**（程序渲染，**不是**模型续写）。
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 *  `ADR-093 D10` 逐字要求：故事条目在反思窗口里的正文来自"**程序渲染**的可见条目文本"。
 *  而装配里一直没有这个渲染器 ⇒ 反射那一路接不上（`L-S8-29`）。
 *  更早的教训也在案：第一版在 `buildReflectionInput` 里拼**占位符**，
 *  于是窗口里一点经历内容都没有，语义 macro-F1 掉到 **0.34**（`S8-WP7` 交接单 §0.3）。
 *
 * ============================================================================
 *  三条硬纪律
 * ============================================================================
 * ```text
 * ① 文本**只**来自本表（作者定义、随内容包版本走），**不**来自模型、**不**现编：
 *    `renderStoryVisibleEvent()` 只做查表 —— 查不到就**抛错**
 * ② **失败关闭**：未知 id ⇒ 抛错，**绝不**回退成占位符或原样返回 id
 *    （占位符正是让"没内容"看起来像"有内容"的那种失败）
 * ③ 完整性自检：`assertRendererCoversPack()` 逐条核对"包里每个 visibleEvent 都有文本"，
 *    漏一条即抛 —— 否则漏掉的那些会在运行时才暴露，而且暴露成"她好像没经历过"
 * ```
 *
 * ⚠️ 来源纪律（沿用内容包 §12）：这些句子描述**她见到的模拟考核场景**，
 * 属 `story-authored`，**不**宣称是极创真实场地或真实规则。
 */

import type { StoryContentPack } from '../../../kernel/storyline/story-types.ts'

/**
 * 可见事件 id ⇒ **程序渲染的正文**。
 *
 * ⚠️ 改这里的文本 = 改内容 ⇒ 必须与内容包一起升 `storyVersion`
 *    （否则来源身份会说谎：`CONTENT_DIGEST` 是对 `.ink` 源算的）。
 */
export const JICHUANG_VISIBLE_EVENT_TEXT: Readonly<Record<string, string>> = {
  s1_intro: '她和你一起报名了极创工作室的二面，两人把各自的空闲时间对了一遍。',
  s1_intro_met: '面试前一天，她和你见了面，说好第二天一起过去。',
  s1_align: '你们开始分工：谁先答、谁补充、遇到不会的怎么接。',
  s1_align_done: '分工说定了，她把两人各自负责的部分复述了一遍确认没听岔。',
  s1_scope: '她问了这次二面大概会考什么范围。',
  s1_scope_known: '你们对考核范围有了一个大致的说法，虽然并不完全确定。',
  s2_prepare: '准备阶段开始，她把要带的东西列了个单子。',
  s2_prepare_started: '她按单子把资料和作品集分开放好。',
  s2_drill: '你们互相模拟了一遍可能被问到的问题。',
  s2_drill_done: '模拟结束，她记下了两处自己答得不利索的地方。',
  s3_attend: '二面当天，你们一起到了场地外面。',
  s3_attend_entered: '你们被带进等候区，她把资料又核对了一遍。',
  s3_qa: '轮到她回答提问了。',
  s3_qa_asked: '她答完，评委追问了一个她没准备到的细节。',
  s4_result: '结果出来了。',
  s4_result_reached: '你们一起看到了这次二面的结果。',
  /*
   * ⚠️ 四个**结局**条目是自检抓出来的（第一版漏了它们）：完整性自检逐条核对
   *    "包里每个 visibleEvent 都有正文"，漏一条即抛。若没有这道自检，
   *    它们会在运行时才暴露，而且暴露成"她好像没走到那一步"。
   */
  ending_passed_together: '这次模拟二面，你们一起通过了。',
  ending_pending_review: '这次模拟二面进了待定，还没给准信。',
  ending_not_passed: '这次模拟二面没有通过。',
  ending_exited_by_user: '这次模拟二面提前结束了。',
}

/**
 * 渲染一个可见条目。
 *
 * ⚠️ **失败关闭**：未知 id ⇒ 抛错。**绝不**返回占位符 —— 那会让"没内容"看起来像"有内容"。
 */
export function renderStoryVisibleEvent(eventId: string): string {
  const text = JICHUANG_VISIBLE_EVENT_TEXT[eventId]
  if (text === undefined) {
    throw new Error(
      `S8 渲染器：可见事件 ${JSON.stringify(eventId)} 没有程序渲染正文。` +
        '按 ADR-093 D10 与 ADR-094 R-3，**不许**回退成占位符或原样返回 id —— ' +
        '漏一条就必须在这里失败，而不是让窗口里出现"看起来有内容"的空话。'
    )
  }
  return text
}

/**
 * 渲染一批可见条目并按包里的顺序拼接（`separator` 由调用方给，缺省换行）。
 */
export function renderStoryVisibleEvents(
  eventIds: readonly string[],
  separator = '\n'
): string {
  return eventIds.map((id) => renderStoryVisibleEvent(id)).join(separator)
}

const JICHUANG_CHOICE_TEXT: Readonly<Record<string, string>> = {
  ask_scope: '先把二面的范围问清楚', align_first: '先对齐分工的意愿', review_first: '直接开始准备',
  go_prepare: '继续做准备', split_by_strength: '按各自的长处分工', improvise: '不排练，临场应变',
  after_drill_go: '演练结束，去参加二面', speak_up: '主动回答', follow_partner: '让搭档先回答，自己补充',
  take_over: '自己接管回答', acknowledge_fix: '承认不足，一起补上', defend_alone: '独自坚持原来的答案',
}

/** 本文全部来自内容资产；候选单列，不能把未选分支说成已发生。 */
export function renderStoryDailyScene(state: {
  readonly currentNodeId: string; readonly visibleEventIds: readonly string[]; readonly terminal: boolean
}, choices: readonly string[]): string {
  const options = choices.map(id => {
    const text = JICHUANG_CHOICE_TEXT[id]
    if (text === undefined) throw new Error(`故事选项 ${id} 缺少内容资产正文`)
    return `${id}：${text}`
  })
  return [
    '《一起去参加极创工作室的二面》：这是模拟共同故事，模拟结果不代表现实录取。',
    `当前场景：${state.currentNodeId}${state.terminal ? '（本次故事已结束）' : ''}`,
    '已提交且她可见的经历：', renderStoryVisibleEvents(state.visibleEventIds),
    options.length === 0 ? '当前没有待选选项。' : `当前可选，尚未发生，不替用户选：\n${options.join('\n')}`,
  ].join('\n')
}

/**
 * **完整性自检**：包里每个 `visibleEvents` 条目都必须有正文。
 *
 * ⚠️ 它是**计数型**自检，因此必须自证"检查了 > 0 项"（AGENTS §6.8）：
 *    一个 visibleEvent 都没读到 ⇒ 抛错（`MEASUREMENT INVALID`），**不是**通过。
 */
export function assertRendererCoversPack(pack: StoryContentPack): { checked: number } {
  const ids = new Set<string>()
  for (const node of pack.nodes) {
    for (const id of node.visibleEvents ?? []) ids.add(id)
  }
  if (ids.size === 0) {
    throw new Error('S8 渲染器自检：内容包里一个 visibleEvent 都没读到 ⇒ MEASUREMENT INVALID（不是通过）')
  }
  const missing = [...ids].filter((id) => JICHUANG_VISIBLE_EVENT_TEXT[id] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `S8 渲染器自检：${String(missing.length)} 个可见事件缺正文 —— ${missing.join(', ')}。` +
        '漏掉的那些会在运行时才暴露，而且暴露成"她好像没经历过"。'
    )
  }
  return { checked: ids.size }
}
