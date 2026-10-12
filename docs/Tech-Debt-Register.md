# 技术债登记册（Tech Debt Register）

> ⏩ **2026-10-05 执行入口（最新）**：见 **§0t（第二十批）** —— 按审计 §5 的建议次序**先做**了「证据/调度可信化三件」
> （`AUD-20261005-01/02/03` ⇒ `R-63～R-66`；载体 [证据选档与发射面修复](post-lv2/Evidence-Selection-Repair-2026-10-05.md)）。
> ⚠️ **`m10:gates` 的 3 道门现在如实报 `INVALID`（归属不明）** —— 那是**新增的诚实读数**，不是把门弄红了
> （旧绿建立在一次未受控的 mtime 选档上；实测旧实现选中的档**连最新 head 都不是**）。
> **B 组（S8 真实入口）见 §0u**：设计**已裁定**（`R-1b/R-2a/R-3b/R-4c`），草案 premise 有一处**如实更正**
> （**不需要新表、不需要迁移授权**），**实现尚未开始**。
>
> **2026-10-05 当前复审入口**：先读 [技术债复审与影响审计](Tech-Debt-Audit-2026-10-05.md) 与本册 **§0s / R-54～R-62**。本轮补接取消序号、目标期限/并行、经历语义召回、OCR、角色工具、语音与 M11.1 局部交付；新增三项证据/回归维护发现。当前 `summaries-all` **13 PASS / 8 FAIL**，失败原因分列，**不是八个生产模块都失效**。§7 及各批次的“当前”按其日期读取；旧 FAIL、用户风险接受、NOT RUN 不回写。
>
> **2026-10-03 Lv2 风险接受修订**：用户「接受以上风险，批准 Lv2 放行」，已执行 **Lv2 = PASS（已知风险接受放行）**，见[ADR-090](adr/ADR-090-lv2-risk-acceptance-release.md)。M9/M11.1 剩余验收及 R1–R5 保持 OPEN / DEFERRED AFTER RELEASE，不再作为本次 Lv2 或 Lv2.5–4.5 的前置阻断；不作已修复销账。当前待办与证据范围见[放行后待办](lv2/Lv2-Deferred-After-Release-2026-10-03.md)，原各行按其历史候选保留。
>
> ⏩ **2026-10-04 补录**：见 **§0p（第十六批）** —— 「接收停摆」自查 + 七个里程碑（M9.5 / M9.6 / M9.7 后续 / M11 / M11.1 / Lv2 / post-Lv2·S8）的当前读数收进总册 + 新立案 **`L-S8-30`** + **覆盖率读数缺口**（`content-rules@6` 之后 `memory-coverage:verify` 未重跑）。

> **编制日期**：2026-09-26（技术债清偿会话；用户指令「1，2，3 按序解决 + 剩余整理成正式登记文档」）。
> **前置登记表**：[`docs/m6.1/M6.1-and-Later-Technical-Debt-Plan.md`](m6.1/M6.1-and-Later-Technical-Debt-Plan.md)（2026-09-22，`PROPOSED SCHEDULE`）。
> 本登记册**不回写**前置表与任何里程碑冻结文档（TD-16 三列纪律）；它只做两件事：
> ① 复核每条的**当前状态**（哪些已销账、哪些仍开放、触发条件是否已到）；② 登记本轮新发现。
> **纪律**：登记 ≠ 关闭；每条写清「边界在哪、证据是什么、触发条件是什么」；已解决项只主张它关闭的那个点，不外推。
> **维护约定**：后续里程碑接收某条时，仍按前置表 §5 的格式（`TD-id → 正式问题编号 → 所属 WP → 前置条件 → 验收材料 → 状态 → runId → 剩余限制`）在其执行计划里销账，并回本登记册更新对应行的状态。

---

## 0. 本轮（2026-09-26）已解决项

### R-01 · 提交树完整性（**本轮新发现**，任何旧表都未登记）✅ 已修复

- **问题**：HEAD 的 `src/main.ts`（已提交）import `guard-timers.ts`，`package.json`（已提交）定义 `fast` / `gates:run` / `gates:verify` / `cli:exit:verify` 脚本——而这些**文件全部未跟踪**。任何人在 main / `m7-complete` 检出的树无法编译、快车道全部失效。
- **根因**：INC-01 防复发会话（2026-09-21/22）只提交了共享文件的改动（被 M6.1/M7 的里程碑提交整文件带入），属于该会话「领土」的**新文件**因混合树纪律从未入库。
- **修复**（4 个提交，全部只含 INC-01/M6.5 会话的成果，M8 在途文件零触碰）：
  - `5607b44` `fix(runtime)` 落地 `guard-timers.ts`（补齐断链 import）；
  - `93abd26` `feat(gates)` 落地门执行器（`scripts/gates-run.ts` + `scripts/gates/` + 两个 verify 脚本 + `inc-01-regression.ts` 修订 + `.gitignore` + AGENTS.md 该会话文档 hunk + INC-01 计划书 §13/§14）；
  - `0ec6ac5` `docs` 落地 M6.5 计划 + ADR-051（`NOT APPROVED`，被已提交的 ADR-052/053 引用，落地消除悬空引用）+ README/m6 计划的 M6.5 登记；
  - `31897f0` `chore(evidence)` 落地 Tavily 时代的搜索证据读数（m5.5 smoke X 段翻绿 + component/measurement 的 HTTP-429 新负控 + m5 wp5 复跑读数）；其余 18 个纯复跑噪声 artifacts 按白名单纪律还原。
- **验证**：`pnpm gates:run --lane summaries` = **7/7 PASS**（还原后复跑，无门被翻转）；改动前后 `m4:test` 基线全绿；独立 worktree 在提交树上的 typecheck（见 R-01 验证记录）。
- **剩余限制（不外推）**：`m7-complete` 标签与 `a820808` 历史提交仍缺这些文件——**标签不改写**；读取规则：`m7-complete` 之后以最新 `main` 为准（与 M8 计划 §1.3 对 `m7-complete` 指向 `c8afc59` 的既有处理同构）。

### R-02 · TD-13：搜索判定超时文案三重漂移 ✅ 已修复（`79e3088`）

- **问题**：`CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS` 的三处文本互相矛盾且都错——`flags.ts` 常量块注释写 15000（中间裁定态）、`warnFlag` 写「1000..10000」、`main.ts` 开发者面报错也写「1000..10000」，而常量是 `MIN=1000 / MAX=25_000 / DEFAULT=25_000`（M5.5.1 收口裁定）。
- **修复**：三处对齐常量并**改为插值**（`${SEARCH_JUDGE_TIMEOUT_MIN_MS}..${SEARCH_JUDGE_TIMEOUT_MAX_MS}`，以后不会再漂）；注释补记「判定调用预算与 provider 出站硬超时（ADR-054：15000ms）是不同层，不得混用」。
- **前置表预期窗口**：「下一次有意修改 flags 的工作包」——M7 已动过 `src/**`，M5.5.1 §10 的冻结理由失效，本轮修复合法。
- **验证**：typecheck EXIT 0 · `m4:test` 258/0 · `m4.5:test` 135/0。
- **剩余限制**：`flags.ts` / `main.ts` 同时是 M8 会话在途写域——已用 blob 管道提交（提交树 = HEAD+修复，不含 M8 hunks），工作树文件同步打了同样修复（M8 后续整文件提交会自然携带）。

### R-03 · M4 S4-1：`memory:audit` 把 retracted 一律渲染成「用户要求忘掉」 ✅ 已修复（`8e84aa1`）

- **问题**：真库那条因 **D1 缺陷修复**被撤回的记录在审计清单里显示为「已撤回（用户要求忘掉）」——审计者会误以为存在一次用户 forget 请求。`MEMORY_RETRACTED.payload.reason` 本有三分（`explicit_forget` / `explicit_correction` / `audit`，治理语义各不同）。
- **修复**：`renderMemoryAudit` 增加可选 `retractReasons` 映射；**未知原因如实写「原因未提供」并指向 `memory:history` / `memory:sources`，不再冒充**；`main.ts` 的 `memory:audit` CLI 与 `scripts/m4-audit.ts` 都从领域事件流（`domainEventsForMemory`）取 reason 填充；`kernel-tests-memory.ts` 加三个正控（每个 reason 一个）+ 一个负控（无原因不得断言 forget）。
- **验证**：typecheck EXIT 0 · `m4:test` 258/0（含新断言）· `m4:verify` 142/0 · `m4:mutation-safety:verify` 20/0 · `m4:nl-mutation:verify` 38/0 · `eval:m4` 17/0 · `m4.5:test` 135/0。
- **剩余限制**：只修**渲染与接线**，不触碰任何冻结的 Memory Kernel 语义；显示层修复不改变库里任何事件。

### R-04 · L-M61-12：AGENTS.md 状态行滞后 ✅ 已修复（同批提交）

- **问题**：AGENTS.md 停在 2026-09-22（M6/M5.5.1）；M6.1 PASS、M7 收口 + 生产激活（ADR-065）、TD-06 长形销账、M8 立项全部未写。M6.1 判定 §4 明文「未授权因此未做」。
- **修复**：追加 M6.1 / M7 / M8 三个状态块（含 G1 = PARTIAL 的澄清：AGENTS 里「AWAITING HUMAN REVIEW」是更早历史读数）+「下一步先读」补 M7 之后指针 + §4 表挂本登记册。

### R-05 · m6 聚合门「当前 NOT PASS」描述过时 ✅ 已修复（同批提交）

- **问题**：AGENTS.md 写「当前聚合门 Hard Gates = NOT PASS（duckduckgo 超时）」——provider 已换代 Tavily（ADR-054），实测已回绿。
- **修复**：按 TD-16 纪律在原段后追加「2026-09-26 修订读数」注记（`m6:gates` = PASS，实测命令与证据来源），**不回写**历史红段。
- **验证**：`pnpm gates:run --lane summaries` 实测 7/7 PASS。

### R-06 · L-M61-15：m6.1 wp0 基线在混合树上 PARTIAL ✅ **已关闭**（2026-09-27 · R-14 + R-17）

- **本轮执行**：INC-01 成果落地后重跑 `pnpm m6.1:wp0:baseline`（runId `m6.1-wp0-20260926-31897f0ebaf7-0e83`，`--supersedes m6.1-wp0-20260922-595e2f49ab32-816d`）。
- **读数**：verdict = **PARTIAL**，但构成已换——`sourceTree stability=unchanged · explained=0 · unexpected=0`（捕获窗口内零意外写入）；真实库摘要 `f65531b1322f340c…` 与历次读数一致；**INC-01 路径的 unknown 归零**（全部提交或归 other-task）；剩余 24 个 unknown **全部是 M8 在途文件**（`src/kernel/contracts/affect.ts`、`flags.ts`、`domain-event.ts`、`main.ts` 的 M8 hunks 等——不在基线工具的归属清单里）。
- **结论**：L-M61-15 的处置「INC-01 落定后重跑」已执行且达成其直接目的（并发噪声消除）；但 `computeVerdict` 的判据（unknownDirtyPaths > 0 ⇒ PARTIAL）决定**最终 BASELINE CAPTURED 只能在 M8 落地后的干净树上取得**。顺延登记，不算关闭。
- ✅ **2026-09-27 关闭**：M8 已落地、`docs/m9/` 已如实归属（R-14）⇒ 干净树上 wp0 = `BASELINE CAPTURED`
  （`m6.1-wp0-20260927-9864a0e6206f-cc35`），且 `m6.1:gates` = **4/4 接受 · overall = PASS**（R-17）。
  **本条不再顺延**。

---

## 0b. 第二批（2026-09-26）：**零 M8 风险**技术债清偿

> 用户指令：「先做第一批零 M8 风险（TD-15 → L-M61-14 → L-M61-06 → L-M61-07 → M4 D3 文档半边 →
> L-M61-08/09 → §6 非破坏性卫生）」。
> 「零 M8 风险」的判据是**两件事同时成立**：① 改动面不与 M8 领土重叠（不碰 `src/**` 的 M8 在途文件、
> 不碰 `package.json` 的 M8 hunks）；② 修法**不改任何已收口的判定语义**，因此不需要新的实测轮次。
> 复核后 **L-M61-07 不满足 ②**（改判定器输入面），**L-M61-06 / L-M61-07 的量具修订本体不满足 ②** ⇒
> 它们只做「上锁 / 前置条件写清」，本体留到量具修订那一批。逐条如下。

### R-07 · TD-15：wp6b 旧 scope 缺失警告 + 「39/32」注释漂移 ✅ 已修复（`42cbc3e`）

- **问题 A（旧 scope 缺失警告）**：`artifacts/m6/m6-wp6b-20260922-866f2fba5f27/restart-recovery.json` 的 payload 里
  `scope` / `counters` / `checks`+`totals` **一个都没有**，于是 `m6:gates` 的 `validateRollupEvidence`
  每次都对它报 `⚠️ rollup_scope_missing` —— 这是**真信息**（那份 payload 确实说不清自己的测量范围），
  但它让汇总门长期带着一条无法消除的噪声。
- **修复 A**：`scripts/verify-m6-wp6b.ts` 的 payload 增加**如实的** `scope` 段
  （`drillDirectories` 是一次性 `mkdtemp`、`opensIsolatedDatabases: true`、`opensProductionDatabase: false`、
  `readsProductionDbTreeDigestOnly: true`、`callsModel: false`、`runsSearch: false`、`headSemantics`）。
  **历史 JSON 按 TD-16 纪律不回写**（旧 run 仍然如实报缺 scope，读数只在**新** run 上翻面）。
- **问题 B（39/32 漂移）**：`verify-m6-wp10a-final-offline.ts` 的注释与门标签写「计划书 §10.1 的 39 条命令」，
  而同一文件里的 `PLAN_10_1` 数组实测只有 **32** 条 —— 数字与清单**互不相同**，且两边都是写死的。
- **修复 B**：报告标题改为从清单本身生成（`${PLAN_10_1.length}` 条），`scripts/m6-evidence.ts` 里那道门的
  标签去掉写死条数（单一来源 = `PLAN_10_1`），文档注释写明「条数不写死」并记录 2026-09-26 的核计值 = 32。
- **验证（三段式可读）**：
  - 修前：`m6:gates` 输出带 `⚠️ rollup_scope_missing`（对象 = 旧的 wp6b run）；
  - 修后重跑：`pnpm exec tsx scripts/verify-m6-wp6b.ts` → **PASS 15/0**（子门 6 条全 EXIT 0），
    新 runId `m6-wp6b-20260926-cd610e730148`，`head = cd610e730148`，证据里 `scope` 段在位（已逐字读出）；
  - `pnpm m6:gates` → **必选门 17 个 · 未运行 0 个 · 未通过 0 个 · Hard Gates = PASS**，
    且 `⚠️ rollup_scope_missing` **不再出现**（唯一残留的 ⚠️ 是「本命令不跑测试」的固定声明）。
- **剩余限制**：旧 run 的 JSON 仍缺 scope（**故意**，防篡改边界）；`m6:gates` 只看每份 schema 的最新
  `generatedAt`，所以下一次 wp6b 重跑才会把它彻底挤出窗口——当前已是新 run 在位。

### R-08 · L-M61-14：m6.1 标准清单的运行器漂移 ✅ **发射侧已修**（`930c82f` + `8deeb4a`；聚合绿**已于 2026-09-27 取得**，见 R-17）

- **问题**：`m6.1:gates` 只接受字段齐全的 `m6.1-manifest@1`（M6 通用 16 + M6.1 追加 6 = **22** 个），
  而三个标准 schema 运行器（`m6.1-live-short` / `m6.1-baseline` / `m6.1-wp3-judge`）只写了**子集**
  —— 它们产出的新读数在聚合器眼里**等于不存在**（旧 run 顶替）。`m6.1-live-short` 还多写了一个
  与契约字段**同名不同义**的 `runRelevantTreeSha256`（运行器自有的续跑指纹）。
- **修复**：
  - 新增 `scripts/m6.1-run-manifest.ts#standardManifestFields()`：git 身份（`codeCommit`/`head`/`branch`）、
    源码树摘要（`runRelevantTreeSha` + **定义字符串**）、`workingTreeExceptions`、`commands`、
    `toolVersions`、`fixtureRubricThresholdHashes`、`nonSecretConfigFingerprint`（**只记存在与长度，取值一个都不进证据**）、
    `sandboxIdentity`、`exclusions`、`contractVersion`/`corpusVersion`/`instrumentVersion`、`supersedes`。
    **一处实现，三个运行器展开同一份**（TD-15 的教训同型：别再让三处各自漂移）。
  - 写侧**失败关闭**：`assertStandardManifestComplete()` 由 `writeManifestAtomic()` 调用，
    **只对 `m6.1-manifest@1` 生效**（`m6.1-live-long.ts` 的 `m6.1-long-manifest@1` 是另一套形状，故意豁免）；
    缺字段 ⇒ **拒绝落盘**，不留半份契约清单。读侧 `validateM6_1Manifest()` 照旧只**报告**问题（历史清单不回写）。
  - `m6.1-live-short` 不再把自有的 `runRelevantTreeSha256` 写进清单（两个名字指同一件事会被读错）。
- **为什么失败关闭而不是「写下去再说」**：缺字段的读数在聚合器眼里等于不存在，而它看起来又是一份完整证据
  ——「看起来有、其实读不进来」正是本登记册反复登记的那类缺陷。宁可运行器收尾时响亮失败。
- **三段式（`scripts/kernel-tests-m6.1.ts`，`pnpm m6.1:test` 313/0）**：
  - 正控：`standardManifestFields()` 装配的清单 ⇒ `validateM6_1Manifest` **0 问题** 且**可落盘**、`readManifest` 判 COMPLETE；
  - 负控：**逐个**删掉全部 22 个必填字段（含 `payloadSha256`）⇒ 写侧必须抛 `ManifestIncompleteError`、
    读侧必须报 `manifest_missing_field`，**22/22 命中**；
    （踩过的坑：负控基线若先删字段再 `sealManifest()`，`payloadSha256` 会被重新算出来 ⇒ 那一格永远测不到；
    改为对**已封**清单删字段、不再封。）
  - 负控（反向保护）：`m6.1-long-manifest@1` 缺字段仍照常落盘（闸没有越界管别人的形状）；
  - 恢复：重新写完整清单 ⇒ 又安静。
- **另一个方向的核对（防「修好三个、弄坏另外三个」）**：另外三个标准 schema 写者
  （`m6.1-wp0-baseline` / `m6.1-wp1-corpus` / `m6.1-instrument-live`）在引入闸之前就已是全字段；
  已逐名字核对 22 个字段（`payloadSha256` 由 `sealManifest()` 补，不字面出现）**无缺**。
- **剩余限制（不外推）**：**`m6.1:gates` 仍然不是 PASS** —— 旧 run 不回写，要绿只能出**新** run，
  而新 run 又撞上 `L-M61-15`（M8 在途混合树 ⇒ wp0 基线必然 PARTIAL）。本次买到的是
  「下一次重跑会**自动**产出全字段清单，而不是再漂一次」。
- ✅ **2026-09-27 修订（R-17）**：新 run 已出，**`m6.1:gates` = 4/4 接受 · overall = PASS**（EXIT 0）。
  上面这条"剩余限制"描述的窗口**已结束**：`L-M61-15`（R-14/R-06）也已关闭。

### R-09 · L-M61-06：要点匹配措辞缺口 ✅ **边界已上锁**（本体留待量具修订 v3）

- **复核结论**：这条的处置原文是「下次量具修订一并处理；按『量具措辞缺口』单列」——
  **「单列」这一半已经在 `docs/m6.1/M6.1-Known-Limitations.md` §3 落地**（不是本轮欠账）；
  欠的是「一并处理」，而处理它 = 一次**量具修订 v3**（改判据 + 重新出读数），不是缩进批次能做的。
- **本轮做的（只做安全的那一半）**：在 `pnpm m6.1:test` 加一条**边界钉**——
  `pointMatchesReply('不吃辣', '我回避辣。') === false` 且反向亦然，并断言 `M6_1_POINT_MATCH_VERSION === 2`。
  于是「近义改写被当成命中」只能是**有意**的量具修订结果（改锁 + 升版本 + 改 Known-Limitations），
  **不可能**被顺手加一张同义词表悄悄放松（抽取审计那边已明文拒过同一件事）。
- **为什么不现在就修**：v2 的两个窄等价模式是从**实测假阴性**里推出来的（有引文级留痕）；
  在没有新的实测样本前加同义词/改写规则 = 凭空发明判据，与 `DR-11`「措辞层没有启发式守卫」的既有立场冲突。

### R-10 · M4 D3：后台记忆抽取 NOT-WIRED 的**文档半边** ✅ 已修复（`cd610e7`）

- **问题**：M4 债表的原话是「要么补接线，要么把开关标成尚未接线并**从文档里去掉『两条路径』的说法**」。
  接线归 TD-19；文档侧此前只做了一半——`docs/architecture/memory-lifecycle.md` §3 早已如实标注
  （「两条写入路径 —— 但生产里只有一条」），但**活文档 `docs/architecture/README.md` 仍把两条路画成对等的一对**
  （`显式路径 … / 后台路径 …` + 「两条路径共享同一个 validator 与 reducer」），读起来像生产里跑着两条路。
- **修复**：在 `docs/architecture/README.md` 那段**追加现状注**（不回写原图）：后台路径实现完整、测试齐全，
  但 `src/` 无文件 import `kernel/app/memory/job.ts`；`CHARACTER_MEMORY_BACKGROUND_ENABLED`
  只被 `flags.ts` 读进并打印、**没有消费者**；右半列是**尚未接线**的形状。指向 `memory-lifecycle.md` §3。
- **纪律**：只改**活文档**；`docs/m4/M4-Technical-Debt.md:73` 与 `docs/m4/M4-问题说明.md:247` 是冻结历史，一字未动。

### R-11 · L-M61-08 / L-M61-09：**登记纠正**（处置已落地，无需动作）· L-M61-07：前置条件已写清（本轮不做）

- **L-M61-08（断言式否认的标签语义）**：登记册 §5 写的处置是「人审时看原文；『alert ≠ 她编造』」——
  这句话**已经在 `docs/m6.1/M6.1-Known-Limitations.md` §3 写着**（含 V2-IN90/IN350 两个实例）。
  ⇒ 无欠账，本轮只把登记册这一行的状态改成「已落地（文档）+ 人审口径」。
- **L-M61-09（探针预期设计误差 V3，5 条）**：处置原文就是「教训已进探针设计」——
  已内化（「显式写 ⇒ 预期取回；随口 ⇒ 预期拒绝」），**本体的 5 条读数是历史事实，不回写、不补跑**。
- **L-M61-07（判定器看不到人设）**：复核后**从零风险批移出**。把 persona bio 摘要进 `factBase` = 改判定器
  **输入面**，而已收口的 M6.1 判定读数是在**当前**证据面下取得的 ⇒ 按「判定契约 → 量具有效性验证 →
  才决定机器门」的硬顺序，它必须与一次**新量具有效性判定**同批落地。前置条件已写进
  `M6.1-Known-Limitations.md` §3：@10 证据面修订立项 + 两轮判定复验。**本批不碰 `factBase`。**

### R-12 · §6 非破坏性卫生：R-01 的多会话教训进协作约定 ✅ 已落地（`AGENTS.md` §8）

- **问题**：R-01 的根因（共享文件的改动会被后续里程碑提交**整文件**带入，而自己**新建的文件**留在
  未跟踪区 ⇒ 别人检出的树编译不过）当时只写在登记册 §6 里，**对下一个会话不可见**。
- **修复**：写进 [`AGENTS.md`](../AGENTS.md) §8「提交与分支约定」三条：
  ① 多会话共享工作树的纪律（收尾前按路径提交自己的全部产物，或明确交接；接收方 `git add` 前检查
  自己不认识但**被自己提交引用**的未跟踪文件）；② **禁止 `git add -A` / `git clean -fd`**（别人的在途文件）；
  ③ 跑门与提交不能同时进行（先提交脚本 → 再跑门出证据 → 单独提交证据，证据里的 `head` 才指得住）。
- **分支删除已执行**（用户 2026-09-26 裁定：「feature/* 旧分支删除」）：5 条旧特性分支已用
  `git branch -d`（**安全删除**，拒绝非合并分支）删除。删除前逐条核对 `git merge-base --is-ancestor <branch> HEAD`
  = 真（**全部已并**），并记下 tip 供回溯：

  | 已删分支 | tip | 仍被这些标签钉住 |
  |---|---|---|
  | `feature/m4.5-action-foundation` | `2c182d749b5efa47d34e2ed379d28c4aaca78dea` | `m5.1-complete` / `m5.1.1-complete` / `inc-01-complete` |
  | `feature/m5-retrieval-context` | `cdb711c4697a3cebe4d9db4cf33088700ccddc43` | 同上 |
  | `feature/m5.1-developer-plane` | `b9790b2c768f2948e42470a72ff1b70dadcef636` | 同上 |
  | `feature/m5.5.1-adaptive-search` | `1165fedcdde2065d41eeeb1b12a635091b4d721a` | `m5.5.1-complete` / `m6-complete` / `inc-01-complete` |
  | `feature/m6-lv1-hardening` | `33d0c08eefc34f1bed121e1297955d09375eda7a` | `m7-complete` |

  **零信息损失**的两条依据：① 每个 tip 都是当前 HEAD 的祖先（提交都在历史里）；
  ② 每个 tip 都被至少一个**已冻结的里程碑标签**包含（即使将来 HEAD 被重写也仍可达）。
  **未删**：`feature/m7-relationship`（当前工作分支，M8 在其上开发）、
  `main`（`ba7acbf`）、`fix/m4.1-memory-correctness`（`ecfadd9`，非 `feature/*`，同类但不在本次裁定范围内）。
  仓库**无远端**（`git remote -v` 为空）⇒ 没有需要同步删除的远程分支；11 个标签全部完好。

### 本批的**边界声明**（不外推）

- 本批**没有**碰 M8 的任何文件（`src/kernel/contracts/affect.ts`、`src/kernel/app/affect/**`、
  `src/kernel/policies/affect-validator.ts`、`src/kernel/projections/affect.ts`、
  `src/infrastructure/runtime/affect-scheduler.ts`、`scripts/m8-*.ts`、`docs/m8/**` 全部零触碰）。
- 本批**没有**改任何 M1–M7 的产品代码（`src/**` 一字未动）；动的是 `scripts/m6*` / `scripts/m6.1*` 与文档。
- 本批**没有**让 `m6.1:gates` 变绿（L-M61-14 发射侧 + L-M61-15 归档侧都还需要一次**新 run**）。
  （✅ 2026-09-27 起**已转绿**：见 R-17 —— 本行是第二批当时的边界，保留不改写。）
- 本批**没有**打开真实库：wp6b 的真实库读数仍是**纯文件摘要**（`digestTree`，不打开库），
  前后 `f65531b1322f340c…`（1208 文件）逐字相同。


---

## 0c. 第三批（2026-09-27）：M8.5 **人审窗口**内的非 M8.5 清偿

> 背景：M8.5 的实现与材料已交付、**停在人审**（`docs/m8.5/M8.5-Gate-Decision.md` = `DRAFT`，人审 `PENDING`），
> M8.5 领土上的写入已静止 ⇒ 本批只动**与 M8.5 领土零重叠**的文件，且**零 `src/**` 改动**。
> 本批每条都按「先提交脚本 → 再跑门出证据 → 单独提交证据 → 最后文档」的顺序落地（AGENTS §8）。

### R-13 · TD-14：`m6:live` 旧入口的指引 ✅ 已修复（`bf4c941`）

- **问题**：`scripts/m6-live.ts` 的收尾提示停在"执行接线属于 WP10b"，而 M6.1 早已交付真实入口
  `pnpm with-test-model pnpm m6.1:live --suite short|long` ⇒ 被**如实拒绝**的人看不到该去哪儿。
- **修复**：`m6-command-surface.ts` 的 `suite_not_implemented` 文案末尾 + `m6-live.ts` 收尾各加一行指针。
  **只改文案**：`M6_LIVE_SUITES` 的 `implemented` / `plannedIn` 字段**一字未动** ——
  它们被 `m6-measurement.ts:389-393` 的 §3-11（`every(s => !s.implemented)`）与 §3-10 钉着；
  "旧入口只留守卫、不转发"是**设计**，不是缺陷。
- **验证**：`pnpm m6:measurement:verify` = **PASS 46/46**（§3-10 / §3-11 仍绿）；**正控**（零模型调用）：
  `DSH_TEST_MODEL_WRAPPER=1 tsx scripts/m6-live.ts --suite smoke` ⇒ 新文案逐字打出、**EXIT 2**（仍如实拒绝）。

### R-14 · L-M61-15：干净树上的 wp0 基线 = `BASELINE CAPTURED` ✅ **已关闭**（`58d0622` + `2a571e5` + `258cece` + `1227f72`）

- **修的是非 M8.5 的那一半**：wp0 归属清单里没有 `docs/m9/`（**另一个会话**的未跟踪 M9 计划）
  ⇒ 即使 M8.5 收口提交完自己的产物，`unknownDirtyPaths` 仍 ≥ 1 ⇒ 判据 `> 0 ⇒ PARTIAL` **恒 PARTIAL**。
- **修复**：`OTHER_TASK_PREFIXES` 追加 `docs/m9/`（`m6.1-wp0-baseline.ts:178`）—— **如实归属**，不是豁免：
  它仍是一条真实的未跟踪在途文件（R-01 同型风险），由它的作者提交或明确交接。
- **读数**（runId `m6.1-wp0-20260927-58d0622bc596-a657`，head `58d0622`）：
  `verdict = BASELINE CAPTURED` · `dirtyPaths=4 / unknown=0 / shared=0 / otherTask=3` ·
  `sourceTree stability=unchanged explained=0 unexpected=0` · 真实库 `stability=unchanged`；
  送聚合器 ⇒ `completion=COMPLETE usable=true`（**L-M61-14 的字段闸也在这份新清单上通过**）。
- **三段式**（AGENTS §6.7；三腿只差那一行）：

  | 腿 | runId | 那一行 | verdict | unknown |
  |---|---|---|---|---|
  | 正控 | `m6.1-wp0-20260927-58d0622bc596-a657` | 有 | `BASELINE CAPTURED` | 0 |
  | **负控** | `m6.1-wp0-20260927-2a571e541c2f-bece` | **撤掉** | **`PARTIAL`** | **1** |
  | 恢复 | `m6.1-wp0-20260927-2a571e541c2f-cb82` | 有 | `BASELINE CAPTURED` | 0 |

  负控目录里留了 `CONTROL-ONLY.md`（那是**负控**，不得当权威读数取）。
- ⚠️→✅ **2026-09-27 更正 + 收口**：上一版这里写着"要整体绿还需三个标准 schema 运行器各出**新 run**
  （`live-short` / `wp3-judge` 含真模型）"—— **这句是错的，现更正**：`m6.1:gates` 的必选门就是
  `M6_1_GATE_SPECS` 里的 **4 道（`component` / `measurement` / `wp0-baseline` / `wp1-corpus`），全部离线**；
  `live-short` / `wp3-judge` **不在**这道门的清单里，也不需要真模型。
  真正缺的只有两样：wp0 在干净树上重跑（本 R-14）+ `wp1-corpus` 的一份新 run。
  两者一次跑完 ⇒ **`m6.1:gates` = 4/4 接受 · overall = PASS**（R-17，`1227f72`）。

### R-15 · TD-11：`auto_public` 激活前复核（**已逾期**）✅ 复核已做 —— 但 **TD-11 本体保持开放**

- **复核载体**：[`docs/m5.5.1/M5.5.1-TD-11-Review.md`](m5.5.1/M5.5.1-TD-11-Review.md)（新增文件，**不改写** M5.5.1 任何冻结档、不改语料标签）。
- **e05**：全历史 40 次观测里只有 **1 次** `span_invalid`（`full-prod-10000ms` r3 `auto_public`），
  且那格 `spanFailureCode` 为空（R2-2 之前未记）⇒ **永久不可追溯**。
  ③ 校验器缺陷 **排除**（L0 门 37/0 里的空白 span 负控 + 恢复两条，加上修复后 34 次观测 0 次 `span_invalid`）；
  ② 坐标契约 **确有缺口**（`SEARCH_NEED_JUDGE_INSTRUCTION` 只用示例暗示基准，校验器却固定 0 基 / UTF-16 码元），
  但**不是**那次成因（纯 BMP 文本上单位歧义不激活；0/1 基错位**不产生** `span_invalid`，只会产生"合法但错位"）；
  ① 模型越界 **最贴近但不可定论**。关键定性：那次是**量具/生产分叉**（WP7 诊断计划 §2 的 P0 第 2 条），
  S1 让量具只走 `resolveSearchNeed()` ⇒ **指标异常那一半已闭合**。
- **e12**：历史 40 次 = 36 `search` + **1 `clarify`**（`closure-full-v2-prod` r2 explicit）+ 3 解析失败
  ⇒ 有效解析分歧率 **1/37 ≈ 2.7%**；本轮**冻结标签** 3 轮 × 2 模式 = **6/6 全 `search`**、三轮 24/24 逐条一致
  ⇒ **低频抖动，今天未复现**。⚠️ 按 TD-11 原文：**未复现 ≠ 根因已消除**。
- **新增两条残余**：`TD-11-a`（指令未写坐标基准；连带观测行不记偏移 ⇒ "合法但错位"永不可归因；
  触发条件 = 下次有意修改判定指令时，且改指令必须**重出**语义门读数）；
  `TD-11-b`（e05 那次的信息损失**已接受**，不是待办）。
- **读数陷阱（登记在案，免得被误读）**：小样本门 `verdict = DIAGNOSTIC ONLY` 且**退出码 1** 是**设计判决**
  （`verify-m5.5.1-semantics-live.ts:349-350`），不是阈值失败；`sections.semantics=false` 是**分母效应**
  （e03 两条过度搜索 = 2/14 = 14.3%，同一条行为在权威全量里是 **2/126 = 1.59%**）。

### R-16 · 真实库摘要**跨天不可比**（读数更正 + 纪律）

- **事实**：登记册 §8.1 记的 `f65531b1322f340c…`（2026-09-26）与本轮实测 **`1bff1d600905abe5…`** 不同，
  而**文件数与字节数完全相同**（1208 / 32436767）。摘要唯一实现是 `digestTree`
  （`src/infrastructure/persistence/production-db-safety.ts`，只 hash 内容、只排除 `postmaster.pid`）
  ⇒ 中间发生过一次**原地写入**；`newestMtime` 从 `2026-09-26T07:52:44Z` 推进到 **`13:05:29Z`**（= 21:05 +08），
  落在那次读数之后、M8.5 的 live 门之前。**不是**本轮任何门所为（同一 run 内 `before == after`）。
- **纪律**：登记册里"真实库摘要前后逐字相同"是**同窗口**断言，**只对产生它的那一次运行有效**；
  **跨天 / 跨会话比较摘要无意义**。以后引用"真实库没被动"，必须连同**该次运行的 runId 与 mtime** 一起引。
- **不影响任何既有结论**：M5.5.1 / M6 / M7 / M8 的"未打开真实库"各自都是**各自窗口内**的 before==after 读数；
  M8.5 同理（其 live 门晚于那次写入）。
- ⚠️ **上面那个摘要**只代表 **2026-09-27T05:32Z 那一刻**，已被再次取代：同一天 `05:54:25Z`，
  **M8.5 会话执行了生产激活**（其 run 证据 `artifacts/m8.5/activation-20260927055425800/activation.json`：
  `ok=true · target=production · path=seeded_fresh · cutoverSequence=117 · aEqualB=true · appliedEvents=0`；
  随附提交 `9ea46b2` 在**冻结枚举** `OPERATION_KINDS` 里追加 `affect_semantic_activate`——**追加不回写**，
  inc-01 证据由 `d24babd` 重出 test 24/0 + verify + measurement 8/8）。⇒ **真实库已被再次打开**，
  `1bff1d60…` 不得当"当前"。这正是本条纪律要防的事：**引摘要必须带 runId 与时刻**。

### R-17 · **`m6.1:gates` 聚合门转绿**：4/4 接受 · `overall = PASS` ✅（`9864a0e` + `1227f72`）

> 这是 L-M61-14（R-08）+ L-M61-15（R-06 / R-14）这条线的**终点**，也是 M6.1 收口时
> 那句"聚合 = NOT PASS（失败关闭如实拒收）"的**修订读数**（按 TD-16：旧读数不回写，只追加）。

- **必选门只有 4 道，且全部离线**（`scripts/m6.1-evidence.ts` 的 `M6_1_GATE_SPECS`）：

  | 门 | 命令 | schemaVersion | 接受判决 | 本次读数 |
  |---|---|---|---|---|
  | `component` | `pnpm m6.1:test` | `m6.1-component@1` | `PASS` | **313 通过 / 0 失败** |
  | `measurement` | `pnpm m6.1:measurement:verify` | `m6.1-measurement@1` | `PASS` | **16 通过 / 0 失败** |
  | `wp0-baseline` | `pnpm m6.1:wp0:baseline` | `m6.1-wp0-baseline@1` | `BASELINE CAPTURED` | runId `…-20260927-9864a0e6206f-cc35` |
  | `wp1-corpus` | `pnpm m6.1:wp1:verify` | `m6.1-wp1-corpus@1` | `FROZEN` | runId `…-20260927-9864a0e6206f-330d`，**0 问题** |

- **命令与出口**：
  `pnpm m6.1:gates --manifest <wp0> --manifest <wp1> --write` ⇒ **必选门 4 · 未运行 0 · 未通过 0 · `overall = PASS`（EXIT 0）**；
  汇总写在 `artifacts/m6.1/m6.1-wp0-20260927-9864a0e6206f-cc35/gate-results.json`。
- **`wp1-corpus` 为什么这次是 `FROZEN`**：判据是 `reviewedBy` + `reviewedAt` 非空
  （`m6.1-wp1-corpus.ts:308-318`），而 `evals/m6.1/annotations/labels.json` 的真人批准**自 2026-09-22 起就在位**。
  所以"未获真人批准"**从来不是** 2026-09-26 收口时的真实阻塞点 —— 真实阻塞点是 wp0 在混合树上的 PARTIAL。
  （聚合器在 NOT PASS 时打印的那句"wp1 未获批准 ⇒ 必然不是 PASS"是**通用提示**，不是当时那台机器的实际读数。）
- **结构提醒**：`component` / `measurement` 这两道门的证据是**固定路径**（`artifacts/m6.1/component.json` /
  `measurement.json`），由 **wp0 清单**引用（`m6.1-wp0-baseline.ts:274-295`）—— 所以顺序纪律是
  **先跑这两道门、再跑 wp0**，否则清单会指向一份即将被改写的证据。
- **顺手更正的一处事实错误**（`9864a0e`）：wp0 的注释原先写"这些固定路径证据**无时钟字段** ⇒ 重复运行逐字节相同"。
  实测：`component.json` 确实无时钟字段（重跑逐字节相同，已自证）；但 `measurement.json` **有**
  `startedAt` / `finishedAt` ⇒ 每次 `m6.1:measurement:verify` 都会改写一份**已入库**文件（只差那两行）。
  注释已改到与事实一致 —— 这解释了"为什么证据总是脏"，也避免后人以为可以随便重跑。
- ⚠️ **本 R-17 只关闭聚合门**：M6.1 的其它读数（行为门 / 长轨迹 / 人审）**不因此重判**；
  `live-short` / `wp3-judge` 等运行器是**它们各自的证据**，与这道聚合门无关。

### R-18 · 状态面纠偏：README / AGENTS 的过时与**自相矛盾** ✅ 已修复（`6c43869`）

- **触发**：用户问「M9 未开工、M8.5 在交付，现在能修什么」⇒ 做了一次**有界**的状态面复核
  （只看人类入口与机器入口，不猜、不臆断）。
- **README.md 的真缺陷（4 处）**：
  ① **M5.5 有两行**，其中一行仍写「🚧 进行中」、且 provider 写成已被 ADR-053/054 取代的
  local SearXNG —— 同一个文件里**自相矛盾**；
  ② 里程碑表**完全没有 M5.5.1 / M6 / M6.1 / M7 / M8** 五行；
  ③「**当前判定**」仍指向 2026-09-20 的 M5.1.1 Phase 1–3；
  ④「与原始计划的核对」里写「**Rolling Summary 仍未实现**」—— M6 早已交付并生产激活（ADR-050 / ADR-052）。
- **AGENTS.md 的过时（2 处）**：① §1 指针里「**M8 实现文件未提交，别的会话不得接管**」
  —— M8 已收口 / 已 ff 合并 / 已生产激活；② §4 表里登记册行仍写「2026-09-26 复核」。
- **修法**：README 删掉矛盾的旧行、补齐 M5.5.1/M6/M6.1/M7/M8 五行（各带**逐条核实过**的标签 SHA
  与权威载体）、把「当前判定」改成最新在前、改掉 Rolling Summary 那句；AGENTS 只做两处最小改写
  （**不回写**历史段，按 TD-16）。标签用 `git rev-list -n 1` 逐条核实：
  `m5.5.1-complete→3541563` · `m6-complete→7126823` · `m6.1-complete→2afec02` ·
  `m7-complete→c8afc59` · `m8-complete→4e43e0f`。
- **M4 S3-1 的读数纠偏（同一批，零代码）**：见 §1 的行与 §7 导航 —— **T31 的语义已由 `m4:verify` §8
  覆盖**（逐字段 `A == B` + 整库 mismatch=0），只剩 **T32** 要等 0010+ 迁移；同时更正了
  「立案 Target Stage（新增 0006）早已过期」这件事。
- **TD-17 性能项的归位（同一批）**：见 §6 备注 —— **不用门耗时冒充产品性能**；性能 SLA 归
  **M9-WP0/WP1**，按 M9 §22.4 的方式冻结（同设备/同数据规模基线 + p50/p95 + 扫描行数/DB 调用数）。
- ⚠️ **R-01 型风险，当场记录**：`README.md` / `AGENTS.md` 正是 **M8.5 收口要写的共享文件**
  ⇒ **收口方 `git add` 前请先 `git status` / 重读**，否则本次改动会被整文件覆盖（AGENTS §8）。
  （本批提交时实测到 M8.5 会话在活跃工作：`scripts/m8.5-activate.ts`、`package.json`、
  `src/infrastructure/persistence/production-db-safety.ts`、inc-01 证据 —— **全部未触碰**。）

### 本批的**边界声明**（不外推）

- 本批**零 `src/**` 改动**：动的是 `scripts/m6*` / `scripts/m6.1*`（两处文案、一处归属清单、一处注释）、文档、证据。
- 本批**没有**碰 M8.5 领土（`src/kernel/app/affect/**`、`contracts/affect*.ts`、`policies/affect-validator.ts`、
  `projections/affect.ts`、`runtime/affect-*`、`scripts/m8.5-*`、`docs/m8.5/**`、`evals/m8.5/**`、
  `artifacts/m8.5/**`、`package.json` 全部零触碰）；另一个会话的脏文件 `artifacts/m8.5/gate-results.json`
  与未跟踪的 `docs/m9/` 原样保留。
- ✅ 本批**把 `m6.1:gates` 变绿了**（R-17：4/4 接受 · `overall = PASS`）—— 这是本批的**主要交付**；
  但**没有**关闭 TD-11（R-15 只补做复核，本体保持开放）。
- 本批**没有**打开真实库；R-16 记的那次写入发生在**本批之前的** 2026-09-26 21:05 +08。
- R-18 的面（README / AGENTS / 登记册纠偏）同样是**零 `src/**`、零实测**：它**没有**关闭任何还开着的债，
  只把**读数与状态**改到与证据一致（S3-1 的 T31 从"缺"改成"已覆盖"、TD-17 的性能项归位、状态面归一）。
- ⏳ **`docs/m9/` 的处置（用户 2026-09-27 裁定）**：**暂不入库 —— 等 M9 真正开工再说**。
  它**仍未被跟踪**（R-01 同型风险：别人检出即缺）。AGENTS §8 不许擅自提交他人的在途文件，
  故本批**不动**它。⇒ **触发条件**：**M9 立项/开工时**，由产物持有人（或接管会话）在
  任何引用它的提交**之前**把它按路径入库 —— 与 R-12 的"收尾前按路径提交自己的产物"同一条纪律。

## 0d. 第四批（2026-09-27）：M9 WP0-R —— L-M8-13 销账

> 背景：M9 正式开工（计划入库 `c5710ef`，基线/准入见
> [`docs/m9/M9-WP0-Handoff.md`](m9/M9-WP0-Handoff.md)）。准入实验把 L-M8-13
> 从"潜伏登记"升级为**完整复现**（E1b 穿透 + E2b/E2c 永久楔死），随后本批修复并复验。

### R-19 · L-M8-13：M7 关系评估器双缺陷 ✅ **已修复并验证**（`afa512b` + `52987ae` + `a762d0a`）

- **缺陷（a）**：`relationship/job.ts` 把窗口全部事件裸转 `processorEventViewOf`（tool 事件
  失败关闭 ⇒ 抛错）；调度器侧 `qualifiedUserEvents` 同款裸转；且 **dry-run 在 try 之外** ⇒
  异常穿透 `maybeRunRelationshipEvaluation` 的"幂等且不抛"契约（`main.ts:1419` 裸调 ⇒ 可及聊天链路）。
- **缺陷（b）**：调度器 catch 只 `return {kind:'failed'}`、从不 `finishJob('failed')` ⇒
  job 行楔在 running ⇒ 同窗重试撞 `job_not_pending` ⇒ **永久楔死**（M8 因 catch 里
  finishJob 而有 L-M8-14 两步自愈，M7 没有）。
- **修复**（形状 = M8 的两处参照修复，`afa512b`）：
  ① `job.ts` 先 `filter(actorType !== 'tool')` 再转视图，`skippedToolEvents` 进 outcome
  （跳过是**可审计读数**，不是静默丢弃）；② `qualifiedUserEvents` 同款过滤；
  ③ 调度器消费段整体入 try（含 dry-run），catch 里 `finishJob(job.id,'failed')`
  （finishJob 自身失败吞掉——主错误优先）。
  **攒尾窗策略原样保留**（零提案窗口持有到 R-1 累积 / 2000 上限强制消费——M7 的设计，不是缺陷）。
- **验证**（`m9:wp0r:verify`，runId `m9-wp0r-verify-20260927-a762d0a99882-8abd`，**8/8**）：
  R1 tool 事件不再穿透 + 跳过数=1 可审计 · R2 消费段失败→行落 failed→同窗重试恢复恰一次（零重复）·
  R3 试算期失败→不抛→无 job 行→恢复 · R4 finishJob 自身失败→主错误不被掩盖（行留原状=文档化边界，
  R4b 证明转 failed 后照常恢复）· R5 completed 后水位写失败→行翻 failed→恢复新建=0（零重复）·
  R6 held→flushed（策略保持）。6/8 中间档（`…-9e28`，量具两处校准）按防篡改纪律留档。
- **门复验**（全部指向 `a762d0a`）：`pnpm typecheck` EXIT 0 · `m7:test` **3/3** ·
  `m7:e2e:verify` **21/21**（含 R2 失败后补洞——直接验证修复后的 catch）·
  `m7:measurement:verify` **19/19** · `m8:e2e:verify` **21/21**（A17 双调度器共存）。
- **边界**：本批只修 M7 关系评估器这两处；`skippedToolEvents` 是**新增可审计读数**
  （outcome 追加字段，不改变任何既有判据）；M7 冻结文档（Gate-Decision/报告）不回写，
  本条即销账记录。真实库未被打开（全部隔离库实验）。

## 0e. 第五批（2026-09-27）：M9 WP9/WP10 live 门两发现 —— **已裁定：M9.1 修复**

> 背景：M9 live 门（生产副本 + 真模型）各抓到一个**真发现**。两条都**不是量具误报**
> （取证见下），都卡在 §15.3 冻结阈值上（live 门 NOT PASS）。
> **2026-09-27 用户裁定：两条均在 M9.1 修复**（同轮授权 WP11 生产激活与合并/打标签）；
> live 门读数不因裁定改写。选项详情在 `docs/m9/M9-Gate-Decision.md` §F-1 / §F-4。

### R-20 · F-1：呈现层遗忘泄漏（M4 政策缺口，非 M9 回归）—— **触发窗口：M9.1**

- **现象**：遗忘后追问「你让我忘的具体是什么」，她以 **2/7** 概率从**上下文窗口可见的
  原始对话行**逐字复述被遗忘取值（level1 @1 1/3 + @2 1/3；长门 #42 干净）。
- **归属**：状态层 7/7 全绿（记忆 retracted、信念失效、无复活）——泄漏通道是近期
  对话行原文；M4 `response-truth` 只绑定遗忘轮自身口吻，**对后续轮复述无条款**。
- **证据**：`artifacts/m9/m9-live-level1-*`（6 runs，失败档分列）+ 盲审材料；
  取证与三选项（上下文遮蔽 / prompt 政策行 / 接受为局限 L-M9-13）见
  Gate-Decision §F-1。
- **触发窗口**：**M9.1**（2026-09-27 用户裁定；①② 都改回复行为 = 措辞层政策，
  ADR 领域，取舍在 M9.1 立项时定）。
- ✅ **2026-09-28 销账（M9.1）**：按 ADR-072 §11 条件**关闭**——① 设计载体
  [`ADR-072`](adr/ADR-072-m9.1-restatement-revival-and-withdrawn-masking.md)
  （`ACCEPTED / DESIGN FROZEN`，D15–D24 = 装配层遮蔽）+ ② WP2 冻结量具
  （`m9.1:measurement:verify` = **MEASUREMENT VALID**，正控/负控/恢复三段式）+ ③ **新 run**
  达计划 §15.3：`m9:live:level1` 候选配置 **×3 全 PASS 11/11**（每轮严重项 **0**；
  探针率 90%/90%/100%；5 场景 ×3 = 15 ≥ 12；探针出自冻结清单）。
  **负控同时保留**：基线配置（开关 OFF）跑同一门 3 次 → run1 PASS · run2 PASS · **run3 FAIL（严重 1）**，
  命中位置是遗忘后探针轮、从上下文原始行复述被遗忘取值 —— 缺陷**在场可复现**且严重检测器**灵敏**。
  证据 `artifacts/m9/m9-live-level1-20260928-*`（ON ×3）+ `…9cc15f13f90c-*`（OFF ×3）。
  销账记录：`docs/m9.1/M9.1-M9-Supplement-Acceptance.md` §1 · 判定 `docs/m9.1/M9.1-Gate-Decision.md` §4。
  ⚠️ **主张边界**：冻结场景通过 + 来源边界可查；**不是**「永不泄漏」（`L-M9.1-12`）。
  人审 = **PASS**（2026-09-28 用户声明式裁定，Q1/Q2 确认；`M9.1-Gate-Decision.md` §6）。
  **生产激活 = ACTIVATED**（2026-09-28 用户授权；载体
  [`ADR-073`](adr/ADR-073-m9.1-production-activation-merge-tag.md)：`.env` 两个开关置 true，
  代码缺省仍 false；激活无真库动作；**FIRST-USE NOT OBSERVED**）。
  M9 原读数（Live Short 2/7）**不改写**。

### R-21 · F-4：同内容重述永不复活（**M4 冻结层**，长门暴露）—— **触发窗口：M9.1**

- **现象**：忘掉/更正后**逐字重述**同一内容——她说「记住了」（trace = written，
  `MEMORY_CREATED` 事件**真的提交**），但确定性内容键 ⇒ memoryId 与旧记录相同 ⇒
  折叠器 `applyCreated`（`projections/memory.ts` :193「已经存在：只记录事件，
  状态保持不变」）无条件 no-op ⇒ **记录永不可召回**。#102 读回来自可见对话行；
  #200（窗口外）她诚实说不知道。
- **归属**：`applyCreated` 的 no-op 是 D2 调查为「同一事实二次抽取」（ACTIVE 场景）
  冻结的语义——**未区分 SUPERSEDED/RETRACTED**；`pipeline.ts` :117「忘掉后重说
  应能重新记住」的意图在折叠层从未实现。重放一致（语义缺口，非账本分歧）。
- **证据**：长门 run 1（`…-6762`）LL-C5/C6 红 + 取证脚本
  `scripts/m9-long-forensics.ts`（事件 #550 已提交、记录仍 superseded）；
  Gate-Decision §F-4 / L-M9-19。
- **触发窗口**：**M9.1**（2026-09-27 用户裁定；修复 = 冻结区 reducer 语义变更 ⇒
  按程序走「新里程碑 + ADR + 全套 `m4:*` 门」，选项 ①/② 在 M9.1 立项时定；
  变通 = 换措辞重述，不同内容键正常重建）。
- ✅ **2026-09-28 销账（M9.1）**：选项 **①（修折叠器 `applyCreated`，保持确定性 id 契约）**。
  按 ADR-072 §11 条件**关闭**——ADR-072（D01–D14）+ WP2 冻结量具 + **新 run 的 Long `LL-C5`/`LL-C6` 双绿**
  （`artifacts/m9/m9-live-long-20260928-15a0848dffa4-94a6/`：`LL-C5` = `active 记忆=1(detailed) · active 信念=1`；
  `LL-C6` = `active 记忆=1 · 信念=1 · 污染=0 · 水位=952/952 · failed=0`；`LL-TURNS 200/200` · 泄漏 0 · 严重 0 · 真实库未动）。
  离线确定性半边：`m9.1:e2e:joint` **21/0**（含 `R12` 长门同构 + `R13`/`R13-B1`）。
  **执行期连带发现 F-5**（复活未传播到派生 reported 信念）经用户 2026-09-28 裁定 **A** 纳入 M9.1，
  由 **WP8** 补修（ADR-072 §13.1）。
  销账记录：`docs/m9.1/M9.1-M9-Supplement-Acceptance.md` §2 · 证据链 `docs/m9.1/M9.1-WP6-Findings.md`。
  ⚠️ **主张边界**：新告知可召回、旧源幂等、重放可重建；**两次 WP8 后 run 的聚合 verdict 均 `FAIL(9/10)`**，
  红项**轮流**落在两个**非确定性**项上（run A = `LL-MARKERS 9/11`；run B = `LL-TURNS 199/200`，
  其 `LL-MARKERS` 已绿 10/11）——两者都与 R-21 判据面不同面，已如实登记
  （`L-M9.1-17` 阈值粒度 / `L-M9.1-18` 一次 filler 控制台快速失败），**不反复抽样挑绿**。
  人审 = **PASS**（2026-09-28 用户声明式裁定，Q3/Q4/Q5 确认；`M9.1-Gate-Decision.md` §6）。
  M9 原读数（`LL-C5/C6` 红）**不改写**。

---

## 0f. 第六批（2026-09-30）：M10 收口后的只读读回 —— **读数更正 + 一条跨里程碑登记**

### R-22 · M9.5 语义召回：**「装上」不等于「在算」**

- **问题**：使用说明、`M9.5-Activation-Candidate.md`、以及 2026-09-30 早些时候的一处文档提交，
  都把 M9.5 的语义召回写成「装好了、主开关开着、**在观察档里真的在算**」。用户追问「未启用」到底指什么
  ⇒ 做了一次**真实库只读读回**，读数与这句话不符。
- **读数**（`scripts/m9.5-semantic-index-readback.ts`：真实库 · SELECT-only 构造闸 · INC-01 全程
  租约 → pre-open 已验证快照 → token → 干净关闭 → post-close 快照 · `cleanClose=true` · **13/13**）：
  `memory_semantic_meta` **0** 行 · `memory_semantic_generations` **0** 行（**已发布代 = 0**）·
  `memory_semantic_index` **0** 行 · `failures` **0** 行；四表都在 · `embedding` 列为 `vector` · schema **10**。
  ⇒ 判定 **C · 从未建过索引**（四表只由 M10 的 `MIGRATION_0010` 建出，该迁移刻意不写版本行）。
- **后果**：探针逐轮 `not_indexed`（连 134 MiB 编码模型都不加载）；`shadow` 的「记对照」分支只在
  **真的拿到分数**时才执行（`memory-retrieval-store.ts:305-320`）⇒ **没有任何对照被记下来**。
- **更正动作**（全部**只追加**，不改旧文）：`docs/苏沐薇-使用说明.txt` §五 + 里程碑列表 ·
  `docs/m9.5/M9.5-Activation-Candidate.md` 新增 §2.1（§2 ④ 的三条预期均不成立）·
  `docs/m10/M10-Known-Limitations.md` 的 `L-M10-66` / `L-M10-60` ·
  **`ADR-075` 新增 §6「读回更正」**（§1–§5 一字未改）。
- **新登记**：**`TD-22`**（§1）—— 把 WP5 交接单 §4 的 `N1`–`N6` 从**里程碑内**提到**跨里程碑层**。
  在此之前 grep `M9.5` / `索引构建` / `存储侧` 在本登记册**零匹配** ⇒ 换个会话必再丢一次。
- **零删除纪律（本次实际用到）**：pre-open 快照缺省 `keep=10`，而本机**恰好 10 份** ⇒ 再来一份会真删最旧那份；
  AGENTS §5.1 ③ 要求「删旧快照 = 单独授权」，本轮**没有**该授权 ⇒ 读回脚本把窗口抬到 **30**
  （多留、不少留）+ **前置拒绝**（≥30 就不开库）+ **事后断言** `pruned=[]`；收尾快照 **10 → 12** 份，一份未删。
- **读数如实**：开库把树摘要从 `5619f85d…` 推到 `e700c697…`（`L-M10-60`：打开会写 `pg_control`/WAL），
  但两份快照的 `fileCount`(**1228**) 与 `totalBytes`(**32862751**) **逐字相同** ⇒ 只动记账、未增数据；
  `m10:realdb:invariant` 注册时**不带** `--expected`，故不因此变红。

### 本批的**边界声明**（不外推）

```text
· 本轮**没有**建索引、**没有**改 `.env`、**没有**切模式：只做了读回 + 文档更正 + 登记。
· 「索引未建」是**此刻**的读数。它**不**推翻 M9.5 的验收读数 —— 那些跑在**隔离库 / 生产副本**上，
  那里确有构建好的「代」（`shadow` 在 500 轮里真的算了 500 次分）；缺的是**生产库里**那一份。
· **不**主张语义召回的质量，也**不**主张「建了就有用」：收益受记忆体量限制，见 `TD-22` 末段。
```

---

## 0g. 第七批（2026-09-30）：`D-6` 裁定后的「记忆体量」线（**M9.7**）—— WP0 + WP1 两个增量

### R-23 · 「她只记得住被明确告知的事」第一次被量出来；随后补上 10 条可达说法

> ⚠️ **本批是 2026-09-30 前半段的读数**。同日的**取值边界线第 1 轮**（§0h / R-24）改动了它：
> **当前读数是 `extracted 27`**（峰值 29）· 登记表可达例子 **16 / 21**。以门为准，本批**不回写**。

- **触发**：M9.5 启用计划的 **`D-6` 裁定**（用户逐条裁定「**先做记忆体量那条线**」）⇒ 立项 **M9.7**
  （载体 [`docs/memory-coverage/`](memory-coverage/)：计划书 · 基线报告 · 两份交接单 ·
  [`ADR-078`](adr/ADR-078-m9.7-memory-coverage-cue-expansion.md) + [`ADR-079`](adr/ADR-079-m9.7-person-slot-expansion.md)）。
- **WP0（量具 + 基线）**：新门 **`pnpm memory-coverage:verify`**（三段式：正控 / 负控①分辨力 / 负控②比对 / 恢复
  + `measuredCount > 0`）· 语料 **47** 条、sha256 **冻结**在 `corpus/manifest.json`（改语料必须有意重刷）·
  注册进 `scripts/gates/manifest.ts` 的 `memory-coverage` lane + `affected-map` + `AGENTS.md` §5。
  **基线（43 条）**：`extracted` **19** · `content_unresolved` **15** · `intent_not_detected` **6** ·
  `content_empty` **2** · `not_remember_intent` **1**。
- **核心读数**：登记表自己声明的 `examples` 是一份**非任意**的可测集合（**不是**覆盖率百分比 ——
  它是抽样）。WP0 时 **17 个里 7 个抽不出**，逐条给了机制（缺线索词 / 整条槽位无规则 / cue 与说法不匹配 / **大小写**）。
- **WP1 增量 1 + 2**：`CONTENT_RULE_VERSION` `@2 → @3 → @4` · 登记表 **11 → 13** 槽位（**只增**）。
  **三段前后对照**：`extracted` **19 → 23 → 29** · 登记表可达例子 **10 → 13 → 17**（分母 17 → 21）。
  ⚠️ 计划 §1.5 的 **4 条既有断言（`LC-A1`…`LC-A4`）一个字都没改** —— 新线索词逐个核对过不在那 4 句里，
  且**由实际跑门验证**（`m4:verify` 142/0 · `m4:nl-mutation:verify` 38/0 · `m6.1:e2e:verify` 20/0）。
- **一条被量具抓住的语义错误（有完整重放档）**：增量 1 第一版把「海鲜过敏」挂进 `food.avoid.general`
  ⇒ 那条规则的取值是**短语专属**的（`positive: '喜欢辣'`）⇒ 实测记成 **`food.avoid.general = 喜欢辣`**。
  只看闸门会以为改动成功，**读取值**才发现 ⇒ 该 cue 已撤回。
  ⚠️ 一般化的教训：**往一条已有规则上挂线索词，只有在该规则的取值不是"短语专属"时才安全。**
- **WP3（门与证据收口）**：`pnpm m4.5:ci` **EXIT 0**（M1→M4.5 全链；聚合器那行 `G14 … FAIL` 是**已登记的
  `L-M10-59`** —— 它按设计只读**已落盘**的 live 证据，而 live 档本轮未跑）；局限册
  [`M9.7-Known-Limitations.md`](memory-coverage/M9.7-Known-Limitations.md)（13 条）；6 份被 CI 重写的
  历史档按白名单还原。
- **WP4（端到端写读 · Level 2）**：新门 **`pnpm memory-coverage:e2e`**（隔离库 + 生产形状链路 + **零模型**）。
  喂 46 条 ⇒ **真的写入 29 条**（11 条带**具名理由**不写：9 `content_unresolved` + 2 `content_empty`；
  6 条 `no_intent`），且这 29 条与可达性读数的 `extracted` **逐条重合** ⇒ **在 46 条抽样上，
  下游写路径（目标解析 / 冲突 / 去重 / 放行口 / 折叠）一条都没丢** ⇒ 体量的瓶颈**完全在闸门②与③**。
  三段式全过（负控①：数"尝试"40 ≠ 数"写入"29；负控②：同一条喂两次 ⇒ `already_applied`，active 仍 1；
  恢复：换沙箱重喂逐字段相同）。⚠️ 顺带证实 `L-M97-02` 那条假阳**真的会落库**。
- **被排除的两个方向（尽管被授权）**：`relationship`（登记表头部逐字排除"人际关系"；且 M7 已另建**独立模块**）·
  `schedule`（过不了"取值形状稳定"那条；且 M10 已有完整的 **goal/commitment 域** ⇒ 加进记忆会造出
  **第二套弱表示**）⇒ 后者需要一道**域边界裁定**，不是加条线索词能解决的（ADR-079 §5）。
- **新登记**（3 条，逐条给处置，详见 [`M9.7-Known-Limitations.md`](memory-coverage/M9.7-Known-Limitations.md)）：
  · **`L-M97-01`** 登记表仍有 **4** 个 declared examples 抽不出（逐条理由：会造语义错误 / 撞 ADR-058 负控 / 要改既有判据）
  · **`L-M97-02`** **已知假阳路径**：抽取器**没有问句守卫** ⇒ 问句会被记成事实
    （「记住，我的生日是什么时候」→ `person.birthday = 什么时候`）。**今天够不到生产**（显式路径要求先说「记住」；
    后台路径 NOT-WIRED），但 **TD-19 一旦接上后台路径它就是现实风险**；修它要问句守卫（行为变更，不在本次授权内）。
    而且这是**既有的一般性质**（既有槽位同样如此）。
  · **`L-M97-03`** **5 条"可达但取值可疑"**（含 `education.major` = 单字「的」—— 与 ADR-056 修掉的「书」/「了」同一形状）
    ⇒ **只登记、未修**：归取值边界线（ADR-056 / `m6.1:extractor:repro`）；ADR-056 §5 与 M6.1 的具名分组裁定都**禁止混着修**。
- **`M4 D2-A` 的方向裁定已出** ⇒ §3 那一行同步更新（它此前逐字写着"需用户裁定"）。

### 本批的**边界声明**（不外推）

```text
· 本轮**没有**建索引、**没有**改任何开关、**没有**碰真实库、**没有**改任何冻结条文。
· **不**主张"覆盖面够了"：仍有 4 个登记表例子抽不出；`G1` 点名的四个方向只做了两个。
· **不**主张"她记得更多 = 她记得更对"（`DR-11`）；**不**主张取值正确性（两个增量都没碰取值边界）。
· **不**主张写入结果 / 假阳率 / 端到端行为 —— 那要库，属隔离库预演。
· `M4 D2-A` **不因本批关闭**；`TD-22` **不因本批关闭**；`M9.5 = PASS` 不因本批改变。
```

---

## 0h. 第八批（2026-09-30）：M9.7 **取值边界线**第 1 轮（**ADR-080**）

### R-24 · 一个虚词 / 疑问词**不是一个取值**

- **触发**：用户 2026-09-30 授权「在取值边界线上做一轮（新 ADR）」。**为什么先做它**：M9.7 的**实测**
  表明扩覆盖已经被取值边界卡住 —— 给 `device.primary` 加一个平台名 cue，会让**既有正确条目**的取值
  从「Windows 笔记本」退化成「笔记本」（`best` 取最长线索词 ⇒ 取值那一支从「往后」翻到「往前」；
  `L-M97-14`，有完整档）。
- **机制（先讲清"取值是怎么来的"）**：自由文本取值由**两支**之一给出 ——「往后」（线索词是引导词、
  不属于值）与「往前」（线索词**通常是值的一部分**、**有意**接回来）；哪一支胜出取决于**命中了哪个
  线索词**（`best` = 最长命中），**不是**句式。
- **五条缺陷（逐条给机制）**：`A` 尾部填充语没剥（「Alex 就行」）· `B` "往后"那一支**接受了一个虚词**
  （「的」）· `C` 同上（疑问词「什么时候」）· `D` `beforeCueValue` 只取**最后一个空白段**（「的项目」）·
  `E` **取值本身也在线索表里**（`neovim`）⇒ 与 `L-M97-14` 同一机制。
- **决定**：`@4` → **`@5`**（只动取值剥法）· ① `normalizeValuePhrase` 多剥一类尾部填充语；
  ② 新增**整值级**拒绝 `VALUE_STOP_SET`（**精确等于**才拒）；③ 拒绝是**终止**语义（**不**回退试另一支 ——
  实测"往前"那一支会给出「不是计算机专业」，把**否定**也当成取值）。
- **读数**（新门 `pnpm extractor:value-boundary:verify` = **PASS**，8 用例 / 一致 8）：
  三段式全过（负控①**关掉判据** ⇒ 两条垃圾取值**重新出现**；负控②**精确 vs 包含** ⇒ 读数**不同**）+
  **接线证明**（走生产抽取器 4/4）+ `measuredCount > 0`。连锁：可达性 `extracted` **29 → 27** ·
  写读 `written` **29 → 27** ⇒ ⚠️ **`written == extracted` 这个恒等式仍成立** ⇒
  "下游写路径一条都没丢"的结论**不因本轮改变**。
- **⚠️ 一处有意的覆盖损失**：`B` 让一个登记表例子**从可达变成不可达**。依据任务书 §19
  「Coverage 不完美可以接受，**False Success 不可接受**」：一条会被召回、会被展示给模型的错记忆，
  比"她如实说没抓住"更坏。它逐字记进语料 `revisions[4].boundary`。
- **新登记**：**`L-M97-15`**（**规则表表达不了 qualifier / 否定** —— `B` 与「海鲜过敏」的**共同根因**；
  规则产出 `{subject, predicate, value}`、没有 qualifiers 位，只有 LLM 抽取器能带）⇒ **登记不修**。
  `L-M97-02`（问句假阳）**收窄**（疑问词取值不再落库）但**未关闭**；`L-M97-03` 改为 **3 修 / 2 未修**
  （未修的 `D`/`E` **特征化在门里**，修好会报红）。
- **门清单**：`extractor:value-boundary:verify` **0** · `memory-coverage:verify` **0**（47/47）·
  `memory-coverage:e2e` **0**（46/46）· `m6.1:extractor:repro` **0**（ADR-056 的冻结 7 句**未被碰**）·
  `m4:test` 258/0 · `m4:verify` 142/0 · `m4:mutation-safety:verify` 20/0 · `m4:nl-mutation:verify` 38/0 ·
  `eval:m4` 17/0 · `kernel:test` 26/0 · `kernel:verify` 25/0 · `typecheck` 0 · `gates:verify` 51/0。

### 本批的**边界声明**（不外推）

```text
· 本轮**没有**加任何线索词、**没有**改 priority / cueInValue / 匹配语义 / 开关 / 冻结条文。
· **不**主张"取值正确了"：只修了 A/B/C；`D`/`E` **特征化在门里**（今天就是这个行为）。
· **不**主张问句问题已解决（`L-M97-02` 收窄未关闭）· **不**主张真实模型下的行为（本轮零模型）。
· **不**主张"少记一点没关系"：`B` 是有意的覆盖损失，其根因（`L-M97-15`）仍在。
· `M4 D2-A` **不因本批关闭**；`TD-22` **不因本批关闭**；`M9.5 = PASS` 不因本批改变。
```

---

## 0i. 第九批（2026-10-01）：M9.5 **WP6 生产副本预演** —— 一条**量级**教训

### R-25 · 隔离夹具的**量级**会掩盖边界缺陷（水位单位的 `integer` 溢出）

- **怎么发现的**：M9.5 启用计划的 **WP6（生产副本预演）**在**真数据副本**上跑全量索引时，
  第一句就失败：
  ```text
  error: value "1789576995336" is out of range for type integer
  ```
- **根因**：**WP2-A 把水位单位选成了毫秒**，而
  `memory_semantic_generations.processed_watermark` 声明的是 **`integer`**。
  `1789576995336` 是真实记忆的 `created_at`（毫秒）⇒ 一进 `integer` 列就溢出。
- ⚠️ **为什么 50 项隔离检查全都没抓到**：那些夹具的 `created_at` 是 **1000..12000**（毫秒）
  —— **数量级小了六个数量级**，塞得下，于是"水位推进到 12000"之类的断言**全绿**。
  ⇒ **隔离库不是真数据的替身**：它证明了**逻辑**，证明不了**量级**。
- **修法**：单位改成**秒**（`floor(created_at/1000)`；`1789576995 < 2^31`，到 2038 不溢出）——
  **不碰冻结列、不加迁移** ⇒ `D-31` 的零迁移仍然成立。
  ⚠️ 代价如实登记：**同一秒内的多条共享 seq** ⇒ 水位在那一点**保守停住**（不漏写、只晚推进）。
- **回归**：门里加了**真实量级**时间戳（`1789576995336`）的判据：seq 必须是秒、必须塞得进
  `integer`、**并且真的能落盘**（`pnpm m9.5:build:verify` ⇒ **52 项**）。
- ⚠️ **一般化的教训（写给所有夹具）**：
  ```text
  夹具的取值要**跨量级**取，不能只在"舒服的小数字"上取 ——
  时间戳用**真实毫秒**、id 用**真实长度**、计数用**接近上限**的值。
  否则"全绿"只说明逻辑通，不说明**真实规模下通**。
  ```
- **同批的第二处**：预演第一版把 `ownerId` 写死成 `char_sumuwei`，而真库的 owner 是
  `character / 00000000-0000-4000-8000-000000000001` ⇒ 副本里明明有 `active=1`，枚举返回 **0 条**，
  整个预演**跑通但零读数**。⇒ **身份要从数据里读**，不要从记忆里抄。

### R-26 · **「未跟踪」≠「可丢弃」**（我自己造成的，已修复并逐字节验证）

- **怎么发生的**：我在收尾时按「删未跟踪文件」清理本轮产生的 run 目录，结果把
  **`artifacts/m9.5/local/`**（**134 MiB 模型资产**，`embedding-lab/models`）一起删了。
- **为什么这条规则是错的**：本仓库**故意**把大的本地资产留在 git 之外
  （`artifacts/**/local/` 按惯例不入库）⇒ 它们**未跟踪**，但它们**不是一次性产物**。
  `git ls-files` 说"不认识它"**不等于**"它可以被删"。
- **修复**：`pnpm m9.5:embedding:download` 重新拉取 ⇒ **7 个资产 / 140,461,908 字节**，
  与冻结清单 `evals/m9.5/embedding-manifest.json` 的合计**逐字段一致**；
  `pnpm m9.5:embedding:verify` **EXIT 0**（每个资产按记录的 sha256 核对，其中 3 个还核上游 LFS 哈希）。
  **功能路径也重新跑通**：真编码器 warmup ok · 384 维 · `validateSemanticVector()` 全过 · 走生产渲染器。
  两次运行的证据都已入库 ⇒ 修复**可追溯**，不只是一句声明。
- ⚠️ **一般化的教训（写给所有"清理"动作）**：
  ```text
  清理必须以**具体路径白名单**为准，**不能**以 git 跟踪状态为准。
  判据要问的是"这个路径是不是**我这次产生的**"，而不是"git 认不认识它"。
  同一条纪律在 §7 已经写过一次（**还原历史证据 = restore whitelist only**）——
  这次是它的**反面**：**删除**也必须是白名单。
  ```

### R-27 · 已提交的 `m5.1` 证据**陈旧**（记 52 项，门现在跑 54 项）

- **怎么发现的**：2026-10-01 跑 `pnpm m5.1:test` / `m5.1:query:verify` 之后按 §7 的**白名单**还原
  被重新生成的历史档时，diff 里出现：
  ```text
  -  "passed": 52,
  +  "passed": 54,
  ```
  ⇒ `artifacts/m5.1/wp1-contracts.json` 记的是 **52**，而门现在跑 **54**。
- **判定**：**不是**本次改动造成的（我那次没给 m5.1 加任何检查）；是**已提交证据相对当前门陈旧**。
  两个检查是**何时**加进 `m5.1:test` 的，本轮**没有**追（要翻 git 历史）。
- **处置**：**只登记，不改写**。⚠️ 刷新那份证据 = **改写已提交的历史证据**，按 §3/§7 的纪律**不能顺手做**；
  要刷新得走"有意重出证据"的程序（并说明为什么）。
  ⇒ 读它的人**必须**知道：**门的读数以门的输出为准，不以这份已提交的 JSON 为准**。
- ⚠️ **一般化**：这条与 `L-M10-59`（聚合器只读**旧**证据）、以及本轮修的
  `m9.5:test` 循环依赖（`m9.5:gates` 当时仍 PASS）**同形**：
  ```text
  **"已落盘证据的绿"不等于"今天跑得起来"，也不等于"今天跑几项"。**
  凡是要回答"现在是什么状态"，只能**跑一遍**，不能读旧 JSON。
  ```

### 本批的**边界声明**（不外推）

```text
· 本批**只**登记教训与修法；**不**主张 WP6 已自动化（它**不注册进任何 gate**，要手跑）。
· **不**主张"重启"已预演（同进程再读一次，**不是**真重启；计划 §1 的 `N4`/`N5` 仍未测）。
· `M4 D2-A` **不因本批关闭**；`TD-22` **不因本批关闭**；`M9.5 = PASS` 不因本批改变。
· 生产里的索引**仍是 0 行**；**真实库从未被打开**。
```

---

## 0p. 第十六批（2026-10-04）：**接收停摆**后的补录 —— 七个里程碑的当前读数

> 出身：用户 2026-10-04 问「有哪些技术债现在能解决、或者已解决但没标明」⇒ 做了一次**只读**总核对
> （登记册全文 + 各里程碑自己的局限册 + 代码 / git / 已落盘证据；四路并行只读审计；
> **零文件改动、零开库、零模型调用**）。
> 本批只做两件事：① 把 §0o（2026-10-02）之后**以及此前漏收**的里程碑残余与销账**收进跨里程碑总册**；
> ② 给字面已过时的行**追加修订读数**（TD-16：追加，不回写）。
> ⚠️ **本批不关闭任何条目**：所有"仍开放"的判断保持原边界；"复核完成"≠"债已关闭"。

### R-39 · 登记册的**接收停摆**（§0o 之后无任何里程碑被接收）· 本批最重要的产物

- **事实**：登记册最后一节此前是 §0o（2026-10-02，Lv2 WP5 重启 lane）。此后至少 **7 个**工作单元已收口 / 已激活，
  而它们在**本册 grep 零命中**：**`M9.6`** · **`M11`** · **`M11.1`** · **`Lv2`**（此前只有 :3 的放行注）·
  **post-Lv2 / `S8` / `L-PL2` / `L-S8-*`**；`M9.5` / `M9.7` 虽有 §0f / §0g，但**其后的销账与残余没有回写**。
  ⇒ 与 `R-22`（"grep `M9.5` 在本登记册零匹配 ⇒ 换个会话必再丢一次"）**同一根因**：
  里程碑自己的局限册在更新，跨里程碑总册没有接收。
- **接收纪律**：登记 = `原ID → 归属 → 前置 → 新证据 → 状态 → runId → 剩余限制`，**不等于关闭**。
- **本批接收的四个面**（明细各见其载体，本册只记"在哪、怎么读"）：

  | 归属 | 当前读法（本册口径） | 载体 |
  |---|---|---|
  | **M9.6**（2026-09-29 收口） | 裁定 **`DO_NOT_ADOPT`**（保留 Jev 搜索验证线，**暂不替换生产组件**）· 生产 **`NOT ACTIVATED`**；残余 `L-M96-01…35`：`L-M96-03` 表达差异未受控（B 列 NOT RUN）· `L-M96-06` 成本臂 NOT RUN · `L-M96-09` 历史影响面 `UNTRACEABLE` · `L-M96-30…35` 情绪轮（其中 `L-M96-35` 的 B 列与基线打平）。⚠️ **一条安全 TODO**：`M9.6-Status-and-Closure.md:160-161` 自述"该 Key 曾出现在会话记录中，建议轮换"——需用户确认是否已轮换 | [`docs/m9.6/M9.6-Status-and-Closure.md`](m9.6/M9.6-Status-and-Closure.md) · `M9.6-Known-Limitations.md` |
  | **M9.5 残余** | 语义召回写侧 / 渲染器 / 生产入口**已实现并激活**（见 §1 `TD-22` 的 ⏩ 修订）；`L-M95-33` 的 ⏩ 状态见 [M9.5-Known-Limitations.md](m9.5/M9.5-Known-Limitations.md)。**新增读数缺口**：`CONTENT_RULE_VERSION` 已升到 **`content-rules@6`**（`src/kernel/app/memory/content-extractor.ts:85`；`ADR-089` 追加 5 个槽位 ⇒ 登记表现在 **18** 个键），而 `pnpm memory-coverage:verify` 的**最新档曾停在 2026-09-30 23:35**、语料 `frozenAt` = 2026-09-30（`itemCount 47`）⇒ `@6` 之后一直没重跑。⏩ **2026-10-04 已补跑**：`pnpm memory-coverage:verify` = **PASS（47 条 / 一致 47 / 不一致 0）**，实测分布 **`extracted=27` · `content_unresolved=11` · `intent_not_detected=6` · `not_remember_intent=1` · `content_empty=2`** ⇒ **`@6` + 冻结语料下 `extracted = 27` 就是当前读数**（§0h 的 27 得到确认；§3 的 `19→29` 是 @4 时代读数）；`pnpm memory-coverage:e2e` = **PASS（喂 46 ⇒ 真的写入 27 · 一致 46）** ⇒ `written == extracted` 的恒等式仍成立。证据 `artifacts/memory-coverage/memory-coverage-20261004034905-25c834e12a83-1f87/` · `artifacts/memory-coverage/e2e/memory-coverage-e2e-20261004034912-25c834e12a83-7444/`。⚠️ 归属仍是 M9.7 维护线 | `M9.5-Known-Limitations.md` · `evals/memory-coverage/corpus/manifest.json` |
  | **M11 / M11.1** | `m11.1:gates` 历史读数 = **NOT PASS**（G1 PARTIAL · G5 INVALID · G6/G7 NOT RUN · G8 INVALID · G10 PARTIAL）；**F01–F06 已修**（代码 + 门读数在案）· F02 PARTIAL · F07 阈值已对齐契约但**正式语义 480 案 FAIL 保留** · F08 v3 材料已出 + 声明式人审 PASS；三槽 540 行为评分与 200 轮混合长门**未交付** | `docs/m11.1/**` · [`Lv2-Deferred-After-Release-2026-10-03.md`](lv2/Lv2-Deferred-After-Release-2026-10-03.md) |
  | **Lv2 / post-Lv2** | Lv2 已按 [`ADR-090`](adr/ADR-090-lv2-risk-acceptance-release.md) **接受 R1–R5 放行**（放行后待办见其载体，本册不重复）；post-Lv2 的 **S8** 已收口 + 激活，残余以 `L-S8-*` / `L-PL2-*` 分列 | `docs/lv2/**` · `docs/post-lv2/**` |

- **新增两条跨里程碑登记**：
  - **`L-S8-30`（新，立案）**：`StoryCognition.ingestChoice`（`src/infrastructure/runtime/story-cognition.ts:71/239`）
    在**生产里没有任何调用者** ⇒ `storyline_commits` 永远 0 行、消费回路每次 `open()` 空转；
    而 `D01` 的消费锁只按**文本**断言 `src/main.ts` 含 `storyCognitionEnabled` + `consumeOnce`
    （`scripts/kernel-tests-memory.ts:3499-3512`）⇒ **入口无调用者时它照样绿**。
    载体 [`docs/post-lv2/S8-Consumption-Entry-Gap.md`](post-lv2/S8-Consumption-Entry-Gap.md)（本批新建）。
    ⚠️ **本条只登记，不修**：属 `ADR-094` `D02` 剩余部分（提案通道 + 服务端 run 生命周期），需设计裁定与新授权。
  - **`L-M95-33` 进册**（此前只在 M9.5 局限册内）：**同 `R-22` 的理由** —— 一条标着"阻断"的条目不进总册，
    换个会话必再丢一次。

### R-40 · A-3：把**更晚里程碑**挂进统一调度器（当场抓到一条新缺陷）

- **背景**：`scripts/gates/manifest.ts` 的 lane 过去只覆盖到 M5–M6 + INC-01 + `td`/`m9`/`m9.5`/`m10`/`m10-semantic`/`memory-coverage`/`m11.1`。
  ⇒ `m9.6` / post-Lv2(S8) / Lv2 的**门**不在任何 lane 里；`m6.1`/`m7`/`m8`/`m8.5`/`m9`/`m9.1`/`m9.5`/`m9.6`/`m10.1`/`m11`/`m11.1`/`lv2`/`postlv2`
  的**只读汇总门**也不在 `summaries` 里 —— `pnpm fast` / `--lane affected` 带不出它们，只能靠人记命令（正是 `R-39` 记的那类"接收停摆"）。
- **做了什么（只加清单，不改任何门本身）**：
  · 新 lane **`m9.6`**（3 道：`test` · `measurement:verify` · `audit-parser:verify`）—— 实测 **3/3 PASS（墙钟 1s）**；
  · 新 lane **`postlv2`**（10 道 S8 隔离库门）—— 实测 **8 PASS / 2 FAIL（墙钟 33.6s）**；
  · 新 lane **`lv2`**（5 道）与 **`summaries-all`**（`summaries` 的 21 道超集）—— 实测 **15 PASS / 6 FAIL（墙钟 15.3s）**；
  · `scripts/gates/affected-map.ts` 增两条规则：**storyline 面**（`story-cognition.ts` / `story-*.ts` / `kernel/app/storyline/**` /
    `kernel/storyline/**` / `contracts/storyline*.ts` / `content/storyline/**` / `scripts/postlv2-s8-*.ts`）⇒ 9 道 S8 门；
    **Lv2 面**（`evals/lv2/**` / `scripts/lv2-*.ts`）⇒ 7 道 Lv2 门。探针实测：三个 storyline 路径 + 两个 Lv2 路径**全部解析成功、`unmatched=0`**。
  · `pnpm gates:verify` = **PASS（51 项 / 0 失败）** · `pnpm typecheck` EXIT 0 · `pnpm gates:run --lane summaries` 仍是原来那 7 道（组成未变）。
- ⚠️ **为什么 `summaries-all` 单独一条 lane**：`summaries` 是被多份文档引用为稳定读数的快速体检（§8 记过"7/7 PASS"）。
  它**当下自身**是 **6 PASS / 1 FAIL**（`m5.1:gates` 承接 `m4.5` 的 `G14` FAIL —— `R-36` 已登记，**不是本批引入**）；
  再把 5 道**各里程碑的真 FAIL**并进去，会让那条命令"因为与本次改动无关的原因"变红 ⇒ 不并进去。
- ★ **当场抓到的一条新缺陷（本条的主要产物）**：`scripts/postlv2-db-verify.ts:57` 的
  **`LATEST_SCHEMA_VERSION = 11` 是硬编码**（真实库 2026-10-03 已在授权下迁到 **v13**），
  于是它印出的结论「而代码最新是 v11 ⇒ **v11 从未被应用到真实库**」**是错的**；
  叠加它读到的两份快照本身不一致（一份 `snapshot_dir_missing`、一份 v10）⇒ 判 **MEASUREMENT INVALID**。
  ⚠️ 这与 `L-S8-25`（**同一道门**的"过期期望"）**同族、但未被那次修复覆盖**（那次只改了"两态 + 一致性"判据，常量没动）。
  **只登记、未修**：修它要重新裁定这道门的判据（它的原始提问是 PL2-AI-01 的历史问题——"那次未授权打开有没有把库升到 v11"——不是常规回归门）。
- **另一条如实读数**：`postlv2:s8:measurement:verify` 的 `Q7` **按设计红** —— 金标语料**尚未人审** ⇒ 如实留 `AWAITING HUMAN REVIEW`
  （`L-S8-22`，不自签）；它的 `Q1–Q6`/`Q8` 全绿（`measured_count = 29`）。
- **本批的边界**：没有跑任何 live / 真模型门；**没有打开真实库**（`postlv2:db:verify` 只**只读**读 `data/snapshots` 里已落盘的快照；
  `postlv2:s8:activation-readback:db` **没有**被登记进任何 lane，也没有被运行）。

### R-41 · A-2：`TD-23` 本体 —— **两处聚合器的选档口径**都已落地（一处是别人顺带修的）

- **m10.1 侧（本轮修）**：新模块 [`scripts/m10.1-gate-select.ts`](../scripts/m10.1-gate-select.ts) 取代
  `m10.1-gates.ts:74` 的 `statSync(...).mtimeMs` 排序。信号**按强弱四段**取，并把用了哪一段**写进读数**：
  `reported-time`（自报 ended/finishedAt/generatedAt/started）→ **`head-commit-time`**（这份档测的是哪个提交，
  用**那个提交的提交时刻** —— `R-34` 自己用的判据）→ `evidence-commit-time`（同一 head 重跑时分先后）→
  `manifest-date`（日粒度，**最弱**）→ `none`（**具名降级**：只按 runId，并打印）。
  ⚠️ **v1 踩过的坑（如实登记）**：最初把 `manifest-date` 排在 git 时刻**之前**，于是同一天的档全部并列、
  又退回 runId 字典序 —— **恰好复现了 `R-34` 那个反例**（选到 `cf6d314c6c81` 那份 FAIL）。改对之后才通过。
- **非权威档过滤 + 并列失败关闭**（与 `m5.5.1-gates.ts` 的 `smallSample === true` 同一条纪律）：
  `dryRun === true` / `authoritative === false` 的档**被滤掉**（滤掉的档名进读数，不静默）；
  **时间并列且判定不同** ⇒ 该门报 **`AMBIGUOUS`（失败关闭）**，不许按字典序偷偷定一个。
  实测依据：`m10.1:activate` 有 4 份**同 head、同提交时刻**的档，其中 **8/9 FAIL 那份正是"干跑"**，
  而 mtime 时代被选中的就是它。
- **读数**：`pnpm m10.1:gates` = **必选门 18 道 · 有读数 18 · 未运行 0 · 未通过 0 · `overall = PASS`（EXIT 0）**
  （runId `m11-m10-1-wp8-gates-20261004-00c5bec80e34-02d0`）。`R-34` 的实测案例已修正：
  `m10.1:long:live (200)` 现在按 **head 提交时刻**选到 **`cc4957f8b775-5683`（PASS 11/11）**，
  而不是 mtime 并列时按目录名取到的 `cf6d314c6c81`（FAIL）。同时 `activation:readback` 由 8/13 变为 **13/13**。
  ⚠️ 2026-10-03 那份 `PASS` 读数**不改写**（它按 mtime 选到了另一批档）—— 两份**各有其选档依据**。
- **三段式（新增第 ⑤ 个检测器）**：`m10.1:measurement:verify` 从 **5/5 → 7/7**（PASS），
  用 `%TEMP%` 夹具驱动**同一个** `selectLatestReading()`：**正控**（自报结束时间更晚者胜）·
  **负控**（**把 mtime 反转**、且两份都没有时间戳 ⇒ 仍不按 mtime，并如实报 `basis=none`）·
  **负控**（干跑档被滤掉：正式档 FAIL 时**照样报 FAIL**，不因好看的档存在就选它）·
  **负控**（时间并列 + 判定不同 ⇒ `conflictingVerdicts=true`）· **恢复**（无候选 ⇒ `undefined`，不是默认选一个）。
- **m5.5.1 侧：已经修好了 —— 但不是本批修的，也不是为 `TD-23` 修的**（**本轮只登记**）：
  `scripts/m5.5.1-gates.ts` 的 `newestSemanticsEvidence()` 现按 `ended ?? started` → **该证据文件的 git 提交时刻** →
  `runId` 并列裁决，并**跳过 `smallSample === true` 的诊断档**；引入者是 **2026-10-03 的 `4005f360`**
  （提交信息是 Lv2 修复，**与本债无关**）⇒ `R-35` 那条"小样本诊断档被当成最新观测"的口径问题**已随之消失**。
  ✅ **本轮补上 `R-35` 留下的"未能确证"**：最新 `artifacts/m5.5.1/gate-results.json` 的语义槽位选的是
  **`step4-full-v2-prod`（收口正式批）**，`overall = PASS` ⇒ 它**不再**取 `td11-e12-r2` 那份诊断档。
- **仍开放的两条（不外推）**：
  ① **m5.5.1 的选档器没有专属三段式控制**（本批只给 m10.1 补了）；"跳过诊断档"目前只有 `R-35` 的实测读数与源码注释背书，
  没有"注入一份 diagnostic + 一份正式档 ⇒ 必须选正式档"的机器判据。
  ② `m4.5:gates` 的 `G14` 是**固定路径**证据 + 真 FAIL（`R-36`），**与选档无关**，本批未动（也不该动）。
  <br>⏩ **2026-10-04 修订（① 已闭合）**：选档器搬进 [`scripts/m5.5.1-gate-select.ts`](../scripts/m5.5.1-gate-select.ts)
  （`m5.5.1-gates.ts` 只留一层薄包装，**行为逐条不变**：跳过 `smallSample` · 自报时刻优先 ·
  缺失退 git 提交时刻 · 并列按 runId 降序），并在 `m5.5.1:measurement:verify` 新增 **§9 选档器自证**（`%TEMP%` 夹具驱动**同一个函数**）：
  · **正控**：自报 `ended` 更晚者胜，且**被选中的那份 runId 字典序更小**（证明不是按名字选）；
  · **负控（`R-35` 的形态）**：`smallSample: true` 的诊断档**即使时刻最新也不许被选中**，且被**具名**跳过；
  · **负控**：两份都没有时间戳 ⇒ **具名降级** `basis = none`（按 runId 裁决），**不偷用 mtime**；
  · **恢复**：不存在的证据根 ⇒ `null`（不是"选一个默认"）。
  读数：`m5.5.1:measurement:verify` **41/0 PASS**（原 37/0）· `m5.5.1:gates` 仍 **6/6 被接受 · overall = PASS**。 |

### R-42 · A-4：M9 的**当前树读数**已刷新（离线全绿；聚合仍 `NOT PASS`，如实）

- **做了什么**：`pnpm gates:run --lane m9 --mode release`（发布档：串行、不缓存、**保留证据**）
  + `pnpm m9:gates`（聚合门重算）。此前登记册/Lv2 引用的 `m9:gates` 读数是 **2026-09-27** 的。
- **读数（2026-10-04 · `artifacts/m9/gate-results.json` 的 `capturedAt` = `2026-10-04T04:08:23Z`）**：
  · **离线 12 道门 = 12/12 PASS**（墙钟 81s；新证据 `artifacts/m9/*-20261004-fa4099ea9d1e-*`）。
  · **聚合 `m9:gates` = `Hard Gates NOT PASS`**，`10/13 门权威读数为绿`（**此前登记为 11/13** —— 以本次为准）。
    非绿 3 道：**`m9:wp0:baseline` = `PENDING-AFTER-SAMPLE`**（3 run 中 2 非绿，**按设计**：基线在抽样后由 `m9:wp0r:verify` 接管权威）·
    **`m9:live:level1` = FAIL**（集内 2/9 非 PASS）· **`m9:live:long` = FAIL**（集内 4/4 非 PASS）。
    （`m9:wp0:admission` = `ACCEPTED (one-time)`：准入当时 PASS，建成后按设计翻红，权威 = `m9:wp0r:verify`。）
  · 在案 run 总数 **57**（含失败档与被取代档，**分列保留、不回写**）。
- **边界**：本步**只刷新读数**，不改任何 M9 判定、不动 live 集、不做真实库迁移；`M9 = PASS/NOT PASS` 的结论
  仍以 `docs/m9/M9-Gate-Decision.md` 为准（本步不替代它）。
- **对 Lv2 侧的影响（如实）**：`docs/lv2/Lv2-Deferred-After-Release-2026-10-03.md` 与 `Lv2-Known-Limitations` 里引用的
  "M9 聚合 11/13" 是**旧读数**；当前是 **10/13**，且原因已具名（见上）。**不改写**那两份文档的原文。

### R-43 · A-5：`TD-17` 拆项 —— M9 线的**性能基线探针**（只出读数 · 不判 SLA）

- **新增**：`scripts/m9-perf-baseline.ts`（`pnpm m9:perf:baseline`，已登记进 `M9_GATES` 与 `package.json`）。
  隔离库 + 零模型 + 零出网；测三条面：**形成**（`appendDomainEvent` + `applyMemoryEvent`）·
  **查询**（`listBeliefsByStatus`）· **上下文回查**（`buildBeliefContextSection` = 资格回查 + 遮蔽 + 去重 + 渲染）。
  每次操作同时记 **DB 调用数**与**返回行数**（把 `getRawDb(runtime).execute` 包一层计数器）。
- **⚠️ 它不判 SLA**（`TD-17` 的原话是"SLA 未冻结"）：退出码非零**只**表示"三段式控制失败"或"空集自检失败"。
  三段式是**针对量具自己**的：正控（三条面各 20 次、`dbCalls > 0`）· 负控（在 DB 句柄上注入 3ms/次 ⇒
  「查询」p95 至少抬高一个注入量、且 `dbCalls/op` **不变**）· 恢复（移除注入 ⇒ p95 回落到注入档之下）·
  **空集自检**（信念 = 0 时上下文面量的是零候选 early path ⇒ 判 `MEASUREMENT INVALID`，不把空集当读数）。
- **读数（2026-10-04 · 隔离库 · 23 条 Memory / 23 条信念）**：
  | 面 | p50 | p95 | DB 调用/次 | 返回行/次 |
  |---|---|---|---|---|
  | 形成 | 6.16 ms | 7.10 ms | 3 | 2 |
  | 查询 | 0.63 ms | 0.80 ms | 1 | 24 |
  | **上下文回查** | **54.6 ms** | **59.5 ms** | **119** | **141** |
  负控/恢复：`0.80 → 16.27 → 0.91 ms`（注入 3ms/次，`dbCalls/op` 1 → 1）。证据
  `artifacts/m9/m9-perf-baseline-20261004-01123e9d3504-34f7/`。
- ★ **当场量出来的实质发现（已登记、未修）**：**信念域的上下文回查是逐候选的 N+1 形状** ——
  23 条候选就要 **119 次 DB 调用 / 141 行**，而 p50 已经 **54.6ms**（线性外推：候选翻十倍即数百毫秒）。
  这与 `TD-17` 关心的"主链变慢 / N+1"是同一类（`M9-Execution-Plan.md` §22.4 的原话：
  "批读、去重、测 p50/p95"）。**只出读数**：修它属独立工作包（要动资格回查的批读形状），
  本批不动 —— 先有基线，才谈得上"冻结上限"。
- **一处踩坑（如实登记）**：v1 用**单会话**夹具 ⇒ 推断形成门槛（跨 ≥2 会话）永不满足 ⇒ 信念 0 条 ⇒
  上下文面量到**零候选 early path**（p95 0.93ms，看着"很快"，其实什么都没量）。
  这一版改成 2 会话 + 走**确定性 reported 路径**（`maybeRunBeliefMemoryReconciliation`，
  零模型）才拿到 23 条信念；那条无效读数按"失败档分列保留"留在 `artifacts/m9/…-aba4/`，**不回写**。
- **仍未做**：`TD-17` 的其它两项 —— **换模型**（不是编码档 A3）与 **UI 像素级验证**；
  §22.4 要求的"上限冻结"需要用户裁定（本门只提供读数）。

### R-44 · B-6：`TD-10` 的 **G-1 已闭合** —— "凭证被拒"不再被说成"未启用联网"

- **缺口原文（`§0m` 的 G-1）**：`permission_denied` 被**两条路径共用** ——
  ① 策略/开关（flag 关闭 ⇒ capability 未授予）②provider 401/403（ADR-046 `D-28` 的设计映射）。
  回复层把两者都读成 **`not_enabled`**（"联网没有启用"）⇒ **凭证被吊销/换错时，她告诉用户"没开联网"** = 说错失败原因
  （用户要换 key，不是打开开关）。`verify-td10-search-reliability.ts` 当时的 §3b 把这个最小复现**如实记成了缺口**（不是断言"应该如此"）。
- **修法（关键：**没有**推翻设计映射）**：`401/403 ⇒ permission_denied` 是 `D-28` **设计好的**，
  而且 `m5.5:measurement:verify` 把它当冻结判据断言着 ⇒ **provider 一个字节没改**（diff = 6 行注释）。
  真正的修点在**回复层**：provider 早就把 `details.status`（HTTP 状态）放进了失败，
  只是 `searchFactOf` 当时**只搬 `failureCode`、把状态丢了** ⇒ 回复层无从区分。
  现在 `ExternalEvidenceSearchFact` **追加**可选字段 `failureHttpStatus`（只取 `details.status` 这一个数字，
  **不搬运任何正文**，`TD-12` 的隐私边界不变），`replyStateOf` 据此判：
  **401/403 ⇒ `failed`（"搜索失败"）**；**没有状态（策略/开关，不经过 HTTP）⇒ 仍是 `not_enabled`**。
  ⇒ **不新增失败码、不改五态**（"失败"与"未启用"本来就在五态里）。
- **读数**：`pnpm td10:reliability` = **59 通过 / 0 失败 · PASS**（探针 ④/⑤ 的**用户可见态**由 `not_enabled` 改判 `failed`，
  provider 侧仍 `permission_denied`；§3b 从"缺口"改写为**闭合门**：真映射+真状态 ⇒ 失败 · 策略拒绝 ⇒ 未启用 · 两者如实句**不同**）·
  `pnpm td12:privacy` = **61/0 PASS** · `pnpm m5.5:test` = **59/0** · `pnpm m5.5:verify` = **46/0** · `pnpm m5.5:e2e:verify` = **25/0**。
  证据 `artifacts/td/td10-td12/reliability-offline.json`（本次运行的读数：57 → 59 项断言，`measurementInvalid=0`）。
- **⚠️ 一条**与本批无关**的当前红态（如实登记，**未修**）**：`pnpm m5.5:measurement:verify` 在本树上 =
  **243 通过 / 11 失败 · FAIL**。**归因已用实验排除本批**：把本批两个 `src/` 文件 `git stash` 掉后重跑，读数**完全相同**（243/11）。
  11 条分四类：① `ContextBudget.goalTokens` 正控收到 `undefined`（预算配置）②**冻结身份**子树漂移
  （`artifacts/m5` / `m5.1` / `m5.1.1` —— 后续里程碑一直在往这几个树里**追加证据**，"自冻结点起未变"这条判据
  在共享树上**必然翻红**）③ `main.ts` 静态接线检查 ④开发者面身份（`query-service.ts` 自 `e7d97cf` 起被别的会话改过）。
  ②③④ 都不是本批造成；①需要单独看（可能是别的会话在改预算装配）。**交维护线**。

### R-45 · `postlv2:db:verify` 的两处**假前提**已修（`R-40` 抓到的那条）

- **原文缺陷（`R-40` 记录）**：脚本里 `LATEST_SCHEMA_VERSION = 11` 是**手写常量**，而迁移清单早已到 0013
  （真库 2026-10-03 已在授权下到 **v13**）⇒ 它印出的"代码最新是 v11"是错的前提；
  由它推出的那句"**v11 从未被应用到真实库**"又是**过度外推**（本门读的是**历史时点快照**）。
  加上两个硬编码快照 id 已被保留策略剪掉 ⇒ 旧读数里"判定 INVALID + 仍无条件打印错结论"同时出现。
- **改法（三处，都**不扩大**本门主张）**：
  ① 版本号**从迁移清单读**：`await import('../src/infrastructure/persistence/migrations.ts')` +
     `latestSchemaVersion()`（该模块只依赖两个叶子模块、不跑迁移 ⇒ 不违反本文件的硬约束）。
     实测现在打印 `codeLatestSchemaVersion = v13`（此前是 11）。
  ② 结论**按快照口径措辞**并**按判定分支**：只在真出结论时才印
     "**在该时点的快照上** v11 那一行不存在"，并显式分列"代码当前最新 = v13（从清单读）·
     其后真库在**显式授权**下到 v13（属激活记录与 `INC-01`，**不在本门主张内**）"。
  ③ 快照缺失**具名**成 `SNAPSHOTS PRUNED`（不再被笼统的 `MEASUREMENT INVALID` 盖掉），
     并新增 `PL2_DB_SNAPSHOTS=<id1>,<id2>` 覆盖入口以便重跑。
- **读数（2026-10-04）**：
  · 缺省（原两个 id）⇒ `SNAPSHOTS PRUNED`，两个 id 都 `exists=false`，**exit 1**（如实：这次没测成，不是"测出来是 v11"）。
  · 覆盖成**现存**的两份快照（`…2026-10-03T10-25-53…` + `…2026-10-04T05-38-19…`）⇒ 只读打开成功：
    **v10（10 条）/ v13（13 条）**，`measured_count = 23` ⇒ `UNEXPECTED`（两份**彼此不一致** —— 这正是本门要报的形状）
    ⇒ **证明修复后的真路径可跑、`AT_CURRENT`/`UNEXPECTED` 分支可达**。
    ⚠️ 这份读数**不是**对 `PL2-AI-01` 的重新回答（换了一对快照，问题时点不同）；
    两轮证据见 `artifacts/post-lv2/postlv2-db-20261004073931-*` 与 `…073945-*`。
- **未做**：没有把"快照保留策略"与"这道门需要哪两份快照"接起来（那是 `INC-01` 维护线的取舍）；
  没有改 `V10 = 10`（它是**事故时点的已知基线**，语义正确）。

### R-46 · `m5.5:measurement:verify` 的 **11 条红全部修完**（243/11 FAIL → **260/0 PASS**）

- **先归因（用实验，不凭印象）**：上一批收尾时曾用 `git stash push -- <本批两个 src 文件>` 重跑，
  读数**完全相同**（243/11）⇒ 那 11 条**不是**上一批造成的。本轮逐条查清后，**没有一条**是"产品坏了"：
  四条全部是**量具自身**的问题（夹具过期 / 锚点被移走 / 判据把两件事混成一句 / 冻结点没跟上已登记的扩展）。
- **① 预算配置检测器（正控 + 恢复 2 条）**：夹具是**手搓的对象字面量**，只有 **5 个字段**，
  而 `ContextBudget` 的必填字段已长到 **8 个**（`rollupTokens`（M6 WP2，当时补过）·
  `goalTokens`（M10）· `adaptiveSelfTokens`（M11）· `commitmentTokens`（M10.1））
  ⇒ 检测器对着一份"字段缺失"的输入报 `ContextBudget.goalTokens ... 收到 undefined` —— **量的是夹具过期**。
  修法：夹具一律 `{ ...DEFAULT_CONTEXT_BUDGET, … }`（**单一真源**），并新增一条
  **防漂移判据**："逐个抹掉 `DEFAULT_CONTEXT_BUDGET` 的每一个键，检测器都必须响"
  （8 个字段全查过、0 个漏网）⇒ 下次再加字段会**自动被覆盖**，不会再红一次。
- **② 装配接线检测器（正控 + 恢复 + 静态 check 3 条）**：后 Lv2 · WP1 把五道守卫收进**唯一实现**
  `src/kernel/app/reply-guard-chain.ts`（`main.ts` 只留一次 `runReplyGuardChain({`）⇒ 原锚点在 `main.ts` 里
  必然找不到。**判据锚点变更（如实登记，不是放宽）**：顺序与"末道"改锚到唯一实现，
  "在写账本之前"留在 `main.ts`（只有它能证明这一层）。要守的性质**一条没少、还更强**：
  顺序断言从 3 道变 **5 道**（记忆 → 承诺 → 动作 → 外部证据 → 搜索判定结论），
  外加"`main.ts` 真的调用那个唯一实现"。单实现性另有更强的独立锁：
  `scripts/postlv2-entry-bridge-verify.ts` 的 **B11**（五个 applier 全仓各只有 1 个调用点）。
- **③ 冻结身份检测器（正控 + 恢复 + check 3 条）**：原判据 = 6 棵子树 `tree id` **逐字相等**，
  它把两件**性质不同**的事混成一句：**文档被改写**（真事故）与**读数产物被重新生成**（仓库纪律要求的动作，
  `AGENTS §3` 明说 `m5:gates` 等**都会重写**这些读数）。改成**两层分开量**：
  · **文档面**（`docs/m5`·`m5.1`·`m5.1.1`）：`--diff-filter=MD` 必须为空 ⇒ **实测 0 改 0 删**；
  · **工件面**（`artifacts/m5*`）：`--diff-filter=D` 必须为空（**不许删除**），读数允许重新生成
    且**在读数里列出被刷新的文件**（本次 9 份）⇒ 实测 0 删除；
  · **承重 blob**（记录的 10 份）：逐字相等，**除非**在新增的 `laterRefreshes` 里被点名
    （要求提交号 + 理由 + 该路径仍在 HEAD 上，且**只有它**享有例外）。
  实测：7 份文档/ADR blob **逐字未变**；唯一真漂移 = `artifacts/m5/gate-results.json`
  ← `31897f0e`（Tavily 时代的读数落地）⇒ 已**具名例外**写进 `artifacts/m5.5/baseline.json`。
- **④ 开发者面身份检测器（正控 + 恢复 + check 3 条）**：`src/infrastructure/dev/query-service.ts`
  被 **M9.5 WP5** 的 `ebc9c693` 改过（`+51 / -0`：把 `semantic_retrieval` 可用性从**硬编码**改成**读真实状态**，
  因为索引建好后硬编码会变成**主动错误**）。这次改动 **M9.5 侧已登记**
  （`docs/m9.5/M9.5-Activation-WP0-Handoff.md:16`/`:38` · `M9.5-Activation-Execution-Plan.md:317` ·
  `M9.5-Execution-Plan.md:495`）⇒ 按 **M6 WP5 的同一先例**给它挂**新的冻结点（`ebc9c693`）**：
  该文件改挂新组，其余 2 个 M6 WP5 文件仍锚 `e7d97cf`；`D-18②` 在 M5.5 当时成立的**历史结论一字不改写**。
  新增一条负控证明它**没有放水**："把 `query-service.ts` 错锚在 `e7d97cf` ⇒ 必须响"。
- **★ 顺带修掉的一类假绿（量具有效性问题）**：②③④ 原先的**负控都是"必然满足"的**
  （检测器本来就在报错 ⇒ "必须响"自然过）。修完后每个检测器的负控都**作用在正确的源上**：
  顺序负控改链源码 · 末道负控改链源码 · "写账本之后"负控搬 `main.ts` 的调用行 ·
  冻结身份新增"把工件子树/文档子树指到别的树"两条 · 开发者面新增"错锚冻结点"一条。
- **读数**：`pnpm m5.5:measurement:verify` = **260 通过 / 0 失败 · PASS**（`measurementInvalid=0`）·
  `pnpm m5.5:gates` = **Hard Gates PASS（G1–G5 全绿）**。
  证据：`artifacts/m5.5/measurement.json`（本次读数）· `artifacts/m5.5/gate-results.json`（聚合）·
  `artifacts/m5.5/baseline.json`（新增 `laterRefreshes` 具名例外 + 口径说明）。
- **边界**：本批**没有改任何产品代码**（改的是**门脚本**与 baseline 的例外台账）；
  没有新增/放宽任何"要守的性质"；没有打开真实库、没有联网、没有跑真模型。

### R-48 · `R-43` 那个 N+1 **已收口**（上下文回查 119 → **9** 次 DB 调用 · p50 54.6 → **8.2ms**）

- **改派依据（按登记册纪律显式改派为一个小 WP，不混进无关提交）**：
  `R-43` 原文写的是"修它属独立工作包，本批不动"。本轮把它**改派为** `R-48` 并要求它**自己重出 `m9:perf:baseline` 读数**（见文末读数）。
- **为什么这是"实现偏离契约"而不是设计选择**（这是敢修的依据）：端口契约**本来就写着批量** ——
  `job.ts`「按 id 批量读 Memory 当前状态」/「按 id 查对话账本」· `eligibility.ts:13`「批量去重读取（**不逐条 N+1**）」·
  M9 执行计划 §22.4「去重批量读取，避免逐 Belief N+1」。而实测每轮 **119 次 DB 调用**（23 条信念时）。
- **改了什么（两处追加 + 三处换调用，全部落在 `src/infrastructure/**`）**：
  ① **Memory 侧**：给 `MemoryStorePort` **追加** `getMany(ids)`（[`memory-store.ts`](../src/infrastructure/persistence/memory-store.ts)），
     内部 `hydrateMany()` 复用**同一批** `rowToRecordBase` 与三张索引表 ⇒ 每条 4 次查询压成**每批 4 次**；
     返回顺序 = 入参顺序、不存在的 id 给 `null`、守卫抛错照旧上抛（**语义与逐个 `get()` 逐条等价**）。
     这是对 M4 冻结文件的**追加能力**（`AGENTS §3` 明确允许），因此重跑了 `m4:*` 全套（见读数）。
  ② **事件侧**：给 [`conversation-store.ts`](../src/infrastructure/persistence/conversation-store.ts) **追加**
     `getConversationEventsByIds(ids)`，逐行走的仍是**同一个私有** `rowToEvent()` ——
     **不另起第二个 row mapper**（`trustedOrigin` 的解码边界全仓只有这一处，`goal-input-store.ts:16-19` 登记过漂移教训）。
  ③ 换调用：`belief-scheduler.ts` 的 `findMemories`/`findConversationEvents` ·
     `adapters.ts` 里 `buildBeliefContextSection` 的 `selectedMemoryIds` 循环（**那条在每轮对话路径上**：
     真实轮次的代价原本是 `119 + 4×|召回集合|`）。
- **读数（同一夹具、同一台机、隔离库、零模型）**：
  | 面 | 改前（`R-43`） | 改后 |
  |---|---|---|
  | **上下文回查** | p50 54.6ms · p95 59.5ms · **119 次 DB 调用** | **p50 8.2ms · p95 9.0ms · 9 次 DB 调用** |
  | 返回行数 | 141 | **141（不变 ⇒ 读的是同一批数据，只是少了 110 次往返）** |
  | 形成 | 6.16 / 7.10ms · 3 调用 | 7.8 / 9.6ms · 3 调用（噪声档） |
  | 查询 | 0.63 / 0.80ms · 1 调用 | 0.76 / 1.37ms · 1 调用（噪声档） |
  控制段 **5/5 PASS**。证据 `artifacts/m9/m9-perf-baseline-20261004-1b72bcf55ac8-e0a5/`。
- **正确性门（全绿，均为离线 / 隔离库）**：`m9` lane **13/13 PASS**（含新增的 `m9:perf:baseline`）·
  `m4:test` **259/0** · `m4:verify` **147/0** · `m4:mutation-safety:verify` **20/0** · `m4:nl-mutation:verify` **38/0** ·
  `memory-coverage:verify` **PASS 47/47** · `m3:verify` **67/0** · `m5.5:test` **59/0** · `m5.5:verify` **46/0** · `m5.5:e2e:verify` **25/0** ·
  `m5.5:measurement:verify` **260/0**（本轮刚修完）。
- **⚠️ 一条**与本改无关**的当前红态（已用实验排除，如实登记）**：`pnpm m5.1.1:k17:verify` = **14/2 FAIL**
  （`K-17 = BLOCKED`），红的是**6 个未分类的消费者文件**：`evals/m11/reflection-corpus.ts` · `scripts/m11-semantic-eval.ts` ·
  `scripts/postlv2-s8-contracts-verify.ts` · `scripts/postlv2-source-root-verify.ts` 等 —— **全是 M11 / post-Lv2 的产物**，
  而 M5.1.1 那套消费者登记表当年没给它们分类。**归因已用实验确认**：把本改的四个 `src/` 文件 `git stash` 掉重跑，
  读数**完全相同**（14/2、同样那 6 个文件）⇒ **不是本次造成的**。**交维护线**：要么补分类，
  要么按"审计已被后续里程碑取代"裁定收口。
- **未做 / 边界**：`reflection-source-read.ts:96-99` 与 `qualification-read.ts:140` **各有一份同形 N+1 副本**
  （S3 指出"同域三个副本"）——本轮**只修了信念域这一条**，那两处**未动**（它们不在本轮读数里，且各自有自己的调用语境）；
  没有改窄列读、没有新增第二个 row mapper、没有碰 `src/kernel/**` 与 `src/kernel/contracts/**`。

### R-49 · 另两处同形 N+1 收口（`R-48` 的姊妹副本）· 外加两条**与本改无关**的既存红

- **改了什么（两处，都是"换调用"，不新增读法）**：
  ① [`reflection-source-read.ts`](../src/infrastructure/persistence/reflection-source-read.ts)：根事件的受信读数原先是
     `Promise.all(roots.map(async id => await getConversationEvent(db, id)))` —— **每个根 1 次查询**；
     现在一次 `getConversationEventsByIds()` 批量取回（逐行仍走**同一个** `rowToEvent()`），再按位置映射。
  ② [`qualification-read.ts`](../src/infrastructure/persistence/qualification-read.ts)：`rootReadingsByMemory()` 的循环里
     逐条 `readingOfEvidence()`（**每条 1 次查询**）；现在把**对话事件**那一批 id 去重后一次取回、按 id 查表 ——
     输出顺序仍按 `rows` 的 `memory_id asc`，故事根仍一律 `undefined`（失败关闭语义不变）。
     私有助手由 `readingOfEvidence(db, id)` 改为**纯函数** `readingOfEvent(event)`（去掉了它自己那次查询）。
  ⇒ 两处**解码边界都没变**（`trustedOrigin` 仍只有 `rowToEvent()` / `processorEventViewOf()` 一条路）。
- **正确性门（全绿，离线 / 隔离库）**：`m11` 六道 = **34/0 · 44/0 · 25/0 · 18/0 · 18/0 · 37/0**
  （lineage / inputs / policy / invalidation / recovery / context）· `m9` lane **13/13 PASS** · `typecheck` EXIT 0。
- **⚠️ 两条**与本改无关**的既存红（已用 stash 实验排除，如实登记，未修）**：
  · `pnpm m6:verify --suite all` = **26/28 · FAIL 2**：`③-2 插入点位于 extraProviders 段内、编译器构造之前`
    （`extraProviders@-1`）与 `§2-4 ④ 降级等价于"没启用"：packet.text 逐字节相同`（len 3068 vs 3084）。
    **归因**：把本改的两个 `src/` 文件 `git stash` 掉重跑 ⇒ 读数**完全相同**（26/28、同样两条）。
  · `pnpm m6:gates` = **Hard Gates NOT PASS**（必选 17 · 未通过 2：`wp3-wiring` · `wp6a-faults`）——
    与 AGENTS 里"`m6:gates` = PASS（2026-09-26 修订读数）"**不一致**，是**当前树上的新红**。
  ⇒ 两条都交 M6 维护线：它们落在 M6 的读侧/装配面（`extraProviders` 段失效 + 降级/packet 字节等价被打破），
  本批只提供**可复现读数**（证据 `artifacts/m6/**20261004**`）。
- **边界**：本步**没有**改任何判据、没有新增读法、没有动 `src/kernel/**`；两处都是"同一语义、更少往返"。

### R-50 · `m5.1.1:k17:verify` 的 6 个未分类消费者**已补分类**（14/2 FAIL → **16/0 PASS**）

- **是什么**：这道门的判据 = "**每个命中 Axis B 名字的文件都必须被人工核对过**"。登记表在
  `scripts/verify-m5.1.1-k17-consumer-impact.ts:131` 的 `CLASSIFICATIONS`（字段 `file` / `klass` /
  `reason` / `wouldChangeLiveBehavior` / `readsWhichColumn`）。该表原先停在 M6/WP2，此后 **M11 的反思语料**
  与 **post-Lv2 的故事来源门**又新增 6 个命中文 ⇒ 门报两条红（"已分类"与 `K-17 = BLOCKED`）。
- **改了什么（**判据一个字未改**）**：`NEEDLES`、扫描范围（`src`/`scripts`/`evals` 下的 `.ts`）、逐行子串比对、
  裁决逻辑**全部未动**；只在表尾追加一个"**M11 / post-Lv2 追平**"小节（与既有 5 个追平小节同型），把 6 个命中逐个交代：
  · `src/kernel/storyline/world-observation.ts` = **D**（故事来源**自己的轴**的定义处：`storySourceAxes()` 里两根轴都是**字面量常量**）；
  · `evals/m11/reflection-corpus.ts` = **C** · `scripts/m11-semantic-eval.ts` = **C**（命中的是夹具字段 `sourceKinds`，
    它的取值域是 **`LineageSourceClass`**，与 Axis B 的 `conversation_events.source_kind` 是**两套词汇**，只有 `user_statement` 同名重叠）；
  · `scripts/postlv2-{s8-contracts,source-root,source}-verify.ts` = **D**（三个都是**门自身**：命中的是
    "把 `sourceKind: 'story_fact'` 传给构造器并断言它被**拒绝**"这类**负控**，以及隔离库里的 CHECK 约束测试 / 词汇表登记）。
  ⇒ **不是放宽**：分类字母对非 A 条目是**惰性**的（只有 A 类才读 `wouldChangeLiveBehavior`），这 6 条全 D/C ⇒ 对 `dangerous` 无贡献。
- **读数**：`pnpm m5.1.1:k17:verify` = **16 通过 / 0 失败 · `K-17 = PASS` · WP3 回填 = READY**（原 14/2）·
  命中 **65 文件**全部已分类（表 59 → **65**）· `typecheck` EXIT 0。
  证据 `artifacts/m5.1.1/wp2.2-k17-consumer-impact.json`（`generatedAt 2026-10-04`）。
- **⚠️ 顺手量到、**未修**的另一条（名字像、其实不同物）**：`pnpm m5.1.1:wp8:verify` 打印的
  **`K-17 分类完整性 = FAIL`** **不是**本表的完整性，而是 **WP8 自己的 verifier 注册表覆盖**
  （`verify-m5.1.1-wp8-harness.ts:206` 的 `unclassifiedVerifier`：`scripts/` 里命中 `DISCOVERY_NEEDLES`
  但既不在 `VERIFIERS` 注册表、也不在 `NON_VERIFIER_SCRIPTS` 例外里的脚本）。实测未登记 **25 个**
  （含 `m7-*` / `m8-*` / `m10-*` / `inc-01-regression.ts` 等 **M7 以来**的产物）⇒ 这条债**远大于** ① 的 6 个，
  且**与本改无关**（`git stash` 撤下本改重跑 ⇒ `wp8` 读数**完全相同**：46 通过 / 7 失败、同样那 25 个）。
  **交 M5.1.1/WP8 维护线**（要么逐条登记进注册表，要么裁定该注册表已被后续里程碑取代）。

### R-51 · `m4.5:gates` 的 **G14 从"固定路径"改成"按身份选当期读数"**（FAIL 26/18 → **PASS 52/0**）

- **原文缺陷（`R-36` 记录的）**：G14 读**固定路径** `artifacts/m4.5/smoke/smoke-result.json` ——
  那份是 **2026-09-30 刻意记录**的失败档（26 通过 / 18 失败，`S11.1–S11.3` 全红 = **量具空转档**）；
  而此后 M11.1 的长回归出过多次 **52 通过 / 0 失败**的当期读数，归档在
  `artifacts/m11.1/m111-full-live-regression-<runId>/`（带 manifest 的 `endedAt` + `head`）。
  ⇒ 聚合门长期显示 FAIL，而"当期真实读数在别处"。这与 `TD-23` 是**同一族**缺陷。
- **改了什么（判据本体一个字没改）**：新增 [`scripts/m4.5-gate-select.ts`](../scripts/m4.5-gate-select.ts)
  （取值：清单 `endedAt` → 清单 `head|headStarted` 的**提交时刻** → 证据提交时刻 → 清单 `date` → **具名降级**；
  **mtime 永不参与** · **刻意不看 verdict** · 并列判定不同 ⇒ 失败关闭），把 `m4.5-gate-results.ts` 的 G14
  从 `fromEvidence({file:'smoke/smoke-result.json'})` 换成 `g14Result()`；判据仍是 `status==='PASS' && failed===0`。
  证据来源**按优先级**且**如实落盘**：`archived-smoke`（归档原始档）→ `archived-gates`（归档聚合的 G14 行）→
  `local-hash-verified`（gitignored 的 `local/<runId>/smoke-result.json`，**必须** sha256 与清单
  `privateSmokeSha256` 逐字相符才采用）。
- **读数**：G14 = **PASS · 52 通过 / 0 失败**（选中 `…-0b0bcdca`，`basis=reported-time`，来源 `archived-gates`）·
  `pnpm m4.5:gates` **EXIT 0** · 连带 `pnpm m5.1:gates` 的 `M45-G` 由 `G14=FAIL` 变 **`G12=PASS G13=PASS G14=PASS`**
  （Hard Gates = PASS）。
- **三段式（新增，`AGENTS §6.7`）**：`m4.5-gate-results.ts` 里加了 **G14 选档器自证 5/5**（`%TEMP%` 夹具，
  与上面那条读数**互不影响**）：**正控** = 更晚的 `endedAt` 胜、赢家 runId **字典序更小**（不是按名字选）、
  且赢的那份是 **FAIL**（⇒ **不偷看 verdict**）；**负控①** = 两份都没有时间戳 ⇒ `basis=none`/`degraded=true`，
  并把 mtime 反转也不跟着 mtime 走；**负控②** = 时间并列且判定不同 ⇒ `conflictingVerdicts=true`；
  **恢复** = 零候选 ⇒ 回落固定路径并具名（`source=fixed-path`、`degraded=true`）；**计数自检** = 真量到夹具。
- **⚠️ 历史档分列（不抹掉）**：G14 行里带 `historical` 数组，列出固定路径那份 **FAIL 26/18**、
  最后提交 `6a6367a8`、以及"刻意保留、不回写（TD-16 / R-36 / R-50）"的理由
  ⇒ **"当期 PASS"与"历史 FAIL"在同一份证据里都看得见**。
- **⚠️ 顺手量到的状态行滞后（未改，交维护线）**：`pnpm lv2:inherited:gates` 当前 = **10/16 · FAIL**，
  非 PASS 6 行（M4 / M4.5 / M5.1 走 2026-10-03 的**归档回归** `lv2-wp6-repair-regression-20261003-…`；
  M6 = `wp3-wiring`+`wp6a-faults`；M9 = 10/13；M11.1 = NOT PASS），而 **AGENTS 的状态行写的是"继承门现 14/16，
  未 PASS 只剩 M9 · M11.1"** ⇒ 与当前读数**不一致**（同 `L-M61-12` 那类"状态行滞后"）。
  **归因实验**：把 `artifacts/m4.5/gate-results.json` 还原成 G14=FAIL 再跑 ⇒ 仍 **10/16、同样 6 行**；
  换成当期读数（G14=PASS）也是 10/16 ⇒ 这 6 行**不读**这份证据，**与本改无关**。
- **边界**：本步**没有**重跑 `m4.5:smoke:live`（真模型、需 key）；**没有**把 52/0 回写进固定路径（那会抹掉历史失败档）；
  没有改 G14 的判据本身，也没有改其它门的读法。

### R-52 · `L-M97-02` 的**问句守卫已做**（`content-rules@7`）—— 独立小项，含三段式与反例组

- **原文缺陷（`L-M97-02`）**：抽取器**没有问句守卫** ⇒ 一句问句只要**同时**带抽取意图词就会被记成事实。
  实测形态：「记住，我的生日是**什么时候**」→ `person.birthday = 什么时候`（今天已被取值层的
  `VALUE_STOP_SET` 挡住）；而「记住，我实验室在**哪个楼**」这种**取值形态不在**那个集合里 ⇒ 旧代码**真的会写坏值**。
- **判据形状（窄两级，宁可漏不要误杀）**：新增导出的纯函数 `isQuestionLike(text)`（`content-extractor.ts`）：
  ```text
  ① 句尾形式：末字符 `？`/`?`；或末字符 `吗`/`呢`（且整句不是以 `什么/怎么/那么/多么` 收尾）
  ② 疑问词 + **非任指语境**：命中 QUESTION_WORDS 且**不**落在任一豁免语境：
     前邻 `都/也/随便/无论/不管/任何`（任指）· 前邻 `没/不/别`（否定）· 落在成对引号内（引用）· 整句以 `！` 收尾（祈使）
  ```
- **插在哪（覆盖显式 + 未来的后台路径）**：① `RuleBasedContentExtractor.extract`（规则匹配**之前**，
  且在 ADR-089 设备更正白名单**之后** —— 不动那个窄特例）；② `LlmContentExtractor.extract`（构造 prompt **之前**
  ⇒ 问句既不进模型、也不多花一次调用）；③ **镜像到后台路径** `extractor.ts` 的
  `RuleBasedMemoryExtractor.process` 与 `LlmMemoryExtractor.process`（后台走的是**另一张线索表** `RULE_CUES`，
  不镜像则 `TD-19` 接上后仍漏）。**不新增失败码**：问句 ⇒ 返回 `undefined` ⇒ 服务回 `content_unresolved`。
- **版本**：`CONTENT_RULE_VERSION` **`@6 → @7`**（该文件自己写着"任一改动都必须升版本"—— 它改的是"哪句话会被抽"，
  不是可选项）。
- **三条不许踩的线（逐条来自实测/裁定）**：**不复用 `VALUE_STOP_SET` 当问句词表**（它含 `了/吧/呢/吗`，
  会误杀「还是叫我阿林吧。」这类合法陈述）· **不用 `negativeGuards` 表达**（ADR-088 §6.4 两次打回：
  它不阻止命中）· **不放宽 `requiresLeading`**（`LV2-D11` 冻结裁定）。
- **三段式（`AGENTS §6.7/§6.8`，落在 [`extractor-value-boundary-verify.ts`](../scripts/extractor-value-boundary-verify.ts) §6）**：
  · **正控（问句沉默）5/5**：`q-lou`「记住，我实验室在哪个楼」· `q-shihou-ne`「…是什么时候呢」·
    `q-zhuanye-ya`「…是什么呀」· `q-university`「…在哪所大学读书？」以及**单列注明"零分辨力"**的
    `q-probe-known`（它今天已被 `VALUE_STOP_SET` 挡住 ⇒ **不许拿它当新守卫的证词**）；
  · **负控（摘掉守卫必须又抽出来）**：新增**具名测试缝** `createRuleOnlyContentExtractorWithoutQuestionGuard()`
    （照 ADR-080 `D-80f` 先例）⇒ 上面前 4 条**真的又**抽出来了；
  · **反例组（不得误杀）8/8**：含「吧」「了」的 4 条**必须照常抽到** + 任指/否定/祈使/引用 4 条**行为与守卫前一致**
    （判据两条一起：**没被判成问句** 且 **抽到与否与期望相符**）；
  · **计数自检**：反例组为空 ⇒ `MEASUREMENT INVALID`。
- **读数**：`pnpm extractor:value-boundary:verify` = **PASS**（用例 8 条一致 8 · 正控 3 · 修好 3 · 特征化未修 2；
  §6 问句沉默 **5/5** · 反例组 **8/8**）· 证据 `artifacts/extractor-value-boundary/**20261004**`。
- **回归面（全绿，均为离线 / 隔离库）**：`m4:test` **259/0** · `m4:verify` **147/0** ·
  `memory-coverage:verify` **47/47 PASS** · `memory-coverage:e2e` **46/46 PASS**（⇒ **没有被误杀**：46 喂仍写 27）·
  `m6.1:extractor:repro` **PASS**（ADR-056 冻结 7 句逐字段一致）· `lv2:diagnose:memory` **7/7 PASS**
  （含 `F4` 正控「还是记一下吧：我的实验室在 A 楼 302。」）· `eval:m4:extraction` **3/0**。
- **⚠️ 一条**与本改无关**的既存读数**：`pnpm m6.1:extraction-audit` 的 `verdict = FAIL（28 条被审 · 需人读 6 条 · 负控全过）`
  —— 它 `exit 0`（"需人读"是**咨询性**判定，不是门失败），且用 `git stash` 撤下本改后**逐字相同** ⇒ 与本改无关。
- **边界（不外推）**：本守卫只挡"**整句是一个问句**"这一种形状；**残余仍在** `L-M97-02` 里 ——
  引用 / 否定 / qualifier 表达不了的那部分、以及"陈述句里夹一个问句片段"都不在覆盖内（`DR-11`：
  它不主张"她不会再记错"）。**没有**改 `VALUE_STOP_SET` 内容、**没有**改槽位线索表（`ADR-056 §5` 禁止混做）、
  **没有**动冻结语料（`memory-coverage` 的语料/清单未改，`@6→@7` 只影响 `basis` 文本）。

### 本批的**边界声明**（不外推）

```text
· 本批（两轮）**以文档与清单为主**，但"只做文档"这句**早已不成立**，如实列出**全部代码面改动**：
  ① **A-3（`R-40`）清单层**：`scripts/gates/manifest.ts`（+4 lane / +17 登记）与 `scripts/gates/affected-map.ts`（+2 规则）
     —— **没有改任何门本身、没有改任何判据**。验证：`pnpm gates:verify` **PASS（51/0）**。
  ② **A-2（`R-41`）选档器**：新增 `scripts/m10.1-gate-select.ts`，改 `m10.1-gates.ts`（不再按 mtime）
     与 `m10.1-measurement-verify.ts`（+第⑤检测器）。**只改"读哪一份证据"**。
  ③ **A-5（`R-43`）探针**：新增 `scripts/m9-perf-baseline.ts` + 登记进 `M9_GATES` / `package.json`（**只出读数、不判 SLA**）。
  ④ **B-6（`R-44`）**：`external-evidence-reply.ts` 追加 `failureHttpStatus`，把"凭证被拒"与"未启用联网"分开；
     `tavily-search-provider.ts` **只加注释**（`D-28` 设计映射未动）。**不新增失败码、不改五态**。
  ⑤ **`R-45`**：`scripts/postlv2-db-verify.ts` **版本号改从迁移清单读**（原本硬编码 11）· 结论按快照口径分词 ·
     新增具名 `SNAPSHOTS PRUNED` 与 `PL2_DB_SNAPSHOTS` 覆盖入口。
  ⑥ **`R-46`**：`scripts/verify-m5.5-measurement.ts`（**四处量具修复**：预算夹具改为从 `DEFAULT_CONTEXT_BUDGET` 展开 +
     防漂移判据 · 守卫链锚点改到唯一实现 `reply-guard-chain.ts` · 冻结身份改**两层判据** ·
     开发者面给 M9.5 WP5 的登记扩展挂新冻结点）+ `artifacts/m5.5/baseline.json`（新增 `laterRefreshes` 具名例外台账）。
     **没有改任何产品代码、没有放宽任何性质**。
  ⑦ **`R-41` 的 ⏩ 修订（选档器三段式控制）**：新增 `scripts/m5.5.1-gate-select.ts`（从 `m5.5.1-gates.ts` 抽出，
     **行为逐条不变**）+ `verify-m5.5.1-measurement.ts` 的 §9 三段式（读数 **41/0**）。
  ⑧ **`R-48`（N+1 收口）**：`memory-store.ts` 追加 `getMany` · `conversation-store.ts` 追加 `getConversationEventsByIds` ·
     `belief-scheduler.ts` / `adapters.ts` 换调用。**两处都是"只追加能力"**，语义与逐个读逐条等价。
  ── 第二轮（用户 2026-10-04「1234 全部做」，提交 `19410e15` / `8f567be2` / `6119ae1e` / `02a8cebf`）──
  ⑨ **`R-49`（另两处同形 N+1）**：`reflection-source-read.ts` 与 `qualification-read.ts` 改成一次批量取回
     （逐行仍走同一个 `rowToEvent()`）；私有助手改纯函数。**语义逐条不变**。
  ⑩ **`R-50`（`k17` 补分类）**：`scripts/verify-m5.1.1-k17-consumer-impact.ts` 的表尾**追加 6 条**（M11 / post-Lv2）、
     追加一个"追平小节"；`NEEDLES`/扫描范围/比对/裁决**一字未改**。读数 14/2 → **16/0 PASS**。
  ⑪ **`R-51`（G14 选档）**：新增 `scripts/m4.5-gate-select.ts`，`m4.5-gate-results.ts` 的 G14 改成按身份选当期读数 +
     **历史档分列** + **选档器自证 5/5**；G14 由 FAIL 26/18 变 **PASS 52/0**。判据本体未改。
  ⑫ **`R-52`（问句守卫，`L-M97-02`）**：`content-extractor.ts` 新增 `isQuestionLike()` + 具名测试缝；
     插在**四处**（规则 + LLM · 后台规则 + LLM）；`CONTENT_RULE_VERSION` `@6 → @7`；
     `extractor-value-boundary-verify.ts` 新增 §6 三段式（问句沉默 5/5 · 反例组 8/8）。
· 本批实测**全是离线门**（`m4:test` 259/0 · `m4:verify` 147/0 · `m4:mutation-safety` 20/0 · `m4:nl-mutation` 38/0 ·
  `memory-coverage:verify` 47/47 · `m3:verify` 67/0 · **M9 lane 13/13** · `m10.1:gates` 18/18 ·
  `m10.1:measurement:verify` 7/7 · `m5.5:measurement:verify` **260/0** · `m5.5.1:measurement:verify` **41/0** ·
  `m5.5:test/verify/e2e` 59/0 · 46/0 · 25/0 · `td10` 59/0 · `td12` 61/0），
  **都只开隔离库**（`isolateDatabase`）或**只读快照副本**，**没有**打开真实库、**没有**跑 `m4.5:ci`、**没有**跑任何 live / 真模型门。
· **销账 4 条**：**`TD-10` G-1**（`R-44`，"凭证被拒"不再被说成"未启用联网"）·
  **`R-43` 的信念域 N+1**（`R-48`，119 → 9 次调用 / 54.6 → 8.2ms）·
  **`k17` 的 6 个未分类消费者**（`R-50`，14/2 → 16/0 PASS）·
  **`L-M97-02` 的问句守卫**（`R-52`，`content-rules@7`）。
  "由红转绿"另有三条：**M4 S3-1 的 `T32`** · **`m5.5:measurement:verify` 的 11 条**（`R-46`）· **G14**（`R-51`，FAIL 26/18 → PASS 52/0）。
· **未修、但已如实登记的当前红态（都带归因）**：
  · `m9:gates` 聚合 = **10/13**（两个 live 集 FAIL，按设计保持；`wp0:baseline` = PENDING-AFTER-SAMPLE）—— `R-42`。
  · `postlv2:s8:measurement:verify` 的 Q7 红（`AWAITING HUMAN REVIEW`，按设计）—— `R-40`。
  · **`m6:verify --suite all` = 26/28**（`③-2` 插入点 + `§2-4` 降级字节等价）与 **`m6:gates` = NOT PASS**
    （`wp3-wiring` · `wp6a-faults`）：**已用 stash 实验排除本批** ⇒ 交 M6 维护线（`R-49`）。
  · **`m5.1.1:wp8:verify` = 46/7**：其中"`K-17 分类完整性`"那一行其实是 **WP8 自己的 verifier 注册表**覆盖，
    未登记 **25 个**（M7 以来）—— 与本批无关（已排除）⇒ 交 M5.1.1/WP8 维护线（`R-50`）。
  · **`lv2:inherited:gates` = 10/16**（M4/M4.5/M5.1 走 2026-10-03 归档回归 · M6 · M9 · M11.1）——
    与 AGENTS 里"继承门现 14/16"**不一致**，是状态行滞后（`R-51`）。
  · `m6.1:extraction-audit` 的 `verdict = FAIL（需人读 6 条）`（咨询性、`exit 0`，已排除本批）—— `R-52`。
· 本批**不主张**"债清完了"：真开放的仍按 §1–§5 与各里程碑局限册分列。
```

---

## 0q. 第十七批（2026-10-04）：**Lv4.5 精简计划的 P1** —— 取消/播放事实真正通了，但只到"账"这一层

> 载体：`docs/post-lv2/Lv4.5-Lean-Execution-Plan-2026-10-04.md`（用户指令「按计划书执行」）。
> 本批只做 **P1 的接线与离线证据**；**P2 / P3 / P4 一行没动**，20 次真实链路与真人体验一次没跑。
> 进度与残余另见 `docs/post-lv2/Lv4.5-Execution-Progress.md`（本批新建）。

**做成了什么（逐条可核对）**

```text
① 传输层解耦（P1 的第一件事，也是"用户抢话能立刻停"的地基）
   旧：`runBridgeTransport` 是"读一行 → await 整条处理完 → 写回一行"的单循环
       ⇒ 一轮慢请求（模型等 5–20 秒）期间，外壳随后发来的消息**躺在 stdin 里**
       直到那一轮结束 —— `L-PL2-04` 的取消只是**账上记下了意图**，收不到。
   新：控制消息（`CANCEL_TURN` / `REPORT_SYNTHESIZED` / `REPORT_PLAYBACK`）读到**立即**处理、
       与在途轮次**并行**；正式轮次（`SUBMIT_TURN`）走**独立串行泵**（D12 的"正式写入串行"不变）。
       分类的答案**只有一处**（`isBridgeControlMessageKind`），传输层不做语义判断。
   读数（`pnpm postlv2:transport:verify` T9，真异步任务触发竞争）：
       控制消息先写回 · 取消时延 **0–1 ms**（同一轮耗时 ≥ 60 ms）· 在途控制峰值 ≥ 1 · send 次数 = 1。
② 受控消息登记表 2 → 4（新增 `REPORT_SYNTHESIZED` / `REPORT_PLAYBACK`，Lv4.5 / P1）
   两条都是控制消息（不排队）；未登记种类照旧 `bridge_unknown_message_kind`。
③ 交付账本体 `src/kernel/app/bridge/voice-delivery-ledger.ts`（**进程内**，不写库、不新增 schema）
   · 状态推进**只有一处**：复用 `media-delivery.ts` 的 `advanceSegment` + 迁移表；
   · 中间跳**由迁移表 BFS 推导**（`pathBetween`），**不手写捷径表**（手写的一定会与迁移表漂移，
     而漂移方向恰好是放宽禁令）；
   · 交付侧另加一条本模块判据：**账上还没有"这一段被合成过"就不受理播放回报**
     （`playback_report_before_synthesis`）—— 因为通用迁移表是"乐观"的，
     BFS 会给出 `generated → synthesized → queued` 这条**存在**的路，
     而那等于让"客户端报了一句播放"顺手把"合成完成"也写进账（契约 §1 第一条禁令的反面）；
   · 重复 / 乱序 / 冒充一律**安静忽略**并带具名码（`playback_report_stale_or_duplicate` /
     `unknown_segment` / `without_segment` / `unknown_state`），**不抛、不回退**已确立事实。
④ 播放事实**真的回账**：浏览器 →（HTTP `POST /lg/playback`）→ 皮套服务 →（NDJSON）→ LG 交付账
   · 浏览器侧（`scripts/postlv2_speech_client.js`）在**真实状态变化**时才报：
     收到真实音频 ⇒ `synthesized`（带 audioId）· 真的排上 Web Audio 时钟 ⇒ `playing` ·
     真的播完 ⇒ `played`（带客户端时钟区间）· 被顶掉/停止 ⇒ `cancelled` · 出错/断连 ⇒ `unknown`；
   · 为什么走 HTTP：上游 WebSocket 入站处理器属于冻结的 patch 锚点，
     而这条回报是**单向、幂等、不需要回复**的；失败一律吞掉，**不影响播放**；
   · 离线读数（`node scripts/postlv2-streaming-verify.mjs`，真播放器 + 模拟 Web Audio 时钟）：
     **11/0**（原 7 条 + 新增 4 条：三段事实回账 · 没出声的句子报 cancelled · 回报通道坏掉播放照常 · 断连报 unknown）。
⑤ **交付视图**接进 LG 上下文（契约 §2 `M11`）：`applyVoiceDeliveryView` 只改**视图**
   · 账未接入 ⇒ 逐字不变（CLI / 干跑 / 各门行为不变）· 账上未播 ⇒ **整行撤掉** ·
     只播一部分 ⇒ **只留已播出的部分** · 整段播完 ⇒ 原样 · 用户行不受影响；
   · 生成记录**一个字都没删**（`conversation_events` 不动，删的只是视图里的一行）。
   · 读数（`pnpm postlv2:bridge:verify` B13，打在**真实落库的那条助手事件**上）：
     未接入 1 行 / 未播 0 行 / 只播前两段 = `"收到：你好，"` / 整段播完 1 行 / 用户行 1 行 + `main.ts` 静态接线两条。
```

**本批改动清单（按路径）**

| 路径 | 改了什么 |
|---|---|
| `src/infrastructure/bridge/turn-bridge-transport.ts` | 控制消息与耗时轮次解耦；`sessionHost` 增加 `delivery` 端口 |
| `src/kernel/app/bridge/turn-bridge.ts` | 登记表 4 种；播放/合成回报端口与线上形状；`isBridgeControlMessageKind` |
| `src/kernel/app/bridge/voice-delivery-ledger.ts` | **新增**：进程内交付账 + `applyVoiceDeliveryView` |
| `src/main.ts` | `--bridge` 分支建交付账并**在构造会话之前**注入；最近对话改用交付视图 |
| `scripts/postlv2_speech_client.js` | 三类播放事实 + 一类合成事实回账（`POST /lg/playback`） |
| `scripts/postlv2_vtuber_runtime.py` | `POST /lg/playback` 入口；桥客户端支持 `SYNTHESIS_RESULT`/`PLAYBACK_RESULT` 与单向回报 |
| `scripts/postlv2-transport-verify.ts` | T6 判据改"显式登记"；新增 **T9**（解耦）· **T10**（合成账+播放回报）· **V2**（三段式） |
| `scripts/postlv2-entry-bridge-verify.ts` | B4 判据改"显式登记"；B9 判据**收紧**（见下）；新增 **B13**（交付视图） |
| `scripts/postlv2-delivery-verify.ts` | `notClaimed` 两条**已过时**的措辞按实现更新（不再写"桥没有取消通道"） |
| `scripts/postlv2-streaming-verify.mjs` | 新增 4 条播放事实回账判据（含负控） |

**判据收紧一处（值得单独记）**

`B9` 原来断言"`turn-bridge.ts` 的代码里不出现 `'played'` 这个词"。这条判据在 P1 之后**必然**翻红，
但它量错了东西：`played` 必须能出现在**受控词汇表**里（否则无法接收真实播放事实）。
要守的性质是"`delivery` 这个**交付真相字段**的闭集里没有 `played`"。已改成：
`DELIVERY_TRUTH_STATES = ['generated','rejected','failed']` 不含 `played` +

- 实测三档 delivery 值都不等于 `played`。**性质没放宽，量具换成了量对的东西**。

**本批实测读数（全部离线；未跑 `m4.5:ci`、未开真实库、未跑任何真模型/live 门）**

```text
pnpm typecheck ................. 见「既有失败」一条（本批文件 0 错误）
pnpm postlv2:bridge:verify ..... PASS（measured 109；含新 B13）
pnpm postlv2:transport:verify .. PASS（measured 59；含新 T9/T10/V2）
pnpm postlv2:delivery:verify ... PASS（measured 34）
pnpm postlv2:speech:verify ..... PASS（measured 20）
pnpm postlv2:body:verify ....... PASS（measured 55）
pnpm postlv2:avatar:verify ..... PASS（checked=true）
pnpm postlv2:expression:verify . PASS（适配器 11/11）
node scripts/postlv2-streaming-verify.mjs ... pass 11 / fail 0
```

**本批未做 / 未主张（如实分列）**

```text
· P2（流式输入与提前准备）· P3（有限插话与纠正）· P4（一次联合验收）：**一行没动**。
· 计划 §3 第一步要的"一个统一协调脚本 `pnpm postlv2:realtime:verify`"：**未建**。
  本批的新增判据落在**既有门**里（transport / bridge），没有为每项能力另造一套门体系。
· **20 次真实链路测试一次没跑**；真人体验、真实麦克风、真实声卡播放**全部 `NOT RUN`**。
  （计划 §4.6：进入模型/麦克风测试前要按用户对游戏占用的安排先联系用户。）
· 播放回报的**端到端**读数（浏览器真的 POST 到皮套服务再进 LG 账）**NOT RUN**：
  本批证明的是"两端各自的判据 + 协议形状对齐"，不是"这条线真的在浏览器里通过一次"。
· 浏览器侧改动还没**重新构建**（`scripts/postlv2-expression-frontend.py` 会把
  `postlv2_speech_client.js` 拷进冻结前端源并 `npm run build:web`）；未重建 ⇒ 现有 12393 页面
  跑的还是旧 bundle。**这是交付前必须做的一步**。
· 合成账的 `audioId` 目前是**客户端观察所得**的内容派生标识（`<segmentId>@<text_sha256 前 12>`），
  不是 TTS 服务侧的原生音频 id —— 足以做对账键，但**不能**拿它去索引音频文件（未主张）。
· `speech_bridge.py`（`pnpm postlv2:speech:verify` 的被测客户端）住在仓库之外
  （`C:\Users\user\postlv2-deps\speech_bridge.py`），**不在 git 里**：本批**没有**改它，
  它的门照旧 PASS；这是一条既有的可复现性缺口，本批只登记。
```

**既有失败（与本批无关，已排除；不越界修复）**

```text
· `pnpm typecheck` 当前 EXIT 2，错误**全部**在别的会话在途的改动上：
  `scripts/verify-m5-budget.ts`（11 条）与 `scripts/m10-context-verify.ts`（1 条），
  根因是 `src/kernel/recall/selector.ts` 新增了 `ContextBudget.turnContentTokens`
  而这两处的字面量预算没跟上。本批改动的文件（`src/main.ts` / `src/kernel/app/bridge/**` /
  `src/infrastructure/bridge/**` / `scripts/postlv2-*`）**零错误**。
· `pnpm postlv2:db:verify` = `SNAPSHOTS PRUNED`（EXIT 1）：它要的两份快照
  （`pglite-2026-10-03T07-23-35-901Z-…` / `…T08-48-59-356Z-…`）已被保留策略清掉 ⇒
  **本次没有重测**（不是"测出来是 v11"）。与本批无关，旧读数不回写。
```

---

## 0r. 第十八批（2026-10-05）：第二批实用能力的**生产事故** —— 当轮内容超单轮上限把整轮打死

> 载体：[`Productivity-Skills-Turn-Content-Overflow-Fix-2026-10-05.md`](post-lv2/Productivity-Skills-Turn-Content-Overflow-Fix-2026-10-05.md)
> （事故 + 修法 + 读数 + **不主张**）。残余进
> [`Productivity-Skills-Known-Limitations.md`](post-lv2/Productivity-Skills-Known-Limitations.md) 的 `L-PS-48…50`。
> 触发形态是**头像实测**（`--mode sandbox-copy`，生产库副本），不是假想场景。

### R-53 · 任务环一轮产出 10 份当轮内容 ⇒ `turn_content_list_invalid` ⇒ **整轮失败**（用户什么都得不到）✅ 已修复

**事故读数（逐条可核对）**

```text
2026-10-05 14:43:51  用户（语音）："还有一件事，能不能帮我查看一下我的电脑桌面上有几个快捷方式？"
2026-10-05 14:44:16  外壳：LG rejected or failed: turn_content_list_invalid（25 秒后，整轮中止）

trace 30b967d8-a2f6-4f77-8a0b-5e8510e8661a：12 个动作，全部 local.file.list
  · C:\Users\Public\Desktop   成功 × 6
  · C:\Users                  成功 × 4
  · C:\Users\user\Desktop               失败 × 1   ← 模型**猜**的用户名
  · C:\Users\Administrator\Desktop      失败 × 1   ← 同上
⇒ 10 份当轮内容 > TURN_CONTENT_LIMITS.maxItemsPerTurn = 6 ⇒ 契约断言抛错 ⇒ 整轮失败
```

**根因（三层，缺一个都解释不了这条事故）**

```text
① "帮我…" ⇒ looksLikeTask + CHARACTER_TASK_AUTONOMY_ENABLED=true ⇒ 任务执行环（这一步是对的）
② 规划器**看不到内容**：回给它的"已执行"只有 `local.file.list.list=success`
   （没有路径、没有条目数、没有指纹）⇒ 它既无法去重、也不知道用户目录叫什么
   ⇒ 同一个目录列 6 次 + 猜两个用户名，直到规划预算（6 次）用光 —— **不可能收敛**
③ 份数是**抛错**（不是按额度丢弃），而 MAX_STEPS_PER_PLAN=8 > maxItemsPerTurn=6、
   任务预算 30 次行动 ⇒ 越顶在结构上随时可达 ⇒ 一个**运行约束**把**整轮**打死
④ 桥的 catch 只回具名码 ⇒ 原因（"一轮最多 6 份内容，收到 10"）被丢掉 ⇒ 只能读账本原始字节复原
```

**修法（六处，逐条可核对）**

```text
① turn-content.ts  新增纯函数 aggregateTurnContentForTurn()：同源+同指纹去重（留第一份、保序）
                   + 超上限**如实丢弃并计数**；⚠️ 逐份契约仍硬（对**全部**候选逐份断言，
                   被丢掉的也不例外 ⇒ 降级不掩盖生产者缺陷）
② turn-gateway.ts  收集点改用汇聚；读数落 IncomingTurn.turnContentAggregation；
                   turn_content 步的 candidate_count 记**降级之前**的候选数，另加
                   kept_count / aggregate_duplicate_dropped_count / aggregate_limit_dropped_count；
                   真丢东西时往 **stderr** 印一行
③ task-loop.ts     回给规划器的摘要**带引用**（path=/url=/query=，单行、≤160 字符、只收引用不收正文）；
+ task-plan.ts     整份计划都是"已经成功过的引用 + 同一个操作"⇒ 如实停止
④ task-authorization.ts  TaskCloseReason **具名追加** `no_progress`（不许写成 done —— 那是假报）
⑤ openai-task-planner.ts 指令写清：同一引用不要重复 · 能凭已有结果回答就 steps=[]+done=true · 不要猜名字
⑥ turn-bridge.ts   KernelError.message 走 **stderr**（单行、≤400 字符）；协议仍只回具名码
```

**读数（本轮）**

```text
· pnpm typecheck = EXIT 0
· pnpm kernel:test / kernel:verify = EXIT 0
· pnpm m4.5:test / m4.5:verify / m4.5:measurement:verify / m4.5:nl-action:verify = 四个 EXIT 0
· pnpm m3.5:test = EXIT 0（prompt 逐字节回归；chat prompt 未改）
· pnpm postlv2:bridge:verify = EXIT 0（含本轮 stderr 诊断改动）
· **pnpm m4.5:ci（完整离线链 M1→M4.5，交付纪律门）= EXIT 0**
  ⚠️ 它重新生成了 artifacts/m4-acceptance/ 与 artifacts/m4.5/ 下的历史证据；那些路径**动手之前就已是脏的**
     （多会话共享树）⇒ 本轮既没有提交它们、也没有回滚它们（AGENTS §7：不对 artifacts/ 做无差别 checkout）
· pnpm productivity:verify（28 组）= PASS 27 · FAIL 0 · NOT RUN 1 · 102 条输入
    runId = productivity-20261005T073053-82653e7d-af88
    与批内历史读数**同形**（唯一 NOT RUN = browser-04，需人工首连真登录态）
    ★ 新增回归全绿：common-05 = 21 条断言（⑥-a…j 汇聚三段式 + 契约未改弱 + 去重/指纹 ·
      ⑦-a…d 8 步真网关轮次**照样成功** · ⑧-a 事故原始形态）· common-06 = 10 条（④-a…e，
      含"读→写→再读"的负控：带载荷的写步骤永不进闸 + 写会作废该引用的读取记录）
    证据：artifacts/post-lv2/productivity-skills/productivity-20261005T073053-82653e7d-af88/run.json
· pnpm utility:verify（32 组）= **EXIT 1**（PASS 29 · FAIL 3）：
    三条都是 math **超时**（观察值 `state=timeout`，不是算错）；runId = utility-20261005T072035-82653e7d-d220
    ⚠️ **同一形态在本批改动之前**的旧 run 里出现过（utility-…-5412d892-de8b，2026-10-04T15:49）
· pnpm utility:verify --only math = **EXIT 0**（14 组 PASS · 0 FAIL · 75 条输入）
    runId = utility-20261005T072709-82653e7d-a3ac
    ⇒ 隔离复跑 math 组全绿 ⇒ 上面那三条判为**负载诱发的超时**（当时本机同时跑着头像外壳 +
      浏览器 sidecar + 本门电池），**不是**本次改动引入（本次不碰 math 适配器与它的超时）
· 树状态：**多会话共享**（run.json 的 dirtyEntries = 395、head 在一次运行期间移动过）
  ⇒ 按 L-PS-34 以 sourceHashes 为准，不以 head 为准；本条**不主张**"全绿"
```

**本批不主张什么**

```text
① 不主张"她不会再重复列举"：机械保证只到"整份计划都在打转就停" + "摘要里带引用"；
   单步重复（一步已做过 + 一步新的）仍会执行 —— 刻意（写完再读回来核对是**合理**的）
② 不主张"规划器现在看得到内容"：它看到的是**引用**，正文只在回复侧的当轮内容里（设计边界）
③ 不主张"回复层知道有几份被丢弃"：汇聚读数在 turn / trace / stderr，**没有**进回复守卫的来源附录
④ 不主张"离线全绿 = 真实链路全对"：离线替换了模型与出站 IO；8 步场景由**脚本化规划器**给出；
   而且 `utility:verify` 全量档本轮是 **FAIL 3（超时）**，只有隔离的 math 档是 PASS
⑤ 没有改 M4.5 冻结面 / 记忆语义 / 归因链；本批**没有**跑真实链路（触发那次是用户侧头像实测）
```

---

## 0s. 第十九批（2026-10-05）：技术债复审、漏接修复与影响审计

用户指令：「帮我再查一遍技术债，看看哪些是已解决没登记，哪些是未解决，以及审计他们的影响」。本轮只做复审/补登记，不实施功能修复、不改配置、不打开真实库、不增加外部模型调用。[完整报告](Tech-Debt-Audit-2026-10-05.md)包含影响、优先级、关闭要求和旧/新证据边界。

### R-54 · 首句前取消后会话序号断链 ✅ 具体缺陷已修，补接总册

旧缓存预测用户和助手均落账（`+2`），首句前取消没有助手事件，下一轮被拒 `conversation_sequence_gap`，整段会话持续不可用。现在每轮从权威账本对齐；已有 7 场景和旧缺陷复现负控，均能下一轮回复，含早取消、晚取消、失败与重启。载体：[Sequence-Continuity-Fix](post-lv2/Sequence-Continuity-Fix-2026-10-05.md)。**只关闭序号断链**，不关闭实际声音停播延迟。

### R-55 · 目标完整响应期限与并行 prepare ✅ 工程已完成，端到端性能仍开放

目标理解期限 **20s→8s**，覆盖 HTTP 成功/错误 body 读取；晚结果不得写入。最新期限控制 **15/15**，并行控制 **15/15**。prepare 与 recall 可重叠，提交保持在 recall 后，单请求与幂等不变。[期限记录](post-lv2/Goal-Understanding-Deadline-2026-10-05.md)、[优化记录](post-lv2/Latency-Optimization-2026-10-05.md)。注入 250ms 探针约 561→277ms 仅为调度验证；8s 非整轮上限，超时可能使目标/约定识别降档。**TD-17 不整体关闭**。

### R-56 · 经历纯语义召回与生产索引 namespace ✅ 机制已修，TD-22 保持 PARTIAL

旧“episode 排除于 renderer / 纯语义最终无资格”的结论已被实现取代：`semantic-render@2`、`semantic-relevance@1`（on 档 floor 0.87 / minMargin 0.01），隔离全链 **28/28**。已有生产修复摘要记录 CLI/正式 bridge、**2 轮纯语义选中**、回归 **10/10**、离线 CI EXIT 0、原始记忆不变；审计副本读回 canonical namespace 的 @2 published 代。[完整链](../artifacts/post-lv2/semantic-recall-2026-10-05T03-45-48-098Z/result.json)、[已有修复摘要](../artifacts/post-lv2/semantic-production-audit-20261005/repair-result.json)。

**TD-22 当前读法再缩小**：写侧/入口/@2 渲染/namespace 对齐和有限受控轮级证据已有，不能再写“自然语言查询完全没有证据”。**自然首用统计、规模 cursor/跨进程恢复、开放改写质量和收益仍分项开放**；本轮不重新打开或维护生产库，小样本不能代证广泛行为改善。

### R-57 · OCR 后端与缺资产具名降档 ✅ 局部已修，旧机械 FAIL 保留

RapidOCR CPU 替换旧后端，原 3 清晰图 CER 全 0；`ocr_assets_missing` 进入确定性回复守卫，**L-US-06b 已修**，真模型缺资产 1/1。新角色矩阵实际 CPU 识别通过。[OCR 修复记录](post-lv2/OCR-Repair-Execution-2026-10-04.md)。退化图为空/CER 100% 属允许的 partial；旧真模型成功案的 spokenText 附录抓取 **FAIL 不改写**。旧 tesseract.js 专有局限不继续套到新后端，OCR 普遍准确率/常驻 worker 等仍未证明。

### R-58 · 角色工具接线、激活及首用 ✅ 接收已有实现与有限首用证据

具体漏接 **L-RTD-07/15/17/18** 已修：桌面事实、bed 权限/适配器、payloadRef 暂存读回、document/OCR 读范围；实际当轮正文进入 planner，搜索→深读可达，空结果与执行分支 decision trace 已修。新 `postlv2:role-tool:matrix` **A 36/36 · B 32/32 · C 11/11 · NOT RUN 0**，模型调用 0，真实库摘要不变。

ADR-105 / [WP4](post-lv2/Role-Tool-Decision-WP4-Record.md)后续已记录 **人审 PASS / role 档 ACTIVATED / FIRST-USE OBSERVED**。已验证快照读回 answer/tools/clarify 三次决策，tools 轮 `local.file.list=success`；耗时 1.46～2.49s。**不是完整生产任务质量/长期稳定证据**。L-RTD-05/13 澄清问句不入回复、09 目录环境、19～23 格式/样本/统计等仍开放；16 sandbox 读取不产正文是明确保留的边界。脚本化决策不证明真实模型抗注入。

### R-59 · Lv4.5 P2～P4 后续接线 ✅ 部分已交付，停播/等待与时序窗口仍开放

总册 §0q 是早期 P1 读数；后续 ASR 提前 partial、唤名、授权查询、语音/浏览器播放回执、中途更正与 superseded 路径已有工程及有限真实链证据。[联合验收](post-lv2/Lv4.5-Joint-Acceptance-2026-10-05.md)分列保留。

**未关闭**：停播协议 p95 **1996ms > 250ms**；原首段实质语音 **9/9 超 5s**、p50 8881ms；真人未唤名插话路径 **NOT OBSERVED**，播讲中新证据到达窗口尚缺独立真链。用户已把生成等待另行处理；本轮不把旧 5s 阈值变成新发布阻断，也不以序号/播放账修复冒充停播体验通过。

### R-60 · M11.1 历史评分与联合装配 ✅ 局部已做，效果与当前证据未闭合

旧 @2 两槽 **360 回复已由 Codex 盲评**，不是仍全部 UNSCORED；C 对 A **0pp**、对 B **3.75pp**，未达 10pp。A12 原生联合门曾 **32/32 PASS**，早期 17/18 的普通字段拒收不宜继续写为无实现。见[后续报告](m11.1/M11.1-Semantic-Repair-Report-2026-10-03.md)、[判定修订](m11.1/M11.1-Gate-Decision.md)。

**仍未完成**：当前统一 540、200 轮混合真链、完整来源生命周期与当前正式语义通过。@5 正式 480 案 **FAIL 保留**，@8 已知探针 14/16 不代证。10/05 新汇总 G1～5/G8/G9/G11 **INVALID**（共享源码指纹变）、G6/G7 **NOT RUN**、G10 **PARTIAL**；旧局部 PASS 不够证明当前候选。M11.1 自身 **NOT PASS**，Lv2 已授权风险放行不改写。

### R-61 · 证据选档与当前红项审计 ⚠️ 两项新发现，保持 OPEN

- **AUD-20261005-01（P2）**：M10.1 assembly 同 HEAD/同日三档，23/24 FAIL 与两份 24/24 PASS 缺细粒度结束时间/替代关系，选档 **AMBIGUOUS**、正确失败关闭。当前总门 18 道有读数/1 道不接受。需新 run 的身份/精确结束时间/supersedes，不回写旧失败或人工选择通过档。
- **AUD-20261005-02（P2，TD-23 同族）**：`scripts/m10-gates.ts` 仍按 manifest mtime 排序；`m11.1-gates.ts` 的非法日期回退仍用 mtime。机制风险已确认，**本轮未证明发生误选**。M10.1/M5.5.1/M4.5/Lv2 既有选择器修复不被重开。
- **TD-23 再缩小**：R-41、R-51 等的本体及 G14 修复已有；旧行末“还缺选择器自证/G14 仍红”不能当当前值。新发射歧义与另一个 M10 聚合器仍需各自维护；不宣布整个同族 CLOSED。
- **当前汇总**：21 门 **13 PASS / 8 FAIL**。M511 harness 46/7；M6 wiring/faults 两红；M9 短/长未过；M10.1 歧义；M11.1 指纹失效；Lv2 源指纹/继承未过。M6.1 裸命令缺显式 manifests，而 inherited 正确传既有 wp0/wp1 后 PASS，属于调用前置条件，**不是模块回归**。
- **时点分列**：Lv2 汇总本次读较早 inherited **10/16**；同轮稍后 inherited 新读数 **9/16**。新继承红包含 M4/M4.5/M5.1 回归指纹过期与 M6/M9/M10.1/M11.1。不能继续以旧 14/16 当当前状态；ADR-090 的历史风险接受放行仍有效，本轮新发现未自动获接受。

### R-62 · 统一回归与登记维护 ⚠️ 调度缺口新立案；导航已补

**AUD-20261005-03（P2，OPEN）**：取消连续性、目标期限/并行、semantic、role-tool 有独立验证脚本，但 `scripts/gates/manifest.ts` 的 `PL2_GATES` 仍仅 10 个 S8/DB 门，post-Lv2 lane 尚不覆盖新修复。后续需将适用离线控制与 affected 选择、资源约束接好；不能自动纳入真实库/Live 入口。**有测试 ≠ 已有持续调度**。

本册顶部已补本批及审计报告入口，修复 ADR-072/073 的两处相对链接。§7 与多个验收/WP 开头保留旧“当前”，需按日期和追加修订读取；不重写冻结结论。历史 R-26 同号两个主题本轮按标题区分，不擅自改引用编号。

**影响优先级**：先补 S8 实际入口；停播/生成等待与可信选档/回归调度优先推进；M11.1 冻结候选后补完整效果/长链；搜索隐私、多用户/多渠道和真实库打开者按触发边界先验收。其它记忆表达、Office 视觉、浏览器登录/焦点及裁剪完整性见[完整影响表](Tech-Debt-Audit-2026-10-05.md)。**仅为建议，不代表本轮已修复或新模型批次已批准**。

本轮验证：`pnpm typecheck` EXIT 0；新角色矩阵 EXIT 0；`summaries-all` EXIT 1（归档审计，非完整回归）。[运行与哈希](../artifacts/tech-debt-audit/20261005/audit-checks.json)、[39 份来源索引](../artifacts/tech-debt-audit/20261005/source-inventory.json)、[稳定汇总日志](../artifacts/tech-debt-audit/20261005/summary-run.json)。真实库未打开，现有脏文件保留，功能代码与生产配置未修改。

---

## 0t. 第二十批（2026-10-05）：**执行**审计 §5 的建议次序 —— 先做「证据/调度可信化三件」

用户指令：「按照建议修复技术债」（指 [技术债复审与影响审计](Tech-Debt-Audit-2026-10-05.md) §5 的建议次序）。本轮做 **A 组 = 证据与调度可信化三件**（`AUD-20261005-01/02/03`）；**B 组（S8 真实入口 `L-S8-30`）另起一轮**，因为按立案它需要一次**设计裁定 + 新授权**（[S8 消费入口缺口立案](post-lv2/S8-Consumption-Entry-Gap.md) §C3）。

完整记录：[证据选档与发射面修复](post-lv2/Evidence-Selection-Repair-2026-10-05.md)（逐条读数、边界、不主张清单）。

### R-63 · `AUD-20261005-02` 选档器 ✅ **已修（身份优先 + 失败关闭 + 三段式自证）**

**事实**：同一个"按文件系统 `mtime` 取最新一份"的缺陷在**三个**聚合门上各出现过一次（`m10.1-gates` / `m10-gates` / `m11.1-gates`）。
**修法**：抽成**唯一一份**实现 `scripts/gate-evidence-select.ts`（自报时间 → head 提交时刻 → 证据提交时刻 → 清单日期 → 具名降级；
**`mtime` 一个字节都不参与**，连"可注入的 mtime 版本"都刻意不留）；`m10.1-gate-select.ts` 改为委派（导出 API 逐字不变、
`m10.1:measurement:verify` 的 ⑤ 选档器三段式复跑后 **7/7 PASS**）；`m10-gates.ts` 删掉 `mtimeMs` 排序、`m11.1-gates.ts` 删掉
`statSync(目录).mtimeMs` 回退。**并列且判定不同 ⇒ 失败关闭**（`m10-gates`/`m11.1-gates` 报 `INVALID`，`m10.1:gates` 报 `AMBIGUOUS`），
**刻意不优先取 PASS**。**自证门**：`pnpm postlv2:gate-selection:verify` **11/11 · EXIT 0**（含"mtime 反转仍不按 mtime"的负控、
一个**故意按 mtime 排**的对照排序证明夹具**具判别性**、结构锁 + 注入负控 + 恢复）。

⚠️ **本轮实测发现：旧实现确实选错了（不是理论风险）**。`artifacts/m10/**` 里每道门**最新那一组**"并列且判定不同"的有 **3 道**
（`long-verify` · `measurement-verify` · `smoke-live`）；为 `long-verify` 旧实现选中的那一份所在的 head **不是最新的 head**
⇒ 旧"最新一份"跟的是**检出顺序**。那 3 道在旧读数里是 PASS。**修复后它们如实报 `INVALID`（归属不明）** ——
这是**新增的诚实读数，不是"把门弄红了"**：旧绿建立在一次未受控的选档上。要让它们重新可裁定，需要各自重新产出一份带 `ended` 的读数。

### R-64 · M10 清单的**发射面** ✅ **已补（`ended` 正式结束时刻）**

`scripts/m10-evidence.ts` 的 `writeM10Manifest`（**唯一**写清单的地方）在封印前补 `ended`（ISO-8601，毫秒；调用方可显式覆盖），
与既有 `injection` 标记同一条思路（三十多个门各自填就会各自忘）。`M10_MANIFEST_REQUIRED_FIELDS` **不**变 ⇒ **历史档仍然合法、一个字不回写**；
判据**只对以后**的档生效。**Why**：M10 清单此前**没有任何时间戳**（`date` 只有天粒度）⇒ 同 head 多次运行**必然并列**。

### R-65 · `AUD-20261005-01` M10.1 装配门的发射缺口 ✅ **已修（新 run 可裁定）**

`scripts/m10.1-assembly-verify.ts` 现在发射 `started`/`ended`（毫秒）+ `supersedes`（**由同一套身份判据**算出的"此前最新一份"，
不按 mtime、不挑 PASS；算不出来就如实 `null`）。本轮新 run `m11-m10-1-wp6b-assembly-20261005-a5de36f8e879-f1e1`（**PASS 24/24**，
`supersedes = …-b223eeb023d4-b5ce`）⇒ **`pnpm m10.1:gates` = 必选 18 · 有读数 18 · 未运行 0 · 未通过 0 · overall = PASS（EXIT 0）**。
**旧档全部原样保留**（那份 23/24 FAIL 与另外两份同 head 档都**没有** `ended`/`supersedes`，逐字未动）。

### R-66 · `AUD-20261005-03` 统一回归调度 ✅ **已接（新 lane + affected 路由 + 实测）**

新 lane **`postlv2-controls`（6 道，全部 `serial`）**：`postlv2:gate-selection:verify` · `postlv2:goal-deadline:verify` ·
`postlv2:goal-parallel:verify` · `postlv2:role-tool:verify` · `postlv2:role-tool:path` · `postlv2:sequence-continuity:verify`。
**实测真跑**（runId `fast-2026-10-05T16-06-03-768Z`，`--serial`）：**5 道 · PASS 5 · FAIL 0 · EXIT 0**（墙钟 56s；
`role-tool:path` 36.7s 最慢）。**affected 路由实测**（`planAffected()`）：`src/main.ts` → 4 门含取消连续性 ·
`scripts/gate-evidence-select.ts` → 2 门含选档器自证 · `src/kernel/app/goal/understanding.ts` → 27 门含目标期限/并行 ·
`src/kernel/action/tool-catalog.ts` → 7 门含角色工具两门（四条都 `escalateToOffline=false`、`unmatchedPaths=0`）。
`pnpm gates:verify` **PASS 51/51**（含 `G1`/`G2` 覆盖新增注册）。

⚠️ **有意不登记 5 道**（原因都是可复核的事实，不是偏好）：`postlv2:semantic:verify`（依赖 gitignored 本地编码器资产）·
`postlv2:semantic:production:verify`（**读活库** `cpSync` 副本；用户聊天时复制不静止 ⇒ 直接崩且**不落证据**）·
`postlv2:role-tool:matrix`（依赖三处 gitignored 本地资产 ⇒ `notRun` ⇒ NOT PASS；且真跑 python + OCR）·
`postlv2:role-tool:known-dirs`（自述读数依赖本机环境；会把**用户真实桌面路径**写进仓库跟踪证据）·
`postlv2:goal-thinking-eval`（**真出站**）。它们仍可 `pnpm <id>` 显式跑；"显式"与"自动带出"是两件事。

### 本批的边界（**不**主张）

- **不**主张 `m10-gates` 变好了：它从"3 道静默选档"变成"3 道如实 `INVALID`"——更**诚实**、不是更**绿**。
  `INVALID` 说的是**归属不明**，**不是**"被测功能坏了"；两者**必须分列**。
- **不**主张 `m11.1-gates` 被改善：仍 `NOT PASS`（`G1～5/G8/G9/G11 INVALID`（来源指纹变）· `G6/G7 NOT RUN` · `G10 PARTIAL`），
  **与审计基线一致、未被本轮改变**。
- **不**主张 `AUD-20261005-03` 之后"post-Lv2 全都有持续回归"：本轮只接 **6 道**；上表 5 道仍只在显式调用时跑。
- **本轮未跑** `postlv2:sequence-continuity:verify`：其证据目录名**固定**（`artifacts/post-lv2/sequence-continuity-verify-20261005`，
  **未跟踪**），重跑会覆盖已落盘的那一份；按审计轮"不覆盖旧证据"的读法，本轮**只登记不重跑**。
- **B 组（S8 真实入口）未开始**：按立案 §C3 它需要**设计裁定 + 新授权**，不与本批混做。

**本批验证**：`pnpm typecheck` **EXIT 0** · `postlv2:gate-selection:verify` **11/11** · `m10.1:gates` **18/18 PASS** ·
`m10.1:measurement:verify` **7/7** · `m11.1:gates:verify` **EXIT 0** · `m10:gates` 自证 **10/10**（门判定 PASS 24 · FAIL 0 · NOT RUN 1 · INVALID 3）·
`m10:evidence:verify` **11/11**（1738 个 run · 422 个 FAIL 档全有具名解释 ⇒ `ended` 发射的回归证据）· `m10:docs:verify` **13/13** ·
`gates:verify` **51/51** · `postlv2-controls` lane **5/5 PASS**。**真实库全程未打开**（本轮门要么零数据库、要么走
`isolateDatabase()` 的 `%TEMP%` 一次性沙箱）；**零模型调用 · 零真实出站**。工作树里**并发的 desktop-control 改动原样保留**，
未提交、未触碰。**本轮不提交**（`.git` 状态留给用户裁定）；本轮新落的证据都是**新的未跟踪 run 目录**，**没有一份已跟踪的历史证据被改写**
（实测复核：35 条 ` M artifacts/...` 与运行前逐条相同，与本轮无关）。

---

## 0u. 第二十批·续（2026-10-05）：B 组 **S8 真实入口** —— 设计已裁定，草案 premise 有一处**如实更正**

用户选定"先 A 后 B"。A 组见 §0t。**B 组 = `L-S8-30`**（[立案](post-lv2/S8-Consumption-Entry-Gap.md)）在立案里就写明需要**一次设计裁定 + 新授权**
⇒ 本轮先出草案 → **用户已裁定** → 草案 premise 经侦察**更正**（见下）。

载体：[`ADR-107：S8 生产故事入口的剩余部分`](adr/ADR-107-s8-production-entry-remaining.md)（**`ACCEPTED / RULED`**）。

### 裁定记录（2026-10-05）：四个待裁定项**全部按草案推荐**

`R-1b`（独立私有决策调用，**不碰**主 prompt 逐字节基线）· `R-2a`（显式 CLI `story:start`）·
`R-3b`（每轮扫 + `open()` 补扫）· `R-4c`（端到端行为锁为**唯一**主张来源，文本锁降级为"装配在场"）。
子问题 `Q1`–`Q11` 一并落定（含：无活跃 run 时私有调用**一次都不许发** — 写成机器判据；`D02.4` 单用户单 run ⇒ 已有活跃 run 时 start **拒收**；
反思消费**不进**用户等待的那一轮；新锁**要**三段式且**要**进 `postlv2-controls` lane）。**裁定 ≠ 完成**：`L-S8-30` 仍 `OPEN`。

### ⚠️ **一处 premise 更正（起草后侦察发现的实质错误，必须先改后做）**

草案初稿断言：「"活跃 run"在当前 schema 里**无处存在** ⇒ `D02.2①` 的"活跃 run"**必然**要求一个新持久化位置（新表 + 新迁移）。」
**这个断言不准确**。更正后的**事实**：

```text
① **已经存在一条"开局"路径**：`src/kernel/app/storyline/commit-service.ts:252-281`
   revision==1 且 commitId 缺失 ⇒ `startStory(...)`；已有开局且 idempotencyKey 不同 ⇒ `story_run_already_started`
   ⇒ 开局**就是**一条 `revision=1` 的 `STORY_STARTED` 提交 ⇒ `run_id` **本来就**持久化在 `storyline_commits.run_id` 里
② **"活跃"是 fold 出来的**：`commit-service.ts:108-136`（0 条 ⇒ `story_run_not_started`）+
   `src/kernel/storyline/world-machine.ts:100-101` `StorylineState.terminal`
③ `listRuns` 是 `select distinct run_id from storyline_commits`（`story-ledger-store.ts:357-364`）——**投影**，不是表
```

⇒ **正确结论**：`D02.2①` 的"服务端生成并**持久化**"**不需要新表**；
`D02.4` 的"单用户单 run"让"该会话的活跃 run" = "该故事**恰好一个非终局 run**"（会话↔run 绑定也不需要新位置）。
⇒ 因此 **实施口径改为 `R-2a′`：显式 CLI + 从账本推导，零 DDL 变更**；
**`AGENTS §3` 的冻结迁移面一个字不动，真实库也完全不需要迁移授权**（原文"可否新增迁移"的问题随之**不再适用**）。
**这不改变用户的顶层裁定**（`R-2a` = 显式 CLI），只改变"持久化落在哪里"。

### 另外三处**会影响实现**的既存事实（侦察所得，已写进 ADR §2.5）

- **`proposalType` 没有封闭集 / 登记表 / 失败关闭开关**（`proposal.ts:129/177` 自由字符串；真正失败关闭判的是**目标事件类型**，
  `validator.ts:165-171`；负控 `scripts/m8-wp3-verify.ts:767-788` 证明**该标签被忽略**）
  ⇒ 新增 `'story-choice'` **不会**让任何测试变红，也**没有**门能验证它"真的是受控值"
  ⇒ **`R-4` 的锁不许主张"提案类型受控"**，只能主张"入口跑了 / 账本真的多了行 / 水位真的前进"。建中央登记表**不在本轮**（会牵动别的里程碑的既有临时值）。
- **故事状态没有现成的 prompt 载体生产者**：`src/main.ts` **从不**设 `input.turn.worldObservations`；
  而 `D04` 点名的 `adaptiveSelfTokens` 喂的是**反思槽**（优先级 44），**不是**世界观测槽（优先级 59）。
  ⇒ `R-1b` 的输入面**另建有界渲染器**（frontier 机器键，**不进**主 prompt）；"故事状态怎么入主 prompt"**本轮不裁**，具名登记为独立缺口。
- **主 prompt 逐字节基线**只在默认 provider 列表 / `composePromptFromPacket` 文本 / `CONTEXT_COMPILER_V2_VERSION` / section-id 集合变化时才红
  （`scripts/future-compat-tests.ts:1003-1040`）；夹具 `scripts/m3.5-prompt-baseline.ts:133-146` **从不**传 `extraProviders` 且**不读任何 flag**
  ⇒ `R-1b` 与 `R-3b` **在结构上**都碰不到那份基线（这是选 `R-1b` 的**依据**，不是猜测）。

### 实施顺序（已按依赖调整，**尚未开始实现**）

```text
① R-2a′ 显式 `story:start`（既有开局路径，零 DDL）   ← 是 R-1b 的前置（没有"活跃 run"就无从闸住私有调用）
② R-1b  私有决策调用 + 闭集校验 + 有界故事输入渲染器 + "无活跃 run 一次都不调"的机器判据
③ R-3b  消费点（每轮扫 + open() 补扫）+ 把 `L-S8-30` §C2 的口径不一致在文档里具名
④ R-4c  端到端行为锁（唯一主张来源）+ 三段式 + 文本锁降级
⑤ 证据：新门读数 · `m4.5:ci` · `m3.5:test`（证明主 prompt 基线**未动）
⑥ 才谈激活（独立裁定）
```

⚠️ **本轮到此为止**：**没有**动一行 B 组实现代码（裁定后只改了设计载体与登记册）。
下一步从 ① 开始；每一步的读数单独出。**S8 的 `story:withdraw` 至今未登进 `docs/苏沐薇-使用说明.txt`** ——
本轮**不**顺带补这笔历史欠账，但 `story:start` 落地时**必须**按 `AGENTS §5` 记账（含 `pnpm doc:sync`）。

### 实施进度（**只追加**）

#### B-① `R-2a′` 显式 `story:start` ✅ **已实现并已有门读数**（2026-10-05）

**入口侧的"第一条提交由谁写"这一半已经补上。** 落地物：
`src/kernel/app/storyline/admin.ts`（纯解析，失败关闭）·
`src/kernel/app/storyline/run-lifecycle.ts`（**活跃 run 从账本算**：`loadStoryRun` + `StorylineState.terminal`；单用户单 run 判据）·
`src/infrastructure/runtime/story-start-command.ts`（显式告警 → 走既有开局路径 → **从账本回读**）·
`src/invocation.ts` + `src/main.ts` + `package.json` 的 `story:start` · 用户文档已按 `AGENTS §5` 记账（`doc:sync` / `doc:check` 均 0）。

**门**：`pnpm postlv2:s8:start:verify` = **PASS（`measured_count = 15`，10 条检查全绿）· EXIT 0**
（正控 / 幂等 / 单活跃 run 负控 / 五类形状负控 / **终局后恢复** / 装配在场 / 非零分母 / 隔离）；
已登记进 `PL2_GATES`（lane `postlv2` 第 11 道）并接进 affected 路由；经调度器真跑 **PASS 3.7s**。
回归：`typecheck` **0** · `m4:test` **259/0** · `m4.5:test` **146/0** · `gates:verify` **51/51**。

⚠️ **两处由代码/先例定死的子决定**（裁定没覆盖，已写进 [`ADR-107`](adr/ADR-107-s8-production-entry-remaining.md) §6.2）：
① 绑定**必须**是 `system` —— `STORY_STARTED` 不在 `STORY_USER_CHOICE_EVENT_TYPES` 里
（`story-ledger.ts:147-151`）⇒ 声明 `user_choice` 会当场抛错；语义上正是 `INV-CI-03`「维护不得冒充经历」。
② **没有** `--confirm` —— 沿用 `story:withdraw` 先例，不单方面发明新流程；但**值得复核**（`cognitive-integrity` §2 的
"Explicit Warning" 本实现用**打印显式告警**满足）。

⚠️ **`L-S8-30` 仍未关闭**：剩下 ② `R-1b`（候选 `choiceId` 的产出面）· ③ `R-3b`（每轮消费点）·
④ `R-4c`（端到端"入口缺席负控"三段式）· ⑤ `m4.5:ci` / `m3.5:test`（证明主 prompt 基线**未动**）· ⑥ 激活（独立裁定）。
**本门 S6 是文本锁，明确不作为主张**（`R-4c`）。

#### B-② `R-1b` 候选 `choiceId` 的产出面 —— **确定性核心已实现并已出门读数**（2026-10-05）

落地物：`src/kernel/contracts/story-choice-draft.ts`（形状 + **闭集**）·
`src/kernel/app/storyline/choice-input.ts`（**有界输入**：候选/正文/原话/最近行各自上界，超界**具名截断**）·
`src/kernel/app/storyline/choice-decision.ts`（端口 + **三个具名失败桶**，不重试不回落）·
`src/kernel/app/storyline/choice-turn.ts`（编排：开关 → 活跃 run → 候选 → 一次调用 → 闭集 → 既有入口）。

**门**：`pnpm postlv2:s8:choice:verify` = **PASS（`measured_count = 21`）· EXIT 0**；经调度器真跑 **PASS 3.6s**；
已登记进 `PL2_GATES`（lane `postlv2` 第 12 道）并接进 affected 路由；`typecheck` **0** · `gates:verify` **51/51**。
分列读数：**正控**（闭集提案 ⇒ 落账本，绑定是**服务端**给的）· **开关关闭 ⇒ 端口零调用** ·
**没有活跃 run ⇒ 端口零调用**（省钱硬闸）· **闭集外/多字段/版本不符/非对象/超时/调用失败/模型说 null/端口缺失 八条负控各自具名且账本零变化** ·
**恢复**（又能提交）· **无候选**（真走 6 步到 `s4_result`）⇒ 端口零调用 · 纯函数上界 · 非零分母 + 隔离。

⚠️ **`L-S8-31`（本批立案，`OPEN`）** —— `R-1b` 暴露的真实风险：`D02.2④` 冻结的绑定是 `user_choice`，
而 `ADR-093 D01` 说它是"**唯一**能成为习惯根的形态"；模型**会解析错**（用户没选/选了别的，模型给一个闭集内的键）
⇒ 那条提交会**冒充一次真实用户选择**。缓解只有"闭集 + 世界判定 + 锚定本轮用户消息 + 失败具名"，
**没有任何一条能证明"用户真的选了它"**（措辞层**刻意没有**启发式守卫，`DR-11`）。
**本步不据此主张任何行为正确性**；真实模型解析质量**不在**本门内（门用注入替身端口）。

⚠️ **②的剩余**：真实 provider · flag（`CHARACTER_STORY_CHOICE_DECISION_ENABLED`，代码缺省 **false**）与缺省锁 ·
`src/main.ts` 的生产调用点（`beginTurn` 之后、回复之前，`D02.3`）。

#### B-②余 真实 provider + flag + 生产调用点 ✅ **已实现并已出门读数**（2026-10-05）

落地物：`src/infrastructure/model/openai-story-choice.ts`（恰好一次 POST · `temperature:0` · `json_object` · `AbortController` 硬期限 ·
**失败分桶**：网络/HTTP/无 key ⇒ 抛（内核映射 `call_failed`/`timeout`），"不是 JSON" ⇒ 返回原文（内核判 `invalid_output`））·
`src/kernel/app/flags.ts`：`storyChoiceDecisionEnabled`（**代码缺省 false**）+ `storyChoiceDecisionTimeoutMs`（有界 1s–25s，缺省 8000）·
`src/main.ts` 的调用点（`beginTurn` 之后、编译与回复之前）· 缺省锁与"装配在场"锁在 `scripts/kernel-tests-memory.ts`。

**读数**：`typecheck` **0** · `postlv2:s8:choice:verify` **PASS（`measured_count = 21`）** · `m4:test` **261/0** · `m4.5:test` **146/0**。
**`recentLines` 复用 `decisionLines`**（那份本来就"给决策的、不进 prompt"）⇒ 结构上碰不到主 prompt 基线；
**`interactionRef = cli:<userId>`**（单用户 CLI 只有一条对话流；多会话入口必须由**那一层**给真实会话 id —— 已登记为边界）。

#### B-②收口 ⚠️ **`m3.5:test` 的边界锁抓到了一次真实的架构退化**（2026-10-05）

第一版接线**没过** `pnpm m3.5:test`：`FC-T04`（"世界/故事实现只允许住在具名模块边界内"，`ADR-091 §2`）报 `src/main.ts`
三条未登记故事依赖（`render.ts` / `choice-turn.ts` / `story-ledger-store.ts`）。**两条路**：
① 把三条边登记进白名单（判据明确允许，且能立刻变绿）—— 但那条负控**专门**拿
`src/main.ts` + `story-ledger-store.ts` 的合成 import 当反例 ⇒ 登记它等于把设计意图抹掉；② 改设计。
**选了 ②**：`story-cognition.ts` 多一个 `resolveChoiceTurn`（账本/内容包/渲染器都在它的闭包里），
`main.ts` 只多**一个字段 + 一句调用**，故事依赖名单**一个字不改**；端口契约移到
`src/kernel/contracts/story-choice-draft.ts`（与每一个同类适配器一致）⇒ 适配器不必触碰故事边界。
我那条消费锁随之从 `runStoryChoiceTurn(` 改成 `.resolveChoiceTurn(`（**性质不变**），并**新增**一条
"边界模块必须真的实现该方法"。

⇒ **这条值得单独记**：那次失败**不是**门太严，而是门抓到了"故事逻辑放错了位置"。
把边登记进去会让门变绿而边界**悄悄变宽**。**判据赢了一次。** 载体 [`ADR-107`](adr/ADR-107-s8-production-entry-remaining.md) §6.7。

**读数**：`m3.5:test` **30/0**（含 `FC-T08` 逐字节 prompt 基线**原样通过** ⇒ 新的每轮块**结构上**碰不到它）·
`postlv2:s8:choice:verify` **PASS 21** · `postlv2:s8:start:verify` **PASS 15** · `m4:test` **261/0** · `m4.5:test` **146/0** · `typecheck` **0**。

⚠️ **仍未做**：③ `R-3b`（每轮消费点：每轮扫 + `open()` 补扫）· ④ `R-4c`（端到端"入口缺席负控"三段式）·
⑤ `m4.5:ci` 全量（`m3.5:test` 那一段已跑；**未跑**整条）· ⑥ 激活（独立裁定）· `L-S8-31` 需**真实模型批次**。

#### B-③④ `R-3b` 每轮消费点 + `R-4c` 入口锁 ✅ **已实现并已出门读数**（2026-10-05）

**③ `R-3b`**：`src/main.ts` 新增 `drainStoryTail()`（轮尾 fire-and-forget，同型重入保护），在 `drainAgreementTail()` 之后调用
⇒ 消费点从"**只在 `open()` 一次**"变成"`open()` 补扫 + **每轮尾扫**"，与 `D03` 的"提交后由既有调度器消费"对齐
（`L-S8-30` §C2 的口径不一致由此**具名消除**）。
⚠️ **为什么在轮尾**（`Q8` 的落定）：`reflectionStep` 会**真发模型请求** ⇒ 压在回复之前就是把一次模型调用塞进用户等待；
放轮尾的代价只是**晚一轮**出现状态变化。

**④ `R-4c` 入口锁**：新门 `pnpm postlv2:s8:entry-lock:verify`（登记进 **`postlv2-controls`** lane —— `Q11` 点名的那条）。
它把 `L-S8-30` §C1.2 的"假绿"正面堵上，**判据是行为的**：

```text
L2 负控（**入口缺席**，先做）：同一套装配**只**跑消费、**从不**调入口 ⇒ CHOICE_COMMITTED **零条**、端口 **0** 调用
   （此时装配是**好的** —— 紧接着的 L1 就产出了 ⇒ "没有"只可能是**没调入口**造成的）
L1 正控：调入口 ⇒ 账本出现 CHOICE_COMMITTED（choice_id 逐字 · 服务端绑定 · 锚定本轮用户消息）
   ⇒ 再消费 ⇒ **三个消费者水位都推进**（affect→2 · relationship→2 · reflection→2）
L3 恢复：把入口放回去 ⇒ 又一条
L4 降级：`main.ts` 的**文本锁读数列出来但 `claimBasis` 里没有它**（claims 只有 L1/L2/L3）
L5 非零分母 + 隔离
```

**读数**：`postlv2:s8:entry-lock:verify` **PASS（`measured_count = 6`，5 条全绿）· EXIT 0**；经调度器真跑 **PASS 3.6s**；
`gates:verify` **51/51** · `m3.5:test` **30/0** · `m4:test` **261/0** · `m4.5:test` **146/0** · `typecheck` **0**。
⚠️ **本门边界**（写在证据的 `notCovered` 里）：**不**回答"生产里是否真的有人调入口"；
**不**驱动 `main.ts` 的轮尾（手动调 `consumeOnce()`）；**不**回答真实模型解析质量（`L-S8-31`）。

⚠️ **还剩**：⑤ `m4.5:ci` **全量**（已在本轮后台启动）· ⑥ 激活（独立裁定）· `L-S8-31` 需真实模型批次。

#### B-⑤ 全量离线 CI ✅ `pnpm m4.5:ci` **EXIT 0**（2026-10-05）

硬门读数：`G12` 量具有效性 **38/0** · `G13` 自然语言 E2E **32/0** · **`G14` Production-copy Live Smoke 52/0**
（只读归档证据、不重跑）· `G2` 部件 **146/0** · `L2` 动作管线 **53/0** · `G9` 人工审计语料 PASS。

#### B-⑥ 两处"值得复核"项的复核结论 ✅ **已执行**（2026-10-05，用户"同意复核"后）

**① `story:start` 原先没有显式授权 ⇒ 已改（加 `--yes`）**。复核结论：**必须有**，理由是一条**方向性**的区别 ——
`story:withdraw` 是**移除**认知使用资格（保守），而 `story:start` 是**新增**一个认知摄入面
（开局后用户的选择才会变成情绪/关系/反思状态）⇒ `cognitive-integrity` §2 的"不得默认开放、不得静默执行"
与 §18 `CI-4`（explicit / warned / authorized / audited / verifiable）针对的正是后者。
⇒ "抄 `story:withdraw` 的形状"**不能**一路抄到"也不要求授权"。落地：具名拒收 `story_start_confirmation_missing`
（零写入）· **形状先判、授权最后判**（两条互不掩盖）· 使用说明已记账 + `doc:sync`/`doc:check` 均 0 ·
门加负控（`S4` 现 **6 类**非法入参，`measured_count` 15 → **16**）。同型先例：`desktop-control:act --i-am-here`。

**② `interactionRef = cli:<userId>` ⇒ 收进具名函数 + 断言形状**。复核结论：单用户 CLI 只有一条对话流，
这个值**诚实**；风险是**将来多会话入口照抄它**。落地：`cliStoryInteractionRef(userId)`
（名字带 `cli` 让复用一眼可见）· 在**故事边界模块内部**拼（`main.ts` 不许 import 故事边界）·
入口锁 `L1` 现在**断言**那个形状。⚠️ **没解决什么**：现在没有机器判据能挡住"多会话入口偷偷复用它"
—— 因为多会话入口**还不存在**。⇒ **触发式**复核项。

#### B-⑦ `L-S8-31`：**方案 A 已实施**（2026-10-05，用户"尝试解决"后执行）

**已落地**：草稿里 **`quote` 必填**（给了 `choiceId` 就必须给"用户在**本轮原话**里逐字写过的一段"），
程序做**机械包含检查**（必须是 `currentInput` 的子串）。解析码新增
`quote_not_a_string_or_null` / `quote_empty` / `quote_not_in_user_turn`；指令里明写"指不出来就必须弃权"。
**门**：选择解析门的负控 **8 → 11**（`G16` 没给引用 · `G17` 引用不在原话里 · `G18` 空引用），
读数 `measured_count` **21**；入口锁门夹具同步（仍 **6**）；`kernel:test` **27/0**（`contracts/` 必跑门）。

⚠️ **`L-S8-31` 仍 `OPEN`**，理由逐字写进契约字段注释：它买到的是"模型必须**指认用户自己的字符**，
指不出来就得弃权"（挡掉"**脱离用户原话**去选"那一类失败）；**买不到**"引用得**对不对**"
（模型照样可以引用一段**无关**原话）⇒ 它是**结构性**缓解，**不是**语义判据（`DR-11`）。

⚠️ **方案 B（更强）仍是待裁定项**：让"**被解读出来的**"与"**用户直接表达的**"选择在账本里**可区分**，
并让"能否成为习惯根"只看后者 —— 可能触碰 `D02.2④` **冻结**的绑定形状与 DDL ⇒ 属"改动冻结面"，需独立裁定 + 迁移审查。
⚠️ **验证**该缓解的效果还需**真实模型批次**（单独授权），本轮**未**新增。

#### B-⑧ `L-S8-31` 方案 A 的真模型 A/B 对照 ⇒ **NO MEASURABLE EFFECT**（2026-10-05，用户授权真实批次）

批次经 `pnpm with-test-model` 包装（端点 `ark.cn-beijing.volces.com` · `deepseek-v4.1-flash` · **无生产 key 回落**，
缺包装器标记实测 exit 2）。量具 `pnpm postlv2:s8:quote:ab:live` + 冻结语料
`evals/post-lv2/s8-choice-quote/cases.json`（10 个 `no_choice` + 6 个 `choice`），**两臂同一批输入**，
只有 prompt 与解析规则不同（臂 1 = 变更前 `82e14d10` 的规则，逐字复刻）；**判据先注册**。

**读数（96 次真实调用）**：臂 1 假阳 **0/30** · 真阳 **18/18**；臂 2 假阳 **0/30** · 真阳 **18/18**；
两臂拒收码都是 **{}**。⇒ **`NO MEASURABLE EFFECT`**（臂 1 假阳本来就是 0 ⇒ 天花板，判据无法成立）。

**逐条说明**：① "**脱离用户原话去选**"那一类失败在这批语料上**没有出现**；② 臂 2 **零拒收** ⇒ 模型对新增的
必填 `quote` **每次照做**，方案 A 在这里**没有代价**（真阳一个没掉）；③ ⇒ 方案 A **既没被否定、也没被证明有收益**。
⚠️ **不主张**"模型不会误解读"：6 个 `choice` 案都是**明确**表达，**没探到**"用户说了 A、模型报 B"那一类
⇒ 要探它需换**更难**的语料（含糊表达 / 近义键 / 听起来像选择但不是选择的句子），已登记为**下一步**；
也不主张长期稳定（小样本，先例 `L-RTD-23`）；读数是**验收端点**（先例 `L-M85-14`）。
⇒ **`L-S8-31` 保持 `OPEN`** + 新增下一步「换更难的选择歧义语料重测」。


**方案 A（下一轮做，不碰冻结面、不碰 DDL）**：要求模型在草稿里**同时给出用户原话里的逐字引用**
（必填 `quote`），程序做**机械包含检查**（`quote` 必须是 `currentInput` 的子串）——
与 `goal-proposal` 的 `span`/`spanFingerprint` 同一条纪律；它是**结构性**的、**不**是语义判据 ⇒ **不**违反 `DR-11`。
⚠️ 边界：它只减少"模型脱离用户原话去选"那一类失败；模型照样可以引用一段**无关**原文
⇒ 买到的是"必须指认用户自己的字符"，**不是**"指认得对"。

**方案 B（需独立裁定）**：让"**被解读出来的**"选择与"**用户直接表达的**"选择在账本里**可区分**，
并让"能否成为习惯根"只看后者。⚠️ 可能触碰 `D02.2④` **冻结**的绑定形状与 DDL ⇒ 属"改动冻结面"，**本轮不做**。

⇒ `L-S8-31` 保持 **`OPEN`**；A 落地后**仍** `OPEN`（边界如上）。**验证**其效果还需**真实模型批次**（单独授权），本轮**未**新增。

---

## 1. 仍开放 · 有明确触发窗口（按计划等待，不提前动）

| ID | 问题 | 当前状态 | 触发窗口 / 关闭要求 |
|---|---|---|---|
| **TD-08** | Recall 排序前截为最近 50 条（M6 局限 §3） | 开放；M7-WP0 准入实验 9/9 判定不阻断 M7 | **M9 Belief 前必要时修**：先用目标规模证明候选遗漏是否影响所需能力；需跨全库时冻结新契约，比较分页/扩窗方案；第 1/51/最老条、资格、排名、预算均要正负控。不是立刻引入向量库。<br>⏩ **2026-10-04 修订（部分已做）**：M9.5 `M95-D25` 已把"排序前截最近 50"改成**相关性排序之后截断**、上限缺省 **200**、分页取完整候选集，并保 off 路径逐字节等价（[`M9.5-WP2-Handoff.md`](m9.5/M9.5-WP2-Handoff.md) :34 · `M9.5-Acceptance-Contract.md` :139-140；实测写 250 ⇒ 候选恰 200，`M9.5-WP9-Handoff.md` :94）。**仍开放**：`L-M95-09` —— subject 通道 `listBySubject` **无 limit**（注入 `scanCeiling=20` + 写 250 ⇒ `scanned=250`；修好会让两处判据报红，[`M9.5-Known-Limitations.md`](m9.5/M9.5-Known-Limitations.md) :39）。M11.1 审计判 **PARTIALLY SUPERSEDED**（:57） |
| **TD-09** | 大库 NL 遗忘 `target_ambiguous`（M6 局限 §4） | 开放；零依赖机器检查通过 | 与 TD-08 同窗口。用户表达→候选集合→唯一目标；歧义时澄清、无误删、重放一致；**不得**为命中率放宽目标确定性 |
| **TD-17** | 性能 SLA 未冻结 / 换模型未跑 / UI 像素级验证未做（M6 局限 §7） | 开放 | 性能在 M7 长时状态前（已到窗口边缘，见 §6 备注）；UI 在下次页面改动；模型在真实迁移时。NOT RUN ≠ bug；没有真实迁移需求不为覆盖率买第二模型。<br>⏩ **2026-10-04 修订（需拆项）**：① 「性能在 M7 长时状态前 / 归 M9-WP0/WP1，现在不做」**已过期** —— M9 未冻结（[`M9-Execution-Plan.md`](m9/M9-Execution-Plan.md) §22.4 只写了方法），但 **M9.5 已冻结契约值**：10k 召回链 p95 ≤ 1000 ms · query 截止 2000 ms · 派生可用 p95 ≤ 5 s，且必测 500/2k/10k 并必报扫描行数（[`M9.5-Acceptance-Contract.md`](m9.5/M9.5-Acceptance-Contract.md) §76-91；实读 `M9.5-WP9-Handoff.md` :94-98 / :204-213）；M11 线另有 p95 ≤ 50/100 ms 与实测 9.55 / 52.41 ms（`docs/m11/M11-Acceptance-Contract.md:46` · `M11.1-Gate-Decision.md:21`）。② **换模型**（M9.5 的 A3 是**编码档**，不是聊天模型迁移）与 **UI 像素级验证** 仍无读数。⇒ 拆项建议见 [`M11.1-Debt-and-Decision-Audit.md`](m11.1/M11.1-Debt-and-Decision-Audit.md) :69 |
| **TD-18** | INC-01 根因轴 PARTIAL | **开放 —— 用户 2026-09-27 裁定：收窄保留**（**不按残余接受关闭**）：近因**已确认**（保留坏库 `pg_control.checkPoint` 指的 checkpoint 记录已不在 WAL 里 ⇒ 启动恢复 PANIC ⇒ abort；判据用 Postgres 自身 `pg_walinspect`）· 一类**充分触发已最小复现 3/3**（同一 dataDir 两个活动实例 + 后写者持有陈旧 WAL 插入位置；严格串行对照 3/3 OK）· 单进程强杀 **12/12**、并发写者 **4/4**、并发只读 **3/3**、热复制 **3/3** 均已排除（都可恢复）· 跨进程租约对该触发类机械生效（实测 `production_db_in_use`）。**真实事故写入方仍未定** | **余下只三件**（收窄后的范围；其余不再重开）：① **写路径完整性** —— 枚举全部会打开 `data/pglite` 的入口并证明它们都在 `INV-DB-01` 租约之内（或给出反例）；租约正控只证明原语有效，**不等于**每个入口都调它；② **挂起形态定性** —— 把"WASM abort 后 PGlite 内部互斥未释放 ⇒ 进程挂死"从观察升为判定（正控/负控）；③ **真实写入方（Q2/Q3）** —— 仅在有**新证据**时才可能定位（现场已封存、WASM FATAL 原文不可取），**不因此关闭本项**。**不在真实库试开或破坏性复现**（含"并发入口端到端测试"，它需要真实数据目录）。报告 [`docs/incidents/INC-01-Root-Cause-Investigation.md`](incidents/INC-01-Root-Cause-Investigation.md) · 证据 `artifacts/incidents/inc-01/rootcause/` · 复跑入口 `scripts/inc-01-rootcause/` |
| **TD-20** | 多用户授权隔离未证明（M5.5.1 局限 §11⑨） | 开放（入口阻断项） | 微信/QQ 渠道开放多用户**之前**：实测账户/会话/权限/记忆/出站隔离 + 重复入站与回声抑制。保持自动回复既有预授权范围 |
| **TD-21** | K-31 回复确认 Axis-B 保真度偏差（R-34） | 开放 | 用户回复图/消息引用接入之前，渠道包准入时复核：先复核是否仍生产不可达，再明确 `USER_REPLY_CONFIRMATION` 与 `USER_EXPLICIT` 的 authority-selection 语义，builder/消费/生产三层证据验收。**不是已关闭的 K-29，不能只改枚举** |
| **TD-22** | **M9.5 派生索引的「写侧」从未实现** —— 生产里的语义召回**逐轮如实降级成 `not_indexed`**（`shadow` 档因此**连算都没在算**、无对照可记） | **开放**（2026-09-30 登记）。只读读回实测（`scripts/m9.5-semantic-index-readback.ts`）：四张派生表都在（M10 `MIGRATION_0010` 建出）· `embedding` 列为 `vector` · 但 `meta` **0** 行 / 代 **0** 个 / 向量 **0** 条。**`src/**` 里没有任何写侧**：全仓唯一写 `memory_semantic_*` 的是 `ensureSemanticIndexSchema()` 的版本行，而每一处 `build_state='published'` 都是**测试夹具**。**已在位**：规划器（`src/kernel/app/recall/index-maintenance.ts`，纯函数 9/9）· 探针（读侧，已接 `src/main.ts:1206`）· 编码器 + 134.0 MiB 资产（`artifacts/m9.5/local/embedding-lab/models/`，清单 `evals/m9.5/embedding-manifest.json`）。**缺**：① **规范渲染器**（`renderer_version` 在 `src/**` **只有列定义**，渲染目前只在实验室脚本里内联拼串 ⇒ 必须先冻结「什么文本进向量」）② 写侧落盘（WP5 `N1`）③ 失效传播（`N2`）④ 重试终态（`N3`）⑤ 重启重放 / 换代断电点（`N4`/`N5`）⑥ 生产入口 | **触发窗口**：**在「真建索引」或「切 `on`」之前** —— 两者是**两件独立的事**（计划 §20.2：建索引 = 第 3 步，切 `on` = 第 6 步）。**关闭要求**：① 按 §20.1 先在**生产副本**上完成全量索引 / 重启 / 切换 / 故障 / 回滚预演；② 生产入口**必须**走既有真实库入口（§19.3：租约 → pre-open 已验证快照 → token；**禁止**另写直连脚本）；③ **用户当轮明确批准生产动作**（ADR-074 `M95-D12` + `M95-D24` + §20.1 逐字一条）；④ 建索引**不是**认知突变（探针只能给**调用方已给的候选**打分 —— `if (!wanted.has(memoryId)) continue`，**无法凭空引入一条记忆**、不写 `memory_records`），但仍是真实库写操作 ⇒ 走生产授权程序。⚠️ **成本不是障碍**（编码 8 条批 p50 **9 ms** ≈ 1.1 ms/条 · `vector(384)` = **1536 B/条** · 资产已在位；惰性 worker 使 ~497.6 MB RSS **今天并未在付**，一旦真建索引 / 切 `on` 才开始付）。⚠️ **真正的瓶颈是收益**：真库 `active` 记忆 **1 条** ⇒ 即便全做完，语义排序**也排不出差别**；收益被**记忆体量**卡住，而体量被 `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`（缺省 off）卡住 ⇒ 与 §3 的 `M4 D3` / `M4 D2-A` 同一条线。<br>⏩ **2026-10-04 修订读数（不回写上文）**：写侧 / 规范渲染器 / 增量维护 / 生产入口**都已实现并已在生产激活** —— `src/infrastructure/persistence/semantic-index-builder.ts` · `semantic-index-production-runner.ts` · `semantic-index-reconcile.ts` · `src/kernel/app/recall/index-render.ts`（`RENDERER_VERSION`）· 维护入口 `pnpm m9.5:maintain`；生产库 `maint-production-…` 代 `build_state=published` · `indexed=1`（[`ADR-082`](adr/ADR-082-m9.5-semantic-recall-production-activation.md) §29/§71 · [`M9.5-Activation-WP7A-Handoff.md`](m9.5/M9.5-Activation-WP7A-Handoff.md) :41），`.env` 已设 `CHARACTER_MEMORY_SEMANTIC_MODE=on`（**代码缺省仍非 on**）。**仍开放**（按 [`M11.1-Debt-and-Decision-Audit.md`](m11.1/M11.1-Debt-and-Decision-Audit.md) §4.2）：真实规模 cursor 续跑 / 跨进程重启 / 生产 schema v2 列 / 自然查询轮级证据 / **收益**（真库 `active` 记忆 1 条 ⇒ 排不出差别，与 §3 的 `M4 D3` 同卡点）。⇒ 本条应从"缺 6 件"改读为 **PARTIAL**（与 §0k:969 的表格读数一致） |
| **TD-23** | **聚合器按"目录 mtime"选最新档**（并列时落到目录名字典序）⇒ 更早的 FAIL 可以盖住更晚的 PASS（§0m / R-34；`m10.1:gates` 的 `long:live (200)` 是实测案例）。另两处同族读数见 R-35（`m5.5.1:gates` 的语义门量到 TD-11 的**小样本诊断档**）与 R-36（`m4.5:gates` 的 G14 量到 2026-09-30 的失败档） | **开放**（2026-10-02 登记，Lv2 WP0）。**当前适用性**：`m10.1:gates` = `NOT PASS`、`m5.5.1:gates` = `FAIL`、`m4.5:gates` = `G14 FAIL` —— 三个读数的成因都是**选档口径**，不是"当前失败"，但**历史 FAIL 档一律保留**（TD-16 不回写） | **触发窗口：Lv2 的量具/聚合工作包（计划 §11.1 的 `lv2:gates`）落地时**。**关闭要求**：① 选档依据换成**清单里的身份/正式结束时间**（不是 `statSync` 的 mtime），并对"并列/缺失时间戳"给**失败关闭**或具名降级；② 三段式（正控：更晚的 PASS 被选中；负控：制造 mtime 并列 + 更早 FAIL ⇒ 必须仍选中更晚的 PASS；恢复：安静）；③ 计数型自检 `measured_count > 0`。⚠️ 本项**不**要求回改既有聚合器（属各里程碑自己的维护线）；Lv2 只保证**自己的**聚合器不继承这个缺陷，并如实分列这三处继承读数。<br>⏩ **2026-10-04 修订①（Lv2 侧已闭环）**：选档改用**身份** —— `scripts/lv2-gate-select.ts:142-155` 按 `ended` 降序（tie 按 `runId`）取，**不看 mtime**（`scripts/lv2-gates.ts:13/103-107`），三段式自证在 `scripts/lv2-measurement-verify.ts`。<br>⏩ **修订②（三处继承读数两处已变）**：`m10.1:gates` = **PASS**（18/18）· `m5.5.1:gates` = **PASS** · `m4.5:gates` = **仍 `G14` 26 通过 / 18 失败**（`artifacts/m4.5/smoke/smoke-result.json`，最后提交 `6a6367a8` / 2026-09-30，未回写）。<br>⏩ **本体未修（属各里程碑自己的维护线）**：`scripts/m10.1-gates.ts:74` 仍 `statSync(...).mtimeMs` 排序取 `.at(-1)`；`scripts/m5.5.1-gates.ts:68` 仍按 mtime 取 `observations.json`。⇒ 本条可读为"**Lv2 义务已履行 + 三处继承读数已核 + 本体留给维护线**"。<br>⏩ **2026-10-04 修订②（本体已落地，见 §0p `R-41`）**：**两处都修好了** ——
`m10.1-gates.ts` 改用新模块 `scripts/m10.1-gate-select.ts`（自报时间 → **head 提交时刻** → 证据提交时刻 → 清单日期 → 具名降级；**mtime 永不参与**），
并加"非权威档过滤（干跑）+ 并列判定不同 ⇒ `AMBIGUOUS` 失败关闭"；`m5.5.1-gates.ts` 的那处是 **2026-10-03 `4005f360` 顺带修的**（按 ended/提交时刻 + 跳过 `smallSample` 诊断档），**本轮才登记**。
读数：`m10.1:gates` = **18/18 · overall PASS**（`R-34` 的 `long:live (200)` 案例已按 head 时刻选到更晚的 PASS）· `m10.1:measurement:verify` **7/7**（新增第⑤检测器）·
`m5.5.1:gates` 的语义槽位选到 **`step4-full-v2-prod`**（`R-35` 的"未能确证"已有答案）。**仍开放**：m5.5.1 的选档器缺专属三段式控制；`m4.5:gates` 的 `G14` 是固定路径真 FAIL，与选档无关 |
| **M511-G8** | Break-Glass 演练 NOT RUN | 开放（**有意边界**） | 仅独立授权 + 隔离方案下规划；不因「清债」实施破坏性演练 |
| **M4 S3-1** | 迁移「中途失败 → 回滚」（**T32**）与「迁移后清空投影全量重放」（**T31**）无独立用例 | **T31 = 已覆盖；T32 = 开放**（2026-09-27 复核把原读数看细了）**（⏩ 2026-10-04：`T32` 已补 —— 见本行末修订）**：① **T31 的语义已由 `pnpm m4:verify` §8 覆盖** —— `scripts/verify-m4-persistence.ts:1132-1153` 断言「全部记忆 `rebuildMemory` **逐字段** `A == B`」+「整库 `rebuildCharacterMemories` mismatch = 0」，而 `rebuildMemory` 的定义就是**从事件从零重算**再比对（`src/kernel/contracts/domain-event.ts:507`、`src/kernel/projections/memory.ts:394`）—— 「先清空投影再重放」与「从零重算并逐字段比对」是**同一个性质**；② `scripts/` 里确实仍无 `T31`/`T32` 这两个**用例编号**（字面属实，但**不等于**性质未被验证）；③ **T32 真缺** | **T32** 在下一次新增迁移（0010+）时一并补，并**沿用 `T31`/`T32` 编号**以便与立案对齐。⚠️ 立案原文的 Target Stage 是「**M5 之前（新增 0006 时一并补）**」——0006…0009 都已过去 ⇒ 这条的窗口**比本登记册原先写的更早过期**。若要与立案措辞**逐字对齐**，可另补一条「先清空投影再重放」的显式用例（离线，改 `verify-m4-persistence.ts`），但**不是**因为性质未验。注：INC-01 的快照/恢复/租约机制已覆盖大部分实际风险面，优先级低。<br>⏩ **2026-10-04 修订：`T32` 已补（沿用原编号）** —— `scripts/verify-m4-persistence.ts` 新增 §8.5（`T31` 两处也补上了具名编号），`pnpm m4:verify` = **147 通过 / 0 失败**（原 142）。读数：**正控** 不注入失败 ⇒ `applied=13/13` · `committed=267`；**负控①** 迁移中途失败**抛出**（错误上下文 = `迁移 2（m2.5-character-kernel）执行失败`）；**负控②** `rolledBack=true` · `committed=0`（**一条版本行都没留**）；**负控③** 失败点在**第 1 条迁移登记之后**（`executes=7 > 阈值 6`，第 1 条迁移 3 条语句）⇒ 量的确实是"中途"而不是"第 0 步"；**`T32-b`** 生产手柄 `db.transaction` **存在**（与 `src/db/index.ts` :286-299 同一个 `getRawDb(runtime)`）⇒ 原子路径在生产里**真的被走到**，不是"看起来原子"。**仍开放的边界**：本用例量的是**迁移链**的原子性，不含"迁移后清空投影全量重放"的独立编号（`T31` 已由 §8 的逐字段 `A == B` 覆盖） |
| **M4 S3-5** | `dedup` / `temporal` 两个评测套件空壳 | 开放（`evals/m4/extraction-cases.ts` 确认仍为预留） | 与 S3-2 同窗口（语义去重第三层落地时）；对应能力目前由 `m4:scale` / `m4:test` 时间语义组覆盖 |
| **M4 S4-2** | `hydrate` N+1（`memory-store.ts:526` 起，每条 3 查询） | 开放（本轮复核确认仍在） | 与 TD-08 同窗口（召回规模上来之后）；790 条规模下无可见问题 |
| **M8.5 首启观察** | 语义情绪激活后的**流量依赖读数**（评估延迟 / token 用量 / 失败率）与生产端点（`api.deepseek.com`/`deepseek-flash`）运行时核对——验收读数全部来自 ark 测试端点（`L-M85-14`） | **首轮读数已出**（2026-09-27，激活后 **3 轮**真实对话）：水位 词形 117→133 · s117→133 · w117→132 · impact 未预置→123 · cutover 117（不动）· 终结闸 3（1 COMMITTED + 2 NO_IMPACT）· 异常终结 0 ⇒ **失败 0/3**；语义四步 1238–3094ms（轮后 drain，不放大轮时延）；生产端点运行时核对 = `api.deepseek.com` / `deepseek-flash`（≠ 验收端点）✔。**token 与单次调用形状在现有观察面不可得**（provider 采集 shape 但无持久面）——如实记不可得、不填 0。读数 [`M8.5-Production-Observation.md`](m8.5/M8.5-Production-Observation.md)。**仍开放**：N=3（1 会话/1 用户/1 时段，0 次失败被观测）⇒ **不构成稳定性判据**；另如实登记该真实会话未 `cleanClose`（不定性） | **样本不足 ⇒ 继续观察**：下一次真实对话后按同一批字段再记（五水位 / 任务与终结闸分布 / 语义四步 elapsed / token 与形状仍记不可得）；**升档**（谈失败率与延迟量级）需多时段 + 多会话 + 至少一次真实失败或重试被观测。异常形状（高频 `truncated`/`unparseable`、失败率抬头）⇒ **先回滚**（`.env` 删行）**再排查，不在线调参**；生产 token 采集属新量具，需独立设计与 L0 门 |

## 2. 仍开放 · 触发点已过但复核未做（应尽快补登记或补复核）

> ⏩ **2026-10-04 修订**：本节的标题口径**已过期** —— 三条的"复核"**都已在 2026-09-27 补做**
> （[`TD-10-TD-12-Reliability-and-Privacy-Phase1.md`](tech-debt/TD-10-TD-12-Reliability-and-Privacy-Phase1.md)）
> 并在 2026-10-02 由 [`M11.1-Debt-and-Decision-Audit.md`](m11.1/M11.1-Debt-and-Decision-Audit.md) §4.1 再确认（:64-67）。
> 变的是**分类**（"待复核"→"已复核、仍开放"），**不是**状态：三条**都仍 OPEN**（各自缺口 G-1 / G-2 / G-5 / G-6 / G-7 未修）。

| ID | 问题 | 当前状态 | 处置建议 |
|---|---|---|---|
| **TD-10** | DDG 可用性波动 / 代理依赖 | **部分被事件取代**：provider 已两次换代至 Tavily（ADR-053 → ADR-054）；ADR-051 草案已落地为 `NOT APPROVED` 历史（`0ec6ac5`）。✅ **2026-09-27 第一阶段证据已出**（只补测试与证据，未改实现/策略）：离线门 `pnpm td10:reliability` **46/0 EXIT 0**（超时 62ms 真触发 · 空结果 · 坏形状 · 4xx/5xx/限流/连接错误/取消 共 14 用例逐条分列 + 五态 + 出站形状）；真实探针 `pnpm with-test-model pnpm td10:reliability -- --live` 三个窗口 **16 发**（0 失败 0 超时，1.1–2348ms，每次 3 条 HTTPS / 1 credit）。**新发现缺口 G-1**（401/403 凭证被拒被 `replyStateOf` 读成"未启用联网"⇒ 说错失败原因）。详见 [`TD-10-TD-12-Reliability-and-Privacy-Phase1.md`](tech-debt/TD-10-TD-12-Reliability-and-Privacy-Phase1.md) | 搜索稳定性独立维护线保留；Tavily 时代的可用性观察散见 `L-M55-12`（超时常态）。**建议**：provider 每次换代/限流复发时按 TD-10 原要求出多时段探针证据，不默认「换了就稳」。**本阶段仍缺口**：G-2（多时段样本不足；本轮 ≤2348ms 与 ADR-054 的 max 8365ms 量级不同，n 小 ⇒ 不推断）· G-7（真实限流/真实超时只在注入路径上验证过）· G-1 修复属改策略，须独立裁定。<br>⏩ **2026-10-04 修订（G-1 已闭合，见 §0p `R-44`）**：**provider 的映射一个字节没改**（`401/403 ⇒ permission_denied` 是 `D-28` 的设计，且 `m5.5:measurement:verify` 拿它当冻结判据）—— 修点在**回复层**：`searchFactOf` 以前把 provider 放在 `details.status` 里的 HTTP 状态**丢了**，现在追加 `failureHttpStatus`（只带一个数字，不搬正文），`replyStateOf` 据此把 **401/403 ⇒ `failed`**（"搜索失败"）与**策略/开关 ⇒ `not_enabled`** 分开。读数：`td10:reliability` **59/0 PASS** · `td12:privacy` **61/0** · `m5.5:test` 59/0 · `m5.5:verify` 46/0 · `m5.5:e2e:verify` 25/0。**G-1 不再是"修复属改策略，须独立裁定"**：它没改策略，只补了被丢掉的**状态**。 |
| **TD-11** | e05 span 历史故障未定位；e12 语义分歧稳定性 | 开放。触发条件写的是「auto_public 激活前复核」——**auto_public 已于 2026-09-22 激活（ADR-052）**。✅ **2026-09-27 复核已补做**（R-15 + [`M5.5.1-TD-11-Review.md`](m5.5.1/M5.5.1-TD-11-Review.md)）：e05 ③ 排除 / ② 有缺口但非成因 / ① 不可定论，且那次已定性为**量具分叉**（S1 后闭合）；e12 历史分歧率 2.7%，本轮冻结标签 6/6 未复现 | **本体保持开放**：e05 模型侧未定位、e12 未复现≠已消除。新增 `TD-11-a`（指令未写坐标基准 + 观测不记偏移）与 `TD-11-b`（历史那次永久不可追溯，已接受）。关闭要求不变：定位到可复现的机制，或按用户裁定改标签/门槛
| **TD-12** | `L-M55-15`（词形触发误判：漏触发 / 私人否定引用误触发 / 查询抽取）· `L-M55-17`（隐私边界端到端证据）· `L-M55-03`（任意语言假搜索口吻） | 开放（M5.5.1 §11⑤⑥：「未完」「待针对性端到端证据」）。✅ **2026-09-27 第一阶段证据已出**（只补测试与证据）：离线门 `pnpm td12:privacy` **54/0 EXIT 0**，语料 **31 条**逐条分类 + 出站逐条核对。**已达**：私人内容（无触发词）5/5 安静且出站 0 · 6 个上下文哨兵出站 0 命中（类型上无处可放）· 出站形状逐条合规（六字段/三头名/凭证只在头）。**新量出的缺口**：否定句 11 条里 **3 条仍触发**（`不要，联网搜索`→query 抽成 `不要`；`别用这个，搜索一下…`；`unable to search the web`→query 抽成 `unable to right now`）· 引用/转述文本 **4/4 全部触发**（`D-5` 既定性质）· 用户把私人内容写进显式查询时随 query 出站（边界事实，未做自动脱敏）。详见 [`TD-10-TD-12-Reliability-and-Privacy-Phase1.md`](tech-debt/TD-10-TD-12-Reliability-and-Privacy-Phase1.md) | 涉及对应功能再激活/扩展前给出分项端到端证据与剩余范围；§7.2 矩阵端到端复核为可选加强。**本阶段仍缺口**：G-5（三条否定缺口，修复=改判据/改策略，须独立立项）· G-6（语义级引用/否定识别，属新里程碑）· `L-M55-03`（任意语言假搜索口吻）本次**未覆盖** |

## 3. 仍开放 · 等产品/授权裁定（**能力缺口，不是 bug**）

| ID | 问题 | 说明 |
|---|---|---|
| **TD-19**（= DC-1/2/3） | 系统发起与后台路径缺口 | Lv2 后的后台调度能力包 / 入口阻断项：系统主体归因、授权、幂等、ledger、trace、恢复与回复真相端到端。人格建设不借机接后台任务 |
| **M4 D3** | 后台记忆抽取 NOT-WIRED | `CHARACTER_MEMORY_BACKGROUND_ENABLED` 无任何消费者，启动如实告警——**她目前只记得住被明确告知的事**。M4 债表的原话是「要么补接线，要么把开关标成尚未接线并从文档里去掉『两条路径』的说法」——**文档侧的「要么」✅ 已做**（R-10，`cd610e7`：`docs/architecture/README.md` 追加现状注，不再把两条路画成对等；`memory-lifecycle.md` §3 原本就如实标注）。接线归 TD-19 能力包 |
| **M4 D2-A** | 显式路径规则抽取器覆盖面外**如实**回报 `content_unresolved`（**不是**静默失败 —— `response-truth.ts` 的确定性守卫保证"没写入"之后不可能出现成功口吻） | ✅ **方向裁定已出**（用户 2026-09-30，见 §0g / R-23）：**先扩槽位线索表**（不是先接模型兜底）⇒ 已由 **M9.7** 执行两个增量（`content-rules@2→@4`、登记表 11→13 槽位、`extracted` 19→29、登记表可达例子 10→17）。**仍开放的部分**：① 登记表 4 个 declared examples 抽不出（`L-M97-01`）② 接 `ChainedContentExtractor` 未做（要 `C-4` 的显式推翻 ADR-056 §5 + `C-6` 的预算/延迟上限）③ 一条**已知假阳路径**（`L-M97-02`）④ 取值边界线的 5 条观察（`L-M97-03`，**不许混着修**）。⚠️ `CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED` **仍缺省 off**（一个字没动）。<br>⏩ **2026-10-04 修订（计数与版本已漂）**：`CONTENT_RULE_VERSION` 现为 **`content-rules@6`**（`src/kernel/app/memory/content-extractor.ts:85`），登记表键数 **18**（`ADR-089` 又追加 5 个：实验室位置 / 备用便携设备 / 茶 / 咖啡 / 颜色偏好）；上文 `@2→@4`、`11→13 槽位`、`extracted 19→29` 是**当时**读数。**并且 `@6` 之后 `pnpm memory-coverage:verify` 一次都没重跑**（最新档 2026-09-30 23:35，语料 `frozenAt 2026-09-30` / `itemCount 47`）。⏩ **2026-10-04 已补跑**：**PASS（47/47 一致）**，当前读数 **`extracted = 27`** · `content_unresolved = 11` · `intent_not_detected = 6` · `not_remember_intent = 1` · `content_empty = 2`；`memory-coverage:e2e` **PASS（46 喂 ⇒ 27 写）** ⇒ 归属 M9.7 维护线 |
| **M4 S3-2** | `MEMORY_MERGED` 接口就位、无生产者 | `resolveConflict()` 的重复走 `REJECT_DUPLICATE`（`target-resolver.ts:62` 注释确认原状）。语义去重第三层的语义判别器接上后才有生产者 |
| **`L-M97-01`** | 登记表**仍有 4 个 declared examples 抽不出**（M9.7 / WP1 之后的残量） | 逐条理由见 [`M9.7-Known-Limitations.md`](memory-coverage/M9.7-Known-Limitations.md) §1：「海鲜过敏」（补它会造出语义错误：`food.avoid.general = 喜欢辣`）·「我平时用 Windows」（加平台名会撞 **ADR-058 `D-58c`** 的 ★负控）·「我用 VS Code」（加大小写变体会让 **4 条既有断言**的输入句变可抽 ⇒ 要**单独授权**改判据）。**不是违约**：`memory-invariants.md` §16.10 逐字写着线索表的不完整是**被设计允许的** |
| **`L-M97-02`** | **已知假阳路径**：抽取器**没有问句守卫** ⇒ 一句**问句**会被记成一条事实 | 实测（语料探针 `mc-probe-0001`）：「记住，我的生日是什么时候」→ `person.birthday = 什么时候`。**今天够不到生产**（唯一接线的显式路径要求先说「记住」；后台路径 NOT-WIRED）⇒ 是**未来风险**：**TD-19 一旦接上后台路径它就成为现实风险**。修它要**问句守卫**（影响所有规则的行为变更，不在"只扩线索表"的授权内）；⚠️ 且这是**既有的一般性质**（既有槽位同样如此：「我的专业是什么？」→ `education.major = 什么`）。<br>⏩ **2026-10-04 修订**：「**今天够不到生产**」**不成立** —— 该假阳已被证实会落库（§0g:535 · [`M9.7-WP4-Handoff.md`](memory-coverage/M9.7-WP4-Handoff.md) :87）；疑问词取值已由 `VALUE_STOP_SET` **收窄**，但**问句守卫未做** ⇒ 仍 OPEN（M11.1 审计判 `NARROWED / OPEN`，:62）<br>⏩ **2026-10-04 修订②（守卫已做，见 §0p `R-52`）**：`isQuestionLike()`（**`content-rules@7`**）已插入**四处**（规则抽取器 · LLM 抽取器 · 后台规则/LLM 抽取器），窄两级判据 + 豁免语境；三段式落在 `extractor:value-boundary:verify` §6（问句沉默 **5/5** · 反例组**不得误杀** **8/8** · 摘掉守卫必须又抽出来）；回归面全绿（`m4:test` 259/0 · `memory-coverage:verify` 47/47 · e2e 46/46 · `lv2:diagnose:memory` 7/7）。**残余仍 OPEN**（本守卫只挡"整句是问句"）：引用/否定/qualifier 表达不了的那部分、"陈述句里夹问句片段"（`DR-11`，不主张"她不会再记错"） |
| **`L-M97-03`** | **5 条"可达但取值可疑"**（含 `education.major` = 单字「的」） | **只登记、未修** —— 归**取值边界线**（ADR-056 / `m6.1:extractor:repro`）。⚠️ ADR-056 §5 与 `M6.1-WP5-Failure-Attribution.md:138` 的具名分组裁定都逐字**禁止把"扩覆盖"与"修取值"混着做**。逐条读数见 [`Memory-Coverage-Baseline-Report.md`](memory-coverage/Memory-Coverage-Baseline-Report.md) §4.4。<br>⏩ **2026-10-04 修订**：已 **3 修 / 2 未修**（§0h / R-24 :588）—— 未修的两条（`D` 「的项目」空白分段 · `E` `neovim` 在 `cueInValue`）**已特征化在门里**（修好会报红）；原"5 条只登记、未修"作废（`extractor:value-boundary:verify` 覆盖） |

## 4. 仍开放 · 记忆与行为长尾（已接受或待专项）

| ID | 问题 | 状态与处置 |
|---|---|---|
| **L-M61-01/02/03** | again_family / timeline 措辞长尾 / RCE-02 | 用户裁定 E **接受为长尾**（DR-11：措辞层无启发式守卫；提示词迭代边际已到）。TD-06 桥段销的是「修复预期」，本体登记不动 |
| **L-M61-04** | 长程回忆衰减：显式「记住：」事实 200–500 轮取回失败 | **M6.1 的真实行为发现**，M7 未触碰记忆链，至今无人接手。处置：记忆专项（检索排名/记忆衰减/上下文预算的长程行为），建议 M9 前立项。<br>⏩ **2026-10-04 修订**：「至今无人接手」**已过时** —— M9.5 已把长程取回作为核心专项**接收**（[`M9.5-Debt-Reception.md`](m9.5/M9.5-Debt-Reception.md) :18 / :34-35），并出了三条 500 轮轨迹读数（off/shadow/on 各 500 / 0 失败，[`M9.5-WP9-Handoff.md`](m9.5/M9.5-WP9-Handoff.md) :176-185）；代价面 `L-M95-09`（p95 约 3.4×）。M11.1 审计判 **PARTIALLY COVERED**（:68） |
| **L-M61-05** | 更正渐蚀：专业更正 60 轮后回潮旧值 | 同上（与 L-M61-04 同一专项）。<br>⏩ **2026-10-04 修订**：M9.5 覆盖到"候选/入模"层，但本条点名的**层⑦摘要 / 层⑧回复「旧值回潮」仍 `NOT RUN`**（[`M9.5-Debt-Reception.md`](m9.5/M9.5-Debt-Reception.md) :88）⇒ 仍 OPEN，边界不变 |
| **L-M7-01** | 锚点语义：日常聊天不推锚，侵蚀持续 | 契约行为非缺陷（ADR-064 §5.1）；若用户裁定「日常陪伴也应计互动」⇒ ADR 修订锚点语义（语义变更，不是 bug 修复） |
| **L-M7-02** | 日基规则（≥10 条跨 ≥2 日 / >24h 侵蚀）真实时钟下不可验证 | 已知边界：证明只在合成时间线上；有跨多日真实使用读数后对照复核 |
| **L-M7-03** | 关系规则是冻结词形判据，不是语义理解 | 设计取舍（ADR-064 D-4）；WP6-B 漏报读数未出（诱导中招 0/6 + 长形 0/34），暂无开 LLM evaluator 里程碑的依据；真实使用若现频繁 2000 强制 flush 再议 |
| **L-M7-07** | 攒尾窗 2000 条强制 flush 上界 | 装配层策略；频繁触发 = L-M7-03 漏报信号，不是调度问题 |
| **L-M85-11** | M8.5 语义评估关键假阳残差（2/29 = 0.0690，b-rep-006 维持 UNCERTAIN） | **用户裁定接受为终态**（2026-09-27 人审声明式裁定，判定权在用户；不重跑凑数、不调参）。完整残余清单 `L-M85-01…18` 以 [`M8.5-Known-Limitations.md`](m8.5/M8.5-Known-Limitations.md) 为权威；`L-M85-17`（语义判定不是事实来源）对 M9 是硬边界 |

## 5. 仍开放 · 量具与证据缺口

| ID | 问题 | 处置 |
|---|---|---|
| **L-M61-06** | 要点匹配措辞等价不足（「不吃/回避辣」≠「不吃辣」） | 处置原文的「单列」已在 M6.1 局限 §3 落地；**边界已上锁**（R-09，`8deeb4a`：`m6.1:test` 断言近义改写如实不命中 + 版本钉在 v2）。**本体留待量具修订 v3**（改判据须重新出读数），不在零风险批内 |
| **L-M61-07** | 判定器看不到人设（persona bio 不在证据面） | **从零风险批移出**（R-11）：改 `factBase` = 改判定器输入面，必须与一次**新量具有效性判定**同批。前置条件已写进 M6.1 局限 §3：@10 证据面修订立项 + 两轮判定复验 |
| **L-M61-08** | 断言式否认被标 UNSUPPORTED_DENIAL 的标签语义 | **已落地（文档）**：人审口径「看原文；alert ≠ 她编造」写在 M6.1 局限 §3（含 V2-IN90/IN350 两个实例）。无代码动作（R-11） |
| **L-M61-09** | 探针预期设计误差（V3，5 条） | **已内化**：教训「预期必须对准留存语义」（显式写 ⇒ 预期取回；随口 ⇒ 预期拒绝）已进探针设计。5 条读数是历史事实，不回写、不补跑（R-11） |
| **L-M61-14** | m6.1 live 运行器 manifest 早于聚合器契约（`m6.1-manifest@1`） | ✅ **已闭合**（R-08 发射侧 `930c82f`+`8deeb4a`；R-17 `1227f72` 取得聚合绿）：公共字段收进 `scripts/m6.1-run-manifest.ts` 一处、三个运行器共用；写侧加「缺字段即拒盘」失败关闭闸（只对 `m6.1-manifest@1`）；新清单经聚合器判 `completion=COMPLETE usable=true`，**字段闸在新 run 上实过**。✅ **2026-09-27**：`m6.1:gates` = **4/4 接受 · overall = PASS**（`1227f72`） |
| **L-M61-15** | 混合树上 wp0 基线 PARTIAL | ✅ **已关闭**（R-14 `58d0622`：`docs/m9/` 如实归属；R-17：干净树上 wp0 = `BASELINE CAPTURED` + 聚合 PASS） |
| **TD-14** | `m6:live` 只有守卫 | ✅ **已修复**（R-13，`bf4c941`）：`suite_not_implemented` 文案 + `m6-live.ts` 收尾各加指针，指向 M6.1 已交付的真实入口 `m6.1:live --suite short|long`。**只改文案**（`M6_LIVE_SUITES` 字段被 L0 门 §3-11 钉着）；实测 `m6:measurement:verify` 46/46 + 正控 `--suite smoke` ⇒ 新文案 + EXIT 2 |
| **TD-15** | 旧 scope 缺失警告、39/32 注释漂移 | ✅ **已修复**（R-07，`42cbc3e`+`ea9fba0`）：wp6b 的新 payload 补真实 scope 段（旧 JSON 不补写，TD-16）；`PLAN_10_1` 条数改为从清单本身生成（单一来源），门标签去掉写死条数。实测 `m6:gates` 不再报 `rollup_scope_missing`，Hard Gates = PASS |
| **M6 G1 §7.2①** | A–E ≥15 条完整轨迹未持久化 | 用户 2026-09-22 裁定**接受现状**（缺口如实留档）；若要补：扩展 `verify-m6-wp7a.ts` 持久化两侧正文再按类抽取，需另行排期与授权。§7.2 其余未达项均已被后续工作取代：②材料范围→M6.1 TD-03 新装配；③遗忘后旧偏好→M6.1 行为门；④FMB→M6.1 CLOSED；⑤复读/挟持→TD-06 读数；⑥摘要激活→ADR-052 ACTIVATED |

## 6. 仓库卫生与流程（可选 / 低优先级）

- **旧特性分支 ✅ 已删（2026-09-26，用户裁定「feature/* 旧分支删除」）**：
  5 条已合并的里程碑分支（`feature/m4.5-action-foundation` · `feature/m5-retrieval-context` ·
  `feature/m5.1-developer-plane` · `feature/m5.5.1-adaptive-search` · `feature/m6-lv1-hardening`）
  以 `git branch -d`（**安全删除**，会拒绝未合并分支）删除；tip 与可达性依据见 §0b 的 R-12。
  现存分支只有 3 条：`feature/m7-relationship`（当前工作分支，M8 在其上开发）·
  `main`（`ba7acbf`）· `fix/m4.1-memory-correctness`（`ecfadd9`，非 `feature/*`，未在本次裁定范围）。
  仓库无远端，11 个里程碑标签完好。
- **`m7-complete` 标签漂移**（指向 `c8afc59`，其后 5 个提交 + 本轮 6 个提交以最新权威报告为准）：读取规则已由 M8 计划 §1.3 与 AGENTS.md 状态行登记，**不改写标签**。
- **TD-17 性能窗口备注（2026-09-27 更正）**：原排期「性能在 M7 长时状态前」已滑过，且**不能**拿门耗时（`pnpm gates:profile`）顶替「性能 SLA」—— [`docs/m6/M6-Known-Limitations.md`](m6/M6-Known-Limitations.md) 写的是「③ 性能 SLA = **未冻结 ⇒ 不判（不临时拍秒数）**」，而 [`M9` 计划 §22.4](m9/M9-Execution-Plan.md) 规定了正确的冻结方式：**同设备 / 同隔离数据规模 / 同配置**下由 **M9-WP0 测基线、WP1 冻结**每次形成/查询/上下文回查的上限，记录 **p50/p95 · 扫描行数 · DB 调用数 · payload 大小 · 累计状态大小**；并明文「**不继承其它里程碑的墙钟总时长当本模块 SLA**」。⇒ 结论：**性能这一项归 M9-WP0/WP1，现在不做**；`换模型` 等真实迁移需求、`UI 像素级验证` 等下次页面改动。本登记册**不**临时拍秒数、也**不**用门耗时冒充产品性能。
- **流程教训（R-01 的根因）✅ 已进协作约定（R-12，`AGENTS.md` §8）**：并发会话在共享工作树上工作时，「共享文件的改动会被后续里程碑提交整文件带入，而新文件留在未跟踪区」——**会话结束前应把自己的全部产物（含新文件）按路径提交**，或明确交接给接管会话；接收方提交共享文件前应检查 `git status` 里是否有自己不认识的未跟踪文件被自己的提交引用。现已写成 `AGENTS.md` §8 的三条（多会话纪律 · 禁止 `git add -A`/`git clean -fd` · 跑门与提交分离）。

---

## 7. 状态导航（当前 / 历史 / 取代关系 —— TD-16 三列）

| 事项 | 当前（本登记册） | 历史 | 取代关系 |
|---|---|---|---|
| 前置 TD 表 TD-01…05 | **已由 M6.1 承接销账**（M6.1 = PASS，2026-09-26） | 前置表 2026-09-22 排期 | M6.1 Gate-Decision §0 第 1–6 行取代排队状态 |
| TD-06 | **关闭（读数销账）**：定义冻结 + 量具 13/13 + 短形 0/6 + 长形 0/34 + 人审 12/12 | 前置表 P2 / M6.1 G1 §6.4 行为观察 | M7 Gate-Decision §6.6 销「修复预期」；G1 §6.4 观察仍为最新行为事实（未被取代的边界：脚本化台词，有机用户行为归激活后真实使用） |
| TD-07 | **CLOSED**（M7 WP6，preflight 11/11 + doc:sync） | 前置表 P2 | M7 Gate-Decision §3 取代排队状态 |
| TD-13 | **已修复**（R-02，`79e3088`） | M5.5.1 局限 §10「刻意不修」 | 冻结理由随 M7 动 src/** 失效；本登记册 §0 取代「等下一次」 |
| M4 S4-1 | **已修复**（R-03，`8e84aa1`） | M4 债表 target=M5；M5.1-Repository-Map D-5「不自动纳入」 | 用户 2026-09-26 裁定接收；本登记册 §0 取代排队状态 |
| M4 S3-1 | **T31 已覆盖**（证据 `m4:verify` §8 的逐字段 `A == B` + 整库 mismatch=0，2026-10-04 起带 `[T31]` 具名编号）· **T32 已补**（2026-10-04：§8.5 正控 + 三条负控 + 生产手柄事务能力实测；`m4:verify` **147/0**） | M4 债表 `docs/m4/M4-Technical-Debt.md:94`（**冻结，未回写**）；立案 Target Stage =「M5 之前（新增 0006）」**已过期** | 本登记册 §1 行取代「T31/T32 两条都没有用例」的粗读（R-18）；补 `T32` 时沿用原编号（✅ 已按原编号补齐） |
| M6-FMB-01 | **CLOSED**（M6.1 按原立案 §5 条件；主张=可查/可审计/可测） | M6 WP9b NOT MET + 探测器 INVALID（历史保持） | M6.1 Closure Addendum 取代「优先修复项」状态；AGENTS.md §4 表的「后续人格主线优先修复项」行按历史读数保留 |
| G1（M6） | **PARTIAL**（人工复核已完成 2026-09-22；未达项见 §5 的 G1 行） | AGENTS.md M6 段「AWAITING HUMAN REVIEW」为更早读数 | M6-Gate-Decision §0 为权威 |
| Original Lv1 | **已由 M7 交付取代**（关系状态演化 + WP6-B 读数 + 人审 + 激活） | M6 判定「PARTIAL（延期至 M7）」 | M7 Gate-Decision §0/§6 取代 |
| m6 聚合门 | **PASS（2026-09-26 实测）** | AGENTS.md「当前 NOT PASS」（2026-09-22 ddg 超时） | Tavily 证据落地（`31897f0`）+ AGENTS.md 修订读数注记取代 |
| m6.1 聚合门 | ✅ **PASS（4/4 接受）**（2026-09-27，R-17）：`component 313/0` · `measurement 16/0` · `wp0 BASELINE CAPTURED` · `wp1-corpus FROZEN` | M6.1 收口时=**NOT PASS**（INC-01/M8 混合树噪声 + 旧清单契约漂移） | R-06 消除 INC-01 侧；R-08 消除清单漂移；R-14 清 `docs/m9/` 归属；R-17 一次取得全绿 |
| TD-15 | **已修复**（R-07，`42cbc3e`+`ea9fba0`） | 前置表 `PROPOSED SCHEDULE`「下一次有意维护量具时」 | 本登记册 §5 行取代排队状态；旧 wp6b JSON 按 TD-16 不回写（新 run 已带真实 scope） |
| M4 D3（文档半边） | **已修复**（R-10，`cd610e7`） | M4 债表 `docs/m4/M4-Technical-Debt.md:73`（**冻结，未回写**）· `memory-lifecycle.md` §3（早已如实标注） | 本登记册 §0b 取代「文档侧的要么至今未做」；接线部分仍归 TD-19 |
| AGENTS.md 状态面 | **已更新至 M8 立项时刻**（R-04）+ 本批追加 M6.1/L-M61-14 修订读数与非破坏性协作约定（R-12） | 2026-09-22 版 | 后续里程碑收口时继续追加，不回写 |

---

## 8. 本轮验证读数汇总（2026-09-26）

```text
pnpm typecheck                        EXIT 0（修复后混树，含 M8 在途代码）
pnpm m4:test                          258 通过 / 0 失败（含 S4-1 新增 4 断言）
pnpm m4:verify                        142 通过 / 0 失败
pnpm m4:mutation-safety:verify        20 通过 / 0 失败
pnpm m4:nl-mutation:verify            38 通过 / 0 失败
pnpm eval:m4                          17 通过 / 0 失败
pnpm m4.5:test                        135 通过 / 0 失败
pnpm gates:run --lane summaries       7/7 PASS（m5/m5.1/m5.1.1/m5.5/m5.5.1/m6/inc-01）
pnpm m6.1:wp0:baseline（重跑）        PARTIAL（INC-01 噪声清零；剩余 24 unknown = M8 在途）
真实库树摘要（基线重跑实测）          f65531b1322f340c…（与 M8-WP0 读数逐字一致，未被动）
提交：5607b44 · 93abd26 · 0ec6ac5 · 31897f0 · 79e3088 · 8e84aa1 + 本批（登记册/AGENTS/基线证据）
```

### 8.1 第二批（零 M8 风险清偿）验证读数（2026-09-26）

```text
pnpm typecheck                          EXIT 0（本批验证时刻）
                                        ⚠️ 这是**时点读数**，会被 M8 的在途文件翻转 —— 本次会话内就翻了两次：
                                        改动前 EXIT 2（3 条错误全在 M8 的 scripts/m8-long-trajectory.ts）→
                                        本批验证时 EXIT 0 → 提交本登记册后 EXIT 2（2 条 TS18047，全在 M8 的
                                        scripts/m8-live-level1.ts）。**每次都要重新读**，不能当恒定基线；
                                        本批自身的改动 typecheck 干净（报错文件都不在本批提交清单里，见各提交 --stat）。
pnpm m6.1:test                          313 通过 / 0 失败（L-M61-14 正控/负控/反向保护/恢复 + L-M61-06 边界钉 = +2）
pnpm exec tsx scripts/verify-m6-wp6b.ts PASS（15 项断言 0 失败 · 子门 6 条全 EXIT 0）
                                        runId m6-wp6b-20260926-cd610e730148 · head=cd610e730148 · scope 段在位（逐字读出）
pnpm m6:gates                           必选门 17 个 · 未运行 0 个 · 未通过 0 个 · **Hard Gates = PASS**
                                        且 `⚠️ rollup_scope_missing` **不再出现**（修前对旧 wp6b run 每次都报）
真实库树摘要（wp6b 前后）                f65531b1322f340c…（1208 文件 / 32436767 字节，前后逐字相同）
                                        本批**从未打开真实库**：wp6b 的 realDb 段是纯文件摘要（digestTree，不打开库）
标准 schema 写者字段核对                6 个写者 × 22 个必填字段 = 无缺
                                        （payloadSha256 由 sealManifest() 补、不字面出现；三个新改的由 standardManifestFields() 提供）
证据白名单还原                          inc-01 的 5 份聚合读数 + m4-acceptance 的 hardkill/restore 两份
                                        （被 wp6b 的子门重新生成，**不是**本批结论，按 §7 纪律还原；只保留新增的 m6-wp6b/m6-wp3-reader + component.json）
提交：42cbc3e（TD-15）· 930c82f（L-M61-14 核心）· 8deeb4a（测试锁）· cd610e7（文档）· ea9fba0（证据）
      + 本批（登记册 / AGENTS.md）
```

> 未变红基线：改动前 `pnpm m6.1:test` = 311 通过 / 1 失败，那 1 条正是**本批新加的负控**（基线取错，
> `payloadSha256` 被 `sealManifest()` 重算 ⇒ 该格测不到）；修正基线后 313/0。改动前后**没有**别的断言被翻转。

> 改动前基线：`pnpm m4:test` 在本轮任何改动之前先跑过一次 = EXIT 0（归因保险：修复后 258/0 与基线同绿）。

### 8.2 第三批（2026-09-27，M8.5 人审窗口内的非 M8.5 清偿）验证读数

```text
pnpm m6:measurement:verify              PASS 46/46（§3-10 suite_not_implemented · §3-11 三套件仍 !implemented）
  正控（零模型调用）                     DSH_TEST_MODEL_WRAPPER=1 tsx scripts/m6-live.ts --suite smoke ⇒ 新文案逐字 + EXIT 2
pnpm m6:gates                           必选门 17 个 · 未运行 0 · 未通过 0 · Hard Gates = PASS（新增证据未扰动聚合）
pnpm m6.1:wp0:baseline（新 run）         BASELINE CAPTURED（unknown=0 · otherTask=3 · sourceTree unchanged/unexpected=0）
  负控 / 恢复                            PARTIAL（unknown=1）/ BASELINE CAPTURED（unknown=0）—— 三腿只差那一行
m6.1:gates（单清单自证）                 wp0-baseline ✅ usable=true；其余门如实 NOT RUN（overall = NOT PASS 是设计）
pnpm m5.5.1:measurement:verify           37 通过 / 0 失败（含空白 span 负控 + 恢复两条）
m5.5.1:semantics:live（M551_SMALL=1 ×3） DIAGNOSTIC ONLY（设计判决）；24×3 观测 · 传输失败 0 · 格式失败 0 ·
                                         三轮逐条一致；e05/e12 各 6/6 search → allowed → spanValid=true
真实库树摘要（2026-09-27 实测）          1bff1d600905abe5…（1208 文件 / 32436767 字节），newestMtime 2026-09-26T13:05:29Z
                                         与本登记册 §8.1 的 f65531b1… 不同 ⇒ 中间有一次原地写入（见 R-16）
提交：bf4c941（R-13）· 58d0622（R-14 修复）· 2a571e5 + 258cece（R-14 / R-15 证据）· 本批（复核文档 + 登记册）
```

> 本批**没有**跑 `m4.5:ci` 与 Live Smoke —— 本批零 `src/**` 改动（AGENTS §5 的触发表里没有这两道），
> 且用户的要求是"不影响 M8.5 建设"；需要完整发布档时按 §9.1 的 release 档另跑。

### 8.3 第三批续（2026-09-27）：`m6.1:gates` 转绿读数

```text
pnpm m6.1:test                          313 通过 / 0 失败（重跑后 artifacts/m6.1/component.json **逐字节不变**）
pnpm m6.1:measurement:verify            16 通过 / 0 失败 · verdict=PASS
                                        ⚠️ 重跑会改写已入库的 artifacts/m6.1/measurement.json（只差 startedAt/finishedAt）
pnpm m6.1:wp1:verify                    verdict = **FROZEN** · 问题 0 条
                                        语料 68 条（dev 20 / calibration 20 / heldout 28）· G1 回归 3 条具名 / 5 个轮次
                                        runId m6.1-wp1-20260927-9864a0e6206f-330d
pnpm m6.1:wp0:baseline（新 run）         verdict = BASELINE CAPTURED · unknown=0 · otherTask=2
                                        sourceTree unchanged/unexpected=0 · 真实库 stability=unchanged
                                        runId m6.1-wp0-20260927-9864a0e6206f-cc35 · head=9864a0e6206f
pnpm m6.1:gates --manifest <wp0> --manifest <wp1> --write
                                        必选门 4 · 未运行 0 · 未通过 0 · **overall = PASS**（EXIT 0）
                                        component ✅313/0 · measurement ✅16/0 · wp0 ✅ BASELINE CAPTURED · wp1 ✅ FROZEN
                                        汇总 artifacts/m6.1/m6.1-wp0-20260927-9864a0e6206f-cc35/gate-results.json
反篡改自证                              重跑 m6.1:test 后 component.json 无变化 ⇒ 聚合器重判仍 PASS（哈希校验重跑）
提交：9864a0e（wp0 注释更正）· 1227f72（本次证据）· 本批（登记册 / AGENTS.md）
```

---

## 0j. 第十批（2026-10-01）：M11 生产激活**当晚的真实对话观察** —— 一条**行为**发现

### R-26 · 她反复提同一件事：**上下文自我强化锚**（不是记忆 / 摘要 / 目标的缺陷）

- **怎么发现的**：用户 2026-10-01 在**真实对话**里报「聊了几轮，发现它总是会重复
  『明天十点二十五，楼下。伞和外套。』」——这是 M11 激活后的第一段真实使用。
- **读数**（`pnpm diagnose:repeat` = `scripts/diagnose-repeat-reply.ts`；真实库 · SELECT-only 构造闸 ·
  INC-01 全程租约 → pre-open 已验证快照 → token → 干净关闭 · `cleanClose=true`）：
  ```text
  · 那句话在对话里出现 **21 次**：**她 20 次 / 用户 1 次**；从 #69(c46) 到 #151(c92) **几乎每轮都提**
  · 每轮注入的 section 固定 10 个，其中含 **`recent-conversation`**（最近若干轮的**原文**）
  · `selected_memory_ids = []` —— **没有任何记忆被选中**；记忆表里 0 条命中
    （该角色只有 1 条 active + 1 条 retracted）
  · **任何投影都不含那句话**（现有投影类型只有 diagnostic-counter / affect / belief×2 / relationship；
    **没有 `goal:`** ⇒ 这段对话里目标/承诺域从未被用过）
  · `rolling-summary` 出现在 section 列表里，但 `createRollupSummaryProvider` **只被一个验证脚本用过、
    没有接进 `src/main.ts`** ⇒ 它不可能是来源
  · M11 本域：水位 141 · 反思事件 **0** · 无反思任务 ⇒ **与 M11 激活无关**
  · 人设（`src/character/苏沐薇.ts`）、Seed 与 prompt 基线里**都没有**这句话 ⇒ 排除"照抄模板"
  ```
- **根因（机制）**：**自我强化的上下文锚**。她在 #69 主动定下这个约定（"明天十点二十五那节，
  你提前十分钟到楼下等我"）；此后每一轮 `recent-conversation` 都把她前几轮的原文喂回去
  （她的提及密度 = **20/46 轮**，任意 16 轮窗口里几乎必然含有），于是"**她看到自己刚说过 ⇒ 继续说**"。
  措辞也被逐字抄稳（"伞和外套"来自 #108 她自己那次成功的天气结论）。
  **并且没有任何程序侧状态能把它结清**：这段对话里没有 goal/commitment 记录
  ⇒ "这件事还没办"在她那儿永远是**未决项**。
- **边界（不主张）**：这不是"记忆坏了"、不是"摘要污染"、也**不是** M11 引入的；
  同时**不**主张"她一定会停"——未测。
- **候选修法**（三条，各有代价，**未执行**）：
  ```text
  ① 产品侧：把这类约定记成 M10 的**目标/承诺**（带可核对判据、可结清）
     ⇒ 她就有程序侧状态可以"结掉"，不必靠反复提醒（M10 已有能力，这段对话里没用上）
  ② 上下文侧：`recent-conversation` 对"同一件事的重复提及"做去重 / 衰减
     ⇒ prompt 层改动，要走 `pnpm m3.5:test`（prompt 逐字节）+ **有意**重刷基线
  ③ 人设侧：执着的程度是 Seed 内容 ⇒ 改内容要升 `SEED_VERSION` + provenance
  ```
- **立刻可做的判别实验**：**明确结清一次**（"十点二十五我会到，不用再提醒"），看下 2–3 轮是否收敛
  ⇒ 能区分"她执着（人设）"与"回路不可打断（上下文机制）"。读数会如实记录，不回写。
- **登记 ≠ 关闭**：本条是**行为**发现，触发条件是"用户希望她别反复提同一件事"。

#### R-26 追加（同日，**用户做了判别实验**）：**明确结清也拦不住** ⇒ 机制确认

- **实验**：用户按建议明确结清一次。读数（**副本模式** `--copy`：真实库租约被聊天进程持有 ⇒
  诊断改读 %TEMP% 副本，**不打扰在跑的会话**）：
  ```text
  #154 用户：「好的明天10点25我绝对会到不用提醒了」          ← 结清
  #155 她  ：「十点二十五，楼下。伞和外套。这回你倒记得清了。…不用我提醒。行。那我就不多说了。睡吧」
              ⇒ **仍然重复了一次**（随后口头答应不再提）
  #158 用户：「没事反正放假嘛,晚点睡反正明天也没课」
  #159 她  ：「没课。放假。这两条都成立。**那今天十点二十五，楼下，还算不算数。**…到点我就在楼下。」
              ⇒ **又提了一次**（这次是**追问**而非逐字复述；且她把"明天"正确改成了"今天"）
  出现总数 21 → **23**（**她 22 / 用户 1**）
  ```
- **机制确认**：`recent-conversation` 注入的是**最近 16 条事件**（= 8 个来回；`sections.ts` 的
  `limit ?? 16`），而她的提及密度是 **22/48 轮** ⇒ **任意窗口里都有 2–4 句她的提及**；
  一句结清压不过这个"证据量"。**更关键的是程序侧什么都没变**：
  ```text
  · 那句话**不在记忆里**（记忆表 0 命中）—— 约定不是"用户事实"，从来不是记忆候选
  · **不在目标/承诺里**（无 `goal:` 投影）—— 它没有任何"已结清 / 已兑现"的终态
  ⇒ 它**只以散文形式活在窗口里**：在窗口里 ⇒ 她就一直提；出了窗口 ⇒ 她会**彻底忘**
     （两半是同一个根因：**约定没有程序侧归宿**）
  ```
- **由此收紧两条主张**：① 这不是"人设执着"单独造成的（她**口头答应停**之后又提 ⇒ 机制 > 人设）；
  ② 反过来说，她的"我记着"目前**并不等于**持久记住——只是窗口里还在。
- **修法优先级（更新）**：
  ```text
  ① 正解（追加式、不改历史）：把这类约定变成 **M10 目标/承诺**（带可核对判据）
     ⇒ 有终态、有事实块；"反复提醒"变成"可结清的一条"。
     两条路：她**主动提议**目标（M10 已有能力，用户点头即可）／新桥"约定→目标提案"（新能力，里程碑级，需 ADR）
  ② 窗口层去重/衰减：⚠️ **不建议**朴素形式——窗口是她的**逐字历史**，改写它等于让她
     记错自己说过什么（真实性）。要做也得用户**明确裁定**，并走 prompt 逐字节 + 有意重刷基线
  ③ 人设层降执着：改 Seed 要升 `SEED_VERSION` + provenance（本次实验已表明它**不是**主因）
  ④ **零代码、可当场验证**：请她把这件事**记成承诺**（"记成承诺，判据是我到楼下"），
     看她是否从"反复提醒"转成"一条可结清的状态" ⇒ 当场验证 ① 是否成立
  ```

---

## 0k. 第十一批（2026-10-02）：M11.1计划编制与技术债状态核对

### R-28 · 旧状态与当前实现分列；生产接线疑点立案

- **授权与范围**：用户要求「给我一份M11.1计划执行书，同时核对技术债，和其他未决定的事情」。本批完成文档与只读核对，**没有实施代码修复、模型调用、真实库读写或开关变更**。
- **核对快照**：`1ae86c47`；M11核心源码核对基线`015b0c28`，其后新接收M10.1 WP0/1设计/输入交接及双方角色(b)裁定前后读数。新计划的实施状态为`NOT STARTED`，不把文档编制当成里程碑完成。
- **交付载体**：[M11.1执行计划](m11.1/M11.1-Execution-Plan.md) · [技术债与历史未决项核对](m11.1/M11.1-Debt-and-Decision-Audit.md) · [待裁定事项](m11.1/M11.1-Unresolved-Decisions.md)。以下为当前修订读法，原历史行和证据不回写。

| 项 | 当前修订读法 | 仍需什么 |
|---|---|---|
| M11状态 | 人审PASS、生产ACTIVATED已在案；行为增益NOT OBSERVED、短门FAIL、长门dialogueRequests=0 | 源链/入模/真实回复分列的新验收与自然首用读回 |
| M11语义门 | 脚本格式平均≥.90、风险recall≥.90与契约格式≥.95、风险recall≥.95/最差轮要求存在差异 | M111-F07：独立金标、契约对齐、新版本新run；不改写旧PASS标签 |
| M11生产接线 | 前3个handle作roots、会话数固定2、缺读数默认usable、adaptiveEnabled固定true、format_invalid正常返回可能推进水位、fence未见生产消费 | M111-F01…F06：先隔离复现，再修复；没有复现前不写生产事故或销账 |
| M11材料归属 | 列表长度slice与累计revision、模板根数/会话数可能造成当案证据失配 | M111-F08：当案身份集合、真实根图、独立库/明确前置，旧材料保留，新v3另出 |
| TD-22 | 写侧/渲染器/增量入口已实现，生产published/indexed=1和on已记录；cursor读回与换代事务已有代码 | 当前生产v2列读回、真实跨进程恢复、自然查询轮级证据及效益仍分项开放 |
| D5 | ADR-083已EXECUTED：强度契约、3字片段、权重1.5 | 不重开扫描；保留同源、A3同强度与改述召回守卫 |
| M4 D2-A / L-M97-02/03 | 取值已修3条，仍剩2条；问句风险收窄未关闭，WP4已证实显式路径可落库 | 原表“今天够不到生产”及“5条全未修”不作为当前读法；问句守卫/两条取值分别走冻结语义程序 |
| TD-08 / L-M61-04/05 | M9.5已部分覆盖候选与长程问题 | 按off/shadow/on分列，不称所有路径已修或无人接手 |
| M9.1 R-20/R-21 | 两项已有正式关闭及激活依据 | 不重新立项旧缺陷；M11新来源旁路单独验证 |
| M10.1 / L-M11-10 / §0j-R26 | ADR-086已冻结，WP0/1已交付；双方角色已获(b)裁定/实施且保留前后读数；约定桥与goalTokens接线归M10.1 | 后续实现与效果未收口；U01不再开放，语义负例量具/生产/联调另交付 |

**接收纪律**：每项仍按`旧ID → 正式问题 → WP → 前置 → 新证据 → 状态 → runId → 剩余限制`。本批新修复`runId=NONE`；“核对完成”不等于技术债关闭。M11.1主线新增外部能力**NONE**，TD-19/20/21继续留在相应Lv2能力入口。

**编号勘误**：§0i/R-26是误删本地资产，§0j/R-26是重复锚，已有两项重号。引用时带章节/标题；本批不改历史编号和证据，新项使用未占用R-28。



## M11.1 实施修订（2026-10-02，继续执行中）

用户随后以 `/goal` 授权按计划实施，并明确批准D-02的160×3语义、90×3×2行为及C对A/B各≥10pp标准。权威接线补充ADR-087；完整进度见 `docs/m11.1/M11.1-Execution-Progress.md`。本修订不覆盖§0k计划编制时的NOT STARTED或旧M11失败档。

F01/F03/F04接线修复与合法来源控制已通过；F02当前持久来源、归因、Memory revision/冲突读数已补，完整跨域矩阵仍未关闭；F05/F06新恢复与进程控制通过。证据：wiring `e9ffd8c2a41c-d921` 21/21，recovery `6a978af2633a-fbd5` 8/8，e2e `6a978af2633a-8d5f` 6/6（均位于artifacts/m11.1）。F07新评分器与F08身份消费控制为 `e9ffd8c2a41c-c478` 18/18；正式语义、行为及v3真人评审还未执行，不凭量具控制关闭行为债。完整离线链EXIT0，聚合读取旧G14 FAIL，整体Hard Gates仍NOT PASS；真实回归待新run。

真实库/生产配置/cutover本轮未动，能力追加NONE。M10.1 WP4尚未接收，G11 NOT RUN；语料独立审阅、真人严重争议、自然首用与生产更新候选均保留原授权/裁定边界。没有标签、合并或整阶段PASS。

### M11.1 同日联调与来源追加（旧读数不回写）

M10.1 WP4c/WP5已接收。M111-G11联调`artifacts/m11.1/m11-m111-joint-20261002-6f582783f5a2-4c8e/`为17/18 **FAIL**：普通Goal理解链解析约定桥草案时报`unknown_field`，`GOAL_DRAFT_FIELD_ALLOWLIST`未列`commitment`。直映射原生提案、约定结清、目标变更、三预算八组合与实际packet通过。字段接纳与生产约定worker/A12归M10.1实施方，本会话未改其实现；独立水位/同轮仲裁与200真实长链未证明，因此L-M11-10/§0j-R26仍开放。

M111-F02派生来源有效正例下6/17 FAIL（`a77266ba092f-f278`），修复读侧消费既有M5/M9资格函数并复核节点revision后17/17（`703df81e8886-76e6`），**PARTIAL**；完整生产生命周期矩阵仍开放。正式语义480案FAIL保留，prompt@4开发探针仍FAIL；用户明确选择先完成工程与联调，不追加480次。36卡真实回复人审直接声明PASS（`a7de08bdc76c-d65c`），完整540评分/增益、目标槽180与200轮长链仍未交付。自然首用NOT OBSERVED，生产配置/cutover/真实库未动，新增能力NONE。

---

## 0l. 第十二批（2026-10-02）：M10.1 生产激活 + 装配三跳接线

### R-29 · 约定桥的**配置层**已激活、"她提出"那条路已接线；**字段接纳缺口**经本会话独立复现后登记

- **授权**：用户 2026-10-02 逐字「生产激活」（并裁定范围 `A` = 两个额度一起开、取值 `goal 300 / commitment 300`）与
  「接 L-M10.1-05 三跳（」。
- **生产激活（配置层，已执行）**：`C:\Users\user\Desktop\project LG\.env` **只追加三行** ——
  `CHARACTER_GOAL_TOKENS=300`（销账 `L-M11-10` 的**接线缺口**）· `CHARACTER_COMMITMENT_TOKENS=300`
  （**代码缺省仍是 0**）。前 `FBCB4062…D836` / 2617 B / 15 个 `CHARACTER_*` ⇒ 后 `7C5718E8…C141F6` / 2777 B / 17 个。
  **真实库本轮连租约都不需要**（这两个额度没有要预置的状态 ⇒ 激活程序**零开库**，有自检）。
  载体 [`M10.1-Activation-Record.md`](m10.1/M10.1-Activation-Record.md)：`activate` 9/9 · `activation:readback` 13/13 ×3
  （含**生产树**里那次）· 值冲突 `exit 2` 不写 · 域开关 off / 无额度读回 ⇒ 如实红 · 幂等重跑追加 0 行且 sha 不变。
  **FIRST-USE = NOT OBSERVED**（不凭配置宣布）。
- **装配三跳（`L-M10.1-05`，已接线）**：网关取"她上一条**未被遮蔽**的回复" → 编排作 `proposalEvidence` → 装配层原样转发。
  新门 `m10.1:assembly:verify` = **19/19**（真网关 + 真编排 + 真写库，从账本读回 `sourceRefs`；负控：遮蔽 / 没有她的行 /
  D19 压制 / 不给证据 / id 不相符 ⇒ 都不给或仍被拒；恢复档 ⇒ 又接受）。M10 八道 + M11 两道 **逐项不变**（逐条 id+判定比对）。
  载体 [`M10.1-WP6b-Handoff.md`](m10.1/M10.1-WP6b-Handoff.md) · [`ADR-086`](adr/ADR-086-m10.1-agreement-bridge.md) **§0.8**。
- ⚠️ **本会话独立复现的字段接纳缺口**（与 §`M11.1 同日联调` 的 M111-G11 同一件事）：
  ```text
  `GOAL_DRAFT_FIELD_ALLOWLIST`（src/kernel/contracts/goal-proposal.ts:270-298）**没有 `commitment`**
  ⇒ `validateGoalProposalDraft` 的**闭集检查**（同文件 :414-418）对任何带 `commitment` 的模型草案
     直接判 `unknown_field` ⇒ **模型侧的"她提出并接受一条承诺"在契约层无法表达**
     （`goal-proposal.ts:222-229` 却把这个字段写成"那条断链的**唯一**接入点"）。
  为什么现有门没红：M10.1 的各门用 `buildAgreementProposal` 造草案后**直接**调 `draftToProgramProposal`
     ⇒ **绕过了** `validateGoalProposalDraft`；`m10.1:assembly:verify` 的 B0 只验"不带 `commitment` 的草案合法"。
  ⇒ 这是 **M10.1 自己的 WP2 漏项**（契约自不自洽的老形状：可携带字段表与类型定义不同步，
     同 `goal-proposal.ts:277-288` 记的 `statement` 事故、§`0.3` 记的 `span` 事故同族）。
  状态：**已登记 → 同日经用户裁定「现在修」并已修**（见本节末条；上面这段是**发现当时**的读数，不回写）。
     修法：闭集表 += `commitment: ['create']` + `FIELD_NOTES` 补一句 + 草案级字段校验 + 门的正/负控读数，
     并跑 `m10:semantic:dry` 的 C1「提示词与契约同步」。
  ```
- **本批新增限制**：
  ```text
  L-M10.1-06 `proposalSpan`（坐标，校验在**本轮原话**上）与提议侧**指纹**（算自**她那条回复**）不是同一份文本
             ⇒ 那条引用的"坐标在采纳侧、指纹在提议侧"；两样都不参与判据（指纹无人重算）⇒ 目前只是**来源账**。
  L-M10.1-07 M10.1 **没有独立的量具验证 lane**（`m10.1:measurement:verify`）：三段式目前**内联**在各门里，
             "这些检测器是不是都会响"没有一处集中回答 ⇒ WP8 的活。
  L-M10.1-08 `m10.1:assembly:verify` **不走真模型**：它判装配与判据，不判"她的提议质量"。
  L-M10.1-09 **快路径有了承诺的生产者**：`D02` 把约定**识别**定在**慢路径**，而字段接纳之后
             **每轮一次**的目标理解链也能产承诺 ⇒ 模型可能**过早**把闲聊当承诺。现有闸：提示词写明门槛
             （明确接受才算）· 判据闭集只有"由对方报告确认"一档 · 承诺有终态（可结清/取消）·
             事实块让双方都能看见它。**行为级读数（`A11`）仍未做** ⇒ 不当成已解决。
  L-M10.1-10 `commitment.scope` 是**模型撰写的散文**（≤300 码点）且**入账**（与 `statement` 同地位）；
             而"证据"（span / 指纹 / conversationEventId）**仍全部来自程序**。⇒ `m10:source:verify` 的
             `F2`（"草案不携带任何文本"）判据本身仍成立（它量字段名闭集），但字面要按"只有**证据**文本
             不许携带"读 —— 别外推成"草案里没有任何模型写的字"。
  ```
- ✅ **同日裁定并已修**（用户 2026-10-02 逐字「现在修（推荐）」）：
  ```text
  ① 闭集表 += `commitment: ['create']`；② **模型面内层闭集** `{scope, criterion}`（`acceptanceEventIds`
     是程序事实 ⇒ 模型写即 `unknown_field`）· ③ **模型面判据闭集** `['user_report']`（真子集；
     `action_result` 要程序能力名、`conversation_output` 要可核对结构 ⇒ 仍走程序侧构造器；
     ⚠️ 放行口的 `COMMITMENT_ACCEPTABLE_CRITERIA`（`U-03-a`）**一个字没改**）·
     ④ 映射层回落 `acceptanceRefs = [sourceRef]`（本轮那条用户事件，带真 span/真指纹）·
     `GoalCommitmentDraft.acceptanceEventIds` 改**可选** · ⑤ 新原因 `commitment_draft_invalid`
     + 提示词补一行**门槛**（明确接受才算）。
  读数（判据变更纪律：旧读数不回写、计数如实上调）：
     `m10:source:verify` 43/43 → **45/45**（+C15 形状非法 · +C16 内层写 id；C13 的"N 条原因"12→13）
     `m10.1:policy:verify` 10/10 → **14/14**（+P10 模型形状被接受 · +P11 走通整条链 ·
       +P12 模型面负控×4 · +P13 程序面仍是 2 条）
     `m10:semantic:dry` 15/15 · 其余 m10/m11/m10.1 **逐条 id+判定相同** · typecheck/m3.5/m4/m4.5/m5 ✅
  ⚠️ 修的**不是**判据的松紧：放行口闭集没动，只是把"模型能不能**表达**"补上；模型面比程序面**更窄**。
  载体 [`ADR-086`](adr/ADR-086-m10.1-agreement-bridge.md) **§0.9**。
  ```
- **仍未做（不因本批关闭）**：WP6 长链/真实链 · WP7 人审 · WP8 收口（含 `m10.1:gates` / `measurement`）·
  `A9` 生产副本 trace 读数 · `A11` 行为级对照 · `U-04`（截止时间的生产来源）。`L-M11-10` 仍**部分销账**。

### R-30 · `COMMITMENT_FULFILLED` **没有生产者** ⇒ 结清不可达（M10.1 的 WP6 长链门当场抓到）

- **授权**：用户 2026-10-02 逐字「继续进行直到 WP6/WP7/WP8 收口」。
- **怎么发现的**：离线长链门 `m10.1:long:verify` 的 W3 **第一次跑就红** —— `GOAL_COMPLETED = 1`
  而 `COMMITMENT_FULFILLED = 0`。逐层查证：该事件在 `src/**` 里**没有任何生产者**
  （`goal-validator.ts` 只为**收到**的承诺事件做结构校验；`understanding.ts` 的 `report_complete` 只产
  `GOAL_COMPLETED`；投影有折叠分支；而 `goal.ts`/`goal-store.ts` **明确禁止**拿 `GOAL_COMPLETED` 推算它）。
- **后果**：**结清不可达** ⇒ `D08`（已结清 ⇒ 不要再提）只剩"到期"一档，而到期**没有生产来源**（`U-04`）
  ⇒ 本里程碑的核心修法**落不了地**。（与 `L-M10.1-04`、`R-29` 同一家族：契约齐、放行口齐、**生产者缺**。）
- **已修**：`report_complete` 时按端口给的承诺摘要**同提案**补 `COMMITMENT_FULFILLED`
  （窄规则：**同档** `user_report` + 非终态 + **可见**目标；缺摘要 ⇒ 不补 —— 失败关闭）。
- **读数**：`m10.1:policy:verify` 14/14 → **16/16**（+P14 正控 · +P15 负控×3）·
  `m10.1:long:verify` 200 轮 **10/10** · 500 轮 **10/10**（W3 由红转绿）。
  载体 [`ADR-086`](adr/ADR-086-m10.1-agreement-bridge.md) **§0.10** · `L-M10.1-11/12`。

### R-31 · ⚠️ **把"已结清"摆在她面前，并不减少她再提**（`A11` 实测；与 `R-26` 同族）—— **已按原计划修**

- **授权**：用户 2026-10-02 逐字「1，2，3全做」（第 2 件 = `A11`）；随后逐字「L-M10.1-15按照原计划修」。
- **读数（旧形态）**（真模型 · 测试端点 · 20 次调用 · 同一批"结清之后"的 10 轮）：宽松词形 `档 A = 2/10 · 档 B = 1/10`
  （首跑 `1/10` vs `1/10`）· 严格判据 `档 A = 2/10 · 档 B = 0/10` ⇒ **未观测到下降，方向上相反**。
- **逐字证据**：档 A 第 6 轮「……明天早上咱们原计划楼下见，要不要一起改行程？」，第 7 轮
  「……明早十点二十五楼下见，记得带伞和外套。」；档 B 那 10 轮**从未**提。
- **归因**：`D08` 的**机制**主张成立（结清可被程序明确陈述）；**行为**主张**不成立** ——
  **把那条事实放进她的上下文，本身就是一种"再启动"锚**（与 [`R-26`](#r-26--她反复提同一件事上下文自我强化锚不是记忆--摘要--目标的缺陷) 同族）。
- ✅ **已修（同日，用户逐字「L-M10.1-15按照原计划修」）**：**换注入形态** —— 终态档改成**计数式陈述、不复述内容**
  （`- 有 1 条约定已结清（内容从略），不要再提。`；新常量 `COMMITMENT_CLOSED_CONTENT_OMITTED`；
  未结清行照常复述内容；`sourceRefs` 仍逐条留）。判据随之反向（`context:verify` 的 `C1` 从"含 scope"改成"**不含** scope"）；
  长链门 `W4` 增判"块里也不复述原话"。
- **复测读数**（同一批 10 轮 · 同一条判据 · 真模型 20 次调用）：**宽松 `A=0/10 · B=0/10` · 严格 `A=0/10 · B=0/10`**
  ⇒ **再启动的通道被关掉**（与"没有块"同档）。**旧读数保留不回写**（它记录的是"复述内容会再启动"）。
- 代价面：`L-M10.1-17`（她看不到"是哪一条"）· 量具弱点照旧 `L-M10.1-16`。
- 载体 [`ADR-086`](adr/ADR-086-m10.1-agreement-bridge.md) **§0.12** · `M10.1-Gate-Decision.md` **§3.5**。

### R-33 · ⚠️ **快路径在真模型上反复未观测到"把约定记成承诺"**（200 轮长链读数）

- **授权**：用户 2026-10-02 逐字「m10.1:long:live200轮够了」。
- **新门** `m10.1:long:live --turns 200`：与离线长链同一条轨迹（约定在第 2 轮、结清在第 4 轮），
  但**每轮真的交给模型**（**200 次调用**）。判据 **11/11 PASS**（闭集外结论 0 · 传输失败 0 · 输出不合法 0 ·
  零越界 ✅ · 重建逐字段相同 ✅ · 额度 0 ⇒ 0 section ✅）；识别相关判据在 live 档**降级为读数**。
- **读数**：`no_operation 198 · accepted 2`；账本 `GOAL_CREATED=1` · `GOAL_COMPLETED=1` ·
  **`COMMITMENT_ACCEPTED=0`** ⇒ **承诺行=0** ⇒ 块形态与结清路径**不可判**（如实标注，不是 PASS）。
- **连起来读**：快路径（每轮一次的目标理解）在真模型上**反复**没记下约定（短链识别 **0/2** · 200 轮 **0 承诺**），
  而 **WP2b 的专用慢路径**（带窗口那条）在同一材料上 **`written`** ⇒ 与 `L-M10.1-09/11` 同一结论：
  **约定识别靠的是那条慢路径，不是快路径的顺带产物。**
- ⚠️ 该门判据修正两次（**三次实跑，前两次 FAIL 档都留在库里**）：空集上的"零越界"记**不可判**；
  `transport_failed` 是**闭集内结论**（读数）而不是"链崩了"；"有写入"≠"有承诺行"。
  载体 [`ADR-086`](adr/ADR-086-m10.1-agreement-bridge.md) **§0.13**。

### R-32 · `D02` 的慢路径约定识别**没有运行时消费者**（`L-M10.1-11`；已修）

- `src/kernel/app/agreement/{inputs,proposal}.ts` 在 `src/**` 里**只有门在用** ⇒ `D03`/`D04` 的门槛、
  50 行有界窗口、12 条具名拒绝**在生产里都不生效**；生产里唯一能记下承诺的是快路径。
- **已修（WP2b）**：新门 `m10.1:agreement:verify` **18/18**（有界窗口 + **一次**模型调用 + 两道闸 +
  M10 的放行口与写路径；一次性 cutover · 失败不前进水位但如实落 `failed` · 结论 ≠ 失败 · 同窗幂等 ·
  晚写闸门；开关 `CHARACTER_AGREEMENT_ENABLED` **代码缺省 off** 且被 `main.ts` 真的消费）。
- 新登记边界：`L-M10.1-13`（窗口按**角色**读、不按房间）· `L-M10.1-14`（v1 只代表 `user_report`）。
  载体 [`M10.1-WP2b-Handoff.md`](m10.1/M10.1-WP2b-Handoff.md) · [`ADR-086`](adr/ADR-086-m10.1-agreement-bridge.md) **§0.11**。

---

## 0m. 第十三批（2026-10-02）：Lv2 WP0 只读盘点 —— **三条"选档口径"读数**

> 出身：Lv2 综合验收的 WP0 基线（[`Lv2-WP0-Baseline.md`](lv2/Lv2-WP0-Baseline.md) §4.1–§4.3）。
> 运行：`pnpm lv2:baseline`（EXIT 0 · 模型请求 0 · 真实库未打开），
> 证据 `artifacts/lv2/lv2-wp0-20261002-b230868b1b1d-12b0/`（21 份聚合门 stdout 原文 + 17 份被刷新汇总的副本）。
> **本批只登记读数，不改任何门的实现、不改写任何历史判定。** 三条都属于同一族：
> **「聚合器选了哪一份档」决定了它报什么** —— 而这三处的选档依据都不是"正式结束时间/身份"。

### R-34 · `m10.1:gates` 的"最新档"按**目录 mtime** 选 ⇒ 更早的 FAIL 盖住更晚的 PASS

- **机制**：`scripts/m10.1-gates.ts` §68–§77 用 `statSync(dir).mtimeMs` 排序取 `.at(-1)`；
  与 `m11-manifest@1` 里**没有** `started/ended` 一起，构成"无法按时间选"的现实。
- **实测**：`artifacts/m10.1/` 下同一道门 `m11-m10-1-wp6-long-live-200-*` 有**四份**档，
  四份目录 **mtime 完全相同**（2026-10-02 16:29:08）⇒ 并列落到目录名（= head 段）字典序最后：
  `cf6d314c6c81`（**FAIL**）。而按 head 的**提交先后**，更新的两份是 `4275b94de8ad` 与 `3152080dfa37`
  （**都是 PASS**；`3152080dfa37` 是 HEAD 之前最近的一次）。
- **后果**：`m10.1:gates` 报 `overall = NOT PASS`（未通过 1 = 这道门 `10/11`），
  而聚合器**自己的抬头**写着「同一道门更晚的 PASS 取代更早的 FAIL；本门按'最新一份'取，
  因此这条规则是**自动**满足的」——mtime 并列时**这句话不成立**。
- **登记为 `TD-23`**（见 §1）。**边界**：这不是"当前失败"，也**不**抹掉那份 FAIL 档；
  它是**选档口径缺陷**——原 FAIL 档照留，读数按 TD-16 不回写。

### R-35 · `m5.5.1:gates` 的语义门把 **TD-11 的小样本诊断档**当成"最新观测"

- **机制**：`scripts/m5.5.1-gates.ts` §58–§70 取 `wp7/**/observations.json` 里 **mtime 最新**的一份。
- **实测**：`wp7/td11-e12-r1|r2|r3` 三份的 mtime **同秒**（2026-09-27 14:20:34），
  亚秒差异决定它挑到 **`r2`**：`verdict = DIAGNOSTIC ONLY`（21 次调用）· `semantics.ok = false`
  （`overSearch 2/14 = 14.29%`；`recallExplicit 4/4` · `recallAutoPublic 5/5` 全过）。
- **两件事必须同时说**（不许只挑一边）：
  ① M5.5.1 **收口的正式语义批次**是 `wp7/step4-full-v2-prod`（2026-09-22 PASS；最差轮 explicit 11/11 ·
  auto 18/20 · 过度搜索 1.6%）——**它没有被取代**；
  ② 但 `overSearch 2/14` 与收口的 `1.6%` **不是同一个规模**，因此**不能**用"那是诊断档"一句话结案。
- **边界**：诊断档的 `DIAGNOSTIC ONLY / exit 1` 是**设计判决**（
  [`M5.5.1-TD-11-Review.md`](m5.5.1/M5.5.1-TD-11-Review.md) §163 逐字）。谁该被聚合器当成"语义门最新档"，
  属 **Lv2 WP1 的冻结项**；本批不改聚合器。

### R-36 · `m4.5:gates` 的 G14 量的是 **2026-09-30 的失败档**；最新真实读数在 M11.1 的归档里

- **实测**：`m4.5:gates` 当前报 `G14 FAIL 26/18`（证据路径固定 = `artifacts/m4.5/smoke/smoke-result.json`，
  内容 `status = FAIL`，由 `6a6367a8` 于 2026-09-30 **刻意记录**：`docs(m10): record the live tier failure
  and the aggregate reading that hid it`）。同时该聚合器**在 G14=FAIL 时仍 `exit 0`**。
- **最新的真实读数**：M11.1 的完整真实回归（2026-10-02，head `0b0bcdca`）在同一位置得 **52/0 PASS**，
  归档 `artifacts/m11.1/m111-full-live-regression-0b0bcdca/artifacts/m4.5/gate-results.json`
  （该档案 `G14 = PASS · passed 52 · failed 0`），按"历史平面证据逐字恢复"纪律**未回写** `artifacts/m4.5/`。
- **后果**：`m5.1:gates` 的 `Hard Gates = FAIL` 是这条 G14 的**传递**（同一根因，不是第二个缺陷）；
  两份读数**各自有效、互不覆盖**。⇒ **Lv2 的 `LV2-G7` 必须在 Lv2 候选上重出 Live Smoke**，
  不继承任何一份（计划 §7「不重复消耗有效证据」的边界同样适用：可接收"覆盖范围"，不可继承"结论"）。
- **边界**：不修聚合器的退出码、不回写历史证据（TD-16）。

---

## 0n. 第十四批（2026-10-02）：Lv2 短场景运行器 —— **一次"控制档仍然出网"的事故**

> 出身：Lv2 的逐案隔离运行器（`scripts/lv2-short-live.ts` + `scripts/lv2-harness.ts`，`pnpm lv2:short:live`）。
> **本批只有一条**，但它是一条**纪律级**的事故，值得逐字登记。

### R-37 · "控制档"只关掉了最外层那一次调用 ⇒ **preflight 不是零调用**

- **现象**：preflight（`--preflight`，设计上"0 次模型请求，只验管线"）**真的出了网**。
- **根因**：运行器只在**回复**那一层分控制/真实（`control ? 占位串 : callModelText(...)`），
  而**目标理解端口**（`runGoalTurn` → `createOpenAiGoalUnderstandingProvider()`）在两档里**都是真 provider**。
  ⇒ 每一轮仍有 1 次真实的目标理解调用。
  ⚠️ 又因为 preflight **不要求** `DSH_TEST_MODEL_WRAPPER=1`，
  那些调用按 `.env` 走 —— 这正是 `.env.test` + `with-test-model` 两条失败关闭要防的
  "**以为在跑测试、其实在烧生产 key**"（`AGENTS.md` §8.1）。
- **实测规模**：三次 preflight 累计 **≈189 次**未经 wrapper 的出站调用
  （3 案档 ≈3 · 72 案档 25 个 SETUP_INVALID ⇒ ≈47 · 72 案档 5 个 ⇒ ≈67 · 72 案档 0 个 ⇒ ≈72；
  按"每轮一次目标理解调用"估算，**内部重试无法精确重建**）。
  另有一条**旁证**：修好前后同是控制档，判据案通过数 43 → 39 ——
  差异正是"真模型真的写下了目标"造成的（即那些调用确实生效过）。
- **影响边界（如实）**：
  · **真实库没有被碰**：每一次 preflight 都走 `isolateDatabase()` + 逐案独立库（`realDb.opened=false`）；
  · **不是数据污染**，而是**凭证/成本**层面的一次越界（测试调用落在生产端点/凭证上）；
  · 那几次的 `manifest.requests` 记的是 `planned=0 / actual=0` —— **记账是错的**，
    本批以"≈189 次"更正（证据档里的 `requests` 字段**不回写**，按 TD-16 三列纪律另记）。
- **修法**（`7452d2f4`）：`createLv2CaseEnvironment({ control })` —— 控制档**整条链**都用脚本化 provider
  （目标理解端口返回闭集内的 `none` 草案，不写任何事件），并加断言"控制档不许有真 provider"。
- **教训（写成纪律）**：
  ```text
  "控制档 / 干跑 / 只读档"必须覆盖**整条链**，而不是最外层那一次调用 ——
  一处漏掉 = 出网 + 可能用错凭证，而它**看起来**仍然是"0 次调用"。
  ⇒ 新运行器落地时必须有一条**机器判据**回答："这个档位里还有没有别的真 provider？"
     （本次的答案是：把 provider 的选择收进**一个**工厂函数，按档位一次性决定。）
  ```
- **载体**：`scripts/lv2-harness.ts` 的 `createLv2CaseEnvironment` 注释（就地记下事故）·
  真零调用档的证据 `artifacts/lv2/lv2-wp4-preflight-20261002-7452d2f4fecb-3a76/`。

---

## 0o. 第十五批（2026-10-02）：Lv2 WP5 重启 lane —— **一次"隔离库"实际写到了真实库的事故**

### R-38 · 只设 `PROJECT_LG_SANDBOX` 而不设 `PGLITE_DATA_DIR` ⇒ 中央闸放行、PGlite 落到真实库

```text
现象（2026-10-02 21:38 本机）：
  `data/pglite` 出现 **21:38:15–21:38:16** 的写入（base/1/* · pg_wal/000000010000000000000014）
  —— 正是 Lv2 WP5 重启 lane 第二段进程的运行窗口（seg1 目录建于 21:37:38）

机制（两条合起来才是事故）：
  ① `src/dev/sandbox.ts:81-100` 的 `isolateDatabase()` 设**两个**变量：
       · `PGLITE_DATA_DIR = dir`   ← **PGlite 真正打开哪个目录**（`src/db/index.ts:209/291`）
       · `PROJECT_LG_SANDBOX = dir` ← **中央闸判"是否隔离"的标志**（`src/db/index.ts:213`）
  ② 重启编排器第一版**只**给第二段进程传了 `PROJECT_LG_SANDBOX`
     ⇒ 闸读到 `isolated = true` ⇒ **放行**
     ⇒ 而 `PGLITE_DATA_DIR` 未设 ⇒ PGlite 用缺省 `./data/pglite`（`src/db/index.ts:271` 逐字）
     ⇒ **第二段进程全程读写真实库**（这样的运行共 5 次，每次第二段 12–25 轮）

影响（如实）：
  · **"真实库从未被打开"这条主张在 WP5 重启 lane 上不成立**
  · 第二段若干轮次（如「出差带 Mac 笔记本。」）**可能**产生真实写入 —— **未验证**；
    验证它需要再打开真实库，**无授权不做**
  · 第二段"看到基库内容"这一现象**因此被解释**：它看的就是真实库

已做的更正（**不回写历史**）：
  · 全部读数保留；`docs/lv2/Lv2-WP5-Trajectory-Report.md` 已标明这两条读数**不是**隔离实验结果
  · 正确做法**仓库里已有**（不需要改 sandbox API）：
    `isolateDatabase(label, { runId: '<固定 id>', keep: true })` —— **两个进程都调它**；
    源码注释 `src/dev/sandbox.ts:79/110-112` 逐字写明这正是"跨进程续跑 / 重启后状态是否还在"的用法

纪律（新增）：
  **"隔离"必须同时满足：`PGLITE_DATA_DIR` 与 `PROJECT_LG_SANDBOX` 指向同一目录。**
  只设后者 = 闸被说服、PGlite 却去了别处 —— 这是 `R-37`（"档位必须覆盖整条链"）
  在**数据目录**上的同形变体。

⚠️ 后续动作（**需授权**）：真实库被写了什么、是否需要恢复，属**独立裁定**
（`INC-01` 的恢复流程默认 dry-run、apply 需逐字授权）；本登记册**不**自行发起。

### R-38 · **已按用户授权完成的只读确认**（2026-10-02，用户：「要确认真实库被写了什么，看情况判断需要恢复」）

```text
流程（全部走 INC-01 的受控只读路径）：
  ① pre-open verified snapshot：`pnpm db:snapshot --keep 30`
     ⇒ snapshotId `2026-10-02T13-55-05-783Z-5bd7f5cfc083`（**零删除**）
  ② 只读读取：`pnpm memory:list` / `pnpm history`
     ⇒ 状态机逐跳走完：IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED → DB_OPEN →
        SERVICES_STOPPED → DB_CLOSED_VERIFIED（读得干净）

**查到了什么**：
  · **记忆层：没有污染** —— `memory:list` 里搜不到本轨迹的任何内容
    （`Mac` / `笔记本` / `出差` / `实验室` / `香菜` / `楼下` / `提纲` 全无命中）
  · **对话层：确有污染** —— `history` 里出现本轨迹的轮次，时间戳 **21:38:15–21:38:16**；
    其中**她的回复带唯一标记**「（离线运行器控制回复：只验管线，不计读数）」**共 10 行**；
    对应的用户行（`嗯，知道了。` / `我实验室在哪来着？` / `今天有点累。` / `今天天气不错。`）同在
    ⚠️ **用户行的确切条数未测准**：我的计数正则漏了行首空白 ⇒ 那次统计的 "0" 是
       **我自己的静默零**，不得当作"没有更多行"（见 AGENTS §6.8 的同形教训）
  · 21:38:16 之后 `data/pglite` 无新写入（事故后未再被碰）

**判断（我的建议）**：
  · **不建议恢复（restore）**：post-incident 快照无法回退污染；而回到**事故前**的快照会
    **丢掉用户在那之后的真实对话** —— 代价大于收益，且 apply 是破坏性动作（需逐字授权）
  · **建议接受 + 登记 + 可识别**：污染行**有唯一标记**（她那 10 行）、时间窗明确
    （21:38:15–16）、记忆层干净 ⇒ 后续如需清理，可按"窗口 + 标记"定位；
    但**本仓库没有受控的删除/改写入口**，要做必须**另行裁定 + 单独实现**（不做自动清理）
  · **不要**把这次读数拿来主张"真实库从未被打开"—— 那句主张在本事故上已被推翻

### R-38 · **用户裁定：按推荐处置**（2026-10-02，用户：「R-38按你推荐的」）

```text
裁定 = **接受 + 登记 + 保留可识别性**（我的推荐，用户已批准）：
  · **不**做 restore（回到事故前快照会丢掉用户在那之后的真实对话，破坏性且需逐字授权）
  · **不**做手术式清理（本仓库**没有**受控的删除/改写入口；要做须另行裁定 + 单独实现）
  · 污染**可识别**：她那 10 行带唯一标记「（离线运行器控制回复：只验管线，不计读数）」，
    时间窗 `2026-10-02 21:38:15–21:38:16`；**记忆层干净**（`memory:list` 无命中）
  · pre-open 快照留档：`2026-10-02T13-55-05-783Z-5bd7f5cfc083`（作为本次确认的证据锚点）

**状态**：`R-38` = **ACCEPTED（按推荐接受，带可识别标记与时间窗）**；
纪律条目（"隔离必须同时满足 `PGLITE_DATA_DIR` 与 `PROJECT_LG_SANDBOX` 同目录"）**保持有效**。
```
```


---

## 0v. 第二十一批（2026-10-05）：**桌面查看与操作**（ADR-106）—— 已适配 / 已过离线与实机只读门（⏩ 生产激活见本节末修订）

> 载体：[`ADR-106`](adr/ADR-106-desktop-control.md)（`ACCEPTED / DESIGN FROZEN`）·
> 计划与进度 [`Desktop-Control-Execution-Plan-2026-10-05.md`](post-lv2/Desktop-Control-Execution-Plan-2026-10-05.md) ·
> 基线 [`Desktop-Control-WP0-Baseline.md`](post-lv2/Desktop-Control-WP0-Baseline.md) ·
> 探针记录 [`Desktop-Control-WP2-Probe-Record.md`](post-lv2/Desktop-Control-WP2-Probe-Record.md) ·
> 门与读数 [`Desktop-Control-WP5-Gates-Record.md`](post-lv2/Desktop-Control-WP5-Gates-Record.md) ·
> 局限 [`Desktop-Control-Known-Limitations.md`](post-lv2/Desktop-Control-Known-Limitations.md)。
> 上游调研（用户给的"计划"）：`docs/research/Su-Muwei-Desktop-Control-Candidates-2026-10-05.md`。

```text
做成了：上游 windows-mcp 0.8.7 装进**独立** venv（PyPI wheel sha256 已复算一致）；
        新增两个能力（desktop.inspect R1 / desktop.operate R2·任务级）与**闭集**三个动作
        （state / click / type）；离线硬门 43/0 · 实机只读门 14/0 · 角色决策矩阵 18 项未覆盖 0 ·
        `pnpm m4.5:ci` EXIT 0。
没做：  **生产激活**（代码缺省两档都是 false；激活需用户单独裁定，候选见
        `Desktop-Control-Activation-Candidate.md`）·
        **真实操作一次**（`pnpm desktop-control:act --i-am-here` 需人在场，本轮 NOT RUN）。
登记的三条新局限（完整清单见 Known-Limitations）：
  · `L-DC-09` 真实操作档 NOT RUN（门已就绪）
  · `L-DC-05` 任务级风险额度是**一个**数：开 operate 会让同一任务里的 browser.operate 也到 R2 可达
  · `L-DC-07`/`L-DC-10` 桌面文字（含她自己的界面、非密码输入框的当前值 ≤200 字符）会进当轮 prompt
已修的一处缺陷（留档，不回写）：`scope.truncated` 曾是恒 false（worker 先裁、适配器再判）——
  由真机读数发现，已补两档夹具负控。
一次事故（留档）：只读门第一版在用户浏览器里真点了一次（多开一个标签页）；修法是结构性的
  （结构化比对 + `dryRun` 干跑），不是"下次小心一点"。
一个并发读数（留档）：`pnpm utility:verify` 首轮 2 组 FAIL（math 相关，均为"没拿到当轮内容"），
  单独重跑 **32/32 PASS** ⇒ 归因并发负载下的子进程超时，不是代码回归。
```

**状态**：桌面能力 = **已适配 / 已过离线与实机只读门 / 未激活 / 真实操作档 NOT RUN**。
⚠️ 本批**没有**动真实库（`data/pglite` 只被隔离库路径绕开；`m4.5:ci` 与两道桌面门都不开真实库）。

⏩ **2026-10-05 修订读数（只追加；上面那两行按 `TD-16` 一字不改）**：
用户裁定「**两档都开**」+「现在跑真实操作门」之后，桌面能力已 **ACTIVATED** ——
`.env` **只追加** `CHARACTER_DESKTOP_INSPECT_ENABLED=true` / `CHARACTER_DESKTOP_OPERATE_ENABLED=true`
（**代码缺省仍是 false**；回滚 = 删这两行，venv 保留）· **首次使用 = NOT OBSERVED** ·
**真实操作档 = PARTIAL**（`type` 实测真的执行；读回 / click 那一档因本机**并发会话抢前台**未取得完整 PASS）·
`L-DC-05`（任务级 R2 也让 `browser.operate` 可达，而 browser 本来就开着）**现已上线** ·
`L-DC-13`（上游只枚举**前台窗口**的元素）见
[`Desktop-Control-Known-Limitations.md`](post-lv2/Desktop-Control-Known-Limitations.md) 与
[`Desktop-Control-Activation-Record.md`](post-lv2/Desktop-Control-Activation-Record.md)。

⚠️ **本节编号已改（`0t` → `0v`、第二十批 → 第二十一批）**：原先它与**同日的另一批**
（§`0t` 证据/调度可信化 + §`0u` S8 真实入口）**撞号**；改的只是**编号与标题**，
正文那两行"未激活 / 真实操作档 NOT RUN"是**当时**的读数，**一字未改**（`TD-16`）。
用户可见说明已同步：[`docs/苏沐薇-使用说明.txt`](苏沐薇-使用说明.txt) 的「十一之二」一节（`092bbd5e`）。

## 0w. 第二十二批（2026-10-07）：S8 日常故事接入与生产启用

用户要求「先把缺口补上」，故事作为日常启动的一部分，「聊到了就推进没聊到没事」，不再单独启动开局入口。设计与授权载体 [ADR-115](adr/ADR-115-story-daily-conversation.md)，事实与证据 [交付记录](post-lv2/S8-Daily-Conversation-Report-2026-10-07.md)。

**当前修订读数**：入口与主回复装配缺口已补齐。日常模式惰性开局；本轮选择通过既有提交口进入世界账本，绑定真实 conversationId 与用户事件；相关轮注入可见场景，普通聊天不推进、不注入世界观测。重启续接，终局不自动重开。`.env` 已启用选择解析与日常模式，代码缺省仍 false，既有认知总开关保留。用户追加授权短暂停服检查并重启；旧核心 cleanClose=true，检查完成后正式 QQ 入口已恢复，LG ready 与 onebot_owner_private_ready 均观察到。

**验证范围**：新机械门 14/14；真实 main.ts 离线与测试模型短链各 5/5，两次启动、1 次开局、2 次选择，三个消费者水位均为 3；默认 8000ms 决策期限复验 PASS。完整离线链 EXIT 0，停服后新取副本的 Live Smoke 52/0。新增两个离线门已进入门清单与 affected 路径；原模块边界负控保留。没有新增 DDL，没有发送生产实验消息。

**历史与边界**：§0u 的旧读数和旧 `L-S8-30` 描述按日期保留；本节只修订入口接通、日常呈现与启用状态。运行中 QQ 重启导致真实库树摘要变化的 FAIL 保留，停服后另出新 PASS，不回写。`L-S8-31` 语义误判风险仍 OPEN；有限真实短链不证明长期人格/习惯收益，也不机械保证所有模拟/现实措辞。当前只接现有的一条有限故事，生产首次自然故事使用尚未观察。

## 0x. 第二十三批（2026-10-07）：L-S8-30 消费锁量具残余修复

用户核查旧消费锁仍会假绿后授权「行如果能修就把它修好」。设计沿用 ADR-107 `R-4c`；事实与验证见 [消费锁量具修复记录](post-lv2/S8-Consumption-Lock-Repair-2026-10-07.md)。

**当前修订：量具残余 RESOLVED（工程验收范围）**。旧 D01 全文正则改为 AST 装配检查，拒收注释、字符串和缺少一侧接线的源码，主张明确降级为装配在场。真实 `main.ts --bridge` 的日常 e2e 新增两个负控：只在临时副本摘除入口调用，五轮回复正常却零提交时必须 FAIL；摘除消费调用，三条提交存在却无水位时必须 FAIL；恢复原入口后三条提交、三个水位均为 3，再次 PASS。负控不能以启动、协议、超时或数据库失败冒充。门已在现有 lane / affected 映射中，临时源码期间声明独占，运行后删除并核对生产源码未变。

**边界分列**：入口缺口已由 ADR-107 / ADR-115 的实现取代；本批只修量具与主张，不改变生产故事逻辑、配置或 DDL。自然生产首次使用仍 NOT OBSERVED；`L-S8-31` 和长期人格/习惯收益不因本批关闭。旧 OPEN / PASS / FAIL 保留，本批没有打开真实库或发送生产实验消息。

## 0y. 第二十四批（2026-10-07）：**三个惰性配置项的确认** + `telemetryEnabled` 口径分裂 + `M4 D3` 修订

来源：全项目审计 `docs/audit/2026-10-07-full-project-audit.md` §4 的"4 个零引用字段"，用户裁定「按建议进行」。
本轮**只确认与标注**：不改行为、不改配置、不改 DDL、不打开真实库。判据 = `src/**` 静态引用 + `git log -S` + 现有门。

### R-67 · `eventPipelineV2`（缺省 **true**）是惰性开关：`=false` 是空承诺

| 项 | 事实 |
|---|---|
| 解析 | `src/kernel/app/flags.ts` 的 `truthy(env.CHARACTER_EVENT_PIPELINE_V2, true)` |
| 消费者 | **行为面 0 个**；`src/**` 里唯一引用是 `record('event-pipeline-v2', …)`（诊断行） |
| 年龄 | 引入于 `0347895c`（M2.5 Architecture Foundation）；其后 `src/**` 无第二个引用 |
| 后果 | 写事实账本（v2）已是**唯一行为** ⇒ 把这个 env 设为 `false` **什么都不发生** |
| 处置 | 本轮只**标注**（`flags.ts` 字段注释已写清）。删除属独立裁定：会动 flags 的公开形状 + `scripts/kernel-tests-m5.5.1.ts:1138/1143` 的夹具 |

### R-68 · `memoryExtractionWindow` / `memoryImportanceThreshold`：**未接线老路径的调参旋钮**

解析处 `flags.ts`（`boundedInt` / `boundedFloat` + 夹紧）；`src/kernel/app/memory/pipeline.ts` **没有** window/threshold 参数；
新的自动记忆（ADR-117）走**逐事件**流水线、**不传**这两个值 ⇒ 目前唯一的读取者是诊断行
（`memory-window=` / `importance-threshold=`，由 `scripts/kernel-tests-memory.ts:3615` 断言）。
引入于 `28f01a9e`（M4 WP4 Background Memory Extraction）⇒ 与 `M4 D3` 同源。**处置：本轮只标注。**

### R-69 · `telemetryEnabled`：字段惰性，但**同一个 env 在 `port.ts` 被真消费**（口径分裂）

`flags.ts` 解析一次（只进诊断行）；`src/infrastructure/telemetry/port.ts:260` 的 `readTelemetryConfig()`
**又解析一次** `CHARACTER_TELEMETRY_ENABLED`（本地 `truthy` 同语义），**行为由它消费**。
⇒ 不是"开关撒谎"，是**同一配置两处解析**；两处**当前**语义一致，但**没有机器判据锁住一致性**（改一处不影响另一处）。
**处置：本轮只标注。** 建议（未做，需裁定）：让 `readTelemetryConfig` 接受注入的 flags，或加一条"两处一致"的门。

### R-70 · `M4 D3`（后台记忆抽取 NOT-WIRED）→ **能力缺口已由 ADR-117/118 交付**；`TD-19` 本体**不收窄**

**新路径（能力已交付）**

```text
接线    automatic-memory.ts → runMemoryExtractionPipeline（kernel/app/memory/pipeline.ts）
        + createMemoryMutationValidator + 水位（advanceWatermark / job-store）
生命周期 main.ts:3445 构造 · :3453 open · :4956 drain · :5082 close
激活    .env CHARACTER_MEMORY_AUTOMATIC_ENABLED=true（ADR-118）
门      postlv2:automatic-memory:verify PASS · m4:test 262/0
守卫    ✅ 问句守卫已覆盖新路径：langmem-memory-extractor.ts:5 引入 isQuestionLike、
        :22 在**调用模型之前**过滤问句（另有 extractor.ts:808/900 与 content-extractor.ts:907/1013）
        ⇒ `L-M97-02` 那条"后台路径未接线 ⇒ 只是未来风险"的**紧迫性判断需要重读**（守卫已在位）
```

**老路径（事实不变）**：`src/**` 对 `kernel/app/memory/job.ts` 的 import 仍 = **0**（只有 `main.ts:7085` 注释提到它）；
`CHARACTER_MEMORY_BACKGROUND_ENABLED` 的唯一消费者仍是**启动告警 + 诊断行** ⇒
`m5.1.1:wp9*` 系列"`src/**` import = 0 ∧ 只有 NOT-WIRED 告警"的断言**照旧成立**（本轮**没有**动它）。

**判定**：`M4 D3` 的**能力**（"她目前只记得住被明确告知的事"）由 **ADR-117/118 的新路径交付**；
`kernel/app/memory/job.ts` 现在是**未被使用的实现**，**不是缺口**。
⚠️ **`TD-19` 本体不收窄、不销账**：它的范围是"系统发起与后台路径的**完整能力包**"
（系统主体归因 / 授权 / 幂等 / ledger / trace / 恢复 / 回复真相端到端），比"记忆抽取"宽得多，仍需独立授权（原文保留）。

**建议（未做，需裁定）**：① 把 `job.ts` 标成"被 ADR-117/118 取代（保留实现）"或删除；
② `docs/m4/M4-Technical-Debt.md` 是**冻结**文档 ⇒ 只在本册记修订，不回写它。

**不主张**：不主张"后台任务已完整接线"（那正是 `TD-19` 的范围）；不主张两个惰性参数已被删除；
不主张两处 `truthy` 已一致（只是"当前一致"）。

### R-70 · **用户裁定（2026-10-07）：`job.ts` = 「被 ADR-117/118 取代（保留实现）」**

用户原话：「**job.ts 被 ADR-117/118 取代（保留实现）**」。据此把上面那条"判定"**落成状态**：

```text
性质      kernel/app/memory/job.ts  = 被取代的**未被使用实现**（保留）
不变      ① src/ 下 import = 0（M5.1.1 的 wp9* 断言照旧成立）
          ② CHARACTER_MEMORY_BACKGROUND_ENABLED 仍是 NOT-WIRED 惰性开关（m4:test 的反向断言照旧成立）
          ③ 本轮**没有**改它的任何行为、也没有动那两条断言
交了      **能力**由 ADR-117/118 的另一条路径交付（automatic-memory.ts → pipeline.ts + 水位）
没交      **TD-19 本体**（系统发起与后台路径的完整能力包）仍然 OPEN，需独立授权
```

**落地位置（四处同步，都是"只追加"口径）**：
`src/kernel/app/memory/job.ts` 头部 ⏩ · `docs/architecture/memory-lifecycle.md` §3 ⏩ ·
`docs/architecture/README.md` 的 M4 段 ⏩ · `AGENTS.md` §3「被刻意关掉的开关」段 ⏩。

⚠️ **为什么"保留实现"而不是删除**：那条链（水位**补洞** / 幂等键 / 断点续跑）与它的测试是**唯一的**在案知识，
删掉等于把"怎么做对"一起删掉；而它不接线就没有成本（惰性开关，启动如实告警）。
**将来要接线**：先读 `scripts/kernel-tests-memory.ts` 的反向断言与 `memory-lifecycle.md` §3 —— 两处必须**同时**改。

## 2026-10-08 审计修复追加（历史状态不回写）

- **AUD-01**：可修补公告已移除；生产 npm 图剩 1 low，含开发工具剩 1 high + 1 low，两个无修补版本残余仍 OPEN。Node 内置 Undici 不属于该 npm 修补读数。
- **AUD-02**：图片/学习/编排/恢复/OSS 控制门及 affected 补齐，升级档保留已审核离线专项；20/20 PASS。旧 timeout、M5 两字桥和 M3 未等待关闭的失败记录保留，量具按当前契约修正后通过。
- **AUD-03**：只读健康与有界原源恢复已实现、隔离验证通过；重启不授权，旧 failed jobs 不删，真实库未发恢复授权。
- **AIRI / LiveKit / Pipecat / MaiBot**：边界机制已接入并通过功能检查、前端实际构建和快照副本真实模型回归 56/56。语音性能及人格收益仍 NOT RUN；当前生产未重启激活。
- **AUD-ISO-01 = OPEN**：首次恢复测试误打开真实库，保护根因已修；本次干净关闭及完整影响未证明。INC-01 漂移失败保留，当前真实库不作为最终验收源。

裁定 [ADR-121](adr/ADR-121-audit-remediation-and-operator-recovery.md)；[交付与残余](audit/2026-10-08-audit-remediation-and-oss-adoption.md)；[事故记录](audit/2026-10-08-recovery-test-isolation-incident.md)。

## 2026-10-09 生产处置追加（不改写上轮历史）

用户明确授权继续处置并生产激活，[ADR-122](adr/ADR-122-audit-mechanisms-production-activation.md) 与[激活记录](audit/2026-10-09-audit-production-activation.md)记录执行范围。

- **AUD-ISO-01** 当前可用性 = **MITIGATED**：现有真实库的租约快照、一次性副本健康及逐表读取通过，后续生产主程序和共存正常关闭具备新的 `cleanClose=true` / post-close 快照。原事故关闭和完整影响仍 UNKNOWN，整体仍 OPEN；没有恢复、迁移或清锁。
- **AUD-03** 正式健康入口已使用；诊断对话的 8 个自动提取任务 completed，水位到 785、pending=0、failures=0、recoveries=0。当前没有耗尽源，不制造恢复授权；真实 apply 分支未运行，隔离控制继续作为该分支证据。
- **借鉴机制** 新前端已部署，真实页面回复、音频终态、清队列和核心 ACK 已观察。四轮生产 trace 每轮选中 1 条合格记忆，尚未触达 INJECTION_LIMIT。64 条洪泛与重复音频注入只在隔离门验证。语音性能和人格收益评测继续 DEFERRED。
- **激活首轮 FAIL** 共存核心未开启表达侧车，外壳拒绝呈现；已补齐现有 `CHARACTER_EXPRESSIVE_SPEECH=true` 配置后复测页面成功。失败的生成/消费账和日志不抹去。
- **安全停机入口** `scripts/coexist/stop.mjs` 少算一层项目根，已修正；真实脚本在一次性项目中从任意 cwd 执行写入正确哨兵，共存专项通过。生产的排空/关闭实现沿用原状态机。

最终运行与完整回归读数以激活记录和该轮 machine evidence 为准；两个无修补版本依赖公告与旧 INC-01 漂移 FAIL 未销账。
