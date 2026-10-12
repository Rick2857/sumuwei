# ADR-110：QQ 主动联系（时间提供机会，角色决定联系）

状态：ACCEPTED / DESIGN FROZEN（2026-10-06）。

计划：[`docs/post-lv2/QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](../post-lv2/QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md) ·
基线：[`docs/post-lv2/QQ-Proactive-Messaging-WP0-Baseline.md`](../post-lv2/QQ-Proactive-Messaging-WP0-Baseline.md)。

本 ADR 冻结**设计与边界**；它**不**宣布任何能力已可用，也**不**授权任何生产外发。
实现、门与激活分别在 WP1–WP7，生产激活需**独立授权**（先例 `ADR-048` / `ADR-065` / `ADR-067` / `ADR-071`）。

## 0. 这个 ADR 要回答的问题

让苏沐薇在**没有新入站消息**时主动联系本人，在现有架构里要做对的**不是"加一个定时器"**，而是六件事：

```text
① 时间从哪来         —— 今天没有任何调度器；`schedule` 已在枚举里登记，但运行闸直接拒绝
② 谁决定要不要发     —— 必须是**同一个角色模型**（人格/关系/情绪/合格记忆），不是插件、不是第二个 Agent
③ 怎么不伪装成入站   —— 不得把"请主动找本人"包成 user_message，也不得调 ChatSession.send() 冒充人类
④ 怎么真的发出去     —— 核心没有 QQ 连接；QQ 外壳只消费**有 pending 项**的 TURN_RESULT
⑤ 怎么不被重启刷屏   —— Croner 只有进程内防重叠；额度/冷静/实例必须落库
⑥ 怎么不谎报已读     —— OneBot 只给"接口接受 + message_id"，没有"本人已读"，也没有跨崩溃幂等凭据
```

## 1. 决定（D01–D14，含 D04a/D05a/D05b/D09a/D09b）

### D01 · 一个执行权威、一个库持有者、**一条低优先级后台 lane**

主动工作**不**新起进程、**不**新起调度权威、**不**并行第二套正式轮次链。
它在**唯一核心**（`--coexist` 的 owner 会话所在进程）内运行，并接入**同一个**串行权威。

`FairTurnScheduler`（`src/kernel/app/bridge/turn-scheduler.ts`）今天只有"人类入口"这一层
（闭环 `entries` + 轮转公平 + 每入口有界）。本 ADR 追加**第二层**：

```text
run(entry, task)          人类入口 —— 语义**一字不改**（闭环、轮转、有界、具名拒绝照旧）
runBackground(task)       后台主动工作 —— **仅当所有人类入口队列为空**时才被取走
                          同时刻**最多一个**后台任务在飞（计划 §4.4「最多一个候选在途」）
```

理由：轮转公平对人类入口是**特性**（一边连发十条不饿死另一边），对后台主动工作是**缺陷**
（把 1/3 的服务时间给一个可以被无限推迟的礼貌行为 ⇒ 用户多等）。把"用户优先"从一句承诺
变成**排队结构上的事实**，是这条决定的全部内容。

⚠️ 后台任务**不持有**音频播放锁，也不参与 `VoiceDeliveryLedger`。

### D02 · 时间只提供机会：Croner 提供内存时间触发，许可由**具名运行闸**给

时间组件 = **Croner 精确版本**（`10.0.1`，见基线 §2；替代候选 `node-cron` 只在 WP1 探针失败时启用）。
它**只**做一件事：到点了叫一下。它**不**持久化、**不**授权、**不**投递、**不**决定发不发。

`assertTriggerEnabledInM3_5()`（`src/kernel/contracts/job.ts:78`）今天只放行
`conversation` / `system`；`schedule` / `environment` / `external_event` **已登记但被运行闸拒绝**。

⇒ 本 ADR **不删旧断言、不放宽旧档**，而是**追加具名许可**：

```text
M3_5_ENABLED_TRIGGER_KINDS        保持 ['conversation', 'system']（历史事实，不许改写）
QQ_PROACTIVE_TRIGGER_PERMITS      新的**具名**许可表：{ processor 名 → 允许的 TriggerKind }
assertTriggerEnabledInM3_5(kind)  语义不变；新增**可选第二参**（processor）
                                  ⇒ 单参调用行为逐字节不变（既有门就是单参调的）
enqueueJob                        只有 processor 在许可表里时，才允许非 conversation/system 的 kind
```

即：**默认仍然是拒绝**（`schedule` 对任何未具名的处理器都会被拒），只有**具名**的后台处理器
（`qq-proactive-reminder` / `qq-proactive-care` 两个名字，WP2 冻结）能拿到 `schedule`。
计划 §2 的要求逐字："必须追加具名触发许可和新证据；不能因为枚举里有它就直接使用"。

**为什么是"按 processor 名作用域"而不是"按 kind 全局放行"（这是实测出来的，不是偏好）**：
既有冻结门 `scripts/verify-m3.5-persistence.ts:299-313` 用
`processor: 'm35-verify'` + `triggerKind: 'schedule'` 断言**必须被拒**；
`scripts/future-compat-tests.ts:998-1021` 又断言 `M3_5_ENABLED_TRIGGER_KINDS` 逐字为
`['conversation','system']` 且三种保留 kind 逐个抛 `trigger_kind_not_enabled`。
⇒ 任何"只要 kind 是 `schedule` 就放行"的全局放宽都会让这两道门直接红。
按 processor 名作用域则**天然兼容**：`'m35-verify'` 不在许可表里 ⇒ 仍然被拒。

⚠️ **一个必须同时修的既有缺口（实测）**：`enqueueJob`（`job-store.ts:114-151`）在
`:116` 命中"同幂等键已有非 failed 行"时**提前 return**，而 `:135` 的触发闸在那之后 ——
也就是说**撞键可以绕过触发闸**。本 ADR 要求把许可判定提到提前返回**之前**
（或在两条路径上都过一遍）。理由不是洁癖：不修的话，新许可会把一个既有的洞
放大成一条真实的越权入队路径。

⚠️ **另一条要如实登记的读数变化**：`scripts/verify-m5.1.1-wp9b-e4-selection.ts:203-210`
的静态探针 `C10` 期望 `src/` 里**非 `conversation` 的 triggerKind 字面量 0 命中**。
新处理器一旦在 `src/` 写字面量，这条读数会从 0 变正 —— 按"**新读数独立登记、旧断言不改**"
处置（计划 §9.1 逐字禁止删旧断言来制造全绿），**不是**把探针改松。

### D03 · 两类触发**同等优先**，但**选择权限不同**

| | 自主关心 | 明确提醒 |
|---|---|---|
| 来源 | 程序给的**时间机会**（无用户请求） | 本人真实请求里明确要求的单次提醒 |
| 角色能决定什么 | `silence` / `defer` / `send` **三者皆可** | **只决定措辞**；不能以沉默/延后自行取消 |
| 沉默的后果 | 记为"合法沉默"，零外发 | **不得**记作提醒完成；须记阻止原因 |
| 模型失败时 | 放弃本次机会 | 可用**已校验通知内容的程序模板**交付，并标明模板来源 |

⚠️ 明确的例外写死：**"已接受且到期、未取消、策略仍允许"的提醒不能被角色的 `silence` 取消。**
模板**不执行**原请求里引用的任何工具指令（它只复述已持久化的、已校验的提醒内容）。

提醒**不是**第二份目标/承诺：若绑定已有 `Goal` / `Commitment`，只保存其 **id 与 revision**，
结清/更正/遗忘/取消时**重新核对资格**。普通目标里出现截止时间**不自动**取得 QQ 通知许可。

### D04 · 私有选择调用：同一角色模型，专用"系统机会"装配，**闭集提案**

一次调用同时产出**选择与候选文字**，输出严格闭集：

```text
{"decision":"silence"|"defer"|"send", "reasonCode":"…", "sourceRefs":[…], "text":"…"(send 时)}
```

- 走的是**同一**模型档位与**同一** `ContextCompiler`，但额外注入一个
  **`system_opportunity` section**（程序生成：机会种类、允许时段、可用来源引用、剩余额度）。
- **禁止**把这次调用包装成 `user_message`，**禁止**调用普通 `ChatSession.send()` 冒充人类入站。
- `defer` 只允许**程序给定的范围**（有界延后），不允许模型自选任意时刻或建立循环。
- 模型**不能**指定收件 QQ、不能启用工具、不能改调度状态、不能触发记忆写入。
- 首版用既有严格 JSON 模式（与 `openai-tool-decision.ts` 同形的"一次调用就是一次调用"），
  **不**要求未经核实的原生 function calling。

理由：`openai-tool-decision.ts` 已经证明了这条形态在本仓库可行且可测（闭集分支 + 严格解析 +
`call_failed` 与 `invalid_output` 分桶）。此处**照形**而不是另发明一套。

⚠️ **"照形"仅限调用与解析形态**：role-tool-decision 的**输入面**与这里**不同形** ——
它的输入面在类型上就排除人设/记忆/检索（`tool-decision.ts:304-311, 359-365`），
而本功能要求"同一角色上下文"。见 D04a。

### D04a · 系统机会的装配纪律（四条硬约束，来自实证）

```text
① prompt 的唯一入口不放松：「系统机会」的 packet 必须由 `TurnGateway` 那一套
   provider 装配产生；本功能**不**另建一个编译器，也不手写 prompt。
   —— 但**不能**复用 `beginTurn`：`characterTurnContextOf` 在"既无 observation
      又无 currentInput"时抛 `turn_without_input`（`context.ts:406-418`），
      `compileTurn` 对非对话 observation 抛 `observation_render_not_supported`
      （`turn-gateway.ts:1481-1489`）⇒ 必须**新增一条不落用户事件的编译入口**
      （先例：`prepareTurn` 的"绝不经过 beginTurn/completeTurn"，`turn-gateway.ts:914-946`）。
② 新 section **只**经 `extraProviders` 插入。`sections.ts:1911-1914` 逐字要求
   「插入点只有这里：**绝不**把它放进 `buildContextCompilerV2` 的默认 provider 列表
   —— 那会让冻结基线变红」。
③ **"调用方不传 ⇒ 产 0 个 section"** 是硬纪律：`evals/fixtures/m3.5/prompt-baseline.txt`
   是**逐字节**冻结基线（AGENTS.md §3）。既有全部可选 section 都靠
   `render() === undefined ⇒ return []` 的形状保住它；`system_opportunity` 必须照同一条形状，
   否则 `pnpm m3.5:test` 会红 —— 而重刷基线是**独立动作**，不许顺手做。
④ section 的身份要**显式**：`ContextSectionKind` 是闭集，追加 `system_opportunity` 成员；
   取名会影响同优先级 section 的**字典序 tie-break**（先例：`external-evidence` 与
   `goal-state` 同为 45，靠 id 定序，`goal-sections.ts:58-61` 逐字警告过这件事）。
```

⚠️ trace 若需要新步：登记进 `TRACE_STEP_STAGE`（`observability.ts:337-433`），
且**不许**新开第 13 个观测阶段（`OBSERVABILITY_STAGES.length === 12` 是 M5.1 门的机器判据）。

### D05 · 能力 `qq.private.message` / `send`：`write` / **R2** / 固定本人 / 幂等必需，且 R2 **不外溢**

> ⚠️ **改名记录（WP5 实测逼出来的，2026-10-06）**：本 ADR 初稿与计划 §4.3 的候选名是
> `qq.private.send_text`。登记口**直接拒绝**了它 —— `ID_PATTERN`
> （`src/kernel/action/capability-registry.ts:87`）是 `/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/`：
> **段里不许有下划线**，操作名同一条（既有操作全是单词：`read` / `write` / `echo` / `act` …）。
> ⇒ 最终名 = **能力 `qq.private.message` + 操作 `send`**（对象=message、动词=send，
> 与 `local.file.read` 同形），权限名仍是 `qq:private_send`。
> 计划 §4.3 自己写着"名称是计划候选，尚未登记" ⇒ **改名不动语义**。
> ⚠️ 这**不是**可以顺手放宽的模式：`ID_PATTERN` 是登记口的失败关闭判据，
> 放宽它 = 改一条已验收的判据（且既有 id 会失去统一形状）。

追加登记一个新能力（`src/kernel/action/qq-proactive-capability.ts`，纯层，
不 import Croner/SQL/网络）：

```text
id            qq.private.message
operations    send   sideEffect=write   riskLevel=R2
sideEffectLevel = write      （合法：write 的风险下限是 R1，声明 R2 高于下限）
riskLevel       = R2
permissions     [qq:private_send]（装配层在 mode !== 'off' 时**条件授予**）
idempotency     required     （理由见 D07：重复发送是可见伤害）
supportsDryRun  true         （shadow 档靠它"完整产生选择与审计、不真的发"）
参数闭集        ['text']     （**没有**收件人字段）
目标类型        qq_private_owner（由绑定常量给 exact 置信度）
```

三条硬边界：

```text
① R2 **只**授给这一项本人私聊操作 —— 不提高全局 `CHARACTER_ACTION_MAX_RISK`（缺省仍 R1）。
② 目标由**现有绑定**生成确定证据（`readQqPrivateConfig().ownerId`），
   `ActionRequest.arguments` 里**没有** `user_id` 字段可用 —— 模型提供不了收件人。
③ 不自动继承文件写入 / 浏览器操作 / 搜索 / 任意 MCP；
   不使用鼠标、键盘、窗口或共享剪贴板发送（保持 M6.5-D2 的后台非干扰通道）。
```

⚠️ **三处实测出来的接线要求**（WP0 复核时补上，实施时**必须**照做）：

```text
① **R2 需要一个"具名作用域内的风险额度"**。今天唯一能抬高风险上限的机制是
   `ActionInvocationContext.riskBudgetOverride`，而它的注释逐字写着
   「**只有任务执行环**能设它，而且只能取自一份程序签发的任务授权；
     模型**没有**任何字段能把它写出来」。
   ⇒ 主动投递**不能**复用任务环（它不是用户任务 ⇒ 没有 TaskAuthorization）。
   本 ADR 冻结的做法：**在装配根**给这条能力一个**它自己的**额度来源 ——
   由主动策略开关（`qqProactiveMode === 'on'`）在同一次调用里签发
   `riskBudgetOverride: 'R2'`，而**这个值是程序常量**（不来自模型、不来自载荷、不进 `arguments`）。
   ⚠️ 它**只**对 `qq.private.message` 生效：网关层的额度是**按调用**给的，
      不是按能力查表；因此 WP5 **必须**在调用点断言"这次调用只带这一个能力"。
   ⚠️ 顺带如实登记：`idempotency: 'required'` 这个取值在仓库里**今天 0 个使用者**
      （唯一非 `none` 的是 `sandbox.file.write` 的 `'supported'`）⇒ 我们是第一个用它的人。
② **目标解析必须新增一支**。`resolveTarget` 是一个**按能力分派**的装配层函数；
   没有为它加分支的能力会落到**沙箱梯子**上，被 `inspectSandboxPath` 判越界
   ⇒ 表现为"策略拒绝 target_out_of_scope"，而不是"没接线"。
   ⇒ WP5 必须在 `resolveTarget` 里加一支：`type: 'qq_private_owner'`，
      `confidence: 'exact'`，证据是**绑定常量**（先例：`web.search` 用固定的
      `external_service` 目标、`math.calculate` 用固定的 `local_executor` —— 同样是"如实"而非猜测）。
③ **`L-QQP-01` 必须落在发送前复检之内**：单次触发的"可排期"判定
   （`floor(目标,秒) > floor(现在,秒)`）与**发送前**的时效复检是同一条判据的两处应用。
   只在排期处判、不在发送前判，会留下"以为排上了、其实从没排上"的静默空洞。
```

### D05a · 归因：**必须**新增一条具名写豁免（ADR-098 的豁免在结构上只接受只读）

`ACTION_ATTRIBUTION_EXEMPTIONS`（`src/kernel/contracts/attribution.ts:946-969`）今天只有一行
`pre_turn_lookup`，而收窄判据 `namedExemptionViolation()` **硬性**要求
`scope.sideEffect === 'read'` **且**实际登记的那个操作也是 `read`（`:1052-1061`）。
⇒ **具名豁免这条入口在结构上无法承载一个写能力**（这正是它的设计意图）。

两条候选与选择：

```text
候选 A  attestActionInitiatorUnresolved()  ⇒ initiator = Unknown(RUNTIME_UNRESOLVED)
        否决：那会写下"运行时定不下来 / 没有因果上下文"，而事实恰恰相反 ——
             这个机会由**一个具名程序调度器**产生，因果是明确的。
             用它是**不真实的归因陈述**（与 ADR-042/043 的立场相反）。
候选 B  在闭集里追加**一条具名写豁免**（本 ADR 采用）
        principal  = { kind: 'SYSTEM', id: 'qq-proactive-scheduler' }
        capability = 'qq.private.message'   operation = 'send'   sideEffect = 'write'
        basis      = 'named_system_schedule_with_recorded_occurrence'
```

**采用的形态**（`D05a` 冻结的形状，WP5 落地）：

```text
① ACTION_ATTRIBUTION_EXEMPTIONS 追加一行（闭集键，如 `qq_proactive_delivery`）
② namedExemptionViolation 的"只读"判据**保持缺省**：
   仍然要求 `read`，**除非**该行的 sideEffect 恰是 `write` **且**该行在闭集里
   —— 即"只读是通例，写是**逐条具名**的例外"，不是把闸门放宽成"随便什么副作用都行"
③ 新增 causalBasis 成员 `named_system_schedule`（`ActionInitiatorCausalBasis` 也是闭集，只追加）
④ `causalEventId` = 通知实例 id（**不是 null**）：这条动作确实有因果客体
⑤ 负控必须包括：换一个 capability / operation ⇒ 拒；换一个 principal ⇒ 拒；
   用只读豁免去发消息 ⇒ 拒；用这条写豁免去发**别的**东西 ⇒ 拒
```

⚠️ 这是**修改一条已验收的判据**（M5.1.1 / ADR-098 的收窄面），因此它必须：
带自己的正控 / 负控 / 恢复三段式 · 不改 `pre_turn_lookup` 那一行的语义（`D-18②` 式逐字核对）·
并且在报告里写清"**新增了一条例外**"而不是"收窄了豁免"。

### D05b · 效果：新增 `message_sent`，**不许**用 `none` 冒充

`ActionEffect.kind` 是闭集 `none | echo | file_created | file_overwritten | content_read | no_change`
（`src/kernel/action/action-request.ts:130`），**没有**"消息已发出"这一档。
而 `action-result.ts:131` 用 `kind !== 'none' && kind !== 'no_change'` 判"世界真的变了吗"。

```text
⇒ 若把本次投递记成 `none`：账本会写"世界没变"—— 而用户手机上多了一条消息。
   这是**假陈述**，且会同时污染"效果真的发生了吗"的每一处读数。
⇒ 本 ADR 采用：追加 `ActionEffect.kind` 成员 `message_sent`，附
   detail（平台受理语义）、fingerprint（正文指纹，**不是正文**）、messageId 走实例表而非 effect。
```

⚠️ 同样是闭集追加 ⇒ 需要负控（`message_sent` **不**能被只读能力产出；
投递失败**不得**报 `message_sent`）。这三个追加（`causalBasis` / 豁免行 / effect kind）
都要按"改判据 = 改对应门并重新出证据"处置。

### D06 · 闭集双向协议 + **唯一投递连接**（不新开数据库）

核心与 QQ 外壳之间**追加两条**受控消息（命名在 WP0 冻结，此处定名）：

```text
核心 → 外壳   DELIVER_QQ_TEXT      { kind, requestId=<deliveryId>, deliveryId, attempt, text }
外壳 → 核心   REPORT_QQ_DELIVERY   { kind, requestId=<deliveryId>, deliveryId, status, messageId?, code? }
```

- **`requestId = deliveryId`**：复用既有的关联字段，而不是新造第二个。
  今天 `handleBridgeMessage` 已把 `requestId` 规范化成 `''`（非字符串）并按**每个 kind**
  各自校验必填字段（先例：`REPORT_SYNTHESIZED` 要 `segmentId`、`CANCEL_TURN` 拒空 id）⇒
  `REPORT_QQ_DELIVERY` **必须**要求 `deliveryId` 非空，其余照同一条纪律办。
- `DELIVER_QQ_TEXT` 经**注入的**出站通道写出（与 `setOutputSink` 同形，
  `src/infrastructure/bridge/turn-bridge-transport.ts:491`）—— 核心侧**不**直接碰 socket。
- `REPORT_QQ_DELIVERY` 登记为**控制类**消息（`isBridgeControlMessageKind`）：
  它只更新进程内投递登记，不写库、不调模型，因此**不排队**（否则慢轮次会把它压到轮末）。
- 旧 `SUBMIT_TURN` / `TURN_RESULT` 的**回复语义一字不改**：`TURN_RESULT` 仍**只**由
  "有 pending 项的那一轮"消费，主动投递**不**复用它的 kind，**不**复用任何活着的 `requestId`。
  这条是必须的 —— 现状里"哪条消息是哪一轮的结果"**只**靠 kind 过滤 + `requestId` 匹配
  （`src/infrastructure/qq/lg-stdio-client.ts:70-75`），复用就会让某一轮被错误地 resolve。
- `REPORT_QQ_DELIVERY` 与皮套入口**互不相通**（皮套既不能消费投递回执，也不能提交它）。
- **唯一投递连接**：多条 QQ 外壳连接时，只有**当前代次**的那条能投递；
  回执按 `deliveryId` **且按连接代次**绑定 —— **旧代次的回执不得覆盖新状态**。
- QQ 外壳仍是"不打开数据库"的那一侧；核心仍是唯一库持有者。
- **顺序保证落在 QQ 外壳的发送队列上，不落在核心→外壳的线缆上**：
  核心侧 `write` 今天**无锁**（`turn-bridge-transport.ts:480-483`），
  所以"主动句与它打断的那一轮结果谁先"在**协议上**没有保证 —— 也不该有：
  真正的串行由外壳的**单条发送队列**给出（现状 `onebot-private-client.ts:126`
  的 `this.queue = this.queue.then(...)` 已经串行），**普通回复优先**的判据落在那里。
  ⚠️ 因此 WP5 **必须**让主动投递与轮次回复**共用同一条队列**，
  而**不是**各写一条 —— 后者正是"相互穿插"的定义。

⚠️ 现状（基线 §4）是：`LgStdioClient` 收到非 `TURN_RESULT` 的行**直接丢弃**
（`src/infrastructure/qq/lg-stdio-client.ts:70`），而 `BridgeWireResponse` 的 `kind` 是**闭集**。
⇒ 两条新消息必须**显式**登记进那两张受控表，不能靠"多一个 kind 也能解析"。

### D07 · 持久化：新增通知意图/实例表（下一号迁移），stable **occurrenceKey**

Croner **只是内存触发**。以下全部落库，否则重启会重置频率或重复发言：

```text
通知意图   owner/character/QQ 会话绑定引用、触发种类、原来源引用、排期与时区、
           许可/来源版本、状态、取消状态
通知实例   occurrenceKey（稳定）、有界候选正文、正文指纹、最终助手事件引用、
           预算占用、OneBot messageId、失败/未知原因
```

- `occurrenceKey` 的构造**稳定且确定**：
  提醒 = `通知 id + 计划版本 + 本次预定时刻`；关心 = `owner + 许可版本 + 时间机会键`。
- 发送幂等由**持久实例 + 唯一占用**保证（**唯一**索引/唯一约束），**不靠**内存 `Set`、不靠随机 `requestId`。
  ⚠️ **不许照抄** `character_action_events_idempotency`（`migrations.ts:739-740`，那是**非唯一**索引）；
  结构性不变量用**表内 CHECK** 表达（先例：`storyline_consumer_watermarks`，
  `migrations.ts:1517-1537`，如 `status='api_accepted' ⇒ message_id is not null` 的同型写法）。
- 既有 `character_jobs` **只**管处理尝试的运行状态；**`job.completed` 不等于已送达**。
- `character_jobs` 的"failed 可重建"**不**变成外发重试规则（见 D08）。
- **无外键**是本仓库既有约定（`migrations.ts:1393-1394` 逐字：「本仓库既有 DDL 一律不用 FK」）：
  与 `Goal` / `Commitment` 的关联靠**保存 id + revision** 与显式完整性探针，不靠 FK。
- `status` 词表收进 CHECK（`character_jobs.status` 恰好**没有** CHECK —— 那是不该重复的先例）。
- **时间触发器的每个"实例"必须自带遗留处置规则**：`character_jobs` 没有 lease / next_run_at，
  且**没有中心 worker loop**（全仓 `setInterval` = 0 命中；`pending` 遗留无人拾取）。
  现有先例只有"启动时把遗留 `running` 改判 `failed`"（`reflection-scheduler.ts:46-51` /
  `agreement-scheduler.ts:50-53`）。本功能的 `dispatching` 遗留按 D08 的"**隔离**、不重发"处理。

⚠️ 本 ADR **不**提前占用迁移号、**不**改任何既有 DDL。迁移只在 WP2 形成具体候选后按当时注册表顺延
（当前最高 = `0013`，基线 §5）。新迁移的连续性判据必须写成**动态式**
（先例 `scripts/verify-m5.1.1-migration.ts:185-186` 的 `latestSchemaVersion() === MIGRATIONS.length`），
**不写常量** —— 三处历史脚本写死 `=== 9` 的教训（基线 §6.1）。

### D08 · 交付真相**五态 + 三个终态**；不承诺 exactly-once

```text
pending → evaluating → prepared → dispatching → api_accepted
    └──────────────→ skipped / cancelled / expired
                            dispatching → failed_confirmed / delivery_unknown
```

| 情况 | 记录 | 允许的后续行为 |
|---|---|---|
| 尚未交给发送器 | 仍是未发送，原因具名 | 连接恢复后**重新预检**；时效允许才处理 |
| 发送前确定连接不可用 | 未发送，**不报已送达** | 关心丢弃；提醒在有效期内等待连接 |
| OneBot 明确成功且有 `message_id` | `api_accepted` + 实际回执 | 记为**平台接口接受**，**不记本人已读** |
| 明确拒绝 | `failed_confirmed` + 理由 | 首版**不自动重发**；保留原实例，由新请求处理 |
| 超时 / 发出后断线 / 发后未落回执即崩溃 | `delivery_unknown` | **不自动重发**、**不声称一定没送出**；占用频率额度 |
| 重启时遗留 `dispatching` | 结果不明，原实例保留 | **隔离**该实例避免重复；不按 failed 作业一律重跑 |

QQ 协议**没有**本计划可依赖的跨崩溃幂等发送凭据 ⇒ 本 ADR **不承诺** exactly-once。
未知状态一律**按避免重复处理**，代价是可能漏发一条提醒 —— 这个代价写进局限，不隐藏。
"标记后、网络前崩溃"也是未知项，同样列入局限。

### D09 · 隐私与来源边界：正文**不进** ActionRequest / 账本 / trace

```text
候选正文    只存通知实例的**有界私有内容字段**
ActionRequest.arguments   不放正文
行动账本 / trace          只放**实例引用 / 指纹 / 长度**
作业错误信息 / 遥测        不放正文
核心 → 外壳的受信线缆      需要正文（它是投递通道）
最终私聊                   需要正文
```

只有**平台接受之后**才向 QQ 会话追加正式助手输出及对应交付事实，
并标明 **API 接受不代表本人已读**。候选**不能提前**当成已经发生的对话，
也**不触发**关系 / 情绪 / 反思消费者。

### D09a · 落账形态：必须先有一个**真实的**回复目标（这是硬冲突，必须裁定）

`assistant_message` **必须**带 `replyToEventId` —— 三条独立实现都强制：
`conversation-integrity.ts:166-172`（`reply_target_required`）、
`conversation-recorder.ts:361-367`、`ledger.ts:103-136` + `validateReplyGraph`。
注释逐字："assistant_message 必须带 replyToEventId：否则无法回答『这条回复在回应什么』"。

而主动消息**没有**用户事件可回指 ⇒ 三个候选：

```text
甲（本 ADR 采用）把回复目标建成**真实的**既有事实，分两类：
   · 明确提醒  ⇒ 回指**原请求的那条 user_message 事件**（通知意图里已保存的原来源引用）。
                  "这条是她对那次请求的履行"——语义最准确，且那条事件确实更早、同会话、同角色。
   · 自主关心  ⇒ 在**交付时**写一条 `system_event`（"时间机会成立"），assistant_message 回指它。
   ⚠️ 两者都**不**伪造用户发言：前者用的是**用户真的说过**的那条事件，后者用的是**系统事实**。
乙  新增一个事件种类 ⇒ 牵动 `ConversationEventType` / 身份矩阵 / 迁移 / 已冻结面附近，代价大。
丙  放松 `validateReplyGraph` 对 assistant_message 的回指强制 ⇒ **否决**：
   那是 M3 已验收的完整性规则，放松会破坏"这句话在回应什么"的可审计性。
```

⚠️ `validateReplyGraph` 只校验"存在 / 同角色 / 同会话 / 序号更早"，**不**约束目标的 type
（`conversation-integrity.ts:176-199`）⇒ 甲在类型上是通的。但**必须**逐条核对：
用户请求事件被**遗忘/撤销遮蔽**时，回指是否仍然合法（延伸阅读：`withdrawnContextMasking`），
若不能，则该提醒按"来源失效"处理（D11 ③），**不**改用别的目标顶替。

### D09b · `system_event` 是**首次真正接线**，必须自带 producer 与证据

```text
① `ConversationRecorder.recordSystemEvent`（`conversation-recorder.ts:390-407`）今天**全仓零调用点**
   —— M5.1.1 的门把它实测登记为 `DEAD / UNREACHABLE`。本功能是它**第一个**真实生产者。
② `system_event` 的正文**不许为空**（`conversation-event.ts:276-282`）⇒
   "只带 metadata 的系统事件"在实现上不成立；正文必须是**程序生成**的、有界的、
   **不携带用户内容**的短句（如"到点了：一次既定的提醒机会"）。
③ `system_event` 族的**生产 attribution factory 不存在**（`conversation-attribution.ts:354-367`
   只装 4 个；`CONFIRMING_ATTESTATION_BY_FAMILY.system_event = 'system_instruction_source'`
   已登记但**没有 producer**）⇒ 必须**新增一个具名 producer**（先例：QQ 那条
   `createHumanQqPrivateUserTurnIngress`，`conversation-attribution.ts:259-281`），
   否则这两条写入会落到 legacy（`attribution_origin` 为 NULL），而那正是 M5.1.1 要消掉的东西。
④ **不许**拿首启 `state_events(trigger='init')` 的既有 PASS 顶替 ——
   M5.1.1 明确分开 `State SYSTEM ≠ Conversation SYSTEM`（`R-47`）。
```

### D10 · 用户优先与发送前复检

- 收到真实入站时**立即**更新活动版本（**不**等这一轮执行完才更新）。
- 生成前读版本；**发送前**复核：活动版本、授权版本、来源 revision、目标、连接、时段、额度。
- 本人在 **QQ 或皮套**开始新一轮对话 ⇒ 取消**旧的自主关心候选**；
  明确提醒按其明确许可**重新判断时效**。
- 停用与新入站必须能**中止候选模型调用**；迟到结果不提交。
- 最终复检、预算占用与投递意图提交**在同一核心串行边界内**完成。
- ⚠️ 网络请求**已经发出后不能撤销**：记录实际先后与竞态范围，**不宣称**零延迟影响。

### D11 · 认知边界：系统机会不产生用户事实

```text
① 调度事件、候选文字、模型自身猜测 **不得**升级成用户事实 / Belief 背书 / 长期记忆。
② 实际助手发言按**真实来源**进原事件链；真实本人后来的回答才走既有用户消息与明确记忆操作。
③ 候选引用必须在**生成前与发送前**各核对一次；遗忘 / 来源失效 / 任务结清使旧候选失效。
④ ContextCompiler 沿用既有**遗忘遮蔽**，**不**读绕过遮蔽的原始历史副本。
⑤ QQ 的近期窗口**只读 QQ 自己的会话**；其它入口的近期原文**不**因主动调度流入 QQ。
   （这依赖 `CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true`；关着时**不**提供主动功能 —— 见 D14。）
```

⚠️ **刻意不复用** `src/kernel/app/bridge/character-output.ts` 的闭集：那个闭集
（`wake_response` / `mid_turn_correction` / `authorized_lookup_notice`）的注释逐字写着
"刻意**不包含**主动闲聊、日程提醒、后台任务完成 —— 它们属于系统主动发起，是另一条线（`TD-19`）"。
主动联系**就是**那条线，因此它走**自己的**投递路径，不从那个闭集溜进去。

### D12 · 停机与恢复：先停触发 → 取消未发 → 排空 → late-write fence → INC-01

```text
① 先停**新触发**（Croner stop；不再产生新机会）
② 取消**尚未发送**的候选（未提交网络的项取消）
③ 排空在途投递（有界）
④ 走既有 late-write fence
⑤ 走 INC-01 的唯一关闭链（`runtime-shutdown.ts`）
```

一个调度器、一个库持有者；**不**另启会打开 `data/pglite` 的提醒进程。

### D13 · 回滚：改模式，不删数据、不恢复快照

```text
即时暂停      新候选停止；尚未提交网络的项取消
配置回滚      `CHARACTER_QQ_PROACTIVE_MODE` 改回 `off`（或删该行）+ 正常重启
保留          会话、投递/行动记录、迁移表、真实记忆、已创建的提醒与通知记录（禁发）
不自动做      不恢复数据库快照；未知交付保持未知
再启用        重新检查时效与许可；**不补发**积压问候
彻底撤销      旧候选与排期失去外发资格；新许可采用**新版本**，改回 `on` **不复活**旧授权
```

### D14 · 参数与开关（**待冻结的建议值**，WP1/WP2 落地时逐条确认）

一个具名策略配置，**不**为每项规则新建管理服务；所有开关**代码缺省 off/false**，
激活属**独立裁定**（先例 `ADR-048`）。

| 项目 | 建议默认值 | 约束 |
|---|---|---|
| 模式（总开关 + 三档） | `off`；验证档 `shadow`；正式档 `on` | `shadow` 完整产生选择与审计，**不**调用真实发送（靠 `supportsDryRun`） |
| 时区 / 自主活动时段 | `Asia/Shanghai`，09:00–22:00 | **不**继承宿主机时区；22:00 后不自主问候 |
| 机会检查 | 每 30 分钟 | 先做**程序预检**；不等于每次调模型或发消息 |
| 自主关心空闲 / 冷却 | 两路真实入站空闲 ≥ 2 小时；关心间隔 ≥ 3 小时 | 连续聊天不评估；**重启不重置** |
| 自主关心上限 | 每日 ≤ 2 条；有 1 条未得到新入站回应时暂停继续关心 | API 接受与结果不明**均占额** |
| 模型评估预算 | 自主评估每日 ≤ 4 次；单次 15s / 输出 ≤ 500 token | **无隐式重试**；另记实际输入 token |
| 明确提醒 | 首版 ≤ 20 个待办；全类主动消息每日 ≤ 10 条 | 明确许可独立于关心限额，但**不绕过**总上限 |
| 迟到处理 | 关心机会过期丢弃；单次提醒逾期 30 分钟后 `expired` | 休眠/重启**不批量补发**；过期不伪报已提醒 |
| 夜间明确提醒 | 普通提醒顺延到下一个允许时刻；本人明确指定夜间时间可**仅该条**例外 | 创建时说明最终时刻；例外**不**变成全局放开 |

⚠️ **前置依赖（写死在装配里，失败关闭）**：主动功能要求
`CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true`。关着时两条入口共用一条会话，
"QQ 的近期窗口只读 QQ 自己的会话"（D11 ⑤）在结构上不成立 ⇒ **拒绝启动主动调度**，
而不是"将就着开，反正是低概率混入"。

## 2. 七槽归因（按**仓库现有的槽位语义**登记，不是按直觉）

> ⚠️ **本节已在 WP0 复核后修正**：初稿把"角色选择与内容产出者"写成 `actor = character`、
> 把"QQ 执行器"写成 `executor = tool`，这两条**与代码不符**。
> 实测（`src/kernel/action/gateway.ts`）：
> **actor 恒为 `SERVICE/<决策点>`**（`:319-325`，由 `attestActionActorFromDecisionPoint` 给，
> 语义是"**决策点**对这条事件负责"），**executor 恒为 `SERVICE/adapter:<capability>`**（`:304-307`）；
> 且行动族的 `contentOriginator` **必须 Absent**（`NECESSITY_MATRIX` 的 `action_requested` /
> `action_side_effect_execution` 两行）。要表达"角色是 actor / 执行器是 tool"就得**改鉴证**，
> 那会波及 M5.1.1 已冻结的门与夹具 ⇒ 本 ADR **不改**，而是**按既有语义如实填**。

| 槽（仓库槽位名） | 本功能里的值 | 依据 |
|---|---|---|
| `initiator` | `SYSTEM/qq-proactive-scheduler`（**具名**，经 D05a 的新豁免） | "谁真的造成这次动作" = 具名程序调度器；`causalEventId` = 通知实例 id |
| `actor` | `SERVICE/action-gateway` | **决策点**；由 `attestActionActorFromDecisionPoint` 给，代码里是硬编码的（`:319-325`） |
| `executor` | `SERVICE/adapter:qq.private.message` | 适配器身份（`attestActionExecutorFromAdapter`，`executorBound` 之后才有） |
| `authority` | `CAPABILITY/qq.private.message` | 由 gateway 自动给（`:419-422`） |
| `recordedBy` | `SYSTEM/kernel` | 恒值（`CANONICAL_LEDGER_RECORDER`） |
| `contentOriginator` | **`Absent`** | 行动族**必须** Absent（矩阵），不能提供 |
| `subject` | `CHARACTER/<characterId>` | 由 gateway 派生（不落列） |

**"是角色自己选择要发"这件事记在哪**（这是本节修正后必须回答的问题）：

```text
① 对话账上: 那条**已交付**的 assistant_message 事件 —— actor = Known(CHARACTER/<id>)、
   contentOriginator = Known(CHARACTER/<id>)（经 `createCharacterAssistantTurnIngress` +
   `character_self_generation` 鉴证）⇒ "这句话是她产出并说出的"有权威归属。
② 通知实例行: 候选正文指纹 + 选择理由码 + 机会键 ⇒ "这次选择发生了"可查。
③ trace: 那一次私有决策调用的步骤与读数。
```

⇒ 于是"角色选择"**不**靠动作账本的 `actor` 槽表达（它在既有语义下表达不了），
而靠**对话账的产出者槽 + 实例行 + trace** 三者合起来表达。
⚠️ **不主张**"动作账本里能看出是她选的" —— 这一点如实登记为本设计的**边界**
（`L-QQP-02`），不要拿它当"归因已覆盖角色"的证据。

⚠️ 系统 / 角色 / 执行器**按实际因果登记**。**不能**仅改 `requestedBy` 就声称归因成立，
也**不能**把预先许可当成"用户刚刚说了一句话"（那正是 D04 禁止的伪装）。行动 Axis B 继续不适用。

## 3. 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 直接装 AstrBot 主动聊天插件（`v1.2.6`） | 它读 AstrBot 会话/persona、调 AstrBot Provider、经 AstrBot 发送并保存历史 ⇒ 绕过 LG 的 ContextCompiler / 归因 / 回复守卫 / 行动账本，且要额外维护 Python 环境（基线 §2.1）。这是**兼容性判断**，不是"插件功能差" |
| OpenClaw Heartbeat / Automations 整套网关 | 要求 Node ≥24.16，而本仓库是 Node 22；且它是**完整 Agent 网关** ⇒ 第二份权威（基线 §2.1） |
| 复用 `character-output.ts` 的闭集插话通道 | 那个闭集**逐字**排除主动闲聊与日程提醒（D11）；从那里溜进去等于偷偷放宽一条已验收的边界 |
| 把主动联系包成一条 `user_message` 再走 `ChatSession.send()` | 违反 D04/D11：合成用户发言会污染事实账本与用户资格，且它是"假装本人说了话" |
| 让模型决定收件 QQ / 时间 / 开关 | 违反 D05 ② 与 D04：收件人由绑定生成，时刻与许可是程序事实 |
| 用内存 `Set` / 随机 `requestId` 做发送幂等 | 违反 D07：重启即失效，重复发言是可见伤害 |
| 承诺 exactly-once 或"未收到回执就重发" | 违反 D08：QQ 协议没有该凭据；重发会把"可能已送达"变成"确定送两次" |
| 提高全局 `CHARACTER_ACTION_MAX_RISK` 到 R2 | 违反 D05 ①：那会一次性放开所有 R2 能力（浏览器操作等） |
| 为主动功能新起一个进程 / 第二个库持有者 | 违反 D01 与 `INV-DB-01`：租约必然拒绝，且会变成第二份认知 |
| 首版就做群聊 / 多用户 / 图片语音 / 主动执行任务 | 计划 §1 明确列为**后续范围**；不得从本人的 QQ 外发许可继承这些能力 |

## 4. 不变量与冻结面（本 ADR **不动**的部分）

- `INV-DB-01…07`（单持有 / 快照 / 关闭 / incident hold）**全部照旧**。
- `INV-CI-01…05`（认知完整性／特权认知操作）**照旧**：主动联系**不**是注入入口，
  它不写长期认知，也不新增特权操作路径。
- Memory Kernel 语义（`src/kernel/app/memory/**` 等冻结面）、M5.1 权威地图、
  `artifacts/**` 历史证据：**不动**。
- `M3_5_ENABLED_TRIGGER_KINDS`（`['conversation','system']`）作为**历史事实不改写**；
  新许可只**追加**，且默认仍是拒绝（D02）。
- `TurnBridge` 的 `SUBMIT_TURN` 语义、`CHARACTER_OUTPUT` 的闭集、皮套入口的交付账：**不动**（D06/D11）。
- M4.5 的 `createDefaultCapabilityDefinitions()`（三个能力）**不动**；新能力**追加**（先例 `ADR-045 D-11/D-12`）。
- 三条跨里程碑硬性质（Assistant Fact Firewall / 投影可重放 / 有副作用必有账本与 traceId）：**照旧**。

## 5. WP0 → WP7 的落地顺序

```text
WP1  隔离安装 Croner 10.0.1 + 兼容探针（Node22 / ESM / tsx / 时区 / 单次 / 防重叠 / 停止 / 退出）
     失败 ⇒ 保留证据并按基线的替代候选逐项核对，**不得**以"装上了"收口
WP2  迁移：通知意图/实例表；`enqueueJob` 的具名 schedule 许可；重启恢复 / 时效 / 配额
WP3  通知入口（空闲关心机会 + 正式入站单次提醒）；创建 / 改时 / 取消 / 暂停恢复；时间歧义澄清
WP4  专用 ContextCompiler 系统机会 section + 闭集提案 + 来源复核 + 回复守卫；shadow 档
WP5  能力登记 + 固定目标解析 + scoped R2 许可 + Gateway 适配器 + 闭集双向协议 + 唯一投递连接
WP6  整链矩阵（计划 §9 全部场景）+ 量具三段式 + 真模型行为 + 回归；失败档全保留
WP7  使用/回滚说明 + 激活候选 + 迁移预演 + 生产开关候选；获准后才做正常切换
```

WP3–WP5 每个包都覆盖**两类触发**；两类均通过才进入正式交付，
**不**单独发布其中一类来宣称完成。
