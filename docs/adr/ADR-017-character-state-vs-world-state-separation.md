# ADR-017：Character State 与 World State 必须分开

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 39 – 42 / 97 节
- **代码**：`src/kernel/contracts/domain-event.ts`（`DOMAIN_EVENT_SCOPE` /
  `assertCharacterInternalScope`）、`src/kernel/policies/validator.ts`

---

## 背景

计划书第 40 节把三种事件的最终职责写得很清楚：

```text
ConversationEvent        谁说了什么
WorldEvent               世界真的发生了什么
CharacterDomainEvent     苏沐薇内部因此发生了什么变化
```

而第 39 节给出了 M3.5 的具体要求：

> M3.5 **不创建 WorldEvent 表**。
> 但必须写入 ADR：`CharacterDomainEvent` 未来永远不能承担 `WorldEvent` 职责。

为什么这条必须现在写：`character_domain_events` 会被 M4 的 Memory、
M9 的 Belief、M11 的 Reflection 反复读取。
一旦它里面混进了"世界事实"，那么"她以为门开了"与"门真的开了"
会在**最底层**变成同一行数据 —— 之后任何再精细的设计都救不回来。

---

## 决策

**引入 `DomainEventScope`，把"角色内部"变成可校验的常量；
M3.5 不建 WorldEvent 表。**

### 1. 形状

```ts
type DomainEventScope = 'CHARACTER_INTERNAL' | 'WORLD'
const DOMAIN_EVENT_SCOPE = 'CHARACTER_INTERNAL'
function assertCharacterInternalScope(scope: DomainEventScope): void   // ≠ 常量 → 拒绝
```

- `DomainEvent.scope?: typeof DOMAIN_EVENT_SCOPE`（字面量类型）
- `ProposedDomainEvent.scope?: DomainEventScope`（Processor 可声称）
- `AcceptedDomainEvent.scope: DomainEventScope`（放行口记录它放行了什么）
- 守卫插在 `policies/validator.ts` 的**唯一**受理点

声称 `scope: 'WORLD'` 的提案会被**整体拒绝**
（`domain_event_scope_not_character_internal`），而不是"这一条被拒、别的照写" ——
因为提案是一个整体工作单元（M2.5 的既有语义）。

### 2. 为什么 `'WORLD'` 登记但永不启用

登记它，是为了让"世界的那个东西"有一个明确的名字 ——
未来真的建 WorldEvent 时不必再发明一个词，也不必回来改这个枚举。

不启用它，是因为那条边界一旦模糊就再也收不回来（append-only）。

### 3. 为什么是**常量 + 校验**而不是一个数据库列

这是本 ADR 的核心决策，也是与 M3 的 provenance 做法**刻意不同**的地方。

M3 给 provenance 加列（`source_kind` / `source_authority` / `epistemic_source`）
的理由是（见 `conversation-event.ts` 文件头）：

> 一旦 provenance 是自由字典，就一定会出现"某个模块忘了写""某个模块写错了键名"。

**但那条理由在这里不成立**：这个值**恒为同一个常量**，不是数据。

| 方案 | 结果 |
|---|---|
| 加一个列 | 得到一个"永远同一个值、但理论上可以被写错"的列；每个写入点都可能写错它 |
| 常量 + 校验 | "写得出 `WORLD` 的地方在编译期与运行期都不存在" |

也就是说：**给常量建列是"把不可能写错的东西变成可能写错"**。
`scope` 的类型是字面量 `'CHARACTER_INTERNAL'`，因此
`const e: DomainEvent = { ..., scope: 'WORLD' }` 是一句**编译错误**。

运行期那道闸（Validator）守的是另一件事：**提案**里声称的 scope。
提案来自 Processor，而 Processor 的输出是不可信输入 —— 因此它必须被校验。

### 4. 违反 scope 的拒绝码

```text
domain_event_scope_not_character_internal
```

放在**最后一道**检查（类型、来源、幂等都已通过之后）：
这样一条同时"类型未登记 + 声称是 WORLD"的提案，
会先被告知"类型未登记" —— 那是更有信息量的那个错误。

---

## 被否决的备选方案

### 方案 A：加一个 `scope` 列

**否决理由**：见决策 3。另外它还会带来一个更隐蔽的问题：
列一旦存在，就会有人想"我们偶尔也写 WORLD 吧"，
而那一刻 Character State 与 World State 的边界就消失了。

### 方案 B：什么都不做，只写文档

**否决理由**：这条边界一旦被越过，修复成本是**历史数据不可逆**。
一个能被 CI 断言的常量比一段能被忽略的文字可靠。

### 方案 C：现在就建 WorldEvent 表（"反正迟早要建"）

**否决理由**：计划书第 39 / 41 / 66 节明确禁止。
而且一张空表会立刻产生"它该有什么列"的设计压力，
而那个设计的输入（世界的形状）今天还不存在。

### 方案 D：把 `scope` 做成 `string` 以便未来扩展

**否决理由**：与 ADR-014 方案 A 同一个理由。
开放成 `string` 之后，"某个模块声称自己是世界事件"就不再可能被拦住。

---

## 后果

### 正面

- "角色内部事件不得承担世界事实"从原则变成**编译期 + 运行期**的双重事实。
- 不新增列、不新增表、不新增服务。
- 未来建 WorldEvent 时名词已经在枚举里。

### 代价

- 「scope 为什么不建列」这件事必须解释清楚，否则后来者会觉得"漏了一个列"。
  缓解：本 ADR + `domain-event.ts` 的注释 + `compatibility-audit.md` 决策 D2。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| `assertCharacterInternalScope` 拒绝 `WORLD` | `m3.5:test` FC-T04 |
| `DomainEvent.scope` 的类型只允许 `CHARACTER_INTERNAL` | TypeScript（`pnpm typecheck`） |
| Validator 在放行口校验 scope | FC-T04 + `kernel:test` Validator 组 |
| 不存在 WorldEvent 表 / 服务 | FC-T04 符号守卫（`world_events`） |
| `character_domain_events` 仍只有角色内部事件 | `m3:verify`（既有 67 项全部通过） |
