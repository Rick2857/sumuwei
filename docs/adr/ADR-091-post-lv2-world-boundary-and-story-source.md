# ADR-091：后 Lv2 世界线边界与故事来源进入认知

状态：**ACCEPTED / DESIGN FROZEN**。日期：2026-10-03（北京时间）。裁定 ID：`POSTLV2-WP0-20261003-01`。
能力影响：**新增受控世界/媒体能力，运行能力 `NONE`**（不新增任何外部应用权限、不新增模型出站、不自动启用任何开关）。
前置：`Lv2 = PASS（已知风险接受放行）`（[ADR-090](./ADR-090-lv2-risk-acceptance-release.md)）；放行后待办见
[`docs/lv2/Lv2-Deferred-After-Release-2026-10-03.md`](../lv2/Lv2-Deferred-After-Release-2026-10-03.md)。
计划权威源：[后 Lv2 首版工程计划](../research/Post-Lv2-Storyline-Embodiment-Realtime-Plan-2026-10-02.md)（含 §0 的 2026-10-03 S1 修订）。

本 ADR 是 WP0 的**设计冻结载体**。它冻结边界与契约，**不宣布任何实现已完成**；实现与读数在各 WP 的具名门里分别产生。

---

## 0. 为什么需要这份 ADR（要解决的真实风险）

计划 §2 已列明四条必须继承的边界，其中两条在本 ADR 之前**没有落地载体**：

1. [`future-compatibility.md`](../architecture/future-compatibility.md) §4/§9 规定 `CharacterDomainEvent` **永远只描述角色内部变化**，
   且 `src/` 内**不得出现** `WorldStateRepository` / `SceneService` / `NPCService` / `SimulationScheduler`；
   `scripts/future-compat-tests.ts` 的 FC-T04 把这条写成了**阶段静态锁**（扫 `src/**` 的符号黑名单）。
   计划 §2 明确要求：**真正建设世界线前，要用新 ADR 将这一阶段锁演进为明确的模块边界测试，
   继续保留 Character 不写世界事实的负控；不得删锁、改名字绕锁或关闭整道门。**
2. 计划 §5.4 / §10 要求「已提交故事事件 → 有来源的可见观测 → 既有记忆与认知域提案」这条链**可追溯且不降门槛**，
   但现有 `SourceKind` 只有四个值（`user_statement` / `character_output` / `system_instruction` / `tool_output`），
   **没有**"这是故事/模拟里发生过的事"这一类别。缺了它，剧情经历只能被塞进 `user_statement`（伪装成用户自述）
   或 `tool_output`（伪装成工具观测）—— 两者都正是 `observation.ts` 开头那段注释点名要阻止的污染链。

因此本 ADR 冻结两件事：**世界边界**（§1、§2）与**故事来源**（§3）。

---

## 1. 权威分层：谁写什么，谁读什么

```text
Storyline（有限故事运行器）      权威：故事世界边界、节点、有限变量、已发生的剧情事件
        │  只写自己的 append-only 事件流，只落"故事事实"
        ▼
World Observation（世界观测）   权威：她**感知到了什么**（可见集合），不是"世界是什么"
        │  经受控 context section 呈现；不得伪装 user_message
        ▼
Character Kernel（苏沐薇）       权威：她对这段经历的**认知**（记忆 / 情绪 / 关系 / 信念 / 目标 / 反思）
```

| 层 | 可以写 | **不得**写 |
|---|---|---|
| Storyline 运行器 | 自己的 `storyline_events`、当前节点、有限变量、快照 | `conversation_events`、`character_domain_events`、Seed、情绪/关系/信念数值 |
| World Observation 适配器 | 由已提交故事事件派生的、**可见**观测 | 未选分支、作者后台设定、她未见到的事件、模型临时续写 |
| Character Kernel | 自己的各域事件（沿既有唯一放行口） | 世界真相、故事节点、变量 |

这与 [`future-world-boundary.md`](../architecture/future-world-boundary.md) 一致：**世界事实与角色认知必须能分别存在**
（FC-06）。"剧情里通过了"与"现实中录取了"在本架构里是两条数据，物理上无法互相升级（见 §3.3）。

---

## 2. FC-T04 阶段锁的演进（**不删锁**，改成模块边界）

### D01 · 阶段锁改判据，不改职责

`scripts/future-compat-tests.ts` 的 FC-T04 静态锁由「`src/` 里不得存在世界实现」演进为两条**同时成立**的判据：

```text
① 世界实现**允许存在**，但只能住在被具名的模块边界内（各自有且仅有一处）：
     src/kernel/storyline/**          —— 纯故事状态机（契约 + 纯函数；不 import 基础设施）
     src/infrastructure/storyline/**  —— inkjs 适配与落库
     src/infrastructure/storyline/store/** —— storyline_events / 快照的仓储
② 负控**不变且更严**：世界/剧情事实**永远不能**出现在
     conversation_events（不得伪装 user_message）
     character_domain_events（scope 恒为 CHARACTER_INTERNAL，assertCharacterInternalScope 仍在唯一受理点）
   且「Character 写世界事实」的最短路径必须**在类型与运行期都不存在**。
```

**被退役的只是"世界不存在"这条阶段断言**（它已完成使命：它保证的是"插座先于世界"，现在世界是真的要建了）。
**没有被退役的**：scope 校验、符号黑名单里与"伪装通道"有关的部分
（`observations` 表、`character_intents` 表、把世界事实写进角色历史的路径）、以及全部负控用例。

### D02 · 退役必须留证

阶段锁的退役是**显式白名单**，不是把黑名单删掉：新判据必须能回答"哪些符号被允许、在哪个目录、为什么"。
任何**未被登记**的新世界/场景/调度器符号仍应让 `pnpm m3.5:test` 失败。
⇒ 本条落地时 `m3.5:test` 的**通过数不得下降**，负控用例数只增不减。

### D03 · 不允许"绕锁"的三种形状

明确禁止（出现即视为违反本 ADR）：

1. 把世界实现改名放进 `src/kernel/` 的其它目录以避开目录白名单；
2. 让 Character 侧直接 `import` 世界存储以"顺手读一下世界状态"（读也必须经 Observation）；
3. 把世界事件塞进 `conversation_events` 并给它一个 `actorType='system'` 来"看起来合法"。

### 2.1 2026-10-04 修订：S8 生产资产与装配的依赖登记

本节承接 [ADR-093](ADR-093-s8-story-state-and-habit-bridge.md) `R-3` 的故事应用服务，
以及 [ADR-094](ADR-094-s8-story-cognition-production-activation.md) `R-1.2` / `R-2` / `R-3` / `R-4`
已批准的生产装配、内容包、可见事件渲染和撤回入口。用户本轮要求「尝试解决这一问题」，
授权同步其对应的 `FC-T04` 判据；原 `D01`–`D03` 与历史失败证据保留。

**发现**：生产资产与装配依赖已经落地，但 `FC-T04` 仍把白名单之外的任何
`from '…storyline/…'` 都当成世界存储访问，连 `import type` 与内容包加载也被拒绝。
2026-10-04 修复前实测 `m3.5:test` = **29/1**，命中五份源码。

世界实现目录仍限定为 `src/kernel/storyline/**`、`src/infrastructure/storyline/**`、
`src/kernel/app/storyline/**`（后者是 ADR-093 `R-3` 的应用服务，原测试已登记）。
下表只授权**源文件 → 目标模块**的依赖，不赋予源文件或其目录世界实现资格。

所有路径相对于 `src/`：

| 源文件 | 允许的目标模块 | 职责 / 限制 |
|---|---|---|
| `content/storyline/jichuang-interview-two/story-pack.ts` | `kernel/storyline/story-types.ts` | 生产内容包只引用类型 |
| `content/storyline/jichuang-interview-two/render.ts` | `kernel/storyline/story-types.ts` | 可见条目渲染只引用类型 |
| `infrastructure/runtime/story-cognition.ts` | `kernel/storyline/story-types.ts`；`kernel/app/storyline/state-evaluators.ts`、`consumer-loop.ts`、`choice-ingest.ts`；`infrastructure/storyline/store/story-ledger-store.ts`、`story-watermark-store.ts`；`content/storyline/jichuang-interview-two/render.ts` | 装配既有提案、放行口、账本端口与消费回路；`story-types.ts` 仍只许类型引用 |
| `infrastructure/runtime/story-withdraw-command.ts` | `kernel/app/storyline/admin.ts`；`infrastructure/storyline/store/story-ledger-store.ts` | 受控撤回入口的参数校验与来源存在性检查 |
| `main.ts` | `content/storyline/jichuang-interview-two/story-pack.ts` | 加载版本化生产内容资产 |

判据使用 TypeScript 语法树和规范化后的模块路径，区分普通导入、类型导入、再导出与动态导入。
白名单外只放行上表的**静态 import**；未知源文件、未知目标、再导出、动态导入和仅副作用导入均拒绝。
`import type` 与 `import { type … }` 都属于类型引用，普通值导入不能冒充类型引用。

`D03` 继续有效：Character 域仍不得直接访问世界存储；世界事实不得伪装成对话或角色内部事实。
符号黑名单和伪装表拒绝规则仍扫描上表的五份文件，未将整个 `runtime` / `content` 目录加入白名单。
量具用五份真实源码逐一执行「合法输入 → 注入未登记依赖 → 恢复」，每份必须实际测到依赖；
另覆盖角色侧访问、内容包越界、值导入冒充类型、再导出、动态导入、副作用导入、路径归一化、
世界实现符号与伪装表的拒绝。读数与回归证据见
[S8 模块边界修复报告](../post-lv2/S8-Module-Boundary-Repair-2026-10-04.md)。

---

## 3. 故事来源进入认知（**追加**契约，不降门槛）

### D04 · 新增受控来源类别（两个新词，成对出现）

**状态：`EXECUTED`（2026-10-03，`MIGRATION_0011` + `pnpm postlv2:source:verify` PASS）。**

在既有受控词汇表上**追加**（不改既有值、不改既有推导函数的行为）：

| 轴 | 新增值 | 含义 |
|---|---|---|
| `SourceKind` | `story_fact` | 这条内容来自**已提交的故事事件**（模拟/剧情世界），不是用户自述、不是工具观测 |
| `SourceAuthority` | `STORY_OBSERVATION` | 有资格支持"**她在这次故事体验里经历过这件事**"这一类结论 |
| `EpistemicSource` | `story_experience` | 认知类别：故事体验 |

三条硬约束：

1. `STORY_OBSERVATION` **不在** `EXTERNAL_FACT_AUTHORITIES` 白名单里
   ⇒ `canSupportExternalFact('STORY_OBSERVATION') === false`（失败关闭）。
   **"模拟中通过二面"永远不能升级成"用户现实中已被极创录取"。**
   （机器判据：`assertStorySourceIsNotExternalFact()`，门 `V2`/`V8`。）
2. `epistemicSourceForKind` / `defaultAuthorityForKind` 对 `story_fact` 返回上表的值，
   **不写进** `SOURCE_KIND_BY_EVENT_FAMILY`（那是**对话事件族**的分类，故事事件不是对话事件族）。
3. 新增值**只许追加**：`SOURCE_KINDS` / `EPISTEMIC_SOURCES` 的既有成员顺序与语义不变，
   `sourceKindForActor` 的签名与行为不变（它仍只接 `ActorType`；故事来源**不是**一种 actor）。
   机器形态：`ACTOR_DERIVED_SOURCE_KINDS` + `isActorDerivedSourceKind()`，门 `V3`。

**落库形态（实施记录）**：`MIGRATION_0011`（`post-lv2-story-source-vocab`）把
`conversation_events` 上**三个** Axis B 词表 CHECK **换宽**（`drop constraint if exists` +
`add constraint`）。⚠️ 三条实施事实：

- **只碰 `conversation_events`**：`character_domain_events` 与 `character_action_events`
  **没有** Axis B 三列（实测 —— 给不存在的表加约束会直接失败），因此只在能承载故事来源的
  那张表上换宽。
- **宽度是单调的**：只添加值，永不删（append-only 的表不允许"事后反悔"）。
- **0007 一个字都没改**：它是已发布的历史 DDL，由 `m5.1.1:migration:verify` 的
  `FROZEN_MIGRATION_FINGERPRINTS` 锁着；扩充只能往前追加。

**`authorityFromSource('STORY_OBSERVATION')` = `DIRECT_INTERACTION`（实施决定，非新增权威）**：
故事事件同样是"在**已提交事件流**里真的发生过一次"，与既有 `DIRECT_INTERACTION` 同档；
而 `DIRECT_INTERACTION` **不在**外部事实白名单里，所以这条映射不会为模拟结果开任何后门。
"现实 vs 模拟"的分辨**不**由 MemoryAuthority 承担，而由来源身份的四个分量与
`experienceScope` 在 provenance 上表达（契约 `S10`）。**不新增 `MemoryAuthority`**（仍 6 个）。

### D05 · 模拟经历 → 长期记忆：沿既有放行口，不新开写口

```text
已提交故事事件（storyline_events，含 storyId/version/runId/eventId）
  → 可见性过滤（只有她**实际感知到**的集合）
  → WORLD_OBSERVATION（source.kind = 'story'；sourceEventIds = 故事事件 id）
  → 记忆提案（EvidenceRef 指向该观测/域事件）
  → **原域**资格与放行口（Memory / Affect / Relationship / Belief / Goal / Commitment / Reflection）
  → 域事件提交 → 投影
  → 后续检索、反思与入模
```

**不新增放行口**：故事经历走的是**同一条**既有唯一放行口，门槛、夹紧、失效、去重规则一律不变。
Storyline **不得**直接写任何认知域。

### D06 · 来源身份的最小记录

每条由故事经历派生的记忆/认知记录，必须可读回并保持：

```text
storyId · storyVersion · runId · storyline eventId（≥1，可多个）
来源类别（story_fact / STORY_OBSERVATION / story_experience）
体验范围（她是亲历者还是旁观者？这一条是**用户陈述**还是**模拟经历**？）
```

`storyId`/`version`/`runId` 进 `EvidenceRef` 的既有来源引用位（不新增表、不新增列到 `conversation_events`）。
**普通聊天、故事上下文与后续反思中的来源范围必须一致。**

### D07 · 模拟与现实结果分离（负控的判据本体）

| 输入 | 允许形成的结论 | **禁止**形成的结论 |
|---|---|---|
| 用户明确告知"我报名了极创、过了一面" | reported 事实记忆（`USER_EXPLICIT`） | 官方核验结论 |
| 剧情里"共同通过二面" | 故事体验记忆（`STORY_OBSERVATION`，`story_experience`） | 用户现实中已被录取 |
| 用户后续明确报告现实结果 | 按用户陈述来源保存 | 由剧情结局推断 |

**来源追问必须能区分**：用户陈述 / 故事体验 / 她的解释。三者混源即判失败。

### D08 · 回放与失效的语义（Append-only 纪律）

1. 快照重建**不**重发世界观测、**不**重复写记忆、**不**重复推动情绪/关系。
2. 崩溃后补送只处理**尚未成功消费**的事件；各域按来源身份去重（`storyline eventId` 即身份）。
3. 记忆更正/遗忘、来源撤回按现有语义传播到召回与认知读面；
   **不得**因 Storyline 回放把已失效的依据重新灌回。
4. 故事重开使用**新 runId**；旧经历保留原范围，不被改写。

### D09 · 不可见即无经历

**只有**用户已确认/提交的选择与**程序已提交**的故事事件才构成进展。
文本里一句"门已经开了"不改变门的状态。未选分支、作者虚构往事、她未见到的事件、
模型临时续写 **一律不形成亲历记忆**，也不产生任何认知副作用。
用户实际提出越界请求的**那一轮对话**仍按正常轮次记录和反应（记录的是请求，不是被请求的虚构进展）。

---

## 4. 媒体来源、交付与取消（S2/S3/S4 的边界）

### D10 · 三类权威分离

```text
LG 生成/检查后的文本   —— 权威：LG 回复守卫后的 replyId / segmentId
TTS 音频              —— 权威：**服务侧**的合成完成记录（不是"播过了"）
实际播放              —— 权威：**客户端上报**的播放确认（delivery evidence）
```

"生成完成"、"已提交"、"已排队"、"已播放"、"已取消"、"未知"是**六个不同状态**，
不得互相代替。`LG 已生成` ≠ `已播出`；`播放确认` 是"客户端报告已播放"的证据，
**不能证明真人确实听懂**；断线时状态为 `unknown`。

### D11 · 先检查，再播出

**先完成一次 LG 回复检查，再对检查后的文本分句合成。** 字幕正文与 TTS 正文取**同一个检查后版本**，
引用同一个 `replyId`。第一版**不**先播未检查 token 再在字幕里修正。

### D12 · 取消不撤销事实

取消的目标是**停止过期工作与表达**，不撤销已经提交的用户消息、记忆或外部副作用。
已开始且不能取消的外部动作仍按原 `actionId` 记录，**不重新执行、不注入新话题**。
一个会话的**正式写入轮次继续串行**；"听/准备/播放重叠"**不等于**两个正式轮次同时写同一库。

### D13 · 未播出的内容不能被说成"我刚才已经告诉过你"

后续语音上下文**据可确认的已播放部分**构造。重连默认**不自动重播**已提交或未知状态的句子
（以免重复承诺）。生成/提交/送达三本账分别保存，**不删除、不重写**已提交历史。

---

## 5. 阈值与判据冻结（WP0 之后不得"看到结果再改"）

计划 §7.1 / §8.7 已给出候选阈值，本 ADR 冻结为**测量口径**（未测或未达标分别报 `NOT RUN` / `FAIL`）：

| 指标 | 判据 |
|---|---|
| 输入后首个可感知反馈 | 浏览器提交 → 实际渲染"已接收/正在处理"或播放起点；**每个受测请求 ≤ 10 秒**，报 max 与全部超标案例 |
| 有意义语音延迟 | 用户语音最终提交 → 第一段实质答复实际播放；记录 p50/p95/max，首版争取普通短轮 p95 ≤ 5 秒 |
| 本地确认有效停止后停播 | ≤ 250 ms |
| 服务取消 / 旧包失效 | p95 ≤ 500 ms |
| 明确快速信号首反馈 | p95 ≤ 500 ms |
| 正式语音样本 | ≥ 60 次：40 普通 + 10 检索/任务 + 10 冷启动/故障；**过滤失败样本后再算"漂亮延迟"不算有效量具** |
| 并发交互 | 六组各 ≥ 5 次，另测误触发 / 否定引用 / 回声 / 断线 / 重复包 |
| 身体 | ≥ 6 类任务状态、4 类情绪表现；故障/中断不继续播放旧嘴型；换皮套后角色 ID / Seed 指纹 / 故事 revision 不变 |

**声音/转录的隐私边界**：声音与完整转录只留在 `artifacts/post-lv2/local/`（gitignore），
trace/公共证据只存必要引用与测量，**不新增隐藏推理日志**。

---

## 6. 本 ADR **不**主张什么

- 不宣布任何 WP 已实现、已通过或已交付；DP0 的读数在各 WP 的具名门里产生。
- 不宣布生产激活：世界线内容接纳、真实库迁移、皮套/语音资源对外分发各按既有独立载体办理。
- 不承诺按期（`10/06 23:59`）完成；那是原计划的条件性估算，剩余工时按实测重估。
- 不新增任何外部应用能力（代码执行 / GitHub / 微信 / QQ / 邮件 / 日历 / 桌面控制 / 自主后台任务仍暂缓）。
- 不改写 Lv2 的旧判定，不销账 M9 / M11.1 的残余。
- 不主张"自然语言永不幻觉"：图的有限性**不能**证明措辞层不会编造。

---

## 7. 相关载体

| 文档 | 回答什么 |
|---|---|
| [`docs/post-lv2/Post-Lv2-Execution-Plan.md`](../post-lv2/Post-Lv2-Execution-Plan.md) | WP0–WP6 的执行计划、具名门与逐轮进度 |
| [`docs/post-lv2/Post-Lv2-WP0-Baseline.md`](../post-lv2/Post-Lv2-WP0-Baseline.md) | 基线读数与依赖探针 |
| [`docs/post-lv2/Post-Lv2-Dependency-and-License-Freeze.md`](../post-lv2/Post-Lv2-Dependency-and-License-Freeze.md) | 版本/commit 固定与许可证分别登记 |
| [`docs/post-lv2/Post-Lv2-Story-World-Source-Contract.md`](../post-lv2/Post-Lv2-Story-World-Source-Contract.md) | §3 的可验收判据（S1…S12） |
| [`docs/post-lv2/Post-Lv2-Media-Delivery-Contract.md`](../post-lv2/Post-Lv2-Media-Delivery-Contract.md) | §4/§5 的可验收判据（M1…M12） |
| [`future-compatibility.md`](../architecture/future-compatibility.md) | FC-01…FC-07 原始契约（本 ADR 追加而非改写） |
| [`cognitive-integrity.md`](../architecture/cognitive-integrity.md) | 任何能改变长期认知的功能都要经审查（本 ADR 即该审查的载体） |
