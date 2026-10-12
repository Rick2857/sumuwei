# ADR-130 — 记忆写入档回退到 LangMem（纯语义召回保留）

2026-10-10 · **ACCEPTED / EXECUTED**（配置层）。用户裁定原话：**「A：只删 WRITE_MODE，启用 LangMem 写入」**
（本轮三选一；另两条 = 完全回退到 2026-10-09 之前 / 先修模板覆盖缺陷，均未被选）。

本页是 [ADR-123](ADR-123-post-turn-model-memory-and-semantic-only-recall.md) 的**状态修订**，只改
"写入侧由谁判定"这一件事：

- ADR-123 的 `D01`–`D08` **未被本页改写**，其中 **§7 的 `semantic_only` 召回仍然生效**（本页刻意保留它）；
- [ADR-117](ADR-117-automatic-memory-langmem.md) `D01`–`D06` 与 [ADR-118](ADR-118-automatic-memory-production-activation.md)
  的 LangMem 设计（含"代码缺省 off"）一并保持有效；
- 两份旧 ADR 的历史读数**不回写**。

---

## 1. 先写代价（改动前实测，来自只读副本）

`pnpm exec tsx scripts/postlv2-langmem-backlog-readback.ts`（生产库**只被 `cpSync` 读、从未作为数据库打开**；
只发 SELECT；不打印任何正文）：

| 项 | 读数 |
|---|---|
| 库 schema | 18 |
| 账本 | 事件 **514** 条 · 最大序号 **944** |
| `automatic-memory-langmem@1` 水位 | **785**（ADR-118 建立 cutover 765，随后自己跑到 785；**8** 个 completed 任务 `[766..785]`） |
| `post-turn-model-memory@1` 水位 | **944** = 账本最大序号（**无积压**）；completed **61** 条 `[786..944]`，另有 **1** 条 failed `[786..793]`（`model_memory_decision_or_commit_failed`，**未堵住**水位） |
| 记忆基线 | active **3** · retracted **2** |
| 回退后 LangMem 要追的区间 | `(785, 944]` = **61 个事件** ⇒ 61 个任务，其中**受信 `user_message` 31 条** |
| 这 31 条的性质 | **全部 31 条都已被 post-turn 档判定过**；从未被任何档处理过的 = **0** |
| owner 记录 | `cleanClose=true` · `operationKind=migrate` · `endedAt=2026-10-10T12:30:42.498Z` |
| 端口 6751/6752/12394 | **0** 个监听（核心确已停机） |

⇒ 换档的**真实代价**是：**最近 31 条原话会被第二个写入器再判一次**，
**不是**"补上从未被处理的洞"（那种洞 = 0 条）。
ADR-117 `D02` 的两道护栏仍在（同槽位不同值拒绝自动变更 · retracted/superseded 不自动复活），
因此本页主张的是"**不会覆盖已有取值**"，**不是**"不会新增记录"。

同时回退掉的还有 ADR-123 §1 的**统一语义判定**（问句/提醒也调模型）与前台"本轮只说待处理"的挂起事实：
写入改由 **LangMem（普通陈述，问句与规则命中的显式命令在调模型前排除）+ 前台同步显式路径（"记住 X"当场写）** 承担。

## 2. 已执行（配置层，一处）

`.env` **只改一处**（8658 → 8889 字节，+231）：把 `CHARACTER_MEMORY_WRITE_MODE=post_turn_model`
改为**注释保留**并加两行说明；`CHARACTER_MEMORY_RECALL_MODE=semantic_only` **原样保留**。

字节纪律（照 `L-QQP-03` 的教训）：

- 改动前备份 `artifacts/post-lv2/local/langmem-write-mode-rollback-20261010/.env.before`
  （字节数与源一致，sha256 前缀 `feb456849387b9c8`）；
- 改动后文件 sha256 前缀 `9e16cd4ea9d86ee9`；
- **严格 UTF-8 解码通过 · `U+FFFD` 计数 = 0**；行级 diff 显示只有该处变化（原行前插入 3 行）；
- 全程**未使用** `Get-Content` / `Set-Content`（走编辑工具）。

生效确认（`readKernelFlags()` 实读，非推断）：

```json
{ "memoryEnabled": true, "memoryAutomaticEnabled": true, "memoryPostTurnModelEnabled": false,
  "memorySemanticOnlyEnabled": true, "memorySemanticMode": "on", "memoryLlmExtractorEnabled": true }
```

## 3. 门与读数（**分列**，不许合成一个总分）

| 槽 | 读数 |
|---|---|
| 设计 | 本页 **ACCEPTED**（状态修订；不改 ADR-117 / ADR-123 正文） |
| 实现 | **无代码改动**（只改配置）；新增**只读**脚本 `scripts/postlv2-langmem-backlog-readback.ts` |
| 离线硬门 | `postlv2:automatic-memory:verify` **20/20 · EXIT 0**（含此前因档位而红的那条 bridge 检查**转绿**）· `postlv2:model-memory:verify` **EXIT 0** · `pnpm typecheck` **EXIT 0** · `pnpm m4.5:ci` **EXIT 0**（G2 150/0 · L2 53/0 · G12 38/0 · G13 32/0 · **G14 Production-copy Live Smoke 52/0** · G9 人工审计 PASS · G14 选档器自证 5/5） |
| 快车道 | `pnpm fast` = 52 道 · **PASS 51 · FAIL 1**；唯一红项 `postlv2:role-tool:verify` 的两点归因见 §4，**与本次改动无关** |
| 量具有效性 | 未新增量具；本轮的**正控/负控** = **同一个门在两种档位下的一红一绿**（只改一个变量，见 §4 ②） |
| 真实链 | **NOT TAKEN**（本轮**未启动核心**） |
| 生产激活 | **EXECUTED（配置层）** |
| 首次使用 | **NOT OBSERVED** |

`pnpm m4.5:ci` 本轮是**按规矩跑的**：它的 `G14` 对生产库做**热复制**，而 §5.1 要求"复制前先停服务" ——
核心正好停着，这个窗口才成立。

## 4. 两条必须分列的观察（容易读错）

1. **`postlv2-model-memory-main-verify` 在回退后仍 EXIT 0**，因为它在子进程里**显式写死**
   `CHARACTER_MEMORY_WRITE_MODE='post_turn_model'`（`scripts/postlv2-model-memory-main-verify.ts:42` / `:82`）。
   ⇒ 它测的是**代码路径**，**不是生产档位**。**不要**拿它的绿当"生产仍在 post-turn"的证据。
2. 反过来，**LangMem 那道门的 bridge 检查继承 `.env`**
   （`scripts/postlv2-automatic-memory-verify.ts:244-247` 的 `*_ENABLED` 正则**不含** `WRITE_MODE`）
   ⇒ 它是**唯一**能反映生产档位的门；本轮它由红转绿，这就是 §3 "实现"槽的正控读数。
   （口径差异本身是既有事实，本页只登记，不改门。）

`pnpm fast` 的唯一红项归因（**两点均为既存，非本次改动**）：

- `browser.mcp 的参数白名单里有通用执行入口：tool` ⇒ 全局 `generic_bypass_arg`，2026-10-09 已登记；
- `TASK_ARG_KEYS 里有一行 local.reminder.message，但它没有被登记` ⇒ 在途的提醒线
  （ADR-124 / ADR-129）往 `src/kernel/action/task-plan.ts:118` 加了能力，却**没有同步
  `scripts/postlv2-role-tool-verify.ts` 的夹具登记表**（该脚本自己的注释就预言了这一条）。

`scripts:catalog:verify` 在改动**之前**已经是红的（已提交 **242** / 现在应 **245**），
其中 1 个是我新增的只读脚本、另 2 个来自在途会话。已 `pnpm scripts:catalog` 重新生成（**601** 条）
⇒ `:verify` 复绿；这一步把在途会话的脚本一并收进清单，逐条可查于该文件的 diff。

## 5. 残余（不回写、不合并，也不因本页关闭）

- LangMem 追那 61 个事件时，31 条原话是**第二次判定**；**新增/去重的实际条数未测**（要等真实运行）。
- LangMem 与前台显式路径的**已知误判面随本页恢复**：ADR-123 的立案根因是事件 679
  （「叫我拔一下插头」→ `preferred.address`），根因就在**前台显式路径的内容规则**上。
  本页**不主张**该面已修；要修它是**另一件事**（ADR-123 §替代方案里的"模板覆盖"与"内容规则"两条各自独立）。
- `post-turn-model-memory` 的 1 条 failed 任务 `[786..793]` 原样保留；其处理器停用后不再重试。
- 补跑节奏：LangMem 每次通知最多消费 **20** 个源事件
  （`src/infrastructure/runtime/automatic-memory.ts:70`），通知来自每轮回复后的
  `void this.drainAutomaticMemoryTail()`（`src/main.ts:4790`）⇒ 61 个事件约需 **4 轮**对话排空；
  回复本身**不被它阻塞**（fire-and-forget），但后台模型调用与 Python 子进程占用会在头几轮升高。
- `AUD-ISO-01`、`L-M97-02`、`L-QQP-*` 等既有残余不变。

## 6. 撤回

把 `.env` 里那一行的注释去掉（恢复 `CHARACTER_MEMORY_WRITE_MODE=post_turn_model`）再受控重启，
即回到 ADR-123 档。**两个处理器水位分开保留**（LangMem 停在它自己的进度、`post-turn` 停在 944）：

- 回退到 **post-turn 档** ⇒ 它不会重跑已处理的区间（水位在 944）；
- 回退到 **LangMem 档** ⇒ 它会**重新追赶** `(水位, 当时最大序号]`（就是 §1 的口径）。

⚠️ **两个方向都不得描述成完整的数据回滚**：已合法提交的记忆事件、任务与投影都不回滚。

---

**变更记录**：2026-10-10 首次成文（配置层回退 + 门读数）。
