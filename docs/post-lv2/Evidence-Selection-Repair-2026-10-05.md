# 证据选档与发射面修复（`AUD-20261005-01/02/03`）

状态：**`CLOSED`（三项各自的关闭条件都已满足，读数见 §4）**。工作包：`POSTLV2-EVIDENCE-SELECTION`。日期：**2026-10-05**。
审计来源：[技术债复审与影响审计](../Tech-Debt-Audit-2026-10-05.md) §3 的 `AUD-20261005-01/02/03` 三行。
登记册：[§0t](../Tech-Debt-Register.md)（本轮追加）。

> ⚠️ 本文**只**主张它逐字写出的东西。所有"已修"都指**所列的边界**；旧 FAIL / INVALID / NOT RUN 与用户风险接受裁定
> **一律不回写**（`TD-16`）。真实库**全程未打开**；本轮**零模型调用**、**零真实出站**。

---

## 1. 为什么要修（一句话各自）

| 编号 | 审计原文（事实） | 本轮的判断 |
|---|---|---|
| `AUD-20261005-01` | M10.1 assembly 三份同 HEAD/同日档，23/24 FAIL 与两份 24/24 PASS **缺精确结束时间或 supersedes**，汇总报 `AMBIGUOUS` | 这是**发射面**缺口：门自己没留下可裁定的身份 ⇒ 修在**发射侧**（补 `started`/`ended`/`supersedes`），**不**回写旧档、**不**用 mtime 猜、**不**人工挑 PASS |
| `AUD-20261005-02` | `scripts/m10-gates.ts` 仍按 manifest `mtime` 排序；`m11.1-gates.ts` 对不可解析日期仍用目录 `mtime` | 这是**判据面**缺口：同一缺陷在**三个**聚合门上各出现过一次 ⇒ 抽成**唯一一份**实现 + 三段式自证 |
| `AUD-20261005-03` | `PL2_GATES` 只有 10 个 S8/DB 门；取消连续性、目标期限/并行、semantic、role-tool 等**有脚本但不在统一调度里** | 把**逐条核过离线安全**的门接进 manifest lane 与 affected 路由；**不**把 Live/真实库/环境依赖入口塞进快车道 |

---

## 2. `AUD-20261005-02`：选档器（`TD-23` 同族）

### 2.1 同一个缺陷出现过三次 ⇒ 现在只有一份实现

新增 `scripts/gate-evidence-select.ts`。三段强弱判据（**先到先得**，并把用的是哪一段**写进读数**）：

```text
① reported-time          读数 / 清单自报的 ended / finishedAt / generatedAt / started
② head-commit-time       这一档测的是哪个提交（清单 head，否则从 runId 的 -<head12>- 提取）
③ evidence-commit-time   该证据文件在 git 里的提交时刻（同一 head 重跑时用它分先后）
④ manifest-date          清单只有 date（天粒度，最弱）
⑤ none                   具名降级：什么时间戳都没有 ⇒ 只按 runId 字典序，调用方必须打印出来
```

**`mtime` 一个字节都不参与**（本模块里没有任何 `statSync(...).mtimeMs`；连"可注入的 mtime 版本"都**刻意不留** ——
留着就是留一条"以后可以切回去"的口子）。使用者与改动：

| 文件 | 改动 |
|---|---|
| `scripts/gate-evidence-select.ts` | **新增**：唯一一份身份优先实现（`basisTime` / `rankReadings` / `pickLatest`） |
| `scripts/m10.1-gate-select.ts` | **改为委派**共享实现；它自己的两件局部语义（非权威档过滤 · 按目录前缀扫描）留在本地。导出 API **逐字不变** |
| `scripts/m10-gates.ts` | `mtimeMs` 排序**删掉**；改为共享选档。新增 `selectionBasis` / `tiedWith` / `ambiguousSelection` 三个读数，并新增降级 / 并列的**具名打印** |
| `scripts/m11.1-gates.ts` | 删掉 `statSync(目录).mtimeMs` 回退；改为共享选档。`inspectM111Run` 只对**选定档与它的并列组**跑（不整档扫） |

**并列（时间相同）⇒ 按 `runId` 裁决，但并列组里判定不同就失败关闭**：
`m10-gates` 报 `INVALID`（它的标签集只有四个词），`m10.1:gates` 报 `AMBIGUOUS`，`m11.1-gates` 报 `INVALID`。
**刻意不优先取 PASS 的那一份** —— 归属必须如实。

### 2.2 三段式自证：`scripts/postlv2-gate-selection-verify.ts`（新门）

`pnpm postlv2:gate-selection:verify` —— **11/11 PASS，EXIT 0**。它判的是**选档器本身**（不属于任何一道业务门）：

| # | 段 | 读数 |
|---|---|---|
| ① | **正控**：自报结束时间更晚者胜（目录名字典序故意写反） | `p-aaa-newer` 胜 · `basis=reported-time` |
| ② | **负控**：`mtime` 反转且两份都没有时间戳 ⇒ 仍不按 mtime | 选 `q-zzz-fail-old-mtime`（FAIL）· `basis=none` |
| ②′ | **反证**：同一组夹具下，一个**故意按 mtime 排**的对照排序选到**另一份** | 对照选 `q-aaa-pass-new-mtime`（**PASS**）⇒ 两种排法**结论相反** ⇒ 负控**不是空转的** |
| ③ | **恢复**：没有候选 ⇒ `undefined`（不是默认选一个） | 共享与 m10.1 两条路都是 `undefined` |
| ④ | **诚实性**：并列且判定不同 ⇒ `conflictingVerdicts=true`；并列且判定相同 ⇒ `false` | `true` / `false` |
| ⑤ | **诚实性**：干跑档被滤掉（正式档 FAIL 时照样报 FAIL） | 选 `r-real-fail` · 滤掉 `['r-dry-pass']` |
| ⑥ | **m11.1 聚合面**：把夹具喂给**真的** `summarizeM111Evidence()` | 更晚的 FAIL 不被更早的 PASS 取代 · **同刻一份 FAIL + 一份 PASS ⇒ `INVALID`** · 移掉并列那份 ⇒ 恢复 |
| ⑦ | **结构锁**：四个生产文件里没有 `mtime` / `statSync(`（去注释） | 0 处命中；**负控**：往源码副本注入一处 `statSync(x).mtimeMs` ⇒ **必须响**（实测命中 2 处）⇒ 恢复后又安静 |

### 2.3 ⚠️ **实测发现：旧实现确实选错了**（不是理论风险）

`scripts/postlv2-gate-selection-verify.ts` 的报告读数（**不作断言**，见 §5 的边界）与一次独立复核给出：

```text
① `artifacts/m10/**` 的 30 个 testType 里，**每道门最新那一组**"并列且判定不同"的有 **3 道**
   ⇒ 与 `m10:gates` 现在报的 INVALID 数量**逐一对应**（`long-verify` · `measurement-verify` · `smoke-live`）
② 旧实现（按 manifest.json 的 mtime 取最新）为 `long-verify` 选中的是 `…-f4a2345ecdc5-d9ea` ——
   而 `f4a2345ecdc5` **不是最新的 head**（`a027b5987e61` 更晚）。
   换句话说：旧"最新一份"跟的是**检出顺序**，不是提交先后。
③ 那 3 道门在旧读数里是 PASS；`long-verify` 的 20 个同 head 组里有 **10 组**判定**既有 PASS 也有 FAIL**。
```

⇒ 修复后这 3 道门**如实报 `INVALID`**（归属不明），而不是继续靠 mtime 撞一个好看的结论。
**这是本轮新增的读数，不是"把门弄红了"**：旧绿建立在一次未受控的选档上。
要让它们重新可裁定，需要各自**重新产出一份带 `ended` 的读数**（见 §2.4）；本轮**不**重跑那些门（`long-verify` / `smoke-live` 面很重）。

### 2.4 发射面：M10 清单从此自带正式结束时刻

`scripts/m10-evidence.ts` 的 `writeM10Manifest`（**唯一**写清单的地方）在封印前补 `ended`（ISO-8601，毫秒），
调用方可以显式覆盖。与既有 `injection` 标记**同一条思路**：三十多个门各自填就会各自忘 ⇒ 在唯一出口盖章。
`M10_MANIFEST_REQUIRED_FIELDS` **不**因此变化（`ended` 是选填 ⇒ **历史档仍然合法**、不会被判非法）。

⚠️ 判据**只对以后**的档生效 —— **历史档一个字都不回写**。

---

## 3. `AUD-20261005-01`：M10.1 装配门的发射面

`scripts/m10.1-assembly-verify.ts` 现在发射：

```text
started / ended   精确到毫秒（payload 与 manifest 都写）⇒ 选档器走到最强的一段（reported-time）
supersedes        被本次运行取代的那一份 —— 由**同一套身份判据**算出的"此前最新一份"
                  （不按 mtime、不挑 PASS；算不出来就如实 null，不许编）
```

本轮新 run：`m11-m10-1-wp6b-assembly-20261005-a5de36f8e879-f1e1`

```text
verdict   = PASS（24/24）
started   = 2026-10-05T16:02:04.930Z
ended     = 2026-10-05T16:02:05.192Z
supersedes = m11-m10-1-wp6b-assembly-20261005-b223eeb023d4-b5ce
```

⇒ `pnpm m10.1:gates`：**必选门 18 道 · 有读数 18 · 未运行 0 · 未通过 0 · overall = PASS（EXIT 0）**，
选中的装配档是上面那一份、依据 `reported-time`、**无并列**。

**旧档全部原样保留**（实测复核）：那份 23/24 FAIL（`…-b223eeb023d4-74fd`）与另外两份同 head 的档
**都没有 `ended`、`supersedes` 都是 `null`**，一个字节未动。

---

## 4. `AUD-20261005-03`：post-Lv2 新增离线控制接入统一调度

### 4.1 新 lane：`postlv2-controls`（6 道，全部 `serial`）

| 门 id | 判它什么 | 为什么不进 `offline` lane |
|---|---|---|
| `postlv2:gate-selection:verify` | 选档器自证（本文 §2.2） | 不属于 `m4.5:ci` 清单 |
| `postlv2:goal-deadline:verify` | 目标理解期限（成功/错误 body · 晚结果零写入 · 8s） | 同上。⚠️ **刻意真等 ~8s** |
| `postlv2:goal-parallel:verify` | prepare 与 recall 并行（提交仍在 recall 后 · 幂等） | 同上 |
| `postlv2:role-tool:verify` | 角色工具决策目录与契约（16 项能力四态） | 同上 |
| `postlv2:role-tool:path` | 角色工具限定路径（53/53） | 同上。⚠️ **声明 serial**：用户正在聊天时会写 `data/pglite`，它的只读 mtime 比对会**假红** |
| `postlv2:sequence-continuity:verify` | `R-54` 的取消/失败序号连续性（7 场景 + 旧缺陷复现负控） | 同上。⚠️ **故意慢**（7 次 `src/main.ts` 启动）；证据目录名**固定** ⇒ 重跑**覆盖**同一份文件 |

### 4.2 **有意不登记**的门（每一条的原因都是可复核的事实）

```text
postlv2:semantic:verify            依赖 gitignored 的本地编码器资产（evals/m9.5/embedding-manifest.json
                                   + artifacts/m9.5/local/embedding-lab/models）⇒ 资产不在就具名 FAIL
postlv2:semantic:production:verify **读活的 data/pglite**（cpSync 真库副本）；用户正在聊天时复制不静止
                                   ⇒ 直接崩且**不落证据**（抛在 try 之外）
postlv2:role-tool:matrix           依赖三处 gitignored 本地资产（python venv / OCR 图 / rapidocr 运行时），
                                   任一缺 ⇒ notRun ⇒ NOT PASS；且真跑 python + OCR（长）
postlv2:role-tool:known-dirs       它**自己**声明读数依赖本机环境；且会把**用户真实桌面路径**
                                   写进仓库跟踪的证据里
postlv2:goal-thinking-eval         **真的出站**（真 fetch；需 DSH_TEST_WRAPPER=1 + 测试凭证）
```

> 纪律与 `affected-map.ts` 里"搜索层行"**刻意只带两道门**同源：让快车道为**与本次改动无关**的原因变红
> = 训练人忽略这条 lane。它们仍可用 `pnpm <id>` **显式**跑；"显式"与"自动带出"是两件事。

### 4.3 affected 路由（实测）

用 `planAffected()` 直接对代表性路径求值（这就是 `--lane affected` 用的那个函数）：

| 改了什么 | 推导出的门数 | 带出的 post-Lv2 控制 |
|---|---|---|
| `src/main.ts` | 4 | `postlv2:sequence-continuity:verify`（`R-54` 的修法就在这个文件里） |
| `scripts/gate-evidence-select.ts` | 2 | `postlv2:gate-selection:verify` |
| `src/kernel/app/goal/understanding.ts` | 27 | `postlv2:goal-deadline:verify` · `postlv2:goal-parallel:verify` |
| `src/kernel/action/tool-catalog.ts` | 7 | `postlv2:role-tool:verify` · `postlv2:role-tool:path` |

四条都 `escalateToOffline=false`、`unmatchedPaths=0`。

### 4.4 门执行器自证 + **真跑一次这条 lane**（实测）

`pnpm gates:verify` = **PASS（检查 51 项 · 失败 0）**，其中 `G1`（每个 `GateSpec.id` 都在 `package.json.scripts` 里）
与 `G2`（每个 `argv` 的仓库内 `.ts` 都真实存在）覆盖了本轮新增的注册。

`pnpm gates:run --lane postlv2-controls --serial --fail-fast --skip postlv2:sequence-continuity:verify`
（runId `fast-2026-10-05T16-06-03-768Z`，**EXIT 0**）：

| 门 | 结果 | 墙钟 |
|---|---|---|
| `postlv2:role-tool:path` | **PASS** | 36.7s |
| `postlv2:goal-deadline:verify` | **PASS** | 8.5s |
| `postlv2:gate-selection:verify` | **PASS** | 5.6s |
| `postlv2:goal-parallel:verify` | **PASS** | 4.4s |
| `postlv2:role-tool:verify` | **PASS** | 0.4s |

```text
总计：5 道 · PASS 5 · CACHED 0 · FAIL 0 · SKIPPED 0 · TIMEOUT 0（墙钟 56s，串行）
门执行器还原：git 还原 0 条 · 删除"本次新弄脏的未跟踪项" 5 条 · 运行前已脏而保留 365 条
```

⇒ 这条 lane **真的可执行**，不是只登记在清单里；`serial` 声明与实测（56s 串行）一致。

---

## 5. 本轮实际执行（可复核）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | **EXIT 0** |
| `pnpm postlv2:gate-selection:verify` | **11/11 · EXIT 0** |
| `pnpm m10.1:gates` | **18/18 · overall = PASS · EXIT 0** |
| `pnpm m10.1:measurement:verify` | **7/7 · EXIT 0**（含 ⑤ 选档器三段式，委派重构后不变） |
| `pnpm m11.1:gates:verify` | **EXIT 0**（15 项控制全过） |
| `pnpm m11.1:gates` | **NOT PASS**（`G1～5/G8/G9/G11 INVALID` · `G6/G7 NOT RUN` · `G10 PARTIAL`）—— **与审计基线一致，未被本轮改变** |
| `pnpm m10:gates` | 门判定 **PASS 24 · FAIL 0 · NOT RUN 1 · INVALID 3**（3 道 = §2.3 的并列冲突）；本门自证 **10/10** |
| `pnpm m10:evidence:verify` | **11/11 · EXIT 0**（1738 个 run 目录 · 422 个 FAIL 档**全部有具名解释**：注入负控 311 · 被第二代取代 111）—— 这是 `ended` 发射改动的**回归证据**：`validateM10Manifest` / `payloadSha256` / FAIL 档账目都没被影响 |
| `pnpm m10:docs:verify` | **13/13 · EXIT 0** |
| `pnpm gates:verify` | **PASS 51/51** |
| `pnpm gates:run --lane postlv2-controls --serial --fail-fast`（跳过慢门） | **5 道 · PASS 5 · FAIL 0 · EXIT 0**（墙钟 56s；runId `fast-2026-10-05T16-06-03-768Z`） |

真实库：**全程未打开**。本轮所有门要么零数据库，要么走 `isolateDatabase()` 的 `%TEMP%` 一次性沙箱。

> ⚠️ **一处如实披露**：本门在**开发过程中**先跑出过两份失败读数（8/11、10/11），原因是**量具自己的夹具造得不具判别性**
> 与**夹具只放了一份档**（都不是被测实现的问题）。它能被抓出来正是三段式的用途；修正后第三份是 **11/11**。
> 前两份（`gate-selection-2026-10-05T15-59-57-146Z` / `…16-00-36-283Z`）是**同一会话内几分钟前自造的开发期草稿**，
> 对应的量具代码已改，**不对应任何当前代码状态**，因此**已删除**；留在库里只会变成"无从归属的历史读数"
> —— 而"无从归属"正是本轮要消灭的东西。保留的那一份是 `gate-selection-2026-10-05T16-01-05-526Z`。

---

## 6. 本条**不**主张什么（边界）

- **不**主张 `m10-gates` 的 `overall` 变好了：它从"3 道静默选档"变成"3 道如实 `INVALID`"——
  这是**更诚实**，不是**更绿**。要让那 3 道重新可裁定，需要各自重新产出一份带 `ended` 的读数。
- **不**主张那 3 道门"真的红了"：`INVALID` 说的是**归属不明**（同 head 并列、判定不同），
  不是"被测功能坏了"。两者在报告里**必须分列**。
- **不**主张 `AUD-20261005-01` 的修法"关闭了 M10.1 的全部选档风险"：
  它关闭的是**这一道门**的发射缺口；别的门若仍同 head 同日多档，仍会走各自的 §4 逻辑。
- **不**主张 `AUD-20261005-03` 之后"post-Lv2 全都有持续回归"：本轮接进来的是**6 道**；
  §4.2 列的 5 道仍**只在显式调用时**跑（各有具名原因）。这就是本条的残余。
- **不**主张 `m11.1-gates` 的读数被改善：它仍是 `NOT PASS`，且 `G1～5/G8/G9/G11` 的 `INVALID`
  是**来源指纹变**造成的——那属于另一条工作（冻结 M11.1 候选 + 补语义/行为/混合长程测量）。
- **本轮未跑** `postlv2:sequence-continuity:verify`：它的证据目录名**固定**，重跑会覆盖已提交的那一份；
  按 `AGENTS §7`，那是"同一道门重跑"而不是"历史证据被改写"，但本轮**不做**这件事，
  以免与"审计轮刻意不覆盖旧证据"的读法混淆。它的登记（lane + affected 路由）**已完成并已实测**。
- **不**主张 `ended` 的引入改变了任何历史档：判据只对以后的档生效，历史档一个字未改。

---

## 7. 载体

- 选档器实现：`scripts/gate-evidence-select.ts`
- 三段式量具与本文的读数来源：`scripts/postlv2-gate-selection-verify.ts` · `artifacts/post-lv2/gate-selection-*/reading.json`
- 三个聚合门：`scripts/m10-gates.ts` · `scripts/m11.1-gates.ts` · `scripts/m10.1-gates.ts`（+ `scripts/m10.1-gate-select.ts`）
- 发射面：`scripts/m10-evidence.ts`（`ended`）· `scripts/m10.1-assembly-verify.ts`（`started`/`ended`/`supersedes`）
- 调度面：`scripts/gates/manifest.ts`（`PL2_CONTROL_GATES` + `postlv2-controls` lane）· `scripts/gates/affected-map.ts`
- 登记册：[`docs/Tech-Debt-Register.md`](../Tech-Debt-Register.md) §0t
