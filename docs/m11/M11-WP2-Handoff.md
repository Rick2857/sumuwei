# M11 WP2 交接单

- 日期：2026-10-01
- 工作包：WP2（派生来源贯通与根解析）
- 状态：**COMPLETE** —— ①派生链传输（`e889ef28`）· ②纯根解析器（`88c076eb`）·
  ③只读适配（`0bdf3a90`）**三件全部落地**；门 `m11:lineage:verify` = **PASS 34/34**
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D25` / `D05` / `D31`（`ACCEPTED / DESIGN FROZEN`）
- 证据（权威代 + 4 代过程档，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp2-20261001-0bdf3a90a027-6c14/`（**34/34**，head = 适配器提交）
  - `…30a4d6f2f51f-1eae`（34/34，适配器未提交）· `…88c076eb29ef-b879`（30/30，解析器提交）
  - `…d94c5b47b50e-43fb`（30/30，脚本未提交）· `…e889ef28fd43-45dd`（16/16，传输）·
    `…1ca68f0e52b9-9e1d`（16/16，但**进程不退出**，见 §5 ①）
- 本轮**没有**：打开真实库（全程 `isolateDatabase()` 一次性沙箱）· 调模型 · 出网 · 改 DDL

---

## 1. 已完成：派生链传输（`D25` ①–④）

| 面 | 实际改动 | 判据 |
|---|---|---|
| 提案契约 | [`proposal.ts`](../../src/kernel/contracts/proposal.ts)：`ProposedDomainEvent.causedByDomainEventIds?` + 结构检查（空数组 / 非字符串 / **重复元素**） | `caused_by_malformed` · `caused_by_duplicate` |
| 放行口 | [`validator.ts`](../../src/kernel/policies/validator.ts)：`AcceptedDomainEvent` 带上该字段；新增**可选** `DomainEventParentLookup`；逐条检查父存在 / 同角色；**口缺失即拒收** | `caused_by_parent_missing` · `caused_by_parent_foreign` · `caused_by_lookup_unavailable` · 查询抛错 ⇒ `caused_by_lookup_failed`（失败关闭） |
| 写入 | [`event-store.ts`](../../src/infrastructure/persistence/event-store.ts)：`${null}::jsonb` → `${causedByJson}::jsonb`（缺省仍 `null`） | 真实 append → 读回逐字一致 |
| 迁移 | **NONE**（列早在 `0001` 就有） | WP0 已逐条核对 |

### 1.1 一个**结构性**论证被写进代码（不是注释）

```text
Validator **不**做环检测，理由是：父事件必须**已存在** ⇒ 它的序号必然小于
本次将要分配的序号 ⇒ 新加的边只向后指 ⇒ **新事件不可能制造环**。
环只可能存在于**旧数据**里 ⇒ 那是 resolver 读时的职责（ADR §4.4 / D31）。
```

⇒ 下一轮的 resolver **必须**实现环检测（读旧数据），而它的负控要**手工构造**一条环（见 §3）。

### 1.2 权威读数（`m11:lineage:verify`，隔离库，16/16 PASS）

```text
A1 不带字段 ⇒ 写成功、读回 undefined、旧行为逐字不变      A4 原始列真的是 JSON 数组（与 A2 的 NULL 对照）
A2 原始列是 **SQL NULL**（不是空数组）                    A5 两个父：顺序与集合逐字保持
A3 一个父：append → 读回恰好那一个 id                     A6 同幂等键重投 ⇒ 不产生第二份
B1 【正控】合法父 ⇒ 放行且**带着**派生链                  B4 【负控】装配无查询口 ⇒ lookup_unavailable
B2 【负控】父不存在 ⇒ parent_missing                     B5 【负控】空数组 ⇒ malformed
B3 【负控】父属别角色 ⇒ parent_foreign                    B6 【负控】重复父 ⇒ duplicate
C1 旧行 payload / 序号 / 派生列**逐字未变**（不补写历史）  C2 事件总数与带链条数**非零**（正控）
S1 三组都非零（否则 MEASUREMENT INVALID）                 S2 负控覆盖 D25 的四种拒收
```

---

## 2. 已完成：纯根解析器（`D05` / `D31` / §4.4）

| 文件 | 内容 |
|---|---|
| [`contracts/reflection-lineage.ts`](../../src/kernel/contracts/reflection-lineage.ts) | 五类来源标签（闭集）· `LineageHandle` / `LineageRoot` / `LineageResolution` · **七条具名拒收理由** + `LINEAGE_REJECTION_FACTS`（逐条写"谁产生 / 怎么到"）· 注入式只读口 `LineageLookup` · 上限常量 16 / 64 |
| [`app/reflection/lineage.ts`](../../src/kernel/app/reflection/lineage.ts) | `expandLineage(lookup, handles, { characterId })`：**有界**展开（节点上限在取数前生效）+ 收根（深度上限、**环检测**、按真实 ID 去重）· `measuredCount` 自检 · 失败关闭（端口抛错原样抛） |

### 2.1 手算图（**独立 oracle**，不复用 resolver 算 expected）

`m11:lineage:verify` 的 D 组用一个**手写**的内存图（9 类节点 + 18 跳链 + 70 节点链）对照契约 §4.4 的表：

```text
D1  mem:A(ce:1) + bel:1(roots ce:1) ⇒ 有效根 **1**（同根不增信）· 派生 2
D2  mem:A + mem:B ⇒ {ce:1, ce:2} = 2 · 会话 2
D3  de:21 → de:20 → {de:10,de:11} → {ce:1,ce:2} ⇒ 根 2 · **派生 4 且都不是根**
D4  三个独立根 / 三会话 ⇒ 3 / 3（D10 门槛的两分量）
D5  de:21 + mem:A ⇒ 仍是 {ce:1, ce:2} = 2（多链不增信）
D13 来源类分列：user ⇒ user_statement · assistant ⇒ assistant_speech · **classHint 优先**（程序事实）
D14 五类计数之和 == rootCount（分列守恒）
D6  de:X ⇄ de:Y ⇒ `lineage_cycle`            D7  18 跳 ⇒ 超限（明细=**深度**）
D8  70 节点 ⇒ 超限（明细=**展开节点**）        D9  悬空引用 ⇒ `node_missing`
D10 别的角色 ⇒ `node_foreign`                 D11 无来源无父 ⇒ `root_unresolvable`
D12 空 handle ⇒ `measuredCount = 0` ⇒ **调用方必须判 MEASUREMENT INVALID**
```

### 2.2 权威读数

```text
m11:lineage:verify = PASS **34/34**（A 传输 6 · B 语义负控 6 · C 不回写 2 · D 根图 14 · E 真实库 4 · S 自检 2）
整门耗时 ≈ 4 秒（隔离库真实 append/readback + 真实适配器 + 纯图解算）
```

---

## 3. 已完成：只读适配（唯一 SQL 落点）

[`infrastructure/persistence/reflection-lineage-read.ts`](../../src/infrastructure/persistence/reflection-lineage-read.ts)
—— `createReflectionLineageLookup(db, { characterId })`：

```text
· 对话事件 / 领域事件 / 记忆证据：**一条** `where … in (<ids>)` 拿一批（不做 N+1）；
  字面量转义沿用 `qualification-read.ts:99-126` 的既有做法。
· 信念：`listBeliefRows(db, characterId)` 按**角色作用域**读出后按 id 过滤
  （与 `listActiveBeliefs` 同一形状；⚠️ 族读取成本是**已知代价**，登记在局限候选里）。
· `caused_by_domain_event_ids` 的 **NULL** 读成"没有父"（旧形状），不是 `node_malformed`。
· 记忆归属：只有 `owner_kind='character'` 才填 `characterId` ⇒ user 归属的记忆**不**被判跨角色
  （`D25` ④ 的原话是"跨用户引用**按各来源的 subject/target 规则**复核"）。
· **本适配器不判资格**（遗忘/撤回由调用方按各域既有资格链处理，`D13`）。
```

### 3.1 真实库段落（E 组）——**不许只测内存图**

```text
E1 真实对话事件 handle ⇒ 它自己就是根（measuredCount=1，非空跑）
E2 ⭐ 造一个**零自有来源、只有 causedBy** 的领域事件 ⇒ 仍能追到父的对话来源
   （只有适配器真的读了那一列才可能通过 —— 这是"字段已存在 ≠ 链路已具备"的正面反证）
E3 不存在的记忆 id ⇒ `node_missing`
E4 记忆/信念两条查询**可执行**（返回空集而不抛；⚠️ 只证明 SQL 可执行，不证明语义覆盖）
```

**WP2 出口条件**（计划 §9）：所有支持 / 反例路径可复核 ✓；量具用独立手算图验证 ✓（D 组）。

---

## 4. 下一轮（WP3：真实输入与结构化候选）

```text
`kernel/app/reflection/inputs.ts`（名称按实际目录定）+ 基础设施只读 store：
· M4/M9/M10 的**真实 revision 与资格**（不接 M9.5 的 fixture：`L-M11-06`）
· 受限 source handles（只给程序提供的候选；`D06`）
· 严格 JSON schema / prompt / model / schema 版本（`D28` 的 draft 形状）
· 出口：真实模型只生成 **draft**；Memory/Belief/Goal 与 AdaptiveSelf 的变化数**均为 0**
```

---

## 5. 受影响旧门的回归读数（AGENTS §5 的最小纪律）

改动面：`kernel/contracts/proposal.ts` · `kernel/policies/validator.ts`（kernel 边界/契约）·
`infrastructure/persistence/event-store.ts`（事件写入）。逐门实测（直接入口调用，`pnpm` 本机被阻塞）：

```text
kernel:test   (scripts/kernel-tests.ts)          EXIT 0
kernel:verify (scripts/verify-phase-c.ts)        EXIT 0
m4:test       (scripts/kernel-tests-memory.ts)   EXIT 0（**258 通过 / 0 失败**）
m4:verify     (scripts/verify-m4-persistence.ts) EXIT 0（**142 通过 / 0 失败**；实验库已清理，真实库未被触碰）
m4:isolation:verify (scripts/verify-m4-isolation.ts) EXIT 0（**22 通过 / 0 失败**）
m3:verify     (scripts/verify-m3-persistence.ts) EXIT 0
m3.5:verify   (scripts/verify-m3.5-persistence.ts) EXIT 0
m10:m11:verify                                   PASS 11/11（只读面边界未被本次改动破坏）
m11:lineage:verify                               PASS **34/34**（≈4 s）
```

⚠️ 这是**受影响门**的读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。

---

## 6. 环境与量具教训（本轮实测）

```text
① ⚠️ **门必须显式退出**：第一代 `m11:lineage:verify` 判词与证据都落盘了，但**进程不退出**
   （M4 harness 把 embedding 插件的处理循环留在 event loop 上）。
   实测对比：不退出 ⇒ 观测到 >10 分钟"仍在运行"（在 runner 下会被读成假超时）；
   改成 `process.exit(...)` 后 ⇒ **整门 3.5 秒**跑完并退出 0。
   登记 `L-M11-12`；仓库既有 608 处 `process.exit(...)` 是同一形状。
② 沙箱库一律 `isolateDatabase(..., { keep: false })`，且必须在**任何**碰数据库的
   import 之前调用（否则构造的是真实库）—— 本门的第一行就是这个顺序。
③ 负控断言的是**具名理由码**，不是"没成功"：否则"被拒"与"执行器不工作"在输出上无法区分。
```
