/**
 * **S8 / ADR-093 `D12`** —— 故事体验的**认知使用资格撤回**（内部领域事件）。
 *
 * ============================================================================
 *  它是什么、**不是**什么
 * ============================================================================
 *  · **是**：一条**内部**领域事件，声明"这些已提交的故事经历**不再**用于认知"
 *    （不再作为根、不再支持反思与习惯），以及为什么。
 *  · **不是**：删除。世界账本 `storyline_commits` / `storyline_observations`
 *    **一个字节都不动** —— 撤回是**读时**判定（`D12` 逐字："它不会物理删除原始世界历史"）。
 *
 * ============================================================================
 *  为什么必须是**读时**判定，而不是"删掉那几行"
 * ============================================================================
 * ```text
 * 删行 ⇒ replay 会把它们**重建回来**（事件流还在）⇒ "撤回了却又复活"
 * 读时判定 ⇒ 每一次解析都要过撤回集合 ⇒ replay / rebuild / 换进程都绕不过去
 * ```
 * ⇒ 于是 `findStoryEvents()` 每次都查撤回集合，`expandLineage()` 见 `withdrawn: true`
 * 就报 `story_root_withdrawn`（具名拒收，不是"悄悄少一个根"）。
 *
 * ⚠️ 纯契约 + 纯函数：不 import 框架 / SQL / `node:*`。
 */

import { KernelError } from './ids.ts'
import { isStorySourceId, type StorySourceRef } from './source-authority.ts'

export const STORY_EXPERIENCE_RETRACTED = 'STORY_EXPERIENCE_RETRACTED' as const

export const STORY_EXPERIENCE_RETRACTION_REASONS = [
  /** 用户明确撤回这段体验的认知使用资格 */
  'user_withdrew',
  /** 用户更正了与这段体验相关的真实情况（体验本身没错，但不该再作为依据） */
  'user_corrected',
] as const

export type StoryExperienceRetractionReason = (typeof STORY_EXPERIENCE_RETRACTION_REASONS)[number]

export interface StoryExperienceRetractedPayload {
  readonly characterId: string
  /**
   * 被撤回的**故事提交身份**（至少一条）。
   *
   * ⚠️ 用的是**提交身份**（`…e<revision>`）而不是观测 id：撤回的粒度与根的粒度一致
   * （`ADR-093 D01`：一次提交一个根）。给观测 id 会让"同一个提交的另一条观测"漏网。
   */
  readonly withdrawnStoryRefs: readonly StorySourceRef[]
  readonly reason: StoryExperienceRetractionReason
  readonly withdrawnAt: number
  /** 人类可读说明（进审计；不进任何 prompt） */
  readonly note?: string
}

/** 结构校验（registry 用；**失败关闭**） */
export function validateStoryExperienceRetractedPayload(
  payload: unknown
): StoryExperienceRetractedPayload {
  const eventType = STORY_EXPERIENCE_RETRACTED
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`${eventType} payload 必须是对象`)
  }
  const object = payload as Record<string, unknown>
  const characterId = object.characterId
  if (typeof characterId !== 'string' || characterId.trim() === '') {
    throw new Error(`${eventType} payload.characterId 必须是非空字符串`)
  }
  const refs = object.withdrawnStoryRefs
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(`${eventType} payload.withdrawnStoryRefs 必须是非空数组（撤回**什么**不能靠猜）`)
  }
  const withdrawnStoryRefs: StorySourceRef[] = []
  const seen = new Set<string>()
  for (const item of refs) {
    const sourceId = (item as { sourceId?: unknown } | null | undefined)?.sourceId
    if (typeof sourceId !== 'string' || !isStorySourceId(sourceId)) {
      throw new Error(
        `${eventType} payload.withdrawnStoryRefs 里有一条不可解析的来源 id：${JSON.stringify(sourceId)}`
      )
    }
    if (seen.has(sourceId)) {
      throw new Error(`${eventType} payload.withdrawnStoryRefs 含重复来源：${sourceId}`)
    }
    seen.add(sourceId)
    const ref = item as StorySourceRef
    withdrawnStoryRefs.push({
      sourceId,
      storyId: String(ref.storyId),
      storyVersion: Number(ref.storyVersion),
      runId: String(ref.runId),
      eventId: String(ref.eventId),
      experienceScope: ref.experienceScope,
    })
  }
  const reason = object.reason
  if (!(STORY_EXPERIENCE_RETRACTION_REASONS as readonly string[]).includes(String(reason))) {
    throw new Error(
      `${eventType} payload.reason 必须是 ${STORY_EXPERIENCE_RETRACTION_REASONS.join(' / ')}，收到 ${String(reason)}`
    )
  }
  const withdrawnAt = object.withdrawnAt
  if (typeof withdrawnAt !== 'number' || !Number.isFinite(withdrawnAt)) {
    throw new Error(`${eventType} payload.withdrawnAt 必须是有限数字（epoch ms）`)
  }
  const result: StoryExperienceRetractedPayload = {
    characterId,
    withdrawnStoryRefs,
    reason: reason as StoryExperienceRetractionReason,
    withdrawnAt,
  }
  if (object.note !== undefined) {
    if (typeof object.note !== 'string') throw new Error(`${eventType} payload.note 必须是字符串`)
    return { ...result, note: object.note }
  }
  return result
}

/**
 * 从一批已登记的撤回事件里取出**被撤回的提交身份集合**（纯函数）。
 *
 * ⚠️ 它**只**认形状正确的行：坏掉的行**抛错**而不是被跳过 ——
 * 一条读不出来的撤回如果被静默忽略，后果是"用户撤回了，但她还在用"
 * （最坏的那类失败：表面上没报错）。
 */
export function withdrawnStoryCommitIdsOf(
  payloads: readonly unknown[]
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const payload of payloads) {
    const validated = validateStoryExperienceRetractedPayload(payload)
    for (const ref of validated.withdrawnStoryRefs) out.add(ref.sourceId)
  }
  return out
}

/** 供门使用：登记表完整性自检（`measured_count > 0` 的一项） */
export function storyRetractionVocabularySize(): number {
  return STORY_EXPERIENCE_RETRACTION_REASONS.length
}

/** 读回自检：撤回事件必须至少撤回一条**可解析的提交身份** */
export function assertRetractionReadback(payload: StoryExperienceRetractedPayload): void {
  if (payload.withdrawnStoryRefs.length === 0) {
    throw new KernelError(
      'validation_error',
      'story_retraction_without_target',
      '撤回事件没有撤回任何东西：这类事件不允许存在（"撤回了什么"必须可查）'
    )
  }
}
