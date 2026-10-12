# 皮套入口主动开口 · WP5b-1 交接单（接线侦察 + 注入线 + 签名修正）

```text
WP     : WP5b-1 —— transport 注入线已接 · 端口签名修正 · **接线所需的每一个读数都已定位**
日期   : 2026-10-11
上游   : ADR-131 · WP5a（桥侧接缝）· WP5b-0（机会状态）
结论   : 接线**只差 `main.ts` 里的那一段实现**（下一轮）；本轮把它的每个前置都查实了
```

---

## 1. 本轮的改动

| 文件 | 改动 |
|---|---|
| `src/infrastructure/bridge/turn-bridge-transport.ts` | **+2 处**：options 加 `openingOpportunity?` · 注入行 `if (options.openingOpportunity !== undefined) host.openingOpportunity = ...`（照 398-400 既有模式） |
| `src/kernel/app/bridge/turn-bridge.ts` | 端口签名修正（+3 个**桥侧**读数）· 新增两个只读访问器 `outputCapable` / `submittedTurnRevision` |

## 2. ★ 修正的那处错（已登记为 `L-APO-09`）

WP5a 定的 `openingOpportunity?({requestId, entry, idleMs})` **实现不了** —— 它缺三个
**只有桥才有**的读数，而它们在 `main.ts` 那侧**拿不到**（都是私有状态）：

```text
userSpeaking      ← 由 `submittedTurns` 推断（VAD 在 Python 外壳里，LG 侧没有独立读数）
turnRevision      ← 同上；且**必须** ≥ `floor.userRevision`，否则立刻被判过期
hasLiveClient     ← `outputSink` 是桥的**私有**字段
```

⇒ 若没发现，装配层只能去**猜**"谁在说话"与"有没有人在听" ⇒ 那就是 `D07` 的
**第二次实现**，外加"生成完才发现没人听"的白白一次模型调用。

**修法**：端口改成 **桥喂自己的读数、装配层喂世界读数**。

---

## 3. ★★ 下一轮照这张表做就行（每个读数都已定位）

| 端口需要什么 | 从哪来 | 现状 |
|---|---|---|
| `db` | `input.db` | 在作用域 ✓ |
| `characterId` | `input.session.characterId`（`main.ts:3731` 的 getter；`turn-bridge-transport.ts:274` 已在用） | ✓ |
| `policy` | `readProactivePolicy(process.env)` —— **在 handler 内部读**（关心那条线的先例：`main.ts:6222`） | ✓ |
| `flags` | `readKernelFlags()` —— 同上，**没有模块级 `flags` 常量**，handler 内读 | ✓ |
| `paused` | `readControl(db, characterId)` → `.paused === true` | ✓（关心线已在用） |
| `entryScopedConversations` | `flags.entryScopedConversations` | ✓ |
| `candidateInFlight` | `hasInFlightOccurrence(db, characterId)` | ✓（关心线已在用） |
| `allUsedToday` | `countQuotaUsage(db, {characterId, dayStart, dayEnd})`（**不传 kind** ⇒ 全类）+ `zonedDayWindow(now, policy.timeZone)` | ✓（关心线已在用） |
| 冷却 / 日额度 / 幂等 | `openingPrecheckInputs({state, now, policy, allUsedToday})`（WP5b-0） | ✓ |
| `evidenceCount` / 依据集 | `buildProactiveSourceCandidates(db, {characterId})` → `.candidates` | ✓（工厂已存在，`proactive-sources.ts:69`） |
| `sheIsSpeaking` / `hasLiveClient` / `floor` / `turnRevision` | **桥自己喂**（本轮已落地） | ✓ |
| 出站 | `bridge.emitCharacterOutput({candidate, floor, expression})` | ✓（public，`turn-bridge.ts:1139`） |
| 挂载点 | `const bridge = new TurnBridge({ host })`（`main.ts:5973`）之后覆写 `host.openingOpportunity` | ✓（与 `host.runTurn` 覆写同一手法，`:5972`） |

### 3.1 ★ 两处新发现（下一轮会踩）

```text
① `emitCharacterOutput` 要的是**结构化** `SpeechExpression`
   （`{version, replyId, segments:[{segmentId, text, cue}]}`），
   **不是** WP4a 里那个 `<lg-speech>…</lg-speech>` **字符串信封**。
   ⇒ 信封那个渲染器是给**外壳/传输**用的；装配层要用 `bindSpeechExpression(replyId, draft)`。
   ⇒ 这一条是 WP4a 的一处**用途澄清**（渲染器本身没错，是"谁用哪个"要分清）。

② `setOutputSink` 对**皮套入口也是接的**（走 `localDelivery`，`main.ts:5985`）——
   ⚠️ 前提是 `qqDelivery !== undefined`（即 `CHARACTER_QQ_PROACTIVE_MODE !== 'off'`）。
   若 QQ 主动模式关着，皮套侧**没有**出站通道 ⇒ 预检会以 `opening_no_live_client` 拒。
   ⇒ 这是一条**真实的耦合**：皮套的主动开口依赖 QQ 主动模式开着（因为出站口是同一条注入）。
      已登记，下一轮接线后要用读数确认它。
```

---

## 4. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 290** | **0** ✓ |
| `pnpm postlv2:transport:verify` | **PASS · measured_count 78** | **0** ✓ |
| `pnpm kernel:test` | **27 通过 / 0 失败** | **0** ✓ |
| `pnpm kernel:verify` | **25 通过 / 0 失败** | **0** ✓ |

⇒ `transport:verify` 是**专门为这次改动跑的**（我动了那个文件），PASS 且计数未变。

---

## 5. 本 WP **没有**做的事

```text
· ❌ **`src/main.ts` 仍未改** —— 端口实现（第 3 节那张表）是下一轮
· ❌ 外壳未改 ⇒ **仍然没有任何东西会发这条报文**
· ❌ 没有真实模型调用 · 没有落账 / trace / 交付读数
· ❌ 没有正式门 / npm script（WP6）
```

⇒ 与 WP5b-0 结束时相比，多了一根**已铺好的线**（transport → host），但**两端仍没人拉**。
