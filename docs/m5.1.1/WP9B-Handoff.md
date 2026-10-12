# WP9-B Handoff —— E4 System-Origin Production Producer

**判定：`WP9-B = BLOCKED BY PRODUCT CAPABILITY DECISION`**（停在 **B0 Semantic Selection Gate**）
**`WP9 = PARTIAL / BLOCKED`（不变）** · **`WP9-C` 先行条件不成立** · **`WP10 = NOT AUTHORIZED`**
日期：2026-09-20 · 上游：`WP9-A / E8 durable audit = PASS`、`WP9-GAP-2 = RESOLVED IN PRODUCTION`
执行令："Do WP9-B only. 完成后 STOP. 不要开始 WP9-C."
B0 的 Hard STOP 条件命中：**production-real system-origin 归因行为 = 0**

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `scripts/verify-m5.1.1-wp9b-e4-selection.ts`（**新增**：只读选型量具）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` 追加一条登记 + 理由）· `package.json`（`m5.1.1:wp9b:selection:verify`）· `artifacts/m5.1.1/wp9b-e4-selection.json`（B0 台账）· 文档（B0 记录 / 本 handoff / 执行计划 R-44）。**生产代码零改动**（`src/**` 一行未动） |
| **Tests Run** | `pnpm typecheck` · `pnpm m5.1.1:wp9b:selection:verify` · 回归：`wp8:verify`、`k17:verify`、`k29:verify`、`wp9a:verify`、`wp8c1:verify`、`wp8c2:verify`、`m5.1:measurement:verify`、`m5.1.1:gates` · 观察（不用于判定）：`wp9:verify` |
| **Tests Passed** | `typecheck` = 0 · `wp8:verify` = **0**（新脚本登记后覆盖扫描仍 0 未分类）· `k17` = 0 · `k29` = 0 · `wp9a` = 0 · `wp8c1` = 0 · `wp8c2` = 0 · `m5.1:measurement` = 0 · `gates` = 0。`wp9b:selection:verify` = **EXIT 1**（本门语义：**1 = BLOCKED**，不是量具失败；量具健康 `valid`） |
| **Tests Failed** | **0**。`wp9:verify` 观察值 = **40 通过 / 0 失败 · `PARTIAL / BLOCKED`（EXIT=1）** —— 这是 WP9 的既定判定，**不是回归**（按 B11：不得用它判断 WP9-B 成败） |
| **Evidence Produced** | `artifacts/m5.1.1/wp9b-e4-selection.json`：`verdict = BLOCKED_BY_PRODUCT_CAPABILITY_DECISION` · `selectedCandidate = null` · `candidates = []` · **14 条被否决候选**（含 5 条**真实**系统发起写入）· **7 条机器核对的事实** · 10 个类的逐类命中/良性命中 · 量具健康（131 文件 / 2,177,904 字节 / 10 类 / 注入段 3 候选，全部达下限）· 三段式（正控安静 / 注入必响 / 恢复安静）· 退出码语义。F4：`M5.1.1-WP9B-B0-Selection-Record.md`；计划行 R-44 |
| **Known Issues** | ① `WP9-GAP-1 / E4-A` **保持 OPEN**：生产里**确实有 5 类**"系统自行发起"的真实写入（启动修复 `recoverMemoryProjections` · 首启 `state_events(trigger='init')` · Seed 幂等 upsert · 世界/房间/实体 ensure · 退出 telemetry flush），但**没有一条**能进入 kernel 归因账本、携带归因信封（实测 F6/F7：修复过程零 ledger insert、`state_events` 无归因列）⇒ 要造出 E4 的证据只能**新造产品语义**，正是执行令禁止的"E4-only producer"。② 解封需要**产品能力决定**（三选项见 B0 记录 §7：让投影修复成为一等可归因系统行为 / 让首启状态可归因（要 v9）/ 引入真实调度器后台任务），**不由本 WP 替用户选**。③ 仪器观察（不立案）：除 `memory-background` 外另有 **5 个开关**在生产无功能消费者（`eventPipelineV2` / `telemetryEnabled` / `memoryEnabled` / `memoryExtractionWindow` / `memoryImportanceThreshold`）。④ B0 量具**自己**有一次 false loud（C8 良性命中写成单条规则 ⇒ 4 个假候选 ⇒ 曾打印 `CANDIDATE FOUND`），已修判据（改成 OR 复合规则）、未改读数，并记录在案。 |
| **Architecture Deviations** | **无**。没有新 schema（**无 v9**）、没有打开真实库、没有碰 MemoryAuthority / Fact Firewall / Recall / extractor / ADR-043 / Phase 4 / K-31、没有改 Developer Control 审计语义、没有开始 WP9-C。新增物只有一个**只读**量具（不 import 任何 kernel/infrastructure 模块 ⇒ 不可能打开数据库）。冻结面最终与 `m5.1-complete` **无差异**（1 条被 measurement 门重写的路径按 C1 从标签逐路径还原）。 |
| **Commit Hash** | `d13e94e` — `test(m5.1.1): add WP9-B B0 semantic selection gate for E4`（量具 + 注册表登记 + `package.json`）· `c96c8cf` — `test(m5.1.1): record WP9-B E4 selection inventory (0 candidates)`（证据）· 本次 docs 提交（B0 记录 / 本 handoff / R-44）紧随其后 |

---

## Next WP Preconditions

**下一步不是 WP9-C。** WP9-C 的两项工作（把 E4 指向真实 SYSTEM producer、把 E8 指向 `main.ts` 已接入的 durable audit writer）
里，**E8 那半边的条件已经成立**（WP9-A），而 **E4 那半边缺一个真实 producer**。

要解封，需要用户先在"产品能力"层面作出决定（B0 记录 §7 的 A/B/C），例如：

1. **A**：承认"记忆投影修复"是一等可归因的系统行为（⇒ 需要产品语义裁定 + memory 权威边界裁定）；
2. **B**：让首启状态引导可归因（⇒ 需要 schema **v9** 或等价表示，属独立迁移里程碑）；
3. **C**：引入**真实的**调度器 / 后台任务（⇒ 产品新能力；M3.5 明文"只登记不实现"，属独立里程碑）。

在作出决定之前：

- `WP9-GAP-1 / E4-A` = **OPEN**；`WP9` = **`PARTIAL / BLOCKED`**；`WP9-C` = **NOT READY**（先行条件不成立）；
- `WP9-A / E8 = PASS` 与 `WP9-GAP-2 = RESOLVED IN PRODUCTION` **不受影响**；
- `WP10` = **NOT AUTHORIZED**；`K-31` = **OPEN / DEFERRED / NON-BLOCKING**；`ADR-043` = **NOT APPROVED**；`Phase 4` = **BLOCKED**。

**纪律提醒（下一次照旧）**：一个进程一个沙箱库（`isolateDatabase` + `resetPluginSqlConnection`）·
**不要并发跑门**（WP8 的"未声明门写入面"判据按 `mtime ∈ 运行窗口` 归因，并发写者会伪造它的红）·
冻结面只从 immutable 标签 `m5.1-complete` 逐路径还原 · 被门重新生成的历史证据逐路径还原到 HEAD ·
绝不 `git add -A` · 每次 execution 只做一个 WP，做完即 STOP。
