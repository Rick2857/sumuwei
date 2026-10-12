# ADR-016：Intent 不等于世界结果

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 20 – 24 / 50 / 78 / 106 节
- **代码**：`src/kernel/contracts/intent.ts`（`IntentResolver` / `IntentResolution`）

---

## 背景

计划书第 24 节把这条说成"未来扩展最重要的原则之一"：

> 如果以后 Character 自己直接 `UPDATE world`，
> 那么：**角色想象什么，世界就发生什么。**
> 这会破坏：因果 / 规则 / 多角色冲突 / 权限 / 世界真实性。

而"她想开门"与"门被打开"在代码里被写成一句话，是最自然、
也最容易在某次"顺手简化"中发生的退化。

未来的形状必须是：

```text
Intent
   ↓
Environment Resolver        ← 由环境决定能不能
   ↓
Result（IntentResolution）
   ↓
Observation（结果以观测的形式回到她那里）
```

---

## 决策

**把 `Intent` 与 `Result` 在类型与端口层面彻底分开；
M3.5 只实现"对话"这一种 Resolver，不实现任何 Environment Resolver。**

### 1. 端口（计划书第 21 节）

```ts
interface IntentResolver {
  readonly name: string
  resolve(intent: CharacterIntent): Promise<IntentResolution>
}
```

M3.5 唯一的实现是 `ConversationIntentResolver`
（`SpeechIntent → 一条 assistant 事件`，计划书第 22 节）。

### 2. `IntentResolution`（计划书第 23 节）

```ts
interface IntentResolution {
  intentId: IntentId
  status: 'accepted' | 'rejected' | 'failed'
  resultRefs?: string[]      // 只有**引用**，不持有结果本身
  reason?: string
  resolvedAt: Timestamp
}
```

### 3. `rejected` 与 `failed` 必须分开

| 状态 | 含义 | 正确处理 |
|---|---|---|
| `rejected` | 环境**明确拒绝**（门锁着） | 正常结果 → 应当变成 Observation 回到她那里 |
| `failed` | 处理过程失败（IO / 网络） | 运维问题 → **不该**被写成"世界规律" |

混成"没成功"的后果很具体：她会把一次网络超时记成"世界不允许这件事"，
而那条结论会进 M9 的 Belief 并被 M11 的 Reflection 反复强化。

### 4. 一条刻意的不对称：Fast Path 落库失败仍然**抛出**

```text
落库失败（reply 目标悬空 / 序号跳号 / DB 报错）  → 抛出
路由不到处理器（非 SPEECH intent）               → rejected
```

理由："用户收到了回复但她的话没进账本"意味着**事实账本与用户实际经历分叉**，
而账本是 append-only 的，事后再补也补不回"当时"那个顺序。

`rejected` / `failed` 是留给**未来 Environment Resolver** 的 ——
它们描述"环境如何回应她的提议"，不是用来把 Fast Path 故障降级成"世界拒绝了"。

### 5. 结果回来时仍然是 Observation

```text
门打不开 → Observation("门打不开")
```

于是它自动继承 ADR-014 的语义：**观测不是事实**。
她可以据此认为"门锁着"，但那依然是她的认知，而不是世界真相（FC-06）。

### 6. 自动化守卫

`m3.5:test` FC-T04 同时做两件事：

1. 造一个 `ACTION`（`OPEN_DOOR`）intent，让 mock 环境返回 `rejected`，
   断言一个"世界哨兵"对象**零变化**
2. 静态扫描 `src/`：不得出现 `WorldStateRepository` / `SceneService` /
   `NPCService` / `SimulationScheduler` / `GameMaster` 等实现

第 2 条把计划书第 102 节的"失控停止条件"变成了自动化断言。

---

## 被否决的备选方案

### 方案 A：只写文档，不加类型

**否决理由**："Intent 与 Result 要分开"如果只是文档里的一句话，
它会在第一次需要"少写一个类"的时候被绕过。
`IntentResolver` 端口 + 三种结果状态是**结构性**的约束：
绕过它需要显式地新增一条世界写路径，而那在 review 里看得见。

### 方案 B：`status` 只有成功 / 失败两种

**否决理由**：见决策 3。`rejected` 与 `failed` 的区别是**语义**的，
不是分类癖。合并之后，"她意识到门锁着"与"她意识到网络断了"
在数据上完全一样 —— 而这两件事对她未来的行为应该产生完全不同的影响。

### 方案 C：现在实现一个最小的 Environment Resolver（"先跑起来"）

**否决理由**：计划书第 3 节明确禁止 `World Event Resolver` 与
`Autonomous Life`。而且一个"最小"的世界解析器必然要有一个"最小"的世界状态，
于是范围失控从那一刻开始（第 102 节列的四个禁止文件名会在几周内全部出现）。

### 方案 D：允许 Resolver 把结果对象直接塞进 `IntentResolution`

**否决理由**：结果应当是**去别处查**的，而不是 resolution 里的一份快照。
否则同一件事会有两个可能不一致的副本，而"哪个是权威"这个问题
会在第一次出现分歧时变成事故。

---

## 后果

### 正面

- "角色只能产生 Intent"从一句原则变成一条**结构性**事实。
- `rejected` / `failed` 的语义差异被保留，为 M9 的 Belief 留出了正确的输入。
- 自动化守卫让"顺手实现世界"在 CI 上直接失败。

### 代价

- Fast Path 多了一层（intent → resolver）。缓解：行为完全不变，
  由 M3 的全部测试 + prompt 基线守着。
- 出现一个"没有 Environment Resolver"的中间状态。
  缓解：这正是本阶段的定义（只建插座，不买电器）。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| `ACTION` intent 不会自动产生世界状态变更 | `m3.5:test` FC-T04 |
| `rejected` 不产生任何 `resultRefs` | FC-T04 |
| `src/` 内没有世界 / 场景 / NPC / 调度器实现 | FC-T04 符号守卫 |
| Intent id 与 result ref 是两件事 | FC-T08 |
| Fast Path 落库失败仍然抛出 | `m3:verify`（悬空 reply 被拒）+ `m3.5:verify` §6 |
| 对话 Resolver 是唯一实现 | `m3.5:test` FC-T03 |
