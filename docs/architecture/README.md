# 架构文档索引

**当前判定**（2026-09-20，ADR-044）：**M5.1.1 Phase 4 = PASS；M5.1.1 Final = PASS；M5.1-D01 = CLOSED**。
Phase 1–3 = `PASS`（历史结论，`§0` 一字未改）；`4a` = `PASS`；`4b` = `PASS`（EXECUTED，verify 10/10）。
裁定载体：[`../adr/ADR-044-m5.1.1-phase4-closure.md`](../adr/ADR-044-m5.1.1-phase4-closure.md)（`ACCEPTED / EXECUTED`，
**状态修订**——ADR-043 的 `ACCEPTED / DESIGN FROZEN` 与它全部的设计决策**仍然有效**）。
机器判据：`pnpm m5.1.1:phase4:closure:verify`（= `pnpm m5.1.1:final:verify`）；
最终报告：[`../m5.1.1/M5.1.1-Phase4-Closure-Report.md`](../m5.1.1/M5.1.1-Phase4-Closure-Report.md)。
历史门 `pnpm m5.1.1:wp11:verify` 仍是 **Phase 1–3 的收官门**（不承担当前状态判定）；见
[`../m5.1.1/M5.1.1-Gate-Decision.md`](../m5.1.1/M5.1.1-Gate-Decision.md)（§12 是当前状态）与
[`../m5.1.1/M5.1.1-Phase1-3-Acceptance-Report.md`](../m5.1.1/M5.1.1-Phase1-3-Acceptance-Report.md)（§12 同上）。
**已冻结阶段**：M5.1 — Developer Plane & Observability Truth（`m5.1-complete`）；
此前 M5、M4.5、M4/M4.1 均已通过各自验收。
**仍未关闭**：`M511-G8`（Break-Glass）仍 `NOT RUN`；`DC-1`/`DC-2`/`DC-3` 与 `K-31` 仍 `DEFERRED / OPEN`。
**下一项**：M5.5（Web Search & External Evidence）**进行中**（2026-09-20 立项）：
provider = **P-2 / local SearXNG**（[`../adr/ADR-047-local-searxng-search-provider.md`](../adr/ADR-047-local-searxng-search-provider.md)；
ADR-045 的 Brave 与 ADR-046 的 Tavily（`SUPERSEDED / NEVER ACTIVATED`）保留为历史，正文不改写）；
WP2 外部证据契约与 WP3/WP4/WP5/WP6/WP7 **已接线**（能力追加登记 `web.search` · 意图检测器 ·
适配器 · `AdapterOutcome`/`ActionResult` 外部证据 · 账本只落引用 ·
`external-evidence` section（优先级 45、可裁）· `ContextBudget.externalEvidenceTokens` **缺省 0** ·
`external_evidence` trace step 记"实际入模" · 守卫链 **记忆 → 动作 → 外部证据** ·
回复**五态**（`D-17`）· 正文里所有自造 `[E<n>]` 一律**剥离** · 来源附录由**程序**按实际入模集合追加（`D-9`）·
开发者面**只**经既有注入点 `runtimeCapabilities` 上报可用性、`D-18②` 的"不改 `query-service.ts` 与 DTO 表"
按 `cfd9219` 逐字节机器核对（`D-8` 的引用隐私同样有哨兵级判据）），
**WP8 的四道门 + WP9 的 Live Smoke 已全部落地**（L1 `m5.5:test` 58/0 · L2 `m5.5:verify` 46/0 ·
L3 `m5.5:e2e:verify` 25/0 · **WP9 生产库副本 + 真模型 + 真 SearXNG `m5.5:smoke:live` 24/0** ·
`m5.5:gates` **Hard Gates PASS**）。
**生产激活已执行**（2026-09-20，载体 [`ADR-048`](../adr/ADR-048-m5.5-production-activation.md)，**只做状态修订**）：`.env` 追加 `CHARACTER_WEB_SEARCH_ENABLED=true`（代码默认值仍是 false）⇒ 真实聊天里出现**显式搜索词**时才会授权/构造适配器/传额度，**1 次出站**，`q` 会被转发给 `duckduckgo / wikipedia / wikidata`；回滚 = 改回 false。标签 `m5.5-complete` 已打；**合并 = 不适用**（直接提交在 `main` 上）。
⚠️ "本地"≠"不出站"：`q` 仍会被本机 SearXNG 转发给冻结的三个上游引擎。
执行计划 / 进度 / 影响面地图在
[`../m5.5/M5.5-Execution-Plan.md`](../m5.5/M5.5-Execution-Plan.md)（附录 D）与
[`../m5.5/M5.5-Affected-Surface-Map.md`](../m5.5/M5.5-Affected-Surface-Map.md)，且不得绕过
当前的认知资格与 Assistant Fact Firewall 边界。
⚠️ **关闭 D01 ≠ 她不会再说错**：`DR-11` 逐字——措辞层没有启发式守卫，机械保证只到
采信 / 排序 / prompt 标签。本次关闭买到的是**可查 / 可审计 / 可降档**。

---

## 一句话

> M3 让系统能可靠地区分**"苏沐薇是谁"、"真正发生了什么"、"谁说了什么"和
> "模型只是生成了什么"**。
>
> M3.5 保证这些区分**不会在进入 Lv3 时变成必须推翻的假设** ——
> 它只建插座，不买电器。
>
> M4 让"她记住了什么"第一次成为一件**可以被审计、回放、撤销**的事 ——
> 而它是第一个**自动写入**长期状态的里程碑，所以它同时也是
> 第一个"没人看着的写入路径"。

M3.5 的七条未来兼容性规则（FC-01 ~ FC-07）见
[`future-compatibility.md`](./future-compatibility.md)。
M4 的十五条记忆不变量（MI-01 ~ MI-15）见
[`memory-invariants.md`](./memory-invariants.md)。

---

## M4 的定位：第一个没人看着的写入路径

M4 **不负责让她更聪明**。它负责让"记住"这件事变成**可负责**的。

```text
显式路径（用户在等答复）        后台路径（没人在看）
  validate → commit → fold         job → 抽取 → 值闸 → 冲突 → 放行 → 提交
  ok:true 只在三步全成功          失败写进 job，水位不越过失败区间
```

两条路径共享同一个 validator 与 reducer，差异只在
"谁来提议"与"何时提交"。

⚠️ **但生产里只有显式路径**（M4 债 `D3` 的文档半边，2026-09-26 现状）：后台路径
**实现完整、测试齐全，生产代码里却没有任何地方调用它** —— `src/` 里没有任何文件
import `kernel/app/memory/job.ts`，开关 `CHARACTER_MEMORY_BACKGROUND_ENABLED`
只被 `flags.ts` 读进 flags 并打印、**没有消费者**（启动时如实告警）。所以上面这张图的
右半列是**尚未接线**的形状，不是"今天跑着两条路"。准确状态与逐条证据见
[`memory-lifecycle.md`](memory-lifecycle.md) §3；接线属于独立能力包（`TD-19`），
代码缺省保持 off。

> ⏩ **2026-10-07 裁定（用户）**：上面这段描述的是 **`job.ts` 那条 job 入口**；它现在的性质是
> **「被 `ADR-117`/`ADR-118` 取代（保留实现）」**（事实不变：import = 0、开关惰性、机器锁在）。
> **能力本身已由另一条路径交付**：`infrastructure/runtime/automatic-memory.ts` →
> `kernel/app/memory/pipeline.ts` + 水位，`.env` 已由 ADR-118 激活。
> ⇒ 读这一段时请把"后台路径"理解为"**那个 job 入口**"，而不是"自动记忆写入这件事还没做"。
> ⚠️ `TD-19` 本体（系统发起与后台路径的完整能力包）**不收窄、不销账**。详见登记册 §0y `R-70`。

M4 的三条硬约束（各自都有独立的机器证据）：

| 约束 | 为什么它是硬约束 |
|---|---|
| 记忆必须存在**证据**，权威由证据**推导** | 模型可以声称任何事，而它不会说"我不知道" |
| 旧事实**不物理覆盖** | 自动写入系统没有历史，就没有发现自身错误的手段 |
| 她的输出**不能**建立用户事实 | 后台写入没人看着，错误会在几十轮后才出现 |

M4 **不实现**召回（那是 M5）、不实现世界状态、不实现自动捕获的
外部后端（那是 Phase 11 的 PoC，且判据在 ADR-027）。

---

## M3.5 的定位：只建插座，不买电器

```text
不是 World          而是 World Boundary
不是 NPC            而是 Entity
不是 Action System  而是 Intent
不是 Simulation     而是 Time Slot
不是 Multi-Agent    而是 Perspective Owner
```

M3.5 **不实现**世界模拟、场景引擎、NPC 管理器、调度器、多角色运行时。
它只把 Kernel 的两端（输入 / 输出）与三个坐标（实体 / 时间 / 触发）
从"写死的假设"变成"显式的契约"。

---

## M3 的定位：Memory 之前的事实防火墙

M3 **不负责让她记住更多东西**。它负责保证未来产生的 Memory
是建立在正确历史之上的。

```
Assistant hallucination → Memory extractor → "长期事实"
   → 未来 Context → 模型更加相信 → 再次写入        ← 自我强化错误
```

阻断这条链的位置不在 M4，而在**写入事件的那一刻**。
因此 M3 只做来源、身份与完整性，不建 Memory（那是 M4）。

---

## 文档地图

### M5.1 新增（开发者平面 / OSS 审计 / E2E）

| 文档 | 回答什么问题 |
|---|---|
| [`../m5.1/M5.1-Execution-Plan.md`](../m5.1/M5.1-Execution-Plan.md) | ⭐ **M5.1 的计划权威源**：§1 用户原文（逐字：G-01~G-06 / WP0–WP9 / FINAL GATE MATRIX / STOP CONDITIONS）、§2 DSH 修订记录 R-1~R-7、§3 批次表（`1 DSH Execution = 1 Batch`）。**每次 execution 先读它的当前 WP 节** |
| [`../m5.1/M5.1-Repository-Map.md`](../m5.1/M5.1-Repository-Map.md) | **读 M5.1 代码先读这份**：WP0 侦察（组件＋行号、`src/` 目录形状）、**既有的 CLI 开发者平面 8 类入口**、"M5.1 接在哪里"、预留钩子、**F-1~F-11 实测发现**、D 系列、R-1~R-8、Scope Fence |
| [`../m5.1/M5.1-Authority-Map.md`](../m5.1/M5.1-Authority-Map.md) | **冻结的权威地图**：16 行 `Capability / Authority / Projection / Provider` ＋ **禁止方向**（G-02/G-03 的可检查形式）＋ 冻结声明 |
| [`../m5.1/WP0-Handoff.md`](../m5.1/WP0-Handoff.md) | WP0 → WP1 交接单（八字段）：F-1~F-11、R-1~R-7 的裁定、WP1 的八条前置（三个契约文件的落点、没有 `success: boolean`、`verification` 四态、key 级白名单不重复实现值级哨兵…） |
| [`../m5.1/WP1-Handoff.md`](../m5.1/WP1-Handoff.md) | WP1 → WP2 交接单：开发者平面契约暴露了哪些接口、三份契约各自"不许改"的是什么、WP2 必须做到哪八条（只读投影 / cursor 走既有索引 / `Mutation Count = 0` / 只读 HTTP 落点 …） |
| [`../m5.1/WP2-Handoff.md`](../m5.1/WP2-Handoff.md) | WP2 → WP3 交接单：只读查询面暴露了哪些接口、**门抓到的两个真实缺陷**（派生耗时被绕开 → 负数；未知查询参数静默通过）、执行账本无 cursor 的如实处理、WP3 必须做到哪七条（白名单 fail closed / 五档可区分 / `verified` 不由 `executed` 推导 / 前后快照 + 量具自检 …） |
| [`../m5.1/WP3-Handoff.md`](../m5.1/WP3-Handoff.md) | WP3 → WP4 交接单：控制面暴露了哪些接口、**契约补强**（`commandType` 放宽到 `string` —— 否则"有人试图执行 `RESET_KERNEL`"表达不出来）、四条已知局限（无持久账本 / 幂等是进程内 / AT3.4 不适用 / 审计分页）、WP4 必须做到哪五条（`developer_control` 阶段理由码已就是 `CONTROL_REASON_CODES`、`traceId` 恒缺省的边界要写进 ADR、泄漏扫描要扫**导出的负载** …） |
| [`../m5.1/WP4-Handoff.md`](../m5.1/WP4-Handoff.md) | WP4 → WP5 交接单：分类法映射暴露了哪些接口、**AT4.1 的实测发现**（既有导出路径发点号键、且**从来没过白名单** —— `error.message` 在今天的遥测里能合法出去）、四条已知局限（wire 键未统一 / 控制无持久 trace / 子阶段嵌套表达不出 / `error.message` 无界）、WP5 必须做到哪五条（只消费两个面 / 复用已有 guard / 极简静态 HTML / 删掉页面要能证明一切照常 …） |
| [`../m5.1/WP5-Handoff.md`](../m5.1/WP5-Handoff.md) | WP5 → WP6 交接单：页面暴露了哪些接口、**真的删了一次页面**的证据（其余 9 个端点逐字节不变）、三条已知局限（DOM 渲染无自动化覆盖 / 静态资产与 DTO 无编译期约束 / 每请求读文件）、WP6 必须做到哪四条（只出文档 / 照 `ADR-036` 与 `ADR-M4-MemOS` 的判据格式 / 不落代码 …） |
| [`../m5.1/M5.1-OSS-Audit.md`](../m5.1/M5.1-OSS-Audit.md) | **M5.1 OSS 集成审计**：方法与**证据强度**（仓库实测 / 一手文档 / 类别推断，分开标注）、五类候选的实测面与裁定汇总（12 行）、**Scope Fence**（本轮没有新增依赖 / 没有新增服务 / 没有实现 MCP Runtime）、每个候选的"下次准入判据" |
| [`../m5.1/WP6-Handoff.md`](../m5.1/WP6-Handoff.md) | WP6 → WP7 交接单：12 条裁定及其落点、四条已知局限（**没有一个第三方被真的部署过** / Graphiti 证据强度低 / Langfuse 语义映射表不存在 / 沙箱是类别级审计）、WP7 必须做到哪四条（汇总器只读已落盘证据 / 复用已有一半的四个负控 / **汇总器本身也要被验证**） |
| [`../m5.1/WP7-Handoff.md`](../m5.1/WP7-Handoff.md) | WP7 → WP8/WP9 交接单：五个检测器的三段式证据与 `gate-results.json` 的形状（`gates[]` / `spikes[]` / `finalGateMatrix` / **`claimDiscipline`**）、**AT6.1 的措辞纪律**（只许说"OTLP protocol compatibility verified; specific backend deployment not exercised"）、WP8/WP9 必须做到哪五条（Key 缺失 → Live Smoke 只能 not-run / 三行待产出要注册成门 / 副本禁 destructive / 三处投影互相对齐 / 任何既有 Hard Gate 退化 = FAIL） |
| [`../m5.1/WP8-Handoff.md`](../m5.1/WP8-Handoff.md) | WP8 → WP9 交接单：E1–E6 六段的证据形状、**E2 的三处投影互相对齐**（本 WP 的核心判据）、M51-G8/G9 两道新硬门的判据字段（`e2eVerdict` / `liveSmokeVerdict`）、**WP7 前提 1 的如实更正**（用户在执行期间给了 Key，所以 Live Smoke 真的跑了——不是把 not-run 改写成 PASS）、WP9 必须做到哪四条（只剩 Full Regression 一行待注册 / `pnpm m4.5:ci` 退出码 0 / 八份文档 / 历史证据还原） |
| [`../m5.1/M5.1-Architecture.md`](../m5.1/M5.1-Architecture.md) | **M5.1 架构**：四个平面的权威与"不许做的事"、AT3.6 五档阶梯（**HTTP 200 ≠ executed**）、AT4.4 Trace Truth、分类法的单一映射链、页面"删掉它"判据、**三条跨里程碑硬性质如何被保住**、证据等级链、Scope Fence |
| [`../m5.1/M5.1-Implementation-Report.md`](../m5.1/M5.1-Implementation-Report.md) | **实现报告**：按 WP 的交付清单、新增/改动文件（含行数）按平面归类、**冻结区核对（diff 全空）**、**门抓到的 7 个真实缺陷**（含汇总器首跑"九门全 not-run"为何是好事）、偏差记录 R-1/R-3/R-8/R-9 + 两条无原文的追加改动、零新增依赖 |
| [`../m5.1/M5.1-Test-Report.md`](../m5.1/M5.1-Test-Report.md) | **测试报告**：12 道门的断言数与证据文件、**量具自检**（含各门自己的正控/负控）、五个检测器三段式、**证据等级**（Level 1 + Level 2）、E2 三处投影对齐、泄漏门、全量回归、**没跑的东西如实列表** |
| [`../m5.1/M5.1-Known-Limitations.md`](../m5.1/M5.1-Known-Limitations.md) | **如实局限清单**：§1 M5.1 自己造成的 11 条（无持久账本 / AT3.4 不适用 / wire 键未统一 / DOM 无自动化覆盖 …）、§2 继承来的 4 条（**G-05 禁止本轮修**）、§3 证据强度的 6 条（**没有任何第三方被真的部署过**）、§4 明确**不是**缺陷的东西、§5 各自销账条件 |
| [`../m5.1/M5.1-Gate-Decision.md`](../m5.1/M5.1-Gate-Decision.md) | ⭐ **M5.1 最终判定书 = PASS**：FINAL GATE MATRIX 14 行逐行结论、**10/10 硬门 PASS · 0 FAIL · 0 not-run**、全量回归（`m4.5:ci` 退出码 0、26 门逐门 0 失败、`baselineAlreadyFailing.claimed = false`）、**AT6.1 的 claim + claimLimit 逐字措辞纪律**、WP7 前提 1 的如实更正、**STOP CONDITIONS 一条都没触发**、§10 "这个 PASS **不**主张什么"、§11 什么会改变判定 |
| [`../m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md`](../m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md) | ⚠️ **正式立案的架构级缺陷（`M5.1-D01` · Architectural Correctness · P1 · OPEN）**：账本能回答"她做了什么"，**不能**回答"谁触发 / 谁授权 / 谁执行 / 谁记录"。含**读 schema 实测的影响面审计**（`conversation_events.actor_type` 是*归属声明*不是*作者证明*；`character_action_events` 只有 `character_id`；控制面契约的 `requestedBy` 从未落进账本）、七个概念拆分（subject/initiator/actor/executor/authority/recordedBy/author）、`EventAttribution` 方向提案、迁移约束、6 类验收场景与 Hard Gate。**修复不在 M5.1**，须先出 schema proposal + migration strategy，**G5.1 Decision Freeze 前裁定** |

> M5.1 的证据落在 `artifacts/m5.1/`（复用既有 `artifacts/<里程碑>/` 约定）；
> `pnpm m5.1:*` 门脚本随 WP1 起逐步建立（WP0 刻意未改 `package.json`）。
> **已裁定**：仓库里**没有** HTTP/server 基础设施 → 开发者平面 = 仓库内最小只读 HTTP 服务
> （`node:http`，零新依赖，仅 loopback，dev-only 开关）；页面为极简静态 HTML。
> 文档落点是 `docs/m5.1/`（**不是**计划书原文写的 `docs/milestones/m5.1/`，见修订记录 R-1）。

### M5 新增（召回与上下文）

| 文档 | 回答什么问题 |
|---|---|
| [`../m5/M5-Acceptance-Report.md`](../m5/M5-Acceptance-Report.md) | ⭐ **M5 验收（结论 PASS）**：八份产物合一（实现 / 九道门 / 分层检索指标 / A–H NL E2E / Live Smoke / 全量回归 1155 项 0 失败 / 八条局限 / Gate Decision） |
| [`../m5/M5-问题说明.md`](../m5/M5-问题说明.md) | ⚠️ **读 M5 现状先读这份**：查出了什么问题（1 条 S3 + 3 条前提缺口）、严重到什么程度、**为什么现有门没抓到**、该做什么、我判断错了哪一条 |
| [`../m5/M5-Execution-Plan.md`](../m5/M5-Execution-Plan.md) | M5 的执行计划：`1 DSH Execution = 1 Work Package`，WP0–WP8 与 Gate 判据（**下次 execution 先读它**） |
| [`../m5/M5-Implementation-Map.md`](../m5/M5-Implementation-Map.md) | **读 M5 代码先读这份**：WP0 实现地图（组件 / 文件 / reuse-extend-untouched）、"M5 接在哪里"、P0 风险 R1–R8、Deferred Issues D-1–D-8 |
| [`../m5/WP0-Handoff.md`](../m5/WP0-Handoff.md) | WP0 → WP1 交接单（八字段：Changed / Tests / Evidence / Known issues / Interfaces / Do not modify / Prerequisites）＋ AT0.7 调查补遗 |
| [`../m5/WP1-Handoff.md`](../m5/WP1-Handoff.md) | WP1 → WP2 交接单：Recall 契约暴露了哪些接口、WP2 必须做到哪六条（状态判定只走 `exclusionReasonForStatus`、每条决策过 `assertRecallDecision`、保留位不许出场、`ORPHANED_EVIDENCE` 接 M5-PRE 探针…） |
| [`../m5/WP2-Handoff.md`](../m5/WP2-Handoff.md) | WP2 → WP3 交接单：P0 资格层暴露了哪些接口、实测泄漏计数（Hard Gate）、静态锁抓到过什么、WP3 必须做到哪五条（宽召回、如实填通道、`integrityOk` 只能来自 M5-PRE 探针…） |
| [`../m5/WP3-Handoff.md`](../m5/WP3-Handoff.md) | WP3 → WP4 交接单：检索端口/适配器/渲染暴露了哪些接口、为什么适配器**刻意不过滤**（零泄漏计数的可测性）、能力报告怎么用、WP4 必须做到哪七条（只排 eligible、component 带 `available`、分层 Gold Dataset…） |
| [`../m5/WP4-Handoff.md`](../m5/WP4-Handoff.md) | WP4 → WP5 交接单：排序器暴露了哪些接口、**相关性闸**（G3 裁定的机制落点）、实测 Gold Dataset 数字（含"95% 在 10 条数据集上等价于全中"的如实说明）、门里修掉的两处"绿得没有意义" |
| [`../m5/WP5-Handoff.md`](../m5/WP5-Handoff.md) | WP5 → WP6 交接单：预算抽象/六类计划/选择器暴露了哪些接口、**"估算的就是注入的"**（WP6 不许重渲染）、Hard Test 的 9 档数字、WP6 必须做到哪九条（注入 `blockText` 本身、空串产 0 section 保住 prompt 基线、开关 + 消费锁、注入负控…） |
| [`../m5/WP6-Handoff.md`](../m5/WP6-Handoff.md) | WP6 → WP7 交接单：运行时接线暴露了哪些接口、**已知边界**（没有意图分类器、词面桥粒度、合成轮次不召回）、WP7 必须做到哪六条（复用既有 trace、**Measurement Truth 判据必须是文本级**、隐私形态…） |
| [`../m5/WP7-Handoff.md`](../m5/WP7-Handoff.md) | WP7 → WP8 交接单：`RecallDecisionRecord` 与指标聚合、**"metrics = 事实 / budget = 意图"**（`selectedIds` 是实际进 packet 的）、WP8 的六条前置（真实文本进入、三样判据、G1/G2/G3 口径、Final Gate 顺序、八个最终产物） |
| [`../m5/WP8-Handoff.md`](../m5/WP8-Handoff.md) | WP8 → M5.5 交接单：A–H NL E2E 与 Live Smoke 各验证了哪一条、**八条已知局限**（无意图分类器 / 词面桥无停用词 / 无第三人 subject / D-9 / 旧探针口径 / 语义通道不可用 / 扫描 500 行上限 / 合成轮次不召回）、M5.5 的入口与不许碰的东西 |
| [`../m5/M5-问题说明.md`](../m5/M5-问题说明.md) §7.0 | 用户对 M5-PRE / G1 / G2 / G3 的四条裁定原文（改口径要先读它） |

> M5 的证据落在 `artifacts/m5/`（复用既有 `artifacts/<里程碑>/` 约定）；
> `pnpm m5:*` 门脚本随 WP1 起逐步建立（WP0 刻意未改 `package.json`）。
> **结论**：M5 = PASS（`pnpm m5:gates` → `hardGateVerdict = PASS`）。

### M4.5 新增（行动真相与可观测性）

| 文档 | 回答什么问题 |
|---|---|
| [`../m4.5/M4.5-Architecture.md`](../m4.5/M4.5-Architecture.md) | 行动架构冻结：五条边界、六个不变量、三层文件地图、后续计划模板（**读 M4.5 先读这份**） |
| [`../m4.5/M4.5-Action-Protocol.md`](../m4.5/M4.5-Action-Protocol.md) | 请求 / 目标 / 结果 / 失败语义 / 部分成功 / 幂等 的形状 |
| [`../m4.5/M4.5-Capability-Registry.md`](../m4.5/M4.5-Capability-Registry.md) | 能力为什么必须登记？首批三个能力是什么？新增一个能力要动哪几处？ |
| [`../m4.5/M4.5-Permission-Risk-Model.md`](../m4.5/M4.5-Permission-Risk-Model.md) | R0–R3、判定顺序、目标确定性闸、开关 |
| [`../m4.5/M4.5-Execution-Truth.md`](../m4.5/M4.5-Execution-Truth.md) | 她为什么不能宣称未发生的动作？两层保证与词表边界 |
| [`../m4.5/M4.5-Audit-Trace.md`](../m4.5/M4.5-Audit-Trace.md) | 账本事件流、traceId 贯穿、六条审计不变量、最小 Inspector |
| [`../m4.5/M4.5-Measurement-Invariants.md`](../m4.5/M4.5-Measurement-Invariants.md) | 量具自己也是被测对象：L0、正负双控、证据优先级 |
| [`../m4.5/M4.5-Acceptance-Report.md`](../m4.5/M4.5-Acceptance-Report.md) | M4.5 验收：G1–G15 / C1–C23 逐条与真实证据 |

> ADR-030 ~ ADR-035 是 M4.5 的六条架构决策（唯一执行入口、能力登记与边界、
> 目标确定性、执行真相、账本与记忆分离、量具可信）。

### M4 新增（可靠长期记忆）

| 文档 | 回答什么问题 |
|---|---|
| [`memory-invariants.md`](./memory-invariants.md) | MI-01 ~ MI-15：记忆系统不许破的 15 条规则，每条由哪个测试守着？（**读 M4 先读这份**） |

> M4 的其余文档是 **ADR**（见下方「评测与决策」）。
> 这不是偷懒：M4 的每一块（证据、owner/subject、类型、supersede、
> 显式路径、后台抽取、时间语义、后端边界）都是一次**决策**，
> 而不是一份概念说明 —— 写成 ADR 才能把"被否决的备选方案"
> 与"代价"一起留下来。

#### 工程计划书第 204 点名的 7 篇文档

M4 验收时这 7 篇**只有分散的内容、没有按名对应的文档** ——
那属于"非关键文档缺失"（附件的 CONDITIONAL PASS 可接受项），
但**验收要求把它补上**（用户 2026-09-17 裁定：修 1 与 3，跳过 2）。
现在它们都在：

| §204 点名的文档 | 回答什么 |
|---|---|
| [`memory-model.md`](./memory-model.md) | 记忆在领域里是什么形状？owner/subject/source、四种类型、三个指纹 |
| [`memory-lifecycle.md`](./memory-lifecycle.md) | 四个状态、六个领域事件、两条写入路径、崩溃窗口与补折叠 |
| [`memory-authority.md`](./memory-authority.md) | "谁说的"怎么表达？为什么她的输出**造不出**用户事实 |
| [`memory-provenance.md`](./memory-provenance.md) | 凭什么成立？根证据 vs 派生证据；§217 的八个问题怎么答 |
| [`memory-temporal-semantics.md`](./memory-temporal-semantics.md) | 四个时间；为什么 `validUntil` 必须**三态** |
| [`explicit-memory-operations.md`](./explicit-memory-operations.md) | 记住 / 纠正 / 忘掉；为什么必须在生成回复**之前**完成 |
| [`memory-backend-contract.md`](./memory-backend-contract.md) | 真源在哪、`MemoryStorePort`、备份恢复、外部后端门禁（含 MemOS 结论） |

每篇都指向它对应的 ADR、不变量与**守着它的测试** ——
不是概念复述，而是"要改这里时先看哪几条规则"的入口。

### M3.5 新增（未来兼容性）

| 文档 | 回答什么问题 |
|---|---|
| [`future-compatibility.md`](./future-compatibility.md) | FC-01 ~ FC-07 是什么？M4–M11 各受什么约束？ |
| [`entity-model.md`](./entity-model.md) | EntityRef 与 ActorRef 什么关系？为什么不是把所有 ID 都改成 EntityId？ |
| [`observation-intent-boundary.md`](./observation-intent-boundary.md) | Kernel 的输入/输出边界怎么划？Intent 与 Result 为什么必须分开？ |
| [`future-world-boundary.md`](./future-world-boundary.md) | 世界进来以后谁负责什么？（最短也最重要） |
| [`temporal-model.md`](./temporal-model.md) | 三种时间分别是什么？为什么现在就要加列？ |

### M3 新增（身份与完整性）

| 文档 | 回答什么问题 |
|---|---|
| [`identity-model.md`](./identity-model.md) | "谁是苏沐薇"由什么回答？四层身份怎么分开？ |
| [`seed-versioning.md`](./seed-versioning.md) | "她什么时候变的、为什么变"能不能被回答？ |
| [`conversation-integrity.md`](./conversation-integrity.md) | "谁说了什么、属于哪个会话"能不能被相信？ |
| [`source-provenance.md`](./source-provenance.md) | 这句话是哪一类内容？它能支持什么结论？ |
| [`assistant-fact-firewall.md`](./assistant-fact-firewall.md) | 她自己编的经历会不会变成她真实的过去？ |

### M2.5 已有（继续有效）

| 文档 | 回答什么问题 |
|---|---|
| [`character-kernel.md`](./character-kernel.md) | 谁是"她"的状态的拥有者？模块边界与依赖方向怎么划？ |
| [`event-model.md`](./event-model.md) | "发生了什么"与"她因此怎么变"为什么要分成两层？ |
| [`projection-model.md`](./projection-model.md) | 为什么 `trust=0.63` 不是真相？Replay 如何成立？ |
| [`context-compiler.md`](./context-compiler.md) | 她每一轮到底看到了什么？为什么只能有一个入口？ |
| [`processor-model.md`](./processor-model.md) | 谁有权解释事实？为什么它只能"提案"？ |
| [`tracing.md`](./tracing.md) | 刚才究竟发生了什么？为什么观测后端不是依赖？ |
| [`data-model.md`](./data-model.md) | 落地的表结构与关系 |
| [`invariants.md`](./invariants.md) | M1–M3.5 的 27 条不许破的规则 + 每条由哪个测试守着（M4 追加的 15 条在 `memory-invariants.md`）；末尾追加 **INV-CI-01 ~ 05（认知完整性）** |
| [`cognitive-integrity.md`](./cognitive-integrity.md) | 🔒 **认知完整性与受控注入原则**（2026-09-17 用户正式立案，**Sovereign Core 约束**）：22 节完整原则 + **No Cognitive State Without Provenance** + Cognitive Integrity Hard Gate（CI-1~10）+ 七个破坏性负控 + 五条冻结不变量（INV-CI-01~05）。**任何能改变长期认知的功能 = `Privileged Cognitive Operation`**，必须经本原则审查；不得被 Developer Console / CLI / Admin API / Plugin / MCP / Tool / Workflow / Database / 第三方后端绕过。合规现状见 [`../m5.1.1/M5.1.1-Cognitive-Integrity-Gap-Audit.md`](../m5.1.1/M5.1.1-Cognitive-Integrity-Gap-Audit.md) |

### 评测与决策

| 文档 | 内容 |
|---|---|
| [`../evaluation/identity-evaluation.md`](../evaluation/identity-evaluation.md) | 三层人格评测、PC/SA 为什么分开、匿名模式 |
| [`../evaluation/personality-drift.md`](../evaluation/personality-drift.md) | Drift / Perturbation / Recovery 的设计 |
| [`../adr/`](../adr/) | ADR-001 ~ **ADR-048**（M3.5 新增 013–019；M4 新增 020–029；M4.5 新增 030–035；**M5.1 新增 036 观测端口边界、037–041 OSS 集成边界**；**M5.1.1 新增 042 Attribution Model**（`ACCEPTED / DESIGN FROZEN`）与 **043 认知重新资格化**（`ACCEPTED / DESIGN FROZEN`）、**044 Phase 4 关闭**（`ACCEPTED / EXECUTED`，只做状态修订）；**M5.5 新增 045 外部证据边界**（`D-1`…`D-18`）、**046 Tavily**（`SUPERSEDED / NEVER ACTIVATED`，历史）、**047 本地 SearXNG**（`D-31`）、**048 生产激活**（`ACCEPTED / EXECUTED`，只做状态修订：ADR-047 的 `production_activation` → `ACTIVATED`）） |
| [`../research/concordia-notes.md`](../research/concordia-notes.md) | 从 Concordia 借了什么、明确没采用什么 |
| [`../research/ai-town-notes.md`](../research/ai-town-notes.md) | 从 AI Town 借了什么、明确没采用什么 |
| [`../m4/compatibility-audit.md`](../m4/compatibility-audit.md) | M4 WP1：审计哪些既有前提与 M4 不相容 |
| [`../m4/current-state.md`](../m4/current-state.md) | M4 开工时的现状盘点（WP1 交付物） |
| [`../m3.5/compatibility-audit.md`](../m3.5/compatibility-audit.md) | M3.5 WP1：审计哪些地方本来会堵死未来 |
| [`../m3/current-state.md`](../m3/current-state.md) | M3 开工时的现状盘点（WP1 交付物） |

### 里程碑验收

| 文档 | 内容 |
|---|---|
| [`../m5/M5-问题说明.md`](../m5/M5-问题说明.md) | ⚠️ **读 M5 现状先读这份**：WP0 之后查出的问题（1 条 S3 `--reset-kernel` 孤儿记忆 + 3 条前提缺口/边界：E2E 生日写不进库、第三人 subject 不存在、词面桥覆盖度）、为什么现有门没抓到（第四次同形状）、我判断错了哪一条、WP1/WP2 该定什么 |
| [`../m4/M4-问题说明.md`](../m4/M4-问题说明.md) | ⚠️ **读 M4 现状先读这份**：遇到什么问题（1 个 S1 + 2 个缺口）、严重到什么程度、为什么 939 项全绿也没抓到、该做什么 |
| [`../m4/M4.1-Correctness-Fix-Report.md`](../m4/M4.1-Correctness-Fix-Report.md) | **M4.1 修复 + 再验收报告**：D1 / D2-B 已修、D3 如实降级；四层测试结构、G1–G13、C1–C23 逐条 |
| [`../m4/M4-Acceptance-Report.md`](../m4/M4-Acceptance-Report.md) | **M4 验收（RC1）**：939 项全绿（但那**不足以**说明可用）、覆盖矩阵、结论 **FAIL** —— **已被 M4.1 修复，见上一条** |
| [`../m4/M4-Defect-D1-wrong-target-forget.md`](../m4/M4-Defect-D1-wrong-target-forget.md) | **D1 缺陷记录**：显式遗忘会撤销无关的正确记忆；复现 / 根因（`target-resolver.ts:340`）/ 为什么整套验收没抓到 |
| [`../m4/M4-Manual-Audit.md`](../m4/M4-Manual-Audit.md) | M4 人工审计（计划书第 217 节）：真实库 2 条 + 沙箱 35 条，37/37 × 8 问全部可答 |
| [`../m4/ADR-M4-MemOS.md`](../m4/ADR-M4-MemOS.md) | MemOS PoC 结论：**REJECT**（判据 = ADR-027 第 7 条） |
| [`../m4/memos-poc.md`](../m4/memos-poc.md) | MemOS 静态 PoC 的逐条证据（10 条判据） |
| [`../m4/M4-Technical-Debt.md`](../m4/M4-Technical-Debt.md) | M4 技术债：0 个 S0/S1/S2；5 个 S3 + 2 个 S4 |
| [`../milestones/M4-verification.md`](../milestones/M4-verification.md) | M4 **检查点报告**（历史）：实现过程、§5 缺陷复盘、§4 改动的既有测试 |
| [`../milestones/M3.5-verification.md`](../milestones/M3.5-verification.md) | M3.5 验收 |
| [`../milestones/M3-verification.md`](../milestones/M3-verification.md) | M3 验收 |
| [`../milestones/M2.5-verification.md`](../milestones/M2.5-verification.md) | M2.5 验收 |

---

## 代码地图

```
src/kernel/                    ← Character Domain ＋ Application
  contracts/                    领域类型与纯函数（不 import 任何框架）
    ids.ts                        基础 ID 与错误类型（M3.5 加 EntityId / ObservationId / IntentId）
    actor.ts                      M3：身份分层（ActorRef / RuntimeId / Participants）
    entity.ts                     M3.5：EntityRef / EntityKind / PerspectiveOwnerId
    observation.ts                M3.5：Observation / ConversationObservation
    intent.ts                     M3.5：CharacterIntent / SpeechIntent / CharacterOutput /
                                        IntentResolution / IntentResolver
    time.ts                       M3.5：EventTime（recordedAt / occurredAt / logicalTime）
    character-definition.ts       Seed v2 结构化定义 + 规范化 + 渲染 + 指纹材料
    identity-snapshot.ts          M3：IdentitySnapshot / SeedVersionRecord
    source-authority.ts           M3：SourceKind / SourceAuthority / Assistant Fact Firewall
    conversation-event.ts         事实账本事件（M3 加结构化 provenance；M3.5 加 occurredAt）
    conversation-integrity.ts     M3：序号 / actor / reply graph / 会话归属 四条规则
    ledger-port.ts                M3：ConversationLedgerPort（唯一写入契约）
    message-normalizer.ts         M3：任意 transport 形状 → 领域输入
    domain-event.ts               领域事件 + M3.5 的 DOMAIN_EVENT_SCOPE（角色内部 vs 世界）
    job.ts                        后台任务契约 + M3.5 的 TriggerKind
    context.ts                    ContextCompiler（唯一 Prompt 入口）+ M3.5 的 CharacterTurnContext
    trace.ts                      CharacterRunTrace（M3.5 加 observation/intent 语义槽与 3 个 step kind）
  identity/seed.ts               Seed 的内容定义与人设表
  policies/validator.ts          Proposal 的唯一放行口（失败关闭；M3.5 加 scope 校验）
  projections/diagnostic.ts      M2.5 的诊断投影
  context/sections.ts            context-compiler@1 与 @2 的装配
  app/                           装配层
    kernel.ts                      Kernel 组装（M3：身份服务 + 快照）
    identity-service.ts            M3：CharacterIdentityService / SeedAdminPath
    conversation-integrity-service.ts  M3：写入前置校验
    turn-gateway.ts                一轮交互的编排 + 11 步 run tree（M3.5 加 observation/intent）
    flags.ts                       功能开关

src/infrastructure/            ← 所有 SQL、HTTP、Runtime 适配都在这里
  persistence/                  仓储 + 唯一变更链 + Replay
    migrations.ts                  迁移 0001 / 0002 / 0003（M3）/ 0004（M3.5：四张表的未来位置）
    character-store.ts             Seed 的三道写闸 + 版本历史
    seed-hash.ts                   M3：sha256 指纹
    identity-store.ts              M3：用户身份 / transport 映射 / 会话身份
    ledger.ts                      M3：ConversationLedgerPort 的持久化实现
    conversation-store.ts          行级 SQL（append-only + 幂等；M3.5 加 occurred_at）
    event-store.ts                 领域事件写入 + 投影（M3.5 加 scope/occurred_at）
    trace-store.ts                 Trace 落库（M3 加身份列，M3.5 加感知/意图列）
  runtime/                      ElizaOS 适配（消息、状态、模型、Seed 投影）
    actor-resolver.ts              M3：transport 身份 → 稳定 UserId
    conversation-recorder.ts       真实消息 → ConversationEvent 的唯一入口
    conversation-intent-resolver.ts M3.5：SpeechIntent → assistant 事件（唯一的 IntentResolver）
    seed-projection.ts             Character → 领域 Seed
  telemetry/                    TelemetryPort + Phoenix(OTLP/protobuf) + Noop

evals/                         ← 行为回归与人格评测
  scenarios/                     M2.5 canonical 定义（SC-001 ~ SC-007）
  harness/                       内部场景执行器与跨场景不变量
  fixtures/m3.5/                 M3.5：prompt 基线（逐字节回归的判据）
  m3/                            M3 评测（12 个套件、36 条用例、126 条检查）
    suites/                        套件定义（canonical，唯一真相）
    runtime/                       评测宿主、引擎、端口、指标
    baseline.json                  实测 baseline（阈值由它决定）
  promptfoo/                     M2.5 的外层 Runner 配置
  m3/**/*.yaml                   M3 的外层 Runner 配置（生成物）

docs/                          ← 本目录 + ADR + 评测 + 里程碑报告
scripts/                       ← 可执行验收入口（见下表）
```

---

## 验收入口

### M5 门（离线、秒级、不需要 API Key）

| 命令 | 检查什么 |
|---|---|
| **`pnpm m5:test`**（新，WP1） | **M5 Recall 契约**：五个要求的契约形状、`RecallRequest` 构造与边界、序列化/反序列化往返、决策阶段自洽性、bundle 三条不变量、**拒绝死枚举值**（每个理由必须登记生产者；`DELETED` / `NOT_ACTIVE` 是保留位，运行期不许出场）、与 M4 `isRecallEligible` 逐状态一致、**隐私**（进 trace 的形态一个字的正文都不含）（30 项） |
| **`pnpm m5:verify`**（新，WP2） | **M5 Eligibility（P0 安全层）**：正向 5 例 + 负控 11 例（forgotten / 无 deleted 状态走 `ORPHANED_EVIDENCE` / superseded / wrong-user / wrong-namespace / 三种 invalid-target / 三条策略闸）、**768 例穷举矩阵零泄漏**、**量具自检**（注入泄漏后计数器必须响 —— INV-M45-06）、静态锁（状态判断只有一处）（26 项） |
| **`pnpm m5:retrieval:verify`**（新，WP3） | **M5 Retrieval Adapter**：混合 fixture 上证明**宽召回**（非法候选必须被取回来，否则零泄漏计数失去意义）；接 WP2 后非法候选各带精确理由消失；`integrityOk` 来自 M5-PRE 探针；能力报告如实标出 `semantic` 不可用；timeScope / memoryKinds 真的起作用；确定性顺序；**只读**（前后规范化快照哈希一致）（28 项） |
| **`pnpm m5:ranking:verify`**（新，WP4） | **M5 Ranking / Conflict / Dedup**：Relevant vs Distractor、稳定 tie-break、完全同内容去重、同槽位 current vs historical 冲突（`maxPerSlot`）、**相关性闸**（无词面/无目标指称 → 不选，含"关掉它会怎样"的对照实验）、`available: false` 如实标注、阈值可配置；**分层 Gold Dataset**（Supported-Domain Top-5 10/10 + 每条查询唯一词面命中的数据集自检）；**Coverage Boundary**（未登记 predicate 不得被强行选出来，但取值含查询词时命中合法）（27 项） |
| **`pnpm m5:budget:verify`**（新，WP5） | **M5 Context Selector & Budget**：预算抽象失败关闭（记忆+预留 > 总预算在装配期就炸）、六类计划（`external_evidence` 恒为 0、身份/当前输入不可裁）、确定性选择、**装不下写 `BUDGET_EXHAUSTED`**、**重复不浪费预算**（槽位指纹二次防线）、账目恒等式、**Hard Test：500 条候选 × 9 档预算全部满足 `used ≤ budget`**、真实链路截断、禁止靠模型窗口绕过（静态锁 + 行为对照）（32 项） |
| **`pnpm m5:runtime:verify`**（新，WP6） | **M5 Runtime 集成（走真实 TurnGateway）**：真实文本 → Recall → `memory-recall` section（kind `memory` / 优先级 40 / 可裁）；**空召回不产 section** 且与"没接端口"的 prompt 逐字节一致（FC-T08 不被破坏的机制）；开关真的被消费（同端口两个开关值两种结果）；**注入负控**（记忆里的"忽略以上所有指令"只出现在 memory 段，identity-core / integrity-rules 逐字节不变）；trace 的 `selectedMemoryIds` 首次被填、进 trace 的形态不含正文（27 项） |
| **`pnpm m5:trace:verify`**（新，WP7） | **M5 Trace / Audit / Measurement Truth**：`RecallDecisionRecord` 逐条完整（候选/决策/排除理由/分数明细/选中/预算/指标）、决策**覆盖每条候选恰好一次**、隐私两道（结构检查 + 用 fixture 真实正文搜记录与 trace 属性）、`memory_recall` step 的扁平指标、**量具必须会响**（抹掉记忆块后判据变 false）、**id 级判据不足以代替文本级**、**真实失配场景**（上下文预算极小时编译器整段丢掉记忆 → trace 如实报 `selectedMemoryIds = []` + `droppedByContextBudget` + 保留 `intendedSelectedIds`）、多轮指标聚合（33 项） |
| **`pnpm m5:e2e:verify`**（新，WP8） | **M5 自然语言 E2E（A–H）**：全部从真实文本进入真实 `TurnGateway`。A 正向召回（含新网关实例）/ B 忘掉 / C 取代 / D 跨用户 / E 目标不确定（G2 口径：管线级验证 `ambiguous`/`not_found` → 不选）/ F 干扰项 / G 无证据 / H 注入负控；判据是**文本级**（事实有没有到 prompt）+ 状态级（28 项） |
| **`pnpm m5:smoke:live`**（新，WP8，需 API Key） | **Production-copy Live Smoke（真实模型）**：生产库只复制、全部写在副本；每轮取 Level 1（她的原话）+ Level 2（副本 trace 的 `selected_memory_ids` 与 `memory_recall` step）（16 项）—— **M5 Hard Gate** |
| **`pnpm m5:gates`**（新，WP8） | M5 门结果汇总（**只读已落盘证据**；文件不存在 = not-run，不是 PASS）→ `artifacts/m5/gate-results.json` |
| `pnpm m4:memory-integrity:verify` | **M5-PRE**：见下（M4 门） |

### M5.1 门（离线、秒级、不需要 API Key）

| 命令 | 检查什么 |
|---|---|
| **`pnpm m5.1:test`**（新，WP1） | **M5.1 开发者平面契约**：① 字段接地（每个 DTO 键必须落到既有权威形状或显式派生清单 —— 造一个键就失败，且**量具自带负控**）② 序列化稳定（键序不变 + 规范 JSON 与摘要的**硬编码期望值**，已用独立实现复核）③ 失败关闭（缺字段 / 未知命令 / 禁止命令 / 越界 / 未知字段 / 坏 schemaVersion）④ **执行状态区分**（AT3.6 五档两两不同 + 九条违规组合负控 + **源码级静态锁：不许有 `success: boolean`**）⑤ **敏感字段负控**（正控 + 12 个敏感键名 + 反绕过 `api_key_id` + **抛错只报键名不回显取值**）⑥ 分类法完整性与无死值（每个阶段登记生产者、阶段理由码一律复用既有受控词汇）⑦ 零基础设施依赖静态锁（`import` 白名单只许有一个已交代的跨模块 import）（50 项） |
| `pnpm kernel:test` / `pnpm typecheck` | 三个新契约文件自动被**依赖方向静态锁**与**编译期字段接地证明**覆盖（见下） |
| **`pnpm m5.1:query:verify`**（新，WP2） | **M5.1 唯一只读查询面**：真实 loopback HTTP 打全 8 个端点；**AT2.7 Hard Test**（调用全部端点前后**整库逐字段快照必须相同** → `Query Mutation Count = 0`）＋ **量具自检**（故意写一次快照必须变）；memory 统计与**直接 SQL 计数**交叉一致；trace 的 `selectedMemoryIds` 与账本一致；执行 DTO 的 `attempted`/`executed` 与账本一致、`intent` 如实 `not_available`、`verification = not_attempted`；**隐私负控**（记忆正文与动作参数一个字都不出现在响应里）；四道闸（非 loopback 拒绝启动 / POST→405 / 未知路由→404 / 参数失败关闭）；静态锁（handler 层无 SQL、service 无写语句）（56 项） |
| **`pnpm m5.1:control:verify`**（新，WP3） | **M5.1 开发者控制面**：AT3.6 的**五档全部走真实 HTTP**（`rejected` / `accepted`(dryRun) / `attempted` / `executed`(核验失败) / `verified`），fingerprint **两两不同**、摘要逐档不同；**"HTTP 200 == executed"被证明为假**（accepted 与 verified 同为 200、attempted 失败也是 200、rejected 才是 400）；**WP3 HARD GATE**：9 张领域表前后逐字段相同 ＋ 5 项交叉核对零不一致；**量具自检**（伪造"重放却声称本次执行过"必须被报出）；AT3.3 幂等（重放不再调 handler、结论逐字相同、明确标出重放）；AT3.5 七个禁止命令逐个被拒；AT3.2 的 dryRun 不进入执行路径；隐私负控（命令参数 / 记忆正文）（41 项） |
| **`pnpm m5.1:observability:verify`**（新，WP4） | **M5.1 可观测性**：真实两轮（正常 + `tokenBudget:1` 让编译器整段丢掉记忆段）→ 规范 span；**AT4.4 Trace Truth**（`selected_memory_ids` 只取编译之后的现实；被丢掉的那条**不得**出现；理由码 `BUDGET_EXHAUSTED`）＋ **量具自检**（注入被丢掉的 id 必须被报出）；**AT4.5 Leakage = 0**（四个哨兵 × 6 份**导出的负载**，含 **protobuf 线上字节**）＋ 量具自检（塞进哨兵必须被找到）；AT4.2 分类法（真实一轮里零个未映射 step kind）；AT4.3 相关性（控制命令自成一棵单 span trace）；两条路径关键事实交叉核对 |
| **`pnpm m5.1:page:verify`**（新，WP5） | **M5.1 开发者页面**：AT5.7（零外部资源 / 无框架 / 无 `type="module"` / JS 过 `node --check`）；AT5.2–AT5.5（只消费 `/dev/query/*`，不碰 persistence）；AT5.6（不硬编码命令名、只有**一个** POST、页面信封实测被接受、未知命令仍 400）；**WP5 ACCEPTANCE：真的删一次 `page.html`** → `GET /` 404 而其余 9 个端点**逐字节不变**、还原后逐字相同；静态面证明 `page.html` 零 import 且只有一处引用 |
| **`pnpm m5.1:spike:otlp`**（新，WP6 / **spike 不是门**） | **AT6.1 最小 spike**：起一个**只认 OTLP 规范**的本地接收端（不认识 Phoenix、不认识我们），把**真实导出路径**指过去并逐字段验收（`POST /v1/traces` · `application/x-protobuf` · trace_id 16B / span_id 8B / `service.name` + `session.id` / `start_time_unix_nano`），protobuf 与 JSON 两种编码各一遍；**量具自检**（错 Content-Type → 415 · 截断 protobuf → 400）。它证明"发出去的是标准 OTLP"，**不**证明任何具体后端的面板效果（10 项断言，证据 `artifacts/m5.1/oss-spike-otlp.json`） |
| **`pnpm m5.1:measurement:verify`**（新，WP7） | **M5.1 量具与负控集中门**：五个检测器各走**三段式** —— 正控（合法输入 → 安静）· 负控（注入假象 → **必响**）· 恢复（放回真实现 → 重新安静）。五个注入：fake `selectedMemoryId` · fake `executed=true` · query-side mutation · secret in telemetry · unknown control command（后者还要求 handler **一次都不许跑**）（16 项） |
| **`pnpm m5.1:e2e:verify`**（新，WP8） | **M5.1 真实自然语言 E2E + 生产副本 Live Smoke**：E1 真实 prompt 组装 · **E2 三处投影互相对齐**（真实 packet 的 `sourceRefs` == trace 的 `selectedMemoryIds` == Query API 的 DTO，同一个 id —— 这是 M5 "Measurement Truth 判据必须是文本级"的延续）· E3 负控（陌生主语 → `selected = []`，不是"召回被关掉"）· E4 执行真相（参数只暴露 key 不暴露 value、`verification = not_attempted`）· E5 控制面走真实 HTTP 后 report 与 Query API 对得上 · E6 **生产副本**只读跑真实历史（`productionUntouched = true`，比对真实库 mtime 摘要）· E6-Live 在**副本**上打真实模型，trace 落盘可读（22 项，真实模型，**非干跑**） |
| **`pnpm m5.1:regression:verify`**（新，WP9） | **M5.1 全量回归证据**：**不重跑任何门**，只读 `pnpm m4.5:ci` 留下的原始日志（退出码 + 26 条逐门小结 + 3 条硬门，**按 BOM 探测 UTF-16LE**）与 `artifacts/m5.1/*.json` 里各门自己写的 verdict 字段，按**合取**给总判定；日志里出现 ❌ 或任何非零失败计数都会被抓出来；解析不到任何小结/硬门时**自报"判据失效"而不是 PASS** → `artifacts/m5.1/regression-evidence.json`（`regressionVerdict`） |
| **`pnpm m5.1:gates`**（新，WP7） | M5.1 门结果汇总（**只读已落盘证据**；文件不存在 = `not-run`，**不是** PASS）。十二道门（十道 M5.1 + M5/M4.5 两道继承）**其中硬门 10 道**（M51-G1 与 M51-G6 按计划书不是硬门）+ 一条 **spike 单列（不参与总判定）** + `finalGateMatrix`（计划书 14 行 → 每行由谁回答）+ **`claimDiscipline`**；三项量具自检：缺证据 → `not-run`、**缺一道硬门会把总判定降级为 FAIL**、spike 不算门且每条必须有 `claimLimit` → `artifacts/m5.1/gate-results.json` |

### M4.5 门（离线、秒级、不需要 API Key）

| 命令 | 检查什么 |
|---|---|
| `pnpm m4.5:test` | **M4.5** L1 部件：协议 / 登记 / 策略 / 目标梯子 / 守卫 / 幂等 / 折叠 / **静态锁**（135 项） |
| `pnpm m4.5:verify` | **M4.5** L2 子系统：Request → Policy → Gateway → Executor → Result → Ledger，**正负双控**（53 项） |
| **`pnpm m4.5:measurement:verify`**（新） | **L0 量具验证**：七种终态逐 id 精确过滤 + 未知状态必须报错（38 项）—— **G12 Hard Gate** |
| **`pnpm m4.5:nl-action:verify`**（新） | **L3 自然语言集成**：只从用户真实文本进入（禁止传 actionId）（32 项）—— **G13 Hard Gate** |
| `pnpm m4.5:audit` | 人工审计语料：七问逐条可答 + 审计不变量（12 项） |
| `pnpm m4.5:gates` | 门结果汇总（**只读已落盘证据**；文件不存在 = not-run，不是 PASS） |
| `pnpm m4.5:ci` | `pnpm m4:ci` + 上面全部 + 门汇总（**M4.5 的完整离线门**） |
| **`pnpm m4.5:smoke:live`**（新，需 API Key） | **Production-copy Live Smoke（L4）**：生产库只复制、沙箱指向临时目录，真实模型 + 真实文件 + 真实回复（50 项）—— **G14 Hard Gate** |
| `pnpm m4.5:ci:full` | 离线门 + Live Smoke |

排查入口（只读）：`pnpm action:list [--status <状态>]` / `action:show <id>` /
`action:trace <traceId>` / `action:audit`。

### M4 门（离线、秒级、不需要 API Key）

| 命令 | 检查什么 |
|---|---|
| `pnpm m4:test` | **M4** 领域模型：证据 / 权威 / 幂等 / 值闸 / 冲突 / 意图 / 目标解析 / 水位 / Trace / Admin CLI / **生产装配接线**（**228 项 / 35 分组**；含"补折叠调用必须接在进入对话之前、且在全部只读分支之后"的回归锁） |
| `pnpm m4:verify` | **M4** 持久化：迁移 0005、状态转移、乐观锁、重放 `A == B`、索引、审计探针、显式路径、后台流水线、冲突处置（**142 项 / 18 节**，全部跑在**实验库**上） |
| **`pnpm m4:memory-integrity:verify`**（新，M5-PRE） | **Memory 状态完整性**：`--reset-kernel` 之后不许留下"ACTIVE 但不可 replay / 证据指向已删事件"的孤儿。判据 = `liveEvidenceCountAfterReset` + **事件流维度**（丢过任何一条自有事件即整条清）；含**量具负控**（旧探针 `unsupportedMemories` 看不见悬空，新探针必须看见）（28 项） |
| `pnpm m4:faults` | **M4** 故障注入矩阵：部分写入回滚 / 折叠失败不污染重放 / 读失败不得伪装成"0 条"（15 项） |
| `pnpm m4:restart:verify` | **M4-014** 跨进程重启持久化：两个真子进程共享磁盘目录（16 项） |
| **`pnpm m4:isolation:verify`**（新） | **M4** 隔离：owner 闸（必须是 character）+ **subject 级隔离** —— 同文本不同人必须是两个槽位、跨 subject 修订/遗忘不得互相干扰（22 项） |
| **`pnpm m4:restore:verify`**（新） | **M4** 备份/恢复：全新目录恢复后 `CanonicalSemanticSnapshot` SHA256 一致 + 计数逐项一致 + 恢复库仍自洽 + 可继续写入；**含两条负控**（24 项） |
| `pnpm eval:m4` | **M4** 场景套件：M4-008 ~ M4-018 + **M4-001~018 的覆盖映射表**（17 项） |
| `pnpm m4:backup:verify` | 迁移前的备份**可读性**验证（8 项） |
| `pnpm m4:real-db:verify` | **真库验收**：四张新表 / 17 条索引（含部分唯一索引的**谓词**）/ 既有数据未动（**30 项**，**只读**） |
| `pnpm eval:m4:extraction` | **M4** 抽取评测 · 离线档：注入 / 意图规则 / 解析器（3 条，确定性） |
| `pnpm eval:m4:promptfoo` | **M4** Promptfoo 离线档（3 配置）+ **断言自检**（断言 × 8 配置 × 5 个坏世界） |
| **`pnpm m4:scale:verify`**（新，慢档） | **M4** 规模：1,000 次混合操作 → 1,060 事件 / 790 记忆，replay 全绿、不变量全绿、重复未膨胀（11 项；**不设 SLA**） |
| **`pnpm m4:hardkill:verify`**（新，慢档） | **M4** 强制终止 + **启动补折叠**：真实 `taskkill /F` 杀掉写入中的子进程 → 库可打开、无半条 revision；另**确定性注入**一条"只提交不折叠"的事件，由生产恢复函数 `recoverMemoryProjections()` 补上（20 项，含幂等负控与空转负控） |
| **`pnpm m4:audit`**（新） | **M4** 人工审计语料：沙箱造 35 条覆盖四态/10 槽位/三种认识状态，用**生产同一套**渲染器输出 8 问清单（10 项） |
| **`pnpm m4:mutation-safety:verify`**（M4.1 新） | **Mutation State Safety**：D1 的 reproduction + 状态级回归。**每条用例一个干净库**；判据是**库快照哈希 + 事件计数前后相等**（不是"函数返回了什么"）；**禁止传 memoryId**，只从用户文本进入（20 项） |
| **`pnpm m4:nl-mutation:verify`**（M4.1 新） | **自然语言集成覆盖（Layer C）**：文本 → 意图 → 抽取 → 目标解析 → 服务 → 事件 → 投影，7 个场景 17 项。**G12 Hard Gate** |
| **`pnpm m4:smoke:live`**（新，需 API Key） | **Production-copy Live Smoke（Layer D）**：把生产库**复制**一份，在副本上跑真实多轮，并对**每一轮**同时断言"库变了没有 / 她说了什么 / 两者是否一致"。**它抓到了 D1**；M4.1 起升为 **G13 Hard Gate** |
| **`pnpm m4:ci`** | **M3.5 的完整离线门 + M4 各套测试（含隔离 / 恢复 / 变异安全 / 自然语言集成）+ Promptfoo 离线档与断言自检**。M4.1 实测退出码 0 |
| `pnpm m4:ci:full` | 再加上真实模型档（抽取评测 + Promptfoo），**需要 `OPENAI_API_KEY`** |

> ⚠️ `m4:verify` 永远跑在**实验库**上，真实库一个字节都不动。
> 需要真库数据的只有 `pnpm memory:*`（迁移之后）。

### M3.5 门（离线、秒级、不需要 API Key）

| 命令 | 检查什么 |
|---|---|
| `pnpm m3.5:test` | **M3.5** FC-T01 ~ T08：实体 / 观测 / 意图 / Intent≠Result / 视角 / 时间 / 触发 / **prompt 逐字节回归**（30 项） |
| `pnpm m3.5:verify` | **M3.5** 迁移 0004、时间列往返、trigger_kind、trace 语义槽、**append-only 未被侵蚀**（**31 项** —— M4 加入迁移 0005 后由 30 改为 31，见 `milestones/M4-verification.md` §4.1） |
| `pnpm m3.5:baseline` | 重新固化 prompt 基线（**只在有意修改 prompt 时运行**） |
| `pnpm m3.5:baseline:check` | 只比对 prompt 基线，不写入 |
| **`pnpm m3.5:ci`** | **M3 的完整离线门 + M3.5 两套新测试** |
| `pnpm m3.5:ci:full` | 再加上两套 Promptfoo |

### M3 门（离线、秒级、不需要 API Key）

| 命令 | 检查什么 |
|---|---|
| `pnpm typecheck` | 类型与依赖方向（`evals/`、`scripts/` 也在检查范围内） |
| `pnpm kernel:test` | M2.5 领域契约（26 项，含依赖方向静态检查） |
| `pnpm kernel:test:identity` | **M3** Seed Schema / 指纹 / 渲染 / 快照 / 修改规程（25 项） |
| `pnpm kernel:test:conversation` | **M3** 来源隔离 / 序号 / 会话归属 / reply graph / 归一化（47 项） |
| `pnpm kernel:verify` | M2.5 Phase C：迁移、Seed 版本、序号并发、append-only |
| `pnpm m3:verify` | **M3** 持久化：写闸、Seed 历史、provenance 落库、身份表、账本端口、**运行期强制**、**迁移路径**（67 项） |
| `pnpm m3:seed-check` | **M3** Seed 自检：结构 + 与上次记录的指纹比对（防"改了内容没升版本"） |
| `pnpm eval:scenarios` | M2.5 行为回归 SC-001 ~ SC-007 |
| `pnpm eval:m3` | **M3** 评测离线档（20 条用例 / 105 条确定性检查 + 硬零指标） |
| `pnpm eval:telemetry` | 编码、HTTP 边界、离线韧性、Noop 等价（54 项） |
| `pnpm eval:otlp` | **官方 OTLP schema** 校验手写编码器（21 项） |
| `pnpm eval:dryrun` | 干跑静默性（15 项） |
| `pnpm eval:providers` | Provider 白名单（11 项） |
| **`pnpm m3:ci`** | **上面这些串起来跑 —— M3 的完整离线门** |
| `pnpm m3:ci:full` | 再加上两套 Promptfoo（M2.5 的 7 个 + M3 的 12 个套件） |

### 需要真实模型 / 观测后端

| 命令 | 检查什么 |
|---|---|
| `pnpm eval:m3:live` | **M3** 人格档：PC / SA / Drift / Recovery / trait alignment（16 条用例 / 21 条 judge 检查） |
| `pnpm eval:m3:live --runs 3 --write-baseline` | 建立 baseline（计划书第 120 节要求 3–5 次） |
| `pnpm eval:real` | M2.5 真实模型行为 smoke |
| `pnpm test` | M1/M2 原有的 45 项集成验收 |
| `pnpm m3:phoenix` | **M3** Phoenix 回查：run tree 逐节点可见（M3.5 起为 11 步）+ 身份属性 + 后端离线韧性 |
| `PHOENIX_RUN_LIVE=1 pnpm eval:telemetry` | 真实 Phoenix 收下、可回查、JSON 被拒（58 项） |
| `pnpm eval:phoenix-chat` | 真实对话 → Phoenix 端到端（7 项） |
| `pnpm eval:m4:extraction:live` | **M4** 抽取评测 · 真实模型档（**14 条**用例；**空过的绿会单列**，不混进"通过"—— 2026-09-17 实测 14/14，其中 3 条空过） |
| `pnpm eval:m4:promptfoo:live` | **M4** Promptfoo 真实模型档（5 配置；2026-09-17 实测 5/5 全绿） |

需要真实观测后端时先 `pnpm phoenix:up`。

### 排查入口（全部只读）

| 命令 | 看什么 |
|---|---|
| `pnpm seed-status` | **M3** Seed 版本 / 指纹 / 历史 / 与代码的比对 |
| `pnpm kernel:status` | 身份快照 + 事实账本 + 投影 + 最近 trace（含八步 run tree） |
| `pnpm dump:prompt` | 她这一轮真正看到的完整 prompt |
| `pnpm memory:stats` | **M4** 记忆统计（"目标为 0"的项会显式标出目标值） |
| `pnpm memory:list` | **M4** 记忆列表（计划书第 135 节要求的字段） |
| `pnpm memory:get <id>` | **M4** 单条记忆详情（`validUntil` 三态可区分） |
| `pnpm memory:sources <id>` | **M4** 溯源：这条记忆根据哪几轮对话建立 |
| `pnpm memory:history <id>` | **M4** 同一槽位的取值演变 |
| `pnpm memory:audit` | **M4** 审计清单（计划书第 217 节的八个问题） |
| `pnpm memory:replay [--all]` | **M4** 重跑折叠（验证 `A == B`） |
| `pnpm memory:retract <id>` | **M4** 撤销一条记忆（**不动**会话事件） |
| `tsx scripts/diag-m4-explicit.ts "记住，……"` | **M4** 显式路径诊断：意图判定 / 内容抽取各自是否成功（离线，不连库） |
| `tsx scripts/diag-m3-coverage.ts` | M3 两档评测各覆盖了哪些用例 |
| `tsx scripts/diag-m3-judge.ts <caseId>` | 实际发给 judge 的 prompt 与模型原始回复 |
| `tsx scripts/diag-phoenix-spans.ts` | Phoenix 里实际存了哪些 span 与属性名 |

前面这些离线项全部 deterministic、秒级 —— 这是"每次改动都能跑"的前提。

