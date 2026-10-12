# WP4 Handoff — Observability / OTel Integration

> 计划书要求的交接单。**下次 execution（WP5）先读这份**，再读
> [`WP3-Handoff.md`](./WP3-Handoff.md)（控制面暴露的接口与那五条前置）、
> [`../adr/ADR-036-observability-port-boundary.md`](../adr/ADR-036-observability-port-boundary.md)（AT4.6 的裁定）。
> **不要重新探索仓库。**

```text
Completed WP: WP4 — Observability / OTel Integration
              （结论 PASS；两条 HARD GATE：Trace Truth PASS · Leakage = 0）

Changed:
  src/kernel/contracts/observability.ts            （改：turn/context/model/response 四个阶段补上
                                                      **有真实生产者**的受控理由码；新增
                                                      TELEMETRY_LEGACY_ATTRIBUTE_ALIASES（16 条）+
                                                      TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY（3 条，被钉住）+
                                                      isTelemetryAttributeAllowedIncludingLegacy；
                                                      `_type` 模式 + 两个规范键）
  src/infrastructure/telemetry/taxonomy.ts          （新增：CharacterRunTrace / ControlExecution
                                                      → 规范 span；强制 AT1.4 白名单并把被过滤的键
                                                      **如实报出来**；spanTraceInconsistencies = AT4.4 的量具）
  src/infrastructure/telemetry/port.ts              （改：**追加**可选方法 emitSpans —— AT4.6 的实质，
                                                      见 ADR-036；noop 实现为空操作）
  src/infrastructure/telemetry/phoenix.ts           （改：实现 emitSpans（复用同一个 emit）+ 导出
                                                      wireTraceHexId（32 位 hex traceId 派生））
  scripts/verify-m5.1-observability.ts              （新增：真实两轮 + 四个哨兵 + 两份编码 + 量具自检）
  scripts/kernel-tests-dev-plane.ts                 （改：**追加**一条别名表断言 + 更新两条因 WP4 变化的断言）
  package.json                                      （改：只新增 "m5.1:observability:verify"）
  docs/adr/ADR-036-observability-port-boundary.md   （新增：AT4.6 的决策与备选与否决理由）
  artifacts/m5.1/observability-evidence.json        （新增）
  artifacts/m5.1/leakage-evidence.json              （新增）
  artifacts/m5.1/wp1-contracts.json                 （**刷新**：WP1 契约测试 51 → 52 条）
  docs/m5.1/WP4-Handoff.md                          （本文件）
  docs/architecture/README.md                       （改：登记 m5.1:observability:verify 与 WP4 文档）

Tests（全部 exit 0）:
  pnpm m5.1:observability:verify → **27 通过 / 0 失败**（真实两轮 + 真实导出路径）
  pnpm m5.1:test                 → 52 通过 / 0 失败
  pnpm m5.1:query:verify 56 · m5.1:control:verify 41
  pnpm eval:telemetry 54 · pnpm eval:otlp          （既有观测门：端口补宽之后仍然全绿）
  pnpm kernel:test 26 · m3.5:test 30 · m4:test 243 · m5:test 30 · typecheck · doc:check

Evidence:
  artifacts/m5.1/observability-evidence.json  → traceTruthVerdict = PASS
  artifacts/m5.1/leakage-evidence.json        → leakageVerdict = PASS（totalLeaks = 0）

  Trace Truth（AT4.4）:
    正向：真实一轮 → 8 个规范 span，recall span 的 selected_memory_ids 含那条记忆
    负向：`tokenBudget: 1` → 编译器把记忆段**整段丢掉** → selectedMemoryIds = []
          且 recall span 的 selected_memory_ids = ""（**不含**被丢掉的那条）
          + reasonCode = BUDGET_EXHAUSTED（事实与诊断分开）
    量具自检：把被丢掉的 id 注入 span → 检测器报出（detectorResponded = true）
    unmappedStepKinds = []（真实一轮里每个 step kind 都映射到了已登记阶段）

  Leakage（AT4.5，扫的是**导出的负载**）:
    6 份负载 × 4 个哨兵（api-key / memory-body / system-prompt / 环境密钥）= 0 泄漏
    含 **protobuf 线上字节**（application/x-protobuf）与 JSON 负载两种编码，
    规范路径与控制命令各扫一遍
    量具自检：把 API key 哨兵塞进 span 属性 → 扫描器报出

Known issues（四条，全部是 WP4 实测到并**如实登记**的边界）:
  1. **既有导出路径仍未过白名单**（AT4.1 的实测发现，也是这一 WP 最该记的一条）：
     既有 `phoenix.ts` 发点号键（`character.id` / `context.section.ids` / `error.message`），
     而 WP1 的规范白名单是下划线键名。更关键的是**它从来没过白名单**，
     因此 `error.message`（`message` 是敏感段，规范规则会直接拒）在今天的遥测里能合法出去。
     WP4 的处理：**不重命名 wire 键**（那是破坏性变更，会碎掉 Phoenix 面板与 50 余条
     `eval:telemetry` 断言），而是把差距变成**有限且被钉住**的三样东西 ——
     16 条别名 + 3 个"超出政策"的键（`error.message` / `step.label` / `span.kind.source`，
     断言不许增长）+ **规范路径强制白名单**。
     退出路径见 ADR-036 §5.1/5.2：给既有路径补 `error.code` 并停发自由文本。
  2. **控制命令没有持久 trace**（WP3 Known Issue 1 的延续）：`ControlResult.traceId` 恒缺省。
     因此控制 span 自成一棵**单 span 的 trace**（id 由 commandId 稳定派生），
     `provenance.control_command` 能关联到命令，但**关联不到 character trace**。
     要持久化需要一条新迁移（属独立里程碑）。
  3. **`spanHexId` 的 parent 只能指到根**：规范路径的 step span 都直接挂在根 span 下
     （既有路径也是这个形状），因此"召回的子阶段之间的父子关系"
     （retrieve → eligibility → ranking → selection）今天**表达不出来**。
     AT4.2 允许 recall 拥有子阶段，但真正的嵌套需要 span 之间建树 —— 那要先有
     "谁是谁的父"这个事实，而今天 trace 里没有。
  4. **`error.message` 是唯一真正有风险的键**：它的值来自 `CharacterRunTrace.error`,
     `contracts/trace.ts` 承诺它不含正文，但它是**无界**的自由文本。
     本次实测 0 泄漏（因为我们的 fixture 里没有错误），
     但这是"没触发"而不是"不可能" —— 因此它被列在 outside-policy 里并写进 ADR-036。

Interfaces exposed to next WP（WP5 直接消费）:
  · `mapTraceToCanonicalSpans(trace)` → `{ spans, unmappedStepKinds, filteredAttributeKeys }`
  · `mapControlExecutionToCanonicalSpan(execution)` → 规范 span（developer_control 阶段）
  · `canonicalSpanToTelemetrySpan` / `canonicalSpansToTelemetrySpans(spans, wireTraceId?)`
  · `spanTraceInconsistencies(spans, trace)` —— AT4.4 的量具（返回不一致项）
  · `TelemetryPort.emitSpans?` / `wireTraceHexId` / `traceHexId` / `spanHexId`
  · `TELEMETRY_LEGACY_ATTRIBUTE_ALIASES` / `TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY` /
    `isTelemetryAttributeAllowedIncludingLegacy`

Do not modify（WP5 只消费）:
  · 阶段枚举与"每个阶段必须有生产者"这条纪律（`OBSERVABILITY_STAGE_FACTS`）
  · `stageOfTraceStepKind` 是 trace step → stage 的**唯一**映射
  · AT4.4 的判据：`selected_memory_ids` **只**取自 trace 的 `selectedMemoryIds`
    （编译之后的现实），绝不取自"本来选了谁"的诊断字段
  · `TelemetryPort` 仍然只有一个（AT4.6 / ADR-036）
  · outside-policy 的三个键**不许增长**（要加就先改 ADR 与那条断言）
  · 四道闸、`allowedQueryParams`、控制面白名单（WP2/WP3 的）
  · 冻结区：`contracts/{memory,trace,recall}.ts` / `migrations.ts` / `kernel/app/memory/**` /
    `memory-validator.ts` / `memory-store.ts` reducer 语义 / `src/character/苏沐薇.ts` / prompt 基线

Next WP prerequisites（WP5 Minimal Developer Page）:
  1. **只消费 Query / Control 两个面**（AT5.3/5.4 明令）：禁止直接访问 persistence，
     禁止自己实现控制逻辑。本 WP 与 WP2/WP3 已经把两条 HTTP 面都留在
     `startDeveloperQueryServer` 里（`GET /dev/query/*` + `GET|POST /dev/query/control/*`）。
  2. **feature guard 已经就位**（AT5.1）：`--dev-server` 显式请求才存在 / 只绑回环 /
     逐请求验对端 / 未知参数与未知路由都失败关闭。页面**不要**自己再建一套开关。
  3. 页面要展示的 trace tree 数据来自 `GET /dev/query/traces/:id`（它回的是
     `steps[]` + `contextSectionIds` + `selectedMemoryIds`）。若要展示**阶段**而非 step kind，
     可以在页面侧用 `stageOfTraceStepKind`（**只是显示映射**，不要另建一张表）。
  4. **AT5.7：仓库没有前端框架 ⇒ 极简静态 HTML**（不得引入 SPA 生态）。
     服务里加一个 `GET /` 返回一段内联 HTML 即可；删除整个页面之后
     kernel / agent / 全部核心门必须照常（WP5 的验收）。
  5. 门请照本 WP 形状写：**真实 HTTP + 量具自检**；
     "删掉页面之后一切照常"这条要有可执行的证据（不是一句话）。
```
