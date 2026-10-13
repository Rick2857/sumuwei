-- =============================================================================
--  PostgreSQL 迁移 WP2 —— 账号分离（bootstrap 阶段，只在**空数据目录**跑一次）
-- =============================================================================
--
--  计划 §3.1 逐字要求：
--    "分开迁移账号、运行账号、只读账号和测试账号。测试账号不能连接/写入生产目标；
--     不能仅设置 default_transaction_read_only 就把具有写权限的账号称作只读账号。"
--
--  ⇒ 这里的**权限边界由 GRANT 造成**，`default_transaction_read_only` 只作第二层。
--
-- -----------------------------------------------------------------------------
--  四个账号各自的职责与"它**不能**做什么"
-- -----------------------------------------------------------------------------
--   lg_migrate   建 schema / 应用迁移 / bootstrap
--                **不能**：被普通启动调用（那是应用层的事，见 ADR-132 `D04`）
--   lg_runtime   核心运行（表级 DML）
--                **不能**：CREATE（DDL）· 拥有表 · BYPASSRLS · 建库/建角色/超级用户
--   lg_readonly  只读诊断 / 备份观察 / 后台只读查询
--                **不能**：INSERT/UPDATE/DELETE/DDL（靠 GRANT）· 且默认只读事务（第二层）
--   lg_test      隔离测试
--                **不能**：连上这个库（本库对它**不授 CONNECT**）
--                ⇒ "测试账号不能连生产目标"是**连接层**拒绝，不是靠应用自觉
--
--  ⚠️ 刻意**不**给 lg_test 建库或授权：测试库由各道门自己建（`lg_test_<门>`，
--     见 ADR-132 `D03`）并单独授权。这样"测试账号能不能连生产库"这条判据才有意义。
--
--  ⚠️ 密码从环境变量来（compose 的 `env_file`，**gitignore**），**不**写进本文件。
--     用 psql 的 `\getenv`（PG 16+）而不是 shell 脚本：Windows 挂载的文件权限不可靠，
--     `.sh` 可能被 entrypoint **source** 进它自己的 shell（`set -e` 会污染父进程），
--     而 `.sql` 由 psql 独立执行，行为确定。
--     代价如实记：环境变量在 `docker inspect` 里可见 ⇒ 见 WP2 Handoff 的局限登记。
-- =============================================================================

\set ON_ERROR_STOP on

\getenv migrate_pw  LG_PG_MIGRATE_PASSWORD
\getenv runtime_pw  LG_PG_RUNTIME_PASSWORD
\getenv readonly_pw LG_PG_READONLY_PASSWORD
\getenv test_pw     LG_PG_TEST_PASSWORD
\getenv dbname      POSTGRES_DB

-- 缺变量必须**失败关闭**（而不是建一个空密码的账号）
\if :{?migrate_pw}
\else
  \echo '[lg-init] FATAL: 缺少 LG_PG_MIGRATE_PASSWORD'
  \quit 1
\endif

\echo '[lg-init] 创建四个账号（migrate / runtime / readonly / test）…'

-- ---------------------------------------------------------------------------
-- 1. 四个账号：一律 NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOBYPASSRLS
-- ---------------------------------------------------------------------------
-- ⚠️ 显式写出这些 NO* 不是啰嗦：它们是**可复核的判据**（`PG-G02` 要读 `pg_roles` 核对），
--    而不是"靠缺省值恰好是对的"。
CREATE ROLE lg_migrate  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'migrate_pw';
CREATE ROLE lg_runtime  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'runtime_pw';
CREATE ROLE lg_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'readonly_pw';
CREATE ROLE lg_test     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'test_pw';

-- ---------------------------------------------------------------------------
-- 2. 只读账号：第二层（第一层是 GRANT；这一层只是"再兜一次"）
-- ---------------------------------------------------------------------------
ALTER ROLE lg_readonly SET default_transaction_read_only = on;
-- search_path 钉死：避免"靠 search_path 意外拿到别的 schema 的对象"
ALTER ROLE lg_runtime  SET search_path = public, pg_catalog;
ALTER ROLE lg_readonly SET search_path = public, pg_catalog;
ALTER ROLE lg_migrate  SET search_path = public, pg_catalog;

-- ---------------------------------------------------------------------------
-- 3. 连接权：只有 migrate / runtime / readonly 能连这个库
-- ---------------------------------------------------------------------------
-- 先把 PUBLIC 的连接权收掉（PG 缺省是任何人都能连）⇒ lg_test 因此连不上
REVOKE CONNECT ON DATABASE :"dbname" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"dbname" TO lg_migrate, lg_runtime, lg_readonly;

-- ---------------------------------------------------------------------------
-- 4. schema 与"未来对象"的授权
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO lg_runtime, lg_readonly;
-- lg_migrate 要能在 public 里建表（PG 15+ 起 public 的 CREATE 已不对 PUBLIC 开放）
GRANT CREATE ON SCHEMA public TO lg_migrate;

-- 迁移由 lg_migrate 执行 ⇒ 用 ALTER DEFAULT PRIVILEGES 让**它以后建的对象**
-- 自动带上正确授权。这样就不需要"先建表、再补 GRANT"的时序耦合
-- （那种时序一旦漏一步，就变成"表建好了但运行账号读不到"的隐蔽故障）。
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lg_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO lg_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE lg_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lg_runtime, lg_readonly;

\echo '[lg-init] 账号分离完成：lg_migrate / lg_runtime / lg_readonly（lg_test 未获 CONNECT）'
