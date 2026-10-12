# ADR-008：用户 / 角色 / 系统 / 工具四种来源必须分离

- **状态**：已接受（M3）
- **日期**：2026-09-16
- **相关**：计划书第 10 / 11 / 26 / 27 / 83–85 节、ADR-009

---

## 背景

M2.5 的 `ConversationEvent` 已经有 `actorType: 'user' | 'character' | 'system'`，
并且有一道闸：`user_message` 的 actorType 必须是 `user`，
`assistant_message` 的必须是 `character`。这拦住了"她冒充用户说话"。

但它拦不住三件更细的事：

1. **没有 `tool`。** 未来接工具后，"工具返回 20°C"会被迫
   塞进 `system` 或 `user` —— 前者让它变成"系统说过"，
   后者更糟：变成"用户说过"。
2. **来源语义散在 `metadata` 里。** M2.5 把 `source` / `userId` /
   `traceId` / `modelProfile` 都塞进一个自由字典。
   自由字典一定会出现"某个模块忘了写""某个模块键名写错"，
   而 M4 的 Memory 会把这些半成品当成权威来源。
3. **没有区分"用户明确陈述"与"用户确认"。** 计划书第 33 节要求
   区分二者，因为它们的证据强度不同：前者是用户主动给出的事实，
   后者是用户对她某句话的确认 —— 权威来源是**第二条 User Event**，
   而不是第一条 Assistant Event。

---

## 决策

**事件携带四个结构化的来源字段，且由 `actorType` 唯一推导。**

```ts
interface ConversationEvent {
  actorType: 'user' | 'character' | 'system' | 'tool'
  sourceKind: 'user_statement' | 'character_output' | 'system_instruction' | 'tool_output'
  sourceAuthority: 'USER_EXPLICIT' | 'USER_REPLY_CONFIRMATION' | 'DIRECT_INTERACTION'
                 | 'TOOL_OBSERVATION' | 'CHARACTER_GENERATION' | 'SYSTEM_INSTRUCTION'
  epistemicSource: 'user_report' | 'character_generation' | 'system_instruction' | 'tool_observation'
  deliveryStatus?: 'generated' | 'delivered' | 'failed'
}
```

四条规则：

1. **`sourceKind` 由 `actorType` 唯一推导**，调用方可以声明，
   但声明与推导不一致时**抛错**（`source_kind_actor_mismatch`，失败关闭）。
   允许声明是为了让调用点把意图写出来，从而在 review 时一眼可见。

2. **`sourceAuthority` 是白名单。** 能支持外部事实的只有三种：
   `USER_EXPLICIT` / `USER_REPLY_CONFIRMATION` / `TOOL_OBSERVATION`。
   新增一种 authority 时它**默认不能**支持外部事实 ——
   于是"某个新模块悄悄获得制造事实的权力"不可能发生。

3. **`DIRECT_INTERACTION` 刻意不在白名单里。**
   它支持的是"这一轮真实发生过"（对 M7 Relationship / M8 Affect 有用），
   而不是"某个关于世界的事实为真"。把这两件事混起来，
   用户说一句"月球是奶酪做的"就会变成世界事实。

4. **`transport` 不参与人格逻辑。** 渠道（cli / qq / discord）只进
   `metadata.transport`，且**改名**（M2.5 叫 `metadata.source`）——
   因为 M3 起 `source` 这个词已经被 `sourceKind` 占用，
   一个词两种含义是来源审计里最容易出错的地方。

---

## 被否决的备选方案

### 方案 A：继续用 `metadata` 自由字典

**否决理由**：这是 M2.5 的现状。它已经产生了具体的坏味道：
一个键叫 `source`，值域是"cli / harness / qq"，而语义上
"来源"在 M3 指的是事实类别。继续加键只会让两件事继续混在一个字典里。

**列是契约，字典是愿望。** 写入时少一个键，SQL 不会报错；
少一列，SQL 会报错 —— 后者才是我想要的失败方式。

### 方案 B：不引入 `tool`，等真接工具时再加

**否决理由**（计划书第 11 节）：event 表是 **append-only**。
等接工具时再加 `tool` 枚举，那之前所有工具产出都已经写成了
`system` 或 `user`，而**改不回来** —— 只能靠"当时大概是工具"
这种推断，而推断出来的来源不能当证据。

代价现在为零（多一个枚举值），以后为零（不需要迁移），
而错过的代价是不可逆的。

### 方案 C：用语义分类（`fact` / `opinion` / `question`）代替来源分类

**否决理由**：语义分类需要理解内容，因此**必然**要调模型，
于是"分类"本身变成一个会出错、会漂移、要版本化的认知过程。
计划书第 27 节把这一点说得很清楚：

> 这是**事实类别**，不是语义类别。

来源分类只看"这条事件从哪条路径进来的"，是确定的、可判定的、
不需要模型的。M3 只需要这个。

---

## 后果

### 正面

- Assistant→Fact Contamination **可以证明为 0**，而不是"观察不到"：
  它是纯函数判定，不依赖模型行为（见 ADR-009）。
- 用户确认的权威提升由 reply graph 驱动，不做语义判断 ——
  因此它是确定的、可测试的。
- 迁移 0003 给旧行**推导**来源而不是留空：账本里不存在"来源未知"的事件。

### 代价

- 事件表多了 5 列。对一个"每秒几条"的账本，这个代价可以忽略。
- 每次新增来源类别都要改契约与迁移。
  **这是刻意的**：来源类别是审计的坐标系，它不该经常变。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 四种 actor → 四种 sourceKind，一一对应 | `scripts/kernel-tests-conversation.ts` |
| 外部事实白名单恰为三种 | 同上（"白名单是封闭的"） |
| 用户确认由 reply graph 提升 | 同上 + `scripts/verify-m3-persistence.ts` T6 |
| 工具返回是 tool_observation | 同上 T8 |
| 系统指令是 system_instruction | 同上 T7 |
| 旧行来源被推导而不是留空 | 同上（`deriveSourceForLegacyRow`） |
