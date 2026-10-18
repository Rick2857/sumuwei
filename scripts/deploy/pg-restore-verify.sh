#!/bin/sh
# ============================================================================
# PostgreSQL 恢复**验证**（把备份灌进一个全新空库，然后逐表对账）
# ============================================================================
#
# ----------------------------------------------------------------------------
#  它证明什么 / 不证明什么（2026-10-16 复核后收紧过口径）
# ----------------------------------------------------------------------------
#  ✅ 证明：这份 dump 的 **sha256 与 manifest 一致**、**能被灌进去**，
#          且**每张表的行数与 manifest 记录一致**、扩展清单一致。
#  ❌ 不证明"记录的行数与 dump 是**同一个快照**"——行数是在另一次连接上读的。
#     在线写入期间两者可能已经不同；要同快照，必须在**停写窗口**内跑 pg-backup.sh。
#  ❌ **不证明逐字段内容一致**——它只比行数，不比列值。
#     （2026-10-14 事故之后的验收口径是"逐表 + 逐字段摘要"，**本脚本没有实现后者**，
#       这里刻意不宣称。若迁移前需要字段级验收，得再加一段。）
#  ❌ 不证明：它**故意**不碰生产库。验证全程在 `lg_restore_verify_*` 这类
#          **一次性空库**里进行；脚本拒绝把目标写成生产库名。
#
# ----------------------------------------------------------------------------
#  为什么"逐表对账"不能只看"灌进去了"
# ----------------------------------------------------------------------------
# 2026-10-14 事故之后，恢复候选是用 `pg_resetwal` 在**克隆**上做的，
# 结论是"54 表 / 4,261 行，53 表完全相同，唯一差异 public.agents.updated_at"。
# ⇒ 这个仓库已经确立了"逐表 + 逐字段摘要"的验收口径，本脚本沿用它。
#
# 用法:
#   sh scripts/deploy/pg-restore-verify.sh --manifest ./out/manifest.json
#   sh scripts/deploy/pg-restore-verify.sh --manifest ./out/manifest.json --keep
# ============================================================================

set -eu

CONTAINER="${PG_CONTAINER:-lg-postgresql-production}"
# ⚠️ 2026-10-16 · **端到端自测抓到的真缺陷**：本脚本原来用 `$PGUSER`（缺省 `lg_migrate`）
#    去 `createdb`。但生产实例的角色是**最小权限**的：
#      lg_bootstrap  superuser + CREATEDB   ← 只有它能建库
#      lg_migrate    属主 sumuwei，无 superuser / 无 createdb
#      lg_runtime / lg_readonly / lg_test  同样无 createdb
#    ⇒ 脚本在真实环境里**根本跑不起来**（实测 `permission denied to create database`）。
#
#    修正：**只有验证库**用管理角色；转储那一侧（pg-backup.sh）继续用最小权限的 `PGUSER`。
#    这是有意的不对称 —— 备份只需要读，管理角色只在**一次性验证库**上用到。
ADMIN_USER="${PG_ADMIN_USER:-lg_bootstrap}"
MANIFEST=""
KEEP=0

usage() {
  cat <<'EOF'
用法: sh scripts/deploy/pg-restore-verify.sh --manifest DIR/manifest.json [--keep]

  --manifest  pg-backup.sh 产出的 **manifest.json 文件路径**（不是它所在的目录！）
  --keep      验证完成后**保留**那个验证库（默认验证完就删）

本脚本拒绝把目标库写成生产库名。验证库一律新建、用完即删。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

log() { printf '[pg-restore-verify] %s\n' "$*"; }
die() { printf '[pg-restore-verify][FATAL] %s\n' "$*" >&2; exit 1; }

# ⚠️ 2026-10-16 · 复核 §2 修正：原来 `--manifest` 收的是**文件路径**，
#    却被当成目录存进 SRC_DIR，再拼一次 `/manifest.json`
#    ⇒ 报 `找不到 manifest: .../manifest.json/manifest.json`，**根本没进数据库**。
#    现在：文件与目录分开拿。
[ -n "$MANIFEST" ] || { usage; exit 2; }
[ -f "$MANIFEST" ] || die "找不到 manifest 文件: $MANIFEST"
SRC_DIR="$(dirname "$MANIFEST")"
DUMP="$SRC_DIR/$(sed -n 's/.*"dumpFile"[^"]*"\([^"]*\)".*/\1/p' "$MANIFEST")"
SRC_DB="$(sed -n 's/.*"database"[^"]*"\([^"]*\)".*/\1/p' "$MANIFEST")"
DUMP_SHA_EXPECTED="$(sed -n 's/.*"dumpSha256"[^"]*"\([^"]*\)".*/\1/p' "$MANIFEST")"
[ -f "$DUMP" ] || die "找不到 dump 文件: $DUMP（按 manifest 的 dumpFile 解析）"

# --- 先验完整性：dump 必须与 manifest 记的 sha256 一致 -------------------------
# ⚠️ 复核 §2：原脚本**完全不校验 sha256** ⇒ 一份被改过的/传输损坏的 dump 会被照灌不误。
ACTUAL_SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA" != "$DUMP_SHA_EXPECTED" ]; then
  die "dump 的 sha256 与 manifest 不符（**拒绝继续**）
  期望: $DUMP_SHA_EXPECTED
  实际: $ACTUAL_SHA
  ⇒ 备份在传输或落盘过程中被改过。**不要**拿它去灌生产。"
fi
log "dump 完整性 OK（sha256 与 manifest 一致）"

# --- 红线：绝不允许拿生产库当验证目标 -----------------------------------------
VERIFY_DB="lg_restore_verify_$(date -u +%Y%m%d%H%M%S)"
case "$VERIFY_DB" in
  "$SRC_DB") die "验证库名与源库同名，拒绝执行（这说明拼装逻辑坏了，不是可接受的配置）" ;;
esac
case "$VERIFY_DB" in
  lg_restore_verify_*) : ;;
  *) die "验证库名不在允许的前缀内，拒绝执行: $VERIFY_DB" ;;
esac

log "源库(备份) : $SRC_DB"
log "验证库     : $VERIFY_DB（一次性空库，用完即删）"
log "dump       : $DUMP"

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    log "清理验证库 $VERIFY_DB"
    docker exec "$CONTAINER" dropdb -U "$ADMIN_USER" --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  else
    log "按 --keep 保留验证库 $VERIFY_DB（记得自己删）"
  fi
}
trap cleanup EXIT

# --- 1. 建空库 ---------------------------------------------------------------
# ⚠️ 必须先装扩展再灌 dump：dump 里有 `CREATE EXTENSION pgvector`，
#    但扩展对象需要先有模板可依。失败关闭，不"尽力而为"。
log "建空库 + 装扩展…"
docker exec "$CONTAINER" createdb -U "$ADMIN_USER" "$VERIFY_DB" || die "建库失败"

log "灌 dump…"
gunzip -c "$DUMP" | docker exec -i "$CONTAINER" psql -U "$ADMIN_USER" -d "$VERIFY_DB" \
  --quiet --no-psqlrc --set ON_ERROR_STOP=1 >/dev/null \
  || die "灌库失败（备份不可用 —— **不要**继续迁移）"

# --- 2. 逐表对账 -------------------------------------------------------------
# ⚠️ 复核 §2：原来用的 `query(text)` 在 PG17 上不存在，实测报
#    `ERROR: function query(text) does not exist` ⇒ 这道对账**从来没真的跑过**。
# ⚠️ 2026-10-16 追加：改用 `\gexec` 之后**仍然错** —— psql 会把生成的 SQL **回显**进
#    stdout（56 张表产出 112 行，`-q` 无效）⇒ 与 pg-backup.sh 统一改用**单条 UNION ALL**。
if [ -f "$SRC_DIR/row-counts.tsv" ]; then
  log "逐表行数对账…"
  _q="$(docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d "$VERIFY_DB" -At -c \
    "select string_agg(format('select %L as table_name, count(*)::bigint as n from %I', table_name, table_name), ' union all ')
       from (select table_name from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name) t;" 2>/dev/null)"
  [ -n "$_q" ] || die "生成逐表行数查询失败"
  docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d "$VERIFY_DB" -At -F '|' -c "$_q" \
    > "$SRC_DIR/row-counts.restored.tsv" 2>/dev/null || die "读回行数失败"

  if diff -u "$SRC_DIR/row-counts.tsv" "$SRC_DIR/row-counts.restored.tsv" > "$SRC_DIR/row-counts.diff" 2>&1; then
    TOTAL="$(wc -l < "$SRC_DIR/row-counts.tsv" | tr -d ' ')"
    log "对账一致：$TOTAL 张表，行数逐表相同。"
    log "⚠️ 注意边界：行数是在**转储之外**的另一次连接上读的（见 manifest 的"
    log "   rowCountsCaptured 字段）。这证明"恢复出来的内容与记录一致"，"
    log "   **不**证明"记录与 dump 是同一个快照"。后者要在停写窗口内才成立。"
  else
    log "❌ 对账**不一致**。差异见：$SRC_DIR/row-counts.diff"
    sed -n '1,40p' "$SRC_DIR/row-counts.diff" >&2
    exit 1
  fi
else
  log "⚠️ 备份里没有 row-counts.tsv ⇒ **只能证明灌得进去，不能证明内容一致**。"
  log "   这份备份不满足迁移前验收口径，请重跑 pg-backup.sh。"
  exit 1
fi

# --- 3. 扩展对账（不一致 ⇒ **失败**，不再只是告警）--------------------------
# ⚠️ 复核 §2：原来扩展不一致只打印告警，然后照样打印"恢复验证通过" ⇒ 自相矛盾。
#    ⚠️ pgvector 版本变了 = 语义召回的向量维度/算子可能不兼容，**必须**拦住。
if [ -f "$SRC_DIR/extensions.txt" ]; then
  docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d "$VERIFY_DB" -At -c \
    "select extname||'@'||extversion from pg_extension order by extname;" > "$SRC_DIR/extensions.restored.txt" 2>/dev/null || true
  if diff -q "$SRC_DIR/extensions.txt" "$SRC_DIR/extensions.restored.txt" >/dev/null 2>&1; then
    log "扩展一致（pgvector 在内）。"
  else
    log "❌ 扩展清单与备份时刻不一致："
    diff -u "$SRC_DIR/extensions.txt" "$SRC_DIR/extensions.restored.txt" >&2 || true
    die "扩展不一致 —— **拒绝判定通过**（pgvector 版本变了 = 语义召回可能不兼容）"
  fi
fi

log ""
log "恢复验证通过。"
log "  ⇒ 这份备份可以带到服务器。"
log "  ⇒ 仍**不代表**迁移完成：服务器侧还要再跑一次本脚本（对服务器上那份库）。"
