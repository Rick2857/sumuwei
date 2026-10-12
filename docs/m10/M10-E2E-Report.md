# M10 端到端报告（E2E Report）

- 日期：2026-09-30
- 依据：计划 **§21.2** 点名的交付物之一（"至少交付：… **E2E Report** …"）
- 定位：本文件**只**报**离线端到端**（**真网关链路 + 隔离库 + 离线固定 provider**）
- 机器判据：`pnpm m10:e2e:verify`

> ⚠️ **`Live chain` 与 `Long trajectory` 是 §21.1 的另两个槽**，**不**在本文件里冒充：
> 前者被 `L-M10-61` 挡住（根因已定位，见交接单 §6.13），后者的读数在
> `m10:long:verify`（200 轮与 500 轮两条**独立**读数）。

---

## 1. 读数（**分组分列，不合成一个总分**）

```text
pnpm m10:e2e:verify   →  PASS 19 / 19
分组：G = 11 / 11   （场景与链路正控）
      C = 3 / 3     （两个崩溃窗口 + 待收敛计划的真库往返）
      X = 4 / 4     （三种"伪装形状" + 它们合起来看）
      Z = 1 / 1     （measured_count > 0 自检）
真实库被触碰：**false**（`realDbTouched=false`，机器字段）
```

⚠️ **`Z1` 自检**：真的建了事件与投影行、真的跑了多轮（`事件 2 · 行 2`）——
"0 事件 / 0 行"与"全部通过"在输出上长得一样（AGENTS §6.8）。

---

## 2. 这一门测什么、**不**测什么

```text
测    ：用户原话 → 固定 provider → 严格校验 → 放行口 → 事件落库 → 投影行 → 上下文 → 开发者面
        （驱动的是 `runGoalTurn()` —— 目标域**唯一的编排入口**）
不测  ：它**不**主张"网关已接线"（该门自己的头部逐字如此）。
        把编排注册进 `TurnGateway` 是**另一件事**，登记为 `U-20`（网关侧已就绪），
        而**装配层**接进 `main.ts` 是 **G-2 / `L-M10-48`**。
边界  ：① `isolateDatabase()` 一次性沙箱库（门顶部）；**真实库从不被打开**
        ② **零模型调用、零出网**（provider 是离线固定实现）
        ③ 每条检查都有非零分母；失败路径强退
```

---

## 3. 19 条检查逐条

### 3.1 G 组：场景与链路（11 条）

| id | 它证明什么 | 实测 |
|---|---|---|
| `G01` | **全链正控**：原话 → provider → 严格校验 → 放行口 → 落库 → 投影行 | `accepted · 1 事件 · 1 行 · trace.validation=accepted` |
| `G37` | 换话题/拒绝推进：目标仍 `active` 但本轮**不执行** | `active · 事件未增=true` |
| `G39` | **数据保全**：两条记录都保留（行数 == 场景建的行数）⚠️ 见 §5 | `行 2 · 冲突成员 0` |
| `G40` | 预算不足：最终入模计数是**真实值**，每个未入模项带**具名原因** | `入模 0 项 · budget_exhausted · dropped=[…beyond_token_budget]` |
| `G41` | 注入正文只当**数据**：事实块 `kind=instruction` 且内容由程序生成 | `fact 含用户原话=false · state kind=goals` |
| `G42a` | `off` 档形状：provider 给 `none` ⇒ 无可操作 | `no_operation · 0 事件 · 0 行` |
| `G42b` | `off` 档**不产事实块**（`D29`：`none` 不是"没写成的操作"） | `fact=false · outcome=no_operation` |
| `G42c` | 真的过 provider：两条 section 都产 **0 个**（不是"空块"） | `0 + 0` |
| `G44` | 开发者面从**真库**读回，执行与聊天**同一份遗忘资格** | `行 2 · 返回 1 · excluded=[…reason=masked]` |
| `G44b` | 遮蔽态的字段集里**没有内容字段** | `字段集=[dependencyCounts,goalId,masked,…]` |
| `G45` | 重启与重建：删投影行后全量重放 ⇒ 与增量**逐字段相同**，且同一折叠核心 | `相同=true · 重放事件=2` |

### 3.2 C 组：两个崩溃窗口与恢复（3 条）

| id | 它证明什么 | 实测 |
|---|---|---|
| `C1` | **窗口 A**（变更已提交、回复未落盘）⇒ `read_back_and_explain`，**禁止**补造 assistant 事件 | `window_a · mustNot=[fabricate_assistant_event]` |
| `C2` | **窗口 B**（结果已落盘、兑现未提交）⇒ `idempotent_backfill`，**禁止**重生成产物/重发副作用 | `window_b · mustNot=[regenerate_artifact,resend_side_effect]` |
| `C3` | 待收敛标记经**序列化往返**仍给出**同一个有界计划**（≤32 · `truncated` 如实报出） | `32 项 · truncated=8 · pending_markers` |

### 3.3 X 组：三种"伪装形状"（4 条）

| id | 它证明什么 | 实测 |
|---|---|---|
| `X1` | 空记录：池为空 + provider 引用不存在的目标 ⇒ **不能**得出 `accepted` | `invalid_output · candidate_goal_not_provided` |
| `X2` | 全失败：provider 每次抛错 ⇒ `transport_failed`（**不是** `no_operation`） | `transport_failed · provider_error` |
| `X3` | 坏 JSON ⇒ `invalid_output` 且带**具名**原因 | `invalid_output · reason=not_an_object` |
| `X4` | 三种一起看：各跑一轮后领域事件**一条都没多** | `2 → 2` |

### 3.4 Z 组：计量自检（1 条）

| id | 它证明什么 | 实测 |
|---|---|---|
| `Z1` | `measured_count > 0`：真的建了事件与投影行 | `事件 2 · 行 2` |

---

## 4. 这一门**最有价值**的部分

```text
① **两个崩溃窗口各有具名恢复路径，且"禁止做什么"是机器字段**
   `C1` 的 `mustNot=[fabricate_assistant_event]` —— "她可能没看到"不许变成"她一定看到了"
   `C2` 的 `mustNot=[regenerate_artifact,resend_side_effect]` —— "完成一次"不许做成两遍
② **三种伪装形状必须与"好结果"分开**：空记录 / 全失败 / 坏 JSON
   ⇒ 各自的结论都**不是** `no_operation`，且合起来看事件一条没多（`X4`）
```

---

## 5. 本门的一条检查**曾经空过**（`L-M10-64`，已修）

`G39` 的原判据 `members.length <= allRows.length && members.join(',') === […].sort().join(',')`
**对任何输入都成立**（子集不可能更大；有序恒真），而标签却声称测了「具名澄清」与「两条记录都保留」——
**两样都没测**；实测该样本 `冲突成员 = 0` ⇒ **本样本根本没有冲突**。

⇒ 已修：断言改成「**行数 == 场景建的行数（2）**」（合并/删除会真的红 ——
用错期望值实测过 **18/19**），标签**明说本样本不含冲突**，
并把冲突判据指向它真正的家 `m10:invalidation:verify` 的 `C1`–`C5`（含负控 `C3`）。
⇒ **覆盖账的 `G39` 一行已改为只引 invalidation 门**，不再拿这条空检查充当覆盖。

⚠️ **仍未做**：让 e2e 场景**真的产生一对冲突目标**（会牵动 `Z1`/`X4` 的计数断言 ⇒ 独立改动）。

---

## 6. 与 §21.1 那 14 个槽的关系

```text
本文件支撑的槽：Mechanical gates（其中端到端那一部分）
它**不**支撑的槽：Live chain（`NOT RUN`）· Long trajectory（另有独立读数）·
                  Semantic evaluation（`NOT RUN`）· Human review（`PENDING`）
⇒ 本文件是 **Mechanical gates** 槽的证据之一，**不是**整个 §21.1 判定的载体
```

---

## 7. 本报告**不**主张什么

```text
① 不主张网关已接线：本门驱动 `runGoalTurn()`；注册进 `TurnGateway` 与装配进 `main.ts`
   分别是 `U-20`（已就绪）与 **G-2 / L-M10-48**（未做）
② 不主张 live 达标：被 `L-M10-61` 挡住（根因已定位，修法待裁定）
③ 不主张语义质量：那一槽一次都没跑（`NOT RUN`）
④ 不主张"19/19"等于覆盖了 §14 的全部场景：场景覆盖账在
   `M10-Scenario-Coverage.md`（本门只覆盖其中一部分）
⑤ 不主张模型行为：本门**零模型调用**，provider 是离线固定实现
```
