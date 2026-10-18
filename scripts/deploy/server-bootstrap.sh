#!/usr/bin/env bash
# ============================================================================
# 服务器引导（需要 root）· 2026-10-16
# ============================================================================
#
#  用法（**以 root 执行**）：
#      sudo bash server-bootstrap.sh
#
#  幂等：可以重复跑。失败即停（set -e），不做"尽力而为"。
#
# ----------------------------------------------------------------------------
#  为什么需要 root：勘察读数（2026-10-16）
# ----------------------------------------------------------------------------
#   sudo          : a password is required      ← 装不了任何系统包
#   docker        : NOT installed              ← PG 与 NapCat 的容器跑不起来
#   node          : 缺（应用要求 >= 22.13.0）
#   python3       : 3.10.12                    ← 工具链要 3.12
#   Xvfb          : 缺                          ← Linux QQ 需要一个显示
#   swap          : 无                          ← 内存只有 3623 MB
#   mem / disk    : 3623 MB / 40G(35G 可用) / 2 vCPU
#
# ----------------------------------------------------------------------------
#  已知的风险，逐条说明（不藏）
# ----------------------------------------------------------------------------
#  · 换 Docker 源用阿里云镜像（这台机器在阿里云，走官方源会慢到像挂死）。
#  · **本脚本不改 sshd 配置、不开任何公网端口。** 容器端口一律绑 127.0.0.1。
#  · swap 只加 2 GB 文件，不改 fstab（重启后是否保留由你决定）。
#  · 加完 swap 后机器不会立刻变快，只是**避免 OOM 直接杀进程**。
# ============================================================================

set -euo pipefail

log()  { printf '\n\033[1m[bootstrap] %s\033[0m\n' "$*"; }
info() { printf '[bootstrap]   %s\n' "$*"; }
die()  { printf '\033[31m[bootstrap][FATAL] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash $0"

export DEBIAN_FRONTEND=noninteractive
APT_ALIYUN="https://mirrors.aliyun.com/ubuntu/"
DOCKER_CE_ALIYUN="https://mirrors.aliyun.com/docker-ce/linux/ubuntu"

# ---------------------------------------------------------------------------
log "0/6 基础包"
# ---------------------------------------------------------------------------
info "apt 源 -> $APT_ALIYUN"
sed -i "s|http[s]*://archive.ubuntu.com/ubuntu|${APT_ALIYUN}|g; \
        s|http[s]*://security.ubuntu.com/ubuntu|${APT_ALIYUN}|g; \
        s|http[s]*://cn.archive.ubuntu.com/ubuntu|${APT_ALIYUN}|g" \
    /etc/apt/sources.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    ca-certificates curl wget gnupg lsb-release git tar xz-utils \
    build-essential python3-dev
info "基础包就绪"

# ---------------------------------------------------------------------------
log "1/6 Docker Engine + Compose v2"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
    info "docker 已存在：$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
else
    info "写入 docker-ce 源（阿里云镜像）"
    install -m 0755 -d /etc/apt/keyrings
    # ⚠️ 2026-10-16 实测踩坑：`gpg --dearmor` 在**无 tty 的 SSH 会话**里会去开 /dev/tty
    #    然后报 `gpg: cannot open '/dev/tty'` 并连带把 curl 打断（`curl: (23)`）。
    #    ⇒ 显式 `--batch --yes`，并且先落盘再转换，让下载失败能被单独看见。
    KEY_TMP="$(mktemp)"
    curl -fsSL "$DOCKER_CE_ALIYUN/gpg" -o "$KEY_TMP" || { rm -f "$KEY_TMP"; die "下载 docker-ce GPG key 失败"; }
    gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg "$KEY_TMP"
    rm -f "$KEY_TMP"
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_CE_ALIYUN ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    info "docker 已安装"
fi
systemctl enable --now docker
info "docker 运行中：$(docker version --format '{{.Server.Version}}')"
info "compose v2：$(docker compose version --short 2>/dev/null || echo '缺失')"

# 把部署用户加进 docker 组（这样日常部署**不需要 sudo**）
DEPLOY_USER="${DEPLOY_USER:-aiagent}"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
    getent group docker >/dev/null || groupadd docker
    usermod -aG docker "$DEPLOY_USER"
    info "已把 $DEPLOY_USER 加入 docker 组（**该用户需要重新登录才生效**）"
fi

# ---------------------------------------------------------------------------
log "2/6 Node.js 22"
# ---------------------------------------------------------------------------
# 应用的 engines 是 >=22.13.0。Ubuntu 22.04 自带的是 18.x，**不能**用。
NODE_MAJOR=22
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge 22 ]; then
    info "node 已满足：$(node -v)"
else
    apt-get install -y -qq "nodejs=${NODE_MAJOR}.x" "npm=${NODE_MAJOR}.x" || {
        info "apt 源里没有 nodejs${NODE_MAJOR}.x —— 改用 NodeSource"
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y -qq nodejs
    }
    info "node = $(node -v)"
fi

# ---------------------------------------------------------------------------
log "3/6 Python 3.12 + venv（工具链需要）"
# ---------------------------------------------------------------------------
# Ubuntu 22.04 自带 3.10。自动记忆 / OCR / 文档 / Office 四个 venv 在开发机上
# 是 3.12.13 建的 —— 锁在 3.10 上大概率装不上已固定的依赖版本。
if python3.12 -V >/dev/null 2>&1; then
    info "python3.12 已存在：$(python3.12 -V 2>&1)"
else
    info "加入 deadsnakes PPA 取 python3.12"
    apt-get install -y -qq software-properties-common
    add-apt-repository -y ppa:deadsnakes/ppa
    apt-get update -qq
    apt-get install -y -qq python3.12 python3.12-venv python3.12-dev
    info "python3.12 = $(python3.12 -V 2>&1)"
fi

# ---------------------------------------------------------------------------
log "4/6 Xvfb（Linux QQ 需要一个显示，哪怕是无头的）"
# ---------------------------------------------------------------------------
apt-get install -y -qq xvfb x11-utils libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1
command -v Xvfb >/dev/null 2>&1 && info "Xvfb 就绪" || die "Xvfb 装不上"

# ---------------------------------------------------------------------------
log "5/6 swap 2 GB（内存只有 3623 MB，没有它更容易被 OOM 直接杀）"
# ---------------------------------------------------------------------------
if swapon --show | grep -q .; then
    info "swap 已存在，跳过"
else
    SWAPFILE=/swapfile
    if [ ! -f "$SWAPFILE" ]; then
        info "创建 2 GB swap 文件…"
        fallocate -l 2G "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none
        chmod 600 "$SWAPFILE"
        mkswap "$SWAPFILE" >/dev/null
    fi
    swapon "$SWAPFILE"
    info "swap 已启用：$(swapon --show --noheadings --size | tr -d ' ' || echo '2G')"
    info "⚠️ **没有**写进 /etc/fstab —— 重启后不保留。要保留请自行加一行："
    info "    $SWAPFILE none swap sw 0 0"
fi
# 轻微降低 swappiness：我们要它兜底，不是要它拖慢正常路径
sysctl -q -w vm.swappiness=10 || true

# ---------------------------------------------------------------------------
log "6/6 校验收尾"
# ---------------------------------------------------------------------------
echo
info "──────────────── 读数 ────────────────"
printf '  os        %s\n' "$(. /etc/os-release && echo "$PRETTY_NAME")"
printf '  cpu       %s vCPU\n' "$(nproc)"
printf '  mem       %s\n' "$(free -m | awk '/^Mem:/{printf "%d MB total, %d MB available", $2, $7}')"
printf '  swap      %s\n' "$(free -m | awk '/^Swap:/{if($2>0) printf "%d MB", $2; else printf "(none)"}')"
printf '  disk      %s\n' "$(df -h / | awk 'NR==2{print $4" free of "$2}')"
printf '  docker    %s\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo MISSING)"
printf '  compose   %s\n' "$(docker compose version --short 2>/dev/null || echo MISSING)"
printf '  node      %s\n' "$(node -v 2>/dev/null || echo MISSING)"
printf '  python    %s (3.10 仍在) / %s\n' "$(python3 -V 2>&1 | cut -d' ' -f2)" "$(python3.12 -V 2>&1 | cut -d' ' -f2)"
printf '  Xvfb      %s\n' "$(command -v Xvfb || echo MISSING)"
printf '  groups    %s\n' "$(id -nG "$DEPLOY_USER" 2>/dev/null || echo '?')"
echo
info "✅ 引导完成。**请让 $DEPLOY_USER 重新登录一次**（docker 组权限才生效）。"
info "⚠️ 本脚本没有开任何公网端口，也没有改 sshd。"
