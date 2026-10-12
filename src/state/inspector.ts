/**
 * State Inspector —— 最小可观察性界面。
 *
 * ============================================================================
 *  为什么 L1 就要做这个
 * ============================================================================
 * 方案里写得很直接：这个东西对开发的价值甚至大于展示价值。
 * 没有它，你迟早会遇到「苏沐薇为什么突然生气了？」然后完全查不出来。
 *
 * 它同时也是 L1-M2 验收的核心工具：验收要求是
 * 「手工修改数据库里的状态值后，她的回复发生符合逻辑的明显变化」——
 * 改完值靠它确认，看完再回去对话。
 *
 * 展示三类信息（对应方案第 13、14 节）：
 *   1. 四个变量当前的数值 + 条形图
 *   2. 距上次互动多久、衰减结算了什么
 *   3. 最近的 state_events：before → after、变化量、以及**变更理由**
 */

import { applyDecay, describeDecay } from './decay.ts'
import { loadState, recentStateEvents } from './repository.ts'
import type { CharacterState } from './types.ts'

function bar(value: number, min: number, max: number, width = 10): string {
  const ratio = (value - min) / (max - min)
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function signed(x: number, digits = 3): string {
  return (x >= 0 ? '+' : '') + x.toFixed(digits)
}

function renderCurrent(state: CharacterState): string {
  const lines: string[] = []
  lines.push('苏沐薇 State')
  lines.push('──────────────────────────────')
  lines.push('')
  lines.push('情绪（快变量：小时级衰减回中性）')
  lines.push(`  Valence   ${bar(state.valence, -1, 1)}  ${signed(state.valence, 2)}`)
  lines.push(`  Arousal   ${bar(state.arousal, 0, 1)}   ${state.arousal.toFixed(2)}`)
  lines.push('')
  lines.push('关系（慢变量：只有 closeness 会被时间侵蚀）')
  lines.push(`  Trust     ${bar(state.trust, 0, 1)}   ${state.trust.toFixed(2)}`)
  lines.push(`  Closeness ${bar(state.closeness, 0, 1)}   ${state.closeness.toFixed(2)}`)
  lines.push('')
  lines.push(`  Version   ${state.version}`)
  return lines.join('\n')
}

export interface InspectOptions {
  /** 事件条数 */
  events?: number
  /** 是否结算挂钟衰减后再展示（默认true，展示的是"此刻"的状态） */
  settleDecay?: boolean
}

/** 生成 Inspector 文本（纯展示，不写库） */
export async function renderInspector(
  runtime: Parameters<typeof loadState>[0],
  characterId: string,
  userId: string,
  options: InspectOptions = {}
): Promise<string> {
  const now = Date.now()
  const snapshot = await loadState(runtime, characterId, userId, now)

  let current = snapshot
  let decayLine = '（未结算衰减，展示的是上次互动结束时的快照）'

  if (options.settleDecay !== false) {
    const result = applyDecay(snapshot, now)
    current = result.state
    const minutes = (now - snapshot.lastInteractionAt) / 60000
    decayLine = `距上次互动 ${minutes < 60 ? `${minutes.toFixed(0)} 分钟` : `${(minutes / 60).toFixed(1)} 小时`}；衰减结算：${describeDecay(result)}`
  }

  const parts = [renderCurrent(current), '', '挂钟衰减', `  ${decayLine}`]

  const events = await recentStateEvents(runtime, characterId, userId, options.events ?? 8)
  parts.push('', '最近的变更（state_events）')
  if (events.length === 0) {
    parts.push('  （暂无变更记录）')
  } else {
    for (const e of events) {
      const when = new Date(e.createdAt).toLocaleString('zh-CN', { hour12: false })
      const deltaText = Object.entries(e.delta)
        .map(([k, v]) => `${k} ${signed(v)}`)
        .join('，')
      const fromTo = Object.entries(e.after)
        .filter(([k]) => ['valence', 'arousal', 'trust', 'closeness'].includes(k))
        .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
        .join(' ')
      parts.push(`  · [${when}] [${e.trigger}] ${deltaText}`)
      parts.push(`      理由：${e.reason}`)
      parts.push(`      结果：${fromTo}`)
    }
  }

  return parts.join('\n')
}
