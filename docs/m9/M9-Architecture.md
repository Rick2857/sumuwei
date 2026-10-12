# M9 Architecture —— 信念域（Belief Domain）架构

- 日期：2026-09-27（WP10 收口）
- 权威：`M9-Execution-Plan.md` §5–§11（设计）+ `M9-Acceptance-Contract.md`（冻结契约）+ ADR（belief-perspective-and-revision）
- 状态：**DESIGN FROZEN / IMPLEMENTED**（v1 语义按计划 §20 裁定表执行，M9-D01…D26）
- 读法：本文描述**已建成**的系统（与计划书的"拟议"措辞区别开）；改动判据 = 版本化重评，不静默改语义。

## 1. 一句话

M9 给了她**带出处的看法**：用户明确说过的（reported）与她从提问方式里有限推断的
（inferred）分开建档、分开表达；来源被更正/撤回/遗忘时，依赖它的信念**自动失效**；
全部状态从 append-only 事件重放可重建。

## 2. 四层信息分离（不变量 INV-M9 基座）

```text
① Memory（M4）    ：「用户说过什么」——事实性内容，显式意图驱动
② Belief（M9）    ：「她据此怎么看」——视角持有，依赖 Memory/对话证据
③ Relationship（M7）：关系状态演化                    ┐
④ Affect（M8）    ：情绪状态演化                      ┘ 独立域，不互为事实来源
```

Belief **只从 ① 的合格事件与对话证据**形成；③④ 的输出、assistant 自己生成的内容、
外部搜索结果**都不是**信念输入（B02/B09/B10 负控钉死）。语义情绪判定（M8.5）不是
事实来源（L-M85-17 延续）。

## 3. 语义模型（contracts/belief.ts）

### 3.1 BeliefState（投影行）

```text
beliefId            确定性 id（内容键派生，幂等重建）
owner               entityRef('character', <id>)     —— 视角持有者
proposition         { predicate, value, scopeKey }   —— 命题三件
epistemicKind       'reported' | 'inferred'          —— 两类认知输入
status              active | disputed | superseded | retracted
supportLevel        tentative | supported            —— inferred 专属档位
evidenceRootIds     依据根（conversation 事件 id / memory id）
dependsOnMemoryIds  Memory 依赖（reported 的失效通道）
supersedesBeliefId  修订链前驱
```

### 3.2 两类认知输入（计划 §5.1）

| | reported | inferred |
|---|---|---|
| 来源 | 合格**明确** Memory（显式意图 + ESTABLISHED 归因） | 对话证据的**词形判定**（patterns.ts 纯函数） |
| 槽位 | 任意谓词（跟 Memory 走） | **单一**互动偏好槽 `interaction.explanation_detail`（concise/detailed） |
| 形成阈值 | 1 条合格 Memory 即成 | ≥3 独立根 **且** 跨 ≥2 会话（`BELIEF_INFERRED_MIN_ROOTS=3` / `MIN_CONVERSATIONS=2`，冻结） |
| 档位 | supported | tentative（永不升 supported，v1） |
| 表达 | 「你说过…」 | 「我猜/感觉…」（prompt 标签区分） |

### 3.3 冻结阈值与规则 id（contracts/belief.ts）

`BELIEF_REPORTED_AUTHORITIES`（EXPLICIT_USER_STATEMENT 等白名单）、
`BELIEF_INFERRED_MIN_ROOTS=3`、`BELIEF_INFERRED_MIN_CONVERSATIONS=2`、
推断规则 id（bi-d-like-detail / bi-c-short-speak / bi-c-point-first / bi-c-direct-tell）、
守卫 id（task-scoped / quoted-mention / hypothetical / third-party / question-form /
belief-injection / neutral-comparison / sarcasm / past-preference）。改任何一个 = 版本化。

## 4. 事件与生命周期

### 4.1 事件集（§6.2）

`BELIEF_FORMED` / `BELIEF_EVIDENCE_NOTED` / `BELIEF_STATUS_CHANGED` /
`BELIEF_RETRACTED` / `BELIEF_SUPERSEDED` / `BELIEF_DISPUTED` —— 全部 append-only，
投影（`character_projections` 的 belief 分组）是派生物：删掉可从事件重放，逐字段一致。

### 4.2 状态转换（§6.3）

```text
(形成) ──→ active ──更正(新值同槽)──→ superseded（新 belief 链 supersedesBeliefId）
              │ ──争议──────────→ disputed
              │ ──遗忘/来源撤回──→ retracted
disputed/superseded 不回 active（修订只前进，历史不丢）
```

### 4.3 失效传播（§7，双保险）

- **读时立即遮蔽**：retracted/superseded 的信念不进候选、不渲染；
- **写侧最终收敛**：Memory 的 `MEMORY_SUPERSEDED` / `MEMORY_RETRACTED` 事件由
  reconciler 消费，把 `dependsOnMemoryIds` 命中的信念转 retracted（依赖失效传播）；
- **推断来源可撤回**（§7.4）：inferred 的对话根被撤回 ⇒ 根数跌破阈值 ⇒ 降档/撤回；
- **禁止用 Recall 排名判断依赖**（§7.2）：依赖是**图事实**，不是检索相关性。

## 5. 处理链（§8）

### 5.1 两条链

```text
流 1  belief-interaction-evaluator    对话事件 → 词形判定 → inferred 提案
流 2  belief-memory-reconciler        Memory 事件 → reported 形成 / 失效传播
```

两链都是**事件驱动 + 水位**（`processor_watermarks`，与 M8 affect 同一调度纪律），
两层幂等（确定性事件 id + `processed_operations` 去重）。open-catchup 在启动时补账；
流 1 有 **origin cutover**（首次建档序号，之前的历史零重判——旧历史不回评，L-M9-06），
流 2 **无 cutover**（Memory 事件全部回放——reported 的历史完整性优先）。

### 5.2 装配（main.ts）

- 启动 open-catchup：`maybeRunBeliefEvaluation` + `maybeRunBeliefMemoryReconciliation`
  （main.ts :1502-1514）；
- 轮内 :1637 + 轮后 :2069-2085（两流都在 post-turn hook 里跑）；
- 开关：`CHARACTER_BELIEF_ENABLED`（**代码缺省 false**；生产激活属 WP11 独立裁定 M9-D26）。

## 6. 上下文与用户可见行为（§9）

- **唯一入口**：`buildBeliefContextSection`（turn-gateway 装配层）——信念 section
  优先级可裁，与 Memory/Relationship/Affect section 并存；
- **表达范式**：reported 与 inferred 分开渲染、分开措辞（「你说过」vs「我猜」）；
  内部术语（B-REPORTED/槽位键/cutover）**不进**用户可见面（live 门泄漏断言钉死）；
- **同根去重**（§9.3）：Memory 与其派生 Belief 不同时整句重复渲染
  （EvidenceKind 修复 `7592899` 后装配层真实生效）；
- **trace**：`belief_context` step 记 outcome（included/absent/dropped/failed）、
  candidate_count、used_count、used_belief_ids——「实际入模」可查（§10.2）。

## 7. 持久化与恢复

- 表：`character_domain_events`（事件）+ `character_projections`（belief 投影）+
  `character_jobs` / `processor_watermarks`（两链水位）+ `processed_operations`（幂等）；
- 无新迁移（复用 M5 的 domain-events 基座）⇒ `Database Migration = NONE`；
- 恢复上界：事件在 ⇒ 投影可重建；水位在 ⇒ 不重放已消费；两者都在 ⇒ 幂等收敛
  （规模门 B45：4001 事件重建逐字段一致）。

## 8. 量具与门（§15-§17）

| 门 | 层 | 量什么 |
|---|---|---|
| `m9:test` / `m9:verify` / `m9:invalidation:verify` | 部件/子系统 | 合同、放行、状态机、失效传播 |
| `m9:measurement:verify` | 量具有效性 | 正控/负控/恢复三段式 |
| `m9:source:verify` | 输入资格 | 白名单/归因/跨 owner 隔离 |
| `m9:runtime:verify` / `m9:context:verify` | 装配/上下文 | 调度、水位、入模、开发者读回 |
| `m9:e2e:verify` | 全链 | B01–B48 场景矩阵（真网关轮） |
| `m9:scale:verify` | 规模 | 分页水位/投影重建/双依赖图修订稳定 |
| `m9:live:level1` / `m9:live:long` | 真实链路 | 生产副本 + 真模型 + 交互控制台（§15.3） |

Live 门**不在** `gates/manifest.ts` 的 m9 lane（要 `with-test-model`；M8 先例），
登记为 package.json 脚本；`m9:gates` 聚合器只读证据、按语料版本分集。

## 9. 与相邻域的边界

- **不改变** Memory Kernel 语义（冻结区）：Belief 只**消费** Memory 事件；
- **不改变** Seed 核心价值观（L-M9-11）：信念是看法持有，不是人格重写；
- **不引入**外部能力（`External Capability Added = NONE`）；
- M10 Goal 依赖的 Belief 被撤回 ⇒ M10 必须重查（§24 边界 3）。

## 10. 已知架构级边界（详见 Known-Limitations）

- B-INFERRED 形成侧在 live 控制台**结构上不可达**（单会话 × 跨 2 会话阈值）——
  形成证据在离线门，读侧由 L14 夹具（受验证测试 ingress）覆盖；
- 呈现层遗忘泄漏（F-1）：状态层撤回正确，但上下文窗口里的原始对话行仍可被
  模型引用（M4 政策无后续轮复述条款）——处置见 Gate-Decision；
- 评估器逐值双迭代（B38 已知噪声）：提案数虚高但 Validator 失败关闭，结果正确。
