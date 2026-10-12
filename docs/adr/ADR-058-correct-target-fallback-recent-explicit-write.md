# ADR-058 — correct 的**目标层兜底**：会话内最近一次显式写入（B① / SRP-C-04 / SRP-C-09）

状态：**ACCEPTED / IMPLEMENTED**（用户 2026-09-25 裁定 **R1**：「我决定是 R1」——
按 R 设计实施确定性兜底 + 守卫 + 新增误伤负控，残余风险如实登记）。
⚠️ 与 ADR-055/056/057 同一条纪律：**本文件正文不再改写**；后续若要再动这条路径，**新开 ADR**。

日期：2026-09-25。归属：**M6.1 / WP5**（B① 问题组的**范围内**修复）。
上游裁定：[`evals/m6.1/acceptance/ADJUDICATION-LOG.md`](../../evals/m6.1/acceptance/ADJUDICATION-LOG.md) §19.2
（「修，但限定范围」：只改**已识别为显式更正、且目标槽位可确定**的路径；守住误触发负控；
**不得**把「换成」「转到」无条件变成全局记忆指令；冻结区 ⇒ 另立 ADR + 跑 M4 门）。
触发它的读数：[`WP5-Handoff.md`](../m6.1/WP5-Handoff.md) §5.5 的具名问题组 +
服务层复现器（`pnpm m6.1:update-turn:service-repro`，`artifacts/m6.1/update-turn-service-repro.json`）。

---

## 0. 归因更正（本 ADR 的前提，必须先说清）

先前把 SRP-C-04 / SRP-C-09 描述为「更新轮未抽出（value=null）」——**归因不准**。
服务层复现（隔离库，与生产接线逐字一致）证明失败发生在**更早一步**：

```text
explicit-service.ts 的 correct()：
  const resolved = await resolveFor(deps, request)   // ① 先解析目标
  if (resolved.status !== 'resolved' || !mayMutate(resolved)) {
    return targetFailure(...)                         // ② 失败直接返回 ⇒ ③ 抽取器根本没被调用
  }

复现读数（服务层 · 隔离库）：
  miss-major  「更正一下，我转到历史学了。」  意图=correct ⇒ 失败(target_not_found) · 新值落库=false
  miss-device 「更正一下，我换成 Mac 了。」    意图=correct ⇒ 失败(target_not_found) · 新值落库=false
  ctl-major   「更正一下，我的专业是历史学。」 ⇒ ok · active:历史学 / superseded:汉语言文学
  ctl-device  「更正一下，我平时用的是 Mac。」  ⇒ ok · active:Mac / superseded:Windows 笔记本
```

机制：`target-resolver.ts` 第 3 步的相关性闸是**词面存在性**判定
（`lexicalOverlapHits`），而「转到历史学了 / 换成 Mac 了」与库里那条
（汉语言文学 / Windows 笔记本）**零词面重叠** ⇒ `not_found` ⇒ 短路返回。
「更新轮未抽出」描述的是**第二道缺口**（只有目标解析成功后才会到达），
本次修复必须**先修目标层**，光修抽取器不够。
正控两条之所以成功，是因为它们点名了槽位线索（「专业」/「用的是」）⇒ 相关性命中。

---

## 1. 决定（R 设计，用户裁定 R1）

| # | 决定 | 落点 |
|---|---|---|
| **D-58a** | **兜底只在 `intent=correct` 生效**，且**只在正常解析失败（`not_found`）时尝试**。`ambiguous`（词面已命中多条）**不走兜底**：那时"用户的话指向多条"，用近因去挑一条正是 INV-M41-02 禁止的"猜着改"。`forget` / `dispute` / `remember` 一律不经过这条路径 | `explicit-service.ts` `correct()` |
| **D-58b** | **选靶规则（确定性）**：取"与触发事件**同一会话**（`conversation_events.conversation_id` 相同）内、该用户经**显式路径**写入（`processor='explicit-memory'`）的 ACTIVE 记录"。**≥2 个不同槽位（canonicalKey）⇒ 拒绝（`target_ambiguous`）**，维持诚实失败；恰好 1 个槽位 ⇒ 取该槽位**最近**的一条作目标；0 条 ⇒ 维持今天的 `target_not_found` | `correction-fallback.ts` `pickRecentExplicitWriteTarget()` + `memory-store.ts` `listRecentExplicitWrites()` |
| **D-58c** | **槽位限定的取值（不经过全局抽取器）**：认转换标记 **「换成 / 转到 / 改成 / 改为」**（闭集，本 ADR 冻结；扩充 = 新 ADR），取**同小句**内标记之后的短语，剥句末语气词（了/啦/咯）与标点。**不把这几个词形加进 `content-extractor.ts` 的任何全局线索表** ⇒ 抽取器层那条 ★负控（「换成/转到」修好后仍应抽不出）继续成立 | `correction-fallback.ts` `extractCorrectionValue()` |
| **D-58d** | **取值守卫（全部确定性，失败方向安全）**：① 非空；② ≤60 字（与抽取器同界）；③ **不得以指代/量词开头**（这/那/另/同/几/一/某/每/个/各/本/其——闭集）；④ **把字句守卫**：「把X<标记>」且 X 与目标记录**词面相关**（复用 `lexicalOverlapHits`，与解析器第 3 步**同一实现**、`includeRegistrySurfaceForms: true`）才接受——「我把闹钟换成七点了」的「闹钟」与 device.primary 无关 ⇒ 拒绝。任一守卫不过 ⇒ **不猜、不写**，维持今天的 `target_not_found` | 同上 |
| **D-58e** | **两者同时成立才用**（目标可确定 ∧ 值可抽出且过守卫）⇒ 走与 correct 主路径**同一**的变更序列：先建新条（同 type / 同 predicate / 新值 / `EXPLICIT_USER_STATEMENT` / confidence 0.7）→ 再 supersede 旧条。**兜底抽不出值时绝不 RETRACT**（区别于主路径的"抽不出 ⇒ 撤旧条"语义：兜底的前提本来就是"我们连目标都是推断出来的"，此时撤旧条比不写危险得多） | `explicit-service.ts`（主路径与兜底共用同一个 `supersedeWithReplacement()` 助手 ⇒ 顺序、payload、失败回报逐字同形） |
| **D-58f** | **端口可选、缺省不注入**（与 D-55b 的 `conflict` 同一形状）：`ExplicitMemoryServiceDeps.recentExplicitWrites?` 缺省 `undefined` ⇒ 行为与今天**逐字相同**，不需要数据迁移；生产（`main.ts buildMemoryWriter`）与复现器**接同一个** `listRecentExplicitWrites(db, …)` ⇒ 复现与生产接线逐字一致 | `explicit-service.ts` / `memory-store.ts` / `main.ts` / 复现器 |
| **D-58g** | **版本**：新增 `CORRECTION_FALLBACK_VERSION = 'correction-fallback@1'`，写进抽取结果的 `basis`（可审计）。**不改** `processorVersion`（落库仍记 `explicit-memory@1`，与 D-56f 同一条理由） | `correction-fallback.ts` |
| **D-58h** | **判据**：复现器升级为修复验证器——冻结两条应翻成「新值 active ∧ 旧值 superseded」（verdict `FIXED`）；正控两条不变绿则读数不可用；**新增 4 条误伤负控**（见 §3）；恢复段保留。L1 新增纯函数回归锁（`kernel-tests-memory.ts`） | `scripts/m6.1-update-turn-service-repro.ts` / `scripts/kernel-tests-memory.ts` |
| **D-58i** | **冻结区纪律**：本改动落在 `src/kernel/app/memory/**` ⇒ 本 ADR + 全套 `m4:*`（`m4:test` / `m4:verify` / `m4:mutation-safety:verify` / `m4:nl-mutation:verify` / `eval:m4`），读数见 §4 | §4 |

### 1.1 与 Mutation Gate（INV-M41-02）的关系——为什么这条路径不经过 `mayMutate`

`mayMutate` 是"**用户的话指向某条**"这类路径的闸（exact/strong = 有词面/结构证据）。
本兜底的前提恰恰是"用户的话**不指向任何一条**（零词面命中）"——按
`target-resolver.ts` 里 `MutationConfidence` 的契约原文（"将来任何新增的模糊路径必须
**先声明自己的置信度**，而不是悄悄把 resolved 当成可以改"），它的目标证据是
**weak 级**的（近因推断，不是词面证据）。因此它**不冒充** strong、也**不放宽**
`mayMutate`（那会波及所有 destructive 路径），而是作为 **correct 专用的、有自己更严
闸门**的例外路径存在，其闸门为：

```text
① intent 必须是 correct（forget/dispute/remember 不经过）；
② 正常解析必须已经诚实失败（not_found；ambiguous 不兜底）；
③ 会话内显式写入必须恰好覆盖 1 个槽位（≥2 ⇒ target_ambiguous；0 ⇒ not_found）；
④ 更正句必须含转换标记，且对**那一个槽位**抽出过守卫的值；
⑤ 任一环不成立 ⇒ 什么都不做（不猜、不写、不撤）。
```

失败方向安全（宁可漏，不可错）；成功方向上走的放行口、幂等、事件、投影与主路径
**完全相同**（`runMutation` 是唯一写入路径，本 ADR 没有新增任何绕过它的写法）。

## 2. 落点（逐文件）

```text
src/kernel/app/memory/correction-fallback.ts   新增（纯函数：选靶 + 槽位限定取值 + 守卫 + 版本常量）
src/kernel/app/memory/explicit-service.ts      · deps 追加可选 recentExplicitWrites（契约见注释）
                                               · correct() 在 not_found 时尝试兜底
                                               · 主路径/兜底共用 supersedeWithReplacement()（行为逐字保持）
src/infrastructure/persistence/memory-store.ts · 追加只读查询 listRecentExplicitWrites(db, input)
                                                 （同会话 · processor='explicit-memory' · ACTIVE · 降序；
                                                  reducer 语义一个字未动）
src/main.ts                                    · buildMemoryWriter 接线生产端口（一行）
scripts/m6.1-update-turn-service-repro.ts      · 接线同一端口；+4 条误伤负控；冻结两条翻绿判据
scripts/kernel-tests-memory.ts                 · +L1 回归锁（纯函数正负控）
```

## 3. 误伤负控（新增 4 条，全部带前置写入 —— 守卫真正被考验的形状）

```text
neg-song-prior    前置 device.primary=Windows 笔记本 ·「更正一下，我把这首歌换成另一首了。」
                  ⇒ 把字句守卫（「这首歌」与 device 无词面相关）+ 指代前缀「另」双保险 ⇒ 不写
neg-alarm-prior   前置 device.primary ·「更正一下，我把闹钟换成七点了。」
                  ⇒ 把字句守卫（「闹钟」无关）⇒ 不写（「七点」本身过前缀守卫，全靠这条）
neg-referential   前置 device.primary ·「更正一下，我换成这台了。」
                  ⇒ 指代前缀「这」⇒ 不写
neg-ambiguous     前置 major + device 两条 ·「更正一下，我换成 Mac 了。」
                  ⇒ 会话内显式写入覆盖 2 个槽位 ⇒ target_ambiguous ⇒ 不写（D-58b 的①）
既有 3 条无前置负控照旧（无前置 ⇒ 0 候选 ⇒ not_found）。
```

## 4. 证据（修后读数；修前基线 = `artifacts/m6.1/update-turn-service-repro.json` 的 MISS_REPRODUCED 版本，已被本轮覆盖，修前读数见 §0 与交接单 §5.5）

```text
pnpm m6.1:update-turn:service-repro   ⇒ verdict = FIXED（exit 0）
     冻结两条：miss-major / miss-device 均为 新值 active ∧ 旧值 superseded
     （active:历史学 / Mac · superseded:汉语言文学 / Windows 笔记本）
     正控 2/2 · 负控 7/7（含新增 4 条：neg-song-prior / neg-alarm-prior /
     neg-referential-prior ⇒ target_not_found · neg-ambiguous-mixed ⇒ target_ambiguous）
     · 恢复 PASS · 真实库树摘要未变 · schemaVersion 升至 update-turn-service-repro@2
pnpm m6.1:update-turn:repro           ⇒ 抽取器层 ★负控照旧绿：verdict = MISS_REPRODUCED
     （「换成/转到」仍抽不出 —— D-58c；正控 2/2 · 负控 4/4 · 恢复 PASS）
全套门（2026-09-25，本 ADR 落地后逐门实跑）：
     pnpm typecheck                     ⇒ EXIT 0
     pnpm m4:test                       ⇒ 256 通过 / 0 失败（+8 条新锁：兜底纯函数 7 + 生产接线 1）
     pnpm m4:verify                     ⇒ 142 通过 / 0 失败
     pnpm m4:mutation-safety:verify     ⇒ 20 通过 / 0 失败（D1 系 target_not_found 诚实失败全部原样）
     pnpm m4:nl-mutation:verify         ⇒ 38 通过 / 0 失败（12 条冻结误触发负控零变化）
     pnpm eval:m4                       ⇒ 17 通过 / 0 失败
     pnpm kernel:test                   ⇒ 26 通过 / 0 失败（依赖方向：correction-fallback.ts 只 import kernel 内模块）
     pnpm m6.1:test                     ⇒ 263 通过 / 0 失败
     pnpm m6.1:e2e:verify               ⇒ 20 通过 / 0 失败（PASS）
     pnpm m6.1:measurement:verify       ⇒ 16 通过 / 0 失败（PASS）
```

## 5. 残余风险（用户在裁定 R1 时已知情，如实登记）

```text
R-a  把字句守卫只覆盖「把X<标记>」这一种句形。「我换成七点了」（无把字、无对象、值具体）
     在"会话内唯一显式写入恰好是 device.primary"的场景下仍会被写成 device.primary=「七点」。
     判定"这句话在说哪个槽位"本质上是语义判断，而按既有裁定（ADR-055 §4 / 19.2）模型抽取
     路径是关着的 —— 本 ADR 用确定性守卫把误伤面收窄到这一类，**不主张**它为零。
R-b  近因选靶在"会话很长且只显式写过 1 个槽位"时，会把一句与该槽位无关的「换成 X 了」
     写进那个槽位（同 R-a 的根因）。会话边界（conversation_id）+ 单槽位约束 + 转换标记
     是三层收窄，不是消除。
R-c  重复更正的交互：兜底写成新值后，同一句更正**再说一次**会走主路径——新值与句子有词面
     重叠 ⇒ 解析成功 ⇒ 全局抽取器仍抽不出（线索词未命中，D-56e 的独立问题组）⇒ 按主路径
     既有语义 RETRACT（"那条是错的"）。即"重复一次 = 撤掉"。这是 correct 主路径的**既有**
     双语义（能抽出 ⇒ SUPERSEDE；抽不出 ⇒ RETRACT），不是本 ADR 引入的分支，但兜底让系统
     能第一次到达那个状态。登记在此，不动主路径语义（那超出 19.2 的范围）。
R-d  「改成/改为」与把字句守卫的组合未在冻结条文里出现，只有 L1 锁覆盖
     （`kernel-tests-memory.ts` "取值守卫④"：`我把 Windows 换成 Mac 了` ⇒ 接受；
      `我把电脑改成 Mac 了` ⇒ 拒绝 —— 「电脑」不在 device.primary 的登记表说法里，
      这是**漏而不误**：她如实说没找到，好过把值写错槽位。登记表说法的覆盖面
      决定这一类的召回率，扩它属于登记表维护，不在本 ADR 范围）。
```

## 6. 本次**不做**（边界）

```text
✗ 不把「换成/转到/改成/改为」加进 content-extractor.ts 的任何全局线索表（19.2 逐字禁止；
   抽取器层 ★负控继续守着）。
✗ 不动 forget / dispute / remember 的任何路径；不动 correct 主路径的解析梯子与 RETRACT 语义。
✗ 不动 mayMutate / MutationConfidence 的既有语义（见 §1.1 —— 分列，不合并）。
✗ 不做"标记未命中 ⇒ 问模型"的兜底（模型抽取路径按既有裁定关着）。
✗ 不改任何冻结条文（evals/m6.1/control/**）。
✗ 不用本 ADR 主张"WP5 可以过"或"B① 组在 live 轮已翻绿"：离线复现 FIXED 只证明这两条
   工况在服务层落新值；WP5 的判定要按 19.5 的收敛顺序，由新候选从 round 1 重跑得出。
```

## 7. 这份 ADR 不主张什么

```text
· 不主张"更正的目标解析从此总能确定"——兜底只覆盖"会话内恰好 1 个显式写入槽位"这一窄面。
· 不主张残余风险为零（§5 如实登记；确定性守卫收窄面，不消除面）。
· 不主张 12 条 live 误触发负控已复验——它们属于 WP5 的 live 轮，按 19.5 等部署档跑完后
  与其余失败一起收敛；离线层由复现器的 7 条负控（含新增 4 条）守住。
· 不主张量具/判定器任何性质。
```
