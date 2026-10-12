/**
 * M5.1.1 / Phase 4b —— **一条已有记忆的「当前认知资格」**（ADR-043 §3.1 / §3.2）。
 *
 * ============================================================================
 *  它回答什么
 * ============================================================================
 * ```text
 *   这条记忆**今天**凭什么算数？它的来源**确立了吗**？
 * ```
 * 与 4a 的形成期闸是**同一个判据**，只是问的对象不同：
 *
 * ```text
 *   4a（形成期）  这条**新候选**的证据来源确立了吗  ⇒ 不确立就不许建立记忆
 *   4b（存量）    这条**已存在**的记忆今天的资格是什么 ⇒ 派生量，不落库
 * ```
 *
 * ⚠️ **它只派生，不改任何东西**（ADR-043 `DR-1`）：
 *    · 不重算 `memory_records.authority`（那是**当时**的判定，不可变）
 *    · 不写库、不改 `MemoryStatus`
 *    · 纯函数，输入只有"记忆类型 + 各根证据的受信读数 + 规则版本"
 *
 * ----------------------------------------------------------------------------
 *  与 4a 的**同一个**判据（`DR-2`：一个概念一个名字）
 * ----------------------------------------------------------------------------
 * 取值的三个字面量**复用** 4a 已经落地的 `SourceQualification`
 * （用户 `D-2 = ①` 裁定：不新引入 `MemoryQualification` 类型 ——
 *  同一组三值两个名字正是仓库明令禁止的"两套方言"）。
 * 每一条根证据的判定也**直接调用** 4a 的 `sourceQualificationOf()` ——
 * 这里不重写一遍"什么算已确立"，否则两处判据会漂移，而漂移的表现是
 * "同一条证据在形成期被拒、在存量期却被认为已确立"。
 */

import {
  COGNITIVE_QUALIFICATION_RULE_VERSION,
  sourceQualificationOf,
  type SourceQualification,
  type TrustedOriginReading,
} from '../contracts/attribution.ts'
import type { MemoryType } from '../contracts/memory.ts'

/**
 * 这条记忆的资格**不适用**（`DR-5`：Episode 面不进本规则）。
 *
 * 用 `undefined` 而不是第四个枚举值表达它：三值域是 ADR 冻结的，
 * "不适用"是**函数的定义域之外**，不是第四个取值。
 * 混成一个枚举值会让"不适用"与"不知道"在统计里长得一样。
 */
export const QUALIFICATION_NOT_APPLICABLE = undefined

/** 本规则只对"关于用户个人的事实"求值 —— 与 4a 的闸、M4 的闸 4 **同一射程** */
export function qualificationAppliesTo(memoryType: MemoryType): boolean {
  return memoryType === 'person_fact' || memoryType === 'preference'
}

/**
 * **唯一**的资格派生（ADR-043 §3.2）。
 *
 * ```text
 * 1. `memoryType` 不在射程内                        → `undefined`（不适用，DR-5）
 * 2. 规则版本不是已知版本                            → UNCONFIRMED_ORIGIN（fail-closed：未知规则不猜）
 * 3. 没有根证据读数（空数组）                        → UNCONFIRMED_ORIGIN（DR-7 失败关闭）
 * 4. 有任一条根证据已确立                            → ESTABLISHED
 * 5. 否则有任一条根证据**知道不是他**                → CONTRADICTED_ORIGIN
 * 6. 其余（全部"不知道"）                            → UNCONFIRMED_ORIGIN
 * ```
 *
 * ⚠️ 第 4/5 条的**优先级**与 4a 的闸**逐字一致**（"已确立优先于知道不是他"）：
 *    一条记忆有多条根证据时，"有一条能确立来源"就够 —— 这与 4a 里
 *    `qualifications.some(qualificationEstablishesUserFact)` 是同一个判断。
 */
export function memoryQualificationOf(input: {
  memoryType: MemoryType
  /**
   * 该记忆**根证据**各自的受信读数。
   *
   * `undefined` 元素 = 那一条根证据**没有受信信封**（历史行 / `MIGRATED_LEGACY` / 形状坏）
   * ⇒ 按 `DR-7` 一律算"来源未确立"，**不**回落到 `actor_type`。
   */
  rootReadings: readonly (TrustedOriginReading | undefined)[]
  /** 规则版本是**输入** ⇒ "同一个账本 + 不同版本 ⇒ 可解释的不同结果"（ADR §3.2 不变量 ③） */
  ruleVersion: number
}): SourceQualification | undefined {
  if (!qualificationAppliesTo(input.memoryType)) return QUALIFICATION_NOT_APPLICABLE
  if (input.ruleVersion !== COGNITIVE_QUALIFICATION_RULE_VERSION) return 'UNCONFIRMED_ORIGIN'
  if (input.rootReadings.length === 0) return 'UNCONFIRMED_ORIGIN'

  const perRoot = input.rootReadings.map((reading) => sourceQualificationOf(reading))
  if (perRoot.some((qualification) => qualification === 'ESTABLISHED')) return 'ESTABLISHED'
  if (perRoot.some((qualification) => qualification === 'CONTRADICTED_ORIGIN')) {
    return 'CONTRADICTED_ORIGIN'
  }
  return 'UNCONFIRMED_ORIGIN'
}

/**
 * 资格是否**扣分**（ADR-043 §3.3 ⑥：authority 分量按降一档计，**不改库值**）。
 *
 * ⚠️ 只对**已定义**的资格扣分：Episode 面（`undefined`）不进本规则。
 */
export function qualificationPenalizesAuthority(qualification: SourceQualification | undefined): boolean {
  return qualification !== undefined && qualification !== 'ESTABLISHED'
}

/**
 * Prompt 标签后缀（ADR-043 §3.3 ⑦）。
 *
 * ```text
 * ESTABLISHED           ''（**不加任何东西** —— 不变才让"今天"与"4b 之前"可比）
 * UNCONFIRMED_ORIGIN    ' / 来源未确立'
 * CONTRADICTED_ORIGIN   ' / 来源与记录不符'
 * 不适用（undefined）    ''
 * ```
 *
 * ⚠️ 两个后缀**必须不同**：它们对"能不能建立用户事实"的答案是同一个（都不能），
 *    但对"该怎么说"不同（ADR-043 §3.5 说的"三值不可互相折叠"）。
 */
export function qualificationLabelSuffix(qualification: SourceQualification | undefined): string {
  if (qualification === 'UNCONFIRMED_ORIGIN') return ' / 来源未确立'
  if (qualification === 'CONTRADICTED_ORIGIN') return ' / 来源与记录不符'
  return ''
}

/** 按三档汇总（开发者平面/审计用；不适用的一律**不计数**，避免与"不知道"混在一起） */
export interface QualificationCounts {
  readonly established: number
  readonly unconfirmedOrigin: number
  readonly contradictedOrigin: number
}

export function countQualifications(
  values: readonly (SourceQualification | undefined)[]
): QualificationCounts {
  let established = 0
  let unconfirmedOrigin = 0
  let contradictedOrigin = 0
  for (const value of values) {
    if (value === 'ESTABLISHED') established += 1
    else if (value === 'CONTRADICTED_ORIGIN') contradictedOrigin += 1
    else if (value === 'UNCONFIRMED_ORIGIN') unconfirmedOrigin += 1
  }
  return { established, unconfirmedOrigin, contradictedOrigin }
}
