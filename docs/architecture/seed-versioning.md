# Seed 版本化（Seed Versioning）

**阶段**：M3
**回答的问题**：**"她什么时候变的、为什么变"能不能被回答。**
**相关**：[ADR-010](../adr/ADR-010-versioned-seed-identity.md)、[identity-model.md](./identity-model.md)

---

## 1. 为什么这件事必须在 M3 做完

计划书第 125 节给了唯一但充分的理由：

> 未来 M11 会有 Adaptive Self。如果发现"角色变化了"，必须区分：
> **角色真的成长 / 开发者修改 Seed / 模型行为漂移**。
> 没有 Seed History 无法判断。

这个区分**只能在数据层面做**。等 M11 再补，M3–M10 期间的所有
Seed 改动都已经不可追溯了。

---

## 2. 四个必须同时产生的东西

每次 Seed 写入都必须同时产生：

```text
seed_version    内容版本（改一个字就 +1）
seed_hash       规范化内容的指纹
history row     character_definition_versions 里一条快照（不覆盖）
provenance      author / reason / effective_at
```

少任何一个都会留下一个无法回答的问题：

| 缺什么 | 无法回答的问题 |
|---|---|
| version | "她变过几次" |
| hash | "库里的内容是不是我以为的那份" |
| history | "两个月前她是哪一版" |
| provenance | "这一版是谁改的、为什么" |

---

## 3. 指纹（`seedHash`）

### 3.1 指纹材料 = 规范化 Seed 的稳定 JSON

```
CharacterDefinition
      │  canonicalizeSeed()      规范化（只保留契约内字段 + 固定顺序）
      ▼
CanonicalSeed
      │  canonicalSeedJson()     手写序列化（键顺序写死，不依赖对象书写顺序）
      ▼
  字符串  ──sha256──►  seedHash
```

### 3.2 规范化规则（写死在 `canonicalizeSeed` 里）

| 规则 | 为什么 |
|---|---|
| 字符串 trim；数组逐项 trim 后丢弃空项；空数组 → 缺失 | 消灭"多一个空格就换指纹"的假警报 |
| `strength` / `priority` 夹到 0..1，保留 6 位小数 | 消灭 `0.1+0.2` 这类浮点尾差 |
| `traits` / `values` / `preferences` **按名字排序** | 人对同一条人格的书写顺序不该改变指纹 |
| 对象键顺序写死（手写序列化） | 一次无害的字段重排不该改变指纹 |
| **`createdAt` / `updatedAt` / `provenance` 不进指纹** | 改一个时间戳不该让人格指纹变化 |

最后一条尤其重要。若不排除时间戳，每次启动都会得到不同的指纹，
于是"库内容与记录不一致"这个检查会永远报警 —— 而一个永远报警的检查
等于没有检查。

### 3.3 ⚠️ 一个真实踩过的坑：指纹排序与渲染顺序不一致

M3 实施中实测到的问题：

- `canonicalizeSeed` 会把 `traits` 按名字排序（见上表）
- 但 `renderSeedIdentity` 曾经直接用 `def.personality.traits` 的**原始顺序**

于是：**从库读回来的那一份**（按 canonical 顺序存的）与
**代码里那份**（按书写顺序）渲染出不同的文本 ——
**指纹相同、内容相同、显示却不同**。

症状是 SC-001 报"库里的 Seed 渲染结果与代码定义不一致（有人偷偷改了人设？）"，
而实际上没有人改。

**修法**：让渲染**从规范化结果出发**（`renderSeedIdentity` 内部先调
`canonicalizeSeed`）。于是指纹与文本共用同一个顺序定义，不可能再分叉。
不是"把渲染也排一遍" —— 那会留下两份排序规则，早晚再次漂移。

这个坑值得记住的教训是：**"内容相同"与"表示相同"是两件事**，
而一个既要算指纹又要渲染的结构，必须让两者共享同一个规范化步骤。

---

## 4. 两道闸

### 4.1 写入闸（`upsertCharacterDefinition`）

| 情形 | 结果 | 错误码 |
|---|---|---|
| 版本回退 | 拒绝 | `seed_version_regression` |
| 内容变了、版本没变 | 拒绝 | `seed_changed_without_version_bump` |
| 库内容与记录指纹不一致 | 拒绝 | `seed_hash_mismatch` |
| 版本没变、内容相同 | 幂等命中 | （返回库里的那份） |

### 4.2 读取闸（`buildIdentitySnapshot`）

重新算一次 hash 与库里记录比对。

**为什么两道都要**：写入闸只能拦"经过代码的写入"。
有人直接 `UPDATE character_definitions` 时它完全看不见，
而那正是"她怎么悄悄变了"最可能的形态。读取闸的成本是几微秒。

### 4.3 修复路径必须显式（刻意的不便）

库被绕过改过之后，系统**不会自愈**：

```text
普通 upsert
   → seed_hash_mismatch（读取闸先报）
   → 即使 acknowledge: 'repair' 让它过第一关
   → 又会撞上 seed_changed_without_version_bump（第二关）
```

修复必须写成：

```ts
await store.upsert(definition, { acknowledge: 'repair' })
```

`acknowledge` 是**字符串**而不是 boolean，取两个值：

| 值 | 含义 |
|---|---|
| `'legacy-backfill'` | 第一次把旧库升级到结构化 Seed（旧行没有 hash，谈不上不一致） |
| `'repair'` | 明确授权把库内容**覆盖回**代码定义（用于修复被改坏的库） |

"要不要丢掉库里的那一版"是一个需要人明确决定的事，
不该由一次启动悄悄完成。所以 `skipHashCheck: true` 这种"顺手关掉一个检查"
的写法被刻意排除了。

---

## 5. 修改规程

写成了代码里的常量（`SEED_CHANGE_PROTOCOL`），而不是文档里的一段话 ——
因为"改 Seed 要做什么"必须只有一处说明：

```text
1. 修改 src/kernel/identity/seed.ts 里的 SEED_VERSION（+1，只增不减）
2. 在 definition.provenance 里写清 author 与 reason
3. 写一条 ADR（与 ADR-007/010 并列）
4. 跑 pnpm m3:seed-check —— 它会打印新指纹并拒绝"内容变了不升版本"
5. 启动时服务会保留旧版本到 character_definition_versions（不覆盖）
```

### 5.1 v1 → v2 是结构升级，不是人格修改

M3 把 Seed 从"四段自由文本"升级为"结构化条目"，
因此 `SEED_VERSION` 从 1 升到 2。

**人设内容本身没有被改写**：`bio` / `adjectives` / `style` 的每一条
都原样保留在新结构里，只是被拆成了带强度、行为例子与反例的条目。
这一点写在 `seed.ts` 的注释里，因为它是判断"这次升版本算不算人格变化"
的唯一依据。

---

## 6. 只读自查

```bash
pnpm exec tsx src/main.ts --seed-status
```

输出四段：

```text
角色 / slug / seed 版本 / seed 指纹 / 结构版本

## 库内 vs 代码
   ✅ 一致            ← 正常
   ❌ 不一致且版本相同  ← "被绕过写入闸改过"的典型特征
   ⚠️ 不一致但版本不同  ← 正常：代码升版了，启动一次即同步

## Seed 版本历史（新的在前，带 author / reason）

## 当前 Seed 的内容摘要（traits / values / boundaries 逐条列出）
```

---

## 7. 不变量与守它的测试

| 不变量 | 守它的测试 |
|---|---|
| 内容变了不升版本 → 拒绝 | `verify-m3-persistence.ts` §3、`verify-phase-c.ts` §3 |
| 版本回退 → 拒绝 | 同上 |
| 库绕过写入闸 → 读取时发现 | `verify-m3-persistence.ts` §3 |
| 历史不覆盖旧版本，每个版本 hash 不同 | `verify-m3-persistence.ts` §2 / §7（T14） |
| 时间戳与 provenance 不进指纹 | `kernel-tests-identity.ts` |
| 数组顺序不影响指纹**与渲染** | `kernel-tests-identity.ts` |
| 100 轮对话后 Seed 完全不变 | `verify-m3-persistence.ts` §6（T3） |
| 无 author/reason 的变更被拒绝 | `verify-m3-persistence.ts` §8 |
| 每一轮 Trace 都带 seed_version / seed_hash | `eval:scenarios` + `--kernel-status` |
