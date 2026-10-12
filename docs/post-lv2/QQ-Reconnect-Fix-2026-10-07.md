# QQ 断开后重连卡死修复（2026-10-07）

用户观察：先正常收到三条 `qq_send_api_accepted`，随后
`onebot_disconnected → onebot_connect_failed → onebot_already_connected` 持续重复。

## 事故证据与根因

- 本机 NapCat 日志在 14:35:33（Asia/Shanghai）记录 `KickedOffLine`：
  “你的账号当前登录已失效，请重新登录。”14:36:51 再次启动 OneBot WebSocket 服务。
  这与本轮 QQ 进程的启动时间及用户日志顺序相符，是初次断开的外部线索。
- Node `v22.23.2` 原生 WebSocket 的本地连接失败探针：`error` 后 `readyState=0`
  （CONNECTING）；调用 `close()` 后 `readyState=2`（CLOSING），没有收到 `close` 事件。
- 原 `connect()` 只在握手成功后的登录检查异常中清理连接。握手失败在该 `try` 之外，
  因而失败对象一直留在 `this.socket`，触发每次后续调用的 `onebot_already_connected`。
  即使 NapCat 已恢复，旧 LG 外壳也不会再建立连接。
- 修复后执行 `pnpm qq:status`，真实 NapCat 的 `get_login_info` 与独立机器人账号匹配。
  此探针不启动 LG、不打开数据库、不发送 QQ 消息。

## 修复

仅修改 `OneBotPrivateClient` 的连接生命周期：握手和身份验证共同受异常清理保护；
关闭或错误时释放当前 socket、清除认证并拒绝未完成 API 请求；连接事件只作用于自己的
socket。握手完成后清理临时监听器。旧连接迟到的关闭、API 回执不得影响新连接。

重连只恢复连接，不重发结果不明的消息；机器人账号验证继续失败关闭。
原有私聊白名单、串行队列与去重规则不变。

新增 `pnpm qq:reconnect:verify`：使用原生 WebSocket 和本地 OneBot 夹具，
覆盖重复连接、断开后连续握手失败、同进程恢复、旧连接迟到事件、在途发送断开及不重发、
活动连接错误、账号不匹配及恢复、恢复后的普通私聊及去重、失败握手后的退出。
该门不打开任何数据库、不接触真实 QQ 消息。

## 验证读数

- 修复前：`artifacts/post-lv2/qq-reconnect-20261007064040744/result.json` = **FAIL**；
  第二次失败连接已变成 `onebot_already_connected`，与用户观察一致。该失败档保留。
- 修复后：`artifacts/post-lv2/qq-reconnect-20261007064610216/result.json` = **PASS，9 项**，含客户端源文件 SHA-256。
- 真实 NapCat 只读恢复：`artifacts/post-lv2/qq-reconnect-napcat-20261007065151636/result.json`
  = **PASS**。同一客户端先连接真实 NapCat 并验证身份，再正常关闭连接，经历一次本地
  连接拒绝，随后重新连接原真实服务并再次验证身份。入站消息消费 0、发送 QQ 消息 0。
- `pnpm typecheck` = **PASS**。
- 完整离线回归第二次运行 `pnpm m4.5:ci` = **PASS / EXIT 0**，
  14:50:37–14:56:52（Asia/Shanghai）。日志 `qq-reconnect-full-ci-20261007/m4.5-ci-run2.log`，
  退出码 `m4.5-ci-run2-exit.json`。G14 按现行选档规则承接既有 Live Smoke；
  本轮未新跑模型 Live Smoke。自动重写的 7 份已跟踪证据归档到该目录的 `after/`，
  再逐文件按本轮开始前的 SHA-256 还原，保留原有工作区改动（`artifact-restore.json`）。
- `pnpm postlv2:qq-proactive:chain` = **11 PASS / 0 FAIL / 1 NOT RUN**：
  `artifacts/post-lv2/qq-proactive-chain-20261007064441199/`；真核心、同一客户端类、
  模拟 OneBot、隔离库。NOT RUN 是该门原有的关心场景边界。真实库树摘要前后相同。
- `pnpm qq:verify` = **FAIL**，停在既有断言 `includes('没真记下来')`；夹具的实际回复是
  “这轮没有确认新的记录写入成功；不能据此判断之前没有记录。”只将连接方法换回 HEAD
  中旧实现，也在同一断言失败。旧实现对照日志：
  `artifacts/post-lv2/qq-reconnect-baseline-20261007/qq-verify-before.log`。
  本轮不修改这条与重连无关的文案断言，也不将该门报告为 PASS。

## 生效与剩余边界

用户已按 Ctrl+C 正常停止旧 QQ 外壳和 LG 核心，本轮检查也确认这两类进程均已退出。
重新运行 `pnpm qq:start` 即可加载修复。

完整 `m4.5:ci` 首次退出码 2：并行开发中新加的 `scripts/postlv2-s8-daily-verify.ts`
有两个缺字段类型错误（`provider` / `recentLines`）。其后该文件的缺字段已在工作区补齐，
完整回归重新执行并退出码 0；两次读数分开保留在 `artifacts/post-lv2/qq-reconnect-full-ci-20261007/`。
第一次运行未更改任何已跟踪证据
（8923 个文件 SHA-256 前后相同）。依据 AGENTS.md §5.1，生产库复制只在聊天进程退出后执行。
真实手机上的下一轮私聊恢复尚未观察，
不得用本地夹具或只读账号探针替代。
