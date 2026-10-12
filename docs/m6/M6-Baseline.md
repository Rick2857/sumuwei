# M6 · WP0 基线（当前代码事实 · 前置证据归属）

> 执行日期：2026-09-21（Asia/Shanghai）。
> 分支：`feature/m6-lv1-hardening`（本轮由 WP0 从 `feature/m5.5.1-adaptive-search` 的 HEAD 建立）。
> `runId`：`m6-wp0-20260921-1165fedcdde2`。
> 机器证据：`artifacts/m6/m6-wp0-20260921-1165fedcdde2/{baseline.json, manifest.json, source-tree-index.before.txt}`。
> 出口状态：**BASELINE CAPTURED**（定案读数在 `baseline.json.verdict`；本文件只复述已落盘证据，不手写全绿表格）。

---

## 1. 本轮授权与边界（先说没做什么）

本轮 = `docs/m6/M6-DSH-Execution-Plan.md` 的 **WP0**，仅做基线与前置核对。**没有**做：

| 禁止项 | 本轮实际 |
|---|---|
| 改 `src/**` 生产代码 | 未改一个字节（唯一新增的 `.ts` 是量具 `scripts/m6-wp0-baseline.ts`） |
| 打开真实库 / 跑真实库 CLI | 未打开。真实库只做**只读内容树摘要**（`digestTree` 只读字节，不 import PGlite） |
| 跑模型 / 跑搜索 | 未跑（无 `with-test-model`、无 `OPENAI_*` 调用） |
| 迁移 / 快照 / 恢复 | 未做 |
| 还原或提交他人改动 | `artifacts/incidents/inc-01/wp1-lease.json` 的原字节保留，未 `checkout`、未 `stash` |
| 打标签 / 合并 / 开 auto_public | 未做 |
| 建 ADR / 写 WP1 设计 | 未做 |

**唯一跑过的门**：`pnpm typecheck`（退出码 0）。理由：新增了 `scripts/m6-wp0-baseline.ts`，而
`tsconfig.json` 的 `include` 含 `scripts/**`，属 AGENTS §5 第一行"任意 `.ts` ⇒ `pnpm typecheck`"。
**未跑**任何里程碑门：WP0 零生产代码改动，跑 `m4.5:ci` 只会重写 `artifacts/` 里的历史证据（AGENTS §7 的真实坑）。

**量具身份**：`PROJECT_LG_SANDBOX` **未设置**（`manifest.sandboxIdentity.projectLgSandboxSet = false`）——
这是**预期**读数，不是缺陷：本量具不打开任何数据库，因此不需要 `isolateDatabase()`，
也不存在"隔离库读数被当成真实库状态"的风险（AGENTS §6.9）。

---

## 2. 分支 / HEAD / 标签 / 工作树

| 项 | 读数 |
|---|---|
| WP0 起始分支 | `feature/m5.5.1-adaptive-search` |
| WP0 起始 HEAD | `1165fedcdde2065d41eeeb1b12a635091b4d721a` |
| `main` | `68fed604fb3338d27f3697a9afc1e89adbf90211` |
| 领先 `main` | **52 个提交**（`git rev-list --count main..HEAD`） |
| 落后 `main` | 0 |
| `main` 是否为 HEAD 祖先 | **是**（`git merge-base --is-ancestor main HEAD` 退出 0） |
| `git stash` | 0 条 |
| 里程碑标签 | `m4-acceptance-rc1` · `m4-acceptance-rc2` · `m4-complete` · `m5.1-complete` · `m5.1.1-complete` · `m5.5-complete`（**无 `m5.5.1-complete`**） |

**结论**：基线位于 `main` 的进化线上且已包含 M5.5.1 的全部 52 个提交 ⇒ 计划书 §5
"不要默认从旧 `main` 切出而漏掉 M5.5.1"这条风险在本轮**已被事实排除**。
`feature/m6-lv1-hardening` 已从 `1165fed` 建立（本轮不移动任何既有标签）。

### 2.1 工作树（逐路径 + 归属）

| 状态 | 路径 | 归属判定 |
|---|---|---|
| ` M` | `artifacts/incidents/inc-01/wp1-lease.json` | **other-task**（INC-01 WP1/WP2 证据重跑遗留，mtime `2026-09-20T14:29:11Z`）。M6 不还原、不提交、不覆盖 |
| `??` | `docs/m6/` | `m6-wp0`（计划书原文；见 §2.2） |
| `??` | `scripts/m6-wp0-baseline.ts` | `m6-wp0`（本轮新增量具） |

`counters.unknownDirtyPaths = 0`：**没有归属不明的改动**。
（对照：WP0 期间的 `artifacts/m6/**` 未出现在 `dirtyPaths` 里，因为摘要采集发生在写入之前；
它属 WP0 自产路径，已在 `verdict` 的"唯一差集"判据里登记。）

### 2.2 计划书原文与附件逐字一致

`docs/m6/M6-DSH-Execution-Plan.md`（51,818 字节）与用户附件
sha256 均为 `ae6c1046c6cd5914066d66950d1772e0ae3620775388fee5a02ecfa02233ebc2` —— **逐字相同**。
因此本 WP0 的"第一个提交把计划书原样入库"**没有改动它一个字节**。

---

## 3. 计划书 §1.2 的 15 条现场事实：逐条复核

> 复核方式：只读打开文件 / 读 JSON 字段 / `git` 只读命令。**没有**重新跑门、跑模型或打开数据库。

| # | 计划书主张 | 复核 | 证据 |
|---|---|---|---|
| 1 | `session.close()` 仍只调 `runtime.stop()`，主入口未接租约 | ✅ 真 | `src/main.ts:1559-1561`；`production-db-safety` 仅被 4 个脚本 import（`scripts/inc-01-lease-child.ts`、`verify-inc-01-wp1.ts`、`verify-inc-01-wp2.ts`、`snapshot-db.ts`），`src/main.ts` **零引用** |
| 2 | 编制开始已有 `wp1-lease.json` 修改 | ✅ 真 | `git status` = ` M`；diff 11+/11−，只有 `generatedAt`／管道样本／临时目录名，`realDb.*Tree*` 字段未变 |
| 3 | `semantics-live.json` 仍是早期 FAIL | ✅ 真 | `verdict=FAIL` · `transportFailures=107` · `wrongEgress=true` · `overSearch=true` · `structuredOutputValid=false` |
| 4 | R2：v2 / 348 次调用 / 形状 348/348 / transport 0/348 / PASS | ✅ 真 | `docs/m5.5.1/M5.5.1-WP7-R2-Execution-Record.md` §1-§6；`runId=r2-9-full-v2-timeout25000` |
| 5 | Live Smoke `passed=20 failed=0`，模式 explicit | ✅ 真 | `artifacts/m5.5.1/smoke/smoke-live.json`（`mode` 自述"生产已激活的模式"） |
| 6 | `evals/m3/baseline.json` 无 `minimums` | ✅ 真 | 顶层键只有 `baseline / values / variance / cases` |
| 7 | M5 最多扫描 500 行 | ✅ 真 | `src/infrastructure/persistence/memory-retrieval-store.ts:80-92`（`STORE_MAX_LIMIT = 500`） |
| 8 | 有 `rollup` 槽位但没有滚动摘要实现 | ✅ 真（且更强） | 全仓 `'rollup'` 只出现在 `src/kernel/contracts/context.ts:65`（kind）与 `:116`（`SECTION_PRIORITY.rollup: 20`）；**没有任何 provider 产出 `kind:'rollup'`**。`sections.ts:303` 只是把 recent-conversation 的优先级设成 `rollup + 10`（=30），`kind` 仍是 `recent-conversation` |
| 9 | `clock` 已存在 | ✅ 真 | `kind:'clock'`（`src/kernel/contracts/context.ts:55`）+ `SECTION_PRIORITY.clock: 58`（`:95`） |
| 10 | §10.1 列出的命令存在 | ✅ 真 | 与 `package.json` 逐条比对，**43/43 全部存在**，无虚构历史别名 |
| 11 | M4 脚本参数是"操作数"，10k 回放须另证 | ✅ 真 | `scripts/verify-m4-scale.ts:56` 把裸数字参数当 `OPERATIONS`；`:327`/`:362` 记 `operations`；`:368` 的 `replay` 只报 `{memories, mismatched}`，**无 `replayed_event_count`** |
| 12 | README 把 L1-M3 状态演化留给 M7、Rolling Summary 未实现 | ✅ 真 | `README.md:50-51` |
| 13 | M5.5 标签不动、G5 未在最终代码上重跑 | ✅ 真 | `docs/closure/M5.5-Closure-Record-Final-Code.md:15-22` |
| 14 | M5.5.1 缺最终提交归属与正式收口 | ✅ 真（比计划书更差） | `docs/m5.5.1/` 无 WP8/WP9 记录 · `docs/closure/` 无 M5.5.1 收官记录 · 标签表无 `m5.5.1-complete` |
| 15 | INC-01 已缓解、WP0–WP2 有代码与证据 | ✅ 真 | `docs/incidents/` 只有 `WP0/1/2-Handoff.md`；`artifacts/incidents/inc-01/` 三个 JSON；防复发计划的 WP3/WP4/WP5/WP6/WP7 未落地 |

**判定**：**没有发现编造或夸大**。计划的现场事实层可以信任。

### 3.1 两条计划书没写、但对 M6 有用的补充事实

1. **`extraProviders` 扩展点已存在**：`src/kernel/context/sections.ts:722`/`:739`/`:791`，
   生产装配在 `src/kernel/app/turn-gateway.ts:868-972`（`:956` 调 `buildContextCompilerV2`）。
   ⇒ 摘要**不需要**改编译器，只需要在装配层挂一个 provider。（影响见 §7 的 R-2）
2. **唯一 prompt 入口在 `contracts/context.ts`**：`createContextCompiler`（`:380`）是**唯一**裁剪算法，
   `dedupeById` + `applyBudget` 都在那里。⇒ 计划书 §3.2"禁止在模型调用前再拼一份摘要"有代码层面的落点。

---

## 4. 前置证据索引（10 条有路径 + 2 条缺失登记）

机器读数：`counters.evidenceEntries = 12` · `evidenceEntriesWithPath = 10` · `supersededEntries = 2` · `unverifiedEntries = 2` ·
`evidenceEntriesMissingPath = 0`（**非零**，说明索引确实逐条比对过磁盘）。

| subject | status | 路径 / 说明 |
|---|---|---|
| M5.5 收官复跑（最终代码） | `historical` | `docs/closure/M5.5-Closure-Record-Final-Code.md`（G1–G4 重跑，**G5 未重跑**） |
| M5.1.1 收官复跑（最终代码） | `historical` | `docs/closure/M5.1.1-Closure-Record-Final-Code.md` |
| M5.5.1 语义门权威（R2） | `current` | `docs/m5.5.1/M5.5.1-WP7-R2-Execution-Record.md` |
| M5.5.1 R2 原始观测 | `current` | `artifacts/m5.5.1/wp7/r2-9-full-v2-timeout25000/observations.json` |
| M5.5.1 早期语义证据（FAIL） | `superseded` | `artifacts/m5.5.1/semantics-live.json` → 被上一条取代。**保留不删** |
| M5.5.1 真实搜索 Live Smoke | `historical` | `artifacts/m5.5.1/smoke/smoke-live.json`（explicit；不代表 auto_public） |
| INC-01 WP1 租约证据 | `historical` | `artifacts/incidents/inc-01/wp1-lease.json`（工作树另有他人未提交副本） |
| INC-01 WP2 快照证据 | `historical` | `artifacts/incidents/inc-01/wp2-snapshot.json` |
| INC-01 事故报告 | `current` | `docs/incidents/INC-01-Pglite-DataDir-Unrecoverable-Corruption.md` |
| ADR-043 重定向文件的状态段 | `superseded` | `docs/adr/ADR-043-legacy-…md` → 被 `ADR-043-epistemic-requalification.md` + `ADR-044` 取代。**M6 不改冻结面，仅登记**（该文件状态段仍写 `Phase 4 NOT RUN / D01 OPEN / Final BLOCKED`） |
| **M5.5.1 收口记录（WP8/WP9）** | `unverified` | **缺失**：无记录、无标签 ⇒ 计划 §2.2 前置 1 未满足 |
| **INC-01 生产接线证据（WP3/WP4/WP5）** | `unverified` | **缺失**：`src/main.ts` 未引用保护模块 ⇒ 计划 §2.2 前置 2 未满足 |

**纪律复述**：同名默认文件（`semantics-live.json`）**不是**选结果的依据；每条证据都带
`path + sha256 + status + supersededBy + appliesTo` 五件套，只给路径等于没登记。

---

## 5. 真实库与源码树：两个不同对象、两个不同定义

**这两个摘要禁止互换**（算法原文都在 `baseline.json` 里）：

| 对象 | 实现 | 定义 | 本轮读数 |
|---|---|---|---|
| `data/pglite`（真实库） | `digestTree()`（INC-01 冻结算法，**唯一实现，未重写**） | 相对路径 ordinal 升序 → `rel\tsize\tsha256(内容)\n` → 整段 UTF-8 求 sha256；默认排除 `postmaster.pid`；`measuredCount = 0` ⇒ 抛 `MeasurementInvalidError` | **1205 文件 / 31,584,799 字节 / `be957694b8a1173aa3da49e8b942fc1e69ddaab1cb5971a6bd5c00863555c500`** |
| 源码树（git 工作树） | `sourceTreeDigest()`（WP0 定义） | 文件集 = `git ls-files` ∪ `git ls-files --others --exclude-standard`，排除 `.git/ node_modules/ data/ dist/ artifacts/m6/` → 同样的行格式 → sha256 | **1271 文件 / 18,470,789 字节 / `138a273cf6c1875d965665aee2da243fa83f556f43cb93f4e0c8c98b1ab56c16`** |

摘要**原像**落在 `source-tree-index.before.txt`（138,748 字节，1271 行）：
它既是"能从这里重算 treeSha256"的凭据，也让 `baseline.json` 保持 33KB 的可复核体量。
`after` 阶段会先复核该原像的 sha256 与自己记录的一致，再拿它做 diff（防"索引被事后改过"）。

### 5.1 真实库稳定性：两条读数，两个结论

- **内容摘要**：`be957694…c500` 与 `scripts/verify-inc-01-wp1.ts:41` 的常量 `WP0_REAL_DB_NONVOLATILE`、
  以及 `artifacts/incidents/inc-01/wp1-lease.json` 的 `nonVolatileTreeBefore` / `nonVolatileTreeAfter`
  **逐字相同**。⇒ 自 INC-01 WP1/WP2 证据落盘（`2026-09-20T14:29Z`）以来，真实库**非易失内容字节未变**。
- **mtime 观测**（只读 `stat`，不打开 PGlite）：最新 `2026-09-20T14:02:55.698Z`（本地 22:02:55），
  最旧 `2026-09-15T15:39:48.506Z`；**最近 1.5 小时内 0 个文件被改**；最近 12 小时内 26 个。
  最新 5 个文件全部是 PGlite 运行态：`pg_wal/00000001000000000000000B`、`base/1/pg_internal.init`、
  `global/pg_internal.init`、`global/pg_control`、`base/1/16847`。
  唯一被摘要排除的是 `postmaster.pid`（易失运行态，`VOLATILE_EXCLUDED_PATHS`，本脚本 **import** 该常量而非另抄一份）。

**这两条合起来说明什么（以及不说明什么）**：

- ✅ 说明：22:02:55 那次写入发生**在** INC-01 WP1 的 22:29 读数**之前**，因此"内容摘要与 INC-01 常量相同"
  与"存在一次 22:02 的 mtime 变化"**不矛盾**；并且**WP0 本轮没有**改变真实库字节，此刻也没有活跃写入。
- ❌ **不说明**：真实库的历史完整、schema 版本、或 22:02 那次写入是"谁的、写了什么"。
  本轮**没有**打开库、没有读账本，因此不作任何此类主张（见 `openQuestions.OQ-1`）。
  事故报告已明确发生过快照恢复、恢复点之后的写入不在恢复点内 —— 那个缺口**保留**。

### 5.2 采样稳定性口径

源码树摘要在 WP0 期间会**合法变化**（WP0 自己在写文件）。因此采用"两次采样 + 逐文件差异 + 分类"：

- `before` 采样（1346 文件集、WP0 新文件尚未落盘）
- `after` 采样（全部 WP0 产物落盘后）
- `verify` 采样（最终一次文档编辑之后）

任何出现在 `changedFiles` 里、**不属于** `docs/m6/`、`artifacts/m6/`、`scripts/m6-wp0-baseline.ts`
的差异都会被归为 `unexpected`，并直接把 `verdict` 降为 `PARTIAL`（不是 PASS）。
`counters.sourceTreeUnexpectedChanges` 就是这道判据的机器落点。

---

## 6. 并发与共享文件边界

| 读数 | 值 |
|---|---|
| 短窗（1.5h）内被改的**源码树**文件 | **1** —— 只有 `scripts/m6-wp0-baseline.ts`（本轮自产） |
| 长窗（12h）内被改的源码树文件 | 88（昨夜 M5.5.1 R2 批次等已结束的工作） |
| 并发判定 | `status = clean`（短窗内无**未登记**改动） |
| INC-01 证据 mtime | `baseline.json` `2026-09-20T14:19:32Z` · `wp1-lease.json` `14:29:11Z` · `wp2-snapshot.json` `14:29:50Z` |
| 真实库最近 1.5h 改动数 | **0** |

**判定**：WP0 期间**没有**另一个任务在写这个 checkout，也没有人在和真实库对话。
⇒ 计划 §2.2 前置 3（"正在运行的任务和共享文件边界已核对"）在本轮窗口内**满足**；
但这是一次**窗口读数**，不构成对未来的保证 —— WP9b/WP10b 长时运行前必须重取。

---

## 7. 前置缺口现状（决定哪些包能开工）

### 7.1 在开工前必须满足、且**现在未满足**的两条

| 前置 | 计划 §2.2 要求 | 现状 | 受影响包 |
|---|---|---|---|
| **P-1** M5.5.1 候选与收口 | 指定可引用的候选提交、保存旧失败与新成功的取代链、给出 WP8／收口结论 | R2 记录与 r2-9 证据**在**（可引用的候选提交 = 本分支 HEAD）；但**无 WP8 记录、无收官记录、无 `m5.5.1-complete` 标签** | WP6b · WP9b · WP10b |
| **P-2** INC-01 运行期保护 | 单持有、静默一致快照、可验证关闭、恢复预演，且**由生产入口证据**证明 | 组件与 WP1/WP2 证据在；**WP3（close 生命周期）/ WP4（生产接线）/ WP5（恢复演练）未落地**，`src/main.ts` 零引用 | WP6b（`BLOCKED`） |

**P-2 的精确边界**：M6 的 WP6b 是 INC-01 保护措施的**集成验收**，不是重写租约/快照模块。

### 7.2 可开工 / 受阻清单

| 包 | 状态 | 前置 / 解除判据 |
|---|---|---|
| WP1（设计冻结与验收契约） | **可开工** | 仅需执行授权。必须处理本文件 §7.3 的两条裁定项 |
| WP2（摘要纯逻辑） | **可开工** | WP1 获批。纯领域层 + 合成夹具，不需要真实库 |
| WP3（接线与全局上下文） | **可开工** | WP2；安全前置 P-1/P-2 **不适用于它**（合成隔离库 + 真实 `TurnGateway`） |
| WP4（验收驱动与量具资格化） | **可开工** | WP3。复用既有 `scripts/*harness*`、`digestTree`、快照与摘要工具 |
| WP5（开发者面可用性） | **可开工** | WP3–WP4 |
| WP6a（降级与动作真相） | **可开工** | WP4。故障注入走既有测试注入点 |
| WP7（A–E 自然语言与跨模块） | **可开工** | WP4、WP6a。**默认全部在合成隔离库** |
| WP8（规模、性能、容量边界） | **可开工** | WP4、WP6a。注意三种计数不可混（见 §3 第 11 条） |
| WP9a（50/100 轮校准与阈值） | **可开工（受限）** | 需批准端点与固定配置；须先核对 M3 的分数方向与 count/rate/score 区别 |
| WP6b（重启、关闭、恢复） | **BLOCKED** | `INC-01-WP3` + `INC-01-WP4` + `INC-01-WP5`（见 P-2） |
| WP9b（500 轮 × 3 轨迹） | **BLOCKED** | WP9a 阈值冻结 + WP8 + 代码稳定 + 端点额度/时长 |
| WP10a（最终候选离线门） | 未到 | 所有实现完成后 |
| WP10b（最终候选 Live） | **BLOCKED** | WP10a + **用户对 Live 的单独授权**（本计划批准 ≠ Live 授权） |
| WP11（M6 收口） | 未到 | WP10；**若 WP6b 仍 BLOCKED，WP11 不能给 `M6 = PASS`** |
| G1-A / G1-B | **BLOCKED** | M6 自动门通过 + 综合验收授权 + 真人评分（LLM judge 不能填充"人工已审"） |

### 7.3 WP1 必须裁定的两条新问题（审阅中发现，计划书原文未列）

| ID | 问题 | 为什么必须在 WP1 定 |
|---|---|---|
| **R-2** | 摘要 provider 是否承诺"prompt 冻结基线一字节不动"？ | 冻结基线 `evals/fixtures/m3.5/prompt-baseline.txt`（sha256 `047c6c96…4ea4b6`）由 `scripts/m3.5-prompt-baseline.ts:135` 用**同一个** `buildContextCompilerV2` 但不传 `extraProviders` 生成。若把 provider 放进工厂**默认列表** ⇒ `pnpm m3.5:test` 必红；走 `extraProviders` + 既有"空集合产 0 section"约定（`turn-gateway.ts:932-933`）⇒ 基线可不动 |
| **R-3** | 摘要额度走"复用 `reservedTokens`"还是"新增 `ContextBudget` 字段/第 7 类 `ContextCategory`"？ | `ContextBudget` 是 4 个**必填**字段、`ContextCategory` 是 6 类，`planContextBudget()`/`assertContextBudget()` 按此写死；新增会连锁打红 `pnpm m5:budget:verify`（`scripts/verify-m5-budget.ts:116-151` 直接断言六类与默认值）并波及约 10 处 `ContextBudget` 字面量 |

---

## 8. 待解问题（openQuestions）

| ID | 问题 | 为什么重要 | 谁能回答 |
|---|---|---|---|
| **OQ-1** | 真实库最新 mtime（本地 `2026-09-20 22:02:55`）是谁产生的写入？ | 计划 §1.2 引用的是 M5.5 收尾时的"前后逐字相同"。本轮已证明**内容摘要未变**，但"谁在 22:02 碰过它"**本轮不解释** | 用户（是否在这段时间聊天）/ 真实库账本（**需用户授权**后由 `src/main.ts` 读取） |
| **OQ-2** | M5.5.1 的 WP8 记录与 `m5.5.1-complete` 标签由哪个任务补齐？ | 决定 WP6b/WP9b/WP10b 何时解阻（P-1） | 用户（是否把 M5.5.1 收口作为独立任务立项） |
| **OQ-3** | INC-01 的 WP3/WP4/WP5 排在什么时候？ | 决定 WP6b 能否解阻（P-2）。组件 PASS ≠ 运行期保护生效 | 用户 / INC-01 独立任务 |
| **OQ-4** | ADR-043 重定向文件的过期状态段要不要另开收口载体修订？ | "同一概念两处权威"是本仓库明令禁止的；M6 不碰冻结面 | 用户（是否接受"仅登记、不修订"） |
| **OQ-5** | `.env` 与 `.env.test` 的端点/key **确实不同**（见 §9），但 `OPENAI_MODEL` 两个文件都没有 | 模型名来自代码缺省；WP9a/WP10b 需要它作为"固定模型配置指纹"的一部分 | WP9a 读取配置时确认（本轮只读键名，不读缺省值来源） |

---

## 9. 配置只读核对（白名单；**永不回显 key 取值**）

读数来源：`.env` / `.env.test` 的**文件文本**（本量具 **不 `import 'dotenv/config'`**，
因此 `process.env` 不参与，"这条读数是哪来的"可判）。每键按文件分别记长度。

| 文件 | 存在 | 字节 | sha256（前 12） |
|---|---|---|---|
| `.env` | 是 | 1017 | `0a9cb9f7b7f9` |
| `.env.test` | 是 | 941 | `b0f29f047d8f` |
| `.env.example` | 是 | 1532 | `c794d957dc11` |
| `.env.test.example` | 是 | 1863 | `92c0f1f1af46` |

| 键 | 出现在 | 值长度（逐文件） |
|---|---|---|
| `CHARACTER_WEB_SEARCH_ENABLED` | `.env` | `.env`: 4（与 ADR-048 记录的 `true` 长度一致；**本证据不承载取值**，权威是 ADR-048 与 `.env` 本身） |
| `CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS` | 无 | —（装配层启用时用代码缺省 800） |
| `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED` | 无 | —（走代码缺省：**关闭**） |
| `CHARACTER_MEMORY_BACKGROUND_ENABLED` | 无 | —（走代码缺省：**NOT-WIRED**，启动时如实告警） |
| `OPENAI_API_KEY` | `.env`, `.env.test` | `.env`: 35 · `.env.test`: 51 —— **取值未记录** |
| `OPENAI_BASE_URL`（非机密） | `.env`, `.env.test` | `.env`: 24 → `https://api.deepseek.com` · `.env.test`: 25 → `https://r.dis.115.zone/v1` |
| `OPENAI_MODEL` | 无 | — |

**判定**：AGENTS §8.1 的"按用途分两个文件"设计在本机**确实成立** ——
`.env`（真实聊天）与 `.env.test`（测试）指向**不同端点、不同 key**，
因此 `pnpm with-test-model` 的"绝不回落 `.env` 原 key"是一条**有实际保护面**的失败关闭，
而不是形式条款。（端点 host 与长度属既有 `scripts/run-with-test-model.ts` 已打印的非机密口径。）

---

## 10. 结论

```text
BASELINE CAPTURED
```

允许的主张：

1. 本 checkout 在 `1165fed` 上、位于 `main` 的进化线上并已含 M5.5.1 的全部 52 个提交；
2. 计划书 §1.2 的 15 条现场事实**逐条为真**；
3. 真实库**非易失内容字节**与 INC-01 证据记录的常量逐字相同，且 WP0 前后两次只读摘要一致；
4. WP0 窗口内**无并发写入**、无人在与真实库对话；
5. M5.5.1（P-1）与 INC-01 生产接线（P-2）**未满足**，WP6b 标 `BLOCKED`；
6. 量具自证（正控 / 负控 / 恢复 / 证据归属负控）**5/5 通过**，所有计数读数**非零**。

**不主张**（与计划书的纪律一致）：

- 不主张真实库历史完整、schema 版本正确，或 22:02 那次写入的来源；
- 不主张 M5.5.1 已收口，也不主张 INC-01 的运行期保护**已经生效**；
- 不主张 M5.5/M5.5.1 的任何 Live 结论可在 M6 的候选代码上复用（§9.2：运行相关树改变即失效）；
- 不主张本基线可以替代 WP9b/WP10b 的实测 —— 它只固定"起点"。
