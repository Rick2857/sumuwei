/**
 * 挂钟时间（wall-clock）衰减。
 *
 * ============================================================================
 *  为什么必须是挂钟时间，而不是「每轮乘个系数」
 * ============================================================================
 * 按轮次衰减意味着：聊一百句，她情绪就平静了；三个月一句话不说，状态纹丝不动。
 * 这与真实感完全相反——苏沐薇「受不了长时间分开」，恰恰是**时间流逝本身**要产生
 * 后果。所以衰减以真实经过的毫秒数为唯一依据，与对话轮数无关。
 *
 * ---------------------------------------------------------------------------
 *  两条核心规则
 * ---------------------------------------------------------------------------
 *
 * 1. 情绪是快变量：valence / arousal 按小时级指数衰减，回归中性。
 *
 *      next = neutral + (current - neutral) · e^(−λ · 经过小时数)
 *
 *    取 λ_valence = ln2/4 ≈ 0.173 → 半衰期 4 小时
 *       λ_arousal = ln2/5 ≈ 0.139 → 半衰期 5 小时
 *    即：一次争吵的怒气，大半天后基本平复。
 *
 * 2. 关系是慢变量，且**只有亲近感会被时间侵蚀，信任不会**。
 *
 *      超过 24 小时无互动后，closeness 才开始下行，速率 0.02 / 天；
 *      trust 完全不随时间变化。
 *
 *    这个不对称是刻意的，也是角色设定的一部分：
 *    她因为你不在而难受，是**想你**（closeness ↓），不是**开始不信你**（trust →）。
 *    把「疏远」和「失信」混进同一个变量，系统就解释不了自己为什么这样回应。
 *    「你答应了却没出现」这类真正影响信任的情况，属于**事件**，
 *    由 L1-M3 的 Evaluator 走 delta 通道扣 trust，与时间衰减是两条独立路径。
 *
 * 3. 衰减**不可逆**：久别之后 closeness 掉下去，不会因为你回来就自动回弹，
 *    必须靠真实互动重新累积。这正是「可以解释的连续性」的来源。
 *
 * ---------------------------------------------------------------------------
 *  什么时候结算衰减
 * ---------------------------------------------------------------------------
 * 状态在数据库里是**上一次互动结束时的快照**；衰减在每次读取时按经过的真实
 * 时间结算（惰性结算）。这样无需后台定时任务，也不会因为进程没运行而漏算——
 * 关掉程序三个月再打开，账照样算得清。
 */

import {
  clampVariable,
  type CharacterState,
  type StateVariable,
} from './types.ts'

export interface DecayConfig {
  /** 情绪半衰期（小时） */
  valenceHalfLifeHours: number
  arousalHalfLifeHours: number
  /** 超过多少小时无互动，closeness 开始下行 */
  absenceThresholdHours: number
  /** closeness 下行速率（每天） */
  closenessLossPerDay: number
  /** 情绪回归的目标值（中性） */
  valenceNeutral: number
  arousalNeutral: number
}

export const DEFAULT_DECAY: DecayConfig = {
  valenceHalfLifeHours: 4,
  arousalHalfLifeHours: 5,
  absenceThresholdHours: 24,
  closenessLossPerDay: 0.02,
  valenceNeutral: 0,
  arousalNeutral: 0,
}

export interface DecayResult {
  state: CharacterState
  /** 本次结算实际发生的变化，用于日志与 Inspector 展示 */
  applied: {
    hoursElapsed: number
    /** 被衰减的变量及变化量（负数表示下降） */
    deltas: Partial<Record<StateVariable, number>>
    /** 是否触发了「长时间分开」 */
    absenceTriggered: boolean
    absentHours: number
  }
}

/** 指数衰减到中性 */
function decayTowardNeutral(
  value: number,
  neutral: number,
  halfLifeHours: number,
  hours: number
): number {
  if (hours <= 0) return value
  const lambda = Math.LN2 / halfLifeHours
  return neutral + (value - neutral) * Math.exp(-lambda * hours)
}

/**
 * 结算从 `state.lastInteractionAt` 到 `now` 之间的挂钟衰减。
 *
 * 纯函数：不读写数据库、不产生副作用，方便单测与 Inspector 复用。
 */
export function applyDecay(
  state: CharacterState,
  now: number = Date.now(),
  config: DecayConfig = DEFAULT_DECAY
): DecayResult {
  const elapsedMs = Math.max(0, now - state.lastInteractionAt)
  const hours = elapsedMs / 3_600_000

  const deltas: Partial<Record<StateVariable, number>> = {}

  // --- 1. 情绪：快变量，小时级回归中性 ---
  const nextValence = decayTowardNeutral(
    state.valence,
    config.valenceNeutral,
    config.valenceHalfLifeHours,
    hours
  )
  const nextArousal = decayTowardNeutral(
    state.arousal,
    config.arousalNeutral,
    config.arousalHalfLifeHours,
    hours
  )

  const valenceDelta = nextValence - state.valence
  const arousalDelta = nextArousal - state.arousal
  if (Math.abs(valenceDelta) > 1e-6) deltas.valence = valenceDelta
  if (Math.abs(arousalDelta) > 1e-6) deltas.arousal = arousalDelta

  // --- 2. 关系：只有 closeness 被时间侵蚀，trust 不动 ---
  let nextCloseness = state.closeness
  let absenceTriggered = false
  let absentHours = 0

  if (hours > config.absenceThresholdHours) {
    absenceTriggered = true
    // 超出阈值的部分才算「分开太久」，阈值内属正常间隔
    absentHours = hours - config.absenceThresholdHours
    const loss = (absentHours / 24) * config.closenessLossPerDay
    nextCloseness = state.closeness - loss
    if (Math.abs(loss) > 1e-6) deltas.closeness = -loss
  }

  return {
    state: {
      ...state,
      valence: clampVariable('valence', nextValence),
      arousal: clampVariable('arousal', nextArousal),
      closeness: clampVariable('closeness', nextCloseness),
      // trust 原样保留 —— 时间不改变信任
      updatedAt: now,
      version: state.version + 1,
    },
    applied: {
      hoursElapsed: hours,
      deltas,
      absenceTriggered,
      absentHours,
    },
  }
}

/** 供日志/Inspector 使用的人类可读描述 */
export function describeDecay(result: DecayResult): string {
  const { hoursElapsed, deltas, absenceTriggered, absentHours } = result.applied
  if (hoursElapsed < 1 / 60) return '（几乎无时间流逝）'

  const parts: string[] = [`经过 ${hoursElapsed.toFixed(2)} 小时`]
  const dv = deltas.valence
  const da = deltas.arousal
  const dc = deltas.closeness
  if (dv !== undefined) parts.push(`valence ${dv >= 0 ? '+' : ''}${dv.toFixed(4)}`)
  if (da !== undefined) parts.push(`arousal ${da >= 0 ? '+' : ''}${da.toFixed(4)}`)
  if (absenceTriggered) {
    parts.push(`已分开 ${absentHours.toFixed(1)} 小时，closeness ${(dc ?? 0).toFixed(4)}`)
  }
  if (parts.length === 1) parts.push('无变化')
  return parts.join('，')
}
