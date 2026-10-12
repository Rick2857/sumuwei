# ADR-031：能力必须登记，且与角色内核分离

- **状态**：已接受（M4.5）
- **日期**：2026-09-17
- **相关**：M4.5 计划书 §11 / §12 / §14 / §44；INV-M45-02
- **代码**：`src/kernel/action/capability-registry.ts`、
  `src/infrastructure/action/adapters/*`

---

## 背景

M2.5 起，这个项目反复守同一条边界：**人格决定她怎么想、怎么说，
不决定系统有什么权限**（ADR-001 / ADR-015 / ADR-016 / ADR-017）。

M4.5 第一次让系统真的动世界，于是这条边界必须落到具体形状上：

```text
Character Kernel  ──►  她说想做什么
Capability Layer  ──►  系统允许/能够做什么
```

如果能力注册表住在角色定义里（例如写在 `苏沐薇.ts` 的 plugins 列表，
或者由某个插件在启动时"自己加一个隐形工具"），就会出现：

```text
改一次人格  →  她的权限变了
装一个插件  →  多了一个没人审计的能力
```

---

## 决策

### 1. 能力是一份**声明**，不是一段代码

```ts
interface CapabilityDefinition {
  id: string                    // 'sandbox.file.write'
  version: string
  description: string
  operations: OperationDefinition[]
  sideEffectLevel: 'none' | 'read' | 'write' | 'destructive'
  permissions: string[]         // 'sandbox:write'
  supportsDryRun: boolean
  idempotency: 'none' | 'supported' | 'required'
}
```

`CapabilityRegistry` 是**唯一的登记处**。Gateway 在开始时查表，
查不到就是 `capability_not_registered` —— **不是"以默认权限执行"**。

登记本身也要过校验（重复 id、未声明的 operation、
`destructive` 却声明 `idempotency: 'none'`、空 permissions 一律拒绝）：
登记口是"能力存在"的唯一来源，它不能接受一份自相矛盾的声明。

### 2. 能力层住在 `kernel/action` + `infrastructure/action`，**不住在角色里**

| 层 | 住哪 | 为什么 |
|---|---|---|
| 协议 / 登记 / 策略 / 编排 | `src/kernel/action/` | 纯逻辑，可离线穷举 |
| 适配器（真实 IO） | `src/infrastructure/action/adapters/` | 与 MI-13 一致：`kernel` 不许 import `infrastructure` |

⚠️ 这一点与 M4.5 计划书 §43 的示例目录**不同**。§43 写的是
`src/kernel/action/adapters/`，但适配器要 `node:fs`，那会打破
MI-13 / ADR-001 已经建立的边界（内存侧就是
`kernel/app/memory/*` + `infrastructure/persistence/memory-store.ts`）。
§43 的用词是"例如"，因此按边界拆分，**不是**范围变更。

### 3. 首批只登记三个能力，且风险等级是硬编码的事实

```text
system.echo             R0  sideEffect=none   idempotency=none
sandbox.file.read       R0  sideEffect=read   idempotency=none
sandbox.file.write      R1  sideEffect=write  idempotency=supported
```

M4.5 **只运行 R0/R1 且只在沙箱根内**。R2/R3 的等级定义现在就写进
`policy.ts`（这样以后能力登记时"忘了想风险"不可能发生），
但没有任何 R2/R3 能力被登记 —— 因此它们**无法被执行**，
而不是"执行了但被拒绝"。

### 4. 角色内核不得知道能力的实现

角色定义文件（`src/character/苏沐薇.ts`）**一个字节都不因 M4.5 而改变**。
她"能做什么"由对话里出现的请求 + 系统策略决定，不由她的 Seed 决定。
这条有一条回归锁：`m4.5:test` 断言 `src/character/**` 的哈希不变。

---

## 被否决的备选方案

### 方案 A：能力写进角色定义的 plugins 列表

**否决理由**：那等于"改人格就改权限"。而且 ElizaOS 的 plugin 机制
是**提供行为**的，不是**提供权限**的 —— 两者混在一起之后，
"她为什么能做这件事"会变成"因为她的 plugin 里有它"。

### 方案 B：默认允许未登记能力（fail-open）

**否决理由**：与 M4 的 fail-closed 完全不同调。一个漏登记的能力
在 fail-open 下**会带着默认权限上线**，而"默认权限"正是没人想过的那种。

### 方案 C：把沙箱根写死在适配器里

**否决理由**：测试（尤其是 Live Smoke）必须能把沙箱指到临时目录，
否则冒烟要么污染真实沙箱、要么不能并行。
因此根目录是配置（`ACTION_SANDBOX_ROOT`），
**但"必须在某个根之内"这条约束是不可配置的**。

---

## 后果

### 正面

- "系统有什么能力"可以在一个文件里读完（`capability-registry.ts` 的默认登记）。
- 新增能力不触碰 Character Kernel、Memory Kernel 与 Action Protocol
  （计划书 §14 的目标）。
- 未登记能力在**编排的第一步**就被拒，连目标解析都不会发生。

### 代价

- 每个能力要维护三处（声明 / 策略可判 / 适配器）。
- 登记表是手工的，因此"忘记登记"= "能力不存在"。
  这是**安全方向的失败**，因此接受。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 未登记 → `capability_not_registered`，且适配器未被调用 | `m4.5:test` + `m4.5:verify` |
| 声明自相矛盾被登记口拒绝 | `m4.5:test`「registry 负向」 |
| `src/character/**` 哈希不变 | `m4.5:test`「角色内核未被触碰」 |
| `src/kernel/action/**` 不 import `infrastructure` | `m4.5:test`「内核边界」静态扫描 |
| 没有任何 R2/R3 能力被登记 | `m4.5:test`「首批能力等级」 |
