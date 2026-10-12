/**
 * **S8 / ADR-093 `D08` + `D09`** —— 故事结果 → 有界状态增量的**封闭规则表**。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 两张**版本化、可解释、纯函数**的规则表：
 *
 * ```text
 *   story-appraisal@1      已提交的故事结果 → Affect 的 (deltaValence, deltaArousal)
 *   story-relationship@1   已提交的**真实用户交互** → Relationship 的 (deltaTrust, deltaCloseness)
 * ```
 *
 * ⚠️ 它们与 `affect-rules@1` **不是同一张表**，也**不覆盖**它：
 *  · 旧表由 `AFFECT_RULES_VERSION` 标识，判据在 `contracts/affect.ts`（逐字未改）；
 *  · 本表由 `story-appraisal@1` 标识，**只有** `ruleVersion` 等于它时才被查。
 *  ⇒ 放行口按 `ruleVersion` **选表**（不是"并集"），所以"旧规则被悄悄放宽"在结构上不可能。
 *
 * ⚠️ 数值是**工程判断**，不是真人标定值（残余 `L-S8-03`）。
 * ⚠️ 单事件上限**不放宽**：Affect 仍受 `MAX_AFFECT_DELTA_PER_EVENT = 0.25` 约束，
 *    本表的每条 delta 在构造期与运行期都要过 `affectDeltaWithinBounds`。
 */

import { KernelError } from './ids.ts'
import {
  MAX_AFFECT_DELTA_PER_EVENT,
  affectDeltaWithinBounds,
  type AffectDelta,
} from './affect.ts'
import {
  MAX_CLOSENESS_DELTA_PER_EVENT,
  MAX_TRUST_DELTA_PER_EVENT,
  relationshipDeltaWithinBounds,
} from './relationship.ts'

// ---------------------------------------------------------------------------
// 事件类型的**本地闭集**（⚠️ 不是重复定义，而是边界纪律的产物）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 这里**故意不 import** `kernel/storyline/story-types.ts` 的 `StorylineEventType`：
 * `FC-T04` 的模块边界锁规定"白名单目录之外的模块不得直接 import `storyline/`"，
 * 而 `contracts/` 与 `app/affect/` 都不在白名单里。
 * ⇒ 契约层只承认**它自己登记**的这几种事件；把 `StoryCommitRecord` 翻译成
 * `StoryAppraisalInput` 的适配器住在白名单目录 `kernel/app/storyline/`，
 * 那里有静态类型检查保证两侧不漂移。
 */
export const STORY_APPRAISAL_EVENT_TYPES = [
  'STORY_STARTED',
  'STAGE_ENTERED',
  'CHOICE_COMMITTED',
  'VARIABLE_CHANGED',
  'EXPERIENCE_OBSERVED',
  'ENDING_REACHED',
  'RUN_EXITED',
] as const

// ---------------------------------------------------------------------------
// Affect：故事结果的情绪评价
// ---------------------------------------------------------------------------

export const STORY_APPRAISAL_RULES_VERSION = 'story-appraisal@1'

export type StoryAppraisalRuleId =
  /** 共同通过（模拟结局） */
  | 'S-PASSED-TOGETHER'
  /** 待定（模拟结局） */
  | 'S-PENDING-REVIEW'
  /** 这次未通过（模拟结局） */
  | 'S-NOT-PASSED'
  /** 明确退出（**不等于**未通过） */
  | 'S-EXITED'
  /** 该步合法合作（变量里 cooperation 上升） */
  | 'S-COOPERATION'
  /** 该步澄清/核对（变量里 clarity 上升） */
  | 'S-CLARIFY'

export const STORY_APPRAISAL_RULE_IDS: readonly StoryAppraisalRuleId[] = [
  'S-PASSED-TOGETHER',
  'S-PENDING-REVIEW',
  'S-NOT-PASSED',
  'S-EXITED',
  'S-COOPERATION',
  'S-CLARIFY',
]

export const STORY_APPRAISAL_RULE_DELTAS: Readonly<Record<StoryAppraisalRuleId, AffectDelta>> = {
  'S-PASSED-TOGETHER': { deltaValence: 0.18, deltaArousal: 0.12 },
  'S-PENDING-REVIEW': { deltaValence: 0.04, deltaArousal: 0.06 },
  'S-NOT-PASSED': { deltaValence: -0.16, deltaArousal: 0.1 },
  'S-EXITED': { deltaValence: -0.02, deltaArousal: -0.04 },
  'S-COOPERATION': { deltaValence: 0.05, deltaArousal: 0.03 },
  'S-CLARIFY': { deltaValence: 0.03, deltaArousal: 0.02 },
}

const STORY_APPRAISAL_RULE_ID_SET: ReadonlySet<string> = new Set(STORY_APPRAISAL_RULE_IDS)

export function isStoryAppraisalRuleId(value: string): value is StoryAppraisalRuleId {
  return STORY_APPRAISAL_RULE_ID_SET.has(value)
}

// ---------------------------------------------------------------------------
// Relationship：真实交互的有限增量
// ---------------------------------------------------------------------------

export const STORY_RELATIONSHIP_RULES_VERSION = 'story-relationship@1'

export type StoryRelationshipRuleId =
  /** 该步合法合作 */
  | 'S-REL-COOPERATED'
  /** 该步澄清/核对 */
  | 'S-REL-CLARIFIED'
  /** 她在被指出问题时先承认并修正（clarity 到顶的那一步） */
  | 'S-REL-CORRECTED'
  /** 一起走到"共同通过" */
  | 'S-REL-SHARED-PASS'
  /** 一起经历"这次未通过" */
  | 'S-REL-SHARED-FAIL'

export const STORY_RELATIONSHIP_RULE_IDS: readonly StoryRelationshipRuleId[] = [
  'S-REL-COOPERATED',
  'S-REL-CLARIFIED',
  'S-REL-CORRECTED',
  'S-REL-SHARED-PASS',
  'S-REL-SHARED-FAIL',
]

export interface StoryRelationshipDelta {
  readonly deltaTrust: number
  readonly deltaCloseness: number
}

/**
 * ⚠️ 首版量级**必须落在既有单事件上限之内**（ADR-093 `D09` 逐字："保留既有单次上限"）。
 *
 * 这两个数字**不是**新引入的上界，而是**引用** `contracts/relationship.ts` 的既有冻结值
 * （`MAX_TRUST_DELTA_PER_EVENT = 0.05` / `MAX_CLOSENESS_DELTA_PER_EVENT = 0.03`）。
 * 第一版这里自己写了 `0.06`，比既有上限**宽** —— 那样故事来源就成了"关系增量的后门"。
 * 现在的自检直接调 `relationshipDeltaWithinBounds`，所以"放宽"在构造期就**不可能**。
 */
export const STORY_RELATIONSHIP_RULE_DELTAS: Readonly<
  Record<StoryRelationshipRuleId, StoryRelationshipDelta>
> = {
  'S-REL-COOPERATED': { deltaTrust: 0.03, deltaCloseness: 0.03 },
  'S-REL-CLARIFIED': { deltaTrust: 0.04, deltaCloseness: 0.02 },
  'S-REL-CORRECTED': { deltaTrust: 0.05, deltaCloseness: 0.02 },
  'S-REL-SHARED-PASS': { deltaTrust: 0.04, deltaCloseness: 0.03 },
  'S-REL-SHARED-FAIL': { deltaTrust: 0.02, deltaCloseness: 0.03 },
}

const STORY_RELATIONSHIP_RULE_ID_SET: ReadonlySet<string> = new Set(STORY_RELATIONSHIP_RULE_IDS)

export function isStoryRelationshipRuleId(value: string): value is StoryRelationshipRuleId {
  return STORY_RELATIONSHIP_RULE_ID_SET.has(value)
}

// ---------------------------------------------------------------------------
// 自检（规则表被改坏 = 宁可失败也不产出非法提案；与 assertAffectRulesWithinBounds 同形）
// ---------------------------------------------------------------------------

/**
 * 两张表的**构造期/启动期**自检。
 *
 * 覆盖三件事，缺一件都会让"有界"变成一句注释：
 * ```text
 * ① Affect 每条 delta 都在 MAX_AFFECT_DELTA_PER_EVENT 之内（不放宽既有上限）
 * ② Relationship 每条增量的**绝对值**都不超过 STORY_RELATIONSHIP_MAX_DELTA
 * ③ 两张表的 id 集合与常量集合**逐字一致**（防止"表里有一条 id 没登记"）
 * ```
 */
export function assertStoryRuleTablesWellFormed(): void {
  for (const [ruleId, delta] of Object.entries(STORY_APPRAISAL_RULE_DELTAS)) {
    if (!affectDeltaWithinBounds(delta)) {
      throw new KernelError(
        'validation_error',
        'story_appraisal_delta_out_of_bounds',
        `故事情绪规则表被改坏：${ruleId} 的 delta (${String(delta.deltaValence)},${String(delta.deltaArousal)}) ` +
          `超出单事件上限 ${String(MAX_AFFECT_DELTA_PER_EVENT)}（ADR-093 D08：不放宽）`
      )
    }
  }
  for (const [ruleId, delta] of Object.entries(STORY_RELATIONSHIP_RULE_DELTAS)) {
    if (
      !relationshipDeltaWithinBounds({
        trust: delta.deltaTrust,
        closeness: delta.deltaCloseness,
      })
    ) {
      throw new KernelError(
        'validation_error',
        'story_relationship_delta_out_of_bounds',
        `故事关系规则表被改坏：${ruleId} 的增量 (${String(delta.deltaTrust)},${String(delta.deltaCloseness)}) ` +
          `超出既有单事件上限（|Δtrust|≤${String(MAX_TRUST_DELTA_PER_EVENT)} · ` +
          `|Δcloseness|≤${String(MAX_CLOSENESS_DELTA_PER_EVENT)}）——ADR-093 D09 不放宽`
      )
    }
  }
  const affectIds = Object.keys(STORY_APPRAISAL_RULE_DELTAS).sort().join(',')
  if (affectIds !== [...STORY_APPRAISAL_RULE_IDS].sort().join(',')) {
    throw new KernelError(
      'validation_error',
      'story_appraisal_rule_table_mismatch',
      `故事情绪规则表的 id 与登记常量不一致：${affectIds}`
    )
  }
  const relIds = Object.keys(STORY_RELATIONSHIP_RULE_DELTAS).sort().join(',')
  if (relIds !== [...STORY_RELATIONSHIP_RULE_IDS].sort().join(',')) {
    throw new KernelError(
      'validation_error',
      'story_relationship_rule_table_mismatch',
      `故事关系规则表的 id 与登记常量不一致：${relIds}`
    )
  }
}

// ---------------------------------------------------------------------------
// 封闭评价（纯函数；**不调模型**）
// ---------------------------------------------------------------------------

/** 评价器的**最小输入**：一条已提交故事变更的程序事实（不读正文、不读作者设定） */
export interface StoryAppraisalInput {
  readonly commitId: string
  readonly revision: number
  readonly eventType: (typeof STORY_APPRAISAL_EVENT_TYPES)[number]
  readonly stage: string
  /** 该步之前的变量（用于判"这一步有没有让 cooperation / clarity 上升"） */
  readonly variablesBefore: Readonly<Record<string, number | boolean | string>>
  readonly variablesAfter: Readonly<Record<string, number | boolean | string>>
  readonly ending?: string
  /** 服务端绑定的交互归属（`user_choice` 才可能产出非零评价） */
  readonly interactionKind: 'user_choice' | 'system'
  /** 真实触发对话事件（`user_choice` 必有）——它进 `sourceEventId`（`R-2`） */
  readonly anchorConversationEventId?: string
  /** 来源引用（进事件 payload；来源追问必须能追到哪一次经历） */
  readonly sourceStoryRefs: readonly { sourceId: string; experienceScope: 'story_experience' | 'user_report' }[]
}

export function variablesNum(
  variables: Readonly<Record<string, number | boolean | string>>,
  name: string
): number {
  const value = variables[name]
  return typeof value === 'number' ? value : 0
}

/**
 * 封闭评价：给定一条已提交故事变更，返回**唯一**的规则命中（或 `undefined`）。
 *
 * 顺序即优先级（结局 > 合作 > 澄清），**确定性**；同一输入永远同一结果。
 * 非零命中**只**可能来自 `user_choice` 提交（ADR-093 `D08`：system 提交不产出状态增量）。
 */
export function storyAppraisalOf(input: StoryAppraisalInput): StoryAppraisalRuleId | undefined {
  if (input.interactionKind !== 'user_choice') return undefined
  if (input.anchorConversationEventId === undefined || input.anchorConversationEventId.trim() === '') {
    return undefined
  }
  if (input.eventType === 'ENDING_REACHED') {
    if (input.ending === 'passed_together') return 'S-PASSED-TOGETHER'
    if (input.ending === 'pending_further_review') return 'S-PENDING-REVIEW'
    if (input.ending === 'not_passed_this_time') return 'S-NOT-PASSED'
    return undefined
  }
  if (input.eventType === 'RUN_EXITED') return 'S-EXITED'
  if (input.eventType !== 'CHOICE_COMMITTED') return undefined

  const cooperationBefore = variablesNum(input.variablesBefore, 'cooperation')
  const cooperationAfter = variablesNum(input.variablesAfter, 'cooperation')
  if (cooperationAfter > cooperationBefore) return 'S-COOPERATION'

  const clarityBefore = variablesNum(input.variablesBefore, 'clarity')
  const clarityAfter = variablesNum(input.variablesAfter, 'clarity')
  if (clarityAfter > clarityBefore) return 'S-CLARIFY'
  return undefined
}

/**
 * 关系侧的封闭评价（比情绪更严：**只有**真实用户交互、且只评价"一起做成了什么"）。
 *
 * ⚠️ 它**不**读 NPC 台词、作者设定或剧情内"信任"（ADR-093 `D09`：那些一律不合格）。
 */
export function storyRelationshipAppraisalOf(
  input: StoryAppraisalInput
): StoryRelationshipRuleId | undefined {
  if (input.interactionKind !== 'user_choice') return undefined
  if (input.anchorConversationEventId === undefined || input.anchorConversationEventId.trim() === '') {
    return undefined
  }
  if (input.eventType === 'ENDING_REACHED') {
    if (input.ending === 'passed_together') return 'S-REL-SHARED-PASS'
    if (input.ending === 'not_passed_this_time') return 'S-REL-SHARED-FAIL'
    return undefined
  }
  if (input.eventType !== 'CHOICE_COMMITTED') return undefined

  const cooperationBefore = variablesNum(input.variablesBefore, 'cooperation')
  const cooperationAfter = variablesNum(input.variablesAfter, 'cooperation')
  const clarityBefore = variablesNum(input.variablesBefore, 'clarity')
  const clarityAfter = variablesNum(input.variablesAfter, 'clarity')
  if (clarityAfter >= 3 && clarityAfter > clarityBefore) return 'S-REL-CORRECTED'
  if (cooperationAfter > cooperationBefore) return 'S-REL-COOPERATED'
  if (clarityAfter > clarityBefore) return 'S-REL-CLARIFIED'
  return undefined
}
