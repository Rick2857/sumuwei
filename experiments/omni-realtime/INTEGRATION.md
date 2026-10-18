# 原生语音与 LG 隔离联调（2026-10-14）

> 2026-10-14 更新：3D 与 Omni 已合并并生产激活。当前事实见 `docs/post-lv2/Avatar-3D-Omni-Production-Activation-2026-10-14.md`；下文保留独立原型/隔离验证的历史范围。

实现与隔离短链已完成；生产未激活、3D 未接线。必须另列本轮
[生产卷误挂载事故](INCIDENT-20261014.md)，不能用语音测试 PASS 覆盖它。

## 装配与已接受的例外

lg-core-entry.ts 安装仅对 avatar 有效的主回复端口，再导入原有 main.ts --bridge。
ChatSession.send 仍执行 beginTurn → 既有记忆/工具网关 → ContextCompiler → 主回复 →
既有回复检查 → completeTurn。内部工具决策模型未被全局替换，QQ/CLI 默认路径不变。
没有新增万能桥消息、云端 MCP 或工具权限；原生 API tools 为空、搜索关闭。

用户已明确选择 Omni 负责语音理解与回复，LG 负责上下文、状态和工具；也接受
“先说出错误承诺，检查结果后停播并更正”。因此本实验允许检查前原生音频播出，
不冒称仍符合旧 TTS 的“每句检查后才合成”性质。发现改写时发 correction 停播通知，
再按已检查文本生成一次更正；更正再次违规则失败停止。
生成事件保留原文和实际更正，不把已说出的错误从记录中抹去。检查覆盖范围仍有既有边界。

LG 模式关闭云端自动出回复，客户端以 600 ms 静音提交；识别文本进入正式轮次，原音频保留在本通 Omni 上下文。
必须获得与本轮 instructions 一致的 session.updated 回显后，才创建本轮输入文本并生成。
抢话先在本地停止节点，再取消 LG 并重建上游；160 ms 前置缓冲减少吞掉句首的风险。
原生播放队列上限 30 秒，防止模型生成速度快于播放时截断普通十秒回复；取消仍立即废弃全部节点。

## 本轮读数

| 项目 | 证据 |
| --- | --- |
| 类型 | 根项目 typecheck 与实验 tsconfig 通过 |
| 完整离线回归 | pnpm m4.5:ci 退出码 0；G14 not-run 不被改称真实模型通过 |
| 既有传输 | postlv2:transport:verify 78 项通过；text-stream 门通过 |
| 新离线专项 | Node 内置测试 10/10；端口隔离、锁/池关闭顺序和实际卷守卫另有 TS 正负控 |
| 真模型/真 PG | 写 1 条记忆，上游重连后召回 trace 有 memory-recall 且 selectedMemoryCount=1 |
| 计算 | LG 网关落 5 条动作事件；原生语音回复 17×24=408 |
| 音频输入 | 合成 WAV → 16 kHz PCM → 百炼转写 → 正式 LG 轮次 → Liora Mira 回复 |
| 真生成取消 | LG ACK 5 ms，上游重建 191 ms；换代后旧音频 0，下一轮正常，核心退出 0 |
| 真实检查驱动更正 | 注入“我记住了”错误回复/提示音；LG 实际 content_unresolved、0 记忆，真实检查触发一次更正 |

取消是单次接收端读数，不是物理停播时延或 p95。更正测例使用注入模型/提示音，
不能宣称已验证真人听到真实模型错误后的纠正。结果及转录保存在忽略的 live-runs，摘要见 integration-validation.json。

发现并修复：上下文更新后立即生成可能采用旧配置；PG 资格连接在关池之后释放会卡住。
现在等回显再生成，ChatSession 复用同一收尾句柄，runtime.stop 关闭池前返回资格连接。
之前的类型缺件、无验证快照拒收、无离线 key 导致旧只读 CLI 门失败、卡住的子进程退出 1、
以及召回断言失败均保留原记录。关闭语义召回时部分自然问法只用近期对话，不能凭回答正确推断长期召回成功。

## 来源与隔离

原主目录 HEAD 为 faa08659，PG 换代等代码仍在未提交树中。按白名单同步 src/scripts/evals 与依赖配置，
形成本分支独立基线 573ba965；未复制生产 .env/data/artifacts 或 3D 改动。
完整旧回归用已验证 PGlite 快照的副本和指向 loopback:9 的离线占位 key，不调用生产模型。

语音联调现独占 lg-omni-isolated-pg / lg-omni-isolated-data / 55434。
setup、核心启动和读回均核对实际 Docker 挂载，不仅核对数据库名或 Compose 项目名。
凭证不入 Git，浏览器不能选择端点、工具或数据库；核心回调需随机本机 token，prompt 不转发到页面。

仍开放：真人麦克风/回声、实际发音与中英文质量、长时对话/p95、逐句交付账、
取消中已发语音的完整生成记录、异步轮后记忆写入失败触发的新纠正、生产人格状态全量装配、Omni + 3D、合并与生产激活。
同页 omni-audio / omni-playback 接口保留，但未修改 3D 工作区。

验证命令：npm test、npm run smoke:lg、npm run smoke:cancel；从根目录执行
node experiments/omni-realtime/lg-smoke.mjs --audio 可加入已保存的合成 WAV 输入；
--fake --fault 使用错误注入回复，但 LG 检查与 PostgreSQL 都是真实路径。

官方契约：[实时指南](https://www.alibabacloud.com/help/en/model-studio/realtime)、
[客户端事件](https://www.alibabacloud.com/help/en/model-studio/client-events)。
