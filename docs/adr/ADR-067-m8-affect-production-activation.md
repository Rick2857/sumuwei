# ADR-067：M8 Affect 生产激活（状态修订）

> 状态：**ACCEPTED / EXECUTED**（2026-09-26）
> 类型：状态修订（与 ADR-048 / ADR-052 / ADR-065 同形）——本文**不改**
> [ADR-066](ADR-066-affect-state-evolution.md) 的任何设计裁定；
> `M8-D14`（flag 缺省 false；激活 = 独立裁定）的执行记录。
> 判定背景：[`docs/m8/M8-Gate-Decision.md`](../m8/M8-Gate-Decision.md)
> （工程面 PASS · Human Review 材料已交付 · 激活候选已审）
> 候选说明书：[`docs/m8/M8-Activation-Candidate.md`](../m8/M8-Activation-Candidate.md)

## 1. 授权（WP9 的开门钥匙）

用户于 2026-09-26 本轮显式授权，原话：**「批准激活」**。
授权对象 = 激活候选说明书全文（`M8-Activation-Candidate.md` §1–§5 的
后果、边界、回滚与观察面）。盲审材料（六轮真模型回复 + 程序事实）
已在该轮之前呈交用户过目。

## 2. 激活动作（一次授权的全部改动）

```text
.env 追加一行：CHARACTER_AFFECT_CONTEXT_ENABLED=true
```

**代码缺省仍为 false**（`src/kernel/app/flags.ts`，M8-D14 不变）——
任何其它环境 / 测试 / 回滚天然安全。无迁移（M8 database migration =
NONE）；无新表；无 seed 变更；无其它配置改动。

## 3. 激活前记录（WP9 任务 3，全部只读取证）

| 项 | 值 |
|---|---|
| 真实库树摘要 | `f65531b1322f340c387886c4`（1208 文件 · 32,436,767 字节；`pnpm db:snapshot --dry-run` 实测，与 M8 全程各次摘要**逐字相同**——本里程碑从未打开写入） |
| 最新 verified snapshot | `pglite-2026-09-26T07-52-44-745Z-f65531b1322f`（`data/snapshots/`，源摘要与上同） |
| 生产配置 | `USER_NAME=Alex` · `CHARACTER_RELATIONSHIP_CONTEXT_ENABLED=true`（ADR-065，M7 在产）· `CHARACTER_ROLLUP_TOKENS=400` · `CHARACTER_WEB_SEARCH_MODE=auto_public` · **无任何 `CHARACTER_AFFECT_*` 键**（激活前） |
| 激活时树 | HEAD `b4b0fc529ad94a1022820d3eeb8a5bd1e9c797e5`（分支 `feature/m7-relationship`；M8 实现文件当时未提交，属 M8 会话领土，见 §6） |
| M7 状态 | 关系投影在产（ADR-065）；M7 潜伏双缺陷未修（`L-M8-13`，激活动作不触碰） |
| M8 门读数 | `m8:gates` = Hard Gates **PASS 10/10**（29 run 在案）· `m4.5:ci` EXIT 0 · `with-test-model m4.5:ci:full` EXIT 0（Production-copy Live Smoke 52/0）· `m8:live:level1` PASS 7/7（生产副本，真实库摘要前后一致） |

## 4. 激活效果与不改变的主张

**效果**（候选说明书 §1 的既定后果）：下一次真实对话轮起，affect 评估器
以 `activeUserId` 资格闸消费账本尾窗；首次评估建档
（`AFFECT_ORIGIN`，cutover = 当时账本最大序号——**激活前的全部历史
永不回评**，M8-D05；该形状已在生产副本上由 Live Smoke 验证：cutover=117，
旧历史零重判）。此后命中冻结词形（`affect-rules@1`）时产生
TOUCH/IMPACT 域事件，投影演化（v∈[−1,1] · a∈[0,1]），prompt 注入块
（section 52，定性 guidance，无数值泄漏），trace 六步落树（reply-truth）。

**激活不新增任何主张**：`L-M8-01…16` 全部照旧——不主张自然语言情绪理解、
不主张识别用户情绪、不主张多用户就绪、不主张"她有了感受"、不主张措辞层
零偏差；能力影响矩阵 = **NONE**（无新外部能力）；affect 事件永不自动进
长期记忆；M7 语义零耦合。

**失败形状**（既定，WP6 已验证）：评估失败 ⇒ 注入块带如实边界行
（"本轮未完成情绪更新"）⇒ 聊天不阻断、水位不动、投影保持旧值、
job 行如实落 `failed`。

## 5. 回滚

回滚 = 从 `.env` 删掉该行（或改 false）。已产生的 `AFFECT_*` 域事件与
投影行**保留**（审计事实，不删不改）；再激活时 cutover 重取账本尾
（停用期间的消息不回评）。回滚 dry-run 的既有证明见候选说明书 §3。

## 6. 执行与提交纪律

- 激活后按用户同轮指示执行**最高并发**收口测试（`fast:offline` 6 路并发
  离线链 + summaries 汇总道 + M8 各门并发复跑 + `m8:gates` 只读汇总）；
  读数登记进 [`M8-Gate-Decision.md`](../m8/M8-Gate-Decision.md) §5。
- M8 会话领土（`src/kernel/app/affect/**`、`scripts/m8-*`、`docs/m8/**`、
  `artifacts/m8/**`、共享文件的 M8 点追加）按 AGENTS §8 在收尾时
  **按路径分批提交**（一件事一提交）；绝不 `git add -A`。
- 打标签 / 合并 `feature/m7-relationship` = 用户另行裁定，本文不涉及。
