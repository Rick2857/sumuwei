# 苏沐薇已加装能力生效核查（2026-10-05）

> 同日 18:07 用户授权后，天气 / 办公生成 / 资讯已启用并回读为 true，见 [ADR-103](../adr/ADR-103-productivity-weather-office-news-activation.md)。本文保留启用前的核查快照；当前三项配置以该激活记录为准。

核查范围：前两批实用能力、本机文件权限和任务自主执行。配置回读于北京时间 16:55:57；本轮隔离测试于 16:56:22 完成。

**结论：第一批四项已启用且本轮隔离测试全过；本机文件读写与任务自主已启用并通过测试；天气、办公生成、资讯三个专用能力仍关闭；浏览器开关已开，但当前服务连接失败，真实登录会话尚未验证。**

## 1. 当前配置与逐项结果

配置使用与 LG 启动相同的 `readKernelFlags()` 回读，代表新进程会加载的取值。当前 `actionEnabled=true`，当轮内容额度为 3000 token。

| 能力 | 当前配置 | 本轮证据与结论 |
|---|---|---|
| 精确计算 | `mathCalculateEnabled=true` | math 六组通过，公共接线八组通过；真实 mathjs 执行器可用 |
| 文档阅读 | `documentReadEnabled=true` | document 六组通过；PDF、DOCX、PPTX、XLSX 文本提取通过 |
| 网页深读 | `webReadEnabled=true` | web 六组通过；使用真实提取组件和受控 HTTP 夹具，覆盖静态正文与地址/体积/超时边界 |
| OCR | `imageOcrEnabled=true` | OCR 六组通过；当前后端 RapidOCR，三个清晰中/英/混合样本 CER 均为 0%，不外推为广泛准确率 |
| 本机文件读取 | `localFileReadEnabled=true` | 沙箱外合成文件实际读取，正文进入当轮上下文；file-01 通过 |
| 本机文件创建、修改、覆盖 | `localFileWriteEnabled=true` | 文件实际落盘、覆盖前恢复副本和覆盖后指纹均核对；file-02/03 通过 |
| 任务自主执行 | `taskAutonomyEnabled=true` | 有限任务环的读→写、预算停止与内容汇聚回归通过；离线规划器替换模型，尚不能证明任意真人任务可完成 |
| 天气专用查询 | `weatherEnabled=false` | 接线和四组隔离测试通过；当前配置未启用 |
| Word / Excel / PPT 生成 | `officeGenerateEnabled=false` | 依赖齐全，四组隔离测试通过；当前配置未启用 |
| RSS / Atom 资讯阅读 | `newsReadEnabled=false` | rss-parser 已装，四组隔离测试通过；当前配置未启用 |
| 浏览器读取与操作 | `browserEnabled=true` | sidecar、扩展和 token 文件已装；当前 8931 端口未监听，生产适配器首连检查失败；真实登录态、正常动作焦点影响及用户标签保留未验收 |

天气与资讯的既有联网搜索另有自己的开关；搜索能回答相关问题，并不证明这两项新增专用能力已启用。

任务预算为 30 个动作、6 次规划、10 分钟。普通聊天风险上限仍 R1；浏览器 R2 操作通过任务授权执行。

## 2. 本轮实际执行的检查

| 检查 | 本轮结果 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm utility:verify --label effectiveness-audit` | EXIT 0；32 PASS / 0 FAIL / 0 NOT RUN，150 条参数化输入 |
| `pnpm productivity:verify --label effectiveness-audit` | EXIT 1；27 PASS / 0 FAIL / 1 NOT RUN，102 条参数化输入；聚合为 **NOT PASS** |
| `pnpm productivity:sidecar:check` | EXIT 1；传输层 `fetch failed`，当前服务未连接 |
| OCR 生产模型只读核对 | 三个模型字节数与 SHA-256 全匹配，Python 存在 |
| 浏览器固定组件只读核对 | @playwright/mcp 0.0.83；入口 SHA-256 匹配；Chrome Default 下扩展 0.4.0_0 存在；token 文件存在，未输出凭据 |

第二批唯一未运行项是 `browser-04`：真实已登录会话、焦点影响和用户标签保留。前三组浏览器测试使用受控 sidecar，不能替代它。

本轮实际复核的依赖：mathjs 15.2.0、jsdom 30.1.2、Readability 0.6.0、MarkItDown 0.1.8、RapidOCR 3.9.2、ONNX Runtime 1.20.1、python-docx 1.2.0、python-pptx 1.0.2、openpyxl 3.1.5、rss-parser 3.13.0。

两份新运行证据记录的源码指纹分别覆盖 42、49 个文件；测试后复核均匹配当前文件。此前计算在高负载下超时的失败档保留，本轮未复现。

## 3. 当前运行状态与适用范围

检查时 8931、12393、12394 均未监听；未发现这两个默认端口上的 LG 聊天服务。本轮确认的是配置、实际组件与隔离的 TurnGateway/动作链路，模型和联网响应采用离线替身或夹具。生产真人聊天和已有登录账号操作仍需单独记运行证据。

2026-10-05 的语音外壳事故记录已经证明 `local.file.list` 曾被实际调用，但当时整轮因内容份数上限失败；本轮汇聚回归通过，不能把那次事故写成一次成功完成的用户任务。事故与修法见 [R-53 执行记录](Productivity-Skills-Turn-Content-Overflow-Fix-2026-10-05.md)。

后续影响使用的具体事项：启用天气、办公生成、资讯三个专用开关；启动浏览器 sidecar 并完成目标登录页面的真实连接验收。

## 4. 本轮证据

- [配置、依赖与端口回读](../../artifacts/post-lv2/skills-effectiveness-audit-20261005/readback.json)
- [第一批 32 组新运行](../../artifacts/post-lv2/utility-skills/effectiveness-audit-20261005T085040-6d073986-49d9/run.json)
- [第二批 28 组新运行](../../artifacts/post-lv2/productivity-skills/effectiveness-audit-20261005T085456-6d073986-2fc1/run.json)
