/**
 * M5.1.1 / Phase 4a —— **来源资格闸**专项门（ADR-043 `DR-1` / `DR-3` / `DR-6` / `DR-7`）。
 *
 * ============================================================================
 *  它守的是什么
 * ============================================================================
 * Phase 4a 只做一件事：**在权威推导之前**，给"关于用户个人的事实"
 * （`person_fact` / `preference`）追加一道**来源资格**闸。
 *
 * ```text
 *   ESTABLISHED          来源已确立，且作者是用户            ⇒ 放行（既有闸 3/4 照旧）
 *   CONTRADICTED_ORIGIN  来源已确立，但作者**不是**人类      ⇒ 拒（evidence_origin_contradicts_claim）
 *   UNCONFIRMED_ORIGIN   来源**未确立**（不知道 / 没有信封）  ⇒ 拒（evidence_origin_not_established）
 * ```
 *
 * 它**不**改既有判据的任何一条：`authorityFromSource` / `canEvidenceExternalFact` /
 * 既有闸 4 `evidence_cannot_support_external_fact` 的语义一字未动，新闸是**追加**的。
 *
 * ----------------------------------------------------------------------------
 *  为什么必须有这道门（而不是"跑一遍 m4:ci 就完了"）
 * ----------------------------------------------------------------------------
 * `m4:test` / `m4:verify` / `eval:m4` 断言的是**结果**（"她被拒了"）。
 * 但"被拒"有两种世界状态**在输出上长得一样**：
 *
 * ```text
 *   ① 新闸真的按来源资格拒了它
 *   ② 新闸把**所有**事实类候选都拒了（包括来源完全合法的那些）
 * ```
 *
 * ② 会让全部 M4 门变成红色 —— 但一个**保守到什么都不做**的实现，
 * 只要夹具恰好没有正例，也能一路绿。因此本门按 AGENTS §6.7 走
 * **正控 / 负控 / 恢复**三段式：
 *
 * ```text
 *   正控  合法来源（人机控制台鉴证）→ 闸**安静**，事实真的能建立
 *   负控  注入三种假来源          → 闸**必须响**，且各自的理由码不同
 *   恢复  放回合法来源            → 闸**重新安静**（且读数逐字段一致）
 * ```
 *
 * ----------------------------------------------------------------------------
 *  量具有效性（INV-M45-06 / AGENTS §6.8）
 * ----------------------------------------------------------------------------
 * · **计数型检测器自检 `measured_count > 0`**：静态扫描必须真的扫到文件、
 *   真的命中过针（`trustedOriginReadingOf(` == 1、`axisBConfirmed` == 3）；
 *   命中 0 次说明**扫描器坏了**，结论是 `MEASUREMENT INVALID` 而不是 PASS。
 * · **静态反后门**：`TrustedOriginReading` 只能由 `trustedOriginReadingOf()`
 *   这一个纯函数产出；`src/**` 里消费它的只有抽取器；`scripts/**` 里
 *   **一次都不出现** —— 夹具没有任何办法自己声明一个来源读数。
 *
 * 跑法：`pnpm m5.1.1:phase4a:verify`
 */

import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import **调用**之前（见 src/dev/sandbox.ts）
import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createM4Harness, createReporter } from './m4-harness.ts'
import {
  asConversationId,
  authorityFromSource,
  canEvidenceExternalFact,
} from '../src/kernel/contracts/index.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createAgentRunnerUserTurnIngress,
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { getConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  COGNITIVE_QUALIFICATION_RULE_VERSION,
  EVIDENCE_ORIGIN_CONTRADICTS_CLAIM,
  EVIDENCE_ORIGIN_NOT_ESTABLISHED,
  SOURCE_QUALIFICATION_REJECTION_CODES,
  sourceQualificationOf,
} from '../src/kernel/contracts/attribution.ts'
import {
  processorEventViewOf,
  resolveCandidates,
} from '../src/kernel/app/memory/extractor.ts'

const report = createReporter()
const ROOT = process.cwd()

/**
 * 「实际值 === 期望值」的一条断言。
 *
 * 刻意不往共享的 `Reporter` 上加方法：那个接口被十几个 M4 脚本用着，
 * 加方法会让本门与它们的耦合变大（而本门要的不是更丰富的断言 API，
 * 只是**把实际读数打出来**——"应当为真"这种失败信息量最小）。
 */
function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  report.check(label, same, same ? String(actual) : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// §0 静态反后门：`TrustedOriginReading` 只有一个产出点
// ---------------------------------------------------------------------------

report.section('§0 静态反后门（`TrustedOriginReading` 的唯一产出点）')

/**
 * 扫一个目录下的全部 `.ts`，返回 `路径 → 全文`。
 *
 * ⚠️ 路径分隔符**统一成正斜杠**再比较 —— 本仓库在 Windows 上开发，
 * 而 `path.relative` 给的是反斜杠；不归一化的话"某个文件没出现"这类断言
 * 会因为分隔符而静默失效（正是 WP10-C 踩过的那一类）。
 */
function readTree(relativeRoot: string): Map<string, string> {
  const files = new Map<string, string>()
  const base = join(ROOT, relativeRoot)
  for (const entry of readdirSync(base, { recursive: true }).map(String)) {
    if (!entry.endsWith('.ts')) continue
    const key = `${relativeRoot}/${entry.replace(/\\/g, '/')}`
    files.set(key, readFileSync(join(base, entry), 'utf8'))
  }
  return files
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * 数**字段**（而不是数名字）的出现次数。
 *
 * ⚠️ 朴素地数 `trustedOrigin` 会把**函数名** `trustedOriginReadingOf` 也算进去，
 *    于是"字段只出现在两处"这条断言在派生函数所在的文件上假红 —— 第一版就是这样
 *    （实测：`src/` 命中 2 次而不是 1 次）。用否定前瞻把名字摘掉，
 *    剩下的才是"有人把来源读数当字段使"。
 */
function countFieldOccurrences(text: string, field: string): number {
  return (text.match(new RegExp(`${field}(?!ReadingOf)`, 'g')) ?? []).length
}

function filesWithField(files: Map<string, string>, field: string): string[] {
  return [...files.entries()]
    .filter(([, text]) => countFieldOccurrences(text, field) > 0)
    .map(([key]) => key)
    .sort()
}

function totalFieldOccurrences(files: Map<string, string>, field: string): number {
  return [...files.values()].reduce((sum, text) => sum + countFieldOccurrences(text, field), 0)
}

function filesContaining(files: Map<string, string>, needle: string): string[] {
  return [...files.entries()].filter(([, text]) => text.includes(needle)).map(([key]) => key).sort()
}

function totalOccurrences(files: Map<string, string>, needle: string): number {
  return [...files.values()].reduce((sum, text) => sum + countOccurrences(text, needle), 0)
}

const SRC = readTree('src')

/**
 * ⚠️ **必须把自己排除掉**：本文件当然会提到 `trustedOrigin`（它就是在验这个字段）。
 * 不排除的话，"夹具里一次都不出现这个字段"会永远为假 —— 而那会让下面每一条
 * `== 0` 的断言变成"永远红"，同样无法区分"没有后门"与"扫描器坏了"。
 */
const SELF_REL = 'scripts/verify-m5.1.1-phase4a-origin-gate.ts'
const SCRIPTS_ALL = readTree('scripts')
const selfPresent = SCRIPTS_ALL.has(SELF_REL)
const SCRIPTS = new Map(SCRIPTS_ALL)
SCRIPTS.delete(SELF_REL)

// 针（刻意拼接，免得本文件自己成为自己扫描结果里的一处命中）
const NEEDLE_CALL = 'trustedOrigin' + 'ReadingOf({'
const NEEDLE_FIELD = 'trusted' + 'Origin'
const NEEDLE_AXIS = 'axisB' + 'Confirmed'

const srcCallHits = totalOccurrences(SRC, NEEDLE_CALL)
const srcAxisHits = totalOccurrences(SRC, NEEDLE_AXIS)
const srcFieldHits = totalFieldOccurrences(SRC, NEEDLE_FIELD)
const scriptCallHits = totalOccurrences(SCRIPTS, NEEDLE_CALL)
const scriptFieldHits = totalFieldOccurrences(SCRIPTS, NEEDLE_FIELD)
const scriptAxisHits = totalOccurrences(SCRIPTS, NEEDLE_AXIS)

const measuredCount = SRC.size + SCRIPTS.size

report.check(
  '量具自检：扫描范围非空（`measured_count > 0`）',
  measuredCount > 0,
  `src ${SRC.size} 个文件 / scripts ${SCRIPTS.size} 个文件（已排除本门自身）= ${measuredCount}`
)
/*
 * 排除自身这一步**自己也必须被验证**：若 `SELF_REL` 拼错，`delete` 会是空操作，
 * 于是"夹具里一次都不出现"会在本文件上假红 —— 而"假红"与"真有后门"看起来一样。
 * 先证明排除动作确实命中了一个真实存在的文件。
 */
report.check(
  '量具自检：自身排除确实生效（路径存在且排除后少 1 个文件）',
  selfPresent && SCRIPTS.size === SCRIPTS_ALL.size - 1,
  `selfPresent=${String(selfPresent)} · ${SCRIPTS_ALL.size} → ${SCRIPTS.size}`
)
/*
 * 这一条是 AGENTS §6.8 那条真实事故的防线：如果针写错了（分割符、大小写、
 * 拼写），下面所有的 "== 0" 都会**因为什么都没扫到而变成绿**。
 * 因此必须先证明针**能**命中已知存在的目标。
 */
report.check(
  '量具自检：针**能**命中（已知存在处：调 1 / 字段 6 / 三态字段 3）',
  srcCallHits === 1 && srcFieldHits === 6 && srcAxisHits === 3,
  `${NEEDLE_CALL} ${srcCallHits} 处 · ${NEEDLE_FIELD} ${srcFieldHits} 处 · ${NEEDLE_AXIS} ${srcAxisHits} 处`
)

checkEqual(
  `${NEEDLE_FIELD} 字段在 src/** 只出现在「声明」与「产出+消费」两处`,
  filesWithField(SRC, NEEDLE_FIELD),
  ['src/kernel/app/memory/extractor.ts', 'src/kernel/contracts/processor.ts']
)
report.check(
  `${NEEDLE_CALL} 在 src/** 只有 1 个调用点（在抽取器里）`,
  srcCallHits === 1 && filesContaining(SRC, NEEDLE_CALL).join() === 'src/kernel/app/memory/extractor.ts',
  filesContaining(SRC, NEEDLE_CALL).join(' | ') || '(没有调用点)'
)
checkEqual(
  `${NEEDLE_AXIS} 在 src/** 只在派生它的那个文件里（别处无法手写出同形读数）`,
  filesContaining(SRC, NEEDLE_AXIS),
  ['src/kernel/contracts/attribution.ts']
)

/*
 * ===========================================================================
 *  S4 —— 反后门：**任何脚本都造不出**一个 `TrustedOriginReading`
 * ===========================================================================
 * ⚠️ 这一条在 Phase 4a 判据取代（F4 §9）之后**改了形状，但更强了**。
 *
 * 改之前它数的是"`scripts/**` 里出现 `trustedOrigin` 的次数 == 0"。4a 的取代把
 * 正向边界写进了 `k17` 与 `wp61` 的**断言文本**，于是那条计数**不再成立** ——
 * 而"出现名字"与"造出读数"本来就是两件事。
 *
 * 新的形状给的是**更强的**结论：
 *   ① `axisBConfirmed` 是 `TrustedOriginReading` 的**必需字段** ⇒
 *      `scripts/**` 里 0 处就**证明**没有任何脚本能构造出这个读数（不论它怎么命名变量）
 *   ② 提到 `trustedOrigin` 的脚本被**逐个登记**（只允许两条已授权的边界断言）；
 *      将来任何新脚本开始提到它都会**立刻红**，必须显式登记
 */
checkEqual(
  `${NEEDLE_FIELD} 在 scripts/** 只允许被**已登记的边界断言**提及（新增即红，须显式登记）`,
  filesWithField(SCRIPTS, NEEDLE_FIELD),
  [
    'scripts/verify-m5.1.1-k17-consumer-impact.ts',
    'scripts/verify-m5.1.1-wp61-conversation-ingress.ts',
  ]
)
report.check(
  `${NEEDLE_AXIS} 在 scripts/** 里 0 处 ⇒ **无法**构造出 TrustedOriginReading（该字段是必需的）`,
  scriptAxisHits === 0,
  `${scriptAxisHits} 处；提到派生函数的脚本 = ${filesContaining(SCRIPTS, NEEDLE_CALL).join(', ') || '(无)'}`
)

/*
 * ===========================================================================
 *  抽取器的三个片区（S5 要按片区说事）
 * ===========================================================================
 */
const extractorText = SRC.get('src/kernel/app/memory/extractor.ts') ?? ''
const viewFnStart = extractorText.indexOf('export function processorEventViewOf')
const viewFnEnd = extractorText.indexOf('\nfunction ', viewFnStart + 1)
const callIndex = extractorText.indexOf(NEEDLE_CALL)

report.check(
  `唯一产出点确实在 \`processorEventViewOf\` 的函数体内`,
  viewFnStart >= 0 && callIndex > viewFnStart && (viewFnEnd === -1 || callIndex < viewFnEnd),
  `函数 @${viewFnStart} · 调用 @${callIndex} · 函数结束 @${viewFnEnd}`
)

/*
 * ===========================================================================
 *  S5 —— **下游只能消费 `view.trustedOrigin`**（用户 2026-09-19 裁定第 ③ 点）
 * ===========================================================================
 * 这是"判据层面的取代"里**新增**的反后门断言：边界被打破的两种形状都要能被抓住 ——
 *   · 适配边界**之外**又有人读原始归因（`event.attribution` / `contentOriginator`）
 *   · 下游候选解析**绕过**派生读数去读原始归因
 * 因此这里**同时**断言"外面是 0"与"里面确实在读"（后者防"针根本没命中"那类假绿）。
 */
const adapterEndInFile = ((): number => {
  const candidates = [
    extractorText.indexOf('\nexport function ', viewFnStart + 1),
    extractorText.indexOf('\nfunction ', viewFnStart + 1),
  ].filter((index) => index > viewFnStart)
  return candidates.length > 0 ? Math.min(...candidates) : extractorText.length
})()
const adapterText = extractorText.slice(viewFnStart, adapterEndInFile)
const outsideAdapterText = extractorText.replace(adapterText, '')
const resolveOneStart = extractorText.indexOf('function resolveOne(')
const resolveOneText = extractorText.slice(
  resolveOneStart,
  extractorText.indexOf('\nfunction ', resolveOneStart + 1)
)

const adapterReadsRawAttribution = adapterText.includes('event.attribution')
const rawAttributionOutsideAdapter = (outsideAdapterText.match(/event\.attribution|contentOriginator/g) ?? [])
  .length
const downstreamReadsRawAttribution = /event\.attribution|contentOriginator/.test(resolveOneText)
const downstreamConsumesReading = resolveOneText.includes('view.trustedOrigin')

report.check(
  'S5：适配边界**确实**读原始受信归因（正向；防"针根本没命中"的假绿）',
  adapterReadsRawAttribution,
  `适配边界内 event.attribution = ${String(adapterReadsRawAttribution)}`
)
report.check(
  'S5：适配边界**之外**对原始归因的引用数 = 0（反后门：别处不得直接读原始归因）',
  rawAttributionOutsideAdapter === 0,
  `边界外引用 ${rawAttributionOutsideAdapter} 处`
)
report.check(
  'S5：下游候选解析**只**消费 `view.trustedOrigin`，不读原始归因',
  downstreamConsumesReading && downstreamReadsRawAttribution === false,
  `消费 view.trustedOrigin = ${String(downstreamConsumesReading)} · 读原始归因 = ${String(downstreamReadsRawAttribution)}`
)

/*
 * ===========================================================================
 *  S6 —— 类型边界：`ProcessorEventView` **只**多一个派生读数（裁定第 ② 点）
 * ===========================================================================
 * S1–S5 都只盯 `trustedOrigin` 这一个字段名，**抓不到**"视图里另开一个原始 Axis B 字段"
 * （实测：把 `sourceKind?: string` 塞进 `ProcessorEventView` 时，本门的第一版**没响**，
 *  只有 k17 的取代② 响了）。因此这里补一条**类型形状**断言，让本门自己也能抓住它。
 */
const processorContractText = SRC.get('src/kernel/contracts/processor.ts') ?? ''
const viewTypeText = processorContractText.slice(
  processorContractText.indexOf('export interface ProcessorEventView'),
  processorContractText.indexOf('export interface ProcessorContext')
)
const AXIS_B_NAMES = [
  'source_kind',
  'source_authority',
  'epistemic_source',
  'sourceKind',
  'sourceAuthority',
  'epistemicSource',
]
const rawAxisBInViewType = AXIS_B_NAMES.filter((name) => viewTypeText.includes(name))
const viewTypeHasDerivedReading = viewTypeText.includes('trustedOrigin?: TrustedOriginReading')
report.check(
  'S6：`ProcessorEventView` 里**没有**任何原始 Axis B 字段，且**有** `trustedOrigin?`（裁定第 ② 点）',
  rawAxisBInViewType.length === 0 && viewTypeHasDerivedReading,
  `视图类型里命中原始 Axis B：${rawAxisBInViewType.join(', ') || '(无)'}；有派生读数 = ${String(viewTypeHasDerivedReading)}`
)

// ---------------------------------------------------------------------------
// §1 夹具：三种"行是怎么进来的"渠道（都是**生产**类 + **生产** ingress）
// ---------------------------------------------------------------------------

report.section('§1 夹具（生产 ingress；夹具不声明来源，只选择站在哪个入口上）')

await resetPluginSqlConnection()
const sandbox = isolateDatabase('m5.1.1-phase4a-origin-gate', { keep: true })

const h = await createM4Harness({
  label: 'phase4a',
  // 显式指名，不依赖缺省：本门的"合法来源"就是**交互式人类控制台**
  userIngress: createHumanConsoleUserTurnIngress(),
})

/** 合法来源渠道：人机控制台（本 harness 就是它的替身） */
const positiveText = '我不吃香菜，从小就受不了那个味道'
const positive = await h.recordUserEvidence(positiveText)

/** 她的输出渠道：角色输出边界（作者是**她**，不是用户） */
const herReply = await h.recorder.recordAssistantMessage({
  text: '我猜你大概不喜欢香菜吧',
  conversationSequence: positive.conversationSequence + 1,
  characterSequence: positive.assistantSequence,
  replyToEventId: positive.event.id as never,
})
if (herReply === undefined) throw new Error('夹具失败：她的回复没有写进账本')

/**
 * 两个**负控渠道**各自一条独立会话上的 recorder。
 *
 * ⚠️ 这里刻意**不**用第二个 `createM4Harness`：`@elizaos/plugin-sql` 是
 * **进程级单例**（AGENTS §7），一个进程只该开一个库。同库、异会话、
 * 各自带一套 ingress，才是"同一个系统里三种写入渠道"的正确形状。
 */
async function legacyRecorder(): Promise<ConversationRecorder> {
  return new ConversationRecorder({
    db: h.db,
    characterId: h.kernel.characterId,
    conversationId: asConversationId('phase4a-legacy'),
    dryRun: false,
    userName: 'Alex',
    characterName: '苏沐薇',
    transport: 'phase4a-legacy',
    // **刻意省略 `attribution`**：这正是 v7 之前的历史行 / 未接受信 ingress 的写入
  })
}

async function agentRunnerRecorder(): Promise<ConversationRecorder> {
  return new ConversationRecorder({
    db: h.db,
    characterId: h.kernel.characterId,
    conversationId: asConversationId('phase4a-agent-runner'),
    dryRun: false,
    userName: 'Alex',
    characterName: '苏沐薇',
    transport: 'phase4a-agent-runner',
    // D01 形状：程序化替用户提交 —— 呈现 user_message，作者是 SERVICE
    attribution: [createAgentRunnerUserTurnIngress(), createCharacterAssistantTurnIngress()],
  })
}

const legacy = await legacyRecorder()
const legacyEvent = (await legacy.recordUserMessage('我不吃香菜，从小就受不了', 1)).event
if (legacyEvent === undefined) throw new Error('夹具失败：legacy 渠道没有写进账本')

const runner = await agentRunnerRecorder()
const runnerEvent = (await runner.recordUserMessage('我不吃香菜，从小就受不了', 1)).event
if (runnerEvent === undefined) throw new Error('夹具失败：agent-runner 渠道没有写进账本')

report.check(
  '夹具就位：4 条事件分别来自 4 个不同渠道（人机控制台 / 她的输出 / legacy / agent-runner）',
  positive.event !== undefined && herReply !== undefined && legacyEvent !== undefined && runnerEvent !== undefined,
  `${String(positive.event.id).slice(-12)} · ${String(herReply.id).slice(-12)} · ${String(legacyEvent.id).slice(-12)} · ${String(runnerEvent.id).slice(-12)}`
)

// ---------------------------------------------------------------------------
// §2 正控：合法来源 → 闸**安静**
// ---------------------------------------------------------------------------

report.section('§2 正控（合法来源 → 闸安静，事实真的能建立）')

/*
 * Level 2 证据：**从库里读回来**再看归因。
 * `recordUserMessage` 的返回值本身就是读库构造的，但这里显式再读一次，
 * 是为了让"库里真的写着这个信封"成为一条独立的读数，而不是"内存里的返回值"。
 */
const positiveFromDb = await getConversationEvent(h.db, positive.event.id as never)
if (positiveFromDb === undefined) throw new Error('正控失败：库里的用户事件读不回来')

checkEqual(
  'Level 2：库里的用户行带 `attribution_origin = RECORDED` 的受信信封',
  positiveFromDb.attribution?.attributionOrigin,
  'RECORDED'
)

const positiveView = processorEventViewOf(positiveFromDb)
const positiveQualification = sourceQualificationOf(positiveView.trustedOrigin)

report.check(
  '正控：抽取器看到的视图带受信来源读数',
  positiveView.trustedOrigin !== undefined,
  positiveView.trustedOrigin === undefined
    ? '(没有读数 —— 受信 ingress 没有生效)'
    : `contentOriginator=${positiveView.trustedOrigin.contentOriginator.state} · axisBConfirmed=${positiveView.trustedOrigin.axisBConfirmed}`
)
checkEqual('正控：来源资格 = ESTABLISHED（作者是用户）', positiveQualification, 'ESTABLISHED')

/**
 * 让证据视图去建立一条**关于用户的事实**（`preference`）—— 与生产抽取器
 * 走的是同一个入口（`resolveCandidates`），不是另写一份判据。
 *
 * 候选形状固定（槽位 `food.preference.cilantro`），于是三次调用之间**只有
 * 证据的来源**这一个变量在变 —— 这正是"控制变量"的字面意思。
 */
function resolvePreference(view: ReturnType<typeof processorEventViewOf>) {
  const resolved = resolveCandidates(
    [
      {
        memoryType: 'preference' as const,
        subjectToken: 'USER' as const,
        claim: { predicate: 'food.preference.cilantro', value: 'dislike' },
        evidenceEventSequences: [view.sequence],
      },
    ],
    {
      owner: h.owner,
      events: [view],
      speaker: h.user,
      processor: 'phase4a-gate',
      processorVersion: 'phase4a-gate@1',
    }
  )
  if (resolved.length !== 1) throw new Error(`解析结果条数异常：${resolved.length}`)
  return resolved[0]
}

/** 同上，只取"结果是什么"（`accepted` 或结构化理由码） */
function outcomeOf(view: ReturnType<typeof processorEventViewOf>): string {
  const resolved = resolvePreference(view)
  return resolved.ok ? '(被接受了 —— 闸没响)' : resolved.rejection.reason
}

const positiveResolved = [resolvePreference(positiveView)]
report.check(
  '正控：来源合法的候选**通过**（闸安静）',
  positiveResolved[0]?.ok === true,
  positiveResolved[0]?.ok === false ? `被拒：${positiveResolved[0].rejection.reason}` : 'accepted'
)
checkEqual(
  '正控：通过后权威仍是既有闸 3 推导出来的 EXPLICIT_USER_STATEMENT（4a 没有动它）',
  positiveResolved[0]?.ok === true ? positiveResolved[0].candidate.authority : '(未通过)',
  'EXPLICIT_USER_STATEMENT'
)

// ---------------------------------------------------------------------------
// §3 负控：三种假来源 → 闸**必须响**，且理由码各不相同
// ---------------------------------------------------------------------------

report.section('§3 负控（注入假来源 → 闸必须响）')

const legacyView = processorEventViewOf(legacyEvent)
const legacyFromDb = await getConversationEvent(h.db, legacyEvent.id as never)
checkEqual(
  '负控 ① 前提：legacy 行在库里**没有**信封（`attribution` 缺失）',
  legacyFromDb?.attribution,
  undefined
)
checkEqual(
  '负控 ①：没有信封 ⇒ 来源未确立（`DR-7`，不猜、不豁免）',
  sourceQualificationOf(legacyView.trustedOrigin),
  'UNCONFIRMED_ORIGIN'
)

const runnerView = processorEventViewOf(runnerEvent)
report.check(
  '负控 ② 前提：agent-runner 行**有**受信信封，但 Axis B 不是 confirmed',
  runnerView.trustedOrigin !== undefined && runnerView.trustedOrigin.axisBConfirmed === false,
  runnerView.trustedOrigin === undefined
    ? '(没有读数)'
    : `contentOriginator=${runnerView.trustedOrigin.contentOriginator.state} · axisBConfirmed=${runnerView.trustedOrigin.axisBConfirmed}`
)
checkEqual(
  '负控 ②：呈现 user_message 但作者是 SERVICE ⇒ 表面身份**不足以**建立资格（D01 形状）',
  sourceQualificationOf(runnerView.trustedOrigin),
  'UNCONFIRMED_ORIGIN'
)

const herView = processorEventViewOf(herReply)
checkEqual(
  '负控 ③：她的输出 ⇒ 来源已确立但**不是人类**（知道不是他）',
  sourceQualificationOf(herView.trustedOrigin),
  'CONTRADICTED_ORIGIN'
)

/** 三种假来源各解一条"用户事实"候选，读回理由码 */
const rejectionOf = outcomeOf

const legacyReason = rejectionOf(legacyView)
const runnerReason = rejectionOf(runnerView)
const herReason = rejectionOf(herView)

checkEqual(
  `负控 ①：没有信封 → 结构化理由码 ${EVIDENCE_ORIGIN_NOT_ESTABLISHED}`,
  legacyReason,
  EVIDENCE_ORIGIN_NOT_ESTABLISHED
)
checkEqual(
  `负控 ②：D01 形状 → 同一个理由码（"不知道"而不是"知道不是"）`,
  runnerReason,
  EVIDENCE_ORIGIN_NOT_ESTABLISHED
)
checkEqual(
  `负控 ③：她的输出 → 结构化理由码 ${EVIDENCE_ORIGIN_CONTRADICTS_CLAIM}`,
  herReason,
  EVIDENCE_ORIGIN_CONTRADICTS_CLAIM
)
report.check(
  '负控：三种假来源各自的理由码**不合并**（"知道不是他" ≠ "不知道"）',
  legacyReason !== herReason && runnerReason !== herReason,
  `${legacyReason} / ${runnerReason} / ${herReason}`
)
checkEqual(
  '两个理由码就是登记的那两个（没有悄悄多出第三个）',
  [...SOURCE_QUALIFICATION_REJECTION_CODES],
  [EVIDENCE_ORIGIN_NOT_ESTABLISHED, EVIDENCE_ORIGIN_CONTRADICTS_CLAIM]
)
checkEqual('规则版本随拒绝理由一起可审计（`DR-10`）', COGNITIVE_QUALIFICATION_RULE_VERSION, 1)

/*
 * **最后一道防线**：`authorityFromSource('UNCONFIRMED_ORIGIN')` 仍然抛错。
 *
 * 这正是新闸必须放在闸 3 **之前**的理由 —— 不是"顺手提早"，而是
 * 让一条可读的拒绝理由取代一个 500。它同时也证明 4a **没有**给
 * `UNCONFIRMED_ORIGIN` 开任何晋级路径（ADR-043 `DR-2`）。
 */
let lastLineCode = ''
try {
  authorityFromSource('UNCONFIRMED_ORIGIN')
} catch (error) {
  lastLineCode = String((error as { code?: string }).code ?? '')
}
checkEqual(
  '最后一道防线未松动：`authorityFromSource(UNCONFIRMED_ORIGIN)` 仍然抛错（`DR-2`）',
  lastLineCode,
  'unconfirmed_origin_cannot_become_memory_authority'
)

// ---------------------------------------------------------------------------
// §4 判据未被改动：`canEvidenceExternalFact`（T3 来源谓词）逐格冻结
// ---------------------------------------------------------------------------

report.section('§4 既有判据未改（T3 来源谓词 / 闸 4 语义逐格冻结）')

const t3Table: readonly [string, Parameters<typeof canEvidenceExternalFact>[0], boolean][] = [
  ['user + USER_EXPLICIT', { type: 'user_message', actorType: 'user', sourceAuthority: 'USER_EXPLICIT' }, true],
  [
    'user + USER_REPLY_CONFIRMATION',
    { type: 'user_message', actorType: 'user', sourceAuthority: 'USER_REPLY_CONFIRMATION' },
    true,
  ],
  [
    'user + TOOL_OBSERVATION',
    { type: 'user_message', actorType: 'user', sourceAuthority: 'TOOL_OBSERVATION' },
    true,
  ],
  [
    'user + UNCONFIRMED_ORIGIN',
    { type: 'user_message', actorType: 'user', sourceAuthority: 'UNCONFIRMED_ORIGIN' },
    false,
  ],
  [
    'character + CHARACTER_GENERATION',
    { type: 'assistant_message', actorType: 'character', sourceAuthority: 'CHARACTER_GENERATION' },
    false,
  ],
  ['system_event', { type: 'system_event', actorType: 'system', sourceAuthority: 'USER_EXPLICIT' }, false],
  ['user 无结构化 authority（迁移前旧数据）', { type: 'user_message', actorType: 'user' }, true],
]

let t3Mismatches = 0
for (const [label, input, expected] of t3Table) {
  const actual = canEvidenceExternalFact(input)
  if (actual !== expected) {
    t3Mismatches += 1
    report.check(`T3 冻结：${label}`, false, `期望 ${expected}，实际 ${actual}`)
  }
}
report.check(
  'T3 冻结：`canEvidenceExternalFact` 七格逐格不变（判据被改动时这里会红）',
  t3Mismatches === 0,
  `检查了 ${t3Table.length} 格 / 不一致 ${t3Mismatches}`
)
report.check(
  '量具自检：T3 表非空（"检查 0 格 / 0 不一致" 不是 PASS）',
  t3Table.length > 0,
  `${t3Table.length} 格`
)

/*
 * 经历类**不受新闸影响**：新闸的射程与闸 4 完全一致（`person_fact` / `preference`）。
 * 这条断言防的是"顺手把闸加到所有类型上"——那会把 M4 的共同经历记忆全部拒掉。
 */
const episodeResolved = resolveCandidates(
  [
    {
      memoryType: 'self_experience' as const,
      subjectToken: 'CHARACTER' as const,
      episode: {
        summary: '苏沐薇和 Alex 一起对了一遍来源资格闸的证据链',
        participantTokens: ['CHARACTER', 'USER'],
        topicTags: ['memory'],
      },
      evidenceEventSequences: [legacyView.sequence, herView.sequence],
    },
  ],
  {
    owner: h.owner,
    events: [legacyView, herView],
    speaker: h.user,
    processor: 'phase4a-gate',
    processorVersion: 'phase4a-gate@1',
  }
)
report.check(
  '射程正确：经历类（`self_experience`）**不受**来源资格闸约束（它本来也不建立外部事实）',
  episodeResolved[0]?.ok === true,
  episodeResolved[0]?.ok === false ? `被拒：${episodeResolved[0].rejection.reason}` : 'accepted'
)

// ---------------------------------------------------------------------------
// §5 恢复：放回真实实现 → 闸**重新安静**
// ---------------------------------------------------------------------------

report.section('§5 恢复（同一份合法来源重新读一遍 → 闸重新安静）')

const restoredRow = await getConversationEvent(h.db, positive.event.id)
if (restoredRow === undefined) throw new Error('恢复段失败：库里的用户事件读不回来')
const restoredView = processorEventViewOf(restoredRow)

report.check(
  '恢复：同一行的来源读数逐字段一致（派生是纯的，不随调用次序漂移）',
  JSON.stringify(restoredView.trustedOrigin) === JSON.stringify(positiveView.trustedOrigin),
  JSON.stringify(restoredView.trustedOrigin)
)
checkEqual(
  '恢复：来源资格回到 ESTABLISHED',
  sourceQualificationOf(restoredView.trustedOrigin),
  'ESTABLISHED'
)
checkEqual(
  '恢复：候选重新通过（负控没有污染正控的判定）',
  rejectionOf(restoredView),
  '(被接受了 —— 闸没响)'
)

/*
 * 三段式的**顺序性质**必须被证明，不能只是"跑完三个场景"：
 * 正控在负控**之前**安静过（§2），负控响过（§3），恢复之后又安静（§5）。
 * 三条合起来才排除了"闸永远响"与"闸永远不响"这两种同样绿的世界状态。
 */
report.check(
  '三段式闭合：正控安静（§2）→ 负控三种全响（§3）→ 恢复再次安静（§5）',
  positiveResolved[0]?.ok === true &&
    legacyReason === EVIDENCE_ORIGIN_NOT_ESTABLISHED &&
    herReason === EVIDENCE_ORIGIN_CONTRADICTS_CLAIM &&
    rejectionOf(restoredView) === '(被接受了 —— 闸没响)',
  '同上'
)

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

report.section('§6 量具有效性汇总')

report.check(
  '量具有效：扫描范围非空 + 针能命中 + 三种负控各自可区分 + 正控与恢复都安静',
  measuredCount > 0 && srcCallHits > 0 && srcAxisHits > 0 && positiveResolved[0]?.ok === true,
  `扫描 ${measuredCount} 文件 · 针命中 ${srcCallHits + srcFieldHits + srcAxisHits} 次 · 负控理由码 3 种已区分`
)

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1.1 Phase 4a 来源资格闸专项验证')
