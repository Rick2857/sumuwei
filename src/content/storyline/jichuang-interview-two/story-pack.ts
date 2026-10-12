/**
 * 《一起去参加极创工作室的二面》—— **作者定义**的机器可读内容包（S1 / Lv2.5）。
 *
 * ============================================================================
 *  载体：ADR-091 §1/§2 · 故事世界来源契约 S1–S6 · 计划 §5.1（2026-10-03 S1 修订）
 * ============================================================================
 * 这个文件是"世界边界"的**权威形态**：它冻结图、变量值域、可见事件与结局。
 * `evals/storyline/jichuang-interview-two/jichuang-interview-two.ink` 是同一张图的
 * **叙事表现**（inkjs 运行它、给它文本与选项）；两者必须逐条一致 ——
 * `scripts/postlv2-story-verify.ts` 会交叉核对，不一致即失败。
 *
 * ⚠️ 来源纪律（契约 §6）：
 *   · 「用户已报名极创、过了一面」来自**本轮用户明确陈述**，本包不宣布它为事实。
 *   · 模拟考核规则/场地/题型/评委都是**作者定义**（`story-authored`），
 *     不宣称是极创真实场地或真实规则。
 *   · `passed_together` 是**模拟结果**，永不能升级成"用户现实中已被极创录取"。
 */

import type { StoryContentPack } from '../../../kernel/storyline/story-types.ts'

/** 内容包身份（版本与摘要一起进来源身份；改内容必须升版本） */
export const JICHUANG_STORY_ID = 'jichuang-interview-two'
export const JICHUANG_STORY_VERSION = 1

/**
 * 内容摘要 = `.ink` **源**的 sha256 前 16 位（由 `pnpm postlv2:story:build` 生成的
 * `content-manifest.json` 给出）。
 *
 * ⚠️ 它是**内容指纹**，不是随便填的字符串：`pnpm postlv2:story:verify` 会拿
 * `content-manifest.json` 的 `inkSourceSha256` 与它比对；不一致即失败。
 * 改了剧情必须**重编 → 取新摘要 → 升 `storyVersion`**，否则来源身份会说谎。
 */
export const JICHUANG_CONTENT_DIGEST = '7e96977429d88330'

/**
 * 作者定义的图（4 阶段 / 14 节点 / 3 结局 + 明确退出）。
 *
 * ⚠️ `visibleEvents` **只列她见得到的**：隐藏节点、未选分支、结局条件都不在这里。
 */
export const JICHUANG_PACK: StoryContentPack = {
  storyId: JICHUANG_STORY_ID,
  storyVersion: JICHUANG_STORY_VERSION,
  contentDigest: JICHUANG_CONTENT_DIGEST,
  title: '一起去参加极创工作室的二面',

  variables: [
    { name: 'clarity', range: { kind: 'int', min: 0, max: 3 }, initial: 0 },
    { name: 'cooperation', range: { kind: 'int', min: 0, max: 2 }, initial: 0 },
    { name: 'rehearsed', range: { kind: 'int', min: 0, max: 1 }, initial: 0 },
    { name: 'stage_ready', range: { kind: 'int', min: 0, max: 1 }, initial: 0 },
  ],

  nodes: [
    {
      id: 's1_intro',
      stage: 'confirm_goal',
      choices: ['ask_scope', 'align_first', 'review_first'],
      visibleEvents: ['s1_intro_met'],
    },
    { id: 's1_scope', stage: 'confirm_goal', choices: ['go_prepare'], visibleEvents: ['s1_scope_known'] },
    { id: 's1_align', stage: 'confirm_goal', choices: ['go_prepare'], visibleEvents: ['s1_align_done'] },
    {
      id: 's2_prepare',
      stage: 'prepare_and_drill',
      choices: ['split_by_strength', 'improvise'],
      visibleEvents: ['s2_prepare_started'],
    },
    { id: 's2_drill', stage: 'prepare_and_drill', choices: ['after_drill_go'], visibleEvents: ['s2_drill_done'] },
    {
      id: 's3_attend',
      stage: 'attend_interview',
      choices: ['speak_up', 'follow_partner', 'take_over'],
      visibleEvents: ['s3_attend_entered'],
    },
    { id: 's3_qa', stage: 'attend_interview', choices: ['acknowledge_fix', 'defend_alone'], visibleEvents: ['s3_qa_asked'] },
    {
      id: 's4_result',
      stage: 'result_and_review',
      /**
       * ⚠️ `choices: []` 是**故意**的：结局不是"玩家在 frontier 上挑一个"，
       * 而是由 `resolveEndingChoice()` 按**变量与已提交事件确定性**算出。
       * 把它写成 frontier 选择，就等于允许"模型说我们通过了"——
       * 那正是契约 S4 要拦的形状。
       */
      choices: [],
      visibleEvents: ['s4_result_reached'],
    },
    { id: 'end_pass', stage: 'result_and_review', choices: [], visibleEvents: ['ending_passed_together'] },
    { id: 'end_pending', stage: 'result_and_review', choices: [], visibleEvents: ['ending_pending_review'] },
    { id: 'end_fail', stage: 'result_and_review', choices: [], visibleEvents: ['ending_not_passed'] },
    { id: 'end_exit', stage: 'result_and_review', choices: [], visibleEvents: ['ending_exited_by_user'] },
  ],

  transitions: [
    // 阶段一（可见事件由**节点**承载：到达该节点即进入可见集合，迁移不重复声明）
    { from: 's1_intro', choice: 'ask_scope', to: 's1_scope', setVariables: { clarity: 1, stage_ready: 1 } },
    { from: 's1_intro', choice: 'align_first', to: 's1_align', setVariables: { cooperation: 1 } },
    { from: 's1_intro', choice: 'review_first', to: 's2_prepare' },
    { from: 's1_scope', choice: 'go_prepare', to: 's2_prepare' },
    { from: 's1_align', choice: 'go_prepare', to: 's2_prepare' },

    // 阶段二
    { from: 's2_prepare', choice: 'split_by_strength', to: 's2_drill' },
    { from: 's2_prepare', choice: 'improvise', to: 's3_attend' },
    { from: 's2_drill', choice: 'after_drill_go', to: 's3_attend', setVariables: { rehearsed: 1, clarity: 2 } },

    // 阶段三
    { from: 's3_attend', choice: 'speak_up', to: 's3_qa' },
    { from: 's3_attend', choice: 'follow_partner', to: 's3_qa', setVariables: { cooperation: 2 } },
    { from: 's3_attend', choice: 'take_over', to: 's4_result', setVariables: { cooperation: 0 } },
    { from: 's3_qa', choice: 'acknowledge_fix', to: 's4_result', setVariables: { clarity: 3 } },
    { from: 's3_qa', choice: 'defend_alone', to: 's4_result', setVariables: { clarity: 1 } },
  ],

  /**
   * **确定性**结局迁移（`resolveEndingChoice` 的机器形态）。
   *
   * ⚠️ 这些**不是** frontier 选择：`s4_result` 的 `choices` 是空的
   * ⇒ "模型说我们通过了"在结构上根本无法提交。
   * 判据与 `.ink` 的 `s4_result` 条件分支必须一致，`postlv2:story:verify` 会核对。
   */
  endingTransitions: [
    { from: 's4_result', to: 'end_pass', ending: 'passed_together', rule: 'clarity>=2 && cooperation>=1 && rehearsed==1' },
    { from: 's4_result', to: 'end_fail', ending: 'not_passed_this_time', rule: 'stage_ready==0' },
    { from: 's4_result', to: 'end_pending', ending: 'pending_further_review', rule: 'otherwise' },
  ],

  entryNodeId: 's1_intro',

  endings: [
    { id: 'passed_together', nodeId: 'end_pass' },
    { id: 'pending_further_review', nodeId: 'end_pending' },
    { id: 'not_passed_this_time', nodeId: 'end_fail' },
    { id: 'exited_by_user', nodeId: 'end_exit' },
  ],

  /** 可退出节点（**退出 ≠ 被判定未通过**） */
  exitNodes: ['s1_intro', 's2_prepare', 's3_attend', 's4_result'],
}

/**
 * 结局判定（**确定性**；与 `.ink` 的 `s4_result` 条件分支逐条一致）。
 *
 * ⚠️ 这是"模型不能新增结局"的机器形态之一：结局由**变量与已提交事件**算出，
 * 不是由模型说"我们通过了"。
 */
export function resolveEndingChoice(
  variables: Readonly<Record<string, number | boolean | string>>
): 'end_pass' | 'end_pending' | 'end_fail' {
  const clarity = Number(variables.clarity ?? 0)
  const cooperation = Number(variables.cooperation ?? 0)
  const rehearsed = Number(variables.rehearsed ?? 0)
  const stageReady = Number(variables.stage_ready ?? 0)

  if (clarity >= 2 && cooperation >= 1 && rehearsed === 1) return 'end_pass'
  if (stageReady === 0) return 'end_fail'
  return 'end_pending'
}

/** 作者前提登记（**来源必须写清**；不得补写不存在的往事） */
export const JICHUANG_AUTHORED_PREMISES: readonly {
  premise: string
  source: 'user_statement_this_round' | 'story-authored'
  note: string
}[] = [
  {
    premise: '你已经报名极创工作室、通过一面，正在准备二面',
    source: 'user_statement_this_round',
    note: '来自本轮用户明确陈述 ⇒ 用户事实记忆；**不**由本内容包宣布',
  },
  {
    premise: '苏沐薇是你的二面搭档，与你一起参加和配合',
    source: 'user_statement_this_round',
    note: '来自本轮用户明确陈述（协作意愿）',
  },
  {
    premise: '模拟考核规则、场地、题型与评委',
    source: 'story-authored',
    note: '内容包作者定义；**不**宣称是极创真实场地/真实规则/真实题型',
  },
  {
    premise: '共同通过 / 待定 / 未通过三个结局',
    source: 'story-authored',
    note: '模拟结局；现实录取结果另行按用户陈述来源保存',
  },
  {
    premise: '她曾陪你参加过一面',
    source: 'story-authored',
    note: '**明确不写入**：序章不得给真实对话账本补写不存在的往事（计划 §5.1）',
  },
]
