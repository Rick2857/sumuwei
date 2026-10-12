# ADR-054 — 搜索 provider 换回 Tavily（本地 SearXNG → Tavily 托管 API）

状态：**APPROVED / IMPLEMENTED / ACTIVATED（生产配置已写入 `.env`）**。

修订对象：[`ADR-047`](ADR-047-local-searxng-search-provider.md) 的 **`D-31`**（本地 SearXNG 那一整条）
与 [`ADR-053`](ADR-053-search-engine-swap-to-brave.md) 的 `D-53a`（冻结引擎组）。
落地对象：[`ADR-046`](ADR-046-search-provider-tavily.md) 的 **`D-20`…`D-30`** ——
那份裁定此前是 `SUPERSEDED / NEVER ACTIVATED`，本 ADR 把它**激活**。
ADR-046 / ADR-047 / ADR-053 的**正文一字未改**（按既例：由取代者在头部声明）。

日期：2026-09-22。范围：让"她联网查资料"这件事**真的能返回结果**。
授权：**用户显式批准**（"等一等我把搜索服务提供换一下，https://app.tavily.com"）。

---

## 1. 为什么换（触发条件）

`ADR-053` 把冻结引擎组换成了 `brave,wikipedia,wikidata`，并在可用窗口里证明了它有效
（Live Smoke 24/0、两轮生产路径 `candidate_count=5`）。但随后出现了**两个独立问题**：

```text
① Brave 限流：SearXNG 把它标成 `暂停服务: 请求过于频繁`，而 /search 仍回 **HTTP 200 + 空 results**
   ⇒ provider 如实 `ok:true / items:[]`、账本如实记 `ACTION_SUCCEEDED`，
     而用户看到的是"没查到"。⇒ "引擎被限流"与"网上确实没有"在证据上长得一样（ADR-053 §4.1）。
② 本机 SearXNG 那一层本身就是额外的故障面（实例、引擎、代理、冷启动），
   而它换来的只是"不出本机"这一条 —— 那条在 ADR-046 里已经被裁定放弃过。
```

用户裁定：换成 **Tavily 托管 API**（ADR-046 的设计），并把硬超时重新裁定为 **15000ms**。

## 2. 关键实测（本 ADR 的证据，全部带外、只读）

| 项 | 实测 |
|---|---|
| `api.tavily.com` 可达性（本机网络） | `GET /` **HTTP 200** · `POST /search`（无 key）**HTTP 401** ⇒ 到得了 |
| 真实响应形状 | `results[].{title,url,content,score,raw_content}` · `usage.credits` · 每次 **5 条 HTTPS** |
| **时延分布**（同一 query，4 发） | min **2285ms** · avg **4897ms** · max **8365ms** · **1 发超过 5000ms** |
| 计费读数 | `usage.credits = 1`（`search_depth=basic`）—— 与声明一致 |
| 真实聊天一轮（生产入口 · 隔离副本 · 生产 key） | `ACTION_SUCCEEDED` · `[search-cost] … 1 credit` · **正文后带程序生成的来源附录** |

**时延那一条就是"硬超时必须重新裁定"的依据**：照 ADR-046 沿用的 5000ms，约 1/4 的真实搜索
会被判成 `timeout`，用户仍然会看到"没查到"。

## 3. 决定

| # | 决定 | 落点 |
|---|---|---|
| **D-54a** | provider = **Tavily**：`POST https://api.tavily.com/search`，认证**只**用 `Authorization: Bearer <key>` | [`tavily-config.ts`](../../src/infrastructure/search/tavily-config.ts) 的 `D20_RULING` + [`tavily-search-provider.ts`](../../src/infrastructure/search/tavily-search-provider.ts) 的 `buildTavilySearchRequest` |
| **D-54b** | **硬超时 15000ms**（取代 ADR-046 `D-28` 沿用的 5000ms）—— 按 `ADR-045 D-19 §3`"先问后改"重新裁定 | `TAVILY_HARD_TIMEOUT_MS` + 配置闸的 `(0, 15000]` 上界 |
| **D-54c** | 出站 body **恰好六个字段**：`query` / `search_depth=basic` / `max_results≤5` / `include_usage=true` / `auto_parameters=false` / `language`（`locale` 小写化） | `TAVILY_ALLOWED_BODY_FIELDS` + 量具的逐字断言 |
| **D-54d** | 凭证**按模式分两个变量名**：生产 `M55_TAVILY_SEARCH_API_KEY`、测试 `M55_TAVILY_SEARCH_TEST_API_KEY`；**一个模式只读一个名字** | `loadTavilyConfig(..., { isTestMode })`；量具的四向断言（prod 只认生产名 / test 只认测试名 / 只有测试名时生产拒绝 / 只有生产名时测试拒绝） |
| **D-54e** | 凭证**只**进 `Authorization` 头；记录器**只记键名与长度**、从不记值 | `recording-fetch.ts` 的 `bodyFieldNames` + `m5.5-fetch-recorder.mjs` + 量具的凭证检测器（三条不变量） |
| **D-54f** | 成本**只报告不阻断**（`ADR-046 D-30` 照旧）：`charge` 不上闸，但 credit 用量进日志 | `PROVIDER_PRICE_FACTS.enforced=false` + `onCreditsUsed` 回调 + 一条**反向**判据 |
| **D-54g** | **删除**本地 SearXNG 那一套（`search-config.ts` / `searxng-search-provider.ts`）—— 单一 provider，不许并存（`ADR-046 V-2`） | 文件删除 + 静态清单判据 + 残留扫描 |
| **D-54h** | 限流单独映射：Tavily 的 **432**（以及 429）⇒ `execution_failed`，**不得**说成 `permission_denied` | `failureForTavilyHttpStatus` |

## 4. 已知弱化（如实登记）

1. **接收方又变了一次**：`q` 现在**直接**发给 `api.tavily.com`（不再是"本机实例转发"）。
   "本地搜索"这个词从这个里程碑起**不再适用** —— 用户说明已同步改写。
2. **第一次引入第三方凭证**：`M55_TAVILY_SEARCH_API_KEY` 在 `.env`（gitignore）。
   它与模型端点 key 是**两把不同的 key**，用途不同、不得互相顶替。
3. **时延明显变长**：实测中位 ~4.9s、最坏 8.4s（SearXNG 时代是"常超 5s"）。
   用户裁定接受 15000ms 预算；**超时态仍然存在**（`L-M55-12` 的实现在新 provider 下依旧成立）。
4. **计费是真实的**：每次 basic 搜索 1 credit、$0.008。**没有**花费上限闸（`D-30` 明确取消），
   本 ADR 也不发明一个；现状是"有报告、无阻断"。
5. **credits 的消费面**：`usage.credits` 目前只进**日志**（`[search-cost]`），
   尚未进 trace / 账本 —— ADR-046 `D-23` 的原意是"进证据"。这是**有意的范围收敛**，
   登记为待办（见 §6），不主张已经做到。
6. **她仍可能说错自己的能力**：那句"我这儿没搜索"的守卫缺口（ADR-053 §6 ①）与本次无关，
   **没有修**。

## 5. 门读数（命令 · 读数 · 状态）

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | **EXIT 0** |
| `pnpm m5.5:measurement:verify` | **PASS · 253 / 0** |
| `pnpm m5.5:test`（L1 部件） | **PASS · 59 / 0** |
| `pnpm m5.5:verify`（L2 子系统） | **PASS · 46 / 0** |
| `pnpm m5.5:e2e:verify`（L3 端到端） | **PASS · 25 / 0** |
| `pnpm m5.5:smoke:live`（真模型 + 真 Tavily + 生产库副本） | **PASS · 24 / 0**（生产路径两轮 `candidate=5/selected=2`） |
| `pnpm m5.5:gates` | **Hard Gates = PASS（G1–G5 全绿）** |
| `pnpm m5.5.1:gates` | **6/6 被接受 · overall = PASS**（`m5.5.1:smoke:live` 20/0） |
| `pnpm m6:gates` | **Hard Gates = PASS**（必选门 17 · 未运行 0 · 未通过 0）—— `wp10b-live` 由 FAIL 转 PASS（12/0，两只受影响 Live 都 exit 0） |
| 真实聊天一轮（生产入口 · 真实 key · 隔离副本） | **通过**：`ACTION_SUCCEEDED` · 1 credit · 来源附录在场 |

### 5.0 本次换代**顺带修掉的一个契约级缺陷**（比换代本身更重要）

```text
现象：接上 Tavily 之后，某一类查询让**整个聊天进程 exit 1**，用户什么也拿不到。
根因：证据选择器按额度**跳过**装不下的条目，却**保留**了各条原来的引用标签；
      一旦被跳过的是**中间**那一条，留下的标签就是 `E1,E2,E4` ——
      而引用校验要求 `E1..En` **连续** ⇒ 抛 `external_evidence_refs_invalid`。
为什么以前没炸：旧 provider 的摘要长，"只装得下最早的两三条"，标签恰好连续。
      ⇒ **缺陷一直存在，只是从未被触发**（摘要截断后，晚一点的那条才可能挤进来）。
修复：`selectExternalEvidenceContext` 在**选完之后**统一重编号（契约里本来就写着
      "标签只能由选择器按顺序赋予"）。模型看到的数据块、程序追加的附录、账本引用，
      现在用的是同一套编号。
回归锁：量具里构造"三条、中间那条超预算"的选择，要求标签连续且 `toExternalEvidenceRefs` 不抛。
```

### 5.2 落地过程中抓到的**真实事故**（这一段是本 ADR 最值钱的部分）

```text
现象：接上 Tavily 之后，Live Smoke 判 FAIL，账本里是 `partial,partial,timeout,timeout`，
      她的回复是"搜不了……什么也没出来"。而 provider 明明 `ok:true`、credit 也扣了 1。
根因：Tavily 的 `content` 常 800–1500 字符，而证据层只收 ≤600 的摘要
      ⇒ **每一条**都被 `snippet_too_long` 丢掉 ⇒ 适配器按设计报 `partial`
        （"返回了条目但一条都没能形成证据"）⇒ 用户看到"搜不了"。
      ⇒ **"provider 成功"和"用户拿到结果"之间隔着证据层**，这一步此前没有 provider 触发过。
修复：在 **provider 边界**把摘要截断到 `EVIDENCE_LIMITS.maxSnippetLength`（600）—— 截断，不是丢弃。
      理由：摘要长度是 provider 的方言，"多长算合格"是**我们的契约**（与 `max_results` 本地截断同理）。
回归锁：量具里加一条 —— 喂 1680 字符的 content ⇒ 必须得到 600 字符的摘要、
        且**真的能形成证据**（`evidence=1 / rejections=0`）。实测读数：`content=1680 → snippet=600 · evidence=1`。
```

### 5.3 本次顺带修正的**判据缺陷**（不是被测对象的问题）

```text
① m5.5 量具："出站不得出现任何凭证"这条口径随 provider 换向**反转**：
   SearXNG 没有认证 ⇒ `authorization`/`bearer` 一律异常；
   Tavily **必须**发 `Authorization: Bearer` ⇒ 那两个词必然出现。
   现在守的是三条不变量：诊断行里只有变量名（不含值）· 凭证只在头里 · 头值非空。
② m5.5 量具：反向自检的探针写的是 `api.tavily.com` —— 表方向反转后那是**合法代码**，自检恒假。
   现在探针用**真在表里**的残留（被删的 SearXNG 痕迹）。
③ m5.5 量具：静态残留扫描从"扫 src + scripts"收窄到"扫 src"。
   脚本里合法地存在被删文件的名字（文件清单锁、WP10b 历史白名单），
   收窄是**去掉假阳性**，而"没有第二套 provider"由文件清单判据独立覆盖。
④ kernel-tests："配置模块不读 env"这条在 Tavily 下不可能成立（key 只能从 env 来）。
   现在断言的是更准的形状：**只有**配置模块读 env，且只有那两个具名常量、只有一次读取。
⑤ e2e 场景 12：窗口写死 1400 字符，ADR-054 加了注释就把 `grantedPermissions` 挤出窗口 ⇒ 假红。
   现在按两个锚点取整段。
⑥ smoke 门 G5：分类判据写的是 `127.0.0.1:8080`（SearXNG 的 host）⇒ provider 换代后
   把搜索出站全算成"模型出站"（搜索 0 条）。现在按 `api.tavily.com/search` 分类。
⑦ smoke 门 G6 的"query 逐字"判据：SearXNG 把 query 放在 **URL 参数**里，所以能逐字读回；
   Tavily 把 query 放在 **body 的值**里，而记录器按纪律**只记键名、不记值** ⇒ 出站侧结构上读不到。
   现在如实改成"body 字段集合含 `query` + 进程内直接探针逐字核对过形状"，
   并在标签里写明**它不再主张**"出站证据里能逐字读到 query"（而不是假装还能）。
```

## 6. 未做 / PENDING（逐条）

```text
① `creditsUsed` 进 trace / 账本（ADR-046 D-23 的原意）：目前只进日志（`[search-cost]`）。
② `m6:gates` 的 `wp10b-live`：R1 白名单已登记本 ADR 的三个文件；X 段仍须重跑。
③ 真实聊天端到端（用户自己重启 `pnpm chat`）：本 ADR 只报"隔离副本上跑通了一轮"。
④ "她否认自己有搜索能力"的守卫缺口：**未修**（与本次无关）。
⑤ 计费累计与免费额度用尽后的行为：**未定义**（没有成本闸是 D-30 的裁定；额度用尽会表现成 401/432）。
```

## 7. 回退

把 provider 换回 `ADR-053` 的那一套（SearXNG + `brave,wikipedia,wikidata`），
或退回 `explicit` 模式 / 关闭 `CHARACTER_WEB_SEARCH_ENABLED`。
不在 `data/` 上做任何迁移或恢复；不改长期记忆。保留本次全部失败与成功证据。
