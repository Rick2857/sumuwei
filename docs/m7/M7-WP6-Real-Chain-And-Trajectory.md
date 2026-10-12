# M7-WP6 · 真实链路与长轨迹（调度 + 离线全链门 + TD-07 销账 + TD-06 定义冻结）

> 日期：2026-09-26。状态：**离线面收口 · 真模型面待授权（WP6-B）**。
> 依据链：[`M7-Execution-Plan.md`](M7-Execution-Plan.md) §5 WP6 行 ·
> ADR-064（`ACCEPTED / DESIGN FROZEN`，附录 A 规则集冻结）·
> WP5 交接 [`M7-WP5-Context-Wiring.md`](M7-WP5-Context-Wiring.md) §7。

## 0. 判定（分列，不合成）

```text
生产调度接线（攒尾窗策略）        = 已实现 · 已提交 · 离线门覆盖
离线全链门 m7:wp6:verify          = PASS 21/21（正控12 · 负控4 · 恢复3 · 网关2 · 域事件41）
  └ 含真 TurnGateway 全链（计划 §7.2 Level 2 的"真网关"形状）
TD-07（--history 权威源替换）      = CLOSED（preflight 门 PASS 11/11 · 用户文档已同步）
TD-06 定义冻结（判定契约式四界）   = FROZEN（缝缺口补齐；量具材料自检门 PASS 13/13，
                                    含 §6.7 三段式的量具自证段）
长轨迹参数冻结单                  = FROZEN（缝缺口补齐；1×500 · ON 单臂 · 时间基边界如实登记）
Level 1（真模型回复读数）          = NOT RUN（待用户授权；见 §5）
长轨迹正式运行                    = NOT RUN（待用户授权；冻结单 §7）
TD-06 判定轮与基线读数             = NOT RUN（待用户授权；与 M6.1 基线分列）
人工盲审包                        = NOT RUN（材料面 = 上述真模型运行；生成器随运行器交付）
```

## 1. 交付物（本 WP 提交链）

| 提交 | 内容 |
|---|---|
| `4400ec9` | 调度基座：`RelationshipEvaluationRunInput.dryRun`（零副作用评估）+ `latestCharacterEventSequence`（水位基准 = 账本最大序号，非计数器——M6.1 §11 的洞） |
| `df73e7b` | `relationship-scheduler.ts`（攒尾窗策略 + 真实 job ports）+ `main.ts` 接线（open() 追赶 + 轮后触发，`describeScheduling` 只记计数不记正文） |
| `55262f6` | 离线全链门 `m7:wp6:verify`（首版 17 检查，FAIL 中间档留档） |
| `a0270ce` | 门算式修正后 PASS 19/19 + TD-07 销账（`history-view.ts` 权威源替换 + preflight 门 PASS 11/11 + 用户文档 `doc:sync`） |
| `3e2c639` | 门补真 TurnGateway 段 ⇒ PASS 21/21（G1/G2：网关事件 → 调度 → Level 2 关联复验） |
| `9f9e234` | TD-06 定义冻结 + 量具材料（场景语料 12 + 有效性集 14 + 自检门） |
| `985a32b` | 长轨迹参数冻结单 |
| （本提交） | 交接单 + TD-06 门补量具自证段（D1–D4：注入坏语料必须响、放回重新安静）⇒ PASS 13/13 |

## 2. 缝缺口登记（如实：派给 WP1 但从未交付，WP6 补齐）

| # | 缺口 | 原归属 | 补齐载体 |
|---|---|---|---|
| S-1 | TD-06 四界定义（回应当前输入/复读/挟持/正常连续性） | WP1（WP0 接待单 §1 表） | [`M7-WP6-TD06-Definition.md`](M7-WP6-TD06-Definition.md)（判定契约式；两公共轴：uptake / add-vs-displace；**不以关键词去重**落成机器可检性质） |
| S-2 | 长轨迹轮数/预算/模型冻结 | WP1（计划 §6.12） | [`M7-WP6-Long-Trajectory-Freeze-Sheet.md`](M7-WP6-Long-Trajectory-Freeze-Sheet.md)（1×500 下限 · ON 单臂 · 检查点 1/50/100/200/300/400/500） |

硬顺序遵守记录：两份冻结都**先于**对应量具/运行器落定（判定契约 → 量具 → 读数；
M6-FMB-01 的顺序约束没有跳步）。

## 3. 调度设计（as-built 摘要；细节在代码注释）

```text
窗口语义     只开 [watermark+1 .. latest]（不相交窗口；重叠 = 双算，被禁止）
攒尾窗       dry-run 评估器跑一遍尾窗：提案>0 或 尾窗≥2000 ⇒ flush；否则 held
             （零提案尾窗自限：R-5 每 100 条合格消息才再fire）
幂等键       r2–r5 带窗口区间（同窗重跑 ⇒ Validator duplicate_operation）；
             r1/origin 中和区间（日单元跨窗幂等）
job 纪律     enqueueJob → markJobRunning → run → finishJob('completed') → 才推水位；
             失败吞进 kind:'failed'（不抛——"链的另一端可能是用户刚说完话"），
             同键重建由 job-store 的部分唯一索引承载（failed 允许重建）
失败恢复     崩溃残留（已落账未评估）由下一窗口覆盖（R1 验证）；
             job 失败由下一次触发同键重建（R2 验证）；水位持久（R3 验证）
计数端口     R-5 计数从账本派生（分页读 + processorEventViewOf + 来源资格 +
             KNOWN originator id 匹配）——不在 SQL 里复制资格语义
```

## 4. 门读数与边界门

```text
m7:wp6:verify   PASS 21/21   runId m7-wp6-verify-20260926-a0270ce320c7-acab
                FAIL 中间档（-ebd5 / -0ee8）留档：全部为量具算式错（侵蚀结算/
                里程碑叠加/联合档基点），链路行为全程正确——判据修正如实记录
m7:wp6:td07     PASS 11/11   runId m7-wp6-td07-20260926-55262f6ea496-1c32
m7:wp6:td06     PASS 13/13  runId m7-wp6-td06-20260926-985a32b3831c-3ebe
                FAIL 中间档（-bec2）留档：3 条样本正文不满足自身标签的
                机器可导性质（uptake 令牌缺席/打发句含令牌）——语料修正；
                D 段 = 量具自证（注入三种坏形态逐条点名 + 恢复安静）
边界门（本 WP 触及面）：kernel:test 26/0 · kernel:verify 25/0 · m4:test 258/0 ·
                m4.5:test 135/0 · m4:verify EXIT 0 · m4:isolation:verify EXIT 0 ·
                dev-test-guard EXIT 0 · m5.1:measurement:verify 16/0 · typecheck EXIT 0
```

## 5. WP6-B（待用户授权的真模型面；不因本单自动开跑）

```text
① Level 1 短场景    关系状态 × 探针的真模型回复；机器面 = 结构性（注入块在场）
                    + 算式一致；语义面 = 人工盲审（四查，见冻结单 §6）
② 长轨迹正式运行    按冻结单：1×500 · spawn-per-turn · 检查点程序读数 +
                    G-M7-L1…L5 机器门；预算 500+9 次调用
③ TD-06 判定轮      冻结判定器先过有效性集（14 条已知标签样本），
                    再跑场景语料（12 条）出基线读数；与 M6.1 基线分列
④ 运行器与盲审包生成器  随授权一起建（M6.1 live-long 同形状的 spawn-per-turn
                    骨架 + M7 检查点读数 + local/ 盲审包，Git 只落摘要）
⑤ 预检闸            开跑前 3 探针 × 3 次 execution（m6.1-preflight-lib 同一实现）
```

授权边界重申：本 WP 的全部离线证据不冒充 Level 1（计划 §7.3：
"没有真实模型读数时只能标 NOT RUN"）。

## 6. 已知边界（本 WP 不主张什么）

```text
· 日基规则（R-1 跨日累积、>24h 侵蚀）在真实时钟的数小时运行里不可触发——
  它们的验证在离线门的合成时间线上（P5/P7 段）；长轨迹不主张覆盖（冻结单 §2）
· 锚点语义：lastInteractionAt 只随关系证据域事件推进；日常无命中的聊天
  不推锚 ⇒ 侵蚀持续 ⇒ 读回如实显示"距上次互动 X 小时"。契约行为，非缺陷
  （WP5 交接 §6 已登记，本 WP 门 P5b 的侵蚀结算再次验证了该语义）
· --test 干跑对她等于没发生过（不写账本事件 ⇒ 调度无尾窗 ⇒ 关系不动）——
  测试纪律与既有约定一致
· 复读/挟持的**行为修复**不在本 WP：TD-06 的定义与量具已就位，
  根因定位与修复是读数出来后的下一步（L-M61-01：预期在行为/装配层）
· 生产激活不在本 WP：flag 代码缺省仍 off；激活走独立 ADR + 用户批准
```

## 7. 下一 WP 入口（WP7）

```text
· m7:gates 汇总门：读已落盘证据（含本 WP 三份 PASS 门与 WP6-B 的 NOT RUN 分列）
· 收口文档四件套：Acceptance-Report / Gate-Decision / Known-Limitations / Handoff
· TD-16 状态对账：M7 判定文档带 当前/历史/取代 三列导航；冲突清单分列
· Original Lv1 状态：仅在本门满足后更新为完成候选（计划 §5 WP7 行）
· WP6-B 若获授权并开跑：其读数进 WP7 的 Gate-Decision 分列段
```
