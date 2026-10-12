# 当前语音识别方案与候选比较

日期：2026-10-03。范围：独立麦克风测试与本机选型；新版已按用户授权替换为当前默认并接入隔离联合外壳，但不代表 LG 持续对话、M12 真人演示或生产激活已完成。

## 当前实际运行的方案

`sounddevice==0.5.6` / PortAudio 采集 Windows 默认麦克风 → 每 100 ms 喂一块音频 → `sherpa-onnx==1.13.8` 在线 Transducer → 输出版本递增的 partial / final。

缺省模型为 **`sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`**；CPU 两个线程，模型特征采样率 16 kHz。旧版 14M 仍可用 `--model 14m` 回退。当前默认设备以原生 44.1 kHz、单声道采集，由 sherpa 重采样。停顿端点结束单句，最长采集 15 秒。语音在本机处理，完整录音和转录只写 `artifacts/post-lv2/local/`。独立入口不调用 LG 模型或数据库；联合外壳则把最终 ASR 交给 LG bridge，再进入既有回复守卫与 TTS。

这套方案已有持续分块和中间结果的本机证据；首次真人口述准确性却为 **FAIL**。因此 14M 的快、轻不能替代真人准确性验收。

## 本轮实际测过的替代

候选：**`sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`**。由[官方 sherpa 模型目录](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)提供，包内说明指向 [icefall 的中文 large 流式模型](https://github.com/k2-fsa/icefall/blob/master/egs/multi_zh-hans/ASR/RESULTS.md#multi-chinese-datasets-char-based-training-results-streaming-on-zipformer-large-model)。上游训练说明列其约 160M 参数。候选仍是真正的在线 Transducer，能复用当前采集与中间结果流程。

模型压缩包 132,634,597 字节，SHA-256：`5a2832047ea1f97dd0dc595b816c230c4bafad65cfc0341fa57517cadc50afd0`。encoder 161,141,793 字节和 joiner 1,033,416 字节是 int8；decoder 5,165,083 字节为 FP32。模型保存在外部依赖目录，未加入 Git。

对用户首次录音作同条件回放：44.1 kHz 输入、100 ms 分块、greedy search、CPU 两线程、相同端点参数；没有提示参考答案、热词或文字替换。参考文本由用户提供；CER 去掉标点与空白后按字符编辑距离计算。

| 模型 | 错误字符 / 参考字符 | CER | 中间文字变化 | 模型加载 | 纯解码耗时 / 4.6 秒录音 |
|---|---:|---:|---:|---:|---:|
| 原 14M int8 | 8 / 12 | 66.7% | 3 | 591 ms | 90 ms，RTF 0.020 |
| 2025 中文 Zipformer | 2 / 12 | 16.7% | 7 | 3,380 ms | 382 ms，RTF 0.083 |

这些耗时是一次非实时回放的本机读数，不含麦克风等候、LG、TTS 和播放，也不是延迟承诺。首次实时运行与回放使用的输入分别是 float32 与保存的 PCM16，旧模型的最终文字有轻微差异，分别保留，不覆盖首次 FAIL。候选 modified beam search（4 条路径）仍错 2 字，未解决该句歧义，故未引入新的解码默认值。

**结论：候选在第一条保存录音上明显改善，但仍未逐字正确。随后用新版候选做了一次新的真人麦克风复测，用户核对为正确（5.0 秒、7 次 partial、0 次输入溢出），并授权替换默认和接入联合外壳。** 这仍是一条真人样本，不能宣布普遍准确；音频与完整转录、参考文本保留在 local，公共证据只登记摘要与计数。

许可：sherpa 代码与具体权重分开登记。候选包内只有转换来源和训练代码链接，无模型许可声明；其[上游模型卡](https://huggingface.co/yuekai/icefall-asr-multi-zh-hans-zipformer-large)当前不可读取。候选权重为 **UNKNOWN**，不能由框架许可推导权重许可；尚不进入 WP0 冻结方案。

## GitHub 候选与取舍

以下项目按官方文档、代码和模型卡核对，没有把上游成绩当成本机结果。后三者本轮未安装或调用，也没有上传这份录音。

| 方案 | 对当前目标的价值 | 接入代价 / 未验证项 | 许可登记 |
|---|---|---|---|
| [sherpa-onnx 新中文 Zipformer](https://github.com/k2-fsa/sherpa-onnx) | 已有本机回放改善；沿用在线识别与 CPU，且已有 1 条真人复测 PASS，接入改动小 | 仅 1 条真人样本；准确率、噪声与并发 TTS 均未充分验收 | 框架 Apache-2.0；本候选权重 UNKNOWN |
| [FunASR Paraformer-zh-streaming](https://github.com/modelscope/FunASR) | 面向中文的原生流式候选，官方 SDK 有逐块输入、cache 与最终块标记；应优先做下一组本机对照 | 需要对应模型和运行依赖；官方示例使用 600 ms 输入块，本机首字、定稿时延和 CPU 负载未测 | 框架 MIT；[模型另有条款](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)，须按下载权重核对 |
| [Qwen3-ASR 0.6B / 1.7B](https://github.com/QwenLM/Qwen3-ASR) | 值得作为中文复杂环境、多语种与方言准确性的候选；有官方流式接口 | 官方流式只支持 vLLM；[vLLM 不原生支持 Windows](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)，需考虑 WSL/Linux。还要测与现有 GPU TTS 共用时的资源和响应，不能拿批量吞吐当首字时延 | 代码 Apache-2.0；[0.6B 模型卡](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)标注 Apache-2.0，其他权重按具体卡核对 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 可作为完整录音的准确性对照，CTranslate2 推理路线成熟 | 实时服务由额外社区集成提供；需评估切块、重解码和定稿策略，当前在线交互的优先级较低 | 框架 MIT；模型按下载来源另核 |

SenseVoice、Fun-ASR-Nano 与 Paraformer-streaming 是不同模型。不能因为某个离线模型解码快，就将它当作当前在线 partial 链的直接替代。Qwen3-ASR 的 Transformers 离线入口也不能替代官方 vLLM 流式入口。

## 建议与验收条件

短期先用可复用现有入口的中文 Zipformer 候选做新口述；下一组应对照 Paraformer-zh-streaming。需要多语种、方言或更复杂声学场景时再测 Qwen3-ASR。这个顺序依据接入成本与当前中文流式目标，不是声称哪一家普遍最准。

选择依据至少包含：用户未提前指定的独立中文句子、静音、自然停顿、噪声、人名/专有词、说到一半纠正；同一音频回放和新真人采集分列。记录 CER、首个有效 partial、话音结束到 final 的时间、CPU/GPU 占用及 TTS 共用影响。选择模型后再做 LG 轮次接线、取消与播放对账；一条测例正确不等于 WP5/M12 PASS。
