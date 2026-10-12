/**
 * M10 WP4 —— **目标语义理解语料**（计划 §15.2 · 契约 §8）。
 *
 * ============================================================================
 *  设计（这就是 `U-10` 要求写出来的"语料怎么造"）
 * ============================================================================
 * ```text
 * 单位        一条"场景" = 一句用户原话 + 一个**金标操作**
 * 家族 family 同一意图的**改述组**（同金标）；**拆分的最小单位是家族** ⇒
 *             一个家族整体进 dev / val / test 之一 ⇒ 改述不可能跨 split 泄漏
 * 六层        ① 明确操作 ② 否定/引用/假设 ③ 承诺与假兑现 ④ 依赖变化
 *             ⑤ 多目标歧义 ⑥ 无关对话
 * 规模        dev 100 / val 60 / test 140 = 300
 * 硬下界      test 每层 ≥20；高风险层（③承诺与假兑现）≥30
 * ```
 *
 * ⚠️ **它是"规格"，不是"模型考试题"**：金标是**程序应当怎么理解**的规格，
 *    用来驱动**离线固定 provider** 的门（`m10:source:verify`）。
 *    真实模型在这一套上的表现属 **WP10**（`m10:semantic:eval`，需要真模型与
 *    `.env.test` 端点预检 `U-02`）。**不得**把本文件的读数当成模型质量读数。
 *
 * ⚠️ 纯数据 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟。
 */

import {
  GOAL_PROPOSAL_OPERATIONS,
  type GoalProposalCancelKind,
  type GoalProposalOperation,
} from '../../src/kernel/contracts/goal-proposal.ts'

export type GoalCorpusLayer =
  | 'explicit_operation'
  | 'negation_reference_hypothesis'
  | 'commitment_and_false_fulfillment'
  | 'dependency_change'
  | 'multi_goal_ambiguity'
  | 'unrelated'

export const GOAL_CORPUS_LAYERS: readonly GoalCorpusLayer[] = [
  'explicit_operation',
  'negation_reference_hypothesis',
  'commitment_and_false_fulfillment',
  'dependency_change',
  'multi_goal_ambiguity',
  'unrelated',
]

/** 高风险层（契约 §8：test 里这一类不得少于 30 条） */
export const GOAL_CORPUS_HIGH_RISK_LAYERS: readonly GoalCorpusLayer[] = [
  'commitment_and_false_fulfillment',
]

export type GoalCorpusSplit = 'dev' | 'val' | 'test'

/** 金标：程序**应当**得出的操作（可能带取消细分的原因） */
export interface GoalCorpusGold {
  readonly operation: GoalProposalOperation
  readonly cancelKind?: GoalProposalCancelKind
  /** 承诺类的 `criterion`（只有 `create` 且是承诺时才有） */
  readonly commitmentCriterion?: 'conversation_output_item_count_3'
  /** 人工可读的一句话说明（**不进模型输入**） */
  readonly note?: string
}

interface GoalCorpusFamily {
  readonly familyId: string
  readonly layer: GoalCorpusLayer
  readonly split: GoalCorpusSplit
  readonly gold: GoalCorpusGold
  /**
   * **上文（状态）** —— 金标是 `(状态, 原话)` 的函数，所以状态必须随题给出。
   * 见 `FAMILY_CONTEXT` 的写法纪律（只写系统当时知道什么，**不评价这句话本身**）。
   */
  readonly context: string
  /**
   * **结构化候选目标** —— 真模型那条链（`GoalUnderstandingInput.candidates`）的输入。
   * ⚠️ 每个 `statement` 必须**逐字出现在** `context` 里（`m10:source:verify` 的 `A9` 守着）。
   */
  readonly candidates: readonly GoalCorpusCandidate[]
  readonly variants: readonly string[]
}

export interface GoalCorpusItem {
  readonly caseId: string
  readonly familyId: string
  readonly split: GoalCorpusSplit
  readonly layer: GoalCorpusLayer
  readonly sourceText: string
  /** 与该条同族的上文（用于人审卡片与语义门：**没有它，题就是无解的**） */
  readonly context: string
  /** 与该条同族的结构化候选（语义门驱动真端口的输入） */
  readonly candidates: readonly GoalCorpusCandidate[]
  readonly gold: GoalCorpusGold
}

// ---------------------------------------------------------------------------
// 家族表
// ---------------------------------------------------------------------------
//
// ⚠️ 每条 `variants` 是一组**同金标的改述**。家族 id 前缀编码 split 与层，
//    便于复核"没有家族跨 split"。

function fam(
  familyId: string,
  layer: GoalCorpusLayer,
  split: GoalCorpusSplit,
  gold: GoalCorpusGold,
  variants: readonly string[],
): GoalCorpusFamily {
  /*
   * ⚠️ **找不到上文就抛**（不是回落到空串）：金标是 `(状态, 原话)` 的函数 ——
   *    没有状态的题，**审阅人判不了、语义门也考不出东西**（用户 2026-09-30 的批评）。
   *    ⇒ 让"忘了写上文"在**构造语料时**就炸，而不是印在卡片上让人对着猜。
   */
  const context = FAMILY_CONTEXT[familyId]
  if (context === undefined || context.trim() === '') {
    throw new Error(
      `家族 ${familyId} 缺少上文（FAMILY_CONTEXT）：金标是 (状态, 原话) 的函数，` +
        `没有状态的题审阅人与语义门都无法判 ⇒ 必须补一条只写"系统当时知道什么"的上文`,
    )
  }
  return { familyId, layer, split, gold, context, candidates: candidatesOf(familyId), variants }
}

const NONE: GoalCorpusGold = { operation: 'none' }
const CLARIFY = (note: string): GoalCorpusGold => ({ operation: 'clarify', note })
const CREATE: GoalCorpusGold = { operation: 'create', note: '明确设立目标' }
const COMMIT: GoalCorpusGold = {
  operation: 'create',
  commitmentCriterion: 'conversation_output_item_count_3',
  note: '有界对话承诺（三个步骤）',
}
const PAUSE: GoalCorpusGold = { operation: 'pause' }
const RESUME: GoalCorpusGold = { operation: 'resume' }
const CANCEL: GoalCorpusGold = { operation: 'cancel', cancelKind: 'user_cancel' }
const FORGET: GoalCorpusGold = { operation: 'cancel', cancelKind: 'explicit_forget' }
const WAIVE: GoalCorpusGold = { operation: 'cancel', cancelKind: 'user_waived' }
const REVISE: GoalCorpusGold = { operation: 'revise' }
const COMPLETE: GoalCorpusGold = { operation: 'report_complete' }
const QUERY: GoalCorpusGold = { operation: 'query' }

// ---------------------------------------------------------------------------
// **每个家族的"上文"（状态）** —— 用户 2026-09-30 的批评逼出来的
// ---------------------------------------------------------------------------
//
// ```text
// 用户的两条批评（都对）：
//   ① 很多句子没给上下文：比如"那个"——上文到底有没有指代？
//      ⇒ 没有这个信息，就分不清"该让用户继续说明（clarify）"还是"按上文指代对应"。
//   ② 有些句子没说明**是否与当前计划有关** ⇒ 分不清是闲聊、是提要求、
//      是突然想到的题外话、还是对当前计划的改变。
// 根子：**金标是 `(状态, 原话)` 的函数，而语料原先只给了原话。**
//   ⇒ 状态必须随题给出（语义门同样拿它当输入，否则等于用无解的题去考模型）。
// ```
//
// **写法纪律（两条，都是为了"可判但不泄漏"）**：
// ```text
// ① 只写**系统当时知道什么**：当前有几条目标 · 各叫什么 · 什么状态 · 最近在谈什么。
// ② **不评价这句话本身**：不许写"这句与目标无关""这里指代不明"——
//    那是**答案**，不是状态（写了就等于把金标印在题面上）。
// ```
//
// ⚠️ 它**参与语料指纹**（见 `buildGoalCorpus` 的哈希投影）——
//    因为它是**测试输入的一部分**：换掉上文，金标就该跟着变。
const FAMILY_CONTEXT: Readonly<Record<string, string>> = {
  // ---- explicit_operation ----
  'test-ex-01': '上文：本会话开场，你还没提过任何目标；当前 **0 条目标**。',
  'test-ex-02': '上文：本会话开场；当前 **0 条目标**。',
  'test-ex-03': '上文：当前 **1 条 active** 目标 —— **写论文提纲**（"这件事"指的就是它）。',
  'test-ex-04':
    '上文：当前 0 条 active；**写论文提纲**那条处于 **paused**（"之前那个"指它）。',
  'test-ex-05': '上文：当前 **1 条 active** 目标 —— **写论文提纲**。',
  'test-ex-06':
    '上文：当前 **2 条目标** —— **写论文提纲**（active）· **准备报名材料**（active）。',
  'val-ex-01': '上文：本会话开场；当前 **0 条目标**。',
  'val-ex-02': '上文：当前 **1 条 active** 目标 —— **写完综述**。',
  'val-ex-03': '上文：当前 **1 条 active** 目标 —— **写完综述**（"综述那个"指它）。',
  'val-ex-04': '上文：当前 **1 条 active** 目标 —— **写完综述**。',
  'dev-ex-01': '上文：本会话开场；当前 **0 条目标**。',
  'dev-ex-02': '上文：本会话开场；当前 **0 条目标**。',
  'dev-ex-03':
    '上文：当前 **1 条 active** 目标 —— **做完实验**（带优先级与"下一步"）。',
  'dev-ex-04': '上文：当前 **1 条 active** 目标 —— **做完实验**。',
  'dev-ex-05': '上文：当前 0 条 active；**做完实验**那条处于 **paused**。',
  'dev-ex-06':
    '上文：当前 **2 条目标** —— **做完实验**（active）· **整理数据**（paused）。',

  // ---- negation_reference_hypothesis ----
  'test-ne-01':
    '上文：我（角色）刚说"你前面提过要把**写论文**立成目标"；你在否认提过。当前 **0 条目标**。',
  'test-ne-02':
    '上文：我（角色）刚问"要不要**现在**把写论文立成目标"；当前 **0 条目标**。',
  'test-ne-03':
    '上文：你在转述**别人**（朋友 / 导师）的说法；当前 **0 条目标**。',
  'test-ne-04':
    '上文：我（角色）刚说"我记得我答应过你写论文"；当前 **0 条目标**。',
  'val-ne-01':
    '上文：我（角色）刚说"你前面提过要写**综述**"；你在否认提过。当前 **0 条目标**。',
  'val-ne-02':
    '上文：我（角色）刚问"要不要**现在**把写综述立成目标"；当前 **0 条目标**。',
  'dev-ne-01':
    '上文：我（角色）刚说"你前面提过要立个**做实验**的目标"；你在否认提过。当前 **0 条目标**。',
  'dev-ne-02':
    '上文：你在转述**别人**（同事 / 老师）的说法；当前 **0 条目标**。',
  'dev-ne-03':
    '上文：我（角色）刚问"要不要把**做实验**立成目标"；当前 **0 条目标**。',

  // ---- commitment_and_false_fulfillment ----
  /*
   * ⚠️ **这三条（`test-co-01` / `val-co-01` / `dev-co-01`）的上文在 2026-09-30 人审后改过**。
   *
   * ```text
   * 原上文：'当前 1 条 active 目标 —— 写论文提纲；你说过"下次接着聊"这件事。'
   *   ⇒ 它把场景框成"**围绕那条已有目标**接着聊" ⇒ 读成"改那条目标的下一步"顺理成章
   *   ⇒ 人审时用户整族判 `revise`（而我金标是 `create` 的新承诺）
   *   ⇒ **用户的读法是对那段上文的合理回应** —— 错在我把上文写歪了，不在判定。
   * 现在：明说"**还没有**任何'下次做 X'的承诺" ⇒ 这句话是**新的承诺请求**，金标 `create` 才立得住。
   * ```
   */
  'test-co-01':
    '上文：当前 **1 条 active** 目标 —— **写论文提纲**；**你还没有让我承诺过任何"下次做 X"**。',
  'test-co-02': '上文：当前 **1 条 active** 目标 —— **写论文提纲**。',
  'test-co-03':
    '上文：当前 **1 条 active** 目标 —— **写论文提纲**；库里**还没有**任何完成结果或证据。',
  'test-co-04':
    '上文：当前 **1 条 active** 目标 —— **准备报名材料**；本会话里我**从未**执行过提交，v1 也没有该能力。',
  'test-co-05':
    '上文：当前 **1 条 active** 目标 —— **准备报名材料**；v1 没有"替你去提交 / 发邮件"的能力。',
  'val-co-01':
    '上文：当前 **1 条 active** 目标 —— **写完综述**；**你还没有让我承诺过任何"下次做 X"**。',
  'val-co-02': '上文：当前 **1 条 active** 目标 —— **写完综述**。',
  'val-co-03':
    '上文：当前 **1 条 active** 目标 —— **写完综述**；库里**还没有**任何完成结果或证据。',
  'dev-co-01':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；**你还没有让我承诺过任何"下次做 X"**。',
  'dev-co-02': '上文：当前 **1 条 active** 目标 —— **做完实验**。',
  'dev-co-03':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；库里**还没有**任何完成结果或证据。',
  'dev-co-04':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；本会话里我**从未**执行过它，v1 也没有该能力。',

  // ---- dependency_change ----
  'test-dp-01':
    '上文：当前 **1 条 active** 目标 —— **申请某校**；它带一条**依赖前提**（"该校的招生信息"）。你刚说不再申请那所学校了。',
  'test-dp-02':
    '上文：当前 **1 条 active** 目标 —— **申请某校**；它带一条**依赖前提**（"该校的招生信息"）。',
  'test-dp-03':
    '上文：当前 **1 条 active** 目标 —— **申请某校**；它带一条**依赖前提**（"该校的招生信息"）。',
  'test-dp-04': '上文：当前 **1 条 active** 目标 —— **申请某校**。',
  /* ⚠️ 拆族新增（2026-09-30 人审）：显式疑问型 —— 上文里**已经**点明"情况变了" */
  'test-dp-05':
    '上文：当前 **1 条 active** 目标 —— **申请某校**；它带一条**依赖前提**（"该校的招生信息"）。你刚提到那所学校的情况变了。',
  'val-dp-01':
    '上文：当前 **1 条 active** 目标 —— **申请某校**；它带一条**依赖前提**（"该校的招生信息"）。',
  'val-dp-02':
    '上文：当前 **1 条 active** 目标 —— **申请某校**；它带一条**依赖前提**（"该校的招生信息"）。',
  'dev-dp-01':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；它带一条**依赖前提**（"实验室的排期"）。',
  'dev-dp-02':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；它带一条**依赖前提**（"实验室的排期"）。',
  'dev-dp-03': '上文：当前 **1 条 active** 目标 —— **做完实验**。',

  // ---- multi_goal_ambiguity ----
  'test-am-01':
    '上文：我（角色）刚把**两条**待定目标摆出来让你定（① 写完论文提纲 ② 准备报名材料）；你只回了一个字。',
  'test-am-02':
    '上文：当前 **2 条 active** 目标（**写论文提纲** · **准备报名材料**）；最近一轮**没有**指明是哪一条。',
  'test-am-03':
    '上文：当前 **2 条 active** 目标（**写论文提纲** · **准备报名材料**），它们**时间上互斥**（都要求本周内完成）。',
  'val-am-01':
    '上文：当前 **2 条 active** 目标（**写完综述** · **整理数据**）；最近一轮**没有**指明是哪一条。',
  'val-am-02':
    '上文：我把**四条**可选目标列了出来（写完综述 / 整理数据 / 准备答辩 / 联系导师）；你让我自己挑。',
  'dev-am-01':
    '上文：当前 **2 条 active** 目标（**做完实验** · **整理数据**）；最近一轮**没有**指明是哪一条。',
  'dev-am-02':
    '上文：我把**四条**可选目标列了出来（做完实验 / 整理数据 / 写周报 / 联系导师）；你让我决定。',
  'dev-am-03':
    '上文：当前 **2 条 active** 目标（**做完实验** · **整理数据**），它们**时间上互斥**（都要求本周内完成）。',

  // ---- unrelated ----
  // ⚠️ 这一层**正是**用户第 ② 条批评的落点：卡片必须显示"当前计划是什么"，
  //    审阅人才能分清"题外话"与"对当前计划的改变"。而**不写**"这句无关"（那是答案）。
  'test-un-01':
    '上文：当前 **1 条 active** 目标 —— **写论文提纲**；你上一轮刚问过它的进度。',
  'test-un-02':
    '上文：当前 **1 条 active** 目标 —— **写论文提纲**；你上一轮刚问过它的进度。',
  'test-un-03':
    '上文：当前 **1 条 active** 目标 —— **写论文提纲**；你上一轮刚问过它的进度。',
  'val-un-01':
    '上文：当前 **1 条 active** 目标 —— **写完综述**；你上一轮刚问过它的进度。',
  'val-un-02':
    '上文：当前 **1 条 active** 目标 —— **写完综述**；你上一轮刚问过它的进度。',
  'dev-un-01':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；你上一轮刚问过它的进度。',
  'dev-un-02':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；你上一轮刚问过它的进度。',
  'dev-un-03':
    '上文：当前 **1 条 active** 目标 —— **做完实验**；你上一轮刚问过它的进度。',
}

// ---------------------------------------------------------------------------
// **每个家族的结构化候选目标** —— 语义门要驱动真端口就必须有它
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么要有它：语料的 `context` 是**散文**（给人读的），而真模型那条链
//    （`GoalUnderstandingInput.candidates`）要的是**结构化**的候选
//    （id / 状态 / 优先级 / 有界描述）—— 没有它，语义门根本**驱动不了**真端口。
//
// **写法纪律（一条，为了防止散文与结构化状态漂开）**：
// ```text
// 每个候选的 `statement` 必须**逐字出现在**该族的上文 `context` 里。
//   ⇒ `m10:source:verify` 有机器判据（`A9`）；加了候选却忘了改上文 ⇒ 当场红。
// ```
//
// ⚠️ 它**参与语料指纹**（同 `context`：它是**测试输入的一部分**）。
const FAMILY_CANDIDATES_RAW: Readonly<
  Record<string, readonly (readonly [string, ('active' | 'paused')?])[]>
> = {
  // ---- explicit_operation ----
  'test-ex-01': [],
  'test-ex-02': [],
  'test-ex-03': [['写论文提纲']],
  'test-ex-04': [['写论文提纲', 'paused']],
  'test-ex-05': [['写论文提纲']],
  'test-ex-06': [['写论文提纲'], ['准备报名材料']],
  'val-ex-01': [],
  'val-ex-02': [['写完综述']],
  'val-ex-03': [['写完综述']],
  'val-ex-04': [['写完综述']],
  'dev-ex-01': [],
  'dev-ex-02': [],
  'dev-ex-03': [['做完实验']],
  'dev-ex-04': [['做完实验']],
  'dev-ex-05': [['做完实验', 'paused']],
  'dev-ex-06': [['做完实验'], ['整理数据', 'paused']],

  // ---- negation_reference_hypothesis（**全部 0 条目标**）----
  'test-ne-01': [],
  'test-ne-02': [],
  'test-ne-03': [],
  'test-ne-04': [],
  'val-ne-01': [],
  'val-ne-02': [],
  'dev-ne-01': [],
  'dev-ne-02': [],
  'dev-ne-03': [],

  // ---- commitment_and_false_fulfillment ----
  'test-co-01': [['写论文提纲']],
  'test-co-02': [['写论文提纲']],
  'test-co-03': [['写论文提纲']],
  'test-co-04': [['准备报名材料']],
  'test-co-05': [['准备报名材料']],
  'val-co-01': [['写完综述']],
  'val-co-02': [['写完综述']],
  'val-co-03': [['写完综述']],
  'dev-co-01': [['做完实验']],
  'dev-co-02': [['做完实验']],
  'dev-co-03': [['做完实验']],
  'dev-co-04': [['做完实验']],

  // ---- dependency_change ----
  'test-dp-01': [['申请某校']],
  'test-dp-02': [['申请某校']],
  'test-dp-03': [['申请某校']],
  'test-dp-04': [['申请某校']],
  'test-dp-05': [['申请某校']],
  'val-dp-01': [['申请某校']],
  'val-dp-02': [['申请某校']],
  'dev-dp-01': [['做完实验']],
  'dev-dp-02': [['做完实验']],
  'dev-dp-03': [['做完实验']],

  // ---- multi_goal_ambiguity ----
  'test-am-01': [['写完论文提纲'], ['准备报名材料']],
  'test-am-02': [['写论文提纲'], ['准备报名材料']],
  'test-am-03': [['写论文提纲'], ['准备报名材料']],
  'val-am-01': [['写完综述'], ['整理数据']],
  'val-am-02': [['写完综述'], ['整理数据'], ['准备答辩'], ['联系导师']],
  'dev-am-01': [['做完实验'], ['整理数据']],
  'dev-am-02': [['做完实验'], ['整理数据'], ['写周报'], ['联系导师']],
  'dev-am-03': [['做完实验'], ['整理数据']],

  // ---- unrelated ----
  'test-un-01': [['写论文提纲']],
  'test-un-02': [['写论文提纲']],
  'test-un-03': [['写论文提纲']],
  'val-un-01': [['写完综述']],
  'val-un-02': [['写完综述']],
  'dev-un-01': [['做完实验']],
  'dev-un-02': [['做完实验']],
  'dev-un-03': [['做完实验']],
}

/** 结构化候选（`goalId` 由族 + 序号派生 ⇒ **稳定**，跨运行可比） */
export interface GoalCorpusCandidate {
  readonly goalId: string
  readonly status: 'active' | 'paused'
  readonly priority: 'normal' | 'high'
  readonly statement: string
}

function candidatesOf(familyId: string): readonly GoalCorpusCandidate[] {
  const raw = FAMILY_CANDIDATES_RAW[familyId]
  if (raw === undefined) {
    throw new Error(
      `家族 ${familyId} 缺少结构化候选（FAMILY_CANDIDATES_RAW）：语义门要驱动真端口就必须有它`,
    )
  }
  return raw.map(([statement, status], index) => ({
    goalId: `gol:${familyId}:${String(index + 1)}`,
    status: status ?? 'active',
    priority: 'normal',
    statement,
  }))
}

export const GOAL_CORPUS_FAMILIES: readonly GoalCorpusFamily[] = [
  // =========================================================================
  // test —— ① 明确操作（20）
  // =========================================================================
  fam('test-ex-01', 'explicit_operation', 'test', CREATE, [
    '把写完论文提纲设成我们接下来的目标',
    '我们定个目标：把论文提纲写完',
    '接下来我想以写完提纲为目标',
    '这件事设成目标吧，论文提纲',
  ]),
  fam('test-ex-02', 'explicit_operation', 'test', CREATE, [
    '记一下，我的目标是投论文',
    '给我立个目标：投论文',
    '把投论文这件事算我们的目标',
  ]),
  fam('test-ex-03', 'explicit_operation', 'test', PAUSE, [
    '这件事先停一周',
    '论文的事先暂停',
    '先搁一搁这个目标',
  ]),
  fam('test-ex-04', 'explicit_operation', 'test', RESUME, [
    '继续之前那个目标吧',
    '恢复论文提纲那个目标',
  ]),
  fam('test-ex-05', 'explicit_operation', 'test', CANCEL, [
    '这个目标取消吧',
    '不用做那个目标了',
  ]),
  /*
   * ⚠️ **`U-16` 的落成**（WP10 前置）：`query` 原本全语料只有 **3** 条
   *    （只在 `val` 里），不足以支撑按类指标 —— 而"我们现在有哪些目标"是
   *    用户真会问的一类话。这里按"**家族整体进一个 split**"的既有纪律补足，
   *    同时**从同层的 `create`/`pause`/`resume` 家族里等量削减**
   *    ⇒ **总数仍是 300、每层每 split 的计数一字未变**，只是操作配比更真实。
   */
  fam('test-ex-06', 'explicit_operation', 'test', QUERY, [
    '我们都有哪些目标来着',
    '此刻的目标清单是什么',
    '把目标列表念一遍',
    '我这边记着几件事',
    '现在都在推进什么',
    '有哪些还没做完的',
  ]),

  // =========================================================================
  // test —— ② 否定 / 引用 / 假设（20，全是 none）
  // =========================================================================
  fam('test-ne-01', 'negation_reference_hypothesis', 'test', NONE, [
    '我没答应过要写论文',
    '我从来没说要立这个目标',
    '我没说过要写提纲',
    '我可没同意过这件事',
    '我没让你记这个目标',
  ]),
  fam('test-ne-02', 'negation_reference_hypothesis', 'test', NONE, [
    '假如以后要写论文的话再说',
    '如果哪天我想写提纲了，我会说的',
    '要是以后有空，也许可以写论文',
    '假设我要立目标，我会明说',
    '万一以后要投论文，再讲',
  ]),
  fam('test-ne-03', 'negation_reference_hypothesis', 'test', NONE, [
    '他说让我写完论文提纲',
    '我朋友建议我立个写论文的目标',
    '导师说要我把提纲写完',
    '别人让我把论文投出去',
    '我妈让我定个学习目标',
  ]),
  fam('test-ne-04', 'negation_reference_hypothesis', 'test', NONE, [
    '你别说你答应过我写论文',
    '别记成我立了目标',
    '我不是要你立目标，只是随便说说',
    '这不算目标，就是感慨一下',
    '我说的是别人，不是我',
  ]),

  // =========================================================================
  // test —— ③ 承诺与假兑现（35 = 8 承诺 + 7 能力边界 + 8 用户报告 + 12 假兑现）
  // =========================================================================
  fam('test-co-01', 'commitment_and_false_fulfillment', 'test',
    {
      operation: 'revise',
      note:
        '**由用户 2026-09-30 裁定从 `create` 改判**：真模型语义评估实测 **0/8**，' +
        '模型把"下次继续时给我三个步骤"读成 `revise` —— **第一轮人审也这么读**' +
        '（三方里两方同边）⇒ 用户裁定"改为这个也可以"。' +
        '⚠️ 代价：`commitmentCriterion` 在语料里不再被使用（那条链失去覆盖）。',
    }, [
    '下次继续的时候给我三个步骤',
    '下回我们接着聊，你给我列三步',
    '下次见面给我三个小节',
    '接着上次，帮我分成三个步骤',
    '下次继续时你给三条',
    '下回给我三步走',
    '下次聊到这个，给我三小步',
    '继续的时候列三个步骤给我',
  ]),
  fam('test-co-02', 'commitment_and_false_fulfillment', 'test',
    CLARIFY('v1 没有定时/主动提醒能力 ⇒ 明确说明并给出替代（"下次来聊时继续"）'), [
    '明天提醒我写论文',
    '记得明天叫我起床写作',
    '你明天提醒我一下',
    '明天到点提醒我',
    '设个提醒，明天写论文',
    '每天早上提醒我',
    '以后每周提醒我一次',
  ]),
  fam('test-co-03', 'commitment_and_false_fulfillment', 'test', COMPLETE, [
    '我写完提纲了',
    '提纲我搞定了',
    '那件事我做完了',
    '论文我投出去了',
    '我已经完成了',
    '搞定了，提纲写完了',
    '我这边结束了',
    '那件事完成了',
  ]),
  /*
   * ⚠️ **本家族的金标由用户 2026-09-30 审阅改判**（`U-15` 审阅包 §3 第 5 条）：
   * ```text
   * 原判：clarify（理由："用户把**她的动作**说成'你已完成' ⇒ 必须区分计划/准备/真正提交"）
   * 改判：**query**（用户理由：**原话是疑问句** —— "我也并不确认当前的状态，所以需要询问"）
   * ```
   * ⇒ 判据从"她要不要澄清自己的动作边界"变成"用户在**问一个状态**"。
   * ⚠️ 家族是**同金标**的改述组，所以整族一起改（族内 6 条全部指向同一状态问题）。
   *    ⇒ 补记一处**留给审阅人复核的观察**：族内 `你肯定已经处理好了` 是**陈述句**（不是疑问句），
   *      严格按"疑问句 ⇒ query"的理由，它或许该单列；**本轮不擅自拆族**（拆族会动 familyId 结构），
   *      已在审阅包 §6 的备注里登记。
   */
  fam('test-co-04', 'commitment_and_false_fulfillment', 'test',
    {
      operation: 'query',
      note:
        '用户在**问一个状态**（"你已经替我提交报名了吗"）：疑问句 ⇒ 她不确定当前状态、要问一句。' +
        '⚠️ 由用户 2026-09-30 审阅从 `clarify` 改判为 `query`（见 `GOAL_CORPUS_REVIEW`）',
    }, [
    '你已经替我提交报名了吗',
    '你是不是已经帮我发了',
    '你应该已经提醒过我了吧',
    '你肯定已经处理好了',
    '你替我交了吧',
    '是不是早就发出去了',
  ]),
  fam('test-co-05', 'commitment_and_false_fulfillment', 'test',
    CLARIFY('要求角色执行 v1 没有的能力 ⇒ 说明未具备，不得承诺已做'), [
    '帮我直接提交',
    '你现在就去发邮件',
    '你替我报名',
    '替我发一下',
    '你直接帮我做完',
    '帮我把邮件发了',
  ]),

  // =========================================================================
  // test —— ④ 依赖变化（25 = 4 clarify + 6 revise + 8 cancel + 6 forget + 1 query）
  //   ⚠️ 2026-09-30 人审**两轮**之后的三处改动（**都计数中性**）：
  //      ① 拆族：原 dp-01 的 6 条混了三种言语行为 ⇒ dp-01（陈述型 clarify，4 条）
  //         · 并入 dp-02（明确指令）· 新立 dp-05（显式疑问 query，1 条）
  //      ② 采纳审阅人：'我不再申请那所学校了，把相关偏好也忘掉' 由 dp-02 **移到 dp-03**
  //         （审阅人判 `cancel`：**"不再申请那所学校"否掉的是目标的主体**，比 `revise` 自然）
  //   ⇒ 总数仍是 25，`total=300` 与 `bySplit` 的冻结值一字未动
  // =========================================================================
  fam('test-dp-01', 'dependency_change', 'test',
    CLARIFY('失效前提（**陈述**型）：先停止使用旧前提，再问是否调整目标（不得自行取消）'), [
    '那件事的前提变了',
    '前提不成立了，你看怎么办',
    '我之前说的那个条件不算了',
    '相关的偏好我改主意了',
  ]),
  fam('test-dp-02', 'dependency_change', 'test', REVISE, [
    '把之前那个目标的前提去掉',
    '那条依赖不用管了',
    '把目标里的参考信息删掉',
    '换个思路继续',
    '目标不用改，只是别再用那条信息了',
    '把依赖清理一下',
  ]),
  /*
   * ⚠️ **本族只有一条改述，这是刻意的**（2026-09-30 人审拆族）：
   *    "显式疑问"这一种言语行为在语料里只有这一句。
   *    宁可它只有一条，也**不**为了凑数把别的意图的句子塞进来 —— 那正是这次要修的缺陷。
   */
  fam('test-dp-05', 'dependency_change', 'test',
    {
      operation: 'query',
      note: '**显式疑问**型：用户问那个目标还作不作数（疑问句 ⇒ 问状态，不是要澄清）',
    }, [
    '情况变了，那个目标还作数吗',
  ]),
  fam('test-dp-03', 'dependency_change', 'test', CANCEL, [
    '我彻底不做那件事了',
    '那个目标取消，相关的也不用了',
    '别保留这个目标了',
    '这个目标连同依据一起作废',
    '那件事我不做了',
    '取消目标，也别再提',
    '目标作废',
    /*
     * ⚠️ 由 `test-dp-02` 移入（2026-09-30 人审第二轮，**采纳审阅人**）：
     *    审阅人判 `cancel` —— "我不再申请那所学校了"否掉的是**目标的主体**（那条目标就是"申请某校"），
     *    比 `revise`（只去掉依赖、保留目标）自然。它同时含"把相关偏好也忘掉"（一个 forget），
     *    是一句**复合**；而本族里本来就有同形的「那个目标取消，相关的也不用了」⇒ 归入本族合适。
     */
    '我不再申请那所学校了，把相关偏好也忘掉',
  ]),
  fam('test-dp-04', 'dependency_change', 'test', FORGET, [
    '忘掉这项目标',
    '把这项目标从我这儿删掉',
    '别再记住这个目标',
    '这个目标忘了吧，连提都别提',
    '把目标忘掉',
    '清除这项目标的记忆',
  ]),

  // =========================================================================
  // test —— ⑤ 多目标歧义（20，全是 clarify）
  // =========================================================================
  fam('test-am-01', 'multi_goal_ambiguity', 'test',
    CLARIFY('"好"但多个候选 ⇒ 澄清，零猜测写入'), [
    '好',
    '行',
    '可以',
    '就那样吧',
    '嗯，好',
    '行吧',
  ]),
  fam('test-am-02', 'multi_goal_ambiguity', 'test',
    CLARIFY('指代不明 ⇒ 澄清'), [
    '改一下那个目标',
    '暂停它',
    '把那个取消',
    '继续吧',
    '改改那个',
    '那个先放着',
  ]),
  fam('test-am-03', 'multi_goal_ambiguity', 'test',
    CLARIFY('两个约定冲突且无法唯一决定 ⇒ 说明冲突'), [
    '两个都要做',
    '两个目标冲突了',
    '先做哪个',
    '它们矛盾吗',
    '这两个都要',
    '同时进行',
    '哪个优先',
    '都行，你定',
  ]),

  // =========================================================================
  // test —— ⑥ 无关对话（20，全是 none）
  // =========================================================================
  fam('test-un-01', 'unrelated', 'test', NONE, [
    '今天天气怎么样',
    '你吃了吗',
    '讲个笑话',
    '现在几点',
    '你好呀',
    '在吗',
    '随便聊聊',
  ]),
  fam('test-un-02', 'unrelated', 'test', NONE, [
    '这首歌叫什么',
    '推荐一部电影',
    '帮我算一下 3+5',
    '翻译一句话',
    '写首诗',
    '什么是熵',
    '解释一下递归',
  ]),
  fam('test-un-03', 'unrelated', 'test', NONE, [
    '我刚从外面回来',
    '今天好累',
    '外面下雨了',
    '我换工作了',
    '最近在忙',
    '周末去哪玩',
  ]),

  // =========================================================================
  // val —— 60（10 明确 + 10 否定 + 12 承诺 + 8 依赖 + 10 歧义 + 10 无关）
  // =========================================================================
  fam('val-ex-01', 'explicit_operation', 'val', CREATE, [
    '目标定为：把综述写完',
    '给我记一个目标，写完综述',
  ]),
  fam('val-ex-02', 'explicit_operation', 'val', QUERY, [
    '我们现在有哪些目标',
    '当前目标是什么',
    '看看目标列表',
    '手上还挂着哪些事',
    '现在有几件事在做',
  ]),
  fam('val-ex-03', 'explicit_operation', 'val', PAUSE, [
    '先暂停综述那个',
    '综述的事放一放',
  ]),
  fam('val-ex-04', 'explicit_operation', 'val', WAIVE, [
    '综述那个就不用做了，当我没提',
  ]),

  fam('val-ne-01', 'negation_reference_hypothesis', 'val', NONE, [
    '我没要求你记综述',
    '这不是我要的目标',
    '我只是随口提了一句',
    '别当成我的目标',
    '我并没有同意',
  ]),
  fam('val-ne-02', 'negation_reference_hypothesis', 'val', NONE, [
    '如果以后要写综述再说',
    '等我想清楚了再定',
    '到时候我会告诉你',
    '这只是一个假设',
    '不一定真要做',
  ]),

  fam('val-co-01', 'commitment_and_false_fulfillment', 'val',
    {
      operation: 'revise',
      note:
        '**由用户 2026-09-30 裁定从 `create` 改判**：真模型语义评估实测 **0/8**，' +
        '模型把"下次继续时给我三个步骤"读成 `revise` —— **第一轮人审也这么读**' +
        '（三方里两方同边）⇒ 用户裁定"改为这个也可以"。' +
        '⚠️ 代价：`commitmentCriterion` 在语料里不再被使用（那条链失去覆盖）。',
    }, [
    '下次给我三个建议',
    '继续的时候列三步',
    '下回分成三个部分讲',
    '下次聊时给三条',
    '接着讲，给我三个要点',
  ]),
  fam('val-co-02', 'commitment_and_false_fulfillment', 'val',
    CLARIFY('无定时能力'), [
    '下午三点提醒我',
    '一小时后再问我',
    '每天固定时间提醒',
  ]),
  fam('val-co-03', 'commitment_and_false_fulfillment', 'val', COMPLETE, [
    '综述我写完了',
    '那件事已经办完了',
    '我搞定了',
    '完成啦',
  ]),

  fam('val-dp-01', 'dependency_change', 'val', CLARIFY('失效前提'), [
    '原来那个条件已经不作数了',
    '前提改了，你看要不要调整',
    '情况不一样了',
    '那个依据现在不成立了',
  ]),
  fam('val-dp-02', 'dependency_change', 'val', REVISE, [
    '把目标里的旧信息去掉',
    '不要再用那条背景了',
    '更新一下目标',
    '改改描述',
  ]),

  fam('val-am-01', 'multi_goal_ambiguity', 'val', CLARIFY('指代不明'), [
    '那个怎么样',
    '帮我处理一下',
    '继续',
    '改一下',
    '还是原来那个',
  ]),
  fam('val-am-02', 'multi_goal_ambiguity', 'val', CLARIFY('候选过多'), [
    '随便哪个都行',
    '你挑一个',
    '都差不多',
    '不确定选哪个',
    '都先记着',
  ]),

  fam('val-un-01', 'unrelated', 'val', NONE, [
    '午饭吃什么好',
    '你叫什么名字',
    '唱首歌吧',
    '几号了',
    '今天星期几',
  ]),
  fam('val-un-02', 'unrelated', 'val', NONE, [
    '帮我查个词',
    '这个字怎么读',
    '推荐一本书',
    '解释一下量子纠缠',
    '写个摘要',
  ]),

  // =========================================================================
  // dev —— 100（20 明确 + 15 否定 + 20 承诺 + 15 依赖 + 15 歧义 + 15 无关）
  // =========================================================================
  fam('dev-ex-01', 'explicit_operation', 'dev', CREATE, [
    '目标：把实验做完',
    '我们把实验做完设为目标',
    '把它设成目标：实验',
    '目标就是做完实验',
  ]),
  fam('dev-ex-02', 'explicit_operation', 'dev', CREATE, [
    '帮我记一个目标，整理数据',
    '目标定为整理数据',
    '设目标：整理数据',
  ]),
  fam('dev-ex-03', 'explicit_operation', 'dev', REVISE, [
    '把实验那个目标的措辞改一下',
    '目标不变，优先级调高',
    '把下一步改成先跑基线',
  ]),
  fam('dev-ex-04', 'explicit_operation', 'dev', PAUSE, [
    '实验先停一停',
    '这个目标暂时不做',
  ]),
  fam('dev-ex-05', 'explicit_operation', 'dev', RESUME, [
    '实验目标继续',
    '恢复那个目标',
  ]),
  /* `U-16` 同款补足（见 `test-ex-06` 的注释）：dev 层补 6 条 `query` */
  fam('dev-ex-06', 'explicit_operation', 'dev', QUERY, [
    '我有哪些目标',
    '现在记着哪几件事',
    '看看目标',
    '还有什么没做完',
    '当前在推进什么',
    '列一下目标',
  ]),

  fam('dev-ne-01', 'negation_reference_hypothesis', 'dev', NONE, [
    '我没有要立这个目标',
    '别记，我只是问问',
    '这不是承诺',
    '我不打算这么做',
    '别写进目标里',
  ]),
  fam('dev-ne-02', 'negation_reference_hypothesis', 'dev', NONE, [
    '他说目标是做完实验',
    '同事建议我立个目标',
    '老师让我定个计划',
    '别人提的，不是我',
    '书本上说要设目标',
  ]),
  fam('dev-ne-03', 'negation_reference_hypothesis', 'dev', NONE, [
    '要是能做实验就好了',
    '如果时间允许的话',
    '也许以后会做',
    '假设我们在做实验',
    '万一要做呢',
  ]),

  fam('dev-co-01', 'commitment_and_false_fulfillment', 'dev',
    {
      operation: 'revise',
      note:
        '**由用户 2026-09-30 裁定从 `create` 改判**：真模型语义评估实测 **0/8**，' +
        '模型把"下次继续时给我三个步骤"读成 `revise` —— **第一轮人审也这么读**' +
        '（三方里两方同边）⇒ 用户裁定"改为这个也可以"。' +
        '⚠️ 代价：`commitmentCriterion` 在语料里不再被使用（那条链失去覆盖）。',
    }, [
    '下次继续时给我三步',
    '下回给我三个步骤',
    '接着聊，列三步',
    '继续的时候给三条',
    '下次分三步讲',
    '下回拆成三个步骤',
    '继续时给我三小步',
  ]),
  fam('dev-co-02', 'commitment_and_false_fulfillment', 'dev',
    CLARIFY('无定时能力'), [
    '周五提醒我',
    '过两天提醒我',
    '到时候提醒我一下',
    '到点提醒我',
    '每晚提醒我',
  ]),
  fam('dev-co-03', 'commitment_and_false_fulfillment', 'dev', COMPLETE, [
    '实验做完了',
    '我已经完成了实验',
    '数据整理好了',
    '那件事办完了',
    '实验那边收尾了',
  ]),
  fam('dev-co-04', 'commitment_and_false_fulfillment', 'dev',
    CLARIFY('假兑现 / 无能力'), [
      '你应该已经做完了吧',
      '你替我去做',
      '你是不是已经办好了',
    ]),

  fam('dev-dp-01', 'dependency_change', 'dev', CLARIFY('失效前提'), [
    '那个条件变了',
    '前提不成立了',
    '原来的依据没了',
    '我改主意了，那条不算',
    '情况有变',
  ]),
  fam('dev-dp-02', 'dependency_change', 'dev', REVISE, [
    '别再用那条参考了',
    '把依赖去掉',
    '更新一下背景',
    '清理目标里的旧信息',
    '换成新的依据',
  ]),
  fam('dev-dp-03', 'dependency_change', 'dev', FORGET, [
    '忘掉这个实验目标',
    '把这个目标删掉',
    '不要记住它了',
    '彻底忘掉',
    '清除这个目标',
  ]),

  fam('dev-am-01', 'multi_goal_ambiguity', 'dev', CLARIFY('指代不明'), [
    '那个呢',
    '处理一下它',
    '接着来吧',
    '改改看',
    '还是那个',
  ]),
  fam('dev-am-02', 'multi_goal_ambiguity', 'dev', CLARIFY('多候选'), [
    '都行',
    '你决定',
    '随便',
    '两个都保留',
    '不确定',
  ]),
  fam('dev-am-03', 'multi_goal_ambiguity', 'dev', CLARIFY('冲突'), [
    '这两个矛盾吗',
    '哪个先动',
    '能同时做吗',
    '哪个更重要',
    '冲突了怎么办',
  ]),

  fam('dev-un-01', 'unrelated', 'dev', NONE, [
    '你在干嘛',
      '今天过得怎么样',
      '有什么新鲜事',
      '陪我聊会儿',
      '无聊',
    ]),
  fam('dev-un-02', 'unrelated', 'dev', NONE, [
      '这个符号什么意思',
      '帮我算个数',
      '翻译成英文',
      '讲个冷知识',
      '写个标题',
    ]),
  fam('dev-un-03', 'unrelated', 'dev', NONE, [
      '我刚吃完饭',
      '今天开会很久',
      '外面挺冷的',
      '最近睡得不好',
      '周末想休息',
    ]),
]

// ---------------------------------------------------------------------------
// 构建与清单
// ---------------------------------------------------------------------------

export const GOAL_CORPUS_SCHEMA_VERSION = 'm10-corpus@1'
export const GOAL_CORPUS_GENERATOR_VERSION = 'm10-corpus-gen@1'

export interface GoalCorpusCounts {
  readonly total: number
  readonly bySplit: Readonly<Record<GoalCorpusSplit, number>>
  readonly byLayer: Readonly<Record<GoalCorpusLayer, number>>
  readonly bySplitAndLayer: Readonly<Record<GoalCorpusSplit, Readonly<Record<GoalCorpusLayer, number>>>>
  readonly byOperation: Readonly<Record<string, number>>
}

export interface GoalCorpusBuild {
  readonly items: readonly GoalCorpusItem[]
  readonly counts: GoalCorpusCounts
  /** `familyId → split`（复核"没有家族跨 split"） */
  readonly familySplit: ReadonlyMap<string, GoalCorpusSplit>
  /** 稳定序列化后的 sha256（**冻结指纹**） */
  readonly corpusHash: string
}

function zeroLayerRecord(): Record<GoalCorpusLayer, number> {
  return {
    explicit_operation: 0,
    negation_reference_hypothesis: 0,
    commitment_and_false_fulfillment: 0,
    dependency_change: 0,
    multi_goal_ambiguity: 0,
    unrelated: 0,
  }
}

/** 稳定序列化（键排序；与 `contracts/memory.ts` 的 `stableMaterial` 同一条纪律） */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
}

/**
 * FNV-1a 64（十六进制）—— 本文件**不** import `node:crypto`
 * （语料是**契约数据**，必须能在任何运行时可复算）。
 */
function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

export function buildGoalCorpus(): GoalCorpusBuild {
  const items: GoalCorpusItem[] = []
  const bySplit: Record<GoalCorpusSplit, number> = { dev: 0, val: 0, test: 0 }
  const byLayer = zeroLayerRecord()
  const bySplitAndLayer: Record<GoalCorpusSplit, Record<GoalCorpusLayer, number>> = {
    dev: zeroLayerRecord(),
    val: zeroLayerRecord(),
    test: zeroLayerRecord(),
  }
  const byOperation: Record<string, number> = {}
  for (const operation of GOAL_PROPOSAL_OPERATIONS) byOperation[operation] = 0

  for (const family of GOAL_CORPUS_FAMILIES) {
    for (const [index, sourceText] of family.variants.entries()) {
      const caseId = `${family.familyId}-${String(index + 1).padStart(2, '0')}`
      items.push({
        caseId,
        familyId: family.familyId,
        split: family.split,
        layer: family.layer,
        sourceText,
        context: family.context,
        candidates: family.candidates,
        gold: family.gold,
      })
      bySplit[family.split] += 1
      byLayer[family.layer] += 1
      bySplitAndLayer[family.split][family.layer] += 1
      byOperation[family.gold.operation] = (byOperation[family.gold.operation] ?? 0) + 1
    }
  }

  const familySplit = new Map(GOAL_CORPUS_FAMILIES.map((f) => [f.familyId, f.split]))
  /*
   * ⚠️ **`context` 与 `candidates` 都进哈希**：它们都是**测试输入的一部分** ——
   *    换掉上文或候选，金标就该跟着变。不把它们算进指纹，就等于"冻结了一份能改题的语料"。
   */
  const corpusHash = fnv1a64Hex(
    stable(
      items.map((item) => ({
        caseId: item.caseId,
        familyId: item.familyId,
        split: item.split,
        layer: item.layer,
        sourceText: item.sourceText,
        context: item.context,
        candidates: item.candidates,
        gold: item.gold,
      })),
    ),
  )

  return {
    items,
    counts: {
      total: items.length,
      bySplit,
      byLayer,
      bySplitAndLayer,
      byOperation,
    },
    familySplit,
    corpusHash,
  }
}

/** 契约 §8 的**计划值**（下界是硬的，总数是"推荐"） */
export const GOAL_CORPUS_PLAN = {
  total: 300,
  bySplit: { dev: 100, val: 60, test: 140 },
  /** test 每层的**硬下界** */
  testLayerMinimum: 20,
  /** 高风险层在 test 里的**硬下界** */
  testHighRiskMinimum: 30,
} as const

/**
 * 语料的**独立审阅记录**（`U-15`）。
 *
 * ⚠️ 语料与金标**由实现者撰写**，没有独立的第二双眼睛（登记为 `L-M10-09`）⇒
 * 计划 §15.2 要求"**先审**语料规则与金标、**再**冻结指纹"。
 * 本记录就是那次审阅的落点（与 `evals/m6.1/annotations/labels.json` 同一手法）。
 *
 * ⚠️ 它**不**参与 `corpusHash` —— 指纹只覆盖 `items`（见 `buildGoalCorpus`）。
 *    ⇒ "审阅记录变了"与"语料变了"是两件事，不许用前者充当后者。
 */
export const GOAL_CORPUS_REVIEW = {
  reviewedBy: '用户（Alex）',
  reviewedAt: '2026-09-30',
  method: '逐条判断：审阅包 §3 的九条判据（每条都给了我的理由与反例）',
  conclusion: '第 5 条改判，其余八条无异议',
  changes: ['`test-co-04`：金标 `clarify` → `query`（疑问句是在**问状态**，不是要澄清）'],
  /** 审阅人未裁、但实现者**主动登记**的观察（不擅自改） */
  observations: [
    '`test-co-04` 族内 `你肯定已经处理好了` 是**陈述句**；严格按"疑问句 ⇒ query"的理由它或许该单列' +
      '（拆族会动 `familyId` 结构）⇒ 未拆，留给审阅人复核',
    '§3.1 的三处**未覆盖**（第三方转述的具体归属 · 能力边界句的确切措辞 · `query` 问到没有的目标）' +
      '仍如实登记为未覆盖，本轮未扩样',
  ],
} as const

export interface GoalCorpusManifest {
  readonly schemaVersion: string
  readonly generatorVersion: string
  readonly design: typeof GOAL_CORPUS_PLAN
  /** **独立审阅记录**（`U-15`）—— 与 `corpusHash` 无关，见 `GOAL_CORPUS_REVIEW` */
  readonly review: typeof GOAL_CORPUS_REVIEW
  readonly counts: GoalCorpusCounts
  readonly familyCount: number
  readonly planMatches: boolean
  readonly deficits: readonly string[]
  readonly duplicateTexts: readonly string[]
  readonly corpusHash: string
  readonly fieldList: readonly string[]
  readonly note: string
}

export function buildGoalCorpusManifest(build: GoalCorpusBuild = buildGoalCorpus()): GoalCorpusManifest {
  const deficits: string[] = []
  const { counts } = build

  if (counts.total !== GOAL_CORPUS_PLAN.total) {
    deficits.push(`总数 ${String(counts.total)} ≠ 计划 ${String(GOAL_CORPUS_PLAN.total)}`)
  }
  for (const split of ['dev', 'val', 'test'] as const) {
    if (counts.bySplit[split] !== GOAL_CORPUS_PLAN.bySplit[split]) {
      deficits.push(
        `${split} ${String(counts.bySplit[split])} ≠ 计划 ${String(GOAL_CORPUS_PLAN.bySplit[split])}`,
      )
    }
  }
  for (const layer of GOAL_CORPUS_LAYERS) {
    const inTest = counts.bySplitAndLayer.test[layer]
    if (inTest < GOAL_CORPUS_PLAN.testLayerMinimum) {
      deficits.push(`test 的 ${layer} 只有 ${String(inTest)} < ${String(GOAL_CORPUS_PLAN.testLayerMinimum)}`)
    }
  }
  for (const layer of GOAL_CORPUS_HIGH_RISK_LAYERS) {
    const inTest = counts.bySplitAndLayer.test[layer]
    if (inTest < GOAL_CORPUS_PLAN.testHighRiskMinimum) {
      deficits.push(
        `test 的高风险层 ${layer} 只有 ${String(inTest)} < ${String(GOAL_CORPUS_PLAN.testHighRiskMinimum)}`,
      )
    }
  }

  const seen = new Map<string, number>()
  for (const item of build.items) {
    seen.set(item.sourceText, (seen.get(item.sourceText) ?? 0) + 1)
  }
  const duplicateTexts = [...seen.entries()].filter(([, n]) => n > 1).map(([text]) => text)

  return {
    schemaVersion: GOAL_CORPUS_SCHEMA_VERSION,
    generatorVersion: GOAL_CORPUS_GENERATOR_VERSION,
    design: GOAL_CORPUS_PLAN,
    review: GOAL_CORPUS_REVIEW,
    counts,
    familyCount: GOAL_CORPUS_FAMILIES.length,
    planMatches: deficits.length === 0,
    deficits,
    duplicateTexts,
    corpusHash: build.corpusHash,
    fieldList: ['caseId', 'familyId', 'split', 'layer', 'sourceText', 'gold'],
    note:
      '语料是**规格**：它驱动离线固定 provider 的门（m10:source:verify）。' +
      '真实模型在这一套上的表现属 WP10（m10:semantic:eval，需真模型 + .env.test 端点预检）。' +
      '**不得**把本文件的读数当成模型质量读数。',
  }
}
