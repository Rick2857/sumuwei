# Context Compiler —— 唯一 Prompt 入口

## 为什么必须是唯一入口

只要存在一条 `systemPrompt += memory` 的旁路，Trace 立刻失去意义：
你会看到"这一轮用了 3 个 section"，而实际上模型还看到了别的 2000 字。

于是排查"她怎么会说这种话"时只能靠猜——而**猜不出原因**正是长期角色
Agent 最难调试的地方。

所以规则是结构性的：

> 任何模块都不许自己拼 prompt 然后调模型。所有主角色请求统一经过
> `CharacterContextCompiler`，且每次都必须产出带 `compilerVersion`
> 与 section id 列表的 `ContextPacket`。

**守着它的测试**：`eval:scenarios` SC-006 五条断言
（含"出现的 section id 必须在注册清单里"与"prompt 必须由 packet 组装"）。

---

## 数据形状

```ts
interface ContextSection {
  id: string                 // 稳定 id，例如 'seed-identity'
  kind: ContextSectionKind   // 受控枚举
  priority: number           // 0..100，越大越先保留
  content: string
  sourceRefs?: string[]      // ['cev:...', 'projection:character-state:v12']
  estimatedTokens?: number
  droppable?: boolean        // false = 硬保留
}

interface ContextPacket {
  compilerVersion, sections[], text,
  sourceConversationEventIds[], droppedSectionIds[],
  estimatedTokens, generatedAt
}
```

`droppedSectionIds` 是**可解释性的关键字段**：
以后回答"她当时是不是忘了某事"，看这里就知道是**被裁了**、
还是**根本没召回**。这两件事的修法完全不同。

---

## M2.5 的分区与优先级

| section id | priority | droppable | 来源 |
|---|---|---|---|
| `current-input` | 100 | **false** | 本轮输入 |
| `seed-identity` | 90 | **false** | CharacterDefinition |
| `critical-state` | 60 | true | M2 的 `renderStateBlock`（复用，不重写） |
| `recent-conversation` | 30 | true | 事实账本最近 N 条 |
| `memory` (M4) | 40 | true | 预留 |
| `rollup` (M5) | 20 | true | 预留 |
| `relationship` / `affect` / `belief` / `goals` / `adaptive-self` (M7–M11) | 44–55 | true | 预留 |

两个**永不裁剪**的 section 是有意的：宁可超预算，也不能让她
"忘了自己是谁"或"忘了用户在问什么"。

排序规则：`priority` 降序，**同优先级按 id 升序**。
第二关键字必须是确定的——用插入顺序会让不同 provider 的完成顺序
改变最终 prompt，从而让 Trace 失去复现能力。

---

## 当前的三段式实现

```
ContextSectionProvider（基础设施）        取内容
        │
        ▼
buildContextCompiler()（领域）            排序 · 裁剪 · 量化 · 记来源
        │
        ▼
composePromptFromPacket()（领域）         套固定外壳 → 最终 prompt
```

`composePromptFromPacket()` 刻意**只做一件事**：把 `packet.text` 放进
`<context>`，外面套一层固定的输出要求。

于是"往 prompt 里加东西"这件事只有一条路径——**先变成一个 section**，
从而必然被 Trace 记录到。

```ts
export function composePromptFromPacket(packet: ContextPacket, agentName: string): string
```

---

## 预算与裁剪

传 `tokenBudget` 时按排序结果依次装填；`droppable === false` 的**无条件保留**。

M2.5 的量化器默认按字符估算（`chars / 2`）。接真实 tokenizer 只需要
注入 `quantifier`——**领域层不做 tokenizer 依赖**。

`tokenBudget` 目前在 CLI 路径里没有开启（`undefined` = 不裁剪），
因为这个项目的对话轮数还没有到需要压缩的量级；M5 的 Conversation Rollup
会与预算一起上线。

---

## 与旧路径的关系（cutover 状态）

M2.5 保留两条路径，由 `CHARACTER_CONTEXT_COMPILER_V1` 切换：

| | 旧路径（默认关闭新路径时） | 新路径 |
|---|---|---|
| 组装 | `runtime.composeState()` + `messageHandlerTemplate` | `ContextCompiler` + `composePromptFromPacket` |
| 历史来源 | `memories` 表（ElizaOS `RECENT_MESSAGES`） | `conversation_events` 表 |
| 可追溯 | 只能靠 `--dump-prompt` 事后看 | trace 里直接有 section id 列表 |

**默认值刻意保守**：`CHARACTER_CONTEXT_COMPILER_V1` 默认 **off**。
原因是接管主 prompt 会**改变回复风格**，而 M2.5 的硬约束是
"M1/M2 行为不得退化"。所以先并列上线、可实测对比，再决定何时默认打开。

即使在新路径下，回复仍然**双写回 `memories`**，
因此 `--history`、`CHARACTER_STATE` provider 等既有能力完全不受影响
（plan 第 72 节的双写策略，Phase J 收口）。

### 一个必须知道的边界：干跑模式不走新路径

`--test` / `--dry-run` 时**整个新链路都不写库**——不写对话事件、
不写领域事件、不写 trace。这是"测试对她等于没发生过"这条既有规矩
在 M2.5 上的延伸。

代价是：干跑模式下看到的是**旧路径**的 prompt。
想验证新路径的真实 prompt，用 `pnpm eval:real`（真实模型 smoke）
或 `pnpm chat`（正常模式，会写库）。

---

## 真实输出长什么样

`pnpm eval:real` 的实测（DeepSeek `deepseek-flash`，ContextCompiler v1）：

```
turn 1  上下文: current-input + seed-identity + critical-state   (~491 tokens)
turn 2  上下文: current-input + seed-identity + critical-state + recent-conversation  (~567 tokens)
turn 3  上下文: current-input + seed-identity + critical-state + recent-conversation  (~630 tokens)

用户: 我今天面试挂了，不太想说话。
她  : 嗯。那就不说。 / 我不问。你也别一个人在那儿复盘，越翻越难受，
       上次你也是，嘴上说没事，半夜三点还在线。 / 吃饭没。……
```

三点值得注意：

1. section 组成**随对话自然增长**（第一轮没有历史，所以没有 recent-conversation）。
2. `critical-state` 一直在——状态确实在影响语气（复用 M2 的确定性映射，未重写）。
3. 她没有念出任何条目名、数值或 XML 标签——外壳是"给她看的"，不是"给她说的"。
