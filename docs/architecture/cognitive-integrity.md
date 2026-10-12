# Cognitive Integrity & Controlled Injection —— 认知完整性与受控信息注入原则

```text
状态      : **正式立案**（用户 2026-09-17 裁定）
层级      : **Sovereign Core Architecture Constraint**
            —— 基础设施可以替换；**认知完整性规则不能替换**（§20）
适用范围  : 所有能够**直接或间接**改变苏沐薇长期记忆、事实认知、主体认知、
            关系认知、世界状态判断及其他持久化认知状态的外部操作
配套      : 合规现状审计 → docs/m5.1.1/M5.1.1-Cognitive-Integrity-Gap-Audit.md
基础条件  : M5.1-D01（Actor Attribution）→ Cognitive Provenance → Cognitive Integrity（§21）
登记处    : docs/architecture/invariants.md（INV-CI-01 ~ 05）
```

> **本文的编辑约定**：§1–§22 与「Architecture Decision」为**用户原文**，
> **措辞逐字保留**；仅把标题层级下调一级以适配本文的 H1（原文的 `# 1.` 变为 `## 1.`）。
> 除此之外唯一的增补是末尾**附录 A/B/C**，且均明确标注为仓库侧增补，不与原文混排。

---

## 1. 核心原则

苏沐薇的认知状态不得被外部系统任意、静默、无来源地修改。

原则定义为：

> **No Cognitive State Without Provenance.**

即：

> 任何进入苏沐薇长期认知状态的信息，都必须能够追溯到合法来源、明确操作者、授权依据、证据或声明来源，以及一次可审计的认知状态转换。

同时：

> **任何绕过正常对话、感知、推理或既定 Memory Lifecycle 的外部认知注入，都应被视为高风险操作，而不是普通 CRUD。**

---

## 2. 权限不取消，但必须受控

系统可以保留：

* 开发者人工注入认知；
* 管理员纠正错误认知；
* 数据迁移；
* 批量知识导入；
* 灾难恢复；
* 人工修复损坏记忆；
* 测试环境认知构造；
* 未来其他必要的管理能力。

但这些能力：

> **不得默认开放、不得静默执行、不得与普通查询或普通编辑混为一谈。**

也就是说：

```text
保留能力
≠
允许任意执行
```

而是：

```text
Privileged Cognitive Operation
        ↓
Explicit Warning
        ↓
Review
        ↓
Authorization
        ↓
Execution
        ↓
Verification
        ↓
Audit
```

---

## 3. 禁止直接认知突变

默认禁止：

```text
Developer / Admin / Script / UI
        ↓
直接修改 memory_records
        ↓
苏沐薇突然“记得”
```

也禁止：

```text
直接 INSERT / UPDATE
↓
绕过 Memory Lifecycle
↓
绕过 provenance
↓
绕过 conflict / supersede / dispute
```

除非属于经过专门授权的：

```text
MAINTENANCE / REPAIR
```

并且该操作不得被解释成角色自己获得了一段经历。

---

## 4. 必须区分两类操作

### A. Cognitive Intervention

#### 认知干预

目标是：

> 改变苏沐薇“相信什么、记得什么、认为发生过什么”。

例如：

* 人工增加一条事实；
* 更正错误记忆；
* 导入新的角色经历；
* 把外部证据写入长期记忆；
* 修改人物关系认知。

这种操作必须经过完整的：

```text
Source
↓
Attribution
↓
Authority
↓
Evidence / Assertion
↓
Policy
↓
Memory Lifecycle
↓
State Transition
↓
Ledger
```

不得直接写最终状态。

---

### B. Maintenance / Repair

#### 维护与修复

目标是：

> 修复系统，而不是给角色制造新经历。

例如：

* schema migration；
* 数据损坏修复；
* orphan cleanup；
* backup restore；
* index rebuild；
* storage normalization。

这类操作可以在严格条件下修改底层数据。

但必须显式标记：

```text
MAINTENANCE
REPAIR
MIGRATION
RESTORE
```

并且：

> 不得让维护行为在角色认知中被解释为“我经历了这件事”或“某人告诉过我”。

---

## 5. 高风险操作必须强制警告

任何 Cognitive Intervention 在执行前，系统必须产生明确警告。

警告至少包含：

```text
你即将直接改变苏沐薇的持久化认知状态。

该操作可能影响：
- 后续 Recall
- 角色行为
- 对历史事件的理解
- 冲突解决
- 长期关系状态
- 后续推理结果

该操作将被永久记录在审计账本中。
```

不得：

```text
点一下 Save
→ 静默修改
```

---

## 6. 必须执行显式确认

高风险认知操作必须：

```text
Prepare
↓
Preview
↓
Warn
↓
Explicit Confirm
↓
Execute
```

至少支持：

```text
dryRun
```

或：

```text
preview
```

让操作者在真正执行前看到：

* 将增加什么；
* 将修改什么；
* 将 supersede 什么；
* 将产生哪些冲突；
* 哪些记忆会受影响；
* Recall 行为可能如何变化。

---

## 7. 必须记录操作者身份

每次认知干预至少必须记录：

```text
operationId
requestedBy
initiator
authorizedBy
executionTime
source
reason
affectedMemoryIds
result
verification
```

如果由 Developer Console 发起：

不得只记录：

```text
actor = 苏沐薇
```

必须能够证明：

> 这是开发者干预，而不是角色自主形成的认知。

---

## 8. 必须保留来源类型

建议认知来源至少区分：

```text
USER_STATEMENT
CHARACTER_EXPERIENCE
CHARACTER_INFERENCE
SYSTEM_DERIVED
TOOL_RESULT
EXTERNAL_EVIDENCE
DEVELOPER_INJECTION
ADMIN_CORRECTION
IMPORT
MIGRATION
LEGACY_UNKNOWN
```

其中：

```text
DEVELOPER_INJECTION
ADMIN_CORRECTION
```

不得伪装成：

```text
USER_STATEMENT
```

---

## 9. 禁止伪造经历

这是本原则的 Hard Invariant。

例如开发者注入：

```text
苏沐薇曾经在北京生活三年
```

不能在账本里记录成：

```text
source = CHARACTER_EXPERIENCE
```

除非系统确实拥有对应历史证据。

正确方式必须表达：

```text
source = DEVELOPER_INJECTION
assertion = "苏沐薇曾经在北京生活三年"
```

然后根据系统规则：

```text
accepted
rejected
disputed
unverified
```

而不是伪造历史。

---

## 10. 注入不等于真相

外部拥有修改权限的人也不能自动成为 Reality Authority。

因此：

```text
Developer says X
```

不能天然等价于：

```text
X = TRUE
```

系统需要能够表达：

```text
ASSERTED
VERIFIED
UNVERIFIED
DISPUTED
SUPERSEDED
REJECTED
```

未来如果存在 Evidence / Reality Model，应允许继续验证该认知。

---

## 11. 冲突必须经过正常生命周期

新注入的信息与旧认知冲突时：

禁止：

```text
DELETE old
INSERT new
```

应经过：

```text
Conflict Detection
↓
Policy
↓
Supersede / Dispute / Correction
↓
Ledger
```

必须保留：

> 过去她曾经相信什么。

而不是只保留：

> 现在数据库里剩什么。

---

## 12. 认知操作必须可回滚，但不能抹掉历史

系统可以提供：

```text
revert cognitive intervention
```

但 revert 应产生新的事件：

```text
INJECTION_APPLIED
↓
INJECTION_REVERTED
```

而不是：

```text
DELETE HISTORY
```

即：

> 可以撤销认知影响，但不能擦除曾经发生过认知干预这一事实。

---

## 13. 必须提供 Execution Truth

系统必须区分：

```text
requested
authorized
accepted
attempted
applied
verified
rejected
rolled_back
```

禁止：

```text
请求提交成功
==
认知已经修改成功
```

也禁止：

```text
DB UPDATE 成功
==
认知生命周期正确完成
```

---

## 14. 必须具备 Verification

操作完成后必须验证至少：

* Memory 状态符合预期；
* Ledger 已记录；
* provenance 正确；
* attribution 正确；
* conflict 状态正确；
* Recall 行为符合预期；
* 未污染其他用户/主体；
* replay 后状态一致。

只有验证通过：

```text
verified = true
```

---

## 15. Developer Console 的强制约束

未来 Developer Console 如果提供：

```text
Add Memory
Edit Memory
Correct Belief
Import Knowledge
```

不得设计成普通表单 CRUD。

必须表现为：

```text
Cognitive Intervention
```

界面至少展示：

```text
HIGH-RISK OPERATION
```

并要求：

```text
Reason
Source
Target
Preview
Confirm
```

必要时可以要求二次确认。

---

## 16. 自动系统同样受约束

该原则不只约束人类管理员。

以下来源同样不能直接写认知：

* Web Search；
* RAG；
* Agent Tool；
* MCP；
* 自动总结；
* LLM background process；
* Knowledge Graph；
* 外部数据库；
* 第三方 Agent；
* Workflow Engine。

它们只能提交：

```text
evidence
assertion
observation
proposal
```

不能自行宣布：

```text
final cognitive truth
```

---

## 17. Emergency / Break-Glass

系统可以保留最高权限：

```text
BREAK_GLASS_COGNITIVE_OVERRIDE
```

用于极端情况。

但必须满足：

1. 默认关闭；
2. 明确高危警告；
3. 需要显式理由；
4. 强制记录操作者；
5. 强制产生审计事件；
6. 不允许关闭审计；
7. 不允许伪造来源；
8. 执行后强制运行 integrity check；
9. 必须可以识别出这是 break-glass 操作。

Break-glass 的含义是：

> 允许绕过正常决策流程。

不是：

> 允许绕过真实性记录。

---

## 18. Hard Gate

新增：

### Cognitive Integrity Gate

必须保证：

#### CI-1

不存在无 provenance 的长期认知。

#### CI-2

Developer Injection 不会被记录成 User Statement。

#### CI-3

Maintenance 不会被解释成 Character Experience。

#### CI-4

所有高危认知修改均有 warning + confirmation。

#### CI-5

所有操作拥有完整 attribution。

#### CI-6

操作结果区分 requested / applied / verified。

#### CI-7

冲突不通过 silent overwrite 解决。

#### CI-8

rollback 不删除历史。

#### CI-9

非法直接写路径必须 fail closed。

#### CI-10

故意绕过 provenance 时，测试必须失败。

---

## 19. Negative Control

必须主动建立以下破坏性测试：

```text
直接 INSERT memory
→ Gate FAIL

Developer Injection 标成 USER
→ Gate FAIL

无 provenance memory
→ Gate FAIL

无 operator identity
→ Gate FAIL

Maintenance 被 Recall 成角色经历
→ Gate FAIL

删除 intervention event
→ Integrity FAIL

绕过 Lifecycle 修改 active memory
→ Gate FAIL
```

即：

> 测试不仅要证明合法操作能工作，还必须证明非法路径真的会被抓住。

---

## 20. 与主权核心的关系

本原则属于：

```text
Sovereign Core Architecture Constraint
```

不得被以下组件绕过：

```text
Developer Console
CLI
Admin API
Plugin
MCP
Tool
Workflow
Database
Third-party Memory Backend
Observability Backend
```

基础设施可以替换。

**认知完整性规则不能替换。**

---

## 21. 与 M5.1-D01 的关系

M5.1-D01 解决：

> “是谁做的？”

本原则进一步解决：

> “是谁把什么信息，以什么权限、基于什么来源，通过什么过程，变成了她的认知？”

因此两者关系为：

```text
Actor Attribution
        ↓
Cognitive Provenance
        ↓
Cognitive Integrity
```

M5.1-D01 是本原则成立的重要基础条件之一。

---

## 22. 最终架构不变量

正式冻结以下五条：

### INV-CI-01

> No Cognitive State Without Provenance.

### INV-CI-02

> External Access Does Not Imply Cognitive Authority.

### INV-CI-03

> Maintenance Must Never Masquerade as Experience.

### INV-CI-04

> Cognitive Intervention Must Be Explicit, Warned, Authorized, Audited and Verifiable.

### INV-CI-05

> Cognitive History May Be Corrected, But Must Not Be Falsified.

---

## Architecture Decision

今后任何功能如果：

```text
能够改变苏沐薇长期认知
```

则默认被归类为：

```text
Privileged Cognitive Operation
```

必须经过 Cognitive Integrity 审查。

不得因为：

```text
“只是开发者工具”
“只是数据库管理”
“只是导入数据”
“只是临时测试”
```

而获得例外。

---
---

# 附录（仓库侧增补，**不属用户原文**）

## 附录 A · 这份原则不是新领土：它与既有不变量的谱系关系

立案前做的合规侦察发现：本原则的**大部分内容已经在既有不变量里有了根**。
这决定了落地方式——不是新建一套并行纪律，而是**把既有谱系推广到"外部注入"这一情形**。

| 本原则条款 | 对应的既有不变量 | 关系 |
|---|---|---|
| §3 §9 §16（不得绕过 Lifecycle 直接写认知） | `#4 Proposal ≠ Fact` | **推广**：从"LLM 的提案不等于事实"推广到"任何外部主体" |
| §9 §10（注入不得伪装成经历/真相） | `#6 Assistant 的输出不会自动变成外部事实` | **同源**：防火墙的对象从"她自己的输出"扩展到"外部注入" |
| §7 §8（操作者与来源类型必须记录） | `#16 来源必须结构化，不能塞进自由字典` | **同源 + 扩展**：需要更细的来源分类（见 U-16） |
| §8 §10（DEVELOPER_INJECTION 不得取得用户陈述资格） | `#17 权威等级是白名单` | **同源**：新来源默认**不**在白名单内 |
| §10 §14（注入 ≠ 真相；需要 ASSERTED/VERIFIED 等状态） | `#26 真实世界事实与角色认知必须可以分别存在` | **同源**：这是 §10 的既有根 |
| §13 §14（requested ≠ applied ≠ verified） | `M4.5 的 Execution Truth`（五档阶梯 + `verification` 四态） | **直接复用**：形状已经存在，见附录 C |
| §11 §12（冲突走生命周期、rollback 不删历史） | `Memory Kernel`（证据推导权威、旧事实不物理覆盖） | **已实现**：见审计报告 |

**结论**：本原则新增的是**"外部注入面"**这一情形，而不是新的认知语义。

## 附录 B · 落地位置与登记

```text
权威源（本文）      docs/architecture/cognitive-integrity.md
不变量登记          docs/architecture/invariants.md → INV-CI-01 ~ 05
合规现状审计        docs/m5.1.1/M5.1.1-Cognitive-Integrity-Gap-Audit.md
待裁定事项          docs/m5.1.1/M5.1.1-Unresolved-Decisions.md（U-16 ~ U-19）
agent 入口          AGENTS.md §4（"能改变长期认知的功能 = Privileged Cognitive Operation"）
```

**追加登记（2026-09-22，仓库侧）**：`M6-FMB-01` —— **假记忆边界**立案
（`docs/m6/M6-False-Memory-Boundary-Register.md`）。
来源：M6 / WP9b 在 500 轮正式轨迹里实测到"她多次把**没有依据的记忆**补成具体细节"（§9 禁止伪造经历的实测形态）；
同期自动探测器**判错**并已标 `INVALID`。归属**后续人格 / 认知主线**的优先修复项，
硬顺序 = **判定契约 → 量具有效性验证 → 才决定机器门与实现方案**（不许跳步）。

**层级说明**：本文是 **Sovereign Core 约束**，效力高于任何组件级设计。
凡与其冲突的组件设计（Developer Console / CLI / Admin API / Plugin / MCP / Tool /
Workflow / Database / 第三方记忆后端 / 观测后端）**以本文为准**（§20）。

## 附录 C · 一个必须点明的既有形状复用（Execution Truth）

§13 要求区分
`requested / authorized / accepted / attempted / applied / verified / rejected / rolled_back`。
本仓库**已经有一套同构的阶梯**（M4.5 / M5.1 AT3.6）：

```text
rejected / accepted / attempted / executed / verified
verification : verified | failed | not_attempted | not_applicable  ← **四态枚举，不是布尔**
```

**落地时必须复用这套形状，而不是发明第二套阶梯**（否则会出现"两套执行真相"，
这正是本仓库反复禁止的"一个概念两处实现"）。
差异只在术语：`applied` 对应既有的 `executed`。⚖️ 术语归并见 U-19 的相邻事项。

## 附录 D · 明确的边界（本轮**不**做什么）

```text
✗ 本轮只做**立案与登记**，不实现任何 Cognitive Integrity 门的代码
✗ 不新增任何注入入口（现在也没有）
✗ 不改 Memory Kernel / Memory Lifecycle / Event Ledger
✗ 不动 M5.1（已冻结）的实现、验收结论或标签
✗ M5.1-D01 保持 P1 · OPEN
```

实现归属：**M5.1.1**（若审查认为需要独立里程碑，则单列 M5.1.2）。
