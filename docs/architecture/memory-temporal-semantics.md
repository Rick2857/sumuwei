# Memory 时间语义

> **这份文件回答**：一条记忆涉及**几个时间**？"当前有效"怎么表达？
> 为什么 `validUntil` 需要**三态**而不是两态？

- **相关 ADR**：ADR-028（记忆的时间语义）、ADR-023（supersede 而非覆盖）
- **相关**：[`temporal-model.md`](./temporal-model.md)（M3.5 的通用时间模型）
- **守它的测试**：`m4:test`「时间语义（validFrom/validUntil/recordedAt）」「时间线」、`m4:verify` §5、`m4:audit`（四态语料）

---

## 1. 四个时间，各回答一个问题

| 字段 | 问题 | 谁决定 |
|---|---|---|
| `occurredAt` | 这件事**什么时候发生**的 | payload（可能不精确） |
| `recordedAt` | 系统**什么时候记下**它的 | **事件的 `createdAt`**，不是校验时刻 |
| `validFrom` | 从什么时候起有效 | payload |
| `validUntil` | 到什么时候为止有效 | SUPERSEDE 写它；RETRACT **不**写 |

⚠️ `recordedAt` 曾经取"校验时刻"，于是同一行里出现 `recordedAt > createdAt`，
自相矛盾，而且**重放永不报错**（两边都这么算）。现在 `applyCreated` 一律取
`event.createdAt` —— 计划书第 37 节把 `recordedAt` 定义为"系统什么时候创建这条 Memory"，
那正是事件被写入的时刻。

---

## 2. `validUntil` 必须是**三态**

契约刻意区分：

```text
undefined —— 不知道 / 不适用
null      —— **明确地"没有终点"**（当前有效，且预期继续有效）
number    —— 失效于这个时刻
```

若把 `null` 与 `undefined` 都写成 SQL 的 NULL，那么：

- `MEMORY_RESTORED` 之后"应该没有终点"与"压根不知道"在数据上**同形**，
  reducer 无法判断该不该清 `validUntil`；
- 重放一条被 restore 过的记忆会得到与首次写入**不同的**结果 ——
  而 `A == B` 是 M4 的 Gate。

因此 SQL 列是 **text**，承载三态：

```text
NULL      ← undefined（不知道）
'none'    ← null（没有终点）
'1756...' ← number（那个时刻）
```

用 `'none'` 而**不是** `''` 或 `'-'`：它必须一眼可读，
且必须不可能与真实时间戳的字符串形式混淆（真实值是纯数字串）。

⚠️ 第一版这里写成 `bigint` + 字符串哨兵，插入时直接类型报错。
改成 text 不是权宜，而是"契约里有两个非时间值"的必然对应物。

---

## 3. 三种"推翻"对时间字段的**不同**处置

| 事件 | `validUntil` | 为什么 |
|---|---|---|
| `MEMORY_SUPERSEDED` | **写入**（失效时刻） | 它说"这条到这时为止还成立" |
| `MEMORY_RETRACTED` | **不动** | 它没说"这条失效了"，它说"这条不该有" |
| `MEMORY_DISPUTED` | **不动** | 它还判不了哪边成立 |
| `MEMORY_RESTORED` | **清掉**（回到 `null`） | 回到"没有终点"，不再自相矛盾 |

三条断言都在 `m4:verify` §5，逐条守着这条区分。

---

## 4. Current Truth：不是删历史

```text
过去事实：  去年住在北京        （superseded，历史保留）
当前事实：  现在住在西安        （active）
```

「当前状态」是一个**视图**，不是"只留一条"。
任何"把旧条删掉"的实现都会丢掉"她曾经住在北京"，
而那正是角色连续性的来源。

`renderMemoryHistory()` 渲染这个视图，`Current:` 那行是**推导**出来的：

```text
2026-09-01  北京   [superseded]
2026-09-16  西安   [active]  ← Current
Current: 西安
```

若当前没有有效记忆（全被取代/撤回/存疑），它会**如实写出来**，
而不是留空 —— 留空会被读成"没有这个槽位"。

---

## 5. 时间限定与值闸

一次性状态（"今天午饭吃了面"）**不该**成为长期记忆。
值闸里有一条**时间限定降权**：带时间限定的槽位 importance 乘
`0.2 + 0.7 × 惩罚`。

实测：`lunch.today` 曾以 **0.783** 通过放行口 → 被永久记住。
降权之后它落到了 0.45 的阈值之下。

---

## 6. 已知限制

| 限制 | 说明 |
|---|---|
| 不做时间区间推理 | `validFrom` / `validUntil` 是**存下来的**，不是被推理出来的 |
| 时间比较在应用层做 | SQL 列只负责无歧义地存下三态 |
| "一段时间内多次发生"没有专门类型 | 用 `episode` + `occurredAt`（M4 不建时间图谱） |
