-- =============================================================================
--  PostgreSQL 迁移 WP2 —— 删掉一个**一次性隔离测试库**
-- =============================================================================
--
--  与 `create-test-db.sql` 成对。**只**接受 `lg_test_` 前缀的库名：
--  这个脚本会被反复调用，一次手滑就是删掉一个真库。
--
--  `WITH (FORCE)` 是 PG 13+ 的：先断开该库上的其它会话再删。
--  没有它就得自己写 `pg_terminate_backend` 那一段（而且容易漏掉刚建立的连接）。
--
--  用法（容器内，以 bootstrap 超级用户）：
--    LG_TEST_DB_NAME=lg_test_g02 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--      -v ON_ERROR_STOP=1 -f /opt/lg/drop-test-db.sql
-- =============================================================================

\set ON_ERROR_STOP on

\getenv dbname  LG_TEST_DB_NAME

\if :{?dbname}
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-drop-test-db] FATAL: 缺少 LG_TEST_DB_NAME'; END $$;
\endif

-- 前缀守卫：与 create 同一条规则（删库比建库更需要它）
SELECT (:'dbname' LIKE 'lg\_test\_%') AS prefix_ok
\gset

\if :prefix_ok
\else
  DO $$ BEGIN RAISE EXCEPTION '[lg-drop-test-db] REFUSED: 只删 lg_test_ 前缀的库（ADR-132 D03）'; END $$;
\endif

\echo '[lg-drop-test-db] 删库 :' :"dbname"

DROP DATABASE IF EXISTS :"dbname" WITH (FORCE);

\echo '[lg-drop-test-db] 已删除（若原本不存在则无操作）'
