# ADR-066：M8 Affect —— 情绪状态演化的语义冻结

> 状态：**ACCEPTED / DESIGN FROZEN**
>
> 日期：2026-09-26。里程碑：M8（Affect Domain）。
> 计划：[`docs/m8/M8-Execution-Plan.md`](../m8/M8-Execution-Plan.md)（执行基线）。
> 前置：M7 已完成并生产激活（ADR-064 / ADR-065）；M8 WP0 准入 PASS 13/13
> （`artifacts/m8/m8-wp0-admission-20260926-a82080865706-2892/`）。
> 授权：用户目标指令「按照计划书，进行 M8 建设」（2026-09-26）。
> 本 ADR 冻结计划 §10 WP1 的 M8-D01…D14 全部裁定（按计划推荐执行），
> 并把 §5 的候选规则表升格为 **affect-rules@1** 冻结规则表。
> 生产激活**不**随本 ADR 发生（M8-D14 ⇒ ADR-067，独立用户授权）。

---

## 0. 问题与结论一句话

**问题**：现有的 valence/arousal 持久字段、时间衰减与行为映射缺少一条可审计的
事件链路——真实用户交互如何形成情绪提案、提案如何被验证、事件如何进入投影、
投影如何进入 prompt、失败如何降级、重复/重启/衰减如何证明，全部没有机器判据。

**结论**：按 M7（ADR-064）已验证的同构链路，为情绪建立 **Affect Domain**：
`合格用户交互 → 确定性 Affect Evaluator → Proposal → Affect Validator（失败关闭）
→ AFFECT_DOMAIN_EVENT → Affect Reducer/Projection → read-time decay →
Affect Context Section（priority 52）→ 本轮回复`。
情绪属于 **Character**（单一 `affect:character` 投影），不属于对话或用户；
v1 用**冻结规则表**（确定性），LLM evaluator 仅预留；生产开关缺省 **false**。

---

## 1. 裁定总表（M8-D01 … M8-D14，全部按计划推荐冻结）

| 决策 | 裁定 | 依据/边界 |
|---|---|---|
| **M8-D01 所有权** | Character-level 全局情绪：`projectionType = affect:character`，`characterId = 唯一 Character` | 禁止 `affect:<conversationId>` / `affect:<userId>` / `affect:<messageId>` 第二权威（计划 §3.1）。对话/用户/消息只能作为来源引用与资格条件 |
| **M8-D02 分片** | 不分片；来源只做引用和资格 | 多用户隔离由资格条件（M8-D11）表达，不由状态键表达 |
| **M8-D03 评估器** | 确定性规则 v1（`affect-evaluator@1` + `affect-rules@1`）；LLM 仅在 processor 合同预留（未来 M8.1 走 slow path，输出仍是 proposal，过同一 Validator） | 计划 §5.3 的四条理由；不可重现的分类器不进核心闭环 |
| **M8-D04 同轮生效** | 确定性 evaluator 成功时**同轮生效**：beginTurn 落事件 → 同步 bounded 评估 → 提交 → 读投影 → 编译 section → 调模型 | 前提：评估无 LLM、无网络、短路径；失败 ⇒ 用旧有效状态，回复照常（§3.7） |
| **M8-D05 历史重放** | 默认**不重放**：激活时以 `AFFECT_ORIGIN`（`ACTIVATION_BASELINE`，valence=0/arousal=0）建立中性起点，记录 `cutoverSequence`；只消费切换点之后的合格交互 | 旧历史不伪装成她亲历的情绪事件；历史导入只能是未来明确批准的 `HISTORICAL_IMPORT`（v1 不启用） |
| **M8-D06 初始值** | valence=0、arousal=0 的中性 origin | 与 `src/state` 既有 `INITIAL_STATE` 情绪初值一致（0/0） |
| **M8-D07 无变化交互** | 产生 `AFFECT_TOUCH`（消费锚点），不产生 `AFFECT_IMPACT` | 中性对话 ≠ 未处理；read-time decay 需要明确锚点 |
| **M8-D08 每轮影响数** | 一次用户事件最多 **1 个 TOUCH + 1 个主导 IMPACT**；只有一个主导 ruleId 能改变 valence/arousal；不做多规则叠加 | 计划 §3.4 |
| **M8-D09 规则冲突** | 冻结全序优先级（§4.2）；命中多族时取最高优先级的一条；无法判定 ⇒ touch-only（`A-UNCERTAIN` 为具名回退，v1 恒不产生 impact） | 拒绝猜测 |
| **M8-D10 关系耦合** | M8 不读不写 M7 投影；两 section 独立读取（relationship 55 / affect 52）；trust/closeness 与 valence/arousal 不得互相混入 | M7 语义由 ADR-064 继续约束 |
| **M8-D11 多用户** | 当前生产边界 = 单 active user（配置的 `USER_NAME` 对应 userId）；其他来源 fail-closed（拒绝码 `affect_source_unqualified`） | 多渠道多用户是未来里程碑的准入边界 |
| **M8-D12 旧 state 迁移** | 不隐式迁移。已核实：现行链路**从不写**旧情绪字段（`saveState` 仅 init 建档；无 evaluator 写 delta），唯一每轮写的是 `markInteraction`（`lastInteractionAt` 锚点，非情绪值）⇒ 「不同时写两条情绪权威」天然成立。若未来要从旧非中性值初始化，必须走 `MAINTENANCE_REPAIR`/`HISTORICAL_IMPORT` 事件 | 计划 §7.1/§7.2 |
| **M8-D13 外部能力** | **NONE**：不引入新外部服务、桌面控制、后台自主任务、网络能力或 MCP 适配器 | 能力影响矩阵 = NONE（计划 §14） |
| **M8-D14 激活** | 独立 ADR-067 + 用户逐字授权；代码缺省 `CHARACTER_AFFECT_CONTEXT_ENABLED=false`；gates PASS 不自动激活 | 与 M7 ADR-065 同构 |

---

## 2. 状态模型（canonical）

### 2.1 AffectState（投影 state；信封字段不重复）

~~~ts
interface AffectState {
  originated: boolean            // ORIGIN 之前不可采信（与 M7 同语义）
  valence: number                // [-1, 1]
  arousal: number                // [0, 1]
  originKind: AffectOriginKind
  /** touch 锚点：TOUCH/IMPACT 都刷新；read-time「分开多久」与衰减展示用 */
  lastInteractionAt: number | null
  /** 情绪轴锚点时刻：ORIGIN/IMPACT 设置；read-time decay 从这里折算 */
  lastAffectEventAt: number | null
  lastDomainEventId: string | null
  /** M8-D05 切换边界：ORIGIN 记录；资格判定用它拒绝切换前事件（A19） */
  cutoverSequence: number | null
}
~~~

说明：计划 §4.1 建议形状中的 `characterId` / `projectionVersion` **不进 state**
——信封（`CharacterProjection`）已携带 `characterId` 与 `revision`，state 内重复
即制造双权威（M7 RelationshipState 同一纪律）。字段微调在计划允许范围内。

### 2.2 AffectOriginKind（登记表）

| OriginKind | 含义 | v1 允许 |
|---|---|---|
| `ACTIVATION_BASELINE` | 激活时建立中性起点 | 是（唯一生产 origin） |
| `INTERACTION_DERIVED` | 合格用户交互经冻结规则形成 | 是（IMPACT 事件的 originKind） |
| `MAINTENANCE_REPAIR` | 管理/修复/迁移产生的内部变更 | **fail-closed**：登记在册、validator 拒绝（`affect_origin_injection_not_enabled`），未来维护入口另立授权 |
| `TEST_FIXTURE` | 隔离测试数据 | 仅 test-only 标记；不进生产 |
| `HISTORICAL_IMPORT` | 历史导入 | **不启用**（M8-D05） |

### 2.3 事件类型（登记进 `createFullDomainEventRegistry`）

~~~text
AFFECT_ORIGIN   建档：一条 character 一个 ORIGIN；中性起点 + cutover 记录
AFFECT_TOUCH    合格交互已消费：刷新锚点，delta 恒为零
AFFECT_IMPACT   冻结规则产生的有界情绪变化：至多一个主导 ruleId
~~~

**AFFECT_ORIGIN payload**（schema 校验、≤4096 字节）：

~~~text
characterId · initialValence=0 · initialArousal=0 ·
originKind='ACTIVATION_BASELINE' · activationId · cutoverAt · cutoverSequence ·
policyVersion='affect-policy@1'
~~~

**AFFECT_TOUCH payload**：

~~~text
sourceEventId · sourceSequence · originKind='INTERACTION_DERIVED' ·
evaluatorVersion · proposalId · traceId?（可缺省：启动 catch-up 无 trace）
~~~

**AFFECT_IMPACT payload**：

~~~text
sourceEventId · sourceSequence · ruleId · ruleVersion ·
deltaValence · deltaArousal · originKind='INTERACTION_DERIVED' ·
evaluatorVersion · proposalId · matchedPatternId? · traceId?
~~~

三条 payload 纪律：**不写用户原话**（原文留在 conversation event 边界内，只存引用）；
schema 可校验；版本明确；唯一 idempotency key；不写外部事实语义（FC-04，
scope 恒 `CHARACTER_INTERNAL`）。

### 2.4 纯函数（WP2 落点 `src/kernel/contracts/affect.ts`）

~~~text
reduceAffect(state, domainEvent) → nextState      // 纯；只用 event.createdAt，不读墙钟
effectiveAffect(state, now, decayPolicy) → EffectiveAffectState
renderAffectGuidance(effective, policy) → string  // 确定性；不暴露数值
~~~

`EffectiveAffectState`（只读派生，**永不回写**投影、不产生事件）：

~~~text
valence · arousal · valenceBucket · arousalBucket ·
behaviorGuidance: string[] · asOf · decayApplied: boolean
~~~

---

## 3. 资格与证据（M8-D11 / 计划 §3.2）

一条 conversation event 能形成 Affect 影响的**全部**条件（validator 逐条机器判定）：

~~~text
type = user_message
originator = Known(USER)（processorEventViewOf 的受信信封）
sourceQualification = ESTABLISHED（sourceQualificationOf 派生）
actor = 配置的唯一 active user
sequence > cutoverSequence（M8-D05 切换边界）
未被重复消费（幂等键）
~~~

以下来源**一律不得**产生 Affect Impact（负控清单，WP3 逐条落量具）：
assistant message · tool output · external evidence/search result ·
unknown/contradicted origin · 非 active user · 切换前历史事件 ·
测试注入未标 test-only · 其他 Character 的事件 · 仅由时间经过推断的"用户情绪" ·
旧 state 字段本身。

证据资格**单源复用** M5.1.1 的既有判定：`processorEventViewOf`（唯一受信视图生产者）
+ `sourceQualificationOf`（唯一资格判定）。M8 不重写、不绕过、不放宽。

---

## 4. 规则表冻结（affect-rules@1）

### 4.1 数值表（delta 上限内；候选值升格为冻结值）

| ruleId | 触发类别 | Δvalence | Δarousal | 说明 |
|---|---|---:|---:|---|
| A-NEUTRAL-TOUCH | 普通中性互动 | 0 | 0 | 只 touch，不产生 impact 事件 |
| A-GRATITUDE | 感谢、认可、温和肯定 | +0.08 | −0.03 | 低幅正向、轻微安定 |
| A-REPAIR | 道歉、修复、承认造成影响 | +0.12 | −0.08 | 不把"道歉"机械等同于完全修复 |
| A-WARM-CONTACT | 温暖关心、亲近表达 | +0.08 | +0.03 | 正向但可能提高互动激活 |
| A-COMFORT | 安慰、平复、缓和 | +0.10 | −0.08 | 不等于解决事实问题 |
| A-HOSTILE | 明确攻击、侮辱、敌意 | −0.15 | +0.12 | 只接受高置信、目标明确的形式 |
| A-REJECTION | 明确拒绝、关系撤回表达 | −0.10 | +0.08 | 普通"不同意"不触发（负控） |
| A-URGENT | 明确紧急、强烈催促 | 0 | +0.10 | 主要影响 arousal，不动 valence |
| A-UNCERTAIN | 规则冲突或证据不足的具名回退 | 0 | 0 | v1 恒不产生 impact（M8-D09 全序可判定） |

**上限**：`MAX_AFFECT_DELTA_PER_EVENT = 0.25`（valence 与 arousal 同限；
语义来源 = `src/state/types.ts` 既有 `MAX_DELTA_PER_TURN` 情绪轴）。
validator 对超限 **拒绝**（`affect_delta_out_of_bounds`），**不静默夹取**。

### 4.2 优先级全序（M8-D09；高 → 低）

~~~text
A-HOSTILE > A-REJECTION > A-URGENT > A-REPAIR > A-COMFORT > A-GRATITUDE > A-WARM-CONTACT
~~~

理由：敌意/拒绝是高风险读法，在场即主导（对她的自我保护保守）；
紧急改变回应节奏，先于修复/安慰；道歉是同一消息里最强的社会行为；
安慰强于感谢；感谢强于一般温暖表达。一次用户事件命中多族时**只取最高一条**
（M8-D08），不做叠加。

### 4.3 匹配语义（冻结）

- **句内匹配，不跨句**：句子切分沿用 M7 的切分器语义（`[。！？!?\n;；]+`）。
- **疑问抑制**：句末为 `？/?` ⇒ 该句不触发任何规则（"你讨厌我吗？"不是敌意）。
- **每族每消息至多一命中**；主导规则按 §4.2 全序取一条。
- **守卫词**：每个 pattern 带冻结守卫词表；句内出现守卫词 ⇒ 该 pattern 不触发
  （否定/转述/玩笑的近邻负控，词表随 pattern 冻结在 `affect-rules@1`）。
- **引号抑制**：句内命中词出现在引号（`「」『』“”`）内 ⇒ 不触发（转述/引用不是直接表达）。
- **词形冻结**：pattern 表是冻结词形判据（M7 附录 A 同纪律）；覆盖面外的表述不触发，
  扩展 = 升 `affect-rules@2`，不允许"顺手加词"。
- **明确不做的推断**（计划 §5.2 全文有效）：不做心理判断、不推断用户真实情绪、
  不从工具失败/她自己的语气/不回复推断任何情绪事件。

### 4.4 版本与重放

`affect-rules@1` 冻结后，规则变更 ⇒ 升版本号 ⇒ 新 proposal 带新 ruleVersion；
已落库事件的 ruleVersion 永不改写；重放按事件自身的 ruleVersion 折算。
向后重放策略：v1 不回填历史（M8-D05）；未来版本升级不重放已消费窗口。

---

## 5. 衰减冻结（affect-decay@1）

| 参数 | 冻结值 | 语义来源 |
|---|---|---|
| valenceHalfLifeHours | 4（向 0） | `src/state/decay.ts` 既有 `DEFAULT_DECAY` |
| arousalHalfLifeHours | 5（向 0） | 同上 |
| valenceNeutral / arousalNeutral | 0 / 0 | 同上 |
| 衰减方向 | 指数回归中性，**不可逆**（回来不自动回弹） | 同上 |

四条硬规则（计划 §3.6 全文有效）：

1. **读取时只算 effective state，不写"衰减事件"**——时间不是新的情绪证据，
   衰减永不伪造 source event。
2. **reducer 折算用事件时间**：真实事件到达时，先把旧锚点（`lastAffectEventAt`）
   以 `event.createdAt` 折算到有效值，再应用 delta，再写新锚点。重放不读运行时墙钟
   （clock policy：reducer 只见 `event.createdAt`；read-time 只见调用方传入的 `now`）。
3. **read-time 折算用调用方 now**：`effectiveAffect(state, now)` 纯函数，
   结果不回写投影。
4. **边界恒成立**：`-1 ≤ valence ≤ 1`、`0 ≤ arousal ≤ 1` 全程由 clamp 保证
   （clamp 是最后防线；validator 拒绝超限 delta 是第一防线）。

---

## 6. 时序与降级（M8-D04 / 计划 §6.3、§3.7）

### 6.1 同轮时序（flag ON 时的生产顺序）

~~~text
1  接收用户消息 → beginTurn 落 user_message 事件
2  同步运行 bounded 确定性评估（无 LLM/网络；消费 watermark 尾窗）
3  proposal → 唯一 validator（整项接受/拒绝）
4  提交 AFFECT_TOUCH（+ 至多一条 AFFECT_IMPACT）——单事务 applyAcceptedEvents
5  读投影 + effectiveAffect(now) → 渲染 affect section
6  compileTurn（relationship 55 / affect 52 各自独立）
7  调模型 → 回复
8  completeTurn 记 trace/reply-truth
9  尾部幂等 catch-up（消费 assistant 事件、重试失败窗口；启动时同样 catch-up）
~~~

### 6.2 失败降级（§3.7 全文有效）

评估/验证/落库/投影/读回任一环节失败：

- 回复**照常**走既有安全链路（情绪处理永不阻断回复）；
- 本轮 section 用**上一份有效状态**渲染，并在 section 内追加一行如实边界：
  「本轮情绪处理未完成——以上是上一份有效状态，不要声称你的情绪因对方刚才的话而改变」；
- trace 记录失败分类与阶段（§7 的六步）；watermark 不前进；
- 下一次启动/下一轮/尾部 catch-up 幂等重试；不自动删事件、不自动修投影、
  不自动切换真实库；
- 开发者面读回不得把 "proposal generated" 显示成 "affect applied"。

### 6.3 幂等与恢复（两层，M7 同构）

- **job 层**：窗口 range key（operation `affect-evaluation`）——同窗口不重复调度；
- **事件层**：`operation = affect-touch:<sourceEventId>` /
  `affect-impact:<ruleId>:<sourceEventId>`，range 分量**置零**
  （跨窗口重处理同一事件 ⇒ 同键命中 ⇒ 0 新建）。
- **cutover 恢复**：ORIGIN 已存在而 watermark 缺失（建档被中断）⇒ 用 ORIGIN payload
  的 `cutoverSequence` 补设水位；切换点之后的事件由正常 catch-up 消费。
- 重复运行 / 重复启动 / 重复请求 ⇒ 幂等命中，不重复影响（WP4 量具）。

---

## 7. 可观测性冻结

### 7.1 trace step kinds（六步，登记进 `TRACE_STEP_STAGE`，不新开第 13 个观测阶段）

~~~text
affect_eligibility  → 'turn'    （资格判定：合格/不合格 + 理由）
affect_proposal     → 'turn'    （提案：ruleId/ruleVersion/delta/来源事件）
affect_validation   → 'turn'    （验证：接受/拒绝 + 拒绝码）
affect_event        → 'turn'    （落库：domainEventId/created/dedup）
affect_projection   → 'turn'    （投影：revision/stateAfter）
affect_context      → 'context' （注入：section 在场/缺席 + 所用 revision/asOf）
~~~

### 7.2 reply-truth

本轮回复事实必须能回答「情绪是否真的应用了」：
`affectApplied = true（本轮事件已提交且 section 用新状态）/ false（失败，用旧状态）/
unknown（flag off 或干跑，无本轮应用）`——与实际 event/projection 证据绑定
（trace 步可回查），不是从回复语气推断。

### 7.3 开发者面读回（--inspect）

三段式：**canonical**（投影 revision/state/lastDomainEventId/cutover）→
**effective**（asOf/decayApplied/桶位）→ **legacy**（旧 src/state 数值，
显式标注「非当前 canonical affect」）。

---

## 8. 上下文与开关

### 8.1 Section（计划 §6.1/§6.2）

- 唯一 `affect` section（id `affect`，kind `affect`，priority **52**，droppable true）；
  未建档 ⇒ 0 个 section（与 M7 同一安静机制）。
- 渲染模板（确定性，不暴露数值）：

~~~text
[Affect Guidance]
当前内部状态：<valence 桶>，<arousal 桶>。
行为倾向：<由桶位确定性导出的行为行，0..n 行>
边界：这是内部程序状态，不是对对方真实情绪的判断；不要把它表述为外部事实，也不要提及任何数值。
[/Affect Guidance]
~~~

- 桶位沿用既有确定性映射（`src/state/provider.ts` 的 describeEmotion 阈值：
  ±0.5/±0.15；arousal 0.6/0.3），行为行沿用其情绪子集（明显冷淡/语气收着/话多/
  句碎急躁），措辞克制、不夸大。
- **critical-state 桥接**：flag ON 时 legacy 状态块**退役情绪轴**
  （`renderCriticalStateSection({ affectAxes: false })`，M7 `relationshipAxes`
  同构）；flag OFF 时逐字节与 M6.1 现状一致（M3.5 基线不受影响的机制）。
- trust/closeness 与 valence/arousal **不得互相混入**（M8-D10）。

### 8.2 开关与回滚（计划 §9）

- 单一生产开关 `CHARACTER_AFFECT_CONTEXT_ENABLED`，代码缺省 **false**；
  三个行为绑定同一开关：评估器消费新事件 / 投影作为 canonical 情绪源 /
  section 进 prompt。**禁止**半接线组合（section 开而投影没开）。
- 回滚分层照计划 §9.2：关 flag（非破坏，保留事件与投影）→ 停消费（非破坏）→
  投影恢复（谨慎，不自动）→ 数据恢复（incident hold 流程，逐轮授权）。
  **禁止**删 `character_domain_events`、删 postmaster.pid、直改投影、"自动切换库"式回滚。
- flag 必须被真的消费（静态回归锁，M7 同纪律）。

### 8.3 兼容（计划 §7）

- `src/state` 保留（M1/M2/M4.5 回归不破坏）；flag OFF ⇒ 旧行为逐字节不变；
  flag ON ⇒ 旧情绪字段不再参与情绪叙述（桥接退役），旧链路无情绪写入可停
  （M8-D12 已核实）。
- `--dump-prompt` 与真实 TurnGateway 用**同一** Affect 装配（不允许第二套渲染）。
- reset/maintenance 命令不得直 set valence/arousal；v1 明确禁用（要改走
  `MAINTENANCE_REPAIR` 另立授权）。

---

## 9. 拒绝码冻结（affect-rejection-codes@1）

域内码（登记表 + 谓词，新增先改表）：

~~~text
affect_owner_mismatch                 归属不是本 Character
affect_source_missing                 来源事件不存在
affect_source_foreign                 来源事件属于其他 Character
affect_source_unqualified             来源不合格（非 user_message / 非 ESTABLISHED /
                                      非 active user / 切换前事件）
affect_not_originated                 IMPACT 先于 ORIGIN
affect_origin_duplicate               ORIGIN 重复建档
affect_origin_injection_not_enabled   MAINTENANCE_REPAIR/HISTORICAL_IMPORT fail-closed
affect_delta_out_of_bounds            |Δ| > 0.25（拒绝，不夹取）
affect_value_not_finite               数值非有限
affect_rule_unknown                   ruleId 不在冻结表
affect_rule_version_mismatch          ruleVersion 不匹配
affect_payload_invalid                payload 结构非法
~~~

管线通用码（与 M7 同源复用）：`processor_version_presence` · `source_event_missing` ·
`source_event_foreign` · `payload_schema_invalid` · `payload_too_large` ·
`duplicate_operation` · `domain_event_type_not_allowed` · `scope_not_character_internal`。

---

## 10. 反向选择清单（明确不采用的方案）

| 不采用 | 理由 |
|---|---|
| `affect:<conversationId>` / `affect:<userId>` 分片 | 把每段对话当独立情绪实体 = 第二权威；M8 要表达的是"她此刻怎么样"（M8-D01） |
| LLM evaluator 进 v1 核心闭环 | 不可重现；规则边界/反事实测试/失败归因会混在一起；先证明机械闭环（M8-D03，计划 §5.3） |
| 重放全部历史对话塑造当前情绪 | 旧消息不是她亲历的情绪事件；激活起点必须可判（M8-D05） |
| 多规则叠加/加权混合 | 一次交互一个主导影响，可解释可回放（M8-D08） |
| 把衰减写成事件 / 定时器结算 | 时间不是新的情绪证据；伪造 source event 违反账本纪律（§5） |
| 隐式迁移旧 src/state 数值 | 旧数值无事件链可审计；迁移必须走维护事件（M8-D12） |
| 在 critical-state 里保留第二套情绪叙述 | 双权威竞争；M7 已示范唯一注入块模式（§8.1） |
| 每轮多 impact / 情绪数值直接进 prompt | 超限风险 + 内部数值泄漏；delta 上限 + 桶位渲染（§4.1/§8.1） |
| 新增迁移/新表 | WP0 P4 已证通用形状可承载；零迁移是首选判定（计划 §8.4） |
| 情绪状态自动进长期记忆/信念/目标 | 认知完整性边界（INV-CI）；affect 是内部投影，不是 belief truth（M9 交接条件） |
| 失败时阻断回复 / 失败时假装成功 | §3.7 两条都违反；降级路径是硬要求 |

---

## 11. 实现落点（指向具体 M8-Dxx；WP2–WP6 的验收锚）

~~~text
src/kernel/contracts/affect.ts                状态/事件 payload/规则表/拒绝码/纯函数（D01,D06,D07,D08,D09；§2,§4,§5,§9）
src/kernel/contracts/domain-event.ts          AFFECT_* 登记 + createAffectDomainEventRegistry（§2.3）
src/kernel/app/affect/patterns.ts             affect-rules@1 词形 + 守卫（§4.3）
src/kernel/app/affect/evaluator.ts            affect-evaluator@1（D03；§3 资格）
src/kernel/app/affect/job.ts                  runAffectEvaluation + 两层幂等（D04；§6.3）
src/kernel/policies/affect-validator.ts       唯一放行口，失败关闭（§3,§9）
src/kernel/projections/affect.ts              reduceAffect + affectReducerFor（§2.4,§5）
src/infrastructure/persistence/affect-store.ts  投影读/重建（零迁移，WP0 P4）
src/infrastructure/runtime/affect-scheduler.ts  尾窗消费 + cutover 恢复（§6）
src/infrastructure/runtime/adapters.ts        renderAffectSection / seedAffectOrigin / readback（§7.3,§8）
src/kernel/context/sections.ts                createAffectProvider（priority 52）（§8.1）
src/kernel/app/turn-gateway.ts                CompileTurnInput.affectSection（§6.1）
src/kernel/app/flags.ts                       CHARACTER_AFFECT_CONTEXT_ENABLED=false（D14）
src/main.ts                                   同轮评估 + section 注入 + 尾部 catch-up + --inspect（§6,§7.3）
~~~

依赖方向铁律不变：contracts 不 import 框架/SQL/node:*；infrastructure → domain
单向；validator 不 import app。

---

## 12. 验收锚（本 ADR 冻结后的判定依据）

- 计划 §11.1 的 A01–A20 场景集是 WP3/WP7 的量具基线；
- 三段式（正控/负控/恢复控）适用于每一个新量具（计划 §11.2）；
- Level 1 = 真实 TurnGateway 可观察（计划 §11.3）；Level 2 = 开发者面逐项读回
  （计划 §11.4）；长轨迹 1×500（计划 §11.5）；
- 判定分列口径照计划 §0.2（不合成"情绪准确率"）；
- **本 ADR 不主张**：人类级情绪理解、识别用户真实情绪、全覆盖自然语言、
  解决 M6.1 假记忆边界、"她不会再说错"、"她真正感受到了什么"。
