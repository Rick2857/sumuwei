#!/bin/sh
# ============================================================================
#  服务器仿真环境 · 容器入口（2026-10-20）
# ============================================================================
#
#  它扮演的角色：服务器上 `lg-qq.service` 的**前置准备**（systemd 的
#  ExecStartPre + 目录准备），把仿真主机带到"可以起核心"的状态。
#
#  ---------------------------------------------------------------------------
#  做的事（逐条都有理由）
#  ---------------------------------------------------------------------------
#  1. 等 PostgreSQL 真的能连上（不是"容器起来了"，是"能握手"）
#     ⚠️ 服务器上 core 持有 session 级 advisory lock；**两个核心不能同时写同一个库**
#        ⇒ 仿真里也必须等 PG 真的就绪再起核心。
#  2. 把凭据文件从只读挂载复制进仓库根，并**改成 600**
#     （服务器上的口径：`chmod 600 .env .env.qq` —— 10-15 §3.5）
#     ⚠️ 凭据**不进镜像**：`.env` / `.env.qq` 都被 .dockerignore 排除了。
#  3. 造出服务器上**确实存在**的那些目录（10-18 记录：这两个目录当初缺失，
#     是"独立初始化空目录并复验"才补上的）
#  4. 把 PID 1 交给 supervisor（systemd 形状的重启与停机策略）
#
#  ---------------------------------------------------------------------------
#  ⚠️ 诚实边界：这个入口**不做**"假装就绪"的事 ——
#     PG 起不来就**如实失败**（退出码 1），不带着半个环境往下跑。
# ============================================================================

set -eu

REPO=/opt/project-lg
ENV_DIR=/opt/serversim/env
WAIT_SECONDS="${SIM_PG_WAIT_SECONDS:-120}"

log() { printf '[serversim-entrypoint] %s\n' "$1"; }
die() { printf '[serversim-entrypoint][FATAL] %s\n' "$1" >&2; exit 1; }

# --- 0. 前提检查 ----------------------------------------------------------
[ -d "$REPO" ] || die "仓库目录不存在：$REPO"
[ -f "$ENV_DIR/.env" ] || die "缺少 $ENV_DIR/.env（先跑 pnpm serversim:prepare）"
[ -f "$ENV_DIR/.env.qq" ] || die "缺少 $ENV_DIR/.env.qq（先跑 pnpm serversim:prepare）"

# --- 1. 等 PostgreSQL ------------------------------------------------------
# ⚠️ 这里连的是 **`pg:5432`（compose 网络里的服务名）**，不是 127.0.0.1:55432：
#    后者是**转发器**的地址，而转发器的上游正是 pg ⇒ 连转发器会"连得上"但
#    上游还没起 ⇒ 等待会假成功。
log "等待 PostgreSQL（pg:5432），上限 ${WAIT_SECONDS}s"
elapsed=0
until node -e "
  const net = require('node:net');
  const socket = net.connect(5432, 'pg');
  socket.on('connect', () => { socket.destroy(); process.exit(0) });
  socket.on('error', () => process.exit(1));
  setTimeout(() => { socket.destroy(); process.exit(1) }, 2000);
" 2>/dev/null; do
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge "$WAIT_SECONDS" ]; then
    die "PostgreSQL 在 ${WAIT_SECONDS}s 内没有就绪 —— **如实失败**，不带着半个环境往下跑"
  fi
  sleep 2
done
log "PostgreSQL 已就绪（等了 ${elapsed}s）"

# --- 1b. 起环回转发器 ------------------------------------------------------
# 核心在仿真里看到的地址必须与服务器**逐字相同**（127.0.0.1:55432 等）。
# ⇒ 由转发器把环回地址映射到 compose 网络上的兄弟容器。
# ⚠️ 转发器**先**起：核心一起来就会连 127.0.0.1:55432。
log "启动环回转发器（127.0.0.1:55432 → pg:5432 等）"
node /opt/serversim/forwarder.mjs &
FORWARDER_PID=$!
# 转发器死了 ⇒ 仿真不成立（核心会连不上却报"数据库查询失败"）⇒ 一起退出。
trap 'kill "$FORWARDER_PID" 2>/dev/null || true' EXIT
sleep 1
kill -0 "$FORWARDER_PID" 2>/dev/null || die "环回转发器起不来 —— 仿真不成立"

# --- 2. 凭据就位（600）----------------------------------------------------
for name in .env .env.qq .env.wechat; do
  if [ -f "$ENV_DIR/$name" ]; then
    cp "$ENV_DIR/$name" "$REPO/$name"
    chmod 600 "$REPO/$name"
    log "凭据就位：$name（600）"
  fi
done
# .npmrc：镜像里已经是服务器口径（无本机代理）；这里再确认一次
if grep -qE '^\s*(https-)?proxy\s*=' "$REPO/.npmrc" 2>/dev/null; then
  die "$REPO/.npmrc 里出现了代理配置 —— 服务器上没有这个代理（10-15 §3.1）"
fi

# --- 3. 服务器上确实存在的目录 --------------------------------------------
for dir in data/qq-private data/personal-library data/action-sandbox data/runtime data/snapshots; do
  mkdir -p "$REPO/$dir"
done
chmod 700 "$REPO/data/personal-library" "$REPO/data/action-sandbox" 2>/dev/null || true

# --- 4. 嵌入模型（硬编码相对路径 + process.cwd()，没有任何环境变量能改）---
#    ⚠️ 这条判据是照抄 10-16 审计 §6 清单第 3 条：进程**必须**从仓库根启动。
if [ ! -d "$REPO/artifacts/m9.5/local/embedding-lab/models" ]; then
  log "⚠️ 缺少语义召回模型目录 —— 核心会在装配期抛错（不是降级）"
else
  log "语义召回模型目录在位"
fi

# --- 5. 交给 supervisor ----------------------------------------------------
log "启动 supervisor（systemd 形状：Restart=always / KillSignal=SIGINT / TimeoutStopSec=180）"
exec node /opt/serversim/supervisor.mjs
