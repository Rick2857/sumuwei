/**
 * P3 —— **统一技能域的版本 / 发布状态 / 使用追溯契约**（kernel 侧，纯函数）。
 *
 * ============================================================================
 *  这份文件冻结的是什么
 * ============================================================================
 * ```text
 * ① 技能版本身份：skillId + version + 内容指纹 + 适用说明 + 所需能力 +
 *    输入边界 + 结果核验契约版本 ⇒ 一个 **releaseDigest**（改任何一项都是新版本）
 * ② 发布状态：candidate / published / suspended / retired（闭集 + 显式转移表）
 * ③ 受信指令引用：`workflow-skill:<id>@<version>#<内容指纹>`（@1 的旧引用逐字仍可解释）
 * ④ 使用记录：把「选中 / 加载成功 / 说明实际入模 / 资料实际入模 / 任务结果」
 *    拆成**互不冒充**的字段，全部来自真实动作与真实 packet，不看自述
 * ⑤ 结果核验：personal-library 首版任务的**机械**判据（来源真实、缺失如实），
 *    语义质量不在其中（那需要独立评测，P3-5）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  P3 纪律（每条都对应 plan §3 的一条约束）
 * ---------------------------------------------------------------------------
 * · 加载成功 ≠ 使用 ≠ 完成：三者在 `WorkflowSkillUsageRecord` 里是不同字段。
 * · 只有 `published` 版本能进受信技能指令；candidate / suspended / retired 一律不能。
 * · 技能声明的 `requiredCapabilities` 是**上限约束**，不授予权限：
 *   加载时与本任务实际授予的能力**求交**，缺一项就失败关闭。
 * · 旧 @1 的内容身份**逐字保留**：personal-library v1 的 `contentFingerprint`
 *   必须等于旧 `manifest.json` 里的 sha256；新增元数据由 `releaseDigest` 覆盖，
 *   因此**不得**声称"旧指纹已经覆盖了新元数据"。
 * · 资料正文是**非受信内容**：本文件只判"哪些正文真的进了 packet"，不把正文当指令。
 *
 * ⚠️ 本文件是**纯组装/判定**：不读文件、不读数据库、不读时钟（`createdAt` 由调用方给）。
 *    资产读取在 `src/infrastructure/action/workflow-skill-catalog.ts`，
 *    状态持久化在 `src/infrastructure/persistence/workflow-skill-release-store.ts`。
 */

import { createHash } from 'node:crypto'

import type { ActionRequest } from '../action/action-request.ts'
import type { ActionTurnResult } from '../action/action-turn.ts'
import type { ContextPacket } from './context.ts'
import type { TurnContent } from './turn-content.ts'

// ---------------------------------------------------------------------------
// 版本与状态
// ---------------------------------------------------------------------------

export const WORKFLOW_SKILL_CATALOG_VERSION = 'workflow-skill-catalog@1' as const
export const WORKFLOW_SKILL_RELEASE_SCHEMA_VERSION = 'workflow-skill-release@1' as const

/** 发布状态（闭集）。只有 `published` 能成为受信技能指令。 */
export const WORKFLOW_SKILL_RELEASE_STATES = ['candidate', 'published', 'suspended', 'retired'] as const
export type WorkflowSkillReleaseState = (typeof WORKFLOW_SKILL_RELEASE_STATES)[number]

/**
 * 允许的状态转移（**显式表**，不是"任何状态都能到任何状态"）。
 *
 * ```text
 * candidate --发布通过--> published    （首次发布 / 修订候选通过冻结验证）
 * candidate --放弃------> retired
 * published --挂起------> suspended    （发现缺陷；后续消费必须停）
 * suspended --复核通过--> published
 * published --退役------> retired
 * suspended --退役------> retired
 * retired   --无--------> （终态；回退靠**切当前版本**，不是把 retired 改回去）
 * ```
 *
 * ⚠️ "重复发布"（published → published）**不在表里**：同一版本重复发布是一类坏操作
 *    （派生状态、双份验证记录），必须被拒。
 */
export const WORKFLOW_SKILL_RELEASE_TRANSITIONS: Readonly<
  Record<WorkflowSkillReleaseState, readonly WorkflowSkillReleaseState[]>
> = {
  candidate: ['published', 'retired'],
  published: ['suspended', 'retired'],
  suspended: ['published', 'retired'],
  retired: [],
}

export function isWorkflowSkillReleaseState(value: unknown): value is WorkflowSkillReleaseState {
  return typeof value === 'string' && (WORKFLOW_SKILL_RELEASE_STATES as readonly string[]).includes(value)
}

/** 某版本的**当前**发布事实（来自持久层；与不可变资产分离）。 */
export interface WorkflowSkillPublishedState {
  readonly skillId: string
  readonly version: number
  readonly state: WorkflowSkillReleaseState
  readonly isCurrent: boolean
  readonly releaseDigest: string
}

// ---------------------------------------------------------------------------
// 版本身份
// ---------------------------------------------------------------------------

/**
 * 输入边界（闭集形状）。
 *
 * ⚠️ 它不是"权限"，是**声明的上限**：真实权限仍由本任务授权决定（两者求交）。
 *    字段刻意只有三个：任意扩展（glob / 正则 / 任意路径）等于给技能开了一条
 *    "自己描述权限"的口子，那正是 plan §3 第 4 条禁止的。
 */
export interface WorkflowSkillInputBoundary {
  /** 只读资料根的**标识**（不是任意绝对路径）：例如 `['data/personal-library']` */
  readonly roots: readonly string[]
  /** 首版流程只读 ⇒ 恒为 false（形状上就不允许 true） */
  readonly writeAllowed: false
  /** 首版流程不出网 ⇒ 恒为 false */
  readonly networkAllowed: false
}

/** 验证记录：谁、何时、哪些门证明这个版本可用。 */
export interface WorkflowSkillVerificationRecord {
  /** 证据文件的仓库相对路径（报告 / 批记录） */
  readonly reportRef: string
  /** ISO 日期（YYYY-MM-DD） */
  readonly verifiedAt: string
  /** 证明它的门 id（闭集校验由调用方提供 `ALL_GATES` 时在门里做） */
  readonly gateIds: readonly string[]
}

/**
 * 版本身份的**全部**内容（hex 之外的每一个字段都进 releaseDigest）。
 *
 * ⚠️ 改这里任何一项 ⇒ 必须是一个**新版本**：不允许覆盖旧版本及其验证证据
 *    （plan §3 约束 1）。`releaseDigest` 就是那条规则的机器形态。
 */
export interface WorkflowSkillReleaseIdentity {
  readonly skillId: string
  readonly version: number
  /** 内容文件字节的 sha256（旧 @1 身份**逐字保留**） */
  readonly contentFingerprint: string
  /** 适用说明（给人看的路由依据；不是模型指令，也不承担关键词路由） */
  readonly applicability: string
  /** 本流程需要的能力 id（上限约束，不授予权限） */
  readonly requiredCapabilities: readonly string[]
  readonly inputBoundary: WorkflowSkillInputBoundary
  /** 结果核验契约版本，例如 `personal-library-answer@1` */
  readonly resultVerificationContract: string
  /** 前驱版本号（首版 = null） */
  readonly predecessorVersion: number | null
}

export interface WorkflowSkillRelease extends WorkflowSkillReleaseIdentity {
  /** 内容文件的仓库相对路径（v1 = `<skillId>/SKILL.md`；v≥2 = `<skillId>/v<version>/SKILL.md`） */
  readonly contentPath: string
  /** 变更原因（首版 = 迁移说明） */
  readonly changeReason: string
  readonly verification: WorkflowSkillVerificationRecord
  /** 目录登记时的初始状态（首个版本 = published；修订候选 = candidate） */
  readonly initialState: 'published' | 'candidate'
  /** 身份摘要（`computeWorkflowSkillReleaseDigest` 的结果，必须逐字相等） */
  readonly releaseDigest: string
}

export interface WorkflowSkillCatalogSkill {
  readonly skillId: string
  /** 当前版本（目录声明；运行时以持久层 `is_current` 为准） */
  readonly currentVersion: number
  readonly releases: readonly WorkflowSkillRelease[]
}

export interface WorkflowSkillCatalog {
  readonly catalogVersion: typeof WORKFLOW_SKILL_CATALOG_VERSION
  readonly skills: readonly WorkflowSkillCatalogSkill[]
}

// ---------------------------------------------------------------------------
// 目录解析（闭集 + 确定性失败码）
// ---------------------------------------------------------------------------

export type WorkflowSkillCatalogCode =
  | 'catalog_not_object'
  | 'catalog_unknown_field'
  | 'catalog_version_mismatch'
  | 'skill_not_object'
  | 'skill_unknown_field'
  | 'skill_id_invalid'
  | 'skill_duplicate'
  | 'skill_releases_empty'
  | 'release_not_object'
  | 'release_unknown_field'
  | 'release_skill_mismatch'
  | 'version_invalid'
  | 'version_duplicate'
  | 'version_gap'
  | 'content_path_mismatch'
  | 'fingerprint_invalid'
  | 'applicability_empty'
  | 'capability_invalid'
  | 'capability_duplicate'
  | 'boundary_invalid'
  | 'result_contract_invalid'
  | 'predecessor_invalid'
  | 'change_reason_empty'
  | 'verification_invalid'
  | 'initial_state_invalid'
  | 'release_digest_mismatch'
  | 'current_version_missing'
  | 'current_not_published'

export type WorkflowSkillCatalogParseResult =
  | { readonly ok: true; readonly catalog: WorkflowSkillCatalog }
  | { readonly ok: false; readonly code: WorkflowSkillCatalogCode; readonly detail: string }

const CATALOG_FIELDS = new Set(['catalogVersion', 'skills'])
const SKILL_FIELDS = new Set(['skillId', 'currentVersion', 'releases'])
const RELEASE_FIELDS = new Set([
  'skillId', 'version', 'contentPath', 'contentFingerprint', 'applicability',
  'requiredCapabilities', 'inputBoundary', 'resultVerificationContract',
  'predecessorVersion', 'changeReason', 'verification', 'initialState', 'releaseDigest',
])
const BOUNDARY_FIELDS = new Set(['roots', 'writeAllowed', 'networkAllowed'])
const VERIFICATION_FIELDS = new Set(['reportRef', 'verifiedAt', 'gateIds'])

const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
/*
 * 能力 id 是**多段**的：`library.search`、`document.read`、`local.file.read`……
 * （真实 id 见 `src/kernel/action/local-file-capabilities.ts`、`learning-capabilities.ts`）。
 * ⚠️ 第一版正则只允许**一个**点 ⇒ 真实资产 `local.file.read` 被误拒，
 *    且 `main.ts` 开目录模式时会启动即抛（门作者实测抓到，已修）。
 */
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function fail(code: WorkflowSkillCatalogCode, detail: string): WorkflowSkillCatalogParseResult {
  return { ok: false, code, detail }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key))
}

function nonEmptyString(value: unknown, max = 600): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

/**
 * 确定性 JSON（排序键、无空白）：`releaseDigest` 的输入必须逐字节稳定，
 * 否则"同一份身份"在不同进程里会算出不同摘要。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * 版本内容文件的**唯一合法路径**。
 *
 * ```text
 * version 1（ADR-119 的旧资产）  → `<skillId>/SKILL.md`      （字节位置不变，@1 身份不动）
 * version ≥ 2（候选 / 修订版本）  → `<skillId>/v<version>/SKILL.md`
 * ```
 * ⚠️ 为什么必须分开：v1 的路径是**既有资产的位置**，改它等于在两个地方放同一份
 *    SKILL.md 并让"@1 内容身份"失去唯一落点；而候选版本必须能和已发布版本
 *    **并存在同一目录里**（P3-3 的候选不得覆盖旧版本文件）。
 */
export function expectedWorkflowSkillContentPath(skillId: string, version: number): string {
  return version === 1 ? `${skillId}/SKILL.md` : `${skillId}/v${String(version)}/SKILL.md`
}

/**
 * 版本身份摘要。
 *
 * 覆盖：skillId / version / 内容指纹 / 适用说明 / 所需能力 / 输入边界 /
 * 结果核验契约 / 前驱版本。**不覆盖** contentPath（它由 skillId 派生）、
 * changeReason、verification（它们是"为什么"与"谁证明"，不是身份）。
 */
export function computeWorkflowSkillReleaseDigest(identity: WorkflowSkillReleaseIdentity): string {
  const payload = canonicalJson({
    skillId: identity.skillId,
    version: identity.version,
    contentFingerprint: identity.contentFingerprint,
    applicability: identity.applicability,
    requiredCapabilities: [...identity.requiredCapabilities],
    inputBoundary: {
      roots: [...identity.inputBoundary.roots],
      writeAllowed: identity.inputBoundary.writeAllowed,
      networkAllowed: identity.inputBoundary.networkAllowed,
    },
    resultVerificationContract: identity.resultVerificationContract,
    predecessorVersion: identity.predecessorVersion,
  })
  return createHash('sha256').update(`${WORKFLOW_SKILL_RELEASE_SCHEMA_VERSION}\n${payload}`).digest('hex')
}

function parseBoundary(raw: unknown): WorkflowSkillInputBoundary | undefined {
  if (!isPlainObject(raw)) return undefined
  if (unknownFields(raw, BOUNDARY_FIELDS) !== undefined) return undefined
  if (!Array.isArray(raw.roots) || raw.roots.length === 0 || raw.roots.length > 8) return undefined
  const roots: string[] = []
  for (const root of raw.roots) {
    if (typeof root !== 'string' || root.length === 0 || root.length > 240) return undefined
    if (root.startsWith('/') || root.includes('\\') || root.split('/').some((part) => part === '..' || part === '')) {
      return undefined
    }
    if (!roots.includes(root)) roots.push(root)
  }
  if (raw.writeAllowed !== false || raw.networkAllowed !== false) return undefined
  return { roots, writeAllowed: false, networkAllowed: false }
}

function parseVerification(raw: unknown): WorkflowSkillVerificationRecord | undefined {
  if (!isPlainObject(raw)) return undefined
  if (unknownFields(raw, VERIFICATION_FIELDS) !== undefined) return undefined
  if (!nonEmptyString(raw.reportRef, 240)) return undefined
  if (typeof raw.verifiedAt !== 'string' || !DATE_PATTERN.test(raw.verifiedAt)) return undefined
  if (!Array.isArray(raw.gateIds) || raw.gateIds.length === 0 || raw.gateIds.length > 32) return undefined
  const gateIds: string[] = []
  for (const gate of raw.gateIds) {
    if (typeof gate !== 'string' || gate.length === 0 || gate.length > 120) return undefined
    if (!gateIds.includes(gate)) gateIds.push(gate)
  }
  return { reportRef: raw.reportRef, verifiedAt: raw.verifiedAt, gateIds }
}

/**
 * 解析 + 校验技能目录资产。
 *
 * 失败码是**闭集**（不是字符串拼接）：门可以逐条断言"哪一类坏形状被拒"，
 * 而"随便一个 Error"无法区分"资产坏了"与"解析器写错了"。
 */
export function parseWorkflowSkillCatalog(raw: unknown): WorkflowSkillCatalogParseResult {
  if (!isPlainObject(raw)) return fail('catalog_not_object', '目录资产必须是对象')
  const extra = unknownFields(raw, CATALOG_FIELDS)
  if (extra !== undefined) return fail('catalog_unknown_field', `目录资产含未知字段 ${extra}`)
  if (raw.catalogVersion !== WORKFLOW_SKILL_CATALOG_VERSION) {
    return fail('catalog_version_mismatch', `catalogVersion 必须是 ${WORKFLOW_SKILL_CATALOG_VERSION}`)
  }
  if (!Array.isArray(raw.skills) || raw.skills.length === 0) {
    return fail('skill_not_object', 'skills 必须是非空数组')
  }

  const skills: WorkflowSkillCatalogSkill[] = []
  for (const rawSkill of raw.skills) {
    if (!isPlainObject(rawSkill)) return fail('skill_not_object', '技能条目必须是对象')
    const skillExtra = unknownFields(rawSkill, SKILL_FIELDS)
    if (skillExtra !== undefined) return fail('skill_unknown_field', `技能条目含未知字段 ${skillExtra}`)
    if (typeof rawSkill.skillId !== 'string' || !SKILL_ID_PATTERN.test(rawSkill.skillId)) {
      return fail('skill_id_invalid', `skillId 不是合法标识：${String(rawSkill.skillId)}`)
    }
    if (skills.some((skill) => skill.skillId === rawSkill.skillId)) {
      return fail('skill_duplicate', `重复的 skillId：${rawSkill.skillId}`)
    }
    if (!Array.isArray(rawSkill.releases) || rawSkill.releases.length === 0) {
      return fail('skill_releases_empty', `${rawSkill.skillId} 没有任何版本`)
    }

    const releases: WorkflowSkillRelease[] = []
    for (const rawRelease of rawSkill.releases) {
      if (!isPlainObject(rawRelease)) return fail('release_not_object', '版本条目必须是对象')
      const releaseExtra = unknownFields(rawRelease, RELEASE_FIELDS)
      if (releaseExtra !== undefined) return fail('release_unknown_field', `版本条目含未知字段 ${releaseExtra}`)
      if (rawRelease.skillId !== rawSkill.skillId) {
        return fail('release_skill_mismatch', `版本条目的 skillId 与所属技能不一致：${String(rawRelease.skillId)}`)
      }
      if (typeof rawRelease.version !== 'number' || !Number.isSafeInteger(rawRelease.version) || rawRelease.version < 1) {
        return fail('version_invalid', `version 必须是 ≥1 的安全整数：${String(rawRelease.version)}`)
      }
      if (releases.some((release) => release.version === rawRelease.version)) {
        return fail('version_duplicate', `重复的版本号：${rawSkill.skillId}@${String(rawRelease.version)}`)
      }
      if (rawRelease.contentPath !== expectedWorkflowSkillContentPath(rawSkill.skillId, rawRelease.version)) {
        return fail(
          'content_path_mismatch',
          `contentPath 必须 = ${expectedWorkflowSkillContentPath(rawSkill.skillId, rawRelease.version)}`
        )
      }
      if (typeof rawRelease.contentFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(rawRelease.contentFingerprint)) {
        return fail('fingerprint_invalid', 'contentFingerprint 必须是 64 位小写 hex')
      }
      if (!nonEmptyString(rawRelease.applicability, 400)) {
        return fail('applicability_empty', 'applicability 必须是非空说明（≤400 字符）')
      }
      if (!Array.isArray(rawRelease.requiredCapabilities) || rawRelease.requiredCapabilities.length === 0) {
        return fail('capability_invalid', 'requiredCapabilities 必须是非空数组')
      }
      const capabilities: string[] = []
      for (const capability of rawRelease.requiredCapabilities) {
        if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
          return fail('capability_invalid', `能力 id 不合法：${String(capability)}`)
        }
        if (capabilities.includes(capability)) return fail('capability_duplicate', `重复能力：${capability}`)
        capabilities.push(capability)
      }
      const boundary = parseBoundary(rawRelease.inputBoundary)
      if (boundary === undefined) {
        return fail('boundary_invalid', 'inputBoundary 形状不合法（roots 非空 / 禁写 / 禁网 / 无绝对路径与 ..）')
      }
      if (!nonEmptyString(rawRelease.resultVerificationContract, 120) ||
          !/^[a-z][a-z0-9-]*@\d+$/.test(String(rawRelease.resultVerificationContract))) {
        return fail('result_contract_invalid', 'resultVerificationContract 必须是 `<name>@<version>`')
      }
      let predecessor: number | null
      if (rawRelease.predecessorVersion === null) predecessor = null
      else if (typeof rawRelease.predecessorVersion === 'number' && Number.isSafeInteger(rawRelease.predecessorVersion) &&
               rawRelease.predecessorVersion >= 1 && rawRelease.predecessorVersion < rawRelease.version) {
        predecessor = rawRelease.predecessorVersion
      } else {
        return fail('predecessor_invalid', 'predecessorVersion 必须是 null 或小于本版本的正整数')
      }
      if (!nonEmptyString(rawRelease.changeReason, 400)) {
        return fail('change_reason_empty', 'changeReason 必须是非空说明（≤400 字符）')
      }
      const verification = parseVerification(rawRelease.verification)
      if (verification === undefined) {
        return fail('verification_invalid', 'verification 形状不合法（reportRef / verifiedAt / gateIds）')
      }
      if (rawRelease.initialState !== 'published' && rawRelease.initialState !== 'candidate') {
        return fail('initial_state_invalid', 'initialState 只能是 published 或 candidate')
      }
      const identity: WorkflowSkillReleaseIdentity = {
        skillId: rawSkill.skillId,
        version: rawRelease.version,
        contentFingerprint: rawRelease.contentFingerprint,
        applicability: rawRelease.applicability,
        requiredCapabilities: capabilities,
        inputBoundary: boundary,
        resultVerificationContract: rawRelease.resultVerificationContract,
        predecessorVersion: predecessor,
      }
      const expectedDigest = computeWorkflowSkillReleaseDigest(identity)
      if (rawRelease.releaseDigest !== expectedDigest) {
        return fail(
          'release_digest_mismatch',
          `${rawSkill.skillId}@${String(rawRelease.version)} 的 releaseDigest 与身份不一致` +
            `（资产=${String(rawRelease.releaseDigest)}，重算=${expectedDigest}）`
        )
      }
      releases.push({
        ...identity,
        contentPath: rawRelease.contentPath,
        changeReason: rawRelease.changeReason,
        verification,
        initialState: rawRelease.initialState,
        releaseDigest: expectedDigest,
      })
    }

    releases.sort((a, b) => a.version - b.version)
    /* 版本链必须从 1 起连续：断号意味着"某个版本的资产被删了"，而那会让历史记录无法回查 */
    for (let index = 0; index < releases.length; index += 1) {
      if (releases[index]!.version !== index + 1) {
        return fail('version_gap', `${rawSkill.skillId} 的版本号必须从 1 起连续（缺 @${String(index + 1)}）`)
      }
    }

    if (typeof rawSkill.currentVersion !== 'number' || !Number.isSafeInteger(rawSkill.currentVersion)) {
      return fail('current_version_missing', `${rawSkill.skillId} 的 currentVersion 缺失或不是整数`)
    }
    const current = releases.find((release) => release.version === rawSkill.currentVersion)
    if (current === undefined) {
      return fail('current_version_missing', `${rawSkill.skillId} 的 currentVersion 不在 releases 里`)
    }
    if (current.initialState !== 'published') {
      return fail('current_not_published', `${rawSkill.skillId} 的当前版本必须登记为 published`)
    }
    skills.push({ skillId: rawSkill.skillId, currentVersion: rawSkill.currentVersion, releases })
  }

  return { ok: true, catalog: { catalogVersion: WORKFLOW_SKILL_CATALOG_VERSION, skills } }
}

// ---------------------------------------------------------------------------
// 引用（旧 @1 身份逐字保留）
// ---------------------------------------------------------------------------

/**
 * 受信指令 section 的 id（**与 P3 之前逐字相同**：`workflow-skill:personal-library`）。
 *
 * ⚠️ 不改 id 是刻意的：M4.5 起的 `learning-skills-verify` 与 trace 历史都按这个 id
 *    断言"流程进了上下文"。版本信息放在 `sourceRefs` 里，而不是塞进 id。
 */
export function workflowSkillSectionId(skillId: string): string {
  return `workflow-skill:${skillId}`
}

/** 受信指令来源引用：`workflow-skill:<id>@<version>#<内容指纹>`。 */
export function workflowSkillReleaseRef(
  skillId: string,
  version: number,
  contentFingerprint: string
): string {
  return `workflow-skill:${skillId}@${version}#${contentFingerprint}`
}

export interface ParsedWorkflowSkillReleaseRef {
  readonly skillId: string
  readonly version: number
  readonly contentFingerprint: string
}

export function parseWorkflowSkillReleaseRef(ref: string): ParsedWorkflowSkillReleaseRef | undefined {
  const match = /^workflow-skill:([a-z][a-z0-9-]{1,47})@(\d+)#([0-9a-f]{64})$/.exec(ref)
  if (match === null) return undefined
  const version = Number(match[2])
  if (!Number.isSafeInteger(version) || version < 1) return undefined
  return { skillId: match[1]!, version, contentFingerprint: match[3]! }
}

/**
 * 旧 @1 引用：`workflow-skill:<id>@1`（P3 之前 `evidence.ref` 的形状，**没有**内容指纹）。
 *
 * 它仍然可解释：旧适配器产出的加载回执就是这个形状，旧 `learning-skills-verify`
 * 也按它断言。P3 的受信指令要求**更强**的引用（带版本与内容指纹），但读历史
 * evidence 时两者都能读出 `skillId`/`version`。
 */
export function legacyWorkflowSkillRef(skillId: string): string {
  return `workflow-skill:${skillId}@1`
}

// ---------------------------------------------------------------------------
// 加载判定
// ---------------------------------------------------------------------------

export type WorkflowSkillLoadCode =
  | 'skill_not_managed'
  | 'skill_unknown'
  | 'release_not_registered'
  | 'release_digest_mismatch'
  | 'content_fingerprint_mismatch'
  | 'release_not_current'
  | 'release_not_published'
  | 'dependency_unauthorized'
  | 'dependency_unregistered'

export type WorkflowSkillLoadDecision =
  | {
      readonly ok: true
      readonly release: WorkflowSkillRelease
      /** 消费这一版**当时**的状态（只有 published 会走到这里） */
      readonly state: WorkflowSkillReleaseState
    }
  | {
      readonly ok: false
      readonly code: WorkflowSkillLoadCode
      readonly detail: string
      readonly state?: WorkflowSkillReleaseState
      readonly requiredCapabilities?: readonly string[]
      readonly missingCapabilities?: readonly string[]
    }

/**
 * 加载判定：**先身份，再状态，再依赖求交**。
 *
 * 顺序是刻意的：先证明"要加载的正是目录里那一版"（否则状态检查没有意义），
 * 再证明"它当前可以成为受信指令"，最后证明"本任务确实授予了它声明的能力"。
 * 任一失败都**不返回 release** ⇒ 调用方无法"先加载再说"。
 */
export function decideWorkflowSkillLoad(input: {
  readonly skill: WorkflowSkillCatalogSkill | undefined
  readonly states: readonly WorkflowSkillPublishedState[]
  /** 内容文件**实测** sha256（由资产加载器读字节算出） */
  readonly actualContentFingerprint: string
  /** 本任务已授予的能力 id 集合（技能声明的能力必须在此之内） */
  readonly grantedCapabilities: readonly string[]
  /** 已登记的能力 id（用于区分"未登记"与"未授权"） */
  readonly registeredCapabilities?: readonly string[]
  /** 请求的精确版本；缺省 = 目录里的当前版本 */
  readonly requestedVersion?: number
}): WorkflowSkillLoadDecision {
  if (input.skill === undefined) {
    return { ok: false, code: 'skill_not_managed', detail: '这个技能不在 P3 技能目录里（保留旧行为）' }
  }
  /*
   * ⚠️ 运行时当前版本以**持久层**为准（`isCurrent`），不是资产里的 `currentVersion`。
   *
   * 资产里的 `currentVersion` 只是**登记种子**（P3-1 bootstrap）：P3-3 的实验发布
   * 会把当前版本切到新候选，而不可变资产不会跟着改。若这里继续用资产的
   * `currentVersion` 判"是不是当前版本"，发布后的真实入口会**永远**加载不到新版本
   * （自己实测踩到：v2 发布后 load 仍解析到 v1 并被判 release_not_current）。
   * 资产给的是"默认/种子"，持久层给的是"此刻生效的是哪一版"。
   */
  const currentState = input.states.find((item) => item.isCurrent)
  const version = input.requestedVersion ?? currentState?.version ?? input.skill.currentVersion
  const release = input.skill.releases.find((item) => item.version === version)
  if (release === undefined) {
    return { ok: false, code: 'skill_unknown', detail: `${input.skill.skillId}@${String(version)} 不在目录里` }
  }
  const state = input.states.find((item) => item.skillId === release.skillId && item.version === release.version)
  if (state === undefined) {
    return { ok: false, code: 'release_not_registered', detail: `${release.skillId}@${String(release.version)} 未登记发布状态` }
  }
  if (state.releaseDigest !== release.releaseDigest) {
    return {
      ok: false,
      code: 'release_digest_mismatch',
      detail: `持久层登记的摘要与目录资产不一致（${state.releaseDigest.slice(0, 12)} ≠ ${release.releaseDigest.slice(0, 12)}）`,
    }
  }
  if (input.actualContentFingerprint !== release.contentFingerprint) {
    return {
      ok: false,
      code: 'content_fingerprint_mismatch',
      detail: `内容文件指纹与目录登记不一致（实测 ${input.actualContentFingerprint.slice(0, 12)}）`,
    }
  }
  if (!state.isCurrent) {
    return {
      ok: false,
      code: 'release_not_current',
      detail: `${release.skillId}@${String(release.version)} 不是当前版本（当前 = @${String(currentState?.version ?? input.skill.currentVersion)}）`,
      state: state.state,
    }
  }
  if (state.state !== 'published') {
    return {
      ok: false,
      code: 'release_not_published',
      detail: `${release.skillId}@${String(release.version)} 当前状态是 ${state.state}，不能作为受信技能加载`,
      state: state.state,
    }
  }
  const registered = input.registeredCapabilities === undefined ? undefined : new Set(input.registeredCapabilities)
  const missing = release.requiredCapabilities.filter((capability) => !input.grantedCapabilities.includes(capability))
  if (missing.length > 0) {
    const unregistered = registered === undefined
      ? []
      : missing.filter((capability) => !registered.has(capability))
    if (unregistered.length > 0) {
      return {
        ok: false,
        code: 'dependency_unregistered',
        detail: `技能声明的能力没有登记：${unregistered.join(', ')}`,
        requiredCapabilities: release.requiredCapabilities,
        missingCapabilities: missing,
      }
    }
    return {
      ok: false,
      code: 'dependency_unauthorized',
      detail: `本任务没有授予这些能力：${missing.join(', ')}（技能声明是上限约束，不授予权限）`,
      requiredCapabilities: release.requiredCapabilities,
      missingCapabilities: missing,
    }
  }
  return { ok: true, release, state: state.state }
}

// ---------------------------------------------------------------------------
// 使用记录（选中 / 加载 / 入模 / 动作 / 结果，全部互不冒充）
// ---------------------------------------------------------------------------

export const WORKFLOW_SKILL_USAGE_FLAGS = [
  /** 回执声称读到了内容，但没有任何当轮内容负载（假读回执） */
  'claimed_content_without_payload',
  /** 本次轮次结束时该版本已不是 published（消费边界复核失败） */
  'release_not_published_at_commit',
  /** 加载成功但指令没有进上下文（预算裁剪 / 状态不符 / 未挂 provider） */
  'instruction_withheld',
  /** 读到的内容没有被交付进上下文（预算裁剪） */
  'content_dropped',
  /** 回复声称完成，但没有任何真实读取支撑（假完成） */
  'unsupported_completion_claim',
  /** 读取落到了资料根之外 */
  'read_outside_boundary',
  /** **提交时读不到**该版本发布状态（表缺失/查询抖动；不得据此把结果升格成完成） */
  'release_state_unverified',
  /**
   * 本轮真实执行的动作超出了技能声明的能力上限（**事后**判据）。
   *
   * ⚠️ 声明的能力在**加载时**与本任务授权求交（失败关闭）；但"同轮之后又用了
   *    声明之外的能力"只能**事后**从真实动作读出来 —— 那正是这个 flag 的用途。
   *    它不撤销已经发生的动作（也不假装撤销），只让"声明是上限"这件事可核验。
   */
  'declared_capability_exceeded',
  /** 本任务被取消 / 授权失效 */
  'task_cancelled',
] as const
export type WorkflowSkillUsageFlag = (typeof WORKFLOW_SKILL_USAGE_FLAGS)[number]

export interface WorkflowSkillUsageRecord {
  readonly recordId: string
  readonly characterId: string
  readonly traceId: string
  readonly taskId?: string
  readonly skillId: string
  readonly version: number
  readonly contentFingerprint: string
  readonly releaseDigest: string
  /** 是否由 P3 目录管理（false = 旧路径，只做记账不做状态约束） */
  readonly managed: boolean
  /** 模型/规划**选中**了这个技能（有加载请求） */
  readonly selected: boolean
  /** 加载请求被接受并真实执行成功 */
  readonly loadSucceeded: boolean
  readonly loadReceiptFingerprint?: string
  readonly loadReceiptRef?: string
  /** 受信流程说明**实际进了** packet（不是"加载过"） */
  readonly instructionDelivered: boolean
  readonly instructionSectionId?: string
  readonly instructionSourceRefs: readonly string[]
  readonly instructionWithheldReason?: string
  /** 资料正文**实际进了** packet */
  readonly contentDelivered: boolean
  /** packet 里真实交付的当轮内容 id（`turn-content:<contentId>` 的 contentId 部分） */
  readonly deliveredContentIds: readonly string[]
  /** 成功读取过的真实路径（来自动作，不看自述） */
  readonly readPaths: readonly string[]
  /** 本轮真实执行过的动作（capability.operation，去重排序） */
  readonly actionRefs: readonly string[]
  readonly outcome: WorkflowSkillTaskOutcome['kind']
  readonly outcomeEvidence: WorkflowSkillTaskOutcome['evidence']
  readonly stopReason?: string
  /** 提交时该版本的状态（`unavailable` = 读不到状态） */
  readonly stateAtCommit: WorkflowSkillReleaseState | 'unavailable'
  readonly flags: readonly WorkflowSkillUsageFlag[]
  readonly budget: { readonly actionsUsed?: number; readonly plansUsed?: number }
  readonly createdAt: number
}

export interface WorkflowSkillTaskOutcome {
  readonly kind: 'done' | 'not_done' | 'unknown'
  readonly evidence: Readonly<Record<string, string | number | boolean>>
}

export interface SkillUsagePacketView {
  readonly sections: readonly {
    readonly id: string
    readonly kind: string
    readonly content: string
    readonly sourceRefs?: readonly string[]
  }[]
  readonly droppedSectionIds: readonly string[]
  readonly text: string
}

/**
 * **不读正文**的能力（回执虽然声明 `content_read`，但它只装载流程身份）。
 *
 * ⚠️ 实测抓到过两个真实缺陷（门作者报）：`workflow.skill.load` 的回执形状沿用旧适配器
 *    （`effect.kind:'content_read'` + `evidence.ref = workflow-skill:<id>@<v>#<指纹>` +
 *    **没有** turnContent）。若不排除它：
 *    ① 每一次成功加载都被记成"假读回执"（`claimed_content_without_payload`）；
 *    ② 受信引用被当成"读过的文件路径"（`readPaths` 混进非路径）⇒ 每次加载都被判
 *       `read_outside_boundary`；
 *    ③ `unsupported_completion_claim` 在加载过的轮次里**永远不可达**（因为它要求
 *       `readPaths` 为空，而加载回执恒占一条）⇒ 假完成负控在该轮失效。
 *    ⇒ 闭集排除（不猜"看起来像路径"），且 `readPaths` 额外只收**绝对文件系统路径**。
 */
const NON_CONTENT_READING_CAPABILITIES: ReadonlySet<string> = new Set(['workflow.skill'])

/** 一个 evidence.ref 是否是**文件系统路径**（绝对路径；不是业务引用如 `workflow-skill:…`）。 */
function looksLikeFilesystemPath(ref: string): boolean {
  return ref.startsWith('/') || ref.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(ref)
}

function actionViews(actionResults: readonly ActionTurnResult[]): {
  readonly readPaths: readonly string[]
  readonly actionRefs: readonly string[]
  readonly contentIds: readonly string[]
  readonly claimedContentWithoutPayload: boolean
} {
  const readPaths = new Set<string>()
  const actionRefs = new Set<string>()
  const contentIds = new Set<string>()
  let claimedContentWithoutPayload = false
  const visit = (item: ActionTurnResult): void => {
    const result = item.result
    if (result !== undefined && result.executed) {
      const request = item.request
      if (request !== undefined) actionRefs.add(`${request.capability}.${request.operation}`)
      for (const content of result.turnContent ?? []) contentIds.add(content.contentId)
      const readsContent = request === undefined || !NON_CONTENT_READING_CAPABILITIES.has(request.capability)
      if (readsContent && result.status === 'success' && result.effect?.kind === 'content_read') {
        const refs = (result.evidence ?? []).map((evidence) => evidence.ref).filter((ref): ref is string => typeof ref === 'string')
        /* 只有**路径**才算"读过的路径"：业务引用（`workflow-skill:` 等）不是路径 */
        for (const ref of refs) if (ref !== '' && looksLikeFilesystemPath(ref)) readPaths.add(ref)
        /*
         * ⚠️ **假读回执**的判定在这里：声称读到内容（`content_read`）却**没有**任何
         *    当轮内容负载 ⇒ 那一段正文从来没有存在过，模型也不可能见过它。
         *    不把"回执说有"当成"真的读了"。
         */
        if ((result.turnContent ?? []).length === 0) claimedContentWithoutPayload = true
      }
    }
    for (const followUp of item.followUps ?? []) visit(followUp)
  }
  for (const item of actionResults) visit(item)
  return {
    readPaths: [...readPaths].sort(),
    actionRefs: [...actionRefs].sort(),
    contentIds: [...contentIds].sort(),
    claimedContentWithoutPayload,
  }
}

/** 一条 packet 里真正交付的当轮内容 id（只在**保留下来**的 section 里数）。 */
export function deliveredTurnContentIds(packet: SkillUsagePacketView): readonly string[] {
  const delivered = new Set<string>()
  for (const section of packet.sections) {
    if (section.kind !== 'turn-content') continue
    for (const ref of section.sourceRefs ?? []) {
      if (ref.startsWith('turn-content:')) delivered.add(ref.slice('turn-content:'.length))
    }
  }
  return [...delivered].sort()
}

/**
 * 由**真实动作结果 + 真实 packet + 独立结果核验**派生一条使用记录。
 *
 * ⚠️ 四条纪律：
 *  1. `instructionDelivered` 只看 packet 里**留下来的**那个 section，且其 sourceRefs
 *     必须含**精确版本引用**（`@version#fingerprint`）——"加载过"不算"入模"。
 *  2. `contentDelivered` 只看 packet 里真实交付的内容 id；被预算裁掉的如实记
 *     `content_dropped`，而不是"读了就等于交付了"。
 *  3. `outcome` 由**独立核验器**给出（本函数不猜）；未达成/未知都不改写成完成。
 *  4. 加载成功但状态在提交时已不是 published ⇒ 记 `release_not_published_at_commit`
 *     且**不得**以 `done` 收口（消费边界复核）。
 */
export function deriveWorkflowSkillUsageRecord(input: {
  readonly characterId: string
  readonly traceId: string
  readonly taskId?: string
  readonly skillId: string
  readonly release: WorkflowSkillRelease
  readonly managed: boolean
  readonly actionResults: readonly ActionTurnResult[]
  readonly packet: SkillUsagePacketView
  readonly outcome: WorkflowSkillTaskOutcome
  readonly stateAtCommit: WorkflowSkillReleaseState | 'unavailable'
  readonly maxReadBoundaryRoots?: readonly string[]
  readonly instructionWithheldReason?: string
  readonly stopReason?: string
  readonly budget?: { readonly actionsUsed?: number; readonly plansUsed?: number }
  readonly createdAt: number
  /** 生成 recordId 的稳定来源（缺省 = traceId + skillId + version） */
  readonly recordIdSeed?: string
}): WorkflowSkillUsageRecord {
  const releaseRef = workflowSkillReleaseRef(input.skillId, input.release.version, input.release.contentFingerprint)
  const sectionId = workflowSkillSectionId(input.skillId)
  const views = actionViews(input.actionResults)

  const loadRequests: ActionRequest[] = []
  let loadSucceeded = false
  let loadReceiptFingerprint: string | undefined
  let loadReceiptRef: string | undefined
  const visit = (item: ActionTurnResult): void => {
    if (item.request?.capability === 'workflow.skill' && item.request.operation === 'load' &&
        item.request.arguments.skill === input.skillId) {
      loadRequests.push(item.request)
      const result = item.result
      if (result?.executed === true && result.status === 'success') {
        loadSucceeded = true
        loadReceiptFingerprint = result.effect?.fingerprint
        loadReceiptRef = (result.evidence ?? []).map((evidence) => evidence.ref)
          .find((ref): ref is string => typeof ref === 'string' && ref.startsWith(`workflow-skill:${input.skillId}@`))
      }
    }
    for (const followUp of item.followUps ?? []) visit(followUp)
  }
  for (const item of input.actionResults) visit(item)

  const instructionSection = input.packet.sections.find((section) => section.id === sectionId)
  const instructionDelivered = instructionSection !== undefined &&
    (instructionSection.sourceRefs ?? []).includes(releaseRef)
  const instructionSourceRefs = [...(instructionSection?.sourceRefs ?? [])].sort()
  const deliveredContentIds = deliveredTurnContentIds(input.packet)
  const deliveredSet = new Set(deliveredContentIds)
  const matchingContent = views.contentIds.filter((contentId) => deliveredSet.has(contentId))
  const contentDelivered = matchingContent.length > 0
  const contentDropped = !contentDelivered && views.contentIds.length > 0

  const flags: WorkflowSkillUsageFlag[] = []
  if (views.claimedContentWithoutPayload) flags.push('claimed_content_without_payload')
  if (input.stateAtCommit !== 'unavailable' && input.stateAtCommit !== 'published') {
    flags.push('release_not_published_at_commit')
  }
  /*
   * ⚠️ 2026-10-28 复核 I9：**状态读不到**不得静默。
   *
   * "读不到发布状态"有两种可能（表还没迁移 / 查询抖动），而两种都不允许把结果
   * 升格成"完成"。因此它与"已知非 published"一样降级，并打一个**具名** flag，
   * 让"这条记录为什么没结论"可以从数据里回答。
   */
  if (input.stateAtCommit === 'unavailable') flags.push('release_state_unverified')
  if (loadSucceeded && !instructionDelivered) flags.push('instruction_withheld')
  if (contentDropped) flags.push('content_dropped')
  if (input.stopReason === 'cancelled' || input.stopReason === 'authorization_revoked') flags.push('task_cancelled')
  if (input.maxReadBoundaryRoots !== undefined && input.maxReadBoundaryRoots.length > 0) {
    const roots = input.maxReadBoundaryRoots.map((root) => root.replace(/\\/g, '/').replace(/\/+$/, ''))
    const outside = views.readPaths.filter((path) => {
      const normalized = path.replace(/\\/g, '/')
      return !roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
    })
    if (outside.length > 0) flags.push('read_outside_boundary')
  }
  /*
   * 声明能力**事后**判据（复核 I3）：本轮真实执行的能力必须 ⊆ 技能声明 ∪ {workflow.skill}。
   * `actionRefs` 的形状是 `${capability}.${operation}` ⇒ 用**最后一个点**切回能力 id
   * （能力 id 自身含点：`local.file.read.read` → `local.file.read`）。
   */
  {
    const declared = new Set<string>([...input.release.requiredCapabilities, 'workflow.skill'])
    const exceeded = views.actionRefs
      .map((ref) => ref.slice(0, Math.max(0, ref.lastIndexOf('.'))))
      .filter((capability) => capability !== '' && !declared.has(capability))
    if (exceeded.length > 0) flags.push('declared_capability_exceeded')
  }
  /* 状态在提交时不是 published（含"读不到"）⇒ 不能以 done 收口（消费边界复核） */
  let outcome: WorkflowSkillTaskOutcome = input.outcome
  if (input.stateAtCommit !== 'published' && outcome.kind === 'done') {
    outcome = {
      kind: 'unknown',
      evidence: {
        ...outcome.evidence,
        reason: input.stateAtCommit === 'unavailable'
          ? 'release_state_unverified'
          : 'release_not_published_at_commit',
      },
    }
  }
  if (input.outcome.kind === 'done' && views.readPaths.length === 0 && views.contentIds.length === 0) {
    flags.push('unsupported_completion_claim')
  }

  const seed = input.recordIdSeed ?? `${input.traceId}:${input.skillId}@${String(input.release.version)}`
  const recordId = `skill-usage:${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`

  return {
    recordId,
    characterId: input.characterId,
    traceId: input.traceId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    skillId: input.skillId,
    version: input.release.version,
    contentFingerprint: input.release.contentFingerprint,
    releaseDigest: input.release.releaseDigest,
    managed: input.managed,
    selected: loadRequests.length > 0,
    loadSucceeded,
    ...(loadReceiptFingerprint !== undefined ? { loadReceiptFingerprint } : {}),
    ...(loadReceiptRef !== undefined ? { loadReceiptRef } : {}),
    instructionDelivered,
    ...(instructionSection !== undefined ? { instructionSectionId: instructionSection.id } : {}),
    instructionSourceRefs,
    ...(input.instructionWithheldReason !== undefined
      ? { instructionWithheldReason: input.instructionWithheldReason }
      : {}),
    contentDelivered,
    deliveredContentIds,
    readPaths: views.readPaths,
    actionRefs: views.actionRefs,
    outcome: outcome.kind,
    outcomeEvidence: outcome.evidence,
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    stateAtCommit: input.stateAtCommit,
    flags,
    budget: { ...(input.budget ?? {}) },
    createdAt: input.createdAt,
  }
}

/** 一次派生里"到底发生了哪几步"的**只读**读数（门用；不进数据库）。 */
export function summarizeSkillUsageStages(record: WorkflowSkillUsageRecord): {
  selected: boolean
  loaded: boolean
  instructed: boolean
  contentDelivered: boolean
  completed: boolean
} {
  return {
    selected: record.selected,
    loaded: record.loadSucceeded,
    instructed: record.instructionDelivered,
    contentDelivered: record.contentDelivered,
    completed: record.outcome === 'done',
  }
}

// ---------------------------------------------------------------------------
// 结果核验（personal-library-answer@1，机械判据）
// ---------------------------------------------------------------------------

export const PERSONAL_LIBRARY_ANSWER_CONTRACT = 'personal-library-answer@1' as const

export interface PersonalLibraryAnswerVerificationInput {
  readonly replyText: string
  /** 任务要求读到才能回答的来源路径（**真实路径**，程序给） */
  readonly requiredSourcePaths: readonly string[]
  /** 程序从真实动作里看到的成功读取路径 */
  readonly readPaths: readonly string[]
  /** 资料根（真实路径）；读取落在这里之外算越界 */
  readonly libraryRoot: string
  /** 只在资料里出现过的**事实标记**（回复若出现未登记标记 = 虚构来源） */
  readonly allowedFactMarkers: readonly string[]
  /** 任务期望"资料里没有"时，这里给出它**不该**出现的标记 */
  readonly absentFactMarkers?: readonly string[]
  /**
   * 任务是否**要求**回复给出"没有找到 / 资料里没有"的如实说明。
   * 为 true 时，回复必须含其中一个 `insufficientEvidencePhrases`，否则不算完成。
   */
  readonly expectsInsufficientEvidence?: boolean
  readonly insufficientEvidencePhrases?: readonly string[]
}

export interface PersonalLibraryAnswerVerification extends WorkflowSkillTaskOutcome {
  readonly requiredSourcesRead: readonly string[]
  readonly requiredSourcesMissing: readonly string[]
  readonly citedSources: readonly string[]
  readonly outOfScopeReads: readonly string[]
  readonly fabricatedMarkers: readonly string[]
  readonly absentMarkersAsserted: readonly string[]
  readonly insufficientEvidenceStated: boolean
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function withinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '')
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

/**
 * 首版流程（personal-library）的**机械**结果核验。
 *
 * 判据（全部可机器复核，不看模型自评）：
 * ```text
 * done       = 要求的来源**都被真实读取** + 回复里**引用了**这些来源
 *              + 没有出现资料里不存在的标记 + 没有越界读取
 *              + （若任务要求）如实说明"资料里没有"
 * not_done   = 真实读取发生但要求未满足（缺来源 / 未引用 / 虚构标记 / 越界）
 * unknown    = 关键前提拿不到（例如 requiredSourcePaths 为空、读路径为空但也没有失败证据）
 * ```
 *
 * ⚠️ **不判**自然语言质量、归纳是否正确：那需要独立评测（P3-5），本函数只回答
 *    "来源是否真实、缺失是否如实"。因此它**不能**被当成"回答正确"的证明。
 */
export function verifyPersonalLibraryAnswer(
  input: PersonalLibraryAnswerVerificationInput
): PersonalLibraryAnswerVerification {
  if (input.requiredSourcePaths.length === 0) {
    return {
      kind: 'unknown',
      evidence: { reason: 'no_required_sources' },
      requiredSourcesRead: [],
      requiredSourcesMissing: [],
      citedSources: [],
      outOfScopeReads: [],
      fabricatedMarkers: [],
      absentMarkersAsserted: [],
      insufficientEvidenceStated: false,
    }
  }
  const read = new Set(input.readPaths.map((path) => normalizePath(path)))
  const requiredSourcesRead: string[] = []
  const requiredSourcesMissing: string[] = []
  for (const path of input.requiredSourcePaths) {
    if (read.has(normalizePath(path))) requiredSourcesRead.push(path)
    else requiredSourcesMissing.push(path)
  }
  const citedSources = input.requiredSourcePaths.filter((path) => {
    const normalized = normalizePath(path)
    const base = normalized.slice(normalized.lastIndexOf('/') + 1)
    return input.replyText.includes(path) || (base !== '' && input.replyText.includes(base))
  })
  const outOfScopeReads = input.readPaths.filter((path) => !withinRoot(path, input.libraryRoot))
  const markerPattern = /LGLIB-[A-Z0-9-]{3,}/g
  const mentioned = new Set(input.replyText.match(markerPattern) ?? [])
  const allowed = new Set(input.allowedFactMarkers)
  const fabricatedMarkers = [...mentioned].filter((marker) => !allowed.has(marker)).sort()
  const absentMarkersAsserted = (input.absentFactMarkers ?? []).filter((marker) => mentioned.has(marker))
  const phrases = input.insufficientEvidencePhrases ?? []
  const insufficientEvidenceStated = !input.expectsInsufficientEvidence ||
    phrases.some((phrase) => input.replyText.includes(phrase))
  const evidence = {
    requiredSourceCount: input.requiredSourcePaths.length,
    requiredSourcesRead: requiredSourcesRead.length,
    requiredSourcesMissing: requiredSourcesMissing.length,
    citedSourceCount: citedSources.length,
    outOfScopeReadCount: outOfScopeReads.length,
    fabricatedMarkerCount: fabricatedMarkers.length,
    absentMarkerAssertedCount: absentMarkersAsserted.length,
    insufficientEvidenceStated,
    realReadCount: input.readPaths.length,
  }
  const base = {
    requiredSourcesRead,
    requiredSourcesMissing,
    citedSources,
    outOfScopeReads,
    fabricatedMarkers,
    absentMarkersAsserted,
    insufficientEvidenceStated,
  }
  if (input.readPaths.length === 0) {
    return { kind: input.replyText.trim() === '' ? 'unknown' : 'not_done', evidence: { ...evidence, reason: 'no_real_read' }, ...base }
  }
  const done = requiredSourcesMissing.length === 0 && citedSources.length >= 1 &&
    fabricatedMarkers.length === 0 && absentMarkersAsserted.length === 0 &&
    outOfScopeReads.length === 0 && insufficientEvidenceStated
  return { kind: done ? 'done' : 'not_done', evidence, ...base }
}

// ---------------------------------------------------------------------------
// 兼容：从 ContextPacket 取紧凑视图
// ---------------------------------------------------------------------------

export function packetSkillUsageView(packet: ContextPacket): SkillUsagePacketView {
  return {
    sections: packet.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      content: section.content,
      ...(section.sourceRefs !== undefined ? { sourceRefs: section.sourceRefs } : {}),
    })),
    droppedSectionIds: packet.droppedSectionIds,
    text: packet.text,
  }
}

/** 便于门与装配层：把 `TurnContent` 列表变成"真实内容 id"。 */
export function turnContentIdsOf(contents: readonly TurnContent[]): readonly string[] {
  return [...new Set(contents.map((content) => content.contentId))].sort()
}
