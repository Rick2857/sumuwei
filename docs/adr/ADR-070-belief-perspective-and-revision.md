# ADR-070：M9 Belief——视角化信念与认知修订（设计裁定）

> 状态：**ACCEPTED / DESIGN FROZEN**（2026-09-27，M9 WP1 出口）
> 类型：设计 ADR——建立 M9 Belief 阶段并冻结其设计决策。**本文不是生产激活授权**（见 §12）。
> 权威源：[M9 执行计划](../m9/M9-Execution-Plan.md)（§0–27）·
> [M9 基线/准入](../m9/M9-WP0-Handoff.md) + [准入报告](../m9/M9-Admission-Report.md)（WP0 实测）·
> [WP0-R 交接单](../m9/M9-WP0R-Handoff.md)（L-M8-13 已修）。
> 前序：[ADR-043](ADR-043-epistemic-requalification.md)（认知资格）·
> [ADR-050](ADR-050-rolling-summary-provenance-boundary.md)（来源边界）·
> [ADR-064](ADR-064-relationship-state-and-behavior.md) / [ADR-066](ADR-066-affect-state-evolution.md)（两域先例）。

## 0. 授权依据（WP1 任务 1：逐项记录结论、授权原话/日期/来源）

**授权原话**：用户目标指令（2026-09-27）：**「根据计划书进行M9建设」**。

**解读与边界**（本节是授权记录，不是扩大解释）：

1. 计划 §20 明文规定裁定语义：「这些是新设计选择，不能标成用户已经批准。
   **批准整份推荐方案后可一次性冻结**，无须对同一权限重复询问；超出冻结方案的新认知入口
   或生产动作另行处理。」目标指令授权按计划书建设 M9 ⇒ 计划 §20 的 **26 项推荐裁定
   （M9-D01…D26）按推荐值一次性冻结**（§2 逐项登记）。
2. **不在本授权内的动作**（计划与既有纪律明文保留）：
   - **生产激活**（M9-D26 / WP11）：需用户单独显式批准 + 独立记录；
   - **合并 / 打标签 / 真实库迁移或写入**：按仓库既有纪律需单独授权；
   - **既有 Memory 的 bootstrap 导入**（M9-D12）：默认不做；如做需逐条预览 + 具名授权；
   - **超出 §20 冻结方案的新认知入口**：另行处理，不在本 ADR 覆盖面内。
3. **M8 人审保持 PENDING**（PRE-07）：M9 不伪造、不代填、不借用 M8 的人审结论；
   M9 自己的人审是独立判定（§11）。
4. 认知完整性约束（INV-CI-01…05）适用：Belief = **Privileged Cognitive Operation**，
   本 ADR 即其设计审查载体。

## 1. 背景：M9 在四层分离中的位置

M4–M8.5 交付了记忆（有资格的事实留存）、关系（M7）、情绪（M8/M8.5）。缺的一层：
**她对命题的当前判断**——"我听用户说过什么、我从中推断出什么、更正后我现在还信什么"。
此前这层要么不存在，要么被塞进 Memory（把"判断"当"事实"）或 prompt（无审计）。

M9 建立第四层信息分离（计划 §3.1）：

```text
Conversation（原始发言与归因）→ Memory（合格留存的事实）→ Belief（对命题的带来源判断）
                                                              ↘ World-truth（本里程碑不建）
```

三条硬边界（与 INV-CI / M6 教训对齐）：

1. **Belief 不是 World**：只描述 `CHARACTER_INTERNAL`（她的认知），永不写世界真相（M9-D10）。
2. **Belief 不是 Memory**：不自动写入 Memory；Memory 是只读输入权威（§3.3 权威表）。
3. **Belief 不是情绪/关系**：Affect/Relationship 只作只读背景，不提供事实资格或支持等级（M9-D11）。

## 2. 冻结决策（M9-D01…D26，按计划 §20 推荐值）

| 编号 | 裁定要点 | 冻结结果 |
|---|---|---|
| D01 | 本版目标 | 有来源陈述 + 有限行为推断 + 修订闭环（三件一起，缺一则缩减成功主张） |
| D02 | Belief owner | `perspectiveOwnerId` 必填；生产 v1 仅当前 Character；多主体生产触发 TD-20 前不做 |
| D03 | 命题身份 | 槽位键 = `(perspectiveOwnerId, subject.kind, subject.id, predicate, scopeKey)`；**value 不进槽位键** |
| D04 | 来源白名单 | reported 从合格 M4 Memory（§3.1 白名单，代码已核对）；inferred 从受限可信互动；不自动记全部聊天 |
| D05 | 推断范围 | 仅 `interaction.explanation_detail`（detailed/concise）一个槽位 |
| D06 | 推断阈值 | ≥3 个不同合格用户事件 · 跨 ≥2 会话 · 窗口 ≤ 最近 50 个合格交互事件（先冻后测） |
| D07 | LLM evaluator | v1 不引入；规则不确定 ⇒ abstain（未来引入须独立测量 + 不阻塞主链） |
| D08 | 支持强度 | `tentative / supported` 可解释等级；无数值概率；confidence 只描述识别器输出 |
| D09 | reported/inferred 冲突 | 合格本人更正优先；未解 ⇒ disputed；不投票、不用亲密度决胜 |
| D10 | 世界与角色 | Belief 仅 `CHARACTER_INTERNAL`；WORLD scope 一律拒绝；无 World 写入者 |
| D11 | 情绪关系影响 | 不改变事实资格/支持等级/真值；未来偏差模型须另立 ADR |
| D12 | 初始历史 | 空起点（BELIEF_ORIGIN + cutover）；旧 Memory 走原 Recall 路径；bootstrap 需具名授权 |
| D13 | 遗忘 | 同轮读侧遮蔽 + 持久撤回双保险；raw-event 推断的遗忘契约见 §5.4（B-INFERRED 激活前置） |
| D14 | 存储 | 复用通用事件/投影/job 表；**新增迁移 = NONE**（WP0 S5 已证 `belief:<beliefId>` 形状可行） |
| D15 | 输入水位 | 两个具名输入流分别有序消费：`belief-interaction-evaluator` + `belief-memory-reconciler` |
| D16 | 同轮可见性 | 新推断**下一轮**生效；失效/更正**本轮立即**遮蔽；不强求同轮推断 |
| D17 | Context | `SECTION_PRIORITY.belief=50`（既有）；每轮 ≤4 条 · 合计 ≈400 token（既有 quantifier）· 原子条目 |
| D18 | 默认开关 | `CHARACTER_BELIEF_ENABLED` 代码默认 **false**；关闭 = 不评估 + 不注入 + 不后台暗写 |
| D19 | 再开启 | 具名恢复边界；**不追补**停用期行为推断；无可靠边界 ⇒ 重新开启保持 blocked |
| D20 | 旧 src/state | 维持 M8 回退窗口；Belief 永不读旧情绪字段；全退役独立维护不混入 |
| D21 | M7 双缺陷 | WP0-R **已修**（`afa512b`，验证 8/8 + M7/M8 门全绿）；原 R-1…R-5 规则不变 |
| D22 | 规模与长尾 | 先复现后修；阻断能力的必修（TD-08/09 按 PRE-03/04 读数处理）；不预引入向量/图服务 |
| D23 | 阶段锁 | FC-T05 存在性禁令由 WP2 正式替代；不变量与边界断言承接（§9） |
| D24 | 验收 | §15 阈值 + Live 短集 12×3 + 离线 1×500 + Live 长集 1×200 + 独立人审（Acceptance Contract 冻结） |
| D25 | 新外部能力 | **NONE**；能力包仍按 M6.5 路线 |
| D26 | 生产激活 | 单独用户显式批准 + 独立激活 ADR；设计通过 ≠ 真实写入授权 |

**关键冻结值**（数值与名称级，验收契约引用）：

- B-REPORTED 白名单（**代码核对**：`src/kernel/contracts/memory.ts`）：
  `type ∈ CLAIM_MEMORY_TYPES = ['person_fact','preference']` ∧
  `authority ∈ ['EXPLICIT_USER_STATEMENT','EXPLICIT_CORRECTION']` ∧
  `epistemicStatus === 'reported'` ∧ `status === 'active'`。
  `episode / self_experience`（EPISODIC 家族）**不进白名单**——它们是经历描述，不是带槽位命题。
- B-INFERRED 唯一槽位：`interaction.explanation_detail ∈ {'detailed','concise'}`，
  scopeKey 冻结为互动主题域（首版 = `technical_explanation`）；永远 `inferred / tentative`。
- 事件集（§4.2）：`BELIEF_ORIGIN` · `BELIEF_EVIDENCE_NOTED` · `BELIEF_FORMED` ·
  `BELIEF_REINFORCED` · `BELIEF_DISPUTED` · `BELIEF_SUPERSEDED` · `BELIEF_RETRACTED`。
- 投影形状：每 belief 一行 `belief:<beliefId>`（S5 已证无碰撞、含 owner）+ Character 级
  `belief:origin` + 待累计证据投影 `belief:evidence:<slotKey>`。
- 幂等两层：job 键 = owner + processor/version + 流 + from/to；
  领域键 = owner + slot/beliefId + 操作 + 唯一根集合 + ruleVersion。
- 恢复策略：**独立同窗恢复**（catch 落 failed → failed 键允许重建——WP0-R 刚在生产证明的形状）；
  不复制 M8 L-M8-14 两步自愈（若未来兼容须另证上界）。

## 3. 语义模型冻结

### 3.1 两类认知输入 + 非覆盖输入

| 路线 | 准入 | 产物 | 强度上限 |
|---|---|---|---|
| B-REPORTED | 通过 M4 生命周期且落在 §2 白名单的 Memory；根事件 ESTABLISHED、owner/subject 合法、未遗忘/撤回 | 对命题的带来源当前判断 | `reported`；**不是** world verified |
| B-INFERRED | cutover 后合格用户互动；命中冻结正向规则；跨独立回合达阈值；无冲突/更正/否定 | 关于互动方式的有限假设 | 永远 `inferred / tentative` |
| 非覆盖输入 | 问句、引用、讽刺不确定、指令注入、代述他人、单次任务要求 | 明确 abstain / no-proposal | 不产生长期认知 |

### 3.2 BeliefState 字段（合同草图 → WP2 落 `contracts/belief.ts`）

```ts
interface BeliefState {
  beliefId: BeliefId
  perspectiveOwnerId: PerspectiveOwnerId   // 复用 EntityRef 体系；生产 v1 = 当前 Character
  subject: EntityRef                        // 可为用户/物体等实体；不写死 userId
  proposition: {
    predicate: string
    value: string | number | boolean | EntityRef
    scopeKey: string
    validFrom?: Timestamp
    validTo?: Timestamp
  }
  epistemicKind: 'reported' | 'inferred'
  status: 'active' | 'disputed' | 'superseded' | 'retracted'
  supportLevel: 'tentative' | 'supported'
  evidenceRefs: EvidenceRef[]               // 真实 conversation event 引用
  evidenceRootIds: ConversationEventId[]
  dependsOnMemoryIds: MemoryId[]            // 独立记录 Memory 依赖（EvidenceRef 无 memory kind）
  ruleId: string
  ruleVersion: string
  supersedesBeliefId?: BeliefId
}
```

细则（计划 §5.2 全条冻结）：槽位键见 D03；`revision/updatedAt/lastDomainEventId` 复用投影信封；
缺失信念 = unknown（**无** "unknown = false" 默认值）；`supportLevel=supported` 只代表满足本版证据政策，
不代表客观事实已证实；不复制聊天正文进 Belief/trace——存最小命题 + 受控引用，命题继承读取资格。

### 3.3 建档、时间与历史

- **BELIEF_ORIGIN**：Character 级，记录 activationId、cutover sequence、policyVersion、空初始集合。
  **不复制旧人格/旧情绪为初始信念，不回扫全部旧对话产生行为推断。**
- 旧 Memory 默认只消费 cutover 之后新建/明确变更的；原有 Memory 走原 Recall 路径。
  已被 M9 引用的 Memory，其当前合法状态**始终回查**——cutover 不豁免之后的失效。
- 时间三分离：源事件时间 / 判断记录时间 / 命题有效期。**不照抄 Affect 指数衰减到事实真假**
  ——时间流逝不是真假证据。

### 3.4 有限行为推断判据（先冻后测）

- 同一 active user、同一 scope、同一取值：≥**3** 个不同合格用户事件，跨 ≥**2** 会话。
- 候选窗口 ≤ 最近 **50** 个合格交互事件；跨页累计由派生投影持久化，不靠无限尾窗。
- 只计用户对解释方式的**明确选择/反馈**；普通问题、单次"这题写细一点"、引用、假设、
  代第三人说话不计为长期倾向支持。
- 同根重复、重复投递、同一事件多轮摘要 **不能多计**（INV-M9-04/08）。
- 达阈值只产 **tentative**；更多重复不自动转 reported。
- 相反反馈未达阈值 ⇒ 保留不确定；双向均成形 ⇒ **disputed**（不靠净票数制造确定性）。
- 明确、合格、目标唯一的更正**优先**；隐式统计不压本人更正。
- 首版**不做**信念→信念递归推断，不做长期自证循环。

## 4. 资格、事件与状态机

### 4.1 输入资格矩阵（计划 §6.1 全表冻结）

| 来源 | 允许形成 v1 持久 Belief？ | 约束 |
|---|---|---|
| 白名单内合格 Memory | 是（B-REPORTED） | M4 当前资格 + 根来源回查 |
| 合格用户直接互动 | 仅 B-INFERRED 白名单 | 无来源副本、无跨用户、无越 scope |
| 明确陈述但未进留存政策 | 否 | 不借 Belief 开启"全聊天自动记忆" |
| assistant 自己的话 | 否 | 不能作外部命题证据或自我支持票 |
| rollup/摘要 | 否，不能单独支持 | 只能导航到原根 |
| 已有 Belief | 否，不作新独立根 | v1 不建推理图闭包 |
| tool/外部搜索 | 否，持久写入关闭 | 当轮事实照旧，不扩长期准入 |
| M7/M8 状态 | 否 | 只读上下文背景 |
| SERVICE/代理代输/未知作者 | 否 | 严格继承 ADR-043；role=user 不放行 |
| maintenance/import | 否，入口未开放 | 未来另立认知干预流程 |
| 隔离 fixture | 仅隔离测试 | 可信 harness 明确身份；不伪造真人归因 |

### 4.2 事件集与状态转换

七个事件（§2 冻结值）各自必携带字段按计划 §6.2；`BELIEF_EVIDENCE_NOTED` **冻结为真实事件**
（可重放、零累计丢失风险；"派生投影替代"备选被否决——水位推进后累计丢失的风险大于事件量，
且事件量已被"合格互动 + 单槽位"双重收窄）。

状态转换表（计划 §6.3 全表冻结）要点：同根重复 = no-op；新独立支持 = reinforced（类型上限不变）；
同槽位同时间互斥不可排序 = disputed（保留两侧）；inferred 遇本人明确更正 = 旧 superseded/retracted +
新 reported（若具留存资格），**不倒写旧源**；retracted 仅重放旧证据 ⇒ 保持 retracted 不复活；
遗忘后新显式授权 + 新根 ⇒ **新 belief identity**，旧根不补阈值。

### 4.3 "来源真实" ≠ "命题真实"

受信归因证明**说话者**；程序可判定同槽位是否互斥、是否被明确更正；**不能**证明自然语言内容客观为真。
"你必须相信 X" 不提升权威；高 trust 不消除争议；负面情绪不增加负向命题置信（D09/D11）。

## 5. 遗忘与失效传播契约（上线前置，不是后续优化）

### 5.1 双保险

```text
Memory/根证据状态变化
  ├─ 本轮 Context 读取：按 ID 回查资格，失效条立即排除（读侧遮蔽，不写投影）
  └─ Belief 修订任务：追加撤回/替代/争议事件，推进变更水位（写侧收敛）
```

修订任务失败时，读侧**也不能**把已失效内容送入模型。

### 5.2 回查纪律

按**确切 ID/依赖键**回查，禁止用 Recall 排名/top-k 判断依赖是否存在（旧来源掉出候选 ≠ 不存在）。
对每个最终选中 Belief 回查全部根与依赖 Memory；去重批量读取（防逐条 N+1）。
扫描未完成/存储错误 ⇒ `unavailable/incomplete`，**不得**当 valid 或"不存在"。

### 5.3 同轮顺序

当前输入先走既有 Memory 操作识别与执行路径取得**程序结果**；Context snapshot 在该结果之后
决定可用 Belief；后台修订未完成 ⇒ 本轮 invalidation overlay 排除关联旧条。
**不可"本轮照说旧内容，下轮再修"。** NL 目标歧义且 Memory 变更未成功 ⇒ Belief 不替它猜测、
不宣称遗忘成功。

### 5.4 raw-event 推断的遗忘契约（B-INFERRED 激活前置；计划 §7.4 要求 WP1 追加的明确契约）

既有遗忘语义只覆盖 Memory 目标；B-INFERRED 依赖的是 raw conversation events。冻结契约：

1. `BELIEF_RETRACTED`（reason ∈ {'user_forget_request','dependency_invalidated', …}）
   **必携 `forbiddenRootIds`**：本次失效所禁止再用的根事件集合。
2. 评估器/Validator 对同槽位的任何新 B-INFERRED 提案，**拒绝**其根集合与
   `forbiddenRootIds` 相交者（失败关闭，不静默跳过）。
3. 遗忘后的**新**互动根可形成**新 belief identity**（§4.2）；旧根永不补足新阈值。
4. 物理账本按既有审计规则保留；对话与普通查询不得重新暴露遗忘内容
   （不承诺 append-only 架构已实现物理擦除）。
5. "忘记关于我的解释偏好"解析为 belief scope 沿既有授权目标解析纪律（TD-09 同款：
   目标不唯一 ⇒ 澄清，无误删、无成功口吻）。

**本契约落地（WP5）并通过 B28–B31 场景之前，B-INFERRED 不得激活**（即使总开关已开——
WP8 装配时以独立子开关或资格闸实现该前置）。

### 5.5 阻止认知反向污染

Belief 不自动写入 Memory；摘要中的"她之前觉得 X"不是恢复已撤回 Belief 的新证据；
重建读取追加事件 + 有效控制事实（不能只重放 formed 漏掉 retracted）；引用缺失与资格不明
都失败关闭。

## 6. 处理链、持久化与恢复

### 6.1 两条链

```text
主链：用户请求 → 真实 conversation event → 既有 Memory 指令结果 + 当轮 invalidation overlay
      → 读取已提交且当前有效的 Belief → ContextCompiler → 回复生成（既有 reply-truth 链）

认知处理链：读事件区间/Memory 变更区间 → 资格筛选 + 有限规则 → BeliefProposal
           → BeliefValidator → 事务（域事件 + processed operation + projection）
           → 任务终态 + 连续水位
```

v1 新推断下一轮使用（D16）；更正/遗忘遮蔽同轮生效。确定性小型读侧资格校验可在主链执行；
未来 LLM Belief Processor 只能走 Slow Path。

### 6.2 存储（迁移 = NONE，WP0 S5 已证）

复用 `character_domain_events / character_projections / processed_operations / character_jobs /
processor_watermarks`；窄 `belief-store.ts` 只做读取与装配。投影键：`belief:<beliefId>`（每条一行，
有界）+ `belief:origin` + `belief:evidence:<slotKey>`（待累计）。**不把所有信念放进一个
无限增长 JSON 行。** 若通用形状将来不足，单列 ADR + 新迁移号；不改 0001–0009。

### 6.3 双输入流与水位（D15）

Conversation sequence 与 Memory domain sequence **不是同一计数器**——分别消费，
禁止用一个最大值代表另一条流已处理。两个具名 processor 共享同一 Validator、槽位政策与存储写口；
不新增通用 workflow 引擎。分页固定本次 high-water mark；只推进连续处理完的范围；
第 2000 行后仍有数据 ⇒ 不推进到总尾，返回 `incomplete`。

### 6.4 两层幂等

Job 键（§2）+ 领域操作键（§2）。同根被不同窗口包含只计一次。规则升级不清空 processed 表；
升级须明确哪些旧记录继续有效、哪些只影响新增输入。

### 6.5 故障矩阵（计划 §8.5 全表冻结）+ 恢复形状

十行故障矩阵按计划 §8.5 逐行冻结（入队前失败 / running 后抛错 / Validator 拒绝 /
append 成功投影失败 / apply 后中断 / completed 后 watermark 失败 / 双 worker /
依赖失效修订失败 / 只读校验失败 / UI 故障）。

**恢复形状冻结 = 独立同窗恢复**：调度器消费段整体入 try（含试算），catch 对已建 job 行
如实 `finishJob('failed')`（finishJob 自身失败吞掉、主错误优先），failed 幂等键允许重建 ⇒
同窗重试。这是 WP0-R 刚在 M7 生产代码证明并 8/8 验证的形状（R2/R3/R4/R5），M9 直接采用；
**不采用** M8 L-M8-14 两步自愈（若未来需兼容须另冻上界证明）。

## 7. 上下文与开关

- **唯一入口** `ContextCompiler`；用既有 `ContextSectionKind='belief'` 与
  `SECTION_PRIORITY.belief=50`；不新增世界真相系统提示、不在 main/provider 直接拼接。
- 每轮 ≤4 条 · 合计 ≈400 token（既有 quantifier 计算）· subject/主题相关才入选；
  零预算或开关关闭 ⇒ 不产 section。
- **原子条目**：命题 + 当前状态 + 来源类别 + 限制 + sourceRefs 整组进出；
  disputed 两侧与"不确定"标签原子呈现；空间不足整组裁掉（不能裁掉"暂定"留命题正文）。
- 表达范式（renderer 纯函数 + byte/结构基线测试）：
  「当前可用判断；内部参考，来源强度不等于客观真值」+ 明确陈述/暂定推断分列 + 限制行
  （"这是互动推断，不是用户明确承诺；新更正优先，不得说成'你说过'"）。
- Memory/Belief 同根去重：稳定槽位/来源指纹识别；选择层去重，不造全文语义合并器；
  无法安全合并 ⇒ 保留 Memory 权威内容 + Belief 只给认知限定。
- 组合场景冻结（§9.4）：高亲密+错误诱导 / 负面 affect+合法纠正 / 正面 affect+无依据赞美 /
  关系降档+已明确用户偏好 / 预算极小+三 section 并存。
- **开关**（D18/D19）：`CHARACTER_BELIEF_ENABLED` 代码默认 false；一个总开关控制生产消费
  与上下文；关闭 = 保留域事件与投影、不推断、不注入、不后台暗写。再开启按原 origin 与持久水位
  恢复；**不追补**停用期行为推断；启停产生真实控制记录（可持久审计），不用当前时间猜停用时刻；
  无可靠边界 ⇒ 重新开启 blocked，走具名恢复流程。

## 8. 不变量登记（INV-M9-01…12 自本 ADR 起正式登记）

计划 §3.2 的 12 条不变量**自本节起正式登记**（此前仅属计划）。机械检查面按计划原表
（负控形状已在 WP2-WP8 各门落地）：

| ID | 不变量 | 机械检查 |
|---|---|---|
| INV-M9-01 | 每条信念必须有合法 perspectiveOwnerId 与 EntityRef 主体 | 缺 owner、外来 owner、同 id 不同 kind 负控 |
| INV-M9-02 | 无有效证据不能形成/维持可入模信念 | 空根、缺源、跨 owner、资格撤销拒绝 |
| INV-M9-03 | inferred 永不伪装为 reported/observed | 来源类型程序推导；模型不能自报提升 |
| INV-M9-04 | Assistant/summary/既有 Belief 不能自我循环增信 | 重复根去重、循环引用拒绝、派生链追根 |
| INV-M9-05 | Affect/Relationship 不提供事实权威 | 改 v/a、trust/closeness 不改变支持状态 |
| INV-M9-06 | 更正/撤回/遗忘不能由第二份投影绕过 | 同轮遮蔽、后台收敛、重启后不复活 |
| INV-M9-07 | Belief 事件只描述 CHARACTER_INTERNAL | WORLD scope 一律拒绝；无 World 写入者 |
| INV-M9-08 | 同一输入重复处理不能增加支持 | 跨窗口、跨重启、并发重复零新增 |
| INV-M9-09 | 投影可由事件确定性重建 | 字段级一致；reducer 无 DB/网络/挂钟/随机 |
| INV-M9-10 | 实际入模范围可审计 | 候选/合格/选中/裁掉四集合分别记录 |
| INV-M9-11 | 修订不抹除历史 | old/new 因果链完整；不 UPDATE 历史 payload |
| INV-M9-12 | 缺证据是未知，不是反命题为真 | unknown vs false 成对场景 |

## 9. FC-T05 阶段锁替代记录（D23；WP1 任务 6）

**旧断言**（`scripts/future-compat-tests.ts` FC-T05 组）防什么：

1. `M3.5 不实现 Belief store`（contracts 下无 belief 文件）：M3.5 时代 Belief **无语义权威**——
   防"顺手实现半个信念存储"（无 ADR、无资格闸、无生命周期），防把 perspectiveOwnerId
   契约约定误当已实现能力。
2. `两个角色可作为不同 perspectiveOwner 被区分`：**永久契约前提**，与存在性无关。

**新阶段承接判据（等强或更强）**：

| 旧防的东西 | 新承接（更强） |
|---|---|
| 无语义权威的半实现 | ADR-070 DESIGN FROZEN（本文件）：字段/资格/生命周期/遗忘全部有权威定义 |
| 未经纪律的 contracts 文件 | WP2 建 `contracts/belief.ts` 时：kernel:test 静态边界组覆盖（纯类型纯函数、不 import 框架/SQL/node:*）+ 语义边界断言（CHARACTER_INTERNAL scope 必填、perspectiveOwnerId 必填、WORLD 拒绝） |
| 无行为面保证 | INV-M9-01…12 机械检查（WP2–WP8 各门）+ 场景矩阵 B01–B48 |
| 暗中开启 | `CHARACTER_BELIEF_ENABLED` 默认 false + "开关必须被真的消费"回归锁（m4:test/m4.5:test 同款） |

**替换动作**（WP2 执行）：删除/改写存在性断言（改为"belief 合同存在且过边界断言"），
**保留** perspectiveOwner 区分测试（永久前提）。多视角与世界隔离语义（FC-04 等）不动。

## 10. 被否决 / 延后备选

| 备选 | 裁定 |
|---|---|
| 开放世界观 / World 写入 | 不采用（D10）——世界真相独立于认知，M9 不建 |
| 全聊天自动信念化 | 不采用（D04）——须重审长期留存权限 |
| 每槽位行为推断 | 不采用（D05）——每扩一槽须独立语料/作用域/遗忘方案 |
| LLM Belief evaluator（v1） | 延后（D07）——引入须独立测量、输出落盘、重试语义、不阻塞主链 |
| 数值置信度 | 不采用（D08）——无校准方法的概率是模型自报 |
| 票数/亲密度决胜冲突 | 不采用（D09）——违反来源资格边界 |
| bootstrap 旧 Memory 为初始信念 | 延后（D12）——需逐条预览 + 具名授权，不在本 ADR |
| 新建 belief 专用表 | 不采用（D14）——WP0 S5 已证通用形状可行 |
| 混用两条输入流的 sequence | 不采用（D15）——不可接受 |
| 同轮推断生效 | 不采用（D16）——须证时延且不把 LLM 塞主链 |
| M8 式两步自愈恢复 | 不采用（§6.5）——优先独立同窗恢复；兼容两步须另证上界 |
| EVIDENCE_NOTED 改派生投影 | 不采用（§4.2）——累计丢失风险 > 事件量收益 |
| 向量库/图数据库 | 不采用（D22）——先复现，阻断才修，不预引入服务 |
| 遗忘 = 物理擦除 | 不承诺——append-only 架构下按 §5.4 契约执行受控遮蔽 |

## 11. 后果

1. **实施授权范围**：WP2–WP10 按计划 §13 执行；全程**无生产影响**——
   `CHARACTER_BELIEF_ENABLED` 代码默认 false（B6 基线：.env 无该行直至 WP11）；
   验收全部在隔离库/生产副本。
2. **机械保证面**：Validator 唯一放行口、事件账本、投影可重放、两层幂等、
   双流水位、失败关闭资格——全部继承 M4–M8.5 已验证的架构纪律。
3. **新增读侧成本**：Belief 入模前按 ID 回查全部根与依赖（批量去重，防 N+1）；
   主链只做确定性小型校验。
4. **上下文预算**：belief section ≤4 条/≈400 token，与既有 section 组合受组合预算约束
   （组合场景 §7 冻结清单必测）。
5. **语义正确性不在本 ADR 保证范围**：机械层保证资格/格式/版本/幂等/事务/重放；
   语义层由 WP2 语料 + WP8 场景矩阵 + WP9 真模型盲测 + 人审证明。
6. **B-INFERRED 激活前置**：§5.4 契约落地并通过 B28–B31 之前不激活（独立资格闸）。

## 12. 激活边界（本文不授予的东西）

本 ADR 的 `DESIGN FROZEN` 授权**实施与验收**，不授权生产激活。WP11 硬前置：

1. Acceptance Contract 全维度 PASS（§15 阈值 + 场景矩阵 + 长轨迹 + 规模）；
2. 独立人审 PASS（判定权在人；M8 人审 PENDING 不借用、不代填）；
3. 用户显式批准（M9-D26）。

激活载体 = 独立状态修订 ADR（与 ADR-065/067/069 同形）：`.env` 设
`CHARACTER_BELIEF_ENABLED=true`（**代码缺省仍 false**）；回滚 = 删该行；
已提交域事件/投影/水位保留。

## 13. 权威/风险映射（WP1 产物；全表见计划 §3.3 / §21.1）

**权威映射**（M9 权限列；概念全表按计划 §3.3 冻结）：

| 概念 | 权威载体 | M9 权限 |
|---|---|---|
| 用户明确保存的事实/偏好 | M4 Memory lifecycle | 只读消费 + 既有变更通知；不另写一套 Memory |
| 原始发言与归因 | conversation events + trusted origin reading | 只读；不信 payload 自报作者 |
| 对证据的当前判断 | Belief domain events / projection | **本里程碑唯一新增内部权威** |
| 关系 / 情绪 | M7 / M8 投影 | 只读背景，不作事实分数或真值 |
| 执行成败 | ActionResult + ledger + verification 阶梯 | 保持既有真相，不从口吻推导 |
| 搜索证据 | 当轮 ExternalEvidence | 只做当轮理解；无自动长期写入 |
| 是否真正入模 | ContextCompiler 产物与 trace | Belief 不能自报"模型已看到" |

**风险映射**（早期信号 → 处理；全表按计划 §21.1 冻结）：

| 风险 | 早期信号 | 处理 |
|---|---|---|
| 变成 Memory 镜像 | 只有 copied claim，无独立推断/修订/限定 | 查 B11/B24/B28；不削成"多一张表"收口 |
| 推断变成事实 | inferred 被渲染成"你说过" | 程序标签 + Live 双查；严重语义门失败 |
| 遗忘被缓存绕过 | Memory 撤回后 Belief 仍入模 | 按 ID 回查 + 当轮 overlay；阻断激活 |
| 沉默式全拒绝 | 负控全绿、正控 0 | measured_count + 正控覆盖；量具 INVALID |
| 来源循环 | 一个根被摘要/回复/重跑反复增强 | root 去重、不接 belief 递归证据 |
| 规则覆盖被夸大 | 只测固定短句 | 分列受支持/开放表达；扩展 = 新规则版本 |
| 主链变慢 | Context 回查 N+1 或额外 LLM | 批读、去重、测 p50/p95；保持 Slow Path |
| 任务永久 running | catch 不收尾/水位超前 | B39/B40 断点注入；不依赖下一条消息 |
| 证据与生产不一致 | 测试绕过归因入口/手塞状态 | 真入口、同工厂、版本/flag 指纹 |
| 旧门误挡新阶段 | belief 文件一建 m3.5 必红 | §9 阶段锁正式交接，保持反向边界 |
| 过度清债 | M9 顺手改关系/人格/旧归因 | 文件地图与职责 diff 逐项审查 |

**停止条件**（计划 §21.2）与**降级行为**（计划 §21.3：Belief 不可用 ⇒ 普通对话继续，
不说"已经更新信念"；证据不明 ⇒ 该条不入模，系统错误不转化为命题为假；
推断关闭 ⇒ 明确不形成新推断，不声称在长期学习）按计划原文冻结。

## 14. 修订记录

| 日期 | 修订 | 依据 |
|---|---|---|
| 2026-09-27 | 初版冻结（M9-D01…D26 + 语义模型 + 遗忘契约 + INV-M9-01…12 + FC-T05 承接） | 用户目标指令「根据计划书进行M9建设」+ 计划 §20 裁定语义 + WP0/WP0-R 实测 |
