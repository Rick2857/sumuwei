# M10 WP2 交接单

- 日期：2026-09-29
- 工作包：WP2（真实来源引用与只读输入）
- 状态：**COMPLETE** —— 门 `m10:inputs:verify` = **PASS 25/25**
- 依据：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) `D25` / §4.6 · [契约](M10-Acceptance-Contract.md) §3 的 `G17`–`G24`
- 前置：[`M10-WP1-Handoff.md`](M10-WP1-Handoff.md) §2（本步就是它列出的八条要求）
- 本轮**没有**：打开真实库 · 调模型 · 出网 · 改任何历史文档或证据

---

## 1. 交付了什么

| 交付物 | 位置 | 作用 |
|---|---|---|
| 引用契约 | [`src/kernel/contracts/goal-reference.ts`](../../src/kernel/contracts/goal-reference.ts) | `MemoryReference` / `BeliefReference` · 8 条拒绝原因闭集 + **可达性事实表** · 三态可用性（hard/soft/unusable）· 档位纯函数 |
| 输入端口与编排 | [`src/kernel/app/goal/inputs.ts`](../../src/kernel/app/goal/inputs.ts) | 批量端口形状 · `captureMemoryReference` / `captureBeliefReference`（取**真实**版本）· `recheckGoalDependencies`（批量去重 + 失败关闭）· `applyGoalInvalidationOverlay`（同轮遮蔽，纯函数） |
| 只读适配器 | [`src/infrastructure/persistence/goal-input-store.ts`](../../src/infrastructure/persistence/goal-input-store.ts) | Memory 走 `MemoryStorePort.get`（**唯一**行映射）· Belief 走 `getBelief`（**投影行**版本）· 撤销集走既有 `computeWithdrawnEvidence`（原样复用）· `createGoalInputPorts` 单入口 + 构造期一致性检查 |
| 引用复核门 | [`scripts/m10-inputs-verify.ts`](../../scripts/m10-inputs-verify.ts) → `pnpm m10:inputs:verify` | 25 项检查（静态 5 + Memory 侧 12 + Belief 侧 7 + fixture 1） |
| 证据 | `artifacts/m10/m10-wp2-inputs-20260929-bd895b2d769e-f8b2/`（**权威读数**：head = WP2 代码提交） | `inputs-verify.json` + `m10-manifest@1` |
| 改动面映射 | [`scripts/gates/affected-map.ts`](../../scripts/gates/affected-map.ts) | 新增 M10 行（见 `U-08`：`m10:test` 待 WP3 追加） |

**WP0 的两个缺口逐条补上**：

```text
缺口 ①  `sourceRevision` 固定为 1
        → captureMemoryReference 从**当前记录**读真实 revision（I1=1 / I2=2）
        → 静态反向判据 S5：goal 模块里不存在 `sourceRevision: 1`
缺口 ②  "复核"只是消费者传入的回调
        → recheckGoalDependencies 自己批量回查 + 比版本 + 查撤销集（I3/I13）
        → 静态判据 S1：fixture 仍无写入能力依赖；I18：fixture 的固定值**一字未改**
```

---

## 2. 三条在实现里定形的东西（WP1 冻结了语义，这里冻结了形状）

### 2.1 可用性是**三态**，不是一个布尔

```ts
type ReferenceUsability =
  | { usable: true;  as: 'hard' }   // 可作**必要前提**
  | { usable: true;  as: 'soft' }   // 只可作**可选规划背景**（带标签）
  | { usable: false; reason }       // 不可用（具名）
```

**理由**：ADR-076 §4.6 规定"必要前提失效 ⇒ `blocked`"、"可选背景失效 ⇒ 只丢引用"。
若这一层只回布尔，调用方就**必须**自己再查一次 `epistemicKind` / `status` 才能决定走哪条路 ——
那正是"两处各判一遍、迟早漂移"的形状。现在 `G19`/`G20`/`G21` 在**输入层**就可机器判定。

档位规则（[`goal-reference.ts`](../../src/kernel/contracts/goal-reference.ts) 的常量）：

| 来源 | `hard` | `soft` |
|---|---|---|
| Memory `status` | `active` | `active` · `disputed` |
| Belief (`epistemicKind` × `status`) | `reported` × `active` | `reported`/`inferred` × `active`/`disputed` |

⇒ **`inferred` 永远最多是 `soft`**（`D06` / `G20` 的结构性落成）。
⇒ **`disputed` 是 `soft`**，不静默挑一边当确定前提（`G21`）。

### 2.2 拒绝原因是**闭集 8 条**，每条都带可达性事实

`unavailable` · `root_missing` · `foreign` · `forgotten` · `withdrawn_incomplete` ·
`revision_changed` · `status_not_usable` · `overlaid`

判定**优先级**即枚举顺序（越靠前越确定）。三条关键取舍：

- **`unavailable` ≠ `root_missing`**：读不到是"不知道"，不是"没有"（沿用
  [`memory-record-status.ts`](../../src/kernel/contracts/memory-record-status.ts) 的 `state_unknown` 立场）。
- **`withdrawn_incomplete` 独立成条**：撤销集有具名缺口时**不并进** `forgotten`，也不并进
  `unavailable`（M9.1 `D19` 的"缺口具名、不合并"）。
- **`overlaid` 独立成条**：它是**本轮**程序结果刚作废的，与"**已持久**的撤销集里有它"不同 ——
  合并会让"读侧遮蔽是否真的独立于写侧"无法被机器检查（与 M9 的 `overlaid` 同一套词汇）。

### 2.3 同轮 overlay 靠**引用里的证据指针**，不靠再读一次库

`BeliefReference` 携带 `evidenceRootIds` + `dependsOnMemoryIds`，因此 overlay 是**纯函数**：
不读存储、不看时钟。没给引用 ⇒ 那两条命中路径**不命中**（而不是"假装检查过"），
且这一点在 `counts.byReason.overlaid` 上如实体现为 0。

---

## 3. 门读数（`m10:inputs:verify` = PASS 25/25）

| 组 | 检查 | 覆盖的契约场景 |
|---|---|---|
| 静态 | `S1` fixture 无写入能力依赖 · `S2` 枚举↔事实表键一致 · `S3` 全部可达 · `S4` 批量端口形状 · `S5` 无固定版本 | —— |
| 真实版本 | `I1` rev=1 · `I2` rev=2 · `I3` **旧引用失效** · `I4` **正控：有效引用可用** · `I4b` superseded ⇒ `status_not_usable` | `G17` |
| 失效与遗忘 | `I5` 被遗忘 ⇒ `forgotten` · `I8` 共享来源事件的另一条也遮蔽 · `I9` 撤销集有缺口 ⇒ `withdrawn_incomplete` | `G18` / `G24` / `G19` 的读侧半边 |
| 身份隔离 | `I6` 跨角色 ⇒ `foreign` · `I6b` 跨用户 subject ⇒ `foreign` | `G09` 的输入层 |
| 失败关闭 | `I7` 读端口抛错 ⇒ **全体** `unavailable` | —— |
| Belief | `I10` reported=hard / **inferred=soft** · `I11` disputed=soft · retracted=status_not_usable · 不存在=root_missing · `I12` 投影**行**版本 | `G20` / `G21` |
| 编排 | `I13` 去重后端口只调一次 · `I14` overlay 只降档 · `I15` 计数守恒 + `measuredCount>0` · `I16` hard/soft 两谓词 | `G40` 的计数纪律前身 |
| fixture | `I17` 消费后计数逐字段不变 + 三个出口数组为空 · `I18` 固定值仍在原处 | M9.5 §4.4 的契约 |

**正 / 负两侧都在**：只做负控的实现可以靠"永远拒绝"通过（`I4`/`I10` 会红）；
只做正控的可以靠"永远接受"通过（`I3`/`I5`/`I8`/`I9`/`I11`/`I14` 会红）。

### 3.1 相关回归（本步必跑）

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm kernel:test` | **26 通过 / 0 失败** |
| `pnpm kernel:verify` | **25 通过 / 0 失败** |
| `pnpm m9.5:compat:verify` | **5/5 测到 · 0 失败 · 0 未跑**；真实库前后摘要相同 = true |
| `pnpm m9.5:gates` | **Hard Gates = PASS**（35/35 有档 · INVALID/REFUSED = 0） |
| `pnpm gates:verify` | **PASS 48 项 · 0 失败**（改了 `scripts/gates/**` 的必跑项） |
| `pnpm fast:offline` | **34 道 · PASS 34 · FAIL 0**（82s，非发布档） |
| 真实库 | **从未被打开**（`m9.5:compat:verify` 自报真实库摘要前后相同） |

新增证据（**两代**，与 WP0 同一纪律）：

| 代 | runId | head | 说明 |
|---|---|---|---|
| 2（**权威**） | `artifacts/m10/m10-wp2-inputs-20260929-bd895b2d769e-f8b2/` | `bd895b2`（WP2 代码提交） | 产生它的代码**可被 head 定位** |
| 1（历史） | `artifacts/m10/m10-wp2-inputs-20260929-979099e3745f-8294/` | `979099e`（WP1 文档提交） | 跑的时候 WP2 代码**还没提交** ⇒ head 指不到它。保留、不回写 |

M9.5 compat 同样两代：权威为 `artifacts/m9.5/m9.5-wp78-compat-20260929-bd895b2d769e-396b/`
（additive；`m9.5:gates` 取 head 最新的那一份作当前读数）。

---

## 4. 实现里踩到的两个真实坑（都不该被下一个 WP 重踩）

### 4.1 夹具自造角色 id 会让 `owner` 与 `kernel.characterId` 分叉

WP2 第一版给 `createM4Harness` 传了 `characterId: 'char_m10_inputs'`，于是：

```text
h.owner.id              = char_m10_inputs                                  （来自我传的选项）
h.kernel.characterId    = 00000000-0000-4000-8000-000000000001            （来自角色定义）
```

`createGoalInputPorts` 的**构造期一致性检查**当场把它拦下（那个检查的用途正是这个）。
**纪律**：门的角色标识**只能从夹具取**（`h.owner.id` / `h.kernel.characterId`），不得自造。

### 4.2 失败路径会**挂死**（不是报错退出）

同一版在 `createM4Harness` **之后**、`try` **之前**抛错，于是 `h.stop()` 从未运行，
而运行时的上游定时器仍然活着 ⇒ **进程不退**。现象是：

```text
stdout 全空 · stderr 只有一条错误 · 进程 CPU 近乎 0（是**阻塞**不是空转）· 挂 >10 分钟
```

⇒ 本门现在做两件事：① 加**阶段进度到 stderr**（否则"卡在哪"完全不可见）；
② 失败路径 `process.exit(1)`（成功路径仍走 `h.stop()` 后自然退出 ——
若那时不退，那是必须被看见的缺陷，不该被 `process.exit` 掩盖）。

**建议 WP3+ 的门脚本都照这两个做**（既有的 M9/M9.5 门没有这个问题，只是因为它们的
夹具构造没失败过 —— 这不是"它们做对了"，是"它们还没撞上"）。

---

## 5. 具名限制（交给 WP11 的 Known-Limitations）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-01` | **撤销集有任一具名缺口 ⇒ 引用一律不可用**（`withdrawn_incomplete`） | 这是"宁过遮不漏"的**有意**方向（M9.1 `D19`），但它会**过度拒绝**：一个 `orphan_no_sources` 缺口就能让整批依赖不可用。今天的撤销集只在 `explicit_forget` 链上产缺口，量很小；WP9 的规模门要实测缺口出现频率 |
| `L-M10-02` | 批量端口是**逐 ID 解析**的实现（`store.get` / `getBelief` 各一次） | 契约要求批量形状，而现有 `MemoryStorePort` **没有**按 id 集合读的方法。选"不动 M4 冻结面"而不是加 `getMany`，代价由 `dependencies ≤16` 兜住。**具名条件**：依赖上限抬到 ~64 以上必须改成真 `where id in (...)`（登记给 WP9） |
| `L-M10-03` | 每次复核**重算**撤销集（`computeWithdrawnEvidence`，内部 `list` 上限 500） | 不缓存是**故意的**（ADR-076 §4.6 要求跨 async 边界再查）；代价是每轮至多两次 `list` + 每条 retracted 的 `history`。WP9 实测 |
| `L-M10-04` | 与遗忘项**共享来源事件**的其他记忆也会被判 `forgotten`（即使它自己仍 `active`） | `I8` 实测。这是 M9.1 遮蔽"那一段对话行"的**同一条**语义（证据被撤 ⇒ 由它派生的都不可用）。副作用是过度遮蔽；正面是"遗忘不会从兄弟记录漏出去" |

---

## 6. 下一步入口

**WP3：Goal / Commitment 纯内核与持久化。**

```text
输入  ADR-076 §4.1–§4.4（字段闭集 / 13 个事件族与上限 / 两张转换表 / 唯一写路径）
      + §4.8 拒绝码闭集 + D05（身份派生）· D15/D24（零迁移）· D21（操作词表自持）· D27（预算额度）
      + WP2 已就绪的依赖复核（本交接 §2）
载体  src/kernel/contracts/goal.ts · policies/goal-validator.ts · projections/goal.ts
      · infrastructure/persistence/goal-store.ts
出口  所有合法边触达；非法边拒绝且零事件；取消后同内容新请求可建立新身份；
      重放不重复；未完成不能靠改 status 跳过 validator
门    m10:test（新增）
      ⚠️ 落地 m10:test 的**同一步**把它追加进 scripts/gates/affected-map.ts 的 M10 行（U-08）
建议  照本交接 §4 的两条做（阶段进度 + 失败路径强退）
```

**不要**在 WP3 里顺手做 WP4 的语义理解或 WP5 的依赖类别处置 ——
契约 §5 的"落地 WP"列就是边界。
