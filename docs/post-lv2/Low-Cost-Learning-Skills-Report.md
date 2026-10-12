# 苏沐薇：低成本技能与 arXiv MCP 接入记录

授权：用户「行，按顺序接入」，并选择在项目内新建专用资料夹。设计载体：[ADR-119](../adr/ADR-119-low-cost-learning-skills.md)。

已按顺序接入并启用：

| 能力 | 现在可以做什么 | 使用例子 |
|---|---|---|
| 个人资料整理 | 在 `data/personal-library` 检索文本/文件名，引用实际文件；深读复用现有文件/文档工具 | 「帮我整理资料夹里关于学习方法的笔记」 |
| 精简写作协作 | 按需采用背景、结构、局部修改、读者检查；保持苏沐薇的表达 | 「帮我把这段整理成给同学看的短报告」 |
| arXiv MCP 0.8.1 | 查论文、摘要、BibTeX，以及有界正文/章节 | 「在 arXiv 找 Attention Is All You Need，给我论文ID和摘要」 |

资料夹：`C:\Users\user\Desktop\project LG\data\personal-library`。目前为空；把需要整理的 TXT/Markdown/CSV/JSON/PDF/Office 文件放进去即可。PDF/Office 首次检索只按文件名，正文通过已授权的文档阅读工具取得。

安装到 LG 项目内，不是 Codex 的个人技能目录。流程源文件在 `resources/workflow-skills`，两份原创中文简写；写作流程参考 Anthropic doc-coauthoring 的阶段设计。arXiv 环境在 `artifacts/post-lv2/local/low-cost-skills/arxiv-venv`，依赖锁定58项。主包 Apache-2.0，依赖保留各自许可；未安装 pro/sentence-transformers/Torch。

代价读数：环境文件合计259891378字节，约247.85MiB（独立 Python 运行时和 uv 全局下载缓存另计）。无需新增 API 订阅或 API Key；现有模型决策、规划和回复仍耗 token，未计量账单。三项能力独立渲染的目录895字符；流程正文按需加载，不进入普通闲聊的流程 section。MCP 单次调用启动、结束退出；元数据45s、正文90s上限。PDF布局依赖已安装，原始PDF转换路径未单独验收；已验证的冷读取来源是 arXiv HTML。

机械保护：固定两个流程ID；固定六个 MCP 工具；资料检索只读专用目录；所有调用经既有 Policy/Gateway 与动作账本。流程必须成功加载且指纹匹配才能作为当轮指令；材料与论文是非受信数据。MCP正文最多12000字符，当轮摘录最多5000字符；超过额度会如实裁掉，不能说全文已读。下载缓存属于写操作，干跑会拒绝。没有自动缓存清理配额。

验证分列：

- 隔离库 + 真实 Gateway/账本/ContextCompiler + 真实 arXiv MCP：**27/27 PASS**，包括从空缓存读取正文、权限拒绝、指纹伪造拒绝、目录链接越界、下一轮不继承流程、实际进程超时与同进程新请求恢复。生产库没有打开或复制。
- 真模型 + `src/main.ts` 本身 + 新建隔离库：**3/3 PASS**，三项能力分别执行成功；论文ID为1706.03762。使用 `.env.test` 测试端点，原生产Key未用于测试。现有自然语言长期收益没有单独评价。
- 工具目录/决策契约：**145项输入 PASS**；激活后22项登记、21项启用、21项已授权。角色工具路径回归 PASS。
- 配置/资产读回：**7/7 PASS**。这层只证明开关、角色决策档、两个流程指纹、33项固定 MCP/启动源码指纹和内容额度，不替代真实出站证据。
- `pnpm m4.5:ci`：**PASS，退出码0**（包含 typecheck；完整串行链，不用缓存）。本轮工作树同时存在其它会话的在途修改，这个读数是机械回归证据，不发布新的全项目里程碑结论。

失败记录保留在 `artifacts/post-lv2/learning-skills`，不回写成 PASS：首次测试路径/会话序号问题；两次冷读取卡在上游自动语义索引的 NumPy native import；正文取得但超出当轮额度而未入模；首次标题裸查询命中了其它论文。已分别修正测试装配、固定 bootstrap 关闭自动索引、控制当轮摘录范围、在目录中明确 `ti:"标题"` 查询。最初全量日志采集器因 GBK 输出失败，退出码无法采信，已保留日志并完整重跑。

生产配置已追加三个 true 开关：CHARACTER_PERSONAL_LIBRARY_ENABLED、CHARACTER_WORKFLOW_SKILLS_ENABLED、CHARACTER_ARXIV_RESEARCH_ENABLED。当前未发现运行中的 `src/main.ts` 对话进程；下次正常启动她即采用这些配置。真实用户普通聊天首次使用仍未观测。关闭相应开关即可停用，资料、缓存、账本不删除，生产数据库无迁移。

最终载体：`artifacts/post-lv2/learning-skills/verify-20261007T170821704Z/acceptance.json`、`main-live-1791393050756/acceptance.json`、`activation-1791392926286/readback.json`、`ci-summary.json`。原始真模型日志与完整回归日志保存在被忽略的 `artifacts/post-lv2/local/low-cost-skills`，不把测试日志里的临时路径/上下文扩大到普通聊天。

可复现命令：

```powershell
py -3.10 scripts/learning-skills/install-arxiv.py
pnpm exec tsx scripts/learning-skills-verify.ts --live
pnpm with-test-model pnpm exec tsx scripts/learning-skills-main-live.ts
pnpm exec tsx scripts/learning-skills-activation-readback.ts
```
