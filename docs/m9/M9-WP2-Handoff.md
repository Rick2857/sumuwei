# M9 WP2 交接单 —— 合同层 + 判据冻结 + 量具（2026-09-27）

> 状态：**DONE**（量测门 MEASUREMENT VALID 20/20 · L1 部件门 20/0）
> 上游：[ADR-070](../adr/ADR-070-belief-perspective-and-revision.md)（设计冻结）·
> [M9-Acceptance-Contract.md](M9-Acceptance-Contract.md)（验收契约）·
> [M9-Unresolved-Decisions.md](M9-Unresolved-Decisions.md)（未决项）
> 下游：WP3（评估器 + 域事件产出者 + afterSequence 增量读）

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/contracts/belief.ts` | 合同层：`PerspectiveOwnerId`（复用 M3.5 entity.ts 预留）、槽位键（value 不进键，D03）、`makeBeliefId`（确定性 + 修订可区分，INV-M9-11）、B-REPORTED 白名单（引用 `CLAIM_MEMORY_TYPES`，单一语义源）、B-INFERRED 冻结槽位与阈值（3 根 / 2 会话 / 50 窗口）、七个事件 payload 契约 + 结构校验器（失败关闭） |
| `src/kernel/contracts/ids.ts` | 点追加 `BeliefId`（branded；修订 = 新 id，不抹历史） |
| `src/kernel/contracts/domain-event.ts` | `createBeliefDomainEventRegistry()`：七事件登记（**只登记不接线**——WP4 起接入 `createFullDomainEventRegistry()`，M7/M8 可审计分步同构）；INV-M9-07 由 `DomainEvent.scope` 字面量类型结构性继承 |
| `src/kernel/contracts/index.ts` | barrel 导出 belief.ts |
| `scripts/future-compat-tests.ts` | **FC-T05 阶段锁正式交接**：存在锁 → 语义边界断言（ADR-070 §9 承接判据：七事件登记齐 / 缺 owner 失败关闭 / 白名单正负控 / 取值闭集逐字 / id 幂等与修订可区分）；perspectiveOwner 区分测试保留（永久前提） |
| `evals/fixtures/m9/belief-rule-corpus.json` | 冻结语料：inferred 41 条（detailed 10 正 / concise 10 正 / 近邻负控 20：单次任务·提问·引用·假设·代述·条件·命令式注入）+ reported 11 条（白名单结构边界，双向） |
| `evals/fixtures/m9/belief-oracle.ts` | **独立 oracle**：从 ADR-070 §4.2 状态表逐条手写的预期折叠（零 import、零共享代码；独立性由 m9:test 静态断言机器可判）；含 §5.4 遗忘契约判据（`oracleRootsForbidden` / `oracleReopenIsLegal`） |
| `scripts/m9-test.ts` | L1 部件门（`m9:test`）：① 合同（7 校验器合法过/篡改抛）② 纯规则（白名单对语料逐条、阈值边界两侧、槽位键语义、id 确定性）③ 状态机（oracle 对手写预期，6 组）④ 静态边界（oracle 独立性 = 零 import、语料完整性 + measured_count 双向 > 0） |
| `scripts/m9-measurement-verify.ts` | L0 量具门（`m9:measurement:verify`）：四检测器 × 三段式（正控/负控/恢复）20 项；证据落 `artifacts/m9/<runId>/`（m9-manifest@1 全字段） |
| `package.json` | 点追加 `m9:test` / `m9:measurement:verify` |

## 2. 门读数（全部机器读数）

| 门 | 读数 | 证据归属 |
|---|---|---|
| `pnpm typecheck` | EXIT 0 | `013f51b` 与 `19f61a1` 各跑一次 |
| `pnpm m3.5:test` | **30/0**（FC-T05 替换后） | `013f51b` |
| `pnpm kernel:test` | **26/0**（belief.ts 过依赖方向静态锁） | `013f51b` |
| `pnpm kernel:verify` | **25/0**（Phase C） | `013f51b` |
| `pnpm m9:test` | **20/0** | `19f61a1`（校准后） |
| `pnpm m9:measurement:verify` | **MEASUREMENT VALID 20/20** | runId `m9-wp2-measurement-20260927-19f61a15af51-96c2`（head `19f61a1`），证据提交 `58dbb31` |

## 3. 量具校准记录（第一轮，3 个夹具缺陷——由门自己发现）

1. **空数组 vs 省略**：`BELIEF_FORMED` 夹具给了 `dependsOnMemoryIds: []`，校验器按设计拒（"空集合用 undefined，不用 []"）。夹具改为省略字段。
2. **闭集内值当负控**：`epistemicKind: 'reported'` 是合法值——"inferred 不许自报提升"是 WP4 Validator 的业务规则，结构层只守闭集。负控改注入 `'asserted'`。
3. **全文扫描误报**：oracle 独立性探测器扫全文，把"说明自己为何独立"的注释（提到生产文件路径）误判成违规。改为只扫 import/require 行（独立性 = 无 import 依赖，不是不许提及）。
4. **`undefined` 不删键**：量测门缺字段负控用 `{ ..., headShort: undefined }` 注入，`field in manifest` 对值为 undefined 的键仍为 true ⇒ 缺字段检测器没被测到。改为 destructure 真删键。
5. **两次无效 run 已删除**：`…-9187`（FAIL 19/20）与 `…-28c8`（PASS 20/20）都产自未提交树（head 归因失真），**从未成为有效证据**，已删除并在校准提交 `19f61a1` 里记录。有效证据只有 `…-96c2`。

## 4. WP3 输入（下一步的起点）

- **合同已冻结**：评估器产出 BELIEF_EVIDENCE_NOTED / BELIEF_FORMED 提案时，payload 形状以 `contracts/belief.ts` 校验器为准（结构层），业务资格（证据资格 / cutover / 槽位冲突 / forbiddenRootIds）在 WP4 `policies/belief-validator.ts`。
- **语料即判据**：B-INFERRED 规则（WP3 实现）必须做到 inferred 语料**正控召回 100% · 近邻负控误触发 0%**（验收契约 §2）；规则实现建议冻结词形 + 长期倾向标记（以后/每次/别再）+ 单次指涉守卫（这题/这次/这里）——语料 note 字段已标注各条的设计意图。
- **登记表未接线**：`createBeliefDomainEventRegistry()` 存在但**未**进 `createFullDomainEventRegistry()`——WP4 落地 Reducer/Validator 后接线（判据在 WP4 证据里翻转，M7/M8 同序）。
- **oracle 待三方比对**：WP4 的 reducer 测试把 m9-test ③ 组的同一批事件序列再喂生产 reducer，oracle / 手写预期 / 生产折叠三方一致。
- **afterSequence 增量读**（计划 §8.3 变更流缺口）：WP3 在 `domainEventsFor` 上加 afterSequence 附加读——**只追加**，不改既有读语义。

## 5. 边界（WP2 没做什么）

- 没有任何 store / 评估器 / 协调器 / 调度器 / Context 接线（WP3–WP7）。
- 没加 `CHARACTER_BELIEF_ENABLED` 开关（WP6/WP8；默认 off 的回归锁届时建）。
- 没动 M4 Memory 冻结区（belief.ts 只**读** `CLAIM_MEMORY_TYPES`，不写 memory.ts）。
- 没把 BELIEF_* 接进全量登记表（WP4）。
- 语料主张的是**冻结清单上的精度**，不主张真实世界分布精度（m7 语料同款边界）。

## 6. 提交链（本 WP）

```
013f51b  feat(m9): WP2 belief contract layer + BELIEF_* registration + FC-T05 succession
6d641c4  test(m9): WP2 gauge assets - corpus + oracle + m9:test / m9:measurement:verify
19f61a1  test(m9): WP2 gauge calibration round 1 (3 fixture defects, gates found them)
58dbb31  test(m9): WP2 measurement gate evidence - MEASUREMENT VALID 20/20
```
