# M7 验收报告（关系状态与行为）

> 日期：2026-09-26。判定见 [Gate-Decision](M7-Gate-Decision.md)（本文只记事实与偏差）。
> 计划：[`M7-Execution-Plan.md`](M7-Execution-Plan.md) · 设计：[ADR-064](../adr/ADR-064-relationship-semantics.md)。
> 提交链：`feature/m7-relationship` 40 提交（`649fb1b` 计划落库 → `951950d` WP7 门接线）。

## 1. 交付了什么（按计划 §5 的工作包）

| WP | 交付 | 主要提交 |
|---|---|---|
| WP0 | 基线快照 + 准入门 9/9 + TD 接待（TD-06/07/16 派工；TD-08/09 不阻断；L-M61-01…15 处置表） | `7e9d0ac` `890a46a` |
| WP1 | ADR-064 草案 → 用户裁定七项全按推荐冻结 → 附录 A 规则集冻结（r1–r5 + 基线 0.85/0.60） | `3b26b51`…`ffbefac` |
| WP2 | 关系合同（EntityRelationKey / 状态 / 有界 delta / 侵蚀 / 证据等级 / 拒绝码登记表）+ 静态门 37/37 | `84b5b4b` `c694917` |
| WP3 | 确定性规则评估器 + 冻结词形判据 + 对抗语料 + 精度探针（三轮校准）+ 门 18/18 | `5fa2269`…`0419951` |
| WP4 | Validator（唯一放行口）/ Reducer（supersede 反扣）/ 投影仓储 / 评估 Job + 门 20/20 | `30b4e24`…`2713b90` |
| WP5 | 关系注入块（唯一）+ 编译器接线 + 桥接裁定（relationshipAxes 退役可选）+ flag 缺省 off + 适配器（渲染/播种/读回）+ 门 14/14 | `cf3fa4e`…`db77280` |
| WP6 | 攒尾窗调度 + 生产接线（open 追赶 / 轮后触发）+ 离线全链门 21/21（含真 TurnGateway）+ TD-07 销账 11/11 + TD-06 定义冻结与量具 13/13 + 长轨迹冻结单 | `4400ec9`…`985a32b` |
| WP7 | `m7:test` 3/3 · `m7:measurement:verify` 19/19 · `m7:gates`（Hard Gates PASS）+ 收口四件套 | `951950d` + 本提交 |

## 2. 证据链（Level 2 为主；Level 1 待授权）

```text
Level 2（账本/事件/投影/来源，已全绿）：
  同一 conversationEventId 贯穿：用户事件（真 ingress）→ 提案（matchedEventIds）
  → 域事件（sourceConversationEventIds）→ 投影 revision → 注入块 sourceRefs
  → 读回（--inspect）。wp6-verify P3b/G2 逐项断言；负控（她的生成 / 无信封 /
  未确立 / 多目标 / 同窗重跑）全部失败关闭。
Level 1（真模型回复）：NOT RUN——WP6-B 待授权（冻结单已钉参数）。
```

## 3. 场景族覆盖（计划 §6 的 12 族 → 门的映射）

| # | 场景族 | 覆盖门 |
|---|---|---|
| 1 | 初始建档（默认值有来源，不因模型自述改变） | wp4 P1 · wp6 P1 |
| 2 | 可靠互动（有界 delta） | wp4 P2 · wp6 P2 |
| 3 | 失约/伤害（trust 降、closeness 不清零） | wp4 P4 · wp6 P3 |
| 4 | 长期陪伴/修复（分别恢复，不一轮跳满） | wp4 P5 · wp6 P4/P5/P7 |
| 5 | 长时间无互动（契约衰减；回归不自动恢复） | wp5 P5（侵蚀读时派生）· wp6 P5b |
| 6 | 很亲近但不信 / 信而不亲（两维不合并） | wp5 P3 · wp6 P7b（被辜负档）· measurement C2 |
| 7 | 助手虚构共同经历（不推动关系） | wp3 负控 · wp6 N1 |
| 8 | 工具/搜索/系统事件（外部观察非关系事实） | wp3 负控（system_event）· wp6 N3 |
| 9 | 多目标隔离（第二 target 独立） | wp4 N2 · wp6 N2 |
| 10 | 重复、乱序、重启（幂等/版本/重放/失败关闭） | wp4 P3 · wp6 N4/R1/R2/R3 |
| 11 | 纠正或撤回（旧事件保留、取代关系） | wp4 P5（反扣）· wp6 P4 |
| 12 | 长轨迹（M6.1 同等级） | 参数已冻结（1×500）；运行待授权 |

## 4. 判据修正与工程坑（全部留档；FAIL 中间档按 runId 可溯）

1. **侵蚀结算是量具的必修课**（wp6-verify `-ebd5`/`-0ee8` → PASS）：§5.1 的
   事件间侵蚀（(间隔−24h)×0.02 先结算再作用）没算进期望值 ⇒ 三个检查红；
   链路行为全程正确。此后任何关系算式都按"先侵蚀、后 delta、再推锚"推导。
2. **里程碑叠加**：8 窗 R-1 链的第 8 窗恰好跨过 R-5 里程碑 2（第 200 条合格消息）
   ⇒ 3 提案不是 2。量具必须按"合格消息计数"推里程碑，不能按窗口数想当然。
3. **联合档基点**：P7b 的 closeness 基点算错一档（0.41 < 0.5 ⇒ 客气档，
   正确地**不**出"被辜负"）——期望值错，行为对。
4. **Validator 层幂等 ≠ 追加层去重**（N4）：同窗重跑在放行口就被
   `duplicate_operation` 拒（放行 0/新建 0），到不了追加层。量具期望
   "追加层 dedup=1"是错的。
5. **证据资格是提案级判据**（m7-measurement `-ed61`/`-e6b0` → PASS）：
   最小夹具的证据行必须带受信信封，否则放行口在资格检查就拒
   （`relationship_evidence_not_qualified`），到不了要测的那条判据。
6. **拒绝码分层**：来源事件缺位 → `source_event_missing`（提案级）；
   建档缺位 → `relationship_origin_missing`（状态级）。第一版量具把两者
   混为一个码。
7. **Windows 下聚合门不能 spawn `.bin/tsx`**（m7-test `-ae8b` → PASS）：
   `.bin` 里是 POSIX 壳脚本；用 `node + tsx/dist/cli.mjs`（与
   `scripts/gates/manifest.ts` 同一形状）。
8. **TD-06 语料的机器可导性质**（td06 `-bec2` → PASS）：样本正文必须真的
   满足自己标签的操作化判别（uptake 令牌在场/缺席）——3 条样本不满足，
   修正语料而不是放宽判据。
9. **账本计数器 vs 账本最大序号**：水位基准取 `coalesce(max(sequence),0)`
   （账本派生），不用进程计数器——M6.1 §11 的洞（计数器可先于账本）不重蹈。
10. **对话序号单计数器**：门里用户/助手/系统追加共用一个 convSeq 计数器
    （硬编码序号会撞账本计数 ⇒ `conversation_sequence_gap`）。
11. **每轮一条 `TEST_CHARACTER_SIGNAL` 域事件**（wp6b-long `-9b10` 中止 ⇒
    `-de9a` PASS）：M2.5 诊断链（turn-gateway 慢路径）对每条用户事件产出
    一条域事件——生产设计，但读数器初版只查 `conversation_events` 看不见它
    （诊断档 t1 的 signal 在 seq 4，一直都在）。第一次全量跑 cp1 的
    20 事件/账本max 30/trace 10 暴露 ⇒ 读数器补 `character_domain_events`
    计数（冻结单 §8.5），序号算式改 3/轮，域事件总数成为"无意外域事件"
    的第二道机器闸。
12. **预检探针污染轨迹库**（同上）：预检的 9 条探针是**真对话轮**（写账本
    + signal），初版与轨迹共用沙箱 ⇒ 预检改独立一次性沙箱。教训：**任何
    "只是探一下"的真模型轮都是真写入**——隔离边界按"会写库"划，不按意图划。
13. **§8.5 期望表漏计 t80 的 R-2 flush**（wp6b-long `-82c0` t111 中止 ⇒
    `-de9a` PASS）：§8.1 的 revision 表从未漏过 t80（cp100 rev4 =
    ORIGIN+R-2@t30+R-2@t80+R-5@t100），但序号表的 F 计数把它落下了。
    cp100 实测 302/302/104/304 与修正算式精确吻合——**判据转录错，链路
    行为无恙**；两份中止档（`-9b10`/`-82c0`）按纪律留档，其检查点读数
    成为修正表的实测锚。
14. **注入器会话内序号必须逐条 +1**（wp6b-td06 `-9a40` FAIL ⇒ `-0aac`
    PASS；wp6b-level1 `-089a` FAIL ⇒ `-65e1` PASS）：`ConversationRecorder`
    的 `assertSequenceContiguous` 要求会话内序号连续（只有角色级序号允许
    空洞）。注入器把每条目当整轮对（+2）且助手用 `cs+1` ⇒ 双重跳号；
    播种器只写 user 事件也 +2 ⇒ 空洞。修复：逐条 +1。

## 5. 偏差与缝缺口（如实登记）

| # | 偏差 | 处置 |
|---|---|---|
| D-1 | TD-06 定义冻结原派 WP1、长轨迹参数原派 WP1——均未交付（缝缺口） | WP6 在造量具/开跑前补齐（硬顺序：判定契约→量具→读数）；[WP6 交接单 §2](M7-WP6-Real-Chain-And-Trajectory.md) |
| D-2 | `m7:test`/`m7:gates` 按 WP0 交接"不提前注册空壳"的纪律，到 WP7 才接线 | 无影响：各 WP 门全程有独立入口；聚合门只是只读汇总 |
| D-3 | Level 1 / 长轨迹 / Live Smoke 全部 NOT RUN | 授权边界（计划 §7.3："没有真实模型读数时只能标 NOT RUN"）；[冻结单 §7](M7-WP6-Long-Trajectory-Freeze-Sheet.md) |
| D-4 | `d5d36d5` 改了 `src/infrastructure/persistence/`（无来源域事件：RELATIONSHIP_ORIGIN 不带对话来源） | 过 `m4:verify` + `m4:isolation:verify` + `dev-test-guard`；语义是"建档事件无对话来源"的合同显式化，不改既有事件判据 |

## 6. 边界门全读数（收口时点）

```text
typecheck EXIT 0 · kernel:test 26/0 · kernel:verify 25/0
m4:test 258/0 · m4.5:test 135/0 · m4:verify EXIT 0 · m4:isolation:verify EXIT 0
dev-test-guard EXIT 0 · m5:test 30/0 · m5:verify 26/0
m5.1:measurement:verify 16/0 · m4.5:ci EXIT 0（全量离线链）
m7:test 3/3 · m7:measurement:verify 19/19 · m7:e2e:verify(=wp6) 21/21 · m7:gates Hard Gates PASS
m4.5:ci:full（Live Smoke）NOT RUN（需测试端点；与 WP6-B 同一授权面）
```

## 7. 修订节：WP6-B 之后的取代指针（2026-09-26；原文 §2/§3/§5/§6 不回写）

> 本节是 TD-16 三列的"当前"列：下列原文行是 WP7 离线收口时点的历史状态，
> 由本节取代；读数全文见 [Gate-Decision §6](M7-Gate-Decision.md)。

| 原文行 | 取代为 |
|---|---|
| §2 "Level 1（真模型回复）：NOT RUN——WP6-B 待授权" | **已跑**：四车道全绿（长轨迹 1×500 PASS 5/5 · TD-06 PASS 2/2 · Level 1 PASS · Live Smoke EXIT 0 · 52/0）；人审盲审三轮全过（Gate-Decision §6.5） |
| §3 第 12 族 "长轨迹……运行待授权" | **已跑**：`m7-wp6b-long-…-de9a` PASS（500 轮 · 七检查点零偏差 · 注入块 500/500） |
| §5 D-3 "Level 1 / 长轨迹 / Live Smoke 全部 NOT RUN" | **取代**：三者均已运行且通过（授权 2026-09-26，并发 3）；判据修正 11-14 条（§4）即本次运行的留档 |
| §6 "m4.5:ci:full（Live Smoke）NOT RUN" | **已跑**：EXIT 0 · Production-copy Live Smoke 52/0（证据在 `artifacts/m4.5/`，M7 只引用） |

**Original Lv1（M6 遗留"状态演化延期至 M7"）**：随本修订节**关闭**——
M7 交付关系状态演化，离线面全绿 + 真模型四车道读数 + 人审盲审全过。
M6 历史读数（`Original Lv1 = PARTIAL`）不改写。

**宣告依据（六项分列终态）**：设计批准（ADR-064）· 已实现 · Hard Gates
PASS（13/13）· 语义评估双面 PASS（离线 + 真模型）· Live Smoke PASS ·
生产激活**未激活**（flag 缺省 off——机制如此设计，激活是独立裁定，
不因完成而自动发生）。判定载体 = Gate-Decision（§0 历史 + §6 修订）；
标签 `m7-complete`（`c8afc59`）。
