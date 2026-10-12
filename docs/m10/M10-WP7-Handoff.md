# M10 WP7 交接单（**分两段：A 与 B 均已完成**）

- 日期：2026-09-29
- 工作包：WP7（Context、trace 与开发者只读面）
- 状态：**A = COMPLETE**（门 `m10:context:verify` = **PASS 26/26**）·
  **B = COMPLETE**（门 `m10:observability:verify` = **PASS 19/19**）
- 依据：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) §4.12 · §6 · `D08` · `D22` · `D27` · `D29`
- 前置：[`M10-WP6-Handoff.md`](M10-WP6-Handoff.md)
- 本轮**没有**：打开真实库 · 调模型 · 出网

> ⚠️ **为什么分两段**：出口判据里"off 档 prompt 基线逐字一致 / 有目标时段落正确 / 截断可解释"
> 三条全属**上下文段**（A）；"trace 不含正文 + 开发者面只读 + 执行与聊天相同的遗忘资格"
> 属**可观察面**（B）。两者共用夹具但互不依赖 ⇒ 分段落地让 A 的读数**当场**可信。
> **两段各有各的门与证据，互不借用**。

---

## 1. 交付了什么（A）

| 交付物 | 位置 | 作用 |
|---|---|---|
| 目标上下文段 | [`src/kernel/context/goal-sections.ts`](../../src/kernel/context/goal-sections.ts) | 两个 provider（`goal-fact` 指令 / `goal-state` 数据）· 三条 `D08` 上界 · 渲染与截断 · 遮蔽的第二道口 |
| 预算落成 | [`src/kernel/recall/selector.ts`](../../src/kernel/recall/selector.ts) | `ContextBudget.goalTokens`（缺省 **0**）· `ContextCategory += 'goal_state'` · 进校验列表与账面求和 |
| 门 | [`scripts/m10-context-verify.ts`](../../scripts/m10-context-verify.ts) → `pnpm m10:context:verify` | 26 项（5 组） |
| M5 门同步 | [`scripts/verify-m5-budget.ts`](../../scripts/verify-m5-budget.ts) | 既有预算夹具补 `goalTokens`（**只补字段，断言一字未改**） |
| 改动面映射 | [`scripts/gates/affected-map.ts`](../../scripts/gates/affected-map.ts) | M10 行补 `m10:context:verify` 与 `src/kernel/context/goal-sections.ts` |

### 1.1 门读数（`m10:context:verify` = PASS 26/26）

| 组 | 项数 | 它对应哪条出口判据 |
|---|---|---|
| `O` 关闭档逐字节一致 | 4 | **off 档 prompt 基线不变**：额度 0 连候选都不取 · 无操作产 0 section · **真的过一遍 ContextCompiler 比串** · 基线文件里没有目标块标题 |
| `C` 有目标时段落正确 | 9 | 两条 provider 的 `kind`/`priority`/`droppable` · `D08` 三条上界 · **实测** `D22` 平局顺序 · 事实块只带码 · 渲染非空 |
| `T` 截断可解释 | 4 | 超项数 / 超预算**两个具名原因** · 部分装下时其余照常入模 · 额度只够标题时产 0 且 `budget_exhausted` · 单行钳制可见 |
| `D` `D27` 预算落成 | 6 | 缺省 0 · 账面自洽 · `planContextBudget` 有那一格 · 超配失败关闭 · **新字段真的进了校验** · **无影子默认** |
| `P` 遮蔽先于渲染 | 3 | 被忘掉/来源被撤的目标不进候选（带 `masked` 原因）· **冗余的第二道口真的会拦** · 事实块只报计数 |

### 1.2 相关回归（**含共享文件**）

`src/kernel/recall/selector.ts` 是 **M5 的文件**，因此本轮必须跑 M5 的门（这是"改共享文件"的纪律）：

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm kernel:test` / `pnpm kernel:verify` | 26/0 · 25/0 |
| **`pnpm m5:test`** / **`pnpm m5:verify`** | **30/0 · 26/0**（`selector.ts` 改动后仍绿） |
| **`pnpm m3.5:test`** | **30/0**，含 `FC-T08`「**Prompt 与 M3 逐字节一致**」⇒ off 档不变的**既有锚点**仍然成立 |
| `pnpm m10:*`（另五门） | 48/48 · 25/25 · 40/40 · 37/37 · 43/43 |
| `pnpm gates:verify` | **PASS 48 项 / 0 失败** |
| `pnpm fast:offline` | **34 道 · PASS 34 · FAIL 0** |
| 真实库 | **从未被打开**（本门 `databaseScope = not-applicable`） |

⚠️ **历史证据还原（白名单）**：`m5:test` / `m5:verify` 会重写
`artifacts/m5/wp1-contracts.json` 与 `artifacts/m5/wp2-eligibility.json`。
跑完已按 §7 的白名单纪律**只**还原这两个路径（不是对 `artifacts/` 无差别 `git checkout`）。

### 1.3 证据（**两代**）

| 代 | runId | head | 说明 |
|---|---|---|---|
| 2（**权威**·A 段） | `artifacts/m10/m10-wp7-context-20260929-478b922a42e8-811e/` | `478b922a`（WP7a 文档提交） | 产生它的代码可被 head 定位（代码在其祖提交 `6d087290`） |
| 2（**权威**·B 段） | `artifacts/m10/m10-wp7b-observability-20260929-3174effe4a16-2ffc/` | `3174effe`（WP7b 文档提交） | 代码在其祖提交 `2981d320` |
| 2（**权威**·另六门复跑） | `…-3174effe4a16-` 下的六个 M10 门 | `3174effe` | 48/48 · 25/25 · 40/40 · 37/37 · 43/43 · 26/26 |
| 1（历史·A 段） | `…-a21af1d8f47e-*`（3 个） | `a21af1d8` | **两次 FAIL + 一次 PASS** 的迭代档，见 §3 |
| 1（历史·B 段） | `…-69f3dcdcb511-*`（3 个） | `69f3dcdc` | **两次 FAIL + 一次 PASS** 的迭代档，见 §6.4 |

---

## 2. 两个 section，两种身份（**不得混成一段**）

```text
goal-fact    kind='instruction'  priority = currentInput - 3 (97)  droppable=false   无操作 ⇒ 0 section
goal-state   kind='goals'        priority = SECTION_PRIORITY.goals (45)  droppable=true   额度 0 ⇒ 0 section
```

混成一段的后果：模型无法区分"我**必须**照实说的程序结论"与"我可以参考的当前状态"，
于是要么把状态当指令照抄、要么把指令当数据忽略。**两种都发生过** ——
M4 的 `memory-write-result`（指令、不可裁）与 `memory-recall`（数据、可裁）就是同一个分野。

### 2.1 优先级为什么是 `currentInput - 3` 而不是 `instruction`

事实块必须**紧跟当前输入**（输入 100 > 它 97 > 其余指令 80）：它是"这一轮用户说的话被程序
怎么处理了"的直接答案。排在 80 会落在身份规则之后，而身份规则**不含**任何关于本轮操作的事实。
`droppable: false` 的理由更直接：**被裁掉的恰恰是最需要它的那一轮**（预算最紧时）。

### 2.2 `D22` 的平局是**实测**的，不是推的

```text
SECTION_PRIORITY.goals === 45 === SECTION_PRIORITY.externalEvidence
sortSections 平局时按 a.id < b.id 升序 ⇒ 'external-evidence' < 'goal-…'（e < g）
⇒ 外部证据先被保留（它只在当轮存在，被裁掉等于这一轮搜索白做）
```

门 `C6` **真的跑一遍 `sortSections`** 取顺序，而不是只断言那个不等式 ——
所以以后任何人把这两个 id 改成以 `a`–`f` 开头，那条检查会红。

---

## 3. 门抓出的三处**量具缺陷**（都值得下一个 WP 看）

| 检查 | 缺陷 | 修法 |
|---|---|---|
| `T2` | 我把"超预算"的夹具设得**太紧**：三项全塞不进 ⇒ 走的是 `budget_exhausted` 那条路，于是 `beyond_token_budget` 的**部分装下**形态**根本没被触达** | 改成第一项短、其余长，额度按 `singleItemCost()` 精确卡在"只够一项 + 1" |
| `T5` | 断言"行尾是 `…`"，但钳制只作用于**语句部分**，整行后面还有机器生成的状态后缀 ⇒ 行尾是 `）` | 断言改为"含 `…` + 整行有界 + 后缀完整可见"。**产品是对的**（钳不可控的长文本、保留短的结构后缀），**量具错了** |
| `D6` | 拿正则搜"不得有影子默认"，而**注释里正好引用了这句禁令**（`而不是再写一个 \`?? 400\``）⇒ 把**写着禁令的那一行**判成违规 | 加 `codeLinesOf()`（去行/块注释）后再搜。**这是 WP3 的 `C2`/`C3` 同款坑的第三次出现** |

⇒ **教训（第三次写下）**：凡是要断言"代码里没有 X"，必须先把注释去掉。
光靠"我记得注释里没写"是靠不住的 —— 而**越是把禁令写进注释，越容易被自己的判据抓到**。

另删掉了一条**假检查**：原 `T3` 的断言写成了字面 `true`（"0 个 section ·
`budget_exhausted`" 却压根没读读数）。它是"什么都不检查"的形态，与通过无法区分
（AGENTS.md §6 第 7 条）。现在同一条命题由 `T2`（部分装下）与 `T4`（极限额度）分别真读。

---

## 4. 具名限制（交给 WP11 的 Known-Limitations）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-23` | 目标状态块**只有** `statement` / `status` / `priority` / `nextStep` 四个字段 | 依赖、承诺、来源引用、禁用根都不进 prompt。它们对模型没有可用性（既不能改也不能查），而放进去会让"这一轮做什么"变成"把目标库读一遍" |
| `L-M10-24` | 单行钳制按**字符数**（120）而不是 token | token 级钳制需要量化器在**渲染中途**可用（它现在是渲染后估）。方向保守（钳多不钳少）。真出现超长正文再改 |
| `L-M10-25` | 事实块的 `maskedCount` 只报**数量**，不含内容 | `D29`/§6 的落成。它在 prompt 里明说"连数量也不必主动说" —— 但**模型会不会照做**属 WP10/WP11 的行为读数，本层只能保证**没有给它内容** |

---

## 5. 装配层的接线点（**下一段必须知道**）

```text
① `goalTokens` 由 flag 派生后传进**那一个** `ContextBudget`（`D27`：不得有影子默认）
② 两个 provider 都要挂上：`goal-fact` **在**（否则"她可以否认做过的事"），
   `goal-state` 按额度（0 = 关闭）
③ 候选必须**先**过 `orderGoalsForFocus`（WP5）**再**交给 `goal-state`
   —— 本层**不重排**（重排会让"焦点是哪一个"取决于谁后跑）
④ `withdrawnEventIds` 要从 M9.1 的 D16 端口取**当前**撤销集（本层会**再查一次**，
   因此调用方忘过滤也不会泄漏 —— 但那是第二道口，不是第一道）
```

---

## 6. WP7 **B 段**（trace 五步 + 开发者只读面）—— 已完成

### 6.1 交付

| 交付物 | 位置 | 作用 |
|---|---|---|
| trace 五步 | [`src/kernel/contracts/observability.ts`](../../src/kernel/contracts/observability.ts) | `goal_eligibility` / `goal_proposal` / `goal_validation` / `goal_event` → `'turn'`；`goal_context` → `'context'` |
| 开发者只读面 | [`src/kernel/app/goal/developer-face.ts`](../../src/kernel/app/goal/developer-face.ts) | `DeveloperGoalDto`（遮蔽/可见**判别联合**）· 构造器 · 列表读取 · 能力登记 |
| 门 | [`scripts/m10-observability-verify.ts`](../../scripts/m10-observability-verify.ts) → `pnpm m10:observability:verify` | 19 项（4 组） |

### 6.2 门读数（`m10:observability:verify` = PASS 19/19）

| 组 | 项数 | 判据 |
|---|---|---|
| `T` trace 五步 | 4 | 5/5 登记 · 阶段映射正确 · **没有**新开第 13 个阶段（`OBSERVABILITY_STAGES.length === 12`）· 未登记步骤仍落 `unknown` |
| `R` 读数不含正文 | 4 | 完成判定的结论类型 · 两条上下文 reading 类型 · **遮蔽 DTO 类型** · 目标 trace 属性键过敏感段策略 |
| `F` 只读 | 3 | 导出全是 `build*`/`read*`（无 `write/create/update/delete/cancel/…`）· 能力有非空 authority · **不 import** 放行口/存储/SQL |
| `M` 遗忘资格一致 | 8 | 三例（来源被撤 / 显式忘掉 / 正控）两侧同结论 · 运行时也无内容字段 · 列表 `excluded` 具名 · `truncated` 如实 · **可见分支确实带内容** |

### 6.3 三条判据落在哪里

```text
① trace 五步不新开阶段   → T3 实测 OBSERVABILITY_STAGES.length === 12
② trace 与开发者面不含正文 → R1/R2/R3 从**类型**上读（不是靠约定）；
                             M5 再从**运行时**查一遍遮蔽 DTO 的字段集
③ 与聊天同一份遗忘资格   → M1–M4：三例都调 goalContentMustBeMasked()，
                             **两侧同结论**。构造器不重新实现判定
                          → M8 是它的正控："永不泄漏"不能靠"永不显示"通过
```

### 6.4 本轮抓到的一个**真问题**（不是量具缺陷）

我最初声明的 trace 属性键里有一个 `goal.focus_row_key`。门 `R4` 拿既有的
`SENSITIVE_ATTRIBUTE_KEY_SEGMENTS`（含 `'key'`）去查 ⇒ **命中**。

⇒ 那条属性**根本发不出去**（会被既有策略拒掉）。改名为 `goal.focus_row_id`
（`id` 是既有策略**刻意保留**的合法段 —— 见该表上方"为什么不含 `memory` / `user`"的注释）。

**价值在于顺序**：先**声明**键名、再让门拿**既有策略**检查它，于是这个问题在**接线之前**
就被抓到了。若等接线后再发现，症状会是"trace 里少了一列"，而那是极难归因的形态。

另有一处量具缺陷：`M6` 忘了把 `status` 过滤参数传进列表读取 ⇒ **那条分支压根没被触达**
（返 2 项、`excluded` 只有 1 项）。已修。

### 6.5 相关回归（B 段）

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm kernel:test` / `pnpm kernel:verify` | 26/0 · 25/0 |
| **`pnpm m5.1:observability:verify`** | **27/0**（含 `AT4.5 LEAKAGE = 0`）—— 改的是它的文件，必跑 |
| `pnpm m10:*`（另六门） | 48/48 · 25/25 · 40/40 · 37/37 · 43/43 · 26/26 |
| `pnpm gates:verify` / `pnpm fast:offline` | 48 项 0 失败 · 34/34 PASS |

⚠️ 历史证据还原（白名单）：`m5.1:observability:verify` 会重写
`artifacts/m5.1/observability-evidence.json` 与 `leakage-evidence.json` ⇒ 跑完**只**还原这两个路径。

### 6.6 具名限制（B 段追加）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-26` | 遮蔽 DTO 仍然暴露 `status` / `cancelReason` / `revision` / 来源事件 id / 三类依赖**计数** | 这些是**结构性**字段，不是"被忘掉的取值"。`statement` 与 `nextStep`（从用户原话来的）才是内容，它们只在可见分支。若将来判定"连状态也算泄漏"，改的是这一个类型 |
| `L-M10-27` | 开发者面**没有**分页游标，只有 `limit` + `truncated` | 与 `executions` 的既有形状一致；目标域的量级（WP9 才测）不支持游标。`truncated` 如实报出（不静默截断） |
| `L-M10-28` | 五个 trace 步骤的**载荷形状**尚未接线（本步只登记阶段映射与"不许带正文"的类型判据） | 真正的发射点在装配层（与 WP8 的 e2e 一起验）。本步能保证的是"登记正确 + 读数类型里没有正文" |

---

## 7. 下一步

**WP8：量具自证三段式 + 端到端**（含 `U-04` 的**网关级**两窗口探针：
需要一个可注入 provider 的完整一轮才能造出"落盘成功 / 落盘失败"两种形状）。
