# M9 Acceptance Report —— 验收事实报告

- 日期：2026-09-27（WP10 收口）
- 性质：**事实报告**（判定见 `M9-Gate-Decision.md`；限制见 `M9-Known-Limitations.md`；
  架构见 `M9-Architecture.md`）。只记录测了什么、读到什么、修了什么、坑在哪。
- 证据：`artifacts/m9/<runId>/`（36+ run 在案，失败档分列保留）；live 人审材料在
  `artifacts/m9/local/`（gitignore）。

## 1. 交付面（WP0 → WP10）

| WP | 交付 | 关键读数 |
|---|---|---|
| WP0/WP0-R | 基线 + 准入 + M7 双缺陷最小修复 | admission 一次性 PASS；wp0r 8/8 |
| WP1 | ADR + 验收契约（DESIGN FROZEN） | §20 裁定表 D01…D26 齐备 |
| WP2 | 量具有效性先行 | measurement 20/20（正控/负控/恢复） |
| WP3 | 输入面 + Evaluator | source 26/26（资格矩阵 + 拒绝理由可读回） |
| WP4 | 放行/事件/投影 | verify 54/54 |
| WP5 | 生命周期 + 遗忘传播 | invalidation 39/39 |
| WP6 | 调度 + 装配（双流 + 水位 + 开关） | runtime 28/28 |
| WP7 | Context + 开发者读回 | context 20/20 |
| WP8 | e2e 全链 + 规模门 | e2e 40/48（6 deferred/1 na/1 cancelled 按审计）；scale 5/5（页边界 2000/2001/4001 + 4001 事件重建 + 双依赖图） |
| WP9 | live 门 ×2 + 人审材料 | 见 §3；语料自检两套全绿 |
| WP10 | 收口（本报告 + 聚合器 + 五文档） | m9:gates 聚合器只读索引；m4.5:ci EXIT 0；lane 12/12 |

## 2. 判据修正与工程坑（如实清单，M5.5 格式）

1. **同根去重装配层 EvidenceKind 写错**（WP8 抓到，`7592899` 修复）：
   `buildBeliefContextSection` 检查 `ref.kind === 'conversation'`，但
   `EVIDENCE_KINDS` 只有 `'conversation_event'` ⇒ 永假 ⇒ §9.3 同根去重在装配层
   **从未生效**。部件门（WP7 直测 renderBeliefSection）绕过了装配层所以全绿——
   「部件全绿 ≠ 装起来可用」的又一实例。修复一处字符串；WP7 复验 20/20。
2. **评估器逐值双迭代**（B38，已知噪声不修）：提案数虚高但 Validator 失败关闭、
   append 确定性去重，结果正确（L-M9-17）。读 trace 勿把被拒提案当回归。
3. **live 语料词形覆盖需实测校准**（@1→@2，M5.5.1 先例）：@1 三运行暴露
   mustInclude 漏合法说法（「讲细」「短。先给结论」「跟生气不生气没关系」）；
   @2 扩宽（轮文本/严重项/检查点一字未动），@1 读数保留各有归属。@2 后
   LV-MARKERS 3/3 绿。
4. **wp 字段歧义**（聚合器工程坑）：M9 manifest 的 `wp` 同时撞车（wp0=baseline+
   admission、wp8=e2e+scale）⇒ `m9:gates` 改用 **runId 前缀**分组 + 最长前缀优先
   （否则准入 run 被基线门吞掉——首版实测踩中）。
5. **运行中的门不是 FAIL**（聚合器第二坑）：无清单的 run（长门在跑）首版被误判
   FAIL；修正为「无可判 run ⇒ NOT RUN（运行中或中断）」，有 payload 才进集。
6. **`artifacts/m9/local/` 忘记登记 gitignore**：首跑 level1 被 `git check-ignore`
  机器闸拦下（local_not_ignored，exit 2）——闸起了作用，补 ignore 后重跑
  （`5eae621`）。这正是 M6/M8 同款闸的价值。
7. **T11 探针词形撞意图关键词**（语料设计期抓到）：初稿「你刚才**忘掉**的具体是
   什么？」会触发 forget 意图（'忘掉' anywhere-match）⇒ 改「让我忘的具体是什么」。
   同类：填充轮全部过意图/抽取/信念三表惰性检查（自检 ⑥）。
8. **抽取器自检范围**（自检设计期抓到）：生产里抽取器只跑显式意图轮；自检首版
   对探针轮也跑抽取 ⇒ T03/T16 误报。修正为意图轮才查。

## 3. Live 门读数（生产副本 + 真模型；详见 Gate-Decision §5）

- **Live Short**：6 运行（@1×3 + @2×3）——状态机 **6/6** 全绿；T13 诱导拒绝 6/6；
  真实库摘要 6/6 逐字相同；**F-1 遗忘后复述 2/6**（唯一红项，待裁定）；
- **Live Long**：run 1（@2）200 轮全执行、payload 落盘，但清单发射器缺
  `supersedes` 字段崩溃（`b9deca7` 修复；该 run 聚合器读 REFUSED 留档不判）。
  payload 读数：**8/10 绿**——200/200 零泄漏、严重项 **0**（诱导三位置稳定、
  #42 遗忘后探针干净）、C1–C4（形成/更正/遗忘/长距离 +40 轮稳定）、词形
  90.9%、真实库未动；**LL-C5/C6 红 = F-4**（同内容重述：事件提交但折叠
  no-op，她说「记住了」却永不可召回——M4 冻结层缺陷，取证见
  `scripts/m9-long-forensics.ts`，详见 Gate-Decision §F-4）。run 2（修复后
  重跑）读数回填 Gate-Decision §5.2；
- **结构性边界**：B-INFERRED live 形成不可达（单会话 × 跨 2 会话阈值）——
  形成证据在离线门，读侧由 L14 夹具（受验证测试 ingress）覆盖，6/6 入模绿。

## 4. 三份读数纪律（§15.5，每能力三读）

| 能力 | 程序事实（L2） | 实际入模（trace） | 用户回复（L1） |
|---|---|---|---|
| reported 形成/修订/遗忘 | invalidation 39/39 + e2e | context 20/20 + live belief_context | live 6/6 状态检查点 + 回复词形 |
| inferred 形成 | e2e B14/B15 + runtime | context 20/20 | live 读侧 L14（形成侧 live 不可达） |
| 来源区分/泄漏 | 泄漏断言（内部术语零出现） | belief_context used_belief_ids | 族 1/2 词形 + 人审材料 |
| 诱导抵抗 | —（无状态写入即负控） | s4 零污染检查点 | T13 6/6 + 长门三位置 |

## 5. 全链回归

- `pnpm m4.5:ci` = **EXIT 0**；
- `pnpm gates:run --lane m9` = **12/12 PASS**（串行 80.1s）；
- `pnpm with-test-model pnpm m4.5:ci:full` = **EXIT 0**（Live Smoke 52/0）；
- 真实库：**本里程碑从未打开写入**；全部 live 试验在 `cpSync` 副本，
  树摘要 7/7 次运行前后逐字相同（1211 文件）。

## 6. 偏差与如实记录

- e2e 48 场景中 6 deferred / 1 na / 1 cancelled：按审计裁定分列（B32/B43-recall
  CANCELLED；B06 N/A-v1），不是失败；
- live:level1 @1 的 80% 词形读数与 @2 的复跑**并存**（各有归属，不回写）；
- F-1 在裁定前维持 Live Short = NOT PASS（不因待裁定改绿，也不悄悄修判据）。
