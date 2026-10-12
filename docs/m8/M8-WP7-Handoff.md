# M8 WP7 交接单 —— 测量门 + e2e + 长轨迹 + Live Smoke + 盲审材料

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP7（任务 1–7）
> 证据（四条车道，全部隔离库或生产**副本**；真实库只树摘要）：
> · `pnpm m8:e2e:verify` = **PASS 21/21**（权威读数
>   `artifacts/m8/m8-e2e-verify-20260926-ba7acbfe9c69-7f02/`；三跑 FAIL 在案见 §4）
> · `pnpm m8:long:verify` = **PASS 5/5**（1×500，首跑即绿；
>   `artifacts/m8/m8-long-verify-20260926-ba7acbfe9c69-3979/`）
> · `pnpm with-test-model pnpm m8:live:level1` = **PASS 7/7**（生产副本 + 真模型 6 轮；
>   `artifacts/m8/m8-live-level1-20260926-1ed11d19e697-a543/`，取代 FAIL 跑
>   `…-7070`——量具缺陷，见 §4；一跑 FAIL 在案）
> · 盲审材料：`artifacts/m8/local/m8-live-level1-20260926-1ed11d19e697-a543/transcript.json`
>   （**不进仓库**——gitignore + `git check-ignore` 机器闸；仓库内索引
>   `blind-review.json` 只含 sha256 与程序事实）
> 回归（本 WP 改了生产代码，全链重跑）：`kernel:test` 26/0 · `kernel:verify` 25/0 ·
> `m8:wp5:verify` 17/17 · `m8:wp6:verify` 12/12（调度器行为变更后复验）· `pnpm typecheck` EXIT 0
> 下一站：WP8（全量回归 + 四份发布文档 + `m8:gates` + 证据清单审计）

## 1. 交付物

| 交付物 | 位置 | 内容 |
|---|---|---|
| e2e 门 | `scripts/m8-e2e-verify.ts`（`m8:e2e:verify`） | A01–A20 + L2 共 21 项：隔离库 + **真实 TurnGateway**（ConversationRecorder 双 ingress）+ 真调度器 + 真放行链；语料 `m8-e2e-corpus@1`；正控 8 / 负控 6 / 恢复 6 / L2 读回 1 |
| 长轨迹生成器 | `scripts/m8-long-trajectory.ts` | 纯函数 500 轮冻结语料（`m8-long-corpus@1`）+ **不变量自证闸**（位置冻结 / 词形恰命中 / 中性零命中 / 单 impact 前提）——破损即拒跑 |
| 长轨迹门 | `scripts/m8-long-verify.ts`（`m8:long:verify`） | 1×500 隔离轨迹：边界夹紧 / rebuild 对账 / 失败注入 retry 不重复 / 长间隔衰减 / 重启探针 / M7 并存（§11.5 逐条） |
| Live Smoke 运行器 | `scripts/m8-live-level1.ts`（`m8:live:level1`） | 生产**副本**（cpSync）+ 真模型 + 交互控制台 spawn-per-turn（M7 §8.3 入口纪律）；冻结 6 轮 `m8-live-corpus@1`；语料自证 + with-test-model 标记双开跑闸 |
| Live 读数器 | `scripts/m8-live-read.ts` | 只读子进程：affect 投影/水位/job 分布/账本尾/AFFECT 域事件逐条/trace 六步与 `applied_this_turn` |
| 盲审材料 | `artifacts/m8/local/<runId>/transcript.json` + 仓库内 `blind-review.json` | 六轮「用户冻结文本 → 她的真实回复」+ 程序事实；审题四条（见 §5）；正文不进仓库 |
| .gitignore | `artifacts/m8/local/` + `artifacts/m8/**/*.log` | M6/M6.1 同款约定（人审正文与长日志不进仓库） |
| package.json | `m8:e2e:verify` / `m8:long:verify` / `m8:live:level1` | 点状追加 |

## 2. 本 WP 发现并修复的两个生产缺陷（e2e 门的直接产出）

### 2.1 缺陷一：tool 事件永久楔死 affect 评估（已修）

- **症状**（e2e run `…-afcf`，A10 起 12/21 连锁红）：窗口里出现任何一条
  `actorType==='tool'` 的事件 ⇒ `processorEventViewOf` 抛
  `tool_event_not_extractable_in_m4`（M4 记忆抽取器的输入边界，冻结区）⇒
  评估 failed ⇒ 水位冻结 ⇒ 该 tool 事件永远留在尾窗 ⇒ **之后每一窗都失败**。
- **修复**（`src/kernel/app/affect/job.ts`）：视图构造前过滤
  `event.actorType !== 'tool'`（M8-D04 早已裁定 tool 内容**永不**是情绪证据——
  过滤是裁定的一致性后果，不是新语义）；`AffectEvaluationOutcome` 增
  `skippedToolEvents` 计数（干跑与正式跑两处返回）。
- **M7 同款楔死为潜伏**（`src/kernel/app/relationship/job.ts` L191 无过滤）：
  今天无生产 tool 事件写入者（grep 验证 `recordToolOutput` 零调用方）⇒ 潜而不发。
  **未动 M7 已交付文件**（冻结纪律）；登记为跨域发现，交 M7 维护线/Tech-Debt。
- e2e 的 A17（关系评估）因此**排在 A10（tool 事件落账）之前**——关系评估器
  在含 tool 事件的窗口上会真抛（其干跑在 try 之外），这是 M7 的已知边界，
  不是 M8 量具的缺陷；语料顺序冻结在 `m8-e2e-corpus@1`。

### 2.2 缺陷二：同窗重试楔死——失败后 job 行永滞 running（已修）

- **症状**（e2e run `…-e347`，A12/A13 红）：调度器 catch 只返回 `failed`、
  **不 `finishJob`** ⇒ job 行停在 `running`；同窗重试时 `enqueueJob` 返回既有行
  （created=false）⇒ `markJobRunning` 抛 `job_not_pending` ⇒ 再失败 ⇒ 永远如此。
  job-store 的部分唯一索引**本来就是为 failed-可重建设计的**
  （L107-113 注释原文："否则一次失败会把这个幂等键永久钉死，重试反而做不了"）
  ——调度器没走完这个契约。
- **修复**（`src/infrastructure/runtime/affect-scheduler.ts` catch）：失败时
  `finishJob(db, job.id, 'failed', { error: message, now })`（自身失败则吞——
  主错误才是要报的）。效果：A13/A14 恢复**一次**成功（failed 键 ⇒ 重建新 job）；
  A12 的 stale-completed 形状两步自愈（① job_not_pending ⇒ 如实落 failed；
  ② 重建 ⇒ 放行口 `duplicate_operation` ×2 拒收 ⇒ 新建=0 ⇒ 水位补推进——
  域键幂等是最后一道闸，两步都不产生重复事件）。
- **行为变更声明**：WP6 交接单 §5.1"失败轮的 job 行永远停在 running"自本修复
  起**不再成立**——失败如实落 `failed`（审计面更诚实：不再躺着一条永不结束的
  running）。`m8:wp6:verify` 复跑 **12/12 PASS**（其断言不依赖旧行为）。
- **M7 同款**（relationship 调度器同形 catch）：同属 M7 维护线，未动。

## 3. 四条车道的读数

### 3.1 e2e（21/21）

- **正控 8**（A01–A08）：中性 touch-only 轴不动 · A-GRATITUDE +0.08 ·
  A-REPAIR +0.12（a 从 0 夹 0）· A-WARM +0.08/+0.03 · A-COMFORT +0.10/−0.08
  （夹 0）· A-HOSTILE −0.15/+0.12 且**只产 AFFECT_\* 事件**（id 集合差分证无
  行动域泄漏）· A-REJECTION −0.10/+0.08 · A-URGENT 0/+0.10。
- **负控 6**（A17/A09/A10/A11/A18/A20）：M7+M8 双 section 并存且词形互不污染 ·
  assistant 复述「谢谢你」零提案 · tool/search 输出零提案零落库（M8-D04）·
  agent-runner（SERVICE 位次）提交的感谢零提案（ESTABLISHED 资格失败）·
  错误 activeUserId 下零提案（fail-closed）· MAINTENANCE_REPAIR 直接注入被
  放行口具名拒收 `affect_origin_injection_not_enabled`（探测 payload 先过
  schema 闸——initialValence/initialArousal 必须 0/0，M8-D06）。
- **恢复 6**（A12–A16 + A19）：崩溃模拟（水位回拨）⇒ 两步重放 ⇒
  `duplicate_operation` ×2 · 新建=0 · 轴不二动 · 域事件不增 ·
  评估输入装载失败（水位冻结、恢复恰一次新建=2）· store/projection 双注入
  （事务回滚零泄漏、恢复两窗一次补洞新建=4）· +8h 读时衰减
  （effective=canonical/4，canonical 不写回，读回带「已衰减」）·
  重启 no_tail · 建档即 cutover（旧消息零评估）。
- **L2 读回**：三段式（投影本体/cutover/轴条 + 读时视图 + legacy 退役对照）·
  每条 IMPACT 带 sourceEventId+ruleId（来源→规则→事件→revision 全链）·
  水位可读 · trace 六步可查。

### 3.2 长轨迹（1×500，PASS 5/5，首跑即绿）

- **L-COUNT**：失败注入轮（t210 感谢）零落库 ⇒ 轮后追赶恰一次（created=2）；
  AFFECT 域事件总数 === ORIGIN(1) + 各窗 createdEvents 之和（对账无重复无丢失）。
- **L-BOUNDS**：**真的碰到夹紧**——v 到 −1.000（10 连敌意，块前 ≈+0.31）、
  a 到 1.000（紧急余量 + 敌意 +0.12/击）；全程 −1≤v≤1、0≤a≤1（500 轮逐轮检查）；
  每轮 impact ≤1（主导规则族去重）；检查点 packet 都有 affect 块。
- **L-REBUILD**：`rebuildAffectProjection` 删行重放与在线投影**逐字段一致**
  （v/a/cutover/originated/lastEventId/revision；折叠事件数 = 在线 revision）——
  不变量②"投影是缓存"的 500 轮可执行证明。
- **L-M7**：relationship 投影独立在场（revision>0）· 关系 section 可渲染 ·
  affect 事件零混入。
- **L-ARC**：长间隔（+12h ×2）读时衰减生效 · 重启探针（×4）no_tail 且
  revision 不动 · 敌意触底后修复块拉回（v(212) > v(209)+0.2）。
- 计数：TOUCH=500 · IMPACT=42 · v∈[−1.000, 0.414] · a∈[0.000, 1.000]。

### 3.3 Live Smoke（生产副本 + 真模型，PASS 7/7）

- 真实库树摘要 `f65531b1322f340c…`（1208 文件）**前后逐字相同**（只复制不打开）。
- **LV-REPLY**：6/6 回复非空、零内部泄漏（效价/唤醒/规则名/cutover 等词形
  不进用户可见面）。
- **LV-ORIGIN**：副本建档 cutover=117 < 首轮冻结文本序号 ⇒ **真实旧历史零重判**
  （M8-D05 活体证明：每条 IMPACT 的 sourceEventId 都指向本轮冻结文本）。
- **LV-EVENTS**：TOUCH=6 · IMPACT=5 · 每条 IMPACT 的 ruleId 与冻结文本期望一致。
- **LV-AXIS**：v=0.1298 / a=0.1699（期望累计 0.13/0.17，±0.04 容差几乎没用上——
  分钟级真实衰减可忽略）；revision=12（ORIGIN + 6 touch + 5 impact）。
- **LV-TRACE**：6 轮 trace 各含 affect 六步 · `applied_this_turn=1` ·
  `revision_to` 单调前进 · `created_event_count` 1（中性轮）/2（事件轮）。
- **LV-WATERMARK**：水位=149=账本最大序号 · jobs 全 completed（12 条：6 轮 ×
  同轮+轮后两次评估），无 failed/滞留 running。
- spawn-per-turn = **6 次真实重启**（每轮独立进程、独立开机追赶）。

### 3.4 量具有效性（INV-M45-06，本 WP 的自证面）

- e2e 的 A06 曾是**恒真断言**（先过滤到 AFFECT_\* 再测"无非 AFFECT_\*"——
  自捕自纠，改 id 集合差分）；A14 首跑的 projection 注入**拦到 0 条查询**却
  绿着报成功（既有行走 `update character_projections`，marker 误写 insert——
  WP6"负控失效是最危险量具缺陷"的复现）——修 marker 后注入才真生效。
  两处都按"判据错了如实写"登记（§4）。
- 长轨迹与 Live 都有**开跑闸**：语料不变量自证（纯函数）不过 ⇒
  MEASUREMENT INVALID，一轮不跑。
- Live 的 LV-ORIGIN 用"IMPACT 的 sourceEventId 全部 ∈ 冻结文本事件"做
  **不依赖注入的第二道断言**（WP6 §6.5 建议的落地）。

## 4. 失败档记录（全部在案，不回写）

| 车道 | runId | verdict | 缺陷 | 修复 |
|---|---|---|---|---|
| e2e | `…-ba7acbfe9c69-afcf` | FAIL 12/21 | 生产缺陷一（tool 事件楔死，§2.1）+ A17 与 A10 的窗口交互 | job.ts 过滤 tool 事件；A17 移到 A10 前 |
| e2e | `…-ba7acbfe9c69-e347` | FAIL 18/21 | 生产缺陷二（同窗重试楔死，§2.2）+ A14 marker 误写 insert + A12 断言误用错误码字面量（`job_not_pending` 是 code，message 是「不是 pending 状态」） | 调度器 catch 补 `finishJob('failed')`；marker 改 `update character_projections`；断言改 message 片段 |
| e2e | `…-ba7acbfe9c69-3793` | FAIL 20/21 | 仅剩 A12 断言字面量（同上第三项） | 同上 |
| e2e | `…-ba7acbfe9c69-7f02` | **PASS 21/21** | —（权威读数） | — |
| live | `…-1ed11d19e697-7070` | FAIL 6/7 | **量具缺陷**（非系统缺陷）：trace 步的结构化元数据是 `attributes.applied_this_turn`（数字 1），读数器误读 `payload.appliedThisTurn` ⇒ LV-TRACE 假红；系统 trace 全程正确（副本复读已证） | 读数器改读 `attributes`；断言兼容 `true \| 1` |
| live | `…-1ed11d19e697-a543` | **PASS 7/7** | —（权威读数，取代 7070：量具修复后重跑；`--supersedes` 参数已随跑传入并在本表登记——运行器的 manifest 字段是跑后补的接线，a543 的 manifest 如实记 null） | — |

长轨迹无失败档（`…-3979` 首跑即 PASS 5/5）。

**量具外观缺陷（不影响任何断言，登记不修）**：`extractReply` 的日志行边界
锚定行首（`^\s*(Info|…)`），而子进程退出时"输入提示前缀 + 关停日志"拼在
同一行（`<USER_NAME>:  Info …[PLUGIN:BOOTSTRAP:…] Stopping …`）⇒ 该行
尾随进提取的回复正文。影响：盲审 transcript 的 reply 字段末尾多一行日志
残迹；LV-REPLY 的两条断言（非空/零泄漏）都不读它，判定不受影响。
改进位（若未来修）：边界正则兼容"提示前缀 + 日志"形状——属 M6.1 共享
模块（`m6.1-reply-extract.ts`），改它要连测 M6.1/M7/M8 三代消费者，
收益是纯外观的，故只登记。

## 5. 盲审材料（任务 7 的"材料"半边；判定权在人）

- **位置**：`artifacts/m8/local/m8-live-level1-20260926-1ed11d19e697-a543/transcript.json`
  （gitignore + `git check-ignore` 机器闸；仓库内 `blind-review.json` 只含
  sha256、字数与程序事实——正文不进 Git）。
- **审题四条**（`blind-review.json.reviewQuestions`）：
  1. 回复是否与 affect guidance **方向一致**（敌意轮转冷、修复轮回暖）而不机械复读？
  2. 回复是否**语义级**复述内部状态/数值（机器面只查了词形级泄漏）？
  3. 回复是否声称**知道用户真实情绪**（注入块明示"不是对对方真实情绪的判断"）？
  4. 失败/边界口吻是否与事实一致（本轮无失败；如见「未完成」边界行应与
     `applied_this_turn=false` 对应）？
- **评审程序事实、边界和降级，不把"更像人"当唯一标准**（计划 §10 WP7 任务 7 原文）。
- 人审结论属 WP8 收口输入；未审不填。

## 6. 已知行为与边界（WP8 需带着）

1. **A12 的 stale-completed 形状是两步自愈**（不是一步）：completed 行先被
   `job_not_pending` 拒 ⇒ 如实落 failed ⇒ 重建后靠**域键幂等**（duplicate_operation）
   保证零重复。生产里该形状只在"finishJob 与 advanceWatermark 之间崩溃"出现，
   且尾窗一长（新事件到）即单步自愈——两步路径是兜底，不是常态。
2. **同窗重试语义**：failed 键可重建（本 WP 修复后）；completed 键不可重跑
   （job-store 契约）——A12 的两步路径是两者粘合的边界行为，已用 e2e 冻结。
3. **M7 的两个同款缺陷未动**（tool 楔死 + catch 不 finishJob）：
   均为 M7 已交付领土，今天潜伏（无生产 tool 写入者；关系评估失败同样自愈于
   尾窗增长）。建议 M7 维护线或 M9 一并处理；Tech-Debt 登记。
4. **Live Smoke 只写副本**：真实库的 affect 状态不存在（flag 缺省 false，
   .env 无 `CHARACTER_AFFECT_*`）——激活属 WP9 独立裁定（M8-D14）。
5. **live:long 未跑**（计划 §12 的建议名）：长轨迹稳定性由离线 1×500 覆盖
   （情绪机制与模型无关——确定性规则）；真模型面由 6 轮 Live + WP8 的
   `m4.5:ci:full`（52 轮生产副本 smoke）覆盖。若 WP8 收口要求补，可复用
   `m8-long-trajectory.ts` + `m7-live-long.ts` 骨架。
6. **HEAD 在本 WP 期间被其它会话推进**（`ba7acbf`→`1ed11d1`，非 M8 路径）——
   M8 领土文件未受影响；e2e/长轨迹读数记 `ba7acbfe9c69`，Live 读数记
   `1ed11d19e697`（各自记录产生它的树，防篡改纪律）。

## 7. 给 WP8 的输入

1. **回归面**：本 WP 改了两个生产文件（`affect/job.ts`、`affect-scheduler.ts`）
   ——WP8 全量回归必须含 `m4.5:ci`（或 `gates:run --lane offline --mode release`）
   + `with-test-model m4.5:ci:full`；`m8:wp6:verify` 已复验 12/12。
2. **`m8:gates` 汇总**：只读已落盘证据（e2e/long/live/wp0-wp6 各 run 的
   manifest）；缺文件 = NOT RUN，不是 PASS。
3. **四份发布文档**的素材：本交接单 §2（两个生产缺陷的发现-修复-回归链）、
   §3（四车道读数）、§4（失败档）就是 Known-Limitations 与 Acceptance-Report
   的直接输入；Architecture 引 ADR-066 + WP2-WP5 交接单。
4. **能力影响矩阵 / M8→M9 交接**：Affect 是 Character 域第 4 个投影
   （memory/relationship/affect + identity）；M9 候选输入包括 §6.3 的 M7
   双缺陷、语义评估器预留（A-UNCERTAIN 恒不产 impact 的具名回退）、
   以及"情绪→行为"目前只到 prompt 注入（无行为门控——ADR-066 §8.4 边界）。
5. **WP9 前置**：盲审结论 + 回滚 dry-run（关 flag 即回滚，不删事件不改历史）
   + 用户显式授权——停在 PASS / NOT ACTIVATED。
