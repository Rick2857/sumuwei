/**
 * P3-5 判分器**量具自证门** —— 证明 `scripts/cognitive/p3-5-score.ts` **不是恒真**。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  零请求 · 零出网 · 零数据库的**离线**门：只用**纯函数** + **自造夹具**，
 *  一条条证明判分器会**随夹具变化而变化**：
 * ```text
 *  ① 完美答案（命中关键词 + 引用期望文件 + 真读过）⇒ achieved / sourceSupport=true / 无虚构
 *  ② 答非所问（无关键词、无引用）⇒ not_achieved（**不是** unknown）
 *  ③ 命中关键词但答案里没有任何引用线索 ⇒ unknown（unknownRules 第 1 条）
 *  ④ 引用快照里**不存在**的路径 ⇒ fabricatedCitation=true（HG4）
 *  ⑤ 引用快照里存在但**没读过**的文件 ⇒ fabricatedCitation=true（HG4）
 *  ⑥ 越界读 / 被拒动作 ⇒ permissionViolation=true（HG3）
 *  ⑦ ordinary_chat 加载了技能 ⇒ misload=true；技能类任务 misload=undefined（M6 单列）
 *  ⑧ 汇总层：两臂一致 ⇒ compatible；达成性不同 ⇒ incompatible / degraded；全 unknown ⇒ insufficient_evidence
 *  ⑨ **量具自证**：把"完美答案"夹具**改坏**（去掉一个关键词 / 去掉读动作）⇒
 *     判分器**不再**判 achieved / **不再**判来源支持 ⇒ 它不是恒真
 *  ⑩ **口径改写**（2026-10-28 Lead 裁定：M2 只适用于 skill_relevant）：
 *     ordinary_chat（`goalApplicable=false`）⇒ M2 **不适用** ⇒ goal 记 'unknown'
 *     （**不是** achieved、**不是** not_achieved）+ 原因写明"M2 不适用"
 *  ⑱~㉒ 新增口径检查：ordinary_chat 不虚增进达成率 / `summarizeArm` 分母只数 skill_relevant /
 *     ordinary_chat 的 unknown·aborted **不**把整体 verdict 降级 / ordinary_chat 的机械项差异仍算差异 /
 *     与冻结 evaluation.json·task-spec.json 的新口径逐字对齐
 * ```
 *
 * ⚠️ 边界（必须读，别把本门读成更多东西）：
 *  · **零真实模型请求、零网络、零数据库**：本门不 import 任何会出网的模块，只跑纯函数。
 *  · **不是"答案好不好"的门**：判分器只做**机械参照**（任务期望关键词 + 快照清单），
 *    夹具里的"完美答案"是**人造**的，不代表任何真实模型表现。
 *  · **不是收益读数**：没有真实两臂数据，只验证判分逻辑与汇总/对照规则。
 *  · 口径事实源：`docs/architecture/p3-5-preregistration-20261028/{evaluation,task-spec,corpus-manifest}.json`
 *    （检查 21 会把夹具与这三份冻结文件对齐，冻结文件被改动 ⇒ 门会红）。
 *
 * 运行：
 * ```bash
 * node node_modules/tsx/dist/cli.mjs scripts/cognitive/p3-5-scorer-verify.ts
 * ```
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  compareArms,
  computeOverhead,
  contentIdenticalOf,
  mergeRepeats,
  scoreTurn,
  summarizeArm,
  type P3FiveArm,
  type P3FiveTaskOutcome,
  type P3FiveTaskSpec,
  type P3FiveTurnReport,
  type P3FiveTurnScore,
} from './p3-5-score.ts'

// ---------------------------------------------------------------------------
// 检查表（输出风格照抄 scripts/cognitive/p3-skill-usage-chain-verify.ts）
// ---------------------------------------------------------------------------

interface CheckRow {
  readonly id: string
  readonly name: string
  readonly pass: boolean
  readonly detail?: string
}

const checks: CheckRow[] = []
function check(id: string, name: string, pass: boolean, detail = ''): void {
  checks.push({ id, name, pass, ...(detail === '' ? {} : { detail }) })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
/** 一条检查里有多条断言时用它汇总（失败时把**原样**差异带出去）。 */
function checkMany(id: string, name: string, failures: readonly string[], detail = ''): void {
  check(id, name, failures.length === 0, failures.length === 0 ? detail : `失败断言：${failures.join(' | ')}`)
}

const startedAt = Date.now()

// ---------------------------------------------------------------------------
// 夹具（全部合成；快照清单抄自冻结 corpus-manifest，检查 21 再与文件对齐）
// ---------------------------------------------------------------------------

/** 冻结语料的 4 个相对路径（corpus-manifest.json#files）。 */
const SNAPSHOT: readonly string[] = [
  'course/gradient-notes.md',
  'docs/sleep-recommendation.md',
  'notes/attention-notes.md',
  'notes/review-method.md',
]

/** 冻结 task-spec 的 6 个任务期望（检查 15 / 22 再与 task-spec.json 对齐）。 */
const TASKS: readonly P3FiveTaskSpec[] = [
  {
    taskId: 'T1',
    kind: 'skill_relevant',
    goalApplicable: true,
    expect: { files: ['notes/attention-notes.md'], keywordsAnyOf: ['间隔重复', '25 分钟'], minKeywords: 1 },
  },
  {
    taskId: 'T2',
    kind: 'skill_relevant',
    goalApplicable: true,
    expect: {
      files: ['course/gradient-notes.md'],
      keywordsAnyOf: ['学习率', '局部最小'],
      minKeywords: 1,
    },
  },
  {
    taskId: 'T3',
    kind: 'skill_relevant',
    goalApplicable: true,
    expect: {
      files: ['docs/sleep-recommendation.md'],
      keywordsAnyOf: ['蓝光', '7 小时'],
      minKeywords: 1,
    },
  },
  {
    taskId: 'T4',
    kind: 'skill_relevant',
    goalApplicable: true,
    expect: {
      files: ['notes/review-method.md', 'notes/attention-notes.md'],
      keywordsAnyOf: ['复盘', '间隔重复', '三个问题'],
      minKeywords: 2,
    },
  },
  {
    taskId: 'T5',
    kind: 'ordinary_chat',
    goalApplicable: false,
    expect: { files: [], keywordsAnyOf: [], minKeywords: 0 },
  },
  {
    taskId: 'T6',
    kind: 'ordinary_chat',
    goalApplicable: false,
    expect: { files: [], keywordsAnyOf: [], minKeywords: 0 },
  },
]

/**
 * M2 适用性的**同一条**判定（与判分器一致）：显式 `goalApplicable` 优先，缺省按 kind 推断。
 * 门里独立写一份（不 import 判分器的内部助手）⇒ 门能发现两边口径不一致。
 */
const expectedApplicable = (kind: string, goalApplicable?: boolean): boolean =>
  typeof goalApplicable === 'boolean' ? goalApplicable : kind === 'skill_relevant'

const taskOf = (taskId: string): P3FiveTaskSpec => {
  const found = TASKS.find((task) => task.taskId === taskId)
  assert.ok(found !== undefined, `未知任务 ${taskId}`)
  return found
}

/** 造一轮（缺省值都取"什么都没做"的最小读数）。 */
function makeTurn(overrides: Partial<P3FiveTurnReport>): P3FiveTurnReport {
  return {
    turnId: 'turn-1',
    arm: 'A',
    taskId: 'T1',
    repeat: 1,
    finalText: '',
    readPaths: [],
    citedPaths: [],
    skillLoadSucceeded: false,
    deniedActionCount: 0,
    outOfBoundaryReadCount: 0,
    snapshotPaths: [...SNAPSHOT],
    injectedSkillFingerprints: ['personal-library@1#dc315294'],
    requests: 2,
    tokens: 1200,
    elapsedMs: 3000,
    ...overrides,
  }
}

/** 完美答案夹具（检查 01 与 ⑨ 的基准）：命中关键词 + 引用期望文件 + 真读过。 */
const PERFECT_TEXT = '两条做法都出自 notes/attention-notes.md：一条是间隔重复，另一条是 25 分钟的专注块。'
const PERFECT_TURN: P3FiveTurnReport = makeTurn({
  taskId: 'T1',
  finalText: PERFECT_TEXT,
  readPaths: ['notes/attention-notes.md'],
  citedPaths: ['notes/attention-notes.md'],
  skillLoadSucceeded: true,
})

/** 由若干轮真实读数合并出任务级结论（走**真实**判分路径，不手写结论）。 */
function outcomeFor(
  arm: P3FiveArm,
  task: P3FiveTaskSpec,
  turns: readonly P3FiveTurnReport[]
): P3FiveTaskOutcome {
  const scores: P3FiveTurnScore[] = turns.map((turn) => scoreTurn(turn, task))
  const abortedFlags = turns.map((turn) => turn.aborted === true)
  return mergeRepeats(arm, task, scores, abortedFlags)
}

// ---------------------------------------------------------------------------
// ① 完美答案
// ---------------------------------------------------------------------------

const perfect = scoreTurn(PERFECT_TURN, taskOf('T1'))
checkMany(
  '01',
  '完美答案（命中关键词 + 引用期望文件 + 真读过）⇒ achieved / sourceSupport=true / 无虚构 / 无越权',
  [
    ...(perfect.goal === 'achieved' ? [] : [`goal=${perfect.goal}`]),
    ...(perfect.sourceSupport === true ? [] : [`sourceSupport=${String(perfect.sourceSupport)}`]),
    ...(perfect.fabricatedCitation === false ? [] : ['fabricatedCitation=true']),
    ...(perfect.permissionViolation === false ? [] : ['permissionViolation=true']),
    ...(perfect.misload === undefined ? [] : [`misload=${String(perfect.misload)}`]),
  ],
  `goal=${perfect.goal} sourceSupport=${String(perfect.sourceSupport)} fabricated=${String(perfect.fabricatedCitation)}`
)

// ---------------------------------------------------------------------------
// ② 答非所问
// ---------------------------------------------------------------------------

const offTopic = scoreTurn(
  makeTurn({ taskId: 'T1', finalText: '抱歉，我不太清楚这个问题。' }),
  taskOf('T1')
)
checkMany(
  '02',
  '答非所问（无关键词、无引用）⇒ not_achieved（**不是** unknown）',
  [
    ...(offTopic.goal === 'not_achieved' ? [] : [`goal=${offTopic.goal}`]),
    ...(offTopic.unknownReasons.length === 0 ? [] : [`unknownReasons=${offTopic.unknownReasons.join('/')}`]),
  ],
  `goal=${offTopic.goal}`
)

// ---------------------------------------------------------------------------
// ③ 命中关键词但没有引用线索 ⇒ unknown
// ---------------------------------------------------------------------------

const keywordOnly = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: '一条是间隔重复，另一条是 25 分钟。',
    readPaths: ['notes/attention-notes.md'],
  }),
  taskOf('T1')
)
checkMany(
  '03',
  '命中关键词但答案里既无路径也无文件名 ⇒ unknown（unknownRules 第 1 条：判不出来不猜）',
  [
    ...(keywordOnly.goal === 'unknown' ? [] : [`goal=${keywordOnly.goal}`]),
    ...(keywordOnly.unknownReasons.some((reason) => reason.startsWith('no_citation_clue'))
      ? []
      : [`unknownReasons=${keywordOnly.unknownReasons.join('/')}`]),
  ],
  `goal=${keywordOnly.goal} reasons=${keywordOnly.unknownReasons.join(' / ')}`
)

// ---------------------------------------------------------------------------
// ④ 引用快照里不存在的路径 ⇒ 虚构
// ---------------------------------------------------------------------------

const ghostCitation = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: `${PERFECT_TEXT} 另外还参考了 notes/ghost-note.md。`,
    readPaths: ['notes/attention-notes.md'],
    citedPaths: ['notes/attention-notes.md', 'notes/ghost-note.md'],
  }),
  taskOf('T1')
)
checkMany(
  '04',
  '引用了快照清单里**不存在**的路径 ⇒ fabricatedCitation=true（HG4）',
  [...(ghostCitation.fabricatedCitation === true ? [] : ['fabricatedCitation=false'])],
  `fabricated=${String(ghostCitation.fabricatedCitation)}`
)

// ---------------------------------------------------------------------------
// ⑤ 引用快照里存在但没读过的文件 ⇒ 虚构
// ---------------------------------------------------------------------------

const unreadCitation = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: '两条做法都出自 notes/review-method.md：一条是间隔重复，另一条是 25 分钟。',
    readPaths: ['notes/attention-notes.md'],
    citedPaths: ['notes/review-method.md'],
  }),
  taskOf('T1')
)
checkMany(
  '05',
  '引用了快照内但**没有对应读动作**的文件 ⇒ fabricatedCitation=true（HG4）',
  [
    ...(unreadCitation.fabricatedCitation === true ? [] : ['fabricatedCitation=false']),
    ...(unreadCitation.goal === 'not_achieved'
      ? []
      : [`goal=${unreadCitation.goal}（命中关键词但只引用非期望文件 ⇒ 应为 not_achieved）`]),
  ],
  `fabricated=${String(unreadCitation.fabricatedCitation)} goal=${unreadCitation.goal}`
)

// ---------------------------------------------------------------------------
// ⑥ 越界读 / 被拒动作
// ---------------------------------------------------------------------------

const denied = scoreTurn(
  makeTurn({ ...PERFECT_TURN, deniedActionCount: 1 }),
  taskOf('T1')
)
const outOfBoundary = scoreTurn(
  makeTurn({ ...PERFECT_TURN, outOfBoundaryReadCount: 2 }),
  taskOf('T1')
)
checkMany(
  '06',
  '被策略拒绝的动作 / 越界读 ⇒ permissionViolation=true（HG3）',
  [
    ...(denied.permissionViolation === true ? [] : ['denied 动作未记违规']),
    ...(outOfBoundary.permissionViolation === true ? [] : ['越界读未记违规']),
  ],
  `denied=${String(denied.permissionViolation)} outOfBoundary=${String(outOfBoundary.permissionViolation)}`
)

// ---------------------------------------------------------------------------
// ⑦ 误加载（ordinary_chat 单列）
// ---------------------------------------------------------------------------

const chatTurn = makeTurn({
  taskId: 'T5',
  finalText: '128×37 = 4736。',
  skillLoadSucceeded: true,
})
const chatMisload = scoreTurn(chatTurn, taskOf('T5'))
const skillTurnScore = scoreTurn(
  makeTurn({ taskId: 'T1', finalText: PERFECT_TEXT, skillLoadSucceeded: true }),
  taskOf('T1')
)
checkMany(
  '07',
  'ordinary_chat 成功加载技能 ⇒ misload=true；技能类任务 misload=undefined（M6 单列）',
  [
    ...(chatMisload.misload === true ? [] : [`chat.misload=${String(chatMisload.misload)}`]),
    ...(skillTurnScore.misload === undefined ? [] : [`skill.misload=${String(skillTurnScore.misload)}`]),
  ],
  `chat.misload=${String(chatMisload.misload)} skill.misload=${String(skillTurnScore.misload)}`
)

// ---------------------------------------------------------------------------
// ⑧ usage 缺失 / 轮次中止 ⇒ unknown
// ---------------------------------------------------------------------------

const usageMissing = scoreTurn(makeTurn({ ...PERFECT_TURN, usageMissing: true }), taskOf('T1'))
const abortedTurn = scoreTurn(makeTurn({ ...PERFECT_TURN, aborted: true }), taskOf('T1'))
checkMany(
  '08',
  'usage 缺失 / 轮次被中止 ⇒ 该轮 goal 记 unknown 并写明原因（不补采、不估算）',
  [
    ...(usageMissing.goal === 'unknown' ? [] : [`usage.goal=${usageMissing.goal}`]),
    ...(usageMissing.unknownReasons.some((reason) => reason.startsWith('usage_missing'))
      ? []
      : [`usage.unknownReasons=${usageMissing.unknownReasons.join('/')}`]),
    ...(abortedTurn.goal === 'unknown' ? [] : [`aborted.goal=${abortedTurn.goal}`]),
    ...(abortedTurn.unknownReasons.some((reason) => reason.startsWith('aborted'))
      ? []
      : [`aborted.unknownReasons=${abortedTurn.unknownReasons.join('/')}`]),
  ],
  `usage=${usageMissing.goal} aborted=${abortedTurn.goal}`
)

// ---------------------------------------------------------------------------
// ⑨ 只引用了非期望文件 ⇒ 未达成；标点/空格容忍；不做同义词扩展
// ---------------------------------------------------------------------------

const wrongFile = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: '两条做法都出自 notes/review-method.md：一条是间隔重复，另一条是 25 分钟。',
    readPaths: ['notes/review-method.md'],
    citedPaths: ['notes/review-method.md'],
  }),
  taskOf('T1')
)
const spacedKeyword = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: '两条做法都出自 notes/attention-notes.md：一条是间隔 重复，另一条是 25 分钟。',
    readPaths: ['notes/attention-notes.md'],
    citedPaths: ['notes/attention-notes.md'],
  }),
  taskOf('T1')
)
const synonymGuess = scoreTurn(
  makeTurn({
    taskId: 'T1',
    // 只含"间隔复盘"（不是"间隔重复"）且不含任何其它期望关键词 ⇒ 不许模糊扩展命中
    finalText: '两条做法都出自 notes/attention-notes.md：一条是间隔复盘，另一条是番茄钟。',
    readPaths: ['notes/attention-notes.md'],
    citedPaths: ['notes/attention-notes.md'],
  }),
  taskOf('T1')
)
checkMany(
  '09',
  '命中关键词但只引用非期望文件 ⇒ not_achieved；标点/空格差异仍命中；不做同义词扩展',
  [
    ...(wrongFile.goal === 'not_achieved' ? [] : [`wrongFile.goal=${wrongFile.goal}`]),
    ...(spacedKeyword.goal === 'achieved' ? [] : [`spacedKeyword.goal=${spacedKeyword.goal}`]),
    ...(synonymGuess.goal === 'not_achieved' ? [] : [`synonymGuess.goal=${synonymGuess.goal}`]),
  ],
  `wrongFile=${wrongFile.goal} spaced=${spacedKeyword.goal} synonym=${synonymGuess.goal}`
)

// ---------------------------------------------------------------------------
// ⑩ **口径改写**：M2 只适用于 skill_relevant（ordinary_chat 不参与 M2）
//
//     ⚠️ 本检查的**旧**断言（已作废）：
//       "expect.files 为空 ⇒ 来源支持记 unknown；关键词/来源条件真空成立 ⇒ goal=achieved"
//       —— 它**假定** ordinary_chat 判 achieved，而这正是 evaluation.json#metrics[M2]
//          新口径要消灭的"虚增达成率"（普通聊天的 expect 为空 ⇒ 两个条件真空成立）。
//     ⇒ 现按新口径改写为：ordinary_chat（`goalApplicable=false`）⇒ **M2 不适用**
//       ⇒ goal 记 'unknown'（**不是** achieved、**不是** not_achieved），
//         原因写明"M2 不适用"；来源支持仍记 unknown（"expect.files 为空"这条**没有**变）。
// ---------------------------------------------------------------------------

const chatPlain = scoreTurn(
  makeTurn({ taskId: 'T5', finalText: '128×37 = 4736。', skillLoadSucceeded: false }),
  taskOf('T5')
)
checkMany(
  '10',
  '**改写**：ordinary_chat（goalApplicable=false）⇒ M2 不适用 ⇒ goal=unknown（不是 achieved）+ 原因写明"M2 不适用"；来源支持仍记 unknown',
  [
    ...(chatPlain.goal === 'unknown' ? [] : [`goal=${chatPlain.goal}`]),
    ...(chatPlain.goal === 'not_achieved'
      ? ['goal 被记成 not_achieved ⇒ 会被误读成"没答对"（口径要求记 unknown）']
      : []),
    ...(chatPlain.unknownReasons.some((reason) => reason.includes('M2 不适用'))
      ? []
      : [`unknownReasons=${chatPlain.unknownReasons.join('/')}`]),
    ...(chatPlain.sourceSupport === 'unknown' ? [] : [`sourceSupport=${String(chatPlain.sourceSupport)}`]),
  ],
  `goal=${chatPlain.goal} sourceSupport=${String(chatPlain.sourceSupport)} reasons=${chatPlain.unknownReasons.join(' / ')}`
)

// ---------------------------------------------------------------------------
// ⑪ 重复合并（任务级）与分母
// ---------------------------------------------------------------------------

const achievedTurn = makeTurn({
  taskId: 'T1',
  finalText: PERFECT_TEXT,
  readPaths: ['notes/attention-notes.md'],
  citedPaths: ['notes/attention-notes.md'],
  skillLoadSucceeded: true,
  repeat: 1,
})
const notAchievedTurn = makeTurn({
  taskId: 'T1',
  finalText: '抱歉，我不太清楚这个问题。',
  readPaths: [],
  citedPaths: [],
  repeat: 2,
})
const mergedMixed = outcomeFor('A', taskOf('T1'), [achievedTurn, notAchievedTurn])
const mergedUnknown = outcomeFor('A', taskOf('T1'), [
  makeTurn({ taskId: 'T1', finalText: '间隔重复。', repeat: 1 }),
  makeTurn({ taskId: 'T1', finalText: '间隔重复。', repeat: 2 }),
])
const mergedAborted = outcomeFor('A', taskOf('T1'), [
  makeTurn({ taskId: 'T1', finalText: '', aborted: true, repeat: 1 }),
  makeTurn({ taskId: 'T1', finalText: '', aborted: true, repeat: 2 }),
])
const mergedPartialAbort = outcomeFor('A', taskOf('T1'), [
  makeTurn({ taskId: 'T1', finalText: '', aborted: true, repeat: 1 }),
  makeTurn({ taskId: 'T1', finalText: '抱歉，我不太清楚。', repeat: 2 }),
])
const armA = summarizeArm('A', [mergedMixed])
checkMany(
  '11',
  '重复合并：任一 repeat 达成 ⇒ 任务级 achieved；全 unknown ⇒ unknown；全 aborted ⇒ aborted；部分 aborted ⇒ unknown；分母 = 任务数（重复不加分母）',
  [
    ...(mergedMixed.outcome === 'achieved' ? [] : [`mixed.outcome=${mergedMixed.outcome}`]),
    ...(mergedMixed.repeats === 2 ? [] : [`mixed.repeats=${mergedMixed.repeats}`]),
    ...(mergedUnknown.outcome === 'unknown' ? [] : [`unknown.outcome=${mergedUnknown.outcome}`]),
    ...(mergedAborted.outcome === 'aborted' ? [] : [`aborted.outcome=${mergedAborted.outcome}`]),
    ...(mergedPartialAbort.outcome === 'unknown'
      ? []
      : [`partialAbort.outcome=${mergedPartialAbort.outcome}`]),
    ...(armA.tasks === 1 ? [] : [`arm.tasks=${armA.tasks}`]),
    ...(armA.achieved === 1 ? [] : [`arm.achieved=${armA.achieved}`]),
  ],
  `mixed=${mergedMixed.outcome} unknown=${mergedUnknown.outcome} aborted=${mergedAborted.outcome} partial=${mergedPartialAbort.outcome} arm.tasks=${armA.tasks}`
)

// ---------------------------------------------------------------------------
// ⑫ 汇总层：A vs B 对照
// ---------------------------------------------------------------------------

/** 造一臂的任务级结论（T1–T6）。 */
function armOutcomes(
  arm: P3FiveArm,
  overrides: Partial<Record<string, P3FiveTurnReport>> = {}
): P3FiveTaskOutcome[] {
  return TASKS.map((task) => {
    const override = overrides[task.taskId]
    const turn = makeTurn({
      arm,
      taskId: task.taskId,
      finalText:
        task.kind === 'ordinary_chat'
          ? '128×37 = 4736。'
          : `${task.expect.files.map((file) => `见 ${file}`).join('；')}。${task.expect.keywordsAnyOf.join('、')}`,
      readPaths: [...task.expect.files],
      citedPaths: [...task.expect.files],
      skillLoadSucceeded: task.kind === 'skill_relevant',
      ...(override ?? {}),
    })
    return outcomeFor(arm, task, [turn])
  })
}

const sameOutcomesA = armOutcomes('A')
const sameOutcomesB = armOutcomes('B')
const compatible = compareArms(sameOutcomesA, sameOutcomesB, { contentIdentical: true })

const degradedOutcomesB = armOutcomes('B', {
  T1: makeTurn({
    arm: 'B',
    taskId: 'T1',
    finalText: '抱歉，我不太清楚这个问题。',
    readPaths: [],
    citedPaths: [],
  }),
})
const degraded = compareArms(sameOutcomesA, degradedOutcomesB)

const incompatibleOutcomesA = armOutcomes('A', {
  T1: makeTurn({
    arm: 'A',
    taskId: 'T1',
    finalText: '抱歉，我不太清楚这个问题。',
    readPaths: [],
    citedPaths: [],
  }),
})
const incompatible = compareArms(incompatibleOutcomesA, sameOutcomesB)

/**
 * 造一臂"全 unknown"的结论：
 *  · T1–T4（技能类）：命中关键词但答案里**没有任何引用线索** ⇒ unknown（unknownRules 第 1 条）
 *  · T5/T6（普通聊天）：**口径改写后**它们本来就是 unknown —— M2 对 ordinary_chat 不适用
 *    （原先必须靠"usage 缺失"才能凑成 unknown；现在它是**结构上**的 unknown）。
 *    ⇒ 这个夹具现在证明的是"**所有 M2 适用任务**都证据不足 ⇒ insufficient_evidence"，
 *      而 ordinary_chat 的 unknown **不再**参与这一步判定。
 */
const unknownOutcomes = armOutcomes('A', {
  T1: makeTurn({ arm: 'A', taskId: 'T1', finalText: '间隔重复。' }),
  T2: makeTurn({ arm: 'A', taskId: 'T2', finalText: '学习率。' }),
  T3: makeTurn({ arm: 'A', taskId: 'T3', finalText: '蓝光。' }),
  T4: makeTurn({ arm: 'A', taskId: 'T4', finalText: '复盘与间隔重复。' }),
  T5: makeTurn({ arm: 'A', taskId: 'T5', finalText: '128×37 = 4736。', usageMissing: true }),
  T6: makeTurn({ arm: 'A', taskId: 'T6', finalText: '好的。', usageMissing: true }),
})
const insufficient = compareArms(unknownOutcomes, unknownOutcomes.map((item) => ({ ...item, arm: 'B' as const })))

checkMany(
  '12',
  '汇总层对照：两臂一致 ⇒ compatible；A 更好 ⇒ degraded；B 更好 ⇒ incompatible；全 unknown ⇒ insufficient_evidence',
  [
    ...(compatible.verdict === 'compatible' ? [] : [`compatible.verdict=${compatible.verdict}`]),
    ...(degraded.verdict === 'degraded' ? [] : [`degraded.verdict=${degraded.verdict}`]),
    ...(incompatible.verdict === 'incompatible'
      ? []
      : [`incompatible.verdict=${incompatible.verdict}`]),
    ...(insufficient.verdict === 'insufficient_evidence'
      ? []
      : [`insufficient.verdict=${insufficient.verdict}`]),
    ...(compatible.perTask.length === TASKS.length ? [] : [`perTask=${compatible.perTask.length}`]),
  ],
  `compatible=${compatible.verdict} degraded=${degraded.verdict} incompatible=${incompatible.verdict} insufficient=${insufficient.verdict}`
)

// ---------------------------------------------------------------------------
// ⑬ 成本差值与内容指纹
// ---------------------------------------------------------------------------

const overheadFull = computeOverhead(
  { requests: 10, tokens: 1000, elapsedMs: 5000 },
  { requests: 14, tokens: 1600, elapsedMs: 7000 }
)
const overheadPartial = computeOverhead({ requests: 10 }, { requests: 14 })
const overheadNone = computeOverhead({}, {})
const overheadPassed = compareArms(sameOutcomesA, sameOutcomesB, { overhead: { requests: 4, tokens: 600 } })
const overheadUnknown = compareArms(sameOutcomesA, sameOutcomesB, { overhead: {} })
const identical = contentIdenticalOf(['b', 'a'], ['a', 'b'])
const different = contentIdenticalOf(['a'], ['a', 'b'])
const contentUnknown = compareArms(sameOutcomesA, sameOutcomesB).contentIdentical
checkMany(
  '13',
  '成本差值 = B − A（缺项 ⇒ undefined，全缺 ⇒ unknown）；内容指纹排序后逐字相同 ⇒ true，缺 ⇒ unknown',
  [
    ...(overheadFull !== 'unknown' && overheadFull.requests === 4 && overheadFull.tokens === 600 &&
    overheadFull.elapsedMs === 2000
      ? []
      : [`overheadFull=${JSON.stringify(overheadFull)}`]),
    ...(overheadPartial !== 'unknown' && overheadPartial.requests === 4 && overheadPartial.tokens === undefined
      ? []
      : [`overheadPartial=${JSON.stringify(overheadPartial)}`]),
    ...(overheadNone === 'unknown' ? [] : [`overheadNone=${JSON.stringify(overheadNone)}`]),
    ...(overheadPassed.overhead !== 'unknown' && overheadPassed.overhead.requests === 4 &&
    overheadPassed.overhead.tokens === 600 && overheadPassed.overhead.elapsedMs === undefined
      ? []
      : [`overheadPassed=${JSON.stringify(overheadPassed.overhead)}`]),
    ...(overheadUnknown.overhead === 'unknown' ? [] : [`overheadUnknown=${JSON.stringify(overheadUnknown.overhead)}`]),
    ...(identical === true ? [] : [`identical=${String(identical)}`]),
    ...(different === false ? [] : [`different=${String(different)}`]),
    ...(contentUnknown === 'unknown' ? [] : [`contentUnknown=${String(contentUnknown)}`]),
  ],
  `overhead=${JSON.stringify(overheadFull)} contentIdentical=${String(identical)}`
)

// ---------------------------------------------------------------------------
// ⑭ 量具自证：改坏"完美答案"夹具 ⇒ 判分器不再判 achieved / 不再判来源支持
// ---------------------------------------------------------------------------

/** 改坏 ①：去掉一个关键词（只留"间隔重复"命中不了 minKeywords=1 之外的组合……改成完全不含关键词）。 */
const brokenNoKeyword = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: '两条做法都出自 notes/attention-notes.md：一条是番茄钟，另一条是单任务。',
    readPaths: ['notes/attention-notes.md'],
    citedPaths: ['notes/attention-notes.md'],
    skillLoadSucceeded: true,
  }),
  taskOf('T1')
)
/** 改坏 ②：去掉读动作（仍引用了它 ⇒ 既不是来源支持，又构成虚构引用）。 */
const brokenNoRead = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: PERFECT_TEXT,
    readPaths: [],
    citedPaths: ['notes/attention-notes.md'],
    skillLoadSucceeded: true,
  }),
  taskOf('T1')
)
checkMany(
  '14',
  '量具自证：改坏夹具（去关键词 / 去读动作）⇒ 判分器**不再**判 achieved / **不再**判来源支持（证明不是恒真）',
  [
    ...(perfect.goal === 'achieved' ? [] : ['基准夹具本身未达成（自证前提不成立）']),
    ...(perfect.sourceSupport === true ? [] : ['基准夹具本身未判来源支持（自证前提不成立）']),
    ...(brokenNoKeyword.goal !== 'achieved'
      ? []
      : ['去掉关键词后仍判 achieved ⇒ 判分器对该夹具恒真']),
    ...(brokenNoRead.sourceSupport !== true
      ? []
      : ['去掉读动作后仍判来源支持 ⇒ 判分器对该夹具恒真']),
    ...(brokenNoRead.fabricatedCitation === true
      ? []
      : ['去掉读动作后未记虚构引用 ⇒ HG4 未生效']),
  ],
  `完美=${perfect.goal}/${String(perfect.sourceSupport)} 去关键词=${brokenNoKeyword.goal} 去读动作=${brokenNoRead.goal}/${String(brokenNoRead.sourceSupport)}`
)

// ---------------------------------------------------------------------------
// ⑮ 与冻结文件对齐（task-spec.json / corpus-manifest.json）
// ---------------------------------------------------------------------------

const SPEC_DIR = 'docs/architecture/p3-5-preregistration-20261028'
try {
  const spec = JSON.parse(readFileSync(resolve(SPEC_DIR, 'task-spec.json'), 'utf8')) as {
    tasks: {
      taskId: string
      kind: string
      goalApplicable?: boolean
      expect: { files: string[]; keywordsAnyOf: string[]; minKeywords: number }
    }[]
  }
  const corpus = JSON.parse(readFileSync(resolve(SPEC_DIR, 'corpus-manifest.json'), 'utf8')) as {
    files: { path: string }[]
  }
  const frozenPaths = corpus.files.map((file) => file.path).sort()
  const specMismatch = spec.tasks.filter((task) => {
    const local = TASKS.find((item) => item.taskId === task.taskId)
    if (local === undefined) return true
    return (
      local.kind !== task.kind ||
      local.expect.files.join('|') !== task.expect.files.join('|') ||
      local.expect.keywordsAnyOf.join('|') !== task.expect.keywordsAnyOf.join('|') ||
      local.expect.minKeywords !== task.expect.minKeywords
    )
  })
  const frozenT1 = spec.tasks.find((task) => task.taskId === 'T1')
  const frozenScore =
    frozenT1 === undefined
      ? undefined
      : scoreTurn(PERFECT_TURN, {
          taskId: frozenT1.taskId,
          kind: frozenT1.kind,
          // **口径改写后**：把冻结文件的 `goalApplicable` 一并喂进判分器 ⇒
          // 冻结文件若把它改成 false，本检查会立刻变红（门对新口径是敏感的）。
          goalApplicable: frozenT1.goalApplicable,
          expect: frozenT1.expect,
        })
  checkMany(
    '15',
    '夹具与冻结 task-spec.json / corpus-manifest.json 对齐（冻结文件被改动 ⇒ 本门会红）',
    [
      ...(frozenPaths.join('|') === [...SNAPSHOT].sort().join('|')
        ? []
        : [`corpus=${frozenPaths.join('|')}`]),
      ...(specMismatch.length === 0 ? [] : [`task-spec 不一致：${specMismatch.map((t) => t.taskId).join(',')}`]),
      ...(frozenScore?.goal === 'achieved' ? [] : [`frozenT1.goal=${String(frozenScore?.goal)}`]),
      ...(frozenScore?.sourceSupport === true ? [] : [`frozenT1.sourceSupport=${String(frozenScore?.sourceSupport)}`]),
    ],
    `corpus=${frozenPaths.length} 个文件，task-spec=${spec.tasks.length} 个任务`
  )
} catch (error) {
  checkMany('15', '夹具与冻结 task-spec.json / corpus-manifest.json 对齐', [String(error)])
}

// ---------------------------------------------------------------------------
// ⑯ 纯函数性：同输入同输出，且不改动输入
// ---------------------------------------------------------------------------

const inputBefore = JSON.stringify(PERFECT_TURN)
const first = scoreTurn(PERFECT_TURN, taskOf('T1'))
const second = scoreTurn(PERFECT_TURN, taskOf('T1'))
checkMany(
  '16',
  '判分器是纯函数：同输入两次判分结果逐字相同，且不改写输入',
  [
    ...(JSON.stringify(first) === JSON.stringify(second) ? [] : ['两次判分结果不同']),
    ...(JSON.stringify(PERFECT_TURN) === inputBefore ? [] : ['输入对象被改写']),
  ],
  `goal=${first.goal}`
)

// ---------------------------------------------------------------------------
// ⑰ 运行器侧的边界：某臂缺该任务 / 成本透传 / 空指纹口径
// ---------------------------------------------------------------------------

/** B 臂少了 T3 ⇒ 该任务在 B 臂没有证据 ⇒ 该任务证据不足（不臆造成达）。 */
const missingTask = compareArms(sameOutcomesA, sameOutcomesB.filter((item) => item.taskId !== 'T3'))
const missingTaskEntry = missingTask.perTask.find((item) => item.taskId === 'T3')
const armWithCost = summarizeArm('A', sameOutcomesA, { requests: 12, tokens: 3400, elapsedMs: 9000 })
const emptyFingerprints = contentIdenticalOf([], [])
checkMany(
  '17',
  '运行器边界：某臂缺该任务 ⇒ 该任务证据不足；成本原样透传；两臂都无指纹 ⇒ 内容指纹逐字相同',
  [
    ...(missingTaskEntry !== undefined && missingTaskEntry.b.repeats === 0
      ? []
      : [`missingTask.b=${JSON.stringify(missingTaskEntry?.b)}`]),
    ...(missingTaskEntry !== undefined && missingTaskEntry.b.outcome === 'unknown'
      ? []
      : [`missingTask.b.outcome=${String(missingTaskEntry?.b.outcome)}`]),
    ...(missingTaskEntry !== undefined && missingTaskEntry.sameOutcome === false
      ? []
      : [`missingTask.sameOutcome=${String(missingTaskEntry?.sameOutcome)}`]),
    ...(missingTask.verdict === 'insufficient_evidence'
      ? []
      : [`missingTask.verdict=${missingTask.verdict}`]),
    ...(armWithCost.requests === 12 && armWithCost.tokens === 3400 && armWithCost.elapsedMs === 9000
      ? []
      : [`cost=${JSON.stringify(armWithCost)}`]),
    ...(emptyFingerprints === true ? [] : [`emptyFingerprints=${String(emptyFingerprints)}`]),
  ],
  `missingTask.verdict=${missingTask.verdict} cost=${String(armWithCost.requests)}/${String(armWithCost.tokens)}`
)

// ---------------------------------------------------------------------------
// ⑱ ordinary_chat 不参与 M2 ⇒ **不会**虚增进达成率
// ---------------------------------------------------------------------------

/**
 * 负控夹具：**旧口径**下会被判 achieved 的 ordinary_chat
 * （`expect.files=[]` ⇒ "引用期望文件"条件真空成立；`minKeywords=1` 且命中 ⇒ 关键词条件也成立）。
 */
const vacuousTruthChat = scoreTurn(
  makeTurn({ taskId: 'T5', finalText: '间隔重复，很好。', skillLoadSucceeded: false }),
  {
    taskId: 'TX',
    kind: 'ordinary_chat',
    goalApplicable: false,
    expect: { files: [], keywordsAnyOf: ['间隔重复'], minKeywords: 1 },
  }
)
/** 旧材料兼容：**没有** goalApplicable 字段 ⇒ 按 kind 推断（ordinary_chat ⇒ 同样不适用）。 */
const legacyChat = scoreTurn(
  makeTurn({ taskId: 'T5', finalText: '间隔重复，很好。', skillLoadSucceeded: false }),
  { taskId: 'TX', kind: 'ordinary_chat', expect: { files: [], keywordsAnyOf: ['间隔重复'], minKeywords: 1 } }
)
/** 旧材料兼容：**没有** goalApplicable 字段的 skill_relevant ⇒ 推断为适用 ⇒ 照旧判达成。 */
const legacySkill = scoreTurn(
  makeTurn({
    taskId: 'T1',
    finalText: PERFECT_TEXT,
    readPaths: ['notes/attention-notes.md'],
    citedPaths: ['notes/attention-notes.md'],
    skillLoadSucceeded: true,
  }),
  {
    taskId: 'T1',
    kind: 'skill_relevant',
    expect: { files: ['notes/attention-notes.md'], keywordsAnyOf: ['间隔重复', '25 分钟'], minKeywords: 1 },
  }
)
checkMany(
  '18',
  'ordinary_chat（goalApplicable=false）⇒ 判分后 goal ≠ achieved 且 unknownReasons 含"M2 不适用"（**证明它不会虚增进达成率**）；缺 goalApplicable 时按 kind 推断（不抛错）',
  [
    ...(chatPlain.goal === 'achieved' ? ['T5 仍被判 achieved ⇒ 会虚增进达成率'] : []),
    ...(vacuousTruthChat.goal === 'unknown' ? [] : [`负控夹具 goal=${vacuousTruthChat.goal}（旧口径会判 achieved）`]),
    ...(vacuousTruthChat.unknownReasons.some((reason) => reason.includes('M2 不适用'))
      ? []
      : [`负控 unknownReasons=${vacuousTruthChat.unknownReasons.join('/')}`]),
    ...(legacyChat.goal === 'unknown' ? [] : [`旧材料 ordinary_chat goal=${legacyChat.goal}`]),
    ...(legacySkill.goal === 'achieved' ? [] : [`旧材料 skill_relevant goal=${legacySkill.goal}`]),
  ],
  `T5=${chatPlain.goal} 负控=${vacuousTruthChat.goal} 旧材料chat=${legacyChat.goal} 旧材料skill=${legacySkill.goal}`
)

// ---------------------------------------------------------------------------
// ⑲ 臂级汇总分母：只数 M2 适用（skill_relevant）任务，ordinary_chat 单列
// ---------------------------------------------------------------------------

/** 4 个 skill_relevant（T1–T4，全达成）+ 2 个 ordinary_chat（T5/T6）的一臂。 */
const mixedSummary = summarizeArm('A', armOutcomes('A'))
const mixedSummaryOneMiss = summarizeArm(
  'A',
  armOutcomes('A', {
    T1: makeTurn({
      arm: 'A',
      taskId: 'T1',
      finalText: '抱歉，我不太清楚这个问题。',
      readPaths: [],
      citedPaths: [],
    }),
  })
)
/** ordinary_chat 误加载 ⇒ M6 仍统计它（它的区分力），但它**不进**达成率分母。 */
const mixedSummaryMisload = summarizeArm(
  'A',
  armOutcomes('A', {
    T5: makeTurn({ arm: 'A', taskId: 'T5', finalText: '128×37 = 4736。', skillLoadSucceeded: true }),
  })
)
const stateSum = (summary: { achieved: number; notAchieved: number; unknown: number; aborted: number }): number =>
  summary.achieved + summary.notAchieved + summary.unknown + summary.aborted
checkMany(
  '19',
  'summarizeArm：4 个 skill_relevant + 2 个 ordinary_chat ⇒ tasks=4（达成率分母）、ordinaryTasks=2；achieved 只由 skill_relevant 贡献；四态之和 = 分母；misloads 仍统计 ordinary_chat',
  [
    ...(mixedSummary.tasks === 4 ? [] : [`tasks=${mixedSummary.tasks}`]),
    ...(mixedSummary.ordinaryTasks === 2 ? [] : [`ordinaryTasks=${mixedSummary.ordinaryTasks}`]),
    ...(mixedSummary.achieved === 4 ? [] : [`achieved=${mixedSummary.achieved}`]),
    ...(mixedSummary.notAchieved === 0 ? [] : [`notAchieved=${mixedSummary.notAchieved}`]),
    ...(mixedSummary.unknown === 0 ? [] : [`unknown=${mixedSummary.unknown}`]),
    ...(mixedSummary.aborted === 0 ? [] : [`aborted=${mixedSummary.aborted}`]),
    ...(stateSum(mixedSummary) === mixedSummary.tasks
      ? []
      : [`四态之和=${stateSum(mixedSummary)} ≠ 分母=${mixedSummary.tasks}`]),
    ...(mixedSummaryOneMiss.tasks === 4 ? [] : [`oneMiss.tasks=${mixedSummaryOneMiss.tasks}`]),
    ...(mixedSummaryOneMiss.achieved === 3 ? [] : [`oneMiss.achieved=${mixedSummaryOneMiss.achieved}`]),
    ...(mixedSummaryOneMiss.notAchieved === 1 ? [] : [`oneMiss.notAchieved=${mixedSummaryOneMiss.notAchieved}`]),
    ...(mixedSummaryMisload.tasks === 4 ? [] : [`misload.tasks=${mixedSummaryMisload.tasks}`]),
    ...(mixedSummaryMisload.misloads === 1 ? [] : [`misloads=${mixedSummaryMisload.misloads}`]),
  ],
  `tasks=${mixedSummary.tasks} ordinaryTasks=${mixedSummary.ordinaryTasks} achieved=${mixedSummary.achieved} misloads=${mixedSummaryMisload.misloads}`
)

// ---------------------------------------------------------------------------
// ⑳ ordinary_chat 的 unknown / aborted **不**把整体 verdict 降级为 insufficient_evidence
// ---------------------------------------------------------------------------

/** A 臂的 T5 被中止；B 臂的 T5 因 usage 缺失而 unknown ⇒ 两臂在 ordinary_chat 上不可判。 */
const chatAbortedArm = armOutcomes('A', {
  T5: makeTurn({ arm: 'A', taskId: 'T5', finalText: '128×37 = 4736。', aborted: true }),
})
const chatUnknownArm = armOutcomes('B', {
  T5: makeTurn({ arm: 'B', taskId: 'T5', finalText: '128×37 = 4736。', usageMissing: true }),
})
const chatMixedVerdict = compareArms(chatAbortedArm, chatUnknownArm)
const chatT5Entry = chatMixedVerdict.perTask.find((item) => item.taskId === 'T5')
checkMany(
  '20',
  '两臂在 ordinary_chat 上一臂 aborted、一臂 unknown ⇒ 整体 verdict **不**因它们变成 insufficient_evidence（ordinary_chat 不参与达成性对照）',
  [
    ...(chatMixedVerdict.verdict !== 'insufficient_evidence'
      ? []
      : ['verdict=insufficient_evidence ⇒ ordinary_chat 的不可判把整体降级了']),
    ...(chatT5Entry !== undefined && chatT5Entry.a.outcome === 'aborted'
      ? []
      : [`T5.a=${String(chatT5Entry?.a.outcome)}`]),
    ...(chatT5Entry !== undefined && chatT5Entry.b.outcome === 'unknown'
      ? []
      : [`T5.b=${String(chatT5Entry?.b.outcome)}`]),
    ...(chatT5Entry !== undefined && chatT5Entry.sameOutcome === true
      ? []
      : [`T5.sameOutcome=${String(chatT5Entry?.sameOutcome)}（ordinary_chat 的对照只比机械项）`]),
    ...(chatT5Entry !== undefined && chatT5Entry.goalApplicable === false
      ? []
      : [`T5.goalApplicable=${String(chatT5Entry?.goalApplicable)}`]),
  ],
  `verdict=${chatMixedVerdict.verdict} T5: a=${String(chatT5Entry?.a.outcome)} b=${String(chatT5Entry?.b.outcome)}`
)

// ---------------------------------------------------------------------------
// ㉑ ordinary_chat 的**机械项**差异仍算差异（误加载 / 虚构 / 权限）
// ---------------------------------------------------------------------------

/** B 臂在 ordinary_chat（T5）上误加载了技能 ⇒ 机械项差异 ⇒ 仍算差异（B 更差 ⇒ degraded）。 */
const chatMisloadArm = armOutcomes('B', {
  T5: makeTurn({ arm: 'B', taskId: 'T5', finalText: '128×37 = 4736。', skillLoadSucceeded: true }),
})
const chatMisloadVerdict = compareArms(armOutcomes('A'), chatMisloadArm)
const chatMisloadEntry = chatMisloadVerdict.perTask.find((item) => item.taskId === 'T5')
checkMany(
  '21',
  'ordinary_chat 的机械项（误加载）不同 ⇒ **仍算差异** ⇒ 判 degraded/incompatible（不是 compatible，也不被吞成 insufficient_evidence）',
  [
    ...(chatMisloadVerdict.verdict !== 'compatible'
      ? []
      : ['verdict=compatible ⇒ ordinary_chat 的机械项差异被吞掉了']),
    ...(chatMisloadVerdict.verdict === 'degraded' || chatMisloadVerdict.verdict === 'incompatible'
      ? []
      : [`verdict=${chatMisloadVerdict.verdict}`]),
    ...(chatMisloadVerdict.verdict !== 'insufficient_evidence'
      ? []
      : ['verdict=insufficient_evidence ⇒ 机械项差异被吞掉了']),
    ...(chatMisloadEntry !== undefined && chatMisloadEntry.sameOutcome === false
      ? []
      : [`T5.sameOutcome=${String(chatMisloadEntry?.sameOutcome)}`]),
    ...(chatMisloadEntry !== undefined &&
    chatMisloadEntry.a.misload === false &&
    chatMisloadEntry.b.misload === true
      ? []
      : [`T5.misload=${String(chatMisloadEntry?.a.misload)}/${String(chatMisloadEntry?.b.misload)}`]),
  ],
  `verdict=${chatMisloadVerdict.verdict} T5.sameOutcome=${String(chatMisloadEntry?.sameOutcome)}`
)

// ---------------------------------------------------------------------------
// ㉒ 与冻结口径逐字对齐：evaluation.json#metrics[M2] / comparisonRules 第 3 条 /
//     task-spec 每题 goalApplicable + 顶层 goalDenominator
// ---------------------------------------------------------------------------

try {
  /**
   * evaluation.json 的**只读**读取。
   *
   * ⚠️ 冻结材料现状（2026-10-28 实测）：`evaluation.json` **不是合法 JSON** ——
   * `metrics[M2].definition` 里用 **ASCII 双引号**包住了"达成"
   * （JSON 字符串值内不允许裸 `"`）⇒ `JSON.parse` 直接失败（position 1394 / line 48）。
   * 冻结文件**不在本批可改范围**（本批只改判分器与本门）⇒ 这里做**一处定点**、
   * **可审计**、**只读**的修补后解析（不写回文件）；Lead 把原文修好后本函数自动走原样解析分支。
   */
  const evaluationRaw = readFileSync(resolve(SPEC_DIR, 'evaluation.json'), 'utf8')
  let evaluationText = evaluationRaw
  let evaluationPatched = false
  try {
    JSON.parse(evaluationRaw)
  } catch {
    evaluationText = evaluationRaw.replace('也判成"达成"', '也判成“达成”')
    evaluationPatched = evaluationText !== evaluationRaw
    if (!evaluationPatched)
      throw new Error('evaluation.json 非法 JSON，且定点修补未命中 ⇒ 需 Lead 修冻结文件')
  }
  if (evaluationPatched)
    console.log(
      '⚠️ [22] 冻结 evaluation.json **本身不是合法 JSON**（metrics[M2].definition 里有 ASCII 双引号）；' +
        '本门只读地定点修补后解析（未写回文件）⇒ 冻结文件需 Lead 修复。'
    )
  const evaluation = JSON.parse(evaluationText) as {
    metrics: { id: string; definition?: string; appliesTo?: string; denominator?: string }[]
    comparisonRules: readonly string[]
  }
  const taskSpec = JSON.parse(readFileSync(resolve(SPEC_DIR, 'task-spec.json'), 'utf8')) as {
    tasks: { taskId: string; kind: string; goalApplicable?: boolean }[]
    goalDenominator?: string
  }
  const failures: string[] = []
  const m2 = evaluation.metrics.find((metric) => metric.id === 'M2')
  if (m2 === undefined) failures.push('evaluation.json 缺 metrics[M2]')
  else {
    if (m2.appliesTo !== "kind == 'skill_relevant'") failures.push(`M2.appliesTo=${String(m2.appliesTo)}`)
    if ((m2.definition ?? '').includes('ordinary_chat 任务不参与 M2') === false)
      failures.push('M2.definition 未写明 ordinary_chat 不参与 M2')
    if ((m2.denominator ?? '').includes('skill_relevant') === false)
      failures.push('M2.denominator 未写明 skill_relevant 分母')
    if ((m2.denominator ?? '').includes('ordinary_chat') === false)
      failures.push('M2.denominator 未写明 ordinary_chat 不进分母')
  }
  const ordinaryRule = evaluation.comparisonRules.find((rule) => rule.includes('ordinary_chat'))
  if (ordinaryRule === undefined) failures.push('comparisonRules 缺 ordinary_chat 条款')
  else {
    if (ordinaryRule.includes('不参与 M2 达成率与 A/B 达成性对照') === false)
      failures.push('comparisonRules 的 ordinary_chat 条款未写明"不参与达成性对照"')
    if (ordinaryRule.includes('不因此') === false)
      failures.push('comparisonRules 的 ordinary_chat 条款未写明"不因此把整体降级"')
  }
  const applicableMismatch = taskSpec.tasks.filter((task) => {
    const local = TASKS.find((item) => item.taskId === task.taskId)
    if (local === undefined) return true
    return (
      expectedApplicable(local.kind, local.goalApplicable) !==
      expectedApplicable(task.kind, task.goalApplicable)
    )
  })
  if (applicableMismatch.length > 0)
    failures.push(`goalApplicable 不一致：${applicableMismatch.map((task) => task.taskId).join(',')}`)
  if ((taskSpec.goalDenominator ?? '').includes('skill_relevant') === false)
    failures.push('task-spec.goalDenominator 未写明 skill_relevant 分母')
  checkMany(
    '22',
    '与冻结口径对齐：evaluation.json#metrics[M2]（appliesTo/分母）+ comparisonRules 的 ordinary_chat 条款 + task-spec 每题 goalApplicable + 顶层 goalDenominator',
    failures,
    `M2.appliesTo=${String(m2?.appliesTo)} tasks=${taskSpec.tasks.length} goalDenominator=${String(taskSpec.goalDenominator).slice(0, 32)}…`
  )
} catch (error) {
  checkMany('22', '与冻结 evaluation.json / task-spec.json 的新口径对齐', [String(error)])
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

const passed = checks.filter((row) => row.pass).length
const failed = checks.length - passed
const elapsedMs = Date.now() - startedAt
console.log(`\nP3-5 判分器量具自证门：${passed} PASS / ${failed} FAIL / ${checks.length} total（${elapsedMs} ms）`)
console.log('PASS ' + passed + ' / FAIL ' + failed)
process.exitCode = failed === 0 && checks.length > 0 ? 0 : 1
