# QQ × Live2D 双入口共存 —— WP1 现成组合兼容试验与路线裁定

日期：2026-10-06（UTC+8）。状态：**WP1 已执行；路线已裁定；WP2 起尚未开始；生产尚未切换**。

计划：[`QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md`](QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md) ·
基线：[`QQ-Live2D-Coexistence-WP0-Baseline.md`](QQ-Live2D-Coexistence-WP0-Baseline.md) ·
设计：[`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md)。

证据（全部在 gitignore 的 `artifacts/post-lv2/local/coexistence-wp1/`）：
`trial-results.json`（逐项读数 + 全部报文）· `astrbot-container.log`（容器日志）·
`compose.yml` / `install-adapter.mjs` / `configure-platforms.mjs` / `trial.mjs`（可复跑）·
上游固定版本源码在**仓库之外**：`C:\Users\user\postlv2-deps\coexistence-wp1\{adapter,desktop}`。

---

## 1. 裁定（结论先行）

**不采用整套替换路线（AstrBot + `astrbot_plugin_live2d_adapter` + `astrbot-live2d-desktop`）；
采用备用路线：本机现有 NapCat + Open-LLM-VTuber，共用 LG 核心。**

判据逐字来自计划 §2：

> WP1 若发现必须重写前端音频调度、建立第二份人格/记忆权威，或无法保留当前已用语音行为，
> 就不采用整套替换路线，转用**本机现有 NapCat + Open-LLM-VTuber，共用 LG 核心**。

三条**全部命中**，且都有运行或源码证据（§3、§4）。**这不等于候选组合"不好"** ——
它在自己的目标上是完整可用的（§5 逐条列出实测通过项），只是它回答的问题与 LG 需要的问题不是同一个。

---

## 2. 试验环境（隔离、可复跑、不碰任何现有部署）

| 项 | 值 |
|---|---|
| 部署 | 独立 Compose 项目 `lg-coexist-wp1`，独立数据目录 `artifacts/post-lv2/local/coexistence-wp1/astrbot-data/` |
| 镜像 | `soulter/astrbot@sha256:cf271483d2f03d2220b2c1ec5574747f4ebbdba27396421ef2e785474255856e`（**本机已有**，`pull_policy: never`） |
| 端口 | WebUI `127.0.0.1:16185` · OneBot `127.0.0.1:16199` · Live2D WS `127.0.0.1:19090`（全部 loopback；**未占用** 6185/6099/6199/6701/6101） |
| 上游版本 | 适配器 `08a35c3c0ec42f05eccd96eb1ec25955d1e05386`（metadata 自报 **1.3.1**）· 桌面端源码 `de15e1e9793da0afd7fcb21152913531de974b31`（README 标 v1.5.0，release 是 v1.6.0 —— 与计划 §3 记的同一处不一致） |
| 受控回复源 | 本仓库自写的 `wp1_echo` 插件（**不调用任何模型**），只为把"谁回答"这个变量固定下来 |
| 模拟客户端 | `trial.mjs`（Node 22 + 仓库内已有的 `ws`）：一个模拟 Live2D 桌面端 + 一个模拟 OneBot 实现 |
| 未做 | **Electron 桌面端未下载、未运行**（Cubism Core 未取）；真实 QQ 账号**未连接**；LG 生产库**未打开** |

**本轮发现（版本基线本身不一致）**：容器日志逐字打出 `AstrBot v4.28.0`，而
`astrbot-stack/README.md` 把该部署记为 **4.27.5**、`compose.yml` 固定的是上面那个 digest。
⇒ 计划 §3 的"本机部署中固定的镜像 digest，README 记录为 4.27.5"在**本机事实上**已经不成立：
**被固定的 digest 就是 4.28.0**。候选路线的"固定版本"这件事需要先修，才谈得上复现。

---

## 3. 兼容矩阵（每项标明通过/失败/不适用/未运行）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 隔离部署能起来（不干扰现有部署） | **通过** | `astrbot-container.log`：`AstrBot v4.28.0` + WebUI 就绪；三个端口全部 loopback |
| 2 | 插件按固定 commit 装载 | **通过** | 日志：`Plugin astrbot_plugin_live2d_adapter (1.3.1) by lxfight` |
| 3 | 平台适配器注册并启动 WS 服务 | **通过** | 日志：`平台适配器启动成功` · `WebSocket: ws://0.0.0.0:9090/astrbot/live2d` |
| 4 | 握手鉴权强制 + 负控有效 | **通过** | 错 token ⇒ `sys.error code=4001`（`trial-results.json` L2D-1） |
| 5 | 正控握手：会话 / 能力 / 配置回传 | **通过** | `session={"sessionId":"wp1-desktop-A","userId":"wp1-desktop-A"}` · `features=["message_chain","tts_url","multi_modal","voice_input"]` · `config.ttsProvider=astrbot-tts` / `config.sttProvider=astrbot-stt` |
| 6 | 皮套输入 → AstrBot 消息事件 | **通过** | 日志：`[wp1_echo] 收到来自 live2d 的消息：A-MARK` |
| 7 | 受控回复 → `perform.show` 回到皮套 | **通过** | 原始载荷：`{"op":"perform.show","payload":{"interrupt":true,"sequence":[{"type":"text","content":"WP1_ECHO[live2d]:A-MARK",...}]}}` |
| 8 | OneBot 私聊事件 → AstrBot 消息事件 | **通过** | 日志：`[wp1_echo] 收到来自 aiocqhttp 的消息：B-MARK` |
| 9 | 受控回复 → `send_private_msg` 回到 QQ | **通过** | `action=send_private_msg params={"user_id":10001,...}` |
| 10 | **定向投递交叉核对（零串台）** | **通过** | 皮套连接看到 `B-MARK`=false · OneBot 连接看到 `A-MARK`=false（X-5） |
| 11 | 两平台共存于同一 AstrBot 实例 | **通过** | 日志：`live2d(live2d_wp1)` 与 `aiocqhttp(onebot_wp1)` 同时加载 |
| 12 | 单连接约束的实际行为（`max_connections=1`/`kick_old=true`） | **观察到** | 第二个皮套客户端接入**成功**，且**第一个被踢**（日志：`客户端已断开: wp1-desktop-A`）⇒ 不是"拒绝第二个"，而是"顶掉第一个" |
| 13 | `perform.show` 的载荷形状（能否承载 LG 的逐句交付） | **失败（对 LG 而言）** | 载荷只有 `{interrupt, sequence[]}`；**没有** `requestId` / `replyId` / `segmentId`（P-7 逐字核对） |
| 14 | 播放真相的粒度 | **失败（对 LG 而言）** | 协议里客户端只上报 `state.playing {isPlaying: bool}` —— **一个布尔**；LG 的交付账是**逐段五态**（`queued/playing/synthesized/cancelled/unknown`） |
| 15 | 服务端发起的取消 | **失败（对 LG 而言）** | `create_perform_interrupt` 在适配器里**定义了但全仓无调用者**（`grep` 逐条：只有定义与协议常量）；"打断"只表现为下一条 `perform.show` 的 `interrupt: true` |
| 16 | 语音（TTS）由谁产生 | **失败（对 LG 而言）** | 握手 config 逐字 `ttsProvider: astrbot-tts`、`ttsMode: "remote"` ⇒ 音频来自 **AstrBot 的 TTS**，不是当前 CosyVoice3 链 |
| 17 | 语音输入（ASR）由谁产生 | **失败（对 LG 而言）** | 协议有 `stt.transcribe`/`stt.result`，config `sttProvider: astrbot-stt` ⇒ **AstrBot 的 STT** |
| 18 | 回答权威（谁生成那句话） | **失败（对 LG 而言）** | 两路都是 AstrBot 的平台，回复由 AstrBot 的 Agent 产生；本试验正是用自写插件**替换**了它，才拿到确定回复 |
| 19 | 独立表演规划 LLM | **观察到（本次 disabled）** | 日志：`[Live2DPlanner] 规划状态: enabled=False, source=插件配置未选择 Provider`；它是**可配置开启**的第二个模型调用点 |
| 20 | Electron 桌面端：模型导入 / 渲染 / 字幕 / 音频 / 表情 | **未运行** | 未下载安装包、未取 Cubism Core |
| 21 | 桌面端麦克风 / 录音链路 / 全局快捷键 | **未运行** | 同上 |
| 22 | 与 LG 的 `CANCEL_TURN`（协作式取消三态读数）对照 | **不适用** | 候选协议没有对应物（见 #15） |
| 23 | 与 LG 的合成账 / 播放账（`REPORT_SYNTHESIZED` / `REPORT_PLAYBACK`）对照 | **不适用** | 候选协议没有对应物（见 #14） |
| 24 | 与 LG 的已检查语句流（`SPEECH_SEGMENT` 逐段）对照 | **不适用** | 候选协议按**整批**下发（见 #13） |

---

## 4. 为什么裁定"不采用"（逐条对应计划 §2 的失败条件）

### 4.1 "必须重写前端音频调度" —— 命中

候选协议是**批次表演**模型：一次 `perform.show` 携带**整个** `sequence`，只有一个
`interrupt` 布尔（`adapter/core/protocol.py:211-226`）。
LG 现有皮套契约是**逐句**模型：`SPEECH_SEGMENT`（逐段已检查语句）·
`REPORT_SYNTHESIZED` / `REPORT_PLAYBACK`（按 `<replyId>#<index>` + `segmentId` 的五态交付账）·
`CANCEL_TURN {requestId}`（协作式取消，读数分 `stoppedBeforeModel` / `alreadyCommitted`）
（`src/kernel/app/bridge/turn-bridge.ts:1046-1122`）。

⇒ 采用候选路线 = 把上面那套语义**换掉**，不是"接上去"。

### 4.2 "无法保留当前已用语音行为" —— 命中

候选路线的 TTS/STT 是 AstrBot 的（握手 config 实测 `astrbot-tts` / `astrbot-stt`），
而当前皮套用的是 CosyVoice3 + Qwen3-ASR + 逐句表情载荷 + 合成账 + 播放账
（`docs/post-lv2/Post-Lv2-Expressive-Speech-Integration-2026-10-04.md`）。
要"保留"就得**另写一个 AstrBot TTS/STT provider 插件**去调 LG 的语音栈 ——
那已经不是"复用现成组合"，而是"在别人的框架里重写我们已有的东西"。

### 4.3 "建立第二份人格/记忆权威" —— 部分命中（可规避，但代价是继续做插件）

两路都是 AstrBot 的平台，默认回答者是 AstrBot 的 Agent。要换成 LG，必须把 LG 做成
AstrBot 插件并在**默认 Agent 之前**截住每一条消息（本试验的 `wp1_echo` 就是这条路的最小形态，
且实测可行）。可规避，但代价是：LG 的入口变成"AstrBot 的一个插件"，
AstrBot 的会话/人格/历史/工具体系成为必须绕开的第二套权威。
另外适配器自带**独立表演规划 LLM**（本次 disabled，但可开启）⇒ 多一个可选的第二模型调用点。

### 4.4 另外两条**计划之外**但影响决策的事实

- **版本基线不一致**（§2）：被固定的 digest 实际是 4.28.0，文档记 4.27.5。
- **替换一个正在工作的入口**（WP0 §2.1/§3.1）：AstrBot 停机两周，QQ 入口**正在服务**；
  AstrBot 路线不是"接着用现成的"，而是"换掉正在跑的那个"。

---

## 5. 候选组合**确实成立**的部分（不许因为不采用就抹掉）

1. **分平台会话 + 定向投递实测成立**：交叉核对零串台（#10），这正是计划 §1 想要的能力。
2. **握手鉴权强制且负控有效**（#4）。
3. **桌面端本身不含 Agent**：上游 README 逐字"本项目本身并不带有任何 Agent 功能"，
   渲染与协议职责分离得干净 —— 这是它可以被借鉴的地方。
4. **资源服务与模型能力上报**：大资源走 `/resources`（单端口复用）、
   `state.model` 支持表情目录/语义预设/combo（`adapter/core/protocol.py:284-402`）。
5. **多平台同实例**（#11）。

⇒ 这些结论进"可借鉴清单"，进 WP3 的设计参考；**不**进采用范围。

---

## 6. 采用路线（WP2 起的工作对象）

```text
本人 QQ → 独立 NapCat（lg-qq-private，已在跑）
        → scripts/qq/chat.ts（白名单/账号校验/去重/串行）
        → LG stdio bridge（src/infrastructure/qq/lg-stdio-client.ts）
             ┐
             ├─ 一个常驻 LG 核心：唯一库持有者 + 唯一公共生命周期 + 一套后台消费者
             │
皮套（Open-LLM-VTuber，现有外壳 + CosyVoice3 + Qwen3-ASR）
        → scripts/postlv2_vtuber_runtime.py → LGBridgeClient
        → 同一个 LG 核心的**另一个受信会话**（语音交付账只属于它）
```

WP2/WP3 的改动对象就是这张图的**中间那一块**：
把今天"每个入口一个进程、各自一套消费者"改成"一个核心、多个受信会话"。
它**不需要**替换 QQ 入口、**不需要**替换语音栈、**不需要**动 AstrBot。

---

## 7. 本轮未做（诚实边界）

- 桌面端（Electron / Cubism / 音频 / 麦克风 / 表情渲染）**未运行**，相关项一律 `未运行`。
- 真实 QQ 账号**未连接**；模拟 OneBot 只发合成事件。
- LG 生产库**未打开**（本轮只跑 AstrBot 隔离部署；采集器只做文件树摘要）。
- 未改动 `.env` / `.env.qq` / `astrbot-stack/**` / `scripts/qq/**`。
- 未验证"长时间运行 / 断线重连 / 大文件资源传输 / 多客户端并发"。
- 未对候选组合做**性能**读数（计划 §5 的性能清单属于 WP4）。
