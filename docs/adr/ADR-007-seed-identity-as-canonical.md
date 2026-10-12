# ADR-007：Seed Identity 是人格的唯一真源

- **状态**：已接受（M3）
- **日期**：2026-09-16
- **相关**：ADR-002（Seed ≠ Memory）、计划书第 12–19 / 127 / 128 节

---

## 背景

M2.5 落地时，苏沐薇的"人格"实际上同时存在于**四处**：

| 来源 | 位置 | 谁在用 |
|---|---|---|
| ElizaOS `Character` 对象 | `src/character/苏沐薇.ts` | 旧链路（`composeState` 的 `CHARACTER` provider） |
| 领域 `CharacterDefinition` | `character_definitions` 表 | 新链路（ContextCompiler） |
| `messageExamples` 少样本示例 | `src/character/苏沐薇.ts` | ElizaOS provider |
| `adjectives` 形容词 | 同上 | 同上 |

这四处**互相覆盖**：默认走新链路时模型看到的是第二处，
一旦 `CHARACTER_CONTEXT_COMPILER_V1=0` 就变成第一、三、四处的组合。

M2.5 允许这种状态，因为它的目标是"把铁路修好，不改变她可见的行为"。
但 M3 的 WP3 Gate 明确要求：

> 所有 Character Main Agent 调用都由 IdentityProvider 得到 Seed。
> **不存在第二人格来源。**

---

## 决策

**`CharacterDefinition`（结构化 Seed）是人格的唯一真源。**

具体规则（四条，全部可被机器检查）：

1. **代码里的 `Character` 对象是人写源，不是运行期真源。**
   它在启动时经 `seed-projection.ts` 投影成 `CharacterDefinition`，
   投影规则是"原样取出内容，不改写人设"。运行期唯一被读取的是投影结果。

2. **Prompt 里的那段人格文本永远是渲染物。**
   它只能是 `CharacterDefinition → renderSeedIdentity() → ContextSection`
   这条链的产物。任何在别处手写人格文本的行为都违反本 ADR。

3. **`messageExamples` 不属于 Seed。**
   它们保留在 `Character` 对象里（旧链路与对照视图仍能看到），
   但**不进入** `CharacterDefinition`。
   理由：它们不是结构化人格数据，而且 `苏沐薇.ts` 的注释已注明
   "是依据设定推导写出来的，不是用户提供的原话" ——
   把推导出来的示例写进 Seed，等于让 Seed 包含一份未经验证的创作。

4. **旧链路不提供 M3 的身份保证。**
   `--legacy` / `CHARACTER_CONTEXT_COMPILER_V1=0` 仍然可用（对照与排障需要），
   但那时的 prompt 里会出现 ElizaOS `CHARACTER` provider 生成的另一份人格文本。
   因此：**默认配置下每一轮 Trace 的 `contextCompilerVersion` 必须是
   `context-compiler@2`**，这条由 M3 评测套件断言守着。

---

## 被否决的备选方案

### 方案 A：删掉 ElizaOS `Character`，只保留结构化 Seed

**否决理由**：`Character` 是 ElizaOS Runtime 的必需输入（agent 的身份、
插件列表、`settings.secrets`）。删掉它就要 fork Runtime 或写一个假对象，
而 ADR-001 已经把"不改 Runtime 本体"定成边界。

而且它承担一个真实作用：`--dump-prompt --legacy` 需要能还原
"M1 时代她看到什么"，那是排查历史问题的唯一手段。

### 方案 B：反过来，把 Seed 塞进 `Character` 的 `system` 字段

**否决理由**：`苏沐薇.ts` 顶部已经写明 `system` **故意留空**：
"人格走 ElizaOS 原生 `CHARACTER` provider，不塞进 system prompt。
这样 L1-M2 接入 State provider、L1-M4 接入 Summary provider 时，
不会把人设挤掉。"

历史证明这个判断是对的：后来接入 `CHARACTER_STATE` 时，
正是"人设走独立 section"这一点让状态没有挤掉人格。

### 方案 C：让 Seed 保持四段自由文本（M2.5 的形状），只加版本号

**否决理由**：这是**最省事**的方案，也是问题最多的方案。
M3 的评测要求回答"她的谨慎有多强""她的谨慎**不**意味着什么"，
而自由文本给不出可比较的强度，也无法在 schema 层面强制"每条倾向必须带反例"。
计划书第 15 节把反例称为"显著减轻角色漫画化的最便宜手段" ——
**只有结构化才能强制它存在**。

---

## 后果

### 正面

- "她是谁"在数据上只有一处，因此"她怎么悄悄变了"可以被检测（见 ADR-010）。
- 上下文里的身份文本可追溯到 (seedVersion, seedHash)，排查时不必猜。
- 结构化 Seed 让评测有锚点：`KNOWN_TRAITS` 的每一条都能被
  Personality Interview 的题目引用。

### 代价

- 每次改人设都要动结构化数据，比"改一句话"麻烦。
  **这是刻意的**：计划书第 18 节要求"改一个字都要 +1 版本"，
  流程越轻，被随手改掉的概率越高。
- `KNOWN_TRAITS` 里未登记的新形容词只会得到"未被展开"的占位描述。
  **这也是刻意的**：宁可信息少，也不要编造一段模型会当真的描述。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 默认每轮都用 `context-compiler@2` | M3 评测套件 `identity-core` 套件 |
| 身份 section 每轮都在且不可裁 | `pnpm eval:scenarios` SC-001 / SC-006 + 跨场景不变量 |
| `messageExamples` 不在 Seed 里 | `scripts/kernel-tests-identity.ts` |
| 渲染从规范化结果出发（指纹与文本同源） | `scripts/kernel-tests-identity.ts` |
| 域层不 import ElizaOS | `pnpm kernel:test` 的依赖方向检查 |
