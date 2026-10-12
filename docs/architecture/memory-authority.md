# Memory 权威模型

> **这份文件回答**：一条记忆"是谁说的"怎么表达？为什么
> **她自己的输出**永远不能建立关于用户的长期事实？

- **相关 ADR**：ADR-029（她的输出不能建立用户事实）、ADR-020（记忆由证据派生）
- **不变量**：MI-02、MI-09、MI-14
- **守它的测试**：`m4:test`「反污染」（含**反向断言**）、`eval:m4` 的 `M4X-020/021/022`（注入型）、`M4X-050/051`（条件句 / 虚构）、`m4:test`「权威映射」

---

## 1. 一句话

> 权威**不是**声明出来的，是从**证据事件的来源**推导出来的。

写入路径不接受"这条是用户说的"这种输入 —— 那是**模型可以随便写的字符串**。
它要的是 `EvidenceRef[]`，然后从事件本身的 actor 推导出 `SourceKind → SourceAuthority`。

---

## 2. 两级枚举：来源类别 → 权威等级

### 来源类别（`SourceKind`，由 actor 唯一决定）

```text
user_statement       用户的陈述
character_output     她自己的输出
system_instruction   系统指令
tool_output          工具观测
```

`sourceKindForActor(actorType)` 是**函数**而不是查表 —— 每种 actor 唯一推导出一种来源，
没有"看情况"的余地。声明与 actor 不符时 `assertSourceConsistency()` 直接拒绝
（四个方向都测过）。

### 权威等级（`MemoryAuthority`，从高到低，**数组顺序就是权威顺序**）

```text
EXPLICIT_CORRECTION       用户明确纠正
EXPLICIT_USER_STATEMENT   用户明确陈述
DIRECT_INTERACTION        真实发生过（她与用户之间的互动）
TOOL_OBSERVATION          工具观测
CHARACTER_GENERATION      她生成的内容
MODEL_INFERENCE           模型推断
```

### 映射

```text
user_statement      → USER_EXPLICIT 或 USER_REPLY_CONFIRMATION
                      （后者只在用户**回复她生成的内容**时成立，由 reply graph 驱动）
character_output    → CHARACTER_GENERATION
system_instruction  → SYSTEM_INSTRUCTION（**不映射成任何 MemoryAuthority**，见 ADR-029）
tool_output         → TOOL_OBSERVATION
```

---

## 3. 结构性闸：谁有权建立用户事实

```text
person_fact / preference
  允许的 authority：EXPLICIT_USER_STATEMENT、EXPLICIT_CORRECTION
  其他一律抛错：authority_cannot_establish_person_fact
```

⚠️ 这条在**构造候选时**就抛（`createMemoryCandidate` → `assertMemoryAuthorityAllows`），
不是等到放行口、更不是等到落库。

**实测（`pnpm m4:audit`）**：脚本第一版把这一步写成"等放行口返回拒绝码"，
结果脚本自己**崩了** —— 而崩得对：它说明防线比预期更靠前。

这正是 ADR-029 / 计划书第 148 节要的：**污染不是"被拦住"，而是"造不出来"**。

---

## 4. 四种"看起来像事实但不是"的情况

| 情况 | 处置 | 由谁守 |
|---|---|---|
| 她的猜测（"我猜是 8 月 3 日"） | 建不了 `person_fact` | `m4:test` 反污染 + `M4X-020` |
| 她临时编的自述经历 | 建不了 `self_experience` | `m4:test` + `M4X-021` |
| 系统提示 / 插件上下文 | 不映射成任何权威 | `source-authority.ts`（ADR-029） |
| 工具观测说到"用户的事实" | 是 `tool_observation`，不是 `user_report` | `m4:test` 来源隔离（T8） |

**反向断言也在**：真实发生过的共同经历**可以**成为 `episode` /
`self_experience`（`DIRECT_INTERACTION` + `observed`）。
少了这条会得到一个"一律不记经历"的过度修正 ——
M4 的目标是"只记值得记的"，不是"什么都不记"。

---

## 5. 认知状态（`epistemicStatus`）与权威**不是**一回事

```text
reported   用户报的
observed   真实观测到的
inferred   推断出来的
generated  生成的
```

⚠️ **本枚举是四值，没有 `uncertain`。**
用户"记不太清"的陈述仍然是 `reported`（是用户报的），
不确定性的正确表达是**降 `confidence`** —— MI-09 由 **authority** 执行，
不由 `epistemicStatus` 执行。

这一点在 M4 验收时踩到过：给抽取评测用例写 `epistemicStatus: 'uncertain'`
会直接撞类型系统 —— 那说明"测试在测类型系统而不是系统"。

---

## 6. 用户明确陈述 > 模型推断

`authority` 的比较是**有序**的（`MEMORY_AUTHORITIES` 的数组顺序）。
计划书第 83 节：显式纠正的权威**高于**任何推断。因此：

```text
系统之前推测"用户可能喜欢咖啡"
用户后来说"我不喜欢咖啡"
→ 最终 Canonical State 必须以用户明确陈述为准
```

`assertMemoryAuthorityAllows` 与冲突分析器都读同一个顺序 ——
权威顺序只有**一个**定义处。

---

## 7. 已知限制

| 限制 | 说明 |
|---|---|
| `USER_REPLY_CONFIRMATION` 依赖 reply graph | 用户没有"回复她的内容"时，权威就只是 `USER_EXPLICIT`，不擅自升级（有正反两条断言） |
| 权威顺序是**数组约定** | 改动顺序等于改语义，必须同时改 ADR 与测试 |
| 污染探针是**第二道** | `contaminatedMemories()` 只覆盖 `person_fact` / `preference`；它防的是"有人绕过断言写了库"，不是主防线 |
