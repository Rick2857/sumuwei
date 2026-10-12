# QQ × Live2D 双入口共存 —— WP4 隔离整链、真实模型与性能

日期：2026-10-06（UTC+8）。状态：**WP4 的离线场景矩阵、真实模型档与性能读数已交付；真人体验仍为 NOT RUN；WP5 起尚未开始；生产尚未切换**。

计划：[`QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md`](QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md) ·
[`WP0`](QQ-Live2D-Coexistence-WP0-Baseline.md) · [`WP1`](QQ-Live2D-Coexistence-WP1-Compatibility-Trial.md) ·
[`WP2`](QQ-Live2D-Coexistence-WP2-Dual-Entry.md) · [`WP3`](QQ-Live2D-Coexistence-WP3-Media-Control.md) ·
[`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md)。

## 0. 三道门（都只读隔离库；生产库从不打开）

```bash
pnpm postlv2:coexist:verify    # WP2/WP3 整链（33 项 PASS + 3 项观察）
pnpm postlv2:coexist:matrix    # ★ 本包：计划 §5 的 12 个场景 + 性能读数
pnpm with-test-model pnpm postlv2:coexist:live   # ★ 本包：真实模型档（测试端点）
```

证据：`artifacts/post-lv2/coexist-wp4-matrix-20261006073905066/result.json` ·
`artifacts/post-lv2/coexist-wp4-live-20261006074421839/result.json` ·
`artifacts/post-lv2/local/coexistence-wp4/m4.5-ci.log`（完整离线 CI）。

---

## 1. 计划 §5 的十二个场景（逐条结论，**不许合成一个总分**）

| # | 场景 | 结论 | 读数 / 理由 |
|---|---|---|---|
| 1 | 同时提交，两边用**相同外部 requestId** | **PASS** | 内部请求互不冲突、回复各回原入口（`S1`） |
| 2 | 标记 A / B 再分别追问 | **PASS**（近期窗口）/ **NOT RUN**（会话摘要） | 追问只看到自己那条、另一条标记 0 个（`S2a`）；摘要层没有可摘材料（Recent 窗口覆盖了全部历史）⇒ 如实 NOT RUN（`S2b`） |
| 3 | QQ 记住 → 皮套问；反向重复 | **PASS** | 两条明确记忆操作**都不在**对方近期窗口里（`S3a`）；**读侧**由真实模型档 `L-6` 覆盖（见 §3） |
| 4 | 普通闲聊 / 问句 / 引用记忆 / 否定命令 | **PASS** | 那四条（`MARK-A5/A6/A7/B5`）**一个都没进记忆**（`R-3`）——路由或框架包装没有增加自动写入 |
| 5 | 播放中收到 QQ / 长轮次期间取消排队请求 | **PASS**（取消）/ **NOT RUN**（播放中） | 取消**排队中**的请求在模型前停住、另一条照常完成（`S5a`）；真实音频面属 WP3 剩下的那一半（`S5b`） |
| 6 | 桌面断开 / QQ 断开 / 单路超时 / 发送失败 | **PASS**（两个断开）/ **NOT RUN**（超时） | 两侧各断一次，另一路新请求都成功（`S6a`/`S6b`）；超时要真等 180s 桥期限（`S6c`）；发送失败属 QQ 外壳（`pnpm qq:verify` 已覆盖） |
| 7 | 断线重连 / 重复 OneBot 事件 | **N/A** + **NOT RUN** | 那是 QQ 外壳职责（`qq:verify` 覆盖，`S7`）；重启后的再投递边界登记为 `L-COEXIST-07`（`S7b`） |
| 8 | 伪造入口 / 用户 / 角色 / 会话 / 取消对象 | **PASS** | 错 token ⇒ `LG_ENTRY_REJECTED`；载荷里塞 `entry`/`conversationId`/`userId`/`characterId`/`role` 都改不了落点；用 QQ 的连接去取消**皮套**的 requestId **不越入口**（被"取消"的那条 `outcome=replied`）（`S8a`） |
| 9 | 慢模型 / 队列上限 / 连续多条 | **PASS**（排队与公平）/ **观察到**（上限） | 基线一轮 80ms vs 排队那一轮 **1268ms**（`S9a`）；**上限在桥的每连接串行泵下结构上不可达**（`S9b`，见 §4） |
| 10 | 坏 JSON / 模型失败后恢复 | **PASS** | 坏 JSON ⇒ 具名 `bridge_malformed_json`；模型失败那一轮 `outcome=failed`，下一轮恢复（`S10`） |
| 11 | 稳定运行后正常重启 | **PASS** | 两次运行都退出码 0；会话 id 确定性相同；QQ `22→24` / 皮套 `27→29` 条且**序号连续**；QQ 身份映射仍 **1** 行（`S11a/b/c`） |
| 12 | 用户观察皮套语音与表情，同时操作 QQ | **NOT RUN** | 需要真实皮套外壳与真人（`S12`）——本机夹具无法代替 |

**硬隔离场景全部通过**（1/3/4/5-取消/6-断开/8/10/11 九项 PASS；其余如实 NOT RUN 或 N/A）。
量具自身的正控 / 负控 / 恢复在 `pnpm postlv2:coexist:verify` 的 `M-1`…`M-3`（本包沿用同一把量具）。

---

## 2. 性能读数（计划 §5 的清单）

**同一批材料**：每轮 `SLOW300`（夹具延迟 300ms，模拟模型耗时）+ 3 轮。

| 项 | 单入口（只有 QQ） | 双入口（QQ + 皮套各 3 轮并发） |
|---|---|---|
| 每轮墙钟 | 400 / 370 / 400 ms | 797 / 727 / 723 ms |
| 平均 | **390 ms** | **749 ms** |
| 排队等待（调度器读数） | 无（无人争用） | **336 / 342 / 348 ms**（每轮都记下） |
| 退出码 | 0 | 0 |

- **接收时间 / 正式轮次耗时**：单入口 390ms、双入口 749ms —— 差额（≈359ms）几乎全部是**排队等待**
  （模型段本身没有变慢）。这就是计划 §1 说的"共同资源造成的等待"，**如实报告，不推导成"普遍零干扰"**。
- **首次文字**：本协议面里"文字"与"轮次完成"是同一件事（没有流式文字通道）⇒ 等于上表。
- **首次音频**：**NOT RUN**（协议面没有真实 TTS/播放）。
- **打断响应**：**协议面已覆盖**（`S5a`：取消在模型之前停住）；"打断后多久**真的**停播"**NOT RUN**。
- **总模型调用数**：整份矩阵夹具共 **46** 次（含各场景）。
- 真实模型档的时延另见 §3（墙钟 2.7–7.0s，其中模型段 1.8–5.6s）。

---

## 3. 真实模型档（`pnpm with-test-model pnpm postlv2:coexist:live`）

端点 `ark.cn-beijing.volces.com` · 模型 `deepseek-v4.1-flash`（**测试端点**，非生产端点）。

| 项 | 结论 | 读数 |
|---|---|---|
| 两条入口真实轮次各自完成 | **PASS** | `qq="嗯。是还行。"` · 皮套也有真实回复（`L-1`） |
| 两个会话独立 + 序号连续 | **PASS** | 两个会话各 6 条事件、`conversation_sequence` 连续（`L-4b`） |
| **真实模型下近期窗口零混入** | **PASS** | 6 轮 trace 引用的对话事件**外来 0 条**（`L-4c`）——与夹具档**同一把量具** |
| **语义写入**（ADR-108 的 LLM 意图兜底） | **PASS** | `请记住，我在示例工程科技大学读书。` ⇒ `memory_records` 落地 1 条 `person_fact=示例工程科技大学`（`L-5`）；⚠️ 规则层**不识别**"请记住……"，所以这条**只能是** LLM 兜底做成的 |
| **跨入口共享记忆的读侧** | **PASS** ★ | 皮套问"示例工程科技大学 是什么地方？"⇒ 皮套那一轮的 `selected_memory_ids` **含 QQ 写入的那条记忆**（`L-6`）。**夹具档跑不出来的那一半，真实模型档跑出来了** |
| 真实时延 | 读数 | `live-a1` 3558ms（model 2377）· `live-b1` 2738（1787）· `live-a2` 6952（5613）· `live-b2` 3830（2687）· `live-a3` 3491（2019）· `live-b3` …（`L-8`） |
| 语义（嵌入）召回 | **NOT RUN** | 要本机编码器运行时（M9.5）；本门把 `CHARACTER_MEMORY_SEMANTIC_MODE=off`（`L-9`） |
| 真实音频 / 真人体验 | **NOT RUN** | （`L-10`） |
| 真实库 | **从未被打开** | 树摘要 `aad0ffdbd22fd8c5…` 前后逐字相同（`L-7`） |

---

## 4. 本包**修掉的一个真实缺陷**（WP4 的现场发现）

**`--coexist` 停机时进程不退出。**
`runCoexistenceHost` 收尾只做了 `server.close()` —— 它**只停止接受新连接**，
已经接入的 socket 仍然开着 ⇒ 那些 `runBridgeTransport` 的 async 任务永远不返回 ⇒
**进程在 `stdin` 已关之后仍然不退出**（实测：180 秒仍在）。

- **修法**（`src/main.ts`）：收尾顺序改成"**关监听 → 等调度器排空（有界 30s）→ 销毁已接入的连接 → 关库**"。
- **同一次修复里踩到的第二个坑**：`server.close()` 的回调**要等所有连接都结束**才触发
  ⇒ "先 `await` 回调、再销毁连接"会**自己把自己挂住**。正确顺序是先销毁 socket、再等回调。
- **判据**：`S11a`（退出码 0）与 `L-4a`（真实模型档退出码 0）。
- ⚠️ **WP2 的门当时为什么是绿的**：那道门在关 `stdin` **之前**就把两条外壳连接关掉了
  ⇒ 掩盖了这个缺陷。这正是"离线全绿 ≠ 真实链路正确"的又一例。

### 另外两条**量具/读数**教训（如实登记，不改判据）

1. **夹具只回一次 500 会假绿**：生产模型调用本身有**有界重试**（`MODEL_CALL_MAX_ATTEMPTS = 3`）
   ⇒ 只失败一次时，重试那一次成功了、轮次照常 `replied`，"模型失败后恢复"这条判据
   **测的不是它以为的那件事**。夹具改成"连回 3 次"后 `S10` 才真的在测失败路径。
2. **日志里取 JSON 不能用第一个 `[`**：日志前缀本身带方括号（`[coexist]`）⇒
   取第一个会把前缀切进 JSON、解析失败、读数显示成"0 条"（**假空**）。
   改用**最后一个** `[`（`schedulerReadings()`）。

---

## 5. 本包**不主张**什么（诚实边界）

1. **真人体验 NOT RUN**（`S12`）——计划 §5 明确要求"真人体验使用明确标识的隔离部署"，
   而真实皮套外壳（ASR/TTS/音频/表情）还没接到核心上（WP3 剩下的那一半）。
2. **会话摘要（rollup）区块的入口归属 NOT RUN**（`S2b`）：本轮的 Recent 窗口覆盖了全部历史，
   摘要层没有可摘材料。要出这条读数需要"每会话 >18 条事件 + 额度 >0"的更长材料。
3. **真实音频面**（首次音频、播放中收 QQ、打断后多久真停）全部 NOT RUN。
4. **单路超时**（`S6c`）与**重启后再投递边界**（`S7b`）NOT RUN / 登记。
5. **语义（嵌入）召回** NOT RUN（要编码器运行时）。
6. **性能读数只有本机夹具**：它量的是"排队与调度"的形状，**不是**真实模型的吞吐；
   真实模型的时延见 §3，两者**不能相加**。

---

## 6. 新登记的残余（`L-COEXIST-07…10`）

| 编号 | 内容 |
|---|---|
| `L-COEXIST-07` | **跨进程去重窗口不保留**：QQ 外壳的 512 条去重缓存只在进程内；重启后同一条 OneBot 事件若被重投会**再次处理**（与既有 QQ 侧登记一致：不宣称跨崩溃 exactly-once）。 |
| `L-COEXIST-08` | **会话摘要的入口归属没有端到端读数**（`S2b`）：要"每会话 >18 条事件 + `CHARACTER_ROLLUP_TOKENS>0`"的材料。设计上它已经**只按会话**（`rollupForTurn` 没有 `conversationId` 就拒绝摘要）。 |
| `L-COEXIST-09` | **队列上限是防御性的**：`runBridgeTransport` 对正式轮次**每连接严格串行** ⇒ 每入口至多 1 条在飞 ⇒ 上限（缺省 4）在生产里不会响。拒绝路径由部件级门覆盖（`verify` 的 `S-4`）。 |
| `L-COEXIST-10` | **夹具档里"我喜欢喝拿铁"没落地成记忆**（`R-3b` 1/2 条）：这是**既有记忆规则**的读数（偏好槽位的抽取边界），不是共存缺陷；真实模型档只验了 `person_fact` 那一类。 |

---

## 7. 完整离线 CI

**`pnpm m4.5:ci` = EXIT 0**（`artifacts/post-lv2/local/coexistence-wp4/m4.5-ci.log`；
硬门含 `G13 Natural Language E2E` 32/0 · `G14 Production-copy Live Smoke` 52/0 · `G2 Component` 146/0 · `G9 人工审计语料` PASS）。

⚠️ 第一次跑**失败**，原因是 `package.json` 被我用 PowerShell 写入了 **UTF-8 BOM**，
一条"读 `package.json` 并 `JSON.parse`"的既有判据因此报 `SyntaxError`。
⇒ 已用 Node 去掉 BOM（`git diff package.json` 现在只有 **3 行新增**：三个脚本登记）。
这是本机工具纪律（AGENTS.md §7：**不要用 PowerShell 重写仓库文件**）的又一次实证。

## 8. 三道门在本包改动之后的复跑

| 门 | 结果 |
|---|---|
| `pnpm typecheck` | **EXIT 0** |
| `pnpm postlv2:coexist:verify`（WP2/WP3） | **PASS**（33 项；停机修复之后复跑仍绿） |
| `pnpm postlv2:coexist:matrix`（本包） | **PASS**（12 场景 + 性能 + `X-1` 真实库逐字相同） |
| `pnpm with-test-model pnpm postlv2:coexist:live`（本包） | **PASS**（含 `L-6` 跨入口召回读侧） |
| `pnpm m4.5:ci`（完整离线 CI） | **EXIT 0** |

