# M8 WP0 交接单 —— Admission / Baseline / 工作树隔离

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP0
> 证据：`artifacts/m8/`（runId 见下；`m8-manifest@1` 全字段清单）
> 下一站：WP1（ADR-066 语义冻结）

## 1. 交付物

| 交付物 | 位置 | 判定 |
|---|---|---|
| M8 证据纪律（runId / 运行目录 / 清单） | `scripts/m8-evidence.ts` | `m8-manifest@1`；复用 `m6.1-evidence.ts` 通用算法（一个概念一处实现） |
| 基线捕获（before/after 双相） | `scripts/m8-wp0-baseline.ts` | **BASELINE CAPTURED**（runId `m8-wp0-20260926-a82080865706-e139`） |
| 准入实验（隔离库） | `scripts/m8-wp0-admission.ts` | **PASS 13/13**（runId `m8-wp0-admission-20260926-a82080865706-2892`） |
| package.json 脚本 | `m8:wp0:baseline` / `m8:wp0:admission` | 点状追加（共享文件纪律） |

## 2. 基线事实（WP0 时刻的工作区真相）

```text
分支        feature/m7-relationship（= main，同指 a820808）
HEAD        a8208086570639daffbf33d2e049800729514ea3
标签        m7-complete 在册（早于其后文档/TD-06 修订 —— 计划 §1.3 的读取规则适用）
源码树      1556 文件 / 25,544,914 字节（sha256 63a251acc3569445…）
真实库      1208 文件 / 32,436,767 字节（treeSha256 f65531b1322f340c…，只读摘要）
脏文件      m8-self=5 · shared(package.json)=1 · concurrent-known=21 · regenerated=55 · unknown=0
.env        CHARACTER_RELATIONSHIP_CONTEXT_ENABLED=true（M7 激活态，ADR-065）
            CHARACTER_AFFECT_CONTEXT_ENABLED 不存在（B6 —— 激活属 WP9 独立裁定）
```

**真实库从未被打开**：四次基线捕获（e044/6e15/e139-before/e139-after）的真实库树摘要
**逐字相同**（`f65531b1322f340c387886c4…`），覆盖整个 WP0 包括准入实验。
准入实验自身声明 `realDbOpened: false`（`isolateDatabase('m8-wp0-admission')` 一次性沙箱）。

## 3. 准入结论（六命题）

| 命题 | 结论 | 量具 |
|---|---|---|
| P1 M7 前置状态可读且不矛盾 | ✅ `pnpm m7:gates` EXIT 0（判定门 13/13 PASS） | 只读汇总子进程（不重算 M7 判定） |
| P2 M8 上下文槽位未漂移 | ✅ `SECTION_PRIORITY.affect === 52` · `ContextSectionKind` 含 `'affect'` | 静态代码事实（S1/S2） |
| P3 生产面干净 | ✅ `.env*` 无 `CHARACTER_AFFECT_*`；代码未登记该开关 | 静态（S3） |
| P4 零迁移前提成立 | ✅ 通用形状承载 `affect:character`：正控（事件一次落库 / 投影读回逐字段一致 / 水位前进 / job 创建）+ 负控（重放 0 新建 / 旧乐观锁 `projection_revision_conflict` / 水位回退 `watermark_regression` / job 复用） | 隔离库实验（E1–E7） |
| P5 命名无碰撞 | ✅ `affect:character` / `affect-evaluator` 在 src/** 执行位置零占用（processor.ts:11 的命中是 M2.5 预留名单的**注释**，不算占用） | 静态（S4，注释行过滤后） |
| P6 表清单在册 | ✅ 五张通用表（projections / domain_events / processed_operations / watermarks / jobs）都在既有迁移 0001–0009 | 静态（S5） |

**P4 的含义**：M8 按计划 §8.4 走「优先复用通用持久化形状」路线的**前提已被实验证明**。
WP4 若发现确需新迁移，按计划立即停在设计门（`M8 database migration = NONE` 是首选判定）。

## 4. 量具缺陷修正记录（如实登记，FAIL 中间档留档）

| runId | 缺陷 | 修正 |
|---|---|---|
| `m8-wp0-…-e044`（baseline） | B4 分类器缺 `artifacts/m4-acceptance/` 再生前缀 ⇒ unknown=1 | 前缀补进 `REGENERATED_EVIDENCE_PREFIXES`；e044 留档，6e15 取代 |
| `m8-wp0-admission-…-9d18` | E3 用 `JSON.stringify` 比对 state —— JSONB 不保键序，读回一致被误判 false（数据无差异，量具误报）；S4 把 processor.ts 的**注释**预留名单当成命名占用 | E3 改逐字段比对（键序无关）；S4 过滤注释行后再搜。9d18 留档，2892 取代 |
| `m8-wp0-…-6e15`（baseline） | 量具修正发生在窗口内 ⇒ A8（源码树同值）会被自己的修正误触 | 以稳定量具重开窗口（e139 取代 6e15）；真实库摘要链跨全部 run 可比对，覆盖不变 |

三条都是**量具缺陷**，不是链路行为问题；被测对象（通用持久化形状 / 工作树 / 真实库）
在修正前后行为一致。

## 5. 工作树纪律（计划 §1.2 的执行记录）

- 并发已知（INC-01 / 门执行器 / M6.5 / M7 收口后证据）**登记、未清理、未接管**；
  `artifacts/m7/` 的未跟踪 run 从 M8 视角归「并发已知」。
- M8 自产文件（`scripts/m8-*` · `docs/m8/` · `artifacts/m8/` · 未来的
  `docs/adr/ADR-066-affect-state-evolution.md`）归 `m8-self`。
- 共享文件只动 `package.json`（点状追加 2 行 scripts）。

## 6. 给 WP1 的输入

1. **全部六命题成立** ⇒ 按计划 §10 WP1 进入 ADR-066 语义冻结，无准入阻塞项。
2. 冻结时必须写进 ADR 的既有事实：
   - `affect:character` 投影作用域键已被实验验证可承载（P4）；
   - `SECTION_PRIORITY.affect = 52`（M3 预留位，低于 relationship 的 55）；
   - 开关名沿用 `CHARACTER_AFFECT_CONTEXT_ENABLED`（代码缺省 **false**，WP9 才谈激活）；
   - 处理器名 `affect-evaluator` / `affect-evaluator@1`（processor.ts 预留名单一致）。
3. M7 文档状态漂移按计划 §1.3 处理：以 ADR-065 / Gate-Decision §6 修订节为当前事实，
   不改写 M7 冻结文档。
