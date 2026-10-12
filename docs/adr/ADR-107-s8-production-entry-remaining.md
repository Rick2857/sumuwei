# ADR-107：S8 生产故事入口的剩余部分（`L-S8-30` 的关闭设计）

状态：**`ACCEPTED / RULED`**（2026-10-05 用户裁定：**四个待裁定项全部按草案推荐** ⇒ `R-1b` / `R-2a` / `R-3b` / `R-4c`）。
**本文的冻结口径自此生效**；实现按 §4 的顺序推进，每一步的读数单独出。
日期：**2026-10-05**。上游：[`ADR-094`](ADR-094-s8-story-cognition-production-activation.md)（`ACCEPTED / DESIGN FROZEN`，本文**不改它一个字节**）。
立案：[`S8-Consumption-Entry-Gap.md`](../post-lv2/S8-Consumption-Entry-Gap.md)（`L-S8-30` `OPEN`）。
登记册：[§0u](../Tech-Debt-Register.md)。

---

## 0.0 裁定记录（2026-10-05）

用户就本文 §2 的四个待裁定项裁定：**全部按草案推荐**。逐项落定如下
（**子问题也一并落定**，不留"没说的也算默许"的缝）：

| 项 | 裁定 | 子问题落定 |
|---|---|---|
| `R-1` | **`R-1b` 独立私有决策调用** | `Q2`：这次调用是**生产代码路径**；验证它需要 `with-test-model` 的**测试模型档**，按既有授权规则单独办，**不在实现轮里自动跑真模型**。`Q3`：**写成机器判据** —— 没有活跃 run 时这次调用**一次都不许发**（否则每轮白付一次调用） |
| `R-2` | **`R-2a` 显式 CLI `story:start`** | `Q5`：**可以**新增迁移；但本轮**只写迁移代码 + 门**，**不应用到真实库**（真实库已 v13；应用另申授权）。`Q6`：按 `D02.4` —— **单用户单 run**；已有活跃 run 时 `start` **拒收**（不是"允许多个但只消费一个"） |
| `R-3` | **`R-3b` 每轮扫 + `open()` 补扫** | `Q8`：反思消费**不进用户等待的那一轮**（`R-3a` 被否） |
| `R-4` | **`R-4c` 端到端行为锁为唯一主张来源**，文本锁降级为"装配在场" | `Q10`：**要**三段式（正控 / 负控 / 恢复）。`Q11`：**要**登记进 `postlv2-controls` lane（`AUD-20261005-03` 刚建的那条） |

> ⚠️ **裁定 ≠ 完成**：`L-S8-30` 要等 §4 的六步都出读数才谈关闭；本文不再重复那句免责，但它仍然成立。

> ⚠️ **本文档原为"待裁定的设计"。2026-10-05 用户已裁定（见 §0.0）⇒ 现在它是冻结口径。**
> 它做四件事：① 把 `ADR-094` **冻结**的部分与**真正还没定**的部分分开；② 记录每个未定项的备选、代价与裁定结果；
> ③ 写明每个选项牵动哪些**已有门与冻结面**；④ 给出实施顺序。**注意**：裁定之前它一行实现都没动；
> 裁定之后按 §4 顺序实现，**每一步的读数单独出**。

---

## 0. 先说清现状（`L-S8-30` 的三条事实，逐条可复核）

```text
① `StoryCognition.ingestChoice` 在**全仓**没有生产调用者
     接口 src/infrastructure/runtime/story-cognition.ts:71-74
     实现 src/infrastructure/runtime/story-cognition.ts:239-247
     ⇒ `grep -rn "ingestChoice" .` 只命中这两处
② `ADR-094` `D02.2④` 要求的提案受控值 `proposalType='story-choice'` 在 `src/**` **不存在**（零命中）
③ ⇒ `storyline_commits` 在生产里**永远 0 行** ⇒ 消费回路每次 `open()` 都读到"无可消费项"
     （`story-cognition.ts:255-258`：`listRuns` 为空 ⇒ `{ progress: [], drained: true }`）
```

**并且消费点只有一处**：`consumeOnce` 在 `src/main.ts:2002`，位于 `async open()`（`src/main.ts:1794`）内
⇒ **每次会话打开跑一次**，不是每轮。⚠️ 这与 `ADR-094` `D03` 的"提交后由既有调度器消费"**口径不一致**（`L-S8-30` §C2）。

**它不是"没接线"**：三个消费者（affect / relationship / reflection）都已在回路数组里
（`story-cognition.ts:273` 的 `steps: [affectStep, relationshipStep, reflectionStep]`），
机制面也有读数（`postlv2:s8:production:verify` 与 `postlv2:s8:lifecycle:verify`）。
**缺的是"入口侧没有东西可消费"。**

### 0.2 ⚠️ **对草案 premise 的一处如实更正**（2026-10-05，起草后核实）

草案初稿断言：「"活跃 run"在当前 schema 里**无处存在** ⇒ `D02.2①` 的"活跃 run"**必然**要求一个新的持久化位置」。
**这个断言不准确**，更正如下（证据逐条可复核）：

```text
① **已经存在一条"开局"路径**，不是没有：
     `src/kernel/app/storyline/commit-service.ts:252-281`
     revision==1 且 commitId 缺失 ⇒ `startStory(...)`；已有开局且 idempotencyKey 不同 ⇒ `story_run_already_started`
     （"拒绝把第二次开局当成同一次"）
   ⇒ 开局**就是**一条 `revision=1` 的提交（`event_type = STORY_STARTED`），
      `run_id` 因此**本来就**被持久化在 `storyline_commits.run_id` 里。
② **"活跃"是 fold 出来的，不是存起来的**：
     `commit-service.ts:108-136` `loadStoryRun`：`commits.length === 0` ⇒ `story_run_not_started`；
     `src/kernel/storyline/world-machine.ts:100-101` `StorylineState.terminal`
     （"终局或退出后为 true：**不再**接受任何推进"）
③ `listRuns` 是 `select distinct run_id from storyline_commits`（`story-ledger-store.ts:357-364`）
   —— 它是**投影**，不是一张表；**没有** `active` 标志。
```

⇒ **正确结论**：`D02.2①` 的"服务端生成并**持久化**"**不需要新表**——`runId` 已经持久化在提交行里；
"活跃"可以由 `loadStoryRun` + `terminal` **算出**；而 `D02.4` 的"**单用户单 run**"让
"该会话的活跃 run" = "该故事**恰好一个非终局 run**"，**会话↔run 的绑定也因此不需要第三个位置**。

⇒ 因此 `R-2` 的裁定子问题 `Q5`（是否新增迁移）**在本轮变成不必要**：
**不新增 DDL**（`AGENTS §3` 的冻结迁移面一个字不动，真实库也**完全不需要**任何迁移授权）。
本文按这条更正实现，并把"新表"降级为**未采用的备选**。**这处更正不改变用户的顶层裁定**（`R-2a` = 显式 CLI），
只改变"它的持久化落在哪里"。

### 0.1 当前树上的基线读数（2026-10-05，供裁定后对照）

`pnpm postlv2:s8:production:verify` = **PASS（`measured_count = 24`）· EXIT 0**
（head `a5de36f8`，隔离库，离线 provider ⇒ 本门零网络）。它逐条证明的是**入口逻辑与消费回路本身没问题**：

```text
N1 开关关闭 ⇒ `disabled` 且**零写入**（"没启用"与"拒绝"是两件事）
N2 合法选择 ⇒ `committed`，提交身份与 revision 与账本一致
N3 绑定字段**进不来**：提案里塞 interactionRef/anchor/actorId/runId ⇒ 账本读回仍是**服务端**的值（签名层强制）
N4 非法选择**全拒且零副作用**（未知选项 / 过期 revision / 形状坏）
N5 幂等：同一服务端键重复投递 ⇒ 账本**不新增**第二条
N6/N7 按水位**逐条**消费；**其它消费者水位不动**（独立）
N8 失败者**停在自己位置**、重跑**从同一条继续**（调用序列 [1,2,3,3]）、成功者不受影响
N9 真实装配的三个 step 都执行到底，三条水位都推进
   ⚠️ 读数：新增领域事件 **0 条**（AFFECT_* 0 · RELATIONSHIP_* 0）——
      「**故事规则未触发时 0 条是合法读数**」，不是"消费失败"
```

⇒ 本文要补的**只有入口侧那一段**；**不**重开上面任何一条（它们的判据与读数都在案）。

---

## 1. `ADR-094` 已经**冻结**的部分（本文**不重开**）

| 项 | 冻结内容 | 出处 |
|---|---|---|
| 开关 | `CHARACTER_STORY_COGNITION_ENABLED`（代码缺省 **false**） | `D01` |
| 三条硬约束 | ① 模型只能**提案**，世界判定归 `advanceFromProposal()`；② 服务端绑定字段（`interaction_ref` / `anchor_conversation_event_id` / `actor_id`）**只能由服务端填**；③ **不做词形判据**（先例 `L-M55-15`） | `D02.1` |
| 入口条件 | 开关打开 **且** 该会话存在一个**用户显式开始**的活跃 run（`runId` 服务端生成并持久化）。**不自动开始任何故事** | `D02.2①` |
| 选择解析 | 模型在该轮**只被允许产出候选 `choiceId`**（内容包定义的机器键），形状进既有提案通道（`proposalType` 新增受控值 `story-choice`） | `D02.2②` |
| 世界判定 | 非法选择（未知 choice / 非 frontier / revision 过期 / 版本不符）**一律拒收**且**零副作用** | `D02.2③` |
| 提交 | `commitStoryTurn()` 原子落账本；幂等键 `story-commit:<runId>:r<revision>:<anchorEventId>`（**服务端拼**） | `D02.2④` |
| 时序 | `beginTurn` →（若启用且 run 活跃）模型产出候选 → 判定 → 通过则提交 → 回复照常生成。**回复与提交解耦** | `D02.3` |
| 首版不做 | 不做"她替用户选"· 不自动开始/推进剧情 · 不做多用户/多 run 仲裁（单用户单 run）· 不做故事事件的外部应用集成 | `D02.4` |
| 水位 | 每消费者一条独立故事水位（**裁定 A**，机制已实现并验证） | `D03` |
| 额度 | `ContextBudget.adaptiveSelfTokens` 决定入不入模（缺省 **0**）；与开关**分开** | `D04` |
| 认知完整性 | 属 `Privileged Cognitive Operation`，须经 [cognitive-integrity](../architecture/cognitive-integrity.md) 审查 | `D05` |
| 激活前置 | `D09` 逐项清单（缺一项即不得激活） | `D09` |

⇒ **所以本文要裁的不是"要不要做"，而是"冻结文本没有回答的那几件怎么做"。**

---

## 2. 真正还没定的四件（**请逐项裁定**）

> 每项格式：**冻结文本说了什么** → **它没说什么** → **备选** → **代价与牵连** → **草案推荐**。
> ⚠️ 推荐只是推荐；**裁定权在用户**。

### R-1 · **谁产出 `choiceId`，经哪条路进放行口？**

**冻结文本说了**：模型在该轮产出候选 `choiceId`，形状进既有提案通道（`proposalType='story-choice'`）。

**它没说什么**：这条提案**搭哪一次模型调用**。两条现实可行的路：

✅ **已核实的两条事实（决定 R-1 的形状）**：

```text
① `proposal.proposalType` 是**自由字符串**，**没有**中央登记表：
     src/kernel/contracts/proposal.ts:129 / :177   —— 类型就是 `string`
   每个域**各自**声明自己的受控值常量，例如：
     src/kernel/contracts/affect.ts:545            —— 「提案类型名（proposal.proposalType 的受控值）」
     src/kernel/contracts/relationship.ts:529      —— 同上
   ⇒ 新增 `story-choice` = **新增一个常量 + 一个肯收它的放行口**，不是"往一张表里加一行"。
      `grep -rn "story-choice" src` = **0 命中**（`D02.2④` 确实未做）。
② 提案**不只是模型产的**：程序自己也造提案 ——
     `src/kernel/policies/goal-validator.ts:1026` 造 `proposalType: 'goal-operation'`
     `src/infrastructure/runtime/{affect-scheduler,adapters,reflection-runner}.ts` 各自造各自域的提案
   ⇒ "模型只提案"这条约束落在**更早的一层**（模型产出 **draft**，由放行口把它映成 proposal）。
      ⚠️ 所以 R-1a"搭既有提案通道"的真实含义是：**扩展主轮那份 draft 的 schema 与映射**，
      而不是"往 proposal 里塞一个字段"。
```

| 备选 | 做法 | 代价 / 牵连 |
|---|---|---|
| **R-1a** 搭**既有主轮提案通道** | 主轮那次模型输出里多一个判别式的提案项 | 要动**主轮 prompt 组装** ⇒ 很可能动到 `evals/fixtures/m3.5/prompt-baseline.txt` 的**逐字节基线**（`pnpm m3.5:test` 会红）⇒ 需要"有意改 prompt"的程序；且把故事耦合进主提案模式 |
| **R-1b** 走**独立私有决策调用** | 每轮（在开关打开且 run 活跃时）多**一次**私有调用，闭集输出 `{choiceId}`；与主 prompt 解耦 | 多一次调用（延迟 + 成本）；但**不碰**主 prompt 基线，且可像 `CHARACTER_TOOL_DECISION_MODE` / `CHARACTER_AGREEMENT_ENABLED` 那样**独立开关 + 独立门** |
| **R-1c** 首版**不由模型产出**，只接受服务端显式传入 | 例如 CLI/控制台显式选一次 | 最省、最可测；但把 `D02.2②` 的"模型提案"降级为"服务端提案"⇒ **与冻结文本冲突**，需要用户**明示修改** `D02.2②` |

**草案推荐**：**R-1b**。理由：它与 `D02.1③`（不做词形判据）一致，
且沿用仓库已有的两条先例（角色工具决策 / 约定慢路径），代价是**已登记过**的那一类
（每轮多一次私有调用 + 等待），并且它把"会不会发模型请求"变成**显式注入决定**（与 `reflectionStep` 的 provider 必填注入同一条纪律）。
⚠️ 但要注意：`D02.3` 把这一步写在 `beginTurn` 之后、回复之前 ⇒ **它是串行等待**，会加在延迟上。

**待裁定的具体问题**：
```text
Q1 选 R-1a / R-1b / R-1c？
Q2 若选 R-1b：这次私有调用**算不算**新增模型出站（⇒ 需不需要新的模型批次授权）？
Q3 若选 R-1b：它在**没有**活跃 run 时必须**一次都不调**（否则每轮白付一次调用）—— 这条要不要写成机器判据？
```

### R-2 · **"用户显式开始的活跃 run"怎么产生与持久化？**

**冻结文本说了**：该会话存在一个**用户显式开始**的活跃 run，`runId` **由服务端生成并持久化**；不自动开始。

**它没说什么**：**用什么动作**算"用户显式开始"，以及"活跃 run"**存在哪里**。

✅ **已核实的关键事实**：见 §0.2 的**更正**。要点：**新表不是必需的** ——
`runId` 已经持久化在 `storyline_commits.run_id` 里（开局**就是**一条 `revision=1` 的 `STORY_STARTED` 提交，
`commit-service.ts:252-281`），"活跃"由 `loadStoryRun`（`commit-service.ts:108-136`，0 条 ⇒ `story_run_not_started`）
与 `StorylineState.terminal`（`world-machine.ts:100-101`）**算出**。触发"谁来写这条开局"的是**入口**，不是新表。

```text
`listRuns` 是**从已提交的行推导**出来的，不是一张表：
  src/infrastructure/storyline/store/story-ledger-store.ts:357-364
  `select distinct run_id from storyline_commits where story_id = ? order by run_id asc`
⇒ 一个**还没有任何提交**的 run，在库里**没有任何表示**。
S8 的迁移只建了**两张**表（`src/infrastructure/persistence/migrations.ts`）：
  · `post-lv2-s8-story-ledger`                  :1418  → `storyline_commits`（v12）
  · `post-lv2-s8-story-consumer-watermarks`     :1515  → `storyline_consumer_watermarks`（v13）
  **没有** runs / sessions 表。
```

⇒ `D02.2①` 的"活跃 run（服务端生成并**持久化**）"**不需要新表**（见 §0.2 的更正）。
**因此本轮不新增 DDL、不新增迁移**：`AGENTS.md` §3 的冻结迁移面一个字不动，
真实库也**完全不需要**任何迁移授权（真实库当前 **v13**）。

| 备选 | 做法 | 代价 / 牵连 |
|---|---|---|
| **R-2a′（采用）** 显式 CLI + **从账本推导活跃 run** | `pnpm story:start` 走**既有**开局路径（`commitStoryTurn({action:{kind:'start'}})`）；"活跃" = 该故事**恰好一个非终局 run** | **零 DDL 变更** ⇒ 真实库**不需要**迁移授权；`D02.4` 单用户单 run ⇒ 会话↔run 绑定也不需要新位置 |
| `R-2a″`（未采用）显式 CLI + **新增 runs 表** | 新迁移 + 新表 + 新端口 | 要动**冻结的迁移面**（`AGENTS §3` 只许追加版本号）+ 真实库迁移**单独授权**；而它买到的东西（一个 `active` 标志）**已经从账本算得出来** |
| **R-2b** 对话式显式开始（一个受控提案） | 由模型/用户显式表达"开始" | 与 `D02.1③`（不做词形判据）有张力；"谁开始"会变成模型 ⇒ 与 `D02.2①` 的"**用户**显式开始"有张力 |
| **R-2c** `main.ts` 启动时按配置自动开一个 run | — | **与 `D02.2①` 的"不自动开始任何故事"直接冲突** ⇒ 需要用户**明示修改**冻结文本 |

**裁定与实现口径**：用户裁定 `R-2a` = **显式 CLI**；持久化落在哪一项按 §0.2 的更正取 **`R-2a′`（不新增 DDL）**。

⚠️ **CLI 形状的已知陷阱**（侦察所得，实现时必须处理）：
`src/invocation.ts:41-55` 的 `READ_ONLY_FLAGS` 这个**名字**指的是"**不探测模型连通性**"，**不是**"只读" ——
`--story-withdraw` 就在里面却是个**写操作**（`src/main.ts:5810-5814` 明写"它是**写操作**"）。
新增 `--story-start` 会**再往这个名单里放一个写操作** ⇒ 沿用可以，但**必须在注释里再次点明**语义；
把名单改名/拆分是**另一件跨里程碑的事，不在本轮**。
另：`pnpm story:withdraw` **至今没进** `docs/苏沐薇-使用说明.txt`（`AGENTS §5` 要求用户可见命令更新它 + `pnpm doc:sync`）——
本轮**不**顺带补历史欠账，但 `story:start` 自己**必须**按 §5 记账。

**待裁定的具体问题**：
```text
Q4 选 R-2a / R-2b / R-2c？
Q5 活跃 run 的持久化：新增迁移（版本号顺延）可否？**是否与真实库迁移一起授权**，还是先只做迁移代码、不应用到真实库？
Q6 允许**同时**存在几个 run？（D02.4 说"单用户单 run；并发 run 一律拒收"—— 是"拒收第二个 start"还是"允许多个但只消费一个"？）
```

### R-3 · **调度口径：消费点放在哪？**

**冻结文本说了**：`D03` 选项 A（每消费者独立水位）**已实现**；`D03` 的文字是"提交后由既有调度器消费"。
`D02.3` 的时序里**没有**写"提交后立刻消费"。

**它没说什么**：**实际上谁在什么时候调 `consumeOnce`**。现状是**只在 `open()` 调一次**（`src/main.ts:2002`）。

| 备选 | 做法 | 代价 / 牵连 |
|---|---|---|
| **R-3a** 提交成功后**同一轮内**立刻消费一次 | 在提交点之后直接调 `consumeOnce()` | 延迟/失败面进入轮内；但"提交了就一定被消费"最直观；⚠️ 反思消费**要发模型请求**（`reflectionStep`）⇒ 会把模型调用压进轮内 |
| **R-3b** 保留 `open()` 的补扫 + **每轮**再扫一次 | 每轮末尾扫，水位保证幂等 | 与 `D03` 的"既有调度器"最近；晚一轮出现状态变化；崩溃窗口由水位兜底 |
| **R-3c** 独立后台调度（定时器/进程） | — | 与"**不做系统级后台自主**"的既有立场张力（见登记册里 `CHARACTER_MEMORY_BACKGROUND_ENABLED` 的教训）；`D02.4` 也没要求 |

**草案推荐**：**R-3b**（每轮扫 + `open()` 补扫）。理由：水位机制**已经**保证"至多一次、失败停住不跳过"，
所以"晚一轮"是**可接受的降级**，而 R-3a 会把"反思要发模型请求"这件重活压进用户等待的那一轮。

**待裁定的具体问题**：
```text
Q7 选 R-3a / R-3b / R-3c？
Q8 反思消费**会真发模型请求**：要不要允许它**在轮内**发生（R-3a），还是坚持"只在不挡用户回复的地方发生"（R-3b）？
```

### R-4 · **"入口缺席"的负控怎么写（不许再是文本锁）**

**冻结文本说了**（`D01`/`ADR-094:276-278` 的立场）："**先挂锁再声称已消费 = 把锁变成假绿**"。

**它没说什么**：新锁**测什么**。现状的消费锁（`scripts/kernel-tests-memory.ts:3499-3512`）只断言
`src/main.ts` 的**文本**里同时出现 `storyCognitionEnabled` 与 `consumeOnce` 两个标识符
⇒ **入口没有调用者时它照样绿**（`L-S8-30` §C1.2 逐字立案）。

| 备选 | 做法 | 代价 / 牵连 |
|---|---|---|
| **R-4a** 端到端行为锁 | 在**隔离库 + 真入口**上让一次显式开始 → 一轮对话 → 断言 `storyline_commits` **≥1 行**且三个消费者水位**真的前进** | 最强；需要一个可跑的"最小真实轮"夹具（仓库里已有同型先例：`postlv2:s8:production:verify` 走隔离库） |
| **R-4b** 静态可达性锁 | 断言"存在一条从生产入口到 `ingestChoice` 的调用链" | 比文本锁强、比 R-4a 弱；仍可能被"调用链在但不可达"骗过 |
| **R-4c** 保留文本锁 + 新增 R-4a | 两者并存 | 文本锁**不再**充当"已消费"的证据（降级为"装配在场"），主张只挂在 R-4a 上 |

**草案推荐**：**R-4c**（R-4a 为唯一主张来源，文本锁降级为装配在场检查）。理由：与 `AGENTS.md` §6 第 7 条（正控/负控/恢复三段式）
和"计数型检测器必须自检 `measured_count > 0`"直接对齐 —— "**消费回路跑到底、无报错、水位停在 0**"
与"**没有任何提交**"在输出上长得一样，这正是要消灭的形态。

**待裁定的具体问题**：
```text
Q9 选 R-4a / R-4b / R-4c？
Q10 新锁要不要**同时**做三段式（正控：显式开始 ⇒ 有 commit；负控：**故意把入口调用者摘掉** ⇒ 必须响；恢复 ⇒ 又安静）？
Q11 这些门要不要登记进 `postlv2-controls` lane（`AUD-20261005-03` 刚建的那条）？
```

---

## 2.5 侦察补充：三处**会影响实现**的既存事实（都与本文的裁定直接相关）

**(1) `proposalType` **没有**封闭集、没有登记表、没有失败关闭的开关。**
它是 `string`（`src/kernel/contracts/proposal.ts:129`/`:177`，原样拷贝 `:268`），
受控值散落成各域常量与内联字面量；真正**失败关闭**的那一层判的是**目标事件类型**
（`src/kernel/policies/validator.ts:165-171`/`:269`）。已有负控证明**这个标签被忽略**：
`scripts/m8-wp3-verify.ts:767-788`（`proposalType:'affect-touch'` + 目标事件 `MEMORY_CREATED` ⇒ 以事件类型拒收）。

⇒ **后果（必须写进 R-4 的边界）**：新增 `'story-choice'` **不会**让任何测试变红（不存在断言该集合的测试），
也**没有**任何门能验证它"真的是受控值"。所以 **R-4 的锁不能主张"提案类型受控"**——
能主张的只有"**入口跑了、账本真的多了行、水位真的前进了**"。
（要不要**顺手**建一个 proposalType 中央登记表？那是**另一条**工作：它立刻要回答
`'m11-policy-probe'` 这类既有临时值怎么办 ⇒ 会牵动别的里程碑。**不在本轮**，在此**具名登记**。）

**(2) 故事状态**没有**现成的 prompt 载体生产者。**
`src/main.ts` **从不**设置 `input.turn.worldObservations`（全仓 grep：只有 `turn-gateway.ts:497`/`:1919`
与 `scripts/postlv2-world-verify.ts:144`）⇒ 世界观测那条"入模"路径**同样没有生产者**；
而 `D04` 点名的 `ContextBudget.adaptiveSelfTokens` 喂的是**反思槽** `adaptive-self`（优先级 44），
**不是**世界观测槽（`SECTION_PRIORITY.worldObservation = 59`）。

⇒ **后果**：本文的 `R-1b` **不依赖**那条路径 —— 私有决策调用的输入面是**另建的有界输入**
（内容包 frontier 的机器键），**不进**主 prompt，因此**不碰** `evals/fixtures/m3.5/prompt-baseline.txt`。
但这意味着**需要新建一个有界的故事输入渲染器**（现有 `renderStoryVisibleEvents` 渲染的是**输出**正文，
用于 `story-cognition.ts:217` 的反思消费，**不是**"把可选项给模型看"）。
"故事状态怎么入**主** prompt"（`D04` 的额度到底是哪一槽）**本轮不裁、不在实现范围内**，
在此**具名登记**为独立缺口。

**(3) 主 prompt 逐字节基线**只有在**默认 provider 列表**、`composePromptFromPacket` 文本、
`CONTEXT_COMPILER_V2_VERSION` 或 section-id 集合变化时才会红
（`scripts/future-compat-tests.ts:1003-1040`：prompt 文本 + `meta.contextSectionIds` + `compilerVersion` + seed 哈希）。
走 `extraProviders` 的 `compileTurn` 注入点**不会**让它红 —— 因为夹具
（`scripts/m3.5-prompt-baseline.ts:133-146`）**从不**传 `extraProviders`，且该脚本**不读任何 flag**。
⇒ `R-1b`（私有调用）与 `R-3b`（消费点）**在结构上都无法**触碰那份基线；这是本 ADR 敢选 `R-1b` 的**依据**，
不是"我猜它不会红"。

---

## 3. 与本文**无关**的事（免得范围蔓延）

- 本文**不改** `ADR-094` / `ADR-093` / `ADR-091` 的任何冻结文字。
- 本文**不改**三个消费者的实现（它们已接线、已有读数）。
- 本文**不**主张"激活"：`D09` 的逐项前置、真实库迁移、`D08` 读回、`FIRST-USE` 登记都是**独立**步骤。
- 本文**不**把行为达标（`S8-A43` 仍 `NOT RUN`、`S8-A38` = 0.7675 已裁定残差）当成实现完成的证据。
- **§2.5(1)(2) 登记的两处缺口不在本轮**：`proposalType` 中央登记表 · 故事状态入**主** prompt 的额度归属。

---

## 4. 实施顺序（**已由裁定确定**；审计 §5 的次序约束在此落地）

```text
① R-2a′ → 显式 `story:start` 入口（走**既有**开局路径 `commitStoryTurn({action:{kind:'start'}})`，
           零 DDL；把"活跃 run"读成"该故事恰好一个非终局 run"）
② R-1b  → "候选 choiceId"的产出面：独立私有决策调用 + 闭集校验 + **新建有界故事输入渲染器**
           （frontier 机器键，不进主 prompt）+ "无活跃 run 一次都不调"的机器判据
③ R-3b  → 消费点：每轮扫 + `open()` 补扫，并把 `L-S8-30` §C2 的口径不一致**在文档里具名**
④ R-4c  → 新锁：端到端行为锁（**唯一**主张来源）+ 三段式（正控/负控/恢复）+ 文本锁降级为"装配在场"
⑤ 出证据：新门读数 · `m4.5:ci` · `m3.5:test`（证明主 prompt 基线**未动**）
⑥ 才谈激活（独立裁定）
```

⚠️ **与草案的一处次序调整（如实记录）**：草案把 `R-1` 排在 `R-2` 之前。
但 `R-1b` 的调用必须被"**有没有活跃 run**"闸住，而"活跃 run"要先有**显式开始**才存在
⇒ **`R-2a′` 是 `R-1b` 的前置**。这里按依赖顺序把 `R-2a′` 提到第一位；**裁定内容不变**。

---

## 5. 本文**不**主张什么

- **不**主张 `L-S8-30` 已关闭：它要等"真实入口→commit→三消费者→状态/行为链 + 入口缺席负控"全部落地并出读数。
- **不**主张上面四个推荐已被接受：它们是**草案**。
- **不**主张 `D09` 的其余项已满足，也**不**主张可以激活。
- **不**主张"新增一次私有模型调用"已获授权：若选 R-1b，那是**新的模型批次**，须按既有授权规则单独办。

---

## 6. 实施记录（**只追加**，逐项出读数）

### 6.1 ① `R-2a′` 显式 `story:start` —— **已实现并已有门读数**（2026-10-05）

| 项 | 落地物 |
|---|---|
| 纯解析（失败关闭） | `src/kernel/app/storyline/admin.ts`：`parseStoryStartArgs` / `STORY_START_USAGE` / `storyStartIdempotencyKey` / `STORY_START_IDEMPOTENCY_KEY_PREFIX` |
| 生命周期（活跃 run 从账本算） | `src/kernel/app/storyline/run-lifecycle.ts`：`storyRunStatusesOf` / `activeStoryRunOf` / `startStoryRun` / `STORY_START_BINDING` |
| DB 侧命令体 | `src/infrastructure/runtime/story-start-command.ts`（解析 → **显式告警** → 走既有开局路径 → **从账本回读**） |
| CLI 接线 | `src/invocation.ts`（`--story-start`，含对 `READ_ONLY_FLAGS` **名字语义**的再次点明）· `src/main.ts` 派发 · `package.json` 的 `story:start` |
| 门 | `scripts/postlv2-s8-start-verify.ts`（`pnpm postlv2:s8:start:verify`）· 登记进 `PL2_GATES`（lane `postlv2`，第 11 道）· 接进 affected 路由 |
| 用户文档 | `docs/苏沐薇-使用说明.txt` 增 `pnpm story:start` 一条 + `pnpm doc:sync` + `pnpm doc:check` |

**读数**：`pnpm postlv2:s8:start:verify` = **PASS（`measured_count = 15`，10 条检查全绿）· EXIT 0**；
经调度器真跑 `--lane postlv2 --only postlv2:s8:start:verify` = **PASS 3.7s**；`pnpm gates:verify` **51/51**；
`pnpm typecheck` **0**；`pnpm m4:test` **259/0**；`pnpm m4.5:test` **146/0**；`pnpm doc:check` **0**。

门的分列读数（三段式；**主张只挂在账本读数上**）：

```text
S1 正控    真实命令体开局 ⇒ exit 0 · 账本**恰好一行** STORY_STARTED @1 ·
           绑定逐字 system（actorKind/interactionKind=system · 无 interactionRef · 无 anchor）· 无 choiceId
S2 幂等    同一 runId 重复 start ⇒ exit 0 · 账本**不新增**（1 行）
S2b 键形状 开局键 `story-start:<runId>` **不**与选择键 `story-commit:<runId>:r<rev>:<anchor>` 同族
S3 负控    已有活跃 run 时 start 另一个 ⇒ exit 1 · 账本**一行都不多**（零副作用）
S4 负控    五类非法入参各给具名 code + exit 2（未知选项 / 缺 runId / 含空白 / 多参数 / 超长）· 零副作用
S5 恢复    把活跃 run 走到终局（RUN_EXITED）⇒ 同一个 start **又能成功**
S6 装配在场 main.ts 派发 + invocation.ts 分类 + package.json 脚本（**文本锁，明确不作为主张**）
S7/S8      非零分母（measured_count=15）· 隔离（`PROJECT_LG_SANDBOX` 在 · `PROJECT_LG_ALLOW_PRODUCTION_DB` **未设**）
```

### 6.2 两处**裁定没有覆盖、由代码/先例定死**的子决定（如实登记，**不**当作新设计）

```text
① 绑定必须是 `system`（**不是我在两可之间挑的**）：
   `STORY_STARTED` **不在** `STORY_USER_CHOICE_EVENT_TYPES`
   （`src/kernel/storyline/story-ledger.ts:147-151`：只有 CHOICE_COMMITTED / ENDING_REACHED / RUN_EXITED）
   ⇒ 声明 `user_choice` 会被 `assertStoryCommitBinding` 当场抛错（`:167-175`）。
   语义上也正确：`INV-CI-03`「维护不得冒充经历」—— **开局不是一次用户选择**。
   因此**不**伪造 `interactionRef` / `anchorConversationEventId`（`system` 分支明令禁止，`:198-207`）。
② 没有 `--confirm` 二次确认：`R-2a` 的裁定是"抄 `R-4` 的 `story:withdraw` 形状"，
   而 `story:withdraw`（一个**移除**认知资格的写操作）就没有二次确认。
   ⇒ 沿用先例，**不**由我单方面发明新流程。⚠️ 但这一条**值得复核**：
   `cognitive-integrity` §2 的链条含 "Explicit Warning" —— 本实现用**打印显式告警**满足它；
   若将来要求"必须逐字确认"，那是一次独立裁定。
```

### 6.3 尚未做（`L-S8-30` **仍未关闭**）

```text
② R-1b  候选 choiceId 的产出面（私有决策调用 + 闭集校验 + 有界故事输入渲染器）**未做**
③ R-3b  消费点（每轮扫 + open() 补扫）**未做** —— 现状仍只在 open() 补扫一次
④ R-4c  端到端"入口缺席负控"（三段式）**未做** —— 本门的 S6 是文本锁，**不作主张**
⑤      `m4.5:ci` / `m3.5:test`（证明主 prompt 基线未动）**未跑**
⑥      激活（独立裁定）**未做**
```

⇒ **`L-S8-30` 保持 `OPEN`**：入口侧的**第一条提交**已经有人写（本步），
但"入口→commit→三消费者→状态/行为链 + 入口缺席负控"这条完整链**还差三步**。

### 6.4 ② `R-1b` 候选 `choiceId` 的产出面 —— **确定性核心已实现并已出门读数**（2026-10-05）

**落地物（全部离线可判定）**：

| 层 | 文件 | 它负责 |
|---|---|---|
| 草稿契约 | `src/kernel/contracts/story-choice-draft.ts` | `story-choice-draft@1` 形状 + **闭集**判定（`recognizeStoryChoiceDraft`）+ `STORY_CHOICE_PROPOSAL_TYPE` |
| 有界输入 | `src/kernel/app/storyline/choice-input.ts` | 候选数 / 候选键长 / 剧情正文 / 本轮原话 / 最近行 **各自有上界**，超界**具名截断**；渲染给模型的那条消息 |
| 端口与读数 | `src/kernel/app/storyline/choice-decision.ts` | 端口只发一次、**不判定形状**；超时 / 调用失败 / 形状坏 ⇒ **三个具名桶**，**不重试不回落** |
| 编排 | `src/kernel/app/storyline/choice-turn.ts` | 开关 → **活跃 run** → 候选 → 一次调用 → 闭集 → **既有入口** `ingestStoryChoice` |
| 门 | `scripts/postlv2-s8-choice-verify.ts` | `pnpm postlv2:s8:choice:verify` |

**读数**：`pnpm postlv2:s8:choice:verify` = **PASS（`measured_count = 21`）· EXIT 0**；
经调度器真跑 **PASS 3.6s**；`pnpm typecheck` **0**；`pnpm gates:verify` **51/51**。

```text
G1  正控    合法闭集提案 ⇒ committed；账本读回 CHOICE_COMMITTED，
            choiceId 逐字相符，绑定是**服务端**给的（user_choice + 会话 + anchor + actor=user）
G2  负控    开关关闭 ⇒ disabled，私有端口**一次都没被调用**、账本零变化
G3  负控    **没有活跃 run** ⇒ no_active_run 且**端口零调用**（`Q3` 的省钱硬闸，**在任何 run 存在之前**量的）
G4-G11 负控 ×8  闭集外 / 多字段 / 版本不符 / 非对象 / 超时 / 调用失败 / 模型说 null / 端口缺失
            ⇒ 各自具名，且**账本一行都不多**
G12 恢复    回到合法提案 ⇒ **又能提交**（证明 G4–G11 的拒是注入条件造成的）
G13 无候选  把 run 走到 `choices: []` 的节点（**6 步真走**，停在 s4_result）⇒ no_candidates · 端口零调用 · 账本零变化
G14 纯函数  没有候选 ⇒ `ok:false`；超上界**如实截断并具名**；闭集外一审就拒；消息里是**截断后**的原话
G15        非零分母 + 隔离（`PROJECT_LG_ALLOW_PRODUCTION_DB` 未设）
```

⚠️ **本步暴露的一个真实风险，已登记为 `L-S8-31`**（**不**声称已解决）：

```text
`D02.2④` 冻结的绑定是 `user_choice`，而 `ADR-093 D01` 说它是"**唯一**能成为习惯根的形态"。
`R-1b` 让**模型**产出候选机器键 —— 模型**不是**在替用户选（它是在**解析**用户已用自然语言做出的选择），
但它**会解析错**：用户没做选择、或做了别的选择时，模型给一个闭集内的键 ⇒
那条提交会**冒充一次真实用户选择**，并按 `D01` 获得"可成为习惯根"的资格。
本步的缓解只有：**闭集**（`choice-input`）+ **世界判定**（`advanceFromProposal`）+ **锚定本轮用户消息**
+ 失败**具名**。**没有任何一条能证明"用户真的选了它"** —— 那是措辞/语义层的判断，
而本仓库在措辞层**刻意没有**启发式守卫（`DR-11` 的既有立场）。
⇒ `L-S8-31` 见登记册；**本步不据此主张任何行为正确性**。
```

> ⚠️ **一处如实披露**：本门在**开发过程中**先跑出过一份 FAIL（`postlv2-s8-choice-20261005164530-ec3e3e2f`，
> 8 条检查 7 通过），原因是**门的断言我写错了一条**（把"消息里出现某个汉字"当作上界判据，
> 而那句指令文本里本来就有那个字），**不是**被测实现的问题。修正后第二份是 **8/8 PASS**。
> 前一份是**同一会话内几分钟前自造的开发期草稿**，对应的门代码已改，**不对应任何当前代码状态**，因此**已删除**；
> 保留的是 `postlv2-s8-choice-20261005164738-ec3e3e2f`。

### 6.6 ②余 **生产接线**（真实 provider + flag + `main.ts` 调用点）—— **已实现并已出门读数**（2026-10-05）

| 项 | 落地物 |
|---|---|
| 真实 provider | `src/infrastructure/model/openai-story-choice.ts`（**恰好一次** POST；`temperature:0` + `response_format:json_object`；`AbortController` 硬期限；**失败分桶**：网络/HTTP/无 key ⇒ **抛**（内核映射 `call_failed`/`timeout`），"不是 JSON" ⇒ 返回原文（内核判 `invalid_output`）） |
| flag | `src/kernel/app/flags.ts`：`storyChoiceDecisionEnabled`（**代码缺省 false**）+ `storyChoiceDecisionTimeoutMs`（有界，缺省 8000，1s–25s） |
| 生产调用点 | `src/main.ts`：`beginTurn` 之后、编译与回复之前（`D02.3` 的位置）；`interactionRef` = `cli:<userId>`；`recentLines` = `decisionLines`；`narrativeOf` = 内容资产渲染器 |
| 缺省锁 + 装配在场锁 | `scripts/kernel-tests-memory.ts`：**缺省 off** + 期限 8000 **必须**成立；并要求 `main.ts` 同时出现开关名与 `runStoryChoiceTurn(`（**文本锁**，**不作为行为主张**，`R-4c`） |

**读数**：`pnpm typecheck` **0** · `pnpm postlv2:s8:choice:verify` **PASS（`measured_count = 21`）· EXIT 0** ·
`pnpm m4:test` **261/0**（比上一步 +1：新锁）· `pnpm m4.5:test` **146/0**。

⚠️ **两处必须点名的实现选择**（裁定没覆盖，由既有先例/形态定死，如实登记）：

```text
① `recentLines` 复用 `decisionLines`，**不**自己再读一遍最近对话。
   理由：那份本来就是"给决策的、**不进 prompt**、不进账本、不进 trace 属性"的有界读
   （`turn-gateway.ts:1297-1302`）⇒ 复用它在**结构上**保证主 prompt 基线碰不到
   （`ADR-107` §2.5(3)）。自己再读一遍反而会引入"两份最近对话"的漂移风险。
② `interactionRef = cli:<userId>`：单用户 CLI 只有**一条**对话流，这是诚实的会话引用。
   ⚠️ **边界**：换 HTTP / QQ 等多会话入口时，**那一层**必须给真实会话 id ——
   用 `cli:<userId>` 冒充会让"两个真实会话"在账本里看不出区别（`D01` 要的是真值）。
   本步**不**假装支持多会话。
```

⚠️ **一个只有真实模型才能回答的问题，本步**不**回答**：开关打开后，
"她会不会把用户没做的选择解析出来" —— 那是 `L-S8-31`，需要**真实模型批次**（按既有授权规则单独办）。
本轮**没有**新增任何真实模型批次，也**没有**打开生产 `.env`。

### 6.7 ⚠️ **`m3.5:test` 的边界锁抓到了一次真实的架构退化**（2026-10-05，如实记录）

第一版接线**没过** `pnpm m3.5:test`：`FC-T04`（"世界/故事实现只允许住在具名模块边界内"，
`ADR-091 §2`，`scripts/future-compat-tests.ts`）报了 `src/main.ts` 的三条未登记故事依赖。
判据原文给出的允许范围是 "`src/kernel/storyline` / `src/infrastructure/storyline` /
`src/kernel/app/storyline`；**白名单之外只允许逐边登记的生产依赖**"。

**两条路摆在面前**，我选了后者：

```text
① 把三条边登记进白名单（"逐边登记"是判据明确允许的做法）—— **便宜**，
   而且能立刻变绿。但那条负控**专门**拿
   `src/main.ts` + `story-ledger-store.ts` 的合成 import 当反例
   ⇒ 登记它等于把"main.ts 不得直接碰故事账本 SQL 适配器"这条**设计意图**抹掉。
② 改**设计**：让 `main.ts` 只多调**一个方法**（`story-cognition.ts` 的
   `resolveChoiceTurn`），账本、内容包、渲染器都留在那个**已登记的边界模块**里。
   ⇒ `main.ts` 的故事依赖名单**一个字都不用改**。
```

⇒ 采用 ②。代价与收获：

```text
· `story-cognition.ts` 多一个方法 `resolveChoiceTurn`（账本/内容包/渲染器都在它的闭包里）
· `main.ts` 只多一个字段（`this.storyCognition`）与一句调用 —— **不**自建账本端口
· `openai-story-choice.ts` 的**端口契约**移到 `src/kernel/contracts/story-choice-draft.ts`
  （与每一个同类适配器一致：`openai-tool-decision` / `openai-agreement-understanding` /
   `openai-goal-understanding` 都从 `kernel/contracts|action` 取自己的契约）——
   这样适配器**不必**触碰故事边界，也就**不必**新增一条 infra/model 白名单边
· `scripts/kernel-tests-memory.ts` 里我那条**消费锁**随之改判据：
  从 `runStoryChoiceTurn(` 改成 `.resolveChoiceTurn(` —— **性质不变**（开关必须有消费者），
  并且**新加一条**：边界模块里必须真的有 `resolveChoiceTurn`（否则可以"调用一个不存在的方法"冒充接线）
```

⚠️ **这一条值得单独记下来的理由**：那次失败**不是**"门太严"，而是**门抓到了实现把故事逻辑
放错了位置**。如果我当时把三条边登记进白名单，门会变绿而边界会**悄悄变宽** ——
那正是这类锁要防的事。**判据赢了一次。**

### 6.8 ③ `R-3b` 每轮消费点 + ④ `R-4c` 入口锁 —— **已实现并已出门读数**（2026-10-05）

**③ `R-3b`（消费点）**：`src/main.ts` 新增 `drainStoryTail()`（轮尾 fire-and-forget，同型重入保护），
在 `drainAgreementTail()` 之后调用。⇒ 消费点从"**只在 `open()` 一次**"变成
"`open()` 补扫 + **每轮尾扫**"，与 `D03` 的"提交后由既有调度器消费"对齐
（`L-S8-30` §C2 登记的口径不一致由此**具名消除**）。

⚠️ **为什么在轮尾而不在提交之后立刻消费**（`Q8` 的落定）：`reflectionStep` 的消费**会真发模型请求**
（provider 是必填注入）⇒ 压在回复之前就是把一次模型调用塞进用户等待。放在轮尾，水位机制保证
"至多一次、失败停住不跳过"，代价只是**晚一轮**出现状态变化 —— 可接受的降级。

**④ `R-4c`（入口锁）**：新门 `scripts/postlv2-s8-entry-lock-verify.ts`
（`pnpm postlv2:s8:entry-lock:verify`，登记进 **`postlv2-controls`** lane —— 即 `Q11` 点名的那条）。
它把 `L-S8-30` §C1.2 的"假绿"正面堵上：**判据是行为的**。

```text
L2 负控（**入口缺席**，先做）：同一套装配上**只**跑消费、**从不**调入口
   ⇒ 账本里 CHOICE_COMMITTED **一条都没有** · 端口调用 **0**
   （此时装配是**好的** —— 紧接着的 L1 就产出了 ⇒ "没有"只可能是**没调入口**造成的）
L1 正控：调用入口 ⇒ 账本出现 CHOICE_COMMITTED（choice_id 逐字相符、绑定服务端给、锚定本轮用户消息）
   ⇒ 再跑消费 ⇒ **三个消费者水位都推进**（affect→2 · relationship→2 · reflection→2）
L3 恢复：把入口放回去再调 ⇒ **又**出现一条
L4 降级：`main.ts` 的**文本锁**读数**列出来但 `claimBasis` 里没有它**（`claims` 只有 L1/L2/L3）
L5 非零分母 + 隔离
```

**读数**：`pnpm postlv2:s8:entry-lock:verify` = **PASS（`measured_count = 6`，5 条检查全绿）· EXIT 0**；
经调度器真跑 **PASS 3.6s**；`gates:verify` **51/51**；`m3.5:test` **30/0**；`m4:test` **261/0**；`m4.5:test` **146/0**；`typecheck` **0**。

⚠️ **本门的边界**（写在证据的 `notCovered` 里）：
```text
· **不**回答"生产里是否真的有人调入口" —— 它回答的是"**被调用时留得下、不被调用时留不下**"；
  生产调用点是否在跑，由 `main.ts` 的装配在场锁 + 真实轮次回答（`FIRST-USE` 另记）
· **不**驱动 `main.ts` 的轮尾（本门手动调 `consumeOnce()`）⇒ `R-3b` 的**调度行为**只有文本锁 +
  它的机制面（`postlv2:s8:production:verify` 的 N6/N7/N9）
· **不**回答真实模型的解析质量（`L-S8-31`）
```

### 6.9 ⑥ **两处"值得复核"项的复核结论**（2026-10-05，用户"同意复核"后执行）

#### 复核项 ①：`story:start` 原先**没有**显式授权 ⇒ **已改**（加 `--yes`）

**原状态**：沿用 `story:withdraw` 的"无二次确认"先例（`R-2a` 的裁定是"抄 `R-4` 的形状"）。

**复核结论：必须有显式授权**，理由是一条**方向性**的区别 —— 而这条区别在立案时没被写出来：

```text
`story:withdraw`（有先例、无确认）—— 它是**移除**认知使用资格的方向（保守：少用一点）
`story:start`                     —— 它是**新增**认知摄入面的方向：
                                     开局之后，用户的选择才会经三个消费者变成情绪/关系/反思状态
```
⇒ `cognitive-integrity` §2 的"**不得默认开放、不得静默执行**"与 §18 `CI-4`
（"认知干预必须 explicit / warned / authorized / audited / verifiable"）针对的正是**后者**。
"抄 `withdraw` 的形状"**不能**一路抄到"也不要求授权"。

**落地**：`STORY_START_CONFIRM_FLAG = '--yes'`（`admin.ts`）·
解析器新增具名拒收 `story_start_confirmation_missing`（**零写入**）·
顺序是"**形状**先判、**授权**最后判"（这样"没给 runId"与"没给授权"两条互不掩盖，各有具名码）·
使用说明已按 `AGENTS §5` 记账 + `doc:sync` / `doc:check` 均 0 ·
门加了对应的负控（`S4` 现为 **6 类**非法入参，读数 `measured_count` 15 → **16**）。
⚠️ 同型先例：`pnpm desktop-control:act --i-am-here`（需人在场的显式授权）。

#### 复核项 ②：`interactionRef = cli:<userId>` ⇒ **收进具名函数 + 断言形状**，边界**登记**

**复核结论**：单用户 CLI 只有一条对话流 ⇒ 这个值是**诚实**的；真正的风险是**将来多会话入口照抄它**
（`ADR-093 D01` 要的是"**真实**会话 id —— 没有它就无法回答'这是不是两个真实会话'"）。

**落地**：抽成 `cliStoryInteractionRef(userId)`（`run-lifecycle.ts`，名字里带 `cli` 让复用一眼可见）·
**在故事边界模块内部**拼（`main.ts` 不许 import 故事边界 —— `FC-T04`）·
入口锁的 `L1` 现在**断言** `binding.interactionRef === \`cli:<userId>\``（照抄会留下可见痕迹）·
边界写进函数注释。

⚠️ **复核也如实说清它没解决什么**：现在**没有**机器判据能挡住"多会话入口偷偷复用它" ——
因为多会话入口**还不存在**，没有可判的对象。⇒ 这是一条**触发式**复核项。

### 6.11 ⑦ **`L-S8-31` 的方案 A 已实施**（2026-10-05，用户"尝试解决"后执行）

**方案 A 落地**：模型给的草稿里 **`quote` 是必填**（给了 `choiceId` 就必须给），
程序做**机械包含检查**（`quote` 必须是**本轮用户原话**的子串）。

| 层 | 落地物 |
|---|---|
| 契约 | `story-choice-draft.ts`：形状加 `quote`；新增解析码 `quote_not_a_string_or_null` / `quote_empty` / `quote_not_in_user_turn`；上界 `STORY_CHOICE_MAX_QUOTE_CODEPOINTS = 200`；`recognizeStoryChoiceDraft` 新增必填参数 `userText` |
| 判定链 | `choice-decision.ts` 透传 `userText`；`choice-turn.ts` 传 `built.input.currentInput`（**触发本轮的用户原话**） |
| 给模型的指令 | `choice-input.ts` 增第四条硬约束（"指不出用户自己的字就必须弃权"）+ 输出形状加 `quote` |
| 门 | 选择解析门的负控从 **8 → 11**（`G16` 没给引用 · `G17` 引用不在原话里 · `G18` 空引用），读数 `measured_count` **21**；入口锁门夹具同步（仍 **6**） |

**读数**：`pnpm postlv2:s8:choice:verify` = **PASS（`measured_count = 21`）· EXIT 0** ·
`pnpm postlv2:s8:entry-lock:verify` = **PASS（`measured_count = 6`）· EXIT 0** ·
`pnpm kernel:test` **27/0**（`contracts/` 改动的必跑门）· `pnpm typecheck` **0**。

⚠️ **`L-S8-31` 保持 `OPEN`，理由逐字写在契约字段的注释里**：
```text
买到：模型必须**指认用户自己的字符**；指不出来就得弃权。
      它挡掉的是"**脱离用户原话**去选"那一类失败（最常见的那一种：它觉得用户"应该"选某个）。
买不到：引用得**对不对** —— 模型照样可以引用一段**无关**的原话。
⇒ 本字段是**结构性**缓解，**不是**语义判据（`DR-11`：措辞层刻意没有启发式守卫）。
```

⚠️ **方案 B 仍是待裁定项**（让"被解读出来的"与"用户直接表达的"在账本里可区分，并让
"能否成为习惯根"只看后者）：它可能触碰 `D02.2④` **冻结**的绑定形状与 DDL ⇒ 属"改动冻结面"，
需要一次独立裁定 + 迁移审查。**本轮不做。**

⚠️ **验证**（不是实现）这套缓解的效果仍需要**真实模型批次**（按既有授权规则单独办）；本轮**没有**新增。

### 6.12 ⑧ `L-S8-31` 方案 A 的**真模型 A/B 对照** ⇒ **NO MEASURABLE EFFECT**（2026-10-05，用户授权真实批次）

**授权**：用户「我先授权你用真模型验证 A 的效果」。批次经 `pnpm with-test-model` 包装：
端点 `ark.cn-beijing.volces.com` · 模型 `deepseek-v4.1-flash` · 凭证存在（不打印）· **无生产 key 回落**
（缺包装器标记即 exit 2，已实测）。

**量具**：`pnpm postlv2:s8:quote:ab:live`（`scripts/postlv2-s8-quote-ab-live.ts`）·
语料 `evals/post-lv2/s8-choice-quote/cases.json`（冻结；10 个 `no_choice` + 6 个 `choice`）·
**两臂同一批输入**，只有 prompt 与解析规则不同（臂 1 = 变更前 `82e14d10` 的规则，逐字复刻；
臂 2 = 生产规则）· **判据先注册**：`PASS` ⟺ 分母非零 且 假阳(臂2) < 假阳(臂1) 且 真阳(臂2) ≥ 真阳(臂1)。

**读数（96 次真实调用；16 案 × 3 轮 × 2 臂）**：

```text
臂 1（变更前）  假阳 0/30 · 真阳 18/18 · 拒收码 {}
臂 2（方案 A）  假阳 0/30 · 真阳 18/18 · 拒收码 {}
判定：**NO MEASURABLE EFFECT**（臂 1 的假阳**本来就是 0** ⇒ 天花板，判据无法成立）
```

**这份读数说明什么（逐条，不外推）**：
```text
① 在这批语料与这个模型上，"**脱离用户原话去选**"那一类失败**没有出现**（两臂各 30 个 no_choice 样本，全 0）。
② 臂 2 的**拒收分解是空的** ⇒ 模型对新增的必填字段 `quote` **每次都照做了**（18/18 给出了在原话里的引用）
   ⇒ 方案 A 在这里**没有代价**（真阳一个没掉、也没有因为指不出来而被拒）。
③ ⇒ 方案 A **既没有被否定，也没有被证明有收益**：它买到的东西在这批样本上**没有可测的边际**。
```
⚠️ **不主张**（与 `L-S8-31` 的边界一致）：**不**主张"模型不会误解读" —— 本批语料的 6 个 `choice` 案
都是**明确**表达（"先问清楚范围吧" ⇒ `ask_scope`），**没有**探到"用户说了 A、模型报 B"那一类。
要探它需要一批**更难**的语料（含糊表达 / 近义键 / 听起来像选择但不是选择的句子）——
那是**下一步**，不是本条的结论。也不主张长期稳定性（16 案 × 3 轮是小样本，先例 `L-RTD-23`：比率不能当硬阈值）；
读数是**验收端点**的（生产端点 ≠ 验收端点，先例 `L-M85-14`）。
⇒ **`L-S8-31` 保持 `OPEN`**，并**新增一条**下一步：**换更难的选择歧义语料重测**。


### 6.10 ⑦ **尝试解决 `L-S8-31`：方案已定**（2026-10-05；**方案 A 已在 §6.11 实施**）

`L-S8-31` = 模型**误解读**把"用户没做的选择"提交成 `user_choice` ⇒ 按 `ADR-093 D01`
那会**冒充一次真实用户选择**（而 `user_choice` 是"唯一能成为习惯根的形态"）。

**本节是当时的方案定稿；A 的实施与读数见 §6.11。** 方案与它为什么需要一次裁定：

```text
方案 A（可做、不碰冻结面、不碰 DDL）：要求模型**同时给出用户原话里的逐字引用**
  在 `story-choice-draft` 里加一个必填 `quote`，程序做**机械包含检查**
  （`quote` 必须**是** `currentInput` 的子串）。
  ⇒ 与 `goal-proposal` 的 `span` / `spanFingerprint` 同一条纪律；
  ⇒ 它是**结构性**的，**不**是语义判据 ⇒ 不违反 `DR-11`（"措辞层没有启发式守卫"）。
  ⚠️ 但它**只**减少"模型脱离用户原话去选"那一类失败：模型照样可以引用一段**无关**原文。
     它买到的是"必须指认用户自己的字符"，**不是**"指认得对"。

方案 B（更强，但要裁定）：让"**被解读出来的**选择"与"**用户直接表达的**选择"
  在账本里**可区分**（例如多一个来源标记），并让"能否成为习惯根"只看后者。
  ⚠️ 这可能触碰 `D02.2④` **冻结**的绑定形状（`interaction_kind='user_choice'`）与 DDL
     ⇒ 属"改动冻结面"，需要一次独立裁定 + 迁移审查。**本轮不做。**

⇒ **采取的次序**：A 先做（下一轮），B 作为**待裁定项**交给用户；
   `L-S8-31` 在 A 落地后仍**保持 OPEN**（因为 A 的边界如上）。
```

⚠️ 另需注意：**验证**（不是实现）`L-S8-31` 的缓解效果需要**真实模型批次** —— 按既有授权规则单独办。
本轮**没有**新增任何模型批次。


```text
②-余  真实 provider（`src/infrastructure/model/openai-story-choice.ts`）· flag
      （`CHARACTER_STORY_CHOICE_DECISION_ENABLED`，代码缺省 **false**）与缺省锁 ·
      `src/main.ts` 的生产接线（每轮调用点，位于 `beginTurn` 之后、回复之前，`D02.3`）
③ R-3b  消费点（每轮扫 + open() 补扫）**未做**
④ R-4c  端到端"入口缺席负控"（三段式）**未做**
⑤      `m4.5:ci` / `m3.5:test`（证明主 prompt 基线**未动**）**未跑**
⑥      激活（独立裁定）· 真实模型解析质量（`L-S8-31`）
```
