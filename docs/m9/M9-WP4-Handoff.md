# M9 WP4 交接单 —— Belief Kernel（Validator / Reducer / Store / 接线）

> 工作包：WP4「信念域核心机制」（计划 §12/§13；ADR-070 §4.2/§5.4）。
> 前序：WP3 交接单（`M9-WP3-Handoff.md`）。本单是 WP5（B-REPORTED reconciler +
> 生命周期产出者）的输入。

## 0. 判定

**WP4 = PASS**（工程面）。机器判据 `pnpm m9:verify` = **54/54 通过 · 0 失败**
（runId `m9-wp4-verify-20260927-8a1e0a989977-45bb`，提交 `8a1e0a9`，隔离库，
EXIT 0）。配套门：`kernel:test` 26/0 · `kernel:verify` 25/0 ·
`m9:test` 20/0 · `m9:source:verify` 复验 26/26（评估器重构后行为保持，
runId `m9-wp3-source-20260927-8a1e0a989977-06b7`）。
`m4.5:ci` 读数见 §6（收口门）。

## 1. 交付物

| 文件 | 角色 |
|---|---|
| `src/kernel/projections/belief.ts` | 七类 BELIEF_* 纯 reducer（`belief-reducer@1`）：origin first-wins；FORMED 新 id；REINFORCED active-only + 去重（INV-M9-08）；DISPUTED/SUPERSEDED/RETRACTED 终态语义（B28 不复活）；证据累计按 (slot,value) 复合键 |
| `src/infrastructure/persistence/belief-store.ts` | `foldBeliefRows` 纯编排核心；`applyBeliefRows` 增量（读行→折→diff 回写，事务）；`rebuildBeliefProjections` 全量重建（删→重放→插，事务）；`forbiddenRootsForSlot` 从 RETRACTED 事件流推导（孤儿撤回跳过不猜）；读助手 `getBeliefOrigin/getBelief/listBeliefRows` |
| `src/kernel/policies/belief-validator.ts` | 信念事件唯一放行口：14 业务码 + 管线通用码；每事件一领域单元的幂等键（range 分量置零）；阈值复推 + beliefId 确定性复推 + 同值拒/异值放（冲突信号）；生命周期失败关闭 |
| `src/kernel/contracts/belief.ts`（增量） | 资格四条单源（`beliefEvidenceQualifies` / `beliefEvidenceVerdictOf`）；`BELIEF_REJECTION_CODES` 14 项冻结；`fnv1aHex` 导出 |
| `src/kernel/app/belief/evaluator.ts`（重构） | 资格判据改用 contracts 单源（行为保持；`BeliefEvidencePolicy` re-export 兼容既有导入） |
| `src/kernel/contracts/domain-event.ts`（接线） | `createBeliefDomainEventRegistry()` 并入 `createFullDomainEventRegistry()`（M7/M8 同序的可审计分步） |
| `scripts/m9-verify.ts` + `m9:verify` | WP4 门（§2 判据清单） |

零迁移：全部行落既有 `character_projections` 表（PK `(character_id, projection_type)`，
projection_type 前缀 `belief:`）。

## 2. 门判据（m9:verify 四段，全部失败关闭）

- **§1 三方折叠比对**：同一 30 事件剧本喂生产 reducer（foldBeliefRows）、
  独立 oracle（`evals/fixtures/m9/belief-oracle.ts`，不 import 生产代码）、
  手写预期——逐信念比对 status/roots/epistemicKind + origin + 禁用根 +
  证据累计行。剧本覆盖：形成阈值、强化去重、重放 no-op、异值冲突并存、
  争议→取代→撤回全状态机、证据行清零重建、禁用根下合法重开。
- **§2 Validator 正控/负控（39 例）**：合成 deps + 真实 registry；接受的样本
  折进行内模型（与 §1 同一折叠核心）。每例断言 accept 或具名拒绝码。
- **§3 Store 往返（隔离库）**：30 提案 → 24 落库（6 重放单元被唯一约束挡下，
  断言去重本身）；两批增量 apply（批界切在 SUPERSEDED 后，覆盖跨批
  「清零→再累计」）→ 快照 A；全量 rebuild → 快照 B；**A==B 逐字段一致**
  （SC-005：投影是缓存；updatedAt 除外）；库侧禁用根与 oracle 一致。
- **§4 接线与冻结面**：全量登记表 7/7；拒绝码表 14 项无重复；
  `belief-reducer@1`；资格四条与 M8 `affectEvidenceVerdictOf` 对同一夹具
  同判定（5 夹具全一致，跨 ADR 防漂移）；B-REPORTED 规则常量在案。

## 3. 校准记录（门抓出的真缺陷，两轮）

**轮 1**（FAIL 于 `54d7dd2`，54 项 48 过；崩溃在 §3 写证据前，无 run 目录）：
1. **store 写回缺陷**：同一批内「证据行清零（SUPERSEDED/RETRACTED）→
   再累计（后续 EVIDENCE_NOTED）」走了 save 路径，拿 pre-batch 旧 revision
   更新一条本事务已删除的行 ⇒ `projection_missing`。修复：删除集里的键一律
   走 insert；清零后重建从 revision 1 重新计，与 rebuild 折叠语义一致（A==B 保持）。
2. 门夹具：同单元重放提案先撞 `duplicate_operation`（幂等检查先于业务规则——
   设计如此），到不了目标业务码 ⇒ 负控样本换新 formationKey/新信念/换 processor。

**轮 2**（FAIL 于 `b16cf25`，runId `…-b16cf25b3e21-fc7c`，54 项 48 过 6 败，
证据目录**保留在案**）：
1. **replay 重复清零**：replay 的 SUPERSEDED 会再次触发证据行清零（把取代后
   新记的 r8..r10 又清了一遍）。修复：清零只在迁移真实发生时执行
   （SUPERSEDED 要求折叠前 active/disputed；RETRACTED 要求非 retracted）——
   与 oracle 终态守卫逐字段对齐（oracle 是规格）。
2. **门夹具 owner 错**：payload.characterId 硬编码 `char_sumuwei`，而
   `kernel.characterId` 是种子 UUID ⇒ rebuild 的 `beliefEventTargets` 过滤
   把 24 事件全滤掉（`rebuildEvents=0`）。修复：夹具 owner 参数化（`useOwner`）。
3. ORIGIN 重复建档负控换 processor（同 processor 同单元先撞幂等键）。

生产事件流里重放单元本就不会二次落库（幂等键唯一约束）；折叠层的 no-op
与清零守卫是纵深防御——rebuild 必须对任意事件序稳健。

## 4. 设计要点（WP5 要用）

- **幂等键**：`(character, processor, version, unit)`，range 分量恒 0。
  unit：`belief-origin` / `belief-evidence:<rootEventId>:<ruleId>` /
  `belief-formed:<beliefId>` / `belief-reinforced:<beliefId>:<fnv1a(sorted newRootIds)>`
  / `belief-disputed:<beliefId>` / `belief-superseded:<old>:<new>` /
  `belief-retracted:<beliefId>`。同批多条会算出同一键——所以 Belief 链
  **不复用** `DomainPolicyValidator`（其幂等键第五分量只有 operation）。
- **冲突不自动争议**：异值现存 + 新 FORMED ⇒ 照放（冲突是真实信号）；
  DISPUTED 是显式事件（WP5 产出者）。同值现存 ⇒ 拒 `belief_slot_already_active`
  （那是 REINFORCED 的事）。
- **FORMED(inferred) 复推双保险**：阈值（≥3 根 / ≥2 会话）+ beliefId 确定性
  （`makeBeliefId(characterId, slotKey, max root seq)`）在放行口再算一遍。
  FORMED(reported) WP4 只做结构检查（`dependsOnMemoryIds` 必填）——
  **记忆资格检查是 WP5 reconciler 的活**（`isBeliefReportedEligible` 已在 contracts）。
- **禁用根**：`forbiddenRootsForSlot` 读 BELIEF_RETRACTED **事件**（不是投影——
  禁用根是事件携带的承诺），从各撤回信念的行推导槽位；孤儿撤回跳过。
  EVIDENCE_NOTED / FORMED / REINFORCED 三处都查相交。
- **证据行清零**：SUPERSEDED/RETRACTED 命中值 ⇒ 该 (slot,value) 累计行删除
  （被取代/撤回的值的累计不得喂同值新形成）；DISPUTED 保留累计。
  已接受的保守边界：争议窗内 noted-but-not-reinforced 的根也会被清（fail-closed，v1 接受）。

## 5. 边界与不做清单

- WP4 不产出任何 BELIEF 事件（产出者是 WP3 评估器 + WP5 reconciler/生命周期）；
  本步只交付「事件 → 放行 → 落库 → 投影」的机器面。
- 不动 Memory/Relationship/Affect 任何语义；`createFullDomainEventRegistry`
  只做并入（affect/relationship 先例同序）。
- 调度器（belief-scheduler 双水位）、`CHARACTER_BELIEF_ENABLED` 开关、
  main.ts 装配 = **WP6**；上下文注入 = **WP7**；e2e = **WP8**。
- 真实库未打开（§3 全程 `isolateDatabase('m9-verify', { keep: false })`）。

## 6. 提交链（本工作包）

```
54d7dd2  feat(m9): WP4 belief kernel - validator, reducer, store, registry wiring
b16cf25  fix(m9): WP4 calibration round 1 - store write-back + gate fixtures
8a1e0a9  fix(m9): WP4 calibration round 2 - replay reset guard + gate owner fix
856cfaf  test(m9): WP4 evidence - verify 54/54 PASS + source re-verify 26/26 + FAIL intermediate kept
```

`m4.5:ci` 收口读数：**EXIT 0**（2026-09-27，`856cfaf` 树上；G2 Component
135/0 · G12 Measurement 38/0 · L2 Pipeline 53/0 · G13 NL E2E 32/0 ·
G9 人工审计语料 12/0 · G14 Live Smoke 读数 52/0；CI 重写过的六份历史
证据文件已按白名单纪律还原，树净）。

## 7. WP5 输入清单

1. B-REPORTED 白名单 reconciler：水位化扫描 Memory 事件（`afterSequence` 可用，
   WP3 §4 已验证），`isBeliefReportedEligible` + `BELIEF_REPORTED_RULE_ID@VERSION`
   过 validator（reported 路径的结构检查已就位，补记忆资格检查）。
2. 生命周期产出者：DISPUTED/SUPERSEDED/RETRACTED 的 NL 路由（U-03）——
   validator 的失败关闭面已冻结（14 码），产出者只需构造合法提案。
3. `m9:invalidation:verify` 门：遗忘契约（§5.4）的端到端判据。
