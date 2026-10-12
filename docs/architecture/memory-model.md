# Memory 领域模型

> **这份文件回答**：长期记忆在领域里**是什么形状**？
> 一份记录由哪些字段构成、哪些字段是"事实"哪些是"推导"、
> 以及为什么同一件事实会落进**同一个槽位**。

- **相关 ADR**：ADR-020（记忆由证据派生）、ADR-021（owner/subject 分离）、ADR-022（四种类型）
- **不变量**：MI-01 ~ MI-15 见 [`memory-invariants.md`](./memory-invariants.md)
- **守它的测试**：`pnpm m4:test`（228 项）、`pnpm m4:verify`（142 项）

---

## 1. 一句话

> 一条长期记忆 = **一个被证据支持的、属于某个角色的、关于某个主体的判断**，
> 它有类型、有槽位、有权威等级、有时间范围、有状态。

它**不是**"一段文本"，也**不是**"模型说的事实"。

---

## 2. 三个维度必须分开（ADR-021）

| 维度 | 问题 | 取值 | 今天的实际值 |
|---|---|---|---|
| **owner** | 这条记忆**属于谁的空间** | `EntityRef` | **几乎总是苏沐薇（角色）** |
| **subject** | 这条记忆**讲的是谁** | `EntityRef` | 几乎总是 Alex（用户） |
| **source** | 这条记忆**凭什么成立** | `EvidenceRef[]` | 真实对话事件 |

⚠️ **owner 被强制为 `character`**：`memory-validator.ts` 里 owner 不是 character
就报 `memory_owner_not_character`。这不是限制，而是模型的一部分 ——
**记忆空间属于角色**，"关于用户的记忆"是 subject 维度的事。

这条区分有两个直接后果：

1. 附件的"多用户 owner 隔离"在这里**不成立**；本项目的隔离落在 **subject** 维度
   （见 `m4:isolation:verify`）。
2. **subject 参与槽位键** —— 否则 A 和 B 的"我住在西安"会被去重成
   **一条共享记忆**，那才是真正的串线。

---

## 3. 四种类型（ADR-022，封闭集合）

```text
claim 型（有槽位）        episodic 型（没有槽位）
  person_fact               episode
  preference                self_experience
```

| 类型 | 一句话 | 有 canonicalKey？ |
|---|---|---|
| `person_fact` | 关于某个实体的事实 | ✅ |
| `preference` | 关于某个实体的偏好 / 回避 | ✅ |
| `episode` | **发生过**的一段经历 | ❌（一段经历不是"一个事实槽位"） |
| `self_experience` | 她自己经历过的事 | ❌ |

判据在 `CLAIM_MEMORY_TYPES` / `EPISODIC_MEMORY_TYPES`。
**封闭**的含义是：新增类型必须显式改契约（受控枚举测试守着）。

---

## 4. 一条记录（`MemoryRecord`）

```ts
id                   MemoryId          // 由 (characterId, 槽位/内容) 派生，幂等
owner                EntityRef         // character
subjects             EntityRef[]       // 至少一个（claim 型必须与 content.subject 一致）
type                 MemoryType        // 四种之一
content              ClaimMemoryContent | EpisodicMemoryContent
status               MemoryStatus      // active | superseded | retracted | disputed
authority            MemoryAuthority   // 见 memory-authority.md
epistemicStatus      reported | observed | inferred | generated
importance           0..1              // 值闸用它
confidence           0..1              // 与 importance **不是**一回事
canonicalKey?        string            // 槽位键（episodic 型没有）
contentFingerprint   string            // 内容指纹
validFrom?           number
validUntil?          number | null     // 三态，见 memory-temporal-semantics.md
occurredAt?          number            // 事情发生的时间
recordedAt           number            // 系统记下它的时间
supersededBy?        MemoryId
supersedes?          MemoryId[]        // 由**其他**记忆的 SUPERSEDED 事件推导
revision             number            // 乐观锁令牌
reducerVersion       string            // 算出它的折叠语义版本
schemaVersion        number
```

`supersedes` 值得单独说：它**不在自己的事件流里**，而是"谁的 `supersededBy` 指着我"。
`rebuildMemory()` 必须把它一起重算出来 —— 否则重放结果永远比读路径少一个字段，
而 `A == B` 这条 Gate（计划书第 74 节）抓的就是这个。

---

## 5. 三个"指纹"分别回答什么（去重的三层）

| 指纹 | 材料 | 回答 |
|---|---|---|
| `contentFingerprint` | 规范化内容 + **全部 qualifiers** + 排序后的 subjects | "这条内容一模一样吗" |
| `canonicalKey` | `owner + subject + type + predicate + qualifier scope` | "这是**同一个槽位**吗" |
| `content` 的规范化键 | 值本身 | "同一个槽位的**同一个取值**吗" |

⚠️ 第一层**含 qualifiers**：否则"技术问题要详细讲"与"闲聊简短点"
会因为 predicate 相同而被合并成一个槽位（实测踩到过）。
⚠️ 第二层先把 predicate **规范化**再摘要：否则 `Food.Preference.Cilantro`
与 `food.preference.cilantro` 会变成两个槽位。

**三层的关系**：第一层抓"重复内容"，第二层抓"同槽位新值"（→ 冲突分析），
第三层是有限候选集 + 语义判断（今天只到前两层 + 注入式用例）。

---

## 6. 为什么"记忆由证据派生"（ADR-020）

写入路径上有一条**结构性**闸：

```text
assertMemoryAuthorityAllows({ authority, type, epistemicStatus })
```

它在**构造候选时**（不是校验时、更不是落库时）就抛错。
例如 `CHARACTER_GENERATION` 想建 `person_fact` → `authority_cannot_establish_person_fact`。

实测（`pnpm m4:audit`）：脚本第一版把这一步写成"等放行口返回拒绝码"，
结果**脚本自己崩了** —— 而崩得对：它说明防线比预期更靠前。

**含义**：污染不是"被拦住"，而是**造不出来**。

---

## 7. 已知限制

| 限制 | 说明 |
|---|---|
| 内容指纹**不是抗碰撞的** | 它用于去重与幂等，不是安全边界（`memory-invariants.md` §16.7） |
| predicate 同义词靠**登记的 description** 消歧 | 没有任何代码阻止模型下次又选宽泛槽位（§16.4） |
| `MEMORY_MERGED` 接口完整但**无生产者** | 不要读成"合并已验证"（§16.2） |
| canonical 槽位上**没有** DB 级"同槽位一条 ACTIVE"唯一约束 | 该保证在**后台冲突分析器**里（`m4:verify` §16）。**含义**：任何绕过流水线的新写入路径必须自己跑冲突分析 |
