# INC-01 根因调查工具（TD-18）

> 这套工具是 [INC-01 根因调查报告](../../docs/incidents/INC-01-Root-Cause-Investigation.md) 的机器可复跑部分。
> 事故本体、防复发计划与验收报告在 [`docs/incidents/`](../../docs/incidents/)。

## 边界（先读）

```text
· 绝不打开真实库 data/pglite：本目录所有脚本只接受位于含 "inc-01-rootcause"
  的草稿根下的 dataDir，其余一律 REFUSED（exit 9）。
· 所有实验库都是可丢弃的：默认写在
  data/diagnostics/inc-01-rootcause/（data/ 已被 gitignore）。
· 不修改 src/infrastructure/persistence/**（M9 的持久化公共层只被"读/调用"）。
· 保留故障环境 data/pglite.broken-20260920-214044 只被**读取**（cpSync / readFileSync）；
  oracle 把它的 WAL 片段复制到一次性读库里让 Postgres 自己解析，不打开坏库本身。
```

## 两个脚本

### 1. `repro.mjs` —— 最小复现（"触发条件"）

```bash
node scripts/inc-01-rootcause/repro.mjs run --iters 3
```

同一 dataDir 上两个**同时存活**的 PGlite 实例：B 先打开并保持空闲（它的 WAL 插入位置就此**陈旧**），
A 随后写入并强制 `CHECKPOINT` 后退出，B 再继续写入 —— B 的记录流会覆盖 A 的 checkpoint 记录，
而 `pg_control` 仍然指着它。此后任何一次打开都会在启动恢复阶段 `PANIC`：

```text
RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
```

对照组（同样负载、但两个写者严格串行 ⇒ 不存在陈旧位置）必须打开成功。
脚本以 `{reproduced, controlHolds, errorSignature}` 收尾；两者不同时成立时退出码 1。

### 2. `wal-oracle.mjs` —— 用 Postgres 自己的 WAL 读取器做判据

```bash
node scripts/inc-01-rootcause/wal-oracle.mjs \
  --reader data/diagnostics/inc-01-rootcause/oracle-committed/reader \
  --inject data/pglite.snapshot-20260919-2329/pg_wal/00000001000000000000000A \
  --inject data/pglite.broken-20260920-214044/pg_wal/00000001000000000000000B \
  --record 0/AF0DC0 --record 0/B19DB0 --named-lsn 0/B19DB0 \
  --checkpoints 0/B00000:0/B25948
```

它把一次性读库推进到目标 LSN 之上，再把指定 WAL 片段复制进读库的 `pg_wal`，然后用
`pg_walinspect`（Postgres 自身的读取器）回答"这个 LSN 上到底有没有记录"。
**为什么不用自己写的解析器**：手写的 XLogRecord CRC 约定始终没对上（见 `evidence.json` 的
`instrumentCorrections`），于是改用权威读取器，避免拿未经验证的解析当结论。

### 3. `collect-evidence.mjs` —— 汇总成可入库证据

```bash
node scripts/inc-01-rootcause/collect-evidence.mjs
# → artifacts/incidents/inc-01/rootcause/evidence.json
```

## 探索性场景脚本（未入库，属草稿）

排除矩阵里的其它场景（单进程 SIGKILL、双写者、并发只读、热复制、带 checkpoint 的并发、
跨进程租约对照）跑在 `data/diagnostics/inc-01-rootcause/lab/` 下的
`driver.mjs` / `writer.mjs` / `writer-ctl.mjs` / `reopen.mjs` / `oracle-ask.mjs` /
`lease-test-driver.mjs` 等草稿脚本上；它们的**逐次读数**已汇总进
`artifacts/incidents/inc-01/rootcause/evidence.json`（`runs` / `excluded` / `preventionControl`）。
`data/` 被 gitignore，因此这些脚本不随仓库分发；上面两个入库脚本覆盖了最关键的两条路径。
