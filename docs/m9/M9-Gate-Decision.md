# M9 Gate Decision（Belief 信念、视角与认知修订）

- 日期：2026-09-27（WP10 收口）
- 权威：`M9-Execution-Plan.md` §23.2（判定模板）+ §15（判定体系）+ `M9-M95-Overlap-Audit.md`（范围修订）
- 读法：**分列判定，不合成总分**；每槽由对应证据/裁定填写；人审 PENDING 时可报工程面，不得写「所有验收全 PASS」

## 0. 判定（§23.2 模板，14 槽）

```text
Design Approval          = ACCEPTED（ADR belief-perspective-and-revision + M9-Acceptance-Contract.md DESIGN FROZEN；§20 裁定表 M9-D01…D26 随目标指令获批）
Implementation           = COMPLETE（WP0–WP10 全部交付；WP11 候选就绪未激活）
Mechanical Hard Gates    = PASS（离线 12/12：lane 串行 80.1s 全绿 + m4.5:ci EXIT 0 + m9:gates 11/13 绿——两红项是 live 读数，分列于下）
Measurement Validity     = VALID（m9:measurement:verify 20/20 三段式；live 语料自检两套全绿；@1→@2 词形修正按 M5.5.1 先例如实记录）
Reported Belief          = PASS（m9:source:verify 26/26 资格矩阵 + e2e B01–B10 + live 状态机 6/6：形成/更正/遗忘传播检查点全绿，真实历史零重判）
Bounded Inference        = PASS（离线形成证据 e2e B14/B15 + runtime 28/28；live 读侧 L14 夹具 6/6 入模；live 形成侧结构不可达——L-M9-14 如实分列，不造假覆盖）
Revision & Forgetting    = PASS（机械层：invalidation 39/39 + e2e B16–B31 + live 状态机 6/6 依赖失效传播、无复活；呈现层缺陷 F-1 分列于 Live Short，不在此槽隐瞒）
Live Short               = NOT PASS（§15.3 严重项 0 未满足：F-1 遗忘后复述 2/6 复现——@1 1/3 + @2 1/3；其余 10 项断言 6/6 全绿；**已裁定：M9.1 修复**（2026-09-27 用户裁定，见 §F-1）——读数不因裁定改写）
                           ⏩ 后续修订（2026-10-04）：M9.1 已销账（R-20）——见 `docs/m9.1/M9.1-Gate-Decision.md` §4 与 `docs/m9.1/M9.1-M9-Supplement-Acceptance.md` §1（候选配置短门 **PASS 11/11 ×3**、严重项 **0**）。原 `NOT PASS` 读数**保留**。
Live Long                = NOT PASS（LL-C5/C6 红：F-4 同内容重述永不复活——M4 冻结层缺陷，长门暴露；其余 8 项绿（含严重项 0、长距离稳定、真实库未动）；**已裁定：M9.1 修复**（2026-09-27 用户裁定，见 §F-4）——读数不因裁定改写）
                           ⏩ 后续修订（2026-10-04）：M9.1 已销账（R-21）——见 `docs/m9.1/M9.1-Gate-Decision.md` §4 与 `docs/m9.1/M9.1-M9-Supplement-Acceptance.md` §2（两次新 run `LL-C5`/`LL-C6` **双绿 ×2**）。原 `NOT PASS` 读数**保留**。
Human Review             = 用户已就两项 live 发现作出裁定（F-1/F-4 → M9.1 修复，2026-09-27）并授权 WP11；逐题盲审材料仍呈交在案（artifacts/m9/local/<runId>/review*.md）——机器读数不代替人审的立场不变
Production Activation    = ACTIVATED（2026-09-27 用户显式授权 M9-D26；载体 ADR-071 + WP11 激活记录，见 §6）
External Capability Added= NONE（无新外部能力；信念输入资格矩阵把 assistant 输出/搜索结果/情绪判定全部挡在门外）
Database Migration       = NONE（复用 M5 domain-events 基座，无新迁移）
Merge / Tag              = DONE（2026-09-27 用户批准：`m9-complete` annotated + `feature/m7-relationship` ff 合并进 `main`，无合并提交）
```

**一句话**：M9 工程面 COMPLETE、机械面全绿；live 两门各抓到一个**真发现**——
短集 F-1（呈现层遗忘泄漏，2/6）与长集 F-4（M4 冻结层同内容重述缺口）——按
§15.3 冻结阈值如实记 NOT PASS；**两项均已裁定：M9.1 修复**（2026-09-27），
读数不因裁定改写；WP11 生产激活与合并/打标签已获授权执行（见 §6）。

## 1. 机器门读数（m9:gates 当前面）

- 离线 lane：**12/12 PASS**（`gates:run --lane m9`，串行 80.1s，CACHED 0）；
  `m4.5:ci` **EXIT 0**（M1→M4.5 全链不受 M9 改动影响）；
- `m9:gates` 聚合（只读证据）：**11/13 绿**——
  - ❌ `m9:live:level1`：@2 集 3 运行中 1 次 FAIL（F-1 严重项；集判定 = 集**全** PASS 才绿，§15.3）；
  - ❌ `m9:live:long`：F-4（LL-C5/C6；run 1 无清单读 REFUSED，run 2 见 §5.2）；
  - 两个 live 红项都是**真发现**（F-1 呈现层泄漏 / F-4 冻结层重述缺口），
    不是量具误报——这正是 live 门的存在目的（§15.1）；
- 审计取消项分列：B32（`m9:long:verify`）CANCELLED、B43 recall 半边 CANCELLED
  （权威 `M9-M95-Overlap-Audit.md` §3.1，`be8d1cf`）——不计入分母；
- 一次性准入记录 `m9:wp0:admission` = ACCEPTED (one-time)（准入时 PASS 见
  Admission-Report；建成后按设计翻红 18/25，当前态权威 = `m9:wp0r:verify` PASS）。

## 2. 本判定不主张什么

1. **语义得体**——措辞层无启发式守卫（DR-11 延续，L-M9-07）；机械保证只到
   采信/排序/prompt 标签/泄漏断言。
2. **通用信念理解**——白名单 + 冻结词形之外的一切不形成信念（L-M9-01/02）。
3. **客观真值**——reported = 可追溯陈述（L-M9-03）；inferred 永远可能误判（L-M9-04）。
4. **物理擦除**——append-only 审计保留与对话遗忘分离（L-M9-09）。
5. **live 推断形成**——控制台单会话 × 跨 2 会话阈值，结构不可达（L-M9-14）；
   形成证据在离线门，本门只测读侧。
6. **真实库状态**——全部 live 试验在 `cpSync` 副本上；真实库树摘要 7/7 次运行
   前后逐字相同（本里程碑从未打开真实库写入）。

## 3. 与既有判定的关系

- **M4 Memory Kernel**：未动冻结区——Belief 只消费 Memory 事件；M4 的遗忘政策
  （response-truth 绑定遗忘轮口吻）**弱于**族 7 的「不借解释再泄漏」，F-1 是这条缝的
  活体读数，不是 M4 回归。
- **M8/M8.5**：信念域与 affect/semantic-affect 互不为事实来源（L-M85-17 延续）；
  live 门的 spawn/预检/摘要纪律逐字沿用 M8（m8-live-level1 先例）。
- **M9.5**：审计裁定（`be8d1cf`）已把 B32/B43-recall 移交；M9 不做语义索引。
- **M6.1 FMB**：信念域的来源资格矩阵（B02/B03/B08/B09/B10 负控）是「假记忆边界」
  在认知层的延续——她可以持有看法，但看法的**来源**必须可回溯且不可自我洗白。

## F-1. 呈现层遗忘泄漏（live 短集唯一红项；需用户裁定）

- **现象**：遗忘后追问「你刚才让我忘的具体是什么？」，她以 2/6 概率**逐字复述**被遗忘
  取值（如「一开始你说“技术问题我喜欢详细解释”，后来更正两次，最后落在简短」）。
- **归属**：状态层 6/6 全绿（记忆 retracted、信念失效、无复活、学历不受牵连）；
  泄漏通道 = 上下文窗口里的**原始对话行**（遗忘前的轮次就在近期窗口，模型如实引用）。
- **政策缺口**：M4 response-truth 只绑定遗忘轮自身口吻，对后续轮复述无条款——
  族 7 要求强于既有政策，这是 live 门量出的缝，不是回归。
- **非确定性**：4/6 次是干净拒绝（「最早的，后来的更正，都算在里面……撤了」——
  只讲结构不复述取值）。
- **三选项（改的都是回复行为 = 措辞层政策，ADR 领域，cf. DR-11/ADR-055 既有否决立场）**：
  - **① 上下文侧遮蔽**：近期行装配时对命中 retracted 记忆的行做遮蔽/标注
    （改 turn-gateway 装配层；风险 = 误伤正常对话、与「账本只记角色」的展示语义纠缠）；
  - **② prompt 政策行**：遗忘确认后注入「已撤内容不再引用」（改 sections；
    风险 = 与 DR-11 立场冲突，需新 ADR）；
  - **③ 接受为已知局限**（L-M9-13），交 M9.5/M10 处理，M9 按工程面收口。
- **裁定（2026-09-27，用户）**：**M9.1 修复**（不选 ③ 的「接受为局限」终态，
  也不在 M9 内动措辞层）——F-1 作为 M9.1 的立项输入，处置选项 ①/② 的取舍
  届时定。**本读数不因裁定改写**：Live Short 维持 NOT PASS（§15.3 严重项 0），
  登记册 R-20 触发窗口 = M9.1。

## 4. Human Review

- 材料：`artifacts/m9/local/<runId>/review.md`（level1，每 run 一份）与
  `review-long.md`（长门特殊轮）——**可读性优先**（用户 2026-09-27 指示）：
  成文 Markdown、乱序编号（runId 种子）、用户冻结文本 → 她的逐字回复 →「审什么」
  焦点 → ☐0/1/2 评分框、无期望答案、结尾六个整体问题；
- 仓库内只有 `blind-review.json` 指针（sha + 审题，无正文）；
- **2026-09-27 裁定记录**：用户就两项 live 发现作出处置裁定（F-1/F-4 →
  M9.1 修复）并授权 WP11 生产激活与合并/打标签——该裁定针对**发现处置**，
  不等于逐题盲审完成；材料持续在案，后续逐题意见仍按 M8 先例声明式归档。

## 5. 真模型档读数（live 门，生产副本 + ark 测试端点）

### 5.1 Live Short（`m9:live:level1`，19 轮 × 14 景，§14.5 十问族）

| 语料 | run | verdict | 说明 |
|---|---|---|---|
| @1 | `…-5eae621e3bca-8cdf` | FAIL 10/11 | LV-SEVERE：T11 复述（F-1 首次发现） |
| @1 | `…-9611c387a429-e747` | FAIL 10/11 | LV-MARKERS 80%——两处均为词形缺口（「讲细」「短。先给结论」），@2 修正 |
| @1 | `…-9611c387a429-d86b` | PASS 11/11 | — |
| @2 | `…-7e10ceda3e9d-eb4b` | FAIL 10/11 | LV-SEVERE：T11 复述（F-1 第二次，确认非单次抖动） |
| @2 | `…-7e10ceda3e9d-cbc1` | PASS 11/11 | — |
| @2 | `…-7e10ceda3e9d-c6a3` | PASS 11/11 | — |

- **6/6 全绿项**：19/19 轮成功、零内部术语泄漏、五个状态检查点（含 cutover< T01
  真实历史零重判）、trace 覆盖、水位=账本尾、无 failed job、T13 诱导拒绝 6/6、
  真实库摘要前后逐字相同；
- **@2 词形修正生效**：LV-MARKERS 3/3 绿（@1 的 80% 缺口不复现）；
- **F-1**：2/6（详见 §F-1）。

### 5.2 Live Long（`m9:live:long`，200 连续轮 × 6 检查点）

**run 1（`…-6762`，@2）**：200 轮全部执行完毕、10 项检查全部算完、payload 与
6 份快照已落盘，但**清单发射器缺 `supersedes` 字段**在写 manifest 时崩溃
（发射器 bug，`b9deca7` 修复）⇒ 该 run 无 manifest，聚合器按 L-M61-14 先例读
REFUSED（留档不判）。其 payload 读数（分析有效、判定链无效）：

- ✅ LL-TURNS 200/200（零泄漏）· ✅ LL-SEVERE **0**（诱导三位置稳定拒绝；
  遗忘后探针 #42 **干净**——F-1 未在长集复现，全局 2/7）· ✅ LL-C1–C4
  （形成/更正/遗忘/长距离 +40 轮稳定）· ✅ LL-MARKERS 10/11=90.9%
  （唯一缺 = #200 终态读回，与 F-4 一致：她诚实说没有）· ✅ LL-DB 真实库
  摘要逐字相同；
- ❌ LL-C5 / LL-C6：**F-4**（见 §F-4）——同内容重述未重建记忆/信念。

**run 2（`m9-live-long-20260927-b9deca78f2b9-8706`，`b9deca7` 修复后重跑，
同一冻结语料 @2，完整证据链）**：**FAIL 8/10——与 run 1 逐字一致，F-4
确定性复现**（LL-C5：重述后 active 记忆=0 · 信念=0；LL-C6 同根）；其余
全绿：200/200 零泄漏 · 严重项 **0**（#42 干净）· C1–C4 · 词形 ≥90% ·
水位=账本尾（951/951）· 无 failed job · 真实库摘要逐字相同。

**集判定**：最新语料版本集内全部 run 须 PASS（§15.3）；F-4 已裁定 M9.1 修复
（2026-09-27），LL-C5/C6 读数维持红、不因裁定改写。

### F-4. 同内容重述永不复活（长门唯一红项根因；M4 冻结层；需用户裁定）

- **现象**：#101「记住，技术问题我喜欢详细解释。」（与 #1 逐字相同）——
  她答「记住了…这事我记下了」（'written' 措辞），但 c5/c6 快照显示
  memory_records 仍 4 条、无新信念；#200（窗口外）她诚实说不知道。
- **取证**（`scripts/m9-long-forensics.ts`，副本只读）：#101 的 trace =
  `written` + `MEMORY_CREATED` 事件 **#550 真的提交了**，memoryId 与 #1
  **完全相同**（确定性内容键）——但投影里该 id 的行仍是 superseded。
- **根因**：折叠器 `applyCreated`（projections/memory.ts :193）对已存在 id
  无条件 no-op——为 D2「同一事实二次抽取」设计（ACTIVE 场景 no-op 正确），
  未区分 SUPERSEDED/RETRACTED。`pipeline.ts` :117 的「忘掉后重说应能重新
  记住」在折叠层从未实现。**回复真话绑定在事件提交上**（提交确实成功），
  与**召回语义绑定在投影上**（no-op）——两者对重述场景分歧。
- **重放一致**：rebuild 与在线折叠同语义 ⇒ 语义缺口，非账本分歧。
- **变通**：换措辞重述（不同内容键 ⇒ 新 id）正常重建；不同取值/限定词同理。
- **三选项**（修复 = M4 冻结区 reducer 语义变更 ⇒ 新里程碑 + ADR + 全套
  m4:* 门）：
  - **① 修折叠器**：`applyCreated` 区分「已存在且 ACTIVE」（维持 no-op，
    D2 语义不变）与「已存在且 SUPERSEDED/RETRACTED」（复活为新 revision
    或重建 active）——语义变更面窄但触碰冻结区，需 ADR + m4 全量回归；
  - **② 修发射侧**：重述场景在显式服务层改走新 id（内容键加盐/带
    re-statement 代次）——不碰折叠器，但改确定性 id 契约（幂等重建依赖
    内容键），影响面可能更大；
  - **③ 接受为已知局限**（L-M9-19），交 M9.5/M10 处理，M9 按工程面收口。
- **裁定（2026-09-27，用户）**：**M9.1 修复**——冻结区 reducer 语义变更届时
  走「新里程碑 + ADR + 全套 m4:* 门」程序，选项 ①/② 的取舍届时定。
  **本读数不因裁定改写**：Live Long 维持 NOT PASS（LL-C5/C6），登记册 R-21
  触发窗口 = M9.1。

### 5.3 全链回归

- `pnpm m4.5:ci` = **EXIT 0**（离线全链；M9 改动零破坏）；
- `pnpm gates:run --lane m9` = **12/12 PASS**（串行 80.1s）；
- `pnpm with-test-model pnpm m4.5:ci:full` = **EXIT 0**（含 Production-copy
  Live Smoke **52/0**——M9 改动对 M1→M4.5 真实链路零破坏）。

## 6. WP11 执行记录 = **ACTIVATED**（2026-09-27，载体 ADR-071）

- **授权**：用户本轮显式批准（M9-D26；同轮分别裁定 F-1/F-4 → M9.1）；
- **激活动作**：`.env` 追加 `CHARACTER_BELIEF_ENABLED=true`（代码缺省仍
  false）+ 合法启动建档（`pnpm chat` 开库即双流追赶，INC-01 状态机全程，
  `cleanClose=true`，零模型调用零对话轮）；
- **启动读数**：流 1 播种 `BELIEF_ORIGIN`（cutover=133=对话账本尾，无尾窗
  ——旧历史零重判）；流 2 窗口 [1,136] · Memory 事件 3 · **形成 1 · 落库 1**；
- **读回**（`scripts/m9-activation-readback.ts`，SELECT-only 真库验收，
  **13/13 通过 EXIT 0**）：恰好 1 条 active reported 信念
  （education.institution = 示例工程科技大学，support=tentative）·
  `BELIEF_INFERRED`=0 · 双流水位 133/136 · 背书记忆逐字未动；
- **摘要链**：激活前 `9990e0d2…`（1211 文件）→ 激活后 `4fc40f6b…`
  （1211 文件；内容差 = 信念事件/投影/水位 + 合法打开的 WAL）；
- **FIRST-USE NOT OBSERVED**：轮级 `belief_context` trace 待首次真实聊天
  （计划 §13 原文要求；不凭配置宣布运行验证通过）；
- **回滚**：删该行即停消费与注入；`BELIEF_*` 事件/投影/水位保留（审计不删）。
