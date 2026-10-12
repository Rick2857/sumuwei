# WP3 Handoff — Retrieval Adapter & Candidate Generation

> 计划书要求的八字段交接单。下次 execution（WP4）**先读这份**，再读
> [`M5-Execution-Plan.md`](./M5-Execution-Plan.md)（WP4 节）与
> [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)（§3/§4/§6）。
> **不要重新探索仓库。**

```text
Completed WP: WP3 — Retrieval Adapter & Candidate Generation
Changed:
  src/kernel/recall/ports.ts                        （新增：端口 + 查询形状 + 能力报告 + isWithinTimeScope）
  src/kernel/recall/render.ts                       （新增：记录 → 数据块文本的**唯一**渲染处）
  src/kernel/app/recall/retrieval.ts                （新增：查询翻译 + 命中→候选 + 接资格层）
  src/infrastructure/persistence/memory-retrieval-store.ts（新增：只读适配器）
  src/kernel/contracts/recall.ts                    （追加：RECALL_CHANNEL_FACTS / RESERVED_RECALL_CHANNELS）
  scripts/verify-m5-retrieval.ts                    （新增：28 项门）
  package.json                                      （新增 pnpm m5:retrieval:verify）
  artifacts/m5/wp3-retrieval.json                   （新增：候选逐条 + 通道 + 能力报告 + 泄漏）
  docs/m5/WP3-Handoff.md                            （本文件）
  docs/architecture/README.md                       （登记 m5:retrieval:verify 与 WP3 文档）

Tests:  pnpm m5:retrieval:verify → 28 通过 / 0 失败（沙箱库，无模型）
        pnpm m5:test             → 30 通过 / 0 失败
        pnpm m5:verify           → 26 通过 / 0 失败
        pnpm typecheck           → exit 0
        pnpm kernel:test         → 26 通过 / 0 失败（kernel/recall/** 仍零基础设施 import）
        pnpm kernel:verify       → 25 通过 / 0 失败
        pnpm m4:test             → 243 通过 / 0 失败
        pnpm m3.5:test           → 30 通过 / 0 失败

Evidence: artifacts/m5/wp3-retrieval.json
        （6 条混合 fixture 的逐条候选/通道/资格理由 + 能力报告 + 泄漏计数 + 通道登记表）

Known issues（刻意的设计，不是缺陷）:
  · **适配器刻意不过滤资格**：它把 wrong-user / forgotten / superseded / orphan 全部
    取回来。这是"宽召回"的**可测形式** —— 在适配器里顺手过滤会让 WP2 的零泄漏计数
    永远返回 0，而"永远是 0"与"真的没有泄漏"在输出上完全一样。
  · **语义维度如实不可用**：能力报告里 `semantic` 进 `unavailable` 并带原因
    （M4 无嵌入列 + 计划书禁止为召回引入向量库）。**不许**把它当成 0 分。
  · **词面相关性目前是二值的**（`retrievedBy` 里有没有 `lexical`），没有分数。
    WP4 若需要更细的排序信号，必须回到契约加字段（`RecallCandidate.lexicalHits`）——
    不要在 WP4 里另写一套匹配（那会让"什么算词面命中"出现第二个实现）。
  · 两个保留通道：`explicit_id` / `canonical_key`（`RECALL_CHANNEL_FACTS` 里写明了解锁条件）。
    门里有一条断言防止它们出现在 `retrievedBy`。
  · `RecallTarget` 解析到**第三人**时，WP2 的 subject 闸会让该轮召回为空。
    这是用户 G2 裁定接受的行为（"不扩 Entity Model"），不是缺陷。
  · 适配器的一次检索最多扫描 500 行（跟随 `store.list()` 的既有上限）；
    超过这个量级的库需要分页/索引策略，那属于 WP4 的 Gold Dataset 规模讨论。

Interfaces exposed to next WP:
  · MemoryRetrievalPort{ name, retrieve(query) } / MemoryRetrievalQuery / MemoryRetrievalHit
  · MemoryRetrievalCapabilities{ available, unavailable[{dimension, reason}] } ← WP4 的 available:false 来源
  · RetrievedCandidates<T>{ candidates, capabilities, scanned }
  · createMemoryRecallService({port, onRetrieved?}) → { translate, retrieveCandidates, recall }
  · createMemoryRetrievalStore({store, integrity}) ← `integrity` **必填**（必须接 M5-PRE 探针）
  · memoryDataText / memorySearchableText / memoryPredicateOf（渲染的唯一入口）
  · isWithinTimeScope（时间边界唯一实现）
  · RECALL_CHANNEL_FACTS / RESERVED_RECALL_CHANNELS

Do not modify（WP4–WP7 只消费）:
  · 适配器的"宽召回"性质（不要在里面加 status/subject 过滤）
  · 渲染的唯一性（`recall/render.ts`）—— WP6 直接用 `candidate.dataText`，不要另写一份
  · `integrityOk` 的来源（只能来自 M5-PRE 探针）
  · 通道登记表（加通道前先问"谁产出它"）

Next WP prerequisites（WP4 Ranking / Conflict / Dedup）:
  1. 只对 `eligibility.eligible` 那一批排序（不要对全部候选排序后再过滤 —— 那等于绕开 P0 层）
  2. 每个 score component 必须带 `available`：语义维度**现在**是 `false` 并带原因
     （能力报告里已经如实给出，别在这里改成"0 分"）
  3. 稳定 tie-break：同样的输入必须给同样的顺序（适配器已给稳定序，排序器要保住它）
  4. dedup 用 M4 的槽位指纹（`slotOfRecord`），不要另造"两条像不像"的判断
  5. current vs historical：由 `request.intent` 决定 superseded 的参与方式（资格层已放行 historical）
  6. Gold Dataset 必须**分层**（用户 G3 裁定）：
     Supported-Domain Recall ≥ 95%（仅登记表覆盖的槽位）+ Coverage Boundary Set（不计入 95%，
     用来证明系统知道自己的边界）
  7. 证据写 artifacts/m5/wp4-ranking.json；新增 pnpm m5:ranking:verify
```
