/**
 * `local.file.list/read/write` 适配器（第二批计划 §2.1 第 1–6 点）。
 *
 * ============================================================================
 *  它与 `sandbox-filesystem.ts` 是**两套**，因为守卫的方向相反
 * ============================================================================
 * ```text
 * sandbox-filesystem.ts   根**内**包含性：candidate 必须在 rootAbs 之下，否则 permission_denied
 * local-filesystem.ts     域**内**包含性：candidate 必须仍在**本地卷**上，否则 permission_denied
 * ```
 * 后者要挡的不是"跳出根"，而是"跳出去之后变成了网络/设备"：NTFS junction 或
 * symlink 可以把 `C:\work\out` 指到 `\\server\share`。因此这里的守卫是：
 *
 * ```text
 * ① 语法院（local-path.ts）：UNC / 设备命名空间 / 保留设备名 / ADS / .. 出卷根 一律拒绝
 * ② **重解析点守卫**（本文件）：对已存在的祖先做 realpath，把结果**再过一遍语法院** ——
 *    若 realpath 之后变成了 `\\server\share\…`，语法院会以 `unc` 拒绝
 * ③ 规模守卫：读 ≤ 10 MiB（计划书 §3.2 的单文件上限）
 * ```
 *
 * ============================================================================
 *  写入的三段式（计划书 §2.1 第 4、5 点）
 * ============================================================================
 * ```text
 * ① 载荷**经私有暂存**传递：`arguments` 里只有 payloadRef / bytes / fingerprint
 * ② 覆盖前把原字节复制到**恢复副本**（位置与前后指纹进证据，可查）
 * ③ 写到**同目录**的临时文件 → 校验指纹 → rename 提交
 *    （同目录 rename 在 NTFS 上是原子的；跨卷 rename 会退化成复制+删除，
 *      那正是"提交到一半断电"会产生半个文件的形状）
 * ④ 覆盖前比对 `expectedOriginalFingerprint`（任务内先前读到的那一个）：
 *    不一致 ⇒ **不写**，如实报 concurrent_modification
 * ```
 * ⚠️ 恢复副本**只针对明确目标**（计划书 §7）：它不做整盘恢复，也不删历史记录。
 */

import { randomBytes, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import {
  LOCAL_FILE_LIST,
  LOCAL_FILE_LIST_OPERATION,
  LOCAL_FILE_READ,
  LOCAL_FILE_READ_OPERATION,
  LOCAL_FILE_WRITE,
  LOCAL_FILE_WRITE_OPERATION,
} from '../../../kernel/action/local-file-capabilities.ts'
import { inspectLocalPath } from '../../../kernel/action/local-path.ts'
import { fnv1a64Hex } from '../../../kernel/action/idempotency.ts'
import type { PayloadStagingPort } from '../../../kernel/action/payload-staging.ts'
import { TURN_CONTENT_LIMITS } from '../../../kernel/contracts/turn-content.ts'
import type { LocalTextTurnContent, TurnContent } from '../../../kernel/contracts/turn-content.ts'

export const LOCAL_FILE_LIMITS = {
  /** 计划书 §3.2：单文件 10 MiB */
  maxFileBytes: 10 * 1024 * 1024,
  /** 目录列举一次最多返回多少条目（分页；不是"扫全盘"） */
  maxListEntries: 500,
  /** 列举结果作为当轮内容的字符上限 */
  maxListChars: 20_000,
  /** 文本判定的采样字节数 */
  sniffBytes: 8192,
} as const

/**
 * 解析本机绝对路径 + **重解析点守卫**。
 *
 * ⚠️ 这是**唯一**把"用户给的字符串"变成"要碰的真实路径"的地方；
 *    三个适配器与文档/OCR 的跨域入口都走它。
 */
export async function resolveLocalAbsolutePath(raw: string): Promise<{
  absolutePath: string
  /** realpath 之后的最终位置（用于"最终位置是不是还在本地卷"的判据） */
  finalPath: string
}> {
  const verdict = inspectLocalPath(raw)
  if (!verdict.ok) {
    throw new ActionFailureError(
      actionFailure('permission_denied', `本机文件域拒绝这个路径：${verdict.detail}`)
    )
  }
  const absolutePath = verdict.absolutePath

  /*
   * ② 重解析点守卫：对**最近的已存在祖先**做 realpath，把结果再过一遍语法院。
   *
   * 为什么不直接 realpath(absolutePath)：目标可能还不存在（写操作的新建目标），
   * 而 `realpath` 对不存在的路径会 ENOENT —— 那会把"新建一个合法文件"
   * 变成一次失败。对祖先做，既覆盖了 junction/symlink 的场景，
   * 又不要求目标已存在。
   */
  let ancestor = absolutePath
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  let finalPath = absolutePath
  if (existsSync(ancestor)) {
    const real = await realpath(ancestor)
    const realVerdict = inspectLocalPath(real)
    if (!realVerdict.ok) {
      throw new ActionFailureError(
        actionFailure(
          'permission_denied',
          `这个路径经重解析点（junction / symlink）指到了本机文件域之外：` +
            `${verdict.absolutePath} → ${real}（${realVerdict.detail}）`
        )
      )
    }
    if (existsSync(absolutePath)) finalPath = await realpath(absolutePath)
    else finalPath = join(real, absolutePath.slice(ancestor.length).replace(/^[\\/]+/, ''))
  }
  return { absolutePath, finalPath }
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 媒体类型表（**程序**按扩展名 + 字节嗅探判定；不由模型说） */
const TEXT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.ps1': 'text/plain',
  '.sh': 'text/plain',
  '.py': 'text/plain',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.mjs': 'text/plain',
  '.cjs': 'text/plain',
  '.sql': 'text/plain',
  '.env': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.toml': 'application/toml',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
}

export interface TextVerdict {
  isText: boolean
  mediaType: string
  /** 为什么判成二进制（只用于如实说明） */
  reason?: string
}

/**
 * 文本 / 二进制判定。
 *
 * ⚠️ 判据是**字节**，不是扩展名：一个 `.txt` 里装的是 PNG 仍然不是文本。
 *    这与 `document-read.ts` 的"扩展名 + 魔数一致"是同一条纪律
 *    （"伪装格式不是猜一个转换器试试，而是明确降档"）。
 */
export function inspectTextLike(path: string, bytes: Buffer): TextVerdict {
  const mediaType = TEXT_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'text/plain'
  const sample = bytes.subarray(0, LOCAL_FILE_LIMITS.sniffBytes)
  if (sample.includes(0)) {
    return { isText: false, mediaType, reason: '样本里含 NUL 字节（二进制）' }
  }
  let control = 0
  for (const byte of sample) {
    // 允许 \t(9) \n(10) \r(13) \f(12) \b(8) 与 >=0x20 的可打印字节
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 8) {
      control += 1
    }
  }
  if (sample.length > 0 && control / sample.length > 0.1) {
    return {
      isText: false,
      mediaType,
      reason: `样本里控制字符占 ${String(Math.round((control / sample.length) * 100))}%（二进制）`,
    }
  }
  return { isText: true, mediaType }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface LocalFilesystemOptions {
  maxListEntries?: number
  maxFileBytes?: number
}

export function createLocalListAdapter(options: LocalFilesystemOptions = {}): CapabilityAdapter {
  const maxEntries = options.maxListEntries ?? LOCAL_FILE_LIMITS.maxListEntries
  return {
    capabilityId: LOCAL_FILE_LIST,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const raw = pathOf(input)
      const { absolutePath } = await resolveLocalAbsolutePath(raw)

      let info
      try {
        info = await stat(absolutePath)
      } catch (error) {
        throw new ActionFailureError(
          actionFailure('target_not_found', `读不到这个目录：${raw}（${(error as Error).message}）`)
        )
      }
      if (!info.isDirectory()) {
        throw new ActionFailureError(
          actionFailure('unsupported', `${raw} 不是一个目录，没法列举（读文件请用 local.file.read）`)
        )
      }

      const dirents = await readdir(absolutePath, { withFileTypes: true })
      const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name))
      const capped = sorted.slice(0, maxEntries)
      const truncated = sorted.length > capped.length

      const lines = capped.map((entry) => {
        const kind = entry.isDirectory() ? 'dir ' : entry.isFile() ? 'file' : 'other'
        return `${kind}  ${entry.name}`
      })
      const header = `目录：${absolutePath}`
      const footer = truncated
        ? `（共 ${String(sorted.length)} 条，只列出前 ${String(capped.length)} 条 —— **不是全部**）`
        : `（共 ${String(sorted.length)} 条，已全部列出）`
      const text = [header, ...lines, footer].join('\n')
      const shaped = text.slice(0, LOCAL_FILE_LIMITS.maxListChars)

      const content: LocalTextTurnContent = {
        contentId: `${String(input.actionId)}:local-list`,
        kind: 'local-text',
        capability: LOCAL_FILE_LIST,
        operation: LOCAL_FILE_LIST_OPERATION,
        sourceKind: 'local-disk',
        resourceRef: absolutePath,
        resultFingerprint: sha256(text),
        scope: {
          totalChars: text.length,
          includedChars: shaped.length,
          truncated: shaped.length < text.length,
        },
        facts: [
          `目录：${absolutePath}`,
          `条目数：${String(sorted.length)}（列出 ${String(capped.length)}）`,
          `截断：${truncated ? '是（只列了前一部分）' : '否'}`,
          '内容类型：目录列举（不含文件正文）',
        ],
        text: shaped,
        mediaType: 'text/x-directory-listing',
        lineCount: shaped.split('\n').length,
        sourceBytes: Buffer.byteLength(text, 'utf8'),
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: 'content_read',
          detail: `列举目录 ${absolutePath}（${String(capped.length)}/${String(sorted.length)} 条）`,
          fingerprint: content.resultFingerprint,
        },
        evidence: [
          {
            kind: 'filesystem',
            detail: `本机目录列举：${absolutePath} · 条目 ${String(sorted.length)}`,
            ref: absolutePath,
          },
        ],
        turnContent,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function createLocalReadAdapter(options: LocalFilesystemOptions = {}): CapabilityAdapter {
  const maxFileBytes = options.maxFileBytes ?? LOCAL_FILE_LIMITS.maxFileBytes
  return {
    capabilityId: LOCAL_FILE_READ,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const raw = pathOf(input)
      const { absolutePath } = await resolveLocalAbsolutePath(raw)

      let info
      try {
        info = await stat(absolutePath)
      } catch (error) {
        throw new ActionFailureError(
          actionFailure('target_not_found', `读不到这个文件：${raw}（${(error as Error).message}）`)
        )
      }
      if (!info.isFile()) {
        throw new ActionFailureError(
          actionFailure(
            'target_not_found',
            info.isDirectory()
              ? `${raw} 是目录，不是文件（列举目录请用 local.file.list）`
              : `${raw} 不是普通文件`
          )
        )
      }
      if (info.size > maxFileBytes) {
        throw new ActionFailureError(
          actionFailure(
            'unsupported',
            `文件 ${String(info.size)} 字节，超过单文件上限 ${String(maxFileBytes)}`
          )
        )
      }

      const bytes = await readFile(absolutePath)
      const verdict = inspectTextLike(absolutePath, bytes)
      if (!verdict.isText) {
        /*
         * ⚠️ 这里**不猜**、**不硬转**：一个非文本文件交给"文本读取"只会产生乱码，
         *    而乱码会被模型当成正文引用。如实说不支持，并指出该走哪个入口。
         */
        throw new ActionFailureError(
          actionFailure(
            'unsupported',
            `这个入口只解释文本类文件，${basename(absolutePath)} 不是文本（${verdict.reason ?? '二进制'}）。` +
              '文档请用 document.read，图片请用 image.ocr。'
          )
        )
      }

      const decoded = bytes.toString('utf8')
      const totalChars = decoded.length
      const text = decoded.slice(0, TURN_CONTENT_LIMITS.maxTextChars)
      const lineCount = decoded === '' ? 0 : decoded.split(/\r\n|\n|\r/).length

      const content: LocalTextTurnContent = {
        contentId: `${String(input.actionId)}:local-text`,
        kind: 'local-text',
        capability: LOCAL_FILE_READ,
        operation: LOCAL_FILE_READ_OPERATION,
        sourceKind: 'local-disk',
        resourceRef: absolutePath,
        sourceFingerprint: sha256(bytes),
        resultFingerprint: sha256(text),
        scope: {
          totalChars,
          includedChars: text.length,
          truncated: text.length < totalChars,
        },
        facts: [
          `文件：${absolutePath}`,
          `媒体类型：${verdict.mediaType}（按扩展名与字节嗅探判定）`,
          `字节数：${String(bytes.length)}`,
          `字符数：${String(totalChars)} · 行数：${String(lineCount)}`,
          `截断：${text.length < totalChars ? `是（只读到前 ${String(text.length)} 字符）` : '否'}`,
        ],
        text,
        mediaType: verdict.mediaType,
        lineCount,
        sourceBytes: bytes.length,
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: 'content_read',
          detail: `本机文件正文：${absolutePath}（${String(bytes.length)} 字节 / ${String(totalChars)} 字符）`,
          fingerprint: content.resultFingerprint,
          bytes: bytes.length,
        },
        evidence: [
          {
            kind: 'filesystem',
            detail:
              `本机文件读取：${absolutePath} · 字节 ${String(bytes.length)} · 字符 ${String(totalChars)}` +
              ` · mediaType=${verdict.mediaType}`,
            ref: absolutePath,
          },
        ],
        turnContent,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export interface LocalWriteOptions extends LocalFilesystemOptions {
  /** 恢复副本根（装配层注入；**不**由适配器推导） */
  recoveryRoot: string
  /** 私有暂存（写入载荷的唯一来源） */
  staging: PayloadStagingPort
  now?: () => number
}

export function createLocalWriteAdapter(options: LocalWriteOptions): CapabilityAdapter {
  const maxFileBytes = options.maxFileBytes ?? LOCAL_FILE_LIMITS.maxFileBytes
  const now = options.now ?? (() => Date.now())

  return {
    capabilityId: LOCAL_FILE_WRITE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const raw = pathOf(input)
      const payloadRef = stringArg(input.args, 'payloadRef')
      if (payloadRef === undefined || payloadRef === '') {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            '写文件缺少 payloadRef —— 正文必须经私有暂存传递，不接受直接放在参数里的 content'
          )
        )
      }
      const staged = options.staging.read(payloadRef)
      if (staged === undefined) {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            `载荷 ${payloadRef} 不在私有暂存里（过期或从未放入）—— 拒绝凭引用写一个取不到内容的文件`
          )
        )
      }
      const bytes =
        staged.kind === 'text'
          ? Buffer.from(staged.text, 'utf8')
          : staged.kind === 'base64'
            ? Buffer.from(staged.base64, 'base64')
            : Buffer.from(staged.json, 'utf8')

      if (bytes.length > maxFileBytes) {
        throw new ActionFailureError(
          actionFailure(
            'unsupported',
            `载荷 ${String(bytes.length)} 字节，超过单文件上限 ${String(maxFileBytes)}`
          )
        )
      }
      const payloadFingerprint = sha256(bytes)
      /*
       * ⚠️ 声明的指纹用**与 kernel 侧同一个算法**核对（`fnv1a64`）。
       *
       * 计划侧（`task-loop.ts` 的 `stagePayloadArgs`）只能算 `fnv1a64` —— kernel
       * 不依赖 Node 的 crypto。如果这里拿 sha256 去比，每一次写入都会被判成
       * "载荷指纹不一致" —— 那正是本批整定期实测到的那条假红。
       * ⇒ 两个指纹**各有用途、不可互比**：`fnv1a64` 管"参数里声明的是不是
       *    暂存里那一份"，`sha256` 管"落盘的字节是不是要写的字节"。
       */
      const declaredFingerprint = stringArg(input.args, 'payloadFingerprint')
      if (declaredFingerprint !== undefined) {
        const declaredSource =
          staged.kind === 'text'
            ? staged.text
            : staged.kind === 'json'
              ? staged.json
              : staged.base64
        if (declaredFingerprint !== fnv1a64Hex(declaredSource)) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              '载荷指纹与参数里声明的不一致 —— 拒绝写一份"不知道是不是它"的字节'
            )
          )
        }
      }

      const { absolutePath } = await resolveLocalAbsolutePath(raw)
      const existed = existsSync(absolutePath)

      /*
       * ④ 并发修改检查（计划书 §2.1 第 5 点）。
       *
       * 只有在**调用方给出了它读到的原文件指纹**时才能查 —— 而调用方（任务执行环）
       * 在"先读后写"的任务里一定给得出。没给就是"这一次写入不基于任何先前读取"，
       * 那是另一种情形（新建 / 显式覆盖），如实记 `concurrencyChecked: false`。
       */
      const expected = stringArg(input.args, 'expectedOriginalFingerprint')
      let beforeFingerprint: string | undefined
      let backupPath: string | undefined
      if (existed) {
        const before = await readFile(absolutePath)
        beforeFingerprint = sha256(before)
        if (expected !== undefined && expected !== beforeFingerprint) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `文件在这次操作之前被改动过（读到的是 ${expected.slice(0, 12)}，现在是 ` +
                `${beforeFingerprint.slice(0, 12)}）—— 拒绝用旧内容覆盖新编辑`,
              { reason: 'concurrent_modification', path: absolutePath }
            )
          )
        }
        /*
         * ② 恢复副本：**覆盖前**把原字节复制到恢复根。
         *    名字里带前后指纹前缀 ⇒ "恢复副本对应哪一次覆盖"可以逐字核对。
         */
        const stamp = new Date(now()).toISOString().replace(/[-:.]/g, '')
        backupPath = join(
          options.recoveryRoot,
          stamp.slice(0, 8),
          `${basename(absolutePath)}.${stamp}.${beforeFingerprint.slice(0, 8)}.bak`
        )
        await mkdir(dirname(backupPath), { recursive: true })
        await copyFile(absolutePath, backupPath)
      }

      // ③ 临时文件 → 校验 → rename 提交（同目录，NTFS 上是原子替换）
      await mkdir(dirname(absolutePath), { recursive: true })
      const tempPath = join(
        dirname(absolutePath),
        `.${basename(absolutePath)}.lg-tmp-${randomBytes(6).toString('hex')}`
      )
      await writeFile(tempPath, bytes)
      const written = await readFile(tempPath)
      if (sha256(written) !== payloadFingerprint) {
        await unlink(tempPath).catch(() => undefined)
        throw new ActionFailureError(
          actionFailure('execution_failed', '临时文件校验失败（写下去的不是要写的字节），未提交')
        )
      }
      try {
        await rename(tempPath, absolutePath)
      } catch (error) {
        await unlink(tempPath).catch(() => undefined)
        throw error
      }

      const afterBytes = await readFile(absolutePath)
      const afterFingerprint = sha256(afterBytes)
      const factsCommitted = afterFingerprint === payloadFingerprint

      return {
        effect: {
          kind: existed ? 'file_overwritten' : 'file_created',
          detail:
            `${existed ? '覆盖' : '创建'} ${absolutePath}（${String(bytes.length)} 字节）` +
            `${backupPath !== undefined ? ` · 恢复副本 ${backupPath}` : ''}`,
          fingerprint: afterFingerprint,
          bytes: bytes.length,
        },
        evidence: [
          {
            kind: 'filesystem',
            detail:
              `本机文件写入：${absolutePath} · 字节 ${String(bytes.length)}` +
              ` · 提交后指纹一致=${String(factsCommitted)}` +
              ` · 并发检查=${String(expected !== undefined)}` +
              `${beforeFingerprint !== undefined ? ` · 覆盖前指纹 ${beforeFingerprint}` : ''}` +
              `${backupPath !== undefined ? ` · 恢复副本 ${backupPath}` : ''}`,
            ref: absolutePath,
          },
          ...(backupPath !== undefined
            ? [
                {
                  kind: 'adapter' as const,
                  detail: `覆盖前原始字节的恢复副本（只针对这一个目标）`,
                  ref: backupPath,
                },
              ]
            : []),
        ],
      }
    },
  }
}

function pathOf(input: AdapterExecuteInput): string {
  const canonical = input.target.canonicalId
  if (canonical !== undefined && canonical !== '') return canonical
  const fromArgs = stringArg(input.args, 'path')
  if (fromArgs !== undefined && fromArgs !== '') return fromArgs
  throw new ActionFailureError(
    actionFailure('validation_failed', '适配器没有拿到路径：目标与参数里都没有 path')
  )
}
