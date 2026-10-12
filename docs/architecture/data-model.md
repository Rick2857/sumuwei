# 数据模型 —— 九张表

## 全景

```
character_definitions          ← Seed Identity（她是谁；起点，不是记忆）
        │
        │  轨道一：事实
        ▼
conversation_events            ← 真实聊天历史（append-only，带角色级序号）
        │
        │  轨道二：解释 → 变化
        ▼
character_domain_events        ← 角色变化历史（必须引用来源对话事件）
        │
        │  reduce（纯函数）
        ▼
character_projections          ← 当前状态（缓存，可从事件重建）

可靠性支撑
  character_sequence_counters  ← 序号原子分配器（可信持久层）
  processed_operations         ← 幂等存储（三层幂等的最内层）
  character_jobs               ← 后台任务契约（顺序 / 重试 / 幂等）
  processor_watermarks         ← 高水位（断点续跑基准）

运行证据
  character_traces             ← 一次交互的完整"选择结果"

迁移
  character_schema_migrations  ← 版本化迁移记录
```

---

## 与 M2 旧表的关系

| M2 已有（保留，不动） | M2.5 新增 |
|---|---|
| `character_states`（当前值快照） | `character_projections`（可重放的状态） |
| `state_events`（变更日志，无来源引用） | `character_domain_events`（带来源引用） |
| `memories`（ElizaOS 的消息表） | `conversation_events`（带 actor / 序号的事实账本） |

**M2.5 只增不改。** 旧表继续服务 M1/M2 的行为；新表通过双写接入。
Phase J 收口之前不做替换。

---

## 表设计要点

### `conversation_events`

```sql
id                    text primary key
character_id          text not null
conversation_id       text not null
sequence              integer not null          -- 角色级全局序号
conversation_sequence integer not null          -- 会话内序号
type                  text not null             -- user_message | assistant_message | system_event
actor_type            text not null             -- user | character | system
actor_id              text
content               text not null
reply_to_event_id     text
metadata              jsonb
schema_version        integer not null
created_at            bigint not null

unique (character_id, sequence)                  -- 序号唯一性的最后一道闸
index (conversation_id, sequence)
index (created_at)
index (character_id, actor_type, sequence)       -- 按来源筛选（SC-002 类查询）
```

`actor_type` 是**来源隔离的载体**：只要它存在且被校验，
"她自己的话被当成用户陈述"就不可能悄悄发生。

### `character_domain_events`

```sql
source_conversation_event_ids  jsonb not null    -- 原始引用（保持"复数来源"语义）
primary_source_event_id        text  not null    -- 冗余第一条，让索引用得上
caused_by_domain_event_ids     jsonb             -- M11 的派生链（现在不产生数据）
idempotency_key                text  not null

unique (character_id, sequence)
unique (idempotency_key)                          -- 幂等的最后一道闸
index (character_id, created_at)
index (character_id, type)
index (primary_source_event_id)                   -- 反查"这次对话引起了什么变化"
```

`source_conversation_event_ids` 用 jsonb 数组而不是关联表：
M2.5 的查询模式是"按事件取它的来源"（正查）与"按主来源反查"
（用冗余列 + 索引），不需要多对多的任意连接。
plan 第 63 节允许"如果使用多对多关联可建关联表"——M4 若真的需要
"多条记忆共享同一批证据"的统计查询，再加关联表，不提前做。

### `character_projections`

```sql
primary key (character_id, projection_type)
revision                    integer not null      -- 乐观锁
reducer_version             text    not null      -- 这一行是用哪个版本算的
last_domain_event_id        text
last_domain_event_sequence  integer               -- 乱序判定
state                       jsonb   not null
```

**一个角色每种投影只有一行**。需要按用户区分时把 userId 编进
`projection_type`（`relationship:user:<uuid>`），而不是加旁路字段。

### `character_jobs`

```sql
unique index (idempotency_key) where status in ('pending','running','completed')
```

这个**部分唯一索引**是刻意的：已完成的活不会被重复排期，
但失败任务允许重建——否则一次失败会把这个幂等键永久钉死，重试反而做不了。

### `character_sequence_counters`

```sql
character_id  text primary key
next_sequence integer not null
```

它存在的唯一理由是让序号分配变成**单条原子语句**
（见 `event-model.md`）。`SELECT MAX(sequence)+1` 在并发下会撞号，
而撞号意味着"她的一段经历被覆盖"，且是静默的。

---

## 迁移纪律

```
character_schema_migrations (version, name, applied_at)
```

- 迁移**只增不改**：已发布过的迁移内容不许再改，需要改就加新版本号。
- 版本号必须从 1 起**严格连续递增**（`assertMigrationsWellFormed()` 会抛错）。
- 整批迁移在**一个事务**里执行（驱动不支持事务时逐条，仍然幂等）。
- 迁移 0001 = M2 已有的两张表（`if not exists`，对已有库是空操作），
  因此**新旧库最终 schema 一致**，而旧库不会因为缺少记录被重复执行。

**守着它的测试**：`kernel:verify` 第 1/2 节（空库 → 最新 schema；重跑幂等）。

### 所有入口共用一次迁移

迁移挂在 `initDatabase()` 里（`src/db/index.ts`），而不是 `main.ts`。
于是主程序、诊断脚本、验收脚本、测试夹具拿到的都是同一个 schema——
不会出现"我在 A 里建了表、B 里没有"这类只在特定入口复现的问题。

---

## Replay 与 Projection 的边界

```
删除 character_projections 里的某一行   → 完全安全（会 rebuild 回来）
修改 character_domain_events 里的记录   → 不允许（变化历史也是事实）
修改 conversation_events 里的记录       → 不允许（没有那个函数）
```

判断标准很简单：**能重算出来的东西可以丢，不能重算的东西不能改。**
