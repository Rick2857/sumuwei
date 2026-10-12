# 苏沐薇按需查看与操作 Windows 桌面：现成方案调研

日期：2026-10-05。范围：GitHub 候选、环境要求与 LG 接入适配性。
**本轮只有只读调研与本报告；未安装、未启动桌面控制服务、未修改生产配置。**

## 结论

优先评估 **CursorTouch/Windows-MCP**，以 **sbroenne/mcp-windows** 为备选。
两者都提供现成桌面执行工具，可由 LG 判断何时调用。安装工具本身并不能自动完成 LG 接入。
Windows-Use 与 Microsoft UFO 也具备相关能力，但包含自己的代理框架，整套接入会与 LG 已有决策和任务执行环重叠；这属于代码适配取舍，不是许可证排除。

## 已核实的 LG 现状

- `CHARACTER_TOOL_DECISION_MODE=role` 已配置，且任务自主执行已启用。现有角色决策可以提出调用已登记的工具，随后由既有任务执行环执行。见 [ADR-105](../adr/ADR-105-role-tool-decision-activation.md)。
- 当前工具目录没有桌面查看或桌面操作能力。见 `src/kernel/action/tool-catalog.ts` 与 `src/main.ts` 的有限能力表。因此“能够自主选工具”不能等同于“现在已经能控制桌面”。
- 工具决策和任务规划的模型消息目前走文本内容；尚无截图输入接线。见 `src/infrastructure/model/openai-tool-decision.ts` 与 `openai-task-planner.ts`。现有 OCR 是文件能力，没有现成的屏幕截图到决策链。
- 本机已装 Python 3.14，路径为 `C:\Users\user\AppData\Local\Programs\Python\Python314\python.exe`。将来可使用独立环境，不必升级现有文档/OCR 环境。

## 候选比较

| 项目 | 已核实的现成能力 | 环境与接入影响 | 建议 |
|---|---|---|---|
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | 读取窗口/控件状态，截图，点击、输入、滚动、快捷键；支持 UI Automation 文本状态与工具白名单 | Python 独立进程；现有 Python 3.14 满足清单要求；接入 LG 的有限桌面能力 | 首选候选 |
| [sbroenne/mcp-windows](https://github.com/sbroenne/mcp-windows) | 查找控件、按已观察的控件 ID 点击/输入、读取表格、管理窗口；截图及鼠标键盘备用路径 | 有自带运行时的独立 Windows 二进制包，可避免增加 Python 依赖；仍需 LG 适配 | 原生独立包备选 |
| [Jeomon/Windows-Use](https://github.com/Jeomon/Windows-Use) | 完整 Windows GUI 代理，自行规划和操作 | 另有代理决策、记忆与语音等组件，整体接入重叠较多 | 参考执行层，不优先整套引入 |
| [microsoft/UFO](https://github.com/microsoft/UFO) | Windows 桌面代理、UI 收集/执行及应用 API 集成 | 框架范围较大；其 Windows 本地 MCP 服务嵌在进程内，不能直接当成独立桌面服务包 | 复杂跨应用任务的参考方案 |

上述仓库本次查看均标为 MIT。仓库文档的能力描述属于上游声明与源码审阅结果，**尚未在你的中文 Windows 和 LG 上运行验证**。

## 版本与具体差异

1. **Windows-MCP**：本次最新发布为 [v0.8.7](https://github.com/CursorTouch/Windows-MCP/releases/tag/v0.8.7)，发布于 2026-09-30；调研主分支为 `8e32225f96ff9d61513b8fbbb8bfde60a13b0dd3`。主分支比该发布多 7 个提交，后续实施需固定实际采用的版本，不能混用两者的证据。
   - [发布版依赖清单](https://github.com/CursorTouch/Windows-MCP/blob/v0.8.7/pyproject.toml) 要求 **Python >=3.14**，README 的 3.13+ 描述不一致；按依赖清单准备。
   - 上游默认开放全部工具，并带 PowerShell、Registry 等额外能力。未来只登记任务需要的桌面操作，可使用其现成白名单。
   - 上游匿名遥测默认开启，提供 `ANONYMIZED_TELEMETRY=false`。中文系统的 App 工具存在语言限制，应优先验证已有窗口与控件操作，不改变系统语言。
2. **mcp-windows**：本次最新发布为 [v1.3.27](https://github.com/sbroenne/mcp-windows/releases/tag/v1.3.27)，发布于 2026-10-01；调研提交为 `a76b3eeb075419986d0b00721bae5cdc896c2f81`。
   - 独立 x64/ARM64 包自带运行时。这里推荐独立包，VS Code 扩展的运行时要求不能与独立包混为一谈。
   - [功能说明](https://github.com/sbroenne/mcp-windows/blob/a76b3eeb075419986d0b00721bae5cdc896c2f81/FEATURES.md) 提供文字/表格状态；部分标准打开/保存对话框快捷辅助依赖英文标签，中文路径仍需验证。

## 与“由她决定”的接入关系

建议沿用：**用户目标 → 苏沐薇选择是否需要桌面信息 → 查看窗口/控件 → 选择操作 → 读回结果 → 继续或回复**。
先用 UI Automation 的控件文字、类型、状态和位置形成有界上下文，适配现有文本模型路径；纯图片、自绘画布等界面再评估截图多模态或 OCR 接线。

| 影响项 | 将来需要的适配 |
|---|---|
| 能力 | 新增有限的桌面查看/操作能力及其适配器；复用现有角色决策、ActionRequest、策略、任务预算、账本与回复事实约束 |
| 权限和副作用 | 查看当前用户桌面；操作可能切换焦点、移动鼠标并改变应用状态。实际输入会与人的使用共用桌面，不能承诺完全后台执行 |
| 认知与记忆 | 桌面状态作为本轮工具观察；不自动扩为长期记忆，也不引入第二个认知主体 |
| 验证 | 后续集中验证中文控件读取、一次真实操作及读回、用户接管/停止、关闭后不可调用；复用共同证据，不重复每个工具的全套验收 |

这是一份候选评估，尚未冻结具体能力名称、风险分级或适配接口。现有桌面执行器的输入权限也受 Windows 进程权限影响，普通进程不能据此承诺操作管理员窗口。

## 本轮完成状态

GitHub 与发布/源码审阅：已完成。LG 当前决策链及 Python 环境核对：已完成。
安装、桌面实机探针、LG 适配与生产激活：**NOT RUN**。
