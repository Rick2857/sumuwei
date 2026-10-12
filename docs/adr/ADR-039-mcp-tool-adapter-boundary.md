# ADR-039：MCP 与工具适配器边界

- 状态：**已采纳**（M5.1 WP6，2026-09-17）
- 里程碑：M5.1（OSS Integration Audit）
- 相关：ADR-030（唯一执行入口）、ADR-031（能力登记与边界）、ADR-032（目标确定性）、
  ADR-033（执行真相）、`docs/m4.5/M4.5-Capability-Registry.md`、`docs/m5.1/M5.1-OSS-Audit.md` §3
- 裁定：**MCP 作为 Tool Adapter = REFERENCE** ·
  **MCP 作为能力发现权 = REJECT** · **M5.1 内实现 Tool Runtime = REJECT**

---

## 1. 背景与实测

M4.5 已经把"她能对世界做什么"变成**登记表 + 适配器**（仓库实测）：

| 事实 | 形状 |
|---|---|
| 能力登记 | `CapabilityDefinition` = **9 个字段**（id / version / description / operations / sideEffectLevel / riskLevel / permissions / supportsDryRun / idempotency） |
| 适配器契约 | `CapabilityAdapter = { capabilityId, execute(input) → AdapterOutcome }`（**1 个方法**） |
| 唯一执行入口 | `ActionGateway.execute()`；`evaluate()` 只判定不执行 |
| 能力发现（今天） | `CapabilityRegistry.list()` + `GET /dev/query/capabilities`（M5.1 WP2） |
| 幂等 | 键由"能力 + 操作 + 目标 + 参数"稳定推导；三档声明 `none/supported/required` |

MCP（一手规范，2025-06-18）关键事实：
- 三类服务端原语：**Prompts（用户控制）/ Resources（应用控制）/ Tools（模型控制）**；
- 服务端**必须声明** `capabilities.tools`（含 `listChanged`：能力清单变化时通知）；
- 错误分**协议错误**（未知工具、参数非法）与**工具执行错误**（`isError: true`）；
- 规范明确建议"**总应有一个人在回路里，能够拒绝工具调用**"。
来源：[Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、
[Server 概览](https://modelcontextprotocol.io/specification/2025-11-25/server)、
[Discovery](https://modelcontextprotocol.io/specification/draft/server/discover)。

---

## 2. 五项解释

### Landing Target
**`CapabilityAdapter` 的一个实现**（`infrastructure/action/adapters/`），
一个 MCP tool ↔ **一个能力 + 一个操作**。
远端 server 的清单**不能**直接变成 `CapabilityRegistry` 的内容 ——
它只能成为**装配层**在登记时输入的一份候选（人（或 ADR）决定登记哪些）。

### Authority Boundary
四条留在我们这边（一条都不能交出去）：
1. **能力登记**：`CapabilityRegistry` 决定"有哪些能力、什么副作用、什么风险、要什么权限"；
2. **策略判定**：`policy.ts` + 装配层显式授予的 permissions（远端 server 说"我可以"不算数）；
3. **目标确定性**：`resolveTarget` 由装配层注入（ADR-032）—— 适配器**只收到已确定的目标**；
4. **执行真相**：`ActionResult` + `character_action_events`（ADR-033/034）。

MCP 的 `listChanged` **不许**成为我们的发现权威：让远端决定"我们有什么能力"，
等于把第 1 条交出去（G-01）。它最多是"**有一个候选变了**"的提示。

### Replacement Strategy
换 MCP server = 换一个已登记能力的适配器实现。**替换成本**：
- 协议层：需要**一次 spike**（本轮没做：AT6.3 明令 M5.1 不实现 Tool Runtime）；
- 语义层：`Tool` 的 JSON Schema ↔ 我们的 `OperationDefinition`（参数形状）之间要有一张映射；
- 特别要注意：MCP 的"工具执行错误"必须**归一**到我们的 `ActionFailure` 受控码
  （`errors.ts` 有一条硬纪律：账本里不许出现原始错误字符串）。

### Failure Isolation
- 远端 server 挂掉 → 那条能力的所有操作回 `execution_failed` / `timeout`（受控码），
  **不影响**其它能力，也不影响本轮回复（回复层只认 `ActionResult`，见 ADR-033）；
- 远端返回超时/部分成功 → 必须走既有 `partial` / `timeout` 语义，
  **不许**合并成 success（§28 的纪律）；
- 协议错误（未知工具）→ `validation_failed`，在**目标解析之前**就断开
  （不产生任何副作用）。

### Future Milestone
**未来里程碑**（计划书把 MCP Tool Runtime 明确排除在 M5.1 之外）。
准入判据：
1. 先写"一个 tool ↔ 一个能力 + 操作"的映射 ADR，并明确**谁**回答 `listChanged`（我们）；
2. 能力登记必须**人审**（远端清单不能自动进表）；
3. 需要一次真实 spike：远端 tool 调用 → 归一失败码 → 账本 → 面板，
   判据是**账本里真的多了一条终态记录**，不是"HTTP 200"。

---

## 3. 备选与否决理由

| 备选 | 否决理由 |
|---|---|
| 把 MCP server 的 `tools/list` 直接灌进 `CapabilityRegistry` | 交出能力登记主权（G-01）；且"远端随时新增能力"会让权限与风险声明失效 |
| 让 MCP server 自己做目标解析 | 违反 ADR-032（目标确定性必须在我们这边，且它决定是否允许副作用） |
| 在 M5.1 内实现 Tool Runtime | AT6.3 明令禁止；会同时引入外部执行、网络与新依赖 |
| 用 MCP 的 `isError` 直接充当我们的失败语义 | 会让账本出现非受控码（`errors.ts` 的硬纪律），失败率无法统计 |
| 忽略规范里"人在回路"的建议 | 我们已有 `dryRun` + 权限模型；主动放弃它没有收益 |

---

## 4. 后果

- 本轮**不动任何代码**；M4.5 的能力/策略/执行入口三条边界原样有效。
- MCP 的**兼容性**结论是"映射关系干净、但只有一次真实 spike 才能证明"，
  因此本轮停在 REFERENCE —— 不假装已经评估完。
