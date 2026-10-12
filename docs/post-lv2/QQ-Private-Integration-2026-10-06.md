# 苏沐薇 QQ 私聊接入（2026-10-06）

用户裁定：独立机器人 QQ 号，第一版只接本人私聊；优先复用本机方案。账号与凭证保存在被忽略的 `.env.qq`，不写进本报告。

## 方案与实际复用

```text
本人 QQ → 独立 NapCat → OneBot v11 正向 WebSocket
                         ↓ 本机白名单 / 账号校验 / 去重 / 串行
                      LG stdio bridge
                         ↓ src/main.ts --bridge --qq-private
                      ChatSession.send()
                         ↓ 原有记忆 / 状态 / ContextCompiler / 工具与回复守卫
                      TURN_RESULT → send_private_msg → 本人 QQ
```

本机已存在 `C:/Users/user/Yuki-QQbot`、`C:/Users/user/astrbot-stack`。选择复用 Yuki 所用的固定版本 NapCat Docker 镜像，而把 QQ 的聊天逻辑留在 LG。复用 Yuki 整套聊天后端会引入另一套人格、记忆和状态权威；AstrBot 的旧 QQ 入口已作为回滚配置保留，也不适合作为此次角色运行时。

2026-10-06 已验证现有镜像 `sha256:1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e` 存在于本机，并通过 `pull_policy: never` 使用。没有下载或安装新组件。生产连接使用 Node 22 自带的 WebSocket；验证器复用本机 jsdom 已安装的 ws。

独立 Compose 项目为 `lg-qq-private`，登录数据与配置为 `data/qq-private/`。WebUI 为 `127.0.0.1:6101`，OneBot 为 `127.0.0.1:6701`；端口只映射到 loopback。Yuki 的账号、配置与登录数据未修改。Docker Desktop 已启动，独立 NapCat 已运行；WebUI 返回 HTTP 200，页面显示独立账号，`qq:status` 的鉴权 `get_login_info` 读回也匹配配置的机器人账号。

官方契约：[NapCat 网络配置](https://napneko.github.io/config/basic)、[NapCat Docker 的持久化路径](https://github.com/NapNeko/NapCat-Docker)、[OneBot 11](https://github.com/botuniverse/onebot-11)。本机 Yuki 采用 MIT；NapCat 的主体逻辑采用[受限再分发许可](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)，包含非商业使用限制。本次通过独立服务的 OneBot 接口对接，不拷贝 NapCat 实现代码。

## 身份、归因与数据库边界

- 只接配置中本人的好友文字私聊，同时校验 `get_login_info.user_id`、事件 `self_id`、`user_id` 和 `sender.user_id`。群聊、临时群会话、自己发出的消息、其他用户、非文字内容均不进入 LG。
- QQ 号通过已有 `bindTransportIdentity` 绑定到 `.env` 的 `USER_NAME` 所决定的领域身份，因此沿用现有 Alex 的关系与记忆作用域。QQ 昵称不能改身份。
- 新增具名入口 `interactive_human_qq_private` 和 `qq-private-owner-user-turn`；原有人类控制台和 agent runner 归因保持原行为。QQ 原文只能提供文本，不能提供归因权限字段。
- 仍由 `src/main.ts` 持有数据库、执行 INC-01 租约/快照/关闭链。不新增迁移、不另开数据库、不绕过既有写入与执行网关。
- QQ 文本入口不消费语音播放视图，避免把完整文本回复误判成未播放的语音。
- 正式 QQ 服务与当前独立 CLI/Live2D 进程不能同时持有同一个生产库；第二个持有者由已有租约拒绝。多前端共享一个运行时不在本次实现范围内。

## 命令

首次配置：`pnpm qq:prepare --owner=<本人QQ> --bot=<独立机器人QQ>`。已有配置时不重生成密钥。

| 命令 | 行为 |
|---|---|
| `pnpm qq:check` | 校验本地身份/密钥/生产入口配置，不打开数据库 |
| `pnpm qq:status` | OneBot 鉴权和账号只读读回，不启动 LG、不发 QQ 消息 |
| `pnpm qq:verify` | 模拟 OneBot + 真 main.ts + 全新隔离库，不调用真模型、不发 QQ 消息 |
| `pnpm qq:start` | 启动/复用独立 NapCat、打开控制台、运行正式 LG QQ 入口 |
| `pnpm qq:chat` | 直接运行正式 LG QQ 入口；使用 `.env` 的生产模型和现有生产库 |

`scripts/qq/start.cmd -CheckOnly` 已经通过 cmd.exe 验证。正式入口拒绝测试模型包装器和沙箱环境。运行时保留终端，Ctrl+C 排空已接收队列、结束桥的 stdin，经 main.ts 正常关闭数据库。单独停止 QQ 网关可执行 `docker compose --env-file .env.qq -f scripts/qq/compose.yml stop`，登录数据保留。

## 验证与边界

`qq:verify` 已通过：账号错误拒绝、本人白名单、群聊拒绝、发言者不一致拒绝、自发消息拒绝、非文字不注入、同消息幂等、并发串行、模型失败后新请求恢复、发送失败后新请求恢复、CQ 字样按纯文本发送；真实 main.ts 在隔离库写出 4 条连续会话事件、1 条 QQ 身份映射和 1 条记忆。生产库目录树摘要前后逐字相同。

测试中假模型声称“已经记住”，在既有显式意图规则不识别“请记住……”时，实际 QQ 回发是程序守卫生成的“没真记下来”；正控“记住：我在示例工程科技大学”则实际写入。本次没有扩展记忆意图词表。此差异保留为现有规则边界。

`pnpm typecheck`、`postlv2:bridge:verify`、`postlv2:transport:verify` 已通过。旧 `m5.1.1:wp6.1:verify` 为 **119 PASS / 2 FAIL**：其 schema v9 与迁移 1..9 断言不适用于当前 v13。新增第四个具名 ingress 的公共守卫断言已同步；没有修改旧 schema 判据来制造绿门。原已提交证据保留，失败运行日志在忽略的 `artifacts/post-lv2/local/qq-ingress-compatibility.log`。

完整 `pnpm m4.5:ci` 已完成，**EXIT 0**。终态 `pnpm typecheck` **EXIT 0**；新增 `qq:verify` 整链门复跑 PASS；启动器 `-CheckOnly` 与真实账号只读 `qq:status` 均 **EXIT 0**。这些是当前混合工作树上的接入验证，不替代已有里程碑的冻结发布证据。

状态分列：接入实现与隔离整链 PASS；独立 QQ 登录/鉴权读回 PASS；LG 正式 QQ 进程未启动；本人自然 QQ 首轮完整往返 **NOT OBSERVED**。正式启动会绑定 QQ 身份并允许真实私聊写入现有记忆库，按 AGENTS.md §7 的真实库授权边界等待用户确认。

局限：第一版只支持好友文字私聊；队列上限 4，最近 512 条消息在本进程中去重；重启后去重缓存不保留，不宣称跨崩溃 exactly-once。发送失败不自动重发，API 返回 message_id 只算服务端接受，不算本人读到。OneBot 断线重连时不重放未发送回复；超过 180 秒的 LG 请求停止后续提交并排空关闭，不声称撤销已提交记忆或动作。没有配置开机自启或后台自主发言。

## 正式启动追加记录（2026-10-06）

用户在完成代码与隔离验证后明确选择“现在启动，保存真实私聊记忆”。据此执行 `pnpm qq:chat`，沿用现有 `.env` 的生产模型、`USER_NAME=Alex` 和 `data/pglite`；未提交任何合成测试对话。该入口在第一条真实消息落账时，通过已有 `ensureIdentity()` 登记 QQ 到 Alex 的映射。

2026-10-06 03:53 UTC 读回：正式 bridge 进程已运行，`session.open()` 后发出就绪信号，入口打印“LG 已就绪”；鉴权 OneBot 连接打印 `onebot_owner_private_ready`。独立 NapCat 容器为 running，端口仍只映射到 `127.0.0.1:6101/6701`。启动读数归档于 `artifacts/post-lv2/qq-private-activation-20261006/activation.json`。

03:56 UTC 的鉴权 `get_friend_list` 只读读回确认本人已在机器人的好友列表中；未发送 QQ 消息，未提交 LG 对话。正式进程仍运行，当前没有观测到首轮回复发送回执。

追加状态：正式入口 **RUNNING**；真实私聊记忆写入已获授权；本人自然 QQ 首轮往返仍 **NOT OBSERVED**，待本人发消息和确认收到回复。上文“未启动/等待确认”是启动前读数，保留历史，不作为当前状态。当前终端需保持运行，后续重启入口使用 `pnpm qq:start`。
