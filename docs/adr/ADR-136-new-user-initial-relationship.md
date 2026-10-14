# ADR-136 —— 新用户初始关系值的落库方式（U1 / WP3）

日期：2026-10-14（Asia/Shanghai）。状态：**ACCEPTED / DESIGN FROZEN** —— 原主人 2026-10-14 裁定：**采用方案 A**（新增具名来源种类 + 独立播种器）。
`R-WP3-1…3` 由本 ADR 取**推荐默认**（原主人未逐项指定；若要改，只改这三行，不影响 A 的其余设计）：

```text
R-WP3-1 名字   = NEW_USER_BASELINE
R-WP3-2 0.2/0.2 = **固定常量**（引用 scope.ts 的 NEW_USER_INITIAL_RELATIONSHIP，不额外做配置项）
R-WP3-3 时机   = **首次幂等建档成功时**（与 U1-WP2b-2b 的身份接线同一处；不早于建档成功）
```
归属：多用户补充计划 **U1**（[`ADR-133`](ADR-133-multi-user-scope-and-authorization.md) §5 的"实现后果"；`WP1 交接单` §4 的 WP3）。
上游裁定：原主人 2026-10-13 —— **新用户首次建档 `trust = 0.2` / `closeness = 0.2`，不继承 0.85/0.60、不重置既有关系**
（载体 [`Multi-User-and-Rejection-Rulings-2026-10-13.md`](../post-lv2/Multi-User-and-Rejection-Rulings-2026-10-13.md)）。

> ⚠️ **本 ADR 是设计，不是实现**。它不改 `src/**`、不建表、不迁移、不激活。
> ⚠️ 之所以必须**另立 ADR**：本项要动的是 **M7 冻结契约**（关系 ORIGIN 的来源种类闭集），
> 按 AGENTS"涉及冻结的记忆或 reducer 语义变更时另立 ADR/里程碑和全套相关门"。

---

## 1. 为什么不能"顺手改一行"

### 1.1 关系**必须先建档**才能累积（reducer 硬闸）

`src/kernel/projections/relationship.ts`：

```text
:127-146  ORIGIN 折叠：写入 originated=true、trust/closeness（夹到 0..1）、originKind、锚 = 事件时间
:130-136  重复 ORIGIN ⇒ **硬错误** relationship_origin_duplicate
:151-157  **IMPACT 要求已建档且锚非空**，否则硬错误 relationship_origin_missing
```

⇒ **"不给新用户建 ORIGIN、让关系从真实互动自然长出来"在当前冻结 reducer 下做不到**：
没有 ORIGIN 就没有锚，第一条 IMPACT 就会被拒（失败关闭）。而印象门槛本身也要求 `originated = true`。
⇒ 新用户**必须**拿到恰好一条 ORIGIN。真正要定的是它的**来源种类**与**值**。

### 1.2 今天的 ORIGIN 播种器是"为原主人写死的"

`src/infrastructure/runtime/adapters.ts`：

```text
:385  seedRelationshipOrigin(runtime, characterId, userId, now)
:418-427  payload = { trust: 0.85, closeness: 0.6, originKind: 'SETTING_BASELINE',
                      basis: '用户授权的角色设定基线（ADR-064 U-M7-02：从小一起长大…）' }
:450  返回语也写死 '（SETTING_BASELINE 0.85/0.60）'
:394-397  幂等：已有投影 ⇒ no-op
:437-442  走**完整放行链**（提案 → Validator → applyAcceptedEvents），被拒 = 不播种
```

调用点：`src/main.ts:3576`（开机；仅 `CHARACTER_RELATIONSHIP_CONTEXT_ENABLED` 打开时）。

⇒ 关键风险：**这个函数对任何 `userId` 都给 0.85/0.60**。若把它直接用于新用户，
就正好违反原主人"不继承原主人的 0.85/0.60"。所以不能只改调用点。

### 1.3 来源种类的闭集是**被门钉住**的

```text
src/kernel/contracts/relationship.ts:139  RELATIONSHIP_ORIGIN_KINDS（今天 4 值：
                                          SETTING_BASELINE / INTERACTION_DERIVED /
                                          MAINTENANCE_INJECTION / STORY_DERIVED）
                                     :151  originKindAcceptedByM7（放行口接受集，M7 拒 MAINTENANCE_INJECTION）
src/kernel/policies/relationship-validator.ts:382  不在接受集 ⇒ relationship_origin_kind_invalid
scripts/m7-wp2-contracts.ts:425        断言 RELATIONSHIP_ORIGIN_KINDS.length === 4   ← **会红**
```

---

## 2. 备选与裁定

| 备选 | 内容 | 判定 |
|---|---|---|
| **A（推荐）** | **新增一个来源种类**（如 `NEW_USER_BASELINE` / `ONBOARDING_BASELINE`）+ **独立的播种函数**（吃显式值，默认 0.2/0.2），只用于**首次建档**；原主人仍走 `SETTING_BASELINE` 0.85/0.60 | ✅ 来源诚实、可审计；代价是"改冻结闭集 + 改一道 M7 契约门的断言" |
| B | 复用 `SETTING_BASELINE`，按用户给不同值 | ❌ **否**。该值的定义逐字是"**用户授权的角色设定基线**（十几年共同长大，是设定不是经历）"。给新用户写 4 就变成"来源说谎"：读回面只显示 `originKind` + `basis`，审计无法区分"人给的设定"与"系统给的初始值"（违 `INV-CI-01` 的来源可判） |
| C | 复用 `INTERACTION_DERIVED` + 固定 0.2/0.2 | ❌ **否**。它的定义是"由**真实互动证据**推导"；首见**没有任何互动证据**，且 IMPACT 走的是另一条带证据链校验的路。误标来源 |
| D | 不建 ORIGIN，让关系从互动长出来 | ❌ **在冻结 reducer 下不可能**（§1.1 的 `relationship_origin_missing` 硬闸）。若要走 D，等于要改 reducer 的建档语义 —— 那是更大的冻结层变更，代价高于 A |

⇒ **推荐 A**。本 ADR 的其余部分按 A 展开；B/C/D 作为历史备选保留。

---

## 3. A 的落地形状（**待裁定后**才实施）

```text
① 契约：RelationshipOriginKind 追加一个值（名字待裁定，本 ADR 暂写 <NEW_USER_BASELINE>）
   · RELATIONSHIP_ORIGIN_KINDS 追加；originKindAcceptedByM7 接受它
   · 语义写进注释：**系统在首次建档时给的初始值**，既不是用户授权设定、也不是互动推导
② 常量：新用户初始值 0.2/0.2 一处定义
   · 已有 `NEW_USER_INITIAL_RELATIONSHIP`（src/kernel/contracts/scope.ts，U1-WP1 已落）
     ⇒ 播种器**引用它**，不另造一份数字
③ 播种器：新增 `seedRelationshipOriginForNewUser(runtime, characterId, userId, values?, now?)`
   · **不改** `seedRelationshipOrigin`（原主人路径逐字节不动）
   · basis 文本必须如实："新档案的初始关系值（非设定基线、非互动推导）"
   · 幂等与放行链与既有播种器**同形**（复用同一条 Validator/applyAcceptedEvents 链）
④ 接线：只在"首次幂等建档"成功时调用一次（与 U1-WP2b-2 的身份接线同一处）
   · **开关缺省 off**；生产开通仍须先过 S1 零失败门（计划 §7）
⑤ 不改：Projection 表结构、事件表结构、reducer、衰减参数、渲染分带、原主人基线
   （`originKind` 住在事件 payload 与投影 state JSON 里 ⇒ **无需迁移**）
```

---

## 4. 影响面与必须复跑的门（**这是"另立 ADR"的代价**）

| 面 | 影响 | 处置 |
|---|---|---|
| `RELATIONSHIP_ORIGIN_KINDS` 闭集 | 4 → 5 值 | **改契约**（本 ADR 授权范围内） |
| `scripts/m7-wp2-contracts.ts:425` | 断言 `length === 4` ⇒ **会红** | **改写量具**：断言改成"闭集恰好是 {5 个具名值}"（**不是**放宽成 `>= 4`）；并新增"新值被接受、MAINTENANCE_INJECTION 仍被拒"的正负控 |
| `m7:*`（关系线各门） | 契约变更 | 复跑 |
| `m8:*` / `m8.5:*` / `m9:*` / `s8:*`（多处调用 `seedRelationshipOrigin`） | 播种器行为未变，但契约闭集变了 | 复跑相关门（至少 `m8:e2e`、`m9:e2e`、`postlv2:s8:state`） |
| 渲染 / 读回（`renderRelationshipReadback`、`renderRelationshipSection`） | 新种类会出现在读回里 | 如实显示；**不**新增"亲密度数字"文案 |
| 数据 | 无新表、无迁移 | — |

⚠️ **不许**用"改断言让它过"的方式处理 `m7-wp2-contracts`：那条断言的价值正是
"闭集不许悄悄长大"。改它必须**同时**把新值写进断言与文档，并在提交信息里可见。

---

## 5. 待原主人裁定

| 编号 | 待定 | 候选 |
|---|---|---|
| `R-WP3-1` | 新来源种类的**名字** | `NEW_USER_BASELINE` / `ONBOARDING_BASELINE` / `INITIAL_ARCHIVE_BASELINE` |
| `R-WP3-2` | 0.2/0.2 是**固定常量**还是**可配置** | 固定常量（推荐，简单可审计）/ 由配置给（多一处可漂移的数字） |
| `R-WP3-3` | 首个 ORIGIN 的**时机** | 首次幂等建档成功时（推荐）/ 首次收到该用户消息时（可能先于建档成功） |

**裁定前**：本 ADR 保持 **PROPOSED**；`originKind` 闭集**不动**，WP3 **不得**开工。

---

## 6. 与既有判定的关系

```text
· 不改 M7 的基线值语义（原主人 0.85/0.60 与 SETTING_BASELINE 一字不动）
· 不改 reducer / 衰减 / 分带 / 证据资格（D-3 仍是"只有 confirmed 互动推动关系"）
· 不改 M4/M8/M9/M10 任何冻结语义
· 不主张多用户隔离已就绪；不激活任何入口
```
