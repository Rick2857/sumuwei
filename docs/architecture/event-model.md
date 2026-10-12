# Event 模型 —— 事实层与变化层

## 两层，不能合并

| | ConversationEvent | DomainEvent |
|---|---|---|
| 回答的问题 | **发生了什么** | **她因此如何变化** |
| 例子 | `USER_MESSAGE`「以后叫我 Alex」 | `MEMORY_CREATED` / `RELATIONSHIP_IMPACT` |
| 可改写吗 | **不可**（append-only） | 不可（变化历史同样只增） |
| 有来源吗 | 它**就是**来源 | 必须引用 `sourceConversationEventIds` |
| M2.5 的实现 | `conversation_events` 表 | `character_domain_events` 表 |

两者可以底层共库，但**Domain Model 必须分清**。把它们塞进同一张
"语义不清的 Event 表"是长期角色系统最早出问题的地方：
一旦分不清"用户说过"和"系统认为"，来源隔离（铁律 5/6）就无处落地。

---

## 为什么 ConversationEvent 必须 append-only

用户先说「我喜欢咖啡」，后说「我现在戒咖啡了」。

**错误做法**：把第一条改成"用户不喜欢咖啡"。
**正确做法**：新增第二条；"旧认识 → superseded"是 M4 Memory 的事。

理由不是洁癖，而是三条具体能力都依赖它：

| 能力 | 依赖什么 |
|---|---|
| 可追溯（"为什么她现在 trust=0.61"） | 那次对话**原样**还在 |
| 可重放（删掉投影重新算） | 折叠的输入没有变过 |
| 可解释的连续性（"她以前是这样，现在是那样"） | 两个时点的证据都保留着 |

实现上这条规则是**结构性的**：`conversation-store.ts` 里
**没有** update / delete 的导出。不是"我们约定不改"，是根本没有那个函数。

---

## 序号：为什么它值得单独设计

序号是后面一切的地基：

```
character_sequence
    ├─ Watermark          我处理到哪了
    ├─ 乱序 Worker 判定    这条是不是过时了
    ├─ Replay             按什么顺序折叠
    └─ Rollup             哪一段已经被压缩过
```

只要它出现重复或回退，"她的一段经历被覆盖"就是**静默**发生的，事后查不出来。

### 不用 `SELECT MAX(sequence) + 1`

无事务保护时并发写会撞号。正确做法是单条语句原子分配：

```sql
insert into character_sequence_counters (character_id, next_sequence)
values ($1, coalesce((select max(sequence) from conversation_events where character_id = $1), 0) + 1)
on conflict (character_id)
  do update set next_sequence = character_sequence_counters.next_sequence + 1
returning next_sequence
```

`coalesce(max(...))` 那一段是为了兼容"迁移前已有事件、计数器未初始化"的库。

**守着它的测试**：`eval:scenarios` SC-003 →
「30 次并发分配无重号、无空洞」「序号严格递增」「读回来的顺序稳定」。

### 一次交互为什么要预分配两个号

`recordUserMessage()` 一次性分配 `[n, n+1]`：用户事件用 `n`，助手事件用 `n+1`。

好处：两者**严格相邻**，于是"这一轮"在数据上是可界定的
（`assistant.sequence === user.sequence + 1`），
SC-003 的第二条断言检的就是这个。

若助手事件最终没产生（模型失败），那个号就空着——
**序号允许空洞**（它是坐标，不是计数器），这比"重排序号"安全得多。

---

## 来源：三个层次的可追溯

### 第一跳：DomainEvent → ConversationEvent

```json
{
  "type": "TEST_CHARACTER_SIGNAL",
  "sourceConversationEventIds": ["cev:char_sumuwei:dm-...:7"],
  "processor": "diagnostic-processor",
  "processorVersion": "diagnostic-processor@1",
  "idempotencyKey": "idem:4fcf62f69f591fd8"
}
```

于是永远能回答："**为什么她现在是这样？**" →
Domain Event #820 → Conversation Event #471 → 那次对话的原话。

反查入口：`domainEventsFromConversationEvent(db, eventId)`。

### 第二跳：DomainEvent → DomainEvent（M11 用）

`causedByDomainEventIds` 现在不产生数据，但**字段必须先存在**。

它是 M11 防"Reflection 自我强化"的基础：

```
模型误判「用户讨厌我」
   → Belief(confidence 0.61)
   → Reflection 读后产生「我意识到他一直不喜欢我」
   → 再存
   → 下次 Reflection 看到「多次证据证明他不喜欢我」
   → 但三次"证据"都源自同一个 event_123
```

有了派生链，判定就能从"有几条结论"变成"**有几份原始证据**"。
M2.5 不实现这个逻辑，但它保证 M11 不需要改表。

### 第三跳：Proposal 的原始语义产出

`DomainProposal.payload` 保留 Processor 的**原始建议**
（可以含 confidence、自然语言解释、LLM 原始结构化输出），
而 `targetEvents[].payload` 是要真正落库的部分。

于是"它当时凭什么这么建议"与"最后写进去了什么"是分开可见的。

---

## 幂等键：唯一计算处

```
character_id + processor + processor_version + source_event_range + operation_type
        ↓ FNV-1a 64 位
idem:4fcf62f69f591fd8
```

三个刻意的设计：

1. **唯一入口** `idempotencyKeyFor()`：Processor、Validator、测试全部走这里，
   因此"重试时算出的键和第一次不同"这种 bug 在结构上不可能发生。
2. **processor_version 进键**：改了 Prompt 或算法就是一次**新的**处理，
   旧的幂等记录不该拦住它（这正是"精确重处理 v2 产物"的前提）。
3. **operation_type 进键**：`create` 与 `supersede` 是两件事，
   否则"更新一条记忆"会被当成"已经建过了"。

### 顺便说明：为什么不用 crypto

它在这里只是"把长键压短"，不是安全用途；同步实现让 DomainEvent 的构造
保持纯函数（`kernel-tests` 因此可以离线、毫秒级跑完）。

---

## 三个层次的幂等（缺一不可）

| 层 | 机制 | 失败症状 |
|---|---|---|
| 事实层 | `(character_id, conversation_id, conversation_sequence)` 幂等探测 + 唯一约束 | 同一句话说两次，历史里出现两条 |
| 提案层 | 幂等键 + `processed_operations` 唯一索引 | 重跑生成第二份领域事件 |
| 投影层 | 只有**新建**的事件才折叠进投影 | 计数器 +1 变成 +2 |

**Processor 自己先自查**（写提案之前先问 `hasProcessed`），
Validator 的 `duplicate_operation` 是**并发兜底**。

这个顺序有实际区别：正常重跑应该是**安静的成功**，
而不是"依赖下游拦下来"——后者会让每次重试都在日志里留下一条拒绝记录，
真出问题时反而淹没在噪声里。

**守着它的测试**：`eval:scenarios` SC-004（五条断言）
+ `kernel:verify` 第 8 节。
