# ADR-047 — Local SearXNG Search Provider（provider 的第三次换代：Brave → Tavily → 本机 SearXNG）

```text
状态      : **ACCEPTED / DESIGN FROZEN**（用户 2026-09-20 裁定：provider = P-2 本地自托管 SearXNG）
取代范围  : ADR-045 的 §`D-19`（Brave）与 ADR-046 的全部 provider 专属决定（`D-20`…`D-30`）
不取代    : ADR-045 的 `D-1`…`D-18`（外部证据边界 / 能力形状 / 引用唯一性 / trace 映射 /
            预算缺省 0 / 回复五态 / COMPAT-1…3）**一个字都没变**；
            ADR-046 里**与 provider 无关**的结论继续有效（凭证只在头、出站形状可断言、
            恰好一次请求、零重试、5000ms 硬超时、结果 ≤5、成本只报告不阻断）
日期      : 2026-09-20
里程碑    : M5.5 Web Search & External Evidence
上游      : ADR-045 `ACCEPTED / DESIGN FROZEN` · ADR-046 `SUPERSEDED / NEVER ACTIVATED`
计划      : `docs/m5.5/M5.5-Execution-Plan.md`（WP0–WP10 与 STOP）
机器判据  : `pnpm m5.5:measurement:verify`（**100 通过 / 0 失败**；全部离线、不依赖本机容器）
```

> **provider 世代**（这段历史是真的，源码注释里也保留）：
> `Brave（ADR-045，已提交）→ Tavily（ADR-046，**从未激活**）→ 本机 SearXNG（本 ADR）`。
> ADR-045 与 ADR-046 的正文**都不改写** —— 它们记录的是"当时的裁定"。

---

## 背景

**为什么再换一次。** 用户在 2026-09-20 提供了本机已运行的自托管 SearXNG
（`P-2 本地自托管`），并裁定 provider 改为它。相比前两代：

| | Brave（P-1） | Tavily（P-1） | **SearXNG（P-2，本 ADR）** |
|---|---|---|---|
| 密钥 | 需要（env） | 需要（env） | **不需要** |
| 出站目标 | 托管 API | 托管 API | **本机 `127.0.0.1:8080`** |
| 单价 | 0.005 USD/次 | 0.008 USD/次 | **0（自托管）** |
| `locale` 语义 | country + search_lang | language | language（**会被实例回落**，见已知弱化） |
| 厂商锁定 | 有 | 有 | **无**（换引擎 = 改一行冻结列表） |

**本机实例的事实**（**只读、带外观察**，2026-09-20；不是本门量的——门必须离线）：

| 项 | 实测 | 怎么得到的 |
|---|---|---|
| 健康 | `/healthz` → **200** | `curl.exe -f --max-time 3` |
| JSON 输出 | `search.formats: [html, json]` | 只读 `…/searxng/settings.yml` 的 `formats` 段 |
| 版本 | `2026.9.20+e75fd22d0` | `/config` |
| 引擎总数 | 260；`general` 类别 **57** 个 | `/config` |
| 冻结的三个引擎 | `duckduckgo` / `wikipedia` / `wikidata` **都存在**（都在 `general`） | `/config` |
| 实例 safesearch 默认 | `0` | `/config`（我们请求里显式发 `1`） |
| `limiter` | `false`（本机自用，不做限流） | 只读 settings.yml |
| `public_instance` | `false` | 只读 settings.yml |

⚠️ **"本地服务"不等于"查询不出站"**：SearXNG 是**元搜索引擎**，它会把 `q`
转发给它聚合的上游（这里冻结为 DuckDuckGo / Wikipedia / Wikidata）。
因此本 provider 仍然是一个**会把用户显式查询词送出本机**的能力，
只是出站目标由本机服务代理、且上游被冻结成三个。
[SearXNG Search API](https://docs.searxng.org/dev/search_api) ·
**这一条写进 `queryLeavesHost: true` 与已知局限，不许被"它是本地的"这句话盖过去。**

---

## 决策

### `D-31`（冻结，用户 2026-09-20 裁定）

```yaml
decision: D-31
provider_class: P-2 本地自托管
provider: SearXNG
endpoint: http://127.0.0.1:8080/search
health_endpoint: http://127.0.0.1:8080/healthz
method: GET
authentication: none
sdk: none
api_fee: 0
requests_per_search_at_adapter_boundary: 1
automatic_retry: 0
hard_timeout_ms: 5000
max_results: 5
safesearch: 1
production_activation: NOT_APPROVED
```

### 逐条落点（每一条都有机器判据）

| # | 决定 | 落点 / 判据 |
|---|---|---|
| **D-31a** | **固定上游引擎**：`duckduckgo,wikipedia,wikidata` | `SEARXNG_ENGINE_ALLOWLIST`；量具断言"引擎集合不得漂移"，并逐条拒绝空列表/重复/未冻结/缺冻结项 |
| **D-31b** | **不使用实例默认 `general` 集合** | 实测该类别有 **57** 个引擎且随镜像更新漂移（裁定文本里写的"9 个"与实测不符，**以实测为准**，但结论不变：必须显式列出） |
| **D-31c** | **HTTP 只是固定 loopback 例外**，不是"支持 http" | `SEARXNG_LOOPBACK_EXCEPTION` 命名 + 逐段核对 scheme/host/port/path/无凭证/无 fragment；15 种非法声明全部被拒 |
| **D-31d** | **没有认证、没有 key、没有环境变量** | 请求头只有 `accept`；`loadSearxngConfig()` 不读环境变量（静态锁）；因此**不存在**"测试 key 回落生产 key"这类失败模式 |
| **D-31e** | 请求形状**冻结成六个参数**：`q` / `format=json` / `language` / `pageno=1` / `safesearch=1` / `engines=…` | 量具断言参数名集合**恰好**是那六个，且 `format/pageno/safesearch/engines` 的值正确 |
| **D-31f** | `limit` **不发给 SearXNG**；响应解析后**本地**截断为最多 5 条 | `limit` 不在请求里；解析器按 `min(limit, maxResults)` 截断（量具喂 8 条 ⇒ 取 5 条） |
| **D-31g** | 只消费 `results[].title/url/content`；**忽略** `answers` / `infoboxes` / `suggestions` / 图片与其它扩展结果 | 解析器只读 `results`；量具断言扩展字段被忽略 |
| **D-31h** | 非 HTTPS 来源、缺字段、非法 URL **丢弃并计数** | 解析器 `rejectedItems`；量具喂 5 条坏条目 ⇒ `rejected=5`；证据层仍然只收 HTTPS（ADR-045 `D-14`） |
| **D-31i** | 响应没有 `results` 数组 ⇒ **`validation_failed`**，不得解释成"成功但无结果" | 量具正负两侧 |
| **D-31j** | **403** 明确提示"JSON 格式未启用或请求被拒绝"；429 / 5xx 映射为既有失败码 | `failureForProviderHttpStatus`；量具断言 403 的 message **不含** HTML 正文 |
| **D-31k** | **超时与调用方取消必须区分** | 超时 ⇒ `timeout`；调用方取消（含**已经 abort** 的信号）⇒ `cancelled`；量具两条都测 |
| **D-31l** | 错误里**不写入 provider 原始响应正文** | 失败分支**根本不读 body**（SearXNG 的错误页是 HTML）；量具断言 403 的 message 不含 `<html>` |

### 保留自 ADR-046 / 前几代仍然成立的结论

```text
· 恰好一次请求、零自动重试（requestCount 如实上报；量具断言 fetch 只被调用一次）
· 硬超时 5000ms，与调用方信号合并
· 结果 ≤5、证据只收 HTTPS、引用无正文、标签 E1..En
· 成本只报告不阻断（D-30 的结论继续沿用；本 provider api_fee = 0）
· 出站内容可断言：参数名集合 + 头名集合 + 哨兵扫描（记忆/人设/历史/userId/traceId 到不了线上）
```

---

## 已知弱化（如实登记，不许被"换成本地就更好了"盖过去）

1. **`locale` 会被实例回落**：本实例 `/config` 的 `locales` 共 62 项，中文只有
   `zh-Hans-CN` / `zh-HK` / `zh-Hant-TW`，**没有 `zh-CN`**；而我们的内部形状
   `zz[-ZZ]` 会产生 `zh-CN` 这样的代码 ⇒ SearXNG 会回落到实例默认
   （`settings.yml` 的 `search.default_lang: "auto"`）。
   即：**`language` 只是"希望"，不是"保证"**。
2. **"本地"≠"不出站"**：`q` 仍会被转发给冻结的三个上游引擎（`queryLeavesHost: true`）。
3. **结果仍要求 HTTPS**：若某个上游只给 `http://` 链接，那条会被丢弃并计数 ——
   宁可少一条来源，也不放行非 HTTPS 证据（ADR-045 `D-14` 不变）。
4. **没有成本闸，但"免费"≠"无限"**：自托管不按次计费（`api_fee = 0`），
   但实例与上游仍可能限流/拒绝；429 与 5xx 都映射为受控失败码。
5. **本 ADR 不主张**：不主张"结果更安全"、不主张"不出站"、不主张
   "provider 层已接入真实聊天"。它的准确状态是**已接线、未激活**：
   动作链会走到它（能力已登记、意图检测器已并入检测链），
   但 `CHARACTER_WEB_SEARCH_ENABLED` 默认 `false` ⇒ 装配层不授予 `web:search`、
   不构造适配器 ⇒ **零出站**；`production_activation` 仍为 `NOT_APPROVED`。

---

## 被否决的方案

| # | 方案 | 否决理由 |
|---|---|---|
| V-1 | **保留 Tavily（或 Brave）** | 用户已裁定换成本地自托管；且托管 provider 需要 key + 计费，而本机已有可用实例 |
| V-2 | **把 endpoint 做成环境变量** | 那就等于开了一个"可以指向任意主机"的口子（含 SSRF 面）。裁定要求它是**代码常量**并被逐段核对 |
| V-3 | **依赖实例默认的 `general` 引擎集合** | 实测该集合有 57 个引擎且随镜像更新漂移 ⇒ 结果不可复现。必须显式冻结三个 |
| V-4 | **不做响应形状校验**（"有 results 就用，没有就当空结果"） | "provider 说 200 但我们读不懂"绝不能变成"成功了、只是没有结果"（ADR-033 执行真相的同一精神） |
| V-5 | **把 `limit` 发给 SearXNG / 用 `pageno` 抓多页** | SearXNG 没有按条数的参数（`limit` 不是它的字段），而翻页会突破"一次有界搜索"的边界。本地截断才是正确位置 |
| V-6 | **把 `answers` / `infoboxes` 也当证据** | 它们是**聚合器自己的生成物**，不是"某个来源说的"。证据必须可追溯到具体 URL |
| V-7 | **给本机实例加认证**（"顺手加个 token"） | 本机 loopback、`public_instance: false` 已经够；加认证就要引回 key 管理，而那正是上一代被换掉的原因之一 |
| V-8 | **允许 HTTP 作为"可配置协议"** | 那会把"本地 loopback 例外"演变成"支持明文 HTTP"。故命名为 `SEARXNG_LOOPBACK_EXCEPTION` 并逐段钉死 host/port/path |
| V-9 | **在量具里去 ping 本机容器** | 门必须**完全离线**：容器没起、被换镜像、端口被占，都不该让量具变红。实例事实单独带外观察并记在本 ADR 里 |

---

## 后果

**正面**

- **零密钥、零费用、零厂商锁定**：配置不读任何环境变量 ⇒ 上一代"测试 key 不得回落生产 key"
  这一类失败模式**结构性消失**。
- 出站形状比前两代更窄：GET、六个参数、一个头、无 body —— 量具可以把"发了什么"
  断言到参数名与头名的级别。
- 上游引擎被冻成三个 ⇒ 结果可复现，且不随镜像更新漂移。

**负面 / 成本**

- 多了一个**本机依赖**（容器要活着）；量具不受影响，但 WP9 的真实查询需要它可用。
- `language` 语义比 Brave 更弱（见已知弱化 1）。
- 仍然出站（见已知弱化 2）。

---

## 复核时点

1. 实例的 `search.formats` 不再包含 `json`（JSON 被关掉 ⇒ 403 会成为常态）；
2. 冻结引擎之一被上游封禁或改名（`duckduckgo` / `wikipedia` / `wikidata` 任一不可用）；
3. 需要 `locale` 真正生效（届时要么给实例加语言映射，要么把 `locale` 形状对齐它的 `locales` 列表）；
4. 需要地区定向或更多引擎（改冻结列表 = 改裁定，要重新出量具证据）；
5. 首次真实 `/search`（WP9 Live Smoke）之前：**再次展示冻结上游引擎清单**并确认出站范围；
6. 生产激活（真实聊天启用联网）—— 需用户显式确认。
