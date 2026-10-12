/**
 * 桌面能力的**运行时固定值**（与 `rapid-ocr-assets.ts` 同型：只读核对，运行时绝不补下载）。
 *
 * ============================================================================
 *  为什么"运行时"本身要被固定成常量
 * ============================================================================
 * ```text
 * ① 上游包与版本：windows-mcp **0.8.7**（PyPI sdist sha256 见 WP0 基线）
 *    —— 换版本 = 换一条证据链；`0.8.x` 与主分支之间已经有差异，不能混用读数。
 * ② 独立解释器：`artifacts/post-lv2/local/desktop-runtime/venv`（**不是**系统 Python，
 *    也**不是** OCR / 语音那两个 venv —— 上游依赖里有 dxcam / comtypes / pywin32，
 *    装进别人的环境会互相污染）。
 * ③ 唯一 worker：`desktop-control-worker.py`（闭集协议，见该文件头部）。
 * ```
 *
 * ⚠️ 它**只回答"这台机器上那个运行时在不在、版本对不对"**（一次 readdir + 两条 stat），
 *    不启动任何进程、不碰 UIA。因此它可以被**装配期**安全调用（不产生副作用），
 *    也可以被工具目录当成"已连接 / 未连接"的如实读数（`ToolConnectionState`）。
 *
 * ⚠️ 不在这里做"版本不对就自动装"：与 OCR 同一条纪律 —— **补下载是人的动作**。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** 上游包名与**唯一**允许的版本（换它 = 换一次验收，不是改一个常量） */
export const DESKTOP_MCP_PACKAGE = 'windows-mcp'
export const DESKTOP_MCP_VERSION = '0.8.7'
/** worker 协议名（header 里的 `protocol`；worker 侧不匹配就失败关闭） */
export const DESKTOP_CONTROL_PROTOCOL = 'desktop-control/1'
/** 结果行前缀（stdout 上**恰好一行**，其余一律 stderr） */
export const DESKTOP_CONTROL_RESULT_PREFIX = 'DESKTOP_CONTROL_RESULT='

export function desktopControlRuntimeDir(): string {
  return join(ROOT, 'artifacts/post-lv2/local/desktop-runtime')
}

export function defaultDesktopControlPython(): string {
  return (
    process.env.PROJECT_LG_DESKTOP_PYTHON ?? join(desktopControlRuntimeDir(), 'venv/Scripts/python.exe')
  )
}

export function defaultDesktopControlWorker(): string {
  return (
    process.env.PROJECT_LG_DESKTOP_WORKER ??
    join(ROOT, 'src/infrastructure/action/adapters/desktop-control-worker.py')
  )
}

export interface DesktopRuntimeCheck {
  /** 三条都成立才算"这个运行时可用" */
  ok: boolean
  /** 具名原因（给日志与人看；**不**含任何用户内容） */
  problems: string[]
  /** dist-info 里读到的实际版本（读不到就是 `undefined`） */
  version?: string
  python: string
  worker: string
}

/**
 * 只读核对运行时（**不启动进程**）。
 *
 * ```text
 * ① 解释器文件存在
 * ② worker 脚本存在
 * ③ 该解释器的 site-packages 里有 windows_mcp-<version>.dist-info，且 METADATA 的
 *    `Version:` 逐字等于 `DESKTOP_MCP_VERSION`
 * ```
 * ⚠️ 第 ③ 条刻意读 dist-info 而**不是**跑 `python -c "import windows_mcp"`：
 *    装配期不该为了报一个状态而拉起一个 2.5 秒的进程（而且那会碰 UIA 初始化）。
 *    真正的版本闸在 worker 里还有一道（`runtime_mismatch`）—— 两处都读同一份 dist-info。
 */
export async function verifyDesktopRuntime(
  python = defaultDesktopControlPython(),
  worker = defaultDesktopControlWorker()
): Promise<DesktopRuntimeCheck> {
  const pythonIsFile = await isFileOf(python)
  const workerIsFile = await isFileOf(worker)
  const sitePackages = sitePackagesOf(python)
  const entries = await readdirSafe(sitePackages)
  const metadata = entries === undefined ? undefined : await metadataOfSafe(sitePackages, entries)
  return verdictOf({ python, worker, pythonIsFile, workerIsFile, entries, metadata })
}

/**
 * 同一判据的**同步**版本（装配期用：工具目录要如实报"已连接 / 未连接"）。
 *
 * ⚠️ 两处判据必须一样 —— 所以它们共用 `verdictOf()`，不是各写一遍结论。
 */
export function verifyDesktopRuntimeSync(
  python = defaultDesktopControlPython(),
  worker = defaultDesktopControlWorker()
): DesktopRuntimeCheck {
  const pythonIsFile = isFileSyncSafe(python)
  const workerIsFile = isFileSyncSafe(worker)
  const sitePackages = sitePackagesOf(python)
  const entries = readdirSyncSafe(sitePackages)
  const metadata = entries === undefined ? undefined : metadataSyncSafe(sitePackages, entries)
  return verdictOf({ python, worker, pythonIsFile, workerIsFile, entries, metadata })
}

function sitePackagesOf(python: string): string {
  return join(python, '..', '..', 'Lib', 'site-packages')
}

async function isFileOf(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function isFileSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

async function readdirSafe(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path)
  } catch {
    return undefined
  }
}

function readdirSyncSafe(path: string): string[] | undefined {
  try {
    return readdirSync(path)
  } catch {
    return undefined
  }
}

async function metadataOfSafe(
  sitePackages: string,
  entries: readonly string[]
): Promise<string | undefined> {
  const distInfo = distInfoOf(entries)
  if (distInfo === undefined) return undefined
  try {
    return await readFile(join(sitePackages, distInfo, 'METADATA'), 'utf8')
  } catch {
    return ''
  }
}

function metadataSyncSafe(sitePackages: string, entries: readonly string[]): string | undefined {
  const distInfo = distInfoOf(entries)
  if (distInfo === undefined) return undefined
  try {
    return readFileSync(join(sitePackages, distInfo, 'METADATA'), 'utf8')
  } catch {
    return ''
  }
}

function distInfoOf(entries: readonly string[]): string | undefined {
  const pattern = new RegExp(`^${DESKTOP_MCP_PACKAGE.replace('-', '_')}-.*\\.dist-info$`)
  return entries.find((entry) => pattern.test(entry))
}

/** 唯一的结论处（同步与异步两条读法共用它 —— 这样两处不可能给出不同判据） */
function verdictOf(input: {
  python: string
  worker: string
  pythonIsFile: boolean
  workerIsFile: boolean
  entries: readonly string[] | undefined
  metadata: string | undefined
}): DesktopRuntimeCheck {
  const problems: string[] = []
  if (!input.pythonIsFile) problems.push('桌面解释器不存在（独立 venv 还没建）')
  if (!input.workerIsFile) problems.push('桌面 worker 脚本不存在')

  let version: string | undefined
  if (input.entries === undefined) {
    problems.push('读不到 site-packages（独立 venv 还没建好）')
  } else if (distInfoOf(input.entries) === undefined) {
    problems.push(`site-packages 里没有 ${DESKTOP_MCP_PACKAGE} 的 dist-info`)
  } else {
    version =
      typeof input.metadata === 'string'
        ? /^Version:\s*(.+)$/m.exec(input.metadata)?.[1]?.trim()
        : undefined
    if (version !== DESKTOP_MCP_VERSION) {
      problems.push(`已安装版本是 ${version ?? '未知'}，要求 ${DESKTOP_MCP_VERSION}`)
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    ...(version !== undefined ? { version } : {}),
    python: input.python,
    worker: input.worker,
  }
}
