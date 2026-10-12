# M6 · 受影响面地图（Affected-Surface Map）

> 由 WP0（`runId = m6-wp0-20260921-1165fedcdde2`）在 HEAD `1165fed` 上只读核对得出。
> 机器读数：`counters.chainSegments = 9` · `chainEntryFiles = 15` · `chainEntryFilesMissing = 0`。
> 本文只描述"改哪里、会撞到什么"，**不含设计裁定** —— 裁定属于 WP1。
> 本文件里标注为"拟改"的路径**全部尚未实现**。

---

## 1. 链路：源 → turn → context → model → guard → ledger/trace → query/UI

| # | 段 | 入口文件（已核对存在） | 当前行为（只读核对所得） | M6 拟改点 | 对应门 |
|---|---|---|---|---|---|
| 1 | **源** | `src/infrastructure/persistence/memory-store.ts` · `conversation-store.ts` | 对话事件与记忆记录的唯一持久层；`memory-store.list()` 自带 500 行上限（`memory-retrieval-store.ts:84-85` 的 `STORE_MAX_LIMIT`） | 新增**只读、显式有界**的摘取来源窗口查询；不得绕过既有 owner/user/qualification 检查 | `m4:test` · `m4:verify` · `m5:test` |
| 2 | **turn** | `src/kernel/app/turn-gateway.ts`（1545 行） | `beginTurn` 之后、编译之前依次挂载：召回（`:888-908`）→ 写入结果（`:910-916`）→ 动作结果（`:917-923`）→ 外部证据（`:937-954`）；`:956` 调 `buildContextCompilerV2` | 在同一位置派生 rollup 摘要（抽取式、带 sourceRefs、失败即整段不注入） | `m3.5:test` · `eval:scenarios` · `eval:dryrun` · `eval:providers` |
| 3 | **context** | `src/kernel/contracts/context.ts` · `src/kernel/context/sections.ts` | `createContextCompiler`（`contracts/context.ts:380`）是**唯一**裁剪算法（`dedupeById` → `sortSections` → `applyBudget` → `renderPacketText`）；两个工厂（`buildContextCompiler` :731 / `buildContextCompilerV2` :772）都留 `extraProviders` | **必须走 `extraProviders`**（见 §3.1）；`SECTION_PRIORITY.rollup: 20` 保持不变 | `typecheck` · `kernel:test` · `kernel:verify` · `m3.5:test` |
| 4 | **预算** | `src/kernel/recall/selector.ts` | `ContextBudget` = 4 个**必填**字段（`totalTokens 6000` / `memoryTokens 800` / `reservedTokens 2400` / `externalEvidenceTokens 0`）；`ContextCategory` 6 类；`planContextBudget()` :115 与 `assertContextBudget()` :145 按这两组写死 | 摘要额度/类别的落点（见 §3.2）**—— 已于 WP2 落地**：5 个必填字段（+`rollupTokens: 0`）+ **7 类**（+`rolling_summary`），`m5:budget:verify` 断言同步更新 | `m5:budget:verify` · `m5:test` · `m5:verify` · `m5:metrics:verify`（若改判据） |
| 5 | **model** | `src/infrastructure/runtime/adapters.ts` | 模型调用经唯一 provider 适配层 | 抽取式摘要**新增模型调用数必须为 0**（这是与"自由改写摘要"的关键分界） | `eval:providers` · `m4.5:smoke:live` |
| 6 | **guard** | `src/kernel/app/turn-gateway.ts` | 守卫链：记忆 → 动作 → 外部证据；回复五态与程序生成的来源附录 | 摘要**不得插进守卫链** —— 它是派生上下文，不是事实，也不是第二个事实权威 | `m4.5:test` · `m5.5:test` |
| 7 | **ledger/trace** | `src/infrastructure/persistence/trace-store.ts` · `src/kernel/contracts/trace.ts` | trace 记 section 组成、裁剪与引用；**不记正文** | 只新增"引用与计数"；**不得**写入摘要正文或搜索 snippet | `m3:verify` · `m3.5:verify` · `eval:telemetry` · `eval:otlp` |
| 8 | **query/UI** | `src/infrastructure/dev/query-service.ts` · `http-server.ts` · `page.html` | 开发者面只消费 `/dev/query/*`；两条受控命令（`RUN_DIAGNOSTIC` / `RUN_AUDIT`） | 按合法生产者登记表扩展 DTO；CLI 与页面复用服务能力，不新建直写数据库路径 | `m5.1:test` · `m5.1:query:verify` · `m5.1:control:verify` · `m5.1:page:verify` · `m5.1:observability:verify` |
| 9 | **运行保护** | `src/infrastructure/persistence/production-db-safety.ts` · `src/main.ts` | 租约/快照模块已存在且有 WP1/WP2 证据，但 **`src/main.ts` 零引用**；`session.close()`（`main.ts:1559-1561`）只调 `runtime.stop()` | **不由 M6 改** —— 属 INC-01 WP3（close 生命周期）/ WP4（生产接线）/ WP5（恢复演练）。M6 只做 §5 的**集成验收** | `verify-inc-01-wp1` · `verify-inc-01-wp2` · `m4:isolation:verify` · `m4:restore:verify` |

**一处需要点名的既有事实**：第 9 段的"组件已 PASS"与"运行期保护生效"是**两件事**。
本仓库自己记录过这个区别（AGENTS §6.9：从隔离/副本读到的数不能当成真实库状态），
M6 必须继续沿用这个口径，不得因为 WP1/WP2 有证据就认为生产入口已经被保护。

---

## 2. 拟增 / 拟改文件清单（按子系统，**全部尚未创建**）

| 子系统 | 路径 | 性质 | 备注 |
|---|---|---|---|
| 领域契约 | `src/kernel/contracts/rollup.ts`（名待定） | 新增 | 摘要条目的纯类型 + 纯函数；**不得** import 框架/SQL/`node:*`（`kernel:test` 边界组会拦） |
| 领域逻辑 | `src/kernel/context/sections.ts` | 追加 | 新增 rollup provider（走 `extraProviders`） |
| 装配 | `src/kernel/app/turn-gateway.ts` | 追加 | 在 `beginTurn` 之后派生摘要并挂 provider |
| 预算 | `src/kernel/recall/selector.ts` | **可能**改 | 仅当 WP1 选"新增字段/类别"时（见 §3.2） |
| 持久层 | `src/infrastructure/persistence/**` | 新增只读查询 | 有界来源窗口；**不得**新增写路径 |
| 开发者面 | `src/infrastructure/dev/**` | 追加 | 摘要的来源数量/范围/裁剪状态 |
| 量具与套件 | `scripts/m6-*.ts` | 新增 | WP4 按计划 §9.1 只加 4 个入口：`m6:verify` · `m6:measurement:verify` · `m6:live` · `m6:gates` |
| 证据 | `docs/m6/**` · `artifacts/m6/<runId>/**` | 新增 | 大日志与本地评审包另放 **gitignored** 输出目录，WP4 先声明路径 |

**WP0 已产出的**：`scripts/m6-wp0-baseline.ts`（量具）、`docs/m6/{M6-Baseline,M6-Affected-Surface-Map,WP0-Handoff}.md`、
`artifacts/m6/m6-wp0-20260921-1165fedcdde2/**`。

---

## 3. 两条高风险落点（审阅发现，计划书原文未列）

### 3.1 R-2：摘要 provider 的插入点决定要不要重刷冻结 prompt 基线

已核对的机制（三方证据一致）：

1. `scripts/m3.5-prompt-baseline.ts:135` 用 **`buildContextCompilerV2`** 生成冻结基线，
   **不传 `extraProviders`**；
2. `turn-gateway.ts:868-972` 在**装配层**构造 `extraProviders`，并把"空集合 ⇒ 产 0 个 section"
   当作"prompt 与基线逐字节相同"的机制（代码注释 `:932-933` 明写这是**机制**不是巧合）；
3. `evals/fixtures/m3.5/prompt-baseline.txt` 的 sha256 = `047c6c965fa6f29c79831e817c93b236f17a982c14a3ad6eafab3b53bd2ea4b6`
   （本轮已登记进 `manifest.fixtureRubricThresholdHashes`）。

**结论**：

- 把 provider 放进 `buildContextCompilerV2` 的**默认** provider 列表 ⇒ 冻结基线必红，
  必须走 AGENTS §3 的"有意改 prompt 才允许 `pnpm m3.5:baseline` 重刷"程序；
- 走 `extraProviders` + 空集合不产 section ⇒ **可以做到基线一字节不动**。

WP1 必须**明确选择**哪一条，并写进验收契约。若选前者，`pnpm m3.5:baseline` 重刷必须在
WP3 的提交里说明理由（AGENTS §6.6：改判据要如实写进报告）。

### 3.2 R-3：预算字段/类别是必填，涟漪面比计划书估计的大

| 事实 | 位置 |
|---|---|
| `ContextBudget` 4 个字段**全部必填**，无可选字段 | `src/kernel/recall/selector.ts:53-76` |
| 默认值 `6000 / 800 / 2400 / 0` | 同上 `:78-88` |
| `ContextCategory` 是 6 类闭集（**无 `rollup`**） | 同上 `:91-97` |
| `planContextBudget()` 按六类硬编码返回 6 行 | 同上 `:115-142` |
| `assertContextBudget()` 遍历 4 个字段名并断言 `memory + reserved + externalEvidence ≤ total` | 同上 `:145-162` |
| `pnpm m5:budget:verify` **直接断言**六类与默认值 | `scripts/verify-m5-budget.ts:116-151` |
| 约 10 处脚本构造 `ContextBudget` 字面量 | `scripts/verify-m5-budget.ts` · `verify-m5-runtime.ts` · `verify-m5.1-e2e.ts` · `verify-m5.5-measurement.ts` · `m5.5-harness.ts` · `kernel-tests-m5.5.ts:596` 等 |

**两条路由**（WP1 选一条并写明理由）：

| 路由 | 代价 | 收益 |
|---|---|---|
| (a) 复用 `reservedTokens` 内部切分 | 零契约变更；`tsc --noEmit` 全绿 | "摘要能占多少"变成**不可审阅的隐含值** |
| (b) 新增 `rollupTokens` 字段 / 第 7 类 `rollup` | 必改 `assertContextBudget` + `planContextBudget` + `m5:budget:verify` 的断言 + ~10 处字面量 | 与 ADR-045 给外部证据独立额度（`externalEvidenceTokens`，缺省 0）同构，可审阅 |

**无论选哪条**：不允许为了让门变绿而放宽分母或删断言（AGENTS §6.4/§6.6）。

---

## 4. 拟改点 → 必跑门（映射表）

| 改动面 | AGENTS §5 要求的门 | 本轮核对 |
|---|---|---|
| 任意 `.ts` | `pnpm typecheck` | ✅ 已跑（退出 0） |
| `src/kernel/contracts/**` · `src/kernel/policies/validator.ts` · `src/kernel/projections/**` | `pnpm kernel:test` + `pnpm kernel:verify` | ⬜ 待 WP2 |
| `src/kernel/context/sections.ts` · `src/kernel/app/turn-gateway.ts`（prompt 相关） | `pnpm m3.5:test` · `eval:scenarios` · `eval:dryrun` · `eval:providers` | ⬜ 待 WP3 |
| `src/kernel/recall/**`（含 `selector.ts`） | `pnpm m5:test` · `m5:verify` · `m5:nl-e2e:verify`；改排名/资格判据加 `m5:metrics:verify`；**改预算必加 `m5:budget:verify`** | ⬜ 待 WP1/WP3（见 §3.2） |
| `src/infrastructure/dev/**` · `src/kernel/contracts/developer-*.ts` | `pnpm m5.1:test` · `m5.1:query:verify` · `m5.1:control:verify`；改页面加 `m5.1:page:verify` | ⬜ 待 WP5 |
| 可观测性（`observability.ts` · `src/infrastructure/telemetry/**`） | `pnpm m5.1:observability:verify`；动白名单/分类法再加 `m5.1:measurement:verify` | ⬜ 待 WP5 |
| **任何新判据 / 新量具** | 那个门 + `pnpm m5.1:measurement:verify`（正控/负控/恢复三段式） | ⬜ 待 WP4（**WP0 的量具已自带三段式**，见 §6） |
| `src/main.ts` / CLI 参数 | `pnpm m4:test` · `m4.5:test`；改用户可见命令要更新权威使用说明 + `pnpm doc:sync` · `doc:check` | ⬜ 待 WP6b |
| 看起来影响真实链路的改动 | `pnpm m4.5:ci:full`（含 Live Smoke） | ⬜ 待 WP10b（**需单独授权**） |
| 收尾 / 交付前 | `pnpm m5.1:gates` · `m5.1:regression:verify`（后者要求先有 `m4.5:ci` 日志） | ⬜ 待 WP10a |

**WP0 的裁决**：本轮**零生产代码改动**，因此**不跑**任何里程碑门；跑门只会重写 `artifacts/` 历史证据。
唯一例外是新量具自身，见 §6。

---

## 5. 冻结面（**不许碰**，改动必须走指定程序）

| 冻结对象 | 依据 |
|---|---|
| `src/kernel/app/memory/**` · `src/kernel/policies/memory-validator.ts` · `src/infrastructure/persistence/memory-store.ts`（reducer 语义） · `src/kernel/contracts/memory.ts` 的事件 payload | AGENTS §3（M4/M4.1 已验收的 Memory Kernel 语义） |
| 已发布迁移 DDL `0001–0009`（真实库当前 **v9**） | AGENTS §3：只许追加新版本号；**新迁移仍须先经用户批准** |
| `src/character/苏沐薇.ts`（人设内容） | AGENTS §3：改内容必须升 `SEED_VERSION` + 刷指纹 |
| `evals/fixtures/m3.5/prompt-baseline.txt` | AGENTS §3：只允许在"有意改 prompt"时用 `pnpm m3.5:baseline` 重刷 |
| `docs/苏沐薇-使用说明.txt`（权威源） | AGENTS §3：只改权威源 + `pnpm doc:sync` |
| `data/pglite/`（真实库） | AGENTS §3：只有 `src/main.ts` 与两个**只读**验收脚本能打开；`data/` 被 gitignore，**git 看不见它的改动** |
| `src/infrastructure/telemetry/**` 既有语义 · `src/kernel/contracts/developer-*.ts` 的生产者登记表 | AGENTS §3：只许追加 |
| `artifacts/**` 已提交的历史证据 | AGENTS §3/§7：不得被重新生成的证据覆盖 |
| `docs/m5.1/**` · `docs/m5.1.1/**` | 被 `m5.1-complete` / `m5.1.1-complete` 冻结的判定文档（`m5.1.1:wp8:verify` 有机器判据守着） |

**被刻意关掉的开关不要顺手打开**（AGENTS §3 的 M4.1 教训）：
`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`（默认 off）与 `CHARACTER_MEMORY_BACKGROUND_ENABLED`（NOT-WIRED）
在本轮 `.env` 里**均未设置**（§M6-Baseline §9），因此走代码缺省 —— M6 **不**把它们打开。

---

## 6. WP0 的新量具：`scripts/m6-wp0-baseline.ts`

| 项 | 内容 |
|---|---|
| 命题 | 「这份 baseline 描述的是**本 checkout 在当前 HEAD 上的真实状态**，而不是旧结果、别人的工作树或一次空扫描」 |
| 正控 | `P1` 2 个已知文件 ⇒ `measuredCount = 2`；`P2` 改 1 个字节 ⇒ `treeSha256` 必变 |
| 负控 | `N1` 空目录 ⇒ **必须抛** `MeasurementInvalidError`（复现 AGENTS §6.8 的真实事故形态）；`N2` 证据路径不存在 ⇒ **必须抛**，不许记空串 |
| 恢复 | `R1` 内容还原 ⇒ 摘要回到原值（量具重新安静） |
| 本轮读数 | **5/5 PASS**（`measurementSelfTest.cases`） |
| 硬边界 | 不 `import dotenv`；不 import 任何数据库依赖；不打开 PGlite；不回显 key 取值 |
| 三段采样 | `before`（本文件的事实来源）→ `after`（WP0 产物落盘后）→ `verify`（最终文档之后，机器判定"采样后只变了纯文档"） |

**新量具门的三段式自证由量具自己承担**，因此它**不需要**再叠加 `pnpm m5.1:measurement:verify`：
后者针对的是 M5.1 的量具白名单与分类法，与本文具无共享判据。
（若 WP4 把本文具并入 `m6:measurement:verify` 套件，届时按 AGENTS §5 的那一行处理。）

---

## 7. 留待 WP1 的裁定项（本文档**不下裁定**）

| ID | 裁定项 | 依据小节 |
|---|---|---|
| R-2 | provider 插入点：是否承诺"冻结 prompt 基线一字节不动" | §3.1 |
| R-3 | 摘要额度：复用 `reservedTokens` vs 新增字段/类别 | §3.2 |
| D-1 | M6/G1 范围与原始 Lv1 差异（M7 不前移；原始 Lv1 缺口保留 `PARTIAL`） | 计划 §0.1 · §4 |
| D-2 | 摘要实现形态（抽取式、引用保留、不自动持久化自由文本；复用 `rollup`） | 计划 §3.1 · §4 |
| D-3 | 行为质量阈值（留到 WP9a 有校准数据时） | 计划 §4 · WP9a |
| 新增 | 摘要契约的字段名与来源资格规则的**具体表达**（与既有 `MemoryQualification` / ADR-043 规则对齐） | 计划 §3.1 |

**未获批准的设计不得进入 WP2**（计划 WP1 出口）。

---

## 8. WP10a 实测到的**受影响面**：M6 合法改变了 M5.5 的三处**冻结期望**

> 来源：WP10a 最终离线门（`runId = m6-wp10a-976eeb302fc0`）。现象是 `m5.5:measurement:verify` 8 条失败、
> `m5.5:gates` 的 G1 = FAIL。逐条分析后确认**不是行为回归**，而是 M6 的登记改动让 M5.5 那三条探针的
> **基准过期**。处置经用户 2026-09-21 批准（B 案）：**只更新探针基准，不改写 M5.5 的历史结论**。
> ⚠️ **本节是"实测发现"，不是 WP0 预测** —— 上面 §1–§7 的 WP0 原文一字未改。

| # | M5.5 的探针 | 为什么在 M6 候选上为红 | 处置（已实现） | 由哪次改动引起 |
|---|---|---|---|---|
| 1 | 预算配置检测器的**夹具**（`verify-m5.5-measurement.ts` 里手搓的 `ContextBudget` 字面量） | `ContextBudget` 在 M6 新增了**必填**字段 `rollupTokens`（`rolling_summary` 那一格，缺省 0 = 不做摘要）；夹具没跟上 ⇒ 检测器对"字段缺失"的输入报错 | 给 4 处夹具补 `rollupTokens: 0`（**夹具新鲜度**，判据与主张都没变） | **WP2**（ADR-050 DR-7） |
| 2 | 冻结身份检测器核对的 **10 个 named blob** | 其中 `artifacts/m5/gate-results.json`、`artifacts/m5.1/gate-results.json` 是**证据**：同一次最终扫描里更早的汇总门刚重写过它们的工作树副本，而探针用裸 `hash-object <path>`（工作树原始字节）比对冻结值 ⇒ **冤枉红**（与"历史"无关；CRLF 检出也会这样） | 改成读**已提交内容** `rev-parse HEAD:<path>`（与同门"子树"那条判据同一种规范化）；**基线哈希一个都没改** —— 实测它们本来就与冻结值逐字一致 | 无（**探针自身的规范化缺陷**） |
| 3 | 开发者面身份检测器："8 个文件自 `cfd9219` 逐字节未改" | **M6 WP5 依 ADR-050 登记扩展了开发者面**（`web.search` 可用性行 + 摘要事实派生 + DTO 扩展）⇒ `page.html` / `query-service.ts` / `developer-query.ts` **确实**与 `cfd9219` 不同 | 拆成两组冻结点：5 个仍对 `cfd9219`；那 3 个改对 **`e7d97cf`**（M6 WP5 那次登记扩展），理由逐字写在代码里。**「`D-18②` 在 M5.5 当时成立"这个历史结论不改写** | **WP5** · `e7d97cf feat(dev): surface the rolling-summary facts in the developer plane (ADR-050)` |

**同时点名一个结构性问题**（WP10a 实测，建议进 WP11 的 `M6-Known-Limitations`）：
"只读汇总门 + 固定路径证据 + 白名单恢复"这套约定会被**旧证据误绿** ——
白名单恢复把新鲜的 FAIL 证据还原成旧的 PASS 之后，之后跑的只读汇总门读到的是旧结论
（同一次扫描里 `m5.5:gates` = ❌；随后的全量回归里同一命令 = ✅，因为那时证据已被还原）。

