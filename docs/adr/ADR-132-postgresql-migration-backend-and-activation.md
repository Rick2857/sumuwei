# ADR-132：生产后端从 PGlite 迁移到独立 PostgreSQL —— 后端选择、身份核对与不变量映射

```text
状态      : **ACCEPTED / DESIGN FROZEN**（2026-10-12 用户指令「按计划执行」⇒ 计划 §4 的 WP0 交付）
            —— 本 ADR 是 **WP0 的设计交付**；**实现尚未开始**，本文件不含任何"已实现"主张
日期      : 2026-10-12（Asia/Shanghai）
上游      : 执行计划（docs/post-lv2/PostgreSQL-Migration-Execution-Plan-2026-10-12.md）
            调研（docs/audit/2026-10-12-postgresql-migration-research.md）
            多用户/群聊/后台补充计划（docs/post-lv2/Multi-User-QQ-Group-and-Admin-Execution-Addendum-2026-10-12.md）→ 本 ADR 只做其 X0 的**接口预留**
            架构不变量（docs/architecture/invariants.md §「追加：真实数据库的单持有、快照与恢复」）
            INC-01 事故与追加处置（docs/audit/2026-10-08-recovery-test-isolation-incident.md）
            WP0 基线读数（docs/post-lv2/PostgreSQL-Migration-WP0-Baseline.md，runId pg-migration-wp0-20261012T232804）
本 ADR 回答: **后端怎么选、错配置怎么失败关闭、写入资格怎么失效保护、测试隔离怎么不串到生产、
            新旧不变量逐条怎么映射** —— 也就是计划 §3.1/§3.2 与 §4/WP0 点名的那些设计阻塞
裁定来源  : 用户 2026-10-12 的指令「按计划执行 docs/post-lv2/PostgreSQL-Migration-Execution-Plan-2026-10-12.md」
            ⇒ 计划 §1「第一阶段不同时引入新 ORM/独立向量库/Redis/PgBouncer/HA/K8s」与
              §2 的"固定版本、不接受 latest"是**上游约束**，本 ADR 不逐条重复、只在其内做选择
```

> **编辑约定**：`D01`…`D12` 是**已冻结的裁定**，实现阶段不得顺手改动；要改必须新开一次 ADR 修订并引用本文件。
> 本文件**只写设计**：任何"实测读数"都标注它的 runId 与证据文件，**不把设计写成已实现**。

---

## 0. Context

### 0.1 为什么需要这个 ADR，而不是"直接换连接串"

`plugin-sql@1.7.2` 的后端选择只有**一条**判据（WP0 从安装包读的，不是推测）：

```text
node_modules/@elizaos/plugin-sql/dist/node/index.node.js
  init:                   const postgresUrl = runtime.getSetting('POSTGRES_URL')
  createDatabaseAdapter:  if (config.postgresUrl) → PgDatabaseAdapter  (pg Pool max 20 / min 2)
                          else resolvePgliteDir(config.dataDir) → PgliteDatabaseAdapter
```

也就是说：**`POSTGRES_URL` 有值就是 PostgreSQL，没值就是 PGlite**，中间没有第三方判据。
而 LG 现有的三层生产保护**全部建立在"目录"这个概念上**：

| 既有保护 | 依据 | 换库之后为什么不够 |
|---|---|---|
| `assertDatabaseAccessAllowed()`（`src/db/index.ts:209`） | `PGLITE_DATA_DIR` 与 `isProductionDir(...)` | PG 后端下 `PGLITE_DATA_DIR` 仍然存在但**不起作用** ⇒ 闸门"看着在守，守的是空气" |
| Windows 独占租约（INV-DB-01，`production-open-guard.ts`） | 按**规范化 dataDir** 派生的 named pipe | PG 是独立服务，"打开目录"不再等于"取得独占" |
| 目录快照 / 恢复（INV-DB-02…07，`production-db-restore.ts`） | 复制 `PGDATA` 目录 | 不能复制运行中的 PG 数据目录；在线备份是另一套东西 |

⇒ 不写清楚"PG 后端下这三层各由什么接替"，就是**把生产保护寄存在一个不再被读的环境变量上**。

### 0.2 WP0 的读数（本 ADR 的事实基础）

| 事实 | 读数 | 证据 |
|---|---|---|
| 项目依赖 | `@elizaos/core|plugin-sql|plugin-bootstrap = 1.7.2` · `plugin-openai = 1.6.0` · `drizzle-orm = 0.45.4` | WP0 Baseline §4 |
| PGlite | `@electric-sql/pglite 0.3.16`（**不是**根依赖：由 plugin-sql 的依赖图提供） | 同上 |
| `pg` | `8.23.1`（同样**不是**根依赖） | 同上 |
| 导出工具 | `@electric-sql/pglite-tools` **不存在** | 同上 |
| Docker 引擎 | **未运行**（`docker info` 连不上 npipe）⇒ 镜像 digest / PG minor **NOT VERIFIED** | WP0 Baseline §2 |
| 来源库（2026-10-11T12:53Z 的 verified 快照副本读回） | **schema v18** · **51 张 public 基表** · 引擎 `PostgreSQL 17.5 … 32-bit` · 扩展 `vector 0.8.0` / `fuzzystrmatch 1.2` / `plpgsql 1.0` · `vector(384)` 一列 + 上游 6 个维度列 · 112 个索引（含 61 个 unique）· 52 个 bigint 列 · 52 个 json/jsonb 列 | `source-production-version-read.json` · `source-column-shape.json` |
| 迁移 17/18 的列 | **4/4 真的存在**（`delivery_channel` / `repeat_mode` / `deferred_until` / `repeat_attempt`） | `source-column-shape.json` `columnShapeAllMatch=true` |
| `ivfflat` / `hnsw` 索引 | **一处都没有**（`src/**` 与插件包全文搜 0 命中） | WP0 Baseline §6.2 |
| 当前 `.env` | 只有 `PGLITE_DATA_DIR=./data/pglite`；**没有任何 PG URL 键** ⇒ 现状仍是 PGlite | WP0 Baseline §5 |

### 0.3 本 ADR 与"多用户 / 群聊 / 后台"的关系

补充计划的 X0 要求"在 PG WP0 定稿前完成身份/来源可见性/原主人特权/条件印象/全局情绪与逐人关系的设计"。
**本 ADR 做不到也不试图做 X0**（那是独立的一批设计）。本 ADR 只做一件事：
**在数据库后端这一层预留接口**，使 X0/U1 之后不需要推翻后端设计。具体预留见 `D11`。

---

## 1. 决策总览

| # | 裁定 | 一句话 |
|---|---|---|
| D01 | 后端选择字段与规范化解析 | 新增闭集 `CHARACTER_DB_BACKEND=pglite\|postgres`，PG 连接串**沿用 `POSTGRES_URL`**，解析收敛到**一处纯函数** |
| D02 | 失败关闭语义 | 选定 PG 后，缺 URL / 连不上 / 身份不符 ⇒ **带具名错误码拒绝启动**，**禁止回落 PGlite** |
| D03 | 测试隔离在 PG 下的默认行为 | `isolateDatabase()` 在"PG 后端已配置"时**默认拒绝**（失败关闭）；允许 `postgres` 隔离要**显式**指向测试库 |
| D04 | 插件 bootstrap 与受限 runtime | 1.7.2 **没有**可关闭的自动迁移开关 ⇒ 走"预建 schema + 受限运行账号"；**只读入口不经 runtime 初始化** |
| D05 | 单认知执行者资格与失效保护 | 专用锁连接上的 session advisory lock + `(pg_backend_pid, generation)`；**池错误 / 锁连接丢失即失效**；一次获取**不构成**保护 |
| D06 | 生命周期与关闭 | 应用只关**自己的连接池**；关闭的判据是"关闭 Promise 成功"且本进程会话释放，**不是** `isClosed()` 标记 |
| D07 | 角色与权限分离 | 迁移 / 运行 / 只读 / 测试**四类账号**；只读账号靠 GRANT 造成，`default_transaction_read_only` 只当第二层 |
| D08 | 版本与镜像固定策略 | PG **17** major 固定；镜像、导出工具、扩展版本**固定到具体 digest / 版本**，**禁止 latest** |
| D09 | 查询参数类型与向量语义 | `vector(384)` 是**扩展类型**，参数化必须走 `::vector` 显式 cast；等距结果的比较按**集合** |
| D10 | 在线备份与恢复的对象边界 | `pg_dump`（逻辑）与目录快照（物理）**各归其位**；PG 侧恢复演练在**新目标**上做 |
| D11 | 为多用户/后台预留的接口 | 后端身份读回、作用域注入点、只读客户端**都从第一天就在**，X0/U1 不推翻它们 |
| D12 | WP0 复核中发现的两个既有真缺陷 | `resetPluginSqlConnection()` 的"清缓存不关池"与"早退"；PG 分支必须一并修掉 |

---

## 2. 决策明细

### D01 · 后端选择字段与"唯一解析结果"

```text
字段名      CHARACTER_DB_BACKEND            （闭集；非法值 ⇒ 失败关闭，不"猜一个"）
取值        'pglite' | 'postgres'           （只此两个；大小写不敏感，写入前 trim）
连接串      POSTGRES_URL                     （沿用插件真正读的那一个，见 0.1）
数据目录    PGLITE_DATA_DIR                  （后端 = pglite 时**必须**仍存在且仍是真实库闸的依据）
```

**裁定**：

1. 新增闭集字段，**不新造第二个连接串变量**（不引入 `LG_PG_URL` 之类）：`POSTGRES_URL` 是插件唯一认的名字，
   再发明一个只会让"插件读到的"和"我们以为的"分开。
2. **规范化只发生在一处**：`src/db/index.ts` 里一个纯函数，
   形状 `(env) → { backend: 'pglite'|'postgres'|'unset', postgresUrl?, dataDir?, problems: string[] }`。
   所有调用方（主程序、诊断脚本、测试、共存 supervisor）都读它的结果，**不许各自 `process.env` 一遍**。
3. `unset` 的语义 = **沿用今天的行为**（PGlite）。因此这个字段是**纯追加**：不设它，一切逐字节不变。
   ⇒ `m4.5:ci` 等既有门在未设该字段时**不受影响**。
4. 字段值非法（如 `postgresl` / 空串 / `pg`）⇒ 具名错误 `db_backend_invalid` 并拒绝；
   **不做"拼写纠正"，也不做"看起来像就当成它"**。

**为什么不是"有 `POSTGRES_URL` 就用 PG"**：那样"PG 后端"会被**任何**继承到该变量的子进程悄悄打开
（含测试、诊断、恢复脚本）—— 正是 INC-01 的同一形状（一个环境变量就能把保护打开）。
显式闭集字段让"换后端"成为**一个显式动作**。

### D02 · 失败关闭语义（四条，全部具名）

| 情形 | 错误码 | 行为 |
|---|---|---|
| `backend=postgres` 但 `POSTGRES_URL` 为空/仅空白 | `postgres_url_missing` | 拒绝启动 |
| `POSTGRES_URL` 存在但后端字段是 `pglite`/`unset` | `postgres_url_without_backend` | 拒绝启动（**防止"设了 URL 以为切了"**） |
| 已连上但 `current_database()` / `current_user` / 期望部署身份 与配置不符 | `db_identity_mismatch` | 拒绝，**在插件迁移、建档与任何业务写入之前** |
| 连接失败 / 池建不起来 | `db_connect_failed` | 拒绝启动 |

**裁定**：这四条一律**不回落**。计划 §3.1 逐字要求"指定 PostgreSQL 后禁止回落 PGlite"，
而它必须落成**可判定的错误码**，否则运维只会看到"它自己起成 PGlite 了"。

**日志纪律**：只记脱敏身份（database / user / host / port + 版本），**不打印密码、不打印完整凭证 URL**。
`POSTGRES_URL` 允许带密码，因此**禁止**把这个变量整体进任何日志、错误消息、trace 或证据 JSON。

### D03 · 测试隔离在 PG 下的默认行为

现状（`src/dev/sandbox.ts`）：`isolateDatabase()` 只做两件事 ——
`process.env.PGLITE_DATA_DIR = <tmp>` 与 `process.env.PROJECT_LG_SANDBOX = <tmp>`。

⚠️ **这就是计划 §3.1 点名的洞**：它**完全不处理** `POSTGRES_URL` / `DATABASE_URL`。
一旦 `.env` 带上生产 `POSTGRES_URL`，所有"已隔离"的实验脚本会**连上生产库**——
而它们的隔离断言（`assertIsolated()` 读 `PGLITE_DATA_DIR`）会**照样通过**。

**裁定（默认失败关闭）**：

```text
isolateDatabase(label)
  ├─ 若解析结果 backend === 'postgres' 且调用方未显式给出测试目标
  │      ⇒ 抛 db_postgres_isolation_not_provided（**不静默继续**）
  └─ 若调用方显式给出测试目标（第二个参数，形如 { postgres: { url } }）
         ⇒ ① 断言 url 的 host/port/database **不等于**生产目标（按解析后的值比，不按字符串比）
            ② 断言该 url 的 database 名带测试前缀（具名规则，WP1 定稿）
            ③ 把 POSTGRES_URL 设成它，并记一条"[sandbox] 本次实验已隔离（postgres）"
            ④ 仍设 PROJECT_LG_SANDBOX 标记（审计用）
```

**并且**：所有仓库级测试脚本**继承**到的 `POSTGRES_URL` 必须在**任何迁移/写入之前**被拒 ——
这一条是 PG-G01 的必测项，不是"读代码宣布"。

### D04 · 插件 bootstrap 与受限 runtime（1.7.2 的真实形状）

**已核实的事实**：

1. `plugin-sql` 的 `init` **无条件**调用 `createDatabaseAdapter(...)`，**没有**"关闭自动建表"的开关
   （WP0 读的是安装包 dist，不是上游最新源码；包元数据指向的 GitHub 仓库本轮访问 404）。
2. LG 自己的 `initDatabase()`（`src/db/index.ts:255`）在 `runtime.registerPlugin(sqlPlugin)` **之后**调
   `runtime.runPluginMigrations()`，然后才让 `initialize()` 去查表 —— 插件自己的表由它建。
3. LG 的 Kernel 迁移**另有一套**显式放行（`allowKernelMigration()` / `--migrate --apply`），与插件迁移无关。

**裁定**（把"bootstrap"与"runtime"分成两条路）：

```text
路线 A（运行核心）：迁移账号先把 schema 建好 → 运行账号启动
    判据：受限运行账号**不产生任何 DDL**。实现方式 = 运行账号在目标库上**没有 CREATE**；
          插件迁移是幂等 DDL，遇到"已存在"不会失败（这是可测的，不是假设）。
    风险：插件若在某次升级里新增一张表，受限运行账号会**失败**。
          ⇒ 这是**期望的**失败（失败关闭），不是缺陷。升级流程 = 先用迁移账号跑一次 bootstrap。

路线 B（只读诊断 / 备份观察）：**不走 runtime 初始化**
    用独立的 `pg` 客户端直连只读账号跑 SELECT。理由：`initDatabase()` **必然**触发
    `registerPlugin` + `runPluginMigrations`，把它排除在只读之外在 1.7.2 里做不到。
    ⇒ 计划 §3.1"只读入口零初始化写入"这句话，落到实现上就是**这条路线**。

不做的：不去谜改 `globalThis[Symbol.for('@elizaos/plugin-sql/global-singletons')]` 来"跳过 bootstrap"。
```

⚠️ **`pg` 必须成为显式依赖**：路线 B 的客户端不能用 pnpm 的传递可见性
（WP0 实测：根目录 `import '@electric-sql/pglite'` 直接 `ERR_MODULE_NOT_FOUND`）。这条是 WP1 的实现改动。

### D05 · 单认知执行者资格与失效保护

计划 §3.2 逐字要求："**获取一次 advisory lock 不构成完整失效保护**"。裁定的落实方式：

```text
资格 = 一个**专用连接**（不是从池里借一个还回去）+ 该连接上的 session 级 advisory lock
       + 记录在案的 (pg_backend_pid, generation)

取得：专用连接 pg_try_advisory_lock(<按角色派生的 bigint>)；
      拿不到 ⇒ 具名拒绝（第二个核心被拒），**不等待、不重试、不"试着跑跑看"**
失效：必须由**可观测事件**判定，而不是"以为还持有"：
      ① 该专用连接 error / end / 池 error 事件 ⇒ 立即撤销资格（停止接收新轮次）
      ② 取得时的 pg_backend_pid 与**同连接**上读回的 pg_backend_pid 不一致 ⇒ 视为已失效
      ③ 资格存续期间，**每次**落账前的一次轻量核对失败 ⇒ 撤销资格
撤销资格后：停止接收新轮次、取消未提交工作、保留已提交事实；
            **绝不**"再试一次拿锁"或"另开一个核心碰碰运气"
```

**关于 plugin-sql 自己的 advisory lock**：它只在 `migrate()` 里用，且把 lockId 定义为
`BigInt("0x" + sha256(pluginName).slice(0,8)) & 0x7fff…`（**63 位掩码**）。
这是**迁移互斥**，不是**认知执行者资格**；两者的域没关系。
⇒ WP3 的资格锁**不能复用**它的派生方式（那会让"迁移在跑"与"核心在跑"互相锁住）。

**首期明确不做**：不做跨机器自动接管（计划 §3.2 逐字）。`(pg_backend_pid, generation)` 也**不是**完整
fencing token —— 若 WP3 的故障门证明它不够，则回退到"被撤销资格后本进程拒绝一切写入"的
**自我隔离**实现，并在 Known-Limitations 里如实登记它挡不住什么。

### D06 · 生命周期与关闭

| 面 | PGlite（今天） | PostgreSQL（裁定） |
|---|---|---|
| 谁拥有生命周期 | 进程内的 PGlite 客户端 | **独立服务**；应用退出**不**停止服务 |
| 关闭对象 | `pgLiteClientManager.close()` | 本进程的 `pg` Pool：`await pool.end()` |
| 关闭成功的判据 | `closed === true`（如实问出来的） | **`pool.end()` 的 Promise 成功** + 本进程会话释放（以服务端视图核对，不以管理器标记） |
| 不许做的 | 删 PID/WAL"修好"检查 | **不复制运行中的 PGDATA**、不删 PID/WAL、不 `pg_terminate_backend` 别人的会话 |
| 关闭顺序 | 先停调度器再关库（既有纪律） | **同样**：先停调度器/消费者，再 `pool.end()` |

⚠️ **既有真缺陷（`D12`）**：`src/dev/sandbox.ts` 的 `resetPluginSqlConnection()` 在 PG 分支上
`postgresConnectionManagers?.clear()` **只清 Map 的引用、不调 `close()`** ⇒ 悬挂连接；
而且函数开头 `if (!bag?.pgLiteClientManager) return false` ⇒ **PGlite 管理器为空时直接早退**，
PG 池**根本不会被处理**。WP1 必须一并修（详见 `D12`）。

### D07 · 角色与权限分离

```text
角色                用途                          权限要点
────────────────────────────────────────────────────────────────────────────────
lg_migrate          建 schema / 应用迁移 / bootstrap   owner 级 DDL；**只**在受控迁移入口使用
lg_runtime          核心运行                      表级 SELECT/INSERT/UPDATE（DELETE 按需）；
                                                   **不**拥有表；**不**持 BYPASSRLS；**不**能 CREATE
lg_readonly         只读诊断 / 备份观察 / 后台只读查询  GRANT SELECT；`default_transaction_read_only=on` 作第二层
lg_test             隔离测试                       只能连测试库；**不得**能连生产库（连接层拒绝）
```

**裁定**：计划 §3.1 逐字"**不能仅设置 `default_transaction_read_only` 就把具有写权限的账号称作只读账号**"
⇒ 权限必须由 **GRANT** 造成，`default_transaction_read_only` 只是**第二层**。
PG-G02 的负控必须**实测**：`lg_readonly` 执行 INSERT / UPDATE / CREATE / 插件迁移 ⇒ 全部被拒。

### D08 · 版本与镜像固定策略

| 对象 | 裁定 | 当前状态 |
|---|---|---|
| PostgreSQL major | **17**（与来源引擎同一 major，减少跨大版本变量） | 来源实测 `17.5` |
| PostgreSQL minor | 记录部署时选定 major 的**受支持 minor** | **NOT VERIFIED**（Docker 引擎未运行） |
| 镜像 | pgvector 官方镜像，**部署固定 digest**；**禁止 `latest`** | 候选 `pgvector/pgvector:0.8.7-pg17-bookworm`；digest **NOT VERIFIED** |
| pgvector 扩展 | 目标版本由镜像提供；**必须显式记录并核对** | 来源 `0.8.0`，候选镜像 `0.8.7` ⇒ **版本漂移，见下** |
| 导出工具 | 与来源 PGlite **兼容**的版本，固定到具体版本 + integrity 复算 | **未安装**（`L-PGM-02`）⇒ WP4 前置 |
| 补丁更新 | 记录流程，不自动跟随 | WP6 写进 Runbook |

**pgvector 0.8.0 → 0.8.7 的版本漂移（必须如实登记）**：

```text
事实：来源库的扩展版本是 vector 0.8.0；候选镜像提供 0.8.7。
      pgvector 0.8.7（2026-10-05 发布）修的是 **IVFFlat 索引构建**的缓冲区溢出（CVE-2026-103484）。
实测：本仓库 `src/**` 与 plugin-sql 安装包全文搜 `ivfflat` / `hnsw` ⇒ **0 命中**；
      来源库的 112 个索引里也没有向量索引（`memory_semantic_index_scope` 是普通 btree）。
⇒ 裁定：① 固定 0.8.7（同 major，且修了 CVE）；② **不**主张该 CVE 在本仓库"已被触发过"，
        因为**根本没有 ivfflat 索引**；③ 迁移后**逐列核对 vector 列**的存在与维度（PG-G06），
        并在 PG-G05/G06 里显式记录两边的扩展版本差。
不做的：不为对齐扩展版本去重建向量索引 —— 没有向量索引可重建，且"重建"会改变派生数据的归属。
```

⚠️ **plan §2 的纪律**：候选不再适用时"记录事实与替换理由再继续，**不能自动使用 latest**"。
Docker 引擎当前未运行 ⇒ 上述两项**保持 NOT VERIFIED**，WP2 开工前必须补。

### D09 · 查询参数类型与向量语义

**裁定**：

1. `vector(384)` 是**扩展类型**。drizzle 的参数绑定不会自动 cast 它 ⇒ 所有向量查询**必须**显式写
   `… <=> ${vec}::vector` / `::vector(384)`。**不许**依赖隐式转换（在 PGlite 里可能恰好work，在真 PG 里会报类型错）。
2. `bigint` 列（`applied_at` / `created_at` / `deferred_until` 等）读回时**必须显式转**：
   `pg` 默认把 `int8` 解析成**字符串**（不是 number）。既有的"只用 `returning` 的结果、不猜驱动语义"
   纪律（`src/infrastructure/persistence/db.ts:84-97`）**继续有效**，并要新增一条 PG 专属断言：
   bigint 边界的读回形状（`PG-G04`）。
3. 向量最近邻的**等距结果**顺序不保证稳定 ⇒ 比较必须按**集合**（计划 §5 的 PG-G06 逐字要求）；
   `PG-G06` 还要固定"相同向量 → 固定查询 ID / 距离"，不只比条数。
4. `jsonb` 的比较与规范化：按**契约列**做规范化后比较（键序、数字编码、时间编码），
   不做"原文比原文"。

### D10 · 在线备份与恢复的对象边界

| 对象 | 手段 | 归属 |
|---|---|---|
| PG 逻辑内容 | `pg_dump` → 空目标恢复 | PG 侧（`PG-G07`）；PD 角色/ACL/search_path 单独处理 |
| PG 物理目录 | **不复制运行中的 PGDATA** | 服务器自己的活 |
| 库外资产（图片/个人资料库/…） | 独立路径 + 摘要 + manifest | 计划 §3.3 / WP4；**本轮只登记目录，未做摘要** |
| PGlite 源库 | INV-DB-01…07 **原样保留**（不改写、不机械套到 PG 的普通 SELECT 上） | PGlite 归属 |
| 恢复演练 | 在**新的**一次性 PG 目标上做；**不**覆盖首次发现的不一致 | `PG-G07` / 计划 §6.7 |

⚠️ 一条**不许混**的：`pg_dump` 的一致性快照只保证**单事务边界**；
"多条业务写入不是同事务"时，数据库一致快照**不能**证明业务操作整体完成（计划 §5 末尾逐字）。
⇒ 中间态必须**可恢复且符合既有事件/投影契约**，不许拿 dump 的一致性好坏替代业务原子性。

### D11 · 为多用户 / 后台预留的接口（只预留，不实现）

补充计划的 X0/U1 需要 RLS、作用域注入、可信身份。本 ADR **只预留三条**，使之后不用推翻后端设计：

```text
① 后端身份读回：开库后读回 (database, user, host, port, server_version, 扩展版本)
   ⇒ 后台"总览"页与运维手册直接用它，不需要为后台单独发明一套身份探测。
② 作用域注入点：连接池层必须能"在固定连接/事务内设置 session scope 并清除"
   （plugin-sql 的 withIsolationContext 已经是这个形状；**本轮不改它**）。
   预留的是**接口位置**：LG 自己的只读客户端也要有同一个形状，否则 U1 会出现两套 scope 语义。
③ 只读客户端从第一天就是**独立角色**（D07 的 lg_readonly）⇒ U1 的"后台只读查询"直接复用它。
```

**明确不做**：本 ADR **不**决定 RLS 策略、不决定可见性字段、不决定印象门槛。
那些是 X0/U1 的裁定，且计划 §11 已把顺序定成"作用域与拒绝契约设计 → … → 多用户私聊访问控制"。

### D12 · WP0 复核中发现的两个既有真缺陷（必须与 PG 分支一起修）

这两个是**读代码复核出来的**，不是本轮运行出来的（本轮没跑任何门）。登记它们的理由是：
**PG 分支会从它们上面长出来**，不修就会把缺陷带进新后端。

```text
缺陷①  `src/dev/sandbox.ts` 的 resetPluginSqlConnection()
        `bag.postgresConnectionManagers?.clear()`  **只清 Map 引用，不调 close()**
        ⇒ PG 连接池悬挂：换库时旧池仍在，新连接可能仍在写旧目标（计划 §3.2 逐字点名的形状）。
        影响面：现状下 PG 分支**从未走过**，所以今天无症状；PG 一上线立刻有症状。

缺陷②  同函数开头的 `if (!bag?.pgLiteClientManager) return false`
        ⇒ 在"只有 PG 池、没有 PGlite 管理器"的进程里**整个函数早退** ⇒ 连缺陷①的那行都到不了。
        修法：把两个分支分开判断；返回"实际关掉了什么"的具名结果（而不是 boolean）。
```

**裁定**：这两个缺陷随 **WP1** 一起修（属 `src/**` 改动，需 WP1 的授权范围），修的时候必须：
① 给出"关闭 Promise 成功"的证据（不是 `isClosed()` 标记，见 D06）；
② 加负控：**不调 close 而直接 clear** 的旧实现必须在门里**被判红**（否则修了也证明不了修了）。

---

## 3. 与既有里程碑/ADR 的关系

| 既有判定 | 本 ADR 是否动它 |
|---|---|
| M4/M4.5 的持久化与行动真相门 | **不动**。PG 后端下它们**照跑**；新增 PG lane 是**追加**，不替换 |
| INV-DB-01…07 的 PGlite 归属 | **保留**（见 §5）。**不**把"目录快照"那套机械套到 PG 的连接上 |
| INC-01 / AUD-ISO-01 | **继承处置，不因换库关闭**（计划 §2 逐字）。本 ADR 不开、不关任何事故 |
| M9.5 的语义索引（`memory_semantic_*`） | **不动语义**。只核验"同一批向量在真 PG 上距离与集合一致"（`PG-G06`） |
| `m4.5:ci` 的既有读数 | **不重跑冒充新证据**；PG 侧是新门、新 runId |
| 多用户/群聊（补充计划 X0/U1/G1/A1/A2/W2） | **不在本 ADR 范围**；只按 `D11` 预留接口 |

---

## 4. 计划 §2「WP0 要做的复核」逐条对账

| 复核项 | WP0 结果 | 证据 / 去向 |
|---|---|---|
| SQL 插件固定安装包、入口及内容摘要；不同时升级 ElizaOS | **DONE** | 版本见 0.2；入口 = `dist/node/index.node.js`；**不**升级 |
| ORM 项目依赖与插件内部打包版本分别记录 | **DONE** | 项目 `0.45.4`；插件内部另有打包（版本号不视为相同） |
| PGlite 导出工具兼容性 | **BLOCKED（具体结论：未安装）** | `L-PGM-02`；WP4 前置 = 固定版本 + integrity 复算 + 合成库试跑 |
| 从**合格快照副本**读取真实库实际版本 | **DONE** | `v18` / 51 表 / 迁移行 18；`source-production-version-read.json` |
| PG 镜像可拉取性、PG minor、扩展、架构、许可证、digest | **BLOCKED（具体结论：引擎未运行）** | `L-PGM-01`；许可证已知（pgvector = PostgreSQL License / MIT 类）；**digest 必须实测后才能写** |
| Docker 引擎状态、独立服务名/卷/端口、磁盘空间；**不擅自启动现有服务** | **PARTIAL** | 引擎状态 = 未运行；磁盘 = C: 109.7 GB 可用；独立服务名/卷/端口 = **WP2 才定**；**本轮未启动任何服务** |
| 工作区：记录 HEAD、owned paths 与相关源码指纹；不收编他人修改 | **DONE** | Baseline §3（12 个文件指纹 + owned paths + "不认领 AGENTS.md"） |
| 事故：继承处置记录，不以本次换库关闭旧事故 | **DONE** | §3 表格；`AUD-ISO-01` 继续 OPEN |

---

## 5. 新旧不变量映射（INV-DB-01…07 逐条）

原文见 `docs/architecture/invariants.md` 的 §「追加：真实数据库的单持有、快照与恢复」。
**本 ADR 不改原文**（那是冻结文档），只登记"PG 后端下每条由什么接替"。

| 不变量 | PGlite 原文（要点） | PG 后端下的裁定 |
|---|---|---|
| **INV-DB-01** 真实库是跨进程单持有资源（Windows named-pipe 租约） | 保留 | **新增同族不变量 `INV-DB-08`**：PG 的"单一权威"由 **D05 的资格锁**表达；**目录租约不再适用于 PG**（PGDATADIR 不在应用手里） |
| **INV-DB-02** 快照只允许来自静止源 | 保留 | **等价物 = `pg_dump` 的同一逻辑快照 / 受控写入屏障**（计划 §5 末尾逐字）；"热复制 PGDATA"**禁止** |
| **INV-DB-03** 快照必须"复制→校验→健康→晋升"，manifest 最后写 | 保留 | **等价物 = 备份 → 恢复到新目标 → 校验 → manifest**；**永不打开待保留的快照本体**这条纪律在 PG 侧没有对应物（PG 备份不是目录） |
| **INV-DB-04** 最后一份健康快照单调保留 | 保留 | **等价物 = 备份保留策略**（首期 `pg_dump` 周期 + 保留份数，WP6 写进 Runbook）；**不**把 PGlite 的"最近 3/10 份"机械搬过来 |
| **INV-DB-05** 打开之前必须已有本进程的 pre-open token | **保留 PGlite 侧**；PG 侧 **新增 `INV-DB-09`**：开库前必须完成**身份核对**（`current_database` / `current_user` / 期望部署身份），且**在任何迁移与业务写入之前** | |
| **INV-DB-06** 收尾唯一，且"关闭是问出来的" | **保留**；PG 侧的"问"= **关闭 Promise 成功 + 本进程会话释放**（`D06`），**不是** `isClosed()` 标记 | |
| **INV-DB-07** 恢复是原子切换，失败保留现场 | **保留 PGlite 侧**；PG 侧是**另一个动作**（恢复到一个**新目标**再切换连接），**不套用 rename 三步** | |

**新增三条不变量的登记口径**（`INV-DB-08/09` + 状态）：

```text
INV-DB-08  同一角色的认知执行者资格由**专用连接上的 session advisory lock + 可观测失效**表达；
           读取/备份连接**不参与**该资格；一次获取不构成完整失效保护。
           ⚠️ 本条与 `D12` 的修法同属 **WP3/WP1 落地**；WP0 只登记设计，**不主张已存在**。

INV-DB-09  开库前身份核对（database/user/host/port/部署身份），不一致则在迁移与写入之前拒绝。
           属 **WP1 落地**；WP0 只登记设计。

（INV-DB-10 预留位：多用户 RLS 与作用域 —— 由 X0/U1 定稿，不在本 ADR）
```

⚠️ **不变量文档的更新**留给**落地时**（WP1/WP3 各自 commit 追加）。
理由是：现在往冻结文档里写"INV-DB-08/09 成立"，而实现还没有 ⇒ 那正是本仓库反复记录的
"可携带字段表与类型定义不同步"的同族错误。

---

## 6. 后果（Consequences）

**好的**：

1. 换后端成为**一个显式动作**（D01），而不是"某个环境变量被继承到"。
2. 生产保护从"目录"迁到"身份 + 资格"，且**每一条都有具名错误码与负控**（D02/D05）。
3. 测试隔离的洞（`POSTGRES_URL` 不处理）在**默认失败关闭**的语义下先被堵住（D03）。
4. 两个既有真缺陷（D12）在 PG 分支长出来之前被登记，不会被带进新后端。
5. pgvector 版本漂移如实登记，且**不主张**一个没有索引会被触发的 CVE（D08）。

**代价 / 明确承担**：

1. **两套后端共存期**：PGlite 的门与 PG 的门并行存在，门表变长，运维要知道"哪条门量的是哪个后端"。
   ⇒ 用**命名前缀**（PG-G0x）与"后端归属"字段解决，不靠人的记忆。
2. **受限运行账号可能在插件升级时启动失败**（D04 路线 A）。这是**有意的**失败关闭，但会增加升级步骤。
3. **首期不做跨机器接管**，也不做 PITR/WAL（计划 §8 逐字）⇒ RPO/RTO 如实记录，不承诺无损回滚。
4. `pg` 成为显式依赖 ⇒ `package.json` / lockfile 会变（WP1）。

---

## 7. 未决（留给后续 WP 或需独立裁定）

| # | 未决项 | 归属 | 触发条件 |
|---|---|---|---|
| U1 | 镜像 digest 与 PG minor | WP2 | 需 Docker 引擎运行（`L-PGM-01`） |
| U2 | PGlite 导出工具版本与兼容性 | WP4 | 需安装 + integrity 复算（`L-PGM-02`） |
| U3 | 测试库命名规则与 `lg_test` 连接拒绝的实现位置 | WP1 | `D03` 的细则 |
| U4 | 资格锁的 lockId 派生规则（不许与 plugin-sql 的迁移锁同源） | WP3 | `D05` |
| U5 | `(pg_backend_pid, generation)` 是否够用作 fencing | WP3 | 若不够 ⇒ 自我隔离实现 + Known-Limitations |
| U6 | 是否改走本机原生 PostgreSQL（替代 Compose） | 需独立裁定 | `L-PGM-01` 如果长期无法启动 Docker 引擎 |
| U7 | 多用户 RLS / 可见性 / 印象门槛 | X0/U1 | 补充计划 §7 |

---

## 8. 本 ADR 明确**不**主张的

```text
· 不主张 PostgreSQL 兼容性通过（本轮从未运行 PG）
· 不主张实现已完成（D01…D12 是设计冻结，`src/**` 一字未改）
· 不主张 INV-DB-08/09 已存在（只登记设计，落地在 WP1/WP3）
· 不主张 D12 的两个缺陷已被修（只登记；修在 WP1）
· 不主张镜像/工具版本已固定（引擎未运行、工具未安装 ⇒ 保持 NOT VERIFIED）
· 不主张本轮关闭或推进任何历史事故、里程碑或技术债
```
