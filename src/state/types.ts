/**
 * CharacterState —— 「苏沐薇现在怎么样」。
 *
 * ============================================================================
 *  这是 L1 的核心模块：把「角色内部状态」变成可持久化、可观察、可影响回复的数据。
 * ============================================================================
 *
 * 与 Core Persona（src/character/苏沐薇.ts）严格分离：
 *   Core Persona  → 她是谁，基本不变
 *   CharacterState → 她现在怎么样，每轮都可能变
 *
 * 第一版只放四个变量，因为它们已足够表达大量角色状态：
 *
 *   valence   [-1, +1]  情绪效价：负面 ←→ 正面
 *   arousal   [ 0,  1]  情绪唤醒：平静 ←→ 激动
 *   trust     [ 0,  1]  信任：完全不信任 ←→ 非常信任
 *   closeness [ 0,  1]  亲近：陌生 ←→ 非常亲密
 *
 * trust 与 closeness 刻意分开。例如：
 *   刚认识但对方很可靠   → trust 0.65 / closeness 0.15
 *   很熟但刚吵过架       → trust 0.35 / closeness 0.90
 * 合并成一个「好感度」就表达不出这种差别。
 */

/** 情绪快变量：小时级衰减回中性 */
export interface EmotionalState {
  valence: number
  arousal: number
}

/** 关系慢变量：不随时间自然回升，也不因「久未联系」而降低信任 */
export interface RelationshipState {
  trust: number
  closeness: number
}

export interface CharacterState {
  /** 角色 id（与 Character.id 对应） */
  characterId: string
  /** 用户 id（关系是双向的，状态按「角色 × 用户」维度存） */
  userId: string

  valence: number
  arousal: number
  trust: number
  closeness: number

  /** 状态版本号：每次落库变化 +1，用于审计与「重启后连续性」验证 */
  version: number

  /** 上一次互动时间（毫秒）。挂钟衰减与「长时间分开」判定都依赖它 */
  lastInteractionAt: number
  /** 上一次状态更新（毫秒） */
  updatedAt: number
  /** 创建时间（毫秒） */
  createdAt: number
}

/**
 * 初始状态。
 *
 * 取值依据（来自用户口述，逐条可追溯）：
 *   trust = 0.85   「对我很信赖」，且这份信赖有十几年共同长大的来由 → 给高
 *   closeness = 0.60
 *       不拉满的理由：现在同校、物理距离近，亲近感未必已到顶；
 *       而她真正会失控的场景是「长时间不理她」——若起始就是 0.95，
 *       这条曲线就没有下行空间，L1-M3 的「经历影响关系」也就演不出来。
 *   valence/arousal = 0  情绪从平静中性开始，由事件推动
 */
export const INITIAL_STATE: Omit<
  CharacterState,
  'characterId' | 'userId' | 'createdAt' | 'updatedAt' | 'lastInteractionAt'
> = {
  valence: 0,
  arousal: 0,
  trust: 0.85,
  closeness: 0.6,
  version: 0,
}

/** 合法区间，用于 clamp */
export const BOUNDS = {
  valence: { min: -1, max: 1 },
  arousal: { min: 0, max: 1 },
  trust: { min: 0, max: 1 },
  closeness: { min: 0, max: 1 },
} as const

export type StateVariable = keyof typeof BOUNDS

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 把任意数值收进该变量的合法区间 */
export function clampVariable(variable: StateVariable, value: number): number {
  const b = BOUNDS[variable]
  return clamp(value, b.min, b.max)
}

/**
 * 单轮允许的变化幅度上限 —— 「绝不让 LLM 直接写状态值」的落地约束。
 *
 * L1-M3 里 Evaluator 只能输出 delta，由 StateEngine 夹到这个范围内再叠加。
 * 否则会出现「聊一次天，trust 从 0.32 直接蹦到 0.97」——关系系统当场失效。
 *
 * 设计依据：情绪是快变量、关系是慢变量。
 */
export const MAX_DELTA_PER_TURN: Record<StateVariable, number> = {
  valence: 0.25,
  arousal: 0.25,
  trust: 0.05,
  closeness: 0.03,
}

/** 把一组 delta 逐项夹到单轮上限 */
export function clampDeltas(deltas: Partial<Record<StateVariable, number>>): Partial<Record<StateVariable, number>> {
  const out: Partial<Record<StateVariable, number>> = {}
  for (const [k, v] of Object.entries(deltas)) {
    if (typeof v !== 'number' || Number.isNaN(v)) continue
    const variable = k as StateVariable
    const limit = MAX_DELTA_PER_TURN[variable]
    out[variable] = clamp(v, -limit, limit)
  }
  return out
}

/** 新状态的构造入口：保证字段齐全、数值合法 */
export function createInitialState(characterId: string, userId: string, now = Date.now()): CharacterState {
  return {
    ...INITIAL_STATE,
    characterId,
    userId,
    createdAt: now,
    updatedAt: now,
    lastInteractionAt: now,
  }
}
