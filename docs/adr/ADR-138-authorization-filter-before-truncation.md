# ADR-138 —— 授权过滤必须早于候选截断（U1 / WP5 前置：`G18`）

日期：2026-10-14（Asia/Shanghai）。状态：**ACCEPTED / DESIGN FROZEN**（**只做设计，不改 `src/**`**）。
归属：多用户补充计划 **U1 / WP5** 的前置裁定（缺口登记载体 [`ADR-133`](ADR-133-multi-user-scope-and-authorization.md) §1.1 `G18`）。
上游冻结：普通用户**不得**读取他人记录（`ADR-133`）；缺标签保守（[`ADR-137`](ADR-137-record-scope-labels.md) `R-WP4-3`）；判定唯一入口 `record-visibility.ts`（WP5 核心，已过门 28/28）。

> ⚠️ **本 ADR 是设计，不是实现**：它不改任何源文件、不建表、不迁移、不激活。
> ⚠️ 它**不**关闭 `G18`：关闭条件是"读取面真的按这个次序过滤"，而今天**一个读取面都还没接线**。

---

## 1. 缺口是什么（逐字复述 + 定位）

```text
G18  召回**截断先于资格层**（`slice(0, limit)` 在 `filterEligible` 之前）
     载体：src/infrastructure/persistence/memory-retrieval-store.ts:345-348
```

实测确认的两件事：

1. `memory-retrieval-store.ts:345-348` 是 `orderedIds.slice(0, query.limit).map(...)` —— **截断发生在排序之后、任何身份判定之前**；
2. `filterEligible` **不在**这个文件里（它的职责在下游的召回服务），也就是说：**截断后的那一批**才是后续判定的输入。

**两个后果（都不涉及"泄露"，而是"该看的看不到"）**

```text
① **缩水**：越权候选占掉名额，把有权看的挤出去 ⇒ 用户看到"她好像不记得了"。
② **静默**：调用方只看到 `hits` 变少，**分不清**"本来就没有"与"被越权候选挤掉了"。
```

⚠️ 为什么它仍然是**安全问题**而不只是体验问题：多用户一旦开放，**任何用户都能通过"多说话"把自己的记录堆进候选前缀**，
从而稳定地压低**别人**的召回面 —— 这是一种**可被外部驱动的可用性攻击**（不需要读任何东西就能让别人失忆）。

---

## 2. 裁定

```text
D01 **次序**：授权过滤**必须先于**候选截断。即 `filter(授权) → slice(limit)`，
    **不许** `slice(limit) → filter(授权)`。
D02 **缺标签的缺省来源域 = 原主人私聊**。理由：档案在单用户时期**只属于原主人** ⇒
    旧记录对普通用户默认**不可见**、对原主人默认可见，且**不回填** origin（`ADR-137` `R-WP4-3` 明令）。
    ⚠️ 它**不是**"把缺标签当成提问者的私聊" —— 那等于给每个陌生人生成一条"你的旧记录"。
    ⚠️ 缺省来源域由**调用方传入**（`ownerPrivateOriginRoom(ownerId)`），store 不许自己猜主人是谁。
D03 **两个维度不许合并**：本裁定说的是**授权**（能不能读）提前；
    **资格**（established evidence / M9 的采信）**保持原位** —— 它是"这条够不够格进上下文"，与"这个人能不能读"是两件事。
    合并两者会得到一个"越权即不成立"的伪语义（记录仍然存在、仍然成立，只是这个人不能读）。
D04 **实现形态**：SQL **批量**读标签（一次 `in (...)`，不做 N+1）+ 纯判定
    （`decideRecordVisibility`，WP5 核心）⇒ 返回**与传入候选同序**的 id 列表。
D05 **缩水必须可观测**：过滤结果如实给出 `denied` 与 `deniedForMissingLabel`
    （并可按 id 给出否决码；**只记 id 与否决码，不记正文**）。
    "被越权候选挤掉"因此**不可能**静默。
D06 **over-fetch 有界**：为了让截断后有 `limit` 条，允许"先取 limit、不够再补"的**有限**补取，
    但**不许**无界扫描全表；补取的轮数与总量必须写在实现里（`R-D18-1`）。
```

**一处已落地的实现骨架**（已过门 12/12 + typecheck，见 §5）：

```text
src/infrastructure/persistence/record-scope-store.ts
  filterAuthorizedMemoryCandidates(db, { context, candidateIds, defaultOriginRoom, roomAuthorized?, … })
    → { authorized（同序）, denied, deniedForMissingLabel, reasons[{recordId, allowed, scopeCode}] }
  ownerPrivateOriginRoom(ownerUserId)   —— D02 的"一处规则"
  scopeContextOf({ principal, purpose, room })
```

---

## 3. 影响面（实施时逐条对照）

```text
必改（接线）
  · 召回调用点：把 `filterAuthorizedMemoryCandidates` 放在**截断之前**（今天截断在 memory-retrieval-store.ts:345-348）
  · 补取策略：按 D06 有界补取（`R-D18-1`）
  · trace：把 `denied` / `deniedForMissingLabel` 如实上报（D05；**不记正文**）

不许改
  · 排序策略（`orderingPolicy` / hybrid / shadow 对照读数）：一个字都不改
  · 资格（eligibility）的语义与位置（D03）
  · M4 记录/事件形状；`AGG`/摘要/reducer
  · 语义探针（`G20`）与其它读取面（`G19`/`G21`/`G22`）—— 它们是**同一批**要接的面，但各自独立裁定
```

**必须复跑的门**（实施后）：`m5:test` / `m5:verify` / `m5.5` 离线门 / `m9:test` / `m9:verify` / `m9.5` 召回相关门 /
`u1:record-visibility:verify` / `u1:record-scope:verify` / `pnpm typecheck`。
⚠️ 真实库**从不打开**：全部读数在隔离库上取。

---

## 4. 判据计划（三段式，实施时随门落地）

```text
正控  越权候选**占满前缀**时，有权看的那条**仍然**出现在结果里（filter→slice 的效力）
      · 返回**同序**（过滤不重排）
      · `limit` 被**填满**（有足够的合法候选时不许少给）
负控① 把实现换成 `slice → filter`（**拆防线**）⇒ 结果为空/缩水 ⇒ **必须判红**
负控② 缺标签 + 普通用户 ⇒ 不可见；缺标签 + 原主人 ⇒ 可见；`deniedForMissingLabel` 如实计数
负控③ 跨群/私聊错位 ⇒ 不可见（复用 WP5 核心的门内形状）
恢复  改回正确次序 ⇒ 重新填满 limit
```

---

## 5. 本轮读数（2026-10-14 当日补取：**已 TAKEN**）

```text
写骨架时本检出的 node_modules 被另一个会话的安装操作降到不健康（`@types/node` 与
`@esbuild/win32-x64` 缺失）⇒ 当时 typecheck 与门都不可用。**恢复后当轮即补取**：
```

| 项 | 读数 |
|---|---|
| `u1:authorized-candidates:verify`（隔离库） | **12 / 12 · failed 0 · EXIT 0** |
| 仓库 cwd 下同一门 | **EXIT 2 · 具名 NOT RUN**（不绿着跳过） |
| `pnpm typecheck` | **EXIT 0** |
| 目录 | `scripts:catalog:verify` EXIT 0（633 条） |

**门里的关键判据**

```text
正控  前三条越权候选占满前缀 ⇒ 合法的两条**仍然**被选出，`limit=2` 被填满 · 返回**同序**
      · `denied=5` / `deniedForMissingLabel=1` 如实（缩水可观测）· 留痕只记 id 与否决码
负控①（拆防线）`slice(2)→filter` 得 **0 条** vs `filter→slice(2)` 得 **2 条** ⇒ 次序就是被量的那件事
负控② 缺标签 + 普通用户 ⇒ 不可见且计数；缺标签 + **原主人** ⇒ 可见（`D02`）
负控③ 同群已授权可见 / 群未授权不可见（`room_not_authorized`）
恢复  正确次序恒定给满（两次调用一致）· 空候选 ⇒ 空结果
```

### 5.1 顺带修掉的一个真缺陷（由 `D02` 逼出来）

```text
`visibilityAllows` 的 `private_to_origin` 分支原来只认 `viewer.kind === 'user'`
⇒ **原主人读自己的私聊来源记录**（以及全部旧的无标签记录）会被判"非来源域本人"而拒绝。
那不是保守，是**坏掉** —— 档案在单用户时期只属于原主人。
修法：来源域本人 = `userId` 与其相等，**不论** `kind` 是 `user` 还是 `owner`；
       "主人读**别人**的私聊来源"仍走独立带审计的特权通路（`decideOwnerPrivilegedRecordRead`）。
复跑：`u1:scope:verify` **54/54** · `u1:record-visibility:verify` **28/28** · `typecheck` EXIT 0。
```

⚠️ **`G18` 仍未关闭**：本 ADR + 门只证明了**被调用的那个函数**是对的；
**读取面还没有接它**（截断仍在 `memory-retrieval-store.ts:345-348`）。

---

## 5bis. 接线已落地（同日第二轮）：**机制**已就位、**装配**未注入

**两处接口决定（实施时才定，记在这里以免"设计里没说"）**

```text
① 授权器注入在 **store options**（装配层），**不**放进 `MemoryRetrievalQuery`：
   授权上下文（谁 · 什么用途 · 哪个空间）是**装配事实**；塞进 query 会让每个调用点自报身份，
   而那正是 `D01` 要防的事。
   `createMemoryRetrievalStore({ …, authorizeCandidates: ({ candidateIds, limit }) => … })`
   ⚠️ **不注入 ⇒ 逐字不变**（与 `semanticMode` / `hybridPolicy` 同一条"缺席=合法状态"的先例）。
② `G18` 的 over-fetch 预算 `R-D18-1` = **复用既有的 `limit × 5`**（`scanCeiling` 仍封顶 500）——
   不新增扫描预算，只是把"授权过滤"插在既有扫描与截断之间。
③ 可观测读数放在结果对象的**可选**字段 `authorization?: { authorized, denied, deniedForMissingLabel }`
   （**只记计数**，不记 id、不记正文）。不注入 ⇒ 字段**不出现**（形状逐字不变）。
```

**读数（实测）**

| 门 | 读数 |
|---|---|
| `u1:g18-wiring:verify`（纯进程内，夹具 store） | **9 / 9 · failed 0 · EXIT 0** |
| `u1:authorized-candidates:verify` | **12 / 12 · EXIT 0** |
| `u1:scope:verify` / `u1:record-visibility:verify` | **54/54** · **28/28**（复跑） |
| `kernel:test` / `kernel:verify` / `m5:test`（召回线） | **EXIT 0**（`kernel:verify` 需在无 `.env` 的 cwd 跑） |
| `pnpm typecheck` / `scripts:catalog:verify` | EXIT 0 · EXIT 0（634 条） |

**接线门里的决定性读数**

```text
T1 不注入授权器 ⇒ 取到**最新的两条**（越权的那两条），且 `authorization` **字段不出现**（形状逐字不变）
T2 注入后 ⇒ 越权候选**不占名额**，结果**向后顺延**取到合法的两条，`limit` 被填满，
   计数如实 `{authorized:3, denied:2, deniedForMissingLabel:1}`，**同序**
T3 **拆防线**：旧次序（先截断后过滤）得 **0 条** vs 新次序得 **2 条**；
   "全放行"授权器 ⇒ 又回到最新的两条（证明**是过滤**把越权候选拿掉的）
T4 再跑一次读数一致（只读、确定性）
```

⚠️ **仍然不是"G18 已关闭"**：本门用的是**夹具 store + 注入的授权器**，证明的是
"**一旦注入，截断就发生在授权之后**"。**装配处（`main.ts` 的召回装配）还没有注入它** ——
授权上下文（谁 · 什么空间）在入口那条线上尚未贯通，那是 WP5 接线的剩余部分。
⇒ **生产行为今天就等于 `T1`**（不注入 ⇒ 与之前逐字相同）。

---

## 5ter. 作用域贯通（同日第三轮）：**每轮上下文到得了检索层**，装配仍未注入

**问题**：召回适配器在**装配时**构造一次（`main.ts:1930`），而"这一轮是谁在问、在哪个空间问"
是**每一轮**的事实 ⇒ 只靠 store options 的闭包拿不到它。

**做法（三处可选字段 + 授权器拿到 query）**

```text
① `RecallRequest.scope?: ScopeContext`（contracts/recall.ts）
   与 `user` 同一条信任边界：**由服务端装配层给出**，不许来自请求载荷。
② `MemoryRetrievalQuery.scope?: ScopeContext`（kernel/recall/ports.ts）
   由召回服务的 `translate()` 从 request 透传（缺省 ⇒ 字段不出现 ⇒ 行为一字不变）。
③ 授权器签名加 `query`：`authorizeCandidates({ candidateIds, limit, query })`
   装配闭包因此能读 `query.scope` 做标签查询。
```

**失败关闭的形状（写进类型注释与门里）**：装配层注入了授权器、而 `query.scope` 缺失 ⇒
**拒绝全部候选**（`hits=0`），且 `authorization.denied` 如实等于候选数 ⇒
"忘了传作用域"表现为**可观测的全拒**，**不可能**变成静默放行。

**读数（`u1:g18-wiring:verify` 扩到 12 条，EXIT 0）**

```text
T5.1 **端到端**：`RecallRequest.scope` 经 `createMemoryRecallService` 的 `translate()`
     到达授权器的 `query.scope`（逐字相同）
T6.1 注入授权器 + 查询无 scope ⇒ 全拒（hits=0）且 `denied = 候选数`（静默放行不可能）
T6.2 补上 scope 后同一查询恢复（失败关闭是"缺上下文"，不是"永久拒绝"）
```

**回归**（本轮同时改了 `contracts/recall.ts` / `recall/ports.ts` / `app/recall/retrieval.ts`）：

```text
typecheck EXIT 0 · kernel:test EXIT 0（须在仓库 cwd：它有按 cwd 扫描 src/kernel 的边界判据）·
kernel:verify EXIT 0（须在无 .env 的 cwd）· m5:test（kernel-tests-recall）EXIT 0 ·
u1:record-visibility:verify 28/28 · scripts:catalog:verify EXIT 0（634 条）
```

⚠️ **装配仍未注入**：`main.ts` 的召回装配**一个字都没改** —— 注入的前提是入口能把
"谁 · 什么空间"解析出来（WP2b-2b 的身份接线）。所以 **`G18` 仍未关闭，生产行为仍是 `T1`**。

---

## 5quater. 抓到一个"看起来接上了其实没接"的真缺陷（同轮修掉）

**缺陷**：`scope` 加进了 `RecallRequest` 类型，但 **`createRecallRequest` 是显式列字段的工厂
⇒ 新增字段被静默丢掉**。而上一轮的门用 `as unknown as RecallRequest` 断言构造请求，
**类型断言正好绕过了校验与字段拷贝** ⇒ 门是绿的，路是断的。

> 这正是本仓库最贵的一类缺陷的形状（`L-QQP-09` 的同族）：**量具绕过生产路径**。

**三处修法（同轮落地）**

```text
① `NewRecallRequest.scope?` + `createRecallRequest` 校验并携带：
   principal.kind / purpose / room.kind / room id 四样都要能判，否则**具名拒绝**
   （`recall_scope_bad_principal` / `_bad_purpose` / `_bad_room` / `_bad_room_id`）。
   ⚠️ 校验里先取成 `string` 再比较：反复比 `kind` 会被 TS 收窄成 `never`（本仓库踩过多次）。
② `serializeRecallRequest` / `recallRequestDigest` **排除 `scope`**：
   授权上下文是**每一轮**的事实，固化进记录/trace 会让回放用上一轮的身份；
   而且"序列化写它、反序列化丢它"会让往返**不幂等**。
③ `parseRecallRequest`（**唯一**接受外部形状的入口）**显式拒绝**载荷里的 `scope`
   （`recall_scope_from_payload`）：否则 WP3 适配器 / WP7 回放 / 未来的外部证据
   都能自称原主人 —— 那是**提权**，不是"宽容一点"。
```

**读数（`u1:g18-wiring:verify` 扩到 18 条，EXIT 0）**

```text
T7.1 `createRecallRequest` **真的带上** `scope`（走生产构造路径，不再用类型断言）
T7.2 记录材料**不含** `scope` 键
T7.3 摘要**不因 scope 变化**（有/无 scope 的同一请求摘要逐字相同 ⇒ 旧读数不变）
T7.4 往返一致：序列化不写、解析不产（不会"存了却没读回"）
T7.5 **载荷自带 scope ⇒ `recall_scope_from_payload`**（提权防线）
T7.6 形状失败关闭：未登记用途 / 空空间 id ⇒ 具名拒绝
```

**本轮的回归与**未取得**的读数（分列，不许合成一个总分）**

```text
取得：typecheck EXIT 0 · kernel:test EXIT 0（仓库 cwd；含依赖方向判据）·
      m5:test（kernel-tests-recall）EXIT 0（无 .env 的 cwd）· scripts:catalog:verify EXIT 0（635 条）
未取得：`m6.1:recall-coverage` = **NOT RUN** —— 它要对 `<cwd>/data/pglite` 取树摘要（须仓库 cwd），
        而仓库 cwd 又让 `isolateDatabase()` 以 `postgres_isolation_not_provided` 拒（PG 激活的 `.env`）
        ⇒ 本环境**跑不了**，如实登记（同 `m3:migrate-gate` / `m4.5:test`）。
```

---

## 5quinquies. 网关侧注入点（同日第四轮）

```text
`TurnGatewayOptions.scope?: ScopeContext`（可选）
  ⇒ `recallForTurn` 把它原样带进 `createRecallRequest({ …, scope })`
  ⇒ 与 `commitmentFactRows` 同一条先例：**用可选选项实现**；不传 ⇒ 字段不出现 ⇒ 与接线前逐字相同。
```

**为什么放在网关**：网关是"这一轮"的装配点（它已经有 `userId` 这个同类事实），
而召回适配器是**装配一次**的 —— 每轮的"谁 · 什么空间"只能从网关这一侧流下去。

**验证（同日补取：端到端读数已 TAKEN）**

```text
取得：`pnpm typecheck` EXIT 0
      `u1:g18-wiring:verify` 18/18（T7.1 证的是**请求构造路径**真的带 scope）
      **`u1:gateway-scope:verify` 5/5**（补上本轮欠下的读数）：
        T1.0 真 `TurnGateway` 走完 `beginTurn → compileTurn`（**不调 `completeTurn`** ⇒ 零模型 / 零出网）
        T1.1 传了 `scope` ⇒ **间谍检索端口**在 `retrieve(query)` 上看到的 `query.scope` **逐字相同**
        T2.0/T2.1 不传 ⇒ 整轮照常跑完，且 `query.scope` 是 **`undefined`**（不是空对象、不是默认作用域）
        T3.1 拆防线：把"不传"补成原主人作用域 ⇒ 与真实读数相反（凭空造出授权上下文会被判红）
```

⚠️ **`main.ts` 仍未设置这个选项** ⇒ 生产行为一字未变；`G18` 的关闭仍差"入口接线"这一步。

---

## 5sexies. **每轮**作用域（同日第五轮）：群场景必需的形态

**为什么"每网关一个 scope"不够**

```text
入口维度共享会话（`CHARACTER_ENTRY_SCOPED_CONVERSATIONS`）⇒ **一个 QQ 会话服务多个用户**。
  · 私有入口：一个会话基本对应一个说话人 ⇒ 网关级 scope 够用
  · **群**：一个会话、多个说话人 ⇒ 网关级 scope **必然错**（第二个说话人会继承第一个的作用域）
```

**做法（加性）**

```text
`CompileTurnInput.scope?: ScopeContext`（**本轮**的作用域）
  ⇒ `recallForTurn({ …, scope })`
  ⇒ 请求里的 scope = **本轮 ?? 网关选项**（都没有 ⇒ 字段不出现 ⇒ 逐字不变）
```

**读数（`u1:gateway-scope:verify` 扩到 7 条，EXIT 0）**

```text
T4.1 网关选项**没有** scope、只有本轮给了 ⇒ 端口看到的是**本轮**那个（每轮身份因此可行）
T4.2 两边都给了且**不同** ⇒ **本轮赢**（群里的第二个说话人不会继承第一个的作用域）
```

**回归**：`typecheck` EXIT 0 · `kernel:test` EXIT 0（网关属领域层）· `scripts:catalog:verify` EXIT 0（636 条）。
⚠️ 仍未取得的是**生产侧**读数：`main.ts` 还没有任何一处设置它。

**全量回归（本轮收尾跑，13 道门 277 条判据全绿）**

```text
u1:scope 54 · u1:identity 26 · u1:identity-store 16 · u1:recorder-identity 15 ·
u1:new-user-relationship 11 · u1:record-scope 17 · u1:record-visibility 28 ·
u1:authorized-candidates 12 · u1:g18-wiring 18 · u1:entry-scope 17 ·
s1:rejection-suite 16 · s1:rejection-evidence 18 · s1:isolation-stub 29
⇒ 13 / 13 EXIT 0 · 277 条判据 · 0 失败
```

---

## 6. 未决

```text
R-D18-1  over-fetch 的补取轮数与总量上限（D06 要写死一个数，本轮未定）
R-D18-2  `G19`（三处读面按 owner/id 读、无 subject 过滤）是否与本次同一批接线
R-D18-3  `G22`（入模装配阶段只有预算判据、无身份判据）是否改成"最后一道身份复核"
         —— 它与 D03 的"资格保持原位"直接相关，需独立裁定
```
