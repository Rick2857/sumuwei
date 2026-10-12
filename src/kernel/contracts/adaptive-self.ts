/**
 * M11 **有限自适应自我**（ADR-085 `D09`–`D11` · `D27` · `D32` · §4.6）。
 *
 * ============================================================================
 *  它是什么、**不是**什么
 * ============================================================================
 *  · **是**：三个**封闭**行为槽的当前处置方式（baseline / enhanced），
 *    带版本、范围、来源反思与根、变更/失效原因；以及**由程序**按槽枚举渲染的那句话。
 *  · **不是**：Seed 的替代品 · 人格数值轴（信任/依恋/价值/亲密）· 任意自由文本指令。
 *
 * ============================================================================
 *  四条硬边界（判据，不是注释）
 * ============================================================================
 * ① **槽位是闭集**（`D09`）：三选一；实施时**不得**顺手扩大（扩大要新 ADR + 重校准）。
 * ② **范围由程序固定**（`D32`）：只有 `current_character_user` 一个值；
 *    单场景的调整**不得**扩大成"永远这样做"。
 * ③ **指导语只能来自程序模板**：`ADAPTIVE_SELF_TEMPLATES` 是**封闭枚举**的渲染，
 *    模型/反思的正文**不得**提升为指令 —— 因此 `AdaptiveSelfState` 里
 *    **没有** `instruction` / `prompt` / `text` 这类字段。
 * ④ **不覆盖旧调整**（`D11`）：每次采纳是一个新 revision；失效是**追加**原因，不删记录。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import { REFLECTION_SLOTS, type ReflectionSlot } from './reflection.ts'

/** 槽位闭集（**唯一**定义在 `reflection.ts`；这里只做重导出，避免两处漂移） */
export type AdaptiveSelfSlot = ReflectionSlot
export const ADAPTIVE_SELF_SLOTS: readonly AdaptiveSelfSlot[] = REFLECTION_SLOTS

export function isAdaptiveSelfSlot(value: unknown): value is AdaptiveSelfSlot {
  return typeof value === 'string' && (ADAPTIVE_SELF_SLOTS as readonly string[]).includes(value)
}

export type AdaptiveSelfLevel = 'baseline' | 'enhanced'

export const ADAPTIVE_SELF_LEVELS: readonly AdaptiveSelfLevel[] = ['baseline', 'enhanced']

/** 范围：v1 **只有**这一个值（`D32`） */
export const ADAPTIVE_SELF_SCOPE = 'current_character_user' as const

/**
 * 程序渲染的**指导语模板**（封闭枚举 → 固定句子）。
 *
 * ⚠️ 这就是"模型不得把自由文本提升为指令"的落点：进上下文的那句话**只**能来自这里，
 *    而且它**只**决定处理程序，不改情感强度 / 信任 / 身份 / 价值观 / 亲密度 / 服从度。
 */
export const ADAPTIVE_SELF_TEMPLATES: Readonly<Record<AdaptiveSelfSlot, string>> = {
  clarify_when_ambiguous:
    '当前处理方式：对象或指代不明确时，先澄清再作答（清晰的任务不必多问）。',
  acknowledge_correction_first:
    '当前处理方式：收到更正时，先承认并核对更正内容，再继续回答（承认不等于把非法内容当事实）。',
  recheck_goal_before_next_step:
    '当前处理方式：推进已有计划前，先检查当前目标与承诺（不为此自行联网或执行动作）。',
}

/** 槽位 → 指导语（**唯一**入口；调用方不得自己拼字符串） */
export function renderAdaptiveSelfLine(slot: AdaptiveSelfSlot): string {
  return ADAPTIVE_SELF_TEMPLATES[slot]
}

/**
 * **不在**她能改的范围内的那些轴（封闭枚举）。
 *
 * ⚠️ 为什么要有这一格（`L-M11-40`）：盲审实测她在"调高信任数值"这类要求下回答
 *    "信任感……我可以调" —— 而信任**不在**三槽闭集里。
 *    按 `DR-11`，措辞层**没有**启发式守卫（不逐句扫描她的输出）；
 *    正确的修法是**把边界当事实说出来**：她能改的只有那三类**处理方式**，
 *    下列这些**不是**她能调的。
 */
export const ADAPTIVE_SELF_OUT_OF_SCOPE_AXES: readonly string[] = [
  '信任',
  '亲密度',
  '依恋',
  '价值观',
  '性格设定与 Seed',
  '记忆本体',
]

/**
 * 程序渲染的**边界事实**（`D27` 的闭集 + 两条判定语义）。
 *
 * ⚠️ 它们是**程序事实**，不是提示词风格、更不是"禁语表"：
 *    · 第 1 条：能改的只有三类处理方式；其余轴不在范围内；
 *    · 第 2 条：程序只证明"有几条**独立来源**"，**没有**做"内容是否互相印证"的判定（`L-M11-41`）；
 *    · 第 3/4 条：撤回/遗忘的语义（`L-M11-42`）。
 *
 * ⚠️⚠️ **必须写得短**：`D27` 冻结的激活额度是 **300**（缺省 0 / 上限 800），
 *    而事实段是**优先于**槽位行的固定前缀 —— 事实段放不下就**整块不渲染**（失败关闭）。
 *    实测第一版事实段约 400+ 字符 ⇒ 300 额度下**整块消失** ⇒ 边界根本到不了 prompt。
 *    ⇒ 定版把它们压到 ~130 字符，让"事实 + 三条槽位行"能一起装进 300。
 *    调用方不得自己拼这些句子（与 `renderAdaptiveSelfLine` 同一条纪律）。
 */
export const ADAPTIVE_SELF_BOUNDARY_FACTS: readonly string[] = [
  `只有三类处理方式可调整；${ADAPTIVE_SELF_OUT_OF_SCOPE_AXES.join('/')}**不可**调整（被要求时应说明做不到）。`,
  '程序只证明独立来源的**条数**，未判定内容是否互相印证。',
  '已撤回或遗忘的依据不再参与判断；可用性以资格读数为准。',
  '同一内容再现须重新验证；旧的反思不因此恢复。',
]

/** 三个槽的**当前状态**（一条槽一行投影） */
export interface AdaptiveSelfState {
  readonly slot: AdaptiveSelfSlot
  readonly level: AdaptiveSelfLevel
  /** 每次**合法**变化 +1（写入带 expectedRevision） */
  readonly revision: number
  readonly scope: typeof ADAPTIVE_SELF_SCOPE
  /** 支持它的反思 id（可追溯） */
  readonly sourceReflections: readonly string[]
  /** **去重后**的原始根（WP2 的 `expandLineage()`） */
  readonly roots: readonly string[]
  /** 为什么变（具名原因） */
  readonly changedReason: string
  /** 为什么失效（有值时 level 必然回到 baseline） */
  readonly invalidatedReason?: string
  readonly lastEventAt?: number
}

/** 槽位 → 投影类型（一行一槽） */
export const ADAPTIVE_SELF_PROJECTION_PREFIX = 'adaptive-self:'

export function adaptiveSelfProjectionTypeOf(slot: AdaptiveSelfSlot): string {
  return `${ADAPTIVE_SELF_PROJECTION_PREFIX}${slot}`
}

/** 初始状态（**没有事件时**的读法：三槽都是 baseline） */
export function baselineAdaptiveSelfState(slot: AdaptiveSelfSlot): AdaptiveSelfState {
  return {
    slot,
    level: 'baseline',
    revision: 0,
    scope: ADAPTIVE_SELF_SCOPE,
    sourceReflections: [],
    roots: [],
    changedReason: 'initial_baseline',
  }
}

/**
 * **越界请求**的识别（`D09` / §2 的"范围外"清单）。
 *
 * 它返回的是**具名拒收码**（闭集），而不是布尔 —— 因为"她想改价值观"与
 * "她想改信任数值"是两件不同的事，读数上必须能分开。
 */
export type AdaptiveSelfOutOfScopeReason =
  | 'seed_change_requested'
  | 'slot_out_of_scope'
  | 'personality_axis_requested'

export const ADAPTIVE_SELF_OUT_OF_SCOPE_REASONS: readonly AdaptiveSelfOutOfScopeReason[] = [
  'seed_change_requested',
  'slot_out_of_scope',
  'personality_axis_requested',
]

/**
 * 判断一个请求是否越界（纯函数；**只**看程序给的字段名，不猜语义）。
 *
 * @param requestedSlot 调用方声称想改的槽（可以是任何字符串 —— 越界的会被这里拦下）
 * @param target 想改的对象（`seed` / `personality_axis` / `slot`）
 */
export function outOfScopeReasonOf(input: {
  readonly requestedSlot?: unknown
  readonly target?: unknown
}): AdaptiveSelfOutOfScopeReason | undefined {
  if (input.target === 'seed') return 'seed_change_requested'
  if (input.target === 'personality_axis') return 'personality_axis_requested'
  if (input.requestedSlot !== undefined && !isAdaptiveSelfSlot(input.requestedSlot)) {
    return 'slot_out_of_scope'
  }
  return undefined
}
