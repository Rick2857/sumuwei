# Omni 独立语音原型

> 2026-10-14 更新：3D 与 Omni 已合并并生产激活。当前事实见 `docs/post-lv2/Avatar-3D-Omni-Production-Activation-2026-10-14.md`；下文保留独立原型/隔离验证的历史范围。

默认独立模式：单用户、独立页面、无数据库和工具。新增 `npm run lg`，接正式 LG 轮次与独立 PostgreSQL。
当前运行基线为私有分支 `codex/omni-realtime` 的 `573ba965` 工作树快照；来源清单见 baseline-runtime.json。
完整联调结果与限制见 [INTEGRATION.md](INTEGRATION.md)。生产未激活，3D 未接线。

**先读 [2026-10-14 数据库误挂载事故](INCIDENT-20261014.md)**：原生产卷发生双实例访问与检查点故障。
原卷已保留，恢复候选已在健康副本验证，尚未执行生产恢复。

## 已配置的 LG 隔离入口

从语音 worktree 根目录先检查实际卷，再启动已存在的独立测试容器：

```powershell
node node_modules/tsx/dist/cli.mjs experiments/omni-realtime/isolated-pg.ts --before-start
docker start lg-omni-isolated-pg
npm --prefix experiments/omni-realtime run lg
```

本机 `.env.local` 与 `.lg-core.local.env` 已配置且忽略提交。LG 模式仅接受实际卷
`lg-omni-isolated-data`、`127.0.0.1:55434`、测试库 `lg_test_omni_*`；错误挂载会拒绝运行。
Ctrl+C 关闭专属核心与代理；结束后 `docker stop lg-omni-isolated-pg`，不删卷。
首次另建环境使用自包含 compose.isolated.yml，先 create、核对实际 Mounts 后再 start。
从根目录执行 `node node_modules/tsx/dist/cli.mjs experiments/omni-realtime/setup-lg.ts "<pg-trial.env>" "<.env.test>"` 创建独立空库。
它不复制生产历史/关系/情绪状态。旧卷及恢复候选均不可拿来做语音测试。

## 启动与停止

需要 Node 22.13+。在本目录执行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

打开 <http://127.0.0.1:12410>，点击「连接测试」。终端按 Ctrl+C 停止。
依赖已安装的本机 worktree 只需 `npm start`。绑定地址仅为 127.0.0.1。
只有此目录中的独立依赖和锁文件会被使用；不加载主项目 `.env`。

1. 「长回复与迟到音频」开始提示音，点击「立即打断」。事件里应出现
   `playback_cancelled`、`local_stop`、`stale_packet_dropped`，旧音频不能恢复。
2. 「模拟写入失败后纠正」先显示错误承诺，随后停掉旧提示音并显示纠正，
   再故意发送一次旧音频。它应被丢弃。这不是一次真实记忆写入或真实错误检测。
3. 「中英文混合」和文本框检查 Unicode、字幕与音频传输。
   **离线音频始终是正弦提示音，不是中英文语音。**
4. 「开启麦克风」后，浏览器才申请权限。采集、16 kHz PCM 重采样和电平显示
   可离线使用；模拟端只检测能量与停顿，不转写说话内容。关闭麦克风会清除未提交输入。
5. 「导出本地诊断」下载事件与计时记录，不包含音频或字幕正文。文件请保存在本地。

建议戴耳机。当前本地 VAD 为连续 120 ms、RMS > 0.025 的能量判据；
这只是可测试的打断触发器，未宣称具备真人判别、扬声器回声鲁棒性或语义打断质量。

## 离线验收

```powershell
npm test
```

使用 Node 内置测试框架，不需要浏览器、凭证、模型、数据库或外部皮套目录。
测试既有状态与 Web Audio 队列，也使用真实本地 HTTP/WebSocket 传输；
覆盖取消后迟到包、响应 ID 返回前取消、跨会话旧回调、模拟主动纠正、
48/44.1 kHz 连续重采样、输入边界、跨站连接拒绝和单页面会话限制。

离线验收记录见 [VALIDATION.md](VALIDATION.md)，真实短链见 [LIVE-VALIDATION.md](LIVE-VALIDATION.md)。
真人麦克风、发音正确性、实际听到声音的时延仍需验证；LG 隔离联调读数见 INTEGRATION.md。

## 真实模型测试入口

原生 WebSocket 代理已通过一条真实文本到音频短链，见 [LIVE-VALIDATION.md](LIVE-VALIDATION.md)。
这不代表麦克风、真人打断、发音质量或 LG 接线已验收。
它只在显式 `--live` 时加载本目录 `.env.local`，缺凭证即拒绝启动，
不会复用 `OPENAI_API_KEY`，不会回落其他模型。

```powershell
Copy-Item .env.local.example .env.local
# 手动填写百炼凭证、业务空间 ID 与对应地域；不要提交密钥。
npm run live
```

本机独立 `.env.local` 已从用户提供的凭证文件配置；不要覆盖为模板。
后续只需 `npm run live`。可重复的固定测试句短链：`npm run smoke:live`，
每次会实际调用模型，音频和结果写入被 Git 忽略的 `live-runs/<时间>/`，测试后自动关闭连接。

固定模型：`qwen3.8-omni-flash-realtime`。默认地域北京，默认音色 `Liora Mira`（清欢）。
服务端发送 16 kHz / 单声道 / s16le PCM，接收 24 kHz PCM；
使用 semantic_vad，关闭搜索，工具列表为空。点击麦克风后才上传采集音频。
输入转写是字幕参考，不等同于 Omni 对音频的理解，也不会写入任何记忆。

官方依据（2026-10-13 核对）：

- [实时调用指南](https://help.aliyun.com/zh/model-studio/realtime)
- [客户端事件](https://help.aliyun.com/zh/model-studio/client-events)
- [服务端事件](https://help.aliyun.com/zh/model-studio/server-events)

## 与 3D 对接的已有输出

页面通过本地 `CustomEvent` 发出以下事件，供同一页面未来的 3D 适配器消费。
这里没有接入 3D，也不新增生产桥协议。

| 事件 | 字段与用途 |
| --- | --- |
| `omni-audio` | `responseId`、`generation`、`chunkIndex`、`samples`（Float32Array）、`sampleRate=24000`、`scheduledAudioTime`、`endAudioTime`、`scheduledPerformanceTime` |
| `omni-playback` | `state=scheduled/ended/cancelled`、相同身份；scheduled 带音频时钟起点，cancelled 带原因与已播放区间估计 |

口型应按计划播放时间驱动，不能收到模型音频就立即动嘴。取消事件立即废弃该片段，
更旧 generation 不应覆盖新回复。`ended` 是浏览器音频节点事件，不证明用户听懂。
这些字段属于实验接口，正式接线时应与现有 LG 身份、交付账和 3D 接口统一。

## 独立模式的历史边界与后续顺序

下列条目描述最初独立原型；LG 隔离入口的当前装配、已完成项和残余以 INTEGRATION.md 为准。

- 当前是单页面会话，第二个连接拒绝；每通最多十分钟，长测试需重新连接。
- **取消发生在响应 ID 返回前时重建上游会话**，防止把迟到的新 ID 错当成下一轮。
  会丢失这通原型的临时云端上下文及尚未完成的输入；正式接 LG 时需按 LG 权威上下文恢复。
- 默认上下文仅为独立测试指令，未加载苏沐薇人格、关系、情绪、长期记忆或 QQ 状态。
- 程序纠正目前由模拟事件触发。真实版本须由 LG 的写入/动作结果提供可核对依据，
  并处理用户抢话优先和纠正的时效性；不能把预设演示当作已具备自动发现错误能力。
- 计时起点是浏览器收到 `speech_stopped` 或提交文本的时刻。
  首音频包、计划播放、物理可闻首音和服务端端点检测等待不是同一个指标。
- 不复制 PGlite，不读取 PostgreSQL 连接串，不启动 LG 核心，不改 `postlv2-deps`。
- 等换库线提供已提交的稳定基线和独立测试库入口，再接入 LG 上下文、工具与取消。
  之后分别做真实 Omni 测试及 Omni + 3D 联调。
