# LLBot PMHQ 隔离对照

本入口只管理 `lg-serversim-qq-pmhq`，不启动 LG 核心，不挂载生产配置、NapCat profile 或数据库。
PMHQ 使用自己的 QQ profile 卷；外部只发布回环端口 13080（WebUI）和 13001（OneBot）。
PMHQ 的 13000 接口只在候选网络内使用。`privileged: true` 沿用上游 Docker 配方，未增加主机目录或设备挂载。

固定上游 Linux amd64 镜像：LLBot 8.3.2、PMHQ 9.0.6，清单 digest 见 compose。
`probe` 在同一套 serversim Linux 镜像内运行，但不加载运行中 simhost 的环境、模型或数据库。
它只读 HTTP 状态，不发送 QQ 消息；退出码 1 表示尚未就绪，不能忽略。

## 服务器侧候选（`compose.server.yml`，2026-10-22）

同一套候选也可以跑在**那台真实服务器**上，用于与生产 NapCat 做同形对照。
服务器侧布局：`/opt/llbot-candidate/`，compose 项目名 `lg-llbot-candidate`，
端口 13000 / 13001 / 13080 **只绑回环**（服务器不对公网暴露任何端口），
独立 QQ profile 卷 `lg-llbot-candidate-profile`，**不挂生产路径、不接数据库、不调模型**。

⚠️ **服务器拉不到这两个镜像**（2026-10-22 实测，三重封锁，都不是配置问题）：
直连 `registry-1.docker.io` 连接超时；Aliyun 镜像源对 **digest 引用**返 500；
DaoCloud 对 `linyuchen/*` 报「这镜像不在白名单」；其余配置镜像源同样拒绝。
⇒ **只能用侧载**：

```bash
# 在能访问 Docker Hub 的机器上
docker save -o candidate-images.tar \
  linyuchen/llbot@sha256:9a6f187e6792e5d42001997ac3c40e19f6024db0db0d0efdbc9a87f0832a26c8 \
  linyuchen/pmhq@sha256:7f875d1aa0a0e1baa9d37c4fe6394d6ddce2b50fa1811088629033d13506757f
# scp 到服务器 → docker load → 用 docker tag 重新登记 RepoDigest
docker tag <image-id> linyuchen/llbot:8.3.2     # 这一步会把 RepoDigest 登记回去
```

登记后服务器 compose 用的仍是 `linyuchen/llbot@sha256:…` 形式（与本机候选同形），
**并且必须带 `pull_policy: never`**（否则每次启动都会去拉并失败）。
**侧载后必须核对内容寻址**：镜像 `Id` 要**逐字等于**仓库钉的 digest。

⚠️ **二维码不是直接用 LLBot 那张 PNG**：日志里存的是**百分号编码**的
`api.2dcode.biz?data=…` 包装链接（明文 `https://txz.qq.com` 搜不到）；
内层载荷 120s TTL、LLBot 每 ~120s 轮换一次。
⇒ 取载荷后**本地重新编码**成大尺寸二维码（ERROR_CORRECT_M），
并按「载荷年龄 ≤ 70s」筛选，否则扫的是过期码。

⚠️ **探针文件不随容器重建存活**：`onebot-probe.mjs` 是 `docker cp` 进容器的，
容器一旦 `down`/`up` 就没了 ⇒ 每次跑探针前必须重新 `docker cp`。

## OneBot 探针（`onebot-probe.mjs`）

在**候选容器内**跑，走真实的正向 WebSocket（`ws://127.0.0.1:3001/?access_token=…`）。

- `LG_PROBE_MODE=readback`：读回 `get_status.online` 与 `get_login_info` 身份，
  **两个回包都到齐才判定**（`status` 可能先到 —— 早退会跳过身份比对却报 READBACK_OK）。
- `LG_PROBE_MODE=inbound`：等一条真实私聊（发送者身份哈希 + 文本逐字匹配），
  然后回一条固定回执并校验 `retcode=0` + `message_id`。
- 只输出 **SHA-256 比对结果**，不落任何明文 QQ 号。

## 准备

先按主目录 README 完成 `pnpm serversim:build`、主仿真 `up -d` 和 `pnpm serversim:preflight`。
候选私有文件位于 `artifacts/serversim/local/qq-pmhq/`，已由现有 gitignore 排除。
本轮已生成；重新准备时在仓库根目录用 PowerShell 执行（会更新候选的本地访问密码）：

```powershell
$dir = 'artifacts/serversim/local/qq-pmhq'
New-Item -ItemType Directory -Force -Path "$dir/data" | Out-Null
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToHexString($bytes).ToLowerInvariant()
$cfg = (docker run --rm --network none --entrypoint cat linyuchen/llbot@sha256:9a6f187e6792e5d42001997ac3c40e19f6024db0db0d0efdbc9a87f0832a26c8 /app/llbot/default_config.json | Out-String) | ConvertFrom-Json
$cfg.webui.host = '0.0.0.0'
$cfg.ob11.connect[0].enable = $true
$cfg.ob11.connect[0].host = '0.0.0.0'
$cfg.ob11.connect[0].token = $token
$cfg.ob11.connect[0].heartInterval = 5000
$cfg.log = $false
[IO.File]::WriteAllText((Join-Path (Get-Location) "$dir/data/default_config.json"), ($cfg | ConvertTo-Json -Depth 9))
[IO.File]::WriteAllText((Join-Path (Get-Location) "$dir/data/webui_token.txt"), $token)
$image = docker inspect lg-serversim-host --format '{{.Image}}'
[IO.File]::WriteAllText((Join-Path (Get-Location) "$dir/runtime.env"), "PMHQ_AUTH_TOKEN=`nSERVERSIM_TEST_IMAGE=$image`n")
```

`runtime.env` 中的 `PMHQ_AUTH_TOKEN` 留空时，当前 PMHQ 镜像先开放管理接口，约 30 秒后因 QQ 未启动退出。
真正的 Auth Token 从 <https://auth.luckylillia.com> 获取，保存在该私有文件；不得使用 NapCat WebUI 或 OneBot token 代替。
启动前按本文末尾的账号单实例要求确认测试对象。这里不默认填写 QQ 号、不自动登录任何历史账号。
若用户要求指定账号自动登录，在私有 `runtime.env` 填入 `PMHQ_AUTO_LOGIN_QQ=<已核对的机器人QQ>`；
Compose 将它传给 PMHQ 的 `AUTO_LOGIN_QQ`。本轮已配置该项，原生 QQ“自动登录”也已勾选，重启恢复仍须独立验证。

## 执行

```powershell
docker compose --env-file artifacts/serversim/local/qq-pmhq/runtime.env -f serversim/qq-pmhq/compose.yml config --quiet
docker compose --env-file artifacts/serversim/local/qq-pmhq/runtime.env -f serversim/qq-pmhq/compose.yml up -d pmhq llbot
docker compose --env-file artifacts/serversim/local/qq-pmhq/runtime.env -f serversim/qq-pmhq/compose.yml run --rm --no-deps --pull never probe
docker compose --env-file artifacts/serversim/local/qq-pmhq/runtime.env -f serversim/qq-pmhq/compose.yml stop
```

配置在 `/app/llbot/default_config.json`，不是仅放在 `data/default_config.json` 就会被读取；compose 同时挂载了这份候选文件。
启动脚本会修改该文件，所以使用候选可写挂载。没有有效 token 时不反复重启，不启用自动 restart。
如果固定的探针镜像已被清理，先核对当前 simhost 的探针文件摘要，再将 `runtime.env` 的 `SERVERSIM_TEST_IMAGE` 更新为当前本地镜像 ID。
`--pull never` 确保缺失本地镜像时直接失败，不能让 Docker 把旧镜像 ID 当成仓库名称拉取。

## 判读与后续实测

1. WebUI HTTP 200、PMHQ HTTP 200：只证明管理接口可达。
2. `identityPresent=true`：只证明 health 中出现身份字段，须再读 OneBot `online`、核对账号与 LG 当前连接。
3. `STARTUP_READY` 是上述探针条件满足，不等于消息送达或长期稳定。
4. 用独立测试号，或先为当前号安排 NapCat 停止窗口；同一账号不能在候选和 NapCat 同时登录。
5. 登录后另验 LG 的身份闸、私聊、群成员授权、图片、消息回执、断线恢复、提醒和至少 24 小时在线。
   未完成的项目保持 `NOT RUN`，假 OneBot 的通过不作 LLBot 真机证据。

本轮结果见 [对照记录](../../docs/post-lv2/QQ-Backend-Comparison-2026-10-22.md)。
