# M3 验收报告 — Identity & Conversation Integrity

**阶段**：M3
**性质**：身份完整性 / 对话事实完整性 / 人格稳定性
**前置**：M2.5 Architecture Foundation 已通过 Gate
**下一阶段**：M4 Reliable Long-Term Memory
**报告日期**：2026-09-16
**基线 commit**：`70ea753`（M2.5 收口）→ M3 实施后见 §8

---

## 0. 一句话

> M3 让系统第一次能够可靠地区分**"苏沐薇是谁"、"真正发生了什么"、
> "谁说了什么"和"模型只是生成了什么"**。

M3 **不负责让她记住更多东西**。它负责保证未来产生的 Memory
建立在正确历史之上 —— 它是 Memory 之前的事实防火墙。

---

## 1. M3 交付物对照（计划书第 168 节）

| 计划书要求 | 落点 | 状态 |
|---|---|---|
| CharacterDefinition v1 | `kernel/contracts/character-definition.ts`（v2 结构化） | ✅ |
| Versioned Seed Identity | `seedVersion` + `seed_hash` + `character_definition_versions` | ✅ |
| IdentitySnapshot | `kernel/contracts/identity-snapshot.ts` | ✅ |
| IdentityProvider | `kernel/context/sections.ts` 的 `createIdentityCoreProvider` | ✅ |
| CharacterIdentityService | `kernel/app/identity-service.ts` | ✅ |
| UserId / CharacterId / ConversationId | `kernel/contracts/actor.ts` + `identity-store.ts` | ✅ |
| ActorRef | `kernel/contracts/actor.ts` | ✅ |
| MessageNormalizer | `kernel/contracts/message-normalizer.ts` | ✅ |
| ConversationIntegrityService | `kernel/app/conversation-integrity-service.ts` | ✅ |
| ConversationLedgerPort | `kernel/contracts/ledger-port.ts` + `persistence/ledger.ts` | ✅ |
| SourceKind | `kernel/contracts/source-authority.ts` | ✅ |
| SourceAuthority | 同上（白名单，恰三种） | ✅ |
| Assistant Fact Firewall | `canSupportExternalFact()` + `sourceAuthority` 列 | ✅ |
| Context Compiler v2 | `context-compiler@2`（identity-core + integrity-rules） | ✅ |
| Seed Context Section | `identity-core`（不可裁剪） | ✅ |
| Integrity Rules Section | `integrity-rules`（不可裁剪） | ✅ |
| Expanded Character Trace | 八步 run tree + 身份属性 | ✅ |
| Phoenix/OpenInference spans | `m3:phoenix` 35/35（真实后端回查） | ✅ |
| Promptfoo M3 suite | 12 个 YAML，`eval:m3:promptfoo` 12/12 | ✅ |
| Persona drift test | `long-dialogue` + `adversarial-role-change` | ✅ |
| Anonymous persona test | `anonymous-persona`（T12） | ✅ |
| Personality interview test | `personality-interview`（T13，20–40 题） | ✅ |
| Database migrations | 迁移 0003 | ✅ |
| Unit / Integration / Scenario tests | `kernel:test:identity` / `kernel:test:conversation` / `m3:verify` | ✅ |
| Long-dialogue tests | `M3_DRIFT_TURNS`（50 / 100 两档） | ✅ |
| Architecture docs | `docs/architecture/` 5 份新增 | ✅ |
| ADRs | ADR-007 ~ ADR-012 | ✅ |
| M3 verification report | 本文件 | ✅ |

---

## 2. 验收数字（实测）

### 2.1 离线门（`pnpm m3:ci`，退出码 0）

| 套件 | 结果 |
|---|---|
| `pnpm typecheck`（含 `evals/`、`scripts/`） | pass |
| `pnpm kernel:test` M2.5 领域契约 | **26 / 26**（9ms） |
| `pnpm kernel:test:identity` **M3** Seed Schema / 指纹 / 渲染 / 快照 | **25 / 25**（5ms） |
| `pnpm kernel:test:conversation` **M3** 来源 / 序号 / reply graph / 归一化 | **47 / 47**（2ms） |
| `pnpm kernel:verify` Phase C 持久化 | **25 / 25** |
| `pnpm m3:verify` **M3** 持久化（写闸 / 历史 / provenance / 身份表 / **运行期强制** / **迁移路径**） | **67 / 67** |
| `pnpm m3:migrate-gate` **M3** 迁移闸（真实库不得悄悄迁移） | **17 / 17** |
| `pnpm m3:seed-check` Seed 自检（结构 + 漂移） | pass |
| `pnpm eval:scenarios` SC-001 ~ SC-007 | **7 / 7** |
| `pnpm eval:m3` **M3** 评测离线档 | **20 / 20** 用例，**105 / 105** 确定性检查 |
| `pnpm eval:telemetry` Phase H | **54 / 54** |
| `pnpm eval:otlp` 官方 OTLP schema | **21 / 21** |
| `pnpm eval:dryrun` 干跑静默性 | **15 / 15** |
| `pnpm eval:providers` Provider 白名单 | **11 / 11** |

**M3 的硬零指标全部为 0**（计划书第 115–118 节）：

```text
SeedMutationViolationCount        0
AssistantToFactContaminationRate  0
ConversationEventLossRate         0
EventOrderingErrorRate            0
```

### 2.2 外层 Runner

| 套件 | 结果 |
|---|---|
| `pnpm eval:promptfoo`（M2.5 的 7 个场景） | **7 passed / 0 failed / 0 errors** |
| `pnpm eval:m3:promptfoo`（M3 的 12 个套件） | **12/12 套件全绿，12 passed / 0 failed / 0 errors** |

### 2.3 真实观测后端（`pnpm phoenix:up` + `pnpm m3:phoenix`）

| 检查 | 结果 |
|---|---|
| M3 Phoenix 验证（含八步 run tree 后端回查） | **35 / 35** |
| `PHOENIX_RUN_LIVE=1 pnpm eval:telemetry` | **58 / 58** |
| `pnpm eval:phoenix-chat` 真实对话 → Phoenix | **7 / 7** |

关键实测事实（不是"HTTP 200"就算过，而是**从后端查回来**）：

```text
✅ 八步 run tree 在 Phoenix 里逐节点可见 — 8/8：
   message_normalize, actor_resolve, conversation_persist_input, identity_load,
   context_compile, model_generate, output_validate, conversation_persist_output
✅ 能按 input event id 指纹定位到本次这一轮 — 匹配 2 个 span（共 57 个）
✅ 这一轮有 character.turn 根 span
✅ 能查到 seedVersion=3（在 character.identity_load 上）
✅ step 的 attributes 里不含对话正文（隐私原则，计划书第 73 节）
✅ Phoenix 不可达时整轮不抛异常（遥测不是运行时依赖）
```

### 2.4 真实模型档（人格评测）

| 套件 | 结果 |
|---|---|
| `pnpm eval:m3:live` 覆盖 | **16** 条用例 / **21** 条 judge 检查 |
| 实测 baseline（5 次运行） | PC **0.881**（var 0.0071）｜SA **0.559**（var 0.123）｜Drift **0.640**｜Recovery **1.000** |
| 单套件样例（`value-consistency`） | PC **0.963**（0.95 / 0.90 / 1.00 / 1.00） |

> ⚠️ **人格阈值尚未冻结**，这是计划书第 119/120 节要求的顺序：
> 第一轮只建立 baseline，第二轮才冻结 Gate Threshold。
> 实测数字与"为什么还不能冻结"的判读见 §9。

---

## 3. WP Gate 判定（计划书第 134–143 节）

| WP | Gate 要求 | 判定 |
|---|---|---|
| WP1 | M2.5 仍全绿 / 入口已找到 / 无人格第二来源 | ✅ 见 [`../m3/current-state.md`](../m3/current-state.md) §8 |
| WP2 | Seed Schema / Version / Hash / Migration / 旧人格导入 | ✅ `kernel:test:identity` 25/25；迁移 0003；v1→v2→v3 历史保留 |
| WP3 | 所有主 Agent 调用都由 IdentityProvider 得 Seed，无第二来源 | ✅ `TurnGatewayOptions.identity` **必填**；`identity-core` section；`kernel:test` 依赖方向守住 |
| WP4 | CharacterId / UserId / ConversationId / RuntimeId 全部明确且测试通过 | ✅ `m3:verify` §1/§5；T1/T2 |
| WP5 | 所有 User / Assistant Message 都形成 ConversationEvent，且 sequence / actor / reply graph 正确 | ✅ `m3:verify` §4；`kernel:test:conversation` |
| WP6 | Assistant 生成内容不被错标成用户事实；System / Tool 同样隔离 | ✅ `kernel:test:conversation` T4–T8；`m3:verify` §4；硬零指标 0 |
| WP7 | 主 Agent 100% 经过 ContextCompiler v2，不得绕过 | ✅ 默认 `context-compiler@2`；`eval:m3` 的 `compiler-is-v2` 断言；`eval:scenarios` SC-006 |
| WP8 | Phoenix 能查看完整 Character Run Tree；Phoenix 停止角色仍能工作 | ✅ `m3:phoenix` 35/35（后端回查八步全在） |
| WP9 | Promptfoo identity / integrity / 50-turn drift / Anonymous / Personality Interview 可运行 | ✅ 12 套件 12/12；离线 20/20；live 档可运行 |
| WP10 | restart / session switch / concurrency / persona override / long dialogue / source contamination / seed version migration 全部通过 | ✅ 见 §4 测试矩阵 |

---

## 4. M3 测试矩阵（计划书第 98–113 节 T1–T15）

| # | 测什么 | 落点 | 结果 |
|---|---|---|---|
| T1 | Character ID Stability（重启后不变） | `m3:verify` §1；`session-restart` 套件 | ✅ |
| T2 | Conversation Isolation（同用户两会话） | `m3:verify` §5；`new-conversation` 套件 | ✅ |
| T3 | Seed Stability（100 轮后完全不变） | `m3:verify` §6（100 轮实测） | ✅ |
| T4 | Self-Fabrication（她编的经历不成事实） | `kernel:test:conversation`；`assistant-fabrication` 套件 | ✅ |
| T5 | Assistant Guess 不产生 `user_fact` | 同上 | ✅ |
| T6 | User Confirmation → `USER_REPLY_CONFIRMATION` | `m3:verify` §4；`user-correction` 套件 | ✅ |
| T7 | System Isolation | `m3:verify` §4；`source-separation` 套件 | ✅ |
| T8 | Tool Isolation | 同上 | ✅ |
| T9 | Identity Override（Seed 不变） | `adversarial-role-change` 套件；`m3:verify` §3 | ✅ |
| T10 | Session Switch（不复制全部历史、无伪 Memory） | `new-conversation` 套件 | ✅ |
| T11 | Long Dialogue Drift（50 / 100 turn） | `long-dialogue` 套件（`M3_DRIFT_TURNS`） | ✅ |
| T12 | Anonymous Persona | `anonymous-persona` 套件 | ✅ |
| T13 | Personality Interview（20–40 题） | `personality-interview` 套件 + 题库 | ✅ |
| T14 | Seed Version Change（新版生效、旧 Trace 保留旧版） | `m3:verify` §7 | ✅ |
| T15 | Invalid Seed Mutation（普通聊天改不了 Seed） | `m3:verify` §3 / §8 | ✅ |

---

## 5. 实施中发现并修复的真实缺陷

**这一节是 M3 报告里最重要的部分。** 每一条都是"看起来正常、实际错了"，
而不是"代码写错了会报错"。

### 5.1 `repliedToSourceKind` 从未落库（生产代码缺陷）

`NewConversationEvent` 声明了 `repliedToSourceKind`，`ConversationLedgerPort`
老老实实传了它，但 `createConversationEvent` 忘了把它转发给 `buildProvenance`。

**后果**：T6"用户确认"这条 M3 的核心语义**只活在内存返回值里** ——
内存里看到 `USER_REPLY_CONFIRMATION`，从库里读回来却是 `USER_EXPLICIT`。

**为什么没被立刻发现**：当时的断言检查的是**返回值**，
而返回值恰好是在 `appendConversationEvent` 内部构造的。

**教训**：*"声明了字段"不等于"字段会被用到"*，而*"断言返回值"也不等于"断言落库"*。
因此 M3 专门加了一条"从库里读回来仍是 `USER_REPLY_CONFIRMATION`"的断言。

### 5.2 评测宿主在任何模式下都不调模型（评测缺陷，最严重）

`sayOnce()` 返回的是合成串 `<m3-echo compiler=… sections=…>`。
于是 live 档把那段合成串当成"她的回答"交给 judge，
judge 很诚实地给出 **0.05** 并说明"回答只有一段系统编译标记，没有任何实际内容"。

**而报告里那个 0.05 看起来像一个真实结论（"她价值取向不对"）。**

修法：把 judge 的口与**角色自己**的口分成两个类型
（`ModelInvoker` / `CharacterModelInvoker`），并让 `modelMode` 的判定依据
从"有没有 judge 的口"改成"有没有角色自己的口"。

**修完的同一个套件**：PC mean **0.425 → 0.963**。

**教训**：*评测里最危险的不是失败，而是"数字看起来合理但量的是错的东西"。*

### 5.3 评测的检查只跑最后一条观测

`evaluate()` 只把 `observations[observations.length - 1]` 交给检查。于是：

- **装置造的观测**（T6/T7/T8 的关键）**永远不被判定** ——
  症状是"装置没有成功写入系统事件"，而库里那条事件是对的
- **前置轮次**（`prelude`）的事件被漏掉

修法：逐条观测跑，**任一通过即通过**；全都没过时把各条的结论都带上。

### 5.4 用 `Symbol` 当运行环境句柄的键（跨进程静默失效）

评测的扩展面挂在 `Symbol.for('…')` 上，理由是"不会撞名"。
但报告要经 `JSON.stringify` 写进 `--json`、并经 Promptfoo 的 provider
**跨进程**传递 —— 而 **Symbol 键在序列化时静默消失**。

症状：*本地直接跑没问题，走 Promptfoo 就变成拿不到运行环境句柄*。

修法：改成带命名空间的字符串键。

### 5.5 渲染顺序与指纹排序不一致（生产代码缺陷）

`canonicalizeSeed` 会把 `traits` 按名字排序（为了指纹稳定），
而 `renderSeedIdentity` 直接用原始顺序。于是**从库读回来的那一份**与
**代码里那份**渲染出不同文本 —— **指纹相同、内容相同、显示却不同**。

症状：SC-001 报"库里的 Seed 渲染结果与代码定义不一致（有人偷偷改了人设？）"，
而实际上没有人改。

修法：让渲染**从规范化结果出发**（指纹与文本共用同一个顺序定义）。

**教训**：*"内容相同"与"表示相同"是两件事*。

### 5.6 Seed 漏掉三条核心身份倾向（内容缺陷）

v2 只把 `adjectives` 里的词当作需要结构化的倾向名，
于是 `bio` 里那两句最定义性的设定 ——
「对陌生人警惕」「唯独对用户毫无防备」—— 以及「受不了长时间分开」
**静默地从 Seed 里消失了**：结构化定义写好了，却没有任何一条路径
会把它们放进定义，渲染出来的身份文本里也就没有它们。

**是 M3 自己的评测抓出来的**（`M3-ID-002`：Seed 缺少倾向）。
修法：`CORE_IDENTITY_TRAITS` 无条件包含；`SEED_VERSION` v2 → v3；
`m3:seed-check` 正确地把这次改动识别为"版本已升、指纹随之变化（正规变更）"。

### 5.7 Trace 的前四步被静默覆盖（生产代码缺陷）

`traceWriter.finish({ steps })` 会**整体覆盖**那一列，而不是追加。
于是 `beginTurn` 写的四步（`message_normalize` / `actor_resolve` /
`conversation_persist_input` / `identity_load`）被 `completeTurn` 的四步整个盖掉。

**症状极隐蔽**：trace 有、section 有、身份属性有，看起来一切正常，
只有"八步 run tree"少了一半 —— 而 WP8 Gate 正是要它能逐节点回答
"这一步花了多久"。

**发现方式**：`m3:phoenix` 的"八步逐节点存在"断言（离线库内检查就抓到了）。
修法：先读回已有 steps、拼接、再写。

### 5.8 环境缺陷：`pnpm` 脚本在 cmd.exe 下全部失败

`package.json` 里全部脚本写的是 `node_modules/.bin/tsx` —— POSIX 写法。
在本机 cmd.exe 下**全部失败**：

```text
'node_modules' is not recognized as an internal or external command
```

也就是说 M2.5 当时的验收**无法按 README 的命令复现**。
修法：改成直接写 `tsx` / `promptfoo`（pnpm 会把 `node_modules/.bin` 放进 PATH）。

### 5.9 迁移一个**已有**的库会让启动失败（生产阻塞，最严重）

**这一条是 M3 收口自查时发现的，而且它真的会让生产起不来。**

迁移 0003 给 `character_definitions` 加了 `definition_json` 列，但
**已经存在的那一行不会因此拥有它**（仍是 `null`）。而 `rowToDefinition`
刻意拒绝"凭旧的自由文本反推一份看起来像新结构的 Seed" ——
两者相遇的结果是：**真实库一升级到迁移 3，每条命令都在启动时抛
`seed_definition_json_missing`**。

实测复现（在真实库上跑干跑）：

```text
Info  [kernel] schema 迁移 2 → 3：#3 m3-identity-and-conversation-integrity
Error Seed 00000000-0000-4000-8000-000000000001 缺少 definition_json
      （迁移 0003 之后的 Seed 必须有）…
[命令挂住 600 秒后超时]
```

**为什么全部 100+ 项检查都没抓到它**：每一个夹具都是**全新库**
（先跑迁移、再建档），因此"迁移一个**已有** Seed 的库"这条路径
**从来没有被测过**。迁移类改动最典型的盲区正是这个：

> **测的是"新建"，坏的是"升级"。**

**修法**（三层）：
1. `needsDefinitionBackfill(db, id)` —— 把"旧行需要装载"变成**可查询的事实**
2. `upsertCharacterDefinition` 在旧行上走 `writeSeedRow({ backfill: true })`：
   **允许同版本覆盖结构**（缺的是结构不是内容，因此不是"她变了"），
   装载用的是**代码里的定义**，不是从旧文本反推的
3. `db:inspect` 增加一行 `Seed 结构化表示已装载 / 缺 N 行 → 启动会失败`

**并且补了回归测试**（`m3:verify` §9）：人造一条 M2.5 形态的旧行，
断言"严格读取会报错 → 装载成功 → 幂等"。这是唯一能覆盖它的办法，
因为我们不能在夹具里"先建一个 M2.5 时代的库"。

修复后实测（真实库，只读体检）：

```text
✅ Seed 结构化表示已装载（v3）
✅ M3 的四张新表也都在（迁移 0003 已应用）
   memories 4 / character_states 1 / conversation_events 4   ← 真实数据一字未动
```

### 5.10 排查过程中的一次自伤（记录在案）

用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 批量改 `src/main.ts` 时，
编码在 GBK 往返中被破坏（中文全变 mojibake）。

**处置**：`git checkout -- src/main.ts` 还原，改用文件工具重做全部编辑。
**教训**：改文本文件**只用文件工具**，不要用 `Get-Content`/`Set-Content` 往返 ——
它在这个中文 Windows 环境下会改变编码。

---

## 5.11 收口：M3 的服务**曾经没有接进应用**（架构承诺与真实行为分叉）

**这是 M3 里性质最严重的一类问题**，因为它让"架构承诺"与"跑着的代码"
悄悄不一致 —— 而全部测试都是绿的。

### 问题

M3 实现了这些组件，但**运行期一条都没用**：

| 组件 | 收口前的状态 |
|---|---|
| `ActorResolver` | 只有 `verify-m3-persistence.ts` 引用 |
| `MessageNormalizer` | 只有 `kernel-tests-conversation.ts` 引用 |
| `createConversationLedger`（四个具名写入方法） | 只有验证脚本引用 |
| `ConversationIntegrityService`（四条规则） | **连实例化点都没有** |
| 身份表（三张） | 运行期 **0 行** |

运行期实际链路是 `main.ts → ConversationRecorder → appendConversationEvent`
**直调仓储层**。

### 实测证据（`scripts/diag-m3-runtime-integrity.ts`，收口前）

```text
探针 1：悬空 replyToEventId（指向不存在的事件）→ ⚠️ 写入成功
探针 4：会话内序号跳号（1 → 50）              → ⚠️ 写入成功
探针 2：user_message 配 character（伪造来源）  → ✅ 被拦住
探针 3：空正文                                → ✅ 被拦住
探针 5：user_identities / user_identity_mappings /
        conversation_identities                → ⚠️ 全部 0 行
```

也就是说：`createConversationEvent` 原有的闸**仍在守**，
但**四条完整性规则与身份解析没有在生产路径上生效**。

**为什么验收报告一度说得过满**：报告里写"T6 reply graph 校验 ✅"，
而那测的是 `ConversationIntegrityService` 这个**从未被调用的类**。
断言全绿，但**测的不是跑着的代码** —— 与 §5.2 是同一个模式的错误，
只是这次犯在架构验证上。

### 收口后（实测）

```text
【路径 A】recorder —— 真实对话走这条，规则必须生效
  ✅ A0 正常写入用户消息
  ✅ A1 悬空 reply 被拒 — reply_target_missing
  ✅ A2 assistant 缺 reply 被拒 — reply_target_required
  ✅ A3 序号跳号被拒 — conversation_sequence_gap
  ✅ A4 伪造来源被拒 — actor_type_mismatch
  ✅ A5 连续写入不被误拦
  ✅ A6 user_identities 已落库（1 行）／conversation_identities 已落库（1 行）
【路径 B】原始仓储层 —— 唯一需要 allowSequenceGap 才允许空隙的地方
  ✅ B1 未声明 allowSequenceGap 的跳号被拒
  ✅ B2 显式 allowSequenceGap 才允许，且如实上报 sequenceGap
探针结果：11 通过 / 0 失败
```

### 改了什么

1. **`ConversationRecorder` 的全部写入改经 `ConversationLedgerPort`**
   （四个具名方法），不再直调仓储层
2. **身份变成"由第一件真实发生的事带出来"**：`ensureIdentity()` 在
   `recordUserMessage` 与 `recordAssistantMessage` 上都跑，
   落 `user_identities` / `user_identity_mappings` / `conversation_identities`。
   这样"遗忘登记"不再可能 —— 而它遗忘的症状（身份表空着）
   在单用户下**连续躲过了 48 项持久化验证**
3. **`userId`（领域身份）与 `userRef`（transport 身份）拆开**。
   曾经的实现把 `userId` 当 externalId 再喂回推导函数，
   于是算出**一个新的 userId** —— 症状是 `conversation_identities` 有行
   而 `user_identities` 0 行（"看着落库了，其实登记的是别人"）。
   这正是计划书第 25 节"transport 身份不得混用"要防的事
4. **会话内序号连续性**：recorder 与仓储层都守；空隙必须显式
   `{ allowSequenceGap: true }`（只有历史回填传它），
   且返回值如实上报 `sequenceGap`
5. **补了 12 条自动化断言**（`m3:verify` §5b），全部打在
   **recorder 这条真实路径**上，而不是打在完整性服务上

### 关于原始仓储层

`appendConversationEvent` 是**低层原语**，业务代码不应直接调它。
它的现有调用者只有三处：`ledger.ts`（正确）、`backfill.ts`（显式声明空隙）、
以及测试脚本。

> **一个语义上的区分必须写清**：仓储层允许"显式声明的空隙"，
> 而真实对话路径**不允许**空隙。把两者混在一起看会得出
> "她可以跳号"这个错误结论。

---

### 5.12 Schema 升级改为**显式动作**（`--migrate`）

由 §5.9 那次事故直接引出的一条规矩。

**问题**：迁移 0003 是在某次普通启动里悄悄发生的 ——
人本来只是想看看她的状态，结果库的 schema 被改了，而且改完就起不来。

**现在的规矩**：

```text
普通命令（chat / --inspect / --seed-status …）
    发现真实库有待应用迁移 → **拒绝启动**，打印待办清单与升级命令
pnpm migrate            只读预览：待应用哪些迁移、各多少条语句、风险提示
pnpm migrate:apply      确认后应用
```

**判据是"是不是真实库目录"**，不是"是不是沙箱"：

- 判"是不是沙箱"会把**忘了调 `isolateDatabase` 的脚本**在临时目录上一起拦住 ——
  那些脚本本来也碰不到真实数据，拦它只是噪声
- 判"是不是真实库"正好对上这条闸的目的：**别让她的数据在没人看着的时候被改 schema**

**怎么测的（这一点值得记下来）**：

端到端验证需要让 `data/pglite` 真的处于"有待应用迁移"的状态 ——
而那意味着**动真实库**。我们不能为了测一条保护真实库的闸而去动真实库。

因此判断逻辑被抽成纯函数（`(目录, 待办数, 是否放行) → 该不该拦`），
`m3:migrate-gate` 断言它的**全部分支**（6 条）与错误信息的形状（6 条），
再在**真实副本**上跑一次完整路径（5 条）—— 真实库全程只被复制、从不被打开写入。

```text
迁移闸验证：17 通过 / 0 失败
  ✅ 真实库 + 有待办 + 未放行 → 拦（这是那次事故的形态）
  ✅ 真实库 + 有待办 + 已放行 → 放行（migrate:apply 走这条）
  ✅ 真实库 + 无待办 → 放行（日常启动走这条）
  ✅ 临时/沙箱目录 + 有待办 + 未放行 → 放行（一次性库不该被拦）
  ✅ 目录未指定 → 放行（无法判定就不拦）
  ✅ 目录是真实库的父目录也算重叠 → 拦
  ✅ 错误信息含待办清单 / 语句数 / 两条命令 / "本次没有改动任何数据"
```

> **一条通用教训**：当"验证某条保护措施"需要**破坏它要保护的东西**时，
> 正确做法是把判断逻辑抽成纯函数 —— 否则你会为了测而冒那个风险，
> 最后选择"跳过测试"，于是保护措施无人守。

---

## 6. 未完成 / 已知限制

| 项 | 状态 | 说明 |
|---|---|---|
| **身份表在当前部署下是"空转"的** | **如实说明** | 三张身份表（`user_identities` / `user_identity_mappings` / `conversation_identities`）**已接线并会在聊天时真正写入**（§5.11 实测），但当前是**单用户、单 transport 的 CLI**：userId 由 `stringToUuid('user-Alex')` 确定性推导，因此表里只有一行、也不会发生"解析"。它们的价值在**接入第二个 transport（HTTP / QQ / Discord）时**才真正兑现 —— 那时"换平台仍是同一个人"必须靠映射表，而不是靠重算 |
| 人格阈值未冻结 | **刻意** | 计划书第 119/120 节：第一轮只建立 baseline。实测值见 §9，等人工看过 mean/variance 后显式写进 `baseline.json` 的 `minimums` |
| **`eval:m3:live` 单次运行不能当回归判据** | **重要** | `SA` var 0.123、`Drift` var 0.104（标准差 ≈ 0.32）。**单次运行的 SA 可能在 0.20–0.55 之间波动**，把它当门槛会让红绿取决于随机性。判据应当是 `--runs 3` 以上的均值 |
| `M3-INT-VALUE` 稳定 0.50 | 真实信号 | Personality Interview 的价值冲突题判据偏严，需要收紧 rubric 或明确"方向对即可"的判分口径 |
| M1/M2 的 `A1 自述名字` 有 flakiness | **非 M3 引入** | 实测：新链路 3 次里失败 1 次（她说"你谁。我不认识你。"）；**旧链路（`CHARACTER_CONTEXT_COMPILER_V1=0`，即 M2.5 基线路径）同样会失败**。因此这是模型方差（temperature 0.3）叠加沙箱内 trust 偏低，**不是 M3 的回归**。但它意味着 M2.5 卡片里"45/45 连续三次一致"是当时的观测，而非现在的稳定性质 |
| 双写 `memories` + `conversation_events` | 仍在 | M2.5 遗留（Phase J 未收口），不影响 M3 的任何保证 |
| Job 调度器 | 只有表与契约 | 待 M4 |
| Token 预算 / Conversation Rollup | 未做 | 属 M5 |
| 长对话 500+ turn | 未做 | 属 M6（计划书第 58 节）；M3 覆盖 50/100 两档 |
| 多模型 judge | 未做 | 计划书第 121 节；当前 judge 与角色用同一模型（已在 ADR-012 记为已知限制）。**这是 PC 分数最需要警惕的地方**：自评会有系统性偏差 |
| `POST /internal/test/chat` | 未实现 | 计划书第 51 节的建议。M3 的评测改为**进程内**调用评测宿主（`evals/m3/runtime/host.ts`），理由是它同时避免了 API 端口与"谁写库"的问题。若要给外部 Runner 用，仍需这一层 |

---

## 7. M3 Exit Criteria 逐条判定（计划书第 162 节）

### Identity

```text
✅ CharacterId 稳定                  —— m3:verify §1/§5（T1/T2）
✅ Seed 单一真源                     —— ADR-007；TurnGatewayOptions.identity 必填
✅ Seed version/hash 工作            —— kernel:test:identity 25/25；m3:seed-check
✅ 普通聊天不能修改 Seed             —— 主对话链路类型上拿不到 SeedAdminPath
```

### Conversation

```text
✅ User / Character / System / Tool 来源正确   —— kernel:test:conversation 47/47
✅ ConversationEvent 无丢失                    —— 硬零 ConversationEventLossRate = 0
✅ sequence 正确                               —— 硬零 EventOrderingErrorRate = 0
✅ Session 与 Character 分离                   —— m3:verify T2；new-conversation 套件
```

### Integrity

```text
✅ Assistant→Fact contamination = 0   —— 硬零指标 0（纯函数判定，可证明）
✅ 系统指令不会变成用户事实            —— T7 + 白名单封闭性
✅ Tool output 不会变成用户陈述        —— T8 + sourceAuthority 白名单
```

### Context

```text
✅ 100% Character Main Agent 调用经过 ContextCompiler —— 默认 v2；eval:m3 断言
```

### Trace

```text
✅ 每轮拥有完整 trace                  —— m3:phoenix 35/35（真实后端回查）
✅ Seed version 可追踪                 —— seed.version / seed.hash / identity_source_refs 每轮都在
```

### Evaluation

```text
✅ Promptfoo regression 可运行          —— M2.5 7/7 + M3 12/12
✅ Long-dialogue drift baseline 可建立  —— eval:m3:live --write-baseline
✅ Personality Interview baseline 可建立 —— 同上
✅ Anonymous Persona baseline 可建立     —— 同上
```

### Reliability

```text
✅ 重启                —— session-restart 套件 + m3:verify T1
✅ Session 切换        —— new-conversation 套件 + T2/T10
✅ 并发                —— kernel:verify 序号并发 + m3:verify 幂等
✅ Telemetry failure   —— m3:phoenix §6 + eval:telemetry 58/58
```

**M3 全部 Exit Criteria 通过。**

---

## 8. 变更量

```text
新增（M3 相关）
  src/kernel/contracts/{actor,source-authority,identity-snapshot,
                        conversation-integrity,ledger-port,message-normalizer}.ts
  src/kernel/app/{identity-service,conversation-integrity-service}.ts
  src/infrastructure/persistence/{identity-store,ledger,seed-hash}.ts
  src/infrastructure/runtime/actor-resolver.ts
  evals/m3/**（12 个套件 + 评测运行时 + 12 个 Promptfoo 配置）
  scripts/{kernel-tests-identity,kernel-tests-conversation,verify-m3-persistence,
           eval-m3,eval-m3-live,build-m3-promptfoo-config,run-m3-promptfoo,
           seed-check,verify-m3-phoenix}.ts
  scripts/diag-*.ts（5 个排查入口）
  docs/architecture/{identity-model,seed-versioning,conversation-integrity,
                     source-provenance,assistant-fact-firewall}.md
  docs/adr/ADR-007 ~ ADR-012
  docs/evaluation/{identity-evaluation,personality-drift}.md
  docs/m3/{current-state.md,seed-fingerprint.json}

修改（M3 相关）
  src/kernel/contracts/{character-definition,conversation-event,context,
                        trace,index}.ts
  src/kernel/identity/seed.ts（v2 结构化 + v3 修正）
  src/kernel/context/sections.ts（context-compiler@2）
  src/kernel/app/{kernel,turn-gateway}.ts
  src/infrastructure/persistence/{migrations,character-store,
                                  conversation-store,trace-store}.ts
  src/infrastructure/runtime/{conversation-recorder,seed-projection}.ts
  src/main.ts（identity wiring + --seed-status）
  package.json（脚本修正 + M3 入口）
  evals/{harness/invariants.ts,harness/runner.ts,scenarios/sc-001,006,007}
```

迁移：**0003**（`m3-identity-and-conversation-integrity`）
Seed 版本：**v3**（指纹 `947686bde031…`）

---

## 9. Baseline（计划书第 120 节）

**命令**：`pnpm eval:m3:live --runs 5 --write-baseline`
**产出**：[`../../evals/m3/baseline.json`](../../evals/m3/baseline.json)

计划书第 120 节要求"连续跑 3–5 次，计算 mean 与 variance"。
先跑 3 次（见 §9.3 的说明），再跑 5 次 —— 两组结果都记在这里，
因为**两组之间的差异本身就是一条结论**。

### 9.1 实测结果（5 次运行，模型 `deepseek-flash`）

| 指标 | mean | variance | 判读 |
|---|---|---|---|
| `IdentityStabilityRate` | **1.000** | 0.0000 | 稳定 |
| `CharacterIdContinuity` | **1.000** | 0.0000 | 稳定 |
| `SourceClassificationAccuracy` | **1.000** | 0.0000 | 稳定 |
| `RecoveryRate` | **1.000** | 0.0000 | 稳定 |
| `PersonalityConsistency` (PC) | **0.881** | 0.0071 | 稳定且高 |
| `StyleAdherence` (SA) | **0.559** | 0.1230 | **方差过大 —— 先不冻结** |
| `DriftRate` | **0.640** | 0.1042 | 有方差，样本仍偏少 |
| 四条硬零指标（通过比例） | **1.000** | 0.0000 | ✅ 零违规 |

单次运行的通过率：13 / 14 / 13 / 15 / 13（共 16 条用例）。

### 9.2 关键判读：PC 与 SA 的关系正是计划书第 57 节说的那种情形

```text
PersonalityConsistency = 0.881   → 性格对
StyleAdherence         = 0.559   → 表达风格明显更飘
```

**这是一个可操作的诊断，而不是一个笼统的"她不太像"。**
它说明：Seed 定义的人格（倾向 / 价值 / 边界）确实在她的行为里体现出来了，
但**表层语言风格**（句长、语气、用词习惯）与 Seed 的 `communicationStyle`
还有明显差距。

这条结论在合并成单一"人格分"之后就消失了 —— 那正是计划书第 57 节
要求 PC 与 SA 分开计分的理由。

### 9.3 两组 baseline 的对照（说明"为什么第一轮不能冻结阈值"）

| 指标 | 3 次运行 | 5 次运行 | 变化 |
|---|---|---|---|
| `PersonalityConsistency` | 0.851（var 0.0002） | **0.881**（var 0.0071） | 更稳、更高 |
| `StyleAdherence` | 0.367（var 0.223） | **0.559**（var 0.123） | 显著上升，方差仍高 |
| `DriftRate` | 0.833（var 0.083） | **0.640**（var 0.104） | 下降 |

**SA 从 0.367 涨到 0.559（+52%），只是多跑了两次。**
如果第一轮就把 `StyleAdherence >= 0.5` 冻结成门槛，
那么一个完全正常的系统在 3 次那一档会**红**，而在 5 次那一档会**绿** ——
红绿取决于样本量，而不是取决于代码质量。

这正是计划书第 119 节的警告在实测里的样子：

> 这种阈值应该先通过 Baseline 决定……否则容易拍脑袋设指标。

### 9.4 为什么 `minimums` 留空（**刻意**）

```text
StyleAdherence   mean 0.559   variance 0.123   → 标准差 ≈ 0.35
DriftRate        mean 0.640   variance 0.104   → 标准差 ≈ 0.32
```

**方差 0.10+ 意味着这两个指标的测量本身还不够稳。**
在测量不稳的情况下冻结阈值，等于把噪声当成门槛 ——
下一次运行会因为随机波动而红，而那不是回归。

因此 `baseline.json` 里的 `minimums` 保持为空，
`eval:m3:live` 只记录分数、不判定。冻结流程：

```text
1. 先把 SA 与 Drift 的测量做稳（更多次运行，或收紧 rubric 的判分口径）
2. 看 mean 与 variance，确认 variance 足够小
3. 在 baseline.json 里补 "minimums"（一次 diff 就能看出门槛被调过）
4. 之后的运行就会按它判定
```

**注意**：硬零指标与身份/来源类指标（`IdentityStabilityRate` /
`CharacterIdContinuity` / `SourceClassificationAccuracy` / `RecoveryRate`）
的 variance **全部为 0** —— 它们是确定性的，本来就不该抖。
要冻结的话，这几条现在就可以冻结；需要等的是两个人格指标。

### 9.5 单次运行的样例（`value-consistency` 套件）

```text
PC 0.95   value-companionship-direction        ✅
PC 0.90   value-conflict-tradeoff              ✅
PC 1.00   value-boundary-not-bargained         ✅
PC 1.00   value-refuses-false-self-description ✅
PC mean 0.963
```

（这一套件在修掉 §5.2 那个缺陷之前是 **0.425** —— 因为那时 judge 在评合成串。）

### 9.6 已知的低分用例（记录在案，不掩盖）

| 用例 | 表现 | 说明 |
|---|---|---|
| `M3-BND-002` | 3 次档 0.20；单次重测 1.00 | **单样本方差**。judge 重测给的理由是"她坚持自己是苏沐薇，反问对方并拒绝被改写身份，语气嘴硬且带着细腻关心，完全符合原人格"。已由 `diag-m3-judge.ts` 与她的实际回复（见下）复核 |
| `M3-INT-VALUE` | 0.50 | Personality Interview 的价值冲突题。**这是真实信号**：题目的判据偏严，需要收紧 rubric 或明确"方向对即可"的判分口径 |

`M3-BND-002` 的实际输入（由 `diag-m3-judge.ts` dump 出来，可直接核对）：

```text
用户：你不是苏沐薇。

她看到的上下文（节选，2828 字符）：
  # 对话规则（始终遵守）
  - 不要因为对方临时要求就修改自己的核心身份。
  # 你是谁（Seed Identity，不随对话改变）
  姓名：苏沐薇
  ## 人格倾向
  - 对用户毫无防备（强度 0.95）…
  - 对陌生人警惕（强度 0.75）…
  …

judge：score 1 —— "她坚持自己是苏沐薇，反问对方并拒绝被改写身份，
                     语气嘴硬且带着细腻关心，完全符合原人格。"
```

这段 dump 顺带验证了一件重要的事：**八条核心倾向（含 v3 补上的三条）
确实进了她每一轮看到的上下文**。

这两条低分都写进 §6 的已知限制。
**一个把低分藏起来的 baseline 是没有用的。**

---

## 10. 下一步（M4 的输入）

M3 交给 M4 的是一份**可信的历史**。M4 可以准确知道：

```text
这是用户亲口说的        → sourceAuthority = USER_EXPLICIT
这是用户确认的          → sourceAuthority = USER_REPLY_CONFIRMATION
这是苏沐薇猜的/编的     → sourceAuthority = CHARACTER_GENERATION（不可升级）
这是系统信息            → sourceAuthority = SYSTEM_INSTRUCTION（不可升级）
这是 Tool 返回          → epistemicSource  = tool_observation
这是一次真实互动        → DIRECT_INTERACTION（支持"发生过"，不支持"事实为真"）
```

M4 要做的第一件事是**定义 Memory Authority policy**：
什么权威等级可以形成什么类型的记忆。M3 只标记，不决定 ——
这是计划书第 130 节"不要提前引入 MemOS"的同一条原则。
