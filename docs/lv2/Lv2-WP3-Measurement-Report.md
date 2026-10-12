# Lv2 WP3（一）—— 量具有效性：选档判据 · 清单契约 · 硬门缺陷负控

> 计划：[`Lv2-Acceptance-Plan.md`](Lv2-Acceptance-Plan.md) §4 `LV2-G2`（"独立 oracle、语义评分、**全分母**、
> **源码适用性**、聚合规则 | 每个硬门**正控 / 缺陷负控 / 恢复**成立；**恒空 / 全拒实现不能 PASS**；
> `measured_count > 0`"）· §11.1（"新聚合器只读证据，按**正式结束时间/身份**先选最新正式候选 run，
> 再验证适用性；最新 run 为 FAIL 或 INVALID 时保持该状态，不退选旧 PASS；零分母 INVALID"）·
> §7 `WP3`（"当前模块门、独立 oracle、聚合失效控制 | 非零合法路径；恒空、全拒、旧 PASS 掩盖新 FAIL 均被拒"）。
>
> 日期：2026-10-02（北京时间）。候选 HEAD：**`22b926eac40e11484e2dded83ad1f7714c537cee`**（`main`）。
> 入口：`pnpm lv2:measurement:verify`（= `scripts/lv2-measurement-verify.ts`），**EXIT 0**。
> 证据：`artifacts/lv2/lv2-wp3-measurement-20261002-22b926eac40e-68da/`（本轮**当前**读数）
> + `…-10ed76506272-1209/`（上一代，14 项）+ `…-8a8a1179ef07-2f0c/`（夹具形状错的 FAIL 档，见 §3）。
>
> **本轮读数**：判定项 **19 · 通过 19 · 未通过 0** ⇒ `verdict = PASS`，另 1 条**读数**（不进判定）。
> **模型请求 0** · **数据库未打开**（连隔离库都不建）· 全程在 `mkdtemp` 合成夹具 + 只读真实证据 +
> 三次 `lv2:core:verify` 子进程上完成。

---

## 0. 为什么这一步必须**先**做

`LV2-G2` 的第一句是"**量具自己也要被验证**"（`INV-M45-06`）。而 WP0 在当前 HEAD 重取各门读数时，
量到了三处**同族**缺陷（`Tech-Debt-Register` §0m / `R-34`·`R-35`·`R-36`，登记为 **`TD-23`**）：

```text
既有聚合门用 `statSync(dir).mtimeMs` 选"最新一份档"——
  · `m10.1:gates` 四份 200 轮真模型档 mtime 全等 ⇒ 并列落到目录名字典序最后 ⇒ 选中更早的 FAIL
  · `m5.5.1:gates` 语义门取到 TD-11 的**小样本诊断档**（三份 mtime 同秒）
  · `m4.5:gates` G14 量到 2026-09-30 的失败档
```

⇒ 如果 Lv2 自己的聚合器（`lv2:gates`，WP7）沿用同一套选档方式，它会**继承同一个缺陷**，
而 Lv2 的全部判定都建立在"最新那份读数"上。

**本轮新增两件东西**：

| 文件 | 作用 |
|---|---|
| `scripts/lv2-gate-select.ts` | **选档与适用性的唯一实现**：`readLv2Runs` · `selectLatestFormalRun`（按 `ended` → `runId`，可限定 `wp`）· `freshnessOf`（源指纹适用性）。刻意不看 `mtime` / 目录名顺序 / `verdict` |
| `scripts/lv2-measurement-verify.ts` | `pnpm lv2:measurement:verify`：上面那两样 + 清单契约 + **硬门自己的缺陷负控** |

---

## 1. 门的读数（19 项判定 + 1 条读数）

| 阶段 | 检查 | 判定 | 它证的是什么 |
|---|---|---|---|
| 正控 | `P1-selection-picks-newest-formal-by-identity` | ✅ | 在 **mtime 全部并列**的夹具上，真实现选中 **`ended` 更晚**的那份（`…aa02` PASS），而不是字典序最后的 `…ff01`（更早的 FAIL） |
| 正控 | `P2-ineligible-runs-excluded-with-named-reasons` | ✅ | **零分母** / **带注入标记** / **缺 `ended`** 三类各被排除并给出**具名**理由；合格候选恰好 2 份 |
| 正控 | `P6-wp-filter-limits-candidates` | ✅ | 限定 `wp` 后候选收敛（同一道门才互相比较） |
| **负控** | `N6-empty-candidate-is-null-not-pass` | ✅ | 候选为空 ⇒ `selected = null`（调用方必须当 **NOT RUN**，不是 PASS） |
| **负控** | `N1-defective-mtime-selector-is-detected` | ✅ | **注入 `TD-23` 的原始缺陷选择器**（mtime 升序 + 目录名升序取最后一个）⇒ 它**确实**选中更早的 FAIL，与真实现的答案**不同** ⇒ 证明这个检测器真的会响 |
| **恢复** | `R1-real-selector-quiet-again` | ✅ | 放回真实现 ⇒ 重新安静（仍选中更晚那份） |
| 正控 | `P3-freshness-positive` | ✅ | 指纹对得上 ⇒ `fresh=true` 且 `checked=1` |
| **负控** | `N2-freshness-detects-stale-source` | ✅ | 指纹对不上 ⇒ `fresh=false` 且 `stale` 里**具名**列出那一条 |
| **负控** | `N3-empty-fingerprints-is-invalid-not-pass` | ✅ | **零个指纹** ⇒ `checked=0` 且**绝不**报 fresh（"测了 0 项"≠"全部一致"，`AGENTS.md` §6.8） |
| 正控 | `P4-manifest-contract-accepts-well-formed` | ✅ | 合契约的清单 **0 问题** |
| **负控** | `N4-manifest-field-negative-controls` | ✅ | **逐字段**删掉 `lv2-manifest@1` 的 **25** 个必填字段，每一个都必须报出**它自己**（**25/25 命中**） |
| **负控** | `N5-manifest-payload-tamper-detected` | ✅ | 封完再改一个字段 ⇒ `payloadSha256` 不符必须被报出（"清单被事后改过"可机器判定） |
| 正控 | `P5-real-evidence-selection-matches-independent-recompute` | ✅ | **真实** `artifacts/lv2/` 下全部 run 的清单都可解析；选档结果与"独立重算（只看 `ended`）"一致 |
| 自检 | `SELF-measured-count-and-denominators-positive` | ✅ | 门的判定项 ≥ 8 且最新真实 run 的指纹项 > 0 且分母 > 0 |
| 读数 | `READING-newest-real-run-freshness` | 📖 | **不参与判定**：最新真实候选 run 的源码适用性（见 §2.2） |
| 正控 | `P7-hard-gate-positive-control` | ✅ | 真源码上 `lv2:core:verify` **EXIT 0** |
| **负控** | `N7-hard-gate-defect-negative-control` | ✅ | **注入 `R-29` 的效应** ⇒ 它必须 **EXIT 1**，且写入的 FAIL 档**带注入标记**、其中 `A1` 正控失败 |
| **负控** | `N8-injected-run-excluded-from-formal-candidates` | ✅ | 带注入标记的档**不在**正式候选里（选档排除它），但原始读者仍能看到它 |
| **负控** | `N9-injected-source-restored-byte-identical` | ✅ | 恢复后源文件 sha256 与改前**逐字相同**（`097aa6ab…e3f7`） |
| **恢复** | `R2-hard-gate-quiet-after-restore` | ✅ | 恢复后 `lv2:core:verify` **重新 EXIT 0**（安静） |

**分母**（`manifest.denominators`）：`gateChecks=19` · 正控 7 · 负控 8 · 恢复 2 · 自检 1 ·
`manifestFieldsNegativeControlled=25` · `fixtureRuns=6` · `hardGateSubprocessRuns=3`。
⇒ **`measured_count > 0` 成立**，"恒空实现"不可能通过本门。

---

## 2. 四处值得单独说的读数

### 2.1 `TD-23` 在 Lv2 侧的闭环：缺陷被**复现**、判据被**验证**

`N1` 不是"我们写了正确的选择器"，而是"**我们把既有聚合门的那套选档方式原样搬进夹具，
并证明它在 mtime 并列时会选错**"：

```text
夹具（六份 run，五份的目录 mtime 被 utimesSync **压成完全相同** —— 这正是 TD-23 的现实条件）
  正确：…-aa02（ended 00:00:02Z · PASS）
  陷阱：…-ff01（ended 00:00:01Z · FAIL，且**目录名字典序在最后**）
缺陷选择器 ⇒ 选中 …-ff01（更早的 FAIL）      ← N1 实测
真实现     ⇒ 选中 …-aa02（更晚的 PASS）      ← P1 / R1 实测
```

⇒ `TD-23` 的**关闭要求 ①**（选档依据换成清单身份/正式结束时间）在 Lv2 侧**已实现且已被验证**；
**②**（三段式）由 `P1` / `N1` / `R1` 三格构成；**③**（`measured_count > 0`）由 `SELF` 一格承担。

⚠️ 本门**不**改既有里程碑的聚合器（`TD-23` 逐字只要求 Lv2 自己的不继承该缺陷），
`m10.1:gates` / `m5.5.1:gates` / `m4.5:gates` 的那三个读数**各自归属、原样保留**。

### 2.2 真实数据上的"旧 PASS ≠ 当前适用"（机器形态）

本轮**第一次**运行（runId `…-8a8a1179ef07-2f0c`）因为夹具自身的 runId 后缀用了非十六进制字符
（`zz` / `mm` / `nn` / `pp`）而被 **runId 形状闸**判为非法 ⇒ **12/14 FAIL**（详见 §3）。
修正夹具后重跑得 14/14 PASS（`…-10ed76506272-1209`），再加硬门负控后得 **19/19 PASS**（`…-22b926eac40e-68da`）。

而那条 `READING` 恰好把"**旧档为什么不能用**"量了出来：

```text
（在 …-10ed76506272-1209 那次运行**开始时**）
最新真实候选 run = lv2-wp3-measurement-…-8a8a1179ef07-2f0c（FAIL 档）
  freshness = { fresh: false, checked: 7, stale: ['scripts/lv2-measurement-verify.ts'], missing: [] }
```

⇒ 那一份 FAIL 档的源指纹**已经对不上**当前文件（夹具被修过）⇒ 它的适用性是 **INVALID**，
不是"当前仍然 FAIL"。这正是 `LV2-G2` 要的"**源码适用性**"与计划 §11.1 的"INVALID 不等于已复现新缺陷"。

⚠️ 它同时说明一个新判据：**本门看不到自己**（写清单之前就算读数）——
聚合器必须在**读**的时候重算适用性，而不是在写的时候。

### 2.3 硬门自己的三段式：`R-29` 的缺陷被**真的注入**过一次

`LV2-G2` 要求"每个**硬门**正控/缺陷负控/恢复成立"。Lv2 目前唯一的硬门是 `lv2:core:verify`，
于是本门用与 M5.1.1 / M10 / M11 的 `*:measurement:verify` 同一条手法跑了一次**真注入**：

```text
① 逐字节读入 src/kernel/contracts/goal-proposal.ts（sha256 = 097aa6ab…e3f7）
② 把 `commitment: ['create'],` 改成 `commitment: [],`   ← 复刻 R-29 的效应（模型面再也表达不出承诺）
   锚点唯一性先自检（命中 1 处才动手）
③ 子进程跑 lv2:core:verify（带 LV2_INJECTION=R-29-effect-fixture）
   ⇒ EXIT 1 · A1 正控失败 · 写出的档 = lv2-wp2-core-20261002-22b926eac40e-c1a2（带注入标记）
④ finally：写回**原字节** ⇒ sha256 与①逐字相同（N9）
⑤ 再跑一次 ⇒ EXIT 0（R2）
```

⇒ 这条证据的分量在于：**门的 FAIL 不是因为"我们觉得它会失败"，而是真的把一个产品缺陷放回去、
看着它红，然后再看着它绿**。同时 `git status` 在整轮结束后**只有新增的未跟踪证据**，
`src/**` 一个字节都没变（`N9` 的 sha256 与 `git` 各自独立证明这一点）。

### 2.4 两代读数并存（"更晚的 PASS 取代更早的 FAIL"）

`artifacts/lv2/` 现在有八份 run。本门自己有两代 + 一份事故档：

| run（`wp3-measurement`） | verdict | ended | 说明 |
|---|---|---|---|
| `…-8a8a1179ef07-2f0c` | `FAIL` 12/14 | 09:07:29Z | 夹具 runId 形状错（§3 事故档，**保留**） |
| `…-10ed76506272-1209` | `PASS` 14/14 | 09:08:00Z | 修正夹具后的上一代 |
| `…-22b926eac40e-68da` | `PASS` 19/19 | 09:11:02Z | **当前读数**（加硬门负控） |

`wp2-core` 四份：`…-f68e103d6e18-8d1e`（WP2 正式档 PASS）· `…-22b926eac40e-df32`（P7 正控 PASS）·
`…-22b926eac40e-c1a2`（**注入档 FAIL，带标记**）· `…-22b926eac40e-eabe`（R2 恢复 PASS）。

按选档规则取最新：`wp3-measurement` → `…-22b926eac40e-68da`（PASS）；
`wp2-core` → `…-22b926eac40e-eabe`（PASS），注入档**不在**候选里（`N8` 逐条断言）。
旧 FAIL 档**留在库里**（`TD-16` 不回写），它的适用性由 `freshnessOf` 单独报 `stale`。

---

## 3. 过程事故（如实登记，不回写）

```text
第一次运行（runId …-8a8a1179ef07-2f0c）：12/14，FAIL
  失败项：P2（合格候选数不是 2）· P6（限定 wp 后候选数不对）
  根因：夹具的六份 runId 后缀写成 zz01 / mm03 / nn04 / pp05 / qq06 ——
        `LV2_RUN_ID_PATTERN` 要求后缀是**4 位十六进制**（`zz`/`mm`/`nn`/`pp`/`qq` 都不是）
        ⇒ 六份**全部**被"runId 形状非法"排除 ⇒ 候选集塌成 1 份
  含义：这不是产品缺陷，而是**夹具形状错**；但它顺带证明了三件事：
        ① runId 形状是**判据的一部分**（不是命名习惯）；
        ② 门的**拒绝路径真的会响**（没有把非法档当好档）；
        ③ 夹具自己也要能被拒 —— 与 `AGENTS.md` §6.9（"数字对 ≠ 数字描述的是你以为的那个东西"）同族
  处置：修正后缀为 ff01/aa02/bb03/cc04/dd05/ee06 后重跑 ⇒ 14/14，再加硬门负控 ⇒ 19/19；
        **FAIL 档保留**（历史读数，且它的指纹现在是 stale，如实）
```

---

## 4. 本门**不**主张什么

- **不**判任何语义/行为门的通过与否（那要各自的语料与真模型档）；
- **不**主张既有里程碑的三个聚合器已被修复（`TD-23` 只要求 Lv2 自己的不继承该缺陷）；
- **不**主张 `LV2-G2` 已经通过：它还差"**独立 oracle**"（本轮是选择器/契约/硬门负控三块）
  与"其余启用模块的合法路径非零样本"（见 §5）；
- **不**主张聚合器已经可用（`lv2:gates` 是 WP7 的交付物）。

## 5. 复现与下一步

```bash
pnpm lv2:measurement:verify     # EXIT 0（19/19 · 0 模型请求 · 未开库；内部会跑三次 lv2:core:verify）
pnpm lv2:core:verify            # EXIT 0（9/9 · 0 模型请求 · 隔离库 · cleanClose=true）
```

**WP3 剩余**（下一轮）：

1. 把 `lv2:core:verify` 的"非零正控/负控/恢复"**扩到当前启用的其余模块**
   （记忆创建/更正/遗忘 · 召回 · 信念 · 情绪 · 目标状态的入模与截断），
   使 `LV2-G1` 的"每条合法路径有非零样本"有机器判据；
2. 给**其余硬门**（届时每一个）都补缺陷负控 —— 手法已在本轮固化（注入 → 断言红 → 恢复 → 断言绿）；
3. 把 `lv2:core:verify` / `lv2:measurement:verify` 登记进 Lv2 的门清单与 lane
   （选档一律走 `scripts/lv2-gate-select.ts`）。
