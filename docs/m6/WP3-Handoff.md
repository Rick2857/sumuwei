# M6 · WP3 Handoff（接线 + 只读来源读取面）

> 分支 `feature/m6-lv1-hardening` · 被测代码提交 `4198d18` · 证据 `artifacts/m6/m6-wp3-20260921-4198d18d5092/wiring.json`（**27/27**）与 `artifacts/m6/m6-wp3-reader-20260921-4198d18d5092/reader.json`（**25/25**）
> 设计权威：ADR-050（`ACCEPTED / DESIGN FROZEN`，§10 裁定记录）
> **状态：WP3 三部分全部完成。** 摘要**已端到端可用**（真实库 → 读取面 → 选择器 → 轮次级端口 → 网关 → packet），
> 但**生产上未启用**：`recallBudget.rollupTokens` 缺省 **0** ⇒ 不读库、不产 section、行为零变化（激活属独立裁定）。

---

## 1. 为什么 WP3 要分两部分（不是为赶时间拆包）

计划书 §5 允许把一个 WP 拆成"能独立评审的子包"。这里的分界是**风险面**，不是工作量：

| 部分 | 内容 | 为什么必须分开 |
|---|---|---|
| **WP3-1（§2）** | 修正 WP2 遗留的**契约缺陷**：把"消费受信读数"改回唯一适配边界产出的那一份 | 它修的是**已经存在的红灯**（`m5.1.1:k17:verify`），且必须先落地，否则后面所有证据都建立在一个违反 R-59 的契约上 |
| **WP3-2（§8）** | provider + 端口形状 + `turn-gateway` 接线 + 接线门 | 它要动 **prompt 组装路径**，必须跑 `m3.5:test` + 三套 eval，并新增 R-2 的逐字节负控 |
| **WP3-3（§9）** | 持久层只读来源查询（`rollup-source-store.ts`）+ 在**合成隔离库**上串通真实 ingress 与真实记忆管线 + `main.ts` 装配 | 它碰数据库与真实装配；必须用 `isolateDatabase()`，且要跑 M5 那几条会写 `artifacts/m5/**` 的门（白名单还原成本） |

---

## 2. 本部分做了什么

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/kernel/contracts/rollup.ts` | `RollupSourceFacts` 由「原始归因三元组」改为「**一份已派生的来源读数**」；`classifyRollupSource` 只调 `sourceQualificationOf(facts.<读数>)` | 原来的形状在契约里**自己派生**读数 ⇒ `src/**` 有 **2** 处派生点 ⇒ 违反用户裁定 `R-59`，`m5.1.1:phase4a:verify` 与 `m5.1.1:k17:verify` 会红 |
| `scripts/verify-m6-wp2-rollup.ts` | 夹具改为**经生产用的唯一适配边界函数**取得读数（不手写读数对象）；N-5…N-8 的四类非法来源按新形状重建 | 同上；且手写读数对象在类型上就构造不出来（必需字段在 `scripts/**` 里 0 处） |
| `scripts/verify-m5.1.1-k17-consumer-impact.ts` | 把本门登记进**消费者分类表**（`klass: 'D'`，写明"只做只读断言、不读库、不跑模型、唯一写入面是 `artifacts/m6/...`"） | k17 的判据是"每个命中 Axis B 名字的文件都必须被人工核对过"——**新文件即红，必须显式登记**（与 `qualification-read.ts` 在 phase4a/k17 里的先例同型） |

**关键细节（值得写下来，因为下一个人一定会踩）**：`phase4a` 的针扫的是**原文**，**不做注释剥离**。
第一版修正时我把针的字面量写进了**注释**（`trusted….（派生函数名）({` 与两个字段名），结果 `src` 的调用计数从 1 变成 **2** ⇒ 门照旧红。
因此本契约的注释里连针的名字都不能写 —— 改用**描述**。这一条已经写进 `contracts/rollup.ts` 的字段注释。

---

## 3. 命令、退出码、读数

| 命令 | 退出码 | 读数（逐字） |
|---|---|---|
| `pnpm typecheck` | **0** | 0 错误 |
| `pnpm exec tsx scripts/verify-m6-wp2-rollup.ts` | **0** | `PASS — 59/59 通过，失败 0，MEASUREMENT INVALID 0` |
| `pnpm m5.1.1:k17:verify` | **0** | `✅ K-17 = PASS [零个 A 类消费者会改实时行为 · 全部命中文件已分类 · 量具有效]`（`16 通过 / 0 失败`） |
| `pnpm m5.1.1:phase4a:verify` | **1** | `35 通过 / 4 失败` —— **4 条全是既有红灯，与 M6 无关**（见 §4） |

### 3.1 针计数的**同口径对照**（证明"我的贡献已清零"）

用 `git archive -o <tar> HEAD src scripts` 落盘后解包（**不能用管道**：二进制经 PowerShell 管道会被喂坏，
第一版对照因此得到"0/0/0"这种**无效读数**，已作废），再按门的正则逐文件统计：

| 针 | HEAD（`36825cc`，WP2 之后） | 工作树（修正后） | 门的要求 |
|---|---|---|---|
| `src` 字段名 | **10** | **10** | 6 |
| `src` 派生调用 | **2** | **1** ✅ | 1 |
| `src` 三态字段 | 3 | 3 ✅ | 3 |
| `scripts` 字段名 | 53（5 个文件） | 53（5 个文件） | 2 个文件 |
| `scripts` 三态字段 | 13（3 个文件） | 13（3 个文件） | 0 |

⇒ **WP3-1 的净效果**：把 `src` 派生调用从 **2 修回 1**（这是我在 WP2 引入的越界），
其余计数**未被我改变**。`k17` 因此从 `BLOCKED` 变 `PASS`。

---

## 4. 新发现：`m5.1.1:phase4a:verify` 是一条**长期红灯**（既有，非 M6 造成）

修正后仍剩 4 条失败，**每一条都能追溯到 phase4a 写就之后新增的文件**：

| # | 失败断言 | 成因（文件） | 归谁 |
|---|---|---|---|
| 1 | 量具自检：针能命中（期望 调1/字段6/三态3） | `src/infrastructure/persistence/qualification-read.ts` 有 4 处字段名 | **Phase 4b** 新增 |
| 2 | 字段名在 `src/**` 只允许出现在 2 个文件 | 同上（第 3 个文件） | Phase 4b |
| 3 | 字段名在 `scripts/**` 只允许被**已登记**的边界断言提及 | `m5.1.1-attribution-gate-registry.ts`、`verify-m5.1.1-wp6-recorded-read-path.ts` | Phase 1–3 / WP8 |
| 4 | 三态字段在 `scripts/**` 0 处 | `verify-m5.1.1-phase4b-qualification.ts`、`verify-m5.1.1-wp61-conversation-ingress.ts` | Phase 4b / WP6.1 |

**M6 的处理**：**不修**这些文件。它们是别的里程碑的产物，判据也属于那个里程碑；M6 的纪律是
"冻结面不改、旧结论不覆盖"。这里的正确动作是**如实登记**，并在 WP10a 跑全量门时把它列入
`FAIL（既有）`而不是"M6 造成的失败"。

⚠️ **重要区分**：`K-17 = PASS` 与 `phase4a = FAIL` **不矛盾**——它们是两套判据：
`k17`（消费者影响审计，Phase 1–3 的取代判据）现在绿；`phase4a`（Phase 4a 的专项门）
的静态针**没有跟着后续 WP 更新**，已经不能反映当前仓库。
`k17` 也因此把它自己的 `WP3 回填` 由 `BLOCKED` 翻成 `READY`（因为派生点重新变成 1 处）。

---

## 5. 沙箱 / 真实库边界

| 读数 | 值 |
|---|---|
| 真实库 | **未打开**（本部分只改契约、夹具与一张门登记表；门只调用纯函数） |
| 模型调用 / 持久化写入 | **0 / 0** |
| 冻结面 | `artifacts/m5.5` 的 6 个子树 + 10 个具名 blob **未动**；`artifacts/m5/**` 未动（本部分没跑 M5 门） |
| 被门改写的证据 | `artifacts/m5.1.1/wp2.2-k17-consumer-impact.json` 被 k17 重写 ⇒ 已按白名单 `git checkout HEAD -- <该路径>` 还原，**blob 逐字节相同**（`b9fef458a9`） |
| 外来改动 | ` M artifacts/incidents/inc-01/wp1-lease.json` 原字节保留 |

---

## 6. 偏差与限制

| # | 内容 |
|---|---|
| **B-10** | WP3 拆成两部分（见 §1）。**WP3 的出口（接线门 PASS）未达成**，本文件不主张它达成 |
| **B-11** | 契约字段名刻意避开被针锁住的字面量（含注释）。这不是绕锁，而是**该锁要求的形状**：下游把读数当"值"传递（`qualification-read.ts` 同型）。已在字段注释里写明"连注释都算"，防止后人"顺手改回去" |
| **B-12** | WP2 的量具 `runId` 由 `HEAD` 派生 ⇒ 每次提交后再跑会**换目录**。本部分重生成了证据（`m6-wp2-20260921-91d84999a4ba`）并删除了旧目录。这是一处**设计缺陷**（证据目录随提交漂移），登记为 WP4 应修的项（改为按"被测提交 + 显式 runId"命名） |

**没有扩大的主张**：摘要**仍未端到端可用**（没有生产读取面）；prompt 冻结基线是否被动过，由 §8 的接线门与 `m3.5:test` 一起回答。

---

## 8. 第 2 部分：接线（本部分完成，接线门 PASS）

### 8.1 做了什么

| 文件 | 改动 |
|---|---|
| `src/kernel/context/sections.ts` | `SECTION_IDS.rollupSummary = 'rolling-summary'` + `createRollupSummaryProvider`（`kind: 'rollup'`、优先级 20、`droppable: true`）；`render()` 为空 ⇒ **产 0 个 section** |
| `src/kernel/recall/ports.ts` | 新增 `RollupSourceReader`（有界、只读、不猜的来源读取面 + 三条契约） |
| `src/kernel/app/rollup/turn.ts` | 新增轮次级胶水（镜像 `app/recall/turn.ts` 的分层）：额度 0 ⇒ `undefined`；读失败 ⇒ `status: 'read_failed'` + 不注入；trace 形态类型里**连 `blockText` 都没有** |
| `src/kernel/app/turn-gateway.ts` | 选项 `rollup?: RollupTurnPort` + `rollupForTurn()` + **唯一的插入点**（`extraProviders`）+ `context_compile` step 追加引用与计数 |
| `scripts/verify-m6-wp3-wiring.ts` | 接线门（27 项断言） |

### 8.2 四个刻意的决定（都有机器判据）

| # | 决定 | 判据 |
|---|---|---|
| **A** | 插入点**只有** `extraProviders`；绝不进 `buildContextCompilerV2` 的默认 provider 列表 | `③-1/③-2/③-3/③-7`：调用点恰 1 处、位于 `extraProviders` 段内且编译器构造之前；工厂函数体里不含摘要字样；基线构造器不得提到摘要 |
| **B** | **空摘要 ⇒ 零字节影响** | `①-5/①-6`：空 provider vs 不接 provider，`packet.text` 与 `prompt` **逐字节相同** |
| **C** | 预算不足时它**被裁**，绝不挤掉不可裁项 | `①-8/①-9`：`droppedSectionIds` 含 `rolling-summary`（实测同时裁掉了 `recent-conversation`），而 `identity-core` / `current-input` 仍在 |
| **D** | 摘要只在**真的启用过**时进 trace，且**只记引用与计数** | `②-3`（trace 形态不含正文）、`③-5`（属性块里没有正文变量）、网关侧 `rollup_*` 属性仅此一批 |

**关于 B 的一个诚实说明**：`①-7` 那条断言的措辞是"基线输入的空摘要 packet 与新编译器相同"——
它与**冻结夹具**之间还隔着一步：`scripts/m3.5-prompt-baseline.ts` 不传 `extraProviders`（`③-4` + `③-3` 共同保证它不可能含摘要），
而"夹具与生成器仍逐字节一致"由 `④-1`/`④-2` 断言、并由仓库自己的 `pnpm m3.5:test` **30/0** 独立确认。

### 8.3 本部分的门读数

| 命令 | 退出码 | 读数 |
|---|---|---|
| `pnpm typecheck` | **0** | 0 错误 |
| `pnpm exec tsx scripts/verify-m6-wp3-wiring.ts` | **0** | `PASS — 27/27 通过，失败 0，MEASUREMENT INVALID 0` |
| `pnpm kernel:test` | **0** | `26 通过 / 0 失败` |
| `pnpm kernel:verify` | **0** | `25 通过 / 0 失败` |
| `pnpm m3.5:test` | **0** | `30 通过 / 0 失败` ← **prompt 冻结基线未变**（R-2 的独立确认） |
| `pnpm eval:scenarios` | **0** | `7 通过 / 0 失败` |
| `pnpm eval:dryrun` | **0** | `17 通过 / 0 失败` |
| `pnpm eval:providers` | **0** | `11 通过 / 0 失败` |
| `pnpm m5.1.1:k17:verify` | **0** | `16 通过 / 0 失败` · `K-17 = PASS`（接线门已按同一程序登记进消费者分类表） |

**冻结面**：本部分**没有**任何门改写 `artifacts/m5/**` 或 `artifacts/m5.1/**`（`git status -- artifacts` 只多出 `artifacts/m6/**`）；
k17 重写的 `artifacts/m5.1.1/wp2.2-k17-consumer-impact.json` 已按白名单还原，**blob 逐字节相同**。

### 8.4 新发现（两处，都是**门抓出来的**）

| ID | 发现 |
|---|---|
| **F-14** | 接线门第一版把 `tokenBudget` 传给了**编译器工厂的选项**，而裁剪读的是 **`compile()` 输入的 `input.tokenBudget`**（`contracts/context.ts` 的 `applyBudget(sorted, input.tokenBudget)`）⇒ "预算不足"那一组什么都没被裁，两条断言直接红。**这是夹具的错、不是实现的错**，而且门把它抓出来了 —— 已修正并把这条写进夹具注释 |
| **F-15** | 新增的接线门脚本被 k17 判为"未分类的命中文件"⇒ `K-17 = BLOCKED`。已按同一程序登记（`klass: 'D'`，写明"不读库、不跑模型、唯一写入面是 `artifacts/m6/`"） |

### 8.5 偏差

| # | 内容 |
|---|---|
| **B-13** | **没有**为摘要新增 `TraceStepKind`，而是把引用与计数挂在既有的 `context_compile` step 上。理由：`DR-9` 只要求"引用与计数进 trace"，不要求新的步骤类型；而新增 kind 会牵动 `TRACE_STEP_STAGE` 等**闭集登记**（M5.5 为 `external_evidence` 处理过同一个问题 → 映射到既有 `context` 阶段）。语义上它**就是**上下文编译的一部分 |
| **B-14** | ADR-050 §3.2 第 ② 步的伪代码把序列判据写成 `sequence > watermark(recentWindow)`（方向写反）。实现按**裁定意图**（`DR-5`：只覆盖 Recent 窗口**之外**）取 `sequence < min(Recent 序号)`。裁定意图未变，属伪代码笔误，如实登记 |
| **B-15** | 网关**没有**配套的 `rollupEnabled` 布尔开关（其它端口都有"端口 + 开关"两半）。理由：`DR-11` 明写"不新增 runtime flag —— 开与关由**额度是否为 0** 表达"（先例 ADR-045） |

### 8.6 本部分**没有**主张的

- 没有主张摘要**在生产上可用**：`main.ts` 尚未构造 `rollup` 端口（那是第 3 部分 + 一次独立的激活裁定）；
- 没有主张"覆盖全部历史"（`coverageTruncated` 如实暴露）；
- 没有主张开发者面能看到摘要（属 WP5）。

### 8.7 第 3 部分的入口

| 项 | 内容 |
|---|---|
| 要做 | ① `src/infrastructure/persistence/rollup-source-store.ts`：`recentConversationEvents({beforeSequence})` 取窗口（**硬上限** `scanCeiling`）+ `processorEventViewOf(event)` 取读数（**不得**自己解析物理列，R-59）+ `memory_evidence_links`（`is_root`）反查 `memory_records.status`；② 在隔离库上串通真实 `TurnGateway`（`isolateDatabase()` 先于任何碰库的 import）；③ 门：有界性 / 跨会话越权负控 / 真库形状核对（**不打开真实库**）；④ `main.ts` 装配（默认额度 0 ⇒ 行为零变化） |
| 必读 | ADR-050 §3.2/§3.4 · `M6-Acceptance-Contract.md` §4.2 · `src/infrastructure/persistence/qualification-read.ts`（读路径纪律范本）· `src/infrastructure/persistence/conversation-store.ts:602`（`recentConversationEvents` 的 `beforeSequence`） |
| **STOP 点** | 第 3 部分的门 PASS 后 STOP |

---

## 9. 第 3 部分：只读来源读取面 + 装配（本部分完成）

### 9.1 做了什么

| 文件 | 改动 |
|---|---|
| `src/infrastructure/persistence/rollup-source-store.ts` | 新增 `createRollupSourceReader`：**单次**有界查询取窗口 + **批量**反查根证据所挂记忆状态 + 逐条取受信读数 |
| `src/infrastructure/persistence/qualification-read.ts` | 把"取受信读数"抽成导出的消费点 `originReadingOfEvent(event)`，原私有路径复用它 ⇒ "取不到怎么办"只有一处（R-59） |
| `src/main.ts` | `buildRollupTurnPort()` + 注入 `rollup`（与 `recall` 同一条纪律） |
| `scripts/verify-m6-wp3-reader.ts` | 读取面门（25 项断言，隔离库） |

### 9.2 四个刻意的决定

| # | 决定 | 理由 / 判据 |
|---|---|---|
| **A** | 一次查询取窗口 + 一次查询取状态 + **不再逐条查库** | ≤200 条候选不该变成 200 次往返；「有界」要同时是有界的**代价** |
| **B** | 上界越界/非有限 ⇒ **视为"没有上界"**，而不是把 `Number.MAX_SAFE_INTEGER - 1` 送进 SQL | `sequence` 是 `integer`（int4）。第一版就是这么炸的，得到的是 `Failed query` 这种**不透明**错误 ⇒ 已登记 F-16。门用 `Number.MAX_SAFE_INTEGER` 表达"无上界"是合法意图，应当有合法表达 |
| **C** | 受信读数**只经** `qualification-read.ts` 的消费点取得 | 用户裁定 R-59：全 `src/**` 只允许一处派生。本文件自己读物理列会让它变成**第二个**消费面（第一版就这样，被 `phase4a`/`k17` 的针计数当场抓出，F-18） |
| **D** | `main.ts` 接线，但缺省额度 **0** | `DR-11`：开/关由额度表达。不接端口 ⇒ 没有那条唯一的开启路径；接了但缺省 0 ⇒ 行为零变化（先例 ADR-045） |

### 9.3 读取面门证明了什么（25/25，全部在**隔离库**上）

| 段 | 断言（节选） |
|---|---|
| ① 正控 | 真实「人类控制台」ingress 写出的行 ⇒ 读数成立（`attributionOrigin = RECORDED`）⇒ 选择器选中它，摘录**逐字**、引用是真实事件 id |
| ② D01 生产形状 | 「程序化 ingress」的行**有**受信信封，但资格 = `UNCONFIRMED_ORIGIN` ⇒ **拒**（`unconfirmed_origin`） |
| ③ 历史行 | 无受信信封（`attribution_origin` 为 NULL）⇒ 读数**缺席** ⇒ **拒**（同一个具名理由，不是静默少一条） |
| ④ 跨会话 | 另一段会话的受信发言**不会**出现在本会话候选里（作用域在 SQL 层，不靠事后过滤） |
| ⑤⑥ 有界 | `scanCeiling` 是硬上限；上限 0 ⇒ 一条不读；`beforeSequence` **排他**，且只排自己不排整段 |
| ⑦ 失效闸 | 事件是某条记忆的**根证据**：`active` ⇒ 可选 → 置 `superseded` ⇒ **拒**（`invalidated_by_memory_state`）→ 置回 `active` ⇒ 重新可选（**三段式**） |
| ⑧ 只读 + 端到端 | 读一次前后 4 张表行数**完全不变**；真实库 → 读取面 → 选择器 → 轮次级端口，trace 形态**不含正文** |

### 9.4 本部分的门读数

| 命令 | 退出码 | 读数 |
|---|---|---|
| `pnpm typecheck` | **0** | 0 错误 |
| `pnpm exec tsx scripts/verify-m6-wp3-reader.ts` | **0** | `PASS — 25/25 通过，失败 0，MEASUREMENT INVALID 0` |
| `pnpm exec tsx scripts/verify-m6-wp3-wiring.ts` | **0** | `PASS — 27/27` |
| `pnpm m4:test` | **0** | `243 通过 / 0 失败`（改 `main.ts` 的必跑门） |
| `pnpm m4.5:test` | **0** | `135 通过 / 0 失败` |
| `pnpm m5.1.1:k17:verify` | **0** | `16 通过 / 0 失败` · `K-17 = PASS` |
| `pnpm m5.1.1:phase4a:verify` | **1** | `35 通过 / 4 失败` —— 与 WP3-1 时**逐条相同**（4 条既有红，未新增） |

**冻结面**：被 `m4.5:test` / `k17` 重写的 `artifacts/m4.5/component.json` 与 `artifacts/m5.1.1/wp2.2-k17-consumer-impact.json`
已按**白名单逐路径**还原，**blob 逐字节相同**。

### 9.5 本部分抓出来的四个问题（全部由门/断言暴露，不是"看着没问题"）

| ID | 问题 | 处置 |
|---|---|---|
| **F-16** | 上界用 `Number.MAX_SAFE_INTEGER` 时，`sequence` 的 int4 溢出 ⇒ `Failed query`（**不透明**） | 读取面改为"越界即无上界"；门保留用最大值表达"无上界"这一意图 |
| **F-17** | 我以为 `h.recordUserEvidence()` 写的是 **legacy** 行 —— 它其实走**受信**写入路径（M5.1.1 起）。夹具假设错了 | 改用真正的不带 `trustedAttribution` 的写入路径；被自己的 ③-1 抓出来 |
| **F-18** | 我的新文件**又**碰了针：`src` 的注释里写了那个字段名、`k17` 的登记理由里引用了它 | 注释改为**描述**而不是字面量；计数已回到与 HEAD **逐字相同**（src `10/1/3`、scripts `53/3/13`） |
| **F-19** | 重写夹具后接线门**不再命中**任何 Axis-B 名字 ⇒ k17 的 **stale-entry** 规则报"陈旧条目"（判决 PASS 但 15/1，退出码 1） | 移除该登记条目；k17 回到 16/0 |

### 9.6 偏差

| # | 内容 |
|---|---|
| **B-16** | 读取面**不新增任何配置项**：有界在上游（`scanCeiling`）、开关在额度（`rollupTokens`）。多一个开关就多一处"看起来配了其实没接" |
| **B-17** | `main.ts` 已接线但**缺省额度 0**：能力可达、生产行为不变。**激活**（把额度配成非 0）属独立裁定，不在 WP3 内 |

### 9.7 本部分**没有**主张的

- 没有主张生产上已启用摘要（额度仍是 **0**）；
- 没有主张覆盖全部历史（`coverageTruncated` 如实暴露，且门只断言"有界"）；
- 没有主张真实库上的效果（**真实库从未被打开**；全部证据来自隔离库）；
- 没有主张"她不会再说错"（ADR-043 `DR-11` 照旧）。

### 9.8 下一包

**WP4（量具资格化与命令面）**：把这两个门并入 `m6:measurement:verify` 套件，按计划 §9.1 定义 4 个命令入口，
并补第 5/第 6 条假绿负控（"永远不摘要也能全绿"、"已选择但被裁掉仍计为实际入模"）。
入口必读：`M6-Acceptance-Contract.md` §4.4 · `M6-Affected-Surface-Map.md` §6 · 本文件 §7/§9。

---

## 7. 下一部分（WP3-2）的准确入口

| 项 | 内容 |
|---|---|
| 必读 | ADR-050 §1 `DR-8`/`DR-9`/`DR-10` + §3.5 · `M6-Acceptance-Contract.md` §4.3 · `src/kernel/context/sections.ts`（`createMemoryRecallProvider` 是形状模板）· `src/kernel/app/turn-gateway.ts:868-972` · `src/infrastructure/persistence/qualification-read.ts`（读路径的纪律范本） |
| 要做 | ① `SECTION_IDS.rollupSummary` + `createRollupSummaryProvider`（空 ⇒ 0 section）；② `recall/ports.ts` 加只读来源端口形状；③ `turn-gateway` 在 `extraProviders` 段接线 + trace 只记引用与计数；④ 持久层只读查询（`conversationEventsInRange` + `memory_evidence_links` 反查记忆状态 + `processorEventViewOf` 取读数）；⑤ 接线门：packet 级正控/负控/恢复 + R-2 负控"摘要为空时 `packet.text` 与关闭态**逐字节相同**" |
| 必跑门 | `typecheck` · `kernel:test` · `kernel:verify` · `m3.5:test` · `eval:scenarios` · `eval:dryrun` · `eval:providers` · `m5:budget:verify` · `m5.1.1:phase4a:verify`（预期仍 4 条既有红）· `m5.1.1:k17:verify` |
| **STOP 点** | 接线门 PASS 后 STOP；**不得**顺手做开发者面（WP5）或故障注入（WP6a） |
