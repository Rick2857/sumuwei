# 首批 OCR 未达标：根因与现成方案修复建议

日期：2026-10-04。范围：调查首批 `image.ocr` 的未达标原因，复现原样本，比较现成组件并给出接入方案。

调查结束时状态：**调查完成；替代组件清晰样本通过；生产替换未实施；LG 全链复验未运行**。
调查阶段仅新增本报告与隔离诊断环境/探针；未修改生产 OCR 源码、`.env` 或打开 `data/pglite`。
**后续已获用户授权并完成接入**，当前验证读数见 [OCR 修复执行记录](../post-lv2/OCR-Repair-Execution-2026-10-04.md)。
既有报告中的 FAIL / PARTIAL 不回写。现场 `CHARACTER_IMAGE_OCR_ENABLED=true`；开启状态不改变准确率判定。

## 1. 原失败是什么

[首批报告](../post-lv2/Utility-Skills-Acceptance-Report.md) §3.1 / §5.2 的两个准确率失败，已在本轮用原图和现有工作器复现：

| 原样本 | 原模型输出中的错误 | CER | 原判据 |
|---|---|---:|---|
| `img-zh.png` | `：` → `:` | 8.33%（1/12） | FAIL，要求 ≤5% |
| `img-en.png` | 无字符错误 | 0% | PASS |
| `img-mixed.png` | `薇` → `微` | 5.88%（1/17） | FAIL，要求 ≤5% |

关键数字 `22.5 / 4711 / 2026-10-04 / 37 / 21` 都正确。CER 已去除空白，错误不是中文字符间多余空格造成的。
原图是清晰的合成打印文字；本轮使用同一 manifest、参考转录及图片 SHA-256，没有换样本或调整阈值。

原组件探针的 `21/21` 检查执行、内容契约、关键数字及生命周期等，**不检查 CER ≤5%**。
因此它与正式准确率 FAIL 并不矛盾；不能把组件探针 PASS 解读成 OCR 达标。

## 2. 已确认的根因

**全角冒号是现有语言模型的字符表边界。** 本轮直接解包本机锁定的两个 `.traineddata.gz`，
按 Tesseract 的 `TESSDATA_LSTM_UNICHARSET=21` 读取 LSTM 字符表：

| 本机资产 | 字符表大小 | 含 `：` | 含 `:` | 含 `薇` |
|---|---:|---|---|---|
| `chi_sim`，SHA-256 `b8a23f10…` | 4022 | 否 | 是 | 是 |
| `eng`，SHA-256 `45b4cb34…` | 112 | 否 | 是 | 否 |

这两个模型的字符表都没有 U+FF1A。现有组合无法直接输出参考转录所需的全角冒号，
因此仅调整页面分割或语言顺序，无法修复这个逐字判据。
分段定义核对了 [Tesseract 官方源码](https://github.com/tesseract-ocr/tesseract/blob/main/src/ccutil/tessdatamanager.h)，
但上表结论来自**本机实际安装资产**，不是拿上游新文件代替本机文件。

**“薇→微”与当前多语言组合有关。** 相同图、相同资产、相同默认分割方式，
`eng+chi_sim` 输出“微”，改为 `chi_sim` 输出“薇”。这是有对照证据的配置影响；
本轮没有进一步定位到解码器内部的具体评分机制。

| 本轮 Tesseract 对照 | 中文 CER | 英文 CER | 混合 CER |
|---|---:|---:|---:|
| 现有默认 `eng+chi_sim` | 8.33% | 0% | 5.88% |
| 仅 `chi_sim` | 8.33% | 0% | 0% |
| `eng+chi_sim` + 单行 PSM 7 | 8.33% | 0% | 5.88% |

所以单中文模型只能解决一处错误；PSM 7 没有解决本批失败。没有证据支持“换个参数就能全部通过”。

**缺资产时还有独立的回复原因丢失问题。** 既有 `L-US-06b` 已记录真模型失败：
适配器知道“本地 OCR 资产不可用”，但 `turnContentFactsOf()` 只取 `failureCode`，
资产失败与普通执行失败都变成 `execution_failed`。回复层不能区分，可能猜成“图片/格式有问题”。
本轮源码核对确认该信息缺口；这是接线缺陷，更换 OCR 引擎不会自动解决它。

## 3. 推荐的现成组件与本机结果

建议首选 **RapidOCR 3.9.2 + ONNX Runtime CPU + 显式固定 PP-OCRv4 mobile 检测/识别模型**。
RapidOCR 提供现成的检测、方向分类、识别流水线，支持中文/英文及指定本地模型路径；
无需自己训练、转换模型或编写识别算法。来源：
[项目](https://github.com/RapidAI/RapidOCR)、[本地模型用法](https://rapidai.github.io/RapidOCRDocs/main/install_usage/rapidocr/how_to_use_offline_model/)、
[v3.9.2 模型清单](https://github.com/RapidAI/RapidOCR/blob/v3.9.2/python/rapidocr/default_models.yaml)。

本轮独立 venv 固定 `rapidocr=3.9.2`、`onnxruntime=1.20.1`、`numpy=1.26.4`、`opencv-python=4.11.0.86`。
模型按上游版本清单下载并校验 SHA-256；推理只传原始图片字节，显式指定全部本地模型路径。

| 原样本 | RapidOCR + PP-OCRv4 mobile CER | 关键数字 | 本轮清晰样本判定 |
|---|---:|---|---|
| 中文 | 0% | 全对 | PASS |
| 英文 | 0% | 全对 | PASS |
| 混合 | 0% | 全对 | PASS |

三张清晰样本使用原判据，均通过；没有替换“微”、转换冒号或用 LLM 补字。
中文图被检测为两个文字框，拼接时使用换行；原 CER 规则忽略空白，**不意味着原图行布局已保真**。
模型初始化约 322ms，已初始化引擎三张清晰图识别分别约 1961 / 1994 / 1932ms，
这些是组件读数，不含生产入口、Python 导入、上下文编译或模型回复时间，不是完整调用 SLA。
CPU provider 为 `CPUExecutionProvider`，本轮 Python 网络守卫观测调用 0；这不是 OS 级网络沙箱证明。

**并非选最新模型就能通过。** 同一环境还保留了以下未通过比较：

- 默认 PP-OCRv6 small：中文/英文 0%，混合 35.29%，字符虽然认对，但文字框输出顺序错误。
- PP-OCRv5 mobile，RapidOCR 默认预处理：中文 33.33%，英文/混合 0%，中文出现漏字/误检。
- PP-OCRv5 mobile，改为 Paddle 官方训练配置的 mean/std 作对照：中文 75%，英文 2.70%，混合 5.88%；仍未通过，不能据此裁定默认预处理就是其失败根因。

因此推荐**本机通过的固定 v4 组合**，不依赖 RapidOCR 可变化的模型默认值。
本轮比较是组件选型证据，不宣称 v4 普遍优于 v5/v6。

**残余需要保留：** v4 对原模糊图返回空结果，原空白图也返回空结果。
它没有证明“模糊图也能读全”，更没有关闭完整 OCR 六组或真人使用验收。
现有 `ocr-04` 实现额外要求退化图有文字且关键数字全对；替换后该门不能原样宣布 PASS。
[原计划](../post-lv2/Utility-Skills-Execution-Plan-2026-10-04.md)允许退化输入如实失败/报告范围，
接入时应明确对齐该降档行为，并保留旧失败读数；清晰样本的 ≤5% 判据保持不变。

## 4. 最小接入与验证方案（调查时未实施；后续已获执行授权）

用户随后授权「确认完方案后你直接执行」。接入与新验证结果见
[OCR 修复执行记录](../post-lv2/OCR-Repair-Execution-2026-10-04.md)；以下保留调查时提出的步骤。

1. **固定资产和独立 OCR 环境。** 为上述已测组合建立安装锁与三项模型哈希；准备阶段下载，
   识别阶段禁止下载。保留旧 Tesseract 安装与资产用于回滚。
2. **只替换 OCR 执行器。** 保持 `image.ocr` 能力 ID、现有 Gateway/Policy、沙箱目标解析、
   16MiB/20MP/30 秒上限及 `OcrTurnContent` 通道；Python 子进程仅收已授权图片字节，
   返回识别文字、置信分数、引擎/模型版本及范围。子进程仍须可取消、超时后退出并恢复。
   这里需要新的短 Python 包装器，不需要通用技能加载器、云 OCR 或第二条 Agent 执行路径。
3. **修复失败原因透传。** 适配器给出有限原因标记，如 `ocr_assets_missing`；
   回复事实提取器只透传这类允许的标记，避免将原始异常、路径或全文透传。
   已知缺资产时由程序生成确定性失败说明，防止模型继续猜测图片质量或格式。
4. **复验实际接线。** 先跑 `pnpm typecheck` 与 `pnpm utility:verify --only ocr`，
   对清晰三图、空/模糊图、缺资产零出站、非法/超限输入、取消/超时及下一次恢复逐项记读数。
   新执行器必须补自己的生命周期与网络守卫证据，不能继承旧 Tesseract 的探针结论。
5. **交付前再收口。** 复验受影响公共接线与 OCR 的真模型成功/缺资产两条短链，
   最后按仓库纪律完成对应交付版本的 `pnpm m4.5:ci`。只有这些完成后才能修订生产能力判定；
   本轮组件结果不能直接把 `PARTIAL` 改成整项 `PASS`。

不建议修改参考答案、把全角/半角计为同一个字符、定向替换“微→薇”或用 LLM 润色后计算准确率。
这些做法会绕开本批原要求，也无法获得可信的修复证据。

## 5. 本轮证据与复现入口

原始读数及模型/环境位于已忽略目录 `artifacts/post-lv2/local/ocr-diagnosis-20261004/`：

- `charset-results.json`：本机两个锁定语言资产的实际字符表检查。
- `tesseract-results.json`：三种配置 × 原五图；现有工作器正常运行，网络自报 0。
- `rapidocr-v4-results.json`：推荐组合的原五图输出、CER、框、分数、耗时和模型 SHA-256。
- `rapidocr-results.json`、`rapidocr-v5-results.json`、`rapidocr-v5-matched-preprocess-results.json`：失败候选，不覆盖。
- `install-report.json`、`requirements.lock.txt`、`v4-assets.json`、`v5-assets.json`：固定依赖、模型来源与哈希。

复现推荐组合：

```powershell
& 'artifacts/post-lv2/local/ocr-diagnosis-20261004/venv/Scripts/python.exe' -X utf8 'artifacts/post-lv2/local/ocr-diagnosis-20261004/probe-rapidocr.py' v4
```

该命令只运行组件探针；不调用 LG、不打开数据库。诊断依赖和模型在本机保留，干净检出不能仅靠本报告自动获得它们。
