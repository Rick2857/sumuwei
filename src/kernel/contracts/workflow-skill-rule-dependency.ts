/**
 * P3-4 —— **技能 → P2 规则资格的可选依赖契约**（kernel 纯类型 + 纯判据）。
 *
 * ============================================================================
 *  计划 §7 P3-4 逐字要求（本文件只落这几条）
 * ============================================================================
 * ```text
 * · 「用独立的受限测试技能引用已有 P2 测试规则，走实际资格读面验证依赖契约；
 *    该测试技能不进入产品目录。」
 * · 「核对正确规则/版本/范围可消费，错误范围、未知、挂起、撤回、替代版本
 *    不能被当作当前合格依赖。」
 * · 「加载之后、动作之前规则失效，后续依赖动作不得继续沿用旧资格；
 *    记录具体阻断原因，不声称已撤销发生过的副作用。」
 * · 「P3 不复制一套 EBL 资格系统，不把技能成功、模拟结果或反思文本回灌成独立规则证据。」
 * ```
 *
 * ---------------------------------------------------------------------------
 *  三条设计约束（决定这个文件为什么这么小）
 * ---------------------------------------------------------------------------
 * ① **不复制资格系统**：资格判据仍然只有 P1/P2 那份（`cognitive-collaboration.ts`
 *    的 `selectUsableRules` / `verifyPlanRulesStillUsable`）。本文件**只**做两件事：
 *    把"技能声明的依赖"翻译成那两份判据的输入，并把"阻断原因"映射成**闭集码**。
 *    ⇒ 不会出现"两套实现算出两个答案"。
 * ② **不认识 EBL**：状态字符串只是**引用**（`ruleStatus`），本文件不定义状态、
 *    不做迁移、不算证据资格。真实快照由适配器从 EBL 只读读面取（infrastructure 的事）。
 * ③ **不写任何状态**：本文件是纯判定；"记录阻断原因"由调用方把返回的
 *    `WorkflowSkillRuleDependencyBlock` 放进**动作失败详情/账本**（不改 EBL 任何状态）。
 *
 * ⚠️ 纯类型 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import {
  RULE_INVALIDATION_REASONS,
  selectUsableRules,
  verifyPlanRulesStillUsable,
  type PlanRuleDependency,
  type RuleInvalidationReason,
  type RuleSnapshotPort,
  type UsableRuleSnapshot,
  type VisibleRuleContext,
} from './cognitive-collaboration.ts'

/** 契约版本（读数要能回答"这份形状按哪一版写的"）。 */
export const WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION = 'workflow-skill-rule-dependency@1'

// ---------------------------------------------------------------------------
// 声明（**测试技能资产里的旁挂文件**，不进产品目录）
// ---------------------------------------------------------------------------

/**
 * 一条**规则依赖声明**。
 *
 * ⚠️ `claimId` 是**引用**：技能不复制规则正文，也不重算资格。
 * ⚠️ `ruleVersion` / `evidenceFingerprint` 可选 —— 填了就是"必须还是这一版"，
 *    没填就是"只要是当前合格的那一版即可"。**填了更严，不填更宽**。
 */
export interface WorkflowSkillRuleDependencyDeclaration {
  readonly claimId: string
  readonly ruleVersion?: string
  readonly evidenceFingerprint?: string
}

/** 旁挂文件（一份技能一份） */
export interface WorkflowSkillRuleDependencyFile {
  readonly dependencyVersion: string
  readonly skillId: string
  readonly dependencies: readonly WorkflowSkillRuleDependencyDeclaration[]
}

/** 声明解析的闭集失败码 */
export const WORKFLOW_SKILL_RULE_DEPENDENCY_PARSE_CODES = [
  'file_not_object',
  'file_unknown_field',
  'dependency_version_mismatch',
  'skill_id_invalid',
  'dependencies_invalid',
  'declaration_invalid',
  'declaration_duplicate',
] as const
export type WorkflowSkillRuleDependencyParseCode =
  (typeof WORKFLOW_SKILL_RULE_DEPENDENCY_PARSE_CODES)[number]

export type WorkflowSkillRuleDependencyParseResult =
  | { readonly ok: true; readonly file: WorkflowSkillRuleDependencyFile }
  | { readonly ok: false; readonly code: WorkflowSkillRuleDependencyParseCode; readonly detail: string }

const FILE_FIELDS = new Set(['dependencyVersion', 'skillId', 'dependencies'])
const DECLARATION_FIELDS = new Set(['claimId', 'ruleVersion', 'evidenceFingerprint'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析旁挂声明（**闭集**：未知字段一律拒绝，不"看见了也当没看见"）。
 *
 * ⚠️ 为什么严：依赖声明是**受评资产的一部分**。放宽字段会让"我把依赖写成别的字段名"
 *    悄悄变成"没有依赖" ⇒ 安全属性反转。宁可加载失败。
 */
export function parseWorkflowSkillRuleDependencies(raw: unknown): WorkflowSkillRuleDependencyParseResult {
  if (!isRecord(raw)) return { ok: false, code: 'file_not_object', detail: '依赖声明文件必须是对象' }
  const unknown = Object.keys(raw).filter((key) => !FILE_FIELDS.has(key))
  if (unknown.length > 0) {
    return { ok: false, code: 'file_unknown_field', detail: `未知字段：${unknown.join(', ')}` }
  }
  if (raw.dependencyVersion !== WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION) {
    return {
      ok: false,
      code: 'dependency_version_mismatch',
      detail: `dependencyVersion 必须是 ${WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION}（收到 ${String(raw.dependencyVersion)}）`,
    }
  }
  if (typeof raw.skillId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(raw.skillId)) {
    return { ok: false, code: 'skill_id_invalid', detail: `skillId 形状不合法：${String(raw.skillId)}` }
  }
  if (!Array.isArray(raw.dependencies)) {
    return { ok: false, code: 'dependencies_invalid', detail: 'dependencies 必须是数组' }
  }
  const seen = new Set<string>()
  const dependencies: WorkflowSkillRuleDependencyDeclaration[] = []
  for (const [index, item] of raw.dependencies.entries()) {
    if (!isRecord(item)) {
      return { ok: false, code: 'declaration_invalid', detail: `第 ${String(index + 1)} 条依赖不是对象` }
    }
    const extra = Object.keys(item).filter((key) => !DECLARATION_FIELDS.has(key))
    if (extra.length > 0) {
      return { ok: false, code: 'declaration_invalid', detail: `第 ${String(index + 1)} 条依赖有未知字段：${extra.join(', ')}` }
    }
    if (typeof item.claimId !== 'string' || item.claimId.trim() === '' || item.claimId.length > 256) {
      return { ok: false, code: 'declaration_invalid', detail: `第 ${String(index + 1)} 条依赖的 claimId 不合法` }
    }
    for (const key of ['ruleVersion', 'evidenceFingerprint'] as const) {
      const value = item[key]
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '' || value.length > 256)) {
        return { ok: false, code: 'declaration_invalid', detail: `第 ${String(index + 1)} 条依赖的 ${key} 不合法` }
      }
    }
    if (seen.has(item.claimId)) {
      /* 同一条命题出现两次 ⇒ 判据会出现"第一次通过、第二次被忽略"的分裂，直接拒 */
      return { ok: false, code: 'declaration_duplicate', detail: `依赖声明重复：${item.claimId}` }
    }
    seen.add(item.claimId)
    dependencies.push({
      claimId: item.claimId,
      ...(typeof item.ruleVersion === 'string' ? { ruleVersion: item.ruleVersion } : {}),
      ...(typeof item.evidenceFingerprint === 'string' ? { evidenceFingerprint: item.evidenceFingerprint } : {}),
    })
  }
  return { ok: true, file: { dependencyVersion: WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION, skillId: raw.skillId, dependencies } }
}

// ---------------------------------------------------------------------------
// 阻断（闭集 · 具名 · 可审计）
// ---------------------------------------------------------------------------

/**
 * 依赖阻断码（闭集）。
 *
 * ⚠️ 它**不**重新定义"规则为什么失效"：规则侧原因仍在 `RuleInvalidationReason`（P1/P2 闭集），
 *    这里只回答"**技能的依赖**在哪一步被挡、属于哪一类"。
 */
export const WORKFLOW_SKILL_RULE_DEPENDENCY_BLOCK_CODES = [
  'declaration_invalid',              // 旁挂声明形状不合法（解析阶段就拒）
  'rule_unknown',                     // 资格读面里没有这条命题
  'rule_not_usable',                  // 当前状态不可用（pending / suspended / retired / withdrawn / superseded …）
  'rule_scope_mismatch',              // 主体/范围/环境/条件对不上（错绑）
  'rule_version_conflict',            // 声明钉了版本/证据指纹，但当前已经不是那一版
  'rule_invalidated_after_load',      // 加载后、动作前失效（**后续依赖动作必须停下**）
  'rule_snapshot_unreadable',         // 读面失败（失败关闭，不当"可用"）
] as const
export type WorkflowSkillRuleDependencyBlockCode = (typeof WORKFLOW_SKILL_RULE_DEPENDENCY_BLOCK_CODES)[number]

/** 两个阶段的读法必须分开：加载时"能不能消费"，动作前"还是不是那一版"。 */
export const WORKFLOW_SKILL_RULE_DEPENDENCY_PHASES = ['load', 'before_action'] as const
export type WorkflowSkillRuleDependencyPhase = (typeof WORKFLOW_SKILL_RULE_DEPENDENCY_PHASES)[number]

/**
 * 一条**阻断记录**（调用方放进动作失败详情/账本；本文件不持久化）。
 *
 * ⚠️ 只放闭集码 / 引用 / 状态字符串 / 计数 —— **不放规则正文、不放用户原文**。
 */
export interface WorkflowSkillRuleDependencyBlock {
  readonly dependencyVersion: string
  readonly phase: WorkflowSkillRuleDependencyPhase
  readonly code: WorkflowSkillRuleDependencyBlockCode
  readonly claimId?: string
  /** 规则侧当前状态（EBL 的字符串，**引用**；不是本文件定义的状态） */
  readonly ruleStatus?: string
  /** 规则侧失效原因（P1/P2 闭集值；只在可映射时给出） */
  readonly ruleReason?: RuleInvalidationReason
  readonly detail: string
}

export type WorkflowSkillRuleDependencyVerdict =
  | { readonly ok: true; readonly baselines: readonly PlanRuleDependency[] }
  | { readonly ok: false; readonly block: WorkflowSkillRuleDependencyBlock }

function blockOf(
  phase: WorkflowSkillRuleDependencyPhase,
  code: WorkflowSkillRuleDependencyBlockCode,
  detail: string,
  extra: { claimId?: string; ruleStatus?: string; ruleReason?: RuleInvalidationReason } = {}
): WorkflowSkillRuleDependencyBlock {
  return {
    dependencyVersion: WORKFLOW_SKILL_RULE_DEPENDENCY_VERSION,
    phase,
    code,
    ...(extra.claimId !== undefined ? { claimId: extra.claimId } : {}),
    ...(extra.ruleStatus !== undefined ? { ruleStatus: extra.ruleStatus } : {}),
    ...(extra.ruleReason !== undefined ? { ruleReason: extra.ruleReason } : {}),
    detail,
  }
}

/** 规则侧原因是否是闭集值（读面可能给出旧的/未知字符串 ⇒ 不猜，丢掉） */
function knownRuleReason(value: string | undefined): RuleInvalidationReason | undefined {
  return value !== undefined && (RULE_INVALIDATION_REASONS as readonly string[]).includes(value)
    ? (value as RuleInvalidationReason)
    : undefined
}

// ---------------------------------------------------------------------------
// ① 加载时：声明的规则必须**当前合格且适用于这个技能**
// ---------------------------------------------------------------------------

/**
 * 加载时判定。
 *
 * 顺序刻意与 P1/P2 一致：**先**看读面有没有这条命题（`rule_unknown`），
 * **再**用 P2 的可见性判据（`selectUsableRules`）判"能不能在这里消费"，
 * **最后**核对声明钉住的版本/指纹（`rule_version_conflict`）。
 * ⇒ 一个失败只报**一个**最具体的原因（先到先得），不堆一堆。
 */
export function decideSkillRuleDependenciesAtLoad(input: {
  readonly declarations: readonly WorkflowSkillRuleDependencyDeclaration[]
  /** 资格读面的**当前**快照（由适配器从真实 EBL 只读读面取；本文件不认识 EBL） */
  readonly snapshots: readonly UsableRuleSnapshot[]
  /** 消费方口径（主体 / 范围 / 环境 / 已知条件） */
  readonly visible: VisibleRuleContext
  /** 读面是否读失败（**失败关闭**：读不到不代表"没有依赖"） */
  readonly snapshotUnreadable?: boolean
}): WorkflowSkillRuleDependencyVerdict {
  if (input.snapshotUnreadable === true) {
    return {
      ok: false,
      block: blockOf('load', 'rule_snapshot_unreadable', '资格读面读取失败：依赖资格无法核验（失败关闭）'),
    }
  }
  const baselines: PlanRuleDependency[] = []
  for (const declaration of input.declarations) {
    const snapshot = input.snapshots.find((candidate) => candidate.claimId === declaration.claimId)
    if (snapshot === undefined) {
      return {
        ok: false,
        block: blockOf('load', 'rule_unknown', `技能依赖的命题 ${declaration.claimId} 不在当前资格读面里`, {
          claimId: declaration.claimId,
        }),
      }
    }
    const selection = selectUsableRules({ snapshots: [snapshot], visible: input.visible })
    if (selection.skipped.length > 0) {
      const skip = selection.skipped[0]!
      if (skip.reason === 'not_usable') {
        return {
          ok: false,
          block: blockOf('load', 'rule_not_usable', skip.detail, {
            claimId: declaration.claimId,
            ruleStatus: snapshot.status,
            ...(knownRuleReason(snapshot.invalidatedReason) !== undefined
              ? { ruleReason: knownRuleReason(snapshot.invalidatedReason)! }
              : {}),
          }),
        }
      }
      return {
        ok: false,
        block: blockOf('load', 'rule_scope_mismatch', skip.detail, {
          claimId: declaration.claimId,
          ruleStatus: snapshot.status,
        }),
      }
    }
    if (
      (declaration.ruleVersion !== undefined && declaration.ruleVersion !== snapshot.ruleVersion) ||
      (declaration.evidenceFingerprint !== undefined && declaration.evidenceFingerprint !== snapshot.evidenceFingerprint)
    ) {
      return {
        ok: false,
        block: blockOf(
          'load',
          'rule_version_conflict',
          `技能声明钉住的是 rule ${declaration.ruleVersion ?? '(任意)'} / 证据指纹 ${(declaration.evidenceFingerprint ?? '(任意)').slice(0, 12)}，` +
            `当前是 rule ${snapshot.ruleVersion} / 证据指纹 ${snapshot.evidenceFingerprint.slice(0, 12)}`,
          { claimId: declaration.claimId, ruleStatus: snapshot.status }
        ),
      }
    }
    baselines.push({
      claimId: snapshot.claimId,
      ruleVersion: snapshot.ruleVersion,
      evidenceFingerprint: snapshot.evidenceFingerprint,
    })
  }
  return { ok: true, baselines }
}

// ---------------------------------------------------------------------------
// ② 动作之前：加载时拿到的基线**必须仍然成立**
// ---------------------------------------------------------------------------

/**
 * 动作前判定（"加载之后、动作之前规则失效"这条要求落在这里）。
 *
 * ⚠️ 它**不**重新实现复核：直接调 P2 的 `verifyPlanRulesStillUsable`（同一条判据）。
 *    ⇒ P3 没有第二套资格系统；这里只把结论映射成**技能依赖**的闭集阻断码。
 * ⚠️ 一条依赖失效 ⇒ **整个依赖动作停下**（不"挑还能用的那条"）——
 *    依赖动作本来就是建立在"这些规则都还成立"之上的。
 */
export async function decideSkillRuleDependenciesBeforeAction(input: {
  readonly baselines: readonly PlanRuleDependency[]
  readonly snapshot: RuleSnapshotPort
}): Promise<WorkflowSkillRuleDependencyVerdict> {
  if (input.baselines.length === 0) return { ok: true, baselines: [] }
  /*
   * ⚠️ "读面**抛错**"与"规则**判为**不可用"必须是两个码：
   *      · 抛错 ⇒ `rule_snapshot_unreadable`（**没读到**，不是"失效了"）
   *      · 判为不可用 ⇒ 下面按 P2 的原因映射
   *    否则审计里会出现一次**没有发生过的失效**。
   */
  const outcome = await verifyPlanRulesStillUsable({
    dependencies: input.baselines,
    snapshot: input.snapshot,
  }).then(
    (value) => ({ kind: 'verdict' as const, value }),
    (error: unknown) => ({ kind: 'unreadable' as const, error }),
  )
  if (outcome.kind === 'unreadable') {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    return {
      ok: false,
      block: blockOf('before_action', 'rule_snapshot_unreadable', `资格读面读取失败：依赖资格无法核验（失败关闭）：${message}`),
    }
  }
  const verdict = outcome.value
  if (verdict.ok) return { ok: true, baselines: input.baselines }
  /*
   * 把 P2 的原因映射成技能侧闭集：
   *   · `version_conflict` ⇒ 版本/证据指纹变了
   *   · 其余（`not_usable` / `source_withdrawn`）⇒ 加载后失效
   * ⚠️ 具体是哪条依赖失败要能看出来：`verifyPlanRulesStillUsable` 的 detail 里带 claim id，
   *    这里再补一次"哪条基线"由调用方按 detail 记录；本函数只保证码是闭集。
   */
  const code: WorkflowSkillRuleDependencyBlockCode = verdict.reason === 'version_conflict'
    ? 'rule_version_conflict'
    : 'rule_invalidated_after_load'
  return {
    ok: false,
    block: blockOf('before_action', code, verdict.detail, {
      ...(knownRuleReason(verdict.reason) !== undefined ? { ruleReason: knownRuleReason(verdict.reason)! } : {}),
    }),
  }
}
