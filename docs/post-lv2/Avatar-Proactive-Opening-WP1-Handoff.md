# 皮套入口主动开口 · WP1 交接单（契约冻结）

```text
WP        : WP1 —— 设计冻结 → 契约（**不含实现**）
日期      : 2026-10-11
上游      : ADR-131（ACCEPTED / DESIGN FROZEN）· WP0 基线（avatar-proactive-opening-20261011）
结论      : **契约层已完成并通过三段式**；实现（报文 / 预检 / 模型调用 / 交付）**未开始**
```

---

## 1. 改了哪四个文件

| 文件 | 改动 | 对应裁定 |
|---|---|---|
| `src/kernel/app/bridge/character-output.ts` | 闭集 3 → **4**（加 `proactive_opening`）；**原注释逐字修订**为 ADR-131 §1 的口径；新增 `NON_URGENT_CHARACTER_OUTPUT_SOURCES`，`arbitrateCharacterOutput` 的 ⑤ 分支改用它 | `D03` · `D07` |
| `scripts/postlv2-entry-bridge-verify.ts` | **故意**把 B17 的 `CHARACTER_OUTPUT_SOURCES.length === 3` 改成 `=== 4`；**新增一条负控**（`proactive_opening` + 用户占话权 ⇒ 让位）；`measured` 22 → 23 | `D03`（"改判据要配负控"） |
| `src/kernel/contracts/notification.ts` | `ProactivePolicy` 加 **4** 个字段 + `DEFAULT_PROACTIVE_POLICY` 补默认值 | `D15` · `D17` |
| `src/kernel/app/flags.ts` | `readProactivePolicy()` 解析这 4 个字段（全部取**安全侧**上下界） | `D15` · `D17` |

### ⚠️ 一处**刻意偏离** ADR 原文，需备查

ADR-131 的 U1 只写了 **3** 个字段（`openingMinIdleMs` / `openingCooldownMs` / `maxOpeningsPerDay`），
而 `D17` 另定了 `openingDeadlineMs = 8_000`。

**本 WP 把它也放进了 `ProactivePolicy`（共 4 个）**，理由：`ProactivePolicy` 是**随策略版本落库**的
（ADR-110 `D14`），把期限散成模块常量会破坏"策略值可版本化可审计"这条既有纪律。
⇒ 这是**一致性选择**，不是新增裁定；ADR §7-U1 的"三个数字住哪里"一节据此应读作**四个**。

### 默认值（待冻结建议值，随策略版本一并定档）

```text
openingMinIdleMs   = 3 分钟        ← 外壳报来的 idleMs 下限
openingCooldownMs  = 30 分钟       ← 两次开口之间的冷却
maxOpeningsPerDay  = 4             ← 日上限（并计入 maxProactiveMessagesPerDay = 10 总闸）
openingDeadlineMs  = 8 000         ← 单次模型调用期限（与 ADR-104 role-tool 同档）
```

对应的新环境变量（**代码缺省即上表**，`.env` 未设任何一个）：

```text
CHARACTER_AVATAR_OPENING_MIN_IDLE_MIN      (1..1440)
CHARACTER_AVATAR_OPENING_COOLDOWN_MIN      (1..10080)
CHARACTER_AVATAR_OPENING_MAX_PER_DAY       (0..24)
CHARACTER_AVATAR_OPENING_DEADLINE_MS       (1000..60000)
```

---

## 2. 读数

### 2.1 `pnpm typecheck` = **EXIT 0** ✓

### 2.2 `pnpm postlv2:bridge:verify` = **PASS** · `measured_count = 289` · EXIT 0 ✓

B17 的实测读数是：

```text
用户说话时紧急两类可插=true（让出话权）· 安静时可插=speak · 无来源=output_without_source ·
空文本=output_without_checked_text · 无版本=output_without_revision · 超句数=output_too_long ·
超字数=output_too_long · 旧版本=output_stale_against_user_revision ·
非紧急让位=user_holds_floor_for_non_urgent_output ·
主动开口让位=user_holds_floor_for_non_urgent_output ·      ← ★ 本次新增
未登记来源=output_source_not_registered · 抢话作废（新=true/同=true/旧=false）·
来源闭集=4                                                 ← ★ 3 → 4
```

### 2.3 ★ 三段式（"改判据要配负控"的机器证据）

| 段 | 动作 | 读数 | 退出码 |
|---|---|---|---|
| **正控** | 守卫在位 | `主动开口让位=user_holds_floor_for_non_urgent_output` · B17 ✅ · PASS 289 | 0 |
| **负控** | **摘掉** `NON_URGENT_CHARACTER_OUTPUT_SOURCES` 里的 `proactive_opening` | `主动开口让位=`**`speak`**（本该让位，实际说了）· B17 ❌ · FAIL | **1** |
| **恢复** | 装回 | `主动开口让位=user_holds_floor_for_non_urgent_output` · B17 ✅ · PASS 289 | 0 |

⇒ 这条负控**真的会响**，而且响的原因是**预期的那一个**（不是别的检查顺带变红）。
⇒ 这正是 `character-output.ts` 原注释要求的"往里加一类 = 改判据（**要配负控**）"的落地形态。

### 2.4 `pnpm fast`（affected lane）= 52 道 · PASS 48 · CACHED 3 · **FAIL 1**

```
❌ postlv2:role-tool:verify
```

#### 归因（**外科式证明，不是猜**）

工作树是**混合树**（90+ 个别的会话改过的文件）。因此做了一个只针对本次 4 个文件的 stash：

```powershell
git stash push -m "wp1-attribution-probe" -- `
  src/kernel/app/bridge/character-output.ts src/kernel/app/flags.ts `
  src/kernel/contracts/notification.ts scripts/postlv2-entry-bridge-verify.ts
pnpm postlv2:role-tool:verify     # ← 我的改动不在树上
```

**结果：仍然 FAIL**，且两条具名码都与本次改动无关：

```json
{"problems":[
  {"code":"generic_bypass_arg","message":"browser.mcp 的参数白名单里有通用执行入口：tool"},
  {"code":"stale_arg_keys","message":"TASK_ARG_KEYS 里有一行 local.reminder.message，但它没有被登记 —— 表与登记表漂移了"}
]}
```

| 问题 | 归属 |
|---|---|
| `generic_bypass_arg` | **已登记的既存项** —— AGENTS.md 2026-10-09 段逐字记过"两条**既存**，同一根因" |
| `stale_arg_keys` | ADR-124（本地提醒 `local.reminder.message`）那条线留下的**表与登记表漂移**，属**别的会话在途工作** |

⇒ **本次改动不是它的原因。** 该门在本次改动之前就是红的（`overall = NOT PASS`）。
⚠️ **本 WP 不修它**：它属别的会话的在途面，修它要动 `src/kernel/action/tool-catalog.ts`
（已被别人改过）与 `TASK_ARG_KEYS`，**不在本 ADR 授权范围内**。

无新增其它红项。stash 已 `pop`，4 个文件完好。

---

## 3. 本 WP **没有**做的事（避免误读）

```text
· 没有新增任何 packet（PROACTIVE_OPPORTUNITY / OPPORTUNITY_RESULT 仍只是 ADR 里的形状）
· 没有机会受理、没有预检（十四条拒绝）、没有三道闸
· 没有模型调用、没有依据集构造、没有回复守卫接线、**没有 sidecar**
· 没有落账、没有 trace、没有读数面
· 没有改 `scripts/postlv2_vtuber_runtime.py` 的入口守卫（一个字未动）
· 没有动 `.env`、没有动 `TD-19` 本体
· 没有跑 `m4.5:ci`（混合树上跑完整门会把别人的在途改动一起卷进来）
```

⇒ 现在她能做的**仍然只有原来那三件事**（呼唤回应 / 中途纠正 / 边听边查）。
`proactive_opening` 只是**在类型上存在、在判据上被承认**，**没有任何东西会产出它**。

---

## 4. 下一步

| 顺序 | WP | 内容 | 前置 |
|---|---|---|---|
| **先** | **WP2** | **外壳侧关掉自带的 proactive speak**（零代码） | **用户操作**；见 WP0 §4 |
| 然后 | WP3 | 机会受理 + 十四条预检 + 三道闸（全部在调模型之前） | WP1 已冻结的契约 |
| 然后 | WP4 | 依据集（复用 ADR-111）+ 一次模型调用 + 回复守卫 + **sidecar** | WP3 |
| 然后 | WP5 | 交付读数 + `OPPORTUNITY_RESULT` + trace | WP4 |
| 然后 | WP6 | 门：正控 1 + 负控 15 + 三段式量具有效性 | 各 WP |
| 最后 | WP7 | 真链路 smoke（生产副本 + 真外壳） | 全部 |

> ⚠️ WP2 **不先做，其余全部白做**：那 33 次/分钟会在下一次启动皮套时照旧。
