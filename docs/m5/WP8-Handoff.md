# WP8 Handoff — M5 Natural-Language E2E Hard Gate & Final Gate

> 计划书要求的八字段交接单。**WP8 是 M5 的最后一包**，这份因此同时是
> **M5 → M5.5 的交接单**。下次 execution 先读这份，再读
> [`M5-Acceptance-Report.md`](./M5-Acceptance-Report.md)（结论与八条局限）与
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（M5.5 节）。

```text
Completed WP: WP8 — M5 Natural-Language E2E Hard Gate + Final Gate（结论 PASS）

Changed:
  scripts/verify-m5-e2e.ts            （新增：A–H 八个 NL 场景 + P0 零泄漏，28 项）
  scripts/verify-m5-smoke-live.ts     （新增：production-copy + 真实模型，16 项）
  scripts/m5-gate-results.ts          （新增：只读已落盘证据的门汇总 → hardGateVerdict）
  scripts/m4-harness.ts               （改：暴露 kernel / recorder / userId / nextTurnSequence；
                                        recordUserEvidence 返回 event + conversationSequence）
  scripts/verify-m5-trace.ts          （改：轮次序号改用 nextTurnSequence（一轮占两个序号））
  package.json                        （新增 m5:e2e:verify / m5:smoke:live / m5:gates）
  artifacts/m5/wp8-e2e.json           （新增）
  artifacts/m5/smoke/                 （新增：smoke-result.json）
  artifacts/m5/regression-evidence.json （新增：全量回归的解析结果）
  artifacts/m5/gate-results.json      （新增：九道门汇总）
  docs/m5/M5-Acceptance-Report.md     （新增：八份产物合一）
  docs/m5/WP8-Handoff.md              （本文件）
  docs/architecture/README.md         （登记 m5:e2e:verify / m5:smoke:live / m5:gates 与 WP8 文档）

Tests（全部 exit 0）:
  M5 九道门：m5:test 30 · m5:verify 26 · m5:retrieval:verify 28 · m5:ranking:verify 27
            m5:budget:verify 32 · m5:runtime:verify 27 · m5:trace:verify 33
            **m5:e2e:verify 28** · **m5:smoke:live 16（真实模型）**
  汇总：`pnpm m5:gates` → `hardGateVerdict = PASS`（只读已落盘证据；缺文件 = not-run）
  全量回归：`pnpm m4.5:ci` 退出码 0 —— 26 个套件 / **1155 项断言 / 0 失败**，
            且 **M4.5 G12 / G13 / G14 三条 Hard Gate 重跑仍 PASS**
  类型：typecheck

Known issues（八条，全部不是 P0；详见验收报告 §8）:
  1. **没有意图分类器**：运行时 `intent` 恒为 `current_fact`、`target` 恒为 `none`；
     Scenario E 的 ambiguous/not_found 是**管线级**验证（直接喂 RecallRequest），
     不是"从一句话里听出指代不明"。要解除需要独立里程碑（意图/指代解析）。
  2. **词面桥是二值 CJK bigram、无停用词表**（计划书禁止手工词表）：
     `今天的天气怎么样？` 会因 `怎么` 命中 `preferred.address`。
     影响被 WP4 排序 + WP5 预算限制住。这是**机制粒度，不是缺陷**。
  3. **第三人主体不存在**（M4 的 subject 域只有 USER / CHARACTER）：按 G2 裁定不扩
     Entity Model；`target` 解析到第三人时该轮召回为空（保守且正确）。
  4. **D-9：证据移除没有对应事件**。M5-PRE 刻意保留"幸存记忆的失效 evidence link"，
     删它会破 MI-11 的 `A == B`（`compareRecords` 比对 `sourceRefs`，重放侧来自
     `MEMORY_CREATED` payload 快照）。要让悬空归零需要**追加一条领域事件 + reducer + 迁移**
     （动冻结区）。真库当前 `dangling_evidence_links = 0`。
  5. **审计探针的历史盲区**：`unsupportedMemories()` 只数 `memory_evidence_links` 的**行数**；
     M5-PRE 新增状态级探针 `memoryIntegrityProblems` 并在 `memory:stats` 单列，
     但**旧探针语义未改**（改它会动 M4 的既有判据）。
  6. **语义检索不可用**：M4 无嵌入列 + 计划书禁止为召回引入向量库 ⇒
     `semantic` 恒 `available: false`（**不是 0 分**，KPI 里不计入）。
  7. **检索最多扫描 500 行**（跟随 `MemoryStorePort.list` 既有上限）；更大规模需要分页/索引。
  8. **合成轮次（无 userId）不召回**：fail-safe，不拿假身份去查别人的记忆。

Interfaces exposed to next WP（M5.5 直接消费）:
  · RecallRequest / RecallCandidate / RecallDecision / ContextBundle
    （+ RECALL_EXCLUSION_REASON_FACTS / RECALL_CHANNEL_FACTS / RECALL_LIMITS）
  · eligibility：evaluateCandidates → EligibilityBatch{verdicts, eligible} / rejectedDecisions /
    measureLeakage（**适配器刻意不过滤**，零泄漏计数才有意义）
  · retrieval：MemoryRetrievalPort / renderRecallBlock / memory-retrieval-store（只读、宽召回）
  · ranking：rankCandidates（相关性闸 requireRelevanceEvidence / component.available /
    slot 冲突 / 稳定 tie-break）
  · selector：ContextBudget / planContextBudget / selectMemoryContext / assertSelectionInvariant
  · runtime：RecallTurnPort / createRecallTurnPort / createMemoryRecallProvider
    （SECTION_IDS.memoryRecall，kind 'memory'，priority 40，droppable true）
  · record：RecallDecisionRecord / buildRecallDecisionRecord / applyContextReality /
    recordToTraceAttributes / aggregateRecallMetrics（**metrics = 事实 / budget = 意图**）
  · 开关：CHARACTER_RECALL_ENABLED（默认 on，flags.ts 的 recallEnabled）

Do not modify（M5.5 只消费，不许顺手改语义）:
  · "metrics = 事实 / budget = 意图"这条划分，以及 step 写在**编译之后**的顺序
  · `selectedIds` 必须是"实际进了 packet 的"（不是"选择器选中了谁"）
  · 资格判定只走 `exclusionReasonForStatus`（不许自己写 status 字面量比较）
  · 适配器的**宽召回**（不要为了好看在适配器里过滤）
  · 隐私两道检查（加字段前先问"它能不能含正文"）
  · M5-PRE 的 `memoryIntegrityProblems` 探针（`integrityOk` 只能来自它）
  · 冻结区：`src/kernel/app/memory/**` / `memory-validator.ts` / `memory-store.ts` reducer
    语义 / `contracts/memory.ts` 事件 payload / 迁移 0001–0006 / `苏沐薇.ts` / prompt 基线

Next WP prerequisites（M5.5 = Web Search / Browser / Planner / World Model / External Tools）:
  1. **外部工具的事实不能绕过同一套纪律**：外部结果进入上下文前必须走
     "Speech ≠ Action ≠ Result"与 Assistant Fact Firewall（她说的不能自动变成外部事实）。
  2. **新通道要如实登记**：`RECALL_CHANNEL_FACTS` 目前只有 lexical / semantic / continuity；
     接外部检索时先决定"它是不是召回通道"——若是，加通道并让 `available` 如实；
     若不是，它就是**另一个上下文来源**，仍必须过 `ContextCompiler` 的预算与可裁性。
  3. **判据仍然是文本级 + 状态级 + 回复级三样**（WP7/WP8 的量具可直接复用）；
     Live Smoke 必须在**生产库副本**上跑，不许把实验写进真库。
  4. **意图分类器可以先做**（局限 1）——它同时解除 Scenario E 的管线级限制；
     但它属于 M5.5 或独立里程碑，**不要**顺手塞进 M5 的代码里。
  5. **G1 仍然有效**：不要为了"覆盖更多场景"打开
     `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`（那是独立里程碑 + 回归锁）。
  6. 计划书里 M5 的 16 条 PASS CRITERIA 已全部满足（验收报告 §11）；
     M5.5 的判据要**新写**，不要复用 M5 的 Gate 结论当作 M5.5 的通过依据。
```
