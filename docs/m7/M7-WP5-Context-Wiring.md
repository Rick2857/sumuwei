# M7-WP5 · Context 与行为接线（唯一注入块 + 桥接 + 播种 + 读回）

> 日期：2026-09-26。状态：**WP5 交付**。语义权威：[ADR-064](../adr/ADR-064-m7-relationship-semantics.md) §6（本轮增补 WP5 落地记录：桥接取**退役**形）。
> 计划对应：[`M7-Execution-Plan.md`](M7-Execution-Plan.md) §5 WP5——出口"关系状态唯一注入块；trust/closeness 联合行为规则；只读 Inspector/读回"。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| [`src/kernel/contracts/relationship.ts`](../../src/kernel/contracts/relationship.ts) | `renderRelationshipGuidance`：关系注入块的**确定性渲染**（同态同文，逐字节可复现）；L1-M2 验收的分档措辞与**联合行为规则**逐字移植；未建档 ⇒ `undefined` |
| [`src/kernel/context/sections.ts`](../../src/kernel/context/sections.ts) | `SECTION_IDS.relationship` + `createRelationshipProvider`（kind `'relationship'` · priority **55** = M3 契约预留值 · droppable）+ `buildContextCompilerV2` 的 `renderRelationship` 选项 |
| [`src/kernel/app/turn-gateway.ts`](../../src/kernel/app/turn-gateway.ts) | `CompileTurnInput.relationshipSection`（数据注入，与 `stateSection` 同一纪律；两遍编译同一装配） |
| [`src/kernel/app/flags.ts`](../../src/kernel/app/flags.ts) | `CHARACTER_RELATIONSHIP_CONTEXT_ENABLED`（缺省 **off**；先例 ADR-048"接线就位、激活另裁"） |
| [`src/infrastructure/runtime/adapters.ts`](../../src/infrastructure/runtime/adapters.ts) | `renderRelationshipSection`（投影 → `effectiveRelationship` 读时视图 → 契约渲染）· `seedRelationshipOrigin`（放行链播种，幂等）· `renderRelationshipReadback`（`--inspect` 读回块） |
| [`src/state/provider.ts`](../../src/state/provider.ts) | 桥接：`renderStateBlock` 增 `relationshipAxes` 选项（缺省 true = M2 验收形态逐字不变；false = 退役关系轴只剩情绪） |
| [`src/main.ts`](../../src/main.ts) | 三处消费：`open()` 播种（干跑跳过）· `send()` 轮次装配（桥接 + 关系 section）· `--dump-prompt`（与真实链路同形）· `--inspect` 追加读回 |
| [`scripts/m7-wp5-verify.ts`](../../scripts/m7-wp5-verify.ts) | 部件门（`pnpm m7:wp5:verify`）：三段式 14 项 |

## 2. 桥接裁定（ADR-064 §6 留给 WP5 的选择）

ADR 给了两个选项：legacy 从投影读（桥接）或退役。**取退役**，理由：

```text
· "单一注入块"不允许同一数值出现两次：若 legacy 块（bridged）与关系
  section 都渲染 trust/closeness，prompt 里就有两份（还可能因两套衰减
  结算时点不同而互相矛盾）。
· 退役让链路可分辨：critical-state = M2 情绪（归 M8），relationship =
  M7 投影（唯一权威）。Trace 里两条链的 sourceRefs 不同
  （projection:character-state:* vs projection:relationship:*）。
· 影响半径审查（ADR 指派给 WP5）：legacy 关系轴无每轮写者（只有
  bootstrap 建档 + 读时衰减），退役无僵尸写者；衰减参数同源
  （24h/0.02/天/trust 恒定）、初始值同源（0.85/0.60）⇒ 值兼容无跳变。
· 联合规则的 closeness 支（"藏短平句"的 <0.4 形态）随关系轴一起进
  契约层渲染；valence 支留在情绪块——两支不丢。
```

## 3. 开关与回滚

```text
CHARACTER_RELATIONSHIP_CONTEXT_ENABLED（缺省 off）
  on  ⇒ 播种 ORIGIN（首次启动写一条域事件）+ 每轮渲染关系 section
        + legacy 状态块退役关系轴
  off ⇒ 三处全部回到 M6.1 形态（renderStateBlock 缺省含关系轴、
        无播种、无关系 section）——N3 逐字验证的回滚形态
回滚 = 改回 false（不需要迁移：关系投影行留在库里也无害，只是不被读）
```

⚠️ **本 WP 没有做生产激活**（`.env` 未动）：激活属独立裁定（WP6/WP7 阶段，
先例 ADR-048）。开关的三个消费点都在 `main.ts`（D3 教训：开关必须被真的
消费——`m4:test` / `m4.5:test` 的静态锁全绿）。

## 4. M3.5 基线为什么不用重刷

基线构造器（`buildBaselinePrompt`）与合成轮次**不传** `renderRelationship`
⇒ provider 产 0 个 section ⇒ prompt 逐字节不变（`m3.5:test` 30/0 实测）。
这与 clock / stateSection / rollup 是同一注入纪律（"不传就安静"）。
ADR §6 的"区段新增 ⇒ 基线重刷"前提是区段进基线——这里刻意不进：
生产 prompt 的真实变化由本门 P8（装配一致：同一编译器、基线无关系段）
+ WP6 Live Smoke 验证。

## 5. 量具读数

| 门 | 退出码 | 读数 |
|---|---|---|
| `pnpm m7:wp5:verify` | 0 | **PASS 14/14**（正控 8 · 负控 4 · 恢复 2 · 渲染变体 108 > 0）；runId `…-wp5-verify-…-2cb1`（首跑 `-baac` FAIL 10/14：四项全是**量具自身**的错——档位边界算错 / 侵蚀算错 / 裸词误伤合法缺席说明 / 对象引用 ===，已修并记录） |
| `pnpm m3.5:test` | 0 | 30/0——prompt 逐字节基线**不变** |
| `pnpm eval:scenarios` / `eval:dryrun` / `eval:providers` | 0 | 7/0 · 17/0 · 11/0 |
| `pnpm kernel:test` / `kernel:verify` | 0 | 26/0 · 25/0 |
| `pnpm m4:test` / `m4.5:test` | 0 | 258/0 · 135/0（开关消费锁） |
| M7 链复验 | 0 | WP2 37/37 · WP3 18/18 · WP4 20/20 |

## 6. 已知边界（本 WP 不主张什么）

```text
✗ 不主张 Live Smoke / Level 1：她的真实回复是否随关系变化 = WP6 的
  隔离库真 TurnGateway + 真模型工作（计划 §7.2：Level 1 回复与 Level 2
  事件/投影/来源逐项一致）。
✗ 不主张生产激活：开关缺省 off，.env 未动（上表 §3）。
✗ 情绪轴（valence/arousal）仍是 M2 legacy：M8 的 affect section
  （priority 52 预留）才取代它；本 WP 只退役了关系轴。
✗ 措辞层不加启发式守卫（DR-11 同源）：N2 的词形扫描是**量具断言**
  （证明渲染器不产出编造词形），不是运行时守卫。
✗ R-1 锚点语义的已知行为（§5.1 ④）：日常闲聊不触发规则 ⇒ 锚点不前进 ⇒
  侵蚀继续——关系 section 会如实显示"距上次互动 X 小时"。这是契约语义，
  不是接线缺陷；校准归规则集（WP3 已冻结）。
```

## 7. 下一 WP 入口

```text
WP6 —— 真实链路与长轨迹（计划 §5：隔离库 + 真 TurnGateway；短场景、
  长轨迹、重启恢复、人工盲审包）
  前置：全链路已接线（WP4 折叠 + WP5 注入），开关在手
  交付：隔离库端到端——开关 on 的真实一轮（Level 1 回复随关系变化 +
  Level 2 同 conversationEventId 关联提案/事件/投影/Context 选择/读回）；
  长轨迹（复用 M6.1 同等级连续性验证）；重启恢复；TD-06 仪表 / TD-07 预检
  出口：失败不伪装成通过；人工盲审包（计划 §7.2 真人复核四查）
```
