# S8 消费入口缺口立案（Consumption Entry Gap）

状态：**`OPEN`（未修，需设计裁定）**。工作包：`POSTLV2-S8`。日期：**2026-10-04**。编号：**`L-S8-30`**。

载体：本文件即立案记录。相关：[S8 激活记录](S8-Activation-Record.md) · [S8 已知局限](S8-Known-Limitations.md) ·
[S8 门判定](S8-Gate-Decision.md) · [ADR-094](../adr/ADR-094-s8-story-cognition-production-activation.md)。

> ⚠️ 本文件**只登记事实与归因**，**不**声称做了任何修复，也**不**回写任何历史读数（`TD-16`）。

---

## C1 · 事实：生产里**没有任何调用者**调用 `ingestChoice`

ADR-094 `D02` 要求一条生产入口：由**用户选择**驱动、经放行口提交、写进 `storyline_commits`。
接口与实现**都已存在**：

```text
StoryCognition.ingestChoice   接口   src/infrastructure/runtime/story-cognition.ts:71-74
StoryCognition.ingestChoice   实现   src/infrastructure/runtime/story-cognition.ts:239-247
```

但在**全仓**范围内，`ingestChoice` 只出现这**两处**：

```text
$ grep -rn "ingestChoice" .
src/infrastructure/runtime/story-cognition.ts:71   （接口声明）
src/infrastructure/runtime/story-cognition.ts:239  （实现）
```

`src/main.ts` 只 import 了 `createStoryCognition`（`src/main.ts:135`）并调用 `consumeOnce()`
（`src/main.ts:1991-2002`）——**从不**调用 `ingestChoice`。

⇒ 连锁事实：

```text
① `ingestChoice` 没有生产调用者 ⇒ 没有生产路径会写入 STORY_* 提交
② ADR-094 `D02.2④` 要求的 `proposalType='story-choice'` 提案通道在 `src/**` **不存在**：
   `grep -rn "story-choice" src` ⇒ **零命中**
③ ⇒ `storyline_commits` 在生产里**永远 0 行**
④ ⇒ 消费回路每次 `open()` 都读到"无可消费项"（`ledger.listRuns(storyId)` 为空 ⇒
   `{ progress: [], drained: true }`，见 `src/infrastructure/runtime/story-cognition.ts:255-258`）
```

## C1.1 · 归因更正（**不改那一行**）

[S8 激活记录](S8-Activation-Record.md) `:47` 把"三张 S8 表各 0 行"解释为
**"只接 affect + 首个真实对话轮未发生"**（原句：`⇒ 与"只接 affect + 首个真实对话轮未发生"一致`）。

⚠️ **这个归因不准**：三张表为 0 的**真因**是 **`ingestChoice` 在 `src/**` 没有调用者** ——
不是"对话轮还没发生"。即便发生了真实对话轮，只要没有代码把用户选择交给 `ingestChoice`，
`storyline_commits` 仍然是 0 行。

> 按 `TD-16`，`S8-Activation-Record.md:47` **原文一字不改**；更正只登记在本文件。

## C1.2 · 假绿的机制：消费锁锁住了消费，**没锁住"有东西可被消费"**

`D01` 的消费锁在 `scripts/kernel-tests-memory.ts:3499-3512`：

```ts
const main = readFileSync('src/main.ts', 'utf8')
expect.equal(
  /storyCognitionEnabled/.test(main) && /consumeOnce/.test(main),
  true,
  'src/main.ts 必须既读 storyCognitionEnabled 又调 consumeOnce：只加开关不消费 = NOT-WIRED 惰性开关'
)
```

⇒ 它断言的是 `src/main.ts` 的**文本**里同时出现 `storyCognitionEnabled` 与 `consumeOnce`
两个**字符串**。**入口没有调用者时它照样绿** —— 因为它从不检查"账本里有没有可消费的行"。

这正是 `ADR-094` 约 `:278` 警告的"把锁变成假绿"的**另一种形态**：

> 原文（`ADR-094:276-278`）：*先挂锁再声称已消费 = 把锁变成假绿 —— 这正是 `CHARACTER_MEMORY_BACKGROUND_ENABLED` 的教训。*

本条的形态是：**锁住了消费（`consumeOnce` 被调用），没锁住"有东西可被消费"（`ingestChoice` 有调用者）**。
两件事在读数上长得几乎一样 —— 消费回路"跑到底、无报错、水位停在 0"
与"没有任何提交"在输出上无法区分。

## C2 · 事实（**待裁定口径**）：消费是"每次会话打开一次"，不是每轮

`consumeOnce` 在 `src/main.ts` 只有**一处**调用：

```text
src/main.ts:2002   const consumed = await cognition.consumeOnce()
```

它位于 `async open()`（`src/main.ts:1794`）内 ⇒ **每次会话打开 `open()` 时跑一次消费回路**，
而不是**每一个对话轮**都跑。

⚠️ 与 `ADR-094` `D03` 的口径**不一致**：`D03` 说的是"提交后由既有调度器消费"。
⚠️ **未能确证**是否在别处（如调度器 / `turn-gateway` / 后台任务）另有补扫 ——
本文件**不**断言"别处没有"。

## C3 · 处置

| 项 | 内容 |
|---|---|
| 归属 | 属 `ADR-094` `D02` 的**剩余部分**（提案通道 `story-choice` + 服务端 run 生命周期），并牵动 `D03` 的调度口径（见 C2） |
| 量级 | **不是小改动** —— 需要一次设计裁定（谁产出选择、提案怎么写进放行口、调度频率）与**新授权** |
| 本文件**不**声称 | 本文件**不**声称做了、或将要做什么修复 |

## C4 · 边界（本条**不**主张什么）

- 本条**只**主张两件事：**① 入口无生产调用者** · **② 消费锁测不到这件事**。
- 本条**不**主张"生产里永远不会消费"以外的任何结论 —— 例如**不**主张消费回路本身有缺陷
  （它在隔离库里由 `postlv2:s8:production:verify` 验过，见 `S8-Activation-Record.md` §7 的 `L-S8-12`/`L-S8-29` 行）。
- 本条**不**主张"首个真实对话轮发生之后就会好" —— 恰恰相反，那是 C1.1 更正的归因。
- 本条**不**回写 `S8-Activation-Record.md:47`、`ADR-094` 的任何原文读数。

---

## ⏩ 2026-10-07 修订：C1 / C2 的**事实基础已被取代**（只追加，上文一字不改）

本次全项目审计（[docs/audit/2026-10-07-full-project-audit.md](../audit/2026-10-07-full-project-audit.md) §6-⑤）在**当前源码**上核到：

| 上文 | 现在的事实 | 证据 |
|---|---|---|
| C1「`ingestChoice` 没有生产调用者 ⇒ 没有生产路径会写入 `STORY_*` 提交」 | **已有生产入口**：开局 `src/main.ts:7316` → `runStoryStartCommand`；同轮选择 `src/main.ts:3775-3778` → `resolveDailyTurn`（ADR-115）/ `resolveChoiceTurn`（ADR-107）→ `runStoryDailyTurn` / `runStoryChoiceTurn` → `commitStoryTurn` | `src/kernel/app/storyline/choice-turn.ts:31` · `daily-turn.ts:114` · `src/main.ts:152,7316,3775-3778` |
| C1③「`storyline_commits` 在生产里**永远 0 行**」 | **已不成立**（隔离库实测）：`pnpm postlv2:s8:daily:e2e` 断言账本**恰好 3 行**（`STORY_STARTED` + 2×`CHOICE_COMMITTED`，choice `ask_scope` / `go_prepare`），三个消费者水位 = 提交数 | `artifacts/post-lv2/s8-daily-e2e-20261007070734382/result.json`（`status: PASS`，`live:false`）|
| C2「消费是每次会话打开一次，不是每轮」 | **每轮尾扫已存在**：`consumeOnce()` 在 `src/main.ts:5008`（轮尾 fire-and-forget）+ `open()` 补扫 | `src/main.ts:1188`（注释）· `:4994` · `:5008` |

**仍然成立、且**未修**的那半**：C1.2 的**假绿机制** —— `scripts/kernel-tests-memory.ts:3515` 至今仍是
`/storyCognitionEnabled/.test(main) && /consumeOnce/.test(main)` 这条**文本断言**，
它**不**检查"账本里有没有可消费的行"。

⇒ 结论：**入口缺口的"事实基础"已被 `ADR-107` / `ADR-115` 取代；"量具测不到它"这条缺陷仍然开放。**

⚠️ **本文件不自行销账**：`L-S8-30` 的处置（销账，或改判为"仅量具缺陷"）应由维护线按
① 一条 `storyline_commits > 0` 的**真实库**读数，或 ② 明确接受 e2e 读数作为等价证据 —— 二者都需要一次**裁定**。
按 `TD-16`，本文件 §C1–C4 的原文与 `S8-Activation-Record.md:47`、`ADR-094` 的原文**一字不改**。

## ⏩ 2026-10-07 维护修订：量具残余已补行为判据

用户授权修复后，按已裁定 ADR-107 `R-4c` 补齐：旧 D01 文本断言改为 AST 装配检查，明确不再声称「真的消费」；既有 `postlv2:s8:daily:e2e` 新增真实主入口正控、临时副本摘除入口、临时副本摘除消费、恢复四档。每档两次进程启动与五轮协议对话，判据直接读取提交和三个消费者水位。入口缺席时零提交必须失败，消费缺席时有提交却无水位必须失败，恢复后重新通过。

**当前残余处置：量具缺陷 RESOLVED（工程验收范围）**。这取代上一修订「量具测不到它仍开放」的当前读数；旧锁假绿复现、原入口缺口与历次状态均保留。自然生产首次使用仍为 NOT OBSERVED，不据隔离库读数声称真实库已产生故事经历。本节修订量具残余，不把生产首用或长期人格收益合并成同一个销账结论。

判据变更的 OLD / NEW / WHY / PRESERVED、负控和完整回归证据见 [消费锁量具修复记录](S8-Consumption-Lock-Repair-2026-10-07.md)。
