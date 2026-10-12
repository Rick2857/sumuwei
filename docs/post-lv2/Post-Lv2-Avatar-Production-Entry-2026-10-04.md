# 皮套正式聊天入口（2026-10-04）

用户授权：「好的补上」，补充带皮套和声音、进入正式记忆库的启动方式。

## 使用

双击 [postlv2-avatar-production.cmd](../../scripts/postlv2-avatar-production.cmd)，或在项目目录执行 `pnpm postlv2:avatar:production`。出现 `LG_AVATAR_READY` 后打开 [正式聊天页](http://127.0.0.1:12394/)，确认左下角显示 **正式聊天 · 使用正式记忆**。

Ono_Anna、LG 决定的有限表达意图、自动表情/头部动作、手动服装与特效继续使用同一套适配器。页面的 HTTP/音频资源与 WebSocket 都绑定当前页面的服务器；不采用上游保存在浏览器里的其它连接地址。

退出时在启动窗口按一次 `Ctrl+C`，等 `LG_BRIDGE_CLOSED exit=0` 再关闭窗口。正式库仍只允许一个持有租约的进程；与 `pnpm chat` 同时启动会被既有占用锁拒绝。测试服务也占用 GPU，正式使用前应关闭它。

测试入口 [postlv2-avatar.cmd](../../scripts/postlv2-avatar.cmd) 固定为 sandbox-copy，端口 12393，显示 **测试聊天 · 使用记忆副本**。其历史不自动转入正式库。

## 记忆与生产保护

[正式桥入口](../../scripts/postlv2-bridge-production.ts) 使用 `.env` 的生产 key，显式启用已实现的表达协议，再调用现有 `main.ts --bridge`。实际聊天仍由同一个 `ChatSession.send()` 完成上下文、记忆提取、回复守卫、落账与慢路径；外壳的历史文件不能成为 LG 的记忆权威。

正式入口拒绝继承 `PROJECT_LG_SANDBOX`、测试模型包装器标记和其它数据库路径；`.env` 自身出现这些配置也会拒绝。生产打开、迁移闸与收尾仍由 main.ts 的既有 INC-01 流程负责：租约、verified pre-open 快照、token、正常关库、verified post-close 快照和释放租约。无新迁移、无 `.env` 激活变更。

启动前先检查端口占用，再通过一个会被拒绝的未知消息确认桥的传输就绪；该探针不提交聊天轮次。启动/收尾错误显示在启动窗口。外壳用 stdin EOF 请求 LG 收尾并等待退出，不因 25 秒超时在 Windows 上强杀数据库进程；非零退出会使启动脚本报错。

聊天历史落库不等于每句话自动成为长期事实记忆。原有提取/资格/放行规则继续生效。此次实测 `请记住，以后你可以叫我青禾灯。` 的 rule intent 为 absent，副本里新增事实记忆 0 条；`记住，叫我青禾灯。` 为 remember，副本里新增恰好 1 条 active 记忆。该既有词形边界保留，未改冻结的 Memory Kernel。

## 验证

- 正式入口控制与 Python 子进程生命周期：13 项通过。包含正常选择、测试继承/异常配置拒绝、stdin EOF 收尾、启动失败、非零退出、未知模式拒绝；子进程为 stub。
- `cmd.exe` 执行正式 `.cmd --help`：成功，完成真实前端 browser 构建及资源配置、参数解析；没有打开生产库。两个 `.cmd` 均保持 CRLF，固定各自模式的参数位于额外参数之后。
- 真模型副本：同一个 main.ts bridge 写入恰好 1 条 active 记忆；同 requestId 重试返回同 reply/trace；正常退出后启动第二个真正的 Node 进程，记忆不变且能召回称呼。使用 `.env.test`；生产树 1249 文件摘要前后逐字一致。证据：[live-copy.json](../../artifacts/post-lv2/avatar-production-20261004/live-copy.json)。
- 启动前 schema 检查：另取未经 main.ts 打开的新副本，仅用原始连接 SELECT；已应用 v13，与代码 v13 相同，pending 0。该检查没有运行迁移器，不能把副本自动升级后的版本当作生产版本。证据：[schema-preflight.json](../../artifacts/post-lv2/avatar-production-20261004/schema-preflight.json)。
- typecheck、INC-01 test/verify/measurement、postlv2 bridge/transport/expression/appearance/avatar 检查通过。生产状态机的正控/负控/恢复继续由既有 INC-01 量具覆盖，不能把它与真人正式启动混作一条证据。
- 实际页面验证新模式提示、同源连接与服装控件；该页面实际连接 sandbox-copy。截图见下。
- `pnpm m4.5:ci` **FAIL**：既有 S8 storyline 依赖超出 FC-T04 模块边界。未修其它会话的 S8 实现，未声称整库验收通过；完整 CI 大日志留在 Temp，摘要/路径/哈希登记在本轮 evidence。
- 初始失败的 stub 自己重写退出码、桥 outcome 量具错用 generated、未支持的「请记住」用例均保留原日志，分别纠正量具或使用已冻结支持的输入；无冻结规则放宽。

本轮没有启动真人正式库聊天，production activation / 首次真人使用 / 正式模式真人听审均为 **NOT RUN**。正式脚本已接线、可由用户启动；副本测试不替代真人首次正式启动。新增检查与证据均按本轮目录登记，其它原有脏证据保留。

![实际测试模式页面](../../artifacts/post-lv2/avatar-production-20261004/test-mode-page.png)
