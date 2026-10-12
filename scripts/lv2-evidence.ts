/**
 * Lv2 证据纪律 —— runId / 运行目录 / 清单（`lv2-manifest@1`）。
 *
 * ============================================================================
 *  为什么有这个文件（而不是每个脚本各写一份清单）
 * ============================================================================
 * 通用算法（稳定序列化 / 清单自摘要 / 原子晋升）**复用**
 * `scripts/m6.1-evidence.ts` 的既有实现 —— 「一个概念一处实现」；
 * 本文件只提供 **Lv2 品牌层**：runId 形状、运行目录父目录、清单契约版本与必填字段。
 * 品牌层的先例是 `scripts/m7-evidence.ts` / `m8-evidence.ts` / `m9-evidence.ts` /
 * `m10-evidence.ts` / `m11-evidence.ts`（同一个理由，逐字同构）。
 *
 * ⚠️ 本契约的字段表**不是**这里自己想的：它逐条对应
 *    [`docs/lv2/Lv2-Acceptance-Plan.md`](../docs/lv2/Lv2-Acceptance-Plan.md) §11.1 的
 *    manifest 要求（HEAD/工作树、契约/语料/gold/评分器与源指纹、配置、
 *    模型非机密标识、计划/实际请求数、完整分母、case/conversation/request/trace 关联、
 *    起止时刻、故障注入声明、cleanClose 及真库源摘要）。
 *
 * ⚠️ `L-M61-14` 的教训（M6.1 的 live 运行器写的 manifest 晚于聚合器契约 ⇒ 一律 REFUSED）
 *    在这里被当作**设计输入**：Lv2 从**第一个**运行器（WP0）起就 emit 全字段清单，
 *    不适用的字段写 **显式 `null` + 具名理由**，**不许省略**
 *    （先例：`m11-manifest@1` 的 `supersedes: null`）。
 *
 * 硬边界（与 M6.1/M7/M8/M9/M10/M11 相同，判据不是注释）：
 *   · runId 目录**拒绝覆盖**（已存在 ⇒ 抛，绝不复用 —— TD-04①）；
 *   · 清单**原子晋升**（`.manifest.tmp` → rename；只有 `manifest.json` 在才算完整）；
 *   · `payloadSha256` 是去掉自身后的稳定摘要 ⇒ 「清单被事后改过」可机器判定。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  MANIFEST_FILE,
  RunDirExistsError,
  RunIdInvalidError,
  computeManifestPayloadSha256,
  normalizeHeadShort,
  sealManifest,
  stableStringify,
  writeManifestAtomic,
} from './m6.1-evidence.ts'

// ---------------------------------------------------------------------------
// runId：`lv2-<wp>[-<sub>…]-<YYYYMMDD>-<headShort12>-<suffix4>`
// ---------------------------------------------------------------------------

/** 例：`lv2-wp0-20261002-0b0bfac5d97e-a1b2`（后缀 4 位 hex ⇒ 同 HEAD 同日也不覆盖）。 */
export const LV2_RUN_ID_PATTERN = /^lv2-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-[0-9a-f]{12}-[0-9a-f]{4}$/

export function assertValidLv2RunId(runId: string): void {
  if (!LV2_RUN_ID_PATTERN.test(runId)) {
    throw new RunIdInvalidError(
      `runId 形状非法：${JSON.stringify(runId)}（要求 ${String(LV2_RUN_ID_PATTERN)}）`,
    )
  }
}

/** Lv2 运行目录的父目录（仓库相对路径）。机器证据进仓库；`local/` 不进（见 .gitignore）。 */
export const LV2_RUN_PARENT = 'artifacts/lv2'

/** 人审材料 / 真实对话正文的父目录 —— **必须**先被 `.gitignore` 挡住（机器闸在写正文前跑 `git check-ignore`）。 */
export const LV2_LOCAL_PARENT = 'artifacts/lv2/local'

export function createLv2RunId(input: {
  /** 工作包 id，例如 `wp0` / `wp4` */
  readonly wpId: string
  /** 候选提交短 hash（任意写法，会被归一化） */
  readonly headShort: string
  /** 注入时钟以便测试确定性；缺省 = now */
  readonly now?: Date
  /** 注入后缀以便测试确定性；缺省 = 2 字节随机 */
  readonly suffix?: string
}): string {
  // 与 m6.1/m7/m8/m9/m10/m11 同一条纪律：不做静默归一化，非法 wpId 直接抛。
  const wp = input.wpId.toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(wp)) {
    throw new RunIdInvalidError(
      `wpId 非法：${JSON.stringify(input.wpId)}（只允许 [a-z0-9] 与内部连字符；不做静默替换）`,
    )
  }
  const head = normalizeHeadShort(input.headShort)
  const date = (input.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '')
  const suffix = (input.suffix ?? randomBytes(2).toString('hex')).toLowerCase()
  if (!/^[0-9a-f]{4}$/.test(suffix)) {
    throw new RunIdInvalidError(`后缀必须是 4 位 hex：${JSON.stringify(input.suffix)}`)
  }
  const runId = `lv2-${wp}-${date}-${head}-${suffix}`
  assertValidLv2RunId(runId)
  return runId
}

/** `--out` 只接受 `artifacts/lv2/<runId>` 这一种形状（运行目录的形状是判据的一部分）。 */
export function runIdFromLv2OutPath(root: string, out: string): string {
  const abs = resolve(root, out)
  const parent = resolve(root, LV2_RUN_PARENT)
  const runId = basename(abs)
  if (resolve(abs, '..') !== parent) {
    throw new RunIdInvalidError(
      `--out 必须是 ${LV2_RUN_PARENT}/<runId>（收到 ${out}）—— 不允许放到别处`,
    )
  }
  assertValidLv2RunId(runId)
  return runId
}

/** 建立一次新运行：父目录可不存在，runId 目录已存在 ⇒ 抛（绝不复用）。 */
export function openLv2RunDir(root: string, runId: string): string {
  assertValidLv2RunId(runId)
  const parent = join(root, LV2_RUN_PARENT)
  mkdirSync(parent, { recursive: true })
  const dir = join(parent, runId)
  if (existsSync(dir)) {
    throw new RunDirExistsError(`runId 目录已存在，拒绝覆盖（TD-04①）：${dir}`)
  }
  try {
    mkdirSync(dir, { recursive: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RunDirExistsError(`runId 目录已存在，拒绝覆盖（TD-04①）：${dir}`)
    }
    throw error
  }
  return dir
}

// ---------------------------------------------------------------------------
// 清单契约：lv2-manifest@1（第一天就是全字段 —— L-M61-14 的教训）
// ---------------------------------------------------------------------------

export const LV2_MANIFEST_VERSION = 'lv2-manifest@1'

/**
 * 必填字段（逐条对应 Lv2 计划 §11.1 的清单要求）。
 *
 * 字段语义：
 *   schemaVersion      恒为 'lv2-manifest@1'
 *   runId / wp / head / headShort / branch / date / toolVersions  运行身份
 *   testType           这份证据测的是什么（'wp0-baseline' / 'short-scenario' / 'mixed-trajectory' / …）
 *   counts             { total, passed, failed } —— 计数型自检的分母必须 > 0（AGENTS §6.8）
 *   phases             本次运行覆盖的阶段（如 ['single'] / ['before','after']）
 *   supersedes         被本次运行取代的旧 runId（无则 **null**，不是省略）
 *   started / ended    起止时刻（ISO 8601）
 *   worktree           候选工作树：干净与否、改动路径、未跟踪路径
 *   sourceFingerprints 源码/契约/gold/评分器指纹（非空记录）
 *   config             本次运行实际生效的配置（**不含 key**）
 *   model              模型非机密标识（endpoint host / model 名 / key 只报存在与长度）
 *   requests           { planned, actual } 模型请求数（计划/实际；actual ≤ planned）
 *   denominators       完整分母（每个判据的分母，含 0 的显式记录）
 *   correlations       { cases, conversations, requests, traces } 关联计数
 *   faultInjection     故障注入声明（无则 **null**）
 *   cleanClose         关闭结局（BOOL；未打开数据库的场景写 **null** + realDb.note 说明）
 *   realDb             真实库读数 { opened, summaryBefore, summaryAfter, note }
 *   payloadSha256      清单自摘要（由 sealManifest 添加；校验时重算比对）
 */
export const LV2_MANIFEST_REQUIRED_FIELDS: readonly string[] = [
  'schemaVersion',
  'runId',
  'wp',
  'head',
  'headShort',
  'branch',
  'date',
  'toolVersions',
  'testType',
  'counts',
  'phases',
  'supersedes',
  'started',
  'ended',
  'worktree',
  'sourceFingerprints',
  'config',
  'model',
  'requests',
  'denominators',
  'correlations',
  'faultInjection',
  'cleanClose',
  'realDb',
  'payloadSha256',
]

export interface Lv2ManifestProblem {
  readonly field: string
  readonly problem: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验一份 manifest 是否满足 `lv2-manifest@1`（缺字段 / 类型错 / 摘要不符都算问题）。 */
export function validateLv2Manifest(manifest: unknown): Lv2ManifestProblem[] {
  const problems: Lv2ManifestProblem[] = []
  if (!isRecord(manifest)) {
    return [{ field: '(root)', problem: 'manifest 不是 JSON 对象' }]
  }
  for (const field of LV2_MANIFEST_REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      problems.push({ field, problem: '必填字段缺失（不适用的字段要写显式 null，不许省略）' })
    }
  }
  if (manifest.schemaVersion !== LV2_MANIFEST_VERSION) {
    problems.push({
      field: 'schemaVersion',
      problem: `必须是 ${LV2_MANIFEST_VERSION}（收到 ${JSON.stringify(manifest.schemaVersion)}）`,
    })
  }
  if (typeof manifest.runId === 'string') {
    try {
      assertValidLv2RunId(manifest.runId)
    } catch (error) {
      problems.push({ field: 'runId', problem: (error as Error).message })
    }
  }
  if (!isRecord(manifest.counts)) {
    problems.push({ field: 'counts', problem: 'counts 必须是对象 { total, passed, failed }' })
  } else {
    for (const key of ['total', 'passed', 'failed'] as const) {
      if (!Number.isInteger(manifest.counts[key])) {
        problems.push({ field: `counts.${key}`, problem: '必须是整数' })
      }
    }
    if (Number(manifest.counts.total) <= 0) {
      problems.push({
        field: 'counts.total',
        problem: '分母必须 > 0（0 检查 0 失败 = MEASUREMENT INVALID，不是 PASS —— AGENTS §6.8）',
      })
    }
  }
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) {
    problems.push({ field: 'phases', problem: 'phases 必须是非空数组' })
  }
  if (manifest.supersedes !== null && typeof manifest.supersedes !== 'string') {
    problems.push({ field: 'supersedes', problem: '必须是 runId 字符串或 null（不许省略）' })
  }
  if (!isRecord(manifest.worktree) || typeof manifest.worktree.clean !== 'boolean') {
    problems.push({ field: 'worktree', problem: '必须是对象且带布尔 clean' })
  }
  if (!isRecord(manifest.sourceFingerprints) || Object.keys(manifest.sourceFingerprints).length === 0) {
    problems.push({ field: 'sourceFingerprints', problem: '必须是非空对象（至少一个源指纹）' })
  }
  if (!isRecord(manifest.config)) {
    problems.push({ field: 'config', problem: '必须是对象' })
  }
  if (!isRecord(manifest.model)) {
    problems.push({ field: 'model', problem: '必须是对象（非机密标识）' })
  }
  if (!isRecord(manifest.requests)) {
    problems.push({ field: 'requests', problem: '必须是对象 { planned, actual }' })
  } else {
    for (const key of ['planned', 'actual'] as const) {
      if (!Number.isInteger(manifest.requests[key]) || Number(manifest.requests[key]) < 0) {
        problems.push({ field: `requests.${key}`, problem: '必须是非负整数' })
      }
    }
    if (
      Number(manifest.requests.actual) > Number(manifest.requests.planned) &&
      Number.isInteger(manifest.requests.planned)
    ) {
      problems.push({ field: 'requests.actual', problem: 'actual 不能大于 planned' })
    }
  }
  if (!isRecord(manifest.denominators)) {
    problems.push({ field: 'denominators', problem: '必须是对象（完整分母，含显式 0）' })
  }
  if (!isRecord(manifest.correlations)) {
    problems.push({ field: 'correlations', problem: '必须是对象（cases/conversations/requests/traces）' })
  }
  if (manifest.faultInjection !== null && typeof manifest.faultInjection !== 'string') {
    problems.push({ field: 'faultInjection', problem: '必须是字符串或 null' })
  }
  if (manifest.cleanClose !== null && typeof manifest.cleanClose !== 'boolean') {
    problems.push({ field: 'cleanClose', problem: '必须是布尔或 null（null 需要 realDb.note 说明理由）' })
  }
  if (!isRecord(manifest.realDb) || typeof manifest.realDb.opened !== 'boolean') {
    problems.push({ field: 'realDb', problem: '必须是对象且带布尔 opened' })
  }
  if (typeof manifest.payloadSha256 === 'string') {
    const recomputed = computeManifestPayloadSha256(manifest)
    if (recomputed !== manifest.payloadSha256) {
      problems.push({ field: 'payloadSha256', problem: '摘要不符（清单被事后改过？）' })
    }
  }
  return problems
}

/**
 * 校验 + 封印 + 原子写。返回 manifest.json 的绝对路径。
 *
 * ⚠️ 注入档标记：子进程 env 里有 `LV2_INJECTION=<id>` ⇒ 在这里（**唯一**写清单的
 *    地方）把它记进清单 —— 与 `m10-evidence.ts` / `m11-evidence.ts` 同一条修法：
 *    量具负控会注入缺陷跑一遍并留档，那一档必须能被读者分列出来。
 */
export function writeLv2Manifest(runDir: string, manifest: Record<string, unknown>): string {
  const injection = process.env.LV2_INJECTION
  const sealed = sealManifest({
    ...manifest,
    schemaVersion: LV2_MANIFEST_VERSION,
    ...(typeof injection === 'string' && injection !== '' ? { injection } : {}),
  })
  const problems = validateLv2Manifest(sealed)
  if (problems.length > 0) {
    throw new Error(
      `manifest 不满足 ${LV2_MANIFEST_VERSION}：\n` +
        problems.map((p) => `  · ${p.field}: ${p.problem}`).join('\n'),
    )
  }
  return writeManifestAtomic(runDir, sealed)
}

// 供脚本复用的重导出（避免每个 Lv2 脚本各自 import m6.1 命名空间）
export { MANIFEST_FILE, stableStringify, writeManifestAtomic }
