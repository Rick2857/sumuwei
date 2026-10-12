# WP8-B Handoff — Full Attribution Measurement & Gate Harness

> **执行令**：`WP7 = PASS · K-29 = CLOSED · K-17 = CLOSED · K-31 = OPEN / DEFERRED / NON-BLOCKING`；
> **只做 WP8-B，做完即 STOP；不得开始 WP9。**
>
> **判定**：`pnpm m5.1.1:wp8:verify` = **48 通过 / 2 失败** ⇒ **WP8-B = PARTIAL / BLOCKED**
> （`M511-G6` FAIL · `M511-G9` FAIL；其余七门 PASS / NOT RUN）。
> 两个失败各自是一个新的 P1：**K-32**、**K-33**（**只登记，没有在本 WP 修**）。

```text
Changed Files

  新增（本 WP 的交付物）
    scripts/m5.1.1-attribution-gate-registry.ts    统一门清单（九门 + 26 verifier + 19 claim 锚 + 7 mutation 锚）
    scripts/verify-m5.1.1-wp8-harness.ts           pnpm m5.1.1:wp8:verify
    scripts/m5.1.1-gate-results.ts                 pnpm m5.1.1:gates（汇总器）

  改动
    package.json                                   注册两个新脚本
    scripts/verify-m5.1.1-k17-consumer-impact.ts    分类表 +1 条（新注册表文件命中 Axis B 名字 ⇒ 必须分类，否则 K-17 报 BLOCKED）
    docs/m5.1.1/M5.1.1-Execution-Plan.md            R-37（K-32）/ R-38（K-33）
    docs/m5.1.1/M5.1.1-WP8-Compatible-Assertion-Record.md   本 WP 的 F4（含 §8 三条仪器观察）
    artifacts/m5.1.1/wp8-*.json / *.txt / *.log     证据（14 个文件）
    artifacts/m5.1.1/gate-results.json              汇总器输出

  没有改
    src/**（零行生产代码）· migrations.ts · page.html · developer-query.ts · attribution.ts
    artifacts/m5.1/** 的内容（**只做还原**，见 Known Issues #1）· data/pglite

Tests Run

  pnpm typecheck                      EXIT=0
  pnpm m5.1.1:wp8:verify              EXIT=1（48 通过 / 2 失败 —— 见下）
  pnpm m5.1.1:gates                   EXIT=1（G6 / G9 FAIL ⇒ 汇总不通过）
  —— 以下 25 道既有 verifier 由 harness 逐门跑了一遍（全部复用，未重新实现）——
  m5.1.1:test · kernel:test:conversation · m5.1.1:migration:verify · m5.1.1:prod-copy:verify ·
  m5.1.1:k16 · k17 · k19 · k20 · k25 · k29 · m5.1.1:wp3 · wp3.2 · wp4 · wp4.1 · wp5 · wp5.1 · wp6 · wp6.1 · wp7 ·
  m5.1:test · m5.1:query:verify · m5.1:control:verify · m5.1:observability:verify · m5.1:page:verify ·
  m5.1:measurement:verify

Tests Passed

  48（harness 自查）
    §0 只读预检 5/5 · §1 门覆盖 + 三段式 7/7 · §3 量具健康 6/6
    §4 跨门一致性 5/5 · §5 十二条不变量/反例 12/12 · §6 七个 mutation 7/7 · §7 兼容性 4/5 · §8 还原 3/3
  25 门里 24 门 EXIT=0

Tests Failed

  2（各自是一个 P1 缺陷，**未修**）
    ❌ 有一条门的证据报红：`wp3(failed=1 · verdict=FAIL)`           → M511-G6 FAIL → **K-33**
    ❌ §7 约束④ `artifacts/m5.1/**` 一字未动                        → M511-G9 FAIL → **K-32**

Evidence Produced

  artifacts/m5.1.1/wp8-gate-manifest.json          九门判定 + 26 verifier 逐条运行结果 + 覆盖 + 兼容性 + 摘要
  artifacts/m5.1.1/wp8-measurement-health.json     逐门量具健康（Σ measurementInvalid = 0）
  artifacts/m5.1.1/wp8-cross-gate-consistency.json crossGateConsistencyViolations = 0（3 事实 × 6 独立副本）
  artifacts/m5.1.1/wp8-negative-controls.json      覆盖负控三段式（合成 verifier / 幽灵条目 / 摘 pnpm 入口 / 恢复安静）
  artifacts/m5.1.1/wp8-invariants.json             19 claim × 71 锚，19/19 成立
  artifacts/m5.1.1/wp8-mutations.json              七个 mutation 逐条锚到"既有门真的响过"
  artifacts/m5.1.1/wp8-gate-exits.txt              25 门 exit code + 未跑的门与理由
  artifacts/m5.1.1/wp8-restore-whitelist.txt       33 条被重写路径 blob 前后对照（byte_exact_mismatches = 0）
  artifacts/m5.1.1/wp8-verify.log · wp8-typecheck.log · wp8-gates-summary.log · wp8-probe-exits.txt
  artifacts/m5.1.1/wp8-k33-wp3-gate-red.log        复现 K-33 的完整 stdout
  artifacts/m5.1.1/wp8-k34-wp7-preflight-red.log   复现 §8.1 仪器观察的 stdout
  artifacts/m5.1.1/gate-results.json               汇总器输出（判定以 harness 的**当前 exit code** 为准）

Known Issues

  1. **K-32（P1, OPEN）**：永久冻结的 `artifacts/m5.1/**` 在 HEAD 上已被 M5.1.1 期的运行结果覆盖
     （`wp1-contracts.json` 52→53 + counts 键；`query-negative-control.json` 40/31→41/33 + 新 id/digest）。
     引入者 = WP7 的 `029aec3`（`git add -A`）；`1a376b7` 只补了 fork，**还原目标是当时的 HEAD**，
     所以冻结内容仍被改。WP8 **只还原到 HEAD**（既不加重也不悄悄修复）并逐路径留证。
     修复建议见 R-37（留给下一个 WP）。
  2. **K-33（P1, OPEN）**：`pnpm m5.1.1:wp3:verify` 在 HEAD 上红（`K-23 结构性证明②` 过宽匹配三个读路径文件）。
     它自 WP4.1 起被每个 WP 显式跳过 ⇒ 回归长期不可见。不是生产语义缺陷，但**是一道无法通过的硬门**，
     而且真判据当前是空转。修复建议见 R-38（改判据属于独立决策）。
  3. **K-21 的旧证据措辞**：已提交的 `wp2.4-k20-anti-fabrication.json` 里仍写着 `K-21 … OPEN`，
     而 R-19 已裁定、当前源码已用 `U` ⇒ **本次实测该冲突 = 0**。旧证据不改（它属于历史），
     只登记为读数陷阱：读旧证据时不要把那句 OPEN 当成现状。
  4. `m5.1.1:wp7:preflight` 现在报红（WP7 期的作用域护栏，基线早于 K-29 的受权改动）。
     已分类为 `historical-scope-guard`，不计入当前 correctness claim；建议加允许面或退役（见 F4 §8.1）。
  5. K-31 仍 OPEN / DEFERRED / NON-BLOCKING；本 WP 一字未碰。

Architecture Deviations

  1. **汇总器的判定源换了**：原计划里 `pnpm m5.1.1:gates` 是"只读已落盘证据"。
     实测发现这样会**假绿** —— 落盘的 `wp3-backfill.json` 是 WP3 那次运行的 PASS，
     而门现在 exit 1。所以汇总器改成：**以 wp8 harness 的当前 exit code 为准**；
     没有 harness 读数时一律 `not-run`（不是 PASS）。这是**收紧**，不是放宽。
  2. **"计数范围非空"的落地形式**：本仓库有两代证据形状，判据按形状分支（F4 §3）。
     要求没变：报不出任何范围的证据照样判红。
  3. **还原面收窄**：从"运行后新出现且未声明的改动"改为"**注册表声明过的**写入面 ∩ 与 HEAD 不同"。
     未声明路径**只报告、绝不还原**（第一版曾误还原作者自己的文档改动，已修并留证）。
  4. **`M511-G9` 的约束②（不得删除/放宽旧判据）不能机械判定** ⇒ 如实声明由兼容性记录承担，
     harness 不假装能判它。

Commit Hash

  21730c5  feat(m5.1.1): add the WP8-B attribution measurement & gate harness
  df90168  fix(m5.1.1): restore package.json formatting（本次注册脚本时误把整个文件重排成 2 空格）
  9d7fe4a  docs(m5.1.1): WP8-B verdict, K-32/K-33 registrations, F4 and handoff
  9a4fa6f  test(m5.1.1): WP8-B harness evidence

  提交后再从**已提交的树**跑了一次 `pnpm m5.1.1:wp8:verify`：判定逐字复现
  （`M511-G6` FAIL · `M511-G9` FAIL · 48 通过 / 2 失败 · 红门只有 wp3 · 门覆盖 0/0/0 · 真库指纹三项一致）。
  唯一变化是 WP8 **自己**那几个证据文件的时间戳与 K-19 记录的"被改写证据的内容哈希"
  （那两个哈希本身就是易变读数，见 F4 §8）—— 因此本 WP 的证据保持为第一次运行的读数，未重复提交。
  真实库 `data/pglite` 的 mtime 仍是 2026-09-17 23:51:40。

Next WP Preconditions（**不要在本 execution 开始**）

  1. **先裁定 K-32 与 K-33**（都是 P1、都阻断 WP8 final acceptance）。两者都是**机械可修**的：
     · K-32：把 `artifacts/m5.1/query-negative-control.json` 与 `artifacts/m5.1/wp1-contracts.json`
       还原到 `m5.1-complete` 的 blob；`wp7-wp1-contracts.json` / `wp7-query-negative-control.json`
       作为 M5.1.1 期证据的正式落脚点保留；更正 WP7 记录 §6 的措辞并补一条兼容性记录。
     · K-33：把 wp3 门的 `recordedBy` 扫描收窄到**写路径**（排除读回映射与 DTO 定义）；
       改判据必须连同判据记录 + 正/负控 + 兼容性记录一起出。
  2. 修完之后重跑 `pnpm m5.1.1:wp8:verify` + `pnpm m5.1.1:gates`；**只有这两条都绿**，
     `WP8 = PASS` 才成立（届时 `M511-G1…G7` 全 PASS、`G8` = NOT RUN、`G9` = PASS）。
  3. 然后才轮到 **WP9 Real Runtime E2E（E1–E8）**；WP9 需要至少 Level 1 + Level 2 证据。
  4. K-31 仍 OPEN / DEFERRED；Phase 4 / ADR-043 仍 **NOT APPROVED**；
     `m4.5:ci` / `m5.1:gates` / `m5.1:regression:verify` 仍留给 WP10。

STOP
```

---

# Final Requalification（WP8-C3，2026-09-19）—— **追加，不改写上面的历史**

> 上面那份 handoff 是 **WP8-B 首次测量**的读数，**必须原样保留**：
> 它记录的是"harness 第一次跑就真的找到了问题"，而不是"WP8 从头到尾一直是绿的"。

```text
WP8-B initial measurement:
  PARTIAL / BLOCKED（48 / 2；随后重跑复现为 49 / 1）
    M511-G6 FAIL ← K-33（wp3 门在 HEAD 上红）
    M511-G9 FAIL ← K-32（冻结的 artifacts/m5.1/** 被 M5.1.1 期结果覆盖）

K-32:
  CLOSED by WP8-C1（从 immutable `m5.1-complete` 还原两条路径；新门 wp8c1:verify 15 / 0）
K-33:
  CLOSED by WP8-C2（K-23 结构证明②从"字段名出现扫描"换成**权威写能力边界分析**；wp8c2:verify 25 / 0）
WP8-C3:
  PASS（39 / 0）

FINAL M5.1.1 WP8:
  PASS
```

## C3 最终读数（`pnpm m5.1.1:wp8c3:verify` = 39 通过 / 0 失败）

```text
九门：G1 PASS · G2 PASS · G3 PASS · G4 PASS · G5 PASS · G6 PASS · G7 PASS · G8 **NOT RUN** · G9 PASS
     （G8 = NOT RUN 是正确状态：break-glass 没有入口 ⇒ NOT RUN > synthetic PASS）

pnpm m5.1.1:wp8:verify   EXIT=0  **50 通过 / 0 失败**（WP8-B 时是 48/2 → 49/1 → 50/0）
pnpm m5.1.1:gates        EXIT=0  九门读数与 harness 一致（以当前执行真相为准，不用陈旧历史证据顶替）

measurementInvalid = 0
missingGate = 0 · staleGate = 0 · unclassifiedVerifier = 0
crossGateConsistencyViolations = 0
19 条 claim / 71 条锚 全部成立 · 七个 mutation 锚定全部成立
每一条有证据的门都报出非空测量范围（measured_count > 0）；负控真的响、恢复真的安静
```

## C3-1 命名明确化（纯表示，不是边界变更）

```text
M5L_FREEZE = { tagName: 'm5.1-complete',
               tagObjectId: '2e718f38…',      ← annotated tag 自身的对象 id
               targetCommitId: '2aac6cad…' }  ← 它指向的 commit（git rev-list -n 1）
+ 逐条验证：rev-parse == tagObjectId · rev-list -n 1 == targetCommitId · ^{commit} 一致
+ 标签**没有 repoint**（tag object id 逐字未变）；冻结边界语义未动
+ 冻结面还原来源写死为 `m5.1-complete:<path>`（harness §8 硬化，见下）
```

## C3-6 冻结证据在**跑完完整 harness 之后**的复验（K-32 真的长期解决）

完整 harness 实际跑了历史上污染冻结证据的两个 writer（`m5.1:test`、`m5.1:query:verify`）。之后：

```text
冻结面 23 条路径：tag blob == HEAD blob == 工作树 blob，mismatch = 0
git diff m5.1-complete..HEAD -- artifacts/m5.1 artifacts/m4.5  =  空
pnpm m5.1.1:wp8c1:verify  EXIT=0（K-32 重新 PASS，不是"跑前暂时干净"）
```

**硬化**：harness §8 现在按路径判定来源 —— 冻结面（`artifacts/m5.1` · `artifacts/m4.5`）的内容
**只能**取自 immutable 标签 `m5.1-complete:<path>`，其余路径才用 HEAD 还原；
`wp8-restore-whitelist.txt` 逐行写出 `source`。C1 建立的不变量从"纪律"变成了**代码**。

## C3-7 K-33 再资格化

```text
pnpm m5.1.1:wp8c2:verify  EXIT=0 · pnpm m5.1.1:wp3:verify  EXIT=0
authoritative writer count = 1 · callerControlledProviders = 0 · unexplainedReferences = 0
```

## C3-10 最终证据（三代事实并存）

```text
artifacts/m5.1.1/wp8c3-final-requalification.json   最终判定 + 九门 + 全部读数 + 还原对照
artifacts/m5.1.1/wp8c3-gate-results.json            汇总器输出（本次执行真相）
artifacts/m5.1.1/wp8c3-measurement-health.json      量具健康 + claim/锚/ mutation 计数
artifacts/m5.1.1/wp8c3-cross-gate-consistency.json  D01 · K-27 · K-29 · K-23 · 指纹 · 展示层
artifacts/m5.1.1/wp8c3-freeze-integrity.json        冻结面 23 条路径的 tag/HEAD/工作树三方对照
artifacts/m5.1.1/wp8c3-gate-exits.txt               C3-8 矩阵逐条 exit code
artifacts/m5.1.1/wp8c3-restore-whitelist.txt        16 条跑动路径的还原来源与 blob 对照（mismatch = 0）
—— 上面三份**未被覆盖**：wp8-*（WP8-B 首测）· wp8c1-*（K-32）· wp8c2-*（K-33）
```

## 需要如实记下的一处过程事实

C3 第一次运行时我在命令里用过一次 `git checkout -- artifacts/m5.1.1/`（整目录 checkout）。
它**没有造成内容损失**：那一刻该目录下被跟踪且被修改的文件，恰好都是上一次失败的 C3 运行留下的
门证据（我本 WP 的意图性改动都在 `scripts/`、`docs/`、`package.json`），事后树状态也证明没有丢东西。
但它仍然**违反**"逐路径还原、不做无差别 checkout"的规矩 —— 因此记在这里，而不是隐去；
后续还原一律走逐路径 + 来源标注（`wp8c3-restore-whitelist.txt` 就是这么写的）。

## 正式状态

```text
WP8-C1 / K-32   PASS / CLOSED
WP8-C2 / K-33   PASS / CLOSED
WP8-B           PARTIAL / BLOCKED（历史读数，保留）
WP8-C3          PASS
**WP8           PASS**
WP9             READY / AUTHORIZED（**不在本 execution 开始**）
K-31            OPEN / DEFERRED / NON-BLOCKING
```

**仍然不主张**：本 PASS 不主张 break-glass 已实现（`G8 = NOT RUN`）、不主张 WP9 的真实运行时 E2E
已做过、不主张 `m4.5:ci` / `m5.1:regression:verify` / Live Smoke 已跑（留给 WP10）、
也不主张 K-31 已修。
