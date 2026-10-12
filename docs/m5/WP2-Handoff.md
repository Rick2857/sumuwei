# WP2 Handoff — Eligibility Filter

> 计划书要求的八字段交接单。下次 execution（WP3）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP3 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)（§3/§4/§6）。
> **不要重新探索仓库。**

```text
Completed WP: WP2 — Eligibility Filter（M5 最重要的安全层）
Changed:
  src/kernel/recall/eligibility.ts      （新增：集中式资格判定 + 泄漏量具 + 装配自检）
  scripts/verify-m5-eligibility.ts      （新增：26 项门，含量具自检与静态锁）
  package.json                          （新增 pnpm m5:verify）
  artifacts/m5/wp2-eligibility.json     （新增：实测泄漏 + 768 例矩阵 + 16 用例表）
  docs/m5/WP2-Handoff.md                （本文件）
  docs/architecture/README.md           （登记 m5:verify 与 WP2 文档）

Tests:  pnpm m5:verify     → 26 通过 / 0 失败（36ms，离线、无 DB、无模型）
        pnpm m5:test       → 30 通过 / 0 失败（WP1 契约未被破坏）
        pnpm typecheck     → exit 0
        pnpm kernel:test   → 26 通过 / 0 失败（依赖方向锁 —— recall/** 零基础设施 import）
        pnpm kernel:verify → 25 通过 / 0 失败
        pnpm m4:test       → 243 通过 / 0 失败（package.json 锁未被新脚本破坏）
        pnpm m3.5:test     → 30 通过 / 0 失败

Hard Gate（**实测**，不是手写）: artifacts/m5/wp2-eligibility.json → hardGateVerdict = PASS
        mixed fixture : forgotten/wrongUser/wrongNamespace/invalidTarget/orphanedEvidence = 0，totalEligible = 2（有正控）
        穷举矩阵 768 例: 五项全 0，eligibleCount = 28
        量具自检       : 注入泄漏后实测 1/1/1/4/1（> 0 → 计数器真的会响）

Known issues（刻意的设计，不是缺陷）:
  · `EligibilityBatch` **只**输出 verdict，不输出 RecallDecision：通过资格 ≠ 被选中，
    而"没进上下文必须有理由"是**终局**决策的规则。中间态不是决策 ——
    WP5 选完之后才写 decisions（被拒的那些可在资格阶段用 rejectedDecisions() 定稿）。
  · `measureLeakage()` 的 forgotten 判据走 `exclusionReasonForStatus`。第一版写的是
    `status === 'retracted'`，被静态锁抓出来 —— 量具里出现第二处状态判断，
    M4 改状态名时它会静默数一个不存在的维度。
  · 新增了一个诊断码闭集 `RecallEligibilityCode`（13 个值）。它是**闭集**而不是自由文本，
    理由与 WP1 的隐私纪律同源：自由文本很容易把记忆正文抄进 trace。
  · 计划书要求"必须拒绝 inactive"：今天 inactive 的具体形态就是 `superseded`
    （`NOT_ACTIVE` 是保留位，没有生产者）。

Interfaces exposed to next WP:
  · evaluateEligibility({request, candidate, policy?}) → EligibilityVerdict{eligible, reason?, code}
  · filterEligible({request, candidates, policy?}) → EligibilityBatch{verdicts, eligible}
  · rejectedDecisions(batch) → RecallDecision[]（终局确定的那一批，可进 trace）
  · toDecision({candidate, verdict, selected, score?}) → RecallDecision（只用于终局）
  · measureLeakage({request, verdicts}) → EligibilityLeakage（Hard Gate 的量具）
  · DEFAULT_RECALL_ELIGIBILITY_POLICY / RecallEligibilityPolicy{minAuthority, allowSupersededForHistorical, allowDisputed}
  · assertCandidateMatchesRequestScope（装配自检，失败关闭）
  · describeVerdict（不含正文的行式诊断）

Do not modify（WP3–WP7 只消费）:
  · 判定顺序与理由归属（owner → subjects → target → status → disputed → integrity → kind → authority）
  · `exclusionReasonForStatus` 的调用（唯一状态接缝）
  · 新增 `RecallExclusionReason` 前先问"谁产出它"（RECALL_EXCLUSION_REASON_FACTS 必须同步）
  · 不要把资格判定复制到检索适配器或 ContextSectionProvider 里（静态锁会红）

Next WP prerequisites（WP3 Retrieval Adapter & Candidate Generation）:
  1. 候选必须**宽召回**：资格层的三个零泄漏判据依赖"该被拒的真的到了它面前"，
     在适配器里顺手过滤掉会让 WP2 的计数失去意义（也失去可测性）
  2. `RecallCandidate.retrievedBy` 要如实填（WP7 的 retrieval metrics 与"为什么没想起来"靠它）
  3. `integrityOk` 必须来自 **M5-PRE 的探针**（`infrastructure/persistence/memory-integrity.ts`
     的 `memoryIntegrityProblems()`），不许在适配器里另写一套"证据还在不在"的判断
  4. 适配器**只读**：不得写 memory_records / 不得改 status（计划书 WP3 Forbidden：不换 backend、不加基础设施）
  5. 证据写 artifacts/m5/wp3-retrieval.json；新增 pnpm m5:retrieval:verify
```
