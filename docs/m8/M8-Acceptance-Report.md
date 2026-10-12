# M8 Acceptance Report（Affect 情绪状态演化）

> 日期：2026-09-26。判定载体：[M8-Gate-Decision.md](M8-Gate-Decision.md)（本文是事实底稿）。
> 机器读数：`pnpm m8:gates`（只读已落盘证据，**Hard Gates = PASS 10/10**）。
> 计划：[M8-Execution-Plan.md](M8-Execution-Plan.md)。设计：[ADR-066](../adr/ADR-066-affect-state-evolution.md)（`ACCEPTED / DESIGN FROZEN`）。
> 分支：`feature/m7-relationship`。**未合并、未打标签**（待用户）。
>
> **M8 database migration = NONE**
> **M8 uses existing generic domain-event/projection tables = VERIFIED**
> （`character_domain_events` / `character_projections` / `character_traces` /
> `character_jobs` 全部复用既有表；WP4 门 14/14 验证投影读写与 rebuild）。

## 1. 交付面（WP0→WP8 全链）

| 工作包 | 交付 | 权威读数 |
|---|---|---|
| WP0 | 基线快照 + 准入（TD 接待 + 干净基线） | baseline CAPTURED（`…-e139` 9/9）· admission **13/13**（`…-2892`） |
| WP1 | ADR-066（24 项裁定，`ACCEPTED / DESIGN FROZEN`） | 用户"按提案执行" |
| WP2 | 合同层（`contracts/affect.ts` 等）+ 纯函数规则 | contracts **55/55**（`…-6eb0`） |
| WP3 | 提案器 + 放行口（fail-closed validator） | proposal-verify **35/35**（`…-ee6e`） |
| WP4 | 投影 store + reducer + rebuild + 水位 | persistence-verify **14/14**（`…-53a7`） |
| WP5 | 上下文注入（section 52 + 边界行 + 基线不动） | context-verify **17/17**（`…-16e0`，调度器变更后复验） |
| WP6 | 同轮有界应用 + 降级 + trace 六步 + reply-truth | same-turn-verify **12/12**（`…-f8d6`，调度器变更后复验） |
| WP7 | e2e + 长轨迹 + Live Smoke + 盲审材料 | e2e **21/21**（`…-7f02`）· long **5/5**（`…-3979`）· live **7/7**（`…-a543`） |
| WP8 | 全量回归 + 四份发布文档 + `m8:gates` + 激活候选 | 见 §5 与 Gate-Decision |

## 2. 机器门读数（m8:gates 的当前面）

```text
m8:wp0:baseline   CAPTURED  9/9    基线快照（3 run 在案，含 2 个中间档）
m8:wp0:admission  PASS     13/13   准入（TD 接待 + 干净基线）
m8:wp2:contracts  PASS     55/55   合同静态 + 三段式
m8:wp3:verify     PASS     35/35   提案器（负控：assistant/tool/SERVICE/错误 user 全零提案）
m8:wp4:verify     PASS     14/14   放行口 + 投影 + rebuild + 水位
m8:wp5:verify     PASS     17/17   上下文注入（基线逐字节不变 + 双 section 并存）
m8:wp6:verify     PASS     12/12   同轮应用 + 降级 + trace 六步（调度器变更后复验）
m8:e2e:verify     PASS     21/21   A01–A20 + L2（正控 8 / 负控 6 / 恢复 6 / L2 1）
m8:long:verify    PASS      5/5    1×500 长轨迹（边界夹紧 + rebuild 对账 + M7 并存）
m8:live:level1    PASS      7/7    生产副本 + 真模型 6 轮（零重判 + 零泄漏 + 库未动）
Hard Gates = PASS（10/10 门权威读数为绿；29 个 run 在案，失败档分列保留）
```

FAIL 中间档全部留档（runId 可溯，不回写）：wp0 `-e044`/`-6e15`（基线中途档）、
wp0-admission `-9d18`、wp2 `-37b4`（判据中途档）、wp3 `-9697`、wp4 `-1b18`、
wp6 `-513f`/`-d90f`（量具缺陷两跑，见 M8-WP6-Handoff §4）、
e2e `-afcf`/`-e347`/`-3793`（**两个生产缺陷的发现档**，见 §3）、
live `-7070`（量具缺陷，trace 元数据键名误读）。
另有 `live-level1-…-2ef6`（无清单——开跑闸拒绝写正文，运行中断，如实留档）。

## 3. 判据修正与工程坑（如实清单）

### 3.1 生产缺陷一：tool 事件永久楔死 affect 评估（e2e 发现，已修）

**症状**（e2e `…-afcf` 12/21 连锁红）：窗口含任何 `actorType==='tool'` 事件 ⇒
`processorEventViewOf` 抛 `tool_event_not_extractable_in_m4`（M4 冻结区的输入
边界）⇒ 评估 failed ⇒ 水位冻结 ⇒ tool 事件永留尾窗 ⇒ 之后每窗都失败。
**修复**：`src/kernel/app/affect/job.ts` 视图构造前过滤 tool 事件（M8-D04
"tool 内容永不是情绪证据"的一致性后果）+ `skippedToolEvents` 审计计数。
**M7 同款潜伏未动**（`relationship/job.ts` L191；无生产 tool 写入者），
登记 L-M8-13 交 M7 维护线。

### 3.2 生产缺陷二：同窗重试楔死——catch 不落 failed（e2e 发现，已修）

**症状**（e2e `…-e347` A12/A13 红）：调度器 catch 只返回 failed、不
`finishJob` ⇒ job 行滞 `running` ⇒ 同窗重试 `enqueueJob` 返回既有行 ⇒
`markJobRunning` 抛 `job_not_pending` ⇒ 永远无法恢复。job-store 的部分唯一
索引**本就为 failed-可重建设计**（L107-113 注释原文），调度器没走完契约。
**修复**：`src/infrastructure/runtime/affect-scheduler.ts` catch 补
`finishJob('failed')`（内层失败吞掉——主错误才是要报的）。
**行为变更**：WP6 交接单 §5.1"失败 job 行永滞 running"不再成立；
`m8:wp6:verify` 复跑 12/12（断言不依赖旧行为）。
**M7 同款潜伏未动**，登记 L-M8-13。

### 3.3 量具缺陷（全部自捕自纠，读数如实留档）

| 坑 | 形态 | 修复 |
|---|---|---|
| A06 恒真断言 | 先过滤到 `AFFECT_*` 再测"无非 AFFECT_\*"——自捕自纠 | 改 id 集合差分（测"新增事件 ⊆ AFFECT_\*"） |
| A14 projection 注入拦 0 条却报绿 | 既有投影行走 `update character_projections`，marker 误写 insert（WP6"负控失效最危险"的复现） | marker 改 `/update\s+character_projections/`；注入后必须量到拦截数 >0 |
| A12 断言误用错误码字面量 | `job_not_pending` 是 KernelError **code**，message 是「不是 pending 状态」 | 断言改 message 片段 |
| 长轨迹边界数学错（跑前自纠） | 8 连敌意只到 −0.89，夹紧断言将恒假 | 敌意块扩到 10 连（v 于 208 夹 −1.0，a 于 207 夹 1.0） |
| live 读数器 trace 键名 | `TraceStep` 的结构化元数据是 `attributes`（`applied_this_turn`，数字 1），读数器误读 `payload.appliedThisTurn` ⇒ LV-TRACE 假红（**系统 trace 全程正确**，副本复读已证） | 读数器改读 `attributes`；断言兼容 `true\|1`；FAIL 档 `…-7070` 留案 |
| live 开跑闸首跑拒写 | `artifacts/m8/local/` 未被 gitignore ⇒ `git check-ignore` 闸如实拒绝（**闸在工作**） | .gitignore 点追加（M6/M6.1 同款约定） |

### 3.4 工程坑（沿用与新增）

- drizzle `sql` 模板字符串块是 `StringChunk` 且 `value` 是**字符串数组**（WP6
  发现，WP7 复用其 `sqlTextOf` 修复）；注入代理必须同时包 `execute` 与
  `transaction`。
- 一次性入口（位置参数）归因 SERVICE/agent-runner ⇒ UNCONFIRMED_ORIGIN ⇒
  情绪评估器永不触发——Live Smoke 必须走交互控制台（M7 §8.3 教训的
  直接复用，spawn-per-turn + stdin 管道 + `苏沐薇:` 标记后 `/exit`）。
- 任何源文件改动走 read/edit/write 工具（PowerShell 重写 = 乱码 + BOM，
  WP6 真实复现过）；读 JSON 用 `[System.IO.File]::ReadAllText`。
- `pnpm <script> --args` 会把参数追加到脚本命令后（live 的 `--supersedes`
  传给了 tsx；运行器的 manifest 字段是跑后补的接线，a543 的 manifest 如实
  记 null，取代关系在交接单 §4 登记）。

## 4. 四条车道的读数（WP7 详版见 M8-WP7-Handoff §3）

- **e2e 21/21**：正控 8（七族规则逐族轴值 + 中性 touch-only）· 负控 6
  （assistant 复述 / tool 输出 / SERVICE 位次 / 错误 user / MAINTENANCE_REPAIR
  注入拒收 / M7 双 section 并存）· 恢复 6（崩溃重放 duplicate_operation ×2 ·
  评估输入失败 · store/projection 双注入事务回滚 · +8h 读时衰减 · 重启
  no_tail · 建档 cutover）· L2 读回 1（投影/事件/水位/trace 全链可查）。
- **长轨迹 5/5**（1×500，首跑即绿）：TOUCH=500 · IMPACT=42 · v∈[−1.000, 0.414] ·
  a∈[0.000, 1.000] · 夹紧真实触达 · rebuild 与在线逐字段一致（不变量②）·
  失败注入轮恢复恰一次 · 重启探针 ×4 no_tail · 长间隔衰减生效 · M7 并存。
- **Live Smoke 7/7**（生产副本 + 真模型 + 交互控制台）：真实库树摘要
  `f65531b1322f340c…`（1208 文件）前后逐字相同 · cutover=117 ⇒ 真实旧历史
  零重判（每条 IMPACT 的 sourceEventId 都指向冻结文本）· TOUCH=6 IMPACT=5
  规则全对 · v=0.1298/a=0.1699（期望 0.13/0.17）· 六轮 trace 六步齐全
  `applied_this_turn=1` · 水位=latest · jobs 全 completed · 回复零泄漏。
- **盲审材料**：`artifacts/m8/local/…-a543/transcript.json`（gitignore 闸）；
  Human Review = **PASS**（2026-09-27 修订：用户声明式裁定"已审、无异议"；
  原读数 PENDING 保留在 Gate-Decision §0/§4 历史段）。

## 5. 全量回归（WP8）

| 门 | 读数 |
|---|---|
| `pnpm m4.5:ci` | **EXIT 0**（离线链 M1→M4.5：G2 135/0 · G12 38/0 · G13 32/0 · G14 52/0 · L2 53/0 · G9 12/0；prompt 基线逐字节不变——flag 缺省 off 的负控形状） |
| `pnpm with-test-model pnpm m4.5:ci:full` | **EXIT 0**（真模型档：离线链重跑 + Production-copy Live Smoke **52/0**，S11 量具自检全绿） |
| `pnpm kernel:test` | 26/0（WP7 调度器变更后） |
| `pnpm kernel:verify` | 25/0（同上） |
| `pnpm m8:wp5:verify` | 17/17（同上） |
| `pnpm m8:wp6:verify` | 12/12（`…-f8d6`，同上） |
| `pnpm typecheck` | EXIT 0 |

## 6. 不变量对账（三条跨里程碑硬性质）

- **① Assistant Fact Firewall**：affect 事件全部来自**用户消息**的词形判据
  （负控：assistant 复述零提案、tool 零提案、注入具名拒收）；她的回复永远
  不是情绪证据。
- **② 投影是缓存**：`rebuildAffectProjection` 删行重放与在线投影逐字段一致
  （WP4 门 + 长轨迹 L-REBUILD 500 轮证明）。
- **③ 没成功就没成功口吻**：调度失败 ⇒ 注入块带如实边界行（`applied_this_turn=false`）
  ⇒ 聊天不阻断、水位不动、投影保持旧值（WP6 N2 + e2e 恢复组）；
  job 行如实落 `failed`（WP7 修复后）。

## 7. 证据清单审计（WP8 任务 4）

- 29 个 run 目录全部带 `m8-manifest@1` 清单（1 个无清单中断档如实留案）；
  `payloadSha256` 自摘要可机器判定"被事后改过"。
- 每个 runId 记录产生它的树（`headShort12`）：WP0–WP6 读数在
  `a82080865706`/`8e84aa12227e`/`ba7acbfe9c69`，WP7 live 读数在
  `1ed11d19e697`（HEAD 期间被其它会话推进两次，M8 领土未受影响——
  各自记录，防篡改纪律）。
- 失败档与被取代档**不删除不回写**；`m8:gates` 按最新未被取代 run 取权威。
- 人审正文**不进仓库**（gitignore + `git check-ignore` 机器闸）；
  仓库内 `blind-review.json` 只含 sha256 与程序事实。
