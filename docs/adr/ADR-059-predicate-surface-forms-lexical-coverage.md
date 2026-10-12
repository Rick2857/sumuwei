# ADR-059 — 登记表里的**已证实问法**（`surfaceForms`）：只补词面覆盖（B② / SRP-A-08 / SRP-C-08）

状态：**ACCEPTED / IMPLEMENTED**（用户 2026-09-25 裁定 **B②**：
「**修词面覆盖，暂不加语义/向量通道，也不降低全局相关性阈值。**先为「在写什么」「哪个学校」等
已证实问法设计槽位相关的匹配，再用无关问题负控证明不会乱召回。」）。
⚠️ 与 ADR-055/056/057/058 同一条纪律：**本文件正文不再改写**；后续若要再动这条闸，**新开 ADR**。

日期：2026-09-25。归属：**M6.1 / WP5**（B② 问题组的**范围内**修复）。
上游裁定：[`evals/m6.1/acceptance/ADJUDICATION-LOG.md`](../../evals/m6.1/acceptance/ADJUDICATION-LOG.md) §19.3。
触发它的读数：[`WP5-Handoff.md`](../m6.1/WP5-Handoff.md) §5.5 的具名问题组 +
[`M6.1-WP5-Failure-Attribution.md`](../m6.1/M6.1-WP5-Failure-Attribution.md) §4.4（子形态 b）
+ 复现器 `pnpm m6.1:recall-coverage --label pre|post`。

---

## 0. 前提：为什么"存在且合格的记忆"会进不了上下文

四轮 live 实测（两条臂 × 两轮）里，SRP-A-08 / SRP-C-08 **每轮都**是同一个读数：

```text
召回跑了：候选 ≥1 · 合格 1 · 选中 0 ⇒ 依据没进上下文 ⇒ 她于是补造（「你从下午坐到现在吧」）
```

归因不是"检索没跑"，而是**最后一道词面闸把唯一合格候选判成不相关**：

```text
target-resolver.ts 第 3 步（相关性闸）
  fragments = lexicalFragments(用户的话)          // CJK 连续段 → 二字滑窗
  relevant  = lexicalOverlapHits(text, active)   // 任一片段出现在候选的可搜索文本里 ⇒ 相关
  relevanceHaystack(record) = predicate + value + 登记表 description + examples

冻结条文 SRP-A-08 / SRP-C-08 的形状：
  库里  project.background.active = 毕业论文
  问句  「我现在在写什么？」→ 片段 [我现, 现在, 在在, 在写, 写什, 什么]
  该槽位的 description（「正在做的长期项目…」）与 examples（「我在做一个角色 Agent 的项目」）
  与这些片段**零重叠** ⇒ 命中 0 ⇒ 总分 < `policyMinTotal: 1.5` ⇒ `LOW_RELEVANCE` ⇒ 不进上下文
```

即：**问句说的就是那个槽位，但槽位的可搜索文本里一个字都不重合**。
这不是阈值调参问题（0 命中到 1.5 分的距离不是靠调阈值补的），也不是"语义通道缺失"问题
（M4 没有嵌入列，`memory-retrieval-store.buildCapabilities()` 把 `semantic` 明列在 `unavailable`，
G3 已裁定）——它缺的是**词面覆盖**。

**修前那两份读数（都是已提交的机器证据，逐字）**：

```text
① 探针（`artifacts/m6.1/recall-probe.json` @ `m6.1-recall-probe@1`，提交 4435ee6）
   finding-project                  （SRP-A-08 形状）候选 1 · 合格 1 · **选中 0** · 命中 0 · LOW_RELEVANCE
   finding-project-after-correction （SRP-C-08 形状）候选 2 · 合格 1 · **选中 0** · 命中 0
                                    逐条理由 = **SUPERSEDED**（旧值，被正确地 supersede 掉）
                                              / **LOW_RELEVANCE**（新值，被词面闸误杀）
                                    达上下文 = false
   ⇒ SRP-C-08 的**双候选**形状在修前是"旧值被正确排除、新值被错误排除" ——
     两条候选**一条都没进上下文**，与四轮 live 的"候选 2 · 合格 1 · 选中 0"逐字吻合。

② 覆盖读数（`artifacts/m6.1/recall-coverage-pre.json`，提交 4435ee6）
   b2-project 命中 0 · 合格 1 · **选中 0** · LOW_RELEVANCE:1
```

---

## 1. 决定（B②：只补词面覆盖）

| # | 决定 | 落点 |
|---|---|---|
| **D-59a** | **只扩"可搜索文本"，不动闸的判据**：`relevanceHaystack()` 在 `includeRegistry` 为真时，除 `description` / `examples` 外**再**拼入 `spec.surfaceForms`。`minTotal`（1.5）、`lexicalFragments()` 的切分规则、`lexicalOverlapHits()` 的"任一命中即相关"语义**一个字未动** | `src/kernel/app/memory/target-resolver.ts` |
| **D-59b** | **覆盖以"数据"形式登记，不写代码字典**：新增可选字段 `PredicateSpec.surfaceForms?: readonly string[]`，逐槽位、逐条登记，可审计、可 diff。**不是**同义词词典，**不是**停用词表，**不是**在解析器里再写一张对照表（沿用 `memory-predicates.ts` 自己的教条："同义词归并的正确位置是登记表"） | `src/kernel/contracts/memory-predicates.ts` |
| **D-59c** | **只登记"已证实问法"**，且**必须避开通用疑问词**。本次只登记一条：`project.background.active.surfaceForms = ['我现在在写']`。**不放**「在写什么」「写什么」「什么」——闸是 **2 字滑窗**，`什么` 一旦进 haystack，**无关问题**（「今天午饭吃什么？」「我平时喜欢什么运动？」）当场命中 ⇒ 负控被打破（§2 有逐片段依据） | 同上 |
| **D-59d** | **语义/向量通道不引入**（19.3 逐字："暂不加"）；**全局相关性阈值不降**（19.3 逐字："也不降低"）。本次改动**不新增**任何依赖、不新增任何模型调用、不改任何评分权重 | 同上 |
| **D-59e** | **射程按"词面闸是不是卡点"逐个判定，不按问题组名字照单全收**：B② 组 3 条里，SRP-A-08 / SRP-C-08 的卡点是本闸（修）；SRP-C-03 的卡点在**抽取阶段**（值被存成「了」，ADR-056 面）——`pre` 读数里它的形状（`b2-institution-updated`）**本来就是 选中 1**，因此**不在**本次射程内（§3 有对照读数） | §3 |
| **D-59f** | **判据（量具）**：新增 `pnpm m6.1:recall-coverage --label pre\|post`——在隔离库里按**生产路径**写入冻结条文的 setup，再用**生产同形**的召回请求读出 词面命中/候选/合格/选中/排除理由；**正控**（同一条链的活样本）**+ 负控**（4 条无关问题：午饭 / 运动 / 天气 / 没存过的槽位）**+ 恢复**（真实实现放回后负控重新安静）+ 真实库树摘要前后逐字比对。**pre 基线先落盘再改代码**（`artifacts/m6.1/recall-coverage-pre.json`，提交 `4435ee6`），post 与之逐条对照 | `scripts/m6.1-recall-coverage.ts` |
| **D-59g** | **冻结区纪律**：改动落在 `src/kernel/contracts/**` 与 `src/kernel/app/memory/**` ⇒ 本 ADR + 两套门（`kernel:test` + `kernel:verify`；`m4:test` / `m4:verify` / `m4:mutation-safety:verify` / `m4:nl-mutation:verify` / `eval:m4`），另加召回链（`m5:*`）与 M6.1 门（§4） | §4 |
| **D-59h** | **探针升版（量具版本变更，不做老读数补判）**：`m6.1-recall-probe` 的期望原本把**缺陷本身**写成断言（"目标必须选中 0"），修好之后它如实拒绝出自己的读数（exit 3）——这是正确行为，但仪器必须能表达**当前**状态。⇒ 升 `m6.1-recall-probe@2`：① 加运行档 `--expect fixed`（**默认**，断言"目标必须选中 ≥1 **且取值正确**"）与 `--expect found`（**历史档**，保留修前那份发现，在已修的树上会如实报未成立）；② 加**取值断言**（SRP-C-08：选中的必须是新值、**不得**是旧值）；③ 加**修后负控**（无关问题必须"候选 > 0 却选中 0"）；④ 加 `--inject-fake` 量具自证开关（判据必须响），且注入档写**另一个文件** ⇒ 永不覆盖真实读数。**修前那份读数不进"补判"**：它留在 git 历史（`4435ee6`）与 §0 的引文里 | `scripts/m6.1-recall-probe.ts` |

---

## 2. 为什么"通用疑问词不能进 haystack"——逐片段依据

`surfaceForms` 不是"多写几个词更保险"。它进的是**召回方向**的判据（`includeRegistrySurfaceForms: true`
的那几个调用点），所以每一条登记项都必须**证明它不会让无关问题也命中**。

```text
若登记 '我现在在写'：2 字滑窗 = [我现, 现在, 在在, 在写]

负控们自己的片段表（pre/post 读数逐条列出，是**读数**不是推测）：
  neg-lunch        「今天午饭吃什么？」  片段 [今天, 天午, 午饭, 饭吃, 吃什, 什么]  ⇒ 与上面 4 个**零交集**
  neg-sport        「我平时喜欢什么运动？」片段 [我平, 平时, 时喜, 喜欢, 欢什, 什么, 么运, 运动] ⇒ 零交集
  neg-weather      「外面下雨了吗？」    片段 [外面, 面下, 下雨, 雨了, 了吗]      ⇒ 零交集
  neg-absent-slot  「我平时用什么电脑？」片段 [我平, 平时, 时用, 用什, 什么, 么电, 电脑] ⇒ 零交集

反事实（**推理，不是实测**，依据是上表 + §4 的"1 命中即被选中"读数）：
  若把「在写什么」也登记进去 ⇒ 滑窗含 `什么`
    ⇒ neg-lunch（片段里有 `什么`）与 neg-sport（片段里有 `什么`）**都会命中**
    ⇒ 而 1 个命中已经足以把分数推过 1.5（b2-project 就是 hits=1 ⇒ 选中 1）
    ⇒ **两条负控当场翻红**。
  这就是"不放通用疑问词"的量化理由；它同时也是"不要图省事放一个长句"的边界：
  长句的滑窗越多，越可能扫到通用片段。
```

因此 `surfaceForms` 的登记纪律（写给下一个人）：

```text
① 必须是**已证实**的问法片段（有冻结条文或复现读数撑着），不是"我觉得用户会这么说"；
② 片段里**不得**出现 什么 / 怎么 / 哪 / 吗 这类通用疑问词（2 字滑窗会把它们带进来）；
③ 加了就必须**重跑** `pnpm m6.1:recall-coverage --label post`（4 条负控 + 正控）；
④ 它只允许**收窄到具体槽位**：一条登记项只写给一个 predicate，不许跨槽位复用。
```

---

## 3. 射程：改了几条、没改哪条（逐条对照读数）

`pre` 基线（提交 `4435ee6`，7 个用例）与 `post` 的逐条对照：

| 用例 | 形状（对应冻结条文） | pre | post |
|---|---|---|---|
| `ctl-institution`（**正控**） | SRP-A-01「我在哪个学校读书？」 | hits=1 · 选中 1（江城大学） | hits=1 · 选中 1（江城大学）✔ 未动 |
| `b2-project` | **SRP-A-08**「我现在在写什么？」 | hits=**0** · 合格 1 · **选中 0** · `LOW_RELEVANCE:1` | hits=**1** · 合格 1 · **选中 1（毕业论文）** ✔ 修好 |
| `b2-institution-updated` | **SRP-C-03** 更正后问同一句 | hits=2 · 候选 2 · 合格 1 · **选中 1（明德大学）** | 同左（**未动**） |
| `neg-lunch` / `neg-sport` / `neg-weather` / `neg-absent-slot`（**负控** 4 条） | 无关问题 | 全部 选中 **0** · `LOW_RELEVANCE:1` | 全部 选中 **0** · `LOW_RELEVANCE:1` ✔ 未乱召回 |

**SRP-C-08 的"双候选"形状**（候选 2 · 合格 1）另有独立的设备读数（
`pnpm m6.1:recall-probe`，同一台机器、同一份冻结 setup 与问句，档 `--expect fixed|found`）：

| 探针用例 | 形状 | 修前（`@1`，提交 4435ee6） | 修后（`@2`，默认档） |
|---|---|---|---|
| `finding-project` | **SRP-A-08** | 候选 1 · 合格 1 · **选中 0** · 命中 0 · `LOW_RELEVANCE` | 候选 1 · 合格 1 · **选中 1** · 选中取值 **[毕业论文]** ✔ |
| `finding-project-after-correction` | **SRP-C-08** | 候选 2 · 合格 1 · **选中 0** · 命中 0 · 理由 `SUPERSEDED` / `LOW_RELEVANCE` · 达上下文 false | 候选 2 · 合格 1 · **选中 1** · 选中取值 **[课程设计]**（新值）· 旧值 `毕业论文` 仍以 `SUPERSEDED` 排除、**未当选现状** ✔ |
| `neg-unrelated-lunch`（**修后负控**） | 同一库里的无关问题 | —（@1 无此用例） | 候选 1 · 合格 1 · **选中 0** ✔ |
| `control-institution`（**正控**） | SRP-A-01 | 选中 1 | 选中 1 ✔ 未动 |

结论（可查的两句话）：

```text
· B② 组的**有效射程 = 2 条**：SRP-A-08 / SRP-C-08（同一个槽位、同一句问法）。
· SRP-C-03 **不在**本闸的射程内：pre 读数里它的形状本来就是"选中 1"。
  它的卡点是**抽取阶段**（「我转学到明德大学了」被存成值「了」），
  归属 ADR-056 的免费文本取值边界，与"依据未入模"是两个不同的失败面
  —— 归因表把这三条放在同一组，是因为**用户看到的症状**相同（她补造），
  不是因为**机制**相同。本 ADR 只认机制。
```

---

## 4. 证据（修前基线 = `recall-coverage-pre.json`（已提交）；修后 = `recall-coverage-post.json`）

```text
修前（提交 4435ee6）：
pnpm m6.1:recall-coverage --label pre    ⇒ verdict = PARTIAL
     b2-project  hits=0 · 合格 1 · 选中 0 · LOW_RELEVANCE:1
     正控 1/1 ✔ · 负控 4/4 ✔ · 恢复 true · 真实库树摘要未变

修后：
pnpm m6.1:recall-coverage --label post   ⇒ verdict = COVERED（exit 0）
     ctl-institution        正控 ✔ 选中 1（江城大学）
     b2-project             选中 1（毕业论文）      ← 本次修复的目标读数
     b2-institution-updated 选中 1（明德大学）
     neg-lunch / neg-sport / neg-weather / neg-absent-slot  全部 选中 0（LOW_RELEVANCE:1）
     near-miss-homework     ★边界读数（见 §5），问的是"她"在写作业 ⇒ 选中 1（毕业论文）
     selfProof: 正控 1/1 · 负控 4/4 · 恢复 PASS · countCheck cases=8(正控1/负控4/读数3)
     realDb: 前后逐字相同（c49ac7f7c22fcdeb…）
```

`surfaceForms` 是**契约层**字段、`relevanceHaystack` 是**记忆装配层**函数，按 §5 的门表跑：

```text
（逐门实跑读数见 §4.1；本节只列必跑清单）
  pnpm typecheck                    · pnpm kernel:test  · pnpm kernel:verify
  pnpm m4:test                      · pnpm m4:verify    · pnpm m4:mutation-safety:verify
  pnpm m4:nl-mutation:verify        · pnpm eval:m4
  pnpm m5:test                      · pnpm m5:verify    · pnpm m5:retrieval:verify
  pnpm m5:ranking:verify
  pnpm m6.1:test                    · pnpm m6.1:e2e:verify · pnpm m6.1:measurement:verify
  pnpm m6.1:update-turn:repro       · pnpm m6.1:update-turn:service-repro  （B① 回归锁）
  pnpm m6.1:recall-probe
```

### 4.1 逐门读数（2026-09-25，本 ADR 落地后逐门实跑；退出码全 0）

```text
pnpm typecheck                     ⇒ EXIT 0
pnpm kernel:test                   ⇒ 26 通过 / 0 失败
pnpm kernel:verify                 ⇒ 25 通过 / 0 失败（Phase C）
pnpm m4:test                       ⇒ 256 通过 / 0 失败
pnpm m4:verify                     ⇒ 142 通过 / 0 失败
pnpm m4:mutation-safety:verify     ⇒ 20 通过 / 0 失败（D1 系 target_not_found 诚实失败全部原样）
pnpm m4:nl-mutation:verify         ⇒ 38 通过 / 0 失败（12 条冻结误触发负控零变化）
pnpm eval:m4                       ⇒ 17 通过 / 0 失败
pnpm m5:test                       ⇒ 30 通过 / 0 失败
pnpm m5:verify                     ⇒ 26 通过 / 0 失败（Eligibility Filter）
pnpm m5:retrieval:verify           ⇒ 28 通过 / 0 失败（Retrieval Adapter）
pnpm m5:ranking:verify             ⇒ 27 通过 / 0 失败（Top-5 命中 10/10 = 100%）
pnpm m6.1:test                     ⇒ 263 通过 / 0 失败
pnpm m6.1:e2e:verify               ⇒ 20 通过 / 0 失败（PASS）
pnpm m6.1:measurement:verify       ⇒ 16 通过 / 0 失败（PASS）
pnpm m6.1:update-turn:repro        ⇒ MISS_REPRODUCED（抽取器层 ★负控照旧绿：正控 2/2 · 复现 2/2 · 负控 4/4 · 恢复 PASS）
pnpm m6.1:update-turn:service-repro ⇒ FIXED（ADR-058 的读数未被本次改动影响：正控 2/2 · 负控 7/7 · 恢复 PASS）
pnpm m6.1:recall-probe             ⇒ PASS（默认档；见 §4.2 与 §3 的取值断言）
```

### 4.2 探针 v2 的量具自证（正控 / 负控 / 恢复，判据本身也要被验证）

```text
① 正控    pnpm m6.1:recall-probe                    ⇒ EXIT 0 · 判据**安静**
          三段式：正控（control-institution 选中 1 ≥ 1）= PASS
                  · 断言（finding-project:选中1/[毕业论文]
                          finding-project-after-correction:选中1/[课程设计]）= 成立
                  · 负控（neg-unrelated-lunch:选中0/合格1）= 成立
                  · 恢复 = PASS
② 负控    pnpm m6.1:recall-probe --inject-fake      ⇒ EXIT 3 · 判据**必须响**，且具名是哪条断言
          「取值断言未成立：finding-project：★注入假象 —— 期望选中「毕业论文」，实际选中 [毕业论文]」
          「取值断言未成立：finding-project-after-correction：★注入假象 —— 期望选中「课程设计」，实际选中 [课程设计]」
          「取值断言未成立：finding-project-after-correction：★注入假象 —— 期望**不**选中「毕业论文」」
          ⇒ 3 条取值断言全部被证明**在真的检查**（不是恒真）
          ⚠️ 注入档写 `artifacts/m6.1/recall-probe-injected.json` ⇒ **永不**覆盖真实读数
③ 恢复    去掉开关再跑 ⇒ 三段式逐字段与①相同（EXIT 0）
④ 历史档  pnpm m6.1:recall-probe --expect found      ⇒ EXIT 3（**如实**："缺陷已不复现"）
          「负控未成立：零期望的那几条必须'选中 0 ∧ 合格 > 0 ∧ 候选 > 0'」
          ⇒ 这不是回归：历史档的期望就是修前那份发现，它只在修前的树上成立。
```

**证据覆盖说明**：`artifacts/m6.1/recall-probe.json` 由 `@1`（修前）**改为** `@2`（修后）——
旧内容**没有丢**，它在提交 `4435ee6`（以及更早的 `c4d9bf5`）里逐字可取，§0 也引了它的关键读数。
`recall-coverage-pre.json` **原样保留**（它是 `@1` 时期落的盘，本来就是基线），
`recall-coverage-post.json` 是 `@2` 时期的新读数；两者是**两次读数**，不是同一份文件的两个版本。

---

## 5. 残余风险与**已实测的边界**（如实登记）

```text
E-a  ★已实测**误召回边界**（post-only 读数 `near-miss-homework`）：
     「你在写作业吗？」（问的是**她**写作业，库里是**用户**的项目）⇒ 词面命中 ⇒
     那条 project.background.active 被选中。这是"扩词面"的**已知代价**：
     闸判的是"这句话与这个槽位有没有词面关系"，它**判不了**主体是用户还是她。
     ⇒ 登记在案、不作辩解；它属于 §2 的登记纪律要盯的形状（本次只登记了
     '我现在在写'，而「你在写作业吗？」的片段里含 `在写`，与该窗口重叠）。
     这条用例是**与修复同批加入**的 ⇒ **只有 post 读数**，没有 pre 对照（不许拿它当"修复前更好"的证据）。
E-b  SRP-C-08 的**双候选形状**（候选 2 · 合格 1）**已有两级机器读数**（§0 与 §3 的表）：
     修前 = 旧值 `SUPERSEDED`（正确排除） + 新值 `LOW_RELEVANCE`（错误排除） ⇒ 选中 0、达上下文 false；
     修后 = 选中 1 且**选中取值 = [课程设计]**（新值当选），旧值仍 `SUPERSEDED`。
     ⚠️ 两级读数的**量具版本不同**（修前 `m6.1-recall-probe@1`，修后 `@2`）：
     用例定义（setup/问句/槽位）逐字相同，修后档新增的是**取值断言**与**负控用例**
     ⇒ 那两条共有用例的 pre/post 对照可比；**新增的**用例（`neg-unrelated-lunch`）只有修后读数。
E-c  `surfaceForms` 进 haystack 的**副作用面**（本 ADR 未逐一实测，但可从调用点读出）：
     ① 第 3 步相关性闸（`includeRegistrySurfaceForms: true`）—— 本次的目标；
     ② `memory-retrieval-store` 的召回命中统计（M5 链，同样为 true）—— 词面覆盖率随之上升；
     ③ `correction-fallback` 的**把字句守卫**（ADR-058 D-58d，显式 true）—— 守卫的
        "X 与目标槽位词面相关"判定**放宽了一点**（接受方向），即「我把**在写**的东西换成…」
        现在会被当作与 project.background.active 相关；
     ④ 词面**判别器**（`LexicalSemanticJudge`，`includeRegistrySurfaceForms: false`）——**不受影响**，
        精度分工不变。
     ⇒ ①②③ 的方向都是"更容易认出相关"，不产生新的写入路径（写入仍只经 `runMutation`），
        但"更容易认出"本身就是 E-a 的代价。
E-d  本 ADR **没有**做"用户问句 → 槽位"的语义映射，也没有引入任何模型调用：
     它只补**已证实问法**。问法换个说法（「我手头在忙什么？」）仍然 0 命中 ⇒ 如实说找不到。
     这正是 19.3 的边界（"暂不加语义/向量通道"）。
```

---

## 6. 本次**不做**（边界）

```text
✗ 不加语义 / 向量 / 嵌入通道（19.3 逐字："暂不加"；M4 无嵌入列，G3 已裁定）。
✗ 不降 `minTotal`、不改 `lexicalFragments` 的切分、不改"任一命中即相关"的语义（19.3 逐字："也不降低"）。
✗ 不登记通用疑问词（什么 / 怎么 / 哪 / 吗），不把整句问法塞进 haystack（§2）。
✗ 不动抽取器 / 目标解析 / correct 兜底的任何既有路径（B① 属 ADR-058；抽取层属 ADR-056）。
✗ 不改任何冻结条文（`evals/m6.1/control/**`）与冻结的门阈值（`minTotal` 等）。
✗ 不主张 "B② 修好了 ⇒ WP5 通过"：WP5 的判定按 19.5 的收敛顺序，
   必须**连同剩余失败一起**在新候选上从 round 1 重跑两轮 + 部署档才能出结论
   （用户 19.5 逐字："两组产品修复还不足以让 WP5 通过"）。
✗ 不主张量具/判定器的任何性质；也不拿 16.9% 的样本内分歧去改 `maxTokens` / `minIntervalMs`（19.4）。
✗ **不给已有 FAIL 补判**：修前的四轮读数（FAIL）仍是 FAIL，本 ADR 不改写它们，
   也不把新读数"贴"回那四轮（探针升版时同样照此办理：修前读数留在 git 历史与 §0 的引文里）。
```

---

## 7. 这份 ADR 不主张什么

```text
· 不主张"词面覆盖问题解决了"——只主张**这一个槽位的一条已证实问法**被覆盖，负控未被打破（4/4）。
· 不主张零误召回（E-a 是已实测的反例，登记在案）。
· 不主张 live 轮的两条已翻绿：修复的**离线**读数是 COVERED，
  live 结论只能由新候选从 round 1 重跑得出（19.5）。
· 不主张 B② 组 3 条一起修好：SRP-C-03 按机制归属 ADR-056 面（§3 有 pre 对照读数）。
```
