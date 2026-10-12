# S0（R6）：提醒入口无关 —— 落地方案（2026-10-10）

用户裁定 **S0-b：旧桥入口改走共享核心那套机制**。
目标（R6 逐字）：提醒功能的开关**无论从哪个路径启动都应保持开启**。

## 侦察结论（行号级，已实测）

```text
① 现成机制已存在：`src/main.ts:437` 起的 `startStandaloneReminders({ kernel, session, flags, channel, write })`
   · 它自己完成：通道注册（`reminderDeliveryChannel`）→ `bindLocalReminderConnection` →
     `ProactiveScheduler`（Croner timer）→ `reminderRefreshHook = () => timer.refresh()` → `timer.start()`
   · 它的门槛是 **flags**（`qqProactiveMode === 'on' && entryScopedConversations`），**不是入口**
   · 返回 `{ report, stop }`（stop 会 `timer.stop()` + `drain()` + 清 hook/channels + `connection.close()`）
② **唯一的缺口**：`channel` 的类型是 `'cli' | 'avatar'` —— **没有 `qq_private`**。
   ⇒ 旧桥入口（`src/main.ts --bridge --qq-private`）没有任何提醒出口
   ⇒ `reminderRefreshHook` 恒 `undefined` ⇒ `main.ts:4213` 的 `enabled=false`
   ⇒ `reminder-turn.ts:93` 返回 `refused: reminder_delivery_unavailable`（实测 2026-10-10 17:22 那条模板）
③ QQ 私聊的投递链**已经在**：`reminderDeliveryChannel()` 的
   `if (channel === 'qq_private') return proactiveDeliveryChannel(db)`（ADR-110 的登记表）
   ＋ `ChatSession.deliverProactiveQqText()`（ADR-110 §25 焊接，签发 R2 的**唯一**一处）
   ＋ QQ 入口每连接一个代次的 `setOutputSink` / `reportQqDelivery`（断开按代次回收）
```

⇒ **S0-b 的实现 = 三处改动**（不是入口重构）：

```text
S0-b-1  `startStandaloneReminders` 的 `channel` union 增加 `'qq_private'`
        —— ⚠️ **但不止是 union**：该函数对**所有**通道都调
           `bindLocalReminderConnection(db, channel, registry, write)`，那是**本地通道专用**
           （cli/avatar 的投递报告）。`qq_private` 的报告路径不是它，而是
           `bridge.setReminderDeliveryReporter(...)`（main.ts:7602）+ QQ 投递登记表（ADR-110）。
        ⇒ 必须按通道分两条：
             本地通道  registry = reminderDeliveryChannel(db, ch) + bindLocalReminderConnection（现状）
             qq_private registry = proactiveDeliveryChannel(db)（**不**建本地连接）
                        report 由 QQ 登记表的读数提供；sink 在连接那一步已绑（main.ts:7598）
        否则会得到一个"本地连接+QQ 通道"的混合体 = 看起来接上了，其实报告路径是错的。
S0-b-2  放开入口条件。**实测定位到那一行**（main.ts:7599）：
            const standaloneReminders = kernel && qqPrivate === undefined ? await startStandaloneReminders({
              kernel, session, flags, channel: 'avatar', write: out => bridge.deliverReminderText(out),
            }) : undefined
        ⇒ 条件里那个 `qqPrivate === undefined` 就是"QQ 私聊没有提醒出口"的原因；
          改成按 `qqPrivate` 选通道（无 ⇒ 'avatar'，有 ⇒ 'qq_private'）并照常启动。
S0-b-3  出站 sink 可见性判据：确认提醒路径看得到 main.ts:7598 绑的 sink
        （并在同一条门里加 R-a 负控：同进程重复启动 ⇒ 不产生第二个 timer）
```

## 风险与必须写的判据

```text
R-a  **不能让两个入口同时装 timer**（否则重复投递）。判据：已有实例/多入口时**拒绝或复用**，
     并有一条负控（同进程重复调用 ⇒ 不产生第二条定时器）。
R-b  `stop()` 的顺序：**先停 shell/timer，再关库**（现有先例：ADR-110 §25 停机顺序）。
R-c  `enabled` 的语义要跟着改：它现在要求 `reminderRefreshHook !== undefined`（对）；
     但**不许**再把"哪个入口"当隐性条件（R6 的本体）。
R-d  交付读数：旧桥入口下 `enabled=true` 且能真的排上一条 5 分钟后的提醒（或 dryRun 读数），
     加上"页面没开/QQ 未连"下的 `refused` 具名码不得再是 `reminder_delivery_unavailable`
     （那时应走 S2 的**改投 + 说明**分支）。
```

## 与其它切片的关系

```text
S0（本片）是 S2/S3/S4 的前提：旧桥入口下没有出口，就永远走不到"改投 + 说明"。
S1（A2 记忆守卫假阳性）与 S0 相互独立，可并行（但都在同一次停机窗口跑 CI）。
⚠️ 每片：typecheck + 相关门（**含负控**）+ **停机窗口** `m4.5:ci`。
```

## 本片**尚未实现**（如实）

```text
本轮只做到"侦察 + 方案"。没有改任何 `src/**`：把"改 + 负控 + 门 + 停机 CI"整套做完需要下一次
可支配余量，而半途改 main.ts 的风险（今天已犯过一次提交夹带）不值得冒。
下一步：S0-b-1 → S0-b-2 → S0-b-3，逐条加判据（R-a/R-b/R-c），再跑门 + CI。
```
