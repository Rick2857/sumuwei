# M10 WP4 交接单

- 日期：2026-09-29
- 工作包：WP4（语义提案与明确请求链）
- 状态：**COMPLETE** —— 门 `m10:source:verify` = **PASS 40/40**
- 依据：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) §7.1–§7.3 · `D07` · `D28` ·
  [契约](M10-Acceptance-Contract.md) §8
- 前置：[`M10-WP3-Handoff.md`](M10-WP3-Handoff.md)（放行口就绪）
- 读数：[`M10-Semantic-Understanding-Report.md`](M10-Semantic-Understanding-Report.md)
- 本轮**没有**：打开真实库 · 调模型 · 出网

---

## 1. 交付了什么

| 交付物 | 位置 | 作用 |
|---|---|---|
| 草案契约 | [`src/kernel/contracts/goal-proposal.ts`](../../src/kernel/contracts/goal-proposal.ts) | 操作闭集（9 个）· 字段闭集（**双向**：必需缺失与不该带的都拒）· 12 条具名拒绝原因 + 可达性事实 · 唯一严格校验器 |
| 理解链 | [`src/kernel/app/goal/understanding.ts`](../../src/kernel/app/goal/understanding.ts) | 有界输入 · 硬期限 8000ms / 零重试 · **五态结论** · span 切片 · 草案 → 程序提案的唯一映射 |
| 语料 | [`evals/m10/goal-corpus.ts`](../../evals/m10/goal-corpus.ts) | 300 条 / 60 家族 / 六层 · 家族不跨 split · 指纹 `d1184a3034b46825` · 清单（计划值 / 缺口 / 重复 / 字段表） |
| 门 | [`scripts/m10-source-verify.ts`](../../scripts/m10-source-verify.ts) → `pnpm m10:source:verify` | 40 项（6 组） |
| 报告 | [`M10-Semantic-Understanding-Report.md`](M10-Semantic-Understanding-Report.md) | 语料读数 · 六步链 · 结构性边界 · **不主张什么** |
| 改动面映射 | [`scripts/gates/affected-map.ts`](../../scripts/gates/affected-map.ts) | M10 行补 `m10:source:verify` + `evals/m10/**` |

### 1.1 门读数（`m10:source:verify` = PASS 40/40）

| 组 | 项数 | 它对应哪条出口判据 |
|---|---|---|
| `A` 语料完整性与**分母** | 7 | ② 语义负控有有效分母（300 / 分片 / test 每层 ≥20 / 高风险 ≥30 / 家族不跨界 / 无重复 / 指纹稳定 / 关键负控非零） |
| `B` 300 条走通链 | 4 | ① 机械链全绿（正控）+ ③ 关键负控 0 条写事件 |
| `C` 12 条拒绝原因 | 13 | ③ 非法输出**记 invalid 不当 none** |
| `D` 传输 / 来源 / 空输入 | 5 | ③ 四态分列（transport / source_unusable / not_invoked 各自可达） |
| `E` 草案 → 提案映射 | 6 | 占位 id 被重写 · 五操作映射 · 三"不写"操作分列 · 乐观锁接上 · resume 失败关闭 · explicit_forget 带禁用根 |
| `F` 结构性边界 | 5 | 草案无程序事实字段 · 无文本 · 契约层无打印 · 输入形状不含金标说明 · 语料自称"规格" |

### 1.2 相关回归

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm m10:test` | **PASS 48/48**（WP3 门在本轮改动后仍绿） |
| `pnpm m10:inputs:verify` | **PASS 25/25** |
| `pnpm gates:verify` | **PASS 48 项 / 0 失败** |
| `pnpm fast:offline` | **34 道 · PASS 34 · FAIL 0** |
| 真实库 | **从未被打开**（本门 `databaseScope = not-applicable`：零数据库） |

### 1.3 证据（**两代**，与 WP0–WP3 同一纪律）

| 代 | runId | head | 说明 |
|---|---|---|---|
| 2（**权威**） | `artifacts/m10/m10-wp4-source-20260929-722c48c16439-389f/` | `722c48c`（WP4 文档提交） | 产生它的代码可被 head 定位（代码在其祖提交 `119e8657`） |
| 2（**权威**·另两门复跑） | `…-m10-wp3-test-20260929-722c48c16439-9432/` · `…-m10-wp2-inputs-20260929-722c48c16439-e592/` | `722c48c` | 48/48 · 25/25（改动后仍绿） |
| 1（历史） | `artifacts/m10/m10-wp4-source-20260929-f519771e8ccb-7324/` | `f519771` | 跑的时候 WP4 代码还没提交 ⇒ head 指不到它。保留、不回写 |

---

## 2. 三条在实现里定形的东西

### 2.1 五态结论**不得合并**

```text
understood / invalid / transport / source_unusable / not_invoked
```

`invalid` 与 `transport` 都**不是** `none`。把故障读成"她没提目标"是本项目最坏的失败模式之一
（她本该说"我没听懂"或"这次没查成"，结果什么都没说）。门把它们分别触发一次（`D1`–`D5`）。

### 2.2 草案**双向**字段闭集

不只判"必需字段缺失"，也判**"不该带的字段出现了"**（`C10`：在 `pause` 上带 `statement`
= 想偷偷改描述）。只判前者会让"模型顺手多写一个字段"静默通过。

### 2.3 草案**不携带文本**，也不携带程序事实

- **无文本**：只有 `span` 坐标；切片一律由程序从原话取（`B4` 实测 300/300 切片 === 原话）。
  ⇒ "用生成的字当原文证明"在**类型上**不可能。
- **无程序事实**：字段闭集里没有 `goalId` / `userId` / `sourceEventId` / `evidenceId`。
  目标只能从程序给的候选里选；`create` 的 id 由放行口重算重写（`E1` 实测占位 ≠ 派生）。

---

## 3. 一处**刻意的失败关闭**（装配层必须知道）

`resume` 草案映射出的 payload，其 `recheck` 缺省是 `{ hard: 0, soft: 0, dropped: 1 }`
—— 即"**有依赖被丢弃**"。后果是放行口**拒绝**它（`E5` 实测）。

**这是有意的**：恢复要求"依赖复核通过"（§4.6），而复核读数来自 WP2 的输入端口，
本模块**不知道**也**不猜**。装配层必须在提交 `resume` 之前跑一次
`recheckGoalDependencies` 并把真实读数填进去 —— 忘了接线就会**失败关闭**，
而不是"静默恢复一个前提已经烂掉的目标"。

---

## 4. 具名限制（交给 WP11 的 Known-Limitations）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-09` | 本轮的语料金标由**实现者**撰写，**没有**独立的第二双眼睛 | `U-15`。WP10 之前必须由用户过一遍；否则"金标正确"没有独立证据 |
| `L-M10-10` | `m10:source:verify` 用**固定 provider**，因此它**不**度量模型语义质量 | 见报告 §0。真实模型读数属 WP10（`m10:semantic:eval`） |
| `L-M10-11` | `query` 类语料只有 **3** 条 | `U-16`：它是低频用法，但 3 条不足以支撑分类指标；WP10 扩到 ≥15 |
| `L-M10-12` | 草案的 `successCriterion` 在映射时**恒为 `user_report`** | 映射层没有从自然语言推 criterion 的能力（那需要"成功条件"的专门理解）。承诺类 criterion 由 WP5/WP6 的装配决定；v1 的目标一律"只有用户能说它完成"是**保守**方向 |
| `L-M10-13` | `revise` 草案只带 `changed: ['statement','nextStep']` 与 `nextStep` | 映射层**不**猜"用户想改哪几项"；真正的字段选择要么由 WP5 的装配在候选比较后决定，要么等更细的草案形状（那会改 `goal-proposal@1`） |

---

## 5. 下一步入口

**WP5：依赖失效、Goal 遗忘与冲突处理。**

```text
输入  ADR-076 §4.6（三类依赖的处置）· §5（遗忘与取消的分野）· `D09` · `D10`
      + `L-M10-08` 的留白（GOAL_SUPERSEDED 时 active 承诺的处置 —— **必须在这里裁定**）
      + WP2 的 recheckGoalDependencies / applyGoalInvalidationOverlay（已就绪）
      + WP4 的 resume 失败关闭接线点（见 §3）
载体  src/kernel/app/goal/ 的失效判定 + 遗忘遮蔽 + 冲突澄清
出口  三类依赖的处置逐条可达；「忘掉目标」与「取消」的读侧差异可机器判定；
      同轮遮蔽独立于写侧；旧根禁用不因内容再次出现而解除
门    m10:invalidation:verify（新增）
```

**提醒**：WP5 必须裁定 `L-M10-08`（supersede 一个带 active 承诺的目标 ⇒ 那个承诺算什么）。
今天放行口**不**强制它，因此它现在是一个**真实的空洞**，不是"已经处理好了"。
