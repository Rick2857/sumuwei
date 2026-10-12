# 中文流式麦克风测试

本入口单独验证麦克风采集与识别，不提交 LG 对话或长期记忆。使用已有中文流式 zipformer 模型和 `sherpa-onnx==1.13.8`；采集依赖为 `sounddevice==0.5.6`（安装在既有外部 venv）。实现参照 sherpa-onnx 的 `speech-recognition-from-microphone-with-endpoint-detection.py` 与 [sounddevice InputStream 文档](https://python-sounddevice.readthedocs.io/en/latest/api/streams.html)。

在仓库根目录运行：

```powershell
pnpm postlv2:mic
```

也可双击 `scripts/postlv2-microphone.cmd`。看到麦克风名称后，按回车开始，说一句中文，例如“你好，今天我们测试语音识别”。程序实时显示中间识别文字；停顿约 2 秒后结束，最长采集 15 秒。Ctrl+C 取消并关闭采集。

缺省使用 Windows 默认输入设备。需要换设备时：

```powershell
pnpm postlv2:mic --list-devices
pnpm postlv2:mic --device 2
```

编号以当前设备列表为准。设备检查（会采集 0.3 秒并立即关闭）：

```powershell
pnpm postlv2:mic --check
```

`DEVICE_READY` 只表示模型可构造、设备可采集且已关闭；不代表真人口述已识别正确。正常测试的 `TRANSCRIBED` 只表示输出了非空转录，准确性须与本人实际说的话核对。没有识别文本、采集溢出或取消会分别记录，不能算通过。

录音 `input.wav`、带版本的 `events.jsonl`、最终 `transcript.txt` 和 `summary.json` 均保存在 `artifacts/post-lv2/local/microphone-*/`。写入前检查该路径确实被 Git 忽略。文件验证模式 `--wav` 明确标记为 `test_file`，不能冒充麦克风证据。

当前边界：真人口述准确性与 LG 对话接线分别验收；本入口不代表 WP5、M5/M9/M12 或整套实时语音已经通过。

## 2026-10-03 本机检查

公共记录：[verification.json](../../artifacts/post-lv2/postlv2-microphone-20261003-01/verification.json)。五项检查通过：测试录音的流式转录与参考文本相符、静音返回 `NO_SPEECH`（退出码 2）、无效设备明确拒绝（退出码 1）、恢复后再次识别一致、真实默认输入采集与关闭通过。录音文件验证始终标记 `test_file`，中间结果和最终结果使用同一 utteranceId 与递增版本；完整正文只落 local。

默认设备为“麦克风阵列（英特尔智音）”，采样率 44,100 Hz，设备检查实际采集 13,230 帧，关闭后 `streamClosed=true`。实现初次检查的 `pnpm typecheck` 退出码 0。

**首次真人口述核对 = FAIL**：本人反馈“识别有误”，并提供了实际说的完整句子。录音 4.6 秒、4 次中间文字变化、输入溢出 0 次，非空转录不代表识别正确；见 [首次人审记录](../../artifacts/post-lv2/postlv2-microphone-20261003-01/human-review-first.json)。准确性仍未通过，不能用文件验证或设备可打开代替。

**新版真人复测 = PASS**：切换到 `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` 后，用户再次口述并核对为“识别正确”。本次 5.0 秒、7 次中间文字变化、输入溢出 0 次；见[新版人审记录](../../artifacts/post-lv2/postlv2-microphone-20261003-03/human-review-new-model.json)。用户随后授权将该版本替换为当前默认，并接入联合外壳；14M 保留为显式回退，LG 持续对话验收仍未完成。

## 新模型比较（已替换为当前默认）

当前缺省为 2025-06-30 中文流式 Zipformer；旧版 14M 仍可用 `--model 14m` 回退。联合外壳的 LG ASR 配置也指向同一新版模型：

```powershell
pnpm postlv2:mic              # 当前默认：2025-06-30
pnpm postlv2:mic --model 14m  # 旧版回退对照
```

新版的 encoder / joiner 为 int8，decoder 为 FP32；仍在 CPU 上运行。首次保存录音回放中，旧模型错误字符 8/12，新模型 2/12；随后新版真实麦克风复测由用户核对正确。该读数仍不足以代表普遍准确率；候选包未附模型许可声明，上游模型卡当前无法读到，许可状态为 `UNKNOWN`，因此保留回退并继续记录该风险。详见 [方案评估](Post-Lv2-ASR-Comparison.md)。

首次完整回归 `pnpm m4.5:ci` 退出码 1：共享工作树当时正在新增的 S8 迁移文件出现 TypeScript 解析错误；记录保留在 [首次 regression.json](../../artifacts/post-lv2/postlv2-microphone-20261003-01/regression.json)。在迁移语法恢复后再次运行，退出码仍为 1，但失败已进入 S8 的 `FC-T04` 模块边界断言（[第二次 regression.json](../../artifacts/post-lv2/postlv2-microphone-20261003-02/regression.json)），与麦克风入口无关。两个失败都如实保留，不按麦克风模块 PASS 掩盖。

提交范围偏差：实现提交 `27b63fc4` 点追加共享文件时，带入了其他会话已在工作树内的 Qwen 声线记录和 `postlv2:s8:baseline` 命令行；S8 随后已由 `6467b2a4` / `ed875163` 提交入口与证据。保留这些会话已有历史，不回退其文件。本次新版已接入隔离联合外壳；真实 LG 持续对话、取消、播放对账仍待联合测试。
