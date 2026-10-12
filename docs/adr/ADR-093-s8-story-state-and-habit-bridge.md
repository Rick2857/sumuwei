# ADR-093：S8 —— 故事经历进入状态与习惯的接线（Story Experience → State & Habit Bridge）

状态：**ACCEPTED / DESIGN FROZEN**（2026-10-03 用户批准；见 §10 冻结记录）。
日期：2026-10-03（北京时间）。工作包：`POSTLV2-S8`。
上位载体：

- 计划书 [`S8-State-and-Habit-Execution-Plan.md`](../post-lv2/S8-State-and-Habit-Execution-Plan.md)（§3 是要冻结的契约面，§4 是工作包）
- 调研 [`S8-Story-Experience-Cognition-Solutions-2026-10-03.md`](../research/S8-Story-Experience-Cognition-Solutions-2026-10-03.md)
- 基线 [`S8-WP0-Baseline.md`](../post-lv2/S8-WP0-Baseline.md)（门 `pnpm postlv2:s8:baseline`）

> ⚠️ **状态纪律**（计划书 §0 逐字）：用户同意的是**总体方案**，
> **不能**据此写成"详细设计已经冻结"。因此本 ADR 在用户逐条批准之前保持 `PROPOSED`。
> **2026-10-03 用户已批准原样冻结** ⇒ 状态改为 `ACCEPTED / DESIGN FROZEN`（§10）。
> `D01`–`D16` 的**决定**自此不许静默改动；后续修订一律进 §10 的修订记录。

---

## 0. 这份 ADR 要解决什么

`PL2-SR-01`（[ADR-092](ADR-092-pl2-sr-01-story-durable-root-ruling.md)）实测到的结构事实是：

```text
以故事观测为唯一证据的 episode：真实放行口受理，但**根读数恒 0**
  ⇒ 故事经历到不了 Affect / Relationship / Reflection 的评估器
  ⇒ 更谈不上"有限习惯采纳"与"实际入模"
```

ADR-092 把候选 1（新持久根类别）**推迟**并写下四项前置；S8 就是**按那四项前置重建**。
本 ADR 是承接载体（计划书 §1.1 逐字要求"须由**新 ADR**承接；旧裁定及旧失败档保留"）。

**旧读数不回写**：ADR-092、`postlv2:source-root:verify` 的历史 FAIL/0 根读数、
`L-PL2-01…03` 全部保留原文；S8 只**追加**新读数与新的适用范围。

## 0.1 三条硬不变（本 ADR 的每一节都要能追溯到这里）

```text
① 世界事实**只由**已提交的世界账本产生；模型与运行器只能提案（提案 ≠ 事实）
② 故事来源**永不**取得现实事实资格（canSupportExternalFact('STORY_OBSERVATION') = false；
   模拟二面通过 ≠ 现实录取）—— 这条是既有不变量的**继续有效**，不是新主张
③ 模型**不能**声明独立性：rootCount / conversationCount / "这是独立证据" 一律由程序算
```

## 0.2 与 ADR-092 四项前置的逐条对应

| ADR-092 `D03` 的前置 | 本 ADR |
|---|---|
| ① 一张**持久的故事事件表** | `D01`（`storyline_commits` + `storyline_observations`） |
| ② 根解析器认识新 kind | `D02`（`EvidenceKind` 追加 `story_event`）+ `D04`（`LineageHandleKind` 追加 `story_event`） |
| ③ 各评估器的输入面扩到故事事件视图 | `D08`（Affect）/ `D09`（Relationship）/ `D10`（Reflection） |
| ④ 新迁移 + 冻结面回归 | `D14`（版本兼容）+ `D15`（迁移取号纪律）+ 验收契约的回归表 |

## 0.3 对计划书原文的**一处显式读法**（请用户在冻结时确认）

计划书 §3.4 写：「现有 `user_feedback` 名称有定义而无可达检测器，**必须补实际生产路径**」。
本 ADR 的读法是：

- **不**给 `user_feedback` 补**词形**检测器 —— 词形判据会误触发，这条边界已被
  `L-M55-15` 与 M10.1 系列读数登记为**已知未解决**问题，本工作包无权顺手推翻；
- 改为新增第七种触发 **`story_outcome`**（`D10`），它是**合格反馈的确定性生产路径**：
  合格性来自**程序事实**（服务端绑定的真实选择 + 合法世界提交 + 可见性），不来自文本。
- `REFLECTION_TRIGGER_FACTS.user_feedback` 的 `v1Detectable` **保持 `false` 不变**
  （如实登记，不回写成 true）。

⇒ 若用户要的是"让 `user_feedback` 这个**名字**变得可达"，请在这一条上直接推翻本读法。

---

## 1. 世界账本与观测身份（`D01`）

### D01 · 追加两张持久表；**不**新建第三份世界权威

```text
storyline_commits        一次**已提交**的世界变更（提交身份 = 根身份）
storyline_observations   剧情可见条目 → 承载它的那次提交（观测 → 提交映射）
```

**提交身份（确定性）**：

```text
commit_id = story:<storyId>@v<storyVersion>#<runId>.e<revision>
```

`e<revision>` 就是 `StorylineEvent.eventId`（`world-machine.ts` 里 `e${revision}`）⇒
提交身份与既有的来源 id 语法**同一套**，可读、可人肉核对、幂等。

**⚠️ 根粒度 = 提交，不是可见条目**（计划书 §3.1 逐字："一个提交产生多个可见条目，
不能因此变成多个独立根"）。同一次提交里新出现的 `s1_intro_met` / `s1_scope_known` …
**全部**通过 `storyline_observations.parent_commit_id` 归到**同一个** `commit_id`。

**观测身份（沿用既有格式，不改）**：

```text
observation_id = story:<storyId>@v<storyVersion>#<runId>.<eventId>     （eventId 形如 s1_intro_met）
```

`storyline_observations` **只为"已经变得可见"的条目落行**：

- 有行 ⇒ 该条目在**那一次提交**上进入可见集合（`parent_commit_id` = 第一次让它可见的提交）
- 无行 ⇒ 它**从来没可见过**（未选分支 / 隐藏节点 / 作者后台设定）⇒ 读取口**失败关闭**，
  **不是**"查不到就不算"这种软处理

### 服务端保存的可信字段（客户端**不得**自报）

| 字段 | 谁定 | 含义 |
|---|---|---|
| `interaction_kind` | **服务端** | `user_choice`（真实用户提交的选择）/ `system`（开场、确定性结局提交、后台推进） |
| `interaction_ref` | **服务端** | 真实会话 id（`user_choice` 才有值）；来自**当轮运行上下文**，不来自提案 payload |
| `actor_kind` / `actor_id` | **服务端** | 可信参与者（当前真实用户 / system） |
| `content_digest` | 内容包 | 该 run 读的是哪一版剧情 |
| `idempotency_key` | **服务端** | 重试的幂等身份；唯一约束 |

**拒绝**的形状（负控）：客户端自报"我们是合作完成的" / "这条属于某用户" / "这是第二次会话"。

### 持久字段清单（最低集，逐条对应计划书 §3.1）

故事/版本/run · 提交身份与 revision · 事件类型 · 选择与前后节点 · 原有状态折叠数据
（`variables_after` / `stage` / `ending` / `ending_rule`）· 提交时间 · 可见条目及其父提交 ·
可信参与者 · 真实交互归属 · 内容摘要 · 幂等身份。

**原子性**：选择的接受与对应的世界提交**同一事务**落盘（要么都在，要么都不在）。
**Ink 快照**只是派生恢复材料，**永不**替代提交记录。

### 被否决的备选

| 备选 | 为什么否决 |
|---|---|
| 复用 `conversation_events` 承载世界事实 | **结构性不可能**（`assertSourceConsistency` 的输入域是 `ActorType`），实际做法只能是伪装 ⇒ 直接违反 `INV-PL2-02`（ADR-092 `D01` 已钉死） |
| 只建事件表、不建观测→提交映射 | 无法回答"这条可见条目属于哪次提交" ⇒ 一个提交的多个条目会被当成多个根（违反 §3.1） |
| 用 `runId` 当提交身份 | 一次 run 有多次提交；用 run 当身份会让"三个独立根"变成"一个 run"（反向也错） |
| 加一个 `storyline_current_state` 当权威 | 第三份权威；快照可由事件重建（`foldStorylineEvents` 已是纯函数） |

---

## 2. 来源引用面（`D02` / `D03`）

### D02 · `EvidenceKind` **追加** `story_event`（旧四个一字节不改）

```text
旧：conversation_event | observation | domain_event | tool_observation      ← 含义不变
新：+ story_event                                                            ← 追加
```

- `EvidenceRef.id` = 上面的 `observation_id`（可见条目）或 `commit_id`（提交）——
  两者都**可解析**（`parseStorySourceId`），读取口按需再查映射表。
- `EvidenceKind` 是**受控词汇**。⚠️ **实测更正**（2026-10-03，WP2 动工前）：
  `memory_evidence_links.evidence_kind` 是**自由 `text`、没有 check 约束**
  （见 §10 修订 R-1）⇒ 词汇扩展**不需要**迁移，只在契约层追加。
  受控性由 `EVIDENCE_KINDS` 与 `evidenceRef()` 的失败关闭保证（旧行为不变）。
- 旧行、旧 decoder、旧投影**不重写**。

### D03 · 提案与内部事件**追加** `sourceStoryRefs`

```text
DomainProposal / NewProposal：
  sourceConversationEventIds: ConversationEventId[]        ← 语义不变（**只**指对话）
  sourceStoryRefs?: StorySourceRef[]                       ← 追加（可选；旧调用方不填照旧合法）

StorySourceRef = { sourceId, storyId, storyVersion, runId, eventId, experienceScope }
```

- **版本化**：`storyVersion` 进引用；不匹配 ⇒ 拒收（`D14`）。
- `experienceScope` ∈ {`story_experience`, `user_report`}（沿用 `buildStoryProvenance`）。
- 内部领域事件的 payload 追加 `sourceStoryRefs`（**可选、只追加**）；它表达的是
  **内部解释 / 状态变化引用了哪次故事经历**，**不**把世界事实写成对话事实。
- 生产端只有一处能构造它：由**账本读取口**产出（`D04`），不由调用方自由拼。

### 被否决的备选

| 备选 | 为什么否决 |
|---|---|
| 把故事来源塞进 `sourceConversationEventIds` | 强转 ID 类型 + 放宽对话 actor 判据 ⇒ 伪装通道（ADR-092 `D01`） |
| 新开一个 Proposal 类型 | 提案放行口会分叉成两套判据；M11 的采纳纪律要求**同一套** validator |
| 用 `observation`（借位）承载新根 | 根读取口按 `evidence_kind='conversation_event'` 过滤 ⇒ 仍然 0 根（这就是 `PL2-SR-01`） |

---

## 3. 根、独立性与真实会话（`D04`–`D07`）

### D04 · lineage 追加故事根类别

```text
LineageHandleKind  += 'story_event'        （旧四类不变：conversation_event / domain_event / memory / belief）
LineageSourceClass += 'story_experience'   （旧五类不变；追加第六类）
LineageRoot        += 有效性结果字段（见 D12）
```

- `LineageRoot.id` 对故事根就是 `commit_id`（**不是**观测 id）⇒ 天然满足"一次提交一根"。
- 根解析的**遍历上限与循环判据沿用** `LINEAGE_MAX_DEPTH = 16` / `LINEAGE_MAX_NODES = 64`。
- 新拒收理由（追加到闭集）：`story_root_unconfirmed`（无提交记录）、
  `story_root_invisible`（条目从未可见）、`story_root_version_mismatch`、
  `story_root_withdrawn`（认知使用资格已撤回）、`story_root_foreign`（跨用户/跨角色）。

### D05 · 因果去重键（**程序算**）

```text
rootKeyOf(node) =
  · 对话事件根            → 'conversation:' + conversationEventId
  · 故事根（user_choice） → 'conversation:' + anchorConversationEventId   ← 与对话根**同一把键**
  · 故事根（system）      → 'story-system:' + commitId                    ← 是经历，但**不合格**为习惯根
```

**为什么故事的根键落在对话事件上**（2026-10-03 WP2 细化，见 §10.2 `R-4`）：
计划书 `S8-C02` 要求"同一次选择同时有真实对话根和故事根 ⇒ **因果身份合并计数**"。
把故事根的键写成 `commitId` 时，同一次选择的对话事件与故事提交会是**两把**键 ⇒ 直接违反 `S8-C02`。
而 `user_choice` 提交**必然**有一条服务端绑定的真实触发对话事件（`R-2` 的 anchor）
⇒ 用它当因果身份键，`S8-C02` 就是**构造上成立**，而不是靠事后去重。

判据：一次**同一**选择产生的对话记录、故事提交、多个观测、记忆、领域事件与反思，
**必须**收敛到同一个 `rootKey`。做法：

1. 任何派生节点（`domain_event` / `memory` / `belief`）在展开时，把它携带的
   `sourceStoryRefs` **解析成 `commit_id`**，再按上表**替换**该路径的根；
2. 于是"观测 → 记忆 → 领域事件 → 反思"四条路径得到**同一个** `rootKey`；
3. `rootCount` = 去重后的 `rootKey` 数（`rootReadingsByMemory` / `expandLineage` 的既有形状不变）。

**来源 kind 本身不变**：没有故事输入的旧对话链**计数语义逐字保持**（`S8-A18`）。

### D06 · 真实会话映射

```text
sessionKeyOf(commit) = interaction_ref   （仅当 interaction_kind = 'user_choice'）
                      = 无                    （否则）
```

- `conversationCount` = **不同 `interaction_ref` 的个数**，由程序算。
- **两个 `runId` / 两次 replay / 两个节点 / 两份快照 ≠ 两个会话**。
- 纯后台世界推进、作者设定、NPC 评价：**可以**成为情绪经历（`D08`），
  **不能**为关系（`D09`）与习惯（`D11`）制造合格反馈 —— 它们贡献 0 个会话。
- ⇒ 只靠故事经历而没有任何服务端确认的真实交互时，`conversationCount = 0 < 2`，
  **如实拒收**（不是"绕过门槛"）。

### D07 · 冲突定义（**沿用**，不新增）

不新增冲突判据。`unresolvedConflict` 继续由既有程序事实提供
（`reflection-validator` 的 `conflicting_support` / `MEMORY_DISPUTED` / `BELIEF_DISPUTED`）。
S8 只保证：**故事根与对话根在同一个冲突判定里被同等对待**（不许"故事来的证据不参与冲突检查"）。

### 被否决的备选

| 备选 | 为什么否决 |
|---|---|
| 用观测 id 当根 | 一次提交的多个条目会加多票（计划书 §3.1 逐字禁止） |
| 把 `runId` 当会话轴 | 计划书 §3.4/§5 表格逐字禁止（"不把 `runId` 偷换成 `conversationId`"） |
| 让模型自报"这几条互相独立" | `D10` 的既有立场：模型不得编造程序事实（`M11` §0②） |
| 新增一套"故事专用门槛"（例如 2 根 1 会话） | 会造出"故事比对话更容易形成习惯"的通道；门槛**必须**是同一套 |

---

## 4. 状态规则（`D08` / `D09`）

### D08 · Affect 的故事输入（**封闭、版本化、可解释**）

**资格**（全部满足才成立，缺一条 ⇒ 具名拒收、零副作用）：

```text
① 该提交在账本里真实存在（可解析到 commit_id）
② 该条目**可见**（storyline_observations 有行且指向该提交）
③ storyVersion 与内容包**匹配**
④ 事件属于"可评价的故事结果"封闭集合（下表）
```

**首版封闭规则表**（`STORY_APPRAISAL_RULES@1`；纯函数，**不调模型**）：

| 触发（已提交事实） | 条件 | delta（valence, arousal） | 说明 |
|---|---|---|---|
| `ENDING_REACHED(passed_together)` | 且 `interaction_kind='user_choice'` | `(+0.18, +0.12)` | 共同通过 = 正向高唤醒 |
| `ENDING_REACHED(pending_further_review)` | 同上 | `(+0.04, +0.06)` | 待定 = 轻微正向与期待 |
| `ENDING_REACHED(not_passed_this_time)` | 同上 | `(-0.16, +0.10)` | 未通过 = 负向高唤醒 |
| `RUN_EXITED(exited_by_user)` | — | `(-0.02, -0.04)` | 明确退出：轻微回落，**不**等于失败 |
| `CHOICE_COMMITTED` 且该步 `cooperation` 上升 | `user_choice` | `(+0.05, +0.03)` | 合法合作 |
| `CHOICE_COMMITTED` 且该步 `clarity` 上升 | `user_choice` | `(+0.03, +0.02)` | 澄清/核对 |
| 其它已提交事件 | — | `(0, 0)` | **显式 0**，不是"没规则" |

硬边界（**不放宽**）：

- `MAX_AFFECT_DELTA_PER_EVENT = 0.25` 逐字保留；`assertAffectDeltaWithinLimit` 照常生效。
- active-user / cutover 边界、衰减、`[0,1]` 夹紧、单事件上限**全部沿用** `M8` 实现。
- 规则表**有版本号**，进事件 payload（"当时的判定"不可变，先例 `ADR-043 DR-1`）。
- 隐藏条目 / 未选分支 / 作者设定 / 模型虚构事件**进不来**（`D01` 的"无行即不可见"）。

### D09 · Relationship 的故事输入

**资格 = `D08` 的资格 + 额外两条**：

```text
⑤ interaction_kind = 'user_choice'（纯后台推进/NPC 评价**不合格**）
⑥ interaction_ref 绑定的真实用户 = 当前角色所对的**那个**用户（服务端绑定）
```

- 规则表 `STORY_RELATIONSHIP_RULES@1`（封闭、纯函数）：只对 `(trust, closeness)` 产生
  **有限**增量（首版量级 ≤ `0.06`，逐条写在契约里），且**尊重既有单次上限与 `[0,1]` 范围**。
- **剧情中的 NPC 信任不映射为真实用户信任**：NPC 台词、作者预设夸奖、剧情里的"大家很信任你"
  一律**不合格** ⇒ 具名拒收 `story_feedback_not_real_interaction`。
- **不增加旧对话里程碑计数**：故事事件**不得**让 `user_messages_total` / `days_active`
  这类既有计数 +1（这是与"真实用户消息数"的直接隔离）。

### 被否决的备选

| 备选 | 为什么否决 |
|---|---|
| 直接引入 FAtiMA 的 appraisal 引擎当情绪权威 | 会形成**第二份状态权威**（调研 §3.2 逐字警告）；首版无 .NET 依赖 |
| 让模型产出情绪 delta | 违反"模型输出只是待审解释"；且引入不可复现的读数 |
| 放宽 `MAX_AFFECT_DELTA_PER_EVENT` | 计划书 §3.4 逐字"不放宽" |
| 用"剧情里 NPC 信任她"推动用户关系 | 计划书 §3.4 逐字禁止（NPC 信任 ≠ 真实用户信任） |

---

## 5. 触发、采纳与入模（`D10` / `D11`）

### D10 · Reflection 的故事触发

```text
REFLECTION_TRIGGER_KINDS += 'story_outcome'              （追加第七种）
REFLECTION_TRIGGER_BY_EVENT_TYPE：把"已消费的合格故事结果"映射到 story_outcome
REFLECTION_TRIGGER_FACTS.user_feedback.v1Detectable 保持 false（见 §0.3）
```

- 触发是**确定性**的：由账本里**已提交且已被消费**的故事提交产生，
  **不**伪造 `GOAL_COMPLETED` 等领域事件（计划书 §3.4 逐字）。
- 窗口**沿用** `REFLECTION_MAX_WINDOW_INPUTS = 50` 与每条 300 码点；
  超界 ⇒ `windowTruncated = true`（不假装看全）。
- 故事来源条目在窗口里带 `sourceClass = 'story_experience'`，
  正文来自**程序渲染**的可见条目文本（不是模型续写）。

### D11 · 有限采纳与实际入模

```text
门槛：≥ 3 个有效**独立根**（D05 的 rootKey 去重后）· ≥ 2 个**真实会话**（D06）· 未解决冲突 = 0
槽位：只有三个（clarify_when_ambiguous / acknowledge_correction_first / recheck_goal_before_next_step）
范围：只有 current_character_user（ADAPTIVE_SELF_SCOPE）
```

- 采纳走**既有** `AdaptiveSelfState` 流程（revision 递增、失效是**追加**原因，先例 `ADR-085 D11`）。
- `rootCount` / `conversationCount` **由程序填**（事件 payload 的既有校验：`rootCount === roots.length`）。
- 入模记录**裁剪后实际入模**的东西：slot · revision · 有效来源 commit_id · section ·
  实际消耗 token；**不是**候选数量。额度不足 / 采纳未启用 / 来源失效 ⇒ 如实记"未入模"。

### 被否决的备选

| 备选 | 为什么否决 |
|---|---|
| 新增第四个习惯槽 | 计划书 §1.2 逐字排除（"本工作包不增加任意指令、自由文本策略或新的习惯槽"） |
| 把故事经历换成"独立根 +1"的捷径 | 会让三个观测条目凑成三个根 —— `D05` 正是为此 |
| 在正式正控里手填 `accepted` | 计划书 §4/WP5 退出条件逐字禁止 |

---

## 6. 失效、重试与恢复（`D12` / `D13`）

### D12 · 失效传播与读时屏蔽

```text
撤回整段故事体验的认知使用资格
  → 追加一条**内部**领域事件（`STORY_EXPERIENCE_RETRACTED`，带 sourceStoryRefs）
  → 账本**原样保留**（世界历史**不物理删除**）
  → 根解析把该 commit 标为 `withdrawn` ⇒ 由它派生的反思/槽位**失去资格**
  → 读时屏蔽：replay **不能**绕过（读口每次都要查撤回集合，不能只看投影缓存）
```

- 派生路径失效：撤回/更正/遗忘**衍生记忆**同样让依赖它的反思与槽位失去资格
  （沿用 M11 的失效链，故事根只是多一种可失效的来源）。
- **退出剧情 / 换 run 不自动遗忘**合法体验，也**不自动复活**已失效的习惯。
- 新的合法反馈走**新候选**，不复活旧失效记录。

### D13 · 消费一致性（至多一次）

```text
世界提交（世界域） ——→ 角色认知（角色域），跨域消费复用既有任务/提案/提交机制
确定性消费身份 = commit_id + consumer（affect / relationship / reflection）
独立故事水位（每个消费者一条）
```

- **至多一次**：每个合格提交对每个消费者**至多**产生一次已提交影响。
- 世界已落盘、角色未消费 ⇒ 恢复时**补扫**（不漏）。
- 角色提案已提交、水位未推进 ⇒ 恢复时**识别既有结果**（不重复加情绪/关系/习惯）。
- 失败**不**提前推进成功水位；`run/revision` 不匹配、旧任务迟到 ⇒ 提交前**再查一次**并拒收。
- 重建投影**不重新调用模型**、**不生成**新的世界事件。

---

## 7. 开关、预算与版本兼容（`D14` / `D15` / `D16`）

### D14 · 版本兼容

| 面 | 规则 |
|---|---|
| 旧 payload / 旧 decoder / 旧投影 | **不重写**；新字段一律**可选**、只追加 |
| `EvidenceKind` / `LineageHandleKind` / `LineageSourceClass` / `REFLECTION_TRIGGER_KINDS` | 全部**只加不删**（闭集扩宽 = 追加） |
| `storyVersion` | 进来源身份与引用；**不匹配即拒收**（绝不静默换剧情） |
| 内容摘要 | 进提交记录；`content-manifest.json` 与内容包必须逐字一致（`postlv2:story:verify` 继续守） |
| 迁移 | 见 `D15` |
| 历史来源 | 没有可验证提交记录的旧故事引用 ⇒ **`story_root_unconfirmed` 拒收**；**禁止**用快照/当前文本/模型回忆回填 |

### D15 · 迁移取号纪律

- **只许追加**新版本号；**不预占** `0012`（执行时取当时的连续序号，登记在 WP2 交接单）；
- **不改** `0001–0011` 的任何字节（`m5.1.1:migration:verify` 锁着内容指纹）；
- 扩宽既有 check 约束一律 `drop constraint if exists` + `add constraint`（与 `0011` 同形，幂等、只加不删）；
- 新迁移在**空库与副本**上验证；**真实库应用另需用户授权**（计划书 §7 与 WP9）。

### D16 · 开关与预算

```text
新增一个必要的故事认知总开关：CHARACTER_STORY_COGNITION_ENABLED   （代码缺省 **false**）
```

- 它消费**装配动作**：装不装故事账本读取端口、跑不跑故事消费（Affect/Relationship/Reflection
  的故事分支）、渲染不渲染故事相关的入模块。**缺省 false ⇒ 与接线前逐字相同**。
- **不新增**整套可配置策略；`CHARACTER_REFLECTION_*` / `CHARACTER_ADAPTIVE_SELF_*` 的语义、
  默认值与两个独立开关的关系**一律不变**。
- 必须被 `main.ts` **真的消费**（D3 的教训，配静态回归锁）。
- 继承（**不调整**）：`REFLECTION_MAX_WINDOW_INPUTS=50` · 每条 300 码点 · 候选模型输入 ≤ 6000 token ·
  `LINEAGE_MAX_DEPTH=16` / `LINEAGE_MAX_NODES=64` · `MAX_AFFECT_DELTA_PER_EVENT=0.25` ·
  `ContextBudget.adaptiveSelfTokens` 缺省 0（上限 800）· 反思门槛 3 根 / 2 会话。
- 调整任何一条都需要**真实需求 + 单独设计依据**（计划书 §3.4 逐字）。

---

## 8. 本 ADR **不**主张什么

- **不**主张 S8 已实现：本 ADR 是 `PROPOSED`，代码尚未按它落地。
- **不**主张故事经历可以升级成现实事实 —— 恰恰相反，`D02`/`D08` 的每一层都保留体验范围。
- **不**主张 `user_feedback` 的不可达性被解决（§0.3 的读法要用户确认）。
- **不**主张引入任何上游组件：首版新依赖 **NONE**；Concordia/FAtiMA/Ensemble/ExpeL 只作**方法参考**。
- **不**回写任何历史读数（ADR-092 / `postlv2:source-root:verify` / `L-PL2-01…03`）。
- **不**包含生产激活：真实库迁移与配置激活属 WP9 的独立授权。

## 9. 冻结后立即要落地的残余清单（进登记册）

| ID | 内容 |
|---|---|
| `L-S8-01` | 故事结果规则表只覆盖首版七个场景（合法合作 / 真实纠正 / 目标核对 / 拒绝 / 冲突 / 退出 / 其它）；不新增通用规则 DSL |
| `L-S8-02` | `story_outcome` 与 `user_feedback` 的**名字**并存（§0.3 的读法），语义精确性待用户裁定 |
| `L-S8-03` | 关系增量的首版量级是**工程判断**，不是真人标定值 |
| `L-S8-04` | 单用户：`interaction_ref` 目前只有一个真实用户；多人社交图谱不在范围 |
| `L-S8-05` | 语义评测集是**自建**的；未经人审前不得自签为已冻结金标 |
| `L-S8-06` | 退出路径（`RUN_EXITED`）的可见事件：纯状态机不带出 `ending_exited_by_user`，`.ink` 侧带出（`R-6`）；WP3 的可见性判据须明确以哪一侧为准 |

---

## 10. 冻结记录与修订历史

### 10.1 冻结记录

| 项 | 内容 |
|---|---|
| 冻结时间 | 2026-10-03（北京时间） |
| 裁定人 | 用户（本轮对话显式选择"原样冻结，进入 WP2"） |
| 冻结范围 | `D01`–`D16` + §0.3 的读法（`user_feedback` 不补词形检测器，改登记 `story_outcome`） |
| 冻结时的基线 | `S8-WP0-Baseline.md`；门 `pnpm postlv2:s8:baseline` = PASS（`measured_count = 121`） |
| 未随冻结生效的东西 | 生产激活（WP9，独立授权）· 真实库迁移（独立授权）· 任何语义/行为读数 |

### 10.2 修订历史（**冻结后只许追加，不许回写**）

| 编号 | 日期 | 类型 | 内容 |
|---|---|---|---|
| `R-1` | 2026-10-03 | **事实更正** | `D02` 原写「`memory_evidence_links.evidence_kind` 有 check 约束 ⇒ 由新迁移扩宽」。**实测不成立**：该列是自由 `text`、无 check 约束（迁移 0004 的 DDL 逐字如此）。**决定不变**（仍然追加 `story_event`、旧四值语义不变、只加不删）；改的只是"要不要动 DDL"这一条实现路径 —— **不需要**迁移。发现时机：WP2 动工前核对 DDL。 |
| `R-2` | 2026-10-03 | **实现细化**（不改变 `D01` 的决定） | `D01` 的"真实交互归属"在落库时需要**两列**：`interaction_ref`（会话 id）与 `anchor_conversation_event_id`（触发该提交的**真实对话事件 id**，可为空）。理由：`character_domain_events.primary_source_event_id` 是 **NOT NULL**（迁移 0002），而由故事触发的域事件必须有**语义正确**的来源列。首版规则：`user_choice` 提交**必填** anchor；`system` 提交可为空，而**任何非零状态增量都只来自 `user_choice` 提交**（`D08`/`D09` 的规则表已如此限定）⇒ 不存在"没有对话来源却改状态"的路径。 |
| `R-3` | 2026-10-03 | **事实登记**（不改变任何决定） | 生产链路里**没有**故事运行器：`src/kernel/app/storyline/` 在本轮之前不存在，`advanceFromProposal` / `exitStory` / `commitEnding` 只被门调用。因此计划书 WP2 的"接到现有世界选择提交入口"落地为：**在纯状态机之上追加原子提交服务**（本 ADR 的 `D01` 形状），而不是改造一个并不存在的运行器。 |
| `R-4` | 2026-10-03 | **设计补全**（`D05` 的键公式；决定不变） | 原 `D05` 把故事根键写成 `story:<storyId>@v<ver>#<runId>.e<revision>`。按它推演 `S8-C02`（"同一次选择同时有对话根和故事根 ⇒ 因果身份合并计数"）**不成立**：同一次选择会得到**两把**键。改为按 `anchorConversationEventId` 落键（与对话根同键）⇒ `S8-C02` 构造上成立。**`D04`/`D06`/门槛与全部负控不变**；`system` 提交仍进不了习惯根（`story-system:` 前缀不合格）。 |
| `R-5` | 2026-10-03 | **上游缺陷修复**（`world-machine.ts`，ADR-091 的实现面） | ⚠️ WP2 实测发现：`advanceFromProposal()` **只**按**迁移声明**取可见事件，而 `story-types.ts` 对节点 `visibleEvents` 的原文是"进可见集合"、`JICHUANG_PACK` 的迁移**故意不声明**（那里的注释逐字写着"可见事件由**节点**承载"）、`.ink` 每节点发 `# visible:` 且 `ink-runtime.ts` 会累积、**同文件的 `commitEnding()` 本来就是按目标节点取**。⇒ 后果是"她只经历了序章那一条"，且纯状态机与 ink 运行器对同一张图给出**不同的经历集合** —— 这是来源安全面的分歧，`S8-A03`/`S8-A09` 直接依赖它。修法：`newlyVisible = 迁移声明 ∪ 目标节点声明`（去重、保持作者顺序、仍然只增不减）。**只改实现使其符合已文档化的语义**；`postlv2:story/world/source/source-root` 四道既有门复跑全 PASS。 |
| `R-6` | 2026-10-03 | **事实登记**（不改变决定） | `exitStory()` **不**移动 `currentNodeId`（退出记 `RUN_EXITED` + `ending='exited_by_user'`，节点不变）⇒ 内容包里 `end_exit` 节点的 `visibleEvents=['ending_exited_by_user']` **不会**由纯状态机带出（`.ink` 侧会）。本工作包**不改**退出的节点语义（计划 §5.1"退出 ≠ 被判定未通过"是既有裁定），把它登记为残余 `L-S8-06`，由 WP3 的可见性判据明确覆盖"退出路径的可见事件按哪一侧为准"。 |
| `R-7` | 2026-10-03 | **设计更正**（`D05` 的合并标签取向；计数决定不变） | `expandLineage` 的根合并第一版让"对话来源类"覆盖"故事类" ⇒ **每个**故事根与自己的 anchor 合并后都变成 `user_statement`，于是新增的 `story_experience` **永远不可达**（死词汇值）—— 而 `S8-C02` 的原话是"因果身份合并计数；**来源 kind 保持各自身份**"。改为**故事侧优先**：合并仍为 1 个根（计数不变），标签保留 `story_experience`。方向也是失败关闭的（把"她经历的"标成"用户说的"是**升级**来源）。旧对话链没有故事路径 ⇒ 标签与计数逐字不变（`W9` 回归）。 |
| `R-8` | 2026-10-03 | **数值更正**（`D09` 的量级） | 故事关系规则表第一版的增量写成了 `trust 0.06 / closeness 0.06`，**超出** `contracts/relationship.ts` 的既有单事件上限（`0.05 / 0.03`）——那会让"故事来源"变成关系增量的**后门**。改为全部落在既有上限内，并让 `assertStoryRuleTablesWellFormed()` **直接调用** `relationshipDeltaWithinBounds`（放宽在**构造期**就不可能）。`D09` 的"保留既有单次上限"逐字未变。 |
| `R-9` | 2026-10-03 | **判据修正**（两处冻结门的断言；**不放宽**） | S8 追加 `STORY_DERIVED` 之后，两个既有门断言的**词表大小**过期：`m8-wp2-contracts` 的 `P15` 断言"originKind **五值**"、`m7-wp2-contracts` 的 `P11` 断言"**三值**"。判据改为 6 值 / 4 值，并把 `STORY_DERIVED` 加入放行集；⚠️ **三个注入类与 `MAINTENANCE_INJECTION` 仍然失败关闭**（那两条纪律一个字节没放宽）。改的是"词表有几项"，不是"什么被允许"。 |
| `R-10` | 2026-10-03 | **设计补全**（`D05` 合并结果的**根 id 取值**；`R-7` 的续修） | `R-7` 只规定了两侧合并时**标签**取故事侧；实现时把**整个根**（含 `id`）都取了故事侧 ⇒ 根 id 成了**提交身份**。后果：M11 的只读面 `readReflectionSourceSnapshot` 按根 id 反查 `conversation_events`（actor / 序号 / 归因），查不到 ⇒ `usable:false` ⇒ **"故事 → 反思"整段不通**（`postlv2:s8:reflection:verify` 的 R4 抓到，诊断行显示追根器本身是 3 根/2 会话、零拒收）。修正：合并时 `id`/`depth` 取**对话侧**（保证根 id 永远是真实对话事件）、`sourceClass` 取**故事侧**（`S8-C02` 的"来源 kind 保持各自身份" + 更保守）。`rootCount`/`conversationCount` 与全部负控不变，`W1`–`W10` 复跑全 PASS。 |
| `R-11` | 2026-10-03 | **设计补全**（`D12` 的撤回**必须传播到消费端能看见的那把键**） | 撤回挂**故事提交**，而采纳后的槽位里存的根是**对话事件 id**（`R-10` 的直接后果）。于是消费端（`readUsableAdaptiveSelfStates` → `readReflectionSourceSnapshot`）重算资格时只看那些对话事件 —— 它们**完全健康** ⇒ **"撤回了却还在入模"**（`postlv2:s8:lifecycle:verify` 的 L3/L4 实测抓到：追根器已报 `story_root_withdrawn`，注入端仍有 section）。补法：新增 `withdrawnStoryAnchorIds()`，把撤回集合经 `storyline_commits.anchor_conversation_event_id` 映射成**触发对话事件 id 集合**，消费端据此把该根标 `source_retracted`。没有撤回事件时集合为空 ⇒ **旧行为逐字不变**（M11.1 各门不受影响）。 |

---

## 10.2 修订 R-12（2026-10-04）

**类型：事实更正**（只追加，不回写上文；`R-11` 之后的编号由 `R-12` 续）。

⚠️ 更正原 `:421` 的这句话：

> 原 `:421`（正文，**一字未改**）：`- **不**主张 S8 已实现：本 ADR 是 \`PROPOSED\`，代码尚未按它落地。`

**该句已过时**：

```text
① 本 ADR 的头部状态是 `ACCEPTED / DESIGN FROZEN`（§10.1 冻结记录，2026-10-03），
   不是 `PROPOSED`；
② S8 已按本 ADR 实现（WP0–WP8）；
③ S8 已生产激活（`.env` 设 `CHARACTER_STORY_COGNITION_ENABLED=true`，代码缺省仍 false）。
```

依据：[ADR-094](ADR-094-s8-story-cognition-production-activation.md) `R-5`（2026-10-04 修订读数）·
[S8 激活记录](../post-lv2/S8-Activation-Record.md) ·
[S8 门判定](../post-lv2/S8-Gate-Decision.md) §5。

⚠️ 本修订**不**声称 S8 能力通过：行为槽 `S8-A43` 仍 `NOT RUN`、`S8-A38` 是已裁定残差；
且**生产入口无调用者**（`L-S8-30` / [S8 消费入口缺口立案](../post-lv2/S8-Consumption-Entry-Gap.md)）。
§8 的其余五条「不主张」**继续有效**。
