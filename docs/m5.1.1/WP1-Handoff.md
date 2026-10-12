# WP1 Handoff — Attribution Contracts

> **结论：PARTIAL —— 交付物已完成并验证，但任务书 §6（Axis B 扩展）单点 BLOCKED。**
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-WP1-Blocking-Issue-Report.md`](./M5.1.1-WP1-Blocking-Issue-Report.md)（阻塞点与三个裁定选项）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md)（§1 用户原文 / §2 修订记录 / §3 批次表）
> 与 [`../adr/ADR-042-attribution-model.md`](../adr/ADR-042-attribution-model.md)。
> **不要重新探索仓库。**

```text
Completed WP: WP1 — Attribution Contracts（PARTIAL：§6 BLOCKED，其余交付）

Changed Files:
  src/kernel/contracts/actor.ts                 （改：追加 PrincipalKind / PrincipalRef /
                                                 UnknownReason / AttributionValue 三态 + 构造器）
  src/kernel/contracts/attribution.ts           （新增：AuthorityKind / AuthorityRef / 七槽位信封 /
                                                 冻结必要性矩阵 / 双向 validator / Attestation 边界 /
                                                 22 个 v7 列名）
  src/kernel/contracts/source-authority.ts      （改：**仅注释** —— sourceKindForActor 的契约定位；
                                                 值域与行为一个字未改）
  scripts/kernel-tests-m5.1.1.ts                （新增：35 项契约测试）
  package.json                                  （改：新增 m5.1.1:test）
  artifacts/m5.1.1/wp1-contracts.json           （新增：本 WP 证据）
  artifacts/m5.1.1/wp1-typecheck.log /
      wp1-kernel-test.log / wp1-contracts-test.log /
      wp1-diagnostic-conversation.log           （新增：四条命令的逐字 stdout）
  docs/m5.1.1/M5.1.1-WP1-Blocking-Issue-Report.md（新增：本 WP 的 BLOCKED 文书）
  docs/m5.1.1/WP1-Handoff.md                    （本文件）

Tests Run:
  pnpm typecheck                 → exit 0
  pnpm kernel:test               → exit 0
  pnpm m5.1.1:test               → exit 0（**35 通过 / 0 失败**，4ms）
  诊断（**不是门**，只为量出阻塞点的影响半径）:
  pnpm kernel:test:conversation  → exit 0（47 通过 / 0 失败）
  未运行：m3:ci / m4:ci / m4.5:ci / m5:gates / m5.1:gates / 任何 Live Smoke
  （按任务书 §9 与"不要跑 M5/M5.1 大门顺便验证"的纪律；大的 inherited regression 留给
   明确的兼容性/回归 WP）

Tests Passed: 35 / 35（m5.1.1:test）· 三条必跑命令全 exit 0
Tests Failed: 0
Tests Not Run: 见上（有意不跑的那些，**不记为 PASS**）

Evidence Produced:
  artifacts/m5.1.1/wp1-contracts.json  ← 由真实测试输出生成；含
     passed/failed/failures、受控词汇（三类）、三态、矩阵（9 族 × 7 槽）、
     负控 5 条 + 正控 3 条的逐条 observed、Attestation 边界、22 列命名桥、
     防火墙零退化探针、suiteExits（typecheck / kernel:test，来自包装命令的真实退出码；
     缺失时为 null，**不推断为 0**）、axisB.status = "BLOCKED"（含编译器原文）
  artifacts/m5.1.1/wp1-*.log（4 份逐字 stdout）

Commit Hash: 84cc17a892cbc9d6cf92fbb4ff84bee7aeb62abd
             （本 handoff 与 Blocking-Issue-Report 在其后一个提交里）

Known Issues（全部登记，一条都没修）:
  K-1  **§6 Axis B 扩展 BLOCKED（唯一阻塞项）**：向 SourceAuthority 联合类型加
       UNCONFIRMED_ORIGIN 会让**冻结区** src/kernel/contracts/memory.ts:1336 的穷尽性锁
       （authorityFromSource 的 `const exhaustive: never = source`）编译失败 ——
       编译器原文：`error TS2322: Type '"UNCONFIRMED_ORIGIN"' is not assignable to type 'never'`。
       为什么不能顺手改：memory.ts 是 AGENTS §3 的冻结区；"MemoryAuthority changes" 是 WP1 §11 的
       Forbidden Scope；而"新的 SourceAuthority 对应哪一种 MemoryAuthority"正是 U-06 / U-09
       **移交 ADR-043** 的决定。⇒ 按 §2/§11 写阻塞文书并 STOP，等裁定（三个选项见文书 §5：
       B1 冻结区加 fail-closed 分支 / B2 放宽 never 锁（不推荐）/ B3 推迟到 ADR-043 之后）。
       当前实现状态 = **值域未改**（SOURCE_AUTHORITIES 仍 6 个），因此树是绿的。
  K-2  **契约层未进公开出口**：没有改 src/kernel/contracts/index.ts（re-export + 文件头登记）。
       理由：WP1 §2 的 Allowed Scope 只列了三个契约文件，而"必须修改其他 production source"
       要 STOP；而不改它并不阻碍本 WP 的任何一项。留给**第一个消费它的 WP**（WP4/WP5）或你的
       明确批准。⚠️ 在那之前，新契约只能按路径直接 import。
  K-3  **矩阵 ↔ ADR 表述差异（3 格，未单方面裁定）**：ADR-042 D7 L265 把
       actor / contentOriginator 列为 conversation_events 的必需槽位、L609 说 tool_event 的
       executor 必需；而冻结矩阵对 tool_event 记的是 actor=ABSENT、executor=ALLOWED_UNKNOWN、
       contentOriginator=ABSENT。本 WP **按矩阵实现**（任务书要求"对冻结矩阵建立 validator"，
       且 WP3 的 D/P/U/N 就派生自它），差异已落成数据
       （NECESSITY_MATRIX_DIVERGENCES）并进证据。**WP4 写工具事件之前必须先有结论**，
       否则会出现"契约拒写、设计要求写"的僵局。
  K-4  **M3 既有断言的碰撞（属 Axis B 落地方）**：kernel-tests-conversation.ts:102 里
       `SOURCE_AUTHORITIES.length === 6`。该值一旦落地，这条既有 M3 断言必然变红 ——
       它属 F4 兼容性更新（单独记录 changed assertion + 证明未放宽旧判据 + 新结果只写
       artifacts/m5.1.1/）。本次**诊断**已证明：在"值域未改"的当前状态下 47/47 全绿，
       所以碰撞严格绑定于那一次加值，而不是本 WP 的其它改动。
  K-5  `attribution.ts` 里我为若干设计上的空白做了**最小且显式**的语义选择，均已写进代码注释：
       ① `?`（ALLOWED_UNKNOWN）单元也要求"被表态" —— Absent 违规；
       ② `REQUIRED` 允许 `Unknown(RUNTIME_UNRESOLVED)`（U-04），但**不允许**
          `Unknown(LEGACY_UNRECORDED)`（那是回填行的结论，不是新事件的合法状态）；
       ③ 信封包含 `attributionOrigin`（ADR-042 §4 L590 的 RECORDED / MIGRATED_LEGACY），
          它不属于七槽位、不参与矩阵；
       ④ 回填行不走写入期矩阵，只查一条：**不得出现具体 contentOriginator**（伪造检测）。

Architecture Deviations:
  D-1  本 WP 按任务书 §2/§11 **主动停在**一个冻结区冲突前，没有修改
       src/kernel/contracts/memory.ts，也没有放宽 never 穷尽性锁。
  D-2  契约层对外暴露方式：不新增 index.ts re-export（见 K-2）。
  D-3  命名按执行计划修订记录 **R-6**：authority 槽位用 AuthorityKind + AuthorityRef，
       列名对齐 schema（authority_kind / authority_ref / authority_unknown_reason），
       并保留 actor_ref_id（不遮蔽既有 legacy 列）与 content_originator_*（B2 改名）。
       一个概念一个名字：Draft v1 的 sourceAuthor **不得**并行存在（静态锁守着）。
  D-4  刻意**没有**建立 PrincipalKind ↔ ActorType 的转换（ADR D8.1 已删除投影与反向投影），
       也没有建立 PrincipalKind → SourceKind 的全函数（U-08）；两条都有静态锁/注释守着。

Do not modify（后续 WP 只消费，不许顺手改）:
  · src/kernel/contracts/memory.ts（**冻结区**）与 memory 相关语义
  · src/kernel/app/memory/**（含 extractor.ts:149 / :329）· policies/memory-validator.ts ·
    memory-store.ts reducer
  · canEvidenceExternalFact / deriveSourceForLegacyRow / SourceProvenance（Phase 4 之前不动行为）
  · 迁移 DDL 0001–0006 · artifacts/{m5.1,m4.5,m5,m4-acceptance,m4.1}/** · data/pglite
  · M5.1 的 m5.1-complete 标签（仍须指向 2aac6ca）

Next WP Preconditions（WP2 — v7 Additive Schema Migration）:
  1. **可开工的部分**：v7 迁移（conversation_events / character_action_events 各 22 列、
     4 条/槽位的 CHECK、1 个 partial 索引 attribution_origin）＋ U-03 的控制面审计承载
     （**新建** append-only 表；仓库无既有表可复用）＋ 迁移测试（1..7 连续 / old→v7 /
     fresh→v7 / 幂等 / 无 DROP / 无破坏性 ALTER / 旧代码兼容）＋ migration-preview.txt。
     只在**临时库**上跑；**不得**对 data/pglite 执行 migrate:apply。
  2. **被阻塞的部分**：`M511-G6` 的 `M7`（Axis B 三列无 NULL 且取值不越界）需要
     `UNCONFIRMED_ORIGIN` 存在。在 K-1 裁定之前，WP2 **不得**声称 M7 通过，
     也不得自己在 DDL/代码里发明那个值 —— 那等于替 ADR-043 做决定。
  3. 建议顺序：**先要你对 K-1 的裁定（B1 / B2 / B3）**，再决定 WP2 是否把 M7 一并纳入；
     若选 B1 且允许同批处理，则 WP2 或紧随其后的一个小 WP 还需补跑全套 m4:*（冻结区程序）。
  4. 契约的消费方式：按路径直接 import（`../src/kernel/contracts/attribution.ts`），
     直到 index.ts 的 re-export 被你批准（K-2）。
  5. 交 WP2-Handoff（九字段）后 STOP。
```

---

## Batch B 的边界

WP1 **到此 STOP**（用户原文 GLOBAL RULE + 任务书 §12："不得自动开始 WP2"）。
本次没有开始 WP2 的任何工作：既没有写迁移，也没有碰 persistence / 运行时写入路径。

**这是一个 PARTIAL + BLOCKER 结束，不是 PASS**：三条必跑命令全绿、35/35 契约测试通过，
但任务书 §6（Axis B 扩展）因冻结区冲突未交付 —— 该冲突需要你裁定（文书 §5 的 B1/B2/B3）。
