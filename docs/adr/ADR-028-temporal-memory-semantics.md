# ADR-028：记忆的时间语义（recordedAt / validFrom / validUntil）

- **状态**：已接受（M4）
- **日期**：2026-09-16
- **相关**：计划书第 30 – 34 / 71 / 132 节；ADR-019；MI-06 / MI-11
- **代码**：`src/kernel/contracts/memory.ts`（`MemoryRecord` 的时间字段）、
  迁移 0005 的 `memory_records`、`src/infrastructure/persistence/memory-store.ts`
  （`VALID_UNTIL_OPEN_SENTINEL`）

---

## 背景

ADR-019 在**事件**层引入了三个时间（`recordedAt` / `occurredAt` /
`logicalTime`），并明确"M4 不允许写 `logicalTime`"。

记忆层需要回答的是**另外**三个问题，它们不是事件时间的直接映射：

| 问题 | 需要的字段 |
|---|---|
| 系统**什么时候**知道这件事的？ | `recordedAt` |
| 这件事**从什么时候**开始成立？ | `validFrom` |
| 这件事**到什么时候**为止？ | `validUntil` |

它们**必然分家**：

```text
用户说"我从 2019 年就不吃香菜了"     validFrom = 2019，recordedAt = 现在
用户说"我现在能吃香菜了"             旧条 validUntil = 现在
一条记忆被标记为 DISPUTED            它仍然"有效"，只是存疑
```

一个真实踩到的类型缺陷说明了这里的复杂度：

> `valid_until` 一开始是 `bigint`，于是"仍有效"只能写 `NULL`。
> 而 `NULL` 与"不知道何时结束"无法区分。

这正是 ADR-019 里"不知道"与"就是现在"必须可区分那条原则
在记忆时间上的复用 —— 而它在记忆层**又出现了一次**。

---

## 决策

**记忆有三个时间字段，其中 `validUntil` 是三态而非两态。**

### 1. 三个字段，各有明确含义

```text
recordedAt   系统记下这条记忆的时刻（必有）
validFrom    这条记忆**从什么时候开始**成立（必有）
validUntil   这条记忆**到什么时候为止**（三态）
```

`recordedAt` 的口径是一个真实修过的缺陷：

> `recordedAt` 曾经取自**校验时刻**，于是 `recordedAt > createdAt`
> —— 一条记忆的记录时间晚于它的领域事件的创建时间。

这在单条上无害（差几毫秒），但它让"按 recordedAt 排序"
与"按事件顺序排序"不一致，而重放依赖后者。

修法：`applyCreated` 把 `recordedAt` / `createdAt` / `updatedAt`
**一律取 `event.createdAt`**。投影的字段必须从事件派生，
不能从"处理这条事件时的墙上时钟"派生 —— 否则重放不可复现。

### 2. `validUntil` 三态（用 text 列 + 哨兵）

```text
NULL        = 不知道何时结束（**未知**）
'none'      = 明确仍有效（**开放**）
'1700000000000' = 已结束，结束于该时刻（**数值字符串**）
```

`VALID_UNTIL_OPEN_SENTINEL = 'none'`。

| 为什么不用 NULL 表示"仍有效" | |
|---|---|
| `NULL` 的语义在 SQL 里是"未知" | 用它表示"已知仍有效"会让两种状态合并 |
| 合并之后 | "这条记忆的结束时间我们不知道"与"这条记忆还在生效"无法区分 |

**列类型是 `text` 而不是 `bigint`**：这是哨兵方案的直接后果，
而且它在迁移里被明确注释。ADR-019 已经记录过
"为了可表达的语义，宁可让列类型不那么自然"。

`describeValidity()`（`provenance.ts`）在展示层把三态渲染成
不同的文字，因此**人**也能区分 —— 否则三态只存在于数据里，
而读日志的人会以为它们一样。

### 3. `recordedAt` / `validFrom` 都必有，但含义不同

- `validFrom` 必有：一条"从什么时候开始成立"未知的记忆
  无法参与时间线（`buildSlotTimeline`）。
  流水线在 SUPERSEDE 时会显式推入 `proposedValidFrom: nowMs`。
- `recordedAt` 必有：它是审计的锚点。

### 4. 时间限定槽位在值闸里额外降权

`isTimeScopedPredicate()`（`TEMPORAL_MARKERS`）识别
"今天 / 这次 / 今晚"这类限定，配合
`TIME_SCOPED_DURABILITY = 0.2` 与 `TIME_SCOPED_PENALTY = 0.7`。

这是 ADR-025 决策 2 的另一半：**时间语义不仅影响存储，
也影响"值不值得记"**。一个"今天"的偏好不该获得与
"一直"的偏好相同的长期权重。

### 5. 时间线的表达由 `buildSlotTimeline()` 负责

同一个槽位的历史取值按时间排出：`unknown` / `open` / `ended`
三态在**展示**层也是可区分的。

`renderMemoryHistory()` 输出历史 + `Current:` 行 ——
"当前值"是从历史派生出来的，不是另存的一个字段。

---

## 被否决的备选方案

### 方案 A：`validUntil` 用 `bigint` + `NULL` 表示"仍有效"

**否决理由**：见决策 2。它是本 ADR 存在的直接原因 ——
实测中它导致类型错误，而在修类型之前，
它是**语义**问题：两种状态被合并了。

### 方案 B：`validUntil = 0` 或 `-1` 表示"仍有效"

**否决理由**：魔法值。而且它让"真的结束于 0 时刻"
（在测试里是合法值）变得不可表达 ——
一个不能用真实值表达的哨兵是隐蔽的错误源。

### 方案 C：不存 `validFrom`，用 `recordedAt` 代替

**否决理由**：见背景表格第一行。
"我从 2019 年就不吃香菜了"的 `validFrom` 是 2019，
而它被记下的时刻是现在。合并两者会让时间线全部偏到今天。

### 方案 D：不给时间限定槽位降权，靠 prompt 让模型别抽

**否决理由**：prompt 是概率的，值闸是确定的。
而且实测证明 prompt 在这件事上不可靠：
`lunch.today` 算出的 importance 是 0.783（远高于阈值 0.45）。

### 方案 E：`recordedAt` 用处理事件时的当前时间

**否决理由**：见决策 1。它会让重放不可复现 ——
同一批事件重放两次得到不同的 `recordedAt`，
而 `A == B` 闸会把这种差异报成"投影不一致"。实测踩到过。

### 方案 F：`logicalTime` 在记忆层也启用

**否决理由**：ADR-019 已决定 M3.5/M4 不允许写 `logicalTime`
（`simulation_time_not_supported`）。记忆层不提前打开它。

---

## 后果

### 正面

- "不知道何时结束"与"仍有效"在数据、契约、展示三层都可区分。
- 时间线（同一槽位的取值演变）可以从事件重建。
- 时间语义同时影响了值闸，因此"今天午饭"不会变成长期记忆。

### 代价

- `valid_until` 是 `text`，因此按时间范围查询需要
  `cast` 或在应用层过滤。当前规模下无影响（见
  `memory-invariants.md` §16.6 关于规模的假设）。
- 三个时间字段让 `MemoryRecord` 更宽。
  缓解：它们都是必有的语义，不是可选的元数据。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 三个时间字段落库并原样读回 | `m4:verify` §2 |
| `validUntil` 三态在展示层可区分 | `m4:test` 分组「Memory Admin CLI」 |
| `recordedAt` 取自事件而非处理时刻 | `m4:test` 分组「Reducer 元信息」+ `m4:verify` §8 |
| `A == B` 重放（时间字段参与比较） | `m4:verify` §8 |
| SUPERSEDE 时推入 `proposedValidFrom` | `m4:verify` §5 / §16 |
| 时间限定槽位被值闸降权 | `m4:test` 分组「Value Gate」 |
| 时间线三态可表达 | `m4:test` 分组「时间线（计划书第 132 节的 WP6 Gate）」 |
| 记忆层不写 `logicalTime` | `m3.5:test` FC-T06 + 记忆契约无该字段 |
