# M6 门判定（Gate Decision）

> 里程碑：**M6 / Lv1 Hardening**（Rolling Summary 的**来源边界**）
> 本文件是 M6 的**判定载体**：由已落盘证据汇总出的状态与**允许的主张**。
> 事实见 [`M6-Acceptance-Report.md`](M6-Acceptance-Report.md)；局限见 [`M6-Known-Limitations.md`](M6-Known-Limitations.md)。
> 契约 [`M6-Acceptance-Contract.md`](M6-Acceptance-Contract.md) 与 [`ADR-050`](../adr/ADR-050-rolling-summary-provenance-boundary.md) 均为 `DESIGN FROZEN`，**本文件不改它们**。

---

## §0 判定（**先列全部阻塞原因，再给 overall**）

```text
M6（本计划冻结范围内的工程与自动化验收） = **PASS**
  依据：`pnpm m6:gates` → 必选门 **17** 个 · 未运行 **0** 个 · 未通过 **0** 个 · **Hard Gates = PASS**（EXIT 0）
        `pnpm typecheck` → EXIT 0
        计划书 §10.1 的**离线清单 32 条** → **32/32 EXIT 0**（另有 Live 清单 4 条，见 WP9a/WP9b/WP10b）
        `inc-01:regression:verify` → EXIT 0 · verdict PASS（2823s，含 m4.5:ci:full）
        WP10b production-copy Live → **12 通过 / 0 失败**（含两道受影响的 Live 复验都 EXIT 0）
```

**必须分列的四件事**（不许合成一个总分）：

| 轴 | 状态 | 谁判 |
|---|---|---|
| `M6`（工程与自动化验收） | **PASS** | WP10/WP11 + `m6:gates` |
| `G1`（含人工复核的综合验收） | **PARTIAL**（人工复核已完成，2026-09-22） | G1-A/G1-B · 结论见 [`G1-Acceptance-Report.md`](G1-Acceptance-Report.md) §7 |
| `Original Lv1 Requirements` | **PARTIAL**（状态演化延期至 M7） | 契约 §2 矩阵 |
| WP9b 的"假记忆边界" | **NOT MET**，且该性质的探测器 **INVALID** | WP9b + 人工核对原文 |

**阻塞原因清单（当前为空）**：无必选门未通过、无必选门未运行。
**但下列项仍**未完成**（不是阻塞 M6 的工程判定，而是**缩小主张**）：

```text
① G1 = **PARTIAL**（人工复核已完成 2026-09-22）⇒ 不得声称"综合验收通过"
② 假记忆边界未守住 + 探测器 INVALID ⇒ 不得声称"她在 500 轮里守住了记忆边界"
③ 摘要生产激活未裁定（rollupTokens 缺省 0）⇒ 不得声称"摘要已在真实聊天里工作"
④ `m6:live` 套件未实现 · 性能 SLA 未冻结 · 换模型实验 NOT RUN
⑤ M5.5.1 收口未做（P-1 仍开放）
```

---

## §1 逐门汇总（判定表）

| 门 | 判定 | 通过/失败 | 证据 |
|---|---|---|---|
| `wp0-baseline` | `BASELINE CAPTURED` | 0 / 0 | `artifacts/m6/m6-wp0-20260921-1165fedcdde2/baseline.json` |
| `wp2-rollup-unit` | PASS | 59 / 0 | `artifacts/m6/m6-wp2-20260922-866f2fba5f27/rollup-unit.json` |
| `wp3-wiring` | PASS | 27 / 0 | `artifacts/m6/m6-wp3-20260922-866f2fba5f27/wiring.json` |
| `wp3-reader` | PASS | 25 / 0 | `artifacts/m6/m6-wp3-reader-20260922-866f2fba5f27/reader.json` |
| `wp4-measurement` | PASS | 46 / 0 | `artifacts/m6/m6-wp4-20260922-14120f7e890b/measurement.json` |
| `wp5-console` | PASS | 21 / 0 | `artifacts/m6/m6-wp5-20260922-866f2fba5f27/console.json` |
| `wp6a-faults` | PASS | 28 / 0 | `artifacts/m6/m6-wp6a-20260922-866f2fba5f27/faults.json` |
| `wp6b-restart-recovery` | PASS | 15 / 0 | `artifacts/m6/m6-wp6b-20260922-866f2fba5f27/restart-recovery.json` |
| `wp7a-e2e` | PASS | 17 / 0 | `artifacts/m6/m6-wp7a-20260922-866f2fba5f27/e2e.json` |
| `wp7b-e2e` | PASS | 25 / 0 | `artifacts/m6/m6-wp7b-20260922-866f2fba5f27/e2e.json` |
| `wp8-scale` | PASS | 24 / 0 | `artifacts/m6/m6-wp8-20260922-866f2fba5f27/scale.json` |
| `wp8-retrieval-boundary` | PASS | 24 / 0 | `artifacts/m6/m6-wp8-20260922-866f2fba5f27/retrieval-boundary.json` |
| `wp9a-calibration` | PASS | 15 / 0 | `artifacts/m6/m6-wp9a-20260921-216c41e5888d/calibration/calibration.json` |
| `wp9a2-judge-discrimination` | PASS | 8 / 0 | `artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/judge-discrimination.json` |
| `wp9b-long-dialogue` | PASS | 22 / 0 | `artifacts/m6/m6-wp9b-20260921-e869f29de85d/long-dialogue.json` |
| `wp10a-final-offline` | PASS | 10 / 0 | `artifacts/m6/m6-wp10a-866f2fba5f27/regression.json` |
| `wp10b-live` | PASS | 12 / 0 | `artifacts/m6/m6-wp10b-6cdd34e7960d/live.json` |

**契约 M6-G0…G12**：全部 PASS（对应关系见验收报告 §2.1）。
⚠️ 契约里 M6-G6 那一行带着 WP0 时代的 `BLOCKED` 标注（当时 P-2 未满足）；**该标注已被 WP6b 的证据取代**（15/15 + 6 条子门全 EXIT 0，且 `src/main.ts` 现已接线 INC-01 的租约→快照→token 链）。契约是 `DESIGN FROZEN`，**本文件不改它的字**，只在此说明状态演进。

---

## §2 允许的主张（**逐条有机器读数支撑**）

```text
✅ 摘要的**来源边界**成立：只有 ESTABLISHED 且作用域正确的用户来源能入选；
   助手 / tool / system / 外部证据 / 跨会话 / 无受信信封 / contradictedOrigin / 记忆已失效 —— 一律**具名拒绝**
   （WP2 59/59：11 条注入逐条被具名理由拒绝，五类拒绝理由**全部**被真的触发过）
✅ "选了 ≠ 入模"：被预算裁掉的摘要**不在** packet.sections 里，且 trace 如实记 dropped（WP3 ①-8/①-9）
✅ R-2 成立：空摘要 ⇒ packet.text 与**不接摘要**时**逐字节相同**；冻结 prompt 基线 sha256 047c6c96…4ea4b6 **一字节未动**
✅ 预算账目恒等式：记忆 + 预留 + 外部证据 + 摘要 = 计划总额（M6 起多一格）（WP2 ⑤-4）
✅ 读取面**只读**：读一次前后相关表行数完全不变（WP3 读取面 ⑧-1）
✅ 摘要**不落库**：同一源重建逐字一致（WP6b D2 + WP3 读取面）
✅ 重启/关闭/恢复链上的保护措施有效：损坏快照被拒、恢复失败保留 quarantine、强杀后租约确实释放、closed=true（WP6b 15/15）
✅ 规模下重放逐字段一致、不膨胀、不物理覆盖、失效不入模、上下文受预算约束（WP8 24/24）
✅ 500 轮有效且**rev2 冻结阈值**全过：3×500 完成 · 区分率 1.000（p≈0）· 位置偏好 0.49–0.50 · 有效响应 500/500（WP9b）
✅ 上下文不随轮数增长：检查点 1→500 的 packet 估算量 1196–1199 token · 3 section · 0 裁剪
✅ 行动与搜索真相：无"未执行却宣告成功"；出站次数/目标/来源与账本及回复对应（WP6a + WP10b）
✅ 真实链路隐私边界：trace 里**没有**用户原话；摘要正文不进 trace/遥测/账本（WP3 ②-3/③-5 + WP10b G4）
✅ 生产形状下**接线就位但默认不激活**：`rollup_*` 键零个、无 `rolling-summary` section（WP10b G2/G3）
✅ 真实库**未被试验打开**：所有真实库读数都是"只复制"或"只读 opener"，摘要前后逐字相同
```

---

## §3 **不**主张（**逐条点名**，防止越界）

```text
❌ **不**主张"她在 500 轮里守住了假记忆边界" —— 该边界 **NOT MET**，且探测器 **INVALID**（Known-Limitations §1）
❌ **不**主张"摘要已经在真实聊天里工作" —— 生产 `rollupTokens` 缺省 **0**，激活属独立裁定（§2 的"接线就位但默认不激活"）
❌ **不**主张"综合验收通过" —— G1 = **PARTIAL**（人工复核已完成；未达项见 G1-Acceptance-Report §7.2）
❌ **不**主张"原始 Lv1 全部完成" —— `Original Lv1 = PARTIAL`（状态演化延期至 M7）
❌ **不**主张"她记得住所有记忆" —— 同一 subject 下记忆数 > 50 时，可排序的选择集是最近 50 条（Known-Limitations §3）
❌ **不**主张"自然语言遗忘在大库上总能命中目标" —— 规模下会被具名拒绝（Known-Limitations §4）
❌ **不**主张"搜索稳定可用" —— 冻结三元组依赖 `duckduckgo`，会被反爬/网络层挡住（Known-Limitations §5）
❌ **不**主张"性能 SLA 达标" —— SLA **未冻结**，本里程碑不判
❌ **不**主张"跨午夜她真的理解了隔了一天" —— WP7b 只测挂钟事实与三通道分列
❌ **不**主张"LLM judge 等于人工已审" —— 契约明文禁止
❌ **不**主张 INC-01 根因已定 —— 根因仍 `PARTIAL`；WP6b 只做集成验收
❌ **不**主张"只读汇总门绿 = 被测对象当时绿" —— 旧证据误绿是实测过的结构性风险（Known-Limitations §6.1）
```

---

## §4 G1 入口（**独立综合验收包**）

```text
前置：M6 自动门通过（✅ 本文件 §0） + **综合验收授权**（需用户）
G1-A 盲审材料：
  · A–E 每类 ≥3 条完整合成多轮轨迹，共 **≥15 条**；每条至少 1 个正控 + 1 个易失败点
  · 从 500 轮正式轨迹抽取**预先约定的**窗口；所有机械硬失败**一并纳入**（不能只选成功演示）
  · 材料只用**合成公开夹具**；真实对话或搜索正文**不得**为方便审阅写进 Git / telemetry / 外部评测服务
G1-B 结论（需**真人**评分）：
  · 逐项输出：工程硬门 / 行为质量 / 人工评审 / **原始 Lv1 差异**
  · 阈值依 WP9a **冻结版本**（rev2），**不得看过答卷再调分**
阻断项：任何 P0 不变量违例 · 假成功动作 · 跨用户认知污染 · 未授权真实库写入
（**契约通则**，非当前状态）没有真人评分时：G1 保持 **AWAITING HUMAN REVIEW**；**LLM judge 不得填充"人工已审"**。当前：人工复核**已完成**，G1 = **PARTIAL** ⇒ 见 §0 与 G1-Acceptance-Report §7
```

**G1 必须独立于 M6 的自动门**：M6 的 PASS **不**蕴含 G1 的结论；G1 也**不**能反过来改写 M6 的机器读数。

---

## §5 本轮**不自动做**的事

```text
合并到 main · 打 `m6-complete` 标签 · 开 auto_public · 真实库迁移/恢复 · M7 开工
—— 计划书 §WP11 明文：M6 完成**不自动做**这些；已明确获得授权才执行并记录。
本轮**没有**获得这些授权 ⇒ 只交具体候选结果。
```

---

## §6 判定所依据的命令（可复现）

```bash
pnpm typecheck                                        # EXIT 0
pnpm m6:gates                                         # 必选门 17 · 未运行 0 · 未通过 0 · Hard Gates = PASS（EXIT 0）
pnpm m5.5:gates                                       # Hard Gates PASS（G1–G5 全绿，复核"旧证据未被覆盖"）
pnpm m6:measurement:verify                            # 46/46 通过 · MEASUREMENT INVALID 0
pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp10b-live.ts   # 12/0 · PASS（EXIT 0）
pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9b-long-dialogue.ts  # 22/22 · PASS（≈99min）
```
