/**
 * 分层去重与冲突分析 —— **"这是同一条、是新状态、还是矛盾？"**
 * （计划书第 75–82、128–130 节）。
 *
 * ============================================================================
 *  计划书把去重明确分成三层（第 75–77 节）
 * ============================================================================
 *     第一层：Exact Fingerprint      —— 内容完全相同 → REJECT_DUPLICATE
 *     第二层：Canonical Key          —— 同一事实槽位 → 找冲突对象
 *     第三层：Semantic Judge         —— 自然语言（Episode）→ 有限候选 + judge
 *
 * 第一层已经落在 `memory-validator.ts`（`duplicate_content`）。
 * 本文件实现**第二层的判定**与**冲突分类**；第三层的端口在
 * `target-resolver.ts` 的 `SemanticJudgePort`（已实现两个：LLM 与词面）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 计划书第 79 节特别强调：**Conflict 与 Duplicate 不是一回事**
 * ---------------------------------------------------------------------------
 *     Memory A：Alex 喜欢咖啡
 *     Memory B：Alex 喜欢咖啡     → duplicate
 *
 *     Memory B：Alex 不喝咖啡了    → 可能是 temporal update，不是 duplicate
 *
 * 把两者混起来的后果是**方向相反的**：
 *   · 把 temporal update 当 duplicate → 新状态被丢掉，"她以为他还喜欢咖啡"
 *   · 把 duplicate 当 temporal update → 每次重复陈述都制造一条新记忆 + 一次
 *     supersede，历史被淹没在噪声里
 *
 * 因此本文件的输出是一个**判别联合**，而不是"重复/不重复"两个布尔。
 */

import {
  contentFingerprintOf,
  entityLabel,
  isClaimContent,
  slotOfCandidate,
  slotOfRecord,
  type MemoryCandidate,
  type MemoryRecord,
} from '../../contracts/index.ts'

/*
 * ⚠️ `slotFingerprintOf` / `slotOfCandidate` / `slotOfRecord` 住在**契约层**
 * （`contracts/memory.ts`），不在这里。
 *
 * 第一版把它们写在本文件，结果放行口（`policies/memory-validator.ts`）
 * 需要它们时必须**反向 import app 层** —— 而那违反依赖方向
 * （app → policies → contracts 是单向的）。
 * 它们本来就是领域概念（与 `canonicalKeyOf` 同级），因此下沉到契约层。
 *
 * 本文件只保留**需要外部输入**的那部分：冲突分类与处置。
 */

export { slotOfCandidate, slotOfRecord, slotFingerprintOf } from '../../contracts/index.ts'

// ---------------------------------------------------------------------------
// 冲突分类（计划书第 80 节）
// ---------------------------------------------------------------------------

/**
 * 计划书第 80 节的输出集合。
 *
 * `AMBIGUOUS` 在这里的含义是"槽位上有太多条 ACTIVE，判不出该跟哪一条比"，
 * 它是**槽位级**的状态；而"两条静态取值直接冲突"在计划书里对应
 * `CONTRADICTION`（→ `MARK_DISPUTED`，第 82 节）。
 */
export type ConflictVerdict =
  | 'NO_CONFLICT'
  | 'DUPLICATE'
  | 'TEMPORAL_UPDATE'
  | 'CONTRADICTION'
  | 'AMBIGUOUS'

/** 槽位上最多容忍几条 ACTIVE 才能做确定性判定 */
export const MAX_ACTIVE_IN_SLOT_FOR_DETERMINISTIC_ANALYSIS = 3

export interface ConflictAnalysis {
  verdict: ConflictVerdict
  /** DUPLICATE / TEMPORAL_UPDATE / CONTRADICTION 时给出比对的那一条 */
  target?: MemoryRecord
  /** 人类可读依据（进 trace 与审计）——**必须**能回答"为什么这么判" */
  reason: string
}

/**
 * 判定"这条候选与这个槽位上已有的 ACTIVE 记录是什么关系"。
 *
 * ============================================================================
 *  判据（全部确定性，不调模型）
 * ============================================================================
 *     same canonicalKey + same slotFingerprint  → DUPLICATE
 *        （第 79 节的第一个例子：一模一样 → 不该新建）
 *
 *     same canonicalKey + 取值不同，且**候选的话里带状态变化标记**
 *                                               → TEMPORAL_UPDATE
 *        （第 81 节："我以前喝咖啡，但现在已经戒了" → 旧条 supersede）
 *
 *     same canonicalKey + 取值不同，且**没有变化标记**
 *                                               → CONTRADICTION
 *        （第 82 节："我最喜欢蓝色" / "我最讨厌蓝色" → 不擅自选一个，
 *          进 DISPUTED）
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ "有没有变化标记"必须来自**用户原话**，不能来自模型自造
 * ---------------------------------------------------------------------------
 * 这是本文件唯一需要外部输入的地方（`utterance`）。理由：
 *
 * "他改主意了"与"他说了一句矛盾的话"在**数据上长得一样**
 * （同一个槽位、两个不同的静态取值）。唯一能区分它们的东西是
 * **用户怎么说的** —— "我现在能吃了" vs "我从来不喜欢蓝色"。
 *
 * 而那个判断**不能**交给模型自报（`candidate.claim` 里加个
 * `isUpdate: true` 就行）：那等于让模型决定"要不要覆盖用户之前说过的话"。
 * 因此它来自用户的原话文本，由一张**确定性**的变化标记表判断。
 *
 * 表很短、且允许不完整：漏掉一个标记的后果是"这条进 DISPUTED"，
 * 而 DISPUTED 是**保守的**（不覆盖、不删除，等后续证据）——
 * 与"漏掉一个标记导致错误覆盖"相比，这是正确的失败方向。
 */
export interface AnalyzeConflictInput {
  candidate: MemoryCandidate
  /** 该槽位上已有的 ACTIVE 记录（由调用方查库得到） */
  activeInSlot: readonly MemoryRecord[]
  /** 用户的原话（用于判断"有没有状态变化标记"）。缺省 = 没有变化标记 */
  utterance?: string
}

export function analyzeConflict(input: AnalyzeConflictInput): ConflictAnalysis {
  const { candidate, activeInSlot } = input

  const slot = slotOfCandidate(candidate)
  if (slot === undefined) {
    // Episode / SELF_EXPERIENCE 没有槽位 —— 它们的去重走第三层
    // （计划书第 77 节：自然语言记忆用有限候选 + judge）
    return {
      verdict: 'NO_CONFLICT',
      reason: `${candidate.proposedType} 没有事实槽位（Episode 家族），去重走第三层语义判别`,
    }
  }

  const sameSlot = activeInSlot.filter((record) => {
    const other = slotOfRecord(record)
    return other !== undefined && other.canonicalKey === slot.canonicalKey
  })

  if (sameSlot.length === 0) {
    return { verdict: 'NO_CONFLICT', reason: '该槽位上没有 ACTIVE 记忆' }
  }

  if (sameSlot.length > MAX_ACTIVE_IN_SLOT_FOR_DETERMINISTIC_ANALYSIS) {
    // 同一槽位堆了太多 ACTIVE —— 这本身是一个**需要被看见的健康问题**
    // （正常流程下 supersede 会让旧条离开 active）。报 AMBIGUOUS 而不是
    // 挑一条来比，因为"挑错了"会覆盖错记忆。
    return {
      verdict: 'AMBIGUOUS',
      reason:
        `槽位上有 ${sameSlot.length} 条 ACTIVE（超过确定性判定的上限 ` +
        `${MAX_ACTIVE_IN_SLOT_FOR_DETERMINISTIC_ANALYSIS}）。` +
        '这本身说明有 supersede 没走完，应当先审计而不是挑一条来比',
    }
  }

  // 完全相同的槽位取值 → duplicate
  const exact = sameSlot.find((record) => {
    const other = slotOfRecord(record)
    return other !== undefined && other.slotFingerprint === slot.slotFingerprint
  })
  if (exact !== undefined) {
    return {
      verdict: 'DUPLICATE',
      target: exact,
      reason:
        `同一槽位（${slot.canonicalKey}）的取值与已有记忆完全相同` +
        `（slotFingerprint ${slot.slotFingerprint}）`,
    }
  }

  // 取值不同 → 看用户原话里有没有状态变化标记
  const target = sameSlot[0]
  const marker = findTemporalChangeMarker(input.utterance)

  if (marker !== undefined) {
    return {
      verdict: 'TEMPORAL_UPDATE',
      target,
      reason:
        `同一槽位的取值不同，且用户原话里出现状态变化标记「${marker}」` +
        '（计划书第 81 节：旧条 supersede + 新条 active）',
    }
  }

  return {
    verdict: 'CONTRADICTION',
    target,
    reason:
      `同一槽位的取值不同，且用户原话里**没有**状态变化标记。` +
      '计划书第 82 节：不擅自选一个（那可能是一次玩笑或一次笔误），进 DISPUTED',
  }
}

/**
 * 状态变化标记（"我改主意了"）。
 *
 * 与 `content-extractor.ts` 的线索词表同一条理由：**它不完整、
 * 而且允许不完整**。漏掉一个标记的后果是"这条进 DISPUTED"，
 * 而 DISPUTED 是保守的（不覆盖、不删除）——
 * 比"漏掉一个标记导致错误覆盖用户之前说过的话"安全得多。
 */
const TEMPORAL_CHANGE_MARKERS: readonly string[] = [
  '现在',
  '如今',
  '后来',
  '最近',
  '已经',
  '不再',
  '改成',
  '改一下',
  '戒了',
  '变了',
  '以前是',
  '从今',
  '将来',
  '以后',
]

/** 找出原话里的第一个状态变化标记 */
export function findTemporalChangeMarker(utterance: string | undefined): string | undefined {
  if (utterance === undefined || utterance.trim() === '') return undefined
  return TEMPORAL_CHANGE_MARKERS.find((marker) => utterance.includes(marker))
}

// ---------------------------------------------------------------------------
// 冲突处置（计划书第 81–84 节）
// ---------------------------------------------------------------------------

/**
 * 冲突的处置决定。
 *
 * ⚠️ 它是一个**动作**，不是"要不要覆盖"一个布尔。
 *
 * 因为 `SUPERSEDE` 与 `MARK_DISPUTED` 在实现上是两件不同的事
 * （前者写 `validUntil` + `supersededBy`，后者只改 status），
 * 而用一个布尔 + 外部判断会把那个区分散到调用点，
 * 于是某天会有一个分支把"矛盾"当成"更新"处理 —— 而那是**静默覆盖**。
 */
export type ConflictResolution =
  | { action: 'CREATE'; reason: string }
  | { action: 'REJECT_DUPLICATE'; target: MemoryRecord; reason: string }
  | { action: 'SUPERSEDE'; target: MemoryRecord; reason: string }
  | { action: 'MARK_DISPUTED'; target: MemoryRecord; reason: string }
  | { action: 'NEEDS_REVIEW'; reason: string }

/**
 * 把冲突判定变成处置决定。
 *
 * **纯函数**：它不改任何东西，只回答"该做什么"。
 * 真正的写入由 pipeline 按这个决定发出对应的事件。
 */
export function resolveConflict(analysis: ConflictAnalysis): ConflictResolution {
  switch (analysis.verdict) {
    case 'NO_CONFLICT':
      return { action: 'CREATE', reason: analysis.reason }

    case 'DUPLICATE':
      // 一模一样 → 不新建。计划书第 75 节的 REJECT_DUPLICATE
      return {
        action: 'REJECT_DUPLICATE',
        target: analysis.target!,
        reason: analysis.reason,
      }

    case 'TEMPORAL_UPDATE':
      // 第 81 节：旧条 supersede（旧条留痕、不再是现状），新条 active
      return {
        action: 'SUPERSEDE',
        target: analysis.target!,
        reason: analysis.reason,
      }

    case 'CONTRADICTION':
      // 第 82 节：**不擅自选一个**。标记为争议，等后续证据澄清
      return {
        action: 'MARK_DISPUTED',
        target: analysis.target!,
        reason: analysis.reason,
      }

    case 'AMBIGUOUS':
      // 判不了 → 让人看见。**不猜、不挑、不覆盖**
      return { action: 'NEEDS_REVIEW', reason: analysis.reason }
  }
}

// ---------------------------------------------------------------------------
// 用户确认的规范化（计划书第 28 / 33 节）
// ---------------------------------------------------------------------------

/**
 * "Assistant guess + User response" 应当只留下**一条**记忆（计划书第 28 节）。
 *
 *     苏沐薇："你是不是不太喜欢聚会？"
 *     Alex："没有啊，我其实挺喜欢的。"
 *
 *     最终应该：
 *       Assistant guess → 不形成 Preference
 *       User response   → PREFERENCE: user likes gatherings
 *
 * 而不是保存两条同级 Memory。
 *
 * 这条在实现上由**两道已经存在的闸**共同保证，本函数是第三道（可断言的那道）：
 *   1. 抽取器的 Source Firewall 不采信她的输出（`canEvidenceExternalFact`）
 *   2. 用户的回复是 `EXPLICIT_USER_STATEMENT`，它**自己就足以**建立记忆
 *   3. 本函数：当她**先**提出一个猜测、用户随后确认时，
 *      只保留用户那一轮的证据（她的猜测不作为证据）
 *
 * 返回值是"应当保留的证据 id"——调用方据此过滤候选的 `sourceRefs`。
 * 若返回全部（没有需要剔除的），调用方行为不变。
 */
export function evidenceExcludingCharacterGuess(input: {
  /** 候选的证据（按事件序） */
  sourceRefs: readonly { kind: string; id: string }[]
  /** 哪些事件是"她自己的输出"（由装配层用 actorType 判定） */
  characterEventIds: readonly string[]
}): { kind: string; id: string }[] {
  const hers = new Set(input.characterEventIds)
  const kept = input.sourceRefs.filter((ref) => !hers.has(ref.id))
  /*
   * ⚠️ 若剔除之后**什么都不剩**，返回原集合而不是空集。
   *
   * 因为空证据会被 `assertMemoryEvidence` 拒绝 —— 而那时正确的行为是
   * "让契约断言去拒这条候选"（它有清晰的错误码），
   * 不是在这里制造一个空集然后让下游报一个含糊的错误。
   */
  return kept.length > 0 ? kept : [...input.sourceRefs]
}

/** 便于 trace：一行摘要（**不含正文**） */
export function summarizeConflict(analysis: ConflictAnalysis): string {
  const target =
    analysis.target !== undefined
      ? ` → ${String(analysis.target.id)} (${entityLabel(analysis.target.owner)})`
      : ''
  return `${analysis.verdict}${target}`
}

/** 便于调用方：从候选与记录直接算内容指纹（去重第一层的判定口） */
export function fingerprintOfCandidate(candidate: MemoryCandidate): string {
  return contentFingerprintOf({
    owner: candidate.owner,
    type: candidate.proposedType,
    content: candidate.proposedContent,
    subjects: candidate.subjects,
  })
}
