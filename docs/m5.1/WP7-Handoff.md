# WP7 Handoff — Measurement & Gate Harness

> 计划书要求的交接单。**下次 execution（WP8 + WP9）先读这份**，再读
> [`WP6-Handoff.md`](./WP6-Handoff.md)（12 条裁定与四条已知局限）。
> **不要重新探索仓库。**

```text
Completed WP: WP7 — Measurement & Gate Harness（结论 PASS；量具自检三项全过）

Changed:
  scripts/verify-m5.1-measurement.ts        （新增：五个检测器的正控 / 负控 / 恢复三段式）
  scripts/m5.1-gate-results.ts              （新增：门汇总器 + **claim 上限**机读字段 + 三项量具自检）
  package.json                              （改：新增 "m5.1:measurement:verify" 与 "m5.1:gates"）
  artifacts/m5.1/measurement-negative-controls.json （新增）
  artifacts/m5.1/gate-results.json          （新增：九道门 + 一条 spike + FINAL GATE MATRIX 映射）
  docs/m5.1/M5.1-OSS-Audit.md               （改：§1.5 加入**措辞纪律**（见下））
  docs/m5.1/WP7-Handoff.md                  （本文件）
  docs/architecture/README.md               （改：登记 m5.1:measurement:verify 与 m5.1:gates）

Tests（全部 exit 0）:
  pnpm m5.1:measurement:verify → **16 通过 / 0 失败**（五个检测器全部会响）
  pnpm m5.1:gates              → **Hard Gates：PASS**（九道门全 PASS；三项量具自检全过）
  pnpm typecheck               → exit 0

Evidence:
  artifacts/m5.1/measurement-negative-controls.json → measurementVerdict = PASS
    正控 5 条（合法输入 → 检测器安静）· 负控 5 条（注入 → 检测器必响）· 恢复 5 条（放回真实现 → 重新安静）
      fake selectedMemoryId   → Trace Truth 报出（"与 trace 的实际不符"）
      fake executed=true      → 执行真相报出（"权威证据为否"）
      query-side mutation     → 只读快照报出（conversation_events 变了）
      secret in telemetry     → 哨兵扫描报出（sk-M51-MEASUREMENT-SECRET）
      unknown control command → 白名单报出（rejected + handler 调用 **0 次**）

  artifacts/m5.1/gate-results.json → hardGateVerdict = PASS
    M51-G1 契约 52 · M51-G2 Query(硬) · M51-G3 Control(硬) · M51-G4 Trace Truth(硬) ·
    M51-G5 零泄漏(硬) · M51-G6 页面独立性 · M51-G7 量具与负控(硬) ·
    M5-G 继承(硬) · M45-G 继承(硬，G12/G13/G14 全 PASS)
    量具自检：缺证据 → not-run；**缺一道硬门会把总判定降级为 FAIL**；spike 不算门

Interfaces exposed to next WP（WP8/WP9 直接消费）:
  · `pnpm m5.1:gates` → `artifacts/m5.1/gate-results.json`
      `gates[]`（九道门，含 `hardGate` 与 `why`）/ `spikes[]` / `hardGates[]` /
      `hardGateVerdict` / `selfCheck` / **`finalGateMatrix`**（计划书 14 行 → 每行由谁回答）/
      **`claimDiscipline`**
  · `pnpm m5.1:measurement:verify` → 五个检测器的三段式证据
  · `scripts/spike-m5.1-otlp.ts` 里的 `startOtlpReceiver` / `validateOtlpProtobuf` /
      `validateOtlpJson`（接任何 OTLP 后端时可直接复用作"对面收得下吗"的预检）

⚠️ 措辞纪律（用户 2026-09-17 明确要求；**WP8/WP9 的 Gate-Decision 必须遵守**）:
  AT6.1 的 spike **只**允许被引述为：
    claim      : OTLP protocol compatibility verified
    claimLimit : specific backend deployment not exercised
  **禁止**写成 "Langfuse/OpenLIT integration PASS" —— 那两个后端一次都没部署过。
  这条已经**不是靠自觉**：它是 `gate-results.json` 的机读字段，
  且 `pnpm m5.1:gates` 会断言"spike 不参与 hardGateVerdict"与"每条 spike 必须有 claimLimit"。

Do not modify（WP8/WP9 只消费）:
  · 汇总器的三条性质：**只读已落盘证据** / 缺文件 = `not-run` / spike 不参与总判定
  · `finalGateMatrix` 的映射（WP8/WP9 要**填**那三个"待产出"行，不是重画这张表）
  · 五个检测器的判据（要改判据 = 改 WP1–WP5 的对应门 + 重新出证据）
  · 冻结区不变：`contracts/{memory,trace,recall}.ts` / `migrations.ts` / `kernel/app/memory/**` /
    `memory-store.ts` reducer 语义 / `infrastructure/telemetry/**`（WP4 的边界）/
    `src/character/苏沐薇.ts` / prompt 基线

Next WP prerequisites（WP8 Real E2E / Production-copy Smoke + WP9 Full Regression）:
  1. **本机没有 `OPENAI_API_KEY`**（M5.1 Repository Map F-2，WP0 实测）。因此：
       · Scenario E1–E5 若能**离线**跑（用 `--test` 干跑 / 合成轮次），就照实在证据里区分"离线跑过"与"需要模型"；
       · **Production-copy Live Smoke 在本环境只能是 `not-run`** —— 不许写成 PASS。
     这一条请先处理：要么用户提供 Key，要么如实标 not-run（后者更符合本仓库纪律）。
  2. `finalGateMatrix` 里有三行标着"**WP8/WP9 待产出**"：
     Natural-Language E2E（`nl-e2e-evidence.json`）、Production-copy Smoke（`live-smoke-evidence.json`）、
     Full Regression（`regression-evidence.json`）。它们必须落在 `artifacts/m5.1/`，
     并在 `m5.1-gate-results.ts` 里注册成门（那时才参与总判定）。
  3. Scenario E6（Production DB copy）**禁止**对真实库做 destructive smoke：
     只复制、沙箱指向临时目录（照 `verify-m4.5-smoke-live.ts` / `verify-m5-smoke-live.ts` 的形状）。
  4. E1–E5 的判据要用**同一个 trace 的三处投影**互相对齐
     （真实 packet 文本 / trace 的 `selectedMemoryIds` / Query API 的 DTO），
     这正是 M5 的 "Measurement Truth 判据必须是文本级" 的延续。
  5. WP9 的"全量回归"必须包含 `pnpm m4.5:ci`（退出码 0）与 `pnpm m5.1:gates`，
     并且**任何既有 Hard Gate 退化 = M5.1 FAIL**（不得解释为"与 M5.1 无关"）。
```
