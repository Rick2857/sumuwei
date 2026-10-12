# Invariants —— 不许破的规则

**这份文件是宪法。** 任何后续改动若与它冲突，必须先改这份文件并写 ADR，
而不是悄悄绕过。

每条都标注了**由哪个测试守着**。没有测试守着的规则只是愿望；
这份表格的作用就是让"规则"和"能被机器发现"之间不留空隙。

> M3 追加了第 13–20 条（身份与完整性）。M2.5 的 1–12 条**一个字都没改** ——
> M3 是在它们之上加约束，不是替换它们。
>
> M3.5 追加了第 21–27 条（未来兼容性）。前二十条**一个字都没改** ——
> M3.5 只在外围增加"未来的接口空间"约束，一个现有行为都没有改（prompt 逐字节不变）。

---

## 1. Character ≠ Model

苏沐薇的状态由 Character Kernel 拥有，不由任何模型调用拥有。
换模型、换 prompt、换提供商，都只是改变"她如何表达"，不改变"她是谁、她经历了什么"。

**守着它的测试**：`kernel:test` → 依赖方向检查（领域层不许 import 模型 SDK）；
`eval:scenarios` SC-002（换 prompt 不改变事实账本的内容）。

## 2. Seed ≠ Memory

Seed Identity（她出生时是什么样）是**起点**，不是记忆。
它独立存储、有版本、有固定的 Context 位置，且**不会被任何自动流程改写**。

- 内容变了但 `seedVersion` 没升 → 直接拒绝写入。
- 版本回退 → 直接拒绝写入。

**守着它的测试**：`kernel:verify` → 「内容变了但版本没变 → 被拒」「版本回退 → 被拒」；
`eval:scenarios` SC-001 → 「Seed 文本逐字节不变」「重启后 Seed 指纹不变」。

## 3. ConversationEvent ≠ DomainEvent

前者是"**发生了什么**"（事实账本，append-only）；
后者是"**她因此如何变化**"（可解释的变化历史）。

两者可以底层共库，但 Domain Model 必须分清 —— 把它们塞进同一张语义不清的表，
是长期角色系统最早出问题的地方。

**守着它的测试**：`kernel:test` → 「来源一致性：type 与 actorType 必须匹配」；
`eval:scenarios` SC-003 → 「同一轮的用户事件与助手事件必须相邻」。

## 4. Proposal ≠ Fact

提案是"某个 Processor 建议系统这么理解"，不是事实，也不是状态。
只有经过 Validator 接受，变成 Domain Event，才产生长期效果。

**守着它的测试**：`kernel:test` → `Validator（失败关闭）` 全部 6 条。

## 5. LLM 不能直接改写 canonical state

模型只能"提出解释"（返回文本或结构化提案）。状态变化必须走
`Proposal → Validator → DomainEvent → Reducer → Projection`。

M2.5 里没有任何一条从模型输出直接写状态的路径；
`setStateVariable()` 这类直写函数只留给 Inspector 与验收脚本，主链路不使用。

**守着它的测试**：`kernel:test` → 依赖方向检查 + Validator 的存在性/归属检查；
`eval:scenarios` SC-002。

## 6. **Assistant 的输出不会自动变成外部事实**

这是长期角色系统最典型的灾难：
她随口生成"我小时候其实很喜欢下雨" → 被总结成事实 → 被当真实记忆召回 →
几十轮后她**自己编出整个人生**，而系统每一句都当成真的。

因此在**最底层**就规定：只有 `actorType === 'user'` 的事件可以充当外部事实证据；
她自己的话最多构成 `self-expression evidence` 或 `inference`。

**守着它的测试**：`kernel:test` → 「只有 user 事件能作为外部事实证据」；
`kernel:test:conversation` → T4/T5 + 「外部事实白名单恰为三种」；
`eval:scenarios` SC-002 → 四条断言（含"仅凭 assistant 事件不产生任何领域事件"）；
`eval:m3` → `assistant-fabrication` 套件（硬零指标）。

## 7. Projection 必须可重放

数据库里的 `trust=0.63` **不是真相**，它只是"到目前为止所有 Domain Event
折叠出来的结果"。删掉它、重放事件，必须得到同一个值。

**守着它的测试**：`eval:scenarios` SC-005 → 「rebuild 后 state 与 revision 一致」
「连续三次 rebuild 结果稳定」「消费的事件数 = 领域事件总数」；
`kernel:test` → Replay 等价性。

## 8. Reducer 必须确定性

`state + event → new state`，纯函数。
禁止：调用 LLM、网络请求、读当前时间、随机数、写数据库、发消息。

**守着它的测试**：`kernel:test` → 「同一输入两次折叠结果相同且不改原状态」；
SC-005 的「连续 rebuild 稳定」（副作用会让第二次结果不同）。

## 9. Processor 的输出必须版本化

任何自动生成的认知数据都要带 `processor` / `processorVersion` / `schemaVersion`
（涉及模型时再加 `modelProfile`），且版本**独立于应用版本**
（`memory-extractor@1`，不是 `project-v0.2.4`）。

版本进幂等键，因此改了 Prompt 或算法就是一次新的处理，旧的幂等记录不会拦住它。

**守着它的测试**：`kernel:test` → 「幂等键稳定可复算」；
`eval:scenarios` SC-004 → 「processorVersion 没有进幂等键 → 必须失败」。

## 10. 副作用必须幂等

同一个输入处理两遍，Domain Event 数量与 Projection 变化只能发生一次。
三层同时成立：事实层（会话内序号）、提案层（幂等键）、投影层（重复事件不重复折叠）。

Processor **自己**先自查幂等再提案；Validator 的 `duplicate_operation` 是并发兜底。

**守着它的测试**：`kernel:verify` → 「第二次全部幂等命中」「计数器没有变成 2」；
`eval:scenarios` SC-004 → 五条断言；`m3:verify` → 同坐标重复写是幂等命中。

## 11. Context 必须经过 ContextCompiler

任何模块都不许 `systemPrompt += memory` 之后直接调模型。
每一次主角色调用都必须产出带 `compilerVersion` 与 section id 列表的 `ContextPacket`。

理由只有一个但足够：**以后必须知道"某轮回答究竟使用了哪些内容"**。

**守着它的测试**：`eval:scenarios` SC-006 → 「section id 必须在注册清单里」
「prompt 必须由 packet 组装」「每轮 trace 都能定位输入事件 / Context 版本 / 输出事件」；
跨场景不变量 → 「每轮上下文都必须含身份 section」。
M3 起还要求 `contextCompilerVersion === 'context-compiler@2'`（`eval:m3`）。

## 12. 遥测不能成为运行时依赖

`Telemetry unavailable ≠ Character unavailable`。
观测后端离线、超时、报错，都只允许出现在日志里，不允许出现在她的对话里，
也不允许污染 `character_traces.error`（那是 Slow Path 的位置）。

**守着它的测试**：`eval:scenarios` SC-007 → 六条断言；
`eval:telemetry` → 「面向不可达后端时没有任何异常逃逸」「Noop 与关闭态等价」；
`m3:phoenix` → 「Phoenix 不可达时整轮不抛异常」。

---

# M3 追加：身份与完整性

## 13. 身份必须分层，四者不可互换

```
CharacterIdentity    她是谁        —— 不随 Session / 登录 / 模型 / 重启变化
UserIdentity         用户是谁      —— 不随 Session / transport 变化
ConversationIdentity 这段对话      —— **可替换**
RuntimeIdentity      这次程序运行  —— 只用于 diagnostics / trace / deployment
```

`RuntimeId` 绝对不能作为 `CharacterId` 或 `UserId` —— 重启一次不该让她变成另一个人。

**守着它的测试**：`kernel:test:conversation` → 「不同会话的同一用户得到同一个 UserId」；
`m3:verify` → T1/T2（重启与会话切换后 CharacterId / UserId 不变）；
`eval:m3` → `session-restart` / `new-conversation` 套件。

## 14. transport 身份不是领域身份

`qq_id` / `discord_user_id` / `websocket_connection_id` 只进 transport metadata，
必须**显式**经过一次 `external_identity → UserId` 的解析。

**守着它的测试**：`kernel:test:conversation` → 「transport 身份只作为元数据保留」
「同一 (transport, externalId) 反复归一化得到同一个 UserId」；
`m3:verify` → 「不同 transport 的同名 id 是两个人」。

## 15. Seed 必须版本化，且改动必须留痕

任何 Seed 修改都必须同时产生 **(version, hash, history, provenance)** 四样东西。
库内容与记录指纹不一致时**读取即报警**（不只是写入时拦）。

**守着它的测试**：`m3:verify` → 「内容变了不升版本 → 被拒」「库被绕过写入闸改过 → 读取时发现」
「历史不覆盖旧版本」「无 author/reason 的变更被拒」；
`kernel:test:identity` → 「时间戳与 provenance 不进指纹」「数组顺序不影响指纹与渲染」；
`m3:seed-check` → PR 期的漂移检测。

## 16. 来源必须结构化，不能塞进自由字典

事件携带 `sourceKind` / `sourceAuthority` / `epistemicSource` 三个**列**，
且 `sourceKind` 由 `actorType` 唯一推导（声明不一致 → 抛错）。

**理由**：字典一定会出现"某个模块忘了写""某个模块键名写错"，
而 M4 的 Memory 会把这些半成品当成权威来源。**列是契约，字典是愿望。**

**守着它的测试**：`kernel:test:conversation` → 「来源类别与 actor 一一对应」
「声明与 actor 不符 → 拒绝」；`m3:verify` → T7/T8 落库后来源仍正确。

## 17. 权威等级是白名单

能支持外部事实的权威等级恰为三种
（`USER_EXPLICIT` / `USER_REPLY_CONFIRMATION` / `TOOL_OBSERVATION`）。
新增一种 authority 时它**默认不能**支持外部事实。

`DIRECT_INTERACTION` **不在**白名单里：它支持"这一轮真实发生过"，
不支持"某个关于世界的事实为真"。

**守着它的测试**：`kernel:test:conversation` → 「白名单是封闭的」
「DIRECT_INTERACTION 不在白名单里」。

## 18. 用户确认的权威由 reply graph 驱动，不做语义判断

```ts
resolveAuthority({ kind: 'user_statement', repliedToKind: 'character_output' })
// → 'USER_REPLY_CONFIRMATION'
```

因此 assistant 事件的 `replyToEventId` 是**必填**，
且 reply 目标必须存在、同角色、同会话、更早（四条校验，全部失败关闭）。

**守着它的测试**：`kernel:test:conversation` → reply graph 全组；
`m3:verify` → T6（提升）+ 「悬空 reply 目标被拒」。

## 19. 生成 ≠ 送达

`deliveryStatus` 默认 `generated`，不是 `delivered`。
写进账本**不等于**送到用户手里。

它是 `conversation_events` 上**唯一**允许 UPDATE 的一列，
且只改这一列 —— 正文、来源、序号、时间都不在那个 SQL 里出现。

**守着它的测试**：`m3:verify` → 「默认是 generated」「可更新为 delivered」
「更新投递状态没有改动正文」。

## 20. 评测必须能区分"她真的说话了"与"引擎在回显"

人格评测（PC / SA / Drift）只有在**角色真的调了模型**时才有意义。
离线档用合成串是可接受的（它测结构性事实），但那时人格检查必须
被**跳过**而不是被打分。

**守着它的测试**：`evals/m3/runtime/engine.ts` 的 `modelMode` 判定 +
`det({ echoAware: true })`；`scripts/diag-m3-coverage.ts` 让"哪一档覆盖了什么"可核对。

> 这条写进不变量是因为它**真的犯过**：第一版在任何模式下都不调模型，
> 于是 live 档拿合成串去打分，judge 给出 0.05 而报告里那个数字
> 看起来像一个真实结论。详见
> [`../evaluation/personality-drift.md`](../evaluation/personality-drift.md) 第 7 节。

---

# M3.5 追加：未来兼容性（FC-01 ~ FC-07）

> M3.5 的七条与前面二十条性质不同：它们守的不是"现在的行为"，
> 而是"**未来的接口空间**"。因此它们的"守着它的测试"大多是
> Schema / Contract 测试（`pnpm m3.5:test` 的 FC-T01 ~ T08），
> 而不是行为回归。
>
> 完整论述见 [`future-compatibility.md`](./future-compatibility.md)。

## 21. Kernel 的输入不得永久绑定 UserMessage（FC-01）

输入必须可以抽象为 `Observation`。任何非对话输入（世界事件、工具观测、场景变化）
都必须有一条**正规**入口，不得伪装成用户消息。

**理由**：伪装成 `user_message` 会同时污染事实账本（来源类别、权威等级、
reply graph 全错，且 append-only 改不回来）、人格评测与可解释性。

**守着它的测试**：`m3.5:test` → FC-T02（非对话观测可被 API 接收；
"渲染成用户文本"这条路失败关闭）；`m3.5:verify` → §6（端到端走新链路）。

## 22. Kernel 的输出不得永久绑定 string（FC-02）

输出必须可以抽象为 `CharacterIntent`；当前 Reply 只是其中一种 Intent（`SPEECH`）。

**理由**：否则未来第一个非语言行为会逼着 Runtime API 从 `Promise<string>`
变成 `Promise<Something>` —— 一个牵动装配层、评测装置与全部调用点的破坏性变更。

**守着它的测试**：`m3.5:test` → FC-T03（普通聊天的输出是
`CharacterOutput └─ SpeechIntent`，且行为与 M3 一致；不变量拦住非 SPEECH / 多条）。

## 23. Intent 与"事情真的发生"必须是两件事（FC-03 / FC-04）

```text
Intent  ≠  Result
```

`rejected`（环境明确拒绝）与 `failed`（处理过程失败）**必须分开**：
前者是正常结果、应当变成一条 Observation 回到她那里；
后者是运维问题、不该被写成"世界规律"。

**守着它的测试**：`m3.5:test` → FC-T04（`MockActionIntent` + mock 环境拒绝 →
世界哨兵零变化；`rejected` 不产生 `resultRefs`）；FC-T08（intent id 与 result ref 是两件事）。

## 24. CharacterDomainEvent 永远只描述角色内部的变化（FC-05）

它**不得**在未来同时承担"世界事实"的职责。

**落地点**：`assertCharacterInternalScope`（唯一受理点：`policies/validator.ts`），
声称 `scope: 'WORLD'` 的提案被整体拒绝。

**守着它的测试**：`m3.5:test` → FC-T04（scope 校验）；FC-T04 的符号守卫
（`src/` 内不得出现 `WorldStateRepository` / `SceneService` / `NPCService` /
`SimulationScheduler` / `GameMaster` / `world_events`）。

## 25. 状态模型不得把 user 写死为唯一目标实体（FC-06）

Relationship / Belief / Memory 必须以 `Entity` 为对象
（`owner → target`、`perspectiveOwnerId`），而不是 `userTrust` 这类形状。

**守着它的测试**：`m3.5:test` → FC-T01（第二个角色 + 同 id 不同 kind 可区分）、
FC-T05（两个角色可作为不同 `perspectiveOwner`）。

## 26. 真实世界事实与角色认知必须可以分别存在（FC-07）

`World truth` / `B knows` / `苏沐薇 doesn't know` 必须能同时成立。
并且 **Observation ≠ 事实**：记录的是"某人说了 X"，不是"X 为真"。

**守着它的测试**：`m3.5:test` → FC-T02（观测记录的是"某人说了这句话"）、
FC-T05（认知可属于不同角色）。

## 27. 现实时间 / 发生时间 / 模拟时间不得绑定为同一概念

```text
recordedAt（≡ createdAt） / occurredAt? / logicalTime?
```

`occurredAt` **不得**默认成 `recordedAt`（"不知道"≠"就是现在"）；
`logicalTime` 的位置必须留着，但 M3.5 **拒绝**写入非空值
（不建半个模拟时钟）。

**守着它的测试**：`m3.5:test` → FC-T06；`m3.5:verify` → §1（列存在、旧行未回填）、
§2（两个时间落库并原样读回、`logicalTime` 被拒）。

---

# M4.5 追加：行动真相与可观测性（INV-M45-01 ~ 06）

M4.5 第一次让系统真的动世界（沙箱文件），因此把 M4.1 的四条教训
提升为**所有未来行动能力**都必须服从的六条不变量。

| 编号 | 内容 | 守着它的测试 |
|---|---|---|
| INV-M45-01 | **Speech ≠ Action**：任何动作性自然语言声明必须绑定真实 `ActionResult` | `m4.5:test`「claim guard 五状态」；`m4.5:smoke:live` S9 |
| INV-M45-02 | **Intent ≠ Permission**：用户想做 / 模型认为该做 ≠ 系统允许执行，必须过 Policy Gate | `m4.5:test`「policy 全分支」；`m4.5:verify` 阴性控制 |
| INV-M45-03 | **Target Certainty precedes Side Effect**：目标 `weak`/`none` 时禁止副作用；"唯一候选"不是证据 | `m4.5:test`「目标梯子 第 3 步」；L4 S4 |
| INV-M45-04 | **Execution Truth precedes Response**：回复只能从 `ActionResult` 推导 | `m4.5:test` + L4 S6/S9 |
| INV-M45-05 | **Observable System Behaviour is the Acceptance Target**：验收对象是用户可见行为，不是 `return true` | `m4.5:smoke:live`（Level 1 + Level 2 证据） |
| INV-M45-06 | **Measurement Truth**：Hard Gate 必须同时证明测量范围与测量结果正确 | `m4.5:measurement:verify`（L0） |

对应的架构决策：ADR-030（唯一执行入口）、ADR-031（能力登记与内核边界）、
ADR-032（目标确定性）、ADR-033（执行真相）、ADR-034（账本与记忆分离）、
ADR-035（量具可信）。

补充边界（M4.5 冻结）：

```text
Action Result ≠ Memory        执行事实进 Execution Ledger，不自动成为记忆
Memory ≠ Belief ≠ World State M4.5 只留 World 接口，不实现预测/模拟
```

---

## 派生规则（后续阶段会用到，位置已预留）

| 规则 | 状态 | 预留位置 |
|---|---|---|
| 派生结论不得重复充当独立证据（防 Reflection 自我强化） | 字段已就位，逻辑 M11 | `DomainEvent.causedByDomainEventIds` |
| 记忆可以过期、被取代、被撤回 | 类型已定义，逻辑 M4 | `ProposalOperation` 的 supersede / retract / delete |
| 后台任务必须有顺序与水位 | 已实现 | `character_jobs` / `processor_watermarks` / 乐观锁 |
| 新增框架必须先说明它替代哪个接口、解决哪个实测问题 | 流程规则 | ADR-006 + `docs/adr/` |
| Memory Authority policy（什么等级能形成什么记忆） | **M3 只标记，M4 才定** | `sourceAuthority` 列 |

---

## 怎么用这份文件

- **改代码前**：看有没有触到上面任何一条。
- **review 时**：如果某个改动让某条规则变模糊了，要求先补测试。
- **加新能力时**（M4 起）：新规则追加到本文件，并在"守着它的测试"列填上真实存在的测试名。
  填不出来，说明这条规则实际上没人守。

---

# 追加：认知完整性与受控注入（INV-CI-01 ~ 05）

**2026-09-17 用户正式立案**。层级：**Sovereign Core Architecture Constraint**。
权威源：[`cognitive-integrity.md`](./cognitive-integrity.md)（含 22 节完整原则 + Hard Gate CI-1~10 + 负控）。
合规现状：[`../m5.1.1/M5.1.1-Cognitive-Integrity-Gap-Audit.md`](../m5.1.1/M5.1.1-Cognitive-Integrity-Gap-Audit.md)。

适用范围：**所有能够直接或间接改变苏沐薇长期记忆、事实认知、主体认知、关系认知、
世界状态判断及其他持久化认知状态的外部操作。**

## 核心原则

> **No Cognitive State Without Provenance.**
> 任何绕过正常对话、感知、推理或既定 Memory Lifecycle 的外部认知注入，
> 都应被视为**高风险操作**，而不是普通 CRUD。

## 五条冻结的不变量

| 编号 | 内容 | 守着它的测试 |
|---|---|---|
| INV-CI-01 | **No Cognitive State Without Provenance** | 🟡 **部分**：`memory-validator` 强制 `assertMemoryEvidence` / `assertMemoryAuthorityAllows`（`kernel:test`）。**但"provenance 存在 ≠ provenance 正确"** —— 见下 |
| INV-CI-02 | **External Access Does Not Imply Cognitive Authority** | ⚪ **空满足**：开发者平面今天只读（`m5.1:query:verify` / `m5.1:control:verify`），但"以用户身份提交"这条路径**确实**换来了认知权威 |
| INV-CI-03 | **Maintenance Must Never Masquerade as Experience** | 🔴 **暂无**（无标记载体，也无检测） |
| INV-CI-04 | **Cognitive Intervention Must Be Explicit, Warned, Authorized, Audited and Verifiable** | ⚪ **空满足**（注入面不存在）；CI-4 的正控/负控**均无** |
| INV-CI-05 | **Cognitive History May Be Corrected, But Must Not Be Falsified** | 🟡 **部分**：更正保留历史（`retract` 不物理覆盖）已有；但"回滚 = 还原备份"会**删除备份之后的事件** ⇒ 与 CI-8 真实冲突 |

## 三条必须记住的落地约束

```text
① CI-1 必须读作 "without **established** provenance"。
   D01 的实例：那条记忆有 provenance、有 authority、有证据根 —— 每一条检查都通过，
   而那个 provenance 说的**是错的事**。⇒ 存在性检查不够，必须是正确性检查。

② 空满足（CI-2 / CI-4 / CI-9）**今天不会失败，也不会阻止明天的第一行注入代码**。
   高风险期是**未来**，不是现在 ⇒ 唯一可检查的形式是 §19 的七个破坏性测试（CI-10），
   而它今天**一个都不存在**。

③ 顺序硬约束：**归因（M5.1-D01）必须先于任何注入入口落地**。
   在没有确立 attribution 的前提下开放"Add Memory"，等于把 D01 制度化。
```

## 架构决定（默认归类）

> 今后任何功能如果**能够改变苏沐薇长期认知**，则默认被归类为
> **`Privileged Cognitive Operation`**，必须经过 Cognitive Integrity 审查。
> 不得因为"只是开发者工具 / 只是数据库管理 / 只是导入数据 / 只是临时测试"而获得例外。

不得被以下组件绕过：Developer Console · CLI · Admin API · Plugin · MCP · Tool ·
Workflow · Database · 第三方记忆后端 · 观测后端（§20）。
**基础设施可以替换；认知完整性规则不能替换。**

---

# 追加：外部证据的边界（INV-M55-01 ~ 06）

**2026-09-20 随 M5.5（Web Search & External Evidence）落地**。
层级：**里程碑级约束**（不是 Sovereign Core 级）。
权威源：[`../adr/ADR-045-external-evidence-boundary.md`](../adr/ADR-045-external-evidence-boundary.md)（`D-1`…`D-18`，
`ACCEPTED / DESIGN FROZEN`）与 [`../adr/ADR-047-local-searxng-search-provider.md`](../adr/ADR-047-local-searxng-search-provider.md)（`D-31` provider）。
判定书：[`../m5.5/M5.5-Gate-Decision.md`](../m5.5/M5.5-Gate-Decision.md)；
已知局限：[`../m5.5/M5.5-Known-Limitations.md`](../m5.5/M5.5-Known-Limitations.md)。

适用范围：**一切"把系统外部的内容带进这一轮上下文"的行为**。
其中"外部"包括搜索引擎结果、未来的任何检索式外部输入。

## 核心原则

> **External Content Is Evidence, Not Cognition.**
> 外部内容可以进入**这一轮**的上下文，但它**不是**她的记忆、**不是**她的判断、
> 也**不是**一次成功口吻的理由 —— 除非有一条**程序生成**的证据链把它固定下来。

## 六条冻结的不变量

| 编号 | 内容 | 守着它的测试 |
|---|---|---|
| **INV-M55-01** | **外部证据是独立上下文来源，不经召回管线**（`D-1` / `D-18①`）：它没有资格层、没有排序、没有主体作用域的区别 —— 它回答的是"这一轮外面告诉了她什么"，不是"她想起了什么" | `m5.5:measurement:verify` §6（section 种类 `external-evidence` / 优先级 45 > 记忆 40 / 可裁）· `m5.5:verify` 正控（证据经 gateway 层进 prompt，`selected_count = 2`）· `m5:runtime:verify` 的**既有**断言（`selectMemoryContext` 恒填 `externalEvidence: []`，COMPAT-2） |
| **INV-M55-02** | **证据与 trace/账本之间只有一条通道 `toExternalEvidenceRef`**；**摘要正文永不落库、永不落 trace、永不进开发者面**（`D-8`） | `m5.5:measurement:verify` §12（引用字段**恰好七个**；四种非法引用被拒；`snippet`/`source_uri` 类键被拒）· `m5.5:verify` 的 `privacy`（`snippetSentinelInTrace = false` · `titleSentinelInTrace = false` · `snippetSentinelInLedger = false`）· `m5.5:e2e:verify` 场景 10 |
| **INV-M55-03** | **模型不决定执行**：只有**显式搜索词形**才触发一次出站；没有显式词形的那一轮，网络调用数为 **0**（`D-5` / `D-6`） | `m5.5:measurement:verify` §5（六类显式词形正控 + 闲聊/形近词负控 + 混合指令**本地优先**）· `m5.5:test`（请求校验三条正负两侧）· `m5.5:verify` 负控（普通聊天 provider 调用 = **0**） |
| **INV-M55-04** | **没成功就没成功口吻**：回复**五态**由程序确定性映射（查到并形成证据 / 无结果 / 超时 / 失败 / 未启用联网）；**来源列表由程序按"实际入模集合"追加**，不由模型生成（`D-9` / `D-17`） | `m5.5:measurement:verify` §11（五态句两两不同 · 22 条词表逐条正控无死词条 · 泛应声词与否定句不误伤 · 正文里所有 `[E<n>]` 被剥离）· `m5.5:verify` 的 `negative.shapes`（三态互不相同，都不给附录）· `m5.5:e2e:verify` 场景 1/3/4/8 · `m5.5:smoke:live`（**真实**一轮：来源附录 5 行真的到了用户眼前；真超时那一轮她自己如实承认） |
| **INV-M55-05** | `web.search` **恒登记**；`web:search` 权限与适配器**只在 flag on 时**授予 / 构造 ⇒ flag off 时**构造上**无法联网，而用户仍得到一条**可审计的** `permission_denied`（`D-12`） | `m5.5:measurement:verify` §5/§12（追加登记后 4 个能力、**默认集仍恰好 3 个**；装配层把"授予权限"与"构造适配器"绑在同一个 flag 上）· `m4.5:test` 的默认能力集回归锁 · `m5.5:verify` 负控（flag off ⇒ `rejected` + `permission_denied`，provider 调用 **0**）· `m5.5:e2e:verify` 场景 12 |
| **INV-M55-06** | **外部证据永不自动进长期记忆**（`D-7`）：它只活在当轮内存、当轮上下文与引用里 | `m5.5:measurement:verify` §11/§12（`D-7` 的契约面与静态面）· `m5.5:verify`（记忆侧逐项计数不变 + **内容快照哈希**不变 + `memory_records` 表摘要不变，并配"同一次搜索让动作表**确实变了**"的对照）· `m5.5:e2e:verify` 场景 6/7 |

## 三条必须记住的落地约束

```text
① "本地 provider" ≠ "不出站"。本机 SearXNG 会把 q 转发给冻结的三个上游引擎
   （duckduckgo / wikipedia / wikidata）。任何"零出站"的表述只成立于 **flag off**
   （那时没有适配器实例、构造上无法联网），不成立于 flag on。
   ⇒ WP9 的第一次真实出站前，门把这条**逐字打印**出来（frozenFacts.outboundScope）。

② 外部证据的"证据链"是**程序**的，不是模型的：来源列表由程序按实际入模集合追加（D-9），
   回复五态由程序映射（D-17）。任何"让她自己引用/自己说明来源"的做法都违反 INV-M55-04
   —— 因为模型漏引/错引/编造**无法被机器断言**。

③ 本组不变量**不**主张"她说的对"：有来源 ≠ 说法成立（ADR-045 D-10），
   v1 只有搜索结果级证据、不抓全文（V-5）。INV-M55-01…06 管的是
   **来源集合与执行证据一致**，不是 claim-level 蕴含验证。
```

## 与既有不变量组的关系

| 组 | 管什么 | 与 M5.5 的关系 |
|---|---|---|
| `INV-CI-01…05`（Sovereign Core） | 任何**能改变长期认知**的外部操作 | M5.5 **没有**新增认知入口：外部证据不进记忆（INV-M55-06），因此不触发 CI 组。⚠️ **顺序硬约束仍然有效**：归因（`M5.1-D01`）已 `CLOSED`，先于本注入面 |
| M4.5 的行动不变量（`INV-M45-01…06`） | 有副作用就必须有目标确定性 / 账本 / traceId；没成功就没成功口吻 | M5.5 **复用**它（`D-3`）：搜索是一次普通动作，没有第二条执行路径。INV-M55-04 是它在**措辞层**的延伸 |
| M5 的召回不变量 | 召回通道的资格、排序、主体作用域 | M5.5 刻意**不进**召回管线（INV-M55-01）：外部证据没有"这条是不是她的"这个问题 |
| M5.1 的权威边界（冻结计数） | 端点 8 / 观测阶段 12 / provenance 5 / 理由码 4 | M5.5 只**追加** 1 个 step kind + 1 行映射，四个计数一个未动（`D-15`） |


---

## INV-M55-03（修订 R1 · 2026-09-20 · [ADR-049](../adr/ADR-049-adaptive-search-verification.md)）

> **这一条是修订记录，不是新不变量。** `INV-M55-03` 的原文**一字未改**（见上面 M5.5 那一组），
> 本节只说明它**自 2026-09-20 起的适用范围**与新旧替代关系 —— 免得同一模式下
> 同时要求"无词形零调用"与"可自动查证"（计划 §4 逐字要求）。

| 项 | 内容 |
|---|---|
| 原不变量 | `INV-M55-03`：**模型不决定执行**；只有显式搜索词形才触发一次出站 |
| 修订后的适用范围 | **`CHARACTER_WEB_SEARCH_MODE=explicit`（缺省）**：与原文**完全一致** —— 无明确请求 ⇒ 零搜索调用。<br>**`auto_public`**：允许**模型提交结构化需求提案**，但**提案不是执行** —— 执行仍只由受信程序（Policy + 唯一 Gateway）放行，且每轮 ≤1 次判定调用 / ≤1 次 provider 调用。 |
| 没有被改动的骨架 | ① 模型**永远不能**自己触发动作（`turn-gateway.ts` 的动作入口只吃**用户**事件正文）；② 执行**唯一**经由 Policy/Gateway（ADR-030）；③ 无授权 / 禁止态 / 校验失败 ⇒ 不搜；④ 非法模式值 ⇒ 配置错误并禁止搜索（不静默降级） |
| 守着它的测试 | 修订前：`m5.5:measurement:verify`（§5 意图正负控）+ `m5.5:test`（§4/§6）<br>修订后：**新增** `m5.5.1:test`（`H1` 授权与唯一入口 / `H2` 有界执行）+ 旧门按 ADR-049 §6 的**兼容判据取代登记**（旧断言不删，新模式补等价断言与新增负控） |
| 谁批准的 | 用户 2026-09-20："我认为你的方案合理，执行"（ADR-049 §10） |

## INV-M55-03（修订 R2 · 2026-09-20 · ADR-049 §11）

用户在 WP3 开工前裁定：**需求判定对显式与自动两条路径都有否决权**。本节追加说明 R1 的适用范围，不改写其历史原文；冲突处以 [ADR-049 §11](../adr/ADR-049-adaptive-search-verification.md#11-r2-裁定--需求判定对显式与自动两条路径均有否决权) 为准。

- `explicit` 保留“无有效显式请求不搜”，**不再表示与旧 regex 直通行为完全一致**。两模式下的显式候选，以及 auto_public 的自动候选，出站前必须经过共同判定。
- 可以提前拒绝，不能提前放行。只有合法 `decision=search` 且程序授权、参数、归因与限额校验通过，才能形成请求并交给唯一 Policy/Gateway；模型结论不能自行授予显式权限或覆盖程序拒绝。
- 非 search、判定异常/超时或校验失败 ⇒ 该轮搜索调用 0；无显式回退或另一条路径补搜。实际 query 必须是同一当前事件中经过判定与校验的片段。
- 共同判定不改变总开关、dryRun、本地优先和每轮 ≤1 次判定调用 / ≤1 次 provider 调用，也不重释既有 initiator 槽位。
- **待实现的机器判据**：WP3 两路径适配器正负控；WP4 真实 TurnGateway/隔离库/provider 计数；量具主动注入显式直通旁路必须失败，恢复后通过。不得以当前 WP2 的部件 PASS 冒充该接线已完成。

这是程序消费判定结果的硬边界；语义识别仍按 ADR-049 §7 的冻结语料评测，不主张任意私人/否定表达都能被正确识别。

---

# 追加：真实数据库的单持有、快照与恢复（INV-DB-01 ~ 07）

**2026-09-21 随 INC-01（真实库不可恢复损坏）的防复发控制落地**。
层级：**里程碑级约束**（不是 Sovereign Core 级）。
权威源：[`../incidents/INC-01-Pglite-DataDir-Unrecoverable-Corruption.md`](../incidents/INC-01-Pglite-DataDir-Unrecoverable-Corruption.md)
（事故记录，含"不可恢复"的操作性定义）· [`../incidents/INC-01-Prevention-Execution-Plan.md`](../incidents/INC-01-Prevention-Execution-Plan.md)（8 个 WP）
· 验收：[`../incidents/INC-01-Prevention-Acceptance-Report.md`](../incidents/INC-01-Prevention-Acceptance-Report.md)（`pnpm inc-01:gates` = Hard Gates PASS 11/11）。

适用范围：**一切会打开、复制、快照或恢复 `data/pglite`（真实对话库）的行为** ——
包含聊天、只读 CLI、迁移、状态快照、只读验收脚本，以及未来的任何入口。
`data/` 被 gitignore ⇒ **`git diff`/`git status` 看不见它的改动**，"它没被动过"只能靠内容树摘要/mtime 证明。

## 核心原则

> **真实库是单持有的外部资源：打开它是一次有副作用的事，而不是一次读。**
> 因此"谁有权打开"必须与"这次打开有没有租约、有没有先做过验证快照、有没有真的关上"绑在一起；
> 任何一环不确定 ⇒ **失败关闭**（拒绝启动），绝不"试着打开看看"。

## 七条冻结的不变量

| 编号 | 内容 | 守着它的测试 |
|---|---|---|
| **INV-DB-01** | **真实库是跨进程单持有资源**：任何会打开它的入口，必须先取得按**规范化 dataDir** 派生的 Windows 独占租约（named pipe）。第二个进程拿不到就**立即失败** —— 不等待、不覆盖、不"试着打开看看"；租约由 OS 在进程终止时释放（强杀也不会留下永久阻塞的锁文件） | `pnpm exec tsx scripts/verify-inc-01-wp1.ts`（`wp1-lease.json`：第二进程 source-open=0 · 不同 dataDir 可并行持有 · 字段注入被拒 · `taskkill /F` 后无需删锁文件即可重取 · 坏管道名 ⇒ 失败关闭）· `inc-01:test` T5–T7 |
| **INV-DB-02** | **快照只允许来自静止源**：必须持有该 dataDir 的租约；复制前后**源摘要一致**；副本摘要**逐字等于**源。热复制（复制正在被写的数据目录）**不得**升级成"可恢复备份" | `verify-inc-01-wp2.ts`（`source_changed_during_copy` / `copy_digest_mismatch`）· `inc-01:measurement:verify` 步骤③ |
| **INV-DB-03** | **快照必须"复制 → 校验 → 健康 → 晋升"**：健康验证只对 **`%TEMP%` 一次性副本**做（跑 `select 1` / public 表数 / `character_schema_migrations` 版本连续 / close 后 `closed=true`）；**永不打开待保留的快照本体**（打开会改 `pg_control`/WAL）；manifest **最后**写，它是"已验证"的凭证 ⇒ 判定 verified 必须**目录 + manifest 都在** | `verify-inc-01-wp2.ts`（N3/N7：验证副本不可启动 ⇒ 不晋升）· WP4 门 B14 · `inc-01:measurement:verify` 步骤⑦ · `scripts/inc-01-real-db-drift.ts`（孤儿 manifest 不算 verified） |
| **INV-DB-04** | **最后一份健康快照单调保留**：新快照晋升完成之前**不删除**任何旧 verified snapshot；缺省保留最近 **3** 份（生产自动路径 **10** 份）；不足份数**不得**清理；删除目标必须 resolve 后位于 `data/snapshots/` 之内（禁止 glob / 环境变量 / 工作区根级递归删除） | `verify-inc-01-wp2.ts`（N5/N6：路径重叠与逃逸 ⇒ 拒绝且零删除）· `inc-01:test` T10 · ⚠️ **删除旧快照是独立授权动作**（计划 §6.10）；首次真实快照因此用 `--keep 30` 做到零删除 |
| **INV-DB-05** | **打开之前必须已有本进程的 pre-open token**：真实库的中央闸要求"**显式放行**（`PROJECT_LG_ALLOW_PRODUCTION_DB=1`）**且**本进程已走完**租约 + pre-open 验证快照**"。token 的**授予**只发生在唯一状态机内部（**没有导出**），中央闸只能**问**（`hasPreopenToken`）⇒ 只设环境变量**不再足以**打开真实库 | `verify-inc-01-wp4.ts`（`productionOpenDecision` 真值表 · K1/K2/K3 三段式 · C1/C2/C3/C5 静态核对）· `inc-01:test` T13–T16/T24 · `inc-01:measurement:verify` 步骤② |
| **INV-DB-06** | **收尾唯一，且"关闭是问出来的"**：`stop → close → closed check` 只有**一处**实现（`runtime-shutdown.ts`）；**只有 `closed === true` 才算关干净**（问不到就判未关闭，失败关闭）；只有关干净才做 post-close 快照；`cleanClose` 如实写进 owner record，"上一次未干净退出"作为**诊断事实**显示、**不得**据此单独断言它就是损坏原因 | `verify-inc-01-wp3.ts`（`wp3-close.json` 33 项：7 场景 + 5 故障注入 · 收尾永不抛 · 退出码判据一处）· WP4 门 B1/B8/B10/B11/B13/B16 · `inc-01:test` T11/T12 · 真实形状实测：`runtime.adapter.db` 是 drizzle 包装对象（无 `close`/`closed`）⇒ 必须走 `adapter.manager.getConnection()` |
| **INV-DB-07** | **恢复是原子切换，失败保留现场**：`copy(snapshot → staging)` → `rename(dataDir → quarantine)` → `rename(staging → dataDir)`；**绝不原地覆盖**；任何一步失败都**保留** quarantine 与 staging、**不说**"恢复成功"；`--from` **只接受 snapshot ID**（路径/`..` 在形状层被拒）；真实库上的 `--apply` 需要**逐字**授权串 `<snapshotId>@<解析后的 dataDir>`（布尔开关**不算**授权） | `verify-inc-01-wp5.ts`（`wp5-restore-drill.json` 20 项：dry-run 零写入 · 原子切换 · 恢复后副本核验 · 二次 rename 失败保留现场 · 授权 6 例对照 · 对真实库 apply 在写任何东西之前被拒）· `inc-01:test` T17–T20 |

## 三条必须记住的落地约束

```text
① "打开" ≠ "读"。PGlite 每次打开都会写 pg_control / WAL 与内部统计 —— 这正是 INC-01 的前提。
   因此只读 CLI、只读验收脚本、状态快照**全部**纳入 INV-DB-01/05；
   `docs/incidents/INC-01-Prevention-Acceptance-Report.md` §3 有实测：
   首次真实快照前后真实源摘要**逐字相同**（快照只读源，postmaster.pid 的 mtime 都没动）。

② 摘要判据不能写成"永远等于某个冻结常量"。真实库**会被合法打开**，摘要必然变；
   正确判据是"本门同轮前后逐字不变" + "漂移**有据**（≥1 份 verified 快照（目录+manifest 都在）+ ≥1 次 cleanClose）"。
   这条在 INC-01 里被更正过四次（WP2/WP4/WP5 + WP6），实现收敛在 `scripts/inc-01-real-db-drift.ts` 一处。
   ⚠️ 保留窗口有限（自动 10 / 手动 3）⇒ **快照不是历史归档**，"改动前那一份还在不在"只是诊断读数。

③ 本组**不**主张：已定位根因 · 任意断电/硬件损坏零丢失 · snapshot 等于异地备份或灾难恢复 ·
   `taskkill /F` 可被优雅关闭捕获 · 3 份本地快照能覆盖整盘损坏 · 未执行的真实 restore 已通过。
```

## 与既有不变量组的关系

| 组 | 管什么 | 与 INC-01 的关系 |
|---|---|---|
| `INV-CI-01…05`（Sovereign Core） | 任何**能改变长期认知**的外部操作 | INC-01 的防线**不新增**认知入口：它管的是"库能不能被安全地打开/备份/恢复"。但**顺序硬约束**同样适用：本组落地之前，任何注入面都不得先上 |
| `INV-M45-01…06`（行动真相） | 有副作用就必须有目标确定性 / 账本 / traceId；没成功就没成功口吻 | INV-DB-06/07 是它在**基础设施层**的同一句话：收尾失败不许有"关好了"的口吻，恢复失败不许有"恢复成功"的口吻 |
| M5.1 的权威边界（冻结计数） | 端点 8 / 观测阶段 12 / provenance 5 / 理由码 4 | INC-01 **一个计数都没动**：它只加了一组基础设施服务与四道门，未改 trace 形状、未加端点 |
| `INV-M55-01…06`（外部证据） | 外部内容进上下文的边界 | 无关（不同面）。两者共同的纪律是"**程序**生成证据，模型不决定执行/不自行断言" |

