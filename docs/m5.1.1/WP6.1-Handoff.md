# WP6.1 Handoff — Production Conversation Attribution Ingress Closure / K-28 Closure

> ## 状态（**必须按字面读**）
>
> ```text
> WP6.1                                        = **PASS**
> WP6.1 专项门（pnpm m5.1.1:wp6.1:verify）      = **PASS（115 通过 / 0 失败）**
>   §1 写入者清单       = **文件级**：6 个生产对话写入者 / 3 个 append 调用点**全部**被分类
>                         **方法级**：5 个 recorder 写入方法 + 4 个账本端口方法逐个分类
>                         （含显式 `TEST_ONLY` / `DEAD·UNREACHABLE` 行）；新增未登记 ⇒ 变红，
>                         且检测器自带**负控**（注入合成写入方法 ⇒ 必响）
>   §1 K-28 闭合        = 生产侧 `buildTrustedAttributionContext()` 构造者 **0 → 1**
>                         （`src/infrastructure/runtime/conversation-attribution.ts`，**不是** verifier）
>   §2 受信边界         = 三个具名工厂 arity = 0；无 `role` / `ingress` 可填枚举；
>                         手写同形 / 结构克隆 / JSON 往返的上下文**写不进账本**；
>                         事实对象夹带 `contentOriginator` ⇒ 拒绝；同族两个生产者 ⇒ 拒绝
>   §3 人类 ingress     = 真实 `beginTurn` ⇒ `KNOWN|USER/<id>` ×2 + `RECORDED` + Axis B **confirmed**
>   §4 D01 生产控制     = 同一个入口、同一个族 ⇒ `KNOWN|SERVICE/agent-runner` ×2 +
>                         Axis B **unconfirmed（UNCONFIRMED_ORIGIN ×2）**，整行**没有任何 USER 位次**
>   §5 她的输出         = 真实 `completeTurn` ⇒ `KNOWN|CHARACTER/<canonical>` ×2 + confirmed；
>                         呈现位次对不上 canonical ⇒ 抛；缺失 ⇒ `Unknown(RUNTIME_UNRESOLVED)`
>   §6 工具 / 系统族    = 生产侧**没有**调用点 ⇒ 不接线、不发明入口（如实记 legacy）
>   §7 端到端           = 真实 ingress → 上下文 → `createConversationEvent` → store → DB →
>                         回读 → 开发者查询（trace DTO）**四份读数逐字段相等**
>   §8 K-27 跨账本      = 动作 `initiator` 与对话 `actor`/`contentOriginator` 一致；
>                         **没有任何读侧面**把 D01 说成 USER
>   §9 兼容 + 三段式    = legacy 路径逐字不变；正控 → 负控 → 恢复 → 再接上
>   §10 认知面          = 实测未动（Fact Firewall / `canSupportExternalFact` / MemoryAuthority /
>                         extractor / Recall / ADR-043 / Phase 4）
>   §11 schema 边界     = v8；0007 / 0008 指纹逐字未变；**没有** v9；真实库从未打开
>   ⇒ **K-28 = CLOSED** ⇒ **WP7 = READY / AUTHORIZED**
> ```
>
> **没有开始 WP7。没有动真实库。没有 schema 变更（v7 / v8 指纹逐字未变，也没有 v9）。**
> **没有改**：Fact Firewall / `canSupportExternalFact` / MemoryAuthority / extractor /
> Recall / ADR-043 / Phase 4 / Developer Control（U-03）/ `page.html`。
> **没有加**：归因过滤器（U-10 仍 DEFER）/ 归因索引 / telemetry 导出 /
> `character_traces` 上的第二份归因。
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-30（K-28 闭合）**、
> [`M5.1.1-WP6.1-Compatible-Assertion-Record.md`](./M5.1.1-WP6.1-Compatible-Assertion-Record.md)、
> `artifacts/m5.1.1/wp6.1-conversation-ingress.json`。
> **不要重新探索仓库。**

```text
Completed WP: WP6.1 — Production Conversation Attribution Ingress Closure（K-28）

  §1  §1 清单：全部生产对话写入者分类 + 静态探测器（新增未登记 ⇒ 变红）+ K-28 计数 0 → 1
  §1b §1b 方法级清单：5 个 recorder 写入方法 + 4 个账本端口方法逐个分类（自动发现调用点；
        `append*` 的分类由"唯一调用它的 recorder 方法体"推导）；
        PRODUCTION_ACTIVE 的族必须在**两个**入口模式下都有生产 ingress（接线闭环）；
        低层原语 `appendConversationEvent` 的调用点恰好 = ledger + backfill；
        检测器三段式：真实源码安静 → 注入合成写入方法**必响** → 去掉后重新安静
  §2  §2 受信边界：三个具名工厂（arity 0）/ 无角色枚举 / 9 条负控
  §3  §3 人类 ingress：真实 beginTurn ⇒ USER + confirmed（写时 == DB == 回读 == DTO）
  §4  §4 agent-as-user 生产 D01 控制：SERVICE/agent-runner + unconfirmed
  §5  §5 她的输出：真实 completeTurn ⇒ CHARACTER + confirmed（两条负控）
  §6  §6 工具 / 系统族：生产无调用点 ⇒ 不接线（如实记 legacy）
  §7  §7 端到端四份读数逐字段相等（不是 store-only）
  §8  §8 K-27 跨账本保持（人类 = USER / D01 = SERVICE）
  §9  §9 legacy 兼容 + 正控 / 负控 / 恢复三段式
  §10 §10 认知面实测未动
  §11 §11 schema 边界与只读面
  §12 §12 汇总 + 16 个计数型检测器（measured_count > 0 全部有效）

Changed Files:
  src/infrastructure/runtime/conversation-attribution.ts （**新增**：唯一的对话 ingress 装配模块 ——
                                                        三个具名工厂 + 入口模式推导 + 族索引（拒绝歧义））
  src/infrastructure/persistence/ledger.ts             （改：+ `ConversationLedgerOptions.attribution`
                                                        → 按**事件族**查生产 ingress → `trustedAttribution`）
  src/infrastructure/runtime/conversation-recorder.ts   （改：+ `attribution` 透传给账本）
  src/kernel/contracts/attribution.ts                   （改：+ `TrustedActorEvidence.unresolvedReason`
                                                        / `attestActorFromDecisionPoint` 接受它 —— 与动作侧同形）
  src/main.ts                                           （改：+ `conversationEntryModeOf(argv)` 唯一判定点；
                                                        `ChatSession.entryMode` **必填**；6 个构造点全传；
                                                        `buildGateway` 接线 `conversationAttributionForEntryMode`）
  scripts/verify-m5.1.1-wp61-conversation-ingress.ts    （新增：WP6.1 专项门，115/0）
  package.json                                          （改：+ m5.1.1:wp6.1:verify）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                   （改：+ R-30（K-28 CLOSED）+ WP6.1 闭包注记）
  docs/m5.1.1/M5.1.1-WP6.1-Compatible-Assertion-Record.md （新增：本步对继承判据/契约的改动逐条留痕）
  docs/m5.1.1/WP6.1-Handoff.md                          （本文件）

Tests Run（见 wp61-gate-exits.txt）:
  pnpm m5.1.1:wp6.1:verify          → 0（**115 / 0**；WP6.1 专项门，本步新增）
  pnpm typecheck                    → 0
  pnpm kernel:test                  → 0（**26 / 0**）
  pnpm kernel:test:conversation     → 0（**47 / 0**）
  pnpm m4:test                      → 0（CLI 解析 + 只读分类；`src/main.ts` 改动必跑）
  pnpm m4.5:test                    → 0（**135 / 0**）
  pnpm m4.5:verify                  → 0（L2 子系统）
  pnpm m4.5:measurement:verify      → 0（L0 量具）
  pnpm m4.5:nl-action:verify        → 0（L3 自然语言动作链路：turn-gateway 直连）
  pnpm m5.1:test                    → 0（**52 / 0**）
  pnpm m5.1.1:test                  → 0（**42 / 0**）
  pnpm m5.1.1:k25:verify            → 0（**22 / 0**）
  pnpm m5.1.1:wp3.2:verify          → 0（**35 / 0**）
  pnpm m5.1.1:wp4:verify            → 0（**48 / 0**）
  pnpm m5.1.1:wp4.1:verify          → 0（**43 / 0**）
  pnpm m5.1.1:wp5:verify            → 0（**58 / 0**）
  pnpm m5.1.1:wp5.1:verify          → 0（**33 / 0**）
  pnpm m5.1.1:wp6:verify            → 0（**51 / 0**；K-28 段现在报"已接线：1 个构造者"）
  pnpm m5.1.1:migration:verify      → 0（**97 / 0**）
  pnpm m5.1:query:verify            → 0（**56 / 0**）
  pnpm m5.1:control:verify          → 0（**41 / 0**）
  pnpm m5.1:observability:verify    → 0（**27 / 0**）
  pnpm m5.1:page:verify             → 0（**27 / 0**）
  pnpm m5.1:measurement:verify      → 0（**16 / 0**）
  tsx scripts/verify-dry-run-silence.ts → 0（真实 gateway 的干跑静默）

Tests Failed: 0
Tests Not Run（**理由明确**）:
  · m4.5:ci / m4.5:ci:full —— 会重写 m4/m4.1/m4.5 历史证据；按 WP6 的同一口径留给 WP10
  · m4.5:smoke:live / m5:smoke:live —— 需要 OPENAI_API_KEY（本步只改写入路径的归因，未改 prompt / 回复守卫）
  · m5.1:gates / m5.1:regression:verify —— 读 m4.5:ci 的日志
  · m5.1.1:wp3:verify / k16 / k17 / k19 / k20 —— 与本次改动无关；其中 **k17 的分类表在 WP2.2 之后已陈旧**
    （见下"架构偏差"第 3 条，是**本步之前就有**的状态）
  · 真实库 data/pglite 的任何 apply / update（未打开）
  · WP7 · Phase 4 / ADR-043 · 里程碑标签（需要批准）

Evidence Produced:
  artifacts/m5.1.1/wp6.1-conversation-ingress.json  —— 写入者清单与分类 / 受信边界负控 / 三个入口的行读数 /
                                                       端到端四份读数 / K-27 跨账本 / 兼容与三段式 /
                                                       认知面实测 / schema 边界 / 16 个检测器
  artifacts/m5.1.1/wp61-*.log（25 份）· wp61-gate-exits.txt · wp61-restore-whitelist.txt

Commit Hash:
  de72edf  （feat：对话 ingress 受信归因接线 —— 三个具名工厂 + 族查表 + main.ts 装配
            + 契约一个可选字段）
  35d6c02  （test：WP6.1 专项门（115/0）+ 25 条门日志 + fork/还原白名单）
  b3fbe1d  （docs：R-30（K-28 闭合）/ compatible-assertion record / 本文件）
  --- 以下两条是收尾（不改变结论、不改任何判据）---
  028ac1b  （docs：把上面三条哈希写进本文件 + 真实库 mtime 证据）
  daf2e3a  （docs：写明本步**不主张**什么（不跑 main.ts / 不验模型 / 真库仍 legacy /
            偏差今天不可达 / K-17 陈旧是本步之前的状态）；重跑门刷新证据：115 / 0）
  44e6f87  （test：§1b **方法级**写入者清单（5 + 4 个方法逐个分类，分类由唯一调用者的
            方法体推导）+ 检测器负控；门 115 / 0；`src/` 未动 ⇒ 其余 24 条门日志仍有效）

真实库未动（mtime 证据）:
  `data/pglite/` 最新写入时间 = **2026-09-17 23:51:40**（本步全程未打开；所有门都跑在
  `isolateDatabase()` 沙箱上）。`data/**` 被 gitignore ⇒ `git status` 对它永远为空，
  因此这里只认 mtime（AGENTS §7）。
```

---------------------------------------------------------------------------
 WP6.1 验收 —— 逐条（对应任务书 §1–§14）
---------------------------------------------------------------------------
```text
§1  Inventory / classification          = PASS ✅ 6 个写入者 + 3 个 append 调用点全部有分类与理由；
                                                新增未分类写入者 ⇒ 门变红（探测器自带 measured_count 自检）
§1  producer 0 → > 0                    = PASS ✅ conversationIngressProducers = 1（唯一模块，
                                                **不是** verifier 造的；门断言它必须在 src/ 且不是 scripts/）
§2  trusted boundary only               = PASS ✅ 无角色枚举（arity 0 + 静态扫描）；手写 / 克隆 /
                                                JSON 往返 / 手写证据 token 一律拒绝；夹带归因字段 ⇒ 拒绝；
                                                同族两个生产者 ⇒ `ambiguous_attribution_ingress`
§3  human ingress                       = PASS ✅ family=user_message / actor_type=user /
                                                Known(USER/<id>) ×2 / RECORDED / Axis B confirmed
                                                （凭 `authenticated_human_input` 鉴证，**不是**凭 actor_type）
§3  不得因 actor_type=user 就确认 USER    = PASS ✅ D01 行（同一族、同一 actor_type）是 unconfirmed，
                                                且**整行没有任何 USER 位次**
§4  agent-as-user 生产 D01 控制           = PASS ✅ Known(SERVICE/agent-runner) ×2 + RECORDED +
                                                `user_statement` / `UNCONFIRMED_ORIGIN` ×2
§5  assistant path                      = PASS ✅ 真实 completeTurn ⇒ Known(CHARACTER/<canonical>) ×2 + confirmed；
                                                呈现位次对不上 ⇒ 抛；缺失 ⇒ Unknown(RUNTIME_UNRESOLVED)（**不**由族推出）
§6  tool / system                        = PASS ✅ src/ 里没有生产调用点 ⇒ 不接线、不发明入口；
                                                接了线的 recorder 写 system_event 仍记 legacy（origin NULL）
§7  runtime end-to-end（**非 store-only**）= PASS ✅ 真实 TurnGateway + 真实 recorder + 真实 store +
                                                DB 行 + `getConversationEvent` 回读 + `readConversationEventAttribution`
                                                + 开发者查询 trace DTO —— 六槽位 + origin + Axis B 逐字段相等
§8  K-27 cross-ledger preservation       = PASS ✅ 人类 ⇒ 动作 initiator = Known(USER/<id>)；
                                                D01 ⇒ Known(SERVICE/agent-runner)；4 个读侧面**没有一个**说 USER；
                                                legacy 兼容字段（actor_type / requestedBy）仍说 user
§9  legacy compat call sites             = PASS ✅ ledger / conversation-store / backfill 三类站点各有书面理由；
                                                legacy 写路径逐字不变（origin NULL、Axis B 推导值不变）
§9  static detector for new writers      = PASS ✅ 文件级：三组调用点扫描 + 冻结分类表 + stale 检查；
                                                方法级：5 个 recorder 写入方法 + 4 个账本端口方法逐个分类
                                                （`append*` 的分类由唯一调用者的方法体**推导**）；
                                                负控：注入合成写入方法 ⇒ 检测器**必响**；去掉后重新安静
§10 no cognitive behaviour switch        = PASS ✅ 实测：`authorityFromSource` 四个既有等级映射未变；
                                                `USER_EXPLICIT` 与 `USER_REPLY_CONFIRMATION` 同映射；
                                                `UNCONFIRMED_ORIGIN` 仍**抛**（ADR-043 未批准）；
                                                extractor 从 actorType 现场推导；Recall 与归因零接触
§11 no schema change                     = PASS ✅ v8；0007/0008 sha256 逐字一致；无 0009；
                                                归因相关索引仍只有 v7 那一个
§12 new gate                             = PASS ✅ `pnpm m5.1.1:wp6.1:verify` = 115/0；正控 / 负控 / 恢复三段式；
                                                16 个计数型检测器全部 `measured_count > 0`
§13 required regressions                 = PASS ✅ 25 条命令全 exit 0（含 main.ts 改动触发的 m4:test / nl-action）
§14 acceptance                           = **K-28 = CLOSED** ⇒ **WP7 = READY / AUTHORIZED**（本步**未**开始 WP7）
```

---------------------------------------------------------------------------
  本步**不主张**什么（先说清，免得被读大）
---------------------------------------------------------------------------
```text
1. **没有运行 `src/main.ts` 本身**：那会打开真实库（AGENTS §3 的冻结区）。
   生产装配的那**一行**（`attribution: conversationAttributionForEntryMode(this.entryMode).producers`）
   由门里的**静态**断言钉住（共享装配函数 / 入口模式唯一判定点 / `entryMode` 必填 /
   6 个构造点全传），运行期行为由门用**同一个**装配函数 + 同形状的 recorder 证明。
   ⇒ "生产装配写对了"这条的强度是 **静态 + 同函数运行期**，不是"真的跑了一次 CLI"。
2. **模型那一跳没有被验证**：本门不调模型，回复文本由 `completeTurn({ replyText })` 喂入
   （M5 / M5.1 门的既有做法）。验的是归因写入链路，不是模型质量。
3. **真实库现在仍然是 legacy**：本步一个字节都没写进 `data/pglite`（只记录路径与 mtime）。
   第一次带接线的真实对话会把**新行**写成 RECORDED，而**旧行**保持无信封 —— 两者可区分、都可读。
4. **`USER_EXPLICIT` vs `USER_REPLY_CONFIRMATION` 的偏差**只在"直接账本端口 + 显式 replyToEventId"
   上生效，而生产录制路径不给用户事件带 reply graph ⇒ **今天不可达**（门里有静态断言）。
   认知后果为零（同一 MemoryAuthority），但它**确实是**一处**未闭合的语义差**。
5. **K-17 分类表陈旧**是**本步之前**就有的状态（见下 §2 第 3 条），本步只登记、不修。
```

---------------------------------------------------------------------------
 关键设计（为什么是这样，而不是别的形状）
---------------------------------------------------------------------------
```text
① **三个具名工厂，而不是一个 `role` 参数**（K-25 §2 / ADR-042 §3.3 的直接推论）：

     ✗ createConversationIngress({ role: 'human_console' })   // 一个 DTO 字段就提权
     ✅ createHumanConsoleUserTurnIngress()     （arity = 0，门里有断言）
     ✅ createAgentRunnerUserTurnIngress()
     ✅ createCharacterAssistantTurnIngress()

   角色由**工厂**决定，位次由**受信事实**决定，入口模式由**真实进程事实**（有没有位置参数）决定。
   三者**都不接受外部载荷**。门里同时静态扫（没有 `role:` / `ingress:` 形状的可填参数）与动态测
   （夹带 `contentOriginator` 的事实对象、手写/克隆/JSON 往返的上下文都必须被拒）。

② **"谁在呈现"与"谁提供的"从此可以不同**（这正是 D01 要打破的等式）：

     人类控制台    actor_type=user       actor=Known(USER/<id>)             confirmed
     agent 一次性  actor_type=user       actor=Known(SERVICE/agent-runner)  unconfirmed
     她的输出      actor_type=character  actor=Known(CHARACTER/<canonical>) confirmed

   第二行就是**生产级的 D01 控制**：程序化入口替用户提交的话仍以 `user_message` 呈现
   （legacy 表面一个字节都没变），但权威槽位说清了它不是用户本人提供的，
   且 Axis B 成对 `UNCONFIRMED_ORIGIN`（表面身份**不足以**建立认知资格）。

③ **接线点在装配层，不在契约层**：`main.ts` 只调 `conversationAttributionForEntryMode(entryMode)`；
   账本按**事件族**查生产 ingress（调用方传不了"用哪份归因"的开关）。
   缺省（不传 `attribution`）= **legacy 路径逐字不变** —— 这是给测试夹具 / 迁移回填 / M3 评测留的，
   并且门的静态探测器会断言生产写入者要么已接线、要么显式登记为兼容路径。

④ **§5 的"证明不了就用 Unknown"必须真的可表达**：对话 builder 原本的 `actor` 证据**没有**
   `unresolvedReason`（动作侧一直有），于是"定不下来"只能被写成 `Absent` —— 而
   `user_message.actor` 在**冻结矩阵**里是 `REQUIRED`（`REQUIRED` 允许 `Unknown(RUNTIME_UNRESOLVED)`、
   不允许 `Absent`）。本步把这一格补齐（与动作侧同形），因此 agent 入口下的"呈现位次缺失"
   与人类入口下的"解析不出用户"都如实写成 `Unknown(RUNTIME_UNRESOLVED)`，而不是一条违反矩阵的行。

⑤ **三段式**（任务书 §6.7）：正控 = 接线后真实 `beginTurn` 写出 RECORDED；
   负控 = 伪造上下文 / 夹带字段 / 歧义生产者 / 位次不符**必响**；
   恢复 = 拆掉接线 ⇒ 回到 legacy（origin NULL），再接上 ⇒ 又是 RECORDED。
   "什么都不检查"与"只做正控"在输出上都无法通过本门。
```

---------------------------------------------------------------------------
 架构偏差 / 已知问题（如实登记）
---------------------------------------------------------------------------
```text
1. **K-28 = CLOSED**：生产侧受信对话归因构造者 0 → 1。WP6 的证据文件
   （`wp6-recorded-read-path.json` 的 `knownGap.conversationIngressProducers = 0`）是**那一步的**
   历史读数，按"历史证据不重写"的纪律**保持原样**；闭合读数在 WP6.1 的证据里。
   重跑 `pnpm m5.1.1:wp6:verify` 时该段会报"已接线：1 个构造者"（判据本身两种情形都通过）。

2. **登记偏差（不影响认知结论，但必须写下来）**：接了人类 ingress 之后，
   **直接调账本端口**的"用户回复确认"（`appendUserStatement({ replyToEventId })`）
   其 `source_authority` 由 legacy 的 `USER_REPLY_CONFIRMATION` 变为 RECORDED Axis B 的
   `USER_EXPLICIT`（K-25 的 builder 在 confirmed 分支只产出 `defaultAuthorityForKind(source_kind)`）。
   · **认知后果 = 0**：两者在 `authorityFromSource` 里映射到**同一个** MemoryAuthority
     （`EXPLICIT_USER_STATEMENT`），`canEvidenceExternalFact` 对两者同为 true，
     extractor 根本不读行上的该列（它从 actorType 现场推导）。门里**实测**了这三条。
   · **可达性 = 今天不可达**：`ConversationRecorder.recordUserMessage(text, sequence)`
     **不传** `replyToEventId`，`src/` 里也没有别处给用户事件传它 ⇒ 生产链路上用户事件
     从来没有 reply graph（WP6.1 之前之后都是）。该偏差只在"直接账本端口 + 显式 replyToEventId"
     这条路上生效（M3 评测夹具走的就是那条，而夹具**不传** attribution ⇒ 逐字保留旧语义）。
   · 若要同时保留两个值，需要动 K-25 的 builder（给它一个"已确立分支的 authority"入口）——
     那属于**契约语义变更**，不在本 WP 范围；登记为**待决**（见下 §2 第 3 条的同一形态）。

3. **K-17 的分类表在本步之前就已陈旧**（不是本步造成的，也不是本步修的）：
   `scripts/verify-m5.1.1-k17-consumer-impact.ts` 的分区表停在 **WP2.2**，而它机械扫描
   `src` / `scripts` / `evals` 里六个 Axis B 名字并断言"每个命中文件都已分类"。
   实测（本步复现，只读扫描、不连库）：命中 46 个文件，其中 **5 个 WP4–WP6 的门脚本未登记**
   （`verify-m5.1.1-wp4-write-path` / `wp41-k22-action-axisb` / `wp5-action-attribution` /
   `wp51-k27-causal-initiator` / `wp6-recorded-read-path`），因此今天重跑 K-17 会是 BLOCKED。
   本步新增的门脚本会是第 6 个。**修它需要改那份冻结表并重出 wp2.2 证据**（还要做
   production-copy 只读预检）—— 与 WP6.1 的范围无关，登记给后续 WP（用户未把它列进 §13 清单）。

4. **`ConversationLedgerOptions.attribution` 是一条"约定式"受信边界**（K-25 §2 的同一形状）：
   能 import `conversation-attribution.ts` 并调用工厂的人就是受信装配点。它挡的是
   "不可信载荷夹带一个字段就提权"，**不是**密码学证明 —— 与本项目既有的三条受信证据同一边界。

5. **对话 builder 不调 `assertAttributionNecessity`**（既有状态，本步未改，也未放宽）：
   因此"`user_message.actor = Absent`"在 builder 层仍可被表达（WP4 的 ⑥ 号夹具就是这样）。
   本步让生产 ingress **不**走那条路（缺证据 ⇒ `Unknown(RUNTIME_UNRESOLVED)`），
   但没有给 builder 加上必要性断言 —— 那会让 WP4 的既有夹具变红，属于另一个 WP 的判据变更。

6. ADR-042 仍是 ACCEPTED / DESIGN FROZEN，本步没有改它（R-30 只进 Execution-Plan 的修订记录）。
   没有 schema 变更、没有 v9；`MIGRATION_0007` / `0008` 指纹逐字未变（门里断言）。
```

---------------------------------------------------------------------------
  Next WP Preconditions（WP7 = READY / AUTHORIZED，但**不要在本 execution 开始**）
---------------------------------------------------------------------------
```text
WP7（开发者页面 / 最终呈现）现在拿到的是**生产里真的有归因**的账本：
  □ 真实人类轮次 ⇒ RECORDED + Known(USER/<id>) + confirmed（不再是"由 actor_type 推导"）
  □ 程序化一次性入口（agent 替用户提交）⇒ RECORDED + Known(SERVICE/agent-runner) + unconfirmed
    ⇒ 页面可以直接把"这句话是谁提供的"渲染出来，而 D01 的两类行**可区分**
  □ 仍需遵守：不得在页面层把 Unknown 渲染成空 / "-"；不得把 MIGRATED_LEGACY 说成 RECORDED；
    不得把 UNCONFIRMED_ORIGIN 渲染成"已确立"；不得合并 WP6.1 + WP7；
    Phase 4 / ADR-043 仍 NOT APPROVED；任何 schema 变更都必须新写 v9+（v7 / v8 均已指纹锁定）
  □ 真实库 `data/pglite` 仍是 legacy（尚未在真库上跑过带接线的对话）：
    第一次真实对话会把 **新行** 写成 RECORDED，而**旧行**保持 legacy/无信封 —— 两者都可读、可区分；
    真库的任何写入仍需要你的批准
  □ 遗留待决（**不阻塞 WP7**）：§2 第 2 条的 builder authority 入口；§2 第 3 条的 K-17 分类表陈旧
```
