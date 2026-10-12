# ADR-131：皮套入口的系统发起开口（proactive opening）

```text
状态      : **ACCEPTED / DESIGN FROZEN**（2026-10-11 用户裁定「批准 D01–D19」）
            —— 设计已冻结；**实现尚未开始**（下一步按 §8 的 WP0 → WP7 顺序）
            —— 本文件不含任何"已实现"主张
日期      : 2026-10-11
上游      : ADR-109（双入口共存）· ADR-110（QQ 主动联系，`D11` 被本 ADR 部分修订）
            ADR-111（关心的依据面 S01–S07）· ADR-113（活动时段只约束 care）
            ADR-124（受信入口事实与 QQ／皮套／控制台提醒出口）
本 ADR 回答: **皮套入口能不能有"她主动开口"这一类输出，以及它在不变量上怎么成立**
裁定记录  : 用户 2026-10-11 四问：D1=(c) · D2=先 (a) 起步 · D3/D4=加第四类 + 模型生成 + 有界依据集
```

> **编辑约定**：`D01`…`D14` 是**待批准的裁定**，批准后不得在实现阶段顺手改动；
> 要改必须新开一次 ADR 修订并引用本文件。本文件**只写设计**，不含任何已实现主张。

---

## 0. Context

### 0.1 触发实例（可复核）

`C:\Users\user\Desktop\报错1.txt`（2026-10-11 11:22:42 → 12:00:41）里：

```text
33 × WARNING Proactive speak prompt not configured, using default
33 × ERROR   Error processing agent response stream:
             LG avatar entry only accepts explicit user text, final ASR or images
33 × Traceback → scripts/postlv2_vtuber_runtime.py:1120
```

链路逐字（上游 → 本仓库）：

```text
前端定时器到点（proactive-speak-context.tsx，localStorage `proactiveSpeakSettings`）
  → ai-speak-signal
  → conversation_handler.py:43  logger.warning("Proactive speak prompt not configured, using default")
  → :44  user_input = "Please say something."
  → :51  metadata = {"proactive_speak": True, "skip_memory": True, "skip_history": True}
  → single_conversation.py:89   User input: Please say something.
  → LGBridgeAgent.chat  scripts/postlv2_vtuber_runtime.py:1119-1120
       if input_data.files or (input_data.metadata or {}).get("proactive_speak"):
           raise ValueError("LG avatar entry only accepts explicit user text, final ASR or images")
```

**现状是"守卫正确 + 触发源是外壳 + 结果变成热循环"**：最早的 12 次挤在 200 毫秒内，
最后一次是 `12:00:41.108`（**日志结束时仍在刷**）。

### 0.2 为什么不能靠"放宽守卫"解决

三条，各有代码证据：

| # | 事实 | 证据 |
|---|---|---|
| ① | `skip_memory` / `skip_history` 是**外壳自己的** metadata，桥**不转发** | `postlv2_vtuber_runtime.py:1133` 的 `submit_packet` 只有 `kind` / `requestId` / `userText`（+ 可选 `images` / `utteranceKey`） |
| ② | 唯一入口是 `SUBMIT_TURN` ⇒ 必然落成 `user_message` | 桥协议里只有 `SUBMIT_TURN` / `PREPARE_TURN` / `CANCEL_TURN` / `REPORT_*`；无"系统发起"入口。**不变量 21（FC-01）逐字禁止**非对话输入伪装成用户消息 |
| ③ | 那条假 `user_message` **真的会被记忆化** | `src/infrastructure/runtime/automatic-memory.ts:103`：源选择即 `event.type === 'user_message' && actorId === speaker.id`；且 `.env` 当前 `memory-automatic(langmem)` 为 ON |

⇒ **要做的不是放宽守卫，是给她一条正规的系统发起入口。**

### 0.3 地基（大半零件已在，本 ADR 不重造）

| 零件 | 位置 | 状态 |
|---|---|---|
| 通道是一等概念 | `src/kernel/contracts/chat-channel.ts`：`'cli' \| 'qq_private' \| 'avatar'` | 已有 |
| 投递口闭集 | 迁移 `0017`：`delivery_channel in ('qq_private','avatar','cli')` | 已有（**avatar 已允许**） |
| 按通道分发 + 代次 | `src/infrastructure/runtime/reminder-scheduling.ts:51,145` | 已有 |
| 系统发起的**依据面** | ADR-111（有界来源集 ≤8 条 / 摘要 ≤120 码点 / 顺序 = 视图顺序） | 已有 |
| **提议闭集** | `proactive-proposal.ts`：`silence / defer / send`（多一个字段整条作废） | 已有 |
| SYSTEM 发起归因先例 | `SYSTEM/qq-proactive-scheduler` + 写归因豁免（两道可见 diff） | 已有 |
| **有来源的角色输出入口** | `src/kernel/app/bridge/character-output.ts`（闭集 + 话权 + 让出话权 + 用户抢话作废） | 已有 |
| 非对话输入的正规接口空间 | 不变量 21/22（`Observation` 入、`CharacterIntent` 出） | 已留 |

---

## 1. 必须先说的冲突：本 ADR **部分修订 ADR-110 `D11`**

### 1.1 被修订的原句

`src/kernel/app/bridge/character-output.ts:31-34`（`CharacterOutputSource` 闭集旁）：

> ⚠️ 这是一个**闭集**：往里加第四类等于放宽"有限插话"这条边界（改判据，要配负控）。
> 刻意**不包含**"主动闲聊""提醒日程""后台任务完成"这类 —— 它们属于"系统主动发起"，
> 是另一条线（`TD-19`），**不许从这里溜进来**。

`src/kernel/app/bridge/turn-bridge.ts:1117-1118`（`deliverQqText` 旁）：

> ⇒ 两者**都不**生成文本、**都**只运输。这里刻意**不**复用
> `arbitrateCharacterOutput`：**那会让主动联系从"被排除的闭集"里溜进去。**

ADR-110 `D11` 第三句同义：「不许复用 `character-output.ts` 的插话闭集（它**逐字**排除主动闲聊/日程提醒）」。

### 1.2 本 ADR 修订的是**结论**，不是**理由**

原裁定排除"主动闲聊"的**真实理由**是：**它没有来源** —— 一条无凭据的自由生成，会从"有来源才准说"这条边界上溜过去。

那条理由**仍然成立，并被本 ADR 强化**：`sourceRefs` 非空是**硬要求**，为空一律 `output_without_source` 失败关闭，
**不补默认来源**（与 `buildWakeResponseCandidate` / `buildLookupNoticeCandidate` 同一条纪律）。

变的是**结论**：ADR-111 已经把"来源"这个问题解掉了 —— **有界依据集就是它的来源**。
⇒ 因此"主动开口"从"无凭据的自由生成"变成了"**有凭据、有界、可复核**的一次输出"，
与当初被排除的那一类**不是同一个东西**。

### 1.3 修订的边界（三件仍然不许）

```text
① **日程提醒仍然排除**：那是 `local.reminder.message` 的语义（ADR-124 决策 6 逐字：
   「本地提醒使用独立 DELIVER_REMINDER_TEXT／REPORT_REMINDER_DELIVERY 协议，
    **不借用角色插话**」）⇒ 不得从本通道走。
② **"后台任务完成"仍然排除**：它属于 TD-19 的另一档，本 ADR 不碰。
③ **不得借此放宽 `SUBMIT_TURN` 的入口守卫**：`postlv2_vtuber_runtime.py:1119` 一个字不改。
```

---

## 2. 决策（待批准）

### D01 · 触发面：外壳只报事实，不产生内容、不指定说不说

外壳在空闲时发一个**只读机会报文**（新 packet，建议名 `PROACTIVE_OPPORTUNITY`），携带：

```text
{ kind:"PROACTIVE_OPPORTUNITY", requestId, entry:"avatar", idleMs }
```

- **它不是输入**：不落 `user_message`、不占正式轮次、不写记忆（与 `PREPARE_TURN` 同一条纪律）。
- **它不含任何要说的内容**：外壳不得提供正文、不得提供 prompt（`Please say something.` 这类**一律不带**）。
- **说不说、说什么，由 LG 决定**（用户 D1=(c) 裁定）。

### D02 · 输出通道：本轮走既有插话通道

复用 `turn-bridge.emitCharacterOutput` → `CHARACTER_OUTPUT` → 外壳播放。
**沿用** `CHARACTER_OUTPUT_LIMITS`（**2 句 / 60 字符**）。
⇒ 本轮**不新增** observation 事件类型、**不**走正式轮次形态。长发言留作后续 ADR（用户 D2 裁定：先 (a) 起步）。

### D03 · 闭集扩到四类：新增 `proactive_opening`

```ts
export type CharacterOutputSource =
  | 'wake_response' | 'mid_turn_correction' | 'authorized_lookup_notice'
  | 'proactive_opening'        // ← 本 ADR 新增（并同时修订 §1 的那两句注释）
```

**扩闭集 = 改判据 ⇒ 必须成对交负控**（见 §5）。这一条是原注释逐字要求的，本 ADR 照办。

### D04 · 内容：模型生成，但必须过既有回复守卫 + 有界依据集

- 正文由**一次私有模型调用**生成，**不新增第二个搜索/工具入口**。
- 生成结果**必须过既有回复守卫**（与正式轮次同一批守卫），未过 ⇒ 整条不发（不修补）。
- 依据面**强制复用 ADR-111 `S01`–`S03`**：只认**经过同一套遮蔽**的读时视图条目 + 稳定 id；
  可用集**有界**（≤8 条 / 摘要 ≤120 码点 / 顺序 = 视图顺序）。

### D05 · 生成前与发送前**各核对一次**

依据失效（条目被撤回 / 被遮蔽 / 版本变化）⇒ **整条作废，不修补**（ADR-111 `S04` 同一条）。

### D06 · 空依据集 ⇒ **在调模型之前** return

不花模型调用（ADR-111 `S06`）。读数记具名码，不记"假装想过"。

### D07 · 话权：`proactive_opening` 归入**非紧急**一类

沿用 `arbitrateCharacterOutput` 的判据顺序，但**新增一条**：

```text
用户正在说话（floor.userSpeaking）且 source === 'proactive_opening'
  ⇒ yield_to_user（代码：user_holds_floor_for_non_urgent_output）
```

理由与 `authorized_lookup_notice` 完全相同（`character-output.ts:110-112` 逐字）：
**它不紧急，用一句主动开口去打断用户，换来的信息量远小于打断的代价。**
⇒ 于是"主动开口"只在**用户没在说话**时成立。这是本功能的**主要可达条件**，必须写进验收。

### D08 · 长度：沿用 2 句 / 60 字符，超限丢弃

`output_too_long`。**不截断、不改写、不重生成**（截断会产生未经守卫的半句）。

### D09 · 版本：过期一律作废

`turnRevision` 由调用方给出（模块不自己造）；旧于用户版本 ⇒ `output_stale_against_user_revision`。
用户抢话 ⇒ `revokeForUserCutIn`（已有）。

### D10 · 落账：**不进对话账、不进记忆、不占正式轮次**

与既有三类插话**同一条纪律**（`turn-bridge.ts:2118` 逐字：「它**只读**：不落用户事件、不写记忆、不占正式轮次」）。

⇒ 由此得到本 ADR 最重要的一条**否定结论**：

```text
**不存在 `replyToEventId` 问题。**
`CHARACTER_OUTPUT` 产出的是 `CharacterOutput`（不是回复、不是 `assistant_message`），
因此不变量 18（assistant 事件 replyToEventId 必填）**不适用于本通道**。
```

**凭据在哪**：`sourceRefs`（只放 id，不放正文）+ 交付读数（`spoken` / `yielded` / `dropped` / `lastCode`）+ trace。

**如实记的代价**：她**不会记得自己开口过**（不进账本 ⇒ 下次没有"我上次主动找过你"这种记忆）。
若将来需要"她记得"，那是 D02 的 (b) 形态，属另一个 ADR，**不得**从本通道偷渡。

### D11 · 频次与时段：复用现成闸，不新造

`readProactivePolicy()`（时段 / 额度 / 冷却 / 暂停）+ ADR-113（活动时段**只约束 care**）。

### D12 · 外壳侧必须做的两件事

```text
① **先关掉 VTuber 自带的 proactive speak**（localStorage `proactiveSpeakSettings` /
   界面上的「主动搭话」）——否则两条路并存会互相打架，且那条路仍然会撞守卫。
② 页面只负责**播放与回执**；不生成内容、不决定说不说。
```

### D13 · 失败关闭与读数（每条具名，不合并）

```text
无出站通道        ⇒ output_channel_absent
正文为空          ⇒ output_without_checked_text
来源为空          ⇒ output_without_source
无版本            ⇒ output_without_revision
超 2 句 / 60 字   ⇒ output_too_long
来源不在闭集      ⇒ output_source_not_registered
版本过期          ⇒ output_stale_against_user_revision
用户占着话权      ⇒ user_holds_floor_for_non_urgent_output（yield，不是 drop）
```

### D14 · 与 TD-19 的边界

本 ADR 只做**皮套入口上的系统发起开口**这一纵切。
**`TD-19` 本体（系统主体归因 / 授权 / 幂等 / ledger / trace / 恢复 / 回复真相端到端）不收窄、不销账**，
仍需独立授权。

---

## 3. 与既有不变量组的关系

| 组 | 关系 |
|---|---|
| **不变量 21/22（FC-01/FC-02）** | 本 ADR 是它的**正面应用**：非对话输入走正规机会入口，**不伪装成 `user_message`**；输出不是 `string` 而是 `CharacterIntent` 家族里的 `CharacterOutput` |
| **不变量 6/17（来源防火墙）** | 不受影响：主动开口**不产生用户事实**；`sourceRefs` 只放 id，正文永不进 trace/账本 |
| **不变量 18（reply graph）** | **不适用**（见 D10）：本通道不产出 assistant 事件 |
| **不变量 11（ContextCompiler 单入口）** | 生成走同一编译入口；依据集作为 section 注入，可裁、可复盘 |
| **`INV-M45-01…06`（行动真相）** | 不受影响：主动开口不是动作，不产生 `ActionResult`，也不写动作账本 |
| **`INV-M55-01…06`（外部证据）** | 不受影响：主动开口**不得**携带外部检索结论（那是正式轮次的职责） |
| **ADR-124（三渠道）** | 本 ADR 只扩**角色开口**这一档；**提醒**档（`local.reminder.message`）语义不变，仍不从插话通道走 |
| **ADR-111（依据面）** | **直接复用**：有界依据集、双次核对、失效作废、空集不花模型 |

---

## 4. 被否决的备选

| 备选 | 否决理由 |
|---|---|
| **放宽 `postlv2_vtuber_runtime.py:1119`，让 `proactive_speak` 当正式输入** | 违反不变量 21；落成假 `user_message`；被 LangMem 抽取（`automatic-memory.ts:103`）；账本 append-only ⇒ **改不回来** |
| **给外壳配 `proactive_speak_prompt`** | **无效**：上游 `conversation_handler.py:51-55` **无条件**设置 `metadata.proactive_speak = True`，与 prompt 是否配置无关 ⇒ 守卫仍然拒 |
| **让外壳自己生成那句话** | 产生**第二份回复权威**（ADR-109 已裁定过同类：批次表演协议 / TTS-STT / 第二份回复权威三条失败条件） |
| **复用 `deliverQqText`（QQ 那条平行通道）** | 它是**投递文字**语义（`deliveryId` + 四道 QQ 具名失败关闭），不含话权仲裁；直接复用会绕过"用户占着话权就让位" |
| **复用 `character_jobs` 当日程/投递箱** | ADR-110 `D11` 明令禁止 |
| **把"主动开口"塞进 `wake_response`** | 借语义：呼唤回应是"回应一次呼唤"，有明确信号；主动开口没有那个信号 ⇒ 口径不干净 |

---

## 5. 要配的门（判据，不是愿望）

| 类型 | 判据 |
|---|---|
| **正控** | 有来源 + 用户没在说 ⇒ **真的说了**，且 `source === 'proactive_opening'` |
| 负控 1 | 用户正在说话 ⇒ `yield_to_user`（**不说**） |
| 负控 2 | `sourceRefs` 为空 ⇒ `output_without_source` |
| 负控 3 | 超 2 句 / 60 字 ⇒ `output_too_long` |
| 负控 4 | revision 旧于用户 ⇒ `output_stale_against_user_revision` |
| 负控 5 | 依据集为空 ⇒ **零模型调用**（`S06`） |
| 负控 6 | 依据在生成与发送之间失效 ⇒ 整条作废、**不修补** |
| **负控 7（本 ADR 的核心判据）** | **对话账本里没有新增 `user_message`** |
| **负控 8（本 ADR 的核心判据）** | **LangMem 抽取器水位不动、无 extraction**（证明它没进记忆） |
| 负控 9 | 无出站通道（外壳离线）⇒ `output_channel_absent`，**不假装说过** |
| 量具有效性 | 正控 / 负控 / **恢复** 三段式；每条拒绝给**互不相同**的具名码 |

> ⚠️ 负控 7/8 是"这条通道**没有**污染认知"的机器证据 —— 没有它们，本 ADR 的主张就只是"我猜它不会"。

---

## 6. 已知代价与**不主张**

```text
① **不主张"她不会说错"**：措辞层仍无启发式守卫（`DR-11` 照旧），机械保证只到
   来源非空 / 长度 / 版本 / 话权四道。
② **不主张她在真人会话里会自然开口**：本通道的可达条件 = **用户没在说话**，
   而现实中用户常在等她说完（生成 7–24s）⇒ 触发频率可能很低（与 Lv4.5 §5.12 同源）。
   要把它变成读数，需统计"她空闲且用户未开口"的真实次数（**未做**）。
③ **不主张她记得自己开口过**（见 D10 的代价面）。
④ **不主张 2 句 / 60 字够用**：这是 D02=(a) 的硬约束；不够就要走 (b) 形态，另开 ADR。
⑤ **不主张外壳侧的 proactive speak 已关**：D12 ① 是**前置条件**，必须在实现时验证。
```

---

## 7. U1–U5 裁定（2026-10-11，草案作者裁定；**待你批准**）

> 这五条原先列为"未决"。现在逐条裁定，理由尽量**引用仓库里已有的冻结值**而不是新拍数字。

### U1 · 机会报文的频率与去重键 → **D15**

**裁定：三层闸 + 双键，且 LG 不信任外壳报来的 `idleMs`。**

```text
① 入口下限   openingMinIdleMs = 180_000（3 分钟）
             外壳报的 idleMs < 此值 ⇒ 直接拒，**不调模型**
             理由：短于此的沉默是正常对话停顿，插话只会显得吵

② 冷却       openingCooldownMs = 1_800_000（30 分钟）
             LG 侧记 lastOpeningAt；未到冷却 ⇒ 直接拒，**不调模型**

③ 日上限     maxOpeningsPerDay = 4
             ⚠️ 并**计入** ProactivePolicy.maxProactiveMessagesPerDay（10）这个**总闸**
             ⇒ 主动开口与 care／提醒**共用每日总上限**，分闸独立、总闸共享
```

**去重键（双键，两者都要）**：

```text
机会键  openingOpportunityKey = `${dayKeyOf(now,tz)}T${hour}`   ← 与 careOpportunityKey 同形、不同前缀
        ⇒ 同一小时最多一次机会；重复报文 / 回调重入 / 重启算出的键相同 ⇒ 幂等
冷却键  lastOpeningAt（存在投递登记里，不新建表）
```

**为什么不信任 `idleMs`**：外壳可以（也会）误报 —— 刚才那 33 次就是明证。
⇒ `idleMs` 只作为"**页面还连着**且**用户没在操作**"的**提示**；LG 侧另有自己的读数
（她是否正在说、最后一次真实入站是什么时候）。这与"**程序生成证据，模型不决定执行**"同一条纪律。

**这三个数字住哪里**：它们是 **`ProactivePolicy` 的新字段**
（与 ADR-110 `D14` 的 `careCooldownMs` / `maxCarePerDay` 同一族）——
⇒ `openingMinIdleMs` · `openingCooldownMs` · `maxOpeningsPerDay` **随策略版本一起冻结并落库**，
不是散在代码里的常量。上面的数字是**待冻结建议值**，批准时一并定档。

**⚠️ 与现有热循环同源的残余风险**：那条循环的根因是"秒失败 ⇒ 立刻又被判空闲"。
本通道的 ①②③ 三道闸把它挡住了（拒的时候**不调模型**），但**必须有一条读数**证明它真的挡住了
（见 §7 的负控 10）。

### U2 · 要不要自己的机会预检 → **D16**

**裁定：复用 ADR-111 的十条具名拒绝作为基线，另加四条本通道特有的。**

四条本通道特有（**全部在调模型之前**判，与 `S06` 同一条纪律）：

```text
① 依据集为空                 ⇒ 拒（复用 S06；**不花模型调用**）
② 她**正在说**               ⇒ 拒（省下一次必然被 D07 yield 掉的模型调用）
③ 用户**正在说**             ⇒ 拒（D07 在仲裁层也会 yield，但预检层先拒更省）
④ **没有活客户端**（页面没连）⇒ 拒
   否则会"生成完才发现 `character_output_no_live_client`" —— 白花一次模型调用
```

⇒ 十条 + 四条 = **十四条具名拒绝**，每条互不相同的理由码（沿用 ADR-111 的`互不相同`要求）。

### U3 · 模型调用的额度与超时 → **D17**

**裁定：有，且比 care 更短。**

```text
期限   openingDeadlineMs = 8_000
       理由**有实测支撑**：与 ADR-104 的 role-tool 决策调用同一档，
       实测 24 次 min 974 / avg 1725 / p90 2400 / **max 3941ms**，越 8000ms 期限 **0 次**
       ⚠️ 不用 ProactivePolicy.evaluationTimeoutMs = 15_000 —— 那是"用户不在场"的 care 档；
          主动开口发生在**用户在线**时，用户能直接感到卡
额度   单次机会**只允许一次**模型调用（与"每轮 ≤1 次判定调用 / ≤1 次 provider 调用"同形）
超时   整条作废、**不重试**（由**新的**机会驱动，不是原地重试）
```

### U4 · 外壳侧 packet 形状与回执 → **D18**

**裁定：复用既有形状，不新开协议族。**

**外壳 → LG**（只读，与 `PREPARE_TURN` 同族，不占轮次、不落用户事件）：

```json
{ "kind": "PROACTIVE_OPPORTUNITY", "requestId": "...", "entry": "avatar", "idleMs": 180000 }
```

**LG → 外壳**：她说的话**仍走 `CHARACTER_OUTPUT`**（已有通道）；机会本身的回执新开一类只读报文：

```json
{ "kind": "OPPORTUNITY_RESULT", "requestId": "...",
  "decision": "spoken|silenced|deferred", "code": "<具名理由码>", "source": "proactive_opening" }
```

⚠️ **回执不含正文**（正文只在 `CHARACTER_OUTPUT` 里，与 `D09` 一致）。

#### ★ U4 附带一条**硬前置**（读代码发现的，不是设计选择）

`deliver_character_output`（`scripts/postlv2_vtuber_runtime.py:998-1004`）逐字要求 payload 带
**`expression` sidecar 且 `segments` 非空**：

```python
sidecar = payload.get("expression")
segments = sidecar.get("segments") if isinstance(sidecar, dict) else None
if not segments:
    INTERJECTION["unsupported"] += 1
    INTERJECTION["last_code"] = "character_output_without_expression"
    return
```

⇒ **`proactive_opening` 必须带 sidecar**（与既有三类插话一样），否则**根本播不出来**，
而且失败形状是 `unsupported` 而不是 `dropped` —— 看起来像"没触发"，不像"配置错了"。
这条必须进实现清单的第一项。

### U5 · 要不要一条具名的归因豁免 → **D19（结论：不需要，但设一条绊线）**

**裁定：按当前设计不需要。**

```text
理由：具名归因豁免（`D05a` 先例 / ADR-098 的 `preview_turn_lookup`）是给**动作**用的 ——
      动作网关要求 `initiatorEvidence`，而"轮次之前"的调用没有因果上下文。
      本通道**不产生动作**：不调工具、不写动作账本、不产生 `ActionResult`。
      它唯一的"写"是一次模型调用（不落账）与一条 `CHARACTER_OUTPUT`（不落账）。
```

⚠️ **绊线（写进实现清单）**：若实现时发现它**需要**走 `ActionGateway`
（例如为了复用模型调用的额度/账本），那就**必须**新增一条具名豁免，
且必须按 `D05a` 的纪律交**两道可见 diff**（登记表 + `WRITE_CAPABLE_ATTRIBUTION_EXEMPTIONS` 白名单）。
⇒ **不许在实现里悄悄加豁免**；出现这个需求时必须回到本 ADR 重新裁定。

### U1–U5 追加的负控

| 类型 | 判据 |
|---|---|
| 负控 10 | 外壳连发同一小时内的多条 `PROACTIVE_OPPORTUNITY` ⇒ **只有第一条被处理**，其余零模型调用（U1 的机会键幂等） |
| 负控 11 | 距上次开口 < `openingCooldownMs` ⇒ 拒，**且 `idleMs` 再大也不放行**（冷却压过提示） |
| 负控 12 | 达到 `maxOpeningsPerDay` 或**共享总闸** `maxProactiveMessagesPerDay` ⇒ 拒 |
| 负控 13 | 页面没连（无活客户端）⇒ 预检层就拒，**模型调用计数为 0**（U2 ④） |
| 负控 14 | payload **不带 sidecar** ⇒ `character_output_without_expression`（**如实报 unsupported，不伪造 sidecar**） |
| 负控 15 | 模型超过 `openingDeadlineMs` ⇒ 整条作废，**不重试**、不产生第二次调用 |

---

## 8. 批准后的实现顺序（WP 草案，仍不动代码）

| WP | 内容 | 为什么这个顺序 |
|---|---|---|
| **WP0** | 基线：`PROACTIVE_OPPORTUNITY` 报文形状、机会键、三道闸的**只读**读数面 | 先把"挡住了什么"变成可见 |
| **WP1** | 设计冻结：把 §2 的 D01–D14 与 §7 的 D15–D19 落成契约（类型 + 具名码，**不含实现**） | 本仓库一贯做法（先契约后实现） |
| **WP2** | **外壳侧先关掉自带的 proactive speak**（D12 ①） | ⚠️ **不先做这步，其余全部白做**：那条路会继续 33 次/分钟撞守卫 |
| **WP3** | LG 侧机会受理 + 预检（十四条拒绝）+ 三道闸 | 全部在调模型之前 |
| **WP4** | 依据集构造（复用 ADR-111）+ 一次模型调用 + 回复守卫 + **sidecar** | sidecar 是 U4 的硬前置 |
| **WP5** | 交付读数 + `OPPORTUNITY_RESULT` 回执 + trace | |
| **WP6** | 门：正控 1 + 负控 15 + 三段式量具有效性 | |
| **WP7** | 真链路 smoke（生产副本 + 真外壳） | |

---

## 9. 批准记录（2026-10-11）

```text
裁定人 : 用户
原话   : 「批准 D01–D19」
范围   : D01…D14（§2，含用户四项裁定 D1=(c) / D2=先(a)起步 / D3+D4=加第四类 + 模型生成 + 有界依据集）
         + D15…D19（§7，U1–U5 的逐条裁定）
载体   : 本文件（ADR-131）即裁定载体
性质   : **设计冻结**。批准的是设计与判据，**不是**"已实现"、**不是**"已激活"、
         **不是**"负控已验"
```

⚠️ **批准不自动做**：

```text
① 不改 `scripts/postlv2_vtuber_runtime.py:1119` 的入口守卫（一个字不改）
② 不动 `.env`（本 ADR 不含任何生产开关）
③ 不动 `TD-19` 本体
④ 不因为批准而宣称"她已能主动开口"
```

⚠️ **前置条件（§8 WP2）**：外壳自带的 proactive speak 必须先关（D12 ①）。
不先做这步，实现完成前的每一次启动都会继续按 33 次/分钟撞守卫。

---

## 10. 参考

- 触发实例：`C:\Users\user\Desktop\报错1.txt`（33 次 / 53 秒，日志结束时仍在刷）
- ADR-109（双入口共存，不采用 AstrBot 整套替换）
- ADR-110（QQ 主动联系，`D11` 三个"不许"）
- ADR-111（关心的依据面 `S01`–`S07`）
- ADR-113（活动时段只约束 care）
- ADR-124（受信入口事实与三渠道提醒出口；决策 6 逐字"不借用角色插话"）
- 代码：`src/kernel/app/bridge/character-output.ts` · `turn-bridge.ts` · `src/kernel/contracts/chat-channel.ts`
- 上游：`open_llm_vtuber/conversations/conversation_handler.py` · `Open-LLM-VTuber-Web-source` 的 `proactive-speak-context.tsx`
