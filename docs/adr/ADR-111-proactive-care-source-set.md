# ADR-111 —— 主动关心的**依据面**（`system_opportunity` section 与可用来源集）

- **状态**：`ACCEPTED / DESIGN FROZEN`
- **日期**：2026-10-06
- **上游**：[ADR-110](ADR-110-qq-proactive-messaging.md)（QQ 主动联系，`D01`–`D14`）·
  [计划 §4.2](../post-lv2/QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md)
- **上位**：计划 §8 的 WP4（角色选择与提醒措辞）。本 ADR **只**裁"依据从哪来"，不改 `D01`–`D14` 任何一条。

---

## 0. 它解决哪一件具体的事

```text
ADR-110 `D03`：关心的候选**必须**带"已有依据引用"（计划 §4.2 逐字：'附理由码、已有依据引用'）
`verifyProactiveSources`：`sourceRefs` 为空 ⇒ `proactive_without_source`；
                         可用集为空 ⇒ `proactive_source_set_unavailable`（**空集即拒**）
⇒ 于是"可用来源集从哪来"就成了**唯一的阻塞点**（`L-QQP-07`）：
  没有它，关心**结构上**发不出去（不是"还没接线"，是"没有东西可引"）
```

---

## 1. 裁定（`S01`–`S07`）

### `S01` 只认**已经过遮蔽**的条目，且必须先有 `id`

可用来源集**只能**由**既有读时视图**给出的条目构成，而且每条必须带一个**稳定 id**：

```text
允许：M4 记忆事实（`memory_fact`，带 fact id）—— 读时已过遗忘/取代遮蔽
允许：M9 可用信念（带 belief id）—— 已是 `usable` 集合（资格回查 + 同轮遮蔽之后）
允许：M10 目标 / 承诺（带 id）—— 未结清的那些
不许：任何"原始历史副本"（最近对话行、另一入口的近期原文、trace、账本）
```

⚠️ **不读绕过遮蔽的副本**是计划 §4.2 的逐字要求（"ContextCompiler 应沿用现有遗忘遮蔽，
不读绕过遮蔽的原始历史副本"）。⇒ 本 ADR 的**实质**不是"挑哪些条目"，而是
**"只能从已经过同一套遮蔽的读时视图里挑"**。

### `S02` 可用集是**有界**的，且界在**程序**手里

```text
最多 `PROACTIVE_MAX_SOURCE_OPTIONS`（8）条 —— 这个常量在 ADR-110 的契约里**已经存在**
每条摘要 ≤ `PROACTIVE_SOURCE_SUMMARY_CODEPOINTS`（120）码点
排序：按"读时视图自己的顺序"取前 8 条（**不**在这里另发明一套打分）
```

⚠️ 摘要**由程序生成**（契约 `ProactiveSourceOption.summary` 的注释逐字），
**不是**正文、**不是**她要说的话 —— 它是"可以引用的东西长什么样"的**标签**。

### `S03` `system_opportunity` 是**追加**的 section kind，且**不传渲染器 = 0 个 section**

```text
· `ContextSectionKind` **追加** `'system_opportunity'`（不动既有成员、不动顺序）
· 装配层用与 `renderRelationship` / `renderAffect` / `renderBelief` **同一形状**的可选渲染器：
  不传 ⇒ 0 个 section ⇒ `evals/fixtures/m3.5/prompt-baseline.txt` **逐字节不变**
· 它是**系统机会**那一类轮次的 section：记录"这一次机会把哪些依据摆出来了"（供 trace 与复核）
```

⚠️ 这条是**照抄既有的两次先例**（M7 `renderRelationship`、M8 `renderAffect`、M9 `renderBelief`），
理由也照抄：任何"不传就变成 0 section"的扩展点才不会动冻结的 prompt 基线。

### `S04` **生成前**与**发送前**各核对一次（两次，缺一不可）

```text
生成前：装配层用**当时**的可用集构造简报 ⇒ 模型只能从这 8 条里挑
发送前：`runCareOpportunity` 在**交给外壳之前**再核对一次
        （中间可能发生遗忘 / 来源失效 / 任务结清 —— `D11` ③）
```

⚠️ 两次用的**必须**是**同一套**可用集构造逻辑（同一个函数），否则"复核"复的是另一件事。

### `S05` 候选失效 ⇒ **整条作废**，不修补、不重问

```text
引用不在可用集里 ⇒ `proactive_source_stale` ⇒ 放弃本次机会（`runCareOpportunity` 已如此）
**不**做"把失效的那条拿掉再发一次"：那是**修复对话**，计划 §4.2 逐字禁止
（"候选不合规或守卫判不过就丢弃，不触发无限修复对话"）
```

### `S06` 依据面**未接线**时：不花模型调用，且具名

```text
可用集为空（或渲染器未接）⇒ 装配层**不调模型**、**不发**，如实记 `L-QQP-07`。
⚠️ **绝不**用编造的依据或程序模板硬凑一条"关心"出来 ——
   那等于替她说了一句她**没有任何依据**可说出口的话。
```

### `S07` 明确**不**做的事

```text
· 不新增"依据"这一类新存储（复用既有投影/读时视图）
· 不为关心单独做一套打分 / 排序 / 去重（用读时视图自己的顺序）
· 不让模型**新增**依据（它只能在闭集里挑）
· 不把"调度事件、候选文字、模型猜测"升级成用户事实 / Belief 背书 / 长期记忆
  （计划 §4.2 逐字；`D04` 的禁令原样）
· 不改 `D11` 的三条禁令（不包成 `user_message` · 不复用插话闭集 · 不复用 `character_jobs`）
```

---

## 2. 为什么不用其它三种做法

| 备选 | 为什么否决 |
|---|---|
| **用最近对话行当依据** | 计划 §4.2 逐字："其它入口近期原文不因主动调度流入 QQ" —— 而"最近对话行"恰恰**就是**原文；用它就等于把两个入口的原文混起来 |
| **让模型自己编一个 `sourceRef`** | `verifyProactiveSources` 的存在前提就是"引用必须在程序给的闭集里"；让模型编就等于把这道复核变成装饰 |
| **没有依据也允许 `send`** | 那正是 ADR-110 `D03` 要防的"她凭空说一句"；`proactive_without_source` 是**刻意**的拒绝口 |

---

## 3. 与本 ADR 之外的东西的关系

```text
· ADR-110 的 `D01`–`D14`：**一字未改**（本 ADR 只补 `D03` 里"依据从哪来"那一格）
· `evals/fixtures/m3.5/prompt-baseline.txt`：**逐字节不变**（`S03` 的"不传 = 0 section"保证）
· 提醒那一类：**不受影响** —— 它的来源是"本人要求过的那条意图"（`D03` 的既有语义）
· `notification_intake` 的十种预检拒绝：**不受影响**（那是"够不够格"，这是"拿什么说"）
```

---

## 4. 本 ADR **不**主张什么

```text
· **不**主张"关心从此能发了"：本 ADR 裁的是**依据面的规则**；
  真正的可用集要等 `system_opportunity` 渲染器接线（下一个工作包）
· **不**主张依据一定是"对的"：`S01` 只能保证"它经过同一套遮蔽"，
  不能保证"她引用得恰当"（那是措辞层的事，措辞层**没有**启发式守卫 —— `DR-11` 的既有立场）
· **不**主张收益：本 ADR 不给出任何"她因此更自然 / 更少打扰"的读数 —— 那要真模型档
```

---

## 5. 落地清单（下一个工作包）

```text
① `src/kernel/contracts/context.ts`：`ContextSectionKind` **追加** `'system_opportunity'`
② `src/kernel/context/sections.ts`：`renderSystemOpportunity?`（与 `renderBelief` 同形）
③ 一个**纯函数**把"读时视图的条目"映射成 `ProactiveSourceOption[]`（有界 + 确定性）
④ 装配层：把渲染器接上、调模型、`runCareOpportunity`
⑤ 门：`system_opportunity` 不传 ⇒ 0 section（基线逐字节不变）· 有界 ·
   stale ⇒ 整条作废 · 可用集为空 ⇒ 不调模型且具名
```
