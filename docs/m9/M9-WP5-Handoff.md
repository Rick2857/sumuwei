# M9 WP5 交接单 —— 生命周期、遗忘与失效传播（Reconciler / Revision / Eligibility）

> 工作包：WP5「生命周期和遗忘」（计划 §12/§13 WP5；ADR-070 §5.1–§5.4、§7.1、B28–B31）。
> 前序：WP4 交接单（`M9-WP4-Handoff.md`）。本单是 WP6（belief-scheduler 双流装配）的输入。

## 0. 判定

**WP5 = PASS**（工程面）。机器判据 `pnpm m9:invalidation:verify` = **39/39 通过 · 0 失败**
（runId `m9-wp5-invalidation-20260927-9c67cf3fa885-06d9`，提交 `9c67cf3`，隔离库，
EXIT 0）。配套门（validator/contracts 改动后的全量复验）：
`kernel:test` 26/0 · `kernel:verify` 25/0 · `m9:test` 20/0 ·
`m9:verify` 复验 **54/54**（runId `m9-wp4-verify-20260927-9c67cf3fa885-340c`，
Memory 端口可选 ⇒ §2 合成 deps 行为不变）·
`m9:source:verify` 复验 **26/26**（runId `m9-wp3-source-20260927-9c67cf3fa885-a9df`）。
`m4.5:ci` 读数见 §6（收口门）。

## 1. 交付物

| 文件 | 角色 |
|---|---|
| `src/kernel/app/belief/reconciler.ts` | B-REPORTED 白名单形成路径：`reconcileMemoryWindow(deps, window)` 消费 Memory 事件触发（CREATED/RESTORED→候选；RETRACTED/SUPERSEDED/MERGED→失效集），合格 claim → FORMED(reported) **提案**（只产提案，绝不写投影）；资格（`isBeliefReportedEligible`）+ claim 内容 + 同值 active 预检三道短路，逐条 skip 理由 |
| `src/kernel/app/belief/revision.ts` | 生命周期规划器（全部只产提案）：`planMemoryInvalidation`（dependency_invalidated，**不禁根**）/ `planRootInvalidation`（forbidden=[该根]）/ `planBeliefForget`（唯一 active ⇒ forbidden=全部根；0/>1 ⇒ **clarify**，零提案零成功口吻）/ `planBeliefCorrection`（新值必须已形成，不倒写旧源）/ `planBeliefDispute`（≥2 active ⇒ 全 DISPUTED，不猜谁对） |
| `src/kernel/app/belief/eligibility.ts` | 读侧回查（双保险的读侧半边，ADR-070 §5.1/§5.2）：`recheckBeliefDependencies` 精确 id 批量读、`unavailable ≠ valid`（存储错误失败关闭）、inferred 根走资格四条、reported 根存在性 + Memory 白名单；`applyInvalidationOverlay` 纯函数同轮遮蔽（写侧修订失败仍零泄漏）；`usableBeliefsOf` |
| `src/kernel/policies/belief-validator.ts`（增量） | `BeliefMemoryLookup` 端口（**可选**；缺失 = reported 失败关闭 `belief_source_missing`）；FORMED(reported) 分支：Memory 存在性/归属/白名单复核 + beliefId 依赖哈希复推；RETRACTED 增 B28 硬规则：`user_forget_request` 必携非空禁用根 |
| `src/kernel/contracts/belief.ts`（增量） | `BELIEF_REVISION_RULE_ID/VERSION`（生命周期事件自带规则身份，与形成规则分开）；`beliefReportedFormationKeyOf`（依赖集合哈希 = reported 的确定性 identity）；`beliefReportedScopeKeyOf`（qualifier 规范化）；`BeliefRetractedPayload.forbiddenRootIds` 改 optional——运行时契约本就「空集合用 undefined 不用 []」，类型改诚实；语义分层：forget 必携非空 / dependency_invalidated 可省 |
| `src/infrastructure/persistence/belief-store.ts`（增量） | `listActiveBeliefs`（revision 规划器的读侧） |
| `scripts/m9-invalidation-verify.ts` + `m9:invalidation:verify` | WP5 门（§2 判据清单） |

零迁移、零新拒绝码（reported 复用 `belief_source_missing`/`belief_source_unqualified`，
14 码表冻结不动）。

## 2. 门判据（m9:invalidation:verify 五段，全部失败关闭）

- **§1 B-REPORTED reconciler**：合格 claim → 恰一条 FORMED(reported) 提案
  （beliefId = 依赖哈希复推）→ 放行口接受 → 信念携带 Memory 依赖 + 溯源根；
  白名单外（episode / observed / retracted）⇒ 零提案逐条 skip；同 Memory 重扫 ⇒
  reconciler 同值预检短路（s1-05）+ 同提案重交 ⇒ `duplicate_operation`（s1-05b，
  两层防线互为独立）；放行口负控四连：端口缺失 / Memory 不存在 / 白名单外 /
  beliefId 不可复推。
- **§2 依赖失效传播（Memory 撤回）**：撤回前 usable 前置 → `planMemoryInvalidation`
  恰一条 RETRACTED(dependency_invalidated，不禁根——B31 通道保留) → 放行口接受、
  信念 retracted（写侧收敛）→ 读侧回查同判失效（`memory_not_qualified`）→
  同轮 overlay：写侧修订**未跑**时读侧仍遮蔽（`overlaid`，零泄漏不依赖写侧成功）→
  回查存储错误 ⇒ `unavailable`（失败关闭）。
- **§3 qualified→unqualified（根失效）**：归因重读降档 ⇒ 读侧排除
  （`root_unqualified`）→ `planRootInvalidation` ⇒ RETRACTED + forbidden=[该根] →
  放行口接受 → **双层防御**：降档中再喂 ⇒ `belief_source_unqualified`（第一层，
  资格四条）；资格复评恢复（信封回来）后再喂 ⇒ `belief_roots_forbidden`
  （第二层——**禁用是事件流承诺，不随资格波动**）。
- **§4 显式遗忘/纠正/争议（B28/B29/B31）**：唯一目标遗忘 ⇒ forbidden=全部根（B28）；
  空禁用根的 forget 被放行口拒（B28 硬规则）；旧禁用根混新根的复活尝试 ⇒
  `belief_roots_forbidden`；新根新显式互动 ⇒ 新 belief identity 形成（B31）；
  同槽位两条 active ⇒ clarify 零提案（B29，调用方不得宣称已忘记）；争议登记
  两条 DISPUTED 全过（不猜谁对）；纠正规划 noop（旧侧全 disputed 时不抢跑）+
  显式 SUPERSEDED（disputed→superseded 合法迁移）+ proposals 路径全链
  （唯一 active 旧侧 ⇒ SUPERSEDED 提案过放行口）。
- **§5 恢复快照 + 重复回放（B30，隔离库）**：全生命周期落库（origin/3 notes/
  formed/forget-retract）→ 增量 apply 6 事件全折 → retracted 终态 + 禁用根在案 →
  全量 rebuild ⇒ **retracted 不复活 + 禁用根保留 + 零 active** → 同单元重放 ⇒
  幂等拦截（created=false）状态不被污染 → 读侧终态 usable 集合为空 →
  拒绝码表仍冻结 14 项。

## 3. 校准记录（门抓出的真问题，一轮）

**轮 1**（崩溃于 `c6d4884`，§1 s1-05；崩溃在写证据前，无 run 目录）：
s1-05 期望「同 Memory 重扫 ⇒ duplicate_operation」，但 reconciler 的
**同值 active 预检**先短路（skip `slot_same_value_active`，零提案）——
`formedProposals[0]` 为 undefined 崩在放行口。修正：两层去重各测各的——
s1-05 断言 reconciler 层 skip；s1-05b 绕过预检重交同一提案断言 validator 层
`duplicate_operation`。这不是缺陷是**设计确认**：reconciler 预检与幂等键
是互为独立的防线（预检挡「扫描窗口重入」，幂等键挡「提案重放」）。

另有一处**判据预演修正**（未产生 FAIL 证据，写门时自查发现）：
复活尝试夹具必须「beliefId 按 max root seq 复推 + 根集合与历史形成不同」，
否则先撞 `belief_id_not_derivable`（复推检查先于禁用根检查）或
`duplicate_operation`（同根同 id 同单元）——**到不了目标码的负控是假负控**。
§3 的双层防御（先资格后禁用）也是这么推出来的：降档根先撞资格四条，
恢复资格后才轮到禁用根承诺。

## 4. 设计要点（WP6/WP7 要用）

- **提案制**：reconciler/revision/eligibility 全部只产 PROPOSAL，唯一写路径仍是
  validator → appendDomainEvent → applyBeliefRows（WP4 冻结面）。产出者不持锁、
  不写投影、可独立重跑。
- **双保险（§7.1）**：写侧 = revision 规划 + 放行口 + 折叠；读侧 =
  `recheckBeliefDependencies` + overlay。写侧失败（提案被拒/调度未跑/落库失败）
  读侧仍遮蔽——**零泄漏不依赖写侧成功**。§2 s2-05 是这条的机器判据。
- **forget vs dependency_invalidated 的禁用根语义**（B28/B31 分层）：
  `user_forget_request` ⇒ forbidden = 该信念全部根（旧依据不得绕道复活，
  validator 硬规则强制非空）；`dependency_invalidated` ⇒ **不禁根**
  （Memory 撤回 ≠ 对话根作废；用户重新显式陈述 ⇒ 新 Memory ⇒ 新 identity，
  B31 通道保留）。空集合用 undefined 不用 []（结构校验拒空数组）。
- **reported 的确定性 identity**：`makeBeliefId(slot, fnv1a(sorted memoryIds))`
  ——同一 Memory 集合必同 id（幂等），不同 Memory 集合必不同 id（新事实新身份）。
  放行口复推（`belief_id_not_derivable`）。
- **clarify 不是失败**：歧义目标（0 或 >1 active）⇒ 规划器返回 clarify + 候选清单，
  **零提案**；调用方（WP7 NL 路由）不得对用户使用成功口吻（B29）。
- **overlay 是纯函数**：`(verdicts, beliefs, {invalidatedMemoryIds, invalidatedRootIds})`
  → 新 verdicts（`overlaid`）；同轮组合，不落库、不持久。
- **读侧回查纪律（§5.2）**：精确 id 批量读（不 Recall top-k）；`unavailable ≠ valid`
  （存储错误 ⇒ 全部不可用，失败关闭）；cutover 语义与放行口同源
  （origin 缺失 ⇒ cutoverSequence=null ⇒ 拒一切 inferred 根）。

## 5. 边界与不做清单

- WP5 交付**产出者与判据**，不接线运行时：调度器（belief-scheduler 双水位
  `belief-interaction-evaluator` + `belief-memory-reconciler`）、
  `CHARACTER_BELIEF_ENABLED` 开关、main.ts 装配 = **WP6**；
  上下文注入 + NL 路由（U-03 clarify 话术）= **WP7**；e2e B01–B48 = **WP8**。
- B-INFERRED 生产激活的前置（§5.4 + B28–B31 判据）本步已交付机器面；
  独立子开关在 WP8 装配时收口。
- 不动 Memory/Relationship/Affect 语义；Memory 事件只读消费。
- 真实库未打开（§5 全程 `isolateDatabase('m9-invalidation-verify', { keep: false })`）。
- 一次中间 run（`…-c6d488440b07-03fb`，39/39 但脚本含未提交修正、head 字段失真）
  已删除不入库——它不是任何提交树上的有效证据。

## 6. 提交链（本工作包）

```
c6d4884  feat(m9): WP5 belief lifecycle - reconciler, revision planners, eligibility recheck, invalidation gate
9c67cf3  fix(m9): WP5 gate s1-05 - reconciler same-value precheck short-circuits before idempotency
<本提交>  test(m9): WP5 evidence - invalidation 39/39 + verify 54/54 + source 26/26 re-runs + handoff
```

`m4.5:ci` 收口读数：**EXIT 0**（2026-09-27，`9c67cf3` 树上；G2 Component 135/0 ·
G12 Measurement 38/0 · L2 Pipeline 53/0 · G13 NL E2E 32/0 · G9 人工审计语料 12/0；
CI 重写过的六份历史证据文件已按白名单纪律还原，树净）。

## 7. WP6 输入清单

1. **双流调度**：`belief-interaction-evaluator`（WP3 评估器，消费对话事件）+
   `belief-memory-reconciler`（WP5 reconciler，消费 Memory 事件）——两个具名
   水位（`processor_watermarks`），互不阻塞；reconciler 的窗口重入安全
   （同值预检 + 幂等键双防线）已验证。
2. **失效传播接线**：Memory RETRACTED/SUPERSEDED/MERGED 事件 →
   `planMemoryInvalidation` → 放行口；读侧 `recheckBeliefDependencies` +
   overlay 接进上下文组装（WP7）。
3. `CHARACTER_BELIEF_ENABLED` 开关（缺省 off）+ main.ts 装配 +
   `m9:runtime:verify` 门。
