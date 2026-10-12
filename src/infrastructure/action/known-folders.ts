/**
 * Windows **已知目录探测**（WP2 的基础设施半边）。
 *
 * ============================================================================
 *  它复用**系统自己的**已知文件夹 API，而不是自己拼路径
 * ============================================================================
 * 计划书 §4 缺口 2 要求"处理重定向后的实际路径"。做法是问 .NET 的标准 API：
 * ```text
 * [Environment]::GetFolderPath('Desktop')              → 个人桌面（跟随 OneDrive 等重定向）
 * [Environment]::GetFolderPath('CommonDesktopDirectory') → 公共桌面
 * ```
 * ⇒ 这是**既有实现**（Windows Shell 的已知文件夹机制），本文件不重写它，
 *    也不去解析注册表（`User Shell Folders` 的 `REG_EXPAND_SZ` 展开、per-user
 *    hive、重定向优先级都是别人已经处理好的事）。
 *
 * ============================================================================
 *  三条工程纪律（都不是可选的）
 * ============================================================================
 * ```text
 * ① **固定命令**：脚本是程序常量，**没有**任何用户输入拼进去（不是"任意 shell"）。
 * ② **强制 UTF-8 输出**：Windows PowerShell 默认按控制台代码页写 stdout，
 *    路径里的中文会被读成乱码（本仓库真实踩过编码这一类坑）。
 *    脚本第一句把 `[Console]::OutputEncoding` 设成 UTF-8 ⇒ 我们按 UTF-8 解码。
 * ③ **硬超时 + 失败如实**：超时 / 没有解释器 / 非零退出 ⇒ 交给内核的
 *    `knownDirectoryProbeFailed()`，**绝不**回落到"拼一个 %USERPROFILE%\\Desktop"。
 * ```
 *
 * ⚠️ 它**只**返回事实，不做任何判定；"在不在"由内核的解析器用 `exists` 回答。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

import {
  knownDirectoryProbeFailed,
  parseKnownDirectoryProbe,
  type KnownDirectoryFact,
} from '../../kernel/action/known-directories.ts'

/**
 * 探测脚本（**程序常量**）。
 *
 * ⚠️ `-NonInteractive` + `-NoProfile`：不受用户 profile 影响（可复现）。
 * ⚠️ `try/catch` 在脚本内部：某一档拿不到就打印空路径，由内核判成 `probe_failed`，
 *    而不是让整个进程非零退出（那样两档都会变成"探测失败"）。
 */
export const KNOWN_DIRECTORY_PROBE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'foreach ($pair in @(@("personal_desktop","Desktop"), @("public_desktop","CommonDesktopDirectory"))) {',
  '  try { $p = [Environment]::GetFolderPath($pair[1]) } catch { $p = "" }',
  '  if ($null -eq $p) { $p = "" }',
  '  Write-Output ($pair[0] + "=" + $p)',
  '}',
].join('\n')

export interface KnownFolderProbeOptions {
  /** 注入是为了让门能在**没有** PowerShell 的环境里也照到解析那一半 */
  readonly run?: (command: string, args: readonly string[]) => Promise<{ stdout: string; failed: boolean }>
  readonly timeoutMs?: number
  /** 默认 `fs.existsSync`；注入是为了离线用例（"路径在不在"是外部事实） */
  readonly exists?: (path: string) => boolean
  /** 非 Windows 直接返回 `probe_absent`（**不**去 spawn） */
  readonly platform?: NodeJS.Platform
}

/** 默认探测超时（毫秒）：一次本地进程，2 秒足够；超时就如实失败 */
export const KNOWN_FOLDER_PROBE_TIMEOUT_MS = 2_000

async function defaultRun(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ stdout: string; failed: boolean }> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: { stdout: string; failed: boolean }): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = execFile(
        command,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          finish({ stdout: typeof stdout === 'string' ? stdout : '', failed: error !== null })
        }
      )
      child.on('error', () => finish({ stdout: '', failed: true }))
    } catch {
      finish({ stdout: '', failed: true })
    }
  })
}

/**
 * 读出这台机器上的已知目录事实。
 *
 * 返回的**永远**是完整的一档事实（哪怕是"探测失败"）—— 调用方不需要处理 `undefined`。
 */
export async function readKnownDesktopDirectories(
  options: KnownFolderProbeOptions = {}
): Promise<readonly KnownDirectoryFact[]> {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  /* 非 Windows：如实说"没探测"，而不是假装探测失败（两者的成因不同） */
  if (platform !== 'win32') return knownDirectoryProbeFailed('probe_absent')

  const probe = options.run ?? ((command, args) => defaultRun(command, args, options.timeoutMs ?? KNOWN_FOLDER_PROBE_TIMEOUT_MS))
  /*
   * ⚠️ 依次试 `powershell`（Windows 10/11 一定在）与 `pwsh`（PowerShell 7）：
   *    两者都是**固定命令**，参数里没有任何用户输入。
   */
  for (const command of ['powershell', 'pwsh']) {
    const result = await probe(command, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      KNOWN_DIRECTORY_PROBE_SCRIPT,
    ])
    if (result.failed || result.stdout.trim() === '') continue
    const facts = parseKnownDirectoryProbe(result.stdout, { exists })
    /* 两档都拿到"没有路径"⇒ 这次解释器显然没干活，换下一个试 */
    if (facts.every((fact) => fact.source === 'probe_failed')) continue
    return facts
  }
  return knownDirectoryProbeFailed('probe_failed')
}
