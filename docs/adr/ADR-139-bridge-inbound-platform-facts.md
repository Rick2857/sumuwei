# ADR-139 —— 桥上的**入站平台事实**：登记一格、失败关闭与逐消息作用域

- 状态：**ACCEPTED / DESIGN FROZEN** —— 用户 **2026-10-14 裁定「`R-139-1`/`R-139-2`/`R-139-3` 全部按推荐的来」**
  ⇒ `D01`（登记一格）· `D04`（只严格校验这一格）· `D07`（**本切片只做 owner-only 可达**）三条同时生效。
  ⚠️ 该裁定**不**授权"开放非原主人私聊"：那是 U1 的**独立裁定**，且受 S1 零失败门（E-4）约束（见 `D07`）。
- 日期：2026-10-14（Asia/Shanghai）
- 归属：多用户补充计划 **U1 / WP2b-2b 的剩余部分**（[`ADR-133`](ADR-133-multi-user-scope-and-authorization.md) `D05`/`D12` ·
  [`ADR-138`](ADR-138-authorization-filter-before-truncation.md)）· 计划 §5「QQ 协议」行 · §10 U1 行
- 关联交接单：[`Multi-User-U1-WP2b2b-Inbound-Turn-Scope-Handoff.md`](../post-lv2/Multi-User-U1-WP2b2b-Inbound-Turn-Scope-Handoff.md) §5/§5bis
- 关联契约：[`Multi-User-QQ-Bridge-Facts-Acceptance-Contract-2026-10-14.md`](../post-lv2/Multi-User-QQ-Bridge-Facts-Acceptance-Contract-2026-10-14.md)
- ⚠️ 本 ADR **不**开放群入口（那是 **G1**）、**不**动"只收原主人"那道闸（见 `D07`）、**不**改变任何生产行为。

---

## 1. 问题（一句话）

**核心需要"这一轮的发言者是谁"这个事实，而它拿不到** —— 事实在外壳里（OneBot 包），
核心只收到 `userText`；而"谁在问"正是授权过滤的唯一输入（`ADR-138`）。

```text
今天的事实链（已实测）：
  OneBot 包（self_id / user_id / message_type / group_id）
    ⇒ OneBotPrivateClient（L194-197：**不是原主人就丢掉**）
    ⇒ 外壳 LgStdioClient.submit()（`...request` 展开上线）
    ⇒ 核心 TurnBridge（受控登记表 BridgeWireRequest）
    ⇒ ChatSession.send()（**没有**"本轮作用域"参数位）
    ⇒ TurnGateway（会话级 scope：只有本机交互入口有）
```

三层都已经就位、都各自过门（`u1:identity:verify` 26 · `u1:identity-store:verify` 16 ·
`u1:entry-scope:verify` 17 · `u1:inbound-turn-scope:verify` 11），**缺的只是"把它们按一条入站消息接起来"**。

---

## 2. 本轮实测出来的关键事实（决定了为什么必须先裁定）

```text
① 客户端已经把事实带上了（**纯追加**，已做）：
   `onebot-private-client.ts` 的 `Submit` 类型多了可选 `platformFacts`
   （transport / selfId / senderUserId / messageType / groupId?），submit 调用处从包里填好。

② 它**今天就能过桥**：`LgStdioClient.submit()` 是 `this.writeLine({ kind: 'SUBMIT_TURN', ...request })`
   （`src/infrastructure/qq/lg-stdio-client.ts:221`）—— 整个 request 被展开上线，
   未登记字段会作为多出来的 JSON 键到达核心。
   实测：`pnpm qq:verify`（真 `main.ts` + 真桥 + 真 OneBot 夹具）= **EXIT 0 · PASS**
   （`artifacts/post-lv2/qq-private-verify-20261014044256462/result.json`）。

③ 但 `BridgeWireRequest`（`src/kernel/app/bridge/turn-bridge.ts:1413-1448`）**没有这一格**，
   而那张表在本仓库的定性是**受控登记表**（"不建万能连接器"，`ADR-109` `D02`）。
```

⇒ **"它反正能过去"不是设计依据**。要么显式登记一格，要么核心侧丢弃它另想办法。
**这就是本 ADR 要裁定的东西**，也是"接线前必须先裁定"的那一步。

---

## 3. 决策

### `D01` 在受控登记表里**显式登记一格**（`SUBMIT_TURN` 专用）

```text
BridgeWireRequest 追加一个**可选**字段（形状是闭集，不是自由 JSON）：

  platformFacts?: {
    transport: 'qq'          // 闭集：今天只有 'qq'（群也是 qq，靠 messageType 区分）
    selfId: string           // 机器人自己的平台账号（来自包，非自报）
    senderUserId: string     // **真实发言者**的平台账号
    messageType: 'private' | 'group'
    groupId?: string         // 仅 messageType === 'group' 时允许出现
  }
```

**为什么是"字段"而不是"新 kind"**：事实属于**那一轮**，跟着那一轮的请求走天然原子
（没有"先 ATTEST 再 SUBMIT"的跨请求状态可以残留、可以错配、可以在并发下串人）。
被否决的备选：新增 `ATTEST_USER` 消息种类（要引入跨请求状态机与过期规则，收益为零）。

### `D02` 它**不能**用来选入口

入口身份仍由**端口 / `--qq-private` 绑定**（`ADR-109` `D02` 原样有效）。
核心拿到 `platformFacts` 后**必须**与会话**已绑定**的入口交叉核对：

```text
会话入口 = 皮套/本机交互（--bridge 且无 --qq-private）而载荷里带 platformFacts
  ⇒ **整轮具名拒绝**（不是忽略、不是照用）
会话入口 = QQ 私聊而载荷里 messageType === 'group'
  ⇒ 本切片**具名拒绝**（群入口属 G1；见 D06）
```

载荷**永远**只是"事实"，不是"授权"，也不能是"我是谁"的声明（沿用 `INV-PL2-08`）。

### `D03` 缺省 = 逐字不变（这是可回滚的前提）

字段**缺席** ⇒ 不解析、不传 `scope`、不注入授权器 ⇒ 行为与接线前**逐字相同**。
⇒ 老外壳、皮套外壳、所有既有门**不需要改一行**。

### `D04` 校验是**严格**的，但**只**针对这一格

```text
· 未知键 / 空串 / 类型不符 / groupId 与 messageType 不匹配 / transport 不在闭集
  ⇒ **整轮具名拒绝**（不是"取能认的字段、忽略其余"）
· ⚠️ **不**顺手收紧其他既有字段：今天的桥**容忍**未知字段（实测 ②），
  把"容忍"改成"拒绝"是一次**未被要求的收紧**，会把既有外壳变成回归。
  本条的边界就是"只看 platformFacts 这一格"。
```

### `D05` 失败关闭的语义：**不给 scope**，而不是"不设防"

解析不出身份（未绑定 / 拒绝码 / 映射失败）⇒ `failClosed` ⇒ **不传** scope。
若此时授权器已注入 ⇒ 结果是**全拒且计数可观测**（`ADR-138` 既有语义），
**不是**回落到"不注入授权器"那条不设防的路。
⇒ 接线顺序必须"**先**能给出 scope，**再**注入授权器"（交接单 §5 ③）。

### `D06` 群：本切片**只做识别与拒绝**

`message_type === 'group'` 需要群白名单 + `groupAuthorized`（今天没有）⇒ 具名拒绝。
群的触发、缓冲、限频、定向回复是 **G1** 的事，且计划明文要求
"**不通过删除当前私聊守卫来'顺便支持群聊'**"（计划 §4 群聊行）。

### `D07` "只收原主人"那道闸（`onebot-private-client.ts:194-197`）**本 ADR 不动**

```text
现状：非原主人的私聊包被**结构性丢弃** ⇒ 多用户 QQ 私聊今天**根本进不来**。
本切片（D01–D05）在 **owner-only 可达性**下即可完成并过门：
  逐消息解析 ⇒ 原主人这一条路走通 ⇒ 非原主人路径**如实标注为"今天不可达"**。
开放非原主人私聊 = **U1 的独立裁定**，且受 S1 零失败门约束（E-4 受控 QQ 入口链）。
⇒ 本 ADR **不**授权它；门里**必须**有"该路径不可达"的如实读数，不许把它读成"已支持多用户"。
```

### `D08` 不新增任何主张

不改人格 / 权限 / 工具 / 额度 / 情绪与关系的归属规则；印象通路不变；
平台昵称、群名片、会话 ID、聊天里自报的身份**永远**不是身份依据（沿用 X0）。

### `D09` 记录面

事实与解析结果只进 **trace / 读数**，**不进 prompt**；正文不进 trace（沿用既有隐私边界）。
平台账号在读数里按既有遮蔽规则处理，不新开明文出口。

---

## 4. 需要原主人裁定的三件（`R-139-1`…`R-139-3`）

| 编号 | 问题 | 选项 |
|---|---|---|
| `R-139-1` | 是否同意在**受控登记表**里为 `SUBMIT_TURN` 登记一格 `platformFacts`（`D01`） | ①同意（推荐）②不同意 ⇒ 核心侧丢弃该字段，改为"外壳先解析身份再自报 userId"（信任面更大，且外壳要拿到映射表） |
| `R-139-2` | 校验的严格度（`D04`） | ①只严格校验这一格、其余照旧容忍（推荐）②整表严格（会把既有外壳变成回归，需另开一轮兼容工作） |
| `R-139-3` | 非原主人私聊的开放时机（`D07`） | ①本切片只做 owner-only 可达（推荐）②同批开放非原主人私聊 ⇒ 必须先过 S1 零失败门（E-4） |

**未获批前**：`D01` 不落地（登记表不动）、`main.ts` 不接线、生产行为保持"逐字不变"。

---

## 5. 已知边界（如实登记，不当作已解决）

```text
· L-139-01 **信任边界**：桥是**本机可信中继**。事实与 `userText` 走**同一条**通道，
  因此"事实可信度"不会比"用户原话"更高；核心**无法**回头验 OneBot 包。
  ⇒ 这不是本 ADR 引入的新风险（外壳本来就能任意伪造 `userText`），
    但**必须写下来**：不得把 platformFacts 说成"平台级不可伪造证据"。
· L-139-02 同一 QQ 的多账号/换号合并仍**不能自动判定**（X0 既有边界，不变）。
· L-139-03 群入口、主动提醒、定向发送、图片/语音一律不在本切片（G1 / 后续）。
· L-139-04 本 ADR 不改变"未接线时显示实际状态"的要求（计划 §6 后台行）。
```

---

## 6. 与既有 ADR 的关系

```text
· ADR-109 D02（入口由端口绑定）：**原样有效**，本 ADR 的 D02 是它的加强而不是例外。
· ADR-133 / ADR-136 / ADR-137 / ADR-138：语义一字未改；本 ADR 只补"事实怎么到核心"这一格。
· INV-PL2-08（身份由 session 构造时绑定，请求无法改）：**不冲突** ——
  会话绑定的仍是"入口 + 原主人"，逐消息身份是**同一入口内的发言者**，
  且必须与入口交叉核对（D02）。
```

---

## 7. 实施状态（2026-10-14，按裁定落地）

### 7.1 已落地：**协议面这一格**（`D01` + `D04`）

```text
改动（只这一处文件）  src/kernel/app/bridge/turn-bridge.ts
  · 新增 `BridgeInboundPlatformFacts`（闭集）+ **纯函数** `platformFactsProblems()`
    —— 具名码：bad_platform_facts / _key / _transport / _self / _sender / _message_type / _group
  · `BridgeWireRequest` 与 `BridgeSubmitRequest` 各登记一个**可选** `platformFacts`
  · `validate()`：**只**校验这一格（缺席跳过；非法 ⇒ 整轮具名拒绝）
    ⚠️ `D04` 边界原样保留：末尾仍是 `imageInputShapeError(request.images)`，别的未知字段照旧容忍
  · 解析处：**原样转交**给 `submit`；缺席 ⇒ **不加这个键**（`D03`）

新门  `pnpm u1:bridge-facts:verify`（`scripts/u1-bridge-platform-facts-verify.ts`）
      判据 **31** · 失败 **0** · `measured_count=31`
      正控（合法 private / 合法 group / 合法轮次真的回 / 缺席照常回）+
      负控（未知键 · 未知 transport · 空 selfId · 空 senderUserId · 未知 messageType ·
            private 带 groupId · group 缺 groupId · null · 数组 · 字符串 **逐条具名**）+
      恢复（只去掉出错的那一处 ⇒ 合法）+ **失败关闭**（非法 facts 的轮次 `host.runTurn` **一次都不跑**）
      ⚠️ 门自己踩过两个坑并已修：① 两个接口同名字段 ⇒ 切片边界必须用**后一个接口**；
      ② 桩 host 少了 `HostTurnResult` 的必填字段 ⇒ 轮次被判 `failed`（那是**桩**的问题，不是桥的）
```

**回归读数**（协议面改动的直接影响面）：

```text
pnpm qq:verify                = **EXIT 0 · PASS**（真 main.ts + 真桥 + 真 OneBot 夹具；
                                生产树摘要前后一致 · productionDatabaseOpened=false）
pnpm postlv2:transport:verify = **EXIT 0 · PASS（78）**
pnpm typecheck                = **EXIT 0**
pnpm scripts:catalog --check  = 一致（641 条）
pnpm postlv2:affected:verify  = EXIT 0
```

⚠️ **`postlv2:bridge:verify` 在本环境跑不了**（如实记）：它**未登记**在门表里
（manifest 逐字："会起 ElizaOS 运行时，因而**未登记**"），且在本机三种跑法都不成立：
仓库 cwd + `.env` postgres ⇒ `postgres_isolation_not_provided`；
仓库 cwd 钉 pglite ⇒ 它经 `m4-harness` 又报 `postgres_url_without_backend`；
无 `.env` 的 cwd ⇒ 它按**相对路径**读源码 ⇒ `ENOENT`。
⇒ 它不是本改动的回归面（失败发生在建 M4 床之前）；本改动的回归面是上面那三道。

### 7.2 **未落地**（下一包，不要读成"已完成"）

```text
· 核心侧消费：`main.ts` 的四处（`turnScope` / 网关装配 / `send()` 无本轮参数位 / `--bridge` 分支）
  ⇒ 逐消息 `resolveInboundTurnScope` + 每轮 `scope` + 那时才注入 `authorizeCandidates`
· 非原主人私聊：**未开放**（`R-139-3` = ①）—— `onebot-private-client.ts:213-217` 的 owner-only 闸**一字未动**
· 群入口（G1）、主动提醒、定向发送、图片/语音：不在本 ADR
```
