# ADR-045 — External Evidence Boundary（Web Search 的外部证据不能成为事实权威）

```text
状态      : **ACCEPTED / DESIGN FROZEN**（用户 2026-09-20 裁定 `D-19` = P-1 / Brave Search API）
授权记录  : 裁定原文要点见 §D-19「裁定记录」；**生产激活（真实聊天启用）仍未批准**
            （`production_activation: NOT APPROVED`，`CHARACTER_WEB_SEARCH_ENABLED` 默认 false）
日期      : 2026-09-20
里程碑    : M5.5 Web Search & External Evidence
上游      : M5 `PASS`（externalEvidence 空钩子 + 六类预算）· M5.1 `PASS`（可观测性冻结计数）·
            M5.1.1 `Final = PASS` / `M5.1-D01 = CLOSED`（ADR-044）
计划      : `docs/m5.5/M5.5-Execution-Plan.md`（WP0–WP10 与 STOP）
基线      : `docs/m5.5/M5.5-Baseline.md`（已核实的插入点与既有判据）·
            `docs/m5.5/M5.5-Affected-Surface-Map.md`（文件级地图）
相关      : ADR-006（依赖闸）· ADR-030 ~ ADR-035（M4.5 六条）· ADR-043（认知资格）· ADR-044（状态修订）·
            `docs/m5/WP8-Handoff.md`（M5 → M5.5 交接单 "Next WP prerequisites"）
```

---

## 背景

M5 的 `NEXT MILESTONE` 只写了一件事：

```text
Internal Memory ─┐
                 ├─→ ContextBundle → ContextCompiler
External Evidence┘
```

并且明确"**而不是再建立一套平行系统**"。M5 交付时把这条边界留成了**空钩子**：

| 已存在的钩子 | 位置 | M5 时的状态 |
|---|---|---|
| `ContextBundle.externalEvidence` | `src/kernel/contracts/recall.ts:1039-1077` | 恒为 `[]`；非空会被 `assertContextBundle` 拒绝 |
| 预算六类里的 `external_evidence` | `src/kernel/recall/selector.ts:119-124` | 额度恒 0，producer 注明"M5.5 才实现" |
| 证据引用结构 `ExternalEvidenceRef` | 同上 | 只有 `id` / `source` / `retrievedAt` |

M5 的 WP8 交接单还留了三条给 M5.5 的硬要求：

> 1. 外部结果进入上下文前必须走 "Speech ≠ Action ≠ Result" 与 Assistant Fact Firewall；
> 2. **先决定"它是不是召回通道"** —— 若不是，它就是**另一个上下文来源**，仍必须过 `ContextCompiler` 的预算与可裁性；
> 3. 判据仍然是文本级 + 状态级 + 回复级三样；Live Smoke 必须在**生产库副本**上跑。

与此同时，M5.1 把可观测性与开发者面钉成了 12 个阶段 / 8 个端点 / 5 种 provenance 的**冻结计数**，
M4.5 把行动钉成了"能力必须登记才存在 + 策略拒绝时适配器一次都不被调用"。
这些既有判据决定了 M5.5 能怎么做（见 `M5.5-Baseline.md` §4）。

**本 ADR 要回答的问题**：当"她自己不知道、只有网上才知道"时，系统凭什么把这件东西放进她这一轮的上下文，
以及**不许**把它变成什么。

---

## 决策

### 第一部分：外部证据的边界（用户 2026-09-20 冻结）

| # | 决定 | 一句话理由 |
|---|---|---|
| **D-1** | **External Evidence 是独立上下文来源，不是 Recall Channel** | 召回通道回答"她想起了什么"（有资格层、有排序、有主体作用域）；外部证据回答"这一轮外面告诉了她什么"。混成一条会让 `RECALL_CHANNEL_FACTS` 里出现一个没有资格判定的通道 |
| **D-2** | **复用 `ContextBundle.externalEvidence`，不新建平行 Bundle** | M5 已经把这个字段按"两个来源、同一个数据结构"预留好了；新建第二套 Bundle 就是 §0 禁止的平行系统 |
| **D-3** | **搜索完整复用 M4.5 的 Capability Registry / Policy / Gateway / ActionResult / Ledger** | 一次联网是**一次真实外部动作**：有副作用等级、有权限、有终态账本、有 execution truth。它不该有自己的第三条执行路径（ADR-030） |
| **D-4** | 能力 = `web.search` / 操作 = `search`；`sideEffect = read` | 它读外部世界、不改它。副作用等级决定了它在策略与审计里被怎么对待 |
| **D-5** | **只有明确词形才触发**（搜索 / 搜一下 / 查一下 / 上网查 / 联网查 / web search） | 与 M4.5 的规则式意图判定同一条纪律：**不让模型决定执行**。误触发的代价是真实出站流量与费用 |
| **D-6** | **模型不决定执行，不做隐式联网**；本轮没有显式搜索词 ⇒ 网络调用数为 0 | 让一次采样决定"要不要联网"，等于让副作用依赖随机性（ADR-030 的理由原文） |
| **D-7** | **证据仅当轮存在，不自动落长期记忆** | 网页内容不可信且会变；把它变成 Memory 就等于让一次搜索永久改写"她知道什么"（Assistant Fact Firewall 的同类风险） |
| **D-8** | **trace / 账本只存 URL、来源、时间、指纹、计数、标签；不存摘要正文** | 摘要正文是任意外部文本，进了 trace/账本就是不可撤回的泄漏面（AT4.5 的隐私纪律） |
| **D-9** | **来源列表由程序按"实际入模证据"确定性追加**，不依赖模型正确生成引用 | "她有没有说来源"如果是模型行为，就不能被机器断言；程序追加才让"用户看到的来源 = 真的进了上下文的东西" |
| **D-10** | **"有来源列表" ≠ "完成了 claim-level entailment verification"** | 本里程碑只主张**来源集合与执行证据一致**；逐句事实蕴含验证是另一件事，不在 v1 |

### 第二部分：为落地必须一并冻结的设计（本次补充）

| # | 决定 | 依据 |
|---|---|---|
| **D-11** | 能力定义放**独立工厂** `createExternalEvidenceCapabilityDefinitions()`，**不**并入 `createDefaultCapabilityDefinitions()` | `scripts/kernel-tests-action.ts:234` 锁死 M4.5 默认集 = 3 个能力。改它就是改 M4.5 的既有判据，而 M4.5 已冻结验收 → 独立工厂是**追加**而不是改判据 |
| **D-12** | 该能力**恒登记**；`web:search` 权限与适配器**仅在 `CHARACTER_WEB_SEARCH_ENABLED=true` 时**授予 / 构造 | flag off 时用户说"帮我搜一下"必须得到**可审计的** `permission_denied`（→ 模型才能如实说"联网没启用"，D-17 第 5 态）；而"未登记"会让动作链返回 `not_applicable:unregistered`，那是"装作没听懂"。同时 flag off ⇒ 无适配器实例、无 key 读取 ⇒ **构造上无法联网** |
| **D-13** | `risk = R1` · `idempotency = 'none'` · `supportsDryRun = true` | `idempotency: 'supported'` 会重放上一次终态，而账本按 D-8 只存 refs ⇒ 重放会产出"成功了但没有内容"的假象（比失败更坏）。`sideEffect='read'` 的风险下限是 `R0`，声明 `R1` 合法且受 `CHARACTER_ACTION_MAX_RISK` 约束 |
| **D-14** | **`ExternalEvidenceRef` 只有一个定义**（`src/kernel/contracts/external-evidence.ts`），`contracts/recall.ts` 改为 re-export（名字不变）；并给 ref 补上 `provider` / `contentFingerprint` / `citationLabel` 三个**必填**字段 | 一个引用两种定义必然漂移（M3 的 `identity-core` 教训）。缺指纹的审计记录正是 WP4 要堵的洞；构造点可枚举（`selector.ts:286` 的空数组 + M5 测试里的一个字面量） |
| **D-15** | trace 只**追加**一个 step kind `'external_evidence'`，并在 `TRACE_STEP_STAGE` 里映射到**既有** `context` 阶段；**不**新增观测阶段 / provenance 种类 / 理由码 / developer-query 端点 | `OBSERVABILITY_STAGES.length === 12` / provenance 5 / 理由码 4 / 端点 8 都是 M5.1 门的机器判据（`kernel-tests-dev-plane.ts:1328/547/1479/1540`）。未映射的 kind 会被降级到 `turn` 并在 `unmappedStepKinds` 里如实报出，那不是我们要的表达 |
| **D-16** | `ContextBudget` 追加 `externalEvidenceTokens`，且 `DEFAULT_CONTEXT_BUDGET` 设 **0**；flag on 时由装配层传有界额度（`CHARACTER_WEB_SEARCH_EVIDENCE_TOKENS`，默认 800） | `scripts/verify-m5-budget.ts:135` 断言缺省预算里 `external_evidence === 0`。保持缺省 0 让该 M5 判据**继续成立且真实**（"默认不注入外部证据"），无需改写它（COMPAT-3）；同时让 `planContextBudget` 这个数字描述真实（ADR-035 测量真相） |
| **D-17** | 模型正文里所有 `[E<数字>]` 形态标签一律**剥离**，来源列表由程序追加；回复五态由程序确定性映射（查到并形成证据 / 无结果 / 超时 / 失败 / 未启用联网） | "凭空 `[E99]`"是**用户可见的伪造引用**；只记 trace 不改文本＝把伪造留给用户。剥离属既有 claim-guard 家族（替换/改写她的句子）的同类先例，且必须在写账本与落库**之前**完成（M4.1 现场纪律：账本 = 用户所见） |
| **D-18** | 三件配套边界：① 证据**不经召回管线**（`selectMemoryContext` 仍恒填 `[]`，证据在 gateway 层附加）；② 开发者面**只**通过既有注入点 `runtimeCapabilities` 上报 `web.search` 可用性，不改 `query-service.ts` 与 DTO 表；③ v1 **不**扩 telemetry attribute 白名单，属性键必须落在既有白名单或 `_count`/`_ids`/`_status`/`_at` 后缀族内 | ① 让 `verify-m5-runtime.ts:365` 的断言继续为真与有意义（COMPAT-2）；② `DeveloperRuntimeCapabilityDto` 已有 `availability` 字段，够用就不该动 DTO；③ 扩白名单要重出 M5.1 观测证据，而 v1 没有任何属性键**必须**扩白名单才能表达 |

### 第三部分：Provider 决策（`D-19`）—— **已裁定：P-1 / Brave Search API**

#### 裁定记录（用户 2026-09-20）

```yaml
decision: D-19
provider_class: P-1 单一 JSON Search API
provider: Brave Search API
endpoint: https://api.search.brave.com/res/v1/web/search
sdk: 禁止
transport: Node 22 native fetch
status: APPROVED FOR WP2
production_activation: NOT APPROVED
```

**已冻结的六条约束**（全部落在代码里，`pnpm m5.5:measurement:verify` 有量具）：

| # | 约束 | 落点 |
|---|---|---|
| ① | 仓库内部保持供应商无关：`SearchQuery{query, limit, locale}`；Brave 映射 `q` / `count` / `country` + `search_lang` | `kernel/action/search-port.ts` · `infrastructure/search/brave-search-provider.ts` |
| ② | 认证**只**用 `X-Subscription-Token`；endpoint 是**代码里的固定常量**（不接受用户输入、不接受普通环境变量）⇒ 封闭 SSRF 面 | `search-config.ts` 的 `D19_RULING` 比对闸 |
| ③ | 测试入口**只**读 `M55_BRAVE_SEARCH_TEST_API_KEY`；缺失即失败关闭，**绝不**读取或回落生产变量 `M55_BRAVE_SEARCH_API_KEY`（生产路径只读后者） | `loadBraveSearchConfig({mode})` 一个模式只拼一个变量名、只读一次 |
| ④ | 一次搜索**恰好一次** provider 请求、**零**自动重试、硬超时 **5000ms**、结果 ≤5、单次成本上限 **0.005 USD**；声明超出上限 ⇒ 配置**拒绝加载**（不静默放宽） | `D19_RULING` · `PROVIDER_PRICE_FACTS` · provider 的单次 `fetch` |
| ⑤ | 只允许发送**合成、非敏感**的 `query`/`limit`/`locale` 与完成 HTTPS/认证所必需的请求头；禁止身份、对话历史、system prompt、人设、长期记忆、traceId、账本、无关上下文、cookie、生产模型密钥 | `SearchProviderCall` 类型 + `recording-fetch` 的哨兵扫描量具 |
| ⑥ | 日志**最多**输出"变量存在/不存在"（不输出值、长度或前后缀） | `describeBraveSearchConfig()` + 静态锁（配置/provider 模块无 `console.`/`logger`） |

**价格是外部可变事实**：`PROVIDER_PRICE_FACTS` 记 `recordedAt: 2026-09-20` 与来源
（<https://brave.com/search/api/>），并且**不**当作永久保证 —— 实际价格超过单次上限、
或一次搜索需要两次以上请求、或 provider 改变计费单位时，必须**失败关闭并重新裁定**。

#### 附加 STOP 条件（第一次真实请求之前）

在发出真实请求前，必须确认所选账户方案允许本 ADR 要求的最小证据留存
（来源 URL、时间、指纹）。若许可范围不允许保存这些字段：

```text
不得发送真实请求
不得削弱既定审计字段
重新回到 Provider 决策
```

#### 决策依据（裁定前的三类候选，保留供复核）

| 候选 | 需要什么 | 出站请求形状 | 可注入 fixture | 退出成本 |
|---|---|---|---|---|
| **P-1 单一 JSON Search API** ← **已选** | 一个固定 HTTPS endpoint + 一个 key（只在 env） | `query` / `limit` / `locale` | 实现 `SearchProviderPort` 的一个假实现即可 | 低：换 provider = 换一个文件 |
| **P-2 本地自托管搜索服务** | 本机常驻服务（端口 / 容器）+ 可能的抓取出口 | 本机 HTTP，形状自定 | 同上 | 中：多一个运行组件与运维面（启停、健康、端口占用） |
| **P-3 当前模型供应商提供的搜索能力** | 复用既有 key / endpoint（可能按次计费） | 由供应商形状决定 | 需要一层薄适配 | 中：出站形状与供应商耦合，回归基线会跟着供应商变 |

**把 P-1 判为最低退出成本的理由**（与裁定前的推荐准则一致）：单一 provider、Node 22 原生
`fetch`、不用 SDK、endpoint 固定、可注入 fixture、key 只在 env，并且满足 ADR-006 §2 的
最关键一条 —— **删除它以后系统仍能运行**（换 provider 只改一个实现文件）。

---

## 被否决的方案

| # | 方案 | 否决理由 |
|---|---|---|
| V-1 | **让模型自己决定要不要联网**（工具调用 / function calling） | 让一次副作用依赖一次采样：不可复现、不可解释、"她为什么突然上网了"无法回答。ADR-030 的同一条理由 |
| V-2 | **新建平行的 ExternalEvidence 系统**（自己的 Bundle / 自己的上下文拼接 / 自己的 trace） | 直接违反 M5 `NEXT MILESTONE` 的"而不是再建立一套平行系统"；两套上下文拼接迟早分叉，而分叉的表现是"来源列表里有、prompt 里没有" |
| V-3 | **把外部检索做成第 4 条召回通道**（加进 `RECALL_CHANNEL_FACTS`） | 召回通道有资格层与主体作用域的语义；外部证据没有"这条是不是她的"这个问题。混进去会让 `available` 这个字段同时描述两件不同的事 |
| V-4 | **把搜索结果直接写进长期记忆**（"顺便记住"） | 网页内容不可信、会变、可能夹带指令；一旦落库就是**不可回溯的性质变更**。M5.5 的硬边界原文禁止 |
| V-5 | **v1 就抓取网页全文 / 上 Browser Agent** | 抓全文把"搜索结果级证据"变成"任意网页正文进上下文"，风险面与实现面都换了一个量级。留作后继工作 |
| V-6 | **用某个搜索 SDK** | 违反 ADR-006 的依赖纪律与本期推荐准则；一个 HTTP POST 不值得换一个架构中心 |
| V-7 | **把 `web.search` 加进 `createDefaultCapabilityDefinitions()`** | 会改 `kernel-tests-action.ts:234` 的 M4.5 既有判据（"首批只登记三个能力"），而 M4.5 已冻结验收 |
| V-8 | **新增第 13 个观测阶段 `external_evidence`** | 会改 `OBSERVABILITY_STAGES.length === 12`；M5.1 已冻结。映射到既有 `context` 阶段语义成立（证据就是进上下文的那一段），不值得为措辞重开 M5.1 |
| V-9 | **只把未知 citation label 记进 trace，不改回复** | 用户看到的就是那句伪造的 `[E99]`。记录 ≠ 阻止；这与 M4.1 "她说了她已经记住"的现场教训同型 |
| V-10 | **让模型自己写来源列表**（给它证据，让它引用） | 模型漏引/错引/编造都无法被机器断言；D-9 的确定性追加是唯一能让"来源列表"成为**可验证事实**的做法 |
| V-11 | **flag off 时不登记能力**（让它表现得像"她没听懂"） | 用户明确要求了联网，系统却静默不做 —— 那正是"未成功却给人成功印象"的镜像缺陷。D-12 让它变成一条可审计的拒绝 |
| V-12 | **`idempotency: 'supported'`**（省一次请求） | 账本只存 refs；重放会返回"成功但无内容"。宁可再查一次 |

---

## 后果

**正面**

- 外部证据与长期记忆**结构上分离**：删掉 M5.5 不会动 M4 的任何语义（`memory_records` 无新列、无新表、无新迁移）。
- 一次联网 = 一次**普通动作**：策略拒绝时适配器一次都不被调用；失败/超时有终态账本与如实措辞（复用 M4.5 的两层保证）。
- "用户看到的来源 = 真的进了上下文的证据"成为**机器可断言**的性质（而不是对模型的期待）。
- 观测面上的代价被明确计价：没有新阶段、新端点、新理由码；只有 1 个 step kind、1 行映射、若干落在既有后缀族里的属性键。

**负面 / 成本**

- **v1 只有搜索结果级证据**：不抓全文、不做逐句蕴含验证 —— "有来源"不等于"说法成立"（D-10 明文）。
- 搜索能力会**恒登记**（D-12）：开发者面会看到 `web.search` 这一行（可用性如实为不可用），
  而不是"它不存在"。
- 来源附录会随她说过的话进入账本，进而在**后续轮次的 `recent-conversation`** 里出现 URL
  （有界、且是真实发生过的事）—— 写进 `M5.5-Known-Limitations.md`。
- 剥离未知 `[E<n>]` 标签意味着**改写她的话**（与既有 claim guard 同类）；trace 记的是程序事实，不是她的原话。

### 本 ADR **不**主张什么（与 `M5.5-Known-Limitations.md` 同源）

```text
✗ 不主张搜索结果本身是事实
✗ 不主张"有来源列表"= 完成了 claim-level entailment verification
✗ 不主张抓取任意网页全文（无 Fetch / Browser）
✗ 不主张外部证据可以自动成为长期记忆
✗ 不主张后台自主的搜索 / 持续联网 / 监控式查询
✗ 不主张任何形式的"她自己决定要不要上网"
```

---

## 复核时点

出现以下任一情况时重新评估本 ADR：

1. Provider 的返回体形状或计费模型发生变化（D-19 的裁定前提失效）；
2. 需要**抓取全文**才能回答问题（V-5 的复议点，且必须重新过 §0 的硬边界）；
3. 出现"来源列表与实际入模集合不一致"的**实测**案例（D-9 / D-17 的判据被证伪）；
4. 外部证据量级大到需要独立检索/排序（届时评估是否升级为召回通道，V-3 的复议点）；
5. `CHARACTER_WEB_SEARCH_ENABLED` 要在真实聊天中打开（激活 STOP，需用户显式确认）。
