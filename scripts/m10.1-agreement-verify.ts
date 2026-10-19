/**
 * M10.1 WP2b —— **约定识别慢路径门**（`m10.1:agreement:verify`，`L-M10.1-11` 的销账判据）。
 *
 * ============================================================================
 *  它判什么（**全部离线**：零模型、零出网；隔离库）
 * ============================================================================
 * ```text
 * A 形状闸与语义闸：`recognizeAgreement` 的**每一条具名理由**都要被真的触发过；
 *    三条**经模型面不可达**的理由**如实登记**（不假装覆盖）。
 * B 调度机器（真 job-store / 真水位 / 真幂等键 / 真晚写闸门）：
 *    B1 首次 cutover 一次性（不回判历史）· B2 no_tail
 *    B3 ⭐ 正控：一对约定形状的对话 ⇒ `ran/written`，账本出现 `GOAL_CREATED` + `COMMITMENT_ACCEPTED`
 *    B4 幂等：同窗再来 ⇒ 不产生第二份业务事件（水位已前进 ⇒ `no_tail`）
 *    B5 失败：provider 抛 ⇒ `failed` + **水位不前进** + 任务行 `failed` + 同窗下一轮 `retry_deferred`
 *    B6 结论 ≠ 失败：`{"kind":"none"}` ⇒ `ran/no_agreement` 且水位**前进**（不会永远卡在同一窗）
 *    B7 晚写闸门：`fence.close()` 后 ⇒ `cancelled`，零写入
 *    B8 零越界：只写目标域事件（白名单逐条核）
 * C 开关与接线：`agreementEnabled` 缺省 off · `CHARACTER_AGREEMENT_ENABLED=true` 能开 ·
 *    **关着时一个端口都不动**（不建水位行）· `main.ts` 真的消费它（去注释后静态锁）
 * D 提示词 ↔ 契约同步：闭集里的每个字段名与每个 kind 都出现在提示词里
 * E 真实读法：`readAgreementWindowEntries` 在**真库**上：区间 · 上限 · **遮蔽**（撤销的那条不进模型）
 * F 非零分母 + 确定性
 * ```
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-1-agreement', { keep: false })

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'




import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { getWatermark, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { latestAgreementSequence, readAgreementWindowEntries } from '../src/infrastructure/persistence/agreement-input-source.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  AGREEMENT_PROCESSOR,
  AGREEMENT_PROCESSOR_VERSION,
  maybeRunAgreementEvaluation,
} from '../src/infrastructure/runtime/agreement-scheduler.ts'
import { runConfiguredAgreementTail } from '../src/infrastructure/runtime/agreement-runtime.ts'
import { runAgreementWindow } from '../src/infrastructure/runtime/agreement-runner.ts'
import { buildAgreementInstruction } from '../src/infrastructure/model/openai-agreement-understanding.ts'
import { createLateWriteFence } from '../src/kernel/app/reflection/late-write-fence.ts'
import {
  AGREEMENT_MODEL_DRAFT_FIELDS,
  AGREEMENT_MODEL_DRAFT_KINDS,
  AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION,
  AGREEMENT_RECOGNITION_REASONS,
  recognizeAgreement,
  type AgreementRecognitionReason,
} from '../src/kernel/contracts/agreement-model-draft.ts'
import { assembleAgreementWindow, type AgreementRawEntry } from '../src/kernel/app/agreement/inputs.ts'
import { GOAL_DOMAIN_EVENT_TYPES } from '../src/kernel/contracts/domain-event.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { AGREEMENT_MASKED_TEXT } from '../src/kernel/contracts/agreement-input.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_1_agreement' as CharacterId
const USER = 'm10-1-agreement-user'
const CONVERSATION = 'dm-m10-1-agreement' as never

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
 * 窗口夹具（**不**来自账本：这一段判的是"形状闸与语义闸"）
 * ------------------------------------------------------------------------- */
const WINDOW_ENTRIES: readonly AgreementRawEntry[] = [
  { id: 'cev:u1', actorType: 'user', sequence: 1, text: '明天十点二十五，楼下，带伞和外套。' },
  { id: 'cev:c1', actorType: 'character', sequence: 2, text: '行，那就这么定了。' },
  { id: 'cev:u2', actorType: 'user', sequence: 3, text: '另外你那本书我看完了。' },
]
const inWindow = (overrides: Record<string, unknown>): unknown => ({
  schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION,
  kind: 'mutual_agreement',
  content: '明天十点二十五在楼下见',
  criterion: '他到楼下，由他报告',
  proposedBySeq: 1,
  acceptedBySeq: 2,
  ...overrides,
})
const window = assembleAgreementWindow({ entries: WINDOW_ENTRIES })

/* ---------------------------------------------------------------------------
 * A 形状闸与语义闸
 * ------------------------------------------------------------------------- */
const positive = recognizeAgreement(inWindow({}), window)
record(
  'A1',
  '【正控】合法草案（序号 1 提出 / 2 接受，不同说话者，顺序正确）⇒ **接受**，且 id 由**程序**解析（模型只说序号）',
  positive.ok === true &&
    positive.agreement.proposedByEventId === 'cev:u1' &&
    positive.agreement.acceptedByEventId === 'cev:c1' &&
    positive.agreement.proposedBy === 'user' &&
    positive.agreement.acceptedBy === 'character',
  positive.ok
    ? `出处=${positive.agreement.proposedByEventId}→${positive.agreement.acceptedByEventId} · 提出者=${positive.agreement.proposedBy}`
    : `拒绝=${positive.reason}`
)

const NEGATIVES: { id: string; reason: AgreementRecognitionReason; raw: unknown }[] = [
  { id: 'not-object', reason: 'not_an_object', raw: 42 },
  { id: 'schema', reason: 'schema_version_missing_or_unknown', raw: inWindow({ schemaVersion: 'x@9' }) },
  { id: 'kind', reason: 'kind_missing_or_unknown', raw: inWindow({ kind: 'maybe' }) },
  { id: 'extra-field', reason: 'unknown_field', raw: inWindow({ proposedByEventId: 'cev:u1' }) },
  { id: 'no-seq', reason: 'citation_missing', raw: inWindow({ proposedBySeq: undefined }) },
  { id: 'seq-out', reason: 'citation_not_in_window', raw: inWindow({ proposedBySeq: 99 }) },
  { id: 'none', reason: 'no_agreement', raw: { schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION, kind: 'none' } },
  { id: 'no-content', reason: 'missing_content', raw: inWindow({ content: '   ' }) },
  { id: 'no-criterion', reason: 'missing_criterion', raw: inWindow({ criterion: '' }) },
  { id: 'long-content', reason: 'content_too_long', raw: inWindow({ content: '长'.repeat(201) }) },
  { id: 'long-criterion', reason: 'criterion_too_long', raw: inWindow({ criterion: '长'.repeat(201) }) },
  { id: 'long-due', reason: 'due_basis_too_long', raw: inWindow({ dueBasis: '长'.repeat(121) }) },
  { id: 'same-party', reason: 'same_party', raw: inWindow({ proposedBySeq: 1, acceptedBySeq: 3 }) },
  { id: 'inverted', reason: 'order_inverted', raw: inWindow({ proposedBySeq: 2, acceptedBySeq: 1 }) },
]
const maskedWindow = assembleAgreementWindow({
  entries: [{ ...WINDOW_ENTRIES[0]!, contentUnavailable: true }, WINDOW_ENTRIES[1]!],
})
const maskedVerdict = recognizeAgreement(inWindow({}), maskedWindow)

const seen = new Set<string>()
const negativeRows: string[] = []
for (const testCase of NEGATIVES) {
  const verdict = recognizeAgreement(testCase.raw, window)
  const got = verdict.ok ? 'accepted' : verdict.reason
  if (!verdict.ok) seen.add(verdict.reason)
  negativeRows.push(`${testCase.id}:${got}`)
}
seen.add(maskedVerdict.ok ? 'accepted' : maskedVerdict.reason)
record(
  'A2',
  '【⭐ 每一条具名理由都被真的触发过】14 条负控 + 1 条遮蔽负控 ⇒ 逐条给出**预期理由**（不是"被拒了"就算）',
  NEGATIVES.every((testCase) => {
    const verdict = recognizeAgreement(testCase.raw, window)
    return !verdict.ok && verdict.reason === testCase.reason
  }) && !maskedVerdict.ok && maskedVerdict.reason === 'citation_masked',
  `实测=${JSON.stringify([...negativeRows, `masked:${maskedVerdict.ok ? 'accepted' : maskedVerdict.reason}`])}`
)

/**
 * ⚠️ **三条理由经模型面不可达**（如实登记，不假装覆盖）：
 * ```text
 * `proposal_not_found` / `acceptance_not_found`：本层**先**把序号解析成 id ⇒ 到了 WP1 校验器
 *    手里，那两条引用**必然存在**（模型编不出 id）。
 * `due_basis_missing`：模型面**没有** `dueAt` 字段（`D06`：不猜日期）⇒ 触发不了。
 * ⇒ 它们仍是**程序侧构造器**（`buildAgreementProposal` 的调用方）的具名理由，不是这一层的。
 * ```
 */
const UNREACHABLE_FROM_MODEL = [
  'proposal_not_found',
  'acceptance_not_found',
  'due_basis_missing',
] as const
const reachableReasons = AGREEMENT_RECOGNITION_REASONS.filter(
  (reason) => !(UNREACHABLE_FROM_MODEL as readonly string[]).includes(reason)
)
const unreached = reachableReasons.filter((reason) => !seen.has(reason))
record(
  'A3',
  '【非零分母 + 不假装覆盖】可达理由**全部命中**；三条不可达理由**具名登记**（并给出为什么不可达）',
  unreached.length === 0 && reachableReasons.length > 0,
  `可达 ${String(reachableReasons.length)} 条 · 命中 ${String(seen.size)} 条 · 未命中=${JSON.stringify(unreached)} ·` +
    ` 不可达=${JSON.stringify([...UNREACHABLE_FROM_MODEL])}`
)

/* ---------------------------------------------------------------------------
 * D 提示词 ↔ 契约同步（纯字符串，先做）
 * ------------------------------------------------------------------------- */
const instruction = buildAgreementInstruction()
const missingFields = AGREEMENT_MODEL_DRAFT_FIELDS.filter((field) => !instruction.includes(field))
const missingKinds = AGREEMENT_MODEL_DRAFT_KINDS.filter((kind) => !instruction.includes(kind))
record(
  'D1',
  '【提示词从契约派生】闭集里的每个字段名与每个 kind 都出现在提示词里（谁手改提示词 / 契约加了字段而提示词没跟上 ⇒ 当场红）',
  missingFields.length === 0 && missingKinds.length === 0,
  `缺字段=${JSON.stringify(missingFields)} · 缺 kind=${JSON.stringify(missingKinds)}`
)

/* ---------------------------------------------------------------------------
 * B / E：真库（隔离）
 * ------------------------------------------------------------------------- */
const agentRuntime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(agentRuntime)
const db = getRawDb(agentRuntime)

const goalEvents = async (): Promise<string[]> =>
  (await domainEventsFor(db, CHARACTER))
    .map((event) => String(event.type))
    .filter((type) => (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(type))

const providerOf = (raw: unknown) => ({
  name: 'm10.1-agreement-verify-stub',
  version: 'stub@1',
  call: async (): Promise<unknown> => raw,
})
const throwingProvider = {
  name: 'm10.1-agreement-verify-throwing',
  version: 'stub@1',
  call: async (): Promise<unknown> => {
    throw new Error('注入的传输失败（负控）')
  },
}

/** 调度端口的夹具：账本边界可变、窗口就是上面那对约定 */
let latestSequence = 10
const portsOf = (provider: { name: string; version: string; call: (input: never) => Promise<unknown> }): never =>
  ({
    latestSequence: async () => latestSequence,
    readWindow: async () => WINDOW_ENTRIES,
    run: (windowPlan: { entries: readonly AgreementRawEntry[]; toSequence: number }) =>
      runAgreementWindow(db, {
        characterId: CHARACTER,
        activeUserId: USER,
        entries: windowPlan.entries,
        provider: provider as never,
        signal: new AbortController().signal,
        now: 1_960_000_000_000,
      }),
  }) as never

const fence = createLateWriteFence()

/* ---- B1 首次 cutover（一次性、不回判历史） ---- */
const first = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(providerOf(inWindow({}))),
})
record(
  'B1',
  '【首次 cutover】水位行不存在 ⇒ **预置边界**并**本次不消费**（`D33`：不回判历史）—— 账本零业务事件',
  first.kind === 'cutover_preset' && (await goalEvents()).length === 0,
  `outcome=${first.kind} · 事件=${String((await goalEvents()).length)}`
)

/* ---- B2 无尾窗 ---- */
const second = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(providerOf(inWindow({}))),
})
record(
  'B2',
  '【无尾窗】水位 == 账本边界 ⇒ `no_tail`（不调模型、不建任务）',
  second.kind === 'no_tail',
  `outcome=${second.kind}`
)

/* ---- B3 ⭐ 正控：跑通一次并真的写 ---- */
latestSequence = 12
const written = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(providerOf(inWindow({}))),
})
const eventsAfterWrite = await goalEvents()
const watermarkAfterWrite = await getWatermark(db, CHARACTER, AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION)
record(
  'B3',
  '【⭐ 正控】账本有新尾 ⇒ `ran/written`；账本出现 `COMMITMENT_ACCEPTED`（**这条链在生产装配之外第一次真的写出来**）；水位前进到窗尾',
  written.kind === 'ran' &&
    written.result === 'written' &&
    eventsAfterWrite.includes('COMMITMENT_ACCEPTED') &&
    eventsAfterWrite.includes('GOAL_CREATED') &&
    watermarkAfterWrite?.processedThroughSequence === latestSequence,
  `outcome=${written.kind}/${String((written as { result?: string }).result)} · 事件=${JSON.stringify(eventsAfterWrite)} · 水位=${String(
    watermarkAfterWrite?.processedThroughSequence
  )}`
)

/* ---- B4 幂等：同窗再来 ⇒ 不产生第二份 ---- */
const repeat = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(providerOf(inWindow({}))),
})
const eventsAfterRepeat = await goalEvents()
record(
  'B4',
  '【幂等】同一窗再调 ⇒ **不**产生第二份业务事件（水位已到窗尾 ⇒ `no_tail`；即便重放也被幂等键挡）',
  repeat.kind === 'no_tail' && eventsAfterRepeat.length === eventsAfterWrite.length,
  `outcome=${repeat.kind} · 事件数 ${String(eventsAfterWrite.length)}→${String(eventsAfterRepeat.length)}`
)

/* ---- B6 结论 ≠ 失败（先做：它会把水位推到窗尾） ---- */
latestSequence = 14
const noneOutcome = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(providerOf({ schemaVersion: AGREEMENT_MODEL_DRAFT_SCHEMA_VERSION, kind: 'none' })),
})
const watermarkAfterNone = await getWatermark(db, CHARACTER, AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION)
record(
  'B6',
  '【结论 ≠ 失败】模型说"这一段里没有约定" ⇒ `ran/no_agreement`，且**水位照样前进**（否则会永远卡在同一窗反复调模型）',
  noneOutcome.kind === 'ran' &&
    noneOutcome.result === 'no_agreement' &&
    watermarkAfterNone?.processedThroughSequence === 14,
  `outcome=${noneOutcome.kind}/${String((noneOutcome as { result?: string }).result)} · 水位=${String(
    watermarkAfterNone?.processedThroughSequence
  )}`
)

/* ---- B5 失败：水位不前进 + 任务行 failed + retry_deferred ---- */
latestSequence = 16
const failedRun = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(throwingProvider),
})
const watermarkAfterFailure = await getWatermark(db, CHARACTER, AGREEMENT_PROCESSOR, AGREEMENT_PROCESSOR_VERSION)
const failedJobs = (await listJobs(db, CHARACTER)).filter((job) => job.status === 'failed')
const retry = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(throwingProvider),
})
record(
  'B5',
  '【失败】provider 抛 ⇒ `failed` + **水位不前进**（下一轮同窗补洞）+ 任务行**如实落 `failed`**（不留在 `running`）+ 同窗下一轮 `retry_deferred`',
  failedRun.kind === 'failed' &&
    watermarkAfterFailure?.processedThroughSequence === 14 &&
    failedJobs.length >= 1 &&
    retry.kind === 'retry_deferred',
  `outcome=${failedRun.kind} · 水位=${String(watermarkAfterFailure?.processedThroughSequence)} · failed 任务=${String(
    failedJobs.length
  )} · 重调=${retry.kind}`
)

/* ---- B7 晚写闸门 ---- */
const eventsBeforeFence = (await goalEvents()).length
fence.close()
latestSequence = 18
const fenced = await maybeRunAgreementEvaluation(db, {
  characterId: CHARACTER,
  cutoverSequence: latestSequence,
  fence,
  ports: portsOf(providerOf(inWindow({}))),
})
record(
  'B7',
  '【晚写闸门】`fence.close()` 之后 ⇒ `cancelled`，**零写入**（收尾期间不产生新业务事件）',
  fenced.kind === 'cancelled' && (await goalEvents()).length === eventsBeforeFence,
  `outcome=${fenced.kind} · 事件数 ${String(eventsBeforeFence)}→${String((await goalEvents()).length)}`
)

/* ---- B8 零越界 ---- */
const allEvents = await domainEventsFor(db, CHARACTER)
const foreign = allEvents
  .map((event) => String(event.type))
  .filter((type) => !(GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(type))
record(
  'B8',
  '【零越界】整条慢路径只写目标域事件（白名单逐条核过）',
  foreign.length === 0,
  `域外=${JSON.stringify(foreign)} · 白名单=${String(GOAL_DOMAIN_EVENT_TYPES.length)} 类`
)

/* ---------------------------------------------------------------------------
 * C 开关与接线
 * ------------------------------------------------------------------------- */
const flagsOff = readKernelFlags({})
const flagsOn = readKernelFlags({ CHARACTER_AGREEMENT_ENABLED: 'true' })
const mainCode = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')
const disabledFence = createLateWriteFence()
const beforeDisabled = (await listJobs(db, CHARACTER)).length
const disabled = await runConfiguredAgreementTail(db, {
  characterId: CHARACTER,
  activeUserId: USER,
  enabled: false,
  provider: providerOf(inWindow({})) as never,
  fence: disabledFence,
  signal: new AbortController().signal,
})
record(
  'C1',
  '【开关】`agreementEnabled` **代码缺省 off**；`CHARACTER_AGREEMENT_ENABLED=true` ⇒ on；**关着时一个端口都不动**（不建任务、不读窗口）',
  flagsOff.agreementEnabled === false &&
    flagsOn.agreementEnabled === true &&
    disabled.kind === 'disabled' &&
    (await listJobs(db, CHARACTER)).length === beforeDisabled,
  `缺省=${String(flagsOff.agreementEnabled)} · 显式开=${String(flagsOn.agreementEnabled)} · 调用=${disabled.kind}`
)
record(
  'C2',
  '【接线】`src/main.ts` 的**代码**里真的消费 `agreementEnabled`（去注释后静态锁）—— 只写 flag 没消费者就是惰性开关',
  /agreementEnabled/.test(mainCode) && /drainAgreementTail/.test(mainCode),
  `消费=${String(/agreementEnabled/.test(mainCode))} · 调用点=${String(/drainAgreementTail/.test(mainCode))}`
)

/* ---------------------------------------------------------------------------
 * E 真实读法（真库上的 SQL 读 + 遮蔽）
 * ------------------------------------------------------------------------- */
const userIngress = createHumanConsoleUserTurnIngress()
const assistantIngress = createCharacterAssistantTurnIngress()
let convSeq = 0
const appendLine = async (actorType: 'user' | 'character', content: string): Promise<string> => {
  convSeq += 1
  const ingress = actorType === 'user' ? userIngress : assistantIngress
  const result = await appendConversationEvent(db, {
    characterId: CHARACTER,
    conversationId: CONVERSATION,
    conversationSequence: convSeq,
    type: actorType === 'user' ? 'user_message' : 'assistant_message',
    actorType,
    actorId: actorType === 'user' ? USER : String(CHARACTER),
    content,
    createdAt: 1_960_000_000_000 + convSeq,
    trustedAttribution: ingress.attest({
      characterId: String(CHARACTER),
      presenterActorId: actorType === 'user' ? USER : String(CHARACTER),
      userId: USER,
    }),
  })
  return String(result.event.id)
}
const firstId = await appendLine('user', '明天十点二十五，楼下，带伞和外套。')
await appendLine('character', '行，那就这么定了。')
const thirdId = await appendLine('user', '另外你那本书我看完了。')
const latestLedger = await latestAgreementSequence(db, CHARACTER)
const allRaw = await readAgreementWindowEntries(db, CHARACTER, 0, latestLedger, 50, new Set<string>())
const boundedRaw = await readAgreementWindowEntries(db, CHARACTER, 0, latestLedger, 2, new Set<string>())
const maskedRaw = await readAgreementWindowEntries(
  db,
  CHARACTER,
  0,
  latestLedger,
  50,
  new Set<string>([firstId])
)
const maskedEntry = maskedRaw.find((entry) => entry.id === firstId)
const maskedAssembled = assembleAgreementWindow({ entries: maskedRaw })
const maskedAssembledEntry = maskedAssembled.entries.find((entry) => entry.id === firstId)
record(
  'E1',
  '【真实读法】区间 + **上限**（`limit=2` 取的是**最近** 2 条）+ 升序归还；`latestAgreementSequence` 与账本一致',
  allRaw.length === 3 &&
    boundedRaw.length === 2 &&
    boundedRaw[1]?.id === thirdId &&
    latestLedger >= 3,
  `全部=${String(allRaw.length)} · 上限 2 ⇒ ${String(boundedRaw.length)}（最后一条=${boundedRaw[1]?.id === thirdId}）· 边界=${String(
    latestLedger
  )}`
)
record(
  'E2',
  '【遮蔽先于注入】被撤销的那条：原材料**正文为空**且标 `contentUnavailable`；装配后是 `[已遮蔽]`、`masked=true` —— **被忘的内容不进模型**',
  maskedEntry?.contentUnavailable === true &&
    maskedEntry?.text === '' &&
    maskedAssembledEntry?.text === AGREEMENT_MASKED_TEXT &&
    maskedAssembledEntry?.masked === true,
  `原材料可用=${String(maskedEntry?.contentUnavailable === true ? 'false' : 'true')} · 装配文本=${String(
    maskedAssembledEntry?.text
  )} · masked=${String(maskedAssembledEntry?.masked)}`
)

/* ---------------------------------------------------------------------------
 * F 非零分母 + 确定性
 * ------------------------------------------------------------------------- */
const denominators = {
  recognitionReasons: reachableReasons.length,
  negativeCases: NEGATIVES.length + 1,
  jobRows: (await listJobs(db, CHARACTER)).length,
  domainEvents: allEvents.length,
  windowEntries: allRaw.length,
}
record(
  'F1',
  '【非零分母】五类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)
const twice = recognizeAgreement(inWindow({}), window)
record(
  'F2',
  '【确定性】同一份输入两次 ⇒ 逐字段相同（纯函数、不读时钟）',
  JSON.stringify(twice) === JSON.stringify(positive),
  `两次相同=${String(JSON.stringify(twice) === JSON.stringify(positive))}`
)

/* ---------------------------------------------------------------------------
 * 落盘
 * ------------------------------------------------------------------------- */
const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp2b-agreement', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-agreement-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  realDbTouched: false,
  modelCalls: 0,
  unreachableFromModelFace: UNREACHABLE_FROM_MODEL,
  throughput: {
    cutover: first.kind,
    written: written.kind,
    repeat: repeat.kind,
    noneOutcome: noneOutcome.kind,
    failed: failedRun.kind,
    fenced: fenced.kind,
    disabled: disabled.kind,
  },
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门判的是**慢路径的机器**（有界窗口 · 一次模型调用 · 两道闸 · 放行口 · 水位/失败/幂等/晚写闸门）与' +
    '**开关接线**。它**不**主张真模型会识别出约定（那要真模型车道），也**不**主张行为增益（`A11`）。',
}
writeFileSync(join(dir, 'agreement-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp2b-agreement',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'agreement-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline', 'isolated-db'],
  supersedes: null,
  notes: `m10.1:agreement:verify（WP2b 慢路径；真 job-store + 真水位 + 真放行口 + 真写；零模型、零出网）`,
})
console.log(`runId: ${runId}`)
console.log(
  `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`
)
process.exit(failed.length === 0 ? 0 : 1)
