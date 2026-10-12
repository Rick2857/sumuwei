# ADR-032：目标确定性先于副作用

- **状态**：已接受（M4.5）
- **日期**：2026-09-17
- **相关**：M4.5 计划书 §3 / §8 / §25 / §41 S4；INV-M45-03；STOP-02
- **代码**：`src/kernel/action/target-resolver.ts`、`src/kernel/action/policy.ts`

---

## 背景

M4 的 D1 是一次真实的错误副作用：

```text
用户：忘掉我养过一只鹦鹉这件事
系统：候选只有一条（示科那条）→ 那就删它 → 库被改了，而用户要忘的不是这件事
```

修复（M4.1）给出的结论写进了最高级不变量：

```text
Unique ≠ Relevant
No Target Certainty → No Mutation
```

M4.5 第一次让系统动**文件系统**。文件系统比记忆更危险：
删一个记忆可以重放事件重建，删一个文件不能。

---

## 决策

**任何具有副作用（write / delete / modify / send / execute / create /
cancel / publish / pay）的动作，都必须先解析出目标，并给出确定等级。
只有 `exact` 与 `strong` 允许副作用；`weak` / `none` 一律不执行。**

### 1. 目标是四种确定等级之一，且必须带证据

```ts
interface ActionTarget {
  type: string
  canonicalId?: string
  displayName?: string
  confidence: 'exact' | 'strong' | 'weak' | 'none'
  evidence?: TargetEvidence[]
}
```

### 2. 五步梯子（与 M4 的 target-resolver 同构）

```text
1. 请求里已带明确 canonicalId            → exact
2. 沙箱内精确相对路径存在                 → exact
3. 唯一 basename 命中，且用户词面出现在路径里 → strong
4. 多命中 / 词面证据不足                  → weak（带候选，但**不选**）
5. 无命中                                → none
```

**第 3 步的两个条件缺一不可**：唯一候选 + 词面相关性证据。

这正是 D1 的修复形状：`唯一` 本身不构成证据。
"report.txt 只有 a/ 下有一个" → 仍然 `weak`，除非用户说的词
真的出现在那条路径上。宁可不做，也不做错。

### 3. 目标解析发生在**任何 IO 之前**

`policy` 拿到的已经是解析结论；`adapter` 拿到的是已判定为
`exact` / `strong` 的路径。"候选只有一个所以就是它"这句话
在代码里**没有位置可以写**。

### 4. 越界不是"找不到"

用户说"读 `C:\Windows\win.ini`"时，正确的结果是
`permission_denied`（或 `target_out_of_scope`），**不是** `not_found`。

两者的区别是用户可见的：前者是"我不被允许"，后者是"它不存在"。
而且更重要的：越界判定必须发生在**触碰真实文件系统之前** ——
沙箱外的一次 `stat` 本身就是越界。

规则：绝对路径 / 盘符 / `..` / 符号链接逃逸 / NUL → 解析结果标记
`scope_violation` 证据，`confidence` 保持 `exact`（目标确实存在，
只是不许碰），策略据此给 `permission_denied`。

### 5. 无副作用的能力不受此约束

`system.echo`（sideEffect=none）可以在 `confidence=none` 下执行。
不变量约束的是**副作用**，不是"所有动作"。把它推广到只读能力
会让"S3 读不到文件"这种正常情况被过度拒绝。

---

## 被否决的备选方案

### 方案 A：只有副作用能力才需要目标解析

**否决理由**：读也需要目标（"读哪个文件"），只是**判定阈值不同**。
解析统一做，阈值由 `sideEffect` 决定 —— 这样以后加"读数据库"、
"读 HTTP" 不需要再造一层。

### 方案 B：唯一候选自动升级为 `strong`

**否决理由**：这就是 D1。M4 已经用一次错误副作用证明了它不安全。

### 方案 C：用模型判断目标相关性

**否决理由**：那是把"确定性"换成"概率性"。M4.5 的目标解析是
**纯函数 + 词面证据**，因此可以被离线穷举。
未来的语义判别器只能作为 `weak → strong` 的**补充证据**，
不能单独把 `weak` 提成 `strong`。

---

## 后果

### 正面

- "点错东西"这类错误在**结构上**被排除，而不是靠 prompt 请求模型小心。
- `ambiguous` 有明确含义：多条候选、都不够确定 → 回复必须说
  "不确定你指的是哪个"（ADR-033）。
- 越界与不存在可区分，用户能看到真实原因。

### 代价

- 覆盖面会偏保守：真实用户说"那个文件"时常常会得到 `ambiguous`。
  这是**如实的失败**，符合 M4.1 的「Coverage 不完美可以接受，
  False Success 不可接受」。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| `weak` / `none` 不得产生副作用 | `m4.5:test`「policy 全分支」+ `m4.5:verify` 阴性控制 |
| 唯一候选但无词面证据 → `weak` | `m4.5:test`「目标梯子 第 3 步」 |
| 越界 → `permission_denied` 且**未触碰**真实 FS | `m4.5:verify`（调用计数器 + 目录快照）+ L4 S5 |
| 多候选 → `ambiguous` 且文件内容哈希不变 | L3 L3-04/05 + L4 S4 |
| 只读能力不受阈值约束 | `m4.5:test`「echo 在 none 目标下仍可执行」 |
