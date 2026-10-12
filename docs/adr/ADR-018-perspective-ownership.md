# ADR-018：Perspective Ownership —— 认知必须属于某个视角

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 25 / 26 / 27 / 28 / 51 / 103 – 105 节
- **代码**：`src/kernel/contracts/entity.ts`（`PerspectiveOwnerId` / `EntityRelationKey`）
- **由谁实现**：M7（Relationship）/ M9（Belief）/ M4（Memory）

---

## 背景

计划书第 51 节给了一个必须能成立的三元组：

```text
World:      箱子里有钥匙      ← 世界真相
苏沐薇:      没看到
Character B: 看到了
```

三件事要**同时成立**：

```text
WORLD truth
B knows
SuMuWei doesn't know
```

如果"她知道 X"这个事实在数据上没有"谁的认知"这一维，
那么这三个陈述里最多只能存下两个 —— 而通常会发生的是：
后写的那条覆盖先写的那条，或者三条混成一条语义不清的记录。

计划书第 25 节给的答案很直接：

> 未来所有 Belief / Knowledge / Perspective 必须拥有 `perspectiveOwnerId: EntityId`。

---

## 决策

**M3.5 只定义契约约定，不实现任何 store。**

### 1. 类型别名

```ts
type PerspectiveOwnerId = EntityId
```

### 2. 关系键的形状

```ts
interface EntityRelationKey { owner: EntityId; target: EntityId }
```

计划书第 27 节明确：M7 不允许

```ts
RelationshipState { userTrust: number }        // ❌ 把 user 写死
```

必须是：

```text
relationship owner → target entity
```

### 3. 写进约束表，交给正确的阶段实现

| 阶段 | 必须带什么 |
|---|---|
| M4 Memory | `owner` / `subject` / `source entity` / `source observation 或 event` |
| M7 Relationship | `owner → target`（`EntityRelationKey`） |
| M8 Affect | 属于 Character（不属 Conversation） |
| M9 Belief | `perspectiveOwnerId` |
| M10 Goal | `targetEntity?` / `contextRef?` |

见 [`../architecture/future-compatibility.md`](../architecture/future-compatibility.md) §8。

### 4. M3.5 **不**实现 Belief store

`m3.5:test` FC-T05 会断言 `src/kernel/contracts/` 下不存在任何 `belief` 文件 ——
防止有人"顺手"把 M9 的东西提前做了。
提前做会带来两个问题：① 没有 M4 Memory 作为地基，② 会让"M9 还没开始"这件事
在代码里看不出边界。

### 5. Observation 带来的一半

`Observation` 本身已经带了 `characterId`（谁的感知）与 `source`（从哪来），
因此 ADR-014 已经为 perspective 提供了**输入侧**的一半：
「她感知到了什么」天然属于某个角色。

而"她**相信**什么"（Belief）与"世界**是**什么"（World truth）
是另外两样东西，属于 M9。

---

## 被否决的备选方案

### 方案 A：现在就建一张 `beliefs` 表（带 `perspective_owner_id`）

**否决理由**：
① 计划书第 25 节说的是"修改相关 contract 设计约定"，不是"实现 Belief"；
② 没有 M4 的 Memory 作为地基，Belief 的来源链（evidence → belief）无法建立；
③ 一张空表会产生"它该有什么列"的设计压力，而那个设计的输入今天不存在。

### 方案 B：把 `perspectiveOwnerId` 设计成可选

**否决理由**：可选等于"可以没有视角"，而"没有视角的认知"是不成立的 ——
它只能意味着"我们忘了写"。M9 的正式 schema 里它必须是**必填**。

M3.5 只是不实现它，但约束表里明确写了"必须存在"。

### 方案 C：用一个 `user` 维度代替 `perspectiveOwnerId`

**否决理由**：这正是计划书第 27 节要阻止的形状。
"苏沐薇 → 用户"只是 `owner → target` 的一个特例；
把它硬编码成"user"之后，"苏沐薇 → 角色 B"就写不出来 ——
而明天加入第二个角色是最可能发生的事（第 108 节问题一）。

### 方案 D：把世界真相也塞进同一个认知表（只加一个 `isTruth` 标记）

**否决理由**：这就是 ADR-017 要阻止的事。
"世界真相"不属于任何视角，因此它**不能**待在"带 perspectiveOwner 的表"里 ——
否则每一行都要回答"这个 owner 是谁"，而真相没有 owner。
真相属于 World（未来才建），认知属于角色，两者是两张表。

---

## 后果

### 正面

- 未来多角色世界里的"不同角色知道不同的事"在数据模型上天然成立。
- M7 / M9 的第一版 schema 只能照着这个形状写，不需要回头改基础结构。
- 成本是零（两个类型别名 + 一段文档）。

### 代价

- 这条约束今天**没有运行时执行力**（没有 store 可以校验它）。
  缓解：由文档 + ADR + 阶段验收（M7/M9 开工时逐条核对约束表）保证。
  这是刻意的取舍 —— 用运行时约束去守一个还不存在的表，只能靠造那张表，
  而那正是本 ADR 否决的方案 A。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 两个角色可作为不同 `perspectiveOwner` 被区分 | `m3.5:test` FC-T05 |
| `EntityRelationKey` 的形状是 `owner → target` | FC-T05 / FC-T01 |
| M3.5 未实现 Belief store | FC-T05（无 `belief` 文件） |
| `EntityRef` 支持"角色 → 非角色实体"（如 object） | FC-T01 / FC-T05 |
| M4–M11 的约束已写进未来约束表 | `future-compatibility.md` §8 + review |
