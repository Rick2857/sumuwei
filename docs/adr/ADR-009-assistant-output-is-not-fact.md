# ADR-009：她的输出不是外部事实

- **状态**：已接受（M3）
- **日期**：2026-09-16
- **相关**：计划书第 28–33 / 82 / 115 节、ADR-008

---

## 背景

这是长期角色系统最典型的灾难，也是 M3 存在的**主要理由**。
计划书第 0 节把它画成一条自我强化链：

```text
Assistant hallucination
        ↓
Memory extractor
        ↓
"长期事实"
        ↓
未来 Context
        ↓
模型更加相信
        ↓
再次写入
```

具体的触发方式极其平常：

```text
用户：你小时候喜欢什么？
苏沐薇：（模型生成）我小时候很喜欢下雨。
```

如果没有防火墙，M4 的 Memory Extractor 会把这句话抽成
`苏沐薇小时候喜欢下雨` 这个"事实"，写进长期记忆，
下一轮进上下文，几十轮之后她**自己编出整个人生**，
而系统每一句都当成真的。

M2.5 已经建了第一道闸（`actorType === 'user'` 才能充当外部事实证据），
但它只覆盖了"谁说的"，没覆盖"这句话有资格支持什么结论"。

---

## 决策

**任何 `assistant_message` 默认只具有 `character_generation` 权威，
永远不能自动升级成外部事实。**

三条具体规则：

### 1. 她的话首先只表示"她在那一刻说了这句话"

事件照样落库（这样"她说过什么"是可查的事实），
但它带的是：

```text
sourceKind        = character_output
sourceAuthority   = CHARACTER_GENERATION
epistemicSource   = character_generation
```

而 `canSupportExternalFact('CHARACTER_GENERATION') === false`。

### 2. 升级需要**另一条**证据，且必须是用户事件

```text
苏沐薇：你好像很喜欢猫。          ← assistant 事件，权威 = CHARACTER_GENERATION
用户：  对，我特别喜欢。          ← user 事件，权威 = USER_REPLY_CONFIRMATION
```

只有第二条才有资格在未来（M4）形成偏好记忆。
判定由 **reply graph** 驱动，不做语义判断：

```ts
resolveAuthority({ kind: 'user_statement', repliedToKind: 'character_output' })
// → 'USER_REPLY_CONFIRMATION'
```

这条设计的要点是：**权威来源是第二条 User Event，而不是第一条 Assistant Event**。
她说了什么不影响事实，用户确认了什么才影响。

### 3. 白名单而不是黑名单

能支持外部事实的权威等级是**枚举出来的三种**。
新增一种 authority 时它默认**不能**支持外部事实 ——
必须显式加进 `EXTERNAL_FACT_AUTHORITIES` 才获得这个能力。

这个方向的差别在出事故时很重要：黑名单的失效模式是"新东西默认有权"，
白名单的失效模式是"新东西默认没权"。后者只会让功能暂时不可用，
前者会让错误数据永久进账本。

---

## 被否决的备选方案

### 方案 A：让 M4 的 Memory Extractor 自己判断"这句话能不能信"

**否决理由**：那等于把防火墙建在"下游的语义判断"上。
而语义判断要调模型、会漂移、要版本化、会有假阳性与假阴性 ——
**每一次假阴性都是一条永久污染**（账本 append-only）。

M3 的选择是把判定变成**确定性事实**（来源标签），
于是 M4 只需要读一个布尔值，不需要理解任何内容。

计划书第 130 节反对提前引入 MemOS，理由与此同源：
> 我们反而可能让 Memory Framework 提前决定本项目信息语义。

### 方案 B：给她的话加一个 `confidence` 字段，低置信度的以后不用

**否决理由**：置信度是**模型自评**，而它恰好在她最自信地编造时最高。
"苏沐薇小时候喜欢下雨"这句话在模型眼里置信度极高（它就是那么生成的）。
用一个来自生成者的分数去判断生成内容是否可信，是循环论证。

### 方案 C：干脆不把她的话写进账本，只写用户的话

**否决理由**：那样就丢掉了"她说过什么"这个真实发生过的事实。
而它有两个真实用途：

1. **人格一致性的评测**需要知道她曾经怎么说话。
2. **用户确认**必须能引用她说的那句话（reply graph 的目标）。

正确的做法不是不记，而是**记下来但标清来源**。

---

## 后果

### 正面

- **Assistant→Fact Contamination Rate 可以为 0，并且是被证明的 0**，
  而不是"跑了一百次没看到" —— 它是纯函数判定。
- M4 的 Memory Extractor 面对的是带标签的输入，
  它只需要读 `sourceAuthority`，不需要做任何语义判断。
- 评测可以拿它做确定性断言（`M3_HARD_ZERO_METRICS`）。

### 代价

- 她自述的经历**永远不会**变成她的长期记忆。
  这是**故意的**：M3 没有真实历史证据，
  所以"她小时候喜欢下雨"只能是一次表达，不能是一段过去。
  若将来确实需要给角色一份背景史，正确做法是把它写进 Seed
  （那是设定，不是习得），而不是让它从模型输出里长出来。

- 用户确认的判定依赖 reply graph 的正确性。
  因此 M3 把 `replyToEventId` 对 assistant 事件变成**必填**，
  并对 reply 目标做四条校验（存在 / 同角色 / 同会话 / 更早）。
  这条依赖是刻意的：**宁可她偶尔"没被确认"，也不要错误确认。**

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 她的输出不能支持外部事实 | `scripts/kernel-tests-conversation.ts`（T4/T5） |
| 白名单恰为三种 | 同上（"白名单是封闭的"） |
| 用户确认由 reply graph 提升 | 同上 + `verify-m3-persistence.ts` T6 |
| 落库后来源仍是 `CHARACTER_GENERATION` | `verify-m3-persistence.ts` §4 |
| 悬空 reply 目标被拒绝 | 同上 + `kernel-tests-conversation.ts` |
| 评测里的硬零指标 | `evals/m3/thresholds.ts`（`M3_HARD_ZERO_METRICS`） |
