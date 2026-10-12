# WP1 Handoff — Recall Contracts

> 计划书要求的八字段交接单。下次 execution（WP2）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP2 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)（§3/§4/§6）。
> **不要重新探索仓库。**

```text
Completed WP: WP1 — Recall Contracts
Changed:
  src/kernel/contracts/recall.ts        （新增：契约 / 校验 / 稳定序列化 / 隐私形态）
  src/kernel/contracts/index.ts         （新增 re-export + 文件头登记）
  scripts/kernel-tests-recall.ts        （新增：契约测试 30 项）
  package.json                          （新增 pnpm m5:test）
  artifacts/m5/wp1-contracts.json       （新增：证据 + 理由登记表快照）
  docs/m5/WP1-Handoff.md                （本文件）
  docs/architecture/README.md           （登记 m5:test 与 WP1 文档）

Tests:  pnpm m5:test      → 30 通过 / 0 失败（4ms，离线、无 DB、无模型）
        pnpm typecheck    → exit 0
        pnpm kernel:test  → 26 通过 / 0 失败（含依赖方向静态锁 —— recall.ts 零基础设施 import）
        pnpm kernel:verify→ 25 通过 / 0 失败
        pnpm m4:test      → 243 通过 / 0 失败（package.json 静态锁未被新增脚本破坏）
        pnpm m3.5:test    → 30 通过 / 0 失败

Evidence: artifacts/m5/wp1-contracts.json
          （含全部 12 个 RecallExclusionReason 的 reachable/stage/producer/blocker 快照）

Known issues（都是**契约层的刻意设计**，不是缺陷）:
  · DELETED 与 NOT_ACTIVE 是**保留位**（reachable=false）。今天没有任何数据能触发它们：
    M4 没有 status='deleted'；四种状态里不可召回的只有 retracted/superseded。
    运行期用它们会被 assertExclusionReasonReachable() 拒绝。
  · RecallCandidate **不是** M4 的 MemoryCandidate（抽取候选）。刻意不同名 —— 同名会让
    `import { MemoryCandidate }` 成为一个随时拿错类型的陷阱。
  · ContextBundle.externalEvidence 非空会被 assertContextBundle() 拒绝（那是 M5.5 的字段）。
  · 契约**零** DB/向量/网络依赖（AT1.3）：适配器负责"行 → RecallCandidate"。
  · WP1 刻意**没有**实现检索/排序/Prompt（计划书 Forbidden）。

Interfaces exposed to next WP:
  · createRecallRequest / parseRecallRequest / serializeRecallRequest / recallRequestDigest
  · RecallCandidate / RecallDecision / assertRecallDecision
  · RecallScoreBreakdown{ total, components[{name,value,available,note}] }  ← available 是"不得伪造"
  · ContextBundle / createEmptyContextBundle / assertContextBundle / serializeContextBundleForTrace
  · exclusionReasonForStatus（**复用** isRecallEligible）· assertExclusionReasonReachable
  · RECALL_EXCLUSION_REASON_FACTS（每个理由的 stage + producer）· RECALL_LIMITS
  · RECALL_TARGET / RecallTimeScope / RecallIntent / RecallChannel

Do not modify（WP2–WP7 只消费，不重定义）:
  · RecallExclusionReason 的语义与 stage（改 = 回来改契约 + 契约测试）
  · exclusionReasonForStatus 的映射（它是 M5 与 M4 的**唯一**接缝）
  · 隐私纪律：正文只允许出现在 ContextBundle.candidates[].dataText 与 selected[].dataText，
    进 trace 一律走 serializeContextBundleForTrace()
  · M5-PRE 已修好的 reset 语义（不要为了召回"顺手"再动 resetKernelData）

Next WP prerequisites（WP2 Eligibility Filter 必须做到）:
  1. 状态判定**只**用 exclusionReasonForStatus / isRecallEligible，不许自己写一套；
     它的 switch 是**穷尽无 default** —— 这正是 NOT_ACTIVE 保留的原因
  2. 每条决策过 assertRecallDecision()（阶段一致性由它保证，不要绕过）
  3. 保留位不许出现在决策里（运行期会抛 exclusion_reason_not_reachable）
  4. ORPHANED_EVIDENCE 接 `memoryIntegrityProblems()`（M5-PRE 的探针，见
     infrastructure/persistence/memory-integrity.ts）
  5. P0 三个零泄漏判据（forgotten / wrong-user / invalid-target）需要**负控**；
     用户裁定：Scenario E 只验证 `not_found/ambiguous → selected = []`，禁止硬造第三人
  6. 新增 pnpm m5:verify 脚本（WP2 才加），证据写 artifacts/m5/wp2-eligibility.json
```
