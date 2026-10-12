# ADR-092：`PL2-SR-01` 的裁定 —— 故事来源的**持久根**暂不建设

状态：**ACCEPTED / DECISION RECORDED**。日期：2026-10-03（北京时间）。裁定 ID：`POSTLV2-SR-01-20261003-01`。
上位载体：[ADR-091](ADR-091-post-lv2-world-boundary-and-story-source.md)（世界边界与故事来源）·
[故事世界来源契约](../post-lv2/Post-Lv2-Story-World-Source-Contract.md) §0.3。
证据：[`artifacts/post-lv2/postlv2-source-root-20261003071739-bd57c287/source-root-verify.json`](../../artifacts/post-lv2/postlv2-source-root-20261003071739-bd57c287/source-root-verify.json)（`pnpm postlv2:source-root:verify`，PASS 23）。

---

## 0. 要裁的是什么

`PL2-SR-01` 是**实测出来的结构事实**，不是推测：

```text
· 以故事观测为唯一证据的 episode：真实放行口**受理**（拒绝码 0）
· 同一批证据的**根读数**：0 条（正控 conversation_event 根 = 1 条）
  ⇒ 原因是 rootReadingsByMemory 的 SQL 写死 evidence_kind = 'conversation_event'
```

契约 §0.3 列了三条候选修法。本 ADR 裁定选哪一条，并写下**为什么**。

## 1. 裁定：**接受现状 + 把边界钉成机器判据**（候选 3）

**不**新建持久根类别，**不**复用 `conversation_event`，**不**改 `EvidenceKind` 受控词汇。
理由如下，每条都是可核对的。

### D01 · 候选 2（复用 `conversation_event`）**在架构上被排除**

这是最关键的一条，也是本轮**实测确认**的：

```text
createConversationEvent() → buildProvenance() → assertSourceConsistency()
  assertSourceConsistency 的输入域是 ActorType（user / character / system / tool）
  story_fact **不在** actor 派生的四个 SourceKind 里
  ⇒ "对话事件带 sourceKind = 'story_fact'" 在**类型与运行期都不可能**
```

因此"让故事事件也写一条对话侧的行"这条路，实际做法只能是**把故事事件伪装成用户或系统消息**
—— 而那正是 `observation.ts` 开头逐字点名要阻止的污染链，也是 `INV-PL2-02` 的正文。
**拒绝**它不是偏好，是这条不可能性。

### D02 · 缺口半径已经量准，代价远小于收益

| 记忆类型 | 资格规则 | 0 根的后果 |
|---|---|---|
| `episode` / `self_experience` | **不适用**（`qualificationAppliesTo` 只认 `person_fact`/`preference`） | **无影响** —— 它们本来就不走资格轴 |
| `person_fact` / `preference` | 适用 | 取 `UNCONFIRMED_ORIGIN`（**失败关闭**）⇒ 排序降档 + prompt 标签"来源未确立" |

⇒ 真正受影响的只有 `person_fact`/`preference` 的**标签精确性**（"故事来源"与"来源破损"
在排序上都降档，但**理由**不同）。而 `episode` 面 —— 也就是"共同经历"的主战场 —— **四跳全通**：

```text
适配（R1）→ 真实放行口受理（R6）→ 真实召回取得到（R9）→ 来源随召回一起出来（R9b）
```

### D03 · 候选 1（新持久根类别）的真实代价被低估了

它**不是**"加一个 `EvidenceKind` 值"这么小。要让故事经历真的到达
Memory / Affect / Relationship / Reflection 的评估器，需要：

```text
① 一张**持久的故事事件表**（`storyline_events`）—— 当前**不存在**（实测：迁移里没有任何 storyline 表）
② 根解析器认识新 kind（`rootReadingsByMemory` 目前只认 conversation_event）
③ 各评估器的输入面从 `ProcessorEventView`（**对话**事件视图）扩到一个新的故事事件视图
④ 新迁移 + 冻结面回归（`EvidenceKind` 属受控词汇）
```

其中 ③ 是**没有**既有实现的：那四个评估器读的都是对话事件。
⇒ 这是一件**新的里程碑级**工作，不是一个补丁。为一个**标签精确性**问题付这个代价，
在本工程的时间盒内是错的取舍（计划 §10.1：范围不足时**收窄**，不是悄悄扩面）。

### D04 · 边界钉成机器判据（本裁定**要求**的唯一实现动作）

"暂不建设"必须**不等于**"以后可以顺手打开伪装通道"。因此新增：

```text
src/kernel/storyline/world-observation.ts
  canWriteStoryFactAsConversationEvent(): false        ← 结构性不可能的可调用形态
  storySourceAxes()                                    ← 三根轴各归各位的读面
```

`pnpm postlv2:source-root:verify` 的 `R10`/`R11` 断言它们，并断言聊天事件构造器
**真的**会拒绝 `story_fact` 声明（负控：不是靠"没人这么写"）。

## 2. 这个裁定**不**主张什么

- **不**主张故事经历无法影响认知。它**能**：episode 记忆四跳全通（D02），
  且她在剧情中的真实交谈走的是既有全部链路。
- **不**主张 `UNCONFIRMED_ORIGIN` 是对故事来源的**最佳**标签。它只是**可辩护**
  （失败关闭、与计划 §5.4 同向）；标签精确性是**已知未满足项**。
- **不**主张候选 1 永远不做。它被**推迟**，并附上 D03 的四项前置。
- **不**关闭 `S7`：`S7` 的 `PARTIAL` 状态不变（机制面全通 / 语义面 `NOT RUN`）。

## 3. 残余（进登记册）

| ID | 内容 |
|---|---|
| `L-PL2-01` | `person_fact`/`preference` 的故事来源在资格轴上与"来源破损"**不可区分**（都降档，理由不同） |
| `L-PL2-02` | 候选 1 的四项前置（见 D03）**未做**；做之前故事经历到不了 Affect/Relationship/Reflection 的评估器 |
| `L-PL2-03` | `storyline_events` 表**不存在** ⇒ 世界事实现在**没有**自己的持久账本（权威只在运行期状态与快照里） |
