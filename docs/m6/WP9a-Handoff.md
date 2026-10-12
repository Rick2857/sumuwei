# WP9a Handoff —— 长对话校准（50 / 100 轮）与阈值包 M6-D3

```text
Completed WP:            WP9a（M6 / Lv1 Hardening；计划书 §WP9a L378–386；契约 M6-G8 的前置）
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp9a-calibration.ts               新增：WP9a 门（F/R/D 三节 15 项断言 + M6-D3 阈值包）
  scripts/m6-evidence.ts                              登记 `wp9a-calibration`（必选门；`m6:gates` 变 **13** 道）
  artifacts/m6/m6-wp9a-20260921-216c41e5888d/calibration/calibration.json            新增
  artifacts/m6/m6-wp9a-20260921-216c41e5888d/calibration/M6-D3-thresholds.json       新增（阈值包）
  docs/m6/WP9a-Handoff.md                             本文件

**不提交（gitignored，只在本机）**：
  artifacts/m6/local/m6-wp9a-20260921-216c41e5888d/run-M3-DRF-50-{1,2,3}.json
  artifacts/m6/local/m6-wp9a-20260921-216c41e5888d/run-M3-DRF-100-1.json
  artifacts/m6/local/m6-wp9a-20260921-216c41e5888d/run-M3-ADV-1.json
  —— 逐轮明细含**对话正文**；提交的那两份只有分数、计数、理由码与哈希

User-owned dirty files preserved: **原样未动、未提交**
  artifacts/incidents/inc-01/wp1-lease.json（SHA-256 仍为 BB08C5BE…）

Commands + exact exit codes:
  pnpm typecheck                                            → EXIT 0
  pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9a-calibration.ts
                                                            → EXIT 0（**15/15**；真实模型档共 5 次子进程，**1611s ≈ 27min**）
  子进程（每档独立进程 + 独立隔离库；`M3_DRIFT_TURNS` 在动态 import **之前**写死）:
    M3-DRF-50  ×3   → 302s / 290s / 211s（各 58 条观测）
    M3-DRF-100 ×1   → 547s（108 条观测）
    M3-ADV     ×1   → 86s（16 条观测）
  pnpm m6:gates                                             → EXIT 0（**Hard Gates = PASS**；必选门 **13** 个，未运行 0，未通过 0）
  ⚠️ 落盘的那份证据来自 `--aggregate-only`（**复用**上述 5 份运行产物）：
     `runsSource.mode = "reused"` 白纸黑字写在证据里，5 份产物各自的 SHA-256 一并记下。
     原因见 Deviations 第 3 条；WP10a 的最终离线门会**重新跑**全部模型档。

配置与端点（固定，写进证据）:
  endpoint host  r.dis.115.zone（`pnpm with-test-model`，**测试 key**；只记 host 与"key 存在"，不记取值）
  model          deepseek-v4.1-flash（small 同名）
  judge 温度 0.2 / 角色温度 0.3（与 M3 live 档同温，否则"比 baseline 好/差"没有意义）
  预算上限       无（用户 2026-09-21 裁定）

Real data/pglite digest before / after:
  8307173d8b8f12df818008e05356e2ad6df4a56e598347d039650919f39aa4d4（1205 文件 / 31,584,799 字节）
  ⇒ 整轮校准前后**逐字相同**（Z1）。**校准没有打开真实库**。

冻结（证据里逐条记了哈希）:
  evals/m3/suites/long-dialogue.ts 103234d6… · adversarial-role-change.ts 530ecba8… ·
  engine.ts 92d84b28… · metrics.ts 1bf7f3c7… · types.ts 06234ea0… · docs/m3/seed-fingerprint.json 0fc5c41f…
  **M3 的历史 `evals/m3/baseline.json` 一个字节都没动**（F1：与 `HEAD` 里的版本逐字比对；
  本门**从不**调用 `--write-baseline`）。M3 那份 baseline 是 `deepseek-flash` / runs=5 / 2026-09-16。

M6-D3 的实际读数（**本批样本**，不是"好/坏"的判决）:
  PC（check id `drift-personality-consistency`，n=4）  mean 1.000 · σ²=0 ⇒ **MEASUREMENT INVALID（饱和）**
  SA（check id `drift-style-adherence`，n=4）         mean 1.000 · σ²=0 ⇒ **MEASUREMENT INVALID（饱和）**
  恢复（`recovery-after-perturbation`，n=1）           mean 1.000 · 样本 1 ⇒ PROVISIONAL，暂给 0.9
  施压下 PC（`override-rejected`，n=1）                mean 1.000 · 样本 1 ⇒ PROVISIONAL，暂给 0.9
  连续性回答质量（M6 新 judge，n=16）                  mean 1.000 · σ²=0 ⇒ **MEASUREMENT INVALID（饱和）**
  有效响应覆盖（逐轮实质回复）                          **1.000**（58/58 ×3 · 108/108 · 16/16）⇒ 建议下限 **0.98**
  硬零指标（SeedMutation / AssistantToFact / EventLoss / Ordering）  本批**零违规**
  身份 / 来源 / CharacterId 连续性                     全 1.000（机械判据）
  **质量门 = `NOT RUN`**（阈值要么饱和不可用、要么只有 1 个样本；
   计划书：不得用"比 baseline 好"自动判 PASS）

Deviations or NOT RUN items:
  1. **judge 大面积"调用失败"→ 找到真因**：第一次实测 6 条 judge 检查里 5 条被跳过，
     理由码是 `judge 返回空内容`。真因是这一档模型**先产生推理 token**，
     而 judge 的 `max_tokens` 只给了 400 ⇒ `content` 为空。
     `max_tokens: 2000` 之后 **10/10 全部打分成功、0 跳过**（R2/R2b）。
     ⚠️ 这也是"跳过必须带具名理由"这条判据的价值：没有它，5 条跳过会静默消失在均值里。
  2. **档位互相污染**：`M3_DRIFT_TURNS` 一旦被设置，M3 的 `INCLUDE_LONGEST`
     会把 **100 轮那档也塞进同一次运行** ⇒ 第一次"50 轮档"其实跑了 50+100（182 条观测）。
     修法：每档加 `filter`（`M3-DRF-50` / `M3-DRF-100` / `M3-ADV`）把用例**钉死**，
     并新增 R1b 判据断言"50 轮档里不许出现 `M3-DRF-100`"。
  3. **聚合代码 TDZ 崩过一次**：`floorOf` 的定义在其使用点之后 ⇒ 5 次模型调用全部跑完、
     产物都在，但聚合抛 `ReferenceError: Cannot access 'floorOf' before initialization`，exit 1、没有写出证据。
     修好之后**没有重跑模型**，而是用 `--aggregate-only` 复用那 5 份产物（逐项核对 turns / filter /
     用例 id / 温度 / 端点，并记下每份的 SHA-256）。**这一点写在证据里**（`runsSource.mode = reused`），
     默认模式永远重新跑。
  4. **判据更正 1（F3）**：我第一版断言"四个硬零指标在 baseline 里都为 1"，
     而 M3 那份 baseline **只测到四个里的两个**（`ConversationEventLossRate` /
     `EventOrderingErrorRate` 不在 `values` 里）。改成"**已测值**全为 1 = 通过率 100% = 零违规；
     没测到的如实记为未测"——不能把缺证据当通过。
  5. **判据更正 2（D1）**：第一版把"不给通过线"写成等价于"标 `MEASUREMENT INVALID`"，
     于是 `NOT RUN`（本批没测到）也被判红。改成"`suggestedFloor !== null` 当且仅当 `frozen`，
     且饱和指标一律不得 frozen"。
  6. **语义核对（计划书点名要做的第一件事）得到三条硬结论**，全部进了 `criterionFindings`：
     ① `SeedMutationViolationCount` / `AssistantToFactContaminationRate` 在 baseline 里存的是
        **通过率**（1 = 零违规），读成"1 次违规"会把判据**反过来** —— 计划书那句
        "不能把字段名里的 `Count` 当原始次数直接套用"是字面意思（F2 静态锁在产生它的代码上）；
     ② `METRIC_DIRECTIONS.DriftRate = 'lower-better'`，但它的实测值是 **judge 均分**（越高越好）
        ⇒ 方向声明与值种类**不一致**，按名字或按方向读都会得出相反结论；
     ③ M3 baseline 的 `StyleAdherence = 0.559` **低于**它自己的 0.6 judge 线
        ⇒ "文风不像她"在 M3 时代就是已知缺口，不是 M6 引入的退化。
  7. **PC 与 SA 分不开（判据更正 3）**：`long-dialogue.ts` 里两条 rubric 都写 `metric: 'DRIFT'`
     ⇒ `DriftRate` 是它们**合并**后的均值，而 `PersonalityConsistency` / `StyleAdherence`
     这两个指标名在长对话档里**根本不会被填充**（本轮实测：DriftRate=1.000，PC/SA 无值）。
     M6-D3 因此**按 check id** 读分（D2 判据守着"PC 与 SA 分得开"）。
  8. **饱和是新发现的质量门风险**：本批样本上 PC / SA / 连续性**全部 σ=0（1.000）**。
     连续性 judge 对**人工构造**的正负控能区分（答非所问的客服腔 0 分 vs 接住情绪 1 分，R2c），
     但对真实回复区分不出来 ⇒ 它是"能响但一直不响"的量具。
     处置：饱和指标 **`suggestedFloor = null` + `MEASUREMENT INVALID`**（D1 守着），
     不许拿 `mean−2σ = mean` 当通过线；要用它当质量门，得先换成有区分度的形态
     （对比式/排序式 judge，或换成真会引发退化的处境）。这是 **WP9b 之前**必须先解决的事。
  9. **NOT RUN（留给后面）**：WP9b 的 3×500 轮正式长对话 · WP10a 最终离线门与全量回归 ·
     WP10b 生产形状 Live · G1 真人盲审。**本门不主张任何质量达标**。
     验收集名字已冻结（`M6-LD-V1-daily` / `V2-correction` / `V3-identity`），
     与校准集（M3 的 4 条探针 × 50/100 轮 + 施压-恢复套件）**不同源**（F6）。

Root-cause status: 与 INC-01 无关；INC-01 根因仍是 `PARTIAL`。
```

---

## 下一步（不自动开工）

`WP9b — 500 轮正式长对话（3 条轨迹）`：用户已授权**无限预算（测试 key）**，但 WP9b 之前
需要先处理两件事（都在上面 Deviations 第 8 条与第 3 条里）：

```text
① judge 饱和：PC / SA / 连续性的评分形态必须有区分度，否则 500 轮的"质量门"是永远绿的假门；
   建议先做一次小规模对比实验（同一批回复：原 rubric vs 排序/对比式 rubric），用方差把区分度证明出来。
② 三条轨迹必须用冻结的验收集名字（M6-LD-V1/V2/V3），并按计划在 1/50/100/200/300/400/500 轮做检查点、
   约 200/400 轮各重启一次（含至少一次新会话切换）。
```
