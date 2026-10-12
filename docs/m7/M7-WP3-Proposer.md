# M7-WP3 · 关系提案器（规则集冻结 + 评估器）

> 日期：2026-09-26。状态：**WP3 交付**。语义权威：[ADR-064](../adr/ADR-064-m7-relationship-semantics.md)（附录 A 规则集已按用户裁定「按提案执行」冻结）。
> 计划对应：[`M7-Execution-Plan.md`](M7-Execution-Plan.md) §5 WP3——"关系证据与提案器"。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| [`src/kernel/app/relationship/patterns.ts`](../../src/kernel/app/relationship/patterns.ts) | 冻结模式清单（18 条模式 + 句级守卫）与匹配器：句界切分 · 守卫抑制 · **问句抑制**（疑言语气不作断言触发）· **指控优先**（同句 r3 在场则 r2/r4 作废） |
| [`evals/fixtures/m7/relationship-rule-corpus.json`](../../evals/fixtures/m7/relationship-rule-corpus.json) | 120 条对抗语料（R-2/R-3/R-4 各 20 正控 + 20 负控；负控覆盖反讽/转述/条件/引用提及/否认框架/方向反转/过去时指涉） |
| [`scripts/m7-wp3-probe.ts`](../../scripts/m7-wp3-probe.ts) | 精度探针（`pnpm m7:wp3:probe`）：三族 precision ≥ 0.90 才冻结；确定性自证 |
| [`src/kernel/app/relationship/evaluator.ts`](../../src/kernel/app/relationship/evaluator.ts) | `RuleBasedRelationshipEvaluator`（`relationship-evaluator@1`）：Tier 1 证据分组 → 冻结规则评估 → `RELATIONSHIP_IMPACT` 提案；含领域幂等键推导 |
| [`scripts/m7-wp3-verify.ts`](../../scripts/m7-wp3-verify.ts) | 部件门（`pnpm m7:wp3:verify`）：三段式 18 项 |

## 2. 冻结程序的实际执行（量具有效性先于实现——M6-FMB-01 §3 硬顺序）

```text
① 判定契约：ADR-064 附录 A（用户 2026-09-26 裁定「按提案执行」）
② 语料先行：120 条对抗形语料独立成文、进 git（改一条 = 改判据）
③ 探针读数（三份，各有归属、互不覆盖）：
   c6c6  首跑：probe.json 有读数但 manifest 写入失败——量具自身的 counts 形状缺陷
         （m7-manifest@1 要求 total/passed/failed 整数），已修；读数保留
   475e  PASS @ precision 90.9%（r2 FP×2：条件句漏守卫；r4 FP×2：问句守卫失效——
         「？」是分句符，先被吃掉，含「？」的守卫永远匹配不到）
   f68a  PASS @ precision/recall 100%（收紧后：R-2 全模式补条件守卫 + 匹配器加问句抑制
         + 删三个死守卫）——**本读数是模式清单的冻结依据**
④ 收紧方向合规：只加守卫/加抑制（收紧），未放宽任何判据（附录 A 允许收紧直接生效）
```

探针主张的是「冻结清单在对抗形语料上的精度」，**不是**真实世界分布精度
（语料为人工对抗形集合；真实分布需要真实对话与隐私审查，另行授权）。

## 3. 评估器行为（与附录 A 逐条对应）

```text
证据入口   只有 user_message 且 sourceQualificationOf = ESTABLISHED 进规则输入；
           按内容来源用户分组（多用户各自成组——关系是 per-target 的）
R-1 陪伴    窗口 ≥10 条 · 跨 ≥2 自然日（UTC+8 固定偏移）· 无 R-3 命中
           → 每个自然日一个单元 {0,+0.02}；同窗口 R-3 命中则整窗停计
R-2 正反馈  窗口聚合一条 {+0.02,+0.02}（同窗口多次命中只计一次）
R-3 负面    窗口聚合一条 {−0.05,−0.02}（closeness 刻意不清零）
R-4 修复    前置 = 在案指控（activeAccusationEventIds）或窗口内 R-3 命中；
           纯修复 → update {+0.03,0}；撤回形（r4b）→ supersede + supersedes 指向
           最新在案指控（部分恢复，不满血）；无在案 → 不触发（0 提案）
R-5 里程碑  两条独立轨道（每 100 条合格消息 / 每 30 活跃日），跨过才计 {0,+0.03}；
           计数由 Job 层从账本派生（缺键 = 失败关闭不猜）
防御自检   每次评估先 assertRelationshipRulesWithinBounds()——冻结规则表任何 delta
           超界 = 规则表被改坏，宁可失败不产出非法提案
```

**幂等键（领域推导，WP4 接线时替换通用 `idempotencyKeyFor`）**：
第五分量 = `${operation}:${ruleId}:${unit}`（与 `idempotencyKeyForMemory` 同一手法）。
⚠️ R-1 的 range 分量**刻意置零**：陪伴单元的幂等身份是
`(character, processor, version, rule, 自然日)`——两个不相重叠的窗口可以都包含
同一自然日，range 进键会让同一天被计两次；置零让跨窗口同日提案**必然撞键**
（"同一天最多计一次单元"的机器保证，部件门 P7 验证）。这与 memory 的
"区间进键"方向相反但各有其理：那边是 supersede 语义，这边是日上限语义。

## 4. 量具读数

| 门 | 退出码 | 读数 |
|---|---|---|
| `pnpm m7:wp3:probe` | 0 | **PASS**：r2/r3/r4 三族 precision = recall = **100%**（120 条；确定性自证 true）；冻结依据 = `…-f68a` |
| `pnpm m7:wp3:verify` | 0 | **PASS 18/18**（正控 9 · 负控 7 · 恢复 2） |
| `pnpm typecheck` | 0 | 干净 |
| `pnpm kernel:test` / `kernel:verify` | 0 | 26/0 · 25/0（依赖方向边界组：app/relationship 只 import contracts ✓） |

## 5. 已知边界（本 WP 不主张什么）

```text
✗ 不主张放行：评估器只提案；Validator（证据资格复核 · 界 · 建档存在性 · 取代链）
  归 WP4——提案不得直接落库是本 WP 的出口条件，部件门不打开任何数据库。
✗ 不主张 Job 接线：水位推进 / 事件窗口读取 / 里程碑计数派生 / activeAccusations
  查询都是 WP4 的装配工作；本 WP 的输入契约（RelationshipEvaluationInput）已把
  形状钉死。
✗ 不主张语义覆盖：词法规则看不见全部反讽/引用/转述（附录 A 如实登记）；
  失约检测（承诺-兑现）明确不做，留给 D-4 预留的 LLM evaluator 位。
✗ 不主张真实世界精度（见 §2）。
```

## 6. 下一 WP 入口

```text
WP4 —— Validator / Reducer / Projection / 装配
  前置：WP2 合同（12 个拒绝码登记表）+ WP3 评估器（提案形状 + 幂等键推导）都已就位
  交付：relationship Validator（消费 RELATIONSHIP_REJECTION_CODES + 幂等键接线）·
        RelationshipReducer（纯折叠：ORIGIN 建档 / IMPACT 有界变化 + 事件间侵蚀结算
        ——ADR-064 §5.1 澄清）· 投影持久化（新迁移版本号，DDL 只追加）·
        createFullDomainEventRegistry 接入关系类型 · Job 装配（水位/计数/在案查询）
  出口：乱序/重复/超界失败关闭；删投影 → rebuild → 逐字段一致（kernel:test 投影组）
```
