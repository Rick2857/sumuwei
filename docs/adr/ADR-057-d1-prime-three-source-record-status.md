# ADR-057 — `D1′`：把"记录状态"改成**三来源分列**，且读数据来自最终 packet

状态：**ACCEPTED / IMPLEMENTED**。与 ADR-055 同一条纪律：**本文件正文不再改写**；
后续若要再动这一行，**新开 ADR**。

授权：**用户 2026-09-24 逐字裁定**（M6.1 WP5 产品发现① 的范围内修复）——

> 「D1′ must express **long-term memory / Recent / summary separately** based on the final packet,
> no word-form triggers ("上次/记得吗"), do not touch reply guards」

日期：2026-09-24。归属：**M6.1 / WP5**（产品发现① 的范围内修复）。
上游：[`ADR-055`](./ADR-055-m6.1-wp4-explicit-memory-correction-and-context-facts.md) `D-55e`/`D-55f`（本 ADR **只改渲染形态与读数来源**，不推翻 D-55e 的任何约束）·
[`M6.1-WP5-Product-Findings.md`](../m6.1/M6.1-WP5-Product-Findings.md) §1 ·
[`M6.1-WP5-Failure-Attribution.md`](../m6.1/M6.1-WP5-Failure-Attribution.md)（③ 回答违规 13 条是这条发现的下游）。

---

## 1. 问题（一句话链，全部有实测）

```text
① RCE-01 与 RCE-02 的**程序事实完全相同**（同一空账本 · 同一沙箱 · 同一轮次形状）：
     RCE-01「我们刚才聊到哪儿了？」          ⇒ no_alert（她如实说没有依据）
     RCE-02「我上次说的事你还记得吗？」      ⇒ **alert**（补出一段没发生过的共同经历）
   ⇒ 差别只在**问法**，而 D1′ 那一行在两次里是**同一句**
     「本轮长期记忆召回未向最终上下文提供记录。」
② 根因（读源码 + 读 prompt 组装）：那一行只说**长期记忆**这一个来源。
   它没有说"这一轮最近对话有多少轮进了上下文 / 摘要有没有进" ——
   于是「本轮……未提供记录」可以被读成"我们之间什么都没有"，
   而"什么都没有"正好是编造共同经历的许可。
③ 旧 `allSourcesCovered` 是**按配置猜**的（`recall ran ∧ recent>0 ∧ rollup 端口在 ∧ rollupTokens>0`），
   **不是**从最终 packet 读的 ⇒ 一个"配置上齐全、实际被裁掉"的轮次也能把措辞升级。
```

## 2. 决定

| # | 决定 | 落点 |
|---|---|---|
| **D-57a** | **三来源分列**：状态行改成 `长期记忆 / 最近对话 / 摘要` **各一行**，三件事**不得合并成一句**。每来源用同一套**五态**表达：`provided` / `empty` / `not_consulted` / `failed` / `unknown`（与 `D-55e` 的"失败不得伪装成零结果"同源） | `src/kernel/contracts/memory-record-status.ts` 的 `ContextSourceOutcome` / `ContextSourceCoverage` / `renderContextSourceCoverage()` |
| **D-57b** | **读数来自最终 packet**，不是配置：`provided` 的判据是"那个 section 真的在 packet 里、且 `sourceRefs` 条数 > 0"（`recent-conversation` / `rollup-summary` / `memory-recall`）；条数也用 `sourceRefs.length` | `src/kernel/app/turn-gateway.ts`（从 **probe packet** 读，因为状态行有独立额度） |
| **D-57c** | **失败关闭的交叉核对**：第二遍编译之后，逐来源核对**最终** packet 与状态行声明是否一致；不一致 ⇒ **丢掉状态行**（退回 probe packet）并在 trace 记 `source_coverage_mismatch = 1` + 三个 `source_*` 读数。宁可这一轮没有状态行，也不许 prompt 里出现一句与 packet 不符的程序事实 | 同 D-57b；落进 `memory_record_status` 步骤的属性 |
| **D-57d** | **"更广那句"的前提收紧**：`allSourcesCovered` 仍可传，但渲染器**再核对** `allSourcesKnown(sources)`（三来源都必须是 `provided` 或 `empty`）⇒ 调用方一个过时的 `true` **不能**单独升级措辞 | `renderMemoryRecordStatus()` |
| **D-57e** | **不得由词形触发**：渲染函数的签名里**没有**用户文本 / 回复文本 / 关键词 —— 结构上不可能变成"上次/记得吗"这类触发。L1 有一条判据守着"同一组事实渲染逐字节相同且不含提问词形" | 契约（纯函数）+ L1 |
| **D-57f** | **不得动回复守卫**：本次只改 prompt 侧那一行；`src/kernel/context/**` 之外不碰 `reply-guard` / `output_validate` / 守卫链 | 代码边界（见 §5） |
| **D-57g** | **独立额度随形态上修**：`MEMORY_RECORD_STATUS_BUDGET_TOKENS` **120 → 220**（分列固定多两行）。理由写在常量注释里；它仍是**独立额度**（`budgetGroup: 'status'`），不占共享预算 | 契约常量 |
| **D-57h** | **向后兼容**：不传 `options.sources` ⇒ 渲染与旧版**逐字节相同**（既有 30 条 L1 判据与 M5 的 `D-55e` 兼容断言因此不动）；只有网关这条生产路径改成传 `sources` | 契约 + 网关 |

## 3. 新的状态行长什么样

```text
记录状态（程序生成）：
  · 长期记忆：本轮长期记忆召回未向最终上下文提供记录。      ← D-55e 的既有措辞，保留
  · 最近对话：本轮有 3 轮对话进入最终上下文。                ← 发现① 的修复点：这一句必须说
  · 摘要：本轮没有咨询摘要（rollup_port_missing）。
```

```text
三来源都已知且长期记忆为空时，才追加更广那句（D-55d）：
  · 本轮提供的上下文中，没有可支持这段共同经历的合格记录。
```

## 4. 落点（逐文件）

```text
src/kernel/contracts/memory-record-status.ts
  · ContextSourceOutcome / ContextSourceReading / ContextSourceCoverage（**新增**）
  · CONTEXT_SOURCE_LABEL / allSourcesKnown() / renderContextSourceCoverage()（**新增**）
  · renderMemoryRecordStatus() 增加 `options.sources` 分支（**不改**旧分支一个字节）
  · MEMORY_RECORD_STATUS_BUDGET_TOKENS 120 → 220（理由随附）
src/kernel/app/turn-gateway.ts
  · 从 probe packet 组 `sourceCoverage`（三来源五态 + `sourceRefs` 条数）
  · 传 `sources` + `allSourcesCovered: allSourcesKnown(coverage)`
  · 第二遍编译后**交叉核对最终 packet**；不一致 ⇒ 丢状态行 + `source_coverage_mismatch: 1`
  · trace 新增：`source_long_term` / `source_recent` / `source_recent_lines` /
    `source_summary` / `source_summary_refs` / `all_sources_known`
scripts/kernel-tests-m6.1.ts
  · 新增 7 条 L1 判据（分列正控 / 空长期记忆必须同时说 Recent / 不许升级 /
    允许升级 / 防词形触发 / 行数自检 / 禁止写法）
```

## 5. 本次**不做**（边界）

```text
✗ 不写"事情没发生过"—— 措辞仍然只讲**我们的记录**（`MEMORY_RECORD_STATUS_FORBIDDEN_PHRASES` 照旧生效）。
✗ 不动回复守卫、不动 `output_validate`、不动模型侧的任何后处理。
✗ 不加第四个来源（加它必须同时加"它怎么进 packet、怎么被计数"的判据）。
✗ 不因为这一行改了就说"发现① 已解决"：它给的是**事实**，能不能减少编造要靠新候选的 round 1 读数。
✗ 不改 WP4 的六件事由、不改 `D-55e` 的五态原因枚举（本 ADR 只加"来源"这一维）。
```

## 6. 门读数（本 ADR 落地时）

```text
pnpm typecheck .......................... EXIT 0
pnpm m6.1:test ........................... **236 / 0**（+7 条新判据；原 229）
pnpm m4:test ............................. 248 / 0
pnpm m3.5:test ........................... 30 / 0（**prompt 逐字节基线未变** —— 基线编译器不带状态行）
pnpm m5:runtime:verify ................... 28 / 0（D-55e 的"差异只来自状态行"仍然成立）
pnpm m5:budget:verify .................... 35 / 0（独立额度不变量）
pnpm m6.1:wp4:closure .................... PASS（7 个文件的标记与"未做"登记都在）
pnpm m6.1:e2e:verify ..................... 20 / 0
pnpm m6.1:measurement:verify ............. 16 / 0 · PASS
pnpm eval:scenarios / dryrun / providers .. 7 / 17 / 11 全 0 失败
pnpm m4.5:verify · m4.5:measurement:verify  53 / 38 全 0 失败
pnpm with-test-model pnpm m4.5:smoke:live . 见 WP5-Handoff §5.6（改 prompt 组装必须跑的真实链路门）
```

## 7. 这份 ADR 不主张什么

```text
· 不主张"她不再补造共同经历"。它只让 prompt 里出现**三来源各自的程序事实**；
  她会不会据此少编，要由新候选的 round 1（同一批冻结条文）回答。
· 不主张"三来源分列一定比一句好"——本 ADR 给的是**可测的机制改动**与离线判据，
  效果读数在 WP5 的下一轮。
· 不主张量具有效性（WP2 的事），也不主张 `expectedPoints` 那类确定性判据的充分性。
```
