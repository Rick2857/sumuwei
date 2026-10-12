# M9 → M10 交接

- 日期：2026-09-27（WP10 收口）
- 依据：计划 §24（M10 必须能只读取得的内容 + 七条边界）
- 读法：M10（目标/承诺域）开工前先读本文 + `M9-Gate-Decision.md` + `M9-Known-Limitations.md`

## 1. M10 必须能只读取得的信念面（全部已实现）

| 需要 | 从哪拿 | 形状 |
|---|---|---|
| beliefId | BeliefState.beliefId | 确定性 id（内容键派生） |
| owner/subject | BeliefState.owner | entityRef('character', id)（v1 单 Character 生产边界） |
| 命题作用域 | proposition.{predicate, value, scopeKey} | 三件套 |
| 当前状态 | status | active/disputed/superseded/retracted |
| 依据类型 | epistemicKind + supportLevel | reported/supported · inferred/tentative |
| 版本（修订链） | supersedesBeliefId | 前驱指针，链可回溯 |
| 有效来源引用 | evidenceRootIds + dependsOnMemoryIds | 对话根 + Memory 依赖 |
| 来源失效后的可用性 | status + 读时遮蔽 | retracted/superseded 不进候选——**读到的就是可用的** |

## 2. 七条边界（计划 §24 逐条，M10 必须遵守）

1. **「她推测用户喜欢 X」不构成替用户执行 X 的授权**——inferred/tentative 是看法，
   不是行动许可；目标生成不得把推测当授权。
2. **「她希望 X」属于 Goal，不是 Belief 世界真值**——M10 的目标域自己持有期望，
   不得塞进信念域冒充事实。
3. **目标依赖的 Belief 被撤回后，M10 要重新检查**——依赖失效传播（§7）只负责把
   信念转 retracted；**消费方重查是 M10 的责任**。机制：Belief 无推送通知，M10
   在执行/规划时按 beliefId 重读 status。
4. **commitment fulfillment 只能从真实 ActionResult/观察确认**——Belief 推测
   「应该完成了」不算完成（M4.5 reply-truth 同族纪律）。
5. **M11 Reflection 未来读取 Belief 时不得把 inferred/disputed 压缩成确定事实**——
   epistemicKind/supportLevel 必须随行。
6. **Evidence L1/L2 已过 ≠ 外部 Capability Lv2 已放行**——M9 无新外部能力
   （`External Capability Added = NONE`）。
7. **人格/认知主线结束后的能力包仍须保留**：目标确定性、授权、账本、trace、
   reply-truth——M10 的新能力一个都不能少这套底座。

## 3. 已实现 / 未实现的输入路径

**已实现（v1）**：
- 合格明确 Memory（显式意图 + ESTABLISHED 归因 + 白名单 authority）→ reported；
- 对话证据词形判定（单一槽 `interaction.explanation_detail`，3 根 × 2 会话阈值）→ inferred/tentative；
- Memory 更正/遗忘 → 依赖失效传播（beliefs retracted）；
- 推断根撤回 → 根数跌破阈值 → 降档/撤回。

**未实现（明确排除，计划 §2.2）**：
- assistant 自述、Affect/Relationship 输出、外部网页/工具内容作为信念输入（负控钉死）；
- 通用自然语言信念抽取（白名单 + 词形覆盖之外的一切）；
- 多视角/world fixture（B06 N/A-v1；合同与隔离测试有，生产单 Character）；
- inferred 升 supported、多槽位推断、信念主动表达（她不先开口谈信念）。

## 4. 默认 / 生产配置

- 代码缺省：`CHARACTER_BELIEF_ENABLED=false`（一切注入与消费的闸）；
- 生产激活状态：**NOT ACTIVATED**（WP11 候选见 `M9-Activation-Candidate.md`，
  需用户显式独立授权）；
- 阈值冻结：`BELIEF_INFERRED_MIN_ROOTS=3` / `MIN_CONVERSATIONS=2` / 白名单 /
  规则 id / 守卫 id——改任何 = 版本化重评。

## 5. 来源资格（一句话版）

只有「用户在受信归因下**明确说出**的 Memory」与「跨会话独立对话根的词形判定」
两条路能进信念；其它一切（她的输出、情绪判定、搜索结果、第三方转述）都被
资格矩阵挡在门外且可读回拒绝理由（`m9:source:verify` 26/26）。

## 6. 遗忘语义与恢复上界

- 遗忘 = Memory retracted → 依赖信念 retracted（读时立即遮蔽 + 写侧收敛双保险）；
- **append-only 审计保留**：retracted 的事件/行不物理删除（L-M9-09）；
- 恢复上界：事件在 ⇒ 投影重建逐字段一致（规模门 B45：4001 事件实测）；水位在 ⇒
  不重放；幂等两层（确定性事件 id + processed_operations）。

## 7. 长轨迹与人审结果

- 长轨迹：live long 门 200 连续轮（形成→更正→遗忘→长距离稳定→**再形成**→情绪→
  终态，6 检查点）——读数见 `M9-Gate-Decision.md` §live；
- 人审：可读盲审材料在 `artifacts/m9/local/<runId>/review*.md`（gitignore，不进仓库），
  仓库内 `blind-review.json` 指针；**PENDING 不回写**，裁决归档 Gate-Decision。

## 8. 仍开放的技术债 / 限制（M10 相关摘要）

- **F-1 呈现层遗忘泄漏**（live level1 严重项，2/7 复现）：状态层正确，泄漏通道是
  上下文窗口里的原始对话行；处置选项与裁定状态见 Gate-Decision——**M10 的目标
  执行若引用用户偏好，同样受此边界影响**；
- **F-4 同内容重述永不复活**（M4 冻结层，长门暴露）：忘掉/更正后逐字重述不重建
  （事件提交、折叠 no-op——L-M9-19）；**M10 的目标若依赖「重新记住」语义，
  必须知道换措辞才有效**；
- B-INFERRED live 形成不可达（单会话结构）：M10 若需要推断信念的**形成**证据，
  走离线门或等 M9.5；
- B38 评估器双迭代（提案数虚高、结果正确）：读 trace 时不要把被拒提案当回归；
- L-M9-01…12 初始限制清单全部随版本交付（见 Known-Limitations）。
