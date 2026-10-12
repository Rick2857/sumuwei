# M10 基线报告（WP0）

- 日期：2026-09-29
- 里程碑：M10 — Goals & Commitments（目标、承诺与持续行为）
- 依据计划：[`M10-Execution-Plan.md`](M10-Execution-Plan.md) §12 WP0
- 基线提交：`81b91122d9c06dc9e2b22c13d7f917654abc438b` @ `feature/m7-relationship`
- 证据目录：`artifacts/m10/<runId>/`（`m10-manifest@1`）
- **本轮没有**：打开真实库 · 调用任何模型 · 出网 · 跑产品门（除 `pnpm typecheck`）· 改写任何历史验收档

---

## 0. 判定

| 槽位 | 读数 |
|---|---|
| WP0 出口（计划 §12：「上述问题有代码指针与探针；未确定处具名 BLOCKED」） | **COMPLETE** |
| 计划 §12 WP0「必须回答」六问 | **6 / 6 = ANSWERED**（每问都有代码指针 + 隔离库实测） |
| 基线采样（before / after） | **BASELINE CAPTURED** |
| 真实库 | **从未被打开**（只做字节级内容树摘要 + mtime 观测；采样窗口内摘要逐字相同） |
| 准入审计 | **ADMISSION PASS 33/33** |
| 回归（新工具是否破坏既有门） | `pnpm fast:offline` = **34 道 · PASS 34 · FAIL 0**（非发布档，见 §7 第 1 条） |
| 未确定处 | 无 `BLOCKED`；**3 项具名交接** + **10 项具名欠账**（见 §7 与 [WP0 交接](M10-WP0-Handoff.md) §4） |

### 0.1 证据 runId

⚠️ **两代证据**（按产生它们时的 `head` 分列）。第一代在**脚本提交之前**产生，
`head` 指向计划提交 ⇒ 它的 `head` 无法回答"是哪份代码产生了这份读数"；
第二代在**工具提交 `decd2d2` 之后**产生，`head` 指向产生它的那次脚本提交
（AGENTS §8 的既有纪律）。**第一代保留、不回写、不删除。**

| 代 | runId | head | 判定 | 处置 |
|---|---|---|---|---|
| 2（**当前**） | `m10-wp0-20260929-decd2d215419-561d` | `decd2d2` | BASELINE CAPTURED | 权威读数 |
| 2（**当前**） | `m10-wp0-admission-20260929-decd2d215419-bd31` | `decd2d2` | **ADMISSION PASS 33/33** | 权威读数 |
| 1（历史） | `m10-wp0-20260929-81b91122d9c0-d574` | `81b9112` | BASELINE CAPTURED | 保留（head 早于工具提交） |
| 1（历史·**量具缺陷档**） | `m10-wp0-admission-20260929-81b91122d9c0-96c0` | `81b9112` | **ADMISSION FAIL 30/32** | **保留**，归因见 §4.2 |
| 1（历史） | `m10-wp0-admission-20260929-81b91122d9c0-c306` | `81b9112` | ADMISSION PASS 33/33 | 保留 |
| 1（历史） | `m10-wp0-admission-20260929-81b91122d9c0-df7c` | `81b9112` | ADMISSION PASS 33/33 | 保留 |

失败档**不回写**（AGENTS §6.1）：`…-96c0` 作为"量具缺陷档"保留归属，
它**不**被后续 PASS 覆盖。

---

## 1. 基线身份

| 项 | 读数 |
|---|---|
| HEAD（计划编制基线） | `81b91122d9c06dc9e2b22c13d7f917654abc438b` @ `feature/m7-relationship` |
| HEAD（**当前证据** `decd2d215419`） | `decd2d215419b9259f3c1bbde0981dce3ba70a39`（= WP0 工具提交） |
| 工具 | node `v22.23.2` · git `2.55.0.windows.5` |
| 源码树摘要（当前代 before → after） | `1fe0b85c34c3f3b9…`（1294 文件 / 24,107,887 字节）→ `59fbb9de51b6a39d…`（1294 文件 / 24,108,689 字节） |
| 源码树摘要（历史代 before → after） | `736b7fe247d3e3ea…`（1292 文件）→ `39e5553079629273…`（1294 文件） |
| 真实库摘要（**两代前后均逐字相同**） | `8c8a196b9330fa01…`（`digestTree`，INC-01 冻结算法）· 1211 文件 · 32,715,295 字节 |
| 真实库最新 mtime | `2026-09-29T02:10:52.295Z`（采样窗口 2h 内写入文件数 = 0） |
| 脏文件归属（当前代 before） | `artifacts/m10/` + `docs/m10/*.md`[m10-self] · **unknown = 0** |
| 脏文件归属（历史代 before） | `package.json`[shared-appended] · `scripts/m10-*.ts` ×3[m10-self] · **unknown = 0** |

**after 阶段判定（两代同形）**：`A11` 真实库摘要逐字相同 ✅ ·
`A12` 源码树摘要变化（如实记录）❌ · `A12b` 变化可由本 WP 自产文件解释 ✅ · `A13` unknown=0 ✅
⇒ **`BASELINE CAPTURED（源码树变化 = 本 WP 自产文件的点状追加，已按归属分类解释）`**，退出码 0。

**两个摘要的算法原文随证据落盘**（`capture.sourceTree.algorithm` / `capture.realDb.digest`），
不靠散文描述：

```text
源码树（本脚本定义，scripts/m10-baseline.ts）：
  sha256 over sorted concat of `${path}\n${byteLength}\n${content}` for every file in
  `git ls-files --cached --others --exclude-standard`
  minus excluded prefixes ['.git/','node_modules/','data/','dist/','artifacts/']

真实库（INC-01 冻结算法，唯一实现在 production-db-safety.ts 的 digestTree —— 本脚本不重写）
```

⚠️ **与 M9 的 baseline 有一处刻意的算法差异**：M9 逐个里程碑列出要排除的证据目录，
于是 M9.1/M9.5/M9.6 落地后那份清单**已经过期**（"源码树变了"可能只是"某次门跑出来的 JSON"）。
M10 按**目录**排除整个 `artifacts/`，因为要测的命题是**源码**树。

⚠️ **after 阶段的判定与 M9 不同**（如实说明）：M9 的 after 读数是 `PARTIAL`，
原因是"源码树摘要在窗口内变了"。而 WP0 的正常形状**就是**"采样 → 写本 WP 的文件 → 再采样"，
因此摘要必然变化 —— 把它一律读成"并发写入"是一个**无法区分**的降档。
M10 把这件事拆成两条：`A12` 如实报"摘要是否变化"，`A12b` 用**脏文件归属分类**
回答"变化是否只由本 WP 自产文件解释"。未知脏文件仍然降档 `PARTIAL`。

---

## 2. 计划 §1.3「旧文档差异」的来源对照

这一节是计划 §1.3 要求 WP0 交付的**来源对照**：不按旧标题阻断开工，
但把"文档说什么 / 工作区实测什么 / M10 按哪个读"三列写清楚。

| 项目 | 文档读数 | 工作区实测（只读） | M10 采用 |
|---|---|---|---|
| M7 / M8 / M8.5 / M9 开关 | AGENTS 段：均已生产激活 | `.env`：`CHARACTER_RELATIONSHIP_CONTEXT_ENABLED=true` · `AFFECT_CONTEXT_ENABLED=true` · `AFFECT_SEMANTIC_MODE=semantic` · `BELIEF_ENABLED=true` | **实测 + 各自 ADR**（065 / 067 / 069 / 071） |
| **M9.1（计划 §1.3 漏列）** | Gate Decision §0/§6 + ADR-073 记"已激活" | `.env`：`CHARACTER_MEMORY_RESTATEMENT_ENABLED=true` · `CHARACTER_WITHDRAWN_CONTEXT_MASKING_ENABLED=true` | **本轮补进白名单**：遗忘遮蔽与同内容复活都是 M10 §8.3 的直接前置 |
| M9 原长门两轮 | 各 9/10，**红项不同** | 未重跑（本轮零模型） | 按最新报告读取，**不把旧 F-1/F-4 当完全未修，也不抹去长门残余** |
| M9.5 生产状态 | 旧 [Gate Decision](../m9.5/M9.5-Gate-Decision.md) / [交接](../m9.5/M9.5-to-M10-M11-Handoff.md) 仍有 `NOT ACTIVATED / OPEN / PENDING`，同文局部有修订读数 | `.env`：`CHARACTER_MEMORY_SEMANTIC_ENABLED=true` · `CHARACTER_MEMORY_SEMANTIC_MODE=shadow` | **ADR-075 为权威**；**shadow = 实际回复仍用旧排序** ⇒ M10 必须在该配置下可用，不把 on 的收益算成现状 |
| M9 → M10 交接的生产状态 | [`M9-to-M10-Handoff.md`](../m9/M9-to-M10-Handoff.md) §4 写「生产激活状态：**NOT ACTIVATED**」 | `.env` 的 `CHARACTER_BELIEF_ENABLED=true` | **文档落后于工作区**。这是**机器可读**的事实（基线检查 `B9` 在案），不是"两边都对"——裁决以 [ADR-071](../adr/ADR-071-m9-belief-production-activation.md) 为准 |
| M9.5-FMB-01 | 记 `CLOSED`，主张 = 可查 / 可审计 / 可测 | 未复验 | 照读；**不**宣称"不存在假记忆" |
| M9.6 搜索 / 情绪 | `DO_NOT_ADOPT`（搜索未达 ADOPT_CANDIDATE；情绪 J 0.5377 vs 基线 0.9528） | 未复验（零模型） | **Jev 不作为 M10 依赖**，不用它判授权或完成 |
| Goal 生产实现 | 计划检索到 `ContextSectionKind='goals'` + `SECTION_PRIORITY.goals=45`，纯 fixture consumer | 复核确认：`'goals' // M10` 与 `goals: 45` 在场；`src/kernel/contracts/goal.ts` / `policies/goal-validator.ts` / `projections/goal.ts` / `app/goal/` **均不存在**；`flags.ts` 无 `CHARACTER_GOALS_ENABLED` | **从接口预留进入第一次实现**，不能写成"只需打开开关"（机器判据 `B7`） |
| 真实库 schema | AGENTS 记 v9；ADR-075 的启动读数记 v2 | **WP0 未开库**（硬边界） | **不给结论**。登记为 WP12 / 需要只读副本时的核对项；不凭旧数字编迁移 |

### 2.1 本轮新发现：两处接口事实（计划未列）

1. **`goals: 45` 与 `externalEvidence: 45` 是同一个数**——
   [`context.ts:109`](../../src/kernel/contracts/context.ts#L109) 的 `goals: 45` 与
   [`context.ts:123`](../../src/kernel/contracts/context.ts#L123) 的 `externalEvidence: 45` 相等。
   而排序规则是 [`sortSections`](../../src/kernel/contracts/context.ts#L497)：
   `priority` 降序，**相同则按 section `id` 升序字典序**；外部证据那一行的 id 恒为
   [`'external-evidence'`](../../src/kernel/context/sections.ts#L107)。
   ⇒ 只要 M10 的 section id 取 `goals`（或 `goal:<id>`），它就**稳定排在外部证据之后**。
   WP7 必须**显式裁定**这个平局（或给 goals 一个不等于 45 的数，或在 ADR 里记录
   "共享 45 且外部证据优先"是有意的），**不能假定"预留了 45 就等于有位置"**。
2. **`goals` 夹在 `belief: 50` 与 `adaptiveSelf: 44` 之间**，而 `memory: 40` 在更下面——
   即"目标块被裁之前先裁记忆"。这与计划 §10.1 的意图一致，但**它是既有约定，不是 M10 新造的**。

---

## 3. 计划 §12 WP0「必须回答」六问

判定：**6/6 ANSWERED**。每问给"答案 / 代码指针 / 实测读数 / 残留"。

### Q1 —— 实际 Memory revision 从哪里读取

**答案**：按 ID 读 `MemoryRecord.revision`。三处都在，且**实测**能取到真实版本号。

| 事实 | 指针 |
|---|---|
| 契约字段（乐观锁版本，每成功应用一个领域事件 +1） | [`memory.ts:502`](../../src/kernel/contracts/memory.ts#L502) |
| 行 → 记录的读映射（**读出来**，不是常量） | [`memory-store.ts:330`](../../src/infrastructure/persistence/memory-store.ts#L330) |
| 每次折叠递增 | [`memory-store.ts:825`](../../src/infrastructure/persistence/memory-store.ts#L825) |

**实测（E1，隔离库）**：新建记录 `revision=1`；被取代后**同一条记录** `revision=2`、`status=superseded`。

**残留（计划 §1.4 第 1 条确认在场）**：M9.5 交接 fixture 的
[`handoff-fixtures.ts:84`](../../src/kernel/app/recall/handoff-fixtures.ts#L84) 把
`sourceRevision` **固定为 1**；同文件的
[`recheckReferences`](../../src/kernel/app/recall/handoff-fixtures.ts#L70) 只调用消费者传入的
`stillValid()`（不自查库、不比版本）。
⇒ **WP2 必须新建真实引用构造路径**（从当前记录取 revision），
保留原 fixture 的契约作用，**不**把 fixture 悄悄变成生产权威。

### Q2 —— Belief 资格如何复用

**答案**：复用 M9 的**两层**，原料由按 ID 的当前状态读法供上，零新增 SQL。

| 复用口 | 指针 | 它管什么 |
|---|---|---|
| `recheckBeliefDependencies()` | [`eligibility.ts:110`](../../src/kernel/app/belief/eligibility.ts#L110) | 按**确切 ID**批量回查根/记忆（防 N+1）；**异常 ⇒ 全体 `unavailable`**（失败关闭，不当 valid、也不当不存在） |
| `applyInvalidationOverlay()` | [`eligibility.ts:222`](../../src/kernel/app/belief/eligibility.ts#L222) | **同轮遮蔽**（纯函数）：写侧修订未完成/失败时，读侧仍把失效内容挡在模型之外 |
| `qualificationsForMemories()` | [`qualification-read.ts:129`](../../src/infrastructure/persistence/qualification-read.ts#L129) | 按 ID 的**读时派生资格** |
| `originReadingOfEvent()` | [`qualification-read.ts:73`](../../src/infrastructure/persistence/qualification-read.ts#L73) | 唯一适配边界（R-59）的消费点 |

**缺口确认在场**（计划 §1.4 第 3 条）：`listActiveBeliefs()` **只做 status 过滤** ——
[`belief-store.ts:123`](../../src/infrastructure/persistence/belief-store.ts#L123) 的
`state.status !== 'active'`。读到 active **不等于**其 Memory/根证据此刻仍有效
⇒ M10 必须叠加资格链，**不能只调这个低层列表**。

**实测（E2，隔离库）**：遗忘前按 ID 读到 `active` 且资格 `ESTABLISHED`；
遗忘后按 ID 读到 `retracted`、槽位 active 集清空（0 条）。
这就是 M10 喂给 `EligibilityMemoryLookup` 的原料形状。

⚠️ **如实读数**：E2 里"遗忘后"的**资格**读数仍是 `ESTABLISHED` ——
因为 `memoryQualificationOf` 回答的是"**来源**资格"，不是"当前是否可用"。
可用性来自 `status`。**两者是两件事，M10 必须同时看**（这正是 `recheckBeliefDependencies`
要两个端口 —— evidence 与 memory —— 的原因）。

### Q3 —— Goal 操作的用户归因从哪里取得

**答案**：取自**本轮那条已落库的用户对话事件**的受信归因，经唯一边界派生。

| 环节 | 指针 |
|---|---|
| 受信上下文构造（调用方自报的 provenance **不算** —— DR-6） | [`attribution.ts:1539`](../../src/kernel/contracts/attribution.ts#L1539) |
| 信封构造 | [`attribution.ts:1664`](../../src/kernel/contracts/attribution.ts#L1664) |
| 资格**唯一**派生口 + 规则版本 | [`attribution.ts:2583`](../../src/kernel/contracts/attribution.ts#L2583) · [`attribution.ts:2568`](../../src/kernel/contracts/attribution.ts#L2568) |
| "够格建立关于用户个人的事实" | [`attribution.ts:2592`](../../src/kernel/contracts/attribution.ts#L2592) |
| 读侧唯一适配边界（R-59） | [`extractor.ts:98`](../../src/kernel/app/memory/extractor.ts#L98) |
| 装配点（两个入口模式都装她的输出通道） | [`main.ts:93`](../../src/main.ts#L93) · [`conversation-attribution.ts:332`](../../src/infrastructure/runtime/conversation-attribution.ts#L332) |

**实测（E3，隔离库）**：经真实入口写下一条用户话语 ⇒
`attributionOrigin=RECORDED` · `axisBConfirmed=true` · **`qualification=ESTABLISHED`**。

⇒ 归因**不**取自聊天文本、模型意图分类、记忆里的偏好或亲密度
（计划 §7.1：「旧聊天里的用户标签、记忆中的偏好以及模型的意图分类，不是授权凭证」）。
反例面同时在案：assistant 通道由 `createCharacterAssistantTurnIngress()` 统一装配，
她的输出有信封但 `contentOriginator ≠ USER` ⇒ 资格为 `CONTRADICTED_ORIGIN`、
`qualificationEstablishesUserFact = false`。

### Q4 —— 正式 assistant event 何时落盘

**答案**：在 `TurnGateway.completeTurn()` 内、`ConversationIntentResolver.resolveWithEvent(intent)`
返回时落盘；门是 `dryRun || assistantSequence !== undefined`。
**落库失败不吞** ⇒ 「回复文本已生成、事件尚未提交」的崩溃窗口**真实存在**。

| 事实 | 指针 |
|---|---|
| 落盘所在方法 | [`turn-gateway.ts:2059`](../../src/kernel/app/turn-gateway.ts#L2059) |
| 真正落盘点 | [`turn-gateway.ts:2134`](../../src/kernel/app/turn-gateway.ts#L2134) |
| 落盘门（无序号 = 这一轮没真的发生） | [`turn-gateway.ts:2116`](../../src/kernel/app/turn-gateway.ts#L2116) |
| 失败不吞的原文位置 | [`turn-gateway.ts:2080`](../../src/kernel/app/turn-gateway.ts#L2080) |
| 结果形状（可为 `undefined`） | [`turn-gateway.ts:454`](../../src/kernel/app/turn-gateway.ts#L454) |

⇒ 对 M10 的直接约束（计划 §9.2）：**默认不在同一条尚未落盘的生成文本里宣告承诺已兑现**。
先生成交付内容，正式落盘后提交兑现事件。

**具名交接（不是"已验"）**：可执行的端到端探针（落盘成功 / 落盘失败两种形状）
需要一个可注入 provider 的完整一轮，而 WP0 的硬边界是**零模型调用**
⇒ 归 **WP6**（`m10:completion:verify`）。本轮只给代码指针与窗口判定，**不假装已实测**。

### Q5 —— 哪些接口允许幂等兑现补记

**答案**：两条接口 + 一层乐观锁。

| 接口 | 指针 | 它管什么 |
|---|---|---|
| `applyAcceptedEvents()` / `appendDomainEvent()` | [`event-store.ts:149`](../../src/infrastructure/persistence/event-store.ts#L149) · [`event-store.ts:174`](../../src/infrastructure/persistence/event-store.ts#L174) | 快路径幂等探测 + `on conflict (idempotency_key) do nothing` + 失败回读 |
| `processed_operations`（PK = `idempotency_key`） | [`migrations.ts:232`](../../src/infrastructure/persistence/migrations.ts#L232) | **没有 DomainEvent 的终态**的裁判（兑现补记的落点） |
| 投影乐观锁 | [`event-store.ts:376`](../../src/infrastructure/persistence/event-store.ts#L376) | 迟到结果不覆盖新状态（`projection_revision_conflict`） |

**实测 E4a（直接探点名的接口）**：同一 accepted 事件投递两次 ⇒
`created=1 → 0` · `deduplicated=0 → 1` · 域事件总数只 `0→1→1` ·
且第二次返回**同一条**已存在事件的 `eventId`（`同 eventId=true`）
⇒ 可以据此幂等补记，**无第二次副作用**。

**实测 E4b（走完整放行口）——一条必须记下来的如实读数**：
同一提案在同一证据区间重复投递，第二次 `accepted=0` 且有具名拒绝码、`MEMORY_CREATED` 不增加；
换证据区间 + 换内容 ⇒ 真的多 1 条（幂等 ≠ 吞掉一切）。
⚠️ **但本例的拒绝码是 `duplicate_content`（内容去重闸）**，
即**不是**幂等键闸先命中（幂等键闸的拒绝码是 [`memory-validator.ts:834`](../../src/kernel/policies/memory-validator.ts#L834) 的 `duplicate_operation`）。
⇒ **M10 的兑现补记不能依赖内容去重**（一条"兑现事件"没有内容指纹可撞），
必须自带确定性事件身份与幂等键 —— 而 E4a 证明这条路可用。

### Q6 —— 是否真的需要迁移

**答案**：**读数支持"迁移目标 NONE"**（与计划 §8.1 的推荐一致 —— 但这是实测，不是预设）。

| 事实 | 指针 |
|---|---|
| 迁移清单 1..9 **严格连续** | [`migrations.ts:1250`](../../src/infrastructure/persistence/migrations.ts#L1250)（1:`m2-character-state-tables` … 9:`m5.1.1-state-events-attribution`） |
| 通用投影表：键就是作用域，PK `(character_id, projection_type)`，两列 `text`（无长度上限），`state` 为 `jsonb`（无大小上限） | [`migrations.ts:175`](../../src/infrastructure/persistence/migrations.ts#L175) · [`migrations.ts:168`](../../src/infrastructure/persistence/migrations.ts#L168) |
| 域事件表：`type` / `idempotency_key` 同为 `text`，`idempotency_key` 唯一 | [`migrations.ts:150`](../../src/infrastructure/persistence/migrations.ts#L150) · [`migrations.ts:155`](../../src/infrastructure/persistence/migrations.ts#L155) |
| **先例**：M9 信念域零迁移，一族多行、每对象一行 `belief:<beliefId>` | [`belief-store.ts:11`](../../src/infrastructure/persistence/belief-store.ts#L11) |

**规模探针实测（E5，隔离库，60 条 `goal:<id>` 投影行）**：

| 读数 | 值 |
|---|---|
| 插入行数（分母 > 0 自检） | 60 / 60 |
| 按 ID 读第 1（最新） | 1 ms · 读到 |
| 按 ID 读第 51 | 0 ms · 读到 |
| 按 ID 读**最老** | 1 ms · 读到 |
| 上界形状一条目标的 `state` 字节数 | **1684 字节**（`statement` 480 字 + `nextStep`） |
| 族读取（列出本角色全部投影行） | 行数 `0 → 60` · 耗时 `1 → 1 ms` |

⚠️ **一条已登记的代价（必须写进 WP3/WP9，不能假定零成本）**：
族读取在当前实现里是"列出本角色**全部**投影行 + 内存前缀过滤"
（[`belief-store.ts:102`](../../src/infrastructure/persistence/belief-store.ts#L102) 的
`startsWith('belief:')` 就是这么做的，[`listProjections`](../../src/infrastructure/persistence/event-store.ts#L462)
不带前缀条件）⇒ **随投影行总数线性增长**，而不是随目标数增长。
- WP3 的可选项：另加一条只含 goal 行的表（= **迁移 0010**，须另写 ADR）——
  「零迁移」是**读数结论**，不是不许改的教条。
- WP9 的规模门**必须实测族读取成本**（目标池 200/500）。

---

## 4. 准入实验与量具自证

### 4.1 实验清单（33 条检查）

| 问 | 静态指针 | 隔离库实测 |
|---|---|---|
| Q1 | S1–S3（revision 三处）+ S4–S5（两处 fixture 缺口） | **E1** revision 1→2 |
| Q2 | S6–S7（两个复用口）+ S8（缺口）+ S9（按 ID 读法） | **E2** 遗忘前/后两个读数 |
| Q3 | S10–S13（构造 / 派生 / 唯一边界 / 网关）+ S14（反例面） | **E3** 资格 = ESTABLISHED |
| Q4 | S15–S18（落盘点 / 门 / 窗口 / 结果形状）+ S19（具名交接） | —— （交接 WP6） |
| Q5 | S20–S22（幂等两层 / 裁判表 / 乐观锁） | **E4a** 幂等补记 · **E4b** 完整放行口 |
| Q6 | S23–S27（迁移连续性 / 表结构 / 先例 / 代价面） | **E5** 60 行三档按 ID 读回 |

**硬边界**（判据，不是注释）：
- `isolateDatabase('m10-wp0-admission', { keep: false })` 在**任何数据库 import 之前**；
- 真实库**从不被打开**（不取租约、不建连接、不迁移）；
- **零模型调用、零出网**；
- 每条计数型检查都有非零分母（`counts.total = 33 > 0`）；
- 静态检查只读源码文本，不修改任何文件。

### 4.2 量具自身的两处缺陷（第一版 FAIL 档的归因）

第一版量具（`…-96c0`）报 **ADMISSION FAIL 30/32**。两条失败**都是量具缺陷，不是产品缺陷**
（AGENTS §6.2：判据错了要如实写进报告，不要悄悄改判据）：

| 失败检查 | 缺陷 | 修法 |
|---|---|---|
| `S14` | 断言里写 `src/main.ts` 含字面量 `createCharacterAssistantTurnIngress` —— 而 `main.ts` 实际是经 `conversationAttributionForEntryMode()` **间接**装配的。这是**指针写错**：量具指的文件里没有那一行 | 改成检查真实装配点：`main.ts:93` 与 `conversation-attribution.ts:332` |
| `E4`（旧编号） | 断言 `事件数 === 1` —— 假设探针运行时库里没有 MEMORY_CREATED。而 Q1/Q2/Q3 的探针已经写过记忆 ⇒ **分母假设错**（量的是"库里的总数"，不是"本探针的增量"） | ① 拆成 E4a（直接探 `applyAcceptedEvents`）+ E4b（改为**增量**断言）；② 顺带发现真实拒绝码是 `duplicate_content` 而非 `duplicate_operation`（见 Q5） |

⇒ 修复后的两次运行均为 **33/33 PASS**。
**这一条本身是 WP0 的产出**：它证明了"新量具必须走正控/负控/恢复"的必要性
（本例两个失败都发生在**量具**而非被测对象上）。

⚠️ **本脚本尚未做三段式（正控 / 负控 / 恢复）**：那是计划 §16.2 / WP8 的
`m10:measurement:verify` 的职责。本轮只做了"分母 > 0"自检与两次运行对照，
**不声称量具已自证**。

---

## 5. 拟改动文件边界（WP0 冻结的受影响清单）

依据计划 §13，逐条核对为"存在 / 不存在 / 需追加"。**不存在的文件不当作已实现接口。**

| 层 | 路径 | WP0 核对 |
|---|---|---|
| contracts | `src/kernel/contracts/goal.ts` | **不存在**（WP1 冻结契约 / WP3 落地） |
| contracts | `src/kernel/contracts/context.ts` | 存在；`'goals' // M10` + `goals: 45` 已在场（**是预留，不是接线**） |
| policy | `src/kernel/policies/goal-validator.ts` | **不存在**（唯一放行口，WP3） |
| projection | `src/kernel/projections/goal.ts` | **不存在**（WP3） |
| app | `src/kernel/app/goal/` | **不存在**（WP2 起逐步落地） |
| persistence | `src/infrastructure/persistence/goal-store.ts` | **不存在**；WP0 已实测"零迁移可行"（§3 Q6） |
| persistence | `src/infrastructure/persistence/migrations.ts` | 存在；**WP0 不改它**（迁移目标 NONE 为读数结论） |
| flags | `src/kernel/app/flags.ts` | 存在；**无** `CHARACTER_GOALS_ENABLED`（缺省 off 的新开关属后续 WP） |
| runtime | `src/main.ts` · `src/kernel/app/turn-gateway.ts` | 存在；WP0 已标出 Q3/Q4 的装配与落盘点 |
| context | `src/kernel/context/sections.ts` · `contracts/context.ts` | 存在；`goals` 已预留，**§2.1 的 45 平局须 WP7 显式裁定** |
| telemetry / dev | `src/kernel/contracts/developer-*.ts` · `observability.ts` · `src/infrastructure/dev/**` | 存在；WP7 只追加必要字段（按 M5.1 追加纪律） |
| scripts | `scripts/m10-*.ts` | 本轮新增 3 个（见下表） |
| evals | `evals/m10/` | **不存在**（WP4 语料） |
| docs | `docs/m10/` | 本轮新增本报告 + WP0 交接 |
| artifacts | `artifacts/m10/<runId>/` | 本轮新增（4 个 runId） |

**本轮实际触碰的文件**（= 交给 WP1 的"已动过"集合）：

| 文件 | 动作 |
|---|---|
| [`scripts/m10-evidence.ts`](../../scripts/m10-evidence.ts) | 新增：runId / 运行目录 / `m10-manifest@1` |
| [`scripts/m10-baseline.ts`](../../scripts/m10-baseline.ts) | 新增：`pnpm m10:baseline`（before/after） |
| [`scripts/m10-wp0-admission.ts`](../../scripts/m10-wp0-admission.ts) | 新增：`pnpm m10:wp0:admission` |
| [`package.json`](../../package.json) | **点追加**两条 `m10:*` 脚本 |
| [`docs/m10/M10-Baseline-Report.md`](M10-Baseline-Report.md) | 新增（本文件） |
| [`docs/m10/M10-WP0-Handoff.md`](M10-WP0-Handoff.md) | 新增 |
| `artifacts/m10/<6 个 runId>/**` | 新增证据（两代；见 §0.1） |

**未触碰**（有意）：`docs/m10/M10-Execution-Plan.md` 一字未改；
所有历史里程碑报告、`artifacts/**` 旧证据、`data/**`、迁移 DDL、人设 Seed、
prompt 逐字节基线、[`AGENTS.md`](../../AGENTS.md)。

⚠️ **`.gitignore` 也刻意未改，这是一个具名决定**：按 M6/M8/M9/M9.1/M9.5/M9.6 的既有约定，
每个里程碑在**创建 `artifacts/<milestone>/local/` 之前**加一条 `artifacts/m10/local/` 忽略规则。
M10 的 `local/` 目录由 **WP10**（人审材料）首次创建 ⇒ 那条规则必须在那之前加。
本轮不加的理由是：现在加它会让"基线摘要"与最终树状态不一致，而**没有**任何东西需要保护
（`artifacts/m10/local/` 尚不存在）。该前置已登记为 [WP0 交接](M10-WP0-Handoff.md) §4 的 `WP0-D10`。

---

## 6. 保护方案（模型 / 测试库 / 真实库）

| 面 | 方案 | 依据 |
|---|---|---|
| **真实库** | 全程**不打开**。只做 `digestTree()` 字节级摘要 + mtime 观测。任何需要数据的实验用 `isolateDatabase()` 一次性沙箱 | AGENTS §3 / §5.1 · INV-DB-01…07 |
| **测试库** | `isolateDatabase('<label>', { keep: false })` 必须在**任何数据库 import 之前**调用 | AGENTS §7 |
| **模型** | WP0 **零调用**。后续真模型档一律 `pnpm with-test-model <cmd>`（`.env.test` 端点 `ark.cn-beijing.volces.com` / `deepseek-v4.1-flash`），**绝不**回落 `.env` 的生产 key（`api.deepseek.com` / `deepseek-flash`） | AGENTS §8.1 · `run-with-test-model.ts` 的 G1/G2 失败关闭 |
| **端点差异** | 生产端点 ≠ 验收端点（`L-M85-14` 同族边界）⇒ M10 的真模型读数必须**分列**，不得当成生产等价 | M8.5 既有边界 |
| **证据** | 全部落 `artifacts/m10/<runId>/`；runId 目录**拒绝覆盖**；manifest **原子晋升** + `payloadSha256` 自摘要 | `m10-evidence.ts`（抄 M6.1/M7/M8/M9 的同一纪律） |
| **私有正文** | 需要正文的人审材料将落 `artifacts/m10/local/`（不进仓库）；仓库证据只留指纹与指针 | 计划 §10.2 / §21.2 |

---

## 7. 本次**未做 / 未验证**（诚实清单）

1. **未跑正式发布档产品门**。跑过两条：
   - `pnpm typecheck`（EXIT 0）；
   - `pnpm fast:offline`（= `gates:run --lane offline --cache`）：
     **34 道 · PASS 34 · CACHED 0 · FAIL 0 · SKIPPED 0 · TIMEOUT 0**（墙钟 83.2s）。
     ⚠️ **这不是发布证据**（AGENTS §9.1 规矩②：`--mode release` 强制串行、拒绝缓存、
     不还原证据）。它的用途只有一个：证明**新增 `scripts/m10-*.ts` 与两条 `package.json`
     脚本没有破坏任何既有门**。正式的 `pnpm m4.5:ci` 留到 WP11（计划 §16.3）。
     ⚠️ 它的 `run.json` 落在 `artifacts/.fast/`——**该路径被 gitignore**（`.gitignore:186`），
     因此**不进仓库**；上面的读数是本轮的实测记录，可用同一条命令复现。
     这是快车道与里程碑证据的**既有分工**，不是把未提交的东西当证据。
2. **未调用任何模型**、未出网。
3. **未打开真实库**，因此 **真实库 schema 版本仍未核**（文档 v9 vs ADR-075 的 v2 分歧**保持未决**）。
4. **Q4 的端到端探针未做**（具名交接 WP6）——本轮只给代码指针与窗口判定。
5. **量具未做三段式**（正控/负控/恢复）——属 WP8 的 `m10:measurement:verify`。
6. **`m10:*` 门清单只落地 2 条**（`m10:baseline` / `m10:wp0:admission`）。
   计划 §16.1 的其余命令**全部未实现**。
7. **未登记进 `scripts/gates/affected-map.ts`**：M10 自己的门要等 `m10:test`（WP3）落地后
   才有一组"按改动面推导"的门可带；现在登记会引用不存在的门（受影响映射对缺门是**失败关闭**）。
   这是一条**具名欠账**，不是遗漏。
8. **未验证 `.env.test` 端点可达**（计划 §7.3 的"WP0 做测试端点预检"）——
   WP0 的零调用硬边界与"预检"冲突 ⇒ 预检移交 WP4 首次真模型调用前，
   登记在 [WP0 交接](M10-WP0-Handoff.md) §4。
9. **未改**任何历史文档、历史 artifacts、`AGENTS.md`。

---

## 8. 结论与下一步

WP0 的出口条件是"上述问题有代码指针与探针；未确定处具名 BLOCKED"。本报告的读数：

- 六问**全部 ANSWERED**，每问有静态指针 + 隔离库实测；
- **无 BLOCKED**；三项具名交接（Q4→WP6 · 真实库 schema→WP12 · `m10:*` 门清单→WP3 起）；
- 迁移目标 **NONE 是实测支持的结论**，但带一条**已登记的代价**（族读取线性成本）；
- 计划 §1.4 的四条接口缺口**逐条确认在场**，全部成为 WP2/WP3/WP7 的显式工作项；
- 真实库摘要前后**逐字相同**，本轮从未打开它。

⇒ **可以进入 WP1（ADR + 验收契约冻结）**。
WP1 的输入清单、必须冻结的项与未决项登记见
[`M10-WP0-Handoff.md`](M10-WP0-Handoff.md)。
