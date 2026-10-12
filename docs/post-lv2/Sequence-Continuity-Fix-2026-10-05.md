# 首句前取消后会话跳号：修复与回归锁

日期：2026-10-05。状态：**已修复 · 已复现（负控）· 已加回归门**。

调查阶段（根因 / 真实会话证据 / 受控复现 / 已有测试为什么没发现）在
[`artifacts/post-lv2/local/Sequence-Gap-Root-Cause-2026-10-05.md`](../../artifacts/post-lv2/local/Sequence-Gap-Root-Cause-2026-10-05.md)，
**本文不回写它的结论**，只记录修复做了什么、读数是什么、不主张什么。

---

## 1. 修了什么（三处，都在既有入口内）

### 1.1 会话内序号的权威源改成**账本**（`src/main.ts`）

`ChatSession` 原来把"下一轮该用几号"存在**进程内缓存**里，而缓存只在两处赋值：
`open()` 的"账本末尾 + 1"与 `send()` 里 `beginTurn()` 之后的
`incoming.conversationSequence + 2`。后者是一条**预测**——"本轮用户事件与助手事件都会落账"。
首句前取消 / 首句前失败时助手事件**从未产生**，预测就领先于账本 ⇒ 同一进程的下一轮拿着
偏大的号去写，被 `ConversationRecorder.assertSequenceContiguous()` 正确地拒成
`conversation_sequence_gap`，**后续整段会话卡死**（重启才好，因为 `open()` 会重读账本）。

修法不是"把预测改小一点"，而是**取消预测**：

```text
新增  private async reconcileConversationSequence()
      —— 每轮 `beginTurn()` **之前**重读
         `latestConversationSequence(db, characterId, conversationId)` 并置 `+ 1`。
      —— 干跑不重算（干跑不写库，账本最大值本来就不会动）。
```

于是"上一轮到底落了几条"这个事实**总是**被尊重：落 2 条、1 条、0 条都对，
**包括今天还不存在的半途失败路径**（这类缺陷的形态就是"多一条没被想到的提前返回"）。

同时把 `beginTurn()` 之后的那次赋值从 `+ 2` 改成 `+ 1`：它现在只推进到
**已知落账的那一条用户事件**，助手事件落账后由下一轮开头的重算带上。
（只做后者不做前者 = 缓存会在一次失败之后永久粘贴成偏大的值；只做前者不做后者 =
"缓存可以随便撒谎"这条纪律还在。两处都改。）

### 1.2 取消与故障**分开具名**（`src/main.ts`）

首句之前结束的一轮，原来无论走哪条路径都记成
`speech_stream_failed_before_sentence` —— 于是"用户主动打断"与
"模型 / 链路自己坏了"在 trace 里**长得一模一样**，而这两件事的处置完全不同
（前者是正常交互，后者要查 provider）。现在：

| 情形 | 具名码 |
| --- | --- |
| 用户取消（`signal.aborted`） | `speech_stream_cancelled_before_sentence` |
| provider / 链路故障（如模型 `length` 终态） | 保留 provider 自己的码（例：`model_stream_finish_length`） |

判据只认 `signal.aborted`，**不**按 `name === 'AbortError'` 猜 ——
后者会把**超时**也误记成用户取消。

### 1.3 ⚠️ 一个实测出来的坑：`DOMException` 不是 `Error` 子类实例

第一版修复在这里**原样抛出** `error`，结果原因码**根本不生效**：桥拿到的仍是通用兜底
`bridge_turn_failed`（= "这次取消没有原因"）。实测原因是：

```text
取消时 `runtime.useModel()` 抛的是 DOMException（name=AbortError）；
它在"等待中的 promise 被 AbortSignal 唤醒"的那条路径上被**换成了另一个 AbortError**
⇒ 我们自己抛出的东西没有到达宿主。
```

换成 `throw new KernelError('validation_error', failureCode, failureCode)` 之后，
原因码逐字到达宿主与桥。**这不是绕过，而是真修**：让取消有一个能被机器读到的具名码。

> 这一条是本次唯一"看代码看不出来、必须实跑才发现"的地方，记在这里免得下次再踩。

---

## 2. 回归锁：`pnpm postlv2:sequence-continuity:verify`

新门 [`scripts/postlv2-sequence-continuity-verify.ts`](../../scripts/postlv2-sequence-continuity-verify.ts)。
走**真实 `src/main.ts --bridge`**、**全新隔离库**、**loopback HTTP 假模型**：
不调用真模型 / 不联网 / 不碰麦克风与 TTS / **不打开生产库**（前后对生产目录树摘要逐字比对）。

七个场景与实测读数（`EXIT 0`）：

| 场景 | 首轮 | 下一轮 | 账本（会话内序号） |
| --- | --- | --- | --- |
| 两轮正常完成（**正控**） | replied | replied | `user:1 character:2 user:3 character:4` |
| 首句前取消 ×3（独立运行） | failed / `speech_stream_cancelled_before_sentence` | **replied** | `user:1 user:2 character:3` |
| 首句前链路失败（模型 `length`） | failed / `model_stream_finish_length` | **replied** | `user:1 user:2 character:3` |
| 首句已发出后取消 | failed / `speech_stream_cancelled` | replied | `user:1 character:2 user:3 character:4` |
| 在失败库上重启 | replied | replied | `user:1 … character:7`（逐字连续） |

除"下一轮必须 replied"外还断言：

- **账本逐条精确比对**（不看"大概"）——助手序号空着是**事实**，不是缺陷；
- **取消原因必须独立可观测**：首句前取消的 `trace.error` =
  `speech_stream_cancelled_before_sentence`；链路失败保留 provider 具名码，
  且**不得**被记成取消；
- 生产库目录树摘要前后**逐字相同**。

⚠️ `speechPackets` 读数是**整个会话两个轮次合计**的（首句前取消那一轮本身 0 包，
加上下一轮回复的 1 包 = 1），断言里写明了这个口径。

### 2.1 负控（三段式的第二段）

把两处修复同时回退（`+ 2` 且不重算），**同一道门立刻变红**：

```text
[cancel-before-1] 首轮=failed/speech_stream_cancelled_before_sentence
                  · 下一轮=failed/conversation_sequence_gap · 账本=["user:1"]
AssertionError: 首句前取消**不得**让下一轮跳号
```

⇒ 这道门量到的**确实是**它声称要量的事情（INV-M45-06 的第一段与第二段：
正控"该写的时候写了" + 负控"注入旧行为必须响"）。恢复修复后重新变绿。

### 2.2 为什么原来的取消测试没发现

- `scripts/postlv2-text-stream-verify.ts` 的取消测试用**受控 session**，
  先发出一条完整句子**再**取消，随后重复的是**同一个 requestId**（验缓存不重播）。
  它既不执行真实 `ChatSession` 的**首句前**失败恢复，也不提交**新 requestId** 的下一轮。
- `scripts/postlv2-text-stream-verify.py` 的真实模型探针同样**等第一分句之后**才取消，
  验的是前缀保存。
- 本次新门补的正是这个缺口（**首句前**取消 + **新 requestId** 的下一轮）。

---

## 3. 本修复**不**主张什么

- 不主张"取消再也不会丢东西"：取消**不撤销**已提交的账本行（用户事件照旧落账），
  这是既有契约（`TurnCancellationRegistry` 的"受理 ≠ 撤销"）。
- 不主张会话内序号**永远**连续可读：助手序号在"首句前失败"时**本来就是空的**——
  那是事实。本修复保证的是**下一轮的号不跳**，不是给空洞补行。
- 不主张 `DOMException` 那条路径是唯一形态：只实测了这一条。因此第 1.1 条
  （从账本重算）是**兜底**——它不依赖"猜到了哪种失败形态"。
- 不改任何冻结面：未动 `src/kernel/app/memory/**`、已发布迁移、人设 seed、
  `evals/fixtures/m3.5/prompt-baseline.txt`、`docs/苏沐薇-使用说明.txt`；
  **未打开真实库**（本门全程只复制/摘要）。
- 未新增 lane 归属：本门与 `postlv2:goal-deadline:verify` 等一样是**直接脚本**
  （未进 `scripts/gates/manifest.ts` 的 `PL2_GATES` 清单），改动清单属另一件裁定。

---

## 4. 证据与入口

```bash
pnpm postlv2:sequence-continuity:verify   # EXIT 0
pnpm postlv2:text-stream:verify           # 既有门，逐字未改（回归）
pnpm typecheck                            # EXIT 0
```

机器证据：`artifacts/post-lv2/sequence-continuity-verify-20261005/sequence-continuity-verify.json`
（含七个场景的账本逐条读数、trace 原因码、语音包计数；`productionDatabaseOpened: false` ·
`productionTreeUnchanged: true` · `externalModelCalls: 0`）。
（写在 `artifacts/post-lv2/<runId>/` 而**不是** `local/`：`local/` 按 `.gitignore` 是
"完整转录取证、不进仓库"的那一层，而本门的证据只有计数 / 具名码 / 逐条序号，无一句对话正文。）

调查阶段证据（不改写）：`artifacts/post-lv2/local/previous-turn-diagnosis-20261005.json` ·
`sequence-gap-reproduction-20261005.json` · `sequence-gap-reproduction-20261005.log`。
