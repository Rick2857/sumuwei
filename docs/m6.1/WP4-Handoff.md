# M6.1 / WP4 收口与交接单

> 判定：**WP4 = 完成**（用户 2026-09-24 裁定「好的确认完成」）。
> 机器依据：`pnpm m6.1:wp4:closure` = **PASS**（证据 `artifacts/m6.1/wp4-closure.json`；
> 六个负控各自因预期原因报红，恢复 = PASS；无时钟字段 ⇒ 重复运行逐字节相同）。
> 上一棒：[`WP3-Handoff.md`](./WP3-Handoff.md)（`WP3 = 完成`，用户 2026-09-24 裁定）。
> 下一棒：**WP5**（集成与真实模型短场景）。
> 载体：[`ADR-055`](../adr/ADR-055-m6.1-wp4-explicit-memory-correction-and-context-facts.md)（设计冻结 + §9 状态修订）
> · 冻结设计：[`M6.1-Root-Cause-and-Design.md`](./M6.1-Root-Cause-and-Design.md) §4.5 / §4.6 / §6.3。
>
> ⚠️ 「WP4 完成」≠「假记忆修好了」：本 WP 交付的是**最小修复 + 判据 + 读数器**，
> 真模型行为门属 WP5/WP6（见 §7 的"不允许主张"）。

---

## 0. 一句话

WP4 要回答的是「**该改哪一层、怎么改最小、门怎么证明改对了**」。
本轮把 ADR-055 的 `D-55a`…`D-55g` **逐条落地**，并把三条原来不存在的判据补齐：

```text
已落地：  B′（更正 cue 词表）· A（冲突分析进显式写入路径）·
         D1′（程序生成的记录状态行）· R-8③ 的第一半 · 守卫三态进 trace ·
         误触发负控扩到 12 条 · 运行期三读数读数器 · 静态装配等价判据补 replyGuards
未落地：  R-8③ 的第二半（「目前没有有效替代值」——缺"槽位当前状态的完整查询"）·
         真实装配下的三读数**真实运行**（属 WP5/WP6 的 Live 档）·
         两轮正式运行的运行器（WP5/WP6）
```

⚠️ **最重要的一条边界**：本轮**没有跑真实模型**。所以下面所有读数都是
**离线 / 部件 / 子系统**级；"她真的不再编造"**一个字节都没有被本 WP 主张**（那是 WP5/WP6）。

---

## 1. 计划书 §4 WP4 出口条件逐条对照

| # | 计划书要求 | 交付物 | 读数 |
|---|---|---|---|
| 1 | 按 WP3 定位结果**修改最小层次** | `src/kernel/app/recall/record-status.ts`（新）· `src/kernel/contracts/memory-record-status.ts`（新）· `turn-gateway.ts` 的两处接线 · `sections.ts` 的新 provider | 见 §2 |
| 2 | 优先修**来源/资格表达**或**断开的接线**，不造新数据库/平台/重写器 | 只新增**一个可裁 section**与**一个 trace step kind**；无新表、无新端口实现、无第二套资格判定 | 静态锁 AT2.1 **26/0**（理由字面量仍只在契约与纯召回层） |
| 3 | 测试装配以 `src/main.ts` 的实际 `buildGateway` 为对照，逐能力核对**开关消费 / 调用 / 状态 / 实际入模** | `scripts/m6.1-assembly-runtime.ts`（新，纯函数三读数）＋ 静态接线表补第 6 个能力 | L1 正控/三条负控/恢复 **228/0**；静态等价判据当前树零问题 |
| 4 | 复用 `scripts/verify-m6-wp7a.ts` 的合成隔离库与生产显式记忆路径，**但**它的 fixture 回复不能证明模型学会 | 未改 WP7a；本 WP 的装配证据用**静态判据 + 纯函数读数器**，并显式声明真实读数属 Live 档 | 同 3 |
| 5 | 交付：修复代码 · 局部回归 · 接线证据 · `WP4-Handoff.md` | 见 §4（变动文件与指纹） | 见 §5（命令与退出码） |
| 6 | 出口：反例修复、正控仍成功；类型与受影响门通过 | `pnpm typecheck` EXIT 0；`m4.5:ci` EXIT 0；`m5:gates` Hard Gates = PASS；`m6.1:test` 228/0 | 见 §5 |
| 7 | 若有意改 prompt ⇒ 按程序重刷基线并记录原因 | **M3.5 逐字节基线未动**（状态行走 `extraProviders`，基线构造器不传它 ⇒ `m3.5:test` EXIT 0）；**M5 两条判据**因设计变更而更新，逐条登记 | [`M6.1-WP4-M5-Compatible-Assertion-Record.md`](./M6.1-WP4-M5-Compatible-Assertion-Record.md) |
| 8 | 不可改 Seed 来背熟测试答案 | Seed **一个字节未动**（`src/character/**` 不在变动清单里） | `git status` 清单 |

---

## 2. WP3 交接单 §4 的六项逐条落地

### ① D1′ 渲染（设计 §4.5 第二稿，**已冻结**）——**已落地**

```text
形态   一条**程序生成**的记录状态行（section id `memory-record-status`，`kind: 'record-status'`）
       内容 = **可并存的原因列表** + 「最终入模数量」（不是单选枚举）
五种情形**分别**渲染（逐字用设计里的措辞）：
       not_searched（三个具名子因：端口未接 / 开关关闭 / 没有 userId）
       search_failed（带具名原因，且**不得**伪装成零结果）
       no_relevant（只写"未达到召回相关性阈值"）
       dropped_by_budget（带**条数**）
       ineligible:forgotten / :superseded / :orphaned（**按原因拆开**，槽位**具名**）
默认句  召回为空 ⇒「本轮长期记忆召回未向最终上下文提供记录。」（**不得**默认升级）
全量句  「本轮提供的上下文中，没有可支持这段共同经历的合格记录。」
       —— 只在 `allSourcesCovered === true` 时可用（今天生产默认摘要 0 ⇒ 走默认句）
预算    独立额度（`ContextCompileInput.statusTokenBudget`，缺省 **120 token**），
       **不占**共享预算 ⇒ 它的存在不会把记忆 section 挤出去
两遍编译 第一遍不带状态行 ⇒ 得到"记忆 section 是否活过裁剪"这个**编译之后**的事实；
       第二遍才把它作为 section 加进去 ⇒ 状态行说的就是最终 packet 的事实
       （两遍安全的前提 = 独立额度；这条**不变量**由 L1 直接断言，不靠"应该没问题"）
留痕    trace 每一步都记：`outcome`（included / dropped / not_generated）+ 结构化
       `reason_code`（`not_searched` 带子因）+ 计数 + `status_budget_isolated`
禁止写法 机器只扫**程序生成**的状态文本（`forbiddenPhrasesInStatusText`），
       范围**不得**扩展成对模型回复的词形守卫（那是 `DR-11`）
```

### ② R-8③（与 D1′ 同一机制）——**第一半已落地；第二半未做（如实登记）**

```text
已做   按原因具名（遗忘 / 取代各自一句）+ **槽位具名**（`canonicalKey` 来自候选明细）。
未做   「该槽位的旧记录已作废，目前没有有效替代值。」
       ⚠️ 为什么不做：设计给它写了**使用前提** ——「**必须**对该槽位当前状态做过完整查询」。
       今天的端口给不出这个查询：`MemoryConflictPort.recordsInCanonicalSlot` 的
       参考实现（`main.ts` 的 `buildMemoryWriter`）只回 **active + disputed**，
       看不到 superseded / retracted 的完整历史 ⇒ 用它来断言"没有有效替代值"就是
       用一次**不完整**的查询说一句**完整**的话。
       ⇒ 按 §4.5 的纪律（前提不满足就不许用这句），**宁可不渲染**。
       要落地它，需要一条"M6.1 WP4 未新增"的槽位全状态查询 —— 登记为 WP5/6 或后续 WP 的候选。
```

### ③ 守卫三态进 trace（设计 §6.3）——**已落地**

```text
契约   `src/kernel/contracts/reply-guard.ts`（新）：四道具名守卫 · 三态
       （`not_run` 观测缺失 / `passed` 静默通过 / `triggered` 已触发）· 结构化原因
接线   `main.ts` 把四道守卫（记忆真相 / 动作真相 / 外部证据真相 / 搜索判定绑定）
       的返回值翻译成报告，经 `completeTurn({ replyGuards })` 带出去 ——
       **不动** `response-truth.ts` / `claim-guard.ts` / 既有守卫的语义
落点   `turn-gateway.ts` 新增 `reply_guard` step，位置在 `model_generate` 之后、
       `output_validate` 之前（**那就是它真实发生的顺序**）
隐私   只记逐道 `*_status`（遥测白名单内的受控族）与计数；**回复正文不进 trace**
缺报告 少一道守卫 ⇒ `guard_missing_count` 如实记；**一份报告都没有** ⇒ 四道全算缺
       （空集不得显示成"全部通过"）
```

### ④ L3-11 从 5 条扩到 12 条（`= correction_intent_negative_v1`）——**已落地**

```text
判据仍**是 mutation 级**：逐条断言**库摘要不变**（0 次未经请求的记忆变更）；
「检测器是否命中」**不作**判据（例如「帮我把这段文字改一下。」仍会命中既有子串线索，
但目标解析不出来 ⇒ 服务如实回报、一个字节都没改）。
文本来源   门**从冻结集读**，不再手抄一份（手抄就是第二个语料来源）
集自检     12 条 / 6 类 × 2 / 每条声明 `mustNotChangeMemory`；
           空集 / 某类少一条 / 漏声明 ⇒ **红**（不是"合格"）
读数       `pnpm m4:nl-mutation:verify` **30 → 38 通过 / 0 失败**
```

### ⑤ 等价判据的**运行期**三读数（设计 §4.6 ②③）——**读数器已落地；真实读数属 WP5/6**

```text
新增   `scripts/m6.1-assembly-runtime.ts`（**纯函数**）：输入是"已经采集好的 trace 事实"，
       输出逐能力的三读数（端口接没接 / 开关开没开 / 实际进下游几条）+ 缺陷清单
三条缺陷  `port_missing` · `flag_not_consumed` · `result_not_in_downstream`
预先声明  `expect: must_fire | not_expected` **是输入的一部分**：
       **没有触发条件的安静轮次不算"装配缺失"，也不能算该能力的证据**
       ⇒ 报 `trigger_not_declared`，且该轮不产生可作证据的读数
判决三层  没有可作证据的读数 ⇒ **MEASUREMENT INVALID**（不是 PASS）；
       有具名缺陷 ⇒ FAIL；其余 ⇒ PASS
自证       L1 正控（健康一轮 ⇒ PASS）· 三条负控（各自**因预期原因**报红）·
       未声明 ⇒ MEASUREMENT INVALID · 空运行 ⇒ MEASUREMENT INVALID · 恢复 ⇒ PASS
静态那一半  接线表补第 6 个能力 `replyGuards`（D-55g 的端口）
⚠️ 真实读数  "生产装配跑出来的那一份"需要真实模型与真实网关 ⇒ **WP5/WP6 的 Live 档**；
       **不许**拿 L1 的注入读数冒充它（ADR-055 §4.6 ④ 的原话）
```

### ⑥ 两轮正式运行的运行器（WP5/WP6）——**不在 WP4 范围**

---

## 3. 本轮我自己的缺陷（如实登记，不藏）

```text
① **我先写断言、后被门抓出两处期望值错**：
   · L1 的第一版断言"6 个能力都被声明" ⇒ 实际只声明了 4 个（门当场报红）。
   · L1 的运行期正控假设"空召回走默认句" ⇒ 实测走的是 `no_relevant`
     （无关问句确实产生 LOW_RELEVANCE）。两处都已按**实测**改正，不是把门放宽。
② **我改了代码去符合既有的静态锁**，而不是改锁：
   `src/kernel/app/recall/record-status.ts` 第一版写了 `'FORGOTTEN'` / `'SUPERSEDED'`
   字面量 ⇒ `pnpm m5:verify` 的 AT2.1 报红。处置 = 把映射搬进 `contracts/recall.ts`
   （锁明确允许的位置），消费方改成逐条读直方图。**判据一个字未改**。
③ **M5 的两条断言因设计变更而失效** ⇒ 不悄悄改，逐条写进
   [`M6.1-WP4-M5-Compatible-Assertion-Record.md`](./M6.1-WP4-M5-Compatible-Assertion-Record.md)，
   并换成**更强**的版本（差异只许来自状态行 + 不许出现记忆内容 section +
   "检索过"的那一轮不许说"没有发起检索"）。
④ **我自己在批处理里跑了一个不存在的命令名**（`m5:nl-e2e:verify`）⇒ 拿到
   `Command not found`。正确入口是 `m5:e2e:verify`（已补跑，EXIT 0）。
   记账：批处理脚本自己也要核对脚本名，不能把"命令不存在"读成"门没过"。
⑤ 我在 `m6.1-assembly-runtime.ts` 里先声明了一个从不产出的缺陷码
   （`unexpected_capability_activity`）⇒ 按仓库纪律（"表达得了但永远出不来"必须消灭或登记）
   **补上产出路径**（`expect: 'not_expected'` 的那一支真的会判）。
⑥ 一处**未做**的事我不含糊：R-8③ 的第二半（§2②）。
```

---

## 4. 变动文件与指纹

候选 = 本 WP 的三个提交（**只含本阶段可归属文件**；其他会话的 WIP 一个字节都没碰）：

```text
86c5905  feat(m6.1): WP4 — record-status line and reply-guard tri-state (ADR-055 D-55e/f/g)
be75d27  test(m6.1): WP4 gates — 12-item false-trigger set, runtime three-readings, L1 182 → 228
e8df233  docs(m6.1): WP4 handoff, ADR-055 status revision, M5 compatible-assertion record
         ＋ 其后的 docs 提交（本文件自身；不在此列自己的哈希 —— 那会让它每次提交都过期）
```

HEAD（提交前）= `7e272fde0e23e2b3ac0cd41617c581a12428a41c`（`7e272fd`）。
逐文件 sha256（前 12 位，**提交前**工作树内容；提交不改变内容）；
合并指纹 = **`e3aad05e7b2e8592a52dd16a9b35456b0355e84972735e85d04999a6487b3e49`**：

```text
新增  a9874e1b21d3  src/kernel/contracts/memory-record-status.ts   记录状态的契约与纯渲染
新增  42871a14ef27  src/kernel/contracts/reply-guard.ts            守卫三态的契约
新增  c4552afcb138  src/kernel/app/recall/record-status.ts         程序事实 → 状态（纯函数）
新增  3a62511d61de  scripts/m6.1-assembly-runtime.ts               运行期三读数（纯函数）
改    e54a5000bb07  src/kernel/contracts/recall.ts                 排除理由 → 状态原因的标签映射
改    c94f2fee7fe5  src/kernel/contracts/context.ts                新 kind / 优先级 41 / budgetGroup / statusTokenBudget
改    925def7f4427  src/kernel/contracts/trace.ts                  两个新 step kind
改    897d42d70d03  src/kernel/contracts/observability.ts          两个 kind → 既有阶段（不新增阶段）
改    5e9a838852af  src/kernel/contracts/index.ts                  导出两个新契约
改    88d5a97e5f2b  src/kernel/context/sections.ts                 记录状态 provider
改    173333f7291b  src/kernel/app/turn-gateway.ts                 两遍编译 · 状态行进 trace · 守卫报告 · 召回失败降级
改    1e416c15de95  src/main.ts                                    四道守卫 → 报告
改    8c7a2bb0742d  scripts/kernel-tests-m6.1.ts                   L1 +46 条（182 → 228）
改    e47c49281b22  scripts/m6.1-assembly-equivalence.ts           接线表补 replyGuards
改    4ec18f5f8105  scripts/verify-m4-nl-mutation.ts               L3-11 改为读冻结集（12 条）
改    929fc5925fe9  scripts/verify-m5-runtime.ts                   M5 两条判据更新（见兼容性记录）
```

**不属于本轮**（其他会话的 WIP，一个字节都没碰）：`.gitignore` · `AGENTS.md` · `README.md` ·
`docs/incidents/**` · `docs/m6/M6-DSH-Execution-Plan.md` · `docs/adr/ADR-051-*` · `docs/m6.5/**` ·
`scripts/gates/**` · `scripts/gates-run.ts` · `scripts/verify-cli-exit-latency.ts` ·
`scripts/verify-gate-runner.ts` · `scripts/inc-01-regression.ts` ·
`src/infrastructure/runtime/guard-timers.ts` · `artifacts/m5.5*` · `artifacts/m6/**`。

---

## 5. 命令与读数

```text
门                        读数                              退出码
────────────────────────────────────────────────────────────────────
pnpm typecheck            —                                    0
pnpm m6.1:test            228 通过 / 0 失败（原 182）            0
pnpm m6.1:wp3:closure     PASS（L1 228/0 被它读回）              0
pnpm m4:nl-mutation:verify 38 通过 / 0 失败（原 30）              0
pnpm m5:test              30 通过 / 0 失败                       0
pnpm m5:verify            26 通过 / 0 失败（AT2.1 静态锁）         0
pnpm m5:retrieval:verify  通过                                   0
pnpm m5:ranking:verify    27 通过 / 0 失败                       0
pnpm m5:budget:verify     35 通过 / 0 失败                       0
pnpm m5:runtime:verify    28 通过 / 0 失败（原 25/2）             0
pnpm m5:trace:verify      33 通过 / 0 失败                       0
pnpm m5:e2e:verify        28 通过 / 0 失败                       0
pnpm m5:gates             **Hard Gates = PASS**（G1–G9 全绿）     0
pnpm m4:test / m4:verify  通过 / 142 通过 / 0 失败                0
pnpm m4:mutation-safety   20 通过 / 0 失败                       0
pnpm eval:m4              17 通过 / 0 失败                       0
pnpm m4.5:test / :verify  通过 / 53 通过 / 0 失败                 0
pnpm m4.5:measurement     38 通过 / 0 失败                       0
pnpm m4.5:nl-action       32 通过 / 0 失败                       0
pnpm m4.5:ci              EXIT 0（离线全链，见 §5.1）             0
pnpm m6:verify --suite all 28/28 PASS · MEASUREMENT INVALID 0     0
pnpm m6:measurement:verify 46/46 PASS                            0
pnpm m6:gates             Hard Gates = PASS（wp10b-live 12/0）    0
pnpm m5.1:test            54 通过 / 0 失败                       0
pnpm m5.1:e2e:verify      22 通过 / 0 失败                       0
pnpm m5.1.1:test          43 通过 / 0 失败                       0
pnpm m5.5:test/:verify/:e2e 59 / 46 / 25 通过，0 失败             0
pnpm m5.5.1:test/:verify/:e2e 176 / 28 / 9 通过，0 失败           0
pnpm gates:run --lane affected  17/17 PASS（含 m3.5:test · kernel:* · eval:*） 0
────────────────────────────────────────────────────────────────────
只读汇总（秒级；各自读回上面那些落盘证据）
pnpm m4.5:gates           PASS（G9 人工审计语料 等）                0
pnpm m5.1:gates           Hard Gates = PASS                       0
pnpm m5.1.1:gates         全部可判定的门 = PASS（WP8-B harness PASS）0
pnpm m5.5:gates           Hard Gates = PASS                       0
pnpm m5.5.1:gates         6/6 被接受 · overall = PASS（自证 PASS）   0
```

### 5.1 `m4.5:ci` 与快车道

```text
pnpm m4.5:ci                EXIT 0（本次日志：artifacts/m4.5/m4-ci.log，已 gitignore）
pnpm gates:run --lane affected --cache   17 道全部 PASS（墙钟 32.9s）
                           runId fast-2026-09-24T04-54-03-358Z
                           证据 artifacts/.fast/<runId>/run.json（快车道不留发布证据）
```

⚠️ 快车道读数是**快照**，不是发布证据（`--mode release` 才串行、不缓存）；
本表里每一道门另有**直接执行**的读数（见上表与 §5.2）。

### 5.2 本轮直接执行并留痕的日志

```text
artifacts/.wp4-gates.txt    第一批（m5 / m5.5 / m5.5.1 / m6:gates / m6.1:wp3:closure）
artifacts/.wp4-gates2.txt   第二批（m5 全套 / m4 / m4.5 / m6:verify / m5.1 / m5.1.1）
artifacts/m6.1/component.json        L1 证据（228/0）
artifacts/m5/wp6-context-compiler.json  G6 证据（28/0，M5 判据已更新）
artifacts/m5/wp2-eligibility.json    G2 证据（26/0，AT2.1 静态锁）
artifacts/m4.1/nl-mutation.json      Layer C 证据（38/0）
artifacts/m5/gate-results.json       M5 汇总（Hard Gates = PASS）
artifacts/m6.1/wp3-closure.json      WP3 出口门（它读回 L1 = 228/0）
artifacts/m6/<runId>/                M6 各套件的本轮重跑证据（HEAD = 7e272fde0e23）：
                                    m6-verify · m6-wp2 · m6-wp3 · m6-wp3-reader ·
                                    m6-wp4 · m6-wp5 · m6-wp6a（--suite all，28/28 PASS）
```

### 5.3 证据还原（AGENTS §7 的白名单纪律）

```text
本轮被门**重新生成**、但内容与我的改动无关的历史证据，已按 §7 **逐条还原**（不做 blanket checkout）：
  artifacts/m4-acceptance/{isolation,restore}/… · artifacts/m4.5/{audit-corpus,audit-report,gate-results,
  measurement,nl-action,pipeline} · artifacts/m5.1/wp1-contracts.json ·
  artifacts/m5/{wp1-contracts,wp3-retrieval,wp4-ranking,wp7-trace,wp8-e2e}.json
保留（**是本轮的真实新读数**，不是 churn）：
  artifacts/{m6.1/component.json,m6.1/wp3-closure.json,m4.1/nl-mutation.json,
  m5/wp2-eligibility.json,m5/wp6-context-compiler.json,m5/gate-results.json,
  m5.1/{live-smoke-evidence,nl-e2e-evidence}.json,m5.5/{e2e,verify-runtime}.json,
  m5.5.1/component.json}
运行前就已脏的其他会话产物：一律**保留**（§7：运行前就脏的不动）。
```

---

## 6. 真实库边界

```text
本 WP **从未**打开真实库（`data/pglite`）：没有任何一条命令指向它，
   所有读数都来自隔离库（`PROJECT_LG_SANDBOX`）或纯函数。
机器读数（只做**文件树摘要**与 mtime 扫描，都不经数据库）：
   treeSha256 = c49ac7f7c22fcdeb6b0189fd274e4726fd7a854781c473551a369bf08a399f67
   measuredCount = 1207 · totalBytes = 32,354,847 · excludedPaths = [postmaster.pid]
   newestMtimeMs = 1790140797410.099（pg_wal/00000001000000000000000C）
   与 ADR 裁定日志 §18.4 记的 `c49ac7f7c22fcdeb…` **逐字相同**。
⚠️ 本 WP **没有**对真实库做任何数据处置（不修既有冲突记录 —— ADR-055 §3 第 4 条）。
```

---

## 7. 允许主张 / 不允许主张

```text
允许（有机器读数）：
  ✔ 「ADR-055 的 `D-55a`…`D-55g` 逐条落到了具名代码与具名判据里」——
    每条都有对应的 L1/门读数（见 §2）。
  ✔ 「记录状态行的五种情形**分别**渲染；默认句**不会**被自动升级；
    它走**独立额度**、**不会**挤掉记忆（两遍编译不变量由 L1 直接断言）」。
  ✔ 「守卫三态**可区分**：修复前的静默分支（`executed: undefined`）现在是一条
    具名的 `not_run`；缺报告会被计数报出来」。
  ✔ 「误触发负控从 5 条扩到 **12 条**（冻结集 · 6 类 × 2 · mutation 级）」。
  ✔ 「本 WP 的门读数全部 EXIT 0，`m4.5:ci` EXIT 0，`m5:gates` Hard Gates = PASS，
    `m6:verify --suite all` PASS」。

不允许：
  ✗ 「她不再编造了」——**没有跑过任何真实模型**，一套验收集都还没跑。
  ✗ 「R-8③ 已完成」——它的第二半（"目前没有有效替代值"）**未做**（§2②）。
  ✗ 「生产装配 ≡ 受测装配已在运行期验证」——读数器在了，**真实读数属 WP5/WP6**。
  ✗ 「守卫触发 = 产品失败」或「经过替换的合格回复 = 模型原始生成已改善」
    （ADR-055 §6.3 的两条边界）。
  ✗ 任何把 M5 两条判据的更新说成"放宽"或"判据错了"的表述 ——
    它是**设计变更的下游**，逐条登记在兼容性记录里。
```

---

## 8. 下一棒 WP5 的入口

```text
1. 用**真实测试模型**跑 WP5 §5 的合成多轮场景，装配用本 WP 落地的那一份
   （`src/main.ts` 本尊），**记录真实三读数**：
     召回/摘要 → 最终 packet 里实际进入的记录 / section（用 `memory_record_status` 的
                 `outcome` 与 `reason_code` 作为"编译之后"的现场）
     显式写入 → 结果 + 状态变化 + **取代链**（§4.2 的四条同时成立）
     动作     → 执行结果 + 账本 id
     回复守卫 → 逐道 `*_status` + 具名原因 + "最终回复对应哪个结果"
   ⇒ 把 `scripts/m6.1-assembly-runtime.ts` 的输入用**真实 trace**填上。
2. 修 R-8③ 的第二半需要一条**槽位全状态查询**（今天没有）⇒ 先裁定要不要加，
   不要用 `recordsInCanonicalSlot`（只回 active + disputed）冒充"完整查询"。
3. 两条 M5 判据已更新（兼容性记录），WP5 若再动 prompt 组成，**继续沿用**
   "差异只许来自具名程序事实"的口径。
4. 真人裁定缺口（本 WP 未索取、WP5 需要）：
     · 冻结的两轮正式运行**次数与检查点**（WP3 已给数字，WP5 落地时必须核对）
     · R-8③ 第二半要不要做（涉及新增查询面）
     · `M6.1-G8`（Break-Glass）与 M5.1 遗留项的处置
```

---

## 9. 复算方式

```bash
pnpm m6.1:wp4:closure           # ★ 本 WP 的出口门（只读 · 无时钟字段 ⇒ 逐字节可复算）
pnpm typecheck
pnpm m6.1:test                  # 判据层 L1：228 通过 / 0 失败
pnpm m4:nl-mutation:verify      # Layer C：38 通过 / 0 失败（12 条误触发负控）
pnpm m5:runtime:verify          # G6：28 通过 / 0 失败（M5 判据已更新）
pnpm m5:gates                   # M5 汇总：Hard Gates = PASS
pnpm m6:verify --suite all      # M6：28/28 PASS
pnpm m4.5:ci                    # 离线全链（约 12 分钟）
git status --porcelain -- src scripts docs   # 变动清单见 §4
```

---

## 10. 收口门：`pnpm m6.1:wp4:closure`（用户裁定「确认完成」之后新增）

用户的"确认完成"没有只写在散文里 —— 那与"没人核对过"在输出上长得一样
（WP3 的收口就是这个形状）。本轮新增 `scripts/m6.1-wp4-closure.ts`，
把 WP4 的**出口条件**逐条变成读数（只读 · 不碰数据库 · 无时钟字段）：

```text
① 交付物齐备   本文件（9 个必备小节）· ADR-055 状态修订（含 IMPLEMENTED）·
              M5 兼容性记录（M5-1/2/3 + "为什么不是放宽"）· 裁定日志 §20.1 / §20.2
② 实现标记     7 个具名文件的**字节级**标记（记录状态契约/构造器 · 守卫三态契约 ·
              运行期三读数与三类缺陷码 · 网关接线 · 误触发负控读冻结集 · M5 判据更新）
③ 门读数       L1 228/0 · 误触发 38/0 · M5 G6 28/0 · M5 G2 26/0 · `m5:gates` Hard Gates = PASS
              （逐条要求 failed = 0；"没测到"⇒ MEASUREMENT INVALID，不是 PASS）
④ 真实库边界   静态锁：WP4 触达的 7 个文件里**零个**"打开真实库"的引用；
              树摘要 `c49ac7f7c22fcdeb… / 1207 文件` 只作**读数**（不作通过条件 ——
              它会随用户正常使用而变化，这条教训 M5.1 的 production-copy 门已经吃过）
⑤ 如实登记     R-8③ 的**第二半未做**必须在交付物里写明（抹掉它 ⇒ 门红）
```

三段式自证（**六个**负控，各自必须因**预期原因**报红）：抽掉交付物 · 删掉必备小节 ·
门读数注入失败 · L1 读数归零（⇒ `MEASUREMENT INVALID`，不是 FAIL 更不是 PASS）·
往实现文件里注入"打开真实库"· 抹掉"第二半未做"。**恢复 ⇒ 重新 PASS。**
读数：`artifacts/m6.1/wp4-closure.json`（`verdict = PASS`，两次运行逐字节相同）。

⚠️ 本门在证据里显式写了 `notProvenByThisGate` 四项：
"她不再编造了" · 运行期三读数的**真实**读数 · R-8③ 第二半 · 根因结论对不对 ——
**一个都不许拿本门冒充**。
