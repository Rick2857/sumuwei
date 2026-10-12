# 皮套入口主动开口 · WP5b-2 交接单（`main.ts` 接线完成）

```text
WP     : WP5b-2 —— **装配根接线**：皮套入口的 `openingOpportunity` 端口已实现
日期   : 2026-10-11
上游   : ADR-131 · WP5a · WP5b-0 · WP5b-1
结论   : LG 侧**整条链已接**（报文进来 ⇒ 预检 ⇒ 依据 ⇒ 模型 ⇒ 守卫 ⇒ 复核 ⇒ 仲裁 ⇒ 出站）；
         **但外壳仍然不发那条报文** ⇒ 生产里这条链一次都不会被走到
```

---

## 1. 交付物：`src/main.ts` 三处

| # | 改动 |
|---|---|
| ① | 4 个新符号的 import（预检 · 状态/编排 · 模型适配器 · `asCharacterId`） |
| ② | 两个**进程级懒建**单例：`openingState()`（机会状态）· `openingModel()`（私有调用适配器）——与既有 `proactiveChannelRef` 同一手法 |
| ③ | **端口本体**：挂在 `new TurnBridge({ host })` **之后**、`setOutputSink` **之后**，只对 `spec.entry === 'avatar'` |

### ★ 为什么挂在 `setOutputSink` 之后

`hasLiveClient` 这个读数就是"出站口绑没绑"。放在 `setOutputSink` **后面**，
那个读数在**同一次连接**里立刻为真；放在前面则第一次机会必然报 `opening_no_live_client`。

### ★ 一处真实的耦合（已登记，待读数确认）

`setOutputSink` 只在 `isQqEntry || localDelivery` 时调用，而 `localDelivery` 要求
`qqDelivery !== undefined`（即 `CHARACTER_QQ_PROACTIVE_MODE !== 'off'`）。
⇒ **皮套的主动开口依赖 QQ 主动模式开着**（因为出站口是同一条注入）。
关着 ⇒ `hasLiveClient = false` ⇒ 预检以 `opening_no_live_client` 拒。

---

## 2. 接线后这条链的完整形状

```text
外壳（未改）── ✗ ──> PROACTIVE_OPPORTUNITY
                          ↓ 桥：形状拒 / opening_capability_absent / 填三个桥侧读数
                    host.openingOpportunity（main.ts，本轮）
                          ↓ 喂真读数：policy · flags · control · quota · in-flight · 依据集
                    precheckOpeningOpportunity（15 条具名拒绝，**全在调模型之前**）
                          ↓ 通过 ⇒ **先占额**（含失败也占额，与 lastCareAt 同口径）
                    runOpeningOpportunity
                          ↓ 依据集 ⇒ 一次模型调用 ⇒ JSON ⇒ 形状 ⇒ **回复守卫**
                          ↓ **发送前再读一次依据面**（S04，与生成前同一个函数）
                    arbitrateCharacterOutput（长度 / 来源 / 版本 / 话权，**唯一一处**）
                          ↓ speak ⇒
                    bridge.emitCharacterOutput（既有那条 CHARACTER_OUTPUT）
                          ↓ 表达 sidecar 由 bindSpeechExpression 绑（守卫改写会标 guard_rewrite）
                    外壳（既有播放路径）
```

### 2.1 ★ 两处在这一轮才暴露、并已修掉的错

```text
① `recheckEvidence` 我写成了**同步**的 —— 而真实的复核要**读库**。
   ⇒ 那是一处**会卡住接线**的类型错（装配层拿不出同步的复核）。已改成异步。
   读数：WP4b 探针在改完**仍然 PASS 18/18**（没有为了通过而放宽判据）。

② `bindSpeechExpression(replyId, checkedText, draft)` 靠 `checkedText !== draft.text`
   判断"守卫改写过了"，改写时回落 natural cue 并标 `fallback: 'guard_rewrite'`。
   ⇒ 若装配层把**改写后**的正文同时当 `draft` 传，那个诚实的标记**永远不会出现**。
   ⇒ 修法：编排层额外交出 `draftText`（**守卫改写前**的正文）。
```

---

## 3. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 290** | **0** ✓ |
| `pnpm postlv2:transport:verify` | **PASS · measured_count 78** | **0** ✓ |
| `pnpm postlv2:coexist:verify` | **EXIT 0**（它专门跑 `createCoexistenceEntryServer`） | **0** ✓ |
| `pnpm postlv2:qq-proactive:verify` | **233 通过 / 2 失败**（**与基线逐字相同**） | 1（**既存，见下**） |
| WP4b 探针（异步修完复跑） | **PASS · 18 项 · 失败 0** | **0** ✓ |

### 3.1 ★ 归因：那两条红**不是我碰坏的**

动 `main.ts` 的最大风险是 `L-QQP-09` 那种**静态文本判据**（"全文按词找"）。
所以这次专门对照了**修改前后**的同一道门：

```text
改之前（WP3 时的读数）   ：233 通过 / 2 失败
改之后（本轮）           ：233 通过 / 2 失败   ← **逐字相同**
两条失败项：
  · ★ 正控：**十一处**焊接都在（含"全局上限没被抬高"这条负控式的静态判据）
  · 静态：共用提醒调度过滤已尝试键，主入口实际使用共用调度
```
⇒ 我往 `main.ts` 里加了约 80 行，**这两条判据的读数一个字节都没变** ⇒
它们量的是**别人在途改动**留下的形状（`src/main.ts` 与那个门都被别的会话改过）。
（更早的 WP3 交接单 §4.2 已用外科式 stash 独立证明过一次。）

---

## 4. 本 WP **没有**做的事

```text
· ❌ **外壳未改** ⇒ 仍然**没有任何东西会发这条报文** ⇒ 这个端口在生产里一次都不会被调用
· ❌ 没有真实模型调用（适配器从未被真的调过）
· ❌ 没有落账 / trace / 交付读数（`OPPORTUNITY_RESULT` 已能回，但没有 trace step）
· ❌ 没有"未接线 ⇒ 不花模型调用"之外的**启动期**判据（WP6 的门要它）
· ❌ 没有正式门 / npm script / Scripts-Catalog（WP6）
· ❌ 没动 `.env`、没动 `TD-19`、没动外壳入口守卫
```

⇒ 与 WP5b-1 相比：**LG 侧整条链已经接通了**，插头插好了，**但外壳那一端还没插上去**。

---

## 5. 下一步

| 顺序 | 内容 | 风险 |
|---|---|---|
| **先** | **WP2**：关掉外壳自带的「主动搭话」（**零代码，用户操作**） | 不先关 ⇒ 两条路并存 |
| 然后 | 外壳侧：`proactive_speak` 从"调 `chat`"改成发 `PROACTIVE_OPPORTUNITY`（入口守卫**一个字不改**） | 外壳文件在混合树里 |
| 然后 | 交付读数与 trace（`OPPORTUNITY_RESULT` 的落库/诊断面） | — |
| 最后 | WP6 正式门（探针转正 + npm 登记 + 清单重生成 + 三段式）· WP7 真链路 smoke | 会动 `scripts/` 与清单 |
