# ADR-071：M9 Belief 生产激活（状态修订）

> 状态：**ACCEPTED / EXECUTED**（2026-09-27）
> 类型：状态修订（与 ADR-048 / ADR-052 / ADR-065 / ADR-067 / ADR-069 同形）——
> 本文**不改** [ADR-070](ADR-070-belief-perspective-and-revision.md) 的任何设计
> 裁定；`M9-D26`（激活 = 独立用户明确批准 + 独立记录）的执行记录。
> 判定背景：[`docs/m9/M9-Gate-Decision.md`](../m9/M9-Gate-Decision.md)
> （工程面全绿 · live 两发现已裁定 M9.1 修复 · 激活候选已审）
> 候选说明书：[`docs/m9/M9-Activation-Candidate.md`](../m9/M9-Activation-Candidate.md)

## 1. 授权（M9-D26）

用户于 2026-09-27 本轮显式授权，对象 = **「先进行WP11 生产激活合并 / 打标签」**。
同轮**分别裁定**：F-1 / F-4 两项 live 发现 → **M9.1 修复**（登记册 R-20/R-21，
读数不因裁定改写）——发现处置裁定与激活批准是两项独立决定，互不替代；
本授权对象 = 激活候选说明书全文（§1–§5 的后果、边界、回滚与观察面）。

## 2. 激活动作（一次授权的全部改动）

**一步**：`.env` 追加一行 `CHARACTER_BELIEF_ENABLED=true`。
**代码缺省仍 `false`**（`flags.ts`，M9 设计不变）——其它环境 / 测试 / 回滚
天然安全。无激活程序（与 M8.5 不同）：M9 的 origin 建档设计为**首次开库时
自播种**（`maybeRunBeliefEvaluation`，main.ts :1502——未建档 ⇒ 播种
BELIEF_ORIGIN，cutover = 当前对话账本最大序号），不需要受控预置脚本。

**合法启动建档**（计划 §13 WP11「仅通过合法启动路径建档」）：
`'/exit' | pnpm chat`——INC-01 状态机全程（租约 → pre-open verified
snapshot → token → 打开 → 干净关闭 → post-close 快照 → 释放租约，
`cleanClose=true`）。开库即执行信念双流追赶（零模型调用、零对话轮）：

| 流 | 启动读数（`artifacts/.m9-wp11-startup.log`） |
|---|---|
| 流 1 交互评估器 | 播种 `BELIEF_ORIGIN`（cutover=**133** = 对话账本尾）；**无尾窗**（水位 133 = 账本 133——切换前历史零重判，L-M9-06） |
| 流 2 Memory 回查 | 窗口 [1, **136**]（域事件序号空间）· Memory 事件 3 · **形成 1** · 失效 0 · 放行 1 拒 0 · **落库 1**（幂等命中 0） |

**写入面（全部，无其它）**：1 条 `BELIEF_ORIGIN` 域事件 + 1 条
`BELIEF_FORMED` 域事件 + `belief:origin` / `belief:<id>` 投影行 + 2 条
水位行（belief-interaction-evaluator=133 · belief-memory-reconciler=136）。
零迁移 · 零新表 · 零 seed 变更 · **零对话事件改动** · **零 Memory 域改动**
（背书记忆逐字未动，读回 §5 证实）。

## 3. 激活前记录（全部只读取证）

| 项 | 值 |
|---|---|
| 激活前树摘要 | `9990e0d2627263340b63592e69de6605643e1df8e663ba0163208c87f80fb479`（1211 文件——与 M9 全部 live 试验的只读基线**逐字相同**：激活前本里程碑从未打开写入） |
| `.env` 前值 | `CHARACTER_BELIEF_ENABLED` **缺省不存在**（追加前 Select-String 证实） |
| pre-open verified snapshot | `2026-09-27T17-12-50-325Z-9990e0d26272`（状态机自动拍摄，源摘要前缀与激活前基线一致） |
| 激活时账本尾 | 对话事件流 133 · 域事件流 136 |
| 激活时树 | HEAD `4813a61`（分支 `feature/m7-relationship`；读回脚本已提交先行） |
| 生产模型指纹 | `api.deepseek.com` / `deepseek-flash`；验收证据端点 = ark 测试端点 / `deepseek-v4.1-flash`——两者不同，如实登记（M5.5/M7/M8/M8.5 激活同款形态） |
| 门读数 | `m9:gates` 11/13 绿（live 两红 = F-1/F-4，已裁定 M9.1）· 离线 lane 12/12 · `m4.5:ci` EXIT 0 · `m4.5:ci:full` EXIT 0（Live Smoke 52/0） |

## 4. 激活后读回（SELECT-only 真库验收，13/13 通过，EXIT 0）

工具：`scripts/m9-activation-readback.ts`（提交 `4813a61` + 修正 `a68cdb4`/
`4532215`；`rows()` 拒绝非 SELECT——「只读」是构造性质；INC-01 状态机全程，
`cleanClose=true`）。读数（`artifacts/.m9-wp11-readback.log`）：

| 检查 | 读数 |
|---|---|
| origin 建档 | `belief:origin` 行在 · cutover=**133** · activationId=`open-catchup` · policy=`belief-evidence-policy@1` |
| 信念行 | **恰好 1 条 active**（候选 §3 预期命中）· kind=**reported** · `education.institution = "示例工程科技大学"` · scope=general · support=tentative · 依赖记忆 `mem:…:person_fact-8d64c71c49424b51`（active） |
| 域事件 | `BELIEF_ORIGIN`=1 · `BELIEF_FORMED`=1 · **`BELIEF_INFERRED`=0**（旧对话历史零重判——cutover 语义） |
| 水位 | belief-interaction-evaluator=**133**（=cutover，切换前无待消费窗口）· belief-memory-reconciler=**136**（≥ max MEMORY_*=31；水位空间 = 全域事件序号） |
| 背书记忆 | `person_fact-8d64c71c49424b51` active 逐字未动（同槽 retracted 旧值 `preference-d0696bd4b1e314c1` 亦未动） |

**激活后树摘要**：`4fc40f6b4b2fa18b144ffdf1be056eec574a3a1b7b0f72e9ac7d13e5f9257e83`
（1211 文件——文件数不变；内容差 = §2 写入面 + 两次合法打开的 WAL/快照副产物）。

## 5. FIRST-USE NOT OBSERVED（计划 §13 WP11 原文要求如实记录）

**CONFIG ENABLED / STARTUP CATCHUP OBSERVED / FIRST-USE NOT OBSERVED**：
激活开关已开、开库追赶已观察（§2/§4），但**真实对话轮尚未发生**——
轮级 `belief_context` trace（信念入模的实际观察）待用户下一次真实聊天。
不凭配置宣布运行验证通过；首个真实轮的观察面 = origin/cutover/资格/
`belief_context` trace/两链水位（候选 §3），异常 ⇒ 回滚 + INCIDENT HOLD。

## 6. 回滚（已演练路径，未执行）

删 `.env` 该行 ⇒ 注入与消费即停；已产生的 `BELIEF_*` 事件与投影**保留**
（审计事实不删）；schema 无新增 ⇒ 无迁移回滚问题。重开开关 = 下次开库
追赶从水位续跑（幂等，`open-catchup` 已证明）。

## 7. 不因激活新增的主张

`L-M9-01…19` 全部照旧（含 F-4 边界 L-M9-19：忘掉/更正后**逐字重述**同一
内容不会重建——换措辞重述正常；F-1 边界 L-M9-13：遗忘后追问可能从可见
对话行复述——两项均已裁定 M9.1 修复，裁定前边界如实生效）。语义得体 /
通用信念理解 / 客观真值 / 物理擦除四项不主张（候选 §4）。
