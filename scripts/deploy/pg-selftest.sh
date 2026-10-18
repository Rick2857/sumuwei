#!/bin/sh
# ============================================================================
# pg-backup.sh / pg-restore-verify.sh 的**端到端自测**
# （2026-10-16 · 复核 §2 要求："做生成备份→新库恢复→读回→篡改dump拒收的完整测试"）
# ============================================================================
#
# ----------------------------------------------------------------------------
#  它在什么库上跑
# ----------------------------------------------------------------------------
# ⚠️ 在**本机 PostgreSQL 实例**里新建两个**一次性**的库：
#     lg_deploy_selftest_src     造数据用（被备份）
#     lg_restore_verify_*        恢复验证自己会建、自己会删
#   **绝不碰生产库 `sumuwei`**：脚本里对它没有任何读或写。
# ⚠️ 如果你不想让任何东西落到生产实例上，**不要**跑这个脚本 ——
#    改在一次性容器里跑（复核原文建议的是"明确指定的隔离容器"）。
#
# ----------------------------------------------------------------------------
#  它证明什么
# ----------------------------------------------------------------------------
#   T1 生成备份成功，且 manifest 齐备
#   T2 恢复验证**通过**（逐表行数一致 + 扩展一致）
#   T3 **篡改 dump 后恢复验证必须拒绝**（sha256 闸真的拦得住）
#   T4 `--manifest` 给文件路径时不再拼出 `…/manifest.json/manifest.json`
#   T5 恢复库里真的能查到数据（不只是行数对上）
#
#   ⚠️ 不证明：跨实例/跨版本恢复、大库性能、并行一致性。
# ============================================================================

set -eu

CONTAINER="${PG_CONTAINER:-lg-postgresql-production}"
DB_USER="${PGUSER:-lg_migrate}"
ADMIN_USER="${PG_ADMIN_USER:-lg_bootstrap}"
SRC_DB="${PG_SELFTEST_DB:-lg_deploy_selftest_src}"
WORK="${PG_SELFTEST_DIR:-$(mktemp -d 2>/dev/null || mktemp -d -t lgpgs)}"
HERE="$(cd "$(dirname "$0")" && pwd)"

log()  { printf '[pg-selftest] %s\n' "$*"; }
fail() { printf '[pg-selftest][FAIL] %s\n' "$*" >&2; FAILURES=$((FAILURES+1)); }
ok()   { printf '[pg-selftest]  OK  %s\n' "$*"; }
FAILURES=0

cleanup() {
    log "清理一次性库与临时目录"
    docker exec "$CONTAINER" dropdb -U "$ADMIN_USER" --if-exists "$SRC_DB" >/dev/null 2>&1 || true
    # ⚠️ 必须用**管理角色** drop：最小权限角色（lg_migrate）没有 DROP DATABASE 权限，
    #    而 `|| true` 会把那个失败**静默吞掉** —— 本轮实测就是这样留下了一库残渣。
    #    另外原来用管道喂 while 循环：改成先落文件再读，避免子 shell 里的失败被吞。
    docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d postgres -At -c \
      "select datname from pg_database where datname like 'lg_restore_verify_%';" > "$WORK/.leftover" 2>/dev/null || true
    if [ -s "$WORK/.leftover" ]; then
        while read -r d; do
            [ -n "$d" ] || continue
            if docker exec "$CONTAINER" dropdb -U "$ADMIN_USER" --if-exists "$d" >/dev/null 2>&1; then
                log "  已删除残留验证库 $d"
            else
                log "  WARNING 删不掉 $d -- 请手工处理: docker exec $CONTAINER dropdb -U $ADMIN_USER $d"
            fi
        done < "$WORK/.leftover"
    fi
    [ -n "${PG_SELFTEST_KEEP:-}" ] || rm -rf "$WORK"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "找不到 docker" >&2; exit 2; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "容器不存在: $CONTAINER" >&2; exit 2; }

log "容器: $CONTAINER   角色: $DB_USER   临时源库: $SRC_DB   工作目录: $WORK"

# ---------------------------------------------------------------------------
log "T0 造数据"
# ---------------------------------------------------------------------------
# 属主给 $DB_USER（lg_migrate）—— 与生产同形（`sumuwei` 的属主就是它）。
# ⚠️ 为什么要 `-O`：
#   · 不给的话，库属主是管理角色，**最小权限角色**连表都碰不到：
#     `pg_dump` 会失败于 `permission denied for table …`（它要 LOCK TABLE ACCESS SHARE）。
#     顺带一提：这也证明 pg-backup.sh 的**失败关闭**是对的 —— 它拒绝产出半份 dump。
#   · PG15+ 起 `public` schema 不再默认授予 CREATE；属主是 $DB_USER 时它才能建表。
docker exec "$CONTAINER" dropdb -U "$ADMIN_USER" --if-exists "$SRC_DB" >/dev/null 2>&1 || true
docker exec "$CONTAINER" createdb -U "$ADMIN_USER" -O "$DB_USER" "$SRC_DB" || { echo "建临时库失败" >&2; exit 2; }
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SRC_DB" -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table selftest_alpha (id int primary key, note text);
create table selftest_beta  (id int primary key, amount numeric);
create table selftest_empty (id int primary key);   -- deliberately empty: an empty table must still reconcile
insert into selftest_alpha select g, 'note-' || g from generate_series(1, 250) g;
insert into selftest_beta  select g, g * 1.5 from generate_series(1, 40) g;
SQL
ALPHA_ROWS="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$SRC_DB" -At -c 'select count(*) from selftest_alpha;')"
ok "临时源库已造好（selftest_alpha=$ALPHA_ROWS 行，含 1 张空表）"

# ---------------------------------------------------------------------------
log "T1 生成备份"
# ---------------------------------------------------------------------------
if PGDATABASE="$SRC_DB" PGUSER="$DB_USER" PG_CONTAINER="$CONTAINER" \
   sh "$HERE/pg-backup.sh" --out "$WORK" --container "$CONTAINER" --db "$SRC_DB" --user "$DB_USER" >"$WORK/backup.log" 2>&1; then
    ok "pg-backup.sh 退出码 0"
else
    fail "pg-backup.sh 失败（见 $WORK/backup.log）"; sed -n '1,25p' "$WORK/backup.log" >&2
fi
for f in manifest.json dump.sql.gz row-counts.tsv extensions.txt; do
    [ -s "$WORK/$f" ] && ok "产出 $f" || fail "缺少或为空: $f"
done
grep -q 'rowCountsCaptured' "$WORK/manifest.json" 2>/dev/null \
    && ok "manifest 标注了行数与 dump 不同快照" \
    || fail "manifest 没有标注行数快照口径"

# ---------------------------------------------------------------------------
log "T2 恢复验证（应当通过）"
# ---------------------------------------------------------------------------
if PGDATABASE="$SRC_DB" PGUSER="$DB_USER" PG_CONTAINER="$CONTAINER" \
   sh "$HERE/pg-restore-verify.sh" --manifest "$WORK/manifest.json" >"$WORK/verify.log" 2>&1; then
    ok "pg-restore-verify.sh 退出码 0"
else
    fail "恢复验证**未通过**（见 $WORK/verify.log）"; sed -n '1,30p' "$WORK/verify.log" >&2
fi
grep -q 'sha256 与 manifest 一致' "$WORK/verify.log" 2>/dev/null \
    && ok "T4 通过：--manifest 收文件路径时不再拼出 …/manifest.json/manifest.json" \
    || fail "T4：看起来仍然在拼路径"

# ---------------------------------------------------------------------------
log "T3 篡改 dump，恢复验证必须**拒绝**"
# ---------------------------------------------------------------------------
cp "$WORK/dump.sql.gz" "$WORK/dump.sql.gz.orig"
printf 'x' >> "$WORK/dump.sql.gz"
if PGDATABASE="$SRC_DB" PGUSER="$DB_USER" PG_CONTAINER="$CONTAINER" \
   sh "$HERE/pg-restore-verify.sh" --manifest "$WORK/manifest.json" >"$WORK/tamper.log" 2>&1; then
    fail "被篡改的 dump 居然通过了验证 —— sha256 闸没起作用"
else
    ok "被篡改的 dump 被拒收（退出码非 0）"
fi
grep -q 'sha256 与 manifest 不符' "$WORK/tamper.log" 2>/dev/null \
    && ok "拒收原因是 sha256 不符（不是别的原因）" \
    || fail "拒收原因不是 sha256（见 $WORK/tamper.log）"
mv "$WORK/dump.sql.gz.orig" "$WORK/dump.sql.gz"

# ---------------------------------------------------------------------------
log "T5 恢复库里真的查得到数据（用 --keep 再跑一遍，才能看见那个库）"
# ---------------------------------------------------------------------------
# ⚠️ T2 那一遍是**默认行为**（用完即删）⇒ 跑完那个库已经没了，这是对的。
#    要验"库里真的有数据"，必须用 --keep 再跑一遍，然后查；最后由 cleanup 统一删掉。
KEEP_LOG="$WORK/verify-keep.log"
if PGDATABASE="$SRC_DB" PGUSER="$DB_USER" PG_ADMIN_USER="$ADMIN_USER" PG_CONTAINER="$CONTAINER" \
   sh "$HERE/pg-restore-verify.sh" --manifest "$WORK/manifest.json" --keep >"$KEEP_LOG" 2>&1; then
    ok "--keep 那一遍也通过"
else
    fail "--keep 那一遍失败（见 $KEEP_LOG）"; sed -n '1,25p' "$KEEP_LOG" >&2
fi
TMPDB="$(docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d postgres -At -c \
  "select datname from pg_database where datname like 'lg_restore_verify_%' order by datname desc limit 1;" | tr -d '\r')"
if [ -n "$TMPDB" ]; then
    N="$(docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d "$TMPDB" -At -c 'select count(*) from selftest_alpha;' 2>/dev/null | tr -d '\r')"
    if [ "$N" = "$ALPHA_ROWS" ]; then
        ok "恢复库 $TMPDB 里 selftest_alpha 有 $N 行（与源库一致）"
    else
        fail "恢复库行数 '$N' != 源库 '$ALPHA_ROWS'"
    fi
    E="$(docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d "$TMPDB" -At -c 'select count(*) from selftest_empty;' 2>/dev/null | tr -d '\r')"
    [ "$E" = "0" ] && ok "空表也被正确恢复（0 行）—— 空表最容易在对账里被漏掉" \
                  || fail "空表恢复后行数是 '$E'，应为 0"
else
    fail "找不到保留的恢复验证库"
fi

# ---------------------------------------------------------------------------
log ""
log "合计失败: $FAILURES"
if [ "$FAILURES" -eq 0 ]; then log "PASS"; exit 0; else log "FAIL"; exit 1; fi
