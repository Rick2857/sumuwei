# M6 · 验收契约（Acceptance Contract）

```text
状态      : **DESIGN FROZEN**（用户 2026-09-21 裁定 D-1 / D-2 / R-2 / R-3 全部按建议获批）
归属      : M6（Lv1 Hardening）· WP1（设计冻结与验收契约）
设计载体  : docs/adr/ADR-050-rolling-summary-provenance-boundary.md（裁定记录见其 §10；**本文件不重复其设计论证**）
前提事实  : docs/m6/M6-Baseline.md · docs/m6/M6-Affected-Surface-Map.md（WP0，`BASELINE CAPTURED`）
出口      : ✅ 裁定已完成 ⇒ `DESIGN FROZEN` ⇒ 已进入 WP2（执行范围由用户一次性批准）
```

---

## 1. 状态与口径（**先立规矩，再谈通过**）

### 1.1 三分状态（不得合并成一句话）

| 名称 | 含义 | 谁判 | 今天的值 |
|---|---|---|---|
| `M6` | 本计划冻结范围内的**工程与自动化验收** | WP10/WP11 + `m6:gates` | 未开工 |
| `G1` | 经批准的**当前阶段范围**综合验收（**含人工复核**） | G1-A/G1-B | 未开工 |
| `Original Lv1 Requirements` | README §"与原始计划的核对"列的原始要求 | 矩阵（§2） | **`PARTIAL`**（状态演化延期至 M7；Rolling Summary 本轮才补） |

**硬纪律**：只要原始状态演化要求仍延期，`Original Lv1` **永远**保留 `PARTIAL`。
**不得**借用 `G1 = PASS` 宣布原始 Lv1 全部完成，也**不得**用改测试措辞消除缺口。

### 1.2 状态词表（沿用计划 §8.1，不得新增）

```text
PASS                 已测、量具有效、满足冻结判据
FAIL                 已有效测量，产品或判据要求未满足
NOT RUN              必要测试没有运行
MEASUREMENT INVALID  分母为零、形状缺失、量具失效、证据归属无效
BLOCKED              明确前置依赖尚未满足
PARTIAL              已完成部分要求，不能替代 PASS
```

聚合规则：**先列全部阻塞原因，再给 overall**；任何必选门不为 `PASS`，`M6` 就不能 `PASS`。

---

## 2. 要求矩阵（原始要求 / 现实现 / 本轮补齐 / 延期归属）

依据：`README.md:49-52` · `M6-DSH-Execution-Plan.md` §0/§2.1 · WP0 的只读核对。

| ID | 要求 | 现实现（可核对的证据） | M6 本轮 | 归属 / 依据 |
|---|---|---|---|---|
| **O-1** | 持续存在的角色（身份不漂移） | ✅ M3 完成（Seed 版本化 + `identity-core` + `snapshotHash` 进 trace） | 不重做；纳入长对话回归 | README:49 |
| **O-2** | **状态演化**影响行为 | ❌ 未做 | **不补** | README:50 明确并入 **M7 Relationship** |
| **O-3** | 重启后连续性 | 🟡 持久化链已落地（M4/M5），但**关闭/恢复生命周期未接生产入口**（`src/main.ts` 零引用 `production-db-safety`） | **补集成验收**（WP6b） | WP0 §7.2 的 **P-2** ⇒ 当前 `BLOCKED` |
| **O-4** | Context Budget（历史放不下时有界） | ✅ M5 完成（6 类额度 + 唯一裁剪算法） | 追加摘要额度与类别 | `selector.ts:53-97` |
| **O-5** | **Rolling Summary** | ❌ **未实现**（`'rollup'` 只有声明，无 provider） | ✅ **本里程碑核心** | README:51 · `context.ts:65` |
| **O-6** | 长期记忆（记住/纠正/遗忘） | ✅ M4 / M4.1 完成 | 只保证"在摘要旁路仍有效" | AGENTS §4 硬性质 |
| **O-7** | 关系 / 情绪 / 信念 / 目标 / 反思 | ❌ | **不补** | M7–M11 |

| ID | M6 核心（计划 §2.1） | 落点 | 出口门 |
|---|---|---|---|
| **C-1** | 有来源约束的会话 Rolling Summary | ADR-050 §3 | M6-G2 |
| **C-2** | 上下文预算组合（记录的就是注入的） | ADR-050 §3.5 + `selector.ts` | M6-G3 |
| **C-3** | 纠正 / 遗忘 / 归因资格在**摘要旁路**仍有效 | ADR-050 §3.4 | M6-G2 · M6-G4 |
| **C-4** | 连续对话与重启链 | WP6b | M6-G6（当前 `BLOCKED`） |

| 类别 | 内容 |
|---|---|
| **Engineering Support** | 隔离验收驱动、证据索引与量具、故障/恢复验收、规模测试、现有 Console 可用性、最终回归 |
| **Interview Surface** | 复用**真实验收记录**形成三个演示脚本；不另造假数据展示链；**不是**工程 PASS 的必要条件 |
| **明确延期** | M7–M11 · 自动情绪/关系成长 · 后台自主任务 · Break-Glass（`M511-G8` 仍 `NOT RUN`）· 新认知注入界面 · 自动长期记忆抽取 |
| **明确不追加** | 云部署 · 语音/Avatar · MCP 运行时 · 多步研究 · 网页全文抓取 · **向量库** · 新记忆后端 · 新前端框架 · 新遥测服务 |

**被刻意关掉的开关不得顺手打开**：`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`（默认 off）、
`CHARACTER_MEMORY_BACKGROUND_ENABLED`（`NOT-WIRED`）。WP0 已核对：两者在本机 `.env` / `.env.test` 中**均未设置**。
自动搜索是否进一步生产激活属于 **M5.5.1 单独裁定**，不捆绑在 M6 内。

---

## 3. 摘要样例集（WP1 必须冻结的夹具）

每条都写明**期望的机械结果**。`✓入选 / ✗拒绝 + 拒绝理由码` 必须是可断言的字面量。

### 3.1 合法样例（正控 —— 必须有非零分子）

| # | 夹具构造 | 期望 |
|---|---|---|
| P-1 | 同会话早期一条 `user_message`，走**升级写入路径**（受信归因：`RECORDED`，`contentOriginator = Known(USER)`，Axis B = confirmed），且已离开 16 条 Recent 窗口 | ✓ 入选；`qualification = 'ESTABLISHED'`；`text` **逐字**等于事件 `content`；`sourceEventId` 命中该事件 |
| P-2 | 同上，但有多条 | ✓ 全部入选（按 `sequence` 升序），`coveredSequenceRange.to` = 最大入选序列 |
| P-3 | 同上 + 该事件已形成一条 `active` 记忆 | ✓ 入选；与 `memory-recall` **可以同时存在**（两条链不同，不要求互斥） |
| P-4 | 摘要与 Recent 窗口有 1 条重叠 | ✓ 该条**只出现在 Recent**（按 source id 去重），摘要中不重复 |
| P-5 | 关闭态（`rollupTokens = 0`） | ✓ **产 0 个 section**；`packet.text` 与冻结基线**逐字节相同** |

### 3.2 纠正后失效样例（负控 —— 硬零）

| # | 夹具构造 | 期望 |
|---|---|---|
| N-1 | 早期用户陈述 → 后续用户纠正，旧记忆 `status = 'superseded'` / `supersededBy` 非空 | ✗ 拒绝，`invalidatedByMemoryState`；**新值**按 `active` 记忆参与 |
| N-2 | 同上，但**摘要自身**（若被持久化/缓存）仍含旧值 | 本设计**不持久化摘要**，因此该夹具断言的是"下一轮重新派生后不再含旧值" |
| N-3 | 早期用户陈述所挂记忆 `status = 'retracted'`（遗忘） | ✗ 拒绝，`invalidatedByMemoryState` |
| N-4 | `reset` / 新会话 | ✗ 新会话**没有任何**历史项（作用域天然切断） |

### 3.3 助手伪造经历拒绝样例（负控 —— 硬零）

| # | 夹具构造 | 期望 |
|---|---|---|
| N-5 | 一条 `user_message` 事件，但受信归因的 `contentOriginator = Known(CHARACTER)`（agent 用 user role 代发 —— **D01 的真实形态**） | ✗ 拒绝，`contradictedOrigin`；`item` 数 0 |
| N-6 | 一条 `user_message`，但**没有受信信封**（`attribution_origin = NULL` / `MIGRATED_LEGACY`） | ✗ 拒绝，`unconfirmedOrigin`（**不回落到 `actorType`**） |
| N-7 | 一条 `user_message`，受信读数在但 Axis B 不在 `confirmed` 分支 | ✗ 拒绝，`unconfirmedOrigin` |
| N-8 | 助手事件 / `tool_event` / `system_event` 的正文 | ✗ 拒绝，`nonUserSource` |
| N-9 | 外部证据 / 搜索 snippet / 网页正文 / 来源附录 | ✗ 拒绝，`nonUserSource`（`DR-4`） |

### 3.4 其它必测边界（沿用计划 WP2/WP4 的清单）

预算不足（摘要被裁且 trace 记 dropped）· 缺来源 / 重复来源 · 伪造 `sourceRef`（指向不存在的行）
· 摘要指令注入（来源正文里写"忽略以上指令"）· 扫描上限截断（`coverageTruncated = true`）
· 跨用户 / 跨会话隔离 · 单进程换库前的单例释放。

---

## 4. 门的定义（量程 / 硬零项 / 质量项 / 分母）

**通则**（AGENTS §6.2/§6.7/§6.8）：
① 每个门必须同时证明"测的范围对"与"结果对"；② 正控 / 负控 / 恢复三段式齐备；
③ **计数型检测器必须自检 `measured_count > 0`**，否则结论是 `MEASUREMENT INVALID` 而**不是** `PASS`；
④ 比率一律保存 `numerator / denominator / value`。

### 4.1 计划 §8 的 13 道门（编号沿用，不改）

| 门 | 命题 | 通过标准 | 主证据 |
|---|---|---|---|
| M6-G0 | 前置与证据归属成立 | 候选清楚；关键证据可追溯；非零测量 | WP0/WP1 + 索引 |
| M6-G1 | 测试与真实历史隔离 | 实际连接均指向授权沙箱；真实库未被试验打开；稳定窗口摘要一致；污染负控必响 | WP4/WP6/WP10 |
| M6-G2 | **摘要来源／作用域正确** | 见 §4.2 | WP2/WP3 |
| M6-G3 | **上下文／预算真实** | 见 §4.3 | WP3/WP4 |
| M6-G4 | 既有记忆与归因语义保持 | A–E 机制正负控成立；无非法覆盖/污染；资格降档与重放一致 | WP7 + M4/M5/M5.1.1 门 |
| M6-G5 | 行动与搜索真相 | 无"未执行却宣告成功"；出站次数/目标/来源与账本及回复对应 | WP6a/WP7/WP10b |
| M6-G6 | 重启与恢复有效 | 两进程间状态读回一致；恢复对象与 manifest 对齐；错误快照被拒；关闭可验证 | WP6b（**`BLOCKED`**） |
| M6-G7 | 规模正确性 | 10k 操作读数与 ≥10k 实际事件回放**分开**；投影一致；覆盖上限如实暴露 | WP8 |
| M6-G8 | 500 轮有效且质量达标 | 3×500 完成轮次；各轨迹满足**冻结的**有效率/质量阈值；硬违例 0 | WP9b |
| M6-G9 | Console 表达真相 | API/页面/CLI 与同源事实一致；合法与失败路径均实测；移除 UI 不影响核心 | WP5 |
| M6-G10 | 量具可信 | 正控/负控/恢复通过；计数 > 0；旧证据/空分母/缺阈值/skipped 均**不能**误绿 | WP4 + 每个新门 |
| M6-G11 | 最终代码回归与 Live | 必跑离线与 Live **全部实际执行**且成功；日志/配置/树指纹匹配候选 | WP10 |
| M6-G12 | 发布主张不越界 | 报告与机器读数一致；历史不改写；原始 Lv1 / M7 / G1 状态**分列** | WP11 |

### 4.2 M6-G2 细化（**摘要来源／作用域正确**）

**量程**：本轮 provider 实际产出的 section 的每一条 item，及其被 trace 记录的引用与拒绝计数。
**分母**：`分母 = 覆盖窗口内的合格来源总数`（由**独立复算**得出，不由被测 provider 自报）。

| 类别 | 项 | 阈值 |
|---|---|---|
| **硬零** | 非 `ESTABLISHED` 来源入模条数 | **0** |
| **硬零** | `contradictedOrigin` 来源入模条数 | **0** |
| **硬零** | 跨 `conversationId` / 跨用户来源入模条数 | **0** |
| **硬零** | 助手 / tool / system / 外部证据来源入模条数 | **0** |
| **硬零** | 无 `sourceRefs` 的 item 条数 | **0** |
| **硬零** | 引用解析失败（sourceRef 指向不存在的行）条数 | **0** |
| **硬零** | 因摘要产生的写入（`MemoryRecord` / DomainEvent / 账本行）条数 | **0** |
| **硬零** | 摘要正文出现在 trace / 遥测 / 账本中的条数 | **0** |
| **负控** | 非 `active` 记忆所挂来源入模条数 | **0** |
| **正控（非零）** | P-1 类夹具中实际入模的 item 条数 | **≥ 1**（否则 `MEASUREMENT INVALID`） |
| **正控（非零）** | trace 中摘要的引用/计数条目数 | **≥ 1** |
| **质量项** | `citation_resolvability = 可解析引用数 / 引用总数` | **= 100%** |
| **质量项** | `coverage = 实际入选数 / 窗口内合格来源数` | 报告值（**不设通过线**；超预算即如实降级） |
| **报告项** | 每类拒绝理由计数（闭集五项） | 全量给出，**不允许只报总数** |

### 4.3 M6-G3 细化（**上下文／预算真实**）

**量程**：`packet.sections` / `packet.droppedSectionIds` / `packet.text` 与 trace 记录的两两一致性，以及 prompt 组装路径的唯一性。

| 类别 | 项 | 阈值 |
|---|---|---|
| **硬零** | packet 与 trace 引用不一致的 section 数 | **0** |
| **硬零** | `droppedSectionIds` 与实际未入模集合的对称差 | **0** |
| **硬零** | 除 `createContextCompiler` 之外的文本拼接入口数（"第二 prompt 入口"） | **0** |
| **硬零** | `render()` 为空却仍产出 section 的次数 | **0** |
| **硬零** | 摘要挤掉不可裁项（identity / integrity-rules / 当前输入 / 程序结果事实）的次数 | **0** |
| **正控** | 预算充足时摘要 section 出现在 `packet.sections` | ≥ 1 |
| **正控** | 预算不足时摘要出现在 `droppedSectionIds` **且** trace 记 dropped | ≥ 1 |
| **恢复** | 撤回预算压力后摘要重新入模、且 `packet.text` 与预期逐字节一致 | 通过 |
| **质量项** | 估算器标记（`estimated` 与 provider usage 分开报告） | 必须分别给出 |
| **负控** | 不可裁部分已超总预算时**伪报** `used <= budget` | 必须被抓住（门 FAIL） |

### 4.4 M6-G10 细化（**量具可信**）—— 每个新门都要过

计划 §WP4 列出的 8 条注入必须**逐条**有检测器与负控：

1. 0 条用例 / 0 条文件 / 缺模型响应 / 退出码 0 但 `skipped`；
2. 旧提交结果、默认路径旧 `FAIL` 与新 runId `PASS` 混淆；
3. `expected=search` 的正例同时进入禁止出站集合（集合冲突 ⇒ 量具无效）；
4. token/usage 不可得却写成 0；搜索调用与模型调用混为一个计数；
5. **已选择但被 `ContextCompiler` 裁掉的来源仍被计为"实际入模"**；
6. 缺失正例时，系统靠"永远不记 / 不搜 / 不摘要"过门；
7. 断点重复输入导致同一 turn 重复写入，或只跑 50 轮却标 500；
8. 一次坏模型回复被重试后的好回复覆盖，或故意丢弃失败轮次。

**第 5 条与第 6 条是本里程碑最危险的两条假绿**：前者让 `实际入模 = 已选择`
（正是 ADR-050 `DR-9` 要防的那件事），后者让"摘要永远为空"看起来像 PASS。
两条都必须有**主动注入**的负控，而**不只是**"跑一遍看着没问题"。

---

## 5. prompt 基线与 R-2 的落点

| 项 | 值 / 策略 |
|---|---|
| 冻结基线 | `evals/fixtures/m3.5/prompt-baseline.txt`，sha256 `047c6c965fa6f29c79831e817c93b236f17a982c14a3ad6eafab3b53bd2ea4b6`（WP0 已登记） |
| 首选手册（**R-2 已裁定选项①**，2026-09-21） | 摘要在**关闭态 / 空集合**时产 0 section ⇒ 基线**一字节不动**，**不重刷** |
| 必须新增的负控 | "摘要为空时 `packet.text` 与基线**逐字节相同**"（把"应该不会变"变成机器判据） |
| 若裁定选② | 必须走 AGENTS §3 的程序：`pnpm m3.5:baseline` 重刷 + 报告里说明"为什么有意改 prompt"（AGENTS §6.6） |
| 禁止 | 为了让门变绿而顺手刷基线；也禁止"因为基线没红就断言摘要没进 prompt"（空摘要与关闭态都合法） |

---

## 6. 预算与类别（R-3 的落点）

| 项 | 现状 | **已裁定（R-3 选项①）** |
|---|---|---|
| `ContextBudget` 字段 | 4 个**必填**：`totalTokens 6000` / `memoryTokens 800` / `reservedTokens 2400` / `externalEvidenceTokens 0` | **+ 必填 `rollupTokens: 0`** |
| `ContextCategory` | 6 类闭集 | **7 类**（+ `rolling_summary`） |
| 断言 | `assertContextBudget` 遍历 4 个字段 + `committed = memory + reserved + externalEvidence ≤ total` | 遍历 5 个字段 + `committed` 纳入 `rollupTokens` |
| 门 | `pnpm m5:budget:verify`（`verify-m5-budget.ts:116-151` 断言六类与默认值） | **同步改断言**（不是放宽分母） |
| 涟漪 | — | 约 10 处 `ContextBudget` 字面量（`typecheck` 全部能找到 ⇒ 失败关闭） |

**纪律**：`rollupTokens` 缺省 **0** = "今天不做摘要"是一个**真实配置**，不是"忘了填"（沿用 ADR-045 的措辞）。
开启是**独立裁定**（先例 ADR-048），M6 本身**不**生产激活。

---

## 7. 证据与 manifest（继承 WP0，不另立一套）

```text
artifacts/m6/<runId>/manifest.json      §9.2 字段集（代码提交、运行相关树哈希、命令与退出码、
                                        fixture/rubric/阈值哈希、非机密配置指纹、计数、证据 SHA-256、
                                        沙箱身份、真实库保护读数、排除项）
artifacts/m6/<runId>/measurement.json   量具资格化（§4.4 的 8 条注入 + 三段式）
artifacts/m6/<runId>/{context,console,faults,restart-recovery,e2e,scale,regression,live}.json
artifacts/m6/<runId>/{calibration,long-dialogue}/
docs/m6/{M6-Acceptance-Contract,M6-Baseline,M6-Affected-Surface-Map,WP<n>-Handoff,M6-Acceptance-Report,
        M6-Known-Limitations,M6-Gate-Decision,G1-Acceptance-Report}.md
```

三条继承纪律：① 旧证据**不覆盖**（`r2-9` PASS 与旧 `semantics-live` FAIL 都留，索引写明取代关系）；
② **运行相关树改变即使该集合失效**；纯报告提交可引用被测提交，但必须**机器验证**运行相关树未变
（WP0 的 `--phase verify` 就是这条纪律的第一个实现）；③ 大日志与本地合成对话评审包放**gitignored** 目录，WP4 先声明路径。

---

## 8. G1 的范围（**不合并判定**）

| 组件 | 前置 | 内容 |
|---|---|---|
| G1-A 盲审 | M6 自动门通过 + **综合验收授权** | A–E 每类 ≥3 条完整合成多轮轨迹（共 ≥15 条）；每条至少 1 个正控 + 1 个易失败点；从 500 轮轨迹抽取预定窗口；所有机械硬失败一并纳入 |
| G1-B 结论 | G1-A + 真人评分 | 逐项输出：工程硬门 / 行为质量 / 人工评审 / **原始 Lv1 差异**；阈值依 WP9a 冻结版本，**不得看过答卷再调分** |

**阻断项**：任何 P0 不变量违例 · 假成功动作 · 跨用户认知污染 · 未授权真实库写入。
**没有真人评分时** G1 保持 `AWAITING HUMAN REVIEW`；**LLM judge 不得填充"人工已审"**。
材料只用合成公开夹具；真实对话或搜索正文**不得**为方便审阅写进 Git / telemetry / 外部评测服务。

---

## 9. 裁定包（WP1 的出口 —— **已完成**）

裁定表与选项见 **ADR-050 §9**；**裁定记录见 ADR-050 §10**。

```text
裁定结果（用户 2026-09-21）：D-1 = ① · D-2 = ① · R-2 = ① · R-3 = ①
⇒ 本文件与 ADR-050 一同置为 DESIGN FROZEN
⇒ 已获一次性执行授权，进入 WP2（领域层纯逻辑 + 部件门；不接线、不碰真实库）
```
