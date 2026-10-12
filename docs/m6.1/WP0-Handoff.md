# WP0 交接单（M6.1）

> 日期：2026-09-22。格式按 [`M6.1-DSH-Execution-Plan.md`](M6.1-DSH-Execution-Plan.md) §8。
> 本单是**机器读**的交接：每条都带命令、退出码与证据路径。

## 1. 候选与运行相关树指纹

```text
仓库根             C:\Users\user\Desktop\project LG
HEAD               958c6be6a213d260d0753a637aa2480c15b8a889
分支               feature/m6-lv1-hardening
runId              m6.1-wp0-20260922-958c6be6a213-f770
runRelevantTreeSha f40dabe4698a8361286107b7474b70b86e78aab4724af7c228687ced7f4584bc
                   （before 与 after **同值** ⇒ 采样窗口内运行相关树未变）
真实库摘要         172df16f88b35b5806a4216ef99b0f7f44a71bc16726eeba264ca1e13b452cef（before/after 同值）
toolVersions       node v22.23.2 · git 2.55.0.windows.5
supersedes         m6.1-wp0-20260922-958c6be6a213-2765（判据更正 CC-1，见 M6.1-Baseline.md §6）
```

## 2. 本轮变动的文件

```text
新增（M6.1 自产）
  scripts/m6.1-evidence.ts          共享判据：门登记表 / manifest 校验 / runId / 运行目录 / 原子落盘
  scripts/m6.1-contract.ts          纯逻辑：标签集 / 类别集 / 语料判据 / 泄漏检测
  scripts/m6.1-command-surface.ts   纯逻辑：Live 守卫 + 汇总的证据选择
  scripts/m6.1-wp0-baseline.ts      WP0 基线门（before / after）
  scripts/kernel-tests-m6.1.ts      L1 部件门（60 条断言，含三段式）
  docs/m6.1/M6.1-Baseline.md        人读基线摘要
  docs/m6.1/WP0-Handoff.md          本单
点状编辑（共享文件，**只追加**）
  package.json                      追加 m6.1:test / m6.1:wp0:baseline（不改动他人条目）
新增证据
  artifacts/m6.1/component.json
  artifacts/m6.1/m6.1-wp0-20260922-958c6be6a213-f770/{baseline.json,manifest.json,source-tree-index.*.txt}
未触碰（他人未提交改动，一律保留）
  artifacts/m6.1/m6.1-wp0-20260922-958c6be6a213-2765/**（判据更正前的读数，具名保留）
  scripts/gates/** · scripts/inc-01-regression.ts · artifacts/m5*/** · AGENTS.md · README.md · …
```

## 3. 命令与退出码（逐条实测）

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | tsc --noEmit 干净 |
| 2 | `pnpm m6.1:test` | **0** | 60 通过 / 0 失败 |
| 3 | `pnpm m6.1:wp0:baseline --supersedes …-2765 --supersedes-reason "…"` | **0** | verdict `PENDING-AFTER-SAMPLE`；未知归属脏文件 **0** |
| 4 | `pnpm m6.1:wp0:baseline --out artifacts/m6.1/…-f770 --phase after` | **0** | verdict **`BASELINE CAPTURED`**；realDb `unchanged`；sourceTree `unchanged`（explained 0 / unexpected 0） |
| 5 | 同 runId 二次 `--phase before`（负控，人工验证） | 见 §5 | 必须 EXIT 2 且旧读数不变 |

## 4. 完成 / 未完成

**完成**

- 运行目录纪律：runId 唯一（候选短 hash + 日期 + 4 位随机后缀），**目录已存在即拒绝**（TD-04①）。
- 清单纪律：`.manifest.tmp` → `rename` **原子晋升**；`payloadSha256` 自摘要；中断运行判 `ABSENT`、`executed=0` 判 `INCOMPLETE`。
- 归属边界：47 条脏文件全部归类（M6.1 自产 7 / 共享 2 / 他人 38 / **未知 0**）。
- 真实库边界：**只读**内容树摘要 + mtime 观测；不取租约、不打开、不迁移、不快照。
- 偏差登记 5 条（分歧 3 条），其中 `D-1`/`D-5` 直接约束 WP5 的摘要两档设计。
- 判据更正 `CC-1` 具名登记，旧读数 `…-2765` 保留在磁盘上。
- 正文面索引：`artifacts/m6/local/**` 393 文件只记路径/大小/摘要，正文**不进 Git**。

**未完成（有意留到后续 WP，不是遗漏）**

- `m6.1:gates`（汇总门）与 `m6.1:live`（Live 守卫）本单尚未接线 —— 归属本阶段第 4 步。
- `m6.1:measurement:verify`（WP2）· `m6.1:e2e:verify`（WP5）**不提前注册空壳入口**。
- 门执行器登记（`scripts/gates/manifest.ts`）**条件性延后**：该子系统是并发会话的未提交工作，
  最近 1.5h 窗口内仍有写入（`concurrency.status = unverified-writes`）⇒ 本单不登记，登记与
  `pnpm gates:verify` 留到并发工作落定后再做（见 `M6.1-Baseline.md` §5）。

## 5. 已知失败 / 已知缺口

```text
① 判据更正 CC-1（不是失败，是"判据错了并已更正"）
   轮次 m6.1-wp0-20260922-958c6be6a213-2765
   症状 8 条真实的并发改动被记成 unknown ⇒ verdict 会被错误降成 PARTIAL（假红）
   处置 保留该轮 + 具名 supersedes；不删除、不重写
② 真实库 mtime 的解释
   最新 mtime 2026-09-22T12:11:23.171Z，1.5h 窗口内 0 个文件
   ⇒ 本阶段只能记录，**不能**解释"是谁写的"（OQ-1）
③ 并发写入不可完全归属
   concurrency.status = unverified-writes（短窗内 22 个文件的归属不在 M6.1 清单里）
   但 sourceTreeStabilityUnchanged = 1（采样窗口内未变）⇒ 采样本身有效
④ 摘要预算的继承事实
   `.env.test` 未写 CHARACTER_ROLLUP_TOKENS ⇒ 测试档继承 `.env` 的 400（D-1 + D-5）
   M6.1 **不修改**配置；WP5 必须显式覆盖
⑤ M6.1 尚未接线汇总门 ⇒ 现在**没有任何**机器命令能对 M6.1 给出整体判定
```

## 6. 正文保存位置

```text
人审材料（gitignored，不进 Git）：artifacts/m6/local/**
  本轮索引在 baseline.json 的 localEvidenceIndex：393 文件 / 8,651,502 字节 / 每文件 sha256
  WP9b 全文：artifacts/m6/local/m6-wp9b-20260921-e869f29de85d/trajectory-V{1,2,3}.detail.json
  G1-A 盲审包：artifacts/m6/local/g1-a-35415631e5bc/{windows,false-memory-probes,hard-failures}.json
```

## 7. 真实库边界（本轮逐条遵守）

```text
打开真实库            ✗ 从未（不调 initDatabase、不取租约、不建连接）
写入真实库            ✗ 从未
迁移 / 快照 / 恢复     ✗ 从未
唯一的真实库操作        digestTree() 只读内容树摘要 + statSync 只读 mtime
前后摘要               172df16f… 逐字相同（1205 文件 / 32,051,743 字节）
```

## 8. 下一 WP 入口与人工裁定

```text
下一入口   WP1 —— 判定契约与人工标注集
           交付 docs/m6.1/M6.1-Judgment-Contract.md + evals/m6.1/** + 标注工作表
需真人裁定 WP1 出口（契约 / 金标准 / 数据切分 / 量具接受标准）—— **必须**由真人批准；
           未经批准时 wp1-corpus 门的 verdict 只能是 AWAITING HUMAN REVIEW（接受集只有 FROZEN）
无需裁定 继续整理合成夹具、做归属校验、跑量具自证（计划书 §WP1 出口允许项）
禁止     在契约冻结前写生产守卫、跑正式行为达标门、改 src/**
```
