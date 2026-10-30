# 苏沐薇（sumuwei）

> **2026-10-30 · 群任务与多成员对话更新**：新增[主人授权群任务](docs/QQ-GROUP-TASKS.md)说明，同步统一语义入口、转告与模型自主表达等此前已部署的源码增量；修正群聊称呼、消息指向、引用与排队上下文。群任务和转告在公开发行中缺省关闭；[累计更新](docs/UPDATES-2026-10-30.md)与[验证范围](docs/PUBLIC-VERIFICATION.md)分别说明机制读数和未验证项。

> **2026-10-27 · QQ 回复语音与微信说明**：普通 QQ 私聊和获准群聊可由她逐轮选择文字或语音，发行缺省关闭，见 [QQ 语音回复](docs/QQ-VOICE.md)。已有微信群适配器补充了独立的[功能与配置指南](docs/WECHAT.md)；微信群目前只收发文字，不继承 QQ 语音开关。

> **2026-10-26 · 可选课表与累计更新**：[西电本科课表](docs/OPTIONAL-XIDIAN.md)默认关闭，可自行配置服务器自动同步与原主人私聊查询。此次一并合入提醒、记忆/认知、文档恢复及隔离测试更新；[变更与实验边界](docs/UPDATES-2026-10-26.md)、[公开验证范围](docs/PUBLIC-VERIFICATION.md)。

> **2026-10-24 · QQ 默认部署更新**：采用 **LLBot / PMHQ**，通过 OneBot v11 接入同一个 LG 核心。
> 授权、扫码、登录态与旧部署切换见 [QQ 部署指南](docs/QQ-DEPLOYMENT.md)。

> **2026-10-20 · Lv2.5 可选化**：世界线源码与内容保留，通过独立入口按需加载。
> 普通聊天默认不加载故事运行器、内容包或选择模型；启用和停止方式见
> [Lv2.5 可选功能](docs/OPTIONAL-LV25.md)。本次只发布源码，不包含部署记录或运行数据。

> **版本划分（2026-10-18）**：`main` 现为**服务器适配版**；原先以个人电脑运行为主要目标的版本保留在 [`desktop`](https://github.com/Rick2857/sumuwei/tree/desktop)，固定起点为 `8baa6fad`（2026-10-15 公开版）。两条分支共用项目身份，不代表同一份部署配置。
>
> 服务器版入口：[部署与运行边界](docs/SERVER-EDITION.md)。需要原 Windows 本机启动方式，请切换 `desktop`；现有 PC 用户无需为了本次发布迁移数据。

一个以持续角色、记忆、关系和认知状态为核心的中文角色智能体实验项目。使用 TypeScript、Node.js 薄宿主、Drizzle 和 PostgreSQL/PGlite；CLI 是最小入口，QQ、微信群、原生语音、3D VRM 及 Live2D 为可选集成。当前 `main` 已移除 ElizaOS 运行时依赖，历史技术文档保留原有归属。

项目公开名称为“苏沐薇”，GitHub 仓库名为 `sumuwei`；历史技术文档沿用原开发代号 Project LG。

本仓库是经过脱敏的公开源码发行副本，主体采用 **Apache-2.0**；可选课表的少量上游衍生文件保留 MPL-2.0/MIT 文件级许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。它包含当前实现、脚本、合成测试夹具和技术文档。个人标识及教育背景示例已替换为虚构值；角色设定保留。

## 当前进展（2026-10-30）

当前 `main` 使用薄 Node 宿主作为唯一运行时；`CHARACTER_THIN_HOST` 不设即启用，旧的 `off` / `false` 值会拒绝启动。依赖卸载与待完成边界见[依赖说明](docs/DEPENDENCY-REMOVAL-PLAN.md)。Lv2.5 保留为默认关闭的可选功能；有界行动预测与反思结果上下文已有实现，发行缺省关闭。QQ 默认部署改为 LLBot / PMHQ，选择依据维护者的长期实际使用确认。公开副本仍需配置自己的 PostgreSQL、模型、账号与资源，发布不包含原环境数据或凭据。工具与部署边界见[三个能力说明](docs/PRIORITY-THREE.md)。

| 范围 | 状态与边界 |
|---|---|
| 角色内核 | 持久记忆、来源归因、可重放投影、关系、情绪、信念、目标/承诺及受控工具链已有实现；功能开关和历史里程碑结果分别记录 |
| 运行时 | 薄宿主是唯一实现；`CHARACTER_THIN_HOST` 未设置或设为 `on` / `1` / `true` 时启用，`off` / `0` / `false` 或其它值拒绝启动；ContextCompiler 必须启用 |
| Lv2.5 世界线 | 源码、内容和显式命令保留；普通聊天默认不加载，通过独立可选入口启用，停用不删除历史账本 |
| 西电本科课表 | 可选，默认关闭；独立同步与会话复用，原主人私聊查询，只读快照；详见 [启用说明](docs/OPTIONAL-XIDIAN.md) |
| 认知与文档恢复 | 来源限定信念生命周期、文档页级恢复与受限模拟/否决已加入源码；实验默认关闭，机制通过不等于真实模型收益，见 [本次更新](docs/UPDATES-2026-10-26.md) |
| 材料驱动提醒 | 可从文字、近期原图及已授权工具结果提出多项提醒；程序核对日期、扣除提前分钟、去重并复用现有持久化调度，支持查看、改期和取消；需自行配置提醒出口与模型 |
| 联网查证 | 当前主入口使用 DeepSeek 原生搜索及受控 HTTPS 来源读取，最多读取两页；服务器模板默认关闭，启用需官方 DeepSeek 端点及自己的可用凭据；不再以 Tavily Key 作为当前主入口前置 |
| PostgreSQL | 新增显式后端选择、连接目标核对、单认知核心资格、迁移对账及在线备份恢复工具；支持数据库独立运行、多个管理/只读连接，多个认知写核心仍属后续阶段 |
| QQ / 语音 / Live2D | 可选入口复用同一 LG 核心；QQ 默认 LLBot / PMHQ，支持白名单群聊、当前群成员私聊、逐人身份与房间隔离，QQ 多用户缺省关闭 |
| QQ 多成员对话 | 保留账号身份并逐轮刷新显示名；区分当前消息、背景和排队补充，显式传递提及与引用；短时连续普通群消息可有界合并，见 [群聊说明](docs/QQ-GROUPS.md) |
| 主人授权群任务 | 默认关闭；主人私聊确认目标群、触发范围、期限及额度后运行，支持单次发送与限时接话；群成员不能代授权限，见 [群任务指南](docs/QQ-GROUP-TASKS.md) |
| 转告与统一语义入口 | 默认关闭的转告任务首版只向主人 QQ 私聊投递；提醒、记忆、目标及工具意图使用统一模型语义入口，程序保留权限与执行事实核对，见 [累计更新](docs/UPDATES-2026-10-30.md) |
| QQ 普通回复语音 | 默认关闭；每轮由模型选择文字或语音，外壳合成最终正文并发送，复用既有私聊/群聊权限；不扩展提醒、主动消息或其它平台，见 [配置与边界](docs/QQ-VOICE.md) |
| 微信群聊天 | 已有可选文字入口，通过独立本机 HTTP 桥接入同一核心；群白名单、账号/原消息核验、模型判断是否接话、逐人身份与来源隔离；不支持微信私聊或微信语音，见 [微信指南](docs/WECHAT.md) |
| 行动预测 / 反思结果上下文 | 默认关闭；预测不增加工具权限，比较材料不冒充独立证据；机制检查、模型读数与行为收益分别记录，见 [WORLD-MODEL](docs/WORLD-MODEL.md) |
| 3D / Omni 原生语音 | 新增 three-vrm 呈现、Qwen3.8-Omni-Flash-Realtime / Liora Mira、LG 上下文/工具接线与取消/更正；仅发布源码，公开副本未激活生产或验收真人设备 |
| 多用户 / 管理 UI | 身份、来源房间、受限召回与后台归因已有实现；服务器快照包含受限管理入口源码，其生产启用与完整拒绝语义验收不由本次公开发布认证 |
| Linux 工具与入口 | 同一核心可常驻服务器；Python 路径可配置，数学 worker 区分冷启动与求解期限，子进程超时/取消按平台清理；微信群入口依赖独立外部桥、账号与白名单 |
| PC 远程动作 | 等待 PC 执行回执后区分完成、拒绝、失败与结果不明；超时或断线不自动重发；需自行配置执行端、SSH 与令牌，真实双机及鼠标整链未在公开副本验收 |
| 备份与部署检查 | 已包含 PostgreSQL 同快照备份 v2、隔离恢复校验、只读依赖健康和源码指纹清单；没有自动周期备份、离机副本或 PITR，公开副本的真实数据库备份/恢复门仍为 NOT RUN |

多人入口保持同一个苏沐薇、唯一全局情绪、逐人关系与 QQ 号唯一存档。私聊和不同群的资料按来源房间授权，过滤先于截断；原主人具名跨用户查询只在私聊或本机入口开放并带审计。普通群成员不继承主人的桌面、任务、提醒或工作流权限。拒绝行为的真模型/真人验收仍须单列，本公开副本没有“零失败拒绝”结论。设置、触发规则和证据边界见 [QQ 多用户与群聊](docs/QQ-GROUPS.md)。

## 服务器安装

使用 Linux、Node.js 22.13+（本次 Linux 检查为 22.23.3）、pnpm 12.4.1 与独立 PostgreSQL 17 + pgvector；QQ 部署另需 Docker Compose。先在没有运行配置和数据的新 checkout 安装并执行有限源码检查：

Lv2.5 加载图探针还要求 Node 提供 `node:module.registerHooks`；没有该 API 时，`ci:source` 将此项记为 NOT RUN。当前 workflow 固定 Windows 22.23.2、Linux 22.23.3，运行时版本下限不代表所有检查均可执行。

```sh
git clone --branch main https://github.com/Rick2857/sumuwei.git
cd sumuwei
pnpm install --frozen-lockfile
pnpm ci:source
cp .env.server.example .env
```

填写自己的模型、数据库连接、`LG_PG_EXPECT_DATABASE` / `LG_PG_EXPECT_USER`。配置文件仅由服务账号读取；旧配置若含 `CHARACTER_THIN_HOST=false`，需删除该键或改为 `true`。准备数据库扩展与账号后，先用 `pnpm migrate` 检查目标和待执行项，确认自己的备份与维护窗口后再执行 `pnpm migrate:apply`。完成依赖和渠道配置后，CLI 用 `pnpm chat`，QQ 常驻入口用 `pnpm qq:chat`；只启动一个认知核心。

完整流程、Python 独立运行环境和 systemd 模板见 [服务器版指南](docs/SERVER-EDITION.md)。桌面、鼠标和 VRM 在用户 PC；服务器不会自动取得用户桌面控制权。当前 `main` 的新部署使用本节的 PostgreSQL 配置。

需要 QQ 时，先将下方账号占位符替换为自己的两个不同 QQ 号：

```sh
pnpm qq:prepare --owner=YOUR_OWNER_QQ --bot=YOUR_BOT_QQ
# 在生成的 .env.qq 填入 LLBot 的 PMHQ_AUTH_TOKEN 后：
docker compose --env-file .env.qq -f scripts/qq/compose.yml up -d
pnpm qq:status
```

WebUI 默认 `http://127.0.0.1:13080/`，密码在 `data/qq-llbot/data/webui_token.txt`；服务器使用 SSH 转发访问。扫码并在手机确认后，身份检查还需配合在线状态和真实收发验证。两个后端服务自动重启并尝试自动登录；QQ 会话过期或风控后仍可能需要重新扫码。已有在线 LLBot 应沿用原配置/登录卷，禁止另起同账号实例。完整授权与旧部署切换见 [QQ 部署指南](docs/QQ-DEPLOYMENT.md)；不使用 QQ 时无需生成 `.env.qq`。

## QQ 语音与微信群

QQ 普通回复可以单独启用语音输出。文字或语音由模型结合当前对话决定，程序不按关键词或频率强制选择；需要自己的 TTS 端点、密钥、音色和支持 record 的 QQ 后端。配置、文字兜底及结果不明时的处理见 [QQ 语音回复](docs/QQ-VOICE.md)。这与 3D/Omni 原生语音入口分别配置。

微信群入口的适配器和模板已在源码中，当前由 `pnpm qq:chat` 的外壳承载，复用唯一 LG 核心。配置自己的 `.env.wechat`、已登录的兼容桥和群白名单后才会启用；她会判断是否接话，不是每条群消息必回。当前只支持群内文字，完整步骤与上游 API 要求见 [微信群功能与配置](docs/WECHAT.md)。

## 本地运行与旧版兼容

在本机使用 `main`，同样先准备自己的 PostgreSQL、模型与显式迁移，再启动 CLI。模板中的模型标识只是配置示例；请以自己账户可用的端点为准。

```powershell
pnpm chat
```

PGlite 仍是未配置后端时的历史缺省，但不作为当前新安装或数据库验收路径。按当前源码，`db:init` 的旧空库初始化会走到薄宿主拒绝的插件建表分支，因此不再提供“复制 `.env.example` 后直接建 PGlite 新库”的安装步骤。需要原个人电脑版流程时使用 `desktop` 分支及该分支说明；不要把别人的运行库导入自己的实例。

QQ 配置模板见 `.env.qq.example`。联网、桌面、本机文件、后台任务、语音和 Live2D 等能力分别有权限、开关及外部依赖要求；仅复制源码不会复现原开发环境的完整启用状态。

通用提醒的用法、材料范围及限制见 [材料驱动提醒](docs/REMINDERS.md)。`.env.test.example` 的模型示例已更新为 `https://api.minimax.cn/v1` / `MiniMax-M3.1-Flash-Preview`，API Key 保持空白；真实测试须使用自己的账户与本机 `.env.test`。

## 可选行动预测、反思比较与世界线

行动预测和反思结果比较可分别启用，代码缺省均为 false：

```dotenv
CHARACTER_ACTION_FORECAST_ENABLED=true
CHARACTER_ACTION_FORECAST_TIMEOUT_MS=20000
CHARACTER_REFLECTION_OUTCOME_COMPARISON_ENABLED=true
```

行动预测还需要已有任务编排入口与模型配置，消耗原规划预算；执行继续经过 TaskPlan 校验和 ActionGateway，核对不符时阻止依赖步骤并重新规划。反思比较需要原反思、自适应开关和上下文预算，不增加证据根或降低采纳门槛。另有默认关闭的规则资格、模拟规划与 F1/F2 实验源码，范围见 [本次更新](docs/UPDATES-2026-10-26.md)；这些机制不构成稳定行为收益证明，原有反思模型对照采集曾因超时 FAIL。配置、成本及证据范围见[世界模型方法应用](docs/WORLD-MODEL.md)。

Lv2.5 世界线是独立的可选功能，三个聊天集成开关默认关闭；显式故事命令可能写入账本。启用和停止见 [Lv2.5 可选功能](docs/OPTIONAL-LV25.md)。上述功能停用后保留既有事件与投影，不通过删除数据库回滚。

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
LG_PG_EXPECT_USER=YOUR_USER
CHARACTER_THIN_HOST=true
CHARACTER_CONTEXT_COMPILER_V1=1
```

连接串与身份期望必须填自己的值并保留在本地。`db:init` 不用于 PostgreSQL 初始化，也不用于当前测试验收；已有 PGlite 数据需要按[迁移计划](docs/post-lv2/PostgreSQL-Migration-Execution-Plan-2026-10-12.md)和[Runbook](docs/post-lv2/PostgreSQL-Migration-Runbook.md)单独演练、备份及切换，不能只改连接串就宣称数据已迁移。

`scripts/postgresql/compose.yml` 是固定镜像、loopback 绑定的试验配置，不是通用生产部署器；使用前确认容器、卷、端口和凭据文件属于自己的隔离环境。试验角色与授权脚本在同目录。

当前 PostgreSQL 普通启动检查迁移状态与六张兼容基础表，不执行 schema DDL；缺表或存在待应用迁移时拒绝启动。显式 `pnpm migrate:apply` 使用 LG 自有迁移，包括 `0023` 的兼容表定义，不再依赖 ElizaOS 插件建表。启动表名检查不等于完整列结构核验，也不证明运行/迁移账号分离已完整验收。薄宿主要求启用 ContextCompiler，不能与 `CHARACTER_CONTEXT_COMPILER_V1=0` 同用；关闭薄宿主不会恢复旧宿主。当前单核心资格不等于多写核心并发已验收。当前宿主行为见[服务器指南](docs/SERVER-EDITION.md)；历史迁移维护与边界见[维护手册](docs/post-lv2/PostgreSQL-Migration-Maintenance-Manual.md)和[已知局限](docs/post-lv2/PostgreSQL-Migration-Known-Limitations.md)。

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
pnpm lv25:optional:verify
pnpm worldmodel:forecast:verify
pnpm worldmodel:reflection:verify
pnpm worldmodel:gates --verify
```

`ci:source` 只用于没有运行配置与数据的新 checkout（已有 `.env`、`.env.test`、渠道配置或 `data/` 时拒绝）：运行类型、脚本清单、行动预测/反思比较/聚合证据自证、可用时的 Lv2.5 加载图、薄宿主接线/接口/退役/UUID、部署工具与入口协议检查，不打开数据库或调用真实模型。上列源码专项部分已包含在其中，可按需单跑。QQ 配置迁移另用 `pnpm exec tsx scripts/qq/prepare-verify.ts`，协议重连用 `pnpm qq:reconnect:verify`，两者使用合成夹具。托管 workflow 使用有限源码链；已有本地 Linux 读数不代表托管运行已成功。旧 `ci:offline` 因仍依赖 PGlite，现以非零退出明确拒绝；旧完整数据库回归待迁移，当前为 NOT RUN。

数据库专项已有独立进展：公开验证记录中的 `worldmodel:reflection:e2e` 为 **11/11 PASS**，使用独立 PostgreSQL 容器、卷、随机端口和离线 provider，准备阶段显式迁移。它只证明该反思机制链，不代表完整回归、真实模型或生产验收通过；重跑需自行准备 Docker 和测试床指定镜像，缺少条件失败关闭。具体前置条件见 [WORLD-MODEL](docs/WORLD-MODEL.md)。

历史 `m4.5:ci` 的聚合器退出码为零也不代表所有 live 门通过；后续重跑其数据库部分前须先迁移测试后端。缺少真实链证据时 G14 为 `not-run`，不能复制历史 PASS 文件补绿。当前发行的专项检查与历史全量读数分别记录在 [PUBLIC-VERIFICATION.md](docs/PUBLIC-VERIFICATION.md)。

`postgresql:g01:verify` 验证配置/目标隔离的程序判据，不打开数据库；真正需要 PostgreSQL、迁移源副本或模型的检查另有前置条件。不要在装有生产配置的 checkout 中直接批量运行迁移/切换脚本，也不能把无凭据的 NOT RUN 当成真实 PG 验证通过。

真实模型、QQ、GPU、桌面、语音及 Live2D 检查属于独立验证，需要自己的配置和外部资源。它们不在无凭证 CI 中执行。

## 数据与许可

仓库不包含原数据库、对话记录、凭证、模型权重、Live2D 模型、展示截图或声音样本。两张既有 PNG 是合成测试夹具。

历史技术文档中的里程碑结论与生产激活记录属于原开发环境；其中的旧提交、hash、未随仓库公开的证据路径不能用作本副本的验证结论。当前发行副本的读数会单独记录。

源码与文档采用 [Apache License 2.0](LICENSE)，依赖及外部素材保留各自许可。欢迎报告可复现的问题；请先删除日志中的 Key、账号、私人路径和聊天内容。
