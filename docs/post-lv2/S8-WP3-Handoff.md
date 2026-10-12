# S8 · WP3 交接单（持久根、提案引用与读取）

状态：**实现完成 · 两道门 PASS**。日期：2026-10-03。工作包：`POSTLV2-S8`。
载体：[ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md) `D02`/`D03`/`D04`/`D05`/`D06`/`D14` · [验收契约](S8-Acceptance-Contract.md)。

| 门 | 判定 |
|---|---|
| `pnpm postlv2:s8:contracts:verify` | **PASS** · `measured_count = 40` · C1–C8 |
| `pnpm postlv2:s8:roots:verify` | **PASS** · `measured_count = 29` · W1–W10 |

机器证据：`artifacts/post-lv2/<runId>/s8-{contracts,roots}-verify.json`（按 `source.head` 归属）。

---

## 1. 交付物

| 文件 | 改了什么 |
|---|---|
| `src/kernel/contracts/memory.ts` | `EvidenceKind` **追加** `story_event`（旧四类逐字不变） |
| `src/kernel/contracts/source-authority.ts` | 来源 id 的**语法**上移到这里（`makeStorySourceId` / `parseStorySourceId` / `isStorySourceId` / `StorySourceIdParts`）；新增 `StorySourceRef` 与 `storySourceRefOf`（**读回自检**） |
| `src/kernel/contracts/reflection-lineage.ts` | `LineageHandleKind` 追加 `story_event` + 登记常量 `LINEAGE_HANDLE_KINDS`；`LineageSourceClass` 追加 `story_experience`；`LineageRoot` 增加 `causalKey`/`sessionKey`；`LineageStoryEventReading`；`LineageMemoryReading.evidenceStoryEventIds`；`LineageDomainEventReading.sourceStoryEventIds`；`LineageLookup.findStoryEvents`（**可选**）；五个具名拒收理由；`LineageResolution.storyRootCount` |
| `src/kernel/contracts/reflection.ts` | `ReflectionHandle.kind` 改为引用 `LineageHandleKind`（消除两处定义漂移） |
| `src/kernel/contracts/proposal.ts` | `DomainProposal`/`NewProposal` 增加 `sourceStoryRefs`（可选、只追加）；工厂里**逐条读回自检** |
| `src/kernel/app/reflection/lineage.ts` | 故事提交作为根（五道具名闸）；`addRoot` **按 `causalKey` 去重**；会话数按 `sessionKey` 去重；故事节点的 missing ⇒ `story_root_unconfirmed`（不是 `node_missing`） |
| `src/infrastructure/persistence/reflection-lineage-read.ts` | `findStoryEvents` 实现：观测 id **或**提交 id 都解析到同一条提交；按 `(storyId, runId, eventId)` 的**第二跳**区分"错版本"与"不存在"；`findMemories` 证据按 kind 分流；域事件 payload 的 `sourceStoryRefs` 进读数 |
| `src/infrastructure/persistence/qualification-read.ts` | `rootReadingsByMemory` 扩到 `evidence_kind in ('conversation_event','story_event')`；故事根一律映射 `undefined` ⇒ **失败关闭**（故事来源不能支持用户事实） |

## 2. 退出条件逐条对账（计划书 WP3）

| 计划书退出条件 | 机器判据 | 读数 |
|---|---|---|
| 至少一个有效故事根能从**真实落盘提交**解析 | `W1` | 真实账本 3 条 `user_choice` 提交跨 **2 个真实会话** ⇒ 根 3 / 会话 2 / 故事根 3 / `usable` |
| 隐藏、错版本、跨 run、跨用户、不存在、已撤回根均**失败关闭** | `W4` `W5` `W6` `W7` | 不存在 ⇒ `story_root_unconfirmed`；无可见条目 ⇒ `story_root_invisible`；`system` ⇒ `story_root_not_interactive`；错版本 ⇒ `story_root_version_mismatch`（**与"不存在"具名区分**，`S8-A10`） |
| 同一次选择的**全部衍生引用只计一个独立根** | `W2` `W3` `W10` | 3 个观测 ⇒ 1 根；对话 handle + 故事 handle ⇒ 1 根（`S8-C02`）；域事件派生 ⇒ 与直接引用同 1 根 |
| 既有**纯对话**样例结果保持 | `W9` | 纯对话 handle ⇒ 1 根 / 1 会话 / 来源类仍是 `user_statement`（`S8-A18`） |
| （防 NOT-WIRED） | `W8` | 真实只读面**确实**实现了可选端口 `findStoryEvents` |
| （非零分母） | 全部 | `measured_count = 29`（roots）/ `40`（contracts） |

## 3. 本 WP 的设计更正（`R-7`，登记进 ADR-093 §10.2）

`addRoot` 的合并规则**第一版写反了**：它让"对话来源类"覆盖"故事类"，于是
**每一个**故事根在与自己的 anchor 合并后都变成 `user_statement` ⇒
`story_experience` 这个新来源类**永远不可达**（一个死词汇值），
而 `S8-C02` 的原话是"因果身份合并计数；**来源 kind 保持各自身份**"。

改为**故事侧优先**：
- 合并成 1 个根（计数不变），但标签保留 `story_experience`；
- 方向也是**失败关闭**的 —— 把"她经历的"标成"用户说的"是**升级**来源，方向正好反了；
- 旧对话链没有故事路径 ⇒ 标签与计数**逐字不变**（`W9` 就是这条回归）。

## 4. 残余 / 未做

| ID | 内容 |
|---|---|
| `L-S8-06` | 退出路径（`RUN_EXITED`）的可见事件：纯状态机不带出 `ending_exited_by_user`（ADR-093 `R-6`）；本 WP 把它**变成可判定的拒收**（`story_root_invisible`），但没有改退出的节点语义 |
| `L-S8-09` | `withdrawn` **恒为 `false`** —— 读时撤回属 WP6（`D12`）。`s8-roots-verify.json` 有 `withdrawalReadEnabled: false` 如实记录，**不得**读成已实现 |
| `L-S8-10` | `cross-run` / `cross-user` 的根目前由"账本里没有这条引用"（`story_root_unconfirmed`）兜住，而**不是**独立码；若要独立码需账本带归属列（WP4 的参与者绑定会给） |
| `L-S8-11` | `findStoryEvents` 是**可选**端口（为兼容 S8 之前的实现）⇒ 只有 `W8` 这条正控守着"真实实现提供了它" |

## 5. 本交接单**不**主张什么

- **不**主张 S8 已可用：**故事经历仍然进不了任何认知域** —— Affect / Relationship / Reflection
  的评估器、validator、调度**都还没接**（WP4/WP5）。
- **不**主张 `qualification-read` 的改变会让故事根"变成已确立来源"：它**恰好相反**
  —— 故事根一律 `undefined` ⇒ `UNCONFIRMED_ORIGIN`（失败关闭）。变的只是**根数**可读了。
- **不**主张跨 run / 跨用户已被**独立**拒收（见 `L-S8-10`）。
- **不**主张 `withdrawn` 已实现（见 `L-S8-09`）。

⏩ 后续修订（2026-10-04）：`L-S8-09` 已关闭 —— 撤回的用户入口已实现并验证：`a56af48e` + `83c15094` + `576ed4f7`；入口 `pnpm story:withdraw`（`package.json`、`src/main.ts:4353`）；门 `postlv2:s8:withdraw:verify` PASS 13。原判定保留。

