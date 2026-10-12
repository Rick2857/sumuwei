# QQ 主动联系 WP4 —— 角色选择（判据层记录，2026-10-06）

> 载体：计划 [`QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md) §4.1/§4.2 / §8 的 **WP4** ·
> 设计 [`ADR-110`](../adr/ADR-110-qq-proactive-messaging.md)（`D03`/`D04`/`D04a`/`D11`）·
> WP0 [`Baseline`](QQ-Proactive-Messaging-WP0-Baseline.md) · WP1 [`Croner-Probe`](QQ-Proactive-Messaging-WP1-Croner-Probe.md) ·
> WP2 [`Record`](QQ-Proactive-Messaging-WP2-Record.md) · WP3 [`Record`](QQ-Proactive-Messaging-WP3-Record.md)。
>
> WP4 的通过条件逐字（计划 §8）：**"关心正控能选 send、沉默负控能选 silence；
> 到期提醒不能因角色 silence 被标完成；零假用户事件、零自动记忆；失效/迟到候选无提交"**。

---

## 0. 一句话

```text
闭集提案 `silence / defer / send` 的**唯一**解析处落地：**多一个字段整条作废**；
两类触发的**权限差**成了机器判据：提醒的 silence ⇒ `deliver_template`（**不**记成完成、**不**记成跳过），
关心的 silence ⇒ `stay_silent`（**合法结局**）；来源复核给三种具名拒绝；
简报由程序生成且**明说"这不是对方发来的消息"**（防伪装入站）。
门：`pnpm postlv2:qq-proactive:verify` = **73 通过 / 0 失败**（measured_count = 73），EXIT 0。
```

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/contracts/proactive-proposal.ts`（**新**） | 决策闭集 · **严格解析**（16 种具名失败）· 来源复核（生成前/发送前）· **权限差**与程序动作翻译 · 程序生成的简报渲染 · **从契约派生**的指令 · 提醒模板 |
| `src/kernel/contracts/index.ts`（追加） | 导出 `./proactive-proposal.ts` |
| `scripts/postlv2-qq-proactive-verify.ts`（扩） | 新增 §15（8 项判据，含 16 条解析负控与 4 条来源复核负控） |

---

## 2. ⚠️ 先写清**本 WP 的边界**（避免把判据层当成交付完成）

```text
本 WP 交付的是**角色选择的判据层**：
  · 闭集与严格解析（模型的输出在这里被收窄）
  · 两种触发的权限差（"提醒不能被 silence 取消"成了机器判据）
  · 来源复核（失败关闭）
  · 简报与指令的**程序生成**（防伪装入站、防提示词漂移）
  · 失败兜底（提醒模板 / 关心放弃）

本 WP **没有**交付（属后续接线）：
  · 真实的**私有模型调用**（`openai-*` 适配器 + 超时 + 失败分桶的落地）
  · 网关里那条**不落用户事件的编译入口**（`D04a` ①，带 `system_opportunity` section）
  · `system_opportunity` 的 `ContextSectionKind` 成员、provider 与"不传 ⇒ 0 section"
  · 把候选交给投递的那一段（WP5）
```

⚠️ 因此本节**不主张**"她已经能自己决定要不要联系" —— 它只主张"那个决定**以什么形状被接受或被拒**"
已经被钉成机器判据。

---

## 3. 判据与读数

| # | 判据 | 读数 |
|---|---|---|
| 1 | 三种选择各一条合法提案 | `silence` / `defer(60)` / `send("上次那个报告写完啦？")` 全通过 |
| 2 | **16 种非法提案逐个具名拒绝** | `proactive_empty` · `_no_json_object` · `_not_object` · **`_unknown_field`（多一个字段整条作废）** · `_bad_decision` · `_missing_reason_code` · `_bad_reason_code` · `_missing_source_refs` · `_source_refs_not_array` · `_send_without_text` · `_send_text_too_long` · `_non_send_with_text` · `_defer_without_minutes` · `_defer_minutes_out_of_range`（5 / 600 两次） · `_non_defer_with_minutes` |
| 3 | 权限差（解析档） | 提醒档 `allowDefer=false` ⇒ 拒；关心档允许 ⇒ 通过 |
| 4 | 来源复核 | `proactive_without_source` / `proactive_source_set_unavailable`（**空可用集也拒** ⇒ 失败关闭）/ `proactive_source_stale`（列出失效的 ref）/ ok |
| 5 | ★ **权限差（动作档）** | 提醒 `silence` ⇒ `deliver_template(reminder_silenced_use_template)`；关心 `silence` ⇒ `stay_silent(care_legal_silence)` |
| 6 | 模型失败兜底 | 提醒 ⇒ `deliver_template(reminder_model_<failure>)`；关心 ⇒ `stay_silent(care_model_<failure>)` |
| 7 | `defer` 翻成程序给的时刻 | `now + 60min`（**不**接受模型自选时刻） |
| 8 | 简报程序生成且有界 | 依据最多 **8** 条 / 每条摘要 ≤ **120** 码点 / 逐字含"这不是对方发来的一条消息" |
| 9 | 指令**从契约派生** | 三个 `decision`、正文上限、`defer` 范围都在指令里（提示词与代码不会漂移） |
| 10 | 提醒模板 | `提醒你一下：<已校验内容>`；空内容 ⇒ 具名拒绝 |

---

## 4. 两条与本仓库既有判据的**对齐说明**

```text
① "严格 JSON + 闭集 + 失败分桶"是**照形**照过来的（`openai-tool-decision.ts` / `tool-decision.ts`）：
   · 一次调用就是一次调用（无重试、无回落）
   · 失败三分法：timeout / call_failed / invalid_output
   · 未知字段 ⇒ 整条作废（不是"忽略它"）
   ⚠️ 但**输入面不同形**：role-tool-decision 的输入面在类型上排除人设/记忆/检索，
      而本功能要求"同一角色上下文"（`D04a` ①）⇒ 上下文由网关的编译入口给，不由本模块给。

② "来源必须非空且在程序给的可选集里"与 `character-output.ts` 的 `sourceRefs` 同一条纪律，
   但**不复用那个闭集**：那个闭集逐字排除主动闲聊与日程提醒（`D11`）。
   ⇒ 本模块的 `sourceRefs` 是**通知候选**的来源，与有限插话的来源是两件事。
```

---

## 5. 量具自身的缺陷（本轮第 4 次被自己的断言抓到）

```text
① `ProactiveProgramAction` 的 union 让 `.code` 在 `defer` 支上不存在 ⇒ 两次类型错。
   改成 `actionCode()` 助手（`code ?? action`）—— 这暴露了"我在断言里假设了三种支都有 code"。
② 简报边界的断言把 ` :: ` 之后的**前导空格**也数进了码点 ⇒ 量到 121 而不是 120。
   改成 `.trim()` 再数。教训与 WP2/WP3 相同：**边界断言最容易量错自己**。
```

---

## 6. WP4 **不**主张什么

```text
① 不主张"她已经在做这个选择"：真实调用与网关编译入口**尚未接线**（§2 已逐条列出）。
② 不主张"提示词质量已被验证"：本轮只断言"指令与契约同步"与"简报有界"；
   模型是否**用得好**属语义评估（WP6 的真模型段）。
③ 不主张"来源集合是完整的"：本模块只做**集合成员核对**；
   "哪些来源够格进这个集合"由 WP4 的装配决定（记忆资格 / 遗忘遮蔽 / 目标结清）。
④ 不主张"defer 一定被兑现"：它只翻成一个程序时刻；
   到点之后仍然要过 WP3 的时效与 WP2 的唯一占用（可能被 `expired` 或被占用键挡下）。
⑤ 不主张"模板一定发得出去"：模板也要过行情守卫与投递（WP5）；
   本模块只保证"模板本身不携带原请求里的任何工具指令"。
⑥ 不主张"零假用户事件"已被端到端证明：本轮只证明**这条路径的类型里没有 `userText`
   与 `recordUserMessage` 的入口**；端到端证据在 WP6 的整链矩阵。
```

---

## 7. 本 WP 跑过的门（**实测读数**）

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | **EXIT 0** |
| `pnpm postlv2:qq-proactive:verify` | **73 通过 / 0 失败**（`measured_count=73`）· EXIT 0 |
| `pnpm kernel:test` | **27 通过 / 0 失败**（`src/kernel/contracts/**` 新增一个模块） |
| `pnpm kernel:verify` | **25 通过 / 0 失败** |
| `pnpm m3.5:test` | **30 通过 / 0 失败**（确认没有碰到 prompt 逐字节基线 —— 本模块不产 prompt 片段） |

⚠️ 未跑：`pnpm m4.5:ci`（留到 WP6）；`pnpm m3.5:baseline` 的动作 ——
本 WP **不**需要它：`system_opportunity` section 与编译入口尚未接线（§2），
所以 prompt 逐字节基线**没有理由**变动。接线时必须重新检查这一条（`D04a` ③）。
