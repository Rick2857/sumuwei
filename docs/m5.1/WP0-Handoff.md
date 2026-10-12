# WP0 Handoff — Repository Reconnaissance & Baseline

> 计划书要求的交接单。**下次 execution（WP1）先读这份**，再读
> [`M5.1-Repository-Map.md`](./M5.1-Repository-Map.md)（§1 组件 / §2 既有开发者平面 / §3 接在哪里 / §5 F 系列 / §7 R 系列）
> 与 [`M5.1-Authority-Map.md`](./M5.1-Authority-Map.md)（§2 禁止方向）。
> **不要重新探索仓库。**

```text
Completed WP: WP0 — Repository Reconnaissance & Baseline（结论 PASS）

Changed:
  .gitignore                              （改：为 artifacts/m5.1/ 追加日志规则，与 m4.1 / m4.5 / m5 同一处理）
  docs/m5.1/M5.1-Execution-Plan.md        （新增：用户原文（逐字）+ DSH 修订记录 R-1~R-7 + 批次表）
  docs/m5.1/M5.1-Repository-Map.md        （新增：组件定位 / 既有开发者平面 / 接入点 / 预留钩子 / F-1~F-11 / D 系列 / R-1~R-8 / Scope Fence）
  docs/m5.1/M5.1-Authority-Map.md         （新增：Capability|Authority|Projection|Provider + 禁止方向 + 冻结声明）
  docs/m5.1/WP0-Handoff.md                （本文件）
  docs/architecture/README.md             （改：登记 M5.1 文档）
  artifacts/m5.1/baseline.json            （新增：基线 + 前置 + testsNotRun + deferredIssues + p0Risks）
  artifacts/m5.1/wp0-baseline.log         （新增：五条基线命令的逐字 stdout，1124 行）

Tests（全部 exit 0，非破坏性；逐字日志在 wp0-baseline.log）:
  pnpm typecheck      → exit 0
  pnpm kernel:test    → 26 通过 / 0 失败
  pnpm kernel:verify  → 25 通过 / 0 失败（走沙箱库，未碰真实库）
  pnpm m3.5:test      → 30 通过 / 0 失败（含 FC-T08 prompt 逐字节）
  pnpm m4:test        → 243 通过 / 0 失败
  只读已落盘证据（**未重跑**，重跑会重写历史证据）:
    artifacts/m4.5/gate-results.json → G12 / G13 / G14 全 PASS（2026-09-17T08:02:16Z）
    artifacts/m5/gate-results.json   → hardGateVerdict = PASS（2026-09-17T11:19:09Z）
  testsNotRun: 全部会写 artifacts/** 的门 + m4.5:ci + m4.5:ci:full + 两条 Live Smoke（理由见 baseline.json）

Evidence: artifacts/m5.1/baseline.json
          artifacts/m5.1/wp0-baseline.log

Known issues（全部登记，**一条都没修** —— G-05 明令不得顺手修）:
  F-1  **仓库里没有任何 HTTP / server / 路由基础设施**（实测 grep 零命中）。
       → 用户裁定：仓库内新增最小只读 HTTP 服务（node:http，零新依赖，仅 loopback，
         dev-only 开关），WP5 页面为极简静态 HTML。实现属 WP2/WP5。
  F-2  **OPENAI_API_KEY 未设置**（.env 只有 OPENAI_EMBEDDING_API_KEY；进程环境亦未设置）
       → 本环境 Live Smoke = not-run，**不得记为 PASS**。WP8/WP9 的前置缺口。
  F-3  TraceWriter.recent() 无 cursor、无过滤、上限 200 → WP2 需 append-only 追加只读列表查询；
       character_traces_recent (character_id, started_at desc) 索引已建，正好支持该游标键。
  F-4  执行真相今天只有 accepted / executed / status；**没有 attempted、没有 verified**，
       账本里也没有"适配器被调用"与"后置条件被核验"的独立事件。
       → WP1 必须在契约层如实表达阶梯（verification 用四态枚举，允许 not_attempted），
         **禁止伪造 verified: true**；真正的核验能力属 WP3。
  F-5  CLI（kernel:status / memory:stats / memory:audit / action:* / seed-status / inspect / dump-prompt）
       已经是**事实上的开发者平面** → Query API 必须是它们的统一投影，不得重新实现状态判断（AT2.4）。
  F-6  src/observability/ 是**空目录**（0 文件）→ WP4 裁定（用它，或出 ADR 说明端口为何住在 infrastructure/telemetry）。
  F-7  TelemetryPort **已经存在**（Noop + Phoenix + 手写 OTLP/protobuf）→ M5.1 **不新建第二个观测端口**；
       AT4.6 由 WP4 复用既有端口或出 ADR（见执行计划 R-5）。
  F-8  稳定序列化在 src/kernel/ 内**有四份**实现 → WP1 **复用** contracts/memory.ts 的
       stableMaterial + memoryDigest（contracts/recall.ts 已是这样做的），**不新增第五份**；
       并加交叉一致性测试把漂移变成可检测失败。"统一四份"记为 D-10（另一个里程碑）。
  F-9  TraceStepKind 末尾有 | (string & {}) 逃生口 → "step kind → stage" 无法在类型上穷尽；
       WP1 的映射须用 Partial<Record<...>> + 'unknown' 兜底，且**不许去掉逃生口**
       （去掉它要动 contracts/trace.ts 及 m3:verify + m3.5:verify + eval:telemetry + eval:otlp）。
  F-10 真实链路里 intent 恒为 current_fact、target 恒为 none（M5 局限 1）→ DTO 必须允许
       { status: 'not_available', reason }；**不得为实现意图分类器而扩大 scope**（STOP 条件 7）。
  F-11 MIGRATIONS 到版本 6；M5.1 **不需要任何迁移**。某个 WP 若发现需要迁移，那是 STOP 信号。

Interfaces exposed to next WP（WP1 直接消费）:
  · 权威地图（冻结）：docs/m5.1/M5.1-Authority-Map.md 的 16 行 + §2 禁止方向
  · 组件锚点（带行号）：Repository Map §1（TurnGateway / Trace / OTLP / Event Ledger /
    Execution Ledger / Memory Stats / memory-integrity / CLI）
  · 预留钩子表：Repository Map §4（哪些能复用、哪些必须新建）
  · F 系列（11 条实测发现）与 R 系列（8 条 P0 风险）
  · 修订记录 R-1~R-7（docs/m5.1/M5.1-Execution-Plan.md §2）：
      R-1 文档落点 = docs/m5.1/（不是 docs/milestones/m5.1/）
      R-2 开发者平面 = 仓库内最小只读 HTTP（node:http，零新依赖，loopback，dev-only）
      R-3 WP0 baseline 非破坏性；full regression 留给 WP9
      R-4 **不新建** kernel/dev|query|control 三个目录
      R-5 **不新建**第二个观测端口
      R-6 序列化复用 stableMaterial + memoryDigest
      R-7 无 Web stack ⇒ minimal HTML / minimal client，不引入前端依赖

Do not modify（M5.1 全程只消费，不许顺手改）:
  · 冻结区：src/kernel/app/memory/** / policies/memory-validator.ts / memory-store.ts 的 reducer 语义 /
    contracts/memory.ts 的事件 payload / 迁移 0001–0006 / src/character/苏沐薇.ts /
    evals/fixtures/m3.5/prompt-baseline.txt
  · contracts/trace.ts（改它要连带 m3:verify + m3.5:verify + eval:telemetry + eval:otlp）
  · src/infrastructure/telemetry/**（WP4 只做追加式映射；端口不新建、不搬家）
  · src/kernel/action/** 的既有语义（accepted / executed / idempotency / ActionGateway）
  · src/kernel/recall/** 的既有语义（exclusionReasonForStatus / 宽召回适配器 / applyContextReality）
  · package.json 既有脚本的语义（WP1 只**新增** m5.1:test）
  · artifacts/{m4-acceptance,m4.1,m4.5,m5}/**（历史证据；被重新生成时用 git checkout -- 还原）

Next WP prerequisites（WP1 Developer Plane Contracts）:
  1. 只交付**契约**：不实现 DeveloperQueryService、不写 HTTP、不写页面、
     不改 flags.ts / main.ts / turn-gateway.ts、不改迁移、不加依赖、不加 m5.1:gates。
  2. 三个新契约文件落 src/kernel/contracts/（developer-query.ts / developer-control.ts / observability.ts）
     ＋ contracts/index.ts 加 3 行 re-export 与文件头登记。**不新建 kernel/dev|query|control 目录**（R-4）。
  3. 名字全部带前缀（Developer* / Observability* / Control* / TELEMETRY_*），避免与既有导出撞名；
     `pnpm typecheck` 是判据。
  4. ControlResult 必须**没有** success: boolean（AT1.2 明令），且 execution-state 五档
     （rejected / accepted / attempted / executed / verified）必须互不相等、可被 assertControlResult 区分。
  5. verification 用四态枚举（verified / failed / not_attempted / not_applicable），**不是 boolean**；
     attempted / executed 的语义与证据来源必须写死在 evidenceOf 里（F-4）。
  6. 敏感数据政策是 **key 级白名单**；值级哨兵仍归 app/memory/memory-trace.ts 的
     assertNoMemoryContentInTrace，**不删、不搬、不改、不重复实现**。
  7. 新增 pnpm m5.1:test，证据写 artifacts/m5.1/wp1-contracts.json
     （形状对齐 artifacts/m5/wp1-contracts.json）。
  8. 跑门：typecheck / m5.1:test / kernel:test / kernel:verify / m4:test / m3.5:test / m5:test；
     其中 **m5:test 跑完后必须 `git checkout -- artifacts/m5/wp1-contracts.json`** 还原 M5 历史证据
     （AGENTS §7），真实计数写进 WP1 handoff。
```

---

## Batch A 的边界

WP0 **到此 STOP**（计划书 §0 EXECUTION RULE：`Inspect → Implement → Target Tests → Evidence → Commit → STOP`，
"不得在完成 WP 后自行开始下一 WP"）。本 Batch 的 WP1 部分在同一个 execution 内继续，
因为计划书把 **Batch A = WP0 + WP1**。
