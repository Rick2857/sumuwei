# M6 · WP1 Handoff

> `runId`（WP0，仍然是基线权威）：`m6-wp0-20260921-1165fedcdde2`
> 分支 `feature/m6-lv1-hardening` · WP0 基点 `1165fedcdde2065d41eeeb1b12a635091b4d721a`
> 本轮产物：`docs/adr/ADR-050-rolling-summary-provenance-boundary.md`（**PROPOSED**）· `docs/m6/M6-Acceptance-Contract.md` · 本文件

---

## 1. 当前 WP / 状态

**WP1（设计冻结与验收契约）= 裁定包已出，等待用户裁定。** 出口是二选一：

```text
D-1 / D-2 / R-2 / R-3 获批  ⇒  ADR-050 置 ACCEPTED / DESIGN FROZEN  ⇒  进入 WP2
要求改写                    ⇒  修订后重新提交；WP2 不得开工
```

| 已做 | 未做（刻意） |
|---|---|
| ADR-050 草案：12 条拟定裁定 + 契约 + 选择算法 + 失效规则 + 效果矩阵 + Cognitive Integrity 审查 + 备选与局限 | **没有**改 ADR-043 / ADR-044 / ADR-049 一个字节 |
| 验收契约：要求矩阵（O-1…O-7 / C-1…C-4）+ 样例集（正控 5 + 负控 13）+ 13 道门的量程/硬零/质量项/分母 | **没有**写任何 `src/**` 代码，**没有**实现摘要 |
| 把 R-2 / R-3 两条审阅发现落成**可裁定的选项**（各带建议与不选的后果） | **没有**改 `ContextBudget` / `ContextCategory` / `evals/fixtures/m3.5/prompt-baseline.txt` |
| 复核冻结面范围（见 §6），确认新增文档不触发任何既有检测器 | **没有**跑任何里程碑门（理由见 §5） |
| G1 范围与 A/B 包的要求写进契约 §8 | **没有**为 G1 设计考卷之外的实施内容 |

---

## 2. branch / HEAD / 树哈希 / 未提交文件归属

| 项 | 读数 |
|---|---|
| 分支 | `feature/m6-lv1-hardening` |
| WP1 起点 HEAD | `1cdaba2`（WP0 的第 4 个提交，已落盘） |
| WP0 基线 commit 链 | `f4a7aaf`（计划书）→ `886e95f`（量具）→ `36a25bf`（基线/受影响面）→ `1cdaba2`（交接与证据） |
| 未提交（WP1 起点） | 仅 ` M artifacts/incidents/inc-01/wp1-lease.json`（**other-task**，原字节保留） |
| 运行相关树哈希 | **本轮不重采**，理由见下 |

**为什么 WP1 不重采树哈希（这是纪律，不是偷懒）**：

1. §9.2 的"运行相关树改变使证据失效"针对的是**运行相关**的改动。WP1 只增三份 Markdown，
   **不改任何运行相关文件**（无 `.ts`、无 `config`、无语料、无阈值）。
2. **候选身份 = 提交 sha**。WP1 的候选就是本轮的提交；树哈希机制的服务对象是 WP10a 的
   "最终候选"。
3. WP0 的 `artifacts/m6/m6-wp0-*/baseline.json.verification` 描述的是 **WP0 边界**。
   为了让 WP1 也有一份读数而重跑量具，会**改写已提交的 WP0 证据**，那正好是 AGENTS §3/§7 禁止的事。

⇒ **结论**：WP1 的候选身份由 `git rev-parse HEAD` 表达；下一个需要树哈希的包是 WP2
（它第一次改运行相关文件），届时按 WP0 的三段采样（`before` / `after` / `verify`）执行。

---

## 3. 输入依据与本轮沿用的授权

| 依据 | 说明 |
|---|---|
| 用户指令「继续」 | 承接 WP0 Handoff §8 指定的下一包 = **WP1**（设计冻结与验收契约） |
| WP0 的四份产物 | `M6-Baseline.md` · `M6-Affected-Surface-Map.md` · `WP0-Handoff.md` · `artifacts/m6/m6-wp0-*/` |
| 计划书 §3.1 / §3.2 / §4 / §6(WP1) / §8 / §9 | WP1 的交付要求、门的编号与状态词表 |
| **本轮未沿用的授权** | WP2 及以后的一切实现 · Live 门 · 生产激活 · 真实库迁移/恢复 · 打标签 · 合并 |

**本轮明确不主张**：`ADR-050` 的状态是 `PROPOSED / AWAITING RULING`。
**在用户裁定之前，本 ADR 不构成任何实施授权**，也不得被引用为"已冻结的设计"。

---

## 4. 有意修改的文件与原因

| 文件 | 性质 | 为什么 |
|---|---|---|
| `docs/adr/ADR-050-rolling-summary-provenance-boundary.md` | 新增 | 计划书 WP1 要求"交付一份有内容的 ADR 草案，编号现场选取"（ADR-049 已占，ADR-050 现场确认空闲） |
| `docs/m6/M6-Acceptance-Contract.md` | 新增 | 计划书 WP1 要求的：要求矩阵、样例、门的量程/硬零/质量项/分母、prompt 变化预期、Cognitive Integrity 结论的**载体** |
| `docs/m6/WP1-Handoff.md` | 新增 | 计划书 §12 的八项交接 |

**没有**新增 npm 命令、**没有**改 `package.json`、**没有**改任何冻结面文件。

---

## 5. 命令、退出码、断言数、失败/跳过、证据路径

### 5.1 本轮**该跑的门 = 0 道**（并说明为什么这不是漏做）

WP1 是**纯设计文档轮**：`git diff --stat` 只有三个 `.md`。AGENTS §5 的门表按"你改了什么"触发，
本轮的改动面（`docs/**`）**不在任何门的触发条件里**。跑 `m4.5:ci` 一类只会重写 `artifacts/` 历史证据。

### 5.2 本轮实际执行的**只读核对**（3 项，全部有具体发现）

| # | 核对 | 方法 | 结论 |
|---|---|---|---|
| V-1 | ADR 编号可用性 | 列 `docs/adr/ADR-04*` | 最新为 ADR-049；**ADR-050 空闲**；未覆写 ADR-049 |
| V-2 | **冻结面范围自检**（本轮最有用的一项） | 读 `artifacts/m5.5/baseline.json` 的 `historicalEvidence`（机器可读清单）+ `scripts/*.ts` 的 `FROZEN_DIRS` | 冻结身份检测器覆盖 **6 个子树**（`docs/m5`、`docs/m5.1`、`docs/m5.1.1`、`artifacts/m5`、`artifacts/m5.1`、`artifacts/m5.1.1`）+ **10 个具名 blob**（其中两份是 ADR：[ADR-043](docs/adr/ADR-043-epistemic-requalification.md) 与 [ADR-044](docs/adr/ADR-044-m5.1.1-phase4-closure.md)）。`FROZEN_DIRS` 全部是 `artifacts/**`。⇒ **`docs/m6/**` 与新增 ADR 不在任何检测器范围内**；本轮新增文档不会让任何既存门变红 |
| V-3 | 需求矩阵的依据行 | 读 `README.md:49-52` | O-1…O-7 的"现实现/延期归属"逐条有出处（L1-M3 状态演化 → M7；L1-M4 拆分，Rolling Summary 未实现） |

**没有**运行模型、搜索、数据库或任何完整 CI。**没有**打开真实库。

## 6. 沙箱 / 真实库边界读数与限制

| 读数 | 值 |
|---|---|
| 真实库是否被打开 | **否**（本轮只读文档与脚本，未触碰 `data/`） |
| `PROJECT_LG_SANDBOX` | 未设置（本轮不涉及数据库进程） |
| 真实库摘要 | 沿用 WP0 的 `be957694b8a1173a…c500`（1205 文件 / 31,584,799 B）—— **本轮未重采**，该读数属 WP0 边界 |

**限制**：V-2 是**范围**核对（读检测器的清单），**不是**重跑检测器。
若要让"新增文档不触发漂移"变成**实测**结论，需要跑 `pnpm m5.5:measurement:verify`；
本轮**刻意不跑**，因为它会重写 `artifacts/m5.5/**`（§5.1 的同一理由）。
⇒ 该门由 **WP10a** 在最终候选上执行一次，届时"WP0/WP1 的历史文档未被改写"会被真正断言。

---

## 7. 新发现问题、阻塞、偏差，以及**没有扩大的**能力主张

### 7.1 新发现（4 条）

| ID | 发现 | 影响 |
|---|---|---|
| **F-5** | **v1 摘要在既有真实历史上会选出 0 条**：`attribution_origin` 只对 v7 之后走升级写入路径的事件是 `RECORDED`，历史行按 `DR-7` 一律 `UNCONFIRMED_ORIGIN` | WP7 / WP9b 的夹具**必须真的产生受信归因**；否则用例会"因为摘要永远为空而全绿"（假绿形态 #6） |
| **F-6** | 冻结身份检测器的**精确覆盖清单**（6 子树 + 10 具名 blob，其中含 ADR-043 / ADR-044） | ADR-043/044 **不得被编辑**；新增 ADR 安全。这条把"冻结面"从概念变成了可查的清单 |
| **F-7** | `ContextSectionKind='rollup'` 已存在但**无 producer**；`recent-conversation` 用 `rollup + 10` 只是优先级算术 | 摘要不需要改契约即可落地；但"rollup"这个名字此前是**空承诺** |
| **F-8** | 「失效闸」可以完全用**程序已知事实**实现（事件→记忆的 `sourceRefs`/`evidenceRootIds` + 记忆 `status`），**不需要**任何语义判断 | 把"这算是纠正吗"从摘要里**移出去**，交给记忆生命周期表达 ⇒ 该规则可写成硬零断言 |

### 7.2 阻塞（2 条，继承 WP0，未变化）

| 阻塞 | 现状 | 受影响包 |
|---|---|---|
| **P-1** M5.5.1 候选与收口 | 仍无 WP8 记录、无收官记录、无 `m5.5.1-complete` 标签 | WP6b · WP9b · WP10b |
| **P-2** INC-01 运行期保护 | 仍无 WP3/WP4/WP5；`src/main.ts` 零引用保护模块 | WP6b = `BLOCKED` |

**WP1 不受这两条阻塞**（它是纯设计轮），但 **WP6b/WP9b/WP10b 仍然受阻**：
`M6 = PASS` 因此**不可达**，直到 P-1/P-2 解决。这一点在契约 §1.1 已写成硬纪律。

### 7.3 偏差（如实登记）

| # | 偏差 | 理由 |
|---|---|---|
| B-4 | 计划书把 WP1 的门写成"部件门/接线门"式的表述，本轮**没有可跑的门** | WP1 交付物是设计文档；实现门属 WP2/WP3。**不发明**"文档门"来充数 |
| B-5 | 契约里给门的**分母**做了具体定义（合格来源总数需独立复算） | 计划书要求"每个新门的量程、硬零项、质量项及分母定义"；不定义分母就必然出现"分母为零也算绿" |

### 7.4 本轮**没有**扩大的能力主张

- 没有主张 ADR-050 已生效（状态是 `PROPOSED`）；
- 没有主张摘要能提升回答质量（质量阈值属 M6-D3 / WP9a）；
- 没有主张摘要是"完整的长期记忆压缩"（它是有界窗口内的逐字摘录）；
- 没有把 V-2 的**范围核对**说成"冻结面已实测未漂移"；
- 没有因为 D01 = CLOSED 就主张"措辞不会再说错"（`DR-11` 照旧）。

---

## 8. 下一包的准确入口、必读文件与 STOP 点

**当前 STOP 点 = 用户裁定。** 裁定表在 [ADR-050 §9](docs/adr/ADR-050-rolling-summary-provenance-boundary.md)。

| 情形 | 下一步 |
|---|---|
| **四项全部按建议获批** | ADR-050 → `ACCEPTED / DESIGN FROZEN`；进入 **WP2**（纯逻辑：契约 + 选择 + 渲染 + 失效） |
| 部分获批 / 要求改写 | 按裁定修订 ADR-050 与契约，重新提交；**WP2 仍不得开工** |
| 要求先解 P-1 / P-2 | 转 INC-01 WP3+ 或 M5.5.1 收口；**M6 的 WP2 可并行**（它不依赖真实库），但 WP6b 之后全部等待 |

**WP2 的入口（若获批）**：

| 项 | 内容 |
|---|---|
| 必读 | ADR-050（全部）· `M6-Acceptance-Contract.md` §3/§4.2 · `M6-Affected-Surface-Map.md` §3 · `src/kernel/recall/qualification.ts` · `src/kernel/contracts/attribution.ts:2509-2594` |
| 产出 | 新契约（`src/kernel/contracts/rollup.ts` 拟）+ 纯策略 + 部件门证据；`docs/m6/WP2-Handoff.md` |
| 必跑门 | `pnpm typecheck` · `pnpm kernel:test` · `pnpm kernel:verify` · 新 rollup 部件门（正控/负控/恢复三段式） |
| **STOP 点** | 部件门 PASS 后 STOP；**不得**顺手接线（接线是 WP3） |
| STOP 条件 | 需要改冻结面 / 需要真实库 / 需要放宽阈值或删失败样本 / 量具无非零正控 |
