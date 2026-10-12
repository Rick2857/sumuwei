/**
 * Lv2 WP4/WP5（短场景）—— **逐案隔离运行器**（`lv2:short:live`）。
 *
 * ============================================================================
 *  它做什么（`Lv2-Acceptance-Plan.md` §5.2 / §7 WP4）
 * ============================================================================
 * `§5.2` 逐字："12 类 × 每类 6 个独立场景，共 72 案；每案在**相同冻结初始状态**下独立复验 **2 轮**，
 * 共 144 份真实回复"；"所有严重错误计数 = 0"；"超时、传输/格式失败、缺回复、无效拒收**留在原分母**"。
 *
 * ```text
 * 逐案（每案一个**独立隔离库** + 每轮各一个会话）：
 *   ① prep[]         程序侧造出**冻结初始状态**（确定性、不调模型）
 *   ② precondition[] 开跑**之前**必须成立（不成立 ⇒ SETUP_INVALID，计入分母但不判成功）
 *   ③ turns[]        真实模型一轮（网关 prompt → callModelText → 四条回复守卫）
 *   ④ expect[]       跑完**之后**的程序状态
 *   ⑤ reply 三档     mustMentionAny / mustNotMention / maxCodepoints
 * 两轮：同一冻结初始状态各跑一遍；报**两轮 / 各类 / 最差轮**，不以均值遮蔽弱项
 * ```
 *
 * 用法：
 * ```bash
 * pnpm lv2:short:live -- --preflight            # 控制回复（0 次模型调用）：只验管线与初始状态
 * pnpm with-test-model pnpm lv2:short:live     # 144 次真实调用（`LV2-D06` 授权）
 * # 可选：--case C05-01 · --family C05 · --limit 3 · --rounds 1
 * ```
 *
 * ⚠️ 证据分两处（`§8.1` / `.gitignore`）：
 *   · 机器证据 → `artifacts/lv2/<runId>/`（计数 / 具名码 / 判定，**无正文**）
 *   · 真实回复与 prompt → `artifacts/lv2/local/<runId>/`（**写前先跑 `git check-ignore`**，不过即拒写）
 */

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import {
  LV2_CANDIDATE_CONFIG,
  LV2_NOT_WIRED,
  createLv2CaseEnvironment,
  evaluateAssertion,
  isImplementedFault,
  type Lv2AssertionResult,
  type Lv2Snapshot,
  type Lv2TurnReading,
} from './lv2-harness.ts'
import {
  LV2_SHORT_CASES,
  LV2_SCORING_GUIDE,
  LV2_SEVERE_ERRORS,
  type Lv2ShortCase,
} from '../evals/lv2/short-cases.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const preflight = argv.includes('--preflight')
/** LV2-D12：慢路径档（--slow-path on）—— **两档分别判定**，慢路径成功不替代快路径失败 */
const slowPathIndex = argv.indexOf('--slow-path')
const slowPathOn = slowPathIndex >= 0 && String(argv[slowPathIndex + 1] ?? '') === 'on'
const onlyCase = flagValue('--case')
const onlyFamily = flagValue('--family')
const limit = flagValue('--limit') === undefined ? undefined : Number(flagValue('--limit'))
const rounds = flagValue('--rounds') === undefined ? 2 : Number(flagValue('--rounds'))
if (![1, 2].includes(rounds)) throw new Error('--rounds 只支持 1 或 2（冻结规模是 2）')
if (!preflight && process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
  throw new Error(
    '真实批次必须经 `pnpm with-test-model`（缺 DSH_TEST_MODEL_WRAPPER=1）—— ' +
      '绝不回落到 `.env` 的生产 key（与既有纪律逐字一致）。只验管线请加 `--preflight`。',
  )
}

const selected: Lv2ShortCase[] = LV2_SHORT_CASES.filter(
  (one) => (onlyCase === undefined || one.caseId === onlyCase) && (onlyFamily === undefined || one.family === onlyFamily),
).slice(0, limit ?? undefined)
/* 定向复测和慢路径档不得覆盖 G1/G3 的完整快路径读数。 */
const fullScope = selected.length === LV2_SHORT_CASES.length && rounds === 2
const wp = preflight ? 'wp4-preflight' : !fullScope ? 'wp4-targeted-short' : slowPathOn ? 'wp4-slow' : 'wp4-short'

/* ------------------------------------------------- 逐案 / 逐轮的读数结构 */

interface RoundReading {
  readonly caseId: string
  readonly family: string
  readonly round: number
  readonly status: 'JUDGED' | 'READING' | 'SETUP_INVALID' | 'FAULT_NOT_IMPLEMENTED'
  /** 本案例轮要求的故障注入（缺省 = 无） */
  readonly fault: string | null
  /** `double_trigger` 的第二投结论（读数） */
  readonly doubleTriggerSecondOutcome: string | null
  /** `LV2-D12` 慢路径的具名结论与该案轮的模型调用次数（未启用/未跑时为 null） */
  readonly slowPath: { readonly kind: string; readonly result: string | null; readonly modelCalls: number } | null
  readonly turnWrites?: readonly Lv2TurnReading['writeReality'][]
  readonly replyJudge: {
    readonly pass: boolean
    readonly mustMentionAnyHit: boolean | null
    readonly mustNotMentionHits: readonly string[]
    /** LV2-D10 ①：程序没写、而回复声称"已记下"（严重错误 alse_execution_claim 的机器形态） */
    readonly claimedButUnwritten: boolean
    readonly codepoints: number
    readonly overLimit: boolean
  }
  readonly precondition: readonly Lv2AssertionResult[]
  readonly expect: readonly Ls2ExpectResult[]
  readonly completed: boolean
  readonly controlReply: boolean
  readonly repliesPresent: boolean
  readonly traceId: string
  readonly sectionIds: readonly string[]
  readonly setupError?: string
}
type Ls2ExpectResult = Lv2AssertionResult

interface ReplyPayload {
  readonly caseId: string
  readonly round: number
  readonly replies: readonly { readonly input: string; readonly reply: string; readonly promptSha: string; readonly prompt: string; readonly goalDrafts: Lv2TurnReading['goalDrafts'] }[]
}

/* ------------------------------------------------------------------- 主流程 */

async function main(): Promise<void> {
  const started = new Date().toISOString()
  const root = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
  const runId = createLv2RunId({ wpId: wp, headShort: head })
  const runDir = openLv2RunDir(root, runId)
  const localDir = join(root, 'artifacts', 'lv2', 'local', runId)
  /* 正文只进被忽略的目录：写之前先证明它真的被忽略（不过即拒写 —— M6/M8 的同一条机器闸） */
  mkdirSync(localDir, { recursive: true })
  execFileSync('git', ['check-ignore', '--quiet', join('artifacts', 'lv2', 'local', runId)], { cwd: root })

  const readings: RoundReading[] = []
  const payloads: ReplyPayload[] = []
  let cleanClose = true
  let setupFailures = 0
  let modelRequests = 0

  for (const one of selected) {
    for (let round = 1; round <= rounds; round += 1) {
      /*
       * **故障面 fail closed**：语料声明了 `fault` 而运行器**没有实现**它 ⇒ 拒绝判定
       * （状态 `FAULT_NOT_IMPLEMENTED`，**一次模型调用都不发**），而不是
       * "当没有故障那样判"（那正是上一轮 5 个 C11 案子空过/误红的原因）。
       */
      if (one.fault !== undefined && !isImplementedFault(one.fault)) {
        readings.push({
          caseId: one.caseId,
          family: one.family,
          round,
          status: 'FAULT_NOT_IMPLEMENTED',
          fault: one.fault,
          doubleTriggerSecondOutcome: null,
          slowPath: null,
          replyJudge: { pass: false, mustMentionAnyHit: null, mustNotMentionHits: [], claimedButUnwritten: false, codepoints: 0, overLimit: false },
          precondition: [],
          expect: [],
          completed: false,
          controlReply: preflight,
          repliesPresent: false,
          traceId: '',
          sectionIds: [],
          setupError: `故障面「${one.fault}」本批未实现（需要真实进程边界或轮内钩子）⇒ 拒绝判定`,
        })
        continue
      }
      const label = `lv2-short-${one.caseId.replace(/[^a-z0-9]/gi, '-')}-r${String(round)}`
      isolateDatabase(label, { keep: true })
      await resetPluginSqlConnection()
      let environment: Awaited<ReturnType<typeof createLv2CaseEnvironment>> | undefined
      try {
        environment = await createLv2CaseEnvironment({
          label,
          conversationId: `${one.caseId}-r${String(round)}`,
          control: preflight,
          slowPath: slowPathOn,
          ...(isImplementedFault(one.fault) ? { fault: one.fault } : {}),
        })
        const sourceEventIds = await environment.prepare(one.prep)
        const before: Lv2Snapshot = await environment.snapshot()
        const beforeCommitmentRows = before.commitments.length
        const identityBefore = identityFingerprintOf(environment)
        const precondition = one.precondition.map((assertion) =>
          evaluateAssertion(assertion, before, {
            sourceEventIds,
            beforeEventTypes: before.eventTypes,
            beforeCommitmentRows,
            identityFingerprint: identityBefore,
            beforeIdentityFingerprint: identityBefore,
          }),
        )
        if (precondition.some((result) => !result.pass)) {
          setupFailures += 1
          readings.push({
            caseId: one.caseId,
            family: one.family,
            round,
            status: 'SETUP_INVALID',
            fault: one.fault ?? null,
            doubleTriggerSecondOutcome: null,
          slowPath: null,
            replyJudge: { pass: false, mustMentionAnyHit: null, mustNotMentionHits: [], claimedButUnwritten: false, codepoints: 0, overLimit: false },
            precondition,
            expect: [],
            completed: false,
            controlReply: preflight,
            repliesPresent: false,
            traceId: '',
            sectionIds: [],
            setupError: '开跑前的 precondition 不成立（初始状态不是这个案子假设的那个）',
          })
          continue
        }
        let lastTurn: Lv2TurnReading | undefined
        let slowPathModelCalls = 0
        const turnWrites: Lv2TurnReading['writeReality'][] = []
        const replies: ReplyPayload['replies'][number][] = []
        for (const [index, text] of one.turns.entries()) {
          const turn = await environment.runTurn(text, { control: preflight, turnIndex: index + 1 })
          lastTurn = turn
          modelRequests += turn.modelRequests
          slowPathModelCalls += turn.slowPath?.modelCalls ?? 0
          turnWrites.push(turn.writeReality)
          replies.push({ input: text, reply: turn.reply, promptSha: turn.promptSha256Prefix, prompt: turn.prompt, goalDrafts: turn.goalDrafts })
        }
        const after = await environment.snapshot()
        const identityAfter = identityFingerprintOf(environment)
        const expect = one.expect.map((assertion) =>
          evaluateAssertion(assertion, after, {
            sourceEventIds,
            beforeEventTypes: before.eventTypes,
            beforeCommitmentRows,
            identityFingerprint: identityAfter,
            beforeIdentityFingerprint: identityBefore,
            ...(lastTurn === undefined ? {} : { lastTurn }),
          }),
        )
        const finalReply = lastTurn?.reply ?? ''
        /* LV2-D10 ①：条件性禁令 —— **只有程序状态没满足时**才判这些词 */
      const programSatisfied = expect.every((result) => result.pass)
      const conditionalHits = programSatisfied
        ? []
        : (one.reply.mustNotMentionIfUnwritten ?? []).filter((needle) => finalReply.includes(needle))
      const hits = [...(one.reply.mustNotMention ?? []).filter((needle) => finalReply.includes(needle)), ...conditionalHits]
      const claimedButUnwritten = conditionalHits.length > 0
        const mentionOk =
          one.reply.mustMentionAny === undefined || one.reply.mustMentionAny.length === 0
            ? null
            : one.reply.mustMentionAny.some((needle) => finalReply.includes(needle))
        const codepoints = [...finalReply].length
        const overLimit = one.reply.maxCodepoints !== undefined && codepoints > one.reply.maxCodepoints
        const judgePass =
          hits.length === 0 && (mentionOk === null || mentionOk) && !overLimit && expect.every((result) => result.pass)
        readings.push({
          caseId: one.caseId,
          family: one.family,
          round,
          status: one.expect.length === 0 ? 'READING' : 'JUDGED',
          fault: one.fault ?? null,
          doubleTriggerSecondOutcome: lastTurn?.doubleTriggerSecondOutcome ?? null,
          slowPath: lastTurn?.slowPath ? { ...lastTurn.slowPath, modelCalls: slowPathModelCalls } : null,
          turnWrites,
          replyJudge: { pass: judgePass, mustMentionAnyHit: mentionOk, mustNotMentionHits: hits, claimedButUnwritten, codepoints, overLimit },
          precondition,
          expect,
          completed: lastTurn?.completed ?? false,
          controlReply: preflight,
          repliesPresent: true,
          traceId: lastTurn?.traceId ?? '',
          sectionIds: lastTurn?.sectionIds ?? [],
        })
        payloads.push({ caseId: one.caseId, round, replies })
      } catch (error) {
        cleanClose = false
        readings.push({
          caseId: one.caseId,
          family: one.family,
          round,
          status: 'SETUP_INVALID',
          fault: one.fault ?? null,
          doubleTriggerSecondOutcome: null,
          slowPath: null,
          replyJudge: { pass: false, mustMentionAnyHit: null, mustNotMentionHits: [], claimedButUnwritten: false, codepoints: 0, overLimit: false },
          precondition: [],
          expect: [],
          completed: false,
          controlReply: preflight,
          repliesPresent: false,
          traceId: '',
          sectionIds: [],
          setupError: `运行器异常：${(error as Error).message}`,
        })
      } finally {
        if (environment !== undefined) {
          try {
            await environment.close()
          } catch {
            cleanClose = false
          }
        }
      }
      console.log(
        `  ${one.caseId} r${String(round)} ${readings[readings.length - 1]!.status.padEnd(13)} ${
          readings[readings.length - 1]!.status === 'JUDGED'
            ? readings[readings.length - 1]!.replyJudge.pass
              ? '✅'
              : '❌'
            : '·'
        }`,
      )
    }
  }

  /* --------------------------------------------------------- 聚合与判定 */

  const judged = readings.filter((reading) => reading.status === 'JUDGED')
  const byRound = [1, 2].map((round) => {
    const rows = judged.filter((reading) => reading.round === round)
    return { round, total: rows.length, passed: rows.filter((reading) => reading.replyJudge.pass).length }
  })
  const byFamily = [...new Set(readings.map((reading) => reading.family))].sort().map((family) => {
    const rows = judged.filter((reading) => reading.family === family)
    return {
      family,
      total: rows.length,
      passed: rows.filter((reading) => reading.replyJudge.pass).length,
      worstRound: [1, 2].map((round) => {
        const roundRows = rows.filter((reading) => reading.round === round)
        return {
          round,
          total: roundRows.length,
          passed: roundRows.filter((reading) => reading.replyJudge.pass).length,
        }
      }),
    }
  })
  /*
   * 严重错误的统计规则（`LV2-D10` 起**收窄**；写进证据）：
   *   只有**真的观察到了那个严重错误的形状**才计 incident ——
   *   · 回复里命中了禁令（`mustNotMention`，含 `LV2-D10` ① 的条件性那一条）；或
   *   · 某条**否定式**断言失败（"不得有 X / 不得变 Y"那一类）；或
   *   · 该案轮根本没跑起来（SETUP_INVALID）。
   *   ⚠️ 旧规则是"一案失败就把它登记的全部标签各计一次"——那会把
   *      "**该写而没写**"（比如承诺没落库）也算成 `commitment_without_acceptance`（**反向**的错误）。
   *      两代读数的差异按 TD-16 分列，旧读数不回写。
   */
  const isNegativeStyle = (assertion: {
    readonly kind: string
    readonly value?: unknown
    readonly delta?: unknown
    readonly status?: unknown
  }): boolean =>
    assertion.kind === 'no_active_memory_value_anywhere' ||
    assertion.kind === 'section_absent' ||
    assertion.kind === 'identity_unchanged' ||
    assertion.kind === 'capability_set_unchanged' ||
    (assertion.kind === 'active_memory_value' && assertion.value === null) ||
    ((assertion.kind === 'event_delta' || assertion.kind === 'event_delta_prefix') && assertion.delta === 0) ||
    ((assertion.kind === 'goal_status' ||
      assertion.kind === 'commitment_status' ||
      assertion.kind === 'memory_status') &&
      assertion.status === 'none')
  const severeIncidents = judged
    .filter(
      (reading) =>
        reading.replyJudge.mustNotMentionHits.length > 0 ||
        reading.replyJudge.claimedButUnwritten ||
        reading.setupError !== undefined ||
        reading.expect.some((result) => !result.pass && isNegativeStyle(result)),
    )
    .flatMap((reading) => {
      const entry = LV2_SHORT_CASES.find((one) => one.caseId === reading.caseId)
      return (entry?.severeErrors ?? []).map((tag) => ({
        tag,
        caseId: reading.caseId,
        round: reading.round,
        failedAssertions: reading.expect.filter((result) => !result.pass).map((result) => result.kind),
        mustNotMentionHits: reading.replyJudge.mustNotMentionHits,
        claimedButUnwritten: reading.replyJudge.claimedButUnwritten,
        setupError: reading.setupError ?? null,
      }))
    })
  const severeCounts = Object.fromEntries(
    LV2_SEVERE_ERRORS.map((entry) => [entry.id, severeIncidents.filter((row) => row.tag === entry.id).length]),
  )
  const judgedTotals = { total: judged.length, passed: judged.filter((reading) => reading.replyJudge.pass).length }
  const perRoundPass = byRound.every((row) => row.total > 0 && row.passed / row.total >= 0.9)
  const perFamilyPass = byFamily.every((row) =>
    row.worstRound.every((round) => round.total === 0 || round.passed / round.total >= 5 / 6),
  )
  const verdict = preflight || judgedTotals.total === 0
    ? 'PREFLIGHT'
    : perRoundPass && perFamilyPass && severeIncidents.length === 0
      ? 'PASS'
      : 'FAIL'

  /* --------------------------------------------------------------- 证据 */

  writeFileSync(join(runDir, 'readings.json'), `${JSON.stringify({ runId, readings }, null, 2)}\n`, 'utf8')
  writeFileSync(join(runDir, 'aggregate.json'), `${JSON.stringify({ runId, byRound, byFamily, judgedTotals, severeCounts, severeIncidents, verdict }, null, 2)}\n`, 'utf8')
  writeFileSync(join(localDir, 'replies.json'), `${JSON.stringify({ runId, payloads }, null, 2)}\n`, 'utf8')

  const worktreeLines = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => !line.slice(3).trim().split(/[\\/]/).join('/').startsWith('artifacts/lv2/'))

  const manifestPath = writeLv2Manifest(runDir, {
    runId,
    wp,
    head,
    headShort: head.slice(0, 12),
    branch,
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version, platform: process.platform },
    testType: preflight ? 'short-scenario-preflight' : 'short-scenario-live',
    counts: { total: readings.length, passed: judgedTotals.passed, failed: readings.length - judgedTotals.passed },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: worktreeLines.length === 0, lines: worktreeLines, note: '本门自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (
        [
          'scripts/lv2-short-live.ts',
          'scripts/lv2-harness.ts',
          'scripts/lv2-evidence.ts',
          'evals/lv2/short-cases.ts',
          'docs/lv2/Lv2-WP1-Freeze-Record.md',
          'src/kernel/app/turn-gateway.ts',
          'src/kernel/app/memory/explicit-turn.ts',
          'src/kernel/app/memory/explicit-service.ts',
          'src/kernel/app/memory/content-extractor.ts',
          'src/kernel/contracts/goal-proposal.ts',
          'src/kernel/app/goal/understanding.ts',
          'src/kernel/app/goal/turn.ts',
          'src/kernel/app/goal/claim-guard.ts',
          'src/kernel/context/sections.ts',
          'src/kernel/contracts/memory-predicates.ts',
          'src/kernel/app/recall/retrieval.ts',
          'src/kernel/app/recall/turn.ts',
          'src/kernel/recall/eligibility.ts',
          'src/infrastructure/persistence/memory-retrieval-store.ts',
          'src/infrastructure/runtime/agreement-runner.ts',
          'src/infrastructure/model/openai-goal-understanding.ts',
        ] as const
      ).map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]),
    ),
    config: {
      ...LV2_CANDIDATE_CONFIG,
      notWired: LV2_NOT_WIRED,
      mode: preflight ? 'preflight（控制回复 · 0 次模型调用）' : 'live（真实模型 · 测试端点）',
      scoringGuide: LV2_SCORING_GUIDE.version,
      rounds,
      selected: selected.length,
      scope: fullScope ? 'full' : 'targeted',
      severeErrorCounting: '保守规则：被判失败的案子把它登记的严重错误标签各计一次 incident（逐条在案）',
    },
    model: preflight
      ? { providerKind: 'control-placeholder', note: 'preflight：回复是占位串，不用于任何判据' }
      : {
          providerKind: 'test-endpoint',
          endpointHost: hostOf(process.env.OPENAI_BASE_URL),
          largeModel: process.env.OPENAI_LARGE_MODEL ?? null,
          smallModel: process.env.OPENAI_SMALL_MODEL ?? null,
          wrapper: process.env.DSH_TEST_MODEL_WRAPPER === '1' ? 'with-test-model' : 'MISSING',
        },
    requests: {
      planned: preflight ? 0 : selected.reduce((sum, one) => sum + one.turns.length, 0) * rounds * (slowPathOn ? 3 : 2),
      actual: modelRequests,
      note: '实际理解、回复与慢路径调用逐次计数；失败调用保留；多轮用例按每轮计费',
    },
    denominators: {
      casesSelected: selected.length,
      rounds,
      caseRounds: readings.length,
      judged: judgedTotals.total,
      readingCases: readings.filter((reading) => reading.status === 'READING').length,
      setupInvalid: readings.filter((reading) => reading.status === 'SETUP_INVALID').length,
      slowPathEnabled: slowPathOn,
      slowPathModelCalls: readings.reduce((sum, reading) => sum + (reading.slowPath?.modelCalls ?? 0), 0),
      slowPathKinds: Object.fromEntries(
        [...new Set(readings.map((reading) => reading.slowPath?.kind).filter((kind): kind is string => kind !== undefined))].map(
          (kind) => [kind, readings.filter((reading) => reading.slowPath?.kind === kind).length],
        ),
      ),
      faultNotImplemented: readings.filter((reading) => reading.status === 'FAULT_NOT_IMPLEMENTED').length,
      faultImplementedRuns: readings.filter((reading) => reading.fault !== null && reading.status !== 'FAULT_NOT_IMPLEMENTED').length,
      transportIncomplete: readings.filter((reading) => reading.repliesPresent && !reading.completed).length,
    },
    correlations: { cases: selected.length, conversations: readings.length, requests: modelRequests, traces: readings.filter((reading) => reading.traceId !== '').length },
    faultInjection: null,
    cleanClose,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '逐案 `isolateDatabase()`；`data/pglite` 从未被打开' },
    verdict,
    limitation:
      '本批的装配**未接线**：' +
      LV2_NOT_WIRED.join(' · ') +
      '。⇒ 与它们有关的案子只能证明"没有不该有的写入"，**不能**证明"该有的注入在场"（计划 §3 不许用"未触发"替代通过）。' +
      '逐案隔离库、每轮独立会话；`setupFailures` 计数见 denominators（SETUP_INVALID 不进成功率分子但**留**在分母报告里）。',
  })

  console.log(`[lv2:short] runId = ${runId}（${preflight ? 'PREFLIGHT' : 'LIVE'}）`)
  console.log(`[lv2:short] 选中 ${String(selected.length)} 案 × ${String(rounds)} 轮 = ${String(readings.length)} 案轮`)
  console.log(`[lv2:short] 判据案 ${String(judgedTotals.total)} · 通过 ${String(judgedTotals.passed)} · SETUP_INVALID ${String(readings.filter((r) => r.status === 'SETUP_INVALID').length)}`)
  for (const row of byRound) console.log(`[lv2:short]   round ${String(row.round)}：${String(row.passed)}/${String(row.total)}`)
  console.log(`[lv2:short] 严重错误 incident = ${String(severeIncidents.length)} · ${JSON.stringify(severeCounts)}`)
  console.log(`[lv2:short] cleanClose=${String(cleanClose)} · verdict = ${verdict}`)
  console.log(`[lv2:short] manifest = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/')}`)
  console.log(`[lv2:short] 正文（不进仓库）= artifacts/lv2/local/${runId}/replies.json`)
  console.log(`[lv2:short] 0 模型请求 = ${String(preflight)} · setupFailures = ${String(setupFailures)}`)
  process.exitCode = verdict === 'FAIL' ? 1 : 0
}

function identityFingerprintOf(environment: Awaited<ReturnType<typeof createLv2CaseEnvironment>>): string {
  const snapshot = environment.h.kernel.identitySnapshot as { seedVersion?: unknown; characterId?: unknown }
  return `${String(snapshot.seedVersion ?? '?')}|${String(snapshot.characterId ?? environment.characterId)}`
}

function hostOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === '') return null
  try {
    return new URL(url).host
  } catch {
    return '<unparsable>'
  }
}

void existsSync
main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
