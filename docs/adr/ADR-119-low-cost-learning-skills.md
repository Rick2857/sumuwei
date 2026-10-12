# ADR-119 — 个人资料、写作流程与固定 arXiv MCP

状态：ACCEPTED / IMPLEMENTED。授权：用户「行，按顺序接入」；资料夹选择「项目内新建专用资料夹」。验证与激活读数见 `docs/post-lv2/Low-Cost-Learning-Skills-Report.md`。

1. 顺序：个人资料整理 → 精简写作协作 → arXiv MCP。复用 LG 的角色工具决策、ActionRequest、Policy/Gateway、账本、当轮内容与回复真相链，不加第二个执行权威。GitHub 等其它服务不在本批范围。
2. 两个精简中文 SKILL.md 放在 `resources/workflow-skills/`，固定清单与 SHA256 校验；`workflow.skill.load` 只能选择 personal-library / writing-collaboration。只在成功执行且指纹匹配后加入**当轮**受信 instruction section。普通轮不加载；失败、权限拒绝、伪造指纹均不能注入。加载流程不等于读过资料或完成写作。
3. `library.search.search` 只读 `data/personal-library`。文本按关键词检索；PDF/Office 只按文件名找，深读复用已授权的 document.read。100文件、300目录项、3层、单份128KiB、累计1MiB、返回8项。跳过隐藏与链接；按既有 realpath 包含性守卫解析。截断如实说明。既有本机文档权限不因本能力扩大。
4. 写作流程由 LG 自己按任务规模采用背景、结构、修改、读者检查。参考 Anthropic doc-coauthoring 的阶段设计，采用原创简写，不复制其完整流程，不额外启动模型或审阅代理。默认在聊天交付，用户要求保存才调用既有写文件/Office能力。
5. arxiv-mcp-server 0.8.1 固定版本与独立 Python3.11 venv，安装 [pdf] 而不安装 pro/语义模型。Apache-2.0 主包；依赖按各自许可分发。Python worker 只白名单调用 search_papers/get_abstract/download_paper/read_paper/read_paper_section/export_citations。LG 只公开 search/abstract/read/cite 和有界参数，不能传工具名、服务器地址、存储路径、URL、命令或凭证。
6. 元数据操作 R1/read，正文 R1/write（缓存到 `data/arxiv-cache`）；干跑禁止正文缓存。元数据允许只读网络访问，临时存储随单次进程清理。MCP 按需启动，调用后退出；元数据45s、正文90s硬上限，超时杀进程树，MCP 正文12000字符、响应16000字符、当轮摘录5000字符。不宣称支持任意网页/任意论文；首次下载依赖上游网络，缓存累计容量没有自动清理配额。固定 bootstrap 关闭上游自动语义索引探测：冷下载实测卡在 NumPy native import，而本批六个 MCP 工具不需要该分支；上游已安装源码不改写，bootstrap 同样受指纹校验。
7. 材料和论文是非受信当轮资料，流程资产才是受信指令。正文不落动作账本/trace，不自动晋升长期记忆。网络可能失败；MCP isError 和响应内部 error/status 均检查，失败不能宣称已读正文。角色措辞仍受既有守卫边界约束。
8. 三个代码缺省 false 的开关：CHARACTER_PERSONAL_LIBRARY_ENABLED、CHARACTER_WORKFLOW_SKILLS_ENABLED、CHARACTER_ARXIV_RESEARCH_ENABLED。用户本轮已授权接入与启用。关闭对应开关即可停用；缓存、资料与历史账本保留，不迁移生产库。

可复现安装：`py -3.10 scripts/learning-skills/install-arxiv.py`。依赖版本见 lock，固定 MCP/worker 源码指纹见 arxiv-assets.json；不安装到 Codex 的个人技能目录。

上游：[Anthropic skills](https://github.com/anthropics/skills/tree/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/doc-coauthoring)、[arXiv MCP](https://github.com/blazickjp/arxiv-mcp-server)。
