# 皮套入口主动开口 · WP4a 交接单（生成侧契约）

```text
WP     : WP4a —— **生成侧**：提示词 · 严格解析 · 候选构造 · 表达信封（纯函数，**不调模型**）
日期   : 2026-10-11
上游   : ADR-131 · WP0 基线 · WP1（契约冻结）· WP3（机会预检）
结论   : 生成侧的**契约与纯函数**已实现并自证（28 项判据）；
         **模型调用 / 回复守卫 / 装配接线 = WP4b，未开始**
```

> ⚠️ **WP4 只是部分完成。** ADR §8 的 WP4 是"依据集 + 一次模型调用 + 回复守卫 + sidecar"。
> 本轮做完的是**依据集（复用）**与 **sidecar（信封）**，以及它们两端的纯函数契约；
> **真的去调模型**与**过回复守卫**属 WP4b。**没有任何东西会产出 `proactive_opening`。**

---

## 1. 交付物

| 文件 | 改动 |
|---|---|
| `src/kernel/app/bridge/proactive-opening.ts` | **新增**：`buildOpeningInstruction()` · `buildOpeningEvidence()` · `readOpeningResponse()` · `buildOpeningCandidate()` · `renderOpeningExpressionEnvelope()` · `PROACTIVE_OPENING_CUE` |
| `artifacts/…/local/avatar-opening-generator-probe.ts` | **新增（gitignored）**：28 项判据，含与两个既有消费者的对接 |

### 1.1 ★ 为什么生成侧在 `app/` 而不是 `contracts/`

它要产出 `CharacterOutputCandidate`（定义在 `app/bridge/character-output.ts`）。
若把它放进 `contracts/`，就变成 **`contracts` 反向依赖 `app`** —— 违反本仓库的单向依赖方向
（`kernel:test` 的依赖方向检查守着这条）。⇒ 分层落成：

```text
contracts/proactive-opening.ts   机会预检（只用 contracts；无 app 依赖）
app/bridge/proactive-opening.ts  ← 本文件：生成侧（可依赖 contracts 与同目录）
```

---

## 2. ★ 三处刻意的"不重复实现"（`L-QQP-09` 那条纪律）

| # | 做法 | 为什么（不这么做会怎样） |
|---|---|---|
| ① | 上限**从契约派生**：提示词里的句数/字数直接引 `CHARACTER_OUTPUT_LIMITS` | 写两份数字**迟早漂移**；探针专门断言二者同源 |
| ② | 解析器**只判形状**，长度/来源/版本**不在这里判** | 长度判据**只有一处**（`arbitrateCharacterOutput`）。若解析器也判一遍，就变成两处判同一件事；而且"太长"会从**读数**（`output_too_long`）退化成**解析失败**——那是**量具口径的降级** |
| ③ | 依据集**不自己拼**：直接复用 ADR-111 的 `boundProactiveSources` / `renderSystemOpportunitySection` | 后者"空集 ⇒ `undefined`"就是 `S06` 的失败关闭；自己再写一遍就多一处"没有依据时会发生什么" |

### 2.1 由 ② 引出的一个**反直觉**设计（值得记）

```text
超长文本在**解析器**里是"形状合法"的；
它会在**仲裁**那里被丢掉，并留下具名读数 `output_too_long`。
```
⇒ 这是**故意的**：我们要的是"她被拦下了，理由是可读的"，不是"解析失败所以什么都没记"。
探针里专门有一条断言这条性质（"解析器不判长度"）。

---

## 3. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| **WP4a 探针** | **PASS · 28 项 · 失败 0** | **0** ✓ |
| `pnpm kernel:test` | **27 通过 / 0 失败** | **0** ✓ |
| `pnpm kernel:verify` | **25 通过 / 0 失败** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 289** | **0** ✓ |

### 3.1 ★ 探针的重点是**对接**，不是"我写了几个函数"

三组**集成**判据 —— 生成侧的输出**真的**经过两个**既有**消费者：

```text
出站仲裁（`arbitrateCharacterOutput`，既有）：
  · 生成侧候选 ⇒ speak(proactive_opening)，yieldFloor=true
  · 用户正在说 ⇒ user_holds_floor_for_non_urgent_output（**D07 不另写一份判据**）
  · 来源为空 ⇒ output_without_source（不补默认来源）
  · 超长 ⇒ output_too_long（程序不截断）
  · 无版本 ⇒ output_without_revision

表达解码（`decodeExpressiveSpeech`，既有）：
  · 信封被接受、正文**逐字往返**、cue = 程序既定值
  · ★ 负控：正文为空的信封被解码器**拒绝**（`expression_invalid_envelope`）

依据面（ADR-111，既有）：
  · 空集 ⇒ section=undefined 且 refs 为空
  · 去重 / 去空 / 最多 8 条 / 摘要按**码点**截到 120
```

⇒ 这三组证明的是：**新增的这条通道没有自造规则**，它复用的正是既有那两条链。

### 3.2 解析器的十条形状判据

合法 `{text}` / trim / `null` / 数组 / 数字 / **多一个字段** / 缺 `text` / `text` 非字符串 /
空串 / 全空白 —— 十种各自给出具名码（`opening_text_*` 五种，覆盖全部十条的判据面）。

---

## 4. 本 WP **没有**做的事

```text
· ❌ **没有调模型**（`buildOpeningInstruction` 只是造提示词；没有任何 invoke）
· ❌ 没有模型适配器（`infrastructure/model/openai-proactive-*.ts` 未动）
· ❌ **没有过回复守卫**（`runReplyGuardChain` 未接）
· ❌ 没有装配接线：**`src/main.ts` 一个字未改**，没有生产代码 import 本模块
· ❌ 没有 packet 收发、没有 `OPPORTUNITY_RESULT` 回执
· ❌ 没有落账 / trace / 交付读数
· ❌ 没有正式门、没有 npm script、没有改 Scripts-Catalog（WP6）
· ❌ 没改入口守卫、没动 `.env`、没动 `TD-19`
```

⇒ **`proactive_opening` 仍然只是一个"能被造出来"的对象，没有任何东西会去造它。**

---

## 5. 下一步：WP4b

| 内容 | 说明 |
|---|---|
| **模型适配器** | 与 `openai-proactive-care.ts` 同一档的私有调用；期限用 `policy.openingDeadlineMs`（8000ms，**不是** care 的 15000ms）；**一次调用就是一次调用**（不重试、不降级重问） |
| **回复守卫** | 生成结果必须过 `runReplyGuardChain`（ADR-131 `D04`）；未过 ⇒ 整条不发（不修补） |
| **双次核对** | 生成前与发送前各核对一次依据面（ADR-111 `S04`）；失效 ⇒ 整条作废 |
| **接线** | 机会报文 → 预检 → 依据集 → 模型 → 守卫 → `emitCharacterOutput` → 外壳 |

⚠️ WP4b 会**第一次改动 `src/main.ts`**。在混合树上动装配根需要格外小心：
按 `L-QQP-09` 的教训，**任何静态文本判据都可能因为我的改动而失效** ——
而 `postlv2:qq-proactive:verify` 里已经有两条这样的判据**当前是红的**（见 WP3 交接单 §4.2）。
