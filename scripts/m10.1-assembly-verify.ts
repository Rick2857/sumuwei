/**
 * M10.1 WP6b —— **装配三跳门**（`m10.1:assembly:verify`，`L-M10.1-05` 的判据）。
 *
 * ============================================================================
 *  它判的是什么：**"她提出"那条路在生产里到底通不通**
 * ============================================================================
 * ```text
 * WP6a 只修了**内核判据的形状**（`draftToProgramProposal` 收 `proposalEvidence`）；
 * 而生产里那条证据**从来没有被送到**那里 —— 登记为 `L-M10.1-05` 的**三跳**：
 *   ① `turn-gateway.ts`：从**最近对话**里取"她上一条**未被遮蔽**的回复"交给目标端口；
 *   ② `goal/turn.ts` ：把这两个字段作为 `proposalEvidence` 交给映射层；
 *   ③ `main.ts`      ：端口签名收下、**原样**转发进 `runGoalTurn`。
 * ⇒ 本门逐跳判，且**用真的东西**判：
 *     ① 走**真 `TurnGateway`**（隔离库 + 真 trace 链，零模型、零出网）
 *     ② 走**真 `runGoalTurn` + 真放行口 + 真写库**，最后从**账本里那条 GOAL_CREATED**
 *        读回 `sourceRefs`（不是读中间变量）
 *     ③ 静态锁（去注释后的代码行）—— 端口签名收两个字段，且 `runGoalTurn` 的调用点
 *        按「两件都齐才带」转发
 * ```
 *
 * ============================================================================
 *  ⭐ 正控 / 负控 / 恢复（`m5.1-measurement` 的三段式）
 * ============================================================================
 * ```text
 * ① **未被遮蔽**的她那条回复        ⇒ 端口收到 { id, text } ⇒ 放行口**接受**（账本里有 2 个 sourceRef）
 * ② **被撤销遮蔽**（占位文本）       ⇒ 端口**两件都不收** ⇒ 放行口按 D28 拒（`goal_proposal_ambiguous_target`）
 * ③ **窗口里没有她的行**            ⇒ 同上拒
 * ④ **D19 整段压制**（撤销集读不出来）⇒ 同上拒
 * ⑤ **id 不相符**（证据不是那条）    ⇒ 同上拒（窄规则：**不放宽**）
 * ⑥ **恢复**：把遮蔽撤掉再跑一遍     ⇒ 又接受（证明 ② 的拒是**注入的条件**造成的，不是门坏了）
 * ```
 *
 * ⚠️ 本门**不调模型**（`m10-harness.ts` 的 `fixedProvider` 是固定输出；`deterministicRuntime`
 *    不碰真实定时器）· **不开真实库**（`isolateDatabase` 一次性沙箱）· **不出网**。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-1-assembly', { keep: false })

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { selectLatestReading } from './m10.1-gate-select.ts'
import { createM4Harness } from './m4-harness.ts'
import { createM10TurnHarness, deterministicRuntime, fixedProvider } from './m10-harness.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { GOAL_CREATED } from '../src/kernel/contracts/domain-event.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '../src/kernel/recall/selector.ts'
import {
  GOAL_PROPOSAL_SCHEMA_VERSION,
  validateGoalProposalDraft,
  type GoalProposalDraft,
} from '../src/kernel/contracts/goal-proposal.ts'
import { goalSpanFingerprint, type GoalUnderstandingInput } from '../src/kernel/app/goal/understanding.ts'
import { buildGoalUnderstandingUserMessage } from '../src/infrastructure/model/openai-goal-understanding.ts'
import {
  lastAssistantEvidenceOf,
  WITHDRAWN_PLACEHOLDER_ASSISTANT,
  type ConversationLine,
} from '../src/kernel/context/sections.ts'

const REPO_ROOT = resolve(process.cwd())
const HER_LINE = '明天十点二十五，楼下。'
const HER_EVENT_ID = 'cev:char:1'
const USER_EVENT_ID = 'cev:user:accept'
const USER_LINE = '行，就那样。'
const FORGOTTEN_USER_EVENT = 'cev:user:forgotten'

function phase(mark: string): void {
  console.error(`[m10.1-assembly] ${mark}`)
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

/* ---------------------------------------------------------------------------
 * 夹具：最近对话（三种形状）
 * ------------------------------------------------------------------------- */
const lineOf = (input: {
  id: string
  actorType: ConversationLine['actorType']
  text: string
  replyToEventId?: string
}): ConversationLine =>
  ({
    id: input.id as never,
    sequence: 1,
    speaker: input.actorType === 'character' ? '苏沐薇' : 'Alex',
    text: input.text,
    actorType: input.actorType,
    ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId as never }),
  }) as ConversationLine

/** 正常形状：用户接受一句 + **她上一轮的提议**（未遮蔽 ⇒ 应当给出证据） */
const normalLines: ConversationLine[] = [
  lineOf({ id: USER_EVENT_ID, actorType: 'user', text: USER_LINE }),
  lineOf({ id: HER_EVENT_ID, actorType: 'character', text: HER_LINE }),
]
/** 她那条回复**复述了被撤销的内容** ⇒ D18 派生面把它换成占位 */
const maskedLines: ConversationLine[] = [
  lineOf({ id: USER_EVENT_ID, actorType: 'user', text: USER_LINE }),
  lineOf({
    id: HER_EVENT_ID,
    actorType: 'character',
    text: HER_LINE,
    replyToEventId: FORGOTTEN_USER_EVENT,
  }),
]

/** 纯函数层先自证一次（选择器本身的正控 / 负控 / 恢复） */
phase('selector: pure-function readings')
const evidenceNormal = lastAssistantEvidenceOf(normalLines)
const evidenceMasked = lastAssistantEvidenceOf([
  { ...maskedLines[1]!, text: WITHDRAWN_PLACEHOLDER_ASSISTANT },
])
const evidenceNoHer = lastAssistantEvidenceOf([normalLines[0]!])
const evidenceEmptyText = lastAssistantEvidenceOf([
  { ...normalLines[1]!, text: '   ' },
] as ConversationLine[])
record(
  'S1',
  '【选择器·正控】未被遮蔽的她那条回复 ⇒ 给出 `{ eventId, text }`（取**最后一条** `actorType=character`）',
  evidenceNormal?.eventId === HER_EVENT_ID && evidenceNormal.text === HER_LINE,
  `eventId=${evidenceNormal?.eventId ?? '(无)'} · text 长度=${String(evidenceNormal?.text.length ?? 0)}`
)
record(
  'S2',
  '【选择器·负控×3】被遮蔽（占位文本）/ 窗口里没有她的行 / 空文本 ⇒ **都不给**（失败关闭，不回退到更早那条）',
  evidenceMasked === undefined && evidenceNoHer === undefined && evidenceEmptyText === undefined,
  `遮蔽=${String(evidenceMasked)} · 没有她的行=${String(evidenceNoHer)} · 空文本=${String(evidenceEmptyText)}`
)

/* ---------------------------------------------------------------------------
 * 前置：隔离库 + 真网关 + 真编排
 * ------------------------------------------------------------------------- */
phase('boot isolated database + real harnesses')
const h = await createM4Harness({ label: 'm10-1-assembly' })
const turnHarness = createM10TurnHarness({
  db: h.kernel.stores.db,
  characterId: h.kernel.characterId,
  userId: h.userId,
})

/** 端口收到的**每一次**信息（按调用顺序）—— 这就是第 ① 跳的读数来源 */
const portCalls: {
  currentInput: string
  sourceEventId: string
  lastAssistantEventId?: string
  lastAssistantText?: string
}[] = []

const gatewayOf = (): TurnGateway =>
  new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: h.nextTurnSequence,
    recentLimit: 16,
    slowPathEnabled: false,
    userId: h.userId,
    recallBudget: { ...DEFAULT_CONTEXT_BUDGET, goalTokens: 0 } as ContextBudget,
  })

/**
 * 走**真实的两步**（`beginTurn` → `compileTurn`）+ 收尾（`completeTurn`）。
 *
 * ⚠️ 三条都是踩过的坑（`m10-gateway-verify` 文件头记着）：trace 行由 `beginTurn` 建；
 *    不跑完 `completeTurn` 会在会话里留**序号空洞**；端口不接 ⇒ 一步都不记。
 */
const compileWithPort = async (input: {
  readonly recentLines: ConversationLine[]
  readonly currentInput?: string
  readonly withdrawnMasking?: { readonly compute: () => Promise<unknown> }
}): Promise<void> => {
  const currentInput = input.currentInput ?? '行，就那样。'
  const gateway = gatewayOf()
  const turn = await gateway.beginTurn(currentInput)
  await gateway.compileTurn({
    turn,
    currentInput,
    recentLines: input.recentLines,
    ...(input.withdrawnMasking === undefined ? {} : { withdrawnMasking: input.withdrawnMasking }),
    runGoalTurn: async (info: {
      currentInput: string
      sourceEventId: string
      lastAssistantEventId?: string
      lastAssistantText?: string
    }) => {
      portCalls.push({ ...info })
      return undefined
    },
  } as never)
  await gateway.completeTurn({
    turn,
    replyText: '（合成轮次：本门只验端口收到了什么，不生成回复）',
    modelDurationMs: 0,
  } as never)
}

phase('hop ①: the gateway hands over the proposal-side evidence')
await compileWithPort({ recentLines: normalLines })
const normalCall = portCalls.at(-1)
record(
  'A1',
  '【① 正控】**真网关**把她上一轮那条回复交给端口：`lastAssistantEventId` = 那条事件 · `lastAssistantText` = 那句原文',
  normalCall?.lastAssistantEventId === HER_EVENT_ID && normalCall?.lastAssistantText === HER_LINE,
  `id=${normalCall?.lastAssistantEventId ?? '(未传)'} · 文本匹配=${String(normalCall?.lastAssistantText === HER_LINE)}`
)

/*
 * ⚠️ 这一档走的是**真的遮蔽路径**：`withdrawnMasking.compute()` 给出撤销集，
 *    网关自己调 `maskWithdrawnLines` 把「复述了被撤内容的她的回复」换成占位 ——
 *    本门断言的是**遮蔽之后**还送不送证据（送占位文本 = 给一条不存在的话做证）。
 */
const withdrawn = (ids: readonly string[], options: { readonly ok?: boolean } = {}) =>
  ({
    ok: options.ok ?? true,
    withdrawnEventIds: [...ids],
    byReason: {},
    gaps: options.ok === false ? ['probe: 撤销集读不出来（D19 压制档）'] : [],
    measuredCount: ids.length,
  }) as never

await compileWithPort({
  recentLines: maskedLines,
  withdrawnMasking: { compute: async () => withdrawn([FORGOTTEN_USER_EVENT]) },
})
const maskedCall = portCalls.at(-1)
record(
  'A2',
  '【① 负控·被遮蔽】她那条回复**复述了被撤销的内容**（D18 派生面）⇒ 端口**两件都不收**（拿占位算指纹 = 给不存在的话做证）',
  maskedCall?.lastAssistantEventId === undefined &&
    maskedCall?.lastAssistantText === undefined &&
    maskedCall?.sourceEventId !== '',
  `id=${maskedCall?.lastAssistantEventId ?? '(未传)'} · text=${maskedCall?.lastAssistantText === undefined ? '(未传)' : '**传了**'} · 端口仍被调用=${maskedCall?.sourceEventId !== ''}`
)

await compileWithPort({ recentLines: [normalLines[0]!] })
const noHerCall = portCalls.at(-1)
record(
  'A3',
  '【① 负控·没有她的行】最近窗口里只有用户的行 ⇒ 端口**两件都不收**（不猜、不编）',
  noHerCall?.lastAssistantEventId === undefined && noHerCall?.lastAssistantText === undefined,
  `id=${noHerCall?.lastAssistantEventId ?? '(未传)'}`
)

await compileWithPort({
  recentLines: normalLines,
  withdrawnMasking: { compute: async () => withdrawn([], { ok: false }) },
})
const suppressedCall = portCalls.at(-1)
record(
  'A4',
  '【① 负控·D19 压制】撤销集**读不出来**（`ok:false`）⇒ 整段 Recent 被压制 ⇒ 端口照样**两件都不收**（失败关闭不外溢）',
  suppressedCall?.lastAssistantEventId === undefined && suppressedCall?.lastAssistantText === undefined,
  `id=${suppressedCall?.lastAssistantEventId ?? '(未传)'} · 端口仍被调用=${suppressedCall?.sourceEventId !== ''}`
)

await compileWithPort({
  recentLines: maskedLines,
  withdrawnMasking: { compute: async () => withdrawn([]) },
})
const restoredCall = portCalls.at(-1)
record(
  'A5',
  '【① 恢复】同一份对话、把**撤销集换成空**（不再遮蔽）⇒ 证据**又回来了**（A2 的"不给"是注入的条件造成的，不是门坏了）',
  restoredCall?.lastAssistantEventId === HER_EVENT_ID && restoredCall?.lastAssistantText === HER_LINE,
  `id=${restoredCall?.lastAssistantEventId ?? '(未传)'}`
)

record(
  'A6',
  '【① 零变化】端口**不传** ⇒ 一次都不调用（`portCalls` 不增长）——合成轮次与 M3.5 基线不受影响',
  await (async () => {
    const before = portCalls.length
    const gateway = gatewayOf()
    const turn = await gateway.beginTurn('行，就那样。')
    await gateway.compileTurn({ turn, currentInput: '行，就那样。', recentLines: normalLines } as never)
    await gateway.completeTurn({
      turn,
      replyText: '（合成轮次：不接端口）',
      modelDurationMs: 0,
    } as never)
    return portCalls.length === before
  })(),
  `调用次数=${String(portCalls.length)}（不接端口的那一轮没有让它增长）`
)

/* ---------------------------------------------------------------------------
 * 第 ② + ③ 跳：真编排（理解 → 放行口 → 写），最后从**账本**读回 sourceRefs
 * ------------------------------------------------------------------------- */
phase('hop ②/③: the real orchestration writes the acceptance-side + proposal-side refs')

const herDraft: GoalProposalDraft = {
  schemaVersion: GOAL_PROPOSAL_SCHEMA_VERSION,
  operation: 'create',
  /* `span` 与 `proposalSpan` 都按契约落在**本轮原话**上（M10 的冻结语义，本步不改它） */
  span: { start: 0, end: 8 },
  statement: '明天十点二十五在楼下见',
  origin: 'character_proposed',
  proposedByAssistantEventId: HER_EVENT_ID,
  proposalSpan: { start: 0, end: 8 },
}
/** 先从契约自己校验一遍夹具（免得"草案本身非法"被读成"判据拒了"） */
const draftVerdict = validateGoalProposalDraft(herDraft, {
  sourceText: '明天十点二十五，楼下。',
  candidateGoalIds: [],
})
record(
  'B0',
  '【夹具自检】`character_proposed` 的草案本身**合法**（否则下面的"拒"会变成"草案非法"的假象）',
  draftVerdict.ok === true,
  draftVerdict.ok ? '合法' : `非法=${draftVerdict.reason}`
)

/**
 * 跑一轮**真编排**，并从**账本**里读回"这一轮新写的那条 `GOAL_CREATED`"。
 *
 * ⚠️ 不读中间变量：`sourceRefs` 只能从事件 payload 里读 —— 那才是"落库的事实"。
 */
const createdCount = async (): Promise<number> =>
  (await domainEventsFor(h.kernel.stores.db, h.kernel.characterId)).filter(
    (event) => String(event.type) === String(GOAL_CREATED)
  ).length

type CreatedRef = { readonly conversationEventId?: unknown; readonly fingerprint?: unknown }
const understandingInputs: GoalUnderstandingInput[] = []

const runTurn = async (input: {
  readonly id: string
  readonly lastAssistantEventId?: string
  readonly lastAssistantText?: string
}): Promise<{
  readonly outcome: string
  readonly rejectionCodes: readonly string[]
  readonly refs: readonly CreatedRef[]
}> => {
  const before = await createdCount()
  const result = await turnHarness.turn({
    currentInput: '明天十点二十五，楼下。',
    sourceEventId: `cev:user:turn-${input.id}`,
    provider: {
      ...fixedProvider(herDraft),
      async call(call) {
        understandingInputs.push(call.input)
        return herDraft
      },
    },
    now: 2_500_000_000_000 + before + 1,
    runtime: deterministicRuntime(),
    ...(input.lastAssistantEventId === undefined || input.lastAssistantText === undefined
      ? {}
      : { lastAssistantEventId: input.lastAssistantEventId, lastAssistantText: input.lastAssistantText }),
  })
  const all = await domainEventsFor(h.kernel.stores.db, h.kernel.characterId)
  const createdAll = all.filter((event) => String(event.type) === String(GOAL_CREATED))
  const fresh = createdAll[before]
  const refs =
    (fresh?.payload as { goal?: { sourceRefs?: readonly CreatedRef[] } } | undefined)?.goal?.sourceRefs ?? []
  return {
    outcome: result.outcome,
    rejectionCodes: result.trace.validation.rejectionCodes,
    refs,
  }
}

const positive = await runTurn({
  id: 'positive',
  lastAssistantEventId: HER_EVENT_ID,
  lastAssistantText: HER_LINE,
})
const positiveRefs = positive.refs
record(
  'B1',
  '【②③ 正控】**两件都齐** ⇒ 真编排接受，且**账本里那条 GOAL_CREATED**带**两组**引用（提议侧 + 采纳侧，D28 满足）',
  positive.outcome === 'accepted' &&
    positiveRefs.length === 2 &&
    positiveRefs.some((ref) => String(ref.conversationEventId) === HER_EVENT_ID),
  `outcome=${positive.outcome} · sourceRefs=${String(positiveRefs.length)} · 含提议侧=${String(
    positiveRefs.some((ref) => String(ref.conversationEventId) === HER_EVENT_ID)
  )}`
)
record(
  'B2',
  '【② 指纹】提议侧那条引用的指纹 = **她那句原文**的 `goalSpanFingerprint`（指纹只由文本算出，正文不进事件）',
  positiveRefs.some(
    (ref) =>
      String(ref.conversationEventId) === HER_EVENT_ID &&
      String(ref.fingerprint) === goalSpanFingerprint(HER_LINE)
  ),
  `期望=${goalSpanFingerprint(HER_LINE)} · 实际=${JSON.stringify(
    positiveRefs
      .filter((ref) => String(ref.conversationEventId) === HER_EVENT_ID)
      .map((ref) => String(ref.fingerprint))
  )}`
)

const noEvidence = await runTurn({ id: 'no-evidence' })
record(
  'B3',
  '【② 负控·不给证据】**两件都不带** ⇒ 只造得出一组引用 ⇒ 放行口按 D28 拒（`goal_proposal_ambiguous_target`）',
  noEvidence.outcome === 'rejected' &&
    noEvidence.rejectionCodes.includes('goal_proposal_ambiguous_target'),
  `outcome=${noEvidence.outcome} · 拒绝=${JSON.stringify(noEvidence.rejectionCodes)}`
)

const mismatched = await runTurn({
  id: 'mismatched',
  lastAssistantEventId: 'cev:char:999',
  lastAssistantText: '另一句话（不是那条提议）',
})
record(
  'B4',
  '【② 负控·id 不相符】证据**不是**草案指的那条 ⇒ **窄规则**不认它 ⇒ 同样按 D28 拒（**没有**放宽判据）',
  mismatched.outcome === 'rejected' &&
    mismatched.rejectionCodes.includes('goal_proposal_ambiguous_target'),
  `outcome=${mismatched.outcome} · 拒绝=${JSON.stringify(mismatched.rejectionCodes)}`
)

const recovered = await runTurn({
  id: 'recovered',
  lastAssistantEventId: HER_EVENT_ID,
  lastAssistantText: HER_LINE,
})
record(
  'B5',
  '【② 恢复】把证据放回去再跑一遍 ⇒ **又接受**（B3/B4 的拒是注入的条件造成的，不是编排坏了）',
  recovered.outcome === 'accepted',
  `outcome=${recovered.outcome}`
)

const providerMessage = (input: GoalUnderstandingInput): string =>
  buildGoalUnderstandingUserMessage({ input, deadlineMs: 8000 })
record(
  'B6',
  '【模型输入正控】提议原文与事件 id 一起进入实际 provider 输入和请求消息',
  Object.hasOwn(understandingInputs[0]!, 'lastAssistantText') &&
    providerMessage(understandingInputs[0]!).includes(`她上一轮原话：${JSON.stringify(HER_LINE)}`),
  `原文已传=${String(Object.hasOwn(understandingInputs[0]!, 'lastAssistantText'))}`
)
record(
  'B7',
  '【模型输入负控】没有提议证据时，不向模型补入旧原文或 id',
  !Object.hasOwn(understandingInputs[1]!, 'lastAssistantText') &&
    !providerMessage(understandingInputs[1]!).includes('她上一轮原话：') &&
    !providerMessage(understandingInputs[1]!).includes(HER_EVENT_ID),
  '未提供提议证据的那轮仍经同一个 provider'
)
record(
  'B8',
  '【模型输入恢复】重新提供证据后，provider 又收到原文',
  Object.hasOwn(understandingInputs[3]!, 'lastAssistantText') &&
    providerMessage(understandingInputs[3]!).includes(`她上一轮原话：${JSON.stringify(HER_LINE)}`),
  `原文已恢复=${String(Object.hasOwn(understandingInputs[3]!, 'lastAssistantText'))}`
)
const partialEvidence = { ...understandingInputs[0]! }
delete partialEvidence.lastAssistantEventId
record(
  'B9',
  '【模型输入负控】只有原文、没有 id 时不提供提议证据',
  !providerMessage(partialEvidence).includes('她上一轮原话：'),
  'id 与原文必须成对'
)
const boundedEvidence = { ...understandingInputs[0]!, lastAssistantText: '😀'.repeat(501) }
record(
  'B10',
  '【模型输入上界】上一轮原文最多 500 码点，截断不拆 Unicode 字符',
  providerMessage(boundedEvidence).includes(JSON.stringify('😀'.repeat(500))) &&
    !providerMessage(boundedEvidence).includes(JSON.stringify('😀'.repeat(501))),
  '501 码点输入按既有 statement 上界有界化'
)

/* ---------------------------------------------------------------------------
 * 第 ③ 跳的静态锁（端口签名 + 调用点）
 * ------------------------------------------------------------------------- */
phase('hop ③: static locks (comment-stripped code)')
const codeLinesOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
const mainCode = codeLinesOf(readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8'))
const gatewayCode = codeLinesOf(readFileSync(join(REPO_ROOT, 'src/kernel/app/turn-gateway.ts'), 'utf8'))
const turnCode = codeLinesOf(readFileSync(join(REPO_ROOT, 'src/kernel/app/goal/turn.ts'), 'utf8'))
record(
  'C1',
  '【③ 静态锁·装配层】`main.ts` 的端口签名收下两个字段，并在 `runGoalTurn` 前按「**两件都齐才带**」转发',
  /readonly lastAssistantEventId\?: string/.test(mainCode) &&
    /readonly lastAssistantText\?: string/.test(mainCode) &&
    /lastAssistantEventId === undefined \|\| lastAssistantText === undefined/.test(mainCode) &&
    /\.\.\.\(lastAssistantEventId === undefined \|\| lastAssistantText === undefined/.test(mainCode),
  `签名=${String(/readonly lastAssistantEventId\?: string/.test(mainCode))} · 转发规则=${String(
    /lastAssistantEventId === undefined \|\| lastAssistantText === undefined/.test(mainCode)
  )}`
)
record(
  'C2',
  '【③ 静态锁·网关】网关**真的**从最近对话里取证据（`lastAssistantEvidenceOf(recentLines)`）并转发进端口',
  /lastAssistantEvidenceOf\(recentLines\)/.test(gatewayCode) &&
    /lastAssistantEventId: proposalEvidence\.eventId/.test(gatewayCode) &&
    /lastAssistantText: proposalEvidence\.text/.test(gatewayCode),
  `取证据=${String(/lastAssistantEvidenceOf\(recentLines\)/.test(gatewayCode))} · 转发=${String(
    /lastAssistantEventId: proposalEvidence\.eventId/.test(gatewayCode)
  )}`
)
record(
  'C3',
  '【② 静态锁·编排】`goal/turn.ts` 把两个字段做成 `proposalEvidence` 交给映射层（**两件都齐才给**）',
  /input\.lastAssistantEventId !== undefined && input\.lastAssistantText !== undefined/.test(turnCode) &&
    /proposalEvidence/.test(turnCode),
  `两件都齐才给=${String(
    /input\.lastAssistantEventId !== undefined && input\.lastAssistantText !== undefined/.test(turnCode)
  )}`
)

/* ---------------------------------------------------------------------------
 * 非零分母 + 确定性
 * ------------------------------------------------------------------------- */
const denominators = {
  portCalls: portCalls.length,
  selectorCases: 4,
  turns: 4,
  acceptedTurns: [positive, recovered].filter((entry) => entry.outcome === 'accepted').length,
  rejectedTurns: [noEvidence, mismatched].filter((entry) => entry.outcome === 'rejected').length,
}
record(
  'D1',
  '【非零分母】五类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)
/** 两次**独立**跑（同一份证据）⇒ 引用组数与指纹集合逐字相同（确定性） */
const fingerprintSetOf = (refs: readonly CreatedRef[]): string[] =>
  refs.map((ref) => String(ref.fingerprint)).sort()
record(
  'D2',
  '【确定性】两次独立跑（同一份提议侧证据）⇒ 账本里那两条事件的**引用组数**与**指纹集合**逐字相同',
  positiveRefs.length === 2 &&
    recovered.refs.length === 2 &&
    JSON.stringify(fingerprintSetOf(positiveRefs)) === JSON.stringify(fingerprintSetOf(recovered.refs)),
  `组数=${String(positiveRefs.length)}/${String(recovered.refs.length)} · 指纹集相同=${String(
    JSON.stringify(fingerprintSetOf(positiveRefs)) === JSON.stringify(fingerprintSetOf(recovered.refs))
  )}`
)

/* ---------------------------------------------------------------------------
 * 证据
 * ------------------------------------------------------------------------- */
const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp6b-assembly', headShort: head })

/*
 * ⚠️ **`AUD-20261005-01` 的修法：发射一份"可裁定"的读数。**
 *
 * ```text
 * 立案时的事实：`artifacts/m10.1/` 下这份门有**三份同 HEAD / 同日期**的档
 *   （`…-b223eeb023d4-{1965,74fd,b5ce}`），其中一份 23/24 FAIL、两份 24/24 PASS；
 *   而那份 payload **没有精确结束时间**、manifest 的 `supersedes` 又是 `null`
 *   ⇒ 选档器四段里只剩 `head-commit-time` ⇒ 三份**全部并列** ⇒ 并列档判定不同
 *   ⇒ 聚合门如实报 `AMBIGUOUS` 并失败关闭。**那是对的**，但"门本身"没有为
 *   后来者留下任何可裁定的身份。
 * ```
 * 从本版起，这一份门**自己**发射两样东西（纪律：**不回写**旧 FAIL 档、
 * **不**用 mtime 猜、**不**人工挑 PASS 档）：
 * ```text
 * ① `started` / `ended` —— 精确到毫秒的正式时间（payload 与 manifest 都写）
 *          ⇒ 选档器走到最强的一段（`reported-time`），不再退到 head 并列
 * ② `supersedes`       —— **被本次运行取代的那一份**（按同一套身份判据算出来的
 *          "此前最新一份"，不是按 mtime，也不是"挑一份好看的"）；
 *          算不出来就如实 `null`（**不许编**）
 * ```
 */
const started = new Date().toISOString()
/** 本次运行取代的那一份（此前最新一份的同门档）；算不出 ⇒ null。 */
const supersedes = ((): string | null => {
  try {
    const previous = selectLatestReading(join(REPO_ROOT, 'artifacts/m10.1'), 'm11-m10-1-wp6b-assembly-', 'assembly-verify.json')
    return previous?.runId ?? null
  } catch {
    return null
  }
})()
const ended = new Date().toISOString()
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-assembly-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  /* ⚠️ 正式时间（选档器的最强依据）：没有它们，同 HEAD 的多份档只能并列 */
  started,
  ended,
  supersedes,
  realDbTouched: false,
  modelCalls: 0,
  portCalls,
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门判的是 `L-M10.1-05` 的**三跳装配**：网关交证据 → 编排传证据 → 装配层转发（① 用**真网关**；' +
    '② 用**真 `runGoalTurn` + 真放行口 + 真写库**，并从账本读回 `sourceRefs`；③ 是静态锁）。' +
    '它**不**主张"她提出的约定在生产里一定被识别"（识别有门槛，`D03`/`D04`；漏识别是已知边界），' +
    '也**不**主张行为级效果（那是 `m10.1:e2e:verify` 里 NOT RUN 的对照读数）。' +
    '⚠️ `started`/`ended`/`supersedes` 是 `AUD-20261005-01` 要求的**发射面**：让聚合门能按身份裁定"哪一份最新"，' +
    '而不是在"同 HEAD 并列"上失败关闭。',
}
writeFileSync(join(dir, 'assembly-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp6b-assembly',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'assembly-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['selector', 'gateway', 'orchestration', 'static'],
  started,
  ended,
  supersedes,
  notes:
    'm10.1:assembly:verify（L-M10.1-05 三跳；隔离库 + 真网关 + 真编排；零模型、零出网）' +
    `；supersedes=${supersedes ?? '(无此前档 / 算不出来)'}（按身份判据算，不按 mtime、不挑 PASS）`,
})
console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
