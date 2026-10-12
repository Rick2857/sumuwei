# ADR-095：实用能力（计算 / 文档 / 网页深读）生产激活

- 状态：**ACCEPTED / EXECUTED**（**只做状态修订**，不改任何设计决策）
- 日期：2026-10-04
- 授权：用户本轮**显式**指令「生产启用」，并明确接受「三项可用 + OCR 记 `PARTIAL`」
- 载体：[`Utility-Skills-Execution-Plan-2026-10-04.md`](../post-lv2/Utility-Skills-Execution-Plan-2026-10-04.md) §5
- 事实：[`Utility-Skills-Acceptance-Report.md`](../post-lv2/Utility-Skills-Acceptance-Report.md) · 基线与用法：[`Utility-Skills-WP0-Baseline.md`](../post-lv2/Utility-Skills-WP0-Baseline.md) · [`Utility-Skills-Usage-and-Rollback.md`](../post-lv2/Utility-Skills-Usage-and-Rollback.md)

## 1. 决定

激活**四项**能力（精确计算 / 文档阅读 / 网页深读 / **OCR**）与**当轮内容额度**。

> **修订（同一天，用户改判）**：本节初版写的是"激活三项、不激活 OCR"。
> 用户随后明确「OCR 开关打开」，因此 OCR **已启用**。
> ⚠️ 但**读数不变**：OCR 的清晰样本仍未达 §4A 的 `CER ≤ 5%`
> （实测 zh 8.33% / mixed 5.88% / en 0%，关键数字全对）⇒ 报告里 OCR 仍记 **`PARTIAL`**，
> 区别只是从"未启用"变成"**已启用但未达阈值**"。本 ADR **不**改写那条读数，
> 也**不**用调阈值/换样本/后处理去凑通过。

OCR 的组件与接线都已落地并通过其自身探针（21/21），但**未达到本项自己的清晰样本阈值**
（计划书 §4A 要求三张清晰样本分别 `CER ≤ 5%`；实测 zh 8.33% / mixed 5.88% / en 0%，关键数字全对）
⇒ 按计划书 §5「可交付前三项并把 OCR 明确列为未完成」，它记 **`PARTIAL` 且 `NOT ENABLED`**。
本 ADR **不**改写那条读数，也**不**用调阈值/换样本/后处理去凑通过。

## 2. 执行了什么（**只追加**，`.env`）

```text
CHARACTER_MATH_CALCULATE_ENABLED=true
CHARACTER_DOCUMENT_READ_ENABLED=true
CHARACTER_WEB_READ_ENABLED=true
CHARACTER_IMAGE_OCR_ENABLED=true      ← 修订：2026-10-04 用户改判为「OCR 开关打开」
CHARACTER_TURN_CONTENT_TOKENS=3000    ← 修订：用户「当轮内容额度取值稍微偏高一点最好」
```

⚠️ **代码缺省一个字节都没改**：四个开关在 `flags.ts` 里仍缺省 `false`，
`ContextBudget.turnContentTokens` 仍缺省 `0`。激活**只是**生产 `.env` 的取值。
⚠️ 执行脚本不打印任何取值（只打印键名），因此 `.env` 里的凭据没有进入会话记录。

### 2.1 修订（同一天，用户两条新决定）

| 项 | 原 | 现 | 代价与处置 |
|---|---|---|---|
| OCR 开关 | `false`（记 PARTIAL、不启用） | **`true`** | 用户改判为"打开"。⚠️ OCR 的清晰样本读数**仍然未达** §4A 的 ≤5%（zh 8.33% / mixed 5.88%），这条**不因开关打开而改变**：报告里 OCR 仍是 `PARTIAL`，只是**已启用** |
| 当轮内容额度 | `2000` | **`3000`** | 2000 原本是 `flags.ts` 的硬上限 ⇒ 要"稍微偏高"必须**放宽界**：`boundedInt(..., 0, 0, 2000)` → `4000`（`src` 变更，语义不变：0 仍是"不注入"、非法值仍回落 0） |

⚠️ 因为第 3 节那次读数发生在**放宽界之前**，按计划书 §5「最终完整回归必须对应交付版本」，
改界之后**重跑了一次** `m4.5:ci` 并重新出读数（EXIT 0，硬门全 PASS，两个汇总器 PASS）。
两次日志都留档：改动前的在 `artifacts/post-lv2/local/utility-skills-preparation/runs/wp9-m4.5-ci-pre-boundwiden.log`，
规范路径上现在是**改动后**那一份（带真实 `EXIT_CODE=0`）。

## 3. 激活后的机器读数

`readKernelFlags()` 实读（不打印凭据）：`mathCalculateEnabled=true` ·
`documentReadEnabled=true` · `webReadEnabled=true` · **`imageOcrEnabled=true`** ·
**`turnContentTokens=3000`**（同一次读到的 `webSearchEnabled=true` · `actionEnabled=true` 未变）。

⇒ 装配层据这三个 `true` **授予权限 + 构造适配器**；`turnContentTokens=2000` 让当轮内容
真的能进上下文（少任一件都只是"半开"，先例 `L-M11-10`）。

## 4. 回滚（一条命令级别）

```text
删掉上面五行（或把三项改成 false / 把额度改成 0）⇒
  · 权限不再授予 ⇒ 用户显式要求得到可审计的 permission_denied
  · 适配器不再构造 ⇒ 不加载重组件、不 spawn 子进程、不出站（构造性保证）
  · 额度 0 ⇒ turn-content section 构造上不会出现
不需要数据库迁移或恢复；已生成的账本记录与报告保留。
```

⚠️ **回滚后要确认的三件事**（计划书 §5）：适配器构造 0 · 进程 0 · 出站 0。

## 5. 这次激活**没有**新增任何主张

```text
· OCR = PARTIAL 且未启用（§1）
· 局限清单 L-US-01…L-US-15 一字未改（页码不保真 / 扫描件降档 / 只支持静态网页 /
  计算单次成本 ≈1.2–1.4 s / 请求参数进账本而正文不进 等）
· 不主张"长期认知绝无变化"（不新增认知写入入口，但正常回复仍经既有消费者）
· 首次真实聊天使用 = NOT OBSERVED（本 ADR 不凭配置宣布运行验证通过）
```

## 6. 一处**必须登记**的部署残余（实测确认）

文档阅读的默认解释器路径是 `artifacts/post-lv2/local/utility-skills-preparation/python/venv/…`，
而 `artifacts/post-lv2/local/**` 被 gitignore ⇒ **在别的机器/清理过 local 的检出上，
文档阅读会失败关闭**（如实报"转换器不存在/执行器失败"，不会静默降级、不会出站）。
重建入口与固定版本见报告 §1 与 `scripts/utility-skills/`（`make-fixtures.py` 与我们记录的依赖锁）。
本机该项可用。
