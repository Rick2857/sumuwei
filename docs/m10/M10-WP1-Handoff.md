# M10 WP1 交接单

- 日期：2026-09-29
- 工作包：WP1（ADR、验收契约与判分规范）
- 状态：**COMPLETE** —— 四类语义（授权 / 失效传播 / 完成 / 遗忘）**全部冻结**；
  13 项开放项**全部**为非语义类（见 [`M10-Unresolved-Decisions.md`](M10-Unresolved-Decisions.md) §0）
- 交付：
  - [`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md)（`ACCEPTED / DESIGN FROZEN`）
  - [`M10-Acceptance-Contract.md`](M10-Acceptance-Contract.md)（`DESIGN FROZEN`）
  - [`M10-Unresolved-Decisions.md`](M10-Unresolved-Decisions.md)
  - 本交接单
- 前置：[`M10-Baseline-Report.md`](M10-Baseline-Report.md) + [`M10-WP0-Handoff.md`](M10-WP0-Handoff.md)（WP0）
- 本轮**没有**：改任何源码 · 改任何历史文档或证据 · 打开真实库 · 调模型 · 出网

---

## 1. 冻结的分工（三份文档各管什么）

```text
ADR-076                  冻结**语义**：29 条决策（D01…D20 计划 + D21…D29 WP0 驱动）
                         + 字段/事件/转换表/拒绝码/时间/多目标/崩溃窗口/隐私
M10-Acceptance-Contract  冻结**判据**：维度与通过条件 + 阈值 + 49 项场景矩阵（计划 48 + G49）+ 版本参数表
                         + 门清单 + 量具纪律 + 语料分层 + 人审题目 + 真模型策略
M10-Unresolved-Decisions 只登记**不影响**授权/失效/完成/遗忘的 13 项开放项 + 12 项已关闭留档
```

**变更纪律**：改语义 ⇒ 改 ADR-076（+ 前后读数）；改判据 / 阈值 / 场景含义 ⇒ 改契约；
新发现一个**语义**级未决项 ⇒ **不是**登记到未决项，而是回去改 ADR。

---

## 2. 给 WP2（真实来源引用与只读输入）的明确任务

WP2 是 D25 的落地点。**必须**做到：

| # | 要求 | 判据 |
|---|---|---|
| 1 | 新增生产 Goal 输入端口（`src/kernel/app/goal/inputs.ts` 等最小模块） | 纯函数为主；端口只给形状 |
| 2 | `MemoryReference` 的 `sourceRevision` **取当前记录**的真实值 | `G17`：`rev1 → rev2` 后被正确取得；旧引用复核为 `revision_changed` |
| 3 | `referenceRecheck()` 的六种 `reason` 全部可达 | 读不到 ⇒ `unavailable`（**不是** usable、**不是** `root_missing`） |
| 4 | `BeliefReference` 携带 `projectionRevision` + `epistemicKind` + `supportLevel` | `G20`：标签随行、**不生授权** |
| 5 | 复用 `recheckBeliefDependencies()` + `applyInvalidationOverlay()`，**不得**只调 `listActiveBeliefs()` | `G19`：写侧未收敛时读侧仍遮蔽 |
| 6 | 身份隔离（owner / subject），跨角色一律拒 | `goal_dependency_foreign` |
| 7 | **不创建**任何自动承诺 | WP2 输出里没有"承诺"这个出口 |
| 8 | 保留 M9.5 两个 fixture 的**无写入**契约（不改写它们） | fixture 文件逐字不变；生产走新模块 |

**门**：`m10:inputs:verify`（新增）+ `m9.5:compat:verify`（回归）。
**交付**：最小模块 + 引用复核门 + `M10-WP2-Handoff.md`。

---

## 3. 给 WP3（纯内核与持久化）的明确任务

| # | 要求 | 依据 |
|---|---|---|
| 1 | `goalId` / `commitmentId` 按 D05 / §4.1 / §4.2 的**材料清单**派生 | `G02`（同事件重复 ⇒ 幂等）+ `G14`（取消后同内容 ⇒ 新身份） |
| 2 | `GoalOperation` / `CommitmentOperation` **领域自持**，**不**改 `ProposalOperation` | D21 |
| 3 | 13 个事件类型 + 独立工厂 + payload 上限（§4.3） | 登记表；`scope` 恒 `CHARACTER_INTERNAL` |
| 4 | `goal-fold@1` reducer **纯函数**；apply 与 rebuild **同一条折叠核心** | `G45`：rebuild 与增量字段级一致 |
| 5 | 投影行 `goal:<goalId>`，**一族多行**；Commitment 住在 Goal 行的 `state.commitment` | D03 / D24 |
| 6 | **零迁移**（除非 D24 第 4 条被 WP9 触发） | D15 |
| 7 | 唯一放行口 `validateGoalProposal()`；拒绝码用 §4.8 的闭集 | 非法边拒绝且**零事件** |
| 8 | `expectedRevision` 乐观锁；关联操作**原子提交** | `G11` / `G16` |
| 9 | `unitOperationOf()` 形状照抄 belief（每事件类型一个 unit 串） | D21 / D26 |
| 10 | ⚠️ `ContextBudget` 追加 `goalTokens` 时，**展开 `DEFAULT_CONTEXT_BUDGET`** | D27 第 4 条：不得有影子默认值 |

**门**：`m10:test`（新增）+ `kernel:test` + `kernel:verify` + `m10:lifecycle:verify`（部分）。
**交付**：契约 / policy / reducer / store 装配 + 状态转换门 + 事务故障门 + rebuild 对账 + `M10-WP3-Handoff.md`。
**同时**：追加 `scripts/gates/affected-map.ts` 的 M10 行（`U-08`，**必须在 `m10:test` 落地之后**）。

---

## 4. 给 WP4–WP7 的前置约束（简表）

| WP | 冻结约束（不可协商） |
|---|---|
| **WP4** | 先做 `.env.test` 端点预检（`U-02`）**再**跑任何真模型门；语料按契约 §8 的六层与拆分纪律（`U-10`）；粗筛若加必须证明冻结正例**无漏检**；非法输出记 `invalid` **不**当 `none`；每合格用户轮 ≤1 次理解调用、总期限 8000ms、**零隐式重试** |
| **WP5** | 三类依赖的处置逐条落 §4.6；**同轮顺序**（先处理已生效的记忆/归因控制，再读 Goal 依据）；遗忘与取消按 §5 的五条；`forbiddenSourceEventIds` 复用 M9 的 B28 机制 |
| **WP6** | 三种达成依据**互不替代**（§4.5）；`conversation_output` 必须绑定**已落库**的 assistant event；两个崩溃窗口都要有恢复（§4.11）；补记走 D26 的事件身份，**不**依赖内容去重；做 Q4 的两种形状探针（`U-04`） |
| **WP7** | section id 以 `goal` 开头（D22）；`goalTokens` 缺省 0（D27）；事实块 `kind='instruction'` / `priority=currentInput-3` / `droppable:false` / 无事发生产 0 个（D29）；**计数守恒**必须可机器校验；trace 不含正文（§6） |

---

## 5. 实现时最容易做错的十条（把 ADR 的裁决变成可执行提醒）

```text
① 用内容哈希当 goalId   ⇒ 取消后同内容永远建不起来（D05 的两条反例必须同时过）
② 把 ProposalOperation 扩了 ⇒ 影响所有认知模块的幂等键语义（D21；既有裁定明确禁止）
③ 只调 listActiveBeliefs() 当资格 ⇒ 读到 active 就当成"来源仍有效"（WP0 的 Q2 缺口）
④ recheck 读不到的时候当"没问题" ⇒ 必须失败关闭为 unavailable（D25）
⑤ 让模型提供 goalId / eventId / 权限 / 完成证据 ID ⇒ 它只能从程序给的候选集里选（§7.2）
⑥ 用 assistant 自述当兑现证据 ⇒ 只有 user_report / 已落库产物结构检查 / 真实 ActionResult（§4.5）
⑦ 依赖内容去重做幂等补记 ⇒ WP0 的 E4b 证明内容去重会先命中（D26）
⑧ 把 dueAt 映射成定时器 ⇒ 时间只用于读取时判断（D14）
⑨ 整项目标正文留在上下文里而只删 dependency ID ⇒ 遗忘泄漏的新通道（§5 第 1 条 + D10）
⑩ 给 goals 块 `budgetGroup: 'status'` ⇒ 它会逃脱共享预算裁剪（D27 的反面理由）
```

---

## 6. 命令与证据

```bash
# WP1 不新增命令（纯文档冻结）。既有：
pnpm typecheck                 # 仍须 EXIT 0
pnpm m10:baseline              # WP0 基线（before / after）
pnpm m10:wp0:admission         # WP0 六问准入审计
pnpm fast:offline              # 既有 34 道离线门（非发布档）

# WP1 冻结后，WP2 起按契约 §5 逐个落地；契约 §6 列了必跑的既有门
```

| 读数 | 值 |
|---|---|
| WP1 出口条件 | **满足**（四类语义全冻结；13 项开放项全为非语义） |
| 本轮改动的源码 | **无**（`git status` 只有新增的 4 份文档） |
| 真实库 | **未打开** |
| 新增命令 | **无**（WP1 是文档冻结工作包） |

---

## 7. 下一步入口

**WP2：真实来源引用与只读输入。**

```text
输入  ADR-076 D25 + §4.1/§4.2 的字段闭集 + 契约 §3 的 G17–G24
载体  src/kernel/app/goal/inputs.ts（最小模块）+ 引用复核门
出口  rev2 被正确取得；旧引用 / 被撤回根 / 错 owner·subject 被拒；
      lookup 失败如实 unavailable；缓存不能绕过新更正；
      保持原两个 fixture 的无写入契约
门    m10:inputs:verify（新增）+ m9.5:compat:verify（回归）
```

**不要**在 WP2 里顺手做 WP3 的内核或 WP4 的语义理解 ——
契约 §5 的"落地 WP"列就是给你们看的边界。
