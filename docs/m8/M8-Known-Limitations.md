# M8 Known Limitations（Affect 情绪状态演化）

> 状态：**ACTIVE**（2026-09-26，随 M8 WP8 收口发布）
> 配套：[ADR-066](../adr/ADR-066-affect-state-evolution.md)（`ACCEPTED / DESIGN FROZEN`）·
> [M8-Gate-Decision.md](M8-Gate-Decision.md) · [M8-Acceptance-Report.md](M8-Acceptance-Report.md)
> 机器读数：`pnpm m8:gates`（只读已落盘证据）
>
> 本文件是 M8 的**边界清单**：每一条都是"系统如实做不到/不主张的事"，
> 不是待办事项。修复任何一条都需要新的证据链，不允许静默扩权。

## 限制清单

### L-M8-01：规则覆盖不是自然语言情绪理解

Affect v1 的评估器是**冻结词形判据**（`affect-rules@1`：七族规则 + 问句抑制 +
敌意语境毒化 + 消息级主导裁定）。"谢谢你"是 A-GRATITUDE，但同义的不同表述
（"多亏有你"在词表内，"你帮了大忙"不在）不触发。覆盖面外的表述 = 只 touch
不 impact——**漏检是设计行为，不是缺陷**。扩展走 ADR-066 预留的语义评估器位
（A-UNCERTAIN 具名回退，v1 恒不产 impact），不加启发式。

### L-M8-02：用户情绪识别不在范围内

M8 演化的是 **Character 的内部状态**，不是对用户情绪的识别。注入块逐字写明
"这是内部程序状态，不是对对方真实情绪的判断"。用户说"我很难过"不改变她的
valence（除非命中安慰/修复等**她被对待**的词形）。

### L-M8-03：单 Character / 单 active user 边界

Affect 投影是 **per-Character**（`affect:character`，M8-D03 单投影不分片），
评估以 `activeUserId` 为闸（M8-D11：contentOriginator ≠ activeUserId ⇒ 零提案，
fail-closed）。多用户生产入口不存在（生产入口仍是单用户控制台）；
多渠道多用户 = M7 TD-20 的既有准入边界，M8 不改变它。

### L-M8-04：默认不历史重放

激活（ORIGIN 建档）时 cutover = 账本当前最大序号（M8-D05）：切换前的历史
消息**永不回评**。Live Smoke 在生产副本上验证了这一点（cutover=117，
全部 IMPACT 的 sourceEventId 都指向激活后的冻结文本）。这保证"激活不会
让情绪来自旧消息"，代价是激活前的互动对情绪无贡献——按设计接受。

### L-M8-05：确定性 v1 可能漏检和误触发

词形判据的两面：近邻负控（普通不同意 ≠ 拒绝、问句抑制、敌意毒化）压误触发，
但无法归零（L-M55-15 的同款边界）；漏检见 L-M8-01。误触发的正确处理 =
回滚规则版本（`affect-rules@1` 是版本化判据），**不把误触发写成用户事实**。

### L-M8-06：M6.1 假记忆边界未关闭

`M6-FMB-01` 已在 M6.1 按原立案条件 CLOSED（主张 = 可查/可审计/可测），
但"她不再编造具体细节"**不是**任何里程碑的主张。M8 的 affect 注入块
给 prompt 增加了新素材（内部状态行 + 行为倾向行），理论上多了一个
"被复述"的素材面——机器面已查词形级泄漏（Live LV-REPLY 零命中），
**语义级**复述由盲审把关（审题 2），且 DR-11 立场不变：措辞层没有启发式守卫。

### L-M8-07：Affect 不等于人类主观体验

valence/arousal 是**程序状态轴**（[-1,1] × [0,1]，确定性 delta + 读时衰减），
不是情绪体验的模型。所有读数（e2e/长轨迹/Live）证明的是**机制性质**
（可查/可重放/可降级/边界稳定），不是"她有了感受"。

### L-M8-08：M7 的 lexical relationship 限制仍存在

M7 关系规则的词形边界（L-M7 系列）原样保留；M8 不改关系语义。
双 section 并存（e2e A17）只证明**互不污染**，不扩展任何一方的覆盖面。

### L-M8-09：旧 src/state 在兼容窗口内存在，但不是 M8 canonical authority

`src/state/provider.ts` 的旧情绪字段在 flag 关闭时照旧渲染（M3.5 基线不动）；
flag 开启后 `affect:character` 投影是**唯一权威**（M8-D02），旧字段不写不读。
两套数值不会双写（WP5 负控验证）；兼容窗口的退役走 ADR-066 §9 的后续裁定。

### L-M8-10：生产激活和 M8 PASS 分列

`CHARACTER_AFFECT_CONTEXT_ENABLED` 代码缺省 **false**；`.env` 无该键。
M8 工程判定 = PASS **不蕴含**激活（WP9 独立裁定 + ADR-067 + 用户逐字授权）。
激活后回滚 = 关 flag（不删事件、不改历史——事件账本保留全部审计事实）。

### L-M8-11：没有任何新增外部能力

能力影响矩阵 = **NONE**（计划 §14）：无新网络/桌面/后台/多模态/MCP 能力。
M8 的唯一"新增"是 Character 内部状态演化——不得被解释为 Level 2 action package。

### L-M8-12：模型回复可能不严格遵守行为指导

M8 保证的是**上下文/程序事实链**（注入块在场 → trace 绑定 → reply-truth），
不保证措辞层零偏差（DR-11 同款边界）。注入块明示"不要向对方复述这些状态"，
机器面查词形泄漏，语义级遵从由盲审与后续观察把关。

---

## 工程边界（WP7 发现，随发布登记）

### L-M8-13：M7 潜伏同款缺陷——tool 事件楔死与 catch 不 finishJob

M8 修复了自己的两个缺陷（见 Acceptance-Report §3），M7 的关系评估器存在
**同款**：(a) `relationship/job.ts` 无 tool 事件过滤（窗口含 tool 事件即抛
`tool_event_not_extractable_in_m4`）；(b) 关系调度器 catch 不落 `failed`。
今天**潜伏**（`recordToolOutput` 无生产调用方；关系失败同窗重试同样靠尾窗
增长自愈）。属 M7 已交付领土，M8 未动；建议 M7 维护线或 M9 处理。

### L-M8-14：stale-completed 任务行的同窗恢复是两步自愈

"finishJob(completed) 与 advanceWatermark 之间崩溃"的形状：同窗重试先撞
`job_not_pending`（任务行如实转 failed），第二次重建才补推进（域键幂等保证
零重复）。生产里尾窗一长即单步自愈，两步路径是兜底。e2e A12 已冻结该行为。

### L-M8-15：live:long（真模型 1×500）未跑

长轨迹稳定性由离线 1×500 覆盖（情绪机制与模型无关——确定性规则）；
真模型面由 6 轮 Live Smoke + WP8 回归的 `m4.5:ci:full`（52 轮生产副本
smoke）覆盖。若要求真模型长轨迹，可复用 `m8-long-trajectory.ts` +
`m7-live-long.ts` 骨架（约 500 次模型调用）。

### L-M8-16：人审（2026-09-27 修订为 PASS；原读数保留）

> **原读数（2026-09-26 收口当时）**：人审盲审**未完成**（材料已交付）——
> 盲审材料在 `artifacts/m8/local/m8-live-level1-…-a543/transcript.json`
> （gitignore 机器闸，正文不进仓库）。四条审题见 WP7 交接单 §5。
> **未审不填**：Human Review = PENDING 是 Gate-Decision 的如实分列。

✅ **2026-09-27 修订**：用户就同一份材料声明已审、无异议
（原话「我之前已经审过了没有问题，只是没有写而已」）⇒ `Human Review = PASS`
（声明式裁定，判定权在人；记录载体 `artifacts/m8/local/blind-review-record.md`，
裁决归档 Gate-Decision §4）。
**附注（不改判定）**：材料每轮 `reply` 尾部带一行日志残迹——WP7 §4 已登记的
量具外观缺陷，人审已见、不影响四条结论。
