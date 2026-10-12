# M8 WP3 交接单 —— Evaluator、Validator 与 Job 编排

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP3
> 证据：`pnpm m8:wp3:verify` = **PASS 35/35**
> （`artifacts/m8/m8-wp3-verify-20260926-a82080865706-<final>/`，取代链见 §4）
> 下一站：WP4（持久化、调度与接线）

## 1. 交付物

| 交付物 | 位置 | 内容 |
|---|---|---|
| 评估器 | `src/kernel/app/affect/evaluator.ts` | `RuleBasedAffectEvaluator`（`affect-evaluator@1`）：`qualifiedAffectEvidence`（资格四条：user_message + ESTABLISHED + active user + 切换后）→ 逐事件 1 touch + 至多 1 主导 impact（M8-D07/D08）；`assertAffectRulesWithinBounds` 启动自检（规则表被改坏 = 抛错不产出） |
| 唯一放行口 | `src/kernel/policies/affect-validator.ts` | `validateAffectProposal`：类型 allowlist → 结构判据（登记码优先）→ registry 兜底 → owner → originKind 开闸表 → 建档存在性 → 证据三层（存在/归属/资格四条 + payload 对位）→ IMPACT 专属（规则/版本/界）→ scope → 幂等；`idempotencyKeyForAffectEvent`（领域键推导，range 恒置零） |
| Job 编排 | `src/kernel/app/affect/job.ts` | `runAffectEvaluation`（窗口 → 视图 → 评估 → 逐提案放行 → 单 reducer 落库）+ `affectEvaluationIdempotencyKey`（区间键）+ dryRun 试算出口（零副作用） |
| 部件门 | `scripts/m8-wp3-verify.ts` | 三段式 35 项（正控 10 / 负控 22 / 恢复 3），内存依赖、不开数据库 |
| package.json | `m8:wp3:verify` | 点状追加 |

## 2. 关键语义（实现锚点，全部指向 ADR-066）

- **逐事件 vs 按窗口聚合**（与 M7 的结构性差异）：M7 的 r2/r3 是"窗口内命中即一次"；
  M8 情绪逐条消息算数——每条合格用户事件 1 TOUCH + 至多 1 主导 IMPACT（M8-D08）。
- **TOUCH 与 IMPACT 是两个独立提案**：touch = "合格交互已消费"（结构性事实），
  impact = "主导规则命中"（规则判断）。规则表出 bug 只拒 impact，不把交互本身
  一起拒掉（touch 被拒 = 事件未消费 = 下次重提；语义各归各）。
- **幂等键 range 恒置零**（比 M7 的 r1/origin 理由更强）：Affect 的幂等身份是
  `(character, processor, version, <unit>)`，unit = sourceEventId（touch）/
  ruleId+sourceEventId（impact）。同一来源事件会被不相重叠的窗口重复覆盖
  （失败重试 / 启动 catch-up / 尾部补消费）——range 进键会让同一事件被计两次。
  置零让跨窗口同源提案**必然撞键**（P10 正控 + N18 重放负控）。
- **payload 对位检查**（⑥b，M8 新增）：payload 声称的 `sourceEventId` 必须在
  提案合格证据集合里——防"因果集合格但 payload 指向别的事件"的装配错位（N19）。
- **证据三层在目标级一次查完**：存在（source_event_missing）→ 归属
  （source_event_foreign）→ 资格四条（affectEvidenceVerdictOf，cutover 来自
  投影状态）。ORIGIN 不查证据（凭据是激活授权，与 M7 origin 同构——P9）。
- **REJECT 是正常结果**：被拒提案记录在案、不重试、不让整批失败（R1 证明
  全负控之后合法提案照常放行）。
- **单投影 reducer**：affect:character 不分片，`reducers = [affectReducerFor(characterId)]`
  ——与 M7 的 per-target 装配是另一处结构性差异。

## 3. 量具读数

- 正控 10：P1 感谢（touch+impact+冻结 delta）/ P2 中性只 touch / P3 敌意 /
  P4 主导裁定（感谢+紧急 → A-URGENT）/ P5 逐事件（3 touch + 2 impact）/
  P6 语义幂等 / P7-P9 Validator 三类放行 / P10 幂等键撞键。
- 负控 22：评估器 6（她的回复 / Axis B / 非 active user / 切换前 / 系统事件 /
  无信封 → 0 提案）+ Validator 16（未建档 / 未知规则 / 版本 / 界 / owner /
  注入 / 重复建档 / 证据三层 × 3 / 幂等重放 / 对位 / 类型 / NaN）。
- 恢复 3：全新依赖重新放行 + 全负控窗口后重新产出 + 资格筛选复原。
- `pnpm typecheck` EXIT 0 · `pnpm kernel:test` 26/0 · `pnpm kernel:verify` 25/0。

## 4. 失败档记录（如实登记）

| runId | 判定 | 原因 | 处置 |
|---|---|---|---|
| `m8-wp3-verify-…-9697` | FAIL 34/35 | **P6 抓到判据错误**：判据要求 payload 跨调用逐字节同形，但 ADR-066 §3 把 `proposalId` 冻结进 payload（每实例关联字段，两次调用必然不同）。幂等的机器保证在幂等键（P10/N18），不在 payload 字节同一 | 修判据：语义同形 = 除 proposalId 外逐字节一致 + 幂等键单次落库；重跑 PASS（`--supersedes …-9697`） |
| （同轮两次崩溃） | 无判定 | 夹具缺陷：`evaluate()` 缺省 `cutoverSequence=10` 把全部夹具事件（sequence 1-4）滤成"切换前"⇒ 0 提案 ⇒ `p1Touch!` 空引用崩溃 | 夹具缺省改 0（事件全部切换后）；N15 用独立 state（cutover=100）保住切换前负控 |

## 5. 给 WP4 的输入

1. **Job 端口形状已定**：`AffectJobPorts` = registry / loadWindowEvents /
   getAffectState / hasProcessed / applyAccepted。WP4 的装配层
   （affect-store + affect-scheduler）按此注入；`applyAccepted` 直接复用
   M2.5 的 `applyAcceptedEvents`（事务包装——注意 M7 的
   `rebuildRelationshipProjection` 缺事务包装是已登记缺陷，M8 重建必须用包装形态）。
2. **ORIGIN 播种走同一放行口**：`seedAffectOrigin` 构造 ORIGIN 提案
   （`sourceConversationEventIds: []`，processor = `affect-origin-seeder@1`，
   与 M7 origin seeder 同构）→ `validateAffectProposal` → apply。
   未建档时放行（P9）、已建档拒绝（N12）——幂等键 `operation='affect-origin'`。
3. **cutover 水位**：ORIGIN payload 的 `cutoverSequence` 是资格边界的唯一来源
   （评估器从 `getAffectState` 读，Validator 从状态读）。播种后
   `advanceWatermark` 到 cutoverSequence；中断恢复从 ORIGIN payload 重读
   （ADR-066 §6.3）。
4. **接线清单**（WP4 翻转 S3）：`createFullDomainEventRegistry()` 加入
   `createAffectDomainEventRegistry()` 的三类 + 翻转
   `m8-wp2-contracts` S3 判据并出证据。
5. **dryRun**：`runAffectEvaluation({ dryRun: true })` 只跑评估器数提案，
   零副作用——WP6 降级路径预判与 `--dry-run` 开发者面用它。
