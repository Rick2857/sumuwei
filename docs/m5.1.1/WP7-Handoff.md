# WP7 Handoff — Developer Console / Attribution Diagnostics

> ## 状态（**必须按字面读**）
>
> ```text
> WP7                                             = **PASS**
> WP7 专项门（pnpm m5.1.1:wp7:verify）             = **PASS（38 通过 / 0 失败）**
>   AT-W7-1  三态 + 第四态（无信封）两两可区分       ✅ 渲染**输出**级（真实页面 + 桩 DOM/fetch）
>   AT-W7-2  attribution origin 原样渲染             ✅ 无 origin promotion（MIGRATED_LEGACY 不升格）
>   AT-W7-3  Axis B 三列独立 + UNCONFIRMED_ORIGIN    ✅ 明确标注"来源未确立"，不得读作用户本人的话
>   AT-W7-4  unknown count（K-30 裁定）              ✅ 两个字段；与**独立从物理列数出来**的值相等
>   AT-W7-5  Trace attribution panel                 ✅ 归因来自 input_event_id 关联的那条对话事件
>   AT-W7-6  Execution attribution panel             ✅ Axis B = NOT_APPLICABLE；Execution Truth 单独显示
>   AT-W7-7  D01 / K-27 呈现                         ✅ SERVICE/agent-runner 原样；任何面都不出现 USER 位次
>   AT-W7-8  Query-only 边界                         ✅ 静态（零 import/SQL/DB/文件）+ 动态（跑完整套后六表字节等价）
>   AT-W7-9  Developer Control 原样                  ✅ 命令来自响应（不硬编码）；单 POST；未知命令 400
>   AT-W7-10 删页面性质（Hard Gate）                 ✅ 200 → 404（说明原因）→ 其余端点逐字不变 → 恢复逐字相同
>   AT-W7-11 专项门                                  ✅ pnpm m5.1.1:wp7:verify（38/0，正控/负控/恢复）
>   AT-W7-12 回归矩阵                                ✅ 18 条命令全 exit 0
>   AT-W7-13 证据                                    ✅ wp7-console.json / wp7-rendering.json /
>                                                       wp7-delete-page.json + 19 条日志 + exits + 还原白名单
>   AT-W7-14 本文件                                  ✅
>   ⇒ **WP8 未开始**（执行计划明令：不得在同一次 execution 开始 WP8）
> ```
>
> **K-30 = CLOSED**（用户 2026-09-18 裁定：`unknownSlotCount` + `recordsWithUnknownCount`，见 R-32）。
> **K-29 / K-17 classification drift 仍 OPEN**（都不在 WP7 范围内）。
> **没有动真实库**（只读 mtime）· **没有 schema 变更**（v7 / v8 指纹逐字未变，无 v9）·
> **认知面一个字都没碰**（Fact Firewall / canSupportExternalFact / MemoryAuthority / extractor /
> Recall / ADR-043 / Phase 4 / Developer Control U-03）。
> **没有加**：归因过滤器（U-10 仍 DEFER）/ 归因索引 / telemetry 导出 / trace 上的第二份归因。
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-31 / R-32**、
> [`M5.1.1-WP7-Compatible-Assertion-Record.md`](./M5.1.1-WP7-Compatible-Assertion-Record.md)、
> `artifacts/m5.1.1/wp7-console.json`。
> **不要重新探索仓库。**

```text
Completed WP: WP7 — Developer Console / Attribution Diagnostics

Changed Files:
  src/infrastructure/dev/page.html                      （改：+ 唯一一套 attribution 渲染器
                                                          renderAttributionValue / renderAttributionOrigin /
                                                          renderAxisB / renderCounts / attributionCard；
                                                          Trace 与 Execution 面板共用）
  src/kernel/contracts/developer-query.ts               （改：+ DeveloperAttributionCountsDto /
                                                          attributionCountsOf / ATTRIBUTION_COUNTED_SLOTS /
                                                          DeveloperTraceListDto / counts 字段 + 派生登记；
                                                          assertDeveloperExecutionDetail 增计数不变量）
  src/infrastructure/dev/query-service.ts               （改：列表面与详情面计算 counts）
  scripts/dev-page-harness.ts                           （新增：桩 DOM + 桩 fetch 驱动**真实页面**；
                                                          fireFirst / flushPage 供点击穿透）
  scripts/verify-m5.1.1-wp7-console.ts                  （新增：WP7 专项门，38/0）
  scripts/verify-m5.1.1-wp7-preflight.ts                （新增：只读预研 —— AT-W0 基线 + K-30 判定 +
                                                          AT-W7-11 预研；44/0）
  scripts/kernel-tests-dev-plane.ts                     （改：+ K-30 计数口径测试（52 → 53）+ 键清单同步）
  package.json                                          （改：+ m5.1.1:wp7:preflight / m5.1.1:wp7:verify）
  docs/m5.1.1/M5.1.1-WP7-Unknown-Count-Narrow-Decision.md （新增：K-30 登记与裁定，STATUS = CLOSED）
  docs/m5.1.1/M5.1.1-WP7-Compatible-Assertion-Record.md   （新增：本 WP 对继承判据/契约的改动逐条留痕）
  docs/m5.1.1/WP7-Handoff.md                              （本文件）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                    （改：R-31 / R-32 + WP7 章节闭包）
  artifacts/m5.1.1/wp7-*                                  （证据，见下）

Tests Run（18 条命令全 exit 0；逐条见 wp7-gate-exits.txt）:
  pnpm m5.1.1:wp7:verify            → 0（**38 / 0**；本 WP 专项门）
  pnpm typecheck                    → 0
  pnpm kernel:test                  → 0（26 / 0）
  pnpm kernel:test:conversation     → 0（47 / 0）
  pnpm m5.1:test                    → 0（**53 / 0**；52 → 53：新增 K-30 计数口径测试）
  pnpm m5.1:query:verify            → 0（56 / 0）
  pnpm m5.1:control:verify          → 0（41 / 0）
  pnpm m5.1:observability:verify    → 0（27 / 0）
  pnpm m5.1:page:verify             → 0（27 / 0；**页面已改**仍全绿）
  pnpm m5.1:measurement:verify      → 0（16 / 0）
  pnpm m5.1.1:test                  → 0（42 / 0）
  pnpm m5.1.1:k25:verify            → 0（22 / 0）
  pnpm m5.1.1:wp4:verify            → 0（48 / 0）
  pnpm m5.1.1:wp4.1:verify          → 0（43 / 0）
  pnpm m5.1.1:wp5:verify            → 0（58 / 0）
  pnpm m5.1.1:wp5.1:verify          → 0（33 / 0）
  pnpm m5.1.1:wp6:verify            → 0（51 / 0）
  pnpm m5.1.1:wp6.1:verify          → 0（115 / 0）

Tests Passed: 38 · 26 · 47 · 53 · 56 · 41 · 27 · 27 · 16 · 42 · 22 · 48 · 43 · 58 · 33 · 51 · 115
Tests Failed: 0
Tests Not Run（**理由明确**）:
  · m4.5:ci / m4.5:ci:full —— 会重写 m4/m4.1/m4.5 历史证据；执行计划 AT-W7-12 明说留给 WP10
  · m4.5:smoke:live / m5:smoke:live —— 需要 OPENAI_API_KEY
  · m4.5:test / m4:test / m4.5:nl-action:verify —— 本 WP **没有**改 runtime / action / CLI 语义；
    改动面由 AT-W7-0 的**允许面**断言钉住（仅 page.html + query-service + developer-query 契约）
  · m5.1:gates / m5.1:regression:verify —— 读 m4.5:ci 的日志
  · m5.1.1:wp3:verify / k16 / k17 / k19 / k20 —— 与本 WP 无关
  · m5.1.1:prod-copy:verify —— 无 schema 变更
  · 真实库 data/pglite 的任何 apply/update（未打开）
  · WP8 · Phase 4 / ADR-043 · 里程碑标签（需要批准）

Evidence Produced:
  artifacts/m5.1.1/wp7-console.json        —— 专项门完整机读事实（query-only 静态 / 渲染输出 /
                                             计数 vs 物理列 / 控制面 / 删页面 / 只读前后快照 / 检测器）
  artifacts/m5.1.1/wp7-rendering.json      —— 渲染词汇表与计数那一段
  artifacts/m5.1.1/wp7-delete-page.json    —— 可移除投影那一段（删页面性质 + 只读）
  artifacts/m5.1.1/wp7-preflight.json · wp7-at-w7-0-baseline.json · wp7-unknown-count-unit.json
  artifacts/m5.1.1/wp7-*.log（19 份）· wp7-gate-exits.txt · wp7-restore-whitelist.txt
  artifacts/m5.1.1/wp7-wp1-contracts.json 等 18 份 fork（矩阵重写的历史证据的**本次**读数）

Commit Hash: （见本文件末尾的提交清单；最后一次 docs 整理提交本身不列）

真实库未动（mtime 证据）:
  data/pglite 最新写入时间 = **2026-09-17 23:51:40**；`data/**` 被 gitignore ⇒ 只认 mtime（AGENTS §7）。
  专项门里记录了它（`scope.liveDbOpened = false`）。
```

---------------------------------------------------------------------------
 AT-W7-* 逐条
---------------------------------------------------------------------------
```text
AT-W7-0  Baseline / Scope Freeze = PASS
  三个展示面文件的 sha256 / v7·v8 指纹逐字未变 / 无 v9 / 真实库 mtime / 上游 WP6.1 = PASS
  ⇒ 开工后"src 干净"必然为假，改为**允许面**断言：自基线 commit 3ccbf9f 起 src/ 的 diff
     必须 ⊆ {page.html, query-service.ts, developer-query.ts}（改到别的 src 文件就红）
AT-W7-1  唯一 UI renderer = PASS
  四态输出：`USER/u-1` · `来源未确立（历史未记录）` · `来源未确定（运行时无法解析）` · `不适用`
  第四态：`未记录归因（Legacy Event）`（且**一个槽位行都不渲染**）
  禁止的渲染逐条断言：Unknown 不得是空 / `-` / null；Absent 不得说成未知；无信封不得说成 Absent
  只有一套：`attributionCard` 1 定义 + 2 调用（Trace / Execution）
AT-W7-2  origin = PASS：RECORDED / MIGRATED_LEGACY 原样；无信封不升格；页面不做 promotion
AT-W7-3  Axis B = PASS：三列独立渲染；UNCONFIRMED_ORIGIN 明确"来源未确立"；
         D01 硬夹具（user_statement + UNCONFIRMED_ORIGIN ×2 + actor=SERVICE）合法且一致
AT-W7-4  unknown count = PASS（K-30 裁定落地）
         `unknownSlotCount`（U-1）+ `recordsWithUnknownCount`（U-2）；范围 = 当前结果集；
         计入 UNKNOWN（含 MIGRATED_LEGACY 的 LEGACY_UNRECORDED）；不计 KNOWN / ABSENT /
         无信封 / Axis B；`0` 显式出现（含空结果集 —— 这里修掉过一个真缺陷）
         证明方式：DTO 的计数 vs **独立 SQL** 从物理三态列数出来的值（6 槽位 / 1 条记录），
         不是"再跑一次同一个函数"
AT-W7-5  Trace panel = PASS：归因来自 input_event_id 关联的对话事件（trace 表零归因列）
AT-W7-6  Execution panel = PASS：Axis B = NOT_APPLICABLE；Execution Truth 与归因**分开**；
         计数在无信封的 action 上也显式给 0
AT-W7-7  D01 / K-27 呈现 = PASS：执行侧与对话侧都不渲染 USER 位次；
         `requestedByKind=user` 的兼容字段不影响权威面
AT-W7-8  Query-only = PASS：静态（零 import / 零外部资源 / 无框架 / 单 POST / 无 persistence·SQL·DB·fs）
         + 动态（跑完整套查询面后六张权威表逐字节等价，mutation = 0）
AT-W7-9  Developer Control = PASS：命令列表来自 GET /dev/query/control/commands（页面无硬编码命令名）；
         单 POST；未知命令 400（fail closed）
AT-W7-10 删页面性质 = PASS（Hard Gate）：`GET /` 200（含渲染器）→ 移走 page.html ⇒ 404 +
         `developer_page_missing` 且 6 个 /dev/query 端点**逐字不变** → 放回 ⇒ 页面与端点逐字回原样
AT-W7-11 专项门 = PASS：`pnpm m5.1.1:wp7:verify`（38/0；正控 / 负控 / 恢复；measurementInvalid = 0）
AT-W7-12 回归矩阵 = PASS：18 条命令全 exit 0（继承门通过数逐门相同，唯一 +1 是新增测试）
AT-W7-13 证据 = PASS（见上；含历史证据 fork/还原白名单与 git blob id 对照）
AT-W7-14 本文件 = PASS
```

---------------------------------------------------------------------------
 本步**不主张**什么（先说清，免得被读大）
---------------------------------------------------------------------------
```text
1. **没有验证模型那一跳**：本门不调模型。它验的是"响应里的归因 DTO 被正确、无歧义地渲染"。
2. **没有动真实库**：真实库的**既有行**仍是 legacy（无信封）⇒ 在页面里会显示
   `未记录归因（Legacy Event）`。**新行**才会是 RECORDED（WP6.1 已证明生产链会写）。
   第一次带接线的真实对话之后，同一个页面会同时展示两类行 —— 这正是它要表达的。
3. **计数只对"携带归因的响应"**：执行**列表面**刻意没有计数（WP6-4 让它不携带归因），
   页面按"这个响应不携带归因 ⇒ 没有计数"如实渲染 —— 那不是"0 个未知"，门里对这一点有断言。
4. **页面不解释、不推导**：任何 `actor_type` / `requestedBy` / family → 权威槽位的推导都不存在
   （门里对"页面没有 `.filter(UNKNOWN)`、没有从 actor_type 推 actor"有断言）。
5. **本 WP 的 §1b/§2 证据是"渲染输出"级的**：桩 DOM + 桩 fetch 驱动真实页面。
   它证明的是**渲染分支真的会执行**，不是"源码里存在某段文案"。
```

---------------------------------------------------------------------------
 Next WP Preconditions（K-29 与 WP8；**不要在本 execution 开始**）
---------------------------------------------------------------------------
```text
WP8（Attribution Measurement & Gate Harness）的入口条件已经齐了：
  □ 生产侧真的会产生 RECORDED 归因（WP6.1 / K-28 CLOSED）
  □ 展示面把三态 + origin + Axis B + 两个计数**无歧义**地呈现（本 WP）
  □ 一条可复用的页面渲染 harness（scripts/dev-page-harness.ts）—— 断言发生在**渲染输出**上
  □ 计数语义只有一处实现（contracts 的 attributionCountsOf），门用独立 SQL 复核过它
顺序：**WP7 PASS → K-29 Necessity Enforcement Closure → WP8**。
WP8 的**第一件事**是修 **K-17 classification drift**（其分类表停在 WP2.2，5 个 WP4–WP6 门脚本未登记），
再做完整的 Attribution Gate Harness。仍**不得**在同一次 execution 里开始 WP8。
```

---------------------------------------------------------------------------
 Commit Hash
---------------------------------------------------------------------------
```text
3ccbf9f  （WP6.1 收尾 —— WP7 的基线 commit，AT-W7-0 的 diff 起点）
7b2d57e  （docs：K-30 CLOSED 的裁定落地 + R-32）
0ae2eb5  （test：页面渲染 harness 与它的三段式证明）
029aec3  （feat：K-30 计数的数据面）
1a376b7  （test：修正一次 git add -A 带进提交的历史证据）
570964a  （feat：Console 的归因渲染器 + 两个面板）
07a9267  （test：pnpm m5.1.1:wp7:verify 专项门）
（本文件与退出码/证据整理为最后一次 docs 提交 —— 该提交本身不列在此）
```

---

## 更正（2026-09-19，WP8-C1 / K-32 —— **不改写上面的原文**）

上面 `1a376b7` 那行写的"修正一次 `git add -A` 带进提交的历史证据"，**只成立一半**。
WP8-C1 实测更正如下：

```text
1a376b7 做的事：把本次读数 fork 到 wp7-*，再把工作树 `git checkout --` 到**当时的 HEAD**。
               但当时 HEAD 里那两条 `artifacts/m5.1/` 路径**已经是污染内容**
               （污染由 `029aec3` 的 `git add -A` 带进 HEAD）
               ⇒ 它还原的是"工作树 == 已污染的 HEAD"，
                 **没有**还原到原始 frozen M5.1 blob。

实测（内容只取自 immutable 标签 `m5.1-complete`）：
  artifacts/m5.1/wp1-contracts.json          polluted(HEAD) 9e8a293b… → frozen(tag) e390b5fb…
  artifacts/m5.1/query-negative-control.json polluted(HEAD) d4c3511e… → frozen(tag) 134310c5…

真正按 immutable 标签完成的还原发生在 **WP8-C1**（提交 504ecc1），
并有门 `pnpm m5.1.1:wp8c1:verify`（15 通过 / 0 失败）逐字节断言
`工作树 blob == 索引 blob == HEAD blob == m5.1-complete:<path>`。
同一更正也写进 `M5.1.1-WP7-Compatible-Assertion-Record.md` §6 与
`artifacts/m5.1.1/wp7-restore-whitelist.txt` 末尾的更正块。
```
