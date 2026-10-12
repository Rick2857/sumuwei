# QQ 与 Live2D 同时聊天：现成方案核对

核对日期：2026-10-06。范围：本机组件与 GitHub 一手源码；未安装新组件、未切换入口、未提交正式测试对话。

## 结论

现成多入口框架的第一候选是 **AstrBot + `astrbot_plugin_live2d_adapter` + `astrbot-live2d-desktop`**。本机已有 AstrBot 部署和源码；QQ 可沿用 NapCat / OneBot。桌宠插件及其前端还未在该部署的插件目录中发现。

这套组合具备分平台会话和向对应桌面客户端回传的机制，适合作为 QQ 与 Live2D 并存的候选；它没有现成的 LG 连接器。**支持两种聊天入口，不等于已经兼容 LG 的人格、记忆和语音交付契约。** 本轮只有静态核对，没有运行兼容性通过的结论。

建议的隔离含义：共用苏沐薇的人格、Alex 身份与长期记忆；QQ 和皮套的近期对话上下文、回复目标、播放、取消各自独立。若要求两边的记忆、情绪、关系、目标也完全互不影响，就需要额外隔离认知作用域，这与共用同一个她的状态是不同的需求。

## 当前 LG 的具体缺口

- `src/infrastructure/qq/lg-stdio-client.ts` 给 QQ 启动独立 `src/main.ts --bridge --qq-private`。
- `scripts/postlv2_vtuber_runtime.py` 的 `LGBridgeClient.start()` 给皮套启动独立正式 bridge。
- 两个正式进程争用同一生产库，由现有单持有租约拒绝第二个持有者。
- `src/main.ts` 的 `ChatSession.buildGateway()` 按角色与用户生成会话 ID，未加入入口维度；因此换一个接入框架本身不会把 LG 的近期历史分开。
- 当前皮套的 LG 适配层还有全局 `BRIDGE` 与 `LIVE_CLIENT`；上游按客户端保存状态，不足以证明这个适配层支持多路隔离。

任何保留 LG 的方案都需要：一个 LG 数据库持有者、由受信入口绑定的独立会话，以及按入口归属的回复与取消。不能用解除数据库锁来代替共享运行时。

## 候选对比

| 方案 | 已有能力与本机状态 | 接入 LG 的剩余工作 | 判断 |
|---|---|---|---|
| 现有 NapCat + Open-LLM-VTuber | 两端均已有；语音、皮套与 QQ 已分别适配 LG | 共享运行时、分开近期会话、调整客户端连接 | 保留当前皮套与语音行为最直接，但并存协调尚未实现 |
| AstrBot + lxfight Live2D 组合 | 本机有 AstrBot；插件提供平台桥接，桌面端负责表现；有 Windows 安装包 | LG 消息桥与内部会话隔离；核对 ASR/TTS、播放回报、取消、表达映射 | 现成多入口框架第一候选，尚未完成运行兼容验证 |
| murphys7017 AstrBot VTuber 插件 | README 声明文字、麦克风、语音打断及配套 Web/Electron 前端 | 同样需要 LG 桥；还需核对定制前端协议及许可 | 备选，不凭功能声明裁定兼容 |

## 一手证据、版本与依赖

### AstrBot

本机部署：`C:\Users\user\astrbot-stack`，README 记录部署验证版本 4.27.5；本轮 Docker 运行列表中没有 AstrBot，不能把部署文件存在当成正在服务。另存的 `AstrBot-source/pyproject.toml` 标记版本 4.28.0-beta.1、Python >=3.12；下面的源码核对来自这份源码，未验证它与现有固定镜像、桌宠插件的运行兼容性。

本机 `astrbot/core/platform/message_session.py` 使用 `platform_id:message_type:session_id` 标识会话；`core/utils/session_lock.py` 按会话维护锁。这支持分平台与分会话处理，但不是 LG 会话隔离已实现的证据。

源码许可为 AGPL-3.0。相关来源：[AstrBot](https://github.com/AstrBotDevs/AstrBot)、[会话标识源码](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/platform/message_session.py)、[会话锁源码](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/utils/session_lock.py)。

### lxfight Live2D 组合

- [适配器](https://github.com/lxfight/astrbot_plugin_live2d_adapter)：核对提交 `9689fd35d51d94a20c89170b3eca9af42abda15b`；GitHub 最新 release `v1.3.1`；MIT。
- [桌面端](https://github.com/lxfight/astrbot-live2d-desktop)：核对提交 `c029e8cfe780cd0b421da360ac63e16ad1f3c68f`；GitHub 最新 release `v1.6.0`；MIT。README 中的版本标记仍为 v1.5.0，不能用它覆盖 release 的读数。
- 适配器依赖：`websockets>=12.0`、`aiohttp>=3.9.0`、`aiofiles>=23.0`；源码已查，未安装。
- 适配器握手要求认证；会话映射到客户端，回复通常使用 `send_to(client_id, ...)`。README 的单连接约束针对 Live2D 连接，并不表示 QQ 平台也只能占用该连接。
- 源码仍有旧服务广播回退与无目标时选当前客户端的分支，不能从主要路径推断任意配置下都绝不串台。
- 桌面端为 Electron + Vue；接受 `.model3.json`，不接受 Cubism 2 `.model.json`；Cubism Core 需要另取，许可独立。
- 新桌宠协议与当前 LG 皮套交付协议不同。角色状态、已检查语句、已播片段、模型取消及中途检索都需逐项核对，不能用消息显示成功代替这些语义通过。

### murphys7017 备选

[插件](https://github.com/murphys7017/astrbot_plugin_self_open_llm_vtuber)核对提交 `6ce14478a6275ee80e4bc98e08e27aa48be81247`；最新 release `v1.0.0`。配套[前端](https://github.com/murphys7017/astrbot_plugin_self_open_llm_vtuber_web)修改了 Open-LLM-VTuber 交互协议。GitHub 仓库许可字段为 null，顶层文件列表未显示 LICENSE；许可未确认，不能按上游 MIT 自动裁定这个分支。

README 要求 AstrBot、Python 依赖、ffmpeg；前端源码构建要求 Node >=18。当前 LG 语音打断及已播视图与它的打断行为尚未对照。

## 后续兼容验证的通过条件

1. 在隔离库同时接收两路消息，分别写入独立近期会话；共享记忆仍走 LG 已有写入链。
2. QQ 回复只回 QQ；皮套只消费自身文字、语音和表情；取消一路不取消另一入口的请求。
3. 一路断开或模型失败后，另一路的新请求可以继续；全程只有一个数据库持有者。
4. 验证现有语义写入、语义召回、播放事实与取消语义，分别记录通过或不适用，不用默认 Agent 替代失败的 LG 请求。

本轮未达到这些运行条件；当前正式 QQ 入口保持原有运行方式。
