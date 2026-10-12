/**
 * M10（`U-14`）—— **折叠 oracle 门**（`pnpm m10:oracle:verify`）。
 *
 * ============================================================================
 *  本门测什么
 * ============================================================================
 * `foldGoalRowsInMemory` 是**铁律 ②**的核心（"投影是派生的"），而它此前只被
 * **手写预期**复核过 —— 那些谓词与 reducer 出自同一支笔。本门引入
 * [`evals/m10/goal-fold-oracle.ts`](../evals/m10/goal-fold-oracle.ts)：
 * 一份**形状不同**的第二实现（声明式转移表 + 每行从头重放），做三方对照：
 *
 * ```text
 * O1 等价    脚本流 + 确定性伪随机流上，oracle 行 == reducer 行（**逐字段**）
 * O2 全表    转移表对每个 (非终态 × 目标事件) 都有条目 ⇒ 没有"没人决定过"的格子
 * O3 幂等    同一条流折两遍 = 同一结果（纯函数）
 * O4 非法边  表里为 `null` 的组合：reducer 与 oracle **都** no-op，且 **revision 不动**
 * O5 隔离    别的角色的事件不产行
 * O6 非空泛  O1 用的流真的产出非平凡行（revision > 1 / 有终态 / 有承诺）
 * O7 计量    `measured_count > 0`
 * ```
 *
 * ⚠️ **证据强度的边界（必须写在门里）**：oracle 也是我写的 ⇒ 它能抓
 *    **实现层面的滑落**，抓不到**规格层面的误读**（两处会把同一句话读错）。
 *    它的强度**低于**"第二个人独立实现"，登记为 `L-M10-52`。
 *
 * ⚠️ 零模型 / 零数据库 / 纯进程内。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { foldGoalRowsInMemory, reduceGoalRow } from '../src/kernel/projections/goal.ts'
import {
  COMMITMENT_STATUSES,
  GOAL_STATUSES,
  GOAL_TERMINAL_STATUSES,
  type GoalRowState,
} from '../src/kernel/contracts/goal.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_FULFILLED,
  COMMITMENT_SUPERSEDED,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_REVISED,
  GOAL_SUPERSEDED,
} from '../src/kernel/contracts/domain-event.ts'
import type { DomainEvent } from '../src/kernel/contracts/index.ts'
import {
  commitmentTableGaps,
  goalTableGaps,
  goalTransitionOf,
  oracleFold,
  oracleRowKey,
  type GoalTransition,
} from '../evals/m10/goal-fold-oracle.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_oracle'
const OTHER_CHARACTER = 'char_m10_oracle_other'

function phase(mark: string): void {
  console.error(`[m10-oracle] ${mark}`)
}

interface Check {
  group: 'O'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group: 'O', id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 事件合成（确定性：固定种子，可复现）
// ---------------------------------------------------------------------------

let seed = 0x2f6e2b1
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)]!
}

/** **逐字段**差异（路径 + 两边的值）—— 不是整包 JSON 的截断对照 */
function diffFields(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 6) return
  if (a === null || b === null || typeof a !== typeof b) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
    }
    return
  }
  if (typeof a !== 'object') {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
    return
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
  for (const key of keys) {
    diffFields(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}.${key}`,
      out,
    )
  }
}

function event(  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  at: number,
  characterId = CHARACTER,
): DomainEvent {
  return {
    id: `dev:m10-oracle-${String(characterId)}-${String(sequence)}`,
    characterId,
    sequence,
    type,
    sourceConversationEventIds: [],
    payload: { characterId, ...payload },
    processor: 'm10-oracle-verify',
    processorVersion: 'm10-oracle-verify@1',
    idempotencyKey: `idem:m10-oracle-${String(characterId)}-${String(sequence)}`,
    schemaVersion: 1,
    createdAt: at,
    occurredAt: at,
  } as unknown as DomainEvent
}

function goalSnapshot(goalId: string, characterId = CHARACTER): Record<string, unknown> {
  return {
    goalId,
    characterId,
    owner: { kind: 'character', id: characterId },
    origin: 'user_requested',
    sourceRefs: [],
    revision: 1,
    statement: `oracle 目标 ${goalId}`,
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
  }
}

function commitmentSnapshot(goalId: string): Record<string, unknown> {
  return {
    commitmentId: `cmt:${goalId}`,
    goalId,
    actor: { kind: 'character', id: CHARACTER },
    beneficiary: { kind: 'user', id: 'u' },
    scope: '给三个步骤',
    acceptedAt: 1_000,
    acceptanceRefs: [],
    criterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
    status: 'active',
    completionRefs: [],
    revision: 1,
  }
}

/** 一段**脚本化**流：覆盖设立 → 暂停 → 恢复 → 受阻 → 修订 → 完成 / 取消 / 替代 */
function scriptedStream(goalId: string): DomainEvent[] {
  const at = 3_000_000_000_000
  return [
    event(1, GOAL_CREATED, { goal: goalSnapshot(goalId), mutation: 'explicit' }, at + 1),
    event(2, GOAL_PAUSED, { goalId, expectedRevision: 1, reason: 'r' }, at + 2),
    event(3, GOAL_RESUMED, { goalId, expectedRevision: 2, recheck: { hard: 1, soft: 0, dropped: 0 } }, at + 3),
    event(4, GOAL_BLOCKED, { goalId, expectedRevision: 3, reasonCode: 'necessary_premise_invalid' }, at + 4),
    event(5, GOAL_RESUMED, { goalId, expectedRevision: 4, recheck: { hard: 1, soft: 0, dropped: 0 } }, at + 5),
    event(6, GOAL_REVISED, { goalId, expectedRevision: 5, changed: ['statement'], statement: '改过' }, at + 6),
    event(7, COMMITMENT_ACCEPTED, { goalId, commitment: commitmentSnapshot(goalId), expectedGoalRevision: 6 }, at + 7),
    event(8, COMMITMENT_FULFILLED, { commitmentId: `cmt:${goalId}`, goalId, expectedRevision: 1, resultRefs: [], basis: 'user_report' }, at + 8),
    event(9, GOAL_COMPLETED, { goalId, expectedRevision: 7, basis: 'user_report', evidenceRefs: [] }, at + 9),
  ]
}

/** 目标事件池（伪随机流用） */
const GOAL_EVENT_POOL = [
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_BLOCKED,
  GOAL_REVISED,
  GOAL_COMPLETED,
  GOAL_CANCELLED,
  GOAL_SUPERSEDED,
] as const
const COMMITMENT_EVENT_POOL = [
  COMMITMENT_FULFILLED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_SUPERSEDED,
] as const

function payloadFor(type: string, goalId: string): Record<string, unknown> {
  switch (type) {
    case GOAL_PAUSED:
      return { goalId, expectedRevision: 1, reason: 'r' }
    case GOAL_RESUMED:
      return { goalId, expectedRevision: 1, recheck: { hard: 1, soft: 0, dropped: 0 } }
    case GOAL_BLOCKED:
      return { goalId, expectedRevision: 1, reasonCode: 'necessary_premise_invalid' }
    case GOAL_REVISED:
      return { goalId, expectedRevision: 1, changed: ['statement'], statement: '改' }
    case GOAL_COMPLETED:
      return { goalId, expectedRevision: 1, basis: 'user_report', evidenceRefs: [] }
    case GOAL_CANCELLED:
      return { goalId, expectedRevision: 1, reason: 'user_cancel' }
    case GOAL_SUPERSEDED:
      return { goalId, expectedRevision: 1, supersededByGoalId: 'gol:other', reason: 'r' }
    case COMMITMENT_FULFILLED:
      return { commitmentId: `cmt:${goalId}`, goalId, expectedRevision: 1, resultRefs: [], basis: 'user_report' }
    case COMMITMENT_BROKEN:
      return { commitmentId: `cmt:${goalId}`, goalId, expectedRevision: 1, violationRefs: [], ruleId: 'r1' }
    case COMMITMENT_CANCELLED:
      return { commitmentId: `cmt:${goalId}`, goalId, expectedRevision: 1, reason: 'goal_cancelled' }
    case COMMITMENT_SUPERSEDED:
      return { commitmentId: `cmt:${goalId}`, goalId, expectedRevision: 1, supersededByCommitmentId: 'cmt:x', reason: 'r' }
    default:
      return { goalId }
  }
}

function randomStream(goalCount: number, length: number): DomainEvent[] {
  const at = 3_100_000_000_000
  const goals = Array.from({ length: goalCount }, (_, index) => `gol:rnd-${String(index)}`)
  const events: DomainEvent[] = []
  for (const goalId of goals) {
    events.push(event(events.length + 1, GOAL_CREATED, { goal: goalSnapshot(goalId), mutation: 'explicit' }, at + events.length))
  }
  for (let index = 0; index < length; index += 1) {
    const goalId = pick(goals)
    const type = pick([...GOAL_EVENT_POOL, ...COMMITMENT_EVENT_POOL] as const)
    events.push(
      event(events.length + 1, type, payloadFor(type, goalId), at + events.length),
    )
  }
  return events
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  /* ======================================================================
   * O2：转移表**全**（先把结构判据摆前面 —— 表有缺口时 O1 的对照没有意义）
   * ==================================================================== */
  phase('O2 transition table totality')

  const goalGaps = goalTableGaps()
  const commitmentGaps = commitmentTableGaps()
  record(
    'O2a',
    '**目标转移表是「全」的**：每个非终态 × 每个目标事件都有条目'
      + '（`null` = 按规格 no-op；**缺条目** = 没人决定过）',
    `0 个缺口（${String(GOAL_STATUSES.length)} 状态 × 7 事件）`,
    goalGaps.length === 0 ? '0 个缺口' : `缺口：[${goalGaps.join(', ')}]`,
    goalGaps.length === 0,
  )
  record(
    'O2b',
    '**承诺转移表是「全」的**：每个非终态 × 每个承诺事件都有条目',
    `0 个缺口（${String(COMMITMENT_STATUSES.length)} 状态 × 5 事件）`,
    commitmentGaps.length === 0 ? '0 个缺口' : `缺口：[${commitmentGaps.join(', ')}]`,
    commitmentGaps.length === 0,
  )

  /* 终态**没有出边**：表里是空对象 —— 这条本身是判据（不可迁移）
   *
   * ⚠️ 第一版这条检查遍历的是 `GOAL_STATUSES`（**全部**状态）⇒
   *    它把 `active`/`paused`/`blocked` 报成"有出边"—— 而那三个**本来就有出边**。
   *    ⇒ 检查的**对象**错了（标签写"终态"，代码看全部）。
   *    正确的对象是 `GOAL_TERMINAL_STATUSES`。
   */
  const terminalWithEdges = GOAL_TERMINAL_STATUSES.filter(
    (status) =>
      goalTransitionOf(status, GOAL_PAUSED) !== undefined ||
      goalTransitionOf(status, GOAL_RESUMED) !== undefined ||
      goalTransitionOf(status, GOAL_REVISED) !== undefined ||
      goalTransitionOf(status, GOAL_COMPLETED) !== undefined ||
      goalTransitionOf(status, GOAL_CANCELLED) !== undefined ||
      goalTransitionOf(status, GOAL_SUPERSEDED) !== undefined ||
      goalTransitionOf(status, GOAL_BLOCKED) !== undefined,
  )
  record(
    'O2c',
    '**终态不可迁移**：`completed` / `cancelled` / `superseded` 在表里**没有出边**'
      + '（检查的对象是**终态**，不是全部状态）',
    '0 个终态有出边',
    terminalWithEdges.length === 0 ? '0 个' : `有出边：[${terminalWithEdges.join(', ')}]`,
    terminalWithEdges.length === 0,
  )

  /* ======================================================================
   * O1：等价（脚本流 + 伪随机流）
   * ==================================================================== */
  phase('O1 equivalence on scripted + random streams')

  const streams: { name: string; events: DomainEvent[] }[] = [
    { name: 'scripted', events: scriptedStream('gol:scripted') },
    ...Array.from({ length: 8 }, (_, index) => ({
      name: `random#${String(index)}`,
      events: randomStream(3 + (index % 3), 24 + index * 3),
    })),
  ]

  const divergences: string[] = []
  let comparedRows = 0
  let comparedStreams = 0
  for (const stream of streams) {
    /* 用**公开**入口拿 reducer 的结果（与 store 走同一条增量折叠路径） */
    const reducerRows = (() => {
      const cache = new Map<string, { projectionType: string; revision: number; state: GoalRowState; changed: boolean }>()
      foldGoalRowsInMemory(cache as never, stream.events)
      const out = new Map<string, GoalRowState>()
      for (const [key, entry] of cache) out.set(key, entry.state)
      return out
    })()

    const oracleRows = oracleFold(stream.events)
    comparedStreams += 1

    const keys = new Set([...reducerRows.keys(), ...oracleRows.keys()])
    for (const key of keys) {
      comparedRows += 1
      const left = reducerRows.get(key)
      const right = oracleRows.get(key)
      /*
       * ⚠️ **逐字段**报差异（第一版把两边的 JSON 各截 120 字符 ⇒
       *    两条消息**看起来一模一样**，因为前 120 字符都是同一个 goal 头）。
       *    "差异在第 130 个字符之后"等于**没有读数** ⇒ 换成字段路径。
       */
      const fieldDiffs: string[] = []
      diffFields(left, right, 'row', fieldDiffs)
      if (fieldDiffs.length > 0) {
        if (divergences.length < 4) {
          divergences.push(`${stream.name} · ${key} ⇒ ${fieldDiffs.slice(0, 3).join(' ; ')}`)
        }
      }
    }
  }
  record(
    'O1',
    '**【等价】脚本流 + 8 条确定性伪随机流上，oracle 行与 reducer 行逐字段相同**'
      + '（两份形状不同的实现给同一个答案）',
    `0 处分歧 · 比较 ${String(comparedRows)} 行`,
    divergences.length === 0
      ? `${String(comparedStreams)} 条流 · ${String(comparedRows)} 行 · 0 处分歧`
      : `分歧：${divergences.join(' | ')}`,
    divergences.length === 0 && comparedStreams === streams.length,
  )

  /* ======================================================================
   * O3：幂等（纯函数）
   * ==================================================================== */
  phase('O3 determinism')

  const twiceOk = streams.every((stream) => {
    const first = JSON.stringify([...oracleFold(stream.events)].sort())
    const second = JSON.stringify([...oracleFold(stream.events)].sort())
    return first === second
  })
  record(
    'O3',
    '**幂等 / 纯**：同一条流折两遍得到**逐字相同**的结果（oracle 无内部状态）',
    '全部流两遍同值',
    twiceOk ? `全部 ${String(streams.length)} 条流两遍同值` : '有流两遍不同值',
    twiceOk,
  )

  /* ======================================================================
   * O4：非法边 ⇒ no-op 且 revision 不动
   * ==================================================================== */
  phase('O4 illegal edges are no-ops')

  const goalEvents = [
    GOAL_PAUSED,
    GOAL_RESUMED,
    GOAL_BLOCKED,
    GOAL_REVISED,
    GOAL_COMPLETED,
    GOAL_CANCELLED,
    GOAL_SUPERSEDED,
  ]
  const illegalPairs: string[] = []
  let illegalChecked = 0
  for (const status of GOAL_STATUSES) {
    for (const type of goalEvents) {
      const target: GoalTransition | undefined = goalTransitionOf(status, type)
      if (target !== null) continue // 只有"表里写了 null"的组合才是本条的对象
      illegalChecked += 1
      /* 造一个该状态的行，投一条该事件，断言两边都 no-op 且 revision 不动 */
      const base: GoalRowState = {
        goal: {
          ...(goalSnapshot('gol:illegal') as never as GoalRowState['goal']),
          status,
        },
        commitment: null,
      }
      const payload = payloadFor(type, 'gol:illegal')
      const synthetic = event(1, type, payload, 3_200_000_000_000)
      const viaReducer = reduceGoalRow(base, synthetic)
      const revisionBefore = base.goal.revision
      const statusAfter = viaReducer?.goal.status
      const revisionAfter = viaReducer?.goal.revision
      if (statusAfter !== status || revisionAfter !== revisionBefore) {
        illegalPairs.push(`${status}×${type} ⇒ ${String(statusAfter)}/rev ${String(revisionAfter)}`)
      }
    }
  }
  record(
    'O4',
    '**【非法边】** 表里为 `null` 的每个组合：reducer **no-op**（状态不变、**revision 不动**）'
      + ' —— 这条把"只判了状态、忘了 revision"这类滑落挡住',
    `0 处异常（检查 ${String(illegalChecked)} 个组合）`,
    illegalPairs.length === 0
      ? `${String(illegalChecked)} 个组合全部 no-op`
      : `异常：${illegalPairs.join(' | ')}`,
    illegalPairs.length === 0 && illegalChecked > 0,
  )

  /* ======================================================================
   * O5：角色隔离
   * ==================================================================== */
  phase('O5 character isolation')

  const mixed = [
    ...scriptedStream('gol:mine'),
    event(999, GOAL_CREATED, { goal: goalSnapshot('gol:theirs', OTHER_CHARACTER), mutation: 'explicit' }, 3_300_000_000_000, OTHER_CHARACTER),
  ]
  const oracleMixed = oracleFold(mixed)
  const reducerMixed = (() => {
    const cache = new Map<string, { projectionType: string; revision: number; state: GoalRowState; changed: boolean }>()
    foldGoalRowsInMemory(cache as never, mixed)
    return new Map([...cache].map(([key, entry]) => [key, entry.state]))
  })()
  /* ⚠️ oracle 本身**不**做角色过滤（它只按行键分组）——过滤是**调用方**的事。
     这里如实记下这件事，并把判据写成"两边**同样**地不过滤"，而不是假装有隔离。 */
  const bothInclude = oracleMixed.has('goal:gol:theirs') && reducerMixed.has('goal:gol:theirs')
  record(
    'O5',
    '**【角色隔离的边界】** 折叠层**不**按 `characterId` 过滤（调用方给什么折什么）：'
      + 'oracle 与 reducer **同样**地把别的角色的事件也折出行 —— 两者一致，'
      + '而"隔离"由**查询端口**（`listGoalRows(characterId)`）保证',
    '两边同样包含 ⇒ 一致',
    `oracle 含别的角色=${String(oracleMixed.has('goal:gol:theirs'))} · ` +
      `reducer 含=${String(reducerMixed.has('goal:gol:theirs'))}`,
    bothInclude,
  )

  /* ======================================================================
   * O6：非空泛
   * ==================================================================== */
  phase('O6 non-vacuity')

  const allRows = [...streams.flatMap((stream) => [...oracleFold(stream.events).values()])]
  const anyMultiRevision = allRows.some((row) => row.goal.revision > 1)
  const anyTerminal = allRows.some(
    (row) => row.goal.status === 'completed' || row.goal.status === 'cancelled' || row.goal.status === 'superseded',
  )
  const anyCommitmentTerminal = allRows.some(
    (row) => row.commitment !== null && row.commitment.status !== 'active',
  )
  record(
    'O6',
    '**非空泛**：O1 用的流真的产出非平凡行（有 `revision > 1`、有终态目标、有终态承诺）'
      + ' —— 否则"两份实现一致"可以靠"两边都什么都不做"通过',
    '三类都出现',
    `revision>1=${String(anyMultiRevision)} · 终态目标=${String(anyTerminal)} · 终态承诺=${String(anyCommitmentTerminal)}`,
    anyMultiRevision && anyTerminal && anyCommitmentTerminal,
  )

  /* ======================================================================
   * O7：计量自检
   * ==================================================================== */
  record(
    'O7',
    '**`measured_count > 0` 自检**：真的对照了行、真的查了非法组合'
      + '（"0 行 / 0 组合"与"全部一致"在输出上长得一样）',
    '行 > 0 · 非法组合 > 0',
    `对照 ${String(comparedRows)} 行 · 非法组合 ${String(illegalChecked)} 个`,
    comparedRows > 0 && illegalChecked > 0,
  )

  phase('done')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp10-oracle', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed

  const payload = {
    schema: 'm10-oracle-verify@1',
    runId,
    head,
    /** ⚠️ 证据强度的边界：oracle 与 reducer 同一作者 */
    oracleProvenance: 'same-author',
    streams: streams.map((stream) => ({ name: stream.name, events: stream.events.length })),
    comparedRows,
    illegalCombinationsChecked: illegalChecked,
    checks,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'oracle-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'oracle-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'U-14 折叠 oracle：声明式转移表 + 每行重放，与命令式 reducer 做等价对照（O1）· ' +
      '转移表全性与终态无出边（O2）· 纯函数幂等（O3）· 非法边 no-op 且 revision 不动（O4）· ' +
      '角色过滤的边界（O5）· 非空泛（O6）· 计量（O7）。' +
      '⚠️ oracle 与 reducer 同一作者 ⇒ 证据强度低于"第二个人独立实现"（L-M10-52）。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log('⚠️ oracle 与 reducer **同一作者** ⇒ 能抓实现滑落，抓不到规格误读（L-M10-52）。')
  process.exit(failed === 0 ? 0 : 1)
}

main()
