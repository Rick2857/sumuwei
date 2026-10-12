# 皮套入口主动开口 · WP3 交接单（机会预检）

```text
WP     : WP3 —— LG 侧**机会受理与预检**（全部在**调模型之前**）
日期   : 2026-10-11
上游   : ADR-131（ACCEPTED / DESIGN FROZEN）· WP0 基线 · WP1 交接单（契约）
结论   : 预检层已实现并自证（19 项判据）；**报文 / 模型调用 / 交付仍属 WP4–WP5，未开始**
```

---

## 1. 交付物

| 文件 | 改动 |
|---|---|
| `src/kernel/contracts/proactive-opening.ts` | **新增**（纯函数，无 IO）：`OPENING_ENTRY` / `OPENING_PACKET_KIND` / `OPENING_RESULT_KIND` · `openingOpportunityKey()` · `OpeningRefusalCode`（15 条）· `precheckOpeningOpportunity()` · `assertOpeningRefusalCodesWellFormed()` |
| `src/kernel/contracts/index.ts` | **+1 行**导出 |
| `artifacts/…/local/avatar-opening-precheck-probe.ts` | **新增（gitignored）**：WP3 过程读数探针，19 项判据 |

### ⚠️ 为什么**没有**进 `scripts/` 也没有 npm script

`scripts/` 目录受 `scripts:catalog:verify` 管：`scripts/gates/scripts-catalog.ts` 按
`package.json` + `scripts/` 顶层文件**机械生成**清单，`--check` 逐字节比对。
⇒ 现在加文件/加脚本会**连带**要求重生成 `docs/architecture/Scripts-Catalog.md`，
而那份清单**已被别的会话改过**（混合树）。
⇒ 因此 WP3 把探针放在 gitignored 的 local 目录；**正式门 + npm 登记 + 清单重生成属 WP6**。

---

## 2. ★ 一处**计数修正**：是 15 条，不是 ADR 写的 14 条

ADR-131 §7-U2 写的是"复用 ADR-111 的十条 + 本通道四条 = **十四条**"。逐条核对后：

```text
care 的十条（precheckCareOpportunity 的实测闭集）：
  mode_off · paused · entry_scope_required · candidate_in_flight · outside_active_window ·
  not_idle_enough · cooldown · previous_care_unanswered · care_quota_reached · daily_quota_reached
  ⇒ 其中**只有八条**适用于本通道
```

**两条不适用的逐条理由**（不能只说"不适用"）：

| care 的码 | 为什么不用 |
|---|---|
| `mode_off` | 本通道**刻意没有自己的生产开关**（ADR-131 §9 批准记录 ②：「不动 `.env`（本 ADR 不含任何生产开关）」）。它的"关"是**未接线** —— 没有报文就没有机会，构造上不会跑（先例 ADR-111 `S07`） |
| `previous_care_unanswered` | care 的对象是**不在场**的用户，"上一次没被回应"才有意义；本通道的对象是**在场且页面连着**的用户，那个语义不存在（他就在那儿） |

⇒ 实际构成：**复用 8 + U2 四条 + 形状 2 + 幂等 1 = 15 条**。
形状（`opening_wrong_entry` / `opening_invalid_idle`）与幂等（`opening_opportunity_already_handled`）
在 `D01` / `U1` / 负控 10 里**已分别被要求过** ⇒ 这是**计数修正，不是新增裁定**。

---

## 3. ★ 一处**歧义的解决**：活动时段**约束本通道**

`D11` 列了"时段"，而 ADR-113 标题是"活动时段**只约束**自主关心" —— 表面冲突。
读 ADR-113 的**理由**后解决：

> 活动时段**只**约束**自主关心** —— 也就是"**没有来源、不该半夜自己冒出来**"的那一类。

⇒ 真实判据是"**系统自己冒出来的**" vs "**本人明确要求的**"：
```text
提醒   = 本人明确要求（原话里有提醒动词）⇒ **不受**时段约束（ADR-113 的实测）
开口   = 用户没要求、她自己开口 ⇒ 属"系统自己冒出来"那一类 ⇒ **受**约束 ⇒ `outside_active_window`
```

---

## 4. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| **WP3 探针**（`artifacts/…/local/…-probe.ts`） | **PASS · 19 项判据 · 失败 0** | **0** ✓ |
| `pnpm kernel:test` | **27 通过 / 0 失败** | **0** ✓ |
| `pnpm postlv2:qq-proactive:measurement:verify` | **32 通过 / 0 失败** | **0** ✓ |
| `pnpm postlv2:qq-proactive:verify` | **233 通过 / 2 失败** | 1（**归因：不是本次**，见下） |

### 4.1 探针的 19 项（逐条）

```text
正控 1  ：全部读数就绪 ⇒ eligible(key=2026-10-11T12, deadline=8000ms)
负控 15 ：15 条具名码各命中一次，且**都是预期的那一条**
形状/顺序 4：
  · 形状先于暂停（两处都坏 ⇒ 报 opening_wrong_entry）
  · 依据集先于"她正在说"（两处都坏 ⇒ 报 opening_without_evidence）
  · 幂等：同键第二次被拒
  · 机会键：同小时相同（2026-10-11T12）/ 跨小时不同（2026-10-11T13）
自检    ：15 条码互不相同且非空（assertOpeningRefusalCodesWellFormed）
```

⇒ **"顺序就是判据的一部分"** 这条被机器量到了（前两条顺序判据）。
⇒ **"每条拒绝给互不相同的具名码"** 也被机器量到了（自检 + 15 条各自命中）。

### 4.2 `postlv2:qq-proactive:verify` 的两条红 —— **归因：不是本次改动**

```
· ★ 正控：**十一处**焊接都在（含"全局上限没被抬高"这条负控式的静态判据）
· 静态：共用提醒调度过滤已尝试键，主入口实际使用共用调度
```

两条都量的是 **`src/main.ts` 的静态文本**，而 `src/main.ts` 与
`scripts/postlv2-qq-proactive-verify.ts` **都被别的会话改过**（混合树）。

**外科式归因证明**：把本次的**全部 6 个文件**（含未跟踪的新契约）一起 stash 后重跑
⇒ **仍然 233 通过 / 2 失败，两条失败项逐字相同**。stash 已 `pop`，6 个文件完好。

⚠️ **这与 `L-QQP-09` 是同一种病**（那条逐字写着"门脚本里**不许**用'全文按词找'当判据 ——
三次都是被我自己的注释/新增代码打败"）。**这是同型的第四、第五次**：改 `main.ts` 的
**别人**让这两条静态计数失效了。⇒ **本 WP 不修它们**（要动 `main.ts` 与那个门，属别人的在途面）。

---

## 5. 踩坑记录（**给下一个会话**）

```text
★ 块注释里**不能**出现"星号 + 斜杠"连写的路径通配。
  我在探针的 JSDoc 里写了 artifacts 下的两段式通配路径，其中的 `*/` **提前闭合了块注释**，
  esbuild 报 `Expected ";" but found "scripts"`（报在第 5 行，与真实原因不在同一处 ⇒ 极易误诊）。
```

---

## 6. 本 WP **没有**做的事

```text
· 没有 packet 收发（`OPENING_PACKET_KIND` / `OPENING_RESULT_KIND` 只是**常量**，没有解析器）
· 没有接线：没有任何生产代码 import 本模块（只有 contracts/index.ts 的 `export *`）
· 没有依据集构造（复用 ADR-111 属 WP4）
· 没有模型调用、没有回复守卫、**没有 sidecar**（WP4）
· 没有落账 / trace / `OPPORTUNITY_RESULT` 回执（WP5）
· 没有正式门、没有 npm script、没有改 Scripts-Catalog（WP6）
· 没有改 `scripts/postlv2_vtuber_runtime.py` 的入口守卫（一个字未动）
· 没有动 `.env`、没有动 `TD-19`
```

⇒ **仍然没有任何东西会产出 `proactive_opening`。** 她现在能做的还是原来那三件。

---

## 7. 下一步

| 顺序 | WP | 内容 | 前置 |
|---|---|---|---|
| **先** | **WP2** | 外壳侧关掉自带的 proactive speak（**零代码，用户操作**） | WP0 §4 |
| 然后 | WP4 | 依据集 + 一次模型调用 + 回复守卫 + **sidecar** | WP3 已就绪 |
| 然后 | WP5 | 交付读数 + `OPPORTUNITY_RESULT` + trace | WP4 |
| 然后 | WP6 | 正式门（探针转正 + npm + 清单重生成）+ 三段式 | 各 WP |
| 最后 | WP7 | 真链路 smoke | 全部 |
