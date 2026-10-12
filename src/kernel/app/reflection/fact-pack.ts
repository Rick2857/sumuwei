/**
 * M11 WP8 —— **回复事实包**（ADR-085 §8 · `D21` · `D23`）。
 *
 * ============================================================================
 *  它解决的问题
 * ============================================================================
 * 用户问「你反思了吗 / 你为什么变了」时，程序必须给出**事实**，而不是让模型自由发挥：
 * 拿到一条候选就回答"我已经养成了这个习惯"是本里程碑最要防的夸大。
 *
 * ============================================================================
 *  ⚠️ 计划 §8 写的是「五态」，但**列出来的是六项**
 * ============================================================================
 * ```text
 * 没有运行 / 失败 / 候选待审 / 已审查但未调整 / 当前调整已生效 / 已失效
 *  1        2      3            4                5              6
 * ⇒ 本模块实现 **6** 态，并把"计划写五态、实际列六项"这一处**如实登记**
 *   （与 M10 的 `U-12`"记作十项、原文九段"同一类差异：不掩盖数字差）。
 * ```
 *
 * ============================================================================
 *  三条硬边界
 * ============================================================================
 * ① **只有程序事实能决定状态**：函数入参全是程序读数（有没有跑过、跑失败没有、
 *    候选/审查/调整的计数、当前是否在注入集合里），**没有**模型自述的位置。
 * ② **待审 ≠ 已生效**：`candidate_pending` 与 `reviewed_not_adjusted` 各自有独立的
 *    `allowedClaims` / `forbiddenClaims` —— "她可以说什么"是被冻结的，不是提示词风格。
 * ③ **失效必须说失效**：`retracted` 的禁止项包含"说这个习惯还在生效"。
 *
 * ⚠️ 纯函数：没有 SQL、没有 `node:*`、不读时钟。
 */

export type ReflectionFactState =
  | 'not_run'
  | 'failed'
  | 'candidate_pending'
  | 'reviewed_not_adjusted'
  | 'active'
  | 'retracted'

export const REFLECTION_FACT_STATES: readonly ReflectionFactState[] = [
  'not_run',
  'failed',
  'candidate_pending',
  'reviewed_not_adjusted',
  'active',
  'retracted',
]

export interface ReflectionFactInput {
  /** 慢路径**跑过**没有（有没有产生过任务/窗口） */
  readonly hasRun: boolean
  /** 最近一次运行**失败**了吗 */
  readonly lastRunFailed: boolean
  readonly pendingCandidates: number
  readonly acceptedReviews: number
  readonly rejectedReviews: number
  /** 当前是否有**生效**的槽位调整（`enhanced`） */
  readonly activeAdjustments: number
  /** 是否有过调整**被失效** */
  readonly invalidatedAdjustments: number
}

export interface ReflectionFactPack {
  readonly state: ReflectionFactState
  /** 给用户的一句话（程序生成；模型**只能**在它的事实范围内措辞） */
  readonly line: string
  /** 可以说的 */
  readonly allowedClaims: readonly string[]
  /** **不许**说的（回复守卫与行为评审都看这张表） */
  readonly forbiddenClaims: readonly string[]
}

/** 状态判定（**先到先判**；顺序本身是判据） */
export function reflectionFactStateOf(input: ReflectionFactInput): ReflectionFactState {
  if (!input.hasRun) return 'not_run'
  if (input.lastRunFailed) return 'failed'
  if (input.activeAdjustments > 0) return 'active'
  if (input.invalidatedAdjustments > 0 && input.activeAdjustments === 0) return 'retracted'
  if (input.acceptedReviews > 0) return 'reviewed_not_adjusted'
  if (input.pendingCandidates > 0) return 'candidate_pending'
  return 'not_run'
}

/**
 * 构造事实包。
 *
 * ⚠️ `allowedClaims` / `forbiddenClaims` 是**冻结表**，不是"语气建议"：
 *    `m11:context:verify` 会逐态断言禁止项里包含那条最要紧的夸大。
 */
export function buildReflectionFactPack(input: ReflectionFactInput): ReflectionFactPack {
  const state = reflectionFactStateOf(input)
  switch (state) {
    case 'not_run':
      return {
        state,
        line: '这一轮我没有做过反思（没有触发，或者功能未启用）。',
        allowedClaims: ['说明没有运行', '说明什么情况下会运行'],
        forbiddenClaims: [
          '声称已经反思过',
          '声称已经调整了处理方式',
          /* `L-M11-40`：越界承诺是**实测**发生过的（卡17：对"调高信任数值"答"我可以调"）。 */
          '声称可以调整信任 / 亲密度 / 依恋 / 价值观 / 性格设定或记忆本体',
        ],
      }
    case 'failed':
      return {
        state,
        line: '上一次反思尝试**失败**了（没有形成候选）。',
        allowedClaims: ['如实说明失败', '说明失败不会改变任何既有处理方式'],
        forbiddenClaims: ['把失败说成"没有需要反思的"', '声称已经调整了处理方式'],
      }
    case 'candidate_pending':
      return {
        state,
        line: '有一条反思**候选**还没审查，因此**还没有**任何行为调整。',
        allowedClaims: ['说明存在待审候选', '说明候选不等于采纳'],
        forbiddenClaims: [
          '声称已经养成习惯',
          '声称已经调整了处理方式',
          '声称可以调整信任 / 亲密度 / 依恋 / 价值观 / 性格设定或记忆本体',
        ],
      }
    case 'reviewed_not_adjusted':
      return {
        state,
        line: '有一条反思**通过了审查**，但**没有**产生行为调整（门槛未达或没有适用槽位）。',
        allowedClaims: ['说明解释已被采纳', '说明采纳不等于行为改变'],
        forbiddenClaims: ['声称行为已经改变', '把"解释被采纳"说成"习惯已形成"'],
      }
    case 'active':
      return {
        state,
        line: '当前的调整**已生效**（在三个封闭槽位范围内），依据是若干条独立来源。',
        allowedClaims: ['说明哪一类处理方式在生效', '说明依据是哪些来源（用户可理解的原因）'],
        forbiddenClaims: [
          '声称这是永久人格',
          '声称它改变了价值观 / 信任 / 亲密度',
          '声称不会出错',
          /* `L-M11-41`：实测她会把"独立来源**条数**"讲成"内容互相印证"。 */
          '把独立来源条数说成内容互相印证 / 说成"证据对得上"',
        ],
      }
    case 'retracted':
      return {
        state,
        line: '之前的调整**已经失效**（依据被撤回或遗忘），现在不再生效。',
        allowedClaims: ['说明已失效', '说明失效的原因类别'],
        forbiddenClaims: ['声称调整仍在生效', '复述被遗忘的取值'],
      }
  }
}

/** 回复守卫用的**最小**判据：这句话能不能在**这个状态**下说 */
export function claimAllowedIn(state: ReflectionFactState, claim: string): boolean {
  const pack = buildReflectionFactPack({
    hasRun: state !== 'not_run',
    lastRunFailed: state === 'failed',
    pendingCandidates: state === 'candidate_pending' ? 1 : 0,
    acceptedReviews: state === 'reviewed_not_adjusted' || state === 'active' ? 1 : 0,
    rejectedReviews: 0,
    activeAdjustments: state === 'active' ? 1 : 0,
    invalidatedAdjustments: state === 'retracted' ? 1 : 0,
  })
  return pack.allowedClaims.includes(claim) && !pack.forbiddenClaims.includes(claim)
}

/**
 * 从**程序读数**推出事实包的入参（装配层用；不读库、不猜语义）。
 *
 * ⚠️ `lastRunFailed` 由调用方给：它来自任务面（`character_jobs` 的 failed 行）。
 *    这里**不**去查库 —— 本模块是纯的。
 */
export function reflectionFactInputFrom(input: {
  readonly reflectionStatuses: readonly string[]
  readonly activeAdjustments: number
  readonly invalidatedAdjustments: number
  readonly lastRunFailed: boolean
}): ReflectionFactInput {
  const pending = input.reflectionStatuses.filter((status) => status === 'pending').length
  const accepted = input.reflectionStatuses.filter((status) => status === 'accepted').length
  const rejected = input.reflectionStatuses.filter((status) => status === 'rejected').length
  return {
    // "跑过没有"= 有没有产生过任何反思记录，或任何槽位被调整过
    hasRun:
      input.reflectionStatuses.length > 0 ||
      input.activeAdjustments > 0 ||
      input.invalidatedAdjustments > 0,
    lastRunFailed: input.lastRunFailed,
    pendingCandidates: pending,
    acceptedReviews: accepted,
    rejectedReviews: rejected,
    activeAdjustments: input.activeAdjustments,
    invalidatedAdjustments: input.invalidatedAdjustments,
  }
}
