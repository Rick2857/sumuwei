# PostgreSQL 迁移 · 维护手册（WP8）

> 面向"日常怎么维护它"。每条命令都是**实测过的**；没演练过的**明确标注**。
> ⚠️ 配套：`Runbook`（切换当天怎么切/怎么退）· `Known-Limitations`（不保证什么）。

---

## 1. 现在的架构（一句话）

```text
她（LG 核心）现在连的是一台**独立的 PostgreSQL**（容器 `lg-postgresql-trial`，库 `sumuwei`），
不再是以前那个"程序自带、放在 data\pglite 文件夹里"的嵌入式库。
`data\pglite` **保留**着 —— 它是**回滚锚点**（见 §5）。
```

## 2. 每天要确认的三件事

```powershell
# 2.1 容器在跑且健康（不在跑 ⇒ 核心会报"连不上数据库"，那不是数据坏了）
docker ps --filter name=lg-postgresql-trial --format '{{.Names}} {{.Status}}'   # 期望 healthy

# 2.2 没有两个核心在抢库（同一时刻只允许一个持有者）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'main\.ts' } | Measure-Object   # 期望 Count = 0 或 1

# 2.3 库里有东西（快速体检）
docker exec -e PGPASSWORD=<migrate-pw> lg-postgresql-trial psql -h 127.0.0.1 -U lg_migrate -d sumuwei `
  -tAc "select (select count(*) from conversation_events)||' 会话事件 / '||(select count(*) from character_domain_events)||' 领域事件'"
```

## 3. 在线查询与在线备份（**核心不用停**）

```powershell
# 3.1 在线只读（用只读账号，最安全）
docker exec -e PGPASSWORD=<readonly-pw> lg-postgresql-trial psql -h 127.0.0.1 -U lg_readonly -d sumuwei -tAc "select count(*) from conversation_events"

# 3.2 在线备份（核心附着时也做过：实测 11 123 042 B / 231 ms / exit 0）
docker exec -e PGPASSWORD=<migrate-pw> lg-postgresql-trial pg_dump -h 127.0.0.1 -U lg_migrate -d sumuwei --no-comments --enable-row-security > 备份.sql
```

⚠️ `--no-comments` **不是可选项**：`COMMENT ON EXTENSION` 要求扩展所有权，而 `vector` 非 trusted
（目标库里的注释由 bootstrap 写、迁移账号改不动）。代价实测为 **0**（注释由扩展安装脚本自带）。

v22 / U1 补充：两张业务表已开启 FORCE RLS，完整管理备份需追加 `--enable-row-security`，使用不携带聊天外部读取作用域的可信管理连接；再以备份清单和同快照逐表计数核对完整性。容器、库名和账号须替换成操作者自己的目标；本公开副本未做真实 PostgreSQL 备份或恢复验收。见 [QQ-GROUPS](../QQ-GROUPS.md)。

**核心重启不停数据库**（实测过）：关核心 → 再起核心，`pg_postmaster_start_time()` **逐字不变**
⇒ 数据库一次都没重启。重启核心**不需要**停容器。

## 4. 备份与恢复计划（**如实：RPO 是"上次备份之后"**）

```text
当前方案   **按需 `pg_dump`**（不是定时任务）
RPO        上一次备份之后的写入会丢 —— 没有任何机制自动补回来
没有的东西 PITR / WAL 归档 / 异地备份（计划把这三样划到第二阶段，**未验**）
```

```powershell
# 4.1 恢复到"另一个库"（不覆盖生产库；推荐做法）
#     先建一个空库，再灌进去，最后把配置指过去（POSTGRES_URL 换库名）
# 4.2 从备份里核对（灌完之后逐表比对，与迁移线用同一套判据）
pnpm postgresql:g05:verify      # 它会从 verified 快照恢复并逐表比 —— 换源快照见 §6
```

⚠️ **恢复成功 ≠ 零数据损失**：这是快照/备份恢复的定义，不是缺陷。

## 5. 回滚（R1：回到 PGlite）

```powershell
# 删掉 .env 里 WP7 追加的那 3 行 + 注释即可（PGLITE_* 两行一直在，所以"回去"不需要恢复动作）：
#   CHARACTER_DB_BACKEND=postgres
#   POSTGRES_URL=postgresql://...
#   LG_PG_EXPECT_DATABASE=sumuwei
# 本次切换**没有改写** data\pglite ⇒ 那边一直是她切换前的状态。
# 切换前备份：artifacts/post-lv2/local/pg-migration/env-before-cutover-20261013T133124
```

## 6. ⚠️ 跑"旧后端（PGlite）归属"的门之前**必须**临时回滚 `.env`

```text
实测（2026-10-13）：`.env` 说 postgres 的时候，`pnpm m4:restore:verify` **失败关闭**：
  「拒绝：后端是 postgres，但本次实验没有给出**测试目标**。」
而只把 `CHARACTER_DB_BACKEND=pglite` 传进去**也不够**（第二条失败关闭）：
  「检测到 PostgreSQL 连接串，但 CHARACTER_DB_BACKEND 没有显式选 postgres。
    这是刻意的失败关闭：仅"环境里有 URL"不足以换后端。」
  ⇒ 因为 `.env` 里的 `POSTGRES_URL` 仍然在（PowerShell 里 `$env:POSTGRES_URL=''` 是**删除**变量，
      dotenv 又会把它读回来）。
⇒ 结论：**要在切换后跑旧后端归属的门（含完整 `m4.5:ci`），必须先临时回滚 `.env`（§5），跑完再切回来。**
   `pnpm m4.5:ci` 的那次 **EXIT 0 是切换之前**的读数（见 Acceptance-Report §1 的标注）。
```

## 7. 补丁升级操作（**未演练**，如实标注）

```text
· PG 小版本升级（换镜像 digest）→ **没有演练过**
· 扩展升级（vector 等）→ **没有演练过**
· 计划：在隔离实例上演练"换镜像 → 数据读回逐表比对"，再把步骤写进本节
⇒ 在此之前**不要**在生产容器上直接换镜像。
```

## 8. 迁移线自己的门（改了什么就跑什么）

```powershell
pnpm gates:run --lane postgresql     # 10 道（≈245 s）· 需要 PG 容器在跑
pnpm postgresql:g10:verify           # 切换就绪（只读审查，读已落盘证据，0.2 s）
pnpm postgresql:p02:verify           # 生产使用（真核心连生产库 · 在线只读/备份 · 重启不停 DB）
pnpm with-test-model pnpm postgresql:live:smoke   # 有限真模型（需要 .env.test）
```

## 9. 出问题时的第一反应

```text
容器不在跑 / 不 healthy   ⇒ 先开 Docker Desktop；**不要**动数据
报"身份不符（期望 sumuwei，实际 template1）" ⇒ **适配器回退成 PGlite 了**（说明某处没把
   POSTGRES_URL 播种进 `runtime.settings`）⇒ **立刻查**：它可能在拒绝之前已经开过真实库
   ⇒ 用 `pnpm tsx scripts/postgresql/production-touch-assessment.ts` 做**内容**评估
报"待应用的 schema 迁移" ⇒ 那是保护；看 `pnpm migrate`（只读预览）再决定
任何情况下           ⇒ **不要删库重建**（理由见用户说明书「数据库坏了怎么办」一节）
```
