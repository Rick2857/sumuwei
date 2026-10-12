# ADR-064：M7 Relationship —— 关系状态演化的语义契约

- **状态**：**ACCEPTED / DESIGN FROZEN**（2026-09-26 用户裁定：「按推荐执行」——
  U-M7-01…07 全部按推荐项通过；见 [`M7-Unresolved-Decisions.md`](../m7/M7-Unresolved-Decisions.md) 的裁定记录）
- **日期**：2026-09-26（草案）/ 2026-09-26（冻结）
- **里程碑**：M7 Relationship（计划：[`docs/m7/M7-Execution-Plan.md`](../m7/M7-Execution-Plan.md)）
- **前置**：M6.1 = PASS · M6-FMB-01 = CLOSED · M7-WP0 = 基线落盘 + 准入实验 9/9
- **实现归属**：M7 WP2（合同）–WP5（接线）；本 ADR 只冻结**语义**，不实现任何 store
- **冻结后变更程序**：语义变更需新 ADR + 用户裁定；实现层发现语义缺口时先回本 ADR 记录，
  不在代码里临时改语义（计划 §5 WP1 出口条件）
- **仍待二次裁定**：附录 A（规则提案器的冻结规则集）——D-4 选了 (C)，规则集在 WP3 前
  由用户逐条裁定后冻结；在此之前不得实现任何具体规则

---

## 0. 背景与要回答的问题

M7 的主目标是原始 Lv1 的 **O-2「状态演化影响行为」**（README:50 并入 M7）。链路（计划 §0）：

```text
真实互动证据 → RelationshipImpactProposal → Validator/Policy → DomainEvent
             → Reducer/Projection → RelationshipState(owner→target) → ContextCompiler → 用户可见行为
```

本 ADR 要冻结的语义：**关系键与作用域（D-1）· 状态维度与初始基线（D-2）· 证据等级（D-3）·
提案机制（D-4）· 时间语义（D-5）· 行为接线（D-6）· 认知完整性（D-7）· 允许/禁止主张（D-8）**。

既有约束（本 ADR 不重开，只引用）：

| 约束 | 载体 | 对 M7 的直接含义 |
|---|---|---|
| 关系键必须是 `owner → target`，不许 `userTrust` | FC-05 · ADR-018 · `entity.ts` 的 `EntityRelationKey` | D-1 只能照这个形状写 |
| 投影 = 事件折叠；reducer 纯函数、版本化、可重放；作用域编进 projectionType | ADR-003 · `projection-model.md` | D-2/D-5 的状态只能是投影；衰减不进 reducer |
| Processor 是唯一允许调 LLM 的地方；只有用户证据能触发变化 | `processor-model.md` | D-3/D-4 的形状 |
| No Cognitive State Without Provenance；修改人物关系认知 = Cognitive Intervention | `cognitive-integrity.md` §1/§4A · INV-CI-01…05 | D-7 全链 |
| 她的生成不自动成为事实/共同经历 | Assistant Fact Firewall · `source-provenance.md` | D-3 的负控面 |
| 措辞层无启发式守卫；机械保证只到采信/排序/标签 | DR-11（M5.1.1） | D-8 的表述纪律 |
| 关系证据 = 直接互动事件；纠正 = 域事件 supersede；区间读界显式可分页 | M7-WP0 准入实验（9/9） | D-3/D-4 的输入面 |

---

## 1. D-1 关系键与作用域

**提案**：

```ts
// 键（审计与领域事件的载荷里带全量）
interface RelationshipKeyPayload { owner: EntityRef; target: EntityRef }   // owner.kind === 'character'

// 投影作用域：projection-model.md 的约定 —— 作用域编进 projectionType
// 唯一性仍由 (characterId, projectionType) 承担；characterId 即 owner（视角拥有者）
projectionType = `relationship:${target.kind}:${target.id}`
// 第一阶段唯一实例：relationship:user:<userId>（苏沐薇 → 用户）
```

- 类型上**不**把 user 写死（FC-05）：`EntityRelationKey` 的形状使"苏沐薇 → 角色 B"未来可直接写。
- `owner.kind` 恒为 `'character'`（M7 只有她一个视角拥有者；M9 Belief 复用同一约定）。
- **被否决**：`RelationshipState { userTrust }`（FC-05 明令禁止）；给投影加旁路 scope 列
 （projection-model.md：会破坏"一角色一投影一行"不带条件的不变量）。

## 2. D-2 状态维度、界与初始基线

**提案**：

```text
维度    trust ∈ [0,1] · closeness ∈ [0,1]（刻意分开：很熟但刚吵过架 ≠ 不可信但亲近）
       valence/arousal 不进 M7（M8 Affect 的变量，不提前做）
单轮界  每条被放行的影响事件，其 delta 由 Validator 夹到：
       |Δtrust| ≤ 0.05 · |Δcloseness| ≤ 0.03（沿用 src/state/types.ts 既有语义：关系是慢变量）
审计字段 revision · reducerVersion · lastDomainEventId/Sequence · updatedAt（投影契约既有形状）
```

**初始基线（已裁定 (a)）**：新关系投影的初始值**必须带来源**（计划 §6 场景 1"默认值有来源"）。候选：

- **(a) ORIGIN 事件携带用户授权基线**：一条 `RELATIONSHIP_ORIGIN` 域事件，
  `trust=0.85 · closeness=0.60`（角色设定：十几年共同长大的信赖；不拉满 closeness 留演化空间），
  来源 = 用户 2026-09 授权的角色设定（`originKind = SETTING_BASELINE`，非互动推导）。
  优点：与既有 INITIAL_STATE 语义连续、来源诚实（是设定不是经历）、可审计。
- (b) 中性 0.5/0.5 起步，靠互动长出来。代价：与角色设定（十几年青梅竹马级信赖）矛盾，
  她对"认识十几年的人"表现得像陌生人。
- (c) 从 legacy `CharacterState` 当前值迁移。代价：legacy 值本身没有事件级来源（M1/M2 快照），
  迁移 = 把无来源数字洗进有来源体系 —— 违反 No Cognitive State Without Provenance 的精神。

**WP2 合同期澄清（"夹到"的准确含义）**：D-2 原文"delta 由 Validator 夹到"细化为**两层各司其职**：

```text
① Validator 对超界 delta 直接拒绝（relationship_delta_out_of_bounds）——
   计划 §3.1.5"单轮上限必须是程序判据" + §9.1"超界必须被程序拒绝"；
   静默夹到上限会让提案器的 bug 不可见（失败关闭优先）。
② reducer 折叠时把结果夹回 [0,1]（clampRelationshipValue）——防御纵深：
   即使一条非法事件混过放行口，状态也不会越出定义域。
放行的 delta 必然在 ±0.05 / ±0.03 内；"拒绝"与"兜底夹取"不冲突。
```

## 3. D-3 证据等级（什么能推动关系变化）

**提案**（失败关闭；负控面即 Assistant Fact Firewall）：

```text
Tier 1（可推动）  用户直接互动事件（user_message 族），且归因资格 = confirmed
                  （M5.1.1 的 epistemic_source 已确立分支：USER_EXPLICIT / USER_REPLY_CONFIRMATION）
Tier 0（永不推动） 她自己的生成（assistant_message）· 工具/系统事件 · 外部证据 · 摘要文本
                  · unconfirmed/unknown 归因 · 维护注入 · 任何"看起来像"的文本
```

- WP0 准入约束①照抄进契约：**关系证据 = 直接互动事件（事件区间读），记忆检索候选集永不作为关系证据**。
- "用户长时间没说话"不是事件：它由 D-5 的读时衰减表达，不产生域事件。
- **被否决**：把她的回复当关系证据（铁律 6）；把记忆记录当证据（走 recall 就受 50 截断，
  且记忆是派生视图不是互动本身）。

## 4. D-4 提案机制（谁提出 delta）

**提案（已裁定 (C)：A 先行 + 接口按 CharacterProcessor 预留 B）**：

- **(A) 确定性规则提案器（推荐 M7 首版）**：Slow Path Processor，输入 = 事件区间
  （水位推进的闭区间，分页遍历），规则**冻结在本 ADR 附录**（例：显式关系表态、
  承诺-兑现/失信的可程序判别形态、持续陪伴的累积项），输出 = 有界 delta 提案。
  优点：可重放、可审计、负控精确、零模型成本、与 M6.1 的"量具先于实现"纪律天然兼容。
- (B) LLM relationship-evaluator（processor-model.md 预留的名字）：语义覆盖面宽，
  但提案器自身需要 M6.1 式的量具有效性验证（否则"模型提案漂移"不可测）。
- (C) 混合：A 先行，B 作为后续扩展（M7.1 或 M8 前置），接口按 `CharacterProcessor` 预留。

无论选哪个：**模型/规则只能提案，Authority 在 Validator/Policy**（计划 §9.1）；
提案幂等（同区间重跑 = 安静成功）；空提案是正常结论。

## 5. D-5 时间语义（衰减）

**提案**：

```text
投影（事件折叠）只含互动驱动的影响；挂钟衰减在读时惰性结算：
  effectiveState = decay(projection, now)   —— 纯函数，两层都可解释、可重放
  · 超过 24h 无互动：closeness 每天侵蚀 0.02（absenceThreshold 24h · lossPerDay 0.02）
  · trust 不随时间变化（疏远 ≠ 失信；失信走事件通道）
  · 衰减不可逆：回来不自动回弹，靠真实互动重新累积
语义来源：src/state/decay.ts 既有契约（M1/M2 已验收），M7 把它接进投影读路径
```

- **衰减不进 reducer、不产生域事件**（ADR-003 否决过"reducer 读时间"；重放将失效）。
- 衰减结果**不回写**投影（投影仍是纯事件折叠；衰减是读时视图）——
  与 legacy 的惰性结算同构，但 M7 明确"投影本体"与"有效状态"两层分离。
- "她想你"（长时间分开的行为表达）= D-6 的上下文渲染，不是状态变更。

### 5.1 WP2 合同期澄清（2026-09-26；实现前记录，非实现后追认）

写合同时发现 D-5 原文有一处**内在张力**，按本 ADR 的变更程序先记录再实现：

**缺口**：若衰减是纯读时视图、且锚点随互动重置，则"回来聊天"会让锚点跳到当前，
累积的侵蚀**全部消失**——这违反裁定的"衰减不可逆"（计划 §6 场景 5
"回归后不自动恢复全部关系"）。不可逆性要求侵蚀**结算进基线**；
而唯一重放安全的结算位置是**纯事件折叠内部**（用事件自身的时间戳，不读挂钟——
ADR-003 禁的是挂钟，不是事件数据）。

**澄清后的机制**（四条裁定性质 24h / 0.02 / trust 恒定 / 不可逆 **逐字保留**）：

```text
① RelationshipState.lastInteractionAt = 衰减锚，由 reducer 从**事件时间戳**折叠（纯）。
② reducer 折叠 RELATIONSHIP_IMPACT 时，先结算「上一锚点 → 本事件时间」之间的历史侵蚀
   （erodeClosenessForAbsence，输入全部来自事件数据），再应用有界 delta，再推进锚点。
   ⇒ 侵蚀成为基线的一部分：回来后的第一条影响事件不会让历史疏远消失。
③ 读时视图 effectiveRelationship(state, now) 只结算「当前疏远」（锚点 → 挂钟），不回写。
   "衰减不回写投影"指的是**读路径不写**；折叠内的结算本来就是事件折叠的一部分。
④ "无互动"的计量单位 = 无**关系证据事件**（不是无消息）：
   日常闲聊若不触发任何冻结规则，锚点不前进——这是满足场景 5 的唯一读法。
   相应地，规则集（附录 A）必须包含日常陪伴的累积规则，让真实互动持续推动锚点与
   closeness；若规则长期不触发导致活跃聊天仍被侵蚀，那是 WP3 规则集的校准缺陷，
   不是本契约的语义缺陷。
```

"衰减不进 reducer"的准确含义由此修正为：**reducer 不读挂钟**（ADR-003 的原意）；
事件间结算逻辑位于纯折叠内，重放 A==B 不受影响。

### 5.2 WP4 合同期澄清（2026-09-26；实现期记录，部件门 20/20 验证）

实现 Validator / Reducer 时发现三处需要把冻结语义落到**可执行形状**的澄清，
按变更程序记录（不改变任何已裁定性质）：

**① 撤回反扣（"supersede 后旧事件不再驱动投影"的字面实现）**。
§9 验证表要求"supersede 后旧事件不再驱动投影"。它的可执行读法：
撤回形（R-4b）折叠时，**反向扣除**被撤回指控（R-3 事件）的 delta，
再应用自己的 {+0.03, 0} ⇒ 净效果 = 指控前 trust + 0.03
（部件门 P5b：0.82 −(−0.05) +0.03 = **0.90**，不是 0.82+0.03=0.85）。
修复形（R-4a）无撤回链，纯叠加 ⇒ 净效果 = 指控后 + 0.03。
两种形态的差（0.05）正是"误会"与"原谅"的语义差——
这也是附录 A 同时保留 (a)/(b) 两形的原因。被撤回事件**不物理删除**（审计链留痕）。

**② `RelationshipState` 增补 `accusationsInCase`（在案指控登记表）**。
①的反扣需要知道被撤回指控的 delta；R-4 的触发前置（"R-3 在案"）与
防双撤回也需要同一份事实。一个字段服务三处，单一事实源：
reducer 折叠 R-3 时登记（eventId + delta + 折叠时间），撤回时移除并反扣；
Validator 的在案检查读它；Job 构建评估器输入（activeAccusations，**按目标键控**）
读它。登记表有界：条目数 ≤ 在案指控数（撤回即移除）。

**③ `RelationshipImpactPayload` 增补必填 `unit`（幂等单元）**。
幂等键必须**从事件自身可推导**（审计自包含："这条事件为什么得到这个键"）
⇒ 判别分量 `${operation}:${ruleId}:${unit}` 的 unit 进 payload：
r1 = 自然日 ISO（UTC+8，`relationshipDayOf`）· r2/r3/r4 = 'window' ·
r5 = 里程碑标签（messages-\<n\> / days-\<n\>）。
range 分量两种刻意形态：**r1 与 ORIGIN 置零**（r1 的幂等身份是
`(character, processor, version, rule, 自然日)`——跨窗口同日必然撞键，
"同一天最多计一次"的机器保证；ORIGIN 一次建档同理）；
r2–r5 保留区间（同窗口重复处理 = 正常幂等命中）。
与 memory 的"区间进键"方向相反但各有其理：那边是 supersede 批次语义，
这边是日上限 / 一次建档语义。

## 6. D-6 行为接线（状态如何影响行为）

**提案**：

```text
单一注入块：ContextCompiler 的 relationship 区段（预留优先级带 44–55 内取值）
  内容 = (trust, closeness, absenceHours) 的确定性映射 → 行为指导文本（分档措辞）
  · 只渲染当前状态与表达方式，不叙述事件、不补造共同经历
  · 注入块由程序生成（与 external-evidence 附录同一纪律：正文自造引用一律剥离）
旧状态桥：M7 投影成为 trust/closeness 的唯一权威；legacy CHARACTER_STATE provider
  改为从投影读（桥接）或退役 —— 影响半径审查归 WP2/WP5，不允许双权威
prompt 纪律：区段新增 = 有意 prompt 变更 ⇒ m3.5 基线重刷 + 全套 prompt 门 + Live Smoke
```

**WP5 落地记录（2026-09-26，部件门 14/14 验证）**：

```text
· 桥接取**退役**形：开关打开时 legacy 状态块不再渲染 trust/closeness（只剩
  情绪，归 M8），关系轴由 relationship section（priority 55 = M3 契约预留值）
  唯一渲染；联合行为规则的 L1-M2 验收措辞**逐字移植**到契约层
  renderRelationshipGuidance（换一套等于改掉已验收行为）。
· 影响半径审查结论：legacy 关系轴无每轮写者（只有 bootstrap 建档 + 读时衰减
  结算），退役无僵尸写者；legacy 衰减与 M7 侵蚀同参数（24h 阈值 / 0.02 每天 /
  trust 恒定），初始值同源（0.85/0.60）——值兼容，切换无跳变。
· 生产激活走 CHARACTER_RELATIONSHIP_CONTEXT_ENABLED（缺省 off，先例 ADR-048
  "接线就位、激活另裁"）；开关关闭 = M6.1 形态逐字不变（回滚形态，N3 验证）。
· prompt 纪律的落地形态：基线构造器与合成轮次**不传**关系渲染器 ⇒ 0 个
  section ⇒ M3.5 基线逐字节不变（m3.5:test 30/0 实测；与 clock / stateSection /
  rollup 同一注入纪律——"区段新增 = 基线重刷"的前提是区段进基线，这里没有）。
  生产 prompt 的真实变化由 WP5 门（装配一致）+ WP6 Live Smoke 验证。
· ORIGIN 播种：启动时经完整放行链（提案 → Validator → applyAcceptedEvents）
  幂等建档（U-M7-02 授权基线）；干跑（--test）不播种（写副作用归真实模式）。
```

## 7. D-7 认知完整性（Privileged Cognitive Operation）

关系认知在 `cognitive-integrity.md` §4A 的清单里（"修改人物关系认知"）。M7 的立场：

```text
正常路径（M7 交付）   互动事件 → 提案器 → Validator/Policy → 域事件 → 投影
                     —— 这就是关系认知的合法 Lifecycle；全程带 traceId 与账本
注入路径（预留不实现） 任何开发者/管理员直接改关系状态 = Cognitive Intervention：
                     显式警告 · dry-run 预览 · 操作者身份 · 审计 · 不得被解释为她的经历
                     M7 不建注入 UI；但域事件的 originKind 必须能区分
                     SETTING_BASELINE / INTERACTION_DERIVED /（未来的）MAINTENANCE_INJECTION
                     —— 让"未来若注入，来源可判"从第一天就成立
INV-CI 对照          ①有来源 ②受控不静默 ③不绕过 lifecycle ④操作者可审计 ⑤审查前置
```

## 8. D-8 允许 / 禁止的主张

```text
允许（且仅在 M7 Gates + 全量回归 + 真人复核后）：
  M7 Relationship = PASS · Original Lv1 O-2 = SATISFIED（按计划范围）
  关系状态变化可追溯、可重放、可审计，并影响用户可见行为
禁止顺带主张：
  她"再也不会编造" · 长程记忆已稳定 · M8 情绪已完成 · Level 2 能力已接入
  · 后台自主任务已实现 · 外部事实逐句可验证
表述纪律（DR-11 同源）：措辞层不加启发式守卫；机械保证只到
  证据采信 / 提案放行 / 投影折叠 / prompt 标签。
```

---

## 9. 后果与验证

**正面**：O-2 有了可审计的实现路径；M8–M11 复用同一 owner/provenance/重放骨架；
衰减与投影两层分离使"她为什么是现在这样"永远可回答。

**代价**：prompt 基线必须重刷（区段新增）；legacy 状态需要桥接审查；
规则提案器的规则集需要逐条负控（WP3/WP4 的量具面）。

**怎么验证这条决策还成立（WP2 起接线）**：

| 检查 | 由谁守 |
|---|---|
| `EntityRelationKey` 形状；`src/**` 无 `userTrust` 类硬编码 | WP2 静态检查（FC-T 同款） |
| 只有 confirmed 用户事件能产生被放行的影响提案 | WP3 正控 + 负控（她的生成/工具/摘要 = 0 变化） |
| delta 夹界 · supersede 后旧事件不再驱动投影 · 乱序/重复失败关闭 | WP4 部件门 |
| 删投影 → rebuild → 逐字段一致；reducer 版本不一致拒绝 | kernel:test 投影组 |
| 关系区段单块注入 · 正文无自造引用 · 基线重刷走全套门 | WP5 + m3.5 门 |
| 真实链路 Level 1/Level 2 逐项一致 · 重启恢复 | WP6 Live |

---

## 附录 A：规则提案器的冻结规则集（2026-09-26 用户裁定「按提案执行」）

> 裁定载体：[`M7-Rule-Set-Proposal.md`](../m7/M7-Rule-Set-Proposal.md)（表决单与影响分析逐字保留）。
> 硬顺序（M6-FMB-01 §3 同款）：**语义类规则（R-2/R-3/R-4）的模式清单必须先过
> WP3 精度探针（≥90%）才冻结**；探针不达标 ⇒ 缩清单重跑，不放宽判据。
> R-1/R-5 是节奏类规则（零语义依赖），随 WP3 实现直接以部件测试验证。

```text
R-1 日常陪伴累积   窗口内 ≥10 条 ESTABLISHED 用户消息 · 跨 ≥2 自然日 · 无 R-3 命中
                  → closeness +0.02（每日最多 1 单元）
R-2 显式正反馈     冻结模式清单（感谢/信任表述）→ trust +0.02 · closeness +0.02
                  【精度探针 ≥90% 前置；同窗口多次命中只计一次】
R-3 显式负面事件   冻结模式清单（欺骗/背叛指控）→ trust −0.05 · closeness −0.02
                  【closeness 刻意不清零（场景 3）；清单最保守；命中窗口停计 R-1】
R-4 更正与修复     (a) R-3 在案后的明确修复 → trust +0.03（部分恢复，不满血）
                  (b) 明确撤回指控 → 同 (a) 且 payload.supersedes 指向被撤回的 R-3 事件
                  【无 R-3 在案不触发；supersedes 指向非 IMPACT → 校验拒绝】
R-5 长程陪伴里程碑 累计合格消息跨里程碑（每 100 条 / 每 30 活跃日，先到先计）
                  → closeness +0.03（里程碑幂等；计数从账本派生）

明确不做（如实登记）：失约检测（承诺-兑现需要语义理解，留给未来 LLM evaluator 位）；
情绪联动（M8）；关系事件写记忆（关系不是记忆）。
```

规则集变更程序：改任何一条规则（阈值/delta/模式）= 回本附录 + 用户裁定；
探针缩清单属于「收紧」，记录探针读数后可直接生效（收紧不会放宽放行面）。
