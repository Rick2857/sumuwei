# M11 WP5 交接单

- 日期：2026-10-01
- 工作包：WP5（有限 Adaptive Self）
- 状态：**COMPLETE** —— 三槽契约 + 纯策略规划 + 折叠 + 存取层四件落地；
  门 `m11:adaptive:verify` = **PASS 22/22**（零模型调用）
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D09` / `D10` / `D11` / `D27` / `D32` · §4.6
- 证据（两代，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp5-20261001-cbe24ec366c8-5cb4/`（**22/22**，head = 实现提交）
  - `artifacts/m11/m11-wp5-20261001-ac6a07966339-ecc0/`（22/22，脚本未提交）·
    `…-3da6`（21/22，**一处真缺陷** ⇒ 见 §3）
- 本轮**没有**：打开真实库（`isolateDatabase()` 一次性沙箱）· 调模型（`modelCalls: 0`）· 出网 · 改 DDL

---

## 1. 交付的代码

| 文件 | 内容 |
|---|---|
| [`contracts/adaptive-self.ts`](../../src/kernel/contracts/adaptive-self.ts) | 三槽闭集（**唯一**定义在 `reflection.ts`，这里只重导出，避免两处漂移）· `baseline/enhanced` · 范围只有一个值 · **程序模板** `ADAPTIVE_SELF_TEMPLATES` + `renderAdaptiveSelfLine()` · 越界识别 `outOfScopeReasonOf()` · 三槽**总有** baseline 读法 |
| [`app/reflection/adaptive-self.ts`](../../src/kernel/app/reflection/adaptive-self.ts) | `planAdaptiveSelfChange()`（纯策略：开关 → 越界 → 反思状态 → 冲突 → 门槛 → 档位）· `foldAdaptiveSelfRows()`（纯折叠，`adaptive-self-fold@1`） |
| [`persistence/adaptive-self-store.ts`](../../src/infrastructure/persistence/adaptive-self-store.ts) | 本域唯一写路径（恰好 apply/rebuild）+ 三个读函数（读面无写原语） |
| [`contracts/reflection-events.ts`](../../src/kernel/contracts/reflection-events.ts) | `validateAdaptiveSelfRevisedPayload()` 现在**查槽位闭集**（见 §3） |

### 1.1 指导语只来自程序模板（`D32` 的落点）

```text
进上下文的那句话**只能**由 `renderAdaptiveSelfLine(slot)` 产出，而它是
`ADAPTIVE_SELF_TEMPLATES` 这个**封闭枚举**的固定句子。
⇒ `AdaptiveSelfState` 里**没有** `instruction` / `prompt` / `systemMessage` / `text` 这类字段
  （C2 是去注释后的结构判据，零命中）—— 模型/反思的正文**在类型上**不可能变成指令。
```

---

## 2. 门（`m11:adaptive:verify` = **PASS 22/22**）

```text
A 正控 3：三个去重根 / 两会话 / 已采纳反思 ⇒ 规划出 revise（baseline→enhanced，revision 1）
          · 落库 + 折叠后状态**真的**变了（根与原因可查）· 三槽总有读法
B 负控 10：单根 ⇒ single_root_only · 两根 ⇒ threshold_not_met · 单会话 ⇒ single_session_only ·
          未解决冲突 ⇒ conflicting_support · 反思只是候选 ⇒ reflection_not_accepted ·
          开关关闭 ⇒ adaptive_disabled · 档位没变 ⇒ no_level_change ·
          **同一个根重复三次 ⇒ 仍算 1 个**（纵深防御）· 越界三码（Seed / 人格轴 / 闭集外的槽）·
          **revision 跳跃不折叠**（非法边）
C 回放/结构 3：全量重建逐字段一致 · 状态里没有自由文本指令字段 · 模板恰好覆盖三槽
D 不碰别的域 3：跑 10 次规划后 Memory/Belief/Goal/关系/情绪事件数**一个都没变**（分母非零）·
          本域写入确实发生（非零正例）· 读面无写原语
S 量具自检 2
```

---

## 3. ⚠️ 本门抓出的真缺陷：**闭集在契约层没有被强制**

```text
第一版 `validateAdaptiveSelfRevisedPayload` 只 `requireString('slot')` 然后**强转** `ReflectionSlot`
⇒ 一个闭集外的槽（`reconcile_goal`）能一路写进**账本**与**投影行**，
  于是"三槽闭集"只剩文档上的一句话。
实测：S2 读到 **2** 条投影行（应为 1 条）—— 那条越界槽真的建了行。
```

修法：契约层用 `isReflectionSlot()` 查闭集，越界值直接抛错。

⚠️ 这条与 WP4 的幂等键缺陷同族：**策略层拦得住，不等于契约层拦得住**。
两道闸各自要被证明（本门 B9/B10 测策略层，S2 测契约层）。

---

## 4. 下一轮（WP6：跨域待审修订、撤回与同轮阻断）

```text
RevisionIntent 只读待审面 · 支持源更正/撤回/忘掉后的**即时可用性过滤** · 幂等持久失效 ·
跨域入口契约锁（M9 inferred 槽不扩张 · M4 authority 不伪造 · M10 承诺修订不绕过接受规则）
门 `m11:invalidation:verify`：模型运行期间源变更 · 目标版本变化 · 隐私遮蔽 · 忘后追问 ·
旧摘要/语义结果/反思链**不能**恢复禁用内容
```

---

## 5. 受影响旧门的回归读数

```text
kernel:test (scripts/kernel-tests.ts)          EXIT 0
kernel:verify (scripts/verify-phase-c.ts)      EXIT 0
m4:test (scripts/kernel-tests-memory.ts)       EXIT 0（258 通过 / 0 失败）
m4:verify (scripts/verify-m4-persistence.ts)   EXIT 0（142 通过 / 0 失败）
m11:lineage:verify                             PASS 34/34
m11:inputs:verify                              PASS 39/39
m11:policy:verify                              PASS 25/25
m11:adaptive:verify                            PASS 22/22
```

⚠️ 这是**受影响门**读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。
