# 苏沐薇（sumuwei）

> **版本划分（2026-10-18）**：`main` 现为**服务器适配版**；原先以个人电脑运行为主要目标的版本保留在 [`desktop`](https://github.com/Rick2857/sumuwei/tree/desktop)，固定起点为 `8baa6fad`（2026-10-15 公开版）。两条分支共用项目身份，不代表同一份部署配置。
>
> 服务器版入口：[部署与运行边界](docs/SERVER-EDITION.md)。需要原 Windows 本机启动方式，请切换 `desktop`；现有 PC 用户无需为了本次发布迁移数据。

一个以持续角色、记忆、关系和认知状态为核心的中文角色智能体实验项目。使用 TypeScript、Node.js、ElizaOS、Drizzle 和 PostgreSQL/PGlite；CLI 是最小入口，QQ、原生语音、3D VRM 及 Live2D 为可选集成。

项目公开名称为“苏沐薇”，GitHub 仓库名为 `sumuwei`；历史技术文档沿用原开发代号 Project LG。

本仓库是经过脱敏的公开源码发行副本，采用 **Apache-2.0**。它包含当前实现、脚本、合成测试夹具和技术文档。个人标识及教育背景示例已替换为虚构值；角色设定保留。

## 当前进展（2026-10-19 源码更新）

本次在 2026-10-18 服务器发行版上合入已提交开发源码的脱敏增量，增加同快照备份 v2、远程动作回执结算、依赖健康与源码指纹，及薄宿主收尾和回归检查。可选薄 Node 宿主缺省仍关闭，ElizaOS 依赖仍在；后续卸载计划保持[草案状态](docs/DEPENDENCY-REMOVAL-PLAN.md)。公开副本仍需配置接收者自己的 PostgreSQL、模型、账号与资源，发布不包含原环境数据或凭据。功能与使用边界见[三个能力说明](docs/PRIORITY-THREE.md)。

| 范围 | 状态与边界 |
|---|---|
| 角色内核 | 持久记忆、来源归因、可重放投影、关系、情绪、信念、目标/承诺及受控工具链已有实现；功能开关和历史里程碑结果分别记录 |
| 材料驱动提醒 | 可从文字、近期原图及已授权工具结果提出多项提醒；程序核对日期、扣除提前分钟、去重并复用现有持久化调度，支持查看、改期和取消；需自行配置提醒出口与模型 |
| PostgreSQL | 新增显式后端选择、连接目标核对、单认知核心资格、迁移对账及在线备份恢复工具；支持数据库独立运行、多个管理/只读连接，多个认知写核心仍属后续阶段 |
| QQ / 语音 / Live2D | 可选入口复用同一 LG 核心；新增白名单群聊、当前群成员私聊、逐人身份与房间隔离，QQ 多用户缺省关闭 |
| 3D / Omni 原生语音 | 新增 three-vrm 呈现、Qwen3.8-Omni-Flash-Realtime / Liora Mira、LG 上下文/工具接线与取消/更正；仅发布源码，公开副本未激活生产或验收真人设备 |
| 多用户 / 管理 UI | 身份、来源房间、受限召回与后台归因已有实现；服务器快照包含受限管理入口源码，其生产启用与完整拒绝语义验收不由本次公开发布认证 |
| Linux 工具与入口 | 同一核心可常驻服务器；Python 路径可配置，数学 worker 区分冷启动与求解期限，子进程超时/取消按平台清理；微信群入口依赖独立外部桥、账号与白名单 |

多人入口保持同一个苏沐薇、唯一全局情绪、逐人关系与 QQ 号唯一存档。私聊和不同群的资料按来源房间授权，过滤先于截断；原主人具名跨用户查询只在私聊或本机入口开放并带审计。普通群成员不继承主人的桌面、任务、提醒或工作流权限。拒绝行为的真模型/真人验收仍须单列，本公开副本没有“零失败拒绝”结论。设置、触发规则和证据边界见 [QQ 多用户与群聊](docs/QQ-GROUPS.md)。

## 服务器安装

使用 Linux、Node.js 22（采样服务器为 22.23.3）与 pnpm 12.4.1。完整流程、PostgreSQL 初始化/迁移、Python 独立运行环境和 systemd 模板见 [服务器版指南](docs/SERVER-EDITION.md)。桌面、鼠标和 VRM 在用户 PC；服务器不会自动取得用户桌面控制权。

## 兼容的本地最小使用

以下保留创建新 PGlite 库的历史运行兼容入口，不用于后续数据库测试验收；服务器长期运行与后续测试使用独立 PostgreSQL。原个人电脑版请使用 `desktop` 分支。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm db:init
pnpm migrate:apply
```

编辑 `.env`，填写自己的模型 API Key、兼容的 base URL 和模型名。模板中的模型标识只是配置示例；请以自己账户可用的端点为准。默认数据库位于本 checkout 的 `data/pglite`，用上面的初始化命令创建空的新库；已有 `data/` 时 `db:init` 会拒绝覆盖。不要导入别人的运行库。

```powershell
pnpm chat
```

QQ 配置模板见 `.env.qq.example`。联网、桌面、本机文件、后台任务、语音和 Live2D 等能力分别有权限、开关及外部依赖要求；仅复制源码不会复现原开发环境的完整启用状态。

通用提醒的用法、材料范围及限制见 [材料驱动提醒](docs/REMINDERS.md)。`.env.test.example` 的模型示例已更新为 `https://api.minimax.cn/v1` / `MiniMax-M3.1-Flash-Preview`，API Key 保持空白；真实测试须使用自己的账户与本机 `.env.test`。

## 可选 3D 与原生语音

3D 预览位于 `tools/avatar-3d`，离线语音协议演示位于 `experiments/omni-realtime`，各自使用独立 npm 锁文件。先分别运行 `npm ci --ignore-scripts --no-audit --no-fund`，再运行目录内的 `npm start`；3D 官方示例需要显式执行 `npm run sample` 下载。

真实语音需要自己的百炼凭据；LG 接线还需要自己的隔离 PostgreSQL 或已准备的生产实例。Omni 负责语音理解/表达，LG 保持人格、ContextCompiler、记忆、工具网关及回复检查权威。多用户启用后，原生语音与 QQ 通过受控入口复用一个共存核心；不会另开第二个认知核心。

源码不包含 Aoba、任何 VRM、ASR/TTS 权重、声音或生产快照。模型许可与代码许可分开；原生音频可能先播出、再因 LG 检查更正。真人回声、听感和长时性能没有本公开版的验收结论。详见 [3D/语音设置与边界](docs/3D-VOICE.md)。

## 长期部署：PostgreSQL

长期运行、在线管理和备份可使用独立 PostgreSQL + pgvector。代码保留 PGlite 缺省以兼容历史运行工具；后续数据库验收统一隔离 PostgreSQL，旧 PGlite 测试入口待迁移。切换需要显式配置，不会因为环境中碰巧有连接串就静默换库。

在自己的数据库完成扩展、schema 和账号准备后，在本地 `.env` 中设置：

```dotenv
CHARACTER_DB_BACKEND=postgres
POSTGRES_URL=postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:55432/YOUR_DATABASE
LG_PG_EXPECT_DATABASE=YOUR_DATABASE
```

连接串必须填自己的值并保留在本地。`db:init` 仅保留创建本 checkout 全新 PGlite 库的兼容功能，会拒绝外部数据库配置；它不会初始化、导入或覆盖 PostgreSQL，也不用于当前测试验收。已有 PGlite 数据需要按[迁移计划](docs/post-lv2/PostgreSQL-Migration-Execution-Plan-2026-10-12.md)和[Runbook](docs/post-lv2/PostgreSQL-Migration-Runbook.md)单独演练、备份及切换，不能只改连接串就宣称数据已迁移。

`scripts/postgresql/compose.yml` 是固定镜像、loopback 绑定的试验配置，不是通用生产部署器；使用前确认容器、卷、端口和凭据文件属于自己的隔离环境。试验角色与授权脚本在同目录。启动期 DDL 仍限制运行/迁移账号分离，当前单核心资格也不等于多写核心并发已验收。见[维护手册](docs/post-lv2/PostgreSQL-Migration-Maintenance-Manual.md)和[已知局限](docs/post-lv2/PostgreSQL-Migration-Known-Limitations.md)。

原开发环境的[迁移验收报告](docs/post-lv2/PostgreSQL-Migration-Acceptance-Report.md)保留工程、数据与首用的分列结果；其生产配置、历史计数和未公开 artifacts 不属于本公开副本的实测证据。公开副本的最新检查单独记录在 [PUBLIC-VERIFICATION](docs/PUBLIC-VERIFICATION.md)。

## 架构

角色状态与稳定人格分离。主回复经 TurnGateway 组织上下文；工具动作经注册表、权限和网关执行，结果写入账本/trace，并约束回复中的动作声明。持久化采用事件与可重放投影，实验数据库必须隔离。

- [架构不变量](docs/architecture/invariants.md)
- [架构文档](docs/architecture/)
- [公开副本的范围与验证边界](docs/PUBLIC-DISTRIBUTION.md)
- [本次公开副本验证记录](docs/PUBLIC-VERIFICATION.md)
- [第三方组件与素材范围](THIRD_PARTY_NOTICES.md)

## 检查

```powershell
pnpm typecheck
pnpm ci:source
pnpm postgresql:g01:verify
```

`ci:source` 只用于没有真实配置与数据的新 checkout：类型、脚本清单、薄宿主接线/接口/退役/UUID、工具依赖与源码清单、进程清理检查，不打开数据库。托管 workflow 使用该有限检查链。旧 `ci:offline` 因仍依赖 PGlite，现以非零退出明确拒绝；迁移至隔离 PostgreSQL 前，完整数据库回归为 NOT RUN。

历史 `m4.5:ci` 的聚合器退出码为零也不代表所有 live 门通过；后续重跑其数据库部分前须先迁移测试后端。缺少真实链证据时 G14 为 `not-run`，不能复制历史 PASS 文件补绿。当前发行的专项检查与历史全量读数分别记录在 [PUBLIC-VERIFICATION.md](docs/PUBLIC-VERIFICATION.md)。

`postgresql:g01:verify` 验证配置/目标隔离的程序判据，不打开数据库；真正需要 PostgreSQL、迁移源副本或模型的检查另有前置条件。不要在装有生产配置的 checkout 中直接批量运行迁移/切换脚本，也不能把无凭据的 NOT RUN 当成真实 PG 验证通过。

真实模型、QQ、GPU、桌面、语音及 Live2D 检查属于独立验证，需要自己的配置和外部资源。它们不在无凭证 CI 中执行。

## 数据与许可

仓库不包含原数据库、对话记录、凭证、模型权重、Live2D 模型、展示截图或声音样本。两张既有 PNG 是合成测试夹具，本次保持其公开版本原始字节。

历史技术文档中的里程碑结论与生产激活记录属于原开发环境；其中的旧提交、hash、未随仓库公开的证据路径不能用作本副本的验证结论。当前发行副本的读数会单独记录。

源码与文档采用 [Apache License 2.0](LICENSE)，依赖及外部素材保留各自许可。欢迎报告可复现的问题；请先删除日志中的 Key、账号、私人路径和聊天内容。
