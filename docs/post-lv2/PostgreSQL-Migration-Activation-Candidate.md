# PostgreSQL 迁移 · 切换候选（Activation-Candidate，WP6）

> **状态**：`CANDIDATE / NOT ACTIVATED`。生产**未切换**；WP7 需要用户当轮**逐字授权**。
> ⚠️ 计划 §L155：**不填写虚构** URL / 快照 ID / 镜像 digest —— 本文每一个值都是**实测读出来的**。

---

## 1. 冻结物（代码 / 镜像 / 工具）

| 项 | 冻结值 | 读数出处 |
|---|---|---|
| 检出 | `faa08659e2c6833b5a551edc69890ad4c0265cc6` | 各门证据的 `head` |
| 目标镜像 | `pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d` | `WP2` 的 `image-resolution.json` |
| 服务端版本 | PostgreSQL **17.11**（Debian 17.11-1.pgdg12+2） | `PG-G07` 的 `srcIdentity.serverVersion` |
| 扩展 | `vector 0.8.7` · `fuzzystrmatch 1.2` · `plpgsql 1.0` | `PG-G07` 的 `srcInventory.extensions` |
| 导出工具 | `@electric-sql/pglite-tools` **0.2.21**（peer pglite **0.3.16**） | `PG-G07` 的 `sourceExport.pinnedTools` |
| pg_dump | 17.11（容器内） | `PG-G07` 的 `pgDumpVersionInContainer` |

---

## 2. 目标身份（唯一权威）

```text
容器      lg-postgresql-trial（healthy）· 卷 lg-postgresql-data
宿主端口  127.0.0.1:55432
**生产库  `sumuwei`**（用户 2026-10-13 裁定：与公开仓库 `Rick2857/sumuwei` 项目名一致）
          owner = `lg_migrate` · 核心连接账号 = **`lg_migrate`**（ⓑ 裁定，见 Activation-Record §5）
库        lg_trial（bootstrap 用）· 迁移/运行/只读/测试四个角色分离
角色      lg_bootstrap · lg_migrate · lg_runtime · lg_readonly · lg_test
凭据      C:\Users\user\Desktop\project LG\artifacts\post-lv2\local\pg-migration\pg-trial.env（gitignore）
测试库命名纪律  **必须** `lg_test_*`（内核的隔离判据按前缀核；不带前缀会被拒）
生产库命名纪律  **不许** `lg_test_*`（`create-production-db.sql` 反向守卫）
```

⚠️ **内核启动时的身份核对是硬闸**：对 PG 目标起核心必须给 `LG_PG_EXPECT_DATABASE`（或
`_PREFIX`），否则失败关闭（"没有给出期望的数据库身份 ⇒ 身份核对没有东西可核"）。

---

## 3. 来源与快照

```text
迁移来源  data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd
          （ⓓ 受控重建之后的 post-close verified 快照）
回滚点    同一根下的 pre-open 快照 2026-10-13T12-09-…（见 goal-rebuild 证据 preOpenSnapshotId）
真实库    C:\Users\user\Desktop\project LG\data\pglite（1269 文件 · 指纹 137b7233…）
```

---

## 4. 命令（实际可跑，见 Runbook §7）

```bash
pnpm gates:run --lane postgresql      # 九道真 PG 门（≈245 s）
pnpm postgresql:g10:verify            # 切换就绪（只读审查）
pnpm db:snapshot                      # 最终快照（只读源）
pnpm db:restore --from <id> [--apply] # 回滚（--apply 需逐字授权）
pnpm m4.5:ci                          # 完整离线 CI（≈12.4 min，跑前必须无 LG 核心）
```

---

## 5. 停机窗口估计（**实测构成**，不承诺固定值）

```text
导出（PGlite→SQL）  **2163 ms**（11 330 234 B）—— PG-G07 的 sourceExport
导入（SQL→PG）      秒级（同量级；G05/G07 的恢复段）
读回比较（54 表）    PG-G05 整门 27 s（含建库+恢复+比较+负控+重恢复）
启动（核心连上）     PG-G08 整门 14.5 s（含两次起核心）
在线备份（写入中）   **231–258 ms** · 11.1 MB · exit 0 —— S8
```

⇒ 切换停机 ≈ 导出 + 导入 + 读回 + 启动；**四段都有读数**，不先承诺"几分钟"。

---

## 6. 前后验证（切换前 / 切换后各跑什么）

```text
切换前  §4 的九道门全绿 + `pnpm m4.5:ci` EXIT 0 + 本文件与 Runbook 的检查项逐条打勾
切换后  ① 读回验证：`pnpm postgresql:g05:verify`（54 表逐表摘要一致）
        ② 功能首用：真实对话一轮，看事件/投影真的落到 PG（未观察到 ⇒ 如实记 NOT OBSERVED）
        ③ 在线只读与备份：核心不停的情况下做一次 `pg_dump`
        ④ 核心重启**不停止 DB**
```

---

## 7. 回滚路线（**两条**）

```text
R1  回到旧后端（PGlite）：`pnpm db:restore --from <snapshot-id> --data-dir <真实库> [--apply]`
    实际可用的是**已验证快照恢复**，**不是**反向迁移 ⇒ 快照之后在 PG 里产生的新写入**不会回来**
    ⇒ 可接受的数据恢复窗口 = 最后一次快照之后的写入。**不主张"恢复成功 = 零数据损失"。**

R2  留在 PG 修 PG：`pg_dump`（`PG-G07` 已证在线可用）+ 灌进新库 + 配置指过去
    ⇒ 备份周期 = **按需**（不是定时）· RPO = 上次备份之后的写入
    ⇒ PITR / WAL 归档 / 异地备份 = **未验**（第二阶段另验）
```

---

## 8. 不主张

```text
· 不主张"切换已就绪" —— 本文件是候选；`PG-G10` 的判定见 Gate-Decision
· 不主张回滚零损失 · 不主张有 PITR/异地备份 · 不主张性能更好
· 不主张"实施后回归适用性已复核" —— 见 Known-Limitations（这一条是 WP6 的待办）
```
