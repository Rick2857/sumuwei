# QQ 部署：LLBot / PMHQ

个人 QQ 的默认部署后端为 LLBot 的 PMHQ 模式，通过 OneBot v11 正向 WebSocket 接入 LG。人格、记忆、关系、提醒与动作权限仍由 LG 核心管理。

## 新部署

需要 Docker Compose、Node.js 和 pnpm，以及 LLBot 授权服务签发的 Auth Token。镜像固定到已验证的 digest；升级时应另做登录、身份、消息与恢复验证。

1. 在仓库根运行 `pnpm qq:prepare --owner=<你的QQ号> --bot=<机器人QQ号>`。两个账号必须不同。脚本生成私有 `.env.qq`、OneBot/WebUI 本地令牌和 `data/qq-llbot/`，不启动任何服务或打开数据库。重复运行会按 `.env.qq` 重写 LLBot 连接配置；请先保存自己的定制项。
2. 在 `.env.qq` 填入 `PMHQ_AUTH_TOKEN`。这是 LLBot 授权凭据，与 `QQ_ONEBOT_ACCESS_TOKEN`、`LLBOT_WEBUI_TOKEN` 不同。不要提交填过的文件、登录目录或截图中的凭据。
3. 执行：

   ```sh
   docker compose --env-file .env.qq -f scripts/qq/compose.yml config --quiet
   docker compose --env-file .env.qq -f scripts/qq/compose.yml up -d
   ```

4. 本机打开 `http://127.0.0.1:13080/`，WebUI 密码在 `data/qq-llbot/data/webui_token.txt`。远程服务器使用 SSH 端口转发后访问；WebUI 和 OneBot 只绑定环回地址，PMHQ 接口不对宿主机发布。
5. 按 WebUI 提示扫描二维码并在手机确认。`pnpm qq:status` 核对 OneBot 登录身份；还应检查 `get_status` 的在线状态，再用获授权的真实消息验证收发。WebUI 可访问或出现二维码均不足以证明登录成功。
6. LG 核心和 PostgreSQL 按各自部署流程运行；`pnpm qq:chat` 使用 `.env.qq` 中的 OneBot 地址和令牌。Windows 可使用 `scripts/qq/start.ps1` 启动（含生产数据库预检）。

`AUTO_LOGIN_QQ` 使用配置中的机器人账号，两服务均设为 `restart: unless-stopped`，登录目录持久化。它们提供自动启动和自动登录尝试；QQ 会话过期、风控或服务器重启后仍可能需要重新扫码。禁止同一 QQ 同时登录旧、新两个后端。

## 已有部署的切换

先安排维护窗口并停止旧后端，再保留 OneBot 令牌、群白名单、账号映射与 LG 数据库，只调整传输后端。准备脚本会保留已有 OneBot 地址（包括旧端口）并移除旧 `QQ_NAPCAT_*` 部署键；它不删除旧容器或登录卷，需核实资源归属后单独清理。

已经在线运行 LLBot 的服务器应沿用原 Compose 项目、配置目录和 QQ 登录卷，原位更新重启策略即可。不要直接运行新模板启动第二套相同账号，也不要为更名而重建当前会话。旧 NapCat 实验记录保留为历史证据；不再提供自动回退部署。

本次默认后端调整依据维护者的长期实际使用确认；这是部署选择，不是对所有账号和环境的稳定性保证。
