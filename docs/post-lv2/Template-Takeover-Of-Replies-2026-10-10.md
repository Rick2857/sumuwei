# 模板接管回复位的两种形态（2026-10-10 QQ 实测）

用户报"这几轮回复很奇怪"，逐字如下（QQ 私聊）：

```text
张Amy 17:22:01  记得在5:55提醒我去抢课,不要管我有没有回复收到
苏沐薇 17:22:22  当前提醒投递未开启，尚未设置可发送的提醒。
张Amy 17:23:00  什么意思？
苏沐薇 17:23:06  收到，记忆请求会在这轮回复后处理；现在还没有完成。
```

读回（只读副本 `scripts/model-stream-length-readback.ts`）：这两轮 **`调模型 = true`**、
trace `completed`、`error=(无)` ⇒ **模型被调了，它的话被程序覆盖**。

## 一、提醒被拒：**入口差异**，不是激活失效

判据（`src/main.ts:4213`）：

```ts
enabled: this.flags.qqProactiveMode === 'on'
      && this.flags.entryScopedConversations
      && reminderRefreshHook !== undefined
```

第三个条件才是关键：`reminderRefreshHook` **只在那条"起提醒 timer + 定时器 drain + 入口连接"的
分支里被赋值**（`main.ts:454`，随 `stop()` 置回 `undefined`，见 `main.ts:461`）——
即 **coexist 共用核心**那条入口。

⚠️ 用户当时跑的是 **`src/main.ts --bridge --qq-private`**（旧的 QQ 桥入口，实测进程命令行），
那条入口**没有装这个 timer** ⇒ `enabled=false` ⇒ `reminder-turn.ts:93` 返回
`{kind:'refused', code:'reminder_delivery_unavailable'}`，并把那句模板**当作整轮回复**发出去。

⇒ 这正是 **ADR-124 `D2` 的字面行为**（"当前运行方式没有的出口返回未配置，不静默改投"）。
**跨入口延时提醒的生产激活是对 coexist 入口成立的**；换回 coexist 入口（QQ 6751 + 入口令牌）
就能投递。**不是激活失效，也不是这次改动引入的。**

## 二、记忆模板答非所问：**分类过宽 + 模板覆盖回复**（真缺陷候选）

链条（都是行号级事实）：

```text
.env: CHARACTER_MEMORY_WRITE_MODE=post_turn_model
  ⇒ src/infrastructure/runtime/post-turn-model-memory.ts:48
     handleTurn() 恒返回 { kind:'not_written', intent:'remember', reason:'pending_post_turn' }
     （写库发生在轮末 ⇒ 这一轮必然"还没写完"）
  ⇒ src/kernel/app/memory/response-truth.ts:173
     const claim = result.reason === 'pending_post_turn' && !replyText.includes('记忆')
  ⇒ response-truth.ts:125
     回复被替换为"收到，记忆请求会在这轮回复后处理；现在还没有完成。"
```

⇒ 只要**某一轮被判成"显式记忆指令"**，而模型回复里没有"记忆"两个字，**整轮回复就被这句替换**。
于是"什么意思？"这种**追问**一旦被算成记忆请求，就会得到答非所问的模板。

**未坐实的部分（如实记）**：我**没有**读到那一轮的分类读数，
所以"追问句被判成 remember"目前是**推断**（最可能的原因：分类器把**最近几行**纳入上下文，
而上一行正是"记得在5:55提醒我…"）。要坐实只需打印该轮的 `memory_explicit_write` 判定输入/结果。

**为什么它"感觉很奇怪"（两条共同的设计代价）**：
这两句都是**程序生成的模板**，因此没有称呼、没有语气、不看上下文 —— 精确、可审计，
但**不像她**。这是「回复绑定程序事实」（不许她提前说"我记住了"）与「没有出口就如实拒绝」
这两条纪律的既定代价。

## 未做

```text
① 坐实"追问句被算成记忆请求"（打印该轮分类输入/结果）—— 一步只读
② 若坐实：让待办记忆的 truth 行**只**作用于发起请求的那一轮（或至少不覆盖追问句）
③ 是否给 bridge 入口也装 reminder timer：**不建议**（与 ADR-109 的入口维度会话重复），
   正解是用 coexist 入口
```
