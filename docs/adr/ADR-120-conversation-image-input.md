# ADR-120：聊天图片输入与近期会话连续性

日期：2026-10-08。状态：IMPLEMENTED / VERIFIED；配置 ENABLED，入口 STOPPED（用户要求保持关闭）。

用户授权补齐苏沐薇的看图链路并优先使用现成方法。用户进一步澄清：目标是防止有图片参与时丢失聊天上下文，不规定先说要求、后发图的使用顺序。

## 采用现有协议

沿用 NapCat / OneBot 的普通 `image` 段及 `get_image` URL；沿用已安装 Open-LLM-VTuber 的 `BatchInput.images` / `ImageData`；沿用当前 OpenAI 兼容 provider 的 Chat Completions `text` + `image_url` 内容数组。LG 下载并验证 QQ 图片，转换为内联 data URL。没有新增 Agent、模型、OCR 服务或运行时依赖，也没有复制上游实现。

官方依据：[OneBot 图片段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)、[NapCat 消息转换源码](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts)、[Open-LLM-VTuber 输入类型](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/agent/input_types.py)、[DeepSeek 图片理解协议](https://api-docs.deepseek.com/zh-cn/guides/vision/)。测试端点与生产端点分列，测试通过不等于生产首次使用已经发生。

## 数据与上下文

1. 文字和图片共同进入既有 `TurnBridge → ChatSession → TurnGateway → ContextPacket → provider` 链路。纯图片消息保留中性附件标记，不替用户补一个固定任务。无图片时 provider 保持原文字消息形状。
2. 图片原件按 SHA-256 存在当前数据目录的 `image-inputs/`；正式用户消息在既有账本 metadata 中只记录 `imageRefs`。目录随数据快照和隔离副本一起保留，不新增数据库表或迁移。干跑不保存原件。
3. 编译上下文时，在当前入口的近期对话中重新读取原图，支持先发图再问、图文一起发、先说要求后发图、后续追问与连续多图比较。重启不清空账本或原件，因此可以在近期窗口内继续聊图。QQ 与皮套仍各自维护近期会话。
4. 新附件最多 4 张，每张 8 MiB、总计 16 MiB；只接 PNG/JPEG，最多 2000 万像素。历史选择沿用近期 16 条对话事件的窗口，当前与历史合计最多 8 张 / 24 MiB，优先较近图片、按对话顺序发送，按内容去重。限制来自现有图片校验和有界请求；不承诺无限历史原图重放。
5. 图片对应消息被既有遗忘机制遮蔽时，原图引用也不再注入。找不到原件、原件损坏或图片预算超限时，上下文明确告知有原图未提供，模型应说明限制并请求重发。附件超出近期窗口后不自动重放。当前没有原件累计容量清理器，也不因遗忘自动物理删除附件或备份。
6. 图片与其内容属于用户材料，不能修改系统指令。原图不自动晋升长期事实记忆，视觉识别结果也不是用户明确自述。文字侧原有记忆链保持原规则。

## 输入与失败边界

QQ 保留本人、好友私聊、机器人账号及消息去重检查；群聊、其他人、闪照、语音、文件仍不接收。下载只允许 QQ 图片域的 HTTP(S) 地址，每次重定向重新校验，不读上游容器文件路径，不接任意网页或本机路径。下载有时间和字节上限。核心另行检查规范 base64、真实图片格式、尺寸与数据量。

图片缺省关闭：`CHARACTER_IMAGE_INPUT_ENABLED=false`；开启还需既有 Kernel/ContextCompiler 正常装配。关闭时拒绝新图片，停用历史图片注入，保留附件与账本。日志、trace 和桥回包不携带原图 base64；trace 只记图片引用、数量及未提供数。模型拒绝或连接失败仍是失败轮，不能宣称已看见或分析完成。

原图会出站到当前配置的视觉模型端点；后续轮为维持图片上下文可能重复出站、增加延迟和 token 使用。回滚为关闭开关并正常重启；无 schema 迁移。

验收与待完成项见 [图片链路验收报告](../post-lv2/Image-Input-Acceptance-2026-10-08.md)。用户本轮授权“启用不过不用再重启共存入口直接关闭即可”：已设 `CHARACTER_IMAGE_INPUT_ENABLED=true`，检查时共存核心 / 监听 / 数据库租约均已停止，因此保持关闭，没有重启或打开生产数据库。上轮 owner 没有留下 `cleanClose`，不能将其表述为本轮正常关库。首次运行与自然首用尚未观察，下次正常启动时加载新配置。

## 2026-10-08 真实入口复验追加

用户授权立即测试真实 QQ 收图与皮套上传。沿用真实 NapCat 和已安装网页，接到全新隔离库与测试模型；正式共存入口仍关闭，生产库没有打开或复制。QQ 本人发送的普通图片及后续纯文字追问均已实际收到并回复，用户确认收到答案。

网页实测发现冻结上游的回形针仅是占位按钮，没有点击处理器或文件输入。经既有 `postlv2-expression-frontend.py` 可重复构建补丁补齐原生文件选择与 FileReader，图片通过原 `useTextInput → text-input.images → BatchInput.images` 提交。没有另造 WebSocket 或模型调用路径。支持图文一起发、纯图片发送、发送前移除及格式/数量/字节校验；文字提问、历史图片与原有提交计时锚沿用原链路。

真实网页已观察到识图回复、无附件的历史两图比较与浏览器播放回报；该读数不替代生产模型自然首用，也不证明真人听感。复验记录与临时启动器异常分列见验收报告追加节。
