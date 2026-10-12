# M7 Relationship —— 关系状态演化执行计划书

> 日期：2026-09-26  
> 状态：**PLAN READY / IMPLEMENTATION NOT STARTED**  
> 主线：`M6.1 → M7 前置质量包 → M7 Relationship → M8 Affect → M9 Belief → M10 Goal → M11 Reflection → Lv2 入口裁定`  
> 本计划不授权生产激活、真实库变更、迁移、合并、打标签或 Level 2 能力接入。

## 0. 里程碑判定目标

M7 的唯一主目标是完成原始 Lv1 的 **O-2「状态演化影响行为」**，并把它实现为可追溯、可重放、可降级的 Relationship 内核：

```text
真实互动证据
  → RelationshipImpactProposal
  → Validator / Policy
  → DomainEvent
  → Reducer / Projection
  → RelationshipState(owner → target)
  → ContextCompiler
  → 用户可见行为
```

M7 要回答的不是“她有没有一个 trust 字段”，而是：

1. 哪一条真实互动证据可以改变她对某个目标实体的关系状态；
2. 变化由谁提出、由谁放行、由什么事件记录；
3. `trust` 与 `closeness` 如何分别演化、如何随时间衰减、如何解释当前行为；
4. 重启、重放、重复投递、失败和缺证据时，系统是否仍然说真话。

M6 的 `Original Lv1 = PARTIAL` 必须保持到本里程碑验收完成；不能用 M6 或 M6.1 的 PASS 覆盖它。

## 1. 依据与已吸收的网页版决定

### 1.1 仓库权威依据

- [`README.md`](../../README.md)：原始 L1-M3 状态演化延期并入 M7 Relationship；M7–M11 在 Level 2 前优先。
- [`M6-Gate-Decision.md`](../m6/M6-Gate-Decision.md)：M6 工程验收 PASS，但 Original Lv1 仍 PARTIAL。
- [`M6.1-Gate-Decision.md`](../m6.1/M6.1-Gate-Decision.md)：M6.1 PASS；M6-FMB-01 已按“可查 / 可审计 / 可测”销账，长程回忆衰减和更正渐蚀仍是新登记。
- [`M6.1-and-Later-Technical-Debt-Plan.md`](../m6.1/M6.1-and-Later-Technical-Debt-Plan.md)：TD-06/07/16 属于 M7 前置质量包；TD-08/09 在 M7 数据规模准入时复核。
- [`M6.5-Lv2-Capability-Integration-Plan.md`](../m6.5/M6.5-Lv2-Capability-Integration-Plan.md)：`PERSONALITY_FIRST_BEFORE_LV2`；M7 不提前接代码执行、微信/QQ、后台任务或桌面控制。
- [`future-compatibility.md`](../architecture/future-compatibility.md)、[`ADR-018`](../adr/ADR-018-perspective-ownership.md)：关系必须采用 `owner → target`，不能写成 `userTrust`；未来模块必须保留 perspective owner。
- [`src/state/types.ts`](../../src/state/types.ts)、[`src/state/decay.ts`](../../src/state/decay.ts)：已有关系底座是 `trust` / `closeness`，有单轮变化上限和挂钟衰减，但当前对话内容尚未形成经过 M7 验收的关系演化链。
- [`assistant-fact-firewall.md`](../architecture/assistant-fact-firewall.md)、[`source-provenance.md`](../architecture/source-provenance.md)：`DIRECT_INTERACTION` 可以作为关系 / 情绪的证据，但助手生成不能自动成为外部事实或共同经历。

### 1.2 网页版及相关对话中已确认的要求

本计划吸收了以下对话中的决定；对话中的愿景只有在与仓库权威文档一致时才进入正式范围：

| 对话来源 | 已吸收的决定 |
|---|---|
| `项目优势分析` | 面试展示只能是核心系统真实能力的观察窗口；不能为了展示价值改写核心架构、绕过正式生命周期或制造特殊行为。 |
| `记忆是否共通` | 仓库内必须保持单一权威源；不能再造互相冲突的项目状态文档。 |
| `苏沐薇人类测试大小规律` | 将来的人类/AI 区分测试必须建立在真实长期行为能力上；M7 只建设关系能力，不为测试预造脚本化人格。 |
| `M5.1阶段进展总结`、`M5.1执行计划书` | 归因、事实资格和失败关闭优先；尚未完成的能力不得因其它门通过而被宣布完成。 |
| `梳理情绪功能建设计划` | M8 Affect 尚未开工；M7 负责关系状态，不提前把自动情绪演化塞进本里程碑。 |
| `评估管理面板排期阶段` | M7 可提供验收所需的只读状态/事件读回；完整 Developer Console v2 不属于 M7 必交付。 |
| `确认苏沐薇多模态能力` | Level 2 前人格建设优先；应用能力保留在路线中，但不在 M7 接入。 |
| `统计Level一至二阶段剩余里程碑` | M7 是主路线图中的 Relationship 里程碑；旧 L1-M3 状态演化不另算，已并入本计划。 |

## 2. 当前基线与准入条件

### 2.1 当前已经存在

- `CharacterState` 已有 `trust`、`closeness`、版本号、互动时间和确定性行为映射。
- `trust` 与 `closeness` 已被刻意分开；单轮变化有上限，时间衰减是纯函数。
- 真实对话、记忆、归因、上下文和执行账本已有各自边界；M7 必须复用这些边界。
- M6.1 已建立针对无据回忆、诱导补造、纠正和长轨迹的测量纪律；M7 不能退回到只看“像不像她”的文风评测。

### 2.2 M7 开工前必须完成或明确接收

| 条目 | 处理方式 | 未满足时的后果 |
|---|---|---|
| TD-06 当前输入响应 / 复读 / 话题挟持 | 作为 M7 前置质量包，先冻结定义、量具和基线 | 关系变化可能被错误的旧话题命中；不得直接进入产品门 |
| TD-07 权威历史视图 | 在 M7 读取历史证据前完成最小核验 | 错误角色或顺序不能作为关系证据 |
| TD-16 文档状态对账 | 在 M7 计划与验收文档中登记当前/历史/取代关系 | 只要状态来源冲突，M7 总判定不得 PASS |
| TD-08/TD-09 召回规模与歧义 | WP0 做准入实验；只有证明会漏掉关系所需证据时才前移修复 | 若阻断关系验收，M7 保持 BLOCKED，不用向量库或放宽目标确定性绕过 |
| M6.1 长程回忆衰减 / 更正渐蚀 | 作为已知风险接收并设计负控；不把它改写成 M7 已解决 | M7 只能声明关系链读数，不能声明长期记忆已稳定 |

## 3. 范围

### 3.1 必须完成

1. **关系键与所有者**：以 `EntityRelationKey { owner, target }` 表达关系；第一阶段至少支持“苏沐薇作为 owner、用户作为 target”，类型上不得把 user 写死。
2. **关系状态**：至少实现 `trust` 与 `closeness` 两个独立维度，并保留版本、时间、来源事件和当前投影所需的最小审计字段。
3. **互动证据**：只有受信的真实直接互动事件能作为关系变化依据；助手自述、模型猜测、未确立归因、外部工具返回和摘要文本默认不能直接推动关系。
4. **提案与放行**：模型或规则只能生成有来源的 delta 提案；不能直接写状态。所有变化都必须经过既有 `Proposal → Validator → DomainEvent → Reducer → Projection` 链。
5. **变化规则**：单轮上限、范围约束、幂等键、并发/重复事件处理、无证据拒绝和失败关闭必须是程序判据，而不是 prompt 承诺。
6. **时间行为**：把现有挂钟衰减纳入关系契约，明确 trust 与 closeness 的不同时间语义；缺省不能因“回来聊天”自动抹平历史变化。
7. **行为接线**：当前关系投影经唯一 ContextCompiler 入口影响语气和行为倾向；上下文只读派生状态，不把关系状态伪装成世界事实或用户新记忆。
8. **重启与重放**：状态必须能从事件重放；重启、重复投递和乱序输入的处置要有明确结果，不靠进程内计数器或最近窗口猜测。
9. **可解释读回**：每次有效变化都能回答“哪条互动、哪个提案、哪个规则、哪一次投影导致当前值”；拒绝和未判定也要留下可审计的原因。

### 3.2 明确不做

- M8 的自动情绪演化（不在 M7 根据对话改变 `valence` / `arousal`）。
- M9 Belief、M10 Goal、M11 Reflection。
- 世界模拟、NPC 管理器、多角色运行时、地点/库存/物理系统。
- 自动长期记忆抽取、向量库、新记忆后端、通用反幻觉系统。
- 代码执行、GitHub、微信/QQ、邮件、浏览器、后台调度、桌面自动化和云部署。
- 为面试单独制造的特殊 case、假数据或专用核心接口。
- 完整管理面板产品化；如验收需要，只做只读状态与事件读回。

## 4. 设计不变量

### 4.1 关系不是事实，关系也不是记忆

RelationshipState 表示“某个 owner 对某个 target 的当前关系投影”。它不是世界真相，也不是 `MemoryRecord`。关系变化必须引用真实事件，但引用事件不等于把事件内容自动写入长期记忆。

### 4.2 生成不是发生

```text
模型输出“我很生气 / 我们以前经常这样”
  ≠ 关系已经改变
  ≠ 共同经历已经成立
```

助手生成只能作为待审计的 `CHARACTER_GENERATION`；它不能单独证明用户做过某事、关系曾经达到某值，或某次互动真实发生过。

### 4.3 关系变化不能绕过归因与认知资格

M7 只接收既有 trusted ingress 产出的事件视图。`USER_EXPLICIT`、`USER_REPLY_CONFIRMATION`、`DIRECT_INTERACTION` 等语义必须按既有归因契约解释；调用方自报 actor、authority、source 或 owner 一律拒绝或降为 Unknown。

### 4.4 关系维度不可合并

`trust` 与 `closeness` 必须能表达“很亲近但不信任”和“信任但不亲近”两种不同状态。任何单一“好感度”替代都会让行为解释和后续 M8/M9 失去依据。

### 4.5 失败口吻必须与状态事实一致

提案被拒绝、目标不明确、证据不足、写入失败、重放不一致时，回复不得使用“已经改变”“我记住了”“我们以前就这样”等成功或共同经历口吻。

## 5. 工作包与出口

| WP | 工作包 | 主要产出 | 出口条件 |
|---|---|---|---|
| M7-WP0 | 前置质量与准入 | TD-06/07/16 接收记录；TD-08/09 准入实验；M6.1 残余风险表；干净基线 | 所有阻断风险有明确处理；否则 `BLOCKED` |
| M7-WP1 | 关系语义与 ADR | M7 ADR；owner/target、trust/closeness、证据等级、时间语义、允许/禁止主张 | 用户裁定后冻结；不在实现中临时改语义 |
| M7-WP2 | 合同与事件形状 | RelationshipState、ImpactProposal、DomainEvent、拒绝理由码、版本/幂等形状 | `EntityRelationKey` 静态检查通过；无 `userTrust` 等写死形状 |
| M7-WP3 | 关系证据与提案器 | 真实互动识别、规则/模型提案、证据绑定、Unknown/拒绝分支 | 助手生成和外部观察负控不产生关系变化；提案不得直接落库 |
| M7-WP4 | Validator / Reducer / Projection | 有界 delta、放行口、事件重放、版本与并发处理、时间衰减接线 | 正控、越权负控、重复/乱序/失败恢复全部有测量 |
| M7-WP5 | Context 与行为接线 | 关系状态唯一注入块；trust/closeness 联合行为规则；只读 Inspector/读回 | 生产装配与验收装配一致；上下文不越界、不制造共同经历 |
| M7-WP6 | 真实链路与长轨迹 | 隔离库 + 真 TurnGateway；短场景、长轨迹、重启恢复、人工盲审包 | Level 1 回复与 Level 2 事件/投影/来源逐项一致；失败不伪装成通过 |
| M7-WP7 | 规模、回归与收口 | 规模证据、全量回归、Gate Decision、Acceptance Report、Known Limitations、Handoff | 所有主张分列；Original Lv1 仅在本门满足后更新为完成候选 |

## 6. 最小场景集

WP1 冻结完整语料前，至少保留以下场景族；每族都要有正控、负控和恢复/拒绝路径：

1. 初始关系建档：owner/target 正确，默认值有来源，不因模型自述改变。
2. 可靠互动：有真实直接互动证据，信任或亲近按有界 delta 变化。
3. 失约/伤害：trust 下降而 closeness 不被错误清零。
4. 长期陪伴/修复：closeness 与 trust 可分别恢复，不能一轮跳满。
5. 长时间无互动：只触发契约规定的时间衰减；回归后不自动恢复全部关系。
6. 很亲近但不信任、信任但不亲近：联合行为映射不合并两个维度。
7. 助手虚构共同经历：不得推动关系，也不得在回复中把它说成真实历史。
8. 工具/搜索/系统事件：外部观察默认不是关系事实；没有关系授权不得写入。
9. 多目标关系：第二个 target 的读写与第一目标隔离；不能把最近用户当目标。
10. 重复、乱序、重启：事件幂等、版本单调、投影可重放，失败关闭且可恢复。
11. 纠正或撤回：保留旧事件与取代关系；当前投影只消费合格的有效状态。
12. 长轨迹：至少复用一条与 M6.1 长轨迹同等级的连续性验证；具体轮数、预算和模型在 WP1 冻结，不用重跑到满意为止。

## 7. 验收与证据门

### 7.1 机器门

- **Contract Gate**：owner/target、状态维度、来源字段、受控枚举、拒绝理由码和 `scope` 结构正确。
- **Boundary Gate**：kernel 依赖方向、无基础设施反向依赖、无 `userTrust` 写死形状、无 LLM 直写状态。
- **Projection Gate**：事件删除后可从事件重放出一致投影；重复事件不重复改变状态；版本与幂等键稳定。
- **Evidence Gate**：每个有效变化都有受信 source event；助手生成、外部观察、Unknown 和缺证据负控均不改变关系。
- **Behavior Gate**：同一关系状态在上下文中得到确定性解释；trust/closeness 联合规则不回归。
- **Recovery Gate**：写入失败、进程重启、超时、乱序、目标歧义和非法 delta 都失败关闭并可读回。

### 7.2 Level 1 / Level 2

| 证据等级 | M7 必须证明 |
|---|---|
| Level 1 | 用户实际看到的回复会随合法关系状态变化；拒绝、失败和无证据时回复诚实。 |
| Level 2 | 同一 `conversationEventId` / `requestId` 关联提案、DomainEvent、投影版本、Context 选择和读回结果；字段逐项一致。 |

机器分数不能覆盖真人复核。真人复核至少检查：关系变化是否符合事件事实、是否把助手自述当共同经历、是否把 trust 与 closeness 混为一谈、是否在失败后仍使用成功口吻。

### 7.3 建议命令集合

具体脚本名在 WP1 冻结；最低应覆盖：

```text
pnpm typecheck
pnpm kernel:test
pnpm kernel:verify
pnpm m4:test
pnpm m4:verify
pnpm m5:test
pnpm m5:verify
pnpm m7:test
pnpm m7:measurement:verify
pnpm m7:e2e:verify
pnpm m7:gates
pnpm m4.5:ci
pnpm m4.5:ci:full
```

任何涉及 prompt 组装、状态接线或用户可见回复的改动，必须增加生产等价 Live Smoke；没有真实模型读数时只能标 `NOT RUN`，不能用离线结果冒充。

## 8. 能力影响矩阵

| 项目 | M7 判定 |
|---|---|
| 复用能力 | 既有 Character Kernel、trusted attribution、DomainProposal、Policy/Validator、事件/投影、ContextCompiler、Level 1/2 证据链。 |
| 新增外部能力 | **NONE**：不新增应用、网络、代码执行、浏览器、微信/QQ、后台任务或桌面控制。 |
| 权限与副作用 | **NONE（外部副作用）**；只在隔离库或获授权副本上产生内部关系事件。真实库迁移/写入必须另行逐字授权。 |
| 认知边界 | 关系状态是 owner 视角的内部投影，不是外部事实，不自动成为长期记忆；所有变化需有来源事件和资格。 |
| 回滚与恢复 | 事件 append-only；拒绝、失败、重放和投影错误均可读回；不物理覆盖旧事件。 |
| 验收证据 | Level 1 回复 + Level 2 事件/投影/上下文关联 + 正控/负控/恢复 + 真人盲审。 |
| 面板/展示 | 只允许复用已有只读 Query/Inspector 观察 M7 证据；完整 Console v2 不作为 M7 依赖。 |

## 9. 风险与停止条件

### 9.1 主要风险

- **长期记忆残余**：M6.1 已登记长程回忆衰减和更正渐蚀；M7 不得把关系读数冒充为记忆问题已解决。
- **旧状态模型冲突**：`src/state/types.ts` 的历史 `character × user` 形状不能直接成为新的通用关系契约；优先做兼容桥和影响半径审查，不静默重写旧迁移。
- **模型提案漂移**：模型可以提出 delta，但不能拥有 authority；所有超界、缺证据和目标歧义必须被程序拒绝。
- **关系与情绪混淆**：M7 不改变 `valence` / `arousal`；若行为需要二者联动，必须通过只读输入并把变化归属留给 M8。
- **规模漏证据**：若最近 50 条截断或目标歧义会影响关系判定，先修准入问题，再进入 M7 产品门。

### 9.2 立即停止条件

命中任一项，当前 WP 停止并形成交接，不继续重跑到绿：

1. 出现无 provenance 的关系事件或调用方自报 authority 被接受；
2. 助手生成能够单独改变关系或建立共同经历；
3. `userTrust` 等写死目标形状进入新契约；
4. 真实库被未授权打开、写入或迁移；
5. Level 1 与 Level 2 关联不一致；
6. 失败、超时、拒绝或目标歧义后仍产生成功口吻；
7. 机器量具与真人证据冲突而没有单独裁定；
8. 为了面试、演示或 UI 方便绕过正式关系生命周期。

## 10. 交付物与最终主张

### 10.1 必交付物

- M7 关系语义 ADR 与 unresolved decisions 记录。
- 关系合同、事件/提案/拒绝理由码和迁移/兼容说明。
- 关系证据、验证器、reducer、projection、Context 接线与只读读回。
- 隔离库证据、Level 1/Level 2 关联证据、负控和恢复证据。
- 短场景、长轨迹、重启/重放和真人复核材料。
- `M7-Acceptance-Report.md`、`M7-Gate-Decision.md`、`M7-Known-Limitations.md`、`M7-Handoff.md`。

### 10.2 允许的最终主张

只有在 M7 Gates、全量回归和真人复核均满足后，才能主张：

```text
M7 Relationship = PASS
Original Lv1 O-2 = SATISFIED（按本计划定义的范围）
关系状态变化可追溯、可重放、可审计，并会影响用户可见行为。
```

仍不得顺带主张：她“再也不会编造”、长程记忆完全稳定、M8 情绪已经完成、Level 2 能力已经接入、后台自主任务已经实现，或所有外部事实都能被逐句验证。

### 10.3 关闭后交接

M7 关闭后进入 M8 Affect；M9 Belief 之前必须复核 TD-08 召回规模与 perspective owner；M10/M11 继续沿用本计划的 owner、provenance、事件重放和能力影响矩阵。Level 2 能力包继续排在 M11 与入口裁定之后。

