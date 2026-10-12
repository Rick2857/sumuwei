# WP10-B Handoff —— Production-Copy Migration

**判定：`WP10-B = PASS`**（EXIT 0 · 24 通过 / 0 失败 · 四项 canonical 验证全过）
**`WP10-A = COMPLETE`** · **`WP9 = PASS`** · **`WP8 = PASS`** · **`WP10-C/D = NOT STARTED`**

日期：2026-09-19 · 上游：`WP10-A = COMPLETE`（R-49 授权）
执行令：**用户 WP10-B** —— "Verify the current frozen migration chain against a **fresh copy** of the
real production DB. **Do WP10-B only.** Do not start WP10-C or WP10-D."

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `scripts/verify-m5.1.1-wp10b-production-copy.ts`（**新增** production-copy 迁移门）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` **+1 条分类**，附理由）· `package.json`（`+ "m5.1.1:wp10b:verify"`）· `docs/m5.1.1/WP10B-Handoff.md`（本文件）· 证据 `artifacts/m5.1.1/wp10-production-copy.json`（canonical 冻结名）+ `wp10b-gate-exits.txt`。**`src/**` 零改动**；**真实库零迁移**（只被 cpSync 复制） |
| **Tests Run** | 提交前：`typecheck` · `wp10b:verify`（新门，内部跑五个 canonical 步骤的门）。**提交后**：`typecheck` → **`wp8c3:verify`**（干净树、最先单独跑）→ **`wp8:verify`** → `gates` → **`wp10b:verify`** → `wp9c0` / `wp9b2` / `wp9b1` / `wp9a` / `k17` / `k29` / `wp8c2` / `migration` / `prod-copy` / `m5.1:measurement` →（还原冻结面后单独重跑）`wp9:verify` · `wp8c1:verify` · `wp10a:verify`。见 §5 |
| **Tests Passed** | 提交前：`typecheck` 0 · **`wp10b:verify` 24/0 · `WP10-B = PASS`**（内含 `wp3` / `wp6` / `m5.1:query` / `m4.5:verify` / `m5.1:control` 五门全 EXIT 0）。提交后：18 项检查全部 **EXIT 0**（含 `wp8c3` 40/0 · `wp8` 53/0 · `gates` G1–G7/G9 PASS · `wp9` 57/0 `WP9 = PASS` · `wp8c1` 15/0 `K-32 = PASS` · `wp10a` 27/0 · `migration` 117/0 · `prod-copy` 36/0） |
| **Tests Failed** | **0 条真实红**。两处非绿**均已归属**为"冻结面 × 跑门顺序"的耦合（`wp9:verify` WP9-16 与 `wp8c1`/K-32：harness 重写了 `artifacts/m4.5/**` 与 `artifacts/m5.1/**`；按白名单还原后**单独重跑均 EXIT 0**）—— **无清洁度例外**。另有一处**我自己的操作失误**（还原白名单过宽，误伤了自己的两处登记）已当场修正，见 §6。 |
| **Evidence Produced** | `artifacts/m5.1.1/wp10-production-copy.json`（canonical 名）：四条 boundary（snapshot/copy · source · copy · migration）· 既有行身份摘要前后 · 四项验证逐项读数 · 五个 canonical 步骤的 `where`/`exit`/`isolatesItself` · 全量量具 · `restoreEpoch = NOT_APPLICABLE`。`artifacts/m5.1.1/wp10b-gate-exits.txt`（逐门退出码） |
| **Known Issues** | ① **`replay` / `query` / `action` / `control` 四个步骤跑在各自的隔离库上，不是跑在本门的副本上** —— 它们的脚本都自隔离（`isolateDatabase` / `cpSync`+env），结构性上无法被指向副本。本门在证据里**逐条标注 `where`**，**不**声称它们跑在副本上；副本侧的证明是 §4/§5/§6 的 raw SQL 读数。② 真实库的历史账本很小且**没有行动历史**：`conversation_events` **28 行** · `state_events` **1 行** · `character_action_events` **0 行**（合计 29 行）—— 这是首次被机器记录的"真实语料规模"。③ 既有行 `attribution_origin` 全为 NULL（无信封）⇒ 按 K-30 它们**不计入** unknown count；**没有任何 `Unknown(LEGACY_UNRECORDED)`**（回填没有发生，canonical 也禁止在 WP10-B 回填）。④ `wp7:preflight / AT-W7-0` 仍 `inherited`；`Generic trusted-envelope clone resistance` 仍 `OPEN / NOT PROVEN`。 |
| **Architecture Deviations** | **无**。没有新 ADR；`src/**` 一字未改；**没有对真实库执行任何迁移**（canonical 明文禁止 `live production destructive migration`）；没有回填；冻结面最终零差异；`MIGRATION_0009` / `INITIAL_STATE` / manual reset 语义未动。 |
| **Commit Hash** | `5d9924f` — `test(m5.1.1): add WP10-B production-copy migration gate (fresh copy of the real DB)`（仪器 + 注册表分类 + package.json + `wp10-production-copy.json` + 本 handoff）· 提交后再鉴定读数与 `wp10b-gate-exits.txt` 在**紧随其后的 docs 提交**（本文件 §5 所在的提交） |

---

## 1. 本步只做一件事

> 用**真实库的一份新鲜副本**验证**当前冻结的迁移链**（`v6 → v7 → v8 → v9`），
> 并在副本上完成 canonical 的四项验证与五个步骤。**只做 WP10-B。**

**真实库的状态**（全程）：只被 `statSync`/`readdirSync` 采样 + 被 `cpSync` 读取；
**从未被应用代码打开**（隔离机制 = `copy`：`PGLITE_DATA_DIR = <副本>`）。

---

## 2. 冻结迁移链（本次实测）

```text
源（真实库）      : 边界身份 38844f4eb730c96f… · 1201 文件 · 31289946 字节 · 最新 mtime 2026-09-17T15:51:40.789Z
                    —— 与 prod-copy 门 2026-09-18 的记录**逐字相同**（§0 与 §8 各测一次，运行全程未变）
副本（cpSync）    : 边界身份 == 源（**逐字节相同**）· 1201 文件 · 31289946 字节
复制协议          : 3s 静默窗口内源两次边界指纹一致 → cpSync → 复制后再测源 ⇒ 未变（否则丢弃副本 + STOP）
apply 前          : schemaVersion = 6（= canonical 的起点 v6）· 待应用 = [v7, v8, v9]
apply 报告        : from 6 → to 9 · applied = [v7, v8, v9] · skipped = 6
apply 后          : schemaVersion = 9（= 代码最新 9）
迁移表            : character_schema_migrations 恰好 **9 行**，版本恰为 1..9，每行都有非空 name
```

**一处解释性说明**（R-49 已登记）：canonical 文本写 `v6 → v7`（当时只有 v7）；v8/v9 之后
同一语义步骤的当前形式是 **`v6 → v9`**。四项语义要求一字未变。

---

## 3. 四项 canonical 验证（逐项读数）

| # | 验证项 | 读数 | 判定 |
|---|---|---|---|
| ① | `migration count truth` | 迁移表 9 行（1..9，name 齐）· `applied` = 3 条（7/8/9）· `6 + 3 = 9` | ✅ |
| ② | `unknown count truth` | 单位按 **K-30**（`unknownSlotCount` 逐槽位 + `recordsWithUnknownCount`）；三表**逐表**提供：`conversation_events` 28 行（有信封 0 / 无信封 28）· `character_action_events` 0 行 · `state_events` 1 行（有信封 0 / 无信封 1）⇒ **UNKNOWN 槽位合计 = 0 · 含 ≥1 UNKNOWN 的记录合计 = 0** | ✅ |
| ③ | `no fabricated USER` | 三表合计：`attribution_origin IS NULL ∧ 任一槽位非空` = **0 行** · `contentOriginator = USER` = **0 行** | ✅ |
| ④ | `no mutation from query` | 只读查询 pass 覆盖三表（28 / 0 / 1 行）；逐表摘要 pass 前后**逐字相同**；副本**边界身份** pass 前后也相同 | ✅ |

**② 的"真相"要读清楚**：副本上所有既有行都是"**信封从未记录过**"（`attribution_origin IS NULL`）。
按 K-30 的 `not counted` 一行，**整封缺席**不计入 unknown count ⇒ 0 是**正确的真相**，
不是"没量到"。**也没有任何 `Unknown(LEGACY_UNRECORDED)` 被伪造出来**（回填没有发生；
canonical 的回填是**另行**的动作，不在 WP10-B 里做）。

**③ 的机制**：v7/v8/v9 都是 `add column` / `add constraint`，**没有 data statement** ⇒
既有行不可能被填上任何槽位值。这是"不可能伪造"的结构性理由，不是"跑一遍没看到"。

**既有行未被改动**（apply 前后身份摘要逐字相同，覆盖三表的既有列）：

```text
conversation_events      28 行 · digest d5277b5979060751…
character_action_events   0 行 · digest e3b0c44298fc1c14…（空集）
state_events              1 行 · digest c6ae3092fb4e4972…
    ⇒ apply 前后完全一致（迁移没有改任何既有行）
```

---

## 4. 五个 canonical 步骤（**逐条标注跑在哪**）

| 步骤 | 实跑的门 | **跑在哪** | EXIT | 读数 |
|---|---|---|---|---|
| `backfill` | `m5.1.1:wp3:verify` | **production-copy** | 0 | 该门**自己** `cpSync` 真实库、在**副本**上跑真实回填（quiet + 边界指纹协议）· `Replay = PASS`｜影响半径 = PRODUCED |
| `replay` | `m5.1.1:wp6:verify` | isolated-sandbox | 0 | WP6 Recorded Read Path：51 通过 / 0 失败 |
| `query` | `m5.1:query:verify` | isolated-sandbox | 0 | M5.1 WP2 只读查询面门：56 通过 / 0 失败 |
| `action` | `m4.5:verify` | isolated-sandbox | 0 | M4.5 L2 子系统验证：53 通过 / 0 失败 |
| `control` | `m5.1:control:verify` | isolated-sandbox | 0 | M5.1 WP3 开发者控制面门：41 通过 / 0 失败 |

**为什么后四个不是"跑在副本上"**：这四门的脚本都**自己建隔离**
（`isolateDatabase()` 或 `cpSync`+env），而 `isolateDatabase()` 会**无条件覆写**
`PGLITE_DATA_DIR` ⇒ 结构性上无法把它们指向本门的副本（除非改那四个门 —— 那超出 WP10-B 的授权）。
本门因此**不**声称它们跑在副本上；副本侧的证明是 §3 的四项验证与 §4 的 raw SQL 读数
（列形状 / 行数 / 无回填 / 只读不变）。
**机器证据**：证据文件里每个步骤都带 `where` + `isolatesItself`（五个全 `true`）。

---

## 5. 提交后串行再鉴定读数

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | |
| 2 | **`pnpm m5.1.1:wp8c3:verify`**（Hard Gate，干净树、最先单独跑） | **0** | 40 通过 / 0 失败 · `WP8-C3 = PASS` → `WP8 = PASS` · C3-0 干净树 ✅ |
| 3 | **`pnpm m5.1.1:wp8:verify`**（Hard Gate） | **0** | 53 通过 / 0 失败 · `WP8-B = PASS` · `unclassifiedVerifier = 0`（WP10-B 的新登记已进册）· `unexpectedWrites = 0` |
| 4 | `pnpm m5.1.1:gates` | **0** | `G1–G7 PASS · G8 = NOT RUN · G9 PASS` |
| 5 | **`pnpm m5.1.1:wp10b:verify`** | **0** | **24 通过 / 0 失败 · `WP10-B = PASS`**（提交后重跑，同一读数） |
| 6 | `pnpm m5.1.1:wp9c0:verify` | **0** | 43 通过 / 0 失败 · `WP9-C0 = COMPLETE` |
| 7 | `pnpm m5.1.1:wp9b2:verify` | **0** | 42 通过 / 0 失败 · `WP9-B2 = PASS` |
| 8 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败 |
| 9 | `pnpm m5.1.1:wp9a:verify` | **0** | 31 通过 / 0 失败 · `WP9-A = PASS` |
| 10 | `pnpm m5.1.1:k17:verify` | **0** | 15 通过 / 0 失败 · `K-17 = PASS` |
| 11 | `pnpm m5.1.1:k29:verify` | **0** | 41 通过 / 0 失败 |
| 12 | `pnpm m5.1.1:wp8c2:verify` | **0** | 25 通过 / 0 失败 · `K-33 = PASS` |
| 13 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败 |
| 14 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败 |
| 15 | `pnpm m5.1:measurement:verify` | **0** | 16 通过 / 0 失败 |
| 16 | `pnpm m5.1.1:wp9:verify`（还原冻结面后**单独重跑**） | **0** | 57 通过 / 0 失败 · `WP9 = PASS` |
| 17 | `pnpm m5.1.1:wp8c1:verify`（还原冻结面后**单独重跑**） | **0** | 15 通过 / 0 失败 · `K-32 = PASS` |
| 18 | `pnpm m5.1.1:wp10a:verify`（干净树、单独跑） | **0** | 27 通过 / 0 失败 · `WP10-A = COMPLETE` |

**两处已归属的非绿**（都**不是**回归，见 `wp10b-gate-exits.txt` 的逐条归属）：

1. **`wp9:verify` EXIT 2**：它跑在 `wp8c3`/`wp8`/`gates` 之后，而 `wp8:verify` 会通过 harness 跑
   `m4.5:*` 门 ⇒ 那些门重写 `artifacts/m4.5/**`（**冻结目录**）⇒ 它的 `WP9-16`（"没往冻结目录写任何东西"）
   **正确地**报红。按白名单从 immutable 标签还原冻结面后**单独重跑 = EXIT 0 · 57/0 · `WP9 = PASS`**。
2. **`wp8c1:verify`（K-32）EXIT 1**：同一根因 —— harness 重写了 `artifacts/m5.1/wp1-contracts.json` /
   `query-negative-control.json` ⇒ K-32 报"冻结证据被污染"。还原后**单独重跑 = EXIT 0 · 15/0 · `K-32 = PASS`**。

⇒ 两处都是**冻结面 × 跑门顺序**的耦合（B1 / B2 / C0 / C1 / WP10-A 都登记过同一课），
**不是** WP10-B 引入的回归。这正是 `WP10-C` 的 **C4 任务（逐路径还原）**要系统化处置的东西。

完整逐门读数见 `artifacts/m5.1.1/wp10b-gate-exits.txt`。

---

## 6. 过程内的一处**我自己的操作失误**（如实登记）

跑完门之后我用一条**过宽的白名单**做还原：`git status --porcelain | ^ M ` 的结果**不区分**
`artifacts/**` 与源码/文档 ⇒ 把**我自己刚做的两处有意改动**（`package.json` 的
`m5.1.1:wp10b:verify` 入口、注册表的 wp10b 分类条目，以及一份被门重写的 docs）一起
`git checkout --` 掉了。

**处置**：当场发现（`Select-String` 复核"注册是否还在" = False），**重新施加**这两处改动，
再 `typecheck` + 复核 diff 确认无误。
**纪律修正**：还原白名单今后**只作用于 `artifacts/**`**（AGENTS §7 的"逐路径"还应再加一条
"只限证据目录"）。冻结面 `artifacts/m5.1/**` 与 `artifacts/m4.5/**` 的还原仍从
immutable 标签 `m5.1-complete` 取。

---

## 7. 下一步

**下一个 WP 只能是 `WP10-C — Full Regression & Gate Aggregation`**，
计划见 `M5.1.1-WP10A-Execution-Plan.md` §3。**不得**开始 `WP10-D`。

进入 `WP10-C` 前必须成立：

1. `WP10-B = PASS`（四项 canonical 验证全过；五步全 EXIT 0）。
2. 工作树干净；真实库边界身份仍 == `38844f4e…`；v7/v8/v9 指纹仍冻结。
3. **`m4.5:ci` 尚未跑**（WP10-C 的活）；Live Smoke 前置仍 `NOT RUN`（无 `OPENAI_API_KEY`）。
   **⚠️ 2026-09-19 更正**：括号里的理由不准确 —— 门只 import `node:*`、未加载 `.env`。见 AGENTS §8.1。
4. `artifacts/m5.1/wp9-m4.5-ci.log`（被 gitignore 的 734070 字节日志）**覆盖前必须先 fork 读数**。

---

## 不主张（诚实边界）

```text
本 WP **不**主张 WP10 已完成 —— 它只交付 canonical 的 "Production-copy" 段。
本 WP **没有**对真实库执行任何迁移（只迁移了它的一份副本）。
本 WP **没有**跑全量 CI / 回归 / Live Smoke（那是 WP10-C）。
本 WP **没有**做任何回填 —— 因此本副本上不存在 Unknown(LEGACY_UNRECORDED)，
  而"0 个 unknown"是 K-30 口径下的**正确真相**，不是"没量到"。
```
