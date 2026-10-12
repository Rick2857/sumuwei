# WP8-C1 Handoff — K-32 Frozen Evidence Restoration

> **执行令**：`WP8-B = PARTIAL / BLOCKED`；`K-32 = OPEN / P1 / BLOCKS WP8`；`K-33 = OPEN / P1 / BLOCKS WP8`。
> **只做 WP8-C1 / K-32，做完即 STOP；不得修 K-33，不得做 WP8 final requalification（那是 C3），不得开始 WP9。**

```text
Changed Files

  ✅ 数据（K-32 的修复本体）
    artifacts/m5.1/wp1-contracts.json           从 immutable 标签还原（52，无 counts 键）
    artifacts/m5.1/query-negative-control.json  从 immutable 标签还原（无 v8 期表名）
      —— 只还原用户点名的这两条；冻结目录里**没有**第三条路径与标签不同

  ✅ 量具（预览 / 应用分开，沿用仓库既有形状）
    scripts/verify-m5.1.1-wp8c1-k32-restoration.ts   pnpm m5.1.1:wp8c1:verify（只读、可反复跑）
    scripts/restore-m5.1-frozen-evidence.ts          pnpm m5.1.1:wp8c1:restore（显式动作）
    package.json                                     注册上面两条脚本

  ✅ 文档事实更正（**原文保留**，只在其后追加更正）
    docs/m5.1.1/M5.1.1-WP7-Compatible-Assertion-Record.md  §6
    docs/m5.1.1/WP7-Handoff.md                             Commit Hash 之后的更正块
    artifacts/m5.1.1/wp7-restore-whitelist.txt             末尾追加更正块（原有 18 行一字未改）

  ✅ 证据
    artifacts/m5.1.1/wp8c1-frozen-restoration.json  tag / tag target / path / historical blob / polluted blob / restored blob
    artifacts/m5.1.1/wp8c1-k32-verify.json · .log   K-32 门读数（15 / 0）
    artifacts/m5.1.1/wp8c1-restore.log · wp8c1-harness.log · wp8c1-k17.log · wp8c1-k19.log · wp8c1-gates-summary.log

  ❌ 没有改
    src/**（零行生产代码）· migrations.ts · schema（无 v9）· page.html · 查询/归因语义
    K-33 的判据（`scripts/verify-m5.1.1-wp3-backfill.ts` 一字未动）
    data/pglite（只读）

Tests Run

  pnpm typecheck                EXIT=0
  pnpm m5.1.1:wp8c1:restore     EXIT=0   （显式还原动作；内容只取自 `git checkout m5.1-complete -- <path>`）
  pnpm m5.1.1:wp8c1:verify      EXIT=0   **15 通过 / 0 失败｜K-32 = PASS**
  pnpm m5.1.1:wp8:verify        EXIT=1   49 通过 / 1 失败 —— 唯一失败 = `M511-G6`（wp3 / K-33）
  pnpm m5.1.1:k17:verify        EXIT=0
  pnpm m5.1.1:k19:verify        EXIT=0
  pnpm m5.1.1:gates             EXIT=1   G6 FAIL（K-33）· G9 **PASS**

Tests Passed

  K-32 门：15 / 0
    · 两条路径：工作树 blob == 索引 blob == **已提交的 HEAD blob** == `m5.1-complete:<path>` 的 blob
    · `artifacts/m5.1/**` + `artifacts/m4.5/**` 与标签整体无差异（变更集为空）
    · M5.1.1 期 fork 仍在（`wp7-wp1-contracts.json` 19965B · `wp7-query-negative-control.json` 12584B）
    · 标签未移动（tag object 2e718f38…）
    · 语义：无 `counts` 键、无 `developer_control_events` 表名
    · 三段式：正控安静 0 · **负控必响 2**（注入 K-32 实测的两个 polluted blob）· 恢复安静 0
    · 真实库指纹一致（mtime 2026-09-17T15:51:40.071Z · 1201 文件 · 31,289,946 字节）
  WP8 harness 的 `M511-G9` 从 **FAIL → PASS**：§7 约束④（`artifacts/m5.1/**` 一字未动）现在为 0

Tests Failed

  1 —— **故意保留**：`M511-G6`（红门 = `wp3`）＝ **K-33**，按执行令不在本 execution 修。
  ⇒ **WP8-B 仍然是 `PARTIAL / BLOCKED`**（49 / 1，不是 PASS）。

Evidence Produced

  artifacts/m5.1.1/wp8c1-frozen-restoration.json   还原全记录（含**污染 blob** 与历史 blob 对照）
  artifacts/m5.1.1/wp8c1-k32-verify.json/.log      K-32 门：15 / 0 + 三段式 + 真实库指纹
  artifacts/m5.1.1/wp8c1-harness.log               C1 之后的 WP8 harness 全文（G9 PASS · G6 FAIL）
  artifacts/m5.1.1/wp8c1-k17.log · wp8c1-k19.log   相邻门复跑
  artifacts/m5.1.1/wp8c1-gates-summary.log         汇总器（判定以 harness 当前 exit code 为准）

Known Issues

  1. **K-33 仍 OPEN / P1**（下一 execution：WP8-C2）—— `wp3` 的 K-23 结构性证明过宽，三个 offender
     全是读路径 / DTO。**本 WP 一字未动它的判据。**
  2. WP8-B 的**自有证据文件保持为 WP8-B 那一次的读数**（C1 改跑后的读数在 `wp8c1-*`）。
     `artifacts/m5.1/**` 是历史事实，`artifacts/m5.1.1/**` 是更晚的重跑事实 —— 这条边界现在有门守着。
  3. 读到一个**命名陷阱**（本 WP 只登记，C3 再让字段名显式化）：
     WP8 注册表里的 `M5L_FREEZE.commit = 2e718f38…` 其实是 **annotated tag object** 的 id，
     真正被指向的 commit 是 `2aac6cad…`（`git rev-list -n 1 m5.1-complete`）。
     用它做 `git diff <id>..HEAD` 是可行的（git 会 peel），但字段名容易被误读成 commit id。
  4. `artifacts/m5.1/` 的这两条路径**今后任何门重跑都会再次改写它们**（`m5.1:test` / `m5.1:query:verify`
     的规范证据名就在那里）⇒ 纪律必须长期成立：跑完**逐路径**还原，且还原目标 = 冻结 blob，
     **不是**当时的工作树 / HEAD。本 WP 已用 `pnpm m5.1.1:wp8c1:verify` 把这条盯住。

Architecture Deviations

  1. K-32 门检查**三面**（工作树 / 索引 / **已提交的 HEAD**），比执行令要求的最低限度更强：
     "冻结"是**仓库属性**，只保证工作树干净是不够的（WP7 的教训正是如此）。
  2. 还原做成**显式动作**（`m5.1.1:wp8c1:restore`），门本身**只读**、可反复跑 ——
     与仓库既有的 `pnpm migrate` / `migrate:apply` 同形。
  3. C1 的 harness 读数写到 `wp8c1-*`，WP8-B 的自有证据文件还原到 WP8-B 的读数：
     两代事实分开存放，避免"更晚的重跑覆盖更早的证据"再次发生。

Commit Hash

  504ecc1  fix(m5.1.1): restore the two frozen M5.1 artifacts from the immutable m5.1-complete tag (K-32)
  2a52a79  test(m5.1.1): add the K-32 frozen-evidence gate and an explicit restore action
  （本 handoff 与其配套的 WP7 措辞更正、执行计划 R-39 在同一份 docs 提交里 —— 该提交本身不列在此）

Next WP Preconditions（**不要在本 execution 开始**）

  1. **WP8-C2 / K-33**：把 wp3 的 K-23 结构性证明从"哪些源码文件出现 `recordedBy` 字样"
     改成"**哪些 production write path 能向权威列提供值**"。用户已明确要求它带三类 control：
     真 write path **必须被命中**（measured_count > 0）；读回映射 / DTO / query 映射**不计为 writer**；
     注入"调用方提供的 recordedBy"或"第二个权威 writer"⇒ **门必响**；恢复后重新安静。
     验收：`pnpm m5.1.1:wp3:verify` = PASS 且上述三条同时成立，不改生产语义、不改 schema、不碰真库。
  2. **WP8-C3 / Full Harness Requalification**（只有 C1、C2 都 PASS 之后）：重跑
     `pnpm m5.1.1:wp8:verify` + `pnpm m5.1.1:gates`，目标 G1–G7 PASS · G8 NOT RUN · G9 PASS ·
     `measurementInvalid = 0` · `crossGateConsistencyViolations = 0` ⇒ 那时才 `WP8 = PASS`、
     `WP9 = READY / AUTHORIZED`。
  3. K-31 仍 OPEN / DEFERRED；Phase 4 / ADR-043 仍 NOT APPROVED；`m4.5:ci` / `m5.1:regression:verify` 仍留给 WP10。

STOP
```
