# ADR-001：Character Kernel 的边界与依赖方向

- **状态**：已采纳（M2.5）
- **日期**：2026-09-16
- **相关**：[character-kernel.md](../architecture/character-kernel.md)、`scripts/kernel-tests.ts`

## 背景

M1/M2 的实现里，"角色状态"直接由 `src/state/` 与 ElizaOS 的 `memories` 表承载。
这套结构能跑，但它有一个结构性上限：**状态和它的来源混在一起**。

具体表现：
- `character_states` 只有"最后一次的值"，没有"这个值是怎么来的"。
- `state_events` 有 `reason` 文本，但**没有指向具体对话事件的引用**。
- "什么算角色状态"这件事散落在 provider、repository、main.ts 三处。

在继续加 Memory / Relationship / Affect / Belief / Goals / Reflection 之前，
必须先有一条**唯一**的链路，否则每加一个认知模块就多一套平行逻辑
（"Memory 自己改数据库、Relationship 自己维护状态、Reflection 自己写 Persona"）。

## 决策

建立 **Character Kernel**，并强制单向依赖：

```
Runtime / Transport
      ↓
Character Application Layer      src/kernel/app/
      ↓
Character Domain                 src/kernel/{contracts,identity,policies,projections,context}
      ↑
Infrastructure Implementations   src/infrastructure/
```

`src/kernel/**`（除 `app/`）**不许** import：

```
@elizaos/*   drizzle-orm   node:fs   node:path   node:child_process   phoenix   opentelemetry
```

这条约束由**静态测试**守着（`kernel-tests.ts` 扫描 import 行），
不是靠 code review 记着。

## 被否决的方案

### 方案 A：不立边界，边加功能边重构

**否决理由**：M4–M11 有八个认知模块。每个模块接入时都会"顺手"多写一点
数据库访问，八次之后依赖方向就再也理不清了。而且这种腐化是**不可逆**的——
事后再拆的代价远高于一开始就立好。

### 方案 B：用分层目录但不加测试

**否决理由**：这条约束是**最容易违反**的一条（实施过程中真的违反了一次，
见下），而它的违反**不会表现为任何运行期错误**——程序照常工作，
只是三个月后没人知道为什么改一个字段要动七个文件。
没有测试守着的分层约定等于没有。

### 方案 C：把 Application 层也算进 Domain（只保留一层）

**否决理由**：装配逻辑（从运行时投影 Seed、建仓储、接遥测）**必须**
知道基础设施，否则它装不起来。硬压成一层会导致领域文件里出现 SQL。
分成 Domain + Application 两级，比"一个都不许知道 SQL"更可执行。

## 后果

**正面**
- 换数据库不动领域代码；换模型不丢状态；换运行时不动 Seed 构造。
- `kernel-tests` 可以**完全离线、毫秒级**跑完（因为领域层没有 I/O）。
- 新增认知模块有唯一落点，新增的只是 Processor + Reducer，不是新架构。

**负面 / 成本**
- 需要一层适配器（`seed-projection.ts`、`adapters.ts`）。这是真实成本：
  一个字段的投影要在两个文件里各写一次。
- 边界测试需要维护（新增目录时要考虑它算 Domain 还是 Application）。

## 实施记录：一次真实的违反

`src/kernel/identity/seed.ts` 最初 import 了 `@elizaos/core` 的 `Character` 类型
来投影 Seed。看起来无伤大雅（只用类型），但边界测试立刻报出：

```
实际: ["\\src\\kernel\\identity\\seed.ts → @elizaos/"]
```

修法是**分开职责**，而不是放宽测试：

| 现在 | 位置 | 认识什么 |
|---|---|---|
| `SeedProjectionInput` + `buildCharacterDefinition` | `kernel/identity/seed.ts` | 只认识字符串 |
| `characterDefinitionFromCharacter` | `infrastructure/runtime/seed-projection.ts` | 认识 ElizaOS `Character` |

额外收益：Seed 的构造从此不依赖运行时，
测试夹具与未来任何网关都能用同一个函数造出同一个 Seed。
