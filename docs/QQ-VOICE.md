# QQ 普通回复语音

QQ 普通私聊和原本获准的群聊可使用完整语音消息。每轮由角色结合人格、对话和用户当前意愿选择文字或语音；程序不按关键词、概率或频次替她选择。群里是否回复仍走原有判断和权限。

本功能默认关闭，与 avatar/Omni 的实时语音分别配置；不增加入站 ASR、语音通话、微信语音、提醒、转告或主动消息的语音行为，也不提供向多个群或联系人群发的功能。

## 配置

先完成 [QQ 后端](QQ-DEPLOYMENT.md)和自己的正式模型/数据库配置。TTS 配置写在项目根目录的 **.env**，不是 .env.qq；共存核心和 QQ 外壳必须使用同一份配置。

```dotenv
CHARACTER_QQ_VOICE_REPLY=true
CHARACTER_QQ_VOICE_OUTPUT=true
CHARACTER_QQ_TTS_PROTOCOL=qwen-tts
CHARACTER_QQ_TTS_URL=https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
CHARACTER_QQ_TTS_API_KEY=YOUR_TTS_API_KEY
CHARACTER_QQ_TTS_MODEL=qwen3-tts-flash
CHARACTER_QQ_TTS_VOICE=Chelsie
# Optional, private, writable by the service user:
CHARACTER_QQ_DELIVERY_JOURNAL=data/qq-reply-delivery.jsonl
```

端点、地域、工作空间及模型可用性按自己的阿里云账户选择，密钥与端点须匹配；上方是官方端点示例，不包含可用凭据。参考阿里云 [TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api)及[音色列表](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)。Chelsie 为配置示例，音色不会由聊天正文任意改写。

qwen-tts 接收完整 text/voice 输入，最多 600 字符；超过限制回落文字，不截断或改写正文。HTTP 执行器也保留原 OpenAI 兼容形状及显式 dashscope 协议，必须按自己的提供方选择相符协议；不能只替换模型名称就认为兼容。

确认自己的目录权限和配置后，有序重启当前唯一核心与外壳。独立 QQ 运行入口仍为：

```sh
pnpm qq:chat --check
pnpm qq:chat
```

已有共存核心或 systemd 服务时沿用原编排重启，不另开同账号的第二个后端或认知核心。双开关必须同时生效，TTS 四项配置齐全且日志可用才装载语音执行器。

## 交付和失败

- 模型同轮给出正文和呈现媒介；程序在回复处理后将最终正文交给 TTS，不另开自由聊天模型生成另一份语音稿。
- 完整 WAV 经 PCM16、大小和时长校验后作为 OneBot record 发送；上限 4 MiB、约 60 秒。后端负责最终平台编码，需用自己的固定 LLBot/PMHQ 环境验证转换和播放。
- 选择文字时不调用 TTS。无端口、合成失败、坏音频或超限回落文字；平台明确拒绝 record 时只尝试一次文字兜底。
- 超时、断线或缺少发送回执表示结果不明，不自动重发。逻辑回复先写持久化占用，重启遗留占用记未知，防止重复发送；仍以单持有者和文件锁为前提。
- 来源附录按原规则单独发文字并单独记录；语音回落文字时保留附录。日志不存正文或音频，仅存摘要、状态与必要测量。
- 平台接受不表示对方听到或已读。上一轮投递事实只按当前会话上一 replyId 查询，不能取另一个房间的最新记录充当上下文。

## 验证范围

```sh
pnpm postlv2:qq-voice-reply:verify
pnpm postlv2:qq-voice-delivery:verify
# Database integration: run only in an isolated serversim PostgreSQL test target:
pnpm serversim:pgtest -- postlv2:qq-voice-main:verify
```

前两项使用本机假 OneBot/TTS 与临时日志，不发真实消息；main 门验证正式入口、群聊目标、文字零合成、格式冲突回归及微信/avatar 隔离。普通入口的最终 prompt 保留旧格式；只有真正编译进 QQ 媒介 section 的轮次才要求封套，不能被“禁止 XML”的普通回复尾部覆盖。

源码和模板不会激活任何人的生产环境。公开副本的真实模型自主选择、真实 QQ 接受、固定后端转码和真人收听需要操作者另行验证；离线机制检查不替代这些结果。


## 群任务中的引用与条数（2026-10-30）

群任务语音的独立引用文字、record 和来源附录分别计入对外条数；record 不与原生 reply 段放在同一条消息，避免客户端隐藏播放。失败回落受任务授权约束，结果不明不重发。详见 [群任务指南](QQ-GROUP-TASKS.md)。
