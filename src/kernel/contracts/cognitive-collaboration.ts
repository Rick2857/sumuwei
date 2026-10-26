/**
 * 认知能力协作契约 · **世界模型 ＋ EBL 一条链**（2026-10-21 · 计划 P1）
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  计划 §3 P1 逐字要求：
 *
 *      「从现有 EBL 与预测契约**列字段缺口**：来源/revision、主体/范围、当前状态、
 *        规则/模型版本、实际动作和参数绑定、原始根、政策、使用记录、失效原因。
 *        **优先扩展现有类型与适配器。**
 *
 *      规则消费者先取得**当前合格快照**；**提交前**复核基准版本与来源；
 *        **执行前**检查计划所依赖的规则是否仍可用。
 *        把**迟到/已取消**的模型结果挡在**提交口**。
 *        **暂不创建万能 Candidate、统一领域状态机或能处理任意 JSON 的提交器。**」
 *
 *  ⇒ 本文件就是那三个接点的**窄形状**与**纯判据**：
 *    ① `UsableRuleSnapshot` —— EBL → 世界模型引擎的「当前合格规则快照」
 *    ② `verifyBaselineBeforeCommit` —— 提交前的基准复核
 *    ③ `verifyPlanRulesStillUsable` —— 执行前的依赖复核
 *    ④ `verifyModelResultAtCommit` —— 提交口的迟到/已取消拦截
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ① **不新建万能 Candidate**：本文件**不**定义"候选"的通用形状 ——
 *    规则候选仍是 `world-model.ts` 的 `RuleCandidate`（有闭集字段与失败关闭校验），
 *    信念候选仍是 EBL 的 `EblClaim`。这里只描述**"已被判定合格的规则"**如何被**引用**。
 * ② **不建统一领域状态机**：`status` 是**引用**（EBL 的状态字符串），
 *    本文件**不**定义新状态、不做状态迁移、不合并各域的 validated / 可发布 / 可召回。
 * ③ **不建任意 JSON 提交器**：提交口的判据是**具名闭集**（`RULE_INVALIDATION_REASONS`），
 *    不是"把一个 JSON 塞进来看看"。
 *
 * ⚠️ 纯类型 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 * ⚠️ **不 import EBL 契约**：本文件对 EBL **无知** ⇒ 领域之间不形成依赖环；
 *    映射由**适配器**做（`src/infrastructure/…`），那是唯一知道两边形状的地方。
 */

import { KernelError } from './ids.ts'

/** 契约自身的版本（读数要能回答"这份形状按哪一版写的"）。 */
export const COGNITIVE_COLLABORATION_VERSION = 'cognitive-collaboration@1'

// ---------------------------------------------------------------------------
// 失效原因（闭集 · 具名）
// ---------------------------------------------------------------------------

/**
 * 一条规则**为什么**不能被消费（闭集）。
 *
 * ⚠️ 必须是**闭集**：否则"失效原因"会退化成一句自由文本，
 *    而消费方要做的是**机器判定**（拒用 / 重新推演 / 保留事实），
 *    不是"读一句理由然后自己判断"。
 */
export const RULE_INVALIDATION_REASONS = [
  'source_withdrawn',    // 来源被撤回（EBL 的 withdraw / forbiddenRoots）
  'version_conflict',    // 基准版本与当前不一致（规则版本或证据指纹变了）
  'subject_mismatch',    // 主体 / 范围 / 环境与消费时不一致（**错绑**）
  'not_usable',          // 当前状态不允许消费（pending / suspended / retired …）
  'late_result',         // 模型结果迟到（产出时用的基准已经不是当前基准）
  'cancelled_result',    // 模型结果已被取消
] as const
export type RuleInvalidationReason = (typeof RULE_INVALIDATION_REASONS)[number]

/** 判据失败时抛出的错误（失败关闭；`code` 就是上面的闭集值） */
export function ruleInvalidationError (reason: RuleInvalidationReason, detail: string): KernelError {
  return new KernelError('validation_error', reason, detail)
}

// ---------------------------------------------------------------------------
// ① 当前合格规则快照（EBL → 世界模型引擎）
// ---------------------------------------------------------------------------

/** 来源引用（**引用**，不是正文） */
export interface RuleSourceRef {
  /** 来源种类（`conversation` / `action` …；由适配器映射，本文件不定义闭集） */
  readonly kind: string
  /** 来源 id */
  readonly id: string
  /** 该来源当时的 revision（**真实值**，不是占位） */
  readonly revision: string
}

/**
 * 一条**当前合格规则**的快照。
 *
 * ⚠️ 它是**引用 + 判据**，不是规则正文：规则正文属于 `RuleCandidate`（受
 *    `assertRestrictedRuleStatement` 约束），而这里是"引擎可以拿到的**合格**版本"。
 *    ⇒ 引擎**消费**它，**不执行**它。
 */
export interface UsableRuleSnapshot {
  /** 命题身份（EBL 的 claim id） */
  readonly claimId: string
  /** 命题内容必须随快照传递，不能仅凭范围推断规则含义。 */
  readonly predicate: string
  readonly expected: string | boolean
  /** 命题版本（**当前**版本；提交前要与基准逐字比对） */
  readonly claimVersion: number
  /** 政策版本（EBL 的 policy；不同政策下的同一条命题**不是**同一条资格） */
  readonly policy: string
  /** 主体（谁） */
  readonly subjectId: string
  /** 范围（适用范围） */
  readonly scope: string
  /** 环境（工具 / 运行环境版本所在的口径） */
  readonly environment: string
  /** 附加条件（键值；**空**表示无条件） */
  readonly conditions: Readonly<Record<string, string>>
  /** **规则**版本（与 claim 版本**分开**：前者是规则内容的版本） */
  readonly ruleVersion: string
  /** 来源引用 + 各自 revision（**当前**证据指纹的原料） */
  readonly sources: readonly RuleSourceRef[]
  /** 当前证据指纹（EBL 的 `sources.fingerprint`；**变了**就意味着证据动过） */
  readonly evidenceFingerprint: string
  /** 当前状态（EBL 的 status；**引用**，本文件不定义状态闭集） */
  readonly status: string
  /** 是否当前可用 */
  readonly usable: boolean
  /** 失效原因（`usable === false` 时给出） */
  readonly invalidatedReason?: RuleInvalidationReason
}

/**
 * 规则快照的**读面**（端口）。
 *
 * ⚠️ 它只有"按 claim id 取当前快照"这一件事 ——
 *    规则消费者**先取得当前合格快照**（计划 §3 P1），
 *    至于"怎么读"是 EBL 侧的事（适配器实现），本契约不关心。
 */
export interface RuleSnapshotPort {
  /** 当前快照（没有这条命题 ⇒ undefined） */
  current (claimId: string): Promise<UsableRuleSnapshot | undefined>
  /**
   * **当前**的全部命题快照（按 claim id 排序）。
   *
   * ⚠️ 它**只**给"当前状态"（每条命题的快照），**不给**"库里所有的行"：
   *    规则消费者要的是"**当前合格**的规则"，不是"检索到的所有东西"。
   *    ⇒ 计划 §3 P2 的「避免全库检索结果直接变成可用规则」在**读面**上就成立。
   */
  list (): Promise<UsableRuleSnapshot[]>
}

// ---------------------------------------------------------------------------
// 规则选择（消费的第一步）
// ---------------------------------------------------------------------------

/** 消费方**看得见**的状态（真实可见状态，不是"检索结果"） */
export interface VisibleRuleContext {
  /** 主体（谁） */
  readonly subjectId: string
  /** 适用范围 */
  readonly scope: string
  /** 环境（工具 / 运行环境版本所在的口径） */
  readonly environment: string
  /**
   * 当前**已知**的条件。
   *
   * ⚠️ 键的**集合**就是"我们知道哪些条件"；值是它们的取值。
   *    ⇒ 规则要求一个**我们不知道**的条件 ⇒ 那是 **unknown**，不是"不适用"。
   */
  readonly conditions: Readonly<Record<string, string>>
}

/** 一条规则**为什么**没被选中（闭集） */
export const RULE_SELECTION_SKIPS = [
  'subject_mismatch',    // 主体不同（**不是**给这条主体的规则）
  'scope_mismatch',      // 范围不同
  'environment_mismatch',// 环境不同
  'condition_unknown',   // ⚠️ 规则要的条件**我们不知道** ⇒ 未知，不是"不适用"
  'condition_mismatch',  // 条件已知但**对不上**
  'not_usable',          // 当前不合格（撤回 / 挂起 / 证据动过）
] as const
export type RuleSelectionSkip = (typeof RULE_SELECTION_SKIPS)[number]

export interface RuleSelection {
  /** 选中的规则（**当前合格**且**适用**） */
  readonly selected: readonly UsableRuleSnapshot[]
  /** 没选中的（逐条给出原因） */
  readonly skipped: ReadonlyArray<{
    readonly claimId: string
    readonly reason: RuleSelectionSkip
    readonly detail: string
  }>
}

/**
 * 从**当前快照**里选出"在**这个**可见状态下适用且合格"的规则。
 *
 * ⚠️ 三个刻意的设计：
 * ① **只从当前快照里选**（不是"检索到什么就用什么"）——
 *    拿不到当前快照的规则**不会**被选进来。
 * ② **"条件未知"与"条件不匹配"分开**：
 *    规则要 `encoding=utf8` 而我们**不知道** encoding ⇒ 这是 **unknown**
 *    （推演要停下来问），**不是**"这条规则不适用"（那会静默少一条规则）。
 * ③ **不合格的规则不算"不适用"**：它的原因是"现在不能用"，要能被单独看见。
 */
export function selectUsableRules (input: {
  readonly snapshots: readonly UsableRuleSnapshot[]
  readonly visible: VisibleRuleContext
}): RuleSelection {
  const selected: UsableRuleSnapshot[] = []
  const skipped: Array<{ claimId: string; reason: RuleSelectionSkip; detail: string }> = []
  for (const snapshot of input.snapshots) {
    if (!snapshot.usable) {
      skipped.push({
        claimId: snapshot.claimId,
        reason: 'not_usable',
        detail: `当前状态 ${snapshot.status} 不可用（${String(snapshot.invalidatedReason ?? 'not_usable')}）`,
      })
      continue
    }
    if (snapshot.subjectId !== input.visible.subjectId) {
      skipped.push({ claimId: snapshot.claimId, reason: 'subject_mismatch', detail: `主体 ${snapshot.subjectId} ≠ ${input.visible.subjectId}` })
      continue
    }
    if (snapshot.scope !== input.visible.scope) {
      skipped.push({ claimId: snapshot.claimId, reason: 'scope_mismatch', detail: `范围 ${snapshot.scope} ≠ ${input.visible.scope}` })
      continue
    }
    if (snapshot.environment !== input.visible.environment) {
      skipped.push({ claimId: snapshot.claimId, reason: 'environment_mismatch', detail: `环境 ${snapshot.environment} ≠ ${input.visible.environment}` })
      continue
    }
    const unknown = Object.keys(snapshot.conditions).filter(key => input.visible.conditions[key] === undefined)
    if (unknown.length > 0) {
      skipped.push({
        claimId: snapshot.claimId,
        reason: 'condition_unknown',
        detail: `条件未知：${unknown.join(', ')}（**不是**"不适用"——推演要在这里停）`,
      })
      continue
    }
    const mismatched = Object.keys(snapshot.conditions).filter(key => input.visible.conditions[key] !== snapshot.conditions[key])
    if (mismatched.length > 0) {
      skipped.push({
        claimId: snapshot.claimId,
        reason: 'condition_mismatch',
        detail: `条件不匹配：${mismatched.map(key => `${key}=${String(input.visible.conditions[key])} ≠ ${String(snapshot.conditions[key])}`).join(', ')}`,
      })
      continue
    }
    selected.push(snapshot)
  }
  return { selected, skipped }
}

// ---------------------------------------------------------------------------
// ② 提交前：复核基准版本与来源
// ---------------------------------------------------------------------------

/** 提交时**声称**的基准（"我是按这一版做的"） */
export interface RuleBaseline {
  readonly claimId: string
  readonly claimVersion: number
  readonly ruleVersion: string
  readonly evidenceFingerprint: string
}

export type RuleVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RuleInvalidationReason; readonly detail: string }

/**
 * 提交前复核：基准版本与来源必须**仍然**成立。
 *
 * ⚠️ 顺序要紧：**先**比版本/指纹（变了 ⇒ `version_conflict`），
 *    **再**比主体/范围/环境（错绑 ⇒ `subject_mismatch`），
 *    **最后**看当前状态（不可用 ⇒ `not_usable` / `source_withdrawn`）。
 *    ⇒ 一个失效只报**一个**最具体的原因（先到先得），不堆一堆。
 */
export function verifyBaselineBeforeCommit (input: {
  readonly baseline: RuleBaseline
  readonly current: UsableRuleSnapshot | undefined
  /** 消费方的口径（主体 / 范围 / 环境）；与快照不一致 ⇒ 错绑 */
  readonly expected: {
    readonly subjectId: string
    readonly scope: string
    readonly environment: string
  }
}): RuleVerdict {
  const { baseline, current, expected } = input
  if (current === undefined) {
    return { ok: false, reason: 'not_usable', detail: `命题 ${baseline.claimId} 当前没有快照` }
  }
  if (
    current.claimVersion !== baseline.claimVersion ||
    current.ruleVersion !== baseline.ruleVersion ||
    current.evidenceFingerprint !== baseline.evidenceFingerprint
  ) {
    return {
      ok: false,
      reason: 'version_conflict',
      detail:
        `基准与当前不一致：claim v${String(baseline.claimVersion)}→v${String(current.claimVersion)} · ` +
        `rule ${baseline.ruleVersion}→${current.ruleVersion} · ` +
        `证据指纹 ${baseline.evidenceFingerprint.slice(0, 12)}→${current.evidenceFingerprint.slice(0, 12)}`,
    }
  }
  if (
    current.subjectId !== expected.subjectId ||
    current.scope !== expected.scope ||
    current.environment !== expected.environment
  ) {
    return {
      ok: false,
      reason: 'subject_mismatch',
      detail:
        `错绑：期望 主体=${expected.subjectId}/范围=${expected.scope}/环境=${expected.environment}，` +
        `实际 主体=${current.subjectId}/范围=${current.scope}/环境=${current.environment}`,
    }
  }
  if (!current.usable) {
    return {
      ok: false,
      reason: current.invalidatedReason ?? 'not_usable',
      detail: `命题 ${baseline.claimId} 当前状态 ${current.status} 不可用`,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// ③ 执行前：计划依赖的规则是否仍可用
// ---------------------------------------------------------------------------

/** 计划对一条规则的**依赖声明**（计划侧记的"我按哪一版做的"） */
export interface PlanRuleDependency {
  readonly claimId: string
  readonly ruleVersion: string
  readonly evidenceFingerprint: string
}

/**
 * 执行前复核：计划依赖的每一条规则都必须**仍然可用**。
 *
 * ⚠️ **一条不可用就整份计划不可用**（不"挑还能用的那条"）——
 *    计划里的步骤是有依赖顺序的，挑一条继续跑等于在下标上撒谎。
 */
export async function verifyPlanRulesStillUsable (input: {
  readonly dependencies: readonly PlanRuleDependency[]
  readonly snapshot: RuleSnapshotPort
}): Promise<RuleVerdict> {
  for (const dependency of input.dependencies) {
    const current = await input.snapshot.current(dependency.claimId)
    if (current === undefined) {
      return { ok: false, reason: 'not_usable', detail: `计划依赖的命题 ${dependency.claimId} 当前没有快照` }
    }
    if (
      current.ruleVersion !== dependency.ruleVersion ||
      current.evidenceFingerprint !== dependency.evidenceFingerprint
    ) {
      return {
        ok: false,
        reason: 'version_conflict',
        detail:
          `计划依赖的命题 ${dependency.claimId} 已变：` +
          `rule ${dependency.ruleVersion}→${current.ruleVersion} · ` +
          `证据指纹 ${dependency.evidenceFingerprint.slice(0, 12)}→${current.evidenceFingerprint.slice(0, 12)}`,
      }
    }
    if (!current.usable) {
      return {
        ok: false,
        reason: current.invalidatedReason ?? 'not_usable',
        detail: `计划依赖的命题 ${dependency.claimId} 当前状态 ${current.status} 不可用`,
      }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// ④ 提交口：挡迟到 / 已取消的模型结果
// ---------------------------------------------------------------------------

/**
 * 模型结果的**基准声明**（"我是按这一版状态做的"）。
 *
 * ⚠️ `producedAt` 由**程序**给（不是模型自报）⇒ 迟到与否能机械判定。
 */
export interface ModelResultBaseline {
  /** 产出时使用的输入 revision */
  readonly inputRevision: string
  /** 产出的时刻（程序给的） */
  readonly producedAt: number
  /** 结果是否已被取消（取消动作先于提交到达） */
  readonly cancelled: boolean
}

/**
 * 提交口复核：迟到或已取消的模型结果**不许**提交。
 *
 * ⚠️ 顺序：**先**看已取消（最硬：它根本不该存在），
 *    **再**看迟到（产出时的基准已经不是当前基准 ⇒ 结论可能建立在过时的状态上）。
 */
export function verifyModelResultAtCommit (input: {
  readonly baseline: ModelResultBaseline
  /** 提交时的当前输入 revision */
  readonly currentRevision: string
}): RuleVerdict {
  const { baseline, currentRevision } = input
  if (baseline.cancelled) {
    return { ok: false, reason: 'cancelled_result', detail: '模型结果已被取消，不许提交' }
  }
  if (baseline.inputRevision !== currentRevision) {
    return {
      ok: false,
      reason: 'late_result',
      detail:
        `模型结果迟到：产出时基准 ${baseline.inputRevision}，` +
        `提交时当前基准 ${currentRevision}`,
    }
  }
  return { ok: true }
}
