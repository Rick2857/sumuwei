# ADR-006：第三方依赖 Gate（含 Promptfoo 的定位）

- **状态**：已采纳（M2.5）
- **日期**：2026-09-16
- **相关**：[invariants.md](../architecture/invariants.md) 派生规则、`scripts/build-promptfoo-config.ts`

## 背景

M2.5 之前调研过一批第三方项目：ElizaOS、MemOS、Graphiti、Honcho、LangMem、
Generative Agents、XState、Promptfoo、Phoenix / Langfuse。

它们都有价值，但**没有一个应该成为架构中心**。
风险是具体的：领域模型还没理顺就引入 Memory Framework，
只会"把错误保存得更漂亮"。

## 决策

### 1. 边界：谁在里、谁在外

| 项目 | 定位 | 在不在 Character Domain 里 |
|---|---|---|
| **ElizaOS** | Agent Runtime | ❌ 只在 `infrastructure/runtime/` 与 `main.ts` |
| **Phoenix** | 默认遥测后端 | ❌ 只在 `infrastructure/telemetry/`（ADR-005） |
| **Promptfoo** | 外层回归 Runner | ❌ 只在 `evals/promptfoo/`，**不 import 业务代码** |
| MemOS | Lv1 后期 Memory Backend 对照实验，非必选 | ❌ 连接口都只是占位 |
| Graphiti | 未来 temporal memory 查询复杂时再考虑作索引 | ❌ 不接入 |
| Honcho | 借 Perspective / Belief 建模**思想** | ❌ 不依赖 |
| LangMem | 借后台 consolidation 思想 | ❌ 只借 Fast/Slow Path 的通用结构 |
| Generative Agents | 借 importance / reflection trigger 思路 | ❌ 不依赖 |
| XState | 只有真正离散的生命周期才使用 | ❌ 不用 |

### 2. 新增任何大型依赖必须填写依赖提案

```
解决什么具体问题？
对应哪个内部接口？
目前 baseline 是什么？
引入后指标改善多少？
增加哪些运行复杂度？
删除它以后系统还能否运行？      ← 最关键的一条
许可证是否兼容？
```

"删除它以后系统还能否运行"这一条之所以最关键：
如果答案是"不能"，那它就不是依赖，而是**架构中心**——
引入它等于把架构决策权交给别人。

### 3. M2.5–M5 不把 MemOS / Graphiti 作为硬要求

先让自己的领域模型正确：

```
MemoryBackend / Event / Projection / Context Compiler
```

如果这些设计正确，以后想换底层很容易；
如果领域模型本身错了，用再先进的 Memory Framework 也只是把错误保存得更漂亮。

## 逐个决定：Promptfoo

**问题**：需要"行为层回归"，而已有的 `scripts/run-tests.ts`（788 行集成测试）
适合验收"她答得像不像"，不适合承载结构化的场景断言。

**决策**：Promptfoo 作为**外层 Runner**，不进入 Character Domain。

关键在于**依赖方向**：

```
evals/scenarios/*.ts            ← Canonical 定义（唯一真相，手写，进 git）
        │
        ├──► scripts/eval-scenarios.ts       内部 runner（人看）
        │
        └──► scripts/scenario-json.ts        机读（单行 JSON）
                    │
                    └──► evals/promptfoo/provider.cjs   Promptfoo 的 exec 桥
                              │
                              └──► evals/promptfoo/promptfooconfig.yaml（生成物）
```

三条硬规则：

1. **Promptfoo 的 YAML 里没有任何测试数据**：它由
   `scripts/build-promptfoo-config.ts` 从 `evals/scenarios` 生成，
   顶部写着"请勿手工编辑"。
2. **Provider 不实现任何角色逻辑**：它只是调用
   `scripts/scenario-json.ts`（而那支脚本读的是 canonical 定义）。
3. **换掉 Promptfoo 不丢任何场景**：场景定义在内部，且被
   `kernel-tests` 的"场景清单锁定"用例守着（id 列表与顺序都被断言）。

### 为什么 provider 用子进程而不是直接 import

Promptfoo 是 CommonJS 加载 provider 文件的，而项目是 ESM + `.ts`。
走 `spawnSync(tsx, ...)` 最稳，而且**顺便解决了数据库隔离问题**：

`@elizaos/plugin-sql` 把 PGlite 客户端缓存在 `globalThis` 上的
**进程级单例**里，同进程内无法真正隔离两个库（见 ADR-001 与
`sandbox.ts` 的注释）。每个场景一个进程 = 天然的隔离。

## 被否决的方案

### 方案 A：只用内部 harness，不引入 Promptfoo

**否决理由**：内部 harness 的定位是**结构性**断言（序号、幂等、可重放）。
它有一个弱点：**报告是纯文本**，不适合长期跟踪
"这 20 个场景在过去 30 次提交里通过率怎么变的"。
Promptfoo 提供的正是这一层（结构化结果、UI、跨运行对比）。

### 方案 B：把场景直接写成 Promptfoo YAML

**否决理由**：这正是 plan 第 54/87 节点名禁止的做法。
场景一旦写进某个外部工具的配置文件，"场景是什么"就变成了
那个工具的格式问题——换工具就得重写，
而且场景无法被单元测试覆盖（YAML 不是代码）。

### 方案 C：用 Promptfoo 的 `http` provider 调一个本地 HTTP 服务

**否决理由**：那需要为评测单独起一个常驻服务，
M2.5 的规模（7 个场景）不值得。而且它会引入"评测时的执行路径
与生产路径不同"的风险——现在两者走的是**同一份**场景定义
与**同一条** TurnGateway。

### 方案 D：同时引入 Langfuse（观测）+ Promptfoo（评测）

**否决理由**：plan 第 50 节要求观测后端二选一。
评测与观测是两件事，但"同时维护两套外部平台"在这个阶段
是不必要的运行复杂度。

## 后果

**正面**
- `src/kernel/**` 里没有任何第三方 Agent 框架的概念
  （由静态测试守着）。
- 换 Promptfoo / 换 Phoenix 都不动业务代码。
- 两套 runner 共享同一份场景定义，因此不存在"评测通过但生产不符合"的漂移。

**负面 / 成本**
- Promptfoo 是一个体积不小的 devDependency（含若干原生依赖）。
  它有 `ERR_PNPM_IGNORED_BUILDS` 警告（`onnxruntime-node` / `sharp` 等
  构建脚本被 pnpm 拦截）。实测 **CLI 与本次用到的 eval 路径完全正常**，
  被拦截的都是嵌入式模型 / 图片处理相关的能力，本用例不使用。
- 多了一个生成步骤（`pnpm eval:promptfoo:build`）。已做成
  `pnpm eval:promptfoo` 的一条命令自动完成，避免"忘了重新生成"。

## 复核时点

当以下任一情况出现时，重新评估本 ADR：

1. 场景数量超过 30 个（内部 harness 的报告能力可能不够）。
2. 需要"跨运行对比通过率"（Promptfoo 的 Datasets / Experiments）。
3. M4 真的需要 temporal memory 查询（届时评估 Graphiti 是否真能解决
   一个**实测**问题，而不是"看起来更专业"）。
