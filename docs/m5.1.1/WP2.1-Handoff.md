# WP2.1 Handoff — Pre-Production-Copy Schema Reconciliation

> **结论：WP2.1 = PASS。K-3 矩阵同步 = DONE。K-16 = PASS（safe to reuse = YES）。
> production-copy v7 migration = NOT RUN（仍等你放行）。WP3 = NOT STARTED。**
>
> 下次 execution **先读这份**，再读
> [`WP2-Handoff.md`](./WP2-Handoff.md)（v7 schema 与 K-4）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) §2（**R-12 已标 DONE；新增 R-14/R-15/R-16**）、
> [`M5.1.1-Migration-Strategy.md`](./M5.1.1-Migration-Strategy.md) §3.2/§3.3（回填矩阵）。
> **不要重新探索仓库。**

```text
Completed WP: WP2.1 — Pre-Production-Copy Schema Reconciliation
              K-3 matrix sync = DONE · K-16 = PASS · production-copy v7 = NOT RUN

Changed Files:
  src/kernel/contracts/attribution.ts                  （改：tool_event 三格 + RULINGS 记录）
  scripts/kernel-tests-m5.1.1.ts                       （改：裁定同步测试 + tool_event 四条断言）
  scripts/verify-m5.1.1-k16-overlap-audit.ts           （新增：K-16 门）
  package.json                                         （改：新增 m5.1.1:k16:verify）
  docs/m5.1.1/M5.1.1-Proposed-Schema.md                （改：§3 tool_event 行 + K-3 行内注解）
  docs/m5.1.1/M5.1.1-Migration-Strategy.md             （改：§3.2 executor D→N + 逐条依据）
  artifacts/m5.1.1/wp2.1-k16-overlap-audit.json        （新增：K-16 证据）
  artifacts/m5.1.1/wp2.1-gate-exits.txt + 9 份日志      （新增）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                 （改：R-12 标 DONE；新增 R-14/R-15/R-16）
  docs/m5.1.1/WP2.1-Handoff.md                         （本文件）

Tests Run（全部 exit 0）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0
  pnpm kernel:verify              → 0（改了 contracts/**，AGENTS §5 的配套门）
  pnpm kernel:test:conversation   → 0
  pnpm m5.1.1:test                → 0（**42 通过 / 0 失败**；上一轮 41 —— 替换 1 条"差异登记"测试，
                                     新增 1 条 tool_event 断言组，内含 4 条断言）
  pnpm m5.1.1:migration:verify    → 0（77 通过 / 0 失败）
  pnpm m5.1.1:k16:verify          → 0（9 通过 / 0 失败）

Tests Passed: 9/9（K-16 门）· **42/42**（契约门）· 77/77（迁移门）· 7 条命令全 exit 0
Tests Failed: 0
Tests Not Run: production-copy v7 migrate:apply（**等你放行**）；WP3 backfill（未开始）

Evidence Produced:
  artifacts/m5.1.1/wp2.1-k16-overlap-audit.json —— K-16 的完整事实（下节逐字段列出）
  artifacts/m5.1.1/wp2.1-gate-exits.txt + wp2.1-*.log（7 条命令的逐字 stdout）
  artifacts/m5.1.1/wp2-schema.json / wp1-*.json（被本轮重跑刷新）

Commit Hash: 2bd703fed85e32af2f101e717236e1a0603ce15b

---------------------------------------------------------------------------
 K-3 同步（用户裁定 → 四个落点，全部改完）
---------------------------------------------------------------------------
  tool_event.actor             = REQUIRED   谁产生了这条 tool event      （TOOL/<tool-id>）
  tool_event.contentOriginator = REQUIRED   谁产生了这段工具输出内容      （TOOL/<tool-id>）
  tool_event.executor          = ABSENT     conversation 的工具事件不是一次执行
  历史迁移分类：actor D · contentOriginator D · executor N
  · 契约：NECESSITY_MATRIX.tool_event + NECESSITY_MATRIX_RULINGS（旧值→新值+理由+裁定人）
  · Proposed-Schema §3 行 + 行内注解          · Migration-Strategy §3.2 + 逐条依据
  · 契约测试：裁定同步断言 + executor 填值被拒 / 缺 actor 被拒 / 缺 contentOriginator 被拒

---------------------------------------------------------------------------
 K-16：v6 既有列与 v7 22 列的重叠审计（**十项事实，逐列**）
---------------------------------------------------------------------------
 真实库（只读统计，**从未打开**）：
   data/pglite｜1201 文件｜31,289,946 字节｜最新 mtime 2026-09-17T15:51:40.789Z
   boundary 指纹（(相对路径,大小) 排序后 sha256）＝见证据 productionReadOnly.boundaryFingerprint
 副本（cpSync 后**只开副本**）：copySchemaVersion = **v6**（代码最新 v7）⇒ 证明没有在副本上跑 v7

 对话表规模：conversation_events 共 **28 行**
 重名列：**恰好 3 个**（v7 22 列 → 净新增 **19** 列；既有 20 列）

 ① source_kind
    · 创建迁移：**v3**（m3-identity-and-conversation-integrity）`add column if not exists source_kind text`
    · 旧语义：Axis B 第一列（来源类别）—— 但写入时是由 `actor_type` **全函数推导**的投影值
    · 类型 text｜可空 YES｜默认 空
    · 非空计数：**24 / 28**
    · distinct：`character_output=12`、`user_statement=12`
    · 既有约束：0 条｜既有索引：1 个（`conversation_events_source_kind`）
    · v7 的意图语义：Axis B 第一列（**同一轴**），v7 只追加词表 CHECK
    · 可安全复用：**YES**（0 个越界取值）
 ② source_authority
    · 创建迁移：**v3**｜旧语义：Axis B 第二列（权威等级），同样由 `actor_type` 推导
    · 类型 text｜可空 YES｜默认 空
    · 非空计数：**24 / 28**
    · distinct：`CHARACTER_GENERATION=12`、`USER_EXPLICIT=12`
    · 既有约束：0 条｜既有索引：0 个
    · v7 的意图语义：Axis B 第二列（新增取值 `UNCONFIRMED_ORIGIN`，既有 6 个一字不改）
    · 可安全复用：**YES**
 ③ epistemic_source
    · 创建迁移：**v3**｜旧语义：Axis B 第三列（认知产物类别），同样由 `actor_type` 推导
    · 类型 text｜可空 YES｜默认 空
    · 非空计数：**24 / 28**
    · distinct：`character_generation=12`、`user_report=12`
    · 既有约束：0 条｜既有索引：0 个
    · v7 的意图语义：Axis B 第三列（新增 `UNCONFIRMED_ORIGIN`）
    · 可安全复用：**YES**

 为什么 `ADD COLUMN IF NOT EXISTS` 静默跳过是**正确**的：
   列名 / 类型 / 可空性 / 既有取值域都落在 ADR-042 的 Axis B 之内，v7 只**追加**词表约束
   与一个新取值，不改变列语义。⇒ **K-16 = PASS / safe to reuse = YES**。

 分类问题的答案（用户问的两种可能，实测都不是）：
   · 不是 `schema exists but runtime never writes` —— 24/28 行有值
   · 不是 `historically different semantic columns` —— 取值全在 Axis B 受控词汇内
   · **是第三种**：`schema exists + runtime 会写，但写的是由 actor_type 全函数推导出来的投影值`
   ⇒ 它**不携带 actor_type 之外的任何信息**。4 行没有值（= 0003 之前的旧行，
     正是 `deriveSourceForLegacyRow` 兜底的对象 —— 与 M3 注释里"真实库里有 4 条"吻合）。

 D01 调查报告为什么会判断"这三列不存在"：
   `M5.1.1-D01-Investigation-Report.md` ③ 的原话是
     "migrations 的 conversation_events **没有** source_kind / source_authority /
      epistemic_source 列；infrastructure/persistence/event-store.ts 也不写它们"。
   实测：这句话对 `conversation_events` **是错的**（0003 就建了这三列，且
   `conversation-store.ts:276` 的 INSERT **会写**它们）。当时看的是 **event-store**（领域事件
   那条写路径）与 `character_action_events`（确实没有这三列），把结论套到了整张
   conversation_events 上。
   ⚠️ 同一句话也出现在 **ADR-042 L67–69**（"落库侧：provenance 没有被持久化"）。
   两份文档本 WP **只登记、未修改**（ADR 已 ACCEPTED；你明令不要改 ADR-042）——
   见下文 K-18。正确的表述是：
     "Axis B **被持久化**，但持久化的是由 `actor_type` 推导出来的投影值，
      因此它不携带 `actor_type` 之外的任何信息；0003 之前的旧行完全没有值，读回时兜底推导。"
   D01 的**结论不受影响**，反而更清楚：问题不是"没记"，而是"记的是推导值"。

---------------------------------------------------------------------------
 连带发现（**WP3 的前置**，本 WP 不做）
---------------------------------------------------------------------------
 回填会把既有非空 Axis B 改写成 `UNCONFIRMED_ORIGIN`（冻结值）——
 那三列**已经存在且有值**，所以这是**改数据**，`IF NOT EXISTS` 不会救我们。
 逐消费者后果：
   · 生产内存链路**不变**：`extractor.ts:149-156` 用的是**它自己推导的**
     `sourceAuthority`（`defaultAuthorityForKind(sourceKindForActor(actorType))`），
     不读行上的记录值。
   · **会变**的：账本上可见的值、任何直接读记录值的面（开发者平面/审计）；
     以及 M3 评测里 `sourceAuthority === 'CHARACTER_GENERATION'` 这类断言在
     读到**被回填的旧行**时会失效。
 ⇒ 这是 WP3 的强制前置项（计划 R-15 / K-17），不是 WP2.1 的。

Known Issues:
  K-16 【已闭环】重叠审计 = PASS / safe to reuse = YES（上面十项事实）。
  K-17 【WP3 前置】回填改的是**数据**：既有 24 行非空 Axis B 会被写成 UNCONFIRMED_ORIGIN。
       回填前必须逐消费者确认（至少：抽取器 / 开发者平面 / M3 评测），并如实报告影响面。
  K-18 【待你批准】**两份文档里的假前提**未修改：`M5.1.1-D01-Investigation-Report.md` ③
       与 `ADR-042` L67–69。建议做**最小更正**（加更正块、不重写历史、不升 Revision），
       因为它是 K-16 的事实基础；本 WP 按"不改已 ACCEPTED 的 ADR"的纪律停在这里。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  K-8  【待 applied 后锁】v7 的内容指纹（现在只锁 0001–0006）。

Architecture Deviations:
  D-1  K-3 的同步**只改值不改结构**：矩阵的语义（三态 + 词表）没动，
       动的是 `tool_event` 行的三格与其依据文本；旧值以 `NECESSITY_MATRIX_RULINGS` 留痕，
       防止有人从旧文档里读到旧值再当实现真相。
  D-2  K-16 门**刻意不调用 `initDatabase()`**：沙箱路径会被放行，那会把 v7 施加到副本上，
       正是用户禁止的动作。证据里以 `copySchemaVersion = v6` 与 `v7AppliedToCopy = false` 留证。
  D-3  K-16 的"可安全复用"是**按取值域**判的（0 越界）；它**不**声称"这三列的历史值是可信的"
       —— 恰恰相反，它们是推导值（见 K-17）。

Do not modify（后续 WP 只消费）:
  · 0001–0007 的任何语句（0001–0006 有指纹锁；v7 一旦 applied 即历史）
  · ADR-042（已 ACCEPTED；K-18 的更正需你先批准）
  · 运行时写入路径 / Fact Firewall / extractor / MemoryAuthority / Recall
  · artifacts/{m5.1,m4.5,m5,m4-acceptance,m4.1}/**（还原只按 whitelist）
  · data/pglite（只有 src/main.ts 能开它）

Next WP Preconditions（WP3 — Legacy Backfill）:
  1. **你放行 production-copy v6→v7**（WP2 的 STOP 点仍在这里）：备份 → 核对(文件数+字节)
     → cpSync 副本 → migrate 预览 → **副本** apply → 计数 → 重放；记录 restore epoch/boundary。
     ⚠️ K-16 已关闭，但 apply 前请再确认一次：v7 会给那三列**加词表 CHECK**，
     既有 24 行取值已实测全部在词表内（apply 不会因约束校验失败）。
  2. **先处理 K-17**：回填把既有非空 Axis B 改写为 UNCONFIRMED_ORIGIN 的后果，
     必须逐消费者写清楚（抽取器 / 开发者平面 / M3 评测），再动手。
  3. WP3 按 `event-family × slot` 的 D/P/U/N 回填（Migration-Strategy §3.2/§3.3，已含 K-3 的 D/D/N）。
  4. 证据一律 `artifacts/m5.1.1/`；还原按 whitelist；每个计数检测器都要 measured_count > 0。
  5. 交 WP3-Handoff（九字段）后 STOP。
```

---

## Batch C 的边界

WP2.1 **到此 STOP**：K-3 同步完成、K-16 关闭，但**没有**在 production copy 上执行 v7，
**没有**开始回填。真实库全程只被统计文件数与字节（`opened: false`），副本读完即删。

按你的顺序，下一步是：

```text
K-16 PASS（已完成）
   ↓
你放行 → Production-copy v6→v7 migration
   ↓
WP3 Legacy Backfill（先处理 K-17）
```
