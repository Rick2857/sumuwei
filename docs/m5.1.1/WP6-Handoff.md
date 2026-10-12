# WP6 Handoff — Recorded Read Path / Query / Replay Attribution Switch

> ## 状态（**必须按字面读**）
>
> ```text
> WP6                                   = **PASS**
> WP6 专项门（pnpm m5.1.1:wp6:verify）   = **PASS（51 通过 / 0 失败）**
>   · 读侧清单：三表读者**全部**被分类（新增读者会让本门变红）
>   · RECORDED 对话 / 行动查询   = 逐字段等于存储列（不重推）
>   · MIGRATED_LEGACY 保持       = origin 不升格 · Unknown 不折叠 · 三态不合并
>   · trace 关联                 = `input_event_id` → 那条对话事件（**不是**第二份存储）
>   · R1–R6                      = PASS
>   · D01 / K-27 跨账本保持       = 三个读侧面都指向 SERVICE/agent，**没有一个**说 USER
>   · 只读                       = 查询套件前后六张权威表逐字段/逐字节等价（mutation = 0）
>   ⇒ **WP7 = READY / AUTHORIZED**
> ```
>
> **没有开始 WP7。没有动真实库。没有 schema 变更（v7 / v8 指纹逐字未变，也没有 v9）。**
> **没有改**：Fact Firewall / `canSupportExternalFact` / MemoryAuthority / extractor /
> Recall / ADR-043 / Phase 4 / Developer Control（U-03）/ `page.html`（除编译必需）。
> **没有加**：归因过滤器（U-10 仍 DEFER）/ 归因索引 / telemetry 导出 /
> `character_traces` 上的第二份归因。
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-29（K-28）**、
> [`M5.1.1-WP6-Compatible-Assertion-Record.md`](./M5.1.1-WP6-Compatible-Assertion-Record.md)、
> `artifacts/m5.1.1/wp6-recorded-read-path.json`。
> **不要重新探索仓库。**

```text
Completed WP: WP6 — Recorded Read Path / Query / Replay Attribution Switch
  §WP6-0  读侧清单 + 分类（AUTHORITATIVE_RECORDED / LEGACY_COMPATIBILITY / PROJECTION_ONLY / DISPLAY_ONLY）
  §WP6-1  RECORDED：查询/读路径消费存储归因（禁用的重建方向逐条未被违反）
  §WP6-2  MIGRATED_LEGACY：原样保留（不升格 / 不折叠 / 不"修好"）
  §WP6-3  对话查询 DTO：六个槽位 + origin + Axis B + subject（三态可判别）
  §WP6-4  行动查询 DTO：六个槽位 + origin + Axis B = NOT_APPLICABLE；执行真相不变
  §WP6-5  接地：新键进**派生清单** + 新 DTO 自己的编译期接地证明 + 门逐字段实测
  §WP6-6  trace：`input_event_id` → 那条对话事件的存储归因（trace 表零归因列）
  §WP6-7  R1–R6 全部实现并验证
  §WP6-8  D01 / K-27 跨账本保持 + legacy 兼容字段的 mutation 控制
  §WP6-9  只读证明：Query Mutation Count = 0
  §WP6-10 不加归因过滤器 / 不加索引（U-10 仍 DEFER）
  §WP6-11 不导出 telemetry / 不新增 provenance kind
  §WP6-12 范围排除逐条遵守
  §WP6-13 新门 `pnpm m5.1.1:wp6:verify`（51/0）

Changed Files:
  src/kernel/contracts/attribution.ts          （改：+ `storedAttributionOfRow` / `StoredAttributionReadback` /
                                                  `ATTRIBUTION_ORIGIN_COLUMN`）
  src/kernel/contracts/developer-query.ts      （改：+ 三态 DTO / Axis B DTO / 归因 DTO / 两个映射函数 /
                                                  接地证明；TraceSummaryDto + attribution；
                                                  ExecutionDetailDto + attribution；派生键清单 + attribution）
  src/infrastructure/persistence/conversation-store.ts （改：+ `readConversationEventAttribution`）
  src/infrastructure/action/action-ledger-store.ts     （改：+ `readActionStoredAttributions`）
  src/infrastructure/dev/query-service.ts      （改：+ 归因映射 + trace/execution 接上存储归因）
  scripts/verify-m5.1.1-wp6-recorded-read-path.ts （新增：WP6 专项门）
  package.json                                 （改：+ m5.1.1:wp6:verify）
  docs/m5.1.1/M5.1.1-Execution-Plan.md         （改：+ R-29（K-28 登记）+ WP6 闭包注记）
  docs/m5.1.1/M5.1.1-WP6-Compatible-Assertion-Record.md （新增：9 条变更逐条留痕）
  docs/m5.1.1/WP6-Handoff.md                   （本文件）

Tests Run（全部 exit 0；见 wp6-gate-exits.txt）:
  pnpm m5.1.1:wp6:verify            → 0（**51 / 0**；WP6 专项门，本步新增）
  pnpm typecheck                    → 0
  pnpm kernel:test                  → 0（**26 / 0**）
  pnpm kernel:test:conversation     → 0（**47 / 0**）
  pnpm m4.5:test                    → 0（**135 / 0**）
  pnpm m5.1:test                    → 0（**52 / 0**；含 DTO 接地编译期断言）
  pnpm m5.1.1:test                  → 0（**42 / 0**）
  pnpm m5.1.1:k25:verify            → 0（**22 / 0**）
  pnpm m5.1.1:wp3.2:verify          → 0（**35 / 0**）
  pnpm m5.1.1:wp4:verify            → 0（**48 / 0**）
  pnpm m5.1.1:wp4.1:verify          → 0（**43 / 0**）
  pnpm m5.1.1:wp5:verify            → 0（**58 / 0**）
  pnpm m5.1.1:wp5.1:verify          → 0（**33 / 0**）
  pnpm m5.1.1:migration:verify      → 0（**97 / 0**；量具 23/23 有效）
  pnpm m5.1:query:verify            → 0（**56 / 0**）
  pnpm m5.1:observability:verify    → 0（**27 / 0**；含 AT4.5 零泄漏）
  pnpm m5.1:control:verify          → 0（**41 / 0**）
  pnpm m5.1:page:verify             → 0（**27 / 0**；page.html 未改）
  pnpm m5.1:measurement:verify      → 0（**16 / 0**）

Tests Passed: 51 · 26 · 47 · 135 · 52 · 42 · 22 · 35 · 48 · 43 · 58 · 33 · 97 · 56 · 27 · 41 · 27 · 16（全 0 失败）；19 条命令全 exit 0
Tests Failed: 0
Tests Not Run（**理由明确**）:
  · m4.5:ci / m4.5:ci:full —— 会重写 m4/m4.1/m4.5 历史证据；WP6-14 明说留给 WP10
  · m4.5:smoke:live —— 需要 OPENAI_API_KEY；本步只改只读面
  · m5.1:gates / m5.1:regression:verify —— 读 m4.5:ci 的日志
  · m5.1.1:prod-copy:verify —— 无 schema 变更，没有新的副本 apply
  · 真实库 data/pglite 的任何 apply / update（未打开）
  · WP7 · Phase 4 / ADR-043 · 里程碑标签（需要你批准）

Evidence Produced:
  artifacts/m5.1.1/wp6-replay.json ・ wp6-query-grounding.json      —— 计划书**登记**的两个证据名
  artifacts/m5.1.1/wp6-recorded-read-path.json                     —— 同一份内容（便于按 WP 名检索）
                                                                     （读侧清单与分类 / 对话与行动 DTO 读数 /
                                                                      trace 关联 / R1–R6 / 跨账本 / 只读前后快照 /
                                                                      边界 / K-28 缺口）
  artifacts/m5.1.1/wp6-*.log（19 份）· wp6-gate-exits.txt · wp6-restore-whitelist.txt

Commit Hash:
  7bb7ebd  （feat：读侧消费存储归因 + 三态 DTO + 接地证明 + 两个读侧解码入口）
  373ebbd  （test：WP6 专项门 + 证据 fork/还原）
  9ed1104  （docs：R-29（K-28）/ compatible-assertion record / 本文件）
```

---------------------------------------------------------------------------
 WP6-15 验收 —— 逐条
---------------------------------------------------------------------------
```text
authoritative recorded read path = PASS  ✅ 查询面消费存储归因（trace + execution）
conversation query attribution   = PASS  ✅ 六个槽位 + origin + Axis B + subject，逐字段等于物理列
action query attribution         = PASS  ✅ initiator/actor/executor/authority/recordedBy/origin；Axis B=N/A
trace linkage                    = PASS  ✅ input_event_id → 对话事件；trace 表**零**归因列
R1–R6 replay/rebuild             = PASS  ✅（R1 无第二份存储 + 重建逐字段一致；R2 不重推；R3/R5 历史保持；
                                            R4 不同可区分/相等仍相等；R6 三态两两不同）
tri-state preservation           = PASS  ✅ Known / Unknown(reason) / Absent 在 DTO 层可判别
D01/K-27 cross-ledger preservation = PASS ✅ 三个读侧面全指向 SERVICE/agent；legacy 兼容字段说 user 也不影响
query read-only                  = PASS  ✅ Query Mutation Count = 0（六张权威表哈希前后相同）
legacy compatibility             = PASS  ✅ 没有信封的行 ⇒ attribution **缺席**（不凭空补）
execution truth unchanged        = PASS  ✅ accepted/attempted/executed/verification 与归因可见性无关
inherited gates                  = PASS  ✅ 19 条命令全 exit 0
live DB untouched                = PASS  ✅ 只记录 PRODUCTION_DB_DIR；所有门在沙箱里
⇒ **WP6 = PASS** ⇒ **WP7 = READY / AUTHORIZED**
```

---------------------------------------------------------------------------
 关键设计（为什么这样最小）
---------------------------------------------------------------------------
```text
① 两条读路**刻意分开**（不是重复实现）：
     rowToEvent / toEvent                   = **事件对象**语义（WP4/WP5：只有 RECORDED 才有信封）
     read*StoredAttribution*                = **读侧表示**语义（WP6：MIGRATED_LEGACY 也如实展示）
   因此 WP4/WP5 的既有判据（"MIGRATED_LEGACY 不制造信封"）**一个字都没改**。

② 三态用**判别联合**而不是可空字段：
     { state:'KNOWN', kind, id } | { state:'UNKNOWN', reason } | { state:'ABSENT' }
   ⇒ "未知"在类型层就不可能被写成 null / '' / '-'；R6 由类型与门同时保证。

③ "没有信封"用**字段缺席**表达，而不是"三态全 Absent"：
   前者是"这条行没有记录过归因"，后者是"这些概念对它不适用" —— 两件事不能合并。

④ trace 归因**零存储**：input_event_id → 对话事件 → 它的归因列。
   门里断言 `character_traces` 没有任何归因列，且只有 input_event_id 这条关联。

⑤ 行动侧的归因取**最后一条带信封的事件**的快照 + `basisEventType`/`basisSequence`：
   阶段快照不跨阶段合并（WP5-5），因此不会把 REQUESTED 行的 Absent 用后来的事实"补上"。
```

---------------------------------------------------------------------------
 架构偏差 / 已知问题（如实登记）
---------------------------------------------------------------------------
```text
1. **K-28（P1 OPEN，本步登记、不修）**：**对话 ingress 还没有构造受信归因** ——
   全 `src/` 里没有生产代码调用 `buildTrustedAttributionContext()`（只有契约与门）。
   ⇒ 生产里的 `conversation_events` 仍是 legacy（origin 为 NULL），
     于是 `trace.attribution` 在生产上**缺席**；而本门证明的是"只要行是 RECORDED，
     读侧就逐字段精确"。**这不是读侧缺陷**（WP6 的范围是读侧），
     而是**写侧接线缺口**：给对话侧接线属单独 WP（与 WP5 的动作侧同一形状）。
   门里有一个**测量**把这个缺口写进证据（`knownGap.conversationIngressProducers = 0`），
   并且只在"已接线或已登记"时通过 —— 不假装它已经接线。
2. 行动查询的归因只在**详情面**（`getExecution`）暴露；列表面（`listExecutions`）**有意**不带它
   —— 否则每行都要多读一次事件流（N+1），而 WP6-10 明令本 WP 不造新的查询产品。
3. trace 的归因是**派生**的（不是 `CharacterRunTrace` 的字段），因此它进了编译期接地的
   **派生键清单**。这是任务书 WP6-5 允许的"minimal F4-compatible adjustment"；
   它不是放宽：门里逐字段把 DTO 与物理列比对，并且断言 trace 表**没有**归因列。
4. 行动行**没有** ActionFailed 的实例出现在本门 fixture 里（链路到 SUCCEEDED）：
   归因面与执行状态无关（WP5 的门已经覆盖 FAILED/PARTIAL/CANCELLED 的写路径），
   本步只补"读侧把这些行原样展示"的那一半。
5. ADR-042 仍是 ACCEPTED / DESIGN FROZEN，本步没有改它（R-29 只进 Execution-Plan 的修订记录）。
   没有 schema 变更、没有 v9；`MIGRATION_0007` / `0008` 指纹逐字未变（门里断言）。
```

---------------------------------------------------------------------------
 Next WP Preconditions（WP7 = READY / AUTHORIZED，但**不要在本 execution 开始**）
---------------------------------------------------------------------------
```text
WP7（开发者页面 / 最终呈现）现在拿得到完整的数据模型：
  □ 三态在 DTO 层不折叠（页面可以直接照原样渲染 Known / Unknown(reason) / Absent）
  □ 对话与行动的归因都从存储列来，且 subject / basis 有明确出处
  □ 仍需遵守：不得在页面层把 Unknown 渲染成空 / "-"，也不得把 MIGRATED_LEGACY 说成 RECORDED；
    不得合并 WP6 + WP7；Phase 4 / ADR-043 仍 NOT APPROVED；
    任何 schema 变更都必须新写 v9+（v7 / v8 都已是指纹锁定的历史 DDL）
  □ K-28（对话 ingress 接线）仍是 P1 OPEN，独立于 WP7
```
