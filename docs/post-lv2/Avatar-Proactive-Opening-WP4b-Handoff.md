# 皮套入口主动开口 · WP4b 交接单（编排 · 模型调用 · 回复守卫）

```text
WP     : WP4b —— 编排（`runOpeningOpportunity`）+ 模型适配器 + 回复守卫 + 发送前复核
日期   : 2026-10-11
上游   : ADR-131 · WP0 基线 · WP1（契约）· WP3（预检）· WP4a（生成侧契约）
结论   : ADR §8 的 WP4 四项（依据集 / 模型调用 / 回复守卫 / sidecar）**实现层已齐**；
         **装配接线（packet + 落账 + 读数）属 WP5，未开始** ⇒ 仍然没有任何东西会产出它
```

---

## 1. 交付物

| 文件 | 改动 |
|---|---|
| `src/kernel/app/bridge/proactive-opening.ts` | **追加**：`OpeningModelPort` · `OpeningModelResult` · `OpeningRunInput` · `OpeningRunOutcome` · `runOpeningOpportunity()` |
| `src/infrastructure/model/openai-proactive-opening.ts` | **新增**：私有模型调用适配器（照 `openai-proactive-care.ts` 的形状） |
| `artifacts/…/local/avatar-opening-runner-probe.ts` | **新增（gitignored）**：18 项判据，含**调用计数** |

---

## 2. ★ 两处值得单独说的设计

### 2.1 守卫链**只有 `replyText` 是必填** —— 主动开口原样可用

逐行读 `reply-guard-chain.ts`：`ReplyGuardChainInput` 里**唯一必填**的是 `replyText`
（`runReplyGuardChain` 只对它做 `typeof !== 'string'` 的失败关闭，第 163 行）；
其余字段（`memoryWriteResult` / `actionResults` / `externalEvidenceInContext` / …）**全部可选**，
**缺席的含义就是"这一轮没有那件事"**。

⇒ 主动开口**没有轮次**，但守卫链**不需要为它改一个字**：全部域事实缺席 = 她确实没写记忆、
没跑动作、没搜索、没排提醒。**这正好是事实。**

探针里有一条实测读数证明它真的在链上（见 §3.2）。

### 2.2 编排层的最后一步是**调既有仲裁**，不是自己判

第一版我写成了"造候选就返回 `spoken`"，于是留下一个瑕疵：
**它可能返回 `spoken`，而下游 `emitCharacterOutput` 的仲裁随后把它丢掉**（超长时尤其明显）——
`spoken` 这个词就成了谎。

改法不是"在编排层再判一遍长度"（那会变成**两处判同一件事**），而是：

```text
⑨ 造候选 → 直接调 `arbitrateCharacterOutput({ candidate, floor })`
   · speak          ⇒ `spoken`
   · yield/drop     ⇒ `silenced(同一个码)`
```

⇒ 好处有三：
```text
① 长度 / 来源 / 版本 / 话权 **只有一处执行**（`L-QQP-09` 那条纪律）
② `spoken` 这个词**变得可信**（它已经过仲裁）
③ 话权让位也**不需要新写一份** —— `floor` 由装配层按真实读数传入，
   编排层只是把它转交给既有仲裁（探针实测 `user_holds_floor_for_non_urgent_output`）
```

---

## 3. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| **WP4b 探针** | **PASS · 18 项 · 失败 0** | **0** ✓ |
| `pnpm kernel:test` | **27 通过 / 0 失败** | **0** ✓ |
| `pnpm kernel:verify` | **25 通过 / 0 失败** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 289** | **0** ✓ |

### 3.1 ★ 只有靠**计数**才能量到的两条

```text
★ 空依据集 ⇒ `opening_without_evidence`，且模型端口**调用次数 = 0**
  （不是"调了再丢"—— 那才是 S06 的全部意义）
★ 三个失败桶各自 ⇒ 同名拒，且**调用次数 = 1**
  （一次调用就是一次调用：不重试、不降级重问）
```

### 3.2 ★ 守卫真的在链上（实测对照）

```text
模型原文   ：我记住了
守卫之后   ：这轮没有确认新的记录写入成功；不能据此判断之前没有记录。
`guardCorrected` = true
```
⇒ 这是**对照读数**，不是"我 import 了守卫链"。没有它，"过回复守卫"就只是一句设计意图。

### 3.3 其余判据

```text
正控                ：spoken · text=在忙吗？ · refs=2 · cue=natural · deadlineMs=8000 · calls=1
端口抛错            ：归 call_failed（不把异常当"她决定不说话"）
不是 JSON           ：opening_text_not_json
多一个字段          ：opening_text_unknown_field（闭集）
超长（61 字）       ：output_too_long（**既有仲裁**报的）
用户正在说          ：user_holds_floor_for_non_urgent_output（**D07 没被重写一份**）
无版本（0）         ：output_without_revision
没接发送前复核      ：opening_recheck_not_wired（**宁可不发**）
复核后依据变了      ：opening_evidence_changed
复核后依据空了      ：opening_evidence_expired
复核被读了第二次    ：reads=1 且一致 ⇒ spoken（证明它不是摆设）
```

---

## 4. ⚠️ 量具踩坑（诚实记录）

**第一次跑：18 项里 16 项红，且所有计数恒为 0。** 看起来像"编排层完全没有工作"。

真相：**探针自己的假模型端口传错了。** `fakeModel()` 返回 `{ port, calls }`，
而我把**整个对象**当端口传进去 ⇒ `input.model.invoke` 不存在 ⇒ 抛错被编排层吞成
`call_failed`、计数恒 0。

⇒ **量具错了，不是被测系统错了** —— 正是 `ADR-035` 记的那个老形状：
"函数名/意图说 A，代码实际量的是 B，而结果看起来'合理'所以没人查"。
⇒ 修法：把 `calls` **挂在端口自己身上**（端口就是端口）。修完 18/18 绿。

> 这条比"修好了"本身更值得记：**如果编排层没有把异常归成 `call_failed` 而是静默返回，
> 这个量具错误会伪装成"功能不生效"** —— 那正是它吞错的设计初衷
> （"不把异常当'她决定不说话'"）在保护我们。

---

## 5. 本 WP **没有**做的事

```text
· ❌ **没有装配接线**：`src/main.ts` **一个字未改**；没有任何生产代码 import 这两个新模块
· ❌ 没有 packet 收发（`PROACTIVE_OPPORTUNITY` / `OPPORTUNITY_RESULT` 仍只是**常量**）
· ❌ 没有落账 / trace / 交付读数
· ❌ 没有真实模型调用（探针用的是假端口；适配器**从未被真的调过**）
· ❌ 没有正式门 / npm script / Scripts-Catalog（WP6）
· ❌ 没改入口守卫、没动 `.env`、没动 `TD-19`
```

⇒ **编排层与适配器都是"能被调用"的，但没有任何东西在调用它们。**

---

## 6. 下一步：WP5

| 内容 | 说明 |
|---|---|
| **packet 形状与解析** | 外壳 → LG 的 `PROACTIVE_OPPORTUNITY`（只读，不落用户事件）；LG → 外壳的 `OPPORTUNITY_RESULT`（**不含正文**） |
| **装配接线** | 机会受理 → 预检 → 依据集 → 编排 → `emitCharacterOutput`。**会第一次改动 `src/main.ts`** |
| **交付读数** | 分列 `spoken` / `yielded` / `dropped` + `lastCode` + `source`（与既有 `INTERJECTION` 读数同形） |
| **trace** | 机会键、依据 refs、模型调用结果、守卫改写与否（**不含正文**） |

⚠️ **两条必须记住的接线纪律**：
```text
① 改 `src/main.ts` 时，**任何静态文本判据都可能因我的改动而失效**（`L-QQP-09` 的第四次教训）；
   而 `postlv2:qq-proactive:verify` 里已有两条这样的判据**当前是红的**（WP3 交接单 §4.2）。
   ⇒ 动 main.ts 之后必须重跑那道门，并区分"我碰坏的"与"本来就红的"（用外科式 stash）。
② 送出前**不要**再补一次"用户在不在说"：那会让 D07 出现第二处实现。
   `floor` 读数由装配层给一次，编排层转交给仲裁一次。
```
