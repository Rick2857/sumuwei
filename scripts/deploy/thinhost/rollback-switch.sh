#!/bin/bash
# 回滚薄宿主开关，让服务先用 ElizaOS 起来（QQ 恢复优先于修接线）。
set -u
ENVF=/home/aiagent/project-lg/.env

echo "=== ① 移除开关行 ==="
if grep -q '^CHARACTER_THIN_HOST=' "$ENVF"; then
  grep -v '^CHARACTER_THIN_HOST=' "$ENVF" > "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
  echo "switch removed"
else
  echo "switch already absent"
fi
grep -c 'CHARACTER_THIN_HOST' "$ENVF" | sed 's/^/occurrences now: /'

echo
echo "=== ② 启动服务（仍是 ElizaOS 宿主）==="
systemctl start lg-qq.service
sleep 25
systemctl is-active lg-qq.service
systemctl show lg-qq.service -p NRestarts 2>/dev/null
pgrep -af 'project-lg/src/main.ts' | head -1

echo
echo "=== ③ 错误检查 ==="
journalctl -u lg-qq.service --since "-40sec" --no-pager 2>/dev/null | grep -icE 'ERR_MODULE|FATAL|no_db_handle|exited, code' | sed 's/^/bad lines: /'
echo "--- db ready lines ---"
journalctl -u lg-qq.service --since "-40sec" --no-pager 2>/dev/null | grep -E '数据库就绪|跳过启动 DDL|schema 已就绪' | tail -3
