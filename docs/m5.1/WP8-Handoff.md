# WP8 Handoff — Natural-Language E2E & Production-copy Live Smoke

> 计划书要求的交接单。**下次 execution（WP9）先读这份**，再读
> [`WP7-Handoff.md`](./WP7-Handoff.md)（含**措辞纪律**与 `finalGateMatrix` 映射）。
> **不要重新探索仓库。**

```text
Completed WP: WP8 — Real E2E & Production-copy Smoke（结论 PASS）
              E1–E5 真实链路 22 项断言全过；E6 + E6-Live 真实模型跑通

Changed:
  scripts/verify-m5.1-e2e.ts                  （新增：E1–E6 六段，含真实模型段与副本段）
  package.json                                （改：新增 "m5.1:e2e:verify"）
  scripts/m5.1-gate-results.ts                （改：注册 M51-G8 / M51-G9 两道**硬门**，
                                              并把 finalGateMatrix 里两行"WP8 待产出"改成由 M51-G8/G9 回答）
  artifacts/m5.1/nl-e2e-evidence.json         （新增：e2eVerdict = PASS，modelExercised = true，notRun = []）
  artifacts/m5.1/live-smoke-evidence.json     （新增：liveSmokeVerdict = PASS，productionUntouched = true）
  artifacts/m5.1/gate-results.json            （重新生成：十一门 + 一条 spike）
  docs/m5.1/WP8-Handoff.md                    （本文件）

Tests（全部 exit 0）:
  pnpm m5.1:e2e:verify  → **22 通过 / 0 失败**（真实模型，非干跑）
  pnpm m5.1:gates       → **Hard Gates：PASS**（十一门全 PASS；三项量具自检全过）
  pnpm typecheck        → exit 0

Evidence:
  artifacts/m5.1/nl-e2e-evidence.json → e2eVerdict = PASS
    E1 真实 prompt 组装（`modelExercised: true`，7 个 step，prompt 里确有 memory 段）
    E2 **三处投影互相对齐** —— 这是本 WP 的核心判据：
         packet.sourceRefs == trace.selectedMemoryIds == Query API 的 DTO
         三者都是同一个 id：mem:00000000-0000-4000-8000-000000000001:person_fact-071d9d0ea33d4075
    E3 负控：主语是陌生人 → selectedCount = 0（不是"召回被关掉"，是真的没有证据）
    E4 执行真相：attempted=true / executed=true / verification=not_attempted；
         **参数只暴露 key，不暴露 value**（argumentValuesLeaked = false）
    E5 控制面走真实 HTTP → 200 verified / verified，report 与 Query API 对得上
  artifacts/m5.1/live-smoke-evidence.json → liveSmokeVerdict = PASS
    hasApiKey = true · productionUntouched = true
    replyLength = 30 · modelDurationMs = 1512 · promptLength = 2400
    traceReadableViaQueryApi = true · stepCount = 7
    真实库 data/pglite 只被复制，**从不打开**（cpSync → 临时目录 → 用完删掉）

    ⚠️ E6 的 `migrationVersion` **量的不是真实库**（WP9 期间源码核实）：
       迁移闸只拦"有待应用迁移且未放行"的库，而沙箱路径被放行 →
       harness 会把待应用迁移施加到**副本**上，所以它报 v6。
       当时真实库其实是 **v5**（2026-09-17 首次 apply 时日志明写 `5 → 6`）。
       E6 的实质结论（真实历史在副本上、真实库未动、真模型）**不受影响**，
       受影响的只是对那个版本号的解释。详见 `M5.1-Gate-Decision.md` §6.1。

  ⚠️ 上面这些数字取自证据文件**当前**的字段值。WP9 在修完 `src/invocation.ts`
     的末尾换行后**重跑过一次** E2E（因为那是 WP8 之后的最后一次源码改动），
     所以证据文件里是 WP9 那一次的值。WP8 当次 stdout 里另有长度/耗时数字，
     但**没有落进证据文件**，因此本交接单不引述它们 —— 只引述可复核的字段。

  Level 1 证据（真实外部结果）：E1 / E6-Live 的模型回复
  Level 2 证据（账本）：character_traces / character_action_events / trace steps

Interfaces exposed to next WP（WP9 直接消费）:
  · `pnpm m5.1:e2e:verify` → 上面两个证据文件（**判据是字段，不是文件存在**）
  · M51-G8 读 `e2eVerdict`；M51-G9 读 `liveSmokeVerdict`
      —— 两道都是**硬门**，任一不是 PASS 会把 hardGateVerdict 降级为 FAIL
  · 副本 smoke 的形状（复制 → 沙箱指向临时目录 → 跑 → 比对真实库 mtime）
      可直接复用为 WP9 的 Full Regression 形态

⚠️ WP7 交接单前提 1 的**如实更正**（必须写进最终报告，不许悄悄改）:
  WP7 交接时写的是"本机没有 OPENAI_API_KEY，因此 Production-copy Live Smoke
  **只能标 not-run**"。**用户在 WP8 执行期间提供了 Key**，所以 E1 与 E6-Live
  **真的**打了模型，`notRun = []`。这不是把 not-run 改写成 PASS，而是前提变了：
    · 若没有这个 Key，正确做法仍然是把 E6-Live 标 not-run（WP7 的判断没错）；
    · 现在有 Key，标 PASS 的依据是 Level 1 的真实模型回复 + Level 2 的 trace。
  Key 只落在 `.env`（已 gitignore，`.gitignore:3`），**从未提交、本报告不记录其值**。

⚠️ 措辞纪律（延续 WP7，WP9 的 Gate-Decision 必须继续遵守）:
  AT6.1 只允许被引述为 claim + claimLimit 两句话：
    claim      : OTLP protocol compatibility verified
    claimLimit : specific backend deployment not exercised
  **禁止**写成 "Langfuse/OpenLIT integration PASS"。

Do not modify（WP9 只消费）:
  · M51-G8 / M51-G9 的判据字段名（`e2eVerdict` / `liveSmokeVerdict`）
  · 汇总器的三条性质：只读已落盘证据 / 缺文件 = not-run / spike 不参与总判定
  · 冻结区不变：`contracts/{memory,trace,recall}.ts` / `migrations.ts`（仍 v6）/
    `kernel/app/memory/**` / `memory-store.ts` reducer 语义 /
    `infrastructure/telemetry/**`（WP4 边界）/ `src/character/苏沐薇.ts` / prompt 基线

Known Issues（如实，不修 —— G-05 禁止在 M5.1 修 M5 已知局限）:
  1. `nl-e2e-evidence.json` 的 E1/E6-Live 依赖真实 Key；没有 Key 的环境重跑会
     把这两段标 not-run（脚本会如实降级，不会假绿）。
  2. 真实模型段每次重跑都会打 2 次真实调用（E1 + E6-Live），**有成本**；
     WP9 重跑全量回归时不要为了"多测几次"重复跑它。

Next WP prerequisites（WP9 Full Regression & Final Gate）:
  1. `finalGateMatrix` 只剩**一行**标"WP9 待产出"：Full Regression
     （`artifacts/m5.1/regression-evidence.json`）—— 必须在
     `m5.1-gate-results.ts` 里注册成硬门（那时才参与总判定）。
  2. Full Regression 必须包含：M5.1 全部七道验收入口 + `pnpm m4.5:ci`（**退出码 0**）
     + `pnpm m5.1:gates`；**任何既有 Hard Gate 退化 = M5.1 FAIL**，
     不得解释为"与 M5.1 无关"。
  3. 出八份最终文档：Repository-Map / Authority-Map / Architecture /
     Implementation-Report / Test-Report / OSS-Audit / Known-Limitations / **Gate-Decision**。
     其中 Gate-Decision 必须用上面那两句 claim 措辞，且必须保留 WP7 前提 1 的如实更正。
  4. 跑门期间若重新生成了历史证据（`artifacts/m4.5/**`、`artifacts/m5/**`），
     提交前用 `git checkout -- <path>` 还原（AGENTS §7）。
```
