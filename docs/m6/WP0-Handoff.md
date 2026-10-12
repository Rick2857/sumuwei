# M6 · WP0 Handoff

> `runId`：`m6-wp0-20260921-1165fedcdde2` · 分支 `feature/m6-lv1-hardening` · 基点 `1165fedcdde2065d41eeeb1b12a635091b4d721a`
> 机器证据（**权威读数**）：`artifacts/m6/m6-wp0-20260921-1165fedcdde2/{baseline.json, manifest.json, source-tree-index.before.txt}`
> 本文件是**报告**，不手写全绿表格：每个数字都可回到上面三份机器证据（AGENTS §6.4）。

---

## 1. 当前 WP / 状态

**WP0（基线与前置核对）＝ `BASELINE CAPTURED`**（定案字段：`baseline.json.verdict`）。

| 已做 | 未做（刻意） |
|---|---|
| 从 `1165fed` 建立 `feature/m6-lv1-hardening` | 没有改任何 `src/**` 生产代码 |
| 只读复核计划书 §1.2 的 15 条事实（逐条对得上） | 没有打开真实库、没有跑任何真实库 CLI |
| 真实库 + 源码树**只读**内容树摘要（两次采样） | 没有跑模型 / 没有跑搜索 |
| 12 条前置证据索引（含 2 条取代关系、2 条缺失登记） | 没有迁移 / 快照 / 恢复 |
| 9 段链路图 + 拟改文件与门的映射 | 没有还原/提交/覆盖他人的 `wp1-lease.json` 改动 |
| `.env` 系列只读核对（键名 + 长度，**不含取值**） | 没有建 ADR、没有写 WP1 的设计内容 |
| 并发与共享文件边界读数 | 没有打标签 / 合并 / 开 auto_public |
| 新量具 + 其正控/负控/恢复自证（5/5 PASS） | 没有跑任何里程碑门（理由见 §5） |
| `docs/m6/{M6-Baseline,M6-Affected-Surface-Map,WP0-Handoff}.md` | 没有推进 M5.5.1 收口或 INC-01 的 WP3+（那是它们自己的里程碑） |

---

## 2. branch / HEAD / 树哈希 / 未提交文件归属

| 项 | 读数（`baseline.json.git`） |
|---|---|
| WP0 起始分支 | `feature/m5.5.1-adaptive-search` |
| WP0 起始 HEAD | `1165fedcdde2065d41eeeb1b12a635091b4d721a` |
| 本轮工作分支 | `feature/m6-lv1-hardening`（从上述 HEAD 建立，**未移动任何既有标签**） |
| `main` | `68fed604fb3338d27f3697a9afc1e89adbf90211`，`aheadOfMain = 52` · `behindMain = 0` · `mainIsAncestor = true` |
| `git stash` | 0 |
| 运行相关树哈希（采样时） | `baseline.json.digests.sourceTree.before.treeSha256` = `138a273cf6c1875d965665aee2da243fa83f556f43cb93f4e0c8c98b1ab56c16`（1271 文件 / 18,470,789 字节） |
| 采样后是否变化 | 见 `baseline.json.verification`（`--phase verify` 的机器判定） |

**未提交文件归属**（`git.status --porcelain=v1 --no-renames -z`，逐路径）：

| 状态 | 路径 | 归属 | 处置 |
|---|---|---|---|
| ` M` | `artifacts/incidents/inc-01/wp1-lease.json` | **other-task**（INC-01 WP1/WP2 证据重跑遗留） | **保留原字节**：未 `checkout`、未 `stash`、未提交 |
| `??` | `docs/m6/` | `m6-wp0` | 本轮按 §9.2 入库（计划书原样 + 三份 WP0 文档） |
| `??` | `scripts/m6-wp0-baseline.ts` | `m6-wp0` | 本轮入库（量具） |

`counters.unknownDirtyPaths = 0` ⇒ **没有归属不明的改动**。

> **摘要口径的一处边界**（必须一起读）：本机 `core.autocrlf = true`（`core.eol` 未设）。
> 本轮工作副本是 **LF**（计划书工作副本 sha256 `ae6c1046…33ebc2` 与 git blob `5280f48e…` 都基于 LF，
> 没有 CRLF 分歧）。但**源码树摘要是工作树字节摘要**，因此若将来某次 `git checkout`
> 把行尾改写成 CRLF，同一个提交会算出不同的 `treeSha256`。
> 结论：它是**同一 checkout 内的变更检测指纹**，不是"克隆间可移植的提交指纹"。
> WP10a/WP10b 的"运行相关树未变"判定在同一 checkout 内成立，不受此影响。

---

## 3. 输入依据与本轮沿用的授权

| 依据 | 说明 |
|---|---|
| 用户附上的 `M6-DSH-Execution-Plan.md` | 已核对与 `docs/m6/M6-DSH-Execution-Plan.md` **逐字相同**（sha256 `ae6c1046…33ebc2`，51,818 字节） |
| 用户对本轮计划的**批准**（plan mode 的 `exit_plan_mode` 通过） | 授权范围 = **A 审阅 + B WP0**：建分支、新增量具与证据、4 个提交 |
| **未**沿用的授权 | M6 后续 WP、Live 门、生产激活、真实库迁移/恢复、`m6-complete` 标签、真实库写入 |
| 只读口径 | 沿用 AGENTS §8.1 的既有非机密读数口径（endpoint host / key 存在性+长度；**取值不打印**） |

**本轮明确不主张**：计划书批准 ≠ 实施授权 ≠ 生产激活 ≠ 真实库变更 ≠ 打标签。

---

## 4. 有意修改的文件与原因

| 文件 | 性质 | 为什么 |
|---|---|---|
| `docs/m6/M6-DSH-Execution-Plan.md` | 入库（**内容未改一个字节**） | 不提交它，M6 分支的最终候选里就没有自己的计划权威源，且工作树会永远挂一条 untracked |
| `scripts/m6-wp0-baseline.ts` | 新增（量具，600+ 行） | WP0 的读数必须是**机器产出**而不是手写表格（AGENTS §6.4/§6.8） |
| `docs/m6/M6-Baseline.md` | 新增 | 计划书 WP0 交付物 |
| `docs/m6/M6-Affected-Surface-Map.md` | 新增 | 计划书 WP0 交付物；含 R-2/R-3 两条审阅发现 |
| `docs/m6/WP0-Handoff.md` | 新增（本文件） | 计划书 §12 的八项交接 |
| `artifacts/m6/<runId>/baseline.json` | 新增（机器证据） | 唯一权威读数载体 |
| `artifacts/m6/<runId>/manifest.json` | 新增（机器证据） | §9.2 的 manifest 字段集 |
| `artifacts/m6/<runId>/source-tree-index.before.txt` | 新增（摘要原像） | 让 `treeSha256` 可被独立重算；同时避免把 260KB 内联进 `baseline.json` |

**没有任何 `src/**` 改动**。**没有**新增 npm 命令（`package.json` 未改）：命令面留给 WP4 按计划 §9.1 一次定义，
避免现在造一次性命令。

---

## 5. 命令、退出码、断言数、失败/跳过、证据路径

| 命令 | 退出码 | 有效读数 / 失败 / 跳过 |
|---|---|---|
| `pnpm typecheck` | **0** | 全仓 `tsc --noEmit`（`include = src/** scripts/** evals/**`），0 错误。这是 AGENTS §5 第一行要求的门 |
| `pnpm exec tsx scripts/m6-wp0-baseline.ts --out artifacts/m6/m6-wp0-20260921-1165fedcdde2` | **0** | `before` 采样：真实库 1205 文件 / 源码树 1271 文件 / 证据 12 条 / 链路 9 段；**0 失败、0 跳过** |
| `pnpm typecheck`（量具每次改动后） | **0** | 共 4 次（新增量具 → 原像 sidecar → `verify` 段 → env 逐文件长度），最后一次为定稿 |
| `... --phase after` | 见 §9 | 第二次采样 |
| `... --phase verify` | 见 §9 | 采样后树一致性判定 |

**量具自证（三段式）**：`measurementSelfTest.cases` = `P1` `P2`（正控）· `N1` `N2`（负控）· `R1`（恢复），
**5/5 PASS**，`counters.measurementSelfTestFailures = 0`。

**哪些门没跑（以及为什么这不是漏做）**：本轮零生产代码改动，因此**不跑**任何里程碑门。
`pnpm m4.5:ci` / `m4.5:gates` 等会重写 `artifacts/` 里的历史证据（AGENTS §3/§7），
在 WP0 跑它们既是浪费也会污染历史证据。它们由 WP10a 负责。
**WP0 没有"跳过"任何它该跑的断言**：它的判据就是量具自证 + 计数非零 + 具名 diff。

**证据路径与哈希**（`manifest.evidence`）：

```
artifacts/m6/m6-wp0-20260921-1165fedcdde2/baseline.json               33,457 B  sha256 79037f402e4a1cbd…
artifacts/m6/m6-wp0-20260921-1165fedcdde2/manifest.json               10,321 B  sha256 11501003119fc38e…
artifacts/m6/m6-wp0-20260921-1165fedcdde2/source-tree-index.before.txt 138,748 B sha256 138a273cf6c1875d…（= before 树哈希本身）
```

---

## 6. 沙箱 / 真实库边界读数和限制

| 读数 | 值 | 限制（必须一起读） |
|---|---|---|
| `PROJECT_LG_SANDBOX` | **未设置**（`manifest.sandboxIdentity.projectLgSandboxSet = false`） | 这是**预期**：本量具不打开任何数据库，因此不需要 `isolateDatabase()`。它不是"忘了隔离" |
| 真实库内容树摘要 | `be957694b8a1173aa3da49e8b942fc1e69ddaab1cb5971a6bd5c00863555c500`（1205 文件 / 31,584,799 B） | **只读字节**。与 `scripts/verify-inc-01-wp1.ts:41` 的 `WP0_REAL_DB_NONVOLATILE` 及 `wp1-lease.json` 的 `nonVolatileTreeBefore/After` **逐字相同** |
| 真实库 mtime | 最新 `2026-09-20T14:02:55.698Z`；最近 1.5h 改动 **0** 个；最近 12h **26** 个 | mtime 只回答"有没有人碰过"，**不回答**"写了什么、谁写的"（见 §7 OQ-1） |
| 被排除的文件 | `postmaster.pid`（易失运行态） | 常量是 **import** 自 `production-db-safety.ts`，不是另抄一份 |
| 真实库是否被打开 | **否**（`digestTree` 只读文件字节，不 import PGlite） | 因此**不**主张 schema 版本、历史完整性 |
| 源码树摘要 | `138a273cf6c1875d…`（1271 文件 / 18,470,789 B） | 排除 `.git/ node_modules/ data/ dist/ artifacts/m6/`；算法定义与真实库摘要**不同**，两者禁止互换 |

**限制（明确写下，防止被误用）**：

1. 本轮**没有**验证真实库的 schema 版本或历史完整性 —— 事故报告已记录过快照恢复造成的历史断档，该缺口保留。
2. 本轮**不**主张 M5.5/M5.5.1 的任何 Live 结论可在 M6 候选代码上复用（§9.2：运行相关树一改即失效）。
3. "无并发写入"是**一次窗口读数**，不是对未来的保证；WP9b/WP10b 长时运行前必须重取。
4. 源码树摘要是**工作树字节**摘要，受 `core.autocrlf`（本机 `true`）影响 ⇒ 它是同一 checkout 内的变更检测指纹，
   不是跨克隆可移植的提交指纹（详见 §2 的边界说明）。

---

## 7. 新发现问题、阻塞、偏差，以及**没有扩大的**能力主张

### 7.1 新发现（4 条，全部已进机器证据）

| ID | 发现 | 影响 |
|---|---|---|
| **F-1** | 真实库内容摘要与 INC-01 记录常量**逐字相同**，且最近 1.5h 零改动 ⇒ 22:02:55 那次写入发生在 INC-01 WP1 读数（`14:29Z`）**之前** | 计划 §1.2 的"引用 M5.5 收尾的前后一致"可以升级为"M6 WP0 亲自取到同一摘要"；但**不能**升级为"历史完整" |
| **F-2** | `extraProviders` 扩展点已存在于两个编译器工厂（`sections.ts:722/739/791`），生产装配在 `turn-gateway.ts:868-972` | 摘要**不需要**改编译器；同时给出"能不刷冻结 prompt 基线"的具体路径（R-2） |
| **F-3** | `.env` 与 `.env.test` 的**端点/key 确实不同**（`api.deepseek.com` 24 / `r.dis.115.zone/v1` 25；key 长度 35 / 51） | AGENTS §8.1 的"两个文件"设计在本机成立，`with-test-model` 的失败关闭**有实际保护面** |
| **F-4** | `ADR-043-legacy-…md` 是 REDIRECT 文件，但其状态段仍写 `Phase 4 NOT RUN / D01 OPEN / Final BLOCKED`（已被 ADR-044 取代） | "同一概念两处权威"的隐患：**仅登记为 `superseded`**，M6 不改冻结面（OQ-4） |

### 7.2 阻塞（2 条，来自计划 §2.2 的前置）

| 阻塞 | 现状 | 受影响包 |
|---|---|---|
| **P-1** M5.5.1 候选与收口 | R2 记录与 r2-9 证据在；**无 WP8 记录、无收官记录、无 `m5.5.1-complete` 标签** | WP6b · WP9b · WP10b |
| **P-2** INC-01 运行期保护 | 组件在；**WP3/WP4/WP5 未落地**，`src/main.ts` 零引用保护模块 | WP6b = `BLOCKED` |

### 7.3 偏差（如实登记）

| # | 偏差 | 理由 |
|---|---|---|
| B-1 | 本轮**建了分支**（`feature/m6-lv1-hardening`），而计划书 WP0 的"前置"只写了"执行授权" | 计划 §5 要求"开工从被批准的整合基线建立 `feature/m6-lv1-hardening`"。基点取**运行时 HEAD**（`1165fed`），并在 `baseline.json` 里留下 `mainIsAncestor = true` 的机器判据 |
| B-2 | 量具是**新写的脚本**（计划 §9.1 只提了 4 个 `m6:*` 入口，没提 WP0 的量具） | WP0 的读数必须机器产出；且该脚本**不新增 npm 命令**，WP4 会把它并入 `m6:verify` 套件 |
| B-3 | 量具在定稿前改过 4 轮（原像 sidecar / `verify` 段 / env 逐文件长度） | 前两轮暴露了真实缺陷：`perFile` 内联把 `baseline.json` 撑到 264KB（不可复核）；`valueLength` 把两个文件合并成一个数，导致"两个端点是否相同"**在证据里无法回答**（AGENTS §6.9 的第二种形态）。两次采样均使用**定稿后**的脚本 |

### 7.4 本轮**没有**扩大的能力主张（逐条）

- 没有因为"内容摘要相同"就主张真实库历史完整；
- 没有因为 WP1/WP2 有证据就主张 INC-01 生产保护**已生效**；
- 没有把 M5.5.1 的 R2 `PASS` 当作 M6 候选代码上的 Live 结论；
- 没有把 `.env` 里 `CHARACTER_WEB_SEARCH_ENABLED` 的存在读成"搜索质量达标"（存在性 ≠ 相关性 ≠ 稳定性）；
- 没有把"量具 5/5 PASS"读成"产品正确"（量具只证明"它量到了它要量的东西"）。

---

## 8. 下一包的准确入口、必读文件与 STOP 点

**下一包 = WP1（设计冻结与验收契约）**，出口 = `DESIGN FROZEN` 或具体裁定包。

| 入口 | 内容 |
|---|---|
| 必读（按顺序） | `docs/m6/M6-Baseline.md`（本文档旁）→ `docs/m6/M6-Affected-Surface-Map.md` → 本文件 → `docs/m6/M6-DSH-Execution-Plan.md` §3.1/§4/§6(WP1)/§9 |
| 涉及模块时才打开 | `src/kernel/context/sections.ts`、`src/kernel/recall/selector.ts`、`src/kernel/app/turn-gateway.ts`、`docs/adr/ADR-043-epistemic-requalification.md`、`docs/m5.1/M5.1-Authority-Map.md`、`docs/architecture/cognitive-integrity.md` |
| 必须提交的裁定 | **R-2**（provider 插入点 / 是否承诺 prompt 基线一字节不动）· **R-3**（摘要额度：复用 `reservedTokens` vs 新增字段/类别）· **D-1** · **D-2** |
| 产出 | `docs/m6/M6-Acceptance-Contract.md` + **ADR-050**（ADR-049 已占，已核对无 ADR-050；**不预占、不覆写 ADR-049**）+ WP1 Handoff |
| **STOP 点** | D1/D2 获批后进入 WP2；**未获批的设计不得进入 WP2**。WP1 不得顺带实现摘要 |
| STOP 条件（遇即停并保存证据） | 目标连到真实库 / 需要迁移或恢复 / INC-01 保护未接线却要做生产副本长时验证 / 要放宽阈值或删失败样本 / 量具无非零正控 / 共享文件被另一任务改动 |

**本 WP0 到此 STOP。** 不开始 WP1，不实施摘要，不跑 Live，不动真实库。

---

## 9. 采样后读数（`after` + `verify`）

> 本节的三次采样读数由 `--phase after` 与 `--phase verify` 落盘，权威字段：
> `baseline.json.digests.*.stability` · `baseline.json.verification` · `baseline.json.verdict`。
> 本文件在所有采样之后仍有纯文档编辑，因此按计划 §9.2 的"新的纯报告提交可以引用被测提交"处理，
> 并由 `verification.unexpectedChangedSinceAfterSample = 0` **机器证明**"采样后只变了 WP0 自产的纯文档"。

| 采样 | 读数（读自 `baseline.json`） |
|---|---|
| `after`：真实库稳定性 | **`unchanged`** —— 两次只读摘要逐字相同（`be957694b8a1173a…c500`，1205 文件 / 31,584,799 B） |
| `after`：源码树稳定性 | **`changed`**，`changedFiles` **恰为 3 条**，全部 `added` + `wp0-authored`：`docs/m6/M6-Affected-Surface-Map.md`、`docs/m6/M6-Baseline.md`、`docs/m6/WP0-Handoff.md`；`unexpectedChangedFiles = 0` |
| `after`：采样树哈希 | `9e21cbcf730c7ef13df9571cd14c0bda28181ed717ed2347bb52f298088b1235`（1274 文件 / 18,522,155 B），原像 `source-tree-index.after.txt` |
| `verify`：采样后一致性 | 由最后一次 `--phase verify` 判定，属于**机制**而非声明：`unexpectedChangedSinceAfterSample = 0` ⇒ `verification.verdict = OK`；否则脚本自动把 `verdict` 降为 `PARTIAL`。读数见 `baseline.json.verification` |
| **最终** | `baseline.json.verdict` = **`BASELINE CAPTURED`** |

**说明**：本文件（§9 的填写）就是 `after` 采样之后**唯一**的编辑，因此 `verify` 阶段预期只看到
`docs/m6/WP0-Handoff.md` 一条 `wp0-authored` 改动 —— 这正是计划 §9.2 允许的
"新的纯报告提交可以引用被测提交"。判据在脚本里（`--phase verify`），不在报告里。
