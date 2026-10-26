# ============================================================================
#  服务器仿真环境 · 仿真主机镜像（2026-10-20）
# ============================================================================
#
#  ⚠️ 刻意**不**写 `# syntax=docker/dockerfile:1.7`：
#     那会让 BuildKit 去 registry-1.docker.io 拉 frontend 镜像。
#     本机 Docker Desktop **没有 HTTPS 代理**（实测：连 registry-1.docker.io:443
#     被直接拒绝）⇒ 第一次构建就栽在这里。
#     本文件用到的特性（ARG/ENV/COPY --chown/USER/WORKDIR/CMD/STOPSIGNAL）
#     内置 frontend 全部支持 ⇒ 不给它一个联网的理由。
# ============================================================================
#
#  这个镜像扮演的角色是**服务器那台机器**，不是某个服务。
#  它被 `serversim/compose.yml` 里的另外几个容器（PostgreSQL / 假 OneBot /
#  假微信桥 / 假模型端点）通过网络命名空间共享当作"同一台机器的 127.0.0.1"。
#
#  口径来源：`serversim/server-spec.json`（机器可读的服务器画像）。
#  逐条对照：
#    · Ubuntu 22.04 ............ server-spec.host.os
#    · Node 22.23.3 ........... server-spec.host.node（10-18 切换记录的实测读数）
#    · Python 3.12 (deadsnakes)  server-bootstrap.sh 第 3/6 步
#    · 非 root 用户 `aiagent` ... server-spec.host.user
#    · TZ=Asia/Shanghai ........ server-spec.host.timezone
#    · **干净的 .npmrc** ....... server-spec.env.npmrc（服务器上没有本机代理）
#
#  ⚠️ 这个镜像**不包含**任何真实凭据：`.env` / `.env.qq` / `.env.wechat`
#     都被 .dockerignore 排除，运行时由 entrypoint 从只读挂载里复制进来。
# ============================================================================

FROM ubuntu:22.04

# --- 版本钉死（与 server-spec.json 对齐）-----------------------------------
ARG NODE_VERSION=22.23.3
ARG PNPM_VERSION=12.4.1
ARG APP_USER=aiagent
ARG APP_UID=1000
ARG APP_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai \
    NODE_VERSION=${NODE_VERSION} \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:/usr/local/lib/nodejs/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# --- 1/6 系统包（对应 server-bootstrap.sh 的 0/6 与 3/6 与 4/6）------------
# ⚠️ 10-15 审计 §3.1 的教训：本机 `.npmrc` 里的 `127.0.0.1:7688` 代理在服务器上
#    不存在 ⇒ 装依赖会卡死。这里装的是**系统包**，不涉及 npm 代理。
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl wget gnupg git tar xz-utils build-essential tzdata procps \
      software-properties-common \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      python3.12 python3.12-venv python3.12-dev \
      xvfb x11-utils libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 \
 && rm -rf /var/lib/apt/lists/* \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

# --- 2/6 Node 22.23.3（官方 tarball，版本逐字钉住）-------------------------
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && mkdir -p /usr/local/lib/nodejs \
 && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
 && ln -s "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64" /usr/local/lib/nodejs/current \
 && ln -s /usr/local/lib/nodejs/current/bin/node /usr/local/bin/node \
 && ln -s /usr/local/lib/nodejs/current/bin/npm  /usr/local/bin/npm  \
 && ln -s /usr/local/lib/nodejs/current/bin/npx  /usr/local/bin/npx  \
 && rm -f /tmp/node.tar.xz \
 && node -v

# --- 3/6 pnpm（**不用 corepack**：它在没有 packageManager 字段时会自己
#        去拉"最新已知版本"，实测在容器里把 12.4.1 换成了 12.14.0；
#        仿真要的是**可复现**的版本，所以直接用 npm 装死版本）-------------
RUN corepack disable || true \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && pnpm --version \
 && node -e "console.log('pnpm path:', require('node:child_process').execSync('which pnpm').toString().trim())"

# --- 服务账号（与服务器同名的 aiagent）-------------------------------------
RUN groupadd -g ${APP_GID} ${APP_USER} \
 && useradd -m -u ${APP_UID} -g ${APP_GID} -s /bin/bash ${APP_USER} \
 && mkdir -p /opt/project-lg /opt/pnpm \
 && chown ${APP_USER}:${APP_USER} /opt/project-lg /opt/pnpm

# ============================================================================
#  仓库与依赖
# ============================================================================
#  分两步 COPY：先只拷清单装依赖，再拷源码 ⇒ **改源码不会触发重装依赖**
#  （这是这套东西能被 agent 反复用而不至于每次等 5 分钟的关键）。
#
#  ⚠️ 所有权用 `COPY --chown` 而不是事后 `chown -R`：
#     `artifacts/` 有上万文件，事后递归 chown 实测要 **6 分钟**；
#     放在 COPY 里是元数据操作，秒级完成。
# ============================================================================
WORKDIR /opt/project-lg
USER ${APP_USER}

# ============================================================================
#  Python 运行时（自动记忆 / OCR / 文档 Office）
# ============================================================================
#  ⚠️ 这一层刻意放在**依赖层之前**（2026-10-22 改）：
#     它的缓存键**只**取决于"系统包层 + 这一个脚本" ⇒
#     **改 `package.json`（加一个脚本）不会再让它失效**。
#     之前它排在依赖层**之后** ⇒ 改一次 package.json 就要重跑一次 pip
#     （3 分钟 + **需要 PyPI**）⇒ 而本机容器内**连不上 PyPI** 时
#     构建会**挂住**（实测 35 分钟无输出，只能中断）。
#     ⇒ 换句话说：这一层放这儿，"改 package.json"才变成**廉价**的操作。
# ---------------------------------------------------------------------------

#  用仓库自带的 `scripts/deploy/bootstrap-linux-python.sh`：
#  · 它**拒绝**在 Windows 仿真层上跑（uname -s 检查）⇒ 在 Linux 容器里天然合法
#  · 它**从不复制** Windows venv，只在目标机按 pin 重建 ⇒ 这正是服务器的做法
#  · 它读不到开发机的 dist-info ⇒ 走**记录下来的 baseline** ⇒ 与服务器同一条路径
#
#  ⚠️ 这一层刻意放在 `COPY . .` **之前**：
#     它要 3 分钟（pip 装 langmem / rapidocr / markitdown），
#     放在源码 COPY 之后 ⇒ agent 每改一行源码就重跑一次这 3 分钟。
#     只 COPY 这一个脚本就够了（它只从源码树里读"开发机 venv 的 dist-info"，
#     读不到就走 baseline —— 与服务器上的路径一致）。
#
#  ⚠️ 失败不炸掉整个构建：写一个标记文件，让 preflight 如实报 FAIL。
#     （镜像可用性 > 构建原子性；但失败必须**留痕**且被门看见。）
# ============================================================================
COPY --chown=${APP_USER}:${APP_USER} scripts/deploy/bootstrap-linux-python.sh scripts/deploy/
RUN sh scripts/deploy/bootstrap-linux-python.sh --prefix /opt/project-lg/data/runtime \
      > /tmp/venv-build.log 2>&1 \
      || { echo "VENV_BUILD_FAILED" > /opt/project-lg/.serversim-venv-failed; \
           echo "---- venv 构建日志（尾部）----"; tail -40 /tmp/venv-build.log; }

COPY --chown=${APP_USER}:${APP_USER} package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ⚠️ 故意**不** COPY 仓库根的 `.npmrc`：它带着本机代理与 `strict-ssl=false`，
#    正是 10-15 §3.1 点名的"第一个会炸的地方"。这里写一份服务器口径的。
RUN printf 'registry=https://registry.npmjs.org/\n@elizaos:registry=https://registry.npmjs.org/\n' > /opt/project-lg/.npmrc \
 && pnpm install --no-frozen-lockfile \
 && pnpm store prune || true


# 原生恢复客户端独立缓存；不重建 Python/Node 依赖，不查询无关的 PPA。
USER root
RUN apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 \
      -o Dir::Etc::sourceparts=- update \
 && apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 \
      install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
USER ${APP_USER}

COPY --chown=${APP_USER}:${APP_USER} . .

# 依赖装完再补一次（COPY . . 覆盖了 package.json，锁文件没变则不会重装）
RUN pnpm install --no-frozen-lockfile --prefer-offline

# ============================================================================
#  仿真运行时脚本
# ============================================================================
COPY --chown=${APP_USER}:${APP_USER} serversim/entrypoint.sh serversim/supervisor.mjs serversim/onebot-mock.mjs \
     serversim/model-mock.mjs serversim/wechat-mock.mjs serversim/forwarder.mjs /opt/serversim/
RUN chmod +x /opt/serversim/entrypoint.sh \
 && sh -n /opt/serversim/entrypoint.sh \
 && for f in /opt/serversim/*.mjs; do node --check "$f"; done \
 && echo "仿真运行时脚本语法自检通过"

# --- 收尾读数（构建日志里必须能看见）--------------------------------------
RUN printf 'serversim image: node %s / pnpm %s / python3.12 %s\n' \
      "$(node -v)" "$(pnpm --version)" "$(python3.12 -V 2>&1 | cut -d' ' -f2)"

USER ${APP_USER}
WORKDIR /opt/project-lg

# 停机信号：SIGTERM（compose down）与 SIGINT（Ctrl+C）都必须走有序停机
STOPSIGNAL SIGTERM
CMD ["/opt/serversim/entrypoint.sh"]
