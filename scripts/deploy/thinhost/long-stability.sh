#!/bin/bash
# 长时稳定性核验：薄宿主已跑 ~1 小时，确认无重启、无内存增长、无错误。
set -u
CORE='project-lg/src/main.ts'
ENVF=/opt/project-lg/.env

echo "=== ① 开关状态 ==="
grep -n 'CHARACTER_THIN_HOST' "$ENVF"

echo
echo "=== ② 服务状态 ==="
systemctl is-active lg-qq.service
systemctl show lg-qq.service -p NRestarts -p ExecMainStartTimestamp 2>/dev/null
PID=$(pgrep -f "$CORE" | head -1)
echo "core_pid=$PID uptime=$(ps -o etimes= -p "$PID" | tr -d ' ')s"
echo "  (uptime < 3600 ⇒ 中途重启过)"

echo
echo "=== ③ 内存（对照：替换前稳态 341.1 MB）==="
awk '/^(Rss|Pss|Private_Dirty)/{print}' /proc/$PID/smaps_rollup

echo
echo "=== ④ 空闲 CPU 60s（对照：替换前 1.019%）==="
T0=$(awk '{print $14+$15}' /proc/$PID/stat); sleep 60
T1=$(awk '{print $14+$15}' /proc/$PID/stat); HZ=$(getconf CLK_TCK)
awk -v d="$((T1-T0))" -v hz="$HZ" 'BEGIN{printf "idle_cpu_percent_of_one_core=%.3f%%\n",(d/hz)/60*100}'

echo
echo "=== ⑤ 薄宿主是否真在用 ==="
journalctl -u lg-qq.service --since "-70min" --no-pager 2>/dev/null | grep -E '已选用薄 Node 宿主' | tail -2
journalctl -u lg-qq.service --since "-70min" --no-pager 2>/dev/null | grep -c '数据库就绪' | sed 's/^/db-ready lines: /'

echo
echo "=== ⑥ 错误（自启动以来）==="
journalctl -u lg-qq.service --since "-70min" --no-pager 2>/dev/null | grep -icE 'no_db_handle|ERR_MODULE|FATAL|exited, code|is not a function' | sed 's/^/bad lines: /'

echo
echo "=== ⑦ QQ 入口连通（容器与连接）==="
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'llbot|pmhq|postgresql' || true
grep -c 'qq' /proc/$PID/cmdline >/dev/null 2>&1 && tr '\0' ' ' < /proc/$PID/cmdline | cut -c1-160 && echo

echo
echo "=== ⑧ 生产数据（应与基线逐字相同）==="
docker exec lg-postgresql-production psql -U lg_bootstrap -d sumuwei -tAc \
  "SELECT 'memories='||count(*) FROM memories UNION ALL SELECT 'conversation_events='||count(*) FROM conversation_events UNION ALL SELECT 'memory_records='||count(*) FROM memory_records UNION ALL SELECT 'character_states='||count(*) FROM character_states;"
