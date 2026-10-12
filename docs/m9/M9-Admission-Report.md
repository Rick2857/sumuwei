# M9 准入报告 —— PRE-01…PRE-10 逐项判定

> 判定日：2026-09-27
> 量具：`pnpm m9:wp0:admission`（runId `m9-wp0-admission-20260927-481523f7a7d3-4819`，**25/25，ADMISSION PASS**）
> 基线：`pnpm m9:wp0:baseline`（runId `m9-wp0-20260927-481523f7a7d3-79e7`，**BASELINE CAPTURED 9/9**）
> 计划依据：[`M9-Execution-Plan.md`](M9-Execution-Plan.md) §4.1（十项准入）· §4.2（PRE-02 修复欠账）· §4.3（实验设计）
> 交接单：[`M9-WP0-Handoff.md`](M9-WP0-Handoff.md)

**总判定：ADMISSION PASS。** 十项准入无一项 BLOCKED；
PRE-02 为**已确认缺陷**（复现链完整），修复欠账归 WP0-R——
按计划 §4.1 不阻断 M9 开工，阻断范围是三域联合验收。

---

## PRE-01 基线与共享树 —— PASS

- 量具：baseline before/after 双相（B1–B6 / A7–A9），9/9。
- 真实库树摘要窗口内逐字相同（`eb401e1aebebd677…`）；脏文件归属分类 unknown=0。
- 首跑 PARTIAL（窗口跨自身校准提交）已由紧窗口 run 取代（`--supersedes` 接续，
  首跑留档）——详见交接单 §4。

## PRE-02 L-M8-13（M7 关系评估器双缺陷）—— DEFECT CONFIRMED，WP0-R 修复欠账

**这不是阻断项，是"欠账确认"**：计划 §4.2 要求 M9 开工前先把 L-M8-13
从"潜伏登记"升级为"已复现、已定位、修复方案已定"。

### 复现链（隔离库，全部真实生产函数）

| 步 | 读数 | 证明 |
|---|---|---|
| E1a 对照 | 纯用户消息窗口 ⇒ `maybeRunRelationshipEvaluation` 完整返回（flushed） | 窗口本身可处理 |
| E1b 缺陷 (a) | tool 事件进窗口 ⇒ `tool_event_not_extractable_in_m4` **穿透**调度器 | `job.ts:191` 裸转 + **dry-run 在 try 之外**（调度器"幂等且不抛"契约被违反；`main.ts:1419` 裸调 ⇒ 异常可及聊天链路） |
| E2a job 级 | `markJobRunning` 之后 `runRelationshipEvaluation` 抛同码 | 缺陷 (a) 的 job 级位置 |
| E2b 缺陷 (b) | 失败后 job 行楔在 `running` | 调度器 catch 只 `return {kind:'failed'}`，从不 `finishJob('failed')` |
| E2c 楔死证明 | 同窗重试：`enqueueJob` 返回旧 running 行（created=false）⇒ `markJobRunning` 抛 `job_not_pending` | 该窗口**永久**无法重处理、水位永不前进。M8 因 catch 里 `finishJob` 而有 L-M8-14 两步自愈，M7 没有 |

### 与 M8 修复的对照（S3/S4：参照形状在场）

- `affect/job.ts`：`filter((event) => event.actorType !== 'tool')` 先滤后转；
- `affect-scheduler.ts` catch：`finishJob(db, job.id, 'failed', { error, now })`
  （finishJob 自身失败吞掉——主错误优先）。

### 修复范围（WP0-R）

三处生产位置：`relationship/job.ts:191`、`relationship-scheduler.ts`
`qualifiedUserEvents`（同款裸转）、同文件 catch（不落 failed）。
**保持 M7 攒尾窗策略不变**（零提案窗口持有到 R-1 累积 / 2000 上限强制消费——
这是 M7 的设计，与 M8 的"每窗必消费"不同）。
恢复路径三态复现矩阵：enqueue 前失败 / finish 失败 / completed 后 watermark 失败
（L-M8-14 两步自愈形状）。

### 今天为什么是潜伏而非事故

生产无 tool 事件写入者（`recordToolOutput` 无生产调用方），且失败可由尾窗增长
自愈——但 M9 的三域联合验收会同时驱动三个评估器，不能第三次踩同一坑。

## PRE-03 TD-08（召回规模窗口）—— NOT BLOCKING

- **E3a**：1000 条隔离样本（越过 51/501 两档），位置 1/50/51/500/501/最老
  全部按 ID 可读（`store.get` 不经召回排名的 50/250/500 窗口）。
- **E3b**：`MEMORY_CREATED` 域事件流全量可见（1000/1000，`domainEventsFor`
  无窗口截断）——belief-memory reconciler 的源流不受 TD-08 影响。
- **S11 对照面**：召回排序前 `filtered.slice(0, query.limit)` 仍在——
  **召回路径**的限制保持登记（TD-08 不因本读数销账）；
  belief 的两条读路径（按 ID / 域事件流）都不走那层。

## PRE-04 TD-09（歧义遗忘）—— NOT BLOCKING

- **S10**：`target_ambiguous` 命中文件集 ⊆ 已知清单（含 M4.5 action 域的
  **定义点** `errors.ts`/`policy.ts`——首轮量具漏记，校准补录）。
- 歧义 = 具名拒绝 + 澄清，无批量删、无猜测改；闸门健康。
- **进 WP1/WP5 的设计约束**：信念的 dispute/supersede/retract 同样
  "不猜目标"——`mayMutate()` 闸（只 resolved ∧ confidence ∈ {exact, strong}）
  的纪律原样继承。

## PRE-05 L-M61-04/05（长尾侵蚀）—— NOT BLOCKING for belief 依赖回查

- **E4a（更正）**：supersede 后按 ID 回查读到 `superseded`、槽位 active 只剩新值
  ——belief 的依赖回查看到的是**当前事实**。
- **E4b（遗忘）**：retract 后按 ID 回查读到 `retracted`——
  "Belief 不得绕过 Memory 遗忘"（INV-M9-06）的依赖失效信号在按 ID 读路径上如实可见。
- **分层归因**：L-M61-05 的侵蚀发生在**召回排名层**（旧值在上下文里复活），
  belief 的依赖回查不走那层；长尾**行为**发现保持登记，不因本读数冒充已关闭。

## PRE-06 src/state 兼容窗口 —— ACCEPTED BOUNDARY

- **S12**：`src/state` 目录在场（M8 off 回退保留）。
- 边界：Belief **不读**旧情绪字段（读取策略在 WP1/ADR-070 冻结）；
  src/state 的退役裁定（M8-to-M9-Handoff 遗留项）不因 M9 开工自动执行。

## PRE-07 M8 人审 —— 2026-09-27 修订：已出结果（PASS）

- **原读数（WP0 准入当时）**：M8 Human Review = PENDING（材料在 `artifacts/m8/local/`，
  gitignore）⇒ 记为 **ACCEPTED BOUNDARY**（不阻断设计/实现/离线门）。
- ✅ **2026-09-27 修订**：M8 Human Review = **PASS**（用户声明式裁定"已审、无异议"；
  记录载体 `artifacts/m8/local/blind-review-record.md`，裁决归档 M8-Gate-Decision §4）
  ⇒ 该边界不再需要"接受"。
- **纪律不变**：M9 不得借用 M8 的人审结论；M9 自己的人审独立进行；
  三域共同措辞（信念 × 关系 × 情绪）进 M9 场景设计。

## PRE-08 FC-T05 阶段锁 —— NOT BLOCKING

- **S7**：future-compat-tests.ts 的"contracts 下无 belief 文件"存在性锁在场。
- 交接是**已排工作**：WP1 在 ADR-070 记录交接决定；WP2 建 `contracts/belief.ts`
  时把存在性锁替换为**语义边界断言**（CHARACTER_INTERNAL 作用域 /
  perspectiveOwnerId 必填 / WORLD 拒绝）——锁的职责从"不存在"升级为"真不变量"。

## PRE-09 M6.1 聚合门 —— NOT BLOCKING

- **S13**：mtime 最新聚合读数 `overall=PASS`（2026-09-27，`1227f72`，4 必选门）。
- L-M61-14（发射侧已修）/ L-M61-15（混合树）残余保持登记。
- 量具校准备忘：聚合器把 gate-results.json 写进**第一个 --manifest 的 run 目录**，
  且"最新"必须按文件 mtime 判（目录名字典序会选中 09-25 的 REFUSED 历史档）。

## PRE-10 生产安全 —— PASS

- **S14**：INC-01 工具链齐备（`snapshot-db.ts` / `restore-db.ts` / `inc-01-gates.ts`）。
- M9 WP0 全程未打开真实库（基线只读摘要 + 隔离沙箱实验）；
  需要数据副本的测试走既有 INC-01 流程。

---

## 附：量具校准史（防篡改纪律：中间档全部留档）

| run | 结果 | 说明 |
|---|---|---|
| `m9-wp0-admission-…-32cb` | 21/25 FAIL | 首轮：四条静态检查的量具缺陷（详见交接单 §4） |
| `m9-wp0-admission-…-dba2` | 24/25 FAIL | S13 目录名字典序挑错"最新" |
| `m9-wp0-admission-…-4819` | **25/25 PASS** | 终读数 |
| `m9-wp0-…-26ad` | baseline PARTIAL | 窗口跨自身校准提交（A8 如实红） |
| `m9-wp0-…-79e7` | **BASELINE CAPTURED** | 紧窗口终读数（supersedes 26ad） |

被测对象在量具修正前后行为一致；修正只涉及量具自身的路径/字符串/排序逻辑。
