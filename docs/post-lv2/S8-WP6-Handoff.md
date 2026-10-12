# S8 · WP6 交接单（失效 · 重复 · 恢复）

状态：**实现完成 · 门 PASS**。日期：2026-10-03。工作包：`POSTLV2-S8`。
载体：[ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md) `D12`/`D13`（+ §10.2 `R-11`）· [验收契约](S8-Acceptance-Contract.md)。

| 项目 | 读数 |
|---|---|
| 门 | `pnpm postlv2:s8:lifecycle:verify` |
| 判定 | **PASS** · `measured_count = 24` · L1–L6 |
| 机器证据 | `artifacts/post-lv2/<runId>/s8-lifecycle-verify.json` |
| 模型调用 / 隔离 | 0 真实模型调用（离线固定 provider）；`isolateDatabase()` 一次性沙箱；`data/pglite` 从未被打开 |

---

## 1. 交付物

| 文件 | 是什么 |
|---|---|
| `src/kernel/contracts/story-events.ts`（新） | `STORY_EXPERIENCE_RETRACTED` 的 payload 契约 + 结构校验 + `withdrawnStoryCommitIdsOf()`（坏行**抛错**，不静默跳过） |
| `src/kernel/contracts/domain-event.ts` | 新增故事域工厂 `createStoryDomainEventRegistry()` 并接入 `createFullDomainEventRegistry()` |
| `src/infrastructure/persistence/reflection-lineage-read.ts` | `findStoryEvents` 每次取数读**撤回集合**（`withdrawn` 不再恒 `false`）；新增 `withdrawnStoryAnchorIds()`（撤回集合 → 触发对话事件 id） |
| `src/infrastructure/persistence/reflection-source-read.ts` | 消费端资格把"背后故事经历被撤回"判为 `source_retracted`（`R-11`） |
| `scripts/postlv2-s8-lifecycle-verify.ts`（新） | 门本体（L1–L6） |
| `package.json` | 注册 `postlv2:s8:lifecycle:verify` |

## 2. 退出条件逐条对账（计划书 WP6）

| 计划书退出条件 | 机器判据 | 读数 |
|---|---|---|
| **失效后**旧反思/槽位**不再入模** | `L3` | 撤回后 `adaptive-self` section = **0**；可用状态里不再有 enhanced（该槽整条从可用集合里消失） |
| replay / 换 run / 重启**不复活** | `L2` `L4` | 被撤回的提交单独解析 ⇒ `story_root_withdrawn`；混合集合里也被剔除；**投影 rebuild 之后**仍不入模 |
| 同一提交对各消费者**至多一次**已提交影响 | `L5` | 同一窗口重放 ⇒ **零**新增领域事件（`eventsWritten = 0`，保持终态、不再次请求模型） |
| 撤回**不**物理删除原始世界历史 | `L6` | 撤回前后 `storyline_commits` / `storyline_observations` 行数**逐字相同**（4→4 / 4→4） |
| （正控：失效**前**链路是通的） | `L1` | 撤回集合为空时 3 根可用、反思 accepted、**实际入模有 section**（否则 L3 的"0"没有意义） |
| （非零分母） | 全部 | `measured_count = 24` |

## 3. 本 WP 发现并修掉的缺陷（`R-11`，最实质的一处）

**"撤回了却还在用"**：撤回挂在**故事提交**上，而采纳后的槽位里存的根是**对话事件 id**
（`R-10` 的直接后果）⇒ 消费端（`readUsableAdaptiveSelfStates` → `readReflectionSourceSnapshot`）
重算资格时只看那些对话事件，它们**完全健康** ⇒ 撤回**看不见**。

抓到它的方式和 WP5 同款：门里**同时**问两个面 —— 追根器（已报 `story_root_withdrawn`）
与注入端（仍有 section）。两个读数一对，断点立刻落在**消费端的键不一致**上。

补法：`withdrawnStoryAnchorIds()` 把撤回集合经 `anchor_conversation_event_id` 映射成
消费端能看见的那把键，消费端据此判 `source_retracted`。
**没有撤回事件时集合为空 ⇒ 旧行为逐字不变**（M11.1 各门不受影响）。

## 4. 本 WP **不**覆盖的面（不许读成已实现）

| 项 | 说明 |
|---|---|
| **独立故事水位**（每个消费者一条） | **未接线**。本门证的是"同一窗口重放零新增"，**不是**"多消费者各自水位推进"。`D13` 的水位部分仍未落地 |
| **迟到结果覆盖新 revision** | **未做**（需要 revision 竞赛夹具）；`S8-A35` 仍只有 WP2 的 stale-revision 拒收兜着 |
| **真进程重启** | 账本侧由 WP2 的 store 门覆盖；投影侧由本门的 rebuild 覆盖；**两者合一的真重启**未做 |
| 生产装配（`CHARACTER_STORY_COGNITION_ENABLED`） | **未落地**（WP8）；今天没有任何生产路径会消费故事经历 |
| 真模型语义评测与 S8-A/B/C 行为对照 | **WP7**（至今**零**真实模型调用） |

`postlv2:s8:lifecycle:verify` 的证据里有 `notCovered` 数组把上面这些**逐条写明**。

## 5. 本交接单**不**主张什么

- **不**主张 `D13` 已完成：水位那半边未接线（见 §4）。
- **不**主张撤回是"用户能按下按钮"的功能：本 WP 只保证**事件一旦写下，读时到处都认**。
- **不**主张真实行为已经改变（那是 WP7 的事）。

⏩ 后续修订（2026-10-04，只追加，不改上文）：本交接单 §4 的四处读数**均已过时**：
- 原 `:54`「独立故事水位 … **未接线**」⇒ 已接线（迁移 v13 + 端口 + SQL 适配；`postlv2:s8:lifecycle:verify` PASS 33 的 `L7`/`L8`/`L9`）。
- 原 `:57`「生产装配 … **未落地**」⇒ 已落地（`src/main.ts:1991-2002`；`S8-Activation-Record.md` §7 的 `L-S8-12`/`L-S8-16` 行）。
- 原 `:58`「至今**零**真实模型调用」⇒ 已过时：正式语义批次真模型调用 **312** 次（见 `S8-Gate-Decision.md:66` 的「已用合计 312」；`S8-WP7-Handoff.md` §3）。
- 原 `:64`「**不**主张 `D13` 已完成」⇒ 机制面 + 回路面已满足（`L7`/`L8`/`L9` + `N7`/`N8`），见 `S8-Activation-Record.md` §7。
⚠️ 另：「生产里没有**入口调用者**」是另一回事（`L-S8-30` / `S8-Consumption-Entry-Gap.md`）。原判定保留。
