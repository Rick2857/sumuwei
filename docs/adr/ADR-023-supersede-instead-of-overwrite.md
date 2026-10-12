# ADR-023：旧事实用 Supersede，不用覆盖

- **状态**：已接受（M4）
- **日期**：2026-09-16
- **相关**：计划书第 71 – 78 节；MI-06 / MI-07 / MI-11
- **代码**：`src/kernel/projections/memory.ts`（`reduceMemory`）、
  `src/infrastructure/persistence/memory-store.ts`（`applyMemoryEvent` / `rebuildMemory`）、
  迁移 0005 的 `memory_records` + `memory_events`

---

## 背景

用户先说"我不吃香菜"，三个月后说"我现在能吃香菜了"。

最直接的做法是 `UPDATE memory_records SET value = 'like' WHERE ...`：

```text
一行，一个值，永远是最新的。查询简单。存储最省。
```

它在这个场景下**能工作**。它不能工作的是下面这些：

| 需求 | 覆盖式为什么不行 |
|---|---|
| "她从什么时候开始能吃香菜的？" | 旧值没了，时间线断了 |
| "她是不是一直记错了？" | 无法区分"她改了"与"系统改错了" |
| "重放能不能回到上周的状态？" | 不能 —— 中间状态没有被记录 |
| "这条记忆当初是谁、因为什么改的？" | 没有历史可查 |
| "撤销上一次纠正" | 撤销不了 |

而 M4 是第一个引入**自动写入**的里程碑：
一旦抽取流水线能自动改值，"她什么时候改的、为什么改的"
就不再是好奇，而是**唯一能发现流水线出错的手段**。

---

## 决策

**旧记忆不物理覆盖；新值是一条新记忆，旧记忆变成 `SUPERSEDED`
并保留双向指针。**

### 1. 追加式状态机

```text
MEMORY_CREATED     → ACTIVE
MEMORY_SUPERSEDED  → SUPERSEDED（旧条）+ ACTIVE（新条）
MEMORY_RETRACTED   → RETRACTED
MEMORY_DISPUTED    → DISPUTED
MEMORY_RESTORED    → 回到 ACTIVE / DISPUTED
MEMORY_MERGED      → 胜者留下，败者 SUPERSEDED（留痕）
```

`memory_records` 的写路径**只**通过 `applyMemoryEvent()`，
它 append `memory_events` 并更新投影行 ——
**不改写业务字段的历史**。

### 2. 双向指针（不是单向）

```text
新条 superRefs / supersedes  →  旧条 id
旧条 supersededBy            →  新条 id
```

单向不够：`new.supersedes = old` 能回答"新条推翻了谁"，
但回答不了"这条旧的**为什么不见了**"——
而后者才是审计要问的问题。

### 3. `rebuildMemory()` 的比较必须包含 `supersedesOf()`

这是一个真实踩过的坑：如果重放校验只比较 `status`，
那么"旧条被覆盖成 SUPERSEDED、但指针丢了"这种情况
会**通过**校验 —— 状态对了，可追溯性没了。

`rebuildMemory()` 因此比较完整快照（含 `supersedesOf()`）。

### 4. 活跃唯一性用**部分索引**，不用"查询时判断"

```sql
create unique index memory_records_active_fingerprint
  on memory_records (...) where status = 'ACTIVE'
```

"查询时判断有没有重复"在并发下会漏：
两个 worker 同时查、同时都看到"没有"，然后都插入。
数据库层的部分唯一索引是唯一真正原子的守卫。

### 5. 内容指纹不是抗碰撞的（如实记录）

`memoryDigest()` 用 FNV-1a，是**去重用的启发式**，不是安全摘要。
把两条内容不同但指纹相同的记忆误判成重复是理论可能的。

影响被限制在：指纹只用于"完全相同就拒"这一层，
且第二层（`CanonicalMemoryKey`）会独立判定。

---

## 被否决的备选方案

### 方案 A：直接 UPDATE 值

**否决理由**：见背景表格。核心是：**自动写入系统没有历史，
就没有发现自身错误的手段。**

### 方案 B：覆盖 + 一张独立的审计表

**否决理由**：审计表会与主表**漂移**。
"当前值"与"审计记录的最后一条"是两个真相，
而它们不一致时没人知道该信哪个。
让当前值**由**事件派生（`currentValidity` ≠ "查表"），
是唯一不会漂移的形状。

### 方案 C：只保留 `supersededBy`（单向）

**否决理由**：见决策 2。

### 方案 D：物理删除 + 墓碑表

**否决理由**：墓碑表是方案 B 的变体，同样的漂移问题。
而且"删除"会让 `validFrom` 边界失去锚点 ——
"它是什么时候不再有效的"答不出来。

### 方案 E：靠应用层去重，不建部分唯一索引

**否决理由**：见决策 4。并发下必然漏。

### 方案 F：用 `validUntil` 的非空表示"已结束"，`NULL` 表示"仍有效"

**采纳了，但加了一个哨兵**。实测踩到的类型缺陷：
`valid_until` 一开始是 `bigint`，于是"仍有效"只能写 `NULL`。
而 `NULL` 与"不知道何时结束"无法区分。改成 `text` 列后
有三态：`NULL`（未知）/ `'none'`（明确仍有效）/ 数字字符串（已结束）。

这正是 ADR-019 里"不知道"与"就是现在"必须可区分那条原则
在记忆时间上的复用。

---

## 后果

### 正面

- 任意时刻的历史状态都可重建（`A == B` 重放闸）。
- 每条记忆都能回答"什么时候、因为什么、被谁改的"。
- "她改主意了"与"系统改错了"在数据上可区分。

### 代价

- 每次纠正写两行 + 一条事件，而不是一次 UPDATE。
- 活跃记忆的查询必须带 `status = 'ACTIVE'`。
  缓解：部分索引让这个查询仍然是一次索引扫描。
- `MEMORY_MERGED` 目前**没有生产者**（`resolveConflict()` 的重复走
  `REJECT_DUPLICATE`）。接口就位、驱动缺失，见
  `memory-invariants.md` §16.2。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 旧条 SUPERSEDED 且历史仍在（非物理删除） | `m4:verify` §5 |
| 同槽位新取值是**另一条**记忆 | `m4:verify` §5 |
| `supersededBy` / `supersedes` 双向可追溯 | `m4:verify`「双向可追溯（MI-07）」 |
| 重放 `A == B`（含指针比较） | `m4:verify` §8 |
| 乐观锁：旧任务不能覆盖新状态 | `m4:verify` §6 |
| `validUntil` 三态可表达、可区分 | `m4:test` 分组「时间语义」+ Admin 渲染层 |
| reducer 版本守卫 | `m4:verify` §7 |
| 活跃指纹唯一（含并发） | `m4:verify` §4 + 迁移 0005 的部分唯一索引 |
