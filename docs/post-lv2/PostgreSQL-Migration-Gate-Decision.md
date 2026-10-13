# PostgreSQL 迁移 · 门判定（Gate-Decision，WP6）

> **判定载体**。它把"切换就绪"这件事拆成可审查的条目，逐条给读数与归属。
> 机器判据：`pnpm postgresql:g10:verify`（**只读审查**：不跑门、不连库、不改东西）。
> ⚠️ 选档按 `runId` 字典序（**不看 mtime**）。

---

## 1. 门读数汇总（本线）

| 门 | 读数 | 来源 |
|---|---|---|
| `PG-G02` schema 与权限 | **31/31** | `pg-migration-wp2-20261013T130636`（旧形态：逐场景 JSON） |
| `PG-G03` 生命周期与写入资格 | **23/23** | `pg-migration-wp3-20261013T134718`（旧形态） |
| `PG-G04` SQL/仓储兼容 | **20/20** | `pg-migration-g04-*` |
| `PG-G05` 迁移完整性 | **29/29** | `pg-migration-g05-*` |
| `PG-G06` 投影与语义召回 | **30/30** | `pg-migration-g06-*` |
| `PG-G07` 在线备份恢复 | **47/47** | `pg-migration-g07-*` |
| `PG-G08` 功能整链与回归 | **28/28** | `pg-migration-g08-*` |
| `PG-G09` 量具有效性 | **23/23** | `pg-migration-g09-*`（⚠️ 2026-10-13 之前**不落盘**，现已补） |
| `S8` 资源读数 | **12/12** | `pg-migration-bench-*` |
| `LIVE` 有限真模型 smoke | **7/7** | `pg-migration-live-smoke-*` |
| **聚合** | **lane 9 道 · PASS 9 · FAIL 0** | `gates:run --lane postgresql` |
| **完整离线 CI** | **`pnpm m4.5:ci` EXIT 0** | G12 38/0 · G13 32/0 · G14 52/0 · G2 150/0 · L2 53/0 |

**run 归属**：所有门记的**来源快照是同一个** ——
`data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd`
（`G10.3` 断言；防止"这份绿、那份比的是别的库"）。

**恢复演练**：`PG-G07` 证据里"备份/恢复"那一族判据 **18/18 全过**（`G10.4` 断言）。

---

## 2. 判定（分列，不合成一个总分）

```text
PG-G01…09 全 PASS            ✅（G01 在 offline lane；其余见 §1）
旧后端回归适用                ⚠️ **PARTIAL** —— `G10.6` 只证到"证据目录在案"；
                              逐门读数与归属**未列**（见 Known-Limitations `L-PG-16`）
恢复演练成功                  ✅（G10.4：18/18）
Runbook / 目标身份 /
停机估计 / 回滚条件           ✅ 完整（`G10.5` 逐要素断言；Activation-Candidate 亦在案）
WP6 四份交付物                ✅ Activation-Candidate · Runbook · Known-Limitations · Gate-Decision
待猜测的生产命令              ✅ 无（Runbook §7 逐条给出实际命令 + 绝对目标）
```

⇒ **`PG-G10` = 本文件 + 机器判据**。**判定：切换候选就绪 = `PASS`（带 1 条 PARTIAL）**，
其中 `旧后端回归适用` 仍是 `PARTIAL`，销账条件写在 `L-PG-16`。

⚠️ **这不是授权**：WP7（真实切换）需要用户当轮**逐字授权**；本判定只说明"候选已就绪"。

---

## 3. 条件（切下去之前必须满足）

```text
C1  用户当轮逐字授权 WP7（先例：`db:restore --apply` / `coexist:start` 都要授权串）
C2  §1 的九道门**在当前检出上重跑一遍**并全绿（不许拿旧 run 的绿当本次的绿）
C3  `pnpm m4.5:ci` EXIT 0（跑前确认**没有 LG 核心在跑** —— 它的 G14 会热复制生产库）
C4  最终快照 = 切换当轮新取的 verified snapshot（`PG-P01` 逐字：不得承接早期副本读数）
C5  Runbook §1 的前置检查逐条打勾（无核心、无 NapCat、PG 健康、上次干净关闭）
C6  R1/R2 两条回滚路线**在切换前确认可用**（R1 的快照 id 要在手上）
```

---

## 4. 失败处置

见 Runbook §8（恢复日志有 ERROR ⇒ 停；门 FAIL ⇒ 先归因是量具错还是被测物错；
核心身份核对拒绝 ⇒ **那是保护**，不要放宽期望值；真实库被意外打开 ⇒ 按 `PG-ISO-01` 处置）。

---

## 5. 不主张

```text
· 不主张"生产已切换" —— 未切换；WP7 待授权
· 不主张"旧后端回归适用已复核" —— 那是 §2 的 PARTIAL
· 不主张回滚零损失 / 有 PITR / 性能更好 —— 见 Known-Limitations
· 不主张本判定覆盖 WP3 余项（消费者生命周期共存启停 · 在飞模型晚返回 · 两个完整核心演练）
```
