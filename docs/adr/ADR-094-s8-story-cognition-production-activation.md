# ADR-094：S8 故事认知的**生产激活**（设计冻结候选）

状态：**ACCEPTED / DESIGN FROZEN**（用户 2026-10-03 批准）。
**实施范围 = 仅 `D01`–`D04` 的实现 + 新门**；**激活本身**（真实库 `v10`–`v12`、`.env`、读回）**仍需另行批准**。
日期：2026-10-03（北京时间）。工作包：`POSTLV2-S8 / WP9`。

> **批准记录（2026-10-03）**：用户原话「批准 ADR-094,D03:A」。
> ⇒ 本条即 `D03` 的裁定：**选项 A —— 接线独立故事水位（每消费者一条），实现 `D13` 原文**。
> ⇒ 选项 B（"提交时同步消费 + 幂等键兜底"）**被否决**，不再作为备选保留。
> ⇒ 本节只记批准这一个动作；**没有**执行任何真实库操作、**没有**改 `.env`、**没有**激活。

上位载体：[ADR-093](ADR-093-s8-story-state-and-habit-bridge.md)（`ACCEPTED / DESIGN FROZEN`）·
[S8 门判定](../post-lv2/S8-Gate-Decision.md) · [S8 已知局限](../post-lv2/S8-Known-Limitations.md) ·
[激活候选](../post-lv2/S8-Activation-Candidate.md)（本 ADR 的执行手册）· 计划书 §7/§8。

> ⚠️ **本文档先于代码**。在用户逐条批准本 ADR 之前**不动任何实现**、**不开真实库**、**不做激活**。
> 本 ADR 批准后，实施与激活仍分两步各自取证（先例：ADR-048 / ADR-069 / ADR-071）。

---

## 0. 要解决什么（**先说清现状**）

S8 建完了**引擎**，但**没有装配到生产链路**。实测（2026-10-03，全仓 grep）：

```text
CHARACTER_STORY_COGNITION_ENABLED
  src/** 里 **0 处**（只存在于 ADR-093 D16 的设计文字与各交接单的"尚未落地"）

commitStoryTurn / createStoryLedgerStore / buildStoryAffectProposals / buildStoryRelationshipProposals
  调用者**只有** scripts/postlv2-s8-*.ts（五道门）
  src/main.ts / 调度器 / turn-gateway **一次都没有调用**
```

⇒ 今天**没有可翻转的开关**：即使往 `.env` 写一个变量，也没有任何代码读它。
⇒ 本 ADR 要冻结的正是"**补上这段装配**"的设计，而不是"打开一个已有的开关"。

## 0.1 三条前置事实（设计必须建立在它们之上）

| 事实 | 出处 | 对设计的约束 |
|---|---|---|
| 生产链路里**没有故事运行器**（谁把用户的"选择"变成已提交的世界变更？） | ADR-093 `R-3` | `D02` 必须**新设计**这个入口；它不在 ADR-093 的交付范围内 |
| `D13` 的**独立故事水位**未接线 | `L-S8-12` | `D03` 要么补上，要么**书面接受**首版的替代口径 |
| 行为槽 `S8-A43` = `NOT RUN`；`S8-A38` = FAIL（已裁定残差）；金标未人审 | 门判定 §0 | `D09` 的前置清单必须**如实**列出，不许用"工程已通过"顶替 |

---

## D01 · 开关：名字、缺省、消费点、回归锁

```text
名字    CHARACTER_STORY_COGNITION_ENABLED
缺省    代码缺省 **false**（`.env` 不写 = 不启用）
消费点  `src/main.ts` 的装配：装不装故事账本端口 / 跑不跑故事消费 / 渲染不渲染入模块
回归锁  `pnpm m4:test` + `pnpm m4.5:test` 里加"开关必须被**真的消费**"的静态断言
```

⚠️ **为什么必须有回归锁**：`CHARACTER_MEMORY_BACKGROUND_ENABLED` 就是因为只被读进 `flags.ts`、
没有任何消费者，才变成 D3（一个惰性、看起来能开的开关）。本 ADR **不允许**重演它 ——
若某一步只能落地开关而落不了消费点，那么开关必须**如实报 NOT-WIRED**（启动告警），
**不得**假装已生效。

## D02 · 生产故事入口（**本 ADR 唯一的实质新设计**）

它要在真实对话里回答三个问题：**谁、什么时候、把什么**提交成已提交的世界变更。

### D02.1 三条硬约束（继承，不重开）

```text
① 模型只能**提案**，世界判定归 `advanceFromProposal()`（ADR-091 §1 / 与 M4.5 同一条纪律）
② 服务端绑定：`interaction_kind` / `interaction_ref` / `anchor_conversation_event_id`
   只能由服务端填（ADR-093 D01）；客户端与模型都**不能**自报
③ 不做词形判据：不用"用户说了某个词"来识别选择（先例 `L-M55-15`：词形判据会误触发）
```

### D02.2 首版口径（**提案 → 判定 → 提交**，三段分离）

```text
① 入口条件（服务端）：`CHARACTER_STORY_COGNITION_ENABLED=true` **且**该会话存在一个
   **用户显式开始**的活跃 run（`runId` 由服务端生成并持久化）。不自动开始任何故事。
② 选择解析（模型提案）：模型在该轮只被允许产出**候选 `choiceId`**（内容包定义的机器键），
   形状进既有提案通道（`proposalType` 新增受控值 `story-choice`）。
③ 世界判定（程序）：`advanceFromProposal(pack, state, { choiceId, expectedRevision, expectedStoryVersion })`
   —— 非法选择（未知 choice / 非 frontier / revision 过期 / 版本不符）**一律拒收**，
   并**不产生**任何状态副作用。
④ 提交（程序）：判定通过 ⇒ `commitStoryTurn()` 原子落账本，绑定：
     interaction_kind = 'user_choice'
     interaction_ref  = 该会话 id（服务端）
     anchor           = **触发本轮的那条用户消息**事件 id（服务端）
     idempotencyKey   = `story-commit:<runId>:r<revision>:<anchorEventId>`（服务端拼）
```

⚠️ **为什么 anchor 必须是那条用户消息**：它同时是因果身份键（ADR-093 `D05`/`R-4`）
与 `character_domain_events.primary_source_event_id` 的**语义正确**来源（`R-2`）。
少了它，故事经历既进不了根，也进不了状态/习惯。

### D02.3 时序（在轮次的哪一步）

```text
beginTurn → （若启用且 run 活跃）模型产出候选 choiceId
         → advanceFromProposal 判定
         → 通过则 commitStoryTurn（账本 + 观测，同一事务）
         → 本轮回复照常生成（**回复内容不因提交而改变**；它只影响后续轮的状态与入模）
completeTurn → 账本已提交（不回滚）
```

⚠️ **回复与提交解耦**：回复生成失败**不**回滚世界提交（那是两件事）；
反之，世界提交失败**不**影响回复。两者的失败各自如实记录。

### D02.4 首版**不做**

- 不做"她替用户选"（选择必须来自用户）；不做自动开始/自动推进剧情；
- 不做多用户/多 run 并发仲裁（单用户单 run；并发 run 一律拒收）；
- 不做故事事件的**外部**应用集成（S8 的能力影响表 = `NONE`）。

## D03 · 消费者的调度与水位

```text
Affect / Relationship：提交后由既有调度器消费；幂等单元 = **提交身份**（已实现，`D09` 的 `unit=commitId`）
Reflection：走既有窗口（`story_outcome` 触发已实现）
水位：`D13` 要求**每消费者一条独立故事水位** —— 目前**未接线**（`L-S8-12`）
```

**两个候选，请在批准时择一**：

| 选项 | 内容 | 代价 |
|---|---|---|
| **A（推荐）** | 接线独立故事水位（每消费者一条），实现 `D13` 原文 | 新代码 + 新证据；WP6 的 `lifecycle:verify` 需要加"多消费者水位推进"的判据 |
| B | 首版用"**提交时同步消费 + 幂等键兜底**"，把 `L-S8-12` 书面接受为残差 | 不许声称已满足 `D13`；崩溃窗口内可能出现"提交了但没消费"，需靠补扫兜 |

> ✅ **2026-10-03 裁定：选 A**。⇒ 选项 B 的"书面接受 `L-S8-12`"**不成立**，
> `L-S8-12` 必须在实施阶段被**真正销账**（接线 + 多消费者水位推进的读数），
> 而不是被接受为残差。`D09` 第 4 项因此是**硬前置**，不是"或书面接受替代口径"。

## D04 · 入模额度（**与开关分开的两件事**）

```text
CHARACTER_STORY_COGNITION_ENABLED   决定"装不装、跑不跑"
ContextBudget.adaptiveSelfTokens    决定"入不入模"（缺省 **0**）
```

⚠️ **必须分列**：只开总开关而额度为 0 ⇒ 消费照跑、状态照变，但**她看不到**
（提示词里没有那一块）⇒ 用户侧观感是"什么都没发生"。激活时**必须**分别裁定这两项，
并在读回里分别取证（先例：`CHARACTER_ROLLUP_TOKENS`、`CHARACTER_GOAL_TOKENS`）。

## D05 · 认知完整性审查（`Privileged Cognitive Operation`）

按 `docs/architecture/cognitive-integrity.md`：**任何能改变长期认知的功能**都必须过这道审查，
不得因"只是接线"而例外。

| 审查项 | 本设计的答案 |
|---|---|
| 它改变什么认知？ | 情绪轴、与当前用户的关系轴、**有限三个行为槽**之一；全部经各自**既有放行口** |
| 有没有绕过放行口的新入口？ | **没有**：`D02` 的提交只写**世界账本**，认知变化仍走 affect/relationship/reflection 既有提案与放行口 |
| 顺序硬约束（归因先于注入入口） | **满足**：归因侧 `M5.1-D01 = CLOSED`（2026-09-20）早于本入口 |
| 失败关闭面 | 非法选择 / 版本不符 / 非 frontier / 已撤回 / 隐藏条目 ⇒ **具名拒收 + 零副作用**（已实现并由门守住） |
| 可查 / 可审计 / 可降档 | 账本 + 事件 + 撤回 + 门读数；⚠️ 措辞层**没有**启发式守卫（`DR-11`） |

## D06 · 真实库迁移（`v9` → `v12`）

真实库按记录在 **v9**，而迁移表已到 **v12**（`v10`/`v11` 属别的里程碑，`v12` 是 S8 的账本）。
⇒ 要让生产真的消费故事，必须把 **v10–v12 一并**应用。程序（§5.1 逐字）：

```text
① 租约（跨进程单持有）→ ② pre-open verified snapshot → ③ 拿到本进程 token
④ 应用迁移（`PROJECT_LG_ALLOW_KERNEL_MIGRATION=1`，且**需用户当轮逐字授权**）
⑤ SELECT-only 读回核对（表在 / 版本 = 12 / 既有行逐字未变）
⑥ 任何一步不符 ⇒ INCIDENT HOLD，**不**自动修复、**不**反复试开
```

⚠️ 本 ADR **不**授权任何一次真实库操作；`D09` 的清单里它是**独立一项**。

## D07 · 回滚

```text
配置回滚（首选手动，秒级）：删掉 `.env` 里那一行（或改 false）⇒ 消费与注入即停
保留物：`storyline_commits` / `storyline_observations` 行、`STORY_*`/`AFFECT_*`/`RELATIONSHIP_*` 事件、
        撤回记录、水位 —— **一律不删**（删了就无法解释"她为什么曾经那样"）
不回滚：迁移 v12（本仓库不写 down 迁移）；表留着无害
验证：回滚后重跑读回脚本，应显示"开关关闭 ⇒ 未消费、未注入"
```

## D08 · 激活读回与"首次使用"

- **读回**：新增 `scripts/postlv2-s8-activation-readback.ts`（**SELECT-only**，带只读机器闸），
  逐项核对：表存在与行数 · 双流水位 · 开关在进程内真的被消费 · `adaptive-self` 是否入模 ·
  既有行逐字未变（摘要）。
- **⚠️ `FIRST-USE NOT OBSERVED`**：读回**不**等于"她已经在用"。轮级的真实消费、
  状态变化与入模观察要等**首个真实对话轮**，并**单独**记录（先例 ADR-069 §4 / ADR-071 §5）。
  **不许**凭配置宣布"运行验证通过"。

## D09 · 激活前置清单（**逐项**，缺一项即不得激活）

| # | 前置 | 当前状态 |
|---|---|---|
| 1 | ADR-093 的 8 道 S8 门全 PASS | ✅ 已满足（本次会话读数在案） |
| 2 | `pnpm typecheck` + `pnpm m4.5:ci` EXIT 0 | ✅ 已满足（2026-10-03） |
| 3 | `D01` 开关 + `D02` 生产入口 + `D03` 消费者调度 + `D04` 额度 全部实现并有门 | ❌ **未实现**（本 ADR 批准后才动工） |
| 4 | `D03` 的"至多一次"读数（含多消费者水位或书面接受替代口径） | ❌ 未满足（**`D03` 已裁定选 A ⇒ 必须真接线 + 出多消费者水位推进的读数，不接受替代口径**） |
| 5 | `D02` 的**放行口审查**读数（非法选择 / 版本不符 / 非 frontier 全拒 + 零副作用） | ❌ 未满足（离线判据已有，生产入口的读数没有） |
| 6 | 行为槽 `S8-A43`：**跑过** 或用户**书面接受不跑** | ⚠️ 当前 `NOT RUN` + 用户 2026-10-03 已接受为残差（**批准本 ADR 时请再确认一次**） |
| 7 | 金标人审 | ⚠️ `AWAITING HUMAN REVIEW`（激活不依赖它，但**不得**趁机自签） |
| 8 | 真实库迁移授权（`D06` 的逐字授权 + 已验证快照） | ❌ 未申请 |
| 9 | 回滚演练（`D07`，dry-run） | ❌ 未做 |

## D10 · 本 ADR **不**主张什么

- **不**主张 S8 能力通过：行为槽 `NOT RUN`；`S8-A38` 是已裁定残差。
- **不**主张激活会带来行为增益：**没有任何**行为读数支持这一点（见门判定 §0）。
- **不**主张开关打开就等于她"记得那次二面"：入模还取决于 `D04` 的额度。
- **不**主张生产激活一次到位：本 ADR 批准 ⇒ 只授权**实施**；激活本身在实施取证之后**另行**批准。

## D11 · 修订表

| 编号 | 日期 | 类型 | 内容 |
|---|---|---|---|
| `R-1` | 2026-10-03 | **设计缺口**（`D03` 的"由既有调度器消费"不够精确） | `D03` 写的是"Affect / Relationship：提交后由既有调度器消费；幂等单元 = 提交身份"。实现到装配那一步才发现：`main.ts` 的既有消费者是 `maybeRunAffectEvaluation()` / `maybeRunRelationshipEvaluation()`（`src/infrastructure/runtime/{affect,relationship}-scheduler.ts`），它们的**输入形状是"对话轮次"**，而故事结果是**世界账本提交**。⇒ 两者之间**不是一根线**，缺一条冻结的接线决定。下面 `R-1.1` 是本 ADR 的补全。 |

### R-1.1 故事结果如何进入既有调度器（**待实现，先冻结口径**）

三个候选中**选 ①**：

```text
① 故事结果 ⇒（既有提案构造器 buildStoryAffectProposals / buildStoryRelationshipProposals）
   ⇒ 走各自**既有放行口**（affect-validator / relationship-validator 的 STORY_DERIVED 分支）
   ⇒ 落 AFFECT_* / RELATIONSHIP_* 领域事件
   即：**不**改调度器的输入形状；故事只作为**提案来源**，放行口与事件形态逐字不变。

② 把故事结果伪装成"一轮对话"喂进调度器
   ❌ 否决：那会让"她经历了一次剧情"与"用户跟她说话"在账本里长得一样
      （`S8-A14` 明确要求 system/剧情推进**不得**看起来像一次真实会话）。

③ 新建一套并行的故事专属调度器
   ❌ 否决：两套调度器 = 两套水位语义与两条放行路径，`D05` 的"过既有放行口"会被绕过。
```

**选 ① 的三个直接后果**（实现时必须照做）：

1. **消费回路的 `consume` 步骤 = "构造提案 → 过放行口 → 落事件 → 推进水位"**；
   水位只在**放行口接受之后**推进（拒收 = 没消费，下次重来 —— 与 `D03` 的"失败就停"同一条纪律）。
2. **`D04` 的额度与它无关**：额度只决定"入不入模"，不影响提案与落事件（两件事分列）。
3. **提案构造器需要 `variablesBefore`**（`buildStoryAffectProposals` 的既有签名要求
   "该 revision 之前的变量"）⇒ 消费步骤必须能拿到**按 revision 有序**的提交序列
   （回路已经把有序序列给它了，见 `consumer-loop.ts` 的 `commits` 参数）。

⚠️ **`R-1.1` 冻结的是口径，不是实现**：`main.ts` 的消费点与调度接线仍属 `D09` 第 3 项，**未做**。在它做完之前，`D09` 第 3 项 = `NOT MET`，且**不得**声称生产已在消费故事经历。

### R-1.2 接线形状（**已侦察到的既有调用点**，实现时照抄，不要再发现一遍）

消费步骤走**既有**两段（与 `src/infrastructure/runtime/affect-scheduler.ts:184-203` 逐字同构）：

```text
① 构造放行口依赖（照抄 affect-scheduler 的 deps）：
     registry: createFullDomainEventRegistry()
     evidence: { findEvents: … }
     processed: { hasProcessed: key => hasProcessedOperation(db, key) }
     affect:    { getAffectState: cid => (await getAffectProjection(db, cid))?.state }
     policy:    { activeUserId }
② const outcome = await validateAffectProposal(deps, proposal)
     · !outcome.accepted ⇒ **不推进水位**（放行口拒收 = 没消费）
③ const applied = await applyAcceptedEvents(db, characterId, outcome.acceptedEvents,
                     [affectReducerFor(characterId)], now)
④ 放行口接受之后**才**推进水位（`advanceWatermark`，逐条）
```

关系侧同形：`validateRelationshipProposal`（现成 deps 形状见 `relationship-scheduler.ts` /
`adapters.ts:414`）。

⚠️ **两个接线难点（必须正面处理，不许绕）**：

```text
① `buildStoryAffectProposals` 需要 `variablesBefore`（该 revision 之前的变量）
   ⇒ 从回路的 `commits`（已按 revision 升序）里算，**不**另读一次库
② 三个消费者各自持水位 ⇒ 一个消费者被放行口拒收**不得**影响其它消费者
   （回路已保证：各自 break）
```

⚠️ **`D01` 的消费锁与本节同一步落地**（`m4:test` / `m4.5:test` 加
"`src/main.ts` 必须出现 `storyCognitionEnabled` 的真实消费"的静态断言）。
**先挂锁再声称已消费 = 把锁变成假绿** —— 这正是 `CHARACTER_MEMORY_BACKGROUND_ENABLED` 的教训。

### R-2 生产**没有内容包**（装配的硬阻塞，2026-10-03 实测发现）

`D02` 与 `R-1.1`/`R-1.2` 都假定了"有一个内容包可用"，但实测全仓只有一个：

```text
$ Get-ChildItem -Recurse -Filter story-pack.ts -Path src,evals
evals/storyline/jichuang-interview-two/story-pack.ts     ← **只有这一个**，而且它是 evals 夹具
```

⇒ **`src/**` 里没有任何生产内容包**。而 `src/main.ts` **不得** import `evals/**`：
evals 是测试资产（把夹具接进生产 = 让"某一次评测用的剧情"成为她的真实经历来源）。

**⇒ 装配在此之前无法落地。** 这不是接线问题，是**缺一份生产资产 + 一条来源决定**：

| 选项 | 内容 | 代价 |
|---|---|---|
| **A（建议）** | 新建 `src/content/storyline/<storyId>/` 作为**生产内容包**（含 `storyVersion` + 内容摘要 + 许可与来源登记），与 `src/character/苏沐薇.ts` 同级的"版本化内容资产"待遇 | 需要一条内容来源决定（谁写的、许可、是否与 evals 夹具同源），并可能需要 `pnpm doc:sync` 式的摘要登记 |
| B | 把 evals 夹具**提升**为生产包（移动而非复制） | 会让评测失去独立夹具；且 `evals/**` 变生产依赖，边界反转 |
| C | 首版不做生产故事内容，只落地"开关 + 装配骨架"，等有内容再开 | 那就是一个**空转的消费者**（`D01` 明确禁止的 NOT-WIRED 形态）⇒ 不能这么交付 |

⚠️ **本 ADR 不擅自选**：内容来源属"长期认知的来源边界"（与 `docs/architecture/cognitive-integrity.md`
同级），应由用户裁定。⇒ 在 `A` 被批准并落地之前，`D09` 第 3 项（`main.ts` 装配）**无法完成**，
`D12.1` 进度表里它保持 `NOT MET`。

⚠️ 已做且已撤回的尝试（留档以免重犯）：2026-10-03 曾在 `main.ts` 里写入消费点，
因 `storyCognitionPack()` 不存在而**整块撤回**——**没有**留下"引用了不存在的东西"的半成品，
`typecheck` 与 `main.ts` 的 S8 残留均为 0（实测 `Select-String storyCognitionEnabled|createStoryCognition` = 0 命中）。

#### R-2 的解决（**2026-10-03 用户裁定 = 选项 A，已执行**）

```text
权威内容包上移到生产资产位：
  src/content/storyline/jichuang-interview-two/story-pack.ts   ← 现在的权威（git mv，非复制）
  evals/storyline/jichuang-interview-two/story-pack.ts         ← 兼容再导出（`export *`）
```

- **方向变成 `evals → src`**（正确方向）；`src/content/**` **不** import `evals/**`。
- **为什么是再导出而不是复制**：复制会让两份内容各自漂移，而 `storyVersion` /
  `CONTENT_DIGEST` 的存在意义正是"内容变了必须能被发现"。
- `pnpm postlv2:story:verify`（内容摘要与 `.ink` 源交叉核对）**EXIT 0** —— 说明移动**没有**动内容身份。

⇒ 于是 `main.ts` 的消费点**能落地了**：

| 项 | 状态 |
|---|---|
| `main.ts` 消费点（`storyCognitionEnabled` ⇒ 构造装配 + 跑一圈消费） | ✅ **已接线**（干跑不执行；`--test` 规矩照旧） |
| `D01` **消费锁**（`m4:test`：`main.ts` 必须**同时**有 `storyCognitionEnabled` 与 `consumeOnce`） | ✅ **已挂且通过** |
| `affect` 一路的放行口 → 落事件 | ✅ 已接（`story-cognition.ts`） |
| `relationship` / `reflection` | ❌ 未接（水位停在 0 = "没消费过"） |
| `D02` 提案受控值 · `D04` 额度 | ❌ 未做 |
| 真实库 v10–v13 · 读回 · 回滚 · 激活 | ❌ 未做（需另行批准） |

⇒ `D09` 第 3 项（`main.ts` 装配）**已满足**；第 4 项（至多一次读数）机制面 + 回路面已满足；
第 5 项（生产入口放行口读数）由 `postlv2:s8:production:verify` 覆盖。
⚠️ **但开关仍然缺省 false**：⇒ 今天生产**依然不会**消费故事经历，直到 §D06/§D08 的激活另获批准。

### R-3 程序渲染器（`L-S8-29` 的前提，2026-10-03 冻结并已实现）

**决定**：装配**不自己拼文本**，而是接收一个**渲染器**；生产实现在**内容资产侧**
`src/content/storyline/jichuang-interview-two/render.ts`。

```text
renderStoryVisibleEvent(eventId) → 程序渲染正文（查表）
  未知 id ⇒ **抛错**（绝不回退成占位符，也绝不原样返回 id）
assertRendererCoversPack(pack) → 逐条核对"包里每个 visibleEvent 都有正文"
  · 计数型自检，必须自证 checked > 0（否则 MEASUREMENT INVALID，不是通过）
  · 漏一条即抛
```

**为什么放在内容资产侧**：文本是**作者定义的内容**，必须与内容包**同版本、同来源登记**地演进
（改文本 = 改内容 ⇒ 与包一起升 `storyVersion`）。放在装配层会让"剧情正文"散落到运行时代码里。

**三条不变量**（后续接线必须照做）：

```text
① 文本**只**来自内容资产的表：不来自模型、不来自装配层现编
② **失败关闭**：未知 id 抛错 —— 占位符正是让"没内容"看起来像"有内容"的那种失败
   （第一版占位符的代价有读数：语义 macro-F1 掉到 0.34）
③ 完整性自检在**构造期/门里**跑，不留到运行时才暴露成"她好像没经历过"
```

**实测**（2026-10-03）：`assertRendererCoversPack(JICHUANG_PACK)` ⇒ **`checked = 12`**；
未知 id ⇒ **抛错**（负控通过）。⚠️ 自检第一次跑就抓出 **4 个漏项**（四个结局条目）
—— 那正是它存在的意义。

⚠️ 本决定**只解决渲染器**：`reflection` 消费者**仍未接线**（它的接线是下一步），
`L-S8-29` 因此只销掉"前提未定"这一半。

### R-4 撤回的用户入口（`L-S8-09`，2026-10-04 冻结并已实现）

**形状**（镜像 `pnpm memory:retract`，本仓库"用户撤回认知依据"的既有形状）：

```text
pnpm story:withdraw <sourceId> --reason user_withdrew|user_corrected [--note <text>]   （**写操作**）
```

**认知完整性审查**（`Privileged Cognitive Operation`，AGENTS §4）：

```text
改变什么认知   撤回一段故事经历的**认知使用资格** ⇒ 依赖它的行为槽不再入模
绕过放行口？   **没有**：只追加一条撤回事件，不直接改任何投影或状态
失败关闭面     来源不可解析 / 理由不在闭集 / **引用不存在** ⇒ 具名拒收 + 零写入
可查可审计     事件进领域事件流，带 reason 与 note
可降档         只影响使用资格，**不**物理删除世界历史（`ADR-093 D12`）
顺序硬约束     归因（`M5.1-D01 = CLOSED`）早于本入口，满足
```

**三条失败关闭判据**（`admin.ts` 负责前两条，命令体负责第三条）：

```text
① `isStorySourceId(sourceId)` 不过 ⇒ `story_withdraw_source_unparsable`
② `--reason` 必须在闭集里 ⇒ 否则 `story_withdraw_reason_unknown`（自由文本会让审计分不了类）
③ 被撤回的提交**必须真的在账本里** ⇒ 否则 `story_withdraw_target_missing`
   —— 否则会留下"悬空撤回事件"（撤回了不存在的东西，日后无法解释）
```

**实测**（2026-10-04）：`postlv2:s8:withdraw:verify` **PASS 13**（`W1`–`W5`：六类坏输入各具名拒收 ·
payload 过契约校验 · 隔离库正控"根变 `story_root_withdrawn`" · 幂等不产生第二条 · 引用不存在则零写入）。
真实库上跑命令本体：生产状态机 `IDLE → … → RELEASED`（**cleanClose=true**，post-close 快照
`2026-10-04T03-07-04-578Z-8b2ec4f7e099`），因账本该 run 有 0 条提交而**具名拒收且零写入**。

⚠️ 撤回**入口**已就位；真实库里目前**没有可撤的东西**（账本为空）—— 这条入口要等她真的经历过剧情选择。

## D12 · 批准后要产出的东西（按序）

```text
① 实现 D01（开关 + 回归锁）/ D02（生产入口 + 提案受控值）/ D03（消费者调度与水位）/ D04（额度接线）
② 新门：`postlv2:s8:production:verify`（生产入口的放行口读数：非法选择全拒 + 零副作用 + 绑定只由服务端填）
③ 真实库：快照 → 迁移 v10–v12 → 读回（各自取证）
④ 激活记录（新的状态修订载体）+ `D08` 读回 + `FIRST-USE NOT OBSERVED` 如实登记
⑤ 回滚演练
```

### D12.1 实施进度（**如实分列**，2026-10-03）

| 项 | 状态 | 证据 |
|---|---|---|
| `D03=A` 水位**机制**（迁移 **v13** + 端口 + SQL 适配 + 只许前进/不许跳号） | ✅ **已实现并验证** | `pnpm postlv2:s8:lifecycle:verify` **PASS 33**（新增 `L7`/`L8`/`L9`）· `pnpm m3:migrate-gate` EXIT 0 |
| `D03=A` **生产消费回路**（调度器按水位消费 + 推进） | ✅ **逻辑已实现并验证**（`consumer-loop.ts`）；❌ **调度器接线未做** | `pnpm postlv2:s8:production:verify` **PASS 20** 的 `N7`/`N8`：按水位逐条消费 · 失败**停住不跳过** · 重跑**从同一条继续**（调用序列 `[1,2,3,3]`）· 成功的消费者不受影响 |
| `D02` **入口逻辑**（提案 → 判定 → 提交；绑定只由服务端填） | ✅ **已实现并验证** | `pnpm postlv2:s8:production:verify` **PASS 20**（`N1`–`N6`）· `pnpm kernel:test` 26/0 |
| `D01` 开关 | ⚠️ **半**：`flags.ts` 字段已加（缺省 false；`m4:test` 259/0 锁住缺省值）；入口接受 `enabled` 并拒绝在关闭时做任何事（`N1`）。**`main.ts` 的消费点未做** | ⚠️ **消费锁刻意未挂**：先挂锁再声称"已消费"会把锁变成假绿。锁与 `main.ts` 装配**同一步**落地（见下） |
| `D02` 提案受控值（`proposalType='story-choice'`） | ❌ 未做 | 入口现在从**参数**拿提案；接进提案通道是装配那一步的事 |
| `D04` 额度接线 | ❌ 未做 | — |
| `D09` 第 3 项（`main.ts` 装配 + 可跑的消费调度） | ❌ 未满足 | 下一步就是它 |
| `D09` 第 4 项（至多一次读数） | ✅ **机制面 + 回路面**已满足（`L7`/`L8`/`L9` + `N7`/`N8`）；调度器面未接线 | 同上 |
| `D09` 第 3/5 项 · 真实库 · 激活 | ❌ 未做 | — |

⚠️ **`L-S8-12` 的销账是"机制已接线、读数已出"，不是"生产已在用"**：
本步只把 `D13` 的**机制**落地并证明（独立、单调、不跳号、重放一致），
生产消费回路的接线属 `D02`/`D03` 的剩余部分。**不得**据此说 `D09` 第 3/4 项已满足。

---

## R-5（2026-10-04 修订读数，只追加）

> 纪律：`TD-16` —— 本文的 `R-1.1`/`R-2`/`R-3`/`R-4` 与 `D12.1` 是**当时**的读数，**一字不改**；
> 本节的修订读数与它们**并列**，冲突时以本节为准。日期的绝对口径 = **2026-10-04**。

| # | 修订项 | 修订读数 | 证据 |
|---|---|---|---|
| 1 | **`D01` 消费点 + 消费锁** | ✅ **已落地**：`src/main.ts:1991` 的守卫（`this.flags.storyCognitionEnabled && this.kernel && !this.dryRun`）⇒ `createStoryCognition(...)`（`:1992`）⇒ `consumeOnce()`（`:2002`）；消费锁 `scripts/kernel-tests-memory.ts:3499-3512`（`m4:test` 通过） | `src/main.ts:1991-2002` · `scripts/kernel-tests-memory.ts:3499-3512` |
| 2 | **三个消费者已接线** | ✅ **affect / relationship / reflection 全部接进回路数组**：`story-cognition.ts:273` 的 `steps: [affectStep, relationshipStep, reflectionStep]`（`affectStep` 定义 `:88`、`relationshipStep` `:136`、`reflectionStep` `:202`） | `edfdb195` · `7bde509e` · `src/infrastructure/runtime/story-cognition.ts:88/136/202/273` |
| 3 | **真实库 v10 → v13** | ✅ **已应用**：`#11 post-lv2-story-source-vocab` · `#12 post-lv2-s8-story-ledger` · `#13 post-lv2-s8-story-consumer-watermarks`；活库只读读回 schema=**13**，三张表都在 | `161d94ed` · [S8 激活记录](../post-lv2/S8-Activation-Record.md) `:35` · 同文件 `:47` |
| 4 | **激活与两层读回** | ✅ **PASS**：`.env` 设 `CHARACTER_STORY_COGNITION_ENABLED=true`（**代码缺省仍 false**，`src/kernel/app/flags.ts:562`）；配置层读回 `postlv2:s8:activation-readback` PASS · 活库层 `postlv2:s8:activation-readback:db` PASS | `S8-Activation-Record.md` §7 · `S8-Gate-Decision.md` §5 |
| 5 | **`R-3` 程序渲染器** | ✅ **已实现**：`src/content/storyline/jichuang-interview-two/render.ts`；`assertRendererCoversPack` 实测 `checked = 12`、未知 id 抛错；`reflectionStep` 由它生成正文 | `ADR-094` `R-3` · `S8-Activation-Record.md` §7（`L-S8-29` 行） |
| 6 | **`R-4` 撤回的用户入口** | ✅ **已实现**：`pnpm story:withdraw <sourceId> --reason …`（`package.json`、`src/main.ts:4353`）；门 `postlv2:s8:withdraw:verify` **PASS 13** | `a56af48e` + `83c15094` + `576ed4f7` · `ADR-094` `R-4` |

### R-5.1 逐字声明

> **本 ADR 的 `:244`、`:289-302`、`:328-330`、`:334`、`:365-366`、`:413-425`、`:427-429` 的"未做"读数以本节 `R-5` 为准。**

### R-5.2 本节**不**主张什么

- **不**主张 `D09` 各项已全部满足：`D02` 的**提案通道**（`proposalType='story-choice'`）在 `src/**`
  仍**不存在**，`D04` 额度接线仍属未做。
- ⚠️ **生产入口无调用者**：`StoryCognition.ingestChoice`（`story-cognition.ts:71-74` 接口、`:239-247` 实现）
  在**全仓没有任何生产调用者** ⇒ `storyline_commits` 生产里**永远 0 行** ⇒ 消费回路每次 `open()`
  都是"无可消费项"。**这不因本节销账而消失** ⇒ 见 `L-S8-30` /
  [S8 消费入口缺口立案](../post-lv2/S8-Consumption-Entry-Gap.md)。
- **不**主张能力通过：行为槽 `S8-A43` 仍 `NOT RUN`、`S8-A38` = 0.7675 是已裁定残差。
