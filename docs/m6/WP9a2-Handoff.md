# WP9a-2 Handoff —— judge 区分度修复（对比实验）与 M6-D3 rev2

```text
Completed WP:            WP9a-2（M6 / Lv1 Hardening；WP9a 的**前提修复**，用户 2026-09-21 选 A）
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp9a2-discrimination.ts           新增：本门（X/J 两节 8 项断言）
  scripts/m6-evidence.ts                              登记 `wp9a2-judge-discrimination`（必选门；`m6:gates` 变 **14** 道）
  artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/judge-discrimination.json        新增
  artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/M6-D3-thresholds-rev2.json       新增（**取代** rev1 的 judge 形态）
  docs/m6/WP9a2-Handoff.md                             本文件

**不提交（gitignored，只在本机）**：
  artifacts/m6/local/m6-wp9a2-20260921-0de5798b36a9/samples-{M3-DRF-12,M3-ADV}.json
  —— 36 条**真实回复正文**；提交的两份只有分数、比率、p 值与哈希

User-owned dirty files preserved: **原样未动、未提交**
  artifacts/incidents/inc-01/wp1-lease.json（SHA-256 仍为 BB08C5BE…）

Commands + exact exit codes:
  pnpm typecheck                                                       → EXIT 0
  pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9a2-discrimination.ts
                                                                       → EXIT 0（**8/8**；形态判定 **CONTRASTIVE ADEQUATE**）
  其中：样本档 2 个子进程（M3-DRF-12 20 条 · M3-ADV 16 条，126s）· 判分 144 次调用（699s）
  pnpm m6:gates                                                        → EXIT 0（**Hard Gates = PASS**；必选门 **14** 个）

问题（WP9a 的实测结论）:
  50/100 轮真实对话上，PC / SA / 连续性的**绝对 rubric**（0 / 0.5 / 1）全部**贴天花板**：
  本门复测 = 三个指标各 12 条真实回复，得分**全是 1.000**（mean 1.000 / σ² = 0）。
  σ²=0 ⇒ `mean − 2σ = mean` ⇒ 那样的"通过线"等于没有门。**不能**拿它当 500 轮的质量门。

实验设计（同一批真实回复，只换评分形态）:
  形态 1（现状）  绝对打分 0 / 0.5 / 1（**逐字用冻结 rubric**，从 `evals/m3/suites/long-dialogue.ts` 读出）
  形态 2（候选）  **对比式**：给她 (真, 退化) 两条候选，问"哪一条更符合这套标准"
  退化对照（确定性字符串构造，**不用模型**，只按 rubric 自己列出的反例）:
    PC  突然热情直白 + 顺从讨好 · SA  客服口吻 + 一连串感叹号 + 网络流行语 · 连续性  答非所问的客服式回答
  每个指标 12 对 × **双向**（A/B 互换）⇒ 每个指标 24 次判分；另加 12 对 **A == B** 的同一对防线。
  统计判据：单侧二项检验（H₀: 区分率 = 0.5）。

实测结果:
```text
  指标          绝对形态                          对比式形态
  PC            mean 1.000 · σ² = 0（12/12 满分）   24/24 = 1.000 · p ≈ 0 · 位置偏好 0.50 · 同一对 tie 12/12
  SA            mean 1.000 · σ² = 0（12/12 满分）   24/24 = 1.000 · p ≈ 0 · 位置偏好 0.50 · 同一对 tie 12/12
  连续性        mean 1.000 · σ² = 0（12/12 满分）   24/24 = 1.000 · p ≈ 0 · 位置偏好 0.50 · 同一对 tie 12/12
  ⇒ 形态判定 = CONTRASTIVE ADEQUATE（三个指标全部达标，不是"至少两个"）
```

M6-D3 **rev2**（取代 rev1 的 judge 形态）:
```text
  质量门形态   PC / SA / 连续性 一律改用**对比式**（真 vs 退化，双向）
  通过线       区分率 ≥ 0.75 且二项检验 p < 0.05（每个指标 24 次判分）
  两条防线     位置偏好 ∈ [0.25, 0.75] · 同一对（A == B）不得系统性选 A（理想是 tie）
  仍然有效     有效响应覆盖下限 0.98 · 硬零指标"只有 0 违规一种形态"
  失效的       rev1 里 PC/SA/连续性的 `mean − 2σ` 通过线（饱和 ⇒ 已标 MEASUREMENT INVALID）
```
  文件：`artifacts/m6/m6-wp9a-20260921-216c41e5888d/calibration/M6-D3-thresholds.json`（rev1，保留）
  与 `artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/M6-D3-thresholds-rev2.json`（rev2，**WP9b 用这份**）

Deviations or NOT RUN items:
  1. **这一轮两次都是"量具坏了"，不是"被测量对象坏了"** —— 两次都记进 rev2 的 `measurementFixes`：
     ① 第一版对比式 prompt 把冻结 rubric 原样拼上来，`{{reply}}` / `{{seedTraits}}` **原样留在 prompt 里**；
     ② 第二版解析器**先 `toUpperCase()` 再 `JSON.parse`** ⇒ 键 `pick` 变成 `PICK`，
        `parsed.pick` 恒为 `undefined`，每条都掉进兜底，而兜底里的 `\bA\b` 会匹配正文里的"候选 A"字样
        ⇒ 量出"24/24 恒选 A"的**假位置偏好**。修法：先按原样解析 JSON、只归一化**值**；
        兜底换成严格正则 `"pick"\s*:\s*"?(a|b|tie)"?`，不再用会匹配正文的模式。
     抓到它们的是 **J3（位置偏好）与 J4（同一对偏好）两条防线**，不是判据本身 ——
     这正是 `AGENTS.md` §6.2「量具自己也要被验证」的实例，也说明"橡皮图章防线"必须常设。
  2. **绝对形态的分数在两次运行间会漂**（第一次连续性 0.9167、第二次 1.000），
     但**始终贴着 1**：这是"饱和"而不是"稳定"——同一份样本换个时刻就换个数，且换不掉天花板。
  3. **`--aggregate-only` 复用样本**：判分代码改好之后没有重抓回复（样本档 126s、判分 699s），
     样本文件路径与 SHA-256 写进证据（`fixtureSource.mode = "reused"`）；默认模式会重新抓。
  4. **端点/模型**：`r.dis.115.zone` · `deepseek-v4.1-flash` · judge 温度 0.2 · 角色温度 0.3
     （与 WP9a、与 M3 live 档一致）；只记 host 与"key 存在"，不记取值。
  5. **NOT RUN**：WP9b 的 3×500 轮 · WP10a/WP10b · G1 真人盲审。
     本门**不主张她的人格好不好**，只主张"换一种评分形态之后这个 judge 能不能区分"。

Root-cause status: 与 INC-01 无关；INC-01 根因仍是 `PARTIAL`。
```

---

## 下一步（不自动开工 → 用户已选 A，WP9b 可以开工）

`WP9b — 500 轮正式长对话（3 条轨迹）`，用**rev2 的对比式判据**：

```text
轨迹（冻结名，与校准集不同源）        M6-LD-V1-daily · M6-LD-V2-correction · M6-LD-V3-identity
规模                                 3 × ≥500 个**完成**的 用户→助手 轮次（一轮不是一条消息）
检查点                               1 / 50 / 100 / 200 / 300 / 400 / 500 轮
重启                                 约 200、400 轮各一次，含至少一次新会话切换
质量门                               对比式判据（区分率 ≥ 0.75 · p < 0.05 · 位置偏好 · 同一对）
                                     + 有效响应覆盖 ≥ 0.98 + 硬零指标 0 违规
如实记录                             失败尝试 / 重试 / 完成轮次**分开记**；耗时、上下文估算量、provider usage 可得性
执行方式                             分三次 execution 跑三条轨迹（不把三段 167 轮伪称成三个 500 轮）
```
