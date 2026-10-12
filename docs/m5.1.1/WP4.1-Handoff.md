# WP4.1 Handoff — K-22 Physical Action-Ledger Closure

> ## 状态（**必须按字面读**）
>
> ```text
> K-22 physical                 = **CLOSED**
> v8 required                   = **YES**（可执行证明：把 v7 的谓词放回去 ⇒ 目标形状必拒）
> production-copy schema check  = **PASS**（v6 → v8；preview=[7,8]；幂等 skipped=8）
> WP4.1 专项门（pnpm m5.1.1:wp4.1:verify） = **PASS（43 通过 / 0 失败）**
> WP5                           = **READY / AUTHORIZED**
> ```
>
> **没有开始 WP5。没有动真实库（只 cpSync 过一个副本）。没有改 `MIGRATION_0007`。**
> **没有碰 Fact Firewall / MemoryAuthority / Recall / extractor / ADR-043 / Phase 4。**
> **没有做 `character_action_events` 的历史回填**（本步是**物理落地**，不是数据回填）。
>
> ```text
> 前置：WP4 = PASS（见 WP4-Handoff.md）。
> 本步关闭的是 K-22 —— 它在 R-20 里被登记为"character_action_events 的 Axis B 回填口径未冻结"，
> 而 WP4.1 的实测把问题问得更准：不是"怎么回填"，而是 **v7 的约束根本不允许一个行动行
> 只声明归因、不编造 Cognitive Axis B**。语义与物理两侧都在本步冻结并落地。
> ```
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-26**（+ R-20 的闭包注记）、
> [`M5.1.1-WP4.1-Compatible-Assertion-Record.md`](./M5.1.1-WP4.1-Compatible-Assertion-Record.md)、
> `artifacts/m5.1.1/wp4.1-k22-action-axis-b.json` / `wp4.1-production-copy-v8.json`。
> **不要重新探索仓库。**

```text
Completed WP: WP4.1 — K-22 Physical Action-Ledger Closure
  §1 v7/v8 现状实测：行动表的列 / 约束 / INSERT 路径 / READ 路径 / 消费者 / 行动门
  §2 v8 决策（**可执行**）：v7 谓词 ⇒ 目标形状必拒；v8 谓词 ⇒ 入账 ⇒ v8 required = YES
  §3 边界冻结：initiator / actor / executor / authority / requestedBy **不得**推出 SourceKind
  §4 物理表示：行动行可携带 6 个槽位 + attribution_origin，**不必**编造 Axis B
  §5 正控：ACTION_REQUESTED / AUTHORIZED / STARTED / SUCCEEDED / FAILED + 一条 MIGRATED_LEGACY 形状
  §6 负控：三条禁止推导在**契约层与库层各响一次**，且零残留
  §7 回归：conversation_events 的 R-21 语义逐条复证未被放宽
  §8 迁移纪律：additive-only 的真值表 + preview + production-copy + 幂等 + 指纹锁 + 回滚/前向兼容
  §9 可查/可审计：行动归因照样能查，Axis B 三列在审计视图里恒为 NULL

Changed Files:
  src/infrastructure/persistence/migrations.ts        （改：+ MIGRATION_0008，**只**替换行动表那一条 CHECK）
  src/kernel/contracts/attribution.ts                 （改：+ ACTION_AXIS_B_SEMANTICS / COGNITIVE_AXIS_B_FAMILIES /
                                                        isCognitiveAxisBApplicable / FORBIDDEN_ACTION_AXIS_B_DERIVATIONS /
                                                        validateActionAxisB / assertActionAxisBNotApplicable）
  scripts/verify-m5.1.1-wp41-k22-action-axisb.ts      （新增：K-22 专项门）
  scripts/verify-m5.1.1-migration.ts                  （改：v8 的迁移纪律 + 指纹锁 + K-22 探针 + fork 证据名）
  scripts/verify-m5.1.1-production-copy-schema.ts     （改：v6 → v8 的副本检查 + 按表点名 Axis B 约束 + fork 证据名）
  scripts/verify-m5.1.1-k20-anti-fabrication.ts       （改：schema 7 → 8）
  scripts/verify-m5.1.1-wp32-recorded-axisb.ts        （改：schema 7 → 8）
  scripts/verify-m5.1.1-wp4-write-path.ts             （改：schema 7 → 8 + scope 文本 + fork 证据名）
  scripts/verify-m5.1.1-wp3-backfill.ts               （改：待应用 [7,8] / 应用到 8；**未重跑**，见 C-12）
  package.json                                       （改：+ m5.1.1:wp4.1:verify）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                （改：+ R-26 + R-20 的闭包注记）
  docs/m5.1.1/M5.1.1-Proposed-Schema.md               （改：+ §5.3b POST-FREEZE ADDENDUM — K-22）
  docs/m5.1.1/M5.1.1-Migration-Strategy.md            （改：+ §3.6b POST-FREEZE ADDENDUM — K-22）
  docs/m5.1.1/M5.1.1-WP4.1-Compatible-Assertion-Record.md （新增：16 条判据变更逐条留痕）
  docs/m5.1.1/WP4.1-Handoff.md                        （本文件）
  artifacts/m5.1.1/wp4.1-*                            （新增：本 WP 的结构化证据 + fork）

Tests Run（全部 exit 0；见 wp41-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0（**26 / 0**）
  pnpm kernel:test:conversation   → 0（**47 / 0**）
  pnpm m5.1.1:test                → 0（**42 / 0**）
  pnpm m5.1.1:k25:verify          → 0（**22 / 0**）
  pnpm m5.1.1:wp3.2:verify        → 0（**35 / 0**）
  pnpm m5.1.1:wp4:verify          → 0（**48 / 0**）
  pnpm m5.1.1:wp4.1:verify        → 0（**43 / 0**；K-22 专项门，本轮新增）
  pnpm m5.1:measurement:verify    → 0（**16 / 0**）
  pnpm m4.5:test                  → 0（**135 / 0**；行动账本的 L1 部件门）
  pnpm m5.1.1:k20:verify          → 0（**30 / 0**）
  pnpm m5.1.1:migration:verify    → 0（**97 / 0**；23 个计数检测器全有效）
  pnpm m5.1.1:prod-copy:verify    → 0（**30 / 0**；production-copy schema check）

Tests Passed: 26/26 · 47/47 · 42/42 · 22/22 · 35/35 · 48/48 · 43/43 · 16/16 · 135/135 · 30/30 · 97/97 · 30/30；13 条命令全 exit 0
Tests Failed: 0
Tests Not Run（**理由明确**）:
  · pnpm m4.5:ci / m4.5:ci:full（约 10–15 分钟，会重写 m4/m4.1/m4.5 历史证据；不在任务书 §9 清单内）
  · pnpm m5.1.1:wp3:verify（WP3 的 production-copy 回填门：重跑会重写 WP3 历史证据；
    本轮没有回填任何行动行。它的三条 v8 判据已更新，行为由 migration / prod-copy 两个门覆盖）
  · pnpm m5.1:gates / m5.1:regression:verify（读 m4.5:ci 的日志）
  · 真实库 data/pglite 的任何 apply / update（只有 cpSync 复制；没有任何脚本打开它）
  · **character_action_events 的历史回填**（本步不做；口径已冻结，需要时按 R-26 执行）
  · WP5 · Phase 4 / ADR-043 · 里程碑标签（需要你批准）

Evidence Produced:
  artifacts/m5.1.1/wp4.1-k22-action-axis-b.json     —— K-22 专项门完整机读事实（现状实测 / v7↔v8 谓词对比 /
                                                       契约边界 / 6 条正控 / 3 条负控 / 对话表 R-21 复证 / 可审计）
  artifacts/m5.1.1/wp4.1-production-copy-v8.json    —— 真实库副本 v6 → v8（preview / apply / 幂等 / 约束点名 /
                                                       逐行 before-image 未变 / 新 CHECK convalidated）
  artifacts/m5.1.1/wp4.1-migration-verify.json + wp4.1-migration-preview.txt
                                                    —— 迁移门（v8 纪律 + 指纹锁 + K-22 库级探针 + 预览）
  artifacts/m5.1.1/wp4.1-wp4-write-path.json + wp4.1-wp4-attestation.json
                                                    —— 继承门 WP4 写路径在 v8 上仍然 48/0
  artifacts/m5.1.1/wp41-*.log（11 份）· wp41-gate-exits.txt · wp41-restore-whitelist.txt

Commit Hash:
  9893ae8  （feat：MIGRATION_0008 + 契约边界，**只**替换行动表那一条 CHECK）
  34e6f64  （test：K-22 专项门 + 六个继承门 v8 化 + 证据 fork）
  0bb167d  （docs：R-26 / 两节 addendum / compatible-assertion record / 本文件）
  5b93b42  （fix：把 passed/failed 计数写进 K-22 证据 artifact）
```

---------------------------------------------------------------------------
 §10 —— 完成判定（逐条）
---------------------------------------------------------------------------
```text
K-22 physical                  = **CLOSED**
v8 required                    = **YES**
production-copy schema check   = **PASS**
⇒ **WP5 = READY / AUTHORIZED**（本 execution **不**开始 WP5）

判定依据（不是自述，是证据）:
  · K-22 专项门 43/0，其中"v7 谓词必拒目标形状 / v8 谓词接受"是**可执行**的 v8 必要性证明
  · production-copy 30/0：真实库**副本** v6 → v8（preview=[7,8] · applied=[7,8] · 幂等 skipped=8）
  · 迁移门 97/0：0001–0008 指纹全对（v7 逐字未改）· v8 只有 2 条语句且只碰行动表 · 23 个计数检测器全有效
  · 继承门全绿：WP4 写路径 48/0 · WP3.2 35/0 · K-25 22/0 · K-20 30/0 · m4.5:test 135/0 · measurement 16/0
```

---------------------------------------------------------------------------
 §1–§2 现状与 v8 决策（**可执行**，不是推理）
---------------------------------------------------------------------------
```text
实测（v8 之后）:
  character_action_events  34 列（12 既有 + 22 归因）· 23 条 CHECK
    · 18 个槽位列 + Axis B 三列 + attribution_origin **都在**（物理承载存在）
    · Axis B 完整性约束 = `character_action_events_axis_b_not_applicable`
      （`CHECK (((source_kind IS NULL) AND (source_authority IS NULL) AND (epistemic_source IS NULL)))`
       convalidated = true ⇒ PG 已逐行验证既有数据）
    · 词表 4 条一个没删（它们在新谓词下恒真）
  conversation_events      仍然是 `conversation_events_axis_b_complete`（v8 没碰它）
  INSERT 路径               全 src **恰好一个**文件写这张表：action-ledger-store.ts
                            —— 它的 INSERT 列清单里**一个归因列都没有**
  READ 路径                 全 src **没有任何**代码从行动表读 Axis B（"不假装是认知来源"）
  消费者                    action-ledger-store.ts（读）· migrations.ts（DDL）—— 已逐条列出并计数
  行动门                    m4.5:test / m4.5:verify / m4.5:nl-action:verify 等仍在册（本轮跑了 m4.5:test 135/0）

v8 必要性（把 v7 的谓词**放回**沙箱库）:
  谓词 v7: attribution_origin is null or (三列都 not null)
    → 目标形状（origin='RECORDED'，Axis B 三列 NULL）**被拒**
  谓词 v8: 三列必须全 NULL
    → 同一形状**入账**
  ⇒ "schema 变更是否必要"这个问题被**执行**回答，而不是被论证回答。
```

---------------------------------------------------------------------------
 §3–§4 物理表示与边界（K-22 §2）
---------------------------------------------------------------------------
```text
冻结: character_action_events 的 Cognitive Axis B = NOT_APPLICABLE（全局）
  契约:  ACTION_AXIS_B_SEMANTICS = 'NOT_APPLICABLE'
         COGNITIVE_AXIS_B_FAMILIES = 对话四族（行动族 + developer_control 不在其中）
         FORBIDDEN_ACTION_AXIS_B_DERIVATIONS = 三条冻结反例
         validateActionAxisB / assertActionAxisBNotApplicable（失败关闭）
  物理:  MIGRATION_0008 —— **只**把行动表的 `axis_b_complete` 换成
         `axis_b_not_applicable`（三列必须全 NULL）

为什么**不需要**第二枚 marker 列（任务书 §4 的"若需要就 STOP"条件**未触发**）:
  · NULL 在行动表上是**唯一**合法取值 —— 由 CHECK **穷尽**，不存在第二种形状；
  · 它的含义由**成文契约**显式定义为"不适用"（不是"未记录"、不是"未回填"）；
  · 四个 SourceKind 全是对话内容类别 ⇒ 行动行**没有**"某个 SourceKind"这个东西可以说；
  ⇒ 没有任何"NULL 到底是哪一种含义"的歧义，因此没有 marker 可加。**没有 STOP。**

可写、可查、可审计（行动侧照样能记归因）:
  6 条正控真的落库：ACTION_REQUESTED（initiator known / authority absent）·
  ACTION_AUTHORIZED（authority known）· ACTION_STARTED / SUCCEEDED（executor Known）·
  ACTION_FAILED（executor Unknown(RUNTIME_UNRESOLVED)）· 一条 MIGRATED_LEGACY 形状。
  每条都过 `validateAttributionNecessity`（0 违规）且 Axis B 三列为 NULL。
  审计查询把 initiator / actor / executor / authority / recordedBy / origin 全部读出，
  且同一视图里 Axis B 三列**全部为 NULL**。
```

---------------------------------------------------------------------------
 §6 负控（三条禁止推导，契约层与库层**各响一次**）
---------------------------------------------------------------------------
```text
  initiator=USER   → source_kind=user_statement   契约必响 · 库必拒 · 零残留  ✅
  actor=CHARACTER  → source_kind=character_output 契约必响 · 库必拒 · 零残留  ✅
  executor=TOOL    → source_kind=tool_output      契约必响 · 库必拒 · 零残留  ✅
  另: 半填 / 无 origin 却带三列 ⇒ 库必拒（v8 收紧的那一格）
  另: conversation_events 仍然要求完整 Axis B（origin=RECORDED + 三列全 NULL ⇒ 被拒），
      且 confirmed / unconfirmed 两个分支与"混合形态必响"逐条复证 ⇒ **R-21 未被放宽**。
```

---------------------------------------------------------------------------
 架构偏差 / 已知问题 / 边界（如实登记）
---------------------------------------------------------------------------
```text
1. v8 的"additive only"要**按字面理解到对象级**：它不加任何对象（无列/无表/无索引/无数据），
   但它**替换了一条 CHECK** —— 这是唯一能做到任务书 §3 目标形状的办法（§4 明确：
   不要为 NULL 发明 marker）。真值表（script / evidence 里都有）：
     · 既有行（Axis B 全 NULL）→ v7 接受、v8 接受；
     · "origin 非空 + Axis B 全 NULL" → v7 **拒**、v8 **接受**（K-22 的目标形状）；
     · "Axis B 三列全非空" → v7 接受、v8 **拒**（唯一收紧的一格 = 禁止行动行假装有认知轴）；
     · 半填 → 两者都拒。
2. **真实库的 character_action_events 是空的（0 行）**，因此"既有行动行是否满足新谓词"
   在副本上如实标 **NOT_APPLICABLE**（不是 PASS）—— 非空证明由沙箱正控/负控提供。
3. 本步**没有**做行动行的历史回填（attribution_origin 仍为 NULL）。口径已冻结：
   MIGRATED_LEGACY + §3.3 的逐事件类型槽位 + Axis B 留 NULL。需要时单独执行。
4. 本步**没有**接行动写/读路径（那会把 `authoritative attribution` 写进账本 = WP5 的内容）。
   物理承载 + 边界 + 控制已就位，WP5 可以直接在这层上接线。
5. `docs/m5.1.1/M5.1.1-Proposed-Schema.md` §5.3 与 `M5.1.1-Migration-Strategy.md` §3.6 的原文
   **一字未改**，只各追加一节 POST-FREEZE ADDENDUM（§5.3b / §3.6b）指出它们只覆盖
   conversation_events —— 符合"不得让旧的冲突矩阵静默变成实现真相"。
6. `MIGRATION_0007` 逐字未改（指纹 2d51997d… 与 K-8 锁一致）；`MIGRATION_0008` 已按同一条规则
   锁定（0a2bd4fe…，触发点 = 本轮成功的 production-copy apply）。
7. 继承门的判据变更 16 条，逐条留痕在 WP4.1 的 compatible-assertion record；被重新生成的
   历史证据 7 条已按 restore whitelist 还原（含 before/after sha256）。
```

---------------------------------------------------------------------------
 Next WP Preconditions（WP5 = READY / AUTHORIZED，但**不要在本 execution 开始**）
---------------------------------------------------------------------------
```text
WP5（Action & Execution Attribution，写侧）现在**没有**已知的物理阻塞：
  □ K-22 physical = CLOSED（R-26）；v8 已落地并在 production copy 上验证
  □ 行动表已能表达：6 个槽位 + attribution_origin，且**不**携带 Cognitive Axis B
  □ 契约侧已冻结：NECESSITY_MATRIX 的五个 action 族判据 + assertActionAxisBNotApplicable
  □ 仍需遵守：不得合并 WP4.1 + WP5；Phase 4 / ADR-043 仍 NOT APPROVED；
    任何 schema 变更都必须新写 v9+（v7 / v8 都已是指纹锁定的历史 DDL）
```
