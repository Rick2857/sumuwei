# ADR-019：可扩展的时间模型（recordedAt / occurredAt / logicalTime）

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 29 – 34 / 52 / 71 / 83 节
- **代码**：`src/kernel/contracts/time.ts`、迁移 0004

---

## 背景

当前事件只有一个时间：`createdAt`。

它今天够用，因为当前一直是同一个东西：

```text
她刚刚说了这句话 → 记下来的时刻 ≈ 这句话说出的时刻
```

但"发生"与"记录"在下面这些情况下**必然分家**，而且**未来一定会发生**：

```text
导入一段旧对话        occurredAt = 2019-03-02，recordedAt = 2026-09-16
她说"我等了你三天"    occurredAt = 故事里的三天前，recordedAt = 现在
存在模拟时钟          logicalTime = "第 12 天清晨"
```

计划书第 33 节给出了现在的做法：

> 因为未来很多已有数据（Memory / DomainEvent / ConversationEvent）
> 可能都已经存了大量 timestamp，到那时再拆：
> 发生时间 / 记录时间 / 模拟时间，**迁移成本很高**。
> 现在增加 nullable 字段非常便宜。

---

## 决策

**引入 `EventTime` 契约 + 迁移 0004 的四个 nullable 列；
不改名任何既有列；M3.5 不允许写入 `logicalTime`。**

### 1. 契约形状

```ts
interface EventTime {
  recordedAt: Timestamp      // 必有
  occurredAt?: Timestamp     // 可空 == "不知道"（不是"就是现在"）
  logicalTime?: string       // 可空；M3.5 必须留空
}
```

**映射（刻意不改名）**：

```text
EventTime.recordedAt ≡ 既有 createdAt ≡ 数据库列 created_at
```

计划书第 83 节禁止大改 schema，因此 `created_at` 这个列名**一个字都没动**。
`recordedAt` 只存在于契约命名里。

### 2. 迁移 0004：四个 nullable 列

| 表 | 列 |
|---|---|
| `conversation_events` | `occurred_at bigint` / `logical_time text` |
| `character_domain_events` | `occurred_at bigint` / `logical_time text` |

全部 `add column if not exists`，全部 nullable，**不回填历史行**。
`select *` + `NULL → undefined` 映射，因此旧行照常可读。

### 3. 两条刻意的不默认

**（甲）不把 `occurredAt` 默认成 `createdAt`。**

"不知道它什么时候发生"与"它就是此刻发生的"是两件不同的事。
用后者冒充前者，会让未来的导入逻辑无法分辨哪些行需要补时间 ——
而那种错误一旦写进 append-only 的表里就再也修不回来。

需要"二者相等"语义的调用方**显式传**同一个值。

**（乙）不建"半个模拟时钟"。**

```ts
const M3_5_ALLOWS_LOGICAL_TIME = false
```

`assertEventTime` **拒绝**任何非空的 `logicalTime`
（`simulation_time_not_supported`）。

| 做法 | 结果 |
|---|---|
| 类型里有位置 | 未来实现模拟时间时不必改 schema、不必改任何调用签名 |
| 运行期失败关闭 | 今天不可能出现"有人写了它但没有任何东西按它排序"的半成品 |

半成品比没有更危险：它会让"时间已经支持模拟了"变成一个看起来成立的假设。

### 4. 校验规则（唯一实现处：`assertEventTime`）

| # | 规则 | 理由 |
|---|---|---|
| 1 | `recordedAt` 必须存在且有限 | `NaN` 会**静默**把事件顺序弄坏（不崩，只错） |
| 2 | `occurredAt` 若存在必须有限 | 同上 |
| 3 | `occurredAt` 可早于 / 晚于 / 等于 `recordedAt` | 故事时间本可以是任何时刻；"不许早于"是**导入策略**，不是时间契约 |
| 4 | `logicalTime` 若存在 → 拒绝 | 见决策 3（乙） |

校验点是事件构造处（`createConversationEvent`）、`createObservation`、
`EventTime` 构造器 —— 非法值在**写入之前**被挡住。

### 5. `append-only` 不被侵蚀

新增列**不得**进入任何 UPDATE 语句。
`m3.5:verify` 逐条抓取 `update conversation_events … (where|returning)` 的语句体，
断言其中没有这两个列 —— `delivery_status` 仍是那一列上唯一允许 UPDATE 的列。

### 6. 同一条思路用在 Trigger

`TriggerKind` 与时间模型是同一个模式（登记扩展位，只启用现在真正产出的）：

```text
启用：      conversation / system
仅登记：    schedule / environment / external_event
```

`character_jobs.trigger_kind text not null default 'conversation'` ——
默认值是**对既有事实的如实登记**（迁移前旧行唯一可能的语义就是"对话驱动"），
不是猜测。`assertTriggerEnabledInM3_5` 在入队时拒绝目前无人产出的触发。

---

## 被否决的备选方案

### 方案 A：等到真的需要时再拆

**否决理由**：那时库里已经躺着大量只有一个 `created_at` 的行，
而那些行**无法回溯判断**当初记的是哪种时间。迁移只能猜，猜错的代价是永久性的。
现在加一个 nullable 列的成本是零。

### 方案 B：把 `created_at` 重命名成 `recorded_at`

**否决理由**：
① 计划书第 83 节明确尽量避免 `RENAME massive schema`；
② 它会同时打断既有 SQL、既有脚本、既有行与所有 `rowTo*` 映射；
③ 而且没有收益 —— 列名与契约名不必一致，**契约名才是给人看的那个**。

### 方案 C：把 `occurredAt` 默认成 `createdAt`

**否决理由**：见决策 3（甲）。

### 方案 D：现在就实现一个模拟时钟

**否决理由**：计划书第 3 / 32 节明确禁止（`Simulation Tick`）。
而且模拟时钟会立刻带来"谁推进它 / 它怎么与真实时间同步 / 已有数据用哪个坐标"
三个问题，每一个都是独立的大工程。

### 方案 E：`logicalTime` 就用 `text` 而不是结构化类型

**否决**：其实**采纳了**（`logicalTime?: string`）。
理由：模拟时间的表示（tick 号 / 故事日期 / 章节序号）取决于未来的世界设计，
今天定义结构只会定义一个错的结构。
用一个不透明的 `string` 是这里**正确**的选择 —— 它的唯一职责是"占位"。

---

## 后果

### 正面

- 未来区分三种时间时不需要迁移已有数据。
- 契约名与列名分离，既有 SQL / 行 / 脚本零影响。
- "不知道"与"就是现在"在数据上可区分。

### 代价

- 每次写事件多一次 `assertEventTime`（一次纯数值检查，可忽略）。
- 库里多四个 NULL 列。缓解：nullable 列在 PostgreSQL 里几乎不占空间，
  且不参与任何索引。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| `recordedAt ≠ occurredAt` 可表达、可序列化 | `m3.5:test` FC-T06 |
| 不传 `occurredAt` → 是 `undefined`（不是"现在"） | FC-T06 |
| `logicalTime` 被拒绝 | FC-T06 + `m3.5:verify` §2 |
| 非法时间戳（NaN / Infinity）被拒绝 | FC-T06 |
| 四个列存在且旧行可读（未回填） | `m3.5:verify` §1 |
| 两个时间落库并原样读回 | `m3.5:verify` §2 |
| 新列不出现在任何 `update conversation_events` 里 | `m3.5:verify` §5 |
| `delivery_status` 仍是唯一可 UPDATE 的列 | `m3.5:verify` §5 |
| `trigger_kind` 的默认值 / 取值 / 拒绝路径 | `m3.5:test` FC-T07 + `m3.5:verify` §3 |
