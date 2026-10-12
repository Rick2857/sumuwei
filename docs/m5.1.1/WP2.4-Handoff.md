# WP2.4 Handoff — Migration Gate Alignment + Production-Copy v7 Apply

> ## 状态
>
> ```text
> K-20                        = CLOSED
> production-copy v7 apply    = PASS
> K-8                         = CLOSED
> ```
>
> **三项全部成立 ⇒ `WP3 = READY`**（技术上无阻塞）。
> **但动手许可仍在你手里**（STOP 点未变）：真实库 / production-copy 的
> **正式** apply 与 **WP3 回填 = NOT RUN**；WP3 **= NOT STARTED**。
> 本 WP **没有**开始 legacy backfill，**没有**进 Phase 4。
>
> **另有一项待你裁定**：**K-21 = OPEN**（两份冻结文档之间的一个格子冲突，见下）。
> 它**不**阻塞 WP3（门把它登记为"已登记冲突"，不替用户改判任何一侧）。
>
> 下次 execution **先读这份**，再读
> [`WP2.3-Handoff.md`](./WP2.3-Handoff.md)（K-18 / K-19）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) **R-17 / R-18**、
> [`M5.1.1-WP2.4-Compatible-Assertion-Record.md`](./M5.1.1-WP2.4-Compatible-Assertion-Record.md)。
> **不要重新探索仓库。**

```text
Completed WP: WP2.4 — Migration Gate Alignment + Production-Copy v7 Apply
  K-20 = CLOSED（D/P/U/N 分类感知的反伪造门；三段式自测 29/0）
  production-copy v7 apply = PASS（副本上 v6 → v7；源只读；25/0）
  K-8  = CLOSED（MIGRATION_0007 指纹已锁 + 漂移自检）
  K-21 = OPEN（**新登记**：system_event.contentOriginator 的跨文档冲突，待你裁定）
  真实库 apply = NOT RUN ｜ WP3 = NOT STARTED

Changed Files:
  src/kernel/contracts/attribution.ts                   （改：D/P/U/N 分类矩阵 + 分类感知的 MIGRATED_LEGACY 校验）
  scripts/kernel-tests-m5.1.1.ts                        （改：1 条断言的期望理由码 + toolEventEnvelope 夹具；**条数仍 42**）
  scripts/verify-m5.1.1-k20-anti-fabrication.ts          （新增：K-20 门，含三段式与转录保真自检）
  scripts/verify-m5.1.1-migration.ts                    （改：FROZEN_MIGRATION_FINGERPRINTS 加 v7 + K-8 漂移自检）
  package.json                                          （改：+ m5.1.1:k20:verify）
  docs/m5.1.1/M5.1.1-Proposed-Schema.md                 （改：§7 ⑦ 换成分类感知判据）
  docs/m5.1.1/M5.1.1-Migration-Strategy.md              （改：§7 检查清单的 M4 那两条换成分类感知判据）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                  （改：R-17 追加 K-8 关闭结论；新增 R-18）
  docs/m5.1.1/M5.1.1-WP2.4-Compatible-Assertion-Record.md （新增：F4 的 changed assertion 记录）
  docs/m5.1.1/WP2.4-Handoff.md                          （本文件）
  artifacts/m5.1.1/wp2.4-*.{json,txt,log}               （新增：8 条门的逐字 stdout + 结构化证据）
  artifacts/m5.1.1/wp2.4-restore-whitelist.txt          （新增：还原白名单 + fork 说明）

Tests Run（全部 exit 0；见 wp2.4-gate-exits.txt）:
  pnpm typecheck                        → 0
  pnpm kernel:test                      → 0（**26 / 0**）
  pnpm kernel:test:conversation         → 0（**47 / 0**）
  pnpm m5.1.1:test                      → 0（**42 / 0**；条数与 WP1 证据一致，见兼容性记录）
  pnpm m5.1.1:migration:verify          → 0（**79 / 0**；含 v7 指纹校验 + K-8 漂移自检）
  pnpm m5.1.1:k20:verify                → 0（**29 / 0**；三段式全绿）
  pnpm m5.1.1:prod-copy:verify          → 0（**25 / 0**；副本 v6 → v7）
  pnpm m5.1:measurement:verify          → 0（**16 / 0**；AGENTS §5 对新 `verify-*.ts` 的要求）

Tests Passed: 26/26 · 47/47 · 42/42 · 79/79 · 29/29 · 25/25 · 16/16；8 条命令全 exit 0
Tests Failed: 0
Tests Not Run:
  · **真实库** data/pglite 的 migrate:apply —— **本 WP 明令不做**（源只允许"读/复制"边界）
  · WP3 legacy backfill（未开始）
  · pnpm m4.5:ci / m4.5:ci:full（全量回归，WP10 的项）

Evidence Produced:
  artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json  —— K-20 的完整事实（分类矩阵 / 转录保真 / 三段式 / 已登记冲突）
  artifacts/m5.1.1/wp2.4-production-copy-v7.json    —— Section B 的结构化证据（本次 apply）
  artifacts/m5.1.1/wp2.4-axis-b-before-image.json   —— 本次 apply 的 Axis B before-image
  artifacts/m5.1.1/wp2.4-migration-verify.json / wp2.4-migration-preview.txt —— 本次迁移门的结构化证据
  artifacts/m5.1.1/wp2.4-v7-fingerprint.txt         —— MIGRATION_0007 的 canonical 指纹（version/name/条数/hash）
  artifacts/m5.1.1/wp2.4-gate-exits.txt + wp2.4-*.log —— 退出码 + 8 条命令逐字 stdout
  artifacts/m5.1.1/wp2.4-restore-whitelist.txt      —— 还原白名单 + fork 说明 + 真实库前后测量

Commit Hash: 8b69e1f8fbebaacb238686ac32a928b30551a32f   （feat：K-20 / K-8 实现 + 全部证据）
             f3e26da                                    （docs：R-18 / K-21 登记 + 本文件）
```

---------------------------------------------------------------------------
 A. K-20 —— 过期规则替换为 D/P/U/N 分类感知
---------------------------------------------------------------------------
**被替换的过期规则**（三处落点，全部处理）：

```text
MIGRATED_LEGACY AND concrete contentOriginator → always invalid
  · src/kernel/contracts/attribution.ts 的 validateMigratedLegacyEnvelope   ← 已替换
  · M5.1.1-Migration-Strategy.md §7 检查清单的 M4 条（"content_originator_kind 具体值"）← 已替换
  · M5.1.1-Proposed-Schema.md §7 ⑦                                      ← 已替换
为什么过期：tool_event.contentOriginator = **D**（K-3 FINAL）——
确定性工具行记录 Known(TOOL/<tool-id>) 是**正确结果**，旧规则会把它判成伪造。
```

**新判据**（`pnpm m5.1.1:k20:verify`，29 通过 / 0 失败）：

```text
D  记了 Known 就必须与确定性证据**逐字一致**（`TOOL/<actor_id>` / `CHARACTER/<actor_id>`）；
   不一致 = 伪造。**Absent 不算伪造**（还没回填 ≠ 编造）—— 这是本 WP 自己纠正的一次过紧判据。
U  具体值计数必须为 0；适用行一律 Unknown(LEGACY_UNRECORDED)（Known 或 Absent 都违规）
N  必须 Absent
P  只有在存在**独立行级证据**（actor_id 非空）时才允许 Known；否则 Unknown(LEGACY_UNRECORDED)；不许 Absent
值级（与分类无关，保留旧理由码）：contentOriginator 永不可是 Known(USER) / Known(CHARACTER)
保留：<slot>_kind LIKE 'UNKNOWN%' 计数 = 0；混合 known+unknown 元组计数 = 0
```

**anti-fabrication 没有放宽**（判据是**变紧**的）：

```text
旧判据抓不到、新判据能抓到的：
  · N 槽位被填值（旧规则完全没查）
  · P 槽位没有独立行级证据却记 Known（旧规则没查）
  · D 槽位的 Known 与确定性证据不一致（**新增**，这是 R-18 的正面要求）
唯一"不再报"的情形：D 槽位记录**与证据一致**的 Known —— 那本来就是正确结果。
```

**三段式自测**（同一门内，全部实测）：

```text
正控：确定性的工具行（Known(TOOL/weather)）⇒ 检测器**安静**
      + 自检"确实存在一个确定性工具行被审过"（防空集通过）
      + 自检"检测器真的读到了行"（rows_in_scope > 0，否则 MEASUREMENT INVALID）
负控：同一行改成 Known(USER) / Known(CHARACTER) / **另一个 TOOL id**（TOOL/search）
      ⇒ 每次都必须响（`d_slot_known_mismatch` / 值级码）
      U 槽位填具体值 ⇒ 响；N 槽位被填值 ⇒ 响；D 槽位说成 Known(USER) ⇒ 值级禁止响
恢复：把值改回正确的 ⇒ 检测器**重新安静**
```

**转录保真**（不做这条，"分类"就是手抄的信仰）：

```text
解析 M5.1.1-Migration-Strategy.md §3.2（conversation_events 逐族）与
§3.3（character_action_events 逐事件类型）的 **markdown 表格**，与编码的矩阵**逐格**比对 ⇒ 一致。
另加两条机检：
  · 编码的事件类型集合 == ACTION_EVENT_TYPES（多一个少一个都红）
  · `N ⟺ ABSENT` 与写入期必要性矩阵交叉核对（**除已登记冲突外零不一致**）
  · BACKFILL_CONTRACT_DEFERRED_FAMILIES == "分类表覆盖不到的族"（恰好相等，
    免得将来新增一个族却**静默**没有回填规则）
```

**契约层改动面**：`AttributionEnvelope` 是按**语义族**构造的，而 §3.3 是**逐事件类型**冻结的
（一个族覆盖多个类型，且这些类型的 U 格并不一致）⇒ 契约层只执行**可判定**的部分
（N 由写入期 `ABSENT` 精确等价推出 + 值级禁止），**U 的限制交给库级门**（它看得到具体 `event_type`）。
这个降级是**机读**的（`BACKFILL_CONTRACT_DEFERRED_FAMILIES`），不是悄悄放过。

---------------------------------------------------------------------------
 A.2 K-21 —— 新发现的**跨文档冲突**（OPEN，待你裁定）
---------------------------------------------------------------------------
K-20 的"转录保真 + `N ⟺ ABSENT`"自检**抓到一个真问题**（不是编码写错，是文档本身不一致）：

```text
system_event.contentOriginator
  M5.1.1-Proposed-Schema.md §3（写入期必要性矩阵）      = ABSENT
  M5.1.1-Migration-Strategy.md §3.2 表 + 逐条依据 L135 = **P**

两侧都是**冻结文档**。`N ⟺ ABSENT` 在这一格上不成立。
```

**我没有替你做任何一侧的改判**：
- 契约矩阵按 §3.2 编码（回填分类的权威是 Migration-Strategy）；
- 门把这一格登记为**已登记冲突**（`REGISTERED_CLASSIFICATION_CONFLICTS`，机读、带两份文档的出处），
  并断言"自洽性检查**恰好**只豁免这一格"—— 任何**新的**不一致仍会立刻变红；
- 冲突本身写进 `wp2.4-k20-anti-fabrication.json` 与 R-18 的备注，**等你裁定**。

三种可能的方向（**留给你选**，我不预设）：① 认为 system_event 的内容来源确实不可确定 ⇒ §3.2 改成 N；
② 认为"系统事件也可能有内容来源"⇒ Proposed-Schema §3 改成 ALLOWED_UNKNOWN；③ 两者都对、
只是**两个轴本就不同义**（那就要重新定义 `N ⟺ ABSENT` 这条机检的含义）。

---------------------------------------------------------------------------
 B. PRODUCTION-COPY V6 → V7（源：**只读/复制边界**）
---------------------------------------------------------------------------
```text
源 data/pglite：**应用代码从未打开**（门里 realSourceOpenedByApplicationCode = false）
  复制前：确认静默（连续两次指纹一致，3000ms 窗口）
         文件数 1201 / 总字节 31,289,946 / boundary 指纹（(相对路径,大小) 排序后 sha256）
  复制后：源指纹与复制前**相同**（源在复制期间没有被写）
         副本文件数 1201 == 源；副本总字节 31,289,946 == 源
         副本 apply 前 schemaVersion = **6**（⇒ 证明没有把 v7 施加到别处）
在**副本**上（按你列的 9 步）：
  ① 迁移预览：只待应用 v7（114 条语句）      ② 只 v7 pending（apply 后 pending = 0）
  ③ apply v7（from 6 → to 7，applied = [7]） ④ 副本 schemaVersion = **7**
  ⑤ K-4 约束：conversation_events 23 / character_action_events 23 / developer_control_events 22
  ⑥ K-16 三列仍在且仍是 text / 可空 / 无默认  ⑦ 既有行值**逐行**未变（28 行全部一致）
  ⑧ 没有回填（attribution_origin 非空 = 0；18 个槽位列全 NULL）
  ⑨ 没有伪造归因值（content_originator_* 全 NULL = 0 非空）
  restoreEpoch = NOT_APPLICABLE（本次没有 restore，按你的明令不记）
量具自检：7 个计数型检测器全部有效（无效 0）
```

**真实库独立复测**（不是转述读数）：apply **前后**各自实测
`1201 文件 / 31,289,946 字节 / mtime 2026-09-17T15:51:40.7898589Z` —— 三项逐字段一致。
⇒ **真实库仍然是 v6，且一个字节都没动**。

---------------------------------------------------------------------------
 C. K-8 —— 指纹锁定（CLOSED）
---------------------------------------------------------------------------
```text
version      = 7
name         = m5.1.1-attribution-model
statements   = 114
sha256       = 2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613
算法         = sha256 over MIGRATION_0007.statements.join('\n')（与 0001–0006 同一算法）
落点         = scripts/verify-m5.1.1-migration.ts 的 FROZEN_MIGRATION_FINGERPRINTS[7]
```

**触发时序（如实说明）**："第一次成功的 production-copy v7 apply" 由 **WP2.2** 首次达成（25/0），
本 WP 再次执行同一门（Section B）确认 PASS，并据此锁定。
另需说清一点：**指纹是源码的确定性函数**，与 apply 的运行时结果无关 ——
所以"apply 之后才锁"是一个**程序性触发点**（确认 v7 从此成为历史 DDL），不是数据依赖。

**漂移必红**（新增自检，实测）：把 v7 的语句列表改一个字节 ⇒ 指纹变成 `583158ed…`
（≠ 锁定值 `2d51997d…`）⇒ 比较器**必红**。从此 **v7 不可改；schema 变更必须新写 v8+**。

---------------------------------------------------------------------------
 还原白名单（R-13 第②条 / AGENTS §7）
---------------------------------------------------------------------------
5 条历史证据被复跑重新生成，已逐个路径 `git checkout --` 还原：
`artifacts/m5.1/measurement-negative-controls.json`（冻结的 M5.1 证据）·
`artifacts/m5.1.1/wp2-schema.json` · `artifacts/m5.1.1/migration-preview.txt` ·
`artifacts/m5.1.1/wp2.2-production-copy-schema.json` · `artifacts/m5.1.1/wp2.2-axis-b-before-image.json`。

★ 后四条**不是丢掉**：它们正是本次运行的结论，已 fork 成 WP2.4 自己的文件
（`wp2.4-migration-verify.json` / `wp2.4-migration-preview.txt` / `wp2.4-production-copy-v7.json` /
`wp2.4-axis-b-before-image.json`，**字节一致**，逐次核对 True），再还原原路径。
理由：F4 要求 WP2/WP2.2 的历史证据永久冻结，而"本次 apply 的结果"必须留在盘上 —— 两者都要。

Known Issues:
  K-20 【**CLOSED**】分类感知反伪造门 = 29/0；三段式（正控 / 负控 / 恢复）全绿；anti-fabrication 未放宽（判据变紧）。
  K-8  【**CLOSED**】MIGRATION_0007 指纹已锁 + 漂移自检；v7 从此不可改。
  K-21 【**OPEN —— 待你裁定**】`system_event.contentOriginator` 的跨文档冲突（见 A.2）。
  K-18 / K-19 / K-16 / K-17 / K-3 【CLOSED】（前序 WP）。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  【待裁定】`WP3` 的正式状态词：技术口径 = READY；动手口径 = BLOCKED BY 你的放行。

Architecture Deviations:
  D-1  **分类矩阵进了契约**（`CONVERSATION_BACKFILL_CLASSIFICATION` / `ACTION_BACKFILL_CLASSIFICATION` /
       `BACKFILL_CLASS_SOURCE`）：写入期校验与库级门共用一份语义，避免两套 D/P/U/N。
  D-2  契约层对**动作族**只执行可判定部分（N 由 `ABSENT` 推出 + 值级禁止），
       U 的限制留给库级门（那里看得到具体 `event_type`）。降级是**机读**的
       （`BACKFILL_CONTRACT_DEFERRED_FAMILIES`），并有"恰好相等"断言守着。
  D-3  **D 槽位的 `Absent` 不算伪造** —— 本 WP 自己纠正过一次过紧判据（门先把它抓出来了）。
       判据的边界是"编造 ≠ 缺信息"：缺信息可以计数，但不是 anti-fabrication 的职责。
  D-4  K-20 门**自证防伪不变量没被放宽**：门内显式断言"旧 blanket 判据已删除" +
       "新判别器（USER/CHARACTER）确实在"，并断言已登记冲突表**非空**（不是一张空豁免表）。
  D-5  契约测试**条数保持 42**（只换理由码 + 加夹具与子断言）⇒ 冻结的 WP1 证据不失真；
       changed assertion 单独记录（F4 第①条）。
  D-6  K-8 的漂移自检在**内存里**改一个字节做负控，**不**去动冻结的 v7 DDL。

Do not modify（后续 WP 只消费）:
  · `MIGRATION_0007` 的任何语句（**指纹已锁**；schema 变更必须新写 v8+）
  · 0001–0006 的任何语句 · ADR-042 正文 / Decision / Revision / Design Freeze 状态
  · 运行时写入路径 / Fact Firewall / extractor / MemoryAuthority / Recall
  · artifacts/{m5.1,m5,m4.5,m4-acceptance,m4.1}/**（还原只按白名单）
  · data/pglite（只有 src/main.ts 能开它；本 WP 连读都只走 cpSync 副本）

```text
Next WP Preconditions（WP3 — Legacy Backfill）:
  1. **你放行**：真实库 / production-copy 的**正式** apply 与 WP3 回填的动手许可（当前 STOP 点）。
  2. 前置缺陷：**K-16 / K-17 / K-18 / K-19 / K-20 / K-8 / K-3 全部 CLOSED**；
     **K-21 仍 OPEN**（它不阻塞 WP3，但会影响 `system_event` 那一个格子的回填口径 —— 建议先裁定）。
  3. WP3 按 `event-family × slot` 的 D/P/U/N 回填，**用 `pnpm m5.1.1:k20:verify` 当反伪造门**
     （它已经具备三段式自测与转录保真检查）。
  4. 证据一律 `artifacts/m5.1.1/`；还原按白名单（**注意 fork 规则**：门重写的历史证据
     若要留结论，先 fork 成本 WP 的文件再还原原路径）。
  5. 交 WP3-Handoff（九字段）后 STOP。
```

---

## 本次**没有**做的事（边界）

```text
✗ 没有开始 WP3（没有回填、没有碰真实库、没有进 Phase 4）
✗ 没有在真实库上 apply v7（Section B 明确是"读/复制边界"；真实库仍是 v6，实测未变）
✗ 没有改 MIGRATION_0007 的任何语句（只**锁定**它的指纹）
✗ 没有替用户裁定 K-21（登记为已登记冲突，不改任何一侧文档）
✗ 没有重写 WP1 / WP2 / WP2.2 的历史证据（fork + 还原）
```
