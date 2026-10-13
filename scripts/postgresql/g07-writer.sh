#!/bin/sh
# =============================================================================
#  PG-G07（在线备份）用的**并发写入进程** —— 一个独立的 OS 进程。
# =============================================================================
#
#  为什么要有它：验收契约 `G07.1` 逐字要求"**核心活动时**备份成功（不停止核心）"。
#  在隔离试验实例上没有"核心"可跑，但"活动"这件事可以**如实**做出来：
#  一个真的在写库、真的独立于备份进程的写入者。
#
#  ⚠️ 这不等于"对真实核心做过在线备份"。真实核心的在线备份读数属 WP7/WP8
#     （见 `L-PGW4-07`）。这里证明的是**备份机制**在并发写入下：
#     · 不需要停任何东西；
#     · 取到的是一个**事务一致的**点（不会取到"半个事务"）。
#
#  ---------------------------------------------------------------------------
#  三条设计（每条都是判据的一部分，别"顺手简化"）
#  ---------------------------------------------------------------------------
#  ① **每批恰好 2 行、一个事务**：这样"目标库里出现了只有 1 行的批次"
#     就等价于"备份取到了半提交状态" —— 快照一致性变成**可判定的**。
#  ② **提交后才打印**：`psql -c "insert…; select…"` 里的多条语句走同一条
#     简单查询 ⇒ PostgreSQL 把它们包在**一个隐式事务**里。stdout 上出现一行
#     就意味着"那一批已经提交"。于是 stdout 就是一份**提交后记录**——
#     备份校验拿它与恢复出来的内容对，而**不**去比"还在变的实时源"。
#  ③ **停机靠库里的一行**（`public.g07_control.stop`），**不是**靠文件：
#     容器里只挂了 `scripts/postgresql/`（compose 的 `.:/opt/lg:ro` 里那个 `.`
#     是 **compose 文件所在目录**），宿主机的 `artifacts/` **看不见**。
#     ⇒ 想让容器里的进程"停下来"，唯一不引入新挂载的办法就是**经数据库**。
#
#  用法（容器内）：
#    PGUSER=... PGPASSWORD=... PGDATABASE=... MAX_BATCHES=... \
#      sh /opt/lg/g07-writer.sh
# =============================================================================

set -u

: "${PGUSER:?需要 PGUSER}"
: "${PGDATABASE:?需要 PGDATABASE}"
: "${MAX_BATCHES:=20000}"

q() {
  psql -h 127.0.0.1 -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -tAq -c "$1"
}

i=0
while [ "$i" -lt "$MAX_BATCHES" ]; do
  # ⚠️ 停机检查的输出**必须**被捕获（`$(...)`），不能漏到 stdout：
  #    stdout 是"提交后记录"这条判据通道，混进别的行就会污染它。
  stop=$(q "select coalesce((select stop from public.g07_control limit 1), false)" 2>/dev/null)
  [ "$stop" = "t" ] && break

  i=$((i + 1))
  # ⚠️ insert 与 select 必须**在同一条 -c 里**（见文件头 ②）。
  out=$(q "insert into public.online_backup_probe(batch_id, seq, payload) values ($i,1,'p$i-1'),($i,2,'p$i-2'); select 'BATCH|$i|'||(select count(*) from public.online_backup_probe where batch_id=$i)||'|'||coalesce(md5(string_agg(batch_id||':'||seq||':'||payload, ',' order by seq)),'none') from public.online_backup_probe where batch_id=$i")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "WRITER_ERROR|$i|$rc"
    exit 1
  fi
  echo "$out"
  sleep 0.01
done

echo "WRITER_STOPPED|$i"
