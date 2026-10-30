#!/bin/bash
# 四道门全跑一遍（薄宿主启用前的准入）。
# ① 语义等价（真 PG） ② 装配闭环（真 PG） ③ 接口面穷举 ④ 接线
# 任一失败 ⇒ 不启用。
set -u
C=lg-postgresql-production
SU=lg_bootstrap
PORT=55432
PW=$(docker exec "$C" printenv POSTGRES_PASSWORD)
cd /opt/project-lg || exit 1
NODE=/usr/bin/node
LOADER=file:///opt/project-lg/node_modules/tsx/dist/loader.mjs
FAILED=0

# --- ③④ 不需要数据库 ---
echo "=== ③ 接口面穷举 ==="
$NODE --import "$LOADER" scripts/thinhost-surface-verify.ts 2>&1 | grep -E '^(PASS|FAIL|===|FAILED)'
[ ${PIPESTATUS[0]} -ne 0 ] && FAILED=$((FAILED+1))

echo
echo "=== ④ 接线 ==="
$NODE --import "$LOADER" scripts/thinhost-wiring-verify.ts 2>&1 | grep -E '^(PASS|FAIL|===|FAILED)'
[ ${PIPESTATUS[0]} -ne 0 ] && FAILED=$((FAILED+1))

# --- ①② 需要真 PG 隔离库 ---
run_pg_gate() {
  local gate="$1" db="$2"
  docker exec "$C" psql -U "$SU" -d postgres -tAc "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1
  docker exec "$C" psql -U "$SU" -d postgres -tAc "CREATE DATABASE $db;" >/dev/null 2>&1
  export CI=1 CHARACTER_DB_BACKEND=postgres PGLITE_DATA_DIR= LG_PG_EXPECT_DATABASE=$db
  export POSTGRES_URL="postgresql://${SU}:${PW}@127.0.0.1:${PORT}/${db}"
  unset PROJECT_LG_SANDBOX || true
  # 先用旧宿主建库（薄宿主的 initDatabase 需要 schema 已就绪）
  $NODE --import "$LOADER" scripts/thinhost-ddl-decoupling-measure.ts --phase=warm >/dev/null 2>&1
  $NODE --import "$LOADER" "scripts/$gate" "--pg-url=postgresql://${SU}:${PW}@127.0.0.1:${PORT}/${db}" 2>&1 | grep -E '^(PASS|FAIL|===|FAILED)'
  local rc=${PIPESTATUS[0]}
  docker exec "$C" psql -U "$SU" -d postgres -tAc "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1
  return $rc
}

echo
echo "=== ① 语义等价 ==="
run_pg_gate thinhost-equivalence-verify.ts lg_test_thin_eq || FAILED=$((FAILED+1))

echo
echo "=== ② 装配闭环 ==="
run_pg_gate thinhost-initdb-verify.ts lg_test_thin_init || FAILED=$((FAILED+1))

echo
echo "=== GATE SUMMARY: $FAILED failed ==="
exit $FAILED
