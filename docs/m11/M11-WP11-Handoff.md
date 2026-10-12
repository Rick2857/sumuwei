# M11 WP11 交接单（进行中）

- 日期：2026-10-01
- 工作包：WP11（收口：聚合、回归消费与文档纪律）
- 状态：**COMPLETE（3/3）** —— ①**只读聚合门** `m11:gates`（三 lane、四态分列）·
  ②**文档与状态纪律门** `m11:docs:verify`（8 条判据）· ③**回归证据消费门** `m11:regression:verify`
  （跑与判分离：`--record` 记账本，缺省模式只读消费）全部落地
- 证据：聚合 `artifacts/m11/m11-wp11-gates-all-20261001-5aebe84d78c5-e778/`（`gates.json`）·
  文档门 `artifacts/m11/m11-wp11-docs-20261001-e72c859afebe-a7b7/`（`docs-verify.json`，**8/8**）·
  回归消费见 §3（`regression-verify.json`）

---

## 1. `m11:gates`：只读聚合（计划 §12.1）

```text
只读：**不跑**任何别的门、不开库、不调模型 —— 只读已落盘的 `artifacts/m11/*/manifest.json`。
三 lane（与计划 §12.1 的建议一致）：
  m11-offline   13 道（WP0 · lineage · inputs · policy · adaptive · invalidation · recovery ·
                context · measurement · e2e · long-200 · long-500 · observability）
  m11-semantic   1 道（盲测语义评测，需真模型 + 冻结语料）
  m11-live       4 道（冒烟 · 200 轮真实链 · 三档消融 · 盲审材料）
四态分列：PASS / FAIL / **NOT RUN**（没有证据）/ **INVALID**（manifest 缺字段）—— **不合成总分**。
退出码：FAIL 与 INVALID **非零**；`NOT RUN` **不**致非零（"离线 lane 里 live 门没跑"是**设计**）。
```

### 1.1 本轮读数

```text
合计：PASS **17** · FAIL **1** · NOT RUN 0 · INVALID 0
  m11-offline  : PASS 13 · FAIL 0
  m11-semantic : PASS 1  · FAIL 0     （第二代 `86f97d8b`，8/8）
  m11-live     : PASS 3  · FAIL 1     （唯一 FAIL = `wp10-smoke-live` 4/5，见下）
```

⚠️ **唯一的 FAIL 是真读数**：`m11:smoke:live` = 4/5（3 次真实调用里 1 次不是 JSON）。
门槛是**跑之前**写下的（3/3 格式有效）⇒ 看到 2/3 之后**不**改门槛（`L-M11-15`）。
它的兄弟读数在别处：盲测格式率 0.90（第二代）、长链 11/62 ≈ 17.7% —— **三者分列**。

### 1.2 ⭐ 判据教训（`L-M11-19`）：**runId 名字不能当排序键**

```text
第一版按 `(date, runId)` 取"最新" ⇒ 聚合门**挑错了代际**：
  · `wp10-semantic`：盲测第一代（head `fe7266f1`，**FAIL 6/8**）与第二代（head `86f97d8b`，**PASS 8/8**）
    同日，而字典序把 `fe7…` 排在最后 ⇒ 聚合报的是**被修掉的那一代**。
  · `wp0`：同理挑到中间的 `30/32` 代际，而**最后**一次是 `32/32`。
根因：runId 里带的是**产生它的那次提交的 head 短哈希**，"产生顺序"与"哈希字典序"无关。
修法：排序键改为 **manifest 文件的 mtime**（"落地顺序"的权威；同秒再按名字兜底）。
⚠️ 修完读数从「FAIL 3」变「FAIL 1」—— 变的那两条**都不是**产品变好，而是**聚合门看对了对象**。
   这正是"门量错了对象"的第 N 次，也是**聚合门自己最该被验的地方**（它决定别人看到哪一代）。
```

### 1.3 还没做的一处集成（如实登记）

```text
计划 §12.1 建议把三个 lane 登记进**既有 runner**（`gates:run --lane m11-*`），
那样 `--lane m11-offline` 能**真的执行**这 13 道门。本轮 `m11:gates` 只做**只读聚合**
（分 lane 与四态都已具备），**未**改 `scripts/gates/manifest.ts` ⇒ 登记为剩余集成项。
```

---

## 2. `m11:docs:verify`：文档与状态纪律（**PASS 8/8**）

| 判据 | 读数 |
|---|---|
| D1 **计划书不可改** | `M11-Execution-Plan.md` 的 sha256 = `12318E89…`（WP0 冻结值）**逐字节未变** |
| D2 文件齐全 | 18 份文档在案（WP0–WP11 交接单 + 契约 + 未决项 + OSS 登记册 + 可观测性交接单） |
| D3 链接可达 | 检查 **133** 条相对链接 · **断链 0** |
| D4 头部齐全 | 13 份交接单都有「日期 / 状态 / 权威」三行 |
| D5 **失败不被藏起来** | 聚合门报 FAIL 的 `wp10-smoke-live` **在案**（坏消息也进了文档） |
| D6 **实现归属** | 22 个实现文件 · **孤儿 0** |
| D7 私密材料标注 | 5 份提到 `artifacts/m11/local` 的文档**都**写明了 gitignored/不入库 |
| D8 **命令存在** | 交接单承诺 22 个 `m11:*` 命令 ⇒ 已注册，或落在**显式待实现白名单**里 · **漂移 0** |

### 2.1 这道门自己抓到的东西（都是真的）

```text
① `M11-WP11-Observability-Handoff.md` **缺「状态」行**（只有日期/门/归属）⇒ 已补。
② **三个命令在交接单里被引用 5–6 次，而 `package.json` 里从来没注册过**：
   `m11:semantic:eval` · `m11:smoke:live` · `m11:docs:verify` ⇒ 已注册（D8 就是为了这一族而加）。
   ⚠️ 这是"文档承诺了一个跑不起来的命令"——**漂移最典型的形态**，而且是**本轮才发现的**。
```

### 2.2 判据自身修了三处（**不是**产品缺陷）

```text
① D6 第一版只认**文件 basename** ⇒ 报了 18 个"孤儿"，而它们其实都被文档点名了 ——
   点的是**命令名**（`m11:inputs:verify`），那正是计划 §12.1 命令表用的名字。
   修法：从 `package.json` 建 `命令 → 入口文件` 表，**两者命中其一**即算有归属。
② D8 第一版用 `\bm11:…` ⇒ 把 `m10:m11:verify`（**M10** 的门）里的 `m11:verify` 也抓出来，
   报了一个根本不存在的"未注册命令"。修法：负向后顾 `(?<![\w:])`。
③ D8 第二版扫全文 ⇒ 又被**我自己解释这个缺陷的那句话**绊倒（散文里的 `m11:verify`）；
   第三版只认 `|` 与 `pnpm ` 行 ⇒ 太窄（只剩 1 个"承诺"，等于没查）。
   定版：认**清单项与表格行**（`^\s*[-|]`）—— 既覆盖"门/命令"的实际书写位置，又不吃散文。
⇒ 三次都是"**判据的对象/作用域错了**"（把命令当文件 · 把别人家的命令当自己的 · 把叙述当承诺）。
```

---

## 3. `m11:regression:verify`：回归证据消费（跑与判**分离**）

```text
`--record`  真的跑一遍**受影响门清单**（24 道），把每道门的 argv / 退出码 / 耗时 / 输出大小 /
            输出哈希写进**账本**（`artifacts/m11/local/regression-<head>.json`，**gitignored**）
            —— 它**不下结论**。
缺省模式    只读账本 + 已落盘 manifest，六条判据：
  G1 **清单齐全**（少跑一道 = NOT RUN，**不是** PASS）
  G2 **退出码**：要么 0，要么命中**显式已知非零**白名单（带具名理由）
  G3 **不过期**：账本 head = 当前 HEAD（不等 ⇒ INVALID）
  G4 **与 manifest 对账**：写证据的 M11 门，manifest 的 head 与账本一致、counts 与退出码自洽
  G5 **账本形状**：schema + 逐条 argv/exitCode/durationMs/输出哈希（**手写全绿表格过不了**）
  G6 **性能读数**：总耗时与最慢三道（如实记录，不与模型延迟混算）
```

### 3.1 记录时暴露的两条非零（**都不是"跑坏了"**）

```text
① `m11:gates` exit=1 —— **按设计**：聚合门对 FAIL/INVALID 非零，而当前聚合里真的有一道 FAIL
   （`wp10-smoke-live` 4/5）⇒ 声明为"已知非零"并写清**为什么**（不是"忽略它"）。
② `m11:docs:verify` exit=1 —— **真发现**：新建的 `scripts/m11-regression-verify.ts`
   还没被任何文档点名 ⇒ D6「实现归属」当场报孤儿。补上本节的点名后复绿。
⇒ 这两条正是"跑与判分离"的价值：**记录只记事实，声明必须显式**。
```

### 3.2 最终读数（head `b544e2a4`，**PASS 6/6**）

| 判据 | 读数 |
|---|---|
| G1 清单齐全 | 清单 **24** 道 · 账本 **24** 道 · 缺 **0** |
| G2 退出码 | 非零且未声明 **0** · 已声明 **2**（`m11:gates` 按设计非零 · `m5:budget:verify` 继承缺陷 `L-M11-13`） |
| G3 不过期 | 账本 head = 当前 head = `b544e2a4e267` |
| G4 与 manifest 对账 | 通过 **11** 道 · 不一致 **0** |
| G5 账本形状 | schema `m11-regression-ledger@1` · 24 条 · 每条带 argv/exitCode/durationMs/输出哈希 |
| G6 性能读数 | 受影响门总耗时 **53 s** · 最慢三道 `m4:verify` / `m5:budget:verify` / `m11:observability:verify` 各 4 s |

### 3.3 ⭐ G4 抓到的一条**真区分**：**捕获 ≠ 判决**

```text
现象：G4 报 `m11:wp0:verify` "manifest 说 failed=4 而账本 exit=0"。
真相：WP0 的基线门默认跑 **`before` 阶段**（断言"实现还不存在"），
      它的 verdict 是 `PENDING-AFTER-SAMPLE`、**按设计 exit 0**，
      而 `counts.failed=4` 记的是"开工前的断言现在不成立"（P2/P6/C2/C3/C5 一类）——
      那是**起点读数**，不是里程碑失败。
⇒ 两处修法（都在判据侧）：
   ① `m11:gates`：只把"跑到判决"（`phases` 含 `after`）的读数当判决；
      纯 `before` 的记为**捕获**并跳过 ⇒ wp0 取到的是**判决代**（32/32）。
   ② `m11:regression:verify`：捕获类门**跳过** counts 对账（退出码说"跑完了"，
      counts 说"断言成立几条"，两者**不必**自洽）。
⇒ 教训：**退出码与 counts 是两个不同的对象**；把它们当成一件事就会报假不一致。
```

---

## 4. 下一轮（WP12 或收口）

```text
WP12：`m11:activation:verify` / `m11:activation:readback`（副本 cutover / 回滚 / 首次只读读回）
      —— 需**独立授权**（碰生产库副本与 `.env`）。
收口：`docs/m11/M11-Gate-Decision.md`（14 槽判定模板）· `M11-Acceptance-Report.md` ·
      `M11-Known-Limitations.md` · `M11-Activation-Candidate.md`
⚠️ 人审（§12.2 第 6 槽）仍是收口的必要条件：卡片在 `artifacts/m11/local/review-cards.md`。
```

---

## 5. 受影响旧门的回归读数（本轮未改 src）

```text
kernel:test EXIT 0 · kernel:verify EXIT 0 · m4:test 258/0 · m4:verify 142/0 ·
m4.5:test EXIT 0 · m5:test EXIT 0 · m10:context:verify 26/26 · m10:m11:verify 11/11
m11：见 §1.1（聚合读数）—— 离线 13 道全 PASS。
⚠️ `m5:budget:verify` 仍红（`L-M11-13`，pre-WP8 实测复现 ⇒ 归 M5/M9.5 线）。
```
