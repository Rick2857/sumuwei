# M7-WP4 · 验证器 / Reducer / 投影（放行口 + 折叠 + 装配）

> 日期：2026-09-26。状态：**WP4 交付**。语义权威：[ADR-064](../adr/ADR-064-m7-relationship-semantics.md)（本轮增补 §5.2 三条实现期澄清）。
> 计划对应：[`M7-Execution-Plan.md`](M7-Execution-Plan.md) §5 WP4——"验证器、Reducer、投影持久化"。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| [`src/kernel/policies/relationship-validator.ts`](../../src/kernel/policies/relationship-validator.ts) | **唯一放行口**：12 个登记拒绝码 + 管线通用码；领域幂等键 `idempotencyKeyForRelationshipEvent`（判别分量 `${operation}:${ruleId}:${unit}`；r1/origin 的 range 置零） |
| [`src/kernel/projections/relationship.ts`](../../src/kernel/projections/relationship.ts) | 纯折叠 reducer：ORIGIN 建档 · IMPACT 事件间侵蚀结算（§5.1）+ 有界 delta + **撤回反扣**（§5.2 ①）+ 指进入案登记表；`relationshipReducerFor(target)` 工厂（per-target 信封不前进） |
| [`src/infrastructure/persistence/relationship-store.ts`](../../src/infrastructure/persistence/relationship-store.ts) | 投影存取 + **按目标过滤的重放**（`rebuildRelationshipProjection`——通用 rebuild 不带目标过滤，会 A≠B） |
| [`src/kernel/app/relationship/job.ts`](../../src/kernel/app/relationship/job.ts) | 评估编排（ports-only）：窗口事件 → 评估器 → 逐提案放行（REJECT 是正常结果）→ `applyAcceptedEvents`（per-target reducers） |
| [`src/kernel/contracts/domain-event.ts`](../../src/kernel/contracts/domain-event.ts) | 关系类型接入 `createFullDomainEventRegistry()`（WP2 的"只登记不接线"在本步完成） |
| [`scripts/m7-wp4-verify.ts`](../../scripts/m7-wp4-verify.ts) | 部件门（`pnpm m7:wp4:verify`）：三段式 20 项，隔离库 + 真存储 + 真入口归因 |

## 2. 零新迁移（WP3 交接单的更正）

WP3 文档曾猜"投影持久化（新迁移版本号）"。实际：**零新表、零迁移**。
`character_projections` 从 M2.5 起就是通用表（`(character_id, projection_type)` 主键），
关系投影的作用域编在 projectionType 里（`relationship:user:<id>`——
contracts/projection.ts 的设计意图在此兑现）；域事件 / 幂等 / 任务表全部照用。
**真实库不需要任何迁移**（这也是"计划不授权真实库变更"的自然满足）。

## 3. 三条实现期澄清（ADR-064 §5.2，部件门验证）

```text
① 撤回反扣  "supersede 后旧事件不再驱动投影" = 撤回形折叠时反向扣除被撤回
            指控的 delta 再应用 +0.03 ⇒ 净效果 = 指控前 + 0.03（P5b：0.90，
            未反扣的错误值是 0.85）。修复形纯叠加（净 = 指控后 + 0.03）。
            两形之差 0.05 正是"误会"与"原谅"的语义差。
② 在案登记表 RelationshipState.accusationsInCase：reducer 反扣 / Validator
            在案检查（防双撤回）/ Job 评估器输入（按目标键控）三处共用，
            单一事实源；撤回即移除（有界）。
③ 幂等单元  payload 增必填 unit（r1=日 ISO · window · 里程碑标签）——键从
            事件自身可推导；r1/origin 的 range 分量置零（跨窗口同日撞键 =
            "同一天最多计一次"的机器保证，P3 验证 created=0）。
```

## 4. 实现期发现（如实记录，均已修）

```text
· appendDomainEvent 的隐藏假设：sourceConversationEventIds[0] 为空时 drizzle
  渲染出非法 SQL（values (…, , …)）。ORIGIN 的冻结形状是空来源（凭据是授权
  不是对话）⇒ 修为 ?? ''（该列是纯索引列，行读取不碰它）。
· createConversationLedger({db}) 不带归因生产者 ⇒ 全部走 legacy 路径 ⇒
  资格永远不是 ESTABLISHED。部件门用 createHumanConsoleUserTurnIngress()
  （生产 ingress）建立受信归因——这也是 WP6 接线时的必经之路。
· PG jsonb 会重排对象键序：库里读回的 state 与重建的内存 state 键序不同，
  逐字 stringify 比较会假阴性 ⇒ 部件门用键序无关的 canonical 比较。
· 多目标缺陷（WP3 遗留）：评估器的在案指控原是平铺数组，user-2 的指控会
  误放行 user-1 的修复 ⇒ 改为按目标键控（activeAccusations）。
```

## 5. 量具读数

| 门 | 退出码 | 读数 |
|---|---|---|
| `pnpm m7:wp4:verify` | 0 | **PASS 20/20**（正控 8 · 负控 8 · 恢复 4 · 事件落库 10 > 0）；runId `…-wp4-verify-…-7e79`（两次 FAIL 中间读数保留：`-a675` 首跑暴露 SQL 缺陷、`-7db8` 暴露 ingress 缺失） |
| `pnpm m7:wp2:contracts` | 0 | PASS 37/37（S4 判据随里程碑翻转：登记表 WP4 起接线，如实记录） |
| `pnpm m7:wp3:probe` / `m7:wp3:verify` | 0 | PASS 100% / 18/18（评估器形状变更后复验） |
| `pnpm typecheck` / `kernel:test` / `kernel:verify` | 0 | 干净 · 26/0 · 25/0（依赖方向边界组全绿） |

## 6. 已知边界（本 WP 不主张什么）

```text
✗ 不主张上下文接线：ContextCompiler 还不读关系投影（WP5：priority band
  44–55 的 section + legacy CHARACTER_STATE 桥 + prompt 再基线）。
✗ 不主张生产调度：job 的 enqueue / 水位推进 / 触发时机是 WP6 的装配工作；
  本 WP 交付的 runRelationshipEvaluation 是编排函数（ports-only），
  部件门里由脚本装配真存储驱动。
✗ R-5 计数端口在部件门里是内存实现（从账本派生，确定性成立）；
  生产化的大账本聚合（SQL count 或计数表）归 WP6——量级与正确性
  届时按 §6.8 自检。
✗ ORIGIN 建档的生产入口（kernel 初始化时按用户授权播种）归 WP5；
  部件门里的 relationship-origin-seeder 是验证用生产者形状样例。
```

## 7. 下一 WP 入口

```text
WP5 —— 上下文接线（状态如何影响行为，ADR-064 D-6）
  前置：投影可读（getRelationshipProjection / listRelationshipProjections）+
        effectiveRelationship 读时视图（当前疏远）都已就位
  交付：ContextCompiler 关系 section（priority band 44–55，读 effectiveRelationship，
        只读不回写）· legacy CHARACTER_STATE 桥（不破 m3.5 prompt 基线的前提下
        有意重刷并记录）· ORIGIN 播种接线（用户授权基线）
  出口：m3.5 prompt 门有意重刷记录 + 关系 section 的正控/负控（无关系 = section
        安静；有关系 = 值与投影一致）+ 她的可见回复不直接引用数值（D-6 措辞层）
```
