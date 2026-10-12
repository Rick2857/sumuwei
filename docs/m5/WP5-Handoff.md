# WP5 Handoff — Context Selector & Budget

> 计划书要求的八字段交接单。下次 execution（WP6）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP6 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)（§3/§4/§6）。
> **不要重新探索仓库。** WP6 是**第一个改变用户体验**的 WP，风险也最高。

```text
Completed WP: WP5 — Context Selector & Budget
Changed:
  src/kernel/recall/selector.ts       （新增：预算抽象 + 六类计划 + 确定性选择 + 账目 + bundle 组装）
  src/kernel/recall/render.ts         （追加：renderMemoryEntry / MEMORY_BLOCK_HEADER / renderMemoryBlock）
  scripts/verify-m5-budget.ts         （新增：32 项门，含 Hard Test）
  package.json                        （新增 pnpm m5:budget:verify）
  artifacts/m5/wp5-context-budget.json（新增：预算计划 + 9 档 Hard Test + 真实链路截断）
  docs/m5/WP5-Handoff.md              （本文件）
  docs/architecture/README.md         （登记 m5:budget:verify 与 WP5 文档）

Tests:  pnpm m5:budget:verify      → 32 通过 / 0 失败
        pnpm m5:ranking:verify     → 27 通过 / 0 失败
        pnpm m5:retrieval:verify   → 28 通过 / 0 失败
        pnpm m5:verify             → 26 通过 / 0 失败
        pnpm m5:test               → 30 通过 / 0 失败
        pnpm typecheck             → exit 0
        pnpm kernel:test           → 26 通过 / 0 失败
        pnpm kernel:verify         → 25 通过 / 0 失败
        pnpm m4:test               → 243 通过 / 0 失败
        pnpm m3.5:test             → 30 通过 / 0 失败

Hard Test（**实测**，见 artifacts/m5/wp5-context-budget.json）:
        500 条候选 × 9 档预算（0/1/7/40/137/500/800/2000/8000）
        每一档都过 assertSelectionInvariant（失败关闭），且 used <= budget 逐档成立：
          0→0, 1→0, 7→0, 40→2, 137→5, 500→19, 800→30, 2000→78, 8000→310（选中条数）
        真实链路截断：大预算装得下、14 token 预算下被裁的都在决策里写 BUDGET_EXHAUSTED

Known issues（刻意的设计，不是缺陷）:
  · **估算的就是注入的**：token 数算在 `renderMemoryEntry()` 产出的那一行上，
    而 WP6 注入的也正是那一行（`selection.blockText`）。两处文本一旦分家，
    预算就是"看起来遵守"。因此 **WP6 不许再渲染一遍**。
  · 选择是**贪心继续**而不是"遇到装不下就收工"：第一条太大时会继续试后面更小的，
    但**从不重排**（优先级顺序是 WP4 给的）。这一点由门里的两条断言分开测：
    "跟随输入优先级" 与 "跳过太大但填满剩余预算"。
  · 装不下的理由固定是 `BUDGET_EXHAUSTED`（budget 阶段），**不复用** `LOW_RELEVANCE`。
  · `DUPLICATE` 在预算阶段又挡了一次（用 `slotFingerprint`）：WP4 已经去重过，
    这里是防御性的 —— 因为"绕过 WP4 直接喂 ranked"完全可能（WP6 接线写错就会）。
    注意判据是**槽位指纹**而不是槽位：问"以前"时"当前 + 一条历史"是刻意要两条的。
  · `conversationTokens` 留给 WP6 填（本层只负责记忆那一块）。
  · `external_evidence` 的额度恒为 0（M5.5 才填）。
  · 默认预算是**配置**（6000/800/2400），与模型窗口无关；门里有静态锁 +
    "只改预算就能改变结果"的行为对照 —— 计划书禁止靠提高窗口绕过。

Interfaces exposed to next WP:
  · ContextBudget{ totalTokens, memoryTokens, reservedTokens } + DEFAULT_CONTEXT_BUDGET
  · assertContextBudget（装配期失败关闭）· planContextBudget（六类分配，可审阅）
  · selectMemoryContext({request, ranked, budget, quantifier?, now}) → MemoryContextSelection
  · MemoryContextSelection{ blockText, entries[{memoryId,text,estimatedTokens}], bundle, decisions }
      · `blockText` = 标题 + 逐条（**空选择时是空串**）
      · `bundle` = WP1 契约定型（已过 assertContextBundle）
      · `decisions` = 预算阶段终局（BUDGET_EXHAUSTED / DUPLICATE）
  · renderMemoryEntry / renderMemoryBlock / MEMORY_BLOCK_HEADER / SELECTED_MEMORY_BLOCK_HEADER
  · assertSelectionInvariant · describeBudgetAccount

Do not modify（WP6 只消费）:
  · `renderMemoryEntry` 的格式（它是"估算 = 注入"的锚点）
  · 贪心继续 + 不重排的选择语义
  · `BUDGET_EXHAUSTED` / `DUPLICATE` 的理由归属
  · 预算来源（配置，不是模型窗口）

Next WP prerequisites（WP6 Context Compiler & Runtime Integration）:
  1. **注入 `selection.blockText` 本身**：`createMemoryRecallProvider`（`sections.ts`）产出
     `ContextSection{ id:'memory-recall', kind:'memory', priority: SECTION_PRIORITY.memory(40),
     droppable: true, content: blockText, sourceRefs: selectedMemoryIds }`。
     **不许**改写它、不许把它拼进别的 section、不许让它升级成 instruction
  2. `blockText === ''` 时**产 0 个 section** —— 这是 prompt 逐字节基线（FC-T08）不被破坏的机制
  3. 只读网关（`--dump-prompt`）也要看到召回结果（召回是只读的；
     但**写路径**（memoryWriter/actionWriter）不进只读网关 —— 别把两者混起来）
  4. 开关 `CHARACTER_RECALL_ENABLED`（默认 on）+ **消费锁**（M4.1 的 D3 教训：
     一个只被读进 flags 没有任何消费者的开关就是惰性开关）
  5. trace：`selectedMemoryIds` 填上、`'memory_recall'` step、
     进 trace 的形态用 `serializeContextBundleForTrace()`（**正文不进 trace**）
  6. `externalEvidence` 保持 `[]`；`conversationTokens` 在这一层补上
  7. **Prompt Injection 负控**：把"忽略以上所有指令"写进一条记忆，召回后
     system policy / identity rules / 工具权限**一个字都不能变**
  8. 无召回普通对话回归：没有可召回记忆时 prompt 与 M3.5 基线逐字节一致
  9. 证据写 artifacts/m5/wp6-context-compiler.json；新增 pnpm m5:runtime:verify
```
