# M8 → M9 交接单（含能力影响矩阵的 as-built 读数）

> 状态：**ACTIVE**（2026-09-26，随 M8 WP8 收口发布）
> 判定：[M8-Gate-Decision.md](M8-Gate-Decision.md) · 边界：[M8-Known-Limitations.md](M8-Known-Limitations.md)
> 下一里程碑：**M9 Belief**（信念/世界观状态；计划链见 M8-Execution-Plan §1）

## 1. 能力影响矩阵（as-built；计划 §14 的逐项核销）

| 能力/组件 | M8 是否新增 | 影响面 | 证据 | 结论 |
|---|---:|---|---|---|
| Character Domain / ContextCompiler | 否，复用 | affect section（52 号） | e2e A17 + WP5 基线门 | 复用 |
| Attribution / source qualification | 否，复用 | 用户来源资格闸 | e2e A11/A18 + M5.1.1 既有证据 | 复用 |
| Generic domain event/projection store | 否，复用 | `affect:character` 事件/投影 | WP4 14/14 + 长轨迹 rebuild 对账 | 复用 |
| M7 relationship | 否 | 双 section 并存 | e2e A17 + 长轨迹 L-M7 | 不改语义 |
| 时间衰减 | 否，收口为 effective read | affect 数值 | e2e A16（+8h 读时衰减不写回） | 复用并规范化 |
| 外部网络搜索 | 否 | 无 | — | NONE |
| 外部应用/桌面控制 | 否 | 无 | — | NONE |
| 后台自主任务 | 否 | 无 | — | NONE |
| 多模态输入 | 否 | 无 | — | NONE |
| 新 MCP / 通用适配器 | 否 | 无 | — | NONE |
| 新权限边界 | 否 | 只读/内部 Character 状态 | WP3 负控（注入具名拒收） | NONE |
| 长期记忆写入 | 否 | 明确禁止自动写入 | e2e A06（id 集合差分：新增事件 ⊆ AFFECT_*） | NONE |

**M8 的唯一新增"能力"是 Character 内部 affect 状态的程序化演化**——不是
外部 capability，不得写成"新增一个可以操作世界的工具"（L-M8-11）。
**M8 database migration = NONE**（WP4 验证：全部复用既有通用表）。

## 2. M9 可以直接复用的 M8 资产

1. **事件溯源骨架的第 4 次实例化模板**：contracts → patterns/evaluator →
   validator（fail-closed）→ reducer/投影 → 水位调度 → section 注入 →
   trace 步 → 装配。Belief 若走同形（ADR-066 §10 的预留），每层都有
   M8 的门模板可抄（wp2→wp6 的三段式结构）。
2. **词形判据框架**（`patterns.ts` 的规则族 + 抑制 + 毒化 + 主导裁定形状）：
   Belief 的"用户陈述世界观"检测可同形实例化；版本化判据（`@1` 后缀）
   的回滚纪律直接沿用。
3. **量具骨架**：语料不变量开跑闸（纯函数自证）+ e2e 三段式 + 长轨迹
   生成器/验证器分离 + Live Smoke 运行器/读数器分离 + `m8:gates` 聚合器
   （okVerdicts 按门分列）。
4. **失败注入代理**（`withFailingDomainEventWrites`：StringChunk 数组语义、
   execute+transaction 双包）与"负控必须有不依赖注入的第二道断言"的防线。

## 3. M9 开工前必须先处理的登记项

| 项 | 位置 | 为什么是 M9 的输入 |
|---|---|---|
| **M7 潜伏双缺陷**（tool 楔死 + catch 不 finishJob） | L-M8-13 | M9 若给 belief 评估器接 tool 事件或同形调度，会**第三次**踩同款；建议 M9 WP0 一并修 M7 侧（或 M7 维护线先修） |
| 语义评估器预留位 | ADR-066（A-UNCERTAIN 具名回退） | Belief 的"陈述 vs 提问 vs 引述"判别大概率需要它；M8 留了位没实现（v1 恒不产 impact） |
| 盲审结论 | Gate-Decision §4（**PASS**，2026-09-27 修订；原 PENDING 读数保留） | M9 的注入块措辞设计应带上 M8 人审的语义级发现（若有）；M9 仍须**独立**人审——不代填、不类比、不借用（ADR-070） |
| `src/state` 兼容窗口退役 | ADR-066 §9 · L-M8-09 | M9 加第 5 个投影前，旧情绪字段的退役裁定应先落地（避免三套数值并存） |
| TD-08 召回规模 / perspective owner | M7 计划 §8 的既有前置 | M9 计划书必须复核（M7 交接原话，未因 M8 改变） |

## 4. M8 留下的边界（M9 不得静默扩权）

- 规则覆盖面外 = 只 touch 不 impact（L-M8-01）：M9 不得为"提高触发率"
  加启发式——扩展走语义评估器位 + 新 ADR。
- affect 事件永不自动进长期记忆（矩阵 NONE 行）：Belief 的"世界观陈述"
  若要进记忆，走 M4 的既有放行口，不开旁路。
- 单投影不分片（M8-D03）与单 active user（M8-D11）：多用户是 TD-20 的
  准入边界，M9 不因新增投影改变它。
- 措辞层没有启发式守卫（DR-11）：M9 的注入块同样只保证上下文/程序事实链。

## 5. 证据索引（M9 复核时的入口）

```text
docs/m8/M8-Execution-Plan.md          计划（PLAN READY → 已执行）
docs/m8/M8-WP{0..7}-Handoff.md        逐 WP 交接（含失败档与教训）
docs/m8/M8-{Architecture,Acceptance-Report,Known-Limitations,Gate-Decision}.md
docs/m8/M8-Activation-Candidate.md    激活候选（等授权）
artifacts/m8/<runId>/                 29 个 run 的机器证据（m8-manifest@1）
artifacts/m8/gate-results.json        m8:gates 聚合读数（只读索引）
artifacts/m8/local/<live runId>/      盲审正文（gitignore，不进仓库）
```
