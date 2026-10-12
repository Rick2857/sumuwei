/**
 * M6 · WP3 —— **接线门**（摘要真的接进上下文了吗？接得对不对？）。
 *
 * ============================================================================
 *  这份脚本要测的命题
 * ============================================================================
 *  「摘要在**空 / 关闭**时对 prompt 的影响是**零字节**；在**有内容**时只经由
 *    `extraProviders` 进入、只占一个可裁的最低优先级 section；而且它只在
 *    **真的启用过**时才在 trace 里留下**引用与计数**（没有正文）。」
 *
 *  三段式（AGENTS §6.7）：
 *    正控：非空摘要 ⇒ packet 里有 `rolling-summary` section，prompt 里含那段文本
 *    负控：空摘要 / 关闭 ⇒ **与不接摘要的 packet 逐字节相同**（裁定 R-2）
 *    恢复：撤掉注入 ⇒ 逐字节回到原值
 *
 *  量具自证（AGENTS §6.2）：
 *    · 静态接线锁：插入点只有一处，且**不在** `buildContextCompilerV2` 的默认 provider 列表里
 *    · 基线构造器（`m3.5-prompt-baseline.ts`）**不得**提到摘要
 *    · trace 属性块里**不许**出现正文变量名（隐私纪律）
 *
 * 用法：`pnpm exec tsx scripts/verify-m6-wp3-wiring.ts`
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  buildContextCompilerV2,
  composePromptFromPacket,
  createRollupSummaryProvider,
} from '../src/kernel/context/sections.ts'
import { SECTION_PRIORITY } from '../src/kernel/contracts/context.ts'
import { renderRollupBlock, type RollupItem } from '../src/kernel/contracts/rollup.ts'
import type { ConversationEventId } from '../src/kernel/contracts/ids.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import type { RollupSourceReader } from '../src/kernel/recall/ports.ts'
import type { RollupSourceFacts } from '../src/kernel/contracts/rollup.ts'
import { baselineIdentity } from './m3.5-prompt-baseline.ts'
import type { TrustedOriginReading } from '../src/kernel/contracts/attribution.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { createConversationEvent } from '../src/kernel/contracts/conversation-event.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { originReadingOfEvent } from '../src/infrastructure/persistence/qualification-read.ts'
import type { PrincipalRef } from '../src/kernel/contracts/actor.ts'

// ---------------------------------------------------------------------------
// 报告骨架（计数型）
// ---------------------------------------------------------------------------

const rows: { label: string; pass: boolean; detail?: string }[] = []
const measurements: { label: string; count: number; mustBePositive: boolean }[] = []
let failures = 0
let measurementInvalid = 0

function check(label: string, pass: boolean, detail?: string): void {
  if (!pass) failures += 1
  rows.push({ label, pass, ...(detail !== undefined ? { detail } : {}) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
function measure(label: string, count: number, mustBePositive = true): void {
  if (mustBePositive && count <= 0) measurementInvalid += 1
  measurements.push({ label, count, mustBePositive })
  console.log(`  MEASURE ${label} = ${count}${mustBePositive && count <= 0 ? '  ← MEASUREMENT INVALID' : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ROOT = resolve('.')

// ---------------------------------------------------------------------------
// 编译器夹具（与 `m3.5-prompt-baseline.ts` 同一套装配，不另写一份）
// ---------------------------------------------------------------------------

const identity = baselineIdentity()
const USER: PrincipalRef = { kind: 'USER', id: 'user-1' } as PrincipalRef
const CONVERSATION = 'conv:sumuwei:user-1'

const RECENT_EVENTS = [
  { id: 'cev:10' as unknown as ConversationEventId, sequence: 10, speaker: 'USER', text: '最近一句', actorType: 'user' as const },
  { id: 'cev:11' as unknown as ConversationEventId, sequence: 11, speaker: '苏沐薇', text: '最近一句回复', actorType: 'character' as const },
]

const COMPILE_INPUT = {
  characterId: identity.characterId,
  currentInput: '帮我想想我那只猫叫什么',
  recentEvents: RECENT_EVENTS,
  now: 1_700_000_000_000,
}

const ITEMS: RollupItem[] = [
  {
    sourceEventId: 'cev:3' as unknown as ConversationEventId,
    sequence: 3,
    text: '我的猫叫豆豆',
    qualification: 'ESTABLISHED',
    ruleVersion: 1,
  },
]
const BLOCK = renderRollupBlock(ITEMS)
const REFS = ['cev:cev:3']

async function compileWith(extra: { text: string; sourceRefs: string[] } | undefined, tokenBudget?: number) {
  const compiler = buildContextCompilerV2({
    identity,
    definition: identity.definition,
    recentLimit: 16,
    ...(extra !== undefined
      ? { extraProviders: [createRollupSummaryProvider({ render: () => extra })] }
      : {}),
  })
  /*
   * ⚠️ 预算要传给 **`compile()` 的输入**，不是编译器工厂的选项 ——
   * 裁剪读的是 `input.tokenBudget`（`contracts/context.ts` 的 `applyBudget(sorted, input.tokenBudget)`）。
   * 第一版把预算传给了工厂，于是"预算不足"那一组**什么都没被裁**，
   * 两条断言直接红。这是夹具的错，不是实现的错，而门把它抓出来了。
   */
  return await compiler.compile({
    ...COMPILE_INPUT,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  })
}

// ---------------------------------------------------------------------------
// ① packet 级：正控 / R-2 负控 / 预算
// ---------------------------------------------------------------------------

section('① packet 级 —— 正控、R-2 逐字节负控、可裁性')

const withoutRollup = await compileWith(undefined)
const withRollup = await compileWith({ text: BLOCK, sourceRefs: REFS })
const withEmptyRollup = await compileWith({ text: '', sourceRefs: [] })

const rollupSection = withRollup.sections.find((s) => s.id === 'rolling-summary')
measure('① 正常轮次的 section 数（范围自检）', withRollup.sections.length)
measure('① 摘要 item 数（范围自检）', ITEMS.length)

check(
  '①-1 正控：摘要 section 真的进了 packet',
  rollupSection !== undefined,
  withRollup.sections.map((s) => s.id).join(',')
)
check(
  '①-2 section 形状冻结：id / kind / priority 20 / 可裁',
  rollupSection?.id === 'rolling-summary' &&
    rollupSection.kind === 'rollup' &&
    rollupSection.priority === SECTION_PRIORITY.rollup &&
    rollupSection.droppable === true,
  `kind=${String(rollupSection?.kind)} priority=${String(rollupSection?.priority)} droppable=${String(rollupSection?.droppable)}`
)
check(
  '①-3 sourceRefs = 来源 id（不含正文）',
  JSON.stringify(rollupSection?.sourceRefs) === JSON.stringify(REFS),
  JSON.stringify(rollupSection?.sourceRefs)
)
check(
  '①-4 最终 prompt 里确实出现了那段摘录（注入的与预算算的是同一份）',
  composePromptFromPacket(withRollup, identity.definition.name).includes(BLOCK),
  BLOCK.split('\n')[0],
)
check(
  '①-5 **R-2 负控（逐字节）**：空摘要 ⇒ packet.text 与**不接摘要**时完全相同',
  withEmptyRollup.text === withoutRollup.text,
  `len ${withEmptyRollup.text.length} vs ${withoutRollup.text.length}`
)
check(
  '①-6 **R-2 负控（逐字节）**：空摘要 ⇒ 最终 prompt 与不接摘要时完全相同',
  composePromptFromPacket(withEmptyRollup, identity.definition.name) ===
    composePromptFromPacket(withoutRollup, identity.definition.name)
)
check(
  '①-7 **R-2 负控（强形式）**：空摘要时，**基线输入**的 packet.text 与新编译器相同',
  withEmptyRollup.text === withoutRollup.text && !withEmptyRollup.text.includes('早期对话'),
  `含摘要 header = ${String(withEmptyRollup.text.includes('早期对话'))}`
)

// 预算：不可裁项不能因为它被挤掉
const tight = await compileWith({ text: BLOCK, sourceRefs: REFS }, 100)
check(
  '①-8 预算不足时摘要**被裁**（进 droppedSectionIds），而不是挤掉不可裁项',
  tight.droppedSectionIds.includes('rolling-summary') &&
    tight.sections.some((s) => s.id === 'identity-core') &&
    tight.sections.some((s) => s.id === 'current-input'),
  `dropped=${tight.droppedSectionIds.join(',')}`
)
const tightSections = tight.sections.map((s) => s.id)
check(
  '①-9 被裁之后它**不**在 packet.sections 里（"选了" ≠ "入模"）',
  !tightSections.includes('rolling-summary') && tight.text !== withRollup.text
)

// ---------------------------------------------------------------------------
// ② 轮次级胶水：`createRollupTurnPort`
// ---------------------------------------------------------------------------

section('② 轮次级胶水（假 reader，无数据库）')

/*
 * 夹具的**唯一**来源读数组装方式：走真实 ingress 生产上下文 → 真实事件 →
 * 经 `qualification-read.ts` 的消费点取读数。
 *
 * ⚠️ 刻意**不**直接调派生函数、也**不**手写读数对象：
 *   · `TrustedOriginReading` 的必需字段在 `scripts/**` 里 0 处（脚本造不出同形读数）；
 *   · 那条派生函数名在 `src/**` 恰好 1 处（唯一适配边界，用户裁定 R-59）。
 * 走真实三段（ingress → event → 消费点）既满足这两条，又比"调一个函数造值"更接近生产。
 */
function readingUser(): TrustedOriginReading | undefined {
  const context = createHumanConsoleUserTurnIngress().attest({
    characterId: String(identity.characterId),
    presenterActorId: 'user-1',
    userId: 'user-1',
  })
  const event = createConversationEvent({
    characterId: identity.characterId,
    conversationId: asConversationId(CONVERSATION),
    // 纯函数构造：序号在这里是**输入**（真正的分配在持久层，见 `sequence.ts`）
    sequence: 1,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: 'user-1',
    content: '夹具事件',
    trustedAttribution: context,
  })
  return originReadingOfEvent(event)
}

let seq = 0
function facts(patch: Partial<RollupSourceFacts> & { originReading?: TrustedOriginReading | null } = {}): RollupSourceFacts {
  seq += 1
  const { originReading, ...rest } = patch
  const base = {
    eventId: `cev:${seq}` as unknown as ConversationEventId,
    conversationId: CONVERSATION,
    sequence: seq,
    type: 'user_message',
    content: `早期第 ${seq} 句`,
    rootMemoryStatuses: ['active'] as const,
    ...rest,
  }
  return originReading === null ? base : { ...base, originReading: originReading ?? readingUser() }
}

const legalSources: RollupSourceFacts[] = [facts({ sequence: 3, content: '我的猫叫豆豆' })]

const seenReads: { beforeSequence: number; scanCeiling: number }[] = []
function fakeReader(sources: readonly RollupSourceFacts[], mode: 'ok' | 'throw' = 'ok'): RollupSourceReader {
  return {
    name: 'fake-reader',
    async read(input) {
      seenReads.push({ beforeSequence: input.beforeSequence, scanCeiling: input.scanCeiling })
      if (mode === 'throw') throw new Error('读取面故意挂了')
      return sources
    },
  }
}

const baseRequest = {
  characterId: identity.characterId,
  conversationId: CONVERSATION,
  recentSourceEventIds: RECENT_EVENTS.map((l) => String(l.id)),
  beforeSequence: 10,
  budgetTokens: 400,
}

const portOff = createRollupTurnPort({ reader: fakeReader(legalSources) })
check('②-1 额度 0 ⇒ 端口返回 `undefined`（连 trace 都不写）', (await portOff.run({ ...baseRequest, budgetTokens: 0 })) === undefined)

const portOk = createRollupTurnPort({ reader: fakeReader(legalSources) })
const outcomeOk = await portOk.run(baseRequest)
check(
  '②-2 正控：合法来源 ⇒ 有可注入的块，且**逐字**等于来源文本',
  outcomeOk?.selection !== undefined &&
    outcomeOk.selection.items.length === 1 &&
    outcomeOk.selection.items[0]!.text === '我的猫叫豆豆',
  outcomeOk?.selection?.items[0]?.text
)
check(
  '②-3 trace 形态**不含正文**（类型里只有 id/计数/序列范围）',
  outcomeOk !== undefined &&
    !JSON.stringify(outcomeOk.trace).includes('豆豆') &&
    outcomeOk.trace.sourceRefs.every((ref) => ref.startsWith('cev:')),
  outcomeOk?.trace.sourceRefs.join(',')
)
check(
  '②-4 trace 如实给出覆盖范围与选择器版本',
  outcomeOk?.trace.coveredSequenceRange?.from === 3 &&
    outcomeOk.trace.coveredSequenceRange?.to === 3 &&
    outcomeOk.trace.selectorVersion.trim() !== '',
  `${JSON.stringify(outcomeOk?.trace.coveredSequenceRange)} v=${outcomeOk?.trace.selectorVersion}`
)

const portThrow = createRollupTurnPort({ reader: fakeReader(legalSources, 'throw') })
const outcomeThrow = await portThrow.run(baseRequest)
check(
  '②-5 负控：读取面抛错 ⇒ `read_failed` + **不注入**（失败关闭，不是"少摘几条"）',
  outcomeThrow?.selection === undefined && outcomeThrow?.trace.status === 'read_failed',
  `status=${String(outcomeThrow?.trace.status)}`
)

const portEmpty = createRollupTurnPort({
  reader: fakeReader([facts({ sequence: 4, type: 'assistant_message', content: '她自己说的' })]),
})
const outcomeEmpty = await portEmpty.run(baseRequest)
if (outcomeEmpty === undefined) {
  throw new Error('额度 > 0 时端口不应返回 undefined（夹具或实现有问题）—— 这是量具自身的故障')
}
check(
  '②-6 负控：只有助手来源 ⇒ 无可注入块，且**拒绝计数如实**（不是"没扫到"）',
  outcomeEmpty.selection === undefined &&
    outcomeEmpty.trace.status === 'evaluated' &&
    outcomeEmpty.trace.rejections.non_user_source === 1 &&
    outcomeEmpty.trace.scannedEventCount === 1,
  `non_user=${outcomeEmpty.trace.rejections.non_user_source} scanned=${outcomeEmpty.trace.scannedEventCount}`
)

check(
  '②-7 恢复：撤掉注入（换回合法来源）⇒ 逐字节回到原值',
  (await createRollupTurnPort({ reader: fakeReader(legalSources) }).run(baseRequest))?.selection
    ?.blockText === outcomeOk?.selection?.blockText
)

check(
  '②-8 `beforeSequence` 原样传给了读取面（摘要只覆盖 Recent 窗口**之前**）',
  seenReads.length > 0 && seenReads.every((item) => item.beforeSequence === 10),
  JSON.stringify(seenReads[0])
)
measure('② 读取面被调用的次数（范围自检）', seenReads.length)

// ---------------------------------------------------------------------------
// ③ 静态接线锁（"接在哪"与"没接在哪"都要能被抓住）
// ---------------------------------------------------------------------------

section('③ 静态接线锁')

const gatewaySrc = readFileSync(join(ROOT, 'src/kernel/app/turn-gateway.ts'), 'utf8')
const sectionsSrc = readFileSync(join(ROOT, 'src/kernel/context/sections.ts'), 'utf8')
const baselineSrc = readFileSync(join(ROOT, 'scripts/m3.5-prompt-baseline.ts'), 'utf8')
measure('③ 静态扫描的文件数（范围自检）', 3)

const callSites = gatewaySrc.split('createRollupSummaryProvider(').length - 1
check('③-1 网关里摘要 provider 的插入点**恰好 1 处**', callSites === 1, `命中 ${callSites} 处`)

const extraIdx = gatewaySrc.indexOf('const extraProviders = []')
const callIdx = gatewaySrc.indexOf('createRollupSummaryProvider(')
const compilerIdx = gatewaySrc.indexOf('const compiler = buildContextCompilerV2({')
check(
  '③-2 插入点位于 `extraProviders` 段内、编译器构造**之前**',
  extraIdx >= 0 && callIdx > extraIdx && compilerIdx > callIdx,
  `extraProviders@${extraIdx} call@${callIdx} compiler@${compilerIdx}`
)

const factoryBody = (() => {
  const start = sectionsSrc.indexOf('export function buildContextCompilerV2')
  const end = sectionsSrc.indexOf('\n/** 计划书第 40 节', start)
  return sectionsSrc.slice(start, end === -1 ? undefined : end)
})()
check(
  '③-3 **冻结基线的装配没被污染**：`buildContextCompilerV2` 的函数体里没有摘要',
  factoryBody.length > 0 && !/rollup|rolling|summary/i.test(factoryBody),
  `函数体 ${factoryBody.length} 字符`
)
check(
  '③-4 基线构造器（`m3.5-prompt-baseline.ts`）不得提到摘要',
  !/rollup|rolling|summary/i.test(baselineSrc)
)
const attributeBlock = (() => {
  const start = gatewaySrc.indexOf('rollup_status:')
  const end = gatewaySrc.indexOf('rollup_section_survived:', start)
  return gatewaySrc.slice(start, end)
})()
check(
  '③-5 trace 属性块里**没有正文变量**（隐私纪律：只记 id 与计数）',
  attributeBlock.length > 0 && !/blockText|selected\.blockText|content:/.test(attributeBlock),
  `${attributeBlock.length} 字符`
)
check(
  '③-6 provider 定义冻结：`kind: \'rollup\'` + `droppable: true` + 优先级取 `SECTION_PRIORITY.rollup`',
  /name: 'rolling-summary'/.test(sectionsSrc) &&
    /kind: 'rollup'/.test(sectionsSrc) &&
    /priority: SECTION_PRIORITY\.rollup/.test(sectionsSrc) &&
    /droppable: true/.test(sectionsSrc)
)
check(
  '③-7 网关**没有**把摘要塞进 `buildContextCompilerV2` 的默认 provider 参数里',
  !/buildContextCompilerV2\(\{[\s\S]*?providers:[\s\S]*?rollup/.test(gatewaySrc)
)

// ---------------------------------------------------------------------------
// ④ 冻结基线：夹具与生成器的输出仍然一致（"有人改了 prompt 却没刷基线"要能被抓住）
// ---------------------------------------------------------------------------

section('④ 冻结 prompt 基线')

const fixturePath = join(ROOT, 'evals/fixtures/m3.5/prompt-baseline.txt')
const fixtureRaw = readFileSync(fixturePath, 'utf8')
const { buildBaselinePrompt } = await import('./m3.5-prompt-baseline.ts')
const generated = (await buildBaselinePrompt()).prompt
const normalize = (text: string): string => text.replace(/\r\n/g, '\n')
check(
  '④-1 冻结夹具与 `buildBaselinePrompt()` 的输出逐字节相同（LF 归一化）',
  normalize(fixtureRaw) === normalize(generated),
  `夹具 ${fixtureRaw.length} / 生成 ${generated.length}`
)
check(
  '④-2 夹具里的**原始字节**也是 LF（没有 checkout 造成的 CRLF 漂移）',
  !fixtureRaw.includes('\r\n'),
  `含 CRLF = ${String(fixtureRaw.includes('\r\n'))}`
)
check(
  '④-3 基线 prompt 里**没有**摘要 header（它不可能含摘要 section）',
  !normalize(generated).includes('早期对话')
)
measure('④ 基线 prompt 的字符数（范围自检）', normalize(generated).length)

// ---------------------------------------------------------------------------
// 判决与证据
// ---------------------------------------------------------------------------

section('判决')

const total = rows.length
const passed = rows.filter((row) => row.pass).length
let verdict = 'PASS'
if (measurementInvalid > 0) verdict = 'MEASUREMENT INVALID'
else if (failures > 0) verdict = 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const now = new Date()
const runId = `m6-wp3-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = resolve('artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wiring.json')

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 'm6-wp3-wiring@1',
      runId,
      generatedAt: now.toISOString(),
      head,
      verdict,
      passed,
      failed: failures,
      measurementInvalid,
      measurements,
      checks: rows,
      packetFacts: {
        sectionsWithRollup: withRollup.sections.map((s) => s.id),
        droppedWhenTight: tight.droppedSectionIds,
        emptyRollupByteIdentical: withEmptyRollup.text === withoutRollup.text,
      },
      glueFacts: { readCalls: seenReads.length, beforeSequencePassed: seenReads[0]?.beforeSequence ?? null },
      scope: {
        opensDatabase: false,
        writesPersistentState: false,
        callsModel: false,
        headSemantics:
          '`head` = 本次运行时 git HEAD（被测代码提交）；证据文件本身落在紧随其后的纯证据提交里。',
        note:
          '接线门：只调用编译器、provider 与轮次级胶水；读取面用**假 reader**，因此不打开数据库、不跑模型、无任何写入。证据里不含真实对话正文（夹具是合成的）。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n  ${verdict} — ${passed}/${total} 通过，失败 ${failures}，MEASUREMENT INVALID ${measurementInvalid}`)
console.log(`  证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)

process.exit(verdict === 'PASS' ? 0 : 2)
