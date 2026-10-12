# WP7 Handoff — Recall Trace, Audit & Measurement Truth

> 计划书要求的八字段交接单。下次 execution（WP8）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP8 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)。
> WP8 是 **M5 Final Gate**，要跑全量回归 + NL E2E + Live Smoke。

```text
Completed WP: WP7 — Recall Trace, Audit & Measurement Truth
Changed:
  src/kernel/recall/record.ts         （新增：RecallDecisionRecord + 指标 + 聚合 + 隐私结构检查 + applyContextReality）
  src/kernel/app/recall/turn.ts       （新增：决策全集（资格/排序/预算/选中各一支）+ 记录构建）
  src/kernel/app/turn-gateway.ts      （改：**step 写在编译器之后**；用 applyContextReality 修正"实际到达"的事实）
  scripts/m4-harness.ts               （新增：nextTurnSequence（一轮占两个会话序号））
  scripts/verify-m5-trace.ts          （新增：33 项门）
  package.json                        （新增 pnpm m5:trace:verify）
  artifacts/m5/wp7-trace.json         （新增）
  docs/m5/WP7-Handoff.md              （本文件）
  docs/architecture/README.md         （登记 m5:trace:verify 与 WP7 文档）

Tests（全部 exit 0）:
  M5：m5:test 30 · m5:verify 26 · m5:retrieval:verify 28 · m5:ranking:verify 27
      m5:budget:verify 32 · m5:runtime:verify 27 · **m5:trace:verify 33**
  类型：typecheck
  prompt / 装配：m3.5:test 30 · eval:dryrun 17 · eval:scenarios 7
  部件/域：m4:test 243 · m4.5:test 135 · kernel:test 26
  ⚠️ 本 WP **没有**重跑 Live Smoke：WP7 不改 prompt 内容与回复路径
     （只多写一个 trace step），而 WP6 接线之后已经跑过 50/0。
     **WP8 的 Final Gate 会按要求重跑它**（含 M5 自己的 NL E2E）。

Known issues（刻意的设计，不是缺陷）:
  · **`selectedIds` 是"实际进了 packet 的"**，不是"选择器选中的"：
    记忆 section 是 `droppable: true`，上下文编译器可以整段丢掉它。
    那时 `selectedIds = []`、`metrics.reachedContext = false`、
    `metrics.droppedByContextBudget = true`，而 `intendedSelectedIds` 保留诊断。
    **`metrics` 描述事实；`budget` 描述选择阶段的账（意图）** —— 两者刻意分开。
  · 记录**有界**（`RECALL_RECORD_MAX_CANDIDATES = 40` 条明细 + `truncated`），
    而**计数与直方图永远全量** —— 被截断的是明细，不是事实。
  · 隐私是**两道**：结构检查（`assertRecordShapeIsContentFree`：不许出现
    正文类键；`{name,value}` 里的 value 必须是数字）+ 门里用 fixture 的真实正文
    搜一遍记录与 trace 属性的 JSON。第一版把通用的 `value` 键当成正文标记，
    于是每个分数都被误判 —— 已修。
  · `memory_recall` step 的 `startedAt` 是**召回开始时**，`finishedAt` 是**编译之后**：
    因为"是否真的进了 packet"只有编译后才知道。它的时长因此覆盖召回+编译。

Interfaces exposed to next WP（WP8 全部要用）:
  · RecallDecisionRecord / RecallCandidateFact / RecallDecisionFact / RecallMetrics
  · buildRecallDecisionRecord / withScanned / applyContextReality /
    recordToTraceAttributes / assertRecordShapeIsContentFree / describeDecisionRecord
  · aggregateRecallMetrics（轮数 / 平均候选 / 平均选中 / 预算利用率 / **reachedContextRate**）
  · `memory_recall` step 的属性：扁平指标 + `decisionRecord`（有界 JSON、无正文）
  · trace 的 `selectedMemoryIds`（**实际到达**的那些）

Do not modify（WP8 只消费）:
  · "metrics = 事实 / budget = 意图"这条划分
  · step 写在编译之后的顺序（写早了就会声称"她想起了"而实际没进）
  · 隐私两道检查（加字段前先问"它能不能含正文"）

Next WP prerequisites（WP8 = M5 Natural-Language E2E Hard Gate + Final Gate）:
  1. E2E 场景必须**从真实文本进入**：`tsx src/main.ts "<话>"` 或 gateway 的真实一轮，
     不许直接构造 RecallRequest / 不许直接给 memoryId（M4 的 D1 就是这么漏过去的）
  2. 判据必须是**文本级 + 状态级**两样：
     · 文本级：那条记忆的条目文本在 prompt 里（WP7 的量具）
     · 状态级：`selectedMemoryIds` / `record.metrics.reachedContext`
     · **回复级**：她真的答对了（需要真实模型 → Live Smoke）
  3. 用户裁定的三个场景口径：
     · G1：E2E Gate 用**规则抽取器已支持的事实**（如 education.institution）；
       生日降级为 Coverage Boundary Test，**不要**打开 LLM 抽取器
     · G2：Scenario E 只验证 `not_found / ambiguous → selected = []`；**禁止硬造第三人**
     · G3：KPI 分层 —— Supported-Domain ≥95% + Coverage Boundary Set 不计入
  4. Scenario B（忘掉）/ C（取代）/ D（跨用户）/ F（干扰）/ G（无证据）/ H（注入）
     各自的判据见计划书；H 可以复用 WP6 的注入负控（identity/规则逐字节不变）
  5. Final Gate 顺序（计划书）：M5 targeted suite → M4/M4.1/M4.5 regression →
     full regression → NL E2E → negative NL E2E → **production-copy live smoke**
  6. 最终产物（计划书 FINAL OUTPUT）：M5-Implementation-Report / Test-Report /
     Retrieval-Metrics / NL-E2E-Evidence / Live-Smoke-Evidence /
     Regression-Evidence / Known-Limitations / **Gate Decision（只能 PASS/FAIL）**
```
