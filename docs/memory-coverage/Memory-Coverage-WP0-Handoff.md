# 「记忆体量」WP0 交接单（基线 + 覆盖率量具 + 语料）

> **日期**：2026-09-30 · **阶段**：`Memory-Coverage-Execution-Plan.md` 的 **WP0**
> **授权**：用户 2026-09-30 显式授权「先授权 WP0：基线 + 覆盖率量具 + 语料」
> （该计划的状态是 `DRAFT / 未获执行授权` ⇒ **本文只覆盖 WP0**；WP1 及以后**仍未获授权**）
> **性质**：纯离线 · **不打开任何数据库** · 不调模型 · 不碰真实库 · **未改任何生产代码路径**
> **读数**：[`Memory-Coverage-Baseline-Report.md`](Memory-Coverage-Baseline-Report.md)（判定 **PASS**，43 条 / 一致 43）
> ⚠️ **本单是 WP0 当时的交接**（语料 rev 2 · 43 条）。之后语料到 **rev 5（47 条）**，
> 当前读数（可达 **27** · 写入 **27** · 登记表可达 **16 / 21**）以**门**为准；本单**不回写**。

---

## 1. 六项交接（计划 §17.2 的格式）

| 项 | 内容 |
|---|---|
| **修改路径** | **新增**：`scripts/memory-coverage-evidence.ts`（证据装配）· `scripts/memory-coverage-verify.ts`（门 / 量具）· `evals/memory-coverage/corpus/memory-coverage-corpus.jsonl`（语料 43 条）· `evals/memory-coverage/corpus/manifest.json`（冻结清单）· 本单 · 基线报告 · `artifacts/memory-coverage/**`（4 个 run）。**改动**：`scripts/gates/manifest.ts`（新增 `MC_GATES` + `memory-coverage` lane + 并入 `ALL_GATES`）· `scripts/gates/affected-map.ts`（memory 行加门 + 新增语料行）· `package.json`（**点追加 1 行**）· `.gitattributes`（钉 `evals/memory-coverage/**` 为 LF）· `AGENTS.md` §5 的 memory 行（加这道门）。**未改**：`src/**` 的任何行为（只被 import，未被修改） |
| **基线提交** | `1593e1ac`（基线证据）· 量具/语料：`7c2dbc72` + `91f776ad` + `720d00fb` |
| **接口版本** | 契约 `memory-coverage-contract@1` · 语料 `memory-coverage-corpus@1`（**rev 2**）· 量具 **`memory-coverage-instrument@2`** · 门 id / npm 脚本同名：**`memory-coverage:verify`** · `lane = memory-coverage` · `dbKind = not-applicable` |
| **测试命令 / 退出码** | `pnpm memory-coverage:verify` → **0**（43/0）· `pnpm typecheck` → **0** · `pnpm gates:verify` → **0**（**51 项 / 0 失败**，含 G1「每个门 id 都有同名 npm 脚本」与 G2「argv 里的 `.ts` 真实存在」）· `pnpm m9.5:gates` → **0**（未被本轮翻转） |
| **已知未完成** | §3（本单**不**含 WP1 的任何工作）· 语料是**抽样**不是总体 · 取值质量观察（基线报告 §4.4）**只登记未修** · 假阳 / 写入结果 / 端到端**未测**（要库） |
| **下一消费者** | **你**（`C-1`…`C-7` 七条裁定 —— 见 [`Memory-Coverage-Execution-Plan.md`](Memory-Coverage-Execution-Plan.md) §2）；裁定后由 **WP1**（扩线索表）接手，基线报告 §4.3 的 7 条"够不着的登记表例子"是现成的待办清单 |

---

## 2. WP0 做了什么（逐条对计划 §3 的 WP0）

| 计划要求 | 状态 | 落在哪 |
|---|---|---|
| ① 冻结"体量"的定义与基线，三道闸门**分开计数不折叠** | ✅ | 闸门分布 5 类（`extracted` 19 / `content_unresolved` 15 / `intent_not_detected` 6 / `content_empty` 2 / `not_remember_intent` 1）；逐条读数见基线报告 §4.2 |
| ② 新语料，**必须含规则抽不出的说法**，且**不得对着实现调参** | ✅ | 43 条，六种 `provenance` 逐条写明；负控①专门证明"只含规则能抽的语料"会被拒（§5） |
| ③ 量具三段式（正控 / 负控 / 恢复）+ `measured_count > 0` 自检 | ✅ | 正控 43/43 · 负控①如实报分辨力不足 · 负控②报出故意写错 · 恢复逐字段相同 · 自检 PASS |
| ④ 基线读数入库（含 FAIL 档如实入库） | ✅ | 4 个 run **一个都没删**，各自可分辨（基线报告 §7） |
| 门登记进 `scripts/gates/` 的清单与 lane | ✅ | `MC_GATES` + `memory-coverage` lane + `affected-map` 两行；`pnpm gates:verify` 51/0 |

⚠️ **计划没要求、但做了两件事**（都如实登记）：
1. **`.gitattributes` 钉 LF + 摘要归一化**（CRLF → LF）：语料 sha256 是**冻结判据**，
   而本机 `core.autocrlf = true` ⇒ 不钉的话"别人 clone 之后这道门必 FAIL"。
   这是仓库**已有的**同类教训（`artifacts/**` 与 `evals/m6.1/**` 早就钉了）；
   已实测往返（删文件 → `git checkout --` → 仍是 LF、归一化摘要不变）。
2. **`AGENTS.md` §5 的 memory 行加了这道门** —— `affected-map.ts` 是 §5 的投影，
   §5 是权威源（该文件自己逐字写着"两边不一致时以 §5 为准"）⇒ 两边必须同步。

---

## 3. 已知未完成 / 本单**不**主张

```text
· 不含 WP1 的任何工作：本单**没有**动 `content-extractor.ts` 的线索表、**没有**翻任何开关
· 语料是**抽样**：43 条覆盖了"登记表声明的例子 + 已具名的欠账 + 两道闸门的构造探针"，
  但**不**等于真实对话的分布 ⇒ 本门**不产覆盖率百分比**
· 取值质量：基线报告 §4.4 登记了 5 条"可达但取值可疑"（含一条单字取值「的」），
  **只登记、未修** —— 取值边界归 ADR-056 / `m6.1:extractor:repro`，混着修正是两条线都禁止的
· 写入结果 / 假阳 / 端到端**未测**：它们要库与真实对话流 ⇒ 属隔离库预演（WP1/WP4）
· 后台路径（闸门①）**不在本门范围**：NOT-WIRED，按 `C-3` 建议明确排除（归 TD-19）
· 不主张 `M4 D2-A` 已解决、不主张 `TD-22` 关闭、不主张扩覆盖的方向已定（那是 C-1…C-7）
```

---

## 4. 复现与消费

```bash
pnpm memory-coverage:verify                      # 本门（退出码 0 = PASS · 3 = FAIL / MEASUREMENT INVALID）
pnpm gates:run --lane memory-coverage            # 走统一调度器（本 lane 目前只有这一道门）
pnpm fast                                        # 改 src/kernel/app/memory/** 或 evals/memory-coverage/** 时自动带出
```

⚠️ **改语料 = 必须有意重刷 `corpus/manifest.json` 的 `corpusSha256`**，否则门会 FAIL
（这正是冻结闸的用途：不许语料悄悄变）。重刷时**应当**在 `revisions` 里追加一条
（旧 hash / 改了什么 / 为什么 / 证据在哪），就像本单的 rev 1 与 rev 2 那样。

⚠️ **`registry_*` 组的期望是特征化**：它们是"本次基线实测"，不是"应当可抽"的规范性主张。
⇒ 一旦抽取器改好，它们**会报红** —— 那是**有意的**（强制回来更新语料，见
`L-M95-09` 的"修好则两处报红"同款纪律）。
