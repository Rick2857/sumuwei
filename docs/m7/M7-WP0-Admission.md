# M7-WP0 · TD-08 / TD-09 准入实验报告

> 日期：2026-09-26。证据 runId：**`m7-wp0-admission-20260925-33d0c08eefc3-6e14`**（9/9 PASS，EXIT 0）。
> 运行器：`pnpm m7:wp0:admission`（`scripts/m7-wp0-admission.ts`）。
> 边界：`isolateDatabase('m7-wp0-admission')` 一次性沙箱库；**真实库从不被打开**；不调模型、不出站。
> 接收记录：[`M7-WP0-TD-Reception.md`](M7-WP0-TD-Reception.md) §2。

## 0. 准入问题（计划 §2.2 的两行）

```text
TD-08：Recall 排序前截为最近 50 条 —— 会不会让 M7 漏掉关系所需证据？
TD-09：大库 NL 遗忘 target_ambiguous —— 会不会阻断 M7 的「纠正或撤回」（场景 11）？
```

计划给的判定规则：**只有证明会漏掉关系所需证据时才前移修复**；若阻断则 M7 保持 BLOCKED，
不用向量库或放宽目标确定性绕过。

## 1. 代码事实（准入分析的输入）

```text
记忆检索路径（TD-08 的事实所在）：
  src/infrastructure/persistence/memory-retrieval-store.ts
  · scanLimit = max(1, min(500, limit × 5))        （生产 limit=50 ⇒ 250）
  · selected  = filtered.slice(0, query.limit)     ← 排序之前切片 ⇒ 生产候选集 = 最近 50
  · M6 WP8 探针读数（已落盘，不重跑）：
    artifacts/m6/m6-wp8-20260922-866f2fba5f27/retrieval-boundary.json
    第 1 名可召回 · 第 51 名召回不到 · 最老一条召回不到

事件区间读（M7 关系证据将走的路径；注释明写「Processor / Job 的输入」）：
  src/infrastructure/persistence/conversation-store.ts · conversationEventsInRange
  · where sequence ∈ [from, to] · order by sequence asc · limit = clamp(1..2000, 缺省 200)
  · 无排序前切片；界是显式、可分页的

NL 遗忘歧义（TD-09 的事实所在）：
  `target_ambiguous` 只出现在记忆 NL 变更 / 行动协议 / 召回资格三类共 7 个文件
  （recall/eligibility · action/{errors,gateway,policy} · app/memory/{response-truth,explicit-service,correction-fallback}）
```

## 2. 实验设计（先写命题，再写量具）

**TD-08 命题**：事件区间读不受 50 截断影响；其界显式可分页；分页能无缺口覆盖全区间。
**TD-09 命题**：`target_ambiguous` 对事件账本与关系路径零依赖（命中文件集 ⊆ 已知清单）。

沙箱内种子 **250** 条用户直接互动事件（`appendUserStatement`，刻意 > 200 与 > 50 两个界），
然后逐条测量。计数型自检全部有非零分母（P1 保证种子集合非空）。

## 3. 读数（9/9）

| # | 检查 | 期望 | 实测 | 结果 |
|---|---|---|---|---|
| P1 | 种子正控 | appended=250 · idempotent=0 · count=250 | 250 · 0 · 250 | ✅ |
| M1 | 显式 limit=250 的区间读 | 全部 250 条可见（无 50 截断） | 250 条 | ✅ |
| M2 | 缺省 limit 的界 | 200（显式文档化界，不是 50） | 200 条 | ✅ |
| M3 | 钳制上限 2000 | 允许一次读完全区间 | 250 条 | ✅ |
| M4 | 分页 `[min..min+199] + [min+200..max]` | 并集=250 · 重叠=0 · 跨度=250 | 250 · 0 · 250（200+50） | ✅ |
| M5 | 第 51 条事件经区间读可见（对照：记忆检索的第 51 条不可达） | 可见 | sequence=51 可见 | ✅ |
| S1 | TD-08 对照面：检索路径的排序前切片行仍在 | 行存在 | 行仍在 | ✅ |
| S2 | 区间读是显式钳制、无排序前切片 | `Math.min(2000, limit)` 在 | 在 | ✅ |
| S3 | `target_ambiguous` 命中集 ⊆ 7 文件清单 | 零清单外命中 | 命中 7 个，全部在清单内 | ✅ |

## 4. 准入结论

```text
TD-08 = NOT BLOCKING
  关系证据 = 直接受信互动事件（事件区间读），不经过记忆检索的候选集切片。
  残余暴露（如实登记，不并入本结论）：
  · 她「口头回忆」共同往事仍走 recall+rollup ⇒ 受 50 截断与 L-M61-04 影响（已知风险，分列）；
  · 关系状态入模走投影区段（当前值），不依赖长程记忆取回 —— 架构缓解，非修复。
TD-09 = NOT BLOCKING
  关系纠正 = 关系域事件 supersede（owner→target 确定性键），不经过 NL 遗忘的目标解析。
  残余暴露：用户口头撤回的「证据识别」是 WP3 提案器的验收职责，不是 TD-09 的回归。
```

**冻结进 ADR-064（WP1）的设计约束**：

```text
① 关系证据 = 直接互动事件（事件区间读）；记忆检索候选集永不作为关系证据。
② 关系域内的纠正/撤回 = 域事件 supersede；不复用记忆 NL 变更的目标解析。
③ 事件区间读的界（缺省 200 / 上限 2000）是显式契约：提案器处理大区间时必须分页遍历，
   不得假设一次调用读全（M4 已证分页无缺口）。
```

原排期不变：TD-08 仍"M9 Belief 前必要时修"，TD-09 仍"与 TD-08 同窗口"（TD 表原文）。

## 5. 量具自身的边界（本报告不主张什么）

```text
✗ 不主张记忆检索路径的 50 截断已修复或已重测 —— 那是 M6 WP8 的已落盘读数，本轮只核对切片行仍在（S1）。
✗ 不主张 250 条 ≈ 生产规模 —— 本实验测的是「路径形状」（有没有截断、界是否显式可分页），
  不是规模性能（那是 TD-17 性能 SLA 的窗口）。
✗ S3 是「零依赖」的机器检查，不是「关系纠正语义正确」的证明 —— 后者是 WP4/WP6 的验收。
✗ 沙箱库读数不描述真实库状态（AGENTS §6.9）。
```
