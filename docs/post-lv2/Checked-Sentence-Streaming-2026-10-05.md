# 正文按句流式交给语音：实现与验证

日期：2026-10-05。用户选择「直接 3」。设计裁定见 [ADR-102](../adr/ADR-102-checked-sentence-speech-streaming.md)。

## 已实现的行为

语音外壳现在请求同一个 LG 模型的 SSE 正文。表达封套中的完整句子经过既有回复守卫后，立即交给原有 CosyVoice TTS；后续正文继续生成。正文 delta 不包含 reasoning、协议字段或 XML thought。模型、推理设置、上下文与状态评估没有因本次优化而调整。

句子的 replyId 使用本轮已分配的助手事件序号，分句沿用 `<replyId>#<index>`。交付账在首句发送前建立，因此合成回报无需等待整篇结束。正常终态保存已检查正文和程序附录；来源附录只追加一次，不进入语音。缺少标准表达封套的合法回复保留整篇兜底。

生成中取消会中止模型流。网络或格式失败发生在首句之后时，只保存已经检查并发出的前缀，并返回失败终态；TTS 和前端停掉该代余句。首个正文 delta 后禁止重试，重复终态也不重播分句。

## 验证读数

| 检查 | 当前读数 | 证明范围 |
| --- | --- | --- |
| `pnpm typecheck` | EXIT 0 | 最终源码类型检查 |
| `pnpm postlv2:text-stream:verify` | PASS / EXIT 0 | UTF-8 SSE、早期句子、后句守卫改写、残缺尾句、来源附录一次且不播、实际 provider 不重复重试、早期合成身份、取消、缓存不重播 |
| `cosyvoice3-venv/Scripts/python.exe -X utf8 scripts/postlv2-text-stream-verify.py` | PASS / EXIT 0 | 实际 Python 消费器在终态前产出、正文不重播、最终不一致失败关闭、消费器关闭时取消 |
| 六道相关门：bridge / transport / expression / delivery / speech / avatar | 全部 EXIT 0 | 桥接、表达、交付与外壳既有回归 |
| 真测试模型生成中取消 | PASS / EXIT 0 | 第一分句后取消，`outcome=failed`、`streamStatus=cancelled`，仅一段前缀 |
| 关闭的取消试验库再次复制后 SELECT 读回 | PASS / EXIT 0 | 助手事件恰好一条，内容哈希等于发出的前缀，实际 ID 相同，trace 为 `failed / speech_stream_cancelled` |
| 外壳安装与前端构建 | SUCCESS | 失败消息由上游对话层转发；前端按 generation 停止播放 |
| 浏览器实际播放与手动点击打断 | 已观察 | 首段非零 RMS、25 段结束，第 26 段 interrupted；打断后无 active，随后观察未重新起播 |

真实模型试验使用 `.env.test` 和 `sandbox-copy`。读回器再复制已经关闭的测试库；没有打开真实 `data/pglite`。浏览器试验用独立的 12395 端口，临时运行文件仅修改端口，避免占用其他会话的 12393 服务；不是生产启动验收。真人听感、麦克风连续对话与 p95 延迟没有在本轮验收。

## 时延实测：接线收益与首音分列

| 单次样本 | 首句 / 开始 TTS | LG 最终结果 | 首个音频 / 实际播放 | 结论 |
| --- | --- | --- | --- | --- |
| 短回复，真模型 + 真 CosyVoice，进程内传输接收器 | 首句 9.835 s | 10.618 s | 首音频包 12.075 s | 提前交付首句 0.783 s；首音频仍晚于整篇结束 |
| 浏览器虚构故事，真模型 + 真 CosyVoice，33 分句 | 开始 TTS 约 14.411 s | 16.638 s | 实际播放 18.947 s | 合成约提前 2.227 s 开始；首音仍晚于整篇结束 |

第一行来自同一个 Python monotonic 计时器。第二行 TTS 起点来自后端同进程日志（对话开始 12:58:32.956，首句合成 12:58:47.367），LG 总耗时来自终态状态；浏览器首播时间取同一浏览器时钟的 `playing(50352)-turn_start(31405)`，不同端的起点并非精确同步。

这些读数证明文本生成与 TTS 已经可以重叠，不能作为优化前后配对实验或 p95 收益。首句之前的上下文、模型首 token 和首句生成仍需等待；长段落被一个完整 JSON 对象包住时，也要等该对象闭合才能发句。本轮没有承诺首音小于 5 秒。

短回复探针最初要求「首音频早于最终结果」，该断言实际 FAIL / EXIT 1，原档保留。两次要求精确 24 句的长回复试验没有得到有效完成样本；首次对外诊断为 `bridge_turn_failed`，补充枚举诊断后的重试为 `model_stream_finish_length`，未调整模型 token 预算凑通过。后续自然故事样本独立记录，不能覆盖这两份失败。

## 完整回归的失败与对照

`pnpm with-test-model pnpm m4.5:ci:full` 的离线 `m4.5:ci` 子段 EXIT 0；当前配置的新 Live Smoke 为 **48/52，完整命令 EXIT 1**。四项失败是 S2.1 / S5.1 / S5.3 / S7.3：已激活的本地文件读写能力与旧 smoke 的动作沙盒文件位置、禁止读取范围及幂等文件位置预期不同。没有改写原失败档，也没有修改这些测试或生产配置。

仅在对照测试进程设置 `CHARACTER_LOCAL_FILE_READ_ENABLED=false` 和 `CHARACTER_LOCAL_FILE_WRITE_ENABLED=false`，再运行 `pnpm with-test-model pnpm m4.5:smoke:live`，得到 **52/52 / EXIT 0**。这是旧文件能力配置的回归对照，不能写成当前生产配置的全绿，也不能用它覆盖前述完整命令失败。

## 已知边界

按句检查与旧整篇检查的改写范围不同：后句触发替换时保留已发出的前句，跨句拆开的口吻标记可能有不同匹配结果。守卫仍为原有确定性策略，没有新增跨句语义或事实正确性保证。

句子在整篇持久化前发送，进程硬崩溃或最终落盘失败仍可能出现「已交付、助手记录尚未持久化」的窗口。正常完成和本轮受控取消的记录一致性已验证，崩溃原子性尚未实现。完整当前配置回归的四个文件能力失败仍需相应维护线处理。

## 证据与复验入口

本轮证据目录：`artifacts/post-lv2/text-stream-20261005/`，含 `live.json`、`browser-last-turn.json`、`browser-playback.json`、`browser-proof.png`、`cancel-live.json`、`cancel-readback.json`、`full-live-failure.json`、`legacy-live-pass.json`。公开时延与记录核对文件使用正文哈希；本地调试日志保留在忽略的 artifacts 日志路径。

生成中取消复验：`cosyvoice3-venv/Scripts/python.exe -X utf8 scripts/postlv2-text-stream-verify.py --cancel-live`。读回复验：`pnpm exec tsx scripts/postlv2-text-stream-readback.ts <已关闭的-avatar-测试副本目录>`。真实语音复验：同一 Python 脚本 `--live --case short/long --output <新证据路径>`，应保留新读数，不覆盖本轮失败档。

标准语音外壳代码和安装脚本已接入新流程，新启动时生效。当前隔离试用页为 `http://127.0.0.1:12395/`；该页使用数据库副本，不会把对话写入真实库。

## ⏩ 2026-10-07 修订：Live Smoke 的**三档**口径（只追加，上文读数不回写）

本页与同批文档里出现过的 52/52 与 48/52 是**三种不同配置**，不得混用、不得相加、不得互相覆盖：

| 档 | 读数 | 配置 | 载体 |
| --- | --- | --- | --- |
| 冻结沙箱档 | **52/52 PASS** | 测试子进程固定 `m4.5-frozen-sandbox`（旧沙箱预期） | [Browser-Role-Task-Check-2026-10-06.md](Browser-Role-Task-Check-2026-10-06.md) §验证读数 |
| **当前生产配置** | **48/52 · 完整命令 EXIT 1** | `.env` 里 `CHARACTER_LOCAL_FILE_READ_ENABLED` / `_WRITE_ENABLED` 已打开 | 本页 §完整回归的失败与对照 |
| 关两个开关的对照 | **52/52 EXIT 0** | 仅在对照进程里关掉那两个文件开关 | 本页同上 |

⇒ 三条纪律（与 `TD-16` 同源）：① **不许**把 52/52 说成"当前配置全绿"；
② **不许**把 48/52 用"负载 / 冷启动 / 样本量"解释掉（四项失败是**旧期望值 vs 已激活能力**，已具名 S2.1 / S5.1 / S5.3 / S7.3）；
③ [Latency-Optimization-2026-10-05.md](Latency-Optimization-2026-10-05.md):65 的 `G14` 是**承接**档读数，不是本轮重出完整 Live Smoke。

> ⏩ **2026-10-07 复跑（冻结档，且**自证配置**）**：`pnpm with-test-model pnpm m4.5:smoke:live`
> = **52 通过 / 0 失败（EXIT 0）**。证据 `artifacts/m4.5/smoke/smoke-result.json` 现在带
> **`profile.name = "m4.5-frozen-sandbox"`** 与 18 条固定环境变量
> （`LOCAL_FILE_READ/WRITE=false` · `TOOL_DECISION_MODE=rules` · `TASK_AUTONOMY_ENABLED=false` · 其余业务能力 false），
> 并且正控（S1/S2/S8）与负控（S3/S4/S5/S6/S9/S10）**逐条全绿**。
> ⇒ 这一档从此**不会再"看起来绿却不知是哪一档"**（2026-10-05 那份证据是 **8525 字节、无 `profile` 字段**）。
> ⚠️ 三个历史读数**都在案、都没被改写**：`artifacts/post-lv2/text-stream-20261005/full-live-failure.json`（**48/52 FAIL**）·
> 同目录 `legacy-live-pass.json`（关两开关的 **52/52** 对照）· 本页 §完整回归的失败与对照。
> ⚠️ 真实库未被打开：跑前后 `data/pglite` 文件数 **1269 → 1269**、mtime 摘要逐字相同。
