# 后 Lv2 依赖与许可冻结（WP0）

状态：**FROZEN**（WP0 产物）。日期：2026-10-03。载体 ADR：[ADR-091](../adr/ADR-091-post-lv2-world-boundary-and-story-source.md)。
本文件回答三件事：**装什么版本**、**许可是什么、在哪读到**、**哪些还没跑起来**。

> ⚠️ 读法：下表"已探针"= 本机真的执行过并留了读数；"仅源码/文档核对"= 只读了上游仓库与文档，
> **不是**运行验证，**不得**当作本机可用性证据。计划 §12 同此口径。

---

## 1. 运行时基线（本机实测）

### 1.1 **网络与代理**（2026-10-03 实测；这决定了"外部工作要多久"）

```text
无代理直连 GitHub / PyPI        : 可用，但**很慢**（70.6 MB 的 ASR 模型花了 **25 分钟**）
本机代理（mesl_lite）           : 混合端口 **7688**（`settings.json` 的 `mixedPort`）
                                  `http://127.0.0.1:7688` 对 GitHub / PyPI 均可用（实测 200）
```

⚠️ 两条**接线纪律**（都是实测踩出来的）：

```text
① 项目 `.npmrc` 里写死的 `proxy=http://127.0.0.1:7897` **是错的**（那个端口没人监听）
   ⇒ `pnpm add` 会失败。绕法：临时移开 `.npmrc`、装完原样移回（**不要**提交 `.npmrc` 改动）。
② 要用代理时**显式置环境变量**，不要依赖 `.npmrc`：
     $env:HTTP_PROXY='http://127.0.0.1:7688'; $env:HTTPS_PROXY='http://127.0.0.1:7688'
   `git clone` 也认这两个变量 ⇒ 上游抓取同样受益。
```

⚠️ **代理不是"加速技巧"，它是可行性问题**：无代理 25 分钟/70 MB 意味着
CosyVoice 的权重（数百 MB 量级）在无代理下基本不可行。用户 2026-10-03 裁定
"尝试用 mesl 的代理下载"，本文件据此登记端口与用法。

| 项目 | 读数 | 来源 |
|---|---|---|
| OS | Windows（`process.platform = win32`，x64） | `pnpm postlv2:baseline` |
| Node | v22.23.2 | 同上 |
| pnpm | 12.4.1 | 同上 |
| Python | 3.10.11（`pip 23.0.1`）；另有 3.14.0 可执行 | 本机探针 |
| uv | 0.12.4 | 本机探针 |
| ffmpeg | 9.0-full_build（gyan.dev） | 本机探针 |
| GPU | NVIDIA GeForce RTX 5080 Laptop GPU | `nvidia-smi` |
| npm registry | 项目 `.npmrc` 指向 `https://registry.npmjs.org/`，但含 `proxy=http://127.0.0.1:7897` | 读 `.npmrc` |

⚠️ **已知环境坑（WP0 实测）**：项目 `.npmrc` 里的 `proxy` / `https-proxy` 指向一个**未运行**的本机代理，
`npm`/`pnpm` 会 `ECONNREFUSED`（端口 7897）并挂起。直连 `registry.npmjs.org`、`github.com`、`pypi.org`
在本机**可达**（实测 HTTP 200）。**实测结论（重要）**：在命令级清空 `npm_config_proxy` **不够** —— pnpm 仍然从项目 `.npmrc` 读到死代理并失败；
`--config.proxy=` 与 `pnpm config get proxy` 也都不足以覆盖。**唯一实测有效的绕法**是
**临时把 `.npmrc` 移开、装完立刻原样移回**：

```powershell
Copy-Item .npmrc "$env:TEMP\npmrc-backup" -Force
Move-Item .npmrc .npmrc.disabled -Force
pnpm add <pkg> --registry=https://registry.npmjs.org/     # inkjs@2.4.0 实测 14.9s 成功
Move-Item .npmrc.disabled .npmrc -Force
```

⇒ 这是一条**操作纪律**，不是仓库缺陷。**不得**把 `.npmrc` 的修改或删除提交进仓库
（它已入库；改动会影响其它会话与 CI）。已入库的 `pnpm-lock.yaml` 里 `inkjs@2.4.0` 条目即本次安装的产物。

---

## 2. 依赖冻结表

> **2026-10-03 R9 实测更新**：下表的三行从"仅源码/文档核对"升级为**开工日已锁定 + 本机已探针**。
> 探针目录在仓库**之外**（`C:\Users\user\postlv2-deps`），**不进 git、不进工作树**。

### 2.1 已锁定的 commit（实测）

| 依赖 | 锁定值 | 许可（读到的地方） | 本机探针读数 |
|---|---|---|---|
| **inkjs** | `2.4.0`（npm，**已进 `package.json` 与 `pnpm-lock.yaml`**） | `LICENSE.md`（MIT）+ `package.json` 的 `"license": "MIT"` | ✅ **编译器 + 运行器都跑通**（WP0 起）：`Compiler(...).Compile()` → `new Story(json)` → `Continue()` 与 `variablesState` 可读；`pnpm postlv2:baseline` 的 `B5` 每次都复验它 |
| **sherpa-onnx** | commit `040afe360a38e25daaa325ce8889abf93ea02609`（`--depth 1`，2026-10-03 抓取） | 仓库根 `LICENSE` = **Apache License 2.0**（逐字读到 `Apache License / Version 2.0, January 2004`） | ✅ **pip 包已装并 import 成功**：`sherpa-onnx==1.13.8`（+ `sherpa-onnx-core==1.13.8`），`from sherpa_onnx import OnlineRecognizer` **可用**；`python-api-examples/streaming_server.py` 与 `sherpa-onnx/python/sherpa_onnx/online_recognizer.py` **都在**（与计划 §3/§8.1 的引用一致）；⚠️ **模型权重尚未下载** ⇒ 还没有真实识别读数 |
| **Open-LLM-VTuber** | commit `992309c0aa19845960228f880013d4685fde93b5`（`--depth 1`，2026-10-03 抓取） | `LICENSE` + **`LICENSE-Live2D.md`** 两份都在（示例模型另行授权 —— 与计划 §3 的判断一致） | ✅ **clone 成功**；⚠️ **Python 依赖未装、未启动**。计划逐条引用的路径**全部存在**（实测）：`agent/agents/agent_interface.py` · `agent/agent_factory.py` · `agent/output_types.py` · `asr/asr_interface.py` · `conversations/single_conversation.py` · `conversations/conversation_handler.py` |
| 依赖 | 锁定值 | 许可（读到的地方） | 本机探针读数 |
|---|---|---|---|
| **CosyVoice** | commit `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`（`--depth 1`，**经本机代理 7688** 抓取） | 仓库根 `LICENSE` = **Apache License 2.0**（逐字读到 `Apache License / Version 2.0, January 2004`） | ✅ **clone 成功**（3.0 MB 源码）；⛔ **模型权重未下、依赖未装、未运行**。⚠️ **音色条款仍未读** |

### 2.2 模型权重（**首次登记：本工程第一个真的下下来的模型**）

| 项 | 读数 |
|---|---|
| 模型 | `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`（中文流式 zipformer，14M 参数） |
| 来源 URL | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2` |
| 大小 | **70.6 MB**（tar.bz2） |
| **内容摘要** | `sha256 = 2CBD71B640D9C37D3784F29367333A4577B0398B62E9DEEED418170B081CBA8B`（已冻结进门 `A2`，逐字节比对） |
| **许可条款** | 模型包内 `README.md` 的 front-matter 逐字写着 `license: apache-2.0`；同文件写明它**转换自** `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`（`export-onnx-zh-14M.sh`） |
| 落盘位置 | `C:\Users\user\postlv2-deps\models\...`（**仓库之外**；不进 git、不进工作树） |
| 本机探针 | ✅ **真流式读数**（见 §2.5） |

⚠️ **"许可已核"到什么程度，说清楚**：模型包**自己**的元数据声明 Apache-2.0，且指明了转换来源；
本工程**没有**再去 HuggingFace 核对上游权重仓库的条款，也**没有**取得法律意见。
按计划 §3 的口径，这属于"**条款在哪读到**"而不是"许可已获确认"。

### 2.3 计划对上游的**接口主张**已逐条核对（实测，不是读文档）

| 计划的主张 | 实测 |
|---|---|
| `AgentInterface` 提供 `chat()` / `handle_interrupt(heard_response)` / `set_memory_from_history()`（计划 §6） | ✅ 三个签名**逐字一致**（`async def chat(self, input_data) -> AsyncIterator[BaseOutput]` 等） |
| `SentenceOutput` / `AudioOutput` 可以**附带 expressions**（计划 §6） | ✅ `class Actions` 有 `expressions: Optional[List[str] \| List[int]]`，且 `AudioOutput` 的注释写明 "Associated actions (expressions, pictures, sounds)" |
| `ASRInterface` 返回 `str`（计划 §7） | ✅ `async def async_transcribe_np(self, audio: np.ndarray) -> str` **逐字一致** |
| `conversation_handler` 有 `task.cancel()` 与 `heard_response`（计划 §8.3） | ✅ 文件存在；⚠️ **"取消真的传播到远端 LG 与用户声卡队列"这件事仍未验证**（计划原文也没主张它） |

⚠️ 上表核对的是**接口形状**，**不是**"本机跑得起来"：VTuber 与 CosyVoice 都还没有端到端运行读数。

### 2.4 仍然没有本机证据的项

| 依赖 | 用途 | 冻结版本 / 参照 | 许可 | 状态 |
|---|---|---|---|---|
| CosyVoice | S3 TTS 首选候选 | 未锁 | 未读 | ⛔ 未探针；若首日 CUDA/依赖阻塞超过约 3 h，按计划 §10.1 走已可用的替代并**重新测量** |
| Live2D Cubism 模型资源 | 皮套 | 未选 | `LICENSE-Live2D.md` 已读到 | ⛔ 未选定最终形象（计划 §6 明确不排期自制立绘/rig/3D） |
| 真实麦克风 / 扬声器 | `M12` 真人演示 | — | — | **麦克风采集已接入独立测试入口**（[操作说明](Post-Lv2-Microphone-Test.md)）；`sounddevice==0.5.6`，默认麦克风 44.1 kHz 采集 13,230 帧并关闭成功。2025 中文 Zipformer 已按用户授权成为默认，首次真人复测 `PASS`（用户核对为“识别正确”）；其权重许可仍 `UNKNOWN`；扬声器与 M12 演示仍 `NOT RUN` |

### 2.5 流式 ASR 的**本机真实读数**（`pnpm postlv2:asr:verify`）

它回答的是计划 §8.1 逐字提出的那个问题："同一麦克风音频流**持续**供给在线识别，
输出带版本的 partial / final；**不能**把完整录音切几片事后处理就称为流式理解"。

| 判据 | 读数 |
|---|---|
| `A1` 外部前置就位 | ✅ 仓库之外的 venv + 探针 + 模型包 |
| `A2` 模型包指纹 | ✅ `2CBD71B6…` 与冻结值**逐字节**一致（70.6 MB） |
| `A3` 探针真的产出结构化读数 | ✅ 17 个字段（跑得起来 + 能被解析） |
| `A4` **真流式** | ✅ 57 块 · **partial 变化 13 次** · 非空 partial 50 条 · final = "对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢" |
| `A5` `final` vs 最后一条 partial | 相同（**如实记录，不作判据** —— 两种情况都不是失败） |
| `A6` 实时性 | RTF **0.023**（构造 788 ms · 喂入 129 ms · 音频 5.612 s）—— **只记录不设阈值**，本机 CPU 的一次读数不是延迟承诺 |

⚠️ **这条读数不主张**：麦克风真的能用（喂的是测试 wav）· 延迟承诺（RTF 非 SLA）·
中文之外的语种 · 多人/噪声环境下的表现。**也还没有**把它接进 LG 的轮次链
（那是 WP5 本体，需要 `--bridge` 那一侧的真实外壳）。

**探针本体**：`C:\Users\user\postlv2-deps\streaming_asr_probe.py`（**仓库之外**；
它是外部进程读数，不是 LG 的部件 —— 因此不进 `src/`/`scripts/`，只由门 spawn 并解析）。

### 2.6 上游 commit/tag 锁定程序（已按此执行过多次，**继续沿用**）

```text
① clone 到仓库之外的独立目录（不进本仓库工作树；不进 git）  ✅ 已做（C:\Users\user\postlv2-deps）
② 记录：仓库 URL · 目标 commit SHA（不是分支名）· 抓取时刻  ✅ 已做（§2.1）
③ 记录：模型/权重文件的**内容摘要**（sha256）· 模型来源 URL  ✅ 已做（§2.2 流式 ASR / §2.7 TTS）
④ 许可证**逐个文件**登记：根 LICENSE + 任何附加 LICENSE-*.md + **模型自带条款** + 音色条款
   ✅ 已读：sherpa-onnx / icefall / VTuber（含 LICENSE-Live2D.md）/ CosyVoice 根 LICENSE /
           ASR 模型包 README / **TTS 模型包 MODEL_CARD** / AISHELL-3 数据集页面
   ⛔ **未读**：任何**音色**条款 · CosyVoice 模型权重条款
⑤ 把 §2 表里对应行的「开工日锁 commit」替换为实际 SHA，并在 §2.1/§2.2/§2.7 追加实测读数  ✅ 已做
⑥ **未完成 ①–④ 的依赖不得进入 WP 验收证据**
```

⚠️ 这条程序在本轮**真的拦住了一个候选**：`vits-piper-zh_CN-xiao_ya` 的模型卡写明训练集
**非商用** ⇒ 否决；`vits-zh-hf-fanchen-unity` 无许可 ⇒ 否决。**先读条款再选模型**不是形式主义。

### 2.7 TTS 模型（当前：Qwen3-TTS 1.7B CustomVoice / Ono_Anna）

> **⚠️ 2026-10-03 用户裁定**（原话）："**改用 fanchen-unity，不用管许可**"。
> 本文件照此执行，并**如实留下**许可状态 —— 记录事实与记录决定是两件事，两件都要做。

> **2026-10-03 后续试听反馈**：用户试听 fanchen-unity 的几段音频后表示“不是很满意”。正式音色改为**待选**；fanchen 不再作为已获用户认可的交付音色或默认回退推荐，已有合成 PASS 与试听文件作为工程证据保留。此前采用决定与许可事实不回写。下一轮比较 **CosyVoice 3 0.5B** 与 **Qwen3-TTS 1.7B CustomVoice 的 Serena/Vivian**，使用同一组台词试听；两者尚无本机样本和延迟证据，不能宣布完成替换。

试听台词建议固定为普通招呼、极创二面协作、误解后的更正三类，例如“我们先把项目讲清楚，再一起练一遍二面的分工”和“刚才是我理解错了，你说的是先准备演示，对吧？”。先按自然、年轻的中文女声准备，不强加夸张表演；实际音色与表达偏好以用户反馈为准。Qwen3-TTS 的 Serena/Vivian 声线描述见[官方仓库](https://github.com/QwenLM/Qwen3-TTS)，这只是候选依据，不是本机听感判定。

> **2026-10-03 最新裁定与本机试听**：用户决定采用 **Qwen3-TTS 1.7B CustomVoice**，具体声线等待试听后选择。主权重由用户手动下载提供；主权重与音频解码器的 SHA-256 均与官方仓库一致。在独立 Python 3.12.13 环境、RTX 5080 Laptop GPU、PyTorch 2.11.0+cu128、BF16/SDPA 下，已离线合成 **Vivian / Serena / Ono_Anna / Sohee** 四种女声，全部使用同一句中文、空情绪指令、相同随机种子，输出 **24 kHz / PCM16 WAV**。模型与环境位于 `C:\Users\user\postlv2-deps`；声音保存在已忽略的 `artifacts/post-lv2/local/`，公共证据只保存引用与测量。正式运行时接线、流式输出、取消与播放延迟尚未验证。详情与重跑命令见[本机试听记录](Post-Lv2-Qwen3-TTS-Audition-2026-10-03.md)。下表及 §2.8 的 fanchen 结论仍是此前工程探针的历史读数。

> **2026-10-03 试听后声线定案**：用户选择 **Ono_Anna**（原话“Ono_Anna，决定就它了”）。当前正式选型为 **Qwen3-TTS 1.7B CustomVoice / Ono_Anna**，默认 `language=Chinese`、空情绪指令，与本次认可的试听设置一致。声线选择记录见[选择证据](../../artifacts/post-lv2/postlv2-qwen3-voice-selection-20261003/selection.json)；已有合成读数保留，后续 WP4 接线使用此组合，正式运行接线状态仍为未完成。

| 模型 | 裁定 | 许可状态（**逐字读到的**） | 实测音质 |
|---|---|---|---|
| **`vits-zh-hf-fanchen-unity`** | ✅ **采用**（用户裁定） | ⚠️ **许可不明**：HF 上游 `csukuangfj/vits-zh-hf-fanchen-unity` 的 `tags = ['onnx','region:us']`、`cardData = {}` ⇒ **无 license 标签**；模型包内**没有** `LICENSE` / `MODEL_CARD`；作者仓库 `Fanchen/vits-zh-fanchen-unity` 返回 **HTTP 401**（不可读）。⇒ 残余 **`L-PL2-05`**（**已知风险，未解决**） | **16 kHz · 单说话人** · 峰值 ~0.79 · 合成 792 ms · RTF 0.33 |
| `vits-icefall-zh-aishell3` | 🟡 **保留为回退路径** | ✅ 三段可核：icefall Apache-2.0 · sherpa-onnx Apache-2.0 · **AISHELL-3 Apache-2.0** | 8 kHz · 174 说话人 · 峰值 ~0.23 · 合成 154 ms · RTF 0.037 |
| `vits-piper-zh_CN-xiao_ya-medium-int8` | ❌ **否决** | 包内 `MODEL_CARD` 逐字写明训练集 `BZNSYP / Data-Baker` 是 **Non-commercial use** | — |

⚠️ **回退不必重新选型**：门 `T8` 断言"许可上干净的替代**仍在案**"。
用户若要回退，改 `scripts/postlv2-tts-verify.ts` 的 `ADOPTED` 一处即可。

**为什么不直接用 CosyVoice**：已 clone 并锁 commit，但**权重是数 GB 量级**；
计划 §10.1 允许"依赖/CUDA 阻塞超过约 3 h 即走已可用且许可明确的替代"。

### 2.7.1 音色试听（**用户问"我能去哪听"**）

**答案：不用去别处 —— 已经用她真的会说的话合成好了，直接听仓库里的这几份。**

```text
artifacts/post-lv2/postlv2-tts-*/voice-samples/01-greeting.wav   「你好，我是苏沐薇。今天想聊点什么？」       2.4 s
artifacts/post-lv2/postlv2-tts-*/voice-samples/02-interview.wav  「我看了你的简历，二面我们聊项目吧。」       2.5 s
artifacts/post-lv2/postlv2-tts-*/voice-samples/03-emotion.wav    「这个想法挺有意思的，我还真没想到过。」     2.8 s
artifacts/post-lv2/postlv2-tts-*/voice-samples/04-long.wav       （长句 + 标点停顿）                        5.8 s
```

⚠️ **上游没有 demo 页面可听**：HF 上**没有** fanchen 的 space（实测搜索无结果），
作者仓库也**不可读**（401）。因此"去哪里听"的唯一诚实答案是**自己合成**
—— 这也正好是"选音色"该看的东西：**她真的会说的话**，而不是"你好世界"。

⚠️ **一个已知的发音缺陷**（实测）：`04-long.wav` 合成时 sherpa-onnx 打出
`Ignore OOV '；'`（**全角分号不在词表里**）⇒ 该标点被**忽略**。
⇒ 分句逻辑（WP4 本体）应当**先归一化标点**，或避开未登记的全角标点。残余 **`L-PL2-08`**。


### 2.8 TTS 的本机真实读数（`pnpm postlv2:tts:verify`，采用模型 = `fanchen-unity`）

| 判据 | 读数 |
|---|---|
| `T2` 是**用户裁定的那个**模型 | ✅ 指纹 `B4B3965681A215DC…` 逐字节一致，且探针读到的 `modelDir` 也确认是它（**不是"文件名对了"**） |
| `T4` **音频本身**（不是"命令没报错"） | ✅ 时长 **2.403 s** · 峰值 **0.7856** · wav **76 948 B** · **16 kHz** · 1 说话人 |
| `T5` 质量代价（只记录，不设阈值） | 合成 **792 ms** · RTF **0.33** · 构造 797 ms |
| `T6` wav 真的落盘 | ✅ 磁盘字节数与探测值一致 |
| `T7` **许可状态如实登记** | ⚠️ `UNKNOWN_UPSTREAM_NO_LICENSE_METADATA` · 上游无 license 标签 · 包内无 LICENSE/**用户决定已记录**（`L-PL2-05`） |
| `T8` 干净替代仍在案 | ✅ `vits-icefall-zh-aishell3`（回退不必重新选型） |
| `V1` 量具三段式 | ✅ 正控（真音频不静）· 负控（全 0 样本必响）· 恢复 |

**可听的证据**：`artifacts/post-lv2/postlv2-tts-*/synthesized-sample.wav` + `voice-samples/`（四份）。

⚠️ **不主张**：许可没问题（**已知不明**，`L-PL2-05`）· 这个音色适合苏沐薇（**用户**的选择）·
延迟达标（一次本机读数不是 SLA）· 已接进轮次链（WP4 本体未做）。

```text
① clone 到仓库之外的独立目录（不进本仓库工作树；不进 git）  ✅ 已做（C:\Users\user\postlv2-deps）
② 记录：仓库 URL · 目标 commit SHA（不是分支名）· 抓取时刻  ✅ 已做（§2.1）
③ 记录：模型/权重文件的**内容摘要**（sha256）· 模型来源 URL  ✅ 已做（§2.2 是第一个）
④ 许可证**逐个文件**登记：根 LICENSE + 任何附加 LICENSE-*.md + **模型自带条款** + 音色条款
   ✅ 已读：sherpa-onnx 根 LICENSE · VTuber 的 LICENSE + LICENSE-Live2D.md · 模型包 README 的 `license: apache-2.0`
   ⛔ **未读**：CosyVoice 的任何条款 · 任何音色条款 · HuggingFace 上游权重仓库的条款
⑤ 把 §2 表里对应行的「开工日锁 commit」替换为实际 SHA，并在 §2.1/§2.2 追加实测读数  ✅ 已做
⑥ **未完成 ①–④ 的依赖不得进入 WP 验收证据**
```

---

## 3. 尚未探针的阻塞项（如实登记）

| 项 | 当前事实 | 影响 | 计划内的处置 |
|---|---|---|---|
| Open-LLM-VTuber 未运行 | 未 clone、未装 Python 依赖、未跑通默认壳 | `M1`–`M4`、`M5` 无读数 | 按 §10.1：模型/CUDA 或依赖阻塞超过约 3 h 即走已可用且许可明确的替代；没有替代就报实际阻塞 |
| sherpa-onnx 未运行 | 未装、未下模型 | `M9` 的流式 ASR 部分无读数 | 计划 §10.1：10/04 晚没有 partial ASR 即判 Lv4.5 排期风险，**不**把整段 ASR 说成"边听边想" |
| CosyVoice 未运行 | 未 clone、未验证 CUDA 兼容 | S3 TTS 无可听读数 | 首日探针口径见计划 §7；不满足则走替代服务并**重新测量** |
| 真实麦克风/扬声器演示 | 未做 | `M12` 无读数 | 属真人体验门，`NOT RUN` 如实保留 |

---

## 4. 本文件**不**主张什么

- **不主张任何上游项目端到端可用**。逐项说清现在的真实边界：
  - `inkjs`：✅ 编译器 + 运行器本机跑通（`postlv2:baseline` 的 `B5` 每次复验）；
  - `sherpa-onnx`：✅ pip 包可导入，且**流式识别已有真实读数**（§2.5）——
    但喂的是模型自带测试 wav，**不是麦克风**，也**还没接进 LG 的轮次链**；
  - `Open-LLM-VTuber`：只 clone 了，**依赖未装、未启动**；
  - `CosyVoice`：**未 clone**（TTS 仍无本机可用性证据）。
- 不替用户选择最终形象或音色。
- 不主张许可证已获法律意见；只登记"条款在哪读到"。
  ⚠️ **仍未读**的条款：CosyVoice 的任何条款 · 任何**音色**条款 ·
  HuggingFace 上游权重仓库的条款（模型包只声明它转换自那里）。
- 不主张 `10/06 23:59` 的截止已被确认：**下载就花了 25 分钟**（70 MB，见 §2.2），
  VTuber 依赖安装与 CUDA 兼容都还没试过 —— 剩余工时仍然未知。
- 不主张 §2.5 的 RTF 是延迟承诺（那是本机 CPU 的一次读数）。
