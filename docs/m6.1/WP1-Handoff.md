# WP1 交接单（M6.1）

> 日期：2026-09-22。格式按 [`M6.1-DSH-Execution-Plan.md`](M6.1-DSH-Execution-Plan.md) §8。
> WP0 的交接见 [`WP0-Handoff.md`](WP0-Handoff.md)。

## 1. 候选与运行相关树指纹

```text
仓库根             C:\Users\user\Desktop\project LG
HEAD               958c6be6a213d260d0753a637aa2480c15b8a889
分支               feature/m6-lv1-hardening
WP1 runId          m6.1-wp1-20260922-46bc68f5a99a-bcf6     （**verdict = FROZEN**，见 §14）
                   m6.1-wp1-20260922-958c6be6a213-c617     （verdict = AWAITING HUMAN REVIEW，冻结前的读数，保留）
WP1 运行相关输入摘要 fec4f772f552a24945b08588bb2179a2064931d7aa8c5dad3893b353faa4550c
                   （定义见 manifest 的 runRelevantTreeShaDefinition：**不是**目录树摘要，
                     而是本次运行依赖的 7 个输入文件的 {path, sha256} 列表摘要）
WP1 executed       68 / 68 完成 / 0 跳过 / 0 失败
WP0 runId          m6.1-wp0-20260922-958c6be6a213-7305     （verdict = BASELINE CAPTURED）
```

**一个有意保留的观察**：WP1 的 `…-c617` 轮次是在「影响面的 `scripts/m6.1-wp0-baseline.ts`、
`scripts/gates/affected-map.ts` 又被改过」之后**仍然有效**的那一轮 —— 因为它的清单把
`runRelevantTreeSha` 绑定在**它自己声明的 7 个输入**上，而那 7 个文件没变。
`m6.1:gates` 复算每条证据的 sha256 后判它 `usable=true`。

## 2. 本轮变动的文件

```text
新增（M6.1 自产）
  scripts/m6.1-corpus-build.ts     语料构装器（编排表 + 确定性分集 + 写出 JSONL/manifest/回归/草案）
  scripts/m6.1-wp1-corpus.ts       WP1 门（语料 + 分集自洽 + G1 指针 + gitignore 闸 + 金标准）
  scripts/m6.1-gates.ts            汇总门（**显式 manifest 引用**式，拒绝"按最新 PASS 选证据"）
  scripts/m6.1-live.ts             Live 入口（四条守卫，如实拒绝未实现套件）
  evals/m6.1/corpus/{dev,calibration,heldout}.jsonl   68 条合成语料
  evals/m6.1/regressions/g1-confirmed.json            3 条 G1 具名回归（**指针式**）
  evals/m6.1/annotations/labels.draft.json            助手草案（DRAFT）
  evals/m6.1/manifest.json                            语料清单（版本/种子/分母/逐文件 sha256）
  docs/m6.1/M6.1-Judgment-Contract.md                 判定契约（DRAFT，待真人批准）
  docs/m6.1/WP1-Handoff.md                            本单
点状编辑（共享文件，**只追加**）
  package.json                     追加 m6.1:corpus:build / m6.1:wp1:verify / m6.1:gates / m6.1:live
  .gitignore                       追加 artifacts/m6.1/local/ 与 artifacts/m6.1/**/*.log
点状编辑（**并发持有**的加速器子系统，只在最新写入安静 >3h 后才动）
  scripts/gates/affected-map.ts    只加一条 AFFECTED_RULES 规则
新增证据
  artifacts/m6.1/m6.1-wp1-20260922-958c6be6a213-c617/{wp1-corpus.json,manifest.json}
  artifacts/m6.1/local/<wp1RunId>/{annotation-worksheet.md,regression-turns.json}   （gitignored）
```

## 3. 命令与退出码（逐条实测）

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | 干净 |
| 2 | `pnpm m6.1:test` | **0** | **61 通过 / 0 失败** |
| 3 | `pnpm m6.1:corpus:build` | **0** | 68 条 · 判据安静（0 问题）· dry-run |
| 4 | `pnpm m6.1:corpus:build --write` | **0** | 写盘成功；**重复构装逐字节相同（已实测）** |
| 5 | `pnpm m6.1:wp1:verify` | **0** | verdict `AWAITING HUMAN REVIEW` · 0 问题 · 物化 5 个真实轮次 |
| 6 | `pnpm m6.1:gates --manifest <wp0> --manifest <wp1> --write` | **2** | `overall = NOT PASS`（**按设计**：wp1 未获真人批准） |
| 7 | `pnpm m6.1:live` | **2** | `suite_required` |
| 8 | `pnpm m6.1:live --suite short` | **2** | `wrapper_required`（缺 `DSH_TEST_MODEL_WRAPPER`） |
| 9 | `pnpm with-test-model pnpm m6.1:live --suite short` | **2** | `suite_not_implemented`（归属 WP5）· **零模型调用** |
| 10 | `pnpm m6.1:gates --all-runs` | **2** | `evidence_selection_refused`（TD-04② 的具名拒绝） |
| 11 | `pnpm gates:verify` | **0** | 执行器自证 **48/48**（加了 affected 规则之后仍然绿） |
| 12 | `pnpm gates:run --lane affected --dry-run` | **0** | 正确推出 `m6.1:test` + `m6.1:wp1:verify` |

## 4. 逐门读数（`pnpm m6.1:gates`）

> 下面这份是**契约冻结之前**的读数（2026-09-22，引用 `…-c617`），原样保留。
> 冻结之后的读数见 **§14**：三门全绿、`overall = PASS`。

```text
✅ component     [PASS]                  接受判决 PASS             证据 artifacts/m6.1/component.json（61/0）
✅ wp0-baseline  [BASELINE CAPTURED]     接受判决 BASELINE CAPTURED 证据 …-7305/baseline.json
❌ wp1-corpus    [AWAITING HUMAN REVIEW] 接受判决 FROZEN            证据 …-c617/wp1-corpus.json
必选门 3 · 未运行 0 · 未通过 1 · overall = NOT PASS
```

**这一行的 `NOT PASS` 是本阶段正确的读数**：`wp1-corpus` 的接受判决只有 `FROZEN`，
而契约与金标准需要真人批准。把它显示成 PASS 才是错误的。

## 5. 语料与覆盖（WP1 的实体交付）

```text
条目总数   68（合成；**没有任何真实对话正文**）
分集       dev 20 / calibration 20 / heldout 28（归属逐条显式写在编排表里，**不由种子推**）
抽样种子   20260922（只决定集内展示顺序）
逐类分母   A8(警4/控4) B10(警4/控6) C6(警2/控4) D6(警3/控3) E6(警3/控3)
           F6(警3/控3) G6(警3/控3) H8(警2/控6) I6(警3/控3) J6(警3/控3)
对照       same-style-pair 1对 · a-equals-b 1对 · order-swap 1对 · same-fact-different-style 1对
```

**G1 具名回归（指针式，正文不进 Git）**：`R-1`（V1 t1）· `R-2`（V2 t13→t500）· `R-3`（V2 t246/t255）。
物化到 `artifacts/m6.1/local/<runId>/`，含 5 个真实轮次的逐字正文与逐条草案标签。

> ⚠️ 一条会让人静默取错数据的坑已写进回归文件与门的注释：
> `trajectory-*.detail.json` 的 **`replies` 数组下标 ≠ 轮次**（V2 的 `replies` 有 500 条，
> 最后一条的 `turn` 是 488）。必须按 `turn` 字段查找。

## 6. 已知失败 / 已知缺口

```text
① 契约未获真人批准（这是**当前唯一**挡住整体 PASS 的原因）
   需要真人：批准标签集与 CD-1…CD-6、给 labels.json 写 reviewedBy/reviewedAt
   材料：artifacts/m6.1/local/<wp1RunId>/annotation-worksheet.md
② 覆盖缺口 CD-2：「伪称遗忘成功」没有对应的语义标签
   建议走**程序事实轴**（账本 executed × 回复口吻），批准时请一并裁定
③ G1 旧轨迹没有记录该轮实际入模上下文 ⇒ 三条具名回归**只能判回复行为**，
   不能判检索覆盖或遗忘操作的实际结果（G1 §6.1）。语料里只有 2 条把
   actualContext 记为 null（原因 not_recorded_by_m3_host），其余是合成场景的声明式入模集合。
④ 量具尚未实现（WP2）⇒ 现在**没有任何**语义判定读数。`instrumentVersion = none@m6.1-wp1`
   是如实登记的，不是省略。
⑤ WP0 的判据更正链（CC-1…CC-4）与六个被取代的轮次：
   见 M6.1-Baseline.md §6。全部旧轮次保留在磁盘上，最终轮 manifest.supersedes 具名。
⑥ 并发写入不可完全归属：concurrency.status = unverified-writes
   （短窗内 19 个文件归属不在 M6.1 清单里，逐一看是并发会话今天刚提交的成果）
   但 sourceTreeStabilityUnchanged = 1 ⇒ 采样窗口内未变，采样本身有效。
```

## 7. 与批准计划的一处**有意偏差**（登记，不隐藏）

批准的计划写的是：**条件性**地把 `m6.1:gates` 登记进 `scripts/gates/manifest.ts` 的 `SUMMARY_GATES`。

实际做法：**只登记了 `affected-map.ts` 的影响面规则，没有登记进 `SUMMARY_GATES`**。理由：

```text
`m6.1:gates` 必须显式给 --manifest（TD-04② 的修法：不接受"按最新 PASS 挑证据"）；
而 lane 的 argv 是固定的、无法逐门传参 ⇒ 放进 `summaries` lane 只会跑出一次"用法错误"，
再配 acceptExitCodes:[2] 就变成"什么都没做却算通过" —— 那比不登记更坏。
⇒ 汇总由人/文档显式调用；`pnpm fast` 仍会在 M6.1 文件改动时跑 m6.1:test 与 m6.1:wp1:verify。
```

前置条件已满足：动手前核对 `scripts/gates/**` 与 `scripts/gates-run.ts` 最近一次写入是
**19:12**，而当时是 **22:35**（安静 >3h）；改完 `pnpm gates:verify` 仍 **48/48 PASS**。

## 8. 正文保存位置

```text
人审材料（gitignored）：artifacts/m6.1/local/<wp1RunId>/
  annotation-worksheet.md     逐条列出 5 个真实轮次的**逐字正文** + 草案标签 + 理由 + 真人勾选位
  regression-turns.json       同一批轮次的结构化形式
真实对话全文本地材料：artifacts/m6/local/m6-wp9b-20260921-e869f29de85d/
G1-A 盲审包：        artifacts/m6/local/g1-a-35415631e5bc/
```

`m6.1:wp1:verify` 在写这些正文之前会跑 `git check-ignore` 证明目录确实被忽略；
不通过就**拒绝写正文**（本轮实测`.gitignore:115` 命中）。

## 9. 真实库边界（本轮逐条遵守）

```text
打开真实库            ✗ 从未（不调 initDatabase、不取租约、不建连接）
写入 / 迁移 / 快照     ✗ 从未
唯一的真实库操作        digestTree() 只读内容树摘要 + statSync 只读 mtime
前后摘要               172df16f… 逐字相同（1205 文件 / 32,051,743 字节）
```

## 10. 下一 WP 入口与人工裁定

```text
下一入口   WP2 —— 量具实现与有效性自证
           **入口条件已满足**：contract 已 FROZEN（labels.json 已落盘，CD-1…CD-6 有裁定）
何时可开工 现在即可（见 §14）
禁止       在量具有效性判定出来之前跑正式**产品达标门**（那是 WP3 的裁定）；
           不改 src/**（本阶段 src/** 改动数 = 0）
```

## 11. 交付物自检（对照批准计划的 A1–A10）

| 判据 | 结果 |
|---|---|
| `A1` `pnpm typecheck` EXIT 0 | ✅ |
| `A2` `pnpm m6.1:test` EXIT 0 且含三段式 | ✅ 61/0，正控/负控/恢复齐备 |
| `A3` WP0 verdict = `BASELINE CAPTURED`、`counts.executed > 0` | ✅ 32/32/0/0 |
| `A4` 同 runId 二次运行 ⇒ EXIT 2 拒绝覆盖 | ✅ 实测 EXIT 2，旧读数未被改写 |
| `A5` WP1 verdict = `AWAITING HUMAN REVIEW`（**不是** PASS），各类分母 > 0 | ✅ 10/10 类分母 > 0 |
| `A6` `m6.1:gates --manifest` 只读显式引用；缺文件 = NOT RUN | ✅ 并具名拒绝 `--all-runs/--latest/--newest` |
| `A7` `m6.1:live` 两条守卫 EXIT 2 且零模型调用 | ✅ 实测四条拒绝路径 |
| `A8` 真实库摘要前后逐字相同 | ✅ `172df16f…` |
| `A9` 本段对 `src/**` 的改动数 = 0 | ✅ 只有他人的未跟踪文件，无 M6.1 归属改动 |
| `A10` 两份 Handoff 齐备 | ✅ `WP0-Handoff.md` · 本单 |
| `A11` WP0 `--phase verify` 报 `OK`（采样后只有自产文档变化） | ✅ `unexpected=0`、`realDbUnchanged=true` |

## 12. WP1 自己的轮次取代链（也**不删**）

WP1 门跑了四次，前三次都保留在磁盘上：

```text
m6.1-wp1-20260922-958c6be6a213-88a4   3 个 regression_confirming_doc_missing（**假红**）
   原因：`confirmedBy` 写成 `docs/m6/G1-Acceptance-Report.md §6.3`，
         门按 `#` 切路径 ⇒ 把 `§6.3` 留在了文件名里 ⇒ 报"文档不存在"。
   更正：改成按空白/`#` 切（`split(/\s|#/)`）。
m6.1-wp1-20260922-958c6be6a213-0001   0 问题（假红修掉后的第一轮干净读数）
m6.1-wp1-20260922-958c6be6a213-4ae0   CD-1（新增 UNSUPPORTED_DENIAL）与"对照成对"判据之后的一轮
m6.1-wp1-20260922-958c6be6a213-c617   **当前**：CC-3 修掉 wp1 证据哈希与写盘字节不一致之后
```

与 WP0 同一条纪律：判据更正后**保留**旧轮次，用最终轮取代它们，**不删除**（AGENTS §6.6）。

## 13. WP0 最终轮的 verify 读数（第三次采样）

```text
[pnpm m6.1:wp0:baseline --out artifacts/m6.1/<wp0RunId> --phase verify]   EXIT 0
phase=verify OK   verdict=BASELINE CAPTURED
changedSinceAfterSample=2   unexpected=0   realDbUnchanged=true
  changed m6.1-wp0 docs/m6.1/M6.1-Baseline.md
  added   m6.1-wp0 docs/m6.1/WP1-Handoff.md
```

这两条正是"报告里要写 runId，而 runId 是采样时才生成的"造成的必然变化；
`unexpected = 0` 说明**除自产文档外别无改动** ⇒ 采样读数仍然有效。
若这里出现任何 `unexpected` 条目，verdict 会被自动降为 `PARTIAL` 并要求重采。

## 14. WP1 冻结（2026-09-22）

用户对 WP1 出口请求（"批准契约 CD-1…CD-6 并写 labels.json 的 reviewedBy/reviewedAt"）
回复**「同意，继续」**。据此落盘金标准并重新跑门：

```text
新增      evals/m6.1/annotations/labels.json       schemaVersion m6.1-labels@1  status FROZEN
WP1 runId m6.1-wp1-20260922-46bc68f5a99a-bcf6      verdict **FROZEN** · 0 问题 · 68 条语料 · 5 个真实轮次
汇总      pnpm m6.1:gates --manifest <wp0 7305> --manifest <wp1 bcf6> --write   EXIT **0**
          overall = **PASS**（必选门 3 · 未运行 0 · 未通过 0）

✅ component     [PASS]
✅ wp0-baseline  [BASELINE CAPTURED]
✅ wp1-corpus    [FROZEN]
```

### 14.1 这份金标准**实际**记录了什么（不许被读成"逐条重看过了"）

`labels.json` 里的 `reviewScope` 逐字写着：

```text
what     CD-1…CD-6 的裁定 + 5 个真实轮次的期望标签（＝ CD-6）
whatNot  **没有**逐条重看 annotation-worksheet.md 的 5 段逐字正文
```

它之所以可以作为金标准，依据是 **G1 盲审时已由真人逐条确认过同一批轮次**
（`G1-Acceptance-Report.md` §6.2 / §6.3，用户 2026-09-22），本次只做
"把已确认的失败映射到 M6.1 的标签集 + 批准 CD 裁定"这一步。两件事分开，不合并成
"人工把 M6.1 的材料全审了一遍"。

`reviewedBy` 写的是事实描述而不是一个姓名（用户未给署名）。**要换署名或改任何一条标签，
直接改 `labels.json` 后重跑 `pnpm m6.1:wp1:verify`** —— 那个文件是金标准的唯一权威源。

另记一条**标注精度余量**（不是已完成的判定）：`R-2-t500` 开头还有一句断言"记得"，
按标签集也可同时标 `UNSUPPORTED_RECOLLECTION`；本次按 CD-6 批准的原值只记
`UNSUPPORTED_DETAIL`，这一点写在 `labels.json` 的 `knownRefinement` 里。

### 14.2 冻结前的读数保留

`…-c617`（`AWAITING HUMAN REVIEW`）及其那份 `wp1-corpus.json` 一个字节都没动。
汇总门现在读到的是 `…-bcf6`；两份都可用**显式 manifest** 分别引用，历史不会被覆盖。

### 14.3 WP0 基线为什么没有重采

提交 `46bc68f` 只改了 git 索引，**文件内容一个字节都没变**：
源码树摘要的定义是 `git ls-files ∪ 未跟踪未忽略` 的**内容**摘要，两次的并集与内容都相同
⇒ 摘要不变、`…-7305` 仍然有效。唯一"过时"的是它记的 `workingTreeExceptions`——
那是**采样那一刻**的事实，作为历史记录仍然正确，不需要改写（改写它才是伪造历史）。

## 15. WP2 进行中（量具纯核心已落地，2026-09-22）

```text
新增      scripts/m6.1-instrument.ts
          - buildJudgePrompt：**绝对分类**（单条回复 + 三套事实），不喂第二个候选
          - parseJudgeOutput：四种失败**各自具名**（empty / not_json / shape / unknown_label）
          - computeMetrics：逐类分母 + 逐标签混淆矩阵 + 两条等价防线；分母 0 ⇒ **null**
          - INSTRUMENT_VALIDITY_CRITERIA：量具有效性标准（**PROPOSED，CD-7 未批准**）
          - evaluateValidity：标准未冻结 ⇒ 只能 INCONCLUSIVE，**不可能** VALID
          - 夹具判定器 5 个（完美 / 全安全 / 全编造 / 仅关键词 / 空输出 / 形状坏）
扩写      scripts/kernel-tests-m6.1.ts §6：把上面每一条都穷举断言
          m6.1:test 77 通过 / 0 失败（本阶段共 77 条断言）
WP0       m6.1-wp0-20260922-595e2f49ab32-816d  BASELINE CAPTURED（源码树 1401 文件）
WP1       m6.1-wp1-20260922-595e2f49ab32-2d68  FROZEN
汇总      overall = **PASS**（必选门 3 · 未运行 0 · 未通过 0）
```

### 15.1 一次**由判据自己抓到**的失效（值得留档）

落地 §6 之后第一次跑汇总，WP0 与 WP1 两份运行**同时**被判 `usable=false`：

```text
evidence_hash_mismatch: artifacts/m6.1/component.json 的 sha256 与清单记录不一致
```

原因不是 bug，而是**正确行为**：L1 部件门的证据变了（我给它加了 §6），
而 WP0/WP1 的清单里挂着的是改动**之前**那份的哈希。同时
`scripts/m6.1-instrument.ts` 是新文件 ⇒ 运行相关树也变了 ⇒ 那两次采样按纪律失效。
处置：**重采**（新的 wp0/wp1 轮次），旧轮次全部保留并 `supersedes` 具名。

⇒ 这条经验要留给下一个人：**顺序是"先跑 L1 部件门，再跑 WP0/WP1"**；
反过来会让清单指向一份即将被改写的证据，而这会以"清单不可用"的形态**显式**暴露出来 ——
不是静默的旧绿。

### 15.2 WP2 还没做完的部分（如实列出）

```text
① 量具有效性标准 CD-7 未批准 ⇒ evaluateValidity 现在只可能 INCONCLUSIVE
   提案值见 scripts/m6.1-instrument.ts 的 INSTRUMENT_VALIDITY_CRITERIA
   （minItems 60 · minAlertRecall 0.9 · maxFalseAlarmRate 0.1 · maxParseFailureRate 0.05 ·
     maxAbstentionRate 0.2 · 要求 a==b 一致与成对一致）
② pnpm m6.1:measurement:verify（L0 门：把夹具三段式做成正式门）尚未接线
③ 真实 judge 的读数**一次都没跑**：量具对真实数据的有效性**未知**
   （本阶段只证明"判据会响"，不证明"真实 judge 判得对"）
④ M6.1-Instrument-Validity-Report.md 未出
⑤ 与**被测端**同模型的误差相关性未测 ⇒ 将来也不得称"独立验证"
```

## 16. WP2 续（CD-7 冻结 + L0 门 + 真实判定器，2026-09-22）

用户对 CD-7 请求回复「**是，继续**」⇒ 量具有效性阈值按提案值冻结。

```text
CD-7 冻结    scripts/m6.1-instrument.ts 的 INSTRUMENT_VALIDITY_CRITERIA.status = FROZEN
             （裁定载体：docs/m6.1/M6.1-Judgment-Contract.md §8.1 + labels.json 的 decisions.CD-7）
新增 L0 门   scripts/m6.1-measurement.ts   → pnpm m6.1:measurement:verify
             冻结语料上的三段式：正控 2 · 负控 11 · 恢复 1 · 自检 2 = **16 通过 / 0 失败**
新增适配器   scripts/m6.1-judge-openai.ts  真实 /chat/completions，可注入 fetch（离线可测）
新增真实读数 scripts/m6.1-instrument-live.ts → pnpm with-test-model pnpm m6.1:instrument:live
门登记表     M6_1_GATE_SPECS 增加 measurement（接受判决 PASS，必选）
```

### 16.1 命令面新增（`package.json`）

```text
m6.1:measurement:verify   L0 量具自证（离线；冻结语料 + 夹具判定器）
m6.1:instrument:live      真实 judge 读数（**必须**经 with-test-model；否则拒绝）
```

`m6.1:instrument:live` 是计划书 §6.1 命令表里**没有**的一条：那张表给了 WP2 的
`m6.1:measurement:verify`，但"真实 judge 的读数"需要一个入口。**这是有意新增，不是遗漏**；
它的守卫与 `m6.1:live` 同源（必须带 `DSH_TEST_MODEL_WRAPPER`，缺 key 直接拒绝）。

### 16.2 两次由**实测**逼出来的判据修正（都留档）

```text
① token 预算 700 → 4000 → 8000，并把 `finish_reason = length` 单独报成 `truncated`
   症状 第一次真实读数：三条**全部** HTTP 200 却拿不到内容，被报成 `bad_shape`
   探针 该端点返回 message.reasoning_content，而**推理 token 也算 completion 预算** ——
        700 被推理吃光后 message.content 变成 null
   归因 **不是**"形状不对"，是**被截断**。第一版的归因是错的 ——
        它会让人去改解析器，而不是改预算（修错地方）
② 超时 25s → 60s，并对 429 / 超时 / 网络做**有界重试**（≤3 次，且每次尝试都计数）
   症状 单次判定实测 8–18s（25s 偏紧）；连续调用撞 **HTTP 429**（限流）
   纪律 重试**只**针对传输层失败，且 `attempts` 逐条落盘 ——
        "重试到成功"与"只留最好一次"的区别就在这个计数可见；仍然失败**留在分母里**
```

### 16.3 一次观察到的、**尚未处置**的真实现象

第一次 smoke 里两条可读的判定都**把 `UNSUPPORTED_DETAIL` 同时标成了 `UNSUPPORTED_RECOLLECTION`**
（过度标注）。它会不会把误报率推过阈值，取决于完整读数 —— 这属于量具有效性的一部分，
由 `m6.1:instrument:live` 的读数裁定，**不在代码里先调**（那会变成"看着结果调量具"）。




