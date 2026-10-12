# Lv2 —— 架构与量具（`LV2-G9` 交接包之一）

> **2026-10-03 交接状态：Lv2 = PASS（已知风险接受放行），可继续 Lv2.5–4.5。** 权威为[ADR-090](../adr/ADR-090-lv2-risk-acceptance-release.md)与[裁定记录](../../artifacts/lv2/release-ruling-20261003.json)；剩余 M9/M11.1 证据转为[放行后待办](Lv2-Deferred-After-Release-2026-10-03.md)。`pnpm lv2:gates`保留机械结果，不表示裁定失效；查询交接状态应同时读取裁定记录，区分里程碑已放行与机械门未全绿。内核与运行时接口未因本次裁定改变。

> 日期：2026-10-02 · 分支 `main` · 计划：[`Lv2-Acceptance-Plan.md`](Lv2-Acceptance-Plan.md)
> 本文件说明 **Lv2 验收自己是怎么被搭出来的**（量具的架构），不重复产品的架构
> （产品架构见 `docs/architecture/`、各里程碑的 `*-Architecture.md`）。

---

## 1. 两条档位（这是本里程碑最容易搞错的地方）

```text
控制档（control）  整条链**一个字节都不出网**：目标理解端口换成脚本化 provider
                  （有活跃目标就报完成 —— 第二代起**故意让它会写**，否则"故障阻止了写入"
                    与"控制档本来就不写"在读数上长得一样）
真实档（live）     目标理解端口 + 回复都走**测试端点**（`pnpm with-test-model` ⇒ `.env.test`）
```

⚠️ **出身是一次真实事故**（[`Tech-Debt-Register.md`](../Tech-Debt-Register.md) §0n / `R-37`）：
第一版只在"回复"那一层分档，preflight 实际**出网 ≈189 次**、且可能用了 `.env` 的生产 key。
⇒ 纪律：**"控制档 / 干跑 / 只读"必须覆盖整条链**，而不是最外层那一次调用。

## 2. 入口与产物

| 入口 | 作用 | 档位 |
|---|---|---|
| `pnpm lv2:baseline` | WP0 只读盘点（开关/版本/来源） | 只读 · 0 调用 |
| `pnpm lv2:corpus:freeze` | 语料冻结门（含 **P3 谓词一致性**机器判据） | 离线纯函数 |
| `pnpm lv2:core:verify` | WP2 核心路径（承诺接纳 / 程序侧草案 / 边界） | 离线 |
| `pnpm lv2:measurement:verify` | WP3 量具有效性（含**硬门自身缺陷注入**） | 离线 |
| `pnpm lv2:diagnose:memory` | 显式记忆链四段离线定位（含正/负控与复活探针） | 离线 · 0 调用 |
| `pnpm lv2:short:live` | **144 案轮真实回复**（逐案隔离库） | 真实（测试端点） |
| `pnpm lv2:gates` | **只读汇总** `LV2-G0…G10`（缺文件 = NOT RUN） | 只读 · 0 调用 |

产物：`artifacts/lv2/<runId>/`（机器证据，进仓库）+ `artifacts/lv2/local/<runId>/`（真实正文，**gitignored**）。
清单契约：`lv2-manifest@1`（25 个必填字段）；`runId = lv2-<wp>-<YYYYMMDD>-<head12>-<suffix4>`。

## 3. 四个不可省的量具纪律（每一条都是踩出来的）

```text
① 逐案隔离库   每一案轮一个 `isolateDatabase(label,{keep:true})` + `resetPluginSqlConnection()`
               真实库**全程未打开**（26+ 份 run 的 `realDb.opened=false` 可逐份核）
② 缺文件≠PASS  汇总门对"没找到证据"一律给 NOT RUN；三段式自检里有一条**注入缺项必须报 NOT PASS**
③ 选档按身份   `ended` 降序、tie 按 runId（**不看目录 mtime**）—— `TD-23` 的教训
④ 失败留档     FAIL 档一律入库、不回写；换代只出新档（`TD-16`）
```

## 4. 短场景运行器（`lv2:short:live`）的装配

生产形状（与 `src/main.ts` 同形），并**点名**未接线面：

```text
已接线  显式记忆服务（+ ADR-058 兜底端口 `recentExplicitWrites`）· 目标/承诺真 provider ·
        撤销遮蔽 `withdrawnContextMasking` · 真实 `recentLines` · 放行口 features
        `{ restatementRevivalEnabled: true }`（按生产 `.env`）·
        回复链四道守卫：记忆 → **承诺** → 动作 → 外部证据
未接线  关系 / 情绪 / 信念 / 反思-自适应 / 摘要 / 搜索 / 动作（`LV2_NOT_WIRED`，逐案在案）
        ⇒ 相关案子只证明"没有不该有的写入"，**不**证明"该注入的注入到位"
额度    目标 300 · 承诺 300 · 自适应 0 · 摘要 0（生产是 300/400）—— 每一代在 manifest 里声明
```

## 5. 故障注入（`C11`）

```text
已实现   provider_error · provider_timeout · double_trigger
未实现   close_before_result · restart_before_result · withdraw_during_generation
         ⇒ 运行器**拒绝判定**这些案轮（状态 FAULT_NOT_IMPLEMENTED · **0 次模型调用**）
            —— fail closed：不空过、也不误红
```

## 6. 复现一次读数（最小步骤）

```bash
pnpm typecheck
pnpm lv2:corpus:freeze              # 9/9（含谓词一致性）
pnpm lv2:core:verify                # 9/9
pnpm lv2:measurement:verify         # 19/19（含注入负控）
pnpm lv2:diagnose:memory            # 7/7（0 调用）
pnpm with-test-model pnpm lv2:short:live     # 144 案轮（测试端点）
pnpm lv2:gates                      # 只读全表
```
