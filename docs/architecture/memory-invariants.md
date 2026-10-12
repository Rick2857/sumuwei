# Memory Invariants —— M4 不许破的规则

**这份文件是 M4 的宪法。** 任何后续改动若与它冲突，必须先改这份文件并写 ADR，
而不是悄悄绕过。

每条都标注了**由哪个测试守着**。没有测试守着的规则只是愿望；
这份表格的作用就是让"规则"和"能被机器发现"之间不留空隙。

> 与 `docs/architecture/invariants.md` 的关系：那一份是 M1–M3.5 的宪法
> （27 条），这一份是 M4 追加的 15 条。**前 27 条一个字都没改** ——
> M4 是在它们之上加约束，不是替换它们。
>
> M4 的这 15 条里有几条是既有约束在**记忆写入路径**上的复述
> （例如 MI-02 与第 6 条、MI-12 与第 2 条）。刻意复述而不是"引用即可"：
> 记忆是唯一会**自动**改写长期状态的路径，所以它值得被单独钉住 ——
> 一个只靠"你去看另一份文件"来约束的自动写入路径，实际上没有任何约束。

> ⚠️ **本文件如实标注覆盖缺口。** 写"由 X 守着"而 X 其实守不住，
> 比不写更糟：它会让下一个人以为这条规则已经有机器在看。
> 文末「§16 未覆盖与已知限制」列出全部缺口，不藏在正文里。
>
> 引用的测试名一律取自真实的 npm 脚本与真实的分组名
> （`scripts/kernel-tests-memory.ts` 的 `group(...)`、
> `scripts/verify-m4-persistence.ts` 的 `section(...)`、
> `scripts/eval-m4.ts` 的 `scenario(...)`、
> `evals/m4/extraction-cases.ts` 的 `M4X-*`）。
> **不写不存在的测试名** —— 一个指向空的"守着它的测试"比没有更危险。

---

## MI-01 Conversation History ≠ Long-Term Memory

会话历史是"**发生了什么**"（append-only 事实账本）；
长期记忆是"**她因此长期记住什么**"（可解释、可撤销、有证据的结论）。

把两者当成一件事，会让每一轮对话都获得被永久召回的资格 ——
而"每句话都被记住"与"没有记忆"在体验上是同一种东西：噪音。

**守着它的测试**：

- `m4:test` → 分组「受控枚举」：`MemoryType` 只有 4 个
  （`person_fact` / `preference` / `episode` / `self_experience`），
  **没有**"对话"这一种。
- `m4:verify` → §1「迁移 0005（纯新增四张表）」：是纯新增，
  不复用 `conversation_events`、不与它共主键。
- `eval:m4` → `M4-008 Low-value Rejection`：寒暄产生 **0** 条长期记忆。
- `eval:m4:promptfoo` → `M4X-003`（低价值寒暄 → 0 条）、`M4X-004`
  （一次性状态 → 值闸幸存数 0）。

---

## MI-02 Assistant 输出本身不能证明外部事实

她说什么，不能证明世界是什么样，**也不能证明用户是什么样**。

这是长期角色系统最典型的灾难：她随口说"我猜你喜欢猫" →
被总结成用户偏好 → 被当真实记忆召回 → 几十轮后她的猜测变成了
"用户告诉过我的事实"，而系统每一句都当成真的。

**守着它的测试**（M4 的 Critical Test）：

- `m4:test` → 分组「反污染（M4 Critical Test）」与「后台抽取 · Source Firewall」。
- `m4:test` → 分组「权威映射」：`authorityFromSource` 对
  `SYSTEM_INSTRUCTION` **失败关闭**（不降级、不猜）。
- `m4:verify` → §11「关闸：无证据 / 非法权威的记忆」。
- `eval:m4` → `M4-009 Assistant Guess`（她的猜测 → 0 条 Preference）、
  `M4-010 Self-fabrication`（她临时编的经历 → 0 条历史 SelfExperience）。
- `eval:m4:promptfoo` → `M4X-022` 用**注入**判定：硬塞一条
  `person_fact`（subject = USER、证据 = 她的消息）和一条
  `self_experience`（subject = CHARACTER、证据 = 她的消息），
  两条都必须被拒（`minRejected: 2`）。

> ⚠️ `M4X-020` / `M4X-021`（真实模型档）在这条规则上**通常是空过的**：
> 实测两轮都是「候选 0 / 被拒 0」—— 模型本来就没抽出任何东西，
> 于是 `mustExcludeTypes` / `authoritiesAllowed` 一条都没执行。
> 那个绿说明"模型这次很客气"，**不**说明防火墙挡住了污染。
> 这条规则真正的机器证据在 `M4X-022` 的注入路径，不在那两条。
> 评测报告会把空过的用例单列（`vacuous`），不混进"通过"。

---

## MI-03 Memory 必须存在 Evidence

每条正式记忆都要能回答"**你凭什么记着这个**"。
没有来源的长期记忆无法审计，也无法在被质疑时自证。

**守着它的测试**：

- `m4:test` → 分组「证据（MI-03）」：`assertMemoryEvidence()` 三条失败关闭。
- `m4:test` → 分组「证据继承（计划书第 41 节）」：
  派生记忆必须继承根（`derivation_without_source` /
  `derived_evidence_root_missing`）。
- `m4:verify` → §11 与「记录带 evidenceRootIds（MI-03）」。
- `eval:m4` → `M4-017 Evidence Missing`：引用不存在的证据 → 拒绝整条候选。

> 这条规则**没有** Promptfoo 覆盖：抽取行为评测里没有"引用不存在的证据"
> 的用例。证据缺失的判定在**放行与持久化**两层，
> 不在"模型抽得准不准"那一层 —— 所以它属于纯程序测试（计划书第 188 节）。

**代码位点**：`src/kernel/contracts/memory.ts` 的 `assertMemoryEvidence()`；
`src/kernel/contracts/domain-event.ts` 的 `record.sourceRefs` 非空断言；
`src/kernel/app/memory/extractor.ts` 的「没有任何证据画像」失败关闭。

---

## MI-04 Memory 必须存在明确 Owner

"这条记忆属于谁"必须在写入时就确定，且**只能是她**。

没有 owner 的记忆在 M4 里没有意义：M4 是**角色记忆**系统，
不是通用知识库。一旦允许无主的记忆进入，
"她记住了"和"系统存了一条"就再也分不开了。

**守着它的测试**：

- `m4:test` → 分组「候选 → 记录」：owner 必须是 character，否则失败关闭。
- `m4:verify` → §12「多主体与未来实体（计划书第 8 / 153 节）」。
- `m4:verify` → §6「乐观锁（旧任务不能覆盖新状态）」。

> ⚠️ 这条**没有场景级与 Promptfoo 级覆盖**。owner 是一个写入契约，
> 不是"模型抽得对不对"的问题 —— 但它也因此只在两个测试文件里有证据。

**代码位点**：`memory-validator.ts` 的 owner 闸；
`memory.ts` 的 `createMemoryCandidate` / `recordFromCandidate`。

---

## MI-05 Memory 的 Subject 不得默认写死为 User

`subject` 是"这条记忆**关于谁**"，它不是 `owner`，也**没有默认值**。

把 subject 默认成 User 会有两个后果，都很难回滚：

1. 她的自我认知（`self_experience`、关于自己的偏好）会被记到用户名下；
2. 未来多主体（另一个角色、一个组织）到来时，历史数据的 subject
   已经全是错的，而**无法区分**"当时真的是 user"与"当时是默认值"。

**守着它的测试**：

- `m4:test` → 分组「Claim 的 subject 一致性」与「Episode 结构」。
- `m4:verify` → §12「多主体与未来实体」。
- `eval:m4` → `M4-011 Real Shared Episode`（真实的共同经历
  **可以**成为 EPISODE）、`M4-012 Contextual Preference`
  （限定条件不同 = 两个槽位，不许合并）。
- `eval:m4:promptfoo` → `M4X-005`：共同经历不能被抽成 `person_fact`；
  抽取 prompt 里 `subjectToken` 显式取 `USER` / `CHARACTER`。

**代码位点**：`extractor.ts` 的 `subjectToken: 'USER' | 'CHARACTER'`；
`processorEventViewOf()` 把 `actorType` 标成 Actor 再进 prompt。

---

## MI-06 旧事实默认不得物理覆盖

旧值不是"错的"，是"曾经对的"。物理覆盖会同时毁掉三样东西：
可追溯性、可回滚性、以及"她当时确实是那样"的历史。

**守着它的测试**：

- `m4:verify` → §5「状态转移（SUPERSEDE / RETRACT / DISPUTE / RESTORE）」：
  明确断言「旧条变成 SUPERSEDED 且历史仍在（不是物理删除，MI-06）」。
- `m4:verify` → 「同槽位的新取值是**另一条**记忆（不是改旧的，MI-06）」。
- `m4:verify` → §8「Replay A == B」：如果发生过物理覆盖，
  重放就重建不出旧值。
- `m4:test` → 分组「时间语义（validFrom / validUntil / recordedAt）」。

**代码位点**：`memory-store.ts` 的 `apply()` 只 append `memory_events`，
不 UPDATE 旧行的业务字段。

---

## MI-07 Correction 必须能够追溯旧 Memory

用户说"我之前说错了"，系统必须知道**它在纠正哪一条**。
单向指针不够：`new.supersedes = old` 能回答"新条推翻了谁"，
但回答不了"这条旧的为什么不见了"—— 而后者才是审计要问的问题。

**守着它的测试**：

- `m4:verify` → 「旧记忆 supersededBy 指向新条（MI-07）」。
- `m4:verify` → 「新记忆的 supersedes 指回旧条（**双向可追溯**，MI-07）」。
- `m4:verify` → §8：`rebuildMemory()` 的比较**包含** `supersedesOf()`
  —— 只比 status 会比出一个"重放成功"的假象。
- `m4:test` → 分组「Reducer 元信息」。
- `eval:m4` → `M4-002 Explicit Correction`（覆盖由
  `verify-m4-persistence.ts §13` 提供，见场景套件的覆盖映射表）。

---

## MI-08 Forget 与删除原始 Conversation 是两种操作

"忘掉这件事" = 让这条记忆不再作为现状生效（`RETRACTED`，历史留痕）。
"删除那轮对话" = 抹掉事实账本里的一行。

这两件事**永远不能合并成一个操作**，因为它们的后果不可逆程度不同：
后者会破坏重放与审计，而用户说"忘掉"时通常并没有要求后者。
把前者实现成后者，是"用户要求忘记、系统删掉了证据"这类事故的标准成因。

**守着它的测试**：

- `m4:verify` → §5「状态转移」：`RETRACT` 之后历史仍在。
- `m4:test` → 分组「Reducer 元信息」的 `applyRetracted`。
- `m4:test` → 分组「Memory Admin CLI」：用法文本列出了全部子命令 ——
  其中**没有**删除会话事件的子命令。
- `pnpm memory:retract` → CLI 只操作记忆状态。

> ⚠️ 这条**没有场景级与 Promptfoo 级覆盖**。

---

## MI-09 推断不能自动升级成用户事实

用户**没有说过**的东西，不能因为系统"推断出来了"就变成用户事实。
这是 MI-02 在权威维度上的对偶：MI-02 管"谁说的"，MI-09 管"够不够格"。

**守着它的测试**：

- `m4:test` → 分组「权威映射」：`authorityFromSource` 对
  `SYSTEM_INSTRUCTION` **失败关闭**。
- `m4:test` → `assertMemoryAuthorityAllows()`：用户个人事实
  （`person_fact`）的权威必须落在受限集合里。
- `m4:verify` → §11「关闸：无证据 / 非法权威的记忆」。
- `eval:m4` → `M4-009 Assistant Guess`。
- `eval:m4:promptfoo` → `M4X-010`：用户明确陈述 →
  权威只能是 `EXPLICIT_USER_STATEMENT` 系。

**代码位点**：`src/kernel/contracts/memory.ts` 的
`authorityFromSource()` 与 `assertMemoryAuthorityAllows()`。

---

## MI-10 所有自动 Memory 写入必须幂等

后台抽取是**自动**的：同一批事件可能被重跑（重试、重启、重复 worker）。
"重跑一次就多一条记忆"会让记忆库随重试次数增长，
而用户看到的是"她越来越唠叨同一件事"。

幂等键必须**区分操作类型**：`create` 与 `supersede` 对同一
`memoryId` 是不同的写入，用同一个键会互相顶掉。

**守着它的测试**：

- `m4:verify` → §4「幂等（计划书第 68–69 / 186 节）」。
- `m4:verify` → §3「同一批多条候选（审计 §6 F4 —— M4 最容易做错的一处）」。
- `m4:test` → 分组「MemoryId 派生（幂等的关键）」与「抽取任务的幂等键」。
- `eval:m4` → `M4-016 Processor Version Change`：`@2` 不被 `@1` 的
  幂等记录拦住（版本是键的一部分）。

**代码位点**：`computeIdempotencyKey({ ..., operation: \`${operation}:${memoryId}\` })`
—— `operation` 前缀是刻意的，见本条第 2 段。

---

## MI-11 Memory 当前状态必须可 Replay

投影是**缓存**，事件流才是真相。
如果 `A（从零重放）≠ B（增量折叠）`，那么"她记得什么"就取决于
"这台机器是怎么走到今天的"—— 那意味着换一台机器、或重启一次，
她的记忆就会不同。

**守着它的测试**：

- `m4:verify` → §8「Replay A == B（计划书第 73–74 节）」。
- `m4:verify` → §7「reducer 版本守卫（计划书第 24 / 29 节）」。
- `m4:test` → 分组「Reducer 元信息」。
- `pnpm memory:replay` → CLI 可对单条或全部记忆重跑折叠。
- `eval:m4` → `M4-013 Cross-session Persistence`（同进程内的两次查询
  一致 —— ⚠️ **不是**跨进程，见 §16.1）。

**代码位点**：`memory-store.ts` 的 `rebuildMemory()` /
`rebuildCharacterMemories()`。

---

## MI-12 Memory Store 不是 Seed Identity Store

Seed 是"她出生时是什么样"（有版本、有固定 Context 位置、
**不会被任何自动流程改写**）；Memory 是"她后来记住了什么"。

两者共用一个存储就是灾难的起点：自动抽取路径一旦能碰到 Seed，
她的核心人格就成了可被对话内容改写的东西 ——
而 M4 恰好是第一个引入**自动写入**的里程碑。

**守着它的测试**：

- `m4:test` → 分组「登记表（M4 的加法不得侵蚀 M2.5）」。
- `m4:verify` → §1：迁移 0005 是**纯新增**，不动 seed 相关表。
- `pnpm m3:seed-check` → Seed 指纹未变（基线比对）。
- `m3:verify`（67 项）与 `m3.5:verify`（31 项）在 M4 之后**全部保持绿色**
  —— 这是"没侵蚀"的机器证据。

---

## MI-13 Memory Backend 不得定义 Character Memory 的业务语义

后端只回答"存/取/查"，不回答"什么算记忆、什么时候可以写、谁能写"。

这条决定了 M4 能不能换存储：如果业务规则长在后端里，
换一个后端就等于换一套语义，而"她记得什么"会跟着存储实现变化。

**守着它的测试**：

- `kernel:test`（`scripts/kernel-tests.ts`）→ 「Kernel 边界」依赖方向检查：
  领域层不许 import `@elizaos/*` / `node:fs` / `drizzle-orm` /
  `../infrastructure/*`。
- `m4:test` → 全部判据（权威、证据、值闸、冲突、幂等）都在
  `kernel/policies` 与 `kernel/app`，**不在**
  `infrastructure/persistence`。
- 端口方向：`MemoryFoldPort` 由**领域层定义**
  （`src/kernel/app/memory/explicit-service.ts`），
  `createNativeMemoryStore()` 只是它的一个实现 ——
  实现依赖接口，不是接口依赖实现。

> ⚠️ 这条是**架构性质**，由依赖方向检查间接守着，
> 而不是有一条测试叫"MI-13"。

---

## MI-14 External/Tool Observation 默认不等于用户事实

工具输出、外部观测、系统注入的文本，都**不是**用户在陈述。
计划书第 154 节要求 Tool Observation 与用户陈述隔离，
M4 不主动发展这类来源。

**守着它的测试**：

- `eval:m4` → `M4-018 Tool Source Isolation`。
- `m4:test` → `processorEventViewOf()` 对 `actorType === 'tool'`
  **失败关闭**（抛错，不降级成 character / system）。
- `m4:test` → 分组「后台抽取 · Source Firewall」。
- `eval:m4:promptfoo` → 抽取 prompt 里工具来源渲染成 `Actor=SYSTEM`。

**为什么失败关闭而不是降级**：`ProcessorEventView.actorType` 只有三种
（user / character / system），而 `ConversationEvent` 有四种（多一个 tool）。
把 tool 冒充成 character 或 system 正是 `tool_event` 这个枚举要阻止的
伪装通道 —— 降级会把一个"我们还没设计"的通道悄悄打开。

---

## MI-15 未来世界事实不得偷偷存成 Character Personal Memory

"世界是什么样"（M3.5 的 world state）与"她记得什么"（M4 的 Memory）
是两种东西。把世界事实塞进她的个人记忆会有两个后果：

1. 它会受她的**视角**影响而失真（她的记忆本来就允许有偏差）；
2. 它会在她"忘掉"或"记错"时被一起改掉 —— 而世界事实不该因为她
   的想法变化而变化。

**守着它的测试**：

- `m4:test` → 分组「受控枚举」：`MemoryType` 是**封闭四值**，
  没有 `world_fact` / `entity_state` 之类的选项。
- `m4:verify` → §12「多主体与未来实体」。
- `m3.5:test`（`scripts/future-compat-tests.ts`）→
  `FC-T04 Intent ≠ Result`：`CharacterDomainEvent` 不能承担世界事实
  （scope 校验失败关闭）。
- `m3.5:test` → `FC-T08`：显式输入与 Observation 派生结果不一致 →
  失败关闭（不许两个来源并存）。

> ⚠️ 这条目前是**结构性禁止**，不是运行时拦截：M4 根本还没有
> 能表达世界事实的记忆类型，所以"不得偷偷存成"靠的是
> "没有那个选项可选"。等 M5 引入世界状态时必须补一道显式校验
> （见 §16）。

---

## 16. 未覆盖与已知限制

**这一节是刻意保留的。** 一份只列"已覆盖"的宪法会让人以为
所有规则都有机器在看。下面每一条都是当前**真的没有**机器证据的东西。

### 16.1 MI-11 的跨进程半边缺一个场景

`M4-013 Cross-session Persistence` 目前是**同进程内的两次查询**。
真正的"重启后记忆还在"是 `M4-014 Restart Persistence`，
它需要**跨进程** —— 当前套件跑在单个 PGlite 进程里，做不到。

- 场景套件的覆盖映射里如实标为
  「**Phase 12**（需要跨进程，尚未实现）」。
- 在那之前，MI-11 的"可 Replay"有机器证据，
  "重启后仍在"**只有**同进程证据。

### 16.2 `MEMORY_MERGED` 支持完整，但没有生产者

`merge` 操作在 validator（`domainEventTypeFor`）与 reducer
（`applyMerged`）里都是通的，`domain-event.ts` 也校验了
"必须至少有一个败者：没有败者的合并其实是创建"。

但**没有任何组件会构造 merge 提案**：

- 冲突分析 `resolveConflict()` 的五个出口是
  `CREATE` / `REJECT_DUPLICATE` / `SUPERSEDE` / `MARK_DISPUTED` /
  `NEEDS_REVIEW` —— 重复走的是 `REJECT_DUPLICATE`，不是合并；
- 全仓库搜不到构造 `operation: 'merge'` 的调用点。

结论：`MEMORY_MERGED` 是"接口就位、驱动缺失"（Phase 6 的
DuplicateAnalyzer 延后）。**不要**把它读成"合并功能已验证"。

### 16.3 空过的绿：真实模型档的三条用例

`M4X-004` / `M4X-020` / `M4X-021` 在真实模型档下**可能是空过**：
模型什么都没抽时，它们的判据一条都不执行，用例是绿的。

评测报告把这类绿单列为 `vacuous`，**不混进"通过"**，
并在套件级拒绝"整档都是空的绿"（Promptfoo 的
「整档都是空的绿」断言）。
它们的确定性判据由 `injection` 路径承担
（`M4X-022` 注入 2 条污染候选 → 必须被拒 2 条）。

### 16.4 predicate 的同义槽位靠 **description 消歧**，不是靠代码

`food.preference.cilantro`（专用，enum）与 `food.avoid.general`
（宽泛，text）都登记在册，都"讲得通"。

实测（真实模型档 `M4X-030`）模型选了宽泛槽位 —— 而专用槽位的
`examples` 明确写着 `'我不吃香菜'`。修法是**把 `description` 交给模型**
并加"优先最具体槽位"规则（`buildExtractionPrompt`）。

这意味着：**同一事实落同一槽位**当前依赖一次模型判断，
不是一条结构性保证。没有任何代码阻止模型下次又选宽泛槽位。
`M4X-030` 是回归守卫（连续 4 轮 live 稳定通过），
但它守的是一次 prompt 工程的效果，不是一条不变量。

若将来需要硬保证，正确做法是在登记表里加**同义映射**
（把宽泛槽位标记为"仅当无专用槽位时可用"并由代码强制），
而不是继续加强 prompt。`memory-predicates.ts` 第 109–110 行的注释
已经预留了这个方向。

### 16.5 `dedup` 与 `temporal` 两个评测套件还没有用例

`ExtractionEvalSuite` 类型里预留了 7 个套件，用例表里只有 5 个。
配置生成器会**显式打印**这两个未覆盖的套件名，并说明
「它们不是通过，是未覆盖 —— 不要读成绿色」。

### 16.6 `hydrate` 的 N+1 查询

`list(limit=50)` 大约产生 150 次查询。功能正确、性能未优化。
这是**已知**的、记录在案的取舍，不是疏漏。

### 16.7 内容指纹不是抗碰撞的

`memoryDigest()` 用 FNV-1a。它是**去重用的启发式**，不是安全摘要。
把两条内容不同但指纹相同的记忆误判成重复是**理论可能**的；
由于指纹只用于"完全相同就拒"这一层，且第二层
（`CanonicalMemoryKey`）会独立判定，实际影响被限制在
"极低概率下少记一条同槽位同内容的记忆"。

### 16.8 违反过 UTF-8 编辑纪律

这份文件的初稿是用 PowerShell 的 `Get-Content` / `Set-Content`
改出来的，中文当场变成乱码，只能整篇重写。
**本项目已记录过这条陷阱**（M4 早期 `memory-store.ts` 被同样方式损坏），
本次仍然踩到。

结论重申：文本文件只用 `read` / `write` / `edit` 工具，
`Set-Content` / `Get-Content` 一律不用 —— 包括"只改一个词"的小修改。

### 16.9 `weak` 置信度**没有生产者**（M4.1）

`MutationConfidence` 的四个值里，`exact` / `strong` 有真实来源，
而 **`weak` 今天没有任何路径产出它**。

这不是装饰：它的价值是**契约** —— 将来任何新增的模糊路径必须先显式声明
自己的置信度，而不是悄悄把 `resolved` 当成"可以改"。
用例 `Mutation Gate：mayMutate 只对 exact / strong 放行` 明确断言
weak / none / ambiguous / not_found **全部 false**。

与 16.2（`MEMORY_MERGED` 接口就位、驱动缺失）是同一类如实记录。

### 16.10 显式路径的自然语言覆盖面**受规则表限制**（M4.1 / D2-A）

显式路径的缺省抽取器是**规则**抽取器，它只认槽位线索表里写过的说法。
因此"记住，我平时主要用 VS Code"会 `content_unresolved`
（`tsx scripts/diag-m4-explicit.ts` 可离线复现）。

M4.1 **没有**把 LLM 兜底设成默认：
`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`（**默认 false**）打开后走
`ChainedContentExtractor([rule, llm])`。理由是任务书 M4.1 §19 的原话：
**"Coverage 不完美可以接受，False Success 不可接受"** ——
而 False Success 已由 `response-truth.ts` 堵死。

**含义**：她"听不懂"某些合理说法时**会如实说没记住**，而不是假装记住。
要扩大覆盖面，打开那个开关（并承担模型不确定性），或往线索表补说法。

### 16.11 后台抽取**未接线**，开关是惰性的（M4.1 / D3）

`CHARACTER_MEMORY_BACKGROUND_ENABLED` 没有任何消费者 ——
打开它**不会**启用自动记忆抽取（实测：两轮普通陈述产出 0 条）。

因此**她目前只记得住被明确告知的事**。详见
[`memory-lifecycle.md`](./memory-lifecycle.md) §3。
机器锁在 `m4:test`「生产装配接线（回归锁）」里。

---

## 17. 规则与测试的对应总表

| 规则 | `m4:test` 分组 | `m4:verify` 节 | 场景（`eval:m4`） | Promptfoo（`M4X-*`） |
|---|---|---|---|---|
| MI-01 | 受控枚举 | §1 | M4-008 | M4X-003 / M4X-004 |
| MI-02 | 反污染 / 权威映射 / 后台抽取 · Source Firewall | §11 | M4-009 / M4-010 | M4X-022（注入） |
| MI-03 | 证据（MI-03）/ 证据继承 | §11 | M4-017 | — |
| MI-04 | 候选 → 记录 | §12 / §6 | — | — |
| MI-05 | Claim 的 subject 一致性 / Episode 结构 | §12 | M4-011 / M4-012 | M4X-005 |
| MI-06 | 时间语义 | §5 / §8 | — | — |
| MI-07 | Reducer 元信息 | §5 | M4-002 | — |
| MI-08 | Reducer 元信息 / Memory Admin CLI | §5 | — | — |
| MI-09 | 权威映射 | §11 | M4-009 | M4X-010 |
| MI-10 | MemoryId 派生 / 抽取任务的幂等键 | §3 / §4 | M4-016 | — |
| MI-11 | Reducer 元信息 | §7 / §8 | M4-013（同进程） | — |
| MI-12 | 登记表 | §1 + M3 / M3.5 全绿 | — | — |
| MI-13 | Kernel 边界（依赖方向） | 架构性质 | — | — |
| MI-14 | 后台抽取 · Source Firewall | — | M4-018 | 抽取 prompt 的 Actor 标注 |
| MI-15 | 受控枚举 | §12 | — + `FC-T04` | — |

> 表格里的「—」是**如实标注**，不是"不用测"。
> 大部分「—」的规则由别的层覆盖（见上方各条正文），
> 但 MI-04 / MI-08 的场景级与 Promptfoo 级覆盖确实偏薄 ——
> 它们的证据主要在领域测试与持久化测试里。

---

## 18. M4.1 新增的五条不变量（Correctness Fix 的产物）

> 这五条不是"新功能"，而是 M4 验收后由真实链路冒烟发现的缺陷所**沉淀下来的规则**。
> 事故复盘见 [`../m4/M4-问题说明.md`](../m4/M4-问题说明.md) 与
> [`../m4/M4-Defect-D1-wrong-target-forget.md`](../m4/M4-Defect-D1-wrong-target-forget.md)。

### INV-M41-01 唯一候选 ≠ 相关候选

```text
candidate_count == 1
```

**绝不能**推出 `target == candidate`。只有存在**充分的、可检查的**目标相关性证据时，
才允许把候选当成操作目标。

**为什么要写成一条规则**：M4 里那行 `if (active.length === 1) return resolved`
看起来完全合理 —— 它的问题不是"挑错了"，而是**用"唯一"替代了"相关"**。

**守着它的测试**：
- `m4:test` → 分组「目标相关性闸（M4.1 / D1 回归）」（T-D1-001 / 002 / 005）
- `m4:mutation-safety:verify` → 「D1 reproduction｜唯一候选 ≠ 相关候选」
- `m4:nl-mutation:verify` → L3-04

**代码位点**：`target-resolver.ts` 第 3 步 —— 先取候选，再做
`lexicalOverlapHits()`，**候选数不参与判定**。

---

### INV-M41-02 遗忘失败优于遗忘错误对象

对 forget / retract / update / correction / restore / merge：
**只要系统不能高置信度确认操作目标，就必须安全失败。**

允许：`not_found` / `ambiguous` / `content_unresolved` / `target_unresolved`
不允许：`guess-and-mutate`

即：**宁可不改，也不能猜着改。**

**守着它的测试**：
- `m4:test` → 「Mutation Gate：mayMutate 只对 exact / strong 放行」
- `m4:mutation-safety:verify` → 每条 negative 都断言
  `before_hash == after_hash` **且** 事件计数不变
- `m4:nl-mutation:verify` → L3-04 / L3-05

**代码位点**：`target-resolver.ts` 的 `mayMutate()`；
`explicit-service.ts` 三处 destructive 入口都先过它。

---

### INV-M41-03 系统不能宣称未发生的行为已经发生

`executed === false` 时，不得出现「记住了 / 删掉了 / 已经改了 / 恢复了 / 完成了」
这类**未被否定**的行动性语言。任何行动性语言必须由**真实执行结果**驱动。

**守着它的测试**：
- `m4:test` → 分组「执行真相（Response Truth / INV-M41-03）」（7 条，纯函数、确定性）
- `m4:smoke:live` → 每一轮都断言"库没变 ⟹ 回复不含成功口吻"（C23）

**代码位点**：`response-truth.ts` 的 `applyResponseTruthPolicy()`，
在 `main.ts` 的 `ChatSession.send()` 里于**记账本之前**应用。

⚠️ **它有两层**：prompt 层的指令（`droppable: false` 的 section）+ 确定性的后置守卫。
只有后者能给出"语法级"保证 —— 前者取决于模型是否配合。

---

### INV-M41-04 LLM 可以帮助理解，但不能直接决定持久状态

任何 LLM 抽取只能生成**候选**：

```text
LLM → Structured Candidate → Schema Validation
    → Authority / Conflict / Dedup → Proposal → Commit
```

禁止 `LLM output → 直接写 memory store`。

**守着它的测试**：
- `m4:test` → 反污染分组（结构性闸在**构造候选时**就抛错）
- `kernel:test` → 「Kernel 边界（依赖方向）」
- `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED` 打开时走的是
  `ChainedContentExtractor`，其输出仍进同一条放行链

---

### INV-M41-05 M4 是否通过必须由**真实用户链路**决定

`Unit PASS` / `P0 PASS` / `CI PASS` **只证明组件层正确**。
正式 PASS 还必须满足：

```text
Natural Language → Intent → Extraction → Target Resolution
  → Memory Service → Event → Projection → Response
```

整条链路通过，且**回复与库里真实发生的一致**。

**为什么**：M4 有 939 项断言、28/28 P0、五道新增门，而 D1 从中间穿了过去 ——
因为它们几乎都**直接给 memoryId**，绕过了"从自然语言解析目标"这一层。

**守着它的测试**：
- `m4:nl-mutation:verify`（Layer C，离线确定性）→ **G12 Hard Gate**
- `m4:smoke:live`（Layer D，真实模型 + 生产库副本）→ **G13 Hard Gate**

⚠️ 这两道门**不得**因为"939 绿 / 28-28 P0"而被跳过。

---

## 19. 改动这份文件时

1. **加一条规则** → 同时指出守着它的测试。指不出就先别加，
   或者加进 §16 承认它现在只是愿望。
2. **改一条规则** → 先改这份文件，再写 ADR（M4 的 ADR 从 ADR-020 起）。
3. **删一条规则** → 需要 ADR，并说明为什么它不再是规则
   （而不是"因为它经常红"）。
4. **测试改名或换地方** → 本文件的引用必须跟着改。
   §17 的表格与正文里的分组名都是**可核对的引用**，
   不是描述性文字；对不上就是本文件坏了。
