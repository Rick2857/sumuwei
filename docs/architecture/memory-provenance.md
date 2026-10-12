# Memory 溯源（Provenance）

> **这份文件回答**：一条记忆**凭什么**成立？哪些是根证据、哪些是派生的？
> 怎么从一条记忆走回"她当时说的那句话"？

- **相关**：[`source-provenance.md`](./source-provenance.md)（M3 的来源类别）、ADR-020
- **不变量**：MI-03（必须有 Evidence）、MI-05（subject 不得默认写死为 User）
- **守它的测试**：`m4:real-db:verify`（真库 MI-03）、`m4:audit`（35 条语料）、`m4:test`「证据（MI-03）」「证据继承」「溯源视图」

---

## 1. 一句话

> 每条正式记忆**至少有一个合法的证据根**，而证据必须**真的存在**。

判据是机械的，可反复调用：

```text
unsupportedMemories(db, owner) → 应当恒为空
```

它就是计划书第 170 节那条"非常重要的 Gate"（目标：0 unsupported memories），
`pnpm memory:audit` 与 `m4:verify` 都用它。

---

## 2. 证据的形状

```ts
interface EvidenceRef {
  kind: 'conversation_event' | 'observation' | 'domain_event' | 'tool_observation'
  id: string
}
```

`kind` 刻意是**四种**而不是只有对话事件：未来的工具观测不该被迫
"伪装成对话事件"才能当证据（`observation.ts` 用 `sourceEventIds: string[]` 是同一条理由）。

`id` 是 `string` 而不是 `ConversationEventId` —— 同一个理由。

### 根证据 vs 派生证据

```ts
record.sourceRefs       // 这条记忆的全部证据
record.evidenceRootIds  // 其中**根**证据（计划书第 40–41 节）
```

派生证据通过 `inheritedEvidenceRoots()` 继承根。
**为什么要有这个区分**：若一段 Episode 由多段对话 + 若干工具观测组成，
"这条记忆凭什么成立"与"它由哪些事件组成"是两件事。今天高度重叠，未来不会。

---

## 3. 证据必须真的存在（一条被正确拒绝的实测）

第一版 `verify-m4-persistence` 用的是**合成的事件 id**（`cev:...:1` 这样拼一个）。
它**被放行口正确地拒绝了**（`memory_evidence_event_missing`）——
而那正是设计要的行为：计划书第 126 / 154 节要求 Evidence 必须指向**真实**事件，
否则"这条记忆来自哪"就只是一句声称。

因此现在所有验收脚本都走 `ConversationRecorder`（生产代码写入账本的**唯一**入口），
让证据事件真的落库。顺带证明了 M4 与 M3 的账本是无缝对接的。

放行口检查三件事：**事件存在**、**属于本角色**、**证据序号落在本批次内**（Source Firewall）。
第三条的判据在评测里叫 `requireEvidenceInBatch` ——
它防的是"这条记忆引用了本次抽取窗口之外的、不相干的证据"。

---

## 4. 怎么从一条记忆走回去

```bash
pnpm memory:sources <id>     # 这条记忆根据哪几轮对话建立（打原文）
pnpm memory:history <id>     # 同一槽位的取值演变 + Current
pnpm memory:audit --limit N  # §217 的八个问题，逐条渲染
```

审计渲染器（`renderMemoryAudit`）逐条回答：

```text
① 真的值得记吗   → importance
② 来源正确吗     → sourceRefs（+ 用 memory:sources 看原文）
③ 谁说的         → authority
④ 是不是模型猜的 → epistemicStatus（+ 是否出现过污染）
⑤ 当前还有效吗   → status / validUntil
⑥ 有没有重复     → contentFingerprint（+ 机械扫描）
⑦ 旧版本在哪里   → supersedes / supersededBy
⑧ 为什么建立     → processor@version
```

⚠️ `⑥` 与 `⑦` **只打印指纹是不够的** —— 判断"有没有重复"要拿指纹去比对，
"旧版本在哪里"要真的顺着指针走一遍。`m4:audit` 因此各加了一条**全量扫描**：
活跃指纹两两不同（0 组重复）、每条 SUPERSEDED 都有 `supersededBy` 且**双向**成立。

---

## 5. 隐私：证据**不进**外部遥测

`memory-trace.ts` 有一条隐私守卫：trace 只发**计数、类型、状态、id**
（13 种步骤 / 14 个属性键），**默认不发记忆正文**（计划书第 110 节）。

实测踩到过一次**误报**：键名里含 `predicate` 就被判成内容 ——
修法是"键以 `_count` / `_ids` 结尾时放行"。

---

## 6. 已知限制

| 限制 | 说明 |
|---|---|
| 内容指纹不是抗碰撞的 | 用于去重与幂等，不是安全边界 |
| `kind` 的四种里今天只用到 `conversation_event` | 其余三种是 M3.5 预留的插座 |
| 证据反查是 `listBySource` 的单跳 | 不做多跳图查询（M4 不建知识图谱，计划书第 19 节） |
