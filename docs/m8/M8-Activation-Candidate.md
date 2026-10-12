# M8 Activation Candidate（生产激活候选）

> 状态：**ACTIVATED**（2026-09-26，用户授权「批准激活」；执行记录
> [ADR-067](../adr/ADR-067-m8-affect-production-activation.md)——
> `.env` 已设 `CHARACTER_AFFECT_CONTEXT_ENABLED=true`，代码缺省仍 false。
> 本文按候选时的原文保留，不回写）
> 人审状态（2026-09-27 修订）：**PASS**——用户声明式裁定"已审、无异议"
> （裁决归档 Gate-Decision §4；本文正文仍按候选时原文保留）
> 判定背景：[M8-Gate-Decision.md](M8-Gate-Decision.md)（工程面 PASS ·
> Human Review = PENDING（候选当时；2026-09-27 修订为 PASS）· 激活后 → ACTIVATED）
> 计划：[M8-Execution-Plan.md](M8-Execution-Plan.md) §10 WP9
> 设计：[ADR-066](../adr/ADR-066-affect-state-evolution.md)（M8-D14：flag 缺省 false；
> 激活 = 独立裁定）

## 1. 激活会做什么（一次授权的全部后果）

```text
动作    .env 追加一行：CHARACTER_AFFECT_CONTEXT_ENABLED=true
        （代码缺省仍 false——这保证任何其它环境/测试/回滚天然安全）

效果①   下一次启动：affect 建档（ORIGIN 事件，cutover = 账本当前最大序号）
        ⇒ 激活前的全部历史消息永不回评（M8-D05；Live Smoke 已在生产副本
        验证该形状：cutover=117，旧历史零重判）
效果②   此后每轮：同轮情绪评估（确定性词形判据，无 LLM、同步、有界、
        失败不阻断聊天）→ 命中词形时产生 AFFECT_TOUCH/AFFECT_IMPACT 域事件
        → 投影演化（v ∈ [−1,1]，a ∈ [0,1]）→ prompt 注入块（section 52，
        定性 guidance，无数值泄漏）
效果③   trace 六步落树（reply-truth：她的回复与程序事实同树可审计）
```

## 2. 激活不会做什么

```text
· 不新增任何外部能力（矩阵 = NONE）：无网络/桌面/后台/多模态/MCP
· 不改记忆：affect 事件永不自动进长期记忆（与 M4 防火墙同界）
· 不改关系语义：M7 投影独立，双 section 并存零耦合（e2e A17）
· 不重写历史：旧消息零回评；事件账本只追加
· 不改她的"人格文件"：seed 不动；注入块是上下文，不是人设改写
```

## 3. 回滚（随时可用，无破坏）

```text
回滚 = 从 .env 删掉那一行（或改 false）
效果：注入块消失、评估停跑（水位与 job 停用）；已产生的 AFFECT_* 域事件
      与投影行**保留**（审计事实，不删不改——防篡改纪律）；
      再激活时 cutover 重新取账本尾（停用期间的消息不回评）。
```

**回滚 dry-run 的既有证明**（WP9 前提之一，已由在案证据覆盖）：
"关 flag"的形状 = M8 全部负控 + 全量回归的缺省态——flag 缺省 false 时
零 affect 步、零注入块、prompt 基线逐字节不变（WP5 基线门 +
`m4.5:ci` EXIT 0 全链验证）；隔离库上"开→关"后事件与投影保留、
再开时 cutover 重取账本尾（e2e A19 的建档语义）。激活后如需一份
**当轮**的回滚演练，可在生产副本上重跑 `m8:live:level1` 的读数器
对照（不触碰真实库）。

## 4. 观察面（激活后怎么知道它在正常工作）

```text
日常    她的回复语气（盲审审题同款：方向一致、不复述内部状态、
        不声称知道你的情绪）
程序    pnpm kernel:status            → affect 投影读数（v/a/revision/cutover）
        trace 六步（affect_eligibility → … → affect_context）
        pnpm m8:gates                 → 门汇总（只读已落盘证据）
边界    故障形状：注入块带"本轮未完成情绪更新"边界行 + 聊天照常
        （失败分类法不新增——WP6 N2 已验证）
```

## 5. 已知代价与边界（激活前应知）

- **覆盖面**：冻结词形判据（`affect-rules@1` 七族）——覆盖面外的表述只
  touch 不 impact（L-M8-01）；误触发回滚规则版本，不写用户事实（L-M8-05）。
- **首启建档**：激活后的第一轮只建档不评估旧消息——情绪从激活时刻开始
  积累（L-M8-04）。
- **盲审未完成**：材料已交付，人审 PENDING——用户可选择先审再授权，
  或授权后边用边审（判定不因此合成，见 Gate-Decision §4）。
- **M7 潜伏缺陷**：关系评估器的 tool 楔死 + catch 不 finishJob 未修
  （L-M8-13）——今天无生产 tool 写入者，激活动作不触碰它们。

## 6. 授权格式（WP9 的开门钥匙）

用户对本文显式授权（任意明确措辞，例如"批准 M8 激活"）后：

```text
① 创建 docs/adr/ADR-067-m8-affect-production-activation.md（只做状态修订，
   记录授权原话、时间、激活时树）
② .env 追加 CHARACTER_AFFECT_CONTEXT_ENABLED=true
③ 首启观察：kernel:status 读回 ORIGIN/cutover + 第一轮 trace 六步
④ 更新 Gate-Decision §0 的 production activation 行 → ACTIVATED
```

**在授权之前：PASS / NOT ACTIVATED——M8 停在这里。**
