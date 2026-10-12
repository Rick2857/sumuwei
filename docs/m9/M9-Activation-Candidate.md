# M9 Activation Candidate —— WP11 生产激活候选

- 日期：2026-09-27（WP10 收口）
- 状态：**ACTIVATED**（2026-09-27 用户显式授权 M9-D26；执行记录 =
  [`docs/adr/ADR-071-m9-belief-production-activation.md`](../adr/ADR-071-m9-belief-production-activation.md)
  + Gate-Decision §6；读回 13/13，FIRST-USE NOT OBSERVED 待首聊）。
  本文件作为候选说明书原样保留（授权时它的状态是 CANDIDATE / NOT ACTIVATED，
  授权与执行见 ADR-071）。
- 形状参照：M8 ADR-067（只做状态修订 + `.env` 一行 + 首启观察 + 回滚）

## 1. 激活什么

```diff
# .env（生产基线；代码缺省保持 false 不变）
+ CHARACTER_BELIEF_ENABLED=true
```

一行开关。无新迁移（`Database Migration = NONE`——信念事件/投影复用 M5 的
domain-events 基座）；无 seed 变更；无新外部能力。

## 2. 激活前核对清单（WP11 顺序，计划 §13 WP11）

| # | 项 | 状态 |
|---|---|---|
| 1 | 获批配置核对：仅 `CHARACTER_BELIEF_ENABLED=true`，其余基线不动 | 待授权后执行 |
| 2 | 副本测试与盲审核对（`m9:gates` 全绿 + 人审材料已呈交/已裁定） | live:level1 受 F-1 阻塞（见 Gate-Decision）；人审 PENDING |
| 3 | 生成 activationId + 留存基线（真实库树摘要 + `.env` 前值） | 待授权后执行 |
| 4 | 开启开关（改 `.env`，唯一动作） | 待授权后执行 |
| 5 | 仅经合法启动路径建档（INC-01 链：租约 → 已验证快照 → pre-open token → 启动/干净关闭） | 待授权后执行 |
| 6 | 真实首用后读回：origin/cutover、资格、`belief_context` trace、两链水位 | **首用未发生 ⇒ 必须写 `FIRST-USE NOT OBSERVED`，不得凭配置宣布运行验证通过** |
| 7 | 回滚演练记录 | 回滚 = 删该行（消费与注入即停；已提交事件/投影/水位保留，审计不删） |

## 3. 激活后的预期行为（可观察面）

- 首次启动：流 2（memory-reconciler）回放全部 Memory 事件——真实历史现有
  1 条合格记忆（`education.institution = 示例工程科技大学`）⇒ 预期形成恰好
  1 条 reported 信念（槽位占用探针 `m9-live-probe` 实测：无其它槽位占用）；
- 流 1 origin cutover 落在首启序号：**旧对话历史零重判**（不回评，L-M9-06）；
- 此后：显式陈述（记住/更正/忘掉）→ 信念形成/修订/撤回；推断槽在跨 ≥2 会话
  凑满 3 根前**不形成**（单会话控制台结构上凑不齐——见 Known-Limitations）；
- ⚠️ **F-4 边界**（裁定前如实生效）：忘掉/更正后**逐字重述**同一内容不会
  重建（确定性 id 撞已存在记录，折叠 no-op——L-M9-19）；换措辞重述正常；
- 每轮 `belief_context` trace 可查实际入模。

## 4. 不因激活新增的主张

- 语义得体（措辞层无启发式守卫，DR-11 延续——L-M9-07）；
- 通用自然语言信念理解（白名单 + 词形覆盖，L-M9-01/02）；
- 客观真值（reported = 可追溯陈述，不是已验证事实，L-M9-03）；
- 物理擦除（append-only 审计保留与对话遗忘分离，L-M9-09）。

## 5. 风险与回滚

- **回滚**：删 `.env` 该行 ⇒ 注入与消费即停；已产生的 BELIEF_* 事件与投影**保留**
  （审计事实不删）；schema 无新增 ⇒ 无迁移回滚问题；
- **观察窗口**（建议）：首启后第一个真实对话轮读回 origin/cutover/水位/trace，
  与 §3 预期逐项对照；异常 ⇒ 回滚 + INCIDENT HOLD（INC-01 纪律）。
