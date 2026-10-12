# M9 WP0 交接单 —— Baseline / Admission / 工作树隔离

> 状态：**DONE**（2026-09-27）
> 计划：[`M9-Execution-Plan.md`](M9-Execution-Plan.md) §13 WP0（基线与前置核对）
> 证据：`artifacts/m9/`（runId 见下；`m9-manifest@1` 全字段清单）
> 下一站：**WP0-R**（L-M8-13 M7 双缺陷修复——准入实验已完整复现，欠账先还）→ WP1（ADR-070 语义冻结）

## 1. 交付物

| 交付物 | 位置 | 判定 |
|---|---|---|
| M9 证据纪律（runId / 运行目录 / 清单） | `scripts/m9-evidence.ts` | `m9-manifest@1`；复用 `m6.1-evidence.ts` 通用算法（与 m8-evidence 同形品牌层） |
| 基线捕获（before/after 双相） | `scripts/m9-wp0-baseline.ts` | **BASELINE CAPTURED**（runId `m9-wp0-20260927-481523f7a7d3-79e7`，9/9） |
| 准入审计（静态 + 隔离实验） | `scripts/m9-wp0-admission.ts` | **ADMISSION PASS 25/25**（runId `m9-wp0-admission-20260927-481523f7a7d3-4819`） |
| package.json 脚本 | `m9:wp0:baseline` / `m9:wp0:admission` | 点状追加（共享文件纪律） |

## 2. 基线事实（WP0 时刻的工作区真相）

```text
分支        feature/m7-relationship
HEAD        481523f7a7d3ad635791618ac4050b23bcb1d7d7（基线锚定提交；其后仅证据/文档提交）
标签        m8-complete / m8.5-complete 在册
源码树      1671 文件 / 27,591,877 字节（sha256 d1dd87e4464d4ddf…）
真实库      1208 文件 / 32,436,767 字节（treeSha256 eb401e1aebebd677…，只读摘要）
脏文件      m9-self=1（准入 run 目录）· shared=0 · concurrent=0 · regenerated=0 · unknown=0
.env        CHARACTER_RELATIONSHIP_CONTEXT_ENABLED=true · CHARACTER_AFFECT_CONTEXT_ENABLED=true
            · CHARACTER_AFFECT_SEMANTIC_MODE=semantic（M8.5 激活态，ADR-069）
            · CHARACTER_BELIEF_ENABLED 不存在（B6 —— 激活属 WP11 独立裁定）
```

**真实库从未被 M9 打开**：全部基线采样与准入实验期间，真实库树摘要逐字相同
（`eb401e1aebebd677e9e233ba779b096310a2a0151aa01c5fdc77206186457a12`）。
准入实验自身 `isolateDatabase('m9-wp0-admission')` 一次性沙箱（keep:false）。

### 2.1 真实库摘要相对 M8 收口的变化（如实分列，不是 M9 所为）

M8/M8.5 收口读数 `f65531b1322f340c387886c4…` → M9 基线读数 `eb401e1aebebd677…`
（文件数同为 1208）。归因：**M8.5 生产激活之后、M9 开工之前，用户有过真实对话**
（mtime 证据：最新写入 2026-09-27T05:56:11Z，基线捕获前约 1 小时；2 小时窗口内
27 个文件被写过）。这是用户对自己记忆库的正当使用；M9 全程不开真实库，
两个读数各有归属、互不覆盖（M8 收口读数按历史保留）。

## 3. 准入结论（PRE-01…PRE-10，机器读数）

| PRE | 结论 | 量具 |
|---|---|---|
| PRE-01 基线与共享树 | **PASS** | baseline B1–B6 / A7–A9（9/9） |
| PRE-02 L-M8-13 M7 双缺陷 | **DEFECT CONFIRMED —— WP0-R 修复欠账**（阻断范围：三域联合验收之前） | S1/S2 代码事实 + E1b/E2a–E2c 复现链 |
| PRE-03 TD-08 召回规模 | **NOT BLOCKING**（belief 两条读路径均不经召回窗口） | E3a（1000 样本位置 1/50/51/500/501/最老全可读）+ E3b（域事件流全量可见）+ S11 对照面 |
| PRE-04 TD-09 歧义遗忘 | **NOT BLOCKING**（具名拒绝闸健康；"信念不猜目标"进 WP1/WP5 设计约束） | S10（target_ambiguous 命中 ⊆ 已知清单，含 M4.5 action 定义点） |
| PRE-05 L-M61-04/05 长尾 | **NOT BLOCKING for belief 依赖回查**（按 ID 读到当前状态）；长尾行为发现保持登记 | E4a（supersede 后旧值=superseded、active 只剩新值）+ E4b（retract 后=retracted） |
| PRE-06 src/state 兼容窗口 | **ACCEPTED BOUNDARY**（M8 off 回退保留；Belief 不读旧情绪字段——WP1 冻结读取策略） | S12 |
| PRE-07 M8 人审 | **ACCEPTED BOUNDARY → 2026-09-27 修订：已出结果 PASS**（用户声明式裁定；M9 自己的人审仍不得借用 M8 结论；三域共同措辞进 M9 场景） | 文档读数（M8-Gate-Decision §4/§6 分列 + U-01 关闭读数） |
| PRE-08 FC-T05 阶段锁 | **NOT BLOCKING**（锁在场；WP1 记录交接、WP2 落地等强判据） | S7 |
| PRE-09 M6.1 聚合门 | **NOT BLOCKING**（mtime 最新聚合读数 overall=PASS，2026-09-27；L-M61-14/15 残余保持登记） | S13 |
| PRE-10 生产安全 | **PASS**（INC-01 工具链在场；M9 WP0 全程未打开真实库） | S14 |

**PRE-02 复现链**（隔离库，全部真实生产函数）：

```text
E1a 对照   纯用户消息窗口 ⇒ 调度器完整返回（flushed，不抛）
E1b 缺陷a  tool 事件进窗口 ⇒ processorEventViewOf 抛 tool_event_not_extractable_in_m4
           且 dry-run 在 try 之外 ⇒ 异常穿透 maybeRunRelationshipEvaluation
           （违反其"幂等且不抛"契约；main.ts:1419 裸调 ⇒ 异常可及聊天链路）
E2a job级  markRunning 之后 runRelationshipEvaluation 抛同码
E2b 缺陷b  失败后 job 行楔在 running（catch 不 finishJob('failed')）
E2c 楔死   同窗重试：enqueue 返回旧 running 行（created=false）⇒ markRunning 抛
           job_not_pending ⇒ 该窗口永久无法重处理、水位永不前进
           （M8 因 catch 里 finishJob 而有 L-M8-14 两步自愈，M7 没有）
```

## 4. 量具校准记录（如实登记，FAIL/PARTIAL 中间档留档）

| runId | 缺陷 | 修正 |
|---|---|---|
| `m9-wp0-admission-…-32cb`（21/25） | S5 逐字空格与 DDL 排版耦合；S10 已知清单漏了 action/errors.ts + policy.ts 两个**定义点**；S13 按固定路径找聚合读数（聚合器实际写进第一个 --manifest 的 run 目录）；S14 脚本名猜错（`inc-01-gates.ts` 非 `verify-inc-01-gates.ts`） | S5 改容忍间距正则；S10 补录定义点；S13 改找最新 gate-results.json；S14 改实际名。32cb 留档 |
| `m9-wp0-admission-…-dba2`（24/25） | S13 按**目录名字典序**挑"最新" ⇒ 选中 09-25 的 REFUSED 历史档（目录名里的日期夹在 wp 名中间，字典序 ≠ 时间序） | 改按**文件 mtime** 挑最新。dba2 留档，4819 取代 |
| `m9-wp0-…-26ad`（baseline PARTIAL） | before/after 窗口跨了 WP0 自身的两次量具校准提交（4807bfb/481523f）⇒ A8 如实红（源码树变化 = 自己的提交，非并发污染；B4/A9 unknown=0 佐证） | 以稳定代码重开紧窗口（79e7 取代 26ad，`--supersedes` 记录接续关系）；真实库摘要链跨全部 run 可比对，覆盖不变 |

三条都是**量具校准**，不是链路行为问题；被测对象（M7 双缺陷 / 按位读 /
更正-遗忘可见性 / 工作树 / 真实库）在修正前后行为一致。

## 5. 工作树纪律（计划 §1.2 的执行记录）

- WP0 时刻工作树干净（脏文件仅 M9 自产 run 目录，`artifacts/m9/` 前缀如实归属）。
- M9 自产前缀：`scripts/m9-*` · `docs/m9/` · `docs/adr/ADR-070-*`（未来）· `artifacts/m9/`。
- 共享文件只动 `package.json`（点状追加 2 行 scripts）。
- 提交切分：证据品牌层（589d40e）/ WP0 门（6cd8c6c）/ 校准（4807bfb、481523f）/
  证据（ec7b593）各自独立提交。

## 6. 给 WP0-R / WP1 的输入

1. **PRE-02 修复欠账先还**（WP0-R，独立维护提交）：
   - 修复对象三处：`relationship/job.ts:191`（裸转 map）、
     `relationship-scheduler.ts` `qualifiedUserEvents`（同款裸转）、
     `relationship-scheduler.ts` catch（不落 failed）。
   - 参照形状 = M8 的两处修复：affect/job.ts 的 `filter((e) => e.actorType !== 'tool')`
     + affect-scheduler.ts catch 的 `finishJob(db, job.id, 'failed', { error, now })`
     （finishJob 自身失败吞掉，主错误优先）。
   - **保持 M7 攒尾窗策略不变**（零提案窗口持有到 R-1 累积 / 2000 上限强制消费——
     与 M8 的"每窗必消费"不同，这是 M7 的设计不是缺陷）。
   - 恢复路径三态都要有复现矩阵：enqueue 前失败（dry-run 抛）/ finish 失败 /
     completed 后 watermark 失败（L-M8-14 两步自愈形状）。
   - 修后跑 M7 相关门 + typecheck；E1/E2 场景翻绿（缺陷不再复现）由
     `m9:wp0r:verify` 出证据。
2. **WP1 冻结时必须写进 ADR 的既有事实**（本 WP 实验读数）：
   - 通用投影表承载 belief 零迁移可行（S5：PK (character_id, projection_type)、
     全 text 列、relationship 先例把作用域编进 projectionType ⇒ `belief:<beliefId>`）；
   - `SECTION_PRIORITY.belief = 50`（M3.5 预留位，低于 affect 52 / relationship 55）；
   - BELIEF_* 事件名无长度约束（`character_domain_events.type` 为 text）；
   - belief 依赖回查组合 = `store.get(id)` + `qualificationsForMemories`（零新增 SQL，S16）；
   - 域事件流缺下界读法（S15）：带水位的 reconciler 需要 `afterSequence` 追加读法
     （冻结区"只允许追加能力"，WP3/WP4 落地，走对应门）；
   - 开关名 `CHARACTER_BELIEF_ENABLED`（代码缺省 off，WP11 才谈激活）。
3. **FC-T05 交接**（S7）：WP1 在 ADR-070 记录交接决定；WP2 建 `contracts/belief.ts`
   时把 future-compat-tests.ts 的存在性锁替换为语义边界断言
   （CHARACTER_INTERNAL 作用域 / perspectiveOwnerId 必填 / WORLD 拒绝）。
4. **真实库新基线**：`eb401e1aebebd677…`（1208 文件）是 M9 期间的"未打开"参照摘要；
   后续 WP 的 A7 判定以各 run 自身的 before/after 为准（不与 M8 历史读数比）。
