# M7 未决决定清单（Unresolved Decisions）

> 日期：2026-09-26。状态：**ADJUDICATED / FROZEN**。
> 配套：[`ADR-064`](../adr/ADR-064-m7-relationship-semantics.md)（**ACCEPTED / DESIGN FROZEN**）。
> **裁定记录**：2026-09-26，用户答复「按你建议做，继续下一步」——
> 七项全部按推荐项通过，ADR-064 随即冻结。逐项裁定值见下表「裁定」列。

## 裁定结果（2026-09-26）

| # | 问题 | 裁定 | 生效方式 |
|---|---|---|---|
| U-M7-01 | 关系键与投影作用域命名 | **(a)** 按 D-1 冻结 | WP2 合同照写 `EntityRelationKey{owner,target}` + `relationship:<targetKind>:<targetId>` |
| U-M7-02 | 初始关系基线来源 | **(a)** ORIGIN 事件携带授权基线 0.85/0.60（`originKind=SETTING_BASELINE`） | WP2 合同含 origin 事件形状；WP4 reducer 按它建档 |
| U-M7-03 | 证据等级 | **(a)** 按 D-3 冻结（只有 confirmed 用户直接互动可推动） | WP3 提案器的输入面；负控进 WP4/WP6 |
| U-M7-04 | 提案机制 | **(C)** 确定性规则提案器先行 + 接口按 CharacterProcessor 预留 LLM evaluator | 规则集在 WP3 前**二次裁定**（ADR 附录 A）；在此之前不实现具体规则 |
| U-M7-05 | 时间语义 | **(a)** 按 D-5 冻结（读时惰性结算；24h 后 closeness 0.02/天；trust 不随时间变；不回写投影） | WP4 接 decay 语义进投影读路径；参数可在 WP3 用真实轨迹校准后定稿，形状不变 |
| U-M7-06 | 行为接线 | **(a)** 按 D-6 冻结（单一关系区段；确定性分档；prompt 基线重刷） | WP5 接线；`m3.5:baseline` 重刷走全套门 |
| U-M7-07 | 认知完整性注入预留 | **(a)** 按 D-7 冻结（originKind 三值：SETTING_BASELINE / INTERACTION_DERIVED / MAINTENANCE_INJECTION 预留） | WP2 合同的枚举从第一天三值；M7 不建注入 UI |

## 原表决单（历史保留）

> 以下为裁定前的选项与影响分析，逐字保留作为裁定依据；不再更新。

### 需要裁定的七项

| # | 问题 | 选项 | 推荐 | 各选项的影响 |
|---|---|---|---|---|
| **U-M7-01** | 关系键与投影作用域的命名是否按 D-1 冻结？（`EntityRelationKey{owner,target}`；`projectionType = relationship:<targetKind>:<targetId>`；第一阶段唯一实例 `relationship:user:<userId>`） | (a) 按 D-1 冻结 (b) 改命名 | **(a)** | (a)：与 FC-05/ADR-018/projection-model 三处既有裁定逐字一致，WP2 直接照写。(b)：任何改名都要先改三份冻结文档 + ADR，成本高且无收益。 |
| **U-M7-02** | 初始关系基线从哪来？ | (a) ORIGIN 事件携带用户授权基线 0.85/0.60（`originKind=SETTING_BASELINE`） (b) 中性 0.5/0.5 靠互动长 (c) 迁移 legacy CharacterState 当前值 | **(a)** | (a)：与角色设定（十几年信赖）连续、来源诚实（设定非经历）、可审计。(b)：她对认识十几年的人会表现得像陌生人，且"演化"从错误起点开始。(c)：legacy 值无事件级来源，迁移=给无来源数字洗白，违反认知完整性精神。 |
| **U-M7-03** | 证据等级是否按 D-3 冻结？（只有 confirmed 用户直接互动事件可推动；她的生成/工具/摘要/外部证据/unconfirmed 一律 Tier 0） | (a) 按 D-3 冻结 (b) 放宽某类 | **(a)** | (a)：负控面清晰，与铁律 6、M6.1 全部教训一致。(b)：任何放宽都要先回答"这类文本什么时候说过谎"（M6-FMB-01 的判定契约纪律对证据面同样适用）。 |
| **U-M7-04** | 提案机制选哪个？ | (A) 确定性规则提案器（首版） (B) LLM relationship-evaluator (C) A 先行 + 接口按 CharacterProcessor 预留 B | **(C)** | (A/C)：可重放、可审计、负控精确、零模型成本；规则集逐条裁定后冻结（ADR 附录 A）。(B)：语义覆盖宽，但提案器自身需要 M6.1 式量具有效性验证，M7 范围会显著膨胀；且"模型提案漂移"需要新量具。 |
| **U-M7-05** | 时间语义是否按 D-5 冻结？（衰减读时惰性结算：24h 后 closeness 0.02/天，trust 不随时间变，衰减不进 reducer、不回写投影、不可逆） | (a) 按 D-5 冻结 (b) 调参数 (c) 衰减也走事件 | **(a)** | (a)：与 decay.ts 既有语义、ADR-003（reducer 禁时间）双重一致；重放不受影响。(b)：参数（24h/0.02）可在 WP3 用真实轨迹校准后再定稿，但形状不变。(c)：需要调度器 + 时间事件，违反 ADR-003 且引入后台任务（M6.5 边界：Level 2 前不接后台）。 |
| **U-M7-06** | 行为接线是否按 D-6 冻结？（单一 relationship 区段，确定性分档措辞，不叙述事件；legacy CHARACTER_STATE 桥接或退役；prompt 基线重刷） | (a) 按 D-6 冻结 (b) 不动 prompt（状态只进开发者面） | **(a)** | (a)：O-2"影响行为"的唯一落点；不接线 = M7 无法主张 O-2。(b)：M7 退化为纯数据里程碑，O-2 仍 PARTIAL——与计划 §0 主目标冲突，不推荐。 |
| **U-M7-07** | 认知完整性的注入预留是否按 D-7 冻结？（originKind 三值：SETTING_BASELINE / INTERACTION_DERIVED / MAINTENANCE_INJECTION 预留；M7 不建注入 UI） | (a) 按 D-7 冻结 (b) 不预留 originKind | **(a)** | (a)：未来若注入，来源从第一天可判（INV-CI-01 的低成本前置）。(b)：省一个枚举值，但未来注入时无法与互动推导区分——重演 M5.1-D01 的归因缺口。 |

## 不需要裁定的项（既有裁定直接继承）

```text
· 关系键形状 owner→target（FC-05/ADR-018 已冻结，M7 只照写）
· 投影可重放/版本化/乱序保护（ADR-003 已冻结）
· 认知完整性五不变量（INV-CI-01…05 已登记）
· WP0 准入的三条设计约束（证据=事件区间读；纠正=域事件 supersede；区间界显式分页）
· 措辞层无启发式守卫（DR-11 立场不变）
```

## 裁定后的路径（已执行）

```text
✅ 用户裁定（2026-09-26「按推荐执行」）
✅ ADR-064 状态改 ACCEPTED / DESIGN FROZEN
✅ WP2 开工：关系合同（RelationshipState / ImpactProposal / 域事件 / 拒绝理由码 / 迁移说明）
→  静态守卫（无 userTrust 硬编码 / EntityRelationKey 形状）随合同落地
→  WP3 前：附录 A 规则集逐条二次裁定（U-M7-04 选 (C) 的既定程序）
```
