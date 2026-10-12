# S3 ③ / S4 ② 接线规格（2026-10-10）—— 供机械执行

前景：S2 已完整关闭；S3 ①②（闭集 `repeat` + `decideReminderRepeat`）已提交，**判据冻结、尚无消费者**；
迁移 #18 已应用到生产库（`repeat_mode` / `repeat_attempt` 两列就位），迁移后读回干净。
本文只写**接线**要做的事与锚点 —— 每一步都是行号级的，不需要再侦察。

## 0. 一句话

把已经冻结的两个判据接上真实链路：**投递后问 `decideReminderRepeat` 决定要不要 60s 后续发**，
把 `repeat_mode`/`repeat_attempt` **落库**（跨重启要靠它），并在**用户任何回复**时**销账**。

## 1. S3 ③：让 `repeat` 真的生效

### 1.1 写侧：把 `repeat` 存到意图上
```text
① src/kernel/app/reminder-turn.ts
   · ports.create 的入参加 `repeatMode?: ReminderRepeatMode`
   · ports.update 的入参同样加（确认/补充不该丢掉这条）
   · 两处调用点（:113 的 create、:110/:119 的 update）把 `draft.repeat` 传进去
② src/main.ts:~4278（`createIntent(db, { id: 'qni:…', … deliveryChannel: request.channel, … })`）
   · 加 `repeatMode: request.repeatMode ?? null`
   · 同一处的 update 端口同样透传
③ src/infrastructure/persistence/notification-store.ts
   · 意图输入类型（含 `delivery_channel: ChatChannel` 那一组）加 `repeat_mode?: string | null`
   · createIntent 的 INSERT 列清单与参数各加一处
   · updateIntent（若存在）同样
```

### 1.2 读侧与驱动：投递之后决定续发
```text
④ src/infrastructure/runtime/reminder-scheduling.ts（本文件 :11-54 是唯一装配点）
   · 该处已有 `dispatch: registry` / `action: { execute }` / `generation: registry.currentGeneration()`
   · 在**投递成功**之后（`advanceOccurrence` 推进到 `api_accepted` 的那条路径，
     见 src/infrastructure/persistence/notification-store.ts:525）追加：
        const d = decideReminderRepeat({ mode, attempt: intent.repeat_mode === 'until_reply' ? attempt : 1,
                                          deliveredAt: now, settledByReply, paused })
        d.kind === 'repeat' ⇒ 以**同一 intent**、attempt+1、due_at = d.nextAt 排下一条 occurrence
                              （占用仍走唯一入口 `reserveOccurrence()`，见 notification-store.ts:445/467）
        d.kind === 'stop'    ⇒ 什么都不做（具名理由已在决策里）
   · `repeat_attempt` 落库：occurrence 的那一列（迁移 #18 已加）
⑤ 重启恢复：`quarantineOrphanedDispatching()`（notification-store.ts:591）已把遗留 `dispatching`
   判为**结果不明**（ADR-110 D08 末行）；续发要在此之外**重新排**未到上限的那条
   ⇒ 启动时按 `repeat_mode='until_reply'` 且 `repeat_attempt < 10` 且未销账 的意图重新 arm
```

### 1.2b 驱动的接缝（2026-10-10 读全 `reminder-scheduling.ts` 后的**精确落点**）

`createReminderScheduling({ db, characterId, channels, registry, execute, reading })`（:11-16）：
```text
listPendingReminders()（:19-29）  ← 列 pending 意图，按 attempted/channels/代次过滤，缓存进 `intents`
onReminderDue(due)（:30-57）      ← 真正的投递路径：
     getIntent ⇒ 必须 status === 'pending' ⇒ decideReminderDue ⇒
       'expire' ⇒ finishIntent(…, 'expired')
       否则     ⇒ deliverReminder({ … store: { reserveOccurrence, advanceReminder }, dispatch, action, generation })
```
⇒ **续发要接在 `deliverReminder(...)` 返回之后**（:42-55）与 **`listPendingReminders` 里**（重启恢复）。

⚠️ **两个原规格没写的缺口（本轮读出来的，必须补）**：
```text
缺口 A：**读映射**。写侧只改了 INSERT；`NotificationIntentRecord` 要能读出 `repeat_mode`，
        还得把 `repeat_mode` 加进 `IntentRow` 与 `rowToIntent()`。
        ⇒ 不补这一处，驱动读到的 `intent.repeatMode` 永远是 undefined（"写了但读不回"，
          与 ADR-110 §25 那次"看起来接上了"同型）。
缺口 B：**`lastInboundAt` 不在这个工厂的入参里**。销账要靠"投递之后用户回过没有"，
        而 `lastInboundAt`（最近一次真实入站）现在只在**关心机会预检**那条路里算（在 main.ts）。
        ⇒ 工厂入参要加一个读数口（例如 `lastInboundAt: () => Promise<number>`），由 main.ts 提供。
```
其余（判据本身、attempt 的来源、上限）都已就绪：occurrence 行自带 `attempt`（读回时亲见
`"attempt":1`）；上限与间隔来自已冻结的 `REMINDER_REPEAT_MAX_ATTEMPTS / _INTERVAL_MS`。

### 1.2c 接线的最小形态：**续发全部收在 `listPendingReminders` 一处**

（2026-10-10 想通：这比"投递后再排一条"小得多，也更难出错。）

```text
为什么可以只改一处：
  `listPendingReminders()` 是调度器每次 refresh/tick **唯一**问"现在有哪些该发"的地方；
  它返回的 `{ occurrenceKey, dueAt }` 直接决定什么时候投递。
  ⇒ 对 `repeat_mode='until_reply'` 的意图，**不返回意图原本的 scheduledAt**，
     而是返回"**下一条该发的时刻**"（由 occurrence 行推出）即可 —— 续发、恢复、上限、销账**同一处**解决。

具体（都在这一个函数里）：
  对每条 pending 意图：
    · 取该意图**最新一条** occurrence（需要 store 加一个只读查询，例如
      `latestOccurrenceForIntent(db, intentId)` → { attempt, dueAt, state } | undefined）
    · 若不是 until_reply            ⇒ 原样返回（scheduledAt）—— **旧行为逐字不变**
    · 若是 until_reply：
        未销账（`(await input.lastInboundAt?.() ?? 0) <= 上次投递时刻`）
        且 attempt < 10
      ⇒ 返回 { occurrenceKey: reminderOccurrenceKey(intentId, planVersion, dueAt = 上次投递 + 60s),
               dueAt: 上次投递 + 60s }
      否则 ⇒ 不返回（= 不再续发）—— 具名理由由 reading 记
  真到点时，`onReminderDue` **一行都不用改**：它照旧 reserveOccurrence（新键）+ 投递 + 推进。

⇒ 于是 `nextRepeatOccurrence`（已冻结 + 6 条门断言）正好是这个函数的"算 dueAt 与键"那一步，
  接线只是**在 `listPendingReminders` 里调用它**，并把 store 的那个只读查询补上。

#### ⚠️ 接线前必须先解决的两个缺口（2026-10-10 读 `onReminderDue` 时发现）

```text
缺口 G1：`onReminderDue` 里 reserve 用的是 **intent.scheduledAt**，不是我要返回的 due.dueAt：
    reserveOccurrence(input.db, { occurrenceKey: due.occurrenceKey, …,
                                  dueAt: intent.scheduledAt, … })
  ⇒ 续发那一条的实例行会把 due_at 记成**原始排期**，于是
     `latestOccurrenceForIntent`（按 due_at 排序）读到的"上次时刻"永远不变
     ⇒ 下一次算出来的 dueAt/键**与上一次相同** ⇒ 被 `attempted` 过滤 ⇒ **续发只发生一次就停**。
  ⇒ 必须先把它改成 `dueAt: due.dueAt`（对**非续发**路径逐字等价：那里 due.dueAt === intent.scheduledAt）。

缺口 G2：`attempt` 走不进 `reserveOccurrence`。
  它的入参是 `{ occurrenceKey, intentId, expectedPlanVersion, characterId, kind, dueAt,
                permissionVersion, policyVersion }` —— **没有 attempt**。
  ⇒ 迁移 #18 加的 `repeat_attempt` 列会一直是缺省值，**上限 10 就从列上判不出来**。
  两条出路（择一，实现时定）：
    (a) 给 `reserveOccurrence` 加可选 `attempt`（迁移列原样可用）；
    (b) **不依赖该列**：把"第几次"改成**按意图计 occurrence 条数**（`count(*) where intent_id=…`），
        与 `latestOccurrenceForIntent` 同一个查询里带出来。**推荐 (b)**：它让"次数"成为可推导事实，
        少一列需要维护的状态（列保留，作为读数冗余）。
```
```

#### ✅ 接线前的前置条件已全部核清（2026-10-10）

```text
· repeat_mode 可读（41daa249）· 次数可推导（430497bf 的 count）· lastInboundAt 已喂（a67cb011）
· G1 已修（05325cb4：reserve 改用 due.dueAt）
· **"G3"不存在**（查证）：`finishIntent` 在提醒路径上只有**过期**一处调用
  （reminder-scheduling.ts:47 → 'expired'）⇒ **投递成功不会把意图收尾**，它仍是 `pending`
  ⇒ `listPendingIntents`（`status = 'pending'`）与 `onReminderDue` 的 `status !== 'pending'`
    **都不会挡住续发** ✓
· `finishIntent` 的状态类型 = 'delivered' | 'expired' | 'missed' ⇒ **missed 可用**（S4 ② 的词汇确认）
```

#### ⚠️ 最后一个未喂的读数口：`paused`

`decideReminderRepeat` 有 `paused`（D05：**停机/暂停优先于重复**），但调度工厂**没有**这个读数口
（暂停状态在 `notification_control`，现在只在关心机会预检那条路里读）。
⇒ 实现时要一并加（形状与 `lastInboundAt` 同：可选读数口 + 两个装配点各一行）；
   在它到位之前**不要**把续发接上，否则"暂停了还继续发"。

#### `listPendingReminders` 的目标形状（照此实现）

```ts
async listPendingReminders() {
  const pending = await listPendingIntents(input.db, input.characterId, { kind: 'reminder', limit: 500 })
  const attempted = new Set(await listAttemptedReminderOccurrenceKeys(input.db, input.characterId))
  intents.clear()
  const due: { occurrenceKey: string; dueAt: number }[] = []
  for (const intent of pending) {                       // flatMap ⇒ for（要 await）
    if (!input.channels.includes(intent.deliveryChannel)
        || input.registry(intent.deliveryChannel).currentGeneration() === null) continue
    const base = reminderOccurrenceKey({ intentId: String(intent.id), planVersion: intent.planVersion, dueAt: intent.scheduledAt })
    if (intent.repeatMode !== 'until_reply') {          // 普通路径：**逐字不变**
      if (attempted.has(base)) continue
      intents.set(base, intent); due.push({ occurrenceKey: base, dueAt: intent.scheduledAt }); continue
    }
    const { occurrence, count } = await latestOccurrenceForIntent(input.db, intent.id)
    if (occurrence === undefined) {                     // 第一条还没发过 ⇒ 原排期
      if (attempted.has(base)) continue
      intents.set(base, intent); due.push({ occurrenceKey: base, dueAt: intent.scheduledAt }); continue
    }
    const lastInbound = (await input.lastInboundAt?.()) ?? 0
    const armed = nextRepeatOccurrence({                // 已冻结 + 6 条门断言
      intentId: String(intent.id), planVersion: intent.planVersion, mode: intent.repeatMode,
      attempt: count, deliveredAt: occurrence.dueAt,
      settledByReply: lastInbound > occurrence.dueAt, paused: /* 见上：先补 paused 读数口 */ false,
    })
    if (armed.kind === 'stop' || attempted.has(armed.occurrenceKey)) continue
    intents.set(armed.occurrenceKey, intent); due.push({ occurrenceKey: armed.occurrenceKey, dueAt: armed.dueAt })
  }
  return due
}
```

### 1.2d 接线级门（S3 ③ 还欠的那 5 条）—— 可照抄的配方（2026-10-10 查证）

```text
目的：不是再量一遍纯函数（那 18 条已绿），而是量**接线**：`listPendingReminders` 的四个分支。

配方（全部有先例，不要自造）：
① registry 替身 —— **不要写假对象**：仓库既有门用的是**真的** `QqDeliveryRegistry`
   + 一个**内存 store 口**：
     scripts/postlv2-qq-proactive-verify.ts:1898  `const registry = new QqDeliveryRegistry({ store: port })`
     (:2173 的注释逐字："用一个内存登记表，真的是 QqDeliveryRegistry，不是另写一个假的")
   store 的形状照 main.ts:427-441 的 `reminderDeliveryChannel()`：
     `{ store: { readOccurrenceState: async key => undefined, advanceOccurrence: async () => {} }, onReading? }`
   取"当前代次非空"：`registry.openConnection(() => ({ written: true }))` ⇒ `currentGeneration() !== null`
② 隔离库与建表：照本门既有的 legacy 块（`isolateDatabase(...)` + `openRawPGlite(dir)` +
   逐条 `MIGRATIONS` 的 statements），并**照抄它的 notification_intents INSERT**（那一行已经把
   所有 NOT NULL 列与两条 check 都满足：`kind='reminder'` ⇒ `text` 非空且 `has_source=true`），
   只是多给一列 `repeat_mode='until_reply'`。
③ 造"已有实例"：再插一行 `notification_occurrences`（`intent_id` 指向上面的意图、`due_at` 取旧时刻、
   `state='api_accepted'`）⇒ 这样 `latestOccurrenceForIntent` 的 `count` 才有值。
④ 调用与断言（5 条，正是欠的那 5 条）：
     正控  until_reply + 已有实例 + 未销账 + 未暂停
            ⇒ 返回**恰好一条**，且 `occurrenceKey === reminderOccurrenceKey(intentId, planVersion, 上次 due_at + 60_000)`
     负控① 把上面那个键塞进 `attempted`（预插一条同键实例）⇒ **不返回**（防重复投递）
     负控② `lastInboundAt` 返回 > 上次 due_at（= 他回过了）⇒ **不返回**
     负控③ `paused: async () => true` ⇒ **不返回**
     边界  实例条数 = 10 ⇒ **不返回**
     兼容  把意图的 `repeat_mode` 置回 NULL ⇒ 返回与改动前**逐字相同**的 `{ occurrenceKey: baseKey, dueAt: scheduledAt }`
⑤ 计数自检：`measured_count` 里这 6 条要真的计入（本门的既有做法）。
```

### 1.2e ⚠️ 第一次尝试踩到的 3 个障碍（2026-10-10，已如实回退）

我第一次把门写进去时**编译不过 + 运行崩溃**，于是**把该文件回退到全绿状态**（不留红门）。
三个障碍都记在这里 —— 它们是下一次一把过的关键：

```text
障碍 1：**MIGRATIONS 不能无条件全量应用**。
  全量跑会在隔离库上崩：`error: type "vector" does not exist`（某条迁移依赖 pgvector 扩展）。
  ⇒ 要么先建扩展，要么像本门既有 legacy 块那样**按版本过滤**
     （legacy 块只跑 `version >= 14 && version <= 16`；本次需要到 18 ⇒ 范围取 14..18）。

障碍 2：**`openRawPGlite(dir)` 返回的不是 `RawDb`**。
  `createReminderScheduling` 的入参要 `RawDb`（类型上带 `execute`），而 `openRawPGlite` 给的是
  可直接 `.query()/.exec()` 的句柄 ⇒ 直接传会得到
  `Property 'execute' is missing in type 'RawPGlite' but required in type 'RawDb'`。
  ⇒ 下一次要先查"门/脚本里怎么拿到一个 `RawDb`"的既有先例（`kernel-tests-memory.ts` 或
     `verify-m4-*` 那一族），照抄即可。

障碍 3：**registry 的 store 口 `advanceOccurrence` 有确切返回形状**，不是 `async () => {}`：
  期望 `(input: { occurrenceKey: string; to: NotificationOccurrenceState;
                 platformMessageId?: string; reasonCode?: string }) => Promise<{ … }>`
  ⇒ 先读它的返回类型（`notification-delivery.ts` 的 store 口），再写内存替身。
  （`readOccurrenceState: async () => undefined` 是允许的：它返回可空。）

教训：**这三个都是"类型/运行期才会暴露"的**，静态看配方看不出来 ⇒ 写这种门必须留出
     "写 → typecheck → 真跑 → 修" 的完整余量；余量不足时**应该只取信息、不落代码**（这次我试了，并如实回退）。

#### 复查后的两个新事实（2026-10-10），它们改变"怎么写这道门"

```text
事实 A：`RawDb` **只有一个方法** ——
    export interface RawDb { execute: (query: unknown) => Promise<unknown>; transaction?: … }
  而 `openRawPGlite(dir)` 给的是可直接 `.query()/.exec()` 的句柄（**没有** `execute`）
  ⇒ 想拿到 RawDb，仓库的既有办法是**起一个 runtime**：`initDatabase(runtime, sqlPlugin)` +
     `getRawDb(runtime)`（先例 `scripts/diagnose-repeat-reply.ts:47/130`、`action-harness.ts:182`、
     `eval-m4.ts:121` 一族）。
  ⇒ 也就是说：**函数级门要背一个 runtime 装配**（AgentRuntime + plugins + character + initDatabase），
     大约 20 行 import 与装配 —— 这就是"为什么这道门一直没人写"的真实原因。
  ⚠️ 不要试图拿 `openRawPGlite` 手搓 `{ execute }`：`execute` 收到的是 sql`` 构造出来的对象，
     手搓包装很容易做出"看着能跑、语义不对"的东西。

事实 B：60s 间隔是**冻结常量**（`REMINDER_REPEAT_INTERVAL_MS`，不可注入）
  ⇒ 想用**既有行为门**（本门已有的 `EntryShell`/`startCoexistHost` 真外壳那条路，
     先例 `postlv2-qq-proactive-chain.ts`：真核心 + 真外壳 + 模拟 OneBot）去测续发，
     至少要等 **60 秒**才能观测到第二条 —— 门会慢到不可接受。

⇒ 因此**两条路各有代价**，下一次要在这两条里选一条并写进 ADR：
   (i) 函数级门：装配一个 runtime 拿 RawDb（~20 行装配），断言那 6 条 —— **快**，但离真实链路远一步；
   (ii) 行为级门：真核心 + 真外壳，等 60s 观测第二条 —— **最真实**，但慢（且要能容忍 60s 门时长）；
   (iii) 第三条（更省）：把间隔做成**可注入**（构造参数或 env），使行为级门能在秒级跑 ——
         但这**改动了已冻结常量**的形态，属于设计变更，需要你点头。
```

#### 函数级门的第二次尝试（2026-10-10，用户选路 (i)）—— 进展与两条精确发现

```text
✅ 装配走通了：起 runtime（initDatabase + getRawDb）· registry 用**真的** QqDeliveryRegistry +
   store 口照**生产写法**（main.ts）⇒ 类型全对、与线上同形。
✅ **正控 PASS**：真库上 `until_reply` + 已有实例 ⇒ `listPendingReminders` 臂出的键
   **确实是"上次 due_at + 60s"** ⇒ **接线本身被真库读数验证了**（这是本轮最有价值的证据）。
❌ 负控①（撞 attempted）失败，实测返回键 = `…repeat-1:1:61000`。

两条精确发现（都把失败原因钉死了）：
① `listAttemptedReminderOccurrenceKeys` **没有 state 过滤** —— 它就是
     `select o.occurrence_key … from notification_occurrences o
      join notification_intents i on i.id = o.intent_id
      where i.character_id = … and i.kind = 'reminder'`
   ⇒ 任何实例行就算"已尝试"；**夹具不需要推进状态**（我上一版多做的 `advanceOccurrence` 是多余的）。
② 我的**第二次 `reserveOccurrence` 静默没落**（证据：臂出 61000 = 1000+60s ⇒ 只看到 1 条实例、count=1）。
   ⇒ 夹具必须**断言 `created === true`**（或至少把 `created` 打进标签）—— 否则"负控的前提"会静默不成立，
     这正是本次失败暴露的**量具缺陷**（不是被测代码的缺陷）。

⇒ 下一次（同一路）要改的就三处：夹具插入断言 created、去掉多余的 advanceOccurrence、再跑负控。

#### 🔴 第三次尝试抓到**真缺陷**：按现状接线，**续发根本发不出去**（2026-10-10）

夹具自检（`assert.ok(written.created === true)`）当场把这件事抓了出来 —— 它**不是**量具问题：

```text
证据（行号级）：`src/infrastructure/persistence/notification-store.ts:502-505`
  reserveOccurrence 的 INSERT … select 末尾带一条**一致性 EXISTS**：
      where exists (select 1 from notification_intents i
        where i.id = … and i.character_id = … and i.status = 'pending'
          and i.plan_version = … and **i.scheduled_at = ${input.dueAt}**)
  ⇒ 它**要求"实例的 dueAt 等于意图的 scheduled_at"**（提供 expectedPlanVersion 时）。

后果（两条路都不通）：
  · G1 之后（reserve 用 `due.dueAt`）：续发臂的 dueAt = 上次 + 60s ≠ 意图原 scheduled_at
    ⇒ EXISTS 不成立 ⇒ 插入**什么都不做** ⇒ `created:false` ⇒ 派发被跳过
    ⇒ **续发"排上了"但永远不会真的发出**（正是本仓库最忌讳的"看起来接上了"）。
  · 回到 G1 之前（reserve 用 intent.scheduledAt）：EXISTS 会过，但实例 due_at 记成原排期
    ⇒ 下一次算出的键与已尝试的键**撞上** ⇒ 被 attempted 过滤 ⇒ 同样发不出去。
```

⇒ **这是我先前报"接线 ✅ CI EXIT 0"时没有覆盖到的地方**（如实更正）：CI 绿是因为**没有任何用例走完一次续发派发**；
  判据层那 18 条 + 驱动核心 6 条也都在纯函数层面。

**修法（需要你/实现时选一条）**：
```text
(a) 【推荐】续发时**把意图的 scheduled_at 前移到下一条**（arm 就是
      `update notification_intents set scheduled_at = 上次 + 60s where id = …`）
    ⇒ `scheduled_at = dueAt` 这条既有不变式**保持成立**，reserve 照常работает；
      而且 `listPendingReminders` 会**更简单**（意图自己的 scheduled_at 就是"下一条该发的时刻"）。
    ⚠️ 要配门：非 until_reply 的意图不得被动 scheduled_at（逐字保持旧行为）。
(b) 放宽这条一致性（续发那条路传 `expectedPlanVersion: undefined`，或加列区分首投/续发）
    ⇒ 改动小，但**削弱了一条现有护栏**（首投时的"意图必须 pending 且排期一致"）。
(c) 改键/排期模型（occurrence 的 due 与 intent 的 schedule 解耦）⇒ 动作最大，需新 ADR。
```
```
```


### 1.3 销账：用户**任何回复**即停

**已定（2026-10-10 查证）：不需要新增迁移。** 两条理由都是查出来的事实：
```text
① 既有状态闭集（migrations.ts:1605-1606）：
     check (status in ('pending', 'delivered', 'cancelled', 'expired', 'missed'))
   ⇒ 投递成功那条已是 `delivered`；"用户已回应、不必再续发"**不需要**新状态。
② 更干净的做法：**不落新标记，直接推导** ——
   续发判据 = `repeat_mode='until_reply'` 且 `repeat_attempt < 10`
             且 **`lastInboundAt` ≤ 上次投递时刻**（即"投递之后用户没有回过任何一句"）
   ⚠️ `lastInboundAt`（"最近一次真实入站 = user_message + actor_type='user'"）**调度器已经在读**
      （关心机会预检的那一套读数里就有它）⇒ 复用它，等于"任何回复即销账"字面成立。
⑥ settle 的实现落点：`decideReminderRepeat({ …, settledByReply: lastInboundAt > lastDeliveredAt })`
   —— 判据本身早已冻结（`src/kernel/app/reminder/repeat-policy.ts`），这里只是喂真读数。
```

## 2. S4 ②：跨重启的"错过"账 + 逐条补说

```text
⑦ "错过"账（要落库）：**已定（2026-10-10 查证）：复用现成词汇，不新增表/列。**
   既有状态闭集里**已经有** `missed`（migrations.ts:1605-1606 的
   `check (status in ('pending','delivered','cancelled','expired','missed'))`）
   ⇒ 到点时核心是关的 ⇒ 意图落到 `missed`（具名、可查、跨重启成立）。
   补说的候选集 = `status='missed'` 的那批意图（按 scheduled_at 升序），**逐条**补说。

#### ⚠️ 标记侧的一个决策点（2026-10-10 查证）

```text
现状：`decideReminderDue` **没有 missed 码** —— 它只返回
        { action:'expire', code:'reminder_expired' }      ← 已过宽限
        { action:'expire', code:'reminder_not_due_yet' }   ← 还没到点（不该问）
        { action:'deliver', grace:'within_grace' }
      而调度器的过期分支把它一律写成 **`expired`**（reminder-scheduling.ts:47）。
      同时：`missed` 只出现在**存储层的终态类型**（`finishIntent` 的
      `Extract<…, 'delivered' | 'expired' | 'missed'>`）与**契约的状态表**（`contracts/notification.ts`
      的 `NotificationIntentStatus` 及 :59/:67 两个数组）里 —— 也就是说词汇**早就为"补说"备好了**，
      只是**没有任何路径真的写它**。

⇒ 要定的：**哪些"过期"算"错过"**。我的建议（需你/实现时裁定）：
    · 到点那一刻核心**不在**（重启后才发现）⇒ **`missed`**（它正是补说对象）；
    · 到点前被用户取消 / 排期被改写而作废 ⇒ **`expired`**（不是"错过"，不该补说）。
  两条路实现：
    (a) 在调度器的过期分支里按"当前时刻距 due 的远近/是否有重启证据"分流（小改，但要真判据）；
    (b) 给 `decideReminderDue` 增加一个具名码（它是有既有测试的冻结纯函数 ⇒ 要一起改门）。
  ⚠️ 无论哪条，都要配门：**`missed` 的才进补说候选；`expired` 的不得进**（双向负控）。
```

⑧ 下一轮对话时补说：
   · takeCatchupBatch(candidates)                     ← 已冻结（≤10 条 → { batch, remaining }）
   · remaining > 0 ⇒ 末句加"未补说的事件还没完" + 询问是否继续
   · 用户回复 ⇒ readCatchupContinuation(text)：
       'continue' ⇒ 取下一批        'stop' ⇒ 销账（保留在账上）
       'unrelated' ⇒ **不继续**（安全侧），且 shouldAskCatchupContinuation({remaining, alreadyAsked})
                     决定**不再自动追问**（一个批次只问一次）
```

## 3. 门与交付（每块都要）

```text
· 门内三段式（正控 / 负控 / 恢复）+ **负控至少两条**：
    不可用时不静默丢弃（S2 已有先例）· 6A 上限边界不是差一（S3 已有先例）·
    **新任务里带"继续"不得触发补说**（S4 已有先例）· **改投不得重复投递**
· typecheck EXIT 0
· 停机窗口 `pnpm m4.5:ci` EXIT 0（带已验证快照源；服务保持停机）
· hunk 级提交（`main.ts` 是多特性共享文件；本会话已三次拦下夹带）
```

## 4. 本会话已确立的纪律（接线时照做）

```text
· 判据一律**冻结纯函数**且能被门直接 import（`main.ts` 不被门 import）
· 新事实的入参一律**三态**或"缺席 = 保持既有行为"，让任何前缀都安全
  （S2 的 `available`、A2 的 `userAskedToRemember`、R-a 的 `hookInstalled` 都是这个形状）
· 旧政策断言**改写保留**，不删；把实际值打进标签（S2 那道门一次性暴露了 5 条）
· ⚠️ **占位默认值不是读数**（本会话我因此报错一次："快照缺 3 行"）；查询要么真查、要么别给数字
```

---

## 5. 会话交接（2026-10-10，S2/S3 已落地；S4 部分）

### 5.1 已完成（都有读数与提交）

```text
S2 改投 + 说明 + 可用性两档
   cef825ad 主实现（含 5 条旧政策断言**改写保留** + 8 条新断言）· CI EXIT 0
S3 ① 闭集 repeat（模型判）· ② 重复策略（纯函数 + 12 条门断言）
   5c57b6eb · CI EXIT 0
S3 ③ 写侧（端口 → INSERT → 透传）· 读回 · 缺口 A/B
   acdb74d3 · c2a14893 · 9bd2fc38 · 41daa249 · 167cf6e8 · a67cb011 · 23377fdf(paused)
迁移 #18（repeat_mode / repeat_attempt）
   8a66a2dc 代码 · **已 apply 到生产库（17→18）** · 迁移后读回干净
   ⚠️ 读回时我自己量错过一次（占位默认值当读数），已更正并写进脚本注释
S3 ③ 驱动核心（纯函数 + 6 条门断言，含键一致性/键不同两条关键负控）
   3e2c36ed
S3 ③ 驱动接线（listPendingReminders 三分支）· 缺口 G1/G2 修复 · G3 排除
   ff0e08da（**CI EXIT 0**）· 430497bf · 05325cb4 · c64eebd3
S4 ① 锚定词表 + 批次边界 + 一个批次只问一次（纯函数 + 11 条门断言）
   c6ea726d · CI EXIT 0
```

### 5.2 未完成（下一轮从这里开始）

```text
① **S3 ③ 接线级门**（6 条）—— 未写；三条路可选，**需要你选**（见 §1.2e 末尾）：
     (i) 函数级门（runtime 装配 ~20 行，快）· (ii) 行为级门（真外壳，等 60s）·
     (iii) 把 60s 间隔做成可注入（**设计变更，需你点头**）
   ⚠️ 我第一次尝试写它时编译不过+运行崩溃，**已回退**（门保持全绿），三个障碍记在 §1.2e。
② **S4 ②**：跨重启"错过"账 + 逐条补说接线
     · 词汇已定：**复用既有 `missed`**（`finishIntent` 的状态类型已含它，无需迁移）
     · 判据已冻结：`takeCatchupBatch` / `shouldAskCatchupContinuation` / `readCatchupContinuation`
     · 待做：到点未发 ⇒ 落 `missed`；下一轮对话按 ≤10 条补说 + 超了问"未完"+ 锚定词表判继续
③ 两片各自的**停机窗口 `m4.5:ci`**（服务当前停机 ⇒ 窗口现成；带已验证快照源）
```

### 5.3 本会话确立、下一轮必须照做的纪律

```text
· 判据一律**冻结纯函数**且能被门直接 import（门不 import main.ts）
· 新入参一律**三态/缺席=既有行为** ⇒ 任何前缀都安全（S2 的 available、A2 的 userAskedToRemember、
  R-a 的 hookInstalled、S3 的 lastInboundAt/paused 都是这个形状）
· 旧政策断言**改写保留**、实际值打进标签（S2 那道门一次性暴露了 5 条）
· 提交一律 **hunk 级**（main.ts 是多特性共享文件；本会话三次拦下夹带）
· ⚠️ **占位默认值不是读数**；⚠️ 门不绿不提交；⚠️ 改行为必须与门同批
```

---

## 6. S4 ② 补说侧：设计已定（2026-10-10，**不需要新迁移**）

### 6.1 两个曾被当作"要落库"的问题，都有现成答案

```text
① "这条错过已经补说过了吗" ⇒ **不用新列**：补说完就把那些意图从 `missed` 推到 **`delivered`**。
   语义正好：`delivered` = 内容已经到他那儿了（补说也是一种投递）。
   ⇒ 候选集永远只是 `status='missed'`（天然幂等：补说过的不再出现）。

② "这一批已经问过了吗"（裁定③"一个批次只问一次"）⇒ **不用新列**：
   批次边界 = "当前还有没有 `missed` 剩余"。问过一次之后，
   下一轮只会在**用户主动说 continue** 时才取下一批；否则**不再自动追问**
   ⇒ 把 `shouldAskCatchupContinuation({ remaining, alreadyAsked })` 的 `alreadyAsked`
      由**调用方在本次补说流程内**记录（一次会话内不重复问），跨轮不追问由 ① 的 `delivered` 保证。
   ⚠️ 若实现时发现"跨轮也要问"的需求，再考虑落库 —— 现在**不新增迁移**。
```

### 6.2 补说侧的目标形状（照此实现，判据全部已冻结）

```text
进入对话时（把这一块放在**回复之前**，与提醒入口同一段）：
  1. `listMissedIntents(db, characterId)`（新增一个**只读**查询，与 `listPendingIntents` 同形，
     只是 `status = 'missed'`，按 `scheduled_at` 升序）
  2. `takeCatchupBatch(missed, 10)` ⇒ { batch, remaining }
  3. 把 `batch` **逐条**补说（不合并成一句；每条的正文用它的 `text`）
  4. 补说成功 ⇒ 把这批意图推 `delivered`（`finishIntent(…, 'delivered')`）
  5. `remaining > 0` ⇒ 末句加"**未补说的事件还没完**"并询问是否继续
     （是否真的问：`shouldAskCatchupContinuation({ remaining, alreadyAsked: 本次是否已问 })`）
  6. 用户回复 ⇒ `readCatchupContinuation(text)`：
       'continue' ⇒ 下一批（**只有这时才继续**）
       'stop'     ⇒ 停（剩余项**保留在账上**，不删）
       'unrelated'⇒ **不继续**（安全侧；含"新任务里带'继续'"）
```

### 6.3 门（三段式 + 负控，必须有的两条）

```text
· 正控：`missed` 的进候选、补说完变 `delivered`、恰好 10 条不问、11 条要问
· **负控①：`expired` 的不得进候选**（标记侧已经把它与 missed 分开了 —— 这里再拦一道）
· **负控②：「继续帮我看看那个回收站」⇒ unrelated ⇒ 不得触发补说**（锚定词表的意义就在这条）
· 负控③：已问过（`alreadyAsked=true`）⇒ 不再自动追问
```


