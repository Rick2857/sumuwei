# M6 · WP4 Handoff（量具资格化与命令面）

> 分支 `feature/m6-lv1-hardening` · 被测代码提交 `aab3859`
> 证据：`artifacts/m6/m6-wp4-20260921-aab3859a9058/measurement.json`（**46/46**）· `artifacts/m6/m6-gates-20260921-aab3859a9058/gate-results.json`（**Hard Gates PASS**）
> 出口状态：**`HARNESS QUALIFIED`**（量具会响、汇总不掺水、入口纪律可断言）

---

## 1. 当前 WP / 状态

| 已做 | 未做（刻意） |
|---|---|
| 四个命令入口全部落地（计划书 §9.1） | **没有**实现任何 Live 套件（属 WP9a/WP9b/WP10b） |
| 计划书 §WP4 的 **8 类注入**逐条处置（实现 / 部分实现 / N/A 且给理由） | **没有**跑任何真实模型或搜索 |
| 量具资格化门：**46 项断言**（9 条注入 × 三段式 + 覆盖表 + 命令面守卫） | **没有**打开真实库 |
| 只读汇总门：缺文件 = `NOT RUN`，可接受判决由登记表给出 | **没有**改任何既有门的判据或冻结面 |
| `.gitignore` 按 §9.2 声明本地长日志与**合成对话评审包**路径 | 没有把对话正文写进仓库 |

---

## 2. 交付物

| 文件 | 职责 |
|---|---|
| `scripts/m6-evidence.ts` | **共享校验**：门登记表、manifest 16 字段校验、摘要证据校验、两个独立检测器（不可得写成 0 / 轮数与重复）、落盘证据读取 |
| `scripts/m6-command-surface.ts` | **纯判定**：`--suite` 选择、离线套件的"无模型/搜索面"审计、Live 三条守卫 |
| `scripts/m6-verify.ts` | `pnpm m6:verify --suite <parts|wiring|reader|all>`（显式选择；不偷偷调用模型/搜索） |
| `scripts/m6-measurement.ts` | `pnpm m6:measurement:verify`（量具资格化） |
| `scripts/m6-live.ts` | `pnpm m6:live --suite <smoke|calibration|long-dialogue>`（守卫齐全；套件尚未实现 ⇒ 如实拒绝） |
| `scripts/m6-gates.ts` | `pnpm m6:gates [--write]`（只读汇总） |
| `scripts/run-with-test-model.ts` | 追加 `DSH_TEST_MODEL_WRAPPER=1` 子进程标记 |

**库 / 外壳分离**（照仓库既有惯例：`m3.5-prompt-baseline.ts` 只有库、外壳另置）：纯判定不含 `process.argv`/`process.env`/`spawn`/`exit`，
因此量具门可以**直接 import 并逐条断言**它们会拒绝。

---

## 3. 8 类注入的逐条处置

| # | 注入 | 处置 | 检测器（问题码） |
|---|---|---|---|
| 1 | 0 条用例 / 退出码 0 但 `skipped` | 实现 | `manifest_zero_counts` · `manifest_skipped_silently` |
| 2 | 旧提交结果、默认路径旧 FAIL 与新 runId PASS 混淆 | 实现 | `manifest_stale_commit` |
| 3 | `expected=search` 正例同时进"禁止出站"集合 | **N/A** | 属 M5.5.1（`m5.5.1-corpus-audit.ts` 是那份清单的唯一来源）；在此实现会造出第二份清单 |
| 4 | `usage` 不可得写成 0 ／ 搜索与模型调用混计 | **部分**：前半实现，后半 N/A | `unavailable_written_as_zero`；混计属 M5.5.1（M6 离线证据不产生出站调用） |
| 5 | **已选择但被裁掉仍计为"实际入模"** | 实现 | `chosen_but_not_injected` |
| 6 | **缺失正例时"永远不摘要"就能过门** | 实现 | `rollup_no_positive_example` |
| 7 | 断点重复输入重复写入 / 只跑 50 轮标 500 | 实现 | `round_count_mismatch` · `duplicate_turns` |
| 8 | 坏回复被重试后的好回复覆盖 / 故意丢弃失败轮次 | **部分**：丢弃实现，重试 N/A | `manifest_failed_runs_dropped`；"重试"是 WP10b 的 Live 才有的动作 |

**N/A 的纪律**：每条 N/A 都带 `reason` + `ownerGate`（量具门断言"必须都有"）。
另有覆盖表断言：**声明的覆盖码必须真的在负控里响过**（`§2-4`）——
因此"纸面覆盖"不可能大于"实际响过"。

---

## 4. 命令与读数

| 命令 | 退出码 | 读数 |
|---|---|---|
| `pnpm typecheck` | **0** | 0 错误 |
| `pnpm m6:measurement:verify` | **0** | `PASS — 46/46 通过，失败 0，MEASUREMENT INVALID 0` |
| `pnpm m6:gates --write` | **0** | `Hard Gates = PASS`（必选门 5 个 · 未运行 0 · 未通过 0） |
| `pnpm m6:verify --suite parts` | **0** | `m6:verify = PASS`（spawn 路径实测；parts 门 59/59） |
| `pnpm m6:verify`（不给 `--suite`） | **2** | `suite_required`（拒绝默认全跑） |
| `pnpm m6:live --suite smoke`（未经包装器） | **2** | `wrapper_required`（绝不回落到 `.env` 原 key） |

**`m6:gates` 的 5 个必选门**：WP0 基线（`BASELINE CAPTURED`）· WP2 部件门（59/59）· WP3 接线门（27/27）· WP3 读取面门（25/25）· WP4 量具门（46/46）。

---

## 5. 沙箱 / 真实库边界

| 读数 | 值 |
|---|---|
| 真实库 | **未打开**（量具门与汇总门都是纯函数；读取面门用**隔离库**） |
| 模型调用 / 搜索 / 出站 | **0 / 0 / 0**（`m6:verify` 的登记表审计静态断言离线脚本不含这些调用面） |
| 冻结面 | `artifacts/m5/**`、`artifacts/m5.1/**`、`artifacts/m4.5/**`、`src/kernel/contracts/developer-*.ts` 等**均未改**；本轮没有跑会写它们的门 |

---

## 6. 新发现（四条，两条是**我自己造成的**）

| ID | 发现 | 处置 |
|---|---|---|
| **F-20** | 我用 **PowerShell 写含中文的 `.gitignore`** ⇒ 文件乱码（AGENTS §7 早就写明这条坑，我还是踩了）。`git checkout HEAD --` 还原后用 `edit` 工具重做 —— 靠**hash 前后对照**发现（还原前 `BDE6934D…` vs 还原后 `8513B4C0…`） | 已还原并重做；本轮"唯一一次自造数据损坏"登记在此 |
| **F-21** | `m6-verify.ts` / `m6-live.ts` 的 CLI 外壳写在**模块顶层**并 `process.exit` ⇒ 量具门 import 时会**在 import 阶段死掉**，且死因与它要测的东西无关 | 拆成"库 + 外壳"（`m6-command-surface.ts` 无副作用） |
| **F-22** | 量具门里有一条断言（注入覆盖数 ≥ 6）写在**后面的注入跑完之前** ⇒ 自造假红：断言早于它要数的东西 | 移到全部注入之后，并改成"覆盖表 + 声明码必须真的响过" |
| **F-23** | `m6:gates` 一开始用 `verdict === 'PASS'` 统一判定，于是 WP0 的 `BASELINE CAPTURED` 被当成失败 ⇒ **假红**；若反向放宽则会出现假绿 | 把"可接受判决"写成登记表字段（`acceptVerdicts`），由登记表说了算 |

---

## 7. 偏差

| # | 内容 |
|---|---|
| **B-18** | `m6:live` **只有守卫、没有套件**（套件属 WP9a/WP9b，最终候选 Live 属 WP10b）。登记表里 `implemented: false`，且量具门断言"当前没有任何 Live 套件已实现"—— 那条断言在实现落地时会**主动变红**，提醒更新 |
| **B-19** | 证据按 runId **累积、不覆盖旧的**（§9.2）；`m6:gates` 取每个门的**最新**一份。代价是目录会增长；缓解：只有 JSON 进 git，长日志与评审包走 `.gitignore` |
| **B-20** | 3 条注入声明为 N/A 并给出理由与归属门（M5.5.1 / WP10b）。**没有**为了凑满 8 条而在 M6 里重造别的里程碑的清单 |
| **B-12（沿用）** | 量具 `runId` 随 `HEAD` 漂移 ⇒ 每次改代码后重跑会新增目录、旧目录需显式作废。已在 WP3 登记；WP10a 前应改为"显式 runId" |

---

## 8. 没有扩大的主张

- 没有主张任何 Live 套件可运行（三条都 `implemented: false`，入口一律如实拒绝）；
- 没有主张"量具 46 项全绿 ⇒ 产品正确"（它证明的是**检测器会响**，不是**系统无缺陷**）；
- 没有主张 `m6:gates` 等于 M6 的最终判定（它只汇总**已落盘**的 5 个门；M6-G1/G5/G6/G7/G8/G11 的载体还没实现）；
- 没有主张摘要已生产启用（`rollupTokens` 仍缺省 **0**）。

---

## 9. 下一包

**下一包按依赖选一个**（两条互不阻塞）：

| 选项 | 内容 | 前置 |
|---|---|---|
| **WP5（开发者面）** | 让 Console/CLI 能读回"摘要选了什么、拒绝理由分布、是否被裁"；复用既有 `/dev/query/*` 与生产者登记表 | 无（WP3 已接线） |
| **WP6a（降级与动作真相）** | 故障注入：读取面失败 / 预算不足 / 模型失败时的诚实降级；与搜索/动作五态对齐 | 无 |
| **WP6b（重启与恢复）** | 关闭 / 快照 / 恢复的集成验收 | **BLOCKED**：INC-01 WP3/WP4/WP5 未落地 |

**STOP 点**：本 WP4 到此 STOP。下一个包开工前必须先跑 `pnpm m6:gates` 确认 5 个必选门仍全绿（它是只读的，秒级）。
