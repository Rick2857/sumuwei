# M6 验收报告（Acceptance Report）

> 里程碑：**M6 / Lv1 Hardening**（Rolling Summary 的**来源边界**）
> 计划权威源：[`M6-DSH-Execution-Plan.md`](M6-DSH-Execution-Plan.md)（另一会话持有，本报告**未改它一个字节**）
> 契约：[`M6-Acceptance-Contract.md`](M6-Acceptance-Contract.md)（`DESIGN FROZEN`，本报告**未改它**）
> 裁定载体：[`ADR-050`](../adr/ADR-050-rolling-summary-provenance-boundary.md)（`DESIGN FROZEN`）
> 判定载体：[`M6-Gate-Decision.md`](M6-Gate-Decision.md) · 局限：[`M6-Known-Limitations.md`](M6-Known-Limitations.md)
> 报告日期：2026-09-22 · 分支 `feature/m6-lv1-hardening`（= `main`）

```text
本报告只写**机器读数**与**可追溯的出处**。凡"未跑"一律写 NOT RUN，绝不写成 PASS。
历史不改写：M5.5 / M5.5.1 / M5.1 / M5.1.1 / M4.5 的既有结论与证据**一字未改**（见 §7）。
```

---

## 1. 一句话判定

```text
M6（本计划冻结范围内的工程与自动化验收） = **PASS**
  —— `pnpm m6:gates`：必选门 **17** 个 · 未运行 **0** 个 · 未通过 **0** 个 · **Hard Gates = PASS**（EXIT 0）

但**必须分列**（不许合成一个总分）：
  · G1（含人工复核的综合验收）              = **AWAITING HUMAN REVIEW**（没有真人评分）
  · Original Lv1 Requirements               = **PARTIAL**（状态演化延期至 M7；Rolling Summary 本轮才补）
  · WP9b 的"假记忆边界"                     = **NOT MET**，且该性质的自动探测器 **INVALID**
  · 摘要的**生产激活**                      = **NOT ACTIVATED**（`rollupTokens` 缺省 0；激活属独立裁定）
```

---

## 2. 逐门事实（`pnpm m6:gates` 的 17 道必选门）

| # | 门 | 判定 | 通过/失败 | 证据（已落盘） |
|---|---|---|---|---|
| 1 | `wp0-baseline` | `BASELINE CAPTURED` | 0 / 0 | `artifacts/m6/m6-wp0-20260921-1165fedcdde2/baseline.json` |
| 2 | `wp2-rollup-unit` | PASS | 59 / 0 | `artifacts/m6/m6-wp2-20260922-866f2fba5f27/rollup-unit.json` |
| 3 | `wp3-wiring` | PASS | 27 / 0 | `artifacts/m6/m6-wp3-20260922-866f2fba5f27/wiring.json` |
| 4 | `wp3-reader` | PASS | 25 / 0 | `artifacts/m6/m6-wp3-reader-20260922-866f2fba5f27/reader.json` |
| 5 | `wp4-measurement` | PASS | 46 / 0 | `artifacts/m6/m6-wp4-20260922-14120f7e890b/measurement.json` |
| 6 | `wp5-console` | PASS | 21 / 0 | `artifacts/m6/m6-wp5-20260922-866f2fba5f27/console.json` |
| 7 | `wp6a-faults` | PASS | 28 / 0 | `artifacts/m6/m6-wp6a-20260922-866f2fba5f27/faults.json` |
| 8 | `wp6b-restart-recovery` | PASS | 15 / 0 | `artifacts/m6/m6-wp6b-20260922-866f2fba5f27/restart-recovery.json` |
| 9 | `wp7a-e2e` | PASS | 17 / 0 | `artifacts/m6/m6-wp7a-20260922-866f2fba5f27/e2e.json` |
| 10 | `wp7b-e2e` | PASS | 25 / 0 | `artifacts/m6/m6-wp7b-20260922-866f2fba5f27/e2e.json` |
| 11 | `wp8-scale` | PASS | 24 / 0 | `artifacts/m6/m6-wp8-20260922-866f2fba5f27/scale.json` |
| 12 | `wp8-retrieval-boundary` | PASS | 24 / 0 | `artifacts/m6/m6-wp8-20260922-866f2fba5f27/retrieval-boundary.json` |
| 13 | `wp9a-calibration` | PASS | 15 / 0 | `artifacts/m6/m6-wp9a-20260921-216c41e5888d/calibration/calibration.json` |
| 14 | `wp9a2-judge-discrimination` | PASS | 8 / 0 | `artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/judge-discrimination.json` |
| 15 | `wp9b-long-dialogue` | PASS | 22 / 0 | `artifacts/m6/m6-wp9b-20260921-e869f29de85d/long-dialogue.json` |
| 16 | `wp10a-final-offline` | PASS | 10 / 0 | `artifacts/m6/m6-wp10a-866f2fba5f27/regression.json` |
| 17 | `wp10b-live` | PASS | 12 / 0 | `artifacts/m6/m6-wp10b-6cdd34e7960d/live.json` |

**合计 17/17 必选门被接受**；`m6:gates` 只读已落盘证据，**不运行测试、不改写 verdict**。

### 2.1 契约 M6-G0…G12 与证据的对应

| 契约门 | 命题 | 承载证据 | 状态 |
|---|---|---|---|
| M6-G0 | 前置与证据归属成立 | WP0 基线 + 证据索引（12 条，缺路径 0） | PASS |
| M6-G1 | 测试与真实历史隔离 | WP4/WP6b/WP10a/WP10b 的真实库摘要前后逐字相同 | PASS |
| M6-G2 | 摘要来源／作用域正确 | WP2（59）+ WP3 接线（27）+ WP3 读取面（25） | PASS |
| M6-G3 | 上下文／预算真实 | WP3 接线（27，含 R-2 逐字节负控）+ WP4（46） | PASS |
| M6-G4 | 既有记忆与归因语义保持 | WP7a（17）+ WP7b（25）+ M4/M5/M5.1.1 既有门 | PASS |
| M6-G5 | 行动与搜索真相 | WP6a（28）+ WP7 + WP10b（12） | PASS |
| M6-G6 | 重启与恢复有效 | WP6b（15，含 9 项 drill） | PASS（契约里 WP0 时代的 `BLOCKED` 标注已被证据取代，见 §6） |
| M6-G7 | 规模正确性 | WP8 规模（24）+ 检索上界（24） | PASS |
| M6-G8 | 500 轮有效且质量达标 | WP9b（22）：3×500 完成 · rev2 阈值全过 | PASS（**但"假记忆边界"不在其覆盖内**，见 §4） |
| M6-G9 | Console 表达真相 | WP5（21） | PASS |
| M6-G10 | 量具可信 | WP4（46，8 类注入）+ 每个新门自带三段式 | PASS |
| M6-G11 | 最终代码回归与 Live | WP10a（10）+ WP10b（12） | PASS |
| M6-G12 | 发布主张不越界 | 本报告 + Gate-Decision + Known-Limitations | PASS（分列见 §1） |

---

## 3. 代码归属（本轮真正改了什么）

```text
领域层（纯逻辑）
  src/kernel/recall/rollup.ts            摘要的选择/资格/拒绝理由（WP2；模块归属由计划书的 kernel/context 改为 kernel/recall，见 §5 B-6）
  src/kernel/recall/selector.ts          ContextBudget + 必填 rollupTokens:0；ContextCategory 6→7 类（+ rolling_summary）（WP2/R-3）
接线层
  src/kernel/app/turn-gateway.ts         摘要 provider 的**唯一**插入点（extraProviders 段内、编译器构造之前）（WP3）
  src/kernel/context/sections.ts         SECTION_PRIORITY.rollup = 20（可裁）
  src/infrastructure/persistence/**      只读、显式有界的来源读取面（WP3）
开发者面
  src/infrastructure/dev/**              摘要事实派生 + DTO 扩展（WP5；`e7d97cf`）
量具（新入口，只组合当前实现）
  scripts/m6-verify.ts / m6-measurement.ts / m6-live.ts / m6-gates.ts
  scripts/verify-m6-wp{0,2,3,4,5,6a,6b,7a,7b,8,9a,9a2,9b,10a,10b}*.ts
```

**未改**（逐字节）：`src/kernel/app/memory/**` · `memory-validator.ts` · `memory-store.ts` 的 reducer 语义 · 迁移 DDL 0001–0009 · `src/character/苏沐薇.ts` · `evals/fixtures/m3.5/prompt-baseline.txt` · `src/infrastructure/telemetry/**` 既有语义 · `docs/m5/**` · `docs/m5.1/**` · `docs/m5.1.1/**` · `docs/m5.5/**`。

**prompt 基线**：sha256 `047c6c965fa6f29c79831e817c93b236f17a982c14a3ad6eafab3b53bd2ea4b6` —— **一字节未动**（R-2 裁定选①：空摘要 ⇒ 产 0 section）。WP3 用**逐字节负控**把"应该不会变"变成机器判据（`①-5/①-6/①-7`）。

---

## 4. 真实观测（Level 1 / Level 2）

### 4.1 WP10b —— production-copy Live（真实模型 + 真实搜索 + 生产装配本尊）

```text
真实一轮（`tsx src/main.ts` 本尊 · 副本库 · 测试端点）：status=0，她真的说了话
副本不是真实库：真实库 1205 文件 `9878ed0512f095df…` **只被复制**，前后逐字不变
接线就位但默认不激活：那一轮 `context_compile` 里**一个 `rollup_*` 键都没有**，也没有 `rolling-summary` section
静态面：生产装配**确实**构造了摘要端口（`rollup: this.buildRollupTurnPort()`），额度来自 `recallBudget`（缺省 0）
隐私边界：trace 里**没有**用户那句原话（账本可以记，trace 不行）
```

### 4.2 受影响的 Live 复验（M6 改了 prompt/上下文 ⇒ 必须复验 M5.5 与 M5.5.1）

```text
m5.5:smoke:live    → EXIT 0（78s）· **24 通过 / 0 失败**
   S1 回复 744 字 · 程序生成的**来源附录 5 行**（E1–E5）· S2 回复 988 字 · 附录 4 行
   tracesWithExternalEvidence=2 · selectedCounts=[4,5] · provider=searxng-local
   账本 ledgerRows = success, success · evidenceRefsInDetail=6
   external_evidence 七键：selected_count=4 · candidate_count=5 · bundle_attached_count=1
                           context_budget_dropped_count=0 · evidence_budget_dropped_count=1
m5.5.1:smoke:live  → EXIT 0（165s）· **20 通过 / 0 失败**
```

⚠️ **旧里程碑证据未被覆盖**：那两道门会把读数写进 M5.5 / M5.5.1 **自己的**冻结证据文件；本轮先原样快照（含 SHA-256）到
`artifacts/m6/m6-wp10b-6cdd34e7960d/affected-live/`，再 `git checkout --` 还原回 HEAD blob，
`git diff --quiet -- artifacts/m5.5 artifacts/m5.5.1` = EXIT 0；`pnpm m5.5:gates` 复核仍 **Hard Gates PASS（G1–G5 全绿）**。

### 4.3 WP10a —— 最终候选离线门与全量回归

```text
head = 866f2fb · 运行相关树哈希 be70e992e5f2f9f7d7565a676f3e73a099a280fc05e1d73552592a038c5b0741（429 文件）
计划书 §10.1 的**离线清单**：**32/32 EXIT 0**（逐条读数在 `steps` 里；其中 m4.5:ci 744s）
  ⚠️ 计数更正：WP10a 交接单与那道门的脚本注释都写作"39 条"，但**实测**计划书 §10.1 的离线代码块只有 **32** 条命令
     （运行相关树 `plan-10.1` 组 = 32 条，全 EXIT 0）；另有 §10.1 的 **Live 清单 4 条**（`m4.5:ci:full` / `m5.5:smoke:live` /
     `m5.5.1:semantics:live` / `m5.5.1:smoke:live`）。本报告以**实测**为准 ⇒ **32/32**。
  全部 48 条读数（plan-10.1 32 + inc-01 5 + m6-offline 11）**非零 0 条**
INC-01 与 M6 离线门：**16/16 EXIT 0**（实测分组 = `inc-01` **5** 条 + `m6-offline` **11** 条；其中 m6-wp8 790s）
  ⚠️ 同一处计数更正：交接单写"INC-01 4 条 + M6 离线 12 条"，实测是 **5 + 11 = 16**（合计一致，分组口径以前者为准）
inc-01:regression:verify：2823s ≈ 47min · EXIT 0 · verdict PASS（含 m4.5:ci:full）
单条**既有**非零：wire-phase4b-db-v9 = 1（回归自己逐条写明：迁移后两句"迁移当时"断言不再成立，实测 28 行）
单条 NOT RUN：m5.5.1-gates（本分支**没有**这个命令）
白名单恢复：跑前脏 3 条 · 新增脏 15 条 · 还原后仍脏 0 · 与索引逐字一致 15/15
```

### 4.4 WP9b —— 3×500 轮正式长对话

```text
三条轨迹各自独立进程 + 独立隔离库：V1 29.3min · V2 41.1min · V3 28.3min ≈ 99min
V1 日常连续性 500/500 · V2 纠正/遗忘/假记忆 500/500 · V3 身份诱导/冲突/恢复 500/500
对比式判据（PC / SA / 连续性）：三条轨迹各 42/42 · 区分率都 = 1.000（p ≈ 0）· 位置偏好 0.49–0.50 · 同一对 tie 100%
有效响应 500/500 × 3 · 硬边界：Seed 指纹跨 500 轮与两次重启逐字段未变（seed 版本 1→1）
上下文估算（M55 harness，不调模型）：检查点 1/50/100/200/300/400/500 = 1199/1198/1199/1198/1196/1199/1198 token · 3 section · 0 裁剪
  ⇒ **上下文不随轮数增长**（受预算约束）
```

### 4.5 WP8 —— 规模与检索上界

```text
1,000 操作：30s · 78 ops/s · 领域事件 1060 · 重放 mismatched=0
10,000 操作：349s · 62.7 ops/s · 领域事件 10600 · 重放 mismatched=0
自有 ≥10k 事件场景：requested operations 7500 · persisted domain events **10302** · replayed_event_count **10302**（独立复算）
  重放 6934/6934 逐字段一致（连续两次）· superseded 2802 / retracted 566（缺指针 0）· unsupported=0 · contamination=0
  上下文受预算约束：memory section 45 token ≤ memoryTokens 800 · 候选 50 / 选中 1
检索上界（如实暴露）：scanLimit = max(1, min(500, limit×5))（生产 limit=50 ⇒ 250）+ **排序之前**的 slice(0, limit)（⇒ 50）
  探针：最新第 1 名能召回 · 第 51 名召回不到 · 最老一条召回不到
  ⇒ 把 M5 报告第 195 行「检索最多扫描 500 行」**收细**为：同一 subject 下记忆数 > 50 时，可被排序的选择集其实是最近 50 条
性能 SLA：**未冻结 ⇒ 本门不判**（不临时拍秒数）
```

### 4.6 WP9a / WP9a2 —— 阈值与判定器

```text
rev1（绝对形态）：PC/SA/连续性 mean 全 1.000、σ²=0 ⇒ **饱和** ⇒ 三者标 MEASUREMENT INVALID，质量门 NOT RUN
rev2（对比式，**冻结**）：质量门 = 对比式（真 vs 退化，双向）
  通过线 = 区分率 ≥ 0.75 且二项检验 p < 0.05（每指标 24 次判分）
  两条防线 = 位置偏好 ∈ [0.25, 0.75] · 同一对（A==B）不得系统性选 A
  仍然有效 = 有效响应覆盖下限 0.98 · 硬零指标"只有 0 违规一种形态"
  实测：三指标均 24/24 = 1.000 · p ≈ 0 · 位置偏好 0.50 · 同一对 tie 12/12 ⇒ 形态判定 **CONTRASTIVE ADEQUATE**
rev2 文件：artifacts/m6/m6-wp9a2-20260921-0de5798b36a9/M6-D3-thresholds-rev2.json（WP9b 用的就是这份）
```

### 4.7 WP6b —— 重启 / 关闭 / 恢复（INC-01 保护的集成验收）

```text
15/15 + 6 条必跑子门全 EXIT 0
drill：损坏快照被拒（`snapshot_digest_mismatch`）· 恢复失败保留 quarantine 且不重建 dataDir（`promote_failed`）
       强杀后租约**确实释放**（heldAfterKill=false）且可重新获取（reacquired=true）· ownerCleanClose=false（如实）
       closeReading：stop=ok · close=ok · **closed=true**
真实库摘要 8307173d8b8f12df…（1205 文件 / 31,584,799 字节）前后逐字相同 · measured_count=1205
```

---

## 5. 偏差（Deviations）

### 5.1 计划与实现的偏差（登记，不改写计划）

| # | 偏差 | 处置 |
|---|---|---|
| B-1 | 计划只写"执行授权"，WP0 实际**建了分支** `feature/m6-lv1-hardening` | 登记；分支即交付面 |
| B-2 | WP0 的量具是新写脚本（计划 §9.1 未提） | 登记；量具自证 5/5 |
| B-6 | 摘要模块落在 `kernel/recall/rollup.ts`（计划写 `kernel/context`） | 登记；依赖方向未破 |
| B-7 | 预算契约落在 WP2（ADR-050 §6 划给 WP3） | 登记 |
| B-10 | WP3 拆两部分，其"出口（接线门 PASS）"当时未达成 | 后续 WP 补齐，最终 PASS |
| B-12 | 量具 `runId` 由 HEAD 派生 ⇒ 证据目录随提交漂移 | **未修**；WP10b 实测踩到并发覆盖（见 §6.3） |
| B-18 | `m6:live` 只有守卫、**没有**套件（`implemented:false`） | 登记为未完成项（见 Known-Limitations） |
| B-20/B-23/B-24 | 3 类注入与模型侧四类故障声明 N/A（归属 M5.5.1 / WP10b / 既有门） | 登记；不冒充覆盖 |
| B-21 | 摘要事实挂在既有 `TraceDetailDto`，不新增 endpoint/capability id | 登记 |
| B-14 | ADR-050 §3.2 伪代码序列判据方向写反（实现按 DR-5 意图） | 登记；**未改 ADR 正文** |

### 5.2 判据 / 量具修正（**不是放宽**，逐条留痕）

| # | 现象 | 真因 | 处置 |
|---|---|---|---|
| WP2 F-9 | `m5:verify` 25/1 | 新增 `recall/rollup.ts` 触发"纯召回层文件清单"静态锁 | 显式登记（锁要求登记，非产品缺陷） |
| WP2 F-10 | 把"命中次数"(11) 报成"理由种类数"(应为 5) | 数字真但量的不是标签那件事（AGENTS §6.9 第二种形态） | 改判据 |
| WP3 F-14 | 接线门两条断言红 | 夹具把 `tokenBudget` 传给工厂选项，而裁剪读 `compile()` 输入 | 修夹具 |
| WP4 F-23 | WP0 的 `BASELINE CAPTURED` 被判失败（假红） | `m6:gates` 用 `verdict==='PASS'` 统一判定 | 改为登记表 `acceptVerdicts` |
| WP5 F-25 | 新 WP5 门被判违规（45/46） | 量具把字符串里提到 `fetch(` 判成真实调用 | 拆"原文提及"与"代码里出现"两套判据 |
| WP6b ① | `m4:hardkill:verify` 19/1 EXIT 1 | 硬编码 `schemaVersion===5`，隔离库自动升到 v9 | 改 `latestSchemaVersion()` ⇒ 20/0 |
| WP6b ② | 强杀后租约仍被持有 | `taskkill /F` 只杀父进程，孙进程仍持 named pipe | 改 `/T` 杀整棵树 |
| WP7a ①②③ | 三条假红 | 判据按中文原句而非存储形状；"摘要无旧值"用中文子串测；`m6:gates` 只读顶层计数 | 逐条改判据 |
| WP7b ① | P4 判据把"没超限"说成超限 | 判据写错（实测 1239 < 1249） | 改判据 |
| WP8 ①②③ | 三条红全是夹具问题 | 空集上判真；2027 合成时钟比生产记忆新；探针时间戳手抖 | 修夹具 |
| WP9a F3/D1 | 判据更正 ×2 | baseline 只测到四个硬零指标里的两个；把"不给通过线"等价于 MEASUREMENT INVALID | 改判据 |
| WP9a 量具 | judge 5/6 静默跳过 | `max_tokens=400` 不够推理 token（`content` 为空） | 改 2000 ⇒ 10/10 打分 |
| WP9a2 量具 | 假 24/24 位置偏好 | ①对比式 prompt 里 `{{reply}}`/`{{seedTraits}}` 占位符**原样未填**；②解析器先 `toUpperCase()` 再 `JSON.parse`（键 `pick`→`PICK`），兜底 `\bA\b` 匹配正文 | 修量具；**J3/J4 两条防线抓到** |
| WP10a ①② | `m5.5:measurement:verify` 231/8、`m5.5:gates` G1=FAIL | ①M5.5 预算夹具缺 M6 新增必填 `rollupTokens`（夹具过期）；②冻结身份探针用裸 `hash-object <path>` 比工作树字节，被同一次扫描里更早的汇总门重写污染 | ①补夹具；②改 `rev-parse HEAD:<path>`（**基线哈希一个都没改**） |
| WP10a ③ | 开发者面"8 文件自 `cfd9219` 未改"红 | **真实受影响面**：M6 WP5 依 ADR-050 扩展了开发者面（`e7d97cf`） | 拆两组冻结点；**历史结论不改写** |
| WP10a 自身 ×3 | wp8 S7 冤枉红 · R2b 把 `exitCode=null` 当非零 · `rollup_scope_missing` 只认一种形状致 8 道门误报 | 判据/检测缺陷 | 逐条修正 |
| WP10b R2 | `m6:gates` = 2 被判红 | **自指**：`wp10b-live` 登记为必选门后，聚合门读数包含本门自己，而本门证据要等本门跑完才落盘 | 改为**可证伪的证明义务**（未运行 0 且唯一未通过的具名门就是本门自己；解析不到就报红） |
| WP10b `say()` | "子进程 exit 1 且回复为空"**完全不可归因** | 两个 `say()` 只留 stdout、丢掉 stderr | 留 stderr 尾部并写进 L1 读数 |
| WP11 计数更正 | WP10a 交接单与那道门的脚本注释都写"§10.1 **39** 条"、"INC-01 4 条 + M6 离线 12 条" | 数字对不上：**实测** plan-10.1 = **32** 条（计划书 §10.1 离线代码块就是 32 行）、inc-01 = **5** 条、m6-offline = **11** 条（合计都是 16）；"39"来自脚本里一句**陈旧的文档注释**（`PLAN_10_1.length` 实际是 32） | 本报告以**实测**为准（32/32 · 5+11=16）；**刻意不改**那道门的脚本（改一个字节就会让运行相关树离开 WP10a 冻结的候选，见 §5.3 的同一条理由），改为在此登记更正 |

### 5.3 遗留的 cosmetic 警告（**刻意不修**）

```text
`pnpm m6:gates` 仍会对 `wp6b-restart-recovery` 打一条警告：
  ⚠️ rollup_scope_missing: 既没有 scope 也没有 counters（以及成对的 checks+totals）⇒ 无法回答"这份读数测的是什么范围"
```

**为什么刻意不修**：修它要改 `artifacts/m6/m6-wp6b-*/restart-recovery.json` 或那个门的脚本，而**运行相关树/证据一改，WP10a 在冻结候选 `866f2fb` 上的冻结就失效**（计划书 §WP10a 明文：任何影响运行行为的后续改变都按影响范围使证据失效并重跑）。该警告**不影响任何判定**（`wp6b-restart-recovery` 本身是 PASS，15/15），因此如实登记为**已知 cosmetic 警告**，不在本轮修。

---

## 6. 失败历史（不许藏）

### 6.1 WP10a 第一轮候选 `976eeb3`：FAIL 9/1

`m5.5:measurement:verify` 231 通过 / 8 失败、`m5.5:gates` G1=FAIL。逐条分析后确认**不是行为回归**，而是 M6 的登记改动让 M5.5 那三条探针的**基准过期**（§5.2 的 WP10a ①②③）。经用户 2026-09-21 批准（B 案）：**只更新探针基准，不改写 M5.5 的历史结论**。修后在冻结候选 `866f2fb` 上重跑 ⇒ PASS。

### 6.2 WP10b 同一 head 上先红过一次（FAIL 10/2）

```text
第一轮：M5.5 受影响复验 20 通过 / 4 失败（S1 子进程 exit 1、回复 0 字 ⇒ 那一轮根本没发出搜索
        ⇒ 没有附录、出站只剩 S2 的查询词 ⇒ "逐字查询词"那条也红）
同一轮里 S2 却正常（status=0、761 字、附录 4 行）；事后用**同一条命令**手工复现 S1 也是 exit 0 且她真的回了话
⇒ 判定为**瞬时失败**（模型端点/装配的偶发），不是 M6 的稳定缺陷
第二轮（同一 head、同一天）：12 通过 / 0 失败 · **PASS**
```

读数与归因留在 `artifacts/m6/m6-wp10b-6cdd34e7960d/affected-live/README.md`（含两份 `*.attempt-fail.json` 快照与 SHA-256）。

### 6.3 并发会话覆盖证据（实测踩到，**结构性风险**）

`runId` 按 head 派生（`m6-wp10b-<head12>`）⇒ **同一 head 上的第二次运行会覆盖同一个目录**。本轮另一个会话在**同一 head `6cdd34e7960d`** 上并发跑了同一道门，覆盖了 `live.json` 与 `local/<runId>/*.log`。受影响复验的读数快照已另存。**教训**：要么串行，要么给 runId 加时间戳/序号。

### 6.4 上游引擎被挡（环境前置，不是 M6 缺陷）

本轮期间 ADR-047 冻结的三元组（`duckduckgo,wikipedia,wikidata`）一度合计 0 条：`duckduckgo` 报 `验证码`/`超时`，从本机直连 `html/lite.duckduckgo.com` 14s 后被连接重置。用户随后在 `searxng/settings.yml` 的 `outgoing.proxies` 指向宿主机 Clash 后恢复（冻结三元组下 `results[]` 返回 10 条，1.5–3.0s）。**本轮没有改冻结引擎组**；引擎组更换属 ADR-051，仍等用户批准。

---

## 7. 历史不改写（逐条核对）

```text
· M5.5 / M5.5.1 的冻结验收证据：本轮受影响复验的读数**先快照再还原**，`git diff --quiet` = EXIT 0
· M5.5 历史证据（artifacts/m5.5/measurement.json、gate-results.json）与 docs/m5/**、docs/m5.1/**、docs/m5.1.1/**：**未改写**
· M5.5 的验收文字：**未改**
· 契约 M6-Acceptance-Contract.md（DESIGN FROZEN）与 ADR-050：**未改**（WP6b 的 `BLOCKED` 标注是本报告/判定载体里说明"已被证据取代"，不是在契约里改字）
· 计划书 M6-DSH-Execution-Plan.md：由**另一会话**持有，本会话**未触碰**
· 用户脏文件 artifacts/incidents/inc-01/wp1-lease.json：SHA-256 仍为 BB08C5BE9FE13FC6B739D67D00D29ED4921CB2E4D8FCD9D1B5D7F12184BA42B6，**未动、未提交**
· 真实库 data/pglite：**从未被本里程碑的试验打开**；所有真实库读数都是"只复制"或"只读 opener"，摘要前后逐字相同
```

---

## 8. 未完成 / 未运行（**不能写成 PASS**）

```text
① G1-A / G1-B 独立综合验收（含**真人盲审**）        = AWAITING HUMAN REVIEW（需要真人）
② WP9b 的"假记忆边界"                              = NOT MET，且该性质的自动探测器 INVALID（见 Known-Limitations §1）
③ 摘要的**生产激活**（rollupTokens > 0）            = NOT ACTIVATED（属独立裁定，先例 ADR-048）
④ `m6:live` 的套件                                 = 未实现（只有守卫）
⑤ 性能 SLA                                         = 未冻结 ⇒ 不判
⑥ 换模型实验                                       = NOT RUN（没有第二个已授权且已配置的真实模型）
⑦ M5.5.1 的收口                                    = 无 WP8 记录 / 无收官记录 / 无 `m5.5.1-complete` 标签（P-1，仍开放）
⑧ 合并 / 打 `m6-complete` 标签 / 开 auto_public / 真实库迁移或恢复 / M7 开工 = **M6 完成不自动做**
```
