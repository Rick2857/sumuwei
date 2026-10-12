# 后 Lv2 故事世界来源契约（Story World & Source Contract）

状态：**ACCEPTED / DESIGN FROZEN**。日期：2026-10-03。载体 ADR：[ADR-091](../adr/ADR-091-post-lv2-world-boundary-and-story-source.md)（§2/§3）。
计划：[Post-Lv2-Storyline-Embodiment-Realtime-Plan-2026-10-02.md](../research/Post-Lv2-Storyline-Embodiment-Realtime-Plan-2026-10-02.md) §5。
范围：**S1 / Lv2.5 有限世界线**。本契约只冻结**判据**，不产生读数。

首个故事（S1 修订）：**《一起去参加极创工作室的二面》**（简称"极创二面"）。

---

## 0. 怎么用这份契约

1. 每条判据（`S1`…`S12`）都有**具名门**与之对应（见 §4）。
2. 量具自身先跑**正控 / 负控 / 恢复**三段式，并要求 `measured_count > 0`（AGENTS.md §6.7/6.8）。
3. 看到结果之后**不得**改金标、分母或阈值凑绿。
4. 失败如实保留：`FAIL` / `INVALID` / `NOT RUN` 三者**分列**，零分母一律 `INVALID`。

### 0.1 当前分项读数（**2026-10-03 R2；不许合成一个总分**）

| 判据 | 读数 | 说明 |
|---|---|---|
| `S1`–`S6` | **PASS** | `pnpm postlv2:story:verify`（离线，30 条真实路径） |
| `S11` · `S12` | **PASS** | 同上 |
| `S9` | **PASS（契约/数据库层）** | `pnpm postlv2:source:verify`：`STORY_OBSERVATION` ∉ 外部事实白名单 + **隔离库真实 CHECK 约束**接受 `story_fact` 并拒绝未登记值 |
| `S10` | **PASS（契约/适配层）** | 同上：三列自洽、来源四分量读回一致、可见性、幂等；**世界观测 section**（`world-observation`，优先级 59、可裁、`sourceRefs` 带确定性来源 id）有观测时恰好 1 块、无观测时 **0** 块 |
| `S7` 长期记忆正控 | **`PARTIAL`（机制面四跳全通，语义面 `NOT RUN`）** | 见 §0.3b：适配 → 受理 → 召回 → 溯源四跳全部走**真实**链并实测；真模型"普通聊天里说出来"的读数仍需跑 |
| `S8` 状态与习惯链 | **`NOT RUN`** | 同上 |

⚠️ `S9`/`S10` 的 PASS **限于契约与适配层**：它们在真实回复里的端到端形态（能区分"用户陈述 / 故事体验 / 她的解释"）
随 `S7`/`S8` 一起 `NOT RUN`。

### 0.3 结构发现 `PL2-SR-01`：故事来源的**持久根**没有位置（2026-10-03 R6 实测）

`pnpm postlv2:source-root:verify` 量的是一件**具体**的事：以故事观测为**唯一**证据的记忆，
能不能在真实 Memory 放行口上被受理、能不能拿到**根证据资格**。答案是：

| 判据 | 读数 | 说明 |
|---|---|---|
| 真实放行口受理 | **受理**（`episode`，拒绝码 0） | 一条以 `observation` 类证据为唯一来源的 episode 记忆**真的能进库** |
| 根证据读取（正控：`conversation_event` 根） | **1** 条 | 读取口本身是好的 |
| 根证据读取（`observation` 根） | **0** 条 | `rootReadingsByMemory` 的 SQL 写死 `l.evidence_kind = 'conversation_event'` |

**⇒ 结构事实**：`Observation` **不落库**（M3.5 §84 的设计），因此它**不能**作为一个**持久根**被引用；
而根读取口只认 `conversation_event`。两者合起来 ⇒ 以故事观测为根的记忆拿到 **0** 条根读数。

**这个缺口的半径（已量准，不是推测）**：

| 记忆类型 | 资格规则 | 0 根的后果 |
|---|---|---|
| `episode` / `self_experience` | **不适用**（`qualificationAppliesTo` 只认 `person_fact`/`preference`） | **无影响** —— 它们本来就不走资格轴 |
| `person_fact` / `preference` | 适用 | 取 `UNCONFIRMED_ORIGIN`（**失败关闭**）⇒ 排序降档 + prompt 标签"来源未确立" |

⚠️ **这恰好与计划 §5.4 同向**（"模拟经历不能升级成现实事实"），因此本门把它记成
"**当前行为可辩护**，但标签的语义精确性待裁"，**不**记成"必须修的缺陷"。

**未决定（需要单独 ADR，本门只报告）** ⟶ **已裁定：[ADR-092](../adr/ADR-092-pl2-sr-01-story-durable-root-ruling.md)（`ACCEPTED / DECISION RECORDED`）**

| 候选 | 裁定 | 理由（ADR-092） |
|---|---|---|
| 1 新建**持久根类别** | **推迟**（`L-PL2-02`） | 代价被低估：需要新建故事事件表 + 根解析 + **各评估器的输入面**（它们现在只读 `ProcessorView` 的对话事件）+ 迁移与冻结面回归 —— 属**里程碑级**工作 |
| 2 **复用** `conversation_event` | **拒绝** | **结构性不可能且方向错误**：`createConversationEvent → buildProvenance → assertSourceConsistency` 的输入域是 `ActorType`，`story_fact` 不在其中 ⇒ 实际做法只能是**把故事事件伪装成用户/系统消息**，正是 `INV-PL2-02` 要阻止的（机器判据：门 `R10`，`source_kind_actor_mismatch`） |
| 3 **接受现状 + 把边界钉成判据** | **采纳**（`D01`–`D04`） | 缺口半径只有 `person_fact`/`preference` 的**标签精确性**，且失败关闭方向与计划 §5.4 一致；`episode` 面**四跳全通** |

**ADR-092 `D04` 要求的实现动作**（已落地）：`world-observation.ts` 的
`canWriteStoryFactAsConversationEvent(): false` 与 `storySourceAxes()`，
由门的 `R10`/`R11` 断言 —— 于是"以后有人打开伪装通道"会**当场**红，而不是静默推翻裁定。

**由本裁定登记的残余**：`L-PL2-01`（故事来源在资格轴上与"来源破损"不可区分）·
`L-PL2-02`（候选 1 的四项前置未做）· `L-PL2-03`（`storyline_events` 表不存在 ⇒
世界事实**没有**自己的持久账本，权威只在运行期状态与快照里）。

⚠️ 在任何一条被裁定之前，`S7` 的"故事经历经**正式 Memory 链**形成长期记忆"只在
**episode 面**成立（已实测受理），`person_fact`/`preference` 面**不成立**。

### 0.3b `S7` 的**机制面闭环**（R7 实测，四跳全部走真实链）

上面那条缺口只覆盖 `person_fact`/`preference`。**episode 面**的四跳**全部**已经实测：

| 跳 | 判据 | 读数 | 载体 |
|---|---|---|---|
| ① 适配 | 已提交且可见的故事事件 → 观测（确定性来源 id） | R1：观测 1 条、id 唯一、两次适配逐字节相同 | `worldObservationsOf` |
| ② 受理 | 以该观测为**唯一**证据的 episode 提案过**真实**放行口 | R6：**受理**，拒绝码 0 | `createMemoryMutationValidator` |
| ③ 召回 | 经**真实** `createMemoryRecallService` + 真实检索店取出来 | R9：候选 2 条，**含**这条故事来源记忆 | `createMemoryRetrievalStore` |
| ④ 溯源 | 候选的 `sourceRefs` 仍带那条确定性来源 id | R9b：`observation:story:jichuang-interview-two@v1#run-root.s1_intro_met` | 同上 |

⇒ **"记得"与"记得这是哪一次体验"两件事都成立**（计划 §5.4 表格最后一列的机器形态）。

⚠️ **仍然 `NOT RUN`**：真模型下"新会话普通聊天里**真的说出来**"的语义读数 ——
机制通不等于措辞自然（`DR-11` 的立场）。

### 0.4 `S10` 的**反伪装**判据

世界观测**不得**伪装成用户消息（计划 §5.3 / `INV-PL2-02`）。机器形态两条：

```text
① createWorldObservationProvider 产出 kind = 'world-observation'（**不是** 'current-input'）
   —— 它与"对方刚刚说"在 prompt 里是两块不同的东西
② deriveCurrentInput(WORLD_OBSERVATION) **仍然抛** observation_not_renderable_as_input
   —— 世界观测在类型与函数上都**不可能**变成"本轮输入"
   反向自证：同一个函数对 CONVERSATION_OBSERVATION 照常返回文本
   （证明这条"拒"不是恒响的噪音源）
```

⚠️ **尚未接线**：`TurnGateway.compileTurn` **还没有**把 host 带来的世界观测挂进
`extraProviders`（provider 与契约已就绪并有门）。这与 WP1 host 未接进 `src/main.ts`
是同一条待办：真正的端到端接线需要一个 host 驱动的入口，属 WP2c/WP3 的交接面。

---

## 1. 世界边界判据

| ID | 判据 | 量具 |
|---|---|---|
| **S1** | 内容包带 `storyId` + 固定 `storyVersion` + 内容摘要；世界范围限于这次极创二面的准备/参加/复盘（约 3 场景、4 阶段、12–18 可达节点）；**不存在未声明的主线出口** | 图遍历 + 内容摘要比对 |
| **S2** | 三个候选结局（共同通过 / 待定或需补考 / 本次未通过）**加上明确退出路径**全部可达；每条路径的用户选择**确实改变**后续阶段或结果 | 全图可达性 + 差分回放 |
| **S3** | 未知 choice / 越界地点 / 穿越指令 / 跳阶段 / 重复投递 / 过期 revision **均不改变故事**；实际提出请求的**那一轮对话**仍按正常轮次记录与反应 | 负控注入 + 状态摘要前后比对 |
| **S4** | 只有用户已确认/提交的选择与程序已提交的事件才算进展；模型不能新增地点/节点/人物/变量/结局，不能以任意 `ChoosePathString` 跳过剧情 | 提案校验 + 拒绝路径用例 |
| **S5** | 重启后：当前节点、有限变量、**角色可见集合**与回放一致；快照重建**不**重发世界观测、不重复写记忆、不重复推动情绪/关系 | 真实子进程重启 + 字段级对账 |
| **S6** | 版本不匹配时**明确拒绝**（不能默默换剧情）；故事重开使用**新 `runId`**，旧经历保留原范围 | 版本错配负控 + runId 对账 |

## 2. 来源与认知判据

| ID | 判据 | 量具 |
|---|---|---|
| **S7** | **长期记忆正控**：一次实际提交、她可感知的共同经历经**正式 Memory 链**提交；新会话/重启且**未加载故事全文**时，在普通聊天中能检索追忆；`Memory ID` 与故事来源读回一致 | 真模型普通聊天 + memory 读面同 ID 对账 |
| **S8** | **状态与习惯链**：真实配合事件能触发合法的情绪/关系更新；有足够**独立**有效反馈的对照场景能完成反思 → 有限行为调整 → 实际入模 → 后续行为测量；**未达采纳门槛要明确拒收** | 各域读面 + 入模集合 + A/B/C 行为评分 |
| **S9** | **来源负控**：未选分支 / 不可见事件 / 作者虚构往事 / 模型续写 **不形成亲历记忆**；模拟结局**不成为**现实录取事实；`canSupportExternalFact('STORY_OBSERVATION') === false` | 负控注入全分母 |
| **S10** | **来源追问可区分**：能区分「用户陈述」/「故事体验」/「她的解释」三者；普通聊天、故事上下文与后续反思中的来源范围一致 | 语义演示 + 来源标签读回 |
| **S11** | **持久性与失效**：终局/退出**不会**自动清除合法记忆与调整；重复投递/回放/断点补送**不重复写入、不重复累计证据**；记忆更正/遗忘/来源撤回按现有语义传播；**回放不把失效依据灌回** | 幂等对账 + 失效传播用例 |
| **S12** | **机制与措辞分列**：机械状态没有越界，与**角色措辞没有编造**分别判定。**不得**用图的有限性证明自然语言永不幻觉 | 两轴分别读数，不合成总分 |

## 3. 冻结的不变量（改动须新 ADR）

```text
INV-PL2-01  storyline_events 只由 Storyline 运行器追加；Character 从不写它
INV-PL2-02  世界/剧情事实永不进入 conversation_events（不得伪装 user_message）
INV-PL2-03  character_domain_events 的 scope 恒为 CHARACTER_INTERNAL（assertCharacterInternalScope 仍在唯一受理点）
INV-PL2-04  STORY_OBSERVATION ∉ EXTERNAL_FACT_AUTHORITIES（失败关闭）
INV-PL2-05  故事经历走既有唯一放行口；Storyline 不直接写任何认知域
INV-PL2-06  快照重建 / 回放 / 补送不产生第二次认知副作用（按来源身份去重）
INV-PL2-07  observedOnly ⊆ committed；可见集合只减不增（不可见事件永不因回放而变成亲历）
```

## 4. 具名门

| 门 | 命令（落地后） | 性质 |
|---|---|---|
| WP0 基线 | `pnpm postlv2:baseline` | 离线，只读 |
| 内容包编译 + 静态核对 | `pnpm postlv2:story:build` | 离线（ink 编译 + 标签 ⟷ 内容包逐条比对） |
| S1 题材门（世界边界） | `pnpm postlv2:story:verify` | 离线（图遍历 + 负控 + 量具三段式） |
| S1 来源门（词汇 / 迁移 / 适配） | `pnpm postlv2:source:verify` | **隔离库**（契约词汇 + 真实 CHECK 约束 + 可见性/幂等） |
| S1 来源根门（故事来源能否成为证据根） | `pnpm postlv2:source-root:verify` | **隔离库 + 真实放行口**（适配器负控 + 受理读数 + 根读取三段式 + 缺口半径） |
| S1 真链门 | `pnpm postlv2:story:live` | **真模型**（生产库**副本** + 隔离）—— **尚未落地** |
| 发布审计 | `pnpm postlv2:gates` | 只读已落盘证据 —— **尚未落地** |

**实现载体**（`S9`/`S10` 的机器形态）：

```text
src/kernel/contracts/source-authority.ts   story_fact / STORY_OBSERVATION / story_experience
                                           + buildStoryProvenance() + assertStorySourceIsNotExternalFact()
src/infrastructure/persistence/migrations.ts  MIGRATION_0011（三个 Axis B 词表换宽，只碰 conversation_events）
src/kernel/contracts/memory.ts             authorityFromSource('STORY_OBSERVATION') = 'DIRECT_INTERACTION'
```

⚠️ **来源适配的当前形态**：`scripts/postlv2-source-verify.ts` 里的 `observationsFromState()`
是**适配逻辑的最小形态**（已提交事件 → 可见集合 → 确定性来源 id）。
它**尚未**接进生产轮次链（那需要 WP1 的入口桥与各域的提案构造），因此
"故事经历形成长期记忆"这条链**还没有**被端到端验证 —— 见上表的 `S7` = `NOT RUN`。

## 5. 证据与隐私

- 运行证据存 `artifacts/post-lv2/<runId>/`：源码/依赖摘要、场景 ID、事件链、`revision`/`generation`、统计分母、**所有失败**。
- 完整对话正文与真人材料只存 `artifacts/post-lv2/local/`（gitignore）。
- 真实库只由**合法入口**持有；Storyline 与语音桥**都不打开 PGlite**。实验一律 `isolateDatabase()` 或用**只读副本**。
- 真实库没有被打开，只能用 **mtime / 内容摘要**证明（`data/**` 被 gitignore，`git diff` 永远为空）。

## 6. 本契约**不**主张什么

- 不主张"任何世界线都不会幻觉"（只主张本内容包的图有界 + 机械拒收）。
- 不主张剧情通过等于现实录取（两者按 `S9`/`S10` 分离）。
- 不主张单次演练形成永久成长（`S8` 明确要求未达门槛即拒收）。
- 不主张 3 场景 / 4 阶段 / 12–18 节点之外的规模；另一故事、三面或另一次招新需要**新的显式内容包与版本**。
