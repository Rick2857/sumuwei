# ADR-041：沙箱执行器边界（Sandbox as Executor Provider）

- 状态：**已采纳**（M5.1 WP6，2026-09-17）
- 里程碑：M5.1（OSS Integration Audit）
- 相关：ADR-030（唯一执行入口）、ADR-031（能力登记）、ADR-032（目标确定性先于副作用）、
  ADR-033（执行真相）、`docs/m4.5/M4.5-Action-Protocol.md`、`docs/m5.1/M5.1-OSS-Audit.md` §5
- 裁定：**沙箱作为 Executor Provider = REFERENCE** ·
  **沙箱持有领域 Authority = REJECT** · **M5.1 内接入 = REJECT**

---

## 1. 背景与实测

"沙箱"在计划书里没有点名具体项目，因此这一条是**类别级审计**
（容器 / microVM / 进程级隔离都可以当执行后端）。仓库实测的现状：

| 事实 | 位置 / 形状 |
|---|---|
| 今天的沙箱 | `infrastructure/action/adapters/sandbox-filesystem.ts`（`createSandboxReadAdapter` / `createSandboxWriteAdapter` / `listSandboxEntries`）—— 一个**本机目录** |
| 适配器收到什么 | `AdapterExecuteInput = { actionId, operation, target（**已解析且已判定为确定**）, args, now }` |
| 谁做目标解析 | 装配层注入的 `resolveTarget`（`main.ts`），**不是**适配器（ADR-032） |
| 谁做判定 | `kernel/action/policy.ts` + `CapabilityRegistry` 的权限/风险声明（ADR-031） |
| 幂等 | 键由"能力 + 操作 + 已解析目标 + 参数"推导；`required` 档缺键即拒绝 |
| 审计不变量 | `audit-invariants.ts` 的"有副作用必须有确定目标"用的是**能力声明**的 sideEffect，不是适配器自报的 effect |

---

## 2. 五项解释

### Landing Target
**替换 `CapabilityAdapter` 内部的执行方式**：
把"在本机目录读写"换成"在容器 / microVM 里读写"。
接口**不变**（`execute(input)`），因此它是**同一个端口下的另一个实现**。

### Authority Boundary（这一条最要紧，而且今天已经是结构性的）
| 能力 | 归属 | 依据 |
|---|---|---|
| 目标解析（"她指的是哪个文件"） | **我们**（装配层注入的 `resolveTarget`） | ADR-032 |
| 是否允许（权限 / 风险 / 副作用等级） | **我们**（`policy.ts` + 登记表） | ADR-031 |
| 执行结果（成功 / 失败 / 部分 / 超时） | **我们**（`ActionResult` + 账本） | ADR-033 |
| 实际怎么做（在哪个隔离环境里落盘） | **沙箱** | 本条 |

关键结构事实：**适配器拿到的 `target` 已经解析好了**。
也就是说"不许沙箱自己解析目标"这件事在**类型层面**就成立 ——
它没有拿到原始请求文本，也没有拿到候选列表。

⚠️ 反例（必须点名）：**沙箱说"这个路径在我这儿可以写"不是策略判定**。
它是**环境事实**；策略判定仍然发生在 `policy.ts`，
而"目标是否越出沙箱范围"由 `resolveTarget` 判定并记进账本（`scopeViolation`）。

### Replacement Strategy
替换成本分三层：
- **接口层**：**零**（`CapabilityAdapter` 只有 1 个方法）；
- **语义层**：`effect` 的 shape 要如实（`file_created` / `file_overwritten` / `no_change`…），
  因为"有副作用必须有确定目标"这条审计不变量看的是**能力声明**，而 effect 决定
  回复措辞与证据（`ActionEvidence`）；
- **运维层**：沙箱根目录的**位置**会变 → `resolveTarget` 的配置要跟着变，
  而它是装配层的职责（`main.ts`），不是适配器的。

### Failure Isolation
- 沙箱不可用 → 该能力的操作回 `execution_failed`（受控码），
  **不影响**其它能力，也不影响本轮对话（回复层只认 `ActionResult`）；
- 沙箱部分成功（3 个文件成功 2 个）→ 必须回 `partial` + `progress`，
  **不许**合并成 success（§28 的纪律，M4.5 有专门的能力样例 `test.partial.write`）；
- 沙箱拒绝（越界）→ 必须在**执行之前**就断（`scopeViolation` 通路），
  而不是"先写了再报错"；
- 沙箱返回的原始错误 → 必须**归一**到受控失败码（`normalizeAdapterError`），
  账本里不允许出现原始错误字符串。

### Future Milestone
**未来里程碑**（M5.1 的 Scope Fence 不含新执行后端）。准入判据：
1. 只替换适配器：`CapabilityAdapter` 的 1 个方法不变；
2. **不许**把目标解析搬进沙箱（判据：适配器签名里没有原始请求文本）；
3. 需要一次真实 spike：在沙箱里跑 `sandbox.file.write`，
   判据是**账本里真的有 `ACTION_SUCCEEDED` + effect 指纹变化**，
   而不是"沙箱返回 200"；
4. 沙箱的隔离失败**不得**污染宿主 —— 这条要写进 spike 的负控
   （例如故意写越界路径，必须被拒且宿主目录无变化）。

---

## 3. 备选与否决理由

| 备选 | 否决理由 |
|---|---|
| 让沙箱自己解析目标（例如给它原始文本让它猜文件） | 违反 ADR-032；且"不确定就不做"这条纪律会在最危险的一层失效 |
| 让沙箱决定"允不允许" | 违反 ADR-031；权限必须由装配层显式授予 |
| 让沙箱的日志成为执行真相 | 违反 ADR-034；"她做过什么"只在 `character_action_events` |
| 把沙箱的 effect 自报当成审计判据 | `audit-invariants.ts` 已经刻意改用**能力声明**的 sideEffect（一个写能力只要返回 `no_change` 就能绕过目标确定性闸） |
| M5.1 内接入 | 引入容器/VM 依赖与网络；且不在本里程碑范围内 |

---

## 4. 后果

- 本轮**不动任何代码**；沙箱文件适配器仍是本机目录实现。
- 本条把"沙箱 = 纯执行后端"写成了**结构性的**（而不是纪律性的）边界：
  适配器签名里没有原始请求，因此它**没法**越权解析目标。
