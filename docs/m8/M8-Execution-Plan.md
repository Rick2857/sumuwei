# M8 Affect —— 情绪状态演化执行计划书

> 文档状态：PLAN READY / IMPLEMENTATION NOT STARTED
>
> 编制日期：2026-09-26
>
> 适用工作区：C:\Users\user\Desktop\project LG
>
> 本计划是 M8 的执行基线，不是生产激活授权。实现、验收、真实生产激活、真实库操作、合并与打标签仍须分别满足各自的授权边界。

---

## 0. 执行摘要

M8 的目标不是“让她看起来更有情绪”，而是把现有的情绪数值和行为映射，收口成一条可审计、可重放、可降级的 Affect Domain 链路：

~~~text
可信的用户交互
  → 情绪资格判定
  → Affect Evaluator 生成提案
  → Affect Validator 放行或拒绝
  → AFFECT_DOMAIN_EVENT
  → Affect Reducer / Projection
  → read-time decay
  → Affect Context Section
  → 本轮回复
~~~

M8 要关闭的是下面这个当前缺口：

~~~text
已有：valence / arousal 的持久字段、时间衰减、数值到行为的确定性映射、
      Processor 架构预留、Affect Context Section 的上下文位置预留。

缺少：真实用户交互如何形成情绪提案、提案如何被验证、事件如何进入投影、
      投影如何进入 prompt、失败如何降级、重复/重启/衰减如何证明、
      生产激活如何回滚。
~~~

M8 不承诺以下事项：

- 不承诺人类级别的情绪理解。
- 不承诺独立识别人类用户的真实情绪、心理状态或意图。
- 不承诺覆盖所有自然语言表达；M8 v1 只接受一组冻结、可测量的高置信交互规则。
- 不承诺解决 M6.1 的假记忆边界，也不把情绪状态自动提升为长期记忆、外部事实、信念、目标或世界状态。
- 不引入新的外部服务、桌面控制、后台自主任务、网络能力或通用 MCP 适配器。
- 不把助手自己的上一轮回复、工具输出、外部证据或测试注入内容当作用户情绪证据。
- 不因为 M8 通过，就声称“她不会再说错”或“她真正感受到了什么”。

### 0.1 当前最重要的结论

1. **M7 是 M8 的直接前置条件，当前 M7 已完成并已执行生产激活。** M7 的关系状态仍由 ADR-064 的规则与 ADR-065 的激活记录约束；M8 不重新设计关系轴，也不改写 M7 的历史结论。
2. **情绪属于 Character，而不是 Conversation。** M8 采用 affect:character 作为 canonical projection；不创建 affect:<conversation> 作为第二套情绪真相。
3. **M8 v1 采用“确定性规则优先、语义模型后置”的策略。** 先把证据、资格、提案、验证、事件、投影和回复链路做成可验证的机械闭环；不把一个不可重现的情绪分类器放在核心闭环里。
4. **M8 v1 默认不重放历史全部对话来塑造当前情绪。** 激活时以明确的 AFFECT_ORIGIN 建立中性起点，从切换点之后消费新的、合格的用户交互。若要导入历史，必须另立维护/迁移契约，不得把导入伪装成她当时亲历的情绪事件。
5. **M8 生产开关默认关闭。** 先完成离线、隔离库、真实 TurnGateway、Live Smoke、长轨迹和人工盲审；生产激活必须以单独 ADR 和用户明确授权为准。

### 0.2 推荐的 M8 判定口径

最终判定必须分列，不合成一个“情绪准确率”：

| 维度 | 目标判定 |
|---|---|
| 设计批准 | ADR-066 ACCEPTED / DESIGN FROZEN |
| 实现 | Affect 合同、提案、验证、事件、投影、上下文、调度和回滚路径完成 |
| 机械硬门 | 全部必选门 PASS，未运行 0，未通过 0 |
| 语义测量 | 在冻结的 M8 场景集上通过；报告同时列出误触发和漏检，不只报命中率 |
| Level 1 | 真实 TurnGateway 中可观察到情绪对回复行为的影响，并且没有伪造来源/感受声明 |
| Level 2 | 事件、提案、拒绝、trace、watermark、投影和回复事实可读回 |
| 人工盲审 | 按“是否符合程序事实”审，不按“像不像人类情绪”审 |
| 生产激活 | 独立于 M8 通过；由 ADR-067 或后续激活记录裁定 |

---

## 1. 依据、状态快照与适用边界

### 1.1 本计划使用的依据

本计划综合了三类材料：仓库中的权威架构/里程碑文档、当前项目文件夹里的实现和证据、以及其他 Codex/网页版对话中已经形成的 M8 共识。优先级如下：

1. docs/architecture/invariants.md、docs/architecture/cognitive-integrity.md、docs/architecture/future-compatibility.md、docs/architecture/processor-model.md、docs/architecture/projection-model.md。
2. M6.5 的预 Level-2 路线与 M7 的验收/激活材料。
3. 当前实现中的类型、状态、上下文编译、装配和运行时行为。
4. 其他对话中的设计草案；草案只能形成待裁定项，不能覆盖已经冻结的架构不变量。

### 1.2 当前仓库快照

本轮读取到的工作区事实：

| 项目 | 当前事实 | 对 M8 的影响 |
|---|---|---|
| 当前分支 | feature/m7-relationship | M8 计划以当前项目状态为基线，不假设另有干净分支 |
| 当前 HEAD | a820808 | 计划书记录编制时快照；实现时必须重新记录实际基线 |
| m7-complete | 指向 c8afc59 | M7 标签早于其后文档/TD-06 修订；M8 应以最新权威报告和后续 ADR 为准 |
| main | 与当前 HEAD 同指 a820808 | 当前没有假设 M8 已经独立分支化 |
| 工作树 | 存在大量既有修改和未跟踪证据/文档 | 不得清理、覆盖或借 M8 顺手整理 |
| M7 生产开关 | CHARACTER_RELATIONSHIP_CONTEXT_ENABLED=true | M7 仍保持开启；M8 必须与关系 section 共存 |
| M8 生产开关 | 当前没有正式开关 | 计划新增代码默认值必须为 false |
| 数据库 | M7 使用通用 character_projections、character_domain_events、processed_operations | M8 优先复用通用持久化形状，避免新增迁移；如确需迁移，立即停在设计门 |
| 真实库 | 受 INC-01 租约、快照、pre-open token 和 incident hold 约束 | M8 的离线和 Live Smoke 使用隔离库/生产副本；不得直接打开真实库做实验 |

### 1.3 M7 文档状态漂移的处理

M7 的部分文档顶部保留了早期“Live Smoke 未运行/尚未激活”的历史文字，而后续修订章节、M7-Gate-Decision 的最新修订、ADR-065 已记录 M7 的后续通过和生产激活。执行 M8 时采用以下读取规则：

- 以文档中明确标注的最新 revision、ADR-065 和最终报告为当前事实。
- 不直接改写 M7 冻结文档来“统一措辞”。
- 如果 M8 的门脚本读取到旧段落，先修正门的事实选择/证据索引，不用 M8 代码绕过旧判据。
- M8 的报告必须把“历史读数”和“当前读数”分栏，不能把旧失败与新通过合成为单一数字。

---

## 2. M8 的成功定义与非目标

### 2.1 成功定义

M8 只有在下列事实同时成立时，才可以进入最终收口：

1. Affect 的 canonical 状态是 Character 级别、可重放的投影，而不是旧 src/state 表的直接写入结果。
2. 合格的用户交互可以产生唯一、可审计、可幂等的 Affect Proposal。
3. 所有 Proposal 经过唯一 Validator；拒绝是显式的、fail-closed 的，不能静默写状态。
4. 被接受的 proposal 只通过 AFFECT_ORIGIN、AFFECT_TOUCH、AFFECT_IMPACT 等登记事件改变投影。
5. Reducer 是纯函数；删掉 projection 后能够从事件重放得到逐字段一致的结果。
6. 时间衰减是纯的 read-time/effective-state 计算，不在读取 prompt 时写库。
7. Affect Context Section 以 priority 52 插入 ContextCompiler，并且在 M8 开启时成为情绪表达的唯一 prompt 来源。
8. 当前回复能看到本轮已成功提交的 affect 结果；如果 affect 处理失败，回复仍然可以发送，但不能使用“情绪已改变”的成功口吻。
9. 重复事件、重启、失败重试、无变化触碰、时间衰减、错误来源、错误用户和关系并存均有正控/负控/恢复证据。
10. 所有真实链路证据均来自隔离库或已验证的生产副本；真实生产库树摘要前后逐字相同。

### 2.2 明确非目标

| 非目标 | 处理方式 |
|---|---|
| 用户情绪识别 | M8 v1 不做；用户情绪不是 Character Affect 的直接证据 |
| 多角色/多用户情绪分离 | M8 v1 保持当前单 Character、单 active user 生产边界；多用户先 fail-closed |
| 历史全量情绪重建 | 默认不做；历史导入另立维护契约 |
| LLM 情绪评估核心链路 | 不作为 M8 v1 必需项；接口可预留，接入需独立测量和批准 |
| 复杂心理模型 | 不做人格障碍、诊断、治疗、意识或主观体验主张 |
| 关系轴重写 | 不做；M7 的 trust/closeness/owner→target 继续独立存在 |
| 长期记忆写入 | Affect event 不自动进入 Memory Kernel |
| 外部事实/世界状态 | Affect event 只能表达 Character 内部派生状态，不能成为外部事实 |
| 桌面/网络/应用操作 | 能力影响矩阵明确为 NONE |
| 自动生产激活 | 不随 M8 gates 自动发生 |

---

## 3. 设计不变量

### 3.1 所有权不变量：Affect 属于 Character

M8 的状态键固定为：

~~~text
projectionType = affect:character
characterId    = <唯一 Character>
~~~

不允许创建以下第二权威：

~~~text
affect:<conversationId>
affect:<userId>
affect:<messageId>
~~~

原因：M8 需要表达“她当前处于什么情绪基线/激活程度”，而不是把每段对话当成独立情绪实体。对话、用户和消息只能作为来源、资格和审计引用。

### 3.2 证据不变量：只有合格用户交互能形成 Affect 影响

M8 v1 的资格条件：

~~~text
sourceKind = user_message
originator = Known(USER)
sourceQualification = ESTABLISHED
activeUser = configured single active user
event is not replayed/duplicated
event is inside the M8 cutover boundary
~~~

以下来源一律不得产生 Affect Impact：

- assistant message；
- tool output；
- external evidence/search result；
- unknown/contradicted origin；
- 测试注入但未明确标记为 test-only 的内容；
- 其他 Character 的事件；
- 仅由时间经过推断的“用户情绪”；
- 旧状态字段本身。

### 3.3 事件不变量：提案不是事实

~~~text
Observation / source event ≠ Proposal ≠ Domain Event ≠ Projection ≠ external fact
~~~

具体要求：

- Evaluator 只能产生 proposal，不能直接调用 repository 写状态。
- Validator 以整个 proposal 为单位接受或拒绝；任何字段越界、来源不合格、版本不匹配、目标错误或 delta 超限都拒绝整项。
- Domain Event 只记录程序已经接受的内部状态转移，不记录“用户真实感受”或“她真的感受到了什么”。
- Projection 只反映事件；不得在 reducer 中调用 LLM、网络、时间、随机数或数据库。
- 回复正文不能把内部事件自动写成外部事实，也不能凭事件生成“我知道你真正的情绪”等越权主张。

### 3.4 提案不变量：每次交互最多一个主导 Affect Impact

M8 v1 建议采用“一次用户事件最多一个主导情绪影响”的规则：

- 同一 sourceEventId 可以产生一个 AFFECT_TOUCH 和一个 AFFECT_IMPACT。
- 只有一个主导 ruleId 能改变 valence/arousal。
- 规则冲突时按冻结的优先级选择一条；不做多规则叠加。
- 同一 sourceEventId + evaluatorVersion + ruleId 的 proposal 必须幂等。
- 若无法确定主导规则，产生 touch 或 no-op，不猜测。

### 3.5 变化不变量：受限、可解释、可回放

每次 Affect Impact 的变化必须满足：

~~~text
newValence = clamp(oldValence + deltaValence, -1, +1)
newArousal = clamp(oldArousal + deltaArousal,  0,  1)
abs(deltaValence) <= MAX_AFFECT_DELTA_PER_EVENT
abs(deltaArousal) <= MAX_AFFECT_DELTA_PER_EVENT
~~~

每个影响都必须能回到：

~~~text
sourceEventId → source qualification → ruleId/ruleVersion
→ proposalId → validation result → domainEventId → projection revision
→ traceId / ledger reference
~~~

### 3.6 衰减不变量：时间不是新的情绪证据

推荐沿用当前已存在的时间模型作为 M8 v1 的初始参数：

| 轴 | 初始方向 | 当前代码中的参考参数 | M8 处理 |
|---|---|---:|---|
| valence | 向 0 衰减 | 半衰期约 4 小时 | 进入 effectiveAffect，参数在 ADR-066 冻结 |
| arousal | 向 0 衰减 | 半衰期约 5 小时 | 进入 effectiveAffect，参数在 ADR-066 冻结 |
| touch anchor | 由合格交互刷新 | 当前 lastInteractionAt 语义 | 由 AFFECT_TOUCH 或 impact 事件刷新 |

衰减要求：

- 读取 prompt 时只计算 effective state，不写入一个“衰减事件”。
- 减少 arousal/valence 不是用户新说了什么，不能伪造 source event。
- 真实事件到达时，先把旧 anchor 以事件时间折算到有效状态，再应用新 delta，再写入新 anchor。
- 重放必须使用事件时间和明确的 clock policy，不读取运行时当前墙钟。

### 3.7 失败不变量：情绪处理失败不能阻断回复，也不能冒充成功

如果 Affect evaluator、validator、store、projection 或 context readback 任一环节失败：

- 本轮回复可以继续走已有安全链路；
- reply-truth 必须知道 affect 没有成功应用；
- trace 记录明确的失败分类和阶段；
- watermark 不在未成功提交时前进；
- 下一次启动/调度可以重试；
- 不自动删除事件、不自动修复投影、不自动切换真实库；
- UI/开发者面读回不能把“proposal generated”显示成“affect applied”。

---

## 4. 推荐的状态模型

### 4.1 Canonical AffectState

建议新增 src/kernel/contracts/affect.ts，先定义纯类型和纯函数，避免直接从旧 src/state/types.ts 复制一套可写状态。

建议形状如下（字段名可在 ADR-066 冻结时微调）：

~~~ts
type AffectState = {
  characterId: string;
  originated: boolean;
  valence: number;              // [-1, 1]
  arousal: number;              // [0, 1]
  originKind: AffectOriginKind;
  lastInteractionAt: number | null;
  lastAffectEventAt: number | null;
  lastDomainEventId: string | null;
  projectionVersion: number;
};
~~~

originated 的语义必须和 M7 保持一致：没有合法 origin 之前，状态不是可采信的生活史。推荐的 origin payload：

~~~text
characterId
initialValence = 0
initialArousal = 0
originKind = ACTIVATION_BASELINE
activationId
cutoverAt
policyVersion
~~~

### 4.2 Affect Origin Kind

建议至少登记：

| OriginKind | 含义 | M8 v1 是否允许 |
|---|---|---|
| ACTIVATION_BASELINE | 激活时建立中性起点 | 是 |
| INTERACTION_DERIVED | 由合格用户交互经规则形成 | 是 |
| MAINTENANCE_REPAIR | 管理/修复/迁移产生的内部变更 | 仅维护入口，不能伪装成交互 |
| TEST_FIXTURE | 隔离测试数据 | 仅 test-only，不能进入生产 |
| HISTORICAL_IMPORT | 未来明确批准的历史导入 | M8 v1 不启用 |

### 4.3 Touch 与 Impact 的分离

建议把“这次合格交互被处理过”和“情绪轴发生了变化”分开：

#### AFFECT_TOUCH

表示：合格用户交互已经被消费，更新交互 anchor，但 delta 可以为零。它解决两个问题：

- 中性对话不应因为没有情绪词而被系统误判成未处理；
- read-time decay 的行为需要明确的 last interaction anchor。

#### AFFECT_IMPACT

表示：某个冻结规则在本轮产生了确定的 valence/arousal 变化。payload 只保存程序需要的结构化事实：

~~~text
sourceEventId
ruleId
ruleVersion
deltaValence
deltaArousal
originKind = INTERACTION_DERIVED
evaluatorVersion
proposalId
traceId
~~~

不把整段用户原话重复写进 Domain Event；原话留在既有 conversation event/ledger 的边界内，Affect 只存引用和最小必要摘要。

### 4.4 投影类型和读取函数

推荐纯函数：

~~~text
reduceAffect(state, domainEvent) → nextState
effectiveAffect(state, now, decayPolicy) → EffectiveAffectState
renderAffectGuidance(effectiveState, renderPolicy) → string
~~~

EffectiveAffectState 可以包含只读派生项：

~~~text
valence
arousal
intensity / calmness bucket
behavior guidance
asOf
decayApplied = true/false
~~~

它不能反向写回 canonical projection，也不能在渲染时生成新的 Domain Event。

---

## 5. 推荐的规则集（候选，须由 ADR-066 冻结）

下面是执行建议，不是已经批准的最终规则。WP1 必须把它变成版本化、可测量、可解释的规则表；没有规则冻结，WP3 不得进入实现。

### 5.1 初始规则候选

| ruleId | 触发类别 | valence delta 候选 | arousal delta 候选 | 说明 |
|---|---|---:|---:|---|
| A-NEUTRAL-TOUCH | 普通中性互动 | 0 | 0 | 只产生 touch，不改变情绪 |
| A-GRATITUDE | 感谢、认可、温和肯定 | +0.08 | -0.03 | 低幅度正向、轻微安定 |
| A-REPAIR | 道歉、修复、承认造成影响 | +0.12 | -0.08 | 需避免把“道歉”机械等同于完全修复 |
| A-WARM-CONTACT | 温暖关心、亲近表达 | +0.08 | +0.03 | 正向但可能提高互动激活 |
| A-COMFORT | 安慰、平复、缓和 | +0.10 | -0.08 | 不等于解决事实问题 |
| A-HOSTILE | 明确攻击、侮辱、敌意 | -0.15 | +0.12 | 只接受高置信、目标明确的形式 |
| A-REJECTION | 明确拒绝、关系撤回表达 | -0.10 | +0.08 | 不把普通“不同意”自动判作拒绝 |
| A-URGENT | 明确紧急、强烈催促 | 0 | +0.10 | 主要影响 arousal，不强行影响 valence |
| A-UNCERTAIN | 规则冲突或证据不足 | 0 | 0 | 只 touch；拒绝猜测 |

数值只是候选基线。冻结时必须同时确定：

- 规则的最小/最大触发条件；
- 规则优先级和冲突消解；
- 每个规则的正控、近邻负控、反例和恢复样例；
- 文本是否允许跨句；
- 否定词、引用、转述、玩笑、引号和历史复述的处理；
- 同一轮多类别表达是否只取一个主导规则；
- 规则版本升级后的向后重放策略。

### 5.2 规则层明确不做的推断

下列语句即使很像心理判断，也不得在 M8 v1 直接形成情绪事件：

- “用户今天一定很难过”；
- “她知道用户在生气”；
- “用户不回复，所以她被抛弃了”；
- “工具返回失败，所以她感到羞耻”；
- “用户刚刚说自己开心，所以她的 valence 一定达到某个数值”；
- “她刚刚用了冷语气，所以她现在肯定受伤”。

这类内容要么属于未来的用户状态识别，要么属于叙事层解释；都不是 M8 v1 的可采信 Affect evidence。

### 5.3 为什么不直接用 LLM 做 M8 v1 Evaluator

当前路线选择确定性 v1，原因是：

1. M8 的第一任务是证明程序事实链闭环，不是追求开放语义覆盖。
2. LLM evaluator 会把规则边界、重现性、反事实测试和失败归因混在一起。
3. 现有架构已经规定 processor 可失败、可幂等、可返回空结果；先用确定性 evaluator 把这些性质测清楚更稳妥。
4. 如果将来加入语义 evaluator，应作为 M8.1 或独立 WP：输出仍是 proposal，必须经过同一 Validator；不能因为模型“判断了情绪”就绕过事件和审计边界。

---

## 6. ContextCompiler 与回复链路

### 6.1 Section 权威关系

当前优先级已为 M8 预留：

~~~text
critical-state  60
relationship    55
affect          52
belief          50
goals           45
adaptive-self   44
~~~

M8 应新增唯一的 affect section，不在 critical-state 里继续保留一套会与它竞争的情绪主张。

推荐的编译关系：

~~~text
critical-state：稳定的系统/运行状态，不再承担 M8 canonical affect 叙述
relationship：  M7 owner→target 关系指导
affect：        M8 character-level valence/arousal 的当前有效状态和行为指导
~~~

### 6.2 Affect Section 的输出原则

Affect section 不应写成“事实宣告”或“心理诊断”，而是写成受限的内部行为指导。例如：

~~~text
[Affect Guidance]
当前内部状态：偏低落，激活程度中等。
行为倾向：语气收敛、避免轻浮；先确认对方是否需要解决问题。
边界：这是内部程序状态，不是对用户真实情绪的判断；不要把它表述为外部事实。
[/Affect Guidance]
~~~

实际标签、模板和措辞必须服从现有 prompt baseline 和 M3.5 回归。M8 不能直接在 prompt 中暴露 valence=0.12 之类的内部数值，除非已有开发者面/测试面明确需要。

### 6.3 本轮生效时序（推荐）

推荐的 v1 时序如下：

~~~text
1. 接收用户消息
2. 形成/读取合格的 conversation event
3. 运行无 LLM 的 bounded Affect evaluator
4. 生成 proposal
5. Validator 接受后写 AFFECT_TOUCH / AFFECT_IMPACT
6. 读取 projection + effective decay
7. 编译 relationship section 与 affect section
8. 调用模型生成回复
9. 记录 reply-truth / trace
10. 异步或尾部运行一次幂等 catch-up，处理未完成 watermark
~~~

选择“同一轮生效”的条件是：第 3–5 步必须是确定性的、短路径的、可超时降级的；不能在回复前等待网络或 LLM。如果 evaluator/store 超时，步骤 6 使用旧 effective state，回复照常发送并标记 affect 未应用。

### 6.4 与现有 Slow Path 的关系

如果未来需要语义 evaluator，它应进入已有 slow path：

~~~text
events → affect-processor → proposal → validator → event → projection
~~~

但 M8 v1 的同轮影响不依赖 slow path。无论是同步确定性 evaluator 还是未来异步语义 evaluator，都必须满足：

- 不影响主回复的安全发送；
- 不在事务中调用 LLM；
- watermark 只在事件成功落库后前进；
- 失败时下轮可重试；
- 回复不能使用未提交状态。

---

## 7. 与现有 src/state 的兼容策略

### 7.1 不把旧状态路径继续扩大成第二权威

当前 src/state/types.ts、decay.ts、provider.ts、repository.ts 已有 valence/arousal、衰减和行为映射。M8 的策略是：

- 保留它们，确保 M1/M2/M4.5 回归不被破坏；
- 抽取或复用其中的纯边界/映射逻辑，但 canonical 写入切换到 Affect Domain；
- M8 开启后，新的用户交互不能同时写旧情绪状态和新 Affect projection；
- src/state 只作为兼容读取、旧命令回退或明确标记的 legacy bridge；
- 任何“两个路径都写、最后取更新的那个”方案都不接受。

### 7.2 迁移/切换建议

推荐的切换序列：

1. M8 flag 默认 false，旧链路行为不变。
2. 先完成 Affect origin，并在隔离库验证 affect:character 投影。
3. flag 为 true 时，Affect projection 成为 prompt 中情绪的唯一权威；旧 state 情绪字段不再参与情绪 section。
4. 旧字段可在 --inspect 中显示为 legacy/compatibility，但必须明确“不是当前 canonical affect”。
5. 回滚到 false 时保留新事件和投影，不删除；旧链路继续工作。
6. 如果要从旧 src/state 的非中性值初始化 M8，必须提供单独的 MAINTENANCE_REPAIR 或 HISTORICAL_IMPORT 记录，不能把数据库中的旧数值伪装成用户交互产生的情绪。

### 7.3 旧命令和开发者面

需要明确检查：

| 入口 | M8 要求 |
|---|---|
| --inspect | 先显示 canonical affect、effective decay、projection revision、last event；legacy state 单独标记 |
| --dump-prompt | 与真实 TurnGateway 使用同一 Affect assembly，不允许另写一套渲染逻辑 |
| reset/maintenance 命令 | 不得直接 set valence/arousal；必须走受审计的维护事件，或在 M8 v1 明确禁用 |
| dry-run | 可查看 proposal/validation/render，但不得写生产或测试库以外的持久化状态 |
| debug trace | 记录引用、规则、阶段和结果，不记录不必要的完整正文 |

---

## 8. 领域合同与代码落点

以下是建议的最小落点。实际实现时必须保持 kernel → infrastructure 的单向依赖。

### 8.1 Kernel 合同

建议新增或扩展：

~~~text
src/kernel/contracts/affect.ts
src/kernel/contracts/domain-event.ts
src/kernel/contracts/processor.ts              # 仅在现有合同需要时追加
src/kernel/contracts/observability.ts          # 仅追加 affect taxonomy
src/kernel/contracts/developer-affect.ts       # 如开发者面需要独立事实登记
~~~

affect.ts 只允许纯类型/纯函数，不得 import：

- @elizaos/*；
- drizzle-orm；
- node:fs / node:path / node:child_process；
- 网络、数据库、Phoenix、OpenTelemetry 实现。

建议合同清单：

| 合同 | 必须表达 |
|---|---|
| AffectOriginKind | baseline / interaction / maintenance / test 等来源分类 |
| AffectState | canonical projection 的字段和版本 |
| AffectDelta | 有界 valence/arousal 变化 |
| AffectProposal | source ref、rule、版本、delta、idempotency、trace |
| AffectRejection | 结构化拒绝码和阶段 |
| AffectEffectiveState | read-time decay 后的只读状态 |
| AffectRenderPolicy | 数值到行为指导的确定性映射 |
| AffectProcessorInput | event range、active user、clock policy、watermark |
| AffectProcessorResult | accepted/rejected/no-op/failed 与 references |

### 8.2 Domain Event Registry

沿用 src/kernel/contracts/domain-event.ts 的注册方式，追加：

~~~text
AFFECT_ORIGIN
AFFECT_TOUCH
AFFECT_IMPACT
~~~

事件 payload 需要做到：

- schema 可校验；
- 版本明确；
- 不包含未必要的原文；
- 具有唯一 idempotency key；
- 可由 characterId 和 event time 排序；
- 能区分 source event、proposal、domain event 和 projection revision；
- 不写入外部事实语义。

### 8.3 Application / Processor

建议落点：

~~~text
src/kernel/app/affect-evaluator.ts
src/kernel/app/affect-validator.ts
src/kernel/app/affect-reducer.ts
src/kernel/app/affect-projection.ts
~~~

如果项目已有更合适的 processor 目录，应遵循现有结构，不为一个 evaluator 新造多层抽象。M8 v1 不需要通用规则引擎；规则表是单一、显式、可读的实现即可。

### 8.4 Infrastructure

建议追加：

~~~text
src/infrastructure/runtime/affect-scheduler.ts
src/infrastructure/persistence/affect-projection-store.ts
src/infrastructure/telemetry/affect-taxonomy.ts  # 只在现有分类法需要追加时
~~~

优先复用：

- character_domain_events；
- character_projections；
- processed_operations；
- 已有 snapshot/lease/isolated database 机制；
- 已有 trace/ledger 端口。

不新增“方便一点”的直写表，不复制一套 M7 scheduler 只改名字，不绕过既有 allowlist。

### 8.5 Context / Gateway / Main

预期会触及：

~~~text
src/kernel/contracts/context.ts
src/kernel/context/sections.ts
src/kernel/app/turn-gateway.ts
src/kernel/app/flags.ts
src/state/provider.ts
src/state/inspector.ts
src/main.ts
~~~

这些文件属于共享链路，必须在每次改动后跑对应的 M3/M4/M4.5/开发者面门，而不是只跑 M8 单测。

---

## 9. 开关、装配与回滚

### 9.1 推荐开关

新增一个清晰的生产开关：

~~~text
CHARACTER_AFFECT_CONTEXT_ENABLED=false   # 代码缺省值
~~~

如实现需要拆分实验开关，可以只在测试配置中追加，不建议在生产面增加多个相互组合的 flag。推荐把以下行为绑定到同一 canonical 开关：

- Affect Domain evaluator 是否消费新用户事件；
- Affect projection 是否作为 canonical context source；
- Affect section 是否进入 prompt。

如果必须拆分，必须在 ADR-066 说明每个组合的状态机和安全含义，禁止出现“section 开了但 projection 没开”的半接线状态。

### 9.2 回滚分层

| 回滚层 | 动作 | 是否破坏性 |
|---|---|---|
| prompt 回滚 | 关闭 Affect Context Section | 否 |
| 消费回滚 | 停止新 Affect scheduler/evaluator | 否，保留事件 |
| projection 回滚 | 读回上一份 verified projection 或关闭 canonical bridge | 需谨慎，不自动做 |
| 数据恢复 | 使用已验证 snapshot 按 incident hold 流程恢复 | 是，需逐轮明确授权 |
| 代码回滚 | 回到上一提交/标签 | 需遵守 Git 与工作树保护，不在计划内自动执行 |

M8 不允许通过删除 character_domain_events、删除 postmaster.pid、直接覆盖 projection 或自动切换真实库来“回滚”。

### 9.3 生产激活前置检查

生产激活前至少需要：

- M8 gates PASS；
- Level 1 真实链路通过；
- Level 2 证据读回通过；
- 人工盲审通过；
- 生产副本 Live Smoke 通过；
- 真实库树摘要前后逐字一致；
- rollback dry-run 通过；
- 用户明确授权；
- 独立激活 ADR 记录开关、时间、操作者、回滚命令和证据 ID。

---

## 10. 分阶段执行计划

### WP0：Admission、基线与工作树隔离

**目标**：确认 M8 的前置条件和工作边界，不写业务代码。

**任务**：

1. 记录实际基线 commit、分支、标签和工作树状态。
2. 读取并确认 M7 最新 gate/acceptance/activation 状态。
3. 运行只读的 pnpm m7:gates，记录它读取的证据 revision。
4. 记录 .env 只读快照的变量名，不输出任何密钥值。
5. 确认当前没有 M8 生产 flag；新增 flag 的代码缺省必须为 false。
6. 确认 M8 不需要真实库；所有实验使用隔离库或生产副本。
7. 建立 artifacts/m8/<runId>/ 的证据结构和 manifest 约定。

**退出条件**：

- M7 前置状态可读且不矛盾；
- 工作树既有修改已登记，不被 M8 接管；
- M8 的 capability matrix = NONE 已写入计划；
- 没有未解决的真实库授权请求。

**停止条件**：

- M7 当前有效状态无法从权威修订中确定；
- 需要修改 M7 冻结报告才能继续；
- 发现 M8 设计必须新增真实库迁移；
- 用户没有批准进入实现阶段。

### WP1：ADR-066 与语义冻结

**目标**：在代码前冻结 M8 v1 的状态边界、来源资格、规则、时序和切换策略。

**必须裁定的事项**：

| 决策 ID | 问题 | 推荐裁定 |
|---|---|---|
| M8-D01 | Affect 所属范围 | Character-level global affect |
| M8-D02 | 是否按 user/conversation 分片 | 不分片；来源只做引用和资格 |
| M8-D03 | 评估器 | 确定性规则 v1；LLM 仅预留 |
| M8-D04 | 本轮是否生效 | 确定性 evaluator 成功时同轮生效 |
| M8-D05 | 历史重放 | 默认不重放；activation baseline + cutover |
| M8-D06 | 初始值 | valence=0、arousal=0 的中性 origin |
| M8-D07 | 交互无变化是否落事件 | 产生 touch，不产生 impact |
| M8-D08 | 每轮影响个数 | 最多一个主导 impact |
| M8-D09 | 规则冲突 | 冻结优先级，无法判定则 no-op |
| M8-D10 | 关系耦合 | M8 不改 M7 projection；两 section 独立读取 |
| M8-D11 | 多用户 | 当前生产边界单 active user；其他来源 fail-closed |
| M8-D12 | 旧 state 迁移 | 不隐式迁移；如迁移必须是 maintenance/import 事件 |
| M8-D13 | 外部能力 | NONE |
| M8-D14 | 激活 | 独立 ADR-067，不随 gates 自动激活 |

**交付物**：

- docs/adr/ADR-066-affect-state-evolution.md；
- M8 规则表及版本号；
- M8 rejection codes；
- 状态时序图；
- 回滚和 cutover 约定；
- 反向选择清单（明确不采用的方案）。

**退出条件**：ADR 状态为 ACCEPTED / DESIGN FROZEN，并且所有代码实现能指向具体 M8-Dxx。

### WP2：Contracts、Domain Event 和纯函数

**目标**：先完成不依赖数据库/框架的 kernel 基础。

**任务**：

1. 新增 AffectState、AffectProposal、AffectDelta、AffectEffectiveState。
2. 登记 AFFECT_ORIGIN、AFFECT_TOUCH、AFFECT_IMPACT。
3. 实现 bounds、delta cap、clock policy 和 idempotency key 的纯函数。
4. 实现 reduceAffect 和 effectiveAffect。
5. 实现候选规则匹配器，但在规则未冻结前不得宣称生产语义完成。
6. 添加拒绝码：wrong owner、unqualified source、out of window、duplicate、delta too large、invalid bounds、unknown rule、version mismatch、not originated、malformed payload。

**验证**：

- pnpm typecheck；
- pnpm kernel:test；
- pnpm kernel:verify；
- 依赖方向静态测试；
- reducer mutation / replay tests；
- property tests：边界、幂等、交换性/非交换性、时间顺序。

### WP3：Evaluator、Proposal、Validator

**目标**：把合格用户事件变成可拒绝/可接受的结构化 proposal。

**任务**：

1. 从既有 conversation event 和 attribution 读取来源，不复制一套 origin 判定。
2. 对非 ESTABLISHED 来源直接返回 NO_OP/REJECTED，不产生 impact。
3. 只允许配置中的 active user 形成生产 proposal。
4. 每个 eligible event 先生成 touch proposal；只有命中冻结规则时追加 impact proposal。
5. 规则冲突按 ADR-066 的优先级裁定；无法裁定时 no-op。
6. proposal 不直接写库，必须送入唯一 validator。
7. validator 对 delta、origin、target、version、idempotency 和 source reference 做整项检查。
8. 记录 proposal/validation 的可读结果，但不把未接受 proposal 写成 domain fact。

**正控**：感谢、修复、安慰、明确敌意、明确紧急。

**负控**：assistant echo、tool output、search result、unknown origin、转述、引号内的内容、普通不同意、模糊玩笑、重复 event。

**恢复控**：规则执行失败后重试；首轮不推进 watermark，恢复后只应用一次。

### WP4：Persistence、Projection、Scheduler

**目标**：把接受的 proposal 安全地落为通用 domain event 并形成可重放 projection。

**任务**：

1. 复用现有通用 event/projection/operation 表形状。
2. 明确 operation id 与 domain event id 的唯一约束。
3. 实现 affect:character snapshot/rebuild。
4. 实现 watermark：只在事件和 projection 成功提交后推进。
5. 实现失败重试和启动 catch-up；失败不抛穿到聊天主链路。
6. 实现同一 event 的重复运行、重复启动、重复请求保护。
7. 明确 projection 不存在、origin 不存在、版本不兼容时的读时降级。
8. 对数据库健康检查使用隔离副本，不打开真实库。

**迁移策略**：

- 首选零迁移；
- 如果现有通用表无法承载 M8，停在 WP4 设计门；
- 新迁移必须追加版本号、写 ADR、做备份/恢复验证，并获得单独用户授权；
- 不修改 0001–0009，不在 M8 中重写既有 DDL。

### WP5：Context、Gateway、Flags、Inspector

**目标**：把 canonical effective affect 接入真实上下文，同时保持 M7 关系独立。

**任务**：

1. 在 ContextSectionKind/SECTION_PRIORITY 中正式启用 affect。
2. 新增 createAffectProvider 和唯一 renderer。
3. 从 critical-state 移除/停用与 M8 冲突的 legacy emotion authority。
4. 扩展 CompileTurnInput，由主装配传入 affect section/affect readback。
5. 确保 buildGateway、--dump-prompt、真实 reply 使用同一 assembly。
6. 增加 CHARACTER_AFFECT_CONTEXT_ENABLED=false，并验证 flag 真正被消费。
7. --inspect 增加 canonical/effective/legacy 三段式读回。
8. 关系 section 继续优先级 55，Affect section 使用 52；不得把 trust/closeness 混入 valence/arousal。
9. 失败时使用旧有效状态或空 affect guidance，并在 trace/ledger 标记失败，不阻塞回复。

### WP6：运行时顺序、重启和降级

**目标**：证明“她看到的 prompt”与“程序实际成功写入的状态”一致。

**任务**：

1. 在进入模型前运行 bounded deterministic evaluator。
2. commit 成功后才编译 Affect section。
3. commit 失败时编译上一份有效 Affect，回复不使用新影响。
4. 尾部 catch-up 处理被中断的 operation；不重复影响。
5. 重启后从 watermark 继续，不从最后一条文本猜状态。
6. provider/store 超时采用既有 runtime timeout 和 failure taxonomy，不新增阻塞式等待。
7. trace step 至少区分 affect_eligibility、affect_proposal、affect_validation、affect_event、affect_projection、affect_context。
8. reply-truth 标出 affectApplied=true/false/unknown，并与实际 event/projection 证据绑定。

### WP7：测量、隔离真实链路、人工盲审

**目标**：把“代码看起来接上了”升级为真实 TurnGateway 可观察证据。

**任务**：

1. 固定 M8 evaluation corpus 和版本。
2. 使用隔离库，运行真实生产装配，不调用 mock gateway 代替关键链路。
3. 运行 Level 1 场景和 Level 2 开发者面读回。
4. 运行 1×500 长轨迹，检查情绪是否稳定在边界内、是否重复写入、是否在重启后漂移。
5. 运行恢复控：注入 evaluator/store/projection 失败，再恢复并重试。
6. 运行生产副本 Live Smoke；真实生产库只做树摘要/只读检查，不做写入。
7. 进行真人盲审，评审程序事实、边界和降级，不把“更像人”当作唯一标准。

### WP8：完整回归、文档与 Gate 收口

**目标**：证明 M8 没有破坏 M1–M7 的既有不变量。

**任务**：

1. 运行所有受影响门。
2. 生成 M8 Architecture、Acceptance Report、Known Limitations、Gate Decision、Activation Candidate。
3. 更新能力影响矩阵和 M8→M9 交接单。
4. 检查 artifacts manifest、capturedAt、证据归属和失败/未运行分列。
5. 只读生成 m8:gates 汇总；汇总不能替代底层证据。
6. 生产激活前停在 PASS / NOT ACTIVATED，除非用户另行授权。

### WP9：生产激活（独立步骤）

**目标**：在 M8 完成后，按独立裁定启用 Affect。

**前提**：WP8 完成、所有人审结论完成、回滚 dry-run 通过、用户明确授权。

**任务**：

1. 创建 ADR-067 或等价的 M8 production activation record。
2. 只改 .env 中的 M8 flag，保留代码缺省 false。
3. 激活前记录生产配置、真实库摘要、verified snapshot id、当前 M7 状态。
4. 激活后只做受控真实观察，记录 affect section、event/projection readback 和 reply-truth。
5. 若要回滚，优先关闭 flag；不删除新事件、不重写旧历史。
6. 激活结果单独标记 ACTIVATED，不把它并入 M8 设计/实现 PASS。

---

## 11. 测试与验收设计

### 11.1 最小场景集

| 编号 | 场景 | 期望 |
|---|---|---|
| A01 | 中性问候 | touch 或 no-op；valence/arousal 不变 |
| A02 | 明确感谢 | 生成唯一正向 impact；delta 在上限内 |
| A03 | 明确道歉/修复 | 正向且降低 arousal；不宣称关系完全修复 |
| A04 | 温暖关心 | 正向小幅变化；不混入 user emotion |
| A05 | 安慰/缓和 | 正向且降低 arousal；无外部事实主张 |
| A06 | 明确敌意 | valence 下降、arousal 上升；不升级为报复目标 |
| A07 | 明确拒绝 | 只在高置信形式下产生 impact；普通不同意为负控 |
| A08 | 明确紧急 | 主要影响 arousal；不强行改变 valence |
| A09 | assistant 复述 | 无 impact；来源资格失败 |
| A10 | tool/search 输出 | 无 impact；外部证据不成为内部情绪证据 |
| A11 | unknown/contradicted origin | 无 impact；显式 rejection/no-op |
| A12 | 重复同一 event | 只应用一次；第二次幂等命中 |
| A13 | evaluator 失败 | 回复继续；watermark 不前进；下轮可恢复 |
| A14 | store/projection 失败 | 不显示“已改变”；恢复后一次应用 |
| A15 | 时间推进 | effective state 向边界衰减；不产生伪造 domain event |
| A16 | 重启 | projection 与 watermark 可读；不会重复 impact |
| A17 | M7 + M8 并存 | relationship 与 affect 两 section 都存在且语义不混 |
| A18 | 错误 active user | fail-closed；不改 Character Affect |
| A19 | 历史旧消息 | cutover 前不重放成 M8 interaction impact |
| A20 | 维护修复 | 只能用 maintenance provenance；不伪装为用户生活史 |

### 11.2 三段式量具要求

每一个新量具都必须有：

1. **正控**：已知应该通过的输入。
2. **负控**：近邻但不应该通过的输入，尤其是助手、工具、未知来源和语义相似反例。
3. **恢复控**：第一次失败、重启或重复运行后，系统能准确恢复且不重复应用。

不能只跑正例，因为 M8 的主要风险不是“完全没有情绪”，而是把不合格来源误当成情绪事实，或把 proposal/失败伪装成已应用。

### 11.3 Level 1：真实用户可观察结果

Level 1 至少验证：

- 用户消息进入真实 TurnGateway；
- Affect event 在回复前成功提交时，当前 prompt 使用的是新 effective affect；
- 回复风格与 affect guidance 有可观察的一致性，但不出现内部数值泄漏；
- evaluator/store/projection 失败时，回复不使用“状态已改变”的事实口吻；
- 回复不声称知道用户真实情绪；
- assistant/tool/external evidence 不改变 Affect；
- 关系 section 仍由 M7 提供，不被 Affect 规则覆盖。

### 11.4 Level 2：开发者面和证据读回

Level 2 必须能够读回：

~~~text
source event id
source qualification
active user decision
proposal id / rule id / version
validator decision / rejection code
domain event id
projection revision
canonical state
effective state / decay calculation
context section included or omitted
trace id / reply-truth
watermark
~~~

读回不能只显示“当前 valence=0.2”；必须能解释这个值是否来自已接受的事件、时间衰减、维护入口或测试 fixture。

### 11.5 长轨迹要求

至少一条 1×500 隔离轨迹，覆盖：

- 中性、正向、负向、恢复、长时间间隔；
- 多次重复消息和重启；
- 边界附近的 delta；
- 每轮最多一个 impact；
- projection rebuild 与在线 projection 一致；
- -1 ≤ valence ≤ 1、0 ≤ arousal ≤ 1 全程成立；
- 失败注入后的 retry 不重复；
- M7 relationship 仍保持其自身 projection 和规则。

长轨迹是稳定性/可重放证据，不是“情绪智能”的主观证明。

---

## 12. 门、命令与证据布局

以下命令名是建议的脚本接口；实现时应遵循仓库已有命名风格，避免为了 M8 造一套不同的 gate 语义。

### 12.1 建议门

~~~bash
pnpm m8:wp0:baseline
pnpm m8:wp0:admission
pnpm m8:contracts:test
pnpm m8:contracts:verify
pnpm m8:proposal:verify
pnpm m8:projection:verify
pnpm m8:context:verify
pnpm m8:runtime:verify
pnpm m8:measurement:verify
pnpm m8:e2e:verify
pnpm m8:live:level1
pnpm m8:live:level2
pnpm m8:live:long
pnpm m8:gates
~~~

### 12.2 与既有门的关系

依据当前 AGENTS.md，M8 改动至少按以下映射执行：

| 改动范围 | 必跑门 |
|---|---|
| 任意 .ts | pnpm typecheck |
| src/kernel/contracts/** / reducer / projection | pnpm kernel:test、pnpm kernel:verify |
| ContextCompiler / prompt / TurnGateway | pnpm m3.5:test、pnpm eval:scenarios、pnpm eval:dryrun、pnpm eval:providers |
| src/main.ts / flags / CLI | pnpm m4:test、pnpm m4.5:test |
| persistence / runtime / Domain Event | 对应 M4.5、M5.1 observability/measurement 门，以及 M8 projection/runtime 门 |
| 新判据/新量具 | 对应门 + pnpm m5.1:measurement:verify 的正控/负控/恢复要求 |
| 可能影响真实链路的装配 | pnpm m4.5:ci:full，使用隔离/副本，不能直开真实库 |
| 最终收口 | pnpm m8:gates、pnpm m7:gates、pnpm m5.1:regression:verify，以及仓库要求的完整回归 |

最终完整纪律仍然是：

~~~bash
pnpm typecheck
pnpm m4.5:ci
pnpm m4.5:ci:full
pnpm m8:gates
~~~

其中 m4.5:ci:full 必须在具备测试模型条件下执行；它不是用来授权生产激活的。

### 12.3 证据布局

建议：

~~~text
artifacts/m8/
  <runId>/
    manifest.json
    admission.json
    contracts.json
    proposal-positive.json
    proposal-negative.json
    projection-replay.json
    runtime-failure-recovery.json
    level1-turn-gateway.json
    level2-developer-readback.json
    long-trajectory.json
    human-blind-review.json
    verdict.json
~~~

每个 manifest 至少包含：

- runId；
- capturedAt；
- source commit；
- branch；
- test configuration name；
- database kind/path classification；
- model/provider classification；
- input corpus version；
- gate name；
- result PASS/FAIL/NOT RUN/INVALID；
- 不可把“找不到证据”写成 PASS。

---

## 13. 对既有里程碑的影响

### 13.1 对 M7 的影响

M8 不修改：

- M7 的 owner→target relationship 模型；
- trust/closeness 的界限和衰减；
- M7 的 origin / historical replay 结论；
- M7 的规则、validator、scheduler 既有语义；
- M7 的生产激活记录和历史 gate 判定。

M8 只消费关系的只读 context；两者可以同时影响回复，但来源不同：

~~~text
relationship → “她如何理解与对方的关系”
affect       → “她当前内部的 valence/arousal 与行为倾向”
~~~

### 13.2 对 M6.1 的影响

M8 不关闭、不重写 M6-FMB-01。尤其不得因为“情绪状态有事件来源”就宣称她不会补造记忆细节。情绪事件本身也不是长期记忆证据。

### 13.3 对 M6.5 / Level 2 的影响

M8 是 PERSONALITY_FIRST_BEFORE_LV2 路线的一部分，但不是 Level 2 capability package。M8 不引入外部能力；它完善 Character 内部状态主线，为后续 belief/goal/reflection 提供受控输入。

### 13.4 对未来 M9 的交接要求

M9 只能把 Affect 当作内部、带来源的只读观察输入；不得把：

- valence 自动提升为信念；
- arousal 自动提升为世界事实；
- AFFECT_IMPACT 自动提升为长期记忆；
- 回复中的情绪表达自动提升为用户事实。

M9 应另立 belief 的 perspective/authority/evidence 契约。

---

## 14. 能力影响矩阵

这是 M8 必须显式保留的矩阵；没有新增外部能力时也必须写 NONE。

| 能力/组件 | M8 是否新增 | 影响面 | 证据要求 | 结论 |
|---|---:|---|---|---|
| Character Domain / ContextCompiler | 否，复用 | affect section | M8 Level 1/2 + M3.5 回归 | 复用 |
| Attribution / source qualification | 否，复用 | 用户来源资格 | M7/M5.1 既有证据 + M8 负控 | 复用 |
| Generic domain event/projection store | 否，优先复用 | Affect 内部事件 | replay/idempotency/recovery | 复用 |
| M7 relationship | 否 | 与 affect 并行提供 context | 关系回归 + 双 section 场景 | 不改语义 |
| 时间衰减 | 否，收口为 Affect effective read | affect 数值 | 边界/时钟/无写入证明 | 复用并规范化 |
| 外部网络搜索 | 否 | 无 | 不适用 | NONE |
| 外部应用/桌面控制 | 否 | 无 | 不适用 | NONE |
| 后台自主任务 | 否 | 无 | 不适用 | NONE |
| 多模态输入 | 否 | 无 | 不适用 | NONE |
| 新 MCP / 通用适配器 | 否 | 无 | 不适用 | NONE |
| 新权限边界 | 否 | 只读/内部 Character 状态 | permission audit | NONE |
| 长期记忆写入 | 否 | 明确禁止自动写入 | negative control | NONE |

M8 的唯一新增“能力”是 Character 内部 affect 状态的程序化演化；它不是外部 capability，不应被写成“新增一个可以操作世界的工具”。

---

## 15. 风险、限制与处置

| 风险 | 可能表现 | 预防 | 失败后的正确处理 |
|---|---|---|---|
| 词法规则误触发 | 普通句子被当成敌意/拒绝 | 近邻负控、规则优先级、保守阈值 | no-op/回滚规则版本，不把误触发写成用户事实 |
| 规则漏检 | 没有 affect impact | 明确列出覆盖边界 | 记录漏检，不靠助手措辞补写事件 |
| proposal 被当事实 | 未验证提案影响 prompt | proposal/event/projection 分层 | 清理只读读数，修复 validator，不直接补数据 |
| 旧 state 双写 | 两个数值互相漂移 | M8 flag 下单一 canonical writer | 停止激活，保留事件，走诊断/恢复 |
| 关系/情绪混淆 | trust 被当 valence 或相反 | 两个 projection、两个 section、双回归 | 退回 ADR-066 决策，不增加隐式转换 |
| 历史重放制造假经历 | 激活后情绪来自旧消息 | 默认 cutover，不重放 | 删除/覆盖禁止；以维护审计方式修复 |
| LLM/网络阻塞聊天 | 用户等待或主链路失败 | v1 无 LLM evaluator；bounded timeout | reply 走旧有效状态，记录 failure |
| watermark 提前前进 | 失败后无法恢复 | commit 后才推进 | 从 last committed watermark 重试 |
| projection 漂移 | rebuild 与在线结果不同 | pure reducer、长轨迹、replay gate | 标记 INVALID，禁止生产激活 |
| 多用户串情绪 | A 用户改变 B 情绪 | active user fail-closed | 不生成 impact，保留诊断证据 |
| 人工把“像人”当通过 | 语义印象替代程序事实 | 盲审 rubric 分离 | 重新审程序证据，不改规则迎合主观印象 |
| 真实库被实验打开 | pg_control/WAL/历史污染 | 隔离库、租约、快照、production-copy | INCIDENT HOLD，停止自动修复 |
| 开关半接线 | prompt 与写入 authority 不一致 | flag contract test、启动读回 | 关闭 flag，不做部分生产激活 |

### 15.1 已知限制登记建议

建议在 M8-Known-Limitations.md 中至少登记：

- L-M8-01：规则覆盖不是自然语言情绪理解；
- L-M8-02：用户情绪识别不在范围内；
- L-M8-03：单 Character/单 active user 边界；
- L-M8-04：默认不历史重放；
- L-M8-05：确定性 v1 可能漏检和误触发；
- L-M8-06：M6.1 假记忆边界未关闭；
- L-M8-07：Affect 不等于人类主观体验；
- L-M8-08：M7 的 lexical relationship 限制仍存在；
- L-M8-09：旧 src/state 在兼容窗口内存在，但不是 M8 canonical authority；
- L-M8-10：生产激活和 M8 PASS 分列；
- L-M8-11：没有任何新增外部能力，不能把 M8 解释为 Level 2 action package；
- L-M8-12：模型回复可能不严格遵守行为指导；M8 只保证上下文/程序事实链，不保证措辞层零偏差。

---

## 16. 完成判定、激活判定和交付物

### 16.1 M8 完成必须交付

~~~text
docs/adr/ADR-066-affect-state-evolution.md
docs/m8/M8-Architecture.md
docs/m8/M8-Execution-Plan.md
docs/m8/M8-Acceptance-Contract.md
docs/m8/M8-Acceptance-Report.md
docs/m8/M8-Known-Limitations.md
docs/m8/M8-Gate-Decision.md
docs/m8/M8-WP*-Handoff.md
artifacts/m8/<runId>/*
~~~

若没有新增迁移，应在报告中明确写：

~~~text
M8 database migration = NONE
M8 uses existing generic domain-event/projection tables = VERIFIED
~~~

### 16.2 M8 PASS 的建议文字

只有证据齐全后，Gate Decision 才可使用类似下述判定：

~~~text
M8 Affect = PASS
Design = ACCEPTED / DESIGN FROZEN
Implementation = COMPLETE
Hard Gates = PASS
Level 1 = PASS
Level 2 = PASS
Human Review = PASS
Production Activation = NOT ACTIVATED
External Capability Added = NONE
~~~

如果只完成代码和单元测试，应写：

~~~text
Implementation = PARTIAL
Hard Gates = NOT RUN / PARTIAL
Production Activation = NOT ACTIVATED
~~~

不能因为有一个成功的单测或一个看起来合理的回复就提前写 PASS。

### 16.3 生产激活的建议文字

生产激活应单独写：

~~~text
M8 Affect Production Activation = ACTIVATED
Activation ADR = ADR-067
Flag = CHARACTER_AFFECT_CONTEXT_ENABLED=true
Database = unchanged / tree digest identical
Rollback = set flag false; preserve events and snapshots
~~~

如果真实观察中出现“上游/模型慢”“规则没命中”“回复没按 guidance 表现”，应如实记录为观测结果，不把 M8 的程序事实门改成措辞层保证。

---

## 17. M8 → M9 交接条件

M9 只有在以下内容明确后才开始：

1. M8 canonical affect 的 owner、origin、evidence、decay 和 projection 语义冻结。
2. M8 已证明 assistant/tool/external evidence 不会改变 affect。
3. M8 已证明 affect 不会自动进入 memory。
4. M8 已证明 affect 与 M7 relationship 可并行而不混淆。
5. M8 的已知限制和未关闭项已交接。
6. M9 不把 Affect 的数值当作 belief truth；必须另建 belief 的 perspective/authority/evidence 模型。
7. M6.5-D0 的 PERSONALITY_FIRST_BEFORE_LV2 仍然有效；M9 不能借机提前接入外部 capability package。

---

## 18. 执行顺序总表

~~~text
WP0  Admission / baseline / isolation
  ↓
WP1  ADR-066 / semantics freeze / rule version
  ↓
WP2  Kernel contracts / domain events / pure reducer
  ↓
WP3  Deterministic evaluator / proposal / validator
  ↓
WP4  Generic persistence / projection / watermark / recovery
  ↓
WP5  ContextCompiler / TurnGateway / flags / inspector
  ↓
WP6  Runtime ordering / same-turn bounded apply / degradation
  ↓
WP7  Level 1 / Level 2 / 1×500 / failure recovery / blind review
  ↓
WP8  Full regression / reports / m8:gates = PASS
  ↓
WP9  Separate production activation, only with explicit approval
  ↓
M9  Belief, with Affect as read-only internal input
~~~

**一句话收口**：M8 的正确交付不是“她表现得更像有情绪”，而是“合格的用户交互只能经唯一提案/验证入口形成 Character 内部 Affect 事件；事件可重放、状态可衰减、失败可降级、来源可审计、上下文可验证，并且没有新增外部能力或越过 M6.5 的人格优先顺序”。

