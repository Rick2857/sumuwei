# WP5 Handoff — Action & Execution Attribution

> ## 状态（**必须按字面读**）
>
> ```text
> WP5                                     = **PASS**
>   · WP5 专项门（pnpm m5.1.1:wp5:verify） = **PASS（58 通过 / 0 失败）**
>   · action attribution write path       = PASS（真实 store + 真实 gateway）
>   · action attribution readback         = PASS（逐槽位 写=库=读）
>   · requestedBy false SYSTEM fallback   = **已消除**
>   · necessity matrix enforced           = PASS（写入前必过）
>   · Axis B always N/A                   = PASS（行动表三格恒 NULL）
>   · execution truth unchanged           = PASS（WP5-9 的四条否定命题）
>   · attestation 正控 / 负控 / 恢复       = PASS（10 条负控）
>   · inherited gates                     = PASS（15 条命令全 exit 0）
>   · live DB untouched                   = PASS（data/pglite 只被记录，从未被打开）
>   ⇒ **WP6 = READY / AUTHORIZED**
> ```
>
> **没有开始 WP6。没有动真实库。没有 schema 变更（v7 / v8 指纹逐字未变）。**
> **没有碰 Fact Firewall / MemoryAuthority / Recall / extractor / ADR-043 / Phase 4。**
> **没有把 Developer Control 当成普通动作（U-03 仍是独立的未决物理面）。**
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-27**、
> [`M5.1.1-WP5-Compatible-Assertion-Record.md`](./M5.1.1-WP5-Compatible-Assertion-Record.md)、
> `artifacts/m5.1.1/wp5-action-attribution.json`。
> **不要重新探索仓库。**

```text
Completed WP: WP5 — Action & Execution Attribution
  §WP5-0  真实链路盘点：gateway → 九个具名 append → action-ledger-store → fold/ExecutionRecord
  §WP5-1  TrustedActionAttributionContext（四个**独立**受信来源 + recordedBy 自写）
  §WP5-2  证明不可伪造：不透明 token + 运行期登记（手写 / 克隆 / JSON 往返一律不算）
  §WP5-3  消除 `requestedBy ?? { kind: 'system' }`；缺受信 initiator ⇒ 失败关闭
  §WP5-4  `ActionRequester` 追加 `'tool'`（最小兼容扩展，不建投影）
  §WP5-5  阶段快照：每个事件记"当时已确立的"，早期行不被回溯填充
  §WP5-6  冻结的 NECESSITY_MATRIX 是唯一判据（事件类型 → 族是一张机读桥表，不是第二张矩阵）
  §WP5-7  store 写路径：INSERT 前过三关，然后写 22 列（Axis B 三格恒为字面量 NULL）
  §WP5-8  store 读回路：RECORDED 行三态逐字解码；历史行不凭空补信封
  §WP5-9  执行真相防火墙：四条否定命题逐条有断言
  §WP5-10 真实 store + 真实 gateway 的九个事件类型逐字段等值
  §WP5-11 10 条负控 + 正控 / 负控 / 恢复三段式（计数检测器全部 measured_count > 0）
  §WP5-12 历史边界：真实库行动账本为空 ⇒ 不制造回填工作（读数变非 0 即变红 = STOP）
  §WP5-13 无 schema 变更（MIGRATION_0007 / 0008 指纹逐字未变）

Changed Files:
  src/kernel/contracts/attribution.ts        （改：+ 行动归因段：桥表 / 四份证据 / 构造器 /
                                                actionAttributionEnvelopeOf / 运行期登记 / 匹配断言）
  src/kernel/action/execution-ledger.ts      （改：+ Base.attribution + ActionLedgerEvent.attribution）
  src/infrastructure/action/action-ledger-store.ts
                                             （改：写 22 列 + INSERT 前三关 + RECORDED 三态解码）
  src/kernel/action/gateway.ts               （改：+ 可选 attribution 配置 + invocation 上下文 +
                                                九个阶段各自构造快照（矩阵驱动））
  src/kernel/action/action-turn.ts           （改：受信 ingress 产出 initiator 证据 + speaker 补 'tool'）
  src/kernel/action/action-request.ts        （改：ActionRequester 追加 'tool'）
  src/kernel/action/execution-record.ts      （改：删掉 requestedBy 的 SYSTEM 默认值；+ FoldingActionRequest）
  src/kernel/contracts/developer-query.ts    （改：requestedByKind: string | null）
  src/infrastructure/dev/query-service.ts    （改：requestedByKind 允许 null）
  src/main.ts                                （改：装配 action-turn 的 ingress 标识 + gateway 的三个产出者 id）
  scripts/verify-m5.1.1-wp5-action-attribution.ts （新增：WP5 专项门）
  scripts/verify-m5.1.1-wp41-k22-action-axisb.ts  （改：两条静态判据适配 WP5 之后的现实，见 W-1/W-2）
  package.json                               （改：+ m5.1.1:wp5:verify）
  docs/m5.1.1/M5.1.1-Execution-Plan.md       （改：+ R-27 + WP5 闭包注记）
  docs/m5.1.1/M5.1.1-WP5-Compatible-Assertion-Record.md （新增：7 条判据/兼容面变更逐条留痕）
  docs/m5.1.1/WP5-Handoff.md                 （本文件）

Tests Run（全部 exit 0；见 wp5-gate-exits.txt）:
  pnpm typecheck                    → 0
  pnpm kernel:test                  → 0（**26 / 0**）
  pnpm kernel:test:conversation     → 0（**47 / 0**）
  pnpm m4.5:test                    → 0（**135 / 0**；legacy 路径逐字段未变）
  pnpm m4.5:verify                  → 0（**53 / 0**）
  pnpm m4.5:measurement:verify      → 0（**38 / 0**）
  pnpm m4.5:nl-action:verify        → 0（**32 / 0**）
  pnpm m5.1.1:test                  → 0（**42 / 0**）
  pnpm m5.1.1:k25:verify            → 0（**22 / 0**）
  pnpm m5.1.1:wp3.2:verify          → 0（**35 / 0**）
  pnpm m5.1.1:wp4:verify            → 0（**48 / 0**）
  pnpm m5.1.1:wp4.1:verify          → 0（**43 / 0**）
  pnpm m5.1.1:migration:verify      → 0（**97 / 0**；23 个计数检测器全有效）
  pnpm m5.1.1:wp5:verify            → 0（**58 / 0**）
  pnpm m5.1:measurement:verify      → 0（**16 / 0**）

Tests Passed: 26 · 47 · 135 · 53 · 38 · 32 · 42 · 22 · 35 · 48 · 43 · 97 · 58 · 16（全 0 失败）；15 条命令全 exit 0
Tests Failed: 0
Tests Not Run（**理由明确**）:
  · m4.5:ci / m4.5:ci:full —— WP5-15 明说留给 WP10（且会重写 m4/m4.1/m4.5 历史证据）；
    本轮改跑三条**针对性**的 m4.5 门（verify / measurement / nl-action）
  · m4.5:smoke:live —— 需要 OPENAI_API_KEY；WP5 没有改 prompt / 动作语义 / 回复守卫
  · m5.1.1:prod-copy:verify —— 本步无 schema 变更，没有新的副本 apply 要做；
    "真实库行动账本为空"由 WP4.1 的已落盘读数支撑，且 WP5 门 §7 会在它变非 0 时变红
  · 真实库 data/pglite 的任何 apply / update（未打开）
  · WP6 · Phase 4 / ADR-043 · 里程碑标签（需要你批准）

Evidence Produced:
  artifacts/m5.1.1/wp5-execution-attribution.json   —— WP5 专项门完整机读事实（计划书**登记**的证据名）
  artifacts/m5.1.1/wp5-action-attribution.json      —— 同一份内容（便于按 WP 名检索）
  artifacts/m5.1.1/wp5-*.log（15 份）· wp5-gate-exits.txt
  artifacts/m5.1.1/wp5-restore-whitelist.txt       —— fork + 还原白名单（12 条路径的 before/after sha256）
  artifacts/m5.1.1/wp5-{k22,migration,wp4,wp3.2,k25,m45,...}*.json|txt
                                                   —— 继承门本轮读数（fork；原路径已还原）

Commit Hash:
  5a97d9d  （feat：行动账本的权威归因契约 + store 写/读 + gateway 阶段快照 + 折叠伪造移除）
  ccd9a79  （test：WP5 专项门 + WP4.1 门的两条静态判据适配 + 证据 fork/还原）
  709fb8b  （docs：R-27 / compatible-assertion record / 本文件）
```

---------------------------------------------------------------------------
 §WP5-16 验收 —— 逐条
---------------------------------------------------------------------------
```text
action attribution write path = PASS   ✅ 真实 store：九个事件类型都写入 22 个归因列；
                                          真实 gateway：成功 5 条 / 拒绝 2 条全部 RECORDED
action attribution readback = PASS     ✅ 逐槽位 state/kind/id|ref/reason + origin，写=库=读
requestedBy false SYSTEM fallback eliminated = PASS
                                       ✅ 折叠视图：缺 requestedBy ⇒ `undefined`（不是 system）；
                                          dev-plane DTO ⇒ `string | null`
necessity matrix enforced = PASS       ✅ INSERT 前 assertAttributionNecessity + 矩阵双向
                                          （该给不给 / 不该给却给 都失败关闭）
Axis B always N/A = PASS               ✅ 行动表三格恒 NULL（写入路径字面量 null + 库 CHECK +
                                          全库扫描 0 行携带 Axis B）
execution truth unchanged = PASS       ✅ Known executor ⇏ executed · Known authority ⇏ accepted ·
                                          ACTION_SUCCEEDED 无 verified 字段 ·
                                          真实 gateway 的 executed 仍由事件类型决定
attestation positive/negative/restore = PASS
                                       ✅ 10 条负控全响（含 caller 自报 recordedBy、
                                          受信上下文克隆 2 种、位次→SourceKind 3 条）+ 恢复安静
inherited gates = PASS                 ✅ 15 条命令全 exit 0
live DB untouched = PASS               ✅ 只记录 PRODUCTION_DB_DIR；所有门跑在 isolateDatabase() 沙箱上
⇒ **WP5 = PASS**（否则应为 FAIL / PARTIAL 并 STOP）
```

---------------------------------------------------------------------------
 关键设计（为什么这样最小）
---------------------------------------------------------------------------
```text
① 四个槽位**各自**有独立来源（WP5-1 的要害）：

     initiator ← 受信 ingress（action-turn 从**呈现角色 + id** 产出证据）
     actor     ← 决策点自己（gateway / policy：它对这条事件负责）
     executor  ← 执行器适配器边界（**只有**真的把工作交给适配器时才产出 Known；
                  幂等重放 / 没有适配器 ⇒ Unknown(RUNTIME_UNRESOLVED)）
     authority ← 策略结论（`CAPABILITY/<capability>`：能力已登记 + 声明权限已授予）
     recordedBy← 构造器自写 SYSTEM/kernel（调用方在**类型层**就给不了）
     contentOriginator ← 恒 Absent（行动不是内容断言）
     Axis B    ← 不参与（K-22：行动侧 N/A）

   构造器入参里**没有** recordedBy / contentOriginator / attributionOrigin / sourceKind
   ⇒ "调用方自报"在类型层不可表达（K-26 的同一形状）。

② 事件类型 → 族是一张**机读桥表**，不是第二张矩阵（WP5-6）：
   每一条都与 §3.3 的 D/P/U/N 做 `N ⟺ ABSENT` 逐格交叉核对（54 格全一致），
   任何一格漂移都会让 wp5 门变红。

③ 阶段快照（WP5-5）：`stageAttribution()` 只读冻结矩阵决定"哪些槽位该表态"，
   gateway 里**没有**按事件类型手写的第二份必要性表。同一 actionId 的早期行
   在后来的授权/执行事实落库之后**逐字未变**（门里有断言）。

④ legacy 零影响：不配 `ActionGatewayOptions.attribution` 的 gateway 逐字段与今天相同
   （135 条 L1 测试零改动）；配了之后每次调用都必须带受信 initiator 证据，
   否则**失败关闭**（不退回 payload 自报 —— WP5-3）。
```

---------------------------------------------------------------------------
 架构偏差 / 已知问题（如实登记）
---------------------------------------------------------------------------
```text
1. ~~**initiator 的来源是"这一轮的呈现角色"**~~ —— **本条已在 WP5.1（K-27）关闭**：
   呈现角色**不再**构造权威 `initiator`；现在只有
   `attestActionInitiatorFromCausalOrigin()`（RECORDED + `actor` 与 `contentOriginator`
   都 Known 且同一位次 ⇒ Known；否则 `Unknown(RUNTIME_UNRESOLVED)`）与
   `attestActionInitiatorUnresolved()` 两个入口。
   见 [`WP5.1-Handoff.md`](./WP5.1-Handoff.md) 与 R-28。
   （历史记录，保留以便追溯：WP5 时 initiator 来自 `ActionTurnInput.speaker`，
   因此"agent 替用户发的轮"会让动作行的 initiator 变成 USER 角色。）
2. `ActionRequester`（legacy payload 字段）**保留**，仍然是兼容/输入证据；
   它**不再**是 RECORDED 行的权威来源。既有消费者不受影响。
3. 幂等重放路径的 `executor` 记为 `Unknown(RUNTIME_UNRESOLVED)`（矩阵要求"表态"，
   而这一次确实没有把工作交给任何执行器）。这是**语义选择**，已写进代码注释与证据。
4. 行动表的 Axis B 三格由写入路径写成**字面量 NULL**；`assertActionAxisBNotApplicable`
   在写入前必过。DB 的 CHECK 是最终裁判（`convalidated=true`）。
5. 本步**没有**做行动行的历史回填（真实库该表 0 行）。口径早已冻结（MIGRATED_LEGACY +
   §3.3 槽位 + Axis B 留 NULL），需要时单独执行。
6. `m5.1.1:wp4.1:verify` 的两条静态判据按 WP5 之后的现实做了**最小更新**（W-1/W-2）：
   旧判据在新现实下会变成假阳性（写入路径必须列出那三列才能写 NULL）。新判据**更精确**
   （写入期只允许字面量 NULL + 读路径不得引用），并保留运行时判据（全库 0 行携带 Axis B）。
7. ADR-042 仍是 ACCEPTED / DESIGN FROZEN，本步**没有**改它；R-27 只进 Execution-Plan
   的修订记录。若你认为"行动归因的四个独立来源"值得一条 ADR 级注记，请批准后再补。
```

---------------------------------------------------------------------------
 Next WP Preconditions（WP6 = READY / AUTHORIZED，但**不要在本 execution 开始**）
---------------------------------------------------------------------------
```text
WP6（读侧 / Query / replay 的归属切换）现在**没有**已知的物理或契约阻塞：
  □ 权威归因已经**落库**（22 列；RECORDED 行可逐字解码）
  □ 桥表（事件类型 → 必要性族）与四个证据构造器已在契约层
  □ 仍需遵守：不得合并 WP5 + WP6；Phase 4 / ADR-043 仍 NOT APPROVED；
    任何 schema 变更都必须新写 v9+（v7 / v8 都已是指纹锁定的历史 DDL）；
    不要顺手把 Developer Control（U-03）解决成"普通动作"
```
