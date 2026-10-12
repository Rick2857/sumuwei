# M6 · WP2 Handoff

> 分支 `feature/m6-lv1-hardening` · 被测代码提交 `70beb9b` · 量具 `runId` = `m6-wp2-20260921-70beb9b552b7`
> 设计权威：[ADR-050 §10 裁定记录](docs/adr/ADR-050-rolling-summary-provenance-boundary.md)（`ACCEPTED / DESIGN FROZEN`）
> 机器证据：`artifacts/m6/m6-wp2-20260921-70beb9b552b7/rollup-unit.json`（**59/59 · 0 失败 · 0 MEASUREMENT INVALID**）

---

## 1. 当前 WP / 状态

**WP2（摘要纯逻辑）＝ 部件门 PASS。** 出口条件（计划书 WP2："部件门正负控通过"）已满足。

| 已做 | 未做（刻意） |
|---|---|
| 契约层：`RollupItem` / `RollupSourceFacts` / 五类拒绝理由闭集 / 逐字渲染 | **没有**接线（`turn-gateway` / `sections.ts` **一个字节未改**） |
| 选择层：`selectRollup()` 五道闸 + Recent 去重 + 预算试装 + 覆盖/拒绝计数 | **没有**新增任何 `ContextSectionProvider`（那是 WP3） |
| 预算契约：`rollupTokens`（缺省 0）+ 第 7 类 `rolling_summary` + 断言同步 | **没有**改动 prompt 冻结基线（`evals/fixtures/m3.5/prompt-baseline.txt` 未动） |
| 部件门 59 项断言（正控/负控/恢复 + 量具自证 + 范围自检） | **没有**打开真实库、**没有**跑模型/搜索 |
| 静态锁登记（纯召回层文件清单） | **没有**开任何 flag、**没有**生产激活 |

---

## 2. branch / HEAD / 提交链

| 提交 | 内容 |
|---|---|
| `7119f0d` | `feat(contracts): add the rollup excerpt contract (ADR-050)` |
| `bce999a` | `feat(recall): add the rolling-summary selector`（+ 静态锁登记） |
| `70beb9b` | `feat(recall): add the rolling-summary budget category (ADR-050 DR-7)` ← **被测代码提交** |
| （本提交） | 门脚本 + 证据 + 本 Handoff + 受影响面一行更新 |

证据里的 `head` = `70beb9b` = **被测代码提交**；证据文件本身落在紧随其后的纯证据提交里
（计划书 §9.2：纯报告提交可以引用被测提交）。工作树在提交前只有一条外来改动
（` M artifacts/incidents/inc-01/wp1-lease.json`，**原字节保留**）。

---

## 3. 输入依据与本轮沿用的授权

| 依据 | 说明 |
|---|---|
| 用户「继续」+ **一次性执行授权**（裁定记录 ADR-050 §10） | 授权范围 = 直接进入 WP2：领域层纯逻辑 + 部件门 |
| ADR-050 §1（12 条裁定）与 §10（四条裁定 + 四条实现约束） | 本轮逐条对照实现，**没有偷换形态** |
| `M6-Acceptance-Contract.md` §3（样例集）/ §4.2（G2 的硬零项）/ §6（预算） | 部件门按这些判据组织 |
| **未沿用** | WP3 及以后的接线 · Live 门 · 生产激活 · 真实库迁移/恢复 · 打标签 |

---

## 4. 有意修改的文件与原因

| 文件 | 性质 | 为什么 |
|---|---|---|
| `src/kernel/contracts/rollup.ts` | 新增（277 行） | 契约 + 逐字渲染 + 五类拒绝理由闭集；与 `contracts/external-evidence.ts` 同形 |
| `src/kernel/contracts/index.ts` | +1 行 | 导出新契约 |
| `src/kernel/recall/rollup.ts` | 新增（177 行） | 选择逻辑（纯函数）；`recall/` 的既有职责原文就含"选择" |
| `src/kernel/recall/selector.ts` | 改 | `rollupTokens` 必填（缺省 0）+ 第 7 类 + 断言纳入摘要额度 |
| `scripts/verify-m5-budget.ts` | 改 | **断言同步更新**：六类→七类、账目恒等式多一项、+2 条摘要判据、+1 条负控、11 处字面量补齐 |
| `scripts/verify-m5-eligibility.ts` | 改（+17 行） | **登记**新文件到"纯召回层文件清单"这条静态锁（见 §7 F-9） |
| `scripts/verify-m6-wp2-rollup.ts` | 新增 | WP2 部件门（59 项断言） |
| `docs/m6/M6-Affected-Surface-Map.md` | 改 1 行 | 预算那一行的"当前行为"随 WP2 落地更新（该文件是**活文档**，不是冻结证据） |
| `artifacts/m6/m6-wp2-20260921-70beb9b552b7/rollup-unit.json` | 新增 | 门产出的机器证据 |

**没有**新增 npm 命令（`package.json` 未改）：命令面仍留给 WP4 按计划 §9.1 定义。

---

## 5. 命令、退出码、断言数、失败/跳过、证据路径

| 命令 | 退出码 | 读数（逐字取自 stdout） |
|---|---|---|
| `pnpm typecheck` | **0** | 全仓 `tsc --noEmit`，0 错误（含新增两份 `.ts` 与门脚本） |
| `pnpm kernel:test` | **0** | `Kernel 契约测试：26 通过 / 0 失败（14ms）` |
| `pnpm kernel:verify` | **0** | `Phase C 结果：25 通过 / 0 失败` |
| `pnpm m5:test` | **0** | `M5 WP1 Recall 契约测试：30 通过 / 0 失败（4ms）` |
| `pnpm m5:verify` | 第一次 **1** → 修后 **0** | 第一次：`25 通过 / 1 失败`（`⑥ 静态锁：纯召回层的文件清单`，见 §7 F-9）；登记后：`26 通过 / 0 失败（570ms）` |
| `pnpm m5:budget:verify` | **0** | `M5 WP5 Context Selector & Budget：35 通过 / 0 失败` |
| `pnpm m5:e2e:verify` | **0** | `M5 WP8 NL E2E（A–H）：28 通过 / 0 失败` |
| `pnpm exec tsx scripts/verify-m6-wp2-rollup.ts` | **0** | `PASS — 59/59 通过，失败 0，MEASUREMENT INVALID 0` |

**为什么跑 `m5:e2e:verify` 而不是 `m5:nl-e2e:verify`**：后者在 `package.json` 里**不存在**
（AGENTS §5 的旧别名，见 §7 F-11）；真实名字是 `m5:e2e:verify`（计划书 §10.1 列的正是它）。

### 5.1 冻结面保护（AGENTS §3/§7 的程序，本轮**真的走到了**）

`m5:test` / `m5:verify` / `m5:budget:verify` / `m5:e2e:verify` 都会**写进冻结子树 `artifacts/m5/**`**。
本轮按纪律执行"跑 → 读数 → 白名单还原 → 字节对照"：

| 路径 | 还原前（工作树） | 还原后（工作树） | HEAD blob | 结论 |
|---|---|---|---|---|
| `artifacts/m5/wp1-contracts.json` | `feb0bcae0f` | `4ce760827d` | `4ce760827d` | ✅ 逐字节相同 |
| `artifacts/m5/wp2-eligibility.json` | `b6f650aa45` | `11c4cef372` | `11c4cef372` | ✅ 逐字节相同 |
| `artifacts/m5/wp5-context-budget.json` | `2621563d89` | `870b52fdd4` | `870b52fdd4` | ✅ 逐字节相同 |
| `artifacts/m5/wp8-e2e.json` | `1c2c8bb822` | `7408282d34` | `7408282d34` | ✅ 逐字节相同 |

`mismatch = 0`；还原后 `git status --porcelain -- artifacts` 只剩外来改动与我方的 `artifacts/m6/**`。
**冻结子树哈希复核**：`HEAD:artifacts/m5` = `96a90855f06757b0f2d75c614d22a19bcbf13606`、
`HEAD:artifacts/m5.1` = `8f464509f29522cae6b2963dc87478621647b1e2` —— 与
`artifacts/m5.5/baseline.json` 的 `historicalEvidence.subtrees` **逐字相同**（顺带证明了这两棵子树自该基线以来未变）。

---

## 6. 沙箱 / 真实库边界读数与限制

| 读数 | 值 |
|---|---|
| 真实库是否被打开 | **否**（WP2 全程不碰数据库：门只调用纯函数） |
| 模型调用 | **0 次**（`DR-2`：v1 不引入任何模型调用） |
| 持久化写入 | **0**（`DR-1`：摘要零写入） |
| 真实库摘要 | 沿用 WP0 的 `be957694b8a1173a…c500`（本轮未重采） |

**限制**：部件门证明的是**纯逻辑**的性质；它**不能**证明"送进模型的 packet 里确实没有非法来源"
（那需要 `ContextCompiler` 级证据）· 也**不能**证明"摘要为空时 prompt 与基线逐字节相同"
（那需要接线后的 packet）。两条都属于 **WP3**，本轮**不主张**。

---

## 7. 新发现问题、阻塞、偏差，以及**没有扩大的**能力主张

### 7.1 新发现

| ID | 发现 | 影响 |
|---|---|---|
| **F-9** | 新增 `src/kernel/recall/rollup.ts` 触发了 `m5:verify` 的静态锁「纯召回层的文件清单是**被审阅过的**」（`verify-m5-eligibility.ts:681-698`） | 已按**仓库自己的先例**（`qualification.ts` 在 M5.1.1 Phase 4b 就是这样登记的）**显式登记**并写明理由。**这不是放宽判据**：锁的原意（只有被审阅的文件能待在这个目录）被完整保留 |
| **F-10** | 量具**第一版**把"命中**次数**"（11）报成了"理由**种类**数"（应为 5） | 数字是真的，但它量的不是标签说的那件事 —— AGENTS §6.9 的第二种形态。已拆成两个计数器（种类/次数）并加断言"五类必须全部被真的触发过"。**这是量具自证抓出来的，不是我以为它没问题** |
| **F-11** | `pnpm m5:nl-e2e:verify` **不存在**（`bad revision`/无此脚本） | AGENTS §5 的该行是**旧别名**；真实名字是 `m5:e2e:verify`（计划书 §10.1 正确）。已按真实名字执行 |
| **F-12** | **没有 `m5-complete` 标签**（`git rev-parse m5-complete` = bad revision） | M5 的冻结证据靠 `m5.1-complete` 可达（`git diff m5.1-complete HEAD -- artifacts/m5` 为空）。历史标签清单：`m4-acceptance-rc1/rc2`、`m4-complete`、`m5.1-complete`、`m5.1.1-complete`、`m5.5-complete` |
| **F-13** | 四条 M5 门都会**写进冻结子树** `artifacts/m5/**`（每次跑必改） | 已按白名单还原并留字节对照。这是 M6 后续每个触发 M5 门的包（WP3/WP10a）**都会承担**的纪律负担 —— 登记为已知成本，不是缺陷 |

### 7.2 阻塞（继承，未变化）

**P-1**（M5.5.1 无 WP8/收口记录与标签）· **P-2**（INC-01 WP3/WP4/WP5 未落地）⇒ `WP6b = BLOCKED`；
因此 `M6 = PASS` 仍**不可达**。WP2 不受影响。

### 7.3 偏差（如实登记）

| # | 偏差 | 理由 |
|---|---|---|
| **B-6** | 纯逻辑的**模块归属**：落在 `src/kernel/recall/rollup.ts`（计划书 WP2 的文件列写的是 `kernel/context`） | 我核对了 `src/kernel/context/**` 与 `src/kernel/recall/**` 的**全部** import：两者**都只依赖 `../contracts/`**。把渲染放 `contracts/rollup.ts`（与 `contracts/external-evidence.ts` 的 `renderExternalEvidenceBlock` 同形）、把选择放 `recall/`，可以**保持这条 import 方向不变**；若把选择放进 `context/`，WP3 的 provider 就不得不让 `context/` 反向依赖 `recall/`（或复制一份渲染）。代价是触发了 F-9 的静态锁，已按先例登记 |
| **B-7** | 预算**契约**落在 WP2（ADR-050 §6 的落地表把"预算"划给 WP3） | 字段与类别是**纯契约**，且选择器的入参就需要它；WP3 只负责把**值**传进来。这条拆分把"契约"与"接线"分开，与"WP2 不接线"一致 |
| **B-8** | 契约**新增**一个字段 `skippedByRecentWindow`（ADR-050 §3.1 的草图里没有） | 去重若不计入任何计数器就是**静默丢弃**。新增独立计数器是**扩展**不是矛盾（"与 Recent 重叠"≠"被拒绝"），且让去重可审计 |
| **B-9** | 改了 `scripts/verify-m5-eligibility.ts`（一份既有门） | F-9 的登记只能在那里做。**判据未放宽**：文件清单的语义（必须被审阅过）不变，只是把新文件加入审阅结果并写明理由 |

### 7.4 本轮**没有**扩大的能力主张

- 没有主张摘要已经"进上下文"（**未接线**，今天它在生产路径上不产生任何 section）；
- 没有主张 prompt 基线未被破坏（那需要 packet 级证据，属 WP3；本轮只能证明"块为空 ⇒ 渲染为空串"这条**机制**）；
- 没有主张覆盖全部历史（超限如实标 `coverageTruncated`）；
- 没有主张她不会再说错（ADR-043 `DR-11` 照旧）；
- 没有主张部件门的 59 项等于产品正确（它只证明"纯逻辑逐条满足冻结判据"）。

---

## 8. 下一包的准确入口、必读文件与 STOP 点

**下一包 = WP3（接线与全局上下文）**，出口 = 接线门 PASS。

| 项 | 内容 |
|---|---|
| 必读 | ADR-050 §1 `DR-8`/`DR-9`/`DR-10` + §3.5 · `M6-Acceptance-Contract.md` §4.3（M6-G3 的硬零）· `src/kernel/context/sections.ts`（`createMemoryRecallProvider` 是形状模板）· `src/kernel/app/turn-gateway.ts:868-972` |
| 要做的（且**只能**这么做） | ① 在 `turn-gateway` 构造 `extraProviders` 的那一段加一个 rollup provider（`render: () => ({text, sourceRefs})`，**空 ⇒ 产 0 section**）；② 只读来源端口（有界，不绕过 owner/user/资格检查）；③ 把 `rollupTokens` 的值传进编译器；④ **不得**改 `buildContextCompilerV2` 的默认 provider 列表（`DR-8` 的承诺） |
| 必跑门 | `typecheck` · `m3.5:test`（prompt 逐字节基线）· `eval:scenarios` · `eval:dryrun` · `eval:providers` · `m5:budget:verify` |
| 必须新增的负控（R-2 已裁定） | "摘要为空时 `packet.text` 与 `evals/fixtures/m3.5/prompt-baseline.txt` **逐字节相同**" |
| **STOP 点** | 接线门 PASS 后 STOP；**不得**顺手做开发者面（WP5）或故障注入（WP6a） |
| STOP 条件 | 需要重刷 prompt 基线 / 需要真实库 / 需要放宽阈值 / 量具无非零正控 / 冻结面被改动 |
