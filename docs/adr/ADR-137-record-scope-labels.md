# ADR-137 —— 可见性标签的落库方式与迁移（U1 / WP4）

日期：2026-10-14（Asia/Shanghai）。状态：**ACCEPTED / DESIGN FROZEN** —— 原主人 2026-10-14 裁定：**采用方案 B**（标签放**记录之外**：新表 `record_scope_labels` + 迁移 `0019`；M4 记录与事件 payload 一字不改）。
`R-WP4-1…4` 由本 ADR 取**推荐默认**（原主人未逐项指定；若要改，只改这几行）：

```text
R-WP4-1 存放位置 = **记录外**（B）
R-WP4-2 首版范围  = 只做 private_to_origin（缺省）+ character_internal；**explicit_shared 的授予动作留到后续**
R-WP4-3 旧记录    = **不批量回填 origin**；缺标签 ⇒ 保守按 private_to_origin，并在完整性报告里如实列出
R-WP4-4 character_internal = **由程序按记录类型/来源判定**（不由写入方自由声明）
```
归属：多用户补充计划 **U1**（[`ADR-133`](ADR-133-multi-user-scope-and-authorization.md) `D07`；契约 [`Multi-User-Scope-Contract.md`](../post-lv2/Multi-User-Scope-Contract.md) §3）。
上游裁定：唯一存档 / 逐人关系 / 原主人可跨域查记录 / 普通用户不得查他人记录 / 群披露按全群受众。

> ⚠️ **本 ADR 是设计，不是实现**。它不改 `src/**`、不写迁移、不动生产库。
> 之所以必须**另立 ADR**：本项要给长期记忆加**归属与披露维度**，
> 按 AGENTS"涉及冻结的记忆语义变更时另立 ADR/里程碑和全套相关门"。

---

## 1. 今日的隔离只有"角色 + 主体"，**没有归属**

```text
MemoryRecord（src/kernel/contracts/memory.ts:403-519）逐字段读完：
  id / owner / type / content / subjects / epistemicStatus / authority /
  importance / confidence / status / sourceRefs / evidenceRootIds /
  validFrom? / validUntil? / occurredAt? / recordedAt / supersedes? / supersededBy? /
  processor / processorVersion / canonicalKey / contentFingerprint /
  reducerVersion / revision / schemaVersion / createdAt / updatedAt
  ⇒ **没有任何 visibility / scope / audience / access 字段**
召回侧的隔离（src/kernel/recall/eligibility.ts:182-194）只有两条：
  ① namespace = owner 是角色        ⇒ WRONG_NAMESPACE
  ② subjects 含 request.user        ⇒ WRONG_USER
  ⚠️ ② 是"这条讲的是不是这个人"，**不是**"这个人有没有权读这条"（X0 `D07`/`D08`）
```

⇒ 缺口是**归属（originRoom）与披露（disclosure）**这两件事，而它们今天无处存放。

---

## 2. 两条硬约束（决定了可选项的边界）

### 2.1 记录**必须能从事件重建**

```text
src/kernel/contracts/domain-event.ts:614-619
  MEMORY_CREATED 的 payload **携带首版完整快照**（maxPayloadBytes 32768），
  理由逐字："rebuildMemory 必须能从事件从零建出记录"
src/kernel/contracts/domain-event.ts:633-644（restatement 的先例）
  payload 校验器会**只取契约内字段**（未知字段被剥离）⇒ 往 payload 里加字段
  必须**显式**写放行分支，否则同一 payload 在旧代码下会被剥掉（回滚兼容的发射侧半边）
src/infrastructure/persistence/memory-store.ts:1021  rebuildMemory(db, id)
```

⇒ 若把标签放进**记录/事件**，它天然随重建存活，但那是 **M4 冻结形状**的变更（重）。
⇒ 若把标签放在**记录之外**，重建不碰它，但必须回答"重建后标签怎么办"。

### 2.2 证据是 `{kind, id}`，来源域**可以**推导但要多跳

```text
src/kernel/contracts/memory.ts:252-279
  EvidenceRef = { kind, id }；kind ∈ conversation_event / observation / domain_event /
                tool_observation / story_event
  ⇒ 只有 conversation_event 能经"事件 → conversationId → conversation_identities"走到房间；
     group 房间还要等 G1 的房间模型
```

---

## 3. 备选与裁定

| 备选 | 做法 | 判定 |
|---|---|---|
| **A（记录内）** | 给 `MemoryRecord` 加 `originRoom` / `disclosure` 字段，并按 §2.1 的显式放行分支写进 `MEMORY_CREATED` payload | 语义最"正统"（标签是记录的一部分，重建自然存活）；**代价最大**：动 M4 记录契约 + 事件 payload 校验 + 全套 M4 门，且旧事件没有该字段 ⇒ 需要"缺字段=保守缺省"的回滚兼容分支 |
| **B（记录外 · 推荐）** | **新表**（迁移 `0019`）按 `(record_kind, record_id)` 存 `origin_room` + `disclosure`；**写入时**打标；**M4 记录与事件 payload 一字不改** | ✅ 不动 M4 冻结形状；标签是**授权元数据**而不是记录内容，这与"owner/subject 是语义归属、不是授权"（X0 `D07`）的分工一致。代价：记忆写路径加一步；重建后**不**重算标签（见 §4.3） |
| C（纯读时推导） | 不新增存储，读时从 `sourceRefs` 推 origin | ❌ 装不下 `explicit_shared`（那是**事后决定**，不是证据属性）；且每次读要多次 join；G1 的群房间未定义时推不出来 |

⇒ **推荐 B**。本 ADR 其余部分按 B 展开。

---

## 4. B 的落地形状（**待裁定后**才实施）

### 4.1 迁移 `0019`（新表）

```text
record_scope_labels
  record_kind   text not null        -- 首版只有 'memory'；留种类以便日后扩到附件/日志
  record_id     text not null
  origin_room_kind  text not null    -- 'private' | 'group'
  origin_room_id    text not null    -- private → userId；group → groupId
  disclosure    text not null        -- private_to_origin | explicit_shared | public_to_room | character_internal
  labeled_at    bigint not null
  labeled_by    text not null        -- 程序来源（如 'memory-write-path@1'）
  primary key (record_kind, record_id)
  + CHECK：disclosure 词表；origin_room_kind 词表；(group ⇒ room_id 非空) 的三态 CHECK
```

**不**给 `memory_records` 加列 —— 那样会让"记录内容"与"授权元数据"混在一张表里，
且 `rebuildMemory` 的重建结果会与标签行产生第二份真相。

### 4.2 写入与读侧

```text
写：记忆创建时同一事务内写一行标签（origin = 当前 room；disclosure = private_to_origin）
读：eligibility / 候选选择 在**序号 ③（room 授权）之后的同一判定**里查标签
    · 缺标签 ⇒ 按 private_to_origin 处理（最保守，X0 `VL-01`）**且**在完整性报告里如实列出
    · 标签非法 ⇒ 拒绝（fail-closed）
`explicit_shared` 的授予走**独立受控动作**（谁在何时向哪个 room 分享），带审计；本 ADR 只定契约，
  首版是否实现列入待裁定项（`R-WP4-2`）
```

### 4.3 与 `rebuildMemory` 的关系（必须写清，否则会变成第二份真相）

```text
· 标签**不是**记录内容 ⇒ 重建**不**重算标签，标签行原样保留
· 重建前后标签行必须**逐字节不变**（判据）
· 若某条记录被物理删除而标签行残留 ⇒ 完整性报告如实列出（不静默清理）
· 反向：活记录没有标签行 ⇒ 保守缺省 + 完整性报告列出（不因为缺行就放行）
```

### 4.4 历史数据（原主人历史）

```text
· 迁移**只建表**，**不**给旧记录补"公共"标签（X0 `D21`：无法确定归属的不向新用户开放为原文）
· 旧记录**没有**标签行 ⇒ 读侧按 private_to_origin 处理，且 origin 只能取"原主人的私聊域"
  （今天全部历史都属于该域）
· **不**在迁移里批量回填 origin —— 回填需要判定"哪条属于哪个 room"，而旧数据没有这个信息；
  宁可按缺省保守处理，也不编一个来源
```

---

## 5. 影响面与必须复跑的门

| 面 | 影响 | 处置 |
|---|---|---|
| M4 记录 / 事件 payload | **不动**（B 的全部价值） | — |
| 记忆写路径 | 加一步"写标签行" | 属 U1 实现；需 M4 线相关门复跑（`m4:*`、`m4.5:ci`） |
| 召回资格层 | 序号 ③ 扩成"room 授权 + 标签" | `u1:scope:verify` 扩判据；`m5:*` 复跑 |
| 迁移 | 新迁移 `0019`（当前最新 `0018`） | `m3:migrate-gate` + `postlv2:db:verify` 复跑 |
| 真实库 | **不打开**；先在副本/隔离库演练 | 先例 `PG-ISO-01` / M5.1.1 的副本纪律 |
| 现有 18 行读取面清单 | 新增标签后要逐面接线 | 见契约 §4；**WP5** |

⚠️ 一处必须同时修的**既有次序问题**（ADR-133 `G18`）：候选**截断发生在资格层之前**
（`memory-retrieval-store.ts:345-348`）。接了标签之后必须裁定"授权过滤早于截断"，
否则会出现"被截掉的那条恰好是越权的"这种掩盖真实泄漏面的形状。

---

## 6. 待原主人裁定

| 编号 | 待定 | 候选 |
|---|---|---|
| `R-WP4-1` | 标签放**记录外**（B，推荐）还是**记录内**（A） | B（不动 M4 冻结形状）/ A（语义最正统但重） |
| `R-WP4-2` | 首版是否实现 `explicit_shared`（显式分享）的授予动作 | 首版只做缺省 `private_to_origin` + `character_internal`（推荐）/ 一并做分享 |
| `R-WP4-3` | 旧记录的处理 | 只按缺省保守处理（推荐，不编来源）/ 尝试按 conversation 证据回填 |
| `R-WP4-4` | `character_internal` 的判定来源 | 按记录类型/来源程序判定（推荐）/ 由写入方显式声明 |

**裁定前**：本 ADR 保持 **PROPOSED**；`memory_records` 与事件 payload **不动**，WP4 **不得**开工。

---

## 7. 与既有判定的关系

```text
· 不改 M4 的记录语义（owner/subject/source 仍只是**语义归属**，不是授权）
· 不改 M7/M8/M9/M10 任何冻结语义
· 不给旧数据补"公共"标签；不把不可归属的历史向新用户开放为原文
· 不主张多用户隔离已就绪；不激活任何入口
```
