# 外部件与本地运行时清单（External Runtime Inventory）

状态：**VERIFIED 快照**（2026-10-07 实测）。用途：回答**两个问题** ——
"她今天跑在哪些外部件上" 与 "换一台机器，能不能把这些复原出来"。

> **与 [依赖与许可冻结（WP0 · 2026-10-03 · FROZEN）](Post-Lv2-Dependency-and-License-Freeze.md) 的关系**：
> 那一份是 **WP0 当时的决策记录**（含当时**尚未探针**的项，以及 `.npmrc` 死代理的绕法）；
> 本文件是**今天实测的外形**。⚠️ 两份冲突时**以本文件的实测读数为准** ——
> 冻结文档里"CosyVoice 未 clone / Open-LLM-VTuber 未运行 / sherpa-onnx 未下模型"等段落
> 已被 2026-10-03…04 的实际工作取代（其 §3/§4 是历史读数，**不回写**）。
> ⚠️ 许可口径一条不变：本文件只登记"**条款在哪读到**"，**不**主张已获法律意见。

---

## 0. 一句话

**32.5 GB 的外部件全部在工作区之外**（`C:\Users\user\postlv2-deps`，脚本缺省见 `scripts/postlv2-avatar.cmd:5`），
另有 `data/runtime/**` 与 `artifacts/post-lv2/local/**`（两者都被 gitignore）。
⇒ **换机后不能只靠 `git clone` 复原**；下表每一行就是复现所需的身份。

| 根 | 总量 | 进 git？ |
|---|---:|---|
| `C:\Users\user\postlv2-deps` | **32,484 MB**（其中 `models/` **25,523 MB**） | ❌ 工作区之外 |
| `artifacts/post-lv2/local/` | 约 **2.3 GB**（含运行时与证据基线） | ❌ gitignore |
| `data/runtime/` | langmem checkout + venv | ❌ gitignore（`data/`） |

---

## 1. 语音 / 皮套运行时（Python venv，仓库之外）

uv **0.12.4** 建的环境；`POSTLV2_SPEECH_PROFILE` 决定用哪一个（`scripts/postlv2-avatar.cmd:6-8`）。

| venv | Python | 关键包（实测） | 用途 | ⚠️ 备注 |
|---|---|---|---|---|
| **`cosyvoice3-venv`** | 3.12 | （**没有** `cosyvoice*` / `torch*` 的 dist-info） | **当前生产 TTS 档** | ⚠️ **它通过 `speech-base.pth` 借用 `qwen3-tts-venv\Lib\site-packages`**（见下） |
| **`qwen3-tts-venv`** | 3.12 | `qwen_tts 0.1.1` · `torch 2.11.0+cu128` · `flash_attn 2.8.3.post1` · `transformers 4.57.3` · `sherpa_onnx 1.13.8` | `legacy` 档（Qwen3-TTS）+ **被默认档借用** | ⚠️ **删它 = 打坏默认档** |
| `qwen3-asr-venv` | 3.12 | （Qwen3-ASR 候选线） | ASR 候选 | 权重在 `models/Qwen3-ASR-*` |
| `voxcpm2-venv` | 3.12 | — | VoxCPM2 候选 | — |
| `venv` | **3.10.11** | `sherpa_onnx 1.13.8` + `sherpa_onnx_core 1.13.8` | 流式 ASR 探针（Freeze §2.5） | 与上面几个**不同 Python** |

**⚠️ 关键耦合（本轮首次登记）**：`cosyvoice3-venv\Lib\site-packages\speech-base.pth` 的内容是

```text
import site; site.addsitedir('C:\\Users\\user\\postlv2-deps\\qwen3-tts-venv\\Lib\\site-packages')
```

⇒ **两个语音档不是互相独立、可分别回滚的两套**：默认档（CosyVoice3）的 `torch` / `flash-attn` 全在 `qwen3-tts-venv` 里。
重建或删除 `legacy` 档会**同时**打坏默认档。

---

## 2. 外部源码 checkout（仓库之外，`git` 身份已实测）

| 目录 | git HEAD（2026-10-07 实测） | 许可（读到的地方） | 登记处 |
|---|---|---|---|
| `Open-LLM-VTuber` | `992309c0aa19845960228f880013d4685fde93b5` | `LICENSE` = **MIT** + `LICENSE-Live2D.md`（示例模型另行授权） | Freeze §2.1 · Avatar-OnoAnna `:7` · 审计 §11 |
| `Open-LLM-VTuber` 的子模块 `frontend` | `06a659b114fff788cf0daaa86e484576db4975bf` | （随上游） | Expressive-Speech `:77` |
| `Open-LLM-VTuber-Web-source` | `3d57a9a0125a0ca13e5d0967092e4e494ed389e` | ⚠️ **`LICENSE` = "Open-LLM-VTuber License 1.0"**（**自定义许可，非 OSI 标准**）—— 本轮首次登记 | Expressive-Speech `:78` |
| `CosyVoice` | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc` | `LICENSE` = **Apache-2.0** | **Freeze §2.1**（审计 §11 原写"文档未记 commit" = **错**，见 §6 更正） |
| `sherpa-onnx` | `040afe360a38e25daaa325ce8889abf93ea02609` | `LICENSE` = **Apache-2.0** | **Freeze §2.1**（同上更正） |
| `data\runtime\automatic-memory\langmem-48e3c11` | `48e3c11f5bb527282c7d5339c6a87a0b35abccfc`（2026-10-02） | `LICENSE` = **MIT** | ADR-117 / ADR-118（**建议**把 commit 也写进去 —— 目前身份只由目录名承载） |

---

## 3. 模型权重（`postlv2-deps\models`，25,523 MB）

| 模型 | 大小 | 用途 | 许可状态 |
|---|---:|---|---|
| `Qwen3-TTS-12Hz-1.7B-CustomVoice` | 8,046 MB | TTS（`legacy` 档；声线 Ono_Anna） | ⏩ **2026-10-07 已读**：**Apache-2.0** —— 本地模型卡 `README.md:2` front-matter 逐字 `license: apache-2.0`；上游仓库 `License: Apache-2.0`。⚠️ 模型卡对 9 个内置声线（含 `Ono_Anna`）**没有**任何额外条款 |
| `Fun-CosyVoice3-0.5B-2512` | 5,176 MB | **当前生产 TTS 档** | ⏩ **2026-10-07 已读**：**源码 Apache-2.0**（本地 `LICENSE` 头逐字）+ **权重 Apache-2.0**（HF 模型卡 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` front-matter 逐字 `license: apache-2.0`）；`CosyVoice-ttsfrd` 资源同为 Apache-2.0 |
| `VoxCPM2` | 4,731 MB | TTS 候选 | ⏩ **2026-10-07 已读**：**Apache-2.0**（HF 卡 `openbmb/VoxCPM2`，卡上自述 "free for commercial use"）；卡上另写 "**Strictly forbidden** to use for impersonation, fraud, or disinformation. AI-generated content should be clearly labeled." —— ⚠️ **本机没有采用它**，本条只作候选登记 |
| `Qwen3-ASR-1.7B` | 4,485 MB | ASR 候选 | ⏩ **2026-10-07 已读**：**Apache-2.0**（HF 卡 `Qwen/Qwen3-ASR-1.7B`） |
| `Qwen3-ASR-0.6B` | 1,793 MB | ASR 候选 | ⏩ **未单独读**（与 1.7B 同族，但**不**按同族推断许可） |
| `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` | 160 MB | **partial ASR（生产档）** | ⚠️ Freeze §2.4 记"权重许可仍 **UNKNOWN**"。⏩ **2026-10-07：仍是 UNKNOWN，但已定位到门在哪** —— 本地 `README.md`（317 B，全文只有一句"转换自 …"）**没有许可行**；上游 `https://huggingface.co/yuekai/icefall-asr-multi-zh-hans-zipformer-large` 实测 **`gated: "auto"`**（HF API）、raw README **HTTP 401** ⇒ 条款**要登录并接受条件**才读得到。⚠️ 该模型由 icefall `multi_zh-hans` 配方训练（多个公开中文数据集，**各自许可不同，未逐项读**） |
| `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23` | 78 MB | 流式 ASR（Freeze 首个模型） | ✅ 包内 README front-matter `license: apache-2.0`；sha256 冻结在门 `A2` |
| `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | 229 MB | **final ASR（生产档）** | ⏩ **2026-10-07 已读，且结论是"非标准许可"**：包内 `LICENSE` 只有 71 字节、逐字为 `Ref to https://github.com/modelscope/FunASR?tab=readme-ov-file#license`。解析结果 —— **工具箱代码 MIT**，**权重按《FunASR Model Open Source License Agreement v1.1》**（`MODEL_LICENSE` 逐字；HF 模型卡写 `License: model-license`）。⚠️ **可执行义务**：§2.2 要求**署名来源与作者信息并保留模型名**；无担保、风险自负；另有社区行为条款（违反即自动丧失全部许可） |
| `vits-icefall-zh-aishell3` | 204 MB | TTS 回退（许可干净） | ✅ icefall / sherpa-onnx / AISHELL-3 三段 Apache-2.0（Freeze §2.7） |
| `vits-piper-zh_CN-xiao_ya-medium-int8` | 20 MB | ❌ 已否决 | 模型卡写明训练集 **非商用** |
| `vits-zh-hf-fanchen-unity` | 131 MB | 历史回退 | ⚠️ **许可不明**（`L-PL2-05`，已知风险未解决） |
| 皮套模型 `ulvm2_0001`（**`%USERPROFILE%\Downloads`**，不在 `postlv2-deps`） | — | Live2D 皮套 | 素材条款另行适用（BOOTH） |

**⚠️ 目录卫生**：`models/` 根目录混着**未完成下载残留**与探针文件 ——
`sensevoice-download-20261004.part1…part8`（≈90 MB）· `sherpa-onnx-sense-voice-…tar.bz2.partial`（15.4 MB）·
`sensevoice-hf-model-probe.bin` / `sensevoice-tokens-probe.bin`（≈1.3 MB），
另有若干 `candidate-download-*.json` / `*-files.json` / `*-tree.json`（**这些是权重来源的登记依据，别删**）。

### 3.1 "音色条款"这一项的收口（2026-10-07）

Freeze §2.6 ④ / §2.7 与 §6 都记着一条 ⛔「**任何音色条款未读**」。本轮把它查到底了，结论是：
**生产链上不存在一份"音色条款"文件可读** —— 因为生产音色**不是**第三方素材，而是**合成产物**。

链条（逐行可复核，全在 `scripts/postlv2-vtuber-setup.py`）：

```text
① Qwen3-TTS 内置声线 Ono_Anna 合成一段音频
   → artifacts/post-lv2/local/postlv2-qwen3-tts-20261003-01/Ono_Anna.wav      （setup.py:171，gitignore）
② 首次跑 cosyvoice3 档时**复制**到 deps\voices\Ono_Anna-reference.wav        （setup.py:173-176）
   ⚠️ 复制后立刻核对 sha256 = 5d6f1575f4578b43ac1859f651d426b3a0428cb6f03d85a552c9be465d85b18e
      （setup.py:178；不一致就 raise ⇒ 换掉参考音会当场失败）
③ CosyVoice3 用这段参考音做 zero-shot 复刻                              （setup.py:188-190）
```

⇒ 两个端点（Qwen3-TTS 权重、CosyVoice3 权重）**都是 Apache-2.0**，中间是**本机自己生成**的 wav。
因此"音色条款"的准确表述是：**没有第三方声音权参与**；此前那一条 ⛔ 可以改读为"**已查明不存在**"。
真正另行授权的**素材**是 Live2D 皮套（BOOTH，`%USERPROFILE%\Downloads\ulvm2_0001`，**仍未读**）。

⚠️ **但边界必须写下来**：CosyVoice3 的 zero-shot 能力本身可以复刻**任何**声音；
许可给的是**模型使用权**，不是"克隆谁都可以"的通行证。**当前生产配置**只喂自合成参考音、且 sha256 被钉死
⇒ 这条边界现在成立。**一旦有人换掉参考音频**（换成真人录音 / 网上素材），"音色"这一项就要**重新登记**，
本节的结论也随之失效 —— 这不是文档纪律，是 `setup.py:178` 那道断言在结构上要求的事。

---

## 4. 工作区内的运行时（都 gitignore）

| 运行时 | 实测身份 | 落点 | 门 / 登记 |
|---|---|---|---|
| 桌面控制 | `windows_mcp-0.8.7.dist-info` · venv **Python 3.14.0** | `artifacts/post-lv2/local/desktop-runtime/`（210 MB） | `desktop-control:verify` 43/0 · `:probe` 14/0（ADR-106） |
| OCR | **`rapidocr 3.9.2`** · `onnxruntime 1.20.1` · `opencv_python 4.11.0.86` · `numpy 1.26.4` · venv **Python 3.12.13** | `artifacts/post-lv2/local/ocr-runtime/`（372 MB） | `postlv2:role-tool:matrix`（真识别） |
| OCR 模型资产 | `models.json` 记 Det/Cls/Rec 三个 onnx 的 **sha256**（`ch_PP-OCRv4_det_mobile` 4.7 MB · `ch_ppocr_mobile_v2.0_cls_mobile` 586 KB · `ch_PP-OCRv4_rec_mobile` 10.9 MB） | 同上 `models/` | ✅ 指纹在案 |
| OCR 安装报告 | ⚠️ `install-report.json` 的 `install` 数组**为空**（只有环境信息）⇒ 包版本**无存证**（本文件第 4 行的版本是本轮实测补上的） | 同上 | — |
| 浏览器 sidecar | `@playwright/mcp 0.0.83`（Apache-2.0）+ `playwright 1.64.0-alpha-1790635538000`；**lock sha256 在案** + CLI 实测 `Version 0.0.83` | `artifacts/post-lv2/local/productivity-skills-preparation/browser-sidecar/` | 与 `flags.ts` 的缺省 `browserSidecarVersion='0.0.83'` 一致 |
| 自动记忆（LangMem） | git checkout `48e3c11…`（MIT）+ `.venv` | `data/runtime/automatic-memory/langmem-48e3c11/` | ADR-117/118 · `.env` 的 `CHARACTER_MEMORY_AUTOMATIC_PYTHON` 指向它的 `python.exe` |

**⚠️ `artifacts/post-lv2/local/` 是"运行时 + 证据基线"混放区**（本轮实测文件数/体积）：
`utility-skills-preparation` 18,603 文件 / 514 MB · `desktop-runtime` 11,541 / 210 MB · `ocr-runtime` 7,685 / 372 MB ·
`ocr-diagnosis-20261004` 7,718 / 394 MB · `browser-*-check-20261006` 各 ≈8,9xx / 99 MB ·
`qq-ci-baseline-20261006` 8,914 / 98 MB · `s8-daily-20261007` 8,987 / 101 MB · `automatic-memory-20261007` 6,933 / 58 MB · …
⇒ 里面既有**可重建的运行时**（desktop / ocr / sidecar），也有**不可重建的证据基线**（89xx 文件的 CI 快照）。

⚠️ 同目录还有一份 **真实库迁移前备份**：`pglite-backup-before-0014-0016-20261007-011214`（1,250 文件 / 37 MB，
见 [ADR-112](docs/adr/ADR-112-qq-proactive-production-activation.md):81）。**不要**当作可丢弃的临时目录。

---

### 4.1 langmem venv 的可复现登记（2026-10-07；`P2-10` 的交付物）

自动记忆能力（ADR-117/118）跑在一个**工作区之内但被 gitignore** 的 checkout 上：
`data/runtime/automatic-memory/langmem-48e3c11`。此前它的身份**只由目录名承载** ——
下面这组读数是"换机能不能复原"要用的东西（本轮实测，命令可复核）。

| 项 | 实测值 |
|---|---|
| checkout | `data/runtime/automatic-memory/langmem-48e3c11`（gitignore，不进仓库） |
| git HEAD | `48e3c11f5bb527282c7d5339c6a87a0b35abccfc` |
| 许可 | **MIT**（`LICENSE` 首行逐字：`MIT License` / `Copyright (c) 2025 LangChain`） |
| 包版本 | `langmem 0.0.30`（`pyproject.toml`，`requires-python >=3.10`） |
| venv Python | **3.12.13**（MSC v.1944 64 bit）· `.venv/Scripts/python.exe` |
| 依赖清单 | `uv.lock` **4,220 行** / 836,654 字节 / sha256 `4a3ad333…22eea` |
| 装出来的包 | **50 个**（uv 建的 venv，**没有 pip** ⇒ `pip freeze` 是空的，见下） |
| 冻结清单 | `artifacts/post-lv2/local/automatic-memory-20261007/langmem-venv-freeze.txt`（50 行，sha256 `8dfa5d70…eed1a`） |
| 同一目录的身份档 | `…/langmem-venv-identity.json`（本轮实测的机器可读副本，含同样的 sha256） |
| 关键钉版本 | `langchain 1.4.0` · `langchain-core 1.6.1` · `langgraph 1.2.11` · `openai 3.8.0` · `pydantic 2.13.5` · `trustcall 0.0.39` · `httpx 0.28.1` · `langsmith 0.12.1` · `langchain-openai 1.6.0` · `langchain-anthropic 1.7.1` |
| 重建程序 | 在 checkout 根：`uv sync --frozen`（**uv 0.12.4**）⇒ 逐字复现 `uv.lock`；`.env` 的 `CHARACTER_MEMORY_AUTOMATIC_PYTHON` 必须指向新建的 `.venv\Scripts\python.exe` |

⚠️ **本机坑（本轮实测，值得记）**：uv 建的 venv **不含 pip** ⇒ `python -m pip freeze` **静默返回空**（不是报错），
会让人误以为"包一个都没装"。实测的取法是 `importlib.metadata.distributions()`（本轮用它列出 50 个包）。
同型坑在本仓库已经出现过一次（OCR 那次是 `install-report.json` 的数组为空）—— **"空读数"与"没读到"必须分清**。

⚠️ **不主张**：本轮**没有**从零重建一次（只登记身份与版本）⇒ 上表是"复现所需的事实"，**不是**"已复现"。
自动记忆链路能不能跑，归 `pnpm postlv2:automatic-memory:verify`（它不在任何 lane 里，原因见 `manifest.ts` 的排除清单）。

---

## 5. 复现步骤（沿用 Freeze §2.6 的程序，逐条仍然有效）

```text
① clone 到仓库之外的独立目录（不进本仓库工作树、不进 git）
② 记录：仓库 URL · 目标 commit SHA（**不是分支名**）· 抓取时刻
③ 记录：模型/权重文件的 **sha256** · 来源 URL
④ 许可**逐个文件**登记：根 LICENSE + 附加 LICENSE-*.md + **模型自带条款** + **音色条款**
⑤ 把本表对应行的身份替换为实际 SHA/版本，并追加实测读数
⑥ **未完成 ①–④ 的依赖不得进入 WP 验收证据**
```

**本机网络**（Freeze §1.1/§1.2 实测仍然有效）：代理端口是 **7688**（`mesl_lite` 混合端口）；
项目 `.npmrc` 里写死的 `proxy=…:7897` **是死的** ⇒ `pnpm add` 会 `ECONNREFUSED`，
唯一实测有效的绕法是**临时移开 `.npmrc`、装完原样移回**（**不得**把 `.npmrc` 的改动提交）。

**本轮实测用过的命令（可复核）**

```powershell
git -C C:\Users\user\postlv2-deps\Open-LLM-VTuber rev-parse HEAD
git -C C:\Users\user\postlv2-deps\Open-LLM-VTuber submodule status          # frontend 06a659b1…
Get-ChildItem C:\Users\user\postlv2-deps\*\Lib\site-packages -Directory      # 各 venv 的包与版本
Get-Content artifacts\post-lv2\local\ocr-runtime\models.json -Encoding utf8  # 三个 onnx 的 sha256
Get-Content ...\browser-sidecar\install-record.json -Encoding utf8            # sidecar 版本与 lock 指纹
```
> ⚠️ 读 CJK/JSON 一律加 `-Encoding utf8`：`Get-Content` 默认走 cp936，会把好文件读成"坏 JSON"（本机坑）。

---

## 6. 已知缺口（**不主张**"许可已清 / 可复现"）

1. ⏩ **2026-10-07：Freeze §2.6 ④ 的 ⛔ 已逐条查到底，从 3 条减到 1 条** ——
   ✅ **音色条款**：**不存在**这样一份条款（生产音色是自合成产物，见 §3.1）·
   ✅ **CosyVoice 模型权重**：**Apache-2.0**（HF 模型卡逐字）·
   ⛔ **HF 上游权重仓库条款**（`yuekai/icefall-asr-multi-zh-hans-zipformer-large`）：**仍读不到** ——
   该仓库 **gated**（`gated: "auto"`）、raw README `HTTP 401`，要登录并接受条件。
   ⚠️ 附带查实：`sherpa-onnx-sense-voice-…-int8`（**生产 final ASR**）的权重**不是** MIT ——
   工具箱代码 MIT，**权重按 FunASR 模型开源许可协议 v1.1**，且该协议 §2.2 有**署名义务**。
2. **许可仍 UNKNOWN 的权重**（本轮缩小但**未清零**）：`zipformer-zh-int8-2025-06-30`
   （**生产 partial ASR 用的就是它**，门在 HF 的 gated 上）· `vits-zh-hf-fanchen-unity`（`L-PL2-05`）·
   `Qwen3-ASR-0.6B`（1.7B 已读 = Apache-2.0，**0.6B 不按同族推断**）。
   ⏩ 本轮**已登记**：VoxCPM2 / Qwen3-ASR-1.7B = Apache-2.0（候选线，本机未采用）。
3. **`Open-LLM-VTuber-Web-source` 用的是自定义许可**（"Open-LLM-VTuber License 1.0"）—— 与 MIT 的上游主体**不同**。
4. **OCR 后端包版本原本无存证**（`install-report.json` 的 `install` 为空），本文件第 4 行是**实测补记**；
   若要持久，应把 `rapidocr/onnxruntime/opencv/numpy` 四个版本写进该 `install-report.json`。
5. **`artifacts/post-lv2/local/` 无清单**：运行时与证据基线混放、**没有一份"哪些可删、哪些是唯一副本"的说明**。
6. **审计 §11 的两行已更正**：我原先写 CosyVoice / sherpa-onnx 的 commit "文档未记" —— **错**，
   Freeze §2.1 逐字记着（本文件已按它更正，原文按 `TD-16` 保留）。
7. ⏩ **`SenseVoiceSmall` 的署名义务已落地**（2026-10-07）：`README.md` 新增
   「**第三方组件与许可**」一节，逐件写明"用在哪 / 条款在哪读到 / 义务"，含 FunASR 模型协议的
   **署名来源与保留模型名**。⚠️ 它**不**等于"许可已清"，也**不**构成法律意见 —— 只登记条款位置与义务。

---

## 7. 本文件**不**主张什么

```text
· 不主张任何外部件"端到端可用"（各自由它自己的门回答）
· 不主张许可已获法律意见（只登记条款在哪读到）
· 不主张本清单"完整"：它覆盖 post-Lv2 语音/皮套/桌面/OCR/自动记忆这几条线；
  仓库其它部分（如 M 系列的第三方依赖）在 package.json / pnpm-lock 里，不在本文件范围
· 不主张"换机后能一键复原"：第 5 节是程序，不是脚本 —— **目前没有安装脚本**
```
