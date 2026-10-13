# PostgreSQL 迁移 · Runbook（WP6）

> **这份文件的作用**：把切换当天要做的每一步写成**可复制粘贴的实际命令 + 绝对目标 + 操作者检查项**，
> 让执行的人**不需要猜**任何东西。
>
> ⚠️ 计划 §L155 逐字："WP6 必须把下列步骤转成**经演练的实际命令、绝对目标和操作者检查项**；
> 本计划**不提供**当前不存在的可执行迁移命令，也**不填写虚构 URL、快照 ID 或镜像 digest。"
> ⇒ 本文里**每一个** ID / digest / 路径都是**实测读出来的**，来源写在每条的"读数出处"。
>
> ⚠️ **本文不是授权**。WP7（真实切换）需要用户当轮**逐字授权**；本文只说明"拿到授权后怎么做"。

---

## 0. 一页速览

```text
目标后端     独立 PostgreSQL 17.11 + pgvector 0.8.7（容器 lg-postgresql-trial）
容器镜像     pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d
宿主端口     127.0.0.1:55432
**生产库     `sumuwei`**（与公开仓库项目名一致）· owner/连接账号 = **`lg_migrate`**（ⓑ 裁定）
来源（迁移） data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd
真实库       C:\Users\user\Desktop\project LG\data\pglite
凭据（gitignore）artifacts/post-lv2/local/pg-migration/pg-trial.env
切换载体     pnpm postgresql:cutover:apply [--apply] [--switch-config]（+ token）
当前状态     **WP0–WP6 达成 · WP7 已执行**（Activation-Record 在案）· WP8 未开始
```

⚠️ **生产库的创建**必须用 `scripts/postgresql/create-production-db.sql`（它**不许**库名带 `lg_test_`）；
`create-test-db.sql` 会**按设计拒绝**生产库名（ADR-132 `D03`）。

**停机窗口估计的构成（实测，不是承诺）**：计划 §L138 要求"以实测导出、导入、比较和启动时间构成"。
本线的实测值见 §5；**总窗口 = 导出 + 导入 + 读回比较 + 启动**，四段都有读数。

---

## 1. 前置检查（**在动任何东西之前**）

操作者逐条打勾；任一条不满足 ⇒ **停**，不要往下走。

```powershell
# 1.1 没有 LG 核心在跑（否则真实库有持有者，绝不能打开）
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*hermes*' -or $_.Path -like '*Codex*' } | Select-Object Id,Path
#   ⇒ 这里**只应看到** DSH/Codex 自己的运行时；看到 `src/main.ts` / `tsx` 起的核心 ⇒ 停

# 1.2 生产 QQ 外壳不在跑（重启 Docker 会按 unless-stopped 拉起它）
docker ps --format '{{.Names}} {{.Status}}'
#   ⇒ 不应出现 lg-qq-private-napcat-1

# 1.3 PG 目标健康
docker ps --filter name=lg-postgresql-trial --format '{{.Names}} {{.Status}}'
#   ⇒ Up ... (healthy)

# 1.4 真实库"上一次是干净关闭的"（诊断事实，不作因果断言）
Get-Content 'data/owner-records/production-db-owner-*.json' | Select-Object -Last 1
#   ⇒ cleanClose 应为 true（ⓓ 受控重建之后是 true）
```

---

## 2. 切换前：最终快照（**只读源**）

```powershell
pnpm db:snapshot
#   ⇒ 它**只读**源、只在 %TEMP% 打开副本；输出里会给出新的 snapshot id
#   ⚠️ 按保留策略它可能**删除旧快照** ⇒ "删旧快照"需要**单独授权**；
#      若要保留全部历史，先确认 PRODUCTION_SNAPSHOT_KEEP（当前 = 10）与目录现状。
```

**操作者检查项**：记下这次的 snapshot id（形如 `2026-10-13T12-02-14-409Z-90cae4d22dcd`）；
它就是 WP7 的**最终来源**。**不要**用早期副本的读数替代最终检查（`PG-P01` 逐字要求）。

---

## 3. 切换：把最终快照导入 PG 目标

```powershell
# 3.1 建一个**新的**目标库（测试库命名纪律：lg_test_*）
#     用仓库里已验证的脚本（容器内可见：/opt/lg/ == scripts/postgresql/）
docker exec -e PGPASSWORD=<bootstrap-pw> lg-postgresql-trial `
  psql -h 127.0.0.1 -U lg_bootstrap -d lg_trial -v ON_ERROR_STOP=1 `
  -v LG_TEST_DB_NAME=lg_test_cutover -v LG_PG_MIGRATE_USER=lg_migrate `
  -f /opt/lg/create-test-db.sql

# 3.2 导出最终快照为 SQL（**源目录逐字未动**），并灌进目标库
#     ⚠️ 容器里**看不见**宿主机 artifacts/ ⇒ 只能走 psql 的 **stdin**
pnpm tsx scripts/postgresql/…（见 §7 的工具清单）   # 导出 + stdin 灌库那两步的封装
```

**排除集（实测过的、逐条有理由）**：

```text
PGlite → PG  ：--no-owner --no-privileges --no-comments
PG   → PG   ：--no-comments
为什么 --no-comments：`COMMENT ON EXTENSION` 要求扩展所有权，而 vector 非 trusted
  ⇒ 目标库里注释由 bootstrap 写、迁移账号改不动。**代价实测为 0**（那 2 条注释由扩展安装脚本
  自带，目标侧逐字相同 —— `PG-G07` 的 `G07.2f` 断言）。
```

**操作者检查项**：恢复命令 **exit 0 且日志里没有 `ERROR`**（这是 `G05`/`G07`/`G08` 共用的前置判据）。

---

## 4. 读回验证（**导入后、启动前**）

```powershell
pnpm postgresql:g05:verify   # 全库逐表规范化内容摘要（54 张表 / 4261 行）⇒ 期望 29/29
pnpm postgresql:g06:verify   # 投影重建 A==B + 向量/编码器读数 ⇒ 期望 30/30
pnpm postgresql:g04:verify   # SQL/仓储兼容（约束/事务/乐观冲突/四仓储）⇒ 期望 20/20
pnpm postgresql:g07:verify   # 在线备份 + 恢复 + 六种具名拒收 ⇒ 期望 47/47
pnpm postgresql:g08:verify   # 功能整链（记忆/通知/重启续跑/断连/消费者/双入口）⇒ 期望 28/28
pnpm postgresql:g09:verify   # 量具有效性（正控/负控/恢复）⇒ 期望 23/23
pnpm postgresql:g10:verify   # 切换就绪（只读审查）⇒ 期望全绿
```

⚠️ 这七道门**都要连真 PG** ⇒ 它们是**切换候选**的判据，不是"随便跑跑"。

---

## 5. 停机窗口估计（**实测构成**，计划 §L138）

| 段 | 实测读数 | 出处 |
|---|---|---|
| 导出（PGlite → SQL） | **2163 ms**（11 330 234 B） | `PG-G07` 证据 `sourceExport` |
| 导入（SQL → PG，stdin） | 见 G05/G07 的恢复耗时（同一量级，秒级） | `PG-G05`/`PG-G07` 证据 |
| 读回比较（全库 54 表） | `PG-G05` 整门 **27 s**（含建库+恢复+比较+负控+重恢复） | lane 日志 |
| 启动（核心起来并连上） | `PG-G08` 整门 **14.5 s**（含两次起核心） | lane 日志 |
| **备份（在线，写入进行中）** | **231–258 ms** · 11.1 MB · exit 0 | `S8` 证据 `backup` |

⇒ **估计口径**：真实切换的停机 ≈ 导出 + 导入 + 读回 + 启动；
上面每一项都有读数，**不承诺固定几分钟**（计划逐字禁止先承诺）。

---

## 6. 回滚路线（**两条，都要在切换前确认可用**）

计划 §L186 逐字："WP6 必须写明 **R1 实际可用的是 PG 修复/恢复还是已验证反向迁移**，及可接受的
数据恢复窗口。PG 内从旧备份恢复也可能损失备份后的写入；**不能把恢复成功等同于零数据损失**。
PITR/WAL 与异地备份按第二阶段另验，当前 pg_dump 方案如实记录实际备份周期和 RPO。"

### R1 —— 回到旧后端（PGlite）

```powershell
# 前提：真实库目录**未被这次切换改写**（本次切换只写 PG，真实库只被读）
# 若真实库被打开过：用它的 post-close verified 快照恢复
pnpm db:restore --from <snapshot-id> --data-dir "C:\Users\user\Desktop\project LG\data\pglite"   # 干跑
pnpm db:restore --from <snapshot-id> --data-dir "C:\Users\user\Desktop\project LG\data\pglite" --apply  # 破坏性
```

**可用性（如实）**：R1 是**已验证快照恢复**，**不是**反向迁移。
⇒ 切换后**在 PG 里产生的新写入不会回到 PGlite**（恢复点 = 快照时刻）⇒ **数据恢复窗口 = 快照之后的新写入**。
⚠️ **不主张"恢复成功 = 零数据损失"**。

### R2 —— 留在 PG，修 PG

```powershell
pnpm postgresql:g07:verify     # 确认在线备份可用（切换前就应有一份）
docker exec -e PGPASSWORD=<pw> lg-postgresql-trial pg_dump -h 127.0.0.1 -U lg_migrate -d <db> --no-comments > <file>
# 需要时把备份灌进一个新库，再把配置指过去
```

**可用性（如实）**：R2 = **PG 内修复/恢复**。当前方案的备份周期 = **按需 `pg_dump`（不是定时）**
⇒ **RPO = 最近一次备份之后的写入**。**PITR / WAL 归档 / 异地备份 = 未验**（第二阶段另验）。

---

## 7. 工具与命令清单（本文引用的每一个都在仓库里）

| 命令 | 作用 | 门 |
|---|---|---|
| `pnpm db:snapshot` | 只读源、在 %TEMP% 打开副本产 verified snapshot | INC-01 |
| `pnpm db:restore --from <id> [--apply]` | 从快照恢复（`--apply` 需逐字授权） | INC-01 |
| `pnpm postgresql:goal-rebuild:apply [--apply]` | 受控重建 `goal:%` 投影（干跑默认） | — |
| `pnpm postgresql:g04/g05/g06/g07/g08/g09/g10:verify` | 七道真 PG 门 | 见 §4 |
| `pnpm postgresql:bench:verify` | 资源读数（S8） | S8 |
| `pnpm with-test-model pnpm postgresql:live:smoke` | 有限真模型 smoke | LIVE |
| `pnpm gates:run --lane postgresql` | 一次跑完九道（≈245 s） | 聚合 |
| `pnpm m4.5:ci` | 完整离线 CI（≈12.4 min；**跑前必须没有 LG 核心在跑**） | 回归 |

**绝对目标**（不要用相对路径猜）：

```text
真实库      C:\Users\user\Desktop\project LG\data\pglite
快照根      C:\Users\user\Desktop\project LG\data\snapshots\desktop-actions-activation-20261009
凭据        C:\Users\user\Desktop\project LG\artifacts\post-lv2\local\pg-migration\pg-trial.env
证据根      C:\Users\user\Desktop\project LG\artifacts\post-lv2\postgresql-migration\
```

---

## 8. 失败处置（每一步的"坏了怎么办"）

```text
恢复日志里有 ERROR            ⇒ **停**，不启动核心；用 §6 的 R1/R2 处置，并把日志原文入档
门读数为 FAIL                 ⇒ **停**，先归因（是本门量具错还是被测物错）；本线的先例：
                                  F-WP5-16 两条竞态判据、F-WP5-17/18/19 三条量具错 —— 都先修量具
核心起不来（身份核对拒绝）      ⇒ **这是保护**（`LG_PG_EXPECT_DATABASE` 不匹配就会拒）；不要放宽期望值
真实库被意外打开               ⇒ 按 `PG-ISO-01` 的处置：**不清现场**、先做内容评估
                                 （`pnpm tsx scripts/postgresql/production-touch-assessment.ts`）
发现"存的与算的不一致"          ⇒ 先查仓库里是否已有同类教训（F-WP5-10 的教训就是"机制说明书 ≠ 已修复"）
```

---

## 9. 切换后（WP8 的入口，不属本文）

```text
· 在线只读查询 / 在线备份（核心不停）
· 核心重启**不停止 DB**
· 真实功能首用观察（未观察到的**保留为 NOT OBSERVED**，不许凭配置宣布"运行验证通过"）
· 备份恢复计划与补丁升级操作
```

---

## 10. 不主张（本文的边界）

```text
· 不主张"切换已完成" —— 本文是 Runbook，WP7 需要**当轮逐字授权**
· 不主张"回滚零数据损失" —— R1 是快照恢复，恢复点之后的写入会丢
· 不主张"有 PITR / 异地备份" —— **未验**，当前只有按需 pg_dump（RPO = 上次备份之后的写入）
· 不主张"停机窗口是 N 分钟" —— 只有 §5 的**实测构成**，不承诺固定值
· 不主张"性能更好" —— 迁移的动机是**运维能力**，不是时延（`S8` 逐字"不设性能收益目标"）
```
