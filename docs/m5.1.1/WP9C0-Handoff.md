# WP9-C0 Handoff —— Canonical E4 Acceptance Boundary Review

**判定：`WP9-C0 = COMPLETE`（复核完成，EXIT=0 · 43 通过 / 0 失败）**
**`Canonical E4/S3` 归属 = 未收口 · 交回用户裁定（`Q1` / `Q2`）**
**`WP9 = PARTIAL / BLOCKED`（不变）** · **`WP9-C1 Final Requalification = NOT READY`** · **`WP10 = NOT AUTHORIZED`**

日期：2026-09-19 · 上游：`WP9-A = PASS` · `WP9-B1 = PASS` · `WP9-B2 = PASS`（范围见 R-47）
执行令：用户 **R-47 §5** —— `READ ONLY` · `No production changes` · `No verifier criterion changes` · 做完即 **STOP**

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `scripts/verify-m5.1.1-wp9c0-e4-boundary.ts`（**新增**只读复核仪器）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` **+1 条分类**，带理由）· `package.json`（`+ "m5.1.1:wp9c0:verify"`）· `docs/m5.1.1/M5.1.1-WP9C0-E4-Acceptance-Boundary-Review.md`（**新增**复核记录）· `docs/m5.1.1/WP9C0-Handoff.md`（本文件）· `docs/m5.1.1/M5.1.1-Execution-Plan.md`（追加 **R-47** 行）· `docs/m5.1.1/WP9B2-Handoff.md`（追加 R-47 范围收紧附注 + Next-WP 指针改为 WP9-C0）· `docs/m5.1.1/M5.1.1-WP9B2-Compatible-Assertion-Record.md`（首部加一行 R-47 指针，**正文一字未改**）· 证据 `artifacts/m5.1.1/wp9c0-e4-boundary.json` + `wp9c0-gate-exits.txt`。**`src/**` 零改动**（含 `migrations.ts` / `attribution.ts` / `init.ts`） |
| **Tests Run** | 提交前：`typecheck` · `wp9c0:verify` · `k17:verify` · `wp8:verify`。**提交后**（串行）：`wp8c3:verify` → `wp8:verify` → `gates` → `typecheck` → `wp9c0:verify` → `wp9b2:verify` → `wp9b1:verify` → `wp9a:verify` → `k17:verify` → `wp8c1:verify` → `wp8c2:verify` → `k29:verify` → `migration:verify` → `prod-copy:verify` → `m5.1:measurement:verify` → `wp9:verify`（只做观察）。见 §4 |
| **Tests Passed** | 提交前：`typecheck` 0 · **`wp9c0:verify` 43/0 · `WP9-C0 = COMPLETE`** · `k17:verify` 15/0（**未新增分类**）· `wp8:verify` 53/0（`unclassifiedVerifier = 0` · `unexpectedWrites = 0`）。**提交后**见 §4 |
| **Tests Failed** | **0**。过程内两处**自己判据的缺陷**已当场修正并记录，均**不是**放宽判据（见 §3）。 |
| **Evidence Produced** | `artifacts/m5.1.1/wp9c0-e4-boundary.json`（23 个逐字锚点 + 哈希 · 探针读数 · 溯源链 · `PREMISE CHECK` · 7 行覆盖率矩阵 · 2 个判定问题与各自备选读法 · 三段式读数 · 全量量具）· `artifacts/m5.1.1/wp9c0-gate-exits.txt`（逐门退出码）· `docs/m5.1.1/M5.1.1-WP9C0-E4-Acceptance-Boundary-Review.md`（含 F4-lite） |
| **Known Issues** | ① **`Canonical E4/S3` 仍未收口** —— 本 WP 的交付恰恰是"把它收口成两个可裁定的问题"（`Q1` 载体归属 / `Q2` 后台任务来源），**归属由用户定**。② **`PREMISE CHECK` 发现**：R-47 把"后台任务"归给 `Test-and-Gate-Plan` 的 S3 单元格，实测该文档全文 **0** 次；真实出处是 `docs/m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md:255`（§7 验收场景表第 3 行）。**实质判断不受影响**（D01 §7 正是 S1–S6 的直接祖先、1:1 顺序对齐），但"场景名一般化 = 改名还是放宽"是 `Q1`。③ 三项能力仍按 R-47 独立判定：State-origin = PASS（B2）· Conversation-origin = **尚未证明生产可达** · Background/system-origin Action = **尚未证明生产可达**。④ 两处既有陈旧项**只登记、未处理**（留给 C1）：WP9 门的 `WP9-GAP-2` 文本对生产装配已陈旧（WP9-A 已实现 writer）；`wp7:preflight / AT-W7-0` 仍 `inherited`。⑤ 浅拷贝受信信封仍是 `OPEN / NOT PROVEN`（独立 WP）。 |
| **Architecture Deviations** | **无**。没有新 ADR；`src/**` 一字未改；`MIGRATION_0009` / `INITIAL_STATE` / manual reset 语义未动；没有实现任何 SYSTEM 生产入口、没有建调度器；真实库未打开；冻结面 `artifacts/m5.1/**` 与 `artifacts/m4.5/**` 最终无差异。 |
| **Commit Hash** | `1f941e4` — `docs(m5.1.1): record R-47 E4 scope-tightening ruling and the WP9-C0 charter`（**Commit 0**，先于仪器改动）· `18838b8` — `test(m5.1.1): add the WP9-C0 canonical E4 acceptance boundary review gate` · `1abd1f9` — `docs(m5.1.1): record WP9-C0 boundary review evidence, matrix and handoff` · 提交后再鉴定读数与刷新后的 harness 当前读数在 **Commit 3**（本 handoff §4 与 F4 §8 所在的 docs 提交） |

---

## 1. 本 WP 只做一件事

用**可复现的机器证据**回答一个问题，并**只**回答这一个问题：

> 冻结的 `E4 / S3` 究竟要求**哪个生产事件族**、**哪一类系统发起行为**、以及**哪些权威账本**提供证据？

它**不**裁定 `E4` 是否 PASS，**不**实现任何 SYSTEM 生产入口，**不**重跑 E1–E8，
**不**修改任何既有 verifier 的判据文本 / 常量 / 阈值。

---

## 2. 交付：7 行覆盖率矩阵（结论由读数推导）

| # | 验收命题 | State B2 证据是否直接支持 | 支撑读数 |
|---|---|---|---|
| 1 | 真实 SYSTEM 身份可受信建立 | **是** | `initiator=KNOWN\|SYSTEM\|state-bootstrap\|-` |
| 2 | SYSTEM 发起的状态转换可持久化 | **是** | `attributionOrigin=RECORDED` |
| 3 | SYSTEM 归因可受信读回 | **是** | `readback.attributionOrigin=RECORDED` |
| 4 | 真实生产 `system_event` 已接线 | **尚未证明** | `conversationFamilies=assistant_message,user_message` · `systemEventFamilyLiterals=0` |
| 5 | SYSTEM 发起 `ActionGateway` 行动 | **尚未证明** | `actionDirsSystemPrincipals=0`（且 `systemPrincipalsInSrc=3` ⇒ 探针非空转） |
| 6 | D01 §7 所述"系统后台任务"真实执行 | **尚未证明** | `backgroundJobImports=0` |
| 7 | **非替代性**（rows 1–3 不能顶替 rows 4–6） | **不可替代** | `stateTransitionInConversationFamilies=0` · `trustedEnvelopeConstructors=1` |

**三个"入口存在但没人调"的正控**（否则这些探针是空问题）：

```text
recordSystemEvent 的定义 = 1 处，生产调用点 = 0        ⇒ 录制端口存在、没有产品行为触发它
行动侧 initiator 只有两式（action-turn.ts:144-153 四条逐行锚点）⇒ SYSTEM 无路径
后台任务 job.ts 的 import = 0，开关消费者只有 NOT-WIRED 告警 ⇒ 子系统根本没接线
```

---

## 3. 过程内修正的五处**自己的判据缺陷**（如实登记，均非放宽）

本门第一版在真实仓库上 `22 通过 / 16 失败`；逐条归属后**全部是我自己的判据写错**：

| # | 缺陷 | 实测症状 | 处置 |
|---|---|---|---|
| 1 | canonical E1–E8 的**行偏移**写错（把围栏行当 E1） | 8 个锚点全红：`E1 期望 E1…实际 ```text` | 改成 `slice(1057,1065)`（:1058-1065 = E1–E8）+ 循环用 `1058 + index` ⇒ 8 个锚点全 MATCH；同批修正 `Level 1 + Level 2` 的句号应为全角「。」 |
| 2 | S1–S6 场景名**取错列**（取到 `**S1**` 而不是 `S1 User initiated`） | `S1–S6 场景名与冻结期望不一致：["**S1**",…]` | 改为「`#` 列 + 场景列」去粗体拼接 ⇒ 六个场景名全 MATCH |
| 3 | 用 **token 重叠启发式**判定"哪几行改了措辞" | 中英对照下恒为假 ⇒ 报出"五行都变了"（`[1,2,3,5,6]`） | 删掉启发式，改成**两条能被逐字判定的具名事实**（第 3 行含"后台任务"、第 6 行 `Replay`→`legacy unknown`）+ 顺序对齐断言 ⇒ 判据不再撒谎 |
| 4 | 读数键名与引用**不一致**（`actionDirsSystemPrincipals` vs `systemPrincipalsInActionDirs`） | 矩阵第 5 行因 `undefined === 0` 为假而被误判为 `supported` | 统一键名 ⇒ 第 5 行回到 `not-proven` |
| 5 | 把 `actionInitiator*Occurrences`（**文本出现次数**，含定义与注释）当成"调用点数 = 1" | 实测为 4 ⇒ 正控误红 | 改为**如实按读数报**，承重判据换成"行动目录 0 个 SYSTEM 位次" + `action-turn.ts:144-153` 四条逐行锚点 |

**没有**任何一处是靠"放宽断言"变绿的：改完之后锚点 20 → **23**、矩阵行 7 行齐备，
判据比第一版**更严**。这正是 AGENTS §6「判据错了要如实写进报告，不要悄悄改判据」的同一纪律。

---

## 4. 提交后串行重跑 —— 实测读数

按 R-47 §5 与既有纪律（**全部串行**，任何时刻只有一个 pnpm 进程）：

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | **`pnpm m5.1.1:wp8c3:verify`**（Hard Gate，干净树、单独跑） | **0** | **40 通过 / 0 失败 · `WP8-C3 = PASS` → `WP8 = PASS`** |
| 2 | **`pnpm m5.1.1:wp8:verify`**（Hard Gate） | **0** | **53 通过 / 0 失败 · `WP8-B = PASS`** · `unclassifiedVerifier = 0` · `unexpectedWrites = 0` |
| 3 | `pnpm m5.1.1:gates` | **0** | **`G1–G7 PASS · G8 = NOT RUN · G9 PASS`** |
| 4 | `pnpm typecheck` | **0** | |
| 5 | **`pnpm m5.1.1:wp9c0:verify`**（本 WP 新门） | **0** | **43 通过 / 0 失败 · `WP9-C0 = COMPLETE`** |
| 6 | `pnpm m5.1.1:wp9b2:verify` | **0** | 42 通过 / 0 失败 · `WP9-B2 = PASS` |
| 7 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败 |
| 8 | `pnpm m5.1.1:wp9a:verify` | **0** | 31 通过 / 0 失败 · `WP9-A = PASS` |
| 9 | `pnpm m5.1.1:k17:verify` | **0** | 15 通过 / 0 失败（**未新增分类**） |
| 10 | `pnpm m5.1.1:wp8c1:verify` | **0** | 15 通过 / 0 失败 · `K-32 = PASS` |
| 11 | `pnpm m5.1.1:wp8c2:verify` | **0** | 25 通过 / 0 失败 · `K-33 = PASS` |
| 12 | `pnpm m5.1.1:k29:verify` | **0** | 41 通过 / 0 失败 |
| 13 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败 |
| 14 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败 |
| 15 | `pnpm m5.1:measurement:verify` | **0** | 16 通过 / 0 失败 |
| 16 | `pnpm m5.1.1:wp9:verify`（**只做观察**） | **1** | **40 通过 / 0 失败 · `WP9 = PARTIAL / BLOCKED`**（既定判定）· 对话侧 `E4-A` 仍 `NOT RUN / BLOCKED` · **没有新的 scenario failure** |

**提交前读数**：`typecheck` 0 · `wp9c0:verify` 43/0 · `k17:verify` 15/0（命中 54 文件，全部已分类）·
`wp8:verify` 53/0（`unclassifiedVerifier = 0`）。

**过程内修正**：本门第一版在真实仓库上 `22 通过 / 16 失败`，逐条归属后**全部是我自己的判据写错**
（行偏移 / 取错列 / 用了一个在中文对照下恒为假的启发式 / 键名不一致 / 把"文本出现次数"当"调用点数"）。
五处已修正并登记在 F4 §8 与本文件 §3；**改完之后的判据比第一版更严**（锚点 20 → 23，新增 row 7），
**没有任何一处是靠放宽断言变绿的**。

完整逐门读数（含提交前的每一条与五处修正的归属）见 **`artifacts/m5.1.1/wp9c0-gate-exits.txt`**。

---

## Next WP Preconditions

**下一个动作不是新 WP，而是用户裁定 `Q1`（与必要时的 `Q2`）**：

```text
Q1  canonical E4/S3 绑定哪个载体？
      Q1-a 任意权威账本        ⇒ B2 的 state_events 即满足 ⇒ 可直接评估进入 C1
      Q1-b 对话/行动运行时      ⇒ 需要独立的 Conversation/行动 SYSTEM 路径（新功能 WP）
      Q1-c D01 §7 的后台任务    ⇒ 需要真实调度器/后台任务入口（新功能 WP + 可能 ADR）
Q2  若 Q1-c：真实后台任务从哪来？（新建调度器 / 重估已有系统行为 / 收窄验收含义）
```

裁定之后的约束：

1. **`WP9-C1 Final Requalification` 仍 `NOT READY`** —— 它的先行条件是 `Q1` 被裁定，
   而不是 C0 完成。**不得**用"state 侧已经有了"或"理论上可以复用 B2 的工厂"替代生产可达性。
2. 若 `Q1` 的答案是 Q1-b / Q1-c ⇒ 那是**新功能**（产品能力），必须先有独立的 WP 与授权，
   **不得**在验收 WP 里补生产入口（WP9-13 的纪律）。
3. 若 `Q1` 的答案是 Q1-a ⇒ `rows 4–6` 的语义必须**显式**处置（写成 deferred 或另立 WP），
   不得因为"E4 满足了"就把它们静默降级。
4. 两处既有陈旧项（WP9 门的 `WP9-GAP-2` 文本 · `wp7:preflight / AT-W7-0`）留给 C1。
5. 纪律照旧：一个进程一个沙箱库 · 计数型判据自检 `measured_count > 0` ·
   正控/负控/恢复三段式 · **不要并发跑门** · 冻结面只从 `m5.1-complete` 还原 ·
   绝不 `git add -A` · 历史证据只按**白名单逐路径**还原（AGENTS §7）。

**仍未授权 / 未关闭**：`WP9-GAP-1` 的 State 分支 = `RESOLVED`，其 `Canonical E4/S3` = `OPEN` ·
`WP9 = PARTIAL / BLOCKED` · `WP9-C1 Final Requalification = NOT READY` · `WP10 = NOT AUTHORIZED` ·
`K-31 = OPEN / DEFERRED / NON-BLOCKING` · `ADR-043 = NOT APPROVED` · `Phase 4 = BLOCKED` ·
`M5.1-D01` 未关闭 · `Generic trusted-envelope clone resistance = OPEN / NOT PROVEN` ·
`wp7:preflight` 的历史 scope 条 = `inherited / pending independent confirmation`。
