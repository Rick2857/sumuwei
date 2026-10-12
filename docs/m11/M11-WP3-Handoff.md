# M11 WP3 交接单

- 日期：2026-10-01
- 工作包：WP3（真实输入与结构化候选）
- 状态：**COMPLETE** —— ①结构化候选（草案契约 + 严格校验，`ed21543e`）·
  ②**真实输入装配**（触发检测 + 有界窗口 + 真实适配器，`322acc81`）两件全部落地；
  门 `m11:inputs:verify` = **PASS 39/39**
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D06` / `D14` / `D15` / `D30` / `D32`
- 证据（权威代 + 4 代过程档，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp3-20261001-322acc81938f-dc5a/`（**39/39**，head = 输入装配提交）
  - `…098047dc22c4-6049`（39/39，未提交）· `…ed21543ecd31-9cbf`（26/26，草案提交）·
    `…6da71f7c925f-cc03`（26/26，未提交）· `…6da71f7c925f-d467`（25/25，**计数分母全零** ⇒ 已被 D6 修正取代）
- 本轮**没有**：打开真实库（`isolateDatabase()` 一次性沙箱）· **调模型**（`modelCalls: 0`）· 出网 · 改 DDL

---

## 1. 已完成：结构化候选（草案契约）

[`src/kernel/contracts/reflection.ts`](../../src/kernel/contracts/reflection.ts)：

```text
· 形状：focusQuestion · explanation · supportHandles · counterHandles · scope
        · suggestedSlot?（三槽闭集）· revisionIntent?（跨域**只提议**）
· **字段闭集**（8 个名字）—— `roots` / `rootCount` / `owner` / `revision` / `authority` /
  `confidence` / `evidenceIds` **不在表里** ⇒ 出现即 `draft_unknown_field`。
  这是 `D06`（模型只选程序提供的 handle）的机器判据，不是注释。
· 上界：自由文本 ≤ **300 码点**（`D30` 的冻结值）；码点计数**不是** UTF-16 长度
  （一个 emoji 算 1，否则上界会被悄悄提前触发）。
· 理由码闭集 7 条（验收契约 §3.3 的 6 条 + WP3 追加的 `draft_schema_unknown`，
  追加有判据变更记录）：`draft_invalid_json` · `draft_empty` · `draft_unknown_field` ·
  `draft_too_long` · `unknown_slot` · `handle_not_provided` · `draft_schema_unknown`。
· `parseReflectionDraft()`（原始文本 → 草案）与 `validateReflectionDraft()`（已解析对象）
  是**两层**，互不顶替；解析失败**不重试、不修补**。
```

### 1.1 门的四段（A–D）

```text
A 正控（4）：合法草案通过 · 可选槽位 · 可选跨域意图 · 解析/校验两层都可独立调用
B 负控（12）：7 条理由**逐条真的被产出**，含"模型自报根数""自报 authority"
              "编造 handle""截断的 JSON""超长解释""自创槽位""版本错配"
C 闭集自检（3）：产出的理由集合 == 登记表（**既不多也不少**）· 每条都有可达性事实
D 零写入（6）：20 份合法草案跑完后 Memory/Belief/Goal/Commitment/Reflection
              事件数**一个都没变** · 结构判据（契约里无写原语、闭集里无程序事实字段）
              · 码点计数自检
```

⚠️ **D 组的分母被特意打非零**（`D6`）：第一代读数里 `before` 全是 0，于是"没写库"是
"0 → 0"——那与"**计数器根本不工作**"在输出上**长得一样**（AGENTS §6.8）。
现在先写一条无关的领域事件把 `other` 打到 1，再断言它在跑草案期间**没变**。

---

## 2. 已完成：真实输入装配（`D14` / `D15` / `D30`）

| 文件 | 内容 |
|---|---|
| [`contracts/reflection-input.ts`](../../src/kernel/contracts/reflection-input.ts) | 六个触发种类 + **逐条可达性事实** · 事件类型→触发的**确定性映射表** · `detectReflectionTriggers()`（纯函数）· 有界窗口与 handle 形状 |
| [`app/reflection/inputs.ts`](../../src/kernel/app/reflection/inputs.ts) | `buildReflectionInput(source, options)`：水位后有界读取 → 触发检测 → 有界窗口（≤50）→ 程序给的 handle + 五类标签 → `ReflectionInput`；**没触发就返回 `undefined`** · `meetsStabilityThreshold()`（`D10`，纯函数） |
| [`persistence/reflection-input-source.ts`](../../src/infrastructure/persistence/reflection-input-source.ts) | 只读适配：**`limit` 下推到 SQL**（不是查全量再切片）· 只读 `id/type/sequence/payload.reason/source_conversation_event_ids`，**不读正文** |

### 2.1 触发是**确定性**的，且有一条**如实登记为不可达**

```text
user_correction      ← MEMORY_RETRACTED(reason=explicit_correction)
safety_invalidation  ← MEMORY_RETRACTED(reason=explicit_forget)   ← **不需要模型**（D12）
goal_outcome         ← GOAL_COMPLETED / GOAL_BLOCKED / GOAL_CANCELLED
commitment_outcome   ← COMMITMENT_FULFILLED / COMMITMENT_BROKEN / COMMITMENT_CANCELLED
registered_conflict  ← MEMORY_DISPUTED / BELIEF_DISPUTED
user_feedback        ← **v1 不可达**（无确定性检测器；显式反馈的识别是语义问题，
                        词形判据会误触发 —— M5.5.1 的 L-M55-15 已登记）⇒ 事实表如实写 v1Detectable=false
MEMORY_RETRACTED(reason=audit) ⇒ **不触发**（审计性撤回不是用户给她的信号）
```

### 2.2 门的六段（**PASS 39/39**，≈4 s）

```text
A 正控 4 · B 负控 12（7 条理由逐条真产出）· C 闭集自检 3 · D 零写入 6
F 触发/门槛 8（表覆盖 8/8 · 撤回三细分 · 可达性自检 · 不误触发 · 无触发⇒undefined
              · 60 条触发 ⇒ 窗口 50 + truncated=true · classHints 覆盖 · 门槛五态手算）
G 真实库 5（真实读回 · limit 下推 · **真实窗口不误触发** · 跑 5 次零写入 · 结构无写原语）
S 量具自检 1（六组非零）
```

⚠️ 触发路径的**边界与超限**用构造读数测（F 组），真实库只测"读得对 / 不误触发 / 不写库"（G 组）——
因为要在真实库里造一条 `MEMORY_RETRACTED` 就得伪造一条撤回事件；检测器本身是**读数的纯函数**，
用构造读数测它更诚实（判据的可达性不依赖伪造的账本）。

**WP3 出口条件**（计划 §9）：不存在 handle / 捏造根 / 错角色 / 未知字段 / 非法 JSON /
无结果 / provider timeout **都不能形成已采纳状态** ✓（草案层与输入层各自钉住）·
Memory / Belief / Goal 与 AdaptiveSelf 的变化数 **= 0** ✓（D 组 + G 组，且分母非零）。

---

## 3. 下一轮（WP4：Reflection 审查与独立生命周期）

```text
新增 reflection 事件族（5 个）+ 事件注册（WP2「只登记」→ WP4「接线」）
+ 审查策略（唯一放行口）+ 纯 reducer + append/apply 入口
+ `m11:policy:verify`：pending/accepted/rejected 是**不同状态**；
  证据不足与冲突不放行；模型说"可靠"不能绕过 policy
```

---

## 4. 受影响旧门的回归读数

```text
kernel:test (scripts/kernel-tests.ts)          EXIT 0
kernel:verify (scripts/verify-phase-c.ts)      EXIT 0
m4:test (scripts/kernel-tests-memory.ts)       EXIT 0（258 通过 / 0 失败）
m4:verify (scripts/verify-m4-persistence.ts)   EXIT 0（142 通过 / 0 失败）
m3:verify (scripts/verify-m3-persistence.ts)   EXIT 0
m11:lineage:verify                             PASS 34/34（WP2 的门未被本次改动破坏）
m11:inputs:verify                              PASS 39/39
```

⚠️ 这是**受影响门**读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。
