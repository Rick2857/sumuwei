# S8 消费锁量具修复（2026-10-07）

用户授权：「行如果能修就把它修好」。设计沿用已裁定的 [ADR-107 R-4c](../adr/ADR-107-s8-production-entry-remaining.md)：装配检查与行为证据分列，行为门必须有正控、入口缺席负控及恢复。本次只修测试与证据，不改变生产故事逻辑、开关、模型端点或数据库结构。

## 原缺陷与判据修订

| 项目 | 原判据 / 主张 | 新判据 / 主张 |
| --- | --- | --- |
| `kernel-tests-memory.ts` D01 | 全文同时含 `storyCognitionEnabled` / `consumeOnce`，测试名声称「真的消费」 | AST 只检查实际属性读取与调用语法；注释、字符串和仅一侧接线均拒收。明确只主张装配在场 |
| `postlv2:s8:entry-lock:verify` | 手动调用故事装配，检查选择行和水位；不驱动生产调用点 | 保留原门及其边界，不将它升级成生产可达性证据 |
| `postlv2:s8:daily:e2e` | 真实 `main.ts --bridge` 的正控与跨进程续接 | 正控 → 摘除实际入口 → 摘除实际消费 → 恢复真实入口；每档全新隔离库、两次启动、五轮真实协议对话，直接读回提交与三个水位 |

**OLD / NEW / WHY / PRESERVED**：原文本锁可被无调用的源码和纯注释骗过。新静态检查拒收此类假象，但仍不证明运行时可达；运行时主张移到已有真实主入口 e2e。原来的开关缺省、三条提交、选择身份、世界上下文、真实会话锚、三个独立水位与跨进程恢复断言全部保留，新增负控没有放宽任何原行为要求。

旧锁复现：[baseline.json](../../artifacts/post-lv2/s8-consumption-lock-repair-20261007/baseline.json)。从 HEAD 读取原断言，在内存摘除四处实际调用后仍通过；只保留两个名字的注释也通过。未修改生产源码。

## 验证范围

第一轮 [整链读数](../../artifacts/post-lv2/s8-daily-e2e-20261007134251474/result.json) 已实测：

| 档位 | 对话 | 账本 / 水位 | 整链门结果 |
| --- | --- | --- | --- |
| 正控 | 五轮均 `replied` | 3 条提交，三个水位均为 3 | PASS |
| 入口缺席 | 五轮均 `replied` | 0 条提交 | FAIL / `story_entry_commits_missing`，被外层负控接受 |
| 消费缺席 | 五轮均 `replied` | 3 条提交，无消费者水位 | FAIL / `story_consumer_watermarks_missing`，被外层负控接受 |
| 恢复 | 五轮均 `replied` | 3 条提交，三个水位均为 3 | PASS |

负控通过的条件是对应的账本或水位断言失败，并有精确读回。启动错误、协议错误、超时或数据库错误不会被接受为负控成功。临时源码只替换 AST 调用表达式，仍保留能骗过旧锁的名字与注释；每次恢复都运行原 `src/main.ts`。`finally` 删除临时源码，生产源码字节和真实库树摘要均不变。

门继续使用既有 `postlv2:s8:daily:e2e` 命令，已有 `postlv2-controls` lane 与 S8 affected 映射照旧。清单追加 `mutatesGitWorktree` 声明，确保临时源码副本期间独占运行。`--live` 仍只运行正常短链，负控仅在离线 HTTP 夹具档执行。

最终源码由调度器串行、无缓存复验 [整链读数](../../artifacts/post-lv2/s8-daily-e2e-20261007135123291/result.json)：**PASS / EXIT 0，四档各五轮，`measuredCount=20`**，两份预期 FAIL 保留。调度器 [run.json](../../artifacts/post-lv2/s8-consumption-lock-repair-20261007/scheduled-e2e-run.json) 为 1 PASS / 0 FAIL / 0 SKIPPED / 0 TIMEOUT，耗时 28.7s；临时源码残留 0，生产源码和真实库树摘要均不变。

`pnpm typecheck` EXIT 0；`m4:test` 262/0；`m5.1:measurement:verify` 16/0；`gates:verify` 51/0。**`pnpm m4.5:ci` 完整离线链 EXIT 0**，本轮 G12 38/0、L2 53/0、G13 32/0、G2 150/0、G9 PASS。G14 52/0 为读取历史 Live Smoke，不是本轮新跑真实模型；没有复制运行中的生产库。[回归归档](../../artifacts/post-lv2/s8-consumption-lock-repair-20261007/regression-validation.json) 保存源指纹与新读数，8 个被测试重写的历史文件逐路径还原，原 FAIL 不回写。

## 处置与边界

本次处置对象是 `L-S8-30` 的量具残余，状态 **RESOLVED（工程验收范围）**。入口缺口已有 ADR-107 / ADR-115 的实现与 e2e 证据；本次按 R-4c 补齐生产调用点缺席时的失败判据和恢复，并把旧静态锁的主张降级。

自然生产首次使用、真实模型语义正确率（`L-S8-31`）以及长期人格/习惯收益不由本门判定。本次没有打开真实库或发送生产实验消息；历史 OPEN / PASS / FAIL 读数保留，不回写。
