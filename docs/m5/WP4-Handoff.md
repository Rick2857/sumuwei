# WP4 Handoff — Ranking / Conflict / Dedup

> 计划书要求的八字段交接单。下次 execution（WP5）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP5 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)（§3/§4/§6）。
> **不要重新探索仓库。**

```text
Completed WP: WP4 — Ranking / Conflict / Dedup
Changed:
  src/kernel/recall/ranking.ts        （新增：打分 + 相关性闸 + 排序 + 去重 + 同槽位冲突）
  src/kernel/contracts/recall.ts      （追加：RecallCandidate.slotFingerprint —— 槽位由适配器用 M4 的 slotOfRecord 算好带上来）
  src/kernel/app/recall/retrieval.ts  （映射时补 slotFingerprint / canonicalKey）
  scripts/verify-m5-ranking.ts        （新增：27 项门）
  package.json                        （新增 pnpm m5:ranking:verify）
  artifacts/m5/wp4-ranking.json       （新增：分层 Gold Dataset + Coverage Boundary + 策略快照）
  docs/m5/WP4-Handoff.md              （本文件）
  docs/architecture/README.md         （登记 m5:ranking:verify 与 WP4 文档）

Tests:  pnpm m5:ranking:verify    → 27 通过 / 0 失败（纯单元 + 沙箱库真实链路）
        pnpm m5:retrieval:verify  → 28 通过 / 0 失败
        pnpm m5:verify            → 26 通过 / 0 失败
        pnpm m5:test              → 30 通过 / 0 失败
        pnpm typecheck            → exit 0
        pnpm kernel:test          → 26 通过 / 0 失败
        pnpm kernel:verify        → 25 通过 / 0 失败
        pnpm m4:test              → 243 通过 / 0 失败
        pnpm m3.5:test            → 30 通过 / 0 失败

Measurement（**实测**，见 artifacts/m5/wp4-ranking.json）:
        Supported-Domain：Top-5 = 10/10 = 100%，Top-1 = 10/10 = 100%
        ⚠️ 数据集只有 10 条 → 95% 门槛**等价于全部命中**（如实写明，不是把门槛降低）
        数据集自检：10/10 条查询**唯一词面命中**目标（否则它不该进这一层）
        Coverage Boundary（**不计入 95%**）：未登记 predicate + 无词面桥 → 取回但不选中
                                          （理由 LOW_RELEVANCE）；取值含查询词时命中合法
        P0 Negative Controls：整份 Gold 运行的泄漏合计 = 0
        历史查询：问"以前" → 旧条（superseded）与新条都被召回；问"现在" → 旧条不通过资格

Known issues（刻意的设计，不是缺陷）:
  · **`requireRelevanceEvidence` 是这道门里最重要的一条**（缺省 true）。
    它是 G3 裁定的机制落点："没有任何当前机制能建立 relevance 的事实，
    不得为了满足 Recall 强行选出来"。判据只有两条：词面命中 / 目标指称。
    ⚠️ "关于本次请求的用户"**不算**证据（几乎所有长期事实都满足它，
       它区分不了"他想问的"与"他记得的其他事"）。
  · 语义维度在 breakdown 里是 `available: false` + 原因，**不参与总分**（不是按 0 分参与）。
    continuity 同理（需要"最近对话话题"，今天没有那条输入）。
  · 词面相关性仍是**二值**。Gold Dataset 因此要求"每条查询唯一词面命中" ——
    机制区分不了的样本不进 Supported 集（那是 G3 裁定的另一半）。
  · `maxPerSlot` 是策略：问"现在"=1，问"以前"=2（当前的 + 一条历史）。
    槽位分组用 `canonicalKey`（含 qualifier scope），去重指纹用 `slotFingerprint`
    （**由适配器用 M4 的 `slotOfRecord` 算好**，WP4 不许自己凑）。
  · 门里修掉的两处"绿得没有意义"：
      ① 三组夹具共用同一个 contentFingerprint → 被去重折叠成 1 条，
         而 tie-break 断言两边都是 1 条所以仍然过（测的是折叠不是排序）。
         修法：数量断言必须同时检查元素个数。
      ② 阈值用例的候选先被**相关性闸**拦下，根本没走到阈值。

Interfaces exposed to next WP:
  · scoreCandidate({request, candidate, capabilities, now, policy}) → RecallScoreBreakdown
  · rankCandidates({request, candidates, capabilities, now, policy}) →
      { ranked: RankedCandidate[], decisions: RecallDecision[], collapsed[] }
  · hasRelevanceEvidence({request, candidate}) → { ok, via: 'lexical' | 'target' | 'none' }
  · DEFAULT_RECALL_RANKING_POLICY（weights / requireRelevanceEvidence / minTotal / maxPerSlot / collapseIdenticalContent）
  · Ranking 阶段就已经**终局**的决策：LOW_RELEVANCE / DUPLICATE（可进 trace）

Do not modify（WP5–WP7 只消费）:
  · 相关性闸的存在与判据（两条：词面 / 目标指称）
  · `available: false` 的语义（不许把不可用维度改成 0 分）
  · 稳定 tie-break 的三关键字（总分 → recordedAt → memoryId）
  · 槽位来源（`slotFingerprint` 只能来自适配器，不许在 WP5/WP6 重算）

Next WP prerequisites（WP5 Context Selector & Budget）:
  1. 输入只能是 `rankCandidates().ranked`（**已排序、已去重**），不要再碰原始候选
  2. 预算判据用**真实 token 估算**（注入 quantifier；不要在 WP5 里写死"一行 = N token"）
  3. 装不下的候选必须写 `BUDGET_EXHAUSTED`（budget 阶段）—— **不要**复用 LOW_RELEVANCE
     （两者的修法不同：一个改预算，一个改相关性）
  4. `duplicate 不浪费预算`：去重已在 WP4 做过，WP5 只需保证"同槽位不重复计入"
  5. budget accounting 四个数字都要（budget / memory / reserved / total），
     并给 WP6 留 `conversationTokens` 的位置
  6. Hard Test：构造大量记忆，`total <= configured budget` **必须恒成立**
  7. 证据写 artifacts/m5/wp5-context-budget.json；新增 pnpm m5:budget:verify
```
