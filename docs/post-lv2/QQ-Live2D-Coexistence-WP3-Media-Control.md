# QQ × Live2D 双入口共存 —— WP3 皮套媒体与控制（**协议面**）

日期：2026-10-06（UTC+8）。状态：**WP3 的协议面已实现并通过；真实 ASR/TTS/音频/桌面体验仍为 NOT RUN；WP4 起尚未开始；生产尚未切换**。

计划：[`QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md`](QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md) ·
[`WP0`](QQ-Live2D-Coexistence-WP0-Baseline.md) · [`WP1`](QQ-Live2D-Coexistence-WP1-Compatibility-Trial.md) ·
[`WP2`](QQ-Live2D-Coexistence-WP2-Dual-Entry.md) · [`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md)。

门：`pnpm postlv2:coexist:verify`（WP2 建立，本包**扩了 C 段**）。
证据：`artifacts/post-lv2/coexist-wp2-verify-<时间戳>/result.json`。

---

## 1. 本包验的是什么（计划 §1 的三条，落在**协议面**）

| 计划的说法 | 本包的机器判据 | 读数 |
|---|---|---|
| **打断皮套不取消 QQ** | `C-1`：QQ 先登记取消再提交同一 `requestId`；皮套同时提交另一条。断言 QQ 那一轮**在模型之前停住**（`bridge_turn_cancelled_before_model`），皮套那一轮**照常完成**且看不到 QQ 的标记 | `requested=true` · `code=bridge_turn_cancelled_before_model` · 皮套回复含 `MARK-B5`=true · 含 `MARK-A6`=false |
| **QQ 内容不自动在皮套播放** | `C-2`：皮套报 `REPORT_PLAYBACK`（未知段）⇒ 交付账**在**，答"账上没有这一段"；QQ 报同一件事 ⇒ 答"**这个入口没有交付账**" | 皮套=`playback_report_unknown_segment` · QQ=`playback_report_unsupported` |
| **关闭一个客户端不关闭 LG 核心或另一入口** | `C-3`：把皮套那条连接**直接销毁**，再让 QQ 发一条新请求 | QQ 新回复含 `MARK-A7`=true（核心与 QQ 都活着） |

三条都跑在**真 `src/main.ts --coexist`** + **全新隔离库** + 本机固定回复夹具上；
真实库树摘要前后逐字相同（`R-10`）。

**同一道门里 WP2 的读数仍然全绿**（33 项 PASS）：入口作用域（`S-1`/`S-2`）· 轮转公平与有界（`S-3`/`S-4`）·
公共生命周期只跑一次（`E-0b`）· 定向投递与近期窗口零混入（`E-5`…`E-8`、`R-5`）·
每会话序号连续（`R-2`）· 量具三段式（`M-1`…`M-3`）。

---

## 2. 实现落点（都在 `--coexist` 的装配里）

```text
src/main.ts  createCoexistenceEntryServer()
  ├─ 每入口自己的 TurnCancellationRegistry      ← C-1（取消按入口归属）
  ├─ 语音交付账只注入皮套（QQ 是纯文字入口）      ← C-2（播放账按入口归属）
  ├─ 一条连接结束只 socket.destroy()             ← C-3（断开不是停机）
  └─ 正式轮次过共享的 FairTurnScheduler（控制消息不排队）← C-1 的"取消在慢轮次期间仍可达"
```

**没有新增任何桥的消息种类**：`CANCEL_TURN` / `REPORT_PLAYBACK` 等仍是
`turn-bridge.ts` 那张受控登记表里的几种（`INV-PL2-09` 不变）。

---

## 3. 本包**没有做**什么（诚实边界）

1. **皮套外壳还没有改成"连到核心"**：今天 `scripts/postlv2_vtuber_runtime.py` 的
   `LGBridgeClient.start()` 仍然**自己 spawn 一个 `scripts/postlv2-bridge-production.ts` 子进程**
   （即 `src/main.ts --bridge`）—— 也就是说**生产里仍然是"每个入口一个库持有者"**。
   把外壳改成连 `--coexist` 的皮套监听端口，是 WP3 剩下的那一半（见 §4）。
2. **真实 ASR / TTS / 音频 / 表情 / 播放**：全部 **NOT RUN**。本包只覆盖协议面；
   计划 §4 WP3 的"复用当前 ASR/TTS、映射已检查语句、表情、合成与播放回报"里，
   **已检查语句与逐句表情载荷的真实链路**要等外壳接上之后才谈得上。
3. **真实桌面体验**（字幕 / 音频 / 表情 / 打断 / 麦克风 / 桌面操作不串台）：NOT RUN（WP4）。
4. **播放账的完整生命周期**（`synthesized → queued → playing → played`）本包只验了
   "账挂在皮套这一侧"；完整状态迁移已由既有的 `pnpm postlv2:transport:verify`（78 项）覆盖，
   本包**不重复**它。
5. **性能读数**（接收/排队/首字/首音/打断响应）：WP4。

---

## 4. WP3 剩下那一半（**2026-10-06 已实现并过门**）

```text
① `scripts/postlv2_vtuber_runtime.py` 的 `LGBridgeClient`
     start()  ：新增**连接档**（`--connect-host/--connect-port/--connect-token`）
                ⇒ TCP 连到 `--coexist` 的皮套监听 + 传输层握手 `LG_ENTRY <token>`
                ⇒ **不**再自己 spawn `--bridge` 子进程（旧档保留，行为不变）
     close()  ：连接档**只关这一条连接**（核心与另一条入口都不受影响 —— `D07`）
     request()/report()/stream_turn()/read_results()
              ：改走 `_send_line` / `_read_line` / `alive` 三个抽象
                （**协议一个字节都没改**：还是 NDJSON + `turn-bridge.ts` 的受控登记表）
② `--bridge-only`：只跑桥客户端（不装 VTuber 上游 / 不碰 ASR/TTS）—— 给验收门用
③ 门：`pnpm postlv2:coexist:avatar-shell`（**用真的 `LGBridgeClient`**，不是本门自写的模拟外壳）
```

**门读数**（`artifacts/post-lv2/coexist-wp3-shell-*/result.json`）：

| 项 | 结论 | 读数 |
|---|---|---|
| `W-1` ★ 真皮套外壳用**连接档**连上共享核心 | **PASS** | `LG_ENTRY_READY avatar dm-sumuwei-21eaed19-avatar` |
| `W-2` 正式轮次经这条连接完成 | **PASS** | `outcome=replied` · `replyId=cev:…:dm-sumuwei-21eaed19-avatar:3` |
| `W-4` ★ **合成账 + 播放账被交付账受理** | **PASS** | `synthesis=accepted` · `playback=accepted` · `accepted=2 / rejected=0` |
| `W-5` 取消读数是三态分列 | **PASS** | `requested=true` · `alreadyCommitted=true` · `stoppedBeforeModel=false`（已提交 ⇒ 受理但**不可撤销**） |
| `W-6` ★ 外壳断开不关核心、也不关 QQ | **PASS** | 外壳关掉之后 QQ 新请求照常成功 |
| `W-7` 核心随后正常停机 | **PASS** | `exit=0` |
| `W-8` 事件落在两条会话上且序号连续 | **PASS** | avatar 2 条 · qq 2 条 |
| `W-9` ★ 真实库从未被打开 | **PASS** | 树摘要 `aad0ffdbd22fd8c5…` 前后逐字相同 |
| `W-10` ASR / TTS / 音频 / 表情渲染 / 真人体验 | **NOT RUN** | 本门只跑桥客户端，不装上游、不碰音频设备 |
| `W-11` 生产皮套启动脚本切到连接档 | **NOT RUN** | 改生产启动路径属**接线**；激活要等 WP5 的切换授权（`postlv2-avatar-production.cmd` **未改**） |

⚠️ **这不等于"皮套已经共用一个核心"**：连接档**已实现并验过**，但**生产启动脚本仍走旧档**
（每个入口一个库持有者）。把生产切过去是 WP5 的授权动作。

⚠️ 回归：`pnpm postlv2:transport:verify`（78 项）与 `pnpm postlv2:expression:verify`（11/11）
在改动之后复跑**仍 PASS**；`python -m py_compile` 通过。

⚠️ 一处**遗留的真实约束**（登记）：连接档下"核心的**开机追赶**"只在核心启动时跑一次，
而外壳可能在核心之后很久才接入 —— 那是设计（追赶消费的是角色级事件流，与入口无关）。

