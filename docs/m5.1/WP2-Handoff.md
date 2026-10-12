# WP2 Handoff — Unified Read-Only Query API

> 计划书要求的交接单。**下次 execution（WP3）先读这份**，再读
> [`WP1-Handoff.md`](./WP1-Handoff.md)（契约暴露的接口）、
> [`M5.1-Repository-Map.md`](./M5.1-Repository-Map.md)（§4 预留钩子 / §5 F-4·F-11）、
> [`M5.1-Authority-Map.md`](./M5.1-Authority-Map.md)（§2 禁止方向）。
> **不要重新探索仓库。**

```text
Completed WP: WP2 — Unified Read-Only Query API（结论 PASS；AT2.7 HARD GATE = Query Mutation Count 0）

Changed:
  src/infrastructure/persistence/trace-store.ts   （改：**追加**一个只读分页读取
                                                    TracePageQuery / TracePageResult / listTracePage；
                                                    复用同一份 rowToTrace，**没有改** recent() 的语义）
  src/infrastructure/dev/query-service.ts         （新增：DeveloperQueryService 的只读实现，8 个方法）
  src/infrastructure/dev/http-server.ts           （新增：最小 node:http 只读服务 + 路由表 + 四道闸 + 错误映射）
  src/infrastructure/dev/http-error.ts            （新增：HTTP 层自有错误类型）
  src/main.ts                                     （改：`--dev-server` / `--port` 分支 + 3 个 import）
  src/invocation.ts                               （改：`--dev-server` 加入只读清单）
  scripts/verify-m5.1-query.ts                    （新增：AT2.7 Hard Test + 正控 + 隐私负控 + 四道闸）
  scripts/kernel-tests-memory.ts                  （改：**追加**两条断言，锁住 `--dev-server` 必须判为只读）
  package.json                                    （改：只新增 "m5.1:query:verify"）
  docs/苏沐薇-使用说明.txt                        （改：登记 `--dev-server`；已 `pnpm doc:sync`）
  artifacts/m5.1/query-negative-control.json      （新增：整库快照前后 + 量具自检 + 闸位快照）
  docs/m5.1/WP2-Handoff.md                        （本文件）
  docs/architecture/README.md                     （改：登记 m5.1:query:verify 与 WP2 文档）

Tests（全部 exit 0）:
  pnpm typecheck                → 0
  pnpm m5.1:query:verify        → **56 通过 / 0 失败**（真实 loopback HTTP，8 个端点全打）
  pnpm m5.1:test                → 50 通过 / 0 失败
  pnpm kernel:test              → 26 通过 / 0 失败
  pnpm m3.5:test                → 30 通过 / 0 失败
  pnpm m3:verify                → exit 0（改 trace-store 的既定门）
  pnpm m3.5:verify              → exit 0（同上）
  pnpm eval:telemetry           → exit 0（同上）
  pnpm m4:test                  → 243 通过 / 0 失败（CLI 参数改动 + package.json 静态锁）
  pnpm m4.5:test                → exit 0（CLI 参数改动）
  pnpm m5:test                  → 30 通过 / 0 失败
  pnpm doc:check                → exit 0（桌面投影与权威源一致）

  CLI 路径端到端（**沙箱库 + 假 Key**，不碰真实库、不联网）：
    OPENAI_API_KEY=dummy  PGLITE_DATA_DIR=<temp>  tsx src/main.ts --dev-server --port 8791
    → 日志："模型连通性检查已跳过（只读命令）"
    → 6 个无参端点 + POST → 405 实测通过；/dev/query/health 返回真实报告
      （status=ok · migrationVersion=6 · seedVersion=3 · integrityOk=true）

Evidence: artifacts/m5.1/query-negative-control.json
  hardGateVerdict = PASS · queryMutationCount = 0（**40 张表 / 31 行逐字段相同**）
  detectorSelfCheck.detectorResponded = true（故意写一次 → character_action_events +
    character_action_sequence_counters 两张表变化）
  privacy：memorySentinelLeaks = [] · actionArgumentLeaks = []
  guardChecks：nonLoopbackRejected=true · POST=405 · unknownRoute=404 · limit=0→400 ·
    limit=abc→400 · 未知参数→400 · status=green→400

Known issues（四条；前两条是本 WP 抓到并已修的**真实缺陷**）:
  1. 【已修】**派生耗时被绕开**：`query-service` 曾经自己写 `finishedAt - requestedAt`，
     而契约层明写 `developerDurationMs` 是"派生字段的**唯一**算法"。后果是当账本的
     `createdAt` 用**真实时钟**、fixture 用固定时刻时，`durationMs` 变成一个**负数**
     （实测 `-10351909773`）—— 而当时**所有**断言都是绿的。
     修法：改用 `developerDurationMs()`；并在门里**新增**一条断言
     "所有派生耗时要么缺省、要么非负"（把它变成可测量的形状）。
  2. 【已修】**未知查询参数曾经静默通过**：handler 只读自己认识的键，于是
     `?orderBy=x` 在到达契约层的 `rejectUnknownKeys` **之前**就被丢掉了，回 200。
     修法：路由表新增 `allowedQueryParams` 白名单，在 HTTP 层先拒（`developer_query_unknown_field`）。
  3. **执行账本的列表查询没有 cursor**（`ActionLedgerQuery` 只有 limit）。
     本 WP 如实回 `hasMore: false`，**没有**编一个游标 —— 编出来的游标会在下一页
     悄悄跳过记录。AT2.3 的"有界分页"要求落在 trace 上（那条是本 WP 新加的 keyset 分页）。
     执行侧的 keyset 分页属后续 WP（或独立里程碑）。
  4. **`--dev-server` 仍然要求 `OPENAI_API_KEY` 存在**（只跳过网络探测，不跳过 Key 检查）。
     这是刻意的：`isReadOnlyInvocation` 只回答"要不要发那次探测"，不回答"要不要 Key"
     （与 `--kernel-status` 等既有只读命令一致）。本环境 Key 未设置（F-2），
     因此 CLI 端到端用的是**假 Key + 沙箱库**。

Interfaces exposed to next WP（WP3 直接消费）:
  · `createDeveloperQueryService(options): DeveloperQueryService`
      options = { db, characterId, owner, runtimeId?, identitySnapshot?, runtimeCapabilities?, now? }
  · `startDeveloperQueryServer(options): Promise<DeveloperHttpServer>`
      options = { service, characterId, host?, port?, prefix? } → { url, host, port, close }
  · `developerQueryRoutePatterns(prefix?)` —— 端点清单（唯一来源是路由表）
  · `buildDeveloperQueryRoutes` / `matchDeveloperQueryRoute` / `unwrapLookup`
  · `isLoopbackHost` / `isLoopbackAddress` / `statusOfError` / `DEFAULT_DEVELOPER_HTTP_PORT`
  · `HttpError`（HTTP 层自有错误类型；领域错误仍走 `KernelError.kind` 映射）
  · `listTracePage(db, query)` —— 只读 keyset 分页（`(started_at, trace_id)` 游标，
    走既有 `character_traces_recent` 索引）

Do not modify（WP3–WP9 只消费，不重定义）:
  · `TraceWriter.recent()` 的语义（`--inspect` 在用它；新分页是**另一个**函数）
  · `MemoryStatsDto` 的九个数与它们背后的**那批函数**（AT2.4：那是唯一一套 Memory 状态判断）
  · `integrityOk` 的来源（只能来自 `memoryIntegrityProblems()`）
  · `attempted` 的来源（账本 `ACTION_STARTED` 的存在性，不是"顺手填 true"）
  · `verification` 的默认值（`not_attempted`；账本没有核验事件之前不许升格为 `failed`/`verified`）
  · `intent` 的 `not_available`（没有意图分类器就是没有；STOP 条件 7）
  · 四道闸（显式请求 / 只绑 loopback / 逐请求验对端 / 只允许 GET）
  · `unwrapLookup` 的语义：`character_mismatch` 也回 404（存在性不可探测）
  · HTTP 层的 `allowedQueryParams`（去掉它，"传了没生效"会回来）
  · 冻结区：`contracts/{memory,trace}.ts` / `migrations.ts` / `kernel/app/memory/**` /
    `memory-validator.ts` / `memory-store.ts` reducer 语义 / `infrastructure/telemetry/**` /
    `src/character/苏沐薇.ts` / prompt 基线

Next WP prerequisites（WP3 Developer Control API 必须做到）:
  1. 命令只能来自 `CONTROL_COMMAND_FACTS` 白名单（`RUN_DIAGNOSTIC` / `RUN_AUDIT`），
     未知命令 fail closed；`FORBIDDEN_CONTROL_COMMANDS` 是**禁止**清单（AT3.5），不是"还没实现"。
  2. `ControlResult` 必须过 `assertControlResult()`；五档（AT3.6）必须**两两可区分**，
     且 `verified` **绝不**由 `executed` 推导。
  3. 两个命令今天**都是只读**（`mutatesDomain === false`）。要加会改变领域的命令，
     **不是**改那个字段，而是让它走 Validation → Policy → Domain Command →
     `ActionGateway` → Event Ledger（否则触发 STOP 条件 14）。
  4. `idempotencyKey` 必填；同一 key 重放不得产生第二次副作用（AT3.3）。
  5. `dryRun` 只能对声明了 `supportsDryRun` 的命令生效（AT3.2）。
  6. **WP3 HARD GATE**：执行结果必须与 Ledger / 权威状态一致 ——
     请照本 WP 的形状写：真实 HTTP + **前后逐字段快照** + **量具自检**（故意写一次必须变）。
  7. 复用本 WP 的 HTTP 层与四道闸（`allowedQueryParams` 白名单也要照做，
     否则"传了没生效"会以同样的方式回来）。
```
