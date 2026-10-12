# 中文语音准确率与响应速度选型

日期：2026-10-04。依据用户的新要求：同时改善识别准确率和话音结束后的等待，两遍识别作为备用，并寻找更适合当前皮套的语音合成模型。

本记录区分现有工程事实、本机小样本和上游能力。选型研究及旧录音回放不代表新模型已接入、正式默认已更换或真人体验验收通过。

## 当前等待发生在哪里

当前皮套网页完成自动断句后，把整段音频送给 CPU Zipformer；LG bridge 返回完整、已检查的回复和表达分句后，TTS 逐段生成。`scripts/postlv2_vtuber_runtime.py` 的适配器调用 `generate_custom_voice(..., non_streaming_mode=True)`，得到完整音频后写 WAV；发送任务等这个文件完成才构造网页音频包。

本机 `qwen-tts 0.1.1` 的 `generate_custom_voice` 会先完成 `model.generate`，再统一调用 tokenizer 解码并返回音频数组。将 `non_streaming_mode` 改为 false 不会让这个 Python 方法逐块返回音频，不能将单一参数变更当成播放流式化。

[退出游戏后的历史对照](Post-Lv2-FlashAttention-Installation-2026-10-04.md)中，SDPA 长句平均 9.45 秒生成 4.00 秒音频，平均 RTF 2.362；FlashAttention 的音频长度不同，未显示稳定的归一化提速收益。该读数不含本次的新模型，也不包含整轮 LG 等待。当前输出链路要同时改善实际生成速率与首段音频等待；仅提前发送音频不能保证连续播放。

本轮只读 GPU 快照：RTX 5080 Laptop，显存总量 16,303 MiB，已用 11,669 MiB，GPU 利用率 64%。这是瞬时负载，不能据此断言游戏是全部延迟的原因；本轮没有在这种状态下强行加载第二个 GPU 模型。

## 识别：优先单遍，比较速度与准确率的共同收益

此前准确率优先的 Qwen3-ASR-1.7B 建议，按本次新增的速度要求扩展为三个候选对照。

| 候选 | 为什么进入对照 | 工程边界 |
|---|---|---|
| [SenseVoiceSmall / sherpa-onnx INT8](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html) | 非自回归识别，现有 sherpa-onnx 已有 CPU 接口；适合把 GPU 留给 TTS 与游戏 | 完整音频识别可用于当前网页；不是独立麦克风 partial 入口的直接流式替代。识别出的情绪标签不作为 LG 表达意图 |
| [Qwen3-ASR-0.6B](https://github.com/QwenLM/Qwen3-ASR) | 上游明确将其定位为准确率与效率之间的取舍，适合与 CPU 候选比较 | 本机尚未测；GPU 与 TTS 共享资源，不能用高并发吞吐推断单句延迟 |
| Qwen3-ASR-1.7B | 保留为更强识别能力的对照；用于判断 0.6B 是否牺牲关键口音、噪声与人名表现 | 本机尚未测；不能因参数更多便宣布更适合当前实时聊天 |

Qwen 的 Transformers 接口能处理完整录音；官方流式入口依赖 vLLM。[vLLM 官方安装文档](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)要求 Linux，原生 Windows 不在支持范围。当前 WSL 只列出 `docker-desktop`，尚无本次验证过的 Linux 语音服务环境。

两遍识别保留为候选主方案无法同时满足准确率和响应需求时的备用设计。第二遍必须从原音重识别，只将 final 交给 LG；不以聊天模型猜测或润色文本代替识别证据。[官方两遍识别示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/two-pass-speech-recognition-from-microphone.py)可作为实现参考，当前网页未接入。

若错误表现为句首/句尾丢失、停顿后半句缺失，先查实际录音与 VAD 边界。ASR 无法恢复已经没有采集到的语音。名字和数字需要单列样本，不拿整体平均分掩盖关键错误。

## 合成：首选 CosyVoice3，保留 Ono_Anna 基准

“更好”按中文发音、声线稳定性、表达指令、首段音频、连续播放及游戏共用时的资源综合判断。Ono_Anna 是已选声线；新候选可尝试使用已有参考音频复刻，但相似度需要试听，不能承诺完全相同。

| 候选 | 对这次目标的价值 | 取舍与实测状态 |
|---|---|---|
| **[Fun-CosyVoice3-0.5B-2512](https://github.com/QwenAudio/CosyVoice)，新模型首选** | 支持中文、零样本声线复刻、情绪/语速指令；PyTorch 接口支持生成时分块返回音频。适合先比较首段速度与连续输出 | 上游 150 ms 是其发布条件下的能力声明，不是本机保证。现有目录仅有代码，尚无这套权重和本机试听/计时 |
| **[VoxCPM2](https://github.com/OpenBMB/VoxCPM)，音质与表达对照** | 中文与多语种、声线复刻、可控情绪/语速；有原生 `generate_streaming` 生成器 | 模型 2B、输出 48 kHz，资源需求和实际速度需测。[模型卡](https://huggingface.co/openbmb/VoxCPM2)上的 RTX 4090 数字不能外推到本机 Laptop GPU |
| **现有 Qwen3-TTS-1.7B + [vLLM-Omni 流式引擎](https://github.com/vllm-project/vllm-omni/blob/main/examples/online_serving/text_to_speech/README.md#qwen3-tts)，保留声线路线** | 使用相同 CustomVoice 权重和 Ono_Anna，不增加复刻误差；当前 vLLM-Omni 提供生成时解码 PCM 的服务 | 需要独立 WSL/Linux 环境和显存配置。本机尚未验证；官方 Qwen README 的旧“仅离线”说明与当前 vLLM-Omni 服务文档存在更新差异，以具体版本、代码与探针判定 |

当前官方 [CosyVoice requirements](https://github.com/QwenAudio/CosyVoice/blob/main/requirements.txt)固定 `torch==2.3.1` / `torchaudio==2.3.1`，而本机既有 Qwen 环境为支持该显卡的 `torch 2.11.0+cu128`。候选应在独立环境检查 CUDA 与依赖兼容性，不能把整份旧 requirements 覆盖进现有皮套环境。初次探针优先原生 PyTorch 分块接口，TensorRT/vLLM 加速单列后续验证。

Qwen3-TTS-0.6B CustomVoice 虽支持相同预设声线，但[官方模型表](https://github.com/QwenLM/Qwen3-TTS#released-models-description-and-download)未列其指令控制能力；当前 SDK 也会对 `0b6` 清空 instruct。它会失去当前六类表达提示的执行能力，故不是本次的首选直接替代。

[Fish Audio S2 Pro](https://github.com/fishaudio/fish-speech)的细粒度情绪与流式能力值得参考，但其 4B 主模型加 400M 快解码器，以及 H200 上的官方计时，使它不适合作为本机与游戏并行时的第一轮速度候选。当前 [vLLM-Omni 模型表](https://github.com/vllm-project/vllm-omni/blob/main/examples/online_serving/text_to_speech/README.md#supported-models)将 IndexTTS-2/2.5 的响应标注为 `non-chunk`；其情绪控制可以另做质量对照，不能将这种 HTTP streaming 当成生成时首段提前输出。

## 本机小样本与下一步判据

CPU 回放探针仅使用两份已保存的真人录音（同一句话）和静音，参考答案不传入模型。公共结果仅登记音频/文字摘要、错字计数与耗时，完整识别文字留在 `artifacts/post-lv2/local/`。五次热调用用于初步观察，不构成稳定 p95 或普遍准确率证据，也不证明当前实际错误已复现。

本机探针结果：**NOT RUN / 等待用户确认测试时机**。用户在 2026-10-04 明确说明准备玩游戏，要求执行 CPU/GPU 测试前先暂停并通知；本轮没有加载 SenseVoice、Qwen3-ASR 或新 TTS 模型进行推理，也不依据尚未执行的探针填写任何性能数字。只有用户明确表示可以测试后，才开始 CPU/GPU 推理与对照。Qwen3-ASR GPU 候选与全部新 TTS 候选的实际推理、试听、网页接线同样为 NOT RUN。

SenseVoice 官方压缩包预期为 163,002,883 字节，GitHub Release API 给出的 SHA-256 为 `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`。下载及分段续传遇到超时，随后连接超时/重置，故当前状态为 **INCOMPLETE**。已有字节保存在外部模型目录，起始文件以 `.partial` 标识；模型没有解压或加载。续传范围和文件长度见 [准备记录](../../artifacts/post-lv2/asr-tts-selection-20261004/preparation.json)。源代码语法已核对；探针内六项编辑距离/规范化自检尚未执行，不能写成已通过。

实施顺序：

1. 同一批音频对照当前 Zipformer、SenseVoice、Qwen3-ASR 0.6B/1.7B；增加独立短句、长句、停顿、口音、噪声、人名和数字，确认 CER 与 final 等待的共同收益。
2. 对照现有 Ono_Anna、CosyVoice3、VoxCPM2；同文本覆盖六类表达，分列冷启动、热调用、首段音频时间、整句 RTF、最长等待、显存和实际听感。主观声线不能由自动指标替代。
3. 按结果接入获选 ASR 和 TTS，浏览器采用连续音频队列；用 `requestId/replyId/segmentId/generation` 检查取消、旧音频丢弃、口型和表情。现有 LG 检查后的字幕与朗读内容继续一致；只向 TTS 输入已经通过守卫的文本。

首段音频变快与整句生成变快分别计时。流式输出要检查播放中是否断续；不能仅用一个小首包认定连续实时播放通过。候选通过小样本不自动变更正式启动默认，更不自动改 LG 人格、记忆语义或生产数据库。

## 来源与复核

上述 GitHub、官方文档与发布方模型卡于 2026-10-04 阅读。上游能力和推荐顺序均不是本机验收结论。探针源见 `artifacts/post-lv2/asr-tts-selection-20261004/probe-asr-cpu.py.txt`；旧模型对照及完整参考文本见本机 `artifacts/post-lv2/local/microphone-model-comparison.json`。

本次研究不修改运行默认或客户端；默认仍为 2025 中文 Zipformer 与 Qwen3-TTS-1.7B / Ono_Anna。

## 后续执行记录（2026-10-04）

上文是等待测试时机时的准备快照，原 NOT RUN 与不完整压缩包状态保留。用户随后允许 CPU/GPU 测试、实际试听并选择 CosyVoice3，要求修复俏皮句尾差异。模型文件现已下载校验，SenseVoice 单遍识别及 CosyVoice3 原生分块合成已接入皮套；启动脚本默认已更新，原语音档保留。修复后 24 段独立回读一致，实际浏览器回放和打断通过；全仓库 CI 仍有既有 FC-T04 失败，真人麦克风和正式新语音档运行未验收。当前状态、数字口径及逐项证据以 [后续接线与实测报告](Post-Lv2-Speech-Integration-2026-10-04.md)为准。
