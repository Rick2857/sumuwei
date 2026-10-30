#!/bin/bash
# 启用薄宿主：追加 CHARACTER_THIN_HOST=on 到 .env，重启，取配对读数。
# 纪律：先备份 .env（**失败即中止**），只追加不改其它行，回滚 = 删掉那一行。
set -u
REPO=/opt/project-lg
ENVF="$REPO/.env"
STAMP=$(date +%Y%m%dT%H%M%S)
BK="/var/backups/thinhost-env-$STAMP"

echo "=== ① 备份 .env（失败即中止）==="
mkdir -p "$BK" || { echo "ABORT: 备份目录失败"; exit 10; }
cp "$ENVF" "$BK/env.bak" || { echo "ABORT: .env 备份失败"; exit 11; }
echo "backup OK: $BK/env.bak"
echo "env lines before: $(wc -l < "$ENVF")"

echo
echo "=== ② 追加开关（只追加，不改任何已有行）==="
if grep -q '^CHARACTER_THIN_HOST=' "$ENVF"; then
  echo "已存在 CHARACTER_THIN_HOST，跳过追加"
else
  printf '\n# thinhost 2026-10-18：薄 Node 宿主。回滚 = 删掉下面这行（代码缺省即 elizaos）。\nCHARACTER_THIN_HOST=on\n' >> "$ENVF"
  echo "appended"
fi
grep -n 'CHARACTER_THIN_HOST' "$ENVF"
echo "env lines after: $(wc -l < "$ENVF")"

echo
echo "=== ③ 重启 ==="
systemctl restart lg-qq.service
sleep 30
systemctl is-active lg-qq.service
systemctl show lg-qq.service -p NRestarts 2>/dev/null
pgrep -af 'project-lg/src/main.ts' | head -1

echo
echo "=== ④ 薄宿主是否真的在用 ==="
journalctl -u lg-qq.service --since "-2min" --no-pager 2>/dev/null | grep -E '已选用薄 Node 宿主|thin-host' | tail -5

echo
echo "=== ⑤ 错误 ==="
journalctl -u lg-qq.service --since "-2min" --no-pager 2>/dev/null | grep -icE 'ERR_MODULE|FATAL|exited, code' | sed 's/^/fatal lines: /'
journalctl -u lg-qq.service --since "-2min" --no-pager 2>/dev/null | grep -iE 'error|拒绝|失败' | tail -8
