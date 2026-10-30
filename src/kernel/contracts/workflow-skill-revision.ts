/**
 * P3-3 —— **候选修订 / 验证包 / 发布裁定契约**（kernel 侧，纯函数）。
 *
 * ============================================================================
 *  它冻结的是什么
 * ============================================================================
 * ```text
 * ① 修订候选：谁、因为什么缺陷/新要求、相对哪个父版本、改动什么、用哪个开发集/留出集
 * ② 冻结验证集：开发集与**留出集**（两份不同的 setId + 各自 specDigest）
 * ③ 验证包：开发回归结果 + 留出结果 + 产者标识 + 冻结集摘要 + 包摘要（可校验完整性）
 * ④ 发布裁定：形状 → 父版本/版本号/身份 → 能力与边界（只允许**不扩大**）→
 *    验证完整性（伪造/篡改/调参留出 ⇒ 拒绝）→ 开发回归 → 留出 → 状态与重发
 * ⑤ 回退与退役：目标必须 published；**不允许直接把当前版本退役**
 * ```
 *
 * ---------------------------------------------------------------------------
 *  计划 §4（P3-3）的每一条在这里都有机器落点
 * ---------------------------------------------------------------------------
 * · 「用一个预先登记的缺陷或新要求触发修订候选」⇒ `triggerDefectRef` 必填且闭集格式。
 * · 「候选依次经过形状/权限/依赖校验、开发回归、冻结留出验证」⇒ 判定顺序即函数顺序。
 * · 「模型自评或单次成功都不足以发布」⇒ 验证包必须来自 `p3-revision-harness`（唯一产者），
 *   且同时含开发与留出两段结果；缺一段 ⇒ `revision_verification_missing`。
 * · 「破坏旧任务的修订 / 扩权限的修订 / 伪造验证记录 / 重复发布」⇒ 各自独立拒绝码。
 * · 「留出失败即结束该候选批次；不得对同一留出材料反复调到通过」⇒ 失败留出集的
 *   `setId` 与**任务签名**（`computeVerificationTasksDigest`）进入 `failedHoldoutSignatures`，
 *   再次引用同一 setId **或同一份任务材料**的候选 ⇒ `revision_holdout_reuse`
 *   （只比 setId 会被"改名重提"绕过，2026-10-28 独立复核构造过）。
 * · 「旧版本保留、当前版本切换可回读；不在生产直接替换」⇒ 发布 = 状态转移 + 切当前版本，
 *   两者都是**存储层原子操作**；本模块只管判定，不执行任何 I/O。
 *
 * ⚠️ 本模块**不能**证明验证包真的在冻结材料上跑过：它能证明的是"包没有被改过、
 *    产者是唯一 harness、引用的冻结集摘要与预注册一致、结果内部自洽"。
 *    "harness 真的跑了"由流水线（gate/CI）负责，并且必须在记录里如实写成边界。
 */

import { createHash } from 'node:crypto'

import {
  canonicalJson,
  computeWorkflowSkillReleaseDigest,
  type WorkflowSkillCatalogSkill,
  type WorkflowSkillPublishedState,
  type WorkflowSkillRelease,
} from './workflow-skill-catalog.ts'

export const WORKFLOW_SKILL_REVISION_REGISTRY_VERSION = 'workflow-skill-revisions@1' as const
export const WORKFLOW_SKILL_VERIFICATION_SET_VERSION = 'workflow-skill-verification-set@1' as const
export const WORKFLOW_SKILL_VERIFICATION_BUNDLE_VERSION = 'workflow-skill-verification-bundle@1' as const

/** 唯一被承认的验证包产者（模型 / 候选技能 / 发布器都**不能**冒充它）。 */
export const P3_REVISION_HARNESS_PRODUCER = 'p3-revision-harness@1' as const

/** 候选提议人（闭集）。`model-proposal` 只能"提议"，永远不能"发布"。 */
export const WORKFLOW_SKILL_PROPOSERS = ['controlled-candidate', 'operator', 'model-proposal'] as const
export type WorkflowSkillProposer = (typeof WORKFLOW_SKILL_PROPOSERS)[number]

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------------------
// 修订候选
// ---------------------------------------------------------------------------

export interface WorkflowSkillRevisionProposal {
  readonly skillId: string
  /** 候选版本号（必须 = 父版本 + 1） */
  readonly version: number
  readonly parentVersion: number
  /** 预先登记的缺陷或新要求引用（闭集格式：`P3-R-<id>`） */
  readonly triggerDefectRef: string
  /** 拟修复的问题（人读；不是模型指令） */
  readonly proposedFix: string
  readonly changeSummary: string
  readonly proposedBy: WorkflowSkillProposer
  /** 开发集 id（与留出集**必须不同**） */
  readonly devSetId: string
  /** 冻结留出集 id */
  readonly holdoutSetId: string
  readonly proposalDigest: string
}

export type WorkflowSkillRevisionProposalIdentity = Omit<WorkflowSkillRevisionProposal, 'proposalDigest'>

export function computeRevisionProposalDigest(identity: WorkflowSkillRevisionProposalIdentity): string {
  return sha256Hex(
    `${WORKFLOW_SKILL_REVISION_REGISTRY_VERSION}\n${canonicalJson({
      skillId: identity.skillId,
      version: identity.version,
      parentVersion: identity.parentVersion,
      triggerDefectRef: identity.triggerDefectRef,
      proposedFix: identity.proposedFix,
      changeSummary: identity.changeSummary,
      proposedBy: identity.proposedBy,
      devSetId: identity.devSetId,
      holdoutSetId: identity.holdoutSetId,
    })}`
  )
}

export interface WorkflowSkillRevisionRegistry {
  readonly revisionRegistryVersion: typeof WORKFLOW_SKILL_REVISION_REGISTRY_VERSION
  readonly proposals: readonly WorkflowSkillRevisionProposal[]
}

export type WorkflowSkillRevisionRegistryCode =
  | 'registry_not_object'
  | 'registry_unknown_field'
  | 'registry_version_mismatch'
  | 'proposal_not_object'
  | 'proposal_unknown_field'
  | 'proposal_id_invalid'
  | 'proposal_duplicate'
  | 'proposal_trigger_invalid'
  | 'proposal_text_invalid'
  | 'proposal_by_invalid'
  | 'proposal_sets_invalid'
  | 'proposal_version_invalid'
  | 'proposal_digest_mismatch'

export type WorkflowSkillRevisionRegistryResult =
  | { readonly ok: true; readonly registry: WorkflowSkillRevisionRegistry }
  | { readonly ok: false; readonly code: WorkflowSkillRevisionRegistryCode; readonly detail: string }

const REGISTRY_FIELDS = new Set(['revisionRegistryVersion', 'proposals'])
const PROPOSAL_FIELDS = new Set([
  'skillId', 'version', 'parentVersion', 'triggerDefectRef', 'proposedFix', 'changeSummary',
  'proposedBy', 'devSetId', 'holdoutSetId', 'proposalDigest',
])
const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/
const TRIGGER_PATTERN = /^P3-R-[A-Z0-9-]{1,32}$/
/* 验证集/任务 id：小写字母数字开头，允许 `@` `.` `-`（例如 `p3-3-dev-personal-library@1`） */
const SET_ID_PATTERN = /^[a-z0-9][a-z0-9@.-]{2,63}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key))
}

function nonEmpty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

export function parseRevisionRegistry(raw: unknown): WorkflowSkillRevisionRegistryResult {
  const fail = (code: WorkflowSkillRevisionRegistryCode, detail: string): WorkflowSkillRevisionRegistryResult =>
    ({ ok: false, code, detail })
  if (!isPlainObject(raw)) return fail('registry_not_object', '修订登记必须是对象')
  const extra = unknownFields(raw, REGISTRY_FIELDS)
  if (extra !== undefined) return fail('registry_unknown_field', `修订登记含未知字段 ${extra}`)
  if (raw.revisionRegistryVersion !== WORKFLOW_SKILL_REVISION_REGISTRY_VERSION) {
    return fail('registry_version_mismatch', `revisionRegistryVersion 必须是 ${WORKFLOW_SKILL_REVISION_REGISTRY_VERSION}`)
  }
  if (!Array.isArray(raw.proposals) || raw.proposals.length === 0) {
    return fail('proposal_not_object', 'proposals 必须是非空数组')
  }
  const proposals: WorkflowSkillRevisionProposal[] = []
  for (const item of raw.proposals) {
    if (!isPlainObject(item)) return fail('proposal_not_object', '候选条目必须是对象')
    const itemExtra = unknownFields(item, PROPOSAL_FIELDS)
    if (itemExtra !== undefined) return fail('proposal_unknown_field', `候选条目含未知字段 ${itemExtra}`)
    if (typeof item.skillId !== 'string' || !SKILL_ID_PATTERN.test(item.skillId)) {
      return fail('proposal_id_invalid', `skillId 不合法：${String(item.skillId)}`)
    }
    if (typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 2) {
      return fail('proposal_version_invalid', `候选 version 必须是 ≥2 的整数：${String(item.version)}`)
    }
    /*
     * ⚠️ 候选版本**不要求** = 父版本 + 1（2026-10-28 复核发现的结构张力）：
     *    "每候选只接受一份验证包 + 版本链连续不可覆盖" ⇒ 若强制 +1，
     *    一个被拒的候选会**永久占住**那个版本号，"换新材料重试"就永远不可达。
     *    因此只要求 `parentVersion < version`（版本号单调递增），重试可以起新版本。
     */
    if (typeof item.parentVersion !== 'number' || !Number.isSafeInteger(item.parentVersion) ||
        item.parentVersion < 1 || item.parentVersion >= item.version) {
      return fail('proposal_version_invalid', 'parentVersion 必须是 ≥1 且 < version 的整数')
    }
    if (typeof item.triggerDefectRef !== 'string' || !TRIGGER_PATTERN.test(item.triggerDefectRef)) {
      return fail('proposal_trigger_invalid', `triggerDefectRef 必须是 P3-R-<id>：${String(item.triggerDefectRef)}`)
    }
    if (!nonEmpty(item.proposedFix, 600) || !nonEmpty(item.changeSummary, 600)) {
      return fail('proposal_text_invalid', 'proposedFix / changeSummary 必须是非空文本（≤600）')
    }
    if (typeof item.proposedBy !== 'string' ||
        !(WORKFLOW_SKILL_PROPOSERS as readonly string[]).includes(item.proposedBy)) {
      return fail('proposal_by_invalid', `proposedBy 必须是 ${WORKFLOW_SKILL_PROPOSERS.join(' | ')}`)
    }
    if (typeof item.devSetId !== 'string' || !SET_ID_PATTERN.test(item.devSetId) ||
        typeof item.holdoutSetId !== 'string' || !SET_ID_PATTERN.test(item.holdoutSetId) ||
        item.devSetId === item.holdoutSetId) {
      return fail('proposal_sets_invalid', 'devSetId / holdoutSetId 必须合法且**不相同**')
    }
    const identity: WorkflowSkillRevisionProposalIdentity = {
      skillId: item.skillId,
      version: item.version,
      parentVersion: item.parentVersion,
      triggerDefectRef: item.triggerDefectRef,
      proposedFix: item.proposedFix,
      changeSummary: item.changeSummary,
      proposedBy: item.proposedBy as WorkflowSkillProposer,
      devSetId: item.devSetId,
      holdoutSetId: item.holdoutSetId,
    }
    const digest = computeRevisionProposalDigest(identity)
    if (item.proposalDigest !== digest) {
      return fail('proposal_digest_mismatch', `${item.skillId}@${String(item.version)} 的 proposalDigest 与身份不一致`)
    }
    const key = `${identity.skillId}@${String(identity.version)}`
    if (proposals.some((proposal) => `${proposal.skillId}@${String(proposal.version)}` === key)) {
      return fail('proposal_duplicate', `重复的候选：${key}`)
    }
    proposals.push({ ...identity, proposalDigest: digest })
  }
  proposals.sort((a, b) => (a.skillId === b.skillId ? a.version - b.version : a.skillId < b.skillId ? -1 : 1))
  return {
    ok: true,
    registry: { revisionRegistryVersion: WORKFLOW_SKILL_REVISION_REGISTRY_VERSION, proposals },
  }
}

/** 按 (skillId, version) 找候选提议。 */
export function findRevisionProposal(
  registry: WorkflowSkillRevisionRegistry,
  skillId: string,
  version: number
): WorkflowSkillRevisionProposal | undefined {
  return registry.proposals.find((proposal) => proposal.skillId === skillId && proposal.version === version)
}

// ---------------------------------------------------------------------------
// 冻结验证集
// ---------------------------------------------------------------------------

/**
 * 一条**任务**的冻结规格（开发集与留出集共用这一形状，材料/标记各自独立）。
 *
 * ⚠️ 这里只有"任务要求什么"，没有"应该怎么回答"：判分靠 `verifyPersonalLibraryAnswer`
 *    （来源真实/缺失如实）与指令清单（机械元素），**不**靠模型措辞。
 */
export interface WorkflowSkillVerificationTask {
  readonly taskId: string
  readonly query: string
  /** 任务要求读到才能回答的来源（相对资料根） */
  readonly requiredSourcePaths: readonly string[]
  readonly allowedFactMarkers: readonly string[]
  readonly absentFactMarkers: readonly string[]
  readonly expectsInsufficientEvidence: boolean
  readonly insufficientEvidencePhrases: readonly string[]
}

export interface WorkflowSkillVerificationSet {
  readonly verificationSetVersion: typeof WORKFLOW_SKILL_VERIFICATION_SET_VERSION
  readonly setId: string
  readonly kind: 'development' | 'holdout'
  readonly skillId: string
  readonly requiredInstructionElements: readonly string[]
  readonly forbiddenInstructionElements: readonly string[]
  readonly tasks: readonly WorkflowSkillVerificationTask[]
  readonly specDigest: string
}

export type WorkflowSkillVerificationSetIdentity = Omit<WorkflowSkillVerificationSet, 'specDigest'>

export function computeVerificationSetDigest(identity: WorkflowSkillVerificationSetIdentity): string {
  return sha256Hex(
    `${WORKFLOW_SKILL_VERIFICATION_SET_VERSION}\n${canonicalJson({
      setId: identity.setId,
      kind: identity.kind,
      skillId: identity.skillId,
      requiredInstructionElements: [...identity.requiredInstructionElements],
      forbiddenInstructionElements: [...identity.forbiddenInstructionElements],
      tasks: identity.tasks.map((task) => ({
        taskId: task.taskId,
        query: task.query,
        requiredSourcePaths: [...task.requiredSourcePaths],
        allowedFactMarkers: [...task.allowedFactMarkers],
        absentFactMarkers: [...task.absentFactMarkers],
        expectsInsufficientEvidence: task.expectsInsufficientEvidence,
        insufficientEvidencePhrases: [...task.insufficientEvidencePhrases],
      })),
    })}`
  )
}

/**
 * **留出任务签名**：只覆盖"题面材料"（query / 必读源 / 标记 / 缺证期望），
 * **不含** `setId` 与 `taskId`。
 *
 * ⚠️ 为什么需要它（2026-10-28 独立复核构造出这条绕过后补）：`specDigest` 含 `setId`，
 *    所以"把同一批留出任务原样复制到一个新 setId 下再提交"能绕过"同一 setId 已失败"
 *    的判据。任务签名把判据绑到**真正需要保密的那部分材料**上：换名字不算换材料。
 *    它不是加密承诺 —— 留出集仍在仓库里，签名只保证"改名不放过"。
 */
export function computeVerificationTasksDigest(tasks: readonly WorkflowSkillVerificationTask[]): string {
  return sha256Hex(
    `${WORKFLOW_SKILL_VERIFICATION_SET_VERSION}\n${canonicalJson(tasks.map((task) => ({
      query: task.query,
      requiredSourcePaths: [...task.requiredSourcePaths],
      allowedFactMarkers: [...task.allowedFactMarkers],
      absentFactMarkers: [...task.absentFactMarkers],
      expectsInsufficientEvidence: task.expectsInsufficientEvidence,
      insufficientEvidencePhrases: [...task.insufficientEvidencePhrases],
    })))}`
  )
}

export type VerificationSetCode =
  | 'set_not_object'
  | 'set_unknown_field'
  | 'set_version_mismatch'
  | 'set_id_invalid'
  | 'set_kind_invalid'
  | 'set_skill_invalid'
  | 'set_elements_invalid'
  | 'set_tasks_invalid'
  | 'set_digest_mismatch'

export type VerificationSetResult =
  | { readonly ok: true; readonly set: WorkflowSkillVerificationSet }
  | { readonly ok: false; readonly code: VerificationSetCode; readonly detail: string }

const SET_FIELDS = new Set([
  'verificationSetVersion', 'setId', 'kind', 'skillId', 'requiredInstructionElements',
  'forbiddenInstructionElements', 'tasks', 'specDigest',
])
const TASK_FIELDS = new Set([
  'taskId', 'query', 'requiredSourcePaths', 'allowedFactMarkers', 'absentFactMarkers',
  'expectsInsufficientEvidence', 'insufficientEvidencePhrases',
])

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxLength) return undefined
    if (!out.includes(item)) out.push(item)
  }
  return out
}

export function parseVerificationSet(raw: unknown): VerificationSetResult {
  const fail = (code: VerificationSetCode, detail: string): VerificationSetResult => ({ ok: false, code, detail })
  if (!isPlainObject(raw)) return fail('set_not_object', '验证集必须是对象')
  const extra = unknownFields(raw, SET_FIELDS)
  if (extra !== undefined) return fail('set_unknown_field', `验证集含未知字段 ${extra}`)
  if (raw.verificationSetVersion !== WORKFLOW_SKILL_VERIFICATION_SET_VERSION) {
    return fail('set_version_mismatch', `verificationSetVersion 必须是 ${WORKFLOW_SKILL_VERIFICATION_SET_VERSION}`)
  }
  if (typeof raw.setId !== 'string' || !SET_ID_PATTERN.test(raw.setId)) {
    return fail('set_id_invalid', `setId 不合法：${String(raw.setId)}`)
  }
  if (raw.kind !== 'development' && raw.kind !== 'holdout') {
    return fail('set_kind_invalid', 'kind 只能是 development 或 holdout')
  }
  if (typeof raw.skillId !== 'string' || !SKILL_ID_PATTERN.test(raw.skillId)) {
    return fail('set_skill_invalid', `skillId 不合法：${String(raw.skillId)}`)
  }
  const required = stringArray(raw.requiredInstructionElements, 24, 120)
  const forbidden = stringArray(raw.forbiddenInstructionElements, 24, 120)
  if (required === undefined || required.length === 0 || forbidden === undefined) {
    return fail('set_elements_invalid', 'requiredInstructionElements 非空 / forbiddenInstructionElements 合法')
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0 || raw.tasks.length > 32) {
    return fail('set_tasks_invalid', 'tasks 必须是 1..32 条')
  }
  const tasks: WorkflowSkillVerificationTask[] = []
  for (const item of raw.tasks) {
    if (!isPlainObject(item)) return fail('set_tasks_invalid', '任务必须是对象')
    const taskExtra = unknownFields(item, TASK_FIELDS)
    if (taskExtra !== undefined) return fail('set_tasks_invalid', `任务含未知字段 ${taskExtra}`)
    const taskId = item.taskId
    if (typeof taskId !== 'string' || !SET_ID_PATTERN.test(taskId)) {
      return fail('set_tasks_invalid', `taskId 不合法：${String(taskId)}`)
    }
    if (tasks.some((task) => task.taskId === taskId)) return fail('set_tasks_invalid', `重复 taskId ${taskId}`)
    const query = item.query
    if (typeof query !== 'string' || query.length > 200) return fail('set_tasks_invalid', `query 不合法：${taskId}`)
    const requiredSourcePaths = stringArray(item.requiredSourcePaths, 16, 240)
    const allowedFactMarkers = stringArray(item.allowedFactMarkers, 16, 64)
    const absentFactMarkers = stringArray(item.absentFactMarkers, 16, 64)
    const phrases = stringArray(item.insufficientEvidencePhrases, 8, 40)
    if (requiredSourcePaths === undefined || requiredSourcePaths.length === 0 ||
        allowedFactMarkers === undefined || absentFactMarkers === undefined || phrases === undefined) {
      return fail('set_tasks_invalid', `任务字段不合法：${taskId}`)
    }
    if (typeof item.expectsInsufficientEvidence !== 'boolean') {
      return fail('set_tasks_invalid', `expectsInsufficientEvidence 必须是布尔：${taskId}`)
    }
    tasks.push({
      taskId,
      query,
      requiredSourcePaths,
      allowedFactMarkers,
      absentFactMarkers,
      expectsInsufficientEvidence: item.expectsInsufficientEvidence,
      insufficientEvidencePhrases: phrases,
    })
  }
  const identity: WorkflowSkillVerificationSetIdentity = {
    verificationSetVersion: WORKFLOW_SKILL_VERIFICATION_SET_VERSION,
    setId: raw.setId,
    kind: raw.kind,
    skillId: raw.skillId,
    requiredInstructionElements: required,
    forbiddenInstructionElements: forbidden,
    tasks,
  }
  const digest = computeVerificationSetDigest(identity)
  if (raw.specDigest !== digest) {
    return fail('set_digest_mismatch', `${raw.setId} 的 specDigest 与内容不一致`)
  }
  return { ok: true, set: { ...identity, specDigest: digest } }
}

/** 开发集与留出集必须**不同**（不同 setId / 不同摘要 / 不同任务集合）——调参留出是伪造。 */
export function assertSetsAreDisjoint(
  dev: WorkflowSkillVerificationSet,
  holdout: WorkflowSkillVerificationSet
): { ok: true } | { ok: false; detail: string } {
  if (dev.setId === holdout.setId) return { ok: false, detail: '开发集与留出集 setId 相同' }
  if (dev.specDigest === holdout.specDigest) return { ok: false, detail: '开发集与留出集摘要相同' }
  const overlap = dev.tasks.filter((task) => holdout.tasks.some((other) => other.taskId === task.taskId))
  if (overlap.length > 0) return { ok: false, detail: `开发集与留出集共享任务：${overlap.map((task) => task.taskId).join(',')}` }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 验证包
// ---------------------------------------------------------------------------

export interface WorkflowSkillVerificationSetResult {
  readonly setId: string
  readonly specDigest: string
  readonly verdict: 'pass' | 'fail'
  readonly checks: number
  readonly failures: number
  /** 逐条结果的**报告摘要**（harness 产出；本模块只校验它被包摘要覆盖） */
  readonly reportDigest: string
}

export interface WorkflowSkillVerificationBundle {
  readonly bundleVersion: typeof WORKFLOW_SKILL_VERIFICATION_BUNDLE_VERSION
  readonly skillId: string
  readonly version: number
  readonly parentVersion: number
  readonly dev: WorkflowSkillVerificationSetResult
  readonly holdout: WorkflowSkillVerificationSetResult
  readonly producer: string
  readonly bundleDigest: string
}

export type WorkflowSkillVerificationBundleIdentity = Omit<WorkflowSkillVerificationBundle, 'bundleDigest'>

export function computeVerificationBundleDigest(identity: WorkflowSkillVerificationBundleIdentity): string {
  return sha256Hex(
    `${WORKFLOW_SKILL_VERIFICATION_BUNDLE_VERSION}\n${canonicalJson({
      skillId: identity.skillId,
      version: identity.version,
      parentVersion: identity.parentVersion,
      dev: {
        setId: identity.dev.setId, specDigest: identity.dev.specDigest, verdict: identity.dev.verdict,
        checks: identity.dev.checks, failures: identity.dev.failures, reportDigest: identity.dev.reportDigest,
      },
      holdout: {
        setId: identity.holdout.setId, specDigest: identity.holdout.specDigest, verdict: identity.holdout.verdict,
        checks: identity.holdout.checks, failures: identity.holdout.failures, reportDigest: identity.holdout.reportDigest,
      },
      producer: identity.producer,
    })}`
  )
}

export const VERIFICATION_REPORT_DIGEST_PATTERN = /^[0-9a-f]{64}$/

export interface VerificationBundleIntegrityExpectation {
  readonly dev: WorkflowSkillVerificationSet
  readonly holdout: WorkflowSkillVerificationSet
  readonly skillId: string
  readonly version: number
  readonly parentVersion: number
}

export type VerificationBundleIntegrityCode =
  | 'revision_verification_missing'
  | 'revision_verification_forged'

export type VerificationBundleIntegrityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: VerificationBundleIntegrityCode; readonly detail: string }

/**
 * 验证包完整性（**不重跑**，只校验可校验的东西）。
 *
 * 拒绝的形状（每种都是"伪造/篡改/调参留出"的一种具体形态）：
 * ```
 * ① 包不存在 / 版本字段缺失                 ⇒ revision_verification_missing
 * ② bundleDigest 与重算不一致（记录被改过）  ⇒ revision_verification_forged
 * ③ producer 不是唯一 harness                ⇒ revision_verification_forged
 * ④ 开发/留出 specDigest 与预注册冻结摘要不符（跑了别的材料）⇒ revision_verification_forged
 * ⑤ setId 与候选提议声明的 dev/holdout 不一致 ⇒ revision_verification_forged
 * ⑥ 结果内部不自洽（pass 却有 failures / fail 却零 failures / checks=0）⇒ revision_verification_forged
 * ⑦ 包的 skillId/version/parentVersion 与候选不符 ⇒ revision_verification_forged
 * ```
 */
export function verifyBundleIntegrity(
  bundle: WorkflowSkillVerificationBundle | undefined,
  expected: VerificationBundleIntegrityExpectation,
  declared: { readonly devSetId: string; readonly holdoutSetId: string }
): VerificationBundleIntegrityResult {
  const forged = (detail: string): VerificationBundleIntegrityResult =>
    ({ ok: false, code: 'revision_verification_forged', detail })
  if (bundle === undefined) {
    return { ok: false, code: 'revision_verification_missing', detail: '候选没有验证包（开发回归 + 冻结留出都未提供）' }
  }
  if (bundle.bundleVersion !== WORKFLOW_SKILL_VERIFICATION_BUNDLE_VERSION) {
    return forged(`bundleVersion 不是 ${WORKFLOW_SKILL_VERIFICATION_BUNDLE_VERSION}`)
  }
  const recomputed = computeVerificationBundleDigest({
    bundleVersion: bundle.bundleVersion,
    skillId: bundle.skillId,
    version: bundle.version,
    parentVersion: bundle.parentVersion,
    dev: { ...bundle.dev },
    holdout: { ...bundle.holdout },
    producer: bundle.producer,
  })
  if (bundle.bundleDigest !== recomputed) return forged('bundleDigest 与内容不一致（验证包被改过）')
  if (bundle.producer !== P3_REVISION_HARNESS_PRODUCER) {
    return forged(`producer 必须是 ${P3_REVISION_HARNESS_PRODUCER}（收到 ${bundle.producer}）`)
  }
  if (bundle.skillId !== expected.skillId || bundle.version !== expected.version ||
      bundle.parentVersion !== expected.parentVersion) {
    return forged('验证包的 skillId/version/parentVersion 与候选不符')
  }
  if (bundle.dev.setId !== declared.devSetId || bundle.holdout.setId !== declared.holdoutSetId) {
    return forged('验证包引用的 setId 与候选提议声明不一致')
  }
  if (bundle.dev.specDigest !== expected.dev.specDigest || bundle.holdout.specDigest !== expected.holdout.specDigest) {
    return forged('验证包引用的 specDigest 与预注册冻结摘要不一致（在别的材料上验证）')
  }
  for (const [label, result] of [['dev', bundle.dev], ['holdout', bundle.holdout]] as const) {
    if (!VERIFICATION_REPORT_DIGEST_PATTERN.test(result.reportDigest)) return forged(`${label} 的 reportDigest 不是 64 位 hex`)
    if (!Number.isSafeInteger(result.checks) || result.checks <= 0) return forged(`${label} 的 checks 必须为正整数`)
    if (!Number.isSafeInteger(result.failures) || result.failures < 0) return forged(`${label} 的 failures 必须为非负整数`)
    if (result.verdict === 'pass' && result.failures !== 0) return forged(`${label} 声称 pass 却有 ${String(result.failures)} 条失败`)
    if (result.verdict === 'fail' && (result.failures === 0 || result.failures > result.checks)) {
      return forged(`${label} 声称 fail 但 failures=${String(result.failures)} / checks=${String(result.checks)} 不自洽`)
    }
    if (result.failures > result.checks) return forged(`${label} 的 failures 超过 checks`)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 指令清单（机械回归/留出的一部分）
// ---------------------------------------------------------------------------

export interface InstructionChecklistResult {
  readonly missing: readonly string[]
  readonly forbiddenFound: readonly string[]
  readonly ok: boolean
}

/** 机械检查：说明里必须出现哪些元素、不得出现哪些元素（都按**原文子串**，不做语义判断）。 */
export function evaluateInstructionChecklist(
  instructions: string,
  required: readonly string[],
  forbidden: readonly string[]
): InstructionChecklistResult {
  const missing = required.filter((element) => !instructions.includes(element))
  const forbiddenFound = forbidden.filter((element) => instructions.includes(element))
  return { missing, forbiddenFound, ok: missing.length === 0 && forbiddenFound.length === 0 }
}

/**
 * **声明边界 vs 说明文本**的冲突检测（P3-3 预登记缺陷 D1 的机器形态）。
 *
 * 规则（闭集，只在这两条）：
 * ```text
 * ① 声明"不写/只读"（writeAllowed=false）却在说明里把写入**委托**出去
 *    ⇒ conflict `write_delegation_without_write_boundary`
 * ② 声明"不出网"（networkAllowed=false）却在说明里把联网检索委托出去
 *    ⇒ conflict `network_delegation_without_boundary`
 * ```
 * ⚠️ 这是**文本级**检测（子串），不是语义判断：它能稳定识别"说明里写了写入工具"，
 *    不能识别同义改写。P3-3 用它证明"候选确实修掉了这条矛盾"，而不是"所有矛盾都能被它发现"。
 */
export const WRITE_DELEGATION_TOKENS = ['写入工具', '保存到文件', '写文件工具'] as const
export const NETWORK_DELEGATION_TOKENS = ['联网检索', 'web.search', '搜索互联网'] as const

export type InstructionBoundaryConflict =
  | 'write_delegation_without_write_boundary'
  | 'network_delegation_without_boundary'

export function detectInstructionBoundaryConflicts(
  instructions: string,
  release: Pick<WorkflowSkillRelease, 'inputBoundary' | 'requiredCapabilities'>
): InstructionBoundaryConflict[] {
  const conflicts: InstructionBoundaryConflict[] = []
  if (release.inputBoundary.writeAllowed === false &&
      WRITE_DELEGATION_TOKENS.some((token) => instructions.includes(token))) {
    conflicts.push('write_delegation_without_write_boundary')
  }
  if (release.inputBoundary.networkAllowed === false &&
      NETWORK_DELEGATION_TOKENS.some((token) => instructions.includes(token)) &&
      !release.requiredCapabilities.some((capability) => capability.startsWith('web.'))) {
    conflicts.push('network_delegation_without_boundary')
  }
  return conflicts
}

// ---------------------------------------------------------------------------
// 发布裁定
// ---------------------------------------------------------------------------

export type WorkflowSkillRevisionRejectCode =
  | 'revision_proposal_missing'
  | 'revision_candidate_not_in_catalog'
  | 'revision_parent_missing'
  | 'revision_parent_mismatch'
  | 'revision_version_invalid'
  | 'revision_content_fingerprint_mismatch'
  | 'revision_digest_mismatch'
  | 'revision_capability_expanded'
  | 'revision_boundary_expanded'
  | 'revision_state_not_candidate'
  | 'revision_stale_parent'
  | 'revision_duplicate_publication'
  | 'revision_verification_missing'
  | 'revision_verification_forged'
  | 'revision_dev_regression_failed'
  | 'revision_holdout_failed'
  | 'revision_holdout_reuse'
  | 'revision_retire_current'
  | 'revision_rollback_target_not_published'
  | 'revision_rollback_target_unregistered'

export type WorkflowSkillRevisionRejectStage =
  | 'proposal'
  | 'identity'
  | 'permission'
  | 'verification'
  | 'state'
  | 'decision'

export type WorkflowSkillRevisionDecision =
  | { readonly ok: true; readonly skillId: string; readonly version: number; readonly bundleDigest: string }
  | {
      readonly ok: false
      readonly code: WorkflowSkillRevisionRejectCode
      readonly detail: string
      /** 判定停在哪个阶段（诊断/门用；不进发布路径） */
      readonly stage: WorkflowSkillRevisionRejectStage
    }

export interface RevisionPromotionInput {
  readonly proposal: WorkflowSkillRevisionProposal | undefined
  readonly catalogSkill: WorkflowSkillCatalogSkill | undefined
  readonly candidateState: WorkflowSkillPublishedState | undefined
  readonly parentState: WorkflowSkillPublishedState | undefined
  readonly parentRelease: WorkflowSkillRelease | undefined
  readonly candidateRelease: WorkflowSkillRelease | undefined
  /** 候选内容文件的**实测** sha256（由资产加载器读字节算出） */
  readonly actualCandidateContentFingerprint: string
  readonly bundle: WorkflowSkillVerificationBundle | undefined
  readonly frozen: { readonly dev: WorkflowSkillVerificationSet; readonly holdout: WorkflowSkillVerificationSet }
  /**
   * 已经**失败**过的留出集签名（来自历史裁定）。签名有两种：`setId`（历史行）与
   * **任务签名**（`computeVerificationTasksDigest`；把判据绑到题面材料上，改名不放过）。
   * 用于"不许对同一份留出材料调到通过"。
   */
  readonly failedHoldoutSignatures: readonly string[]
  /** 本次候选所用冻结留出集的**任务签名**（发布器算好传进来；kernel 不读文件） */
  readonly holdoutTasksDigest: string
}

/**
 * 发布裁定（**纯判定**，顺序即计划 §4 的顺序）。
 *
 * ```text
 * 提案存在 → 候选在目录+登记为 candidate → 父版本存在且 = version-1 →
 * 内容指纹/身份摘要 → 能力不扩大 → 边界不扩大 → 验证包完整性 →
 * 开发回归 pass → 留出 pass（且不是"重试同一留出集"）→ 父版本仍是当前版本 → 未重复发布
 * ```
 */
export function decideRevisionPromotion(input: RevisionPromotionInput): WorkflowSkillRevisionDecision {
  const reject = (
    code: WorkflowSkillRevisionRejectCode,
    stage: WorkflowSkillRevisionRejectStage,
    detail: string
  ): WorkflowSkillRevisionDecision => ({ ok: false, code, stage, detail })

  if (input.proposal === undefined) {
    return reject('revision_proposal_missing', 'proposal', '没有登记这个（技能 × 版本）的修订候选提议')
  }
  const proposal = input.proposal
  if (input.catalogSkill === undefined || input.candidateRelease === undefined) {
    return reject('revision_candidate_not_in_catalog', 'identity', `目录里没有 ${proposal.skillId}@${String(proposal.version)}`)
  }
  const candidate = input.candidateRelease
  const parent = input.parentRelease
  if (parent === undefined) {
    return reject('revision_parent_missing', 'identity', `父版本 ${String(proposal.parentVersion)} 不在目录里`)
  }
  if (candidate.predecessorVersion !== parent.version || proposal.parentVersion !== parent.version) {
    return reject('revision_parent_mismatch', 'identity', `候选父版本与提议/目录不一致（proposal=${String(proposal.parentVersion)}，release=${String(candidate.predecessorVersion)}）`)
  }
  /*
   * 版本单调递增（不要求 = 父+1；见 `parseRevisionRegistry` 里那段说明：
   * 强制 +1 会让"被拒候选永久占位"，"换新材料重试"不可达）。
   */
  if (candidate.version <= parent.version || proposal.version !== candidate.version) {
    return reject('revision_version_invalid', 'identity', `候选版本必须 > 父版本（父=${String(parent.version)}，候选=${String(candidate.version)}）`)
  }
  if (input.actualCandidateContentFingerprint !== candidate.contentFingerprint) {
    return reject(
      'revision_content_fingerprint_mismatch',
      'identity',
      `候选内容文件实测指纹与目录登记不一致（实测 ${input.actualCandidateContentFingerprint.slice(0, 12)}）`
    )
  }
  const recomputed = computeWorkflowSkillReleaseDigest(candidate)
  if (recomputed !== candidate.releaseDigest) {
    return reject('revision_digest_mismatch', 'identity', '候选 releaseDigest 与身份不一致')
  }
  if (input.candidateState === undefined) {
    return reject('revision_candidate_not_in_catalog', 'state', `候选 ${proposal.skillId}@${String(proposal.version)} 没有登记发布状态`)
  }
  if (input.candidateState.releaseDigest !== candidate.releaseDigest) {
    return reject('revision_digest_mismatch', 'state', '持久层登记的摘要与候选目录资产不一致')
  }

  /* ---- 权限/边界：只允许"不扩大" ---- */
  const expandedCapabilities = candidate.requiredCapabilities.filter(
    (capability) => !parent.requiredCapabilities.includes(capability)
  )
  if (expandedCapabilities.length > 0) {
    return reject(
      'revision_capability_expanded',
      'permission',
      `候选声明了父版本没有的能力：${expandedCapabilities.join(', ')}（技能声明的能力是上限，修订不得扩张）`
    )
  }
  const expandedRoots = candidate.inputBoundary.roots.filter((root) => !parent.inputBoundary.roots.includes(root))
  if (expandedRoots.length > 0 || candidate.inputBoundary.writeAllowed !== parent.inputBoundary.writeAllowed ||
      candidate.inputBoundary.networkAllowed !== parent.inputBoundary.networkAllowed) {
    return reject('revision_boundary_expanded', 'permission', '候选扩大了输入边界（新增根 / 改变写或网声明）')
  }

  /* ---- 验证包完整性 ---- */
  const integrity = verifyBundleIntegrity(
    input.bundle,
    {
      dev: input.frozen.dev,
      holdout: input.frozen.holdout,
      skillId: candidate.skillId,
      version: candidate.version,
      parentVersion: parent.version,
    },
    { devSetId: proposal.devSetId, holdoutSetId: proposal.holdoutSetId }
  )
  if (!integrity.ok) return reject(integrity.code, 'verification', integrity.detail)
  const bundle = input.bundle!

  if (bundle.dev.verdict !== 'pass') {
    return reject(
      'revision_dev_regression_failed',
      'verification',
      `开发回归失败：${bundle.dev.setId} 有 ${String(bundle.dev.failures)}/${String(bundle.dev.checks)} 条失败`
    )
  }
  /*
   * 留出材料复用：**既按 setId 也按任务签名**判。
   * 只按 setId 会被"复制同一批任务到新 setId"绕过（独立复核构造过）；任务签名让
   * "换名字"不等于"换材料"。
   */
  const holdoutReused =
    input.failedHoldoutSignatures.includes(bundle.holdout.setId) ||
    input.failedHoldoutSignatures.includes(input.holdoutTasksDigest)
  if (holdoutReused) {
    return reject(
      'revision_holdout_reuse',
      'verification',
      `留出材料 ${bundle.holdout.setId}（任务签名 ${input.holdoutTasksDigest.slice(0, 12)}）已经失败过：` +
        '继续修订必须换新的开发/验证安排，不得对同一份留出材料反复调到通过'
    )
  }
  if (bundle.holdout.verdict !== 'pass') {
    return reject(
      'revision_holdout_failed',
      'verification',
      `冻结留出失败：${bundle.holdout.setId} 有 ${String(bundle.holdout.failures)}/${String(bundle.holdout.checks)} 条失败`
    )
  }

  /* ---- 状态 ---- */
  if (input.candidateState.state !== 'candidate') {
    return reject(
      'revision_state_not_candidate',
      'state',
      `候选当前状态是 ${input.candidateState.state}（重复发布同一版本也被这里挡住）`
    )
  }
  if (input.parentState === undefined || !input.parentState.isCurrent) {
    return reject('revision_stale_parent', 'state', `父版本 @${String(parent.version)} 已不是当前版本`)
  }
  /*
   * ⚠️ 不再拿**资产里的** `currentVersion` 判"当前版本"（2026-10-28 实测踩到）：
   *    资产是登记种子，P3-3 的实验发布会把持久层的当前版本切到新候选，
   *    而不可变资产不会跟着改 ⇒ 用资产值判会让重试候选被判 stale（它的父版本
   *    明明是刚发布的那一个）。运行时当前版本**只**看 `parentState.isCurrent`。
   */
  return { ok: true, skillId: candidate.skillId, version: candidate.version, bundleDigest: bundle.bundleDigest }
}

/** 回退裁定：目标必须**已登记且 published**（旧版本保留的条件）。 */
export function decideRevisionRollback(input: {
  readonly skillId: string
  readonly toVersion: number
  readonly targetState: WorkflowSkillPublishedState | undefined
}): { ok: true } | { readonly ok: false; readonly code: WorkflowSkillRevisionRejectCode; readonly stage: 'state'; readonly detail: string } {
  if (input.targetState === undefined) {
    return { ok: false, code: 'revision_rollback_target_unregistered', stage: 'state', detail: `目标 ${input.skillId}@${String(input.toVersion)} 未登记` }
  }
  if (input.targetState.state !== 'published') {
    return {
      ok: false,
      code: 'revision_rollback_target_not_published',
      stage: 'state',
      detail: `目标 @${String(input.toVersion)} 当前状态是 ${input.targetState.state}：只有 published 能回退过去`,
    }
  }
  return { ok: true }
}

/** 退役裁定：**不允许直接把当前版本退役**（否则消费面会在没有替代版本时失联）。 */
export function decideRevisionRetirement(input: {
  readonly version: number
  readonly state: WorkflowSkillPublishedState | undefined
  readonly isCurrent: boolean
}):
  | { ok: true }
  | { readonly ok: false; readonly code: WorkflowSkillRevisionRejectCode; readonly stage: 'state'; readonly detail: string } {
  if (input.state === undefined) {
    return { ok: false, code: 'revision_rollback_target_unregistered', stage: 'state', detail: `版本 @${String(input.version)} 未登记` }
  }
  if (input.isCurrent) {
    return {
      ok: false,
      code: 'revision_retire_current',
      stage: 'state',
      detail: `@${String(input.version)} 是当前版本：先回退/切换当前版本，再退役`,
    }
  }
  return { ok: true }
}
