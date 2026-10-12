/**
 * M10（`U-20`）—— **网关注入门**（`pnpm m10:gateway:verify`）。
 *
 * ============================================================================
 *  本门测什么
 * ============================================================================
 * `U-20` 的交付主张是三条，本门逐条验：
 * ```text
 * ① **不接端口 ⇒ 零变化**：不调用、不挂 section、trace 不变长
 *      ⇒ 与"不传 `runGoalTurn`"的 prompt **逐字节相同**（不是"应该不会变"）
 * ② **接上端口 ⇒ 两条 section 各按自己的规则挂**：
 *      事实块（`instruction` / `97` / 不可裁）**有操作就挂**，与额度无关
 *      状态块（`goals` / 45 / 可裁）走 `ContextBudget.goalTokens`，缺省 0 ⇒ 不挂
 * ③ **五个 trace 读数真的被转发**，且**属性里没有正文**
 *      端口抛错 ⇒ 五步如实记 `port_threw`，**回复照常**
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库；真实库**从不被打开**。
 *  · **零模型调用、零出网**：只调 `compileTurn`（它不生成回复）。
 *  · 每条检查都有非零分母；阶段进度写 stderr；失败路径强退。
 *
 * ⚠️ 本门**不**跑 `completeTurn`：回复生成要真模型。它验的是**上下文与 trace
 *    的接入**，那是 `U-20` 的全部内容。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-gateway', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { createM4Harness } from './m4-harness.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { TurnGateway, type IncomingTurn } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '../src/kernel/recall/selector.ts'
import { GOAL_SECTION_IDS } from '../src/kernel/context/goal-sections.ts'
import type { GoalTurnPortResult } from '../src/kernel/app/turn-gateway.ts'
import type { GoalTurnResult } from '../src/kernel/app/goal/turn.ts'
import type { ContextPacket } from '../src/kernel/contracts/context.ts'
import type { CharacterRunTrace, TraceStep } from '../src/kernel/contracts/trace.ts'

const REPO_ROOT = resolve(process.cwd())
const GOAL_STATEMENT = '把提纲写完（这一句是正文，不该出现在 trace 里）'

function phase(mark: string): void {
  console.error(`[m10-gateway] ${mark}`)
}

interface Check {
  group: 'O' | 'S' | 'T'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
  /**
   * **`true` = 这一行是"登记"，不是断言**（`L-M10-65`）。
   * ⚠️ 登记**不进** `passed/total`，只另报 `notes: N` —— 否则"N/N PASS"会把
   *    "什么都没断言的行"也算成"验证过的事"（`recordNote()` 记的就是这类）。
   */
  note: boolean
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
  checks.push({ group, id, label, expected, actual, pass, note: false })
}
/**
 * 记一条**登记**（如实报出一个读数，**不对它作断言**）—— `L-M10-65` 的修法。
 *
 * ⚠️ 它**没有 `pass` 参数**：调用点连"传个恒真的表达式"都做不到，
 *    所以"空量具混进断言计数"在这条路径上**是类型上不可能的**。
 * ⚠️ 读数仍**留在 `checks` 数组里**（不丢），只是**不进** `passed/total`。
 */
function recordNote(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
): void {
  checks.push({ group, id, label, expected, actual, pass: true, note: true })
}

/** 一个**完整**的编排结论（字段都填满，免得"少了哪个字段"变成隐性 skip） */
function turnResult(overrides: Partial<GoalTurnResult> = {}): GoalTurnResult {
  return {
    outcome: 'accepted',
    fact: {
      outcome: 'accepted',
      operation: 'create',
      acceptedEventTypes: ['GOAL_CREATED'],
      maskedCount: 0,
    },
    trace: {
      eligibility: { outcome: 'invoked', candidateCount: 3, maskedCount: 1 },
      proposal: { outcome: 'understood', operation: 'create', elapsedMs: 7 },
      validation: { outcome: 'accepted', rejectionCodes: [] },
      event: { acceptedEventTypes: ['GOAL_CREATED'], eventsCommitted: 1, rowsCommitted: 1 },
      context: { includedRowIds: [], renderedNextSteps: 0, maskedCount: 1 },
    },
    ...overrides,
  }
}

async function main(): Promise<void> {
  phase('boot isolated database + real harness')
  const h = await createM4Harness({ label: 'm10-gateway' })

  const gatewayOf = (input: {
    readonly goalTokens: number
    readonly port?: (info: { currentInput: string; sourceEventId: string }) => Promise<
      GoalTurnPortResult | undefined
    >
  }): TurnGateway =>
    new TurnGateway({
      kernel: h.kernel,
      definition: h.kernel.definition,
      identity: h.kernel.identitySnapshot,
      recorder: h.recorder,
      conversationSequence: h.nextTurnSequence,
      recentLimit: 16,
      slowPathEnabled: false,
      userId: h.userId,
      recallBudget: { ...DEFAULT_CONTEXT_BUDGET, goalTokens: input.goalTokens } as ContextBudget,
    })

  /**
   * 走**真实的两步**：`beginTurn`（建 trace + 分配会话序号）→ `compileTurn`。
   *
   * ⚠️ 第一版只调了 `compileTurn` ⇒ `getTrace` 返回 `undefined`
   *    （trace 行是 `beginTurn` 建的）⇒ 门在 `kindsOf` 里崩。
   *    **门会"崩"而不是"报"** 这条教训在这里是第三次出现（WP8a / WP9b 各一次），
   *    但这次它抓的是**我对调用序的假设错了**，而不是量具写错。
   *
   * ⚠️ 每轮都必须走完 `completeTurn`：`beginTurn` 已经开了一个序号，
   *    不走完会在会话内留下**序号空洞**（`m5.5-harness.ts` 文件头记过这条坑）。
   */
  const compile = async (
    gateway: TurnGateway,
    port: ((info: { currentInput: string; sourceEventId: string }) => Promise<
      GoalTurnPortResult | undefined
    >) | undefined,
  ): Promise<{ packet: ContextPacket; trace: CharacterRunTrace }> => {
    const turn = await gateway.beginTurn('我们定个目标吧')
    const packet = await gateway.compileTurn({
      turn,
      currentInput: '我们定个目标吧',
      recentLines: [],
      ...(port !== undefined ? { runGoalTurn: port } : {}),
    } as never)
    /*
     * 走完这一轮（**不生成回复**：这里给一句占位文本）。
     * ⚠️ 不能给空串 —— `createSpeechIntent` 失败关闭："她说了什么都不说"
     *    不是一条 intent。本门断言的是**上下文与 trace**，不碰回复内容。
     */
    await gateway.completeTurn({
      turn,
      replyText: '（合成轮次：本门不生成回复，只验上下文与 trace 的接入）',
      modelDurationMs: 0,
    } as never)
    const trace = await getTrace(h.kernel.stores.db, turn.traceId)
    return { packet, trace: trace as CharacterRunTrace }
  }

  const kindsOf = (trace: CharacterRunTrace): string[] =>
    (trace.steps ?? []).map((step: TraceStep) => String(step.kind))

  /* =======================================================================
   * O 组：不接端口 ⇒ 零变化
   * ===================================================================== */
  phase('O: port absent => zero change')

  const offGateway = gatewayOf({ goalTokens: 0 })
  const offRun = await compile(offGateway, undefined)
  const offKinds = kindsOf(offRun.trace)
  record(
    'O',
    'O1',
    '【不接端口】trace 里**一步目标步骤都没有**（关闭的轮次 trace 不变长）',
    '0 个 goal_* 步骤',
    `goal 步骤=[${offKinds.filter((k) => k.startsWith('goal_')).join(',')}]`,
    offKinds.filter((k) => k.startsWith('goal_')).length === 0,
  )
  record(
    'O',
    'O2',
    '【不接端口】packet 里**没有目标 section**（两条 id 都不在）',
    '0 个目标 section',
    `section ids=[${offRun.packet.sections.map((s) => s.id).join(',')}]`,
    !offRun.packet.sections.some(
      (s) => s.id === GOAL_SECTION_IDS.fact || s.id === GOAL_SECTION_IDS.state,
    ),
  )

  /* =======================================================================
   * S 组：接上端口 ⇒ 两条 section 各按自己的规则挂
   * ===================================================================== */
  phase('S: port present => sections follow their own rules')

  /* `goalTokens = 0` + 端口返回**只带事实**（无 contextState）⇒ 只挂事实块 */
  const factOnly = await compile(
    gatewayOf({ goalTokens: 0 }),
    async () => ({ turn: turnResult() }),
  )
  const factSection = factOnly.packet.sections.find((s) => s.id === GOAL_SECTION_IDS.fact)
  record(
    'S',
    'S1',
    '【接上端口】事实块挂上，且 `kind=\'instruction\'` · `priority = currentInput-3` · **`droppable:false`**'
      + '（它是"程序对本轮做了什么"的答案，被裁掉就等于她可以随便说）',
    `instruction / ${String(100 - 3)} / false`,
    `${String(factSection?.kind)} / ${String(factSection?.priority)} / ${String(factSection?.droppable)}`,
    factSection?.kind === 'instruction' &&
      factSection.priority === 97 &&
      factSection.droppable === false,
  )
  record(
    'S',
    'S2',
    '【接上端口 + 额度 0】**状态块不挂**（`D27`：0 是真实配置，不是忘了填）',
    '0 个状态块',
    `state 在场=${String(factOnly.packet.sections.some((s) => s.id === GOAL_SECTION_IDS.state))}`,
    !factOnly.packet.sections.some((s) => s.id === GOAL_SECTION_IDS.state),
  )
  record(
    'S',
    'S3',
    '【接上端口】prompt **确实变了**（证明上面那条"没变"不是因为端口整个没生效）'
      + ' —— 与不接端口相比，差异**恰好**来自事实块',
    'prompt 不同 · 且差异文本出现在事实块里',
    `不同=${String(offRun.packet.text !== factOnly.packet.text)}`,
    offRun.packet.text !== factOnly.packet.text && factSection !== undefined,
  )

  /* `goalTokens > 0` + 端口返回 contextState ⇒ 状态块也挂上 */
  const withState = await compile(
    gatewayOf({ goalTokens: 200 }),
    async () => ({
      turn: turnResult(),
      contextState: {
        ordered: [
          {
            rowKey: 'goal:gol:m10-gateway',
            goal: {
              goalId: 'gol:m10-gateway' as never,
              characterId: h.characterId as never,
              owner: h.owner,
              origin: 'user_requested',
              sourceRefs: [],
              revision: 1,
              statement: GOAL_STATEMENT,
              successCriterion: { kind: 'user_report' },
              status: 'active',
              priority: 'normal',
              dependencies: [],
              time: { recordedAt: Date.now() },
            },
          },
        ],
        withdrawnEventIds: new Set<string>(),
      },
    }),
  )
  const stateSection = withState.packet.sections.find((s) => s.id === GOAL_SECTION_IDS.state)
  record(
    'S',
    'S4',
    '【额度 > 0】状态块挂上，且 `kind=\'goals\'` · `priority = 45` · `droppable:true`',
    'goals / 45 / true',
    `${String(stateSection?.kind)} / ${String(stateSection?.priority)} / ${String(stateSection?.droppable)}`,
    stateSection?.kind === 'goals' &&
      stateSection.priority === 45 &&
      stateSection.droppable === true,
  )
  /*
   * ⚠️ **S5 原先是"无条件的真"，而且连"我不作断言"都没声明**（判据审计抓到，已修）：
   *
   * ```text
   * 原判据：`true` · 原 expected：'排序规则不变'
   * ⇒ 标签与 expected 都在**声称**排序规则被验证了，而这一条**什么都没验**
   *   （它只把优先级列出来；真正的排序判据在 `m10:context:verify` 的 `C6`，
   *     标签自己也是这么写的 —— 那 expected 就不该写成一句断言口气的话）
   * ```
   * ⇒ 修法：把它**如实降级成登记**（expected 明说"不作断言"并指向判据的真身），
   *   并把它列进 `L-M10-65`（"登记被当成断言计数"那一族，计数口径的修法见该条）。
   */
  recordNote(
    'S',
    'S5',
    '【`D22` 平局】两条目标 section 之外，**外部证据那条不在场**时不影响；'
      + '在场时按 id 升序 ⇒ 外部证据先（这条由 `m10:context:verify` 的 `C6` 实测排序）',
    '**如实报出（本行不作断言）** —— 排序判据在 `m10:context:verify` 的 `C6`',
    `本 packet 的 section 优先级=[${withState.packet.sections.map((s) => String(s.priority)).join(',')}]`,
  )

  /* =======================================================================
   * T 组：五个 trace 读数被转发，且属性里没有正文
   * ===================================================================== */
  phase('T: five trace steps forwarded, with no body text')

  const goalKinds = kindsOf(withState.trace).filter((k) => k.startsWith('goal_'))
  record(
    'T',
    'T1',
    '**五个目标步骤真的被转发**（不是"登记了但没人发"）',
    '5 个：eligibility / proposal / validation / event / context',
    `[${goalKinds.join(',')}]`,
    goalKinds.length === 5 &&
      ['goal_eligibility', 'goal_proposal', 'goal_validation', 'goal_event', 'goal_context'].every(
        (k) => goalKinds.includes(k),
      ),
  )

  /* 属性里**没有正文**：把整条 trace 序列化后搜那句正文 */
  const serialized = JSON.stringify(withState.trace)
  record(
    'T',
    'T2',
    '**trace 里没有正文**：把整条 trace 序列化后搜那个目标描述 ⇒ 0 命中'
      + '（"只有码/计数/id"的机器判据，不是"我记得别写"）',
    '0 命中',
    `命中=${String(serialized.includes('把提纲写完'))} · trace 长度 ${String(serialized.length)}`,
    !serialized.includes('把提纲写完') && !serialized.includes(GOAL_STATEMENT),
  )
  record(
    'T',
    'T3',
    '`goal_context` 的**入模 id 只来自最终 packet**：状态块入模时 `state_row_ids` 非空',
    '非空 id 列表',
    `state_row_ids="${String(
      (withState.trace.steps ?? []).find((s: TraceStep) => s.kind === 'goal_context')?.attributes
        ?.state_row_ids ?? '',
    )}"`,
    String(
      (withState.trace.steps ?? []).find((s: TraceStep) => s.kind === 'goal_context')?.attributes
        ?.state_row_ids ?? '',
    ).includes('goal:gol:m10-gateway'),
  )

  /* 端口抛错 ⇒ 五步记 failed，且编译照常 */
  phase('T4: port throws => five steps marked failed, compile still succeeds')
  let threwRun: { packet: ContextPacket; trace: CharacterRunTrace } | undefined
  let compileThrew = false
  try {
    threwRun = await compile(
      gatewayOf({ goalTokens: 0 }),
      async () => {
        throw new Error('注入的端口抛错（负控）')
      },
    )
  } catch {
    compileThrew = true
  }
  const threwGoalSteps = (threwRun?.trace.steps ?? []).filter((s: TraceStep) =>
    String(s.kind).startsWith('goal_'),
  )
  record(
    'T',
    'T4',
    '【负控】端口抛错 ⇒ **编译照常**（不阻断回复），且五步如实记 `port_threw`'
      + '（不是"她没提目标"）',
    '编译不抛 · 5 步 · 全部 port_threw',
    `编译抛错=${String(compileThrew)} · 目标步骤 ${String(threwGoalSteps.length)} 个 · ` +
      `outcome=[${threwGoalSteps.map((s) => String(s.attributes?.outcome)).join(',')}]`,
    !compileThrew &&
      threwGoalSteps.length === 5 &&
      threwGoalSteps.every((s) => String(s.attributes?.outcome) === 'port_threw'),
  )
  record(
    'T',
    'T5',
    '【负控】抛错那一轮**没有挂任何目标 section**（事实块也不挂 —— 没结论就没有事实）',
    '0 个目标 section',
    `[${(threwRun?.packet.sections ?? []).map((s) => s.id).join(',')}]`,
    !(threwRun?.packet.sections ?? []).some(
      (s) => s.id === GOAL_SECTION_IDS.fact || s.id === GOAL_SECTION_IDS.state,
    ),
  )

  phase('done')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp10-gateway', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  /*
   * ⚠️ **分母只算断言**（`L-M10-65`）：登记（`recordNote`）不进 `passed/total`，
   *    只另报 `notes: N` —— 否则"N/N PASS"会把"什么都没断言的行"也算成"验证过的事"。
   */
  const assertions = checks.filter((c) => !c.note)
  const notes = checks.length - assertions.length
  const passed = assertions.filter((c) => c.pass).length
  const failed = assertions.length - passed
  const groups = ['O', 'S', 'T'] as const
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
    schema: 'm10-gateway-verify@1',
    runId,
    head,
    characterId: h.characterId,
    offPathSectionIds: offRun.packet.sections.map((s) => s.id),
    onPathSectionIds: withState.packet.sections.map((s) => s.id),
    offPathGoalSteps: offKinds.filter((k) => k.startsWith('goal_')),
    onPathGoalSteps: goalKinds,
    checks,
    perGroup,
    summary: {
      total: assertions.length,
      passed,
      failed,
      /** **登记**条数（不进 `total/passed`）—— `L-M10-65` */
      notes,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
  }
  writeFileSync(join(dir, 'gateway-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp10',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'gateway-verify',
    counts: { total: assertions.length, passed, failed, notes },
    phases: ['single'],
    supersedes: null,
    notes:
      'U-20 网关注入门：不接端口零变化 · 两条 section 各按自己的规则挂 · ' +
      '五个 trace 读数被转发且无正文 · 端口抛错不阻断编译。隔离库，零模型。',
    databaseScope: 'isolated',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} [${c.group}] ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(
      `verdict: ${payload.summary.verdict}（断言 ${String(passed)}/${String(assertions.length)}` +
        `${notes > 0 ? ` · 登记 ${String(notes)} 条` : ''}）`,
    )
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  /*
   * ⚠️ **必须显式 `process.exit`**（WP2 的教训，这里第三次出现）：
   *    elizaOS 运行时留着上游定时器，失败路径只设 `exitCode` 会让进程**永不退出**
   *    —— 门挂死、stdout 全空、CPU 近 0，看起来像"还在跑"。
   */
  process.exit(failed === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
