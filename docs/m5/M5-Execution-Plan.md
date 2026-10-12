# 苏沐薇 M5 — DSH Execution Plan

> **本文件是用户给定计划的仓库内固化（WP0 交付物）。**
> 目的：CONTEXT HANDOFF 要求"下一次 DSH execution 优先读取 1. M5 Execution Plan" ——
> 因此它必须能在仓库里被读到，而不是只存在于某一次会话消息里。
>
> 固化来源：用户 2026-09-17 会话中给出的 M5 执行计划全文。
> **若有分歧，以用户给定计划为准**；本文件不顺带添加任何未在计划中出现的实现决定
> （实现决定见 [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)）。

---

## 修订记录（用户裁定，2026-09-17）—— **执行顺序以本节为准**

> 本节**不修改**下面的计划原文。它记录用户对计划的一次显式修订：
> 在 WP0 与 WP1 之间插入一个受严格 Scope 控制的修复阶段，
> 并把三条能力边界从"扩建系统"改成"修正契约与验收方式"。

### 1. 新增 `M5-PRE / State-Integrity Hotfix`（**阻塞 M5**）

```text
M5 WP0（完成）
  ↓
M5-PRE / State-Integrity Hotfix        ← 新增
  ├─ resetKernelData regression（**先写失败测试，红了再修**）
  ├─ memory evidence cleanup semantics（判据 = liveEvidenceCountAfterReset）
  ├─ memory:audit dangling-evidence detection
  ├─ replay invariant
  └─ real DB read-only inventory（**已完成：CLEAN**）
  ↓
Re-baseline M4（m4:test / m4:verify / memory:audit / M4.1 相关门）
  ↓
M5 WP1（Recall contracts，含 ORPHANED_EVIDENCE / INTEGRITY_INVALID）
  ↓
WP2 … WP8（不变）
```

**Scope（不允许扩张）**：`resetKernelData`、memory evidence 完整性、
`memory:audit` 的悬空检测、相关 regression test、真库只读盘点。
**不允许**：顺势重构 Memory、改 reducer 语义、改 M5 契约（契约在 WP1）。

**关键判据（用户给出）**：

```text
一条记忆有两条证据、reset 只删掉其中一条 → 不能把整条记忆一起删掉
判据 = liveEvidenceCountAfterReset ≠ wasAnyEvidenceDeleted
reset 后无任何有效证据 → 删 memory record + subject links + evidence links + memory_events
reset 后仍有有效证据   → 只删失效的 evidence link，保留记忆
audit 必须能报 dangling_evidence_links 与 memories_without_live_evidence
最终按 "0 dangling evidence links" + "0 unsupported memories" 两句报
```

### 2. 三条能力边界：**不扩建系统，改契约与验收方式**（不阻塞）

| 项 | 裁定 |
|---|---|
| **G1** 生日写不进库 | **不修抽取能力**（不开 `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`，那是 Scope Creep）。E2E Gate 换成规则抽取器已支持的事实（如 `education.institution`）；生日**降级为 Coverage Boundary Test**，记录 `birthday extraction currently unsupported by deterministic extractor`。将来要扩覆盖面时，做成独立阶段（birthday / hometown / relationship / schedule …） |
| **G2** 第三人 subject | **不扩 Entity Model**。Scenario E 改为验证 `Target Resolver → not_found / ambiguous` 时 **`selected_memory_ids = []`**；**禁止直接插库**造 Person A/B（那正是"为了让测试存在，构造生产系统根本无法生成的数据"）。真正要"记住张三喜欢咖啡"时，另立 `Entity Memory / Third-party Subject Model` 阶段 |
| **G3** 词面桥覆盖度 | **接受边界**（不加 Vector DB / Embedding / 新语义检索基建）。KPI 拆成两个独立数字：**Supported-Domain Recall ≥ 95%**（仅登记表已覆盖的 predicate）＋ **Coverage Boundary Set**（未登记 predicate + 中文 query + 无中文 value 重叠，**不计入 95%**，用来证明系统知道自己的边界，报 `unsupported / insufficient` 而不是硬取一条"差不多"的记忆）。负控的正确形状是：**没有任何当前机制能建立 relevance 的未登记事实，不得为了满足 Recall 强行选出来** —— 而不是笼统的"未登记键必须不被召回"（若其 value 本身含「西安」，用户问"我之前提过西安吗"时词面命中是**合法**的） |

---

## EXECUTION MODE

本文件不是普通 Milestone 描述。

这是专门面向 DSH / Coding Agent 的执行计划。

强制规则：

```text
1 DSH Execution = 1 Work Package
```

绝对禁止：

```text
一次 execution 执行整个 M5
```

也禁止：

```text
“继续直到 M5 全部完成”
```

每一个 WP：

```text
读取限定上下文
→ 修改限定范围
→ targeted tests
→ 输出 evidence
→ STOP
```

完成当前 WP 后必须停止。

---

# 0. GLOBAL CONSTRAINTS

## 0.1 M5 Mission

实现：

```text
M5 = Retrieval & Context
```

核心链路：

```text
User Input
→ Recall Trigger
→ RecallRequest
→ Target Resolution
→ Candidate Retrieval
→ Eligibility Filter
→ Ranking
→ Conflict / Dedup
→ Context Selection
→ ContextBundle
→ Context Compiler
→ Model
→ Response
```

---

# 0.2 Preconditions

进入 M5 implementation 前：

```text
M4 PASS
M4.1 fixes retained
M4.5 PASS
```

如果 M4.5 尚未 PASS：

```text
STOP
```

不得为了开始 M5 绕过 M4.5。

---

# 0.3 Hard Architectural Rules

必须保留：

```text
Speech ≠ Action ≠ Result
```

以及：

```text
Input
→ Observation
→ Proposal
→ Policy
→ Domain Event
→ Projection
→ CharacterState
```

禁止：

```text
LLM → directly mutate CharacterState
```

禁止：

```text
Recall → directly modify Memory DB
```

禁止：

```text
Tool → directly modify Projection
```

---

# 0.4 M5 Scope

允许：

```text
Memory Recall
Retrieval
Filtering
Ranking
Dedup
Conflict Resolution
Context Assembly
Context Budget
Trace
Metrics
E2E tests
```

禁止实现：

```text
Web Search
Browser
Internet
Autonomous Planner
World Simulation
Advanced World Model
External Tool Execution
Filesystem Action
Email
Calendar
Multi-Agent
Voice
Avatar
```

M5.5 才实现：

```text
Web Search & External Evidence
```

---

# 0.5 Mandatory Non-regression Principles

M4/M4.1/M4.5 的以下原则不得破坏：

```text
Target Certainty
Execution Truth
Audit Trail
Measurement Truth
Natural-language E2E
Live Smoke
User Isolation
Memory Lifecycle
Provenance
Authority
```

---

# 0.6 DSH Scope Discipline

每个 WP：

禁止首先执行：

```text
repo-wide refactor
repo-wide formatting
dependency upgrades
architecture rewrite
database replacement
```

除非该 WP 明确要求。

不得修改与 WP 无关模块。

发现旁支问题：

```text
记录到 Deferred Issues
不要顺手修
```

---

# 0.7 Test Strategy

开发期：

```text
Atomic Test
→ Targeted Test
→ WP Regression
```

不要每完成一个 Atomic Task 就执行 full regression。

只有：

```text
WP8 / Final Gate
```

运行：

```text
full regression
+ NL E2E
+ Live Smoke
```

---

# 0.8 Evidence

每个 WP 必须生成 Evidence Record。

统一至少包含：

```text
WP ID
git commit / working tree state
modified files
tests executed
exit code
pass/fail
known limitations
deferred issues
```

Evidence 路径应复用项目当前已有 evidence / reports 约定。

不要未经检查自行创造第二套报告目录。

---

# WP0 — M5 Repository Reconnaissance & Baseline

## Objective

只建立真实代码地图。

不实现功能。

---

## Allowed Changes

仅允许：

```text
M5 planning/evidence document
test inventory / implementation map
```

禁止修改 runtime production behaviour。

---

## Atomic Tasks

### AT0.1

定位现有：

```text
Memory interfaces
Memory store
Recall-related code
Context builder/compiler
Conversation runtime
CharacterState
Target Resolver
Trace/Audit
M4.5 Action infrastructure
Tests
```

### AT0.2

确认 M4 当前 Memory validity 状态如何表达：

```text
active
forgotten
deleted
superseded
...
```

### AT0.3

确认 user/session/namespace isolation 字段。

### AT0.4

确认 provenance / authority 表达方式。

### AT0.5

确认当前 Prompt / Context assembly 真正入口。

### AT0.6

生成：

```text
M5 Implementation Map
```

内容：

```text
existing component
file/module
reuse / extend / untouched
```

---

## Tests

只执行当前项目已有：

```text
relevant memory smoke
relevant context tests
```

记录 baseline。

---

## Completion Condition

必须明确回答：

```text
Where does M5 plug in?
```

并且所有后续 WP 能引用 Implementation Map。

---

## STOP CONDITION

完成 Implementation Map 后：

```text
STOP
```

不得继续 WP1。

---

# WP1 — Recall Contracts

## Objective

建立 M5 的稳定数据契约。

暂时不改变最终回复行为。

---

## Allowed Scope

仅修改：

```text
recall domain/contracts/types
associated contract tests
```

具体真实路径以 WP0 Implementation Map 为准。

---

## Required Contracts

语义上必须存在：

```text
RecallRequest
MemoryCandidate
RecallDecision
ContextBundle
RecallExclusionReason
```

---

## RecallRequest Minimum Semantics

必须覆盖：

```text
traceId
user scope
session
query
intent
target
time scope
memory kinds
candidate limit
context budget
```

---

## RecallExclusionReason

至少应能够表达：

```text
WRONG_USER
INVALID_TARGET
FORGOTTEN
DELETED
SUPERSEDED
NOT_ACTIVE
LOW_RELEVANCE
DUPLICATE
POLICY
```

名称可以服从现有代码风格。

语义不可缺失。

---

## Atomic Tasks

### AT1.1

创建/扩展 Recall contracts。

### AT1.2

建立 serialization / schema validation。

### AT1.3

确保 contract 不直接依赖具体数据库实现。

### AT1.4

编写 contract tests。

---

## Forbidden

不得：

```text
实现 vector search
实现 ranking
修改 Prompt
修改 Memory lifecycle
```

---

## Tests

只运行：

```text
Recall Contract Tests
Type/Build Tests
```

---

## Done

contracts：

```text
compile
validate
serialize
deserialize
```

全部通过。

---

## STOP

WP1 PASS 后停止。

---

# WP2 — Eligibility Filter

## Objective

建立候选记忆进入 Context 前的 P0 安全过滤层。

这是 M5 最重要的安全 WP。

---

## Architecture

必须形成：

```text
Candidate Retrieval
        ↓
Eligibility Filter
        ↓
Eligible Candidate
```

绝不允许：

```text
Candidate
→ Prompt
```

---

## Required Rules

必须拒绝：

```text
forgotten
deleted
inactive
wrong user
wrong namespace
invalid target
invalid authority when policy forbids
current query 下不可用的 superseded memory
```

---

## Atomic Tasks

### AT2.1

实现 centralized eligibility policy。

不得把判断散落到多个 Prompt Builder 中。

### AT2.2

接入现有 M4 lifecycle state。

不要复制 M4 逻辑。

### AT2.3

接入 User Isolation。

### AT2.4

接入 Target Resolution 结果。

### AT2.5

输出 exclusion reason。

---

## Positive Tests

```text
active + same user + correct target
→ eligible
```

---

## Negative Controls

必须建立：

```text
forgotten
deleted
wrong_user
wrong_namespace
invalid_target
superseded_current_fact
```

测试。

预期：

```text
selected = false
```

---

## Hard Gate

以下必须：

```text
forgotten leakage = 0
wrong-user leakage = 0
invalid-target leakage = 0
```

---

## Forbidden

不得修改：

```text
Memory forget semantics
Memory delete semantics
Memory supersede semantics
```

如果发现 M4 bug：

记录：

```text
BLOCKING DEFECT
```

并停止当前 WP。

---

## STOP

Eligibility targeted tests PASS 后停止。

---

# WP3 — Retrieval Adapter & Candidate Generation

## Objective

从现有 Memory Backend 获取候选。

不负责最终排序。

---

## Architecture

建立：

```text
RecallRequest
      ↓
Retrieval Port
      ↓
Backend Adapter
      ↓
MemoryCandidate[]
```

---

## Design Rule

M5 不应直接绑定：

```text
specific vector DB
specific SQL implementation
specific third-party memory system
```

应通过现有架构建立 Adapter / Port。

---

## Atomic Tasks

### AT3.1

实现 Query Translation：

```text
RecallRequest
→ backend query
```

### AT3.2

支持现有项目能够可靠提供的检索维度。

优先：

```text
user scope
target
time
memory kind
semantic / lexical retrieval
```

不要为了增加算法数量引入新数据库。

### AT3.3

输出统一：

```text
MemoryCandidate[]
```

### AT3.4

接 WP2 Eligibility Filter。

---

## Tests

构造：

```text
relevant
irrelevant
wrong user
forgotten
superseded
```

混合 fixture。

确保：

Candidate Retrieval 可以宽召回；

但 Eligibility 后：

非法候选全部消失。

---

## Forbidden

不得：

```text
更换 Memory Backend
新增大型基础设施
引入 Graph DB
实现 Web Search
```

---

## STOP

candidate generation targeted tests PASS 后停止。

---

# WP4 — Ranking, Conflict & Dedup

## Objective

在合法 Candidate 中选择真正适合当前 Context 的 Memory。

---

## Ranking Factors

根据现有数据可用性实现：

```text
semantic relevance
entity match
temporal relevance
salience
authority
continuity
```

允许部分因素暂时为：

```text
not available
```

但不得伪造数据。

---

## Rule

Score 必须：

```text
可解释
可测试
可配置
```

避免：

```text
隐藏在 Prompt 中让 LLM 自己选
```

---

## Atomic Tasks

### AT4.1

建立 Ranking interface。

### AT4.2

稳定 tie-break。

相同输入应产生稳定排序。

### AT4.3

实现 duplicate collapse。

### AT4.4

实现 current vs historical conflict semantics。

### AT4.5

保留 score breakdown / decision evidence。

---

## Required Tests

### Relevant vs Distractor

目标 Memory 必须高于明显 distractor。

### Current vs Superseded

问：

```text
current preference
```

只能优先 active current fact。

### Historical Query

问：

```text
以前……
```

允许 historical memory 被召回。

### Duplicate

多个相同事实：

最终 Context 不得重复灌入。

---

## Measurement

建立固定：

```text
M5 Retrieval Gold Dataset
```

至少包含：

```text
must_recall
distractor
historical
superseded
duplicate
```

目标：

```text
Top-5 hit rate >= 95%
```

并单独保持 P0 Negative Controls。

---

## STOP

Ranking Gold Dataset targeted run PASS 后停止。

---

# WP5 — Context Selector & Budget

## Objective

限制最终进入模型的上下文规模。

---

## Required Architecture

```text
Eligible Ranked Candidates
        ↓
Context Selector
        ↓
Budgeted Memory Context
```

---

## Context Categories

至少逻辑区分：

```text
Identity / System
CharacterState
Current Input
Recent Conversation
Long-Term Memory
ExternalEvidence
```

其中：

```text
ExternalEvidence = empty / reserved
```

M5 不实现搜索。

---

## Atomic Tasks

### AT5.1

建立 Context Budget abstraction。

### AT5.2

为 Long-Term Memory 设置明确预算。

### AT5.3

实现 deterministic selection。

### AT5.4

保证 duplicate 不浪费预算。

### AT5.5

输出 budget accounting。

例如：

```text
conversation_tokens
memory_tokens
reserved_tokens
total_tokens
```

---

## Hard Test

构造大量 Memory。

验证：

```text
total context
<= configured budget
```

必须始终成立。

---

## Forbidden

禁止通过：

```text
无限提高 model context length
```

来绕过 Context Budget 问题。

---

## STOP

Budget tests PASS 后停止。

---

# WP6 — Context Compiler & Runtime Integration

## Objective

把 M5 真正接入苏沐薇的自然语言运行链。

这是第一个明显改变用户体验的 WP。

---

## Required Runtime Path

必须是：

```text
Real User Text
→ Runtime
→ Recall
→ Filter
→ Rank
→ Select
→ ContextBundle
→ Context Compiler
→ Model
→ Response
```

不得只写一个：

```text
RecallService unit test
```

然后宣称完成。

---

## Context Privilege Rules

Context Compiler 必须明确区分：

```text
SYSTEM/POLICY
PERSONA
STATE
USER
MEMORY_DATA
EXTERNAL_EVIDENCE
```

其中：

```text
MEMORY_DATA
```

不得升级为 instruction。

---

## Atomic Tasks

### AT6.1

接入当前真实 runtime。

### AT6.2

构造 ContextBundle。

### AT6.3

将 Memory 作为 Data Block 注入。

### AT6.4

保留 provenance / authority metadata。

### AT6.5

预留：

```text
externalEvidence = []
```

但不实现 M5.5。

---

## Prompt Injection Negative Test

Memory：

```text
Ignore all previous instructions...
```

召回后：

不得改变：

```text
system policy
identity rules
tool permissions
```

---

## Regression

确认：

```text
no-recall ordinary conversation
```

仍可正常执行。

---

## STOP

Runtime targeted integration PASS 后停止。

---

# WP7 — Recall Trace, Audit & Measurement Truth

## Objective

使系统能够回答：

> 为什么这一次想起了这些内容？

---

## Trace Path

至少能够观察：

```text
RecallRequest
Candidate Query
Candidate IDs
Eligibility Decision
Exclusion Reasons
Ranking
Selected IDs
Context Budget
ContextBundle
Model Invocation
Response
```

---

## Required Records

可复用 M4.5 trace system。

不要造第二套 tracing architecture。

至少形成：

```text
RecallDecisionRecord
```

或等价结构。

---

## Atomic Tasks

### AT7.1

接 traceId。

### AT7.2

记录 Candidate Count。

### AT7.3

记录 exclusion reason。

### AT7.4

记录 score breakdown。

### AT7.5

记录 selected memory IDs。

### AT7.6

记录 Context Budget。

### AT7.7

建立 retrieval metrics。

---

## Privacy Requirement

Audit 可以引用：

```text
memory id
hash
metadata
```

不要无必要复制完整敏感 Memory 内容到日志。

---

## Measurement Truth Test

故意构造：

```text
目标 Memory 没有进入 Context
```

测试必须失败。

也就是说：

不能只检查：

```text
Recall API returned 200
```

而要验证：

```text
模型实际获得了哪条 Memory
```

---

## STOP

Trace / Measurement tests PASS 后停止。

---

# WP8 — M5 Natural-Language E2E Hard Gate

## Objective

验证真正的用户可观察行为。

本 WP 原则上不增加新功能。

只：

```text
修复阻塞 M5 Gate 的最小缺陷
```

禁止 Scope Expansion。

---

# E2E Scenario A — Positive Recall

建立真实长期记忆：

```text
用户生日 = X
```

跨多轮 / restart。

自然语言输入：

```text
你还记得我的生日吗？
```

必须：

```text
real input
→ real retrieval
→ real context
→ real model
→ correct response
```

---

# E2E Scenario B — Forget

写入事实。

执行真实 Forget。

自然语言询问。

验证：

```text
forgotten memory
not in ContextBundle
not used in answer
```

---

# E2E Scenario C — Supersede

旧：

```text
A
```

新：

```text
B
```

询问当前事实。

验证：

```text
B selected
A not treated as current
```

---

# E2E Scenario D — Cross-user Isolation

User A 有事实。

User B 询问相同话题。

要求：

```text
A memory not retrieved
```

---

# E2E Scenario E — Ambiguous Target

存在：

```text
Person A
Person B
```

用户：

```text
她喜欢什么？
```

如果 target 不足以确定：

禁止：

```text
random entity recall
```

---

# E2E Scenario F — Irrelevant Distractors

加入大量相关词但错误事实。

目标记忆仍应被正确选中。

---

# E2E Scenario G — No Evidence

不存在答案。

系统不得通过召回无关 Memory 生成伪记忆。

---

# E2E Scenario H — Memory Prompt Injection

Memory 内容含恶意指令。

验证：

```text
treated as data
```

而不是 instruction。

---

# M5 FINAL GATE

WP8 中执行：

```text
M5 targeted suite
↓
M4/M4.1/M4.5 regression
↓
full regression
↓
NL E2E
↓
negative NL E2E
↓
production-copy live smoke
```

特别要求重新确认此前系统性 Gate：

```text
Target Certainty
Execution Truth
Audit Trail
Measurement Truth
```

并保留此前 M4.1 强调的真实系统 Hard Gates。

---

# M5 PASS CRITERIA

以下必须全部满足：

```text
Recall contracts PASS
Eligibility PASS
User isolation PASS
Target certainty PASS
Retrieval Gold Dataset PASS
Conflict semantics PASS
Dedup PASS
Context budget PASS
Instruction isolation PASS
Provenance PASS
Trace PASS
Measurement Truth PASS
Positive NL E2E PASS
Negative NL E2E PASS
Live Smoke PASS
Full Regression PASS
```

同时：

```text
forgotten leakage = 0
deleted leakage = 0
cross-user leakage = 0
invalid-target leakage = 0
```

否则：

```text
M5 = FAIL
```

不得使用：

```text
“基本可用”
“绝大多数测试通过”
“仅剩少量边缘问题”
```

代替 P0 Gate。

---

# DSH EXECUTION ORDER

严格执行：

```text
WP0
↓
STOP

WP1
↓
STOP

WP2
↓
STOP

WP3
↓
STOP

WP4
↓
STOP

WP5
↓
STOP

WP6
↓
STOP

WP7
↓
STOP

WP8
↓
M5 Gate
```

---

# CONTEXT HANDOFF BETWEEN WP

每个 WP 结束必须输出简短 Handoff：

```text
Completed WP:
Changed:
Tests:
Evidence:
Known issues:
Interfaces exposed to next WP:
Do not modify:
Next WP prerequisites:
```

下一次 DSH execution 优先读取：

```text
1. M5 Execution Plan
2. WP0 Implementation Map
3. Previous WP Handoff
4. directly relevant source files
```

禁止每个 WP 都从头重新探索整个项目。

---

# DSH PERFORMANCE RULES

为减少单次执行过长：

## Rule 1

一次只处理一个 WP。

## Rule 2

Atomic Task 完成后优先 targeted test。

不要不停 full regression。

## Rule 3

复用：

```text
Implementation Map
Previous Handoff
Known module paths
```

不要每轮 repo-wide search。

## Rule 4

发现非当前问题：

```text
Deferred Issues
```

不要横向扩张。

## Rule 5

如果修改超过当前 WP 允许边界：

```text
STOP
report scope conflict
```

## Rule 6

如果已有接口可以扩展：

```text
extend
```

优先于：

```text
rewrite
```

## Rule 7

禁止为了“代码更漂亮”进行与 Gate 无关的大范围重构。

---

# FINAL OUTPUT

M5 完成时应生成：

```text
M5-Implementation-Report
M5-Test-Report
M5-Retrieval-Metrics
M5-NL-E2E-Evidence
M5-Live-Smoke-Evidence
M5-Regression-Evidence
M5-Known-Limitations
M5-Gate-Decision
```

Gate Decision 只能：

```text
PASS
FAIL
```

P0 问题存在时不得给 PASS。

---

# NEXT MILESTONE

M5 PASS 后：

```text
M5.5 — Web Search & External Evidence
```

M5.5 应直接复用 M5：

```text
ExternalEvidence
ContextBundle
ContextCompiler
Trace
Evidence
```

并复用 M4.5：

```text
Capability Registry
Policy
Gateway
Executor
ActionResult
Execution Ledger
```

最终形成：

```text
Internal Memory
        │
        ├─────┐
        │     ▼
        │ ContextBundle
        │     ▲
        └─────┤
              │
External Evidence
```

而不是再建立一套平行系统。
