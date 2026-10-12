# 苏沐薇（sumuwei）

一个以持续角色、记忆、关系和认知状态为核心的中文角色智能体实验项目。使用 TypeScript、Node.js、ElizaOS 和 PGlite；CLI 是最小入口，QQ、语音及 Live2D 为可选集成。

项目公开名称为“苏沐薇”，GitHub 仓库名为 `sumuwei`；历史技术文档沿用原开发代号 Project LG。

本仓库是经过脱敏的公开源码发行副本，采用 **Apache-2.0**。它包含当前实现、脚本、合成测试夹具和技术文档。个人标识及教育背景示例已替换为虚构值；角色设定保留。

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
```

`ci:offline` 只用于没有 `.env*` 真实配置和 `data/` 的新 checkout：先创建并关闭空的合成测试库，再经受控迁移入口验证和关闭，再运行原有 `m4.5:ci`。已有运行数据时它会拒绝启动，请另用测试 checkout。

`m4.5:ci` 运行离线回归并读取门结果。最后的汇总器退出码为零不代表所有 live 门通过；缺少真实链证据时 G14 应显示 `not-run`。不要提交伪造的 PASS 文件来消除这个状态。提示能力审计会检查当前源码；未公开的原运行 prompt 归档检查应显示 `NOT RUN`。

真实模型、QQ、GPU、桌面、语音及 Live2D 检查属于独立验证，需要自己的配置和外部资源。它们不在无凭证 CI 中执行。

## 数据与许可

仓库不包含原数据库、对话记录、凭证、模型权重、Live2D 模型、展示截图或声音样本。两个 1 像素 PNG 是合成测试夹具。

历史技术文档中的里程碑结论与生产激活记录属于原开发环境；其中的旧提交、hash、未随仓库公开的证据路径不能用作本副本的验证结论。当前发行副本的读数会单独记录。

源码与文档采用 [Apache License 2.0](LICENSE)，依赖及外部素材保留各自许可。欢迎报告可复现的问题；请先删除日志中的 Key、账号、私人路径和聊天内容。
