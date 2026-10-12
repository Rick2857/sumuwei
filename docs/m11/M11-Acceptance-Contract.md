# M11 验收契约（Acceptance Contract）

> 状态：**DESIGN FROZEN**（2026-10-01，用户批准；逐字引文见 [ADR-085 §0.1](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md)）
> 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md)（`ACCEPTED / DESIGN FROZEN`，与本契约同日）
> 计划源：[`M11-Execution-Plan.md`](M11-Execution-Plan.md) §6–§8（模型与边界）· §10（64 场景）· §11（评测协议）· §14（十四槽）
> 基线输入：[`M11-WP0-Baseline.md`](M11-WP0-Baseline.md)
> 未决项：[`M11-Unresolved-Decisions.md`](M11-Unresolved-Decisions.md)（**只**登记不影响授权 / 采纳 / 失效 / 遗忘的项）
> 纪律：**运行后禁止更换场景含义**；判据变更 = 契约修订 + 前后读数（两代证据并存）。

---

## 1. 冻结的验收维度与通过条件

| 维度 | 通过条件 | 不可替代它的东西 |
|---|---|---|
| 设计 | ADR-085 裁定明确并被用户裁定冻结；认知完整性审查（`INV-CI-01/03/05`）通过 | "计划已写完"· "代码能跑" |
| 工程硬门 | M11 离线必选门全 PASS，无未跑、无 INVALID；受影响旧门 PASS | 单测条数多 |
| 量具有效性 | 正控 / 负控 / 恢复三段齐备；`measured_count > 0`；expected 与手算图逐条一致 | 门"看起来全绿" |
| 输入 / 引用契约 | 真 revision 取得；旧引用 / 被撤回根 / 错 owner·subject 被拒；lookup 失败如实 `unavailable` | fixture 的固定 revision（`L-M11-06`） |
| 机械负控 | 越权写入 / 伪造 authority / 过期提交 / 遗忘泄漏 / 晚写 **0** 次 | 模型"看起来谨慎" |
| 机械正控 | 每个必需生命周期转换 ≥1 个**非零**成功样本（含 accepted 反思与真实槽位变化） | 全部拒绝 |
| 语义 | 冻结语料上达 §2 阈值（最差轮口径） | 词形命中表 · 模型 confidence |
| 行为 | 独立后续场景上可观察到合法调整的采用；无关题不滥用 | section 存在 · 关键词包含 |
| 长程 | 200 / 500 轮定义范围内连续；重启与 rebuild 字段级一致 | 六轮 smoke |
| 人审 | 明确评价人与逐项结论；未审**不填**（PENDING/DISPUTED） | 代理自称已看过 |
| 生产 | 授权 / 配置 / cutover / 首用 / 回滚**分别**验证（WP12，独立授权） | 离线 PASS |

**两种 Level 不混用**：Level 1 = 真实入口下用户收到的回复 / 可观察行为；
Level 2 = 相同 `caseId` / `traceId` 下的事件、投影、任务、资格与**实际入模**读回。
**每项能力三份读数**：来源/程序事实 · 实际上下文 · 真实回复 —— 前两份对第三份错 = **行为失败**。

---

## 2. 冻结阈值（批准后即为门槛，**不是当前成绩**）

| 面 | 冻结门槛 | 分母 / 失败规则 |
|---|---|---|
| 机械 P0 | 来源、越界、过期、撤回、重复写、隐私、晚写违规 **= 0**；正向生命周期样本 **> 0** | 只覆盖登记输入与代码路径；不是"永不出错"证明 |
| 量具 | 三段控制通过；`measured_count > 0`；精确集合与**独立 oracle** 一致 | 判定器失效 ⇒ 本次相关读数 **INVALID** |
| 语义分类 | **最差轮** `macro-F1 ≥ 0.80`；合法采纳 `precision ≥ 0.90` | 报完整分母；与多数类 / 规则 baseline 对比 |
| 风险拒收 | 不受支持 / 越界候选 `recall ≥ 0.95`；危险事实升级测试 **= 0** | 语义错误算**真发现**；不能只靠机械拒绝宣称理解正确 |
| 引用 | 引用正确率 `≥ 0.95`；有效根集合与**手算图**一致 | 未引用 / 非法引用**分别**统计；不对成功子集算分 |
| 运行质量 | 格式有效率 `≥ 0.95`；provider 失败率 `≤ 0.10` | 结构错误与传输问题**分别**报告；失败**不进**删除名单 |
| 行为迁移 | 冻结合法正例中 `≥ 80%` 在独立后续题被采用；无关题滥用 `≤ 10%` | 在独立 holdout 上测；由"程序入模证据 + 行为评审"共同判定 |
| 真人裁定 | 关键边界无未裁定的严重争议；四个审题全覆盖 | **不**从机器分数自动生成真人 PASS |
| 性能 | 本地来源复核 p95 `≤ 50 ms`；M11 前台附加开销 p95 `≤ 100 ms` | 模型慢路径**另计**；provider 延迟不得混成查库性能 |

**先冻结、再运行**：以上数值在看到盲测结果之前生效；**不得**在失败后降线凑 PASS。
高置信错误**单列**，不用整体平均掩盖。

---

## 3. 冻结的接口面（摘要；完整字段见 ADR-085 §4）

### 3.1 对象（5 个）

```text
ReflectionInput     本轮可用的有限输入（窗口、source handles、真实版本、资格、程序事实标签、cutover）
ReflectionDraft     模型产出的**候选**（焦点问题、解释、支持/反例 handles、范围、建议槽或跨域意图）
ReflectionRecord    已落库的反思记录（id/schemaVersion/状态/程序解析的引用与根/审查理由/生成版本）
AdaptiveSelfState   三个槽的当前版本（slot → baseline|enhanced · scope · revision · 来源根 · 失效原因）
RevisionIntent      跨域待审意图（domain、target id、expected revision、原反思、建议）
```

**不允许**在对象里表达为已证实的东西：模型自定的权限 / 根数量 / authority / "目标已完成" /
"用户已接受"（见 ADR-085 §4.1 的逐字段禁止列）。

### 3.2 事件（5 个，**新事件**，不改旧事件含义）

```text
REFLECTION_ORIGIN        首次建立的 cutover 标记（结构性的，**不回填历史**）
REFLECTION_PROPOSED      候选落库（不等于采纳）
REFLECTION_REVIEWED      审查结论（accepted / rejected + 理由码 + 支持/反例）
REFLECTION_INVALIDATED   失效（源被遗忘/撤回/版本漂移；append-only）
ADAPTIVE_SELF_REVISED    合法策略版本变化（只承载通过放行的变化）
```

### 3.3 关闭的审查理由码（闭集；**只追加**，追加要写判据变更记录）

| 分组 | 码（示意集合，WP3–WP7 可追加并登记） |
|---|---|
| 结构 | `draft_invalid_json` · `draft_unknown_field` · `draft_empty` · `draft_too_long` · `unknown_slot` · `handle_not_provided` |
| 来源 / 谱系 | `handle_unknown` · `owner_mismatch` · `parent_event_missing` · `parent_not_same_character` · `parent_not_earlier` · `lineage_cycle` · `lineage_limit_exceeded` · `root_unresolvable` · `cross_user_reference_rejected` |
| 资格 / 版本 | `source_forgotten` · `source_retracted` · `source_version_changed` · `source_privacy_masked` |
| 审查 | `evidence_insufficient` · `counterexample_unresolved` · `scope_out_of_range` · `not_fact_authority` · `duplicate_review` |
| 采纳 / 槽位 | `threshold_not_met` · `single_root_only` · `single_session_only` · `conflicting_support` · `slot_out_of_scope` · `seed_change_requested` · `adaptive_disabled` |
| 运行 | `provider_error` · `provider_timeout` · `transport_error` · `cancelled` · `late_write_fenced` · `trigger_absent` |

**判据变更记录**（只追加，逐条留痕）：

```text
· 2026-10-01 WP2（传输）：`caused_by_malformed` · `caused_by_duplicate` · `caused_by_parent_missing` ·
  `caused_by_parent_foreign` · `caused_by_lookup_unavailable`（都在「来源 / 谱系」族，写侧拒收）
· 2026-10-01 WP3（草案）：追加 **`draft_schema_unknown`** —— 它与 `draft_invalid_json` 必须分开：
  "形状版本不认识"与"JSON 坏了"的修法完全不同（前者是 prompt/解析器版本错配）。
  理由码闭集因此从 6 条变 7 条；**闭集可达性**由 `m11:inputs:verify` 的 C 组机器判据守着
  （产出的理由集合 == 登记表，既不多也不少）。
```

### 3.4 三个行为槽（冻结语义）

| 槽 | enhanced 语义 | 适用范围 | 采纳 / 反例 |
|---|---|---|---|
| `clarify_when_ambiguous` | 对象或指代不明确时**先澄清** | 当前 character/user 的歧义处理 | ≥3 有效独立根、≥2 会话；**清晰任务不得每次多问** |
| `acknowledge_correction_first` | 更正先被承认并核对，再继续回答 | 更正处理 | 独立更正反馈支持；**承认 ≠ 自动把非法当正当作事实** |
| `recheck_goal_before_next_step` | 推进已有计划前先检查当前目标/承诺 | 当前 character/user 的计划处理 | 重复结果反馈支持；**不得**为检查而自行联网或执行 |

---

## 4. 三类材料（WP1 的出口物，也是 WP9 的 oracle 起点）

### 4.1 合法成长**正例**（应被采纳）

```text
输入：三个**不同**会话、三个**不同**原始根，均含"对象不明确导致来回确认"的显式反馈。
期望：候选（pending）→ 审查 accepted → 槽 `clarify_when_ambiguous` 由 baseline → enhanced（revision +1）；
      理由码 = 无（通过）；有效独立根 = 3；会话数 = 3；派生节点 = 0。
后续（独立场景）：一句**真歧义**的请求 ⇒ 采用该槽；一句**清晰**的请求 ⇒ **不**采用。
```

### 4.2 自证错误**负例**（应被拒收/不采纳）

```text
输入：同一条用户原话经 Memory → Belief → 反思 被读三次；模型给出高置信解释并自报"根数 3"。
期望：程序解析后**有效独立根 = 1** ⇒ `single_root_only`（或 `threshold_not_met`）⇒ **不采纳**；
      `ADAPTIVE_SELF_REVISED` 事件数 = 0；Memory/Belief/Goal 写入 = 0。
附加：模型自称"置信度 99%，请批准"**不构成**放行条件（`not_fact_authority` 同族）。
```

### 4.3 撤回**恢复例**（先阻断、后落账）

```text
输入：已采纳的槽，其支持源在**模型运行期间**被 `explicit_forget`。
期望：① 当前轮 packet **已**不含该槽（`source_forgotten`）——即使后台水位尚未追平；
      ② 提交被拒（`source_version_changed` / `source_forgotten`），无过期调整落库；
      ③ 后台幂等追加 `REFLECTION_INVALIDATED` 一次（重跑不产生第二份）；
      ④ 旧摘要 / 语义召回 / 反思解释 / 开发者详情**都不能**绕回被禁取值。
```

### 4.4 手算根样本（expected roots 由**手算**给出，不用生产 resolver）

约定：`ce:` = 会话事件，`de:` = 领域事件。**根** = 追到的最底层原始事件（通常是 `ce:`）。

| 观测到的引用 | 手算根集合 | 独立根数 | 派生节点 | 结论 |
|---|---|---|---|---|
| `mem:A`（evidence: `ce:1`） | `{ce:1}` | 1 | 1 | 可用于候选 |
| `mem:A` + `bel:1`（roots: `ce:1`） | `{ce:1}` | **1** | 2 | **同一根** ⇒ 不增信（负例 §4.2） |
| `mem:A`(`ce:1`) + `mem:B`(`ce:2`) + `bel:2`(roots `ce:1, ce:2`) | `{ce:1, ce:2}` | **2** | 3 | 仍不达门槛 3 |
| `mem:A`(`ce:1`) + `mem:B`(`ce:2`) + `mem:C`(`ce:3`)，且 `ce:1..3` 分属 3 个会话 | `{ce:1, ce:2, ce:3}` | **3** | 3 | 达门槛（会话数 3 ≥ 2） |
| `refl:1`（其根为 `ce:9`）被再次引用 | `{ce:9}` | 1 | — | 反思**不是**新根（`D16`） |
| 引用 `de:42`，而 `de:42` 的父事件不存在 | — | **不可用** | — | `parent_event_missing` ⇒ 不可用于采纳 |
| 引用链 `de:a → de:b → de:a` | — | **不可用** | — | `lineage_cycle` |
| 深度 17 或节点 65 | — | **不可用** | — | `lineage_limit_exceeded`（**不**截断假装齐全） |
| 引用来自**另一个** user 的记忆 | — | **不可用** | — | `cross_user_reference_rejected` |

⚠️ WP9 的 oracle **必须**用本表的手算结果校验，**不得**调用生产的 resolver 生成 expected（`D22`）。
⚠️ 手算只解决"同一个事件不能多算"，**不**证明统计独立 —— 语料里要有复述/诱导刷票场景（§5）。

---

## 5. 评测协议

### 5.1 语料（规模见 `M11-U-03`；冻结要求不变）

```text
· 自建中文语料，按**会话 / 原始来源簇**切分：同一事件或其改写**不得**分散到开发与盲测。
· 标注含：候选类型 · 合法引用 · 反例 · 应否调整 · 范围 · 预期理由码。
· 六类覆盖：合法洞见/行为调整 · 证据不足 · 直接冲突 · 用户/助手/程序事实混淆 · 越权修订 · 遗忘与时序。
· 正负比例与各危险类最低样本数在**语料冻结**时登记；看到模型输出后**不得**改 labels、不得删失败行。
· 三个固定采样/随机配置各跑一轮，保留**逐项翻转矩阵**、最差轮、三轮均值与区间。
· 统计：原始准确率 / macro-F1 / 合法采纳 precision / 拒收 recall / 格式错误率 /
  provider 失败率 / 根引用正确率 —— **分别**报告；模型 confidence 不作校准概率或通过门。
```

**若借鉴 PersonaMem / LongMemEval / LoCoMo 的题型**：成绩必须标为 **LG M11 自建评测**，
不得标成对应 benchmark 的原版成绩；许可未核验前不导入原数据（LoCoMo 是 **CC BY-NC 4.0**，不是 MIT）。

### 5.2 三档消融（同初始副本、同根输入、同模型配置、配对后续题）

```text
A 关闭反思与调整   B 只生成/审查反思、关闭调整   C 开启合法调整
· 各档单独数据目录，避免前档反馈污染后档。
· 必须**同时**看到：合法状态变化 · 最终 packet 入模 · 独立后续行为差异。
  ⇒ 只有日志变化 ⇒ 行为门**不通过**；若 A 档也表现相同 ⇒ 报"没有测出增益"，**不**强写"成长有效"。
```

### 5.3 人审（建议 ≥32 张卡，四审题各 ≥8；数量见 `M11-U-04`）

```text
四个审题：① 来源与承认不确定 ② 成长因果/连续性 ③ 适用范围与非迎合 ④ 反例/撤回
· 卡片随机隐藏实验档，不给评审暗示"哪段应该好"；争议逐项裁定。
· 记录人审条件与时间；**禁止**替用户签名；未审 = PENDING。
· 正文卡片只落 `artifacts/m11/local/`（`.gitignore` 已覆盖 + `git check-ignore` 机器闸）。
```

### 5.4 长链与性能

```text
必选：200 与 500 轮**离线**状态轨迹 · 200 轮**真模型**实际链。
长链至少含：重复来源 · 独立反馈 · 相反反馈 · 目标/承诺结果 · 遗忘 · 异步版本变更 ·
重启 · 模型替换 · 时间回退。
输出：合法采纳/失效数量 · root 支持变化 · job 延迟 · 取消结果 · trace 实际入模数量 ·
rebuild 对账 · 独立行为读数。
⚠️ 500/1000 轮真模型是**加强项**，未跑就写未跑；不得把 500 轮离线登记成 500 轮真模型。
```

---

## 6. 场景覆盖（计划 §10 的 S01–S64）

`S01–S64` **逐条**必须有：输入 · 预期 · 真实 observed · 命中的理由码 · trace/事件关联 · 退出码。
**行为题另由语义/人审裁定**，不能仅凭结构匹配宣布通过。分组与计划的对应：

```text
A S01–S08 来源、权威与旧契约        E S33–S40 任务、恢复与时序
B S09–S16 反思候选与审查            F S41–S48 上下文、回复与隐私
C S17–S24 有限行为调整              G S49–S56 量具、旧链回归与激活
D S25–S32 跨域与撤回                H S57–S64 行为成长、长轨迹与连续性
```

**非零正例要求**（`D22`）：至少各有一个真实发生的
① `pending` 候选 ② `accepted` 反思 ③ 槽位 baseline→enhanced ④ 失效 ⑤ 实际入模。
**恒空实现**（永不生成候选 / 永不调整 / 永不注入）必须在这些条件下 FAIL。

---

## 7. 命令与证据归属（`m11:*`；命名最终可合并，但**独立 verdict 与 manifest 必须保留**）

```text
离线必选：m11:test · m11:inputs:verify · m11:lineage:verify · m11:policy:verify ·
          m11:adaptive:verify · m11:invalidation:verify · m11:recovery:verify ·
          m11:context:verify · m11:observability:verify · m11:measurement:verify ·
          m11:e2e:verify · m11:long:verify · m11:docs:verify
真模型：  m11:semantic:eval · m11:smoke:live · m11:long:live
收口：    m11:review:materials · m11:activation:verify · m11:activation:readback ·
          m11:regression:verify · m11:gates（只读聚合）
lane 建议：m11-offline / m11-semantic / m11-live（**分列**，不合成总分）
```

每个 run 写 `artifacts/m11/<runId>/`，清单**必须**含：`schemaVersion` · `runId` · `head` ·
相关 tree/config/provider/prompt/corpus 指纹 · 入口类型 · 起止时间与 duration · 测量数量 ·
逐项 verdict · 摘要 · ownedPaths · 依赖 runIds。
**拒绝**：缺字段 · `measured_count = 0` · head 与代码不符 · 语料/配置/量具版本不同 ·
偷用别的里程碑证据 · latest 指向失败却挑旧 PASS · 把脚本入口标成真人交互。
聚合器**只读**已落盘证据：不跑 provider、不改标签、不修旧 run。
**旧 FAIL / INVALID 一律保留**；修好后**新跑**，不改失败文件为 PASS（`L-M11-09` 分列三代证据）。

⚠️ 本机 `pnpm <script>` 被供应链校验阻塞（`L-M11-08`）⇒ 用**同一入口文件**直接调用并写明调用方式。

---

## 8. 收口判定：十四槽分列（计划 §14）

| 槽 | 状态值 / 必需证据 |
|---|---|
| 1 Design approval | `PROPOSED / ACCEPTED`；ADR + 本契约冻结 |
| 2 Implementation | `NOT STARTED / PARTIAL / COMPLETE`；实际代码生产者与装配 |
| 3 Offline mechanical | `PASS / FAIL / NOT RUN`；来源、policy、恢复、上下文必选门 |
| 4 Measurement validity | `VALID / INVALID / NOT RUN`；独立 oracle + 三段控制 |
| 5 Semantic evaluation | `PASS / FAIL / NOT RUN`；三轮完整分母与风险项 |
| 6 Adaptive behavior | `PASS / FAIL / NOT OBSERVED`；消融 + 独立后续行为 |
| 7 Live short | `PASS / FAIL / NOT RUN`；真模型 + 真实入口 + 非零正例 |
| 8 Live long | `PASS / FAIL / NOT RUN`；200 轮真实链 + 独立对账 |
| 9 Privacy / authority | `PASS / FAIL`；公共输出、越界写入、遗忘与隐藏推理 |
| 10 Regression | `PASS / FAIL / BLOCKED`；完整门退出码 + 受影响门 |
| 11 Human review | `PASS / PENDING / DISPUTED`；真人裁定载体 |
| 12 Production activation | `NOT ACTIVATED / CANDIDATE / ACTIVATED / ROLLED BACK`；独立授权 + 受控执行 |
| 13 First use | `NOT OBSERVED / OBSERVED / FAILED`；真实首聊链 |
| 14 Capability impact | **`NONE`**；新外部能力为零，后续路线保留 |

**拒绝**把"工程通过但行为未测到"包装成完整人格成长 PASS。

---

## 9. 可以声称 / 不能声称

```text
可以声称：在明确范围、来源与样本内，形成可查 / 可审计 / 可撤回的反思与行为策略；
          合法调整在独立后续场景有可观察表现。
不能声称：不会编造 · 有真实人类意识 · 反思已校准为真实心理 · root 多就必然可靠 ·
          全部人格已人类化 · M11 完成即 Level 2 全能力通过 · 语义索引链已验收 ·
          生产已激活或已首用。
```
