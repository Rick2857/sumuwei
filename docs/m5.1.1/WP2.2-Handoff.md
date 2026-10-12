# WP2.2 Handoff — K-17 Consumer Impact Audit + Production-Copy Schema Apply

> **结论：WP2.2 = PASS。K-17 = PASS（WP3 的 Axis B 回填 = READY）。
> production-copy v6→v7 的 `schema-only` apply = PASS（在**副本**上执行，真实库从未被打开）。
> 真实库 `data/pglite` 的正式 apply 与 WP3 回填 = NOT RUN（仍等你放行）。**
>
> 下次 execution **先读这份**，再读
> [`WP2.1-Handoff.md`](./WP2.1-Handoff.md)（K-16 与 v6 列重叠）、
> [`WP2-Handoff.md`](./WP2-Handoff.md)（v7 schema 与 K-4）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) §2（**R-15 已由本 WP 追加验证结论**）、
> [`M5.1.1-Migration-Strategy.md`](./M5.1.1-Migration-Strategy.md) §3.2/§3.3（回填矩阵）。
> **不要重新探索仓库。**

```text
Completed WP: WP2.2 — K-17 Consumer Impact Audit + production-copy schema-only v6→v7 apply
              K-17 = PASS（会改实时行为的消费者 = 0）· production-copy schema apply = PASS
              真实库 apply = NOT RUN · WP3 backfill = NOT STARTED

Changed Files:
  scripts/verify-m5.1.1-k17-consumer-impact.ts          （新增：K-17 只读消费者影响审计门）
  scripts/verify-m5.1.1-production-copy-schema.ts       （新增：production-copy v7 schema-only 门）
  package.json                                          （改：+ m5.1.1:k17:verify / m5.1.1:prod-copy:verify）
  artifacts/m5.1.1/wp2.2-k17-consumer-impact.json       （新增：K-17 证据，34 文件 / 334 命中点）
  artifacts/m5.1.1/wp2.2-production-copy-schema.json    （新增：副本 apply 证据）
  artifacts/m5.1.1/wp2.2-axis-b-before-image.json       （新增：Axis B before-image，WP3 用）
  artifacts/m5.1.1/wp2.2-gate-exits.txt                 （新增：6 条命令退出码）
  artifacts/m5.1.1/wp2.2-restore-whitelist.txt          （新增：还原白名单 + 前后哈希）
  artifacts/m5.1.1/wp2.2-{typecheck,migration-verify,k17-verify,prod-copy-verify,test,measurement-verify}.log
                                                        （新增 6 份：逐字 stdout）
  artifacts/m5.1.1/wp2-schema.json / migration-preview.txt （改：复跑刷新，**仅** generatedAt 与沙箱目录名）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                  （改：R-15 行尾追加 WP2.2 的验证结论）
  docs/m5.1.1/WP2.2-Handoff.md                          （本文件）

Tests Run（全部 exit 0；本会话逐条**重跑**，退出码见 wp2.2-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm m5.1.1:migration:verify    → 0（**77 通过 / 0 失败**；19 个计数型检测器，无效 0）
  pnpm m5.1.1:k17:verify          → 0（**15 通过 / 0 失败**）
  pnpm m5.1.1:prod-copy:verify    → 0（**25 通过 / 0 失败**）
  pnpm m5.1.1:test                → 0（**42 通过 / 0 失败**）
  pnpm m5.1:measurement:verify    → 0（**16 通过 / 0 失败**；正控 / 负控 / 恢复三段式）

Tests Passed: 77/77 · 15/15 · 25/25 · 42/42 · 16/16；6 条命令全 exit 0
Tests Failed: 0
Tests Not Run:
  · 真实库 data/pglite 的 migrate:apply（**等你放行** —— WP2 的 STOP 点仍在这里）
  · WP3 legacy backfill（未开始；K-17 前置**已解除**）
  · pnpm m5.1:gates / m5.1:regression:verify（交付级收尾门；本 WP 无 src/ 改动，未触发）
  · pnpm m4.5:ci / m4.5:ci:full（全量回归，WP10 的项）

Evidence Produced:
  artifacts/m5.1.1/wp2.2-k17-consumer-impact.json       —— K-17 的完整事实（下节逐条列出）
  artifacts/m5.1.1/wp2.2-production-copy-schema.json    —— 副本 apply 的完整事实
  artifacts/m5.1.1/wp2.2-axis-b-before-image.json       —— before-image（28 行；manifestHash 见下）
  artifacts/m5.1.1/wp2.2-gate-exits.txt                 —— 退出码（非量具自述）
  artifacts/m5.1.1/wp2.2-restore-whitelist.txt          —— 还原白名单 + 哈希前后对照
  artifacts/m5.1.1/wp2.2-*.log                          —— 6 条命令的逐字 stdout（UTF-8 无 BOM）

Commit Hash: da3345a8a5e6e9a445f66b3c0de325eb0f6bbf29

---------------------------------------------------------------------------
 K-17：回填的消费者影响（**34 文件 / 334 命中点，全部逐条分类**）
---------------------------------------------------------------------------
 扫描词（6 个）：source_kind · source_authority · epistemic_source ·
                sourceKind · sourceAuthority · epistemicSource
 命中：**34 个文件 / 334 个位置**｜已分类：**34**｜未分类：**0**

 回填会改什么（冻结语义，见 Migration-Strategy §3.6）：
   source_authority  ：由「按 actor_type 推导」→ `UNCONFIRMED_ORIGIN`
   epistemic_source  ：由「按 actor_type 推导」→ `UNCONFIRMED_ORIGIN`
   source_kind       ：**不改**（仍是既有 4 值之一）

 分类计数：A=4 · B=7 · C=10 · D=13

 ⚠️ 读这个数的正确方式（INV-M45-06 的形态）：
   **"A 类候选 = 4"** 与 **"会改实时行为的 A 类 = 0"** 是**两个不同的数**。
   4 个 A 类候选**逐个**判过 `wouldChangeLiveBehavior`，**四个全是 false**，
   于是 `aClassThatWouldChangeBehavior = []`。
   ⇒ 结论是"**候选 4 个、确认会改的 0 个**"，不是"命中 A 类 0 个"。

 4 个 A 类候选（各自为什么不会改行为）：
   ① src/kernel/contracts/conversation-event.ts
      `canEvidenceExternalFact`（:372）是**唯一**会读事件对象上 `sourceAuthority` 的
      行为判据（Fact Firewall）。但它读的是**调用方传进来的**值。
   ② src/kernel/app/memory/extractor.ts
      唯一的行为消费者。它的输入类型 `ProcessorEventView` **没有** Axis B 字段
      （contracts/processor.ts:40-49），`processorEventViewOf`（:90-118）只搬
      id / sequence / type / actorType / actorId / content / createdAt；
      `sourceAuthority` 在 :149 由 `defaultAuthorityForKind(sourceKindForActor(view.actorType))`
      **现场推导**。⇒ 它**读不到**存储里的 Axis B，改写它不影响抽取器。
   ③ src/infrastructure/persistence/ledger.ts
      `appendUserStatement` 用 `repliedToSourceKind` 参与 `resolveAuthority` —— 但它取的是
      **source_kind**，而回填**不改** source_kind。
   ④ src/kernel/app/turn-gateway.ts
      把 `sourceKind` 放进 prompt/上下文（:514、:1213）—— 只读 **source_kind**，回填不改它。

 结构证明（机读，见证据 structuralProofs）：
   processorEventViewHasNoAxisB = true ｜ processorEventViewMapperDropsAxisB = true ｜
   extractorDerivesLocally = true ｜ src/ 里 canEvidenceExternalFact 调用点 = **1** ｜
   authorityFromSource 调用点 = **1**

 **会变**的只是：账本上可见的值、开发者平面/审计这类**直读记录值**的面，
 以及 M3 评测里 `sourceAuthority === 'CHARACTER_GENERATION'` 这类断言。

 C 类（10 个文件）里，回填**之后会**失败的测试**枚举出 3 条**（本 WP **不改**它们）：
   · evals/m3/runtime/support.ts（:219-228 / :246 —— `=== CHARACTER_GENERATION` 等）
   · evals/m3/suites/user-correction.ts（:107 / :128-137 / :147 / :196 / :250-265）
   · evals/m3/suites/source-separation.ts（:75-81 / :147-153 / :162）
   条件：**仅当读到被回填的行**。评测跑在**沙箱库**上（AGENTS §7）⇒ 默认看不到真实库的旧行。
   另有 4 条 C 类被判定**不受影响**（如 assistant-fabrication 断言"不是 USER_EXPLICIT"，
   `UNCONFIRMED_ORIGIN` 同样满足；其余是纯内存夹具）。

 量具自检（R-13 第①条）：measurements 共 6 项**全部 valid**，`measurementInvalid = 0`
   （34 文件 / 334 命中 / 34 已分类 / 4 个 A 类候选 / 1 个调用点 / 3 条 C 类失败项）
 本门范围（机读）：readOnly = true · modifiedCTests = false ·
   modifiedConsumers = false · enteredPhase4 = false

---------------------------------------------------------------------------
 production-copy v6→v7（**schema-only**，只加列不改数据）
---------------------------------------------------------------------------
 真实库：`realSourceOpenedByApplicationCode = false`
   只读统计 1201 文件 / 31,289,946 字节 / 最新 mtime 2026-09-17T15:51:40.789Z
   boundary 指纹（(相对路径,大小) 排序后 sha256）：`38844f4e…b9cc2`
   指纹 before == afterCopy ⇒ **复制动作本身没有改动源**
 副本：beforeApply 指纹 = 源指纹（`38844f4e…`）；apply 后 = `a0d14932…`（副本真的变了）
 迁移：from 6 → to 7，`appliedVersions = [7]`，`codeLatestVersion = 7`
   pendingBefore = [ v7 `m5.1.1-attribution-model` / 114 条语句 ]；pendingAfter = []

 关键判据（v7 只加列、**不改数据**）：
   attribution_origin 非空行数        = **0**      （没有任何回填）
   18 个槽位列全部 NULL               = **0 非空** （一个都没被填）
   content_originator_* 全 NULL       = **0**      （没有伪造 contentOriginator）
   before-image 行数                  = **28**
   source_authority 非空              = **24 → 24**（逐行 identical = true，changedRowIds = []）
   K-4 约束计数：conversation_events 23 / character_action_events 23 /
                developer_control_events 22；partial 索引与新增 CHECK 均已在副本上清点
   restoreEpoch = **NOT_APPLICABLE**（本次没有 restore —— 按你的明令不记）
 量具自检：measurements 7 项全部 valid，`measurementInvalid = 0`
 本门范围（机读）：notDone = [ 真实库 migrate:apply · legacy backfill（WP3）· restore ]

 ⚠️ **本 WP 不主张真实库的 schema 版本**。上面所有版本读数都来自**副本**；
   按 AGENTS §6.9「隔离/副本读数 ≠ 真实库状态」，真实库的状态只能由真实库回答。
   （WP0/WP2.1 已如实记录真实库为 **v6**；本 WP 未对它做任何断言。）

 真实库未被触碰 —— **本会话独立复测**（不是转述读数）：
   全部复跑结束后实测 `data/pglite` = 1201 文件 / 31,289,946 字节 /
   最新 mtime 2026-09-17T15:51:40.7898589Z ⇒ 与证据里记录的边界指纹**逐字段一致**。
   （`data/**` 被 gitignore，git 看不见它；只能用文件数/字节/mtime 证明。）

---------------------------------------------------------------------------
 Axis B before-image（WP3 若要改写历史值，先有这份）
---------------------------------------------------------------------------
 列：id · sequence · source_kind · source_authority · epistemic_source
 **不包含任何消息正文**（`content` 没有被 select）
 rowCount = 28 ｜ nonNullSourceAuthority = **24**
 manifestHash（sha256 over "id\tsequence\tkind\tauthority\tepistemic" 行，
 按 (sequence, id) 排序）= `1cbbedc1c6dcfe9a53f2754f3af40f3dbd63fe707f3144e8c8c4585140e2f164`
 它是**迁移证据**，不是新的认知真相来源，也不随认知状态变化。

---------------------------------------------------------------------------
 还原白名单（R-13 第②条 / AGENTS §7）
---------------------------------------------------------------------------
 本 WP 复跑门时**重新生成但不属于本 WP 产物**的历史证据，逐个路径 `git checkout --`：
   artifacts/m5.1.1/wp1-contracts.json
   artifacts/m5.1.1/wp1-axis-b-closure.json
   artifacts/m5.1/measurement-negative-controls.json（**冻结的 M5.1 证据**）
 **没有**对 `artifacts/` 做无差别 checkout（R-13 明令禁止 —— 那会连本 WP 自己的证据一起还原掉）。
 还原后 `git status --porcelain -- artifacts/m5.1 artifacts/m4.5 artifacts/m4-acceptance
 artifacts/m4.1 artifacts/m5` = **空**。
 前后哈希、CRLF/LF 判据、以及一次**无效读数**（反斜杠路径导致 git show 产出空文件、
 量到空串哈希 `e3b0c442…`）全部登记在 `wp2.2-restore-whitelist.txt`。

Known Issues:
  K-17 【**已闭环**】消费者影响审计 = **PASS**；会改实时行为的消费者 = 0；
       WP3 的 Axis B 回填 = **READY**。证据 wp2.2-k17-consumer-impact.json。
  K-18 【**待你批准**】两份文档里的假前提仍**未修改**：`M5.1.1-D01-Investigation-Report.md` ③
       与 `ADR-042` L67–69（"conversation_events 没有这三列 / provenance 没有被持久化"）。
       本 WP 按"不改已 ACCEPTED 的 ADR"停在这里。正确表述见 WP2.1-Handoff 的 K-18。
  K-19 【**本轮新登记，等你确认编号**】`pnpm m5.1.1:test` **裸跑**（不设
       `M511_TYPECHECK_EXIT` / `M511_KERNEL_TEST_EXIT` / `M511_CONVERSATION_EXIT` /
       `M511_M4_CI_EXIT`）会把**已提交的** `wp1-contracts.json` 与 `wp1-axis-b-closure.json`
       里的真实退出码 **0 改写成 `null`**（脚本自述"缺失时为 null —— 不得推断为 0"）。
       因此这两个路径固定进还原白名单；否则一次顺手重跑就**静默降级**历史证据。
       与 K-14 同族（K-14 是"包装脚本设环境变量的顺序错"），本条是"**裸跑**"这一形态。
  K-8  【待 applied 后锁】v7 的内容指纹（现在只锁 0001–0006）。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  §3 批次表【登记，待你裁定】Execution-Plan 的批次表里**没有** WP1.1 / WP2.1 / WP2.2 三行
       （它们都是插入的 WP）。本 WP **未**擅自加行 —— 只按 R-12 的先例在 R-15 行内追加了
       验证结论。是否要在 §3 补一行，请你裁定。

Architecture Deviations:
  D-1  K-17 门是**只读审计**：不调用 `initDatabase()`、不改任何消费者、不进 Phase 4
       （证据里以 readOnly / modifiedConsumers / enteredPhase4 四项机读留痕）。
  D-2  production-copy 门**刻意不调用 `initDatabase()`**：源只被统计 + `cpSync`，
       只在**副本**上 apply v7。理由与 K-16 门相同 —— 沙箱路径会被放行，
       直接 `initDatabase()` 等于把 v7 施加到不是副本的地方。
  D-3  before-image **不 select `content`**：它要承载的是"历史 Axis B 的旧值"，
       不是对话内容。少取一列，就少一份正文副本。
  D-4  本 WP 额外跑了 `pnpm m5.1:measurement:verify`（AGENTS §5：新增 `verify-*.ts` 判据
       必须配测量门；本 WP 新增 2 个）。该命令重写了冻结的
       `artifacts/m5.1/measurement-negative-controls.json`，**已按白名单还原**（见上）。
  D-5  本 WP 的结论**只覆盖回填的消费者影响**，不覆盖"回填本身是否该做"——
       那是 WP3 的判定，且仍等你放行。

Do not modify（后续 WP 只消费）:
  · 0001–0007 的任何语句（0001–0006 有指纹锁；v7 一旦 applied 即历史）
  · ADR-042（已 ACCEPTED；K-18 的更正需你先批准）
  · 运行时写入路径 / Fact Firewall / extractor / MemoryAuthority / Recall
  · artifacts/{m5.1,m4.5,m5,m4-acceptance,m4.1}/**（还原只按白名单）
  · data/pglite（只有 src/main.ts 能开它）

Next WP Preconditions（WP3 — Legacy Backfill）:
  1. **你放行 production-copy v6→v7 的正式 apply 与 WP3 回填的动手许可**（当前 STOP 点）。
     备份 → 核对（文件数 + 字节）→ `cpSync` 副本 → migrate 预览 → **副本** apply → 计数 → 重放；
     记录 restore epoch / boundary。⚠️ v7 会给 K-16 那三列**加词表 CHECK**，
     既有 24 行取值已实测全部在词表内（apply 不会因约束校验失败）。
  2. **K-17 已闭环** ⇒ WP2.1 列出的前置之一已解除；WP3 不必再自己重做消费者审计，
     但**必须**在回填前把"会被改写的行"与 before-image 的 manifestHash 对上。
  3. WP3 按 `event-family × slot` 的 D/P/U/N 回填（Migration-Strategy §3.2/§3.3，已含 K-3 的 D/D/N）。
  4. 证据一律 `artifacts/m5.1.1/`；还原按白名单（含 K-19 的两条路径）；
     每个计数检测器都要 `measured_count > 0`，否则 MEASUREMENT INVALID。
  5. 交 WP3-Handoff（九字段）后 STOP。
```

---

## Batch C/D 的边界

WP2.2 **到此 STOP**：K-17 闭环、production-copy 的 **schema-only** apply 在副本上通过，
但**没有**在真实库上执行 v7，**没有**开始回填，**没有**进 Phase 4。
真实库全程只被统计文件数与字节（`realSourceOpenedByApplicationCode: false`），
副本读完即删；本会话另以文件数/字节/mtime 独立复测确认真实库未变。

按你的顺序，下一步是：

```text
K-16 PASS（WP2.1 已完成）
   ↓
K-17 PASS（本 WP 已完成）—— 回填的消费者影响已逐条写清
   ↓
你放行 → 真实库 / production-copy 的 v6→v7 正式 apply
   ↓
WP3 Legacy Backfill（按 event-family × slot 回填，附 before-image 对账）
```
