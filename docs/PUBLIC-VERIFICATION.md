# 公开源码副本验证记录

## QQ 多用户与群聊更新（2026-10-14）

本次延续公开 main `d993322e4d61ff08943461fe4f3059d7824a2b9d`，导出逐人身份、来源房间读写授权、授权前置过滤、两表 FORCE RLS、群成员动态准入、保守触发、共享后台归因与语音共存编排。保留公开许可、依赖补丁、合成数据初始化和 CI 保护；不携带原检出历史、实际群号/账号、凭证、库、备份或激活记录。配置见 [QQ-GROUPS.md](QQ-GROUPS.md)。

| 检查 | 本次公开副本结果 |
|---|---|
| 锁文件安装 | 根 `pnpm install --frozen-lockfile --offline` EXIT 0；语音子项目 `npm ci --offline --ignore-scripts` EXIT 0，未增加依赖或修改锁文件 |
| 类型检查 | 根 typecheck、语音 TypeScript 检查均 EXIT 0 |
| `pnpm ci:offline` | EXIT 0，403.0 秒；包含完整 `m4.5:ci`，以本副本新建、关闭的合成库为源 |
| 硬门状态 | G1/G2/G9/G10/G13 PASS；G14 仍为 `not-run`，不声称 Hard Gates 全通过 |
| U1 隔离 | `u1:completion:verify` 28/28 PASS，覆盖实际 RLS、跨房间读写、后台来源归因与印象门槛 |
| QQ 整链 | stdio 30/30、共存 TCP 32/32 PASS；使用合成账号、临时数据库和本机 OneBot/模型协议夹具 |
| 语音与旧 QQ 回归 | 语音/取消 10/10 PASS；旧 owner QQ 私聊 verify EXIT 0 |
| 脚本清单 | 642 条，按本公开副本 package 重新生成，排除未发布的 A1/S1 门 |
| 隐私检查 | 全部候选文件未命中已配置凭证、实际群号/账号、个人昵称/学校、本机用户名；不包含库、备份、环境文件或运行记录 |
| Gitleaks | 全树原始 EXIT 1 / 10 个既有命中；逐项与上一版匹配，没有新增，未确认真实凭证 |
| 真实模型 / QQ / 设备 | 本公开副本 NOT RUN；原开发环境的迁移、首用和人工审查不作本副本证据 |

以下 3D/语音与 PostgreSQL 记录保持各自历史归属，不用于冒充这次更新的新证据。此轮验证期间未启动开发者的生产核心、语音或 QQ 外壳，也未复制或连接开发者的数据库。

## 3D 皮套与原生 Omni 语音更新（2026-10-14）

本次以公开 `main` 的 `3d3d34273206b09b3cb23db24dc9676667c2e026` 为父版本，只导出本次已提交的 3D/语音集成源码并脱敏，保留公开副本的许可、依赖补丁与初始化保护。公开启动器使用本 checkout 自己的配置与运行目录，不依赖开发者的发布快照；生产卷使用单独的 `lg-omni-production-data` 名称。未包含在途的多用户/管理后台修改、模型、VRM、声音、截图、数据库或原开发历史。配置与使用边界见 [3D-VOICE.md](3D-VOICE.md)。

| 检查 | 本次结果 |
|---|---|
| 锁文件安装 | 根 `pnpm install --frozen-lockfile --offline --ignore-scripts` 与两个可选子项目 `npm ci --offline --ignore-scripts` 均 EXIT 0 |
| 类型与静态检查 | 根类型检查、语音 TypeScript 检查、3D JavaScript 语法检查均 EXIT 0 |
| 可选组件测试 | 语音 10/10；3D 19/19；关库顺序与原生端口/PG 隔离保护回归 EXIT 0 |
| 公开启动器保护 | 缺少本副本语音配置时在启动 core 前拒绝，未连接数据库或模型 |
| 全部离线回归 | `pnpm ci:offline`（含 `m4.5:ci`）EXIT 0，441.5 秒；G14 not-run，整体 Hard Gates 未全通过；合成测试库，没有使用原数据库或凭据 |
| 更新差异凭证扫描 | Gitleaks v8.30.1 暂存差异扫描 EXIT 0，零命中 |
| 全量公开树凭证扫描 | 原始 EXIT 1、10 项，均为上次已复核的相同行内容；新增命中 0，未禁用规则 |
| 私密值与发布文件范围 | 17 个配置凭证/账号值零命中；已确认个人标识零命中；2301 个候选文件，仅两张合成 1px PNG 为二进制；文本统一 LF |
| 公开说明的本地链接 | README 与本次三个组件说明的本地目标均存在 |
| 依赖公告刷新 | audit 原始 EXIT 1；critical=0、high=1、moderate=0、low=1，仍为 SECURITY.md 已登记的两项 |
| 真实 PostgreSQL/Omni 模型/生产/人类麦克风与 3D 动作 | 本公开副本 NOT RUN；原开发环境的激活与运行报告不作为本副本实测证据 |

原始日志、扫描结果及来源摘要保存在被忽略的本地制作目录。公开源码发布不代表接收者环境已完成生产激活；外部模型和形象资产由使用者按各自许可单独配置。

## PostgreSQL 源码更新（2026-10-13）

本次从公开 `main` 的 `7aaba6496d2ebb0f13183cfa5d2b718b5e7903c0` 制作增量脱敏导出，保留公开许可、初始化保护与依赖补丁，不导入开发历史或真实运行数据。README 同步新增 PostgreSQL 配置、迁移工具及尚未实施的多用户/群聊/管理后台计划。

| 检查 | 本次结果 |
|---|---|
| 锁文件安装 | `pnpm install --frozen-lockfile --offline --ignore-scripts` EXIT 0；873 个包来自本地内容存储 |
| 类型检查 | `pnpm typecheck` EXIT 0 |
| PostgreSQL 配置/隔离门 | `postgresql:g01:verify` EXIT 0；常断言 42/42、负控 2/2、未运行 0，共 44 项；不打开数据库 |
| 全部离线回归 | `pnpm ci:offline`（含 `m4.5:ci`）EXIT 0，395.7 秒；G12 38/0、L2 53/0、G13 32/0、G2 150/0、G9 PASS；G14 not-run，整体 Hard Gates 未全通过 |
| 更新差异凭证扫描 | Gitleaks v8.30.1，暂存差异扫描 EXIT 0、零命中 |
| 全量公开树凭证扫描 | 原始 EXIT 1、10 项；均与上次公开根提交中的同一行内容相同，为已复核测试哨兵、资源标签与摘要，新增命中 0；未禁用规则 |
| 当前敏感值与个人标识精确比对 | 14 个不同的配置凭证/账号值（含本地 PG 凭据）零命中；已确认的个人标识零命中；仅保留两张合成 1px PNG |
| README 本地链接 | 13 个全部存在 |
| 依赖公告刷新 | 原始 audit EXIT 1；critical=0、high=1、moderate=0、low=1，仍为 SECURITY.md 已登记的两项；默认代理不可用的失败另保留，使用独立直连请求得到本读数 |
| 真实 PostgreSQL/模型/QQ 生产链 | 本公开副本 NOT RUN；原开发环境报告不作本副本实测证据 |
| 唯一存档与零失败拒绝能力 | 计划已纳入，尚未实现/验收，不能以本次源码发布宣布安全门已通过 |

所有日志、扫描报告与原始来源摘要留在开发者被忽略的本地发行制作目录；不提交真实环境文件、运行 artifacts、数据库或生产切换记录。第一次文件检查发现的 package.json 换行格式问题已修正，原失败日志与复验记录保留。

## 首次公开发行记录（2026-10-12）

日期：2026-10-12。适用对象：本公开发行副本。历史里程碑报告中的读数不作为本记录的结果。

## 发布范围

- Apache-2.0，包含 LICENSE、NOTICE 和 THIRD_PARTY_NOTICES.md。
- 新建 Git 历史，采用通用贡献者身份；包含制作副本时选定的工作区源码。
- 排除旧 Git 历史、全部原始 artifacts、运行数据库、真实环境文件、外部模型、截图和声音样本。仅保留两张合成的 1px PNG 测试夹具。
- QQ 标识、个人昵称、学校全称及简称、本机用户名路径已替换。历史文档里的相关示例也已处理。
- 运行目录（包括 ElizaOS 默认目录）、依赖及测试产物均被忽略。实际发布范围以 Git 跟踪文件和基于 Git 导出的归档为准。

## 本次验证

| 检查 | 结果 |
|---|---|
| 锁文件安装 | `pnpm install --frozen-lockfile --offline` EXIT 0；此前已在该副本内完成正常安装 |
| 类型检查 | EXIT 0，包含新加入的公开初始化脚本 |
| 全部离线回归 | `pnpm ci:offline`（包含原 `m4.5:ci`）EXIT 0，330.1 秒；已执行检查通过。聚合结果 5 项 PASS、G14 not-run，因此整体 Hard Gates 未全通过 |
| 动作审计量具 | 针对性复验 EXIT 0；38/38 通过 |
| 记忆覆盖率 | `memory-coverage:verify` EXIT 0；47/47 一致，extracted=27 |
| 记忆写读整链 | `memory-coverage:e2e` EXIT 0；46/46 一致，写入 27 条；另 1 条非 remember 意图按范围排除 |
| 初始化保护 | 模板配置可创建新库；已有 data/、配置的外部 PostgreSQL 或外部 PGlite 路径会拒绝；已有配置时 `ci:offline` 拒绝 |
| 发布文件精确比对 | 当前本地 8 个不同凭证/账号值零命中；已确认的个人标识零命中 |
| 通用凭证扫描 | Gitleaks v8.30.1 原始 EXIT 1、10 条命中；逐项复核为测试值、标签或摘要，未确认真实凭证 |
| 依赖公告 | critical=0、high=1、moderate=0、low=1；原始 audit EXIT 1，见 SECURITY.md |
| 提示能力审计 | 静态源码审计保持启用；原运行 prompt 归档未公开，因此运行材料检查为 NOT RUN |
| 真实模型及生产链 | NOT RUN；没有复制原运行数据来执行检查 |

`ci:offline` 仅适用于新 checkout。它清除凭证及功能开关环境变量，只读 CLI 装配所需的 Key 字段使用无效占位值，并把模型端点设为回环地址；临时创建本地空 .env 阻止依赖向祖先目录查找配置，在本 checkout 内新建、关闭 schema-only 测试库，经原有受控迁移入口验证，再执行原 `m4.5:ci`。测试使用合成输入，不使用开发者的实际运行库。结束后删除自己创建的空配置；已有数据不会被这个命令清除。

Gitleaks 的 10 条命中包括：`scripts/gates/manifest.ts` 中 4 个 scratchKey 资源标签；`scripts/learning-skills/arxiv-assets.json` 中 1 个文件 SHA-256；`scripts/m9.6-jev-protocol.ts` 中 1 个环境变量名称；`scripts/verify-gate-runner.ts` 中 1 个合成复用指纹；`scripts/verify-m5.1-measurement.ts` 中 2 个泄漏检测测试哨兵；`scripts/verify-td10-search-reliability.ts` 中 1 个响应正文测试哨兵。没有禁用通用 API Key 规则，也没有把原始非零结果写成零命中。

语料内容因脱敏而改变，公开版 corpus manifest 已声明新的版本与 LF 内容指纹。没有改写原项目的验收记录来给公开版补绿。首次检查发现的替换错误、缺少新库来源、上级配置加载及旧指纹不符均已保留在本地制作记录；这些本地日志不进入发布仓库。

扫描与测试不能证明任何未知旧凭证都不存在，也不能替代可选集成的独立实测。原开发 checkout 的选定源文件摘要、HEAD 和未提交修改数量已复核保持不变。

公开命名：用户选择中文项目名“苏沐薇”、仓库名 `sumuwei`。命名后的修改仅涉及 README、包元数据及发行说明；上述离线回归对应同一份程序源码。
