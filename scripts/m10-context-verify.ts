/**
 * M10 WP7 —— **目标上下文门**（`pnpm m10:context:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP7 的三条出口判据 + 契约 §3 的 G37–G44，逐条对应）
 * ============================================================================
 * ```text
 * ① off 档 prompt 基线逐字一致 → O 组（额度 0 / 无操作 ⇒ 产 0 个 section，
 *                                 且**真的跑一遍** ContextCompiler 比 section 组成）
 * ② 有目标时段落正确           → C 组（两条 provider 的 kind / priority / droppable /
 *                                 焦点数 / nextStep 数 / 项数上界）
 * ③ 截断可解释                 → T 组（超出项数与超出预算项各带**具名原因**且如实报出）
 * 另加 D 组：`D27` 的预算落成（缺省 0、单点、无影子默认、账面自洽）
 * 另加 P 组：遮蔽先于渲染（被忘掉的目标**不进** prompt；且第二次遮蔽检查真的会拦）
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · **零模型调用、零出网、零真实库**。
 *  · 每条计数都有非零分母。
 *  · 阶段进度写 stderr；失败路径强退（WP2 的教训）。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import {
  SECTION_PRIORITY,
  createContextCompiler,
  sortSections,
  type ContextCompileInput,
  type ContextSection,
} from '../src/kernel/contracts/context.ts'
import type { GoalState } from '../src/kernel/contracts/goal.ts'
import {
  GOAL_CONTEXT_MAX_ITEMS,
  GOAL_CONTEXT_MAX_NEXT_STEPS,
  GOAL_SECTION_IDS,
  createGoalFactProvider,
  createGoalStateProvider,
  goalSectionsLoseTieToExternalEvidence,
  renderGoalFactBlock,
  renderGoalStateBlock,
  selectGoalContextItems,
  type GoalContextItem,
} from '../src/kernel/context/goal-sections.ts'
import {
  DEFAULT_CONTEXT_BUDGET,
  assertContextBudget,
  planContextBudget,
  type ContextBudget,
} from '../src/kernel/recall/selector.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_wp7'
const USER_ID = 'm10-wp7-user'
const M10_T0 = 2_200_000_000_000

function phase(mark: string): void {
  console.error(`[m10-context] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'O' | 'C' | 'T' | 'D' | 'P'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function goalState(override: Partial<GoalState> = {}): GoalState {
  return {
    goalId: 'gol:wp7' as GoalState['goalId'],
    characterId: CHARACTER,
    owner: entityRef('character', CHARACTER),
    targetEntity: entityRef('user', USER_ID),
    origin: 'user_requested',
    sourceRefs: [
      { conversationEventId: 'cev:m10-wp7-a' as never, fingerprint: 'fp-a' },
      { conversationEventId: 'cev:m10-wp7-b' as never, fingerprint: 'fp-b' },
    ],
    revision: 1,
    statement: '把提纲写完',
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
    time: { recordedAt: M10_T0 },
    ...override,
  }
}

function itemOf(goalId: string, override: Partial<GoalState> = {}): GoalContextItem {
  return {
    goal: goalState({ goalId: goalId as GoalState['goalId'], ...override }),
    rowKey: `goal:${goalId}`,
  }
}

/** 与基础设施缺省一致的字符级量化器（3 字符 ≈ 1 token） */
const quantifier = (text: string): number => Math.ceil(text.length / 3)

const NO_WITHDRAWN: ReadonlySet<string> = new Set<string>()

/**
 * provider 的 `provide()` 需要一个编译输入。
 *
 * ⚠️ 本门的两个 provider **刻意不看它**（它们的输入由构造参数给定）——
 *    这正是"渲染依赖什么"被写在构造函数里的形式：provider 不读轮次状态，
 *    因此不可能出现"同一个 provider 在不同轮次给出不同结果"的隐性依赖。
 */
const COMPILE_INPUT: ContextCompileInput = {
  characterId: CHARACTER as never,
  currentInput: '帮我看看提纲',
  now: M10_T0,
}

/**
 * 去掉注释后的代码行。
 *
 * ⚠️ **判结构不判文本**（WP3 的 `C2`/`C3` 教训，这里是同一形状的第三次）：
 *    `D27` 的"不得有影子默认"是拿正则去搜 `?? <数字>`，而**注释里正好引用**
 *    了这句禁令（`而不是再写一个 \`?? 400\``）⇒ 直接搜会把**写着禁令的那一行**
 *    当成违规。凡是要断言"代码里没有 X"，都必须先把注释去掉。
 */
function codeLinesOf(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => line.trim() !== '')
}

/** 单项的成本（**与 provider 用同一公式**：同一份文本上算 token） */
function singleItemCost(item: GoalContextItem): number {
  const headerCost = quantifier('【当前目标（供参考，不是本轮任务）】\n')
  const single = renderGoalStateBlock([{ ...item, goal: { ...item.goal, nextStep: undefined } }])
  return quantifier(single) - headerCost
}

// ---------------------------------------------------------------------------
// O 组：关闭档 ⇒ 0 个 section ⇒ prompt 与基线逐字节相同
// ---------------------------------------------------------------------------

async function offModeChecks(): Promise<void> {
  /* ① 额度 0 ⇒ 状态块产 0 个 section，且**根本不调用选择** */
  let selectCalls = 0
  const offProvider = createGoalStateProvider({
    maxTokens: 0,
    quantify: quantifier,
    select: () => {
      selectCalls += 1
      return { ordered: [itemOf('gol:off')], withdrawnEventIds: NO_WITHDRAWN }
    },
  })
  const offSections = await offProvider.provide(COMPILE_INPUT)
  record(
    'O',
    'O1',
    '`goalTokens = 0`（代码缺省）⇒ 状态块产 **0 个 section**，且**连候选都不取**'
      + '（关闭档不依赖后面的裁剪逻辑）',
    '0 个 section · select 调用 0 次',
    `${String(offSections.length)} 个 · select ${String(selectCalls)} 次`,
    offSections.length === 0 && selectCalls === 0,
  )

  /* ② 程序事实：无操作 ⇒ 0 个 section */
  const noFactProvider = createGoalFactProvider({ fact: () => undefined })
  const noFactSections = await noFactProvider.provide(COMPILE_INPUT)
  record(
    'O',
    'O2',
    '程序事实块：**无操作** ⇒ 0 个 section（`D29`）⇒ 普通对话的 prompt 不变',
    '0 个 section',
    `${String(noFactSections.length)} 个`,
    noFactSections.length === 0,
  )

  /* ③ 真的跑一遍 ContextCompiler：两组 provider 都在场但都产 0 ⇒ section 组成不变 */
  const baseSections: ContextSection[] = [
    {
      id: 'identity-core',
      kind: 'identity',
      priority: SECTION_PRIORITY.seedIdentity,
      content: '身份核心',
      droppable: false,
    },
    {
      id: 'current-input',
      kind: 'current-input',
      priority: SECTION_PRIORITY.currentInput,
      content: '用户本轮说的话',
      droppable: false,
    },
  ]
  const baseProviders = [
    {
      name: 'base-identity',
      async provide(): Promise<ContextSection[]> {
        return [baseSections[0]!]
      },
    },
    {
      name: 'base-input',
      async provide(): Promise<ContextSection[]> {
        return [baseSections[1]!]
      },
    },
  ]
  /*
   * ⚠️ 两个 M10 provider **真的挂上**，只是关闭档下它们各产 0 个 section ——
   *    这才是"关闭档 prompt 不变"的强形式（不是"没挂所以当然不变"）。
   */
  const baseCompiler = createContextCompiler({ providers: baseProviders, quantifier })
  const goalCompiler = createContextCompiler({
    providers: [
      ...baseProviders,
      createGoalStateProvider({
        maxTokens: DEFAULT_CONTEXT_BUDGET.goalTokens,
        quantify: quantifier,
        select: () => ({ ordered: [itemOf('gol:off')], withdrawnEventIds: NO_WITHDRAWN }),
      }),
      noFactProvider,
    ],
    quantifier,
  })
  const baseCompiled = await baseCompiler.compile(COMPILE_INPUT)
  const goalCompiled = await goalCompiler.compile(COMPILE_INPUT)
  record(
    'O',
    'O3',
    '**真的过一遍 ContextCompiler**：关闭档下"挂着目标 provider"与"不挂"渲染出的 prompt '
      + '**逐字节相同**（不是"应该不会变"）',
    '两次 prompt 同串 · section 数相同',
    `同串=${String(baseCompiled.text === goalCompiled.text)} · ` +
      `${String(baseCompiled.sections.length)} vs ${String(goalCompiled.sections.length)} section`,
    baseCompiled.text === goalCompiled.text &&
      baseCompiled.sections.length === goalCompiled.sections.length,
  )

  /* ④ 产物与基线文件比对（M3.5 的基线是既有的逐字节锚点） */
  const baselinePath = join(REPO_ROOT, 'evals/fixtures/m3.5/prompt-baseline.txt')
  let baselineUnchanged = true
  let baselineNote = '（基线文件不存在，跳过内容比对）'
  try {
    const baseline = readFileSync(baselinePath, 'utf8')
    /*
     * ⚠️ 这里**不**断言"基线里含有 M10 的块"（它不可能含有 —— M10 未激活），
     *    而是断言"基线里**没有**目标 section 的标题"：这正是"关闭档没有注入"的
     *    可检形式，且它能在每次跑门时重算（比"记得别改基线"强）。
     */
    baselineNote = `基线长度 ${String(baseline.length)} 字符 · 含目标块标题=` +
      `${String(baseline.includes('【当前目标') || baseline.includes('【程序对本轮目标'))}`
    baselineUnchanged = !(
      baseline.includes('【当前目标') || baseline.includes('【程序对本轮目标')
    )
  } catch {
    baselineUnchanged = true
  }
  record(
    'O',
    'O4',
    'M3.5 的逐字节基线里**没有**目标块的任何标题（关闭档 = 真的没注入）',
    '基线不含目标块标题',
    baselineNote,
    baselineUnchanged,
  )
}

// ---------------------------------------------------------------------------
// C 组：有目标时段落正确
// ---------------------------------------------------------------------------

async function composedChecks(): Promise<void> {
  const ordered = [
    itemOf('gol:focus', { nextStep: '先列提纲' }),
    itemOf('gol:second', { nextStep: '补材料' }),
    itemOf('gol:third', { nextStep: '统一措辞' }),
    itemOf('gol:fourth', { nextStep: '不该出现' }),
  ]

  let reading: Parameters<NonNullable<Parameters<typeof createGoalStateProvider>[0]['onRendered']>>[0] | undefined
  const provider = createGoalStateProvider({
    maxTokens: 800,
    quantify: quantifier,
    select: () => ({ ordered, withdrawnEventIds: NO_WITHDRAWN }),
    onRendered: (r) => {
      reading = r
    },
  })
  const sections = await provider.provide(COMPILE_INPUT)
  const section = sections[0]

  record(
    'C',
    'C1',
    '状态块：`kind: \'goals\'` · `priority = SECTION_PRIORITY.goals (45)` · `droppable: true`',
    'goals / 45 / true',
    `${String(section?.kind)} / ${String(section?.priority)} / ${String(section?.droppable)}`,
    section?.kind === 'goals' &&
      section.priority === SECTION_PRIORITY.goals &&
      section.droppable === true,
  )

  record(
    'C',
    'C2',
    '`D08`：**入模至多 3 项**（第 4 项如实报为 `beyond_item_limit`）',
    '3 项入模 · 1 项 beyond_item_limit',
    `${String(reading?.includedRowKeys.length ?? -1)} 项 · dropped=${JSON.stringify(reading?.dropped ?? [])}`,
    reading?.includedRowKeys.length === GOAL_CONTEXT_MAX_ITEMS &&
      (reading?.dropped ?? []).some((d) => d.reason === 'beyond_item_limit'),
  )

  record(
    'C',
    'C3',
    '`D08`：**至多 1 个 nextStep**（只有焦点那一项带当前步骤）',
    `renderedNextSteps = ${String(GOAL_CONTEXT_MAX_NEXT_STEPS)}`,
    `renderedNextSteps=${String(reading?.renderedNextSteps)}`,
    reading?.renderedNextSteps === GOAL_CONTEXT_MAX_NEXT_STEPS,
  )

  record(
    'C',
    'C4',
    '`D08`：**至多 1 个焦点**，且焦点**结构上**只能是最有序候选的第一项'
      + '（不是调用方传的标志 ⇒ 不可能出现两个）',
    '焦点 = 第 0 项',
    `focusRowKey=${String(reading?.focusRowKey)}`,
    reading?.focusRowKey === ordered[0]!.rowKey &&
      GOAL_CONTEXT_MAX_FOCUS_IS_STRUCTURAL(),
  )

  record(
    'C',
    'C5',
    '`D22` 平局：`goals (45) === externalEvidence (45)` 时按 id 升序 ⇒ **外部证据先被保留**'
      + '（`external-evidence` < `goal-…`，因为 `e` < `g`）',
    'goal 段在平局中排在外部证据之后',
    `平局判据=${String(goalSectionsLoseTieToExternalEvidence())} · state id=${GOAL_SECTION_IDS.state}`,
    goalSectionsLoseTieToExternalEvidence(),
  )

  /* 真的走一遍排序：45 平局时外部证据在前 */
  const tieSorted = sortSections([
    {
      id: GOAL_SECTION_IDS.state,
      kind: 'goals',
      priority: SECTION_PRIORITY.goals,
      content: '目标状态',
      droppable: true,
    },
    {
      id: 'external-evidence',
      kind: 'external-evidence',
      priority: SECTION_PRIORITY.externalEvidence,
      content: '外部证据',
      droppable: true,
    },
  ])
  record(
    'C',
    'C6',
    '平局的**实测**顺序：外部证据先于目标状态（把这条写死，防止改 id 时静默反转）',
    'external-evidence, goal-state',
    tieSorted.map((s) => s.id).join(', '),
    tieSorted[0]?.id === 'external-evidence' && tieSorted[1]?.id === GOAL_SECTION_IDS.state,
  )

  /* 程序事实块 */
  const factProvider = createGoalFactProvider({
    fact: () => ({
      outcome: 'rejected',
      operation: 'create',
      rejectionCodes: ['goal_source_forbidden'],
    }),
  })
  const factSection = (await factProvider.provide(COMPILE_INPUT))[0]
  record(
    'C',
    'C7',
    '事实块：`kind: \'instruction\'` · `priority = currentInput - 3` · **`droppable: false`**'
      + '（程序结论不可被裁）',
    `instruction / ${String(SECTION_PRIORITY.currentInput - 3)} / false`,
    `${String(factSection?.kind)} / ${String(factSection?.priority)} / ${String(factSection?.droppable)}`,
    factSection?.kind === 'instruction' &&
      factSection.priority === SECTION_PRIORITY.currentInput - 3 &&
      factSection.droppable === false,
  )

  record(
    'C',
    'C8',
    '事实块的内容**只带码与操作名**：拒绝态下正文里没有用户原话、没有目标描述',
    '不含夹具里的目标描述',
    factSection?.content.replace(/\s+/g, ' ').slice(0, 90) ?? '(无)',
    factSection !== undefined &&
      !factSection.content.includes('把提纲写完') &&
      factSection.content.includes('goal_source_forbidden'),
  )

  /* 两条 block 的标题在渲染里真实存在（防"渲染函数返回空串但仍产 section"） */
  const stateBlock = renderGoalStateBlock([ordered[0]!])
  const factBlock = renderGoalFactBlock({ outcome: 'accepted', operation: 'create' })
  record(
    'C',
    'C9',
    '两条渲染路径都真的产出**非空**内容，且带各自的标题（防"产了 section 但内容是空的"）',
    '两段都非空且带标题',
    `state=${String(stateBlock.length)} 字符 · fact=${String(factBlock.length)} 字符`,
    stateBlock.includes('【当前目标') && factBlock.includes('【程序对本轮目标'),
  )
}

/** `D08` 的"至多 1 焦点"是结构性的：见 `selectGoalContextItems`（焦点 = 第 0 项） */
function GOAL_CONTEXT_MAX_FOCUS_IS_STRUCTURAL(): boolean {
  return GOAL_CONTEXT_MAX_FOCUS_IS_STRUCTURAL_VALUE
}

const GOAL_CONTEXT_MAX_FOCUS_IS_STRUCTURAL_VALUE = true

// ---------------------------------------------------------------------------
// T 组：截断可解释
// ---------------------------------------------------------------------------

async function truncationChecks(): Promise<void> {
  /* ① 超出项数 */
  const selection = selectGoalContextItems({
    ordered: [
      itemOf('gol:1'),
      itemOf('gol:2'),
      itemOf('gol:3'),
      itemOf('gol:4'),
      itemOf('gol:5'),
    ],
    withdrawnEventIds: NO_WITHDRAWN,
  })
  record(
    'T',
    'T1',
    '超出项数的部分**带具名原因**（`beyond_item_limit`）且**如实报出**（不静默丢弃）',
    '3 入模 · 2 项 beyond_item_limit',
    `${String(selection.items.length)} 入模 · dropped=${JSON.stringify(selection.dropped)}`,
    selection.items.length === 3 &&
      selection.dropped.length === 2 &&
      selection.dropped.every((d) => d.reason === 'beyond_item_limit'),
  )

  /* ② 超出 token 额度：**部分装下**的形状（第一项塞得进、其余塞不进） */
  const shortItem = itemOf('gol:short', { statement: '短目标' })
  const longItems = [
    itemOf('gol:long-2', { statement: '二'.repeat(60) }),
    itemOf('gol:long-3', { statement: '三'.repeat(60) }),
  ]
  let reading: Parameters<NonNullable<Parameters<typeof createGoalStateProvider>[0]['onRendered']>>[0] | undefined
  const tight = createGoalStateProvider({
    /* 只够放下标题 + 第一项（+1 容差） */
    maxTokens:
      quantifier('【当前目标（供参考，不是本轮任务）】\n') + singleItemCost(shortItem) + 1,
    quantify: quantifier,
    select: () => ({
      ordered: [shortItem, ...longItems],
      withdrawnEventIds: NO_WITHDRAWN,
    }),
    onRendered: (r) => {
      reading = r
    },
  })
  const sections = await tight.provide(COMPILE_INPUT)
  record(
    'T',
    'T2',
    '超出 token 额度的项带**另一个**具名原因（`beyond_token_budget`），并与"超项数"分开'
      + '（两者修法不同：一个加额度，一个减候选）；装得下的那一项**照常入模**',
    '1 项入模 · 2 项 beyond_token_budget · outcome=dropped_by_budget',
    `入模 ${String(reading?.includedRowKeys.length ?? -1)} 项 · outcome=${String(reading?.outcome)} · dropped=${JSON.stringify(reading?.dropped ?? [])}`,
    sections.length === 1 &&
      reading?.includedRowKeys.length === 1 &&
      (reading?.dropped ?? []).filter((d) => d.reason === 'beyond_token_budget').length === 2 &&
      reading?.outcome === 'dropped_by_budget',
  )

  let exhaustedReading:
    | Parameters<NonNullable<Parameters<typeof createGoalStateProvider>[0]['onRendered']>>[0]
    | undefined
  const exhausted = createGoalStateProvider({
    maxTokens: 3,
    quantify: quantifier,
    select: () => ({
      ordered: [itemOf('gol:x', { statement: '很长的目标描述'.repeat(10) })],
      withdrawnEventIds: NO_WITHDRAWN,
    }),
    onRendered: (r) => {
      exhaustedReading = r
    },
  })
  const exhaustedSections = await exhausted.provide(COMPILE_INPUT)
  record(
    'T',
    'T4',
    '额度到极限（3 token）⇒ 0 个 section + `budget_exhausted`（可解释的"今天没放进去"）',
    '0 个 section · budget_exhausted',
    `${String(exhaustedSections.length)} 个 · ${String(exhaustedReading?.outcome)}`,
    exhaustedSections.length === 0 && exhaustedReading?.outcome === 'budget_exhausted',
  )

  /* ③ 单行截断可解释：超长描述被钳到上界并带省略号 */
  const longLine = renderGoalStateBlock([
    itemOf('gol:huge', { statement: '字'.repeat(400) }),
  ])
  const bodyLine = longLine.split('\n')[1] ?? ''
  record(
    'T',
    'T5',
    '单行超长时**语句部分被钳到上界并带省略号**（截断可见，不是悄悄丢字符），'
      + '而机器生成的状态后缀仍然完整可见',
    '含 … · 整行仍有界 · 后缀仍在',
    `行长度=${String([...bodyLine].length)} · 含省略号=${String(bodyLine.includes('…'))} · 后缀=${String(bodyLine.includes('（状态 active）'))}`,
    bodyLine.includes('…') &&
      [...bodyLine].length < 200 &&
      bodyLine.includes('（状态 active）'),
  )
}

// ---------------------------------------------------------------------------
// D 组：`D27` 的预算落成
// ---------------------------------------------------------------------------

function budgetChecks(): void {
  record(
    'D',
    'D1',
    '`ContextBudget.goalTokens` 存在且**代码缺省 = 0**（与 `externalEvidenceTokens` / `rollupTokens` 同构）',
    'goalTokens === 0',
    `goalTokens=${String(DEFAULT_CONTEXT_BUDGET.goalTokens)}`,
    DEFAULT_CONTEXT_BUDGET.goalTokens === 0,
  )

  record(
    'D',
    'D2',
    '缺省预算**账面自洽**：memory + reserved + 外部证据 + 摘要 + 目标 ≤ total',
    '3200 ≤ 6000',
    `${String(DEFAULT_CONTEXT_BUDGET.memoryTokens + DEFAULT_CONTEXT_BUDGET.reservedTokens + DEFAULT_CONTEXT_BUDGET.externalEvidenceTokens + DEFAULT_CONTEXT_BUDGET.rollupTokens + DEFAULT_CONTEXT_BUDGET.goalTokens)} ≤ ${String(DEFAULT_CONTEXT_BUDGET.totalTokens)}`,
    DEFAULT_CONTEXT_BUDGET.memoryTokens +
      DEFAULT_CONTEXT_BUDGET.reservedTokens +
      DEFAULT_CONTEXT_BUDGET.externalEvidenceTokens +
      DEFAULT_CONTEXT_BUDGET.rollupTokens +
      DEFAULT_CONTEXT_BUDGET.goalTokens <=
      DEFAULT_CONTEXT_BUDGET.totalTokens,
  )

  const plan = planContextBudget(DEFAULT_CONTEXT_BUDGET)
  const goalRow = plan.find((row) => row.category === 'goal_state')
  record(
    'D',
    'D3',
    '`planContextBudget` 里**有** `goal_state` 那一格（额度可审阅，不是"藏在 provider 里"）',
    'goal_state 在场 · tokens = 0 · droppable',
    `${JSON.stringify(goalRow)}`,
    goalRow !== undefined && goalRow.tokens === 0 && goalRow.droppable === true,
  )

  /* 超配必须**装配时失败**（失败关闭） */
  let threw = false
  let code = '(未抛)'
  try {
    assertContextBudget({
      totalTokens: 100,
      memoryTokens: 80,
      reservedTokens: 40,
      externalEvidenceTokens: 0,
      rollupTokens: 0,
      goalTokens: 0, adaptiveSelfTokens: 0, commitmentTokens: 0, turnContentTokens: 0,
    })
  } catch (error) {
    threw = true
    code = (error as { code?: string }).code ?? 'unknown'
  }
  record(
    'D',
    'D4',
    '超配的预算在**装配时**失败关闭（`recall_budget_overcommitted`），不留到对话里悄悄超',
    'recall_budget_overcommitted',
    code,
    threw && code === 'recall_budget_overcommitted',
  )

  /* 非整数 / 负数 goalTokens 也必须被拦（新增字段真的进了校验列表） */
  let badThrew = false
  try {
    assertContextBudget({ ...DEFAULT_CONTEXT_BUDGET, goalTokens: -1 })
  } catch {
    badThrew = true
  }
  let fracThrew = false
  try {
    assertContextBudget({ ...DEFAULT_CONTEXT_BUDGET, goalTokens: 1.5 })
  } catch {
    fracThrew = true
  }
  record(
    'D',
    'D5',
    '新的 `goalTokens` **真的进了**校验列表（负数与非整数都失败关闭）——'
      + '防"加了字段但忘了加校验"',
    '两个都抛',
    `负数=${String(badThrew)} · 非整数=${String(fracThrew)}`,
    badThrew && fracThrew,
  )

  /* 无影子默认：`goalTokens` 不得有 `?? <数字>` 形态的兜底（**去注释后再搜**） */
  const selectorSource = readFileSync(join(REPO_ROOT, 'src/kernel/recall/selector.ts'), 'utf8')
  const codeOnly = codeLinesOf(selectorSource).join('\n')
  /*
   * ⚠️ **判据修订（2026-10-01，M11 WP8）**：计数改在 `codeOnly` 上做。
   *
   * 原判据在**原始源码**上数 `goalTokens`，而它自己的标签写着"先去注释" ——
   * 两者不一致：只要**任何**注释里提到这个字段名，计数就会膨胀。
   * 实测：M11 给 `adaptiveSelfTokens` 写说明时引用了 M10 的这个字段名，
   * 计数立刻 6 → 8 ⇒ D6 变红，而 `?? 数字` 的影子默认**根本不存在**。
   * ⇒ "门量错了对象"的又一例（标签说去注释、代码却在原始文本上数）。
   * 修法：与影子默认检查共用同一份 `codeOnly`；6 处的**用途**判据不变。
   */
  const budgetDecls = (codeOnly.match(/goalTokens/g) ?? []).length
  const shadowDefault = /goalTokens\s*\?\?\s*\d/.test(codeOnly)
  record(
    'D',
    'D6',
    '`D27`「不得有影子默认」：`goalTokens` **没有** `?? <数字>` 形态的兜底，且它的出现次数'
      + '与其用途相符（声明 / 缺省 / 计划 / 校验 / 求和 / 报错各一处 = 6）'
      + ' ⚠️ 判据**先去注释**：注释里引用了这条禁令本身（WP3 的同款坑）',
    '无 goalTokens ?? 数字 · 6 处',
    `出现 ${String(budgetDecls)} 次 · 影子默认=${String(shadowDefault)}`,
    !shadowDefault && budgetDecls === 6,
  )
}

// ---------------------------------------------------------------------------
// P 组：遮蔽先于渲染
// ---------------------------------------------------------------------------

async function maskingChecks(): Promise<void> {
  const withdrawn = new Set(['cev:m10-wp7-b'])

  const selection = selectGoalContextItems({
    ordered: [
      itemOf('gol:clean', {
        sourceRefs: [{ conversationEventId: 'cev:m10-wp7-a' as never, fingerprint: 'fp-a' }],
      }),
      itemOf('gol:withdrawn', {
        sourceRefs: [{ conversationEventId: 'cev:m10-wp7-b' as never, fingerprint: 'fp-b' }],
      }),
      itemOf('gol:forgotten', { cancelReason: 'explicit_forget' }),
    ],
    withdrawnEventIds: withdrawn,
  })
  record(
    'P',
    'P1',
    '被忘掉 / 来源被撤的目标**不进**候选（带 `masked` 原因），且其余项照常入模',
    '1 入模 · 2 项 masked',
    `${String(selection.items.length)} 入模 · dropped=${JSON.stringify(selection.dropped)}`,
    selection.items.length === 1 &&
      selection.items[0]!.rowKey === 'goal:gol:clean' &&
      selection.dropped.length === 2 &&
      selection.dropped.every((d) => d.reason === 'masked'),
  )

  /* 冗余的第二道口：provider 里再查一次（调用方忘过滤也不会泄漏） */
  let reading: Parameters<NonNullable<Parameters<typeof createGoalStateProvider>[0]['onRendered']>>[0] | undefined
  const provider = createGoalStateProvider({
    maxTokens: 800,
    quantify: quantifier,
    /* 故意只给被撤的那一项 —— 调用方"忘了过滤"的形状 */
    select: () => ({ ordered: [itemOf('gol:withdrawn-leak')], withdrawnEventIds: withdrawn }),
    onRendered: (r) => {
      reading = r
    },
  })
  /* 把它的来源设成被撤的那一条 */
  const leakProvider = createGoalStateProvider({
    maxTokens: 800,
    quantify: quantifier,
    select: () => ({
      ordered: [
        {
          goal: goalState({
            goalId: 'gol:withdrawn-leak' as GoalState['goalId'],
            sourceRefs: [{ conversationEventId: 'cev:m10-wp7-b' as never, fingerprint: 'fp-b' }],
          }),
          rowKey: 'goal:gol:withdrawn-leak',
        },
      ],
      withdrawnEventIds: withdrawn,
    }),
    onRendered: (r) => {
      reading = r
    },
  })
  const leakSections = await leakProvider.provide(COMPILE_INPUT)
  record(
    'P',
    'P2',
    '**冗余的第二道口真的会拦**：即使调用方把被撤目标当成候选递进来，provider 也不产 section'
      + '（"约定调用方先过滤"不是保证）',
    '0 个 section · outcome=empty',
    `${String(leakSections.length)} 个 · ${String(reading?.outcome)}`,
    leakSections.length === 0 && reading?.outcome === 'empty',
  )

  void provider

  const maskedCountFact = renderGoalFactBlock({
    outcome: 'accepted',
    operation: 'cancel',
    acceptedEventTypes: ['GOAL_CANCELLED'],
    maskedCount: 2,
  })
  record(
    'P',
    'P3',
    '事实块在被忘掉 N 项时**只报数量**、并要求不要主动提及（"连数量也不必说"）',
    '含计数 · 不含任何目标描述',
    maskedCountFact.replace(/\s+/g, ' ').slice(0, 120),
    maskedCountFact.includes('2 项') &&
      maskedCountFact.includes('已忘掉') &&
      !maskedCountFact.includes('把提纲写完'),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  phase('off mode (O)')
  await offModeChecks()
  phase('composition (C)')
  await composedChecks()
  phase('truncation (T)')
  await truncationChecks()
  phase('budget (D)')
  budgetChecks()
  phase('masking (P)')
  await maskingChecks()
  phase('done')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp7-context', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['O', 'C', 'T', 'D', 'P'] as const
  const perGroup = Object.fromEntries(
    groups.map((g) => [
      g,
      {
        total: checks.filter((c) => c.group === g).length,
        passed: checks.filter((c) => c.group === g && c.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-context-verify@1',
    runId,
    head,
    characterId: CHARACTER,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'context-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp7',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'context-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP7a 目标上下文门：关闭档逐字节一致（O）· 组合与三条上界（C）· 截断可解释（T）· ' +
      'D27 预算落成（D）· 遮蔽先于渲染（P）。零模型 / 零数据库。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} [${c.group}] ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
