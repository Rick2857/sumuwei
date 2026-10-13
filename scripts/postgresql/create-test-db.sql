-- =============================================================================
--  PostgreSQL 迁移 WP2 —— 建一个**一次性隔离测试库**（`lg_test_<门>`）
-- =============================================================================
--
--  ADR-132 `D03` 定的命名规则：测试库必须以 `lg_test_` 开头（可用
--  `LG_TEST_DATABASE_PREFIX` 覆盖）。这条规则不是装饰 —— `postgresIsolationDecision()`
--  用它来证明"这个目标不是生产库"，所以**门建的库必须真的带这个前缀**。
--
--  为什么需要它：`ALTER DEFAULT PRIVILEGES` 是**按库**生效的（不是全局）。
--  010-roles.sql 里那几条只对 `lg_trial` 生效 ⇒ 每建一个新测试库，都要重放同一套授权，
--  否则会出现"表建好了但运行账号读不到"的隐蔽故障。
--  把这件事收在一个脚本里，而不是散在各道门里各写一遍。
--
--  用法（在容器内，以 bootstrap 超级用户）：
--    LG_TEST_DB_NAME=lg_test_g02 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--      -v ON_ERROR_STOP=1 -f /opt/lg/create-test-db.sql
--
--  ⚠️ 幂等性：`CREATE DATABASE` **没有** `IF NOT EXISTS` ⇒ 本脚本**要求**库不存在。
--     要重来一次，先 `DROP DATABASE`（见 drop-test-db.sql）。
--     刻意不做"存在就跳过"：那会让"这次到底建没建"变成一个猜。
-- =============================================================================

\set ON_ERROR_STOP on

\getenv dbname  LG_TEST_DB_NAME
\getenv owner   LG_PG_MIGRATE_USER

-- 缺变量必须**失败关闭**（而不是建一个名字空白的库）
\if :{?dbname}
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-test-db] FATAL: 缺少 LG_TEST_DB_NAME'; END $$;
\endif
\if :{?owner}
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-test-db] FATAL: 缺少 LG_PG_MIGRATE_USER'; END $$;
\endif

-- ---------------------------------------------------------------------------
-- 前缀守卫：脚本层面再挡一次（判据层已经有，这里是"别让手滑绕过"）
-- ---------------------------------------------------------------------------
-- ⚠️ 两条 psql 语法坑（本轮实测踩到）：
--   ① `\if` 要的是**布尔**，不是字符串比较 ⇒ 不能写 `\if :'x' = 'ok'`
--      （会报 `unrecognized value "'ok' = ok" for "\if expression"`）
--      正确写法：先 `SELECT ... AS ok \gset`，再 `\if :ok`
--   ② `\quit` **总是**以 0 退出（给它的参数会被忽略，且带警告）
--      ⇒ 想"非零退出"必须让一条 SQL **报错**（`ON_ERROR_STOP` 会把它变成非零退出码）
SELECT (:'dbname' LIKE 'lg\_test\_%') AS prefix_ok
\gset

\if :prefix_ok
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-test-db] REFUSED: 测试库名必须以 lg_test_ 开头（ADR-132 D03）'; END $$;
\endif

\echo '[lg-test-db] 建库 :' :"dbname"

-- ---------------------------------------------------------------------------
-- 1. 建库：owner 是**迁移账号**（它负责建 schema）
-- ---------------------------------------------------------------------------
CREATE DATABASE :"dbname" OWNER :"owner";

-- 切到新库做后面的授权（`\connect` 之后 ON_ERROR_STOP 仍有效）
\connect :"dbname"

-- ---------------------------------------------------------------------------
-- 2. 扩展：pgvector 必须在**插件迁移之前**装好
-- ---------------------------------------------------------------------------
-- 计划 §6.4 逐字："预装所需扩展；恢复完整 SQL 并检查所有错误"。
-- 装在这里（而不是让 runtime 顺手装）是因为：受限运行账号**没有** CREATE 权限，
-- 它装不了 —— 而"运行账号装不了扩展"正是我们要的边界。
--
-- ⚠️ `vector` **不是** trusted 扩展 ⇒ 只有超级用户能装 ⇒ 由 bootstrap 装，
--    装完之后**它的 owner 就是 bootstrap 且无法转移** ——
--    `ALTER EXTENSION vector OWNER TO lg_migrate` **语法不存在**
--    （实测：`ERROR: syntax error at or near "OWNER"`；PG 的 `ALTER EXTENSION`
--     只支持 UPDATE / SET SCHEMA / ADD / DROP，没有 OWNER TO）。
--    ⇒ 这条限制的后果由**导出参数**处理：`pg_dump --no-comments`
--      （来源里**只有 2 条 COMMENT，且都在 EXTENSION 上**，见表头说明）。
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 3. 连接权与授权：与 010-roles.sql 同一套（按库重放）
-- ---------------------------------------------------------------------------
REVOKE CONNECT ON DATABASE :"dbname" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"dbname" TO lg_migrate, lg_runtime, lg_readonly;
-- ⚠️ 同样**不**给 lg_test：即使它是"测试库"，也由需要它的门显式授权。
--    这样"lg_test 连不上没授权的库"这条判据在测试库上依然成立。

GRANT USAGE ON SCHEMA public TO lg_runtime, lg_readonly;
GRANT CREATE ON SCHEMA public TO lg_migrate;

ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lg_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO lg_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lg_runtime, lg_readonly;

\echo '[lg-test-db] 就绪：' :"dbname" '（pgvector 已装，授权已重放）'
