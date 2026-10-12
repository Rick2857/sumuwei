# WP9 Handoff — Real Runtime Attribution E2E

> **执行令**：`WP8 = PASS` · `K-32/K-33 = CLOSED` · `K-31 = OPEN / DEFERRED / NON-BLOCKING`。
> **只做 WP9，做完即 STOP；不得开始 WP10。**
>
> **判定**：`pnpm m5.1.1:wp9:verify` = **40 通过 / 0 失败**，但
> **`WP9 = PARTIAL / BLOCKED`** —— 两个 canonical 场景的生产入口不存在（WP9-13 提前授权的结果）：
> `WP9-GAP-1`（E4-A：Known(SYSTEM) 分支）· `WP9-GAP-2`（E8-audit：control 的 durable audit row）。
> 其余全部用真实运行时 + Level 1/Level 2 证据跑通。**`WP10 = NOT AUTHORIZED`**。

```text
Changed Files

  新增
    scripts/verify-m5.1.1-wp9-runtime-e2e.ts   真实运行时 E2E 门（一个进程、一个沙箱库）
    artifacts/m5.1.1/wp9-*.json / .txt         9 份证据（含执行计划冻结名 wp9-e2e.json）
  改动
    package.json                                注册 m5.1.1:wp9:verify
    scripts/m5.1.1-attribution-gate-registry.ts  NON_VERIFIER_SCRIPTS +1（附理由，见 NOTE-3）
    scripts/verify-m5.1.1-k17-consumer-impact.ts 分类表 +1（WP9 门自身归 D）
    docs/m5.1.1/M5.1.1-Execution-Plan.md        R-42（WP9 判定 + 两个 capability gap 登记）
    docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md   本 WP 的 F4
  没有改
    src/**（零行生产代码，含 conversation-store.ts）· migrations.ts · schema（无 v9）
    page.html · developer-query 语义 · 归因语义 · 真库 data/pglite
    artifacts/m5.1/** 与 artifacts/m4.5/**（冻结面：写入 0）

Tests Run

  pnpm typecheck                  EXIT=0
  pnpm m5.1.1:wp9:verify          EXIT=1（= PARTIAL / BLOCKED：0 失败但有 2 处预先授权的 gap）
  pnpm m5.1.1:wp8:verify          EXIT=0   **50 / 0 · WP8 = PASS**（覆盖 0/0/0）
  pnpm m5.1.1:gates               EXIT=0
  pnpm m5.1.1:k17:verify          EXIT=0   15 / 0 · unclassified 0 · hitFiles 52
  pnpm m5.1.1:wp6.1:verify        EXIT=0
  pnpm m5.1.1:wp5.1:verify        EXIT=0
  pnpm m5.1.1:k29:verify          EXIT=0
  pnpm m5.1.1:wp8c1:verify        EXIT=0（K-32 仍 CLOSED）
  pnpm m5.1.1:wp8c2:verify        EXIT=0（K-33 仍 CLOSED）
  pnpm m5.1:measurement:verify    EXIT=0
  冻结面纪律：回归跑动过的 `artifacts/m5.1/measurement-negative-controls.json` 按 C1 从
  **immutable `m5.1-complete`** 还原；`git diff m5.1-complete..HEAD -- artifacts/m5.1 artifacts/m4.5` = 0

Tests Passed

  40 / 40（E2E 门自身）
    WP9-0 canonical E1–E8 与执行计划逐字一致（读出来断言，不是手写清单）
    WP9-3 S1–S6 六行都在 + E→S 映射显式声明（不新增编号）
    WP9-1 真实边界：沙箱非真库 · 真库未打开 · 沙箱 schema v8 · 生产 ingress 覆盖 user/assistant
    E1 真实人类用户 ⇒ Known(USER/<id>) + user_statement/USER_EXPLICIT/user_report + RECORDED
    E2/D01 agent 替发 ⇒ actor_type=user 但 actor=contentOriginator=Known(SERVICE/agent-runner)、Axis B UNCONFIRMED
    E3 character 输出 ⇒ Known(CHARACTER/<canonical>)、character_output/CHARACTER_GENERATION、origin RECORDED
    E3 负控：同 family 但不接线 ⇒ 无信封（family 本身不是证据）
    E5 真实成功执行 ⇒ 5 事件阶梯 + executed=true + actor/executor 独立 + authority=CAPABILITY + Axis B NULL
    E6 真实失败执行 ⇒ ACTION_FAILED 收尾、无 SUCCEEDED、initiator/actor 保留、error.code=validation_failed
    E4-B 诚实 Unknown：无因果证据 ⇒ Unknown(RUNTIME_UNRESOLVED)，不从呈现角色猜
    E7 legacy 行与 RECORDED 行共存；受信读回不制造信封
    E8-L1 真实 control 命令经真实 HTTP 到 verified
    WP9-2 4 条 L1↔L2 关联全部由真实键建立且一致
    WP9-10 物理行 == 受信回读（逐字段指纹；Absent 与 Unknown(reason) 参与且不折叠）
    WP9-4 D01 跨 5 层 USER substitution count = 0；K-27 行动 initiator = SERVICE/agent-runner（永不 USER）
    WP9-5 人类正控与 D01 成对（human → USER，agent → SERVICE）
    WP9-11 ledger truth 只从账本/物理行读出（模型文本零参与）
    WP9-18 src 零改动 · 冻结目录零写入 · 量具 measurementInvalid = 0

Tests Failed

  0（本门 40/40）
  ⚠️ 但**不宣布 WP9 = PASS**：两处 canonical 场景的生产入口不存在 —— 见 Known Issues。

Evidence Produced

  artifacts/m5.1.1/wp9-e2e.json              总证据（执行计划冻结名）
  artifacts/m5.1.1/wp9-runtime-e2e.json      WP9-16 命名
  artifacts/m5.1.1/wp9-level1-results.json / wp9-level2-ledger.json
  artifacts/m5.1.1/wp9-correlations.json / wp9-d01-k27.json / wp9-execution-truth.json
  artifacts/m5.1.1/wp9-gate-exits.txt / wp9-restore-whitelist.txt

Known Issues

  1. **WP9-GAP-1（E4-A）**：生产 ingress 只有 user_message / assistant_message 两个族
     （`conversationAttributionForEntryMode(...).producers` 实测），也没有任何生产调用点能给出
     SYSTEM 因果证据 ⇒ S3 的 `Known(SYSTEM/组件名)` 分支**不可达**。本门证明其不可达，并把
     S3 的另一半（无法确认 ⇒ 如实 `Unknown(RUNTIME_UNRESOLVED)`）用真实端口跑通。
     **不在本 WP 里加 system producer**（WP9-13）。
  2. **WP9-GAP-2（E8-audit）**：`developer_control_events` 表存在且形状冻结（31 列、无 Axis B、22 CHECK），
     但仓库**没有**任何生产 writer（U-03 LANDING = 只落 DDL；已知局限 L-02；控制面明文说"今天没有持久化的控制账本"）。
     本门跑通真实命令（verified），**拒绝**替它写审计行（那是 fixture 自证）。
  3. **NOTE-1（措辞差异，非 drift）**：生产行动侧 actor 由**决策点**注入 ⇒ 实测
     `actor=Known(SERVICE/action-gateway)`、`executor=Known(SERVICE/adapter:system.echo)`（两者不同，
     各自可读）。较早的 Test-and-Gate-Plan S1/S4 行把 actor 字面写成 `Known(CHARACTER)`；
     本门按执行令的措辞（"actor 与 executor 独立"）判定，并把差异写进 F4 §5。
  4. **NOTE-3（登记耦合）**：WP9 门登记在 `NON_VERIFIER_SCRIPTS`（不是 `VERIFIERS`），
     否则 WP9 的 PARTIAL 会把已 PASS 的 WP8 判红。K-17 分类表里该脚本归 D。
  5. 本门是**文本驱动端口**的一个仪器观察：`createActionIntentDetector` 在"帮我 echo 一下 e4b"上未命中，
     E4-B 因此走"无因果证据"分支（canonical `attestActionInitiatorUnresolved`），已在 F4 NOTE-2 说明。

Architecture Deviations

  1. **单库单进程**：只用 `createM4Harness` 一个 runtime/DB（plugin-sql 是进程级单例），
     行动侧由 `h.db` 上按 `src/main.ts` 的同一批工厂装配（不用 `createActionTestBed`，
     那会引入第二个 AgentRuntime ⇒ 违反"一个进程一个库"）。
  2. **证据名双份**：执行计划冻结的 `wp9-e2e.json` + WP9-16 要求的 8 份命名，同一份读数两面写。
  3. **verdict 语义**：`wp9:verify` 在"0 失败但有预先授权 gap"时 **EXIT=1** 且 verdict 写
     `PARTIAL / BLOCKED` —— 不用 exit 0 冒充通过，也不把 gap 折算成失败断言。

Commit Hash

  <本次提交在会话末报告>

Next WP Preconditions（**不要在本 execution 开始**）

  1. **需要用户裁定**（本 handoff 明确请求，见 F4 §8）：
     · E4：S3 的"未知就如实 Unknown"分支是否满足 canonical `E4 system initiated`？
       若算 ⇒ E4 = PASS（诚实 Unknown 形态）；若不算 ⇒ 需要独立 WP 实现 system producer（新功能，非验收）。
     · E8：`developer_control_events` 的持久化 writer（U-03 / L-02）是否先作为独立 WP/ADR 落地；
       本门当前只能证明"命令真实可跑 + 承载面已冻结 + writer 尚不存在"。
  2. 只有 `WP9 = PASS` 才允许 `WP10 = READY / AUTHORIZED`；
     `m4.5:ci` / `m4.5:ci:full` / Live Smoke / `m5.1:regression:verify` 仍留在 WP10。
  3. K-31 仍 OPEN / DEFERRED；Phase 4 / ADR-043 仍 NOT APPROVED。

STOP

---

## R-48 / WP9-C1 附注（2026-09-19，**本文件之上后加**）

> ⚠️ 本节**不改**本 handoff 的正文结论。本文件里的 `WP9 = PARTIAL / BLOCKED`、
> `WP9-GAP-1` / `WP9-GAP-2` 与上面的"Next WP Preconditions"都是**当时（WP9 首轮）的真事实**。

**后续已发生的事**（每一步都有自己的 F4 / handoff）：

```text
WP9-A  = PASS      Developer Control durable audit writer（解决 WP9-GAP-2 的"没有 writer"那一半）
WP9-B0 = BLOCKED BY PRODUCT CAPABILITY DECISION（选型门：生产里可归因的系统发起行为 = 0）
WP9-B1 = PASS      state_transition 契约 + MIGRATION_0009（physical carrier）
WP9-B2 = PASS      生产 State Bootstrap 的受信 SYSTEM 归因接线（E4-A 从"不可达"变为"已实测"）
WP9-C0 = COMPLETE  canonical E4/S3 的验收边界复核（7 行矩阵 + Q1/Q2 交回用户）
R-48   = Q1-a      S3 的载体 = domain-appropriate authoritative event ledger（载体无关的 System initiated 验收）
WP9-C1 = PASS      E4 接到真实 State Bootstrap 链 · E8 接到生产 audit writer 链
                   ⇒ **WP9 = PASS** · **WP10 = READY / AUTHORIZED**
```

**本文件里几处已过时的表述**（保留原文，不重写）：

| 本文件的说法 | 现状 |
|---|---|
| `WP9 = PARTIAL / BLOCKED` | WP9-C1 之后 **`WP9 = PASS`**（见 `WP9C1-Handoff.md`） |
| "E8：writer 尚不存在" | WP9-A 已实现且 `src/main.ts:2193` 已接线；WP9-C1 把 E8 指到该生产链 |
| "E4：需要独立 WP 实现 system producer" | 载体解释由 **R-48** 裁定（`Q1 = a`）；`Conversation SYSTEM Producer` 仍是 **DC-1 / DEFERRED**（`state-bootstrap` **不是**它） |
| "只有 `WP9 = PASS` 才允许 `WP10 = READY / AUTHORIZED`" | 仍然成立 —— 前置条件已满足；`WP10` 已放行但**未开始** |

**下一步**：`WP10 — Production-Copy Migration & Regression`（**不在** WP9-C1 的 execution 里开始）。
