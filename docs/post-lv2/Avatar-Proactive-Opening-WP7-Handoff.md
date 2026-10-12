# 皮套入口主动开口 · WP7 交接单（整链门 + 激活开关）

```text
WP     : WP7 —— **真链路读数**（整链门）+ 补上激活缺口（`CHARACTER_AVATAR_OPENING_MODE`）
日期   : 2026-10-11
上游   : ADR-131 · WP0…WP6 · 裁定 C · 激活就绪评估
结论   : ① 拿到了**第一批真链路读数**（真 socket + 真核心 + 真协议）
         ② 补上了"没有开关 ⇒ 重启就等于激活"那个缺口 ⇒ **现在重启是安全的**
         ③ ⚠️ `spoken` 那条路与真模型**仍然 NOT RUN**
```

---

## 1. 交付物

| 文件 | 改动 |
|---|---|
| `scripts/postlv2-avatar-opening-chain.ts` | **新增**：整链门（真核心 + 真 socket + 真握手；**三档**） |
| `package.json` | **+1 条**：`postlv2:avatar-opening:chain`（照 QQ 整链门的待遇：**不进 lane**，因为它起真核心） |
| `src/kernel/app/flags.ts` | **+`avatarOpeningMode`**（`CHARACTER_AVATAR_OPENING_MODE`，代码缺省 **`off`**）；`readProactiveMode` 加可选名字参数（**一条实现两处用**） |
| `src/main.ts` | **消费它**：`off` ⇒ 端口**不注入**；`shadow` ⇒ 整条链照跑但**不出站**（具名码 `opening_shadow_no_emit`）；启动打一行模式读数 |
| `scripts/postlv2_vtuber_runtime.py` | 外壳：收到 `opening_capability_absent` ⇒ 提示**一次** + **退避 900 秒**（不引入第二个开关） |
| `scripts/postlv2-avatar-opening-verify.ts` | **+2 条判据**（开关解析的**结构判据** + `main.ts` 真的消费它的窄范围锚）⇒ **85 项** |

---

## 2. 真链路读数（本门第一次跑出来的东西）

### 2.1 档一：`avatarOpeningMode=on` + `qqProactiveMode=on`

```text
[PASS] 真握手：`LG_ENTRY` ⇒ `LG_ENTRY_READY`（拿到会话 id）
[PASS] 正控：机会报文 ⇒ 收到 `OPPORTUNITY_RESULT`
[PASS] 正控：回执 `requestId` 与请求一致（不是别的东西冒充的）
[PASS] ★ 空依据库 ⇒ `decision=silenced` + `code=opening_without_evidence`（**S06 在真链上成立**）
[PASS] ★ **零模型调用**（"不花模型"不是文档里的话，是计数：calls 2 → 2）
[PASS] ★ `D18`：回执里**没有正文**（字段只有 decision,code,idleMs）
[PASS] 负控：`entry=qq_private` ⇒ `opening_packet_shape_invalid`（**不接管**别的入口的报文）
[PASS] 负控：形状那条也**零模型调用**
[PASS] 负控：`idleMs=-1` ⇒ `opening_packet_shape_invalid` · 同样零模型调用
```

### 2.2 档二：`avatarOpeningMode=off`（**本轮新加的开关**）

```text
[PASS] ★ 开关生效：off ⇒ 端口**不注入** ⇒ `opening_capability_absent`（`outcome=rejected`，**不假装**评估过）
[PASS] ★ 开关生效：off 档**零模型调用**（calls 4 → 4）
```

⇒ 这一档是"开关**真的被消费**"的真链证据 —— 不是"我加了变量、没人读它"。

### 2.3 档三：`qqProactiveMode=off`（登记的那条耦合）——**部分**

```text
[OBSERVED] 回执 code=opening_without_evidence
[NOT RUN]  ★ 耦合判据：`qqProactiveMode=off` ⇒ `opening_no_live_client`
           —— 判据**顺序**说它在"依据集"**之后**，空库走不到 ⇒ **如实标 NOT RUN**，不假装测到了
```

⚠️ **诚实边界**：`calls 2 → 2` 里的那个 **2** 是核心启动期自己的模型调用（**不是**本门产生的）。
本门所有"零调用"断言都是**前后差值**，所以这一点不影响结论 —— 但读数里必须写出来，免得被读成"启动零调用"。

---

## 3. 本 WP **仍然没有**取到的读数（**不得**当成已通过）

```text
❌ `decision=spoken` + `CHARACTER_OUTPUT` 真的出站   —— 需要**非空依据**（库里得有信念/目标/记忆）
❌ `opening_no_live_client`                          —— 见 §2.3（顺序问题）
❌ 幂等：同一小时第二次 ⇒ `opening_opportunity_already_handled` —— 幂等在**记额之前**，空库从没记过额
❌ **真模型**（适配器仍**从未被调过**；本门用离线夹具，它回 XML 而不是 JSON）
❌ 首用读数（`FIRST-USE`）· 人审
```

⇒ `L-APO-10`（整条链一次都没真跑过）**由本条部分销账**：协议段与两个拒都有了真读数；
**"生成那一段"仍无真读数**。

---

## 4. 激活路径（缺口补上之后）

```text
现在（缺省）      ：什么都不用做 —— `off` ⇒ 端口不注入 ⇒ **重启外壳是安全的**
第一步（取读数）  ：`.env` 加 `CHARACTER_AVATAR_OPENING_MODE=shadow`
                    ⇒ 整条链照跑（含**一次真实模型调用**）但**不出站**
                    ⇒ 这是唯一能在"不真的对她说话"的前提下，把"生成那一段"跑出真读数的档
第二步（真开口）  ：把那一行改成 `=on`
回滚              ：**删那一行**（代码缺省仍是 off）
```

⚠️ `shadow` 档**照旧占额**（冷却 30 分钟 / 日额度 4 次）—— 因为它确实花了一次模型调用。
⇒ 想连续取读数要注意这一条（不是 bug，是"占额"的口径）。

---

## 5. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| `python -m py_compile`（外壳） | EXIT 0 | **0** ✓ |
| **`postlv2:avatar-opening:verify`** | **PASS · 断言 85 项 · measured_count=85** | **0** ✓ |
| **整链门（`tsx scripts/postlv2-avatar-opening-chain.ts`）** | **12 PASS + 2 OBSERVED + 5 NOT RUN** | **0** ✓ |
| `pnpm scripts:catalog:verify` | **一致（603 条）** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 290** | **0** ✓ |
| `pnpm postlv2:qq-proactive:verify` | **233 / 2**（与长期基线**逐字相同** ⇒ 没碰坏共享的 `flags.ts`） | 1（**既存**） |
