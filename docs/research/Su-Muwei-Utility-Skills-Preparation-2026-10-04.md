# 苏沐薇首批实用技能准备包

日期：2026-10-04。范围：文档阅读、网页深读、精确计算、OCR。

状态：**PREPARATION COMPLETE / DESIGN PROPOSED / IMPLEMENTATION NOT STARTED**。
本轮交付候选版本、源码核对、接入方案和验收矩阵；未安装依赖、未运行组件探针、未接入 LG、未加载模型、未打开真实数据库。

## 0. 用户决定与范围

用户确认：“在许可证的层面，均可以应用到我的项目中，在代码层面还得另说”，并要求“文档阅读＋网页深读＋精确计算＋OCR”这一组先准备。

- Anthropic Skills 与 NapCat 的项目适用性按用户确认记录为 `USER_CONFIRMED_APPLICABLE`；后续评价转向代码兼容性，不再以此前许可初筛作为阻塞理由。本文件不把用户确认改写成第三方法律审计结论。
- 本批选用 MarkItDown、Readability、mathjs、Tesseract.js，原因是功能边界和依赖适合当前工程。Anthropic 文档技能保留为后续代码候选；QQ/NapCat 不属于本批。
- “先准备”在本轮落实为可审阅的方案与来源证据。四项运行能力、生产开关及 [M6.5 整包路线](../m6.5/M6.5-Lv2-Capability-Integration-Plan.md) 的排期未据此改写。
- 设计提案不改变现有记忆资格、行动权限、人格主权与失败口吻。实现时每项能力单独验收，不创建通用插件框架或任意 MCP 工具入口。

## 1. 当前工程与环境读数

本机观察：Windows；Node **22.23.2**；pnpm **12.4.1**。Python Launcher 列出独立 **CPython 3.12.13** 解释器，可用于创建专属 venv；本轮没有创建环境。

四项能力需要完成的接线已经定位：

| 当前代码事实 | 对接入的影响 |
|---|---|
| [main.ts](../../src/main.ts) 的 `buildActionWriter/buildActionGateway` 装配三个默认能力和 `web.search` | 新能力采用追加登记、独立权限和适配器；保持默认三能力集合 |
| [sandbox-filesystem.ts](../../src/infrastructure/action/adapters/sandbox-filesystem.ts) 的读取结果只有效果、字节数、指纹和引用 | 读取成功不代表模型拿到了正文；须补受控的当轮内容通道 |
| [external-evidence.ts](../../src/kernel/contracts/external-evidence.ts) 限制 HTTPS 来源、每条摘要 600 字符、最多 5 条 | 保留搜索契约；长文、本地文件、计算和 OCR 不冒充搜索结果 |
| [executor-port.ts](../../src/kernel/action/executor-port.ts) 与 [action-result.ts](../../src/kernel/action/action-result.ts) 没有这四类内容结果字段 | 实现需要审阅一个可选、有限类型的当轮结果扩展，不能只安装依赖 |
| `main.ts` 的目标解析目前专门处理搜索服务，其余走沙箱文件 | 计算需要固定本地执行器目标，网页需要明确 URL 目标；不把 URL 当沙箱路径 |
| [intent-detector.ts](../../src/kernel/action/intent-detector.ts) 没有 PDF/DOCX/PPTX/XLSX/图片的专用触发路径 | 增加明确触发与格式识别，回归旧文件/搜索词形，避免旧检测器抢走新请求 |
| [action-ledger-store.ts](../../src/infrastructure/action/action-ledger-store.ts) 对短字符串会保留值或前缀 | 正文、图片、HTML 与 OCR 原文不传入持久化参数；引用与正文分开 |

18 份上游文件的固定提交、内容指纹，以及 18 个本地实现/配置文件的准备期基线，见 [sources.json](../../artifacts/research/utility-skills-preparation-20261004/sources.json)。其中 `.env` 只记录 SHA-256，未读取或展示凭据值。

## 2. 候选版本与源码结论

这些是**准备期候选固定值**，还不是已安装环境或完整的传递依赖锁。

| 用途 | 固定候选 | 来源与实际核对 |
|---|---|---|
| 文档转换 | `markitdown[pdf,docx,pptx,xlsx]==0.1.8` | [微软发布 v0.1.8](https://github.com/microsoft/markitdown/releases/tag/v0.1.8)，Git tag 解引用到 `b8f79c57ebc0044be41323d89b2a45d3fda8460e`；核对流入口和四种转换器 |
| 网页正文 | `@mozilla/readability@0.6.0` | [固定源码](https://github.com/mozilla/readability/blob/4d5dd0bbe0bfbc44e219dc86865131e79639e30b/Readability.js)；`parse()` 可返回 `null`，返回正文、标题等；支持 DOM 元素数量限制 |
| DOM 解析 | `jsdom@30.1.2` | [固定 package.json](https://github.com/jsdom/jsdom/blob/a23bfb72b5a3fc776db51ae1bccabf46af8a9e38/package.json) 要求 `^22.22.2 || ^24.15.0 || >=26.0.0`；本机 22.23.2 满足声明，运行兼容仍需探针 |
| 计算 | `mathjs@15.2.0` | [固定解析器](https://github.com/josdejong/mathjs/blob/fee4561840043a7473962367bbae6f15bbb3cebb/src/expression/parse.js) 不仅支持算术，还支持赋值、数组、函数与访问器；须限定 AST |
| OCR 包装器与核心 | `tesseract.js@7.0.0` + `tesseract.js-core@7.0.0` | [固定工作器](https://github.com/naptha/tesseract.js/blob/42eae669e4b3a66429d8516f078912cc747a89df/src/worker-script/index.js)；核对创建、语言加载、终止和图像读取 |
| OCR 语言资产 | `@tesseract.js-data/chi_sim@1.0.0` + `@tesseract.js-data/eng@1.0.0` | npm 发布元数据与分发 integrity 已记录；未下载/解包，具体 traineddata 文件 SHA-256 仍待准备环境时生成 |

Node/Python 包的发布元数据、分发地址和 integrity/SHA-256 已记录。不能把 Git 源码指纹或 registry 声明摘要当成“本机已下载并校验”。

### 2.1 文档阅读

- 使用专属 Python 3.12.13 venv，调用已验证路径的 `convert_stream()`，不暴露通用 `convert()/convert_uri()`。后两者能访问 URL 和本地 URI，已由 [固定源码](https://github.com/microsoft/markitdown/blob/b8f79c57ebc0044be41323d89b2a45d3fda8460e/packages/markitdown/src/markitdown/_markitdown.py) 确认。
- 首版支持文字型 PDF、DOCX、PPTX、XLSX；保留可取得的标题、表格、工作表名与幻灯片标记。页码或结构未被转换器保留时如实注明，不生成虚构定位。
- 转换器关闭插件、不配置 LLM/Azure 客户端；本批不启用音频、YouTube、远端 URL 或任意 ZIP 转换。
- 文档中的宏、链接、图片描述和指令作为输入内容处理，不执行。扫描 PDF 或图片型页面在首版返回“需要 OCR/当前未提取”，不凭空总结；PDF 到图像的渲染链另验，不承诺 Tesseract.js 直接读 PDF。
- MarkItDown 基础依赖包含 `magika~=0.6.1`；其元数据含 NumPy、ONNX Runtime。故“文档阅读”并非无模型依赖，文件类型分类器和环境锁也要实测；使用专属 CPU 环境，不复用语音 venv。

### 2.2 网页深读

- 首版只处理用户明确指定的 HTTPS URL 和静态 HTML 正文。网络获取由 LG 适配器完成，取得字节后传给 `new JSDOM(...)`；不用 `JSDOM.fromURL()` 隐式获取内容。
- 保持脚本执行与子资源加载关闭，优先使用 `textContent`；不把抽出的 HTML直接作为可执行页面展示。[上游说明](https://github.com/mozilla/readability)明确要求单独处理不可信 HTML 的显示安全。
- URL 校验包括端口、DNS 解析结果、IPv4/IPv6 私有/回环/链路本地地址和重定向每一跳；连接须使用已校验地址，避免 DNS 检查与实际连接分离。有限制的专用取网页代码，不是任意 HTTP 工具。
- 登录页面、验证码、动态空壳、正文为 `null` 或编码失败分别返回可解释状态；不自动启动浏览器补救。
- 来源记录最终 URL、获取时间、内容指纹。正文来源内容无权修改权限、发起下一次搜索或写记忆。

### 2.3 精确计算

- 首版：四则运算、括号、有限指数和 `abs/sqrt/round`；数值按 BigNumber 路线验证，十进制表达式不先转 JavaScript 浮点数。
- AST 仅允许数值常量、括号、列举的操作符与列举的函数；禁止赋值、属性访问、动态函数、导入、嵌套解析/执行、随机数和未列举类型。函数名称白名单与 AST 类型白名单要一起生效。
- 输入、节点数、深度、指数/结果长度都有硬上限；计算运行在可终止的独立执行器，超时后释放进程。参考 [mathjs 官方执行安全说明](https://mathjs.org/docs/expressions/security.html)。
- 程序结果、数学错误和显示精度分列。`0.1+0.2` 等十进制断言是功能门；“高精度”不表示无限精度，开方的误差按配置记录。
- 单位换算和统计是同一候选组件能支持的后续切片；首个闭环通过后再列允许单位与函数，不把全部 mathjs 命名空间暴露给模型。

### 2.4 OCR

- 首版处理沙箱内 PNG/JPEG、简体中文与英文，读取确定目标后向工作器传 `Buffer`。[图像加载器](https://github.com/naptha/tesseract.js/blob/42eae669e4b3a66429d8516f078912cc747a89df/src/worker/node/loadImage.js) 能自行读路径/URL，故不传用户原始路径或 URL 字符串。
- 语言文件解包到专属目录，显式配置本地 `langPath/cachePath/corePath/workerPath`，限制工作器数量为 1。[源码](https://github.com/naptha/tesseract.js/blob/42eae669e4b3a66429d8516f078912cc747a89df/src/worker-script/index.js) 的缺省语言路径会访问 CDN；离线门须测到网络调用数为 0，包括语言缺失时。
- 记录文字、引擎 confidence 和实际识别范围。引擎 confidence 不直接等同于经过校准的准确率；不靠聊天模型润色来掩盖错字。
- 图片字节数、宽高/像素数和处理时间受限；用独立进程承载 OCR 工作器，取消/超时必须释放整个执行器。
- 本批不访问屏幕、摄像头或剪贴板；用户提交图片的读取是独立文件能力。前端图片提交和识别不能仅凭组件成功宣布已接入。

## 3. 保持现有框架的最小接入提案

```text
用户明确请求
 → 具体能力触发与目标解析
 → 既有 ActionRequest / Registry / Policy / Gateway
 → 已授权的具体适配器
 → 原有 ActionResult（执行事实）＋新增有限类型的当轮内容（数据）
 → 预算与实际入模集合
 → 同一回复链 / 同一语音与字幕文本
```

这里需要审阅的新增内容契约只覆盖这四项，**不是通用插件协议**：

1. 在 `AdapterOutcome/ActionResult` 增加可选的当轮内容载体；四种有限类型为文档文字、网页文章、计算结果、OCR 文字。默认缺省时，旧路径逐字段和逐字节不变。
2. 携带 `actionId/traceId`、资源引用、来源类别、源/结果指纹、实际取得范围和截断标志。文本通过受控预算进入模型；账本/trace 只保留引用、计数和状态。
3. 计算结果标注为程序计算；文档/网页文字标注为读取内容；OCR 标注为识别文字。文件里写着“用户住在某地”不等于用户本人陈述；解析成功不提升事实资格。
4. 当前搜索 `ExternalEvidence` 的形状、600 字符限制、来源附录和记忆隔离保持。新增当轮内容用独立 section/额度；建议初值 **2000 token**、可裁，仍服从现有总预算，默认 **0**。具体配置与命名是设计提案。
5. 只对**实际入模片段**形成来源/范围说明；全文仅提取部分、预算裁剪或内容为空时，不给“已读完全文”的口吻。只显示页码/段号等实际存在的位置。
6. 正文不写入 `conversation_events` 冒充 user 消息，不新增 `MEMORY_* / BELIEF_* / STORYLINE_*` 写入。最终回复按现有对话链记录；既有消费者对正常回复的影响另观察，不能声称长期认知绝无变化。
7. 一轮首版处理一项明确能力。内容中的“再打开这个链接/执行命令/记住以下事实”不会作为新用户任务。迟到结果不能进入另一个轮次，取消时删除当轮内容引用。

网页触发要比“像文件名的 URL 片段”更具体；旧文件读写与搜索优先级不因新检测器泛化而改变。输入有歧义或多项任务时先返回范围/目标说明，不实现自动多步代理。

## 4. 能力影响矩阵（提案，尚未登记）

| 能力 / 操作 | 权限 / 风险 / 副作用 | 复用与新增 | 认知及环境边界 | Level 1 / Level 2 |
|---|---|---|---|---|
| `document.read / read` | `document:read`；R0；read | 复用沙箱路径边界与行动链；新增文档转换适配器和当轮文字 | 指定文件；独立 venv；不自动写事实 | 文件确实解析且正文被看见 / 同一 action 与片段引用一致 |
| `web.read / read` | `web:read`；R1；read | 复用行动链；新增限定获取与正文提取 | 显式 HTTPS；无登录态；外部内容不取得用户权威 | 最终 URL 与正文确实取得 / 重定向、指纹、入模范围一致 |
| `math.calculate / evaluate` | `math:calculate`；R0；none | 复用行动链；新增有限表达式执行器 | 无宿主 Shell；独立可终止进程 | 数值/错误与参考答案一致 / 结果与程序事实一致 |
| `image.ocr / recognize` | `image:ocr`；R0；read | 复用沙箱目标与行动链；新增 OCR 执行器和识别文字 | 指定图片；CPU；本地语言资产 | 原图与识别有读数 / 范围、版本、confidence、来源一致 |

操作权限与能力构造使用同一开关，缺省关闭；关闭时不导入重依赖、不启动进程、不访问目标、不出站。开发者面通过已有 `runtimeCapabilities` 注入点展示真实可用性。

## 5. 专属环境与依赖准备方法

建议使用现有已忽略目录 `artifacts/post-lv2/local/utility-skills-preparation/`，本轮已用 `git check-ignore` 验证。目录布局是提案，尚未创建：

```text
utility-skills-preparation/
  node/             独立 package.json、pnpm-lock.yaml 和组件探针
  python/           Python 3.12.13 venv 与完整依赖锁
  ocr-data/         固定语言版本、逐文件 SHA-256
  fixtures/         合成样本与明确授权的本地样本
  runs/             原始内容、冷/热读数与失败档
```

下一阶段在该目录准备独立 Node 项目，固定五个组件包和两个语言包的精确版本；使用该项目的 lockfile，不改 LG 根 `package.json/pnpm-lock.yaml` 来试依赖。首次安装禁用非必要安装脚本；核心与语言数据不得在日常请求中悄悄下载。

Python 用已存在的 CPython 3.12.13 创建新 venv，只安装 `markitdown[pdf,docx,pptx,xlsx]==0.1.8` 所需依赖。先完成 Windows wheel 可用性、完整依赖锁和实际文件哈希，再运行转换。既有语音环境、Torch/CUDA、模型目录与生产 `.env` 不参与准备。

独立进程属于资源/生命周期分离，不能单凭 venv 或进程隔离就声称形成了 OS 安全沙箱。真实可读目录、网络范围和子进程约束必须由适配器及受测运行环境承担。

公开证据只保存来源、版本、引用与读数；原始文档、图片和全文放在已忽略目录。合成公开 fixture 可在实现时另列，不导入真实聊天历史。CPU/模型探针安排遵循用户此前要求的测试时机，本轮未运行。

## 6. 实现顺序与完成判据

| 工作包 | 交付 | 如何判完成 |
|---|---|---|
| P0 准备（本轮） | 版本、源码指纹、当前缺口、环境布局、矩阵 | 准备文件可解析；链接有效；基线核对；不计入运行验收 |
| WP0 独立组件验证 | 专属依赖锁、四个最小探针、合成 fixture、逐次证据 | 每项有真实正控、失败、超时/释放读数；记录 NOT RUN，不以 README 代替 |
| WP1 当轮内容设计与最小实现 | 有限结果类型、引用/正文分离、额度和实际入模集合 | 新字段缺省时旧路径不变；隐私与预算正/负控；不建立第二个记忆入口 |
| WP2 精确计算闭环 | 触发、固定执行器目标、权限、执行与可见结果 | 真实用户请求调用一次；拒绝/超时无成功口吻；恢复后可再次计算 |
| WP3 文档阅读闭环 | 四格式转换、确定文件、结构/范围说明 | 从输入文件到模型所见片段到回复逐段可查；空/扫描件诚实降档 |
| WP4 网页深读闭环 | URL 校验、限定获取、正文、引用 | 网络负控有效；实际最终 URL 与正文一致；动态页如实失败 |
| WP5 OCR 闭环 | 本地资产、图片读取、识别结果、取消 | 离线读取有准确率读数；缺资产零出站；取消和下一轮恢复 |
| WP6 组合回归与交付 | 四项独立状态、文本/语音材料、局限册 | 相关离线门与全量回归通过；需要真模型的短链另列；生产激活独立记录 |

顺序从计算开始是为了先验证最小内容/执行闭环；四种阅读不需要等代码执行/GitHub 整包恢复。这里是新的局部实施建议，尚未改写旧里程碑排期。

## 7. 验收矩阵与量具要求

以下为待执行用例，不是已有 PASS。每个检测器要有合法正控、违法负控、移除闸门后重新失败的恢复/反控；行为级判据必须测真正的模型输入与可见回复。

| 组 | 至少要覆盖的输入 | 必须看到的证据 |
|---|---|---|
| 文档正控 | 中文标题/段落 PDF；DOCX 表格；PPTX 两页；XLSX 两表 | 已知文字与数字、结构范围及源文件指纹；原文件前后相同 |
| 文档降档 | 扫描 PDF、空文件、加密/损坏文件、超限、扩展名伪装 | 明确未读/部分读取/不支持；未取得内容不能生成阅读成功事实 |
| 文件范围 | 同名多候选、绝对路径、`..`、symlink/junction 指向边界外、UNC | 越界内容读取次数为 0；目标歧义不选最近文件 |
| 网页正控 | 静态中文文章、含导航广告、允许的重定向 | 正文与 fixture 一致；最终 URL、抓取时间与指纹可查 |
| 网页网络负控 | 回环/内网 IPv4/IPv6、私网重定向、DNS 变更、非 HTTPS、非准入端口 | 不连接受禁地址；逐跳复验；不能只测 URL 字符串 |
| 网页失败 | 404、超时、超大/压缩响应、非 HTML、动态空壳、正文 null | 状态与实测一致；超限在读取阶段终止；不隐式调浏览器 |
| 网页脚本负控 | script/iframe/图片子资源与含“忽略规则”的正文 | DOM 不执行脚本，不加载子资源；指令只作为文段 |
| 计算正控 | `0.1+0.2`、括号、负数、有限幂次、sqrt/round | 十进制预期值、显示精度和配置；源结果与可见结果一致 |
| 计算负控 | 除零、未知函数、赋值、属性访问、import、嵌套 evaluate、超长/深 AST、巨指数 | 禁止的输入在执行前拒绝；超时终止；不是靠正则名称黑名单 |
| OCR 正控 | 中文、英文、混合文本；关键数字；不同分辨率/旋转 | 独立参考转录与逐样本 CER；版本/资产哈希/原图范围 |
| OCR 降档 | 模糊/低对比图片、空图、非图、超大尺寸 | 失败或质量说明；不把空字符串算成功，不借模型猜字 |
| OCR 离线 | 缺语言文件、空 cache、重复识别、取消和后续请求 | 所有受测情形网络调用 0；工作器释放与恢复有计数 |
| 默认关闭 | 四项分别关闭；模块不配置；不匹配闲聊 | 适配器/进程/目标 IO/出站次数为 0；原对话 packet 基线不变 |
| 正文隐私与来源 | 文中包含私密 sentinel、用户事实和工具指令 | 账本/trace/开发者面无正文 sentinel；不新增认知写入；来源类别不伪装 |
| 预算与取消 | 大于额度、裁掉全部片段、运行中取消、下一轮开始 | 实际入模集合准确；裁掉内容不宣称已看到；旧 action 结果不串轮 |
| 失败口吻与前端 | 一项成功、一项拒绝/超时/未启用/部分；文本和语音入口 | 可见回复依据执行事实；语音与字幕消费同一已检查版本 |

OCR 建议以至少 12 个独立合成样本起步；清晰样本建议 `CER <= 5%` 且关键数字全部正确，退化样本单列，不混成一个平均数。该阈值是待审阅提案，尚无本机准确率或延迟结论。

四项都记录冷启动/热请求耗时与峰值内存。建议首轮限制：文件 10 MiB、HTML 2 MiB（解压后）、图片 16 MiB/20 MP、表达式 512 字符/128 节点/深度 16；计算 2 s、网页总计 15 s、文档/OCR 各 30 s。均为防失控设计候选，不是已测性能 SLA；有限指数和结果位数还需 WP0 的具体用例确定。

## 8. 实现后的回归归属

- `.ts` 实现：`pnpm typecheck`；行动声明/触发/执行/口吻变化：现有 `m4.5:test`、`m4.5:verify`、`m4.5:measurement:verify`，加新能力专属门。
- 新当轮契约或 context/turn-gateway：`kernel:test`、`kernel:verify`、`m3.5:test`、`eval:scenarios`、`eval:dryrun`、`eval:providers`；搜索旁路回归要覆盖 M5.5/M5.5.1 的相关门。
- `main.ts`/CLI 装配：按 AGENTS.md 跑 `m4:test` 与 `m4.5:test`；新增用户命令更新使用说明及 `doc:sync`。具体清单开工时对照当前 gates manifest 再固定。
- 工程交付执行 `pnpm m4.5:ci`；生产副本与真模型短链只有在其范围/预算明确后执行。离线组件正确、LG 接线、真人体验和生产激活四项分别报告。

## 9. 当前准备结论

| 事项 | 当前状态 |
|---|---|
| 四项选择与准备范围 | USER CONFIRMED |
| 两个原注释候选的许可适用性 | USER CONFIRMED APPLICABLE；代码评价另列 |
| 发布版本、分发摘要、18 份源码指纹与接入缺口 | PREPARED |
| Node 版本门槛与 Python 基础解释器可用性 | OBSERVED；不等于包安装/导入验证 |
| 完整传递依赖锁、OCR 资产下载/实际哈希 | NOT RUN |
| 组件准确率、延迟、内存与释放 | NOT RUN |
| LG 内容契约、触发、适配器、前端和回复接线 | NOT STARTED |
| 真实端到端验收与生产激活 | NOT RUN / NOT STARTED |

主要残余：文档结构与页码保真、扫描 PDF 渲染、中文 OCR 质量、Windows 进程资源上限、网络连接级地址约束、当轮数据预算及触发兼容性。准备包将这些列为待验事项，不把源码核对转换为能力已可用。

准备包复核：JSON 可解析；18 份来源指纹格式有效；4 个 npm 主组件的发布 gitHead 与源码快照一致；9 个本地链接存在；18 个实现/配置文件的前后 SHA-256 一致。复核结果 `PASS` 的范围仅为本准备包，不代表四项能力的工程或行为验收。
