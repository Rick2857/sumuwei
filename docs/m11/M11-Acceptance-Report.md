# M11 Acceptance Report —— 验收事实报告

- 日期：2026-10-01
- 里程碑：**M11 —— Reflection 与有限 Adaptive Self**
- 判定载体：[`M11-Gate-Decision.md`](M11-Gate-Decision.md)（十四槽，**不合成总分**）
- 计划书（权威源）：[`M11-Execution-Plan.md`](M11-Execution-Plan.md)（sha256 `12318E89…`，**未改一字**）
- 设计权威：[`ADR-085`](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md)（`ACCEPTED / DESIGN FROZEN`）+ [`M11-Acceptance-Contract.md`](M11-Acceptance-Contract.md)

> 本报告只写**事实与读数**；判定与"能声称什么"在 Gate-Decision。

---

## 1. 交付面（WP0 → WP12）

```text
事件（5 个，闭集）    REFLECTION_PROPOSED / REVIEWED / INVALIDATED · ADAPTIVE_SELF_REVISED · （+ 既有）
行为槽（3 个，闭集）  clarify_when_ambiguous · acknowledge_correction_first · recheck_goal_before_next_step
慢路径                触发检测 → 有界窗口 → **一次**模型调用 → 严格校验 → 审查 → 事件 → 投影
                      （WP7 调度：水位/任务/失败/晚写闸门；WP12 接进 `src/main.ts`）
同轮阻断与失效        根被忘/撤回 ⇒ **当前轮**立即不可用；后台补一条幂等失效事件（`D12`）
跨域待审              意图只带 {域, 目标, 期望版本}；**不得**夹带目标域的提案正文（`D13`）
注入                  `adaptive-self` section（优先级 44 · 可裁 · 至多 3 条程序模板 · 额度缺省 0）
开发者面              遮蔽**写进类型**的 DTO + `*_FACTS` + `FORBIDDEN_EXPORT_PATTERNS`
可观测性              `adaptive_self_context` trace 步（属性闭集；入模 id 只来自最终 packet）
```

## 2. 门读数（全部分列，**不合成总分**）

| 门 | 读数 | 权威代 runId（`artifacts/m11/…`） |
|---|---|---|
| `m11:wp0:verify` | 32/32（判决代） | `m11-wp0-20261001-9a0694a309a6-a58b` |
| `m11:lineage:verify` | 34/34 | — |
| `m11:inputs:verify` | **43/43**（含 H 组：有界正文 / 遮蔽先于注入） | — |
| `m11:policy:verify` | 25/25 | — |
| `m11:adaptive:verify` | 22/22 | — |
| `m11:invalidation:verify` | 18/18 | — |
| `m11:recovery:verify` | **18/18**（判据已按 `cutover_preset` 更新） | `m11-wp7-20261001-fb10b0efa241-b17f` |
| `m11:context:verify` | 31/31 | — |
| `m11:measurement:verify` | **24/24**（四判定器三段式 + 差分负控 + 语料冻结） | — |
| `m11:observability:verify` | **18/18**（理由码可达性机器核对 + 四个外发面零泄漏） | — |
| `m11:e2e:verify` | 12/12（触发→…→上下文 的关联链） | — |
| `m11:long:verify`（离线） | 200 轮 12/12 · 500 轮 12/12 | — |
| `m11:semantic:eval` | **8/8**（第二代；480/480 全分母） | `m11-wp10-semantic-20261001-86f97d8babb7-4da9` |
| `m11:smoke:live` | **4/5 FAIL**（格式 2/3） | `m11-wp10-smoke-live-20261001-bfe15bf6d225-c1a1` |
| `m11:long:live` | **8/8** | `m11-wp10-long-live-20261001-62b45453c7a2-c213` |
| `m11:ablation:verify` | **7/7**（材料差异层） | `m11-wp10-ablation-20261001-d79f101fc9b6-3599` |
| `m11:review:materials` | **6/6**（32 张卡 · 档位隐藏） | `m11-wp10-review-materials-20261001-2ac3451e5850-9c4b` |
| `m11:activation:verify` | **9/9**（生产副本；源摘要前后相同） | `m11-wp12-activation-20261001-0440670a572a-178f` |
| `m11:activation:readback` | **8/8**（真实库只读；`cleanClose=true`） | `m11-wp12-readback-20261001-ca88049e100b-8469` |
| `m11:docs:verify` | **8/8**（计划书 sha256 未变 · 133 条链接可达 · 命令存在） | — |
| `m11:gates` | 只读聚合：离线 **13/13** · 语义 1/1 · live 3 PASS + 1 FAIL | — |
| `m11:regression:verify` | **6/6**（完整清单 **49** 道 · 388 s） | `m11-wp11-regression-20261001-add606904a73-438c` |

## 3. 三份关键读数（各自独立，**不许互相顶替**）

```text
① 语义（模型这一格）：盲测 160×3 = 480 次真实调用
   格式有效 0.9000（最差轮 0.8688）· **编造 handle 0** · **支持膨胀 0** · 反例漏报 0 · 传输失败 0.0021
   ⚠️ E6（采纳 precision / 拒收 recall = 1.0）量的是**语料自洽性**，**不是**模型质量
② 行为（她这一格）：`m11:long:live` 200 轮真实链（采纳 39 · 拒绝 10 · 失效 15 · 调整 3 ·
   rebuild 对账 4/4 · 入模引用 501 · p50 5249 ms / p95 14436 ms）
   与三档消融（材料差异可机器判定：A/B 无块且逐字相同 · C 只多那一段 59 字）
③ 真实端点短链：`m11:smoke:live` **FAIL 4/5**（3 次里 1 次不是 JSON）—— 门槛跑之前写下，不改
```

## 4. 缺陷与判据修正（如实清单）

```text
L-M11-13  `m5:budget:verify` 继承红（pre-WP8 实测复现 ⇒ 归 M5/M9.5 线）      —— 未修（不顺手修）
L-M11-14  窗口**没有正文**（模型无从反思）                                    —— **已修** + H 组判据
L-M11-15  真实端点格式失败率（盲测 10% / 长链 11-62 / 冒烟 1-3，**三条分列**） —— 如实登记
L-M11-16  两族语料**输入与金标不自洽**（第一代 E6 precision 0.34）              —— **已修**（金标未改，指纹重冻）
L-M11-17  门的时序：投影是派生的，折叠必须逐轮做                                —— **已修**
L-M11-18  消融**没有测出增益**（n=1/档 + 回复相似本身是预期的）                  —— 读数
L-M11-19  runId 名字不能当排序键（聚合门挑错代际）                              —— **已修**（改用 mtime）
L-M11-20  `src/main.ts` **从未**调用慢路径调度（生产里没人跑）                  —— **已修**（WP12 接线）
判据修正  WP0 判官 4 版（注释当代码 / 字段扫描 / 自产前缀）· M10 D6 判据（去注释）·
          D6/D8 归属判据 3 版（命令当文件 / 别人家的命令 / 叙述当承诺）
工程坑    `pnpm` 供应链校验阻塞 ⇒ 逐条跑入口文件（L-M11-08）· `m4.5:measurement:verify` 需要
          `OPENAI_API_KEY` 存在（本工作树无 `.env`）⇒ 回归门加载 `.env.test`（**环境**，非代码回归）
```

## 5. 全链回归

```text
`m11:regression:verify --set=full` = **PASS 6/6**：完整清单 **49** 道（`m4.5:ci` 的扁平展开 + M11 各门）
· 已声明非零 **2**（`m11:gates` 按设计 · `m5:budget:verify` 继承）· 与 manifest 对账 **12** 道 ·
总耗时 **388 s** · 账本在 `artifacts/m11/local/regression-<head>.json`（**gitignored，不入库**，私密运行日志；
含逐条退出码与输出哈希，公开摘要在 runId 目录里）。
⚠️ 跑与判**分离**：`--record` 只记账，缺省模式才判 —— "手写一张全绿表格"过不了 G5。
```

## 6. 偏差与如实记录

```text
① **对话请求未跑**：计划 §11.4 要求"200 轮真实长链包含 200 次对话请求"，而 `m11:long:live`
   的回复是**脚本化**的（`dialogueRequests = 0`，L8 就是这条的机器判据）。
② **短链 FAIL 保留**：`m11:smoke:live` 4/5（格式 2/3）—— 门槛跑之前写下，看到 2/3 后**不**改。
③ **两代读数并存**：盲测第一代 FAIL 6/8（语料缺陷）→ 第二代 PASS 8/8；两代证据**都保留**。
④ **消融的行为增益未测出**：按计划 §11.3 记「没有测出增益」，**不**写"成长有效"。
⑤ **语料是程序构造的**：320 条按家族/簇/变体生成（非人工撰写）；金标由程序规则给出。
⑥ **生产激活未执行**：`m11:activation:readback` 读到的就是 `NOT ACTIVATED` / `FIRST-USE NOT OBSERVED`。
```
