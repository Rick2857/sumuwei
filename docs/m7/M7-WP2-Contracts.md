# M7-WP2 · 关系合同与事件形状

> 日期：2026-09-26。状态：**WP2 交付**。语义权威：[ADR-064](../adr/ADR-064-m7-relationship-semantics.md)（ACCEPTED / DESIGN FROZEN，含 §2/§5.1 两处 WP2 合同期澄清）。
> 计划对应：[`M7-Execution-Plan.md`](M7-Execution-Plan.md) §5 WP2——"RelationshipState、ImpactProposal、DomainEvent、拒绝理由码、版本/幂等形状"。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| [`src/kernel/contracts/relationship.ts`](../../src/kernel/contracts/relationship.ts) | 关系合同本体：键与作用域 / 状态 / 界 / originKind / 衰减纯函数 / 证据等级判据 / payload 形状与结构校验 / 拒绝码登记表 |
| [`src/kernel/contracts/domain-event.ts`](../../src/kernel/contracts/domain-event.ts)（追加节） | `RELATIONSHIP_ORIGIN` / `RELATIONSHIP_IMPACT` 类型登记 + `createRelationshipDomainEventRegistry()` 工厂（**只登记不接线**，装配归 WP4） |
| [`src/kernel/contracts/index.ts`](../../src/kernel/contracts/index.ts) | 桶导出追加 relationship.ts |
| [`scripts/m7-wp2-contracts.ts`](../../scripts/m7-wp2-contracts.ts) | WP2 出口门（`pnpm m7:wp2:contracts`） |

## 2. 合同要点（与 ADR-064 逐条对应）

```text
键与作用域（D-1）   EntityRelationKey{owner,target}（entity.ts 冻结形状，S1 静态检查）
                   projectionType = relationship:<targetKind>:<targetId>（作用域编进类型）
状态（D-2）         RelationshipState{originated, trust, closeness, originKind, lastInteractionAt}
                   版本/时间/来源在投影信封上（CharacterProjection 既有字段），不重复
界（D-2 澄清）      Validator 拒绝超界（±0.05/±0.03）；reducer 兜底夹 [0,1]
初始基线（U-M7-02） RELATIONSHIP_ORIGIN 事件携带 0.85/0.60（originKind=SETTING_BASELINE，
                   basis 非空 = "用户 2026-09 授权的角色设定"）；initialState 是"未建档"零值，
                   基线值只存在于事件里——数字不无来源
证据等级（D-3）     relationshipEvidenceVerdictOf：候选非空 且 每条都是 user_message
                   且 sourceQualificationOf = ESTABLISHED（ADR-043 的唯一资格派生，不另造判据）；
                   她的生成/工具/未确立归因一律 Tier 0；混引她的回复 = 整体不合格
时间语义（D-5+§5.1）erodeClosenessForAbsence 纯函数（24h 阈值 / 0.02 每天 / trust 恒定）；
                   锚点 lastInteractionAt 由事件折叠；事件间侵蚀在纯折叠内结算（不可逆）；
                   读时视图 effectiveRelationship 只算当前疏远、不回写
认知完整性（D-7）   originKind 三值全登记；MAINTENANCE_INJECTION 登记但 M7 放行口
                   一律拒绝（originKindAcceptedByM7 = false）——未来注入从第一天就可判
纠正链（场景 11）   RELATIONSHIP_IMPACT.supersedes{domainEventId, reason}；旧事件不物理删除
幂等/版本           沿用既有机制：DomainEvent.idempotencyKey（持久层唯一索引）+
                   投影信封 revision/reducerVersion（乐观锁 + reducer_version_mismatch）
```

**拒绝理由码**（12 个，全具名，`RELATIONSHIP_REJECTION_CODES`）：owner_mismatch · target_kind_invalid · delta_not_finite · delta_out_of_bounds · origin_values_out_of_range · origin_kind_invalid · origin_injection_not_enabled · origin_already_exists · origin_missing · evidence_missing · evidence_not_qualified · supersedes_invalid。WP4 的 Validator 只能引用登记过的码。

## 3. 量具与读数

| 命令 | 退出码 | 读数 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净（含新合同 + 门脚本） |
| `pnpm m7:wp2:contracts` | 0 | **PASS 37/37**（静态 4 · 正控 12 · 负控 17 · 恢复 4）；runId `m7-wp2-contracts-20260925-33d0c08eefc3-…`（见 artifacts/m7/ 最新一份） |
| `pnpm kernel:test` | 0 | 26/0（含依赖方向边界组——contracts 未越界） |
| `pnpm kernel:verify` | 0 | 25/0 |

**量具校准记录（如实登记，读数保留）**：首跑 FAIL 35/37，两处红都是**量具自身的缺陷**，不是合同缺陷：
① P9 期望值算术错（72h−24h 阈值=48h 计费 ⇒ 0.8−0.04=**0.76**，我写成了 0.74；函数行为已被 P8 独立验证正确）；
② S2 天真扫描把 `entity.ts:200` 的**禁令原文注释**（"不允许 userTrust 这种形状"）误报为违规——已改为注释感知扫描（字符串状态机剥离注释；字符串字面量仍在扫描内，列名叫 userTrust 同样算违规）。
首跑的 FAIL 证据目录按"runId 拒绝覆盖"纪律保留，不删除。

## 4. 迁移与兼容说明（计划 §9.1"旧状态模型冲突"的处置）

```text
不动 legacy：src/state/types.ts（CharacterState）与 src/state/decay.ts 一行不改——
  它们是 M1/M2 已验收的冻结语义，且 M7 的衰减常量显式引用其语义来源。
不静默重写：不把 legacy CharacterState.trust/closeness 的当前值"迁移"进新投影——
  那些值没有事件级来源（U-M7-02 裁定 (c) 已否决）。
桥接（WP5）：M7 投影成为 trust/closeness 的唯一权威后，legacy CHARACTER_STATE
  provider 改为从投影读（桥）或退役——影响半径审查在 WP5 做，届时不允许双权威。
新迁移：WP4 若需要投影持久化表，新迁移版本号从既有最大值 +1，DDL 只追加；
  真实库应用必须另行逐字授权（本计划不授权任何真实库变更）。
```

## 5. 已知边界（本 WP 不主张什么）

```text
✗ 不主张提案器存在（WP3）——合同只定义了提案的 payload 形状与 proposalType 常量。
✗ 不主张 Validator/Reducer/Projection 存在（WP4）——12 个拒绝码是登记表，尚无消费点；
  createFullDomainEventRegistry() 刻意不含关系类型（S4 检查守着这条纪律）。
✗ 不主张规则集已冻结——ruleId 是字符串占位；附录 A 的规则集在 WP3 前需用户逐条裁定。
✗ 不主张行为接线（WP5）——effectiveRelationship 是纯函数，还没有任何 Context 消费它。
```

## 6. 下一 WP 入口

```text
WP3 —— 关系证据与提案器
  前置：附录 A 规则集逐条裁定（U-M7-04 选 (C) 的既定程序：规则先冻结，再实现）
  交付：relationship-evaluator 提案器（确定性规则，CharacterProcessor 接口），
        证据绑定（relationshipEvidenceVerdictOf 的调用点），Unknown/拒绝分支
  出口：助手生成和外部观察负控不产生关系变化；提案不得直接落库（计划 §5 WP3）
  机器门：m7:wp3:* 系列随实现接线（沿用 m7-manifest@1 全字段清单）
```
