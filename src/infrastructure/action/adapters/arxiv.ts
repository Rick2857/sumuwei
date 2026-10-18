import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { ARXIV_RESEARCH } from '../../../kernel/action/learning-capabilities.ts'
import { killProcessTree } from './kill-process-tree.ts'
import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import type { LocalTextTurnContent } from '../../../kernel/contracts/turn-content.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
/*
 * ⚠️ 2026-10-16（服务器 Linux 适配）：
 *   原来这两行是**硬编码的 Windows 形状**（`artifacts/.../arxiv-venv` +
 *   `Scripts/python.exe`），**没有任何覆盖口** ⇒ 在 Linux 上 `arxiv` 一调必失败。
 *   现在与 `rapid-ocr-assets.ts` / `desktop-control-assets.ts` **同形**：
 *   环境变量优先，缺省值按平台挑形状。
 *   ⚠️ **不传环境变量时行为逐字不变**（win32 上两条路径与今天完全一致）。
 */
export const ARXIV_RUNTIME = process.env.PROJECT_LG_ARXIV_RUNTIME
  ?? join(REPO, 'artifacts', 'post-lv2', 'local', 'low-cost-skills', 'arxiv-venv')
export const ARXIV_PYTHON = process.env.PROJECT_LG_ARXIV_PYTHON
  ?? join(ARXIV_RUNTIME, process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'))
export const ARXIV_CACHE = join(REPO, 'data', 'arxiv-cache')
const WORKER = join(REPO, 'scripts', 'learning-skills', 'arxiv-worker.py')
const ASSETS = join(REPO, 'scripts', 'learning-skills', 'arxiv-assets.json')
export const ARXIV_LIMITS = { timeoutMs: 45_000, readTimeoutMs: 90_000, maxOutputBytes: 256 * 1024, maxChars: 16_000, contextChars: 5000 } as const
const PAPER_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/

/**
 * 这个 venv 的 **site-packages 目录**。
 *
 * ⚠️ 2026-10-16（服务器 Linux 适配 · 复核 §4）：
 *   `arxiv-assets.json` 里的键是**仓库相对路径**，且全部形如
 *   `…/arxiv-venv/Lib/site-packages/…` —— 那是 **Windows venv 布局**。
 *   Linux 的 venv 是 `lib/python3.X/site-packages`（注意 **`lib` 小写**、
 *   **多一层 python3.X**）⇒ 直接 `resolve(REPO, key)` 在 Linux 上**必然 ENOENT**，
 *   `verifyArxivRuntimeSync()` 会**永远返回 false**，`arxiv` 能力静默不可用。
 *
 *   ⚠️ 只加 `PROJECT_LG_ARXIV_PYTHON` **不够** —— 复核点名的正是这一点：
 *   "不能只验证 env 变量出现"。指纹校验必须**跟着一起适配**。
 *
 *   做法：**只取键里 `site-packages/` 之后的那段**，拼到本平台解析出来的
 *   site-packages 根上。指纹本身（sha256）是文件内容的，与路径无关。
 *   ⚠️ Windows 上解析出的根与清单键的前缀**逐字相同** ⇒ 行为完全不变。
 */
function arxivSitePackagesDir(): string | undefined {
  const venv = ARXIV_RUNTIME
  if (process.platform === 'win32') {
    const win = join(venv, 'Lib', 'site-packages')
    return existsSync(win) ? win : undefined
  }
  // POSIX：lib/python3.X/site-packages —— 列出 lib/ 下真实存在的那一个，不猜版本号
  const lib = join(venv, 'lib')
  if (!existsSync(lib)) return undefined
  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('python')) continue
    const candidate = join(lib, entry.name, 'site-packages')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function verifyArxivRuntimeSync(): boolean {
  try {
    if (!existsSync(ARXIV_PYTHON)) return false
    const manifest = JSON.parse(readFileSync(ASSETS, 'utf8')) as Record<string, string>
    const paths = Object.keys(manifest)
    if (paths.length === 0) return false
    const sitePackages = arxivSitePackagesDir()
    if (sitePackages === undefined) return false
    return paths.every((path) => {
      /*
       * ⚠️ 清单里**绝大多数**键形如 `.../Lib/site-packages/…`，但**不是全部**：
       *   `scripts/learning-skills/arxiv-server.py` 这类是**仓库相对路径**。
       *   ⇒ 只有**含** `site-packages/` 的键才拼到 site-packages 根上；
       *     其余按仓库相对路径解析（与改动前逐字一致）。
       *   这一条是本机实测补上的：先前把两类混为一谈，2/33 条 ENOENT，
       *   `verifyArxivRuntimeSync()` 从 true 变成 false —— 一个自己造成的能力静默下线。
       */
      const marker = 'site-packages/'
      const at = path.lastIndexOf(marker)
      const absolute = at === -1 ? resolve(REPO, path) : join(sitePackages, path.slice(at + marker.length))
      return createHash('sha256').update(readFileSync(absolute)).digest('hex') === manifest[path]
    })
  } catch { return false }
}

export function validateArxivArgs(operation: string, args: Record<string, unknown>): void {
  const keys = operation === 'search' ? ['query', 'limit'] : operation === 'read' ? ['paperId', 'section'] : ['paperId']
  if (!['search', 'abstract', 'read', 'cite'].includes(operation) || Object.keys(args).some((key) => !keys.includes(key))) {
    throw new ActionFailureError(actionFailure('validation_failed', 'arXiv 操作或参数不在固定清单内'))
  }
  if (operation === 'search') {
    if (typeof args.query !== 'string' || args.query.trim() === '' || args.query.length > 300 ||
        (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 5))) {
      throw new ActionFailureError(actionFailure('validation_failed', 'arXiv query 需为非空短查询，limit 为 1..5 整数'))
    }
  } else if (typeof args.paperId !== 'string' || args.paperId.length > 40 || !PAPER_ID.test(args.paperId) ||
      (args.section !== undefined && (typeof args.section !== 'string' || args.section.trim() === '' || args.section.length > 120))) {
    throw new ActionFailureError(actionFailure('validation_failed', '只接受合法 arXiv ID 和有界章节名，不接受 URL 或路径'))
  }
}

export interface ArxivReading { ok: boolean; text?: string; totalChars?: number; truncated?: boolean; calls?: string[]; failure?: string }

export async function runArxivWorker(operation: string, args: Record<string, unknown>, cache = ARXIV_CACHE, timeoutMs?: number): Promise<ArxivReading> {
  if (!verifyArxivRuntimeSync()) throw new ActionFailureError(actionFailure('execution_failed', 'arxiv_runtime_missing_or_invalid：独立运行环境缺失或指纹不符'))
  const env: NodeJS.ProcessEnv = { PYTHONUTF8: '1' }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return new Promise((resolveReading, reject) => {
    const child = spawn(ARXIV_PYTHON, ['-X', 'utf8', WORKER, cache], { env, cwd: ARXIV_RUNTIME, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      /* ⚠️ 2026-10-16（服务器 Linux 适配）：非 win32 时**自建进程组**，
         好让共享助手能用 `kill(-pid)` 带走整棵树。Windows 路径逐字不变。 */
      detached: process.platform !== 'win32' })
    const chunks: Buffer[] = []
    let bytes = 0, finished = false
    /*
     * ⚠️ 2026-10-16：这里原本是本文件**私有的**一份平台分支（win32 走 `taskkill /T /F`
     * 且挂了 `'error'`，否则走 `child.kill('SIGKILL')`）。它当时是**对的**，
     * 但那是**第二处**需要维护的同一份逻辑 ⇒ 收进共享助手，判据只剩一处。
     */
    const stop = (): void => { killProcessTree(child) }
    const fail = (code: 'timeout' | 'execution_failed', message: string): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stop()
      reject(new ActionFailureError(actionFailure(code, message)))
    }
    const timer = setTimeout(() => fail('timeout', 'arXiv 调用超时，本次未完成'), timeoutMs ?? (operation === 'read' ? ARXIV_LIMITS.readTimeoutMs : ARXIV_LIMITS.timeoutMs))
    child.on('error', () => fail('execution_failed', 'arXiv 独立进程启动失败'))
    child.stdin.on('error', () => fail('execution_failed', 'arXiv 独立进程输入失败'))
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > ARXIV_LIMITS.maxOutputBytes) fail('execution_failed', 'arXiv 响应超过上限')
      else chunks.push(chunk)
    })
    child.on('close', (code) => {
      if (finished) return
      try {
        if (code !== 0) throw new Error('worker_exit')
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ArxivReading
        if (result.ok !== true) {
          fail(result.failure === 'timeout' ? 'timeout' : 'execution_failed', 'arXiv 上游本次未返回可用结果')
          return
        }
        if (typeof result.text !== 'string' || result.text.length > ARXIV_LIMITS.maxChars ||
            !Number.isInteger(result.totalChars) || Number(result.totalChars) < result.text.length) throw new Error('worker_shape')
        finished = true
        clearTimeout(timer)
        resolveReading(result)
      } catch { fail('execution_failed', 'arXiv 独立进程返回了无效结果') }
    })
    child.stdin.end(JSON.stringify({ operation, args }))
  })
}

export function createArxivAdapter(options: { cache?: string; run?: typeof runArxivWorker } = {}): CapabilityAdapter {
  return {
    capabilityId: ARXIV_RESEARCH,
    async execute(input) {
      validateArxivArgs(input.operation, input.args)
      const reading = await (options.run ?? runArxivWorker)(input.operation, input.args, options.cache ?? ARXIV_CACHE)
      if (reading.ok !== true || typeof reading.text !== 'string' || reading.text.trim() === '' ||
          reading.text.length > ARXIV_LIMITS.maxChars || !Number.isInteger(reading.totalChars) ||
          Number(reading.totalChars) < reading.text.length) {
        throw new ActionFailureError(actionFailure('execution_failed', 'arXiv 本次没有返回有效内容'))
      }
      const text = reading.text.slice(0, ARXIV_LIMITS.contextChars)
      const fingerprint = createHash('sha256').update(text).digest('hex')
      const resourceRef = typeof input.args.paperId === 'string' ? `https://arxiv.org/abs/${input.args.paperId}` : 'https://export.arxiv.org/api/query'
      const content: LocalTextTurnContent = {
        contentId: `arxiv:${input.actionId}`, kind: 'local-text', capability: ARXIV_RESEARCH,
        operation: input.operation, sourceKind: 'remote-service', resourceRef, resultFingerprint: fingerprint,
        scope: { totalChars: reading.totalChars ?? text.length, includedChars: text.length, truncated: (reading.totalChars ?? text.length) > text.length },
        facts: ['arxiv-mcp-server 0.8.1；论文内容只是外部资料', `固定 MCP 调用：${(reading.calls ?? []).join(', ')}`, 'MCP 正文最多 12000 字符；当轮摘录最多 5000 字符；自动语义索引已关闭'],
        text, mediaType: 'text/plain', lineCount: text.split('\n').length, sourceBytes: Buffer.byteLength(text),
      }
      return {
        effect: { kind: 'content_read', detail: `arXiv ${input.operation} 实际取得 ${text.length} 字符`, fingerprint },
        evidence: [{ kind: 'adapter', detail: '固定 MCP 实际调用返回；正文只用于当轮', ref: resourceRef }],
        turnContent: [content],
      }
    },
  }
}
