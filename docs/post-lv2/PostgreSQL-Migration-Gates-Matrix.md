# PostgreSQL 迁移：既有回归门 × PG 适用性矩阵

日期：2026-10-12（Asia/Shanghai）。状态：**WP0 交付**（只登记，不改任何门脚本）。
上游：[执行计划](PostgreSQL-Migration-Execution-Plan-2026-10-12.md) §5 · [ADR-132](../adr/ADR-132-postgresql-migration-backend-and-activation.md) ·
[验收契约](PostgreSQL-Migration-Acceptance-Contract.md) · [WP0 基线](PostgreSQL-Migration-WP0-Baseline.md)。

**这份矩阵要回答的唯一问题**：换后端之后，**哪一条既有门量的是哪个后端**，
以及**哪一条门在哪一包必须增加 PG 场景**。

⚠️ **本轮没有跑任何门**（WP0 授权是"只写文件"）。下表的"读数"列一律写
**WP0 读代码得到的结构判据**（脚本里真的出现了什么标识符），不写"它通过了"。

---

## 0. 门表的规模（实测）

| 项 | 读数 | 来源 |
|---|---|---|
| `scripts/gates/manifest.ts` 里登记的**门 id** | **118** | 正则抽 `id: '…'` |
| 其中以 `pnpm` 命令形式存在的**门** | 见 §2 | `package.json` scripts |
| 引用 `isolateDatabase` 的脚本 | **253** | `scripts/**` 全文 |
| import `production-db-safety` / `production-db-restore` / `production-open-guard` 的脚本 | **≈120** | `scripts/**` 全文 |

⇒ **隔离层的耦合面是"百级脚本"**，不是"几张表"。这条决定了两件事：

1. `D03`（`isolateDatabase()` 在 PG 后端下**默认失败关闭**）是**唯一**在规模上可行的做法 ——
   逐个脚本改成显式测试目标不现实，而且改一批漏一批正是"看起来隔离了"的形状。
2. WP1 的隔离门必须**反向**验证：把 `POSTGRES_URL` 注入环境 ⇒ 那 253 个脚本里**任何一个**
   在写库前都必须失败。做法 = 选一组代表性脚本（覆盖主程序/诊断/恢复/召回/提醒/共存）逐个跑负控，
   **不**声称"253 个都验过"。

---

## 1. 分类口径

| 类别 | 含义 | 处置 |
|---|---|---|
| **A 后端无关** | 纯函数 / 不碰数据库 / 只读静态检查 | **不改**。PG 与 PGlite 下都必须照绿 |
| **B PGlite 归属（保留）** | 量的就是 PGlite 的目录 / 租约 / 快照 / 恢复 | **原门保留、归属不变、不许改名充当 PG 证据**；PG 侧另立新门 |
| **C 后端无关但走隔离库** | 逻辑与后端无关，但每次运行都建一个隔离库 | **不改断言**；PG 后端下由 `D03` 决定"拒绝或显式测试目标" |
| **D 必须新增 PG 场景** | 同一业务性质在 PG 上有不同的失败形状 | 在原门**之外**新增 PG lane（不替换） |
| **E 聚合 / 选档门** | 只读已落盘证据，按身份选档 | **不改**；新增 PG lane 的证据按同样口径登记 |

---

## 2. 逐门矩阵

### 2.1 M1–M3 阶段（内核与迁移）

| 门 | 类别 | WP0 结构判据 | 处置 / 归属 |
|---|---|---|---|
| `typecheck` | A | 只读编译 | 不改。**每一包都必须 EXIT 0** |
| `kernel:test` | A | 纯内核断言（无 DB/spawn/写文件） | 不改 |
| `kernel:test:identity` | A | 纯函数断言 | 不改 |
| `kernel:test:conversation` | A | 纯函数断言 | 不改 |
| `kernel:verify` | A | 跨进程内核验证（`SAFE_PURE`） | 不改 |
| `m3:verify` | C | 走隔离库 | 断言不改；PG 下受 `D03` 约束 |
| `m3:migrate-gate` | **B/D** | `PGLITE_DATA_DIR` ×1 · 生产闸标识 ×4 | **B**：`shouldBlockForPendingKernelMigration` 的判据是 `isProductionDir(dataDir)` ⇒ PGlite 归属。**D**：PG 侧需要等价物（"待迁移 ⇒ 拒绝启动"）⇒ **PG-G02.2/G02.4** |
| `m3:seed-check` | C | 走库 | 断言不改 |
| `eval:scenarios` / `eval:m3` / `eval:telemetry` / `eval:otlp` / `eval:dryrun` / `eval:providers` | A/C | 评测链，多为隔离库 | 不改 |

### 2.2 M3.5–M4.5 阶段（持久化与行动真相）

| 门 | 类别 | WP0 结构判据（脚本里真的出现） | 处置 / 归属 |
|---|---|---|---|
| `m3.5:test` / `m3.5:verify` | C | 走隔离库 | 断言不改 |
| `m4:test` | C | 隔离库 | 断言不改 |
| `m4:verify` | C | 隔离库 | 断言不改 |
| `m4:faults` | C | 隔离库 ×2 | 断言不改；**PG-G03.2** 的对照物 |
| `m4:restart:verify` | **D** | 隔离库 ×4；`snapshot` 0 命中 | **D**：重启续跑在 PG 上的失败形状不同（服务器不随应用停）⇒ **PG-G03.1/G03.6** |
| `m4:isolation:verify` | **B/D** | `isolateDatabase` ×2；`snapshot` ×3 | **B**：量的是 PGlite 目录隔离。**D**：PG 侧 = **PG-G01.6/G01.7**（继承生产 URL、第二目标） |
| `m4:restore:verify` | **B** | `snapshot` **43** 命中 · `isolateDatabase` ×5 | **B（强 PGlite 归属）**：量的就是"复制→校验→健康→晋升"的那套目录语义（INV-DB-03）。**保留、不改名**。PG 侧 = **PG-G07**（另一条路） |
| `m4:mutation-safety:verify` | C | `snapshot` ×3 · `isolateDatabase` ×3 | 断言不改；**PG-G05.4/G05.5** 相关 |
| `m4:nl-mutation:verify` | C | 隔离库 | 断言不改 |
| `m4:memory-integrity:verify` | C | `isolateDatabase` ×4 | 断言不改；**PG-G05.6/G06.1** 相关 |
| `eval:m4` | C | 评测链 | 不改 |
| `m4:promptfoo:build` / `:assertions` / `:run` | A/C | promptfoo 配置与断言 | 不改 |
| `m4.5:test` / `m4.5:verify` / `m4.5:measurement:verify` / `m4.5:nl-action:verify` / `m4.5:audit` | C | 隔离库 / 只读审计 | 断言不改 |
| `m4.5:gates` | E | 只读已落盘证据 | **不改**；PG lane 证据按同口径登记 |

### 2.3 M5–M6 阶段（联网 / 摘要 / 事故）

| 门 | 类别 | 处置 |
|---|---|---|
| `m5:gates` / `m5.1:gates` / `m5.1.1:gates` / `m5.5:gates` / `m5.5.1:gates` / `m6:gates` | E | **不改**（只读证据聚合） |
| `inc-01:gates` | **B** | **EXPECTED PGlite 归属，最强**。量的就是 INV-DB-01…07 那套目录租约/快照/恢复。⇒ **原门保留，PG 侧不映射**；PG 的对应物是 `INV-DB-08/09`（ADR-132 §5）与 **PG-G03** |
| `td10:reliability` / `td12:privacy` | A/C | 不改 |

### 2.4 M9–M10 阶段（认知与订阅）

| 门 | 类别 | 处置 / 归属 |
|---|---|---|
| `m9:wp0:baseline` / `m9:wp0:admission` / `m9:wp0r:verify` / `m9:test` / `m9:verify` / `m9:invalidation:verify` / `m9:runtime:verify` / `m9:context:verify` / `m9:perf:baseline` / `m9:e2e:verify` / `m9:scale:verify` / `m9:measurement:verify` / `m9:source:verify` | C | 断言不改。`m9:e2e:verify` / `m9:scale:verify` 纳入 **PG-G08.2/G08.3** 的对照 |
| `m9.5:*`（baseline / poc / a3:arm / long / embedding:* / corpus / aggregator / regression） | C/**D** | `m9.5:aggregator:verify` 是选档门（E）。**D**：向量距离与等距集合语义 ⇒ **PG-G06.2/G06.3/G06.4** |
| `m10:activation:readback` / `m10:realdb:invariant` | **C（含真 PG 价值）** | 这两个是"只读快照副本 + 真实会话读数"的形状 ⇒ 值得**优先**在 PG 上复跑（WP5） |
| `m10:semantic:eval` / `m10:smoke:live` / `m10:long:live` / `m10:onpath:live` | C/D | 真模型链 ⇒ **PG-G08.7**（外部发送受控）+ **S7** |
| `m10:preflight` / `m10:scale:verify` / `m10:regression:verify` | C | 断言不改 |
| `m10:gates` / `m10:activation:verify` / `m10:evidence:verify` / `m10:docs:verify` / `m10:review:materials` / `m10:oracle:verify` / `m10:gateway:verify` / `m10:long:verify` / `m10:e2e:verify` / `m10:measurement:verify` / `m10:coverage:verify` / `m10:m11:verify` / `m10:semantic:dry` | E/A | 不改 |
| `memory-coverage:verify` / `memory-coverage:e2e` / `extractor:value-boundary:verify` | C | 断言不改；纳入 **PG-G08.1** 对照 |
| `m9.6:test` / `m9.6:measurement:verify` / `m9.6:audit-parser:verify` | A/C | 不改 |

### 2.5 post-Lv2 阶段（入口 / 共存 / 主动联系 / 桌面）

| 门 | 类别 | 处置 / 归属 |
|---|---|---|
| `postlv2:s8:start:verify` / `postlv2:s8:choice:verify` | C | 断言不改 |
| `productivity:verify` / `productivity:sidecar:autostart:verify` | C | 断言不改 |
| `m11.1` | C/E | 见 `docs/m11.1/`；历史读数为 NOT PASS，**本迁移不改它的结论** |
| `desktop-control` / `productivity` | A/C | 不改 |
| `scripts:catalog:verify` | A | **WP1 起必须同步更新**（新增 PG 脚本要进 Scripts-Catalog） |

⚠️ **`docs/architecture/Scripts-Catalog.md` 与 `scripts/gates/affected-map.ts` 都是"只追加"的登记面**。
WP1 起每加一个 PG 脚本/门，这两处必须同时更新（否则 `pnpm fast` 会出现"改了 PG 脚本什么都没红"的洞 ——
这正是本仓库在 QQ 主动联系批次踩过的坑，见 AGENTS.md 的对应段）。

### 2.6 复用 key 与聚合 key（**不是**独立门）

`offline` / `summaries` / `all` / `td` / `m9` / `m9.5` / `m10` / `m10-semantic` / `memory-coverage` /
`m9.6` / `postlv2` / `postlv2-controls` / `lv2` / `summaries-all` / `scripts` / `affected` ——
它们是**分组/聚合标识**，不是新门。⇒ **不加 PG 门进任何聚合 key**，除非有独立裁定
（理由：计划 §9 逐字禁止把 FAIL/NOT RUN 汇成 PASS，而聚合最容易破坏这条）。

---

## 3. 必须新增的 PG 门（标识在 WP0 定稿，命令在 WP1–WP5 登记）

计划 §5 逐字："以下是拟新增门的职责标识，**不是当前已存在的 pnpm 命令**。WP0 定稿标识，
WP1–WP5 实现后再登记实际命令。每个门要求 `measured_count > 0`；缺证据、错误后端、指纹不适用、关键断言失败均拒收。"

| 门标识 | 范围 | 落地包 | 命令登记状态 |
|---|---|---|---|
| `PG-G01` 配置与隔离 | 程序 + 真 PG | WP1 | ✅ **已登记**：`pnpm postgresql:g01:verify` —— **42 正控 + 2 负控 · 0 失败 · 0 NOT RUN**（`measured_count = 44`）。⚠️ 原来那三条 `*-real-pg` 的 NOT RUN **已清空**（理由是过时的）：`G01.5`/`G01.8` 已于 WP2 在真 PG 上关闭，`G01.7` 的**行为面搬到 `PG-G02`**，本门只留纯函数真值表。它**留在 `offline` lane**（不需要实例 ⇒ 被核心 CI 覆盖） |
| `PG-G02` schema 与权限 | 真 PG | WP2 | ✅ **已登记**：`pnpm postgresql:g02:verify` —— **31/31 · 0 失败 · 0 notRun**（`measured_count = 31`）。含 `G01.7-real-pg` 的**行为面**（同进程换目标 ⇒ 具名拒绝；重复同一目标 ⇒ 放行）。⚠️ **有意不并入 `offline` lane**（同 `desktop-control` 先例）：它**需要**在跑的隔离 PG 实例，塞进 offline 等于让核心离线 CI 依赖 Docker。它在**自己的 `postgresql` lane** 里、标 `serial`。拿不到实例时**非零退出**并具名报 notRun |
| `PG-G03` 生命周期与写入资格 | 真 PG + **两个 OS 进程** | WP3 | ✅ **已登记**：`pnpm postgresql:g03:verify` —— **23/23 · 0 失败 · 0 notRun**（`measured_count = 23`）。含：两个真实 OS 进程的第二核心拒绝 / 锁丢失由**可观测事件**检测 / **服务器重启 ⇒ 资格被观测到失效且可重新取得** / 只读不受限 / lockId 与 plugin-sql **不同源** / 装配根接线的 4 条**结构性**断言。⚠️ 它会 **`docker restart` 容器**（故必须 serial，且无论成败都等实例回到健康）· 结构性断言**不**等于"真的起两个生产核心"—— 那属 WP6 演练 |
| `PG-G04` SQL/仓储兼容 | 真 PG | WP2/WP4 | ✅ **已登记 · PASS**：`pnpm postgresql:g04:verify` —— **20/20 · 0 失败 · 0 notRun**（`measured_count = 20`）。七组：**JSON/null**（jsonb 往返含嵌套/数组/null/中文/大整数字符串逐字不变；`null` 与**缺键**可区分；真库 `state` 列 `jsonb_typeof` = object）· **bigint 边界**（`9007199254740993` 在 **SQL/文本层**往返不丢；如实记录 JS number 丢成 `…992`）· **`RETURNING`**（返回写入后的值）· **唯一/部分索引**（普通唯一 ⇒ `23505` 且行数不变；**部分**唯一 ⇒ 谓词命中报 `23505`、**不命中不拦**；主键 ⇒ `23505`）· **幂等**（事件键 / 任务键 / 已处理操作表 `recorded:false`）· **乐观冲突**（错的 `expectedRevision` ⇒ 具名 `projection_revision_conflict` 且 **revision 仍是 1**）· **事务原子性**（事务内撞主键 ⇒ 整体回滚 **0 行**）· **四仓储真实执行**（Event / Conversation / Memory / Job + 水位前进）。⚠️ 真实库目录逐字未动 · ⚠️ 必须 serial |
| `PG-G05` 迁移完整性 | 隔离源副本 + 真 PG | WP4/WP5 | ✅ **已登记**：`pnpm postgresql:g05:verify` —— **29/29 · 0 失败 · 0 notRun**（`measured_count = 29`）。**全库逐表规范化内容摘要**：54 张表（public 51 + migrations 3）/ **4 261 行**，`G05.1` 表清单**双向**差集为空 · `G05.2` 主键集合 + 列规格逐表一致 · `G05.3` **54/54 摘要一致** · `G05.8` 无主键表（`public.logs` 421 行，全库唯一）走**稳定行多重集** · 主题面（`G05.4` 撤回/归因取值面 · `G05.5` 生命周期字段非空计数 · `G05.6` 12+3 水位与 2 个序号 · `G05.7` 插件七表 · `G05.9` 18 行登记表）逐项相同 · **六条真数据负控**触达四条具名原因（删行 / 改主键 / 改归因 / 改向量 / **回退水位** / 无主键表改一行）· `G05.R` 重新恢复一次 ⇒ 又全部一致。⚠️ 14 张空表只做到结构性一致、无 numeric/bytea 列（`L-PGW5-01…03`） |
| `PG-G06` 投影与语义召回 | 真 PG | WP5 | ✅ **已登记 · PASS**：`pnpm postgresql:g06:verify` —— **30/30 · 0 失败 · 0 notRun**（`measured_count = 30`）。恢复确定性（同一份导出恢复两次逐行相同）· **六个 store 级重建**全部返回（生产代码）· 重建不写领域事件（470→470）· 等距按**集合**比 · vector 版本差异显式记录（源 **0.8.0** → 目标 **0.8.7**）· 相同向量最近邻距离≈0 · 编码器指纹 A==B（`semantic-render@1`/`@2` 共存）· 向量逐字未变 · **`G06.1k` 真实库目录逐字未动** · **`G06.1f` 投影重建 A == B 逐行相同**（18 行差异已由 ⓓ 受控重建消除）· **`G06.1m` 源侧已修**（存的 revision 与折叠值逐行相等：`deltaSum=0` · `stateEqual=19`）。来源 = **新基线** `pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd`。⚠️ 有意不并入 `offline` lane |
| `PG-G07` 在线备份恢复 | 真 PG + 独立进程 | WP4/WP5 | ✅ **已登记**：`pnpm postgresql:g07:verify` —— **47/47 · 0 失败 · 0 notRun**（`measured_count = 47`）。含：**并发写入进程**（真实 OS 进程）在写库时**不停任何东西**做在线 `pg_dump`（416ms）· 恢复到**新空库**（exit 0 无 ERROR）· **篡改 / 截断 / 抹尾 / 空 / 缺 / 非 dump** 六种**互不相同**的具名拒收（且**拒收发生在恢复之前**）· 备份里是**连续前缀且每批恰好 2 行**（没有半提交）· 每批与**提交后记录**逐字一致 · 静默态对照 dump 证明"两份取自不同时刻" · 源与目标身份**分开**记录 · **库外资产**按 manifest 验证（改/删/加 三种具名拒收 + **完整性判据**：`data/` 下每个目录都有具名归属）。⚠️ "活动"是**并发写入进程**而非真实核心（`L-PGW4-07`）；逐表只做到**行数**一致（`L-PGW4-13`，内容级属 WP5） |
| `PG-G08` 功能整链与回归 | 真 PG + 隔离 provider / 有限真模型 | WP5 | ⚠️ **已登记 · 断言 20/20 全过但有 2 项具名未运行 ⇒ 不报 PASS**：`pnpm postgresql:g08:verify` —— **20/20 · 0 失败 · 2 notRun**（`measured_count = 20`，退出码 **1** 是"缺证据拒收"不是"断言红"）。同一个 PG 目标上**起两次真核心**：**记忆增改撤回**（`appendDomainEvent`+`applyMemoryEvent` 真事件溯源；真 store 读回 active；同事件重折 `created:false`；supersede ⇒ 旧 `superseded` 且 `supersededBy` 可追溯；retract ⇒ 不再 active）· **通知**（`repeat_mode=until_reply` 落库；同 `occurrenceKey` 第二次 `created:false`；`deferOccurrence` 对 reminder 具名拒绝 `occurrence_defer_not_care`、对 care 成功；`pendingCareDeferrals` 还压着 1 / 到点 0）· **重启续跑**（核心 #2 起得来；记忆逐行一致；领域事件数不增；投影摘要不变；**水位 12 行摘要不变**；通知意图/实例跨重启存活且同键仍 `created:false`）· **断连恢复**（关库后旧句柄查询必须失败；重连后数据仍在）· **外部发送受控**（0 通道/0 QQ 进程/0 外发尝试，读数里无真实联系人字段）。**未运行**：`g08.6` 后台消费者长跑 · `g08.7` QQ/Live2D 双入口路由。⚠️ 真实库目录逐字未动 · ⚠️ **必须 serial** |
| `PG-G09` 量具有效性 | 新比较器/选档器 | WP4/WP5 | ✅ **已登记**：`pnpm postgresql:g09:verify` —— **23/23 · 0 失败 · 0 notRun**（`measured_count = 23`）。三段式：正控（含**真跨驱动** PGlite→真 PG）/ 负控（**四条互不相同**的具名原因：`row_count_differs` · `primary_key_set_differs` · `content_digest_differs` · `multiset_differs`）/ 恢复。⚠️ 目前只在**一张 18 行的真表**上做过真跨驱动验证（`L-PGW4-01`：bytea/vector/uuid/数组/时区未在真数据上验证）—— 全库那一步由 **`PG-G05`** 承担（54 张表 / 4 261 行） |
| `WP5 资源读数`（S8） | 真 PG + 同一快照的 PGlite 副本 | WP5 | ✅ **已登记**：`pnpm postgresql:bench:verify` —— **12/12 · 0 notRun**（`measured_count = 12`）。两侧 = **同一份快照**（`B03` 断言同一条查询两边结果相同）。**①服务端执行时间**（`EXPLAIN ANALYZE` 的 `Execution Time`，两侧可比）：8 条固定查询全部**亚毫秒**（PG p50 0.061–0.480 / PGlite 0.054–0.643）。**②端到端往返**：PG 侧在**同一个 psql 会话**里 `\timing` 连跑 20 次（每题 20 个样本，`B06` 断言）；PGlite 进程内。**资源**：PG 库 19.7 MB vs PGlite 目录 49.0 MB · 容器空闲 0.02%/78.9 MiB ⇒ **负载下 83.28%/82.96 MiB** · 负载下连接数 **2**。**并发只读**：写入进行中连续读 4 秒 **24/24 成功 0 失败**。**写入进行中的备份**：**231 ms · 11.1 MB · exit 0**，期间提交 129 批。⚠️ **不设性能目标、不判优**（`B11` 结构性断言：读数里不许出现 faster/winner/speedup）· ⚠️ **真实库目录逐字未动**（`B10`）· ⚠️ **必须 serial**（会起写入进程） |
| `PG-G10` 切换就绪 | 只读审查 | WP6 | ✅ **已登记 · PASS**：`pnpm postgresql:g10:verify` —— **17/17 · 0 失败 · 0 notRun**。**只读聚合器**（不连库、不跑门、不改东西）：读已落盘证据 + WP6 四份文档。断言：G04/G05/G06/G07/G08/G09/S8/LIVE 的**最新证据**全过且**分母非零**（按 `runId` **字典序**选档，**不看 mtime**）· G02/G03 证据在案（⚠️ **旧形态**无 `counts`，本条**只证"有档"**）· **run 归属**（所有门记的来源快照是同一个）· **恢复演练**（G07 的备份/恢复族 18/18）· **四份文档**逐要素齐（Activation-Candidate/Runbook/Known-Limitations/Gate-Decision）· 旧后端回归适用（⚠️ 本轮只证"证据目录在案"⇒ `L-PG-16` 仍是 PARTIAL）。⚠️ **必须最后跑**（读的就是别的门刚写的证据） |
| `PG-P01` 生产执行 | WP7 专属 | WP7 | 未登记 |
| `PG-P02` 生产使用 | WP8 专属 | WP8 | 未登记 |

**命名与登记纪律（WP0 裁定）**：

```text
① 门 id 用 `PG-G0x` / `PG-P0x`（与既有门 id 命名风格一致：全小写字母数字 + 冒号分隔的对照口径：
   pnpm 脚本名形如 postgresql:g01:verify；manifest 里的 id 形如 PG-G01）。
② **不与既有门同名、不覆盖既有门**。PG 门一律是**新增**。
③ 每条 PG 门在 manifest 的 `resources` 里必须写清楚：是否碰真实库（`realDb: true`）、
   是否并行安全（PG 门一律 `serial` —— 它们要独占一个隔离 PG 实例）、证据写入路径。
④ 每条 PG 门的 `why` 要写依据（行号级别），与既有 manifest 的纪律一致。
⑤ 每条 PG 门的证据必须含 ④「实际后端」字段（连接后读回），不能只写配置声明。
⑥ PG 门**不进**任何聚合 key（§2.6）。
```

---

## 4. 数据来源：隔离 PG 实例的归属（WP0 先定，WP2 实施）

| 用途 | 实例 | 生命周期 | 与生产的关系 |
|---|---|---|---|
| PG-G01/G02/G04 门 | 每个门**自己的**一次性隔离库（同一 PG 服务、不同 database） | 门结束时删除 | **不得**与生产库同 database |
| PG-G03 门 | 一个专用实例 + 第二个只读客户端 | 门结束时停止 | 同上 |
| PG-G05/G06 门 | 一个从**源副本**导入的目标 | 保留到比较完成 | 目标身份**重设**（不用源身份） |
| PG-G07 门 | 备份 + **另一个**新空目标 | 保留证据（manifest） | 同上 |
| PG-G08 门 | 隔离 PG + 隔离 provider | 门结束时清理 | **不向真实联系人发测试消息** |

⚠️ **同进程多目标的池问题（计划 §3.2 逐字）**：插件池的全局键是
`` `${managerKey}:${useNeonDriver ? 'neon' : 'pg'}` ``，`managerKey` 缺省 `'default'` —— **不含连接地址**。
⇒ 同进程切换不同 PG 目标会**复用旧池**。
⇒ WP0 裁定：**首期隔离库一律独立进程**（计划 §3.2 已给出的路线）；同进程多目标路径必须**拒绝**
或有**已验证**的隔离实现。**禁止**直接清空缓存掩盖悬空连接（这正是 `D12` 缺陷①的形状）。

---

## 5. 每包的必跑门（最小纪律 + 交付纪律）

| 包 | 最小纪律（改完就跑） | 交付纪律（包收口） |
|---|---|---|
| WP1 | `pnpm typecheck` + `PG-G01` + `m4:isolation:verify` + `m3:migrate-gate` | 同左 + `m4.5:ci` |
| WP2 | `pnpm typecheck` + `PG-G02` + `PG-G04` | 同左 + `m4.5:ci` |
| WP3 | `pnpm typecheck` + `PG-G03` + `m4:faults` + `m4:restart:verify` | 同左 + `m4.5:ci` |
| WP4 | `pnpm typecheck` + `PG-G05` + `PG-G07` + `PG-G09` + `m4:restore:verify`（**PGlite 归属，回归适用性**） | 同左 + `m4.5:ci` |
| WP5 | `pnpm typecheck` + `PG-G06` + `PG-G08` | **`pnpm m4.5:ci` 必须 EXIT 0**（计划 §5 逐字）+ 受控真模型 smoke |
| WP6 | 只读审查 | `PG-G10` |
| WP7 | —（生产操作） | `PG-P01`；每步退出码在案 |
| WP8 | —（生产观察） | `PG-P02` |

**关于 `m4.5:ci` 的一条既有约束**（AGENTS.md 记录）：它的 G14 会对生产库做**热复制**，
而"复制前先停服务"是既有要求。⇒ PG 后端下这条**不再适用于 PG**（服务器独立），
但**PGlite 源库仍在** ⇒ WP5/WP6 必须明确：跑 `m4.5:ci` 时生产核心是**停**还是**跑**
（若跑，G14 的热复制在 PGlite 侧仍是不允许的）。**这是 WP6 Runbook 的必写项**，本轮只登记。

---

## 6. 不主张

```text
· 不主张上表任何一条门"已经跑过" —— WP0 没有跑任何门
· 不主张 118 个门都已逐条核对到行号 —— B/D 两类做了脚本级结构测量（上表列出命中数），
  其余按门的**职责**分类（A/E 类）并给出理由；WP1 落地时会逐条补行号级依据
· 不主张"253 个隔离脚本都已验证拒绝" —— §0 已写明只做代表性负控
· 不主张新增 PG 门的命令已存在 —— 它们全部是"未登记"
```
