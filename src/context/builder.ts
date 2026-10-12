/**
 * Context Builder —— 每轮对话真正送给模型的东西。
 *
 * 这是 L1 方案里"后续所有层级都从这里扩展"的核心入口：
 *
 *   Context = Core Persona + Current State + Summary + Recent Messages + Input
 *
 * L1-M1 阶段实际生效的是其中三项：
 *   Core Persona   ← RECENT_MESSAGES / CHARACTER 等 provider 注入 state.text
 *   Recent Messages ← bootstrap 的 RECENT_MESSAGES provider
 *   Input          ← 当前用户消息
 *
 * Current State（持久化角色状态）与 Summary（滚动摘要）分别在 L1-M2 / L1-M4 接入，
 * 届时只需把新的 provider 注册进 runtime，本文件的骨架不需要改。
 */
import {
  composePromptFromState,
  messageHandlerTemplate,
  type AgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core'

/** 单个 provider 对本轮上下文的贡献（用于可观测性与排错） */
export interface ProviderContribution {
  name: string
  chars: number
}

export interface TurnContext {
  state: State
  /** 最终交给模型的提示词 */
  prompt: string
  /** 本轮上下文的组成明细 */
  contributions: ProviderContribution[]
  recentMessageCount: number
}

/**
 * 组装一轮对话的上下文。
 *
 * 注意：provider 的输出会被 core 合并进 `state.text`；`composePromptFromState`
 * 再用官方模板把它填成最终提示词。我们不做任何"手写 prompt 拼接"，
 * 以免后续接入 State/Memory provider 时被自己的拼接逻辑挤掉。
 */
export async function buildTurnContext(
  runtime: AgentRuntime,
  message: Memory,
  opts: {
    /** 只跑这些 provider（不传 = 全部可用 provider） */
    includeList?: string[]
    /** true = 白名单模式（只跑 includeList）；默认 false，即 includeList 为优先级提示 */
    onlyInclude?: boolean
  } = {}
): Promise<TurnContext> {
  // composeState 是 AgentRuntime 的实例方法（不是 core 的模块级导出）
  //
  // ⚠️ 一个实测踩到的坑：`composeState` 会按 **message.id 缓存 state**。
  //    用同一个 message 对象连续调用两次，第二次直接返回上一次的 provider 结果 →
  //    "白名单没生效"的假象。要对比不同 provider 组合，必须换 message.id
  //    （见 scripts/verify-provider-whitelist.ts）。
  const state = await runtime.composeState(
    message,
    opts.includeList,
    opts.onlyInclude ?? false
  )

  // composePromptFromState 只接受 { state, template }；
  // 当前用户输入由 provider（RECENT_MESSAGES / 消息自身）进入 state.text。
  const prompt = composePromptFromState({
    state,
    template: messageHandlerTemplate,
  })

  return {
    state,
    prompt,
    contributions: describeContributions(state),
    recentMessageCount: countRecentMessages(state),
  }
}

/** 从 state 里读出各 provider 的贡献大小，供日志与 Inspector 使用 */
function describeContributions(state: State): ProviderContribution[] {
  const providers = (state.data as { providers?: Record<string, unknown> } | undefined)
    ?.providers
  if (!providers) return []
  return Object.entries(providers)
    .map(([name, value]) => {
      const text =
        typeof value === 'string'
          ? value
          : typeof (value as { text?: unknown })?.text === 'string'
            ? String((value as { text: string }).text)
            : JSON.stringify(value ?? '')
      return { name, chars: text?.length ?? 0 }
    })
    .filter((c) => c.chars > 0)
    .sort((a, b) => b.chars - a.chars)
}

/** 粗略统计本轮注入的历史消息条数 */
function countRecentMessages(state: State): number {
  const text = typeof state.text === 'string' ? state.text : ''
  // bootstrap 的 RECENT_MESSAGES 用 "<name>: <text>" 逐行列出历史消息
  return text.split('\n').filter((line) => /^[^:\n]{1,40}:\s+\S/.test(line.trim())).length
}
