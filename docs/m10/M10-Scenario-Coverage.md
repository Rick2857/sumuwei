# M10 §14 场景矩阵覆盖账（G01–G48）

- 日期：2026-09-30
- 依据：计划 §14「验收场景矩阵（48 项最低集合）」+ 契约 §3 的冻结判据
- 出口原文：**"每项都要有非零测量"**；WP11 的**"未跑项不写 PASS"**
- 机器判据：`pnpm m10:coverage:verify` —— 本表的每一行都被核过：
  编号齐不全 · 门是否已登记 · **检查 id 是否真的存在于那道门的最新证据里** ·
  非 `COVERED` 的行是否**写了理由**

> ⚠️ **"覆盖"的定义**：该项目有一条**具名检查**在**真实证据**里存在**且通过**。
> 不是"文档提到过它" —— `grep` 到编号不算覆盖。**这一条是本表的全部价值。**

| ID | 场景 | 覆盖它的门 | 检查 | 状态 | 说明 |
|---|---|---|---|---|---|
| G01 | 明确设立目标 | `m10:test` / `m10:e2e:verify` | L1 / G01 | COVERED | 全链与纯内核两侧都跑 |
| G02 | 同事件重复投递 | `m10:test` / `m10:long:verify` | X21 / L8 | COVERED | X20 是它的正控半边；L8 走真链 |
| G03 | 随口愿望 / 闲聊 | `m10:source:verify` | B3 | COVERED | 金标 `none`/`clarify` 的条目**没有一条**产生写 |
| G04 | 否定 / 假设 / 玩笑 | `m10:source:verify` | B3 / A7 | COVERED | 关键负控分母非零（A7） |
| G05 | 第三方转述 / 引用 | `m10:source:verify` | C8 / B3 | COVERED | 采纳侧引用缺失 ⇒ 结构拒绝 |
| G06 | 角色提议未被采纳 | `m10:source:verify` | E3 | COVERED | 三个"不写"操作都没有提案 |
| G07 | 明确采纳**唯一**提议 | `m10:source:verify` | C8 / C14 / B5 / B4 | PARTIAL | 契约的三句**分开记账**：①「`acceptanceRefs` 指向具体提议」**已覆盖**（`C8` 缺事件 id · `C14` 缺 `proposalSpan` —— `C8` 到不了的那一半 · **`B5` 正控**：合法采纳 ⇒ `understood` 且 `origin` 保留）；②「用户采纳原话」**已覆盖**（`span` 校验 `C4`–`C6` + `B4`）；③「**范围不超原提议**」**未做** —— 它是**内容范围的语义比较**（`L-M10-57`），材料齐了但判据要另立语义量具 |
| G08 | "好"但多个候选 | `m10:source:verify` | E3 / A7 | COVERED | 澄清路径：零提案、零写入，且分母非零 |
| G09 | 两目标同名不同主体 | `m10:inputs:verify` / `m10:test` | I6 / I6b / X17 | COVERED | 跨角色与跨用户都拒 |
| G10 | 改步骤 / 优先级 | `m10:test` | L5 | COVERED | 小改 ⇒ revision+1、身份不变 |
| G11 | 改对象 / 成功条件 | `m10:test` | L10 / X5 | COVERED | 实质改走 supersede；改 criterion 被拒 |
| G12 | 暂停 / 恢复 | `m10:test` | L2 / L3 / L4 | COVERED | 含 blocked→active 的复核 |
| G13 | 取消目标 | `m10:test` | L7 / X12 | COVERED | 三条取消原因全触达 + 孤儿约定 |
| G14 | 取消后同内容重新设立 | `m10:test` | G2 | COVERED | 新身份可达（不被旧幂等键吞掉） |
| G15 | 查询未知目标 / 承诺 | `m10:e2e:verify` | X1 | COVERED | 引用不存在的目标不能得 `accepted` |
| G16 | 两请求并发修同 revision | `m10:test` | X6 | COVERED | 乐观锁 |
| G17 | Memory `rev1 → rev2` | `m10:inputs:verify` | I2 / I3 | COVERED | 重新捕获取新 revision；旧引用失效 |
| G18 | Memory 遗忘 / 复活 | `m10:inputs:verify` / `m10:invalidation:verify` | I5 / F1 / F2 | COVERED | 同来源重述禁、新独立来源可达 |
| G19 | Belief `active` 但根已失效 | `m10:invalidation:verify` / `m10:inputs:verify` | D1 / I12 | COVERED | 根失效 ⇒ cancel；投影版本来自投影行 |
| G20 | `inferred` / `tentative` 输入 | `m10:inputs:verify` | I10 | COVERED | `inferred` ⇒ `soft`，不当确定前提 |
| G21 | `disputed` 与 `reported` 冲突 | `m10:inputs:verify` | I11 | COVERED | `disputed` ⇒ `soft`（不静默挑边） |
| G22 | 失效**可选**偏好 | `m10:invalidation:verify` | D5 | COVERED | 可选背景 ⇒ 只丢引用，目标保留 |
| G23 | 失效**必要**前提 | `m10:invalidation:verify` | D3 / D4 | COVERED | 含"读不到"与"确定失效"分开 |
| G24 | Goal 文本复制被忘取值 | `m10:context:verify` / `m10:invalidation:verify` | P1 / P2 / M1 / M4 | COVERED | 读侧遮蔽独立于写侧 |
| G25 | 用户报告**自己的**目标完成 | `m10:completion:verify` | J1 | COVERED | 正控 |
| G26 | 用户说角色"已经替我发了" | `m10:completion:verify` | J2 / J5 | COVERED | 她的输出不能自我确认；未落盘不算交付 |
| G27 | 对话产物正式落盘 | `m10:completion:verify` | J4 | COVERED | 已落库 assistant 事件 + 结构达标 |
| G28 | 输出生成失败 / 未落盘 | `m10:completion:verify` | J5 | COVERED | `evidence_missing` |
| G29 | `accepted=true`，`executed=false` | `m10:completion:verify` | J10 | COVERED | `not_executed` |
| G30 | `failed` / `timeout` / `partial` | `m10:completion:verify` | J11 | COVERED | `evidence_failed` |
| G31 | 错 `actionId` / 目标 / 用户 | `m10:completion:verify` | J12 / J13 | COVERED | 含跨角色隔离 |
| G32 | 旧 revision 的迟到结果 | `m10:completion:verify` | J14 / J15 | COVERED | 目标与承诺**各自**的 revision |
| G33 | 兑现补记前崩溃（窗口 B） | `m10:completion:verify` / `m10:e2e:verify` | P3 / P4 / C2 | COVERED | 幂等补记；禁止重生成产物 |
| G34 | 接受已提交、确认未落盘（窗口 A） | `m10:completion:verify` / `m10:e2e:verify` | P1 / P2 / C1 | COVERED | 读回并如实解释；禁止补造 assistant 事件 |
| G35 | 到期但系统离线 / 有实际违约证据 | `m10:test` | C11 / C6 / C7 / C8 / L11 / X22 | COVERED | 契约的三段**各有判据**：**无自动发送**（`C11`：目标域无定时器/调度器/出站调用）· `overdue`/`outcome_unknown` **结构上不可能冒充**（`C7`：不在任何闭集、也不在源码里）· **有匹配违反证据才记 `broken`**（`C8` 必填三向 + `C6` broken 唯一来源 + `L11` 正控 + `X22` 终态 no-op）。⚠️ "主动到期发送"那一半**不属本场景**（契约自己的判据就是"无自动发送"，`D14` 不建 scheduler） |
| G36 | 时间 / 时区有歧义 | `m10:test` | C9 / C10 | COVERED | **不猜日期**是结构性的（`C9`：生产侧**没有任何一处**写 `dueAt`）· **解析依据可查**（`C10`：`dueAt` 有值而 `dueBasis` 缺失 ⇒ 结构校验**必须拒**）。⚠️ `C10` 这条**当场是红的** ⇒ 它揭出一处真缺口：契约 §3 的 G36 判据**没有落到结构校验里**。已按"**实现契约**"补严（更严、不放松；今天无任何生产者受影响），见 §3 |
| G37 | 用户换话题 / 拒绝推进 | `m10:e2e:verify` | G37 | COVERED | 0 新事件、行逐字段不变 |
| G38 | 情绪低落 / 关系升高 | （M7/M8 的门） | | ELSEWHERE | **不属目标域**：情绪与关系状态由 M8/M7 的门覆盖（见 `m10:e2e` 的覆盖账） |
| G39 | 多目标冲突 | `m10:invalidation:verify` | C1 / C2 / C3 / C5 | COVERED | 冲突判定与"两条都保留"都在**这一门**：`C1`（同对象+同描述+**不同**成功条件 ⇒ 冲突）· `C2`（同对象+同描述+两个都 `active` ⇒ 冲突）· **`C3` 是负控**（不同描述 ⇒ 不冲突、自己与自己 ⇒ 不冲突）· `C4` 对称 · `C5` 两条都保留、成员 id 升序。⚠️ **不再**把 `m10:e2e:verify` 的 `G39` 算作本场景的覆盖 —— 它**空过了**（原判据对任何输入都成立，且样本里 `冲突成员 = 0`）⇒ 已在 `L-M10-64` 登记并把该检查降级成"**数据保全**"（行数 == 场景建的行数，会真的红） |
| G40 | 预算不足 / 整段被裁 | `m10:context:verify` / `m10:e2e:verify` | T2 / T3 / T4 / G40 | COVERED | 每项带具名原因；入模计数是真实值 |
| G41 | Goal 正文含 prompt 注入 | `m10:e2e:verify` / `m10:context:verify` | G41 / C7 / C8 | COVERED | 正文只当数据；内容由程序生成 |
| G42 | 开关 `off` | `m10:e2e:verify` / `m10:context:verify` | G42a / G42b / G42c / O1 / O3 | COVERED | 关闭档 prompt 与"不挂 provider"逐字相同 |
| G43 | `off` / `shadow` / `on` 召回对照 | （M5 召回门） | | ELSEWHERE | **不属目标域**：三档召回对照由 M5 的门覆盖 |
| G44 | 开发者查询 / trace | `m10:e2e:verify` / `m10:observability:verify` | G44 / G44b / R1 / R3 | COVERED | 遮蔽态字段集里没有内容字段 |
| G45 | 重启与重建 | `m10:e2e:verify` / `m10:long:verify` / `m10:scale:verify` | G45 / L3 / S5 | COVERED | 全量重放与增量路径逐字段相同 |
| G46 | 第 1 / 第 51 / 最老 active 目标 | `m10:scale:verify` | S1 / S2 / S3 / S4 / R1 / R3 | COVERED | 首项/第 51 项/最老都可按 ID 查；重建一致 |
| G47 | 200 / 500 轮连续轨迹 | `m10:long:verify` | L1 / L2 | COVERED | **标题里的两个数都真的跑过了**：`--turns` 默认 200、另加一次 `--turns=500`，两次都 **断言 9/9（另各 2 条登记）**，且 `L1` 的读数**逐字相同**（`链上出现=[cancel,create,pause,resume,revise] · 无状态轮次=0 · 未闭合=无`）。⇒ 不再需要"覆盖看核心判据列、不看标题"这条**判读**（原判读已由这把读数取代） |
| G48 | 损坏输出 / 量具 / 证据档 | `m10:e2e:verify` / `m10:long:verify` / `m10:evidence:verify` / `m10:measurement:verify` | X3 / G48a / A1 / A8 / N1 | COVERED | 三块齐：坏输出 · 零分母 · **证据档本身** |

---

## 1. 汇总（**不合成一个总分**）

```text
COVERED         45   G01–G06 · G08–G37 · G39–G42 · G44–G48
PARTIAL          1   G07   —— 契约三句里两句已覆盖、一句**语义**未做（`L-M10-57`）
ELSEWHERE        2   G38 · G43   —— 不属目标域，判据在 M7/M8/M5 的门里
NOT_COVERED      0
────────────────────────────────────────
合计            48   ✅ 与计划 §14 的 48 项一致
```

⚠️ **`ELSEWHERE` 不计入 `COVERED`**：它是"别的里程碑覆盖"，不是"M10 覆盖"。
把它算进覆盖数会让 M10 看起来比实际多做了两项。
⇒ **本表的读法**：M10 目标域内的覆盖 = **45 COVERED + 1 PARTIAL**；另 2 项不属本域。

⚠️ 本表**由 `pnpm m10:coverage:verify` 机器核对**：
编号齐不全 · **每个检查 id 在它点名的门的最新证据里真的存在** · 门都已登记 ·
非 COVERED 行都有理由 · 状态在闭集内。

## 1.1 从 `PARTIAL` / `NOT_COVERED` 收上来的项

| 项 | 原来 | 现在 | 怎么收的 |
|---|---|---|---|
| G35 | PARTIAL（只有折叠路径，没有具名检查） | **COVERED** | 契约三段各补判据：`C11` 无自动发送 · `C7` 不冒充 · `C8`+`C6` 有匹配证据才 broken，加 `L11` 正控与 `X22` 终态 no-op |
| G36 | NOT_COVERED | **COVERED** | `C9`（不猜日期是结构性的）+ **`C10` 揭出一处真缺口并修掉**（见 §3） |
| G47 | PARTIAL | **COVERED** | 按"覆盖看**核心判据**列"判（200 轮已满足全链在案 + 每回合有状态）；**500 轮未跑**仍记为 `L-M10-44`。⚠️ 判读写在明处，**供推翻** |
| G07 | PARTIAL | **PARTIAL（理由更精确）** | 补上缺的**正控** `B5` 与 `C8` 到不了的**第二分支** `C14`（三句里两句已覆盖）；第三句「范围不超原提议」是**语义比较** ⇒ 具名 `L-M10-57`。**这一项本轮收不上来，如实留着** |

## 3. `C10` 揭出的真缺口与处置（**本轮的实质发现**）

```text
现象  契约 §3 的 G36 判据后半句是「dueBasis 与解析依据**可查**」，
      而结构校验（validateGoalStateSnapshot 的 time 段）**只**要求
      "dueBasis 若出现则非空" —— **没有**要求"dueAt 有值时 dueBasis 必须出现"。
后果  一个带 dueAt、不带 dueBasis 的目标可以落库 ⇒ "这个日期是怎么来的"**查不到**
      ⇒ G36 的后半句在实现里**不成立**（契约与实现之间的一道缝）
发现  门 m10:test 的 C10 用**真的** payload 校验函数跑出来的（**红**）——
      它是"门的判据暴露了产品的缺口"，不是"门的缺陷"
处置  按"**实现**契约"补严：`dueAt` 有值而 `dueBasis` 缺失 ⇒ 抛
      ⚠️ 三条性质保证**不会误伤**：① 更严，不放松任何既有判据；
      ② 生产侧**没有任何一处**写 `dueAt`（`C9` 是这条的判据）⇒ 今天不存在会被它拒的真实事件；
      ③ 只约束**新写入**，已落库事件不受影响。
      ⇒ 契约（`DESIGN FROZEN`）的**语义一字未动**；这是把它**落地**，不是改它。
```

⚠️ **这是一处 `src/kernel/contracts/**` 的改动** ⇒ 按 AGENTS §5 必须跑
`pnpm kernel:test` + `pnpm kernel:verify`（已跑，见下）。

## 2. 三条 `PARTIAL` 与一条 `NOT_COVERED` 的**处置**

| 项 | 缺什么 | 处置 |
|---|---|---|
| G07 | "采纳指向具体提议与原话"的**正控** | **不进 M10**：提议来源是 M9.5 的输入面，M10 只校验引用存在性（`C8`）。若要正控，需 M9.5 侧的提议 fixture ⇒ 独立议题 |
| G35 | "到期"那一半 | **有意不做**：`D14` 冻结"不建 scheduler"。主动到期检查是新能力（Lv2 的主动提醒），须另立里程碑 |
| G35 | "违约证据"那半边没有**具名检查** | **可补**：给 `COMMITMENT_BROKEN` 的折叠路径加一条门检查（`m10:test` 的 L 组缺 B 开头的一条）⇒ 记入 WP11 可选收口 |
| G47 | 500 轮 | **未跑就是未跑**（`L-M10-44`）。跑它只需改一个常量并等，但**没有跑**⇒ 不写 PASS |
| G36 | 整项 | **未覆盖**。要么补一条检查（"时间歧义 ⇒ 澄清，不猜"），要么在契约里**具名**把它标为不适用 ⇒ 交 WP11 裁定；**本表不替它写 PASS** |
