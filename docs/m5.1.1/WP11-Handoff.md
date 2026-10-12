# WP11 Handoff —— Phase 1–3 Closure

**判定：`WP11 = PASS`**（EXIT 0 · **107 通过 / 0 失败**）
**`WP10 = PASS`** · **`Phase 1 = PASS` · `Phase 2 = PASS` · `Phase 3 = PASS`**
**`Phase 4 = BLOCKED BY ADR-043`** · **`M5.1.1 Final = BLOCKED`** · **`M5.1-D01 = P1 OPEN`**

日期：2026-09-19 · 上游：`WP10 = PASS`（R-51）
执行令：**用户 R-52**（原文）：

```text
任务继续,但有一条必须坚持：
WP11 可以关闭满足条件的 Phase 1–3 工作，不能借此关闭仍然依赖 Phase 4 的 D01 认知资格问题。
```

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `scripts/verify-m5.1.1-wp11-closure.ts`（**新增**：Phase 1–3 收官门）· `scripts/verify-m5.1.1-k17-consumer-impact.ts`（`CLASSIFICATIONS` **+1 条良性命中**；判据一字未改）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` **+1 条分类**）· `package.json`（`+ "m5.1.1:wp11:verify"`）· 文档四份（F4 / 验收报告 / Gate-Decision / 本文件）· `M5.1.1-Execution-Plan.md`（**R-52** 行）· 证据 `artifacts/m5.1.1/wp11-phase1-3-closure.json` + `wp11-gate-exits.txt` + 刷新后的 `wp2.2-k17-consumer-impact.json` / `gate-results.json` 当前读数。**`src/**` 零改动**；**没有任何数据库被打开或复制** |
| **Tests Run** | 本门**不重跑任何门**（它只读已落盘证据）。它**自己**跑：① 从 `artifacts/m5.1.1/**` 独立算出 Phase 1/2/3 状态；② 断言两份报告的六行与算出来的值逐字相同；③ canonical 禁令检测器的**正控 / 负控 N1–N3 / 特异性 N4–N5 / 恢复**五段；④ 冻结面与标签比对。提交后另跑 19 条命令（§5） |
| **Tests Passed** | `pnpm m5.1.1:wp11:verify` = **EXIT 0 · 107 通过 / 0 失败 · `WP11 = PASS`** · `measurementInvalid = 0`（20 个量具全有效）。**阶段 1–3 的八条退出条件 8/8 达成**；`EC-8`（ADR-043）与 `EC-10`（D01 可关闭）**逐字维持未达成** |
| **Tests Failed** | **0**（最终）。三处**非绿且已逐条归属**：① 本门**第一次**运行（报告尚未写出来时）= **93 通过 / 11 失败**，11 条全部是"报告缺失 / 六行读不到" ⇒ **这是设计行为**（AGENTS §6.4：文件不存在 = `not-run`，**不是** PASS），它同时把**算出来**的六行打印出来供报告引用；② 门自己的 §0 前置**两次抓到"别人"的脏**（未提交的 F4 更正 / 未提交的 handoff）= **103 通过 / 1 失败** ⇒ 处置是**先提交、再在干净树上跑**；③ 更宽的禁令自查落地后第一次 = **105 通过 / 2 失败**（过程性文档里有一行描述措辞没有禁止语上下文）⇒ 处置是**把那句话改写成明确的禁止句**，不是加白名单。**没有**为了变绿放宽任何既有判据 |
| **Evidence Produced** | `artifacts/m5.1.1/wp11-phase1-3-closure.json`：`computedStatuses` / `reportedStatuses` / `statusesAgree` · `phaseCriteria`（Phase 1 的 M1–M7 逐格 + M3 六槽位 + M4 六类计数 + M7 两分支 · Phase 2 的场景/合法读数/payload 拒绝 · Phase 3 的 R1–R6 / S1–S6 / K-27 / mutation）· `exitConditions`（十条，带 `scope`）· `canonicalProhibition`（检测器规则 + 正控 + 5 条负控/特异性 + 恢复）· `adr043`（状态行）· `d01` · `liveSmoke` · `readingsSources`（**24 份**证据的路径/字节/sha256）· `frozenFace` · `scope` · `notClaimed`。`artifacts/m5.1.1/wp11-gate-exits.txt`（逐门退出码） |
| **Known Issues** | 见 §6。要点：① `M5.1-D01` 仍 **`P1 OPEN`**、`Phase 4` 仍 **`BLOCKED BY ADR-043`**、`M5.1.1 整体` 仍 **`BLOCKED`**；② `DC-1/DC-2/DC-3` 三项能力缺口**全部仍是 `NOT IMPLEMENTED / DEFERRED`**；③ Live Smoke = **NOT RUN**；④ 退出条件 **EC-7** 的"**已交你看过**"是**人类动作**，门只能证明报告存在且只读；⑤ `M511-G8` 仍 **NOT RUN**；⑥ `Generic trusted-envelope clone resistance` 仍 **OPEN / NOT PROVEN** |
| **Architecture Deviations** | **无**。没有新 ADR；`src/**` 一字未改；`ADR-042` / `ADR-043`（草案）/ `MemoryAuthority` / Fact Firewall / 迁移 / schema **一字未改**；`M5.1-D01` 的**状态未被改动**（门只读它）；冻结面与 `m5.1-complete` **零差异**；标签未动。判据面变更 = **F4 `W11-G1`**（新增门）+ **`W11-G2`**（k17 分类表追平，**判据一字未改**）+ **`W11-G5`**（禁令检测器拆成**两套规则**；**这是一次判据放宽，只作用于过程性文档，且自带负控**，逐字登记在 F4 §1.6）+ 两条登记（`W11-G3` / `W11-G4`） |
| **Commit Hash** | `aba4704` — `docs(m5.1.1): record the WP11 closure F4 and the R-52 Phase 1-3 closure ruling`（**Commit 0**，先于仪器改动）· `5dde646` — `test(m5.1.1): add the WP11 Phase 1-3 closure gate` · `1967426` — `test(m5.1.1): exclude the WP11 gate's own declared writes from its clean-tree predicate` · `bbb4c06` — `docs(m5.1.1): publish the Phase 1-3 acceptance report and the M5.1.1 gate decision` · `a5cfaae` — `test(m5.1.1): add WP11 closure evidence and refreshed gate readings` · `5b80c83` — `docs(m5.1.1): correct the k17 hit-location reading in the WP11 F4 record` · `90108d5` — `test(m5.1.1): widen the WP11 gate's declared write surface to its five products` · `b0f2bb7` — `test(m5.1.1): audit forbidden claims in the WP11 process documents with a second control set` · `b70ad27` — `docs(m5.1.1): phrase the WP11 handoff prohibition row as a prohibition` · **最后一提交** — 本文件 + `wp11-gate-exits.txt` + F4 §1.6 + 最终一次 `wp11:verify` 的证据 |

---

## 1. 本步只做一件事

> 按 canonical WP11：生成 `M5.1.1-Phase1-3-Acceptance-Report.md`，并给出**六行状态**；
> 按 R-9：追加 `M5.1.1-Gate-Decision.md`（含 §"这个判定不主张什么"）。

**不做**：不实现任何功能、不改任何既有判据的语义、不跑 `m4.5:ci`、不重跑任何 M5.1 verifier、
不碰数据库、不碰 `src/**`、不开始 `WP11` 之后的任何工作。

---

## 2. 这道门为什么必须存在（它把用户那条约束变成**会红的判据**）

报告里的六行如果由人写，就是一句**人写的承诺**（AGENTS §6.4 明令禁止手写"全绿"表格）。
因此本 WP 新增 `pnpm m5.1.1:wp11:verify`，它的形状是：

```text
① 它**独立地**从 `artifacts/m5.1.1/**` 的落盘证据**算出** Phase 1 / 2 / 3 的状态
   （每一格都指名到具体证据文件的**具体字段**，见验收报告 §2–§4）
② 它**断言**两份报告里的六行与算出来的值**逐字相同**
③ 它**机器地**执行 canonical 的禁令（`M5.1.1 PASS` / `D01 CLOSED` 不得出现）
④ 它读 `ADR-043` 草案**自己的状态行**来支撑 `Phase 4 = BLOCKED BY ADR-043`
   ⇒ 那一行是**事实推导**，不是声明；ADR-043 被改成 APPROVED（或文件缺失）会让门红
⑤ 它把 `EC-8`（ADR-043）与 `EC-10`（D01 可关闭）写成**必须维持未达成**的判据
```

**用户约束的机器落点**（F4 §1.3 的同一张表）：

| 判据 | 它防的是什么 |
|---|---|
| `ST-4` | 把 `Phase 4` 写成 `PASS`/`FAIL`（= 声称认知资格已重新资格化） |
| `ST-5` | 把"阶段 1–3 全绿"偷换成 `M5.1.1 Final = PASS` |
| `ST-6` | 把 `M5.1-D01` 写成 `CLOSED` |
| `ADR-FACT` | 把 `BLOCKED` 当成一句可以随手改的声明 |
| `EC-8` / `EC-10` | 把"阶段 1–3 的绿"读成"退出条件全绿" |
| `FB-1` | **禁止**在正文任何位置把 `M5.1.1 PASS` / `D01 CLOSED` 写成断言 |
| `DC-1..3` | 把三项能力缺口删成 0 条以制造"问题从未存在过" |
| `AUX-1` | 三份**过程性文档**（本文件 / F4 / `wp11-gate-exits.txt`）里对禁令的每一处提及都必须可归类（**`UNCLASSIFIED` = 0**）—— 见 F4 §1.6 的两套规则；**它自己的负控**是"往每份文档追加一行裸的 `M5.1.1 PASS` ⇒ 三份都必须出现 `UNCLASSIFIED`"（实测 1 / 1 / 1） |

---

## 3. 算出来的六行与它们的证据链

```text
Phase 1  PASS   阶段 1 = WP2 + WP3
   M1–M7 逐格 verdict=true · M3 六槽位 0/0 · 14/14 · 0/0 · 0/0 · 0/0 · 28/28（**计数精确**）
   M4 六类陈旧状态计数全 0 · M7：28 行 · axisBNull=0 · axisBBadValue=0 · sourceKindOutOfVocab=0
   M7 两分支各 measured_count>0：confirmed=3 · unconfirmed=5 · m7Violations=[]
   M6 restoreEpoch=NOT_APPLICABLE（显式）· M5 影响半径 3084 字节 · readOnly=true · evidenceLinks=2
   迁移门 117/0（1..9 指纹逐条 match · destructiveStatements=0）· prod-copy 36/0
   wp3 36/0 · wp3.1 50/0 · wp3.2 35/0 · k20 PASS（30/0）

Phase 2  PASS   阶段 2 = WP4
   6 个场景的三段（写/库/回读）逐槽位一致 · slotMismatches=[] · axisBMismatches=[]
   G-AT-4：positiveQuiet=true · payloadRejections=9 · mutationDetected=true · restoreOk=true
   K-25 22/0 · 7 条合法读数里 4 条 distinct=false 且 match=true（**S2′ 反假阳性对照**）
   wp4.1 43/0 · v8Required=true · 负控逐条 contractDetectorFired ∧ dbRejected ∧ residueRows=0

Phase 3  PASS   阶段 3 = WP5 写侧 + WP6 读侧
   wp5 58/0 · 9 级阶梯 · negatives.fired=10 · cloneProbes=2 · restoreOk=true
   Execution Truth 与归因不互相冒充：knownExecutorImpliesExecuted=false · recordedRowsWithAxisB=0
   K-27 CLOSED（人类正控 KNOWN|USER|u-1 · 负控 fired=7 · 恢复 == 正控）
   wp6 51/0 · R1–R6 全绿（**r5 Unknown 不被洗白** · r6 三态仍可区分）· wp6.1 115/0（K-28 CLOSED）
   wp9 57/0 · E→S 覆盖 S1–S6 · fieldwise.equal=true · 8 条 L1↔L2 关联全 agree · blockingGaps=0
   七个 mutation 7/7 ok · wp8 不变量 INV-1..10 + CE-D01 + CE-K27 全成立
   DC-1 / DC-2 / DC-3 **全部仍是 NOT IMPLEMENTED / DEFERRED**（3 条，未被删）

Phase 4  BLOCKED BY ADR-043     ← 读 ADR-043 草案自己的状态行：`DRAFT / NOT APPROVED`
M5.1.1 Final  BLOCKED           ← `Final Status Vocabulary`：ADR-043 完成前只允许 BLOCKED
M5.1-D01      P1 OPEN           ← 本轮**未动**它的状态；门只读它并断言它没变
```

---

## 4. 十条退出条件

| # | 退出条件 | scope | 状态 |
|---|---|---|---|
| EC-1 | `G-AT-1/2/3/4` 全绿 + 正负控 | 阶段 1–3 | **达成** |
| EC-2 | `S1–S6` 可区分 + `S2′` 通过 | 阶段 1–3 | **达成** |
| EC-3 | 七个 mutation 必响 + 恢复安静 | 阶段 1–3 | **达成** |
| EC-4 | `R1–R6` 全绿 | 阶段 1–3 | **达成** |
| EC-5 | `M1–M7` 全绿 + `M4`=0 + `M7` 完整 | 阶段 1–3 | **达成** |
| EC-6 | `M511-G9` 旧 Gate 兼容性 | 阶段 1–3 | **达成** |
| EC-7 | 影响半径报告（只读） | 阶段 1–3 | **达成**（机器可证"存在且只读"；"已交你看过"= **人类动作**） |
| EC-8 | **`ADR-043` 已批准** | **Phase 4 专属** | **未达成（必须维持）** |
| EC-9 | 全量回归零退化 | 阶段 1–3 | **达成**（WP10-C：`m4.5:ci` EXIT 0 · 718 s） |
| EC-10 | **`M5.1-D01` 改为 `CLOSED`** | **Phase 4 专属** | **不适用 / 禁止（必须维持）** |

⇒ **8/8（阶段 1–3）** · **0/2（Phase 4 专属，逐字维持未达成）**。

---

## 5. 提交后串行再鉴定读数

见 `artifacts/m5.1.1/wp11-gate-exits.txt`。口径：`$o = pnpm <script> 2>&1; $c = $LASTEXITCODE`，
**串行**执行，任何时刻只有一个 pwsh/pnpm 门进程；`wp8c3` **最先**（它的 C3-0 要求干净树）。

---

## 6. Known Issues（诚实边界）

```text
①  `M5.1-D01` = **P1 OPEN**（认知资格问题）。关闭要求 `ADR-043` **批准并落地**（Phase 4）。
    本 WP **不**关闭它，也**不**改动它的状态；门只读它并断言它仍是 `P1 OPEN`。

②  `Phase 4 = BLOCKED BY ADR-043`：`ADR-043` 仍是 `DRAFT / NOT APPROVED`。
    Phase 4 会改变 Assistant Fact Firewall 的**输入行为** ⇒ 它同时是**认知资格问题**，
    必须先走认知重新资格化的正式流程（`M5.1.1-Migration-Strategy.md` §2.1）。

③  `M5.1.1 整体 = BLOCKED`（`Final Status Vocabulary` 明文）。

④  三项能力缺口**全部仍是 `DEFERRED / NOT IMPLEMENTED`**：
    `DC-1` Conversation SYSTEM Producer · `DC-2` System-origin Action ·
    `DC-3` D01 Background-System-Initiation。
    ⇒ **不得**写「`D01` 已全部关闭」，**不得**写「苏沐薇已经具备后台自主运行能力」
      （R-48 §三逐字：不能因为 E4 通过而销账，也不能把 `state-bootstrap` 改称为 background job）。

⑤  Live Smoke = **NOT RUN**（无 `OPENAI_API_KEY`）。**⚠️ 2026-09-19 更正**：括号里的理由不准确
    —— 收集本 WP 读数的门只 import `node:*`、未加载 `.env`；准确依据是**本 WP 没有跑 Live Smoke**。
    见 `M5.1.1-Gate-Decision.md` §11 与 AGENTS §8.1。`M51-G9 liveSmokeVerdict = PASS`
    读的是 **M5.1 期的冻结 blob**；两者**不得互相冒充**。

⑥  退出条件 `EC-7` 里的"**已交你看过**"是**人类动作**：门只能证明影响半径报告**存在**且是**只读**的。

⑦  `M511-G8`（Break-Glass Cognitive Override）= **NOT RUN**（规则已冻结、未实现；从未伪造为 PASS）。

⑧  `Generic trusted-envelope clone resistance` = **OPEN / NOT PROVEN**（独立 WP）。

⑨  `wp7:preflight / AT-W7-0` = **inherited**（历史作用域护栏）。

⑩  `K-31` = **OPEN / DEFERRED / NON-BLOCKING**。

⑪  阶段 5（日落 `actor_type`）= **NOT RUN**（需 `Compatibility-Matrix.md` §4 四条日落条件全部成立）。

⑫  本门**不重跑**任何门：它的证据是"别人跑完我来读"。因此它证明的是
    **"落盘证据仍然成立"**，不是"门刚才又绿了一次"。
```

---

## 7. 下一步

`WP11` 是 `M5.1.1-Execution-Plan.md` 批次表里的 **Batch L（最后一批）**。
本 WP **到 STOP**。

**此后可以做的**（都**不在**本次 execution 的授权范围内，需要用户另行裁定）：

```text
· `ADR-043` 的正式设计 → 批准（那是 Phase 4 的前置，也是 `M5.1-D01` 关闭的前置）
· Phase 4（切 Fact Firewall 输入）
· 阶段 5（日落 `actor_type`）
· `DC-1` / `DC-2` / `DC-3` 三项能力缺口各自的独立 WP
· `Generic trusted-envelope clone resistance` 的硬化（独立 WP）
```

---

## 不主张（诚实边界）

```text
本 WP **不**主张 `M5.1.1` 整体通过 —— `M5.1.1 Final = BLOCKED`。
本 WP **不**主张 `M5.1-D01` 关闭 —— 它是 `P1 OPEN`，且关闭要求 `ADR-043` 批准并落地。
本 WP **不**主张账本已经能说明"这是谁做的"（**认知资格**层面）。
本 WP **不**主张「苏沐薇已经具备后台自主运行能力」（DC-1/2/3 仍全部 DEFERRED）。
本 WP **不**主张 Phase 4 已执行或已设计完（`ADR-043 = DRAFT / NOT APPROVED`）。
本 WP **不**主张 Live Smoke 跑过（**NOT RUN**）。
本 WP **不**主张阶段 1–3 的 PASS 等于认知完整性已达标。
本 WP **不**跑 `m4.5:ci`、**不**重跑任何 M5.1 verifier、**不**读真实库、**不**改 `src/**`。
```
