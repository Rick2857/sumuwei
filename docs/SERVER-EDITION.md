# 服务器适配版与个人电脑版

2026-10-18 起，`main` 的主要部署目标为 Linux 服务器。`desktop` 保留此前个人电脑版的公开历史，起点为 `8baa6fad38f078ce02f509d8185c04955802e29c`。没有重写旧提交或要求个人电脑用户迁移；需要原启动方式时使用 `git switch desktop`。

| 范围 | main：服务器适配版 | desktop：个人电脑版本线 |
|---|---|---|
| 常驻核心 | Linux 服务账号、systemd、统一正式 QQ 入口 | Windows / 本机 CLI 与启动器 |
| 存储 | 独立 PostgreSQL + pgvector；认知核心仍保持唯一 | 保留旧版 PostgreSQL/PGlite 用法 |
| 文档、数学、OCR | 服务器独立 Python 环境与可终止 worker | 本机相应运行环境 |
| 桌面、3D、语音 | 主要放在用户 PC；跨端链路需独立配置和验收 | 原本机集成方式 |
| 账号与资料 | 部署者自行配置；发布没有真实账号、群、消息或数据库 | 原公开配置模板，仍需自行填写 |

2026-10-18 版本从运行服务器只读提取源码；2026-10-19 在此基础上合入已提交开发源码的脱敏增量，不把私有 Git 历史接到公开仓库。发行副本保留许可证、安全依赖覆盖与初始化保护；当前 CI 仅执行明确的无数据库专项检查。运行数据、私有运行报告、真实配置、模型/头像、微信桥镜像均不发布。

## 新服务器准备

需要 Node.js 22.13+（采样服务器为 22.23.3）、pnpm 12.4.1，及 PostgreSQL 17 + pgvector。Python 工具应使用符合 `bootstrap-linux-python.sh` 要求的独立解释器，不能复制 Windows venv。不要将源码目录中的 `data/`、PGDATA 或 Docker 数据卷复制给另一个 PostgreSQL 进程。

```sh
git clone https://github.com/Rick2857/sumuwei.git
cd sumuwei
git switch main
pnpm install --frozen-lockfile
cp .env.server.example .env
cp .env.qq.example .env.qq
```

在 `.env` 填写自己的模型与 `POSTGRES_URL`，将 `LG_PG_EXPECT_DATABASE` / `LG_PG_EXPECT_USER` 对准该实例。配置文件应由服务账号持有、权限 600。不要使用开发者的数据库、备份或凭据。

数据库初始化与迁移属于显式维护步骤：

```sh
pnpm migrate
# 检查目标、备份与待执行项后：
pnpm migrate:apply
```

当前运行时拒绝启动期插件 DDL，所需六张兼容基础表必须事先准备；表名检查不能证明列结构正确，也不等于运行账号与迁移账号的权限分离已完整验收。保持单认知核心，数据库的多个客户端不等于可以同时启动多个角色核心。

薄 Node 宿主已成为唯一运行时，ElizaOS 运行时依赖已移除；认知与权限仍由 Kernel / TurnGateway / ActionGateway 持有。`CHARACTER_THIN_HOST` 不设即启用，模板明确为 `true`；旧 `false` / `off` / `0` 配置会拒绝启动，应删除该键或改为 `true`。工厂保留 PostgreSQL 与历史 PGlite 兼容分支，但后续测试只使用隔离 PostgreSQL。旧 `composeState` 链路不支持，需要已准备的插件表与 ContextCompiler，不能与 `CHARACTER_CONTEXT_COMPILER_V1=0` 同用。本公开副本的接线与接口检查不替代真实 PostgreSQL 等价性、生产切换或真人体验验收。QQ 后端安装与登录见 [LLBot / PMHQ 指南](QQ-DEPLOYMENT.md)。

工具环境先检查计划：

```sh
sh scripts/deploy/bootstrap-linux-python.sh --dry-run
```

按自身目录与解释器创建环境后，配置 `PROJECT_LG_DOC_PYTHON`、`PROJECT_LG_OFFICE_PYTHON`、`PROJECT_LG_RAPIDOCR_PYTHON` 等所需变量。文档环境包括 `markitdown[pdf,docx,pptx,xlsx]==0.1.8` 及办公格式依赖；脚本已有环境完整性检查。模型资产需要按各组件清单单独取得，不随本仓库分发。安装时保留 tsx 等启动所需依赖，不能直接采用删掉所有开发依赖的安装方式。

## 启动与服务

先以自己的 QQ/OneBot 账号和受限本机地址配置 `.env.qq`，再前台运行 `pnpm qq:chat`。正式入口复用现有内核；不要另外启动第二份认知核心。

`scripts/deploy/lg-qq.service.example` 是通用模板，使用 `/opt/project-lg`、服务账号 `lg` 和 `/usr/bin/node`。安装前按真实目录、Node 路径和权限调整，再由管理员安装服务。模板不会替你创建数据库、桥接服务或自动打开工具开关。停止时保留有序收尾，配置与日志不要公开。

微信为可选入口：复制 `.env.wechat.example` 并配置自己的独立桥、令牌、平台身份与群白名单。适配器要求 loopback HTTP 地址和有效账号，不包含桥镜像、登录态或任何群授权。启用前自行核验上游桥的来源与运行条件。公开离线检查不发送消息。

详细能力、配置字段、共享核心和群内文字范围见 [微信群指南](WECHAT.md)。QQ 普通回复的可选 TTS 输出另见 [QQ 语音回复](QQ-VOICE.md)，不会自动扩展到微信、提醒或主动投递。

## 验证与边界

```sh
pnpm typecheck
pnpm ci:source
pnpm deploy:verify
```

`ci:source` 仅用于**没有配置与数据的新检出**，会拒绝现成运行目录；仅运行明列的无数据库检查。旧 `ci:offline` 因 PGlite 测试设施待迁移而明确拒绝，完整数据库回归和 G14 当前均为 NOT RUN。当前发行实际读数见 [PUBLIC-VERIFICATION.md](PUBLIC-VERIFICATION.md)。

当前源码已合入 v2 同快照备份、远程回执结算和健康/源码清单；旧“未包含这些改造”的说明属于 2026-10-18 早期快照。使用方式见[三个能力说明](PRIORITY-THREE.md)。本次发布不执行部署或恢复；远程鼠标、双机 SSH、真实渠道和生产操作仍须独立验证。

附带的旧里程碑文档只作为历史技术背景，不是本次公开版、当前服务器或第三方环境的统一通过证明。
