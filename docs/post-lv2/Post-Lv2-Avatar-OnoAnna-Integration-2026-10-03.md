# 后 Lv2 皮套与 Ono_Anna 接入记录

日期：2026-10-03。该记录描述本次工程接入的实际边界，不把真人体验或 Lv4.5 验收提前算作通过。

## 已接入

- 外壳固定为 Open-LLM-VTuber backend `992309c0aa19845960228f880013d4685fde93b5`，frontend `06a659b114fff788cf0daaa86e484576db4975bf`。
- 下载目录 `C:\Users\user\Downloads\ulvm2_0001\ulvm2_0001` 被复制到外壳的 `live2d-models/lg_ulvm2_0001`。原始资源没有改写。
- 模型注册了原包 35 个 `.exp3.json`，另加一个只做淡出的 `neutral`，共 36 个表情；`EyeBlink` 使用 `ParamEyeLOpen` / `ParamEyeROpen`，`LipSync` 使用 `ParamMouthOpenY`。
- TTS 固定为本机的 `Qwen3-TTS-12Hz-1.7B-CustomVoice`，speaker 固定为 `Ono_Anna`。ASR 固定为 `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`；当前适配器处理最终一段音频，不把联合外壳宣称成流式 partial。
- 外壳通过 `scripts/postlv2-bridge-sandbox.ts` 启动 LG 桥。桥在导入数据库相关模块前创建生产库副本，外壳不能更换 LG 身份、历史或记忆，也没有默认 Agent 回退路径。

皮套原作者和资源许可仍以用户提供的 [BOOTH 商品页](https://booth.pm/ko/items/4154562?utm_source=chatgpt.com) 为准；本工程只在本机使用，不重新分发资源。

## 本机工程冒烟读数

`pnpm postlv2:avatar:verify` 已通过：固定版本、模型引用、36 个表情、眨眼/口型参数、Ono_Anna、ASR/TTS 配置均可读回。

2026-10-03 用户授权后，外壳生成配置已切换到新版 ASR 的 `encoder.int8.onnx`、`decoder.onnx`、`joiner.int8.onnx` 和 `tokens.txt`；启动时会先检查这四个文件。服务健康端点返回 `200`，隔离模式和 LG bridge 进程在线。

浏览器冒烟也已完成：页面显示该模型，输入一条短句后，LG 桥返回带 `replyId` 的已检查回复；页面显示的字幕是“嗯，在。”，Ono_Anna 生成 24 kHz WAV，97,920 帧（约 4.08 秒），合成耗时 26.35 秒。`last_turn.checked_text_sha256` 与 `last_synthesis.text_sha256` 相同，说明合成输入就是这次检查后的回复。

这个合成速度目前明显达不到媒体契约里的实时目标，因此只记录为“链路已通”，不记录为低延迟通过。页面的播放完成回报由固定外壳继续处理；真人是否听清、音色是否合适、麦克风识别是否准确，均没有用工程冒烟代替。

## 启动与后续真人测试

在仓库根目录运行：

```powershell
pnpm postlv2:avatar
```

然后打开 <http://127.0.0.1:12393>。启动脚本会重新校验固定外壳并生成配置；LG 只使用隔离数据库副本。你可以在外壳中依次测试：文字输入和播放、麦克风最终转录、说话时打断、重新开始一轮，以及实际扬声器/耳机听感。完整的 60 次延迟样本、真人 M12 演示、持续对话和表情状态全量对账仍需真人测试记录后再判定。

## 2026-10-04 flash-attn 安装与退出游戏后复测

`flash-attn 2.8.3.post1` 已编译安装并通过本机 GPU 原生运算探针。后台游戏会干扰速度判断；退出游戏后，SDPA 长问候平均 9.45 秒生成 4.00 秒音频，FlashAttention 平均 8.90 秒生成 3.52 秒音频。按音频时长归一化后未见明显、稳定的整体加速收益，外壳继续使用 SDPA，安装包保留。具体环境、样本与边界见 [安装和性能记录](Post-Lv2-FlashAttention-Installation-2026-10-04.md)。
