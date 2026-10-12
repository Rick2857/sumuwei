/**
 * M11 证据纪律 —— runId / 运行目录 / 清单（`m11-manifest@1`）。
 *
 * ============================================================================
 *  这份模块抄的是谁的作业、为什么
 * ============================================================================
 * 通用算法（稳定序列化 / 清单自摘要 / 原子晋升）**复用**
 * `scripts/m6.1-evidence.ts` 的既有实现 —— 「一个概念一处实现」；
 * 本文件只提供 **M11 品牌层**：runId 形状、运行目录父目录、清单契约版本与必填字段。
 * 品牌层的先例是 `scripts/m7-evidence.ts` / `m8-evidence.ts` / `m9-evidence.ts` /
 * `m10-evidence.ts`（同一个理由，逐字同构）。
 *
 * ⚠️ `L-M61-14` 的教训在这里被当作**设计输入**（与 M7/M8/M9/M10 相同）：
 *   M6.1 的 live 运行器写的 manifest 是简化 schema，晚于 WP2 时代的聚合器契约
 *   ⇒ `m6.1:gates` 对那些 run 一律 REFUSED。因此 M11 从**第一个运行器**起就
 *   emit 全字段清单；`m11:gates`（WP11）只需要按 `m11-manifest@1` 校验。
 *
 * ⚠️ `M10_INJECTION` 那条教训（M10 WP11 的**证据档缺陷**）在这里**继承**：
 *   量具负控会故意注入缺陷、跑门、再字节还原，而那次"注入态"运行会照常写一份
 *   FAIL 证据档 —— 与被测门**真正的** FAIL 档在盘上完全同形。
 *   ⇒ 修法同 M10：**唯一写清单的地方**把注入标记记进清单，读证据的人可以分列。
 *   M11 的值具名 `M11_INJECTION`。
 *
 * 硬边界（与 M6.1/M7/M8/M9/M10 相同，判据不是注释）：
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
// runId：`m11-<wp>[-<sub>…]-<YYYYMMDD>-<headShort12>-<suffix4>`
// ---------------------------------------------------------------------------

/** 例：`m11-wp0-20261001-b368c5577208-a1b2`（后缀 4 位 hex ⇒ 同 HEAD 同日也不覆盖）。 */
export const M11_RUN_ID_PATTERN =
  /^m11-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-[0-9a-f]{12}-[0-9a-f]{4}$/

export function assertValidM11RunId(runId: string): void {
  if (!M11_RUN_ID_PATTERN.test(runId)) {
    throw new RunIdInvalidError(
      `runId 形状非法：${JSON.stringify(runId)}（要求 ${String(M11_RUN_ID_PATTERN)}）`,
    )
  }
}

/** M11 运行目录的父目录（仓库相对路径）。 */
export const M11_RUN_PARENT = 'artifacts/m11'

export function createM11RunId(input: {
  /** 工作包 id，例如 `wp0` / `wp9` */
  readonly wpId: string
  /** 候选提交短 hash（任意写法，会被归一化） */
  readonly headShort: string
  /** 注入时钟以便测试确定性；缺省 = now */
  readonly now?: Date
  /** 注入后缀以便测试确定性；缺省 = 2 字节随机 */
  readonly suffix?: string
}): string {
  // 与 m6.1/m7/m8/m9/m10 同一条纪律：不做静默归一化，非法 wpId 直接抛。
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
  const runId = `m11-${wp}-${date}-${head}-${suffix}`
  assertValidM11RunId(runId)
  return runId
}

/** `--out` 只接受 `artifacts/m11/<runId>` 这一种形状（运行目录的形状是判据的一部分）。 */
export function runIdFromM11OutPath(root: string, out: string): string {
  const abs = resolve(root, out)
  const parent = resolve(root, M11_RUN_PARENT)
  const runId = basename(abs)
  if (resolve(abs, '..') !== parent) {
    throw new RunIdInvalidError(
      `--out 必须是 ${M11_RUN_PARENT}/<runId>（收到 ${out}）—— 不允许放到别处`,
    )
  }
  assertValidM11RunId(runId)
  return runId
}

/** 建立一次新运行：父目录可不存在，runId 目录已存在 ⇒ 抛（绝不复用）。 */
export function openM11RunDir(root: string, runId: string, parentRelative: string = M11_RUN_PARENT): string {
  assertValidM11RunId(runId)
  /*
   * ⚠️ `parentRelative` 是**可选**的追加参数（缺省仍是 `artifacts/m11` ⇒ M11 各门行为逐字不变）。
   *    加它的原因：M10.1 的证据属于 `artifacts/m10.1/`，而"运行目录的形状是判据的一部分"
   *    ⇒ 与其复制一份助手（会漂），不如让**同一个实现**接受一个显式的父目录。
   */
  const parent = join(root, parentRelative)
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
// 清单契约：m11-manifest@1（第一天就是全字段 —— L-M61-14 的教训）
// ---------------------------------------------------------------------------

export const M11_MANIFEST_VERSION = 'm11-manifest@1'

/**
 * 必填字段。每个 M11 运行器（wp0-verify / 未来的 test·verify·live）emit 的
 * manifest 必须齐这组字段，`m11:gates`（WP11）才认。
 *
 * 字段语义（与 m6.1/m7/m8/m9/m10-manifest@1 逐字段同构）：
 *   schemaVersion  恒为 'm11-manifest@1'
 *   runId / wp / head / headShort / branch / date / toolVersions —— 运行身份
 *   testType       这份证据测的是什么（'baseline' / 'prerequisite' / …）
 *   counts         { total, passed, failed } —— 计数型自检的分母必须 > 0（AGENTS §6.8）
 *   phases         本次运行覆盖的阶段（如 ['before'] / ['before','after'] / ['single']）
 *   supersedes     被本次运行取代的旧 runId（无则 null，不是省略）
 *   payloadSha256  清单自摘要（由 sealManifest 添加；校验时重算比对）
 */
export const M11_MANIFEST_REQUIRED_FIELDS: readonly string[] = [
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
  'payloadSha256',
]

export interface M11ManifestProblem {
  readonly field: string
  readonly problem: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验一份 manifest 是否满足 `m11-manifest@1`（缺字段 / 类型错 / 摘要不符都算问题）。 */
export function validateM11Manifest(manifest: unknown): M11ManifestProblem[] {
  const problems: M11ManifestProblem[] = []
  if (!isRecord(manifest)) {
    return [{ field: '(root)', problem: 'manifest 不是 JSON 对象' }]
  }
  for (const field of M11_MANIFEST_REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      problems.push({ field, problem: '必填字段缺失' })
    }
  }
  if (manifest.schemaVersion !== M11_MANIFEST_VERSION) {
    problems.push({
      field: 'schemaVersion',
      problem: `必须是 ${M11_MANIFEST_VERSION}（收到 ${JSON.stringify(manifest.schemaVersion)}）`,
    })
  }
  if (typeof manifest.runId === 'string') {
    try {
      assertValidM11RunId(manifest.runId)
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
 * ⚠️ 注入档标记：子进程 env 里有 `M11_INJECTION=<id>` ⇒ 在这里（**唯一**写清单的
 * 地方）把它记进清单 —— 与 `m10-evidence.ts` 同一条修法，理由见文件头。
 */
export function writeM11Manifest(runDir: string, manifest: Record<string, unknown>): string {
  const injection = process.env.M11_INJECTION
  const sealed = sealManifest({
    ...manifest,
    schemaVersion: M11_MANIFEST_VERSION,
    ...(typeof injection === 'string' && injection !== '' ? { injection } : {}),
  })
  const problems = validateM11Manifest(sealed)
  if (problems.length > 0) {
    throw new Error(
      `manifest 不满足 ${M11_MANIFEST_VERSION}：\n` +
        problems.map((p) => `  · ${p.field}: ${p.problem}`).join('\n'),
    )
  }
  return writeManifestAtomic(runDir, sealed)
}

// 供脚本复用的重导出（避免每个 M11 脚本各自 import m6.1 命名空间）
export { MANIFEST_FILE, stableStringify, writeManifestAtomic }
