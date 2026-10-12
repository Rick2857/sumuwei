# WP9-A Handoff —— U-03 Developer Control Durable Audit Writer

**判定：`WP9-A = PASS`** · **`WP9 = PARTIAL / BLOCKED`（不变）** · **`WP10 = NOT AUTHORIZED`**
日期：2026-09-20 · 上游：`WP9 = PARTIAL / BLOCKED`（`WP9-GAP-1` / `WP9-GAP-2` 两条正式裁定）
执行令："下一次只执行 **WP9-A / U-03 Developer Control Durable Audit Writer**"

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `src/infrastructure/dev/control-audit.ts`（**新增**：唯一 writer + reader，`createDeveloperControlAuditWriter` / `readDeveloperControlAudit` / `developerControlAuditCount`）· `src/infrastructure/dev/control-service.ts`（+34/−8：可选 `audit?: DeveloperControlAuditWriter` 端口 + 四个终态写点）· `src/main.ts`（装配注入 writer，**故意不传** `developerIdentity`）· `scripts/verify-m5.1.1-wp9a-control-audit.ts`（**新增**专项门）· `scripts/m5.1.1-attribution-gate-registry.ts`（新门登记进 `NON_VERIFIER_SCRIPTS`，附理由）· `package.json`（`m5.1.1:wp9a:verify`）· 文档三份（F4 / 本 handoff / 执行计划 R-43） |
| **Tests Run** | `pnpm m5.1.1:wp9a:verify` · `pnpm typecheck` · `pnpm m5.1:test` · `pnpm m5.1:query:verify` · `pnpm m5.1:control:verify`（§5 核心表对 `src/infrastructure/dev/**` 的全部要求）· 回归：`pnpm m5.1.1:wp8:verify` · `pnpm m5.1.1:wp9:verify` · `pnpm m5.1.1:k17:verify` · `k29` · `wp8c1` · `wp8c2` · `pnpm m5.1:measurement:verify` |
| **Tests Passed** | `m5.1.1:wp9a:verify` **31 / 0**（exit 0，14 个量具全部 `measured_count > 0`，`measurementInvalid = 0`）· `typecheck` 0 · `m5.1:test` 0 · `m5.1:query:verify` 0 · `m5.1:control:verify` 0 · `wp8:verify` **50 / 0**（exit 0）· `wp9:verify` **40 / 0**（exit 1 = `PARTIAL / BLOCKED`，**既定判定**）· `k17` 15 / 0 · `k29` / `wp8c1` / `wp8c2` / `m5.1:measurement` 全 exit 0 |
| **Tests Failed** | **0**（两次中途的"红"都已归属、都不是回归：① `wp8:verify` 49/1 = **并发写者**污染，单进程重跑 50/0；② `wp9:verify` EXIT=2/38-2 = 门的两条**工作树清洁度** scope guard（`WP9-18` / `WP9-16`）与提交顺序耦合，提交 + 按 C1 还原冻结面后回到 40/0。详见 F4 §6） |
| **Evidence Produced** | `artifacts/m5.1.1/wp9a-control-audit.json`（31 条断言 / 14 量具 / 四个负控 / L1↔L2 关联 / 逐槽位指纹 / `character_action_events` 4→4（控制命令前后不变））· `artifacts/m5.1.1/wp9a-gate-exits.txt`（每道门的退出码）· F4：`docs/m5.1.1/M5.1.1-WP9A-Compatible-Assertion-Record.md` · 执行计划 R-43 |
| **Known Issues** | ① **canonical E8 仍未完成**：WP9 门**自建**控制服务、不装 audit 端口 ⇒ 它测到的 0 行是**该 runtime** 的事实；把 E8 指向生产装配是 **WP9-C** 的活。② 该门的 `WP9-GAP-2` 文本"控制面今天**没有**持久化 writer"对**生产装配已陈旧**（现在有了）——**故意不在本 WP 改**（改 WP9 的验收面 = WP9-C）。③ **仪器观察（未立案）**：`WP9-18`/`WP9-16` 是工作树清洁度守卫、**没有运行前基线** ⇒ 提交前过严、提交后静默通过；建议 WP9-C 照 WP8 §0 加 pre-capture。④ **过程纪律**：WP8 的"未声明门写入面"判据按 `mtime ∈ 运行窗口` 归因 ⇒ **并发跑门会伪造它的红**（已实测）。⑤ `WP9-GAP-1 / E4-A` 仍 `NOT RUN / BLOCKED`（WP9-B）。 |
| **Architecture Deviations** | **无**。没有新 ADR（执行令明确：E8 不需要新 ADR）；没有改判据 / 阈值 / 词表 / CHECK；没有新迁移（**无 v9**，schema 仍 v8）；`kernel/**` 零改动（依赖方向未破）；`character_action_events` 与 Execution Truth 语义未动；冻结面最终与 `m5.1-complete` **无差异**。一次 503 是本 WP **自己**的 INSERT 列序缺陷（见 F4 §5），已在唯一源头修，**不是产品缺陷**、**未放宽 CHECK**。 |
| **Commit Hash** | `ce7e1a7` — `feat(dev-plane): persist developer control authority with attribution slots`（生产 writer + `control-service` 端口 + `main.ts` 装配）· `36c14df` — `test(m5.1.1): add WP9-A developer control durable audit gate`（专项门 + 注册表登记 + `package.json`）· `27514d0` — `docs(m5.1.1): record WP9-A verdict with F4 record and handoff`（F4 / 本 handoff / R-43）· `ba3ed20` — `test(m5.1.1): add WP9-A durable audit gate evidence`（`artifacts/m5.1.1/wp9a-*`）|

---

## Next WP Preconditions

**下一个 WP 只能是 `WP9-B — E4 System-Origin Production Producer`**（用户已排定：`WP9-A → WP9-B → WP9-C → WP9 PASS → WP10`）。
**不得**在同一次 execution 里开始它；**不得**跳过 C 直接宣布 `WP9 = PASS`。

进入 WP9-B 前必须成立：

1. 本 WP 的两次账已结清：`wp8:verify` 单进程 **50/0**、`wp9:verify` **40/0 · PARTIAL / BLOCKED**（EXIT=1 是既定判定）。
2. `WP9-GAP-1 / E4-A` 的现状被如实带过去：**生产 ingress 只有 `user_message` / `assistant_message` 两个生产者**，
   `Known(SYSTEM)` 分支**不可达**——WP9-B 要加的是一个**真的生产** `system_event` 生产者，
   不是测试 fixture（否则 `WP9-13` 的"缺生产入口 ⇒ NOT RUN"仍然成立）。
3. 纪律照旧：一个进程一个沙箱库（`isolateDatabase` + `resetPluginSqlConnection`）、
   生产入口优先、真实键关联 L1↔L2、计数型判据自检 `measured_count > 0`、正控/负控/恢复三段式、
   **不要并发跑门**、冻结面只从 `m5.1-complete` 还原、绝不 `git add -A`。

**`WP9-C` 的待办（本 WP 移交，不要遗忘）**：把 E8 的判定指向**生产装配**的 writer
（`src/main.ts` 的 `createDeveloperControlAuditWriter`），并把门内 `WP9-GAP-2` 的陈旧文本改成当前事实；
顺手照 WP8 §0 的形状给 `WP9-18` / `WP9-16` 加运行前基线。

**仍未授权 / 未关闭**：`K-31 = OPEN / DEFERRED / NON-BLOCKING` · `ADR-043 = NOT APPROVED` · `Phase 4 = BLOCKED` ·
`WP10`（production-copy migration）= **NOT AUTHORIZED** · `M5.1-D01` 未关闭。
