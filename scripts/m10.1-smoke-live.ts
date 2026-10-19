/**
 * M10.1 WP6 —— **小批真实链**（`m10.1:smoke:live`）。**真模型档**。
 *
 * ============================================================================
 *  它量什么、不量什么
 * ============================================================================
 * ```text
 * 量    ：**约定 → 承诺 → 结清**这条链在**真模型**下能不能跑通（语义识别那一段只有真模型能回答）：
 *         用户说一句约定形状的话 ⇒ 模型会不会产 `create` + `commitment`（R-29 之后模型面能表达它）；
 *         说一句"我到了" ⇒ 会不会产 `report_complete`（映射层据此**同提案**补兑现，见 WP6 的 R-30 修复）。
 * 不量  ：**模型答得对不对**（那是语义评测的逐案读数）；**也不量回复正文**（那是 M3/M5 的 live 门）；
 *         **更不量** `A11` 的"她是否真的不再提"（那是 10 轮 × 两档的行为对照，**NOT RUN**）。
 * ```
 *
 * ============================================================================
 *  三条硬纪律（与 `m10:smoke:live` 同源）
 * ============================================================================
 * ```text
 * ① **守卫：绝不回落生产 key** —— 没有 `DSH_TEST_MODEL_WRAPPER=1` 就拒跑（exit 2）。
 *    本门在**工作树**里跑（那里只有 `.env.test`，**没有** `.env`）⇒ 连"误用生产 key"的可能都不存在；
 *    端点 host 与 key 的**长度**进证据，**取值永不打印**。
 * ② **只断言结构不变量，不断言模型的选择** —— "模型一定会产承诺"会让这道门**看运气**
 *    （且那是"为绿而抽样"的近亲）⇒ 识别读数**如实分列**（有/无都记）。
 * ③ ⭐ **判据不许有空档**：识别这一段可能是"模型没走到"，而**块的样子**那一条**必须**有真读数
 *    ⇒ 无论真模型走到哪一步，本门都会**补齐**一条确定性的结清（`applyProposal`），
 *    再读块；**"这条读数是谁造的"逐条记在证据里**（`closureSource`）。
 * ```
 *
 * ⚠️ `isolateDatabase()` 一次性沙箱库（顶部）—— **真实库从不被打开**。
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { config as loadEnvFromFile } from 'dotenv'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-1-smoke-live', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'




import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { commitmentSummariesOf } from '../src/kernel/app/goal/turn.ts'
import { createM10TurnHarness } from './m10-harness.ts'
import { draftToProgramProposal } from '../src/kernel/app/goal/understanding.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { createOpenAiGoalUnderstandingProvider } from '../src/infrastructure/model/openai-goal-understanding.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_FULFILLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_DOMAIN_EVENT_TYPES,
} from '../src/kernel/contracts/domain-event.ts'
import {
  COMMITMENT_DO_NOT_RAISE,
  commitmentFactRowsOf,
  renderCommitmentStateBlock,
} from '../src/kernel/app/goal/commitment-facts.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_1_smoke_live' as CharacterId
const USER_ID = 'm10-1-smoke-live-user'
const T0 = 2_800_000_000_000
const quantify = (text: string): number => [...text].length
/** 生产端点（AGENTS §8.1 / ADR-069 记的那个）—— **测试档必须不是它** */
const PRODUCTION_ENDPOINT_HOST = 'api.deepseek.com'

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `[m10.1:smoke:live] 拒绝：缺 ${TEST_MODEL_WRAPPER_MARKER}=1 ⇒ 本门**不**回落生产 key（exit 2）。\n` +
      '  跑法（工作树里只有 .env.test）：\n' +
      `    $env:${TEST_MODEL_WRAPPER_MARKER}='1'; node node_modules/tsx/dist/cli.mjs scripts/m10.1-smoke-live.ts`,
  )
  process.exit(2)
}
/*
 * ⚠️ **测试档的 key 必须来自 `.env.test`**：`dotenv/config` 只读 `.env`（工作树里没有），
 *    因此这里显式加载 `.env.test` 并**覆盖**（与 `with-test-model` 的语义一致：测试端点赢）。
 *    随后是一条**独立**的失败关闭判据：解析出来的 host **不许**是生产端点。
 */
loadEnvFromFile({ path: resolve(REPO_ROOT, '.env.test'), override: true })
const resolvedHost = ((): string => {
  try {
    return new URL(process.env.OPENAI_BASE_URL ?? '').host
  } catch {
    return ''
  }
})()
if (resolvedHost === '' || resolvedHost === PRODUCTION_ENDPOINT_HOST) {
  console.error(
    `[m10.1:smoke:live] 拒绝：解析出的端点 host = ${resolvedHost === '' ? '(空/非法)' : resolvedHost}` +
      ` ⇒ 不跑（测试档禁止打生产端点；只打印 host，不打印 key）`,
  )
  process.exit(2)
}

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

async function main(): Promise<void> {
  console.error('[m10.1-smoke-live] boot isolated database + real model provider')
  const agentRuntime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(agentRuntime)
  const db = getRawDb(agentRuntime)
  const harness = createM10TurnHarness({ db, characterId: CHARACTER, userId: USER_ID })
  const provider = createOpenAiGoalUnderstandingProvider()
  const runtime = createRealGoalUnderstandingRuntime()
  const endpointHost = new URL(process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com').host

  const goalEventsOf = async (): Promise<string[]> =>
    (await domainEventsFor(db, CHARACTER))
      .map((event) => String(event.type))
      .filter((type) => (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(type))

  const blockOf = async (): Promise<string> =>
    renderCommitmentStateBlock({
      rows: commitmentFactRowsOf(await harness.listStates()),
      maxTokens: 300,
      quantify,
    })[0]?.content ?? ''

  /* ---------------------------------------------------------------------------
   * 真实模型轨迹（**每一轮都是真调用**）
   * ------------------------------------------------------------------------- */
  const script = [
    { id: 'agreement', text: '明天十点二十五，楼下，带伞和外套。' },
    /* ⚠️ 这一轮刻意写成**明确接受**的形状 —— 提示词里的门槛就是"明确表达或接受" */
    { id: 'accept', text: '行，那就这么定了。我到了跟你说。' },
    { id: 'unrelated', text: '今天天气不错。' },
    { id: 'closure', text: '我到了，就在楼下。' },
    { id: 'unrelated-2', text: '刚才那件事就这样吧。' },
  ] as const

  const turns: {
    id: string
    outcome: string
    eventsAdded: readonly string[]
    acceptedCommitment: boolean
    completed: boolean
  }[] = []
  let modelCalls = 0
  for (const [index, step] of script.entries()) {
    const before = await goalEventsOf()
    const result = await harness.turn({
      currentInput: step.text,
      sourceEventId: `cev:user:smoke-${step.id}`,
      now: T0 + index * 1_000,
      provider,
      runtime,
    })
    modelCalls += 1
    const after = await goalEventsOf()
    const added = after.slice(before.length)
    turns.push({
      id: step.id,
      outcome: result.outcome,
      eventsAdded: added,
      acceptedCommitment: added.includes(String(COMMITMENT_ACCEPTED)),
      completed: added.includes(String(GOAL_COMPLETED)),
    })
  }

  /* ---------------------------------------------------------------------------
   * L1 每轮都有闭集内的结论（**没有"崩了但看起来跑完了"**）
   * ------------------------------------------------------------------------- */
  const CLOSED_OUTCOMES = [
    'no_operation',
    'query',
    'clarify',
    'accepted',
    'rejected',
    'invalid_output',
    'transport_failed',
    'source_unusable',
    'not_invoked',
    'commit_failed',
  ]
  const offClosedSet = turns.filter((turn) => !CLOSED_OUTCOMES.includes(turn.outcome))
  record(
    'L1',
    '【每轮都有闭集内的结论】真实模型 5 轮里没有一轮落进"未知结论"（端口不抛、编排不崩）',
    offClosedSet.length === 0,
    `轮次=${String(turns.length)} · 结论=${JSON.stringify(turns.map((turn) => `${turn.id}:${turn.outcome}`))}`
  )

  /* ---------------------------------------------------------------------------
   * L2 非零分母：至少一轮真的走到写路径
   * ------------------------------------------------------------------------- */
  const written = turns.filter((turn) => turn.eventsAdded.length > 0)
  record(
    'L2',
    '【⭐ 至少一轮真的写了】`measured_count > 0`：真模型轨迹里**至少一轮**落了目标域事件 —— 否则"链跑通了"没覆盖写入',
    written.length > 0,
    `写入轮=${JSON.stringify(written.map((turn) => `${turn.id}:${turn.eventsAdded.join('+')}`))}`
  )

  /* ---------------------------------------------------------------------------
   * L3 ⭐ 识别读数（**如实分列，不要求模型一定成功**）
   * ------------------------------------------------------------------------- */
  const agreementTurn = turns.find((turn) => turn.id === 'agreement')
  const acceptTurn = turns.find((turn) => turn.id === 'accept')
  const closureTurn = turns.find((turn) => turn.id === 'closure')
  const recognized =
    (agreementTurn?.acceptedCommitment ?? false) || (acceptTurn?.acceptedCommitment ?? false)
  record(
    'L3',
    '【识别读数·如实分列】"约定形状"的两轮里，模型**有没有**真的产出一条承诺（`COMMITMENT_ACCEPTED`）—— **有记有、无记无**（本门不把它当 PASS/FAIL 的判据）',
    true,
    `约定轮=${String(agreementTurn?.outcome)}${String(agreementTurn?.acceptedCommitment)} · 接受轮=${String(
      acceptTurn?.outcome
    )}${String(acceptTurn?.acceptedCommitment)} · 识别到了=${String(recognized)}`
  )

  /* ---------------------------------------------------------------------------
   * L4 ⭐⭐ 块的样子（**判据不许有空档**）
   * ------------------------------------------------------------------------- */
  /*
   * ⚠️ 第一版这里是 `closedNow.length === 0 || (...)` —— 于是**真模型没产出承诺**时，
   *    这条判据**短路成真**（"什么都没断言的行"混进 N/N PASS，`L-M10-65` 记的就是这个形状）。
   *    修法：**分支** ——
   *      · 真模型产出了承诺 ⇒ 断言"结清后块里出现不要再提"（真读数）；
   *      · 真模型没产出 ⇒ **由程序补齐一对**（程序侧构造器造的 create+commit，再走**同一个**
   *        映射层与放行口）⇒ 仍然是一条**真读数**，并在证据里记明是谁造的。
   */
  const rowsAfterLive = commitmentFactRowsOf(await harness.listStates())
  let closureSource = rowsAfterLive.length > 0 ? 'live-model' : 'gate-forced-pair'
  if (rowsAfterLive.length === 0) {
    const forcedDraft = {
      schemaVersion: 'goal-proposal@1',
      operation: 'create',
      span: { start: 0, end: 4 },
      statement: '（门造的对照片：一条由对方报告确认的约定）',
      origin: 'user_requested',
      commitment: {
        scope: '（门造的对照片）到时候由对方报告确认',
        criterion: { kind: 'user_report' },
        acceptanceEventIds: ['cev:user:smoke-forced-pair'],
      },
    }
    const created = await harness.applyProposal(
      harness.proposalOf({
        proposalId: 'm10.1-smoke-live-forced-pair',
        operation: 'create',
        characterId: CHARACTER,
        processor: 'm10.1-smoke-live',
        processorVersion: 'm10.1-smoke-live@1',
        sourceConversationEventIds: ['cev:user:smoke-forced-pair'],
        sourceQualifications: [
          { eventId: 'cev:user:smoke-forced-pair', qualification: 'ESTABLISHED' },
        ],
        targets: draftToProgramProposal(forcedDraft as never, {
          characterId: CHARACTER,
          sourceEventId: 'cev:user:smoke-forced-pair',
          proposalId: 'm10.1-smoke-live-forced-pair',
          processor: 'm10.1-smoke-live',
          processorVersion: 'm10.1-smoke-live@1',
          candidates: [],
          sourceText: '（门造的对照片）',
          now: T0 + 20_000,
        }).proposal!.targetEvents,
        } as never),
      T0 + 20_000
    )
    if (!created.accepted) closureSource = `gate-forced-pair-rejected:${created.rejectedCodes.join(',')}`
  }

  const unclosed = commitmentFactRowsOf(await harness.listStates()).filter(
    (row) => row.status === 'active'
  )
  if (unclosed.length > 0) {
    const row = (await harness.listStates()).find((entry) => entry.commitment?.status === 'active')
    if (row !== undefined) {
      const closureDraft = {
        schemaVersion: 'goal-proposal@1',
        operation: 'report_complete',
        span: { start: 0, end: 4 },
        targetGoalId: String(row.goal.goalId),
      }
      const mappedClosure = draftToProgramProposal(closureDraft as never, {
        characterId: CHARACTER,
        sourceEventId: 'cev:user:smoke-forced-closure',
        proposalId: 'm10.1-smoke-live-closure',
        processor: 'm10.1-smoke-live',
        processorVersion: 'm10.1-smoke-live@1',
        candidates: [
          {
            goalId: String(row.goal.goalId),
            status: row.goal.status,
            priority: row.goal.priority,
            statement: row.goal.statement,
            revision: row.goal.revision,
          },
        ],
        sourceText: '我到了。',
        now: T0 + 30_000,
        targetCommitments: commitmentSummariesOf({
          rows: await harness.listStates(),
          visible: (await harness.listStates()).map((entry) => entry.goal),
        }),
      })
      if (mappedClosure.proposal !== undefined) {
        const applied = await harness.applyProposal(mappedClosure.proposal, T0 + 30_000)
        if (!applied.accepted && !closureSource.startsWith('gate-forced')) {
          closureSource = `live-commitment-closure-rejected:${applied.rejectedCodes.join(',')}`
        }
      }
    }
  }
  const finalBlock = await blockOf()
  const closedNow = commitmentFactRowsOf(await harness.listStates()).filter(
    (row) => row.status !== 'active'
  )
  record(
    'L4',
    '【⭐⭐ 结清后 ⇒ 不要再提】承诺存在时：结清后块里**必须**出现「已结清」与「不要再提」' +
      '（`closureSource` 记明这条读数是**真模型**造的还是**程序补齐**的）',
    closedNow.length === 1 &&
      finalBlock.includes('已结清') &&
      finalBlock.includes(COMMITMENT_DO_NOT_RAISE),
    `已结清行=${String(closedNow.length)} · 含已结清=${String(finalBlock.includes('已结清'))} · 含不要再提=${String(
      finalBlock.includes(COMMITMENT_DO_NOT_RAISE)
    )} · 来源=${closureSource}`
  )

  /* ---------------------------------------------------------------------------
   * L5 CLI 现状（**如实报出**真模型走到哪一步；不据此判 PASS/FAIL）
   * ------------------------------------------------------------------------- */
  const liveCompletion = closureTurn?.completed ?? false
  const liveFulfilled = turns.some((turn) => turn.eventsAdded.includes(String(COMMITMENT_FULFILLED)))
  record(
    'L5',
    '【结清读数·如实分列】"我到了"那轮，真模型**有没有**真的走成 `GOAL_COMPLETED`（有 ⇒ 映射层同提案补了兑现）',
    true,
    `我到了那轮=${String(closureTurn?.outcome)} · 真模型结清=${String(liveCompletion)} · 真模型兑现=${String(
      liveFulfilled
    )}`
  )

  /* ---------------------------------------------------------------------------
   * L6 零越界 + 真实库未开
   * ------------------------------------------------------------------------- */
  const allEvents = await domainEventsFor(db, CHARACTER)
  const foreign = allEvents
    .map((event) => String(event.type))
    .filter((type) => !(GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(type))
  const dataDir = process.env.PGLITE_DATA_DIR ?? ''
  record(
    'L6',
    '【零越界 + 未开真实库】只写目标域事件 · 库目录在临时沙箱里（真实库从未被打开）',
    foreign.length === 0 && dataDir !== '' && !dataDir.includes('project LG'),
    `域外=${JSON.stringify(foreign)} · 沙箱=${String(dataDir.includes('Temp') || dataDir.includes('tmp'))}`
  )

  const denominators = {
    turns: turns.length,
    modelCalls,
    /* ⚠️ **只放"结构上必然 > 0"的分母**：`goalDomainEvents` / 承诺行数**可能**是 0
     *    （真模型可能什么都没写）—— 那种零**不是**量具失效，而是 L2/L3 要如实报出的读数。
     *    把它们塞进"非零分母"判据会让这道门在模型不配合时**报错**，而不是**报读数**。 */
    eventTypeWhitelist: GOAL_DOMAIN_EVENT_TYPES.length,
    closedOutcomes: CLOSED_OUTCOMES.length,
  }
  record(
    'L7',
    '【非零分母】结构上必然 > 0 的四类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
    Object.values(denominators).every((value) => value > 0),
    JSON.stringify(denominators) + ` · 另报（可为 0，见 L2/L3）：目标域事件=${String(allEvents.length)} · 承诺行=${String(commitmentFactRowsOf(await harness.listStates()).length)}`
  )

  /* ---------------------------------------------------------------------------
   * 证据
   * ------------------------------------------------------------------------- */
  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm10-1-wp6-smoke-live', headShort: head })
  const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
  const payload = {
    schema: 'm10.1-smoke-live@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    realDbTouched: false,
    model: {
      endpointHost,
      model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)',
      keyPresent: (process.env.OPENAI_API_KEY ?? '').length > 0,
      keyLength: (process.env.OPENAI_API_KEY ?? '').length,
      wrapperMarker: true,
    },
    turns,
    recognition: { recognized, source: 'live-model' },
    closure: { closureSource, liveCompletion, liveFulfilled },
    denominators,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    notRun: [
      {
        id: 'behavioral-comparison-A11',
        why: 'R-26 的**行为级对照**（结清后 10 轮里"提及该约定"的轮数，档 A vs 档 B）要**两档 × 多轮真实对话**，本门只跑 5 轮短链。',
        howToRun: '按 WP6 的 live 车道：同一段 R-26 形状的对话跑两档，数 N 轮里的提及次数，两条读数分列；无下降 ⇒ 记"没有测出效果"。',
      },
      {
        id: 'long-live-200-500',
        why: '`m10.1:long:live`（真模型 200/500 轮）成本高，且离线长链门已覆盖时间维度。',
        howToRun: '`tsx scripts/m10.1-long-verify.ts --turns 200` 的 live 版本（把 fixedProvider 换成真 provider）。',
      },
    ],
    disclaimer:
      '本门只主张"**这条链在真模型下能跑通、且各轮结论都在闭集内**"，以及"**结清后块里确实出现不要再提**"。' +
      '识别率（模型会不会产承诺）与行为效果（她是否真的不再提）**都是如实分列的读数**，不是 PASS/FAIL 判据。',
  }
  writeFileSync(join(dir, 'smoke-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'm10-1-wp6-smoke-live',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'smoke-live',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['live'],
    supersedes: null,
    notes: `m10.1:smoke:live（真模型 ${String(turns.length)} 轮；端点 ${endpointHost}；识别=${String(
      recognized
    )}；结清来源=${closureSource}）`,
  })
  console.log(`runId: ${runId}`)
  console.log(
    `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
