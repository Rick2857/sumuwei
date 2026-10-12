/**
 * M10 WP7b —— **可观察面门**（`pnpm m10:observability:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP7 的可观察面 + §6 隐私边界，逐条对应）
 * ============================================================================
 * ```text
 * ① trace 五步已登记且映射到既有阶段（不新开第 13 个阶段）→ T 组
 * ② trace 与开发者面**不含正文**                          → R 组（从**类型**上钉）
 * ③ 开发者面**只读**                                      → F 组
 * ④ 开发者面执行与聊天**相同的遗忘资格**                  → M 组（同一函数的两处消费）
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
  OBSERVABILITY_STAGES,
  SENSITIVE_ATTRIBUTE_KEY_SEGMENTS,
  TRACE_STEP_STAGE,
  sensitiveSegmentsOf,
  stageOfTraceStepKind,
} from '../src/kernel/contracts/observability.ts'
import type { GoalState } from '../src/kernel/contracts/goal.ts'
import {
  DEVELOPER_GOAL_CAPABILITY_FACTS,
  DEVELOPER_GOAL_FORBIDDEN_EXPORT_PATTERNS,
  buildDeveloperGoalDto,
  buildDeveloperGoalList,
  type DeveloperGoalDto,
} from '../src/kernel/app/goal/developer-face.ts'
import {
  goalContentMustBeMasked,
} from '../src/kernel/app/goal/invalidation.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_wp7b'
const USER_ID = 'm10-wp7b-user'
const M10_T0 = 2_300_000_000_000

function phase(mark: string): void {
  console.error(`[m10-observability] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'T' | 'R' | 'F' | 'M'
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

function codeLinesOf(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => line.trim() !== '')
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function goalState(override: Partial<GoalState> = {}): GoalState {
  return {
    goalId: 'gol:wp7b' as GoalState['goalId'],
    characterId: CHARACTER,
    owner: entityRef('character', CHARACTER),
    targetEntity: entityRef('user', USER_ID),
    origin: 'user_requested',
    sourceRefs: [
      { conversationEventId: 'cev:m10-wp7b-a' as never, fingerprint: 'fp-a' },
      { conversationEventId: 'cev:m10-wp7b-b' as never, fingerprint: 'fp-b' },
    ],
    revision: 3,
    statement: '把提纲写完',
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [
      { class: 'root_evidence', target: { kind: 'memory', memoryId: 'mem:1' } },
      { class: 'necessary_premise', target: { kind: 'memory', memoryId: 'mem:2' } },
      { class: 'optional_background', target: { kind: 'memory', memoryId: 'mem:3' } },
    ],
    time: { recordedAt: M10_T0 },
    ...override,
  }
}

// ---------------------------------------------------------------------------
// T 组：trace 五步
// ---------------------------------------------------------------------------

const GOAL_TRACE_STEPS = [
  'goal_eligibility',
  'goal_proposal',
  'goal_validation',
  'goal_event',
  'goal_context',
] as const

function traceStepChecks(): void {
  const missing = GOAL_TRACE_STEPS.filter((step) => TRACE_STEP_STAGE[step] === undefined)
  record(
    'T',
    'T1',
    '五个目标步骤**全部**登记在 `TRACE_STEP_STAGE`（缺一个 ⇒ 那一处的观测会落进 `unknown`）',
    '5/5 登记',
    `${String(GOAL_TRACE_STEPS.length - missing.length)}/5 · 缺失=[${missing.join(',')}]`,
    missing.length === 0,
  )

  const expectedStages: Record<string, string> = {
    goal_eligibility: 'turn',
    goal_proposal: 'turn',
    goal_validation: 'turn',
    goal_event: 'turn',
    goal_context: 'context',
  }
  const wrong = GOAL_TRACE_STEPS.filter(
    (step) => stageOfTraceStepKind(step) !== expectedStages[step],
  )
  record(
    'T',
    'T2',
    '五个步骤映射到**既有**阶段：前四步 `turn`（轮内处理），`goal_context` `context`'
      + '（编译器之后的事实）—— 与 affect / belief 同一条纪律',
    '5/5 映射正确',
    GOAL_TRACE_STEPS.map((s) => `${s}→${String(stageOfTraceStepKind(s))}`).join(' · '),
    wrong.length === 0,
  )

  record(
    'T',
    'T3',
    '**没有**新开第 13 个阶段（`OBSERVABILITY_STAGES.length === 12` 是 M5.1 门的机器判据）',
    '12 个阶段 · 5 个目标步骤都落在其中',
    `阶段数=${String(OBSERVABILITY_STAGES.length)} · 目标步骤用到的阶段=[${[...new Set(GOAL_TRACE_STEPS.map((s) => String(stageOfTraceStepKind(s))))].join(',')}]`,
    OBSERVABILITY_STAGES.length === 12 &&
      GOAL_TRACE_STEPS.every((step) =>
        (OBSERVABILITY_STAGES as readonly string[]).includes(String(stageOfTraceStepKind(step))),
      ),
  )

  /* 未知步骤仍然落 unknown（不得因为加了新步骤就把兜底改掉） */
  record(
    'T',
    'T4',
    '【负控】未登记的步骤仍然落 `unknown`（加新步骤**没有**把兜底改宽）',
    'unknown',
    `stageOfTraceStepKind('goal_typo')=${String(stageOfTraceStepKind('goal_typo'))}`,
    stageOfTraceStepKind('goal_typo') === 'unknown',
  )
}

// ---------------------------------------------------------------------------
// R 组：读数不含正文（**从类型上钉**）
// ---------------------------------------------------------------------------

/** 在给定源码块里找"像正文字段"的声明 */
function bodyLikeFieldsIn(source: string): string[] {
  const found: string[] = []
  for (const line of codeLinesOf(source)) {
    /*
     * ⚠️ **`?` 必须允许**（WP10 的量具自证注入 `N8` 抓到的）：
     *    第一版的正则要求字段名后面**紧跟 `:`** ⇒
     *    `readonly statement?: string`（**可选**正文字段）**根本匹配不到** ——
     *    而"可选"恰恰是泄漏最可能采用的形状（"有就带出去"）。
     *    ⇒ 一个漏掉可选字段的"没有正文字段"检查，等于给泄漏留了正门。
     */
    const match = /readonly\s+(statement|nextStep|text|content|body|utterance|quote)\??\s*:/.exec(line)
    if (match !== null) found.push(match[1]!)
  }
  return found
}

function readingShapeChecks(): void {
  /* ① M10 各层的 **reading** 类型里不许有正文字段 */
  const completionSource = readFileSync(
    join(REPO_ROOT, 'src/kernel/app/goal/completion.ts'),
    'utf8',
  )
  const verdictBlock = completionSource.slice(
    completionSource.indexOf('export type GoalCompletionVerdict'),
    completionSource.indexOf('export type GoalCompletionVerdict') + 900,
  )
  record(
    'R',
    'R1',
    '完成判定的**结论**类型里没有 `text` / `content` / `body`（读过的正文不可能被写进 trace）',
    '0 个正文字段',
    `命中=[${bodyLikeFieldsIn(verdictBlock).join(',')}]`,
    bodyLikeFieldsIn(verdictBlock).length === 0,
  )

  /* ② 上下文段的 **reading** 类型里不许有正文字段（counted 与 id 才允许） */
  const goalSectionsSource = readFileSync(
    join(REPO_ROOT, 'src/kernel/context/goal-sections.ts'),
    'utf8',
  )
  const stateReading = goalSectionsSource.slice(
    goalSectionsSource.indexOf('export interface GoalStateRenderReading'),
    goalSectionsSource.indexOf('export interface GoalStateRenderReading') + 700,
  )
  const factReading = goalSectionsSource.slice(
    goalSectionsSource.indexOf('export interface GoalFactRenderReading'),
    goalSectionsSource.indexOf('export interface GoalFactRenderReading') + 500,
  )
  const stateFields = bodyLikeFieldsIn(stateReading)
  const factFields = bodyLikeFieldsIn(factReading)
  record(
    'R',
    'R2',
    '两条上下文 reading 里**只有** id / 计数 / 具名原因（没有正文字段）',
    '0 个正文字段',
    `state=[${stateFields.join(',')}] · fact=[${factFields.join(',')}]`,
    stateFields.length === 0 && factFields.length === 0,
  )

  /* ③ 开发者条目**可见分支**带着 statement 是**允许**的（它是查询结果，不是 trace）；
      但**遮蔽分支**不许带 —— 这条由 M 组从类型与运行时两处钉。 */
  const developerSource = readFileSync(
    join(REPO_ROOT, 'src/kernel/app/goal/developer-face.ts'),
    'utf8',
  )
  const maskedBlock = developerSource.slice(
    developerSource.indexOf('export interface DeveloperGoalMaskedDto'),
    developerSource.indexOf('export interface DeveloperGoalVisibleDto'),
  )
  record(
    'R',
    'R3',
    '开发者面的**遮蔽分支**类型里没有 `statement` / `nextStep`（"遮蔽了还带正文"是类型错误，不是疏忽）',
    '0 个正文字段',
    `命中=[${bodyLikeFieldsIn(maskedBlock).join(',')}]`,
    bodyLikeFieldsIn(maskedBlock).length === 0,
  )

  /* ④ trace 属性键不得含敏感段（既有的 `SENSITIVE_ATTRIBUTE_KEY_SEGMENTS` 是负向策略） */
  /*
   * ⚠️ **本轮抓到一个真问题**：最初写的键名是 `goal.focus_row_key`，被既有的
   *    `SENSITIVE_ATTRIBUTE_KEY_SEGMENTS`（含 `'key'`）判为敏感 ⇒ 那条属性**根本发不出去**。
   *    这不是量具缺陷，是键名设计问题，而且它**在接线之前**就被抓到了 ——
   *    正是"先声明键、再检查策略"这个顺序的价值。
   *    ⇒ 改用 `goal.focus_row_id`（`id` 是合法段，既有策略刻意保留了它）。
   */
  const goalAttributeKeys = [
    'goal.operation',
    'goal.rejection_code_count',
    'goal.accepted_event_count',
    'goal.included_count',
    'goal.dropped_by_budget_count',
    'goal.focus_row_id',
    'goal.rendered_next_steps',
  ]
  const offenders = goalAttributeKeys.filter((key) => sensitiveSegmentsOf(key).length > 0)
  record(
    'R',
    'R4',
    '目标域的 trace 属性键**不含**任何敏感段（`content` / `text` / `statement` 之外，'
      + '本条检查保证我们连"看起来像正文"的键名都没用）',
    `0 个命中 · 检查了 ${String(goalAttributeKeys.length)} 个键`,
    offenders.length === 0
      ? `敏感段表=${String(SENSITIVE_ATTRIBUTE_KEY_SEGMENTS.length)} 段 · 无命中`
      : `命中=${offenders.join(',')}`,
    offenders.length === 0 && goalAttributeKeys.length > 0,
  )
}

// ---------------------------------------------------------------------------
// F 组：开发者面只读
// ---------------------------------------------------------------------------

function readOnlyChecks(): void {
  const source = readFileSync(join(REPO_ROOT, 'src/kernel/app/goal/developer-face.ts'), 'utf8')
  const exportedFunctions = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]!)
  const violating = exportedFunctions.filter((name) =>
    DEVELOPER_GOAL_FORBIDDEN_EXPORT_PATTERNS.some((pattern) => pattern.test(name)),
  )
  record(
    'F',
    'F1',
    '开发者面导出的函数**全是**读形状（`build*` / `read*`），没有 `write/create/update/delete/cancel/…`',
    '0 个写形状导出',
    `导出=[${exportedFunctions.join(',')}] · 违规=[${violating.join(',')}]`,
    exportedFunctions.length > 0 && violating.length === 0,
  )

  const facts = DEVELOPER_GOAL_CAPABILITY_FACTS.goals
  record(
    'F',
    'F2',
    '`goals` 读能力**登记了非空 authority**（"看起来存在、说不出谁负责"的能力不许存在）',
    'authority 非空 · availability=AVAILABLE',
    `authority 长度=${String(facts.authority.length)} · availability=${facts.availability}`,
    facts.authority.trim() !== '' && facts.availability === 'AVAILABLE',
  )

  /* 只读面**不 import** 写入相关的模块（放行口 / 存储） */
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
  const writeImports = imports.filter(
    (spec) =>
      spec.includes('goal-validator') ||
      spec.includes('goal-store') ||
      spec.includes('persistence') ||
      spec.includes('drizzle') ||
      spec.startsWith('node:'),
  )
  record(
    'F',
    'F3',
    '只读面**不 import** 放行口 / 存储 / SQL / `node:*` ⇒ 它在结构上没有写路径',
    '0 个写相关 import',
    `imports=[${imports.join(',')}]`,
    writeImports.length === 0,
  )
}

// ---------------------------------------------------------------------------
// M 组：与聊天共用同一份遗忘资格
// ---------------------------------------------------------------------------

function maskingParityChecks(): void {
  const withdrawn = new Set(['cev:m10-wp7b-b'])

  const cases: { id: string; label: string; goal: GoalState }[] = [
    { id: 'M1', label: '来源被撤 ⇒ 遮蔽（`withdrawn_source`）', goal: goalState() },
    {
      id: 'M2',
      label: '显式忘掉 ⇒ 遮蔽（`explicit_forget`）',
      goal: goalState({ cancelReason: 'explicit_forget' }),
    },
    { id: 'M3', label: '【正控】都不命中 ⇒ 可见', goal: goalState({
      sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }],
    }) },
  ]

  const rows: string[] = []
  let parity = true
  for (const testCase of cases) {
    const chatVerdict = goalContentMustBeMasked({ goal: testCase.goal, withdrawnEventIds: withdrawn })
    const dto = buildDeveloperGoalDto({ goal: testCase.goal, withdrawnEventIds: withdrawn })
    /* 两处的**结论**必须一致：聊天说遮蔽 ⟺ 开发者面也说遮蔽 */
    const agree = chatVerdict.mask === dto.masked
    if (!agree) parity = false
    rows.push(`${testCase.id}:chat=${String(chatVerdict.mask)}/dev=${String(dto.masked)}`)
    record(
      'M',
      testCase.id,
      `【一致性】${testCase.label}：聊天侧与开发者面**同结论**`,
      '两侧一致',
      `chat=${String(chatVerdict.mask)} · dev=${String(dto.masked)}${dto.masked ? `(${dto.maskingReason})` : ''}`,
      agree,
    )
  }
  record(
    'M',
    'M4',
    '**同一份判定被两处消费**：三例全部一致（若有第二份实现，正控或负控之一必然分叉）',
    '3/3 一致',
    rows.join(' · '),
    parity,
  )

  /* 运行时：遮蔽 DTO **真的没有**内容字段（类型之外再查一次） */
  const maskedDto = buildDeveloperGoalDto({
    goal: goalState({ cancelReason: 'explicit_forget' }),
    withdrawnEventIds: withdrawn,
  })
  const leakedFields = ['statement', 'nextStep', 'successCriterionKind'].filter(
    (field) => field in maskedDto,
  )
  record(
    'M',
    'M5',
    '遮蔽 DTO 在**运行时**也不含 `statement` / `nextStep` / `successCriterionKind`'
      + '（类型与运行时两道都查）',
    '0 个内容字段',
    `字段集=[${Object.keys(maskedDto).sort().join(',')}]`,
    leakedFields.length === 0,
  )

  /* 列表：遮蔽项进 `excluded`（可查"它被排除了"），但**不进**列表本体 */
  const list = buildDeveloperGoalList({
    goals: [
      goalState({ goalId: 'gol:visible' as GoalState['goalId'], sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }] }),
      goalState({ goalId: 'gol:masked' as GoalState['goalId'], cancelReason: 'explicit_forget' }),
      goalState({ goalId: 'gol:paused' as GoalState['goalId'], status: 'paused', sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }] }),
    ],
    withdrawnEventIds: withdrawn,
    /* ⚠️ 状态过滤**必须真的传进来**（第一版忘了传 ⇒ 那条分支压根没被触达） */
    status: 'active',
  })
  record(
    'M',
    'M6',
    '列表读取：遮蔽项与状态过滤项**分别具名**进 `excluded`（"查不到"与"被排除了"分得开），'
      + '且列表本体只有可见项',
    '1 项返回 · excluded 含 masked 与 status_filter 各一',
    `返回=${String(list.goals.length)} · excluded=${JSON.stringify(list.excluded)}`,
    list.goals.length === 1 &&
      list.goals[0]!.goalId === 'gol:visible' &&
      list.excluded.length === 2 &&
      list.excluded.some((e) => e.reason === 'masked') &&
      list.excluded.some((e) => e.reason === 'status_filter'),
  )

  /* `truncated` 如实报出（不静默截断） */
  const limited = buildDeveloperGoalList({
    goals: [
      goalState({ goalId: 'gol:a' as GoalState['goalId'], sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }] }),
      goalState({ goalId: 'gol:b' as GoalState['goalId'], sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }] }),
      goalState({ goalId: 'gol:c' as GoalState['goalId'], sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }] }),
    ],
    withdrawnEventIds: new Set<string>(),
    limit: 2,
  })
  record(
    'M',
    'M7',
    '`limit` 截断**如实报出** `truncated`（不静默少给），且返回顺序按 rowKey 升序稳定',
    '2 项返回 · truncated=1 · a,b',
    `${String(limited.goals.length)} 项 · truncated=${String(limited.truncated)} · ${limited.goals.map((g) => g.goalId).join(',')}`,
    limited.goals.length === 2 &&
      limited.truncated === 1 &&
      limited.goals.map((g) => g.goalId).join(',') === 'gol:a,gol:b',
  )

  /* 可见分支**确实**带内容（防"两分支都不带内容"这种过度遮蔽也能通过） */
  const visibleDto: DeveloperGoalDto = buildDeveloperGoalDto({
    goal: goalState({ sourceRefs: [{ conversationEventId: 'cev:clean' as never, fingerprint: 'fp-c' }] }),
    withdrawnEventIds: new Set<string>(),
  })
  record(
    'M',
    'M8',
    '【正控】可见分支**确实带** `statement` 与依赖计数（否则"永不泄漏"可以靠"永不显示"通过）',
    'statement 在场 · 三类依赖计数各 1',
    `masked=${String(visibleDto.masked)} · 有 statement=${String('statement' in visibleDto)}`,
    visibleDto.masked === false &&
      'statement' in visibleDto &&
      visibleDto.dependencyCounts.rootEvidence === 1 &&
      visibleDto.dependencyCounts.necessaryPremise === 1 &&
      visibleDto.dependencyCounts.optionalBackground === 1,
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  phase('trace steps (T)')
  traceStepChecks()
  phase('reading shapes (R)')
  readingShapeChecks()
  phase('read-only face (F)')
  readOnlyChecks()
  phase('masking parity (M)')
  maskingParityChecks()
  phase('done')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp7b-observability', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['T', 'R', 'F', 'M'] as const
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
    schema: 'm10-observability-verify@1',
    runId,
    head,
    characterId: CHARACTER,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'observability-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp7b',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'observability-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP7b 可观察面门：trace 五步与阶段映射（T）· 读数不含正文的类型判据（R）· ' +
      '开发者面只读（F）· 与聊天共用同一份遗忘资格（M）。零模型 / 零数据库。',
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

void main()
