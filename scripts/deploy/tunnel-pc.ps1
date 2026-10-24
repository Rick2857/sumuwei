<#
.SYNOPSIS
    PC 侧 · 到服务器核心的 SSH **反向隧道**（服务器部署 · 远程执行接线）

.DESCRIPTION
    ============================================================================
    它解决什么
    ============================================================================
    部署形态（另一条 agent 与你商定的分工）：

        服务器   LG 唯一人格内核 + PostgreSQL + LLBot / PMHQ
        你的电脑 Windows 桌面执行端 + 已登录态浏览器 + 本机文件 + 皮套 + GPU 语音
        连接层   **本脚本建立的 SSH 反向隧道**（不是 Tailscale）

    本脚本在你**电脑上**运行，让电脑**主动连出**到服务器，
    并把「服务器上的某个本机端口」反向映射到「你电脑上某个本机端口」：

        服务器 127.0.0.1:<ServerPort>  ──SSH隧道──▶  电脑 127.0.0.1:<PcPort>

    ⇒ 电脑**不需要**公网 IP，路由器**不需要**端口映射。
    ⇒ 服务器**不需要**新增公网入站端口。

    ============================================================================
    为什么这条路值得先走，而不是先改代码放开监听地址
    ============================================================================
    审计里原本记的是两条"必须改代码"的阻塞项：

      · 核心只绑 loopback：`server.listen(spec.port, '127.0.0.1')`（src/main.ts:6597）
      · 皮套连接档**主动拒绝**非 loopback（tools/avatar-3d/shell-connected.py:14-15）

    隧道让**两端都落在 127.0.0.1** ⇒ 这两条闸**一个字都不用改**。
    加密由 SSH 提供，不需要自建 TLS。

    ⚠️ 这**不代表**零工作：工具协议、应用层鉴权、重连、取消这四项仍然要补，
       见 scripts/deploy/README.md 的「远程执行四项缺口」。

.PARAMETER Server
    服务器地址（user@host 形式）。密钥认证，不接受密码（见下方说明）。

.PARAMETER ServerPort
    要在**服务器**上打开的反向端口。LG 核心随后连它。

.PARAMETER PcPort
    你电脑上执行端监听的端口（默认只听 127.0.0.1）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\deploy\tunnel-pc.ps1 `
        -Server lg@your-server-ip -ServerPort 8765 -PcPort 8765
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Server,
    [int] $ServerPort = 8765,
    [int] $PcPort = 8765,
    [string] $IdentityFile = "$env:USERPROFILE\.ssh\lg_tunnel_ed25519",
    [int] $KeepAliveSeconds = 30,
    [int] $ReconnectDelaySeconds = 5,
    [int] $MaxAttempts = 0,   # 0 = 一直重连
    <#
    ADR-146 `R-146` ③：执行端的**第二个**反向转发（复用同一条 SSH 连接）。
    ⚠️ 两个都必须给；只给一个会被脚本拒（见下方校验）。

    ⚠️⚠️ 类型**必须**是 `[Nullable[int]]`，不能写 `[int]`：
    ⚠️⚠️   `[int] $X = $null` 在 PowerShell 里得到的是 **0**，不是 `$null`。
    ⚠️⚠️   ⇒ `$null -ne $X` 恒为真 ⇒ 不传参数也会进"执行端"分支，
    ⚠️⚠️     然后被判"端口 0 不在 1024-65535" ⇒ **脚本直接退出**。
    ⚠️⚠️   本轮自己的负控当场抓到（原注释写的"缺省不影响今天的行为"是句假话）。
    #>
    [Nullable[int]] $ExecutorServerPort = $null,
    [Nullable[int]] $ExecutorPcPort = $null
)

$ErrorActionPreference = 'Stop'

function Write-Stage { param([string]$Message) Write-Host "[tunnel] $Message" }
function Write-Fail  { param([string]$Message) Write-Host "[tunnel][FATAL] $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 前置检查（失败关闭：宁可一条都不做，也不要半条隧道跑着）
# ---------------------------------------------------------------------------

$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $ssh) { Write-Fail "找不到 ssh.exe（Windows 10/11 自带 OpenSSH 客户端；也可装 Git for Windows）"; exit 2 }

if (-not (Test-Path $IdentityFile)) {
    Write-Fail "找不到密钥文件: $IdentityFile"
    Write-Host "[tunnel] 建议**一次性**生成一对**专用**密钥（不要复用你其它地方的密钥）："
    Write-Host "[tunnel]   ssh-keygen -t ed25519 -N '""' -C 'lg-pc-executor' -f `"$IdentityFile`""
    Write-Host "[tunnel] 然后把公钥（$IdentityFile.pub）加到服务器的 ~/.ssh/authorized_keys。"
    exit 2
}

if ($ServerPort -lt 1024 -or $ServerPort -gt 65535) { Write-Fail "ServerPort 必须在 1024-65535（低于 1024 需要服务器上 root）"; exit 2 }
if ($PcPort    -lt 1     -or $PcPort    -gt 65535) { Write-Fail "PcPort 不合法"; exit 2 }

# ---------------------------------------------------------------------------
# 执行端那条转发（2026-10-17 · ADR-146 `R-146` ③：复用现有隧道，**新开一个端口**）
# ---------------------------------------------------------------------------
# ⚠️ 裁定是"**复用现有 SSH 隧道**，新开一个端口" ⇒ **一条 SSH 连接、两个 `-R`**：
#     服务器 127.0.0.1:<ServerPort>          → 电脑 <聊天/皮套服务>
#     服务器 127.0.0.1:<ExecutorServerPort>  → 电脑 <执行端>
#
#   为什么值得多一个端口，而不是让执行端复用聊天那条：
#   两边是**两个独立的服务端口**，核心可以分别判断"皮套在不在"和"执行端在不在"，
#   而不必靠"这条连接上有没有多一个人在说话"去猜。
#   ⚠️ 但它们**共享同一条 TCP 连接**的心跳 ⇒ 电脑休眠 ⇒ **两条一起断**。
#     这是"复用隧道"这个裁定的**必然代价**，不是可以两全的事；如实记为 `L-146-03`。
#
# ⚠️ 两组参数**必须同时给或同时不给** —— 只给一半会开出一条没有对端的转发，
#   表现为"服务器上端口在听，但连上去没人应答"。那种形状比"没这条隧道"更难查。
if (($null -eq $ExecutorServerPort) -ne ($null -eq $ExecutorPcPort)) {
    Write-Fail "ExecutorServerPort 与 ExecutorPcPort 必须**同时**给或同时不给（只给一半会开出一条没有对端的转发）"
    exit 2
}
if ($null -ne $ExecutorServerPort) {
    if ($ExecutorServerPort -lt 1024 -or $ExecutorServerPort -gt 65535) {
        Write-Fail "ExecutorServerPort 必须在 1024-65535"; exit 2
    }
    if ($ExecutorServerPort -eq $ServerPort) {
        Write-Fail "ExecutorServerPort 不能与 ServerPort 相同（$ServerPort）—— 两条转发会互相覆盖"; exit 2
    }
    if ($ExecutorPcPort -lt 1 -or $ExecutorPcPort -gt 65535) { Write-Fail "ExecutorPcPort 不合法"; exit 2 }
    if ($ExecutorPcPort -eq $PcPort) {
        Write-Fail "ExecutorPcPort 不能与 PcPort 相同（$PcPort）—— 两条转发指向同一个本地服务"; exit 2
    }
}

# ---------------------------------------------------------------------------
# 隧道参数（逐条都有理由，不是抄来的）
# ---------------------------------------------------------------------------
$args = @(
    '-N'                          # 不开 shell，只做转发
    '-T'                          # 不分配伪终端
    '-o', "BatchMode=yes"         # ★ 绝不在隧道里交互式提示密码
    '-o', "StrictHostKeyChecking=accept-new"
    '-o', "ExitOnForwardFailure=yes"   # ★ 端口被占用就**明确失败**，不静默不转发
    '-o', "ServerAliveInterval=$KeepAliveSeconds"   # ★ 断链检测
    '-o', "ServerAliveCountMax=3"                   # ★ 3 次心跳无回应就判死
    '-o', "TCPKeepAlive=yes"
    '-i', $IdentityFile
    # ★★ 反向转发：服务器 127.0.0.1:ServerPort → 电脑 127.0.0.1:PcPort
    #
    # ⚠️ 2026-10-16 · 复核 §3 更正：脚本**不能**单方面保证"服务器以外连不上"。
    #   sshd 的 `GatewayPorts` 缺省是 `no`，此时远程转发只绑 loopback；
    #   但**若管理员把它改成 `yes` / `clientspecified`，就会绑到 0.0.0.0**。
    #   ⇒ 这是**服务器侧配置**，必须在服务器上确认，并且**读回实际监听地址**才算数：
    #       sshd -T | grep -i gatewayports      # 期望 gatewayports no
    #       ss -ltnp | grep ":<ServerPort>"      # 期望 127.0.0.1:<ServerPort>，不是 0.0.0.0
    #     改法：/etc/ssh/sshd_config 里显式写 `GatewayPorts no`，然后 systemctl reload ssh。
    '-R', "${ServerPort}:127.0.0.1:${PcPort}"
    $Server
)
# ⚠️ 第二条转发加进**同一个** ssh 调用里（ssh 允许多个 -R），
#   因为 `R-146` ③ 的裁定就是"**复用现有 SSH 隧道**，新开一个端口" ——
#   是一条连接、两个服务端端口，**不是**两条连接。
#   ⚠️ 别改成两次 ssh 调用：那就成了两条连接，而"一条连接"正是这条裁定要的
#   （电脑只需要一条出站、服务器只需要一条心跳）。
#   ⚠️ 也别改成两条隧道脚本：端口对不上时错误信息会指到错的那条上。
if ($null -ne $ExecutorServerPort) {
    # -R 必须放在服务器名**之前**，所以要把服务器名摘掉、加完再放回去
    $target = $args[$args.Count - 1]
    $args = $args[0..($args.Count - 2)]
    $args += @('-R', "${ExecutorServerPort}:127.0.0.1:${ExecutorPcPort}", $target)
}

Write-Stage "电脑 → 服务器 反向隧道"
Write-Stage "  服务器端点 : 127.0.0.1:$ServerPort"
Write-Stage "  电脑端点   : 127.0.0.1:$PcPort"
if ($null -ne $ExecutorServerPort) {
    Write-Stage "  执行端     : 服务器 127.0.0.1:$ExecutorServerPort -> 电脑 127.0.0.1:$ExecutorPcPort"
    Write-Stage "              （**同一条** SSH 连接上的第二个 -R）"
    Write-Stage "              ⚠️ 两条共享心跳 ⇒ 电脑休眠会**两条一起断**（L-146-03）"
    Write-Stage "    上线后核对：ss -ltnp | grep ':$ExecutorServerPort'   # 期望 127.0.0.1，不是 0.0.0.0"
}
Write-Stage "  密钥       : $IdentityFile"
Write-Stage "  心跳       : ${KeepAliveSeconds}s × 3"
Write-Stage ""
Write-Stage "  绑定通常只在 loopback —— 但那取决于**服务器** sshd 的 GatewayPorts。"
Write-Stage "  上线前请在服务器上核对这两条（期望值见下）："
Write-Stage "    sshd -T | grep -i gatewayports      # 期望 gatewayports no"
Write-Stage "    ss -ltnp | grep ':$ServerPort'       # 期望 127.0.0.1:$ServerPort，不是 0.0.0.0"
Write-Stage "  电脑关机 / 休眠 ⇒ 隧道断 ⇒ 服务器侧执行能力如实显示'不可用'（**这是预期行为**）。"
Write-Stage ""

# ---------------------------------------------------------------------------
# 保持连接（断线自动重连）
# ---------------------------------------------------------------------------
$attempt = 0
$global:LgStopRequested = $false

<#
⚠️ 2026-10-16 · 复核 §3 修正。
   原来这里写的是：
       Register-ObjectEvent -SourceIdentifier SigInt -SignalType CtrlC -Action { ... }
   而 **`Register-ObjectEvent` 没有 `-SignalType` 参数**（本机实测：
   `ParameterBindingException: A parameter cannot be found that matches parameter name 'SignalType'`）
   ⇒ 脚本在**连接之前**就会抛异常，什么也干不成。

   改成下面这套真的能用：让 Ctrl+C 变成一次普通按键事件，由主循环自己识别，
   "优雅停止"与"重连循环"共用同一个 `$global:LgStopRequested`；
   ssh 子进程随 PowerShell 进程一起结束。
#>
try {
    $null = [Console]::TreatControlCAsInput
    $null = Register-ObjectEvent -SourceIdentifier LgKey -EventName KeyAvailable -Action {
        $ev = $EventArgs
        if ($ev.Key -eq [ConsoleKey]::C -and ($ev.Modifiers -band [ConsoleModifiers]::Control)) {
            Write-Host "`n[tunnel] 收到 Ctrl+C，正在关闭…"
            $global:LgStopRequested = $true
        }
    }
}
catch {
    Write-Host "[tunnel][WARN] 无法接管 Ctrl+C（$($_.Exception.Message)）；改用 Ctrl+Break 或直接关闭窗口。"
}

while (-not $global:LgStopRequested) {
    $attempt++
    if ($MaxAttempts -gt 0 -and $attempt -gt $MaxAttempts) { Write-Fail "已达最大重试次数 $MaxAttempts，退出"; break }

    Write-Stage "第 $attempt 次连接 $Server …"
    & $ssh.Source @args
    $code = $LASTEXITCODE

    if ($global:LgStopRequested) { break }
    Write-Stage "隧道已断开（ssh 退出码 $code），$ReconnectDelaySeconds 秒后重连"
    Start-Sleep -Seconds $ReconnectDelaySeconds
}

Write-Stage "隧道已停止。"
