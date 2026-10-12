# QQ 主动联系 WP2 —— 持久通知与时间（记录，2026-10-06）

> 载体：计划 [`QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md) §5 / §8 的 **WP2** ·
> 设计 [`ADR-110`](../adr/ADR-110-qq-proactive-messaging.md)（`D02`/`D07`/`D08`）·
> WP0 [`Baseline`](QQ-Proactive-Messaging-WP0-Baseline.md) · WP1 [`Croner-Probe`](QQ-Proactive-Messaging-WP1-Croner-Probe.md)。
>
> WP2 的通过条件逐字（计划 §8）：**"单次实例唯一；旧处理器仍维持原 trigger 闸；
> 跨日、时钟回退、休眠与重启不重置额度或刷屏；新迁移正负控。"**

---

## 0. 一句话

```text
迁移 **0014** 落地（通知意图 + 通知实例两张表，含三条结构性 CHECK）；
发送幂等靠**唯一占用**（主键），不靠内存 Map；
`schedule` 触发改成**按 processor 名作用域**的具名许可（旧闸一字未放宽、默认仍拒绝）；
**并修掉一个既有洞**：`enqueueJob` 的"撞键即绕过触发闸"。
离线门 `pnpm postlv2:qq-proactive:verify` = **39 通过 / 0 失败**（measured_count = 39），EXIT 0。
```

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/contracts/notification.ts`（**新**） | 纯层契约：状态闭集与迁移表 · 稳定 `occurrenceKey` · `L-QQP-01` 的可排期判据 · 指定时区的日键 / 活动时段 · 额度与时效判据 · 候选正文的校验与指纹 |
| `src/kernel/contracts/ids.ts`（追加） | `NotificationIntentId` + `newNotificationIntentId()` + `asNotificationIntentId()` |
| `src/kernel/contracts/index.ts`（追加） | 导出 `./notification.ts` |
| `src/kernel/contracts/job.ts`（追加） | `NAMED_TRIGGER_PERMITS`（**有界具名**：两个处理器 × 只允许 `schedule`）· `isTriggerPermittedForProcessor()` · `assertTriggerEnabledInM3_5(kind, processor?)`（第二参**可选**） |
| `src/infrastructure/persistence/migrations.ts`（追加） | `MIGRATION_0014`（两张表 + 3 个 CHECK + 4 个索引） |
| `src/infrastructure/persistence/notification-store.ts`（**新**） | 两张表的唯一读写口：登记 / 去重 / 改时 / 取消 / **唯一占用** / 状态推进 / 重启隔离 / 额度统计 |
| `src/infrastructure/persistence/job-store.ts`（改） | **触发闸前移**到幂等提前返回之前 |
| `scripts/postlv2-qq-proactive-verify.ts`（**新**）+ `postlv2:qq-proactive:verify` | 离线门（38 项判据 / 9 段结构） |

---

## 2. 迁移 0014（正负控）

```text
notification_intents      本人要求过的一件事（提醒）或一次许可登记（关心）+ 排期
notification_occurrences  某一次**具体**的外发尝试（含交付真相与平台回执）
```

**三条结构性 CHECK**（写成 CHECK 而不是"写入方记得别写错"）：

| 约束 | 含义 | 为什么是硬要求 |
|---|---|---|
| `notification_intents_reminder_has_text` / `_has_source` | 提醒**必有**正文与来源；关心**两者皆无** | "凭空设一条提醒"与"替关心的候选保存正文"都被结构挡住 |
| `notification_occurrences_accepted_iff_message_id` | `api_accepted ⇔ platform_message_id is not null` | "接口接受"的**唯一**凭据就是那个回执 id；反过来也不许带着回执说没被接受 |
| `…_candidate_length_bounds`（1–500）+ `…_candidate_pairing` + `…_candidate_length_pairing` | 候选正文 / 指纹 / 长度**三者成对**且有界 | 正文要发到真人手机上；"有长度没正文"这类半截状态不许落库 |
| `…_reminder_has_intent` | 提醒的实例必须挂在意图上 | 没有意图就没有"凭什么发" |

**唯一占用**：`notification_occurrences.occurrence_key` 是**主键**（不是"折叠 + 查询"，也**不**照抄
`character_action_events_idempotency` 那种非唯一索引）。意图侧另有**部分唯一索引**
`notification_intents_active_dedupe`（只覆盖 `pending`，形状与 `character_jobs_idempotency_active` 相同）：
"同一件事不许排两次"，但终态不挡住"本人后来又要了一次"。

---

## 3. 离线门读数（三段式）

| 段 | 内容 | 读数 |
|---|---|---|
| ① 迁移与结构 | 版本连续到 14（`latest === MIGRATIONS.length === 已应用`）· 两张表在案 · **4 条 CHECK 负控**（含 3 条**差分正控**） | 全绿 |
| ② 通知意图 | 登记（正文 + 指纹 + 来源）· **同 dedupeKey 去重**（`created=false` 且读回原行）· 负控：无来源的提醒被拒 · 负控：关心带正文被拒 · 改时 ⇒ **计划版本 +1** | 全绿 |
| ③ 发送幂等 | 占用键**稳定可复算**（同输入同键；换计划版本换键）· **同键第二次占用 `created=false`**（不新建、不报错）· 关心的键锚在 (owner, 许可版本, 机会键) | 全绿 |
| ④ 交付真相 | 正控：五态走到 `api_accepted`（带回执）· 负控：**终态不可迁移** · 负控：**没有回执不许记成接受** · 负控：**`delivery_unknown` 不许变接受、不许回 `dispatching`** · 负控：`failed_confirmed` 不许变接受 · 正控：**重启遗留 `dispatching` ⇒ `delivery_unknown` 且仍占额** | 全绿 |
| ⑤ 取消 | 正控：未发送实例 → `cancelled`，而**已接受 / 结果不明**的两条**不动** · 负控：`cancelled` 是终态 · 负控：**已取消的意图不许改时复活** | 全绿 |
| ⑥ 额度 | 正控：只有 `dispatching`/`api_accepted`/`delivery_unknown`/`failed_confirmed` 占额（**结果不明也占额**）· 负控：换一天 ⇒ 0 · 日键按指定时区（上海 23:59 与次日 00:01 分属两天） | 全绿 |
| ⑦ 时间判据 | `L-QQP-01`：**提前 1500ms 可排期 / 同秒不可排期** · 活动时段 09:00–22:00（22:00 **不含**）· 迟到三态 `due`/`grace`/`expired` | 全绿 |
| ⑧ 具名触发许可 | 许可表**有界具名**（2 个处理器，只允许 `schedule`）· 单参仍拒 · 未具名处理器仍拒 · 具名通过 · 具名但 kind 不在允许集 ⇒ 拒 · 具名的 `schedule` 作业**真的落库**且读回 `trigger_kind='schedule'` · **★ 撞键不再绕过触发闸** | 全绿 |
| ⑨ 恢复 | 负控之后正控**重新成立**（登记 → 占用 → 走到 `api_accepted`；具名许可仍成立） | 全绿 |

```text
pnpm postlv2:qq-proactive:verify ⇒ 39 通过 / 0 失败（measured_count = 39）· EXIT 0
隔离库：%TEMP%/project-lg-exp-qq-proactive-wp2-verify-<ts>-1（`isolateDatabase`；**从未**打开真实库）
```

---

## 4. ★ 修掉的那个既有洞（`enqueueJob` 撞键绕过触发闸）

**事故形状**（WP0 复核时逐行确认，非本轮引入）：

```text
旧顺序：先 findJobByIdempotencyKey → 命中非 failed 就 return → **然后才** assertTriggerEnabledInM3_5
⇒ 同一个幂等键只要已有一行非 failed 的作业，
  后面无论传什么 triggerKind 都直接返回那一行 ⇒ **闸根本没跑**。
```

**为什么必须在本 WP 修**：既有 9 处生产调用点全是 `conversation`，所以洞今天不构成越权；
但**具名许可会把它放大** —— 一个 `schedule` 请求只要撞上键就能悄悄通过。
（`ADR-110` `D02` 已把这条写成"必须同时修"，本轮照做。）

**修法**：判据是**声明出来的那个 kind**（与最终落库逐字相同），且**两条路径都跑同一处断言**。

**机器证据**（门里的 ★ 那一条）：先入队一条 `processor='qq-proactive-reminder'` + `schedule` 的作业
（成功、`trigger_kind='schedule'` 读回一致），再用**同一个幂等键** + `processor='m35-verify'` + `schedule`
请求一次 —— 必须被**具名拒绝**。修复前那一次会静默返回旧行（读数会是"竟然绕过去了"）。

---

## 5. 冻结语义的**逐字**保留（本 WP 没放宽任何旧闸）

| 冻结面 | 本 WP 的动作 | 机器证据 |
|---|---|---|
| `M3_5_ENABLED_TRIGGER_KINDS = ['conversation','system']` | **一字未改** | `m3.5:test` 的 `deepEqual` 断言仍绿 |
| `M3_5_RESERVED_TRIGGER_KINDS` 三种 kind 逐个抛 `trigger_kind_not_enabled` | **一字未改**（默认仍拒绝） | `m3.5:test` 全绿 |
| `assertTriggerEnabledInM3_5(kind)` **单参**调用 | 第二参是**可选**的 ⇒ 旧调用点逐字节不变 | `m3.5:test` / `future-compat-tests.ts` 的单参调用仍绿 |
| `processor='m35-verify'` + `schedule` 必须被拒 | **仍然被拒** | `m3.5:verify` 31/0 · 门里另有独立负控 |
| 既有迁移 0001–0013 的 DDL | **一个字节都没动**（只追加 0014） | 迁移指纹门（`m5.1.1:migration:verify`）与 `m3:migrate-gate` |
| `character_action_events_idempotency`（非唯一索引） | **没有**照抄它；新表用主键/唯一键兜底 | 门里 §3 的唯一占用正负控 |

---

## 6. 量具自身的三个缺陷（差分正控抓出来的，如实登记）

第一版的 CHECK 负控**看起来全过**，但我把"断言"写成了"错误信息里要含约束名"，
而实际错误信息只有 `Failed query: insert into …` ⇒ 4 条判据全红（**其中 3 条其实是拒绝成功的**）。
改成**差分正控**（"同一条插入带上合法值就必须成功"）之后，又连续抓出**两处夹具缺陷**：

```text
① 只给 candidate_length 不给 candidate_text  ⇒ 被 `…_candidate_length_pairing` 挡住，
   量到的**不是**上下界那条 CHECK（负控过了，但正控也过不去 ⇒ 立刻暴露）
② 给了 candidate_text 却忘了 candidate_fingerprint ⇒ 被 `…_candidate_pairing` 挡住，同样不是目标约束
```

⇒ 教训（已写进门里的注释）：**"负控被拒"本身不是证据**；
必须同时给出**差分正控**，否则"被别的约束挡住"与"被测约束生效"在读数上完全一样。
这与仓库既有的"正控 / 负控 / 恢复三段式 + measured_count > 0"是同一条纪律的落地。

---

## 7. WP2 **不**主张什么

```text
① 不主张"主动联系已经能用"：本轮只有**持久层与触发许可**；
   机会检查、角色选择、投递与真实外发在 WP3–WP5。
② 不主张"额度已经接上真实时钟"：门用**固定瞬间**做正负控（不依赖"今天是几号"）；
   "每 30 分钟检查一次""冷却 3 小时"这些**策略**在 WP3 装配，本轮的判据只提供纯函数。
③ 不主张"跨进程安全"：唯一占用靠**单库**（`INV-DB-01` 的单持有）——
   多进程共库**不**在本设计的前提里。
④ 不主张"时钟回退已完全处理"：占用键里**没有**"当前时间"（只有程序事实）⇒ 同一次机会换不回新键；
   但日键是**按时刻算**的，若系统时钟真的被回拨跨过午夜，"当天额度"会按新的日键重新计 —— 如实登记为边界。
⑤ 不主张"`onceShotIsSchedulable` 已在生产被调用"：WP2 只**提供**判据；调用出现在 WP3/WP5。
⑥ 不主张"休眠后能补发"：本设计逐字**不**批量补发（计划 §6）；休眠期间错过的机会按 `expired` 处理。
⑦ 不主张"正文不进任何地方"：正文**在**那两张表里（它必须能发出去）；
   不进的是 `ActionRequest.arguments`、行动账本与 trace（WP5 落地时验证）。
⑧ 不主张"旧门已被全部复核"：本轮跑了与改动模块相关的 8 道门（见 §8）；
   `m4.5:ci` 全量串行门留到 WP6（计划 §9.1 要求交付前跑）。
```

---

## 8. 本 WP 跑过的门（**实测读数**）

| 门 | 读数 | 为什么必须跑 |
|---|---|---|
| `pnpm typecheck` | **EXIT 0**（多轮，含新脚本） | 任意 `.ts` |
| `pnpm postlv2:qq-proactive:verify`（**新**） | **39 通过 / 0 失败**（`measured_count=39`）· EXIT 0 | 本 WP 的专属门 |
| `pnpm kernel:test` | **27 通过 / 0 失败** | `src/kernel/contracts/**` 改动 |
| `pnpm kernel:verify` | **25 通过 / 0 失败** | 同上 |
| `pnpm m3.5:test`（触发锁） | **30 通过 / 0 失败** | `job.ts`（触发枚举/闸） |
| `pnpm m3.5:verify`（`m35-verify` + `schedule` 必须被拒） | **31 通过 / 0 失败** | `job-store.ts`（触发闸位置） |
| `pnpm m3:verify` | **67 通过 / 0 失败** | `migrations.ts` |
| `pnpm m3:migrate-gate` | **17 通过 / 0 失败** | `migrations.ts` |
| `pnpm m4:verify` | **147 通过 / 0 失败**（日志逐字：**"真实库未被触碰"**） | `migrations.ts` + `job-store.ts` |
| `pnpm m4.5:test` | **146 通过 / 0 失败** | 迁移版本断言 |

⚠️ 未跑（**如实登记**）：`pnpm m4.5:ci`（全量串行离线门，约 12.4 分钟）留到 **WP6**
—— 计划 §9.1 要求"代码交付前完整串行执行 `m4.5:ci` 并取得 EXIT 0"，那是在**实现完成之后**。
⚠️ `m4.5:test` 会重写 `artifacts/m4.5/component.json` 等历史证据 —— 按 AGENTS.md §3/§7
**不**顺手提交这些被重新生成的历史读数（本轮也没有提交任何东西）。
