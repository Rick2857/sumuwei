# 苏沐薇（sumuwei）

一个以持续角色、记忆、关系和认知状态为核心的中文角色智能体实验项目。使用 TypeScript、Node.js、ElizaOS、Drizzle 和 PostgreSQL/PGlite；CLI 是最小入口，QQ、语音及 Live2D 为可选集成。

项目公开名称为“苏沐薇”，GitHub 仓库名为 `sumuwei`；历史技术文档沿用原开发代号 Project LG。

本仓库是经过脱敏的公开源码发行副本，采用 **Apache-2.0**。它包含当前实现、脚本、合成测试夹具和技术文档。个人标识及教育背景示例已替换为虚构值；角色设定保留。

## 当前进展（2026-10-13）

| 范围 | 状态与边界 |
|---|---|
| 角色内核 | 持久记忆、来源归因、可重放投影、关系、情绪、信念、目标/承诺及受控工具链已有实现；功能开关和历史里程碑结果分别记录 |
| PostgreSQL | 新增显式后端选择、连接目标核对、单认知核心资格、迁移对账及在线备份恢复工具；支持数据库独立运行、多个管理/只读连接，多个认知写核心仍属后续阶段 |
| QQ / 语音 / Live2D | 现有可选入口复用 LG 核心；QQ 当前为配置 owner 的好友私聊，尚未开放多用户群聊 |
| 多用户、QQ群聊、管理 UI | 执行计划已编写，尚未实现；不会因切换 PostgreSQL 自动获得这些能力 |

多人计划保持同一个苏沐薇、唯一全局情绪、逐人关系与 QQ 号唯一存档；按身份区分原主人跨用户访问、普通记录查询与关系门槛下的人物印象。临时演戏按关系范围允许，不能改变永久人格或安全权限。拒绝改档/越权操纵、隐私泄露、提示词注入、危险动作和搜索滥用的测试默认零失败，是未来多用户/群入口的发布条件，尚无本公开版的通过结论。见[执行补充计划](docs/post-lv2/Multi-User-QQ-Group-and-Admin-Execution-Addendum-2026-10-12.md)。

## 安装与最小使用

支持的基线环境：Windows、Node.js 22.23.2、pnpm 12.4.1（版本已记录在 `package.json`）。

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

## 长期部署：PostgreSQL

长期运行、在线管理和备份可使用独立 PostgreSQL + pgvector。代码保留 PGlite 缺省以兼容本地初始化与离线测试；切换需要显式配置，不会因为环境中碰巧有连接串就静默换库。

在自己的数据库完成扩展、schema 和账号准备后，在本地 `.env` 中设置：

```dotenv
CHARACTER_DB_BACKEND=postgres
POSTGRES_URL=postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:55432/YOUR_DATABASE
LG_PG_EXPECT_DATABASE=YOUR_DATABASE
```

连接串必须填自己的值并保留在本地。`db:init` 仅创建本 checkout 的全新 PGlite 测试库，会拒绝外部数据库配置；它不会初始化、导入或覆盖 PostgreSQL。已有 PGlite 数据需要按[迁移计划](docs/post-lv2/PostgreSQL-Migration-Execution-Plan-2026-10-12.md)和[Runbook](docs/post-lv2/PostgreSQL-Migration-Runbook.md)单独演练、备份及切换，不能只改连接串就宣称数据已迁移。

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
pnpm ci:offline
pnpm postgresql:g01:verify
```

`ci:offline` 只用于没有 `.env*` 真实配置和 `data/` 的新 checkout：先创建并关闭空的合成测试库，再经受控迁移入口验证和关闭，再运行原有 `m4.5:ci`。已有运行数据时它会拒绝启动，请另用测试 checkout。

`m4.5:ci` 运行离线回归并读取门结果。最后的汇总器退出码为零不代表所有 live 门通过；缺少真实链证据时 G14 应显示 `not-run`。不要提交伪造的 PASS 文件来消除这个状态。提示能力审计会检查当前源码；未公开的原运行 prompt 归档检查应显示 `NOT RUN`。

`postgresql:g01:verify` 验证配置/目标隔离的程序判据，不打开数据库；真正需要 PostgreSQL、迁移源副本或模型的检查另有前置条件。不要在装有生产配置的 checkout 中直接批量运行迁移/切换脚本，也不能把无凭据的 NOT RUN 当成真实 PG 验证通过。

真实模型、QQ、GPU、桌面、语音及 Live2D 检查属于独立验证，需要自己的配置和外部资源。它们不在无凭证 CI 中执行。

## 数据与许可

仓库不包含原数据库、对话记录、凭证、模型权重、Live2D 模型、展示截图或声音样本。两个 1 像素 PNG 是合成测试夹具。

历史技术文档中的里程碑结论与生产激活记录属于原开发环境；其中的旧提交、hash、未随仓库公开的证据路径不能用作本副本的验证结论。当前发行副本的读数会单独记录。

源码与文档采用 [Apache License 2.0](LICENSE)，依赖及外部素材保留各自许可。欢迎报告可复现的问题；请先删除日志中的 Key、账号、私人路径和聊天内容。
