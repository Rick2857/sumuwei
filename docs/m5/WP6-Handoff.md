# WP6 Handoff — Context Compiler & Runtime Integration

> 计划书要求的八字段交接单。下次 execution（WP7）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP7 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)（§3/§4/§6）。
> **不要重新探索仓库。**

```text
Completed WP: WP6 — Context Compiler & Runtime Integration（第一个改变用户体验的 WP）
Changed:
  src/kernel/app/recall/turn.ts        （新增：轮次端口 = WP3 服务 + WP4 排序 + WP5 选择的**唯一**组合处）
  src/kernel/context/sections.ts       （新增：SECTION_IDS.memoryRecall + createMemoryRecallProvider（kind 'memory' / 优先级 40 / 可裁））
  src/kernel/app/turn-gateway.ts       （新增：recall / recallEnabled / recallBudget 选项 + recallForTurn + memory_recall step + selectedMemoryIds）
  src/kernel/contracts/trace.ts        （新增：TraceStepKind 'memory_recall'）
  src/kernel/app/flags.ts              （新增：CHARACTER_RECALL_ENABLED，默认 on + describeKernelFlags 打出 'recall'）
  src/main.ts                          （新增：buildRecallTurnPort + 两个分支都注入（召回只读））
  scripts/m4-harness.ts                （暴露 kernel / recorder / userId；recordUserEvidence 多返回 event + conversationSequence）
  scripts/verify-m5-runtime.ts         （新增：27 项门，构造**真实 TurnGateway**）
  package.json                         （新增 pnpm m5:runtime:verify）
  artifacts/m5/wp6-context-compiler.json（新增）
  docs/m5/WP6-Handoff.md               （本文件）
  docs/architecture/README.md          （登记 m5:runtime:verify 与 WP6 文档）

Tests（全部 exit 0）:
  M5：m5:test 30 · m5:verify 26 · m5:retrieval:verify 28 · m5:ranking:verify 27
      m5:budget:verify 32 · **m5:runtime:verify 27**
  类型：typecheck
  域/持久化：kernel:test 26 · kernel:verify 25 · m3:verify 67 · m3.5:verify 31
  部件：m4:test 243 · m4.5:test 135
  **prompt / 装配（§5 点名要跑的）**：
      m3.5:test 30（**含 FC-T08 prompt 逐字节基线 —— 仍然通过**）
      eval:scenarios 7 · eval:dryrun 17 · eval:providers 11
  遥测（trace 契约改了）：eval:telemetry 54 · eval:otlp 21
  Live Smoke：pnpm m4.5:smoke:live（生产库副本 + 真实模型）→ 见本文件末尾的实测结论

Known issues（刻意的设计 / 如实记录的边界）:
  · **没有意图分类器**：运行时 `intent` 恒为 `current_fact`。
    历史查询（"以前……"）的语义已在 WP4 层验证（问"以前"→ superseded 参与、
    问"现在"→ 它在资格层出局），但**运行时还不会自动判成 historical**。
    这需要一个真的意图判定，不属于 M5 —— 已记入 M5 Known Limitations，不假装它会动。
  · **词面桥的粒度=二值 bigram**：`今天的天气怎么样？` 会因为 `怎么` 命中
    `preferred.address` 的登记说明（"希望被**怎么**称呼"）。
    这不是缺陷，是机制的粒度（计划书禁止手工词表）；影响由 WP4 排序 + WP5 预算限制。
  · **合成轮次没有 userId → 不召回**（fail-safe：不拿假身份去查别人的记忆）。
    `--dump-prompt` 在 main.ts 里是有 userId 的，因此它照常能看见召回结果。
  · **只读网关也注入召回**（与 memoryWriter/actionWriter 相反）—— 因为召回不写库，
    而"她这一轮想起了什么"正要在最常用的排查入口里可见。
  · **memory section 的 kind 是 `memory`（可裁）**，与写入结果那条 `instruction`（不可裁）
    是两条不同的链：前者是数据，后者是必须如实转述的指令。
  · `droppable: true` 的代价：预算极紧时记忆段会被整段裁掉（WP5 的账目里看得见）。

Interfaces exposed to next WP:
  · RecallTurnPort.run(request) → RecallTurnOutcome{ selection, bundleTrace, trace }
      · `trace.traceId / scanned / candidateCount / eligibleCount / selectedIds /
        exclusionHistogram / droppedByBudget / account`（**全部无正文**）
      · `bundleTrace` 来自 `serializeContextBundleForTrace()`（契约层保证脱敏）
  · createMemoryRecallProvider({ render })（sections.ts）
  · TurnGatewayOptions{ recall?, recallEnabled?, recallBudget? } + TraceStepKind 'memory_recall'
  · flags.recallEnabled（CHARACTER_RECALL_ENABLED，默认 on）
  · main.ts: buildRecallTurnPort()（装配模板：store → 适配器 → 服务 → 轮次端口）

Do not modify（WP7/WP8 只消费）:
  · 召回在 `compileTurn` 里的位置（在 buildContextCompilerV2 之前、`beginTurn` 之后）
  · `createMemoryRecallProvider` 的注入方式（**原样**用 blockText，不重渲染）
  · `memory_recall` step 的属性集合（**只有计数与 id，没有正文**）
  · 两个分支都注入召回这条性质（只读网关也必须能看见）

Next WP prerequisites（WP7 Recall Trace / Audit / Measurement Truth）:
  1. 复用**已有**的 trace 通道（`memory_recall` step + `selectedMemoryIds`），
     不要再造第二套 tracing
  2. 至少形成 `RecallDecisionRecord` 或等价结构：candidate ids / exclusion reasons /
     score breakdown / selected ids / budget —— **全部从 `RecallTurnOutcome.trace` 取**，
     不要重新查库
  3. **Measurement Truth**：故意构造"目标记忆没有进上下文"，测试必须**失败**。
     判据是 **prompt/packet 文本级**的（模型实际拿到的那份文本里有没有它），
     不是"Recall API 返回了什么" —— 这是 WP7 最重要的一条
  4. 隐私：进 trace 的形态一律走 `serializeContextBundleForTrace()`；
     新增指标时先问"它能不能含正文"
  5. 证据写 artifacts/m5/wp7-trace.json；新增 pnpm m5:trace:verify
  6. WP8 的 Live Smoke 要复用 `verify-m4.5-smoke-live.ts` 的骨架
     （生产库只复制、沙箱指向临时目录、每一轮同时验 Level 1/2/3 + 回复口吻）
```

## 附：Live Smoke 实测结论

（见本 WP 的最终报告；`pnpm m4.5:smoke:live` 在生产库**副本**上跑真实模型多轮，
用来回答"用户看到的是不是真的"。它验证的是我这一轮改动**没有破坏真实链路**；
M5 自己的真实召回行为要到 WP8 的新 Live Smoke 才被端到端验证。）
