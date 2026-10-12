# QQ 主动联系 WP5 —— 能力登记与投递协议（记录，2026-10-06）

> 载体：计划 [`QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md) §4.3 / §7 / §8 的 **WP5** ·
> 设计 [`ADR-110`](../adr/ADR-110-qq-proactive-messaging.md)（`D05`/`D06`/`D08`）· WP0 [`Baseline`](QQ-Proactive-Messaging-WP0-Baseline.md) ·
> WP1 [`Croner-Probe`](QQ-Proactive-Messaging-WP1-Croner-Probe.md) · WP2 [`Record`](QQ-Proactive-Messaging-WP2-Record.md) ·
> WP3 [`Record`](QQ-Proactive-Messaging-WP3-Record.md) · WP4 [`Decision-Record`](QQ-Proactive-Messaging-WP4-Decision-Record.md)。
>
> WP5 的通过条件逐字（计划 §8）：**"模拟 OneBot + 真核心无入站情况下，两类候选均实际执行 send API；
> messageId/未知状态/来源/账本对账；另一路保持可用。"**
>
> ✅ **本记录覆盖 WP5 的 `A` 半（能力登记）与 `B` 半的①②③⑥（协议 + 外壳侧投递）**；
> ❌ **`B` 半的 ④⑤⑦（唯一投递连接 / 投递适配器与回执落账 / 账本对账）尚未开始** —— 见 §5。

---

## 0. 一句话

```text
能力 `qq.private.message` / `send` 恒登记（`write` / **R2** / 幂等必需 / 参数闭集只有 `text`）；
闭集双向协议 `DELIVER_QQ_TEXT`（核心→外壳）/ `REPORT_QQ_DELIVERY`（外壳→核心）已登记、回执是**控制类**、
四条失败关闭与出站上界都有具名码；
**外壳侧端到端已跑通**：假核心发一条投递 ⇒ 外壳**真的**调用 `send_private_msg`（owner 固定）
⇒ 三态回执（`api_accepted`/`failed_confirmed`/`delivery_unknown`）逐条对账。
门：`pnpm postlv2:qq-proactive:verify` = **96 通过 / 0 失败**（measured_count = 96），EXIT 0。
⚠️ 候选名 `qq.private.send_text` 被登记口**直接拒绝**（`ID_PATTERN` 不许下划线）⇒ 已改名 `qq.private.message`。
```

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/action/qq-proactive-capability.ts`（**新**） | 能力声明 · 参数闭集 · **收件人字段黑名单**与两条复核函数 · 正文上限 |
| `src/kernel/action/tool-catalog.ts`（改） | `ToolGateKey` 加 `qqProactiveMode`；`TOOL_GATE_KEYS` 加一行 |
| `src/kernel/action/task-plan.ts`（改） | `TASK_ARG_KEYS['qq.private.message'] = ['text']` |
| `src/kernel/app/flags.ts`（改） | `qqProactiveMode`（**缺省 off**，非法值失败关闭回 off）+ **具名策略配置** `readProactivePolicy()`（11 项，全在安全侧） |
| `src/main.ts`（改） | 注册进登记表（恒登记）· 权限**条件授予**（`mode !== 'off'`） |
| `src/kernel/app/bridge/turn-bridge.ts`（改） | `BridgeMessageKind` + `BridgeWireResponse.kind` 各加一个成员 · `BridgeQqDeliveryStatus` 闭集（三态）· `TurnBridgeHost.reportQqDelivery?` 端口 · `handleBridgeMessage` 新 arm（**四条具名失败关闭**）· `TurnBridge.deliverQqText()`（出站，有界，四条具名拒绝） |
| `src/infrastructure/qq/lg-stdio-client.ts`（改） | `setQqDeliveryHandler()` · `DELIVER_QQ_TEXT` 不再被丢弃（**仍不经 `pending`**）· 回执写回（非接受**不带** `messageId`）· 唯一写口 `writeLine()` |
| `src/infrastructure/qq/onebot-private-client.ts`（改） | `sendText` 返回回执 id · **公开**主动发送面 `deliverProactiveText()`（**同一条** `this.queue`，**普通回复优先**，三态、不重试） |
| `scripts/qq/chat.ts`（改） | 装上投递处理器（外壳仍**不打开数据库**） |
| `scripts/kernel-tests-action.ts`（改） | **手写消费锁 ×4**（§9.16–§9.19） |
| `scripts/postlv2-role-tool-verify.ts`（改） | 夹具登记表与"八工厂同形"清单各加一项（见 §3） |
| `scripts/postlv2-qq-proactive-verify.ts`（扩） | §16（能力登记 8 项）· §17（协议 10 项）· §18（**外壳侧端到端 5 项，含模拟 OneBot**） |

---

## 2. ⚠️ 改名：候选名不可登记（本轮第 3 处"设计 ↔ 代码"冲突）

```text
ADR-110 D05 / 计划 §4.3 的候选名：`qq.private.send_text`
登记口直接抛：invalid_id: 能力 id 不合法：qq.private.send_text
              invalid_operation: qq.private.send_text 的 operation 名不合法：send_text
依据：ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/（capability-registry.ts:87）
      —— 段里**不许有下划线**；操作名同一条（既有操作全是单词：read / write / echo / act / list …）
⇒ 最终：能力 `qq.private.message` + 操作 `send`（对象=message、动词=send，与 `local.file.read` 同形）
```

**没有**放宽 `ID_PATTERN`：那是登记口的失败关闭判据，放宽它 = 改一条已验收的判据，
而且会让既有 id 失去统一形状。计划 §4.3 自己写着"名称是计划候选，尚未登记" ⇒ 改名不动语义。
三处文档已按"不回写 + 修订节"处置（ADR-110 的 D05 改名记录、WP0 基线顶部修订节、计划 §4.3 的补记）。

---

## 3. ⚠️ 一处**真的**跨门耦合（量具把它抓出来了）

加了 `TASK_ARG_KEYS` 一行之后，`pnpm postlv2:role-tool:verify` **立刻变红**：

```text
× wp0-no-stale-arg-rows 参数白名单与登记表同源（没有"写了却不存在"的漂移行）
observed = {"problems":[{"code":"stale_arg_keys",
  "message":"TASK_ARG_KEYS 里有一行 qq.private.message，但它没有被登记 —— 表与登记表漂移了"}]}
```

原因：`auditToolCatalog()` 的判据 ④ 是**反向**的 —— 它按 `TASK_ARG_KEYS` 遍历，
**任何**没有出现在**那一次**登记表里的一行都会被判成漂移。而那个门用的是**它自己的夹具登记表**。

⇒ 处置（**先例**是 ADR-106 的桌面两件）：把新能力的工厂加进那个夹具的 `buildRegistry()`
与 `wp0-main-assembly-parity` 的工厂清单。**没有**删改任何旧断言 —— 只是让夹具与生产同源。
⚠️ 这条耦合值得记住：**"往 TASK_ARG_KEYS 加一行"会同时动到另一个里程碑的门**。

---

## 4. 判据与读数（§16）

| # | 判据 | 读数 |
|---|---|---|
| 1 | 能力**恒登记**在装配层，且**不在** `TASK_CAPABILITY_IDS` 里 | `...createQqProactiveCapabilityDefinitions()` 在；候选表里**没有**它（计划 §7："本批新增 NONE"） |
| 2 | 权限**条件授予** | `this.flags.qqProactiveMode !== 'off' ? [QQ_PRIVATE_SEND_PERMISSION] : []` ⇒ `off` 时得到可审计的 `missing_permission` |
| 3 | 声明形状 | `write` / **R2** / `idempotency='required'` / `supportsDryRun=true` / 单操作 `send` |
| 4 | 登记完整性 | `TOOL_GATE_KEYS` = `qqProactiveMode`；`TASK_ARG_KEYS` = `['text']` |
| 5 | **收件人不可提供**（负控 ×7） | `user_id` / `ownerId` / `to` / `recipient` / `qq` / `uin` / `userId` ⇒ 逐个 `qq_send_recipient_from_argument` |
| 6 | 未声明参数（负控） | `qq_send_unknown_arg`；合法参数通过 |
| 7 | 参数闭集与黑名单互不重叠 | `['text']` 与黑名单无交集 |
| 8 | 策略配置缺省在安全侧 | `Asia/Shanghai` 09:00–22:00 · 关心 ≤2/日 · 全类 ≤10/日 · 评估 15000ms · 待办 ≤20 · 逾期宽限 30min |

**手写消费锁**（`m4.5:test`，§9.16–§9.19）—— 本仓库**没有**"枚举全部 flags 逐个检查消费者"的通用锁，
新开关必须自己加一条，否则正好长成 D3 惰性开关的形状：

```text
§9.16 qqProactiveMode 必须被 main.ts 真的消费（决定 capability 权限是否授予）
§9.17 它**不在**任务候选表里（按 `const TASK_CAPABILITY_IDS` 那个数组字面量的原文断言）
§9.18 缺省 off；拼错的值（`onn`）失败关闭回 off；`shadow` 正常识别
§9.19 策略配置的时区不继承宿主机（传 TZ=UTC 也读成 Asia/Shanghai）
```

---

## 4b. WP5-B 协议与外壳侧（§17/§18 读数）

**协议（§17，10 项）**：

| 判据 | 读数 |
|---|---|
| 两个新 kind 显式登记 | 入站受控表 = `[SUBMIT_TURN, CANCEL_TURN, REPORT_SYNTHESIZED, REPORT_PLAYBACK, PREPARE_TURN, REPORT_QQ_DELIVERY]` |
| 回执是**控制类** | `REPORT_QQ_DELIVERY` / `PREPARE_TURN` 是；`SUBMIT_TURN` 不是 |
| 结局闭集**三态**，刻意**无** `delivered`/`read`/`seen` | `api_accepted` / `failed_confirmed` / `delivery_unknown` |
| 出站写出**一行**，`requestId` = `deliveryId` | `kind=DELIVER_QQ_TEXT requestId=delivery-known` |
| 负控 ×3：空 id / 空正文 / 超 500 码点 ⇒ 具名拒绝且**零字节写出** | `qq_delivery_without_id` / `_without_text` / `_text_too_long` · 写出=1 行（只有正控那次） |
| 负控：**没有出站通道** ⇒ `output_channel_absent` | 不假装说出去了 |
| 回执正控 + 未知 id 负控 | `accepted:true recordedState=api_accepted`；未知 id ⇒ `accepted:false qq_delivery_unknown_id`（**不是失败**） |
| 回执负控 ×3 | `qq_delivery_report_without_id` / `_unknown_status` / `_unexpected_message_id`（非接受却带回执 id） |
| 负控：host 没有投递登记 | `qq_delivery_report_unsupported` |
| 读数分列 | 投递 `written=1 refused=3`；有限插话 `spoken=0`（两条线不混） |

**外壳侧端到端（§18，模拟 OneBot + 假核心，5 项）**：

```text
★ 正控  假核心发 DELIVER_QQ_TEXT ⇒ 外壳**真的调用** send_private_msg（发给=10001 固定 owner）
        ⇒ 回 api_accepted + messageId=90001
负控    平台明确拒绝（retcode=100）        ⇒ failed_confirmed / onebot_api_failed
负控    平台 ok 但**没有**回执 id          ⇒ delivery_unknown / qq_delivery_unconfirmed
负控    外壳**未连接**                     ⇒ failed_confirmed / qq_not_connected_before_send
        ⚠️ 且**没有**多调一次 send API（发送次数不变）
负控    没装投递处理器                     ⇒ 那一行如实回"结果不明"，不假装送出
```

⚠️ 三个桶分开是刻意的（`D08`）：

```text
平台明确拒        ⇒ failed_confirmed   （确定没发出）
接受了却没有回执 id ⇒ delivery_unknown  （**不**猜；也没法证明没发出）
超时 / 断开        ⇒ delivery_unknown
发送**前**已断连    ⇒ failed_confirmed   （未发送 —— 这是确定的事实，不是"不明"）
```

---

## 4c. 一处**结构性**设计选择：回执与轮次**无关**

```text
DELIVER_QQ_TEXT 的 requestId = deliveryId（不是任何轮次 id）
⇒ 外壳**不查 pending**、不 resolve 任何一轮
⇒ 旧有的"只消费有 pending 的 TURN_RESULT"那条纪律**逐字保留**（WP0 §5.7 ①）
```

门里专门有一条断言 `SUBMIT_TURN` **不是**控制类、而回执**是**，以及"回执不经 pending"这条由
§18 的端到端读数证明（假核心发的投递没有携带任何轮次）。

---

## 4d. WP5-B 投递登记与适配器（§19 读数）

**连接代次（④）**：

```text
代次单调递增、**不回收**（只增不减的水位 ⇒ "旧连接的回执"永远能用一个整数判出来）
只增不减之外还有两条：
  从未开过连接      ⇒ qq_delivery_no_active_connection   （"根本不该发"）
  不是当前代次      ⇒ qq_delivery_not_current_connection （同上，两种情形分开命名）
  旧代次**断开**     ⇒ 只清它自己的水位（不清新代次的）
```

**回执结算（⑤）** —— 四类**不受理**，且四类的 `accepted:false` **都不是**"投递失败"：

| 情形 | 读数 |
|---|---|
| 认不出来的 `deliveryId` | `qq_delivery_unknown_id`（**不**新建一行） |
| 同一个结局又报一次 | `qq_delivery_duplicate_receipt`（幂等） |
| 已定案又换结局 | `qq_delivery_already_settled`（**含 `delivery_unknown → api_accepted`** —— 结果不明永远不明） |
| 来自旧代次连接 | `qq_delivery_stale_generation` |
| `api_accepted` 却没有回执 id | `occurrence_accepted_without_message_id`（由迁移复核挡下，实例停在 `dispatching`） |

✅ **正控**：`dispatching` + `api_accepted` + 回执 id ⇒ 实例落 `api_accepted`；
✅ `delivery_unknown` 是**被受理的回执**（结果不明是事实，不是拒绝）。

**适配器（⑤ 的另一半）**：

```text
正控：参数合法 + 目标=本人 ⇒ 真的交给投递端口
     effect = `message_sent` + **正文指纹**，`detail` **不含正文**（D09：账本不收正文）
负控 ×7：未知操作 / 带收件人字段 / 未声明参数 / 目标不是本人 / 空正文 / 超上界 / 通道拒收
     ⇒ 逐条归一到**闭集**失败码 + 具名 `reason`
负控：取不到稳定键 ⇒ 失败关闭（幂等必需的能力不许在无键时发送）
```

⚠️ **量具自证那一条是我自己被抓出来的**：我一开始断言"端口只被调 1 次"（只有正控），
实际是 **2 次** —— "通道拒收"那一条**必须调用之后才知道**拒收。
⇒ 断言改成 2 次，并额外加一条：其余 5 条在**到达端口之前**就被挡下。

**新增的一个诚实性缺口（已补）**：`ActionEffect.kind` 原本表达不了"交给外部通道了"
（`none` / `echo` / `file_created` / …）。⇒ 加 `message_sent`，并在注释里逐字写明
它说的是"**已交给外壳去投递**"，**不是**"对方收到了"。

---

## 4e. 接线（§20 读数）—— 目标解析 + 装配层七处

**目标解析**（`src/main.ts` 的 `resolveTarget` 新增一支）：目标 = **已绑定的本人**，
取自 `readQqPrivateConfig().ownerId`（与 `web.search` / `math.calculate` 同一类：
**与用户输入无关** ⇒ `exact` 是如实的）。

```text
★ 正控（策略层）：qq_private_owner + exact + R2 + 已授权 ⇒ code = **allowed**
   —— 整条策略链真的放行（不是"看起来像能过"）
★ 负控（失败关闭）：绑定读不出来 ⇒ confidence = 'none' ⇒ code = **target_uncertain**
   —— 不许"那就发给某个人吧"
```

**装配层七处**（§20 逐处静态核对）：

```text
① resolveTarget 新增这一支
② 绑定读不出来时**如实**给 confidence:'none'（不是猜一个 owner）
③ 登记表只在 `qqProactiveMode !== 'off'` 时装配
④ QQ 入口连上时**开一个代次**，并按**这条连接**注入出站通道（`setOutputSink`）
⑤ QQ 入口注入 `reportQqDelivery`（带**本条连接**的代次）
⑥ 断开时按**代次**回收（`closeConnection` 自己判"只有它仍是当前代次才清"）
⑦ 端口只给形状：`notification-store` 的 `getOccurrence` / `advanceOccurrence` 是唯一权威
```

⚠️ **一个刻意的不对称**：`reportQqDelivery` **只**注入 QQ 入口，皮套入口没有。
皮套投递的是"表演"，不是 QQ 文字 ⇒ 它那条线上不该存在这张表。

⚠️ **`@` 一处细节**：`readQqPrivateConfig` 在缺配置时会**抛**。解析器**必须**吞掉它 ——
这台机器完全可能只跑皮套入口（没有 QQ 绑定），那时解析器不许把进程带崩。

⚠️ 一条**读数旁证**（`postlv2:role-tool:verify` 的目录读数）：
`目录：19 项能力 · 当前启用 18 项` —— 第 19 项就是它，**如实显示为未启用**
（因为它在任务候选表外 + 主动模式关着）。这正是 §6 ② 说的那个设计。

---

## 4f. 调度器（§22 读数）—— `L-QQP-01` 的两半都成了判据

```text
`ProactiveScheduler`（kernel/app，**一行 SQL、一行 croner 都没有**）
`createCronerTimer`（infrastructure/time，真定时器住这里）
⇒ 门可以拿**假定时器**把判据全部跑出来（确定、不等待），
   而"真 croner 到底会不会响"由一条**真的等 1.2 秒**的用例单独证明
```

| 判据 | 读数 |
|---|---|
| ★ 正控：待办可排 ⇒ **排上**，`nextRunAt` = 那条的 `dueAt`；关心 tick 也排上 | ✓ |
| ★ 正控：到点 ⇒ 回调**真的执行一次**，并且**重排**（再读一次待办） | `refreshes ≥ 2` |
| 正控：没有待办 ⇒ 取消排期 + `no_pending_reminder` | ✓ |
| ★ **负控（`L-QQP-01` 的另一半）**：目标同秒 ⇒ **不排**（绝不排一个永不响的作业）+ 具名 + **立刻交给上层** | `reminder_not_schedulable` |
| 正控：多条待办 ⇒ 取 **`dueAt` 最小**的（不是数组第一条） | ✓ |
| 负控：关心 tick 在**活动时段外** ⇒ 如实跳过、**不回调** | `care_outside_active_window` |
| 正控：关心 tick 在**时段内** ⇒ 真的回调（十种预检交给上层） | ✓ |
| ★ 负控：上层**抛异常** ⇒ 记错误原文，**重排照样发生** | `lastError='上层炸了'` · 已重排 |
| 负控：`stop()` ⇒ 两个具名作业都取消 | ✓ |
| ★ **真 croner**：排一次 1.2 秒后的单次触发 ⇒ **它真的响了** | 目标 `…670628` · 实际 `…670001` |

### ⚠️ 这条门**抓出了一个真缺陷**（不是量具误报）

第一版在"**不可排 ⇒ 立刻交付**"那条路上**无条件重排**，而重排又会读到**同一条**
（上层还没来得及定案）⇒ `refresh` ⟷ `fireReminder` **互递归到堆爆**：

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
（4 GB 堆，Mark-Compact 反复触发）
```

⇒ 修法（**判据变了，不是断言变了**）：

```text
① `not_schedulable` 那条路**不**自动重排 —— 那一条还挂在待办里，
   上层拿到它之后要先去定案，**定案完自己调 `refresh()`**
② 加一个**交付闸**：重入 ⇒ 具名拒绝 `reminder_handover_reentry_refused`，
   **绝不**让栈/堆失控（真发生了也是一个可查的读数，不是崩溃）
③ 计数**分列**：`reminderFired`（到点了）与 `reminderExpiredHandover`（到得太晚、排不上）
   —— 合成一个数就再也分不清"她不发"是因为没到点还是因为已经过期
```

⚠️ 还有一条**读数语义**要写清楚：上层抛异常之后，`lastCode` 会被**随后那次成功的重排**覆盖
（`lastCode` 是"最后一次为什么"，错误原文单独留在 `lastError` 里）。这是**刻意**的，
门里那条断言据此写成"看 `lastError`"而不是"看 `lastCode`"。

---

## 4g. 到点提醒的五步 + 适配器装配（§23 读数）

```text
① reserveOccurrence()     —— 插入成功才算占用（幂等：第二次 created=false，不报错、不重发）
② pending → evaluating     —— 迁移表要求（pending → prepared 不在表里）
③ evaluating → prepared    —— 候选正文在这一步落库（reminderTemplateText，程序既定句）
④ dispatchProactiveText()  —— 先 dispatching 再经真网关
⑤ 结局：dispatching（等回执）/ failed_confirmed（本地确定没发出）
```

⚠️ 这一节**对真 store 跑**（隔离库）—— 它要验的正是"写库那一段"：

| 判据 | 读数 |
|---|---|
| ★ 正控：真提醒走到 `dispatching`，**候选正文落在实例行上**，且**真的写出去了** | `text=提醒你一下：十分钟后提醒我喝水` |
| ★ 负控（幂等）：同一次机会再走一遍 ⇒ `reminder_occurrence_dispatching`，**不重发不覆盖** | 写出次数不变 |
| 负控：网关拒了 ⇒ `failed_confirmed`（确定没发出），**零字节写出** | ✓ |
| ★ 负控：**没有当前投递连接** ⇒ `qq_delivery_no_active_connection`，实例停 `prepared` | ✓ |

**装配层**：适配器注册进网关（**只在非 off 时**），出站口是**登记表**（不是某条 socket）。
顺带把登记表的构造收进**一处**（`proactiveDeliveryChannel`）—— §20 那条静态判据因此改写成
"只有一处构造"，而不是把它删掉。

### ⚠️ 现在离"真的发出去"只差**一件事**（已具名）

```text
`deliverReminder` 走到第 ④ 步要经**真网关**，而网关要求**受信的 initiator 证据**；
主动发送**没有因果轮次上下文** ⇒ 老实说就是"没有因果上下文"（`attestActionInitiatorUnresolved`）
⇒ 网关**失败关闭**（`action_attribution_evidence_missing`）
⇒ 唯一出路是一条**新的具名归因豁免**（ADR-110 `D05a`，WP0 已登记）——
   而 ADR-098 现有豁免**结构上只允许只读**（`sideEffect === 'read'`），
   所以那是一条**写**豁免：新名字 + 收窄到 (能力 `qq.private.message` / 操作 `send` /
   主体 `qq-proactive-scheduler`) + 负控。**这是一条判据改动，不是接线。**
```

⇒ **本轮的边界**：链路的**每一段**都建好并各自有读数（判据 / 持久 / 协议 / 外壳 / 登记 /
适配器 / 调度器 / 五步），**但把最后两个端口焊在一起还差那条写豁免**。
所以今天**仍然没有任何路径能主动发起一次投递** —— 这一条不许含糊。

---

## 4h. `D05a` 已落地：闭集里第一条**写**归因豁免（§24 读数）

```text
为什么必须有它：主动联系**没有因果轮次上下文**（定时器到点触发）
              ⇒ 老实说就是"没有因果上下文" ⇒ 网关失败关闭
              ⇒ 而它是一件**写**的事，ADR-098 那条豁免**结构上**只读 ⇒ 用不了
```

闭集里加一条，收窄到**一个三元组**：

```text
主体   SYSTEM/qq-proactive-scheduler   —— 调度器，不是用户、不是模型
能力   qq.private.message              —— 只发文字给已绑定的本人
操作   send
副作   write                           —— ⚠️ 要**逐字**等于登记表里那个操作的级别
basis  system_scheduled_reminder_due
```

⚠️ **关键设计：写豁免要两道可见的 diff**（这是"收窄不是调用点的自觉"的机器形态）：

```text
加一条豁免          → 改 ACTION_ATTRIBUTION_EXEMPTIONS   （第一处 diff）
让它能写            → 还要把名字加进 WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS（第二处 diff）
⇒ 于是"自己声明一个 sideEffect:'write' 的豁免"这条捷径**在结构上不存在**
```

| 判据 | 读数 |
|---|---|
| ★ 正控：写豁免在闭集里且收窄到那个三元组 | `SYSTEM/qq-proactive-scheduler · qq.private.message/send · write` |
| ★ 正控：**恰好这个三元组** ⇒ 复核通过 | 落点合法 |
| ★ 负控 ×8：匿名 / 陌生身份 / 换能力 / 换操作 / 未登记 / 声明与登记不一致 / 只读豁免越权（两种） | 全部具名拒绝 |
| ★ 结构：写白名单**只有它一条** | `写白名单=proactive_qq_delivery · 闭集=pre_turn_lookup,proactive_qq_delivery` |
| 正控：构造出的证据是**具名**的 | `causalBasis=named_exemption · causalEventId=null` |

⚠️ **一处顺序是刻意的**（量具又抓到我一次预测错误）：只读豁免去请求**别的**能力时，
判据先撞的是**收窄**（`attribution_exemption_scope_mismatch`）而不是"陌生身份" ——
因为查找是按 **principal** 做的，而那个 principal 在闭集里。这比"陌生身份"**更精确**。
断言据此改（改的是**我的预测**，不是代码）。

⚠️ `ADR-098` 的既有判据**一字未动地在跑**：`postlv2:bridge:verify` 的 B23
（含"登记为写 ⇒ 拒绝"、"principal 为 null ⇒ 拒绝"）**原样 PASS**。

⇒ **现在只差最后一道焊接**：调用点签发 `riskBudgetOverride: 'R2'` + 用这条豁免构造
`initiatorEvidence`，再把调度器 `start()` 接上。

---

## 4i. 最后一道焊接已完成（§25 读数）—— 链路**第一次真的连通**

`main.ts` 里新增：

```text
① 会话类上一个新方法 `deliverProactiveQqText()`（与 `prepareLookup` **同形**）
   读声明 → 建请求 → 经真网关执行 → 把结局归一成具名读数（**不**写日志）
   ⚠️ 三处**刻意不同**：
     · 它是**写**（用 `D05a` 的写豁免），提前检索是只读
     · **额度在这一步签发**：`riskBudgetOverride: 'R2'` —— 全仓库**唯一**一处，
       而它**只**对这次调用生效（全局 `CHARACTER_ACTION_MAX_RISK` 仍是 R1）
     · 幂等键由参数带进来（同一次机会重试不许变成两次发送）
② 调度器启动的三道闸（`D14` + 计划 §8 的硬要求 + 执行体）
   ⚠️ `entryScopedConversations !== true` ⇒ **如实告警、不启动**（失败关闭，不将就）
   ⚠️ 没有 QQ 入口会话 ⇒ 也不启动（没有执行体就没有网关那一步）
③ 关心那一条**如实不评估**（模型措辞未接线，`L-QQP-04`）——
   **绝不**用模板假装那是"她自己想说的"
④ 停机时**先停调度器**再关库（它会推进库状态 ⇒ 顺序不能换）
```

| 判据 | 读数 |
|---|---|
| ★ 正控：**十一处**焊接都在 | 十一处齐 |
| ★ 正控（端到端那一维）：`R2` + exact 本人 + 幂等键 + 已授权 | **`policy=allowed`** · 写豁免落点合法 |
| ★ 负控（额度那一维）：**不签发 R2**（沿用全局 R1） | **拒** —— 这正是"额度只授给这一项操作"的机器形态 |

⚠️ 两类判据**都要**，理由写在门里：文本判据证明"那几行在"（重构会让接线悄悄消失）；
**构造输入**判据证明"这条路真的通"。少任何一类都会得到"看起来接上了"。

### ⚠️ 这一条**仍然不许**被读成"她能发消息了"

```text
它证明的是：**每一闸都不无条件拒绝**，而且装配层的十一个焊点都在。
它**没有**证明：真外壳 + 真 NapCat + 无入站的那一次真实发送（= WP6 的真实链）。
它**没有**接线：模型给提醒选措辞（今天走程序模板）· 关心那一条 · `system_opportunity` section ·
            网关那条"不落用户事件"的编译入口 · 入口读点（`lastAcceptedAt` / 近期窗口）。
```

---

## 4j. **整链第一次真的通了**（`pnpm postlv2:qq-proactive:chain`，11 通过 / 0 失败 / 1 未运行）

```text
真：`src/main.ts --coexist`（生产入口、真内核、真网关、真调度器 Croner）
真：`scripts/coexist/qq-proactive-shell.ts`（用**同一套真客户端类**：LgStdioClient 连接档 + OneBotPrivateClient）
假：OneBot（NapCat）· 模型 · 库（隔离）
```

| 判据 | 读数 |
|---|---|
| ★★ **模拟 OneBot 真的收到 `send_private_msg`**，收件人是本人、正文是模板那条 | `123456789:提醒你一下：十分钟后提醒我喝水` |
| ★ 外壳报 `api_accepted`（**有回执 id 才敢这么说**） | `deliveryId=qq-notify:reminder:chain-reminder-near:1:…` |
| ★ 外壳自己的发送面走到 `qq_send_api_accepted` | `messageId=424242` |
| ★ 发出时刻落在目标那一秒里 | 差 `-200ms` / `-862ms`（两次运行） |
| ★★ 回执受理 ⇒ 实例行 `api_accepted` + `platform_message_id=424242` | ✓ |
| ★ 负控：**没到点**的那条（+10 分钟）**没有**产生实例行 | `intent_id 列 = chain-reminder-near` |
| ★ 观察：全程**没有入站**（外壳 stdin 一个字都没写） | ⇒ 发出去的东西只可能来自调度器 |
| ★ INC-01：真实库树摘要前后逐字相同 | `9455f82e4de5fb4f…` |

### ⚠️ 这一轮**抓到四个真缺陷**（都是"看起来接上了"）

```text
① `bridge.setOutputSink` + `openConnection()`（**不传 sink**）—— 两处都像接上了，
   而登记表的 `deliver()` 只认"当前代次那一格 sink" ⇒ 整链走到最后一步才以
   `execution_failed` 收场。修：**出站口在 `openConnection` 那一步绑**（登记表 → 桥 → socket）。
② 稳定键被塞进 `args`（`__occurrenceKey`）⇒ 能力自己的闭集检查**当场拒绝**
   （`qq.private.message 的参数只有 text，收到 __occurrenceKey`）—— **那个拒绝是对的**。
   修：把它接到 **`ActionRequest.idempotencyKey`** 上，并让网关把它转给适配器
   （`AdapterExecuteInput.idempotencyKey`，**追加**的可选字段，老适配器逐字不变）。
③ `armEvery` 把**任何**间隔都塞进秒字段 ⇒ 30 分钟 = 1800 秒超出 0–59 ⇒ Croner 抛错
   ⇒ 如实报 `care_arm_refused: croner_arm_failed`（**关心 tick 永远排不上**）。
   修：按量级选字段（< 60s 走秒，否则走**分钟**），并为"表达不了"留具名拒绝。
④ 量具自身的两个缺陷：**丢了外壳的 stderr**（于是"外壳一个字都没说"只能靠猜）、
   失败时只回一个具名码（`validation_failed`）而**不记人读的理由**。两个都修了。
```

### ⚠️ 两条**实测**边界（登记为读数，不是散文）

```text
`L-QQP-06`：单次触发的火点在**秒首** —— 目标 928888 ⇒ 实际 928026/928040（早 862/200ms）
   ⇒ `onceShotIsSchedulable` 判的是"能不能排上"，**不**保证"不早于目标时刻"。
      本批没有"不得提前"的硬要求，但这条**必须**写下来（谁要有这种要求，得另加判据）。
`L-QQP-05`：投递之后**意图没有被结清**（`finishIntent` 没被调用）⇒ 它仍是 `pending`
   ⇒ 调度器每次重排都会再交付一次；靠**实例行的唯一占用**兜住
   （日志里观测到第二次以 `reminder_occurrence_dispatching` 被拒 —— **没有发出第二次**）。
```

⚠️ **仍然只覆盖"提醒"那一类**：关心那一条的整链如实标 `NOT RUN`（措辞要模型给，`L-QQP-04`），
**不**用"提醒通了"代表"两类都通了"（计划 §8 的硬要求）。

---

## 4k. 关心那一条的**判据核心**已落地（§26 读数，7 条全绿）

`src/kernel/app/proactive-care.ts` —— 从"够不够格"走到"说 / 不说 / 改期"，四道闸缺一条都不发：

```text
① 私有调用失败（timeout / call_failed / invalid_output）⇒ **放弃本次机会**
   ⚠️ 与提醒**不同**：关心**没有**模板兜底 —— 用模板硬发就等于"替她说了一句她没说出口的话"
② 严格解析失败（多一个字段整条作废）⇒ 放弃
③ 来源复核（引用不在程序给的可选集里 / 可用集为空）⇒ 放弃
④ `shadow` 档（`dryRun`）⇒ 完整产生选择与审计，但**一个字节都不发**（`D14`）
```

⚠️ 权限差**不是**在这里各写一遍 `if`：两条分岔都调**冻结的纯函数**
（`programActionFor` / `programActionOnModelFailure`）—— 判据只有一处权威。

| 判据 | 读数 |
|---|---|
| ★ 正控：模型说 `send` ⇒ **恰好一次**交给外壳，正文落在**实例行**上 | `sent · 写出=早点睡吧。` |
| ★ 负控：`silence` ⇒ **合法结局**（不发、不记完成、不记失败） | `stayed_silent / care_legal_silence` |
| ★ 负控：模型失败 ⇒ `abandoned`，零写出 | `abandoned/care_stay_silent_timeout` |
| ★ 负控：提案**多一个字段** ⇒ 整条作废 | `abandoned/proactive_unknown_field` |
| ★ 负控：引用不在可选集里 ⇒ 来源复核不过 | `abandoned/proactive_source_stale` |
| ★★ 负控（`D14`）：`shadow` ⇒ 实例行停 `prepared`、正文落了、**零字节发出** | `shadowed · state=prepared · 写出=1`（只有前面那条真的发过） |
| ★ 正控：`defer` ⇒ 排到 `now + 30 分钟`，不发 | `until=+1800000` |

⚠️ **关心的候选正文只活在实例行上**（意图里没有正文 —— 表级 CHECK 挡着）：
"她说的话"落库的**唯一**位置是实例行的 `candidate_text`。这一条在正控里逐字断言了。

⚠️ **仍未接线**：这一段是**判据核心**（端口 + 真 store），但 `main.ts` 里的
`onCareOpportunity` 还是"如实不评估"——**它需要真实读数**（两路最近入站 / 上次关心时刻 /
是否有新入站 / 日额度 / 在途候选）与**真实私有模型调用**。⇒ 整链那一门对关心的 `NOT RUN` **不变**。

---

## 4l. `L-QQP-05` **已修**（§27 读数，5 条全绿）—— 修法在**读侧**，不是把状态写成"已送达"

```text
问题（整链那一门实测出来的）：投递之后意图**仍然是 `pending`**
   —— 本批刻意**不**把 `api_accepted` 写成"已送达"（`D08`：平台接受 ≠ 送达）
   ⇒ 调度器每次重排都会**再列出同一条**并再交付一次
   实测：第二次被实例行的唯一占用拒住（`reminder_occurrence_dispatching`）—— **没有发出第二次**
   ⇒ 幂等保住了，但每次重排白跑一趟 + 日志多一条"被拒"
```

修法：**加一道读侧过滤**，而不是去改状态语义。

```text
"还要不要发"（机会）与"发出去之后平台怎么说"（实例行终态）是**两件事**；
把它们混成一个状态，就会既过度主张、又丢掉真相。
⇒ `listAttemptedReminderOccurrenceKeys()`（store 读）+ `excludeAttempted()`（纯函数）
   键用**与占用那一步同一条冻结纯函数**重算 —— 不反解、不猜格式。
```

| 判据 | 读数 |
|---|---|
| ★ 正控：已尝试的**被剔掉**，其余保持原序 | ✓ |
| 负控：空集 ⇒ **一条都不剔** | ✓ |
| 负控：全部尝试过 ⇒ 空列表（不是"退回原列表"） | ✓ |
| ★ 正控（真 store）：`已尝试` 集合**非空** | `6 个键` |
| ★ 负控：意图仍是 `pending` ⇒ "已尝试 ∩ 仍在待办"可以非空，而**过滤后必须为空** | ✓ |
| 静态：装配层两处都在 | ✓ |

**整链上的恢复读数**（修之前 / 修之后）：

```text
修之前：reminder_armed(near) → 到点交付 → handed_over → **reminder_not_schedulable(near)** → 第二次被拒
修之后：reminder_armed(near) → 到点交付 → handed_over → **reminder_armed(far)**
        ※ 重排落到了**下一条未尝试的**提醒；`reminder_occurrence_dispatching` 一条都没有
```

⚠️ 量具自身又抓到我一次：§27 第一版**跨块复用**了别的段的 `dueAt`/`intentId` 去重算一个键，
于是"已尝试"集合里有 6 个键、而它要找的那个不在里面 ⇒ 断言失败。
教训：**跨块复用变量会让一条判据看起来在验 A、其实在验 B**。已改成断言**结构性质**
（"已尝试 ∩ 仍在待办"过滤后必须为空），与"是哪几条"无关。

---

## 4m. 关心那一条的**接线**（§28 读数，13 条全绿）

```text
真读数 ×5（全部来自库，不是内存变量）：
  paused         ← notification_control（**落库**的暂停/恢复）
  日额度         ← countQuotaUsage ×2（关心 / 全类），日界按**策略时区**
  lastCareAt     ← 上一次关心**占额**的时刻（含结果不明与明确失败）
  lastInboundAt  ← 最近一次真实入站（`user_message` + `actor_type='user'`）
  在途候选       ← 还在 pending/evaluating/prepared/dispatching 的实例行
判据：`precheckCareOpportunity`（**冻结的纯函数**，装配层不重写一遍 if）
```

新增的**三条**判据助手（都可单独验）：

| 助手 | 判据 |
|---|---|
| `zonedDayWindow`（contracts） | 上海 20:00 ⇒ 当地 00:00→次日 00:00；**同一瞬间**在上海是 10-07、在 UTC 是 10-06 |
| `lastInboundAt`（store） | **两个条件的合取**：`type='user_message'` **且** `actor_type='user'` |
| `hasInFlightOccurrence`（store） | `dispatching` **算在途**（平台结局还没回来 ⇒ 此时再开新候选就是并行） |

**私有调用适配器**（`openai-proactive-care.ts`）用注入的 `fetch` 把五种结局全打了一遍：

| 判据 | 读数 |
|---|---|
| ★ 正控：调用成功 ⇒ 把**原文**交回内核（那里**不**解析、不下结论） | `{"decision":"silence",…}` |
| ★ 负控：**没有凭证** ⇒ `call_failed`（不是"她决定不说话" —— 两种读数必须分开） | `call_failed` |
| 负控：HTTP 非 2xx ⇒ `call_failed` | `call_failed` |
| 负控：超时（`AbortError`）⇒ `timeout`（**不是** `call_failed`） | `timeout` |
| ★ 负控：调用成功但**没有正文** ⇒ `invalid_output` | `invalid_output` |
| 静态：**只**做一次 POST，零写路径 | 一处 POST · 零写路径 |

### ⚠️ 但今天**仍旧发不出去** —— 理由现在**具名**了（`L-QQP-07`）

```text
关心的候选**必须**带"已有依据引用"（计划 §4.2 逐字），
而依据只能来自**既有的 ContextCompiler**（同一个 §4.2：「由既有 ContextCompiler
装配专用系统机会」）⇒ 那条 `system_opportunity` section **还没建**
⇒ 可用依据集是**空的** ⇒ `verifyProactiveSources` 会以
   `proactive_source_set_unavailable` 失败关闭
   （**空集即拒**是刻意的：拿不到可用集就不输出，而不是"没查到失效就当它有效"）
⇒ 所以接线**走到"够格"就停**：如实记"机会够格、依据面未接线"，**不花那次模型调用**。
   ⚠️ **绝不**用编造的依据或程序模板硬凑一条"关心" —— 那等于替她说了一句
      她**没有任何依据**可说出口的话。
```

⇒ 关心的**判据面、读数面、调用面**都通了；**依据面**是唯一剩下的阻塞，而它是一条
**设计裁定**（`system_opportunity` section 取什么当依据、怎么遮蔽），不是一个接线疏忽。

---

## 4n. 依据面的**裁定**已落地（ADR-111 · §29 读数，9 条全绿）

新增 [`ADR-111`](../adr/ADR-111-proactive-care-source-set.md)（`ACCEPTED / DESIGN FROZEN`）——
它**只**裁"依据从哪来"，`ADR-110` 的 `D01`–`D14` **一字未改**。

```text
`S01` 只认**已经过同一套遮蔽**的读时视图条目（记忆事实 / 可用信念 / 未结清目标），
      且每条必须带**稳定 id**；**不许**任何"原始历史副本"
      ⚠️ 实质不是"挑哪些条目"，而是"只能从经过同一套遮蔽的视图里挑"
`S02` 可用集**有界**（≤8 条 · 每条摘要 ≤120 码点），且**顺序 = 读时视图的顺序**（不另发明打分）
`S03` `system_opportunity` 是**追加**的 section kind；装配层用**可选**渲染器
      ⇒ **不传 = 0 个 section** ⇒ 冻结的 prompt 基线逐字节不变
`S04` **生成前**与**发送前**各核对一次（两次用的是同一个函数，否则"复核"复的是另一件事）
`S05` 候选失效 ⇒ **整条作废**，不修补、不重问（"不触发无限修复对话"）
`S06` 依据面未接线时：**不花模型调用**、具名 `L-QQP-07`
`S07` 五条"明确不做"（不新增存储 · 不另做打分 · 不让模型新增依据 · 不把候选升级成事实 · 不动 `D11` 三禁令）
```

**为什么不用其它三种做法**（写进 ADR 的否决表）：用最近对话行当依据（正是 §4.2 禁止的
"其它入口近期原文"）· 让模型自己编 `sourceRef`（把复核变成装饰）· 没有依据也允许 `send`（正是 `D03` 要防的）。

| 判据 | 读数 |
|---|---|
| ★ 正控：空 ref / 空 label 丢掉 · 同 ref 去重（保留第一次）· 超长截到 120 码点 | `fact:1(7) · fact:3(120)` |
| 负控：**按码点**截断（emoji = 1 码点，不是 2 个 UTF-16 单元） | `120` |
| ★ 正控：最多 **8** 条，顺序 = 输入顺序（**确定性**） | `8 条 · 尾=fact:7` |
| 负控：空输入 ⇒ 空集合（不是"退回全部"、也不是"给个默认依据"） | `0` |
| ★ 负控：可用集为空 ⇒ `proactive_source_set_unavailable` | ✓ |
| ★ 负控：有一条失效 ⇒ `proactive_source_stale` 且**点名是哪几条** | `fact:gone` |
| ★ 正控：`system_opportunity` 在闭集里且**写在最后**（追加） | 追加在 `instruction` 之后 |
| ★ 负控（`S03`）：契约里**没有**"默默多出一个 section"的默认 | 可选 · 无默认 |
| 静态：映射器的字段叫 **`label` 而不是 `text`**（名字上就拦住"塞原始对话行"） | ✓ |

⚠️ **冻结基线未动**：`m3.5:test` 30/0 · `m3.5:verify` PASS（`S03` 的"不传 = 0 section"保证）。

⚠️ **仍未做**：渲染器接进 `sections.ts`（与 `renderBelief` 同形）· 一个把读时视图条目映射成
`ProactiveSourceCandidate` 的装配层函数 · 把渲染器接上后**真的调模型** ⇒ 那时 `NOT RUN` 才会变成真读数。

---

## 4o. 依据面的**渲染器**已落地（§29 追加读数，3 条全绿）

`createSystemOpportunityProvider`（`kernel/context/sections.ts`）—— 与 `createBeliefProvider` **逐字同形**：

```text
· `render` 返回 `undefined` 或**空文本** ⇒ **0 个 section**（不是"空 section"）
· section id = `system-opportunity` · kind = `system_opportunity` · 优先级 **43**（goals 45 之下、memory 40 之上）
· **不传这个 provider ⇒ 这一块整块不存在** ⇒ 冻结的 prompt 基线**逐字节不变**
· ⚠️ 它**不是** `droppable: true`：这一块说的是"这一次机会你**只能**从这些依据里挑" ——
    被裁掉之后模型会以为"没有依据限制"，那正好是最糟的误解。它只在**系统机会**那一类轮次里出现，
    本身已经很省预算。
```

| 判据 | 读数 |
|---|---|
| ★ 正控（行为）：给了文本 ⇒ **恰好一个** section · 携带来源引用 · **不可裁** · priority 43 | `1 个 · droppable=false · priority=43` |
| ★ 负控（行为）：**空文本** 与 **`undefined`** 都 ⇒ **0 个 section** | `0 / 0` |
| ★ 负控（`S03`）：装配层里是**条件**挂载的 | 条件挂载 |

⚠️ **这条判据的**行为**部分是刻意的**：静态判据只能证明"那几行在"；只有真的调一次 provider
才能证明"**空 / undefined ⇒ 0 个 section**" —— 而**冻结基线之所以不变，靠的正是这一条**。
（`m3.5:test` 30/0 · `m3.5:verify` PASS 为它作证；`evals/fixtures/m3.5/prompt-baseline.txt` 的
`git status` **无改动**。）

⚠️ 断言写在 **provider 级**而不是整套 compiler 级：compiler 要一份 `IdentitySnapshot`，
而这里要验的判据与身份**无关** —— 多构一份身份只会让这条判据多一个无关的失败原因。

⚠️ **仍未做**（ADR-111 §5 的 ④）：把读时视图（记忆事实 / 可用信念 / 未结清目标，**带 id**）
映射成 `ProactiveSourceCandidate[]` 的**装配层函数**，并在系统机会那一类轮次里
把 `renderSystemOpportunity` 传进去 —— **在那之前果然还是发不出去**
（可用集为空 ⇒ `proactive_source_set_unavailable` 失败关闭）。

---

## 4p. 用户裁定 + 依据集的**收集**与**渲染**（§30 读数，5 条全绿）

### 2026-10-06 用户裁定（三问）

```text
① 依据面取哪几类   ⇒ **三类都接**（可用信念 + 记忆事实 + 未结清目标/承诺）
② 下一步优先级     ⇒ **先把关心走通**（计划 §8：「两类均通过才进入正式交付」）
③ `L-QQP-03` 的 273 处 `?` 占位 ⇒ **暂不修，保持登记**
```

### 本轮落地（3 类中的 2 类 + 渲染器）

```text
`boundProactiveSources`（契约）  有界化：去空 / 去重 / 截到 120 码点 / 最多 8 条
`renderSystemOpportunitySection`（契约）  确定性渲染：逐条列出 ref（**这就是给模型的闭集**）
                                        ⚠️ **空集 ⇒ `undefined`**（不是空文本）⇒ provider 给 0 个 section
`buildProactiveSourceCandidates`（infrastructure）  从**两个**读时视图收集：
  · 可用信念  `status ∈ {active, disputed}` · ref = beliefId · label = `predicate = value`
  · 未结清目标 `status ∈ {active, blocked}` · ref = goalId · label = statement
  ⚠️ **记忆事实还没接**（`L-QQP-08`）：它的可用集在召回/投影那一层（同轮遮蔽 + 相关性过滤），
     不在某个 store 的 `list` 里 ⇒ 读数**如实记 0**，不假装接了。
```

⚠️ **为什么"如实记 0"是必须的**：少一类来源只会让可用集**更小**（更保守）；
而"假装接了"会让**发送前复核**去复一个**不存在的资格判据** —— 那正是 `S04` 要防的。

| 判据 | 读数 |
|---|---|
| ★ 正控（真 store）：空库里**收集不到**任何依据 | `{"beliefs":0,"goals":0,"memories":0}` |
| ★ 负控：记忆读数恒 0 且代码里**具名** `L-QQP-08` | ✓ |
| ★ 正控（`S01` 的实质）：收集器**不读**原始对话行 / trace / 账本 | 只两个读时视图 |
| ★★ 正控（把 `S06` 串起来）：空依据集 ⇒ 渲染器 `undefined` ⇒ provider **0 个 section** | `渲染=undefined · section=0` |
| ★ 正控：有一条依据 ⇒ 文本里**逐条列出 ref**，`sourceRefs` 与它同源 | `belief:1` |

⚠️ 量具又抓到我一次：§29 那条"候选字段叫 `label` 不是 `text`"的静态判据
原本是"从 `ProactiveSourceCandidate` 往后 200 字符内不许出现 `readonly text`"——
而我本轮新加的**渲染器返回类型里正好有** `readonly text: string` ⇒ 断言被**无关的代码**打败。
教训：**文本判据要框住它真正要检的那一段**（改成只检接口体）。

⚠️ **仍未做**：记忆那一类（`L-QQP-08`）· 把 `renderSystemOpportunity` 与
`buildProactiveSourceCandidates` **接进 `main.ts` 的关心路径**（现在还是"够格就停"）·
接上之后**真的调模型** ⇒ 那时整链那一门的 `NOT RUN` 才会变成真读数。

---

## 4q. **三类依据都接上了**（§30 读数，6 条全绿）

按用户裁定「三类都接」，把第三类（**记忆事实**）补上：

```text
记忆事实  `status = active` —— **那道遮蔽**：superseded / retracted / disputed 都不是
          "她今天还这么认为"的话 ⇒ 拿它们当依据 = 让她引用一句她自己都不再采信的话
ref       = 记忆 id（canonical）· 读法 = store.list({owner, status:'active', limit:200})
label     = **内容那一面**：claim ⇒ `predicate = value`；episode ⇒ `summary`
          ⚠️ **不用**那行面向运营的审计串（它含 authority / importance / confidence / evidence）
```

⚠️ **只用 `active` 比信念那一条更严，这是刻意的**：信念的 `disputed` 在 M9 里仍算
"可用判断"（有争议但还在用），而记忆的 `disputed` 不是 —— 两类的资格判据**本来就不同**，
所以**不能**用一个 where 一把捞（这正是本文件开头那三行）。

| 判据 | 读数 |
|---|---|
| ★ 正控（真 store）：空库 ⇒ 三类都是 0 | `{"beliefs":0,"goals":0,"memories":0}` |
| ★ 负控：记忆那一类**真的接了**（store.list + `status:'active'` + 显式 `limit`） | ✓ |
| ★ 负控：标签从**内容**取（claim 槽位 / episode summary），不是审计串 | ✓ |
| ★ 正控（`S01` 实质）：**三个**读时视图，且不读原始对话行 / trace / 账本 | 三个读时视图 |

### ⚠️ 同型踩坑**第三次**：静态判据不许落在**词**上，只能落在**结构**上

```text
① 早前：断言"文件里不含 `user_message`"，而我自己文件头的注释里正好写着这个词
② 本轮前：断言"`ProactiveSourceCandidate` 附近不许有 `readonly text`"，
          而我新加的渲染器**返回类型里正好有** `readonly text: string`
③ 本轮：断言"代码里不该再出现 `L-QQP-08` / 不该出现 `summarizeRecord`"，
        而**我自己的注释里正好写着**"不再有 `L-QQP-08` 占位""**不**用 `summarizeRecord()`"
```

⇒ **纪律**（已写进门脚本的注释）：**静态判据只落在结构上**（有没有那段分支 / 有没有那个调用），
**不落在词上**；要检某一段，就**框住那一段**（如只检接口体），不要全文按词找。

⚠️ **仍未做**：把收集器 + 渲染器**接进 `main.ts` 的关心路径**（现在还是"够格就停"）·
接上之后**真的调模型** ⇒ 那时整链那一门的 `NOT RUN` 才会变成真读数。

---

## 4r. 最后那道焊接的**规格**（自查清楚，下一步是机械的）

按 ADR-111 §5 的第 ④ 步，把 `main.ts` 的 `onCareOpportunity` 从"够格就停"接到
`runCareOpportunity`。**已核实**要喂什么（各签名都读过原文）：

```text
runCareOpportunity({occurrenceKey, dryRun, briefing, evaluate, store, dispatch, action, generation, now})
  occurrenceKey ← precheck.opportunityKey        （`eligible:true` 那一支有它）
  dryRun        ← precheck.dryRun                （`shadow` 档 ⇒ D14）
  now           ← 回调给的 `at`
  generation    ← qqDelivery!.currentGeneration()（没有连接 ⇒ null ⇒ 失败关闭）
  evaluate      ← createOpenAiProactiveCarePort(...)      ← 已落地（§28）
  store         ← CareStorePort：reserveOccurrence / advanceCare / deferOpportunity
  dispatch      ← 与提醒那一条**逐字同形**（assertDeliverable / beginDispatch / settleConfirmedFailure）
  action        ← 与提醒那一条**逐字同形**（proactiveSender.deliverProactiveQqText）
  briefing      ← opportunity（程序写的一句话）/ localTime / timezone / sources / textBudget
```

**两条已定的填法**（不新造读法）：

```text
sources    ← boundProactiveSources(buildProactiveSourceCandidates(...).candidates)
             并且**同一次**用它渲染 `renderSystemOpportunitySection` 作为审计面
             （`S04` 要求"生成前与发送前用**同一个**构造逻辑"）
textBudget ← `MAX_NOTIFICATION_TEXT_CODEPOINTS`（**既有**的冻结上限 500）
             ⚠️ 刻意**不**新编一个数：那个常量已经是 QQ 正文的权威上限
```

### ⚠️ 一处**微裁定**（本轮发现，尚未拍）

```text
`deferOpportunity({occurrenceKey, until})` 需要"把这次机会排到 until"（D03 的 defer 那一支），
但**持久层今天没有这一格**（`notification_occurrences` 没有"改期到"的列，关心也没有意图行）。
两条路：
  ① **失败关闭**（推荐）：返回 `{ok:false, code:'care_defer_not_persisted'}`
     ⇒ 模型的 `defer` 变成"放弃本次"，**不发**（保守）；
     代价：D03 名义上的 defer 暂时用不了（要登记成 `L-QQP-10`）。
  ② 落一格（加迁移 + 列）：真让它能"3 小时后再看"
     ⇒ 更贴 D03，但要**新迁移**（按纪律：新迁移需用户批准）。
```

⇒ **按本仓库"失败关闭"的既有纪律，默认走 ①**；若你认为 defer 必须真能用（②），
那需要你批准**一条新迁移**（这是我要在下一步之前确认的唯一一件事）。

### ✅ 2026-10-06 用户裁定：**加一条新迁移，让 `defer` 真能用** ⇒ 迁移 `0016` 已落地

```text
迁移 `0016`（`post-lv2-qq-proactive-care-defer`）：
  · `alter table notification_occurrences add column if not exists deferred_until bigint`
  · `create index ... on notification_occurrences (character_id, deferred_until)`
```

⚠️ **三条设计判断**（都写进了迁移的注释里）：

```text
① 必须是**新迁移**而不是改 `0014`：0014 的 DDL 已发布过，
   `create table if not exists` 会让"改了既有 DDL"**静默失效**
② **加列而不是加表**：这一格与实例行**一对一**（一次机会最多一个改期），
   单开一张表就要自己维护"外键般的配对"，而配对正是"一行一列"免费保证的事
③ 只加列、**不**加约束：`deferred_until` 与 `state` 是**正交**的
   （一个实例行可以在任何非终态上带着一个改期时刻）——
   在这里写 `check` 会把"正交"表达成"耦合"，日后想放宽还得再写一条迁移
```

门：`kernel:test` **27/0** · `m3:migrate-gate` **17/0** · `postlv2:qq-proactive:verify` **193/0** · `typecheck` 0。
（另核：全仓**没有** `latestSchemaVersion() === 1x` 这类写死的版本判据 —— 上一轮修过的那类洞没有再出现。）

⚠️ **仍未做**（下一步）：`deferOccurrence` / 读改期的 store 函数 · tick 里"还压着的改期就跳过"·
以及把整条关心路径焊进 `main.ts`（规格见本节上面那一张表）。

### ✅ 同上轮：`defer` 的两个 store 函数已落地（§31 读数，**6 条全绿**）

```text
`deferOccurrence(db, key, until)`   写 `deferred_until`（不动状态机 —— 两者**正交**）
                                    三道守卫：键不存在 ⇒ `occurrence_missing`
                                             非关心   ⇒ `occurrence_defer_not_care`
                                             已终态   ⇒ `occurrence_defer_terminal`
`pendingCareDeferrals(db, cid, now)` 给 tick 用：`deferred_until > now` 的那些**还压着**的
                                    返回**时刻**而不是布尔 ⇒ 读数能说出"压到什么时候"
```

| 判据 | 读数 |
|---|---|
| 正控（真 store）：先真的占用一条关心实例行 | `created=true` |
| ★ 正控：改期成功，且 `pendingCareDeferrals(now)` **认得它** | 压着 1 条 → `+3h` |
| ★ 负控：`now` 过了那个时刻 ⇒ **不再压着**（改期是"到那之前别问"，不是"永不再问"） | `0 条` |
| ★ 负控：**终态**的关心实例改期 ⇒ `occurrence_defer_terminal` | ✓ |
| 负控：不存在的键 ⇒ `occurrence_missing` | ✓ |
| ★ 负控（**静态**，理由见下）：`kind !== 'care'` 的守卫在 | ✓ |

### ⚠️ 一条**没跑成**的负控 —— 我把它写清楚了，没有假装跑过

```text
想做：用 `rawInsertOccurrence` 自己造一条**提醒**实例，跑"提醒改期 ⇒ 拒"的**行为**判据。
实测：`inserted=false`（那个裸插入是给"§23 那种带意图的实例"用的，在本段前置条件下插不进去）。
⇒ 在**不再造一条完整意图**的前提下，我想不出确定性造出提醒实例的办法
⇒ 退回**静态**判据，并在读数里**明说**这一点（`本段那次裸插入 inserted=false（故未走行为路径）`）。
⇒ 行为面的另一半由 ③b（终态 ⇒ 拒，**真的跑过**）与 ①②④ 三条**真的跑过**的判据兜着。
```

⚠️ **这是我这一轮最想做对的一件事**：判据可以弱，但**读数不许虚报** ——
"静态判据 + 明说未走行为路径"与"行为判据看起来跑过了"在账面上必须能分辨。

门：`postlv2:qq-proactive:verify` **199/0** · `kernel:test` 27/0 · `m3:migrate-gate` 17/0 · `m4:test` 262/0 · `m3.5:test` 30/0 · `typecheck` 0。

⚠️ **仍未做**：tick 里"还压着的改期就跳过"· 把整条关心路径焊进 `main.ts`（规格见上一节）。

---

## 4s. ✅ **最后一道焊接完成**（§32 读数，7 条全绿）—— 关心那一类**从"够格就停"接到真的执行**

```text
`main.ts` 的 `onCareOpportunity` 现在：
  ① 先查"上一轮她说过会儿再说"（迁移 `0016`）⇒ 还压着就**不问**（放在 precheck **之前**：
     它是上一次机会的延续，与"这一轮够不够格"是两件事，混进去会污染那套判据的读数）
  ② 真读数 ×5 ⇒ `precheckCareOpportunity`（够格与否 + 具名原因）
  ③ **一次构造两用**：`built.candidates` 同时喂 `boundProactiveSources`（给模型的闭集）
     与 `renderSystemOpportunitySection`（审计面）—— `S04` 要求"两次复核用同一个函数"
  ④ 空依据集 ⇒ **在调模型之前** return（`S06`：她没有依据可说时，唯一诚实的结局就是这一轮没有这一块）
  ⑤ `runCareOpportunity`（落库 → 调模型 → 严格解析 → 来源复核 → shadow/发送）
  ⑥ 读数**不含正文**
```

| 判据 | 读数 |
|---|---|
| ★ 正控：真的调了 `runCareOpportunity`（不再是"够格就停"） | 已接 |
| ★ 正控（`S04` 机器形态）：**同一份** `built.candidates` 喂两处 | 同一份 candidates |
| ★ 负控（`S06`）：空集判定**在调模型之前** | 空集判定在前 |
| ★ 正控：`deferOpportunity` 接到**真的落库**函数（`0016` 那一列） | 接到 `deferOccurrence` |
| ★ 正控：tick 开头查"还压着的改期"，且在 `precheck` **之前** | 压着就不问 |
| ★ 负控：这条线上**零模板兜底** | 零模板 |
| ★ 正控：`textBudget` 用**既有的冻结上限**（不新编一个数） | 复用既有常量 |

⚠️ **判据一律落在结构上**（`L-QQP-09`）：只看"有没有那段调用 / 那个顺序"，
**不**按词找 —— 前面已经三次被自己的注释打败了。本段第一版还留了一处
"两个分支写成一模一样的三元表达式"（读起来像在判两件事，其实只判了一件），已改成直白写法。

门：`postlv2:qq-proactive:verify` **206/0** · `kernel:test` 27/0 · `kernel:verify` 25/0 · `m4:test` 262/0 · `typecheck` 0。

⚠️ **仍未做**：让整链门**真的跑一次关心**（现在整链那一门对关心仍是 `NOT RUN`，
因为关心 tick 的周期是 30 分钟、门跑不到那一拍）。⇒ 下一步：用**策略里的机会间隔**把它压到秒级，
在整链门里真跑一条"够格 ⇒ 调模型（模拟 provider）⇒ 发送 ⇒ 回执受理"的关心读数。

### ✅ 2026-10-06 用户裁定：**在离线门里跑关心的执行核心**（不碰生产代码）⇒ §33 读数，**6 条全绿**

⚠️ **为什么不是整链门**：关心 tick 的间隔下限是 **5 分钟**（`CHARACTER_QQ_PROACTIVE_INTERVAL_MIN`
的 `min=5`，那是**生产防护**），门等不到那一拍。把下限改小 = 动一个生产防护参数；
加一次性探针开关 = 生产代码里多一个只为验收存在的开关。用户选了第三条：
**在离线门里直接跑执行核心**。

```text
★ 正控（本批第一次）：`sent` + 正文交到外壳 + 实例行落库
   读数：outcome=sent · 外壳收到 1 条 · 实例行=dispatching · candidate_text 逐字相同
★ 负控：同一条实例键再来一次 ⇒ refused（dispatching 已被占）· 零发送
★ 负控：她选沉默 ⇒ stayed_silent · 零发送（沉默是合法结局，不是失败）
★ 负控（S05）：引用不在闭集里 ⇒ abandoned + `proactive_source_stale` · 零发送（不修补、不重问）
★ 负控（D14）：shadow 档 ⇒ shadowed · 零发送
★ 负控：模型失败 ⇒ abandoned + `care_stay_silent_timeout` · 零发送、**没有模板兜底**
```

⚠️ **这一段的边界（必须说清，否则读数会被读大）**：

```text
真的    ：真 `runCareOpportunity` · 真 store（占用/evaluating/prepared/dispatching 全落库）
          · 真严格解析 · 真来源复核 · 真状态机
脚本化  ：模型响应（`evaluate` 端口）—— 本门不调真模型
桁接    ：`dispatch.assertDeliverable`（假装有连接）与 `action.execute`（只记录，不发 socket）
```

⇒ 它证明的是"**关心这一条真的走完了执行核心**"，
**不**主张"关心已经在真 QQ 上发出过消息"（socket 那一半由提醒整链证过，两者走**逐字同形**的
dispatch/action 端口，但那仍是**提醒**的读数）。

---

## 4t. **真模型档**（`pnpm with-test-model pnpm postlv2:qq-proactive:live`）—— PASS 3/3

新门 `scripts/postlv2-qq-proactive-live.ts`（只跑"私有调用 + 严格解析 + 来源复核"三件，
**不碰数据库、不写状态、不发消息**；正文只进证据文件、不进 stdout）。

```text
端点：ark.cn-beijing.volces.com · 模型 deepseek-v4.1-flash（small 同）· 预算上限：无（既有裁定）
调用 3 次，同一份简报（3 条依据：睡眠习惯 / 期限 / 乌龙茶）
读数：成功 3/3 · **send 3 · silence 0 · defer 0** · 越界引用 0 · 正文 35/48/51 码点
负控（**空依据集**）：拒 —— `proactive_without_source` ✅
```

**她真的说的三句**（人审材料，逐字）：

| # | 正文 |
|---|---|
| 1 | 这两天要交的东西写得顺吗？不用急着回。交完了就早点睡，别又熬到后半夜。 |
| 2 | 这两天那个期限的事弄完了吗？要是差不多了就早点收工睡吧，别又熬到凌晨。不用急着回，明天再说也行。 |
| 3 | 这两天那个期限忙得差不多了吗？别一路硬扛，泡杯乌龙茶歇几分钟。忙完就早点睡，剩下的事明天再收尾也不迟。 |

⚠️ **这就是人审要看的东西**（`artifacts/post-lv2/qq-proactive-live-20261006165519.92/readings.json`）。

### ⚠️ 一条**真观察**（登记为 `L-QQP-10`）

```text
给足依据时，模型 **3/3 都选 send** —— 闭集里的 `silence` / `defer` **一次都没出现**。
它说明"沉默是合法结局"在**协议上**成立，但在**这个模型的倾向上**几乎不被选。
⇒ 所以"她会不会忍住不说"这件事，**不能**靠模型自律；
   真正兜着的是**程序闸**（安静时段 / 额度 / 冷却 / 暂停 / 无人回应）—— 那些判据都有独立负控。
⚠️ 边界：**3 个样本不是比率**，不能读成"她 100% 会说话"。
```

⚠️ 另注：三句里都出现"不用急着回 / 明天也行"这类**降低回复压力**的措辞 ——
这是好的迹象，但**不构成**"她不会打扰你"的主张（一次 3 样本的观察，不是评测）。

### ✅ 2026-10-06 **人审 = PASS**（*声明式裁定*）

```text
用户就上面三句（真模型档的真实产出）声明：「三句话看了没问题」。
⇒ 按 M8 / M10.1 的先例：**原机器读数不回写**（那一槽在候选文档里的历史读数仍是 PENDING），
   裁定作为**独立事实**记录在这里。
⚠️ 它主张的是"这三句读起来没问题"，**不是**"主动联系的措辞已经过评测"
   （semantic evaluation 那一槽仍是 NOT RUN；三句 ≠ 评测）。
```

---

## 4v. ⚠️ WP3 的**入口那一半其实没接**（本轮发现）—— 以及它揭出的设计缺口

```text
`readReminderRequest` / `decideReminderDue` 在全 `src/` 里**只有定义、零调用者**
（都在 `contracts/notification-intake.ts`）⇒ 提醒那一类在**激活后的生产里永远发不出去**：
本人说什么都不会产生意图行。这与 `L-S8-30` 是同一个病，只是这次病人是我自己。
```

⚠️ **我自己的门对这个病是瞎的**：判据全绿（§12 把十种拒绝都量过），
但**没有一条判据证明"生产路径上有人调用它"**。⇒ 这正是 `L-S8-30` 教训的反制要补的地方。

### 精确挂点（已查实，不猜）

```text
`ChatSession.send(userText, streaming?)`（`src/main.ts:3590`）—— 生产入站入口
`incoming = await this.gateway.beginTurn(...)`（:3670-3672）
`IncomingTurn.userEvent?: ConversationEvent`（`turn-gateway.ts:462`）⇒ 来源事件 id = `incoming.userEvent?.id`
```

### ⚠️ 揭出的设计缺口：**提醒正文从哪来**

```text
`createIntent` 对提醒**强制要求非空正文**（`notification_reminder_without_text`，
"不许'设了一个空提醒'"）。
而 `readReminderRequest` 的 `scheduled` 产出**只有** dueAt / timezone / explicitNight / basis / **matched**
⇒ **没有**提醒内容。全仓也**没有**"从原话取提醒内容"的助手。
`reminderTemplateText(reminderText)` 是**接收**正文的（用于到点交付），不是生产正文的。
```

### ✅ 2026-10-07 用户裁定：**B —— 创建时让她写**

```text
正文由**模型在创建那一刻**写一句（不是到点时才给）。
⇒ 意图行一建就带着它被确认过的正文
⇒ "未创建不说已设"这条上游保证**更硬**（正文与排期同一刻成立）
⚠️ 代价如实记：创建那一刻多**一次私有模型调用**；且**失败时不建意图**
   （失败当作"这次没接住"，下次他再说一次即可 —— 绝不写一条空正文的意图）
⚠️ 它**不改**迁移 0014 那条 CHECK（`(kind='reminder')=(text is not null)`）——
   选 B 的附带好处正是"不用动已发布的约束"（选 C 才要新迁移）。
```

### 下一步的实现清单（下一轮）

```text
① contracts：`buildReminderTextInstruction(...)`（**从契约派生**的指令）+ 正文的**有界校验**
   （≤ `MAX_NOTIFICATION_TEXT_CODEPOINTS`；不许多字段；与 `D04` 的"一次调用就是一次调用"一致）
② infrastructure：`openai-reminder-text.ts`（与 `openai-proactive-care.ts` **同形**：
   无 key / HTTP 非 2xx ⇒ `call_failed`；超时 ⇒ `timeout`；空正文 ⇒ `invalid_output`）
③ main.ts：把入口接在 `beginTurn` **之后**（那里才有 `userEvent.id`）：
   `scheduled` ⇒ 调② ⇒ 成功才 `createIntent`（带 sourceRefs + dedupeKey）；失败 ⇒ 只记读数、不建意图
   ⚠️ 入口**只创建意图**，**不外发**（外发仍是到点五步那条路）
④ 门：**加一条"生产路径上真的有调用者"的判据** —— 这是治 `L-S8-30` 那个病的那一味药
   （静态：`src/main.ts` 里真的有 `readReminderRequest(` 与 `createIntent(`；且它们在同一段里）
⑤ typecheck + 离线门 + 有序重启（服务再断几十秒）
```

### ✅ 2026-10-07 已实现（本轮，裁定 B）—— 门 226/0

```text
① `proactive-proposal.ts` 追加：`buildReminderTextInstruction()`（**从契约派生**，正文上限引
   `MAX_NOTIFICATION_TEXT_CODEPOINTS`）+ `readReminderTextResponse()`（**闭集**：只许一个 `text`）
② 新文件 `infrastructure/model/openai-reminder-text.ts`（与 care 适配器**同形**：
   没 key / HTTP 非 2xx ⇒ `call_failed`；超时 ⇒ `timeout`；拿不到合法正文 ⇒ `invalid_output`）
③ `main.ts`：入口接在 `beginTurn` **之后**（那里才有 `userEvent.id`）——
   `scheduled` ⇒ 先 `reminderTextPort.write()` ⇒ **成功才** `createIntent`（带 sourceRefs + dedupeKey）；
   **失败 ⇒ 不建意图**（只记读数）；`clarify`/`refused` 也各留读数。
   ⚠️ 入口**只创建意图**，**不外发**（外发仍是到点五步那条路）
④ 门 **§35**：★★「`src/main.ts` 里**带参数**调用了 `readReminderRequest`」+
   「`createIntent(this.kernel` 出现在它**之后**」+「`!written.ok` 那一支只记日志」+
   正文闭集校验的**差分正控**（多一字段 / 空串 / 非字符串 / 501 码点 / 数组）
```

⚠️ **一条判据的自纠**：③ 的第一版写成"`readReminderRequest({` 与 `createIntent(` 相距 ≤2600 字符"，
实测**假红**（那段比窗口长）⇒ 改成判**顺序**（读出 < 落库）。教训与前几次同型：
**窗口是猜的，顺序是事实**。

---

## 4u. WP6 · **量具有效性（三段式）** —— 新门（先说 15/0，同轮扩到 **32/0**，见本节末）

新门 `pnpm postlv2:qq-proactive:measurement:verify`
（`scripts/postlv2-qq-proactive-measurement-verify.ts`；**不出站、不开库、纯函数**）。

```text
① 正控      ：够格的输入 ⇒ eligible:true（key=2026-10-07T21）
② 负控      ：十种"不该发"的情形 ⇒ 每一种都 eligible:false
③ 差分正控  ：②里每一种都是拿①**同一个**输入**只改一个字段**得到的
             ⇒ 判据**恰好**因为那一个字段翻红
④ 恢复档    ：把字段改回来 ⇒ 重新够格（判据看当前状态，不粘住）
⑤ 量具自证  ：`measured_count > 0`
```

| 只改的**那一个**字段 | 具名拒绝码 |
|---|---|
| 模式切成 off | `mode_off` |
| 被暂停 | `paused` |
| 入口作用域关着 | `entry_scope_required` |
| 已有一个候选在途 | `candidate_in_flight` |
| 不在活动时段（凌晨 3 点） | `outside_active_window` |
| 不够空闲（刚有人说过话） | `not_idle_enough` |
| 还在冷却里 | `cooldown` |
| 上次关心之后**没有**新入站 | `previous_care_unanswered` |
| 关心日额度用完 | `care_quota_reached` |
| 全类日额度用完 | `daily_quota_reached` |

⚠️ **十条码互不相同**（10/10）—— 这一条是**刻意的判据**：如果十种情形吐出同一个"不许"，
那"十道闸"就只是**一道**闸的十种说法。差分正控正是用来拆穿这一点的。

⚠️ **判据写成 `{...baseline, <一个字段>}` 的形式本身就是"只改一个"的证明** ——
不靠注释声明；任何一条若不小心改了第二个字段，读代码就能看出来。

⚠️ 边界：这一段覆盖的是**关心的十条预检判据**。本批其它链路的差分正控仍是
**分散的结构判据**（§29 依据面 / §30 收集器 / §31 defer / §32 焊接 / §33 执行核心），
**没有**统一成一段"只改一个字段"的形式 —— 那是 WP6 剩下的活。

### ⏩ 同轮补齐：**四组**判据都走"只改一处" ⇒ 门 32/0

```text
① 关心的十条预检判据（第一组，见上表）
② **依据集有界化**：基线 3 条好条目，每条只改一处
   空 ref ⇒ 剔 · 空 label ⇒ 剔 · 同 ref ⇒ 去重 · 200 码点 ⇒ 截到 120 · 9 条 ⇒ 截到 8
③ **来源复核**：基线合法，只改一处
   一条引用出闭集 ⇒ `proactive_source_stale`
   可用集换空 ⇒ `proactive_source_set_unavailable`
   引用清空 ⇒ `proactive_without_source`
④ **严格解析**：基线合法，只改一处
   多一个字段 ⇒ `proactive_unknown_field` · decision 出闭集 ⇒ `proactive_bad_decision`
   send 没正文 ⇒ `proactive_send_without_text` · 缺 reasonCode ⇒ `proactive_missing_reason_code`
```

⚠️ **量具自身又抓到我一处**：④ 第一版里我拿"把 `sourceRefs` 清空"当解析层的负控，
期望它作废 —— 结果**过了**。查下来是**我测错了层**：空引用由 `verifyProactiveSources` 拒
（`proactive_without_source`，③ 那一组已经量过），**不是**解析器的活。
⇒ 这个错误的期望值本身是一条**真读数**：**两道闸各管各的**，解析器不会替复核层下结论。
已换成"只缺 `reasonCode`"这个真正的解析层缺失。

---

## 5. ⚠️ 本 WP 的**边界**（还差的，不许当成"能发了"）

```text
已完成：
  A.  能力声明 / 登记 / 治理开关 / 条件授予 / 参数闭集 / 收件人不可提供 / 消费锁 / 策略配置
  B① 闭集双向协议：DELIVER_QQ_TEXT / REPORT_QQ_DELIVERY 进两张受控表；回执是控制类
  B② 出站有界（500 码点）+ 四条具名失败关闭
  B③ 外壳侧真的投递：LgStdioClient 不再丢该行、OneBotPrivateClient 的公开面（同一条队列、普通回复优先）
  B④ **连接代次**：`QqDeliveryRegistry.openConnection/closeConnection`；旧代次发起投递或回执都被具名拒绝
  B⑤ **回执落账**：`QqDeliveryRegistry.report()` ⇒ `notification_occurrences` 的三态；
     **投递适配器**（`qq.private.message`/`send`，effect = `message_sent` + 正文指纹）
未做（逐条列清）：
  ⑦ **账本 / trace 与实例的对账**：`occurrenceKey` 作为幂等键交给 `ActionRequest.idempotencyKey`、
     trace step 与实例的关联、以及"两类候选各实际执行一次 send API"的**整链**读数（要真核心装配）。
  以及（属接线）：`resolveTarget` 的 `qq_private_owner` 支 · R2 额度的程序常量签发 ·
     入口读点 / 调度器 / 网关的"不落用户事件"编译入口 / `system_opportunity` section /
     真实私有模型调用 · 外壳侧"另一路保持可用"的端到端复核。
  ⚠️ `QqDeliveryRegistry` / 适配器**都还没有在 `src/main.ts` 里被装配** ——
     它们今天是"已建好、有读数、可被判据层驱动"的部件。
⇒ 在那之前，**没有任何一段代码能让一条消息真的发出去**：
   §18 证明的是**线缆与外壳能做对**，§19 证明的是**登记与适配器能做对**，都不是"产品链路已通"。
```

---

## 6. WP5 **不**主张什么

```text
① 不主张"她能发消息了"：§5 的 ④⑤⑦ 与接线一条都没做 —— 只有声明、闸、线缆与外壳侧投递。
② 不主张"工具目录里它会显示为可用"：它在任务候选表外 ⇒ 目录按 `isCapabilityEnabled` 如实显示未开启。
   这是**设计**（计划 §7："主动联系不授予这些能力"），不是缺陷。
③ 不主张"R2 已经能被执行"：全局上限仍是 R1；额度必须由调用点显式签发，那条还没写。
④ 不主张"收件人绝对安全"：本轮的证据是**参数闭集 + 黑名单 + 复核函数 + 外壳侧 owner 固定**；
   真正的"没有收件人字段可用"由 `resolveTarget` 的绑定常量兜底，那条还没写。
⑤ 不主张"`idempotency: 'required'` 已被验证"：它是本仓库第一个用 `required` 的能力；
   调用方**必须**显式给键（策略第 ⑧ 步会拒无键请求），真正落键还没做。
⑥ 不主张"策略配置已被真人校准"：默认值是 ADR-110 `D14` 的**待冻结建议值**，不是实测最优。
⑦ 不主张"多外壳并发已安全"：**代次闸已经建好并有读数**（旧代次的投递与回执都被具名拒绝），
   但它**还没有在 `main.ts` 里被装配** —— 今天没有任何生产路径会调用 `openConnection()`。
⑧ 不主张"外壳侧端到端 = 产品链路"：§18 用**假核心**（不是 `src/main.ts`）与**模拟 OneBot**
   （不是本机 NapCat）跑通；"真核心 + 真 NapCat + 无入站"那一条属 WP6 的真实链。
⑨ 不主张"另一路保持可用"已经有读数：计划 §8 的这一条要端到端复核（QQ 主动投递时皮套仍能对话），
   属接线与 WP6。
⑩ 不主张"回执一定会到"：登记表现在能**结算**回执，但没有任何东西保证外壳一定会回 ——
   一条 `dispatching` 的实例会一直停在那里（孤儿清扫在 WP3 的 `quarantineOrphanedDispatching` 里，
   生产侧尚未接线）。这是 `D08` 的已知边界，不是缺陷。
```

---

## 7. 本 WP 跑过的门（**实测读数**）

| 门 | 读数 | 为什么跑到它 |
|---|---|---|
| `pnpm typecheck` | **EXIT 0** | 任意 `.ts` |
| `pnpm postlv2:qq-proactive:verify` | **113 通过 / 0 失败**（`measured_count=113`）· EXIT 0 | 本 WP 的专属门（§16–§19） |
| `pnpm postlv2:bridge:verify` | **PASS**（`measured_count=283`） | `turn-bridge.ts` 的两张受控表改了 |
| `pnpm postlv2:transport:verify` | **PASS**（`measured_count=78`） | 同上（传输层的排队分类） |
| `pnpm qq:verify` | **PASS**（真实库树摘要**前后逐字相同**） | `onebot-private-client.ts` / `lg-stdio-client.ts` / `scripts/qq/chat.ts` |
| `pnpm postlv2:coexist:shells` | **PASS**（`W-9 ★ 真实库从未被打开`：树摘要 `9455f82e4de5fb4f…` 前后逐字相同） | `LgStdioClient` 的行处理改了 |
| `pnpm postlv2:role-tool:verify` | **overall = PASS** | 能力登记改变了夹具与生产的一致性 |
| `pnpm kernel:test` / `kernel:verify` | **27 / 25 通过 · 0 失败** | `contracts/**` 与 `kernel/app` |
| `pnpm m4:test` | **262 通过 / 0 失败** | `flags.ts` |
| `pnpm m4.5:test` | **150 通过 / 0 失败** | 含 4 条手写消费锁；`ActionEffect` 联合加成员 |
| `pnpm m4.5:verify` / `m4.5:measurement:verify` / `m4.5:nl-action:verify` | **53 / 38 / 32 通过 · 0 失败** | `src/kernel/action/**` + 新适配器 |

⚠️ **`ActionEffect.kind` 加 `message_sent` 没有打破任何既有门**（三个 m4.5 门 + kernel 门都原样绿）——
这条特意先跑过才继续。
⚠️ 未跑：`pnpm m4.5:ci`（全量串行离线门）留到 **WP6**。

---

## 8. 一条**工程事故**（如实登记）：门脚本的标签被编码往返损坏（`L-QQP-03`）

### 8.1 事故本身

我在用 shell **就地改写** `scripts/postlv2-qq-proactive-verify.ts` 的三个调用点时，
`Get-Content -Raw` + `Set-Content -Encoding utf8` 走的是**代码页往返**（本机是 GBK/936）：
UTF-8 字节被按 GBK 解码 → 再按 UTF-8 写回 ⇒ 全文中文变成乱码，且在解码时**逐字丢字节**。

```text
原文        ：）'          （一个 CJK 全角括号 + 闭合单引号）
GBK 解码后   ：把这两个字节当成**一个** GBK 双字节字 ⇒ 只剩一个"不能解码"的位置
UTF-8 写回后 ：U+FFFD（替换符）
⇒ 净损失 = 1 个全角标点 + **1 个闭合引号** ⇒ 语法直接坏掉
```

后果（实测读数）：

```text
tsc 报错       179 条，涉及 147 行
含 U+FFFD 的行  279 行（其中"引号不配对"133 行）
```

⚠️ **这条与 §8 里上一轮那次是同一个成因** —— 我**已经**写过"不要用 shell 就地改写含 CJK 的源文件"，
然后又犯了一次。教训不是"知道了"，而是：**这类改写必须走编辑工具或 .NET UTF-8 API，不能走 `Get-Content`/`Set-Content`。**

### 8.2 为什么它没被 `git` 救回来

⚠️ 这个脚本是**未提交的新文件**（`??`）⇒ `git checkout` **救不回来**。
这正是上一次记录里那句"如果那是一个未提交的新文件，这次事故就会真的丢失内容"的**应验**。

### 8.3 修复（两段，都可机器验证）

```text
① 机械反演：GBK 编码 → UTF-8 解码，把 99% 的中文**真的还原**回来
   （还原后：`post-Lv2 / **QQ 主动联系**` 一类文本逐字正确）
② 剩下 571 处**真的丢了字节**的位置 ⇒ 换成**可见的 ASCII 占位 `?`**
   ⚠️ 这一步是**如实留标记**，不是猜原文
   ⚠️ 必须换：`U+FFFD` 会让 tsc 直接判 **TS1490 "File appears to be binary"**，整份文件连语法检查都进不去
③ 逐行修回**语法**：四张 [行号, 正确整行] 表（36 + 28 + 74 + 7 = 145 行），
   全程走 .NET UTF-8 与 `fs.writeFileSync(..., 'utf8')`（**不**经代码页）
   ⚠️ 应用器带一条闸：**只允许改动带损坏标记的行**（写错行号会把好行改坏 ⇒ 直接抛）
```

**验证读数**：

| 观测量 | 事故后 | 修复后 |
|---|---|---|
| `tsc` 报错（本文件） | **179** | **0** |
| `pnpm postlv2:qq-proactive:verify` | 跑不起来 | **125 通过 / 0 失败**（`measured_count=125`）· EXIT 0 |

⇒ **语义判据无损**：判据比的是**码**与**布尔**，不是标签文本；
`measured_count` 与事故前逐字相同（125）。

### 8.4 ⚠️ 仍未修的（**如实登记**，不许当成"已恢复原状"）

```text
· 232 行里还有 **273 处**"中文旁边"的 `?` 占位（可见标记，不是猜的）
· 它们**只影响可读性**，不影响任何判据：那 273 处全在**注释**与 `check(...)` 的人读标签/明细里
· 没有丢过：任何 `code` / 期望值 / 断言表达式 / 控制流
· 修法（下一轮或独立小 WP）：按行把 `?` 还原成原话 —— 但**不能**靠猜，
  只能靠"这句话说的是什么"重写 ⇒ 它是一次**文本重写**，不是数据处理
```

⚠️ **这条限制的边界**：`L-QQP-03` 主张的是"**判据无损、标签可读性有损、已登记**"，
**不**主张"文件已逐字节恢复原状"。后者**做不到** —— 丢掉的字节不可逆。


我在用 PowerShell **就地改写**两个 `.ts` 文件里的能力名时，`Get-Content -Raw` + `Set-Content`
把整个文件的中文注释变成了乱码（编码往返错误）。`pnpm typecheck` **立刻**报出语法错
（`Unterminated string literal` 一类），我 `git checkout --` 还原这两个文件、再用 `edit` 工具重做。

```text
教训：**不要用 shell 就地改写源文件**（尤其含 CJK 的）；用编辑工具。
代价：可忽略（文件是干净树里的受版本控制文件，还原即可）；但如果那是一个**未提交**的新文件，
      这次事故就会真的丢失内容。
```
