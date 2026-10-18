#!/bin/sh
# ============================================================================
# PostgreSQL **逻辑**备份（服务器部署 · 数据迁移准备）
# ============================================================================
#
# ----------------------------------------------------------------------------
#  一、为什么是"逻辑"备份而不是拷数据目录
# ----------------------------------------------------------------------------
# 2026-10-14 那次事故的根因逐字写着："**未复制运行中的 PGDATA**"这条纪律被违反了 ——
# 两个 PG 进程并发挂载同一个卷，checkpoint 校验和失效，报
# `invalid checkpoint record / could not locate a valid checkpoint record`，
# 原生产卷**损坏**。
#
# ⚠️ **本脚本刻意不做 `cp -r` 数据目录、不做 `docker cp` PGDATA、不做 pg_basebackup。**
#    它只走 `pg_dump`：一次**一致性快照**（MVCC），与"文件是否正在被写"无关。
#    这不是慢一点的问题，是**唯一一个不会因为拷错时机而损坏源库的做法**。
#
# ----------------------------------------------------------------------------
#  二、它产出什么
# ----------------------------------------------------------------------------
#   out/
#     dump.sql            纯 SQL 文本（可 review、可 grep、可重放）
#     dump.sql.gz         同一份的压缩
#     manifest.json       备份时刻的**可核对读数**（见下）
#
#   manifest.json 里**必须**有的东西（否则这份备份"没法验证能不能用"）：
#     · 备份时刻（UTC 与本地）
#     · PG 版本、pgvector 版本、**镜像 digest**
#     · 目标库名与 server_version
#     · **逐表行数**（恢复后拿它逐表对账）
#     · 迁移版本水位（schema 版本）
#     · dump 的 sha256 与字节数
#     · 表清单（数量）
#
# ----------------------------------------------------------------------------
#  三、什么时候需要停服
# ----------------------------------------------------------------------------
# `pg_dump` 自身**不需要**停服（它取快照）。
# ⚠️ 但本仓库有一条更严的纪律：核心持有 **session 级 advisory lock**（单认知执行者资格），
#    切换当天必须**先在本机有序停服**再起服务器 —— 否则第二个写核心会被具名拒绝。
#    那属于**切换**步骤，不属于备份步骤。本脚本只管备份。
#
# 用法：
#   sh scripts/deploy/pg-backup.sh --out ./out
#   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... sh scripts/deploy/pg-backup.sh
#   若走容器：先 `docker exec -i <container> pg_dump -U ... ` 由本脚本管道转出。
# ============================================================================

set -eu

OUT_DIR="./out"
CONTAINER="${PG_CONTAINER:-lg-postgresql-production}"
DB_USER="${PGUSER:-lg_migrate}"
DB_NAME="${PGDATABASE:-sumuwei}"

usage() {
  cat <<'EOF'
用法: sh scripts/deploy/pg-backup.sh [--out DIR] [--container NAME] [--db NAME] [--user NAME]

环境变量:
  PG_CONTAINER   容器名（默认 lg-postgresql-production）
  PGDATABASE     库名（默认 sumuwei）
  PGUSER         角色（默认 lg_migrate）
  OUT_DIR        输出目录，或用 --out

说明: 本脚本**只做逻辑备份**。它不会、也不允许复制 PGDATA 目录。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --user) DB_USER="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

log() { printf '[pg-backup] %s\n' "$*"; }
die() { printf '[pg-backup][FATAL] %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "找不到 docker"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  die "容器不存在: $CONTAINER（先确认 PG 跑在哪个容器上；不要猜）"
fi

# --- 红线检查：这个容器挂的**不是**那个事故卷 -------------------------------
# 2026-10-14 的教训是"项目名隔离 ≠ 物理卷隔离"。这里把实际挂载打印出来，
# 让人能一眼看见，而不是让脚本替人假设。
log "实际数据卷挂载（请人工核对，不要只看项目名）:"
docker inspect "$CONTAINER" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}  {{.Name}}{{end}}{{end}}' \
  | sed 's/^/[pg-backup]/'
log "备份对象: 容器=$CONTAINER 库=$DB_NAME 角色=$DB_USER"

mkdir -p "$OUT_DIR"

# ----------------------------------------------------------------------------
#  1. 逻辑转储（一致性快照）
# ----------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SQL_FILE="$OUT_DIR/dump.sql"

log "开始 pg_dump（一致性快照；不锁表、不停服）…"
# --clean --if-exists  ⇒ 目标库可从零重建
# --no-owner --no-privileges ⇒ 换机器/换角色也能灌
# 单事务保证 dump 内部一致
docker exec "$CONTAINER" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --format=plain --clean --if-exists --no-owner --no-privileges \
    > "$SQL_FILE" || die "pg_dump 失败（**没有**产生半份备份，请查上面的报错）"

[ -s "$SQL_FILE" ] || die "dump 为空 —— 拒绝继续（空备份比没备份更危险）"

gzip -f "$SQL_FILE"
log "dump 写盘完成: $SQL_FILE.gz"

# ----------------------------------------------------------------------------
#  2. 读数（决定"这份备份能不能用"的那部分）
# ----------------------------------------------------------------------------
log "采集备份读数…"

# 逐表行数 —— 恢复后要拿它**逐表**对账
#
# ⚠️ 2026-10-16 · 复核 §2 修正：**原来用的 `query(text)` 在 PostgreSQL 17 上不存在**
#    （实测：`ERROR: function query(text) does not exist`）。它在更老的版本里是
#    一个内部函数，PG14 之后不再可调用。
#    而且原写法把错误 `2>` 吞掉后**继续产出元数据** ⇒ "有文件"并不等于"可恢复"。
#    ⇒ 改用 psql 的 `\gexec`（纯客户端元命令，PG9.6+ 都有）动态生成 count 查询。
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -F '|' > "$OUT_DIR/row-counts.tsv" 2>"$OUT_DIR/row-counts.err" <<'SQL'
select format('select %L as table_name, count(*)::bigint as n from %I;', table_name, table_name)
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name;
\gexec
SQL

if [ ! -s "$OUT_DIR/row-counts.tsv" ]; then
  log "❌ 逐表行数采集**失败** —— 详见 $OUT_DIR/row-counts.err"
  log "   这份备份**不算数**：没有它就无法逐表对账，等于无法证明可恢复。"
  die "行数读数缺失，拒绝产出一份无法验证的备份"
fi

# 扩展版本（pgvector 必须记录：换机器装错版本 = 语义召回会坏）
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -c \
  "select extname||'@'||extversion from pg_extension order by extname;" \
  > "$OUT_DIR/extensions.txt" 2>/dev/null || true

SERVER_VERSION="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -c 'show server_version;' 2>/dev/null || echo 'unknown')"
IMAGE_DIGEST="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || echo 'unknown')"

DUMP_SHA="$(sha256sum "$SQL_FILE.gz" | cut -d' ' -f1)"
DUMP_BYTES="$(wc -c < "$SQL_FILE.gz" | tr -d ' ')"
TABLE_COUNT="$(wc -l < "$OUT_DIR/row-counts.tsv" | tr -d ' ')"

cat > "$OUT_DIR/manifest.json" <<JSON
{
  "kind": "project-lg/pg-logical-backup",
  "schemaVersion": 1,
  "capturedAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "capturedAtLocal": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "container": "$CONTAINER",
  "database": "$DB_NAME",
  "role": "$DB_USER",
  "serverVersion": "$SERVER_VERSION",
  "imageDigest": "$IMAGE_DIGEST",
  "dumpFile": "dump.sql.gz",
  "dumpSha256": "$DUMP_SHA",
  "dumpBytes": $DUMP_BYTES,
  "tableCount": ${TABLE_COUNT:-0},
  "rowCountsFile": "row-counts.tsv",
  "rowCountsCaptured": "separately-from-dump",
  "notes": [
    "逻辑转储，非 PGDATA 拷贝 —— 见脚本头关于 2026-10-14 事故的说明。",
    "⚠️ row-counts.tsv 与 dump **不是同一个快照**：行数是在转储前后另一次连接上读的。",
    "  在线写入期间两者可能已经不同。要做同快照对账，请在**停写窗口**内跑本脚本。",
    "恢复验证请用 scripts/deploy/pg-restore-verify.sh，它会先校验 dump 的 sha256，",
    "再灌进一个全新空库并逐表对账。",
    "本备份**不含**库外资产（嵌入模型、OCR 模型、资料库、.env）；那些走 asset-manifest。"
  ]
}
JSON

log "备份完成。"
log "  dump      : $SQL_FILE.gz"
log "  sha256    : $DUMP_SHA"
log "  大小      : $DUMP_BYTES 字节"
log "  表数量    : ${TABLE_COUNT}"
log "  读数      : $OUT_DIR/manifest.json"
log ""
log "下一步（不要跳过）："
log "  sh scripts/deploy/pg-restore-verify.sh --manifest $OUT_DIR/manifest.json"
