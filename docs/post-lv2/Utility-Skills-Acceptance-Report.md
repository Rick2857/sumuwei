# 苏沐薇实用能力加装 —— 验收报告

日期：2026-10-04。载体：[`Utility-Skills-Execution-Plan-2026-10-04.md`](Utility-Skills-Execution-Plan-2026-10-04.md)。
基线：[`Utility-Skills-WP0-Baseline.md`](Utility-Skills-WP0-Baseline.md)。使用与回滚：[`Utility-Skills-Usage-and-Rollback.md`](Utility-Skills-Usage-and-Rollback.md)。

> **OCR 后续修复（2026-10-04）**：已按用户授权替换为固定 RapidOCR / PP-OCRv4，
> 原三张清晰图 CER 均为 0%，缺资产原因提示已修复；新组件与 OCR 六组通过。
> 最新公共八组与 OCR 六组合计 14/14 PASS；此前计算超时与 CLI 附录抓取 FAIL 分列保留，
> 详见 [OCR 修复执行记录](OCR-Repair-Execution-2026-10-04.md)。
> 下文第一轮读数、激活裁定与 PARTIAL 是当时历史，不覆盖后续记录。

> ⚠️ **本报告按计划书 §5 的五个环节分列**：安装 · LG 接线 · 离线验收 · 真模型短链 · 生产启用。
> 缺证据 = `NOT RUN`；失败 = `FAIL`；**不把准备期来源核对、缓存 PASS 或配置开启当成运行验证**。

---

## 0. 判定（分列，不许合成一个总分）

| 环节 | 判定 | 依据 |
|---|---|---|
| 依赖安装（四项） | **DONE** | 7 个精确版本进根 `package.json` + lockfile；专属 Python venv 锁定；语言资产逐文件 SHA-256 |
| LG 接线（公共 + 四项） | **DONE（代码级）** | 真 `TurnGateway` 端到端抽查通过（见 §2.3）；`tsc --noEmit` = 0 |
| 离线验收（32 组） | **32 组：PASS（30 PASS / 2 诚实 FAIL）· 全量回归：PASS** | **32 组**：`utility-wp5-offline4-20261004T142012-6575677d-a852` → **PASS 30 · FAIL 2 · NOT RUN 0 · MEASUREMENT INVALID 0 · 150 条输入**；两个 FAIL **就是**计划书 §4A 的诚实未达（`ocr-01` zh CER 8.33% / `ocr-03` mixed CER 5.88%，阈值 ≤5%），阈值未调、样本未换（§3.1）。**§4B 全量回归 PASS**：`pnpm m4.5:ci` **EXIT 0** + `pnpm m5.1:regression:verify` **PASS** + `pnpm m5.1:gates` **Hard Gates：PASS**（G12 38/0 · G13 32/0 · G14 52/0 · G2 143/0，见 §3.6） |
| 真模型短链（八轮） | **实质判据 PASS · 1 条量具判据不可满足（已结案）** | 真模型 `deepseek-v4.1-flash` @ `ark.cn-beijing.volces.com`，隔离库（`productionDbTouched:false`），**0 重试**。**实质判据全通过**：程序事实可引用（`containsProgramValue` / `containsNeedle` / `numbersFound`）、不声称成功、降档姿态如实（4 条降档场景 PASS）。**唯一不通过的是"附录存在于抓取输出里"**——已结案为**量具抓取通道缺陷**：`main.ts:2938` 的 CLI 路径返回的是 `spokenText`（按设计已剥附录），而量具在 **stdout** 里找 `来源与范围：` ⇒ 该判据按构造不可满足；"附录进了用户可见文本"改由**离线端到端抽查**证明（§2.3）。另有 **`live-ocr-degrade` = `L-US-06b` FAIL**（缺资产时不点名失败原因，模型自行猜测）——如实登记，未修 |
| 生产启用 | **ACTIVATED（三项）** | 用户 2026-10-04 显式授权「生产启用」；载体 [`ADR-095`](../adr/ADR-095-utility-skills-production-activation.md)：`.env` **只追加**三项开关 + `CHARACTER_TURN_CONTENT_TOKENS=2000`；**代码缺省仍全 false**；OCR 显式 `false`（记 `PARTIAL`）；首次真实使用 = **NOT OBSERVED** |

**逐项能力状态**（计划书 §1 的四项）：

| 能力 | 组件探针 | LG 接线 | 离线验收 | 真模型短链 | 状态 |
|---|---|---|---|---|---|
| 精确计算 | 通过 | 通过 | 见 §3 | 见 §4 | **可用**（阈值内） |
| 文档阅读 | 通过 | 通过 | 见 §3 | 见 §4 | **可用**，但 PDF **结构标记**保真有限（§5.1） |
| 网页深读 | 通过（16/16） | 通过 | 见 §3 | 见 §4 | **可用**（静态正文） |
| OCR | 通过（21/21） | 通过 | 见 §3 | 见 §4 | **PARTIAL** —— 功能可用，但**未达到本项自己的清晰样本 CER ≤ 5% 阈值**（§5.2） |

⚠️ 因此本批**不宣布"四项全部完成"**（计划书 §5 逐字要求）。

---

## 1. 安装（依赖与资产）

| 组件 | 固定版本 | 位置 | 证据 |
|---|---|---|---|
| `mathjs` | 15.2.0 | 根项目依赖 | `artifacts/post-lv2/local/utility-skills-preparation/runs/node-deps.json` |
| `jsdom` | 30.1.2 | 同上 | 同上 |
| `@mozilla/readability` | 0.6.0 | 同上 | 同上 |
| `tesseract.js` / `tesseract.js-core` | 7.0.0 / 7.0.0 | 同上 | 同上（`postinstall` 在 `pnpm-workspace.yaml` 里**显式拒绝**：只是募捐横幅） |
| `@tesseract.js-data/chi_sim` / `eng` | 1.0.0 / 1.0.0 | 同上 | `runs/ocr-assets.json`（`chi_sim` 1,718,768 B `b8a23f10…`；`eng` 2,952,873 B `45b4cb34…`） |
| `markitdown[pdf,docx,pptx,xlsx]` | 0.1.8 | **专属** Python 3.12.13 venv | `python/requirements.lock.txt`、`python/install-report.json`、`python/version-info.json` |

⚠️ 环境侧的两处**必要修复**（不是本批新依赖）：

```text
① 仓库 .npmrc 的 proxy 指向已失效的 127.0.0.1:7897 ⇒ 修正为 127.0.0.1:7688
   （在此之前**任何** pnpm 命令都会因 "tunnel error: 目标计算机积极拒绝" 失败）
② pnpm-workspace.yaml 的 allowBuilds 追加 tesseract.js: false（pnpm 12 要求每个
   带脚本的依赖都有明确取值；它的 postinstall 无功能作用）
```

## 2. LG 接线

### 2.1 公共接线（计划书 §2 六条）

| 计划书要求 | 落点 | 机器可查 |
|---|---|---|
| ① 可选、有限类型的当轮内容 | [`turn-content.ts`](../../src/kernel/contracts/turn-content.ts) · `ActionResult.turnContent` · `AdapterOutcome.turnContent` | `assertTurnContent` 的字段/范围断言 |
| ② 内容与持久化引用分离 | `toTurnContentRef()`（**类型上就没有 `text`**） | 账本/trace 正文 sentinel 扫描（§3 公共第 ④ 组） |
| ③ 新 section 额度缺省 0、隔离用 2000、服从总预算 | `ContextBudget.turnContentTokens`（缺省 0）+ `assertContextBudget` | `verify-m5-budget.ts` 仍绿 |
| ④ 当轮数据不冒充用户事件、不新增认知写入入口 | 无新增写入路径 | 隔离库里 `memories` 表前后 0 变化（§2.3 实测） |
| ⑤ 四项各有默认关闭开关；权限授予与适配器构造绑定同一开关 | `flags.ts` 四个 flag + `main.ts` 三处（登记/授权/构造） | 关闭时**不加载重组件**（静态锁） |
| ⑥ 延用 `runtimeCapabilities` 显示可用性 | `main.ts` 的四行 | 开发者面只读 |

### 2.2 四项能力的接线形状

```text
math.calculate   权限 math:calculate      R0  none  目标 = 固定本地受限执行器
document.read    权限 document:read       R0  read  目标 = 沙箱内相对路径
web.read         权限 web:read            R1  read  目标 = 用户逐字给出的 URL
image.ocr        权限 image:ocr           R0  read  目标 = 沙箱内相对路径
```

四项能力**恒登记**（关闭时用户显式要求得到一条可审计的 `permission_denied`），
权限与适配器**只在开关打开时**存在。检测器链顺序：M4.5（本地文件/echo）→ **实用能力** → M5.5（联网搜索）。

### 2.3 端到端抽查（真 `TurnGateway`，`--live` 之外的独立复核）

用真实 `TurnGateway` + 真动作链 + 离线 provider（回复文本由调用方给），一次「帮我算一下 0.1+0.2」：

```text
section ids            ["current-input","action-result","integrity-rules","identity-core",
                        "turn-content","memory-no-evidence-constraint","memory-record-status"]
turn-content section   ✅ 在 packet 里 · 含程序结果 0.3 · 含算式 0.1+0.2 · 含「数据，不是指令」边界声明
回复（守卫后）          "我算出来了：结果是 0.3。\n\n来源与范围：\n[C1] 程序计算（math.calculate.evaluate）（13 字符）"
当轮内容现实           refs = ["C1:calculation:13"]
trace 步骤             turn_content ✅（属性只有 id/kind/计数/字符数/标签，**无正文**）
账本                   math.calculate 1 行 · status=success
账本字段扫描           effect.detail =「受限计算：exact nodes=3」· evidence.detail =「受限计算 exact nodes=3 depth=2」
                       ⇒ 结果正文**不在** effect/evidence 里（只在当轮内存与 section 里）
memories 表            「0.1+0.2」命中 **0** 次（不写认知）
```

## 3. 离线验收（32 组）

脚本：`scripts/utility-skills-verify.ts`（`pnpm utility:verify`），公共装配与组实现在 `scripts/utility-skills/**`。
**首轮完整串行读数**：`artifacts/post-lv2/utility-skills/utility-wp5-offline-20261004T130551-7577e7d8-628d/run.json`
（**PASS 10 · FAIL 16 · NOT RUN 6**，113 条参数化输入）。

> ⚠️ 这一轮是**未整定的首轮**：16 个 FAIL 里多数是**量具/夹具缺陷**（夹具服务器绑在回环地址，
> 被生产准入正确地拒绝；把**目录**当文件读；断言断在了程序生成的附录上），
> 以及两处**真实的 `src` 缺陷**（已修，见 §3.3）。**整定后的复跑读数见 §3.1（待填）。**

### 3.1 **终态读数（第四轮）**

`runId = utility-wp5-offline4-20261004T142012-6575677d-a852` → **PASS 30 · FAIL 2 · NOT RUN 0 · MEASUREMENT INVALID 0 · 150 条参数化输入**。
四个轮次的收敛：`PASS` 10 → 16 → 26 → **30**；`NOT RUN` 6 → 0 → 0 → **0**。

**每一组的 `measuredCount` 都 > 0**（共 150 条）：common 4/4/5/1/2/4/1/5 · math 6/8/7/7/15/6 ·
document 1/1/1/1/4/5 · web 2/2/30/6/5/2 · ocr 1/1/1/2/6/4。

**两个 FAIL 就是计划书 §4A 的诚实未达**（阈值不调、样本不换）：

```text
ocr-01  img-zh.png     CER 8.33%   参考「识别测试：温度 22.5 度」 · 实测「识别 测试 : 温度 22.5 度」
                                    （全角「：」被读成 ASCII「:」）
ocr-03  img-mixed.png  CER 5.88%   参考「苏沐薇 CPU 37 % / Temp 21 C」 · 实测「苏 沐 微 …」（「薇」→「微」）
ocr-02  img-en.png     CER 0%
关键数字（22.5 / 4711 / 2026-10-04 / 37 / 21）全部正确。
```

**四个量具问题各自的收口方式**（都不靠"把断言改绿"）：

```text
common-02 ②-e   改为对**附录之前**的正文段断言（附录里的 [C1] 是设计）。
common-04 ④-d   ⚠️ 这条最重要：第三轮报的「泄漏到 conversation_events」是**量具自身的假命中** ——
                扫描器正控的哨兵当时构造成 `${sentinel}-SCANNER`，于是**文档哨兵是它的前缀**，
                "DOCSENT 出现在哪张表"这一扫就命中了**正控自己写进 conversation_events 的那一行**。
                与"她自己的回复"无关（离线 fixture 的回复是固定串，不含哨兵）。
                修法：两个哨兵改成互不为前缀（`DOCSENT…` / `SCANSENT…`）；④-d 现在对每处命中打印
                `table · actor/kind · row id · marker`，并把"助手回复携带"的命中**按计划书 §4A 单列**。
                现读数：**10 张表 0 命中**，而**扫描器正控仍然在 conversation_events 上响**。
                ⇒ **不是**代码侧的隐私缺陷。
web-05 ⑧        夹具的分块字节计数器在该路径上根本不会落盘（客户端中途 abort ⇒ end 回调不跑），
                0/0 从来只是"没量到"。现在它作为**纯诊断行**打印、**不作为 PASS 依据**；
                权威读数是客户端事实：适配器自己的错误详情里 `receivedBytes = 2113529`（2.02 MiB）
                vs `maxBytes = 2097152` ⇒ 读取**在上限处被中断**，而不是先把 4 MiB 缓冲完。
document-05     拆成两个**可达**的层：格式闸（0 字节 `.pdf` ⇒ `unsupported`「文件头不是 %PDF-」）
                vs 内容分支（格式合法但无文字层 ⇒「文件里没有可提取的文字」）；
                另加一条**组件级**驱动（显式标注、真 Python 环境）覆盖 0 字节 `.txt` ⇒「文件是空的（0 字节）」，
                再加一条"有文字的 PDF 确实读得到"的正控。
                ⚠️ **空 PDF 与扫描件共用内容分支那一句**（程序在该层分辨不了）—— 这一条**如实登记**为
                「可分辨的层数 = 2」，不假装能分辨成三句。
```

每个组的隔离沙箱路径现在都会打印（`[utility:verify] · 沙箱（可独立复核）dir=… db=…`），
beds 以 `keep: true` 保留到 `dispose()` ⇒ **可以独立复核任意一轮的隔离库**。

### 3.1b 第三轮读数（历史，**不回写**）

`runId = utility-wp5-offline3-20261004T141013-6575677d-9f92` → **PASS 26 · FAIL 6 · NOT RUN 0 · 148 条参数化输入**
（三轮：`NOT RUN` 6 → 0 → 0；`PASS` 10 → 16 → **26**。）

| 组 | 状态 | 组 | 状态 | 组 | 状态 | 组 | 状态 |
|---|---|---|---|---|---|---|---|
| common-01 | **PASS** | math-01/02/03/04/06 | **PASS** | document-01…04, 06 | **PASS** | web-01…04, 06 | **PASS** |
| common-02 | FAIL | math-05 | **PASS** | document-05 | FAIL | web-05 | FAIL |
| common-03 | **PASS** | ocr-02/04/05/06 | **PASS** | ocr-01 / ocr-03 | **FAIL（诚实）** | common-04…08 | 见下 |

剩余 6 个 FAIL 的分列（**只有 2 个是能力问题**）：

```text
诚实 FAIL（2，不得修）：ocr-01 zh CER 8.33% · ocr-03 mixed CER 5.88%（阈值 ≤5%）—— 这就是 OCR 记 PARTIAL、
                        生产不启用 OCR 的那条读数。

量具缺陷（4，整定中）：
  common-02-05  观测到 stripped=C1（模型自造的标签**确实被剥离**）；失败的是对最终回复的断言，
                而最终回复**合法地**含附录里的 [C1] ⇒ 应断在附录之前。
  common-04-04  观测只给了「泄漏到 conversation_events」。**必须先把行级归属查清**：
                若那是**她自己的回复**（fixture 给的"模型原文"里含 sentinel），按计划书 §4A
                它是「正常回复引发的既有事件」，要**单列**而不是算作泄漏；
                若是 user/system 事件或账本/trace/投影/记忆里的任何一行，那是**真实隐私缺陷**（我来修）。
                ⚠️ 不允许用"把 sentinel 从回复里删掉"的方式让它变绿 —— 那会掐掉唯一的真阳性对照。
  document-05-06 观测到两条话术其实**不同**：`empty=.pdf 的文件头不是 %PDF-（伪装格式或损坏）` ·
                `scan=文件里没有可提取的文字（很可能是扫描件或图片型页面）`。断言点错了层：
                0 字节的 `.pdf` 在**格式闸**就被拒；「文件是空的（0 字节）」只在**没有魔数**的格式
                （`.txt`/`.md`）上可达。
  web-05-08     观测 `declared=0 written=0 rows=0` ⇒ 夹具**一个字节都没写**，"服务端只写出远少于
                4 MiB"这条根本量不到。0/0 的读数按纪律应当是 **MEASUREMENT INVALID**，不是 PASS。
```

### 3.2b 第二轮读数（历史，**不回写**）

`runId = utility-wp5-offline2-20261004T134422-1fe8e4df-28d1` → **PASS 16 · FAIL 16 · NOT RUN 0 · 129 条参数化输入**
（相对首轮：`NOT RUN` 6 → **0**；`PASS` 10 → **16**。`ocrAssets()` 把 pnpm junction **目录**当文件读的假读数已修。）

| 组 | 状态 | 组 | 状态 | 组 | 状态 | 组 | 状态 |
|---|---|---|---|---|---|---|---|
| common-01 | **PASS** | math-01 | **PASS** | document-01 | **PASS** | web-01 | FAIL |
| common-02 | FAIL | math-02 | **PASS** | document-02 | **PASS** | web-02 | FAIL |
| common-03 | **PASS** | math-03 | **PASS** | document-03 | **PASS** | web-03 | FAIL |
| common-04 | FAIL | math-04 | **PASS** | document-04 | **PASS** | web-04 | FAIL |
| common-05 | FAIL | math-05 | FAIL | document-05 | FAIL | web-05 | FAIL |
| common-06 | FAIL | math-06 | **PASS** | document-06 | **PASS** | web-06 | FAIL |
| common-07 | FAIL | ocr-01 | **FAIL（诚实）** | ocr-02 | **PASS** | ocr-03 | **FAIL（诚实）** |
| common-08 | FAIL | ocr-04 | **PASS** | ocr-05 | **PASS** | ocr-06 | **PASS** |

16 个 FAIL 的归因（**这一轮**）：

```text
诚实 FAIL（2 个，**不得**修，也不得调阈值）：
  ocr-01 img-zh.png     CER 8.33% > 5%（全角「：」被读作 ASCII「:」）
  ocr-03 img-mixed.png  CER 5.88% > 5%（「薇」→「微」）
  ⇒ 这正是 OCR 记 PARTIAL、生产**不启用** OCR 的那条读数。

量具缺陷（14 个，整定中）：
  web-01/02/04/05/06  夹具用的地址 203.0.113.10 属 TEST-NET-3（文档用途），
                      被生产 `classifyAddress` **正确地**判为非公网 ⇒ 拿不到正文。
                      网页探针用的是真实公网地址 93.184.216.34，正控通过。
  web-03              期望值写错：非 HTTPS 的**准入**拒绝姿态应是 validation_failed/rejected，
                      不是 execution_failed（后者会夸大；permission_denied 会被回复层读成
                      "没启用"，那是撒谎）。
  math-05（2 条）     要求 `import(1)` 在 **AST 层**被拒（理由含"不允许的函数"）。
                      但白名单外的函数调用现在**连请求都不产生**（触发精度规则），
                      ⇒ 该用例应直接驱动适配器（AST 层），而不是走检测器。
  document-05         `.txt` 在 M4.5 的扩展名轮转里且 M4.5 检测器先跑，
                      ⇒ 空文件用例根本没到 `document.read`（观测到 capability=sandbox.file.read）。
                      应改用 **0 字节的 `.pdf`**。
  common-02 ②-e       断言断在最终回复上（附录**合法地**含 `[C1]`）⇒ 应断在附录之前的正文段。
  common-04/05/06/07/08  同一条级联：正控要求"当轮内容真的进了 packet"，
                      上游文档/网页拿不到内容 ⇒ 级联失败；上游修好后应转绿。
```

⚠️ 本节是**过程读数**，不是最终判定：整定完成后会再出一版，最终判定以那一版为准。

### 3.5 全量回归汇总的**陈旧证据**处置（计划书 §4B 的第二段）

计划书要求「既有回归汇总器固定读取 `artifacts/m5.1/wp9-m4.5-ci.log`…**不能让它误读旧日志**」。
实测到过一次**真实**的误读：该路径上当时是 **2026-09-19** 的旧日志（430,661 B，
sha256 `6750dc115b3d51803993985acf5edd69b0838ec6198ceee64dd89c6c5af1a342`），
于是 `pnpm m5.1:regression:verify` 报出 **`全量回归判定：PASS`** —— 那是九月的读数，
与本批代码无关。处置：

```text
① 旧日志先复制到 artifacts/post-lv2/local/utility-skills-preparation/runs/prior-wp9-m4.5-ci-20260919.log（留档）
② 原地更名为 wp9-m4.5-ci.log.stale-20260919 ⇒ 规范路径上**没有**日志
③ 复跑汇总器：`全量回归判定：FAIL` +「m4.5:ci 原始日志不存在 → 全量回归 not-run（**不是** PASS）」
```

⇒ 这正是计划书要的方向：**缺日志 = NOT RUN，不是 PASS**。

### 3.6 本批自己的全量回归读数（计划书 §4B）

`pnpm m4.5:ci` 在**冻结代码**上跑了一次，**EXIT 0**：

```text
M4.5 门结果汇总（只读证据）        G12 Measurement Validation  PASS 38/0 [HARD GATE]
                                  L2  Action Pipeline         PASS 53/0
                                  G13 Natural Language E2E    PASS 32/0 [HARD GATE]
                                  G14 Production-copy Smoke   PASS 52/0 [HARD GATE]
                                  G2  Component               PASS 143/0
                                  G9  人工审计语料              PASS
（同一次日志里的其它门）            M2.5 Phase H 54/0 · OTLP 兼容 21/0 · 干跑静默 17/0 ·
                                  provider 白名单 11/0 · M3 离线评测 20/0 ·
                                  M3.5 future-compat 30/0 · M3.5 持久化 31/0 · M4.5 L3 32/0
```

`pnpm m5.1:regression:verify` → **全量回归判定：PASS**（`m4.5:ci exit=0 · 编码=utf-8 · 逐门小结=26 条 · 硬门=3 条`）；
`pnpm m5.1:gates` → **Hard Gates：PASS**（M51-G1…G10 全 PASS，含 G10「全量回归 · 既有 Hard Gate 零退化」）。

⚠️ **两处真实的工具坑（都已处置，登记在此）**：

```text
① 本机 PowerShell 是 **5.1**：既没有 `Add-Content -Encoding utf8NoBOM`（参数绑不上），
   而且 `Tee-Object` 默认把日志写成 **UTF-16LE**（本次原始日志 799,962 字节，
   含 BOM FF FE）。⇒ 追加 EXIT_CODE 失败、日志编码也不是汇总器偏好的那种。
   处置：用一个按 BOM 判断编码的 Node 脚本把它**规范化成 UTF-8（无 BOM，466,386 字节）**
   并追加真实 `EXIT_CODE=0`，随后自检：26 条逐门小结 / 3 条硬门 / **0 处 ❌** / 0 处非零失败。
② 在这之前，规范路径上放的是 **2026-09-19 的旧日志**（§3.5），汇总器会据此报 PASS。
   ⇒ 先留档、再移走，让"缺日志"如实表现为 not-run，然后才写入本批自己的日志。
```

⇒ **这一格现在是属于本批的读数**，而不是历史承接。

### 3.2 首轮 16 个 FAIL 的归因（**如实分列，不回写**）

| 组 | 首轮 FAIL 的原因 | 归因 |
|---|---|---|
| `common-02` | 断言断在最终 `replyText` 上没有 `[C1]`，而程序追加的附录**合法地**含 `[C1]` | 量具缺陷 |
| `common-04/05/06/07/08` | 正控要求"真的产出了当轮内容"；文档/网页夹具被准入拒绝 ⇒ 级联失败 | 量具缺陷（上游） |
| `document-01` | 要求 PDF 的结构标记里有"标题"，而 markitdown 对 PDF **不产 `#` 标题标记** | 期望值缺陷（**不得**让适配器谎称有标题） |
| `document-05` | 空文件与扫描件的失败话术**不可分辨** | **真实 `src` 缺陷**（已修） |
| `document-06` | `doc-huge.txt` 的 `.txt` 不在检测器扩展名白名单里 ⇒ 根本不产生请求 | 量具缺陷 |
| `math-05` | `evaluate("1+1")` 被抽成内层 `1+1` ⇒ **悄悄改写用户给的算式** | **真实 `src` 缺陷**（已修） |
| `web-01..06` | 夹具服务器在 `127.0.0.1` ⇒ 被生产准入如实拒绝（`forbidden_address`） | 量具缺陷 |
| `ocr-01..06` | 把**目录** `node_modules/tesseract.js-core` 当文件 `readFileSync` ⇒ `EISDIR` ⇒ 误判"资产不可用" | 量具缺陷 |

### 3.3 首轮逼出来的两处真实 `src` 缺陷（已修）

```text
① math.calculate 的算式抽取会**改写用户给的算式**：
   用户说「帮我算一下 evaluate("1+1")」，第一版"引号优先"抽出内层 `1+1` 并算出 2。
   修法：句子里出现**白名单之外**的函数调用 ⇒ 不抽算式、**连请求都不产生**。
   ⚠️ 这不是安全检查（安全仍在 AST 白名单），而是**触发精度**规则：不猜、不改写。
   实测：`evaluate("1+1")` / `sin(0)` / `max(1,2)` ⇒ undefined；
        `sqrt(2)` / `round(2.345, 2)` / `abs(-4.5)` / `0.1+0.2` / `(1+2)*3` ⇒ 照常。

② document.read 把"空文件"与"扫描件"说成同一句话 ⇒ **说错失败原因**。
   修法：0 字节 ⇒「文件是空的（0 字节）：没有任何内容可读」；
        有字节但没有文字层 ⇒「文件里没有可提取的文字（很可能是扫描件或图片型页面）」。
```

### 3.4 组件级读数（各能力的独立探针，`artifacts/post-lv2/local/utility-skills-preparation/runs/`）

**精确计算**（`mathjs-probe.json` + 父代理直接驱动适配器）：

```text
0.1+0.2                     = 0.3（精确，approx=false）
9007199254740993+1          = 9007199254740994（精确）
sqrt(2)                     = 1.414…（64 位有效数字，approx=true）
1/3                         = 0.333…（64 位，approx=true）
round(2.345, 2)             = 2.35（decimal.js 半进位，**与 JS 的 2.34 不同**）
2^999999999                 ⇒ 拒绝 exponent_too_large（执行前）
1/0                         ⇒ 拒绝 not_finite
a = 1 / import("x") / random() / evaluate("1+1") / #comment / [1,2,3] / 1 km to m / ones(100000000)
                            ⇒ 全部**在执行前**拒绝，且理由具名
单次成本                    ≈1.2–1.4 s（spawn `node --import tsx` + mathjs 装载）
```

**文档阅读**（`document-probe.json` + 父代理直接驱动适配器）：

```text
doc-zh.pdf        ✅ 84 字符（标题/段落/项目代号 LG/4096 均在）
doc-table.docx    ✅ 94 字符（表格 项目|数值、温度|21.5、电压|3.3）
doc-two-slides    ✅ 92 字符（<!-- Slide number: 1 --> + 两页文本）
doc-two-sheets    ✅ 75 字符（## 汇总 / ## 明细）
doc-scan.pdf      ⇒ target_not_found「很可能是扫描件或图片型页面」（不猜内容）
doc-empty.txt     ⇒ target_not_found「文件是空的（0 字节）」
doc-corrupt.docx  ⇒ unsupported（**魔数**判定，8–10 ms，**没有 spawn Python**）
doc-fake.pdf      ⇒ unsupported（同上）
doc-huge.txt      ⇒ unsupported（12 MiB > 10 MiB 上限，1 ms，未读文件）
missing.pdf       ⇒ target_not_found    ../escape.pdf ⇒ permission_denied「路径越出沙箱根」
```

**网页深读**（`web-read-probe.json`，16/16）：

```text
夹具正文        1004 字符 · title 静水压力测量笔记 · DOM 28 元素
已知句 + 7.25   ✅ 在正文里     SCRIPT-RAN / 广告 / 页脚 / 导航块 ⇒ 都不在
注入样本        「忽略以上所有指令…」**作为数据保留**（不清洗，靠 header 声明）
受禁目标        35 条判决全部拒绝 · **连接尝试 0 · 解析尝试 0**
跳链            302→302→200 · 逐跳重校验 · 重定向到 10.0.0.7 / http://169.254.169.254 / 解析到 10.1.2.3
                ⇒ 全部**在连接之前**拒绝 · 第 4 次重定向 ⇒ too_many_redirects
TLS（真实套接字） 正控 200 + 读回 3843 B；负控 servername 错 / 无 CA / IP 当 servername ⇒ 三种不同错误
上限            65536 B 放行 / 65537 B 立刻中断；3 MiB 响应在 2,129,920 B 处被掐（**边读边掐**）
               60,006 元素 ⇒ dom_element_limit_exceeded；98,400 字符 ⇒ truncated=true 且契约通过
上游行为        404 → not_found · 500 → failed · application/json → unsupported_content_type
                · 无 content-type → missing_content_type · 未请求的 gzip → unsupported_content_encoding
                · DNS 失败 → execution_failed（**不是** timeout）
jsdom A/B       默认选项：脚本不执行、子资源 0 次网络调用；`runScripts:'dangerously'` ⇒ 标记出现（正控）
```

**OCR**（`ocr-probe.json`，21/21）：

```text
img-en      conf 95  CER 0        "OCR CHECK: Order 4711 shipped on 2026-10-04"
img-zh      conf 92  CER 0.0833   "识别 测试 : 温度 22.5 度"（全角「：」被读作 ASCII「:」）
img-mixed   conf 86  CER 0.0588   "苏 沐 微 CPU 37 % / Temp 21 C"（「薇」→「微」）
img-degraded conf 67  CER 0.1765  "BAR CPU 37% / Temp 21C"
img-empty   conf 0   ⇒ partial（不发当轮内容）
网络调用     父进程 0 / 子进程独立守卫 0（装载于 thread 0 与 1）/ 工作器自报 0
资产         树前后指纹逐字相同 · cache 目录前后为空 · 删除物化目录后一次调用自建且逐字节相同
工作器       超时/取消 ⇒ SIGKILL + released · 随后恢复成功 · 并发第二次失败关闭
语言顺序     **必须 `eng+chi_sim`**：`chi_sim+eng` 会静默丢掉英文
```

## 4. 真模型短链（八轮）

执行形态：`pnpm with-test-model pnpm utility:verify --live` —— 真 `src/main.ts` 装配 + 真模型 +
**tmpdir 隔离库**（`isolation.productionDbTouched = false`，生产 `data/pglite` 一个字节都没动）。
端点：`ark.cn-beijing.volces.com` · model `deepseek-v4.1-flash`。

### 4.1 已跑两轮，其中一条**被我拒收**

| 轮 | runId | 计数 | 说明 |
|---|---|---|---|
| 1 | `utility-live-live-20261004T142334-50560` | **7 PASS / 1 FAIL / 0 NOT RUN** | 唯一 FAIL = `live-ocr-degrade` 用了"**资产可用**"的等价形态执行，却断言"不得声称识别成功" ⇒ **形态缺陷**（不是代码缺陷） |
| 2 | `utility-live-live-20261004T142741-18860` | 名义 **8/8 PASS** | ⚠️ **`live-ocr-degrade` 是假 PASS，已拒收**（见下） |

**为什么拒收**（这是本批第二次遇到"量具自己没被验证"，第一次是 §3.1 的 `common-04`）：

```text
expected  {noRecognitionClaim: true, assetsReallyMissing: true}
observed  {emptyLangDir: true, modelCalls: 0, retries: 0}
回复      「识别完了。img-zh.png，就一行：测试 : 温度 22.5 度 … 18 个字符，全读出来了。」
```

回复**声称识别成功并引出了识别文字**，而用例同时声称"资产确实缺失" —— 两者不可能同时为真。
根因是适配器自身的行为：把 `PROJECT_LG_OCR_LANG_PATH` 指向**空目录**并不会让资产不可用 ——
惰性的 `ensureOcrLocalAssets()` 看到 lang 目录空/缺失，就**从已安装的包里把资产物化进去**，
然后正常识别。于是"降档形态"根本不是降档，而断言（"空 lang 目录存在"）恰好与**成功**相容。

⇒ 已要求改成真形态（连 `PROJECT_LG_OCR_DATA_PACKAGE_ROOT` 一起指向空目录，物化无从复制），
并把判据从"目录为空"换成**程序事实**（适配器自己的归一失败 + 没有 `turnContent` + 回复不声称识别成功）；
若真形态在 live 里不可达，则如实记 `NOT RUN` 并给理由。**这一条在出真读数之前不计入 PASS。**

**后续轮次（仍然未收口）**

| 轮 | runId | 计数 | 说明 |
|---|---|---|---|
| 3 | `…144140-1248` | 3 / 5 | 空资产 env 被设成**全局** ⇒ 连四个"成功"场景都 FAIL（量具回归，已要求限定到单场景） |
| 4 | `…144548-21736` | 4 / 4 | 四个降档场景过、四个成功场景仍 FAIL |
| 5 | `…144845-40412` | **3 / 5** | 同形；`live-ocr-degrade` 保持 **FAIL**（唯一失败项 = `assetFailureNamed=false`，即 `L-US-06b`） |

**第 5 轮里那个仍未定性的矛盾（本批最后一个悬而未决项）**：

```text
应用日志：  [turn-content-truth] 本轮内容 = math.calculate:delivered，已追加确定性来源与范围附录（1 条）
量具抓取：  回复里**没有** `来源与范围：` / `[C1]`（四条"成功"场景因此 FAIL）
程序事实：  containsProgramValue=true · containsNeedle=true · numbersFound=["4711","2026-10-04"]（都在）
```

我在 `src/main.ts` 读出的定位（**不是猜**）：

```text
· 守卫链之后的 `replyText` **含**附录（2716）⇒ 进账本（2809）⇒ 作为**文本投递**（2829 / 2948 的 content.text）
· 全仓库**唯一**剥掉附录的地方是 2926 行 `const spokenText = withoutAppendices(replyText, […])`，
  它存在的唯一目的是**朗读路径**不要念来源列表（`withoutAppendices` 只有一个调用点）
```

⇒ 两种可能，**尚未判定**：①量具抓的是 console 回显 / 朗读文本 ⇒ **量具假失败**（修抓取）；
②量具抓的是投递文本或助手事件而仍无附录 ⇒ **真实源码缺陷**（我修 `src` + 按纪律重跑回归）。
已给出一次性判别法：同一场景把**投递文本**（或从隔离库读回的助手事件）与 console 回显**并列打印**。

**父代理的独立核对（把可能性①变成主因）**：我直接查了那一轮的**原始逐场景日志**
（`artifacts/post-lv2/local/utility-skills-preparation/live/<runId>/live-math-success.log`，7,868 字节）：

```text
`来源与范围` 命中 0 次 · `[C1]` 命中 0 次 · `turn-content-truth` 命中 0 次
```

即：量具落盘的这份文件里**既没有附录、也没有那条"已追加附录"的应用日志行** ⇒ 它抓的不是
"应用完整输出"，而是**被裁剪过的回复文本**；而我读代码得到的定位是
**只有朗读路径**会剥附录（2926 行，`withoutAppendices` 全仓库唯一调用点）。
⇒ 主因判定为**可能性①：量具的抓取通道是朗读/console 文本**（附录按设计不在那里），
**不是**源码缺陷。对照证据：**离线端到端抽查**（同一套回复守卫）里附录**确实**出现在
`replyText` 与账本路径上。

⚠️ 残余不确定性如实保留：这条结论来自"日志里没有那两样东西"＋"代码里只有朗读路径会剥附录"，
**还差一次直接确认**（量具打印投递文本或从隔离库读回的助手事件）。在确认之前，
四条"成功"场景在报告里记为 **`FAIL（抓取通道待确认）`**，不计入 PASS。

**结案（父代理读码确认，2026-10-04）**：确认 = **量具的抓取通道缺陷**，不是源码缺陷。证据链闭合：

```text
量具侧：live.ts:82 parseReply(stdout) → 102 行 `raw.lastIndexOf('来源与范围：')`
        → 104 行把它从 reply 里切出去当 appendix；断言（309/316）= reply 含程序结果 **且** appendix 含「来源与范围：」
应用侧：main.ts:2926 `const spokenText = withoutAppendices(replyText, […])`
        → 2935 用它绑定朗读表达 → **2938 `return spokenText`（CLI 路径返回的就是朗读文本）**
        ⇒ 子进程 stdout 里**按设计**不存在「来源与范围：」；它只存在于**文本通道**的 `replyText`
        （2829 / 2948 的 `content.text`）—— 而量具偏偏去 stdout 里找它
```

⇒ 那四条失败的**不是**"附录没生成"，而是"**量具问错了地方**"：它的判据在一个按设计
不含附录的通道上不可满足。

**直接测量（判别性证据，2026-10-04，父代理执行）**：用 `scripts/utility-skills/probe-delivery.ts`
跑一次真子进程 + 真模型 + 隔离库，**并在 `src/main.ts` 里临时加一行阳性对照日志**
（打印 `guardChain.turnContent.appendix.length` / `guardChain.replyText` 是否含附录 / `refs` /
`reachedContext` / 最终 `replyText` 是否含附录；用完已删除）。读数：

```text
① 控制台回声（live.ts 今天断言的就是这个）        117 字符 · 来源与范围=**false** · [C1]=false
② 隔离库 conversation_events（助手事件=交付文本）  167 字符 · 来源与范围=**true**  · [C1]=true
③ 隔离库 memories(messages)                      167 字符 · 来源与范围=**true**  · [C1]=true
   tail: 「…结果就是 0.3。没别的。\n\n来源与范围：\n[C1] 程序计算（math.calculate.evaluate）（…」
```

⇒ **附录确实进了被投递、被记录的正文**（助手事件与 memories 都带），**只有控制台回声不带** ——
因为 CLI 路径返回的是 `spokenText`（按设计已剥附录，2938 行）。判据成立的完整链条因此是：

```text
量具在 stdout 里找「来源与范围：」 → CLI 返回 spokenText（附录按设计已剥） → 永远找不到 → 假失败
```

⚠️ **同时登记一个量具陷阱（这次差点让我误判）**：该探针**上一次**的读数三个通道**都没有**附录
（各 107 字符），而那一轮应用日志里**连 `[turn-content-truth]` 行都没有** ⇒ **那一轮压根没有当轮内容**
（没有东西可追加）。**缺阳性对照的一次测量，会同时"证明"两种相反的结论** —— 这正是本批第三次
"量具自己没被验证"（前两次：§3.1 的 `common-04` 前缀哨兵、`web-05` 的 0/0 计数）。
因此：

- live 链的**实质判据全部通过**：程序事实确实可引用（`containsProgramValue=true`、
  `containsNeedle=true`、`numbersFound=["4711","2026-10-04"]`）、不声称成功、降档姿态如实；
- **"附录进了用户可见文本"这条改由离线端到端抽查证明**（§2.3：真 `TurnGateway` + 真守卫链，
  `replyText` 与账本路径都带 `来源与范围：[C1] …`），而不是靠一个取错通道的 live 断言；
- 该量具缺陷如实登记（与 §3.1 的 `common-04` 前缀哨兵、`web-05` 的 0/0 计数同属"量具自己没被验证"）。
  修法（留给后续）：量具改为读取**投递文本**或**隔离库里读回的助手事件**，不要解析朗读回显。

同时登记一条**口径区分**（不许混成一句）：live 量具**按场景用 env 覆盖四个开关**（`=1` 各，
并额外 `CHARACTER_WEB_SEARCH_ENABLED=0`、token 额度从父进程继承 = 3000），
因此"live 跑过"**不等于**"live 跑在生产 `.env` 取值上"；生产取值另行由 `readKernelFlags()` 核过（§3 / ADR-095）。

### 4.2 可以引用的读数（第 2 轮的其余 7 轮 + 第 1 轮）

```text
live-math-success      PASS   程序结果与回答一致
live-math-degrade      PASS   非法算式 ⇒ 不声称已计算
live-document-success  PASS   指定 pdf 里的事实/数字被读出且带来源
live-document-degrade  PASS   空/无文字层 ⇒ 不猜测内容
live-web-success       PASS   真实文章的指定段落 + 实际来源与范围
live-web-degrade       PASS   受禁 URL 被程序拒绝，不声称已阅读
live-ocr-success       PASS   关键数字 4711 / 2026-10-04 全对（附录带资源）
                              reply：「识别出来了。img-en.png，就一行字：OCR CHECK: Order 4711 shipped on
                              2026-10-04 … 44 个字符，全读出来了。……Order 4711。今天发的。剩下的
                              一概不知道，图上没写发去哪、发给谁。」
```

⚠️ **一条口径必须讲清（未定）**：live 量具很可能**按场景用 env 覆盖四个能力开关**。
若是，则"live 跑过"**不等于**"live 跑在生产 `.env` 的取值上"。生产取值我另行核过
（`readKernelFlags()`：四项全 `true` · `turnContentTokens=3000`，见 §3/ADR-095），
但报告不会把两件事混成一句 —— 已向量具所有者索取它**实际使用的开关值**。

端点预检（父代理独立执行）：`ark.cn-beijing.volces.com` · model `deepseek-v4.1-flash` ·
**HTTP 200 / 771 ms**（key 有效，只打印存在性与长度）。

## 5. 局限与残余（**如实登记，不淡化**）

### 5.1 文档阅读

```text
L-US-01  页码/精确定位：markitdown 不保留 ⇒ 本批**不提供**（`structure` 里明写这一点）
L-US-02  PDF 结构标记：`doc-zh.pdf` 的输出**没有** `#` 标题层级 ⇒ 适配器**不谎称有标题**；
         结构事实只报转换器实际给出的（标题/表格行/幻灯片标记/工作表标记）
L-US-03  扫描件：首版不渲染 PDF 到图像、也不对它跑 OCR ⇒ 如实"没有可提取的文字"
L-US-03b **"读不到文字"有两层，别再合成一层**（整定期的实测更正）：①**格式闸**先跑，
         0 字节或伪装格式的文件在**碰转换器之前**就被拒（`.pdf` 的文件头不是 `%PDF-` ⇒ `unsupported`）；
         ②通过了格式闸、但没有文字层的文件才走"文件里没有可提取的文字（很可能是扫描件或图片型页面）"。
         顺带更正一条：**0 字节的 `.pdf` 不属于第 ② 层** —— 它在第 ① 层就被如实拒绝；
         0 字节的 `.txt` 则根本归 M4.5 的 `sandbox.file.read`（另一种能力、另一种事实）。
L-US-04  转换器语义：markitdown 用 magika 嗅探并**吞掉**转换器异常 ⇒ 它的 `ok:true` 只代表
         "某个转换器成功了"；因此格式闸必须按**魔数**判定（本批已如此实现）
```

### 5.2 OCR

```text
L-US-05  **未达到本项自己的清晰样本阈值**：计划书 §4A 要求三张清晰样本分别 CER ≤ 5%，
         实测 zh 8.33% / mixed 5.88% / en 0%（关键数字 22.5 / 4711 / 2026-10-04 / 37 / 21 全对）
         ⇒ OCR 记 **PARTIAL**；不调阈值、不换样本、不加后处理凑通过
L-US-06  语言顺序取舍：`eng+chi_sim` 在**退化中文图**上比 chi_sim 单语言差（67 vs 75）
L-US-06b **缺资产时的失败原因没有被点名**（真模型 live 实测，2026-10-04）：资产确实缺失时，
         当轮内容为空、回复如实说"没识别出来、什么都没拿到"，**但**它不点名"缺语言资产"，
         于是模型**自己猜了一个原因**：「文件是在的，但识别这一步没走通。可能是格式不对，
         或者图片本身有问题」—— 这是**说错失败原因**（计划书 §5 明确禁止）。
         根因：回复守卫拿到的只有 `{capability, kind, status, failureCode}`，
         而"缺资产"这一档在**归一失败码**上与其它 `execution_failed` 不可区分
         ⇒ "让回复层点名缺资产"需要把更细的失败原因透传给守卫（**独立小改动**，不在本批冻结范围内）。
         本批**如实登记为未修**；对应量具读数为 `assetFailureNamed=false`（保持 FAIL，不因交付而放宽）。
L-US-07  每次调用一个全新子进程（"杀掉即释放 + 可恢复"的代价）⇒ 没有跨调用常驻热 worker
L-US-08  引擎 confidence ≠ 校准准确率（如实标注，不用模型润色掩盖错字）
L-US-09  `corePath` 在 tesseract.js v7 的 Node 路径上**被库忽略**（仍显式传入并核对存在，但不谎称生效）
```

### 5.3 网页深读

```text
L-US-10  首版只支持静态正文；登录态/验证码/动态渲染空壳 ⇒ 如实降档（不启动浏览器补救）
L-US-11  证书校验的正控用的是**本地真实 TLS 服务器**（本机无直连出站，只有 HTTP 代理，
         而代理与"固定地址连接"本质冲突）⇒ 1 正控 + 3 负控都是真实握手，但不是公网 CA 站点
L-US-12  2 MiB / 50,000 元素 / 15 s 是**运行约束**，不是已测性能 SLA
```

### 5.4 计算与公共

```text
L-US-13  单次计算成本 ≈1.2–1.4 s（可终止执行器的代价，如实记录）
L-US-14  首版只支持十进制四则/括号/负数/受限整数幂(abs/sqrt/round)；单位换算与统计留后续切片
L-US-15  请求参数（算式 / URL / 路径）进账本 —— 它们是"引用"；**内容正文**只在当轮内存与
         可裁 section 里（effect/evidence 经实测不含正文；trace 属性只有 id/计数/字符数/标签）
```

## 6. 本批**不主张**的事

```text
· 不主张"四项已在生产启用"（事实是：**三项已激活、OCR 未启用**，见 §0 与 ADR-095）
· 不主张"四项全部完成"（OCR = PARTIAL）
· 不主张 OCR 有广泛准确率（只有 3 清晰 + 2 边界样本的读数）
· 不主张"网页全文"（超限时只读一部分，且回复层必须这么说）
· 不主张长期认知绝无变化（不新增写入入口，但正常回复仍经既有对话记录与消费者）
· 不新建通用技能加载器 / 任意 MCP 工具入口 / 第二个记忆后端 / 数据库迁移
```

## 7. 证据索引

```text
公开（进仓库）
  artifacts/post-lv2/utility-skills/<runId>/run.json          32 组逐组读数 + 源码/输入指纹
  artifacts/post-lv2/utility-skills/utility-wp0-2026…-06a4/    WP0 基线 run（32 组全 NOT RUN）
  docs/post-lv2/Utility-Skills-WP0-Baseline.md                基线
  docs/post-lv2/Utility-Skills-Usage-and-Rollback.md          使用与回滚

raw（已忽略，artifacts/post-lv2/local/utility-skills-preparation/）
  runs/{node-deps,node-env,mathjs-probe,web-probe,ocr-probe,ocr-assets,document-probe}.json
  runs/web-read-probe.json · runs/image-ocr-probe.json · runs/README.md（索引）
  fixtures/manifest.json（fixture + **独立撰写**的参考答案与 SHA-256）
  python/{requirements.lock.txt,install-report.json,version-info.json}
```
