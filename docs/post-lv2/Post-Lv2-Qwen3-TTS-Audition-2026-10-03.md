# Qwen3-TTS 1.7B CustomVoice 本机试听

日期：2026-10-03。当前选型：**Qwen3-TTS 1.7B CustomVoice / Ono_Anna**，中文合成默认参数为 `speaker=Ono_Anna`、`language=Chinese`、空 `instruct`。本批完成独立环境、模型下载与校验、四种内置女声的本机离线合成，没有修改 LG 的生产配置或角色状态。

**试听后的用户裁定**：用户明确表示“Ono_Anna，决定就它了”。[声线选择记录](../../artifacts/post-lv2/postlv2-qwen3-voice-selection-20261003/selection.json)关联到本批 Ono_Anna 的已交付样本；模型支持列表与样本 SHA-256 已核对。声线选择已完成，实时运行接线与性能验收仍按 S3/S4 另行执行。以下四声线测量与合成过程保留为本批历史事实。

## 同一句中文

> 别紧张，极创工作室的二面我们一起准备，先把项目讲清楚，再练一遍分工，遇到不确定的问题，就一起确认思路。

四种女声均使用 `language=Chinese`、空 `instruct`、每次生成前重置种子 `42`、`non_streaming_mode=True`、`max_new_tokens=512`，其余沿用模型生成配置。没有音量归一化、变速、裁切或后期修音。

| 声线 | 官方标注的母语 | 音频时长 | 完整合成耗时 | RTF |
|---|---|---:|---:|---:|
| Vivian | 中文 | 12.40 s | 44.28 s | 3.57 |
| Serena | 中文 | 9.60 s | 23.14 s | 2.41 |
| Ono_Anna | 日语；本次合成中文 | 10.32 s | 23.76 s | 2.30 |
| Sohee | 韩语；本次合成中文 | 10.56 s | 21.98 s | 2.08 |

Vivian 是加载后首次生成，后续三个共用同一个模型实例；这张表不能作为声线间的公平速度排名。四份文件均为 24 kHz、单声道、PCM16 WAV，写入后读回验证帧数与采样率、有限非零波形、四个互异的文件哈希；生成波形峰值均小于 1。音色是否适合由用户试听判断，本批没有自动接受某个声线。

## 本机文件与运行环境

- 声音目录：`artifacts/post-lv2/local/postlv2-qwen3-tts-20261003-01/`，文件为 `Vivian.wav`、`Serena.wav`、`Ono_Anna.wav`、`Sohee.wav`；已验证命中 `git check-ignore`，声音不提交。
- [机器测量](../../artifacts/post-lv2/postlv2-qwen3-tts-20261003-01/manifest.json)：保存权重与音频哈希、同一句台词、有效参数、环境版本、显存与耗时。
- 合成脚本：`C:\Users\user\postlv2-deps\qwen3-tts-audition.py`；本批实际执行版本 SHA-256 为 `ff8063753f1fa1800fbc0d7041c82349ab64c16d57466323eff5bf1aacb2c17e`，留在本机依赖目录供后续复用。
- 独立环境：`C:\Users\user\postlv2-deps\qwen3-tts-venv`。Python 3.12.13、qwen-tts 0.1.1、PyTorch/torchaudio 2.11.0+cu128、Transformers 4.57.3、Accelerate 1.12.0。
- RTX 5080 Laptop GPU；CUDA 12.8；BF16、SDPA。实际 GPU 矩阵运算与模型合成均已运行。模型加载耗时 3.76 s；本批最大 PyTorch 分配显存约 4.26 GiB，不代表整个进程或显卡总占用。
- SoX 可执行文件与 FlashAttention 未安装；导入时产生提示，但本批 CustomVoice 合成正常完成，使用 PyTorch SDPA。

## 模型来源与校验

[官方模型卡](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)标注 `apache-2.0`；本机 README 保留同一标注。锁定 Hugging Face revision `0c0e3051f131929182e2c023b9537f8b1c68adfe`；配置、文本 tokenizer 与音频解码器从该 revision 下载。主权重的大文件自动下载阻塞后，提供[官方 ModelScope 文件链接](https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/resolve/master/model.safetensors)，由用户下载并放入模型目录。已将外层同名文件夹内的实际权重移到模型根目录；权重字节未修改。

| 文件 | 字节 | 与官方文件逐字节一致的 SHA-256 |
|---|---:|---|
| `model.safetensors` | 3,833,402,552 | `38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137` |
| `speech_tokenizer/model.safetensors` | 682,293,092 | `836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258` |

模型目录：`C:\Users\user\postlv2-deps\models\Qwen3-TTS-12Hz-1.7B-CustomVoice`。合成时设置 Hugging Face 与 Transformers 离线模式，模型加载使用 `local_files_only=True`。

重跑时使用新的输出目录与证据目录，保留本批读数：

```powershell
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HUB_DISABLE_PROGRESS_BARS = '1'
$env:TOKENIZERS_PARALLELISM = 'false'
$env:PYTHONUTF8 = '1'
& 'C:/Users/user/postlv2-deps/qwen3-tts-venv/Scripts/python.exe' -u 'C:/Users/user/postlv2-deps/qwen3-tts-audition.py' `
  --model-dir 'C:/Users/user/postlv2-deps/models/Qwen3-TTS-12Hz-1.7B-CustomVoice' `
  --output-dir 'C:/Users/user/Desktop/project LG/artifacts/post-lv2/local/postlv2-qwen3-tts-new-run' `
  --manifest 'C:/Users/user/Desktop/project LG/artifacts/post-lv2/postlv2-qwen3-tts-new-run/manifest.json'
```

## 能力与边界

新增本机能力是 **Qwen 离线语音合成**；LG 正式运行时新增能力为 **NONE**。现有 VITS 工程探针及其历史 PASS 保留。本批没有接入 LG 回复、修改 `.env`、读写角色数据库、自动选择声线或宣称真人已试听认可。

测量是完整波形生成时间，当前 RTF 大于 1。流式首段出音、浏览器实际播放、10 秒首反馈、情绪接线、插话取消与播放对账均未在本批验证，需在 S3/S4 接线时另测。
