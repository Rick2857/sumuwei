-- =============================================================================
--  PostgreSQL 迁移 WP7 —— 建**生产库**
-- =============================================================================
--
--  为什么需要这个脚本（`F-WP5-21`）：`create-test-db.sql` 第 47–53 行**断言库名以
--  `lg_test_` 开头**（ADR-132 `D03` 的命名纪律，`postgresIsolationDecision()` 依赖它）
--  ⇒ 拿它建生产库会被**按设计拒绝**。而 `lg_trial`（bootstrap 库）里只有 1 张表
--  ⇒ 直接灌 dump 会与既有对象冲突。⇒ **生产库的创建路径必须单独存在**。
--
--  ⚠️ 本脚本与测试脚本**同形**（同一套授权、同一套扩展），只有**守卫方向相反**：
--     测试库**必须**带 `lg_test_` 前缀；生产库**不许**带 —— 这样"生产库被误当成测试库"
--     和"测试库被误当成生产库"两个方向都被挡住。
--
--  用法（在容器内，以 bootstrap 超级用户）：
--    LG_PROD_DB_NAME=sumuwei LG_PG_MIGRATE_USER=lg_migrate \
--      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--      -f /opt/lg/create-production-db.sql
--
--  ⚠️ 幂等性：`CREATE DATABASE` **没有** `IF NOT EXISTS` ⇒ 本脚本**要求库不存在**。
--     刻意不做"存在就跳过"：那会让"这次到底建没建"变成一个猜。
-- =============================================================================

\set ON_ERROR_STOP on

\getenv dbname  LG_PROD_DB_NAME
\getenv owner   LG_PG_MIGRATE_USER

-- 缺变量必须**失败关闭**（而不是建一个名字空白的库）
\if :{?dbname}
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-prod-db] FATAL: 缺少 LG_PROD_DB_NAME'; END $$;
\endif
\if :{?owner}
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-prod-db] FATAL: 缺少 LG_PG_MIGRATE_USER'; END $$;
\endif

-- ---------------------------------------------------------------------------
-- 反向守卫：生产库名**不许**带 `lg_test_` 前缀
-- ---------------------------------------------------------------------------
-- ⚠️ `\if` 要的是**布尔** ⇒ 先 `SELECT … AS ok \gset`，再 `\if :ok`
--    （不能写 `\if :'x' = 'ok'`）；想"非零退出"必须让一条 SQL **报错**。
SELECT (:'dbname' NOT LIKE 'lg\_test\_%') AS prod_name_ok
\gset

\if :prod_name_ok
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-prod-db] REFUSED: 生产库名不许以 lg_test_ 开头（那是测试库的命名空间）'; END $$;
\endif

\echo '[lg-prod-db] 建库 :' :"dbname"

-- ---------------------------------------------------------------------------
-- 1. 建库：owner 是**迁移账号**（它负责建 schema）
-- ---------------------------------------------------------------------------
CREATE DATABASE :"dbname" OWNER :"owner";

\connect :"dbname"

-- ---------------------------------------------------------------------------
-- 2. 扩展：pgvector 必须在**导入之前**装好
-- ---------------------------------------------------------------------------
-- ⚠️ `vector` **不是** trusted 扩展 ⇒ 只有超级用户能装 ⇒ 由 bootstrap 装。
--    导入的 dump 里是 `CREATE EXTENSION IF NOT EXISTS vector` ⇒ 这里先装 = 幂等。
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 3. 连接权与授权：与 010-roles.sql 同一套（按库重放）
-- ---------------------------------------------------------------------------
REVOKE CONNECT ON DATABASE :"dbname" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"dbname" TO lg_migrate, lg_runtime, lg_readonly;

GRANT USAGE ON SCHEMA public TO lg_runtime, lg_readonly;
GRANT CREATE ON SCHEMA public TO lg_migrate;

ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lg_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO lg_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lg_runtime, lg_readonly;

-- ---------------------------------------------------------------------------
-- 4. 运行账号的启动期 DDL：**不授权**（ⓑ 裁定，2026-10-13）
-- ---------------------------------------------------------------------------
-- 实测（`F-WP5-24`）：以 `lg_runtime` 起核心会撞上**启动期 DDL 级联**：
--   ① `CREATE SCHEMA IF NOT EXISTS migrations`（plugin-sql 的 `MigrationTracker.ensureSchema()`，
--      由 `initializeWithDatabase()` **无条件**调用 —— 插件里没有开关，ⓒ 不可行）
--   ② `CREATE TABLE IF NOT EXISTS migrations._migrations`
--   ③ `SELECT … FROM migrations._migrations`
--   ④ `create table if not exists character_schema_migrations`（kernel 自己的迁移表）
--   ⑤ …（同型，还没走到头）
-- 每一步都是"**PG 先查权限、再查存在性**"⇒ 受限账号必然失败；
-- 而"一条条授"既**没有有限最小集**，又逐条侵蚀 WP2 的账号分离。
--
-- ⇒ 用户 2026-10-13 裁定 **ⓑ：核心以 `lg_migrate` 运行**（启动期 DDL 本来就属迁移职责面；
--    这也是**十道门全程证明过**的配置）。⇒ 本脚本**保持** WP2 的原设计：
--    `lg_runtime` **没有** CREATE（数据库级与 schema 级都没有）。
--    ⚠️ 代价如实记：**失去 runtime/migrate 分离**（`lg_readonly` 仍可用于只读路径）。

\echo '[lg-prod-db] 就绪：' :"dbname" '（pgvector 已装，授权已重放；ⓑ：核心以 lg_migrate 运行）'
