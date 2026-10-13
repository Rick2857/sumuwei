/**
 * PostgreSQL 迁移 WP4：**数据库外资产清单**（计划 §3.3 / §4-WP4；契约 `PG-G07.5`）。
 *
 * ============================================================================
 *  为什么这件事不能"顺手列一下"
 * ============================================================================
 *  计划 §3.3 逐字：
 *
 * ```text
 *   数据库外图片、个人资料库等列独立路径、摘要、归属和备份恢复办法；
 *   ImageInputStore 不再以 PG 连接配置推导文件路径。
 * ```
 *
 *  这里最容易犯的错**不是漏算某个文件，而是漏算一整个根**：
 *  写一张"要备份的目录"表很容易，难的是**证明这张表是完整的** ——
 *  也就是"`data/` 底下每一个条目都被判过"。
 *  ⇒ 本模块的判据形状刻意做成**闭集**：
 *    `unclassifiedDataRoots()` 列出**没有归属**的条目，它非空就是拒收。
 *    加了新目录却不来登记，门会红着说"这个我没判过"——
 *    而不是安静地把它漏在备份之外。
 *
 * ---------------------------------------------------------------------------
 *  两条纪律
 * ---------------------------------------------------------------------------
 *  ① **摘要不含 mtime**：`TD-23` 的既有裁定是"身份优先、mtime 永不参与"。
 *     资产摘要只由"相对路径 + 字节数 + 内容 sha256"构成。拷贝一次文件
 *     （mtime 变了、内容没变）**不应该**被判成"资产变了"。
 *  ② **判据给互不相同的原因**：`asset_missing`（少了）/ `asset_digest_mismatch`
 *     （内容变了）/ `asset_unexpected_file`（多了）—— 恢复演练里这三种的处理
 *     方式完全不同（分别是"没备份全"/"被改过"/"没清干净"），
 *     给同一个原因就失去了诊断力。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

/** 资产根缺省位置（工作区相对） */
export const DATA_ROOT = 'data'

export interface AssetRootDeclaration {
  /** 稳定的机器 id（进证据文件） */
  id: string
  /** 工作区相对路径 */
  path: string
  /** **归属**：谁写的、为什么在库外（计划 §3.3 逐字要这一项） */
  attribution: string
  decision: 'include' | 'exclude'
  /** `exclude` 的**具名原因**（`include` 时写备份办法） */
  reason: string
}

/**
 * `data/` 之下每个条目的归属表。
 *
 * ⚠️ `data/` 底下**新增任何条目都必须来这里登记**，否则
 *    `unclassifiedDataRoots()` 会让门变红。这是刻意的。
 */
export const ASSET_ROOT_DECLARATIONS: AssetRootDeclaration[] = [
  {
    id: 'image-inputs',
    path: 'data/pglite/image-inputs',
    attribution: '聊天图片输入的原件（`ImageInputStore`，内容寻址 `image:sha256:<hex>.bin`，库里以同一 ref 引用）',
    decision: 'include',
    reason: '按目录 + 每文件 sha256 进 manifest；恢复时逐个校验（库里存的是 ref，文件没了那行引用就指向空）',
  },
  {
    id: 'personal-library',
    path: 'data/personal-library',
    attribution: '个人资料库（用户提供的资料文件）',
    decision: 'include',
    reason: '按目录 + 每文件 sha256 进 manifest（当前为空目录，读数原样记录）',
  },
  {
    id: 'owner-records',
    path: 'data/owner-records',
    attribution: '数据库归属凭证（`production-db-owner-*.json`，由 `production-open-guard` 写）',
    decision: 'include',
    reason: '按目录 + 每文件 sha256 进 manifest；这些凭证决定"这个库是不是她的"，丢了要重建',
  },
  {
    id: 'local-file-recovery',
    path: 'data/local-file-recovery',
    attribution: '本地文件恢复暂存（就地改写前的 `.bak`）',
    decision: 'include',
    reason: '按目录 + 每文件 sha256 进 manifest；内容量小且是用户文件的副本，不做丢弃',
  },
  {
    id: 'qq-private',
    path: 'data/qq-private',
    attribution: 'QQ 入口的私聊落盘（`config` 与 `qq` 两段：会话/媒体文件）',
    decision: 'include',
    reason: '按目录 + 每文件 sha256 进 manifest；与库内私聊账本同源，迁移时必须一起搬',
  },
  {
    id: 'database-itself',
    path: 'data/pglite',
    attribution: '**数据库本体**（PGlite 数据目录）',
    decision: 'exclude',
    reason: '它不是"库外资产" —— 它由快照/导出链负责（计划 §6.1：不直接复制运行中的 `data/pglite`）',
  },
  {
    id: 'legacy-snapshot-roots',
    path: 'data/snapshots',
    attribution: 'verified 快照归档根（含 `pglite-<id>/` 与同名 `.manifest.json`）',
    decision: 'exclude',
    reason: '快照归档**本身**就是备份载体；把备份再备份一遍不增加可恢复性',
  },
  {
    id: 'snapshot-root-semantic-repair',
    path: 'data/snapshots-semantic-repair-20261005',
    attribution: '一次专项修复期的快照归档根',
    decision: 'exclude',
    reason: '同 `legacy-snapshot-roots`（历史归档，非运行期资产）',
  },
  {
    id: 'legacy-db-copies',
    path: 'data/backup',
    attribution: '旧库副本归档（`pglite-pre-v9-*` + 边界记录）',
    decision: 'exclude',
    reason: '历史归档；保留原样但不由本清单管理',
  },
  {
    id: 'legacy-pglite-copies',
    path: 'data/pglite.backup-*',
    attribution: '历史 PGlite 库副本（各里程碑迁移前的备份）',
    decision: 'exclude',
    reason:
      '历史归档（`pglite.backup-m3.5-*` / `-m4-*` / `-pre-v6-*` / `-pre-v9-*` / `-verify-temp-*`）；' +
      '可恢复性由快照链负责，不由本清单管理。⚠️ 通配符**也是声明**（它逐条列出匹配到哪几个目录，见 reading.matchedRoots），不是"没判过"',
  },
  {
    id: 'legacy-pglite-broken',
    path: 'data/pglite.broken-*',
    attribution: '事故残留的 PGlite 目录（未通过验证/被中断的库）',
    decision: 'exclude',
    reason: '事故现场保留物（`L-PGW0`/INC-01 相关）；**刻意不删**，但它不是运行期资产，恢复也不从它来',
  },
  {
    id: 'legacy-pglite-snapshot',
    path: 'data/pglite.snapshot-*',
    attribution: '手工快照目录（早期 `snapshots/` 之前的做法）',
    decision: 'exclude',
    reason: '与 `data/snapshots` 同类的历史归档；由快照链负责',
  },
  {
    id: 'diagnostics',
    path: 'data/diagnostics',
    attribution: '诊断产物（探针 dump / trace 快照）',
    decision: 'exclude',
    reason: '由 retention 管理、可重现、非角色运行必需；本轮**不遍历**（体量大，遍历会拖长门且不增加判据）',
  },
  {
    id: 'automatic-memory-runtime',
    path: 'data/runtime/automatic-memory/langmem-48e3c11',
    attribution: '第三方实验运行时（`langmem` 仓库检出 + `.venv`）',
    decision: 'exclude',
    reason:
      '是**可重现的工具链**而不是角色数据（含 `.venv` / `.git`）。⚠️ 这是一条**裁定**而不是读数：' +
      '若 M9.6 线将来把它当权威记忆存储，这条要重开（见 `L-PGW4-09`）',
  },
]

/** 对**显式列出的动作根**做完整遍历（这些目录体量可控，且内含角色数据） */
const FULLY_COUNTED = new Set(['image-inputs', 'personal-library', 'owner-records', 'local-file-recovery', 'qq-private'])

/** 声明路径的**第一段**（`data/` 之后那一层）。通配声明以 `*` 结尾。 */
function firstSegment(path: string): string {
  return path.replace(/^data[\\/]/, '').split(/[\\/]/)[0]
}

/**
 * 一条声明是否覆盖 `data/` 下的某个条目。
 *
 * ⚠️ 通配符（`data/pglite.backup-*`）**是声明**而不是省略：它同样要写归属与原因，
 *    而且 reading 里会**逐条列出它匹配到哪几个目录**（`matchedRoots`）——
 *    于是"这个通配符实际盖住了什么"是**可审计的读数**，不是一句"反正匹配了"。
 */
export function declarationMatches(declaration: AssetRootDeclaration, entry: DataRootEntry): boolean {
  const segment = firstSegment(declaration.path)
  if (segment.endsWith('*')) return entry.isDirectory && entry.name.startsWith(segment.slice(0, -1))
  return entry.name === segment
}

export interface DataRootEntry {
  /** `data/` 之下的相对名字（`pglite` / `m3-ci.log` / …） */
  name: string
  isDirectory: boolean
}

/** `data/` 的**直接**子条目（文件与目录都算） */
export function enumerateDataRoots(dataRoot = DATA_ROOT): DataRootEntry[] {
  const root = resolve(dataRoot)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * `data/` 之下的条目里**没有被任何声明覆盖**的那些**目录**。
 *
 * 覆盖规则：声明路径去掉 `data/` 前缀之后的**第一段**必须等于条目的名字。
 * ⇒ `data/pglite`（本体）与 `data/pglite/image-inputs`（图片）由**两条不同声明**
 *    分别覆盖，而两者都指向同一个顶层条目 `pglite` —— 这是刻意的：
 *    "顶层条目被归过类"与"里面每个部分都有归属"是两件事。
 *
 * ⚠️ 判据**只对目录**要求具名归属。理由：数据都在目录里；`data/` 顶层的散落文件
 *    是开发期日志/证据/一次性探针脚本（见 `residualDataFiles`），
 *    逐条声明它们只会造出一张需要天天维护的表，而那张表**本身**不是判据。
 *    ⇒ 散落文件**照实记读数**（`residualDataFiles` + 计数），不假装它们被"归类"了。
 */
export function unclassifiedDataRoots(dataRoot = DATA_ROOT): DataRootEntry[] {
  return enumerateDataRoots(dataRoot).filter(
    (entry) =>
      entry.isDirectory && !ASSET_ROOT_DECLARATIONS.some((declaration) => declarationMatches(declaration, entry))
  )
}

/** `data/` 顶层的**散落文件**（非目录）——照实记，不假装归过类 */
export function residualDataFiles(dataRoot = DATA_ROOT): string[] {
  return enumerateDataRoots(dataRoot)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
}

export interface AssetFileEntry {
  /** 相对**数据根**的 posix 路径 */
  path: string
  bytes: number
  sha256: string
}

export interface AssetRootReading {
  id: string
  path: string
  attribution: string
  decision: 'include' | 'exclude'
  reason: string
  exists: boolean
  /** `exclude` 且刻意不遍历时为 `false` */
  counted: boolean
  files: number
  bytes: number
  /** 根摘要：对（相对路径 + 字节数 + 内容 sha256）排序后取 sha256。**不含 mtime**。 */
  digest: string | null
  /** 通配声明实际盖住的目录名（**逐条列出** ⇒ "盖住了什么"是可审计读数） */
  matchedRoots: string[] | null
}

export interface AssetManifest {
  dataRoot: string
  capturedAtUtc: string
  roots: AssetRootReading[]
  /** 只含 `decision === 'include'` 且 `counted` 的根的文件 */
  files: AssetFileEntry[]
  totalFiles: number
  totalBytes: number
  unclassified: string[]
  /** `data/` 顶层散落文件（照实记录；非"已归类"） */
  residualFiles: string[]
  manifestDigest: string
}

function walkFiles(base: string): string[] {
  const out: string[] = []
  const visit = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      const next = rel === '' ? entry.name : posix.join(rel, entry.name)
      if (entry.isDirectory()) visit(full, next)
      else out.push(next)
    }
  }
  visit(base, '')
  return out.sort()
}

/** 算一个根的文件清单 + 根摘要（**只读**；不改动被算的目录） */
export function readAssetRoot(declaration: AssetRootDeclaration, dataRoot = DATA_ROOT): AssetRootReading {
  const isWildcard = firstSegment(declaration.path).endsWith('*')
  const matchedRoots = isWildcard
    ? enumerateDataRoots(dataRoot)
        .filter((entry) => declarationMatches(declaration, entry))
        .map((entry) => entry.name)
    : null
  const full = isWildcard
    ? null
    : resolve(dataRoot, declaration.path.replace(/^data[\\/]/, ''))
  const exists = isWildcard ? (matchedRoots?.length ?? 0) > 0 : existsSync(full!)
  const base: AssetRootReading = {
    id: declaration.id,
    path: declaration.path,
    attribution: declaration.attribution,
    decision: declaration.decision,
    reason: declaration.reason,
    exists,
    counted: false,
    files: 0,
    bytes: 0,
    digest: null,
    matchedRoots,
  }
  if (!exists || full === null) return base
  if (declaration.decision === 'exclude' && !FULLY_COUNTED.has(declaration.id)) return base
  const relative = walkFiles(full)
  const entries = relative.map((path) => {
    const bytes = readFileSync(join(full, path))
    return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const canonical = entries.map((entry) => `${entry.path}\u0000${entry.bytes}\u0000${entry.sha256}`).join('\n')
  return {
    ...base,
    counted: true,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  }
}

export function buildAssetManifest(options: { dataRoot?: string; capturedAt?: Date } = {}): AssetManifest {
  const dataRoot = options.dataRoot ?? DATA_ROOT
  const roots = ASSET_ROOT_DECLARATIONS.map((declaration) => readAssetRoot(declaration, dataRoot))
  const files: AssetFileEntry[] = []
  for (const declaration of ASSET_ROOT_DECLARATIONS) {
    if (declaration.decision !== 'include') continue
    const full = resolve(dataRoot, declaration.path.replace(/^data[\\/]/, ''))
    if (!existsSync(full)) continue
    for (const path of walkFiles(full)) {
      const bytes = readFileSync(join(full, path))
      files.push({
        path: posix.join(declaration.path.replace(/^data[\\/]/, ''), path),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const canonical = files.map((entry) => `${entry.path}\u0000${entry.bytes}\u0000${entry.sha256}`).join('\n')
  return {
    dataRoot,
    capturedAtUtc: (options.capturedAt ?? new Date()).toISOString(),
    roots,
    files,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    unclassified: unclassifiedDataRoots(dataRoot).map((entry) => entry.name),
    residualFiles: residualDataFiles(dataRoot),
    manifestDigest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  }
}

export type AssetRefusalReason =
  | 'asset_root_missing'
  | 'asset_missing'
  | 'asset_digest_mismatch'
  | 'asset_unexpected_file'
  | 'asset_manifest_empty'

export type AssetVerification =
  | { ok: true; files: number; bytes: number; manifestDigest: string }
  | { ok: false; reason: AssetRefusalReason; detail: string }

/**
 * 按 manifest 校验一个数据根。**有序**检查链（原因互不相同）：
 *
 * ```text
 *   ① 根在不在            ⇒ asset_root_missing
 *   ② 有没有可比的东西     ⇒ asset_manifest_empty     （空 manifest 不算"通过"）
 *   ③ 缺文件              ⇒ asset_missing
 *   ④ 文件内容变了         ⇒ asset_digest_mismatch
 *   ⑤ 多出文件            ⇒ asset_unexpected_file   （"没清干净"是独立的事故形状）
 * ```
 */
export function verifyAssetManifest(
  manifest: AssetManifest,
  options: { dataRoot?: string } = {}
): AssetVerification {
  const dataRoot = options.dataRoot ?? manifest.dataRoot
  if (!existsSync(resolve(dataRoot))) {
    return { ok: false, reason: 'asset_root_missing', detail: resolve(dataRoot) }
  }
  if (manifest.files.length === 0) {
    return {
      ok: false,
      reason: 'asset_manifest_empty',
      detail: 'manifest 里一个文件都没有 ⇒ 按它"校验通过"不证明任何事（不许把空集当绿灯）',
    }
  }
  const onDisk = new Set<string>()
  for (const entry of manifest.files) {
    const full = resolve(dataRoot, entry.path)
    if (!existsSync(full)) {
      return { ok: false, reason: 'asset_missing', detail: entry.path }
    }
    const bytes = readFileSync(full)
    onDisk.add(entry.path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) {
      return {
        ok: false,
        reason: 'asset_digest_mismatch',
        detail: `${entry.path} 现在 ${bytes.byteLength}B/${digest.slice(0, 12)}… ≠ 清单 ${entry.bytes}B/${entry.sha256.slice(0, 12)}…`,
      }
    }
  }
  for (const declaration of ASSET_ROOT_DECLARATIONS) {
    if (declaration.decision !== 'include') continue
    if (firstSegment(declaration.path).endsWith('*')) continue
    const full = resolve(dataRoot, declaration.path.replace(/^data[\\/]/, ''))
    if (!existsSync(full)) continue
    for (const path of walkFiles(full)) {
      const relative = posix.join(declaration.path.replace(/^data[\\/]/, ''), path)
      if (!onDisk.has(relative)) {
        return { ok: false, reason: 'asset_unexpected_file', detail: relative }
      }
    }
  }
  return { ok: true, files: manifest.files.length, bytes: manifest.totalBytes, manifestDigest: manifest.manifestDigest }
}
