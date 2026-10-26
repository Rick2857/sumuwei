# Linux / PostgreSQL 隔离仿真支撑

此目录提供 Ubuntu、Node、Python、独立 PostgreSQL 测试实例与假模型/OneBot/微信端点。`server-spec.json` 是公开通用模板，不能当作任何真实服务器的实测画像。未附带原环境文件、数据副本、资源模型或运行报告。

完整仿真栈的启动助手需要你自行准备自己的应用配置与可用资源；请先审阅 `scripts/serversim/prepare-env.ts`、`serversim/compose.yml` 和资源挂载。不要把真实账号用于假端点测试。`seed.ts` 是显式导入操作，会把你指定的备份恢复到仿真库；发布不附带备份，也不需要从维护者服务器取得数据。

基础源码检查应在干净检出执行：`pnpm install --frozen-lockfile`、`pnpm ci:source`。数据库门另用 `scripts/gates/run-pg-gate.ts` 或 `scripts/serversim/pgtest.ts` 所要求的空白 `lg_test_*` 库及独立测试角色；逐场景测试须每场景新建进程和库。不要将生产连接串交给测试入口。

Compose 中 `pgtest` 使用独立容器与卷，不发布端口；假服务只验证协议及编排，不能代替真实模型行为、学校登录、QQ 收发或 systemd 验收。旧 PGlite 数据库回归入口继续明确拒绝，不能自动回退掩盖 PostgreSQL 缺项。

本次公开检出的具体执行范围见 [PUBLIC-VERIFICATION](../docs/PUBLIC-VERIFICATION.md)。本目录无正在运行的预配置环境或生产准入承诺。
