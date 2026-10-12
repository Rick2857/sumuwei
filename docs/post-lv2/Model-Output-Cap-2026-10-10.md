# 主回复输出上限与 `model_stream_finish_length`（2026-10-10）

## 事故（逐字）

```text
2026-10-10 00:38:33  用户（皮套入口）："好的试一下清空回收站"
                      [turn-content] 候选 5 份 → 入轮 4 份
                      [assembly] compileTurn 合计 6186ms
00:39:36             [bridge] 轮次失败 code=model_stream_finish_length
                     lg-speech-stream-failed ⇒ postlv2_vtuber_runtime.py:1196
                     RuntimeError: LG rejected or failed: model_stream_finish_length
                     ⇒ 对话链断开（用户看到的是"崩了"）
```

## 报错链（每一跳都有位置）

```text
① 上游 SSE 以 finish_reason="length" 结束（生成被 max_tokens 截断）
② src/providers/chat-stream.ts:28-31   非 stop ⇒ ChatStreamError('model_stream_finish_length')
③ 整轮失败（**设计如此**：宁可不说，也不说半句 —— 有专门断言：
   scripts/postlv2-sequence-continuity-verify.ts:361）
④ 皮套收到 lg-speech-stream-failed ⇒ Python 外壳抛 RuntimeError ⇒ 链路结束
```

## 只读读回（2026-10-10，副本模式；真库从未打开）

读法：`scripts/model-stream-length-readback.ts`（`cpSync` 真库到 %TEMP%，只开副本，
`rows()` 拒绝一切非 SELECT —— 照 `diagnose-repeat-reply.ts` 的 `--copy` 先例）。

```text
① 失败那一轮：trc:d5801aa1-eb2f-456d-8a75-60b8f43f9839
   status=failed · error=model_stream_finish_length · steps=25
   **最后一个 step 是 memory_recall** ⇒ **没有 model_generate / model_call 步**
② 对话账：#886 c43 user（清空回收站）→ #890 c44 user（下一条）
   **中间没有任何 assistant_message** ⇒ 那一轮**零可见产出**（不是"说了半句"）
③ token 读数：trace 里 "token" 出现 10 次 —— **逐条核过，全是预算字段**
   （estimatedTokens:6275 · budget_tokens:300 · budgetTokens:800 · memoryTokens:0 ·
     reservedTokens:0 · totalTokens:0 · selectedTokens:0）；
   **"reasoning" 出现 0 次** ⇒ **没有任何 usage**（completion / reasoning 都不存在）
```

## 结论：**"思维链吃光预算"是最可能的解释，但未被坐实**

```text
支持它  ：上游以 length 结束 + 零可见产出 + 同型读数先例（M5.5.1 R2：
          completionTokens=800 · reasoningTokens=800 · contentKind=missing）
反驳不了：另一种可能是"她在 <lg-speech> 里写了很多但始终没成形就被截断" ——
          **同样表现为零产出** ⇒ 现有读数无法区分这两者，而修法不同
⇒ 要坐实必须**先装仪表**
```

### 缺口（本轮真正的发现）

`usage` 只有两个**私有**调用在解析（`affect-semantic-provider.ts:236-238`、
`openai-search-need-judge.ts:139-140`）。**主回复流完全没有计量**：`readChatStream` 只累加
`delta.content`，既不解析 `usage`，请求里也没有 `stream_options: { include_usage: true }`
（`openai-compatible.ts:171` 那处 usage 日志在**非流式**分支上）。
⇒ 主回复链**从建立起就没有 token 读数**，失败那一轮尤其什么都没有。

## 本次处置 = **A 档（先把眼下堵住）**

```text
新开关  CHARACTER_REPLY_MAX_TOKENS     代码缺省 4096（= 与改动前逐字相同）· 范围 512…16384
接线    src/main.ts 主回复那一次 callModelText(..., { maxTokens: flags.replyMaxTokens })
        ⚠️ 只影响主回复；私有调用（判据 2400 / 规划 8000 / 决策）各有自己的常量
.env    已设 8192（回滚 = 删那一行 ⇒ 逐字回到 4096）
```

⚠️ **A 档明确不主张的**：
- 不主张"额度够用了"——只是**把撞顶推远**，长回复仍可能撞到 8192；
- 不主张已坐实根因（见上）；
- **没有**补 token 计量。

## 仍未做（按建议顺序）

```text
① 给主回复流补 usage 采集 —— **已做（2026-10-10，本轮）**，但读数落在**日志**、**尚未进 trace**：
   请求带 `stream_options: { include_usage: true }`（`openai-compatible.ts`，仅流式）；
   `readChatStream` 解析最后一个 usage chunk（`prompt_tokens` / `completion_tokens` /
   `completion_tokens_details.reasoning_tokens`，不可得记 null、**不伪装成 0**）；
   **非 stop 的终态改成"先记下、读完整条流再抛"**，并把 usage 与 `streamedChars`
   挂在 `ChatStreamError` 上 ⇒ **失败那一轮也有数字**（这正是本次事故缺的）。
   落点两行：成功 `[model] tokens(stream): prompt=… completion=… reasoning=…`；
   失败 `[model] stream failed code=… streamedChars=… prompt=… completion=… reasoning=…`。
   ⚠️ 判据形态：思维链吃光 ⇒ `completion ≈ max_tokens` 且 `reasoning` 占绝大部分；
      正文太长 ⇒ `reasoning` 很小而 `streamedChars` 很大。
   ⚠️ **仍未进 trace**：trace 的那一步（`model_generate`）今天不携带 usage ——
      要进 trace 需要把 usage 从 provider 一路带到 turn gateway 的 step 写入点（下一步）。
② 用 ① 的读数复现一次，再决定 B 档（推理档位）或 C 档（对 length 做受控降级）
③ 皮套侧：失败现在会抛 RuntimeError 打断对话链；按"如实降级"惯例更合适的是
   如实播报这次失败并保链路活着（需写进局限）
④ ⚠️ **观察到的偶发**：`pnpm postlv2:sequence-continuity:verify` 在改动后**第一次 EXIT 1、
   紧接着重跑 EXIT 0**（两次输出均含"首句前失败之后会话不跳号"场景）。
   我没有复现出稳定的失败形态 ⇒ 如实记为**未归因的偶发**，不要拿第一次的读数当结论。
```
