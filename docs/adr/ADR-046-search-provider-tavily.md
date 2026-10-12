# ADR-046 — Search Provider 变更：Brave Search API → Tavily

```text
状态      : **SUPERSEDED / NEVER ACTIVATED**（provider 由 ADR-047 换为本地 SearXNG）
取代者    : [`ADR-047-local-searxng-search-provider.md`](./ADR-047-local-searxng-search-provider.md)（`D-31`）
生效范围  : 本 ADR 的 provider 专属决定（`D-20`…`D-30`）**已被 ADR-047 取代**；
            其中**与 provider 无关**的结论仍有效（凭证只在头、出站形状可断言、
            恰好一次请求、零重试、5000ms 硬超时、结果 ≤5、成本只报告不阻断）
未激活声明: **Tavily 从未被激活** —— 它的代码只在工作树与提交里准备过，
            **没有任何消费者**（`src/main.ts` 与 `src/kernel/app/**` 对搜索层的引用数 = 0），
            **从未进入真实聊天、从未发出过任何真实出站请求、从未在生产装配里构造过 provider**。
            本文件保留的是"当时的裁定"这段历史，按 ADR-043 → ADR-044 的同一惯例**不改写正文**。
当时取代  : ADR-045 的 §`D-19`（Brave 的 provider 裁定）
不取代    : ADR-045 的 `D-1`…`D-18`（外部证据边界 / 能力形状 / 引用唯一性 /
            trace 映射 / 预算缺省 0 / 回复五态 / COMPAT-1…3）**一个字都没变**
日期      : 2026-09-20
里程碑    : M5.5 Web Search & External Evidence
上游      : ADR-045 `ACCEPTED / DESIGN FROZEN`（§D-19 当时由本 ADR 取代）·
            现由 [`ADR-047`](./ADR-047-local-searxng-search-provider.md) 取代本 ADR
机器判据  : 历史判据为 `pnpm m5.5:measurement:verify`（当时：Tavily 出站形状 / 计费量 /
            成本报告）。**当前**判据见 ADR-047（同一条命令，SearXNG 版）
```

> ⚠️ **本 ADR 已不再生效**：provider 是 **本地 SearXNG**，见
> [`ADR-047-local-searxng-search-provider.md`](./ADR-047-local-searxng-search-provider.md)。
> 本文件保留的只是"当时的裁定"这段历史（与 ADR-043 被 ADR-044 取代的处理方式一致：
> **正文不改写**，由取代者在头部与状态源里声明）。

---

## 背景

`D-19`（ADR-045）裁定 provider = **Brave Search API**，并在 §3 写了一条硬规则：

> 如果实际订阅价格超过单次上限、一次用户搜索需要两次以上请求，或者 provider 改变计费单位，
> 必须失败关闭并重新裁定，不得静默放宽预算。

用户在 2026-09-20 决定**更换 provider**（ADR-045 的复核时点第 1 条正是"provider 形状/计费变化"）。
换 provider 的成本很低，因为 M5.5 的 provider 层从一开始就是**端口 + 薄适配器**：
`SearchProviderPort` 与 kernel 侧契约不认识任何供应商（ADR-045 `D-3`/`D-19` 的"仓库内部保持供应商无关"），
因此这次只换了一个实现文件。

**新 provider 的事实**（裁定当天查证，来源见下）：

| 项 | 值 |
|---|---|
| endpoint | `POST https://api.tavily.com/search` |
| 认证 | `Authorization: Bearer tvly-…`（**请求头**） |
| 计费 | `search_depth=basic` = **1 credit**；`advanced` = **2 credits** |
| 单价 | PAYG **$0.008/credit**；免费 **1000 credits/月**；月付计划 $0.0075–$0.005/credit |
| 结果上限 | `max_results`（官方默认 10，上限 20） |
| 语言/地区 | `language`（ISO 639-1 或 `zh-cn` 这类代码）；`country` 要的是**国家名** |
| 隐藏成本 | `auto_parameters: true` 时，官方文档明写**可能自动把 `search_depth` 升级成 `advanced`** |
| 来源 | <https://docs.tavily.com/documentation/api-reference/endpoint/search> · <https://docs.tavily.com/documentation/api-credits> · <https://tavily.com/pricing> |

---

## 决策

### 第一部分：provider（取代 `D-19`）

| # | 决定 |
|---|---|
| **D-20** | provider = **P-1 单一 JSON Search API / Tavily**；endpoint 固定常量 `https://api.tavily.com/search`；方法 `POST`；认证**只**用 `Authorization: Bearer <key>`（请求头）；**禁用 SDK**、只用 Node 22 原生 `fetch`；`production_activation: NOT APPROVED`（真实聊天启用仍需单独批准） |

### 第二部分：随 provider 一起适配的三处（其余沿用 ADR-045）

| # | 决定 | 理由 |
|---|---|---|
| **D-21** | 内部契约不变：仍是 `{query, limit, locale}`；映射为 `query` → `query`、`limit` → `max_results`、`locale` → `language`（小写化：`zh-CN` → `zh-cn`） | 端口与内核不认识供应商；换 provider 不该动契约 |
| **D-22** | **刻意不映射 `country`** | Tavily 的 `country` 要的是国家**名**（`"united states"`），从 `zh-CN` 推国家名需要一张**手工维护的对照表** —— 而本项目在 M5 已有明确结论：**禁止手工词表**（会腐坏且没人复核）。v1 只发 `language`（默认只增强排序，不硬过滤：`filter_by_language` 保持 false）。这是**与 Brave 的已知差异**（Brave 走 `country` + `search_lang`） |
| **D-23** | **显式**发 `search_depth: basic` + `auto_parameters: false` + `include_usage: true` | 官方文档明写 `auto_parameters` 可能把 basic **悄悄升级**成 advanced（2 credits = 成本翻倍）—— 那正是"静默放宽预算"。`include_usage: true` 让 provider 把**实际**消耗的 credit 报回来（成本用**测量**，不用假设），并让"被升级"这件事先于账单被人看见 |

### 第三部分：成本（**用户两次裁定：先定上限，随后取消这条规则的执行**）

| # | 决定 |
|---|---|
| **D-24** | 单次搜索成本上限 = **0.008 USD**（由用户 2026-09-20 选定）。理由：Tavily PAYG 的 basic 搜索 = 1 credit × $0.008 = $0.008/次；这是**重新裁定**，不是静默放宽 —— ADR-045 的 `D-19` §3 要求的正是"失败关闭并重新裁定" |
| **D-30** | **取消 `D-24` 的"执行"**（用户 2026-09-20 追加裁定，原话："算了为了防止后续问题直接取消'实际单价超过单次上限 ⇒ 必须失败关闭并重新裁定，不得静默放宽预算'"）。理由：**未来价格变动不该让系统起不来**。取消的**只是拒绝加载这道闸**；成本信息本身**照旧留在报告与证据里**（声明单价 / credit 用量 / `recordedAt` / `source`）|

**`D-30` 之后，成本相关的代码只有"报告"与"形状自洽"，没有任何"阻断"**：

| 保留 | 取消 |
|---|---|
| `PROVIDER_PRICE_FACTS`（`usdPerCredit` / `creditsPerBasicSearch` / 免费额度 / `recordedAt` / `source` / `enforced: false`） | "声明价 × credit 数 > 上限 ⇒ 配置**拒绝加载**" |
| `D20_RULING.costEnforcement = 'none'`（**作为可断言的数据**写下来：有人把闸装回来或把闸拆掉，量具都看得见） | `D20_RULING.maxCostPerSearchUsd`（**已删除** —— 一个没有执行者的上限就是一个死值） |
| `describeSearchProviderConfig()` 打出 `declared=… USD/次（cost-enforcement=none）` | 任何"因为贵所以拒绝工作"的路径 |
| **形状自洽**：声明的一次搜索 credit 数必须与所声明的 `search_depth` 一致（`basic` = 1 / `advanced` = 2） | —— |
| `include_usage: true` + `creditsUsed`（实际用量进证据；**只报告**） | —— |

⚠️ **如实登记一条判据变更**：量具门里原来的"成本闸检测器"（负控 = 声明价超上限 ⇒ 必须响）
**一并改掉了** —— 不是删掉，而是换成"**成本报告检测器**"（正控/负控/恢复）：
核对报告如实写出声明单价、"成本不阻断"被写明、且价格事实**没有**被接回拒绝加载；
并新增一条**反向**判据：把单价抬到 0.05/credit 时加载器必须**照常成功** ——
如果哪天有人把闸装回来，这一条会红。

### 第四部分：key 与出站形状（沿用 `D-19` 的五条，变量名随 provider 改）

| # | 决定 |
|---|---|
| **D-25** | 变量名 **`M55_TAVILY_SEARCH_TEST_API_KEY`**（测试入口只读它）与 **`M55_TAVILY_SEARCH_API_KEY`**（生产，当前不得写入任何文件）。一个模式只拼一个变量名、只读一次 ⇒ 测试缺失时**结构性**不可能回落到生产 key |
| **D-26** | key **只**出现在 `Authorization` 请求头。`recording-fetch` 结构上不保存请求头的**值**（只记名字与长度），并且 body 里一旦出现 `api_key`/`token`/`secret` 这类字段就**拒绝记录**（fail closed）⇒ key 无法进入证据、日志、提交 |
| **D-27** | 日志**最多**输出"变量存在/不存在"（不给值、长度或前后缀）；配置模块与 provider 模块**不含任何打印**（有静态锁） |
| **D-28** | 一次搜索**恰好一次**请求、**零**自动重试、硬超时 **5000ms**、结果 ≤5；超时必须如实报 `timeout`（不得压成 success）；失败码映射：401/403 → `permission_denied`、400/422 → `validation_failed`、429 → `execution_failed`、其它 → `execution_failed` |
| **D-29** | 只允许发送**合成、非敏感**的 query/limit/locale 与完成 HTTPS/认证所必需的请求头。`SearchProviderCall` 类型里**没有**记忆、prompt、人设、历史对话、userId、traceId 的位置；运行期多塞的字段会被丢弃（有量具的哨兵扫描证明它们到不了线上） |

### 第五部分：key 交付方式（**用户 2026-09-20 更新**）

`D-19` §2 原写"明文 key 由用户本机手工写入，不得交给代理消息"。用户本次明确改为：

```text
由用户把测试 key 交给 DSH；DSH 只把它写进本机 `.env.test`（已被 .gitignore 排除）。
```

**仍然禁止**：进提交、进日志、进证据文件、进 ADR/文档、进聊天以外的任何持久产物。
**仍然成立**：DSH 只创建/更新 `.env.test.example` 的**空占位符**（本轮已改为 `M55_TAVILY_SEARCH_TEST_API_KEY=`）。
⚠️ 如实登记一条：key 经对话传递会进入**会话日志**（用户已知悉并接受）。

---

## 被否决的方案

| # | 方案 | 否决理由 |
|---|---|---|
| V-1 | **保留 Brave**（不改） | 用户已裁定更换；保持"代码里的 provider"与"裁定"一致是最低要求 |
| V-2 | **同时接两个 provider**（Brave + Tavily 并存可切换） | 违反单一 provider 的准则（ADR-045 `D-19` 的推荐准则第 1 条）；两个 provider 意味着两套出站形状、两套失败映射、两份回归基线 |
| V-3 | **把 key 放进 body**（Tavily 的旧形状 `{"api_key": ...}`） | key 一旦进 body，`recording-fetch` 就会记下它 —— "结构性不可泄漏"这条保证当场失效。`Authorization` 头是唯一允许的形状，且记录器对 body 里的凭证字段 **fail closed** |
| V-4 | **`country` 用手工对照表映射** | 需要维护"语言/地区 → 国家名"的表；M5 的经验是**禁止手工词表**（会腐坏、没人复核）。宁可少发一个可选参数 |
| V-5 | **打开 `auto_parameters`**（"让 provider 自己选更好的参数"） | 官方文档明写它可能把 `search_depth` 升级成 `advanced` = **2 credits**，即成本翻倍且**不可预测** —— 与"不得静默放宽预算"直接冲突 |
| V-6 | **用 `advanced` 深度**（相关性更好） | 2 credits/次 = $0.016 > 裁定的 0.008 上限；要改必须先重新裁定上限 |
| V-7 | **装 Tavily SDK** | ADR-006 的依赖纪律 + 本期推荐准则"不用 SDK"；一个 HTTPS POST 不值得换一个架构中心 |
| V-8 | **把上限"顺便"改成 0.008 而不重新裁定** | 正是 ADR-045 `D-19` §3 明文禁止的"静默放宽预算"。当时的做法是**先问后改**，并记为 `D-24`。（**后续**：用户在同一天又用 `D-30` 取消了这条规则的执行 —— 但那是**新的裁定**，不是"顺手把闸拆了"；两者的区别就是本条被保留的原因） |

---

## 后果

**正面**

- provider 层仍然是**端口 + 一个薄适配器**：换 provider 的实测代价 = 删一个文件 + 加一个文件 + 改一处常量与判据（本 ADR 的全部代码改动）。
- 成本从"假设"变成"**测量**"：`include_usage: true` ⇒ 响应里的 `usage.credits` 被如实报出（`creditsUsed`），并按"≤ 声明 credit 数"设闸 ⇒ 任何"被悄悄升级成 advanced"都会在量具里先响。
- key 的不可泄漏性是**结构性的**：只在请求头 + 记录器不存头值 + body 凭证字段 fail closed。

**负面 / 成本**

- **`locale` 的语义变弱**：Brave 时代 `locale` → `country` + `search_lang`；现在只 → `language`（增强排序，不硬过滤）。这是 `D-22` 明确接受的差异。
- **单价上涨**：0.005 → 0.008（+60%），上限随之重新裁定为 0.008（`D-24`）。
- **多了一个必须复核的外部事实**：`auto_parameters` 的"可能升级"行为与计费口径，都写在 provider 的文档里、可能变化 ⇒ 复核时点第 1 条。

### 本 ADR **不**主张什么

```text
✗ 不主张 Tavily 的计费口径长期不变（它是外部可变事实，有 recordedAt 与 source）
✗ 不主张"basic 深度就足够好"（相关性取舍未做评测）
✗ 不主张 locale 语义与 Brave 等价（D-22 是明确的降级）
✗ 不主张真实聊天已可联网（production_activation 仍为 NOT APPROVED）
```

---

## 复核时点

1. Tavily 的**计费口径或 `auto_parameters` 行为**变化 —— 注意 `D-30` 之后这**不再**阻断运行，
   只需更新 `PROVIDER_PRICE_FACTS` 的 `recordedAt`/数字；
2. 出现"实际消耗 credit > 声明"的**实测**案例（量具的计费量检测器响了 —— 那是"被悄悄升级成
   advanced"的可观测信号，与价格无关，仍然 fail closed）；
3. 需要 `country` 级地区定向（`D-22` 的复议点，且届时必须给出**不带手工词表**的方案）；
4. 需要 `advanced` 深度（相关性取舍的复议；`D-30` 之后它不再受价格闸限制，
   但仍要改 `D-20` 的 `searchDepth` 并同步量具）；
5. 真实聊天启用联网（激活 STOP，需用户显式确认）。
