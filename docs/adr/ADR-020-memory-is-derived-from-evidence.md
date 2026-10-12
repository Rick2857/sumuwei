# ADR-020：Memory 由 Evidence 派生，不由模型声明

- **状态**：已接受（M4）
- **日期**：2026-09-16
- **相关**：计划书第 25 – 27 / 40 – 41 / 148 / 170 节；MI-03
- **代码**：`src/kernel/contracts/memory.ts`（`assertMemoryEvidence`）、
  `src/kernel/app/memory/extractor.ts`（`resolveCandidates` / `evidenceProfileOf`）、
  迁移 0005 的 `memory_evidence_links`

---

## 背景

长期记忆系统最容易做错的一处是**证据与结论的绑定方向**。

一个自然的做法是让抽取器（或模型）在产出候选时顺带声明来源：

```json
{ "claim": {...}, "evidence": ["用户在第 1 轮说过"], "authority": "EXPLICIT_USER_STATEMENT" }
```

这个做法看起来只是"让模型把话说全"，但它在三个地方必然失效：

1. **模型可以说谎，而且不会说"我不知道"。** 它被要求填 `authority`
   时倾向于填一个看起来合理的值。她自己的猜测会被填成
   `EXPLICIT_USER_STATEMENT` —— 而那条记忆从此再也无法与真实陈述区分。
2. **声明与事实可能不一致，而系统无从发现。** 候选说"用户在第 1 轮说过"，
   而第 1 轮其实是她在说话。除非系统**独立地**去查，
   否则这个不一致会一路写进库里。
3. **证据必须是可执行引用，不是自然语言。** `"用户在第 1 轮说过"`
   无法被程序校验；它只能被人读。而人不会读每一条。

计划书第 148 节把这一条当成 M4 的 Critical Test：

> Assistant 的输出不能建立关于用户的事实。

---

## 决策

**Evidence 是引用的集合（可执行），authority 由证据事件**推导**出来，
且模型**没有任何字段**可以声明它。**

### 1. 候选**没有** `authority` 字段

`CandidateDescriptor`（`extractor.ts`）刻意不含 `authority`。
模型能给的只有：

```json
{ "memoryType", "subjectToken", "claim" | "episode",
  "evidenceEventSequences", "confidence", "longTermValue" }
```

模型**不能**声明来源、不能声明权威、不能声明 owner。
这些都是 `resolveCandidates()` 在拿到证据之后**算**出来的。

类型上不存在这个字段，因此"模型声称自己是权威"不是一个
"要记得校验"的问题，而是一个**写不出来的表达式**。

### 2. 权威从证据**派生**

```text
证据事件（actorType / actorId）
  → sourceKindForActor()
  → defaultAuthorityForKind()
  → authorityFromSource()
  → candidate.authority
```

`authorityFromSource()` 对 `SYSTEM_INSTRUCTION` **失败关闭**：
不降级、不猜、不取"最近似的那个"。

| 证据来自 | 推导出的权威 |
|---|---|
| 用户的明确陈述 | `EXPLICIT_USER_STATEMENT` |
| 用户的纠正 | `EXPLICIT_CORRECTION` |
| 角色的输出 | 弱权威（不足以建立用户事实） |
| 系统指令 | **拒绝** |

### 3. 证据必须是**可解析的引用**

`EvidenceRef.id` 非空是硬断言：

> `EvidenceRef 的 id 不能为空：没有具体来源的"证据"等于没有证据（MI-03）`

`resolveCandidates()` 还要求候选引用的序号**落在本批次里**
（`requireEvidenceInBatch`）：引用一个不存在的事件 =
把"我编的"伪装成"有出处的"。

### 4. 派生记忆必须继承根

`assertDerivedEvidenceInherits()` 保证
`evidenceRootIds ⊆ sourceRefs`，否则抛
`derivation_without_source` / `derived_evidence_root_missing`。

没有继承链，一条由 A 推出的记忆就无法回答"追到底是哪句话"。

### 5. 三处独立的失败关闭（不是一处）

| 层 | 函数 | 失败码 |
|---|---|---|
| 契约 | `assertMemoryEvidence` | 证据为空 / id 为空 |
| 构造 | `evidenceProfileOf` | `没有任何证据画像` |
| 持久化 | 迁移 0005 的 `memory_evidence_links` + `m4:verify` §11 | 写不进去 |

刻意重复：**只在一层守的规则，会在那一层被重构时消失。**

---

## 被否决的备选方案

### 方案 A：让模型声明 `authority`，系统校验

**否决理由**：校验需要"真值"，而真值只能从证据推导 ——
那就等于把推导做两遍，且第一遍（模型的声明）永远只是噪音。
更糟的是：一旦 schema 里有这个字段，调用方就会开始**读**它。

### 方案 B：把证据存成自然语言描述

**否决理由**：不可校验。而"不可校验"在自动写入路径上等于"不存在"。
它可以作为**附带**信息（`payload` 里的原文），但不能作为证据本身。

### 方案 C：只在持久化层校验证据

**否决理由**：抽取流水线会先构造候选、再过值闸、再分析冲突。
如果证据校验只写在最末端，那么前面所有阶段的输入都是
"可能有证据也可能没有"—— 每个阶段都得处理这个不确定性。
在**构造时**就失败关闭，让下游可以假定"候选一定有合法证据"。

### 方案 D：证据只存根，不存直接引用

**否决理由**：`sourceRefs`（直接证据）与 `evidenceRootIds`（根）
回答的是两个不同问题 —— "这条记忆根据什么建立"与
"追到底是哪句话"。只存根会丢掉中间层，
而中间层正是"这条记忆是从哪一轮推导出来的"的答案。

---

## 后果

### 正面

- 模型无法通过**任何**输出字段影响 authority —— 这条通道在类型上不存在。
- 每条记忆都能回答"你凭什么记着这个"，且答案可被程序校验。
- 污染（她的猜测变成用户事实）有两处独立的机器守卫。

### 代价

- 抽取器需要把事件的 `actorType` / `actorId` 带进证据视野
  （`processorEventViewOf`），因此 tool 事件必须失败关闭 ——
  它没有合法的三种 Actor 之一。
- 证据链让每条记忆多两个关联表的写入。缓解：两者都是一次批量插入。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| `SYSTEM_INSTRUCTION` → 权威推导失败关闭 | `m4:test` 分组「权威映射」 |
| 候选类型里**没有** `authority` 字段 | 类型系统 + `m4:test` 分组「后台抽取 · Source Firewall」 |
| 无证据 → 构造时抛错 | `m4:test` 分组「证据（MI-03）」 |
| 引用不存在的事件 → 拒绝整条候选 | `eval:m4` M4-017 |
| 派生证据必须继承根 | `m4:test` 分组「证据继承（计划书第 41 节）」 |
| 她的猜测建不了用户事实 | `m4:test` 分组「反污染」+ `eval:m4` M4-009 / M4-010 + `M4X-022` 注入 |
| 无证据的记忆写不进库 | `m4:verify` §11 |
| 记录带 `evidenceRootIds` | `m4:verify`「记录带 evidenceRootIds（MI-03）」 |
