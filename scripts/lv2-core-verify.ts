/**
 * Lv2 WP2 —— **核心合法路径的三段式控制**（`lv2:core:verify`）。
 *
 * ============================================================================
 *  它回答什么（`docs/lv2/Lv2-Acceptance-Plan.md` §3 / §6 C07，用户裁定 `LV2-D04`）
 * ============================================================================
 * 计划 §3 对"当前配置中启用的能力"提的硬要求是：
 *   「取得当前候选的**非零正控与负控**；保持启用配置时不能用'未触发'替代通过」。
 * 用户裁定 `LV2-D04` 把它具体化为：**先修快路径字段接纳缺口**（`R-29`）——
 * 使**原生生产路径**（每轮一次的目标理解链）真的能记下一条承诺；**慢路径保持 `off`**。
 *
 * 但 `R-29` 的契约修复（`4f8474d8`）只保证了**契约层**能表达承诺（`GOAL_DRAFT_FIELD_ALLOWLIST`
 *  += `commitment: ['create']`），`m10.1:policy:verify` 的 P10 也只在**草案级**验了它。
 * **没有一处证明**"这句话经**原生轮次链**跑完会真的落成一条 `COMMITMENT_ACCEPTED`"。
 * 而 200 轮真模型长链的读数是 **0 条承诺**（`R-33`）——那是"没发生"，**不是**"不可能发生"。
 * ⇒ 本门补的正是这一步：**确定性的（脚本化 provider）端到端正控**，把"不可能"与"没发生"分开。
 *
 * ```text
 * A1 正控  · 原生快路径：明确接受的约定 ⇒ 目标 + 承诺**真的写入**，且采纳出处 = 本轮用户事件
 * A2 负控  · 同一句话但草案**不带承诺** ⇒ 目标照写、**承诺行 = 0**（防"有写入就算过"）
 * A3 负控  · 草案在承诺里**写了 id** ⇒ `unknown_field`（模型编不了 id 的机械闸）
 * A4 负控  · 承诺判据用了模型面**不允许的档** ⇒ `enum_value_unknown`
 * A5 负控  · 承诺挂在**非 create** 的操作上 ⇒ `field_present_for_operation`
 * A6 恢复  · 回到 A1 的形状 ⇒ 又写一条（证明前四条不是"碰巧一次"）
 * C1a 记录 · **程序侧**草案（带 `acceptanceEventIds`）走模型面校验器 ⇒ `unknown_field`
 * C1b 正控 · 同一份程序侧草案走**生产路由**（`draftToProgramProposal` → 放行口）⇒ 承诺写了
 * B1 边界  · 闲聊句 + 草案仍带承诺 ⇒ **会被写入**（快路径**没有**机械守卫，唯一闸是提示词）
 * ```
 *
 * ⚠️ **B1 是边界读数，不是门**：把它算成"负控失败"会掩盖真实设计边界
 *    （`L-M10.1-09` 逐字："字段接纳之后每轮一次的目标理解链也能产承诺 ⇒ 模型可能过早把闲聊当承诺"）。
 *    它的作用是把"机械闸在哪一层"钉死：**闸在提示词，不在放行口**。
 *
 * ⚠️ **零模型请求**（`fixedProvider`，绝不出网）· **零真实库**（`isolateDatabase`）·
 *    零外部能力。`lv2-manifest@1` 的 `requests.planned = actual = 0`。
 *
 * 用法：`pnpm lv2:core:verify`
 */

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('lv2-core', { keep: false })

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { GOAL_PROPOSAL_SCHEMA_VERSION } from '../src/kernel/contracts/goal-proposal.ts'
import { validateAgreementDraft } from '../src/kernel/contracts/agreement-input.ts'
import { buildAgreementProposal } from '../src/kernel/app/agreement/proposal.ts'
import { draftToProgramProposal } from '../src/kernel/app/goal/understanding.ts'
import type { GoalTurnResult } from '../src/kernel/app/goal/turn.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createM4Harness } from './m4-harness.ts'
import { createM10TurnHarness, deterministicRuntime, fixedProvider } from './m10-harness.ts'
import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

interface Check {
  readonly id: string
  readonly group: string
  readonly pass: boolean
  readonly expected: string
  readonly observed: unknown
}

/** 从轮次结果里取草案被拒的**具名**理由（`unknown_field` / `enum_value_unknown` / …）。 */
function rejectionReasonOf(result: GoalTurnResult): string | null {
  const trace = result.trace as { proposal?: { rejectionReason?: string } }
  return trace.proposal?.rejectionReason ?? null
}

const checks: Check[] = []
const boundaries: { id: string; note: string; observed: unknown }[] = []
const record = (id: string, group: string, pass: boolean, expected: string, observed: unknown): void => {
  checks.push({ id, group, pass, expected, observed })
}

async function main(): Promise<void> {
  const started = new Date().toISOString()
  const h = await createM4Harness({ label: 'lv2-core' })
  const characterId = h.kernel.characterId
  const goals = createM10TurnHarness({ db: h.db, characterId, userId: h.userId })
  const recorder = new ConversationRecorder({
    db: h.db,
    characterId,
    conversationId: asConversationId('lv2-core-native'),
    dryRun: false,
    userId: h.userId,
    userName: 'Alex',
    characterName: '苏沐薇',
    transport: 'lv2-core-controlled-console',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
  })
  let sequence = 0
  /** 把一句话写进**真实账本**（拿它的出处 id），再走**真原生链**跑一轮。 */
  const record_ = async (text: string) => {
    const row = await recorder.recordUserMessage(text, ++sequence)
    if (!row.event) throw new Error(`原生用户事件没有落库：${text}`)
    return { row, eventId: String(row.event.id), text }
  }
  const turn = async (
    source: { eventId: string; text: string },
    draft: unknown,
  ): Promise<GoalTurnResult> =>
    goals.turn({
      currentInput: source.text,
      sourceEventId: source.eventId,
      now: Date.now(),
      provider: fixedProvider(draft),
      runtime: deterministicRuntime(),
    })
  const commitmentEvents = async () =>
    (await domainEventsFor(h.db, characterId)).filter((event) => String(event.type) === 'COMMITMENT_ACCEPTED')
  const spanOf = (text: string) => ({ start: 0, end: [...text].length })
  const createDraft = (source: { text: string }, statement: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
    operation: 'create',
    span: spanOf(source.text),
    statement,
    origin: 'user_requested',
    ...extra,
  })
  const commitmentOf = (scope: string, criterion: unknown = { kind: 'user_report' }, extra: Record<string, unknown> = {}) => ({
    commitment: { scope, criterion, ...extra },
  })

  let cleanClose = false
  try {
    /* ---------------------------------------------------------------------
     * A1 · 正控：原生快路径 + 明确接受 ⇒ 目标与承诺**都**写入
     * ------------------------------------------------------------------- */
    const a1Text = '好，就按你说的，明天十点楼下见，一起去核对旧提纲。'
    const a1Statement = '明天十点楼下见，一起去核对旧提纲'
    const a1Source = await record_(a1Text)
    const a1Before = (await commitmentEvents()).length
    const a1 = await turn(
      a1Source,
      createDraft(a1Source, a1Statement, commitmentOf(a1Statement)),
    )
    const a1Events = await commitmentEvents()
    const a1Row = (await goals.listStates()).find((row) => row.goal.statement === a1Statement)
    const a1Refs = (a1Row?.commitment?.acceptanceRefs ?? []) as readonly { conversationEventId?: string }[]
    record(
      'A1-positive-native-create-with-commitment',
      'agreement',
      a1.outcome === 'accepted' &&
        a1Events.length - a1Before === 1 &&
        a1Row?.commitment?.status === 'active' &&
        a1Refs.some((ref) => String(ref.conversationEventId) === a1Source.eventId),
      'outcome=accepted 且 承诺行 +1 且 status=active 且 采纳出处 = 本轮用户事件',
      {
        outcome: a1.outcome,
        acceptedEventTypes: a1.trace.event.acceptedEventTypes,
        commitmentRowsDelta: a1Events.length - a1Before,
        commitmentStatus: a1Row?.commitment?.status ?? null,
        acceptanceRefs: a1Refs,
        sourceEventId: a1Source.eventId,
      },
    )

    /* ---------------------------------------------------------------------
     * A2 · 负控：同一句话、草案**不带承诺** ⇒ 目标照写，承诺行 = 0
     * ------------------------------------------------------------------- */
    const a2Text = '好，就按你说的，后天下午三点在图书馆门口见。'
    const a2Statement = '后天下午三点在图书馆门口见'
    const a2Source = await record_(a2Text)
    const a2Before = (await commitmentEvents()).length
    const a2 = await turn(a2Source, createDraft(a2Source, a2Statement))
    const a2After = (await commitmentEvents()).length
    const a2Row = (await goals.listStates()).find((row) => row.goal.statement === a2Statement)
    record(
      'A2-negative-no-commitment-in-draft',
      'agreement',
      a2.outcome === 'accepted' && a2After - a2Before === 0 && a2Row?.goal.goalId !== undefined,
      'outcome=accepted 且 目标写了 且 承诺行 +0',
      {
        outcome: a2.outcome,
        goalCreated: a2Row?.goal.goalId !== undefined,
        commitmentRowsDelta: a2After - a2Before,
      },
    )

    /* ---------------------------------------------------------------------
     * A3 · 负控：承诺里**写了 id** ⇒ `unknown_field`（模型编不了 id）
     * ------------------------------------------------------------------- */
    const a3Text = '行，那就按这个来：周末一起把材料整理好。'
    const a3Statement = '周末一起把材料整理好'
    const a3Source = await record_(a3Text)
    const a3Before = (await commitmentEvents()).length
    const a3 = await turn(
      a3Source,
      createDraft(
        a3Source,
        a3Statement,
        commitmentOf(a3Statement, { kind: 'user_report' }, { acceptanceEventIds: [a3Source.eventId] }),
      ),
    )
    const a3After = (await commitmentEvents()).length
    record(
      'A3-negative-inner-id-rejected',
      'agreement',
      a3.outcome !== 'accepted' && rejectionReasonOf(a3) === 'unknown_field' && a3After - a3Before === 0,
      'outcome≠accepted 且 理由 = unknown_field 且 承诺行 +0',
      { outcome: a3.outcome, reason: rejectionReasonOf(a3), commitmentRowsDelta: a3After - a3Before },
    )

    /* ---------------------------------------------------------------------
     * A4 · 负控：判据用了模型面**不允许的档** ⇒ `enum_value_unknown`
     * ------------------------------------------------------------------- */
    const a4Text = '行，那就说定了：下周把实验数据整理出来。'
    const a4Statement = '下周把实验数据整理出来'
    const a4Source = await record_(a4Text)
    const a4Before = (await commitmentEvents()).length
    const a4 = await turn(
      a4Source,
      createDraft(
        a4Source,
        a4Statement,
        commitmentOf(a4Statement, { kind: 'action_result' }),
      ),
    )
    const a4After = (await commitmentEvents()).length
    record(
      'A4-negative-criterion-not-model-face',
      'agreement',
      a4.outcome !== 'accepted' && rejectionReasonOf(a4) === 'enum_value_unknown' && a4After - a4Before === 0,
      'outcome≠accepted 且 理由 = enum_value_unknown 且 承诺行 +0',
      { outcome: a4.outcome, reason: rejectionReasonOf(a4), commitmentRowsDelta: a4After - a4Before },
    )

    /* ---------------------------------------------------------------------
     * A5 · 负控：承诺挂在**非 create** 的操作上 ⇒ `field_present_for_operation`
     * ------------------------------------------------------------------- */
    const a5Text = '我们现在有哪些目标？'
    const a5Source = await record_(a5Text)
    const a5Before = (await commitmentEvents()).length
    const a5 = await turn(a5Source, {
      schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
      operation: 'query',
      span: spanOf(a5Text),
      ...commitmentOf('不该出现在 query 上的承诺'),
    })
    const a5After = (await commitmentEvents()).length
    record(
      'A5-negative-commitment-on-query',
      'agreement',
      a5.outcome !== 'accepted' &&
        rejectionReasonOf(a5) === 'field_present_for_operation' &&
        a5After - a5Before === 0,
      'outcome≠accepted 且 理由 = field_present_for_operation 且 承诺行 +0',
      { outcome: a5.outcome, reason: rejectionReasonOf(a5), commitmentRowsDelta: a5After - a5Before },
    )

    /* ---------------------------------------------------------------------
     * A6 · 恢复：回到 A1 的形状 ⇒ **又**写一条（`measured_count > 0` 的第二笔）
     * ------------------------------------------------------------------- */
    const a6Text = '好，那就这么定：这周末一起去把旧照片归档。'
    const a6Statement = '这周末一起去把旧照片归档'
    const a6Source = await record_(a6Text)
    const a6Before = (await commitmentEvents()).length
    const a6 = await turn(a6Source, createDraft(a6Source, a6Statement, commitmentOf(a6Statement)))
    const a6After = await commitmentEvents()
    const a6Row = (await goals.listStates()).find((row) => row.goal.statement === a6Statement)
    record(
      'A6-recovery-second-positive',
      'agreement',
      a6.outcome === 'accepted' && a6After.length - a6Before === 1 && a6Row?.commitment?.status === 'active',
      'outcome=accepted 且 承诺行 +1 且 status=active',
      {
        outcome: a6.outcome,
        commitmentRowsDelta: a6After.length - a6Before,
        commitmentStatus: a6Row?.commitment?.status ?? null,
        totalCommitmentEvents: a6After.length,
      },
    )

    /* ---------------------------------------------------------------------
     * B1 · **边界读数（不是门）**：闲聊句 + 草案仍带承诺 ⇒ 会被写入
     *     —— 快路径的闸在**提示词**，不在放行口（`L-M10.1-09`）
     * ------------------------------------------------------------------- */
    const b1Text = '今天天气不错，窗外挺安静的。'
    const b1Statement = '今天天气不错'
    const b1Source = await record_(b1Text)
    const b1Before = (await commitmentEvents()).length
    const b1 = await turn(b1Source, createDraft(b1Source, b1Statement, commitmentOf('今天天气不错')))
    const b1After = (await commitmentEvents()).length
    boundaries.push({
      id: 'B1-no-mechanical-guard-on-the-model-face-route',
      note:
        '同一句闲聊 + 一份带承诺的草案 ⇒ 放行口**照收**（`outcome=accepted`，承诺行 +1）。' +
        '⇒ 机械闸**不在**放行口：模型面路径对"这算不算约定"**没有**机械判据，' +
        '唯一的闸是提示词里的门槛（`openai-goal-understanding.ts` 的 `FIELD_NOTES.commitment`）。' +
        '这与 `L-M10.1-09` / `R-33` 是同一条边界：真实模型会不会过早产承诺，只能由真模型档回答。',
      observed: {
        outcome: b1.outcome,
        commitmentRowsDelta: b1After - b1Before,
        guardLayer: 'prompt-only',
      },
    })

    /* ---------------------------------------------------------------------
     * C1 · 两条路由分开：程序侧草案**不能**走模型面校验器；生产走直映射
     * ------------------------------------------------------------------- */
    const c1Text = '隔离约定：一起核对旧提纲'
    const proposed = await record_(c1Text)
    const accepted = await recorder.recordAssistantMessage({
      text: '接受，一起核对旧提纲。',
      conversationSequence: ++sequence,
      characterSequence: proposed.row.assistantSequence!,
      replyToEventId: proposed.row.event!.id,
    })
    if (!accepted) throw new Error('原生采纳侧出处没有落库')
    const agreement = validateAgreementDraft(
      {
        kind: 'mutual_agreement',
        content: c1Text,
        criterion: '由对方报告旧提纲核对完成',
        proposedByEventId: proposed.eventId,
        acceptedByEventId: String(accepted.id),
      },
      {
        entries: [
          { id: proposed.eventId, actorType: 'user', sequence: 1, text: c1Text, masked: false },
          { id: String(accepted.id), actorType: 'character', sequence: 2, text: '接受，一起核对旧提纲。', masked: false },
        ],
        facts: { entryCount: 2, characterCount: 1, userCount: 1, windowTruncated: false },
      },
    )
    if (!agreement.ok) throw new Error(`约定夹具被拒：${agreement.reason}`)
    const built = buildAgreementProposal({
      agreement: agreement.value,
      characterId: String(characterId),
      span: spanOf(c1Text),
      proposalId: 'lv2-core-bridge',
      processor: 'lv2-core-controlled',
      processorVersion: 'controlled@1',
      now: Date.now(),
      criterion: { kind: 'user_report' },
    })
    if (!built.ok) throw new Error(`桥构造器被拒：${built.reason}`)

    /* C1a：程序侧草案经**模型面**校验器 ⇒ 必须 `unknown_field`（内层 id 不在模型面闭集里） */
    const c1aBefore = (await commitmentEvents()).length
    const c1a = await turn({ eventId: proposed.eventId, text: c1Text }, built.draft)
    const c1aAfter = (await commitmentEvents()).length
    record(
      'C1a-program-draft-through-model-face-validator',
      'route',
      c1a.outcome !== 'accepted' && rejectionReasonOf(c1a) === 'unknown_field' && c1aAfter - c1aBefore === 0,
      'outcome≠accepted 且 理由 = unknown_field 且 承诺行 +0（程序侧草案不得从模型面进）',
      { outcome: c1a.outcome, reason: rejectionReasonOf(c1a), commitmentRowsDelta: c1aAfter - c1aBefore },
    )

    /* C1b：同一份草案走**生产路由**（`agreement-runner.ts:149` 的直映射）⇒ 承诺写了 */
    const c1bBefore = (await commitmentEvents()).length
    const mapped = draftToProgramProposal(built.draft, {
      characterId: String(characterId),
      sourceEventId: proposed.eventId,
      proposalId: 'lv2-core-bridge-native',
      processor: 'lv2-core-controlled',
      processorVersion: 'controlled@1',
      candidates: [],
      sourceText: c1Text,
      now: Date.now(),
    })
    if (mapped.proposal === undefined) throw new Error('直映射没有产出提案')
    const bridge = await goals.applyProposal(mapped.proposal, Date.now())
    const c1bAfter = (await commitmentEvents()).length
    const c1bRow = (await goals.listStates()).find((row) => row.goal.statement === c1Text)
    record(
      'C1b-production-route-direct-mapping',
      'route',
      bridge.accepted && c1bAfter - c1bBefore === 1 && c1bRow?.commitment?.status === 'active',
      '放行口 accepted 且 承诺行 +1 且 status=active（生产路由 = `agreement-runner` 的直映射）',
      {
        accepted: bridge.accepted,
        acceptedEventTypes: bridge.acceptedEventTypes,
        commitmentRowsDelta: c1bAfter - c1bBefore,
        commitmentStatus: c1bRow?.commitment?.status ?? null,
      },
    )

    /* ---------------------------------------------------------------------
     * 自检：计数型检测器必须自证 `measured_count > 0`（AGENTS §6.8）
     * ------------------------------------------------------------------- */
    const commitmentTotal = (await commitmentEvents()).length
    record(
      'SELF-measured-count-positive',
      'self',
      commitmentTotal >= 3 && checks.length >= 8,
      '承诺行 ≥ 3（A1/A6/C1b）且 门的检查数 ≥ 8',
      { commitmentTotal, checksRecorded: checks.length },
    )
  } finally {
    await h.stop()
    cleanClose = true
  }

  const failed = checks.filter((check) => !check.pass)
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
  const runId = createLv2RunId({ wpId: 'wp2-core', headShort: head })
  const dir = openLv2RunDir(process.cwd(), runId)
  /*
   * 工作树读数：**排除 `artifacts/lv2/` 自己**（否则本门刚建出来的 run 目录会让
   * `clean` 恒为假 —— 与 `scripts/lv2-baseline.ts` 的同一条处理）。
   */
  const worktreeLines = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => !line.slice(3).trim().split(/[\\/]/).join('/').startsWith('artifacts/lv2/'))

  const FINGERPRINTED = [
    'scripts/lv2-core-verify.ts',
    'scripts/lv2-evidence.ts',
    'scripts/m10-harness.ts',
    'src/kernel/contracts/goal-proposal.ts',
    'src/kernel/app/goal/understanding.ts',
    'src/kernel/app/goal/turn.ts',
    'src/kernel/app/agreement/proposal.ts',
    'src/kernel/contracts/agreement-input.ts',
    'src/kernel/policies/goal-validator.ts',
    'src/infrastructure/runtime/agreement-runner.ts',
    'src/infrastructure/model/openai-goal-understanding.ts',
    'docs/lv2/Lv2-WP1-Freeze-Record.md',
  ] as const

  writeFileSync(
    join(dir, 'checks.json'),
    `${JSON.stringify({ runId, checks, boundaries }, null, 2)}\n`,
    'utf8',
  )

  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp2-core',
    head,
    headShort: head.slice(0, 12),
    branch,
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version, platform: process.platform },
    testType: 'native-core-path-controls',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: {
      clean: worktreeLines.length === 0,
      lines: worktreeLines,
      note: '本门自己的 run 目录（`artifacts/lv2/**`）按白名单不计入干净性判断；其余任何改动都会出现在 `lines` 里',
    },
    sourceFingerprints: Object.fromEntries(
      FINGERPRINTED.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
    ),
    config: {
      note: '本门**不读** `.env` 的功能开关：它走的是 `m10-harness` 的直接端口装配，因此"原生链能不能记下承诺"与生产开关无关（`CHARACTER_AGREEMENT_ENABLED` 保持 off 的证据另见 WP0 基线）',
      agreementEnabled: process.env.CHARACTER_AGREEMENT_ENABLED ?? '<unset>',
    },
    model: {
      providerKind: 'scripted-offline',
      providerName: 'm10-fixed-provider',
      endpointHost: null,
      note: '厂商不参与：草案由夹具给出，用来把"不可能"与"没发生"分开',
    },
    requests: {
      planned: 0,
      actual: 0,
      note: '零模型请求：脚本化 provider（绝不出网）',
    },
    denominators: {
      gateChecks: checks.length,
      boundaries: boundaries.length,
      commitmentEventsObserved: (await commitmentEvents()).length,
      positiveWrites: checks.filter((check) => check.id.startsWith('A1') || check.id.startsWith('A6') || check.id.startsWith('C1b')).length,
      negativeControls: checks.filter((check) => check.id.startsWith('A2') || check.id.startsWith('A3') || check.id.startsWith('A4') || check.id.startsWith('A5') || check.id.startsWith('C1a')).length,
    },
    correlations: { cases: checks.length, conversations: 1, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose,
    realDb: {
      opened: false,
      summaryBefore: null,
      summaryAfter: null,
      note: '`isolateDatabase()` 在碰库之前调用；没有打开 `data/pglite`',
    },
    verdict,
    limitation:
      '本门只判**机械可达性**：一份合法的模型面草案经原生链会不会落成承诺，以及四条形状负控是否给出具名理由。' +
      '它**不判**"真实模型会不会产承诺"（那是真模型档，`R-33` 的 200 轮读数 = 0）' +
      '，也**不判** B1 那条边界的用户可见后果（闸在提示词，不在放行口）。',
  })

  console.log(`[lv2:core] runId   = ${runId}`)
  console.log(`[lv2:core] head    = ${head}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id.padEnd(46)} ${check.pass ? '' : `期望 ${check.expected} · 实测 ${JSON.stringify(check.observed)}`}`)
  }
  for (const boundary of boundaries) console.log(`  ⚠️  边界 ${boundary.id}：${boundary.note}`)
  console.log(`[lv2:core] 门检查 ${String(checks.length)} · 通过 ${String(checks.length - failed.length)} · 未通过 ${String(failed.length)}`)
  console.log(`[lv2:core] 模型请求 0 · 真实库未打开 · cleanClose=${String(cleanClose)}`)
  console.log(`[lv2:core] verdict = ${verdict}`)
  console.log(`[lv2:core] manifest = ${manifestPath.replace(`${process.cwd()}\\`, '').split('\\').join('/')}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
