# 备份、远程回执与部署依赖（2026-10-19）

本次公开源码增加三个关联能力。这里描述程序行为；发布源码不代表接收者的 PostgreSQL、PC 执行端或真实渠道已经验收。原环境的运行记录、数据和凭据不随发行。

## PostgreSQL 同快照备份与隔离恢复

`scripts/deploy/postgresql-backup.ts` 同时持有只读 repeatable-read 导出快照，供 pg_dump、逐字段数据摘要与 schema 摘要使用。使用 system scope 和行安全转储，避免 FORCE RLS 下只备份部分数据。清单在快照正常关闭后发布；已有输出不覆盖。

```sh
# 只有操作者明确选定源实例后才执行逻辑备份。
sh scripts/deploy/pg-backup.sh --out ./out/new-backup --container SOURCE --db DB --user ROLE
# 必须是另一容器，且不与源实例共享挂载。
sh scripts/deploy/pg-restore-verify.sh --manifest ./out/new-backup/manifest.json --target-container ISOLATED_TARGET --admin ADMIN
```

验证先检查 dump 长度与 SHA、目标实例和实际挂载，再在随机命名空库中恢复、核对表集合、字段与 schema 摘要。默认删除该临时库；只有显式 `--keep` 且验证通过才保留。自测 `pnpm deploy:pg:selftest` 需要操作者自己的 Docker 与指定 PostgreSQL 镜像，且只允许隔离测试资源；本公开副本未执行该数据库门。

v1 gzip/行数清单不兼容 v2 接口。逻辑备份不包含原角色所有权/ACL，也没有自动周期备份、离机副本或 PITR/WAL 归档；manifest 不是数字签名。备份包含用户数据，应保存在私有存储。

## PC 执行回执

Gateway 等待对应 ACTION_RESULT 后结算：completed 才能写成功；rejected、failed_confirmed 与 unknown 分别拒绝、失败、结果不明。超时、断线和在途取消不会自动重发，也不会回落到服务器本地桌面。旧 action_delegated 仍仅表示派发，新成功效果为 action_completed_remote。

输入正文只在既有授权暂存通过后进入线路参数，不写入原 ActionRequest 或账本。跨机加密仍依赖 SSH 和独立令牌。取消不能证明 PC 鼠标动作已经停止；desktop.inspect 仍是本地读取。默认配置不自动授予桌面权限。本次不包含 SSH 双机、真实鼠标、真实 QQ/微信收发或真人首次使用的验收。

## 只读依赖健康与源码清单

`scripts/deploy/runtime-health.ts` 检查工作流指纹、资料库/沙箱权限、Python 元数据、文档/办公 runner、数学依赖、OCR 和 arXiv 资产；不加载模型或用户文档。可创建的写目录只探测最近存在的父目录，健康检查本身不创建目录。

`asset-manifest.mjs` v2 同时绑定源码路径/内容、工作流说明、换行属性、锁文件、schema 和已装依赖。清单不记录 .env 的内容或内容哈希。源码变更后必须重新生成；有 Git 时会拒绝额外或遗漏源码。无 Git 的部署目录还需独立确保目录干净。

本地依赖就绪不代表业务授权、外部连通或动作成功。实际检查范围见 [公开验证记录](PUBLIC-VERIFICATION.md)。

## 后续数据库测试

后续数据库验收使用隔离 PostgreSQL；旧 PGlite 门标为待迁移。历史读数只保留原归属。`pnpm ci:source` 执行明确列出的无数据库检查；`pnpm ci:offline` 暂以非零退出拒绝旧数据库链。迁移这些测试是后续工作，不能通过修改报告宣布已经完成。
