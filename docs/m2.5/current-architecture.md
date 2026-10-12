# M2.5 Phase A — 当前架构盘点（只读扫描结果）

**扫描时间**：2026-09-16（M2.5 开工前）
**扫描方式**：只读。未修改任何现有代码、未写入任何数据库。
**代码基线**：`b049631 L1-M1/M2 严格验收：35/35 全部满分`
**工作区**：`C:\Users\user\Desktop\project LG`（本项目仅在此工作区运行）

---

## 1. 技术底座（实测，非推测）

| 项 | 实际值 | 证据 |
|---|---|---|
| 语言 / 运行时 | TypeScript（ESM，`"type": "module"`）+ Node **v22.23.2** | `package.json`、`node --version` |
| 执行器 | `tsx`（无构建步骤，直接跑 `.ts`；import 带 `.ts` 后缀） | `node_modules/.bin/tsx` |
| Agent Runtime | **ElizaOS `@elizaos/core` 1.7.2** | `package.json` dependencies |
| 持久化 | **PGlite**（嵌入式 Postgres）+ `@elizaos/plugin-sql` 1.7.2 | `scripts/diag-db.ts` → `adapter = PgliteDatabaseAdapter` |
| 查询层 | `drizzle-orm` 0.44.7，但**只作传递依赖使用**（不能直接 import 表定义） | `src/state/repository.ts` 顶部注释 |
| 模型 | DeepSeek 官方端点 `deepseek-flash`，走 `/chat/completions` | `.env`；`src/providers/openai-compatible.ts` |
| 包管理 | pnpm 12.4.1（`registry=https://registry.npmjs.org/`，见 `.npmrc`） | `pnpm --version` |
| 类型检查 | `pnpm typecheck` = `tsc --noEmit`，`include: ["src/**/*.ts"]` | `tsconfig.json` |
| 测试 | 自研 runner `scripts/run-tests.ts`（`pnpm test`）+ 验收套件 `scripts/verify-l1-suite.ts`（`pnpm verify:l1`） | `package.json` scripts |
| 观测 | **无**（仅 `logger` 文本日志 + `runtime.events` 事件打印） | `src/main.ts` `attachEventLog()` |

`package.json` 目前**没有** promptfoo / OpenTelemetry / Phoenix 相关依赖。

---

## 2. M1 已实现什么（L1-M1：角色能活起来）

| 能力 | 实现位置 | 说明 |
|---|---|---|
| Runtime 装配 | `src/main.ts` `buildRuntime()` | `AgentRuntime` + `settings` 显式播种（`getSetting()` 不读 `process.env`） |
| 数据库初始化 | `src/db/index.ts` `initDatabase()` | **先 `runPluginMigrations()` 再 `initialize()`**（否则查 `agents` 表必失败） |
| 角色定义 | `src/character/苏沐薇.ts` | ElizaOS `Character`：bio / adjectives / style / messageExamples |
| 模型 provider | `src/providers/openai-compatible.ts` | 自研 `priority=10` 的 `TEXT_LARGE`/`TEXT_SMALL`，覆盖官方插件的 Responses API |
| 输出解析 | 同上 | 用 core 的 `parseKeyValueXml` 从 `<response><text>` 取正文，`<thought>` 留存 |
| 对话循环 | `src/main.ts` `ChatSession` | 脚本模式（多句一次跑完）+ 交互模式（`Alex: ` 提示符） |
| 消息持久化 | `runtime.createMemory(msg, 'messages', true)` | **消息与记忆同在 `memories` 表**，`type='messages'` 区分 |
| 上下文组装 | `src/context/builder.ts` | `runtime.composeState()` → `composePromptFromState(messageHandlerTemplate)` |
| 确定性 ID | `stringToUuid()` | world / entity / room / message id 全部由稳定字符串推导，重启不变 |
| 事件日志 | `attachEventLog()` | `runtime.events` 是 `{event: handler[]}` 字典（不是 EventEmitter） |

**M1 的 ChatSession 关键事实（M2.5 必须接住）**：

```
send(text):
  1. nextTurn()            ← turn = 房间内已有消息条数（跨进程单调，见下）
  2. createMemory(用户消息) ← 幂等 onConflictDoNothing
  3. markInteraction()     ← 推进 last_interaction_at（挂钟衰减锚点）
  4. buildTurnContext()    ← composeState + 模板渲染
  5. runtime.useModel(TEXT_LARGE, {prompt})
  6. createMemory(回复消息)
```

> `nextTurn()` 的历史坑：不能用进程内计数器，否则新消息 id 撞上上一轮运行的 id，
> 被 `unique=true` 的 `onConflictDoNothing` **静默丢弃**（表现为"聊了但历史没涨"）。

---

## 3. M2 已实现什么（L1-M2：Persistent CharacterState）

**注意命名碰撞**：现有 `L1-M2` 是**状态持久化**里程碑，与新版路线图的
`M2`（用户口述中的"已完成 M2"）**不是同一件事**。M2.5 只重构架构，两者都要保住。

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 状态模型 | `src/state/types.ts` | 四变量：`valence`[-1,1]、`arousal`[0,1]、`trust`[0,1]、`closeness`[0,1] |
| 初始值 | 同上 `INITIAL_STATE` | trust 0.85、closeness 0.60、情绪中性；**理由写进 `state_events.reason`** |
| 单轮上限 | 同上 `MAX_DELTA_PER_TURN` | trust ±0.05、closeness ±0.03、情绪 ±0.25（"绝不让 LLM 直接写状态值"） |
| 挂钟衰减 | `src/state/decay.ts` `applyDecay()` | **纯函数**；情绪指数衰减（半衰期 4h/5h），**trust 不随时间变**，>24h 无互动 closeness 按 0.02/天下行 |
| 状态持久化 | `src/state/repository.ts` | 自研表 `character_states`（角色×用户一行）+ `state_events`（before/delta/after/reason/trigger） |
| 建表 | 同上 `ensureStateTables()` | 原生 DDL，全部 `IF NOT EXISTS`，**无迁移版本表** |
| 状态 provider | `src/state/provider.ts` | `CHARACTER_STATE`，`position=50`；数值 → **确定性语义解释 + 行为倾向** |
| 插件封装 | `src/plugin/persistent-character.ts` | `createPersistentCharacterPlugin(ids)` 只注册 provider |
| 初始化 | `src/state/init.ts` `initCharacterState()` | 迁移后调用；首次建档写 `trigger='init'` 事件 |
| 可观测 | `src/state/inspector.ts` `renderInspector()` | `--inspect`：状态四值 + 版本 + 距上次互动 + 最近变更理由 |
| 干跑模式 | `src/main.ts` `dryRun` | `--test`：真实对话但**不落消息、不记 state_events、不推进时间** |
| 实验隔离 | `src/dev/sandbox.ts` | 三层强制：`isolateDatabase()` + `initDatabase` 写保护闸 + 只有 `main.ts` 调 `allowProductionDatabase()` |

### 实测数据库现状（`scripts/diag-db.ts`，生产库 `data/pglite`）

```
public schema 表（20 张）：
  ElizaOS 自带：agents, cache, central_messages, channel_participants, channels,
                components, embeddings, entities, logs, memories,
                message_server_agents, message_servers, participants,
                relationships, rooms, servers, tasks, worlds
  自研（M2）：  character_states, state_events
```

- 消息表是 **`memories`**（`type='messages'`），不是 `messages`。
- 自研表用**原生 DDL**，与 ElizaOS 的 Drizzle 迁移体系**互不隶属**。

---

## 4. 现有持久化方式（M2.5 要动的地方）

| 数据 | 表 | 写入者 | 问题 |
|---|---|---|---|
| 对话消息 | `memories`（ElizaOS） | `ChatSession.send()` | ①**无角色级全局序号**；②`turn` 由"条数"推导，删除消息会重号；③user/assistant 只能靠 `entityId` 区分，**没有显式 actor 字段** |
| 角色状态快照 | `character_states`（自研） | `saveState()` | 只有"最后一次的值"，**无法从中重建历史**；非事件溯源 |
| 状态变更 | `state_events`（自研） | `recordStateEvent()` | `before/delta/after` 是 JSON 快照，**无 source conversation event 引用**，无法回答"这次变化源于哪轮对话" |
| 角色定义 | 代码 `src/character/苏沐薇.ts` | 人工 | **无版本号**（只有 `seedVersion` 概念缺失）、无 DB 记录 |

**关键缺口（M2.5 必须补）**：

1. 对话事实没有**不可变、有序、可定位**的账本（`memories` 可被删、可重号、无 actor）。
2. 状态变更**不可重放**：`state_events` 不是 reducer 的输入，只是日志。
3. 没有 **Proposal → Validator → DomainEvent** 这条唯一变更链；`setStateVariable()`
   这种"直接写值"的路径仍然存在（虽有 trigger=manual 留痕）。
4. 没有 **idempotency key**：后台任务重试必然产生重复副作用。
5. 没有 **Trace / Receipt**：无法回答"这一轮她到底看到了什么、用了哪个 Context 版本"。
6. 没有 **Context Compiler 单入口**：`buildTurnContext()` 是唯一入口、但**不产生结构化
   `ContextSection`/`ContextPacket`**，Trace 无法表达"用了哪些 section"。
7. `tsconfig.include` 只有 `src/**/*.ts`，**`scripts/` 与 `evals/` 不在类型检查内**。

---

## 5. 现有消息生命周期（逐跳）

```
用户 stdin
  │
  ▼  rl.question() / argv
ChatSession.send(text)                         [src/main.ts]
  │
  ├─ nextTurn():  getMemories(count=1000) → turn = length
  ├─ createMemory(userMemory, 'messages', true)  ← 落库（dryRun 时跳过）
  ├─ markInteraction()                           ← 推进衰减锚点（dryRun 时跳过）
  ├─ buildTurnContext(runtime, userMessage)      [src/context/builder.ts]
  │     ├─ runtime.composeState(message, includeList?, onlyInclude?)
  │     │     └─ providers: BOOTSTRAP 内置 + CHARACTER_STATE(position 50)
  │     └─ composePromptFromState({state, template: messageHandlerTemplate})
  ├─ runtime.useModel(TEXT_LARGE, {prompt})      [src/providers/openai-compatible.ts]
  │     └─ POST {OPENAI_BASE_URL}/chat/completions → parseKeyValueXml(<text>)
  ├─ createMemory(agentMemory, 'messages', true) ← 落库（dryRun 时跳过）
  └─ console.log 回复
```

**状态侧**（读时结算，无后台任务）：

```
CHARACTER_STATE provider.get()
  └─ resolveCurrentState()
        ├─ loadState()       读 character_states（查不到则建档）
        └─ applyDecay(state) 惰性结算挂钟衰减（不写库、不推进 last_interaction_at）
```

---

## 6. 现有 Prompt 构造路径

```
src/context/builder.ts:buildTurnContext()
  → runtime.composeState()
        provider 输出合并进 state.text
  → composePromptFromState({ state, template: messageHandlerTemplate })
  → runtime.useModel(TEXT_LARGE, { prompt })
```

- `CHARACTER` provider 提供人设（`character.system` **故意留空**）。
- `RECENT_MESSAGES` 提供最近 `CONVERSATION_LENGTH=16` 条。
- `CHARACTER_STATE` 提供数值 + 语义解释 + 行为倾向（`position=50`）。
- **没有 token 预算**、**没有 section 优先级**、**没有预算裁剪**。
- `--dump-prompt` 只读导出完整 prompt 到 `data/prompt-dump.txt`（不写任何数据）。

---

## 7. 分类结论（M2.5 的处置策略：Adapter > Migration > Rewrite）

### 7.1 可以保留（不动）

| 模块 | 理由 |
|---|---|
| `src/character/苏沐薇.ts` | 就是 **Seed Identity** 的内容源；M2.5 只给它加"版本 + 独立存储 + 固定 Provider" |
| `src/state/types.ts` / `decay.ts` | 纯函数、可确定性重放；将直接作为 `character-state` reducer 的内部算法 |
| `src/providers/openai-compatible.ts` | 与架构无关的模型接入层 |
| `src/db/index.ts` | 迁移顺序的坑已修好；只在其后追加我们自己的迁移 |
| `src/dev/sandbox.ts` | 三层隔离是既有铁规，M2.5 新表**必须**同样受它约束 |
| `src/state/inspector.ts` | 可观测性入口，M2.5 只追加（不替换） |
| `src/plugin/persistent-character.ts` | 插件边界正确，M2.5 在其旁边加新插件 |

### 7.2 与新架构冲突（必须走 Adapter 或迁移）

| 现状 | 冲突的规则 | 处置 |
|---|---|---|
| 消息只存在 `memories`，无 actor/序号 | 铁律 3、8；SC-002 来源区分；SC-003 顺序 | **Adapter 双写**：`ChatSession` 每轮额外写 `ConversationEvent`（M2.5 阶段不替换 `memories`） |
| `character_states` 是"最后的值" | 铁律 9（Projection 必须可重放） | **新建 Projection 骨架**，M2.5 阶段**双写**；`character_states` 继续服务 M1/M2 行为 |
| `state_events` 无 source 引用 | 铁律 8（可回溯源头） | 新建 `DomainEvent` 并在其中引用 `sourceConversationEventIds`；旧表保留 |
| `setStateVariable()` 直接写值 | 铁律 4（LLM 不能直接改 canonical state） | 保留给测试/Inspector，但**标记为绕过链路的兼容路径**，M2.5 中主链路不再使用 |
| `buildTurnContext()` 无结构化 section | 铁律 11；SC-006 | **Rewriter 包一层**：`CharacterContextCompiler` 成为唯一入口，内部仍复用 `composeState`，但产出 `ContextPacket` |
| 无 trace | 可观测性要求 | 新建 `character_traces` + `TelemetryPort` |
| 自研表无迁移版本 | 第 60 节（禁止启动时随意 CREATE/ALTER） | 新建**版本化迁移表** `character_schema_migrations`；旧表的 `IF NOT EXISTS` DDL 保留但登记为迁移 0001 |
| `tsconfig.include` 缺 `scripts/`、`evals/` | CI 需要 typecheck 覆盖 | M2.5 扩展 include |

### 7.3 只需要 Adapter

| 目标 | Adapter |
|---|---|
| 真实消息 → `ConversationEvent` | `ConversationEventRecorder`（挂在 `ChatSession.send()` 的两个落库点） |
| 旧状态快照 ↔ 新 Projection | `character-state` reducer 复用 `applyDecay` 的算法，Projection 读模型映射到旧 `CharacterState` 形状 |
| ElizaOS 事件 → Trace | `attachEventLog()` 扩展为 `TraceRecorder` |

---

## 8. M2.5 落地决策（在盘点结论之上，逐条可追溯）

1. **CharacterId 直接使用既有稳定 UUID**：`00000000-0000-4000-8000-000000000001`
   （`character.id`）。它不依赖 Session / 模型 / 登录用户 / Runtime 实例 / 数据库行号，
   已满足第 8 节全部要求；另提供人类可读别名 `char_sumuwei` 作 `slug`。
2. **不新增 npm 硬依赖**：Phoenix 走 OTLP/HTTP JSON 直发（Node 内置 `fetch`），
   不引入 `@arizeai/*`；Promptfoo 作为**可选 dev 工具**，缺失时 Eval 走内部 harness。
   理由：第 74/78 节明确反对 speculative architecture 与重量依赖。
3. **新表与旧表并存**：M2.5 只增不改。旧 `character_states`/`state_events` 继续
   服务 M1/M2 已有行为；新表通过双写接入，Phase J 之前不做替换。
4. **dry-run 不得产生任何事件**：`--test` 模式连 `ConversationEvent` 也不写。
   这是"测试不写入记忆"规矩在 M2.5 的延伸，也是 SC 系列的前提。
5. **实验隔离继承**：所有新表读写都经过 `getRawDb()` 与 `initDatabase()` 的写保护闸，
   实验脚本忘记 `isolateDatabase()` 会在 `initDatabase` 处失败（既有三层防护不变）。
6. **Projection 作用域**：`(character_id, projection_type)` 唯一。需要按用户区分的
   投影把 `userId` 编进 `projection_type`（如 `relationship:user:<uuid>`），
   而不是给投影加一个"作用域"旁路字段。
7. **测试基建缺口**：现有 `scripts/run-tests.ts` 是 700 行单文件集成测试，
   不适合承载 M2.5 的 deterministic 契约测试。M2.5 新增
   `scripts/kernel-tests.ts`（自研 mini runner，零依赖），并保留原 runner 不动。

---

## 9. 结论

M1/M2 的实现是**扎实且自洽**的：状态真的落库、衰减是纯函数、实验隔离是代码强制的、
干跑模式真的不写库。它缺的不是"更多功能"，而是**把已有事实提升为可审计、可重放、
可顺序化的骨架**。

M2.5 因此不需要推倒任何东西：

```
已有：CharacterState(值)         → 补：DomainEvent(变化) + Projection(可重放)
已有：memories(消息)             → 补：ConversationEvent(不可变账本 + 序号 + actor)
已有：buildTurnContext(拼接)     → 补：ContextCompiler(结构化 + 可追溯)
已有：state_events(日志)         → 补：Trace/Receipt(这一轮看到了什么)
```

这条盘点结论直接决定 Phase B–J 的实施顺序：
**先立契约（B）→ 再立持久化（C）→ 双写接真实对话（D）→ 接管 Context（E）
→ 打通诊断纵切（F）→ 补可靠性（G）→ 接观测（H）→ 建评测（I）→ 收尾（J）。**
