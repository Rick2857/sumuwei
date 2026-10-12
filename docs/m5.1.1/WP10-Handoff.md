# WP10 Handoff —— Production-Copy Migration & Regression

**判定：`WP10 = PASS`**
（`WP10-A = COMPLETE` · `WP10-B = PASS` · `WP10-C = PASS` · `WP10-D = COMPLETE`）

**状态词表**（`M5.1.1-Execution-Plan.md` 的 `Final Status Vocabulary`，只允许
`PASS / FAIL / NOT RUN / BLOCKED`）：
`WP10 = PASS` · `M5.1.1 整体 = BLOCKED`（`ADR-043` 完成前）· `M5.1-D01 = P1 OPEN`。

日期：2026-09-19 · 上游：`WP8 = PASS` · `WP9 = PASS` · `WP10-A = COMPLETE` · `WP10-B = PASS`
执行令：**用户 R-49**（WP10 拆 A/B/C/D）· **R-50**（WP10-B）· **R-51**（"**允许继续下次一次性跑完**"）

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | 本 WP（C/D）新增：`scripts/verify-m5.1.1-wp10c-regression.ts`（**新门**）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` **+1 条分类**，附理由）· `package.json`（`+ "m5.1.1:wp10c:verify"`）· 文档三份（`M5.1.1-WP10-Compatible-Assertion-Record.md`（F4）· `M5.1-Compatible-Assertion-Changes.md`（canonical 冻结名）· 本文件）· `M5.1.1-Execution-Plan.md`（**R-50 / R-51** 两行）· 证据 `artifacts/m5.1.1/wp10-regression.json`（canonical 冻结名）+ `wp10c-gate-exits.txt` + 被重跑刷新的一批 `wp8*` / `wp9*` / `k17` / `k29` / `gate-results.json` 当前读数。**`src/**` 零改动**；**没有任何数据库被打开或复制** |
| **Tests Run** | ① **WP10-C 门内**（一次执行，串行）：`typecheck` 前置 → `wp8c3` → `wp8` → `wp9` → **fresh `pnpm m4.5:ci`** → `m5.1.1:gates` / `m5.1:gates` / `m4.5:gates` / `m5.1:regression:verify` → 逐路径还原冻结面 → `wp8c1` / `wp8c2`。② **提交后串行再鉴定**：20 条命令全部 EXIT 0（§5） |
| **Tests Passed** | `pnpm m5.1.1:wp10c:verify` = **EXIT 0 · 24 通过 / 0 失败**（`WP10-C = PASS`）。其中：`wp8c3` **40/0** · `wp8` **53/0** · `wp9` **57/0 `WP9 = PASS`** · **`m4.5:ci` EXIT 0（718s）** · 四个聚合器全 EXIT 0 · `M511-G1–G7 PASS / G8 NOT RUN / G9 PASS` · `m5.1:regression:verify = PASS` · `K-32` 15/0 · `K-33` 25/0。提交后 20 条命令全 EXIT 0 |
| **Tests Failed** | **0 条真实红**。一处**非绿且已归属**：WP10-C 的**第一次运行**以 EXIT 1 中止 —— 根因是**本门自己的解析缺陷**（`git status --porcelain` 路径用了 `slice(3)`，而 helper 的 `trim()` 吃掉第一行 `XY` 前的空格 ⇒ 路径首字母被切掉），修法与两条**新增自检**见 F4 `C-G1`；**不是**产品回归，**没有**动用任何清洁度例外 |
| **Evidence Produced** | `artifacts/m5.1.1/wp10-regression.json`（canonical 名）：`priorCi` / `priorLog`（fork 读数）· `freshCi` / `freshLog`（fresh `m4.5:ci` 的退出码、字节、sha、BOM、逐门小结 26 / 硬门 3）· `selfParsedCiLog`（本门自解析，与冻结读者**交叉核对**）· `requalification`（wp8c3/wp8/wp9）· `m511Gates` 九门读数 · `wp8Harness` · `aggregators`（4 条）· `frozenFaceRestore`（canonicalSource / forbidden / 13 条被改写路径 / 还原后零差异）· `k32` / `k33` · `liveSmoke`（**NOT RUN** + 理由）· `interpretation`（三条不得读错的口径）· 15 个量具全 `valid` · `scope`（`productionDbOpened=false` · `realDbCopied=false` · `srcChanged=false` · `liveSmokeMocked=false`）· `artifacts/m5.1.1/wp10c-gate-exits.txt`（**两次运行**的逐门退出码）· `docs/m5.1.1/M5.1-Compatible-Assertion-Changes.md`（canonical 的四项证明） |
| **Known Issues** | 见 §6。要点：① `M51-G9 liveSmokeVerdict = PASS` 是 **M5.1 期冻结 blob** 的历史读数，本轮 Live Smoke = **NOT RUN**，两者**不得互相冒充**；② M5.1 期那份 734070 字节 utf-16le CI 日志**已不在磁盘上**（被本门第一次、中止的运行覆盖）—— 其**边界身份**保存在已提交的 `wp10a-preflight.json`，**解析读数**与覆盖前逐字一致；③ `wp10a`/`wp10b`/`wp10c` **没有**在提交后重跑（理由见 §5）；④ `M5.1-D01` 仍 `P1 OPEN`，`Phase 4` 仍 `BLOCKED BY ADR-043`，`D01-Background-System-Initiation` 仍 `DEFERRED / NOT IMPLEMENTED`；⑤ `Generic trusted-envelope clone resistance` 仍 `OPEN / NOT PROVEN` |
| **Architecture Deviations** | **无**。没有新 ADR；`src/**` 一字未改；**没有对真实库执行任何迁移**（本 WP 根本没有打开数据库）；没有回填；没有新增文件落进冻结目录；冻结面最终与 `m5.1-complete` **零差异**；标签未动。**一处判据变更**（F4 `C-G1`，**变严**）+ **一处判据集合扩大**（F4 `C-G2`，补上计划 §3 C3 的三道资格复核门与两条交叉核对） |
| **Commit Hash** | `4ddd680` — `test(m5.1.1): add WP10-C full regression and gate aggregation gate` · `842691f` — `fix(m5.1.1): parse porcelain paths without eating the first character in the WP10-C gate` · `ccec57f` — `docs(m5.1.1): record the WP10-C compatibility record, the M5.1 compatibility proofs and R-50/R-51` · `743e55c` — `test(m5.1.1): add WP10-C full regression evidence and refreshed gate readings` · **Commit 4** — 本文件 + `wp10c-gate-exits.txt` + F4 §7 的提交后读数（本轮最后一提交） |

---

## 1. WP10 的四步（每一小步都有自己的判定）

| 步 | 判定 | 读数 | 证据 |
|---|---|---|---|
| `WP10-A` Production-Copy & Regression Preflight | **COMPLETE** | `wp10a:verify` EXIT 0 · **27 通过 / 0 失败** · 只读预检七项全有读数 | `artifacts/m5.1.1/wp10a-preflight.json` |
| `WP10-B` Production-Copy Migration | **PASS** | `wp10b:verify` EXIT 0 · **24 通过 / 0 失败** · 副本上 `v6 → v9`（`applied=[7,8,9]`）· 四项 canonical 验证全过 | `artifacts/m5.1.1/wp10-production-copy.json` |
| `WP10-C` Full Regression & Gate Aggregation | **PASS** | `wp10c:verify` EXIT 0 · **24 通过 / 0 失败** · fresh `m4.5:ci` EXIT 0（718s）· 四聚合器全 0 | `artifacts/m5.1.1/wp10-regression.json` |
| `WP10-D` M5.1 Compatibility Record & Verdict | **COMPLETE** | 四项证明全部由 `git diff` 读数支撑（§3） | `docs/m5.1.1/M5.1-Compatible-Assertion-Changes.md` + 本文件 |

---

## 2. WP10-C 的回归读数（canonical "Regression" 段的逐项映射）

canonical 五项 → 本仓库当前命令名，**逐项落实、无一项被省略或替换**：

| canonical | 实跑 | EXIT | 读数 |
|---|---|---|---|
| `M5.1.1 gates` | `pnpm m5.1.1:gates` | 0 | `G1–G7 PASS` · **`G8 = NOT RUN`**（Break-Glass 未实现，不伪造 PASS）· `G9 PASS` · WP8 harness 自检 53/0 |
| `M5 gates` | `pnpm m5.1:gates` | 0 | `Hard Gates：PASS` |
| `M4.5 gates` | `pnpm m4.5:gates` | 0 | 全绿（G2 135/0 · G9 · G14 …） |
| `natural-language E2E` | `pnpm m5.1.1:wp9:verify` | 0 | **57 通过 / 0 失败 · `WP9 = PASS`** |
| `full regression` | `pnpm m5.1:regression:verify` | 0 | `regressionVerdict = PASS` · 逐门小结 26 · 硬门 3 · `problems = 0` |
| （计划 §3 C3 追加）`wp8c3` | `pnpm m5.1.1:wp8c3:verify` | 0 | **40 / 0** · C3-0 干净树 ✅（**无清洁度例外**） |
| （计划 §3 C3 追加）`wp8` | `pnpm m5.1.1:wp8:verify` | 0 | **53 / 0** · `unexpectedWrites = 0` · `redGates = 0` |
| （计划 §3 C3 追加）`wp9` | `pnpm m5.1.1:wp9:verify` | 0 | **57 / 0** |

**fresh `pnpm m4.5:ci`**：

```text
EXIT          = 0（**718s**）
日志          = artifacts/m5.1/wp9-m4.5-ci.log（被 gitignore）
                430661 字节 · sha256 6750dc115b3d5180… · **UTF-8 无 BOM**
                （Node `writeFileSync` —— **故意不用** PowerShell `*>`，它写 UTF-16LE，AGENTS §7 的坑）
尾行          = EXIT_CODE=0
本门自解析    = 逐门小结 26 条 · 硬门 3 条
冻结读者解析  = 逐门小结 26 条 · 硬门 3 条        ← **交叉核对：两套判据同一份真值**
```

**冻结面还原**（canonical source = immutable 标签 `m5.1-complete`）：

```text
被改写的冻结路径 = 13 条（逐条列在 wp10c-gate-exits.txt §5）
自检① 13 条全部形如 `artifacts/…`（解析没有吃掉首字符）        ← 本 WP 新增判据
自检② 13 条全部存在于 `m5.1-complete` 里                       ← 本 WP 新增判据
还原 = git checkout m5.1-complete -- <逐条路径>（**禁止**无差别 checkout）
还原后：五个冻结目录工作树 vs 标签差异 = 0 · HEAD vs 标签差异 = 0
```

---

## 3. WP10-D 的四项证明（全部由 `git diff` 读数支撑）

| # | 证明 | 判定 | 读数 |
|---|---|---|---|
| ① | `old semantic criterion preserved` | ✅ | 全里程碑只有 **3 个既有脚本**被改动；**7 行删除逐行配对**，每一条都在原处换成**同一谓词/同一比较器**的写法 |
| ② | `assertion deleted = 0` | ✅ | `scripts/` `+30026 / −7`；7 行删除**无一条是删除断言**；断言载体计数 `47→47 · 92→92`｜`56→57 · 193→203`｜`140→140`（**单调不减**） |
| ③ | `criterion weakened = 0` | ✅ | 146 条新增行 × 6 类放松形态扫描 **全部 = 0**（`>=`/`<=` · 松散 truthy · `includes/some` · `try/catch` · 条件化 · `.skip/.only`） |
| ④ | `historical artifact changed = 0` | ✅ | `git diff --name-status m5.1-complete..HEAD -- artifacts` = **502 条全部 `A`，全部在 `artifacts/m5.1.1/` 下**；非 `artifacts/m5.1.1/` 的条目 = **0**；五个冻结目录差异 = **0**；标签未动 |

**三处必须看清的口径**（详见 `M5.1-Compatible-Assertion-Changes.md` §0 / §6）：

1. `assertion deleted = 0` 量的是**删除的行**（"把 `6` 改成 `7`"在 diff 里是 `−1 +1`，不是删掉一条断言）；
2. `historical artifact changed = 0` 量的是**已提交的历史证据**（commit-to-commit），**不是**工作树 ——
   跑门时冻结目录会被重新生成，那由 `wp10-regression.json` 的 `frozenFaceRestore` 单独负责；
3. 四项证明**只覆盖"旧判据面"**；M5.1.1 的**新增**判据面（37 个新脚本 / 30,026 行）规模登记在该文件 §4。

---

## 4. `WP10 = PASS` 的构成

```text
canonical WP10 四段          判定        证据（canonical 冻结名）
Production-copy              WP10-B PASS  artifacts/m5.1.1/wp10-production-copy.json
Regression                   WP10-C PASS  artifacts/m5.1.1/wp10-regression.json
M5.1 Compatibility           WP10-D ✅    docs/m5.1.1/M5.1-Compatible-Assertion-Changes.md
Evidence（两份 canonical 名） ✅ 均在库
STOP                         ✅ 本文件之后 STOP，**不**开始 WP11
```

**`WP10 = PASS` 的充分条件**（`M5.1.1-WP10A-Execution-Plan.md` §4 D2）：`WP10-A/B/C = PASS` 齐备
✅；`D3`：两份 canonical 证据文件名齐备 ✅。

---

## 5. 提交后串行再鉴定读数（20 条命令，全部 EXIT 0）

```text
 1  pnpm typecheck                          EXIT 0
 2  pnpm m5.1.1:wp8c3:verify                EXIT 0   40 通过 / 0 失败（**干净树、最先单独跑**）
 3  pnpm m5.1.1:wp8:verify                  EXIT 0   53 通过 / 0 失败
 4  pnpm m5.1.1:wp9:verify                  EXIT 0   57 通过 / 0 失败 · WP9 = PASS
 5  pnpm m5.1.1:gates                       EXIT 0   harness 自检 53/0 · measurementInvalid = 0
 6  pnpm m5.1.1:wp9c0:verify                EXIT 0   43 通过 / 0 失败 · WP9-C0 = COMPLETE
 7  pnpm m5.1.1:wp9b2:verify                EXIT 0   42 通过 / 0 失败 · WP9-B2 = PASS
 8  pnpm m5.1.1:wp9b1:verify                EXIT 0   56 通过 / 0 失败
 9  pnpm m5.1.1:wp9a:verify                 EXIT 0   31 通过 / 0 失败 · WP9-A = PASS
10  pnpm m5.1.1:k17:verify                  EXIT 0   15 通过 / 0 失败 · K-17 = PASS
11  pnpm m5.1.1:k29:verify                  EXIT 0   41 通过 / 0 失败
12  pnpm m5.1.1:migration:verify            EXIT 0   117 通过 / 0 失败
13  pnpm m5.1.1:prod-copy:verify            EXIT 0   36 通过 / 0 失败 · PASS
14  pnpm m5.1:measurement:verify            EXIT 0   16 通过 / 0 失败
    （逐路径从 m5.1-complete 还原冻结面：1 条）
15  pnpm m5.1.1:wp8c1:verify                EXIT 0   15 通过 / 0 失败 · K-32 = PASS
16  pnpm m5.1.1:wp8c2:verify                EXIT 0   25 通过 / 0 失败 · K-33 = PASS
17  pnpm m5.1:gates                         EXIT 0   Hard Gates：PASS
18  pnpm m4.5:gates                         EXIT 0   全绿
19  pnpm m5.1:regression:verify             EXIT 0   全量回归判定：PASS · M51-G9 liveSmokeVerdict=PASS（**冻结历史读数**）
    （再逐路径还原冻结面：3 条 ⇒ 冻结目录与标签零差异）
```

**为什么 `wp10a` / `wp10b` / `wp10c` 没有在提交后重跑**（如实说明，不是遗漏）：

```text
· `wp10c` 会重跑**整条 `m4.5:ci`**（~12 分钟）+ 覆盖被 gitignore 的 CI 日志 + 再污染冻结面，
  而它的读数**已经**由 Commit 3 的证据承载；重跑只会产生第二份等价读数与一次额外的还原/提交往返。
· `wp10a` / `wp10b` 的门内有**"工作树干净"前置**（排除各自自己的写入面）。
  本轮 20 条命令会刷新一大批 `artifacts/m5.1.1/**`（被跟踪）⇒ 跑它们必须先把这些刷新回滚到 HEAD，
  那等于**抹掉**本轮刚产生的当前读数。两者不可兼得，因此选择"保留当前读数 + 不重跑"，
  并把这一点写进这里。
· 提交后的三个 commit（`ccec57f` / `743e55c` / Commit 4）**只含 `docs/**` 与 `artifacts/m5.1.1/**`**，
  不可能改变 `wp10a` / `wp10b` 的任何判据输入（它们的输入是 `scripts/**` + 迁移指纹 + 真实库边界身份）。
```

---

## 6. Known Issues（诚实边界）

```text
①  Live Smoke = **NOT RUN**（本机无 OPENAI_API_KEY；OPENAI_BASE_URL 亦不存在）。
    **⚠️ 2026-09-19 更正**：括号里的理由**不准确**（原文保留）—— 那几道门只 import `node:*`、
    **未加载 `.env`**，所以读到的 key 为空是**门的环境**，不是本机没有 key。
    准确依据是：**本轮没有跑 Live Smoke**。见 `M5.1.1-Gate-Decision.md` §11 与 AGENTS §8.1。
    canonical：`no key → NOT RUN`，**绝不能** mock 成 PASS。本门 spawn 过的 10 条命令里
    live/smoke 命令 = 0。`m4.5:ci:full`（= `m4.5:ci && m4.5:smoke:live`）本轮**没有**跑。
    ⇒ `M51-G9 liveSmokeVerdict = PASS` 读的是 **M5.1 期**的冻结 blob
       （`artifacts/m5.1/live-smoke-evidence.json`），**不得**读成"M5.1.1 期跑过 live smoke"。

②  M5.1 期那份 **734070 字节 · utf-16le · sha256 502c1d72…** 的 CI 日志
    （`artifacts/m5.1/wp9-m4.5-ci.log`，被 gitignore，磁盘级、git 不可还原）
    **已不在磁盘上** —— 被本门**第一次（因 C-G1 而中止）**的运行覆盖。
    fork 合规性：它的**边界身份**保存在**已提交的** `artifacts/m5.1.1/wp10a-preflight.json`；
    它的**解析读数**（`ciExit=0` · 逐门小结 26 · 硬门 3 · `regressionVerdict=PASS`）在第一次运行的 §1
    被 fork，且与覆盖后那份**逐字一致**；M5.1 期的权威回归读数另有**冻结 blob**
    `artifacts/m5.1/regression-evidence.json` 承载（本门 §5 的零差异断言覆盖它）。
    ⇒ **不主张**"原始 734 KB 日志仍可取回"。

③  `wp8c3:verify` 的 **C3-0 要求运行前工作树干净** ⇒ 它必须**最先、单独**跑。
    任何先跑的门都会重写被跟踪的 artifacts 而让 C3-0 变红（B1 / B2 / C0 / C1 / WP10-A/B 都登记过同一课）。
    WP10-C 的门把这条**跑序**写成了自己的判据（§0 断言干净 ⇒ §2 第一件事就是 `wp8c3`）。

④  **`replay` / `query` / `action` / `control` 四个 canonical 步骤跑在各自的隔离库上，
    不是跑在 WP10-B 的副本上** —— 那四个脚本都自隔离，结构性上无法被指向副本。
    WP10-B 在证据里**逐条标注 `where`**，**不**冒充"跑在副本上"。

⑤  `scripts/kernel-tests-dev-plane.ts` 的负控用例首行丢了换行（**纯空白**格式瑕疵）。
    **有意不修**：修它 = 在回归/记录 WP 里改一个 verifier 源码，收益为零。
    详见 `M5.1-Compatible-Assertion-Changes.md` §3.4。

⑥  `wp7:preflight / AT-W7-0` 仍 **inherited**（历史作用域护栏，不计入当前 correctness claim）。

⑦  `Generic trusted-envelope clone resistance` 仍 **OPEN / NOT PROVEN**（独立 WP）。

⑧  `K-31` = **OPEN / DEFERRED / NON-BLOCKING**（回复确认语义，本里程碑不解）。

⑨  `M511-G8`（Break-Glass Cognitive Override）= **NOT RUN** —— 从未被伪造为 PASS。

⑩  `WP9` 门仍**不在** `M511-G2` 的成员集合里（那个集合是 WP8-C3 冻结时的）；
    它的判定由 WP9 自己的验收清单与 handoff 承担。若要反映进 `m5.1.1:gates`，那是一次
    WP8 注册表变更，需另行裁定。

⑪  `ADR-043 = NOT APPROVED` ⇒ `Phase 4 = BLOCKED`；`M5.1-D01` = **`P1 OPEN`**；
    `M5.1.1 整体 = BLOCKED`（`Final Status Vocabulary` 明文）。
    三项能力缺口 **`DC-1` Conversation SYSTEM Producer · `DC-2` System-origin Action ·
    `DC-3` `D01-Background-System-Initiation`** = **`DEFERRED / NOT IMPLEMENTED`**。
    ⇒ **不得**写"`D01` 已全部关闭"，**不得**写"苏沐薇已经具备后台自主运行能力"。

⑫  C4 的 text-level false-loud（`MIGRATION_0009` 注释里的"系统自行发起"命中）**有意不修复**
    （R-46 §1：B0 的 historical criterion 被 R-45 取代，为一个历史选型量具的 console 更漂亮而改它
    没有 correctness 收益）。
```

---

## 7. 下一步

**下一个 WP 只能是 `WP11 — Phase 1–3 Closure`**（`M5.1.1-Master-Plan.md` / 执行计划的 WP11 段）。
**不得在同一次 execution 开始。** 本 WP 到此 **STOP**。

进入 `WP11` 前必须成立：

```text
1. `WP10 = PASS`（本文件 §4）且 `WP10-A/B/C` 判定齐备。
2. 工作树干净；五个冻结目录与 `m5.1-complete` 零差异；标签 object `2e718f38…` → commit `2aac6cad…`。
3. 真实库边界身份仍 == `38844f4e…`（1201 文件 / 31289946 字节 / 最新 mtime 2026-09-17T15:51:40.789Z）。
4. `MIGRATION_0007/0008/0009` 指纹仍 == `2d51997d…` / `0a2bd4fe…` / `5a007003…`。
5. `ADR-043` 仍 `NOT APPROVED` ⇒ `Phase 4` / `M5.1-D01` 的关闭**仍 BLOCKED**。
```

---

## 不主张（诚实边界）

```text
本 WP **不**主张 Live Smoke 被跑过（NOT RUN），也不主张 `m4.5:ci:full` 可用本机 PASS。
本 WP **不**主张 M5.1.1 已完成 —— `WP10` 只是 M5.1.1 执行计划里的一段；
  后面还有 `WP11 — Phase 1–3 Closure`，而 `Phase 4` / `M5.1-D01` 仍 `BLOCKED BY ADR-043`。
本 WP **不**主张 `M5.1-D01` 关闭（`P1 OPEN` 不变）。
本 WP **不**声称"苏沐薇已经具备后台自主运行能力"：
  `D01-Background-System-Initiation` 仍 `DEFERRED / NOT IMPLEMENTED`（R-48 明文：
  不能因为 E4 通过而销账，也不能把 `state-bootstrap` 改称为 background job）。
本 WP **不**主张"整个 M5.1.1 只有一处判据变更" —— 只登记本 WP 的变更面；
  里程碑级变更面由 `M5.1-Compatible-Assertion-Changes.md` 汇总。
本 WP **不**主张 `WP10-C` 的第一次（中止的）运行"不存在" —— 它逐字保留在
  `artifacts/m5.1.1/wp10c-gate-exits.txt` 的第一节里。
```
