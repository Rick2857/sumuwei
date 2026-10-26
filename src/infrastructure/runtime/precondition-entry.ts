/**
 * **F1 有界条件观察的任务入口**（ADR-151 R1 §2 —— 纯函数、零 IO）。
 *
 * ============================================================================
 *  为什么要有独立入口
 * ============================================================================
 * ```text
 * 旧入口 explicitFileGoal：只接受**扁平** .txt 文件名
 * 族识别 familyOfWriteTarget：要求命中 `目录/` 前缀
 *   ⇒ 旧入口拿不到族；把族硬塞给规划器 = 绕过受信来源
 * 前置条件观察：需要**另一个文件**的一次只读
 *   ⇒ 原任务只授权了"一个目标"，不能自己扩范围
 * ```
 * ⇒ 新的**两行**精确请求：第一行授权一个目录内目标；第二行**明确**授权唯一例外
 *    （一个条件标记的只读、最多一次）。族仍然只来自受信 `knownDirectories`。
 *
 * ⚠️ 旧入口**保持原样**；本解析器只在开关打开时被调用。
 * ⚠️ 解析成功**不等于**执行获准：路径仍要走既有目标解析/沙箱根/权限/符号链接检查。
 */

import { fnv1a64Hex } from '../../kernel/action/idempotency.ts'

/** 第二行的开头（只有它才说明"这是一个 F1 请求"）。 */
export const PRECONDITION_ENTRY_CLAUSE = '允许本任务额外只读条件标记'

/** 目录段 / 文件 stem 的字符集（闭集）。 */
const SEGMENT = /^[A-Za-z0-9_-]+$/
/** 全路径上限（UTF-16 单元）。 */
export const PRECONDITION_ENTRY_MAX_PATH = 256
/** 目标最多几层目录（ADR-151 R1 §2：1–3 层）。 */
const MAX_TARGET_DIRS = 3

export interface PreconditionTaskEntry {
  /** 目标路径（目录相对路径，含 `.txt`）。 */
  readonly targetPath: string
  /** 目标内容的指纹（来自第一行的 JSON 字符串）。 */
  readonly expectedFingerprint: string
  /** 唯一的条件标记路径（相对沙箱根；允许在根目录）。 */
  readonly conditionPath: string
}

export type PreconditionTaskEntryResult =
  | { readonly kind: 'entry'; readonly entry: PreconditionTaskEntry }
  /** 自称是 F1 请求（第二行子句在场）但形状/路径不合法 ⇒ **明确拒绝**（不许截半执行）。 */
  | { readonly kind: 'rejected'; readonly reason: string }
  /** 不是 F1 请求（没有第二行子句）⇒ 交给旧入口。 */
  | { readonly kind: 'not_applicable' }

const LINE1 = /^只操作相对路径 (.+?)。写入以下 JSON 字符串解码后的精确内容，再读回核对：("(?:[^"\\]|\\.)*")。?$/
const LINE2 = /^允许本任务额外只读条件标记 (.+?)，最多一次。$/

/** 一个**有界相对路径**：`段/段/名.txt`；拒绝绝对/盘符/反斜线/空段/`.`/`..`/glob/超长。 */
function segmentsOf(raw: string, options: { minDirs: number; maxDirs: number }): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PRECONDITION_ENTRY_MAX_PATH) return undefined
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return undefined
  if (/[*?[\]{}]/.test(raw)) return undefined
  const parts = raw.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  if (parts.length < options.minDirs + 1 || parts.length > options.maxDirs + 1) return undefined
  const file = parts.at(-1)!
  // ⚠️ 文件名是 `<stem>.txt`：**只**校验 stem 与目录段，`.txt` 后缀单独判。
  if (!file.endsWith('.txt')) return undefined
  const stem = file.slice(0, -'.txt'.length)
  if (stem === '' || !SEGMENT.test(stem)) return undefined
  if (!parts.slice(0, -1).every(part => SEGMENT.test(part))) return undefined
  return parts
}

/**
 * 解析两行 F1 请求（**失败关闭**）。
 *
 * ⚠️ 只要文本里出现第二行的子句开头，就**不是** `not_applicable` ——
 *    形状不合法时返回 `rejected`，**绝不**"去掉第二行、截取第一行照跑"。
 */
export function parsePreconditionTaskEntry(text: string): PreconditionTaskEntryResult {
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''))
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  const claimsEntry = lines.some(line => line.trimStart().startsWith(PRECONDITION_ENTRY_CLAUSE))
  if (!claimsEntry) return { kind: 'not_applicable' }
  if (lines.length !== 2) return { kind: 'rejected', reason: 'entry_not_two_lines' }
  const first = lines[0]!.trim()
  const second = lines[1]!.trim()
  const match1 = LINE1.exec(first)
  if (match1 === null) return { kind: 'rejected', reason: 'entry_bad_target_line' }
  const match2 = LINE2.exec(second)
  if (match2 === null) return { kind: 'rejected', reason: 'entry_bad_condition_line' }
  const targetSegments = segmentsOf(match1[1]!, { minDirs: 1, maxDirs: MAX_TARGET_DIRS })
  if (targetSegments === undefined) return { kind: 'rejected', reason: 'entry_bad_target_path' }
  const conditionSegments = segmentsOf(match2[1]!, { minDirs: 0, maxDirs: MAX_TARGET_DIRS })
  if (conditionSegments === undefined) return { kind: 'rejected', reason: 'entry_bad_condition_path' }
  const targetPath = targetSegments.join('/')
  const conditionPath = conditionSegments.join('/')
  if (conditionPath === targetPath) return { kind: 'rejected', reason: 'entry_condition_is_target' }
  let content: unknown
  try { content = JSON.parse(match1[2]!) } catch { return { kind: 'rejected', reason: 'entry_bad_content_json' } }
  if (typeof content !== 'string') return { kind: 'rejected', reason: 'entry_content_not_string' }
  return { kind: 'entry', entry: { targetPath, expectedFingerprint: fnv1a64Hex(content), conditionPath } }
}
