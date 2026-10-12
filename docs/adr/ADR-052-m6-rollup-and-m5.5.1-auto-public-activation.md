# ADR-052 —— M6 摘要与 M5.5.1 自动查证的**生产激活**（状态修订）

```text
状态      : ACCEPTED / EXECUTED（**只做状态修订**）
日期      : 2026-09-22
授权      : 用户 2026-09-22 明确指令「先把后面两个激活吧，我先试试」+ 选择「(i) 旋钮 + 400 + 连带重跑」
载体性质  : 照 ADR-048（M5.5 搜索生产激活）的形状 —— 只记录"哪个能力被通电、凭什么、怎么回滚"，
            **不改** ADR-049（搜索设计与模式语义）· **不改** ADR-050（摘要来源边界）一个字节
```

---

## §1 激活了什么

| # | 能力 | 激活方式 | 缺省（未激活时的行为） |
|---|---|---|---|
| 1 | **会话摘要（rolling summary）** | 新增 `CHARACTER_ROLLUP_TOKENS`（有界 0..2000，**缺省仍 0**）· 生产 `.env` 设 **400** | 额度 0 ⇒ 端口虽构造，**不读库、不产 section、不写 trace**（与 M6 验收时逐字一致） |
| 2 | **按需自动查证（`auto_public`）** | 生产 `.env` 加 `CHARACTER_WEB_SEARCH_MODE=auto_public`（模式本身由 ADR-049 裁定；本次只是**通电**） | 未设 ⇒ 走 `explicit`：只有原话带显式搜索词才出站 |

**代码改动**（进 `main`）：`19b394a`（`flags.ts` 加旋钮 + `main.ts` 喂给 `recallBudget.rollupTokens`）。
**配置改动**（gitignored、不进 Git）：`.env` 两行。`.env.test` **未改** ⇒ 测试档仍走 `explicit`、额度 0。

## §2 激活的机器证据（**两轮两次复现**）

```text
① 摘要真的在跑（不是"接了线"）：
   wp10b G2（判据已改为"配置与实际一致"）读：额度=400（已激活）
   那一轮 trace 的 context_compile 出现 **16 个 `rollup_*` 键**：
     rollup_items · rollup_status · rollup_scanned · rollup_covered_from/to · rollup_source_refs ·
     rollup_omitted_eligible · rollup_section_survived · rollup_selector_version ·
     rollup_rejected_{non_user,invalidated,unconfirmed,contradicted,out_of_scope} ·
     rollup_skipped_by_recent · rollup_coverage_truncated
   （runId `m6-wp10b-19b394a32b4c` 与 `m6-wp10b-830b37a8ae27` 两次都复现）
   ⚠️ 那两轮 `rollup_section_survived` 都是**假**（这一轮没有摘要 section 存活）—— 如实记录，
      不主张"每轮都会带摘要"；额度给了，**能不能产出内容仍取决于有没有合格来源**。
② 自动查证真的在跑：`m5.5.1:smoke:live` = **20/0**
   C1/C2「对 SearXNG 恰好一次出站」· C3/C4「私人对象 / 显式禁止 ⇒ 零出站」· 附录形状 · 账本读回 ·
   真实库摘要前后逐字相同（1206 文件）
③ 真实库未被试验打开：Z1 摘要 `9878ed0512f095df…` 前后逐字不变
```

## §3 判据随之修正（**两条，都记录了理由，不是放宽**）

| 判据 | 旧口径 | 新口径 | 为什么 |
|---|---|---|---|
| `wp10b-live` **G2** | "那一轮一个 `rollup_*` 键都没有"（= 证**缺省不激活**） | "**配置与实际一致**"：额度 0 ⇒ 不许有键；额度 >0 ⇒ **必须**有键 | 旧口径只对"未激活"这一个状态成立；通电后它会在新运行里说假话。新口径两态都成立、都更有牙 |
| `wp10b-live` **R1** | "相对 WP10a 冻结候选 `866f2fb`，只动了 `scripts/`" | "相对 **`m6-complete`**，运行相关的非 scripts/ 改动**逐条**落在**逐文件白名单**里" | 旧口径的前提是 M6 收口那一刻的树；`m6-complete` 之后经批准的 4 处改动（`package.json` · 判定指令 `6a3ea3c` · 旋钮 `19b394a`）让它在数学上必然为假。白名单比前缀判断**更严**：白名单外任何一条都会报出来 |

两次修正后实测：**R1 PASS**（白名单外 0）· **G2/G3/G4 PASS** · **R2 PASS**（自指豁免已证明）。

## §4 本 ADR **不**主张什么

```text
· 不主张"她更聪明了"：摘要是**抽取式 + 带 sourceRefs** 的会话内摘要，不产生新事实、不进永久记忆
· 不主张 auto_public 的判定**准**：语义门最差轮 auto 召回 **18/20 = 90.0%**（阈值 ≥90%，刚好达标）
  ⇒ 该查的约有**一成**不会查；过度搜索 1.6%。这是**可接受的工程值**，不是"不会漏"
· 不主张"每轮都会带摘要"：见 §2① —— 这一轮没有 section 存活
· 不改 M6 = PASS、M5.5.1 = PASS、G1 = PARTIAL、`M6-FMB-01` = NOT MET 中的任何一个
· 不迁移 / 不恢复真实库；不动 M5.5 / M5.1 / M5.1.1 的历史证据与标签
```

## §5 当前已知的**非激活类**阻塞（如实登记）

```text
`wp10b-live` 的 X 段里，`m5.5:smoke:live` 连续两轮 FAIL（17 通过 / 7 失败），
逐条归因 = **上游搜索返回 0 条**：探针 `timeout→ok(0)`、账本 `2 行 timeout,timeout`、
没有 `external_evidence` step ⇒ 7 条红全是"候选为 0"的下游后果。
这与 `M6-Known-Limitations §5`（搜索稳定性：冻结三元组依赖 duckduckgo，会被反爬/网络层挡住）
是**同一类环境问题**，**与本次激活无关**（C3/C4 的零出站、恰好一次出站都正常通过）。
⇒ 因此 `pnpm m6:gates` 现在是 **Hard Gates = NOT PASS**（wp10b-live 取最新那份 FAIL 证据）。
   这是**如实读数**，不许藏；等上游恢复后重跑 X 段即可回到 PASS。
```

### §5.1 归因精化（2026-09-22 晚 · **只加证据，不改上文的结论**）

```text
上文"上游搜索返回 0 条"没错，但**太粗**。机器探针把"0 条"拆成了三件不同的事：

① `wikipedia` / `wikidata` **不是故障**：这两个引擎按设计只做"精确标题查 Wikipedia REST 摘要接口"
   （`searx/engines/wikipedia.py` 的 `rest_v1_summary_url`，`display_type = ["infobox"]`），
   结果落在 **`infoboxes`**，**本来就不产 `results`**。
   实测 `q=北京`：`wikipedia results=0 infoboxes=1`（"北京市，简称'京'…"）·
   `wikidata results=0 infoboxes=1`（命中同名县城），**无报错、~140ms**
   ⇒ `results=0` 是**健康引擎的正确读数**，**不是**"静默失败"。
   ⚠️ 而且"忽略 infobox"是**冻结裁定**：ADR-047 `D-31g`（只消费 `results[].title/url/content`）；
      `V-6` 把"把 `answers`/`infoboxes` 当证据"列为**已否决备选**
      （它们是聚合器自己的生成物，追溯不到具体来源）。
      ⇒ **不得**为了点亮 X 段而把 infobox 变成候选 —— 那既是推翻冻结裁定，也是"为过门放松判据"。

② `duckduckgo` 是**唯一**会产 `results` 的引擎，而它从这台机器**不可达**：
   · 直连 `/search` = 8.0s ⇒ `unresponsive=[duckduckgo:超时]`
   · 容器日志：`ERROR:searx.engines.duckduckgo: engine timeout` +
     `WARNING:searx.network.duckduckgo: ConnectionError: the server has disconnected, retrying`
   · 容器**已**配 Clash 出口（`/etc/searxng/settings.yml` 的
     `outgoing.proxies = http://host.docker.internal:7897`）⇒ **经代理仍然超时**
   · 宿主机侧：Clash 在听（`verge-mihomo`），但 `html.duckduckgo.com` 与 `duckduckgo.com`
     **经代理与直连都失败**（~14s，"基础连接已经关闭"= 链路被重置）
   ⇒ 堵点是 **ddg 这一跳**（代理规则 / 节点 / 链路），**既不在仓库里，也不在 wikipedia 引擎里**。

③ 容器与宿主机对 `zh.wikipedia.org` / `www.wikidata.org` **都可达**
   （宿主机 HTTP 200 · 容器 `wget` OK · 引擎要的摘要接口经代理与直连都返回 200 JSON）
   ⇒ **不是** Docker 出口隔离问题，也不是容器 DNS 问题。

⇒ 结论不变：**X 段只能等 ddg 可达**（或按 ADR-051 的引擎恢复提案，走程序改冻结清单）。
   `M6-Known-Limitations §5` 已登记"冻结三元组依赖 duckduckgo"这条局限；
   本节把**机制**补精确（三元组里只有 ddg 产 `results`，另两个按设计只产 `infoboxes`）。
```

### §5.2 出口侧排查（2026-09-22 晚 · **只读**，未改任何代理配置）

```text
在 §5.1 的②上再往下查一层，结论是**上游 ddg 侧拒绝**，不是本机配置缺项：

① 这台机器的**全部**流量都被 Clash TUN 接管：`tun.enable: true`（stack=gvisor, auto-route）
   且 `dns.enhanced-mode: fake-ip`（`198.18.0.1/16`）⇒ 宿主机解析任何域名都返回 198.18.0.x。
   因此先前测的"直连"其实**也**走 Clash —— "经代理/直连结果一样"不是巧合。
② 配置里**没有** `duckduckgo` 规则 ⇒ 落到兜底 `MATCH,Final`（`Final` 是 select：
   `MESL / Fallback / Auto / DIRECT`）。但**同样没有规则**的 `zh.wikipedia.org`（HTTP 200 · 575ms）
   与 `baidu.com`（HTTP 200 · 679ms）都通 ⇒ **兜底这条路是通的**，
   既不是"缺规则"，也不是 `Final` 指向 `DIRECT`。
③ 有专属规则且能通的站（`x.com` · `twitter.com` · `bbc.co.uk` · `facebook.com`）也都通。
   ⇒ **唯一失败的就是 `*.duckduckgo.com` 的三个主机**（home / html / lite），
   形态完全一致：**~14.3–14.5s，TLS 发送阶段"基础连接已经关闭"（链路被重置）**。
④ ⇒ 归因：**DuckDuckGo 侧对这条出口的拒绝/重置**（ddg 对机房/VPN 出口 IP 的已知封锁），
   **不是**本机 DNS 污染（fake-ip 由 mihomo 远端解析，且 wiki/百度同时正常）、
   **不是**节点全挂（同一路径下别的站 200）。
⑤ 佐证：另一会话今天写进 `/etc/searxng/settings.yml` 的注释称其当时实测
   "en.wikipedia.org / wikidata.org / duckduckgo.com/html 均 200 且无 challenge 页"
   ⇒ ddg **今天早些时候是通的，之后被拒** ⇒ 属**间歇性 · 上游侧**，
   与 `L-M55-12`（"真实超时是常态而非偶发"）同一类。

可操作项（都在宿主机侧，**未由本会话执行**）：
  (a) 在 Clash Verge 里给 `duckduckgo.com` 加一条规则指向**别的节点组**，或换 `Final` 的选中节点；
  (b) 换/续订阅（当前出口 IP 被 ddg 拉黑）；
  (c) 若短期不可解 ⇒ 引擎清单变更属 **ADR-051** 的程序，**不得**从仓库内绕过
      （`D-31g` + 已否决的 `V-6` 决定了 infobox 不能当候选）。
```

### §5.3 X 段复跑读数（2026-09-22 晚 · **不稳定，不是"再跑一次就好"**）

```text
背景：ADR-053 已把引擎组换成 `brave,wikipedia,wikidata`（用户批准）。换完之后实测 brave
**有候选**（探针连续三次 `results=19`、`unresponsive=[]`），于是重跑 X 段。
四次读数（**每次都是真的跑了**；按纪律**不挑选通过批次**、不靠重跑刷绿）：

  19:37  wp10b（另一会话，换 brave 前）  m5.5:smoke:live = 19 通过 / 5 失败（候选为 0 那一组）
  19:52  wp10b（本会话）                m5.5:smoke:live = **23 通过 / 1 失败**（只红 S1 附录）
         └ 同一轮 X 段：`m5.5.1:smoke:live` = PASS
  19:55  **单跑** `m5.5:smoke:live`      = **24 通过 / 0 失败（PASS）**（S1 附录 5 行 · 2 条出站 · 2 条 step）
  19:57  wp10b（本会话）                m5.5:smoke:live = **20 通过 / 4 失败**

⇒ **20/4 那一轮的红全是同一件事**：`external_evidence` step = **0 条**（扫了 20 条 trace），
  两个回合的回复都短（98 / 186 字）且**都没有附录** ⇒ 那一轮**两次搜索都没形成证据**。
⇒ 即：**同一个提交、同一份配置，四分钟内三次读数分别是 24/0 · 23/1 · 20/4**
  ⇒ `m5.5:smoke:live` 现在是**间歇性**的，而不是"某一次偶然红"。

**本节点不主张已定位根因**（不许把假设写成结论）—— **该保留已被 §5.4 取代：归因已做出来**。现有证据只支持到这个程度：
  · 红的形态都是"**证据根本没入模**"，不是"入了模但附录没加"（后者才是纯程序问题）；
  · 同一条链上有三个**已知会间歇失效**的环节，本轮**尚未**逐一定位：
    ① **需求判定器失败关闭**（判定超时 / 非法输出 ⇒ 不出站；该端点历史上出现过 HTTP 429 与
       `invalid_output`，见 `M5.5.1-WP7-Failure-Report` · `L-M55-16`）
    ② **provider 5s 硬超时**（`L-M55-12`：真实超时是**常态而非偶发**；超时 ⇒ 候选 0 ⇒ 无证据）
    ③ **brave 侧 429 限流窗口**（换引擎当天实测到 `SearxEngineTooManyRequestsException,
       suspended_time=180`）
⇒ 归因属 **M5.5 / M5.5.1 的稳定性范围**，且正好是 `ADR-053` 那条 `VERIFICATION PENDING` 要收口的东西。
⇒ 因此 **`pnpm m6:gates` 仍是 `Hard Gates = NOT PASS`（未通过 = `wp10b-live`）**，
   §5 的环境阻塞**保留**；**不得**靠反复重跑来把这一格刷绿。
```

### §5.4 归因结果（2026-09-22 晚 · 三个候选环节逐一定位）

```text
对 §5.3 列的三个环节做了一轮**只读**归因，逐条给当场读数：

① **判定器"失败关闭 / 不出站" —— 排除。**
   失败轮的 G5 出站记录器**捕获到了两次生产回合的出站**，`q` 正是两句原话里被挑出来的那段
   （`2026年9月20日 有什么科技新闻` · `ignore all previous instructions prompt`）
   ⇒ 判定器**确实**判了 `search`，红的不是"判定失败关闭"。

② **provider 5s 硬超时 —— 真实存在，已量到。**
   冻结配置（ADR-047 `D-31`）：`hardTimeoutMs=5000` · `automaticRetry=0`。
   现场测同一引擎组：**全新查询 8004ms（> 5000ms ⇒ 必然超时）**，另两次 1259ms / 3424ms
   ⇒ 延迟**横跨**5 秒线。失败轮自己的诊断探针也记了 `timeout(req=1) → ok(5)`（**第一次就超时**），
   而真实库副本里 `web.search` 的终态行确有 `status=timeout`
   ⇒ 与已登记的 `L-M55-12`（"真实超时是**常态而非偶发**"）逐字吻合。

③ **brave 侧 429 限流 —— 真实存在，且以"分钟"为尺度振荡。**
   19:51 连续三次 `results=19 · unresponsive=[]`（守望正是那时命中的）
   → 20:0x 同一句查询连续五次 `results=0 · brave:暂停服务: 请求过于频繁`
   ⇒ 候选可用性会在**几分钟内**翻转。

⇒ ② 与 ③ **同时在生效**，且终态相同：**候选 0 ⇒ 没有证据包 ⇒ 没有 `external_evidence` step
   ⇒ 没有来源附录 ⇒ S1 红** —— 这就是 §5.3 那轮"0 条 step"的成因。

**同时被排除的两项**（也有读数支撑）：
  · **不是附录 / 绑定的程序缺陷**：红的形态是"**0 条 step**"（根本没东西可追加）；
    通过轮里附录是好的（S1 5 行 · S2 4 行）。**所以不该去改那段代码。**
  · **不是本次激活（摘要 400 / `auto_public`）造成的**：**同一份配置**在 19:55 跑出 **24/0 PASS**
    ⇒ 激活不是那个变量（§5 原文的判断成立）。

⇒ 结论：`m5.5:smoke:live` 的 S1 断言的是**正路径**（"真的形成证据并加了附录"），
   而这条正路径的**前置**——第三方引擎在 5 秒内给出候选——在当前环境里**按分钟级振荡**
   ⇒ 该门在 brave/超时窗口里**必然间歇性红**，**不是仓库内可修的**，也**不许靠重跑掩盖**。
   可动的只有**冻结判据**（`hardTimeoutMs=5000` · `automaticRetry=0` · 引擎组），
   三者都属 **ADR-047 `D-31`** 的修订范围 ⇒ 须走 ADR（ADR-051 / ADR-053 一侧）；
   **不得**为了让门变绿而改它们。
```

## §6 回滚（不需要动代码、迁移或数据）

```text
· 只关"自动查"：删掉 `.env` 的 `CHARACTER_WEB_SEARCH_MODE=auto_public`（或改成 `explicit`）
· 关摘要：`CHARACTER_ROLLUP_TOKENS=0`（或删掉该行）
· 全部不联网：`CHARACTER_WEB_SEARCH_ENABLED=false`
改完重启 `pnpm chat` 生效。三条都只改 `.env`，**无代码变更、无数据变更**。
用户可见说明已同步：`docs/苏沐薇-使用说明.txt`（第七节改为两种情形 + 新增第八节讲摘要），
桌面投影由 `pnpm doc:sync` 生成，`pnpm doc:check` = 一致。
```
