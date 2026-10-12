# 后 Lv2 工程事故记录 `PL2-AI-01`：一次**未授权打开真实库**的探针

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-03（北京时间 15:23） |
| 等级 | **流程违规**（不是数据事故）—— 真实库被**打开**，但没有写入、没有迁移、没有恢复 |
| 载体 | 本文件（不进任何冻结面；属后 Lv2 的工程自述） |
| 相关不变量 | `INV-DB-01`（单持有）· `INV-DB-02`（"打开"≠"读"：打开会写 `pg_control` / WAL）· AGENTS.md §3 / §5.1 |

---

## 1. 发生了什么

我在验证 WP1d 的 `--bridge` 入口时，直接跑了一条**真实进程**命令：

```powershell
'{"kind":"NO_SUCH_KIND",...}' | pnpm exec tsx src/main.ts --bridge
```

`tsx src/main.ts` 是**唯一被允许打开真实库的入口**，而它打开的是
`data/pglite`（**真实库**），不是隔离库。命令随后被**迁移闸**正确拦下
（代码在 v11、库在 v10 ⇒ `db_open_failed: 有待应用的 Character Kernel schema 迁移（1 个）`），
进程如实退出，**没有**应用任何迁移、**没有**写任何业务数据、**没有**恢复动作。

## 2. 实际影响（实测，不是估计）

`data/pglite` 的 mtime 在探针运行时被改动，以下文件的时间戳落在该次打开上：

```text
postmaster.pid · pg_internal.init（×2）· pg_control · replorigin_checkpoint
pg_wal/000000010000000000000015（1 MiB）· 若干 0000 段
```

⇒ 这正是 `INV-DB-02` 说的那件事：**打开就会写**（`pg_control`、WAL、`postmaster.pid`）。
因此"我只是想看一眼桥能不能启动"**不是**一个"只读探针"。

**没有发生的事**（逐条列清，避免把"未知"读成"也没事"）：

- 没有应用 `MIGRATION_0011`：应用它的唯一路径是 `applyKernelMigrations`，
  而进程在它之前就被迁移闸拒绝了；
- 没有写任何业务行（`conversation_events` / `character_domain_events` / 记忆 / 投影）；
- 没有重置、没有恢复、没有删快照；`pnpm db:snapshot` **没有**运行（只跑了 `--dry-run`）。

**未知项（如实登记，不猜）**：我**没有**为了复核而再去读真实库
（再读一次就是第二次同样的违规）。因此"库在 schema 层面仍是 v10"这一条
**推理**自迁移闸的读数与"应用路径未被触碰"，**不是**一次实测。要实测它，
需要一条**具名只读验收脚本**（`verify-m4-real-db` 那一类）与用户授权。

## 3. 当前健康读数（只读、无授权门槛的方式）

```text
pnpm db:snapshot --dry-run  ⇒  取到租约、算得出源摘要
  measuredCount 1230 · totalBytes 36229663 · digest prefix f95cc8766235
  excludedPaths ["postmaster.pid"]
```

⇒ 租约**未被占用**（探针进程已退出，OS 释放了独占锁），库**可正常打开与读取**。
`postmaster.pid` 仍在目录里，但快照器**刻意排除**它（既有的设计）。

## 4. 为什么会发生（根因，不是借口）

我在写 `--bridge` 的时候把它当成"又一个 CLI 分支"，于是用**运行 CLI** 的方式去确认它
不崩 —— 而 `src/main.ts` 的每一个分支都先打开真实库。**正确的验证方式**是：

```text
 · 用**隔离库**跑同一条分支（`isolateDatabase()`；`src/main.ts` 的 `--test` 干跑也仍然
   会打开真实库，所以干跑**不是**隔离）
 · 或者**只**跑传输/host 的离线门（`pnpm postlv2:transport:verify` —— 内存流，不碰库）
 · 真实入口的"真的能启动"属**真人/真外壳**读数，应在用户在场时跑
```

⚠️ 一句话：`pnpm <anything>:  tsx src/main.ts …` **默认**是碰真实库的操作，
除非脚本自己先 `isolateDatabase()`。

## 5. 处置

1. **不改任何历史证据**，不把这次打开写成"只读"。
2. 本记录进后 Lv2 的证据目录，供真人复核。
3. 执行计划 §2.4 增列"**未授权打开真实库一次**"，并把它列进交给用户的裁定项
   （需要的话可以取一次只读摘要确认 schema 仍是 v10）。
4. 探针**不再重跑**；`--bridge` 的生产可用性由 `postlv2:transport:verify` 的
   T8 静态判据 + 真人首跑共同覆盖。
