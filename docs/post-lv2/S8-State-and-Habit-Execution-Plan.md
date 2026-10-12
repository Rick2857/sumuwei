# S8 状态与习惯链执行计划书

日期：2026-10-03（北京时间）。工作包标识：`POSTLV2-S8`。

状态：**总体方案已获用户同意 / 计划已编制 / 实现尚未开始 / 验收尚未执行**。

⏩ 2026-10-04 修订（只追加，原判定保留）：本行已过时 —— 实现与验收**均已执行**（WP0–WP8 逐包完成，**Hard Gates PASS**），见 `S8-Gate-Decision.md` §0。

用户授权依据：同意上一轮调研建议，并要求提供执行计划书。本轮交付计划书；没有执行代码修改、模型批次、真实库迁移或生产激活。WP1 的详细契约仍须形成新的 ADR，不能把同意总体方案写成详细设计已经冻结。

## 0. 要交付什么

补齐以下真实工程链，保留 LG 的人格、状态和提案放行权威：

```text
已提交的故事事件账本
  → 有可见性、参与者和实际交互归属的观测
  → 可解析、可去重、可失效的故事根证据
  → Affect / Relationship 的故事输入与合法提案
  → Reflection 的触发、取数、来源审查
  → 达到既有门槛后的有限习惯采纳
  → ContextCompiler 实际入模
  → 后续行为对照与失效后的退场
```

**完成标准不是“存下一个 episode”，也不是“类型检查通过”。** 必须同时取得持久根、三类消费者接线、合法采纳、实际入模、行为改变和失效恢复的证据。对不足门槛、冲突、不可见或伪造来源，必须得到明确拒收及零副作用。

本计划参考 [S8 现成方案调研](../research/S8-Story-Experience-Cognition-Solutions-2026-10-03.md)，以该文对应提交 `6c16c11b` 为调研锚点。编制期间共享工作区仍在推进 S7；WP0 必须记录执行当时的 HEAD、相关源文件摘要及其他会话改动，不能把本计划日期或调研提交当成未来验收基线。

## 1. 当前裁定与实施范围

### 1.1 当前缺口

| 项目 | 当前事实 | 本工作包补齐 |
|---|---|---|
| 世界运行 | 已有纯故事事件、状态机及 Ink 运行时 | 提交账本、观测与提交的持久对应、恢复入口 |
| 来源词汇 | 已有 `story_fact` / `STORY_OBSERVATION` / `story_experience` | 把来源标签接到可解析的持久根 |
| Affect / Relationship | 输入和放行仍围绕对话事件 | 独立故事输入、资格判定及合法提案引用 |
| Reflection | 根构造和解析没有完整故事路径 | 故事触发、读取、根解析、独立性与失效传播 |
| 习惯 | 已有 M11/M11.1 的有限槽位与采纳纪律 | 让合格故事经历能走完既有采纳和入模链 |
| S8 状态 | **工程缺失；测量未执行** | 新证据闭环，不能沿用旧表的 `NOT RUN` 暗示已实现 |
| ⏩ `S8` 状态修订（2026-10-04） | **已过时**：工程已落地（WP0–WP8），语义测量**已执行**（两批 144+144，真模型调用**已用合计 312**，见 `S8-Gate-Decision.md` §0/§2）；本行原读数保留 | — |

[ADR-090](../adr/ADR-090-lv2-risk-acceptance-release.md) 已按已知风险接受放行 Lv2；它没有把 M11.1 的残余或新 S8 门改成 PASS。本计划不重设 Lv2 的历史放行条件，也不把风险接受当作 S8 验收证据。

[ADR-091](../adr/ADR-091-post-lv2-world-boundary-and-story-source.md) 的来源边界继续有效。[ADR-092](../adr/ADR-092-pl2-sr-01-story-durable-root-ruling.md) 的持久故事根候选在本工作包重新进入实施设计，须由**新 ADR**承接；旧裁定及旧失败档保留。新 ADR 编号在登记时取用，避免与其他会话冲突。

### 1.2 首版范围

- 当前角色、当前真实用户、已版本化的有限故事包；沿用现有 World 状态机和 LG 状态折叠。
- 同时支持 Affect、当前角色与当前用户的 Relationship、Reflection / Adaptive Self。NPC 间关系不映射成角色与真实用户的关系。
- 情绪和关系评价先采用**少量封闭、版本化、可解释的故事结果规则**。合法合作须能追到真实参与者及实际选择；剧情作者写出的赞美、NPC 台词不能充当真实用户反馈。
- 习惯只使用已有三个槽位：`clarify_when_ambiguous`、`acknowledge_correction_first`、`recheck_goal_before_next_step`。本工作包不增加任意指令、自由文本策略或新的习惯槽。
- 不包含 S7 检索排序/语义召回修复、头像/语音改造、M11.1 全部历史残余销账、多人社交图谱、背景自主学习或新的外部应用集成。

S7 的召回问题与 S8 工程缺口分别记录。S8 测试通过真实故事提交与新输入口，不依赖“能否先把故事记忆排进检索结果”。涉及来源安全、冻结语义或共同装配的失败仍须修复，不能用范围声明排除。

## 2. 现成方案如何使用

| 方案 | 固定核对版本 | 本工作包采用方式 | 直接采用运行时的决定 |
|---|---|---|---|
| [Concordia](https://github.com/google-deepmind/concordia/tree/b71d202750e23444ce1bf28d9f114bcd88aa41db) | `b71d202…`；Python；Apache-2.0 | 参考 `observe()` → 观测组件 → 反思/行动上下文的输入链 | 首版保留 LG 运行时，不引入第二个 agent 权威 |
| [FAtiMA Toolkit](https://github.com/GAIPS/FAtiMA-Toolkit/tree/56b7cbd992f953cfe21a7b12cb1a0e6cdf6ccf9f) | `56b7cbd…`；C#；Apache-2.0 | 参考事件感知和情绪 appraisal，把有限故事结果映射成可审查的解释 | 首版无需 .NET 服务；若规则探针证明确需原引擎，再单列接入决定 |
| [Ensemble](https://github.com/ensemble-engine/ensemble/tree/8b74bdec4ba2ef4e14795b7591df3b5d73f283e3) | `8b74bde…`；JavaScript；四条款 BSD 文本 | 参考社会事实与触发规则；WP0 核对许可证义务 | 不复制其可变全局社会状态；直接复制代码前登记出处与许可证 |
| [ExpeL](https://github.com/LeapLabTHU/ExpeL/tree/e41ec9a24823e7b560c561ab191441b56d9bcefc) | `e41ec9a…`；Python；Apache-2.0 | 参考成功/失败轨迹及后续任务对照 | 经验提取仍经过 LG 根审查、有限槽位和采纳放行 |
| LG 现有 M7/M8/M11 | WP0 记录本机版本 | **直接复用**状态投影、提案放行、反思任务、有限采纳、上下文和追踪 | 本工作包的生产主干 |

这是一份“复用 LG 主干、补齐故事接线”的执行方案。上游源码核对不等于本机已运行验证。首版不要求安装上述四套框架；只有组件复用能减少实际代码和维护成本时才采用，并先完成隔离探针。探针失败即可记录淘汰，不为比较框架启动额外模型批次。

## 3. WP1 必须冻结的契约

### 3.1 世界账本与观测身份

复用现有 `StorylineEvent`，追加持久账本及必要的提交/观测关联。世界存储放在 `src/infrastructure/storyline/store/**`，纯故事契约和折叠放在 `src/kernel/storyline/**`；Kernel 通过端口取数，不能直接 import 世界 SQL。

当前有两个不同的 ID：

1. `StorylineEvent.eventId`：一次已提交世界变更的事件 ID。
2. `StoryWorldObservation.eventId`：剧情可见条目的 ID，例如一次提交产生的多个可见片段。

两者不能混用。账本须保存观测属于哪次提交；继续兼容已有 `story:<storyId>@v<version>#<runId>.<eventId>` 来源标识。**一个提交产生多个可见条目，不能因此变成多个独立根。** `runId` 变化也不能自动证明新证据独立。

提交以完整故事/版本/run/事件身份唯一定位，revision 顺序另行校验；一个旧来源 ID 必须能唯一定位实际产生它的提交。条目重现、旧来源歧义及重复请求的处理在 WP1 冻结，不能随意挑一条账本记录充当原始根。

最低持久信息包括故事/版本/run、提交身份与 revision、事件类型、选择与前后节点、原有状态折叠数据、提交时间、可见条目及其父提交、可信参与者和真实交互归属。选择的接受与对应世界提交须原子落盘；重试请求的幂等身份由服务端验证。

只存实际发生的提交。未选择分支、作者背景、模型补写和不可见内容不进入角色的有效观测。账本是恢复权威；Ink 快照可作为派生恢复材料，但不能替代提交记录。

### 3.2 新输入和来源引用

| 接口 | 追加方式 | 旧语义约束 |
|---|---|---|
| 评估器 | 独立、只读的故事观测视图；与对话视图按 kind 明确区分 | 不把故事 ID 强转为 `ConversationEventId`；不放宽对话 actor 判据 |
| 提案/角色内部事件 | 追加版本化的故事来源引用；候选形状为 `sourceStoryRefs` | `sourceConversationEventIds` 继续只指对话；内部事件不伪装为世界原始事实 |
| EvidenceRef | 候选新增 `story_event` kind | 四个既有 kind 含义保持；旧数据解码与折叠结果不变 |
| Lineage handle / root | 增加带故事身份、可见性、归属和有效性结果的根类别 | 故事体验与用户陈述、程序结果、内部解释分开 |
| 历史 story observation | 精确识别已登记的来源格式，查询观测→提交映射 | 不把所有 `observation` 都当故事；不改写旧引用 |

上述字段名称为 WP1 设计候选，不能提前视为已存在的 API。必须一次核对 evaluator、validator、proposal、event payload、SQL 读取、lineage、trace、旧版 decoder；只改输入 union 不算接通。

来源标签继续使用 `STORY_OBSERVATION` / `story_experience`，保留 `experienceScope`。沿用已有 authority 映射不表示可以升级为外部事实；反思、习惯、记忆和上下文都须保留体验范围，不把世界结果写成用户现实履历或 reported 事实。

历史故事来源若没有可验证的提交记录，返回“原始根未确认”，保持拒收。没有真实记录时禁止用快照、当前文本或模型回忆伪造历史提交。

### 3.3 根独立性与真实会话

习惯采纳仍要求 **至少 3 个有效独立根、至少 2 个真实会话、未解决冲突为 0**。

根数按可信原始交互的因果身份计数。同一次选择产生的对话记录、故事提交、多个观测、记忆、领域事件和反思，必须通过可审计的因果关联去重，不能沿不同来源路径重复加票。来源 kind 本身不改变；没有故事输入的旧对话链保持既有计数语义。

会话只能来自服务端确认的真实用户交互归属。两个 `runId`、两次 replay、两个节点或两份快照均不等于两个会话。纯后台世界推进、作者设定、NPC 评价可以按资格成为情绪经历，但不能为当前用户关系和习惯制造合格反馈。

WP1 须冻结因果去重键、真实会话映射和冲突定义，配正控/负控。模型不得自行声明“这是独立证据”或填入 rootCount / conversationCount。

### 3.4 状态、触发与习惯

- Affect：故事资格独立检查，再形成现有放行口可审查的提案。保留既有状态区间、衰减、cutover 和单事件最大变化限制；已有 `MAX_AFFECT_DELTA_PER_EVENT` 不放宽。
- Relationship：真实参与和目标用户由服务端绑定；保留 trust/closeness 的 `[0,1]` 范围及既有单次上限。故事事件不能增加旧规则中“用户消息总数/天数”的里程碑计数。剧情中的 NPC 信任不映射为真实用户信任。
- Reflection：登记确定性的故事结果/合格反馈触发入口。现有 `user_feedback` 名称有定义而无可达检测器，必须补实际生产路径；不能伪造 `GOAL_COMPLETED` 等领域事件来触发。
- Adaptive Self：仍由已接受反思和程序计算的有效根决定采纳；只更新已有三个槽位。习惯采纳不能改变 trust、人格、用户事实或世界事实。
- 预算和上限：沿用既有有界窗口、输入预算、每任务候选/调用限制、图遍历上限及上下文预算。WP0 核对实际数值，WP1 登记继承关系；调整必须有真实需求和单独设计依据。

故事结果评价规则须有固定版本、可解释条件和期望 delta。首版先覆盖合法合作、真实纠正、目标核对和拒绝/冲突等必要场景；不新增通用规则 DSL。结果标签来自合法世界提交及可信交互，模型输出只是待审解释。

### 3.5 消费、恢复与失效

世界提交与角色认知属于各自事件域。跨域消费复用现有任务/提案/提交机制，以确定性的消费身份、独立故事水位和恢复查询补齐一致性，不另起消息中间件。

必须证明“每个合格提交对每个消费者至多产生一次已提交影响”。世界已落盘而角色尚未消费时可恢复；角色提案已提交而水位尚未推进时，恢复须识别既有结果。失败不能提前推进成功水位，也不能因重试重复加情绪、关系或习惯。

对已保存的模型候选按冻结版本复核；重建投影不能重新调用模型或生成新的世界事件。任务捕获后来源失效、run/revision 不匹配、旧任务迟到时，提交前再次检查并拒收。

失效按依赖路径传播：撤回/更正/遗忘衍生记忆会使依赖它的反思和习惯失去资格；它不会物理删除原始世界历史。若用户撤回整段故事体验的认知使用资格，须有持久标记和读时屏蔽，防止 replay 绕过失效。退出剧情或换 run 不自动遗忘合法体验，也不自动复活已失效习惯。

### 3.6 入模与开关

沿用现有 Reflection / Adaptive Self 开关和默认值；故事认知消费入口需要受控启用，默认关闭。若现有开关无法单独控制该入口，WP1 只增加一个必要的故事认知总开关，名称和配置归属在 ADR 冻结，不增加整套可配置策略。

沿用 ContextCompiler 的有限习惯渲染。证据必须记录**裁剪后实际入模**的 slot、revision、有效来源及 section，而不是候选数量。预算不足、采纳未启用或来源失效时，不能声称模型已经获得习惯。

## 4. 工作包与退出条件

依赖顺序：`WP0 → WP1 → WP2 → WP3 → WP4/WP5 → WP6 → WP7 → WP8`。WP4/WP5 都依赖冻结接口及持久根；共享文件改动须协调，不据此自动创建并行代理或接管其他会话。

### WP0：记录基线与复用决定

**动作**：记录 HEAD、相关文件/迁移摘要、开关与预算、当前 S8 可达性；读取有效裁定和最新验收修订。列出其他会话改动及排除路径。完成上游组件许可证核对；只有拟直接复用的组件才做隔离本机探针。

**交付**：`S8-WP0-Baseline.md`、基线 manifest、现成组件“直接复用/方法参考/淘汰”表。

**退出条件**：故事根缺口和消费者缺口可定位；没有把旧 NOT RUN 写成实现完成；每个拟引用的既有命令确实注册。当前混合树被如实归属，未来证据可追到执行源版本。

### WP1：追加 ADR、契约与验收量具

**动作**：冻结 §3 的数据模型、来源资格、因果去重、真实会话、状态规则、触发、版本兼容、失效和开关；登记新迁移版本，在执行时取连续序号，**不预占 0012 或改旧 DDL**。列出封闭故事场景与独立标注的期望结果，冻结模型入口、预算、轮数和停止条件。

**涉及**：[processor.ts](../../src/kernel/contracts/processor.ts)、[proposal.ts](../../src/kernel/contracts/proposal.ts)、[domain-event.ts](../../src/kernel/contracts/domain-event.ts)、[memory.ts](../../src/kernel/contracts/memory.ts)、[reflection-input.ts](../../src/kernel/contracts/reflection-input.ts)、[reflection-lineage.ts](../../src/kernel/contracts/reflection-lineage.ts)，以及故事纯契约。

**交付**：新 ADR、`S8-Acceptance-Contract.md`、`S8-Measurement-Plan.md`、覆盖表和离线正控/负控设计。详细设计冻结状态如实记录。

**退出条件**：不存在“模型填根数”“故事充当对话”“多个观测多票”的漏洞；旧 decoder/投影语义兼容方案明确；量具能区分不可达、正确拒收、错误采纳和传输失败。人工标签未经审阅时不得自签为已冻结金标。

### WP2：实现故事持久提交与恢复

**动作**：追加 DDL；在许可目录实现账本端口/存储及观测→提交关联；接到现有世界选择提交入口和恢复入口。服务端保存可信参与者、交互归属、幂等身份，拒绝客户端自报“已合作/属于某用户”的权威字段。

**涉及**：[world-machine.ts](../../src/kernel/storyline/world-machine.ts)、[world-observation.ts](../../src/kernel/storyline/world-observation.ts)、[ink-runtime.ts](../../src/infrastructure/storyline/ink-runtime.ts)、[migrations.ts](../../src/infrastructure/persistence/migrations.ts)；新文件按许可目录创建。

**交付**：持久世界提交、兼容读取、隔离库迁移与真实进程重启证据。

**退出条件**：关闭进程后重新打开隔离库，提交、可见观测、revision 和折叠状态逐项对账；重复选择不重复提交；提交前/后故障恢复均无半条世界记录。旧来源无账本时拒收，不自动回填。

### WP3：接通持久根、提案引用与读取

**动作**：实现故事根读取；将新 kind 接入来源资格、提案和内部事件、lineage 图、SQL 查询及追踪。兼容旧的精确 story observation 引用；因果去重跨对话/故事/衍生节点生效。

**涉及**：[qualification-read.ts](../../src/infrastructure/persistence/qualification-read.ts)、[reflection-lineage-read.ts](../../src/infrastructure/persistence/reflection-lineage-read.ts)、[reflection/lineage.ts](../../src/kernel/app/reflection/lineage.ts)，以及 WP1 冻结的提案和来源契约。

**退出条件**：至少一个有效故事根能从真实落盘提交解析；隐藏、错版本、跨 run、跨用户、不存在和已撤回根均失败关闭；循环/超限仍拒收。同一次选择的全部衍生引用只计一个独立根，既有纯对话样例结果保持。

### WP4：接通 Affect 与 Relationship

**动作**：新增故事输入分支、封闭评价规则、资格与 validator 分支；调度端使用故事水位，继续走既有提案放行和状态折叠。故事源不增加旧对话消息里程碑计数。

**涉及**：[affect/evaluator.ts](../../src/kernel/app/affect/evaluator.ts)、[relationship/evaluator.ts](../../src/kernel/app/relationship/evaluator.ts)、[affect.ts](../../src/kernel/contracts/affect.ts)、[relationship.ts](../../src/kernel/contracts/relationship.ts) 及对应调度装配。

**退出条件**：合法实际合作能产生预期的非零情绪/关系更新，提案可追到原始故事根；隐藏作者设定、NPC 评价冒充用户、重复提交均零额外影响；既有范围、单次 delta、对话规则及 cutover 回归通过。

### WP5：接通 Reflection、有限采纳与实际入模

**动作**：实现故事结果/反馈的可达触发；构造有界输入；来源审查采用新根读取；已接受反思进入已有有限采纳流程。上下文编译记录裁剪后实际 slot/revision/来源。

**涉及**：[reflection/inputs.ts](../../src/kernel/app/reflection/inputs.ts)、[reflection/lineage.ts](../../src/kernel/app/reflection/lineage.ts)、[reflection/adaptive-self.ts](../../src/kernel/app/reflection/adaptive-self.ts)、[adaptive-self.ts](../../src/kernel/contracts/adaptive-self.ts)、现有 ContextCompiler 与装配入口。

**退出条件**：通过真实入口完成“3 独立根 + 2 真实会话 → 非零已接受反思 → 合法槽位更新 → 实际入模”。不得在正式正控中手填 accepted 状态、伪造来源计数或绕过 validator。2 根、1 会话、有冲突均明确拒收；开关关闭或 token 裁剪能如实显示未入模。

### WP6：失效、重复、恢复及迟到结果

**动作**：完成认知使用资格撤回、衍生依赖失效、重评/退役与读时屏蔽；注入跨域提交故障、水位故障、消费重试、来源竞态和真实重启。复用现有恢复纪律，不把失败状态当作有效采纳。

**退出条件**：失效后旧反思/槽位不再入模；replay、换 run、重启不复活；同一提交对各消费者至多一次已提交影响；投影 rebuild 与正常结果一致且不再调用模型；迟到结果不能覆盖新 revision。新的合法反馈可走新候选，不复活旧失效记录。

### WP7：语义和后续行为评测

**动作**：先验证量具，再按 §6 冻结批次运行隔离库真模型测量；采用同版本、同上下文条件的独立留出场景和 S8-A/B/C 三组。核对实际入模记录、响应、状态及来源，提交人工审阅材料。

**退出条件**：工程、语义、行为、长轨迹分别有有效读数；无来源泄漏或现实事实升级；不足门槛和失效对照有效。行为没有增益则记录未达标，不能以状态事件非零代替行为通过。

### WP8：回归、判定与交接

**动作**：完成 §7 的相关门与全量离线纪律；汇总有效证据而不回写旧失败档。提交架构、验收、已知限制、门判定、使用/恢复说明、激活候选。

**交付**：`S8-Architecture.md`、`S8-Acceptance-Report.md`、`S8-Known-Limitations.md`、`S8-Gate-Decision.md`、`S8-Activation-Candidate.md` 及逐 WP 交接单。

**退出条件**：§8 各槽独立报告；要求的验证均有正确归属；源版本变化后的旧证据不冒充当前证据。只提交本工作包路径，不收走 S7、语音或其他会话的改动。

### WP9：条件性生产激活

WP9 不因计划交付或工程通过自动执行。先完成迁移/恢复演练、配置差异、回滚和验收材料，再按既有规则取得真实库迁移、配置激活的明确授权。需要授权的理由是 AGENTS 的真实库迁移边界及现有激活流程，不是新增的泛化审批。

激活按“独占使用约束 → 已验证快照 → 受控授权执行 → 只读读回 → 首次真实使用观察”推进。开启后首轮实际消费/入模证据另报；配置成功不等于首次使用已验证。回滚停止故事认知新消费/注入，保留世界历史、内部事件及投影，不以删除数据回滚。

## 5. 离线门必须覆盖的正控与负控

| 编号 | 场景 | 必须观察到的结果 |
|---|---|---|
| S8-C01 | 一个提交有 3 个可见条目，产生记忆、领域事件及反思引用 | 独立根仍为 1；派生路径不能加票 |
| S8-C02 | 同一次选择同时有真实对话根和故事根 | 因果身份合并计数；来源 kind 保持各自身份 |
| S8-C03 | 3 次独立有效交互，跨 2 个真实会话，无冲突 | 满足采纳资格；真实反思/槽位链非零，实际入模可查 |
| S8-C04 | 2 根跨 2 会话；3 根只在 1 会话；多个 run 无真实会话 | 分别拒收，明确不足原因，零非法采纳 |
| S8-C05 | 根数足够但有未解决冲突或真实反馈撤回 | 不采纳；已采纳依赖正确失效/退场 |
| S8-C06 | 未选分支、隐藏条目、作者设定、模型虚构事件 | 不成为有效经历；不改变状态/习惯、不入模 |
| S8-C07 | 伪造用户、NPC 冒充用户、错版本/run、未知提交 | 资格拒收；不污染真实用户关系 |
| S8-C08 | `story_fact` 写入对话事件尝试；旧纯对话场景 | 前者仍拒绝；后者行为与既有契约一致 |
| S8-C09 | 世界提交成功后宕机；角色提交成功但水位未推进 | 重启恢复，不漏合法影响、不重复加状态 |
| S8-C10 | 同提交重试、相同快照重放、源任务迟到 | 至多一次影响；旧结果不能覆盖新状态 |
| S8-C11 | memory 更正/遗忘、故事资格撤回、退出与重开 | 依赖失效不复活；合法未撤回经历按契约保留 |
| S8-C12 | 开关组合、token 裁剪、候选模型失败/格式错误 | 不假报已入模/已采纳；失败计入失败率而非正确拒收 |
| S8-C13 | 真进程重启与纯投影 rebuild | 状态/水位/资格/上下文逐项对账，无新增模型调用 |
| S8-C14 | 同一剧情结果被追问为现实事实、用户履历或真实承诺 | 保留体验范围，不升级为现实权威事实 |

各门须包含非零正控、负控和恢复/边界控。只验证“全部拒绝”不能证明链路可用；只看到 evaluator 被调用也不能证明提案已合法提交。

拟新增以下验收入口；**它们当前未注册，需在对应 WP 落地后才可执行**：

| 拟定入口（`pnpm` 后缀） | 证据责任 |
|---|---|
| `postlv2:s8:baseline` | 基线、源版本和可达性，不宣告通过 |
| `postlv2:s8:contracts:verify` | 类型/边界、旧版本兼容、kind/actor 不混用 |
| `postlv2:s8:store:verify` | 隔离迁移、提交关联、事务、真实重启 |
| `postlv2:s8:roots:verify` | 根解析、因果去重、归属/可见性/失效 |
| `postlv2:s8:state:verify` | Affect/Relationship 合法更新与旧规则隔离 |
| `postlv2:s8:reflection:verify` | 真实触发、根门槛、采纳、裁剪后实际入模 |
| `postlv2:s8:lifecycle:verify` | 重试、水位、失效、rebuild、迟到结果 |
| `postlv2:s8:measurement:verify` | 金标、量具三段式、非零分母、请求计划 |
| `postlv2:s8:e2e:verify` | 隔离库真实入口全链正控/负控 |
| `postlv2:s8:semantic:eval` | 冻结语义集，分轮统计与来源合规 |
| `postlv2:s8:behavior:live` | S8-A/B/C，留出行为及实际入模 |
| `postlv2:s8:long:live` | 有界长轨迹、重启/失效/幂等观察 |
| `postlv2:s8:gates` | 只读聚合有归属的证据；缺失/失效如实拒收 |

可复用运行器基础设施并共用少量脚本，但独立 verdict 不能合并成一个无从区分的断言总数。注册入口时禁止用空脚本或恒 PASS 代替实现。

⏩ 2026-10-04 修订（只追加，原判定保留）：`postlv2:s8:*` 入口已注册于 `package.json:502-517`（共 **16** 条：`baseline` · `store:verify` · `contracts:verify` · `roots:verify` · `state:verify` · `reflection:verify` · `lifecycle:verify` · `measurement:verify` · `dev-probe` · `semantic:eval` · `semantic:recompute` · `gates` · `production:verify` · `activation-readback` · `activation-readback:db` · `withdraw:verify`）。

⚠️ 本表里**仍未注册**的草案入口：`postlv2:s8:e2e:verify` · `postlv2:s8:behavior:live` · `postlv2:s8:long:live`（对应行为槽 `S8-A43` = `NOT RUN`、短链 16 / 长轨迹 66 未跑）。依据：`S8-Gate-Decision.md` §0/§4。

## 6. 真模型测量、预算和停止条件

### 6.1 量具与判据

以下为**拟继承/采用的首版验收值，WP1 必须在看正式结果前冻结**：

| 面向 | 判据 |
|---|---|
| 机械来源安全 | 非法来源采纳、隐藏分支泄漏、伪对话写入、重复状态影响均为 0；正控必须非零 |
| 语义 | 最差轮 macro-F1 ≥ 0.80；采纳 precision ≥ 0.90；高风险拒绝 recall ≥ 0.95；引用及格式合规 ≥ 0.95；provider 失败率 ≤ 0.10 |
| 合法习惯使用 | 留出场景中 S8-B 合法使用率 ≥ 80%；无关场景过度使用 ≤ 10% |
| 行为增益 | S8-B 相对 S8-A 的合法使用率提高至少 10 个百分点；按槽位报告样本量和不确定性 |
| 退场及范围 | S8-C 无失效槽位实际注入；严重现实事实升级为 0；不能再以旧习惯为有效来源解释行为 |
| 生命周期 | 状态、来源、投影、水位对账通过；恢复不新增推断，不重复提交 |
| 延迟 | 本地来源复核 p95 ≤ 50ms，前台附加开销 p95 ≤ 100ms；规模、配置和测量边界同案记录，不将异步模型耗时偷换成前台阻塞 |

语义值参考 [M11.1 契约](../m11.1/M11.1-Acceptance-Contract.md)；本工作包有独立故事语料和证据归属。不得声称这组读数关闭了 M11.1 的历史 FAIL/INVALID/NOT RUN。

模型引用的根是否有效由程序核实；语义评测只评价待审解释与有限槽位选择。传输失败、空输出、无可达触发须单列，不当作“安全拒收”提高分数。金标和量具须独立于候选输出，未经人审时记录待审。

### 6.2 S8-A/B/C 对照

- **S8-A**：同样的合法经历和对话背景，未采纳目标习惯。
- **S8-B**：通过真实反思/审查/采纳链获得有效目标习惯，并确认实际入模。
- **S8-C**：从 B 的有效状态出发，按真实撤回/失效流程使该习惯退场，再进行对照。

三组使用同 provider/model/参数和冻结的留出问题；不在留出问题中提示“请遵守某习惯”。准备数据与观察者标签隔离，不手工把 B 标成 accepted。记录来源根、真实会话、采纳 revision、裁剪后上下文和响应。S8-C 用于检验退场；不要求它比 A 表现更差。不能复用 M11.1 其他 A/B/C 组名的含义或历史读数。

### 6.3 初始请求计划

下表是规划上限，**本轮未启动、未消耗，也不代表可自动重跑**。WP1 冻结每个入口后由 dry-run 核对；状态评价首版为程序规则，不额外增加 appraisal 模型调用。

| 批次 | 设计 | 初始最大模型请求数 |
|---|---|---:|
| 开发探针 | 最多 12 个候选请求，核对输入/输出/放行形状 | 12 |
| 正式语义 | 48 项 × 3 轮：18 项合法（三槽各 6），30 项风险/不足/范围负控 | 144 |
| 真模型短链 | 8 条 ×（1 次候选 + 1 次后续回复） | 16 |
| 留出行为 | 三槽 × 6 项 × 三组 × 3 次重复 = 162 次回复；三槽各最多 3 次准备候选 | 171 |
| 有界长轨迹 | 三槽各 20 轮 = 60 次回复；合计最多 6 次额外候选 | 66 |
| **合计** | 每个出站请求均落统计；没有隐含自动重试额度 | **409** |

6 个留出项/槽至少包含 4 个相关项、2 个无关项；逐槽与总体分别报告。60 轮长轨迹用于本版 S8 生命周期观察，不替代 M11.1 已有长轨迹门。轮数和调用数是规划值，不是成功率或已观测运行时间。

若真实入口需要更多准备调用，dry-run 必须暴露并更新请求计划，不能隐藏在“准备步骤”中。需要付费调用时使用既有测试模型入口与隔离数据；不得借本计划复用此前未批准的 M11.1 额外批次额度。

停止规则：机械门或量具未通过，不开始正式语义/行为批次；探针发现结构不可达先修复；格式/传输连续失败先记录并查明原因。正式批次未达标，保留原档，定位具体机制或来源问题，再登记修复及新批次，不通过改标签、改阈值、无限扩样或择优选轮宣布成功。

模型等待、人工复核和修复轮数无法在编制时保证。本计划采用工作包退出条件安排进度；没有将其他里程碑的旧截止日期自动当成本工作包的新交付承诺。

## 7. 隔离、相关回归与冻结面

所有实验使用 [sandbox.ts](../../src/dev/sandbox.ts) 建立隔离库；真实库副本按既有只复制规则取用。新迁移验证先在空库及副本完成，不打开真实库应用 DDL。已发布迁移只能追加，真实库迁移按 WP9 独立授权。

当前已注册、实施时按改动面执行的回归入口：

| 改动面 | 必须执行的相关门 |
|---|---|
| 所有代码改动 | `pnpm typecheck`；最终交付 `pnpm m4.5:ci` EXIT 0 |
| Kernel、对话来源、迁移与资格 | `pnpm kernel:test`；`pnpm kernel:verify`；`pnpm kernel:test:conversation`；`pnpm m5.1.1:migration:verify`；`pnpm m5.1.1:wp3.2:verify` |
| Memory/Evidence 追加与失效 | `pnpm m4:test`；`pnpm m4:verify`；`pnpm m4:mutation-safety:verify`；`pnpm m4:nl-mutation:verify`；`pnpm eval:m4`；`pnpm memory-coverage:verify` |
| Relationship | `pnpm m7:test`；`pnpm m7:measurement:verify`；`pnpm m7:e2e:verify` |
| Affect 与语义兼容 | `pnpm m8:wp2:contracts`；`pnpm m8:wp3:verify`；`pnpm m8:wp4:verify`；`pnpm m8:wp5:verify`；`pnpm m8:wp6:verify`；`pnpm m8:e2e:verify`；`pnpm m8:long:verify`；`pnpm m8.5:test`；`pnpm m8.5:verify`；`pnpm m8.5:e2e:verify`；`pnpm m8.5:long:verify` |
| Reflection / Adaptive Self | `pnpm m11:lineage:verify`；`pnpm m11:inputs:verify`；`pnpm m11:policy:verify`；`pnpm m11:adaptive:verify`；`pnpm m11:invalidation:verify`；`pnpm m11:recovery:verify`；`pnpm m11:context:verify`；`pnpm m11:measurement:verify`；`pnpm m11:observability:verify`；`pnpm m11:e2e:verify`；`pnpm m11:long:verify` |
| M11.1 共同装配与量具 | `pnpm m11.1:wiring:verify`；`pnpm m11.1:recovery:verify`；`pnpm m11.1:e2e:verify`；`pnpm m11.1:measurement:verify`；`pnpm m11.1:source:verify`；`pnpm m11.1:joint:verify` |
| 既有 World / 故事来源 | `pnpm postlv2:story:verify`；`pnpm postlv2:source:verify`；`pnpm postlv2:world:verify`；`pnpm postlv2:source-root:verify`；`pnpm postlv2:bridge:verify`；`pnpm postlv2:transport:verify`；`pnpm postlv2:db:verify` |

WP0 对照执行当时的脚本注册表补齐/调整以上清单。既有来源根诊断若锁定旧“不支持故事根”读数，保留历史事实，在新 S8 门加入支持后的正控并明确新旧适用范围；不能删除防止故事伪对话的负控。

Memory 冻结语义、旧 payload、旧 migration、seed 不在重构范围。因追加 story kind/引用而触达冻结文件时，按新里程碑 ADR 及对应 M4 纪律验证；不借接线重写既有折叠。若确实发现必须改变冻结语义，先登记独立变更范围及证据，不静默纳入。

全量离线门完成后，生产副本 Live Smoke 是否需重跑由装配影响与 WP1 请求计划列明；需要时使用 `pnpm with-test-model pnpm m4.5:ci:full`，单列预算和归属，不从 409 次里隐含扣除，也不在文档编制阶段启动。

## 8. 证据、交付判定与能力影响

每份 run manifest 至少记录源版本/相关摘要、契约/规则/语料/量具版本、配置形状、隔离库身份、正式结束时间、分母、请求数、结果与适用范围。按 manifest 身份和当前契约选证据，不能靠目录 mtime 取“最新绿档”。

原始故事文本、候选/回复和金标放入既有忽略目录 `artifacts/post-lv2/local/`；可入库的证据只保留必要的程序字段、匿名场景 ID、来源身份、版本、计数与判定。不得把 API 凭证、私人原文或模型内部思考链写入报告/trace。

最终判定分列以下 14 槽，不用一个断言总数替代：

| 槽 | 本轮计划交付时的状态 | 实施验收要求 |
|---|---|---|
| 设计 | 总体方案同意；详细设计待冻结 | 新 ADR 与验收契约有明确状态 |
| 实现 | NOT STARTED | 世界根及三类消费者全部可达 |
| 机械硬门 | NOT RUN | 正控非零，负控及恢复全通过 |
| 量具有效性 | NOT RUN | 三段式、有效金标、非零分母 |
| 语义评估 | NOT RUN | §6 冻结的语义判据 |
| 行为增益 | NOT RUN | 有效 S8-A/B/C 及增益读数 |
| 真实短链 | NOT RUN | 隔离库、真实入口、真模型 |
| 有界长轨迹 | NOT RUN | 三槽、失效/重启/幂等证据 |
| 隐私与来源边界 | NOT RUN | 隐藏内容/现实升级/非法来源零越界 |
| 回归 | NOT RUN | 相关门和完整离线纪律 |
| 人工复核 | NOT RUN | 金标/语义/行为材料的真实裁定 |
| 生产激活 | NOT REQUESTED | WP9 授权与激活读回独立记录 |
| 首次真实使用 | NOT OBSERVED | 实际消费、状态与入模观察 |
| 能力影响登记 | 计划值已列 | 按最终实现登记并复核 |

S8 工程完成可以先于生产激活。完整 S8 能力通过要求工程、量具、语义、行为、生命周期及相关回归取得有效证据；生产未激活仍单列。没有行为增益时，只能报告已接通/未达完整行为标准。

| 能力/配置影响 | 本工作包计划 |
|---|---|
| 新外部 ActionRequest / 应用 / MCP 能力 | **NONE** |
| 新模型 provider / 新 agent 运行时 | **NONE**；沿用现有测试/生产入口 |
| 新依赖 | 首版 **NONE**；组件直接复用若发生，另记版本/许可证/探针 |
| 本地世界持久化 | 追加事件账本、必要关联及迁移 |
| 本地认知输入 | 增加受控故事输入、根读取、三类消费者消费 |
| 模型调用影响 | 合格故事触发可进入既有反思候选链；有界请求计划，不后台无限运行 |
| 人格/习惯范围 | seed 不改；已有有限槽位和状态边界保持 |
| 生产开关/真实库 | WP9 独立激活；默认值与回滚在新 ADR 冻结 |

## 9. 首个可执行交接

后续实施从 WP0 开始：记录当时的源码/共享树与迁移基线，完成复用决定和新增门登记设计；随后 WP1 冻结持久身份、因果独立性和真实会话契约。第一份可审查的工程结果应是“隔离库提交一个真实故事选择，关闭进程后能恢复并解析到一个有效故事根”，再继续三类消费者。

本计划没有把 S8 缺口改写成已完成。它给出的是可以逐包实施、逐门验收、独立生产激活的建设路径。
