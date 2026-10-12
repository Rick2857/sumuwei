# ADR-003：Projection 是可重建的缓存，Reducer 必须确定性

- **状态**：已采纳（M2.5）
- **日期**：2026-09-16
- **相关**：[projection-model.md](../architecture/projection-model.md)、SC-005

## 背景

M2 的 `character_states` 表存的是"最后一次的值"：
`trust=0.85, closeness=0.60, version=12`。

这够跑 L1。但一旦关系会因经历而变化（M7），就会出现三个问题：

1. **改算法就得放手**：发现"冲突惩罚太强"想调 reducer，
   库里那些数字是用旧算法算的，没有共同基准。
2. **无法回答"她变了吗"**：只有当前值，没有"如果重放一遍会得到什么"。
3. **状态不可信**：如果某个 bug 让状态被改错，无法恢复——
   因为没有任何东西能重新算出来。

## 决策

Projection 定义为 `Domain Events` 的折叠结果，并满足：

```ts
interface ProjectionReducer<TState, TEvent> {
  readonly projectionType: string
  readonly version: string          // 必须版本化
  readonly handledEventTypes: readonly string[]
  initialState(): TState            // 纯函数
  reduce(state, event): TState      // 纯函数：禁止 LLM/网络/时间/随机/写库
  isStale?(projection, event): boolean
}
```

三条硬性约束：

1. **Reducer 纯函数**：`state + event → new state`。
2. **版本化**：`projection.reducerVersion` 记录"这一行是用哪个版本算的"；
   版本不一致时 `applyEvent()` **直接抛错**，不允许新算法继续算旧状态。
3. **单一认领**：同一 `(projectionType, domainEventType)` 只允许一个 Reducer，
   `ReducerRegistry` 在登记时检测冲突。

以及一个 `rebuildProjection()`：删掉当前快照 → 读全部领域事件 → 按序 reduce → 写回。

## 被否决的方案

### 方案 A：直接改 `character_states`，把 reducer 逻辑写在写入路径上

**否决理由**：这正是 M2 的状态。它的问题是**没有重算能力**——
`applyDecay()` 是纯函数，但它的输出直接落库、没有留下可重放的中间表示。

### 方案 B：Reducer 允许读当前时间（"衰减在 reduce 里算"）

**否决理由**：这看起来方便（衰减本来就是时间相关的），但它会让 Replay
**不可能**：同一批事件在不同时刻折叠出不同结果，于是"她为什么是现在这样"
再也说不清。

M2 已经给出了正确做法的范例：`decay.ts` 是纯函数，
**惰性结算**（读的时候按真实流逝时间算）而不是定时写库。
M2.5 沿用这个思路——衰减留在读时结算，而不是进 reducer。

### 方案 C：reducer 版本不一致时自动 rebuild

**否决理由**：自动 rebuild 会掩盖"有人改了算法但没想清楚兼容性"这件事。
M2.5 选择**抛错**，把决定权交给调用方：是有意升级（那就显式 rebuild），
还是误改（那就修回去）。

### 方案 D：`SELECT ... FOR UPDATE` 代替乐观锁

**否决理由**：M2.5 的场景是单进程 + 少量后台任务，
悲观锁会引入行锁等待与死锁面，而它解决的问题（并发覆盖）
用 `revision` 乐观锁同样解决，且失败时能给出**可诊断**的错误
（`expectedRevision` vs `actualRevision`）。

如果未来真的出现高并发写入，那时再加悲观锁；现在加属于 speculative。

## 后果

**正面**
- 改算法可以 `rebuild`，不需要丢掉旧人格。
- SC-005 让"可重放"成为一条**每次提交都会被验证**的性质，
  而不是一个说法。
- 乱序保护有单一定义处（`isStale`），而不是散落在各 Worker 里。

**负面 / 成本**
- 每次状态更新多一次读（乐观锁要先读当前 revision）。
  实测在 PGlite 上可忽略。
- Reducer 版本升级需要一次显式 rebuild（长跑数据下是 O(n) 事件数）。
  这是有意的代价：升级算法本来就该是一次显式动作。

## 实现细节：为什么不用 `affectedRows`

所有"改了几行"的判断都用 `... returning *` 数返回数组长度，
**不猜驱动的 `affectedRows` 语义**。

不同驱动（PGlite / Postgres / drizzle 包装层）对 UPDATE / DELETE 的
返回形状并不一致，而"乐观锁到底成功没有"是必须绝对可靠的判断——
猜错一次就是**静默的数据覆盖**。这一点写进了 `db.ts` 的注释，
避免以后有人为了少写几个字符把它改回去。
