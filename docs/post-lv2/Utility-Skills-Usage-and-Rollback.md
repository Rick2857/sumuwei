# 苏沐薇实用能力 —— 使用与回滚说明

日期：2026-10-04。载体：[`Utility-Skills-Execution-Plan-2026-10-04.md`](Utility-Skills-Execution-Plan-2026-10-04.md) §5。
适用范围：本批四项能力（精确计算 / 文档阅读 / 网页深读 / OCR）。

> 本文只讲**怎么用**与**怎么退回去**。逐项读数、残余与判定见
> [`Utility-Skills-Acceptance-Report.md`](Utility-Skills-Acceptance-Report.md) 与
> [`Utility-Skills-WP0-Baseline.md`](Utility-Skills-WP0-Baseline.md)。

---

## 1. 四个开关（代码缺省全 `false`）

| 能力 | 开关（`.env`） | 打开后发生什么 |
|---|---|---|
| 精确计算 | `CHARACTER_MATH_CALCULATE_ENABLED=true` | 授予 `math:calculate`、构造受限计算器适配器、检测器认得"算一下 …" |
| 文档阅读 | `CHARACTER_DOCUMENT_READ_ENABLED=true` | 授予 `document:read`、构造文档适配器（专属 Python 环境）、检测器认得 `.pdf/.docx/.pptx/.xlsx` + 读的动作词 |
| 网页深读 | `CHARACTER_WEB_READ_ENABLED=true` | 授予 `web:read`、构造有界获取适配器、检测器认得显式 `https://` URL + 读的动作词 |
| OCR | `CHARACTER_IMAGE_OCR_ENABLED=true` | 授予 `image:ocr`、构造本地 OCR 适配器、检测器认得 `.png/.jpg/.jpeg` + 识别的动作词 |

另有**一个额度**（不是开关）：

```text
CHARACTER_TURN_CONTENT_TOKENS   # 当轮内容进上下文的独立额度；代码缺省 0（= 不注入）
```

⚠️ **打开能力 ≠ 内容进上下文**：两者是**两件事**，都打开才有完整闭环。
代码缺省值 **0** 是刻意的 —— "今天不注入当轮内容"是一个真实配置（先例 ADR-048 / `rollupTokens`）。

**回滚**（任一能力）＝ 把对应开关改回 `false`（或删掉那一行）：
适配器**不再构造**、权限**不再授予**、检测器**不再产生请求** ⇒
不加载重依赖、不 spawn 进程、不访问目标、不出站。当轮内容那一段随额度回到 0 而消失。
**不需要**数据库迁移或恢复；账本里已生成的记录与报告保留。

---

## 2. 用户怎么说才触发（**只有明确触发**）

| 能力 | 触发形状 | 例子 |
|---|---|---|
| 精确计算 | 计算动作词 **+ 一个可抽取的算式**（至少一个数字 + 一个运算符/括号/白名单函数） | 「帮我算一下 `0.1+0.2`」「(1+2)*3 等于多少」 |
| 文档阅读 | `.pdf/.docx/.pptx/.xlsx` 形态的路径 **+ 读的动作词** | 「读一下 report.pdf」「看看 quarterly.xlsx」 |
| 网页深读 | **显式 `https://` URL** + 读的动作词 | 「读一下 https://example.com/a」 |
| 图片识别 | `.png/.jpg/.jpeg` 形态的路径 + 识别/读的动作词 | 「识别一下 scan.png」「图里写了什么：chart.jpg」 |

三条刻意的边界（保证不抢旧路径）：

```text
· `.txt/.md/.csv/.json/…` 仍走 M4.5 的 sandbox.file.read（本批的扩展名白名单里没有它们）
· 检测器在**能力开关关闭时不产生任何请求**（而不是产生一条注定被拒的请求）
· 一轮只做**一项**明确能力；组合任务返回范围说明，不做自动多步代理
```

---

## 3. 四项能力各自的实际边界

| 能力 | 支持 | **不支持**（如实降档，不假装） |
|---|---|---|
| 精确计算 | 十进制四则、括号、负数、受限整数幂（\|指数\| ≤ 1000）、`abs/sqrt/round`；BigNumber 64 位有效数字 | 单位换算、统计、矩阵、赋值/数组/属性访问/`import`/嵌套求值/任意函数、任意程序执行 |
| 文档阅读 | 文字型 PDF、DOCX、PPTX、XLSX、纯文本；保留转换器实际给出的标题/表格/工作表/幻灯片标记 | 扫描件与图片型 PDF（返回"没有可提取的文字"）、**页码与精确定位**（转换器不保留 ⇒ 本批不提供）、加密文件、>10 MiB、展开 >50 MiB 或 >1000 成员的容器 |
| 网页深读 | 静态 HTML 文章正文（Readability 提取，去导航/广告）；最多 3 次重定向 | 登录态、验证码、动态渲染空壳、浏览器自动操作、非 HTTPS、非 443 端口、回环/私网/链路本地地址、解压后 >2 MiB、>50,000 DOM 元素、总耗时 >15 s |
| OCR | 沙箱内 PNG/JPEG，简体中文与英文；本地语言资产 | 扫描 PDF、摄像头、屏幕、剪贴板、>16 MiB 或 >20 MP 的图片；**引擎 confidence 不等于校准过的准确率** |

### 3.1 两条必须知道的口径

1. **来源与范围附录由程序生成**：四项能力交付时，程序会按"实际入模的那几份"追加一行
   `来源与范围：`。模型自己写的 `[C1]` 这类内联标签会被**剥离**（它放在哪句话后面无法被机器验证）。
2. **只读到一部分就说一部分**：正文被程序截断或整段被预算裁掉时，
   `scope` 与 trace 里都记着"实际入模了多少"，回复层据此只能说"我没拿到"。

### 3.2 OCR 当前后端与回滚（2026-10-04 修复）

生产装配缺省选择 **RapidOCR 3.9.2 + ONNX Runtime 1.20.1 CPU + 固定 PP-OCRv4 mobile**。
原三张清晰图逐样本 CER 都为 0%，数字全部正确；退化图与空白图返回空结果，不能据此声称广泛准确率。
诊断与后续执行证据见 [OCR 修复报告](OCR-Repair-Execution-2026-10-04.md)。

```powershell
# 准备阶段安装精确版本并下载/核对固定模型；日常识别不调用此脚本。
pnpm exec tsx scripts/utility-skills/setup-rapidocr.ts
```

独立环境与模型保存在 `artifacts/post-lv2/local/ocr-runtime/`。可用
`PROJECT_LG_RAPIDOCR_PYTHON` 与 `PROJECT_LG_RAPIDOCR_MODEL_DIR` 指定已准备好的绝对路径；
缺失或指纹不符时直接失败，不自动补下载。

**后端回滚**：在 `.env` 设 `PROJECT_LG_OCR_BACKEND=tesseract` 并重启聊天；删此行恢复 RapidOCR。
**整项关闭**：设 `CHARACTER_IMAGE_OCR_ENABLED=false` 并重启聊天。
旧 Tesseract 依赖、资产与执行器保留，回滚可运行，但其中文/混合准确率未达门槛的原结论仍有效。

### 3.3 Tesseract 回滚后端的历史实测口径

```text
· 语言加载顺序：用 `eng+chi_sim`（**不要**用 `chi_sim+eng` —— 它会静默丢掉英文）
· 代价：在退化中文图上 `eng+chi_sim` 的读数低于 chi_sim-only（实测 67 vs 75）
  ⇒ 这是**如实登记的取舍**，不是"两全"
· 缺语言资产：**零出站**，而且必须靠自己的超时/`errorHandler` 才能看到失败
  （`createWorker()` 在缺资产时不会 reject，会一直不返回）
```

---

## 4. 验收命令

```bash
pnpm utility:verify --list                          # 只打印 32 组的形状（不跑任何东西）
pnpm utility:verify --only math|document|web|ocr     # 开发中短测：公共 8 组 + 该项 6 组
pnpm utility:verify                                 # 32 组完整组合离线验收
pnpm with-test-model pnpm utility:verify --live       # 八轮真模型短链（隔离库，不碰生产库）
```

公开证据落在 `artifacts/post-lv2/utility-skills/<runId>/`（`run.json` + 报告）；
原始正文、图片、模型输入输出落在已忽略的 `artifacts/post-lv2/local/utility-skills/**`。

---

## 5. 组件与资产

| 组件 | 固定版本 | 装在哪 |
|---|---|---|
| `mathjs` | 15.2.0 | 根项目依赖（精确版本，lockfile 管理） |
| `jsdom` / `@mozilla/readability` | 30.1.2 / 0.6.0 | 同上 |
| `tesseract.js` / `tesseract.js-core` | 7.0.0 / 7.0.0 | 同上（`postinstall` 已在 `pnpm-workspace.yaml` 里**显式拒绝**：它只是募捐横幅） |
| `@tesseract.js-data/chi_sim` / `eng` | 1.0.0 / 1.0.0 | 同上（语言资产由本地路径解析 + SHA-256 核对，**日常识别零 CDN 下载**） |
| `markitdown[pdf,docx,pptx,xlsx]` | 0.1.8 | **专属 Python 3.12.13 venv**（不复用 TTS venv / Torch / CUDA） |
| `rapidocr` / `onnxruntime` | 3.9.2 / 1.20.1 | 独立 OCR venv；完整依赖锁在 `scripts/utility-skills/rapidocr-requirements.lock.txt` |
| PP-OCRv4 mobile 检测/识别 + v2 分类模型 | 三个固定 ONNX 文件 | `artifacts/post-lv2/local/ocr-runtime/models`；内置字节数与 SHA-256 核对 |

专属 Python 环境与 fixture 的重建入口见 [`scripts/utility-skills/`](../../scripts/utility-skills/)：
`make-fixtures.py`（确定性地重出全部 fixture）、`doc-runner.py`（**只吃 stdin 字节**的转换器）。

---

## 6. 本批**不主张**的事

```text
· 不主张"四项已在生产启用"（激活是独立裁定；本文开头那四个开关才是事实）
· 不主张 OCR 有广泛准确率（只有三张清晰样本 + 两个边界样本的读数）
· 不主张"网页全文"（>2 MiB 或超预算时只读一部分，且回复层必须这么说）
· 不主张长期认知绝无变化（当轮数据不新增 MEMORY/BELIEF/STORYLINE 写入入口，
  但正常回复仍会经既有对话记录与消费者）
· 不新建通用技能加载器 / 任意 MCP 工具入口 / 第二个记忆后端
```
