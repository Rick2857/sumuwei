# M8 WP2 交接单 —— Contracts、Domain Event 与纯函数

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP2
> 证据：`pnpm m8:wp2:contracts` = **PASS 55/55**
> （`artifacts/m8/m8-wp2-contracts-20260926-a82080865706-<final>/`，取代链见 §4）
> 下一站：WP3（Evaluator、Proposal、Validator）

## 1. 交付物

| 交付物 | 位置 | 内容 |
|---|---|---|
| Affect 契约 | `src/kernel/contracts/affect.ts` | AffectState / 五值 originKind / AFFECT_DECAY（半衰期 4h/5h）/ effectiveAffect / renderAffectGuidance / 证据资格（active user + cutover）/ 三类 payload 结构校验 / 冻结规则标识（7 族 + affect-rules@1）/ 幂等单元纯函数 / 12 拒绝码登记表 |
| 事件登记 | `src/kernel/contracts/domain-event.ts` | `AFFECT_ORIGIN` / `AFFECT_TOUCH` / `AFFECT_IMPACT` + `createAffectDomainEventRegistry()`（独立工厂；**WP2 只登记不接线**——`createFullDomainEventRegistry()` 尚不含，判据在 WP4 翻转，与 M7 同构） |
| 纯 Reducer | `src/kernel/projections/affect.ts` | `reduceAffectState`（ORIGIN 建档 / TOUCH 只推交互锚 / IMPACT 先衰减再 delta 再双锚）+ `affectReducerFor(characterId)`（own 判定 + defaultIsStale）+ `affectEventTargets`（重放过滤用） |
| 规则匹配器 | `src/kernel/app/affect/patterns.ts` | affect-rules@1 词形判据：7 族 34 模式 + 句级守卫（转述/条件/引号/否认前缀/反讽）+ 问句抑制 + 敌意毒化 + `AFFECT_RULE_DELTAS`（ADR-066 §4.1 冻结值）+ `AFFECT_RULE_PRIORITY`（M8-D09 全序）+ `dominantAffectRuleFamily` |
| 合同门 | `scripts/m8-wp2-contracts.ts` | 静态 4 项 + 三段式 51 项（正控 19 / 负控 26 / 恢复 6） |
| package.json | `m8:wp2:contracts` | 点状追加 |

## 2. 关键语义（实现锚点，全部指向 ADR-066）

- **M8-D01**：`AFFECT_PROJECTION_TYPE = 'affect:character'`；S2 静态锁证明 src/** 无
  `affect:conversation/user/message` 第二权威形状。
- **M8-D05**：`cutoverSequence` 进 ORIGIN payload **和** AffectState；
  `affectEvidenceVerdictOf` 拒绝 `sequence ≤ cutover` 的事件（N13 负控）。
- **M8-D07**：TOUCH 折叠只推 `lastInteractionAt`，valence/arousal 与情绪轴锚不动（P12）。
- **§5 规则 2**：IMPACT 折叠 = `decayAffectBetween(锚→事件时间)` → `+delta`（clamp）→ 双锚推进（P13）。
- **M8-D08/D09**：一次消息至多一个主导 IMPACT；全序
  `A-HOSTILE > A-REJECTION > A-URGENT > A-REPAIR > A-COMFORT > A-GRATITUDE > A-WARM-CONTACT`（P18）。
- **两层幂等的事件层**：`affect-touch:<sourceEventId>` /
  `affect-impact:<ruleId>:<sourceEventId>`（range 置零由 Validator 做——WP3）。
- **渲染纪律**：桶位 + 行为行逐字移植 M2 的情绪子集；不泄漏 valence/arousal 原始数值；
  失败时追加如实边界行（P10）。

## 3. 量具读数

- 静态：S1 依赖方向 / S2 无第二权威 / S3 未接线（WP4 翻转）/ S4 reducer 纯度——4/4。
- 正控 19：payload 三类 / 登记表 / 证据 / 界 / 衰减半衰期 / 读时视图 / 渲染 /
  reducer 三类折叠 + 重放确定 / originKind / 拒绝码 / 匹配器 7 族 / 主导裁定 / 幂等单元。
- 负控 26：payload 结构 9 / 证据 6 / 界与夹取 2 / 登记表 1 / 匹配器 5 / reducer 3。
- 恢复 6：合法输入重新安静 + 中性消息安静 + 折叠复原。
- `pnpm typecheck` EXIT 0 · `pnpm kernel:test` 26/0 · `pnpm kernel:verify` 25/0。

## 4. 失败档记录（如实登记）

| runId | 判定 | 原因 | 处置 |
|---|---|---|---|
| `m8-wp2-contracts-…-37b4` | FAIL 54/55 | **P10 抓到真实缺陷**：渲染器把 `（情绪投影 r3 · 更新于 <ISO>）` 写进 prompt——审计信息属 Level 2 读回，不属模型面（ADR-066 §8.1）；同时判据用 `\d\.\d` 过宽（小时数与 ISO 都会命中） | 修渲染器（删 revision/ISO 行）+ 修判据（改为「valence/arousal 原始数值不得出现」）；重跑 PASS |
| `m8-wp2-contracts-…-addb` | PASS 55/55 | 修复后的第一次全绿（supersedes 字段为 null——当时还没接 CLI 参数） | 留档为中间档 |
| 最终档（`--supersedes …-37b4`） | **PASS 55/55** | 同 addb 读数，manifest 记录取代链 | **WP2 判定证据** |

## 5. 给 WP3 的输入

1. 合同层全部就绪：评估器产 proposal 只需组合
   `affectEvidenceVerdictOf`（资格）+ `matchAffectPatterns`/`dominantAffectRuleFamily`（规则）
   + `AFFECT_RULE_DELTAS`（数值）+ `affectTouchIdempotencyOperation`（幂等单元）。
2. Validator（`src/kernel/policies/affect-validator.ts`）需要覆盖的域内码已在
   `AFFECT_REJECTION_CODES` 全部登记（12 码）；管线通用码复用 M7 的同源实现。
3. **未接线提醒**：`createFullDomainEventRegistry()` 还不含 AFFECT 类型（S3）——
   WP4 接线时必须翻转该判据并出证据（M7 WP4 同构）。
4. 评估器版本常量：`affect-evaluator@1`（payload 校验已按此形状测试）。
5. WP3 的正控语料直接复用 P17 的 7 族样例；负控复用 N19–N22 的守卫样例，
   并按计划 §11.1 扩充 assistant echo / tool output / 重复 event。
