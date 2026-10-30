#!/bin/bash
# 在**隔离 PG 测试库**上跑 CLI 退出延迟门。
# ⚠️ 为什么必须用隔离库（2026-10-18 实测两次才明白）：
#   · 直接跑 ⇒ `production_db_in_use`：生产服务持有租约，而"真实库同一时刻
#     只允许一个访问者"是既有纪律（不该绕，也不该停生产来跑门）。
#   · 换 PGlite ⇒ 四种隔离姿势全失败（见 scripts/verify-cli-exit-latency.ts 注释）。
#   · ⇒ 唯一可行：建一个 lg_test_ 前缀的一次性 PG 库，让 CLI 连它。
set -u
C=lg-postgresql-production
SU=lg_bootstrap
DB=lg_test_cli_exit
PORT=55432
PW=$(docker exec "$C" printenv POSTGRES_PASSWORD)

docker exec "$C" psql -U "$SU" -d postgres -tAc "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1
docker exec "$C" psql -U "$SU" -d postgres -tAc "CREATE DATABASE $DB;" >/dev/null 2>&1
echo "created isolated db: $DB"
trap 'docker exec "$C" psql -U "$SU" -d postgres -tAc "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1; echo "dropped $DB"' EXIT

cd /opt/project-lg || exit 1
export CI=1
export CHARACTER_DB_BACKEND=postgres
export LG_PG_EXPECT_DATABASE=$DB
export POSTGRES_URL="postgresql://${SU}:${PW}@127.0.0.1:${PORT}/${DB}"
export CHARACTER_THIN_HOST=on
# 关键：让开库的守卫把这次运行当成"沙箱"而不是"生产库"
export PROJECT_LG_SANDBOX="$DB"

# ⚠️ 隔离库是**空的** ⇒ 必须先让旧宿主把 schema 建出来。
#    薄宿主按设计**不在启动期执行 DDL**（`thin_host_refuses_startup_ddl`），
#    所以顺序必须是"先建表 → 再用薄宿主跑 CLI"。
echo "--- step 1: build schema with legacy host ---"
/usr/bin/node --import file:///opt/project-lg/node_modules/tsx/dist/loader.mjs \
  scripts/thinhost-ddl-decoupling-measure.ts --phase=warm > /tmp/cli-exit-warm.log 2>&1
echo "warm exit=$?  (tables:)"
docker exec "$C" psql -U "$SU" -d "$DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

echo
echo "--- step 2: run CLI exit gate (thin host) ---"

OUT=/tmp/cli-exit-iso.log
/usr/bin/node --import file:///opt/project-lg/node_modules/tsx/dist/loader.mjs \
  scripts/verify-cli-exit-latency.ts > "$OUT" 2>&1
RC=$?
grep -a -E '(✅|❌|CLI 退出延迟门)' "$OUT"
echo "gate exit=$RC"
[ $RC -ne 0 ] && { echo "--- stderr head ---"; grep -a -A2 '子进程真的跑起来了' "$OUT" | head -6; }
exit 0
