# ADR-010：Seed 必须版本化，且改动需要留痕

- **状态**：已接受（M3）
- **日期**：2026-09-16
- **相关**：计划书第 18 / 19 / 76 / 77 / 124 / 125 节、ADR-007

---

## 背景

Seed 加版本号这件事，M2.5 已经做了一半：`seedVersion` 字段存在，
且"内容变了不升版本"会被拒写。M3 需要补完三件事：

1. **指纹**。只有版本号时，"配置文件被偷偷改了但版本没更新"
   这句话在**运行期**是检测不出来的 —— 版本号是人填的。
2. **历史**。M2.5 用 `UPDATE` 覆盖旧 Seed。一旦覆盖，
   "她两个月前为什么是那样"就无从回答。
3. **修改留痕**。版本差异留在 commit message 里，而不是数据里。
   半年后没人能从数据上回答"这一版是谁改的、为什么"。

为什么这三件事现在必须做完（而不是等 M11 的 Adaptive Self）：

计划书第 125 节给了最直接的理由：

> 未来 M11 会有 Adaptive Self。如果发现"角色变化了"，
> 必须区分：角色真的成长 / 开发者修改 Seed / 模型行为漂移。
> 没有 Seed History 无法判断。

这个区分**只能在数据层面做**。等 M11 再补，M3–M10 期间的所有
Seed 改动都已经不可追溯了。

---

## 决策

**Seed 的每一次写入都必须同时产生 (version, hash, history, provenance) 四样东西。**

### 1. 指纹（`seedHash`）

对**规范化** Seed 求 sha256。规范化规则写死在
`canonicalizeSeed()` 里，且刻意排除时间戳与 provenance：

- 字符串 trim、数组去空项
- 强度/优先级夹到 0..1 并保留 6 位小数（消灭浮点尾差）
- 结构化条目**按名字排序**
- 对象键顺序固定（手写序列化，不依赖 `JSON.stringify` 的插入顺序）
- `createdAt` / `updatedAt` / `provenance` **不进指纹**

最后一条尤其重要：改一个时间戳不该让人格指纹变化，
否则每次启动都会误报"人设被改了"。

### 2. 两道闸（写入闸 + 读取闸）

**写入闸**（`upsertCharacterDefinition`）：

| 情形 | 结果 |
|---|---|
| 版本回退 | 拒绝 `seed_version_regression` |
| 内容变了、版本没变 | 拒绝 `seed_changed_without_version_bump` |
| 库内容与记录指纹不一致 | 拒绝 `seed_hash_mismatch` |

**读取闸**（`CharacterIdentityService.buildIdentitySnapshot`）：
重新算一次 hash 与库里记录比对。

为什么两道都要：写入闸只能拦"经过代码的写入"。
有人直接 `UPDATE character_definitions` 时它完全看不见，
而那正是"她怎么悄悄变了"最可能的形态。
读取闸的成本是几微秒。

### 3. 历史（`character_definition_versions`）

每次真正的写入都插一条快照，**不覆盖**。
保留 `author` / `reason` / `effective_at`。

### 4. 修改规程（`SEED_CHANGE_PROTOCOL`）

写成代码里的常量，而不是文档里的一段话：

```text
1. 修改 SEED_VERSION（+1，只增不减）
2. 在 provenance 里写清 author 与 reason
3. 写一条 ADR
4. 跑 pnpm m3:seed-check
5. 启动时服务会保留旧版本（不覆盖）
```

### 5. 修复路径必须**显式**

一个刻意设计的不便之处：库被绕过改过之后，系统**不会自愈**。

普通的 `upsert` 会一路报错（先报 hash 不一致，`acknowledge: 'repair'`
之后又会撞上"内容变了不升版本"）。修复必须写成：

```ts
await store.upsert(definition, { acknowledge: 'repair' })
```

参数是**字符串**而不是 boolean：调用点必须写出"为什么"，
而 `skipHashCheck: true` 读起来像是"顺手关掉一个检查"。

"要不要丢掉库里的那一版"是一个需要人明确决定的事，
不该由一次启动悄悄完成。

---

## 被否决的备选方案

### 方案 A：只靠版本号（M2.5 的现状）

**否决理由**：版本号是人填的。它回答不了"这个版本号对应的内容是什么"，
也发现不了"有人改了内容但没动版本号"。

### 方案 B：用 `UPDATE` + 一张 `audit_log` 表记录改动

**否决理由**：`audit_log` 是"另写一处"的方案，
它需要每个写入点都记得写日志 —— 而忘记写日志**不会报错**。

`character_definition_versions` 是主键 `(character_id, seed_version)`，
写入由 `upsert` 内部完成。忘记留痕这件事在结构上不存在。

### 方案 C：把整个 Seed 每次改动都存一份新行（不区分版本表）

**否决理由**：那会让"当前 Seed"变成一个需要 `WHERE version = MAX()`
的查询，而所有读取路径都要改。多一张历史表比改所有读取路径便宜得多，
而且历史表天然可以有不同的保留策略（例如以后只留 50 版）。

### 方案 D：hash 用领域层的实现（不用 `node:crypto`）

**否决理由**：领域层**不许** import `node:crypto`（有静态测试守着）。
但"指纹"又必须只有一个定义。因此拆成两半：

- 领域层 `canonicalSeedJson()` —— 决定**指纹材料是什么**
- 基础设施 `hashSeed()` —— 决定**用什么算法算**

换算法（sha256 → blake3）只改后者，而"哪些内容算人格"仍由前者单独决定。
这个拆分还带来一个好处：单测可以在不碰 crypto 的情况下断言规范化是确定的。

---

## 后果

### 正面

- "她怎么变了"可以被判定成三种情况之一：真的成长 / 开发者改了 Seed / 模型漂移。
- 每次对话的 Trace 都带 `seed_version` + `seed_hash`，
  排查"她为什么这样说"时第一眼就能看到用了哪版人格。
- `--seed-status` 给出一个只读的自检入口。

### 代价

- 改人设要走五步流程。**这是刻意的**（见 ADR-007 的"代价"一节）。
- 历史表会随版本增长。对一个"一年改几次"的人设，这是零成本。
- 库被改坏后不能自愈，需要一条 `acknowledge: 'repair'` 的命令。
  **这同样是刻意的**。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 内容变了不升版本 → 拒绝 | `verify-m3-persistence.ts` §3 + `verify-phase-c.ts` §3 |
| 版本回退 → 拒绝 | 同上 |
| 库绕过写入闸 → 读取时发现 | `verify-m3-persistence.ts` §3 |
| 历史不覆盖旧版本 | `verify-m3-persistence.ts` §2 / §7（T14） |
| 时间戳与 provenance 不进指纹 | `scripts/kernel-tests-identity.ts` |
| 数组顺序不影响指纹与渲染 | 同上 |
| 100 轮对话后 Seed 完全不变 | `verify-m3-persistence.ts` §6（T3） |
| 无 author/reason 的变更被拒 | `verify-m3-persistence.ts` §8 |
