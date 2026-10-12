# S8 · WP5 交接单（反思触发 · 有限采纳 · 实际入模）

状态：**实现完成 · 门 PASS**。日期：2026-10-03。工作包：`POSTLV2-S8`。
载体：[ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md) `D10`/`D11`（+ §10.2 `R-10`）· [验收契约](S8-Acceptance-Contract.md)。

| 项目 | 读数 |
|---|---|
| 门 | `pnpm postlv2:s8:reflection:verify` |
| 判定 | **PASS** · `measured_count = 26` · R1–R7 |
| 机器证据 | `artifacts/post-lv2/<runId>/s8-reflection-verify.json` |
| 模型调用 | **0**（provider 是离线固定件，与 M11.1 各门同口径）；`data/pglite` 从未被打开 |

---

## 1. 交付物

| 文件 | 改了什么 |
|---|---|
| `src/kernel/contracts/reflection-input.ts` | `REFLECTION_TRIGGER_KINDS` **追加** `story_outcome` + `REFLECTION_TRIGGER_FACTS` 具名登记（并写明它**不**推翻 `user_feedback.v1Detectable = false`） |
| `src/kernel/app/reflection/inputs.ts` | `BuildReflectionInputOptions.storyOutcomes`（调用方从世界账本读出）；故事结果 ⇒ `story_outcome` 触发 + `story_event` 窗口条目（`sourceClass = story_experience`）+ handle；**修掉一个静默缺口**（只有故事结果时会提前 `return undefined`） |
| `src/kernel/app/reflection/lineage.ts` | 合并故事根与对话根时：`id`/`depth` 取对话侧、`sourceClass` 取故事侧（`R-10`） |
| `scripts/postlv2-s8-reflection-verify.ts`（新） | 门本体（R1–R7，含诊断行） |
| `package.json` | 注册 `postlv2:s8:reflection:verify` |

## 2. 退出条件逐条对账（计划书 WP5）

| 计划书退出条件 | 机器判据 | 读数 |
|---|---|---|
| 通过**真实入口**完成「3 独立根 + 2 真实会话 → 非零已接受反思 → 合法槽位更新 → 实际入模」 | `R4` `R5` `R6` | `runReflectionWindow` **accepted**（`rootCount=3` / `conversationCount=2`，由程序算）→ `clarify_when_ambiguous` 变 `enhanced`（revision 1，且**只有**这一个槽）→ `adaptiveSelfTokens=300` 时 `adaptive-self` section = 1 且来源 `adaptive-self:clarify_when_ambiguous@1` |
| 故事结果**可达触发**（`D10`） | `R1` | 每条已提交故事结果 ⇒ 恰好一个 `story_outcome` 触发；窗口条目来源类 `story_experience`；handle 含该提交 |
| 不得在正式正控中手填 accepted / 伪造来源计数 / 绕过 validator | `R7` | 同一真实入口、**2 根**材料 ⇒ **拒收**；门里没有任何"填 accepted"的路径 |
| 2 根 / 1 会话 / 有冲突均**明确拒收** | `R3` `R7` | `threshold_not_met`（2 根）/ `conflicting_support`（有冲突）/ 真实链拒不采纳（2 根材料） |
| 开关关闭或 token 裁剪能**如实显示未入模** | `R6` | `adaptiveSelfTokens=0` ⇒ `adaptive-self` section = **0**（不是"渲染了空块"） |
| 窗口有界、不假装看全 | `R1` `R2` | 无触发（且无故事结果）⇒ `undefined`，**不调模型** |
| （非零分母） | 全部 | `measured_count = 26` |

## 3. 本 WP 发现的缺陷（已修 + 登记）

1. **`buildReflectionInput` 的提前返回**：只有故事结果、没有领域事件触发时直接 `return undefined`
   ⇒ "故事经历永远无法触发反思"会**静默成立**。已修（触发条件改为"任一来源有触发"）。
2. **根 id 取错侧（`R-10`）**：合并故事根/对话根时把 `id` 也取了故事侧 ⇒ 根 id 是提交身份，
   而 M11 的只读面按根 id 反查 `conversation_events`（actor / 序号 / 归因）⇒ 查不到 ⇒
   `readReflectionSourceSnapshot.usable = false` ⇒ **"故事 → 反思"整段不通**。
   ✅ 抓到它的方式是门里的**诊断行**（`[diag]` 打印追根结果）：它显示追根器本身是 3 根/2 会话、
   零拒收，而 R4 却是 `rejected: 来源当前不可用` —— 两行一比，断点立刻定位在**只读面而不是追根器**。
3. **门自己的夹具缺陷**：R7 的"2 根材料"里，触发事件的 `sourceConversationEventIds` 带了 3 个 anchor
   ⇒ 经对话侧凑出 3 个根 ⇒ R7 读到 `accepted`（假绿）。已把"带哪些对话来源"变成用例参数。

## 4. 本 WP **不**覆盖的面（不许读成已实现）

| 项 | 归属 |
|---|---|
| **独立故事水位**与"每个提交对每个消费者**至多一次**已提交影响" | **WP6**（`postlv2:s8:lifecycle:verify`） |
| 撤回后的**读时屏蔽**（`withdrawn` 恒 `false`） | **WP6**（`L-S8-09`） |
| 真模型语义评测与 S8-A/B/C 行为对照 | **WP7** |
| 生产装配（`src/main.ts` 真的消费故事认知开关） | **WP6/WP8**（`CHARACTER_STORY_COGNITION_ENABLED` 尚未落地） |

## 5. 本交接单**不**主张什么

- **不**主张 S8 已可用：本门证明的是"**离线固定 provider** 下的完整链走得通"，
  不是"她在真实聊天里会因此改变行为"（那是 WP7 的 S8-A/B/C）。
- **不**主张 `story_outcome` 会替代 `user_feedback`：后者 `v1Detectable` 仍是 `false`（ADR-093 §0.3）。
- **不**主张水位/至多一次已经成立（见 §4）。

⏩ 后续修订（2026-10-04）：`L-S8-09` 已关闭 —— 原 `:54`「撤回后的读时屏蔽（`withdrawn` 恒 `false`）⇒ WP6（`L-S8-09`）」与 §5 的「不主张」已过时：读时屏蔽早已落地，用户入口已实现并验证（`a56af48e` + `83c15094` + `576ed4f7`；`pnpm story:withdraw`，`package.json`、`src/main.ts:4353`；门 `postlv2:s8:withdraw:verify` PASS 13）。原判定保留。
