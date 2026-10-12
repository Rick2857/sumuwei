# 公开源码副本验证记录

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
