# WP10a Handoff —— 最终候选离线门与全量回归

```text
Completed WP:            WP10a（M6 / Lv1 Hardening；计划书 §WP10a；契约 M6-G11）—— **判定 PASS**
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
冻结候选:                head = 866f2fb · 运行相关树哈希 = be70e992e5f2f9f7d7565a67… （429 个文件）
                         工作树例外 = **0 条**（运行相关树干净）· node v22.23.2 · pnpm 12.4.1

Changed files:
  scripts/verify-m6-wp10a-final-offline.ts          新增：本门（分块/可续跑；48 步 + 冻结 + 白名单恢复）
  scripts/m6-evidence.ts                            登记 `wp10a-final-offline`（必选门；`m6:gates` 变 **16** 道）
  scripts/verify-m6-wp8.ts                          **判据更正**：S7 改成状态相对
  scripts/verify-m5.5-measurement.ts                **受影响面**：三处探针基准（见下）
  docs/m6/M6-Affected-Surface-Map.md                §8 记录"WP10a 实测到的受影响面"（WP0 原文一字未改）
  artifacts/m6/m6-wp10a-{976eeb302fc0,866f2fba5f27}/regression.json  先 FAIL 后 PASS 的两次证据（**都保留**）
  artifacts/m6/m6-wp{2,3,3-reader,4,5,6a,6b,7a,7b,8}-20260922-866f2fba5f27/  冻结候选上重跑的 M6 离线门证据
  docs/m6/WP10a-Handoff.md                          本文件

Commands + exact exit codes（分块跑；每步读数落盘 `artifacts/m6/local/<runId>/readings/`）:
  pnpm typecheck                                    → EXIT 0
  §10.1 的 39 条命令                                 → **39/39 EXIT 0**（m4.5:ci 744s）
  INC-01 登记门 4 条 + M6 离线门 12 条                → **16/16 EXIT 0**（m6-wp8 790s）
  pnpm inc-01:regression:verify（含 m4.5:ci:full）   → EXIT 0（**2823s ≈ 47min**），证据 verdict = PASS
  pnpm m6:gates                                     → EXIT 0（**Hard Gates = PASS**；必选门 **16** 个）
  WP10a 本门                                        → **10 通过 / 0 失败 · 判定 = PASS**
```

## 这次是怎么从 FAIL 走成 PASS 的（失败历史保留）

第一轮扫描（候选 `976eeb3`）判 **FAIL 9/1**：§10.1 里只有 **2 条**红 ——
`m5.5:measurement:verify`（231 通过 / 8 失败）与 `m5.5:gates`（G1 = FAIL）。逐条分析后确认
**不是行为回归**，而是 **M6 自己合法地让 M5.5 的三处冻结期望过期**：

| # | M5.5 的探针 | 性质 | 处置（用户 2026-09-21 选 B 批准） |
|---|---|---|---|
| ① | 预算配置检测器的**夹具**缺 M6 WP2 新增的必填 `ContextBudget.rollupTokens` | **夹具过期** | 给 4 处夹具补 `rollupTokens: 0`（判据与主张都没变） |
| ② | 冻结身份检测器用**裸 `hash-object <path>`** 比工作树原始字节 ⇒ 同一次扫描里更早的汇总门刚重写过那两份证据就被判成"历史证据被改" | **探针规范化缺陷**（冤枉红；CRLF 也会这样） | 改成读**已提交内容** `rev-parse HEAD:<path>`（与同门"子树"那条同一种规范化）。**基线哈希一个都没改** —— 实测它们本来就与冻结值一致 |
| ③ | 开发者面"8 个文件自 `cfd9219` 逐字节未改" | **真实受影响面**：M6 WP5 依 ADR-050 登记扩展了开发者面（`e7d97cf`） | 拆两组冻结点：5 个仍对 `cfd9219`，那 3 个改对 `e7d97cf`，理由逐字写在代码里。**「`D-18②` 在 M5.5 当时成立」这个历史结论不改写** |

⇒ 三处修完、`m5.5:measurement:verify` 与 `m5.5:gates` 立刻转绿；按契约 §9（**量具改了 ⇒ 证据失效**）
在**新候选**上**重跑整轮**（§10.1 39 条 + INC-01 4 条 + M6 离线 12 条 + 全量回归），全部 EXIT 0 ⇒ **PASS**。

**两次证据都保留**：`m6-wp10a-976eeb302fc0/regression.json`（FAIL，含 48 步读数与红名单）与
`m6-wp10a-866f2fba5f27/regression.json`（PASS）。M6-G12「历史不改写」按这条落地。

## 硬边界与逐条读数

```text
  §10.1 39 条        全部 EXIT 0（含 typecheck / m4.5:ci / m5:* / m5.1:* / m5.1.1:* / m5.5:* / m5.5.1:* / doc:check）
  INC-01 4 条        inc-01:test · inc-01:verify(96s) · inc-01:measurement:verify(22s) · inc-01:gates —— 全 0
  M6 离线 12 条      m6:measurement:verify · wp2 · wp3-wiring · wp3-reader · wp5-console · wp6a · wp6b(182s)
                     · wp7a(72s) · wp7b(35s) · **wp8(790s)** · m6:gates —— 全 0
                     需要模型的两道（wp9a 校准 / wp9b 3×500 轮）按计划书 §WP10b 重验，本门只跑离线
  全量回归           11 步：9 步 0 · `wire-phase4b-db-v9 = 1`（**回归自己逐条写明的既有非零**：
                     两句"迁移当时"的断言在迁移后合法不成立，实测 28 行）· `m5.5.1-gates = NOT RUN`（本分支无此命令）
  白名单恢复         跑前已脏 3 条（含你的 `wp1-lease.json`）· 新增脏 15 条 · 还原后仍脏 0 · 与索引逐字一致 15/15
  真实库            回归里三个只读 opener **合法打开**真实库（各按 INC-01 状态机：租约 + 前置 verified snapshot）；
                     本门**不主张"真实库没被打开"**，只记 10 份 verified 快照目录供人工核对
```

## Deviations（全部如实登记）

1. **作业被杀过一次（harness 层）**：整门一口气跑约 2 小时、父进程里嵌 `pnpm → tsx → 孙进程` 三层时，
   Windows 作业运行器以 *"before proving its managed range empty"* 杀了整棵树（父进程停在回归那一步，
   回归连证据都没写完）。处置：改成**分块 + 续跑**（`--steps` / `--finalize`；runId 只由 HEAD 派生；
   每步读数落盘；日志异步流式写）。此后 4 批（32 条 / 15 条 / 1 条回归 / 汇总）**再没被杀过**。
2. **我自己的三处判据/检测缺陷**（都在本轮修掉，都不是放宽）：
   ① `verify-m6-wp8.ts` 的 S7 要求固定证据路径跑完必须干净，**没区分跑前是否已经脏** ⇒ 冤枉红；
   ② 本门的 R2b 把 `exitCode = null`（本分支无该命令 ⇒ `NOT RUN`）也算成"非零读数" ⇒ 冤枉红；
   ③ `m6-evidence.ts` 的 `rollup_scope_missing` 只认 `scope`/`counters` 的对象形状 ⇒ 8 道门误报
      （它们的计数在 `checks`/`totals`、范围是字符串 `scope`）。改成四种形状任一即可。
3. **一个结构性发现**（建议进 WP11 的 `M6-Known-Limitations`）：
   "只读汇总门 + 固定路径证据 + 白名单恢复"这套约定会被**旧证据误绿** ——
   白名单恢复把新鲜的 FAIL 证据还原成旧的 PASS 之后，之后跑的只读汇总门读到的是旧结论
   （同一次扫描里 `m5.5:gates` = ❌；随后的全量回归里同一命令 = ✅，因为那时证据已被还原）。
4. **遗留的一处 cosmetic 警告**：`m6:gates` 对 `wp6b-restart-recovery` 报
   `rollup_scope_missing`（它的 payload 用 `measurements` 而不是成对的 `checks`+`totals`）。
   **本轮刻意不修** —— 改它就要再动运行相关树、从而让 WP10a 的冻结失效；留给 WP10b 之后的窗口
   或 WP11 如实登记（16 道必选门全部 PASS，这条不影响判定）。
5. **NOT RUN**：WP10b（生产形状 Live + 受影响的 M5.5/M5.5.1 Live 复验）· WP11（三份报告 + `M6 = PASS/FAIL`）
   · G1-A/G1-B 真人盲审（`AWAITING HUMAN REVIEW`）。

Root-cause status: 与 INC-01 无关；INC-01 根因仍是 `PARTIAL`。
```

---

## 下一步

`WP10b`：`pnpm with-test-model pnpm m4.5:ci:full` 已在 WP10a 的回归里跑过并通过；
WP10b 还要做**本里程碑自己的实际链路验证**（生产形状 Live：真实搜索 provider / 生产库副本 /
受影响的 M5.5、M5.5.1 Live 复验），然后才进 `WP11`（三份报告 + `M6 = PASS/FAIL`）。
⚠️ WP11 **必须**分列：rev2 冻结阈值全过（WP9b PASS）与 **WP9b 里那条未达标的假记忆边界**（`findings` 已记）。
