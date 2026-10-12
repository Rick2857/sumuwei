# M10 `U-20` 交接单 —— 目标域注册进 `TurnGateway`

- 日期：2026-09-29
- 工作包：`U-20`（WP8/WP9 期间一直悬着的那一条）
- 状态：**COMPLETE** —— 门 `m10:gateway:verify` = **PASS 12/12**
- 依据：ADR-076 §6 · AGENTS.md §6（trace 与隐私边界）· 镜像 M9 的 `buildBeliefSection` 形状
- 前置：[`M10-WP9-Handoff.md`](M10-WP9-Handoff.md)

---

## 1. 为什么它必须单独做一轮

在 WP8/WP9 期间，`turn-gateway.ts` 里 **`goal` 出现 0 次** ——
换句话说：**编排写好了、门全绿了，而生产轮次根本不会调用目标域**。
那是"实现完成"与"接线完成"之间典型的一道缝，而它最容易被"门都绿了"掩盖。

⚠️ **本轮的完成不主张任何语义质量**：它证明的是**接线对了**，
不是"她在真实对话里理解得对"（那是 WP10）。

## 2. 交付

| 交付物 | 位置 | 作用 |
|---|---|---|
| 网关端口 | [`src/kernel/app/turn-gateway.ts`](../../src/kernel/app/turn-gateway.ts) | 编译输入新增可选 `runGoalTurn?`；两条 section 挂进 `extraProviders`；五个 trace 读数转发 |
| 门 | [`scripts/m10-gateway-verify.ts`](../../scripts/m10-gateway-verify.ts) → `pnpm m10:gateway:verify` | 12 项（O 关闭档 · S section · T trace）；**隔离库 + 真实网关** |
| 门清单 | [`scripts/gates/manifest.ts`](../../scripts/gates/manifest.ts) | `M10_GATES` 现 **13 道**；lane 实测 13 道 PASS 13 / 70.6s |

### 2.1 设计：为什么是一个**端口**，而不是让网关自己去跑

目标域的一轮要走：资格 → 读候选（走遮蔽）→ 语义理解（要模型）→ 严格校验 →
放行口 → 兑现判定 → 写。**其中一半是基础设施的事**，而那条链**已经有唯一的实现**
（`app/goal/turn.ts` 的 `runGoalTurn`）。

⇒ 网关是 `kernel/app/` 里**唯一**允许碰基础设施的层，但它**不该**再拼一条链。
因此这里是一个端口：装配层把 `runGoalTurn` 连同四个端口接好，
网关只负责**在对的时机调它**、**挂它给的两条 section**、**转发五个 trace 读数**。

### 2.2 三条硬性质（都由门钉住）

```text
① 不接端口 ⇒ 零变化
   不调用、不挂 section、trace 不变长 ⇒ prompt 与"根本没这功能"逐字节相同（门 O1/O2）
② 不阻断回复
   端口抛错 ⇒ 如实记 port_threw，**编译照常**（门 T4/T5）——与 buildBeliefSection 同一条纪律
③ 属性纪律
   转发进 trace 的只有**操作名 / 具名码 / 计数 / id**；门 T2 把整条 trace 序列化后
   搜目标正文 ⇒ **0 命中**（"我记得别写"不是判据）
```

### 2.3 两条 section 的额度是**两回事**（门 S1–S4）

```text
事实块  kind='instruction'  priority=currentInput-3 (97)  droppable=false
        **有操作就挂**，与额度无关 —— 它是"程序对本轮做了什么"的答案，
        被裁掉就等于她可以随便说
状态块  kind='goals'          priority=45                  droppable=true
        走 `ContextBudget.goalTokens`，缺省 **0** ⇒ **根本不挂**（`D27`）
```

---

## 3. 本轮抓到的**三处问题**（都在我自己身上）

### 3.1 `compileTurn` 单独调用时 `getTrace` 是 `undefined`

第一版只调 `compileTurn` ⇒ trace 行根本不存在（它是 `beginTurn` 建的）⇒
门在 `kindsOf` 里**崩**而不是报。

⚠️ **"门会崩而不是报"这条教训这是第三次出现**（WP8a 一次、WP9b 一次）——
但这一次它抓的**不是量具写错，而是我对调用序的假设错了**。
⇒ 修法：走**真实的两步**（`beginTurn` → `compileTurn` → `completeTurn`），
并且**每轮都走完**（`beginTurn` 开了会话序号却不走完会留**序号空洞**，
`m5.5-harness.ts` 文件头记过这条坑）。

### 3.2 端口抛错时只有第一步记 `port_threw`，后四步落成 `absent`

门 `T4` 抓到。**这不是小事**：`absent` 是一个**结论**（"确实没有提案/校验/写入"），
而抛错是**读不到结论** —— 两者混起来，"端口挂了"会被读成"这一轮什么都没发生"。
⇒ 现在**五步全部**记 `port_threw`。

### 3.3 门在判定之后**不退出**（挂死）

失败路径只设了 `process.exitCode` ⇒ elizaOS 运行时的上游定时器让进程**永不退出**
（stdout 全空、CPU 近 0、看起来像"还在跑"）。这正是 WP2 记过的坑，
**第三次出现**。⇒ 显式 `process.exit(failed === 0 ? 0 : 1)`。

---

## 4. 相关回归（**含共享文件**）

`turn-gateway.ts` 是**prompt 组装的核心**，因此本轮跑了它全部的下游门：

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| **`pnpm m3.5:test`** | **30/0**，含 `FC-T08`「Prompt 与 M3 逐字节一致」⇒ **关闭档的既有锚点仍然成立** |
| `pnpm kernel:test` / `kernel:verify` | 26/0 · 25/0 |
| `pnpm m4:test` / `m4.5:test` | 258/0 · 135/0 |
| `pnpm m5.1:observability:verify` | **27/0**（含 `AT4.5 LEAKAGE = 0`） |
| `pnpm gates:run --lane m10` | **13 道 · PASS 13 · FAIL 0** |
| `pnpm gates:verify` / `pnpm fast:offline` | 48 项 0 失败 · 34/34 |
| 真实库 | **从未被打开** |

---

## 5. 具名限制（交给 WP11）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-46` | 门验的是**上下文与 trace 的接入**，**不**跑 `completeTurn` 生成回复 | 生成回复要真模型 ⇒ 属 WP10。本轮全部主张都止于"编译与 trace 对了" |
| `L-M10-47` | `goalTokenQuantifier` 用**字符数 / 2**（与编译器缺省同公式），不是真 tokenizer | 与 M5/M6 的既有做法一致；"估算的就是注入的"仍成立（同一份文本上算）。真 tokenizer 属独立议题 |
| `L-M10-48` | 装配层**还没有**把 `runGoalTurn` 接到 `main.ts` | 本轮做的是**网关侧**的端口与转发；把端口接上生产装配是**激活**的一部分（WP12），也是 `U-01`/`U-12` 的同一批工作 |
| `L-M10-49` | 五个 trace 读数**只**在端口被接上时转发 | 这正是"关闭档 trace 不变长"的机制；代价是"开关关着"与"本轮没目标操作"在 trace 上**只能靠 `outcome` 区分**，不能靠"有没有这五步"区分 |

---

## 6. 下一步

**WP10（真模型评测与真人复核）** 仍是主线，且有一条**用户侧前置**：
[`M10-Corpus-Review-Packet.md`](M10-Corpus-Review-Packet.md) 的九条金标判据待你过目
（`U-15`，我无法自己补）。
`U-22`（清单↔`package.json` 常设交叉检查）仍开放；本轮手工自检 `gates=13 missing=[]`。
