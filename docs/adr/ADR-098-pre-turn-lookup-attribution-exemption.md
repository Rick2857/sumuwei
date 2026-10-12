# ADR-098 —— 提前检索的**具名**归因豁免（`pre_turn_lookup`）

- **状态**：`ACCEPTED`（用户 2026-10-05 在会话内裁定：「给它一个具名的归因豁免」）
- **日期**：2026-10-05
- **载体**：本文件；实现落在 `src/kernel/contracts/attribution.ts`（**只追加**）、
  `src/kernel/action/gateway.ts`（判定点强制收窄）、`src/main.ts`（唯一调用者）
- **涉及**：ADR-042（归因模型）· ADR-043（认知再资格）· `M5.1-D01` · Lv4.5 `P3`（选项 B）

---

## 1. 为什么需要它（实测读数，不是推测）

Lv4.5 的 `P3` 选项 B（「边听边查」）要在**轮次开始之前**发起一次**只读**检索
（用户原话里出现**显式检索词形**时才发起），查到就插一句"查到了。"。按用户裁定，
它**走动作网关**（同一个能力入口、同一套权限与账本）。

真链路探针第一次拿到的**具名结局**是：

```text
/lg/status → partial.prepare = {"prepared":8, ..., "lookup_failed":6,
                                "lookup_last_code":"action_attribution_evidence_missing"}
```

根因在 `src/kernel/action/gateway.ts`（WP5-3，**失败关闭**）：

```text
动作事件需要**受信 initiator 证据**（ActionInvocationContext.initiatorEvidence）；
提前检索发生在**轮次之前** ⇒ 没有因果上下文 ⇒ 没有受信证据 ⇒ 拒绝。
而该处**明确拒绝**退回到 payload 里自报的 `requestedBy`：
    "不退回落 payload 的 requestedBy（那是自报）…那会让'谁发起的'重新变成猜测"
```

⇒ 这不是缺陷，是 ADR-042 的**设计**。ADR-042 的模块里**故意没有**
"从呈现角色构造 initiator"的构造器（WP5.1 已把那个构造器**删除**）。

## 2. 裁定

在 ADR-042 的模型内**追加**一个**具名**的第三条入口 —— 不是放宽检查，而是**给出名字**：

```text
① attestActionInitiatorFromCausalOrigin()      —— 因果上下文（原有）
② attestActionInitiatorUnresolved()            —— 如实说"没有因果上下文"（原有）
③ attestActionInitiatorFromNamedExemption()    —— **本 ADR 追加**：具名豁免
```

**只有一条豁免，名字是 `pre_turn_lookup`**，声明在**闭集**里：

```ts
ACTION_ATTRIBUTION_EXEMPTIONS = {
  pre_turn_lookup: {
    principal: { kind: 'system', id: 'pre-turn-lookup' },   // 账本记的是**这个**身份
    capability: 'web.search',
    operation: 'search',
    sideEffect: 'read',                                     // 只读，且由判定点复核
    basis: 'user_explicit_request_read_only_speculative',
  },
}
```

- `causalBasis` 追加一个成员 `'named_exemption'`（**只追加**，不改既有四个）。
- `causalEventId` 为 `null`：**没有**触发事件 —— 这一点如实记录，不伪造一个事件 id。

## 3. 收窄**在判定点**强制（不在调用点）

调用点的自觉不算收窄。网关在归因解析处**复核**：

```text
causalBasis === 'named_exemption' ⇒
  ① 该名字必须在闭集里（不在 ⇒ 具名拒绝）
  ② 请求的能力/操作必须与声明**逐字相同**
  ③ 该操作的 `sideEffect` 必须是 `read`（写/破坏性 ⇒ 具名拒绝）
```

⇒ "豁免只能用于只读的那一种操作"是**机器判据**，不是注释。

## 4. 这条豁免**不**允许什么（逐条写明）

```text
· 不是通用逃生门：再加一条要**改闭集**（一处可见的 diff），不是加个参数
· 不允许写/破坏性操作（判定点拒绝）
· 不允许用在别的能力上（判定点拒绝）
· 仍然**不能**从"呈现角色"推出具体位次 —— 它给出的是**系统侧**具名身份，
  不是"他就是用户"；账本因此记 `SYSTEM/pre-turn-lookup`，而不是 `USER/<某人>`
· 不允许把 payload 自报的 `requestedBy` 洗成权威 —— 那条禁令原样保留
```

## 5. 代价与残余（如实分列，不外推）

| 项 | 说明 |
|---|---|
| 账本含义 | 账本里会出现"发起人是 `SYSTEM/pre-turn-lookup`"的动作行。**那条检索真的发生过**，所以这是如实的；它只是**不隶属某一轮回复** |
| 归因强度 | `SYSTEM/<名>` 是**具名**，但不是"受信用户" —— 它比 Unknown 强（有名字、有闭集、有收窄），比因果证据弱（没有触发事件） |
| 豁免的"理由" | `basis` 是**声明**，不是机器可证的事实。它依赖"用户原话里有显式检索词形"这条**规则判定器**（由门 `B20` 锁着），不是模型判断 |
| 未证明 | 本 ADR **不**主张"提前检索现在一定成功"：它只解除归因这一处阻塞。出站是否真能拿到结果、以及"她正在说"的时机是否成立，仍由真链路读数决定 |

## 6. 与既有不变量的关系

```text
M5.1-D01 / ADR-042 的核心主张 = "谁发起的必须可查、可审计，不能靠猜"
本条**没有**推翻它：它把"猜"换成了"一个具名的、闭集的、被判定点收窄的身份"
⇒ 可查（账本里有名字）· 可审计（闭集 + 判定点复核）· 不可滥用（写操作被拒）
```

---

## 附：本裁定之前的就地记录

在裁定之前，进度文档 `docs/post-lv2/Lv4.5-Execution-Progress.md` §5.4 已把
三个方向（① 放弃 / ② 具名豁免 / ③ 挪进轮次）连同代价分列呈交；
用户 2026-10-05 选择 **②**。本 ADR 是那条选择的裁定载体。
