# 皮套入口主动开口 · WP5a 交接单（桥侧接缝）

```text
WP     : WP5a —— **桥侧接缝**：入站报文种类 · host 端口 · 响应形状 · 分发分支
日期   : 2026-10-11
上游   : ADR-131 · WP0 基线 · WP1（契约）· WP3（预检）· WP4a/4b（生成侧与编排）
结论   : 桥**能收**这条报文并如实回报；但**没有任何东西会发它**
         （`src/main.ts` 与外壳都还是原样）⇒ WP5b 才是接线
```

---

## 1. 交付物：`src/kernel/app/bridge/turn-bridge.ts` 六处

| # | 改动 | 说明 |
|---|---|---|
| ① | `BridgeMessageKind` 加 `'PROACTIVE_OPPORTUNITY'` | 与 `PREPARE_TURN` / 投递回执并列的**第三条"与轮次无关"**的入站消息 |
| ② | `BRIDGE_MESSAGE_KINDS` 数组加同名一项 | 闭集与数组同步 |
| ③ | `isBridgeControlMessageKind`：**加注释说明它为什么不进去**（**不**加分支） | ★ 见 §2 |
| ④ | `TurnBridgeHost.openingOpportunity?(input)` | 与 `prepareLookup` / `prepareTurn` 同形的 host 端口（**可选**） |
| ⑤ | `BridgeOpeningReading` / `BridgeOpeningResult` | 读数字段与响应（**正文只许出现在 `reading.text` 一处**） |
| ⑥ | `handleBridgeMessage` 的分发分支 + 两个 getter | 形状拒 / 能力缺席 / host 抛错，三条各自具名 |

---

## 2. ★ 一处关键判断：它**不是控制类**

`isBridgeControlMessageKind` 决定"排队还是立即"。控制类的**理由**是
"慢轮次期间必须能被读到" —— 而它们都是**微秒级、不改世界**的动作。

而机会报文**会调一次模型**（`openingDeadlineMs` 上限 **8000ms**，实测 p90 ≈ 2400ms）。
若把它当控制类：

```text
一次 8 秒的机会评估会**挡住同一批控制消息** ——
而 CANCEL_TURN 恰好在"用户要打断她"时到达，那是**最不能等**的时刻。
```

⇒ 判断：**走排队那一档**。机会**不紧急**，被慢轮次推迟是**安全方向**
（推迟后预检按**新鲜读数**重判；过期就拒）。

**可测的推论**（已写进注释，供 WP6 的门用）：
```text
它**不应**出现在 `isBridgeControlMessageKind` 的 `true` 分支里。
```

---

## 3. 另一处小决策：不动共享的 `outcome` 联合

`BridgeWireResponse.outcome` 是**共享**联合。ADR-131 `D18` 的三态是
`spoken / silenced / deferred`，而 `silenced` / `deferred` 不在那个联合里。

两条路：
```text
(a) 往共享联合里加两个字面量（动别人也在用的类型）
(b) `outcome` 只用**既有**那几个（`spoken` / `rejected` / `failed`），
    细分三态放进 `reading.decision`
```

⇒ 选 **(b)**：既不动共享联合，又保留 ADR 的形状。
外壳的解析可以两段式：先看粗 `outcome`，要细的再读 `reading.decision`。

---

## 4. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 290**（原 289） | **0** ✓ |

### 4.1 `measured_count` 289 → 290：已核清

我往入站闭集里加了一项，所以专门查了门与它的关系：

```text
scripts/postlv2-bridge:verify  → `BRIDGE_MESSAGE_KINDS.includes('PREPARE_TURN')`（**成员判断**）
scripts/postlv2-qq-proactive-verify → `BRIDGE_MESSAGE_KINDS.includes('REPORT_QQ_DELIVERY')`（同上）
                                       `isBridgeControlMessageKind('REPORT_QQ_DELIVERY') && … && !isBridgeControlMessageKind('SUBMIT_TURN')`
⇒ **没有任何一处断言"闭集恰好 N 项"**  ⇒ 加一项不会撞计数锁
```
⇒ `+1` 最可能来自某个把 `BRIDGE_MESSAGE_KINDS` 长度当 `measured` 传的断言（7 → 8）。
**门仍 PASS、无失败项** ⇒ 结论：**加这一项是安全的**。

---

## 5. 本 WP **没有**做的事

```text
· ❌ **`src/main.ts` 仍未改**（装配根一个字未动）
· ❌ 外壳未改（`scripts/postlv2_vtuber_runtime.py` 的 `LGBridgeAgent.chat` 守卫照旧）
· ❌ **没有任何东西会发这条报文** ⇒ 桥上的新分支在生产里**永远不会被走到**
· ❌ 没有落账 / trace / 交付读数
· ❌ 没有正式门 / npm script（WP6）
· ❌ 没动 `.env`、没动 `TD-19`
```

⇒ 现在这条链**两端都能用**（桥能收、编排能跑），**中间那根线还没接**。

---

## 6. 下一步：WP5b（真正的接线）

| 顺序 | 内容 | 风险 |
|---|---|---|
| 1 | `src/main.ts` 实现 `openingOpportunity` 端口：读数 → 预检 → 依据集 → 编排 → `emitCharacterOutput` | ⚠️ **第一次改装配根**；混合树上要按外科式 stash 分离归因 |
| 2 | 外壳侧：把 `proactive_speak` 从"调 `chat`"改成"发 `PROACTIVE_OPPORTUNITY`"（`LGBridgeAgent.chat` 的守卫**一个字不改**） | 外壳文件也在混合树里 |
| 3 | 交付读数（`spoken` / `yielded` / `dropped` + `lastCode` + `source`）与 trace | — |

⚠️ WP2（关掉外壳自带的 proactive speak）**仍然欠着**，且它是 WP5b 第 2 步的**前置**：
不先关掉，两条路会并存（旧的照旧 33 次/分钟撞守卫，新的也发）。**零代码、属用户操作。**
