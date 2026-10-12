# ADR-M4-MemOS：MemOS 在 M4 的最终结论（PoC 收口）

- **状态**：**已接受**（结论 = **REJECT**，不用于本工程生产架构）
- **日期**：2026-09-17
- **相关**：`docs/adr/ADR-027-memos-adapter-gate.md`（判据清单）、
  `docs/m4/memos-poc.md`（实测证据）、计划书第 94 – 103 / 138 – 142 / 198 / 215 节、
  ADR-026、MI-13
- **代码**：**不新增**（结论为不采用，因此不实现 `MemOSMemoryStoreAdapter`）

> 这份 ADR 只做一件事：把 ADR-027 的**判据**变成**结论**。
> 判据本体仍留在 ADR-027，避免同一份契约出现两个真源。

---

## 背景

计划书第 216 节把 "MemOS Lifecycle PoC 完成并有正式结论" 列为
GitHub Integration 的 Exit Criterion。ADR-027 在 2026-09-16 定下了
10 条判据（其中第 7、10 条为**否决项**），状态标为"提议" ——
因为把判据写成结论正是本项目反复防的错误。

M4 验收阶段执行了 **Phase 11 的静态 PoC**：在不安装、不启用、不使用凭证的
前提下，读 `@memtensor/memos-cloud-dsh-plugin@0.1.1` 的随包代码与文档，
逐条裁决 ADR-027 §101 的 10 条判据。完整证据见 `docs/m4/memos-poc.md`。

## 决策

**REJECT —— MemOS（`@memtensor/memos-cloud-dsh-plugin@0.1.1`）
不用于本工程的生产架构。**

## 理由

**单一决定性判据：Q7（不得绕过调用方的 Memory Policy）不满足。**

该包不是"调用方决定写什么"的记忆后端，而是一个**默认接管每一轮记忆行为**的
生命周期 bundle：

- 无条件订阅 `agent/pre-step`（`prepend: true`）与 `session/event`（`lib/index.js:1073-1074`）
- recall 自动注入到本次发送的消息列表（`1024-1027`）
- 每轮结束自动 capture 上报，**没有逐条的调用方决定**（`1043-1072`）
- `recallEnabled / addEnabled / includeAssistant` 默认全为 `true`（`774-776`）
- **没有注册任何调用方可调用的写入 API**（导出仅 `settings.register` + 两个 `ctx.on` + `ctx.effect`）

这与 MI-02 / ADR-029（她自己生成的话不能自动升级成事实）
以及 ADR-027 §96 的禁止项**直接冲突**，且**不能通过配置恢复**逐条权威
（只有全局开关 + 静态 info/tags）。

次要缺口（均为代码层面事实、非凭证问题，且不可配置弥补）：
Q1 无调用方 `MemoryId`；Q3 无 supersede；Q4 无"保留历史的 retract"；
Q5 无历史版本查询；Q9 无导出路径。另外默认会把 assistant 文本上传到第三方云。

**范围诚实性**：本结论由**代码与文档**判定，不是运行期行为。
未被评估的三项（MemOS 内部是否保留旧版本、`messages[].id` 是否能反查、
后端删除软/硬）标为 `UNKNOWN-WITHOUT-CREDENTIALS` ——
**它们不是失败证据**，且都不改变 Q7。

## 后果

### 现在

- M4 **不引入**任何 MemOS 依赖；`package.json` 不含 memos 条目。
- 长期记忆继续由原生 `NativeMemoryStore` 承担（ADR-026 的决策 1 维持不变）。
- 计划书第 216 节的 "MemOS Lifecycle PoC 完成并有正式结论" **已满足**
  （第 102 节明确：关键项不满足 → `rejected for production`，
  项目继续 Native 后端，完全没有问题）。
- **`m4:restore:verify` 把"移除外部后端仍能恢复权威记忆"从一句话变成了机械证据**：
  Native 真源（账本 + `MEMORY_*` 领域事件）可以在全新库上独立恢复，
  且 CanonicalSemanticSnapshot 哈希一致（24/24，含两条负控）。
  这正是 Q10 想要的保证，且它不依赖任何外部后端。

### 将来（M5 Gate B / 重开研究）

若仍要评估 MemOS 或同类外部后端，前置条件至少是：

1. 独立 DSH profile（ADR-027 的非可选项）；
2. 云凭证；
3. **一个把 recall 注入与自动 capture 都关闭、只用其 `add`/`search` 的窄 Adapter** ——
   当前包**不提供**这个形状；需要先与上游确认或自行 fork。

在满足第 3 条之前，任何"装上去试试"的实验都会**打开污染通道**，
而不是"评估一下"。

### 借鉴（正当结论，与是否采用代码无关）

MemOS 强调的 memory lifecycle、异步 ingestion、feedback/correction、
可组合 memory containers 在**设计上**值得参考（计划书第 196 节）。
本次把"借鉴"与"采用"分开记录，避免让"研究过了"被读成"采用了"。

## 怎么验证这条决策仍然成立

| 检查 | 由谁守 |
|---|---|
| Domain 侧不 import MemOS | `pnpm kernel:test`（内核边界） |
| 主工程没有 memos 依赖 | `package.json` 无 memos 条目；`git grep -i memos -- package.json` 为空 |
| 真源仍在账本，且可独立恢复 | `pnpm m4:restore:verify`（24 项） |
| 自动 capture 不会偷偷进来 | 本 ADR + `docs/m4/memos-poc.md` 的 Q7 证据；升级 DSH/插件后必须重做静态检查 |
| 结论是三选一之一且附证据 | 本文的状态字段 + `docs/m4/memos-poc.md` |
