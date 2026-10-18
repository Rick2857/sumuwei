/**
 * `office.generate` 适配器（第二批计划 §3.2）。
 *
 * ============================================================================
 *  它与 `local-filesystem.ts` 的写入段共用同一套提交纪律
 * ============================================================================
 * ```text
 * ① 规格**经私有暂存**传递（`specRef`），账本里只有引用与指纹
 * ② 覆盖前留**恢复副本** + 并发修改检查（与 local.file.write 同一条）
 * ③ 生成器写到**同目录的临时文件** → 校验指纹 → rename 提交
 * ④ 生成器**重新打开**产物做结构读回（三类各自的读回函数在 Python 侧）
 * ```
 *
 * ============================================================================
 *  不接受任意代码执行（计划书 §3.2 逐字）
 * ============================================================================
 * 参数里**没有** `code` / `script`；规格是一份**闭集**的结构化 JSON，
 * 由 `scripts/productivity-skills/office-generate.py`（本仓库固定版本）解释。
 * 未知块类型、未知字段、超限规模都在 Python 侧**拒收整条**（`ok:false`）。
 * TypeScript 侧只做**形状闸**（format 闭集、路径、引用可取），
 * 语义校验留给唯一的执行者 —— 两份校验迟早会分叉。
 *
 * ⚠️ 它**不**静默安装 Microsoft Office / WPS / LibreOffice（计划书 §3.2）：
 *    首版交付的是可编辑文件；"排版视觉查看"另行登记为待办。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree } from './kill-process-tree.ts'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import {
  OFFICE_FORMATS,
  OFFICE_GENERATE,
  OFFICE_GENERATE_OPERATION,
  type OfficeFormat,
} from '../../../kernel/action/office-capability.ts'
import type { PayloadStagingPort } from '../../../kernel/action/payload-staging.ts'
import { resolveLocalAbsolutePath } from './local-filesystem.ts'
import { fnv1a64Hex } from '../../../kernel/action/idempotency.ts'
import type { DocumentTurnContent, TurnContent } from '../../../kernel/contracts/turn-content.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

export const OFFICE_GENERATOR_SCRIPT = join(
  REPO_ROOT,
  'scripts',
  'productivity-skills',
  'office-generate.py'
)

/**
 * 专属 Python 解释器 —— **复用第一批建的 venv**（计划书 §1：三个库已装好）。
 * ⚠️ 刻意不新建、不复制：复制会产生第二份事实来源。
 *
 * ⚠️ 2026-10-16（服务器 Linux 适配 · 复核 §4 补上）：
 *   这一段原来也是**写死的分段 `join(…,'Scripts','python.exe')`**，
 *   而我第一轮的 S5 判据只找**单个字符串字面量** ⇒ **看不见分段 join，给了假绿**。
 *   现在与 document-read / rapid-ocr / desktop / arxiv **同形**：
 *   环境变量优先，缺省值按平台挑形状。
 *   不设环境变量时，Windows 上的路径与改动前**逐字相同**。
 */
export const OFFICE_PYTHON = process.env.PROJECT_LG_OFFICE_PYTHON ?? join(
  REPO_ROOT,
  'artifacts',
  'post-lv2',
  'local',
  'utility-skills-preparation',
  'python',
  'venv',
  process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')
)

export const OFFICE_LIMITS = {
  timeoutMs: 60_000,
  maxFileBytes: 10 * 1024 * 1024,
  /** 规格 JSON 的上限（与 `TASK_ARG_KEYS` 的体积闸同规） */
  maxSpecBytes: 2 * 1024 * 1024,
} as const

export interface OfficeGenerateOptions {
  recoveryRoot: string
  staging: PayloadStagingPort
  pythonPath?: string
  generatorPath?: string
  timeoutMs?: number
  now?: () => number
}

interface GeneratorReading {
  ok: boolean
  bytes?: number
  summary?: Record<string, unknown>
  readback?: Record<string, unknown>
  errorType?: string
  error?: string
  timedOut: boolean
  exitCode: number | null
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function killTree(child: ChildProcess | undefined): void {
  /*
   * ⚠️ 2026-10-16：本地这份 `spawn('taskkill')` 已**删除**，改用共享的跨平台助手。
   *   原写法在 Linux 上不是"杀不掉"，而是会在一次工具超时后**打崩整个核心**
   *   （`spawn` 找不到命令是**异步** `'error'`，原来的 `try/catch` 接不到）。
   *   判据仍是"父进程不等它"，不是"杀干净了"。见 `kill-process-tree.ts`。
   */
  killProcessTree(child)
}

export function createOfficeGenerateAdapter(options: OfficeGenerateOptions): CapabilityAdapter {
  const pythonPath = options.pythonPath ?? OFFICE_PYTHON
  const generatorPath = options.generatorPath ?? OFFICE_GENERATOR_SCRIPT
  const timeoutMs = options.timeoutMs ?? OFFICE_LIMITS.timeoutMs
  const now = options.now ?? (() => Date.now())

  return {
    capabilityId: OFFICE_GENERATE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const rawPath = stringArg(input.args, 'path') ?? input.target.canonicalId ?? ''
      if (rawPath === '') {
        throw new ActionFailureError(
          actionFailure('validation_failed', '没有给出输出文件路径', { reason: 'missing_path' })
        )
      }
      const formatRaw = (stringArg(input.args, 'format') ?? '').toLowerCase()
      if (!(OFFICE_FORMATS as readonly string[]).includes(formatRaw)) {
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            `首版只支持 ${OFFICE_FORMATS.join(' / ')}，收到「${formatRaw === '' ? '(空)' : formatRaw}」`,
            { reason: 'bad_format' }
          )
        )
      }
      const format = formatRaw as OfficeFormat

      const specRef = stringArg(input.args, 'specRef')
      if (specRef === undefined || specRef === '') {
        /*
         * ⚠️ 这一条有一个**实测来源**（2026-10-04 真模型 live）：模型常常只给
         *    `path` + `format` 而不给 `spec`（它以为对着读到的正文就能生成）
         *    ⇒ 这里如实拒绝，并把**闭集原因**放进 `details.reason`，
         *    这样"为什么没生成"在诊断面上可读，而不是只能看到一句 `validation_failed`。
         */
        throw new ActionFailureError(
          actionFailure(
            'validation_failed',
            '缺少 specRef —— 规格必须经私有暂存传递（不接受直接放在参数里的 spec）',
            { reason: 'missing_spec_ref' }
          )
        )
      }
      const staged = options.staging.read(specRef)
      if (staged === undefined || staged.kind !== 'json') {
        throw new ActionFailureError(
          actionFailure('validation_failed', `规格 ${specRef} 不在私有暂存里（或不是 JSON）`, {
            reason: 'spec_not_staged',
          })
        )
      }
      const specText = staged.json
      if (Buffer.byteLength(specText, 'utf8') > OFFICE_LIMITS.maxSpecBytes) {
        throw new ActionFailureError(
          actionFailure('unsupported', '规格超过体积上限', { reason: 'spec_too_large' })
        )
      }
      const specFingerprint = sha256(specText)
      /*
       * ⚠️ 声明的指纹用**与 kernel 侧同一个算法**核对（`fnv1a64`）——
       *    计划侧算不了 sha256（kernel 不依赖 Node 的 crypto）。
       *    两个指纹各有用途、不可互比：`fnv1a64` 管"参数里声明的是不是暂存里那一份"，
       *    `sha256` 管"落盘的字节是不是要写的那一份"。
       */
      const declared = stringArg(input.args, 'specFingerprint')
      if (declared !== undefined && declared !== fnv1a64Hex(specText)) {
        throw new ActionFailureError(
          actionFailure('validation_failed', '规格指纹与参数里声明的不一致 —— 拒绝生成', {
            reason: 'spec_fingerprint_mismatch',
          })
        )
      }

      if (!existsSync(pythonPath)) {
        throw new ActionFailureError(
          actionFailure('unsupported', `专属 Python 环境不存在：${pythonPath}`)
        )
      }
      if (!existsSync(generatorPath)) {
        throw new ActionFailureError(
          actionFailure('unsupported', `生成器脚本不存在：${generatorPath}`)
        )
      }

      const { absolutePath } = await resolveLocalAbsolutePath(rawPath)
      const existed = existsSync(absolutePath)
      const expected = stringArg(input.args, 'expectedOriginalFingerprint')
      let beforeFingerprint: string | undefined
      let backupPath: string | undefined
      if (existed) {
        const info = await stat(absolutePath)
        if (!info.isFile()) {
          throw new ActionFailureError(
            actionFailure('unsupported', `${absolutePath} 不是普通文件，不能覆盖`)
          )
        }
        const before = await readFile(absolutePath)
        beforeFingerprint = sha256(before)
        if (expected !== undefined && expected !== beforeFingerprint) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `文件在这次操作之前被改动过（读到的是 ${expected.slice(0, 12)}，现在是 ` +
                `${beforeFingerprint.slice(0, 12)}）—— 拒绝用新产物覆盖别人的编辑`,
              { reason: 'concurrent_modification', path: absolutePath }
            )
          )
        }
        const stamp = new Date(now()).toISOString().replace(/[-:.]/g, '')
        backupPath = join(
          options.recoveryRoot,
          stamp.slice(0, 8),
          `${basename(absolutePath)}.${stamp}.${beforeFingerprint.slice(0, 8)}.bak`
        )
        await mkdir(dirname(backupPath), { recursive: true })
        await copyFile(absolutePath, backupPath)
      }

      await mkdir(dirname(absolutePath), { recursive: true })
      const suffix = `.${format}`
      const tempPath = join(
        dirname(absolutePath),
        `.${basename(absolutePath).replace(/\.[^.]+$/, '')}.lg-office-tmp-${randomBytes(6).toString('hex')}${suffix}`
      )
      const specPath = join(
        tmpdir(),
        `lg-office-spec-${randomBytes(6).toString('hex')}.json`
      )
      await writeFile(specPath, specText, 'utf8')

      let reading: GeneratorReading
      try {
        reading = await runGenerator({
          pythonPath,
          generatorPath,
          format,
          specPath,
          outPath: tempPath,
          timeoutMs,
        })
      } finally {
        await unlink(specPath).catch(() => undefined)
      }

      if (reading.timedOut) {
        await unlink(tempPath).catch(() => undefined)
        throw new ActionFailureError(
          actionFailure('timeout', `生成器在 ${String(timeoutMs)}ms 内没有返回，进程树已被终结`, {
            reason: 'timeout',
          })
        )
      }
      if (!reading.ok) {
        await unlink(tempPath).catch(() => undefined)
        /*
         * ⚠️ 规格被拒（`spec_rejected` / `bad_spec`）是**用户/模型可修的错**
         *    ⇒ `validation_failed`；生成器自身炸了是 `execution_failed`。
         *    两者混成一个码会让"我该改规格"与"工具坏了"在回复层分不开。
         *
         * ⚠️ `details.reason` 用**生成器自报的闭集码**（`bad_spec` / `spec_rejected`
         *    / `generate_failed` / `no_output` / `bad_output` / `bad_spec_file`）
         *    —— 它进诊断面，因此必须是一个短码而不是自由文本。
         */
        const code =
          reading.errorType === 'spec_rejected' || reading.errorType === 'bad_spec'
            ? 'validation_failed'
            : 'execution_failed'
        throw new ActionFailureError(
          actionFailure(
            code,
            `办公文件生成失败（${reading.errorType ?? 'unknown'}）：${reading.error ?? ''}`.slice(0, 400),
            { reason: reading.errorType ?? 'generator_failed' }
          )
        )
      }

      const tempBytes = await readFile(tempPath)
      if (tempBytes.length === 0) {
        await unlink(tempPath).catch(() => undefined)
        throw new ActionFailureError(
          actionFailure('execution_failed', '生成器报成功，但产物是 0 字节文件 —— 未提交', {
            reason: 'empty_output',
          })
        )
      }
      const resultFingerprint = sha256(tempBytes)
      await rename(tempPath, absolutePath)

      const summary = reading.summary ?? {}
      const readback = reading.readback ?? {}
      const missingCount = typeof readback.missingCount === 'number' ? readback.missingCount : 0

      const facts = [
        `产物：${absolutePath}`,
        `格式：${format}（由固定版本的 Python 生成器写出并**重新打开**读回）`,
        `字节数：${String(tempBytes.length)}`,
        `生成读数：${JSON.stringify(summary)}`,
        `读回读数：${JSON.stringify(readback)}`,
        missingCount === 0
          ? '读回校验：规格里点名的文本/列都在产物里'
          : `读回校验：有 ${String(missingCount)} 处规格点名的内容**没有**在产物里`,
        backupPath !== undefined
          ? `覆盖前已留恢复副本：${backupPath}`
          : '这是一次新建（没有覆盖，因此没有恢复副本）',
        '排版视觉查看：首版**未做**（没有已验证的渲染器；XML 可读 ≠ 视觉排版已通过）',
      ]

      const digest = [
        `# ${format.toUpperCase()} 产物读回`,
        `路径：${absolutePath}`,
        `字节数：${String(tempBytes.length)}`,
        `生成：${JSON.stringify(summary)}`,
        `读回：${JSON.stringify(readback)}`,
      ].join('\n')

      const content: DocumentTurnContent = {
        contentId: `${String(input.actionId)}:office`,
        kind: 'document',
        capability: OFFICE_GENERATE,
        operation: OFFICE_GENERATE_OPERATION,
        sourceKind: 'local-disk',
        resourceRef: absolutePath,
        sourceFingerprint: specFingerprint,
        resultFingerprint,
        scope: { totalChars: digest.length, includedChars: digest.length, truncated: false },
        facts,
        text: digest,
        mediaType: format,
        structure: Object.keys(readback),
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: existed ? 'file_overwritten' : 'file_created',
          detail:
            `生成 ${format}：${absolutePath}（${String(tempBytes.length)} 字节）` +
            `${backupPath !== undefined ? ` · 恢复副本 ${backupPath}` : ''}`,
          fingerprint: resultFingerprint,
          bytes: tempBytes.length,
        },
        evidence: [
          {
            kind: 'filesystem',
            detail:
              `office.generate ${format} · 字节 ${String(tempBytes.length)}` +
              ` · 读回缺失 ${String(missingCount)} · 并发检查=${String(expected !== undefined)}` +
              `${backupPath !== undefined ? ` · 恢复副本 ${backupPath}` : ''}`,
            ref: absolutePath,
          },
          /*
           * ⚠️ 恢复副本单独成一条 `adapter` 证据（与 `local.file.write` 同形）：
           *    调用方（任务环 / 报告 / 验收门）据此**按 kind 找到副本位置**，
           *    而不必去解析一句自由文本。
           */
          ...(backupPath !== undefined
            ? [
                {
                  kind: 'adapter' as const,
                  detail: '覆盖前原始字节的恢复副本（只针对这一个目标）',
                  ref: backupPath,
                },
              ]
            : []),
        ],
        turnContent,
      }
    },
  }
}

async function runGenerator(input: {
  pythonPath: string
  generatorPath: string
  format: string
  specPath: string
  outPath: string
  timeoutMs: number
}): Promise<GeneratorReading> {
  const child = spawn(
    input.pythonPath,
    [input.generatorPath, '--format', input.format, '--spec', input.specPath, '--out', input.outPath],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      /* ⚠️ 2026-10-16（服务器 Linux 适配）：非 win32 时**自建进程组**，
         好让 `killProcessTree()` 能用 `kill(-pid)` 带走整棵树。
         刻意只在非 win32 开 —— Windows 上 `detached: true` 会改变子进程存活语义。 */
      detached: process.platform !== 'win32',
      /*
       * ======================================================================
       *  ⚠️ 必须显式要求 Python 用 UTF-8 说话（实测逼出来的）
       * ======================================================================
       * Windows 上 CPython 的 stdout 默认走**系统代码页**（中文机器上是 cp936/GBK）。
       * 生成器用 `json.dumps(..., ensure_ascii=False)` 打印读回读数，里面有中文
       * 工作表名 / 幻灯片标题 ⇒ 那些字被编成 GBK，而 Node 按 UTF-8 解码
       * ⇒ **当轮内容里出现乱码**（`"sheetNames":["����","��ϸ"]`）。
       *
       * ⚠️ 文件本身是对的（openpyxl 在进程内处理 Unicode）；坏的是**读数通道**。
       *    而读数通道正是模型与报告看到的那一份 —— 所以它必须修。
       */
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }
  )
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

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, input.timeoutMs)

  const exitCode = await new Promise<number | null>((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code))
    child.on('error', () => resolvePromise(null))
  })
  clearTimeout(timer)

  const line = stdout
    .trim()
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .pop()
  if (line === undefined) {
    return {
      ok: false,
      errorType: timedOut ? 'timeout' : 'no_output',
      error: stderr.trim().slice(0, 400) || '生成器没有输出',
      timedOut,
      exitCode,
    }
  }
  try {
    const parsed = JSON.parse(line) as {
      ok?: boolean
      bytes?: number
      summary?: Record<string, unknown>
      readback?: Record<string, unknown>
      errorType?: string
      error?: string
    }
    return {
      ok: parsed.ok === true,
      ...(parsed.bytes !== undefined ? { bytes: parsed.bytes } : {}),
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      ...(parsed.readback !== undefined ? { readback: parsed.readback } : {}),
      ...(parsed.errorType !== undefined ? { errorType: parsed.errorType } : {}),
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      timedOut,
      exitCode,
    }
  } catch (error) {
    return {
      ok: false,
      errorType: 'bad_output',
      error: `生成器输出无法解析：${(error as Error).message}`,
      timedOut,
      exitCode,
    }
  }
}
