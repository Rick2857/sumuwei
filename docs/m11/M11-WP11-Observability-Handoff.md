# M11 WP11 前置：可观测性与隐私门（`m11:observability:verify`）

- 日期：2026-10-01
- 状态：**COMPLETE** —— 具名门 `m11:observability:verify` 已建并 **PASS 18/18**（零模型调用）
- 门：**PASS 18/18**（零模型调用、零出网、一次性沙箱库）
- 计划归属：§12.1 命令表 `m11:observability:verify` —— 「query / trace / 隐私 · **理由码生产者** · **遮蔽** · **正文泄漏负控**」
- 权威代证据：`artifacts/m11/m11-wp11-observability-20261001-41b6bba7c75e-d031/`（18/18）
  过程档：`…a8d14205525a-db2a`（18/18，脚本未提交）· `…a8d14205525a-aa48`（16/18：判据的路径解析与登记表形状 ⇒ 已修）

---

## 1. 本轮补上的一个**真缺口**：审查理由码没有闭集

```text
现象：`reviewReflection()` 里是 `const reasons: string[] = []` + `reasons.push('duplicate_review')`
      —— "有哪些理由码"只能靠**读代码**。
而 ADR-085 §6.2 与计划 §12.1 要求「**理由码的闭集 + 每个码的可达性事实**」。
⇒ 补法（两件，缺一不可）：
   ① 登记 `REFLECTION_REVIEW_REASONS`（8 个码）+ `REFLECTION_REVIEW_REASON_FACTS`
      （`reachable` / `producer` / `howToReach`）；
   ② **把类型收紧到闭集**：`const reasons: ReflectionReviewReason[]`
      ⇒ 再想推一个闭集外的码就是**编译错误**（这才是闭集存在的意义，而不是文档里的一句话）。
```

## 2. 门的四组（18 条）

```text
A 理由码生产者 8：
  草案拒绝码闭集完整 · 可达性事实齐全 · **producer 点名的源文件真的含这个码**（不漂移）·
  派生链拒绝码各有 producedBy · 六类触发各有 v1Detectable（含"本版检测不到"那一档）·
  审查理由码闭集完整 · **机器扫描 `reviewReflection()` 函数体**里真的推的码全在闭集内 ·
  审查理由码 producer 可达
B 遮蔽 4：开发者面遮蔽支无正文（撤回 / 根被忘两种）· **正控**（未遮蔽时 canary 确实出现）·
  **读不到 ≠ 遮蔽**
C 正文泄漏负控 4：事实包无正文 · 上下文 section 只有程序模板且无内部 id ·
  **trace 属性键闭集**（新增键必须显式登记，否则正文会悄悄进 trace）· trace 无自由文本形态
S 2：三组非零 · **canary 自检**（canary 在该出现的地方确实出现）
```

### 2.1 ⚠️ A7 的扫描边界（如实说明）

```text
A7 只抓 `reasons.push('字面量')` 形态（实测抓到 1 条：`duplicate_review`）。
其余路径（`verdict.reason` / `stability.reason`）走的是**变量**，扫描抓不到 ——
它们由 **② 的类型收紧**兜住（编译期保证）。
⇒ 两层合起来才等于"闭集真的成立"；只报 A7 会高估覆盖。
```

### 2.2 判据自身修了两处（**不是**产品缺陷）

```text
① 路径解析：登记表里写裸文件名（`reflection-validator.ts`）是正常写法，
   而第一版只按"相对 src/ 的路径"找 ⇒ 判成"文件不存在"。
   修法：先直查、再在 `src/` 下**按文件名递归找**（有深度上限）。
② 登记表形状：草案拒绝码的 `producer` 只写了函数名（`validateReflectionDraft · …`），
   没有文件名 ⇒ 机器无法核。修法：补上 `reflection.ts · …`（7 行，逐行脚本改，不用宽松正则）。
```

---

## 3. 还没做的（WP10/WP11 剩余）

```text
WP10：§11.3 三档消融（OFF / proposal-only / adaptive）· `m11:long:live`（200 轮真模型长链）
      · `m11:review:materials`（盲审卡片 ≥32 张）
WP11：`m11:regression:verify` · `m11:docs:verify` · `m11:gates`（只读聚合，三个 lane）
WP12：`m11:activation:verify` / `m11:activation:readback`（需独立授权）
```

---

## 4. 受影响旧门的回归读数

```text
kernel:test EXIT 0 · kernel:verify EXIT 0 · m4:test 258/0 · m4:verify 142/0 ·
m4.5:test EXIT 0 · m5:test EXIT 0 · m10:context:verify 26/26 · m10:m11:verify 11/11
m11 门：lineage 34/34 · inputs 43/43 · policy 25/25 · adaptive 22/22 · invalidation 18/18 ·
       recovery 17/17 · context 31/31 · measurement 24/24 · e2e 12/12 · long 12/12 ·
       **observability 18/18**
⚠️ `m5:budget:verify` 仍红（`L-M11-13`，pre-WP8 实测复现 ⇒ 归 M5/M9.5 线）。
```
