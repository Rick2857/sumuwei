# Lv2 局部修复报告 · 2026-10-03

本轮修复了提议原话传递、承诺确认的事实绑定、慢路径量具首启边界，并修正选档和请求计数。完整回归退出 0，生产副本 Live Smoke 为 **52/0**。**Lv2 仍为 NOT PASS**：A12 联合证据未齐，承诺正控仍失败，继承门仍有未通过项。

验证基于 `a797fa0e0ede57e978f7c9b9953098283b87bd42` 上的修复工作树，各 run 保存源码指纹。日期按北京时间记录，runId 使用 UTC 日期。此报告追加新证据，历史 v1–v6 的读数保留。

## 1. 七个卡点的处置

| 原卡点 | 本轮结果 | 剩余事项 |
|---|---|---|
| G4 / A12 | M10.1 WP2b 生产约定 worker 已接线；“worker 未实现”已过时。Lv2 慢路径夹具改用生产同款入口 | A12 联合故障矩阵、独立水位、取消及关闭证据仍缺，G4 不放行 |
| G6 继承门 | 最终读数 **9/16 PASS**；M9 F-1/F-4 已在 M9.1 修复、销账 | 7 道未通过项仍阻断；需分别核对当前失败项 |
| G7 回归半 | 本会话完成完整离线与真实回归，EXIT 0；G14 **52/0**，新的 Lv2 回归读取 **PASS** | 保留原 26/18 档，用本轮新证据承接 |
| G6/G7 接口处置 | G7 已有本轮完整通过证据；G6 继续分列 | 本轮没有代替用户作出“接受当前未通过项”的裁定 |
| `device.primary` 的“还是 X” | 按 ADR-088 的边界保持原状 | 需同时覆盖取值句与“还是算了”等负控的独立处理 |
| G3 83.6% / 承诺与表述 | 修复提议原话在理解链中丢失；定向实测仍未使 C07/C08 达标 | 新约定识别、快慢路径重复写入；C03/C04 取回与更正表述仍需处理 |
| C08-06 虚假确认 | 快路径定向两轮没有再出现“未写承诺却确认记下”；承诺行仍未增加 | 回复纠正不等于承诺正控通过，也不能据两轮宣布 G1 通过 |

M9 关闭依据见 [M9.1-Gate-Decision §4](../m9.1/M9.1-Gate-Decision.md) 与 [技术债登记册 R-20/R-21](../Tech-Debt-Register.md)。M9 原长门仍有独立的非确定性失败；两项旧缺陷关闭不自动使整个 M9 聚合门通过。

## 2. 修复与根因

### 提议原话在理解链中丢失

`TurnGateway` 已提供上一条 assistant 原话，但 `runGoalTurn → GoalUnderstandingInput → provider` 只传事件 id。用户说“就按你说的”时，理解模型看不到被接受的内容。

现在成对传递 id 与原话；缺一项就不提供提议证据。provider 用 JSON 引用原话，并按现有 500 codepoint 上限裁剪。未改身份 prompt 或承诺草案校验规则。

装配复现先得到 **20/22 FAIL**，缺失原话的两条断言失败；修复后扩展为 **24/24 PASS**，覆盖原生调用链、缺失证据负控和 Unicode 长度边界。这证明输入已到达模型，不证明模型一定正确建立承诺。

### 目标创建、校验通过被误用作承诺写入依据

原守卫在“本轮写了任何东西”时放过泛称的“记下了”；C08-06 只创建目标也会取得这一放行。另一个缺口是：提交失败时 trace 仍保留校验通过的事件类型，单看 `COMMITMENT_ACCEPTED` 类型不能证明已入库。

现在同一事实函数要求 **`eventsCommitted > 0` 且含相应事件类型**。只创建目标、未接受承诺时，泛称确认改为说明已留下目标记录、尚未形成新约定；合法记忆确认、已提交承诺和否定表达保留。生产回复、Lv2 夹具、自主行为夹具使用相同事实绑定。

守卫仍采用有限词形覆盖，没有新增“任何说法都不会误报成功”的主张。

### 慢路径首轮只建立 cutover，没有消费本轮

旧夹具在首条真实回复后初始化 cutover，单轮 C08-06 因此只得到 `cutover_preset / modelCalls=0`；手工复制的 scheduler 端口还缺生产同款 fence、signal 与撤回集合。原 82.8% 档不能证明慢路径有效。

现在在 prep 结束、真实对话开始前建立首启边界，之后调用 `runConfiguredAgreementTail`，共享会话关闭 fence/signal，并传入当前撤回集合。离线复现确认：prep 不被重判、首轮实际消费、第二轮继续消费、水位与会话尾对齐、控制档模型调用为 0。

这补齐夹具消费路径，尚未覆盖 A12 中两类 worker 的联合故障与独立水位矩阵。

### 量具范围与计数

- 私有正文目录 `local` 不再被当成正式 run；其他缺清单或清单损坏的 run 仍拒收。量具自检 **20/20 PASS**。
- 定向复测归入 `wp4-targeted-short`，完整慢路径档归入 `wp4-slow`；只有完整两轮快路径档归入 `wp4-short`，定向结果不能覆盖 G1/G3。
- 请求按理解、回复与慢路径的实际调用记录，多轮用例逐轮累计，不再按案轮数估算。
- 交付检查还复现了隐私报告自身的误报：公开语料值被 JSON 引用后，外层引号使原始字符串匹配失败。现在仅还原完整 JSON 字符串的表示，再核对同一内容是否已在公开语料中；新增两条控制验证公开内容不误报、新正文仍拦截。失败详情只存 SHA256、长度和来源，不再把命中的正文再次写入公开证据。窗口长度、预算阈值和语料内容保持原口径。

## 3. 定向真实实测与残余

三组定向测试使用测试端点 `deepseek-v4.1-flash`，共 **18 次实际请求**。未重跑正式 144 案轮或扩大长链规模。下表是中间修复候选的实测；随后增加的“校验通过但提交失败”绑定由离线控制和最终完整回归验证，未再运行正式 G3 批次。

| 案子 / 档位 | 案轮通过 | 状态与回复 | 实际请求 |
|---|---|---|---|
| C08-06 快路径 ×2 | **0/2** | 承诺行均为 1，期望 2；两轮虚假确认 incident 均为 0，目标记录确认被纠正 | 4 |
| C07-05 快路径 ×2 | **0/2** | 承诺行均为 0，期望 1；虚假确认 incident 为 0；正确写成约定仍未做到 | 8 |
| C08-06 慢路径 ×2 | **0/2** | 两轮均 `ran`，各有 1 次慢路径调用；承诺行分别为 **1、3**，期望 2；第二轮重复新增 | 6 |

慢路径第二轮的机器保守分类仍记 2 条严重 incident。分类按案子失败附加既定标签，粒度较粗：**总行数 3 证明多写了一条，不能单凭这项读数证明旧行复活或这轮“未写却确认”**。保留机器分类和行数，不改金标、不删失败案。下一步需复现快慢两路对同一语义约定的重复接受，确认来源幂等与仲裁位置后再修。

三组证据不替代正式 G1/G3。v6 **83.6%** 是历史候选读数，新工作树的全量通过率尚未测得。

其他会话已立案 **LV2-D15**：C04-04 的程序侧 prep 对 `recentExplicitWrites` 不可见，导致 `target_not_found`。本轮保持语料 @3，未改为显式播种、未调整期望；见 [Freeze Record 的 D15](Lv2-WP1-Freeze-Record.md)。这一类夹具问题不能与 C03/C04 的全部表述失败合并归因。

## 4. 验证与证据

| 验证 | 结果 | 证据 |
|---|---|---|
| `pnpm lv2:repair:verify` | **13/13 PASS**，0 模型调用 | [修复控制](../../artifacts/lv2/lv2-wp2-repair-20261002-a797fa0e0ede-8b4a/checks.json) |
| `pnpm m10.1:assembly:verify` | **24/24 PASS** | [原生装配](../../artifacts/m10.1/m11-m10-1-wp6b-assembly-20261002-a797fa0e0ede-b654/assembly-verify.json) |
| `pnpm lv2:measurement:verify` | **20/20 PASS** | [量具清单](../../artifacts/lv2/lv2-wp3-measurement-20261002-a797fa0e0ede-e5b3/manifest.json) |
| `pnpm m10.1:agreement:verify` | **18/18 PASS** | [约定验证](../../artifacts/m10.1/m11-m10-1-wp2b-agreement-20261002-a797fa0e0ede-7858/manifest.json) |
| `pnpm m10:test` / `pnpm m10:e2e:verify` | **59/59、19/19 PASS** | [组件](../../artifacts/m10/m10-wp3-test-20261002-a797fa0e0ede-6963/manifest.json)、[E2E](../../artifacts/m10/m10-wp8b-e2e-20261002-a797fa0e0ede-0541/manifest.json) |
| `pnpm lv2:core:verify` | **9/9 PASS** | [核心](../../artifacts/lv2/lv2-wp2-core-20261002-a797fa0e0ede-db0f/manifest.json) |
| `pnpm typecheck` | **EXIT 0**，含最终隐私量具修复 | 本地日志 `artifacts/lv2/local/repair-20261003/typecheck-delivery.log` |
| `pnpm with-test-model pnpm m4.5:ci:full` | **EXIT 0**，含完整离线门；Live Smoke **52/0** | [最终回归归档](../../artifacts/lv2/lv2-wp6-repair-regression-20261002-a797fa0e0ede-f27c/regression.json) |
| `pnpm lv2:regression:read` | **PASS**，未通过 Hard Gate 0 道 | [新回归读数](../../artifacts/lv2/lv2-wp6-regression-20261002-a797fa0e0ede-b6c6/manifest.json) |
| `pnpm lv2:inherited:gates` | **9/16 PASS，整体 FAIL** | [最终继承读数](../../artifacts/lv2/lv2-wp6-inherited-gates-20261002-a797fa0e0ede-2aea/readings.json) |
| `pnpm m11.1:behavior:control` | **10/10 PASS**，0 模型调用 | [自主行为控制](../../artifacts/m11.1/m11-m111-behavior-control-20261002-a797fa0e0ede-f648/manifest.json) |
| `pnpm lv2:privacy:budget:verify` | **9/9 PASS**；1605 正文窗口 × 290 份机器证据，泄漏 0，预算问题 0；自检 6/6 | [隐私 / 预算](../../artifacts/lv2/lv2-wp6-privacy-budget-20261002-a797fa0e0ede-6242/manifest.json) |
| `pnpm lv2:gates` | **6 PASS / 3 FAIL / 1 NOT RUN**，整体 NOT PASS；自检 3/3 | [当前门汇总](../../artifacts/lv2/lv2-wp7-gates-20261002-462244719ab2-1937/manifest.json) |

当前 G0/G2/G5/G7/G8/G9 为 PASS，G1/G3/G6 为 FAIL，G4 为 NOT RUN。G1/G3 继续使用最新完整快路径 v6；没有用定向结果覆盖正式读数。

定向真实档：[C08 快](../../artifacts/lv2/lv2-wp4-targeted-short-20261002-a797fa0e0ede-6f79/manifest.json)、[C07 快](../../artifacts/lv2/lv2-wp4-targeted-short-20261002-a797fa0e0ede-37cc/manifest.json)、[C08 慢](../../artifacts/lv2/lv2-wp4-targeted-short-20261002-a797fa0e0ede-f15a/manifest.json)。失败档、修复前复现和修复后档均保留。

完整回归之后的最后改动仅在隐私量具，由新增控制和类型检查验证；生产应用源码保持完整回归时的版本。验证先在注明 `worktree.clean=false` 的候选树中执行，随后按产品、量具、测试、证据、文档分别提交；不把原 run 的 HEAD 改成后来的提交号。

[源码承接核对](../../artifacts/lv2/repair-20261003-source-provenance.json)确认：**284 个应用文件**与完整回归候选的字节指纹全部相同；回归后唯一改动的验收脚本是隐私量具，其最终 PASS 档指纹与提交后源码一致。

继承门未通过名单：**M4、M5.5.1、M6.1、M9、M10.1、M11、M11.1**。M4 调用的 `m4:gates` 在当前 package.json 中不存在，独立复现为 command not found；它不是已测得的内核语义失败，也不能改称通过，需补齐继承入口契约。M5.1 本轮已 PASS。当前继承脚本生成的 `criteria-table.md` 为空白，核对结果应使用 `readings.json`。

## 5. 交付边界与下一步

本轮仅打开隔离实验库或生产副本，未执行生产激活或真实库迁移。测试重写了部分旧脚本固定产物：新回归的无正文摘要与原文件 SHA 单独存档，原有已跟踪证据按运行前字节快照恢复；生成正文和完整日志留在被忽略的 `local`。未把本轮声明扩成“整个真实库的前后树摘要已核对”。

恢复证明见 [字节恢复记录](../../artifacts/lv2/repair-20261003-evidence-restore.json)。恢复固定路径后，旧聚合入口会再次引用该路径的历史档；本轮通过依据是已经封存的新回归读数及对应的 52/0 归档，不是把旧 26/18 档回写成 PASS。

建议先复现并修快慢路径重复接受，再补 A12 联合矩阵；C03/C04 先区分 D15 语料形状与真实表述问题，再安排正式 G3 复测。G6 应逐项核对当前失败或不可运行原因。

| 能力影响 | 本轮 |
|---|---|
| 新增执行、应用或联网能力 | **NONE** |
| 现有人格 / 认知链修复 | 提议原话传递与承诺回复事实绑定 |
| 验收范围变化 | 无；阈值、金标、50 轮混合长链口径保持原裁定 |

本轮结论是局部修复已验证，**Lv2 尚未放行**。
