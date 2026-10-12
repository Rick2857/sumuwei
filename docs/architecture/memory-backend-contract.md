# Memory 后端契约

> **这份文件回答**：记忆存在哪里？外部后端（MemOS / Vector DB / Embedding）
> 能替换到哪一层？换掉它们会不会丢掉苏沐薇的权威记忆？

- **相关 ADR**：ADR-026（先有 Native 基线再谈外部后端）、ADR-027（外部后端的门禁判据）
- **结论记录**：[`../m4/ADR-M4-MemOS.md`](../m4/ADR-M4-MemOS.md)（**REJECT**）、[`../m4/memos-poc.md`](../m4/memos-poc.md)（证据）
- **不变量**：MI-13（后端不得定义角色记忆的业务语义）
- **守它的测试**：`m4:restore:verify`（24 项）、`m4:real-db:verify`、`kernel:test`（依赖方向）

---

## 1. 一句话

> **真源是 append-only 的账本 + 领域事件**，不是任何后端。
> 后端只允许通过一个**窄接口**接入，而且必须在 Native 基线之后。

计划书第 93 节的原文：

> 否则使用 MemOS 以后得到一个结果："好像能记住"，
> 无法判断：是 MemOS 真的改善了，还是我们根本没有自己的基线。

---

## 2. `MemoryStorePort`（`memory-store.ts`）

```ts
get(id)                                  按 id 取一条
getActiveByCanonicalKey(key)             按槽位取**当前有效**的
listByCanonicalKey(key)                  按槽位取**全部历史**（含 superseded/retracted/disputed）
listBySubject(owner, subject)            按主体查
listBySource(ref)                        按来源反查
list(scope)                              按 owner / status / type 列出
getActiveByFingerprint(owner, fp)        去重第一层的查询口
history(id)                              这条记忆的全部领域事件（升序）
apply(event)                             应用一个**已被放行口校验过**的领域事件
rebuildMemory(id)                        从事件流重建单条 + `A == B` 判定
rebuildCharacterMemories(owner)          重建整个 Memory Space
```

### ⚠️ 刻意**没有** `search(query)`

计划书第 89–90 节：**Storage lookup 与 Semantic retrieval 不是同一问题**。
"根据这句话找到最相关的五条"是 **M5** 的 `MemoryRetrievalPort`。

把两者合成一个"万能 `search()`"会让："检索结果"与"存储事实"在接口上无法区分 ——
而计划书第 3 节明确把"检索结果自动永久写入长期记忆"列为**架构违规**。

---

## 3. 真源在哪：账本，不在投影

```text
conversation_events      事实账本（append-only）—— 她与用户之间**发生过**什么
character_domain_events  领域事件（含 MEMORY_*）—— 她因此**怎么变**了
memory_records           投影（当前事实视图）—— **可以随时重建**
memory_subject_links     索引（subject）
memory_evidence_links    索引（证据 + is_root）
memory_events            索引（这条记忆的事件流）
```

**Memory Projection 是由事件推导得到的当前事实视图，而不是唯一真相来源**（计划书第 3 节）。

三条机器证据：

| 它证明什么 | 由谁守 |
|---|---|
| 投影能从事件流从零重算，且 `A == B` | `m4:verify` §8、`m4:scale`（790/790） |
| 崩溃留下的"已提交未折叠"事件可以补折叠 | `m4:hardkill` §3d（确定性注入 + 生产恢复函数） |
| 备份恢复到**全新库**后逻辑状态 100% 一致 | `m4:restore` §4（哈希 + 计数逐项一致） |

---

## 4. 备份 / 恢复 / 可移植性

```bash
pnpm m4:backup:verify      # 备份可读性（8 项）—— 迁移前的状态
pnpm m4:restore:verify     # 关闭连接后复制 → 全新目录恢复 → 比较（24 项）
```

`m4:restore` 的比较对象是 `CanonicalSemanticSnapshot`：
`logicalId / owner / type / normalizedContent / status / authority /
epistemicStatus / validFrom / validUntil / revisionEdges` 的**规范化排序 SHA256**，
外加 11 项计数。**非语义字段（`updatedAt` 等）被刻意过滤**，否则会因为
"重算的那一秒不同"产生假失败。

两条**负控**（没有负控的"相等"没有信息量）：

1. 全新空库的哈希必须与语料库**不同**
2. 改一个语义字段后哈希必须**改变**

⚠️ 计划书第 203 节的"Native → export → import → New Native"完整往返
今天用**目录级复制**实现（PGlite 是嵌入式 Postgres）。
JSONL 导出格式（§202）**尚未实现** —— 它是"如果将来真的要换后端"时的前置件。

---

## 5. 外部后端的门禁（ADR-027）

任何外部后端（MemOS / Vector DB / Embedding Provider）必须逐条通过：

```text
1  能否保留我们的 MemoryId？
2  能否保留 source provenance？
3  能否表达 supersede？
4  能否表达 retract（且不销毁历史）？
5  能否查询历史版本？
6  能否隔离不同 owner？
7  能否**避免绕过 MemoryPolicy**？        ← 否决项
8  失败时主聊天是否仍能工作？
9  能否完整导出数据？
10 移除它之后是否还能恢复 Native Backend？ ← 否决项
```

**任一条关键项不满足 → `rejected for production`，项目继续 Native 后端，
完全没有问题**（计划书第 102 节）。

### 实测结论（Phase 11）：**REJECT**

`@memtensor/memos-cloud-dsh-plugin@0.1.1` 的决定性失败是**第 7 条**：
它无条件订阅 `agent/pre-step` 与 `session/event`，**默认开启**自动 recall 注入
与整轮 capture（含 assistant 文本），且**不注册任何调用方可调用的写入 API** ——
因此它在结构上无法遵守 Memory Policy。

证据与逐条裁决见 [`../m4/memos-poc.md`](../m4/memos-poc.md)。

**含义**：第 10 条今天尤其重要，而它**已经**由 `m4:restore` 机械证明 ——
Native 真源可以在全新库上独立恢复，不依赖任何外部后端。

---

## 6. 依赖方向（`kernel:test` 静态守着）

```text
src/kernel/**（app/ 除外）  领域层：**不** import 任何基础设施 / Runtime / SQL / 观测后端
src/kernel/app/**           Application Layer：**允许**依赖 infrastructure（它本来就是装配层）
src/infrastructure/**       所有 SQL、HTTP、Runtime 适配都在这里
```

`kernel:test`「Kernel 边界（依赖方向）」会遍历 `src/kernel`（跳过 `app/`），
禁止出现 `@elizaos/`、`drizzle-orm`、`node:fs`、`node:path`、`phoenix`、
`opentelemetry` 等 import。

⚠️ **这里有一个比"接口在哪一层"更值得记住的细节**：
`MemoryStorePort` 的**接口本身**定义在基础设施层（`memory-store.ts`），
而 `src/kernel/app/memory/explicit-service.ts` **刻意不 import 它** ——
文件里写着：

> ⚠️ 刻意**不** `import { MemoryStorePort } from infrastructure/...`。
> 后果不是洁癖问题：一旦 kernel 认识 `MemoryStorePort`，……

它自己定义了一个**更窄的端口**（只要 `apply()`，不要全部读能力）。
同一份理由也写在 `memory-validator.ts`：

> 领域侧的放行口不该拿到 `MemoryStorePort` 的全部读能力。

因此 MI-13 的可静态检查部分是：
**非 `app/` 的领域层不得 import 基础设施**，而不是"kernel 完全不认识后端类型"。
把这条说成后者会夸大保护范围 —— 而夸大保护范围正是本项目反复防的错误。

---

## 7. 已知限制

| 限制 | 说明 |
|---|---|
| JSONL 导出（§202）未实现 | 今天用目录级复制；换后端前需要补 |
| `hydrate` 是 N+1 | `list(limit=50)` 约 150 次查询（每条 1 subject + 1 evidence + 1 supersedes） |
| 只实现一个后端 | Native；Adapter 的**形状**已为外部后端预留，但**没有**第二个实现 |
| 嵌入 / 向量检索不在 M4 | 属 M5；M4 的接口里刻意没有 `search()` |
