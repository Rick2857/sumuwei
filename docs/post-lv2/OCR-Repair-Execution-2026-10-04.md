# OCR 修复执行记录（2026-10-04）

调查始于 2026-10-04，完整回归收口于 2026-10-05（Asia/Shanghai）。

授权：用户在原因与方案调查后明确要求「确认完方案后你直接执行」。
此前的第一轮 FAIL 与 PARTIAL 保留；本记录只说明后续修复，不回写旧运行结果。
诊断：[原因、候选实测与接入方案](../research/OCR-Failure-Diagnosis-and-Repair-Plan-2026-10-04.md)。

## 1. 已执行的修复

- 生产 OCR 装配选择 RapidOCR 3.9.2 / ONNX Runtime 1.20.1 CPU，显式指定已测通过的
  PP-OCRv4 mobile 检测/识别与 v2 分类模型。没有使用默认 PP-OCRv6，后者原图实测有框顺序错误。
- 三个模型固定字节数、SHA-256；父进程识别前核对，工作器再次核对。
  Python 与完整依赖有独立安装锁，准备入口 `scripts/utility-skills/setup-rapidocr.ts`；运行时不下载模型。
- 保留 `image.ocr`、原输入校验、权限/路径解析、当轮内容、预算与持久化引用通道。
  Python 工作器只接收 stdin 图片字节；16MiB / 20MP / 30s 上限保持，超时/取消都等待进程实际退出。
- 资产故障新增有限原因标记 `ocr_assets_missing`，回复层只透传该白名单原因并生成确定性提示，
  消除 `L-US-06b` 中模型猜测图片格式的行为，不透传原始路径或异常。
- Tesseract 回滚代码与资产保留；`PROJECT_LG_OCR_BACKEND=tesseract` 可切回。
  本机已有的 `CHARACTER_IMAGE_OCR_ENABLED=true` 没有改动；代码层能力开关仍缺省关闭。

## 2. 当前验证读数（分列）

| 验证 | 结果 | 当前证据 |
|---|---|---|
| 类型检查 | PASS，EXIT 0 | `local/ocr-diagnosis-20261004/typecheck-final-delivery.log` |
| 新工作器组件 | PASS，15/15 | `local/ocr-diagnosis-20261004/component-hjGFEl/results.json` |
| OCR 原六组 | PASS，6/6 | `utility-skills/ocr-repair-delivery-20261004T155635-f954404a-470a/run.json` 中 ocr-01…06 |
| 公共接线八组 | PASS，8/8；14 组合计 EXIT 0，41 输入 | 同一 delivery run；此前两轮 common-02 计算超时 FAIL 保留 |
| 真模型 OCR 缺资产 | PASS，1/1 | `utility-skills/ocr-repair-live-20261004T154944-17908/live.json` 的 live-ocr-degrade |
| 真模型 OCR 成功 | 数字正确；机械 FAIL 保留 | 同一 live 的 live-ocr-success：4711 / 2026-10-04 都在回复里；CLI spokenText 不带来源附录，原附录抓取判据仍 FAIL |
| M4.5 路径检测测试修复 | PASS，145/0 | `local/ocr-diagnosis-20261004/m4.5-component-repair.log` |
| 完整 `m4.5:ci` | PASS，EXIT 0（第二轮） | `local/ocr-diagnosis-20261004/m4.5-ci-final.log`，第一轮 FAIL 日志保留 |

完整回归实跑的 M4.5 读数：部件 146/0、子系统 53/0、量具 38/0、自然语言 32/0、审计 12/0。
汇总门中的 G14=52/0 承接既有合格 Live Smoke 证据；本次没有重跑该 52 案真模型档。
本轮新出的 OCR 真模型证据仅为上表两条，成功场景的附录抓取 FAIL 保留。

生产配置已只读核对：`backend=rapidocr`、`CHARACTER_IMAGE_OCR_ENABLED=true`，Python/模型路径均指向
`artifacts/post-lv2/local/ocr-runtime`；证据 `local/ocr-diagnosis-20261004/production-config-readonly.json`。
现有聊天进程需重启才能加载新执行器。

以上路径均相对 `artifacts/post-lv2/`。新组件证据包括独立 Python audit 网络探针的正控、
缺失/损坏模型零 spawn、运行中的取消与同一实例恢复、并发拒绝、硬超时后退出、
模型前后指纹相同，以及 Tesseract 回滚实际识别。未用旧 Tesseract 的 21/21 替代新工作器验证。

| 原图 | 修复前 CER | 新后端 CER | 关键数字 |
|---|---:|---:|---|
| 清晰中文 | 8.33% | 0% | 全正确 |
| 清晰英文 | 0% | 0% | 全正确 |
| 清晰混合 | 5.88% | 0% | 全正确 |

参考转录、图片、CER 算法与清晰门槛 ≤5% 没有变；没有文字定向替换或 LLM 润色。
退化图现在为空，CER=100%；按原计划允许的无内容降档，验证 `partial`、零当轮正文、`empty` 态与无来源附录。
这不是退化图准确率提升，且不再断言它识别出了数字。

## 3. 失败档、尚未关闭的判据与边界

公共 common-02 的计算工作器未修改。直接运行同一原工作器得到 0.3，但本机测得启动到退出
18,253 / 2,255 / 2,134ms，都超过既有 2,000ms 硬超时；读数在
`local/ocr-diagnosis-20261004/math-startup-readonly.json`。这是前两轮公共聚合的真实失败，未放宽阈值凑绿；
后续 delivery run 中同一生产 2s 阈值通过。启动耗时越过硬上限的风险仍需保留，不能据最后一轮绿删除失败档。

第一轮 `m4.5:ci` 在 `kernel-tests-action.ts` §8.7 失败：旧用例仍要求绝对 Windows 路径被
`sandbox.file.read` 认领，第二批生产代码已明确把它交给 `local.file.read` 检测器。
为完成本轮回归，只维护该用例：用 `../private.txt` 保留相对越界被沙箱策略拒绝的原性质，
另加绝对路径不被旧检测器认领、由第二批检测器识别的两个断言。没有修改路径路由或放宽读取权限。
第一轮 FAIL 原日志 `m4.5-ci.log` 保留；修复后部件 145/0，随后完整回归退出 0
（完整回归时共享工作树的部件档为 146/0）。

真模型成功场景的附录抓取问题已在第一轮验收报告登记：CLI 输出 spokenText 按设计剥掉附录，
量具却在 stdout 要求该附录。此次保留 FAIL；实际 OCR 内容入模与程序附录由离线真实 Gateway 验证。
不据识别数字正确宣布完整 live 门通过，也不把修复扩大成 CLI/计算器改造。

本轮全部数据库试验使用隔离库，未打开真实 `data/pglite`；部署后用户自己的首次对话仍需另记。
当前结论是 **OCR 实现已替换，原清晰准确率失败与资产错误提示已修复**；
完整 live 量具仍按上述附录红项如实保留，不能宣布四项所有门全部 PASS。

使用、重建与回滚见 [使用说明 §3.2](Utility-Skills-Usage-and-Rollback.md#32-ocr-当前后端与回滚2026-10-04-修复)。
