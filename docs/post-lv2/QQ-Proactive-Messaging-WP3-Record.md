# QQ 主动联系 WP3 —— 通知入口与用户控制（记录，2026-10-06）

> 载体：计划 [`QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md) §4.1 / §6 / §8 的 **WP3** ·
> 设计 [`ADR-110`](../adr/ADR-110-qq-proactive-messaging.md)（`D03`/`D07`/`D13`/`D14`）·
> WP0 [`Baseline`](QQ-Proactive-Messaging-WP0-Baseline.md) · WP1 [`Croner-Probe`](QQ-Proactive-Messaging-WP1-Croner-Probe.md) ·
> WP2 [`Record`](QQ-Proactive-Messaging-WP2-Record.md)。
>
> WP3 的通过条件逐字（计划 §8）：**"两类触发均有真实来源；创建后真持久，未创建不说已设；
> 同实例取消有效；重启不漏恢复。"**

---

## 0. 一句话

```text
提醒入口：从本人原话里**确定地**读出一个时刻 —— 读不出就澄清、已过去就如实拒绝、**绝不猜**；
          夜间普通提醒**顺延**、本人明确指定的夜间时刻**仅该条**例外。
用户控制：暂停/恢复**落库**（迁移 **0015**），三件套同真同假；重启之后状态仍在。
机会预检：**十种**不合格**逐个具名**（不是一句"不该发"）。
门：`pnpm postlv2:qq-proactive:verify` = **63 通过 / 0 失败**（measured_count = 63），EXIT 0。
```

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/contracts/notification-intake.ts`（**新**） | 提醒入口判据（`readReminderRequest`）· 去重键 · 自主关心的机会预检（`precheckCareOpportunity`，十种具名拒绝）· 到点判定（`decideReminderDue`）· 指定时区的墙上时刻 ↔ 瞬间换算 |
| `src/infrastructure/persistence/migrations.ts`（追加） | `MIGRATION_0015`：`notification_control`（暂停/恢复的**持久**状态 + 三条 CHECK） |
| `src/infrastructure/persistence/notification-store.ts`（追加） | `readControl` / `pauseNotifications` / `resumeNotifications`（幂等、具名拒绝） |
| `src/kernel/contracts/index.ts`（追加） | 导出 `./notification-intake.ts` |
| `scripts/postlv2-qq-proactive-verify.ts`（扩） | 新增 §10–§14（提醒入口 / 控制面 / 机会预检 / 到点判定 / 重启读回） |

---

## 2. 提醒入口：**读得出才排期**（`D03` + 计划 §4.1）

| 输入 | 结局 | 读数 |
|---|---|---|
| "十分钟后提醒我喝水" | `scheduled` | `+10min`，`basis=relative:十分钟后` |
| "半个小时后提醒我" | `scheduled` | `+30min` |
| "今晚九点半提醒我吃药" | `scheduled` | 当日 **21:30（上海）** |
| "明天早上八点提醒我交报告" | `scheduled` | 次日 **08:00（上海）** |
| "今天天气不错" | **`none`** | 没有提醒意图 ⇒ 不排期 |
| "以后提醒我多喝水" / "有空提醒我一下" | **`clarify`** | `reminder_time_unspecified`（**绝不**偷偷排期） |
| "提醒我一下" | **`clarify`** | `reminder_time_unreadable`（问一句，不猜时间） |
| "今天早上八点提醒我开会"（现在 20:00） | **`refused`** | `reminder_due_at_not_future`（如实说过去了，**不**顺手挪到明天） |

**夜间规则**（计划 §6 逐字）：
```text
"八小时后提醒我"（20:00 ⇒ 次日 04:00）⇒ **顺延**到 09:00，explicitNight=false，basis 以 >shifted_to_window 结尾
"今晚十一点半提醒我看球"            ⇒ **该条例外**留在 23:30，explicitNight=true，basis 以 >explicit_night_exception 结尾
```
⚠️ **"明确指定"的判据是"本人说出了那个钟点"**，不是"模型觉得可以"：相对时刻**不**享有例外。

⚠️ **不碰目标域的 `dueAt`**：那是 M10 的**结构性判据**（G36「目标域生产侧没有任何一处写 `dueAt`」）。
提醒用**独立**结构（`ADR-110` `D03`）。

---

## 3. 控制面：**暂停必须活过重启**（`D13`）

```text
notification_control（每角色一行）
  paused ⇔ paused_at is not null ⇔ pause_reason is not null   ← 表级三条 CHECK
```

| 判据 | 正控 | 负控 |
|---|---|---|
| 暂停 | 三件套**同时**有值 | 空理由 ⇒ `notification_pause_without_reason` |
| 幂等 | 重复暂停**保留原 `paused_at`**（不把"停了多久"重置成 0），理由更新 | — |
| 表级一致性 | 三件齐全 ⇒ 通过 | **暂停却没时刻 / 没暂停却有时刻 / 有时刻却空理由 ⇒ 全拒** |
| 恢复 | 三件套**一起**清掉 | 没暂停时"恢复" ⇒ `not_paused` |
| **重启** | 关掉运行时 → **裸 PGlite 从同一目录重开** → 读回 `paused / perm@3` 逐字一致 | — |

⚠️ 为什么"暂停"必须落库：它若只活在内存里，一次重启就会把"她正在暂停"变成"她又在发了" ——
那不是配置问题，而是**违逆本人明确意图**。计划 §8 的"重启不漏恢复"就是这个。

---

## 4. 机会预检：**每条不合格都具名**（十种）

```text
正控   mode=on · 未暂停 · 入口作用域 · 空闲 3h · 无冷却 · 额度未用 ⇒ 够格（dryRun=false）
正控   mode=shadow ⇒ 够格但 dryRun=true（完整产生选择与审计，**不**真的发）
负控 ×10，**逐个具名**：
  mode_off · paused · entry_scope_required · candidate_in_flight · outside_active_window ·
  not_idle_enough · cooldown · previous_care_unanswered · care_quota_reached · daily_quota_reached
负控   不在活动时段时**给出 deferredUntil**（"顺延到什么时候"是可回答的，不是一句"不行"）
```

⚠️ **顺序就是判据的一部分**：先问"该不该跑"（模式/暂停/前置），再问"是不是时候"
（在途/时段/空闲/冷却/回应/额度）。

---

## 5. 到点判定（计划 §6 的迟到处理）

```text
未到点          ⇒ `reminder_not_due_yet`（**不**提前发）
逾期 ≤ 30 分钟  ⇒ deliver（连接恢复后重新预检，时效允许才处理）
逾期 > 30 分钟  ⇒ `reminder_expired`（**不伪报已提醒**）
```

---

## 6. 量具自身的三个缺陷（本轮同样被差分正控/正控抓出）

```text
① `latestSchemaVersion()` 写死 14 —— 加了 0015 之后自己变红。
   ⇒ 改成**动态式**（`latest === MIGRATIONS.length` 且逐个 version === index+1）。
   这正是 WP0 记下的教训（三处历史脚本写死 `=== 9` 的同一个坑）。
② 夜间规则的断言写错了方向：把"顺延档"也要求成 `explicitNight === true`。
   ⇒ 实测读数（`explicitNight=false` + `>shifted_to_window`）反过来纠正了断言 ——
   "我预期的语义"与"代码的语义"不一致时，**先看读数再改断言**，不是改代码迁就断言。
③ 重启读回时断言"表里只有一行"，但 §11 的夹具在同一张表里留了 `wp3-check-*` 行。
   ⇒ 改成**按角色过滤**（`where character_id`），而不是假设表里没有别的行。
```

---

## 7. WP3 **不**主张什么

```text
① 不主张"主动联系已经能用"：本轮交付的是**入口判据 + 控制面 + 机会预检**（纯层 + 持久层）。
   真正的装配（把入口接进正式轮次、把调度器接进核心、把候选交给角色模型）在 WP3 的**接线部分**与 WP4/WP5。
② 不主张"提醒解析覆盖自然语言"：它是**有界闭集**（相对时刻 + 钟点 + 今天/明天 + 时段词）。
   闭集之外的表达**一律澄清**——这是刻意的（读不出就问，而不是猜）。
③ 不主张"重启"已被完整验证：读回证据是"关掉运行时 → 裸 PGlite 从同一目录重开"，
   那是**同一进程**里最接近重启的形态；跨进程冷启动与**停机链**下的恢复在 WP6 的压力段再量。
④ 不主张"额度已经接上时钟"：本轮只提供**判据**；日界由调用方按指定时区算好后传入。
⑤ 不主张"暂停会自动取消在途候选"：`cancelIntent` 只作废**未发送**的实例；
   已经 `dispatching` 的按 `D08` 隔离为 `delivery_unknown`，**不重发**。
⑥ 不主张"两路真实入站"已经接好：`lastInboundAt` 是调用方给的读数；
   真正的读点（QQ 与皮套两条会话的活动版本）在接线部分。
⑦ 不主张"`shadow` 档在任何路径都不外发"：判据给出 `dryRun=true`；
   真正的"不调用发送器"由 WP5 的装配保证（`supportsDryRun` + 条件构造适配器）。
```

---

## 8. 本 WP 跑过的门（**实测读数**）

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | **EXIT 0**（多轮） |
| `pnpm postlv2:qq-proactive:verify` | **63 通过 / 0 失败**（`measured_count=63`）· EXIT 0 |
| `pnpm kernel:test` | **27 通过 / 0 失败** |
| `pnpm kernel:verify` | **25 通过 / 0 失败** |
| `pnpm m3.5:test` | **30 通过 / 0 失败** |
| `pnpm m3.5:verify` | **31 通过 / 0 失败**（`m35-verify` + `schedule` 仍被拒） |
| `pnpm m3:verify` | **67 通过 / 0 失败** |
| `pnpm m3:migrate-gate` | **17 通过 / 0 失败** |
| `pnpm m4:verify` | **147 通过 / 0 失败**（日志逐字："真实库未被触碰"） |
| `pnpm m4.5:test` | **146 通过 / 0 失败** |

⚠️ 未跑：`pnpm m4.5:ci`（全量串行离线门）留到 **WP6** —— 计划 §9.1 要求"代码交付前"跑它。
⚠️ 本 WP **仍未接线**：`src/main.ts` 未被改动 ⇒ 上面全部门跑的都是**库与纯函数**层面的判据；
真正的"接入"（入口读点、调度器、装配）还在后面。这一点是本节要如实写清的边界。
