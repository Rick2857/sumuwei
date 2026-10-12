# WP0 交接单（M7）

> 日期：2026-09-26。格式按 [`M6.1-DSH-Execution-Plan.md`](../m6.1/M6.1-DSH-Execution-Plan.md) §8（M6.1 的 WP0 交接单同款）。
> 本单是**机器读**的交接：每条都带命令、退出码与证据路径。

## 1. 候选与运行相关树指纹

```text
仓库根             C:\Users\user\Desktop\project LG
HEAD               33d0c08eefc34f1bed121e1297955d09375eda7a（= main，M6.1 收口提交）
分支               feature/m7-relationship（自 main 新建；未动 main）
基线 runId         m7-wp0-20260925-33d0c08eefc3-b322
源码树摘要         d9534a2407f7f2b2…（before 与 after 同值，1521 文件 / 24,920,850 字节）
真实库摘要         c49ac7f7c22fcdeb…（before 与 after 逐字相同，1207 文件 / 32,354,847 字节）
toolVersions       node v22.23.2 · git 2.55.0.windows.5
准入 runId         m7-wp0-admission-20260925-33d0c08eefc3-6e14
```

## 2. 本轮变动的文件

```text
新增（M7 自产）
  scripts/m7-evidence.ts           M7 证据纪律：runId / 运行目录 / m7-manifest@1 全字段清单（L-M61-14 对策）
  scripts/m7-wp0-baseline.ts       WP0 基线门（before / after 两相；脏文件归属分类）
  scripts/m7-wp0-admission.ts      TD-08/09 准入实验（隔离库；事件区间读 vs 记忆检索对照）
  docs/m7/M7-WP0-TD-Reception.md   TD-06/07/16 接收记录 + TD-08/09 准入结论 + M6.1 残余风险表
  docs/m7/M7-WP0-Admission.md      准入实验报告（命题 / 读数 / 结论 / 不主张清单）
  docs/m7/M7-WP0-Handoff.md        本单
点状编辑（共享文件，只追加）
  package.json                     追加 m7:wp0:baseline / m7:wp0:admission（不改动他人条目）
新增证据
  artifacts/m7/m7-wp0-20260925-33d0c08eefc3-b322/{baseline-before.json,baseline-after.json,manifest.json}
  artifacts/m7/m7-wp0-admission-20260925-33d0c08eefc3-6e14/{admission.json,manifest.json}
未触碰（他人未提交改动，一律保留）
  AGENTS.md · README.md · .gitignore · scripts/gates/** · scripts/gates-run.ts ·
  scripts/verify-gate-runner.ts · scripts/verify-cli-exit-latency.ts · scripts/inc-01-regression.ts ·
  src/infrastructure/runtime/guard-timers.ts · docs/incidents/** · docs/adr/ADR-051* ·
  docs/m6.5/** · docs/苏沐薇-使用说明.txt · docs/m6/M6-DSH-Execution-Plan.md ·
  artifacts/incidents/** · artifacts/{m4.5,m5,m5.1,m5.5,m5.5.1,m6,m6.1}/** 的再生/遗留证据
```

## 3. 命令与退出码（逐条实测）

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | tsc --noEmit 干净（含三个新脚本） |
| 2 | `pnpm m7:wp0:baseline --phase before` | **0** | verdict `PENDING-AFTER-SAMPLE`；脏文件归属 m7-self=4 · shared=1 · concurrent=15 · regenerated=52 · **unknown=0** |
| 3 | `pnpm m7:wp0:admission` | **0** | **PASS 9/9**（P1 种子正控 · M1–M5 区间读测量 · S1–S3 静态代码事实）；沙箱库，真实库未打开 |
| 4 | `pnpm m7:wp0:baseline --out artifacts/m7/m7-wp0-20260925-33d0c08eefc3-b322 --phase after` | **0** | verdict **`BASELINE CAPTURED`**；真实库前后逐字相同；源码树同值；unknown=0 |

## 4. 完成 / 未完成

**完成**

- 干净基线：before/after 两相采样，真实库内容树摘要前后逐字相同（唯一强失败条件未触发）。
- 脏文件归属分类：全部 72 条具名归属（m7-self / shared-appended / concurrent-known / regenerated-evidence），
  **unknown = 0** ⇒ 混合树被如实描述而非降档（与 M6.1 的 PARTIAL 分列，见 TD-Reception §3）。
- TD-06/07/16 接收记录：按 TD 表 §5 格式，每项有正式编号、所属 WP、前置条件、验收材料、状态、剩余限制。
- TD-08/09 准入实验：**NOT BLOCKING**（9/9）；设计约束三条待冻结进 ADR-064。
- M6.1 残余风险表：L-M61-01…15 逐条处置。
- `m7-manifest@1` 全字段清单契约从第一个运行器起生效（L-M61-14 对策落地）。

**未完成（有意留到后续 WP，不是遗漏）**

- `m7:gates`（汇总门）与 `m7:test`（L1 部件门）**不提前注册空壳入口**——随 WP2 合同落地再接线。
- TD-06 定义冻结（WP1）、TD-07 最小核验（WP6 preflight）、TD-16 收口对账（WP7）——已排期，未开工。
- AGENTS.md 的 M6.1/M7 状态行：文件被并发会话持有，**不碰**；收口阶段一并处理（L-M61-12）。

## 5. 已知失败 / 已知缺口

```text
① 基线跑在混合工作树上（L-M61-11 的延续）
   并发 INC-01 / 门执行器会话的 15 个未提交文件 + 52 个再生证据路径在案；
   本轮全部具名归属（unknown=0）⇒ 判定 BASELINE CAPTURED；
   但"纯候选 = 已提交链"的纪律照旧：M7 的行为证据以后续已提交链上的运行为准。
② 真实库摘要与 M6.1 时期不同（172df16f… → c49ac7f7…，1206 → 1207 文件）
   这是 M6.1 收口之后真实使用（真实聊天）的正常演化，不是本轮写入——
   本轮唯一的主张是"WP0 采样窗口内前后逐字相同"（A6 ✅）。
③ 准入实验的 250 条是路径形状测量，不是规模性能（TD-17 窗口）；
   也不重跑 M6 WP8 的检索截断读数（S1 只核对切片行仍在）。
```

## 6. 真实库边界（本轮逐条遵守）

```text
打开真实库            ✗ 从未（不调 initDatabase、不取租约、不建连接）
写入真实库            ✗ 从未
迁移 / 快照 / 恢复     ✗ 从未
唯一的真实库操作        digestTree() 只读内容树摘要 + statSync 只读 mtime（基线脚本内）
准入实验               isolateDatabase() 一次性沙箱库（keep:false，用后即弃）
前后摘要               c49ac7f7c22fcdeb… 逐字相同（1207 文件 / 32,354,847 字节）
```

## 7. 下一 WP 入口与人工裁定

```text
下一入口   WP1 —— 关系语义与 ADR
           交付 docs/adr/ADR-064-m7-relationship-semantics.md（草案已随本 WP 备好）
           + docs/m7/M7-Unresolved-Decisions.md（未决决定清单）
需真人裁定 WP1 出口（关系键 / 维度 / 证据等级 / 提案机制 / 时间语义 / 行为接线 / 初始基线来源
           —— 见 Unresolved-Decisions 的 U-M7-01…07）—— **必须**由真人批准后才冻结；
           未经批准时 ADR 状态保持 DRAFT / AWAITING ADJUDICATION，不得据此实现 WP2 合同
无需裁定   继续整理 ADR 的既有事实引用、约束表核对（FC-05 / ADR-018 / 认知完整性五不变量）
禁止       在 ADR 冻结前写关系合同代码、改 src/**、跑正式行为达标门
```
