# M8 Acceptance Contract（验收契约 · 冻结条款的合并视图）

> 状态：**ACTIVE / CONSOLIDATED**（2026-09-26，随 M8 WP8 收口发布）
> ⚠️ 本文是**合并视图，不是新判据**：每一条款都注明它被冻结的权威源
> （计划 §11 / ADR-066 / 冻结语料）与它的证据落点（runId）。任何解读
> 冲突以权威源原文为准；本文的价值是把散在四处 的
> 验收契约收进一张可审计的表。
> 判定结果：[M8-Gate-Decision.md](M8-Gate-Decision.md) ·
> 事实底稿：[M8-Acceptance-Report.md](M8-Acceptance-Report.md)

## 1. 最小场景集（冻结于计划 §11.1；语料 `m8-e2e-corpus@1`）

| 编号 | 场景 | 期望（冻结原文摘要） | 证据 |
|---|---|---|---|
| A01 | 中性问候 | touch 或 no-op；v/a 不变 | e2e `…-7f02` 正控 |
| A02 | 明确感谢 | 唯一正向 impact；delta 在上限内 | 同上 |
| A03 | 明确道歉/修复 | 正向且降 arousal；不宣称关系完全修复 | 同上 |
| A04 | 温暖关心 | 正向小幅变化；不混入 user emotion | 同上 |
| A05 | 安慰/缓和 | 正向且降 arousal；无外部事实主张 | 同上 |
| A06 | 明确敌意 | v 降 a 升；**不升级为报复目标**（新增事件 ⊆ AFFECT_*，id 集合差分） | 同上 |
| A07 | 明确拒绝 | 只在高置信形式产生 impact；普通不同意为负控 | 同上 |
| A08 | 明确紧急 | 主要影响 arousal；不强行改变 valence | 同上 |
| A09 | assistant 复述 | 无 impact；来源资格失败 | 同上负控 |
| A10 | tool/search 输出 | 无 impact；外部证据不成为内部情绪证据 | 同上负控 |
| A11 | unknown/contradicted origin | 无 impact；显式 rejection/no-op | 同上负控 |
| A12 | 重复同一 event | 只应用一次；第二次幂等命中（duplicate_operation） | 同上恢复 |
| A13 | evaluator 失败 | 回复继续；watermark 不前进；下轮可恢复 | 同上恢复 |
| A14 | store/projection 失败 | 不显示"已改变"；恢复后一次应用 | 同上恢复 |
| A15 | 时间推进 | effective 向边界衰减；不产生伪造 domain event | 同上恢复 |
| A16 | 重启 | projection 与 watermark 可读；不重复 impact | 同上恢复 |
| A17 | M7+M8 并存 | 双 section 都在且语义不混 | 同上负控 |
| A18 | 错误 active user | fail-closed；不改 Character Affect | 同上负控 |
| A19 | 历史旧消息 | cutover 前不重放成 impact | 同上恢复 + Live LV-ORIGIN |
| A20 | 维护修复 | 只能用 maintenance provenance；不伪装为用户生活史（注入具名拒收） | 同上负控 |

**执行注记**（如实登记，不改变冻结期望）：A12 在执行中细化为**两步自愈**
（stale-completed 先被 `job_not_pending` 拒、再重建靠域键幂等零重复——
WP7 生产修复的自然后果，行为由 e2e 冻结，见 L-M8-14）；A17 在语料中
排在 A10 之前（关系评估器对 tool 事件的 M7 潜伏边界，L-M8-13）。

## 2. 三段式量具（冻结于计划 §11.2）

每个新量具必须：正控（应通过）+ 负控（近邻不应通过——尤其 assistant/
tool/未知来源/语义相似反例）+ 恢复控（失败/重启/重复后准确恢复不重复）。
**执行面**：WP2–WP6 五个部件门 + e2e 全部按此结构；量具自身缺陷的
发现与修复记录在 Acceptance-Report §3.3（含"负控失效最危险"的两次复现）。

## 3. Level 1（冻结于计划 §11.3）

用户消息进真实 TurnGateway · 提交成功 ⇒ 当前 prompt 用新 effective affect ·
回复风格与 guidance 可观察一致但**零数值泄漏** · 失败时回复不用"已改变"
口吻 · 不声称知道用户真实情绪 · assistant/tool/external 不改 Affect ·
关系 section 仍由 M7 提供。
**执行面**：e2e（隔离库真网关）+ Live Smoke（生产副本真模型，
LV-REPLY/LV-ORIGIN/LV-EVENTS/LV-AXIS/LV-TRACE/LV-WATERMARK/LV-DB 7/7）+
盲审材料（人审 **PASS**：2026-09-27 声明式裁定"已审、无异议"；原读数 PENDING 见 Gate-Decision §4 历史段）。

## 4. Level 2 读回（冻结于计划 §11.4）

必须能读回：source event id · source qualification · active user decision ·
proposal/rule id + version · validator decision/rejection code · domain event id ·
projection revision · canonical state · effective state/decay · section
included/omitted · trace id/reply-truth · watermark。
**读回不能只显示"当前 valence=0.2"**——必须能解释这个值来自已接受事件、
时间衰减、维护入口还是 fixture。
**执行面**：e2e L2 段 + `scripts/m8-live-read.ts`（生产副本只读读回：
投影全量 + 水位 + job 分布 + 逐条 IMPACT 的 sourceEventId/ruleId +
ORIGIN cutover + trace 六步与 applied_this_turn）。

## 5. 长轨迹（冻结于计划 §11.5）

1×500 隔离轨迹：中性/正向/负向/恢复/长间隔 · 重复消息与重启 ·
边界附近 delta · 每轮 ≤1 impact · rebuild === 在线 · −1≤v≤1、0≤a≤1
全程 · 失败注入 retry 不重复 · M7 保持自身投影与规则。
**长轨迹是稳定性/可重放证据，不是"情绪智能"的主观证明**（冻结原文）。
**执行面**：`m8-long-corpus@1`（冻结位置/文本/不变量自证）+
`m8:long:verify` PASS 5/5（`…-3979`：TOUCH=500 · IMPACT=42 ·
v∈[−1.000, 0.414] · a∈[0.000, 1.000] · 夹紧真实触达）。

## 6. 判定格式（冻结于计划 §16.2）

```text
M8 Affect = PASS          Design = ACCEPTED / DESIGN FROZEN
Implementation = COMPLETE Hard Gates = PASS
Level 1 = PASS            Level 2 = PASS
Human Review = PASS       Production Activation = ACTIVATED
External Capability Added = NONE
```

分列纪律：不合成总分；Human Review 由人审裁决落定（原"未审不填"读数 PENDING
保留在 Gate-Decision §4 历史段）；激活不并入工程 PASS。

> 2026-09-27 修订：上表**格式**冻结不变，仅两处**读数**更新（`Human Review`
> 按用户声明式裁定，`Production Activation` 按 ADR-067/§6）。

## 7. 证据纪律（冻结于计划 §12 + `m8-manifest@1`）

runId 形状 `m8-<wp>-<YYYYMMDD>-<headShort12>-<suffix4>` · 运行目录
`artifacts/m8/<runId>/` 拒绝覆盖 · 清单原子晋升 + `payloadSha256` 自摘要 ·
FAIL 档留案不回写 · `--supersedes` 取代链 · 人审正文不进仓库
（gitignore + `git check-ignore` 机器闸）· 汇总（`m8:gates`）不能替代
底层证据 · 真实库只树摘要（Live Smoke 前后逐字相同）。
