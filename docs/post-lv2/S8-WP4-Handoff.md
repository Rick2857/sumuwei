# S8 · WP4 交接单（接通 Affect 与 Relationship 的故事输入）

状态：**实现完成 · 门 PASS**。日期：2026-10-03。工作包：`POSTLV2-S8`。
载体：[ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md) `D08`/`D09` · [验收契约](S8-Acceptance-Contract.md)。

| 项目 | 读数 |
|---|---|
| 门 | `pnpm postlv2:s8:state:verify` |
| 判定 | **PASS** · `measured_count = 26` · V1–V9 |
| 机器证据 | `artifacts/post-lv2/<runId>/s8-state-verify.json`（按 `source.head` 归属） |
| 隔离 / 出网 | `isolateDatabase()` 一次性沙箱；**零模型调用、零出网**；`data/pglite` 从未被打开 |

---

## 1. 交付物

| 文件 | 是什么 |
|---|---|
| `src/kernel/contracts/story-appraisal.ts`（新） | 两张**封闭、版本化、纯函数**规则表：`story-appraisal@1`（6 条情绪规则）与 `story-relationship@1`（5 条关系规则）+ `storyAppraisalOf` / `storyRelationshipAppraisalOf` + 自检 |
| `src/kernel/contracts/affect.ts` | `AffectOriginKind` **追加** `STORY_DERIVED`；`originKindAcceptedByM8` 接受它（旧值语义不变） |
| `src/kernel/contracts/relationship.ts` | `RelationshipOriginKind` **追加** `STORY_DERIVED`；`RelationshipImpactPayload` 增加**可选** `ruleVersion`（缺省 ⇒ 旧规则集，行为逐字不变） |
| `src/kernel/app/storyline/state-evaluators.ts`（新） | 账本行 → 契约层评价输入的**唯一翻译点**；`buildStoryAffectProposals` / `buildStoryRelationshipProposals`（只提案、不落库） |
| `src/kernel/policies/affect-validator.ts` | 放行口按 `ruleVersion` **选表**：`story-appraisal@1` ⇒ ruleId ∈ 故事表 + `originKind=STORY_DERIVED` + delta **精确一致** |
| `src/kernel/policies/relationship-validator.ts` | 同上（`story-relationship@1`）+ **反向闸**：声明 `STORY_DERIVED` 却不带故事版本 ⇒ 拒收 |
| `scripts/postlv2-s8-state-verify.ts`（新） | 门本体（V1–V9） |
| `package.json` | 注册 `postlv2:s8:state:verify` |

## 2. 退出条件逐条对账（计划书 WP4）

| 计划书退出条件 | 机器判据 | 读数 |
|---|---|---|
| 合法实际合作能产生**预期的非零**情绪/关系更新 | `V1` `V2` `V7` | 真实账本 4 条提交 ⇒ 3 TOUCH + 1 IMPACT（非零）；放行口**接受** 4 条（TOUCH 3 / IMPACT 1），零拒收；关系提案 1 条被接受 |
| 提案**可追到原始故事根** | `V1` | 每条提案的 `sourceStoryRefs[].sourceId` 都指回**真实提交身份**；`sourceEventId` = 真实触发对话事件（`R-2`） |
| 隐藏作者设定 / NPC 评价冒充用户 ⇒ 零额外影响 | `V6` | `system` 提交 ⇒ 资格 `story_feedback_not_real_interaction`，情绪与关系提案**都是 0** |
| 重复提交零额外影响 | `V8` | 关系幂等单元 = **提交身份**（既非 `messages-*` 也非 `days-*`）⇒ 同一提交易撞键 |
| 既有范围、单次 delta、对话规则及 cutover 回归通过 | `V9` `V3` `V4` `V5` | 规则表自检通过；每条情绪 delta 在 `MAX_AFFECT_DELTA_PER_EVENT` 内、每条关系增量在**既有**上限内；放行口的故事分支逐条具名拒收 |

### 2.1 过程中修掉的三处缺陷（都留在门与代码的注释里）

1. **故事关系增量第一版超出既有上限**（`trust 0.06 / closeness 0.06` > 既有 `0.05 / 0.03`）
   ⇒ 那会让"故事来源"变成关系增量的**后门**。改成落在既有上限内，并让自检**直接调**
   `relationshipDeltaWithinBounds`（放宽在构造期就不可能）。
2. **放行口的版本链缺故事分支**：选表判完之后又落回 `else` ⇒ 合法提案被判
   `affect_rule_version_mismatch`（而且那条消息里**列着** `story-appraisal@1` —— 
   自己打自己的脸）。已补显式分支。
3. **门的证据读数缺 `axisBConfirmed`** ⇒ 全部判 `UNCONFIRMED_ORIGIN`。
   这是"放行口而不是 evaluator 才是判据归属处"的现场证据：evaluator 全绿，
   放行口一条都不放。

## 3. 本 WP **不**覆盖的面（不许读成已实现）

| 项 | 归属 |
|---|---|
| 故事提案进入**真实调度与水位**（什么时候跑、跑几次） | **WP5 / WP6** |
| 裁剪后**实际入模**（ContextCompiler） | **WP5** |
| 撤回后的读时屏蔽（`withdrawn` 恒 `false`） | **WP6**（`L-S8-09`） |
| 跨 run / 跨用户的**独立**拒收码 | `L-S8-10`（WP4 已把参与者绑定落到 `interaction_ref`，但独立码仍缺） |
| 真模型语义评测与行为对照 | **WP7** |

`postlv2:s8:state:verify` 的证据里有 `notCovered` 数组把这些**逐条写明**，不许靠叙述省略。

## 4. 本交接单**不**主张什么

- **不**主张 S8 已可用：故事经历能产生**提案**，但还没有任何调度把它接进真实轮次或上下文。
- **不**主张 NPC / 作者设定能被语义识别：本 WP 的判据是**程序事实**（`interaction_kind`），
  不是"读台词判断这是不是 NPC 说的"—— 后者需要新的量具，本工作包不做。
- **不**主张数值经过标定：它们是**工程判断**（残余 `L-S8-03`）。

⏩ 后续修订（2026-10-04）：原 `:56`「撤回后的读时屏蔽（`withdrawn` 恒 `false`）⇒ WP6（`L-S8-09`）」已过时 —— `withdrawn` 的读时判定早已落地（`story-cognition.ts` 消费端判 `source_retracted`），`L-S8-09` 的**用户入口**也已关闭（`a56af48e` + `83c15094` + `576ed4f7`；`pnpm story:withdraw`，`src/main.ts:4353`）。原判定保留。
