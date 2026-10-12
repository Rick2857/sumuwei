# ADR-053 — 搜索上游引擎组更换：`duckduckgo` → `brave`

状态：**APPROVED / IMPLEMENTED（代码与断言）/ VERIFICATION PENDING / ACTIVATED（生产配置即时生效）**。

修订对象：[`ADR-047`](ADR-047-local-searxng-search-provider.md) 的 **`D-31a`**（固定上游引擎组）。
ADR-047 正文**一字未改**；本 ADR 只做状态修订，并把"接收方变更"这一条记成可审计的事实。
提案来源：[`ADR-051`](ADR-051-search-engine-recovery-proposal.md)（`NOT APPROVED`，**保留为历史**）。

日期：2026-09-22。范围：解除"用户显式要求搜索 → 每次必然 `timeout`"的真实故障。
授权：**用户显式批准**（"A. 换引擎组为 brave,wikipedia,wikidata（推荐）"）。
⚠️ 这是**出站接收方变更**：`queryLeavesHost` 仍然为 `true`，`q` 现在被本机 SearXNG 转发给
**Brave** 而不是 DuckDuckGo。

---

## 1. 触发条件（TD-10 的"复发"判定）

[M6.1 技术债 TD-10](../m6.1/M6.1-and-Later-Technical-Debt-Plan.md) 写明启动条件是
"DDG 可用性波动、代理依赖 ⇒ **复发时启动**"。本轮复发，且比 ADR-051 立案时更彻底 ——
不再是"波动"，而是**持续不可用**。

真实聊天现场（用户提供，2026-09-22）：

```text
[action] ACTION_REQUESTED      act:c6bd9060-…
[action] ACTION_TARGET_RESOLVED
[action] ACTION_AUTHORIZED        ⇐ 能力已授予、策略已放行、适配器已构造
[action] ACTION_STARTED
[action] ACTION_FAILED          status=timeout
苏沐薇: 没查到。……反正我这边什么都没拿到。
```

`ACTION_AUTHORIZED` 排除了"权限未授予"那条路（`.env` 的
`CHARACTER_WEB_SEARCH_ENABLED=true` 是生效的）；`status=timeout` 把故障钉在**出站结果**上。

## 2. 带外证据（本次实测，按冻结的六个参数与 5000ms 硬超时）

| 引擎组 | 查询 | 实测 | `unresponsive_engines` |
|---|---|---|---|
| `duckduckgo,wikipedia,wikidata`（**旧**） | 西安今天天气 | **8010ms / 0 条** | `duckduckgo 暂停服务: 超时` |
| `duckduckgo` 单独 | 西安 / openai | **11ms / 67ms / 0 条** | 秒级失败（引擎已被暂停） |
| `wikidata` 单独 | 西安 / openai | 8ms / 3009ms / 0 条 | 超时 |
| `wikipedia` 单独 | 西安 / openai | 429ms / 113ms / 0 条 | 无失联（但这两个查询它本来也未必有词条） |
| `wikipedia.en` 单独 | openai | **8022ms / 34 条** | 2 个 |
| **`brave,wikipedia,wikidata`（新）** | 西安今天天气 | **1188ms / 20 条（17 条 HTTPS）** | **0** |
| **同新组** | 最近有什么新的前端框架火起来了 | **1280ms / 20 条（20 条 HTTPS）** | **0** |

结论：旧组里唯一的通用网页引擎已死，`wikidata` 也超时，只剩 `wikipedia` —— 而它单查询约 **8 秒**，
**必然超过冻结的 5000ms 硬超时**。因此旧组下的搜索**不是"有时失败"，而是结构性必然超时**。
新组在同一台机器、同一实例、同一时刻把两个查询都压到 ~1.2 秒并返回 20 条。

与 ADR-051 立案时的读数一致（当时：Brave 2084ms/20 条，DDG 5009ms 超时）——
两次独立测量方向相同，故本次不再重复"多时段探针"。

## 3. 决定（逐条落点）

| # | 决定 | 落点 / 判据 |
|---|---|---|
| **D-53a** | 冻结上游引擎组由 `duckduckgo,wikipedia,wikidata` 改为 **`brave,wikipedia,wikidata`** | `SEARXNG_ENGINE_ALLOWLIST`（[`search-config.ts`](../../src/infrastructure/search/search-config.ts)）；`D31_RULING.engines` 与它同源 |
| **D-53b** | **只换 D-31a 这一条**；ADR-047 其余全部裁定（`D-31b`…`D-31l`）**逐条不动** | 固定 loopback endpoint · 无认证/无 key/无环境变量 · 恰好六个参数 · 恰好一次请求 · 零重试 · 硬超时 5000ms · 结果 ≤5 · 只消费 `results[].title/url/content` · 非 HTTPS 丢弃并计数 · 无 `results` ⇒ `validation_failed` · 失败分支不读 body |
| **D-53c** | 量具的**精确集合断言**随之更新，**不得**放宽成"任意非空列表" | `verify-m5.5-measurement.ts`（`D31_RULING.engines`）与 `verify-m5.5-smoke-live.ts`（`SEARXNG_ENGINE_ALLOWLIST`）两处逐字断言 |
| **D-53d** | 四条负控（空列表 / 重复 / 未冻结 / 缺冻结项）**继续有效**，并改用**新**冻结集合取值 | 重复 = `brave,brave,wikipedia,wikidata`；未冻结 = 新组 + `google`；缺冻结项 = 仅 `brave` |
| **D-53e** | 这是一次**接收方变更**，必须如实登记在受影响文档里，**不得**用"本地搜索"盖过去 | 本 ADR 第 5 节 + 用户说明第七节（`docs/苏沐薇-使用说明.txt`，权威源） |
| **D-53f** | **不加长超时**（用户本轮未选 B） | `hardTimeoutMs` 保持 5000ms：实测证明加时拿不到结果（DDG 秒级失败、wikidata 超时），加时只会让用户多等 |
| **D-53g** | ADR-047 / ADR-051 正文**不改写**；ADR-051 状态保持 `NOT APPROVED`（它是提案，不是本次裁定） | 本 ADR 取代其**提案**，但不改写它的历史读数 |

## 4. 已知弱化（如实登记）

1. **Brave 会限流，而且是"秒回空结果"而不是报错**（本轮实测，2026-09-22）：
   在短时间内密集查询之后，SearXNG 把它标成 `暂停服务: 请求过于频繁`
   （`unresponsive_engines`），而 `/search` 仍然回 **HTTP 200 + 空 `results`** ——
   于是 provider 如实报 `ok: true / items: []`、账本如实记 **`ACTION_SUCCEEDED`**，
   而用户看到的是"没查到"。**代码与账本都没有说谎**（它是真的 200、真的没有条目），
   但"引擎被限流"与"网上确实没有"在这条路径上**长得一模一样** —— 这是个真实的可观测性缺口。
   本轮退避实测：约 2 分钟后恢复过一次（20 条），随后再度限流。
   ⚠️ 复现方法：对同一实例连续探测；结论不得外推为"Brave 一贯可用"。
   ⇒ 归属建议：作为**独立条目**进入搜索维护包（与 `L-M55-12` 的"超时"分开记，两者不同层）。
2. **`wikipedia` / `wikidata` 在旧组里也没救回来**：它们不是本次故障的根因，本 ADR 不主张它们可用性提升。
3. **`locale` 仍会被实例回落**（ADR-047 已知弱化 §1，**未修**）：本实例 `locales` 没有 `zh-CN`。
4. **"本地"≠"不出站"**：`q` 仍离开本机，只是接收方由 DuckDuckGo 换成 Brave。
5. **本次不改回复守卫**：她仍可能说出"我这儿没搜索"这类**能力否认句**而守卫不纠正
   （守卫只顶替"成功口吻"）。那是独立缺陷，见第 6 节。

### 4.1 一次完整真实聊天的现场（2026-09-22，生产入口 · 真端点 · 隔离副本）

```text
环境：`tsx src/main.ts "搜一下最近有什么新的前端框架火起来了"` · PGLITE_DATA_DIR 指向生产库副本
（`%TEMP%\lg-chatcheck\pglite`）· 真实 .env 端点 · 真实库树摘要前后**逐字相同**（1206 文件）
账本：ACTION_REQUESTED → TARGET_RESOLVED → AUTHORIZED → STARTED → **SUCCEEDED**
她的回复：正文里写"没结果"，并附带一句**假的能力否认**——"我这边真没有能用的搜索"
归因（带外复测同一句）：provider `ok:true · items:[] · requestCount:1 · rejectedItems:0`
                      裸上游 `HTTP 200 · results=0 · unresponsive=[["brave","暂停服务: 请求过于频繁"]]`
```

⚠️ 这一段**正是**上面第 1 条与第 5 条的现场：动作层成功、证据层为空、并且她**同时**说错了自己的能力。
它也是"为什么不能只看 `ACTION_SUCCEEDED`"的证据。

## 5. 受影响面（接收方可审计清单）

```text
出站接收方      DuckDuckGo → Brave（本机 SearXNG 的 brave 引擎，非需 API key 的 Brave 托管 API）
出站内容        不变：仅 q（用户原话里判定器挑出的那一段）+ 固定六参数 + accept 头
出站次数        不变：每轮 ≤1 次 provider 请求、0 重试
超时预算        不变：5000ms 硬超时（D-53f 明确不改）
认知边界        不变：证据不写长期记忆（D-7）、正文不进 trace/账本（D-8）、不做逐句蕴含验证（D-10）
```

## 6. 未做法（不在本 ADR 范围内，逐条登记）

```text
① 回复守卫的"能力否认"缺口：`我这儿没搜索` 不含成功口吻 ⇒ 不被顶替（本次真实回复里出现过）。
   与引擎无关，属独立缺陷；建议在搜索维护包内单独立项。
② 511/517 类响应超时后的用户可见句：本轮她自己在正文里承认"超时"，守卫按设计未接管（正确）。
③ 受影响 Live 门与 WP10b 的**重跑**：见第 7 节。
④ 代理/网络层根因（原本 DDG 是靠 outgoing.proxies 恢复的）：本次不追究，保留失败证据。
```

## 7. 实施范围与验证要求（诚实分列）

| 项 | 状态 |
|---|---|
| `src/infrastructure/search/search-config.ts` 常量 + provider 注释 | **已完成** |
| 两道精确集合断言 + 四条负控取值 | **已完成** |
| `pnpm typecheck` | **EXIT 0** |
| `pnpm m5.5:measurement:verify` | **PASS · 239 / 0** |
| `pnpm m5.5:test`（L1 部件） | **PASS · 58 / 0** |
| `pnpm m5.5:verify`（L2 子系统） | **PASS · 46 / 0** |
| `pnpm m5.5:e2e:verify`（L3 端到端） | **PASS · 25 / 0** |
| `pnpm m5.5:smoke:live`（真实模型 + 真 SearXNG + 生产库副本） | **PASS · 24 / 0** |
| `pnpm m5.5:gates`（G1–G5） | **PASS（Hard Gates 全绿）** |
| 带外实测：生产 provider 代码本尊 | **2/2 成功**（1966ms / 1762ms · `ok:true` · HTTPS 条目各 5 条，含真实天气数据） |
| `pnpm fast`（= offline lane，34 道） | **EXIT 0 · 34 PASS / 0 FAIL** |
| 受影响 Live（M6 WP10b 的 X 段） | **PENDING**（见第 7.1 节） |
| 真实聊天端到端（用户重启 chat 后说一句"搜一下 …"） | **PENDING**（用户侧） |

### 7.1 换引擎前后同一条门的对照（同一个门、不同上游）

```text
换之前（本机记录）：M5.5 Live Smoke = 17 通过 / 7 失败 · 判定 FAIL
                    · 真实 provider 在生产路径返回候选 = **0**（旧组每次超时）
换之后（本 ADR）：  M5.5 Live Smoke = **24 通过 / 0 失败 · 判定 PASS**
                    · 两轮生产路径各拿到 candidate=5/selected=4 与 candidate=5/selected=5
```

### 7.2 本次顺带修正的两处**判据缺陷**（如实登记，不是"被测对象"的问题）

```text
① `scripts/kernel-tests-m5.5.ts` 的"开关真的被消费"静态锁：
   旧正则写死了 `recallBudget: this.flags.webSearchEnabled ?` 这一种字面形状；
   M6 的 `19b394a` 把 `rollupTokens` 追加进 `recallBudget` 后形状变了 ⇒ 判据**假红**
   （同一个 flag 仍在那一行做守卫）。现按"条件 + 展开 + 同一行上的额度"判，
   已用**三段式**自证：正控安静 / 负控（去掉守卫）必响 / 恢复又安静。
② `scripts/verify-m5.5-smoke-live.ts` 的超时判据：
   旧写法拿"账本里**任意**一条超时行"去比 **S2 那一轮**的回复 ⇒
   真实聊天留下的账本行（或 S1 超时 + S2 成功）会造成**假红**。
   现按 **traceId** 把"超时行"与"它自己那一轮的回复"配对；不属于本次运行的行
   如实说明并不参与判据。本轮读数：2 行超时均不属于本次运行，本次运行 0 行超时。
```

⚠️ **本 ADR 不主张任何未在上表出现的门已经通过。** 未跑的项按 PENDING 如实保留。

### 7.3 同一道门**当日后续复跑**的读数（如实分列；不许把 PASS 说成当前状态）

| 次序 | 命令 | 读数 |
|---|---|---|
| 第 1 次 | `pnpm with-test-model pnpm m5.5:smoke:live` | **24 通过 / 0 失败 · PASS**（生产路径两轮 candidate=5/selected=4 与 5/5） |
| 第 2–4 次 | 同上（本轮为写本 ADR 与做真实聊天验证而密集探测之后） | **19/5 · 20/4 · FAIL** —— 红的是"没有附录 / 没有 `external_evidence` step / `candidate_count=0`" |

第 2–4 次的根因是**第 4 节第 1 条**：`brave 暂停服务: 请求过于频繁`，SearXNG 仍回 HTTP 200 + 空
`results` ⇒ provider 如实 `ok:true / items:[]` ⇒ 没有证据可入模。静默 15 分钟**不足以**恢复；
40 分钟窗口另行验证（见下）。第 2–4 次**不是**"引擎组换错了"的读数，也**不覆盖**第 1 次 ——
两次读数的差别在**外部配额**，不在代码：这四次跑的是同一个提交、同一份冻结配置。

⚠️ **对"第 1 次 PASS 能不能当当前状态的证据"这个问题，本 ADR 的立场是：不能单独当。**
它证明"这条链在新引擎下真的走得通"，但它**不证明**"引擎组在当前时刻可用"。
`m6:gates` 里 `wp10b-live` 那一条因此**仍然红**，直到补跑拿到 X 段的绿。

## 8. 回退

把 `SEARXNG_ENGINE_ALLOWLIST` 与两处断言改回 `duckduckgo,wikipedia,wikidata`；
不进行数据库迁移或恢复，不改长期记忆。保留本次全部失败与成功证据。
