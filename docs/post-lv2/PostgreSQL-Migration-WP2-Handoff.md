# PostgreSQL 迁移 WP2：PG 服务与 schema —— Handoff

日期：2026-10-13（Asia/Shanghai）。runId：`pg-migration-wp2-20261013T130636`。
状态：**WP2 部分交付**（隔离实例 + 账号分离 + 建库工具 + 真 PG 上的从零可运行**已取得读数**）；
**权限正负控通过**；但 **`PG-G02` 门本身尚未落成脚本**（见 §6）；
生产**未切换**；真实库**未被打开**。
上游：[执行计划](PostgreSQL-Migration-Execution-Plan-2026-10-12.md) §4/WP2 ·
[ADR-132](../adr/ADR-132-postgresql-migration-backend-and-activation.md)（`D04`/`D07`/`D08`）·
[验收契约](PostgreSQL-Migration-Acceptance-Contract.md)（`PG-G02`）·
[门矩阵](PostgreSQL-Migration-Gates-Matrix.md) · [WP1 Handoff](PostgreSQL-Migration-WP1-Handoff.md)。

---

## 0. 本轮的一件先决事实（必须写在最前面）

用户裁定"启动 Docker Desktop 引擎、按计划 Compose 路线推进"。启动引擎时，
用户的 **`lg-qq-private-napcat-1` 被自动拉起**（`RestartPolicy=unless-stopped`，**用户自己的配置**），
而 LG 核心并未运行。按用户指令**优雅停止**（`docker stop --time 30` ⇒ `Exited (143)` = SIGTERM，
**不是** kill）。此后 `docker ps` 为空；其余 13 个容器保持各自原有 `Exited` 状态，未被启动。

⇒ 由此得到一条**直接影响本包设计**的结论：新 PG 服务用 **`restart: "no"`**（见 §2 的第 ③ 条理由）。
生产上"服务器重启后数据库仍可读"（计划 §1）是 **WP6** 的裁定，要用独立可用性证据支撑，
不是靠一个 compose 字段顺手带过。

---

## 1. 实际改动路径

| 文件 | 性质 | 内容 |
|---|---|---|
| `scripts/postgresql/compose.yml` | **新增** | 独立项目/命名卷/digest 固定/loopback/显式服务参数 |
| `scripts/postgresql/init/010-roles.sql` | **新增** | 四账号分离（bootstrap 阶段，只在空数据目录跑一次） |
| `scripts/postgresql/create-test-db.sql` | **新增** | 一次性测试库的建库 + 按库重放授权（含前缀守卫） |
| `scripts/postgresql/drop-test-db.sql` | **新增** | 删一次性测试库（含前缀守卫） |
| `scripts/postgresql/init-probe.ts` | **新增** | 让 LG 真实 `initDatabase()` 跑在真 PG 上（含迁移闸负控） |
| `artifacts/post-lv2/local/pg-migration/pg-trial.env` | **新增（gitignore）** | 试验凭据（随机生成；`artifacts/post-lv2/local/` 被 `.gitignore:232` 忽略） |
| `src/**` | **零改动** | 本包**没有**改任何源码 |

---

## 2. 三条刻意选择（别"顺手改掉"）

```text
① image 用 digest 固定，不用 tag
   计划 §2 逐字："部署固定 digest"、"不能自动使用 latest"。
   实测：pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d

② 端口只绑 loopback：127.0.0.1:55432
   计划 §1 逐字："首轮部署限 loopback"。写 55432:5432（不带 127.0.0.1）会暴露到局域网。

③ restart: "no" —— 刻意不自动启动
   理由见 §0 的实测。数据库服务的生产重启策略是 WP6 的裁定。
```

另：持久性设置**一律不关**（`fsync=on` / `synchronous_commit=on`，计划 §5 逐字）；
连接 / DDL / 锁等待日志全开（为 WP3 的"第二核心"排查留第一手证据）。

---

## 3. L-PGM-01 已关闭（WP0 遗留）

| 项 | 读数 |
|---|---|
| 镜像 tag | `pgvector/pgvector:0.8.7-pg17-bookworm` |
| **digest（用于固定）** | `pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d` |
| **PostgreSQL** | **17.11**（Debian 17.11-1.pgdg12+2，x86_64） |
| **pgvector（镜像内）** | **0.8.7**（`vector.control` 的 `default_version`） |
| 架构 / OS / 大小 | amd64 / linux / 636 900 560 B（created 2026-10-01T17:35:53Z） |
| **许可证** | 两者都是 **PostgreSQL License**（`/usr/share/doc/pgvector/LICENSE` 实读；镜像 `Config.Labels` 为 `null` ⇒ 按镜像内文件判定，不按标签） |

证据：`artifacts/post-lv2/postgresql-migration/<runId>/image-resolution.json`。

---

## 4. 账号分离（`D07`）：读数逐条

四账号 = `lg_migrate` / `lg_runtime` / `lg_readonly` / `lg_test`。
**权限边界由 GRANT 造成**；`default_transaction_read_only` 只作第二层。

| 用例 | 账号 | 期望 | 实测 |
|---|---|---|---|
| SELECT | `lg_readonly` | 允许 | rc=0 |
| CREATE TABLE | `lg_readonly` | 拒 | `cannot execute CREATE TABLE in a read-only transaction`（**第二层**） |
| **INSERT（把只读事务关掉）** | `lg_readonly` | **拒** | **`permission denied for table`（★第一层 GRANT）** |
| **UPDATE（同上）** | `lg_readonly` | **拒** | `permission denied for table` |
| **DELETE（同上）** | `lg_readonly` | **拒** | `permission denied for table` |
| DROP（同上） | `lg_readonly` | 拒 | `must be owner of table` |
| INSERT/UPDATE/DELETE | `lg_runtime` | 允许 | rc=0 |
| CREATE TABLE | `lg_runtime` | 拒 | `permission denied for schema public` |
| ALTER / DROP | `lg_runtime` | 拒 | `must be owner of table` |
| CREATE TABLE / INSERT | `lg_migrate` | 允许 | rc=0 |
| **CONNECT** | `lg_test` | **拒** | **`FATAL: permission denied for database "lg_trial"`** |

★ 中间那三行是本组的**关键**：把"第二层"关掉之后写仍然被拒 ⇒ 满足
计划 §3.1 逐字"**不能仅设置 `default_transaction_read_only` 就把具有写权限的账号称作只读账号**"。

`pg_roles` 实读：四个业务账号的 `rolsuper` / `rolcreatedb` / `rolcreaterole` / `rolbypassrls` /
`rolinherit` **全部 false**（`lg_bootstrap` 是 initdb 超级用户，PG 官方镜像语义）。
本库 ACL：`{=T/lg_bootstrap, …, lg_migrate=c, lg_runtime=c, lg_readonly=c}` —— `lg_test` 不在其中。

证据：`<runId>/account-separation.json`（17 条负控，`measured_count=17`、`failed=0`）。

---

## 5. 从零可运行（`PG-G02` 的核心读数，真 PG）

`scripts/postgresql/init-probe.ts` 让 LG 的**真实** `initDatabase()` 跑在真 PostgreSQL 上。
目标库由 `create-test-db.sql` **从零**建立（先 drop 再 create 之后才跑）。

| 步 | 结果 | 读数 |
|---|---|---|
| `isolateDatabase({ postgres })` 放行 | ✅ | `backend=postgres` |
| **负控：未放行时 Kernel 迁移闸拦住** | ✅ | `code=kernel_migration_pending` ⇒ **M3 迁移闸在 PG 下照样生效** |
| 显式放行后 `initDatabase()` | ✅ | — |
| 适配器 | ✅ | **`PgDatabaseAdapter`**（不是 `PgliteDatabaseAdapter`） |
| 身份核对读到真服务端地址 | ✅ | `172.25.0.2/32:5432`（PGlite 嵌入式下这里是空） |
| serverVersion | ✅ | `PostgreSQL 17.11 … x86_64-pc-linux-gnu` |
| 读回的 database = 测试目标 | ✅ | `lg_test_wp2` |
| 插件 + Kernel 迁移建出表 | ✅ | public 表 **51** 张 |
| pgvector 已安装 | ✅ | **0.8.7** |
| Kernel schema 版本 | ✅ | **18** |
| 本进程连接池已关闭 | ❌ | `isDatabaseClosed=false` ⇒ **F-WP2-01** |

**与 WP0 来源读数的对照**：public 表 `51 = 51` ✅ · Kernel schema `18 = 18` ✅ ·
pgvector `0.8.0 → 0.8.7`（**预期的版本漂移**，R-71）· 引擎 `17.5 (PGlite/emcc 32-bit)` → `17.11 (Debian x86_64)`
（同一 major，minor 不同 —— 这是 PGlite 与真 PG 的差别，不是缺陷）。

证据：`<runId>/real-postgres-init.json`。

---

## 6. 边界（`L-PGW2-01…05`）

```text
L-PGW2-01  ~~**`PG-G02` 门尚未落成脚本**~~ ⇒ ✅ **2026-10-13 已关闭**：
           `pnpm postgresql:g02:verify` 已落成（`scripts/postgresql-g02-verify.ts`），
           读数 **27/27 · 0 失败 · 0 notRun**（`measured_count = 27`，实测 8.1s）。
           它把本包 §4 的权限负控与 §5 的从零读数收进了一道可被 `pnpm` 调起、
           已登记 manifest / affected-map 的门。
           ⚠️ 两条**落门时才发现、已修**的东西（都不是"读数"，是门自己的缺陷）：
             ① 第一版在**实例不可达时以 0 退出** ⇒ CI 会把"根本没有数据库"当绿。
                那正是契约 §2「缺证据…拒收」与 §9「NOT RUN 不能汇成 PASS」要挡的。
                现在：**只要有关键断言未运行，本门就不报 PASS**（非零退出 + 具名原因）。
             ② 第一版把 `PG-G02` 放进了 `OFFLINE_GATES` —— 那条 lane 的声明与
                `pnpm m4.5:ci` **逐条等价** ⇒ 等于让本仓库的核心离线 CI **依赖 Docker 在跑**。
                已改为**自己的 `postgresql` lane**（标 `serial`），与 `desktop-control` 的先例一致。
           ⇒ 现在 `m4.5:ci` 的组成**不受 PG 线影响**；PG 门用
              `pnpm gates:run --lane postgresql` 调。

L-PGW2-02  凭据以**环境变量**进容器 ⇒ 在 `docker inspect` 里可见。
           试验可接受；**生产**（WP6）必须换成 docker secret 或等价机制，且 Runbook 写明轮换。
           本轮**未**做秘密管理 —— 如实登记，不假装做到了。

L-PGW2-03  实例是**长期存在**的（命名卷保留），不是"每道门一个容器"。
           门之间靠**库名隔离**（`lg_test_<门>`）。风险：一道门忘了清理会污染下一道。
           缓解：`drop-test-db.sql` 有前缀守卫；WP3 起每道门自建自删。
           ⚠️ 这也意味着**同时跑两道 PG 门会互相影响** ⇒ PG 门在 manifest 里必须标 `serial`。

L-PGW2-04  主机端口固定 `55432`。若本机已有服务占用它，`up` 会失败（如实报错，不静默换端口）。
           端口本身是可配置的，但**换端口要改 compose 并重新核对**（不是自动行为）。

L-PGW2-05  `init-probe.ts` 的"连接池已关闭"那一步当前**必然为 false**（F-WP2-01）。
           它是**已知的假阴性**，不是随机失败 ⇒ 该步在门里落地时要么先修 F-WP2-01（WP3），
           要么改用"服务端会话数"作为判据（那是 F-WP2-01 的修法方向）。
```

---

## 7. 发现的两个真缺陷（都归 WP3，本包**不改**源码）

### F-WP2-01 · `isDatabaseClosed()` 在 PG 下**假阴性**

池**真的**关了（`pg_stat_activity` 里 `lg_migrate` 会话数 = **0**），而 `isDatabaseClosed()` 返回 `false`。
根因：它只认 PGlite 形状（`connection.closed` / `adapter.closed`）；`pg.Pool` 不暴露 `.closed`，
`PostgresConnectionManager` 暴露的是 `isClosed()`（方法）与 `_closed`（私有）。
方向**安全**（失败关闭），但"关闭是问出来的"这句在 PG 上**答不出来**。

### F-WP2-02 · **初始化失败不回收连接池 ⇒ 进程挂住**

把 `LG_PG_EXPECT_DATABASE` 故意写错 ⇒ 身份核对抛 `db_identity_mismatch`（正确），
但**探针进程 14 分钟没退出**；`pg_stat_activity` 里 `lg_migrate` 有 **1 个 `idle/Client` 会话**
⇒ 池握着连接撑住事件循环。强制结束后会话立刻归 0。

机理：`initDatabase()` 是 `registerPlugin(sqlPlugin)`（**这一步就建好 `pg.Pool`**，min=2）
→ 身份核对 → `runPluginMigrations()`；身份核对抛错时池已存在而**没人关它**。
PGlite 分支无此症状 ⇒ **换库才暴露**。生产上"初始化失败"会变成**挂住**而非**快速失败**。

⇒ 两者都属 **WP3**（计划 §4/WP3 必交付物逐字包含"连接池关闭"与"初始化失败回收"）。
**本包不改**：WP1 已收口且 `m4.5:ci` EXIT 0，改动会让那份读数指纹不适用。

---

## 8. WP1 遗留的真 PG 用例：2 条关闭

```text
✅ G01.5-real-pg  错库 ⇒ db_identity_mismatch（写入前拒绝）
                  旁证：期望 kernel_migration_pending 的那一步实际拿到 db_identity_mismatch
                        ⇒ 身份核对**先于**插件迁移（顺序由真读数钉住）
✅ G01.8-real-pg  拒绝后重读 information_schema.tables ⇒ **0 张**（与基线相同）
⏳ G01.7-real-pg  同进程第二个 PG 目标 —— 归 WP3
```

---

## 9. 下一包（WP3）的前置与开工清单

**WP3 的必交付物**（计划 §4/WP3）："连接池关闭、初始化失败回收、服务器重连；核心资格与
消费者生命周期；共存启停适配"。⇒ 它天然包含本包发现的 `F-WP2-01` / `F-WP2-02`。

**已就绪**：隔离 PG 实例（`lg-postgresql-trial`，loopback 55432）· 四账号 ·
建/删测试库工具 · 真 PG 上的 `initDatabase` 通路 · 身份核对与迁移闸在 PG 上的读数。

**WP3 的第一批可做项**：

```text
① 修 F-WP2-01：给 isDatabaseClosed() 加 PG 分支（判据 = 关闭 Promise 成功 + 本进程会话释放，
   而不是管理器标记 —— ADR-132 D06）
② 修 F-WP2-02：initDatabase 失败路径回收连接池（registerPlugin 之后到身份核对之间的异常
   必须关掉池再抛；否则生产上"初始化失败"= 挂住）
③ 资格锁（ADR-132 D05）：专用连接 + session advisory lock + (pg_backend_pid, generation)
   + 池错误即失效；**不许**复用 plugin-sql 迁移锁的 lockId 派生方式
④ 落成 PG-G02 门（收 §4/§5 的读数）+ 起 PG-G03 骨架（两个真实 OS 进程）
⑤ G01.7-real-pg：同进程第二个 PG 目标（池键不含连接地址）—— 与 ③ 一起验
```

**不需要新授权**：以上都在用户「按计划执行」的授权范围内（代码 + 隔离验证）。

---

## 10. 不主张

```text
· ✅ PG-G02 **已 PASS**（门已落成，27/27 · `measured_count = 27`）—— 见 L-PGW2-01 的关闭记录
· 不主张 PG-G03 已存在（那是 WP3 的门）
· 不主张"权限正负控已成为门"（目前是**读数**，不是可被 pnpm 调起的门）
· 不主张生产重启策略已定（本包刻意 restart:"no"；那是 WP6 的裁定）
· 不主张凭据管理已达标（L-PGW2-02：环境变量在 docker inspect 里可见）
· 不主张数据迁移/完整性（WP4/WP5）· 不主张仓储级 SQL 兼容（PG-G04）
· 不主张"初始化失败会快速退出" —— 实测**恰好相反**（F-WP2-02）
· 不主张本轮关闭或推进任何历史事故、里程碑或技术债
```
