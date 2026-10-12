# S8 验收报告（Acceptance Report）

状态：**事实汇总**（判定在 [Gate-Decision](S8-Gate-Decision.md)，局限在 [Known-Limitations](S8-Known-Limitations.md)）。
日期：2026-10-03。工作包：`POSTLV2-S8`。设计载体：[ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md)（`ACCEPTED / DESIGN FROZEN`）。

> 本报告只写**发生了什么**。它不判定、不主张能力通过、不合成总分。

---

## 1. 工程交付（WP0–WP6）

| WP | 交付 | 门 | measured_count |
|---|---|---|---|
| WP0 | 基线：HEAD / 27 个相关源文件摘要 / 迁移 v11 / 开关缺省 / 缺口定位 / 上游四组件许可与复用决定表 / 混合树归属 | `postlv2:s8:baseline` | 121 |
| WP1 | [ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md)（D01–D16 + §10.2 修订表 `R-1`…`R-11`）· [验收契约](S8-Acceptance-Contract.md)（S8-A01…A50）· [测量计划](S8-Measurement-Plan.md)（M1–M11 三段式 · S8-C01…C14 覆盖表 · 请求计划） | — | — |
| WP2 | 迁移 **v12**（`storyline_commits` + `storyline_observations`）· 纯契约 `story-ledger.ts` / 端口 / SQL 适配（含完整性探针）/ 提交服务 | `postlv2:s8:store:verify` | 86 |
| WP3 | `EvidenceKind += story_event` · `LineageHandleKind += story_event` · `LineageSourceClass += story_experience` · 因果键去重（`D05`/`R-4`）· `findStoryEvents` 只读面 · 提案 `sourceStoryRefs` · 资格读取面 | `contracts:verify` 40 / `roots:verify` 29 | 69 |
| WP4 | 故事规则表 `story-appraisal@1`（6 条）+ `story-relationship@1`（5 条）· `STORY_DERIVED` origin kind · 两个放行口的选表分支 | `postlv2:s8:state:verify` | 26 |
| WP5 | `story_outcome` 触发 · `buildReflectionInput.storyOutcomes` · 有限采纳 · 实际入模（300 token 有 section / 0 token 无） | `postlv2:s8:reflection:verify` | 26 |
| WP6 | `STORY_EXPERIENCE_RETRACTED` · 读时撤回传播（`R-11`）· 至多一次 · rebuild 不复活 | `postlv2:s8:lifecycle:verify` | 24 |

**共 7 道门全 PASS**，356 项断言之和。全部**离线**（除 WP7 的真模型批次）；`data/pglite` 全程未被打开。

## 2. 真模型测量（WP7）

| 批次 | 请求 | 结果 |
|---|---:|---|
| 开发探针（第一次） | 12 | 全 12 次被**探针自身读法缺陷**误读为 `draft_invalid_json`（原档保留） |
| 开发探针（修正后） | 12 | **PASS**（62）· 12/12 可解析 · 12/12 引用不越权 · 0 传输失败 · p95 5962ms |
| 正式语义第一批 | 144 | **FAIL**（`S8-A38` 0.3402）—— 根因 = 产品缺陷（窗口正文是占位符） |
| 正式语义第二批 | 144 | **FAIL**（`S8-A38` 0.7675 · `S8-A39` 0.7097 · `S8-A41` 0.9097） |
| 判据 v2 重算 | **0** | `S8-A39` **1.0000** ✅ · `S8-A41` **0.9562** ✅ · `S8-A38` 0.7675 ❌（**同口径，未切**） |
| 短链 16 / 行为 171 / 长轨迹 66 | 0 | **未获批预算，未跑** |
| **合计** | **312 / 421** | 见 [Gate-Decision](S8-Gate-Decision.md) §2 的预算账 |

## 3. 真实库纪律

```text
全部离线门与真模型批次都在 `isolateDatabase()` 的**一次性沙箱**里（%TEMP%）
`data/pglite` **从未被打开**；门只记它的 mtime（`data/**` 被 gitignore ⇒ 不能用 git 证明）
真实库迁移（若需要）属 WP9 的**独立授权**
```

## 4. 工程过程中发现并修掉的缺陷（**11 条**，全部留档）

| # | 缺陷 | 载体 |
|---|---|---|
| 1 | `world-machine.ts` 只按**迁移**取可见事件（内容包/`.ink`/`commitEnding` 都是**节点**级）⇒ 她只经历序章那一条 | ADR-093 `R-5` |
| 2 | `FC-T04` 伪装通道判据用**子串**匹配 ⇒ `storyline_observations` 被误判 | WP2 交接单 §3.2 |
| 3 | 故事关系增量**超出既有单事件上限**（0.06 > 0.05/0.03）⇒ 后门 | ADR-093 `R-8` |
| 4 | 放行口版本链缺故事分支 ⇒ 合法提案被判 `affect_rule_version_mismatch` | WP4 交接单 §2.1 |
| 5 | 根合并时 **`id` 取错侧** ⇒ 根 id 是提交身份、M11 只读面查不到 ⇒ 故事→反思整段不通 | ADR-093 `R-10` |
| 6 | 撤回挂在故事提交上、消费端按对话事件重算 ⇒ **"撤回了却还在入模"** | ADR-093 `R-11` |
| 7 | `buildReflectionInput` 只有故事结果时**提前返回 `undefined`** | WP5 交接单 §3 |
| 8 | 故事窗口正文是**占位符**（违反 `D10`）⇒ 语义批次 F1 0.34 | WP7 交接单 §0.3 |
| 9 | **四道门跑完不退出**（PGlite 句柄吊住事件循环）⇒ 每轮留孤儿进程 | 本轮 `L-S8-18` |
| 10 | 开发探针**读法缺陷**（已解析对象喂给字符串解析器） | 本轮 `L-S8-19` |
| 11 | 判据 v1 把**程序的职责**（作用域闸）扣在模型头上 + 合规分母含超时行 | 测量计划 §6.1 |

## 5. 回归

| 项 | 读数 |
|---|---|
| `pnpm typecheck` | **EXIT 0** |
| `pnpm m4.5:ci`（完整离线纪律） | **EXIT 0** |
| S8 相关既有门（M11 / M11.1 / M7 / M8 / M8.5 / M3.5 / M4 / M4.5 / kernel） | 逐批 **EXIT 0**（明细见各 WP 交接单） |
| 三处**冻结门判据**的修正 | `m8-wp2-contracts` P15（6 值）· `m7-wp2-contracts` P11（4 值）· `m11-inputs-verify` F3（两条触发来源）—— 均**只改词表/来源数，不放宽拒绝** |

## 6. 本报告**不**主张什么

见 [Gate-Decision](S8-Gate-Decision.md) §3 与 [Known-Limitations](S8-Known-Limitations.md)。
一句话：**工程与量具已接通；语义 4/5（`S8-A38` 如实 FAIL）；行为未测；生产未激活；首次使用未观察。**
