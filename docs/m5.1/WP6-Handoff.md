# WP6 Handoff — OSS Integration Audit & Spike

> 计划书要求的交接单。**下次 execution（WP7）先读这份**，再读
> [`M5.1-OSS-Audit.md`](./M5.1-OSS-Audit.md)（§6 裁定汇总 / §7 Scope Fence / §8 下次入口）
> 与 [`../adr/ADR-037`](../adr/ADR-037-observability-backend-boundary.md)~[`ADR-041`](../adr/ADR-041-sandbox-executor-boundary.md)。
> **不要重新探索仓库。**

```text
Completed WP: WP6 — OSS Integration Audit & Spike（结论 PASS：12 条裁定全部有落点与理由）

Changed（**只有文档 + 一个 spike 脚本**；生产代码一行未动）:
  docs/m5.1/M5.1-OSS-Audit.md                        （新增：方法与证据强度 / 五类候选 / 裁定汇总 / Scope Fence / 下次入口）
  docs/adr/ADR-037-observability-backend-boundary.md （新增：Langfuse ADAPT / OpenLIT REFERENCE / Phoenix ADOPT）
  docs/adr/ADR-038-memory-infra-boundary.md          （新增：Cognee REJECT / Graphiti REJECT / 外部后端 REFERENCE）
  docs/adr/ADR-039-mcp-tool-adapter-boundary.md      （新增：MCP Tool Adapter REFERENCE / 发现权与 Runtime REJECT）
  docs/adr/ADR-040-durable-workflow-boundary.md      （新增：Temporal 编排 REFERENCE / Execution Truth REJECT）
  docs/adr/ADR-041-sandbox-executor-boundary.md      （新增：沙箱 Executor REFERENCE / 领域 Authority REJECT）
  scripts/spike-m5.1-otlp.ts                         （新增：AT6.1 的最小 spike —— 只认 OTLP 的本地接收端）
  package.json                                       （改：只新增 "m5.1:spike:otlp"）
  artifacts/m5.1/oss-spike-otlp.json                 （新增：spike 证据）
  docs/m5.1/M5.1-Execution-Plan.md                   （改：§2 追加 R-8 / R-9 两条修订记录）
  docs/m5.1/WP6-Handoff.md                           （本文件）
  docs/architecture/README.md                        （改：登记审计、五条 ADR、spike 脚本）

Tests（WP6 没有"测试"，只有一次 spike；下面两条都是 exit 0）:
  pnpm m5.1:spike:otlp → **10 通过 / 0 失败**，spikeVerdict = PASS
  pnpm typecheck       → exit 0

Evidence: artifacts/m5.1/oss-spike-otlp.json
  protobuf 路径：POST /v1/traces · application/x-protobuf · 3 个 span · 导出记录 ok=true
  接收端逐字段验收：resourceSpans=1 · Resource.attributes 含 service.name + session.id ·
    ScopeSpans=1 · InstrumentationScope.name · 每个 span 的 trace_id 16B / span_id 8B ·
    name · start_time_unix_nano(fixed64) —— **零问题**
  JSON 路径：同样通过（traceId 32 位 hex / spanId 16 位 hex）
  量具自检：错 Content-Type → 415；截断 protobuf → 400（detectorResponded = true）

裁定汇总（详见审计 §6；每条都有 Landing Target / Authority Boundary /
Replacement Strategy / Failure Isolation / Future Milestone 五项）:
  ADOPT     Phoenix（既有，不动）
  ADAPT     Langfuse（协议已通；差一张 LLM 语义属性映射表）
  REFERENCE OpenLIT · 外部记忆后端（类别，门在 ADR-027）· MCP Tool Adapter ·
            Temporal 编排层 · 沙箱 Executor Provider
  REJECT    Cognee（争记忆主权）· Graphiti（同类别，**证据强度低**）·
            MCP 作为能力发现权 / M5.1 内 Tool Runtime ·
            Temporal 作为 Execution Truth · 沙箱持有领域 Authority

Known issues（四条）:
  1. **没有一个第三方被真的部署过**。Langfuse / OpenLIT / Cognee / Temporal 都没有在本机起容器，
     因此所有"能不能接"都是**文档级 + 协议级**结论。唯一的实跑证据是 OTLP 协议 spike。
     这条必须留在报告里，免得下次有人把 ADAPT 当成"已经接上了"。
  2. **Graphiti 的裁定证据强度低**：本轮未取得一手页面（检索只命中同话题聚合页），
     REJECT 依据是**类别推断**。要改判，先补一手文档 + 一次 spike（审计 §2.2 已标注）。
  3. **Langfuse 的 LLM 语义映射表不存在**：trace 进得去，但 generation/span 的详情视图
     不会自动完整。ADR-037 把"面板里真的看到了那条 trace"写成了准入判据。
  4. **沙箱这一条是类别级审计**（计划书只说"Sandbox"，没点名项目），
     因此 ADR-041 的判决对象是"这一类执行后端"，不是某个具体产品。

Interfaces exposed to next WP（WP7 直接消费）:
  · `docs/m5.1/M5.1-OSS-Audit.md` §6 的裁定表（12 行，含落点与里程碑）
  · 五条 ADR 的"Future Milestone"小节 = 每个候选的准入判据（下次别再从头评估）
  · `pnpm m5.1:spike:otlp` 的接收端实现（`scripts/spike-m5.1-otlp.ts` 里的
    `startOtlpReceiver` / `validateOtlpProtobuf` / `validateOtlpJson`）——
    **将来接任何 OTLP 后端时可以直接复用它做"对面收得下吗"的预检**

Do not modify（WP7/WP8/WP9 只消费）:
  · 五条 ADR 的裁定（改裁定 = 新的 ADR + 一条"为什么之前错了"，不要就地改）
  · `M5.1-OSS-Audit.md` 里标注了"证据强度低"的结论（Graphiti）**不许**被引用成确定事实
  · 审计 §7 的 Scope Fence：本轮没有新增依赖 / 没有新增服务 / 没有实现 MCP Runtime
  · 冻结区不变：`contracts/{memory,trace,recall}.ts` / `migrations.ts` / `kernel/app/memory/**` /
    `memory-store.ts` reducer 语义 / `infrastructure/telemetry/**`（WP4 的边界）/
    `src/character/苏沐薇.ts` / prompt 基线

Next WP prerequisites（WP7 Measurement & Gate Harness）:
  1. WP7 要做的是 **`pnpm m5.1:gates`**：**只读已落盘证据**的汇总器
     （照 `scripts/m4.5-gate-results.ts` / `scripts/m5-gate-results.ts` 的形状），
     **文件不存在 = not-run，不是 PASS**。
  2. 它要汇总的证据文件已经**全部就位**（都在 `artifacts/m5.1/`）：
     `baseline.json` · `wp1-contracts.json` · `query-negative-control.json` ·
     `control-execution-truth.json` · `observability-evidence.json` · `leakage-evidence.json` ·
     `page-evidence.json` · `oss-spike-otlp.json`
     以及待产出：`measurement-negative-controls.json`（WP7 自己的两样负控）、
     `gate-results.json`（汇总器输出）。
  3. AT7.2 的四个主动注入（fake selectedMemoryId / fake executed=true / query-side mutation /
     secret in telemetry / unknown control command）**在 WP1–WP5 已经各有一半**，
     WP7 要做的是把它们**集中成一份可复核的负控证据**（而不是重新发明）。
     已经存在的可复用实现：
       · 假 selectedMemoryId → `scripts/verify-m5.1-observability.ts` 的 `tamperedSpans`
       · 假 executed=true   → `scripts/verify-m5.1-control.ts` 的 `tampered`
       · query-side mutation → `scripts/verify-m5.1-query.ts` 的"故意写一次，快照必须变"
       · secret in telemetry → `scripts/verify-m5.1-observability.ts` 的 `poisoned`
  4. **门汇总器本身也要被验证**（INV-M45-06）：删掉一个证据文件 → 该门必须是 `not-run` 而**不是** PASS；
     这一条要成为 WP7 自己的断言。
```
