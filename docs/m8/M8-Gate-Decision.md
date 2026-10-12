# M8 Gate Decision（Affect 情绪状态演化）

> 日期：2026-09-26。判定载体：本文。机器读数：`pnpm m8:gates`（只读已落盘证据）。
> 计划：[M8-Execution-Plan.md](M8-Execution-Plan.md)。设计：[ADR-066](../adr/ADR-066-affect-state-evolution.md)（`ACCEPTED / DESIGN FROZEN`）。
> 分支：`feature/m7-relationship`。**未合并、未打标签**（2026-09-26 收口当时读数；
> ✅ 2026-09-27 修订：已打 annotated 标签 `m8-complete`（指向本提交），
> `feature/m7-relationship` 已 ff 合并进 `main`（无合并提交）——当前读数以 AGENTS.md M8 段为准）。
> 事实底稿：[M8-Acceptance-Report.md](M8-Acceptance-Report.md) ·
> 边界：[M8-Known-Limitations.md](M8-Known-Limitations.md) ·
> 架构：[M8-Architecture.md](M8-Architecture.md)

## 0. 判定（六项分列，不合成总分）

| 项 | 判定 | 依据 |
|---|---|---|
| design approval | **批准** | ADR-066 24 项裁定全按推荐冻结（用户"按提案执行"） |
| implementation | **已实现** | 合同→词形判据→评估器→放行口→reducer/投影→水位调度→上下文注入→trace 六步→装配全链；`src/**` 改动全部过对应边界门 |
| hard gates（离线） | **PASS** | `m8:gates` = **10/10 门权威读数 PASS**（29 run 在案，失败档分列保留）；`m4.5:ci` **EXIT 0**（G2 135/0 · G12 38/0 · G13 32/0 · G14 52/0 · L2 53/0 · G9 12/0）；`kernel:test` 26/0 · `kernel:verify` 25/0 · `m8:wp5:verify` 17/17 · `m8:wp6:verify` 12/12（调度器行为变更后复验）· `typecheck` EXIT 0 |
| semantic evaluation | **离线面 PASS / 真模型面 PASS（6 轮 Live）/ 人审 PASS（2026-09-27 声明式裁定）** | e2e 21/21（七族规则逐族轴值 + 六负控）· 长轨迹 1×500 PASS 5/5（夹紧真实触达 + rebuild 对账）· Live Smoke PASS 7/7（真模型 + 生产副本 + 零重判 + 零泄漏）；**盲审材料已交付、人审已完成**（`Human Review = PASS`，2026-09-27 修订，见 §4；原读数 PENDING 保留在 §4 历史段） |
| live smoke | **PASS** | `pnpm with-test-model pnpm m8:live:level1` = **7/7**（生产副本 + 真模型 6 轮 + 交互控制台 6 次真实重启；真实库树摘要 `f65531b1322f340c…` 前后逐字相同）；`with-test-model m4.5:ci:full` = **EXIT 0**（Production-copy Live Smoke 52/0，见 §5） |
| production activation | **ACTIVATED**（2026-09-26，用户授权「批准激活」；载体 [ADR-067](../adr/ADR-067-m8-affect-production-activation.md)，只做状态修订：`.env` 设 `CHARACTER_AFFECT_CONTEXT_ENABLED=true`，**代码缺省仍 false**）。激活前记录：真实库摘要 `f65531b1322f340c387886c4`（1208 文件）· 快照 `pglite-2026-09-26T07-52-44-745Z-f65531b1322f` · `kernel:status` 首启干净（INC-01 全周期 cleanClose）。激活结果单独标记，**不并入**设计/实现 PASS（计划 §10 WP9 任务 6） |

**M8 建议判定文字（计划 §16.2 的格式）**：

```text
M8 Affect = PASS（工程面）
Design = ACCEPTED / DESIGN FROZEN
Implementation = COMPLETE
Hard Gates = PASS
Level 1 = PASS（e2e 21/21 + 长轨迹 5/5 + Live 7/7）
Level 2 = PASS（开发者面读回：投影/事件/水位/trace 全链可查）
Human Review = PASS（2026-09-27 声明式裁定；原读数 PENDING 保留在 §4 历史段）
Production Activation = ACTIVATED（ADR-067；原读数 NOT ACTIVATED 保留在 §6 历史段）
External Capability Added = NONE
```

> 2026-09-27 修订：上表**格式**（计划 §16.2）不变，仅两处**读数**更新——
> `Human Review` 按用户声明式裁定（§4）、`Production Activation` 按 ADR-067/§6
> （M9 计划 §1.5 的读取规则）。两处原读数均保留在各自历史段，不回写。

## 1. 机器门读数（m8:gates 的当前面）

```text
m8:wp0:baseline   CAPTURED  9/9    基线快照（M7 末状态）
m8:wp0:admission  PASS     13/13   准入（TD 接待 + 干净基线）
m8:wp2:contracts  PASS     55/55   合同静态 + 三段式
m8:wp3:verify     PASS     35/35   提案器（负控：assistant/tool/SERVICE/错误 user 全零提案）
m8:wp4:verify     PASS     14/14   放行口 + 投影 + rebuild + 水位（迁移 = NONE）
m8:wp5:verify     PASS     17/17   上下文注入（基线逐字节不变 + 双 section 并存）
m8:wp6:verify     PASS     12/12   同轮应用 + 降级 + trace 六步（调度器变更后复验）
m8:e2e:verify     PASS     21/21   A01–A20 + L2（正控 8 / 负控 6 / 恢复 6 / L2 1）
m8:long:verify    PASS      5/5    1×500 长轨迹（v∈[−1,1] a∈[0,1] 夹紧触达 + rebuild 对账）
m8:live:level1    PASS      7/7    生产副本 + 真模型（零重判 + 零泄漏 + 库未动）
Hard Gates = PASS（10/10；29 run 在案，失败档分列保留不回写）
```

全量回归：`m4.5:ci` **EXIT 0**（离线链 M1→M4.5 全绿，含 prompt 基线逐字节
不变——affect flag 缺省 off 的负控形状）；真模型档
`with-test-model m4.5:ci:full` 的最终读数见 §5（运行中收口时填写）。

## 2. 本判定不主张什么

```text
· 不主张"她有了感受"——valence/arousal 是程序状态轴（L-M8-07）；
  全部读数证明的是机制性质（可查/可重放/可降级/边界稳定）；
· 不主张规则覆盖自然语言情绪理解——冻结词形判据，覆盖面外只 touch
  不 impact（L-M8-01）；扩展走语义评估器预留位，不加启发式；
· 不主张识别用户情绪——演化的是 Character 内部状态（L-M8-02）；
· 不主张多用户生产就绪——单 Character/单 active user（L-M8-03），
  生产入口仍是单用户控制台；
· 不主张激活前的历史对情绪有贡献——cutover=账本尾，旧历史永不回评
  （L-M8-04，Live 已验证）；
· 不主张措辞层零偏差——注入块是上下文/程序事实链，回复遵从由盲审与
  观察把关（L-M8-12，DR-11 同款边界）；
· 不主张 M7 的潜伏缺陷已修——tool 楔死 + catch 不 finishJob 在关系
  评估器同款存在，登记 L-M8-13 交 M7 维护线；
· 不主张任何新增外部能力——能力影响矩阵 = NONE（L-M8-11），
  不得解释为 Level 2 action package。
```

## 3. 与既有判定的关系（三列导航）

| 事项 | 当前（本文） | 历史 | 取代关系 |
|---|---|---|---|
| M8 工程判定 | **PASS（工程面）**；Human Review = **PASS**（2026-09-27 修订）；ACTIVATED（ADR-067） | —（M8 首次判定） | — |
| WP6 交接单 §5.1"失败 job 行永滞 running" | **不再成立**（WP7 修复：catch 落 `failed`；wp6 门复验 12/12） | WP6 交接单（2026-09-26 上午） | WP7 修复取代该行为描述；WP6 文档按历史保留不回写 |
| M7 潜伏缺陷 | L-M8-13 登记（未动 M7 领土） | M7 Gate-Decision（未涉及） | 无取代——M7 判定不因此变化（今天无生产 tool 写入者） |
| M6 `Original Lv1` | 与 M8 无关（M7 已交付取代） | M7 Gate-Decision §0 | 无取代 |

## 4. Human Review = PASS（2026-09-27 修订；原读数 PENDING 保留于下）

**2026-09-27 声明式裁定**：用户就 2026-09-26 呈交的同一份盲审材料声明——
原话「我之前已经审过了没有问题，只是没有写而已」⇒ 四条审题**无异议**，
`Human Review = PASS`（判定权在人；记录载体 `artifacts/m8/local/blind-review-record.md`，
gitignore 不进仓库——人审正文与记录不进 Git 的约定不变）。
材料完整性复核（2026-09-27）：`…-a543/transcript.json` 六轮 `replySha256` 与仓库内
`blind-review.json` 的 `turnFacts` **6/6 逐字一致**。
**附注（不改判定）**：材料每轮 `reply` 尾部带一行日志残迹——WP7 §4 已登记的
量具外观缺陷，人审**已见**，不影响四条结论。
**边界**：人审 PASS 不改变工程判定、不改变激活状态（ADR-067 已 EXECUTED）、
不新增任何能力主张；`DR-11`（措辞层没有启发式守卫）照旧。原"未审不填"的 PENDING
读数按防篡改纪律保留如下，不回写。

> **原读数（2026-09-26 收口当时）**：Human Review = PENDING。盲审材料已交付：
> `artifacts/m8/local/m8-live-level1-20260926-1ed11d19e697-a543/transcript.json`
> （六轮「用户冻结文本 → 她的真实回复」+ 程序事实；gitignore 机器闸，正文不进
> 仓库）。四条审题：方向一致而不机械复读 / 语义级零复述 / 不声称知道用户情绪 /
> 失败口吻与事实一致（详单见 M8-WP7-Handoff §5）。
> **未审不填**：人审结论出来前，本判定不把"更像人"当通过依据（计划 §10 WP7
> 任务 7：评审程序事实、边界和降级）。

## 5. 真模型档最终读数

`pnpm with-test-model pnpm m4.5:ci:full` = **EXIT 0**（2026-09-26）：
离线链原样重跑全绿 + **M4.5 Production-copy Live Smoke 52/0**（52 轮
生产副本真模型；S11 量具自检：每轮回复被捕获、CLI 全零退出）。
该 smoke 以 M8 代码 + flag 缺省 off 跑出——**M8 的存在不破坏既有生产
形状**（prompt 基线逐字节不变）；其一次性入口的 SERVICE 归因同时是
affect 资格闸的活体负控（UNCONFIRMED_ORIGIN ⇒ 永不评估）。
全量回归闭环：`m4.5:ci` EXIT 0 + `m4.5:ci:full` EXIT 0。

### 5.1 激活后并发收口读数（2026-09-26，用户指示「最高并发」）

flag 已置 `.env`（ADR-067）**之后**的确认扫（全部隔离库，与真实库零冲突；
HEAD `b4b0fc52`，证据 `artifacts/m8/<runId>/` + `artifacts/.fast/`）：

| 道 | 读数 |
|---|---|
| `fast:offline`（6 路并发离线链） | **34/34 PASS**（墙钟 89.5s；串行基线 12.4 分钟） |
| `gates:run --lane summaries` | **7/7 PASS**（m5 / m5.1 / m5.1.1 / m5.5 / m5.5.1 / m6 / inc-01） |
| `m8:wp5:verify` 复跑 | **PASS 17/17**（`…-e2fb`） |
| `m8:wp6:verify` 复跑 | **PASS 12/12**（`…-c5e9`） |
| `m8:e2e:verify` 复跑 | **PASS 21/21**（`…-51d3`） |
| `m8:long:verify` 复跑 | **PASS 5/5**（`…-5376`，500 轮） |
| `m8:gates` 终读 | **Hard Gates PASS 10/10**（33 run 在案） |

**环境隔离确认**：`.env` 的 affect flag 打开**不改变任何门的判读**——
各门在 harness 内显式构造 flags（与 M7 flag 在 `.env` 时 ci 照绿同理）。
快车道按 §7 白名单还原了本次新弄脏的 5 条历史证据；运行前已脏的保留。

## 6. WP9 执行记录（ACTIVATED）

用户于 2026-09-26 授权「批准激活」（盲审材料过目之后——该次过目即 §4 的人审；
其裁决由用户 2026-09-27 声明并补记落纸，原读数 PENDING 保留在 §4 历史段）。执行链：

```text
激活前记录   真实库摘要 f65531b1322f340c387886c4（1208 文件，与 M8 全程逐字相同）
             · 快照 pglite-2026-09-26T07-52-44-745Z-f65531b1322f
             · 配置：M7 flag on · 无 CHARACTER_AFFECT_*（ADR-067 §3 全表）
载体         ADR-067（ACCEPTED / EXECUTED，只做状态修订）
动作         .env += CHARACTER_AFFECT_CONTEXT_ENABLED=true（代码缺省仍 false）
首启观察     kernel:status 干净（INC-01 全周期 LEASED→…→RELEASED，cleanClose=true）
             · affect 投影未建档（符合预期：ORIGIN 在首轮真实对话创建，cutover=账本尾）
             · M7 关系投影在产（trust 0.85 / closeness 0.64）——双投影并存的生产形状
并发收口     （用户同轮指示「最高并发」）fast:offline 6 路离线链 + summaries 7 门
             + m8 四门并发复跑 + m8:gates 只读汇总——读数见 §5
回滚         删 .env 该行即回滚；AFFECT_* 事件与投影保留（审计事实不删不改）
```

激活结果单独标记 **ACTIVATED**，不并入 M8 设计/实现 PASS（计划 §10 WP9
任务 6）。首次真实对话后的 ORIGIN/cutover/trace 六步读回：用户下一轮
`pnpm chat` 后可用 `pnpm kernel:status` 直接查看（affect 投影行 +
per-character 读回）。
