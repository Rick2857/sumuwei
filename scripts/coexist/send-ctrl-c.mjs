/**
 * 生产激活用：**给一个正在跑的控制台进程发 Ctrl+C**（Windows）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * 计划 §6 第 2 步要求"正常排空现有 QQ 和在飞消费者" —— 也就是**有序停机**，
 * 不是 `taskkill`。而有序停机的入口是那个进程的 Ctrl+C 处理器。
 *
 * ```text
 *   AttachConsole(pid) → SetConsoleCtrlHandler(NULL, true)（自己忽略）
 *                      → GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)
 * ```
 * ⚠️ 事件发给**那个控制台的全部进程**（这正是"在窗口里按 Ctrl+C"的效果）。
 * ⚠️ `AttachConsole` 失败（没有控制台 / 权限不够）⇒ **什么都不做**并如实退出 1，
 *    绝不改用 `taskkill` —— 那会跳过排空（`INC-01` 的纪律）。
 */
import { execFileSync } from 'node:child_process'

const targetPid = Number(process.argv[2] ?? '')
if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
  console.error('用法：node scripts/coexist/send-ctrl-c.mjs <pid>')
  process.exit(2)
}

const script = `
Add-Type -Namespace LG -Name Ctrl -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@
[LG.Ctrl]::FreeConsole() | Out-Null
if (-not [LG.Ctrl]::AttachConsole([uint32]${targetPid})) {
  Write-Output "ATTACH_FAILED"
  exit 1
}
[LG.Ctrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
if (-not [LG.Ctrl]::GenerateConsoleCtrlEvent(0, 0)) {
  Write-Output "SIGNAL_FAILED"
  [LG.Ctrl]::FreeConsole() | Out-Null
  exit 1
}
Start-Sleep -Milliseconds 600
[LG.Ctrl]::FreeConsole() | Out-Null
Write-Output "CTRL_C_SENT"
exit 0
`

try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  console.log(out.trim())
} catch (error) {
  const e = error
  console.log(String(e.stdout ?? '').trim())
  console.error(String(e.stderr ?? '').trim())
  console.error(`发送 Ctrl+C 失败（exit=${String(e.status ?? '?')}）：**不**改用 taskkill（那会跳过排空）`)
  process.exit(1)
}
