# ADR-021：Memory 的 Owner 与 Subject 是两个维度

- **状态**：已接受（M4）
- **日期**：2026-09-16
- **相关**：计划书第 8 / 153 节；MI-04 / MI-05
- **代码**：`src/kernel/contracts/memory.ts`（`MemoryRecord.owner` / `subject`）、
  `src/kernel/policies/memory-validator.ts`（owner 闸）、
  `src/kernel/app/memory/extractor.ts`（`subjectToken`）

---

## 背景

"这条记忆属于谁"和"这条记忆关于谁"看起来常常是同一个答案 ——
在当前的场景里确实如此：苏沐薇记住了关于用户的一件事。

正因为它们**当前**总是相同，最省事的做法是不区分，或者
让 subject 默认成 owner。这个决定在第一个真实需求出现时就会崩：

| 场景 | owner | subject |
|---|---|---|
| 用户说"我不吃香菜" | 苏沐薇 | 用户 |
| 她说"我小时候住在海边" | 苏沐薇 | 苏沐薇 |
| 用户说"我妹妹学医" | 苏沐薇 | 用户的妹妹 |
| 未来：另一个角色说"我怕黑" | 该角色 | 该角色 |

四个场景里 owner 永远是她，subject 有四种。

计划书第 153 节要求 M4 与 M3.5 的 Entity 模型对齐 ——
而"subject 默认写死为 User"恰好是对齐的反面。

---

## 决策

**Owner 与 Subject 是独立的两个字段，Subject 没有默认值。**

### 1. Owner 必须是她，且写入时校验

`owner` 是"这条记忆存在于谁的记忆里"。M4 是**角色记忆**系统，
不是通用知识库，因此：

```text
owner 必须是 character，否则失败关闭
```

一旦允许无主的记忆进入，"她记住了"和"系统存了一条"就再也分不开。

### 2. Subject 用 `EntityRef`，不用字符串

`subject` 是 `EntityRef`（类型 + id），与 M3.5 的通用实体引用一致。
这带来两件事：

- 未来多主体（另一个角色、一个组织）不需要改 schema；
- "关于谁"与"谁说的"可以指着同一个实体而**仍然是两个字段**。

### 3. 抽取器只允许 `subjectToken: 'USER' | 'CHARACTER'`

模型能表达的 subject 是**封闭的两值**，且是抽象的 token，
不是具体名字或 id：

> `subjectToken` 用 USER / CHARACTER，不要写具体名字或 id。
> —— 抽取 prompt 第 5 条

理由：让模型写具体 id 会把"她猜的是谁"变成一个不可校验的字符串。
token 由系统映射到 `EntityRef`，映射关系在**代码**里，不在模型输出里。

### 4. 主观经历的记忆不因"她也参与"就变成用户事实

共同经历（`episode`）的 subject 是**共同**的参与者集合，
而不是"默认 USER + 顺带提一下 CHARACTER"。

`Episode.participantTokens` 是显式的参与者列表。
实测的反例：一段"我们一起把问题啃下来了"被抽成
`person_fact: project.background.active`（subject = USER）——
那既丢了 episode 的类型，也把共同经历单向归给了用户。

---

## 被否决的备选方案

### 方案 A：不区分 owner 与 subject，只有一个 `who`

**否决理由**：四场景表格里它当场崩。而且崩的方式很隐蔽 ——
"我妹妹学医"会被记成"用户学医"。
**字段名相同会让人以为它们是同一件事**，而它们不是。

### 方案 B：Subject 默认成 Owner

**否决理由**：这是"默认值灾难"的标准形状。当前的调用方
100% 都会显式传，因此默认值不会带来任何便利；
但它会让**忘传**这个错误静默通过 —— 而忘传的那一处，
恰恰最可能是"关于她的自我认知"或"关于第三方"。

误设的 subject 无法回溯修正：历史数据里
"当时真的是 user"与"当时是默认值"不可区分。

### 方案 C：Subject 用自由文本

**否决理由**：无法与未来的实体表关联，也无法做"关于同一主体"的查询 ——
而多主体聚合（"关于他的一切"）是 M4 之后一定会要的能力。

### 方案 D：让模型输出具体的实体 id

**否决理由**：见决策 3。模型不该知道、也不该能编造内部 id。

---

## 后果

### 正面

- 多主体到来时不需要迁移历史数据。
- "关于谁"与"谁说的"在类型上就是两件事，不会被合并。
- 自我认知（她的偏好、她的经历）不会被记到用户名下。

### 代价

- 每条记忆多一次 `EntityRef` 解析与校验。
- 抽取 prompt 需要交代 subjectToken 的用法（一条规则）。
  实测这条交代是必要的：见 ADR-022 关于 `episode` 与 `person_fact`
  被混淆的记录。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| owner 非 character → 失败关闭 | `m4:test` 分组「候选 → 记录」 |
| Claim 的 subject 与 memoryType 一致 | `m4:test` 分组「Claim 的 subject 一致性」 |
| Episode 的参与者列表合法 | `m4:test` 分组「Episode 结构」 |
| 多主体 / 未来实体可表达 | `m4:verify` §12 |
| 共同经历不被抽成用户事实 | `M4X-005`（`mustIncludeTypes`）+ `eval:m4` M4-011 |
| 她的自我经历不被记成历史正史 | `eval:m4` M4-010 |
| 限定条件不同 = 两个槽位，不合并 | `eval:m4` M4-012 |
