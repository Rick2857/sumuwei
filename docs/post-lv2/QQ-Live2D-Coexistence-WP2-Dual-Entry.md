# QQ × Live2D 双入口共存 —— WP2 共享核心与文字双入口

日期：2026-10-06（UTC+8）。状态：**WP2 已实现并离线整链通过；WP3 起尚未开始；生产尚未切换**。

计划：[`QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md`](QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md) ·
基线：[`WP0`](QQ-Live2D-Coexistence-WP0-Baseline.md) ·
路线：[`WP1`](QQ-Live2D-Coexistence-WP1-Compatibility-Trial.md) ·
设计：[`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md)。

门：**`pnpm postlv2:coexist:verify`**（新增）。证据：`artifacts/post-lv2/coexist-wp2-verify-<时间戳>/result.json`
（最近一次 `coexist-wp2-verify-20261006062810771`）。

---

## 1. 实现了什么（逐条对应 ADR-109 的决定）

| 决定 | 落点 | 说明 |
|---|---|---|
| `D02` 入口维度进会话 | **新增** `src/infrastructure/runtime/entry-scope.ts` | `conversationIdForEntry()` 是**纯函数**；`cli` 后缀为空串 ⇒ CLI 会话 id 逐字不变；`qq_private`→`-qq`、`avatar`→`-avatar` |
| `D02` 开关 | `src/kernel/app/flags.ts` | `CHARACTER_ENTRY_SCOPED_CONVERSATIONS`，**代码缺省 false**（先例 ADR-048：接线就位、激活另裁） |
| `D04` 近期窗口按入口 | `src/infrastructure/runtime/adapters.ts` `recentContextLinesFrom` 新增可选 `conversationId`；`src/main.ts` 两处调用（决策输入 + prompt Recent） | 不传 ⇒ 角色级（M3 起的行为）；传 ⇒ 只读本入口那条会话 |
| `D01`/`D03` 公共生命周期只跑一次 | `src/main.ts` `ChatSession.openSharedConsumers()` + `SharedConsumerDelegate` + `sharedConsumerDelegate()` | owner 跑共享段；借用者（`consumers` 非空）**跳过**共享段、`close()` **什么都不做**、四个 drain 转交 owner |
| `D06` 有序 + 轮转公平 | **新增** `src/kernel/app/bridge/turn-scheduler.ts`（`FairTurnScheduler`） | 每入口有界队列（上限含正在跑的那一轮）、轮转指针、一次一轮；超限**具名拒绝** `scheduler_queue_full` |
| `D05`/`D07` 回复 / 取消 / 交付按入口 | `src/main.ts` `createCoexistenceEntryServer()` | 每入口自己的 `TurnCancellationRegistry`；语音交付账**只给皮套**（QQ 是纯文字入口）；一条连接断开只 `socket.destroy()` |
| `D02` 入口由程序事实绑定 | `src/main.ts` 的**监听端口** + 传输层握手 `LG_ENTRY <token>` | 载荷里**没有**任何字段能选入口；握手**不是**桥的消息种类 ⇒ `turn-bridge.ts` 的受控登记表**一个字都没改** |
| 新装配模式 | `src/main.ts` `--coexist`（缺省不存在） | 一个核心进程：owner 会话 + 两条监听（`127.0.0.1`）；停机触发 = **stdin EOF** |

**没有做的事（刻意）**：不改桥的受控消息种类；不动 `INV-PL2-08/09`；不动 `INC-01` 的租约/快照/关闭链；
不新增迁移；不动 AstrBot（WP1 已裁定不用它）；不改 `.env`（激活是独立裁定）。

---

## 2. 门的读数（`pnpm postlv2:coexist:verify`）

范围：**真 `src/main.ts --coexist`** + **全新隔离库** + **本机固定回复夹具**（不调外部模型）+
两个模拟外壳（TCP）。**生产库从未被打开**（树摘要 `aad0ffdbd22fd8c5…` 前后逐字相同，`R-10`）。

### 2.1 入口作用域与调度（纯函数 / 部件级）

| 项 | 读数 |
|---|---|
| `S-1` 开关关着 | 三条入口**同一个** `dm-sumuwei-abcd1234`（M3 起的行为） |
| `S-2` 开关打开 | `cli` 逐字不变 · `qq`=`…-qq` · `avatar`=`…-avatar`，三者互不相同 |
| `S-3` 轮转公平 | 一边连发三条 + 另一边一条 ⇒ 顺序 `["A1","B1","A2","A3"]`（**B1 不在最后**）· 峰值并发 **1** |
| `S-4` 队列有界 | 上限 1 时第二条被拒成 `scheduler_queue_full`（失败关闭，不堆积） |

### 2.2 端到端（两条模拟外壳 ↔ 一个核心）

| 项 | 读数 |
|---|---|
| `E-0` | `COEXIST_READY entries=qq_private:<port>,avatar:<port>`（两条都只绑 loopback） |
| `E-0b` ★ | 共享段目击行「关系基线播种」出现 **1** 次（owner 跑一次；两条入口会话不各跑一遍） |
| `E-1` | 错 token ⇒ `LG_ENTRY_REJECTED invalid_handshake` |
| `E-2`/`E-3` | `qq=dm-sumuwei-21eaed19-qq` · `avatar=dm-sumuwei-21eaed19-avatar`（**不同**会话，入口分量正确） |
| `E-4` | 两路**同时**提交，各自完成（同外部 `requestId` 也不冲突） |
| `E-5` | 首轮：QQ 回复含 B 标记 **0** 个 · 皮套回复含 A 标记 **0** 个 |
| `E-6`/`E-7` | 追问轮：QQ 看到自己的 `MARK-A1` 且 B 标记 **0**；皮套看到自己的 `MARK-B1` 且 A 标记 **0** |
| `E-8` | 皮套的问句里**没有** A3（不靠近期窗口，靠共享记忆链） |
| `E-9` | 坏 JSON ⇒ 具名 `bridge_malformed_json`（不打断任何东西） |
| `E-10` | 一路的坏输入 / 断开之后，另一路新请求仍然成功 |
| `E-11` | stdin EOF ⇒ 有序收尾，**退出码 0**（唯一关库链） |

### 2.3 实际读回（事件 / trace / 记忆 / 建档）

| 项 | 读数 |
|---|---|
| `R-1` | 事件落在**两个** `conversation_id` 上，互不混合 |
| `R-2` | 每会话 `conversation_sequence` 从 1 起连续：qq `[1..6]` · avatar `[1..8]` |
| `R-3` | A 标记只出现在 QQ 会话、B 只在皮套会话 |
| `R-4` | 7 条 trace：QQ 3 轮 / 皮套 4 轮 —— 与提交次数逐一对上，`conversation_id` 与入口一致 |
| `R-5` ★ | **每一轮 trace 引用的对话事件全部属于本轮自己的会话（外来 0 条）** |
| `R-6` | 有历史的 5 轮**都真的带上了** `recent-conversation` 区块（不是"没有区块所以没混入"） |
| `R-7` | `memory_records` 恰好 **1** 行（QQ 的明确记忆操作，写在共享的记忆里） |
| `R-9` | 关系基线只建一次档（1 条 `RELATIONSHIP_ORIGIN` 域事件 + 1 行 `relationship:user:…` 投影） |
| `R-10` ★ | 真实库树摘要前后**逐字相同** |

### 2.4 量具自身的正控 / 负控 / 恢复（AGENTS.md §6.7）

| 项 | 读数 |
|---|---|
| `M-1` 正控 | 带会话过滤读近期窗口 ⇒ 命中 A=14 · **B=0** |
| `M-2` 负控 | **去掉**过滤读**同一张表** ⇒ 命中 A=14 · **B=30**（隔离来自那一行过滤，不是"库里本来没有"） |
| `M-3` 恢复 | 把过滤放回去 ⇒ 又只剩 A（与 M-1 逐字一致） |

### 2.5 已跑的相关门（都在本次改动之后复跑）

`pnpm typecheck` **0** · `pnpm kernel:test` 27/0 · `pnpm m3.5:test` 30/0（prompt 逐字节基线未变）·
`pnpm m4:test` 262/0 · `pnpm m4.5:test` 146/0 · `pnpm qq:verify` PASS ·
`pnpm postlv2:bridge:verify` PASS · `pnpm postlv2:transport:verify` PASS（78 项）·
`pnpm m5.1.1:wp6.1:verify` **119 通过 / 2 失败** —— 两处失败与本次改动**无关**
（schema v9 / 迁移 1..9 的断言不适用于当前 v13，QQ 接入时已是同一读数，见 `QQ-Private-Integration-2026-10-06.md` §"验证与边界"）。

---

## 3. 本轮**不主张**什么（诚实边界）

1. **跨入口"召回"没有读数**（`R-8`）：QQ 写入的那条记忆在 `memory_records` 里确实只有一行（共享），
   但皮套那一轮 `selected_memory_ids` **为空**（4 轮都是 0）⇒ **本门不主张"皮套能召回 QQ 记住的事实"**。
   这属于计划 §5 场景 3 的**读侧**，留给 WP4 的针对性探针。
2. **没有真模型、没有真 QQ、没有真皮套**：夹具是本机固定回复；Electron 桌面端未运行；
   ASR/TTS、播放、取消的**真实**链路是 WP3 的事。
3. **调度读数只覆盖部件级 + 端到端的功能面**：计划 §5 的**性能**清单（接收/排队/首字/首音/打断响应）
   属于 WP4。
4. **信号不是有序停机**：`--coexist` 的优雅停机触发是 **stdin EOF**；Ctrl+C 走既有收尾链
   （它**不等待**在飞轮次）—— 与 `--bridge` 的既有行为一致，登记为 `L-COEXIST-03`。
5. **只支持两个入口**：入口键是闭集 `cli | qq_private | avatar`；`--coexist` 只装配后两个。
6. **本门跑在 `CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true` 上**：`.env` **没有**这一行
   ⇒ 生产当前行为**一个字都没变**（`qq:verify` 与 `postlv2:bridge:verify` 在同一棵树上通过即为证）。

---

## 4. 已登记的限制（`L-COEXIST-*`）

| 编号 | 内容 | 为什么现在不修 |
|---|---|---|
| `L-COEXIST-01` | **皮套仍沿用 `interactive_human_console` 归因入口**（没有独立的 `avatar` 具名 ingress）⇒ 账本上 CLI 与皮套不可区分 | 要先裁定"**ASR 转写出来的话算不算 `authenticated_human_input`**"这个**认知资格**问题（打字与说话不是同一件事）。擅自新增一个声称 confirmed 的入口会制造一个**没有证据的**确认 |
| `L-COEXIST-02` | Recent 区块给出的 `sourceRefs` 是 **`cev:cev:<…>`**（比表里的 `conversation_events.id` 多一层 `cev:`）；其它区块给的写法不同 ⇒ trace 的 `source_conversation_event_ids` 是**混合**引用集合 | 既有（M2.5 起）的写法差异；改它会改 trace 内容，可能扰动多条已冻结的证据线。本门**两种都解析**并如实登记（见 `R-4b`/`R-4c`） |
| `L-COEXIST-03` | Ctrl+C **不**做有序排空（先关库）；优雅停机只由 **stdin EOF** 触发 | 与 `--bridge` 的既有行为一致；真正的启动/停机脚本属于 WP5 |
| `L-COEXIST-04` | 旧镜像（`messages` 表）与 `roomId` 仍是**房间级**共用 ⇒ `turn` 坐标是房间级 | **有序调度（一次一轮）下不会撞号**（每轮写 2 条、计数前进）；但若将来允许并发轮次，`onConflictDoNothing` 会**静默丢消息**。WP0 基线 §6 的 `R2` 仍然 OPEN |
| `L-COEXIST-05` | `--coexist` 的两条入口**必须**配 token（`CHARACTER_COEXIST_*_TOKEN`，≥16 字符），否则**拒绝启动** | 这是刻意的失败关闭：无鉴权的本机监听在多用户机器上等于把会话对同机任何进程开放 |
| `L-COEXIST-06` | 队列上限**含正在跑的那一轮**（`CHARACTER_COEXIST_QUEUE_BOUND`，缺省 4） | 只算排队数会让"有界"变成假读数（一个入口可以"跑一轮 + 排一轮"地逼近上限） |

---

## 5. 下一步（WP3 入口）

WP2 已经把"一个核心 + 两条受信会话"这条结构立起来了，**文字面**已闭环。WP3 要接的是**皮套的媒体与控制**：

- 复用当前 ASR/TTS、已检查语句、表情载荷、合成账、播放账与取消流程；
- 把皮套外壳从"自己 spawn 一个 `--bridge` 子进程"改成"连到 `--coexist` 的皮套监听端口"；
- 客户端断开只清理自身资源（`D07` 已有结构，WP3 验真实链路）；
- 播放事实与已提交事实分开报告。

WP3 的现场仍是**隔离部署**；真实皮套与真模型的读数属于 WP4。
