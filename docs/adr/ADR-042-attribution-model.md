# ADR-042：Attribution Model —— 把「归因」与「认知资格」拆开

- 状态：**ACCEPTED / DESIGN FROZEN**（正式 Design Freeze Review，2026-09-18）
- 里程碑：M5.1.1 Correctness Milestone（独立于已冻结的 M5.1）
- 立案来源：`../m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md`（**P1 · OPEN**）
  —— **本 ADR 获批不关闭 D01**；其关闭被 ADR-043 阻塞（见 §8）
- 相关：
  - 配套设计文档（`../m5.1.1/`）：Proposed-Schema · Migration-Strategy ·
    Compatibility-Matrix · Affected-Surface-Map · Test-and-Gate-Plan · Unresolved-Decisions
  - 送审与裁定记录：`../m5.1.1/M5.1.1-Revision-2.1-Review-Summary.md`
  - **ADR-043**（`../m5.1.1/M5.1.1-ADR-043-Epistemic-Requalification-Draft.md`，
    状态 **DRAFT / NOT APPROVED**）—— **Phase 4 的硬依赖**
- 裁定：
  **归因与认知资格是两条独立的轴 = ACCEPT** ·
  **`actor_type` = legacy presented / message role（**不是** attribution 的投影）= ACCEPT** ·
  **认知资格只能由已确立的 `contentOriginator` 抬升 = ACCEPT** ·
  **Phase 4（切换 Fact Firewall 输入）= DEFER（BLOCKED BY ADR-043）**
- 变更历史：Draft v1 → Revision 2（B1–B7）→ **Revision 2.1（F1–F4）**；
  三份变更记录（§10、§11）与全部设计依据**原样保留，未重写历史**

---

> **迁移说明（2026-09-18）**：本 ADR 在设计阶段位于
> `../m5.1.1/M5.1.1-Attribution-ADR.md`；正式 Design Freeze 后依仓库既有 ADR 规范
> 迁入本目录（`git mv`，历史保留）。原路径保留一份**不含规范内容**的重定向说明 ——
> 目的是**不产生第二份权威**，这正是本 ADR 的核心结论。

**配套设计文档（`../m5.1.1/`）**

| 文档 | 内容 |
|---|---|
| [`M5.1.1-Proposed-Schema.md`](../m5.1.1/M5.1.1-Proposed-Schema.md) | 提案 schema（v7 形状 + 字段级语义 + authoritative/observational 分级） |
| [`M5.1.1-Migration-Strategy.md`](../m5.1.1/M5.1.1-Migration-Strategy.md) | 迁移策略 + 历史回填矩阵（D/P/U/N）+ rollback / forward compat |
| [`M5.1.1-Compatibility-Matrix.md`](../m5.1.1/M5.1.1-Compatibility-Matrix.md) | `actor_type` 的 legacy 定位 + 三套词汇表对照 |
| [`M5.1.1-Affected-Surface-Map.md`](../m5.1.1/M5.1.1-Affected-Surface-Map.md) | Query / Trace / Observability / Console / Execution Truth 影响面 + 冻结区含义 |
| [`M5.1.1-Test-and-Gate-Plan.md`](../m5.1.1/M5.1.1-Test-and-Gate-Plan.md) | 六类验收场景 + G-AT-1~4 + 七个 evidence-consistency mutation |
| [`M5.1.1-Unresolved-Decisions.md`](../m5.1.1/M5.1.1-Unresolved-Decisions.md) | U-01~U-19 的最终 STATUS / DECISION / RATIONALE / LANDING |
| [`M5.1.1-ADR-043-Epistemic-Requalification-Draft.md`](../m5.1.1/M5.1.1-ADR-043-Epistemic-Requalification-Draft.md) | **ADR-043 草案**：旧认知的重新资格化（Phase 4 由它裁定） |

> **命名对照（强制保留）**
> `Draft-v1 name: sourceAuthor` → `Revision-2 canonical name: contentOriginator`。
> 全文只有**一个**概念，不使用两个并行术语。

---

## 1. Context —— 缺陷的真实形状（比"少一个字段"深一层）

M5.1-D01 的触发实例是：用户从未打过"示科"，她却记住了并有 `EXPLICIT_USER_STATEMENT` 出处。
追查代码后，完整的因果链是（**代码锚点已核对**）：

```text
①  写入侧：某次会话由 agent 以用户身份提交「记住，我现在上的大学是示例工程科技大学」
             → conversation_events 落一行 actor_type='user'
               （**与用户亲手打的字无法区分**）

②  计算侧：contracts/source-authority.ts
             sourceKindForActor('user')                 → 'user_statement'   （**全函数**，L64）
             defaultAuthorityForKind(...)               → 'USER_EXPLICIT'
             canSupportExternalFact(...)                → **true**（白名单命中，L202）

③  决策侧：**Fact Firewall 的唯一输入是 actorType**
             kernel/contracts/conversation-event.ts:363  canEvidenceExternalFact(event)
               内部只看 event.actorType（character/system → 否；user/tool → 是）
             kernel/app/memory/extractor.ts:149          defaultAuthorityForKind(sourceKindForActor(view.actorType))
             kernel/app/memory/extractor.ts:329          事实类必须有可支持外部事实的证据（执行点）

④  落库侧：**provenance 没有被持久化**
             conversation_events 无 source_kind / source_authority / epistemic_source 列；
             infrastructure/persistence/event-store.ts 也不写它们

⑤  读回侧：infrastructure/persistence/conversation-store.ts:79
             deriveSourceForLegacyRow(actorType)  **从 actor_type 重新推导**
             （contracts/conversation-event.ts:335 定义；migrations.ts:266 的注释记录了该取舍）
             → "当时到底是谁写的"这个信息**从未存在过**，
               而读回来的却是一个**语气确定的** USER_EXPLICIT

⑥  后果：memory 的 MemoryAuthority 拿到 USER_EXPLICIT
             → education.institution = 示例工程科技大学 成为"用户明确陈述的事实"
```

### 1.1 缺陷不是"忘了存作者"，而是两条轴被压成了一条

```text
轴 A —— 归因（who）：      actor_type + actor_id
                           取值：user | character | system | tool（**一根轴，四个值**）

轴 B —— 认知资格（能支持什么结论）：
                           SourceKind → SourceAuthority → EpistemicSource
                           （模型已经很完整：USER_EXPLICIT / USER_REPLY_CONFIRMATION /
                             DIRECT_INTERACTION / TOOL_OBSERVATION /
                             CHARACTER_GENERATION / SYSTEM_INSTRUCTION）

耦合：sourceKindForActor(actor_type) 是**全函数** ⇒ 轴 B **完全由**轴 A 决定
      ⇒ actor_type='user' 是**唯一**的输入，就足以让内容获得"支持外部事实"的资格
```

**Assistant Fact Firewall 本来只防"她自己生成的内容变成事实"。
它防不住"别人以她的用户身份提交的内容变成事实"——因为在今天的模型里，
`actor_type='user'` 与"人亲手输入"是同一个东西。** 这就是 D01。

### 1.2 代码里那个取舍，正是"伪造"的来源

`deriveSourceForLegacyRow` 的注释明写：

> 这样做的代价是旧行没有"当时声明的来源"，收益是账本里
> **不存在来源未知的事件** —— 后者对 M4 更危险。

这个取舍在当时是合理的（M4 需要一个来源总能被算出来）。但它的副作用是：
**当归因信息不足时，系统不会说"不知道"，而是给出一个由粗粒度字段推导出来的确定答案。**
本 Revision 2 显式推翻这个取舍，并如实计入换来的风险（§6.2）。

### 1.3 `actor_type` 的证据强度（B1 的前提）

```text
actor_type='user' 只能证明：该事件以 user role 提交。
它**不能**证明：内容是用户本人产生的。
```

因此 `actor_type` 在新模型里是 **legacy presented / message role**
（**不是** attribution 的投影，也**不是** actor 的粗粒度投影 —— 见 D8.1），
它**不是** authoritative actor，也**不是**新 Attribution Model 的事实源。

---

## 2. Decision

### D1 —— 归因与认知资格是两条**独立**的轴

轴 A 回答"谁"，轴 B 回答"这条内容有资格支持什么结论"。**轴 B 不得再由轴 A 单独决定。**

具体地：`canSupportExternalFact` 的可达性必须同时要求
**轴 A 给出了足够确立的来源证据**（至少 `contentOriginator` 被确立为
`USER`，或由其他已确立的合法来源承担），而不只是 `actor_type='user'`。

**落地锚点（实现阶段才动，本轮只登记）**：

```text
kernel/contracts/conversation-event.ts:363  canEvidenceExternalFact  ← 必须消费已记录的 attribution
kernel/app/memory/extractor.ts:149          推导调用点                ← 必须改为读取已记录值
kernel/app/memory/extractor.ts:329          执行点（保持）
src/kernel/app/memory/** 是**冻结区** ⇒ 语义变更需新里程碑 + ADR + 全套 m4:*
                                      （AGENTS §3；本 ADR 正是那个 ADR）
```

> `sourceKindForActor` 作为"类型安全的默认映射"**降级为 legacy classifier**，
> 不再作为新事件的 authoritative 全函数（U-08 已裁定）。

### D2 —— 归因是**被记录**的事实，不是**被重新推导**的结果

```text
WRITE :  记录当时**实际确立**的归因（连同"不知道"一起）
READ  :  读取已记录的值
NEVER :  从 actor_type 重建 authoritative 认知状态
```

`deriveSourceForLegacyRow(actor_type)` 只能作为**一次性迁移**的输入分类器，
**不得**留在常规读路径上（见 D11 与 §4）。

### D3 —— 未知是**认知状态**，不是主体类型

`Unknown` **不进入** `PrincipalKind`，也不进入 `AuthorityKind`。
未知通过 `AttributionValue` 的 `Unknown<UnknownReason>` 表达，并且：

```text
✅ 是可查询、可计数、可被审计看见的
✅ 是 fail-closed 的：Unknown **不得**进入 EXTERNAL_FACT_AUTHORITIES
❌ 不得被回填成 'user' / 'USER'（那正是 D01 的成因）
❌ 不得与"该槽位对本事件不适用"（Absent）混为一谈
```

### D4 —— **物理必要性原则**：事件只携带它自己需要的归因槽位

见 §5 的专论。**不需要的槽位必须 `Absent`，而不是填空。**
"为了字段完整"而填值是**伪造语义**，且会让"未知"与"不适用"都无法表达。

### D5 —— 最小模型：`PrincipalRef` / `PrincipalKind` / `AttributionValue`

```ts
type PrincipalKind =
  | 'USER' | 'CHARACTER' | 'SYSTEM' | 'SERVICE' | 'TOOL'
  | 'EXTERNAL_ACTOR'                    // **没有** UNKNOWN*

type UnknownReason =
  | 'LEGACY_UNRECORDED'                 // 该概念本应存在，但历史没有记录
  | 'RUNTIME_UNRESOLVED'                // 该概念本应存在，但运行时未能确定

type AttributionValue<T> =
  | { state: 'KNOWN'; value: T }
  | { state: 'UNKNOWN'; reason: UnknownReason }
  | { state: 'ABSENT' }

interface PrincipalRef {
  kind: PrincipalKind
  id: string                  // 形如 u-… / char_… / scheduler / weather / svc:telemetry
}
```

**与 Entity Model 解耦的硬约束**

```text
· PrincipalRef **不是** CharacterId / UserId 的替代品，也不与之相互转换
· 它只有 kind + id 两个字段；**不得**在这里挂 displayName / traits / relationships
· 「谁是同一个实体」属于未来 Entity Model，**不**由 attribution 回答
· attribution 回答的是"这个位次上是谁"，不是"这个实体是什么"
```

对照现有 `ActorType`：`user | character | system | tool`（4）→ `PrincipalKind`（**6**，新增
`SERVICE` / `EXTERNAL_ACTOR`）。**`ActorType` 的四个既有值不改名、不改语义。**

> **U-02 已裁定**：不新增 `PrincipalKind.DEVELOPER`。
> developer 是**上下文角色**，不是主体种类：
> 能确认真实开发者人类身份 → `initiator = USER/<developer-id>`；
> 无法确认 → `initiator = Unknown(RUNTIME_UNRESOLVED)`；
> control plane 本身可作为 `SERVICE` actor；`cli/http/page` 只作 transport metadata。

### D6 —— 七个槽位的严格语义（含"对哪个判定程序而言是 authoritative"）

| 槽位 | 严格语义 | 回答的问题 | 权威性（相对哪个判定程序） |
|---|---|---|---|
| `subject` | 该事件**描述的是谁**（谁的账本、谁的经历） | 这是关于谁的 | **归属**：投影分派（由既有 canonical domain owner 派生，**不重复存储**） |
| `initiator` | **发起**这件事的位次（动机来源） | 这是谁提出/触发的 | **Execution Truth**：谁发起 |
| `actor` | **作出决定**并实施行为的位次 | 谁决定干的 | **Execution Truth** + **Audit** |
| `executor` | **真正执行**的系统/服务/工具（可能是外部） | 哪个东西真的动了手 | **Execution Truth**：Agent 与 executor 必须可分离 |
| `authority` | **凭什么允许**它发生（不是"谁"，而是"哪条许可"） | 依据是什么 | **Execution Truth**：没有 authority 就不许有副作用 |
| `recordedBy` | 谁把这条事实**写入账本** | 这条记录是谁写的 | **Audit**：账本完整性 |
| `contentOriginator` | 这段**语义内容**是谁产生、声明或提供的 | 内容从谁那里来 | **Fact Firewall**：唯一能抬升认知资格的依据 |

**三条必须写清的边界**

1. **`actor` 与 `contentOriginator` 不是一回事。** 她说了一句话：`actor = CHARACTER`，
   但若那句话是人类替她写的（例如剧本/替发），`contentOriginator` 仍是那个提交者。
   反过来，用户说的话：`actor = USER`，`contentOriginator = USER`。
   **把两者合并正是 D01 的成因。**

2. **`contentOriginator` 是语义来源，不是键盘操作者。**
   它回答"这段语义内容是谁产生、声明或提供的"，
   **不**回答"谁按下了回车"。这是 Revision 2 对 Draft v1 的修正（B2）。

3. **`subject` 与 `actor` 不是一回事。** "关于苏沐薇的事件"不等于"苏沐薇做的事"。
   这条看似显然，但它正是 M5.1-D01 指定的 Hard Gate（见 D10）。

**`contentOriginator` 的三个标准示例**

```text
人类亲自表达
  → actor_type = user
  → contentOriginator = Known(USER/<id>)

agent 生成内容并以 user role 提交
  → actor_type = user
  → contentOriginator = Known(SERVICE/<agent-id>)
  ⇒ actor_type=user **永远不能单独证明** contentOriginator=USER

外部代理提交
  → contentOriginator = Known(EXTERNAL_ACTOR/<id>)
```

### D7 —— 统一 envelope，**差异化**要求

```text
统一： 七个槽位是**同一套**语义、同一套 kind 词汇、同一种三态规则
        → 否则 Query / Audit / Trace 会各有一套归因口径

差异化：**每个事件族要求的槽位不同**（由 §5 的必要性矩阵给出）
        conversation_events：subject, actor, contentOriginator, recordedBy
        character_action_events：subject, initiator, actor, authority, recordedBy
                                 （+ 有副作用时 executor 必需）
```

理由：把两套表强行合并成"所有列都填"会立刻违反 D4；
把两套语义分开定义又会让审计无法统一查询。**统一语义 + 差异化必要性**是唯一同时满足两者的形状。

**B5.1 对 authority 必要性的修正**（请求 §7）：

```text
ACTION_REQUESTED          authority = ABSENT      ← 请求发生 ≠ 请求已获授权
ACTION_AUTHORIZED         authority = REQUIRED
SIDE_EFFECT_EXECUTION     authority = REQUIRED
（ACTION_STARTED / SUCCEEDED / FAILED / PARTIAL / CANCELLED 属执行侧）
```

> **已核实**：`ACTION_AUTHORIZED` **已经存在** 于 `ActionEventType`
> （`kernel/action/execution-ledger.ts`，与 `ACTION_REQUESTED` /
> `ACTION_TARGET_RESOLVED` / `ACTION_REJECTED` / `ACTION_STARTED` /
> `ACTION_SUCCEEDED` / `ACTION_FAILED` / `ACTION_PARTIAL` / `ACTION_CANCELLED` 并列）。
> **因此不需要新增生产事件**，只需把 authority 从请求事件移到授权/执行事件。
>
> 并保持 Execution Truth：`requested ≠ authorized ≠ attempted ≠ executed ≠ verified`。

### D8 —— `actor_type` / `actor_id` 的兼容策略（B1 修正）

`actor_type` / `actor_id` **保留且语义不变**，但明确定位为：

```text
legacy presented / message role（兼容列）
```

```text
· **不重定义** actor_type 的任何既有取值（历史行与既有查询都依赖它）
· 新归因以槽位形式**并存**（additive），不替换 actor_type
· actor_type **不得**成为新 Attribution Model 的事实源
· 它是 **legacy presented / message role**：由 **event family / message role** 决定，
  **不是** attribution 的投影，也**不是** actor 的粗粒度投影
· 二者在迁移期**并存，但不要求语义相等**（见 D8.1）
· 废弃需要显式日落条件与版本号，见 Compatibility-Matrix
```

#### D8.1 —— **Rev 2.1 删除"方向反转"**（附反例）

```text
已删除（Rev 2 的错误规则）：
  ✗ actor_type === projectActorTypeFromSlots(...)   （Phase 2 的写入期断言）
  ✗ 槽位成为输入、actor_type 成为**派生输出**         （Phase 3 的方向反转）
  ✗ actorTypeFromPrincipalKind 的反向投影            （旧 ActorType 没有 SERVICE）

为什么必须删除 —— 反例就是 D01 本身：
  event family      = user_message
  actor_type        = 'user'                       ← 以 user role 出现
  actor             = Known(SERVICE/<某 agent>)
  contentOriginator = Known(SERVICE/<某 agent>)
  ⇒ 三者**同时为真**，且**完全合法**
  ⇒ 若把 actor_type 定义成 actor 的投影，这一行将**无法表达** ——
    D01 会以另一种方式回来（系统只能把 SERVICE 记成 user，或拒绝写入）

正确语义：
  actor_type = legacy presented / message role = 由 event family / message role 决定
  actor      = actual attribution principal    = **独立记录**
  二者并存，**不要求语义相等**
```

**一致性 Gate（唯一允许的一致性检查）**

```text
检查的是 **event family → actor_type**，而不是 attribution → actor_type：

  user_message      → actor_type = 'user'
  assistant_message → actor_type = 'character'
  tool_event        → actor_type = 'tool'
  system_event      → actor_type = 'system'

✗ 禁止判据：actor = Known(SERVICE) ⇒ actor_type 应当也是 SERVICE
   （旧 ActorType 连 SERVICE 都没有；这条检查在**类型上**就不可能成立）
```

> **类型层面的旁证**：`ActorType = user | character | system | tool`（4 个值），
> 而 `PrincipalKind` 有 6 个值。二者**不是**同一根轴的不同粒度，
> 而是**两个不同的概念**（呈现角色 vs 实际位次）。
> 因此任何"互相投影"的设计都与类型域本身的形状矛盾。

**禁止（B1 的核心）**

```text
✗ actor_type='user'  →  actor=USER          作为**通用历史回填规则**
✗ conversation_events.actor 整列判为"可确定"
✗ character_action_events 整表判为"可确定"
```

**历史迁移规则（改为）**

```text
conversation_events.<slot>
  → 默认 Unknown(LEGACY_UNRECORDED)
  → 除非存在**独立、权威、可复核**的证据证明该槽位的实际值

character_action_events.<slot>
  → **按 event family / event type 分别证明**
    哪些可确定（D）、哪些部分确定（P）、哪些未知（U）、哪些不适用（N）
```

### D9 —— Control API 的 `requestedBy` 必须进入 durable authoritative audit ledger

现状：`ControlCommand.requestedBy = { kind: 'developer', surface: 'cli'|'http'|'page' }`
**从来没有进入事件账本**（控制命令按 L-02 不写 trace）。

**U-03 已裁定**：

```text
Privileged Developer Control **必须最终**进入 durable authoritative audit ledger。
**不得**永久选择"控制面不参与 attribution 权威"。
```

正确模型（U-02 + B5 合成）：

```text
initiator  = Known(USER/<developer identity>)
             或 Unknown(RUNTIME_UNRESOLVED)
actor      = Known(SERVICE/<control-plane>)
transport  = cli / http / page      # **observational only**
authority  = Known(CAPABILITY/<developer-control capability>)
             或 Known(POLICY/<policy>)
```

禁止：

```text
✗ authority = DEVELOPER_SURFACE        （transport 不是许可，见 B5）
✗ 为了省事把 Control Command 假装成普通 Character Action
```

本轮只确定**设计要求**；若需要物理新表，留到 M5.1.1 implementation plan。

### D10 —— Hard Gate：**不得**从粗粒度字段推断作者或发起者

> **不能仅凭 Character 是事件主体，就推断 Character 是作者或发起者。**
> 同理：**不得仅凭 `actor_type='user'` 推断"人类亲手输入"**，
> 也不得据此推断 `contentOriginator=USER`。

**禁止的是"无证据推导"，不是"两个字段恰好相等"**（B6 修正）：

```text
Prohibited   : derive B from A without evidence
NOT prohibited: A and B legitimately have the same value

合法反例（必须能通过）：
  角色自主发起 → subject=CHARACTER, initiator=CHARACTER, actor=CHARACTER
```

因此负控的判据改为 **"字段值与权威证据冲突 → FAIL"**，
而不是 `field A != field B`。详见 `Test-and-Gate-Plan`（G-AT-1~4 与七个 mutation）。

### D11 —— 迁移：只追加、不回填猜测、历史标 `Unknown(LEGACY_UNRECORDED)`

见 [`M5.1.1-Migration-Strategy.md`](../m5.1.1/M5.1.1-Migration-Strategy.md)。四条硬约束：

```text
1. 只追加新迁移版本号（当前 v6 → v7）；既有 DDL 0001–0006 一字不改
2. 新列可空或带默认值（M3 的 0003 教训）
3. 历史回填**逐（event family × slot）**判定，四态：
      D deterministic · P partial · U unknown · N not applicable
   **不可确定**者必须是 Unknown(LEGACY_UNRECORDED)，不许用 actor_type 反推
4. **Phase 4 由 ADR-043 裁定**（见 §8）
```

### D12 —— replay / rebuild 一致性

```text
· attribution 是**事件的一部分**，因此 replay 必须原样重现它（不重新推导）
· 投影（projection）**不得**在做归因判断；它只能消费
· 「删掉投影 → 从事件重放 → 逐字段一致」这条 MI-11 性质
  在加入 attribution 之后仍然必须成立，且 attribution 不同的两行
  **不得**因为投影而变得相同（否则审计信息在投影层丢失）
· rebuild 之后，Unknown(LEGACY_UNRECORDED) 必须**仍然是** Unknown；
  不得因为重放而被"洗"成 KNOWN
```

---

## 3. Attribution Construction & Attestation Boundary（B3 · Revision 2 新增）

> 本节回答：**谁有资格填写每一个 authority-bearing attribution field？**
> 设计边界，不含实现。

### 3.1 构造者表（每个 authority-bearing 字段的合法构造者）

| 字段 | 合法构造者 |
|---|---|
| `contentOriginator` | trusted ingress adapter |
| `initiator` | trusted command / action ingress |
| `actor` | authoritative decision point / gateway |
| `executor` | actual executor |
| `authority` | policy / capability evaluator |
| `recordedBy` | ledger writer |
| `subject` | canonical domain context（派生，非新存储） |

### 3.2 核心不变量

> **Authority-bearing attribution MUST NOT be self-asserted
> by an untrusted caller.**

必须禁止的情形（示例）：

```text
agent request payload:
{
  contentOriginator: USER,          ← untrusted caller 自报
  authority: CAPABILITY             ← untrusted caller 自报
}
→ 然后系统无条件信任
```

### 3.3 边界形状：外部输入 DTO 与内部 authority-bearing envelope **分离**

```text
Untrusted Input
      ↓
Trusted Ingress
      ↓
Validation / Authentication
      ↓
Trusted Attribution Context
      ↓
Domain / Ledger Event
```

**设计要求**（本轮只冻结原则，不实现）：

```text
· 外部输入 DTO **不得**含有可直达 authority-bearing envelope 的同名字段
· trusted ingress 是**唯一**能把外部声明提升为 attribution 的地方
· ingress 要么拒绝、要么覆盖、要么使该字段不可传入 —— 三者必取其一，不得默认信任
```

> 与之呼应的是 §4：authority-bearing 的认知状态必须由写入侧**记录**，
> 而记录者只能是上面这张表里的合法构造者。

---

## 4. Axis B 必须真正持久化（请求 §10）

既然常规读路径**不得**从 `actor_type` 重新推导认知资格，
那么新事件必须**持久化当时真实确定的 Axis B**。原则：

```text
WRITE : record what was actually established
READ  : read what was recorded
NEVER : reconstruct authoritative epistemic state from actor_type
```

因此 Proposed Schema 必须明确设计（或仓库中语义完全等价的结构化字段）：

```text
source_kind
source_authority
epistemic_source
```

### 4.1 旧历史行的 Axis B：**已冻结的精确表示**（Rev 2.1 · F3）

> Rev 2 在这里写的是 `epistemic_source = legacy / unknown-equivalent` ——
> **那是描述性占位，不是 schema contract**。评审要求在设计冻结前回答"到底存什么"。
> 以下是冻结答案：

```text
source_kind       = legacy classifier 的输出（既有 4 值之一）      ← D 确定，非占位
                    （由 sourceKindForActor 这个 legacy classifier 给出，U-08）
source_authority  = 'UNCONFIRMED_ORIGIN'                          ← U-09 已裁定
epistemic_source  = 'UNCONFIRMED_ORIGIN'                          ← **新增受控值**
```

**新增 `EpistemicSource` 取值 `UNCONFIRMED_ORIGIN`**（采纳评审候选 A）：

```text
· `EpistemicSource` 既有 4 值（user_report / character_generation /
  system_instruction / tool_observation）**不改名、不改语义**
· 新值语义 = "这条内容的来源类别**未被确立**"
· 它与 `SourceAuthority.UNCONFIRMED_ORIGIN` **成对出现**（同一行的两条轴同时拒绝抬升）
```

**Axis B 没有 `Absent` 态**（这条必须写死，否则 NULL 语义会与三态纪律冲突）：

```text
每个事件都有其认知类别 ⇒ Axis B 三列在 MIGRATED_LEGACY 行上都是**具体受控值**，
**不使用 NULL 语义**（因此不需要第二个 `unknown_reason` 来表达"未知"）。
```

**写入期不变量**（Rev 2.1 明确其适用范围）：

```text
对 RECORDED 行（来源已确立）：
    epistemic_source === epistemicSourceForKind(source_kind)        ← 必须成立

对 MIGRATED_LEGACY 行（来源未确立）：
    该等式**刻意不成立** —— epistemic_source = UNCONFIRMED_ORIGIN
    ⚠️ 不得声称它是 SourceKind 的推导结果
       （那等于把"未确立"又变成"确定"，正是 D01 的形状）
```

> **如实记录一处既有断言的范围收窄**：原设计写着
> "两者都由 `SourceKind` 推导，因此不会出现自相矛盾的组合"。
> Rev 2.1 之后，该性质是**写入期**对"来源已确立"行的性质，
> **不再是**关于所有行的普遍真理。这是解耦归因与认知资格的必然代价，
> 不是回退。

但**不得伪造** `USER_EXPLICIT`。

**U-09 已裁定**：新增 `SourceAuthority.UNCONFIRMED_ORIGIN`（或仓库命名规范下的等价名）。
它必须：

```text
· **不在** EXTERNAL_FACT_AUTHORITIES 白名单内
· fail-closed
· 可查询、可审计
```

其对**已落库 `MemoryAuthority`** 的影响 → **MOVED TO ADR-043**（不在本 ADR 裁决）。

**Persistence 与 UnknownReason 的分工**（不可互相替代）：

```text
attribution_origin   : 整条 attribution 是怎么来的（RECORDED | MIGRATED_LEGACY）
unknown_reason       : **某个槽位**为什么不知道（LEGACY_UNRECORDED | RUNTIME_UNRESOLVED）
```

---

## 5. 专论：一个事件是否**真的需要**同时填写所有 attribution 字段？

**不需要。而且"为了字段完整而填满"是本次设计要明确禁止的行为。**

### 5.1 判据：物理必要性原则

> **一个归因槽位是必需的，当且仅当该事件自身的结论集会因为该槽位而改变。**
> 否则该槽位必须是 `Absent`。

| 事件 | `executor` 必需吗 | 为什么 |
|---|---|---|
| 用户说"我今天很累" | **不**（`Absent`） | 没有东西"被执行"。填 `executor=USER` 是**伪造**——它暗示存在一次执行 |
| 她生成一句回复 | **不**（`Absent`） | 同上；`actor=CHARACTER` 已足够 |
| 工具返回"20°C" | **是** | 存在一个外部执行者；不填就无法区分"她说的"与"工具观测到的" |
| 沙箱写文件成功 | **是** | Execution Truth 明确要求 Agent 与 executor 可分离 |

| 事件 | `authority` 必需吗 | 为什么 |
|---|---|---|
| 任何 `user_message` | **不**（`Absent`） | 说话不需要许可。填 `authority=…` 会暗示"这句话被授权过" |
| `ACTION_REQUESTED` | **不**（`Absent`） | **请求发生 ≠ 请求已获授权**（B5.1 修正） |
| `ACTION_AUTHORIZED` | **是** | 授权这一事实本身就是该事件的结论集 |
| 有副作用的执行事件 | **是** | 没有 authority 就不该有副作用（Execution Truth） |
| 只读诊断命令 | **不**（`Absent`） | 它不改任何东西，没有需要被授权的东西 |

### 5.2 三种"空"必须互相区分（本设计的核心纪律之一）

```text
Absent
  —— 该槽位**对本事件不适用**（物理上不存在这个概念）
     语义："没有执行者，因为没有任何东西被执行"

Unknown(LEGACY_UNRECORDED)
  —— 该槽位**语义上必需**，但**历史上没记**（不可确定）
     语义："这里本该有一个执行者，但我们不知道是谁"

Unknown(RUNTIME_UNRESOLVED)
  —— 该槽位语义必需，但**当前也没能确定**（例如 tool 未自报身份）
     语义："现在这次就是不知道"        ← U-04 已裁定：允许
```

**禁止**把这三者中的任何一个渲染成具体值。**"空"本身就是信息。**
**禁止**把 `Unknown` 表达为 `PrincipalKind` 的某个取值（B4）。

### 5.3 为什么"填满"是有害的（不只是没用）

```text
① 它把缺席变成断言：executor=USER 让"没有执行者"这件事不可见
② 它让"未知"不可检测：满格的行与真正确定的行长得一模一样，
   于是审计无法发现"这段历史其实是不知道的"
③ 它会污染 fail-closed 白名单：一旦某个必需槽位被默认填成合法值，
   canSupportExternalFact 之类的判定就再也拦不住它
④ 它是 append-only 的：账本写错了无法回收（本仓库真实事故的教训）
```

### 5.4 落地形式：必要性矩阵 + **反向**断言

必要性由矩阵声明（哪个事件族要求哪些槽位），并配一条反向负控：

```text
正控：必需槽位缺失 → 写入被拒
负控：**非必需槽位被填充 → 写入被拒**（或至少被判据报出）
```

第二条负控是本设计的要害。只测"该填的填了"拦不住"不该填的也填了"，
而后者正是"为了字段完整制造虚假语义"的定义。

---

## 6. Consequences

### 6.1 正面

```text
· Fact Firewall 的输入从"一个粗粒度 actor_type"升级为"足够确立的 contentOriginator"，
  于是"别人替我发的话"不再自动获得用户陈述的资格
· "未知"变成一等可观测状态（且**不再伪装成主体种类**），而不是被推导成确定值
· 归因只能由 trusted 构造者写入 ⇒ 外部调用方无法自报 authority
· Execution Truth / Audit 从"只有 character_id"升级为可回答
  谁发起 / 谁决定 / 谁执行 / 凭什么
· Query / Trace / Observability / Console 有**同一套**归因口径可依
· 与既有 SourceKind / SourceAuthority / EpistemicSource **同构**，不是第二套体系
```

### 6.2 负面 / 代价（必须如实计入）

```text
· 历史 user 事件的认知资格会被**降级**（D3 的推论）：
  那批记忆会从"用户明确陈述"变成"来源不确定"。
  **这是纠正，不是回归**，但它会改变既有记忆的可召回性/可采信度。
  ⚠️ 其对已落库 MemoryAuthority 的处理**不在本 ADR**（MOVED TO ADR-043）
· ~~写入路径从"actor_type 为输入"反转为"槽位为输入"（D8）~~ ——
  **Rev 2.1 已删除该反转**（见 D8.1）。改为：actor_type 与 attribution **并存、不要求相等**，
  因此不再存在"写入路径真相来源被换掉"这一最高风险项；
  但落地仍会触碰**冻结区** src/kernel/app/memory/**（AGENTS §3）
· Axis B 必须新增持久化列（§4），列宽显著增加
· trusted ingress 成为**单点**：它的实现质量决定全部 attribution 的可信度
· 增加一层概念，**可能被误用成"所有事件都要填满"** —— 故 §5 必须与 D4 一起裁定
· Unknown 会让一批既有审计查询返回"不确定"，
  下游（如果有报表/断言依赖"总是有值"）会暴露出来
```

### 6.3 不做会怎样（维持现状的代价）

```text
· 任何"以用户身份提交"的路径都自动获得 USER_EXPLICIT —— 包括 agent 替发、
  导入、回填、测试夹具、未来任何外部工具
· 一旦系统开始真的做事（Lv3–Lv4 / 多主体），审计语义会迅速含混且**不可回溯修正**
  （append-only）
· 未知被静默地推导成确定值 ⇒ "这段历史不知道"永远不可观测
```

---

## 7. 与既有不变量的关系

```text
① Assistant Fact Firewall —— 本 ADR **加强**它（把唯一的输入从粗粒度字段
   换成足够确立的来源），不改变它的方向与白名单形状
② 投影是派生的 —— 本 ADR 要求 attribution 属于事件本体，replay 原样重现；
   并新增一条：投影**不得**做归因判断
③ 副作用 ⇒ 目标确定性 + 账本 + traceId —— 本 ADR **补全**"账本"这一半：
   账本不只要存在，还要能回答"是谁的"
```

**本 ADR 不改变**：Memory Kernel 语义、Memory Lifecycle、D-9、召回策略、
观测分类法、控制面白名单。凡涉及这些的改动都超出 M5.1.1 的范围。

---

## 8. 阶段门：Phase 4 由 ADR-043 裁定（B7）

以下问题**不得**由 ADR-042 决定（它们属于 Cognitive Integrity /
Epistemic Requalification，而不是纯 Attribution Model）：

```text
· 旧 USER_EXPLICIT memory 如何处理
· 是否重算 MemoryAuthority
· 是否降低 Recall / Trust
· 如何保留历史认知但纠正当前资格
```

因此：

```text
Phase 1–3   可由 ADR-042 管理
Phase 4     **BLOCKED BY ADR-043**
```

新增 [`ADR-043 Legacy Cognitive Provenance & Epistemic Requalification`](../m5.1.1/M5.1.1-ADR-043-Epistemic-Requalification-Draft.md)
（本轮只允许 **DRAFT / PROBLEM STATEMENT**，不得实现）。

---

## 9. 本轮**没有**做什么（边界声明）

```text
✗ 没有改任何 schema / migration / 契约 / 生产代码
✗ 没有动 M5.1 的实现、验收结论、artifacts 或标签（M5.1 已冻结）
✗ 没有关闭 M5.1-D01（它保持 **P1 · OPEN**，直到 M5.1.1 实现并验收）
✗ 没有为认知资格的降级影响做任何数据操作
✗ 没有实现 Cognitive Integrity、Control Ledger、或外部 audit service
✗ 没有重新调查 D01 的历史事实（已冻结）
```

**下一步**：Design Freeze Review。审查通过后，本 ADR 移入 `docs/adr/ADR-042-*.md`
并进入 M5.1.1 Master Plan；审查不通过则在本文档内改判，**不另起**一份 ADR。

---

## 10. Revision 2 变更记录

| # | Blocker | 变更 |
|---|---|---|
| B1 | `actor_type` 不得直接迁移为新的 `actor` | D8 重写：`actor_type` 定位为 *legacy presented / message role*；删除"`actor_type→actor`"通用回填；`conversation_events.actor` 默认 `Unknown(LEGACY_UNRECORDED)`；`character_action_events` 改为**逐 event family/type** 判定 |
| **B2** | `sourceAuthor` 语义过窄 | 全库更名为 **`contentOriginator`**（语义来源，非键盘操作者）；保留 Draft-v1 名称对照；补齐三个标准示例 |
| **B3** | 缺少构造/证明边界 | **新增 §3 Attribution Construction & Attestation Boundary**：构造者表 + 核心不变量 + 输入 DTO / authority-bearing envelope 分离 |
| **B4** | `UNKNOWN` 混入 `PrincipalKind` | `PrincipalKind` 收敛为 6 值；未知改为 `AttributionValue` 的 `Unknown<UnknownReason>`；`UnknownReason = LEGACY_UNRECORDED \| RUNTIME_UNRESOLVED` |
| **B5** | `AuthorityKind` 含 `DEVELOPER_SURFACE` | 删除；新 `AuthorityKind = POLICY \| CAPABILITY \| SYSTEM_RULE \| USER_CONSENT \| BREAK_GLASS`；未知走 `UnknownReason`；Developer Control 示例按正确模型重写 |
| **B5.1** | `ACTION_REQUESTED` 要求 authority | 改为 `ACTION_REQUESTED → authority = ABSENT`；`ACTION_AUTHORIZED` / 副作用执行 → `REQUIRED`。**已核实 `ACTION_AUTHORIZED` 已存在，无需新增生产事件** |
| **B6** | Gate 用值相等作判据 | 改为"无证据推导"与"字段值与权威证据冲突"；记录合法反例（`subject=initiator=actor=CHARACTER` 必须通过） |
| **B7** | Memory 重新资格化混在 ADR-042 | 移出至 **ADR-043**；新增阶段门：Phase 1–3 由 ADR-042，**Phase 4 BLOCKED BY ADR-043** |
| §10 | Axis B 未持久化 | **新增 §4**：WRITE/READ/NEVER 原则 + `source_kind` / `source_authority` / `epistemic_source` 落库要求 + 旧行 `UNCONFIRMED_ORIGIN`（U-09） |

---

## 11. Revision 2.1 变更记录（Design Freeze Review 的收口）

```text
评审结论：ADR-042 Core Architecture = PASS；B1–B7 = SUBSTANTIALLY RESOLVED
          正式 Design Freeze = NOT YET；状态 = REVISION 2.1 REQUIRED
本轮只做收口修正，**不重新设计**、不开第三轮。
```

| # | 评审问题 | 变更 |
|---|---|---|
| **F1** | `actor_type` 又被定义成可从新 attribution 派生，与"`user_message.actor = U`"自相矛盾 | **删除方向反转**（新增 D8.1）：`actor_type` = legacy presented / message role，由 **event family / message role** 决定，与 attribution **并存但不要求相等**。删除 `projectActorTypeFromSlots` 写入期断言、Phase 3 的"派生输出"、以及 `actorTypeFromPrincipalKind` 反向投影。一致性 Gate 改为检查 **event family → actor_type**。附 D01 反例（`actor_type='user'` 与 `actor=SERVICE` 同时为真） |
| **F2** | "S1–S6 attribution fingerprint 两两不同"仍是值级判据的场景级变体 | 删除该全排列互异要求，改为**按语义维度证明可区分**（见 Test-and-Gate-Plan §2.1）：S1/S2/S3 看 `initiator`；S4 看 `executor` 证据可独立于 `actor` 表达；S5 看**执行态**（attribution 可相同）；S6 看 **origin / unknown 态** |
| **F3** | 历史行 `epistemic_source = legacy / unknown-equivalent` 是描述性占位，不是 schema contract | **冻结为受控值**（§4）：`EpistemicSource` 新增 **`UNCONFIRMED_ORIGIN`**；旧行三列均为具体受控值、不用 NULL 语义；并明确 Axis B **没有 Absent 态** |
| **F4** | U-12 的"实现期待决"与退出条件的"全量回归零退化"不能同时悬空 | **冻结 compatibility rule**（Test-and-Gate-Plan §6 + Affected-Surface-Map §6）：历史 evidence **永久冻结**、旧 Gate **语义**永久冻结；允许为**纯 additive** 契约演化做**最小**测试源码兼容更新，但四条约束必须同时满足 |

**Rev 2.1 未改变**：`PrincipalKind` 6 值 · `AttributionValue` 三态 · `AuthorityKind` 5 值 ·
`contentOriginator` 命名 · Attestation Boundary · `ACTION_REQUESTED → ABSENT` ·
Phase 4 BLOCKED BY ADR-043。**这些是评审已批准的部分，一字未动。**
| — | 依赖锚点未落地到文字 | §1 补齐 5 个已核对的代码锚点（`conversation-event.ts:363`、`extractor.ts:149`/`:329`、`conversation-store.ts:79`、`source-authority.ts:64`/`:242`、`migrations.ts:266`），并标注 `kernel/app/memory/**` 属冻结区 |

---

## 12. POST-FREEZE FACTUAL ERRATUM — K-16（2026-09-18，**勘误，非修订**）

> **性质：事实勘误。** 本节**不**改变本 ADR 的状态（仍是 `ACCEPTED / DESIGN FROZEN`）、
> **不**升 Revision（仍是 Revision 2.1）、**不**改任何 Decision（D1–D12）、
> **不**改 §10 / §11 的变更历史。§1 ④（L67–69）**一字未改、原样保留**，本节只登记
> 其中一句与实测不符，并给出正确表述。
> 立据：M5.1.1 WP2.1 的 K-16 审计（`pnpm m5.1.1:k16:verify`）+ WP2.2 在 production copy 上的只读实测。

被更正的是 §1 ④ 落库侧的**第一句**（"conversation_events 无 `source_kind` /
`source_authority` / `epistemic_source` 列"）。

```text
① 列存在（v3 就有）
   src/infrastructure/persistence/migrations.ts:346-351（MIGRATION_0003，见 :275）
     alter table conversation_events add column if not exists source_kind text
   （同样两条建立 source_authority / epistemic_source；索引见 :357-358）

② 会写
   src/infrastructure/persistence/conversation-store.ts:264-278 的 INSERT
   显式写这三列（:268 列清单、:276 取值）

③ 有值（production copy v6，只读实测）
   conversation_events 28 行，三列非空 **24 行**；4 行为 0003 之前的旧行

④ 但这些值**不是独立的 provenance evidence**
   写入值来自 src/kernel/contracts/conversation-event.ts:277-284 的
   buildProvenance({ actorType, … }) —— **由 actor_type 推导出来的投影值**；
   读回侧（conversation-store.ts:79 → deriveSourceForLegacyRow，:335-346）同一规则

⇒ 正确表述：
  「Axis B **被持久化**，但持久化的是**由 `actor_type` 推导出来的投影值** ——
    它不携带 `actor_type` 之外的任何信息，因此**不构成独立的 provenance evidence**；
    0003 之前的旧行三列为 NULL，读回时按同一规则兜底推导。」

**不要过度更正**：§1 ④ 的后半句（"infrastructure/persistence/event-store.ts 也不写它们"）
**仍然成立** —— 该文件写的是 character_domain_events（event-store.ts:156），确实没有这三列。
错的只是把 event-store 的结论套到整张 conversation_events 上。
```

**与本 ADR 的关系：结论不变，而且更清楚。**

- §1 ③「Fact Firewall 的唯一输入是 `actorType`」—— **不变**，而且这正是缺陷所在。
- **§4「Axis B 必须真正持久化」（WRITE / READ / NEVER）—— 不变**：
  被更正的只是"**过去**有没有持久化"这个**历史事实**，不是"**应当**持久化"这条**要求**。
  今天库里的那三列装的是**推导值**，所以 §4 的 NEVER 原则依然成立 ——
  **不得**把由 `actor_type` 推导出的值当成 authoritative epistemic state。
- §1 ① ② ⑤ ⑥（写入侧 / 计算侧 / 读回侧 / 后果）—— 逐条**不变**。
- §4.1 旧历史行的 `UNCONFIRMED_ORIGIN` 表示 —— **不变**（那是"该怎么记"的规定，与本勘误无关）。

**本次勘误没有做的事**：不升 Revision · 不改 Design Freeze 状态 · 不改任何 Decision ·
不改 §10 / §11 变更历史 · 不改 D01 的状态（`../m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md`
保持 **P1 · OPEN**）。

---

## 13. POST-FREEZE SEMANTIC ADDENDUM — K-24 / R-21（2026-09-18，**窄幅补充**）

> **性质：窄幅语义补充。** 本节**不**重写 §4，也**不**改任何 Decision（D1–D12）、
> Revision 历史或 Design Freeze 状态。它只补一句 §4 里**隐含得过头**的话，
> 并给出两个分支的可执行判据。

```text
§4 的 WRITE 原则写的是 "record what was actually established"。
但本 ADR 通篇把 `attribution_origin = RECORDED` 读成了"认知来源已确立"，
于是 RECORDED 行**只剩一个可表达的形态**（confirmed），
而真实世界还有另一形态："归因在事件当时被记录下来了，但**认知资格尚未确立**"
（例：agent 以 user 身份提交 ⇒ contentOriginator = Known(SERVICE/…)）。

K-24：RECORDED Unconfirmed Axis-B Representability Gap
R-21：RECORDED Axis-B Confirmation Semantics（本次冻结）
```

冻结语义（**两分支**）：

```text
RECORDED 的含义（**仅此**）：attribution was recorded at event time。
它 **不** 意味着 epistemic source 已确立。

confirmed   ：source_authority !== UNCONFIRMED_ORIGIN
              ⇒ epistemic_source === epistemicSourceForKind(source_kind)
unconfirmed ：source_authority = UNCONFIRMED_ORIGIN
              AND epistemic_source = UNCONFIRMED_ORIGIN      ← 必须**成对**
              （无外部事实资格）

必须拒的混合形态：
  · UNCONFIRMED source_authority + 非 UNCONFIRMED epistemic_source
  · 已确立 source_authority + UNCONFIRMED epistemic_source

事件族 → SourceKind（**族分类**，不是 PrincipalKind → SourceKind）：
  user_message → user_statement ／ assistant_message → character_output
  system_event → system_instruction ／ tool_event → tool_output
  ✗ SERVICE 不得自动意味着 system_instruction
  ✗ EXTERNAL_ACTOR 不得推出任何 SourceKind
  ✗ actor_type='user' 不得自动意味着 USER_EXPLICIT
```

**与 §4 的关系**：§4 的 NEVER 原则**加强**而非放松 —— unconfirmed 分支让
"记录下来了但来源未确立"变成**可表达**的状态，而不是被逼着填一个确定的 authority
（那正是 D01 的病根）。

**物理层不需要变更**（故不触发"v7 已冻结 ⇒ 要 v8"的 STOP）：
v7 对 Axis B 只有 5 条约束（4 条**词表** + `axis_b_complete`），
**没有** epistemic 等式 CHECK ⇒ unconfirmed 分支本来就写得进去（实测见
`artifacts/m5.1.1/wp3.2-recorded-axisb.json` 的 `schemaFeasibility`）。

**没有做的事**：不改 Fact Firewall / MemoryAuthority / extractor / Recall ·
不做 ADR-043 / Phase 4 · 不改 `MIGRATION_0007` · 不动真实库。
