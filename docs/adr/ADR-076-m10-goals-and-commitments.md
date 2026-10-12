# ADR-076：M10 目标、承诺与持续行为（设计裁定）

> 状态：**ACCEPTED / DESIGN FROZEN**（2026-09-29，M10 WP1 出口）
> 计划源：[`M10-Execution-Plan.md`](../m10/M10-Execution-Plan.md) §5–§9 · §20（推荐决策）· §14–§16（判定体系）
> 基线输入：[`M10-Baseline-Report.md`](../m10/M10-Baseline-Report.md)（WP0 六问的代码指针与实测读数）
> 未决项：[`M10-Unresolved-Decisions.md`](../m10/M10-Unresolved-Decisions.md)（**只**登记不影响授权 / 失效传播 / 完成 / 遗忘语义的项）
> 验收契约：[`M10-Acceptance-Contract.md`](../m10/M10-Acceptance-Contract.md)（与本 ADR 同日冻结）
> 纪律：本 ADR 冻结**语义**；实现命名由工程处理。判据变更 = 本 ADR 修订 + 前后读数。

---

## 0. 授权依据

M10 由计划书 `M10-Execution-Plan.md` 立项（提交 `81b9112`），WP0 于 `decd2d2` 完成并出基线报告。
本 ADR 冻结计划 §20 的 `M10-D01…D20`，并追加 WP0 读数驱动的 `M10-D21…D29`。

**本 ADR 不授权**：生产激活（WP12 独立裁定）· 合并 / 打标签 · 真实库迁移或恢复 ·
新增任何外部能力 · 修改任何历史验收档或已冻结的既有契约语义。

---

## 1. 背景：M10 在六域分离中的位置

计划 §4.1 的六域分离是本 ADR 的地基：

| 域 | 回答的问题 | 不能替代什么 |
|---|---|---|
| Memory | 她有资格长期记住什么 | 不替代目标或授权 |
| Belief | 她当前相信什么、依据是什么 | 不替代用户承诺或世界真值 |
| **Goal** | **她准备追求什么结果** | **不证明事情已发生** |
| **Commitment** | **她在什么范围内正式承担了什么** | **不自动产生外部执行权限** |
| ActionResult / 合格 Observation | 实际执行或观察到什么 | 单次成功不必然满足整个目标 |
| Reflection（M11） | 根据经历提出怎样的认知修订 | 不直接把目标自述写成 Memory 或世界事实 |

> 「我希望你信任我」是目标 / 表达；「你信任我」是关于用户的判断。
> 前者不能给后者提供事实资格。

### 1.1 WP0 的基线结论（本 ADR 的设计输入，不是背景装饰）

| WP0 事实 | 本 ADR 的落点 |
|---|---|
| Memory 的真实 `revision` 按 ID 读得到（实测 create=1 → supersede=2）；M9.5 交接 fixture 把 `sourceRevision` **写死为 1**，且 `recheckReferences()` 只调用消费者传入的回调 | **D25**：冻结真实的引用构造与复核形状，补齐该 fixture 的两个缺口 |
| `listActiveBeliefs()` **只按 status 过滤**（读到 active ≠ 来源仍有效）；`recheckBeliefDependencies()` + `applyInvalidationOverlay()` 是既有的两层复用口 | **D06 / D09**：Goal 的依赖读取**必须**走那两层，不得只调低层列表 |
| 用户归因的唯一派生口是 `sourceQualificationOf()`，实测经真实入口的用户话语得 `ESTABLISHED` | **D07 / §4.5**：来源资格矩阵以它为唯一判据 |
| assistant 事件在 `completeTurn()` 内 `resolveWithEvent()` 时落盘，落库失败**不吞** | **D13 / §4.11**：崩溃窗口真实存在，`conversation_output` 依据**必须**绑定已落库事件 |
| 幂等补记走 `applyAcceptedEvents` / `processed_operations`（实测 created 1→0 / dedup 0→1）；但走完整放行口的重复投递被 **`duplicate_content`（内容去重闸）**先挡下 | **D26**：兑现补记**不得依赖内容去重**，必须自带确定性事件身份 |
| 通用投影表 PK `(character_id, projection_type)`、全 `text`、`state` 为 `jsonb`；60 条 `goal:<id>` 探针三档按 ID 全通；但族读取是"列出全部投影行 + 内存前缀过滤" | **D15 / D24**：v1 零迁移；族读取成本作为具名代价交给 WP9 实测 |
| `goals: 45` 与 `externalEvidence: 45` 同数，`sortSections` 按 id 升序打破平局 | **D22**：裁定平局方向，并对新增 section id 加约束 |
| `ContextSectionKind='goals'` 与 `goals: 45` 是**预留**；`ContextBudget` 的两个既有额度缺省都是 **0**（"接线就位、缺省 0、激活另裁"） | **D15 / §4.12**：`goalTokens` 缺省 0，沿用同一形状 |

### 1.2 与既有裁定的关系（哪些**不动**）

```text
不动  src/kernel/app/memory/** 与 memory-validator.ts 的语义（M4 冻结面）
不动  M5.1.1 / M9 / M9.5 / M9.1 的资格链与遗忘遮蔽语义 —— **复用**，不改写
不动  M4.5 的 ActionResult / reply-truth 语义 —— **复用**，不新增执行能力
不动  `SECTION_PRIORITY.goals = 45` 这个既有常量（见 D22）
不动  迁移链 0001–0009（D15：v1 追加迁移 = NONE）
不动  任何历史验收档（失败档、作废量具档一律保留归属）
```

---

## 2. 冻结决策（M10-D01…D20，按计划 §20）

| 编号 | 冻结决定 | 冻结理由（或计划给出的取舍） |
|---|---|---|
| M10-D01 | 范围为 **Goals + 有限 Commitments**；新增外部能力 = **NONE** | 加后台提醒 / 应用动作需另立能力与权限验收；本阶段不提前拥有闹钟、邮件、代码执行 |
| M10-D02 | **用户明确设立或采纳**才持久激活；角色可提出建议，但不能据偏好替用户接受 | 开放自主目标需新增治理、抑制与长期质量契约，属后续范围 |
| M10-D03 | Goal 与 Commitment 语义分开判定；v1 **共用一行投影 / 一个事务** | 双存储 / 多承诺需要额外一致性机制；一条 Goal 当前至多一个正式承诺 |
| M10-D04 | 原生 `EntityRef` + `contextRef`；生产仍**单 Character** | 不提前建设多角色服务，但保留隔离测试 |
| M10-D05 | `goalId` 含**来源 / 操作身份**，不仅内容键 | 纯内容键会复现"取消后永不重新建立"（M9 的 F-4 同族） |
| M10-D06 | 真 Memory `revision` + Belief 投影版本 + **使用前复核** | 不能直接复用固定 revision 的 fixture |
| M10-D07 | 模型只产**有界提案**；程序控制接受 / 状态 / 权限 | 纯词形方案需明确缩小语义范围，不得声称开放中文理解 |
| M10-D08 | 每轮最多 **1 焦点 Goal · 1 nextStep · 至多 3 项入模** | 任务图 / 并行步骤会增加调度与恢复面 |
| M10-D09 | 必要依赖失效 ⇒ `blocked`；可选背景失效 ⇒ **只丢引用** | 一概取消会误解用户意图；一概保留会继续用旧事实 |
| M10-D10 | Goal **遗忘独立于取消**；新增文本受来源遮蔽 | 只删 dependency ID 无法防正文泄漏 |
| M10-D11 | 两类角色承诺：**有限对话交付** + **已有 ActionResult** | 长期维护型承诺需独立触发 / 失败定义，v1 不假装覆盖 |
| M10-D12 | `user_report` 可结束**用户自己的**目标，**不**证明角色外部履约 | 不区分会让"你已经做了"伪造成功 |
| M10-D13 | `fulfilled` **必须有真实结果**；`partial` / `timeout` 不代替 | 任意 LLM 评分直接改状态不可接受 |
| M10-D14 | 时间**只用于读取时判断**；**不创建 scheduler** | 主动提醒将扩张 Lv2 阶段范围 |
| M10-D15 | 复用通用事件 / 投影；**迁移目标 NONE**（WP0 实测支持） | 不够再追加迁移，绝不改旧 DDL |
| M10-D16 | 新开关**缺省 off**；激活设 cutover、**不回填历史** | 扫旧聊天可能批量造义务 |
| M10-D17 | M9.5 生产模式维持 **shadow**；Goal 在现状下验收 | 切 `on` 必须独立对照与授权，不能归 Goal 收益 |
| M10-D18 | **不依赖、不默认采用 Jev** | 采用须另有 Goal 专项质量证据 |
| M10-D19 | **300 场景**（dev 100 / val 60 / test 140）· **三轮取最差** · 长门 **200 → 500 轮** | 调整规模可讨论，但必须先冻结且保留足够高风险分母 |
| M10-D20 | 人审 / 量具 / live / 激活**分别判定** | 总 PASS 不能掩盖未运行与配置差异 |

---

## 3. WP0 驱动的追加裁定（M10-D21…D29）

### M10-D21 · 领域操作词表**自持**，不扩展 `ProposalOperation`

**冻结**：M10 定义自己的闭集 `GoalOperation` / `CommitmentOperation`，并在
`idempotencyKeyForGoalEvent({ …, unit })` 里用 `unit` 作第五分量 —— 与
`idempotencyKeyForBeliefEvent` 逐字同形。

**依据（既有裁定，不是新发明）**：[`memory-validator.ts:82`](../../src/kernel/policies/memory-validator.ts#L82) 逐字写着
「它与 `ProposalOperation` 的对应关系是**显式**的（不是同一个枚举）……
但把 `restore` 加进 `ProposalOperation` 会影响所有认知模块的语义」。
而 [`idempotencyKeyForBeliefEvent`](../../src/kernel/policies/belief-validator.ts#L145) 的 `operation` 就是 `string`，
实际传入的是 `unit`。

**代价**：无。**若选择其它方案**（扩展共享词表）：会影响所有认知模块的幂等键语义，
需要一次跨域回归，而收益只是少一个类型。

### M10-D22 · `goals: 45` 平局的裁定：**外部证据优先保留**

**冻结**：
1. **不修改** `SECTION_PRIORITY.goals = 45`（它是既有常量，且改它等于改一个跨里程碑的排序约定）。
2. M10 新增的 section `id` **必须**以 `goal` 开头（即字典序 **大于** `'external-evidence'`）。
3. 因此在 priority 45 平局时，[`sortSections`](../../src/kernel/contracts/context.ts#L497) 的
   「相同按 id 升序」使**外部证据先被保留**。

**理由**：外部证据是**用户显式要求**的、且**只在当轮存在** —— 被裁掉等于这一轮搜索白做；
Goal 块是**持久状态**，下一轮仍读得到。这与 `externalEvidence: 45` 被定在"高于记忆的 40"的
原始理由同源。
**可测判据**：契约 §3 的 `G40` 要求"预算不足时最终入模计数为真实值"，且 `G42` 要求 off 档基线不漂移。

### M10-D23 · cutover 是**结构性**的（v1 不加 `GOAL_ORIGIN` 事件）

**冻结**：v1 **不新增** `GOAL_ORIGIN` 事件，也**不**记录 cutover 水位。
理由是结构性的：M10 的 Goal **只在当轮合法请求上创建**，v1 **没有任何**按窗口扫描
会话历史 / 域事件的路径 ⇒ "不回填旧聊天"由构造保证，而不是由水位保证。

**绊线（必须与实现同时成立，否则本裁定失效）**：v1 的任何扫描（包括 §4.11 的
崩溃窗口 reconciliation）**不得**回溯 conversation events / 旧聊天。若某个 WP 引入
按窗口扫描（例如把 reconciliation 改成按会话窗口），**必须同时**：
追加 `GOAL_ORIGIN` 事件 + 重放守卫 + `cutoverSequence` 判定 + 一份新的 ADR。

**写作时的事实**：M8 / M9 之所以需要 ORIGIN，是因为它们的调度器**按事件窗口**工作
（`AFFECT_ORIGIN@2` / `BELIEF_ORIGIN` 的 `cutoverSequence`）。M10 没有那个形状 ⇒ 不抄。

### M10-D24 · 族读取成本的处置

**冻结**：
1. v1 **零迁移**（D15）。投影行为一族多行：`goal:<goalId>`，每 Goal 一行。
2. 族读取（列出本角色的 goal 行）在 v1 允许是"列出全部投影行 + 内存前缀过滤"，
   **但必须**在 trace 里记账（扫描了多少行、命中多少行）。
3. **WP9 的规模门必须实测**该成本（目标池 200 / 500）并出曲线。
4. 若实测不可接受，**允许**追加一条只含 goal 行的表（**迁移 0010**）——
   但那需要单独 ADR + 迁移闸；**不得**为此修改既有 DDL。

### M10-D25 · 引用构造与复核的**真实**形状（补齐 M9.5 fixture 的两个缺口）

**冻结**（这是 WP2 的接口契约）：

```text
MemoryReference  := { memoryId, sourceRevision: number, evidenceIds: string[], status }
    构造  = 按 ID 读当前记录（store.get）→ 取**当前** revision；
            **不得**使用任何固定值，**不得**使用检索时的缓存快照
    复核  = referenceRecheck(ref) →
              { usable: true }
            | { usable: false, reason: 'root_missing' | 'revision_changed'
                                     | 'status_not_usable' | 'forgotten' | 'foreign' | 'unavailable' }
```

**硬要求**：
- `unavailable`（读不到）**不是** `usable`，也**不是** `root_missing` —— 失败关闭为**不可用**。
- 复核必须**跨 async 边界之后再查一次**，不得持有旧授权快照。
- `referencesFromOutcome()` / `recheckReferences()` 这两个 **fixture** 保留其契约作用，
  **不**被改写成生产权威；生产走新模块（计划 §1.4 第 1/2 条的落点）。

**Belief 侧**：`BeliefReference := { beliefId, projectionRevision, epistemicKind, supportLevel, status }`。
`epistemicKind` / `supportLevel` **必须随行**（M9 交接 §2 第 5 条），
inferred / tentative **不得**作硬前提。

### M10-D26 · 兑现补记的事件身份（**不依赖内容去重**）

**冻结**：
1. 兑现 / 完成事件的幂等键由**确定性事件身份**给出：
   `unit = goal-completed:<goalId>:<expectedRevision>` /
   `commitment-fulfilled:<commitmentId>:<expectedRevision>:<resultRefId>`。
2. 补记走 `applyAcceptedEvents` 的幂等路径（WP0 的 E4a 已证明 created 1→0 / dedup 0→1 且返回同一事件），
   **不得**依赖 `duplicate_content`（WP0 的 E4b 证明内容去重闸会**先于**幂等键闸命中）。
3. 补记**不得**重新生成产物、不得重发副作用（§4.11 窗口 B）。

### M10-D27 · Goal section 的 id 约束与预算**独立额度**

**冻结**：
1. section `id`：规划块为 `goals`（单数 / 复数固定一个），逐项 section 为 `goal:<goalId>`；
   两者都以 `goal` 开头（D22）。
2. `ContextBudget` **追加** `goalTokens: number`，`DEFAULT_CONTEXT_BUDGET.goalTokens = 0`
   ——与 `externalEvidenceTokens` / `rollupTokens` **逐字同构**（"接线就位、缺省 0、激活另裁"）。
3. `ContextCategory` 追加 `'goals'`；`assertContextBudget` 的等式追加 `goalTokens`。
4. **⚠️ 追加字段的连带影响**：任何手写字面量的 `ContextBudget` 构造点会立刻类型不过
   ⇒ 实现必须**展开 `DEFAULT_CONTEXT_BUDGET`**，不得在别处复制一份默认值
   （否则"缺省 0"会有一个影子副本，而影子迟早漂移）。
5. 上限：`goalTokens` 有界 `0..1000`，缺省 **500**（计划 §10.1 的推荐值）。

**为什么不是 `budgetGroup: 'status'`**：那个分组是"程序生成的记录状态行"专用，
其语义是"**不从共享预算扣**"。Goal 规划块是**可裁内容**（与记忆同性质），
给它独立的 `budgetGroup` 会让它在预算最紧的一轮仍然占位 —— 与计划 §10.1
「允许裁剪……最终仍服从 ContextCompiler 总预算」相反。

### M10-D28 · **提议不是持久实体**；跨轮采纳不可验证时必须澄清

**问题**：计划要求"用户采纳角色提议"必须"能定位提议与**具体内容**"（§7.1），
而 §5.1 又说"正式 Goal 候选之前的 `Proposal` 不属于上述状态机"。
一个悬空的"提议生命周期"会凭空引入一个新的状态机与遗忘面。

**冻结**：
1. v1 的**提议不是持久实体** —— 它是**已落库的 assistant event 里的一段有界文本**。
   **不新增** proposal 表 / 投影行 / 事件族。
2. 采纳路径的 `acceptanceRefs` 必须**同时**给出两组引用：
   - 提议侧：`{ proposedByAssistantEventId, span, fingerprint }`
   - 采纳侧：`{ conversationEventId, span, fingerprint }`（用户的原话）
3. **同轮采纳**（提议与本轮用户话语在同一个对话窗口内）：可验证 ⇒ 正常受理。
4. **跨轮 / 跨会话采纳**：若程序**无法**唯一定位那条提议（assistant event id 不由本轮上下文提供），
   **必须澄清**（`goal_proposal_ambiguous_target`）——
   **不接受**"我猜你说的是那个提议"。**不得**编造 `proposedByAssistantEventId`。
5. 采纳路径的范围**不得超出**原提议内容；超出 ⇒ `commitment_scope_exceeds_proposal`。

**理由**：这条把"提议"留在**已有的、已验收的**对话账本里，而不是新造一个第二权威；
同时它把"跨会话采纳不可靠"这件事变成一条**必须澄清**的显式行为，
而不是一个"她猜对了"的运气问题。

**残留（登记，见未决项 `U-05`）**：v1 **不做**跨会话的提议检索
⇒ 隔很久之后的"好，就这么办"会走澄清路径。这是**有意的保守**，不是缺陷。

### M10-D29 · Goal 操作事实块的位置与不可裁级别

**冻结**：新增的 `GoalOperationResult` 程序事实块**逐字遵循**既有两个结果事实的先例
（[`sections.ts:712`](../../src/kernel/context/sections.ts#L712) 的 `memory-write-result`
与 [`:746`](../../src/kernel/context/sections.ts#L746) 的 `action-result`）：

```text
kind        = 'instruction'
priority    = SECTION_PRIORITY.currentInput - 3     （紧接既有两条之后）
droppable   = false                                 （被裁 = 模型不知道该说"还没成立"）
无 Goal 操作 ⇒ 产 0 个 section（render 返回 undefined / 空串）⇒ 绝大多数轮次 prompt 不变
```

**理由**：这三条块回答的是同一个问题——"程序**真的**做了什么 / 没做什么"。
被裁掉的后果与"少想起一条记忆"不是一个量级：
回到"我已经帮你处理好了"的默认倾向正是计划 §9.1/§9.4 要堵的。

**内容纪律**（§9.4 的落成）：必须区分 `accepted / rejected / clarify / failed`、
当前状态、**实际变化**、**真实兑现状态**。
**可见确认由程序事实块支持**；模型自由正文的违约 / 完成夸大另用语义评测
（**不宣称**词形守卫可覆盖所有说法）。

---

## 4. 技术接口冻结

### 4.1 Goal 身份与字段闭集

**身份派生（D05 的落成）**：

```text
goalId = `gol:${characterId}:${fnv1a64Hex(stableMaterial({
  characterId, owner:{kind,id}, targetEntity?:{kind,id}, contextRef?,
  origin,                      // 'user_requested' | 'character_proposed'
  statementFingerprint,        // 有界目标描述的稳定指纹（不是原文）
  acceptanceSourceEventId,     // 受理来源：用户明确设立的**那条**对话事件
  operation: 'create',
}))}`
```

**两条反例为什么被结构性排除**：

| 要求 | 为什么成立 |
|---|---|
| 同内容重新设立 ⇒ **新身份** | 新的一轮 = 新的 `acceptanceSourceEventId` ⇒ 指纹不同 |
| 同一操作重复投递 ⇒ **幂等** | 同事件 + 同操作 + 同内容 ⇒ 同一 `goalId` 与同一幂等键 ⇒ 放行口按 `hasProcessed` 拒绝第二次 |
| 同轮两次不同内容的 create ⇒ 不撞键 | `statementFingerprint` 在材料里 |

**字段闭集**（全部由放行口校验；缺省值必须显式写出，不用 `undefined` 兜底）：

| 字段 | 类型 / 范围 | 备注 |
|---|---|---|
| `goalId` | 上述派生 | 不可由模型提供 |
| `owner` | `EntityRef(character, id)` | 生产单 Character；跨 owner 一律拒 |
| `targetEntity?` | `EntityRef` | 涉及用户时**必须显式**给出，不取"最近用户" |
| `contextRef?` | 有界字符串 ≤128 码点 | v1 不建设世界上下文系统 |
| `origin` | `'user_requested' \| 'character_proposed'` | 后者必须能定位采纳证据才可激活 |
| `sourceRefs` | 非空数组，≤8 项，每项 `{conversationEventId, span:{start,end}, fingerprint}` | **正文不复制进 trace** |
| `revision` | 整数 ≥1，每次正式转换 +1 | 写入带 `expectedRevision` |
| `statement` | ≤500 **码点** | 是**数据**，不得被渲染成系统指令 |
| `successCriterion` | 闭集（见 §4.5） | 不接受"LLM 判断达成" |
| `status` | `'active' \| 'paused' \| 'blocked' \| 'completed' \| 'cancelled' \| 'superseded'` | 终态不可迁移 |
| `priority` | `'normal' \| 'high'`，缺省 `normal` | 只由用户显式指定；不凭情绪 / 亲密度升降 |
| `dependencies` | ≤16 项，三类（见 §4.6） | 必要与可选分开 |
| `nextStep?` | ≤300 **码点**，至多一个 | 随新来源显式修订，不造任务树 |
| `time` | `{recordedAt, occurredAt?, dueAt?, dueBasis?, timezone?}` | 三分离，见 §4.9 |
| `commitment` | `CommitmentState \| null` | 至多一个 |
| `supersedesGoalId?` | 前项 id | 旧项保持可审计 |
| `blockedReason?` | 闭集原因码 + 非敏感说明 | **不得**含被忘取值 |

### 4.2 Commitment 字段与状态

```text
commitmentId = `cmt:${characterId}:${fnv1a64Hex(stableMaterial({
  characterId, goalId, actor:{kind,id}, beneficiary:{kind,id},
  scopeKey, acceptanceSourceEventId,
}))}`
```

| 字段 | 类型 / 范围 |
|---|---|
| `commitmentId` / `goalId` | 上述派生 / 所属目标 |
| `actor` / `beneficiary` | `EntityRef`（谁承担 / 谁受益） |
| `scope` | ≤300 码点；**不得超出原提议范围**（采纳路径） |
| `acceptedAt` / `acceptanceRefs` | 时间 + 非空引用（≤8） |
| `criterion` | 闭集，且**必须**是 D11 的两类之一 |
| `status` | `'active' \| 'fulfilled' \| 'broken' \| 'cancelled' \| 'superseded'` |
| `completionRefs` | 完成依据引用（≤8），`fulfilled` 时非空 |
| `revision` | 整数 ≥1；与 `goal.revision` **各自独立** |

**硬规则**：
- **一个 Goal 当前至多一个**非终态 Commitment；已有一个 active 时再来一次普通 accept ⇒
  拒绝 `commitment_already_active`；只有**显式替代**（`supersede`）才合法。
- Goal 被取消时，其 active Commitment **在同一操作中**取消
  （`reason: 'goal_cancelled'`）——不得留下"已取消目标仍被履行"的孤儿约定。
- Goal 被**暂停**时 Commitment **不自动**解除；`status` 保持 `active`，
  但**可履行性**由 Goal 状态决定，用户界面必须显示暂停原因（计划 §5.2）。
- `broken` **不**由超时 / 未知 / 取消 / 用户暂未回复推定；需要可判定的承诺规则 + 违反证据
  （§4.5）。否则只记 `overdue` / `outcome_unknown` 作为**当前可用性原因**，
  **不发明**成功或失约。

### 4.3 事件族与 payload 上限

**Goal（8 个，计划 §8.1 的清单逐条落地）**：

| 事件 | payload 要点 | `maxPayloadBytes` |
|---|---|---|
| `GOAL_CREATED` | 首版**完整快照**（reducer 必须能从零建出记录）+ `mutation` + `sourceRefs` | **16384** |
| `GOAL_REVISED` | `goalId` + `expectedRevision` + `changed: string[]`（闭集字段名）+ 新值 + `reason` | 4096 |
| `GOAL_PAUSED` | `goalId` + `expectedRevision` + `reason` | 4096 |
| `GOAL_RESUMED` | 同上 + **依赖复核读数**（usable/dropped 计数） | 4096 |
| `GOAL_BLOCKED` | `goalId` + `expectedRevision` + `reasonCode`（闭集）+ 非敏感说明 + `preservedStatus` | 4096 |
| `GOAL_COMPLETED` | `goalId` + `expectedRevision` + `basis`（三选一）+ `evidenceRefs[]` | 8192 |
| `GOAL_CANCELLED` | `goalId` + `expectedRevision` + `reason` + `forbiddenSourceEventIds?` | 8192 |
| `GOAL_SUPERSEDED` | `goalId` + `supersededByGoalId` + `expectedRevision` + `reason` | 4096 |

**Commitment（5 个）**：

| 事件 | payload 要点 | `maxPayloadBytes` |
|---|---|---|
| `COMMITMENT_ACCEPTED` | 首版完整快照 + `acceptanceRefs` | 8192 |
| `COMMITMENT_FULFILLED` | `commitmentId` + `expectedRevision` + `resultRefs[]` + `basis` | 8192 |
| `COMMITMENT_BROKEN` | 同上 + `violationRefs[]` + `ruleId` | 4096 |
| `COMMITMENT_CANCELLED` | `commitmentId` + `expectedRevision` + `reason` | 4096 |
| `COMMITMENT_SUPERSEDED` | 旧 / 新 commitmentId + `expectedRevision` + `reason` | 4096 |

**⚠️ 不加 `GOAL_ORIGIN`**（D23）。**这 13 个上限都是第二道防线** ——
第一道是放行口的字段上界（`statement` ≤500 码点等），因此"payload 太大"与
"字段不合法"是两个**可区分**的拒绝码（沿用诊断信号与 Memory 的既有做法）。

**登记方式**：新增独立工厂 `createGoalDomainEventRegistry()`，并**从 WP3 起**接入
[`createFullDomainEventRegistry()`](../../src/kernel/contracts/domain-event.ts#L692)
（M7/M8/M9 的"WP2 注册、WP4 接线"可审计分步）。

**投影行键**：`goal:<goalId>`（一族多行，D24）；**没有** `commitment:` 行 ——
Commitment 住在 Goal 行的 `state.commitment` 里（D03）。

### 4.4 两张转换表的**合法边全集**

**Goal**（计划 §6.1 逐行落成；左列是"当前状态"）：

| 当前 | 合法触发 | 结果 | 附带要求 |
|---|---|---|---|
| 不存在 | 受理明确目标；身份 / 来源 / criterion 合格 | `active` | 唯一 Goal；owner/target 显式 |
| `active` | 用户明确暂停 | `paused` | 来源合格 |
| `active` / `paused` | **必要**依赖失效或能力条件不满足 | `blocked` | 保留 `preservedStatus` + 具名原因；禁止继续使用旧前提 |
| `paused` | 用户明确恢复**且**依赖复核通过 | `active` | 复核读数进 payload |
| `blocked` | 用户确认修订 / 恢复**且**依赖复核通过 | `active` | 不得因索引恢复就静默继续 |
| `active` | 合格完成证据满足**当前 revision** 的 criterion，且 `completionBasis === criterion.kind` | `completed` | 依据类型 + 引用 |
| `paused` / `blocked` | 用户明确报告**自己的**目标已完成，且 `successCriterion.kind === 'user_report'` | `completed` | **不**顺带把角色承诺判 `fulfilled` |
| `active` / `paused` / `blocked` | 用户明确取消，或**免除**一项机器可判的义务 | `cancelled`（豁免时 `reason='user_waived'`） | **不是** `completed`（见 §4.5） |
| `active` / `paused` / `blocked` | 用户明确取消 | `cancelled` | 同步取消 active Commitment |
| `active` / `paused` / `blocked` | **根证据**失效（§4.6） | `cancelled` (`reason: 'root_evidence_withdrawn'`) | 读侧立即整项遮蔽 |
| `active` / `paused` / `blocked` | 改变目标对象 / 成功条件等**实质**语义 | 旧 `superseded` + 新 Goal | 关联操作**原子提交** |
| `active` / `paused` / `blocked` | 用户明确"忘掉这项目标" | `cancelled` (`reason: 'explicit_forget'`) + `forbiddenSourceEventIds` | 见 §5 |
| 任意终态 | 查询 / 重放 | 不变 | 幂等，不重复计数 |
| 任意终态 | 新的**明确**设立请求 | **新身份**（D05） | 不原地复活旧承诺；旧根禁用不因内容再次出现而解除 |

**非法边**（必须**拒绝且零事件**，全部有具名拒绝码）：

```text
终态（completed / cancelled / superseded）→ 任何状态（`goal_terminal_state`）
paused / blocked → completed，**但依据不是 user_report**
    （即：机器证据**不能**把一个暂停/受阻的目标直接判完成 ——
      paused/blocked 只接受 user_report，见上表最后两行）
completed → active（不得"复活"）
任何 expectedRevision 与实际不符的写入（`goal_revision_conflict`）
```

**另一条行为禁止（不是状态迁移）**：Goal 处于 `paused` / `blocked` / 终态时，
**不得**继续执行其 `nextStep`，也不得把它当作"仍可执行"渲染给模型。

**小改 vs 实质改的界**：措辞 / 优先级 / 当前步骤 ⇒ `GOAL_REVISED` + revision +1；
**对象 / 截止义务 / 成功条件** ⇒ `GOAL_SUPERSEDED` + 新身份。
**不得**用自由文本覆盖抹掉"曾经答应过什么"。

**Commitment**（计划 §6.2）：

| 当前 | 合法触发 | 结果 |
|---|---|---|
| 不存在 | 合格明确请求 + 能力检查通过 + 程序接受；或合格提议被**明确采纳** | `active` |
| `active` | 当前 revision 的**可验证**兑现证据 | `fulfilled` |
| `active` | 明确撤销约定 | `cancelled` |
| `active` | 双方明确重新约定，旧约定被替代 | 旧 `superseded` + 新身份 |
| `active` | 有证据证明已触发**且确实违背**有限义务 | `broken` |
| `active` | Goal 被取消 | `cancelled`（`reason: 'goal_cancelled'`，同操作） |
| 任意终态 | 重复结果 / 同一事件重放 | 幂等，**不重复增加完成数** |

**禁止**：把 `timeout` / `unknown` / 任务取消 / 用户暂未回复自动等同 `broken`。

### 4.5 三种达成依据（**必须分开**）

| 依据 | 可以确认 | **不可以**确认 |
|---|---|---|
| `user_report` | 用户报告**自己的**目标已完成；显示"据你刚才确认" | 角色已替用户完成外部动作 |
| `conversation_output` | 正式 assistant event 中存在约定产物；**结构检查**通过 | 内容必然正确、用户已经执行、世界已经改变 |
| `action_result` | 对应请求**实际执行**且满足具体 criterion（必要时读回） | 别的请求 / 别的用户 / 后来新修订的目标也已完成 |

**`successCriterion` 闭集**（**三个 kind，与三种依据一一对应**）：

```text
{ kind: 'user_report' }
    只有用户明确报告时才能成立；不自动满足。
    「跟进用户完成论文」用这一种 —— 完成依据允许是 user_report，但**只有用户**能说它完成。

{ kind: 'conversation_output', structure:
    { kind: 'item_count', count: 2..7 }
  | { kind: 'marker_set', markers: string[1..5] } }
    程序可证明"正式输出包含该项结构"并关联实际 assistant event；
    **不能**因此证明建议内容正确或有用（质量维度另做人审 / 语义评测）。

{ kind: 'action_result', capability: string, operation: string, require: 'executed_succeeded' }
    只消费**已获原有权限**的请求结果；Goal 不额外授予能力。
    匹配按**存下来的 actionId**，不做正文匹配（避免正则当成判据）。
    没有本阶段可复用的真实能力用例时，相关测试**明确标成 fixture**，
    不作为外部生产闭环。
```

**依据准入规则（唯一映射，不得放宽）**：

```text
completionBasis 必须 === successCriterion.kind     （一对一，无例外）
```

**⚠️ 三种依据**互不替代（计划 §5.3）。**特别地**：Goal 可以是"跟进用户完成论文"
（`user_report`），而 Commitment 若是"我替你发送文件"，用户说"你发了"**不能**代替真实 `ActionResult`。

**⚠️ "算了，就当完成了吧" = 放弃，不是完成**：用户免除一项**机器可判**的义务
（`conversation_output` / `action_result`）走 **`cancel`**（`reason='user_waived'`），
**不是** `completed`。这条堵的是"用一句客气话把未兑现的义务刷成已完成"——
那正是计划 §9.1「`accepted=true` 不代表执行」在目标层的同一条纪律。

### 4.6 三类依赖与失效传播

| 类 | 失效后的处置 | 事件 |
|---|---|---|
| **原始设立 / 接受证据**（`root_evidence`） | 目标**失去使用资格**：对话面**立即整项遮蔽**；写侧记录撤回原因；**不得**再说"你答应过" | `GOAL_CANCELLED(reason='root_evidence_withdrawn')` |
| **必要事实前提**（`necessary_premise`：Memory / Belief 引用） | Goal → `blocked`；**用户确认前不自动重新执行**；原因**不含**敏感细节 | `GOAL_BLOCKED(reasonCode=…)` |
| **可选规划偏好**（`optional_background`） | **丢弃引用、重新规划**，目标本身保留；**不得**因偏好撤回就宣告用户取消了目标 | `GOAL_REVISED(reason='optional_background_dropped')` |

**使用前复核**至少覆盖：`owner` / `targetEntity` · Memory `revision` · Memory `status` / 资格 ·
Belief 投影版本与 `status` · 根证据有效性 · **当前遗忘遮蔽** · 当前 Goal `revision`。
**跨 async 边界之后再检查**，不得持有旧授权快照。

**双保险**（与 M9 同款）：**读时立即遮蔽 + 写侧事件收敛**。
写侧失败 / 后台任务未运行 / 正在重建，**不得**让旧内容在下一次上下文读取中重新出现。

**同轮顺序**（计划 §8.3，与 M9 的 §5.3 同构）：

```text
当前输入 → Memory 操作路径取得**程序结果**
        → Context snapshot 在该结果**之后**决定可用 Goal
        → 本轮刚失效的 Memory / 根 id 进 overlay ⇒ 依赖它的 Goal **同轮**排除
        （不可"本轮照说旧内容，下轮再修"）
```

### 4.7 唯一写路径

```text
GoalProposal（模型或程序）
  → validateGoalProposal()            ← 唯一放行口
  → transaction: 幂等检查 + expectedRevision + append DomainEvent + fold projection
  → 已提交的 GoalOperationResult
  → 回应事实块 / trace
```

**硬规则**：
- 应用层**禁止**绕过事件直接 UPDATE 投影行。
- 没有 `sourceConversationEventIds` 的 Goal / Commitment 事件**不得**写入
  （沿用 `source_event_missing` 的失败关闭）。
- `scope` 恒为 `CHARACTER_INTERNAL`（类型层面已是字面量）。
- 关联操作（supersede + create、goal cancel + commitment cancel）**原子提交**：
  要么都发生，要么都不发生。

### 4.8 拒绝码闭集

**提案层（模型输出）**：

```text
goal_proposal_invalid_shape          结构与版本不符（未知字段 / 未知枚举按冻结契约处理）
goal_proposal_unknown_operation      操作不在闭集内
goal_proposal_span_not_in_source     span 不是原话范围
goal_proposal_source_not_user        来源不是本轮用户话语
goal_proposal_source_unqualified     归因不是 ESTABLISHED
goal_proposal_ambiguous_target       目标 / 主体 / 操作范围不唯一
goal_proposal_goal_not_found         引用的候选 id 不在程序给出的集合里
goal_proposal_revision_mismatch      expectedRevision 非法
goal_proposal_transport_failed       超时 / 取消 / 不可用（**不是** none）
```

**领域层**：

```text
goal_duplicate_operation        幂等键已处理（同操作重复投递）
goal_id_conflict                同一 goalId 已存在且状态不允许该操作
goal_not_found                  目标不存在
goal_terminal_state             终态不可迁移
goal_revision_conflict          expectedRevision 与当前不符（乐观锁）
goal_statement_too_long         超过 500 码点
goal_criterion_unsupported      criterion kind 不在闭集
goal_criterion_param_invalid    criterion 参数越界
goal_source_missing             没有来源事件
goal_source_forbidden           来源命中 forbiddenSourceEventIds
goal_dependency_missing         依赖读不到（**失败关闭**，不当"不存在"）
goal_dependency_foreign         owner / subject 跨角色
goal_capability_unavailable     能力条件不满足（D01：本阶段不新增能力）
goal_operation_dependency_unavailable  依赖不可用 ⇒ 整项拒绝
commitment_already_active       已有一个 active 承诺
commitment_scope_exceeds_proposal  采纳路径的范围超出原提议
commitment_not_found
completion_evidence_missing     fulfilled 无依据
completion_evidence_kind_mismatch  依据类型与 criterion 不符
completion_evidence_revision_stale 迟到结果绑定的是旧 revision
completion_evidence_not_executed   accepted=true 但未执行
completion_evidence_failed      failed / timeout / partial / cancelled
completion_structure_check_failed  对话产物结构检查不过
goal_operation_unavailable      请求未处理成功（**如实说明**，不以"没新目标"掩盖故障）
```

**非法输出记录为 `invalid`，不当 `none`**（计划 §7.2 第 1 条）。

### 4.8.1 WP3 追加的六条拒绝码（**判据变更记录**，2026-09-29）

冻结 §4.8 时列出的码覆盖了计划 §5–§9 的语义，但**实现时**发现六类情形需要**可区分的码**
（否则它们会被压进邻近的码里，而"压进去"的后果是排查时看不出真实原因）。
按本 ADR 头部的纪律（"判据变更 = 本 ADR 修订 + 前后读数"）在此**追加**，原文一条未改：

| 新增码 | 它区分的是什么 | 若压进邻近码会怎样 |
|---|---|---|
| `goal_illegal_transition` | **非终态但不在转换表里**的边（`paused→paused`、`blocked→paused`、`paused/blocked` 被机器证据判完成） | 压进 `goal_terminal_state` 会让人去查"为什么是终态"，而它根本不是终态 |
| `goal_revision_requires_supersede` | `changed` 含**实质**字段（对象 / 成功条件 / status） | 这是"想用修订绕过 supersede"的那条路；压进 `goal_revision_conflict` 会被读成并发问题 |
| `goal_supersede_target_missing` | supersede 的新目标**不在同一提案** | 关联原子性被破坏却只报"目标不存在" |
| `goal_orphan_commitment` | 取消有 active 承诺的目标却没在同提案取消它 | "已取消目标仍被履行"的孤儿约定会静默通过（`G13`） |
| `commitment_criterion_unacceptable` | v1 **不**正式接受的承诺 criterion（`user_report` 型 = 长期维护型） | 压进 `commitment_scope_exceeds_proposal` 会把它说成"范围太大"，而真实原因是**类型不支持** |
| `processor_version_presence` | 提案缺 `processor` / `processorVersion` | 与 memory / belief 的既有约定保持一致（放行口不认匿名提案） |

**前五条由门 `m10:test` 的 X 组逐条钉住**（`X2`/`X3`/`X7`/`X4`/`X5`/`X13`/`X12`/`X15`/`X17`）。

### 4.8.2 WP5 追加的两个原因值 + 关闭 `L-M10-08`（**判据变更记录**，2026-09-29）

**① `GoalBlockedReason` 追加 `dependency_unavailable`**（§4.6 的落成）

它必须与 `necessary_premise_invalid` **分开**：

```text
necessary_premise_invalid   我们**读到了**依据，它不作数了
dependency_unavailable      我们**读不到**依据，因此无法证明它作数
```

两者的用户措辞与排查方向不同（"那条依据已经不作数了" vs "我们暂时查不到那条依据"），
合并会让一次**数据读失败**看起来像"用户的依据真的废了"。

⚠️ **更重要的一条**：`dependency_unavailable` **只**导致 `blocked`，**绝不**导致 `cancelled`。
理由是"宁过遮不漏"在这里**不适用**：遮蔽是**读侧**动作（可逆），
`cancelled` 是**写侧**事实（append-only、不可逆）。拿一次读失败销毁一个合法目标，
等于让一次数据库抖动抹掉用户的约定。门 `D2`/`D8` 把这条顺序钉住
（根证据读不到 ⇒ `blocked`，**不**升级为 `cancel`）。

**② `GoalCancelReason` 追加 `goal_superseded`**（**关闭 `L-M10-08`**）

§4.2 规定"取消一个有 active 承诺的目标，必须在同一提案里取消该承诺"。
WP3 实现时**只**对 `GOAL_CANCELLED` 强制了这一条，对 `GOAL_SUPERSEDED` 留了白
（登记为 `L-M10-08`）。**WP5 裁定**：

```text
实质替代一个带 active 承诺的目标时，该承诺必须在同一提案里作废
（COMMITMENT_CANCELLED，reason='goal_superseded'），否则拒绝 goal_orphan_commitment。
```

**为什么不"顺延到新目标"**：承诺是对**旧对象 / 旧成功条件**答应的
（"实质替代"的定义就是对象或成功条件变了）。顺延等于在用户没有重新同意的情况下
**重新划定一个正式义务** —— 那正是 §4.2 禁止的（"采纳路径的范围不得超出原提议"、
重新约定必须显式）。新目标若需要承诺，双方**重新** `COMMITMENT_ACCEPTED`（**新身份**）。

⇒ 与"取消"走**同一条**机制（`hasPairedCommitmentCancellation`），不新增概念。
门 `W1`–`W4` 钉住：没有配对 ⇒ 拒绝；有配对 ⇒ 受理且折叠后旧承诺为 `cancelled`、
新目标 `commitment === null`（**不顺延**）。

### 4.8.3 WP6 追加的四条完成拒绝码 + 两个崩溃窗口的优先级（**判据变更记录**，2026-09-29）

**① 完成判定追加四条码**

| 新增码 | 它区分的是什么 | 若压进邻近码会怎样 |
|---|---|---|
| `completion_target_not_found` | 目标不存在 / 承诺不存在 / `target` 与实参不符 / 不属于本角色 | 压进 `completion_evidence_missing` 会让人去查"证据呢"，而问题在目标本身 |
| `completion_target_terminal` | 目标或承诺已是终态 | 终态重放是**幂等**问题（由 `processed_operations` 负责），与"证据不合格"是两件事 |
| `completion_source_not_established` | `user_report` 的证据事件归因不是 `ESTABLISHED` | 压进 `kind_mismatch` 会丢失"来源资格"这一层 —— 而它正是 §7.1 的核心判据 |
| `completion_evidence_unavailable` | 证据**读不到**（端口抛错） | 这是本层最重要的第三条事实：读不到既不是"没证据"，也**不是**"通过"（失败关闭） |

**② 两个崩溃窗口的优先级：`B` 先于 `A`**（§4.11 的补充裁定）

```text
结果已落盘 + 兑现未提交（B）  与  变更已提交 + 回复未落盘（A）  同时在场时
⇒ 先收敛 B
```

**理由**：补记是**幂等**的、**不产生新的用户可见动作**；而 A 的处置（读回并如实解释）
依赖"这一轮到底有没有真的发生"，那要等 B 收敛后才有定论。
顺序反了会先向用户解释一件尚未确定的事。

**③ 恢复时禁止做的事必须**具名**（不是"注意不要……"）**

```text
窗口 A  mustNot: ['fabricate_assistant_event']          补造 assistant 事件会把"她可能没看到"变成"她一定看到了"
窗口 B  mustNot: ['regenerate_artifact','resend_side_effect']   否则完成一次要做两遍
```

⇒ 它们是 `GoalCrashWindowVerdict.mustNot` 的**返回值**，因此可被机器断言（门 `P2`/`P4`）。

### 4.9 时间模型

- 保留**用户表达**与**解析后的绝对时间**、时区、解析依据（`dueBasis`）。
- **日期歧义要澄清**；**不得**把"明天"固定成服务器 UTC 日。
- 读取时可计算 `overdue`；**只有下次合法调用才会观察到到期**，离线期间**没有**后台行为。
- **不把 `dueAt` 映射成 scheduler**。遇到"明天主动提醒我"，明确未具备该能力；
  若用户愿意，可另设"下次来聊时继续"的目标。
- 测试用**注入时钟**，不靠真实 sleep；覆盖跨日、重启、迟到结果、时钟回退、
  `recordedAt` / `occurredAt` 不同。
- **重启后不得**因错过 `dueAt` 批量生成履约 / 违约事件。

### 4.10 多目标选择（确定性规则）

```text
① 本轮明确点名
② 本轮明确续接且唯一
③ 当前相关、有效的高优先级目标
④ 其余相关目标
同分按**稳定 ID**（goalId 升序）
```

**每轮最多**：1 个焦点 Goal · 1 个 nextStep · 至多向模型提供 **3 个**相关 Goal。
候选多于上限时**记录裁剪**（`候选 = 资格拒绝 + 合格`；`合格 = 选择排除 + 被选择`；
`被选择 = 渲染裁剪 + 最终入模`），**不把"没选中"说成"没有目标"**。

暂停 / 终态 / 受失效依赖阻挡的内容**不得**伪装成仍可执行。
**当前用户明确换话题优先于内部目标倾向**；Relationship / Affect **可影响表达，
不拥有**取消 / 建立承诺或改变授权的权力。

**两项约定冲突且无法唯一决定时，说明冲突并澄清**；不要仅按最新记录覆盖。

### 4.11 两个崩溃窗口与恢复

| 崩溃位置 | 恢复要求 |
|---|---|
| **A**：承诺已提交、回复**未**成功落盘 | 记录仍真实存在；"用户已收到确认"**未知**；**不得补造** assistant event；下一轮读回解释 |
| **B**：对话产物 / ActionResult 已落盘、兑现事件**未**提交 | 依据**持久结果引用**做幂等补记（D26）；**不得重发副作用**、不得重新生成一份产物来凑完成 |

**恢复形态**（计划 §9.3 的落成）：
- 由**下一次合法启动 / 调用**中的**有界** reconciliation 完成 —— **不新增长期后台调度**。
- 有界 = 单次调用最多处理 **32** 个待收敛项；范围由投影行里的**显式 pending 标记**决定
  —— **不扫会话历史**（这是 D23 绊线的机器判据）。
- 失败**可重试**、错误**被记录**、checkpoint 有界。

### 4.12 配置与开关

| 键 | 代码缺省 | 有界 | 消费点 |
|---|---|---|---|
| `CHARACTER_GOALS_ENABLED` | **false** | 布尔 | 授予 Goal 能力 + 构造理解器 + 注入块 + 同轮钩子（少一件都不算打开） |
| `CHARACTER_GOALS_CONTEXT_TOKENS` | **500** | 0..1000 整数 | 仅在总开关打开时喂给 `ContextBudget.goalTokens`；关闭时装配层传 **0** |

**非法值 ⇒ 失败关闭到 false + 启动告警**（与 `affectSemanticMode` 的"回到安全缺省"同款；
**不**沿用 `webSearchMode` 的 `undefined`，因为 Goal 的安全缺省**确实**是"不做任何事"）。

**必须被 `main.ts` 真的消费**（D3 的教训，有静态锁守着）。
**关闭时**：不抽取、不写入、不注入 Goal，也不追跑历史任务；旧 prompt 与行为路径保持既有基线。
**回滚** = 改回 false：已写事件与投影**保留**；不生成取消事件；
用户查询时应能如实得知"当前功能未启用"，**不得**说"我已经忘了所有约定"，也不得说"仍会自动执行"。

---

## 5. 遗忘与取消的分野（计划 §8.3 的落成）

**问题**：Goal 的 `statement` / `nextStep` / `scope` 也可能**复制** Memory 的被忘取值。
**仅移除 dependency ID 不够。**

**冻结**：
1. 对来源受遗忘控制的**派生文本**，v1 **优先整项退出普通上下文**，
   保留**不含原取值**的 blocked / cancelled 原因。
   **不让** LLM"改写一下去敏"充当机械保证。
2. **用户明确"忘掉这项目标"** 与 **"取消但保留历史"** 分开：
   - `GOAL_CANCELLED(reason='explicit_forget')` ⇒ 普通查询与上下文**无法复述内容**；
     且 payload 带 `forbiddenSourceEventIds`（**非空**）；
   - `GOAL_CANCELLED(reason='explicit_cancel')` ⇒ 历史保留，普通查询可显示"已取消"与说明；
   - `GOAL_CANCELLED(reason='user_waived')` ⇒ 用户免除一项机器可判的义务（§4.5），
     历史保留但**不得**被读成"已完成"。
   append-only 审计保留仍按既有规范说明（**审计保留 ≠ 物理擦除**）。
3. **M9.1 的遮蔽必须覆盖新增的 Goal 来源通路**：当轮事实块、重编译路径、下一轮查询。
   若既有 forget 控制事实无法覆盖 Goal，**只能**在 ADR 中追加明确语义，
   **不能**假装"取消就是遗忘"。
4. **旧根禁用不因内容再次出现而解除**（M9 的 B28 机制逐字复用）：
   新的 `create` 的 `acceptanceSourceEventId` 命中任何 `forbiddenSourceEventIds` ⇒
   拒绝 `goal_source_forbidden`。新的**独立**来源必须自己合格。
5. 读侧遮蔽的触发条件（两条，任一命中即整项退出普通上下文）：
   ① 该 Goal 的最近一次取消 `reason === 'explicit_forget'`；
   ② 该 Goal 的**任一**来源 / 依赖落在**当前**撤销集（`withdrawnSetCore` 的读数）里。

**本 ADR 不主张**："忘掉"等于物理擦除；也不主张"取消后她绝不会再提"（措辞层没有启发式守卫，
沿用 `DR-11` 的既有立场）。

---

## 6. 隐私与可观察性边界

**Trace 最小字段**（计划 §10.2）：`goal_proposal` / `goal_validation` / `goal_event` /
`goal_context` / `commitment_result` 五个具名步骤（名称服从既有 developer schema 的**追加**程序）。

**记录**：规则 / 解析器版本 · 输入来源 ID · 操作 · 目标 / 承诺 ID · 前后 revision ·
拒绝码 · 依赖 usable/dropped 数 · 候选 / 选中 / 裁剪 / **实际入模**数 ·
完成依据类型 · 关联 `actionId` / `traceId` · 耗时 · 是否调用模型及 token 读数可用性。

**trace 不含**：用户原话 · 完整目标正文 · Memory / Belief 取值 · 模型隐藏推理 · 凭据。
需要正文的人审材料落 `artifacts/m10/local/`（**私有区**，不进仓库）；仓库证据保存指纹与指针。

**开发者面**：复用既有只读 query 注入点（当前目标 / 状态历史 / 承诺依据 / 为何 blocked /
为什么没有选择 / 何种证据导致完成）。**只读查询也要执行与聊天相同的遗忘资格。**
**不新建**任意 SQL、直接编辑 Goal JSON 或"强制完成"按钮。

**计数守恒**（计划 §10.2，必须可机器校验）：

```text
候选 = 资格拒绝 + 合格
合格 = 选择排除 + 被选择
被选择 = 渲染裁剪 + 最终入模
若整个 section 被 ContextCompiler 丢弃 ⇒ 最终入模数**必须**为 0（不能拿渲染时的 ID 集充数）
```

---

## 7. 与既有契约的增量（逐条，**只追加**）

| 契约 | 增量 | 是否改变既有语义 |
|---|---|---|
| `DomainEventRegistry` | 新增 `createGoalDomainEventRegistry()`（13 个类型） | 否（独立工厂，装配层组合） |
| `ProjectionReducer` | 新增 `goal-fold@1`，投影类型 `goal:<goalId>` | 否 |
| `ContextSectionKind` | `'goals'` **已在场**（M3.5 起预留） | 否 |
| `SECTION_PRIORITY` | 不动 | 否 |
| `ContextBudget` | **追加** `goalTokens: 0` | 否（等式仍成立：800+2400+0+0+0 ≤ 6000） |
| `ContextCategory` | **追加** `'goals'` | 否 |
| `ContextSection.budgetGroup` | **不**新增取值（D27） | 否 |
| `KernelErrorKind` | 不动（拒绝码是 `code`，不是 `kind`） | 否 |
| `ProposalOperation` | **不动**（D21） | 否 |
| `TraceStepKind` | 追加 5 个具名步骤 | 否 |
| `observability.ts` | 追加 5 个步骤 → 既有分组的映射 | 否 |
| `developer-*.ts` | 追加 Goal DTO / 理由码 / 生产者表条目（按 M5.1 追加纪律） | 否 |
| 迁移链 | **不动**（D15 / D24） | 否 |
| `flags.ts` | 追加 2 个字段（§4.12） | 否 |

---

## 8. 本 ADR 不主张

1. **不主张**外部能力有任何增加：`External Capability Added = NONE`（D01）。
   Evidence 的 L1/L2 是**证据层级**；项目的 Lv1/Lv2 是**能力阶段**。M10 通过前者**不等于**后者已放行。
2. **不主张**"她不会再说错"：措辞层**没有**启发式守卫（`DR-11` 的既有立场）。
   本 ADR 买到的机械保证只到**采信 / 状态 / 拒绝码 / 入模计数**。
3. **不主张**开放中文理解完全正确：模型只产有界提案，低置信 / 含糊表达应澄清；
   隐含意图仍是**语义质量问题**，须由盲测量化（§15.3 的门槛）。
4. **不主张**长期维护型承诺已被覆盖：v1 只正式接受 §4.5 的两类可观察承诺。
5. **不主张**"忘掉"等于物理擦除：append-only 审计保留按既有规范说明。
6. **不主张** `completed` / `fulfilled` 的内容正确：`conversation_output` 的结构检查
   只证明**结构**；质量维度另由人审 / 语义评测判定。
7. **不主张**单角色之外的边界：v1 生产仍单 Character（D04）。
8. **不主张** M9.5 的语义召回收益：生产仍是 `shadow`，M10 在现状下验收（D17）。

---

## 9. 后续（本 ADR 之后的执行面）

```text
WP2  真实来源引用与只读输入（D25 的落成：goal/inputs.ts + 引用复核门）
WP3  Goal / Commitment 纯内核与持久化（D05/D15/D21/D24 的落成：契约/policy/reducer/store）
WP4  语义提案与明确请求链（D07/D19 的落成：语料 + 离线固定 provider）
WP5  依赖失效、Goal 遗忘与冲突处理（§4.6 / §5 的落成）
WP6  兑现与回复事实（§4.5 / §4.11 / D26 的落成）
WP7  Context、trace 与开发者只读面（D22 / D27 / §6 的落成）
WP8  量具自证与真实装配端到端
WP9  规模、长轨迹、重启与性能（D24 的实测）
WP10 真模型评测与真人复核
WP11 回归、正式收口与 M11 交接
WP12 生产激活与首次实际使用（**独立授权**，本 ADR 不授权）
```

**停线条件**（计划 §17，出现即停对应链路并保留现场）：
用户意图无法稳定区分于引用 / 假设却准备自动写承诺 · 把 Memory / Belief 内容或相似分数当授权 ·
不存在真实结果却可写 `fulfilled` · Goal 成为遗忘后的**新**正文来源 · 使用真实库跑实验 ·
量具空过 / 缺分母 / 坏响应被视为通过 · 为达阈值临时改标签 / 扩大期限 / 删失败 / 反复抽样挑绿 ·
生产 / 测试装配不同而没有显式证据。

---

## 10. 修订（2026-10-02）：`M10-D11` **扩类** —— 承诺判据加入 `user_report`

> 本节的**唯一**依据是用户当轮裁定。**修订前原文（§2 的 `M10-D11` 那一行）一字不改**，按 TD-16 的三列纪律只追加本节。

### 10.1 授权（逐字）

```text
M10.1（约定桥）WP2 把一条实测阻塞摆到用户面前（`U-03`）：承诺判据的闭集里**没有** `user_report`，
⇒ "明天十点二十五楼下见"这类**双方约定**（判据是"**他到没到**"，只能由对方报告）**记不下来**。
用户逐字回复：
    「(U-03-a) 扩闭集」
```

### 10.2 改了什么（**只改一处常量**）

```text
`src/kernel/policies/goal-validator.ts`：
  `COMMITMENT_ACCEPTABLE_CRITERIA` 由 `['conversation_output','action_result']`
  扩为 `['conversation_output','action_result','user_report']`。
⇒ 放行口从"只接受两类**程序可观察**承诺"变成"**三类**：两类可观察 + 一类**由对方报告**"。
```

### 10.3 语义与边界（**这一节比改动本身重要**）

```text
① 新类的准确说法是「**由对方报告结清**」，**不是**"程序观测到"。
   `judgeGoalCompletion` 的 `user_report` 分支已有两条硬要求（本次未改）：
     · 依据事件必须是**用户**发的 —— **她的输出永远不能当 user_report**；
     · 归因必须是 `ESTABLISHED`。
② **不破 `M10-D12`**（"`user_report` … **不**证明角色外部履约"）：它的作用范围因此明确为
   —— 结束的是一条**由报告结清**的约定，**不**等于"程序证实了她履约"。
   完成事件里的 `completionBasis = user_report` **如实记下这一点** ⇒ 事后可查"这条是靠报告结清的"。
③ **不破 `M10-D13`**（`fulfilled` 必须有真实结果）：`user_report` 的"真实结果"就是
   那条**已落库的用户对话事件**（有 actor 与归因资格可查），不是模型评分。
④ **不扩别的**：`action_result` 仍需真实执行成功；`conversation_output` 仍需结构检查通过。
```

### 10.4 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 新造一个判据类（如 `counterparty_report`） | `user_report` **已经存在**、**已经有配套判定**（上述两条硬要求），且 `completionBasis` 已经能把"靠报告结清"如实记下 ⇒ 新造一个只会多一份要维护的语义 |
| 把约定记成**目标**（`successCriterion: user_report`）而不是承诺 | 目标允许 `user_report`（既有），但**承诺**才是"她的承担"；R-26 要的是"**这件事有个可结清的承担**"，只记目标会丢掉承担语义 |
| 保持闭集不变，只做目标层 | 就是 `U-03-b`：会让"楼下见"这类永远无法成为可结清的承担（用户已否决） |

### 10.5 前后读数（**判据变更纪律**）

```text
① `m10:test` 的 **X15** 逐字断言"v1 不接受 user_report 类型的承诺" ⇒ 改闭集后它**当场变红（57/58）**。
   处置：按新语义**改写 X15**（改为"被接受"断言）+ **新增 X15b**（未知判据类仍被拒）。
   读数：**59/59 PASS**（改写前该文件 58 项，改写后 59 项）。
   ⚠️ 旧读数（58/58 且 X15 期望拒绝）作为**修订前**读数保留在 M10 的历史证据里，**不回写**。
② 新门 `m10.1:policy:verify` 的 **P4**：**前** = "user_report 被判据闭集拒绝"；
   **后** = "user_report 被接受（事件里 `criterion.kind=user_report`）"；并新增 **P4b**
   （未知判据类仍被拒）⇒ **10/10 PASS**。
③ 其余 M10 门**逐项不变**（见 `docs/m10.1/M10.1-WP2-Handoff.md` §6）。
```

### 10.6 一处**附带的工程事实**（值得记下来）

```text
扩类之后，**三个合法判据类全都在闭集内** ⇒ `goal-validator.ts` 里那条
`commitment_criterion_unacceptable` 分支**正常载荷到不了**了（契约层的判据校验会先拦下未知类，
报 `goal_proposal_invalid_shape`）。它现在是**纵深防御**：留着，但**不要**再拿它当"闭集在起作用"
的证据 —— 真正在起作用的是契约层的判据校验 + 这条兜底。
```
