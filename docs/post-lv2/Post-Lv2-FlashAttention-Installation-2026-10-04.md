# flash-attn 安装与 Ono_Anna 性能复测

日期：2026-10-03 至 2026-10-04。用户授权先安装 flash-attn，并在指出后台游戏可能影响耗时后，同意退出游戏复测。

## 安装结果

`flash-attn 2.8.3.post1` 已从官方 PyPI 源码编译并安装到 `C:\Users\user\postlv2-deps\qwen3-tts-venv`。本机 CUDA 原生固定长度/可变长度前向运算通过 float32 PyTorch attention 对照，反向梯度有限性检查通过。这里的 PASS 只覆盖这些安装探针。

| 项目 | 本机版本或结果 |
| --- | --- |
| GPU | NVIDIA GeForce RTX 5080 Laptop GPU，compute capability 12.0 |
| Python / PyTorch | 3.12.13 / 2.11.0+cu128 |
| CUDA Toolkit / MSVC | 12.8.93 / 14.38.33130 |
| qwen-tts / transformers | 0.1.1 / 4.57.3 |
| 编译目标 / 并发 | `sm_120` / `MAX_JOBS=4`，`NVCC_THREADS=1` |
| 源码 SHA256 | `55d5103ed846da8b56e0797acf4bde07dee4b1c7e8907fcfc6699c203030c348` |
| wheel SHA256 | `293847188946c9068d82f419a312e0b27b1afb0d421d3e3197a1a0c26a1467ff` |
| 原生探针最大绝对误差 | 0.0098109245（BF16，对照容差 atol/rtol 各 0.03） |

wheel 保留在 `C:\Users\user\postlv2-deps\flash-attn-build\flash_attn-2.8.3.post1-cp312-cp312-win_amd64.whl`。编译工具链已装到本机；CUDA/编译器路径与并发设置仅在构建命令内指定。Torch 编译助手对本机 UTF-8 编译器诊断的解码调整也只在构建进程内生效，没有修改已安装的 Torch、FlashAttention 算法或 Qwen 源码。

安装前，这个 12Hz 模型的运行配置已经显式使用 PyTorch SDPA。SDK 的另一个 25Hz tokenizer 模块带有导入提示，当前实例的 attention 选择应以加载参数和实际调用计数为准。

官方说明：[FlashAttention 源码与安装要求](https://github.com/Dao-AILab/flash-attention)、[CUDA 12.8 Windows 编译器要求](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-installation-guide-microsoft-windows/index.html)、[Qwen3-TTS attention 参数](https://github.com/QwenLM/Qwen3-TTS)。

## 性能测量范围

比较同一本机 `Qwen3-TTS-12Hz-1.7B-CustomVoice`，固定 `Ono_Anna`、中文、BF16、`instruct=""`、`non_streaming_mode=True`、`max_new_tokens=1024` 和随机种子 42。每个模型进程生成“嗯，在。”两次与“你好，我是苏沐薇，很高兴见到你。”两次。计时两端执行 CUDA synchronize，落盘 WAV 不计入合成耗时；包装 transformers attention 注册项，要求所选实现的实际调用次数大于零。

最初未控制后台游戏时，SDPA 长句约 19.2–20.0 秒，FlashAttention 约 28.1–31.2 秒。用户指出游戏负载后，这组结果保留为未控制负载的观察，不能单独证明后端性能高低。

随后暂停皮套服务、释放其 GPU 模型，按 SDPA → FlashAttention → FlashAttention → SDPA 顺序串行复测，并每两秒记录 GPU 利用率、显存、温度、功率和频率。用户声明退出游戏；每次模型加载前另有 GPU 空闲读数。测量不会终止用户的游戏或其它程序。

相同种子仍可能因两种后端的浮点差异生成不同长度音频，因此同时比较合成秒数与 `RTF=合成秒数/音频秒数`。RTF 越低越快。这是有限本机样本，不代替 60 次媒体延迟验收、p95 或真人听感测试。

四个复测进程均正常退出，模型加载前 GPU 利用率依次为 9%、5%、4%、10%，显存为约 2.1–2.3 GiB。每种后端有四次长句与两次短句热调用；各进程的第一次短句保留在原始读数中，未混入热调用均值。

| 后端 | 长句合成耗时范围 / 均值 | 长句音频长度 | 长句平均 RTF | 短句热调用均值 / 平均 RTF |
| --- | --- | --- | --- | --- |
| SDPA | 9.12–10.08 秒 / 9.45 秒 | 4.00 秒 | 2.362 | 3.04 秒 / 2.530 |
| FlashAttention 2 | 8.46–9.25 秒 / 8.90 秒 | 3.52 秒 | 2.529 | 3.80 秒 / 2.499 |

退出游戏后的 SDPA 长句耗时约为此前未控制负载读数的一半，说明先前的运行负载对性能判断有重大影响。两种后端的音频长度不同：FlashAttention 长句总耗时略短，但单位音频长度的耗时较高；短句 RTF 接近。这组有限样本没有显示明显、稳定的整体加速收益。

**运行决定**：保留已安装的 flash-attn，皮套运行配置继续用 SDPA；Ono_Anna、模型和生成参数照旧。两种后端的 RTF 都高于 1，当前非流式合成仍未达到实时目标。以后重新评估后端时，应在游戏退出后比较并保留音频长度与 GPU 负载。

可复核的原始读数、GPU 采样、构建参数、探针源码及文件哈希见 [安装与复测证据](../../artifacts/post-lv2/flash-attn-20261004/receipt.json)。未控制负载的旧读数与退出游戏后的复测放在各自目录中，未覆盖旧文件。WAV 与大构建日志保留在本机依赖目录，没有提交模型资源或二进制 wheel。

## 验证边界

本轮 `pnpm typecheck` 和 `pnpm m4.5:ci` 均退出 0。该离线 CI 聚合器同时读到既有 G14 Live Smoke 的 FAIL（26 通过 / 18 失败）；本轮没有重跑该 Live Smoke，也不据 CI 退出码宣称聚合硬门全绿。CI 重新生成的七份历史证据按预先记录的路径白名单恢复，哈希与运行前一致。

最终运行配置另通过 Python 语法检查、`pnpm postlv2:avatar:verify` 和一次浏览器文字到语音冒烟。服务状态读回为 `sandbox-copy`、LG 进程在线、`Ono_Anna`、`tts_attention=sdpa`；页面显示 LG 的多句回复并回到“已连接 / 空闲”。最后一段为 24 kHz、97,920 帧（4.08 秒），合成 9.80 秒。最后分句的字幕哈希与 TTS 输入哈希相同；整句回复包含多段，未把这个分句检查当作整句哈希一致性检查。具体见 [恢复服务后的冒烟](../../artifacts/post-lv2/flash-attn-20261004/service-smoke.json)。

皮套桥继续使用隔离数据库副本。本次没有用工程测试代替真人麦克风、音色、实际听感和打断体验验收。服务恢复后可在 <http://127.0.0.1:12393> 继续真人测试；启动命令仍是 `pnpm postlv2:avatar`。
