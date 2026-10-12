# Projection / Reducer 模型 —— 状态是缓存，不是事实本体

## 核心命题

数据库里的 `trust = 0.63` **不是真相**。

它只是"到目前为止所有 Domain Event 折叠出来的结果"：

```
Domain Events ──reduce──► Projection { revision, reducerVersion, state }
                   ▲
                   └── rebuild 可以从头算出同一个结果
```

于是 reducer 改进以后 `rebuild projection` 即可，**不需要丢掉旧人格**
（plan 第 23/24 节）。这是"可解释的连续性"能长期成立的技术前提。

---

## 契约

```ts
interface CharacterProjection<TState> {
  characterId, projectionType, revision, reducerVersion,
  lastDomainEventId?, lastDomainEventSequence?,
  state, updatedAt
}

interface ProjectionReducer<TState, TEvent> {
  readonly projectionType: string
  readonly version: string
  readonly handledEventTypes: readonly string[]
  initialState(): TState
  reduce(state: TState, event: TEvent): TState
  isStale?(projection, event): boolean
}
```

### Reducer 里禁止的东西

```
调用 LLM · 网络请求 · 读当前时间 · 随机数 · 写数据库 · 发消息
```

只允许 `state + event → new state`。

这条不是风格问题：上面任何一样都会让 Replay 失效——
第二次算出来的结果与第一次不同，于是"她为什么是现在这样"就再也说不清了。

**守着它的测试**：`kernel:test` →「同一输入两次折叠结果相同且不改原状态」；
SC-005 →「连续三次 rebuild 结果稳定」。

### 版本化：不许用新算法继续算旧状态

改了 `reduce` 的任何语义，必须升 `version`。然后有两种正当做法：

1. **rebuild**：用新 reducer 把全部事件重放一遍（推荐）
2. 保持两套 reducer 各自服务各自的投影

**不允许**的是：拿 `v2` 去继续更新一个由 `v1` 算出来的投影——
那样 `reducerVersion` 这一列就在说谎，而它恰恰是"这一行是怎么来的"的唯一记录。

`applyEvent()` 在这里**直接抛错**（`reducer_version_mismatch`），不给机会。

**守着它的测试**：`kernel:test` →「reducer 版本不一致时拒绝继续追加」。

---

## 乱序保护：`isStale`

后台任务天然会乱序。默认判定是 `event.sequence <= projection.lastDomainEventSequence`。

返回 `stale: true` 时**静默跳过**，而不是报错 ——
乱序是正常现象，不是故障。

这是"旧 Worker 不能覆盖新 Worker"的单一定义处。

**守着它的测试**：`kernel:test` →「乱序事件被判定为过时（不覆盖更新状态）」。

---

## 唯一变更链与事务边界

```
LLM → Proposal
─────────────── transaction ───────────────
Validator → insert DomainEvent → reduce → 乐观锁更新 Projection
─────────────── commit ────────────────────
```

`applyAcceptedEvents()` 是唯一的落库入口，事务里只有：
序号分配、插入、**纯函数** reduce、乐观锁更新。

**没有 LLM、没有网络、没有遥测**。

禁止的是：`BEGIN → 调模型 20 秒 → 写库 → COMMIT`。
那会让一次模型超时把数据库连接一起拖住，而事务里等待的时间
在生产里是不可控的。

### 只有"新建"的事件才折叠

```ts
if (!created) continue   // 幂等命中：事件已存在，不再折叠进投影
```

少了这一行，重跑一次就会让计数器 +2（SC-004 检的正是这个）。

---

## 乐观锁：为什么不用 `affectedRows`

M2.5 里所有"改了几行"的判断都用 `... returning *` 数返回数组长度，
**不猜驱动的 `affectedRows` 语义**。

原因：不同驱动（PGlite / Postgres / drizzle 包装层）对 UPDATE / DELETE 的
返回形状并不一致，而"乐观锁到底成功没有"是必须绝对可靠的判断——
猜错一次就是静默的数据覆盖（见 `src/infrastructure/persistence/db.ts`）。

`saveProjection()` 的实现因此是三步：先读、带 revision 条件更新、用
`returning` 确认；影响行数为 0 时抛 `revision_conflict`，并把
`expectedRevision` 与 `actualRevision` 一起放进错误详情。

**守着它的测试**：`kernel:verify` →「过期 revision 写入 → revision_conflict」
「冲突后状态未被污染」。

---

## Replay Service

```ts
rebuildProjection(db, characterId, reducer)
  → 读该角色的全部 Domain Event（按 type 过滤出本投影关心的）
  → initialState() → 按序号升序 reduce
  → 事务内：删旧投影 + 写新投影
```

返回 `previousRevision`，因此"重建前后是否一致"可以直接比对。

**守着它的测试**：`eval:scenarios` SC-005（四条断言）：
删掉投影 → rebuild → state 与 revision 与删除前一致；
连续三次 rebuild 稳定；消费事件数 = 领域事件数；
`lastDomainEventSequence` = 最大序号。

---

## 作用域：`(characterId, projectionType)` 唯一

一个角色每种投影只允许一个当前快照（plan 第 64 节）。

那"关系状态是按用户分开的"怎么办？

**答案：把作用域编进 `projectionType`**，例如：

```
character-state:user:<uuid>
relationship:user:<uuid>
character:self              ← 角色级（不需要区分用户时）
```

而不是给投影加一个旁路的 scope 字段。好处是唯一约束保持简单，
"一个角色一种投影一行"这条不变量不需要附带条件。

> M2.5 只有 `diagnostic-counter` 一个投影（测试用）。
> 真正的 `RelationshipState` 在 M7，届时按上面的约定命名。
