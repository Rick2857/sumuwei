#!/bin/bash
# 启用薄宿主并取配对读数（与替换前同一口径：PSS 曲线 90s + 空闲 CPU 采样）。
set -u
ENVF=/home/aiagent/project-lg/.env
CORE='project-lg/src/main.ts'
STAMP=$(date +%Y%m%dT%H%M%S)
BK="/var/backups/thinhost-env-$STAMP"

echo "=== ① 备份 .env（失败即中止）==="
mkdir -p "$BK" || { echo "ABORT"; exit 10; }
cp "$ENVF" "$BK/env.bak" || { echo "ABORT"; exit 11; }
echo "backup: $BK/env.bak"

echo
echo "=== ② 追加开关 ==="
grep -q '^CHARACTER_THIN_HOST=' "$ENVF" || \
  printf '\n# thinhost 2026-10-18：薄 Node 宿主。回滚 = 删掉下面这行（代码缺省即 elizaos）。\nCHARACTER_THIN_HOST=on\n' >> "$ENVF"
grep -n 'CHARACTER_THIN_HOST' "$ENVF"

echo
echo "=== ③ 重启 ==="
systemctl restart lg-qq.service
sleep 30
systemctl is-active lg-qq.service
systemctl show lg-qq.service -p NRestarts 2>/dev/null
PID=$(pgrep -f "$CORE" | head -1)
echo "core_pid=$PID"
if [ -z "$PID" ]; then echo "!!! CORE NOT RUNNING"; journalctl -u lg-qq.service --since "-60sec" --no-pager | tail -25; exit 20; fi

echo
echo "=== ④ 薄宿主确认 ==="
journalctl -u lg-qq.service --since "-90sec" --no-pager 2>/dev/null | grep -E '已选用薄 Node 宿主|thin-host' | tail -3

echo
echo "=== ⑤ PSS 曲线（与替换前同口径）==="
for i in $(seq 1 18); do
  C=$(pgrep -f "$CORE" | head -1)
  if [ -n "$C" ]; then
    echo "t+$((i*5))s pid=$C pss_kb=$(awk '/^Pss:/{print $2}' /proc/$C/smaps_rollup 2>/dev/null)"
  else
    echo "t+$((i*5))s !!! NO CORE"
  fi
  sleep 5
done

echo
echo "=== ⑥ 空闲 CPU（60s 窗口，对照替换前 1.019%）==="
PID=$(pgrep -f "$CORE" | head -1)
read -r _ _ _ _ _ _ _ _ _ _ _ _ _ U0 S0 _ < /proc/$PID/stat
T0=$(awk '{print $14+$15}' /proc/$PID/stat)
sleep 60
T1=$(awk '{print $14+$15}' /proc/$PID/stat)
HZ=$(getconf CLK_TCK)
echo "cpu_ticks_delta=$((T1-T0)) clock_ticks_per_sec=$HZ"
awk -v d="$((T1-T0))" -v hz="$HZ" 'BEGIN{printf "idle_cpu_percent_of_one_core=%.3f%%\n", (d/hz)/60*100}'

echo
echo "=== ⑦ 定时器/句柄（对照替换前 Timeout=2）==="
echo "(通过 /proc 无法直接看；用 journal 与后续探针补)"
journalctl -u lg-qq.service --since "-5min" --no-pager 2>/dev/null | grep -c '守卫定时器已 unref' | sed 's/^/guard-timer-unref log lines: /'

echo
echo "=== ⑧ 错误 ==="
journalctl -u lg-qq.service --since "-5min" --no-pager 2>/dev/null | grep -icE 'no_db_handle|ERR_MODULE|FATAL|exited, code' | sed 's/^/bad lines: /'
echo
echo "=== ⑨ 生产数据 ==="
docker exec lg-postgresql-production psql -U lg_bootstrap -d sumuwei -tAc \
  "SELECT 'memories='||count(*) FROM memories UNION ALL SELECT 'conversation_events='||count(*) FROM conversation_events;"
