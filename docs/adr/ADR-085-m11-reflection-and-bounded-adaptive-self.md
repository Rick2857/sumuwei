# ADR-085：M11 反思与有限自适应自我（设计裁定）

> 状态：**ACCEPTED / DESIGN FROZEN**（2026-10-01，用户批准，逐字引文见 §0.1）
> 计划源：[`M11-Execution-Plan.md`](../m11/M11-Execution-Plan.md) §5（D01–D24）· §6（数据模型）· §7（慢路径与装配）· §8（回复事实与隐私）· §11（阈值）
> 基线输入：[`M11-WP0-Baseline.md`](../m11/M11-WP0-Baseline.md)（WP0 的代码指针与实测读数）
> 验收契约：[`M11-Acceptance-Contract.md`](../m11/M11-Acceptance-Contract.md)（与本 ADR 同批送审）
> 未决项：[`M11-Unresolved-Decisions.md`](../m11/M11-Unresolved-Decisions.md)（**只**登记不影响授权 / 采纳 / 失效 / 遗忘语义的项）
> 纪律：本 ADR 冻结**语义与边界**；实现命名由工程处理。判据变更 = 本 ADR 修订 + 前后读数。

---

## 0. 授权依据与状态

M11 由 [`M11-Execution-Plan.md`](../m11/M11-Execution-Plan.md) 立项（提交 `b368c557`）。
WP0 于 `7176c51f` / `e5028472` 完成并出基线报告（27/31 项判据全 PASS）。

用户 2026-10-01 两项排期裁定：① **M11 现在推进**（不视为抢占 M9.5 的 D-6 记忆体量线）；
② **M11 分支更新到当前 `main` 再开工**（已 `git rebase`，`main` 未被动过）。

**本 ADR 不授权**：生产激活（WP12 独立裁定）· 合并 / 打标签 · 真实库迁移或恢复 ·
新增任何外部能力 · 修改 Seed 内容或版本 · 修改任何历史验收档或既有域（Memory / Belief / Goal）的语义。

### 0.1 用户设计裁定（**逐字登记**，2026-10-01）

```text
R-M11-01（2026-10-01）—— 用户原话（**逐字**，不得改写）：

    「我同意你刚才说的五项方向.继续进行」
```

**这次批准覆盖什么**（本节的解释文字不是引文）：

| # | 送审事项（登在 [WP1 交接单 §2](../m11/M11-WP1-Handoff.md) 与本文 §10 末段） | 状态 |
|---|---|---|
| 1 | 三个行为槽的语义（`D09` / §4.6） | ✅ 按**推荐值**批准 |
| 2 | 稳定采纳门槛：≥3 个有效独立根、≥2 个会话、无未解决直接冲突（`D10`） | ✅ 按推荐值批准 |
| 3 | 阈值与上限全集（`D30`：50 条 / 6000 token / 1 条 draft / 300 汉字 / 深度 16 / 节点 64 / 20 s / 1 次请求 / 预算 300·上限 800） | ✅ 按推荐值批准 |
| 4 | 事件族形状与生命周期（§4.2 / §4.3：5 事件 · `REFLECTION_REVIEWED` 不拆 · `rejected`/`retracted` 不许翻案） | ✅ 按推荐值批准 |
| 5 | 两个开关名与缺省（`D19` / §4.8，代码缺省均 **false**） | ✅ 按推荐值批准 |

```text
⇒ 其余裁定（D01–D08 · D11–D29 · D31–D34）我给出的口径是"按计划建议冻结；**有异议的请逐条指出**"，
   用户**未提出异议**并指示"继续进行" ⇒ 一并冻结（**不回写**成"用户逐条批准了 34 项"）。
⇒ "继续进行" = 授权进入 **WP2**（来源链与根解析）。
```

**本节的授权边界**（与 §0 的"不授权"一致，逐项重申）：

```text
✅ 授权：M11 的实现工作（WP2 起）按本 ADR 与验收契约推进。
❌ 不授权：生产激活 · 合并 · 打标签 · 真实库迁移或恢复 · 新增外部能力 · 开 Lv2。
❌ 不授权：把本 ADR 的裁定当成"永不可修订" —— 修订仍需本 ADR 修订 + 前后读数。
```

**本 ADR 的冻结是"语义与边界"的冻结**（§0 的纪律行逐字有效）：实现命名由工程处理；
判据变更 = 本 ADR 修订 + 前后读数。

---

## 1. 背景：M11 在认知域分离中的位置

M10 的六域分离（ADR-076 §1）在 M11 之后成为七域。M11 回答的问题与它**不能**替代的东西：

| 域 | 回答的问题 | M11 不能拿它替代什么 |
|---|---|---|
| Memory（M4） | 她有资格长期记住什么 | 反思**不是**记忆；不自动写长期记忆 |
| Belief（M9） | 她当前相信什么、依据是什么 | 反思**不扩大** inferred 槽、不自创用户心理判断 |
| Goal / Commitment（M10） | 她准备追求什么、正式承担了什么 | 反思**只提议**修订；不改写接受历史 |
| Affect / Relationship（M8 / M7） | 她此刻的情绪与关系状态 | 反思**不改**情绪强度、信任、亲密度 |
| **Reflection（M11）** | **根据经历，她对自己此前的判断形成了什么可审查的解释** | **不是事实、不是授权、不是人格参数** |
| **Adaptive Self（M11）** | **在封闭的三个行为槽上，她当前的处置方式是什么** | **不是 Seed 的替代品，不是任意系统指令** |

> 「用户有三次提醒我对象不明确」是**经历**；
> 「我形成了『遇到歧义先澄清』的处置习惯，依据是这三条」是**反思与策略**；
> 「用户不喜欢被追问」是**关于用户的判断** —— 它需要 M9 的资格，M11 无权生产。

### 1.1 WP0 的基线结论（本 ADR 的设计输入，不是背景装饰）

| WP0 事实（`L-M11-*`） | 本 ADR 的落点 |
|---|---|
| `causedByDomainEventIds` 类型已预留、**读回已映射**、但写入路径固定 `null`，且提案层与校验层不传递（`L-M11-06` 同族） | **D05 / D18**：WP2 只**追加**贯通（零迁移），且"字段存在"**不得**被读成"来源链已具备" |
| 三处记录漂移：计划 §1.2 说 `mode=shadow`，生产实为 `mode=on`；M9.5 交接 §4 与 `AGENTS.md`（v9）同样过期（`L-M11-01`） | **D14 / D24**：语义召回的**当前**能力面按实测读数走；本 ADR 不据此宣称索引链已验收（`L-M11-02` 记 UNKNOWN） |
| `D-6` 的记忆体量线**仍未开始**；真库 `active` 记忆极少（`L-M11-03`） | **D10 / §4.6**：稳定门槛定义在**合格输入**上；**达不到就如实记"未达门槛"**，禁止为了凑正例降线或自建大库冒充 |
| 本工作树有一份**陈旧** `data/pglite`，与生产库不是同一份（`L-M11-05`） | **§7**：所有 M11 实验 `isolateDatabase()`；证据必须写清读数出自哪一份库 |
| 本工作树没有 `.env` / `.env.test`（`L-M11-04`） | **§9**：Live 门与生产激活在主 checkout 执行；本 WP 不代跑 |
| `'adaptive-self'` kind 与优先级 44 **已在场**；`ContextBudget` 有 7 个额度字段但**没有** `adaptiveSelfTokens` | **D20**：复用既有槽；新额度按同一形状加，缺省 **0** |
| M10 的三段 revision 分列、完成依据**只在事件 payload**、`recheckGoalDependencies()` 读时重算、cutover **不是**投影字段 | **D14 / §4.4**：反思引用目标结果**必须读事件**，不得从投影行推断 |

### 1.2 与既有裁定的关系（哪些**不动**）

```text
不动  M4 冻结面（app/memory/** · memory-validator.ts · reducer 语义 · 事件 payload）
不动  M9 的 inferred 槽闭集与 Belief 资格链（eligibility / invalidation overlay）
不动  M10 的目标与承诺语义（转换表、完成依据、接受规则）
不动  M7/M8 的关系与情绪投影
不动  M5.1.1 / M9.1 / M9.5 的资格链与遗忘遮蔽语义 —— **复用**，不改写
不动  迁移链 0001–0010（D15：v1 追加迁移 = NONE，除非 WP0/WP2 证明不够）
不动  `SECTION_PRIORITY.adaptiveSelf = 44` 与 kind `'adaptive-self'`（既有常量）
不动  任何历史验收档（失败档、作废量具档一律保留归属）
```

### 1.3 认知完整性审查（`INV-CI-01…05`）—— M11 是**第一个真正的受审对象**

| 不变量 | M11 的处境 | 本 ADR 的机器判据 |
|---|---|---|
| `INV-CI-01` No Cognitive State Without Provenance | M11 **产生**新的内部认知状态（反思记录、行为策略） | **D05 / D06 / §4.2**：每条记录携带**程序解析**的引用与根；模型不得自报 owner/revision/root（结构检查 + 负控） |
| `INV-CI-02` External Access ≠ Cognitive Authority | M11 **不新增**任何外部入口 | **D01 / §7**：新增外部能力 = **NONE**；无新 capability / adapter / ActionRequest 生产者 |
| `INV-CI-03` Maintenance Must Never Masquerade as Experience | 反思是**她自己的**产物，但**不得**被当成"经历过什么"的证据 | **D04 / D16**：反思事件不成新根、不参与增信；`accepted ≠ 事实`；回复五态分列 |
| `INV-CI-04` Intervention Must Be Explicit / Authorized / Audited | M11 的写入由**新增 policy** 放行，模型不自批 | **D08 / §4.5**：审查链与理由码闭集；机械正控 + 负控 |
| `INV-CI-05` History May Be Corrected, Must Not Be Falsified | 失效 = **追加失效事件**，不物理改写；不倒改承诺历史 | **D11 / D12 / §5**：append-only；两步失效；同轮先阻断再补账 |

⇒ **结论**：M11 不触发 `INV-CI-02`（无外部认知入口），但它是 `INV-CI-01 / 03 / 05` 的
**首个真实承载者**。这三条因此在 M11 从"原则"变成**可测的判据**（§4/§5）。

---

## 2. 冻结决策（M11-D01…D24，按计划 §5）

裁定语言：**冻结 = 本 ADR 生效后，实现不得偏离；偏离 = 本 ADR 修订 + 前后读数。**

| 编号 | 裁定（逐字保留计划 §5 的推荐，并补"为什么 / 被否决的备选"） | 可检验约束 |
|---|---|---|
| **M11-D01** | **Reflection + 有限 Adaptive Self；新增外部能力 NONE。** 为什么：M6.5 已把代码执行 / GitHub / 微信 QQ 划给 Lv2；M11 若顺手接一个适配器，就同时引入了第二个权限口与第二个失败面。**被否决**：① 顺带接一个"外部记忆服务"（引入第二个记忆写入器）；② 用独立 Agent Runtime 承载反思（引入第二套状态主权）。 | 不增加 capability / adapter / ActionRequest 生产者（结构判据 + 依赖方向门） |
| **M11-D02** | **Reflection 属于 Character internal state。** 不修改 World truth；不改 Seed 内容/版本。为什么：Seed 是版本化数据，改了内容必须升版本（否则启动即被写闸拒绝）；"行为习惯"与"人设"必须是两条记录链。**被否决**：把成长写回 `src/character/苏沐薇.ts`（等于每次成长都要升 Seed，且开发者面再也分不清"她长成的"与"人改的"）。 | 不写 Seed、不出现新 Seed 版本；`scope` 恒为 `CHARACTER_INTERNAL` |
| **M11-D03** | **反思先形成独立的 `pending_review`。** 为什么：候选生成 ≠ 采纳；把"待审"塞进共享 `ProposalStatus` 会让所有领域被迫理解一个它们不需要的状态。**被否决**：把 `pending_review` 加进 `ProposalStatus` 枚举。 | 候选生成不等于采纳（两个状态各自有非零样本）；`ProposalStatus` 的类型闭集**不被扩展** |
| **M11-D04** | **反思是解释/假设，不是事实权威。** 不自动写 Memory，不自创用户事实或 `self_experience`。为什么：不变量 ①（Assistant Fact Firewall）与 M4 的 authority 组合是**已验收**语义，M11 无权绕过。**被否决**：允许"高置信反思"直接落一条 Memory。 | 反思运行后 Memory/Belief/Goal 的新增数 = 0（除显式跨域待审意图） |
| **M11-D05** | **根来源去重，派生链可追溯。** 多个 Memory/Belief/Reflection 若追到同一原始事件，只计**一个**根。为什么：否则"她把自己说过的话读三遍"就等于三份独立支持（M9 的 `D26` 同族纪律）。**被否决**：按节点数计证（会把派生链当证据）。 | 同根不同派生链 ⇒ 有效根恰好 1；不同根 ⇒ 计数正确（独立手算图对照） |
| **M11-D06** | **模型只选程序提供的 source handles。** owner / revision / root / 权限**不接受**模型自行声明。为什么：模型给自己的引用打分是"自证"；程序必须能在写入前独立重建引用。**被否决**：让模型输出 memoryId 字符串（等于让模型决定权限与版本）。 | 虚构 handle / root / owner ⇒ 结构或来源检查拒收（含负控） |
| **M11-D07** | **捕获 → 审查 → 提交 → 注入前复核。** 版本漂移 / 遗忘 / 撤回 / 隐私禁止 ⇒ 拒收或失效。为什么：慢路径天生有窗口；"提交前重读版本"是唯一能挡住过期结果的时机。**被否决**：只在捕获时校验一次（窗口内漂移会被写成事实）。 | 模型运行期间源被更正/撤回 ⇒ 提交被拒；无过期调整落库 |
| **M11-D08** | **审查由新增 policy 放行；模型不自批。** 为什么：M4.5 起"提案的唯一放行口是 policy"（kernel 边界门守着）；反思若自己批自己，等于在 kernel 里开第二个放行口。**被否决**：把审查做成模型二次调用（同一模型的自评不是独立判据）。 | 策略检查 / 来源检查 / 语义评测各司其职，互不替代；"模型说可靠"不构成放行条件 |
| **M11-D09** | **v1 封闭三个行为槽。** `clarify_when_ambiguous` · `acknowledge_correction_first` · `recheck_goal_before_next_step`。为什么：这三个是**处理程序**，可按程序模板渲染、可回放、可撤回；人格数值轴（信任/依恋/价值）没有可判定的验收条件。**被否决**：开放"任意行为指令"或先上五个槽（无法给出反例判据）。 | 槽位是**闭集**；越界请求（价值观 / 依恋 / 信任数值 / Seed）拒收 |
| **M11-D10** | **稳定调整门槛预先冻结：≥3 个有效独立根、来自 ≥2 个会话、无未解决直接冲突。** 为什么：门槛必须在看到读数**之前**定；它不是统计独立性主张，只是"别拿一次反馈当人格"。**被否决**：① 单根即增强；② 用"模型置信度"替代根数。 | 单根复述/刷票/单会话重复 **不**达门槛；相关性限制可审计 |
| **M11-D11** | **每次采纳记录版本、原因、范围与回退。** 不覆盖旧调整；相反证据产生**新**审查。为什么：`INV-CI-05`；倒改历史会让"她为什么变了"不可回答。**被否决**：原地更新策略行（丢失失效因果）。 | 状态可回放；相反证据产生新审查事件；旧记录逐字保留 |
| **M11-D12** | **安全失效先阻断上下文，再补落账。** 为什么：后台任务可能落后几十轮；"等账本追平才停止使用"= 在窗口里继续用一个已被遗忘的依据。**被否决**：只靠后台失效事件（窗口内泄漏）。 | 后台未追平时，当前轮 packet **已**不含该项；失效落账幂等 |
| **M11-D13** | **跨域修订返回 M4/M9/M10。** 不直接调用旧域 reducer/SQL；承诺修订遵守 M10 接受规则。为什么：领域归属是 M5.1 之后最硬的一条边界（读面边界已有机器判据）。**被否决**：反思事务里顺手 `applyGoalRows`。 | `RevisionIntent` 不产生对旧域的写；跨域入口契约锁（结构判据） |
| **M11-D14** | **当前事实与未来期望分离。** `user_report` / `program_result` / Goal·Commitment / 解释四类标签保留。为什么：M10 已冻结"完成依据分三类"；反思若把 `user_report` 读成世界事实，就把 M10 的边界吃掉了。**被否决**：统一成一个"事实"标签。 | 四类标签在反思输入与审查里分列；assistant 话只能证明"说过" |
| **M11-D15** | **复用 jobs + 水位，限制慢路径。** 不在每轮必跑模型；不新增独立外部自主循环。为什么：每轮一次模型调用会把延迟与失败率直接乘到对话上；且 M10 已证明确定性触发够用。**被否决**：每轮"重要性评分"模型 + 无限递归 reflection。 | 无触发输入时**不调用**模型（负控：调用数 = 0）；每 job 最多 1 次请求 |
| **M11-D16** | **双流序号分开；自己的输出不成新支持。** 会话序号与 domain sequence 不混用；反思事件不反复触发自身增强。为什么：混用会造成漏读/重读增信；自我强化是 Reflection 的典型退化（`INV-CI-03`）。**被否决**：用一个统一递增序号。 | 两个水位各自推进；反思自身事件被再次扫描时不成新根 |
| **M11-D17** | **deadline、取消、late-write fence 真实生效。** 为什么：M8/M10 的历史缺陷（catch 不落 failed、定时器不清理、晚返回写库）都属这一族；M11 的慢路径同样会晚返回。**被否决**：靠"provider 一般会回"而不做取消。 | timeout 后请求被取消；晚返回写库 = 0；shutdown 后无写入 |
| **M11-D18** | **回放只折叠已提交事件。** replay/rebuild 不调 provider、不重新生成候选、不用当前世界解释过去。为什么：否则同一日志在不同日期会得出不同历史（不可回放 = 不可审计）。**被否决**：rebuild 时"顺便刷新"反思内容。 | rebuild 前后逐字段一致；replay 期间零 provider 调用 |
| **M11-D19** | **新开关缺省关闭，独立控制调整。** `CHARACTER_REFLECTION_ENABLED` / `CHARACTER_ADAPTIVE_SELF_ENABLED`，代码里均缺省 **false**。为什么不合成一个：Reflection 开而 Adaptive 关是**必须可表达**的状态（可审查的反思、但不改行为）。**被否决**：一个总开关（无法做 §11.3 的 B 档消融）。 | 关闭不删除历史；Reflection 开 + Adaptive 关 ⇒ 行为状态与入模调整 = 0 |
| **M11-D20** | **使用现有 `adaptive-self` 槽，预算缺省 0。** 新额度只从 `ContextBudget` 传递；被裁剪**不算**实际入模。为什么：`selector` 是唯一预算权威；在 renderer/provider 里写第二个默认会让"这轮为什么没注入"无法回答。**被否决**：在 renderer 里硬编码 300。 | 预算 0 ⇒ section 数 0；最终 packet 与 trace 逐 id/revision 相同 |
| **M11-D21** | **回复绑定程序事实；隐私元数据观测。** 待审不能说"已形成习惯"；trace 无反思正文 / 来源正文 / 隐藏思维链。为什么：`INV-CI-03` 的用户可见面就是这句话；进展汇报是"她最容易被诱导夸大的地方"。**被否决**：把候选正文写进 trace 方便调试。 | 五态事实包与回复一致（机器判据 + 行为评审）；leak 扫描 0 |
| **M11-D22** | **独立量具 + 三段式控制 + 非零正例。** 不用同一生产 helper 生成 expected roots；恒空实现不能过门。为什么：M4.5 起 INV-M45-06 就是这条；"检查了 0 项"与"全部一致"在输出上无法区分。**被否决**：用生产 resolver 算 expected。 | 正控/负控/恢复三段；`measured_count > 0`；手算图对照 |
| **M11-D23** | **机械、语义、行为、人审、激活分列。** 不以聚合绿、模型 confidence 或一句好回复代替其他维度。为什么：M10/M8 的收口表就是这么分列的（14 槽）。**被否决**：一个总分。 | §14 十四槽各自有状态值与证据 |
| **M11-D24** | **不自动激活、迁移、合并、打标签或开 Lv2。** 收口和生产操作各有具体载体；激活后另取 FIRST-USE 证据。为什么：M9/M10 的既有纪律；本 ADR 同样不授权。**被否决**：工程 PASS 即激活。 | 激活需独立授权载体；`FIRST-USE NOT OBSERVED` 不得写成观测通过 |

---

## 3. WP0 驱动的追加裁定（M11-D25…D33）

WP0（[基线报告](../m11/M11-WP0-Baseline.md)）的实测读数要求计划 §5 之外再冻结九件事。
它们不是"实现细节"，而是**没有它们，D05/D07/D10/D17 就不可检验**。

### M11-D25 · `causedBy` 的**追加**贯通与旧数据规则

```text
① 传递链：NewDomainEvent → 提案 → AcceptedDomainEvent → 写入，三处**追加**字段。
② 写入改为写 `accepted.causedByDomainEventIds ?? null`（**替换现在的固定 ${null}::jsonb**）。
③ 旧调用者缺字段 ⇒ 仍写 null（兼容）；**不补写历史事件**，不改旧事件的证据含义。
④ 校验（新增，失败关闭）：父事件**必须存在**、**同 character**、**序号早于**本事件、**无环**；
   跨用户引用按各来源的 subject/target 规则复核。
⑤ 历史事件缺二跳字段 ⇒ 从既有 Memory evidence / Belief roots / Goal sourceRefs 解析；
   **无法追溯 ⇒ 降为不可用于采纳** —— 不许猜父事件。
⑥ 零迁移（列已存在，WP0 逐条核对）；**不得**把"字段存在"读成"来源链已具备"。
```

**被否决**：① 补写历史事件（等于伪造当时的因果）；② 缺根时用"最相近的事件"兜底（猜出来的根
比没有根更坏）；③ 为来源链新建图数据库（D20/§7 的范围外）。

### M11-D26 · 反思的事件身份**不依赖内容去重**

```text
· 每条反思记录有**确定性事件身份**（由 character + cutover + 触发区间 + 槽位/序号派生）。
· 同一窗口重跑、重启补跑、重复召回 ⇒ 幂等键相同 ⇒ **不产生第二份业务记录**。
· ⚠️ M10 的教训（ADR-076 D26）：走完整放行口的重复投递会被**内容去重闸**先挡下，
  于是"靠内容去重防重复"看起来能用 —— 但那是**另一个机制**的副作用，不是本域的保证。
```

### M11-D27 · `adaptive-self` section 的 id 约束与**独立额度**

```text
· 复用既有 kind `'adaptive-self'` 与 `SECTION_PRIORITY.adaptiveSelf = 44`（不改常量）。
· 额度**只**来自 `ContextBudget.adaptiveSelfTokens`：缺省 **0**；激活建议 **300**、硬上限 **800**。
  （形状与 `externalEvidenceTokens` / `goalTokens` 逐字同构：接线就位、缺省 0、激活另裁。）
· section id 必须**稳定且可对账**（含槽位 id 与策略 revision），使 trace 能逐 id/revision 比对最终 packet。
· 最多 **3** 条；被裁剪 ⇒ **不算**实际入模（D20）。
```

**被否决**：① 与 `goals` 共享额度（"她自己的策略"和"她准备做的事"被裁掉的后果不同）；
② 在 renderer 里写 300 的第二个默认（会让"这轮为什么没注入"不可回答）。

### M11-D28 · 候选与采纳是**两条记录**，不是一次状态翻转

```text
`REFLECTION_PROPOSED` 落候选 → `REFLECTION_REVIEWED` 落审查结论（accepted / rejected + 理由码）。
· 读面必须能**分别**回答："这一轮有没有候选"与"候选是否被采纳"（D03 的可检验面）。
· 反例与支持同时保存；未解决的直接冲突 ⇒ **不采纳**且写下具名理由。
· **不**把 reviewed payload 拆成两套并行生命周期（计划 §6.1 末段逐字）。
```

### M11-D29 · 生产体量不足时的诚实行为（WP0 `L-M11-03` 驱动）

```text
· 稳定门槛（D10）定义在**合格输入**上，不在"库里有多少条"上。
· 真库 `active` 记忆体量极小（D-6 体量线尚未开始）⇒ 生产上**可能长期达不到** enhanced。
  那不是需要修的缺陷，而是一条**读数**：M11 报"未达门槛"。
· **禁止**：为了凑正例降线 · 自建大库冒充生产覆盖面 · 把构造正例说成生产观测（D22/D23）。
· WP10 的行为门因此在**明确设计的合法正例**上测，并在报告里把
  「生产观测」与「构造正例」**分列**。
```

### M11-D30 · 冻结的窗口与上限（计划 §7.1 的建议值 → 冻结值）

| 项 | 冻结值 | 超限时的确定性行为 |
|---|---|---|
| 每 job 合格原始输入 | **50** 条 | 按确定性窗口分页；未消费区间留给下一 job |
| 候选模型输入 | **≤ 6000** token | 超限 ⇒ 按确定性裁剪规则 + 具名原因（不静默丢） |
| 每 job 反思候选 | **1** 条 | 多余的留给下一次触发 |
| 单条候选解释 | **≤ 300** 汉字 | 超长 ⇒ 拒绝该候选（不改写成"更短的正确版"） |
| 来源遍历 | 深度 **16** / 节点 **64** | ⇒ `lineage_limit_exceeded`（D31） |
| 总 deadline | **20 s** | 真实 cancel；无隐式重试；job 落 `failed` 或"无候选"分列 |
| 每个 job 的模型请求 | **1** 次 | 第二次请求属于新 job |
| `adaptiveSelfTokens` | 缺省 **0** / 激活 **300** / 上限 **800** | 被裁不算入模 |

⚠️ 这些是**设计冻结值**，不是已测值。WP9 报性能；若性能不足 ⇒ 如实 FAIL/DEFERRED，
**不得**在看到盲测失败后改阈值（计划 §7.2 末段逐字）。

### M11-D31 · `lineage_limit_exceeded`：超限**不许**截断后假装根已齐全

```text
超过 D30 的遍历上限 ⇒ 返回具名码 ⇒ 该候选**不可用于采纳**。
理由：截断后的根集合"看起来"完整，而 D05 的去重与 D10 的门槛都建立在"根集合完整"上 ——
一个不完整的根集合会让门槛**静默地**变松。
```

### M11-D32 · 行为指导只能来自**封闭枚举的程序模板**

```text
· 模型可以建议"哪个槽"（闭集三选），但真正进入上下文的**那句话**由程序按槽枚举渲染。
· 模型的自由文本**不得**提升为系统指令 / policy / Seed；正文只作为**记录**保存与审查。
· 槽的 scope 由程序固定为"当前 character/user"；单场景调整不得扩大为"永远这样做"。
```

**被否决**：把模型输出的"行为守则"直接拼进 system（等于让模型改人设，D02 禁止）。

### M11-D33 · cutover 是**结构性**的（沿用 M10-D23 的形状）

```text
· **没有**"回填历史"这一步：首次建立记 `REFLECTION_ORIGIN`（含 cutover 序号），
  **不**把激活前的全部旧聊天重新解释一遍。
· cutover **不是投影字段**（WP0 P3 核过：目标域同款形状）⇒ 只能从激活载体与事件水位读。
· 顺序依据**序号**（domain sequence / 会话序号各自推进，D16），不依赖系统时间。
```

### M11-D34 · 新额度**必须真的接线**（照 `rollupTokens` 的形状，不照目标链）

```text
WP0 的继承缺陷读数（L-M11-10）：`goalTokens` **从未**被生产装配设置
  ⇒ `goal-state` 块在生产里**不可达**（额度恒为缺省 0），而 M10 的判定表写的是
    `Production activation = ACTIVATED`（`.env` 只加了 `CHARACTER_GOALS_ENABLED=true`）。
  ⇒ 两者可以同时为真（激活的是**域**，不是**注入**），但它极易被读成"目标状态已在注入"。

M11 的冻结要求：
① `adaptiveSelfTokens` 的值**只**从 `flags → main.ts 的 recallBudget → ContextBudget` 传，
   形状照 `rollupTokens`（独立额度，**不**挂在另一个总开关下）。
② 配一条**静态回归锁**：断言 `src/main.ts` 里真的出现该字段（先例：M10 对 `goalsEnabled` 的锁）。
   只加字段不接线 ⇒ 那是一个**惰性的、看起来能开的开关**（M4.1 的 D3 教训）。
③ 额度字段从 **6** 个变 **7** 个；`assertContextBudget` 的键列表、`planContextBudget` 的分类
   与既有的 `ContextBudget` 字面量调用点都要同步（typecheck 会强制列出）。
④ **不**新增 `budgetGroup`（既有只有 `'status'` 一个值，新增会牵出编译器的额度接线）。
```

---

## 4. 技术接口冻结

### 4.1 对象与字段闭集（**只追加**，不造通用可配置认知引擎）

**`ReflectionInput`** —— 反思这一轮**实际看到**的东西（程序装配，不由模型声明）

| 字段 | 语义 | 禁止表达为 |
|---|---|---|
| `characterId` / `user` | 归属（branded id） | 由模型选择的目标人物 |
| `originSequence` / `cutover` | 首次建立的序号边界（`D33`） | 任意历史全量 |
| `window` | **有限**输入（条数 ≤ 50，见 `D30`） | "全部相关历史" |
| `handles: SourceHandle[]` | 程序提供的**候选引用**（id + 类型 + 真实 revision + 可用性） | 模型自报的 root / authority |
| `programFacts` | 程序事实标签（`program_result` / `user_report` / `assistant_speech` / 内部解释） | 合并成单一"事实" |
| `counters` | 本次窗口的合格/裁剪/跳过计数与具名理由 | 只给"成功数" |

**`ReflectionDraft`** —— 模型产出的**候选**（还不是记录）

| 字段 | 语义 | 禁止表达为 |
|---|---|---|
| `focusQuestion` | 焦点问题（结构化借鉴 Generative Agents） | 自由文本人格宣言 |
| `explanation` | 候选解释，**≤ 300 汉字**（`D30`） | 用户事实 / 世界事实 |
| `supportHandles` / `counterHandles` | **必须来自 `handles`** 的子集 | 未提供的 id（`handle_unknown`） |
| `scope` | 适用范围（当前 character/user） | "永远这样做" |
| `suggestedSlot?` | 三槽之一（闭集） | 任意行为指令 |
| `revisionIntent?` | 跨域待审意图（`domain` + `targetId` + `expectedRevision`） | "已经提交到目标领域" |
| `schemaVersion` / `promptVersion` / `modelVersion` | 生成版本（可审计） | 以版本冒充质量 |

**`ReflectionRecord`** —— 已落库的记录（append-only）

| 字段 | 语义 |
|---|---|
| `reflectionId` / `schemaVersion` | 身份与形状版本 |
| `status` | `pending` / `accepted` / `rejected` / `retracted`（§4.3） |
| `handles` / `roots` | **程序解析**的引用与原始根（`D05`/`D06`） |
| `reviewReasons` | 审查理由码（闭集，§4.5） |
| `generatedBy` | provider / prompt / schema 版本指纹 |
| `lifecycle` | 发生过的转换（事件 id + 序号），供回放 |

**不允许**：从 `confidence` 推导事实或许可；把 `accepted` 写成"世界事实"。

**`AdaptiveSelfState`** —— 三个槽的当前版本

| 字段 | 语义 |
|---|---|
| `slot` | 闭集三槽（`D09`） |
| `level` | `baseline` / `enhanced` |
| `revision` | 每次合法变化 +1（写入带 `expectedRevision`） |
| `scope` | 当前 character/user（程序固定） |
| `sourceReflections` / `roots` | 支持它的反思与**去重后**的根 |
| `changedReason` / `invalidatedReason` | 变更/失效的具名理由 |

**不允许**：Seed 替代品 · 无范围人格标签 · 任意自由文本 system instruction。

**`RevisionIntent`** —— 跨域待审意图（**只读待审面**）

| 字段 | 语义 | 禁止表达为 |
|---|---|---|
| `domain` | `memory` / `belief` / `goal` / `commitment` | —— |
| `targetId` / `expectedRevision` | 目标与**期望版本**（乐观锁） | "已提交" |
| `originReflectionId` | 原反思 | "用户已接受" |
| `proposal` | 建议内容（按目标领域的既有形状） | 绕过目标领域 policy |

### 4.2 事件族与 payload 上限（**新增 5 个**，不改旧事件）

| 事件 | 承载 | 上限（对齐既有量级 4K/8K/16K） | 幂等键（`D26`） |
|---|---|---|---|
| `REFLECTION_ORIGIN` | 首次建立 + cutover 序号（`D33`） | 4 KB | `reflection-origin:<characterId>` |
| `REFLECTION_PROPOSED` | 候选（`ReflectionDraft` 落库形状 + 输入窗口指纹 + 程序解析的引用与根） | 16 KB | `reflection-proposed:<characterId>:<jobId>:<draftOrdinal>` |
| `REFLECTION_REVIEWED` | 结论 + 理由码 + 支持/反例 + 解析后的根 | 8 KB | `reflection-reviewed:<reflectionId>:<decision>` |
| `REFLECTION_INVALIDATED` | 失效原因 + 触发的源事件 | 4 KB | `reflection-invalidated:<reflectionId>:<causeEventId>` |
| `ADAPTIVE_SELF_REVISED` | 槽位版本变化（slot / level / revision / roots / 理由） | 4 KB | `adaptive-self-revised:<characterId>:<slot>:<revision>` |

```text
· 形状沿用既有工厂模式：新增 `createReflectionDomainEventRegistry()`，
  每个事件一个 `DomainEventTypeSpec`（`maxPayloadBytes` + `validatePayload`），
  再由 `createFullDomainEventRegistry()` 组合（M9/M10 逐字同构：
  `createBeliefDomainEventRegistry()` / `createGoalDomainEventRegistry()`）。
  ⚠️ 既有先例：**WP2 只登记、WP4 起接线**（Belief/Affect 的注释逐字写着这条）。
· ⚠️ **没有事件类型字符串联合**：`DomainEventType = string`（`domain-event.ts`），
  allowlist 由**注册表**与各域的 `<DOMAIN>_DOMAIN_EVENT_TYPES` 常量数组表达
  ⇒ M11 要同时加 `REFLECTION_DOMAIN_EVENT_TYPES`（13 个目标的数组是同一形状）。
· ⚠️ **两层报错分工不同**（照抄既有纪律）：
    · 契约层的 `validateReflection*Payload()` 抛**普通 `Error`**（消息含事件类型与字段路径）；
      它被泛型校验器接住 ⇒ 拒绝码固定为 `payload_schema_invalid`（超限是 `payload_too_large`）。
    · 策略层**不抛**，而是累积 `RejectedTarget { type, code, message }`，
      code 用本域命名空间（`reflection_*`）。`KernelError` 只用于契约/基础设施级违约。
· scope 一律 `CHARACTER_INTERNAL`（`assertCharacterInternalScope`，在逐目标循环里**最后**一道）。
· payload **不含**：用户原话 · Memory 正文 · 完整 prompt · 模型隐藏推理。
· 是否拆分 `REFLECTION_REVIEWED` 的 payload ⇒ **不拆**：一条结论一条事件，
  **不**在实施时同时发展两套并行生命周期（计划 §6.1 末段）。
· 追加迁移 = **NONE**（列与表已够）；若 WP2 证明不够 ⇒ 另提 0011 并**单独授权**，禁改 0010。
```

### 4.2.1 投影与写路径（照 M9/M10 的**行存储 + 折叠**，不用第二种模式）

```text
· M9/M10 的投影**不是** `applyAcceptedEvents` + `ProjectionReducer` 那条路：
  它们是「行存储 + 纯折叠」：`applyGoalRows` / `rebuildGoalProjections` · `applyBeliefRows` ·
  reducer 版本常量（`goal-fold@1` / `belief-reducer@1`）· 投影类型前缀（`goal:` / `belief:`）。
  ⇒ M11 照**这一条**：`reflection-fold@1` + 前缀 `reflection:<reflectionId>`。
· 写入边界（沿用 M10 的机器判据形状，WP2 起可照抄成门）：
  · 本域**自己的**写入口**恰好 2 个**（apply + rebuild），多一个 ⇒ 门变红；
  · 共享账本追加 `applyAcceptedEvents`（`event-store.ts`）**是另一个域的东西**，
    不并入"本域写入口"的计数；
  · 读面函数体里**不得**出现 `insertProjection` / `saveProjection` / `deleteProjection` / `inTransaction`
    （判结构**先去掉注释** —— 这条纪律 WP0 的判据缺陷 #1 已经用过一次）。
· 幂等键**由既有 `computeIdempotencyKey` 计算**（`characterId|processor|processorVersion|from-to|operation`），
  operation 分量用**确定性单元串**（先例：`goalUnitOperationOf()` 的 `goal-created:<goalId>` 一族）
  ⇒ **不要**自造裸字符串当键（那会绕过既有的 `processed_operations` 账）。
```

### 4.3 生命周期状态机（合法边 / 非法边）

```text
候选：      (无) --PROPOSED--> pending
审查：      pending --REVIEWED(accept)--> accepted
            pending --REVIEWED(reject)--> rejected
失效：      accepted --INVALIDATED--> retracted
            pending  --INVALIDATED--> retracted
非法边：    rejected --REVIEWED--> accepted        （不许翻案：要新候选，走新记录）
            retracted --REVIEWED--> accepted        （同上）
            pending/accepted --PROPOSED--> …        （同一记录不许二次提案）
            accepted --REVIEWED--> accepted         （重复审查 ⇒ duplicate_review）
```

**为什么 `rejected` / `retracted` 不许翻案**：`INV-CI-05` —— 历史可以被更正，
但**不得**被改写；翻案会抹掉"当时为什么拒"的因果。要重新成立就走**新的**候选记录。

### 4.4 来源归一化与根计数（`D05`）

```text
① 用真实 event/ref 取回来源，校验 character / user / namespace / 时间顺序 / 权限。
② 展开链路：`DomainEvent.causedByDomainEventIds`（WP2 追加贯通，`D25`）+ 各旧域已有的
   evidence / roots / sourceRefs。
③ 按真实 ID 对**原始根**去重：同一 root 的重复检索、不同摘要、多个派生节点**不**增量计证。
④ 五类标签分列：`user_statement` · `user_report` · `program_result` · `assistant_speech` · 内部解释。
   `assistant_speech` 只能证明"她说过"，**不能**证明说的内容真实发生。
⑤ 资格与撤回**双向**覆盖支持与反例；缺根 / 循环 / 跨角色 / 过期 / 禁止使用 ⇒ 不可用于采纳。
⑥ 遍历上限：深度 **16** / 节点 **64**；超限 ⇒ `lineage_limit_exceeded`（**不**截断后假装根齐全，`D31`）。
```

### 4.5 审查顺序与理由码（顺序不可跳）

```text
结构 → 来源合法 → 当前版本/资格 → 支持与反例 → 目标范围 → 槽位/跨域合法 → 修订冲突
```

每一步的**具名码**见验收契约 §3.3（闭集，只追加）。
⚠️ 程序能机械保证的是结构、引用、资格、版本、封闭槽位与既有权限；
它**不能**仅凭"引用存在"证明解释被原文蕴含 —— 该语义残差必须由**独立语义评测 + 人审**检验，
并进入 Known-Limitations（契约 §1 的"不可替代"列）。

### 4.6 三个行为槽（冻结语义，见验收契约 §3.4）

```text
clarify_when_ambiguous         对象/指代不明确时先澄清（清晰任务不得每次多问）
acknowledge_correction_first   更正先承认并核对，再继续回答（承认 ≠ 把非法当正当作事实）
recheck_goal_before_next_step  推进既有计划前检查当前目标/承诺（不得为检查而自行联网/执行）
```

三个槽**只决定处理程序**；**不改**情感强度、信任、身份、价值观、亲密度或服从程度。
渲染进上下文的句子由**程序按槽枚举**生成（`D32`）。

### 4.7 跨域只读面与写入口归属（`D13`）

| 目标域 | M11 可以做 | M11 **不得**做 |
|---|---|---|
| Memory | 读（含 evidence / authority / 资格）；发起 `RevisionIntent` | 调 M4 reducer / SQL；伪造 authority；写 `self_experience` |
| Belief | 读 roots / supportLevel / epistemicKind / overlay | 扩大 inferred 槽；生成"用户心理"信念 |
| Goal / Commitment | 读 state + **事件**（完成依据只在 payload）；发起待审修订 | 调 `applyGoalRows` / `rebuildGoalProjections`；倒改接受历史 |
| Action / 搜索结果 | 只解释**既有**结构化程序事实 | 产生新外部动作；把成功外推为世界效果 |

### 4.8 配置与开关

```text
CHARACTER_REFLECTION_ENABLED=false      控制候选生成与审查链
CHARACTER_ADAPTIVE_SELF_ENABLED=false   控制行为调整的写入与注入
· 两个都缺省 **false**；形状沿用 `readKernelFlags()` 的 `truthy(env.X, false)`（既有先例：
  `goalsEnabled: truthy(env.CHARACTER_GOALS_ENABLED, false)`）。
· "代码缺省 false / `.env` 可激活"是本仓库的既有分工：开关在代码里关着，
  生产激活属 WP12 **单独裁定**（先 Reflection、再 Adaptive，或分阶段）。
· 关闭**不删除**历史记录；Reflection 开 + Adaptive 关是必须可表达的合法状态（`D19`）。
· 预算 `ContextBudget.adaptiveSelfTokens`：缺省 0 / 激活建议 300 / 硬上限 800（`D27`）。
· **不接通**历史 NOT-WIRED 的 `CHARACTER_MEMORY_BACKGROUND_ENABLED`。
```

### 4.9 时间与序号模型（`D16`）

```text
· 会话事件与会话序号：对话侧推进。
· 领域事件与 domain sequence：账本侧推进，反思事件也走这里。
· 两者**各自**水位；不得互相替代（混用会造成漏读或重读增信）。
· 顺序依据**序号**，不依赖系统时间；时间回退不得改变结论。
· 反思**自身**事件被再次扫描时：不成新根、不触发自身增强（`INV-CI-03`）。
```

---

## 5. 遗忘与失效（`INV-CI-05` 的落成）

### 5.1 两步失效（顺序不可颠倒）

```text
第 1 步（当前轮，注入之前）：资格过滤 —— 使相关项**立即不可用**。
第 2 步（后台，幂等）：追加失效事件 + 更新投影 —— 把"为什么失效"落成可审计的记录。
```

⚠️ 为什么不能只做第 2 步：后台任务可能落后几十轮，而"等账本追平才停止使用"
= 在窗口里继续用一个**已经被遗忘的依据**作答（M9.1 的 `L-M9-13` 同族风险）。

### 5.2 覆盖范围（支持与反例**双方**）

| 路径 | 失效后必须发生什么 |
|---|---|
| 原始窗口（上下文里的历史对话行） | 被禁用取值不得被复述（M9 的 F-1 是真发现，不是量具误报） |
| 摘要 / rollup | 不得从摘要绕回 |
| 语义召回 | 语义分数**不进**采信；被禁源不因"分数高"复活 |
| 反思输入与反思解释 | 反思不得成为被禁取值的**旁路**（`accepted` 也不是豁免理由） |
| 开发者详情 / trace | 默认遮蔽；M11 从领域侧读正文时**自己**承担隐私规则 |

### 5.3 跨域失效的归属（不是 M11 自己判断）

```text
Memory 忘掉          ⇒ 引用它的反思**不可用**（M11 只消费 M4 的资格结论）
Belief 撤回/失效     ⇒ 同理（消费 M9 的 overlay）
Goal 取消 / 受阻     ⇒ 反思引用**降档**而非删除：历史仍可解释，但不能当"当前目标"用
```

### 5.4 回放与当前使用**分开**

```text
· 回放过去：按**已提交事件**恢复当时状态（D18）。
· 当前使用：以**当前资格**再筛一次。
· **禁止**在 replay 内读取"当前来源"来改写历史投影 —— 否则同一日志在不同日期会得出不同历史。
```

---

## 6. 隐私与可观测性边界

### 6.1 允许进入 trace / telemetry / 公共 artifact 的

```text
id · revision · 状态 · 具名理由码 · 根计数 · 来源类型 · 指纹（哈希）· 实际入模计数 · 时间与耗时
```

### 6.2 **禁止**进入的（负控会扫这些）

```text
候选正文 · 用户原话 · Memory 正文 · 完整 prompt · 模型隐藏推理 · 凭证
```

### 6.3 developer DTO 与领域侧读取

```text
· developer DTO 默认**遮蔽**（沿用 `goalContentMustBeMasked` 的既有形状）。
  M11 的对应物 = **一个** `reflectionContentMustBeMasked()`，由**对话侧与开发者面共用**
  （既有纪律：「两处各写一遍『什么算可用』迟早漂移」）。
· **遮蔽要写进类型**：DTO 是判别联合 —— 被遮蔽的那一支**类型里就没有**正文字段
  （先例：`DeveloperGoalMaskedDto` 没有 `statement` / `nextStep`）。这样"漏遮蔽"是编译错误。
· M11 若需要正文（例如给审查/人审用），**必须**从领域侧读并**自己**复核隐私规则 ——
  不得绕过 masked DTO 拿一个"看起来是内部接口"的旁路。
· 新增理由码 / 分类法**只追加**，且**只有实际生产者的值**才允许登记。
```

### 6.3.1 可观测性的硬边界（照抄既有，三条都是机器判据）

```text
① **阶段数冻结在 12**：不得新开第 13 个阶段（`OBSERVABILITY_STAGES.length === 12` 是 M5.1 门的判据）。
   M11 只允许在**唯一的** kind→stage 映射表里**追加条目**（M10 的五个 goal_* 就是这么接的：
   `goal_eligibility/goal_proposal/goal_validation/goal_event → 'turn'` · `goal_context → 'context'`）。
② **理由码必须先登记**：stage 事实表的 `reasonCodes` 是**受控词表**，**空数组 = 任何理由码都被拒**
   （失败关闭）。新的码要么复用既有词表，要么先登记。
③ **正文被三层挡着**：键级白名单（`TELEMETRY_ATTRIBUTE_ALLOWLIST` + 敏感片段
   `api/key/secret/token/prompt/content/body/text/message/raw/payload/…`，**敏感片段优先**）·
   值级哨兵（沿用 `assertNoMemoryContentInTrace` 的**同族**做法，M11 要自己的那一条）·
   类型级门（读面类型里不得出现正文类字段 —— 既有判据用 `stripComments()` 后的正则，
   且 `?` 可选字段也要被抓住）。
```

### 6.4 人审材料的落点（WP0 已把机器闸先放好）

```text
· 机器证据：`artifacts/m11/<runId>/`（进仓库；只有上方 §6.1 的那类字段）
· 人审材料：`artifacts/m11/local/<runId>/`（**不进仓库**）
· WP0 已把该路径加进 `.gitignore` 并用 `git check-ignore` 验证（exit 0）；
  写正文之前仍要**在代码里**再跑一次该闸，不过即拒写（M6.1/M8/M9/M10 同形）。
```

---

## 7. 生命周期、触发与真实装配

### 7.1 触发是**确定性的**，不是每轮

```text
触发条件（任一）：显式更正 / 显式反馈 · 目标完成或受阻 · 承诺结果 · 已登记认知冲突
有限窗口里没有这些输入 ⇒ **不调用模型**（负控：模型调用数 = 0）。
已有安全失效 ⇒ 无需模型即可立即处理（§5.1 第 1 步）。
```

**被否决**：每轮"重要性评分"模型 · 无限递归 reflection（计划 §7.1 原文）。

### 7.2 并发与合并

```text
· 每个 character 最多 **1** 个 running 模型任务。
· 最多 **1** 个合并待处理区间；合并**只扩大**待处理序号范围。
· ⚠️ **合并不得丢掉区间中的必须失效事件** —— 否则"合并"会静默变成"跳过"。
· 会话输入与 domain event 用**各自**的序号 / 水位（D16）。
```

### 7.3 失败、恢复与关闭

| 情况 | 必须行为 |
|---|---|
| provider 错误 / 非法 JSON | 不采纳、不改旧域；记录失败原因；**模型错误与传输错误分别计数** |
| 超时 | 20 s 总 deadline；**真实取消** fetch；无隐式重试；job 落 `failed` 或"无候选"分列 |
| tool / assistant / 非资格事件 | 显式判为不适用，**并按契约推进相应扫描水位**（不能楔死调度） |
| 异步处理抛异常 | 持久标记 `failed`；下一合法触发按冻结规则可重试（不能永远 running 或同窗永远拒绝重入） |
| 事件已提交、投影未写 | 按既有增量恢复纪律**补投影**；**禁止**再提交一次业务事件 |
| 任务开始后来源被更正/遗忘 | 提交前**重读版本与资格**；过期结果 ⇒ 拒绝 |
| shutdown | 停止接收新任务 → 有限等待/取消 → 设置 late-write fence；沿 `main.ts` 既有受控关闭 |
| 关闭后 provider 返回 | **零**写入（事件 / 投影 / 水位），且不得重新开库 |
| 进程重启 | 从 origin/cutover 与持久任务恢复；**不**把首次激活前的全部旧聊天重新解释一遍 |

⚠️ 上表每一行都对应一个**负控**（WP9 的门必须能分辨"真的处理了"与"执行器不工作"）。
M8 的两条历史缺陷（`catch` 不落 `failed` 导致同窗重试楔死 · tool 事件楔死评估器）
在这里是**设计输入**，不是背景故事。

### 7.3.1 既有后台任务的形状（WP7 **照抄**，不另造一套）

```text
· **不是守护进程**：既有各域都是"挂在 open / send 两个既有钩子上的 maybe-run 一次"
  （源码逐字："turn hook ≠ 新建自主后台任务…没有定时器"）⇒ M11 同样不新增定时器。
· 持久任务在既有 `character_jobs` 表；它的**部分唯一索引只覆盖 pending|running|completed**
  ⇒ `failed` 的幂等键**允许重建** —— 这正是"同窗重试有活路"的机制（不要另建一张表）。
· 水位 = `processor_watermarks.processed_through_sequence`（按 character+processor+版本），
  **只在成功时前进**；失败后尾窗被下一轮重新覆盖（补洞）。
· ⚠️ **三条事故教训必须逐条落成负控**（都是本仓库真实踩过的）：
   ① `catch` 必须把任务行**如实落 `failed`**，否则行留在 running ⇒ 下次同窗重试撞
      `job_not_pending` ⇒ **永久楔死**（M8 WP7 / M7 的 `L-M8-13` 修复形状）。
   ② tool / assistant / 非资格事件必须**显式跳过**，同时**仍然推进水位**；
      不跳过 ⇒ 窗口里出现一条就永久楔死（`processorEventViewOf` 对 tool 失败关闭）。
   ③ **late-write fence 在仓库里不存在**（`grep fence|late_write` 在 `src/` **零命中**）——
      `D17` 要求的"关闭后晚返回零写入"今天只有 `close()` 的 abort + 有界等待作为**部分**替代
      ⇒ **M11 必须自己建这道闸**，并且它要能被负控证明（否则 `D17` 不可检验）。登记 `L-M11-11`。
· 超时：既有唯一可复用的 deadline helper 是目标域的 `withDeadline`（`finally` 里
  **clear + unref**）；provider 调用的 `AbortController` 形状在若干 provider 里是重复实现，
  仓库**没有**通用 `withTimeout` ⇒ M11 可以复制那条形状，但**不得**留下未清理的定时器
  （M10 的 `waitReady` 180 s 兜底定时器就是"进程不退出"的根因）。
```

### 7.4 真实入口与实验隔离

```text
· 领域读面与写面在**真实装配**（TurnGateway + 真实 scheduler）上验证；
  "只在 fixture 上成功"不算（计划 §15 的一行风险就是它）。
· 一切实验脚本 `isolateDatabase()`（AGENTS §7 / INC-01）。
· 本工作树没有 `.env` / `.env.test`（`L-M11-04`）⇒ Live 门在生产 checkout 上跑。
· 本机 `pnpm <script>` 被供应链校验阻塞（`L-M11-08`）⇒ 用**同一入口文件**直接调用，
  并在证据里写明调用方式。
```

---

## 8. 与既有契约的增量（逐条，**只追加**）

| 面 | M11 的增量 | 不许做的事 |
|---|---|---|
| Memory（M4 冻结面） | **无** | 不新增写路径、不改 reducer 语义、不改事件 payload |
| Belief（M9） | **无** | 不扩大 inferred 槽、不生成"用户心理"信念 |
| Goal / Commitment（M10） | 只读 + `RevisionIntent`（待审） | 不直接调 `applyGoalRows` / 不改接受历史 |
| Context（`contracts/context.ts`） | **复用** kind `'adaptive-self'` 与优先级 44（**已存在**） | 不改既有优先级常量、不新增第二个预算权威 |
| ContextBudget（`recall/selector.ts`） | **+** `adaptiveSelfTokens`（缺省 0） | 不在 renderer / provider 写第二个默认 |
| 事件注册表 | **+5** 个 M11 事件（§4.2） | 不改既有事件的 payload 含义 |
| 迁移链 | **NONE**（v1；列已存在） | 不改 0001–0010；不够 ⇒ 另提 0011 并单独授权 |
| flags | **+2** 个 boolean（缺省 false） | 不接通历史 NOT-WIRED 的 Memory background |
| trace / telemetry | **+** 具名步骤与理由码（只追加） | 不落正文 / 隐藏推理 / 凭证 |
| 能力面 | **NONE** | 不新增 capability / adapter / ActionRequest 生产者 |

---

## 9. 本 ADR 不主张

```text
· 不主张"她不会编造"（M6-FMB-01 的主张是可查/可审计/可测，不是这个）
· 不主张反思已校准为真实心理，也不主张 root 多就必然可靠
· 不主张语义索引链已验收（WP0 只读到开关；真实库未打开 ⇒ L-M11-02 记 UNKNOWN）
· 不主张生产已激活或已首用（那是 WP12 与 FIRST-USE 的证据）
· 不主张人格成长完成、不主张 Level 2 能力
· 本 ADR **已获批准**（`ACCEPTED / DESIGN FROZEN`，§0.1）—— 但"设计冻结"**不等于**
  实现存在、门全绿、行为已观测或生产已激活（那些是 §10 后续各包各自的证据）
```

---

## 10. 后续（本 ADR 之后的执行面）

```text
WP2 来源链（D25）→ WP3 真实输入与结构化候选 → WP4 审查与生命周期（D28）
   → WP5 有限 Adaptive Self（D09/D10/D11/D32）→ WP6 跨域与失效（D12/D13/§5）
   → WP7 任务/装配（D15/D16/D17/§7）→ WP8 上下文/回复事实（D14/D20/D21/D27）
   → WP9 量具与离线 → WP10 真模型/人审 → WP11 收口 → WP12 激活候选
```

**送审事项已裁定**（2026-10-01，逐字引文见 §0.1）：三个行为槽的语义（D09 / §4.6）·
稳定门槛（D10）· 阈值与上限全集（D30）· 事件族形状与生命周期（§4.2 / §4.3）·
两个开关名（D19 / §4.8）—— **全部按本文的推荐值批准**；其余裁定无异议 ⇒
本 ADR 已由 `PROPOSED` 改为 **`ACCEPTED / DESIGN FROZEN`**（只做状态修订，未改任何正文裁定）。
⇒ **WP2 可以开工**（来源链与根解析，见 [WP1 交接单 §3](../m11/M11-WP1-Handoff.md)）。
