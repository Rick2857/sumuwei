/**
 * M9.5 WP3 —— **本地编码器的清单与资产校验**（D30）。
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 * ```text
 * ① **指纹不可变**（D30）：`revision` 必须是**不可变 commit sha**，不许写 `main` 这类可变引用
 *    —— 否则"同一个模型名"背后可能是不同的权重，而 generation 隔离会失去意义。
 * ② **资产可核对**：每个文件的字节数与 sha256 都要对得上；带 LFS 哈希的文件还要与
 *    **上游报告的** sha256 逐字相同（镜像一致性靠哈希，不靠"镜像可信"）。
 * ③ **失败关闭**：清单缺失、结构非法、资产缺失或不符 ⇒ **拒绝**，不自动下载、不转云
 *    （计划 §6.2：「模型缺失时如实降级，不临时改走云服务」）。
 * ```
 *
 * ⚠️ 本模块**不联网**、**不打开数据库**：它只读清单与本地资产。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface EmbeddingAsset {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** 上游报告的 LFS 哈希（有则必须与本地一致） */
  readonly upstreamLfsSha256?: string
}

export interface EmbeddingManifest {
  readonly manifestVersion: string
  readonly modelId: string
  readonly baseModel: string
  readonly revision: string
  readonly dtype: string
  readonly dimension: number
  readonly pooling: string
  readonly normalize: boolean
  readonly queryPrefix: string
  readonly passagePrefix: string
  readonly runtime: { readonly package: string; readonly version: string }
  readonly license: {
    readonly baseModel: string
    readonly conversionRepoDeclared: string | null
  }
  readonly source: { readonly mirror: string; readonly upstream: string }
  readonly assets: readonly EmbeddingAsset[]
}

/** 清单契约版本 —— 改结构时同步改这里，并让校验器认识新旧两版。 */
export const EMBEDDING_MANIFEST_VERSION = 'm9.5-embedding-manifest@1'

/** 默认清单位置（仓库内，可评审；只有哈希与元数据，无私人文本）。 */
export const DEFAULT_EMBEDDING_MANIFEST_PATH = 'evals/m9.5/embedding-manifest.json'

/** 可变引用的黑名单：它们**不能**充当冻结指纹（D30）。 */
const MUTABLE_REVISIONS: readonly string[] = ['main', 'master', 'latest', 'HEAD', 'refs/heads/main']

export function loadEmbeddingManifest(path: string): EmbeddingManifest {
  if (!existsSync(path)) {
    throw new Error(
      `编码器清单不存在：${path}\n` +
        '⇒ 失败关闭（**不**自动下载、**不**转云）。先按 WP3 的安装步骤取回资产并写入清单。'
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as EmbeddingManifest
}

/**
 * 结构自检。返回**具名**问题列表；空列表才算通过。
 *
 * 刻意把每条检查的理由写在消息里 —— 将来红的时候能直接读出"为什么这条存在"。
 */
export function validateEmbeddingManifest(manifest: unknown): string[] {
  const problems: string[] = []
  if (typeof manifest !== 'object' || manifest === null) return ['清单不是 JSON 对象']
  const m = manifest as Partial<EmbeddingManifest>
  if (m.manifestVersion !== EMBEDDING_MANIFEST_VERSION) {
    problems.push(`manifestVersion 必须是 ${EMBEDDING_MANIFEST_VERSION}（收到 ${String(m.manifestVersion)}）`)
  }
  for (const field of ['modelId', 'baseModel', 'dtype', 'pooling', 'queryPrefix', 'passagePrefix'] as const) {
    if (typeof m[field] !== 'string' || (m[field] as string).length === 0) {
      problems.push(`${field} 必须是非空字符串`)
    }
  }
  if (typeof m.revision !== 'string' || m.revision.length === 0) {
    problems.push('revision 缺失')
  } else if (MUTABLE_REVISIONS.includes(m.revision.toLowerCase())) {
    problems.push(
      `revision=${JSON.stringify(m.revision)} 是**可变引用** ⇒ 不能充当冻结指纹（D30）；` +
        '必须写不可变的 commit sha'
    )
  } else if (!/^[0-9a-f]{7,64}$/i.test(m.revision)) {
    problems.push(`revision=${JSON.stringify(m.revision)} 不像 commit sha（要求 7..64 位十六进制）`)
  }
  if (!Number.isInteger(m.dimension) || (m.dimension as number) <= 0) {
    problems.push('dimension 必须是正整数')
  }
  if (typeof m.normalize !== 'boolean') problems.push('normalize 必须是布尔')
  if (typeof m.runtime?.package !== 'string' || typeof m.runtime?.version !== 'string') {
    problems.push('runtime.package / runtime.version 缺失（D29 要求登记运行时身份）')
  }
  if (!Array.isArray(m.assets) || m.assets.length === 0) {
    problems.push('assets 必须是非空数组（否则"校验通过"什么都没校验）')
  } else {
    const paths = new Set<string>()
    for (const asset of m.assets) {
      if (typeof asset?.path !== 'string' || (asset.path as string).length === 0) {
        problems.push('某个 asset 的 path 非法')
        continue
      }
      if (paths.has(asset.path)) problems.push(`asset 路径重复：${asset.path}`)
      paths.add(asset.path)
      if (!Number.isInteger(asset.bytes) || (asset.bytes as number) <= 0) {
        problems.push(`asset ${asset.path} 的 bytes 必须是正整数`)
      }
      if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
        problems.push(`asset ${asset.path} 的 sha256 不是 64 位十六进制`)
      }
    }
    if (![...paths].some((path) => path.endsWith('.onnx'))) {
      problems.push('assets 里**没有权重文件**（*.onnx）⇒ 清单不足以定位模型')
    }
  }
  if (m.license?.conversionRepoDeclared === undefined) {
    problems.push('license.conversionRepoDeclared 必须显式给出（可为 null，但不得省略）')
  }
  return problems
}

/**
 * **贯穿用的模型指纹**（D30）：由**影响输出空间**的字段派生 ——
 * 换模型/换量化/换维度/换归一化/换前缀/换 revision 都会换指纹。
 * 它与 ADR-074 §4.1 的 `model_fingerprint` 列同源。
 */
export function embeddingFingerprintOf(manifest: EmbeddingManifest): string {
  const parts = [
    manifest.modelId,
    manifest.revision,
    manifest.dtype,
    `dim=${String(manifest.dimension)}`,
    `pooling=${manifest.pooling}`,
    `normalize=${String(manifest.normalize)}`,
    `q=${JSON.stringify(manifest.queryPrefix)}`,
    `p=${JSON.stringify(manifest.passagePrefix)}`,
  ]
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 32)
}

export interface AssetVerification {
  readonly total: number
  readonly verified: number
  readonly missing: readonly string[]
  readonly sizeMismatch: readonly string[]
  readonly hashMismatch: readonly string[]
  readonly upstreamHashMismatch: readonly string[]
  /** 判定：**全部**核对通过且核对了 > 0 个文件 */
  readonly ok: boolean
}

/**
 * 逐个核对本地资产。
 *
 * ⚠️ 计数型自检：`verified === 0` 时 `ok` **必须**是 false
 * —— "检查了 0 个文件、发现 0 处不符"与"全部一致"在输出上长得一样（AGENTS §6.8）。
 */
export function verifyEmbeddingAssets(
  modelDir: string,
  manifest: EmbeddingManifest,
  options: { readonly hash?: boolean } = {}
): AssetVerification {
  const hash = options.hash ?? true
  const missing: string[] = []
  const sizeMismatch: string[] = []
  const hashMismatch: string[] = []
  const upstreamHashMismatch: string[] = []
  let verified = 0

  for (const asset of manifest.assets) {
    const file = join(modelDir, asset.path)
    if (!existsSync(file)) {
      missing.push(asset.path)
      continue
    }
    const stat = statSync(file)
    if (stat.size !== asset.bytes) {
      sizeMismatch.push(`${asset.path}(${String(stat.size)}!=${String(asset.bytes)})`)
      continue
    }
    if (hash) {
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
      if (actual !== asset.sha256.toLowerCase()) {
        hashMismatch.push(`${asset.path}(${actual.slice(0, 12)}…!=${asset.sha256.slice(0, 12)}…)`)
        continue
      }
      if (asset.upstreamLfsSha256 !== undefined && actual !== asset.upstreamLfsSha256.toLowerCase()) {
        upstreamHashMismatch.push(asset.path)
        continue
      }
    }
    verified += 1
  }

  return {
    total: manifest.assets.length,
    verified,
    missing,
    sizeMismatch,
    hashMismatch,
    upstreamHashMismatch,
    ok:
      verified > 0 &&
      verified === manifest.assets.length &&
      missing.length === 0 &&
      sizeMismatch.length === 0 &&
      hashMismatch.length === 0 &&
      upstreamHashMismatch.length === 0,
  }
}
