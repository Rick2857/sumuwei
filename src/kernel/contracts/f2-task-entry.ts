/**
 * **F2 任务入口解析**（纯函数 · 零 IO · 失败关闭）。
 *
 * 目的：让"**一条真实 ActionTurn 闭环**"有一个**确定、可校验、不可伪造**的任务形状，
 * 由装配层据此挂 `TaskAuthorization.sourceScopedPaths`（逐路径授权 R4）。
 *
 * 形状（**单行、闭集、顺序固定**）：
 * ```text
 * F2 只操作相对路径 f1/a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。
 * ```
 * 规则：
 *  · 四个路径都必须落在**同一个族**（族 = 目标路径的目录）；
 *  · 四个路径**互不相同**；族标记不得等于目标/缓存源/权威源；
 *  · 全部是**相对路径**、无盘符、无反斜线、无空段、无 `.`/`..`、无 glob、每段 ≤256 字符；
 *  · 标记读次数**固定为 1**（本入口不接受其它数值）；
 *  · 任何多余内容 / 自称 F2 但形状不合法 ⇒ **整条拒绝**（绝不"截半执行"）。
 *
 * ⚠️ 本模块**不**发授权、**不**读写文件；它只把"任务原话"变成结构化的范围声明。
 */

export interface F2TaskPaths {
  /** 目标（可写 + 读回）。 */
  readonly target: string
  /** 缓存源（只读）。 */
  readonly cacheSource: string
  /** 权威源（只读；真值来源）。 */
  readonly authoritativeSource: string
  /** 族级条件标记（限次只读一次）。 */
  readonly familyMarker: string
}

export interface F2TaskEntry {
  readonly kind: 'f2_task_entry'
  readonly familyId: string
  readonly paths: F2TaskPaths
  /** 标记读次数上限（本入口恒为 1）。 */
  readonly markerMaxReads: 1
}

export type F2TaskEntryParsed =
  | { readonly status: 'parsed', readonly entry: F2TaskEntry }
  | { readonly status: 'not_applicable' }
  | { readonly status: 'rejected', readonly reason: F2TaskEntryRejectReason }

export const F2_TASK_ENTRY_REJECT_REASONS = [
  'multiline',
  'bad_prefix',
  'bad_shape',
  'bad_path_charset',
  'absolute_or_escape_path',
  'path_too_long',
  'paths_not_distinct',
  'paths_not_same_family',
  'marker_equals_payload_path',
  'marker_reads_not_one',
] as const
export type F2TaskEntryRejectReason = (typeof F2_TASK_ENTRY_REJECT_REASONS)[number]

// ⚠️ 允许**前导点**的隐藏名（族标记 `.freshness`），但 `.`/`..` 已在前面单独拒绝。
const SEGMENT = /^\.?[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const MAX_UNITS = 256

const reject = (reason: F2TaskEntryRejectReason): F2TaskEntryParsed => ({ status: 'rejected', reason })

/** 相对路径校验（**失败关闭**）：段字符集、无逃逸、长度上限。 */
const validateRelPath = (value: string): F2TaskEntryRejectReason | undefined => {
  if (value === '') return 'bad_path_charset'
  if (value.length > MAX_UNITS) return 'path_too_long'
  if (value.includes('\\') || /^[A-Za-z]:/.test(value) || value.startsWith('/')) return 'absolute_or_escape_path'
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'absolute_or_escape_path'
    if (segment.includes('*') || segment.includes('?')) return 'bad_path_charset'
    if (!SEGMENT.test(segment)) return 'bad_path_charset'
  }
  return undefined
}

const familyOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

const PATTERN = /^F2 只操作相对路径 (\S+)；缓存源 (\S+)；权威源 (\S+)；族标记 (\S+)，最多读一次。$/u

/**
 * 解析任务原话。**只有**严格匹配的单行请求才会 `parsed`；
 * 自称 F2（以 `F2` 开头）但不匹配形状 ⇒ `rejected`；完全不像 F2 ⇒ `not_applicable`。
 */
export function parseF2TaskEntry (text: string): F2TaskEntryParsed {
  const trimmed = text.trim()
  if (!trimmed.startsWith('F2')) return { status: 'not_applicable' }
  if (trimmed.includes('\n') || trimmed.includes('\r')) return reject('multiline')
  const match = PATTERN.exec(trimmed)
  if (match === null) return reject(trimmed.startsWith('F2 只操作') ? 'bad_shape' : 'bad_prefix')
  const [, target, cacheSource, authoritativeSource, familyMarker] = match as unknown as [string, string, string, string, string]
  for (const path of [target, cacheSource, authoritativeSource, familyMarker]) {
    const problem = validateRelPath(path)
    if (problem !== undefined) return reject(problem)
  }
  if (new Set([target, cacheSource, authoritativeSource, familyMarker]).size !== 4) return reject('paths_not_distinct')
  const family = familyOf(target)
  if (familyOf(cacheSource) !== family || familyOf(authoritativeSource) !== family) return reject('paths_not_same_family')
  // 族标记必须**直接**挂在族目录下（不许与载荷路径同名）
  if (familyMarker !== `${family}/.freshness`) return reject('marker_reads_not_one')
  return {
    status: 'parsed',
    entry: {
      kind: 'f2_task_entry',
      familyId: family,
      paths: { target, cacheSource, authoritativeSource, familyMarker },
      markerMaxReads: 1,
    },
  }
}

/** 由已解析入口**派生**逐路径范围（供装配层挂到授权上）。 */
export function sourceScopedPathsOf (entry: F2TaskEntry): {
  readonly readOnly: readonly string[]
  readonly limitedReads: readonly { readonly path: string, readonly maxReads: number }[]
  readonly writable: readonly string[]
} {
  return {
    readOnly: [entry.paths.cacheSource, entry.paths.authoritativeSource],
    limitedReads: [{ path: entry.paths.familyMarker, maxReads: entry.markerMaxReads }],
    writable: [entry.paths.target],
  }
}
