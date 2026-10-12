# M9 WP8 交接单 —— 验收门矩阵（e2e 全链 + 规模门）

- 日期：2026-09-27
- 分支：`feature/m7-relationship`
- 基线：`dbe24ae`（WP7 收口后的 e2e 初版）→ `7592899`（生产修复）→ `b014966`（e2e 门修绿）→ `dfb5e71`（e2e 证据）→ `4919fcb`（规模门）→ `68c6b0c`（规模证据）→ §16.2 登记（本轮）
- 权威：计划 §14（场景矩阵）+ §16.2（命令登记）+ `M9-M95-Overlap-Audit.md`（范围修订，`be8d1cf`）
- 门：
  - `pnpm m9:e2e:verify` = **48 场景 · pass=40 fail=0 deferred=6 na=1 cancelled=1 · EXIT 0**（runId `m9-wp8-e2e-20260927-b014966206fa-cee8`，head 匹配）
  - `pnpm m9:scale:verify` = **5 场景 · pass=5 fail=0 · EXIT 0**（runId `m9-wp8-scale-20260927-4919fcb9dbaa-d819`，head 匹配）
  - `pnpm m9:context:verify` = **20/20 PASS**（EvidenceKind 修复后复验，runId `m9-wp7-context-20260927-b014966206fa-1557`）
  - `pnpm gates:run --lane m9` = **12/12 · EXIT 0**（墙钟 78.9s；11 道真 PASS +
    `m9:wp0:admission` 按一次性准入记录接受——它断言开工前基线，M9 建成后
    按设计翻红 18/25，当前态权威 = `m9:wp0r:verify` PASS；先例 `inc-01:gates`）

## 1. 范围修订（审计裁定，本 WP 执行的边界）

| 场景 | 处置 | 依据 |
|---|---|---|
| B32（更正后 60/200/500 轮追问） | **CANCELLED**，`m9:long:verify` 不建、不在 M9 出证据 | 审计 §3.1 裁定一（与 M9.5 迭代关系；落后一代建设取消） |
| B43 Recall 半边（候选范围如实报告） | **CANCELLED**，移交 M9.5 TD-08（S31/S32） | 审计 §3.1 裁定二 |
| B43 信念半边（核心依赖 ID 回查完整） | **保留**，迁规模门执行 | 审计 §3.1 |
| B42 / B45 / B47 | **保留**，迁规模门执行（非迭代：分页水位 / 投影重建 / 修订稳定性是 M9 独有契约；M9.5 的 S32/S34/S44/S53 量的是语义索引，不同派生物） | 审计 §3.2 |
| B06（world fixture） | **N/A-v1**，如实记理由不造假 world | 计划 §14.1 + WP7 交接单 |
| 其余 B01–B31 / B33–B41 / B44 / B46 / B48 | e2e 门全链执行 | 计划 §14 |

## 2. 交付物

| 文件 | 内容 |
|---|---|
| `scripts/m9-e2e-verify.ts` | WP8 门 1：B01–B48 全链场景矩阵（真网关轮 + 真双流 + 真召回端口），每场景落 source/event/revision/入模四件 |
| `scripts/m9-scale-verify.ts` | WP8 门 3：B42/B43 信念半/B45/B47 规模门（页边界 2000/2001/4001 + 4001 事件重建 + 双依赖图修订稳定） |
| `package.json` | `m9:scale:verify` 注册（点追加） |
| `scripts/gates/manifest.ts` | `M9_GATES` 组（12 门）+ `m9` lane——照 TD_GATES 纪律**不并入** offline 链（那条 lane 的「与 m4.5:ci 逐条等价」声明保持为真） |
| `scripts/gates/affected-map.ts` | 信念域路径规则：改评估器/校验器/合同/投影/调度/装配 ⇒ 自动带出 7 道 m9 门 |
| `src/infrastructure/runtime/adapters.ts` | **生产修复**（见 §3.1） |

## 3. 本轮抓到的两个真问题（e2e 的存在意义）

### 3.1 生产缺陷：同根去重装配层 EvidenceKind 写错（已修，`7592899`）

`buildBeliefContextSection` 从 `record.sourceRefs` 推导 memoryCoveredRoots 时检查
`ref.kind === 'conversation'`——但 `EVIDENCE_KINDS`（contracts/memory.ts）里只有
`'conversation_event'`。**永假 ⇒ §9.3 同根去重在装配层从未生效**（本轮召回选中了
同根 Memory，全句照样重复渲染）。WP7 门没抓到它，因为 WP7 直测
`renderBeliefSection`（部件层），绕过了装配层的 sourceRefs→roots 推导——
"部件全绿 ≠ 装起来可用"（AGENTS §6.1）的又一实例。修复 = 一处 kind 字符串；
WP7 门复验 20/20，e2e B36 转绿。

### 3.2 已知行为（不修，如实登记）：评估器逐值双迭代（B38）

`runBeliefInteractionWindow` 对 `INFERRED_VALUES` 每个值各调一次
`evaluator.process()`，而评估器内部 byValue 循环**每次都处理全部命中值**——
用当次迭代的单值 slotState。后果：槽位有 concise-active 而无 detailed-active 时，
detailed 迭代会用错误 slotState（activeBelief=undefined）提出一个**伪 FORMED(concise)**
提案；Validator 的同值闸 fail-closed 拒绝（`belief_slot_already_active`）。
EVIDENCE_NOTED 提案被两轮迭代各提一次，在 append 处按确定性事件 id 去重
（accepted=8 / createdEvents=0）。**系统失败关闭、无数据损害**；冻结评估器
未动（§14：改判据 = 版本化重评）。B38 断言 = 零新建事件 + 零重复行 + 拒绝码
全部可解释（`duplicate_operation` ∪ `belief_slot_already_active`），机制写进场景注释。
**WP9/WP10 注意**：这是"提案数虚高但结果正确"的已知来源，读 trace 时不要把
rejected 提案数当缺陷信号；若未来要修，走版本化重评程序。

## 4. e2e 门修绿过程（9 轮迭代，全部如实记录在提交链）

| 轮次 | 主要发现 | 修法 |
|---|---|---|
| 1（8 FAIL） | memSeq id 漂移（B04 的外根 Memory 也消耗计数器 ⇒ 全部硬编码 `mem-m9-wp8-00N` 错位） | id 一律走返回变量（`memB01Id`/`m2Id`/`m3Id`）——B22/B25/B26/B27/B36 级联全解 |
| 2 | B09：externalEvidence 挂错层（应在 turn 上）+ 预算 0（缺省永不注入）+ 夹具形状错 | 挂 `IncomingTurn.externalEvidence` + `externalEvidenceTokens: 800` + 真 ExternalEvidence 契约形状 |
| 3–6 | B38 逐轮插桩（proposals/accepted/窗口 dump/处理器 dump） | 定位双迭代机制（§3.2） |
| 7 | B44：关闭期文本不命中冻结词形（原选词全部弃权） | 从词形表重选（'以后都长话短说' 等） |
| 8 | 召回探针崩溃：B23 episode 夹具缺 `participants`（渲染器在召回扫描时崩） | 补 `participants: [USER_ENTITY], eventRefs: []` |
| 9 | B36：召回选中但去重不触发 | **§3.1 生产缺陷**——修装配层 |
| 10–11 | B36：M5 值拉丁文 + 中文问句 = 永远 LOW_RELEVANCE（`preference.answer_length` 未登记进谓词登记表 ⇒ 可搜索面只有 predicate+value 本身） | M5 值改中文'结论先行'（可搜索）；**登记表缺口本身是 M9.5/M10 的登记事务，不在本门修** |

删除的文件：`scripts/m9-wp8-diag-b22.ts`（B22 机制在隔离下证明成立后功成身退；
真根因是 id 漂移）。

## 5. 规模门判据（B42 的形状学）

共享计数器真相：域事件与对话事件共用 `character_sequence_counters`——锚点
MEMORY_CREATED 与评估器自己的 EVIDENCE_NOTED 都推高 latest。因此规模门
先**纯灌 4000 条对话事件**（页边界精确落在 2000/2001/4001），交互流一次追赶：

```
窗口 = [1..2000 | 2001..4000 | 4001..4001]
连续无缝 ✓ 页宽≤2000 ✓ 前两页恰 2000 宽（整页钳位真实吃满）✓
水位推进后 ≤ latest ✓（flushed 结果的 watermark 字段是推进前旧值——量具记窗口 to）
对话全覆盖（水位终 4001）✓ 各页记根 [4,4,2] ✓ 收敛 no_tail ✓
```

域尾（评估自身事件）由后续小窗口诚实消费——这是共享计数器的生产真相，
不是缺陷。B45 在 4001 事件规模下投影删除重建逐字段一致（16 事件重放，
B47 的撤回因果链存活）；B47 双依赖图（不同 processor 身份）产出同一目标
/同一载荷，第三图对已撤回目标重规划 → `clarify/belief_not_active`（确定性下游）。

## 6. §16.2 登记（本轮完成）

- `M9_GATES` = 12 门（WP0–WP8 全部离线门），全部
  `parallel: 'safe' + evidenceWrites: ['artifacts/m9']`（同目录重叠由调度器自动串行）；
- `m9` lane：`pnpm gates:run --lane m9`；`--lane affected` 改信念域路径自动带出；
- **不并入** offline lane / SUMMARY_GATES（`m9:gates` 聚合器属 WP10，届时
  按 B32/B43-recall 的 CANCELLED 处置单独登记）；
- WP9 的 live 门（真模型）**不在**本登记——属 WP9 收口时的独立裁定；
- `m9:long:verify` **永不登记**（CANCELLED，审计 §3.1）。

## 7. 本 WP 不主张什么

- **没有 live 读数**：全部离线（隔离库、无模型）；真实链路属 WP9（live 门 ×3 + 人审材料）。
- **没有生产激活**：WP11（M9-D26）需用户单独授权；合并/打标签同样需单独授权。
- **B32 与 B43-Recall 半边没有证据**：CANCELLED 是处置记录，不是 PASS。
- **M8 人审仍 PENDING**：跨里程碑遗留，不归本 WP。
- **谓词登记表缺口仍在**（§4 轮 10）：`preference.answer_length` 等未登记 ⇒
  词面可搜索面窄；登记属 M9.5/M10 事务。
- **评估器双迭代行为仍在**（§3.2）：fail-closed、无数据损害、冻结面未动。

## 8. WP9 接手须知

1. live 门按计划 §14.5 十族问法造场景，每族至少一个正控 + 一个应保留未知/拒绝的
   变体（不能靠"全部说不知道"拿安全分）；用 `pnpm with-test-model`，测试端点。
2. B38 的 rejected 提案是已知噪声（§3.2），判定器不要把它当回归。
3. 同根去重（§3.1 修复后）在 live 里第一次真实生效——值得在 live 读数里专门
   看一眼"记忆已载 ⇒ 信念只给限定行"是否如预期出现。
4. `m9:gates` 聚合器（WP10）要读的本轮证据：
   `artifacts/m9/m9-wp8-e2e-20260927-b014966206fa-cee8/`、
   `artifacts/m9/m9-wp8-scale-20260927-4919fcb9dbaa-d819/`、
   `artifacts/m9/m9-wp7-context-20260927-b014966206fa-1557/`。
