# M6 · WP5 Handoff（开发者面）

> 分支 `feature/m6-lv1-hardening` · 被测代码提交 `bbf635c`
> 证据：`artifacts/m6/m6-wp5-20260921-bbf635c38713/console.json`（**21/21**）· `artifacts/m6/m6-gates-20260921-bbf635c38713/gate-results.json`（**Hard Gates PASS，6 个必选门**）
> 出口状态：**开发者面能读回摘要事实，且"不知道"与"确定是 0"在界面上分得开**

---

## 1. 交付物（全部是**追加**，既有判据一字未改）

| 文件 | 改动 |
|---|---|
| `src/kernel/contracts/developer-query.ts` | `DeveloperRollupSummaryDto` + `developerRollupSummaryOf()`（**纯函数、唯一实现**）+ 16 个属性键登记表 + `TraceDetailDto.rollup`（**派生**，进派生清单） |
| `src/infrastructure/dev/query-service.ts` | `getTraceDetail` 从 **`context_compile` step 的属性**派生摘要视图（**不新开查询、不读第二张表**） |
| `src/infrastructure/dev/page.html` | Trace 详情新增摘要卡片（缺席时**明说**"没有启用"；"选了但没活过裁剪"单独提示） |
| `scripts/kernel-tests-dev-plane.ts` | 补一条**详情接地**测试；把已漂移的 `TRACE_SUMMARY_KEYS` 补齐 |
| `scripts/verify-m6-wp5-console.ts` | WP5 门（21 项断言） |

---

## 2. 三条语义写死在代码里（每条都有机器判据）

| # | 语义 | 为什么 | 判据 |
|---|---|---|---|
| 1 | **缺席 ≠ 全 0** | 那一轮**没启用**摘要（额度 0 / 没接端口）与"启用了但窗口内没有合格来源"是**两件事**；把前者渲染成 0 条就是把"不知道"伪装成"确定" | `§1-6`：无 `rollup_status` ⇒ `undefined`；页面侧 `§3-2` |
| 2 | **形状不完整 ⇒ 整条不作数** | 属性是开放字典，读到一半就拼一半的数，会让"0 条入选"与"属性没写完"在页面上长得一样 | `§1-7` |
| 3 | **哨兵 `-1` ⇒ 缺席** | `turn-gateway` 用 `-1` 表示"没有覆盖范围"；开发者面必须把它翻成缺席，而不是 `0..0` | `§1-8` |

另加一条**隐私**判据：`§1-9` 往属性里塞正文键（`rollup_text` / `rollup_excerpt`），DTO 只认登记过的那 16 个键 ⇒ 正文**进不来**。

---

## 3. 门读数

| 命令 | 退出码 | 读数 |
|---|---|---|
| `pnpm typecheck` | **0** | 0 错误（含派生清单的编译期接地证明） |
| `pnpm exec tsx scripts/verify-m6-wp5-console.ts` | **0** | `PASS — 21/21 通过，失败 0，MEASUREMENT INVALID 0` |
| `pnpm m5.1:test` | **0** | `54 通过 / 0 失败`（新增一条详情接地测试；原 53） |
| `pnpm m5.1:query:verify` | **0** | `56 通过 / 0 失败` |
| `pnpm m5.1:control:verify` | **0** | `41 通过 / 0 失败` |
| `pnpm m5.1:page:verify` | **0** | `27 通过 / 0 失败` |
| `pnpm m5.1:observability:verify` | **0** | `27 通过 / 0 失败` |
| `pnpm m6:measurement:verify` | **0** | `46 通过 / 0 失败`（套件表新增 `console`） |
| `pnpm m6:gates --write` | **0** | `Hard Gates = PASS`（必选门 **6** 个 · 未运行 0 · 未通过 0） |

**冻结面**：四条 M5.1 门改写了 5 个 `artifacts/m5.1/**` 证据文件 ⇒ 已按**白名单逐路径**还原，
**逐个 blob 逐字节相同**；`HEAD:artifacts/m5.1` = `8f464509f29522cae6b2963dc87478621647b1e2`，与 `artifacts/m5.5/baseline.json` 记录的冻结值一致。

---

## 4. 新发现（三条，全部由门/自查暴露）

| ID | 发现 | 处置 |
|---|---|---|
| **F-24** | `scripts/kernel-tests-dev-plane.ts` 的 `TRACE_SUMMARY_KEYS` 号称"DTO 的**全部**键"，实际**漏了 `attribution`**（WP6-5 追加的派生字段）⇒ "加字段必须同时改这里"这条纪律一直是**靠自觉**的，漏了两轮没人发现 | 补齐 `attribution`（并加进派生清单），再追加 `rollup` 与详情接地测试。原测试只查"清单里的键有没有权威"，不查"DTO 的键有没有全进清单"——这条缺口已登记 |
| **F-25** | 量具门的"套件审计"把**字符串里提到 `fetch(`** 判成了真实调用 ⇒ 新增的 WP5 门（它要检查页面只往 `/dev/query` 发请求）被判违规，`m6:measurement:verify` 45/46 | 把审计拆成两套判据：**原文提及**（模型端点/包装器/搜索 provider 的名字）与**代码里出现**（`fetch(`，先剥字符串与注释）。这不是放宽——它把"提到"与"调用"分开了 |
| **F-26** | 我自己写的三条静态检查太粗：注释里举例的函数名被算成"第二个调用点"；页面断言 `!includes('rollup.itemCount +')` 与我实际写法冲突（假红） | 剥注释后再数调用点；页面那条改成"不自己数 `sourceRefs.length`、直接渲染服务端的 `itemCount`" |

---

## 5. 偏差

| # | 内容 |
|---|---|
| **B-21** | 摘要事实挂在**既有** `TraceDetailDto` 上，**不**新增 endpoint、**不**新增 capability id。理由：它本来就是"这一轮 trace 的一部分"，为读回一件事新开一条查询面会让"同一事实两个入口"，而 `m5.1:observability:verify` 的权威边界正是防这个 |
| **B-22** | **CLI 侧本轮无新增用户可见命令**：事实走既有 trace 读回路径（`/dev/query/traces/:id` 与页面）。计划书 §WP5 要求的"CLI 与页面复用同一服务"在**服务端只有一处派生**这一点上成立（`§2-1`/`§2-3`） |

---

## 6. 没有扩大的主张

- 没有在**真实 HTTP 服务**上跑过请求：本门是纯函数 + 静态读（`m5.1:query:verify` / `m5.1:page:verify` 覆盖服务端与页面的契约与失败路径）；
- 没有做像素级视觉验证（页面卡片的存在与语义由静态锁 + 既有页面门保证）；
- 没有主张摘要已生产启用（`rollupTokens` 仍缺省 **0** ⇒ 今天没有任何 trace 会带 `rollup` 字段）；
- 没有主张开发者面能替代报告：它展示**引用与计数**，判断仍由 `m6:gates` 与验收报告承担。

---

## 7. 下一包

| 选项 | 内容 | 前置 |
|---|---|---|
| **WP6a（降级与动作真相）** | 故障注入：读取面失败 / 预算不足 / 模型失败时的诚实降级，与搜索/动作五态对齐 | 无 |
| **WP7（A–E 自然语言与跨模块）** | 端到端语料：摘要与召回/证据/动作的交互 | 无 |
| **WP6b（重启与恢复）** | 关闭 / 快照 / 恢复的集成验收 | **BLOCKED**：INC-01 WP3/WP4/WP5 未落地 |

**STOP 点**：本 WP5 到此 STOP。下一个包开工前先跑 `pnpm m6:gates`（只读、秒级）确认 6 个必选门仍全绿。
