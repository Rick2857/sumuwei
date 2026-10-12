/**
 * ★ S2（2026-10-10，ADR-129 D01–D03）：**提醒走哪个出口** —— 冻结纯函数。
 *
 * ============================================================================
 *  裁定（用户 2026-10-10，正面推翻 ADR-124 D2 的一条）
 * ============================================================================
 *  ADR-124 D2 原文：「其他渠道返回未支持；当前运行方式没有的出口返回未配置，**不静默改投**。」
 *  现裁定：
 *    · 默认出口 = QQ（未指定即默认；指定则按指定）；
 *    · **明确指定的出口不可用时，适用同一规则：改投 + 说明**（不区分默认/指定）；
 *    · "不可用" = **用户收不到**（渠道没开 / 发送失败 / 页面没开）；
 *    · 改投成功同样记"已送达"（送达记账**不看方法/过程**）。
 *
 * ============================================================================
 *  为什么是"纯函数 + 可返回 undefined"
 * ============================================================================
 *  ① 纯函数 ⇒ 门可以直接三段式量到它（判据不能只活在装配层；先例 `precheckCareOpportunity`）。
 *  ② **返回 `undefined` = "判不了，请调用方保持既有行为"**：
 *     `available`（本运行方式支持的出口）缺席时不猜、不改投、不静默丢弃 ——
 *     这样"接线只做一半"也**不会**改变任何既有行为（旧路径与旧门逐字不变）。
 *
 *  ⚠️ 边界：用户点名**闭集外**的渠道（"unsupported"，例如微信）也按"不可用"处理 ⇒ 改投 + 说明；
 *     但**绝不**把 'unsupported' 写进 `PendingReminder.channel`（那里只收闭集内的渠道，类型上就不允许）。
 */

import { type ChatChannel } from '../../contracts/chat-channel.ts'

/** 未指定渠道时的固定倾向（与 ADR-129 D02 的"默认 QQ"一致） */
const PREFERENCE: readonly ChatChannel[] = ['qq_private', 'avatar', 'cli']

/** 用户原话点名的渠道（含两个非渠道值） */
export type RequestedChannel = ChatChannel | 'current' | 'unsupported'

export interface ReminderChannelChoice {
  /** 真正要投递的渠道（**闭集内**，可直接写进 PendingReminder.channel） */
  readonly channel: ChatChannel
  /** 非空 ⇒ 这是一次**改投**：原定的渠道不可用（供事实/说明文案用） */
  readonly fallbackFrom?: ChatChannel
  /** true ⇒ 用户点名了一个**闭集外**的渠道（说明文案要说"不支持"，而不是说"没开"） */
  readonly requestedUnsupported?: boolean
}

/**
 * 决定提醒的出口。`undefined` = **判不了**（`available` 缺席）⇒ 调用方保持既有行为。
 *
 * 选择规则（全确定性）：
 * ```text
 * 目标 = requested === 'current' ? (entry ?? 'qq_private')
 *      : requested === undefined ? 'qq_private'
 *      : requested === 'unsupported' ? 无（闭集外）
 * 目标在 available 里            ⇒ { channel: 目标 }（不改投）
 * 否则（目标不可用 / 闭集外）      ⇒ 候选 = [entry, ...PREFERENCE] 中**可用且不等于目标**的第一个
 *                                  命中 ⇒ 改投；一个都没有 ⇒ undefined（调用方照旧走具名拒绝，
 *                                  绝不静默丢弃、也绝不硬塞一个不可用渠道）
 * ```
 */
export function chooseReminderChannel(input: {
  requested?: RequestedChannel
  entry?: ChatChannel
  available?: readonly ChatChannel[]
}): ReminderChannelChoice | undefined {
  const available = input.available
  /* 判据缺席 ⇒ 不猜（保持既有行为） */
  if (available === undefined || available.length === 0) return undefined

  const requested = input.requested
  const unsupported = requested === 'unsupported'
  const target: ChatChannel | undefined = unsupported
    ? undefined
    : requested === undefined || requested === 'current'
      ? (requested === 'current' ? (input.entry ?? 'qq_private') : 'qq_private')
      : requested

  if (target !== undefined && available.includes(target)) return { channel: target }

  for (const candidate of [input.entry, ...PREFERENCE]) {
    if (candidate === undefined) continue
    if (candidate === target) continue
    if (!available.includes(candidate)) continue
    return {
      channel: candidate,
      ...(target === undefined ? {} : { fallbackFrom: target }),
      ...(unsupported ? { requestedUnsupported: true } : {}),
    }
  }
  /* 一个可用出口都没有：**不静默丢弃** —— 交给调用方按具名拒绝处理（D01/R1 的失败侧） */
  return undefined
}
