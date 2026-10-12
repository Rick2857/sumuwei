/**
 * M11 WP8 —— **行为策略注入块**（ADR-085 `D20` · `D27` · `D32` · §7.3）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 把**当前**可用的行为槽渲染成一段可裁的上下文 section（`kind = 'adaptive-self'`，
 * 优先级 44）。渲染进正文的句子**只**来自 `ADAPTIVE_SELF_TEMPLATES`（封闭枚举）。
 *
 * ============================================================================
 *  四条硬边界（都是判据）
 * ============================================================================
 * ① **额度 0 ⇒ 根本不渲染**（`D20`）：`maxTokens <= 0` 时**连候选都不看**就返回 `[]`
 *    —— 这样"关闭档的 prompt 与基线逐字节相同"不依赖裁剪逻辑（先例：`goal-sections.ts`）。
 * ② **只有 `enhanced` 进上下文**：`baseline` 是"没有特殊处置"，把它渲染出来等于
 *    凭空多出一段指令（而且会让"她今天有没有被调整过"在 prompt 里出现噪声）。
 * ③ **至多三条**（`D27`）：三槽闭集，一条一槽。
 * ④ **id 与 revision 进 `sourceRefs`**（不写进正文）：trace 据此逐 id/revision 对账
 *    —— 正文里出现内部 id 是隐私与可读性双重问题（先例：`goal-sections.ts`）。
 *
 * ⚠️ 纯函数：没有 SQL、没有 `node:*`、不读时钟。
 */

import { SECTION_PRIORITY, type ContextSection, type ContextSectionProvider } from '../contracts/context.ts'
import {
  ADAPTIVE_SELF_BOUNDARY_FACTS,
  ADAPTIVE_SELF_SLOTS,
  renderAdaptiveSelfLine,
  type AdaptiveSelfState,
} from '../contracts/adaptive-self.ts'

/** section id（稳定；trace 与 packet 对账靠它） */
export const ADAPTIVE_SELF_SECTION_ID = 'adaptive-self'

/** 程序渲染的块头（**不是**模型输出） */
export const ADAPTIVE_SELF_BLOCK_HEADER = '【当前处理方式（供参考，不是本轮任务）】'

/** 边界事实段的标题（**程序事实**，不是禁语表） */
export const ADAPTIVE_SELF_BOUNDARY_HEADER = '【关于"我能改什么"的事实】'

/** 至多三条（`D27`） */
export const ADAPTIVE_SELF_MAX_ITEMS = 3

export interface RenderAdaptiveSelfInput {
  /** 三槽的当前状态（缺省读法见 `baselineAdaptiveSelfState()`） */
  readonly states: readonly AdaptiveSelfState[]
  /** 本块的额度；**0 = 关闭**（缺省 0 是刻意的，`D20`） */
  readonly maxTokens: number
  /** 定价器（与其它 section 共用；不许在这里另写一个默认） */
  readonly quantify: (text: string) => number
}

/** 一条槽 → 它对外的稳定引用（trace 用；**不进正文**） */
export function adaptiveSelfRefOf(state: AdaptiveSelfState): string {
  return `${ADAPTIVE_SELF_SECTION_ID}:${state.slot}@${String(state.revision)}`
}

/**
 * 渲染行为策略块。
 *
 * @returns 0 或 1 个 section（三槽合并成一段；`D27` 的"至多三条"是**行数**上界）
 */
export function renderAdaptiveSelfSection(input: RenderAdaptiveSelfInput): ContextSection[] {
  // ① 额度 0 ⇒ 根本不渲染（连候选都不看）
  if (input.maxTokens <= 0) return []

  // ② 只有 enhanced 进上下文；顺序按**闭集**（确定性，不按投影行顺序）
  const enhanced = ADAPTIVE_SELF_SLOTS.map((slot) =>
    input.states.find((state) => state.slot === slot)
  ).filter((state): state is AdaptiveSelfState => state !== undefined && state.level === 'enhanced')

  if (enhanced.length === 0) return []

  // ③ 至多三条
  const selected = enhanced.slice(0, ADAPTIVE_SELF_MAX_ITEMS)

  /*
   * ⚠️ **固定的前置事实段**（`L-M11-40`/`41`/`42` 的修法）：
   *    · 它是**程序事实**（"能改的只有三类处理方式" + 两条例定语义 + "只证明条数"），
   *      不是禁语表、不是逐句守卫（`DR-11`）；
   *    · 它**优先于**槽位行：额度连事实段都放不下 ⇒ **整块不渲染**（失败关闭），
   *      因为"只印一半边界"比"不印"更容易误导；
   *    · 槽位行仍受"至多三条"与额度约束（放不下就少印几条）。
   */
  const factsBlock = [ADAPTIVE_SELF_BOUNDARY_HEADER, ...ADAPTIVE_SELF_BOUNDARY_FACTS.map((fact) => `- ${fact}`)]
  const lines: string[] = [ADAPTIVE_SELF_BLOCK_HEADER]
  const refs: string[] = []
  let spent = input.quantify(`${ADAPTIVE_SELF_BLOCK_HEADER}\n`)
  for (const factLine of factsBlock) {
    const cost = input.quantify(`${factLine}\n`)
    if (spent + cost > input.maxTokens) {
      // 事实段都放不下 ⇒ 整块不渲染（**不**印半条边界）
      return []
    }
    lines.push(factLine)
    spent += cost
  }
  for (const state of selected) {
    // ④ 正文**只**来自程序模板；id/revision 只进 sourceRefs
    const line = `- ${renderAdaptiveSelfLine(state.slot)}`
    const cost = input.quantify(`${line}\n`)
    if (spent + cost > input.maxTokens) break // 放不下就停（**不**改写成"更短的正确版"）
    lines.push(line)
    refs.push(adaptiveSelfRefOf(state))
    spent += cost
  }

  if (refs.length === 0) return []

  return [
    {
      id: ADAPTIVE_SELF_SECTION_ID,
      kind: 'adaptive-self',
      priority: SECTION_PRIORITY.adaptiveSelf,
      content: `${lines.join('\n')}\n`,
      sourceRefs: refs,
      droppable: true,
    },
  ]
}

/**
 * **provider 工厂**（形状照 `createBeliefProvider` / `createGoalStateProvider`）。
 *
 * ⚠️ 额度与状态都在**构造时**定死：provider 自己**不**读配置、不查库、不写第二个默认
 *    （`D20`：预算只从**那一个** `ContextBudget` 传进来）。
 *    额度 0 ⇒ `provide()` 返回 `[]`（`renderAdaptiveSelfSection` 的第一条边界）。
 */
export function createAdaptiveSelfProvider(options: RenderAdaptiveSelfInput): ContextSectionProvider {
  return {
    name: ADAPTIVE_SELF_SECTION_ID,
    async provide(): Promise<ContextSection[]> {
      return renderAdaptiveSelfSection(options)
    },
  }
}

/**
 * **"实际入模"的现实读数**（与 `evidenceContextReality` / `applyContextReality` 同构）。
 *
 * ⚠️ 这是本模块最容易写错的一处：**选择器选了谁 ≠ 模型看到了谁**。
 *    section 被上下文预算裁掉时，`selectedRefs` **必须清空** ——
 *    否则 trace 会把"计划注入"标成"已注入"。
 */
export interface AdaptiveSelfContextReality {
  readonly intendedRefs: readonly string[]
  readonly selectedRefs: readonly string[]
  readonly reachedContext: boolean
  readonly droppedByContextBudget: boolean
}

export function adaptiveSelfContextReality(input: {
  readonly intendedRefs: readonly string[]
  readonly sectionSurvived: boolean
  readonly finalRefs?: readonly string[]
}): AdaptiveSelfContextReality {
  if (!input.sectionSurvived) {
    return {
      intendedRefs: input.intendedRefs,
      selectedRefs: [], // 事实：模型一条都没拿到
      reachedContext: false,
      droppedByContextBudget: input.intendedRefs.length > 0,
    }
  }
  const refs = input.finalRefs ?? input.intendedRefs
  return {
    intendedRefs: input.intendedRefs,
    selectedRefs: refs,
    reachedContext: refs.length > 0,
    droppedByContextBudget: false,
  }
}
