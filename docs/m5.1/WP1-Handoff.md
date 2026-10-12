# WP1 Handoff — Developer Plane Contracts

> 计划书要求的交接单。**下次 execution（WP2）先读这份**，再读
> [`M5.1-Execution-Plan.md`](./M5.1-Execution-Plan.md)（§2 修订记录 R-4 / R-5 / R-6）、
> [`M5.1-Repository-Map.md`](./M5.1-Repository-Map.md)（§2 既有 CLI 开发者平面 / §4 预留钩子 / §5 F-4·F-8·F-9）、
> [`M5.1-Authority-Map.md`](./M5.1-Authority-Map.md)（§2 禁止方向）。
> **不要重新探索仓库。**

```text
Completed WP: WP1 — Developer Plane Contracts（结论 PASS）

Changed:
  src/kernel/contracts/developer-query.ts       （新增：DeveloperQueryService 8 个只读方法的 port /
                                                 Developer*Dto / 有界游标分页 / DeveloperLookup 三态 /
                                                 执行阶梯自洽断言 / 两条**编译期**字段接地证明）
  src/kernel/contracts/developer-control.ts     （新增：ControlCommand / ControlResult / ControlCommandType /
                                                 CONTROL_COMMAND_FACTS 白名单 / FORBIDDEN_CONTROL_COMMANDS /
                                                 outcome×disposition×verification / controlLadderBooleansOf /
                                                 稳定序列化与摘要）
  src/kernel/contracts/observability.ts         （新增：ObservabilityStage 分类法 + 阶段生产者登记 /
                                                 stageOfTraceStepKind 唯一映射 / ObservabilitySpanInput /
                                                 spanDurationMs / AT1.4 的 **key 级** telemetry 白名单）
  src/kernel/contracts/index.ts                 （改：3 行 re-export + 文件头登记；无其它改动）
  scripts/kernel-tests-dev-plane.ts             （新增：契约测试 50 项）
  package.json                                  （改：只新增 "m5.1:test"，既有脚本语义未动）
  artifacts/m5.1/wp1-contracts.json             （新增：证据 + 三张登记表快照 + 五档执行真相快照）
  docs/m5.1/WP1-Handoff.md                      （本文件）
  docs/architecture/README.md                   （改：登记 m5.1:test、WP1 文档）

Tests（全部 exit 0）:
  pnpm typecheck     → 0（含两条**编译期**字段接地证明：DTO 凭空造字段 → 直接编译失败）
  pnpm m5.1:test     → **50 通过 / 0 失败**（9ms，离线、无 DB、无模型、无 HTTP）
  pnpm kernel:test   → 26 通过 / 0 失败（依赖方向静态锁覆盖三个新文件）
  pnpm kernel:verify → 25 通过 / 0 失败（走沙箱库）
  pnpm m3.5:test     → 30 通过 / 0 失败（FC-T08 prompt 逐字节仍一致）
  pnpm m4:test       → 243 通过 / 0 失败（package.json 静态锁未被新脚本破坏）
  pnpm m5:test       → 30 通过 / 0 失败 → 跑完已 `git checkout -- artifacts/m5/wp1-contracts.json`
                       还原 M5 的历史证据（AGENTS §7），本文件记的是**这次实测**的计数

Evidence: artifacts/m5.1/wp1-contracts.json
          （含 12 个阶段的登记快照、8 个查询能力、2 个白名单命令 + 7 个禁止命令、
            10 个控制理由码、五档执行真相的指纹、敏感数据政策三张表、字段接地清单）

Known issues（都是**契约层的刻意设计**，不是缺陷）:
  · **三个契约文件都只交付形状与判定，没有实现**：没有 DeveloperQueryService 的实现、
    没有 HTTP、没有页面、没有 Control 执行器（计划书 WP1 Forbidden）。
  · `intent` / `attempt` / `verification` 是**派生**字段，因为今天**没有**独立权威形状：
    运行时还没有意图分类器（M5 局限 1）、`attempted` 由账本 `ACTION_STARTED` 派生、
    账本里没有核验事件的独立证据（Repository Map F-4）。契约因此把"今天填不出来"
    做成一等公民（`DeveloperQueryAvailability` / `verification` 四态），**不许伪造**。
  · `action` / `policy` 阶段的理由码引用 M4.5 的 `ACTION_FAILURE_CODES`；
    `eligibility` / `ranking` / `selection` 引用 M5 的 `RECALL_EXCLUSION_REASONS`；
    `developer_control` 引用 `CONTROL_REASON_CODES` —— **一个都没另造**。
    `turn` / `context` / `model` / `response` 四个阶段今天 `reasonCodes` 为**空**
    （`stagesWithoutReasonCodes()` 如实列出），WP4 要 emit 必须先回来登记。
  · `developer-control.ts` 是 `src/kernel/contracts/**` 里**唯一**一处 import 到
    `contracts/` 之外的模块（`type ActionFailure`）。理由逐条写在文件头：
    它是领域层不是基础设施、运行时不成环、另造一套失败码才是真正的代价。
    契约测试有一条静态锁把这个 import 白名单化（多一条就失败）。
  · `api_key_id` 这类键会被**敏感段优先**规则拒绝（`_id` 后缀救不了它）。
    代价：`token_count` 一类"看起来像计数"的键也会被拒 —— 这是刻意的 fail closed。
  · 契约文件选择**扁平放 `src/kernel/contracts/`**，没有新建 `kernel/dev|query|control`
    （修订记录 R-4 的理由：开发者平面不是领域能力；先例是 `contracts/recall.ts`）。

Interfaces exposed to next WP（WP2 直接消费）:
  · 查询：`DeveloperQueryService` / `DeveloperLookup<T>` / `DeveloperMiss` / `DeveloperPage<T>` /
    `DeveloperPageRequest` / `resolveDeveloperLimit` / `encodeDeveloperCursor` / `decodeDeveloperCursor` /
    `assertDeveloperCursor` / `DeveloperCursorKey`
  · DTO：`HealthDto` / `CapabilitiesDto` / `DeveloperRuntimeCapabilityDto` /
    `TraceSummaryDto` / `TraceDetailDto` / `DeveloperTraceStepDto` /
    `MemoryStatsDto` / `MemoryIntegrityDto` /
    `DeveloperExecutionSummaryDto` / `DeveloperExecutionDetailDto` + 六个子 DTO
  · 入参解析（唯一入口，失败关闭）：`parseTraceListQuery` / `parseTraceGetQuery` /
    `parseMemoryStatsQuery` / `parseMemoryIntegrityQuery` / `parseExecutionListQuery` / `parseExecutionGetQuery`
  · 派生算法（唯一处，WP2 必须调它，不许自己算）：`developerDurationMs` / `summarizeTraceDerived`
  · 如实性：`DeveloperQueryAvailability` / `unavailable()` / `AVAILABLE` /
    `DeveloperVerificationState` / `DEVELOPER_VERIFICATION_STATES`
  · 断言：`assertDeveloperLookup` / `assertDeveloperExecutionSummary` /
    `assertDeveloperExecutionDetail` / `assertDeveloperCapabilityFact`
  · 上限：`DEVELOPER_QUERY_LIMITS` / `DEVELOPER_QUERY_CAPABILITY_IDS` /
    `DEVELOPER_QUERY_CAPABILITY_FACTS` / `DEVELOPER_QUERY_REASON_CODES`

Do not modify（WP2–WP9 只消费，不重定义）:
  · `DeveloperLookup` 的**三态**语义（找到 / 没找到 / 今天填不出来）——
    合并成 `T | undefined` 会让三种处置无法区分。
  · `DeveloperVerificationState` 的**四态**与 `attempted ⇒ accepted`、`executed ⇒ attempted`
    这条单调性（它是 AT3.6 判据的基石）。
  · `DEVELOPER_QUERY_LIMITS` 的边界与"越界抛错而不是夹住"这条语义。
  · 游标形态（`v1.<startedAt>.<encodeURIComponent(id)>`）与 `maxCursorLength` ——
    改形态 = 客户端手里的 cursor 全部作废，属破坏性变更。
  · `assertTelemetryAttributesAllowed` 的**判定顺序**（敏感段优先 → 显式白名单 → 后缀模式 → 默认拒绝）。
    调换顺序会让 `api_key_id` 重新蒙混过关。
  · `CONTROL_COMMAND_FACTS` 的两个命令**必须保持 `mutatesDomain === false`**；
    要加会改变领域状态的命令，**不是**改这个字段，而是让它走
    Validation → Policy → Domain Command → ActionGateway → Event Ledger（STOP 条件 14）。
  · `FORBIDDEN_CONTROL_COMMANDS` 是**禁止清单**，不是"还没实现的清单"（AT3.5）。
  · 阶段理由码必须继续**引用**既有受控词汇，不许在 `observability.ts` 里新造字符串。
  · 冻结区：`contracts/memory.ts` / `contracts/trace.ts` / `migrations.ts` /
    `kernel/app/memory/**` / `memory-validator.ts` / `memory-store.ts` reducer 语义 /
    `src/infrastructure/telemetry/**` / `src/character/苏沐薇.ts` / prompt 基线。

Next WP prerequisites（WP2 Unified Read-Only Query API 必须做到）:
  1. **只读**：只调既有 readers / probes —— `trace-store.ts`（`getTrace` / `countTraces`）、
     `memory-integrity.ts` 的 `memoryIntegrityProblems()`、`memory-store.ts` 的统计入口、
     `action-ledger-store.ts` 的 `listRecords` / `foldRecord`。
     **不许在 handler 里写 arbitrary SQL**（AT2.1）。
  2. **不重新实现 Memory 状态判断**（AT2.4）：`MemoryStatsDto` 逐字段搬运 `MemoryStatsView`；
     `integrityOk` **只能**来自 `memoryIntegrityProblems()`（Repository Map R-2 / F-5）。
  3. **`listTraces` 需要新的一条只读列表查询**：既有 `TraceWriter.recent()` 无 cursor、
     无过滤、上限 200。按 **append-only** 追加（不改 `recent()` 语义，`--inspect` 在用它），
     游标键 `(started_at, trace_id)`，正好走既有索引 `character_traces_recent`
     （`migrations.ts:224`）。**不要新增迁移**（Repository Map F-11）。
  4. **`attempted`/`executed` 的来源要写进 `evidenceOf`**，不许自报：
     `attempted` 读 `ACTION_STARTED` 的存在性；`executed` 读 `ActionResult.executed`；
     `verification` 今天只能是 `not_attempted`（除非真的做出核验）。
  5. **`intent` 如实标 `not_available`**（M5 局限 1）。**不许为实现意图分类器扩大 scope**
     （STOP 条件 7）。
  6. **HTTP 面落点**：仓库内最小只读服务（`node:http`，**零新依赖**，仅 loopback，
     dev-only 开关），前缀可依实现调整；`GET /dev/query/*` 八个端点与
     `DeveloperQueryService` 的八个方法一一对应。页面留给 WP5。
  7. **WP2 HARD GATE 的负控形态**：先快照 DB / 账本计数 → 调**全部** Query 端点 →
     再快照 → 必须**逐字段相同**（`Query Mutation Count = 0`）。
     不能只靠代码审查说"看起来没写"。
  8. 新增脚本建议命名 `pnpm m5.1:query:verify`，证据写
     `artifacts/m5.1/query-negative-control.json`；并加静态锁"handler 内不得出现 SQL"
     （AGENTS §5：`scripts/verify-*.ts` 这类量具本身也要被验证）。
```
