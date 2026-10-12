/**
 * M9.5 证据纪律 —— runId / 运行目录 / 清单（`m9.5-manifest@1`）。
 *
 * ============================================================================
 *  这份模块抄的是谁的作业、为什么
 * ============================================================================
 * 通用算法（稳定序列化 / 清单自摘要 / 原子晋升 / runId 目录拒绝覆盖）**复用**
 * `scripts/m6.1-evidence.ts` 的既有实现 —— 「一个概念一处实现」；
 * 本文件只提供 **M9.5 品牌层**：runId 形状、运行目录父目录、清单契约版本与必填字段。
 * 品牌层的先例是 `scripts/m7-evidence.ts` / `scripts/m8-evidence.ts` / `scripts/m9-evidence.ts`
 * （同一条理由：通用算法不重写，只换品牌与契约版本）。
 *
 * ⚠️ L-M61-14 的教训照旧当**设计输入**：M6.1 的 live 运行器写的是简化 manifest，
 *    晚于 WP2 时代的聚合器契约 ⇒ `m6.1:gates` 对那些 run 一律 REFUSED。
 *    因此 M9.5 **从第一个运行器（WP0 基线）起**就 emit 全字段清单；
 *    `m9.5:gates` 只按 `m9.5-manifest@1` 校验。
 *
 * ⚠️ 与 M9/M9.1 的一处**刻意的差别**（计划 §16.3）：
 *    M9 的 manifest 必填集是「运行身份 + counts/phases」；M9.5 的 §16.3 要求
 *    「dbKind / isolationProof / measuredCount / notRunCount / completion / usable」
 *    也进必填集 —— 因为 M9.5 的核心风险是「读的是副本还是真库」「零测量冒充 PASS」
 *    「未跑的档冒充已跑」。这些字段是那三条风险的机器判据，不能等到某个门才补。
 *
 * ============================================================================
 *  必填 vs 可选（为什么要分成两组）
 * ============================================================================
 * **必填**（每个 run 都能如实声明，与是否接模型/是否开库无关）：
 *   schemaVersion / runId / stage / lane / startedAt / completedAt / head / headShort
 *   / branch / dirtyPaths / sourceTreeHash / gateVersion / dbKind / isolationProof
 *   / configHash / command / exitCode / completion / usable / measuredCount
 *   / notRunCount / counts / toolVersions / supersedes / payloadSha256
 *
 * **可选**（只在**确实存在该事物**时出现；出现即按类型校验，不许写半截）：
 *   corpusHash / split / modelFingerprint / replyModelHostAndName / tokenizer
 *   / rendererVersion / retrievalPolicyVersion / generationId / sourceSnapshot
 *   / namespaceScope / metricsWithDenominators / caseResults / failureReasons
 *   / artifactHashes
 *
 * ⚠️ 这条划分本身是**拟议**（计划 §16.3 的字段表 + 本模块的落法），
 *    WP2 冻结验收契约时**可以**扩展必填集；扩展必须走这一处，
 *    不能让每个运行器各自决定"哪些字段算数"（那就是 L-M61-14 的复发形态）。
 *
 * 硬边界（与 M6.1/M7/M8/M9 相同，判据不是注释）：
 *   · runId 目录**拒绝覆盖**（已存在 ⇒ 抛，绝不复用 —— TD-04①）；
 *   · 清单**原子晋升**（`.manifest.tmp` → rename；只有 `manifest.json` 在才算完整）；
 *   · `payloadSha256` 是去掉自身后的稳定摘要 ⇒ 「清单被事后改过」可机器判定；
 *   · `usable === true` 而 `measuredCount <= 0` ⇒ **拒写**（AGENTS §6.8：
 *     0 检查 0 失败 = MEASUREMENT INVALID，不是 PASS）。
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
// runId：`m9.5-<wp>[-<sub>…]-<YYYYMMDD>-<headShort12>-<suffix4>`
// ---------------------------------------------------------------------------

/** 例：`m9.5-wp0-20260928-40ec16e56690-a1b2`（后缀 4 位 hex ⇒ 同 HEAD 同日也不覆盖）。 */
export const M95_RUN_ID_PATTERN =
  /^m9\.5-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-[0-9a-f]{12}-[0-9a-f]{4}$/

export function assertValidM95RunId(runId: string): void {
  if (!M95_RUN_ID_PATTERN.test(runId)) {
    throw new RunIdInvalidError(
      `runId 形状非法：${JSON.stringify(runId)}（要求 ${String(M95_RUN_ID_PATTERN)}）`,
    )
  }
}

/** M9.5 运行目录的父目录（仓库相对路径）。 */
export const M95_RUN_PARENT = 'artifacts/m9.5'

/** M9.5 的「私人正文 / 人工材料」目录（已 ignore；写正文前必须 `git check-ignore` 验过）。 */
export const M95_LOCAL_PARENT = 'artifacts/m9.5/local'

export function createM95RunId(input: {
  /** 工作包 id，例如 `wp0` / `wp1` / `wp9-scale` */
  readonly wpId: string
  /** 候选提交短 hash（任意写法，会被归一化） */
  readonly headShort: string
  /** 注入时钟以便测试确定性；缺省 = now */
  readonly now?: Date
  /** 注入后缀以便测试确定性；缺省 = 2 字节随机 */
  readonly suffix?: string
}): string {
  // 与 m6.1/m7/m8/m9 同一条纪律：不做静默归一化，非法 wpId 直接抛。
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
  const runId = `m9.5-${wp}-${date}-${head}-${suffix}`
  assertValidM95RunId(runId)
  return runId
}

/** `--out` 只接受 `artifacts/m9.5/<runId>` 这一种形状（运行目录的形状是判据的一部分）。 */
export function runIdFromM95OutPath(root: string, out: string): string {
  const abs = resolve(root, out)
  const parent = resolve(root, M95_RUN_PARENT)
  const runId = basename(abs)
  if (resolve(abs, '..') !== parent) {
    throw new RunIdInvalidError(
      `--out 必须是 ${M95_RUN_PARENT}/<runId>（收到 ${out}）—— 不允许放到别处`,
    )
  }
  assertValidM95RunId(runId)
  return runId
}

/** 建立一次新运行：父目录可不存在，runId 目录已存在 ⇒ 抛（绝不复用）。 */
export function openM95RunDir(root: string, runId: string): string {
  assertValidM95RunId(runId)
  const parent = join(root, M95_RUN_PARENT)
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
// 清单契约：m9.5-manifest@1（第一天就是全字段 —— L-M61-14 的教训）
// ---------------------------------------------------------------------------

export const M95_MANIFEST_VERSION = 'm9.5-manifest@1'

/** 工作包 id（计划 §12 的 WP0–WP12；`stage` 字段的取值域）。 */
export const M95_STAGES: readonly string[] = [
  'wp0',
  'wp1',
  'wp2',
  'wp3',
  'wp4',
  'wp5',
  'wp6',
  'wp7',
  'wp8',
  'wp9',
  'wp10',
  'wp11',
  'wp12',
]

/**
 * 运行通道（`lane` 的取值域）。
 *
 *   offline  = 无真实模型、无真实库（隔离库 / 纯契约）
 *   live     = 真实回复模型或真实编码器（仍不开真实库，除生产副本档）
 *   release  = 发布档：串行、无缓存、干净树（计划 §16.1 末段）
 */
export const M95_LANES: readonly string[] = ['offline', 'live', 'release']

/**
 * 数据库身份（`dbKind` 的取值域）。
 *
 *   synthetic        = `isolateDatabase()` 沙箱（**默认**；全部 WP0–WP11 离线档）
 *   production-copy  = 真实库的**副本**（计划 §20 的预演档）
 *   production       = 真实库本体（**只**允许 WP12 且需当轮显式授权）
 *   not-applicable    = 本 run 不碰任何数据库（纯契约 / 纯文档门）
 */
export const M95_DB_KINDS: readonly string[] = [
  'synthetic',
  'production-copy',
  'production',
  'not-applicable',
]

/** 完成度（`completion` 的取值域）。 */
export const M95_COMPLETIONS: readonly string[] = [
  'complete',
  'partial',
  'aborted',
  'not-run',
]

/**
 * 必填字段。每个 M9.5 运行器 emit 的 manifest 必须齐这组字段，`m9.5:gates` 才认。
 *
 * 字段语义（对计划 §16.3 的字段表逐条落地）：
 *   schemaVersion   恒为 'm9.5-manifest@1'
 *   runId / stage / lane / startedAt / completedAt / head / headShort / branch
 *                   —— 运行身份与时间窗
 *   dirtyPaths      运行时的脏文件清单（**是事实，不是污染**；计划 §17.2 纪律）
 *   sourceTreeHash  源码树摘要（`sourceTreeReading` 的定义必须同时落盘）
 *   gateVersion     产出本证据的运行器版本（脚本自报）
 *   dbKind          见 `M95_DB_KINDS`
 *   isolationProof  「本 run 没有打开真实库」的**程序事实**（不是自我声明）
 *   configHash      非机密功能配置指纹（**任何取值不进证据**，计划 §16.3 末段）
 *   command         实际执行的命令 + exitCode
 *   exitCode        进程退出码
 *   completion      见 `M95_COMPLETIONS`
 *   usable          这份读数**能不能当证据用**（false 时 aggregator 必须降档）
 *   measuredCount   实际测到的**非空**条目数（AGENTS §6.8）
 *   notRunCount     声明了但**没跑**的档位数（不许用 0 冒充"全跑了"）
 *   counts          { total, passed, failed } —— 与 measuredCount 分开记
 *   toolVersions    node / platform / arch / git
 *   supersedes      被本次运行取代的旧 runId（无则 null，不是省略）
 *   payloadSha256   清单自摘要（由 sealManifest 添加；校验时重算比对）
 */
export const M95_MANIFEST_REQUIRED_FIELDS: readonly string[] = [
  'schemaVersion',
  'runId',
  'stage',
  'lane',
  'startedAt',
  'completedAt',
  'head',
  'headShort',
  'branch',
  'dirtyPaths',
  'sourceTreeHash',
  'sourceTreeHashDefinition',
  'gateVersion',
  'dbKind',
  'isolationProof',
  'configHash',
  'command',
  'exitCode',
  'completion',
  'usable',
  'measuredCount',
  'notRunCount',
  'counts',
  'toolVersions',
  'supersedes',
  'payloadSha256',
]

/**
 * 可选字段（存在才校验；**不许**用 `null` 冒充"有这个字段但不知道值"）。
 *
 * 这条纪律来自 M9.5 的一处具体风险：`modelFingerprint` 若写成 `null`，
 * 聚合器无法区分「本 run 没接模型」与「接了模型但没记指纹」——
 * 前者应该**省略字段**，后者应该**报错**。
 */
export const M95_MANIFEST_OPTIONAL_FIELDS: readonly string[] = [
  'corpusHash',
  'split',
  'modelFingerprint',
  'replyModelHostAndName',
  'tokenizer',
  'rendererVersion',
  'retrievalPolicyVersion',
  'generationId',
  'sourceSnapshot',
  'namespaceScope',
  'metricsWithDenominators',
  'caseResults',
  'failureReasons',
  'artifactHashes',
]

export interface M95ManifestProblem {
  readonly field: string
  readonly problem: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0
}

/** 校验一份 manifest 是否满足 `m9.5-manifest@1`（缺字段 / 类型错 / 摘要不符都算问题）。 */
export function validateM95Manifest(manifest: unknown): M95ManifestProblem[] {
  const problems: M95ManifestProblem[] = []
  if (!isRecord(manifest)) {
    return [{ field: '(root)', problem: 'manifest 不是 JSON 对象' }]
  }
  for (const field of M95_MANIFEST_REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      problems.push({ field, problem: '必填字段缺失' })
    }
  }
  if (manifest.schemaVersion !== M95_MANIFEST_VERSION) {
    problems.push({
      field: 'schemaVersion',
      problem: `必须是 ${M95_MANIFEST_VERSION}（收到 ${JSON.stringify(manifest.schemaVersion)}）`,
    })
  }
  if (typeof manifest.runId === 'string') {
    try {
      assertValidM95RunId(manifest.runId)
    } catch (error) {
      problems.push({ field: 'runId', problem: (error as Error).message })
    }
  }
  if (typeof manifest.stage === 'string' && !M95_STAGES.includes(manifest.stage)) {
    problems.push({
      field: 'stage',
      problem: `必须是 ${M95_STAGES.join(' / ')} 之一（收到 ${JSON.stringify(manifest.stage)}）`,
    })
  }
  if (typeof manifest.lane === 'string' && !M95_LANES.includes(manifest.lane)) {
    problems.push({
      field: 'lane',
      problem: `必须是 ${M95_LANES.join(' / ')} 之一（收到 ${JSON.stringify(manifest.lane)}）`,
    })
  }
  if (typeof manifest.dbKind === 'string' && !M95_DB_KINDS.includes(manifest.dbKind)) {
    problems.push({
      field: 'dbKind',
      problem: `必须是 ${M95_DB_KINDS.join(' / ')} 之一（收到 ${JSON.stringify(manifest.dbKind)}）`,
    })
  }
  if (
    typeof manifest.completion === 'string' &&
    !M95_COMPLETIONS.includes(manifest.completion)
  ) {
    problems.push({
      field: 'completion',
      problem: `必须是 ${M95_COMPLETIONS.join(' / ')} 之一（收到 ${JSON.stringify(manifest.completion)}）`,
    })
  }
  for (const field of ['head', 'headShort', 'branch', 'sourceTreeHash', 'sourceTreeHashDefinition', 'gateVersion'] as const) {
    if (field in manifest && !isNonEmptyString(manifest[field])) {
      problems.push({ field, problem: '必须是非空字符串（不许用 null / 空串占位）' })
    }
  }
  for (const field of ['isolationProof', 'configHash'] as const) {
    if (field in manifest && !isRecord(manifest[field])) {
      problems.push({ field, problem: '必须是对象（把"凭什么这么说"写进去，不是一句断言）' })
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
  }
  for (const field of ['measuredCount', 'notRunCount'] as const) {
    if (!isNonNegativeInteger(manifest[field])) {
      problems.push({
        field,
        problem: '必须是非负整数（AGENTS §6.8：计数型读数必须有分母）',
      })
    }
  }
  if (
    manifest.usable === true &&
    isNonNegativeInteger(manifest.measuredCount) &&
    (manifest.measuredCount as number) <= 0
  ) {
    problems.push({
      field: 'measuredCount',
      problem:
        'usable=true 而 measuredCount=0 —— 0 检查 0 失败 = MEASUREMENT INVALID，不是 PASS（AGENTS §6.8）',
    })
  }
  if (typeof manifest.usable !== 'boolean') {
    problems.push({ field: 'usable', problem: '必须是布尔（不是字符串 "true"）' })
  }
  if (!Array.isArray(manifest.dirtyPaths)) {
    problems.push({ field: 'dirtyPaths', problem: '必须是数组（无脏文件 ⇒ 空数组，不是省略）' })
  }
  if (!Array.isArray(manifest.command)) {
    problems.push({ field: 'command', problem: '必须是数组 [{ cmd, exitCode }]' })
  }
  if (!isRecord(manifest.toolVersions)) {
    problems.push({ field: 'toolVersions', problem: '必须是对象（node/platform/arch/git）' })
  }
  if (manifest.supersedes !== null && typeof manifest.supersedes !== 'string') {
    problems.push({ field: 'supersedes', problem: '必须是 runId 字符串或 null（不许省略）' })
  }
  if (typeof manifest.payloadSha256 === 'string') {
    const recomputed = computeManifestPayloadSha256(manifest)
    if (recomputed !== manifest.payloadSha256) {
      problems.push({ field: 'payloadSha256', problem: '摘要不符（清单被事后改过？）' })
    }
  }
  return problems
}

/** 校验 + 封印 + 原子写。返回 manifest.json 的绝对路径。 */
export function writeM95Manifest(runDir: string, manifest: Record<string, unknown>): string {
  const sealed = sealManifest({ ...manifest, schemaVersion: M95_MANIFEST_VERSION })
  const problems = validateM95Manifest(sealed)
  if (problems.length > 0) {
    throw new Error(
      `manifest 不满足 ${M95_MANIFEST_VERSION}：\n` +
        problems.map((p) => `  · ${p.field}: ${p.problem}`).join('\n'),
    )
  }
  return writeManifestAtomic(runDir, sealed)
}

/**
 * 计数自检（AGENTS §6.8 的**可复用**形态）。
 *
 * 「检查了 0 项、发现 0 处不一致」与「全部一致」在输出上长得一样 ——
 * 所以每个 M9.5 量具在给出 PASS 之前必须过这一关。
 */
export interface M95MeasurementSelfCheck {
  readonly measuredCount: number
  readonly notRunCount: number
  readonly verdict: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID'
  readonly reason: string
}

export function selfCheckMeasurement(input: {
  readonly measuredCount: number
  readonly notRunCount: number
  readonly failedCount: number
}): M95MeasurementSelfCheck {
  const { measuredCount, notRunCount, failedCount } = input
  if (measuredCount <= 0) {
    return {
      measuredCount,
      notRunCount,
      verdict: 'MEASUREMENT INVALID',
      reason:
        'measuredCount=0 —— 0 检查 0 失败与"全部一致"在输出上无法区分（AGENTS §6.8），不是 PASS',
    }
  }
  if (notRunCount > 0) {
    return {
      measuredCount,
      notRunCount,
      verdict: 'FAIL',
      reason: `notRunCount=${String(notRunCount)} —— 声明了却没跑的档位使本 run 不完整`,
    }
  }
  if (failedCount > 0) {
    return {
      measuredCount,
      notRunCount,
      verdict: 'FAIL',
      reason: `failedCount=${String(failedCount)}（分母 measuredCount=${String(measuredCount)}）`,
    }
  }
  return {
    measuredCount,
    notRunCount,
    verdict: 'PASS',
    reason: `${String(measuredCount)} 项全部测到，0 失败，0 未跑`,
  }
}

// 供脚本复用的重导出（避免每个 M9.5 脚本各自 import m6.1 命名空间）
export { MANIFEST_FILE, stableStringify, writeManifestAtomic }
