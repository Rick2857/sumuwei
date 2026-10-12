# ADR-035：量具本身也是被测对象

- **状态**：已接受（M4.5）
- **日期**：2026-09-17
- **相关**：M4.5 计划书 §4 / §33 / §38 / §39 / §41 S10；INV-M45-06；STOP-07
- **代码**：`src/kernel/action/audit-invariants.ts`、
  `scripts/verify-m4.5-measurement.ts`

---

## 背景

M4.1 的验收里发现了两次**量具自身的错误**（不是被测系统的错误）：

| 量具 | 错法 | 后果 |
|---|---|---|
| `activeValues()`（第一版） | 取所有含 `=` 的行，把启动日志的 `hash=…` 收了进来 | 库没动，断言却红了（噪声在变） |
| `activeValues()`（第二版） | 函数名写着 active，实际用的是 `--memory-list`（**全部状态**） | 已经正确遗忘的记录仍被算成"当前有效"，幻影假红 |

两版的共同形状：

```text
函数名 / 意图说的是 A
代码实际量的是 B
而结果看起来"合理"，所以没人查
```

M4.5 的量具比 M4 更多（`action:list --status X`、smoke 的回复解析、
ledger 查询），因此这条风险只会变大。

---

## 决策

**每一个 Hard Gate 都必须同时证明"测量范围正确"与"测量结果正确"；
量具的正确性本身是门的一部分，而不是门的前提假设。**

### 1. 新增 L0（Measurement Validation）层

L0 不测系统，**只测量具**：

```text
播 fixture（success / failed / partial / cancelled / rejected 各一条）
  → 对每个 status 跑**生产 CLI** `action:list --status X`
  → 断言输出**恰好等于**该状态的集合（逐 id 比对）
  → 断言不过滤时的集合严格大于任一单态集合
  → 负向控制：未知 status / 拼错 flag 必须非零退出或空，不得静默返回全部
```

第三条是防"过滤恒空 / 恒全"这种最隐蔽的错法：
如果过滤器永远返回空集，"恰好等于 success 集合"在 success 为空时也会绿。

### 2. 状态过滤**只有一处实现**

`--status` 的过滤发生在 `action-ledger-store.ts` 的 **SQL where 子句**里，
不是读回来再在 JS 里 `filter`。CLI、`action:audit`、测试脚本全部走同一个
`listRecent({ status })`。

理由：M4.1 的量具错误正是"另写一份过滤逻辑"造成的（脚本自己解析 CLI 文本）。

### 3. audit invariants 由 CLI 与门**共用一份实现**

```ts
checkActionAuditInvariants(records) → violations[]
```

`pnpm action:audit` 与 `m4.5:verify` / L4 都调用它。
如果门与 CLI 各写一份，"审计说没问题"就只说明其中一份的没问题。

### 4. Positive Control + Negative Control 同时存在

```text
Positive Control —— 该成功的真的成功（合法写 → 文件真的出现）
Negative Control —— 不该执行的真的没有执行（越界 → 目录快照/调用计数零变化）
```

只测"不该写的时候不写"会被"什么都不做"骗过（计划书 §39）。
只测"该写的时候写了"则拦不住越权。两者必须同时存在。

### 5. 真实链路优先级高于离线结论

`STOP-10`：Live Smoke 与离线结果冲突时，**以真实链路为准**，
先查量具与系统。禁止用"离线很多测试通过"否定冒烟。

### 6. 冒烟自己也用量具，因此冒烟的量具要单独自测

Live Smoke 解析 `--action-list` 的输出、解析回复文本。
这两段解析在 L0 里用混合 fixture 单独验证（含"回复里出现
'没有完成'但包含'完成'二字"这类边界），避免冒烟把一个
解析错误报成系统错误。

---

## 被否决的备选方案

### 方案 A：量具正确性靠代码评审

**否决理由**：M4.1 的两版错误都通过了评审，因为它们"看起来合理"。
只有断言能发现它们。

### 方案 B：让门直接查数据库，绕过 CLI

**否决理由**：那会让 CLI（用户真正用的那个入口）**从未被验证**。
计划书 §50 的证据优先级要求 Level 1（真实外部结果），
而用户面对的真实入口就是 CLI。

### 方案 C：只做 Negative Control

**否决理由**：计划书 §39 已明确 —— 只测"不该写的时候不写"，
系统可以通过"什么都不做"骗过测试。

---

## 后果

### 正面

- "测试测错了东西"这一类问题会在 L0 就被抓住，而不是在验收报告里。
- 过滤器只有一份实现，因此不会有"两个数字都合理但不一致"。
- 正负双控让"什么都没做"与"做对了"无法互相伪装。

### 代价

- 多一道门、多一份 fixture 播种脚本，运行时间增加。
  这是 M4.1 用两次幻影红换来的，值得。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 五态过滤逐 id 精确 | `m4.5:measurement:verify` |
| 不过滤集合严格更大 | `m4.5:measurement:verify` |
| 未知 status 不静默返回全部 | `m4.5:measurement:verify` 负向控制 |
| CLI 与门共用 `checkActionAuditInvariants` | `m4.5:test`「单一实现」静态断言 |
| 正负双控同时存在 | `m4.5:verify`（阳性 + 阴性都用例） |
| 冒烟解析器自测 | `m4.5:measurement:verify` 边界用例 |
