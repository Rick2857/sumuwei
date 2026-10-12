# M11 WP4 交接单

- 日期：2026-10-01
- 工作包：WP4（Reflection 审查与独立生命周期）
- 状态：**COMPLETE** —— 事件族 + 域放行口 + 纯 reducer + 存取层四件全部落地；
  门 `m11:policy:verify` = **PASS 25/25**（零模型调用）
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D03` / `D08` / `D11` / `D26` / `D28` / §4.3
- 证据（两代，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp4-20261001-b75a72641700-d5a7/`（**25/25**，head = 实现提交）
  - `artifacts/m11/m11-wp4-20261001-91cd3f5a68c5-2d84/`（25/25，脚本未提交）·
    `…-d762`（22/24，**两处真缺陷** ⇒ 见 §3）
- 本轮**没有**：打开真实库（`isolateDatabase()` 一次性沙箱）· 调模型（`modelCalls: 0`）· 出网 · 改 DDL

---

## 1. 交付的代码

| 文件 | 内容 |
|---|---|
| [`contracts/reflection-events.ts`](../../src/kernel/contracts/reflection-events.ts) | 5 个事件常量 + payload 形状 + 校验器（抛**普通 `Error`**）· **合法边真值表**（`rejected`/`retracted` **不许翻案**）· 折叠后的记录形状 |
| [`contracts/domain-event.ts`](../../src/kernel/contracts/domain-event.ts) | `createReflectionDomainEventRegistry()` + **接入** `createFullDomainEventRegistry()`（WP2「只登记」→ WP4「接线」） |
| [`projections/reflection.ts`](../../src/kernel/projections/reflection.ts) | 纯折叠 `reflection-fold@1` · 前缀 `reflection:<id>` · **非法边不折叠、也不抛** |
| [`policies/reflection-validator.ts`](../../src/kernel/policies/reflection-validator.ts) | `reviewReflection()`（门槛/冲突/来源/重复四族，纯函数）· `reviewTransitionAllowed()` · **域放行口 `validateReflectionProposal()`** |
| [`persistence/reflection-store.ts`](../../src/infrastructure/persistence/reflection-store.ts) | 本域**唯一**写路径（恰好两个导出：apply / rebuild）+ 三个读函数（**读面里没有写原语**） |

### 1.1 两条防线的分工（不是重复）

```text
放行口（validateReflectionProposal）  ← 拒收"夹带采纳"：payload 说 accepted 而策略判 rejected
                                        ⇒ `not_fact_authority`
折叠层（foldReflectionRows）          ← 拒收"非法边"：rejected/retracted 之后的 accepted **不折叠**
```

两条各自有负控（B13 / B11+B12）——只测一条就不知道另一条是否也在工作。

---

## 2. 门（`m11:policy:verify` = **PASS 25/25**）

```text
A 正控 5：PROPOSED ⇒ **pending**（候选≠采纳）· ORIGIN 不建记录行 · 三根两会话 ⇒ accepted
          且状态真的翻转 · 采纳记录里的根是**程序解析**的那些 · 生命周期两个事件 id 都在
B 负控 13：threshold_not_met · single_root_only · single_session_only · conflicting_support ·
          source_forgotten · source_version_changed · duplicate_review ·
          **模型自称置信度 99% 不改判定**（行为）· 放行口无"模型自评"字段（结构）·
          rejected/retracted→accepted 非法 · 折叠层拒非法边 · 失效是终态 · 夹带采纳被放行口拒
C 回放 2：全量重建与重建前**逐字段一致** · 重建不产生额外事件
D 结构 3：读面无写原语 · 放行口是纯的 · accepted **不得**带理由码
S 量具自检 2：四组非零 + 拒收理由覆盖四族；五条事件类型用到四条（第五条归 WP5）
```

---

## 3. ⚠️ 本门抓出的**两个真缺陷**（都已修）

### 3.1 缺陷一：同一窗口的两条反思会**塌成一条**（`D26` 的落点）

```text
第一版门用**通用**放行口（`createDomainPolicyValidator`）发两条 `REFLECTION_PROPOSED`
（同一个窗口、同一个 processor 版本、同一个 operation）⇒ 幂等键**完全相同**
⇒ 第二条被**静默去重** ⇒ 两条不同的反思只剩一条。
实测：B11 的 `refl:B` 记录根本不存在（`undefined → undefined`）。
```

⇒ 这正是 ADR `D26`（"反思的事件身份**不依赖内容去重**"）要求的东西，也是 M10 的 `D26` 教训
（"兑现补记必须自带确定性事件身份"）在 M11 的重演。修法：新增**域放行口**
`validateReflectionProposal()`，用 `reflectionUnitOperationOf()` 把 `reflectionId`（以及
decision / causeEventId / slot+revision）编进单元操作串（先例 `goalUnitOperationOf()`）。

### 3.2 缺陷二：结构判据**作用域切错**（第三次同类）

```text
第一版 D1 从 `listReflectionRows` 切到**文件末尾** ⇒ 把后面的
`rebuildReflectionProjections`（它**本来就应该**有写原语）一起扫进来 ⇒ 永远判 ❌。
修法：按**函数体**逐个切片（`functionBodyOf`），只扫三个读函数。
```

⚠️ WP0 的判据三次修订 + WP4 这一次，**没有一次是"门太严"**，四次都是"门量错了对象"。
这条经验继续写在交接单里（WP0 §4③）。

---

## 4. 下一轮（WP5：有限 Adaptive Self）

```text
三个固定槽位 + 纯策略规划/折叠 + 自己的写入入口
· baseline/enhanced 状态、scope、revision、根/反思关联、采纳/撤回原因
· `ADAPTIVE_SELF_REVISED` 接线（事件形状已在 WP4 登记并接入 registry）
· 禁止自由文本提升为指令（`D32`）
· 门 `m11:adaptive:verify`：至少一个合法轨迹发生真实变化；
  重复根 / 单次反馈 / 冲突 / 越界人格改动**不能**增强；关闭 flag 不调整
```

---

## 5. 受影响旧门的回归读数

```text
kernel:test (scripts/kernel-tests.ts)          EXIT 0
kernel:verify (scripts/verify-phase-c.ts)      EXIT 0
m4:test (scripts/kernel-tests-memory.ts)       EXIT 0（258 通过 / 0 失败）
m4:verify (scripts/verify-m4-persistence.ts)   EXIT 0（142 通过 / 0 失败）
m3.5:verify (scripts/verify-m3.5-persistence.ts) EXIT 0
m11:lineage:verify                             PASS 34/34
m11:inputs:verify                              PASS 39/39
m11:policy:verify                              PASS 25/25
```

⚠️ 这是**受影响门**读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。
