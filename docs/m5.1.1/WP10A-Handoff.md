# WP10-A Handoff —— Production-Copy & Regression Preflight

**判定：`WP10-A = COMPLETE`**（EXIT 0 · 27 通过 / 0 失败；七项读数见 §3）
**`WP9 = PASS`** · **`WP10 = READY / AUTHORIZED`** · **`WP10-B/C/D = NOT STARTED`**

日期：2026-09-19 · 上游：`WP9-C1 = PASS`（⇒ `WP9 = PASS`）· `WP8 = PASS`
执行令：**用户 R-49** —— 只执行 WP10-A；**不迁移 · 不跑全量 CI · 不改生产代码**；提交后 **STOP**

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `scripts/verify-m5.1.1-wp10a-preflight.ts`（**新增**只读预检仪器）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` **+1 条分类**，附理由）· `package.json`（`+ "m5.1.1:wp10a:verify"`）· `docs/m5.1.1/M5.1.1-Execution-Plan.md`（追加 **R-49** 行）· `docs/m5.1.1/M5.1.1-WP10A-Execution-Plan.md`（**新增**：B/C/D 计划）· `docs/m5.1.1/WP10A-Handoff.md`（本文件）· 证据 `artifacts/m5.1.1/wp10a-preflight.json` + `wp10a-gate-exits.txt`。**`src/**` 零改动**；**未执行任何迁移**；**未运行任何 CI** |
| **Tests Run** | 提交前：`typecheck` · `wp10a:verify`（新门）。**提交后**：`typecheck` → **`wp8c3:verify`**（干净树、最先单独跑）→ **`wp8:verify`** → `gates` → **`wp10a:verify`**（单独、干净树）→ `wp9` / `wp9c0` / `wp9b2` / `wp9b1` / `wp9a` / `k17` / `k29` / `wp8c1` / `wp8c2` / `migration` / `prod-copy` / `m5.1:measurement`。见 §5 |
| **Tests Passed** | 提交前：`typecheck` 0 · **`wp10a:verify` 27/0 · `WP10-A = COMPLETE`**。提交后：17 道门全部 **EXIT 0**（含 `wp8c3` 40/0 · `wp8` 53/0 · `gates` G1–G7/G9 PASS · `wp9` 57/0 `WP9 = PASS` · `migration` 117/0 · `prod-copy` 36/0） |
| **Tests Failed** | **0 条真实红**。两处非绿**均已归属**：① 批量中 `wp10a:verify` EXIT 1 = **顺序耦合**（紧跟在会重写被跟踪 artifacts 的门之后 ⇒ 工作树干净前置正确报红；还原后单独重跑 = EXIT 0，**无清洁度例外**）；② `wp9c1:verify` = **不存在的 script**（本表命令笔误；WP9-C1 改的是 `wp9:verify` 本身）。另：隔离检测器第一版有**一处我自己的判据缺陷**（只认一条隔离机制），已当场修正并加正控，**判据更严**。 |
| **Evidence Produced** | `artifacts/m5.1.1/wp10a-preflight.json`（七项读数 + 三段式 + 白名单 + 命令盘点 + Live Smoke 前置）· `artifacts/m5.1.1/wp10a-gate-exits.txt`（逐门退出码）· `docs/m5.1.1/M5.1.1-WP10A-Execution-Plan.md`（B/C/D 的 Atomic Task / Hard Gate / 时长 / 失败停止条件） |
| **Known Issues** | ① **`OPENAI_API_KEY` 不存在** ⇒ Live Smoke = **NOT RUN**（canonical：no key → NOT RUN，**不得 mock 成 PASS**）⇒ `m4.5:ci:full` 在本机**不可能**被诚实判 PASS。**⚠️ 2026-09-19 更正**：本门只 import `node:*`、**未加载 `.env`** ⇒ 它读到的 key 为空是**门的环境**，不是本机没有 key；`NOT RUN` 的准确依据是"**本步没有跑 smoke**"。见 `M5.1.1-Gate-Decision.md` §11 的更正块与 AGENTS §8.1（测试端点政策）。② `artifacts/m5.1/wp9-m4.5-ci.log` 是**被 gitignore** 的 734070 字节 UTF-16LE 日志（`m5.1:regression:verify` 读它）⇒ WP10-C **覆盖前必须先 fork 读数**（不复制 734KB）。③ canonical 的 `v6 → v7` 现为 **`v6 → v9`**（见 §2 的解释性说明，需你确认）。④ `wp7:preflight / AT-W7-0` 仍 `inherited`；`Generic trusted-envelope clone resistance` 仍 `OPEN / NOT PROVEN`；`K-31` 仍 `OPEN / DEFERRED / NON-BLOCKING`；`C4` 文本误报有意不修。 |
| **Architecture Deviations** | **无**。没有新 ADR；`src/**` 一字未改；`MIGRATION_0009` / `INITIAL_STATE` / manual reset 语义未动；真实库未打开；冻结面零差异；**没有**执行迁移、**没有**跑 CI、**没有**跑 Live Smoke。 |
| **Commit Hash** | `f131a73` — `test(m5.1.1): add WP10-A production-copy and regression preflight (read-only)`（含本 WP 内修正的隔离检测器；`--amend` 合并，因为缺陷在**报告之前**就修好了）· `da3cac4` — `docs(m5.1.1): record WP10-A preflight evidence, execution plan and handoff` · 提交后再鉴定读数与 `wp10a-gate-exits.txt` 在 **Commit C**（本文件 §5 所在的 docs 提交） |

---

## 1. 本步只做一件事

> R-49：**WP10-A —— Production-Copy & Regression Preflight**。只读预检，产出**预检证据 + 执行计划 + Handoff**，然后 STOP。

**明确不做**：不执行实际迁移（真实库或副本都不迁移）· 不运行全量 CI · 不跑 Live Smoke · 不修改生产代码 · 不开始 B/C/D。

---

## 2. 七项预检的结论（读数见 §3）

| # | 预检项 | 结论 |
|---|---|---|
| ① | Git 工作树 + v7/v8/v9 指纹 | **干净**；`MIGRATION_0007/0008/0009` 指纹仍 == `2d51997d…` / `0a2bd4fe…` / `5a007003…`；迁移链 1..9、最新 = 9 |
| ② | 真实库只读基线 + 副本方案 + 隔离边界 | 边界身份 `38844f4e…`（1201 文件 / 31289946 字节 / 最新 mtime `2026-09-17T15:51:40.789Z`）与 `prod-copy` 门 2026-09-18 的记录**逐字相同**；副本方案 = `cpSync` + 静默复核 + 只在副本上 apply；**三层写保护**齐备 |
| ③ | 命令盘点 + Live Smoke 前置 | `m4.5:ci` = **32 个叶命令**（链无断）；`m4.5:ci:full` / `m5.1:gates` / `m5.1:regression:verify` / `m5.1.1:gates` 全部可展开；**Live Smoke = NOT RUN**（无 key） |
| ④ | fork / restore 白名单 | 冻结面（`artifacts/m4-acceptance` / `m4.1` / `m4.5` / `m5` / `m5.1`）= immutable 标签 `m5.1-complete` 的 blob；`artifacts/m5.1.1/**` per-WP 证据 = HEAD blob；被 ignore 的大日志**覆盖前必须 fork 读数** |
| ⑤ | 真实库不会被意外打开/修改 | 三层写保护（`isProductionDir` 重叠判定 / `assertDatabaseAccessAllowed()` / `shouldBlockForPendingKernelMigration()`）+ CI 链**每个能开库的脚本都 `isolateDatabase()`**（三段式负控：注入"能开库但不 isolate"的合成脚本 ⇒ 必响） |
| ⑥ | B 的 Atomic Task / Hard Gate / 时长 / 停止条件 | 见 `M5.1.1-WP10A-Execution-Plan.md` §2（5 个任务 · 5 个 Hard Gate · **6–10 分钟** · 5 条失败停止条件） |
| ⑦ | C / D 同上 | 同文件 §3（C：5 个任务 · **15–25 分钟** · 5 条停止条件）· §4（D：3 个任务 · **5 分钟**） |

### 2.1 一处**解释性说明**（需你确认，R-49 已登记）

canonical WP10 写的 `v6 → v7` 写于只有 v7 的年代；v8/v9 之后同一语义步骤的当前形式是
**`v6 → v9`（`applied = [7,8,9]`）**，仍然**只在副本上** apply。四项语义要求一字未变。

### 2.2 一处**必须提前说清的风险**

`m5.1:regression:verify` **不重新跑任何门**：它读 `artifacts/m5.1/wp9-m4.5-ci.log`
（被 gitignore 的 734070 字节 UTF-16LE 日志）+ `artifacts/m5.1/*.json` 的 verdict 字段。
其中 `live-smoke-evidence.json` 的 `liveSmokeVerdict = PASS` 是 **M5.1 期的历史读数**（当时有 key）。
⇒ WP10-C 若不重跑 `m5.1:e2e:verify`，`m5.1:regression:verify` 会**引用历史 live 证据**；
如实做法是把这一点写进 `wp10-regression.json`（**新鲜** vs **历史** 分开标注），
而**不是**把它当作"M5.1.1 期也跑过 live smoke"。

---

## 3. WP10-A 的实测读数

`pnpm m5.1.1:wp10a:verify` = **EXIT 0 · 27 通过 / 0 失败 · `WP10-A = COMPLETE`**（`measurementInvalid = 0`）。

```text
工作树        : 没有被跟踪文件的改动（未跟踪的只剩本门自己的证据面）
指纹冻结      : v7 = 2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613
                v8 = 0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29
                v9 = 5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c
迁移链        : 1..9 连续 · 最新 = 9
真实库边界身份: 38844f4eb730c96f… · 1201 文件 · 31289946 字节 · 最新 mtime 2026-09-17T15:51:40.789Z
                与 prod-copy 门 2026-09-18 的记录**逐字相同** ⇒ 源自那次复制以来没被动过
源 schema（间接）: fromVersion = 6（复制那一刻）· applied = [7,8,9] · toVersion = 9
immutable 标签 : m5.1-complete = tag object 2e718f38… → commit 2aac6cad…
冻结目录      : m4-acceptance(19) · m4.1(9) · m4.5(9) · m5(20) · m5.1(14) —— 全部与标签**零差异**
命令盘点      : m4.5:ci = 32 叶 · m4.5:ci:full = 33 叶 · m5.1:gates / m5.1:regression:verify / m5.1.1:gates
Live Smoke    : NOT RUN（OPENAI_API_KEY 不存在；OPENAI_BASE_URL 亦不存在；docker 可用）
被 ignore 日志: artifacts/m5.1/wp9-m4.5-ci.log 734070 B utf-16le sha 502c1d7243a6…（覆盖前须 fork 读数）
                artifacts/m4.5/m4-ci.log 640284 B utf-16le sha 8b94a25fb07a…
                artifacts/m4.5/m4.5-ci.log 734258 B utf-16le sha 37f67ee0b128…
CI 链隔离静默 : 检查 31 个叶（32 − 无 tsx 的 typecheck）· 10 个"能开库"的脚本**全部**经由
                sandbox(9) / copy(1) 两条已声明机制 ⇒ offender = 0
                三段式：真实 0 → 注入"两条机制都没有"的合成脚本**必响** → 恢复 0
                （两条机制正控被正确识别为 sandbox / copy）
```

**本 WP 内修正的一处自己的判据缺陷**：隔离检测器第一版只认 `isolateDatabase()`，
把 `scripts/verify-migrate-gate.ts` 误报为违规；实测它用的是**第二条已声明机制**
（`cpSync` 出副本 + `PGLITE_DATA_DIR` 指向副本，其注释逐字写着"真实库全程未被打开写入"）。
处置 = **把第二条机制写进判据 + 加第三个正控**，而不是塞进白名单（判据因此**更严**）。

完整读数见 `artifacts/m5.1.1/wp10a-preflight.json`。

---

## 4. 下一步

**下一个 WP 只能是 `WP10-B — Production-Copy Migration & Copy-Scoped Verification`**，
计划见 `M5.1.1-WP10A-Execution-Plan.md` §2。**不得**跳过 B 直接跑 C/D；
**不得**在 WP10-B 里对**真实库**执行任何迁移（canonical 明文禁止 `live production destructive migration`）。

进入 `WP10-B` 前必须成立：

1. `WP10-A = COMPLETE`（仪器 EXIT 0；七项有读数）。
2. 工作树**干净**；`MIGRATION_0007/0008/0009` 指纹仍冻结；真实库边界身份仍 == `38844f4e…`。
3. `m4.5:ci` 的 32 个叶命令可展开；CI 链隔离静默检查无洞。
4. Live Smoke 前置如实登记（本机 = `NOT RUN`）。

---

## 5. 提交后串行再鉴定读数

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | |
| 2 | **`pnpm m5.1.1:wp8c3:verify`**（Hard Gate，干净树、最先单独跑） | **0** | 40 通过 / 0 失败 · `WP8-C3 = PASS` → `WP8 = PASS` · C3-0 干净树 ✅（无清洁度例外） |
| 3 | **`pnpm m5.1.1:wp8:verify`**（Hard Gate） | **0** | 53 通过 / 0 失败 · `WP8-B = PASS` · 新登记（`NON_VERIFIER_SCRIPTS` +1）后 `unclassifiedVerifier = 0` · `unexpectedWrites = 0` |
| 4 | `pnpm m5.1.1:gates` | **0** | `G1–G7 PASS · G8 = NOT RUN · G9 PASS` |
| 5 | **`pnpm m5.1.1:wp10a:verify`**（**干净树、单独跑**） | **0** | **27 通过 / 0 失败 · `WP10-A = COMPLETE`** |
| 6 | `pnpm m5.1.1:wp9:verify` | **0** | 57 通过 / 0 失败 · `WP9 = PASS`（不变） |
| 7 | `pnpm m5.1.1:wp9c0:verify` | **0** | 43 通过 / 0 失败 · `WP9-C0 = COMPLETE` |
| 8 | `pnpm m5.1.1:wp9b2:verify` | **0** | 42 通过 / 0 失败 · `WP9-B2 = PASS` |
| 9 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败 |
| 10 | `pnpm m5.1.1:wp9a:verify` | **0** | 31 通过 / 0 失败 · `WP9-A = PASS` |
| 11 | `pnpm m5.1.1:k17:verify` | **0** | 15 通过 / 0 失败 · `K-17 = PASS` |
| 12 | `pnpm m5.1.1:k29:verify` | **0** | 41 通过 / 0 失败 |
| 13 | `pnpm m5.1.1:wp8c1:verify` | **0** | 15 通过 / 0 失败 · `K-32 = PASS` |
| 14 | `pnpm m5.1.1:wp8c2:verify` | **0** | 25 通过 / 0 失败 · `K-33 = PASS` |
| 15 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败 |
| 16 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败（**在副本上** v6 → v9；真库只被复制） |
| 17 | `pnpm m5.1:measurement:verify` | **0** | 16 通过 / 0 失败 |

**两处已归属的非绿**（都在 `wp10a-gate-exits.txt` ③/⑤ 逐条写明）：

1. **`wp10a:verify` 在一次批量里的 EXIT 1 = 顺序耦合**：它紧跟在 `wp8c3`/`wp8`/`gates` 之后跑，
   而那几道门会重写**被跟踪的** `artifacts/m5.1.1/wp8-*` / `wp8c3-*` / `gate-results.json` ⇒
   它的"工作树干净"前置**正确地**报红。处置 = 按白名单逐路径还原回 HEAD ⇒ 树干净 ⇒ **单独重跑 = EXIT 0**。
   **没有**加任何清洁度例外；它的判据只放过**它自己**的证据面（重跑时必然未跟踪）。
2. **`wp9c1:verify` 不存在**：本表一处命令笔误（WP9-C1 修改的是 `wp9:verify` 本身，**没有**新增入口），
   pnpm 报 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`。**不是**门的红。

**本 WP 内自己修正的一处判据缺陷**（非放宽）：隔离检测器第一版只认 `isolateDatabase()`，
把 `scripts/verify-migrate-gate.ts` 误报为违规；实测它用的是**第二条已声明机制**
（`cpSync` + `PGLITE_DATA_DIR`）。处置 = 把第二条机制**写进判据** + 加第三个正控，
判据因此**更严**（详见 §3 与执行计划 §7）。

完整逐门读数见 `artifacts/m5.1.1/wp10a-gate-exits.txt`。

---

## 不主张（诚实边界）

```text
本 WP **不**主张 WP10 已完成 —— 它只交付"WP10 的执行前边界"。
本 WP **没有**执行任何迁移、**没有**跑任何 CI/回归/Live Smoke、**没有**改生产代码。
Live Smoke = NOT RUN（无 key），**绝不可**被读成"live smoke 通过了"。
M5.1-D01 的认知资格问题仍受 ADR-043 / Phase 4 阻塞（与 WP10 无关，也不因它改变）。
```
