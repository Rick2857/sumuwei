/**
 * post-Lv2 / **ADR-109 `D02`** —— **入口作用域**（会话 id 的入口分量）。
 *
 * ============================================================================
 *  它回答的问题
 * ============================================================================
 *
 * ```text
 * 今天：`dm-<slug>-<userHash8>`  —— 三条入口（CLI / QQ 私聊 / 皮套）**共用**它
 *      ⇒ "她看到的近期对话"是角色级的，谁说的话都进同一个窗口（WP0 §5/§6 R1）
 * ```
 *
 * 本模块把**入口**变成会话 id 的一个分量，于是近期对话 / 会话摘要 / 任务上下文
 * 按入口分开，而长期记忆、语义索引、信念、关系、情绪、目标与故事**仍然共享**
 * （ADR-109 `D04`：共享认知、分开近期）。
 *
 * ----------------------------------------------------------------------------
 *  三条纪律
 * ----------------------------------------------------------------------------
 * ① **入口由程序事实决定，不由载荷决定**（`D02`）。
 *    这里的 `ChatEntryKey` 只该由装配层（argv / 监听端口 / 认证结果）产生；
 *    外部昵称、persona、conversationId、消息角色字段**不能**传进来选会话。
 * ② **CLI 逐字不变**：`cli` 的后缀是空串 ⇒ 打开开关也不改变 CLI 的会话 id
 *    （ADR-109 §2「CLI 原会话语义保持原样」）。
 * ③ **关着开关 ⇒ 与 M3 起逐字相同**：`entryScoped: false` 时三条入口都得到
 *    今天那个 id。于是这个模块可以在**不改变任何现有行为**的前提下落地，
 *    激活是独立裁定（先例 ADR-048）。
 */

import { asConversationId, type ConversationId } from '../../kernel/contracts/ids.ts'
import type { ConversationEntryMode } from './conversation-attribution.ts'

/**
 * 入口键。
 *
 * ⚠️ 它是**闭集**且**只有三个**：新增入口要新增一个键 + 一个具名归因 ingress，
 *    不得引入一个"可配置的入口字符串"（那就等于让载荷选会话）。
 */
export type { ChatChannel as ChatEntryKey } from '../../kernel/contracts/chat-channel.ts'
import type { ChatChannel as ChatEntryKey } from '../../kernel/contracts/chat-channel.ts'

export interface ChatEntryScope {
  readonly key: ChatEntryKey
  /**
   * 会话 id 的后缀。
   *
   * ⚠️ `cli` 是**空串**：CLI 的会话 id 因此在开关打开后仍然逐字等于
   *    `dm-<slug>-<userHash8>`（ADR-109 §2 的冻结口径）。
   * ⚠️ 另外两条入口拿到**新的**近期会话 ⇒ 切换那一刻它们的近期窗口是空的
   *    （长期记忆与认知仍在）。这是**计划选定**的后果，必须如实登记。
   */
  readonly conversationSuffix: string
  /** 账本 `transport` 字段（沿用既有两值：CLI/皮套 = `cli`，QQ = `qq`） */
  readonly transport: 'cli' | 'qq'
  /** 本入口的**具名归因 ingress**（`D02`：一个入口一个具名工厂） */
  readonly attributionEntryMode: ConversationEntryMode
  /** 日志/证据用标签（**不含**任何身份） */
  readonly label: string
}

/**
 * 三个入口的作用域表。
 *
 * ⚠️ `avatar` 今天沿用 `interactive_human_console` 归因入口（与皮套既有行为一致）。
 *    "给皮套一个独立具名 ingress" 是**已登记的未做项**：它要先回答
 *    "ASR 转写出来的话算不算 `authenticated_human_input`" 这个**认知资格**问题
 *    （打字与说话不是同一件事）。在那之前**不**擅自新增一个声称 confirmed 的入口。
 */
export const CHAT_ENTRY_SCOPES: Readonly<Record<ChatEntryKey, ChatEntryScope>> = Object.freeze({
  cli: Object.freeze({
    key: 'cli' as const,
    conversationSuffix: '',
    transport: 'cli' as const,
    attributionEntryMode: 'interactive_human_console' as const,
    label: 'CLI（人类控制台）',
  }),
  qq_private: Object.freeze({
    key: 'qq_private' as const,
    conversationSuffix: '-qq',
    transport: 'qq' as const,
    attributionEntryMode: 'interactive_human_qq_private' as const,
    label: 'QQ 私聊（本人）',
  }),
  avatar: Object.freeze({
    key: 'avatar' as const,
    conversationSuffix: '-avatar',
    transport: 'cli' as const,
    attributionEntryMode: 'interactive_human_console' as const,
    label: '皮套（Live2D 外壳）',
  }),
})

/** 全部入口键（顺序固定；门与证据按它枚举） */
export const CHAT_ENTRY_KEYS: readonly ChatEntryKey[] = Object.freeze(['cli', 'qq_private', 'avatar'])

/**
 * 由 `(角色 slug, 用户哈希, 入口, 开关)` 推导会话 id —— **纯函数**。
 *
 * ```text
 * entryScoped = false  ⇒  dm-<slug>-<userHash8>                （三条入口同一个，今天的行为）
 * entryScoped = true   ⇒  cli   : dm-<slug>-<userHash8>        （逐字不变）
 *                         qq    : dm-<slug>-<userHash8>-qq
 *                         avatar: dm-<slug>-<userHash8>-avatar
 * ```
 *
 * ⚠️ `userHash8` 由调用方算好（`stringToUuid('user-<name>').slice(0,8)`）——
 *    本模块**不**依赖 elizaos，也不读环境：它要能被门直接单测。
 */
export function conversationIdForEntry(input: {
  readonly slug: string
  readonly userHash8: string
  readonly entry: ChatEntryKey
  readonly entryScoped: boolean
}): ConversationId {
  const legacy = `dm-${input.slug}-${input.userHash8}`
  if (!input.entryScoped) return asConversationId(legacy)
  const suffix = CHAT_ENTRY_SCOPES[input.entry].conversationSuffix
  return asConversationId(suffix === '' ? legacy : `${legacy}${suffix}`)
}

/**
 * 由**入口模式 + 是不是桥入口**反推入口键。
 *
 * ⚠️ 两个事实一起决定，缺一个就会算错：
 * ```text
 *   `--qq-private`        ⇒ qq_private（QQ 私聊）
 *   有位置参数             ⇒ scripted_agent_runner（一次性脚本；归 cli）
 *   其余 + `--bridge`     ⇒ avatar（**皮套外壳**）
 *   其余（无 `--bridge`） ⇒ cli（交互式控制台）
 * ```
 * ⚠️ 为什么必须把 `--bridge` 算进来（2026-10-06 激活前实测发现的缺口）：
 *    皮套**两种连法**都叫 `interactive_human_console` ——
 *    自起子进程档（`scripts/postlv2-bridge-production.ts`）与连接档（`--coexist`）。
 *    只看 `entryMode` 的话，自起档会落到 `cli` ⇒ **同一个皮套写进两条不同的会话**，
 *    而连接档写 `-avatar`。那会让"她刚才在皮套里说过什么"取决于外壳怎么连的 ——
 *    连接方式是**接线**，不该改变会话归属。
 */
export function chatEntryKeyOfMode(
  mode: ConversationEntryMode,
  options: { bridgeEntry?: boolean } = {}
): ChatEntryKey {
  switch (mode) {
    case 'interactive_human_qq_private':
      return 'qq_private'
    case 'scripted_agent_runner':
      return 'cli'
    case 'interactive_human_console':
      return options.bridgeEntry === true ? 'avatar' : 'cli'
  }
}
