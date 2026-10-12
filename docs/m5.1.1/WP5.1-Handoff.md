# WP5.1 Handoff — Causal Initiator Attribution Closure (K-27)

> ## 状态（**必须按字面读**）
>
> ```text
> K-27                                   = **CLOSED**
> WP5 final acceptance                   = **PASS**（K-27 关闭 + WP5 全部门仍绿）
> WP5.1 专项门（pnpm m5.1.1:wp5.1:verify） = **PASS（33 通过 / 0 失败）**
>   · 真实跨账本 D01：agent 以 user 角色提交 ⇒ 动作 initiator = **SERVICE/agent**（**不是** USER）
>   · 正控：真正的受信人类输入 ⇒ **USER/u-1**
>   · 歧义 / 未记录 / 只有呈现角色 ⇒ **Unknown(RUNTIME_UNRESOLVED)**
>   · 正控 / 负控 / 恢复 = PASS（9 条负控全响）
>   ⇒ **WP6 = READY / AUTHORIZED**
> ```
>
> **没有开始 WP6。没有动真实库。没有 schema 变更（v7 / v8 指纹逐字未变，也没有 v9）。**
> **没有改**：actor 证据 / executor 证据 / authority 证据 / `recordedBy` / 必要性矩阵 /
> Axis B N/A / Execution Truth 阶梯 / `MIGRATION_0007` / `MIGRATION_0008`。
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-28**、
> [`M5.1.1-WP5.1-Compatible-Assertion-Record.md`](./M5.1.1-WP5.1-Compatible-Assertion-Record.md)、
> `artifacts/m5.1.1/wp5.1-k27-causal-initiator.json`，以及
> [`WP5-Handoff.md`](./WP5-Handoff.md)（WP5 的九个字段与它的已知边界 ——
> 那条"initiator 来源是呈现角色"的边界**已被本步关闭**）。
> **不要重新探索仓库。**

```text
Completed WP: WP5.1 — Causal Initiator Attribution Closure
  §1 K-27 登记：initiator = 真正提出/造成/触发这次动作的位次；呈现角色不是证据
  §2 `speaker` 保留（legacy / 呈现 / 兼容 / 路由），但**不能**构造 Known(任何人)
  §3 因果证据：受信读者读回触发事件 → 显式关联边界 → 只回一条"有证据/没有证据"
  §4 真实跨账本 D01 场景（真实 conversation store 写 + 读回 + 真实动作触发）
  §5 正控：真正的受信人类输入 ⇒ Known(USER/u)
  §6 负控 9 条（呈现角色 ×2 · 历史行 · payload requestedBy · 手写因果证据 · 克隆 ×2 ·
     槽位不一致 · 只有一个槽位 Known）
  §7 其余 WP5 语义一字未动；无 schema 变更
  §8 早期 action 行不可变（整条链逐行断言）；隔离库；真实库未打开

Changed Files:
  src/kernel/contracts/attribution.ts        （删：呈现角色构造器；+ K-27 因果来源段：
                                                TriggeringConversationEvent / 关联边界 /
                                                TrustedCausalSource / 两个新构造器 / causalBasis）
  src/kernel/action/action-turn.ts           （删 `speakerPrincipal`；initiator 只从因果上下文或
                                               "如实未定"产出；+ ActionTurnInput.triggeringEvent）
  src/kernel/app/turn-gateway.ts             （+ `triggeringEvent: triggeringConversationEventOf(userEvent)`）
  src/kernel/action/gateway.ts               （文档：invocation 的 initiator 证据只能因果建立）
  scripts/verify-m5.1.1-wp51-k27-causal-initiator.ts （新增：K-27 专项门）
  scripts/verify-m5.1.1-wp5-action-attribution.ts    （改：九阶段的 initiator 改用因果构造器）
  package.json                               （改：+ m5.1.1:wp5.1:verify）
  docs/m5.1.1/M5.1.1-Execution-Plan.md       （改：+ R-28（K-27））
  docs/m5.1.1/M5.1.1-WP5.1-Compatible-Assertion-Record.md （新增：7 条变更逐条留痕）
  docs/m5.1.1/WP5-Handoff.md                 （改：把"initiator 来自呈现角色"的已知边界标记为已关闭）
  docs/m5.1.1/WP5.1-Handoff.md               （本文件）

Tests Run（全部 exit 0；见 wp51-gate-exits.txt）:
  pnpm m5.1.1:wp5.1:verify          → 0（**33 / 0**；K-27 专项门，本步新增）
  pnpm typecheck                    → 0
  pnpm kernel:test                  → 0（**26 / 0**）
  pnpm kernel:test:conversation     → 0（**47 / 0**）
  pnpm m4.5:test                    → 0（**135 / 0**）
  pnpm m4.5:verify                  → 0（**53 / 0**）
  pnpm m4.5:measurement:verify      → 0（**38 / 0**）
  pnpm m4.5:nl-action:verify        → 0（**32 / 0**）
  pnpm m5.1.1:test                  → 0（**42 / 0**）
  pnpm m5.1.1:k25:verify            → 0（**22 / 0**）
  pnpm m5.1.1:wp3.2:verify          → 0（**35 / 0**）
  pnpm m5.1.1:wp4:verify            → 0（**48 / 0**）
  pnpm m5.1.1:wp4.1:verify          → 0（**43 / 0**）
  pnpm m5.1.1:migration:verify      → 0（**97 / 0**；量具 23/23 有效）
  pnpm m5.1.1:wp5:verify            → 0（**58 / 0**；WP5 语义未被 K-27 改动）
  pnpm m5.1:measurement:verify      → 0（**16 / 0**）

Tests Passed: 33 · 26 · 47 · 135 · 53 · 38 · 32 · 42 · 22 · 35 · 48 · 43 · 97 · 58 · 16（全 0 失败）；16 条命令全 exit 0
Tests Failed: 0
Tests Not Run（**理由明确**）:
  · m4.5:ci / m4.5:ci:full —— 会重写 m4/m4.1/m4.5 历史证据；留给 WP10（改跑针对性三条）
  · m4.5:smoke:live —— 需要 OPENAI_API_KEY；本步未改 prompt / 动作语义 / 回复守卫
  · m5.1.1:prod-copy:verify —— 无 schema 变更，没有新的副本 apply 要做
  · 真实库 data/pglite 的任何 apply / update（未打开）
  · WP6 · Phase 4 / ADR-043 · 里程碑标签（需要你批准）

Evidence Produced:
  artifacts/m5.1.1/wp5.1-k27-causal-initiator.json —— K-27 专项门完整机读事实
                                                      （静态 / 真实跨账本 D01 / 正控 / 9 条负控 /
                                                       恢复 / 不可变 / schema 边界）
  artifacts/m5.1.1/wp51-*.log（16 份）· wp51-gate-exits.txt · wp51-restore-whitelist.txt
  artifacts/m5.1.1/wp51-{k22,migration,wp4,wp3.2,k25,wp5,m45,...}*.json|txt
                                                      —— 继承门本轮读数（fork；原路径已还原）

Commit Hash:
  ff21af8  （fix：删掉呈现角色入口；initiator 只从因果上下文或"如实未定"产出 + turn-gateway 接上触发事件）
  728bdc9  （test：K-27 专项门 + WP5 门的九阶段改用因果构造器 + 证据 fork/还原）
  ebc1b1a  （docs：R-28 / compatible-assertion record / 本文件 / WP5 handoff 的边界关闭标注）
```

---------------------------------------------------------------------------
 为什么"因果证据"是两个槽位的**合取**（而不是一条映射）
---------------------------------------------------------------------------
```text
判据（`attestActionInitiatorFromCausalOrigin`）：

  触发事件是 RECORDED
    且它**当时**记录的 actor 与 contentOriginator **都是 Known**
      且两个位次**相等**
        ⇒ Known(那位次)          causalBasis = recorded_actor_and_content_originator_agree
  否则
        ⇒ Unknown(RUNTIME_UNRESOLVED)
           causalBasis = not_recorded | slot_not_known | slots_disagree

为什么不是 `contentOriginator → initiator` 的通用映射（任务书 §3 明令禁止）：
  · 它只在**一个显式关联边界**内成立（`conversation_turn_triggered_action`，不透明 token）；
  · 它要求两个**互相独立**的权威槽位**同时**指向同一个位次；
  · 任一条不满足就返回 Unknown，**不挑一个**、不回落呈现角色。
代价（如实登记）：当两个槽位不一致时（例如 character 呈现了 user 提供的内容），
initiator 会是 Unknown —— 这是**有意的保守**："有歧义"就该说"定不下来"。
```

---------------------------------------------------------------------------
 真实跨账本 D01 场景（本步的要害证据）
---------------------------------------------------------------------------
```text
① conversation 侧（**真实 conversation store** 写）:
     family=user_message · actor_type=user · actor=Known(SERVICE/agent)
     contentOriginator=Known(SERVICE/agent) · attribution_origin=RECORDED
   —— 这**就是** D01 的形状：呈现是 user，作者是 agent。

② 受信读者**读回**那一行（不是拿内存对象），过显式关联边界：
     triggeringConversationEventOf(readback) → correlationSourceFromConversationEvent()

③ **真的从那个事件触发一次动作**：真实 action-turn 端口（`speaker` 故意写 user/u-1）
   + 真实 gateway + 真实 action store（system.echo）。

④ 结论（门里逐条断言）:
     动作行 initiator = **Known(SERVICE/agent)**      ✅
     initiator **不是** USER                          ✅
     整条 action 链（5 行）的 initiator 都是 SERVICE/agent（早期行没被回溯改写） ✅
     全库 initiator=USER 的动作**只有**两条真正的受信人类输入路径 ✅
```

---------------------------------------------------------------------------
 负控（8 条 + 恢复；检测器共响 9 次）
---------------------------------------------------------------------------
```text
  ① speaker=user 且无因果证据                 ⇒ Unknown（**不是** Known(USER)）        ✅
  ② speaker=character 且无因果证据            ⇒ Unknown（**不是** Known(CHARACTER)）   ✅
  ③ 历史行（actor_type=user 但无权威归因）     ⇒ Unknown（**不是** USER）               ✅
  ④ payload `requestedBy`=user + speaker=user ⇒ Unknown（自报不是证据）                ✅
  ⑤ 手写的同形"因果证据"对象                   ⇒ 构造器必响（不是受信 token）            ✅
  ⑥ 受信因果证据结构克隆 / JSON 往返（2 种）    ⇒ 都不算证据（必响 2 次）                 ✅
  ⑦ actor=CHARACTER 而 contentOriginator=USER ⇒ Unknown（两个权威槽位不一致，**不挑一个**）✅
  ⑧ 只有一个槽位是 Known                       ⇒ Unknown                              ✅
  — 恢复：放回合法因果路径                     ⇒ 重新安静（Known(USER/u-1)）            ✅
  （证据里 `negatives.fired = 7` 是走 `fired()` 的那 7 条；2 种克隆单独计在
    `negatives.causalClonesRejected = 2` ⇒ 合计 9 次检测器响应。）
```

---------------------------------------------------------------------------
 WP5 final acceptance（任务书 §10）
---------------------------------------------------------------------------
```text
K-27 = CLOSED
WP5  final acceptance = PASS（K-27 关闭 **且** WP5 全部门仍绿）

  逐条复核（WP5-16 的九条 + 本步的 K-27）:
    action attribution write path / readback        = PASS（wp5:verify 58/0）
    requestedBy false SYSTEM fallback eliminated     = PASS
    necessity matrix enforced                        = PASS
    Axis B always N/A                                = PASS
    execution truth unchanged                        = PASS
    attestation positive/negative/restore            = PASS
    inherited gates                                  = PASS（16 条命令全 exit 0）
    live DB untouched                                = PASS
    **K-27 initiator causal closure**                = PASS（wp5.1:verify 33/0）
  ⇒ **WP6 = READY / AUTHORIZED**
```

---------------------------------------------------------------------------
 架构偏差 / 已知问题（如实登记）
---------------------------------------------------------------------------
```text
1. 因果判据**刻意保守**：两个权威槽位不一致时返回 `Unknown(RUNTIME_UNRESOLVED)`
   而不是挑一个。因此"character 呈现了 user 提供的内容"这类事件的 initiator 会是 Unknown。
   若将来需要更细的因果链（例如"提议者 vs 执行决定者"分开表达），那需要新的槽位语义 +
   新裁定 —— 本步**没有**发明它。
2. `correlationSourceFromConversationEvent()` 是**受信调用点**（能 import 它的人就是受信的），
   与 K-25/K-26 的边界同一条约定：运行期登记挡的是**结构克隆 / JSON 往返 / 手写对象**，
   不是密码学证明。
3. `turn-gateway` 传的 `triggeringEvent` 来自它**读回来的** `userEvent`（recorder 的返回值）。
   如果那条 conversation event 是历史行（没有 RECORDED 归因），initiator 就是
   `Unknown(RUNTIME_UNRESOLVED)` —— 这是**设计**，不是缺陷：没有证据就不编。
4. `ActionTurnInput.speaker` 仍在，仍填 payload 的 `requestedBy`。因此
   **legacy payload 里仍会看到 `requestedBy.kind='user'`** —— 它是兼容/输入证据，
   **不是**权威 `initiator`（两者在门里被同时断言：payload 写 user，而 initiator 是 Unknown）。
5. 没有 schema 变更，没有 v9；`MIGRATION_0007` / `0008` 指纹逐字未变（门里断言）。
6. ADR-042 仍是 ACCEPTED / DESIGN FROZEN，本步没有改它（R-28 只进 Execution-Plan 的修订记录）。
```

---------------------------------------------------------------------------
 Next WP Preconditions（WP6 = READY / AUTHORIZED，但**不要在本 execution 开始**）
---------------------------------------------------------------------------
```text
WP6（Recorded Read Path & Replay）的前置现在齐了：
  □ conversation 侧与 action 侧都有**权威归因**落库，且都能逐字读回
  □ action 的 `initiator` 有**因果**证据链（K-27 CLOSED）
  □ 仍需遵守：不得合并 WP5.1 + WP6；Phase 4 / ADR-043 仍 NOT APPROVED；
    任何 schema 变更都必须新写 v9+（v7 / v8 都已是指纹锁定的历史 DDL）；
    不要顺手把 Developer Control（U-03）解决成"普通动作"
```
