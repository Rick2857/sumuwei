# ADR-038：记忆基础设施边界（Cognee / Graphiti / 外部 Memory 后端）

- 状态：**已采纳**（M5.1 WP6，2026-09-17）
- 里程碑：M5.1（OSS Integration Audit）
- 相关：ADR-020~029（记忆模型与后端门禁）、ADR-026（原生优先）、
  ADR-027（外部后端 Gate）、`docs/m4/ADR-M4-MemOS.md`（先例：REJECT）、
  `docs/architecture/memory-invariants.md`（MI-01~15）、`docs/m5.1/M5.1-OSS-Audit.md` §2
- 裁定：**Cognee = REJECT** · **Graphiti = REJECT（证据强度低）** ·
  **外部 Memory 后端（类别）= REFERENCE（门在 ADR-027）**

---

## 1. 背景与实测

AT6.2 只问三个问题（计划书原文）：
> could it act as backend/provider? / does it try to own memory semantics? /
> does it conflict with Event Ledger?

**"接一个外部记忆后端要付什么"是可以量出来的**（仓库实测）：

| 要付的东西 | 数字 |
|---|---|
| 接口面 | `MemoryStorePort` = **11 个方法** |
| 必须保住的不变量 | **MI-01 ~ MI-15**（其中 MI-11 = 删投影能从事件重放且逐字段一致） |
| 事实源 | 六种 `MEMORY_*` 领域事件 + `memory-validator.ts`（唯一放行口） |
| 已有的先例 | **MemOS 已 REJECT**（M4，判据是 ADR-027 第 7 条） |

外部事实（强度已标注）：Cognee 自述为"open-source AI memory platform"、
"self-hosted knowledge graph"、"persistent long-term memory across sessions"（**一手**）；
**Graphiti 本轮未取得一手页面**，因此判断是**类别推断**（这一类时序知识图谱框架
都以"拥有 fact / 时间轴 / 冲突消解"为核心卖点）。来源见审计 §2.2。

---

## 2. 五项解释

### Landing Target
只允许一个落点：**`MemoryStorePort` 的一个实现**（`infrastructure/persistence/`）。
不允许出现在 `src/kernel/**`，不允许成为任何领域的 Authority。

### Authority Boundary（这一条是本次裁定的核心）
三条**不可让渡**：
1. **状态语义**（`active` / `superseded` / `retracted` / `disputed` 与 `isRecallEligible`）
2. **证据与权威**（`EvidenceRef` / `evidenceRootIds` / `MemoryAuthority` 六级）
3. **事件账本**（六种 `MEMORY_*` 事件是事实源；投影是派生的，可重放）

Cognee / Graphiti 的卖点**正是**第 1 与第 2 条（"它自己维护知识图谱与事实演化"）。
只要它要求"我说了算"，就与 G-01 直接冲突 —— 这与 MemOS 的下场**同一条判据**。

### Replacement Strategy
若将来要换：**只换端口实现，不换端口**。
- 换之前必须先证明 **MI-11 成立**：删掉投影、从事件重放，逐字段一致。
  （这一条正是 MemOS 被拒的地方：它要求接管事实演化，MI-11 无从成立。）
- 备份 / 恢复 / 隔离（MI-13/14）必须跟着换，不能只在原生实现里有。

### Failure Isolation
后端的失败**不得**变成记忆的静默丢失。渠道：
- 所有写入必须过 `memory-validator.ts`（失败关闭）；
- 后端不可用时，写入失败要**如实**回 `content_unresolved` 一类的拒绝，
  绝不允许"看起来记住了"（M4.1 的 C7 教训）；
- 现有实现**不引入网络**（PGlite 本地），因此今天不存在"远端超时"这一类窗口 —— 引入外部后端会**新开**这个窗口，属独立里程碑的风险清单。

### Future Milestone
**未排期**。若用户想推进：先做一次"费用记账 spike"，回答：
- 11 个方法里**哪几个**在外部后端上语义对不上？（写 `apply` / `rebuildMemory` 最难）
- MI-11 能不能成立？不能成立则**直接 REJECT**，不必再评估成本。

---

## 3. 备选与否决理由

| 备选 | 否决理由 |
|---|---|
| Cognee 作为 Memory 后端 | 它自述拥有 memory 语义（知识图谱 + 跨会话长期记忆）→ 争第 1/2 条主权 |
| Graphiti 作为 Memory 后端 | 同类别推断；**证据强度低**，若改判先补一手文档 |
| Cognee/Graphiti 作为**召回通道**（检索供应商） | 会绕开 `exclusionReasonForStatus` 这**唯一**资格判据（M5 WP2 的 P0 安全层），并让"零泄漏计数"失去意义 |
| 把它们的 MCP server 接上（Cognee 提供） | 见 ADR-039：MCP 只是适配器层，不能带进记忆权威 |
| 离线读我们的导出做分析 | **不在本轮范围**；且要走隔离副本（`data/pglite/` 冻结区） |

---

## 4. 后果

- 本轮**不动任何代码**；ADR-026/027 的门禁继续有效。
- 新增一条可复核的**准入判据**（写进这里，免得下次从"它看起来很强"开始）：
  > **MI-11 成立吗？** 不成立 → REJECT，且不必再谈集成成本。
