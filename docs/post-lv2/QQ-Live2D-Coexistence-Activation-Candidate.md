# QQ × Live2D 双入口共存 —— 激活候选（WP5）

日期：2026-10-06（UTC+8）。状态：**候选已备，尚未激活**。生产仍是旧形态（每个入口一个库持有者）。

计划：[`QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md`](QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md) ·
[`WP0`](QQ-Live2D-Coexistence-WP0-Baseline.md) · [`WP1`](QQ-Live2D-Coexistence-WP1-Compatibility-Trial.md) ·
[`WP2`](QQ-Live2D-Coexistence-WP2-Dual-Entry.md) · [`WP3`](QQ-Live2D-Coexistence-WP3-Media-Control.md) ·
[`WP4`](QQ-Live2D-Coexistence-WP4-Scenario-Matrix.md) · [`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md)。

> 本文件是计划 §6 WP5 第 1 步的交付：**汇总成一份可审查的激活候选**。
> 第 2–5 步（停旧入口 / 开库 / 起双入口 / 自然聊天）**都需要当轮逐字授权**，本文件不代做。

---

## 1. 采用路线与版本清单

| 项 | 值 |
|---|---|
| **路线** | **备用路线**：本机现有 NapCat + Open-LLM-VTuber，**共用 LG 核心**（`ADR-109` `D10` 追加节） |
| 不采用的路线 | AstrBot + `astrbot_plugin_live2d_adapter` + `astrbot-live2d-desktop`（WP1 裁定；计划 §2 三条失败条件全命中） |
| LG 核心 | 本仓库 `src/main.ts`（`--coexist` 模式；唯一库持有者） |
| QQ 侧 | 独立 NapCat 容器 `lg-qq-private-napcat-1`（镜像 `1336a777f9a4`）+ `scripts/qq/chat.ts`（**连接档**） |
| 皮套侧 | `scripts/postlv2-avatar-production.cmd` → `postlv2_vtuber_runtime.py`（**连接档**）+ CosyVoice3 声线 + Open-LLM-VTuber 外壳 |
| 数据库 | `data/pglite`（**不迁移**；本候选不新增任何迁移） |
| 模型端点 | 生产 `.env` 的 `api.deepseek.com` / `deepseek-flash`（**不变**） |

## 2. 源码指纹（本候选 = 冻结对象）

`artifacts/post-lv2/local/coexist-runtime/activation-fingerprint.json`（`node scripts/coexist/fingerprint.mjs` 可复算）。

```text
HEAD = 2d64997290dff77142705d5bcae76130a00c36fd（2026-10-06T12:23:47+08:00）
真实库 = 1250 文件 · 树摘要 268af1eb8d8fb81db4e1b0ec7616df4e677fc190142f6a121220ad6288e40e25
```

改动文件（sha256 前 16 位）：

| 文件 | 指纹 | 作用 |
|---|---|---|
| `src/main.ts` | `43af800638a6b80a…` | `--coexist` 装配 + 核心/会话拆分 + 停机顺序 |
| `src/kernel/app/flags.ts` | `d6734c701a8990f3…` | `CHARACTER_ENTRY_SCOPED_CONVERSATIONS`（**缺省 false**） |
| `src/kernel/app/bridge/turn-scheduler.ts` | `3cf78ef789d6046d…` | 有界轮转公平调度 + `whenIdle` |
| `src/infrastructure/runtime/entry-scope.ts` | `9d3e3f570e0d5656…` | 入口维度的会话 id（纯函数） |
| `src/infrastructure/runtime/adapters.ts` | `da470ac6ce4fe413…` | `recentContextLinesFrom` 的入口作用域 |
| `src/infrastructure/qq/lg-stdio-client.ts` | `1a66dca4ee343e1d…` | QQ 外壳的**连接档** |
| `scripts/qq/chat.ts` | `9c8363156d30e2c6…` | QQ 正式入口的连接档开关 |
| `scripts/postlv2_vtuber_runtime.py` | `b0b47ec16b7ed660…` | 皮套外壳的**连接档** + `--bridge-only` |
| `package.json` | `ac1f619a8e604a1b…` | 八个新脚本（4 道门 + 4 个运行时命令） |

（完整清单见指纹文件；门脚本与夹具的指纹也在里面。）

## 3. 配置改动清单（**激活时要改的就是这些**）

```diff
  .env
+ CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true      # ★ 入口维度的会话；代码缺省 false
```

**只有这一行**。令牌与端口不进 `.env`：

```text
artifacts/post-lv2/local/coexist-runtime/entry-tokens.json   （gitignore；由 `pnpm coexist:prepare` 生成）
  qqPort=6751 · avatarPort=6752 · 两个 48 位十六进制令牌
```

两条外壳各自拿到**自己那条入口**的端口与令牌：

| 外壳 | 环境变量 | 值来源 |
|---|---|---|
| QQ（`scripts/qq/chat.ts`） | `QQ_COEXIST_CONNECT_PORT` / `QQ_COEXIST_CONNECT_TOKEN` | 令牌文件的 `qqPort` / `qq` |
| 皮套（`postlv2-avatar-production.cmd`） | `--connect-host/--connect-port/--connect-token` | 令牌文件的 `avatarPort` / `avatar` |

## 4. 通过 / 失败 / 未运行（**分列**）

| 面 | 结论 | 载体 |
|---|---|---|
| 现成方案兼容（AstrBot 路线） | **不采用**（24 项矩阵：13 通过 / 3 对 LG 失败 / 8 未运行或不适用） | WP1 |
| 共享核心 | **PASS**（公共生命周期只跑一次；一个库持有者） | `postlv2:coexist:verify` `E-0b`/`R-9` |
| 文字隔离（近期窗口 / 回复 / 取消） | **PASS**（每轮 trace 引用的对话事件外来 **0** 条） | `verify` `R-5` · `matrix` `S1/S2a/S5a` |
| 语义记忆 | **PASS**（写侧一次 + 真实模型档**读侧**召回命中） | `live` `L-5`/`L-6` |
| 媒体交付 | **协议面 PASS**（合成账 / 播放账被受理；三态取消读数） | `postlv2:coexist:shells` `W-4`/`W-5` |
| 异常恢复 | **PASS**（坏 JSON / 模型失败 / 断开 / 重启） | `matrix` `S6`/`S10`/`S11` |
| 工程回归 | **PASS**（`m4.5:ci` **EXIT 0**） | `artifacts/post-lv2/local/coexistence-wp4/m4.5-ci.log` |
| **真人体验** | **NOT RUN** | 需真实皮套外壳 + 音频设备 + 真人 |
| **生产激活** | **NOT STARTED**（本候选） | —— |
| **自然首用** | **NOT RUN** | —— |

## 5. 待解决限制（激活**不会**关闭它们）

`L-COEXIST-01…10`（见 WP2/WP3/WP4 各册）。与本候选关系最大的四条：

- `L-COEXIST-01` 皮套仍用 `interactive_human_console` 归因入口（账本上 CLI 与皮套不可区分）；
- `L-COEXIST-04` 旧镜像 `messages` / `roomId` 仍是房间级（**有序调度下**不会撞号）；
- `L-COEXIST-09` 队列上限在每连接串行泵下**结构上不可达**（防御性上限）；
- `L-COEXIST-10` 夹具档里偏好类记忆未落地（既有记忆规则的读数）。

另：`W-10`（ASR/TTS/音频/表情渲染）与 `S12`（真人体验）在激活前仍是 NOT RUN。

## 6. 切换后**立刻会变的东西**（必须在授权时看到）

```text
① QQ 与皮套的**近期对话各自从零开始**
   今天三条入口共用 `dm-<slug>-<userHash>`；打开开关后
     QQ   → `dm-<slug>-<userHash>-qq`
     皮套 → `dm-<slug>-<userHash>-avatar`
     CLI  → 逐字不变（仍是 `dm-<slug>-<userHash>`）
   ⇒ **旧混合历史保留**（账本里一条不删，`--history` 仍看得到），但**不复制**到两条新会话；
     因此切换那一刻，她在 QQ 与皮套里都"想不起刚才聊过什么"（长期记忆、关系、情绪、信念仍在）。
② 生产 QQ 入口会从"自己持有一个库"变成"连到共享核心"
   ⇒ 旧入口必须**先停**（真实库跨进程单持有；本候选不替人杀进程）。
③ 每个入口多一个本机 loopback 监听（6751 / 6752，带令牌）。
```

## 7. 启动方案

```bash
pnpm coexist:prepare     # 一次：生成入口令牌（gitignore）
pnpm coexist:check       # 只读就绪判据（入口开关 / QQ 配置 / 端口 / 旧入口是否在跑）
```

就绪后（**需要授权**）：

```powershell
# 1) 到正在跑旧 QQ 入口的那个窗口按 Ctrl+C，等它排空退出（租约释放）
# 2) 在 .env 追加一行：CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true
# 3) 逐字授权启动（布尔开关不算授权）：
$env:PROJECT_LG_COEXIST_ACTIVATE='coexist@C:\Users\user\Desktop\project LG\data\pglite'
pnpm coexist:start
```

`pnpm coexist:start` 做四件事（顺序即计划 §6 的顺序）：
① 校验就绪判据 → ② 拒绝在**旧入口仍在跑**时启动 → ③ 起常驻核心（唯一库持有者）并等 `COEXIST_READY`
→ ④ 起两条外壳（QQ 连接档 + 皮套连接档）。

**负控（已实测）**：不给 `PROJECT_LG_COEXIST_ACTIVATE` ⇒ **退出码 2**，并打印需要的授权串。

## 8. 停机与回滚

**有序停机**（任一种）：

```bash
pnpm coexist:stop        # 写停机哨兵 ⇒ 编排者"停两条外壳 → 关核心 stdin → 排空 → 关库 → 释放租约"
# 或在编排窗口按 Ctrl+C（同一条有序停机路径）
```

⚠️ **不要 `taskkill`**：那会跳过"排空在飞消费者"，不是有序停机（`INC-01` 的纪律）。

**回滚**（计划 §6 末段）：

```text
① 有序停掉共存核心（上面那条）
② 确认租约已释放、库已 clean close（编排窗口会打退出码；`pnpm inc-01:gates` 可读回）
③ 起回已验证的旧 QQ 入口：`pnpm qq:start`（皮套仍用 `pnpm postlv2:avatar:production`，它自己持库）
④ **不恢复数据库快照、不抹除切换后的真实记忆**；新会话历史保留
⑤ 切回旧入口时，近期上下文按**旧会话**（`dm-<slug>-<userHash>`）读取 —— 那是 CLI 与旧 QQ 共用的那条
```

⚠️ 回滚**不**等于"什么都没发生"：切换期间写入的 QQ/皮套会话（`-qq` / `-avatar`）会留在账本里，
只是旧入口不再读它们。这一点必须如实告知。

## 9. 本候选**不主张**什么

- 不主张"两个模型请求可以完全同时运行、零等待"（计划 §1 逐字否掉；实测双入口平均等待 336–348ms）。
- 不主张真实音频面（ASR/TTS/播放/表情）已验（`W-10` NOT RUN）。
- 不主张真人体验（`S12` NOT RUN）。
- 不主张语义（嵌入）召回（`L-9` NOT RUN；本候选不改 `CHARACTER_MEMORY_SEMANTIC_MODE`）。
- 不主张"她不会再说错"（沿用 `DR-11` 的既有立场）。
