# ADR-004：Context Compiler 作为唯一 Prompt 入口

- **状态**：已采纳（M2.5）
- **日期**：2026-09-16
- **相关**：[context-compiler.md](../architecture/context-compiler.md)、SC-006

## 背景

M1/M2 的上下文组装方式是正确的但**不可追溯**：

```ts
const state = await runtime.composeState(message, includeList, onlyInclude)
const prompt = composePromptFromState({ state, template: messageHandlerTemplate })
```

它把所有 provider 的输出**合并进一个 `state.text` 字符串**，
再用 Handlebars 模板渲染。于是：

- 事后无法知道"这一轮究竟有哪些块进了 prompt"——
  只能靠 `--dump-prompt` 把整段文本打出来人眼看。
- 无法做预算裁剪（也没有地方记录"裁掉了什么"）。
- 无法给 Trace 提供"用了哪些 section"这种结构化事实。

## 决策

引入 `ContextCompiler` 作为**唯一**入口：

```
ContextSectionProvider（基础设施，取内容）
        ↓
buildContextCompiler()（领域，排序 / 裁剪 / 量化 / 记来源）
        ↓
composePromptFromPacket()（领域，套固定外壳）
        ↓
ContextPacket { compilerVersion, sections[], text, droppedSectionIds[], ... }
```

**任何模块都不许自己拼 prompt 后直接调模型。**

`composePromptFromPacket()` 只做一件事：把 `packet.text` 放进 `<context>`，
外面套一层固定的输出要求。于是"往 prompt 里加东西"只有一条路径——
先变成一个 section，从而必然被 Trace 记录到。

## 被否决的方案

### 方案 A：继续用 ElizaOS 的 `composeState` + 模板，额外记录 provider 大小

**否决理由**：这是在 **Data 层**做可观测性，而不是在 **Model 层**。
它能告诉你"CHARACTER_STATE 贡献了 102 个字符"，
但不能告诉你"这一轮用的 Seed 是哪个版本的"，也不能做预算裁剪。

而且 `composeState` 的合并是不可逆的：一旦合并进 `state.text`，
就再也分不出"哪一段来自哪个 provider"。

### 方案 B：自定义 Handlebars 模板，给每个 section 一个占位符

**否决理由**：这保留了 ElizaOS 的渲染管线，但把"哪些 section 存在"
编码进了模板字符串。加一个 section 就要改模板，且模板本身
**在测试外**（一串字符串常量），没有任何东西守着它。

### 方案 C：直接接管，删掉旧路径

**否决理由**：M2.5 的硬约束是"M1/M2 行为不得退化"。
接管主 prompt 会**改变回复风格**（新旧 prompt 结构不同），
一次性替换就无法实测对比"到底有没有改坏"。

因此采用**并列上线 + 功能开关**（见下面的后果）。

## 后果

**正面**
- Trace 里直接有 `contextSectionIds` / `droppedSectionIds`，
  "她是忘了还是根本没进去"变成可回答的问题。
- 预算裁剪有明确语义：`droppable === false` 的 section（Seed 与当前输入）
  **宁可超预算也不裁**。
- 排序确定性可测（priority 降序 + id 升序），因此 prompt 可复现。

**负面 / 成本**
- 多了一层"provider → section"的转换。
- `COMPILER_VERSION` 需要维护：改了 section 顺序或格式就要升版本，
  否则 Trace 里两条不同结构的记录会看起来一样。

## 关键实施决定：默认关闭，并列上线

```
CHARACTER_EVENT_PIPELINE_V2     默认 on   （写事实账本不改可见行为）
CHARACTER_CONTEXT_COMPILER_V1   默认 off  （接管主 prompt 会改变回复风格）
CHARACTER_TELEMETRY_ENABLED     默认 off  （观测一律 opt-in）
CHARACTER_SLOW_PATH_ENABLED     默认 on   （纯本地，不调模型）
```

这个默认值组合让 M2.5 的**首次交付不改变任何用户可见行为**，
同时新链路已经在真实对话上运行（事实账本有数据）。
想验证新路径时打开开关，随时可以关回去。

即使在新路径下，回复仍然**双写回 `memories`**，
因此 `--history`、`CHARACTER_STATE` provider 等既有能力完全不受影响。

### 一个必须知道的边界

`--test` / `--dry-run` 时整个新链路都不写库（不写事件、不写 trace），
因此干跑模式下看到的是**旧路径**的 prompt。

这是"测试对她等于没发生过"这条既有规矩的延伸，
但它确实让"用干跑验证新 prompt"做不到——
要验证新路径的真实输出，用 `pnpm eval:real`（真实模型 smoke，
在一次性副本库上跑）或正常模式。
