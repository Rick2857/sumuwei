# M11 WP8 交接单

- 日期：2026-10-01
- 工作包：WP8（ContextCompiler、回复事实与开发者面）
- 状态：**COMPLETE（8/8）** —— ①额度与**真接线**（`D34`）· ②注入块渲染 · ③六态事实包 ·
  ④网关接线与 trace · ⑤**隐私 DTO（开发者面）** · ⑥**回复事实绑定** 全部落地
- 门 `m11:context:verify` = **PASS 31/31**（零模型调用）
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D20` / `D21` / `D23` / `D27` / `D32` / `D34` · §6.3 · §7.3 · §8
- 证据（六代，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp8-20261001-cbb43bfccad1-2631/`（**31/31**，head = 开发者面提交）
  - `…cbb43bfccad1-2ea6`（31/31，明细措辞未修）· `…9529fe5feda4-4f7e`（24/24，网关接线）·
    `…25356a4bd125-1321`（24/24）· `…-6ca7`（23/24：E 组未计入组计数 ⇒ 已修）· `…40059641221a-1d56`（19/19，第一代）
- 本轮**没有**：打开真实库（`isolateDatabase()` 一次性沙箱）· 调模型（`modelCalls: 0`）· 出网 · 改 DDL

---

## 1. 交付的代码

| 文件 | 内容 |
|---|---|
| [`recall/selector.ts`](../../src/kernel/recall/selector.ts) | `ContextBudget.adaptiveSelfTokens`（**第 7 个**额度字段，缺省 **0**）· `planContextBudget` 新分类 `adaptive_self` · `assertContextBudget` 的键列表 + committed 求和 + 报错文本 |
| [`app/flags.ts`](../../src/kernel/app/flags.ts) | `reflectionEnabled` / `adaptiveSelfEnabled`（**两个独立开关**，代码缺省均 false）· `adaptiveSelfTokens`（`boundedInt` 0..800，缺省 0） |
| [`main.ts`](../../src/main.ts) | **`D34` 的落点**：`recallBudget` 里真的写 `adaptiveSelfTokens: this.flags.adaptiveSelfTokens` |
| [`context/adaptive-self-sections.ts`](../../src/kernel/context/adaptive-self-sections.ts) | `renderAdaptiveSelfSection()`（额度 0 ⇒ 不渲染；只有 enhanced；至多三条；正文只来自程序模板）· `adaptiveSelfContextReality()`（**被裁 ≠ 入模**） |
| [`app/reflection/fact-pack.ts`](../../src/kernel/app/reflection/fact-pack.ts) | 六态事实包（每态一句程序事实句 + 允许说 / **不许说**两张冻结表） |

### 1.1 `D34` 与 `L-M11-10`：这次**真的**接线了

```text
WP0 实测：M10 的 `goalTokens` **从未**被生产装配设置 ⇒ 生产里 goal-state 块永远不可达。
⇒ 本步把 `adaptiveSelfTokens` 从 `flags` 一路写进 `main.ts` 的 `recallBudget`，
   并让门做**静态回归锁**（C3：断言 `src/main.ts` 里真的出现 `adaptiveSelfTokens`）。
```

### 1.2 计划 §8 写「五态」但列了**六项**（如实登记）

```text
没有运行 / 失败 / 候选待审 / 已审查但未调整 / 当前调整已生效 / 已失效  = **6**
⇒ 本步实现 **6** 态，并把"计划写五态、实际列六项"这一处差异如实登记
  （与 M10 的 `U-12`"记作十项、原文九段"同一类：不掩盖数字差）。
```

---

## 2. 门（`m11:context:verify` = **PASS 19/19**）

```text
A 额度 4：额度 0 ⇒ 0 section · 代码缺省 = 0 · 负数/非整数被拦 · 超额在装配时失败
B 渲染 6：kind/优先级/可裁对 · 只有 enhanced 进上下文 · 至多三条 · 正文不含内部 id ·
        sourceRefs 逐条带槽位与 revision · 额度只够一条时只渲染一条（不改写成"更短的正确版"）
C 入模现实 4：被裁 ⇒ selectedRefs 清空 + droppedByContextBudget · 活下来 ⇒ 与最终 packet 一致 ·
        **`D34` 静态锁**（main.ts 真的出现该字段）· 两个开关名与缺省在场
D 事实包 3：六态各自可达 · 每态禁止项含最要紧的夸大 · 每态都有程序事实句
S 2：渲染/事实包都不写库（10 轮后所有域事件数不变）· 四组非零
```

---

## 3. ⚠️ 本轮发现的两件事（都不是 M11 造成的）

### 3.1 `m5:budget:verify` 在本基线树上**已经是红的**（继承缺陷，`L-M11-13`）

```text
现象：真实 recall 链路上"大预算能装下记忆块"读到 **entries=0**（34 通过 / 1 失败）。
**判定它不是本步造成的**（实测而非推测）：把本步的全部改动 `git stash` 掉、回到
pre-WP8 状态重跑同一道门 ⇒ **完全相同的失败**（34/1，同一检查，entries=0）。
⇒ 归 M5/M9.5 线（真实链路的候选面在本树为空），登记 `L-M11-13`；M11 不顺手修它。
```

### 3.2 M10 的 `m10:context:verify` D6 **判据量错了对象**（已修，判据变更记录在代码里）

```text
D6 的标签写着"**先去注释**再数"，代码却在**原始源码**上数 `goalTokens`。
M11 给 `adaptiveSelfTokens` 写说明时引用了那个字段名 ⇒ 计数 6 → 8 ⇒ D6 变红，
而 `?? 数字` 的影子默认**根本不存在**。
修法：与影子默认检查共用同一份 `codeOnly`（6 处的**用途**判据不变）⇒ 复跑 **26/26 PASS**。
⚠️ 这是"门量错了对象"的**第五例**（前四例在 WP0/WP4）。
```

---

## 4. 本轮新增：网关接线与 trace（`9529fe5f`）

```text
turn-gateway.ts：新增选项 `buildAdaptiveSelfStates`（**不传 ⇒ 什么都不发生**）·
  按**那一个** `ContextBudget.adaptiveSelfTokens` 渲染 · provider 挂载 ·
  trace 步 `adaptive_self_context`（入模 id **只来自最终 packet**）
main.ts：`adaptiveSelfEnabled` 开 ⇒ 传 `buildAdaptiveSelfStates`（读三槽状态）
contracts/observability.ts：只**追加**一条 kind→stage 映射（`context`），**阶段数仍 12**
contracts/trace.ts：trace 步类型登记（属性只有 id / 计数 / 结局）
```

⚠️ **`L-M11-10` 的失败模式在这里被主动规避**：只加网关选项而装配层不传，等于功能永不生效。
E3 就是这条的静态锁（`main.ts` 真的挂在开关上）。

**prompt 基线**：`turn-gateway.ts` 是 prompt 相关文件 ⇒ 按 AGENTS §5 跑了
`m3.5:test`（`future-compat-tests.ts`，含 prompt 逐字节回归）+ `eval:scenarios` +
`eval:dryrun` + `eval:providers` —— **四门全 EXIT 0**（关闭档 prompt 与基线逐字节相同）。

---

## 5. 本轮新增：隐私 DTO 与回复事实绑定（`cbb43bfc`）

```text
app/reflection/masking.ts       reflectionContentMustBeMasked() —— **唯一**的遮蔽判定
                                （撤回整条 ⇒ retracted_reflection；任一根被忘 ⇒ withdrawn_source + 命中 id；
                                  ⚠️ **读不到 ≠ 遮蔽**：一次查询失败不该让正常的反思在开发者面消失）
app/reflection/developer-face.ts 遮蔽**写进类型**的 DTO 判别联合（遮蔽支**没有**正文与 revisionIntent）·
                                buildDeveloperReflectionList()（含 excluded / truncated）·
                                行为策略的开发者面（**没有正文**，但标出被禁根）·
                                `*_FACTS` + `FORBIDDEN_EXPORT_PATTERNS`（9 条形状）
turn-gateway.ts                 `reflectionFactPack` 选项 → `adaptive_self_context` 步新增
                                `fact_state` / `allowed_claims_count` / `forbidden_claims_count`
main.ts                         按程序读数算出事实包并传入（`reflectionFactInputFrom()`）
```

### 5.1 为什么**不**做逐句扫描（这是刻意的）

```text
`DR-11` 的既有立场：措辞层**没有**启发式守卫。
⇒ 绑定做的是：**程序事实进 trace**（本轮处于六态中的哪一态）+ 允许/不许说的**冻结表**
  作为行为评审与人审（WP10）的核对清单。
⇒ 逐句扫描会制造假信号（"说'我已经调整了'但其实是待审"这种判断需要看**状态**，
  而不是看词）—— 本门 F6 因此**反向**断言网关里没有 `replyText.includes(` 这类形态。
```

⚠️ 一处**如实登记**：`reflectionFactPack` 的 `lastRunFailed` 在装配处暂取 `false`
（任务面的失败读数接在 `m11:recovery:verify` 那一侧）；它的**回复面**绑定留给 WP10 行为评审，
**不**假装已经接了。

---

## 6. 下一轮（WP9：独立量具、语料冻结与离线端到端）

```text
§10 的 64 个必测场景（S01–S64）· §11 的中文语义语料 · 独立 oracle · 判定器三段式 ·
性能/隐私扫描 · 200/500 轮离线轨迹
门 `m11:measurement:verify`（量具有效性先过）· `m11:e2e:verify`（真实 TurnGateway + 离线 provider）
```

---

## 7. 受影响旧门的回归读数

```text
kernel:test EXIT 0 · kernel:verify EXIT 0 · m4:test 258/0 · m4:verify 142/0 ·
m4.5:test EXIT 0 · m5:test EXIT 0 · m10:context:verify **26/26 PASS**（修好判据后）·
m10:m11:verify PASS 11/11
**prompt 基线四门**（AGENTS §5，因为动了 `turn-gateway.ts`）：
  m3.5:test（future-compat-tests，含 prompt 逐字节回归）EXIT 0 · eval:scenarios EXIT 0 ·
  eval:dryrun EXIT 0 · eval:providers EXIT 0
m11 门：34/34 · 39/39 · 25/25 · 22/22 · 18/18 · 17/17 · 本轮 context **31/31**
⚠️ **`m5:budget:verify` = FAIL（1 项）**：pre-WP8 复现同样失败 ⇒ 继承缺陷 `L-M11-13`，非本步引入。
```

⚠️ 这是**受影响门**读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。
