# WP9-B1 Handoff —— State Event Attribution Contract + `MIGRATION_0009` Physical Landing

**判定：`WP9-B1 = PASS`** · **`WP9-GAP-1 = OPEN`** · **`WP9 = PARTIAL / BLOCKED`（不变）**
**`WP9-B2 = READY / AUTHORIZED`** · **`WP9-C = NOT READY`** · **`WP10 = NOT AUTHORIZED`**

日期：2026-09-18 · 上游：`WP9-A = PASS` · `WP9-B0 = BLOCKED BY PRODUCT CAPABILITY DECISION`
执行令：用户裁定 **R-45 = SELECTED B**（授权新增 `MIGRATION_0009`）+ **R-46**（收尾顺序与门纪律）

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `src/kernel/contracts/attribution.ts`（+58：第 10 个族 `state_transition` + 冻结 necessity 行 + `STATE_TRANSITION_SYSTEM_ORIGIN_RULE` + `BACKFILL_CONTRACT_DEFERRED_FAMILIES` 5→6）· `src/infrastructure/persistence/migrations.ts`（+91：`v9StateEventAttributionColumnStatements()` + `MIGRATION_0009` + `MIGRATIONS` 追加）· `src/state/repository.ts`（+157/−4：可选 `TrustedAttribution` + `attributionCell()` + `stateEventAttributionOfRow()` + `readStateEventAttribution()` + `recordStateEvent` 返回 `{id}`）· **21 个 verifier 脚本**的 current-schema 判据（见 F4 §3）· `scripts/verify-m5.1.1-wp9b1-verify.ts`（**新增**专项门）· `scripts/m5.1.1-attribution-gate-registry.ts`（`prodcopy.evidence` fork + `NON_VERIFIER_SCRIPTS` +1）· `package.json`（`m5.1.1:wp9b1:verify`）· 文档三份（F4 / 本 handoff / 执行计划 R-45 + R-46）· 证据四份 + `wp9b-e4-selection.json` 的有意重写 |
| **Tests Run** | 提交前（子代理，串行）：`typecheck` · `wp9b1:verify` · `migration:verify` · `prod-copy:verify` · `wp9b:selection:verify` · `k20` · `k29` · `wp9a` · `wp5` · `wp5.1` · `wp6.1` · `wp8c1` · `wp8c2` · `m5.1:measurement` · `m5.1.1:test` · `wp4` · `wp3.2` · `wp4.1` · `wp6` · `wp7` · `wp3` · `k16` · `k17` · `k19` · `k25` · `wp7:preflight` · `wp8:verify`。**提交后**（本执行，按 R-46 §7 串行）：见 §9 |
| **Tests Passed** | 提交前：`typecheck` 0 · **`wp9b1:verify` 56/0**（新门）· `migration:verify` **117/0**（v9 指纹已锁）· `prod-copy:verify` **36/0**（副本 v6→v9，`applied=[7,8,9]`）· `wp9b:selection:verify` 0（`SUPERSEDED_BY_R45_PRODUCT_DECISION`）· 其余 20 余门 0。**提交后**（R-46 §7 串行）：`typecheck` 0 · `wp9b1` 0 · `migration` 0 · `prod-copy` 0 · `k17` 0 · **`wp8:verify` 0（53/0 · `WP8-B = PASS`）** · **`wp8c3:verify` 0（40/0 · `WP8-C3 = PASS`）** · `gates` 0 · `wp8c1` 0 · `wp8c2` 0 · `k29` 0 · `wp9a` 0 · `m5.1:measurement` 0 · `wp9:verify` 观察值 **40/0 · `PARTIAL / BLOCKED`（EXIT=1，既定判定）** |
| **Tests Failed** | 提交前 **1 条**（`wp8:verify` 52/1，唯一红 = §0 工作区清洁度，因 `migrations.ts` 未提交；**提交后已自行转绿为 53/0**）· `wp7:preflight` EXIT=1（**既有**历史 scope 条，非本 WP 回归，按 R-46 §9 不改）。提交后**第一次** `wp8c3:verify` EXIT=1（2 条红：① 执行顺序产物 ② **判据缺陷**，已修正 ⇒ 单独重跑 40/0 PASS）；`wp9:verify` 第一次 EXIT=2（`WP9-16` 顺序耦合，还原后 40/0 EXIT=1 既定判定）。**全部归属完毕，无未解释的红。** |
| **Evidence Produced** | `artifacts/m5.1.1/wp9b1-schema.json`（DDL / 列与约束清单 / 指纹读数 / 契约读数 / 12 个量具全 `valid`）· `wp9b1-roundtrip.json`（隔离库 round-trip + 六类负控 + 不回填）· `wp9b1-production-copy-v9.json`（**副本**上的 v6→v7→v8→v9，`verdict = PASS`，36/0）· `wp9b1-gate-exits.txt`（每道门的退出码）· F4：`docs/m5.1.1/M5.1.1-WP9B1-Compatible-Assertion-Record.md` · 执行计划 R-45 / R-46 |
| **Known Issues** | ① **`src/state/init.ts` 未接线** ⇒ 今天生产里**仍然没有任何一条** `state_events` 带信封；`E4-A = still unreachable`（这是 B1 的**边界**，不是缺陷；B2 的活）。② `wp7:preflight` 的 `AT-W7-0 scope` 条仍红 —— **既有状态**（列出的文件包含 WP9-A / 更早 WP 已提交的改动），按 R-46 §9 只登记为 `inherited / pending independent confirmation`，**不写成 confirmed harmless**。③ C4 文本误报（`MIGRATION_0009` 注释里的"系统自行发起"）**有意不修**，登记为 `historical false loud / superseded detector observation`（R-46 裁定）。④ `wp9:verify` 只做**观察**（R-46 §7），不作为 B1 成功判据；其 `WP9-16` 红是已登记的顺序耦合。⑤ **执行顺序纪律**：`wp8c3:verify` 的 C3-0 要求运行前工作区干净 ⇒ 必须单独跑、不能排在 `wp8:verify` / `m5.1:measurement:verify` 之后。⑥ **本 WP 唯一一处判据缺陷已修正并记录**（G14：用历史证据文件的读数断言当前代码边界）—— 同类缺陷已全仓排查，只有这一处。 |
| **Architecture Deviations** | **无**。没有新 ADR（R-45 是产品能力裁定，不是架构变更）；没有改 `MIGRATION_0007` / `MIGRATION_0008`（指纹逐字未变）；没有改 Fact Firewall / MemoryAuthority / extractor / Recall 资格判据；`state_transition` **不进** Cognitive Axis B；**没有**把 `state_transition` 塞进 `CONVERSATION_BACKFILL_CLASSIFICATION`；真实库未打开；冻结面 `artifacts/m5.1/**` 与 `artifacts/m4.5/**` 最终无差异。 |
| **Commit Hash** | `a1f62f0` — `docs(m5.1.1): record WP9-B1 F4 compatibility record and R-45/R-46 rulings`（**Commit 0**，先于判据变更）· `6668e59` — `feat(m5.1.1): add state_transition family and MIGRATION_0009 state_events attribution carrier` · `521f750` — `feat(m5.1.1): add trusted state-event attribution persistence and readback` · `316d709` — `test(m5.1.1): advance verifier schema expectations to v9 and register WP9-B1 gate` · `73eb186` — `test(m5.1.1): record WP9-B1 schema, round-trip and production-copy evidence` · 本 handoff 与 G14 判据修正所在 docs 提交紧随其后 |

---

## 1. 本 WP 只做一件事

R-45 = SELECTED B 之后，用户的执行令是：

> **下一次只做 `WP9-B1 — State Event Attribution Contract + v9 Physical Landing`**
> 目标：`Design Freeze → additive MIGRATION_0009 → schema/checks → store read/write capability
> → production-copy verification → STOP`
> **暂时不要接 `state/init.ts` 生产 producer。**

本 WP 就只做这件事：**给 `state_events` 造好诚实的 contract + physical representation**。

---

## 2. 冻结的矩阵行（唯一新族）

族名：**`state_transition`**（**语义名**，刻意与表名 `state_events` 不同；
族名**永远不是** SYSTEM 的推导来源）。

位置：`src/kernel/contracts/attribution.ts` 的 `NECESSITY_MATRIX.state_transition`，逐字：

```text
row('REQUIRED','REQUIRED','ABSENT','REQUIRED','REQUIRED','ABSENT')
⇒ initiator=REQUIRED · actor=REQUIRED · executor=ABSENT · authority=REQUIRED ·
  recordedBy=REQUIRED · contentOriginator=ABSENT · subject=DERIVED（`row()` 固定）
```

同步改动：

- `AttributionEventFamily` 加 `| 'state_transition'`；`ATTRIBUTION_EVENT_FAMILIES` **9 → 10**
- `BACKFILL_CONTRACT_DEFERRED_FAMILIES` **5 → 6**（加 `state_transition`，
  **不**进 `CONVERSATION_BACKFILL_CLASSIFICATION`）
- **没有**进 `COGNITIVE_AXIS_B_FAMILIES`（`isCognitiveAxisBApplicable()` 仍为 `false`）
- `SOURCE_KIND_BY_EVENT_FAMILY` 未动
- 新增成文常量 `STATE_TRANSITION_SYSTEM_ORIGIN_RULE`：`Known(SYSTEM/<component>)`
  只能来自组件的**受信身份**，逐条点名禁止 `trigger` / 族名 / payload / `actor_type` /
  `requestedBy` / transport
- `SYSTEM_RULE/state-bootstrap-rule` **只出现在门的测试信封里**，**没有**冻结成生产常量（留给 B2）

---

## 3. `MIGRATION_0009`

```text
name       = 'm5.1.1-state-events-attribution'
statements = 38
sha256     = 5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c
```

**纯追加**、**只碰 `state_events`**、**无 Axis B**、**无索引**、**无数据语句**。

① 19 条 `alter table state_events add column if not exists <c> text`
= `initiator_kind/initiator_id/initiator_unknown_reason` · `actor_kind/actor_ref_id/actor_unknown_reason` ·
`executor_kind/executor_id/executor_unknown_reason` · `recorded_by_kind/recorded_by_id/recorded_by_unknown_reason` ·
`content_originator_kind/content_originator_id/content_originator_unknown_reason` ·
`authority_kind/authority_ref/authority_unknown_reason` · `attribution_origin`
（列名由新私有生成器 `v9StateEventAttributionColumnStatements()` 从**同一个**
`ATTRIBUTION_PHYSICAL_SLOTS` 产出；刻意**不**复用 `v7AttributionColumnStatements`
（它会多出 Axis B 三列）。）

② 18 条槽位 CHECK：`...v7AttributionCheckStatements('state_events', { axisB: false })`

③ 1 条手写 origin 词表（与 v7 的 axisB 分支逐字同形，复用模块私有字面量 `ATTRIBUTION_ORIGIN_VALUES`）：

```text
alter table state_events add constraint state_events_attribution_origin_vocab
  check (attribution_origin is null or attribution_origin in ('RECORDED','MIGRATED_LEGACY'))
```

`MIGRATIONS` 追加 `MIGRATION_0009`（最新 schema = **9**）。

**指纹（完整，不用缩写）**：

```text
MIGRATION_0007 = 2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613   （immutable）
MIGRATION_0008 = 0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29   （immutable）
MIGRATION_0009 = 5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c   （B1 PASS ⇒ FROZEN）
```

**B1 PASS 后 v9 指纹 → FROZEN**；B2 **不得**再修改 v9，需要物理修正就 **v10**。

---

## 4. `state_events` 列清单（v9 之后 = 30 列）

```text
id, character_id, user_id, before_state, delta, after_state, reason, trigger,
state_version, message_id, created_at,
initiator_kind, initiator_id, initiator_unknown_reason,
actor_kind, actor_ref_id, actor_unknown_reason,
executor_kind, executor_id, executor_unknown_reason,
recorded_by_kind, recorded_by_id, recorded_by_unknown_reason,
content_originator_kind, content_originator_id, content_originator_unknown_reason,
authority_kind, authority_ref, authority_unknown_reason,
attribution_origin
```

- **CHECK = 19 条**（6×`tri_state` + 6×`kind_vocab` + 6×`reason_vocab` + `attribution_origin_vocab`）；**无** `axis_b_*`
- **索引 = 恰好 `state_events_pkey` + `state_events_lookup`**（v9 未建任何索引；
  wp6/wp61 的"全库归因索引恰好 1 个"仍绿）
- 生产副本实测：`state_events` 共 **1 行**（首启那条 `trigger='init'`），
  apply v9 后 `attribution_origin` 非空 = **0**

---

## 5. 写 / 读能力（`src/state/repository.ts`）

- `StateEventInput.attribution?: TrustedAttribution`（**可选**）：
  **不传** ⇒ 19 列全 NULL、`attribution_origin` NULL、读回 `undefined`（"从未记录过归因"）；
  **传了但没有** `TRUSTED_INGRESS_MARK` ⇒ **失败关闭**抛 `untrusted_state_event_attribution`。
- 私有 `attributionCell()` 是**第三份**镜像实现（`conversation-store.ts:401` /
  `action-ledger-store.ts:99`），按要求**不**导出共享工具，注释写明这是刻意的重复；
  列名与值从 `ATTRIBUTION_SLOT_COLUMNS` 的**同一份** entries 同序展开。
- `recordStateEvent()` 现在返回 `{ id }`（原有 3 个调用点忽略返回值，零影响）。
- 读回：`stateEventAttributionOfRow(row)`（转调 canonical `storedAttributionOfRow`，表无关）+
  `readStateEventAttribution(runtime, id) → { found, attribution }`
  （**不**把"行不存在"与"没有归因"折叠成一个 `undefined`）。
- **未接线 `src/state/init.ts`**（B2）；今天生产里仍没有任何一条 `state_events` 带信封。

---

## 6. `subject` / `actor` 的显式陈述（本 WP 唯一一处语义判断）

- `subject = CHARACTER/<characterId>`，与对话 / 行动信封同一条派生规则（U-13：派生语义、不落列）。
  **`user_id` 刻意不进 `subject`**：它是**关系维度**（`character_states` 的主键第二列、
  `state_events` 的 not-null 列），留在行上而不是信封里；`PrincipalRef` 只有 `{kind,id}` 一个位次，
  把 user 塞进去会制造第二个位次概念。
- `actor = REQUIRED`：今天 `src/state/**` **没有**决定者 / 施加者分离
  （`initCharacterState` 在一个函数里决定 + 施加 + 记账），所以 `executor = ABSENT` 是**结论**
  而不是占位；B2 必须从**受信组件证据**提供 actor，B1 不解析这个分裂。

---

## 7. round-trip 读数（隔离库，`artifacts/m5.1.1/wp9b1-roundtrip.json`）

- **带信封**（RECORDED）：`initiator = KNOWN|SYSTEM|state-bootstrap` ·
  `actor = KNOWN|SYSTEM|state-bootstrap` · `executor = ABSENT` ·
  `authority = KNOWN|SYSTEM_RULE|state-bootstrap-rule` · `recordedBy = KNOWN|SYSTEM|kernel` ·
  `contentOriginator = ABSENT`（逐格 == 写入值，SYSTEM 未被折叠）。
- **非塌缩**：同一行 `actor = UNKNOWN|RUNTIME_UNRESOLVED`、`executor = ABSENT`，两者各自逐字还原。
- **不带信封**：`found = true, attribution = undefined`，19 个归因列**全 NULL**。
- 行级读取器与按 id 回读 JSON **完全相同**（没有第二个解码器）。

---

## 8. 六类负控（全部实测）

(a) **DB 拒绝**：半填（`kind` 有 / `id` 无 / `reason` 无）· 只给 `id` · `kind='HACKER'` ·
`attribution_origin='WHATEVER'` —— 四探针全 **REJECT**；
**正控**：合法三元组 + `origin='RECORDED'` **可入账**（不是"全都拒绝"）。

(b) `trigger='init'` 且不给信封 ⇒ `attribution = undefined`、19 列全 NULL（**不推断** SYSTEM）。

(c) 手写 `SYSTEM/attacker-controlled` 信封 ⇒ `untrusted_state_event_attribution`，
且**行数 5→5（无残留）**；受信构造器另两道：`callerSuppliedFields:['actor','authority']` 与
`untrustedDto:{contentOriginator}` ⇒ 均 `untrusted_attribution_field`；
**恢复**：真实受信信封仍可落库并解码。

(d) **读取器负控**：坏 origin ⇒ `attribution_origin_invalid`；半填形状 ⇒ `attribution_slot_shape_invalid`；
词表越界 ⇒ `attribution_slot_value_invalid`；放回真实行 ⇒ **重新安静**。

(e) **判据双向**：REQUIRED 的 initiator 写 Absent ⇒ `required_slot_absent`；
executor / contentOriginator 被填 ⇒ 两条 `absent_slot_filled_concrete`；
`assertAttributionNecessity` ⇒ 抛 `attribution_necessity_violation`。

(f) **不回填**（v8→v9 真迁移，在隔离库上）：回退到 v8、插入 11 列的 `trigger='init'` 旧行、
apply v9（`from 8 → to 9, applied=[9]`）⇒ 该行 11 个原列**逐字段未变**、
读回 `attribution = undefined`、全表 `attribution_origin` 非空 = **0/6 行**、总行数 **6→6**。

真实库副本（prod-copy）侧独立复核：`state_events` 共 **1 行**（首启那条 `trigger=init`），
apply v9 后 origin 非空 = **0**。

> **B1 强制的一半 = 受信标记 + 必要性矩阵 + 矩阵/读取器 fail-closed；
> 另一半（把组件身份装进受信证据并在生产调用点接线）= B2。**

---

## 9. 提交后串行重跑（R-46 §7 / §8）—— 实测读数

> 口径：`cmd /c "pnpm <script> > <log> 2>&1"` + `$LASTEXITCODE`，**串行**，
> 任何时刻只有一个 pnpm 门进程。提交后工作树干净（`git status --porcelain` 为空）。

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | |
| 2 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败（12 个量具全 `valid`） |
| 3 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败（v9 指纹已锁） |
| 4 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败（副本 v6→v9，`applied=[7,8,9]`） |
| 5 | `pnpm m5.1.1:k17:verify` | **0** | |
| 6 | **`pnpm m5.1.1:wp8:verify`** | **0** | **53 通过 / 0 失败 · `WP8-B = PASS`** ⇒ R-46 §8 的 Hard Gate **真实通过**（提交前那条 49/1 的"工作区清洁度"红已自行转绿） |
| 7 | **`pnpm m5.1.1:wp8c3:verify`** | **0** | **40 通过 / 0 失败 · `WP8-C3 = PASS` ⇒ `WP8 = PASS`**（**修正 G14 判据后**，从干净树单独跑；见下） |
| 8 | `pnpm m5.1.1:gates` | **0** | 九门 `G1–G7 PASS · G8 = NOT RUN · G9 PASS`；"全部可判定的门 = PASS" |
| 9 | `pnpm m5.1.1:wp8c1:verify` | **0** | |
| 10 | `pnpm m5.1.1:wp8c2:verify` | **0** | |
| 11 | `pnpm m5.1.1:k29:verify` | **0** | |
| 12 | `pnpm m5.1.1:wp9a:verify` | **0** | |
| 13 | `pnpm m5.1:measurement:verify` | **0** | |
| 14 | `pnpm m5.1.1:wp9:verify` | **1** | **只做观察**（R-46 §7）：**40 通过 / 0 失败 · `WP9 = PARTIAL / BLOCKED`** —— 正是预期；**没有新的 scenario failure** |

**第一次跑时 `wp8c3` 报 EXIT=1（2 条红），两条都已归属、都不是产品缺陷**：

1. **`C3-0：git 工作区干净`** —— runner 在 `wp8c3` 之前先跑了 `wp8:verify`，而后者会重新生成
   自己的 `wp8-*.json` 并**故意不还原**（它们是本门的输出）⇒ **执行顺序产物**。
   处置：从干净树**单独**跑 `wp8c3`。
2. **`C3-0：schema = v9`** —— **这是判据缺陷**（本 WP 唯一一处）：`wp8c3` 读的是**历史证据文件**
   `wp6.1-conversation-ingress.json`（= v8），却断言 9。
   处置：拆成"历史证据仍 = v8" + "当前代码 = 9（从 `latestSchemaVersion()` 读源码）"两条
   ⇒ **修正后更强，不是放宽**。同类缺陷已全仓排查，**只有这一处**踩坑。

**`wp9:verify` 第一次 EXIT=2 也已归属**：唯一红是 `WP9-16`（`artifacts/m5.1/measurement-negative-controls.json`
被 `m5.1:measurement:verify` 重写）—— WP9-A F4 §6.2 已登记的**顺序耦合**。按 C1 从 `m5.1-complete`
标签还原该路径后重跑 ⇒ **40/0 · `PARTIAL / BLOCKED`（EXIT=1）**。

**执行顺序纪律（本轮实测教训）**：`wp8c3:verify` 的 C3-0 要求"运行前工作区干净" ⇒ 必须**单独**跑，
且**不能**排在 `wp8:verify` / `m5.1:measurement:verify` 之后（那两个门会留下自己的输出）。
若必须串行：`wp8c3`（干净树）→ `wp8` → `gates` → 其余。

### 9.1 第三次重跑：`k29-exits.json` 未声明写入面（**已修复**，G21）

**现象**：第二次的 `wp8:verify` 报 **EXIT 1 · 52/1**，唯一红是
`❌ 没有预料之外的**门写入**面 … [artifacts/m5.1.1/k29-exits.json]` —— 与第一次的 `53/0`
**在同一棵干净树上不一致**。

**归属（决定性实验，全部实测）**：

| 实验 | 读数 | 结论 |
|---|---|---|
| `git hash-object` vs `HEAD:` | 两侧均 `a9f0037f723065ad8f0d0bfc2672082378f6d000` | 内容**逐字节相同** |
| `git diff --exit-code -- <path>` | **0** | 无内容差异 |
| 单独跑 `k29:verify` × 5 | 每次 hash 相同、`status` 为空 | 内容**不随运行变化** |
| 删除文件 → 跑 `k29:verify` | 文件被**重新创建**，blob 与 HEAD 一致 | 它**确实是** k29 门的输出 |
| `git log -S 'k29-exits' -- <registry>` | **全历史为空** | 注册表**从未**声明过它 |
| 仓库全部 `*-exits.json` | 只有它一个，且**未声明** | 孤例，非普遍惯例 |

⇒ **两条独立事实**：① `k29-exits.json` 是 k29 门的真实写入面，且**长期未被登记**
（`9c7bff7` 起进 git，既有遗漏，**非本 WP 引入**）；② 该检查的"新出现"判据依赖
**git index stat 缓存时序** ⇒ 同一棵树会出现 53/0 与 52/1 两种读数，
**摆动的是 git 的脏标记，不是文件内容**。

**处置**：补登记 `k29.evidence`（F4 **G21**）。**检测器一字未改** —— 这是**如实登记**，不是改判据。

**第三次实测读数**（`f2514b1` 之后，从干净树按 `wp8c3 → wp8 → gates → 其余` 顺序，**全部实跑**）：

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | **`pnpm m5.1.1:wp8c3:verify`**（干净树，单独跑） | **0** | **40 通过 / 0 失败 · `WP8-C3 = PASS` ⇒ `WP8 = PASS`** |
| 2 | **`pnpm m5.1.1:wp8:verify`** | **0** | **53 通过 / 0 失败 · `WP8-B = PASS`**；被门重写 **36** 条（35 → 36）· 未声明 **0** 条 · 残留 **0** 条 |
| 3 | `pnpm m5.1.1:gates` | **0** | 九门 `G1–G7 PASS · G8 = NOT RUN · G9 PASS` |
| 4 | `pnpm typecheck` | **0** | |
| 5 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败 |
| 6 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败 |
| 7 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败（副本 v6 → v9） |
| 8 | `pnpm m5.1.1:k17:verify` | **0** | 15 通过 / 0 失败 |
| 9 | `pnpm m5.1.1:wp8c1:verify` | **0** | 15 通过 / 0 失败 · `K-32 = PASS` |
| 10 | `pnpm m5.1.1:wp8c2:verify` | **0** | 25 通过 / 0 失败 · `K-33 = PASS` |
| 11 | `pnpm m5.1.1:k29:verify` | **0** | 41 通过 / 0 失败 |
| 12 | `pnpm m5.1.1:wp9a:verify` | **0** | 31 通过 / 0 失败 · `WP9-A = PASS` |
| 13 | `pnpm m5.1:measurement:verify` | **0** | 16 通过 / 0 失败 |
| 14 | `pnpm m5.1.1:wp9:verify`（**只做观察**） | **1** | **40 通过 / 0 失败 · `WP9 = PARTIAL / BLOCKED`** —— 正是预期；`WP9-16` = ✅；**没有新的 scenario failure** |

> **两道 Hard Gate（`wp8c3` / `wp8`）均真实 EXIT = 0** ⇒ R-46 §8 的硬要求成立。
> **`wp8:verify` 的 EXIT 0 现在是可复现的**：修复前取决于 git stat 时序（53/0 或 52/1），
> 修复后未声明写入面恒为 0，该摆动源已消除。

**收尾核对**：冻结面 `artifacts/m5.1/**` 与 `artifacts/m4.5/**` **干净**；
真实库 `data/pglite` 三项一致（**1201 文件 · 31289946 字节 · mtime `2026-09-17T23:51:40.7898589+08:00`**）；
历史证据已**逐路径**还原，工作树 `git status --porcelain` 为空。

---

## Next WP Preconditions

**下一个 WP 只能是 `WP9-B2 — Production State Bootstrap Attestation`**（用户已排定：
`WP9-B1 → WP9-B2 → WP9-C → WP9 PASS → WP10`）。
**不得**在同一次 execution 里开始它；**不得**跳过 C 直接宣布 `WP9 = PASS`。

进入 WP9-B2 前必须成立：

1. 本 WP 的账已结清：§9 全部 EXIT=0（含 `wp8:verify` 与 `wp8c3:verify` 两道 Hard Gate），
   `wp9:verify` 观察值仍为 `PARTIAL / BLOCKED` 且**没有新的 scenario failure**。
2. `MIGRATION_0009` 指纹已 **FROZEN**（`5a007003…`）；B2 **不得**修改 v9。
3. B2 只做一件事：在 `src/state/init.ts` 用**组件自己的受信身份**构造 `state_transition` 信封
   （actor / initiator 来自受信证据；`executor` 恒 `Absent`；
   `authority = SYSTEM_RULE/<state-bootstrap-rule>` 待冻结 ref；`recordedBy = SYSTEM/kernel`），
   并把它传给 `recordStateEvent(runtime, { ..., attribution })` —— B1 的边界已就位且被负控证明。
4. B2 必须同时证明两条形态：**E4-A**（真实首启 + 有受信 SYSTEM 证据 ⇒
   `initiator = Known(SYSTEM/<component>)`）与 **E4-B**（没有受信因果证据 ⇒
   `Unknown(RUNTIME_UNRESOLVED)`），并做三个核心负控：
   删 SYSTEM attestation ⇒ Known SYSTEM 消失 / 只保留 `trigger='init'` ⇒ 不得因此得到 Known SYSTEM /
   调用方自报 `SYSTEM/<id>` ⇒ 不得进入权威槽位。
5. L1 / L2 用**真实 `state_event` id**（或现有稳定键）关联，而不是文本对应。
6. 纪律照旧：一个进程一个沙箱库（`isolateDatabase` + `resetPluginSqlConnection`）、
   生产入口优先、计数型判据自检 `measured_count > 0`、正控/负控/恢复三段式、
   **不要并发跑门**、冻结面只从 `m5.1-complete` 还原、绝不 `git add -A`、
   还原历史证据只按**白名单逐路径**（AGENTS §7）。

**仍未授权 / 未关闭**：`WP9-GAP-1 / E4-A = OPEN` · `WP9-C = NOT READY` ·
`K-31 = OPEN / DEFERRED / NON-BLOCKING` · `ADR-043 = NOT APPROVED` · `Phase 4 = BLOCKED` ·
`WP10`（production-copy migration）= **NOT AUTHORIZED** · `M5.1-D01` 未关闭 ·
`wp7:preflight` 的历史 scope 条 = `inherited / pending independent confirmation`。
