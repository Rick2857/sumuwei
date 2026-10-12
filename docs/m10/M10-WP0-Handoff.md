# M10 WP0 交接单

- 日期：2026-09-29
- 工作包：WP0（基线、风险探针和范围校准）
- 状态：**COMPLETE** —— 计划 §12 WP0 六问 **6/6 ANSWERED**，无 `BLOCKED`
- 权威读数：[`M10-Baseline-Report.md`](M10-Baseline-Report.md)（本交接只给"下一手要什么"）
- 证据：`artifacts/m10/` 下 6 个 runId（两代，见基线报告 §0.1；失败档保留不回写）
- 本轮**没有**：打开真实库 · 调模型 · 出网 · 改历史文档或证据

---

## 1. 本轮交付

| 交付物 | 位置 |
|---|---|
| 基线报告 | [`M10-Baseline-Report.md`](M10-Baseline-Report.md) |
| 本交接单 | `M10-WP0-Handoff.md` |
| 基线 manifest + before/after（**当前代**，head = `decd2d2`） | `artifacts/m10/m10-wp0-20260929-decd2d215419-561d/` |
| 准入审计 + manifest（**当前代**） | `artifacts/m10/m10-wp0-admission-20260929-decd2d215419-bd31/` |
| 第一代证据（head 早于工具提交，**保留不回写**） | `artifacts/m10/m10-wp0-*81b91122d9c0*`（4 个 runId，含量具缺陷档） |
| 新命令 | `pnpm m10:baseline` · `pnpm m10:wp0:admission` |

新增文件 3 个（`scripts/m10-evidence.ts` · `scripts/m10-baseline.ts` · `scripts/m10-wp0-admission.ts`）、
点追加 1 处（[`package.json`](../../package.json) 两条脚本）、新增文档 2 份。
**计划书 [`M10-Execution-Plan.md`](M10-Execution-Plan.md) 一字未改。**

---

## 2. 交给 WP1 的十条输入

WP1 不必重新侦察仓库 —— 下面十条已带代码指针与实测读数（详见基线报告 §3）。

| # | 输入 | 指针 / 读数 |
|---|---|---|
| 1 | **Memory 真实 revision 怎么取** | [`memory-store.ts:330`](../../src/infrastructure/persistence/memory-store.ts#L330) 读映射 + [`:825`](../../src/infrastructure/persistence/memory-store.ts#L825) 递增；E1 实测 1→2 |
| 2 | **M9.5 fixture 的两处缺口** | [`handoff-fixtures.ts:84`](../../src/kernel/app/recall/handoff-fixtures.ts#L84) 固定 `sourceRevision=1`；[`:70`](../../src/kernel/app/recall/handoff-fixtures.ts#L70) 复核只是回调 ⇒ **WP2 新建真实引用路径** |
| 3 | **Belief 资格复用口** | [`eligibility.ts:110`](../../src/kernel/app/belief/eligibility.ts#L110) + [`:222`](../../src/kernel/app/belief/eligibility.ts#L222)；`listActiveBeliefs` 只按 status 过滤（[`belief-store.ts:123`](../../src/infrastructure/persistence/belief-store.ts#L123)）**不够用** |
| 4 | **用户归因从哪来** | [`main.ts:93`](../../src/main.ts#L93) → [`conversation-attribution.ts:332`](../../src/infrastructure/runtime/conversation-attribution.ts#L332) → [`attribution.ts:2583`](../../src/kernel/contracts/attribution.ts#L2583)；E3 实测 `ESTABLISHED` |
| 5 | **assistant 事件落盘时机 + 崩溃窗口** | [`turn-gateway.ts:2059`](../../src/kernel/app/turn-gateway.ts#L2059) / [`:2116`](../../src/kernel/app/turn-gateway.ts#L2116) / [`:2134`](../../src/kernel/app/turn-gateway.ts#L2134)；失败**不吞**（[`:2080`](../../src/kernel/app/turn-gateway.ts#L2080)） |
| 6 | **幂等补记接口** | [`event-store.ts:149`](../../src/infrastructure/persistence/event-store.ts#L149) + [`:174`](../../src/infrastructure/persistence/event-store.ts#L174) + [`migrations.ts:232`](../../src/infrastructure/persistence/migrations.ts#L232)；E4a 实测 created 1→0 / dedup 0→1 / 同 eventId |
| 7 | **迁移目标** | **实测支持 NONE**；先例 [`belief-store.ts:11`](../../src/infrastructure/persistence/belief-store.ts#L11)；带一条**代价**（族读取线性，见 #10） |
| 8 | **规模探针读数** | 60 条 `goal:<id>` 行；第 1 / 51 / 最老按 ID 全部可读（1/0/1 ms）；上界形状一条 `state` ≈ 1684 字节 |
| 9 | **Context 注入点的既有事实** | `'goals' // M10` + `goals: 45` 已在场；⚠️ 与 [`externalEvidence: 45`](../../src/kernel/contracts/context.ts#L123) **同数**，字典序下外部证据优先 ⇒ WP7 须显式裁定 |
| 10 | **族读取代价** | [`listProjections`](../../src/infrastructure/persistence/event-store.ts#L462) 无前缀条件；[`belief-store.ts:102`](../../src/infrastructure/persistence/belief-store.ts#L102) 是内存前缀过滤 ⇒ 随**全部**投影行线性增长（WP3 选表 / WP9 实测） |

---

## 3. WP1 必须冻结的东西（计划的验收契约清单）

WP1 的出口是"没有影响授权、失效传播、完成或遗忘语义的悬而未决项"。
以下按计划 §5–§7 与 §20 列出**必须**在 `M10-Acceptance-Contract.md` 里定形的最小集：

1. **Goal 身份**：`goalId` 派生（owner + 受理来源事件 + 操作身份；**不只用内容哈希**）
   —— 必须同时满足计划 §5.1 的两条反例：同内容重新设立可得**新身份**、
   同操作重复投递**幂等**（M9 的 F-4/F-5 不许重演）。
2. **字段闭集**：`§5.1` 的 `statement` / `successCriterion`（**闭集 criterion kind + 参数 + 证据要求**，
   不能是"LLM 判断达成"）/ `status` 六态 / `priority` / `dependencies` /
   `nextStep`（至多一个）/ `time` 三分离 / `commitment?` / `supersedesGoalId?`。
3. **事件族与 payload 上限**：`GOAL_*` 8 个 + `COMMITMENT_*` 5 个（计划 §8.1）；
   每个都要给 `maxPayloadBytes` 与 `validatePayload` 形状
   （沿用 [`DomainEventRegistry`](../../src/kernel/contracts/domain-event.ts#L264) 的模式）。
4. **两条转换表**：Goal（计划 §6.1）与 Commitment（§6.2）的**合法边全集**与**非法边**。
5. **三种达成依据的边界**：`user_report` / `conversation_output` / `action_result`（计划 §5.3）；
   尤其"Goal 可以 user_report 完成，但**不**顺带把角色承诺判 fulfilled"。
6. **来源资格矩阵**（计划 §7.1）落成**可拒可查**的判据：
   每格给允许/拒绝 + 拒绝码；且**不与** M5.1.1/M9 的既有资格链冲突。
7. **遗忘与取消的分野**（计划 §8.3 / `M10-D10`）：Goal 正文可能复制被忘取值
   ⇒ v1 的处置（整项退出普通上下文 + 不含原取值的 blocked 原因）、
   "忘掉目标"与"取消但保留历史"两条路径的事件形状。
8. **三类依赖失效的处置**（计划 §8.2）：原始设立/接受证据 · 必要事实前提 · 可选规划偏好。
9. **多目标选择的确定性规则**（计划 §6.4）：至多 1 焦点 Goal / 1 nextStep / 至多 3 项入模，
   同分按稳定 ID；候选超限的**裁剪记账**形状。
10. **上界与默认值**：`goals` 块 token 上限（推荐 500）、最多项数（推荐 3）、
   完成时限（推荐总 8 秒、零隐式重试）、每轮至多 1 次 Goal 理解调用 —— **推荐值不是已测值**，
   冻结时要么接受为设计值、要么写明"待 WP4 实测后修订并记录原因"。
11. **开关名与缺省**：`CHARACTER_GOALS_ENABLED`（代码缺省 **false**）；
   生产激活属 WP12 独立裁定。
12. **`M10-Unresolved-Decisions.md`**：把本文 §4 的未决项**全部**收进去；
   影响授权/失效/完成/遗忘语义的项**不得**留白。

---

## 4. 具名欠账与未决项（WP1 收进 `M10-Unresolved-Decisions.md`）

| 编号 | 项 | 现状 | 归属 |
|---|---|---|---|
| WP0-D1 | **真实库 schema 版本**（文档 v9 vs ADR-075 的 v2） | **未决**（WP0 未开库，不猜） | WP12 / 需要只读副本时 |
| WP0-D2 | **`goals` 与 `externalEvidence` 同为 45 的平局** | 事实在案，**未裁定** | WP7（或 WP1 的 ADR） |
| WP0-D3 | **`.env.test` 端点可达性预检**（计划 §7.3） | 未做（与 WP0 零调用硬边界冲突） | WP4 首次真模型调用前 |
| WP0-D4 | **`m10:*` 门清单** | 只落地 2 条；计划 §16.1 其余全部未实现 | WP3 起逐步 |
| WP0-D5 | **`scripts/gates/affected-map.ts` 未登记 M10 行** | 具名欠账（登记会引用不存在的门 ⇒ 失败关闭） | WP3（`m10:test` 落地后） |
| WP0-D6 | **量具三段式**（正控/负控/恢复）未做 | 只做了分母自检 + 两轮对照 | WP8 `m10:measurement:verify` |
| WP0-D7 | **Q4 端到端探针**（落盘成功/失败两种形状） | 具名交接，非"已验" | WP6 `m10:completion:verify` |
| WP0-D8 | **族读取的线性成本** | 实测读数在案（60 行），**未做**规模曲线 | WP3 选表裁定 / WP9 规模门 |
| WP0-D9 | **`duplicate_content` 先于幂等键闸命中** | 如实读数在案 | WP3/WP6：兑现补记必须自带确定性事件身份 |
| WP0-D10 | **`.gitignore` 缺 `artifacts/m10/local/` 忽略规则** | 刻意未加（保护对象尚不存在；现在加会让基线摘要与最终树状态不一致） | **WP10 前置**：在创建 `artifacts/m10/local/` **之前**必须加（M6/M8/M9/M9.1/M9.5/M9.6 的既定约定） |

---

## 5. 命令与证据

```bash
# WP0 的两条命令（本轮新增）
pnpm m10:baseline --out artifacts/m10/<runId> --phase before
pnpm m10:baseline --out artifacts/m10/<runId> --phase after
pnpm m10:wp0:admission

# 最小纪律（AGENTS §5）
pnpm typecheck          # 本轮唯一跑过的产品门
```

| 读数 | 值 |
|---|---|
| 基线（before/after，当前代） | `BASELINE CAPTURED`（真实库摘要 `8c8a196b9330fa01…` 前后逐字相同） |
| 准入审计（当前代） | `ADMISSION PASS 33/33`（head = `decd2d2`） |
| 准入审计（第一版量具） | `ADMISSION FAIL 30/32` —— **保留**，归因为量具缺陷（基线报告 §4.2） |
| 回归（新工具是否破坏既有门） | `pnpm fast:offline` = 34 道 · PASS 34 · FAIL 0（**非发布档**，只证明没破坏既有门） |
| 真实库 | **从未被打开** |

---

## 6. 纪律提醒（下一手最容易踩的）

1. **实验必须先隔离**：`isolateDatabase()` 必须在碰数据库的 import **之前**（AGENTS §7）。
2. **真实库**：只有 `src/main.ts` 与带"只允许 SELECT"机器闸的只读验收脚本能开它；
   任何需要数据的实验走一次性副本或沙箱。`data/` 被 gitignore ⇒ **不能用 git 证明它没被动**。
3. **端点分列**：真模型档一律 `pnpm with-test-model <cmd>`；它**拒绝**回落生产 key（G1）
   且**拒绝**真实聊天形状（G2）。生产端点 ≠ 验收端点，报告里必须分列。
4. **失败档不回写**：作废量具档、额外复跑与正式批次都保留各自归属，不得覆盖成最终 PASS。
5. **提交纪律**：只按路径 `git add` 自己的文件；共享文件（`package.json`）用**点追加**；
   **不要** `git add -A` / `git clean -fd`。
6. **跑门与提交不同时**：先提交脚本，再跑门出证据，然后单独提交证据 ——
   这样证据里的 `head` 才指向产生它的那次脚本提交。
7. **计数型检测器自检 `measured_count > 0`**：0 检查 0 失败 = `MEASUREMENT INVALID`，**不是** PASS。

---

## 7. 下一步入口

**WP1：ADR、验收契约与判分规范。**

```text
输入  本交接 §2（十条）+ §3（必须冻结的十二项）+ §4（十项欠账）
载体  新 ADR（编号以开工时未占用者为准）+ M10-Acceptance-Contract.md
      + M10-Unresolved-Decisions.md + M10-WP1-Handoff.md
出口  没有影响授权 / 失效传播 / 完成 / 遗忘语义的悬而未决项
      （普通实现命名不阻断）
```

WP1 **不需要**重新侦察仓库，也**不**要求 M9.6 先变成可采用
（`M10-D18`：Jev 不作为依赖）。
