# Temporal Model —— 三种时间

**阶段**：M3.5 WP5（计划书第 29–34 / 52 / 71 节）
**代码**：`src/kernel/contracts/time.ts`、迁移 0004

---

## 1. 现在只有一个时间，而它会不够用

```ts
createdAt: Timestamp      // 既有字段，一个都不能少
```

它今天够用，因为当前一直是同一个东西：

```text
她刚刚说了这句话  →  记下来的时刻  ≈  这句话说出的时刻
```

但"发生"与"记录"在下面这些情况下**必然分家**，而且**未来一定会发生**：

```text
场景一：导入一段旧对话
    occurredAt = 2019-03-02 20:14   （当时说的）
    recordedAt = 2026-09-16 10:02   （今天记进来的）

场景二：她说"我等了你三天"
    occurredAt = 故事里的三天前
    recordedAt = 现实里的现在

场景三（更远）：存在模拟时钟
    logicalTime = "第 12 天清晨"
```

---

## 2. 契约形状

```ts
interface EventTime {
  recordedAt: Timestamp      // 必有：系统什么时候记录到它
  occurredAt?: Timestamp     // 可空：这件事什么时候发生
  logicalTime?: string       // 可空：模拟时间（M3.5 必须留空）
}
```

**与既有字段的映射（刻意不改名）**：

```text
EventTime.recordedAt  ≡  既有 createdAt  ≡  数据库列 created_at
```

计划书第 83 节禁止大改 schema，因此 `created_at` 这个列名**一个字都没动** ——
所有既有 SQL、既有行、既有脚本继续有效。`recordedAt` 只存在于**契约命名**里。

---

## 3. 为什么现在就要加（计划书第 33 节）

因为 `conversation_events` / `character_domain_events` / 未来的 `Memory`
都是 **append-only** 的：

```text
等到真的需要区分三种时间时
        ↓
库里已经躺着大量只有一个 created_at 的行
        ↓
那些行**无法回溯判断**当初记的是哪种时间
        ↓
迁移只能猜 —— 猜错的代价是永久性的语义污染
```

现在加一个 nullable 列的成本是**零**（旧行保持 NULL，读回来是 `undefined`）。
这是一个"便宜的现在"换"昂贵的未来"的决定。

---

## 4. 两条刻意的不默认

### 4.1 不把 `occurredAt` 默认成 `createdAt`

"不知道它什么时候发生"与"它就是此刻发生的"是**两件不同的事**。

用后者冒充前者，会让未来的导入逻辑无法分辨哪些行需要补时间 ——
而那种错误一旦写进 append-only 的表里就再也修不回来。

需要"二者相等"这个语义的调用方**显式传**同一个值。

### 4.2 不把 `logicalTime` 建成"半个时钟"

```ts
export const M3_5_ALLOWS_LOGICAL_TIME = false
```

`assertEventTime` 会**拒绝**任何非空的 `logicalTime`
（错误码 `simulation_time_not_supported`）。

这不是自相矛盾，而是刻意的：

| 做法 | 结果 |
|---|---|
| 类型里有位置 | 未来实现模拟时间时**不需要**改 schema、不需要改任何调用签名 |
| 运行期失败关闭 | 今天不可能出现"有人写了 `logicalTime` 但没有任何东西按它排序"的半成品 |

半成品比没有更危险：它会让"时间已经支持模拟了"变成一个看起来成立的假设。

---

## 5. 校验规则（唯一实现处：`assertEventTime`）

| # | 规则 | 为什么 |
|---|---|---|
| 1 | `recordedAt` 必须存在且有限 | `NaN` 会**静默**地把事件顺序弄坏（不崩，只错） |
| 2 | `occurredAt` 若存在必须有限 | 同上 |
| 3 | `occurredAt` 可以早于 / 晚于 / 等于 `recordedAt` | 故事时间本来就可以是任何时刻；"不许早于"是**导入策略**，不是时间契约 |
| 4 | `logicalTime` 若存在 → 拒绝 | 见 §4.2 |

**校验点**：`createConversationEvent`（事件构造处）、`createObservation`、
`EventTime` 构造器。落库路径上的非法值在**写入之前**就被挡住。

---

## 6. 落库

迁移 0004 追加四个 nullable 列（两张事件表各两个）：

| 表 | 列 | 说明 |
|---|---|---|
| `conversation_events` | `occurred_at bigint` / `logical_time text` | 事实账本 |
| `character_domain_events` | `occurred_at bigint` / `logical_time text` | 角色变化历史 |

行映射是 `NULL → undefined`，并且**不回填历史行**（计划书第 83 节）。
`m3.5:verify` 明确断言"新库里没有被回填的时间列"。

`append-only` 语义不受影响：`m3.5:verify` 断言这两个新列
**没有**出现在任何 `update conversation_events` 语句里 ——
`delivery_status` 仍是那一列上唯一允许 UPDATE 的列。

---

## 7. Time Compatibility Test（计划书第 52 节）

假设未来：

```text
recordedAt: 12:00 real time
occurredAt: 10:00 story time
```

数据结构是否还能表达？**能**：

- `m3.5:test` FC-T06 断言两者可表达、可 JSON 序列化、且互不相等
- `m3.5:verify` 断言两者落库后**原样读回**（不是只活在内存返回值里）

---

## 8. Trigger：同一条思路用在"什么触发了任务"

`TriggerKind` 与时间模型是同一个模式 —— **登记扩展位，但只启用现在真正产出的**：

```text
启用：     conversation / system
仅登记：    schedule / environment / external_event
```

`character_jobs` 增 `trigger_kind text not null default 'conversation'`。

默认值 `'conversation'` **不是猜测**：迁移前旧行唯一可能的语义就是"对话驱动"，
因此这是对既有事实的如实登记。

`assertTriggerEnabledInM3_5` 会在入队时拒绝 `schedule` 这类目前无人产出的触发
（失败关闭，而不是悄悄写成一条"看起来像定时任务"的对话任务）。

详见 [`future-compatibility.md`](./future-compatibility.md) FC-07 与
`m3.5:test` FC-T07 / `m3.5:verify` §3。
