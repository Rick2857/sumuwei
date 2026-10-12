# WP10b Handoff —— 最终候选 Live（production-copy + 受影响 Live 复验）

```text
Completed WP:            WP10b（M6 / Lv1 Hardening；计划书 §WP10b L407–411；契约 M6-G11 的 Live 半边）
                         —— 判定 **PASS**：本门自己的 Live 全绿，且两道受影响的 Live 复验**都真的跑过并通过**
Commit / branch:         `6cdd34e`（判据修正：自指豁免 + 失败可归因 + stderr 留证）· 本文件所在提交 =
                         `git log -1 -- docs/m6/WP10b-Handoff.md` / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp10b-live.ts                       本门（S/L/G/X/C/R/Z 七节 12 项断言）
  scripts/m6-evidence.ts                                登记 `wp10b-live`（必选门；`m6:gates` = **17** 道）
  artifacts/m6/m6-wp10b-6cdd34e7960d/live.json          本门证据（PASS）
  artifacts/m6/m6-wp10b-6cdd34e7960d/affected-live/     受影响复验的读数快照 + 归因 + 失败历史
  docs/m6/WP10b-Handoff.md                              本文件

Commands + exact exit codes:
  pnpm typecheck                                        → EXIT 0
  pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp10b-live.ts
                                                        → **EXIT 0（判定 PASS；12 通过 / 0 失败）**
  pnpm m6:gates                                         → **EXIT 0（必选门 17 个 · 未运行 0 · 未通过 0 · Hard Gates = PASS）**
  子步骤（受影响的 Live 复验，本轮都真的跑了）:
    pnpm m5.5:smoke:live      → 0（78s）  24 通过 / 0 失败（附录 5 行 · selectedCounts=4,5）
    pnpm m5.5.1:smoke:live    → 0（165s） 20 通过 / 0 失败
```

## 本门证了什么（12 项全绿）

```text
  S1  副本**不是**真实库（`isProductionDir` 逐路径校验）—— 真实库 1205 文件 `9878ed0512f0…` 只被**复制**
  L1  生产装配**本尊** `tsx src/main.ts` 跑得通：退出码 0，她真的说了话（真模型/测试端点）
  G1  真实写入链完好：这一轮的用户/助手事件都进了**副本**库的账本（conversation_events=30）
  G2  **接线就位但默认不激活**（行为面）：那一轮 `context_compile` 里**一个 `rollup_*` 键都没有**，
      也没有 `rolling-summary` section
  G3  **接线就位**（静态面）：生产装配里确实构造了摘要端口（`rollup: this.buildRollupTurnPort()`），
      额度来自 `recallBudget`（`DEFAULT_CONTEXT_BUDGET.rollupTokens` 缺省 **0**）
  G4  真实链路隐私边界：trace 里**没有**用户那句原话（账本可以记，trace 不行）
  X   **两道受影响的 Live 复验都 EXIT 0**（M5.5 24/0 · M5.5.1 20/0）—— 这是本里程碑"Live 为必需"的落点
  C1  `pnpm with-test-model pnpm m4.5:ci:full`（含 Live Smoke）在**同一冻结候选**上 EXIT 0
      —— 读数取自 WP10a 回归自己写下的快照（`head=866f2fb`、回归 verdict=PASS）
  R1  相对 WP10a 冻结候选（`866f2fb`），运行相关树**只动了 `scripts/`**（`src/` `evals/` 等逐字节未变）
  R2  受影响三步重跑：typecheck=0 · m6:measurement:verify=0 · m6:gates=2（**自指豁免已证明**）
  Z1  真实 `data/pglite` 在本门前后**逐字不变**（所有读写都在副本上）
```

**生产激活状态（如实登记）**：`rollup = NOT ACTIVATED`。
生产的 `recallBudget` 走 `DEFAULT_CONTEXT_BUDGET`，其 `rollupTokens` 缺省 **0**
⇒ 端口虽已构造，但**不读库、不产 section、不写 trace**。这与 M5.5 的搜索
（先接线、缺省 0、激活另裁，ADR-048）是同一个形状：**激活属独立裁定**，本门不替它做主。

## 受影响 Live 复验的关键读数（Level 1 + Level 2）

```text
M5.5（24/0）：S1 回复 744 字 · 来源附录 5 行（E1–E5）· S2 回复 988 字 · 附录 4 行
              tracesWithExternalEvidence=2 · selectedCounts=[4,5] · provider=searxng-local
              ledgerRows = success, success · evidenceRefsInDetail=6
              external_evidence 七键：selected_count=4 · candidate_count=5 · bundle_attached_count=1
                                      context_budget_dropped_count=0 · evidence_budget_dropped_count=1
M5.5.1（20/0）：语义/归因 Live 全绿（它同样读 M6 改过的上下文装配）
```

## Deviations（**判据修正，不是放宽**）

1. **R2 的自指缺陷（已修）**：`wp10b-live` 登记为必选门后，`m6:gates` 的读数**包含本门自己**，
   而本门证据要等本门跑完才落盘 ⇒ 运行中的聚合门**不可能**把它算成通过。
   第一版判据要求"三步都 EXIT 0"，于是在一个**正确**的读数上永久报假红。
   修正后的判据保留原意（"所有**其它**必选门仍被接受"），并把豁免写成**可证伪的证明义务**：
   必须同时满足 ①聚合门确实非 0 ②未运行 = 0 ③未通过 = 1 ④唯一那个具名门**就是** `wp10b-live`；
   解析不到具名清单 ⇒ 豁免**不成立**（失败关闭），仍然报红。
2. **`say()` 丢 stderr（已修）**：两个 `say()` 都只留 stdout，于是"子进程 exit 1 且回复为空"这种红
   **完全不可归因**（日志里连一句错误都没有）。现在 stderr 尾部会被打印并写进 L1 的读数。
3. **同一 head 上并发重跑会互相覆盖证据（实测踩到）**：`runId` 按 head 派生
   （`m6-wp10b-<head12>`），另一个会话在**同一 head** 上并发跑了同一道门，
   覆盖了 `live.json` 与 `local/<runId>/*.log`。受影响复验的读数快照已另存（见
   `artifacts/m6/m6-wp10b-6cdd34e7960d/affected-live/README.md`）。
   **教训**：要么串行，要么给 runId 加时间戳/序号。
4. **不覆盖旧里程碑证据**：那两道受影响门会把读数写进 M5.5 / M5.5.1 **自己的**冻结证据文件；
   本轮先把读数原样快照（含 SHA-256），再 `git checkout --` 还原回 HEAD blob，
   `git diff --quiet -- artifacts/m5.5 artifacts/m5.5.1` = EXIT 0；`pnpm m5.5:gates` 复核仍 **PASS**。
5. **失败历史不删**：同一 head 上先红过一次（M5.5 20/4，4 条红全部由一次瞬时 `exit 1` 级联而来），
   读数与归因都留在 `affected-live/README.md`。

## 环境前置（**不是 M6 的缺陷，但决定了这道门能不能跑**）

```text
本轮期间 ADR-047 冻结的三元组（`duckduckgo,wikipedia,wikidata`）一度合计 0 条：
  duckduckgo 报 `验证码`/`超时`；从本机直连 html/lite.duckduckgo.com 14s 后被连接重置
  ⇒ 用户随后在 `searxng/settings.yml` 的 `outgoing.proxies` 指向宿主机 Clash（`host.docker.internal:7897`）后恢复
恢复后实测：wikipedia ✓ / wikidata ✓ / brave ✓ 26 条 / google cse ✓ 10 条 / 默认引擎组 37 条零超时；
冻结三元组下 `results[]` 返回 10 条（1.5–3.0s）。DDG 仍会被服务端反爬（针对 SearXNG 的 POST 形状）。
⚠️ 引擎组更换（如 ddg→brave）属 **ADR-051**，**仍等用户批准**；本轮**没有**改冻结引擎组。
```

Root-cause status: 与 INC-01 无关；INC-01 根因仍是 `PARTIAL`。

---

## 下一步

```text
① WP11：M6-Acceptance-Report / M6-Known-Limitations / M6-Gate-Decision + `M6 = PASS/FAIL`。
   WP11 **必须分列**：rev2 冻结阈值全过（WP9b PASS）· **WP9b 那条未达标的假记忆边界**（探测器 INVALID）
   · 生产激活未裁定（rollup）· 搜索稳定性（本轮真实观测：上游引擎会被 CAPTCHA/网络层挡住，
   冻结三元组下 `results[]` 能否非空取决于 duckduckgo）· G1 待真人盲审。
② G1-A/G1-B 仍 `AWAITING HUMAN REVIEW`（需要真人）。
③ M6 完成后**不自动做**：合并、打 `m6-complete`、开 auto_public、真实库迁移/恢复、M7 开工。
```
