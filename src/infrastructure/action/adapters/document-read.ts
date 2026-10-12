/**
 * `document.read` 适配器（计划书 §3.1「文档阅读」/ §1 首版能力第 2 项）。
 *
 * ============================================================================
 *  四道边界，缺一不可
 * ============================================================================
 * ```text
 * ① 目标：复用 M4.5 的沙箱包含性守卫（resolveSandboxPath：语法 + realpath 双层）
 *    ⇒ 越界永远不会变成一次真实的文件读取；UNC / junction / symlink 都在这一层被挡
 * ② 格式：扩展名与**魔数**必须一致（.pdf 真的是 PDF、.docx 真的是 ZIP+word/）
 *    ⇒ "伪装格式"不是"猜一个转换器试试"，而是明确降档
 * ③ 规模：文件 ≤ 10 MiB；压缩容器另查**成员数 ≤ 1000** 与**展开体积 ≤ 50 MiB**
 *    （在转换**之前**查，不能只看压缩文件大小 —— 计划书 §3.1 逐字）
 * ④ 执行：交给**独立 Python 环境**的 `convert_stream()`（只喂已授权字节），
 *    30 秒硬超时 + 杀掉进程树 ⇒ 卡住不会拖死对话，"超时"如实记 `timeout`
 * ```
 *
 * ⚠️ **不调用** `MarkItDown.convert()` / `convert_uri()`：那两条能读任意 URI
 *    （准备包 §2.1 已核对固定源码）。本适配器只把 `Buffer` 交给 `convert_stream()`。
 * ⚠️ 转换器**不保留**页码时**不生成虚构定位**：`facts` 里只说转换器**实际给出**的结构。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import {
  DOCUMENT_READ,
  DOCUMENT_READ_OPERATION,
} from '../../../kernel/action/utility-capabilities.ts'
import type { DocumentTurnContent, TurnContent, TurnContentSourceKind } from '../../../kernel/contracts/turn-content.ts'
import { resolveSandboxPath, type SandboxFilesystemOptions } from './sandbox-filesystem.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

/** 转换器入口（与本批的 Python 环境一起交付；见 `scripts/utility-skills/doc-runner.py`） */
export const DEFAULT_DOC_RUNNER = join(REPO_ROOT, 'scripts', 'utility-skills', 'doc-runner.py')
/** 专属 venv 的解释器（装配层可覆盖；缺省是准备期确定的那个路径） */
export const DEFAULT_DOC_PYTHON = join(
  REPO_ROOT,
  'artifacts',
  'post-lv2',
  'local',
  'utility-skills-preparation',
  'python',
  'venv',
  'Scripts',
  'python.exe'
)

export const DOCUMENT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxArchiveMembers: 1000,
  maxArchiveUncompressedBytes: 50 * 1024 * 1024,
  timeoutMs: 30_000,
} as const

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'txt'

export interface DocumentReadOptions extends SandboxFilesystemOptions {
  /** 专属 Python 解释器（缺省 `DEFAULT_DOC_PYTHON`） */
  pythonPath?: string
  /** 转换器入口（缺省 `DEFAULT_DOC_RUNNER`） */
  runnerPath?: string
  timeoutMs?: number
  maxFileBytes?: number
  /** 测试注入点：换成别的转换实现（**不改变生产缺省**） */
  convert?: (input: {
    bytes: Buffer
    format: DocumentFormat
    timeoutMs: number
  }) => Promise<DocumentConversionReading>
  /**
   * 第二批：**跨域路径解析**（缺省 = 只认沙箱，逐字段回到第一批行为）。
   *
   * 计划书 §2.1 第 3 点：「文档/OCR 从**同一授权文件读取入口**取得字节」。
   * 配了它 ⇒ 本适配器接受**本机绝对路径**，而守卫换成
   * `resolveLocalAbsolutePath`（语法院 + 重解析点守卫）；
   * 不配 ⇒ 老样子（`resolveSandboxPath`，绝对路径一律 `permission_denied`）。
   *
   * ⚠️ 它**只**替换"路径 → 已授权绝对路径"这一步：格式闸、规模闸、转换器、
   *    截断与 `TurnContent` 形状全部不变 —— 跨域不是"另一条读取链"。
   */
  resolveTarget?: (rawPath: string) => Promise<{
    absolutePath: string
    resourceRef: string
    sourceKind: TurnContentSourceKind
  }>
}

/**
 * 转换读数（生产路径与注入点**共用同一个形状**）。
 *
 * ⚠️ 它把"超时"与"失败"分成两个字段而不是一个状态码：超时**必须**能被单独看见
 *    （`status: 'timeout'` 与 `status: 'failed'` 是用户可见的不同结局）。
 */
export interface DocumentConversionReading {
  ok: boolean
  markdown?: string
  errorType?: string
  error?: string
  timedOut: boolean
  exitCode?: number | null
  ms?: number
}

// ---------------------------------------------------------------------------
// 格式判定（扩展名 + 魔数）
// ---------------------------------------------------------------------------

const EXTENSION_FORMAT: Readonly<Record<string, DocumentFormat>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.txt': 'txt',
  '.md': 'txt',
}

export function formatOfExtension(path: string): DocumentFormat | undefined {
  return EXTENSION_FORMAT[extname(path).toLowerCase()]
}

/** ZIP 中央目录的**只读**扫描：成员数 + 展开体积（用于转换前的规模闸） */
export interface ZipScan {
  members: number
  uncompressedBytes: number
  /** 条目名前缀（用于区分 docx/pptx/xlsx：`word/` / `ppt/` / `xl/`） */
  prefixes: readonly string[]
}

export interface ZipScanFailure {
  problem: string
}

/**
 * 扫描 ZIP 中央目录（**不解压、不执行任何东西**）。
 *
 * ⚠️ 只看中央目录：够了。我们只需要"有几个成员、展开后多大"，
 *    而这两件事在中央目录里就有 —— 不需要读任何一个成员的内容。
 */
export function scanZip(bytes: Buffer): ZipScan | ZipScanFailure {
  const maxBack = Math.min(bytes.length, 66_000)
  let eocd = -1
  for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { problem: 'ZIP 中央目录找不到（文件可能不是 ZIP 容器）' }

  const members = bytes.readUInt16LE(eocd + 10)
  const cdOffset = bytes.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || members === 0xffff) {
    return { problem: 'ZIP64 容器首版不支持（中央目录字段是 0xffffffff 哨兵）' }
  }

  let cursor = cdOffset
  let uncompressedBytes = 0
  const prefixes = new Set<string>()
  for (let i = 0; i < members; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      return { problem: `ZIP 中央目录第 ${String(i + 1)} 条记录损坏` }
    }
    const uncompressed = bytes.readUInt32LE(cursor + 24)
    const nameLen = bytes.readUInt16LE(cursor + 28)
    const extraLen = bytes.readUInt16LE(cursor + 30)
    const commentLen = bytes.readUInt16LE(cursor + 32)
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    const slash = name.indexOf('/')
    if (slash > 0) prefixes.add(name.slice(0, slash + 1))
    if (uncompressed === 0xffffffff) {
      return { problem: 'ZIP64 成员首版不支持（未压缩长度是 0xffffffff 哨兵）' }
    }
    uncompressedBytes += uncompressed
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return { members, uncompressedBytes, prefixes: [...prefixes] }
}

export interface FormatVerdict {
  ok: boolean
  format?: DocumentFormat
  problem?: string
}

/** 扩展名 + 魔数的一致判定（"伪装格式"在这里被拒绝，而不是"猜一个转换器试试"） */
export function inspectDocumentFormat(path: string, bytes: Buffer): FormatVerdict {
  const byExtension = formatOfExtension(path)
  if (byExtension === undefined) {
    return { ok: false, problem: `首版不支持的扩展名：${extname(path) || '(无)'}` }
  }
  const head = bytes.subarray(0, 8)
  const isPdfMagic = head.subarray(0, 5).toString('latin1') === '%PDF-'
  const isZipMagic =
    head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)

  if (byExtension === 'pdf') {
    return isPdfMagic
      ? { ok: true, format: 'pdf' }
      : { ok: false, problem: '.pdf 的文件头不是 %PDF-（伪装格式或损坏）' }
  }
  if (byExtension === 'txt') {
    if (isPdfMagic || isZipMagic) {
      return { ok: false, problem: `${extname(path)} 的文件头是二进制格式（伪装格式）` }
    }
    return { ok: true, format: 'txt' }
  }
  // docx / pptx / xlsx：必须是 ZIP，且内部前缀要与扩展名对得上
  if (!isZipMagic) {
    return { ok: false, problem: `${extname(path)} 的文件头不是 ZIP（伪装格式或损坏）` }
  }
  const scan = scanZip(bytes)
  if ('problem' in scan) return { ok: false, problem: scan.problem }
  const need = byExtension === 'docx' ? 'word/' : byExtension === 'pptx' ? 'ppt/' : 'xl/'
  if (!scan.prefixes.includes(need)) {
    return {
      ok: false,
      problem: `${extname(path)} 的容器里没有 ${need} 目录（扩展名与内部结构不一致）`,
    }
  }
  return { ok: true, format: byExtension }
}

// ---------------------------------------------------------------------------
// 转换器
// ---------------------------------------------------------------------------

interface ConversionReading extends DocumentConversionReading {
  ok: boolean
  timedOut: boolean
  exitCode: number | null
}

async function runConverter(input: {
  pythonPath: string
  runnerPath: string
  bytes: Buffer
  format: DocumentFormat
  timeoutMs: number
}): Promise<ConversionReading> {
  const startedAt = Date.now()
  const child = spawn(input.pythonPath, [input.runnerPath, '--ext', `.${input.format}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdin.write(input.bytes)
  child.stdin.end()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, input.timeoutMs)

  const exitCode = await new Promise<number | null>((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code))
    child.on('error', () => resolvePromise(null))
  })
  clearTimeout(timer)

  const line = stdout.trim().split('\n').filter((l) => l.trim() !== '').pop()
  if (line === undefined) {
    return {
      ok: false,
      errorType: timedOut ? 'timeout' : 'no_output',
      error: stderr.trim().slice(0, 400) || '转换器没有输出',
      ms: Date.now() - startedAt,
      timedOut,
      exitCode,
    }
  }
  try {
    const parsed = JSON.parse(line) as {
      ok?: boolean
      markdown?: string
      errorType?: string
      error?: string
    }
    return {
      ok: parsed.ok === true,
      ...(parsed.markdown !== undefined ? { markdown: parsed.markdown } : {}),
      ...(parsed.errorType !== undefined ? { errorType: parsed.errorType } : {}),
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      ms: Date.now() - startedAt,
      timedOut,
      exitCode,
    }
  } catch (error) {
    return {
      ok: false,
      errorType: 'bad_output',
      error: `转换器输出无法解析：${(error as Error).message}`,
      ms: Date.now() - startedAt,
      timedOut,
      exitCode,
    }
  }
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    spawn('taskkill', ['/pid', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 见 math-calculate 的同名函数：真正的判据是父进程不等它 */
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 从 markdown 里抽出转换器**实际给出**的结构标记（只报实有的，不生成虚构定位） */
export function structureOf(markdown: string, format: DocumentFormat): string[] {
  const out: string[] = []
  const headings = markdown.match(/^#{1,6}\s+.*$/gm)
  if (headings !== null && headings.length > 0) out.push(`标题 ${String(headings.length)} 个`)
  const tables = markdown.match(/^\|.*\|$/gm)
  if (tables !== null && tables.length > 0) {
    out.push(`表格行 ${String(tables.length)} 行`)
  }
  if (format === 'pptx') {
    const slides = markdown.match(/^#{1,6}\s+.*$/gm)
    out.push(`幻灯片标记 ${String(slides?.length ?? 0)} 个（按转换器给出的标题计）`)
  }
  if (format === 'xlsx') {
    const sheets = markdown.match(/^##\s+.*$/gm)
    out.push(`工作表标记 ${String(sheets?.length ?? 0)} 个（按转换器给出的二级标题计）`)
  }
  out.push('页码/精确定位：转换器未保留，故本批**不提供**（不生成虚构位置）')
  return out
}

export function createDocumentReadAdapter(options: DocumentReadOptions): CapabilityAdapter {
  const pythonPath = options.pythonPath ?? DEFAULT_DOC_PYTHON
  const runnerPath = options.runnerPath ?? DEFAULT_DOC_RUNNER
  const timeoutMs = options.timeoutMs ?? DOCUMENT_LIMITS.timeoutMs
  const maxFileBytes = options.maxFileBytes ?? DOCUMENT_LIMITS.maxFileBytes

  return {
    capabilityId: DOCUMENT_READ,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const relativePath = stringArg(input.args, 'path') ?? input.target.canonicalId
      if (relativePath === undefined || relativePath === '') {
        throw new ActionFailureError(actionFailure('validation_failed', '没有给出要读的文件'))
      }

      // ① 包含性（沙箱：语法 + realpath 双层；本机域：语法院 + 重解析点守卫）
      const resolution =
        options.resolveTarget === undefined
          ? {
              absolutePath: await resolveSandboxPath(options, relativePath),
              resourceRef: relativePath,
              sourceKind: 'local-file' as TurnContentSourceKind,
            }
          : await options.resolveTarget(relativePath)
      const absolute = resolution.absolutePath

      let size: number
      try {
        const info = await stat(absolute)
        if (!info.isFile()) {
          throw new ActionFailureError(
            actionFailure('unsupported', `${relativePath} 不是一个普通文件`)
          )
        }
        size = info.size
      } catch (error) {
        if (error instanceof ActionFailureError) throw error
        throw new ActionFailureError(actionFailure('target_not_found', `读不到文件：${relativePath}`))
      }
      if (size > maxFileBytes) {
        throw new ActionFailureError(
          actionFailure(
            'unsupported',
            `文件 ${String(size)} 字节，超过上限 ${String(maxFileBytes)}`
          )
        )
      }

      const bytes = await readFile(absolute)

      // ② 格式（扩展名 + 魔数）
      const verdict = inspectDocumentFormat(relativePath, bytes)
      if (!verdict.ok || verdict.format === undefined) {
        throw new ActionFailureError(
          actionFailure('unsupported', verdict.problem ?? '格式无法判定')
        )
      }

      // ③ 压缩容器的规模（转换**之前**查；不能只看压缩文件大小）
      if (verdict.format !== 'pdf' && verdict.format !== 'txt') {
        const scan = scanZip(bytes)
        if ('problem' in scan) {
          throw new ActionFailureError(actionFailure('unsupported', scan.problem))
        }
        if (scan.members > DOCUMENT_LIMITS.maxArchiveMembers) {
          throw new ActionFailureError(
            actionFailure(
              'unsupported',
              `容器成员 ${String(scan.members)} 个，超过上限 ${String(DOCUMENT_LIMITS.maxArchiveMembers)}`
            )
          )
        }
        if (scan.uncompressedBytes > DOCUMENT_LIMITS.maxArchiveUncompressedBytes) {
          throw new ActionFailureError(
            actionFailure(
              'unsupported',
              `容器展开 ${String(scan.uncompressedBytes)} 字节，超过上限 ` +
                `${String(DOCUMENT_LIMITS.maxArchiveUncompressedBytes)}`
            )
          )
        }
      }

      // ④ 转换（独立环境 + 30 秒硬超时 + 杀进程树）
      const convert =
        options.convert ??
        ((request: { bytes: Buffer; format: DocumentFormat; timeoutMs: number }) =>
          runConverter({
            pythonPath,
            runnerPath,
            bytes: request.bytes,
            format: request.format,
            timeoutMs: request.timeoutMs,
          }))

      const reading = await convert({
        bytes,
        format: verdict.format,
        timeoutMs,
      })

      if (reading.timedOut) {
        throw new ActionFailureError(
          actionFailure('timeout', `文档转换在 ${String(timeoutMs)}ms 内没有返回，执行器已被终结`)
        )
      }
      if (!reading.ok) {
        throw new ActionFailureError(
          actionFailure(
            'execution_failed',
            `文档转换失败（${reading.errorType ?? 'unknown'}）：${reading.error ?? ''}`.slice(0, 400)
          )
        )
      }

      const markdown = (reading.markdown ?? '').replace(/\r\n/g, '\n')
      const text = markdown.trim()
      if (text === '') {
        /*
         * ⚠️ 扫描件 / 空文件 ⇒ **没有成功阅读事实**（计划书 §4A 文档第 ⑤ 组的判据）。
         *    返回 `not_found`（"没有可读的文字"），**不是** success + 空正文：
         *    后者会让回复层以为"读到了，只是内容为空"。
         *
         * ⚠️ **两种情况必须可分辨**（实测逼出来，2026-10-04）：0 字节的"空文件"与
         *    "有字节但没有文字层"的扫描件是**两件事** —— 说成一样等于说错失败原因
         *    （"这份文件是空的"与"这份文件是扫描件，首版读不出文字"用户要做的事不同）。
         */
        const empty = bytes.length === 0
        throw new ActionFailureError(
          actionFailure(
            'target_not_found',
            empty
              ? '文件是空的（0 字节）：没有任何内容可读'
              : '文件里没有可提取的文字（很可能是扫描件或图片型页面）：首版如实报告，不猜测内容'
          )
        )
      }

      const totalChars = text.length
      const capped = text.slice(0, 60_000)
      const structure = structureOf(text, verdict.format)
      const content: DocumentTurnContent = {
        contentId: `${String(input.actionId)}:document`,
        kind: 'document',
        capability: DOCUMENT_READ,
        operation: DOCUMENT_READ_OPERATION,
        sourceKind: resolution.sourceKind,
        resourceRef: resolution.resourceRef,
        sourceFingerprint: sha256(bytes),
        resultFingerprint: sha256(text),
        scope: {
          totalChars,
          includedChars: capped.length,
          truncated: capped.length < totalChars,
        },
        facts: [
          `文件：${relativePath}`,
          `格式：${verdict.format}（按扩展名与文件头一致判定）`,
          `字节数：${String(bytes.length)}`,
          `提取字符数：${String(totalChars)}`,
          `结构：${structure.join(' · ')}`,
          `转换器：MarkItDown convert_stream（本地专属环境，关闭插件）`,
        ],
        text: capped,
        mediaType: verdict.format,
        structure,
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: 'content_read',
          detail: `文档正文：${relativePath}（${verdict.format}，${String(text.length)} 字符）`,
          fingerprint: content.resultFingerprint,
          bytes: bytes.length,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `document.read ${verdict.format} bytes=${String(bytes.length)} ` +
              `chars=${String(text.length)}`,
            ref: resolution.resourceRef,
          },
        ],
        turnContent,
      }
    },
  }
}
