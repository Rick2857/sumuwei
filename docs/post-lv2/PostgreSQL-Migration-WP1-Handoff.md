# PostgreSQL 迁移 WP1：后端入口与强隔离 —— Handoff

日期：2026-10-12（Asia/Shanghai）。runId：`pg-migration-wp1-20261012T235534`。
状态：**WP1 已实施**；门 `PG-G01` 已登记并 **PASS（37 正控 + 2 负控 · 0 失败 · 3 条如实 NOT RUN）**；
生产**未切换**（`.env` 未改）；真实库**未被打开**。
上游：[执行计划](PostgreSQL-Migration-Execution-Plan-2026-10-12.md) §4/WP1 ·
[ADR-132](../adr/ADR-132-postgresql-migration-backend-and-activation.md)（`D01`/`D02`/`D03`/`D12`）·
[验收契约](PostgreSQL-Migration-Acceptance-Contract.md)（`PG-G01`）·
[门矩阵](PostgreSQL-Migration-Gates-Matrix.md) · [WP0 基线](PostgreSQL-Migration-WP0-Baseline.md)。

按计划 §4 的六项逐节分列。

---

## 1. 实际改动路径

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/infrastructure/persistence/database-backend.ts` | **新增**（27.6 KB） | 后端闭集解析、目标三元组比较、身份核对（纯函数）、开库前判据、隔离判据、脱敏 |
| `src/infrastructure/persistence/db.ts` | 改（+读回） | 新增 `readDatabaseIdentity()` / `verifyDatabaseIdentity()`（**唯一**允许碰 SQL 的目录不变） |
| `src/db/index.ts` | 改 | 开库闸并入后端配置判据；**连接后、迁移前**身份核对；`DbReady` 追加 `backend` / `identity` |
| `src/dev/sandbox.ts` | 改 | `isolateDatabase()` 的 PG 分支（默认失败关闭）；`assertIsolated()` 双判据；`assertConnectedToSandbox()` 直问 `current_database()`；**修掉 `D12` 的两个真缺陷** |
| `scripts/postgresql-g01-verify.ts` | **新增**（32.1 KB） | `PG-G01` 门 |
| `src/…` 其它 | **零改动** | 见 §7 的"没有改什么" |

指纹（SHA-256 前 16 位 / 字节）：

```text
src/infrastructure/persistence/database-backend.ts   228a16196094be1d   27643
src/dev/sandbox.ts                                   1c15994e18496395   21382
src/db/index.ts                                      abf4e62250868399   20611
src/infrastructure/persistence/db.ts                 6769afff64d82b6e   12001
scripts/postgresql-g01-verify.ts                     6a6f4089c1bc1c78   32108
```

登记面（"只追加"口径）：

```text
package.json                          + "postgresql:g01:verify"
scripts/gates/manifest.ts             + 门 postgresql:g01:verify（resources 逐条核对后填 SAFE_PURE）
scripts/gates/affected-map.ts         + 两条规则（src/dev/sandbox.ts / database-backend.ts + db.ts）
docs/architecture/Scripts-Catalog.md  重新生成（生成物；同时带入其它在途会话的条目）
docs/Tech-Debt-Register.md            追加 R-71 / R-72（R-72 的修法状态在 §6 更新）
```

---

## 2. 改动前后的行为对照（**这是本包最要紧的一节**）

| 面 | 改动前 | 改动后 |
|---|---|---|
| 后端选择 | 只有"`POSTGRES_URL` 有值 ⇒ PG"（插件内部判据） | **显式闭集** `CHARACTER_DB_BACKEND=pglite\|postgres`；未设 ⇒ **逐字等于今天** |
| 有 URL 但没选后端 | 静默按 PG 走（继承到该变量的子进程会跟着换） | **具名拒绝** `postgres_url_without_backend` |
| 选了 postgres 却没 URL | 插件 `config.postgresUrl` 为空 ⇒ **静默回落到 PGlite** | **具名拒绝** `postgres_url_missing`（禁止回落） |
| 连上之后的身份 | PGlite：目录闸 + 租约 + pre-open token | **追加**：PG 侧读回 `current_database()`/`current_user` 并与期望比对，**在插件迁移之前** |
| `isolateDatabase()` | 只设 `PGLITE_DATA_DIR` + `PROJECT_LG_SANDBOX` | PG 后端下**默认拒绝**；给了测试目标还要过三道（可解析 / ≠生产 / 带测试前缀） |
| `assertIsolated()` | 只读 `PGLITE_DATA_DIR` | 按后端分判据（PG 侧问目标三元组） |
| `assertConnectedToSandbox()` | 只验"有 `character_schema_migrations` 表" | PG 侧**直问** `current_database()` 并与目标比对（PGlite 侧逐字不变） |
| `resetPluginSqlConnection()` | **只 clear 不 close** PG 池；PG-only 进程**整个函数早退** | 先逐个 `await close()` 再 clear；关失败如实计数并告警；两个分支互不短路 |

⚠️ 关键设计：**`CHARACTER_DB_BACKEND` 未设时一切逐字不变**。这是 `PG-G01 D02.12/D02.17`
两条断言在钉的东西 —— 它保证 `m4.5:ci` 等既有门**不受本包影响**。

---

## 3. 运行命令与退出码（本轮实际跑的）

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | **EXIT 0** | 0 错 |
| `pnpm postgresql:g01:verify` | **EXIT 0** | 37 正控 / 2 负控 / 3 NOT RUN；`measured_count = 39` |
| `pnpm m3:migrate-gate` | **EXIT 0** | 17 通过 / 0 失败 |
| `pnpm m4:isolation:verify` | **EXIT 0** | **22 通过 / 0 失败**（直接覆盖本包改的隔离语义） |
| `pnpm m4:test` | **EXIT 0** | 266 通过 / 0 失败 |
| `pnpm m4:verify` | **EXIT 0** | 147 通过 / 0 失败（真实库未被触碰） |
| `pnpm postlv2:database-env:verify` | **EXIT 0** | `productionDatabaseOpened: false` |
| `pnpm inc-01:test` | **EXIT 0** | 25 项断言 / 0 失败（含 **T24**：中央闸仍在 `registerPlugin` 之前） |
| `pnpm postlv2:affected:verify` | **EXIT 0** | 23 通过 / 0 失败（受影响门选择器自身） |
| `pnpm scripts:catalog:verify` | **EXIT 0** | 604 条一致 |
| `pnpm m4.5:ci` | **EXIT 0** | **完整离线门**：G12 38/0 · G13 32/0 · G14 52/0（三个 HARD GATE）+ G2 150/0 · L2 53/0 · G9 12/0 · 场景回归 7/0 · G14 选档器自证 5/5。日志 `artifacts/post-lv2/postgresql-migration/m45ci-wp1-20261012.log` |
| `pnpm postlv2:db:verify` | **EXIT 1（与本包无关）** | 它自报 `SNAPSHOTS PRUNED`：`PL2-AI-01` 需要的两份旧快照已被保留策略清掉 ⇒ **本次没有重测**（它自己读到的迁移清单是 v18，说明代码侧正常）。旧读数不因本结论改写。 |

**没有跑的**：`pnpm m4.5:ci:full`（含真实模型档；需要 `OPENAI_API_KEY`，且属**交付候选**纪律，
不是单个 WP 的最小纪律 —— 计划 §5 把完整 `m4.5:ci` 定在 WP5/交付候选，本包已额外补跑）。
另有三条 `PG-G01` 用例需要**真 PG 实例** ⇒ 见 §4.3（归 WP2）。

---

## 4. 门 `PG-G01` 的读数逐条

### 4.1 正控（37/37）

```text
D01.1 未设字段 ⇒ backend=pglite 且无问题（纯追加，既有入口不受影响）
D01.2 空串字段视同未设
D01.3 显式 pglite ⇒ 透传 dataDir
D01.4 显式 postgres + 合法 URL ⇒ 透传（trim 后）
D01.5 混合大小写字段值 ⇒ **拒绝**（不猜拼写）
D02.1 无 URL ⇒ postgres_url_missing
D02.2 非法后端值 5 例 ⇒ backend_unknown
D02.3 有 URL（含 DATABASE_URL）未选后端 ⇒ postgres_url_without_backend
D02.4 mysql:// ⇒ postgres_url_invalid
D02.5 后端判据与 plugin-sql 同形（含 :memory:）
D02.6 脱敏：密码与用户名都不出现；主机/端口/database 保留；解析不了 ⇒ 占位符
D03.1 回环别名 / 大小写 / 尾斜杠 / 默认端口 / scheme 别名 ⇒ 同一个目标
D03.2 不同 database / 不同端口 / 不同主机 ⇒ 判**不同**
D03.3 解析不了 ⇒ 视为"同一"（失败关闭）
D02.7 期望 database 相符 ⇒ ok
D02.8 期望不符 ⇒ ok=false 且具名（并与"相符"对照）
D02.9 期望 user 不符 ⇒ ok=false
D02.10 一条期望都不给 ⇒ ok=false
D02.11 期望从环境读；空串=不给
D02.12 未设字段 ⇒ 逐字退化成原 PGlite 目录闸（三分支全对）
D02.13 错配置**优先**被拒
D02.14 PG 后端 ⇒ PGlite 目录闸不适用
D02.15 有 URL 未选后端 + 目录闸放行 ⇒ 仍拒
D02.16 祖先环境继承 POSTGRES_URL ⇒ 未选后端则拒
D02.17 真实库目录 + 未放行 ⇒ 仍拒（本次修掉的假阴性）
D03.4 不给测试目标 / 空白 / 解析不了 ⇒ 全部拒绝
D03.5 带前缀且≠生产 ⇒ 放行
D03.6 隔离目标=生产目标（字符串与别名都不同）⇒ 拒
D03.7 不带测试前缀 ⇒ 拒
D03.8 前缀可用 LG_TEST_DATABASE_PREFIX 覆盖
D12.1 closePostgresPoolManagers 真的调了每个池的 close（含无 close 方法的项）
D12.2 关失败如实计数
G01.1 PGlite 后端 isolateDatabase 照常 + 开库步骤照常执行（**没被新闸误伤**的正控）
G01.6 继承到 POSTGRES_URL 的实验脚本 ⇒ isolateDatabase 直接拒（默认失败关闭）
G01.4 祖先 .env 的 POSTGRES_URL 真的被读到 ⇒ 隔离被拒 + 开库不执行
G01.7 显式测试目标（写进 .env 的后端配置）⇒ 隔离放行 + 开库前判据不误伤
G01.5 隔离目标解析后=生产目标 ⇒ 拒
```

### 4.2 负控（2/2，**红了才算过**）

```text
D03.6b 把比较器换成"判据不足"的那一个（不做规范化）⇒ 漏判**必须被暴露**。
       用"带前缀 + 尾斜杠"这一对，同时钉住两件事：
       · 比较器可被证伪（否则"我们比过了"这句话没有支撑）
       · 尾斜杠规范化确实在做工（本轮真踩到的洞：`.../db` 与 `.../db/` 曾是两个键）
D12.3  把"只 clear 不 close"的旧实现跑一遍 ⇒ "池真的被关了"这条断言**必须抛**
```

### 4.3 真 PG 用例（3 条）—— **2 条已于 2026-10-13 在真 PostgreSQL 上关闭**

```text
G01.5-real-pg  连到一个**真实存在但错误**的 PostgreSQL 库 ⇒ db_identity_mismatch（写入前拒绝）
G01.7-real-pg  同进程第二个 PostgreSQL 目标 ⇒ 拒绝或已验证的隔离实现
G01.8-real-pg  拒绝发生在任何 CREATE/INSERT/ALTER 之前（以目标库表数未变证明）
```

⇒ 三条都需要**隔离 PG 实例**，而那需要 Docker 引擎（WP0 `L-PGM-01`）⇒ 留到 WP2。
**不**用"纯函数通过"冒充它们通过。

**2026-10-13 修订读数**（用户授权启动 Docker 引擎 ⇒ WP2 建起隔离实例后补跑）：

```text
✅ G01.5-real-pg  真实存在但错误的库 ⇒ db_identity_mismatch（写入前拒绝）—— **CLOSED**
     读数：KernelError / code=db_identity_mismatch
           "database: 期望 lg_test_WRONG_NAME，实际 lg_test_wp2b（本次没有改动任何数据。）"
     旁证：期望 kernel_migration_pending 的那一步实际拿到 db_identity_mismatch
           ⇒ 身份核对**先于**插件迁移触发（顺序被真读数钉住，不是读代码宣布的）

✅ G01.8-real-pg  拒绝发生在任何 CREATE/INSERT/ALTER 之前 —— **CLOSED**
     读数：拒绝后重读 information_schema.tables ⇒ **0 张**（与拒绝前基线相同）
     ⇒ "在写入前拒绝"由**目标库表数未变**证明

⏳ G01.7-real-pg  同进程第二个 PG 目标 —— **仍 NOT RUN**
     为什么：它要驱动 LG 自身的连接池复用路径（plugin-sql 的池键**不含连接地址**）
     ⇒ 与 PG-G03（WP3）一起验，不单独凑一个读数
```

同批取得两条**本包代码在真 PG 上的正面读数**（WP2 的 `init-probe`）：

```text
· 适配器实测是 **PgDatabaseAdapter**（不是 PgliteDatabaseAdapter）
· 身份核对读回真服务端地址 `172.25.0.2/32:5432`（PGlite 嵌入式下这里是空 ⇒ 能区分后端）
· 从零建库后 public 表 **51 张** · Kernel schema **v18** · pgvector **0.8.7**
  —— 与 WP0 从来源快照读出的 51 表 / v18 **逐项对上**（扩展是预期的 0.8.0→0.8.7 漂移）
```

⚠️ 同批发现**两个换库才暴露的真缺陷**（`F-WP2-01` / `F-WP2-02`）：
`isDatabaseClosed()` 在 PG 下**假阴性**；**初始化失败不回收连接池 ⇒ 进程挂住**（真 PG 实测，
进程 14 分钟不退出且池里握着 1 个 idle 会话）。两者都属 **WP3** 的职责
（计划 §4/WP3 逐字包含"连接池关闭"与"初始化失败回收"），**本包不改源码**
（WP1 已收口且 `m4.5:ci` EXIT 0，改动会让那份读数指纹不适用）。

---

## 5. 配置档（本包新增的环境变量）

| 变量 | 取值 | 缺省行为 | 归属 |
|---|---|---|---|
| `CHARACTER_DB_BACKEND` | `pglite` \| `postgres` | **未设 ⇒ 等于今天（PGlite）** | `D01` |
| `POSTGRES_URL` | PG 连接串（唯一被插件读取的那一个） | 未设且选了 postgres ⇒ 拒绝 | `D01` |
| `LG_PRODUCTION_POSTGRES_URL` | 生产 PG 目标（**只在测试隔离的判据里**用） | 未设 ⇒ 少一层"等于生产"检查（另两道前缀/解析检查仍在） | `D03` |
| `LG_TEST_DATABASE_PREFIX` | 测试库前缀 | `lg_test_` | `D03` |
| `LG_PG_EXPECT_DATABASE` | 期望 database 名 | 不给 ⇒ 该项不判 | `D02` |
| `LG_PG_EXPECT_USER` | 期望账号（逗号分隔多个） | 不给 ⇒ 该项不判 | `D02` |
| `LG_PG_EXPECT_DATABASE_PREFIX` | 期望 database 前缀 | 不给 ⇒ 该项不判 | `D02` |
| `LG_PG_EXPECT_USER_PREFIX` | 期望账号前缀 | 不给 ⇒ 该项不判 | `D02` |

⚠️ **`LG_PRODUCTION_POSTGRES_URL` 未设时的语义必须说清**：那样"等于生产目标"这一条
**无从判定**，只剩"能不能解析"与"带不带测试前缀"两道。这是**刻意的**（不设那个变量就
没有"生产目标"可谈）；但也就意味着**WP6 的生产 Runbook 必须写明它要设**。已登记 `L-PGW1-01`。

⚠️ **切换后端时 `LG_PG_EXPECT_*` 至少要给一项**，否则 `initDatabase()` 会以
`db_identity_expectation_missing` 拒绝启动 —— 那是**有意**的失败关闭（换到 PG 却不说
什么身份算对，等于没有核对）。已登记 `L-PGW1-02`。

⚠️ **`.env` 本轮未改**（仍只有 `PGLITE_DATA_DIR=./data/pglite`）⇒ 现状**仍是 PGlite**。

---

## 6. 边界（`L-PGW1-01…07`）

```text
L-PGW1-01  `LG_PRODUCTION_POSTGRES_URL` 未设 ⇒ "隔离目标=生产目标"这条判不了。
           影响：少一层检查（前缀与解析两道仍在）。归属：WP6 Runbook 必写。

L-PGW1-02  切到 postgres 后至少要给一项 `LG_PG_EXPECT_*`，否则拒绝启动。
           **这是有意的**；风险是运维会以为"配好了却起不来" ⇒ Runbook 必写四个变量名。

L-PGW1-03  主机名**不做 DNS 解析**（刻意）：`db.internal` 与它的 IP 形式会被判成**不同**目标。
           代价：若生产目标用域名写、隔离目标用 IP 写，则"等于生产"这条**判不出来**。
           为什么不解析：DNS 会引入"网络依赖 + 解析歧义"两个新变量，两者都让判据不可测。
           缓解：`L-PGW1-01` 的两道后备检查仍然在；WP2 起测试库一律 `lg_test_` 前缀。

L-PGW1-04  database 名按"**整个 path**去掉两侧斜杠"取，不处理含 `/` 的库名
           （PG 允许 `create database "a/b"`，但 `URL` 里要转义）。
           影响面：只在有人真的用带斜杠的库名时才有意义；本轮**未**支持、也**未**声称支持。

L-PGW1-05  **`pnpm m4.5:ci` 已补跑 = EXIT 0**（本包收口前）。
           读数（`artifacts/post-lv2/postgresql-migration/m45ci-wp1-20261012.log`）：
           ```text
           G12 Measurement Validation（L0）   PASS 38 通过 / 0 失败   [HARD GATE]
           L2  Action Pipeline（子系统）        PASS 53 通过 / 0 失败
           G13 Natural Language E2E（L3）      PASS 32 通过 / 0 失败   [HARD GATE]
           G14 Production-copy Live Smoke（L4） PASS 52 通过 / 0 失败  [HARD GATE]
           G2  Component（L1）                PASS 150 通过 / 0 失败
           G9  人工审计语料                    PASS（12/0）
           场景回归 SC-001…SC-007              7 通过 / 0 失败
           G14 选档器自证（正控/负控/恢复）      5/5
           ```
           ⚠️ 两条证据完整性说明：
           ① 运行期间**只改过一份 `.md`（本 Handoff）**，源码 mtime 全部早于本次运行
              ⇒ 这次读数对应当前源码指纹（不是"指纹不适用"档）。
           ② 日志里 `数据库就绪: PgliteDatabaseAdapter，已建 18 张表` —— 这是
              **"未设 `CHARACTER_DB_BACKEND` ⇒ 逐字走 PGlite"** 在真实插件路径上的读数，
              与门里 `PG-G01 D02.12/D02.17` 的纯函数断言互相印证。
           前置条件已满足：跑之前确认**没有**核心进程在运行（G14 的热复制因此是对空闲库的复制）。

L-PGW1-06  单进程内**两个不同 PG 目标**的支持仍未验证（`PG-G01` 的 G01.7-real-pg 未运行）。
           计划 §3.2 的裁定不变：首期隔离库**独立进程**；同进程多目标路径必须拒绝或有已验证实现。

L-PGW1-07  `assertConnectedToSandbox()` 在 PG 侧的读回只在"**明确给了身份期望**"时才断言；
           它现在按 `POSTGRES_URL` 的路径段比对（不是按 `LG_PG_EXPECT_*`）。
           两处判据**有意不同**：一个是"连的是不是我声明的那个库"，一个是"这个库身份对不对"。
           WP2 起应统一到同一份期望（否则会出现"两套身份判据"）。

           ⚠️ **同一条修法还要处理一件本包复核时发现的语义问题**：`initDatabase()` 里的身份核对
           目前**不按后端分叉** —— 只要 `LG_PG_EXPECT_*` 有值就会跑（PGlite 后端也跑）。
           而那几个变量名是 `LG_PG_*`（**PostgreSQL 作用域**）⇒ 现在"给 PGlite 设 PG 期望"
           会让它去核对 PGlite 的 `current_database()`，不匹配就抛 `db_identity_mismatch`。
           影响面很小（这是误配置；且 PGlite 侧本来就有目录闸 + 租约 + pre-open token 三层），
           但语义上是**错的**：PG 作用域的变量不应当影响 PGlite 路径。
           ⇒ WP2 把身份核对**按后端分叉**（只对 postgres 跑），与上面那条统一判据一起做。
           本包**刻意不在收口后改源码**：改它会让 `m4.5:ci` 的读数"指纹不适用"（计划 §5 的拒收条件），
           而重跑 12.4 分钟只为这一处语义收窄不划算 —— 如实登记、随 WP2 一起做。
```

---

## 7. 没有改什么（边界声明）

```text
· `production-open-guard.ts`（INV-DB-01…07 的租约/快照/恢复）—— **一字未改**，PGlite 归属照旧
· `applyKernelMigrations()` 的原子性与 `pendingMigrations()` 语义 —— 未改
· `runtime-shutdown.ts` 的收尾唯一实现 —— 未改
· 任何既有门脚本的断言 —— 未改
· `.env` / `.env.qq` —— 未改
· 任何 `src/**` 中与 PG 无关的模块 —— 未改
· 真实库 —— **未被打开**（本轮全部门都在隔离库/临时目录上跑）
```

---

## 8. 下一包（WP2）的前置

**WP1 侧已就绪**：后端解析与身份核对的接口已定（`database-backend.ts`），
测试隔离在 PG 后端的语义已定并在门里可判。

**WP2 开工的硬前置（都不在 WP1 授权内）**：

1. **Docker 引擎必须运行**（WP0 `L-PGM-01`）—— 用于拉起隔离 PG + pgvector，并核对镜像 digest / PG minor。
2. **`@electric-sql/pglite-tools` 的显式依赖 + 版本固定**（WP0 `L-PGM-02`，WP4 用；不阻塞 WP2）。
3. WP2 的第 3 件**必须在 PG 实例上做的**（即 §4.3 那三条 NOT RUN）。

**WP2 可先做（不需要上面三件）**：

```text
① PG-G02 的门骨架（schema 与权限）—— 先写判据，实例到位后补读数
② `m4:isolation:verify` / `m4:restore:verify` 等既有门的**后端归属字段**登记（只追加，不改断言）
③ WP2 的 compose / 命名卷 / 端口 / 账号分离设计定稿（先出设计，后起实例）
```

---

## 9. 不主张

```text
· 不主张 PostgreSQL 兼容性通过 —— 本包**从未运行过** PostgreSQL（连镜像都没拉）
· 不主张"隔离已对 PG 全面生效" —— 253 个用 `isolateDatabase` 的脚本里，
  门只覆盖了**代表性**路径（PGlite 正控 + PG 三条 + 祖先环境)；其余靠 `isolateDatabase` 的**默认拒绝**兜
· 不主张"`m4.5:ci` 绿"（见 `L-PGW1-05`）
· 不主张身份核对在真 PG 上已验证（G01.5-real-pg 是 NOT RUN）
· 不主张 X0/U1 的多用户隔离已完成 —— 本包只按 ADR-132 `D11` 预留接口
· 不主张本轮关闭或推进任何历史事故、里程碑或技术债
```
