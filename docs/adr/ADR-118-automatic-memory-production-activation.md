# ADR-118 — 普通对话自动记忆生产激活

日期：2026-10-07。状态：ACCEPTED / EXECUTED。用户授权原话：**“好的进行生产激活”**。

这是 ADR-117 的激活状态修订，D01–D06 与代码默认关闭的设计保持有效。ADR-117、筛选报告和 `acceptance.json` 中的生产未激活是上一轮交付的历史读数，不回写。

## 已执行

部署独立运行环境到 `data/runtime/automatic-memory/langmem-48e3c11/`：固定提交 `48e3c11f5bb527282c7d5339c6a87a0b35abccfc`，LangMem 0.0.30，Python 3.12.13，使用该提交的 `uv.lock` 执行 `uv sync --frozen --no-dev`。50 个安装包的版本逐项等于验收环境。没有新增 Node 依赖、全局 Python 包或数据库迁移。

生产 `.env` 只追加以下配置及说明注释，其余原有字节保持不变：

```dotenv
CHARACTER_MEMORY_AUTOMATIC_ENABLED=true
CHARACTER_MEMORY_AUTOMATIC_PYTHON="C:/Users/user/Desktop/project LG/data/runtime/automatic-memory/langmem-48e3c11/.venv/Scripts/python.exe"
```

既有记忆总开关读取为 true。沿用 `api.deepseek.com / deepseek-flash`；生产密钥未改。测试继续遵守 AGENTS.md §8.1，只使用测试端点或本地 fixture。

核心先完成一次受控启动、有序关闭和快照副本读回，再通过既有 `scripts/coexist/start-background.ps1` 恢复常驻运行。每次真实打开都由 `src/main.ts` 走租约、pre-open verified snapshot 和 token；受控关闭确认 `cleanClose=true`。本轮快照写入独立的 `data/snapshots/automatic-memory-activation-20261007/`，没有清理旧快照。

## 验证与边界

- 新生产 Python 环境的隔离专项复验：**20/20 PASS**，包括真实 main bridge 的写入读回。此前测试模型短链 **13/13 PASS**、类型检查和完整离线 CI EXIT 0 的证据继续分列。
- 真实核心首次启用：消费者 `automatic-memory-langmem@1` 的水位 **765** 已持久化；自动任务 0、自动记忆 0。现有 **4 条记忆**逐行序列化摘要前后一致；账本最大序号仍为 765，schema 仍为 16。没有历史回判。
- 读回只打开已验证、已关闭快照的一次性副本；没有第二个进程打开生产库或快照本体。
- 常驻核心已就绪，6751 / 6752 同属唯一生产库持有进程；QQ 和 Live2D 外壳已接入，OneBot 入站已就绪，聊天页 HTTP 200。重启没有再次建立 cutover，未观察到自动消费者失败。
- **自然生产首次写入 = NOT OBSERVED**；生产模型工具调用兼容性、实际延迟/token 和语义索引维护真链仍待真实对话证据。没有向生产聊天注入合成验收句，也没有发送实际 QQ 测试消息。

第一次启动检查因检查脚本遗漏 `.env.qq` 中的 QQ 配置而 FAIL；核心正常关闭。检查脚本按既有 supervisor 的方式传入 QQ 配置后复验 PASS。失败档、正常关闭事实和后续成功档分别保留，没有修改生产代码来绕过问题。

## 撤回

将 `CHARACTER_MEMORY_AUTOMATIC_ENABLED` 改为 false，再通过 `pnpm coexist:stop` 正常停机并重启。现有任务、水位、事件和记忆保留。不要删除记忆、重置水位或回判历史来模拟撤回；不要强杀核心。

详细记录：[激活记录](../post-lv2/Automatic-Memory-Activation-Record-2026-10-07.md)。机器证据：`artifacts/research/automatic-memory-20261007/activation/`。
