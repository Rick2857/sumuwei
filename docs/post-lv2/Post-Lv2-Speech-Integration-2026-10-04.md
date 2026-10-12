# SenseVoice 与 CosyVoice3 接线、实测与边界

日期：2026-10-04。用户已允许 CPU/GPU 模型实测，并在真实试听后选择 **CosyVoice3**，要求先处理俏皮语气改变句尾的问题。新录音及修复后主观试听仍由用户后续完成。

## 当前可运行结果

两个皮套启动脚本现在默认使用 **SenseVoiceSmall INT8 / CPU + CosyVoice3 FP16 / GPU**。CosyVoice 使用用户先前选择的 Ono_Anna 参考音进行复刻；这是用户选中的新试听声线，与原 Qwen CustomVoice 预设分列。原环境、Zipformer 和 Qwen3-TTS / Ono_Anna 保留，设 `POSTLV2_SPEECH_PROFILE=legacy` 可以回退。

- 测试入口：`scripts/postlv2-avatar.cmd`，`http://127.0.0.1:12393/`，只写正式库的隔离副本。
- 正式入口：`scripts/postlv2-avatar-production.cmd`，`http://127.0.0.1:12394/`。启动配置已更新；**本轮未启动正式库，未完成新语音档的正式数据库运行验收**。
- 独立麦克风 CLI `pnpm postlv2:mic` 仍使用原 Zipformer 流式识别。本次替换针对皮套网页完整录音入口，不能将它称为 SenseVoice partial 流式识别。
- 二遍识别仍为备用设计，**未接入**默认链路。本次一次识别后只将 final 交给 LG，不用聊天模型猜测或改写识别文字。

模型与依赖已下载、安装并在本机验证，用户无需再下载本轮选型所需组件。模型文件、声线及独立环境放在 `C:\Users\user\postlv2-deps`，不进 Git。五套候选共校验 43 个模型文件、17,211,096,453 字节，清单及摘要见 [下载及初测汇总](../../artifacts/post-lv2/asr-tts-selection-20261004/summary.json)。先前不完整的 GitHub SenseVoice 压缩包保留原状态；实际使用的是随后校验完成的独立模型文件，未把不完整压缩包宣布为成功。

## 为什么采用这个识别档

使用两份已保存的真人录音；两份说的是**同一句、规范化后 12 字**。五次热调用的中位数只计解码，不包含浏览器断句、网络及 LG。没有新增人名、数字、口音等独立测试语料。

| 模型 | 两份原录音错字数 | 热解码中位数，毫秒 | 原始静音结果 |
|---|---|---|---|
| 现有 Zipformer 2025 / CPU | 2 / 0 | 338.093 / 379.534 | 空 |
| SenseVoiceSmall INT8 / CPU | 0 / 0 | 105.781 / 111.500 | 误识别一个字 |
| Qwen3-ASR 0.6B / GPU | 0 / 0 | 288.075 / 290.918 | 误识别一个字 |
| Qwen3-ASR 1.7B / GPU | 0 / 0 | 267.863 / 270.428 | 误识别一个字 |

噪声与低音量对照的 7 份语音变体合计 84 个参考字：Zipformer 错 10，SenseVoice 错 1，Qwen 0.6B 错 2，Qwen 1.7B 错 0。**这是同一句的变体，不是七句独立语料，不构成普遍准确率或稳定 p95 结论。** SenseVoice 在这些样本中兼顾解码等待和准确率，并把 GPU 留给合成，因此选作网页主档；没有据此宣称它普遍比 Qwen 1.7B 准确。

针对静音误识别，实际适配器先执行现有 Silero VAD v5 的 CPU 语音检查，阈值 0.5，静音和纯噪声不送入识别器。实际工厂创建的 `LGSenseVoiceASR` 已验证：两份原音与一份低音量音频识别一致；静音及纯噪声返回空，空结果不进入 agent 或聊天历史。该工厂测试含 VAD 的三份语音总耗时约 116–118 毫秒。详见 [ASR 实际接线证据](../../artifacts/post-lv2/asr-tts-selection-20261004/asr-wiring.json)。VAD 不是所有噪声或小声说话的保证，仍需真人验证采音和断句。

## 合成对照与句尾修复

初测为同文本、原生 PyTorch 接口，RTX 5080 Laptop、Torch 2.11.0+cu128、两条 CPU 线程；模型各自在独立覆盖环境运行。短句的自然语气热调用中位数如下，**这是最初试听探针，早于随后增加的逐字朗读约束**：

| 模型 | 首段音频，秒 | 整句 RTF | 原生分块情况 |
|---|---|---|---|
| 现有 Qwen3-TTS 1.7B / Ono_Anna | 5.295 | 1.789 | 整句 WAV，首段等于整句完成 |
| CosyVoice3，逐句重置流式 hop | 1.661 | 0.827 | 两块，24 kHz |
| VoxCPM2，10 timesteps，未 compile | 0.167 | 0.983 | 小块，48 kHz |

长文本三次热调用的 RTF 中位数为 Qwen 2.355、CosyVoice 0.921、VoxCPM2 1.209。Vox 虽然首块更早，该长文本生成比播放慢，不能直接即时开播并保证连续。Cosy 最慢一次的音频到达回放计算也需要额外 2.158 秒缓冲。这些是音频生成与到达重放指标，**不是实际浏览器开口时间，也不包含 LG 生成回复的等待**。

上游 CosyVoice 在流式合成中把实例的 `token_hop_len` 从 25 逐渐增长，下一句没有复位；初测热短句退化成整句一块。适配器在串行合成锁内逐句重置为 25，保留原始失败读数。对应 [固定版本模型代码](https://github.com/QwenAudio/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/cli/model.py)和 [初测汇总](../../artifacts/post-lv2/asr-tts-selection-20261004/summary.json)。

初测 88 次合成独立回读有 82 次逐字一致，6 次差异均来自 Cosy 的俏皮提示：把“来了／吧”读成“来啦／呗”；另一识别模型也确认句尾差异。旧失败档保留在 [原始回读](../../artifacts/post-lv2/asr-tts-selection-20261004/tts-readback.json)及 [交叉确认](../../artifacts/post-lv2/asr-tts-selection-20261004/tts-readback-confirmation.json)。

修复在六类表达提示后追加“逐字朗读给定文本，保持每个字和句尾语气词，不做改写”，并关闭上游文本重写。实际适配器覆盖六类表达 × 三个种子，另加两种俏皮句尾 × 三个种子，共 24 段；独立 Qwen3-ASR 1.7B、无上下文提示的规范化回读 **24/24 一致**。见 [修复后的回读](../../artifacts/post-lv2/asr-tts-selection-20261004/cosyvoice-literal-readback.json)。这没有证明音色、语气始终稳定，也没有证明未来所有音频绝不改字；修复后的真人试听仍为 NOT RUN。

真实网页使用修复后的适配器；一段较长的已检查回复原生输出 8 块、26.96 秒音频，首块 2.207 秒、生成总耗时 22.682 秒。该段在浏览器中主动打断，后端排空模型，**没有完整长段浏览器播完的验收主张**。见 [实际集成记录](../../artifacts/post-lv2/asr-tts-selection-20261004/integration.json)。首块生成耗时不能直接当成用户开口等待。

## 实际链路与播放

LG 继续决定回复和有限表达意图；识别模型返回的情绪标签不驱动皮套，也不接入人格或记忆判定。TTS 只接收 LG 已检查分句，并核对文字 SHA-256。每块音频都携带 `requestId/replyId/segmentId/generation` 和分句摘要，字幕、语气和动作属于同一分句。

浏览器将 24 kHz 单声道 PCM 排到同一个 Web Audio 时钟，累计 3 秒音频或收到句末标记才开播，排程前留 0.4 秒余量。很短的句子可能仍等整句完成；3 秒指音频储量，**不是固定三秒墙钟等待**。后续分句依次等待前一句完成。表情、动作和口型从实际播放开始，口型取实际 PCM 的 RMS；结束、打断和断连会清理排程与恢复模型回调。

打断后浏览器立即停止音频及动作、拒收旧 generation。Cosy 上游内部线程未提供本次验证过的安全即时终止接口，适配器排空正在生成的一句并丢弃迟到音频；**显卡计算不保证瞬间停止，下一句可能等待上一句排空**。

首次启动先加载参考声线并做一次不落 LG 轮次的模型预热；实际预热约 17.7 秒，加载还需要额外时间。应等 `LG_AVATAR_READY` 后开始聊天，不能把冷启动预热误认为第一轮聊天。Windows 覆盖环境还修复了 base 环境 `.pth` 不被处理导致的 `pywintypes` 缺失；原 Qwen 环境未被替换。

## 验证结果分列

| 检查 | 结果及范围 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| 音频前端队列离线检查 | 7/0，模拟 Web Audio 时钟 |
| 音频后端传输离线检查 | 6/0，真实任务管理器与假声学生成器；确认未生成完已发首包、顺序与取消 |
| 既有表达检查 | 前端 16/16，适配器 11/11 |
| 既有服装检查 | 9/9 |
| 正式入口边界与生命周期离线检查 | 15/15；没有打开正式库 |
| 皮套及新配置检查 | `postlv2:avatar:verify` checked=true，SenseVoice/CosyVoice、36 个表情、口型配置通过 |
| 实际网页回放 | 保存的真实 DOM 和 status 推导 10/0；四轮测试、8 段播完、1 段播放中打断，下一轮恢复 |
| 逐字约束独立回读 | 24/24；修复后主观试听 NOT RUN |
| 实际新录音 | NOT RUN；没有授予浏览器麦克风权限 |
| 正式新语音档的数据库运行 | NOT RUN；本轮只用 sandbox-copy |
| `pnpm m4.5:ci` | **EXIT 1**；M3.5 Future Compatibility 29/1，已有 S8 的 `FC-T04` 模块边界锁失败；下游门未完整执行 |

回放计数中的 underrun=0 是**已播放分句内部**的音频缓冲结果，不代表分句之间零停顿、任何长度都能连续播完或真人听感已通过。歪头和点头有实际 Cubism 参数偏移，所有完成分句有非零 PCM RMS；打断前明确处于播放状态，打断后旧句未重启。证据由 [集成汇总脚本](../../artifacts/post-lv2/asr-tts-selection-20261004/summarize-integration.py.txt)从保存的观察生成，截图与对话留在本地私有目录。

退出实测发现 Uvicorn 在 HTTP 关闭后重放 Ctrl+C，导致等待 LG 进程时被取消；已用受保护的关闭任务修复，并增加取消期间必须等待真实子进程退出的回归检查。一键启动复测实际出现 `LG_BRIDGE_CLOSED exit=0`。Windows PTY 外层仍返回 1，和 LG 子进程正常收尾分列；未据此外推外层退出码全部正常。

全仓库失败没有被本轮改写为 PASS，也没有改冻结的 S8/FC-T04 判据。本轮语音配置和专项验证通过不替代全仓库放行。正式库、新真人识别、修复后声线听感、长段完整播放及游戏共用下的性能仍需各自证据。

## 启动、回退与用户下一步

通常直接双击上述原有脚本，或运行 `pnpm postlv2:avatar` / `pnpm postlv2:avatar:production`。桌面《苏沐薇-使用说明》同步说明了新语音档及冷启动等待。

在 PowerShell 临时回退整个语音档：

```powershell
$env:POSTLV2_SPEECH_PROFILE = 'legacy'
pnpm postlv2:avatar
```

退出并等待 LG 关闭确认后，运行 `Remove-Item Env:POSTLV2_SPEECH_PROFILE`，下一次恢复 CosyVoice3/SenseVoice 默认。已分别通过原脚本的 legacy 测试入口与默认正式入口 `--help` 执行验证；`--help` 不加载声学模型或打开数据库。

用户后续先在 12393 测试入口，试听俏皮句尾、说几句不同内容及含名字、数字的句子，确认字幕、断句、音色和打断。当前测试服务已关闭，不会在用户继续游戏时自行再加载模型。

最初的 [研究与准备记录](Post-Lv2-ASR-TTS-Selection-2026-10-04.md)保留当时 NOT RUN；本文件与新的执行证据是随后完成的工作，不能回写原准备状态。运行脚本、候选探针与结果按提交和源摘要区分；共享工作区的 HEAD 可能含其它会话提交，详见各证据的 source 字段。
