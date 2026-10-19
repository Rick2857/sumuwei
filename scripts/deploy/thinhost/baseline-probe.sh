#!/bin/bash
# 只读基线探针（不重启服务、不写库、不改配置）。
# 输出 PSS/RSS、fd 数、线程数、/proc 状态。全部来自 /proc 与 smaps_rollup。
set -u
cd /home/aiagent/project-lg || exit 1

echo "### host"
date -Is
uptime
echo "--- memory ---"
free -m | head -3
echo "--- load ---"
cat /proc/loadavg

echo
echo "### lg processes (PSS/RSS/threads/fds)"
for p in $(pgrep -f 'project-lg/src/main.ts' ; pgrep -f 'project-lg/scripts/qq/chat.ts' ; pgrep -f 'encoder-worker-entry'); do
  if [ -d "/proc/$p" ]; then
    echo "--- pid $p ---"
    tr '\0' ' ' < /proc/$p/cmdline | cut -c1-120
    echo
    grep -E '^(Rss|Pss|Private_Clean|Private_Dirty|Shared)' /proc/$p/smaps_rollup 2>/dev/null || echo "(smaps_rollup unavailable)"
    grep -E '^Threads' /proc/$p/status 2>/dev/null
    echo "fds: $(ls /proc/$p/fd 2>/dev/null | wc -l)"
  fi
done

echo
echo "### pg client connections (LG db)"
docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | head

echo
echo "### node version + eliza packages present"
/usr/bin/node --version
ls -d node_modules/@elizaos/* 2>/dev/null
