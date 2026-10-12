# M5 Implementation Map — Repository Reconnaissance & Baseline（WP0）

> **WP0 交付物。** 用途：让 WP1–WP8 不必重新探索整个仓库（计划书 DSH PERFECTION RULES Rule 3）。
> 本文件只描述**已存在的真实代码**与**已决定/未决定的边界**，不描述实现。
>
> 证据：[`../../artifacts/m5/baseline.json`](../../artifacts/m5/baseline.json)、
> [`../../artifacts/m5/wp0-baseline.log`](../../artifacts/m5/wp0-baseline.log)
> 计划原文：[`M5-Execution-Plan.md`](./M5-Execution-Plan.md)
> 交接单：[`WP0-Handoff.md`](./WP0-Handoff.md)

WP0 日期：2026-09-17 · 分支基线：`feature/m4.5-action-foundation` @ `2c182d7`（干净工作树）

---

## 0. 前置校验（计划书 §0.2）

| 前提 | 判据 | 结论 |
|---|---|---|
| M4 PASS | `docs/m4/M4-Acceptance-Report.md`（RC1 曾 FAIL）→ `docs/m4/M4.1-Correctness-Fix-Report.md`（D1/D2-B 已修） | **PASS** |
| M4.1 fixes retained | `artifacts/m4.1/{mutation-safety,nl-mutation,smoke}/*` | **retained** |
| M4.5 PASS | `artifacts/m4.5/gate-results.json`（2026-09-17T08:02:16Z） | **PASS**；hard gates **G12 / G13 / G14 全 PASS** |

→ 允许进入 M5。若上述任一 hard gate 变为非 PASS，**WP1 必须 STOP**（不得绕过）。

---

## 1. AT0.1 现有组件定位（逐条实测，均为真实路径）

| 关注点 | 真实位置 | 说明 |
|---|---|---|
| Memory interfaces | `src/kernel/contracts/memory.ts` | `MemoryRecord` / `MemoryStatus` / `MemoryType` / `MemoryContent` / `MemoryEpistemicStatus` / `MemoryAuthority` / `EvidenceRef` / `MemoryCandidate` / `canonicalKeyOf` / `contentFingerprintOf` / `slotOfRecord` / `isRecallEligible` |
| Memory store | `src/infrastructure/persistence/memory-store.ts` | `MemoryQueryScope`(:86) / `MemoryStorePort`(:100) / `createNativeMemoryStore`(:578) / `applyMemoryEvent` / `rebuildMemory`；**刻意没有 `search()`**（:96 注释） |
| Memory recovery | `src/infrastructure/persistence/memory-recovery.ts` | 启动补折叠（未折叠领域事件 → 投影） |
| Memory reducer | `src/kernel/projections/memory.ts` | 六个 `MEMORY_*` 事件的纯折叠 |
| Memory 放行口 | `src/kernel/policies/memory-validator.ts` | 写入唯一放行口（幂等 / 权威 / 证据 / 槽位冲突） |
| Memory 应用层 | `src/kernel/app/memory/**` | `conflict.ts`（去重第二层 + 冲突分类）、`target-resolver.ts`（三态目标解析 + `scoreByHints`）、`explicit-service.ts` / `explicit-turn.ts`（显式路径）、`value.ts`（importance）、`provenance.ts`、`content-extractor.ts`、`extractor.ts`、`job.ts`、`admin.ts`、`pipeline.ts`、`response-truth.ts`、`memory-trace.ts`、`intent-detector.ts` |
| **Recall-related code** | **不存在** | 只有预留钩子，见 §2.6 |
| Context builder（旧链路） | `src/context/builder.ts` | M1 的 ElizaOS `composeState` 路径；主链路默认走编译器（`CHARACTER_CONTEXT_COMPILER_V1` 默认 on） |
| Context compiler（主链路） | `src/kernel/contracts/context.ts`（`ContextCompiler` / `ContextSection` / `ContextCompileInput` / `ContextPacket` / `applyBudget` / `sortSections`）＋ `src/kernel/context/sections.ts`（`buildContextCompilerV2` / `SECTION_IDS` / `SECTION_PRIORITY` / `composePromptFromPacket`） | **唯一 prompt 入口**（铁律 11） |
| Conversation runtime | `src/kernel/app/turn-gateway.ts`（`beginTurn` :~450 / `compileTurn` :728 / `promptFor` :842 / `completeTurn` :847）＋ `src/main.ts` `SarahRuntime.send()` :805、`buildGateway` :447 | 真实链路编排 |
| Runtime 适配 | `src/infrastructure/runtime/adapters.ts`（`renderCriticalStateSection` :45 / `recentContextLinesFrom` :71 / `callModelText` :220）、`conversation-recorder.ts`、`conversation-intent-resolver.ts`、`actor-resolver.ts` | provider/模型/账本适配 |
| CharacterState | `src/state/**`（`resolveCurrentState`、`renderStateBlock`）＋ `state/provider.ts` | 经 `critical-state` section（priority 60）进 prompt |
| Target Resolver | 记忆侧 `src/kernel/app/memory/target-resolver.ts`（`resolved` / `ambiguous` / `not_found`、`scoreByHints` :631）；动作侧 `src/kernel/action/target-resolver.ts`（ADR-032） | 两套不同用途，**不得互相替代** |
| Trace / Audit | `src/kernel/contracts/trace.ts`、`src/infrastructure/persistence/trace-store.ts`、`src/kernel/app/memory/memory-trace.ts`、`src/kernel/action/audit-invariants.ts` | 一条 trace 贯穿一轮 |
| M4.5 Action 基建 | `src/kernel/action/**`、`src/infrastructure/action/**` | `CapabilityRegistry` / `Policy` / `Gateway` / `action-ledger-store` |
| flags | `src/kernel/app/flags.ts`（`KernelFlags` :29、`readKernelFlags` :145、`describeKernelFlags` :251） | 开关必须**真的被消费**（M4.1 D3 教训） |
| Tests | `scripts/kernel-tests.ts`（`kernel:test`）、`scripts/future-compat-tests.ts`（`m3.5:test`）、`scripts/kernel-tests-memory.ts`（`m4:test`）、`scripts/kernel-tests-action.ts`（`m4.5:test`）、`scripts/verify-*.ts`（DB 子系统门）、`evals/**`（行为回归 + 人格评测） |

---

## 2. AT0.2–AT0.5 四条结论

### 2.1 AT0.2 — Memory validity 如何表达

```text
MemoryStatus = 'active' | 'superseded' | 'retracted' | 'disputed'   （contracts/memory.ts:123）
```

- **没有** `forgotten` / `deleted` 这两个字面量。显式"忘掉"折叠为 **`RETRACTED`**；删除原始对话是**另一件事**（MI-08），不得混同。
- `SUPERSEDED` = "当时可能为真，但现在有更合适描述当下情况的条"（`supersedes` / `supersededBy` 双向可追溯，MI-07）。
- `DISPUTED` = 矛盾证据且系统还判不了（可作为**降权**候选）。
- **M4 已经给出召回资格语义**：`isRecallEligible(status) = (status === 'active' || status === 'disputed')`（`contracts/memory.ts:139`，注释明写 `RETRACTED` 绝不允许召回）。
  ⚠️ 该函数**当前没有任何运行时消费者** —— WP2 的第一件事就是让它成为唯一判据。

### 2.2 AT0.3 — user / session / namespace 隔离字段

| 维度 | 载体 | 备注 |
|---|---|---|
| owner（Memory Space） | `MemoryRecord.owner: EntityRef`（必须 `kind === 'character'`；`ownerCharacterId()` :1222 失败关闭） | 一个角色一个 Memory Space |
| subject（这条记忆讲的是谁） | `MemoryRecord.subjects: EntityRef[]` ＋ 关系表 `memory_subject_links`（`migrations.ts:626`） | **用户是 subject，不是 owner** |
| 证据关系 | `memory_evidence_links` ＋ `sourceRefs` / `evidenceRootIds` | provenance |
| session / conversation | **不在 Memory 上**；在 `ConversationEvent`（`conversation_id`）与 `CharacterRunTrace.conversationId` | Memory 通过 `sourceRefs` 间接回到会话 |
| namespace | **没有独立字段**；等价物就是 `owner`（character） | "wrong namespace" 在 M5 里 = owner 不是当前角色 |

> ⚠️ 关键事实：`memory_records` **没有 `user_id` 列**。跨用户隔离只能靠 **subject 作用域**（`listBySubject(owner, subject)`）与资格过滤（§6 R1）。

### 2.3 AT0.4 — provenance / authority 如何表达

| 概念 | 表达 | 位置 |
|---|---|---|
| 权威 | `MemoryAuthority` 六级枚举 + `authorityRank` / `compareAuthority` | `contracts/memory.ts:200-238` |
| 认识状态 | `MemoryEpistemicStatus = reported / observed / inferred / generated` | `:163` |
| 证据 | `EvidenceRef { kind, id }`（非空，MI-03）＋ `evidenceRootIds`（派生证据继承，MI-03 弱形式） | `:265` / `:443` / `assertMemoryEvidence` :802 |
| 来源权威（对话侧） | `SourceAuthority` + `authorityFromSource` 映射 | `contracts/source-authority.ts` |
| 指纹 / 槽位 | `canonicalKey`（不含取值、含 qualifier scope）、`contentFingerprint`、`slotFingerprint` | `canonicalKeyOf` :597 / `contentFingerprintOf` :672 / `slotFingerprintOf` :741 |
| 产生者 | `processor` / `processorVersion` / `reducerVersion` | `MemoryRecord` |
| 人类可读摘要 | `summarizeRecord()` | `memory-store.ts:1095` |

> M5 的 provenance 要求（计划书 §WP6 AT6.4 / §WP7）**只需把上述既有字段往下传**：进 `ContextSection.sourceRefs`（形如 `memory:<id>`）与 trace attributes；**不新建第二套 provenance**。

### 2.4 AT0.5 — Prompt / Context assembly 的真正入口

```text
SarahRuntime.send()                      src/main.ts:805
  ├─ gateway.beginTurn()                 turn-gateway.ts        （写用户事件、显式记忆、动作）
  ├─ renderCriticalStateSection()        infrastructure/runtime/adapters.ts:45
  ├─ recentContextLinesFrom()            adapters.ts:71
  ├─ gateway.compileTurn()               turn-gateway.ts:728    ← 组装上下文
  │    └─ buildContextCompilerV2()       context/sections.ts:523（context-compiler@2）
  │         providers: identity-core / integrity-rules / critical-state / recent-conversation /
  │                    current-input / [memory-write-result] / [action-result]
  │         → createContextCompiler().compile()  contracts/context.ts:339（去重→排序→预算裁剪）
  ├─ gateway.promptFor(packet)           → composePromptFromPacket()  sections.ts:560
  └─ callModelText(prompt)               adapters.ts:220
```

- **唯一**允许拼 prompt 的出口是 `composePromptFromPacket`；任何模块都不得 `systemPrompt += memory`。
- 两条"本轮事实"section 是**扩展先例**：`createMemoryWriteResultProvider`（`sections.ts:396`，id `memory-write-result`）与 `createActionResultProvider`（`sections.ts:440`，id `action-result`），**都只在真的发生时产 section**，因此普通对话 prompt 与 M3.5 基线逐字节一致。
- 只读路径：`--dump-prompt` 走 `buildGateway({dryRun:true})`（`main.ts:447-517` 的 dryRun 分支不注入任何 writer）→ 因此**只读网关不能注入写路径**（已有回归锁）。
- Trace：每轮 `context_compile` step 记录 `sections` / `dropped` / `estimatedTokens` / `identityIncluded`（`turn-gateway.ts:820-835`）。

### 2.5 AT0.7 — 中文问句 → 记忆的词面桥（WP0 之后的补充实测，2026-09-17）

WP0 之后做了一次针对性调查（问题、命令与原始输出见
[`../../artifacts/m5/investigation-2026-09-17.json`](../../artifacts/m5/investigation-2026-09-17.json)）。
三条结论直接约束 WP2/WP3/WP4/WP8 的设计：

**(1) 桥是存在的 —— 不要另造词表。** M4.1 已经把"中文说法 → 槽位"的映射放在
**登记表**里（`contracts/memory-predicates.ts` 的 `description` + `examples`），
并由 `relevanceHaystack(record, includeRegistry=true)` 拼进词面 haystack；
`lexicalFragments()` 对 CJK 做 **二字 bigram**，因此「香菜」「大学」「生日」这类
二字片段能命中登记表的中文说明。`target-resolver.ts:518-533` 的组合已经是
M5 需要的形状：

```text
listBySubject(owner, subject) → 只留 status === 'active'
   → lexicalOverlapHits(用户原话, 候选, { includeRegistrySurfaceForms: true })
   → 命中 1 条 = resolved；命中多条 = 进第 4 步打分；0 条 = not_found（绝不猜）
```

这三个纯函数/方法（`lexicalFragments` / `lexicalOverlapHits` / `listBySubject`）都已导出，
**是 reused 而不是 new**。

**(2) 桥的覆盖度 = 登记表覆盖度。** 当前登记表只有 **10 个槽位**
（`food.preference.cilantro` / `food.avoid.general` / `education.status` /
`education.major` / `education.institution` / `preferred.explanation.style` /
`preferred.address` / `project.background.active` / `device.primary` /
`tooling.preference.editor`）。**未登记**的 predicate（例如 LLM 抽取器自造的
`person.birthday`，抽取 prompt 明确允许"确实没有合适的才自造点分隔小写键"）
在词面 haystack 里**只剩英文键 + 取值**，因此中文问句对它是**系统性不可召回** ——
除非取值本身含中文片段。这正是 WP4 允许把 `semantic relevance` 标
`not available` 的真实边界，也是 WP4 目标必须与机制对齐的原因。

**(3) `CREATE` 路径依赖线索词表，且出生日期这类说法根本没有槽位。**
实测（`pnpm exec tsx scripts/diag-m4-explicit.ts`）：

```text
「记住，我的生日是8月3日」        → ① 意图 ✅ ／ ② 内容抽取 ❌ content_unresolved
「记住，我现在上的大学是示例工程科技大学」→ ① ✅ ／ ② ✅ education.institution
```

`PREDICATE_RULES`（`content-extractor.ts:158-267`，**模块私有**，未导出）里
没有生日一类说法；`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED` 默认 **off**。
→ **E2E Scenario A 的 `用户生日 = X` 在默认装配下写不进库**，
召回再正确也无从验证（写入端会如实回 `content_unresolved`，她不会说"记住了"）。
另注：`生日` 在整个 `src/` 里**只出现一次**，且是 M4 的**反污染负样本**
（`contracts/memory.ts:846-848`：「猜猜我的生日」不得变成用户事实）——
M5 若把它当**正**样本，等于让同一个词承担两个相反的判据。

---

## 3. AT0.6 — M5 Implementation Map（reuse / extend / untouched）

| # | Existing component | File / module | M5 动作 | 理由 |
|---|---|---|---|---|
| 1 | Memory 领域契约（状态/权威/证据/指纹/候选） | `src/kernel/contracts/memory.ts` | **reuse**（不改；M5 契约放新文件） | 冻结区语义 + 事件 payload；M5 只读它 |
| 2 | `isRecallEligible()` | `contracts/memory.ts:139` | **reuse**（WP2 唯一资格判据） | M4 已给出语义，只缺消费者 |
| 3 | `slotOfRecord` / `slotFingerprintOf` / `canonicalKeyOf` | `contracts/memory.ts:597-784` | **reuse**（WP4 去重/冲突） | 同一套槽位定义，不得另造 |
| 4 | 冲突分类（duplicate vs temporal update） | `kernel/app/memory/conflict.ts`（:54 再导出槽位函数） | **reuse** | 方向相反的两种处置已有实现 |
| 5 | 目标解析三态 + `scoreByHints` | `kernel/app/memory/target-resolver.ts` | **reuse 纯函数** | 与 ADR-032 同一条"不确定就不猜"纪律（E2E 场景 E） |
| 6 | `MemoryStorePort` / `MemoryQueryScope` | `infrastructure/persistence/memory-store.ts:86-145` | **extend（append-only）或 wrap** | 见 §6 R4 与 §8 升级路径 |
| 7 | `memory_records` 的 M4 索引 | `migrations.ts:599-620`（`owner_status` / `owner_type` / `owner_canonical` / `recorded_at` / `processor`） | **reuse** | **M4 已为 M5 召回建好索引**（注释 :593 明写） |
| 8 | subject / evidence 关系表 | `migrations.ts:626`＋、`listBySubject` :619、`listBySource` :632 | **reuse** | 隔离与 provenance 的查询口 |
| 9 | ContextCompiler 排序/预算/去重 | `contracts/context.ts:339-472` | **untouched**（复用，不改算法） | 只有一套裁剪逻辑 |
| 10 | Section 装配与固定 id/优先级 | `kernel/context/sections.ts`（`SECTION_IDS` :54、`SECTION_PRIORITY`、`buildContextCompilerV2` :523） | **extend**：新增 `createMemoryRecallProvider`（`kind:'memory'`，priority `SECTION_PRIORITY.memory = 40`，`droppable: true`） | 计划书要求 memory 是**可裁剪的数据块**，与 `droppable:false` 的指令类 section 语义不同 |
| 11 | 本轮事实 section 先例 | `sections.ts:396` / `:440` | **参照**（不修改） | 只在真发生时产 section → 保住 prompt 基线 |
| 12 | TurnGateway 编排 | `kernel/app/turn-gateway.ts`（`compileTurn` :728、`promptFor` :842） | **extend**：`compileTurn` 内注入 recall 端口 + `extraProviders` + trace step | **M5 主插入点**（§4） |
| 13 | Trace 契约与表列 | `contracts/trace.ts:174` `selectedMemoryIds`、`migrations.ts:210` `selected_memory_ids`、`trace-store.ts:96/188` | **reuse + 首次填值**（关闭 compat-audit N2） | 列与读写路径都已存在 |
| 14 | `TraceStepKind` | `contracts/trace.ts:59`（含 `| (string & {})`） | **extend**：加 `'memory_recall'` 字面量 | WP7 需要可查询的步骤名 |
| 15 | flags | `kernel/app/flags.ts:29/145/251` | **extend**：`recallEnabled` + `CHARACTER_RECALL_ENABLED` + `record('recall', ...)` | 开关必须有真消费者（D3 教训） |
| 16 | 装配与只读网关 | `src/main.ts:447 buildGateway` | **extend**：real 与 dryRun **都**注入 recall（召回是只读） | `--dump-prompt` 必须能看到召回结果 |
| 17 | CharacterState | `src/state/**`、`critical-state` section | **untouched** | 状态不是记忆 |
| 18 | Memory 生命周期 / 遗忘 / supersede / 删除语义 | `kernel/app/memory/**`、`policies/memory-validator.ts`、store 的 `apply`/reducer | **untouched（冻结区）** | 计划书 WP2 明令禁止修改 |
| 19 | M4.5 Action 基建 | `kernel/action/**`、`infrastructure/action/**` | **untouched** | M5 无 External Effect（M5.5 才有） |
| 20 | prompt 逐字节基线 | `evals/fixtures/m3.5/prompt-baseline.txt`、`scripts/m3.5-prompt-baseline.ts`、`future-compat-tests.ts` FC-T08 | **必须守住** | WP6 判据：基准场景无记忆 → 0 section → prompt 不变 |
| 21 | Admin CLI / 只读分类 | `kernel/app/memory/admin.ts:190`、`src/invocation.ts:71-85`、`scripts/kernel-tests-memory.ts:3856` | **基本 untouched**；若新增 CLI 必须同步用法文本锁与只读分类 | 既有静态锁 |
| 22 | 门与证据约定 | `scripts/m4.5-gate-results.ts`、`artifacts/<milestone>/`、`docs/<milestone>/` | **复用**（M5 照此写 `m5:gates` / `artifacts/m5/`） | 计划书 §0.8 |

**M5 新增（尚不存在）**：`src/kernel/contracts/recall.ts`、`src/kernel/recall/**`（eligibility / ranking / selector / ports）、`src/infrastructure/persistence/memory-retrieval-store.ts`、`scripts/verify-m5-*.ts`。→ 新目录自动被 `kernel:test` 的依赖方向静态检查覆盖（禁 `@elizaos/` / `drizzle-orm` / `node:fs` / `node:path` / `node:child_process` / `phoenix` / `opentelemetry`；仅 `src/kernel/app/` 例外）。

---

## 4. "Where does M5 plug in?"（WP0 必须回答的问题）

> **M5 的插入点只有一处：`TurnGateway.compileTurn`（`src/kernel/app/turn-gateway.ts:728`）。**

```text
User Input（真实自然语言）
  ↓  main.ts send() → gateway.beginTurn()                 （已存在，不改语义）
  ↓  gateway.compileTurn()                                ← ★ M5 插入点
       ├─① RecallRequest（新契约，contracts/recall.ts）
       ├─② Target Resolution（复用 memory/target-resolver 三态纪律）
       ├─③ Candidate Retrieval（新端口 MemoryRetrievalPort → infrastructure 适配器）
       ├─④ Eligibility Filter（新纯函数模块，P0 安全层，唯一判据 isRecallEligible + subject/owner/target）
       ├─⑤ Ranking（复用 slotOfRecord + scoreByHints 的确定性打分）
       ├─⑥ Conflict / Dedup（复用 conflict.ts 的分类）
       ├─⑦ Context Selector + Budget（新纯函数）
       └─⑧ ContextBundle（新契约）
  ↓  createMemoryRecallProvider → ContextSection{ id:'memory-recall', kind:'memory', priority:40, droppable:true }
  ↓  composePromptFromPacket()                            （已存在的唯一 prompt 出口）
  ↓  Model → Response
另：selectedMemoryIds + 'memory_recall' step 写进同一条 CharacterRunTrace（列已存在，首次填写）
```

装配点：`src/main.ts` 的 `buildGateway`（:447）—— 与 `memoryWriter` / `actionWriter` **同一处**接线纪律（端口决定接没接上，开关决定要不要用）。
端口实现点：`src/infrastructure/persistence/memory-retrieval-store.ts`（只读，不新增依赖、不新增数据库）。

**绝不新增**：第二套 prompt 出口、第二套 ContextCompiler、第二套 trace、第二套 provenance、第二个数据库。

### M5 将消费的既有预留钩子

| 钩子 | 位置 | 现状 | M5 用途 |
|---|---|---|---|
| `ContextSectionKind = 'memory'` + `SECTION_PRIORITY.memory = 40` | `contracts/context.ts:47/:73` | 已登记、**无产出者** | WP6 的 memory data block |
| `character_traces.selected_memory_ids` | `migrations.ts:210` + `trace-store.ts` | 列存在、**恒 `[]`** | WP7 记录"这一轮真的用了哪几条" |
| `isRecallEligible(status)` | `contracts/memory.ts:139` | 无消费者 | WP2 的唯一资格判据 |
| `(owner_id,status)` 索引 | `migrations.ts:593/599` | 已建 | WP3 召回查询 |
| `ExternalEvidence` 位置 | 计划书 §WP5/§WP6 | **不存在**（非空实现留给 M5.5） | WP6 只预留 `externalEvidence = []` |

---

## 5. 必须保留的非回归原则（M4/M4.1/M4.5）

| 原则 | M5 不得破坏的地方 |
|---|---|
| Target Certainty | 目标不确定 → **不选**（复用 `ambiguous` 纪律），禁止随机实体召回 |
| Execution Truth / Measurement Truth | 不允许只测"Recall API 返回 200"；必须验证**模型实际拿到哪条 Memory**（packet 文本级判据） |
| Audit Trail | 一条 trace 贯穿；只记 id/hash/metadata，不复制敏感正文 |
| User Isolation | subject 级作用域 + owner 闸；`cross-user leakage = 0` |
| Memory Lifecycle | 不改 forget / delete / supersede 语义；召回**只读**，绝不写 Memory DB（`§0.3`） |
| Provenance / Authority | 沿用既有字段；memory 作为 **DATA**，不得升级为 instruction |
| 不变量清单（改动前先读） | `docs/architecture/invariants.md`（M1–M3.5 27 条）、`docs/architecture/memory-invariants.md`（MI-01~MI-15）、`docs/m4.5/M4.5-Architecture.md`（M4.5 六条） |

---

## 6. WP0 发现的 P0 风险（供 WP2/WP3 直接引用）

| # | 风险 | 证据 | 处置（归属 WP） |
|---|---|---|---|
| **R1** | `MemoryStorePort.list()` **只按 owner 过滤，不按 subject**：直接用它召回会把**该角色的所有用户**的记忆取回 → 跨用户泄漏面 | `memory-store.ts:644-657` | WP2 必须按 `subjects` 做显式作用域校验；WP3 优先 `listBySubject(owner, user)`。`list()` 只能作宽召回后的过滤输入 |
| **R2** | `listBySubject` **不过滤 status**（含 retracted / superseded） | `memory-store.ts:619-630` | 资格过滤是**唯一防线**，绝不能依赖查询层 |
| **R3** | `MemoryIndexPort`（compat-audit N4 称"M4 定义接口 + 提供 Noop"）**代码中不存在** | `grep MemoryIndexPort` 仅命中文档；仅 `memory-store.ts:22` 注释提到 `MemoryRetrievalPort` | WP1/WP3 必须**新建**检索端口（不是复用） |
| **R4** | `MemoryQueryScope` 无 subject / time / text 维度；`list()` 上限 500 且 `order by recorded_at desc`；无任何向量/语义索引 | `memory-store.ts:86-91, 644` | WP3 只做"宽召回 + 确定性打分"；语义相似度按计划书可标 `not available`，**不得伪造**；升级路径见 §8 |
| **R5** | 记忆侧目标解析是**逐条记录**的（不是实体级），"她喜欢什么？"在 Person A/B 共存时的实体归属尚无判据 | `target-resolver.ts`、E2E 场景 E | WP2/WP4：target 不足以确定 → `INVALID_TARGET` 排除，不猜 |
| **R6** | 既有**源码级静态锁**：`main.ts` 不得 import `memory/job`（`:4308`）、`memory:*` 脚本必须判为只读（`:4019-4037`）、Admin 用法文本必须含 `M5`（`:3856-3863`）、`flags` 消费锁 | `scripts/kernel-tests-memory.ts` | WP6/WP7 接线时不得踩破；新增 recall 开关**必须**同时加"真的被消费"的锁 |
| **R7** | **`--reset-kernel` 之后存在"孤儿记忆"**：`memory_records` 行存活且 `status=active`，但其事件流被删空 → 不可 replay、证据 link 指向已不存在的对话事件，而 `unsupportedMemories()` **看不见它**（它只数 link 行）。沙箱实测：`rebuildMemory` → `after=null` / `equal=false` / 差异 `['存在性（一条不存在）']`，`evidenceLink行数=1`，`conversation_events=0` | `event-store.ts:153`（`primary_source_event_id` = 对话事件 id）、`:709-775`（只删 6 张表，**不含** `memory_records` / 两张 link 表）、`memory-store.ts:1029-1055`（只看 link 行）、`main.ts:2128-2155`；原始输出见 `artifacts/m5/investigation-2026-09-17.json` | **M5 必须排除这类记忆**（否则会把"证据已不存在"的事实注入 prompt，且 WP7 的审计链指向空）。修 `resetKernelData` 属 **M4 领地**（新里程碑/ADR），不在 M5 内顺手改。记录为 **候选 BLOCKING DEFECT（D-7）** 交 WP2 裁定 |
| **R8** | **桥有覆盖边界**：未登记 predicate 对中文问句系统性不可召回（见 §2.5(2)）；登记表只有 10 个槽位 | `memory-predicates.ts:159-234`、`extractor.ts:555`（允许自造键） | WP4 的 `semantic relevance` 与 Gold Dataset 目标必须与"登记表覆盖度 + CJK bigram"这条机制对齐，否则数字会假绿 |

---

## 7. Deferred Issues（WP0 只登记，不修；计划书 §0.6 Rule 4）

| # | 问题 | 证据 | 归属 |
|---|---|---|---|
| D-1 | 文档漂移：README 称 `m4:test` **228 项**，实测 **243 项** | `docs/architecture/README.md:295` vs `artifacts/m5/baseline.json` | 记录，不修 |
| D-2 | `MemoryIndexPort` 在 `docs/m4/compatibility-audit.md:468`（N4）被记为"M4 定义接口 + 提供 Noop"，**代码中不存在** | grep 仅命中文档 | WP1/WP3 新建端口（见 R3） |
| D-3 | `MemoryQueryScope` 缺 subject / time / text；`listBySubject` 不过滤 status | `memory-store.ts` | WP3 处理（见 R2/R4） |
| D-4 | `docs/m4/current-state.md:275` 称 `m4:test` 断言 "`'memory'` section 仍无人产出"，**该断言不存在** | `scripts/kernel-tests-memory.ts` 内无此断言 | WP6 **新增**正向锁（防止"注入了但没人知道"） |
| D-5 | M4 技术债目标阶段标注 M5：T31/T32（迁移失败 / 清空重放用例）、语义去重第三层、`memory:audit` retracted 渲染（S4-1）、`hydrate` N+1（S4-2） | `docs/m4/M4-Technical-Debt.md`、`docs/m4/M4-Acceptance-Report.md:169-175` | **不自动纳入 M5**；由用户裁定 |
| D-6 | MI-11 跨进程场景缺口 | `docs/architecture/memory-invariants.md §16.1` | 沿用 M4 记录 |
| D-7 | **候选 BLOCKING DEFECT → 用户 2026-09-17 裁定：必须解决，且阻塞 M5**。`--reset-kernel` 不清理 `memory_records` / `memory_subject_links` / `memory_evidence_links` / `memory_events`，导致"ACTIVE 但不可 replay、证据已不存在"的孤儿记忆；`memory:audit` 的 "0 unsupported memories" 探针看不见它，`scripts/` 下**没有任何测试**调用过 `resetKernelData` | 沙箱实测（`artifacts/m5/investigation-2026-09-17.json`）+ **真库只读盘点 CLEAN**（`artifacts/m5/real-db-inventory.json`） | **插入 `M5-PRE / State-Integrity Hotfix`**（先写失败测试 → 修 `resetKernelData` → 修 `memory:audit` 悬空检测 → 重新 baseline M4 → 再进 WP1）。判据 = `liveEvidenceCountAfterReset`；Scope 见 `M5-Execution-Plan.md` 修订记录 |
| D-8 | 文档漂移：`docs/m4/current-state.md:275` 声称的"`'memory'` section 仍无人产出"断言不存在（同 D-4）；README `m4:test` 计数 228 vs 实测 243（同 D-1） | `grep` + 实测 | 记录，不修 |
| D-9 | **证据移除没有对应的事件**：要让"幸存记忆的失效 evidence link"也归零，需要为"证据被移除"追加一条领域事件（+ reducer 分支 + 迁移），否则删 link 会破 MI-11 的 `A == B`（`compareRecords` 比对 `sourceRefs`，而重放侧来自 `MEMORY_CREATED` 的 payload 快照）。本次 Hotfix 因此**刻意保留**该 link | `memory-store.ts:901-953`、`memory-integrity.ts` 的"幸存者：刻意不动它的 evidence link"；`verify-m4-memory-integrity.ts` 场景②a | **新里程碑**（动冻结区：领域事件 + reducer + 迁移）；M5 内不做 |

> **附：AT0.7 调查的三条结论**（中文词面桥存在 / 桥覆盖度 = 登记表覆盖度 /
> 生日这类说法在默认装配下写不进库）见 §2.5 与
> [`../../artifacts/m5/investigation-2026-09-17.json`](../../artifacts/m5/investigation-2026-09-17.json)。

---

## 8. 计划落地路径与升级路径（WP1+，本文件只登记）

| WP | 落点 | 门 / 证据 |
|---|---|---|
| WP1 | `src/kernel/contracts/recall.ts`（RecallRequest / MemoryCandidate / RecallDecision / ContextBundle / RecallExclusionReason + schema 校验 + 稳定序列化；**不依赖任何 DB**） | `pnpm m5:test`（WP1 才加脚本）；`artifacts/m5/contracts.json` |
| WP2 | `src/kernel/recall/eligibility.ts`（集中判定，唯一处） | 正控 + 六负控；`forgotten / wrong-user / invalid-target leakage = 0` |
| WP3 | `src/kernel/recall/ports.ts` + `src/infrastructure/persistence/memory-retrieval-store.ts` | 混合 fixture：宽召回 → 资格过滤后非法候选全部消失 |
| WP4 | `src/kernel/recall/ranking.ts` | M5 Retrieval Gold Dataset（must_recall / distractor / historical / superseded / duplicate，Top-5 ≥ 95%） |
| WP5 | `src/kernel/recall/selector.ts` | `total <= configured budget` 恒成立 |
| WP6 | `context/sections.ts`（新 provider）+ `turn-gateway.ts` + `main.ts:447` + `flags.ts` | 指令隔离负控；无召回普通对话不回归；FC-T08 仍绿 |
| WP7 | 复用 `CharacterRunTrace` / `selectedMemoryIds` / 新 `'memory_recall'` step | 只记 id/hash/metadata；"目标记忆未进 Context 必须失败" |
| WP8 | `scripts/verify-m5-nl.ts`、`scripts/verify-m5-smoke-live.ts`（照 `verify-m4.5-smoke-live.ts`：生产库只复制、沙箱指向临时目录） | `m5:gates` / `m5:ci` / `m5:ci:full`；A–H 场景 + 全量回归 |

**升级路径（仅当 R4 被证明不可接受时）**：向 `memory-store.ts` **append-only** 追加一个只读 `listCandidates(scope)`（含 subject / status / time 过滤），随后重跑 `m4:*` 相关门（`m4:test` / `m4:verify` / `m4:isolation:verify` / `m4:mutation-safety:verify` / `m4:nl-mutation:verify`）并在报告中记录。默认**不**走这条路（Rule 6：extend > rewrite，且冻结区只允许追加）。

---

## 9. 明确不做（Scope Fence，计划书 §0.4）

Web Search / Browser / Internet / Autonomous Planner / World Simulation / World Model / External Tool Execution /
Filesystem Action（新增）/ Email / Calendar / Multi-Agent / Voice / Avatar —— 全部属 M5.5 或更后。
M5 不新增 npm 依赖、不新增数据库、不接向量库 / Graph DB、不改 `package.json` 的既有脚本语义。
