# Character Kernel —— 边界与依赖方向

## 谁是"她的状态"的拥有者

```
                    Runtime / Transport（ElizaOS / CLI / 未来的网关）
                                  │
                                  ▼
                    Character Application Layer
                       kernel.ts / turn-gateway.ts / flags.ts
                                  │
                                  ▼
                       Character Domain
          contracts / identity / policies / projections / context
                                  ▲
                                  │
                    Infrastructure Implementations
              persistence / runtime 适配 / telemetry
```

**唯一合法的依赖方向是从下往上**（Infrastructure 实现 Domain 定义的接口），
而不是 Domain 反过来知道 SQL、模型 SDK 或观测后端。

`src/kernel/` 下除 `app/` 之外的文件里，出现下列 import 会**直接让测试失败**：

```
@elizaos/*   drizzle-orm   node:fs   node:path   node:child_process   phoenix   opentelemetry
```

守着它的是 `scripts/kernel-tests.ts` 的「Kernel 边界（依赖方向）」用例 ——
这是 M2.5 里唯一一条**静态**不变量，也是最早被违反的一条（见下）。

---

## 一次真实的违反，以及它带来的教训

M2.5 实施过程中，`src/kernel/identity/seed.ts` 一开始 import 了
`@elizaos/core` 的 `Character` 类型去投影 Seed。

它看起来无伤大雅（只用了类型），但边界测试立刻报了出来：

```
❌ Kernel 边界（依赖方向） :: 领域层不 import 任何基础设施 / Runtime / SQL / 观测后端
   实际: ["\\src\\kernel\\identity\\seed.ts → @elizaos/"]
```

修法不是"把测试放宽"，而是**把职责分开**：

| 现在 | 位置 | 认识什么 |
|---|---|---|
| `SeedProjectionInput` + `buildCharacterDefinition` | `kernel/identity/seed.ts` | 只认识字符串 |
| `characterDefinitionFromCharacter` | `infrastructure/runtime/seed-projection.ts` | 认识 ElizaOS `Character` |

这次分离带来一个额外好处：Seed 的构造从此**不依赖运行时**，
所以测试夹具、未来的 HTTP 网关、甚至一个完全不同的运行时
都能用同一个 `buildCharacterDefinition` 造出同一个 Seed。

---

## Character Kernel 包含什么

```
Character Kernel
├─ Identity            Seed Identity（她是谁）        → identity/
├─ Event Ledger        事实账本 + 变化历史            → contracts/event-*.ts
├─ Memory              长期认知（M4）                 → 预留 MemoryBackend 契约
├─ Relationship        关系（M7）                     → 预留 projection 契约
├─ Affect              情绪（M8）                     → 预留 projection 契约
├─ Belief              看法（M9）                     → 预留 projection 契约
├─ Goals               目标与承诺（M10）              → 预留 job/proposal 契约
├─ Adaptive Self       后来的自己（M11）              → 预留 Seed modifier 语义
├─ Reflection          反思（M11）                    → 预留 causedBy 派生链
├─ Projection          当前状态（可重放）             → projections/ + contracts/projection.ts
├─ Context Compiler    唯一 Prompt 入口               → context/
└─ Policy              唯一放行口                     → policies/validator.ts
```

**模型不是 Kernel，数据库不是 Kernel，Embedding 不是 Kernel，
ElizaOS Runtime 也不是 Kernel。**

它们的区别很具体：把数据库换掉，Kernel 的所有类型一个字都不用改；
把模型换掉，她的经历与状态一条都不会丢。

---

## 三处刻意的最小化

### 1. Validator 只认识"id 与归属"

`ProposalSourceLookup.findEvents()` 返回的是 `{id, characterId, sequence}`，
**不含正文**。

理由：校验器不需要读聊天内容。少给它一份能力，它就少一份被误用的可能，
也更容易测（构造三个字段就能测全部失败路径）。

### 2. Processor 拿到的是"能力"而不是"句柄"

Processor 需要问"这件事我做过没有"，于是它拿到的是
`createProcessedOperationStore(db)` 返回的 `{ hasProcessed }`，
而不是整个数据库句柄。

于是"Processor 只能问、不能写"是结构性的，不是靠约定。

### 3. Context 的 section 内容由外部给，排序与预算在内部定

`ContextSectionProvider` 负责**取内容**（它才知道数据库与角色状态），
`ContextCompiler` 负责**排序、裁剪、量化、记录来源**。

这样"状态在上下文里排第几"是一个可审计的常量（`SECTION_PRIORITY`），
而不是某处 `+=` 的偶然结果。

---

## 哪些东西**没有**推翻

M2.5 的默认策略是 **Adapter > Migration > Rewrite**（plan 第 4 节）。
实际保留下来的 M1/M2 资产：

| 保留 | 为什么 |
|---|---|
| `src/character/苏沐薇.ts` | 它就是 Seed 的内容源；只加了"版本 + 独立存储 + 固定 Provider" |
| `src/state/types.ts` / `decay.ts` | 纯函数、可确定性重放，直接复用为状态语义 |
| `src/providers/openai-compatible.ts` | 与架构无关的模型接入层 |
| `src/db/index.ts` | 迁移顺序的坑已修好；只在其后追加我们自己的版本化迁移 |
| `src/dev/sandbox.ts` | 三层隔离是既有铁规，新表同样受它约束（并修了一个真实缺陷，见下） |
| `src/state/inspector.ts` | 只追加，不替换 |
| `memories` 表的全部读写 | 双写，`--history` / `CHARACTER_STATE` 完全不受影响 |

### 顺带修掉的一个真实缺陷：数据库隔离其实没生效

`src/dev/sandbox.ts` 的 `isolateDatabase()` 原本用 `Date.now()` 生成目录名。
同一个进程内连续隔离两个库时，毫秒相同就会拿到同一个目录。

更隐蔽的是第二个问题：`@elizaos/plugin-sql` 把 PGlite 客户端缓存在
**`globalThis` 上的进程级单例**里（`pluginSqlClientManager ??= ...`）——
**一个进程里只有第一个数据库会生效**。

症状是"看起来在正常工作"：SC-002 只有 2 轮对话，却读到了 86 条事件
（它读的是 SC-001 的库）。

修法（两处，都在 `sandbox.ts`）：
1. 目录名加进程内自增序号；
2. 新增 `resetPluginSqlConnection()`，切换数据库前先关掉旧连接再清掉单例。

以及一个**探针** `assertConnectedToSandbox()`：万一上游换了缓存策略，
它会立刻炸出来，而不是等到"某个场景莫名多读了 84 条事件"。
