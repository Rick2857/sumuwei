#!/bin/bash
# 建立**可回滚**基线（root 运行，写 /var/backups —— artifacts/deploy 属 root，aiagent 写不了）。
# ⚠️ 上一轮 deploy 的备份失败但替换已发生 ⇒ 这一步是补建，不是走过场。
set -u
REPO=/home/aiagent/project-lg
STAMP=$(date +%Y%m%dT%H%M%S)
BK="/var/backups/thinhost-$STAMP"

mkdir -p "$BK/src/infrastructure/runtime" || exit 1
cd "$REPO" || exit 1

cp src/main.ts "$BK/src/main.ts"
cp src/db/index.ts "$BK/src/index.ts"
for f in thin-host.ts thin-host-bridge.ts thin-host-factory.ts; do
  [ -f "src/infrastructure/runtime/$f" ] && cp "src/infrastructure/runtime/$f" "$BK/src/infrastructure/runtime/$f"
done

sha256sum src/main.ts src/db/index.ts > "$BK/sha256.txt"
chown -R root:root "$BK"

echo "backup_dir=$BK"
cat "$BK/sha256.txt"
echo "--- verify backup readable ---"
ls -l "$BK/src/" "$BK/src/infrastructure/runtime/"
echo "--- restore command (run as aiagent) ---"
echo "cp $BK/src/main.ts $REPO/src/main.ts && cp $BK/src/index.ts $REPO/src/db/index.ts"
