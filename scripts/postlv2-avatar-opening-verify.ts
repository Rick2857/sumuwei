/**
 * ADR-131（皮套入口的系统发起开口）**离线门**。
 *
 * ============================================================================
 *  它守什么（五段，每段都自带三段式）
 * ============================================================================
 * ```text
 * §1 机会预检     15 条具名拒绝 + 判据顺序 + 幂等 + 机会键日界
 * §2 生成侧       提示词（上限从契约派生）/ 严格解析 / 候选 / 表达信封
 *                 —— 且**真的**经过两个既有消费者（出站仲裁 + 表达解码）
 * §3 编排         调用**计数**（空依据零调用 / 失败只调一次）/ 回复守卫在链上 /
 *                 发送前双次复核（S04）/ 长度与话权与版本交给既有仲裁
 * §4 机会状态     时区日界 / 占额 / 幂等键有界 / **内存实现的已知局限是读数**
 * §5 接线         报文种类在闭集里且**不是控制类** / 桥的三个读访问器 /
 *                 transport 注入线 / 装配根的端口 / 外壳的上报器与诊断面
 * ```
 *
 * ============================================================================
 *  三段式（每一段都跑）
 * ============================================================================
 * ```text
 * ① 正控（系统按设计工作）      ：全部判据过
 * ② 负控（**系统**的真破坏）    ：由各段自己写（真不合格的输入被**正确具名**地拒）
 * ③ 量具有效性（**量具**的负控） ：`collect(true)` 把期望反向 ⇒ **必须**有失败
 * ④ 恢复                        ：`collect(false)` 再跑 ⇒ 失败 0
 * ⑤ `measured_count > 0`        ：不许"零断言全绿"
 * ```
 * ⚠️ ③ 与 ② 是两件事：② 证**被测对象**在该拒时拒；③ 证**判据本身**不是恒真。
 *
 * ============================================================================
 *  ⚠️ 静态判据的纪律（`L-QQP-09`，本仓库同型踩坑第三次）
 * ============================================================================
 * ```text
 * **不许**用"全文按词找"当判据 —— 三次都是被**我自己的注释**打败。
 * ⇒ §5 一律优先用**结构判据**：把真东西 import 进来**调用它**
 *    （例如 `isBridgeControlMessageKind('PROACTIVE_OPPORTUNITY')` 必须为 false），
 *    而不是在源码里搜那几个字。
 * ⇒ 只有确实无法 import 的（`main.ts` 里内联的那个端口、外壳的 Python）才退回**窄范围**文本判据，
 *    并且**在读数里写明它是文本判据**。
 * ```
 *
 * 跑法： `pnpm postlv2:avatar-opening:verify`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_PROACTIVE_POLICY, type ProactivePolicy } from '../src/kernel/contracts/notification.ts'
import {
  OPENING_REFUSAL_CODES,
  assertOpeningRefusalCodesWellFormed,
  openingOpportunityKey,
  precheckOpeningOpportunity,
  type OpeningPrecheckInput,
  type OpeningRefusalCode,
} from '../src/kernel/contracts/proactive-opening.ts'
import {
  PROACTIVE_MAX_SOURCE_OPTIONS,
  PROACTIVE_SOURCE_SUMMARY_CODEPOINTS,
} from '../src/kernel/contracts/proactive-proposal.ts'
import {
  PROACTIVE_OPENING_CUE,
  OPENING_MAX_CHARACTERS,
  OPENING_MAX_SENTENCES,
  buildOpeningCandidate,
  buildOpeningEvidence,
  buildOpeningInstruction,
  readOpeningResponse,
  renderOpeningExpressionEnvelope,
  runOpeningOpportunity,
  type OpeningModelPort,
  type OpeningModelResult,
  type OpeningRunOutcome,
} from '../src/kernel/app/bridge/proactive-opening.ts'
import {
  createInMemoryOpeningState,
  countOpeningsToday,
  IN_MEMORY_OPENING_STATE_LIMITATION,
  openingPrecheckInputs,
} from '../src/kernel/app/bridge/proactive-opening-state.ts'
import {
  CHARACTER_OUTPUT_LIMITS,
  NON_URGENT_CHARACTER_OUTPUT_SOURCES,
  arbitrateCharacterOutput,
} from '../src/kernel/app/bridge/character-output.ts'
import { BRIDGE_MESSAGE_KINDS, isBridgeControlMessageKind } from '../src/kernel/app/bridge/turn-bridge.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { decodeExpressiveSpeech } from '../src/kernel/contracts/expressive-speech.ts'
import { REPO_ROOT } from './gates/manifest.ts'

// ---------------------------------------------------------------------------
// 三段式驱动（本门内联；四个探针的本地原型与它同形）
// ---------------------------------------------------------------------------

interface Row {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

interface SectionResult {
  readonly title: string
  readonly failed: number
  readonly mangleFailed: number
  readonly measured: number
  readonly lines: string[]
}

async function threePhase(title: string, collect: (mangle: boolean) => Promise<Row[]> | Row[]): Promise<SectionResult> {
  const phase1 = await collect(false)
  const phase2 = await collect(true)
  const phase3 = await collect(false)
  const bad = (rows: readonly Row[]): number => rows.filter((row) => !row.pass).length
  const failed = bad(phase1)
  const mangleFailed = bad(phase2)
  const recovered = bad(phase3)
  const lines: string[] = [`\n—— ${title} ——`]
  for (const row of phase1) lines.push(`  ${row.pass ? '✅' : '❌'} ${row.name}  ${row.detail}`)
  lines.push(`  ③ 量具有效性：期望反向 ⇒ 失败 ${String(mangleFailed)}（**必须 > 0**）  ${mangleFailed > 0 ? '✅' : '❌'}`)
  lines.push(`  ④ 恢复：⇒ 失败 ${String(recovered)}（**必须 = 0**）  ${recovered === 0 ? '✅' : '❌'}`)
  return {
    title,
    failed,
    mangleFailed,
    measured: phase1.length,
    lines,
    /* 恢复相也是判据：它不单独计入失败数，但会拉低 verdict（见 main） */
    ...(recovered === 0 ? {} : { failed: failed + recovered }),
  }
}

/** 量具有效性的反向：把期望翻过来（各段只需实现 `collect`） */
const flip = (mangle: boolean, pass: boolean): boolean => (mangle ? !pass : pass)

// ---------------------------------------------------------------------------
// §1 机会预检
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 11, 4, 0, 0) /* 上海 2026-10-11 12:00 */
const TZ = DEFAULT_PROACTIVE_POLICY.timeZone
const POLICY_ALL_DAY: ProactivePolicy = {
  ...DEFAULT_PROACTIVE_POLICY,
  activeWindow: { timeZone: TZ, startHour: 0, endHour: 24 },
}
const PRECHECK_BASE: OpeningPrecheckInput = {
  entry: 'avatar',
  idleMs: POLICY_ALL_DAY.openingMinIdleMs + 1_000,
  now: NOW,
  policy: POLICY_ALL_DAY,
  paused: false,
  entryScopedConversations: true,
  candidateInFlight: false,
  evidenceCount: 3,
  sheIsSpeaking: false,
  userIsSpeaking: false,
  hasLiveClient: true,
  openingsUsedToday: 0,
  allUsedToday: 0,
}

function shiftCode(code: OpeningRefusalCode): OpeningRefusalCode {
  const index = OPENING_REFUSAL_CODES.indexOf(code)
  return OPENING_REFUSAL_CODES[(index + 1) % OPENING_REFUSAL_CODES.length]!
}

function precheckCollect(mangle: boolean): Row[] {
  const rows: Row[] = []
  const expect = (name: string, override: Partial<OpeningPrecheckInput>, expected: OpeningRefusalCode): void => {
    const result = precheckOpeningOpportunity({ ...PRECHECK_BASE, ...override })
    const got = result.eligible ? 'ELIGIBLE' : result.code
    const target = mangle ? shiftCode(expected) : expected
    rows.push({ name, pass: got === target, detail: `期望=${target} 实际=${got}` })
  }
  {
    const result = precheckOpeningOpportunity(PRECHECK_BASE)
    const good =
      result.eligible === true &&
      result.opportunityKey === openingOpportunityKey(NOW, TZ) &&
      result.deadlineMs === POLICY_ALL_DAY.openingDeadlineMs
    rows.push({
      name: '正控：全部读数就绪 ⇒ eligible（机会键 + 期限都对）',
      pass: flip(mangle, good),
      detail: result.eligible ? `key=${result.opportunityKey} deadline=${String(result.deadlineMs)}` : result.code,
    })
  }
  expect('形状：入口不是皮套', { entry: 'qq_private' }, 'opening_wrong_entry')
  expect('形状：idleMs 非法', { idleMs: Number.NaN }, 'opening_invalid_idle')
  expect('幂等：机会键已处理过', { handledOpportunityKeys: [openingOpportunityKey(NOW, TZ)] }, 'opening_opportunity_already_handled')
  expect('用户已暂停', { paused: true }, 'paused')
  expect('入口作用域未开', { entryScopedConversations: false }, 'entry_scope_required')
  expect('已有候选在途', { candidateInFlight: true }, 'candidate_in_flight')
  expect(
    '时段外（ADR-113 的理由：系统自发的一类受约束）',
    { policy: { ...POLICY_ALL_DAY, activeWindow: { timeZone: TZ, startHour: 0, endHour: 1 } } },
    'outside_active_window'
  )
  expect('外壳报的空闲不足', { idleMs: POLICY_ALL_DAY.openingMinIdleMs - 1 }, 'not_idle_enough')
  expect('冷却中', { lastOpeningAt: NOW - 60_000 }, 'cooldown')
  expect('本通道日额度用完', { openingsUsedToday: POLICY_ALL_DAY.maxOpeningsPerDay }, 'opening_quota_reached')
  expect('共享总闸用完', { allUsedToday: POLICY_ALL_DAY.maxProactiveMessagesPerDay }, 'daily_quota_reached')
  expect('依据集为空（**不花模型**）', { evidenceCount: 0 }, 'opening_without_evidence')
  expect('她正在说', { sheIsSpeaking: true }, 'opening_she_is_speaking')
  expect('用户正在说', { userIsSpeaking: true }, 'opening_user_is_speaking')
  expect('没有活客户端', { hasLiveClient: false }, 'opening_no_live_client')
  /* 顺序就是判据的一部分：两处都坏时报**先**那一条 */
  {
    const r = precheckOpeningOpportunity({ ...PRECHECK_BASE, entry: 'x', paused: true })
    rows.push({
      name: '顺序：形状先于暂停',
      pass: flip(mangle, !r.eligible && r.code === 'opening_wrong_entry'),
      detail: r.eligible ? 'ELIGIBLE' : r.code,
    })
  }
  {
    const r = precheckOpeningOpportunity({ ...PRECHECK_BASE, evidenceCount: 0, sheIsSpeaking: true })
    rows.push({
      name: '顺序：依据集先于她正在说',
      pass: flip(mangle, !r.eligible && r.code === 'opening_without_evidence'),
      detail: r.eligible ? 'ELIGIBLE' : r.code,
    })
  }
  {
    const sameHour = openingOpportunityKey(NOW + 5 * 60_000, TZ)
    const nextHour = openingOpportunityKey(NOW + 60 * 60_000, TZ)
    rows.push({
      name: '机会键：同小时相同 / 跨小时不同',
      pass: flip(mangle, sameHour === openingOpportunityKey(NOW, TZ) && nextHour !== sameHour),
      detail: `${sameHour} / ${nextHour}`,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// §2 生成侧
// ---------------------------------------------------------------------------

const QUIET = { userSpeaking: false, userRevision: 1 }
const SPEAKING = { userSpeaking: true, userRevision: 1 }

function tryDecode(envelope: string): { text?: string; segments?: number; cue?: string; error?: string } {
  try {
    const decoded = decodeExpressiveSpeech(envelope)
    return { text: decoded.text, segments: decoded.segments.length, cue: String(decoded.segments[0]?.cue) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function generatorCollect(mangle: boolean): Row[] {
  const rows: Row[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    rows.push({ name, pass: flip(mangle, pass), detail })
  }
  push(
    '上限与出站仲裁**同源**（不另写一份数字）',
    OPENING_MAX_SENTENCES === CHARACTER_OUTPUT_LIMITS.maxSentences &&
      OPENING_MAX_CHARACTERS === CHARACTER_OUTPUT_LIMITS.maxCharacters,
    `${String(OPENING_MAX_SENTENCES)} 句 / ${String(OPENING_MAX_CHARACTERS)} 字`
  )
  const instruction = buildOpeningInstruction()
  push(
    '提示词从契约派生上限',
    instruction.includes(String(OPENING_MAX_SENTENCES)) && instruction.includes(String(OPENING_MAX_CHARACTERS)),
    '两个数都在提示词里'
  )
  push(
    '提示词是闭集字段且明说"多一个字段整条作废"',
    instruction.includes('只能有一个字段 `text`') && instruction.includes('多一个字段整条作废'),
    '闭集'
  )
  push('提示词不给"用户让你找他"的错觉（ADR-110 D04 同纪律）', !instruction.includes('用户让你'), '只说"一次机会"')
  push('提示词明说"不宣称没做过的事"', instruction.includes('没有做过'), '禁伪造行动')
  {
    const empty = buildOpeningEvidence([])
    push(
      '空依据集 ⇒ section=undefined（S06 失败关闭的入口）',
      empty.section === undefined && empty.sourceRefs.length === 0,
      `refs=${String(empty.sourceRefs.length)}`
    )
  }
  {
    const many = [
      { ref: 'memory:a', label: '甲'.repeat(PROACTIVE_SOURCE_SUMMARY_CODEPOINTS + 30) },
      { ref: 'memory:a', label: '重复 ref' },
      { ref: '', label: '空 ref' },
      { ref: 'memory:b', label: '   ' },
      ...Array.from({ length: 10 }, (_, i) => ({ ref: `memory:c${String(i)}`, label: `第${String(i)}条` })),
    ]
    const built = buildOpeningEvidence(many)
    const refs = [...built.sourceRefs]
    push(
      `有界化：去重 / 去空 / 最多 ${String(PROACTIVE_MAX_SOURCE_OPTIONS)} 条`,
      refs.length === PROACTIVE_MAX_SOURCE_OPTIONS && new Set(refs).size === refs.length,
      `refs=${String(refs.length)}`
    )
    const firstLine = (built.section?.text ?? '').split('\n')[1] ?? ''
    push(
      `摘要按**码点**截到 ${String(PROACTIVE_SOURCE_SUMMARY_CODEPOINTS)}`,
      firstLine === `- memory:a：${'甲'.repeat(PROACTIVE_SOURCE_SUMMARY_CODEPOINTS)}`,
      `首行码点=${String([...firstLine].length)}`
    )
  }
  const acceptCases: [string, unknown, boolean][] = [
    ['合法 {text}', { text: '在忙吗？' }, true],
    ['两侧空白被 trim', { text: '  在忙吗？  ' }, true],
    ['null', null, false],
    ['数组', ['x'], false],
    ['多一个字段', { text: 'x', cue: 'natural' }, false],
    ['缺 text', { other: 'x' }, false],
    ['text 不是字符串', { text: 123 }, false],
    ['text 空串', { text: '' }, false],
    ['text 全空白', { text: '   ' }, false],
  ]
  for (const [name, raw, shouldOk] of acceptCases) {
    const r = readOpeningResponse(raw)
    push(`解析：${name} ⇒ ${shouldOk ? '接受' : '拒绝'}`, r.ok === shouldOk, r.ok ? `ok(${r.text})` : r.code)
  }
  push(
    '解析器**不判长度**（长度留成读数，不降级成解析失败）',
    readOpeningResponse({ text: '长'.repeat(OPENING_MAX_CHARACTERS + 1) }).ok === true,
    '形状通过 ⇒ 由仲裁报 output_too_long'
  )
  {
    const d = arbitrateCharacterOutput({
      candidate: buildOpeningCandidate({ text: '在忙吗？', sourceRefs: ['memory:a'], turnRevision: 1 }),
      floor: QUIET,
    })
    push(
      '集成：候选 ⇒ **既有仲裁**接受，source/yieldFloor 正确',
      d.action === 'speak' && d.source === 'proactive_opening' && d.yieldFloor === true,
      d.action === 'speak' ? `speak(${d.source})` : d.action
    )
  }
  {
    const d = arbitrateCharacterOutput({
      candidate: buildOpeningCandidate({ text: '在忙吗？', sourceRefs: ['memory:a'], turnRevision: 1 }),
      floor: SPEAKING,
    })
    push(
      '集成：用户正在说 ⇒ 既有仲裁让位（D07 不另写一份判据）',
      d.action === 'yield_to_user' && d.code === 'user_holds_floor_for_non_urgent_output',
      d.action === 'yield_to_user' ? d.code : d.action
    )
  }
  for (const [name, candidateInput, code] of [
    ['来源为空', { text: '在忙吗？', sourceRefs: [], turnRevision: 1 }, 'output_without_source'],
    [
      '超长',
      { text: '长'.repeat(OPENING_MAX_CHARACTERS + 1), sourceRefs: ['memory:a'], turnRevision: 1 },
      'output_too_long',
    ],
    ['无版本', { text: '在忙吗？', sourceRefs: ['memory:a'], turnRevision: 0 }, 'output_without_revision'],
  ] as const) {
    const d = arbitrateCharacterOutput({ candidate: buildOpeningCandidate(candidateInput), floor: QUIET })
    push(`集成：${name} ⇒ 既有仲裁报 ${code}`, d.action === 'drop' && d.code === code, d.action === 'drop' ? d.code : d.action)
  }
  {
    const decoded = tryDecode(renderOpeningExpressionEnvelope({ replyId: 'reply:opening-1', text: '在忙吗？' }))
    push(
      '集成：信封被**既有解码器**接受，正文逐字往返',
      decoded.text === '在忙吗？' && decoded.segments === 1,
      decoded.error ?? `text=${String(decoded.text)} segs=${String(decoded.segments)}`
    )
    push('集成：cue 是程序既定值（v1 不让模型挑）', decoded.cue === PROACTIVE_OPENING_CUE, decoded.error ?? String(decoded.cue))
    const bad = tryDecode(renderOpeningExpressionEnvelope({ replyId: 'r', text: '   ' }))
    push(
      '负控：空正文的信封被解码器**拒绝**',
      typeof bad.error === 'string' && bad.error.length > 0,
      bad.error ?? '（没有拒绝——坏了）'
    )
  }
  return rows
}

// ---------------------------------------------------------------------------
// §3 编排
// ---------------------------------------------------------------------------

const RUNNER_CANDIDATES = [
  { ref: 'memory:a', label: '他明天要交材料' },
  { ref: 'belief:b', label: '他最近在准备答辩' },
]
const RUNNER_CHANGED = [{ ref: 'memory:z', label: '换了一条完全不同的依据' }]
const RUNNER_PRECHECK = { eligible: true as const, opportunityKey: '2026-10-11T12', idleMs: 300_000, deadlineMs: 8_000 }

function fakeModel(behavior: (briefing: string) => OpeningModelResult): OpeningModelPort & { calls: () => number } {
  let calls = 0
  return {
    id: 'fake@verify',
    endpointHost: 'fake',
    async invoke(input) {
      calls += 1
      return behavior(input.briefing)
    },
    calls: () => calls,
  }
}

const okText = (text: string): OpeningModelResult => ({ ok: true, raw: JSON.stringify({ text }) })
const outcomeCode = (outcome: OpeningRunOutcome): string =>
  outcome.kind === 'silenced' ? outcome.code : `spoken(${outcome.text})`

async function runnerCollect(mangle: boolean): Promise<Row[]> {
  const rows: Row[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    rows.push({ name, pass: flip(mangle, pass), detail })
  }
  const run = async (input: {
    model: OpeningModelPort
    candidates?: readonly { ref: string; label: string }[]
    floor?: { userSpeaking: boolean; userRevision: number }
    turnRevision?: number
    recheck?: () => readonly { ref: string; label: string }[]
  }): Promise<OpeningRunOutcome> =>
    await runOpeningOpportunity({
      precheck: RUNNER_PRECHECK,
      candidates: input.candidates ?? RUNNER_CANDIDATES,
      model: input.model,
      turnRevision: input.turnRevision ?? 1,
      floor: input.floor ?? QUIET,
      ...(input.recheck === undefined ? {} : { recheckEvidence: async () => input.recheck!() }),
    })

  {
    const model = fakeModel(() => okText('在忙吗？'))
    const outcome = await run({ model, recheck: () => RUNNER_CANDIDATES })
    push(
      '正控：够格 + 有依据 + 复核一致 ⇒ spoken',
      outcome.kind === 'spoken' && outcome.text === '在忙吗？' && outcome.sourceRefs.length === 2,
      outcomeCode(outcome)
    )
    push('正控：**只调了一次**模型', model.calls() === 1, `calls=${String(model.calls())}`)
  }
  {
    const model = fakeModel(() => okText('不该被问到'))
    const outcome = await run({ model, candidates: [], recheck: () => [] })
    push(
      '★ 空依据集 ⇒ opening_without_evidence，且**零模型调用**',
      outcome.kind === 'silenced' && outcome.code === 'opening_without_evidence' && model.calls() === 0,
      `${outcomeCode(outcome)} · calls=${String(model.calls())}`
    )
  }
  for (const failure of ['call_failed', 'timeout', 'invalid_output'] as const) {
    const model = fakeModel(() => ({ ok: false, failure }))
    const outcome = await run({ model, recheck: () => RUNNER_CANDIDATES })
    push(
      `失败分桶：${failure} ⇒ 同名拒，且**只调一次**`,
      outcome.kind === 'silenced' && outcome.code === failure && model.calls() === 1,
      `${outcomeCode(outcome)} · calls=${String(model.calls())}`
    )
  }
  {
    const model: OpeningModelPort = {
      id: 'thrower',
      endpointHost: 'fake',
      async invoke() {
        throw new Error('端口炸了')
      },
    }
    push(
      '端口抛错 ⇒ call_failed（不把异常当"她决定不说话"）',
      outcomeCode(await run({ model, recheck: () => RUNNER_CANDIDATES })) === 'call_failed',
      'call_failed'
    )
  }
  for (const [name, raw, code] of [
    ['不是 JSON', '这不是 JSON', 'opening_text_not_json'],
    ['多一个字段', JSON.stringify({ text: '在忙吗？', cue: 'natural' }), 'opening_text_unknown_field'],
  ] as const) {
    const model = fakeModel(() => ({ ok: true, raw }))
    const got = outcomeCode(await run({ model, recheck: () => RUNNER_CANDIDATES }))
    push(`${name} ⇒ ${code}`, got === code, got)
  }
  {
    const model = fakeModel(() => okText('我记住了'))
    const outcome = await run({ model, recheck: () => RUNNER_CANDIDATES })
    push(
      '★ 回复守卫**真的在链上**：说"我记住了" ⇒ 正文被改写',
      outcome.kind === 'spoken' && outcome.text !== '我记住了',
      outcome.kind === 'spoken' ? `守卫后=${outcome.text}` : outcomeCode(outcome)
    )
    push(
      '★ 改写前的正文被单独交出（供 sidecar 标 guard_rewrite）',
      outcome.kind === 'spoken' && outcome.draftText === '我记住了' && outcome.guardCorrected === true,
      outcome.kind === 'spoken' ? `draft=${outcome.draftText} corrected=${String(outcome.guardCorrected)}` : outcomeCode(outcome)
    )
  }
  {
    const model = fakeModel(() => okText('长'.repeat(61)))
    push(
      '超长 ⇒ **既有仲裁**报 output_too_long（编排层不自己判长度）',
      outcomeCode(await run({ model, recheck: () => RUNNER_CANDIDATES })) === 'output_too_long',
      'output_too_long'
    )
  }
  {
    const model = fakeModel(() => okText('在忙吗？'))
    push(
      '用户正在说 ⇒ 既有仲裁让位',
      outcomeCode(await run({ model, floor: SPEAKING, recheck: () => RUNNER_CANDIDATES })) ===
        'user_holds_floor_for_non_urgent_output',
      'user_holds_floor_for_non_urgent_output'
    )
  }
  {
    const model = fakeModel(() => okText('在忙吗？'))
    push(
      '无版本 ⇒ 既有仲裁报 output_without_revision',
      outcomeCode(await run({ model, turnRevision: 0, recheck: () => RUNNER_CANDIDATES })) === 'output_without_revision',
      'output_without_revision'
    )
  }
  {
    const model = fakeModel(() => okText('在忙吗？'))
    push('**没接**发送前复核 ⇒ opening_recheck_not_wired（宁可不发）', outcomeCode(await run({ model })) === 'opening_recheck_not_wired', 'opening_recheck_not_wired')
  }
  {
    const model = fakeModel(() => okText('在忙吗？'))
    push(
      '复核后依据**变了** ⇒ opening_evidence_changed（整条作废，不修补）',
      outcomeCode(await run({ model, recheck: () => RUNNER_CHANGED })) === 'opening_evidence_changed',
      'opening_evidence_changed'
    )
  }
  {
    const model = fakeModel(() => okText('在忙吗？'))
    push('复核后依据**空了** ⇒ opening_evidence_expired', outcomeCode(await run({ model, recheck: () => [] })) === 'opening_evidence_expired', 'opening_evidence_expired')
  }
  {
    let reads = 0
    const model = fakeModel(() => okText('在忙吗？'))
    const outcome = await run({
      model,
      recheck: () => {
        reads += 1
        return RUNNER_CANDIDATES
      },
    })
    push('复核**真的被读了**（读次数 = 1）⇒ spoken', reads === 1 && outcome.kind === 'spoken', `reads=${String(reads)}`)
  }
  return rows
}

// ---------------------------------------------------------------------------
// §4 机会状态
// ---------------------------------------------------------------------------

const SHANGHAI_2330 = Date.UTC(2026, 9, 11, 15, 30)
const SHANGHAI_0030 = Date.UTC(2026, 9, 11, 16, 30)

function stateCollect(mangle: boolean): Row[] {
  const rows: Row[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    rows.push({ name, pass: flip(mangle, pass), detail })
  }
  push(
    '前提：这两刻**同属 UTC 日**、但上海分属两天',
    Math.floor(SHANGHAI_2330 / 86_400_000) === Math.floor(SHANGHAI_0030 / 86_400_000),
    'sameUtcDay=true'
  )
  push(
    '★ 日额度按**时区**日界数（不是 UTC 日）',
    countOpeningsToday([SHANGHAI_2330], SHANGHAI_0030, TZ) === 0 &&
      countOpeningsToday([SHANGHAI_0030], SHANGHAI_0030, TZ) === 1,
    `跨日=${String(countOpeningsToday([SHANGHAI_2330], SHANGHAI_0030, TZ))} 当日=${String(countOpeningsToday([SHANGHAI_0030], SHANGHAI_0030, TZ))}`
  )
  push(
    '机会键跟着日界走',
    openingOpportunityKey(SHANGHAI_2330, TZ) !== openingOpportunityKey(SHANGHAI_0030, TZ),
    `${openingOpportunityKey(SHANGHAI_2330, TZ)} vs ${openingOpportunityKey(SHANGHAI_0030, TZ)}`
  )
  {
    const state = createInMemoryOpeningState()
    state.record({ opportunityKey: 'k1', at: NOW - 60_000 })
    state.record({ opportunityKey: 'k2', at: NOW - 30_000 })
    const snapshot = state.snapshot()
    push(
      'record：lastOpeningAt 取**最新**、时间戳升序、键去重',
      snapshot.lastOpeningAt === NOW - 30_000 &&
        snapshot.openingTimestamps.length === 2 &&
        snapshot.handledOpportunityKeys.join(',') === 'k1,k2',
      `last=${String(snapshot.lastOpeningAt)} keys=${String(snapshot.handledOpportunityKeys.length)}`
    )
    state.record({ opportunityKey: 'k1', at: NOW - 10_000 })
    push(
      '同键再记：时间戳**仍然追加**（占额要算），但键不重复',
      state.snapshot().openingTimestamps.length === 3 && state.snapshot().handledOpportunityKeys.length === 2,
      `ts=${String(state.snapshot().openingTimestamps.length)}`
    )
  }
  {
    const state = createInMemoryOpeningState()
    for (let i = 0; i < 60; i += 1) state.record({ opportunityKey: `k${String(i)}`, at: NOW + i })
    const keys = state.snapshot().handledOpportunityKeys
    push('幂等键**有界**（不留无限历史）', keys.length <= 48 && keys[keys.length - 1] === 'k59', `n=${String(keys.length)}`)
  }
  {
    const state = createInMemoryOpeningState()
    state.record({ opportunityKey: openingOpportunityKey(NOW, TZ), at: NOW - 1_000 })
    const result = precheckOpeningOpportunity({
      ...PRECHECK_BASE,
      ...openingPrecheckInputs({ state, now: NOW, policy: POLICY_ALL_DAY, allUsedToday: 0 }),
    })
    push(
      '对接：状态端口喂进预检 ⇒ 同键被幂等挡住',
      !result.eligible && result.code === 'opening_opportunity_already_handled',
      result.eligible ? 'ELIGIBLE（不该）' : result.code
    )
  }
  {
    /* ★ 把**已知局限**变成读数：全新实例上同一个机会键照样放行 */
    const key = openingOpportunityKey(NOW, TZ)
    const a = createInMemoryOpeningState()
    a.record({ opportunityKey: key, at: NOW - 1_000 })
    const onA = precheckOpeningOpportunity({
      ...PRECHECK_BASE,
      ...openingPrecheckInputs({ state: a, now: NOW, policy: POLICY_ALL_DAY, allUsedToday: 0 }),
    })
    const onB = precheckOpeningOpportunity({
      ...PRECHECK_BASE,
      ...openingPrecheckInputs({ state: createInMemoryOpeningState(), now: NOW, policy: POLICY_ALL_DAY, allUsedToday: 0 }),
    })
    push(
      '★ 局限实测：A 上被挡、**全新实例 B 上照样放行**（重启绕过限流）',
      !onA.eligible && onA.code === 'opening_opportunity_already_handled' && onB.eligible === true,
      `A=${onA.eligible ? 'ELIGIBLE' : onA.code} · B=${onB.eligible ? 'ELIGIBLE（重启绕过了）' : onB.code}`
    )
    push(
      '该局限有**机器可读**标识（`L-APO-01` 的锚点）',
      IN_MEMORY_OPENING_STATE_LIMITATION.startsWith('in_memory_opening_state_resets_on_restart'),
      IN_MEMORY_OPENING_STATE_LIMITATION.slice(0, 56) + '…'
    )
  }
  return rows
}

// ---------------------------------------------------------------------------
// §5 接线（**优先结构判据**；只有无法 import 的才用窄范围文本判据）
// ---------------------------------------------------------------------------

function readRepoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

function wiringCollect(): Row[] {
  const rows: Row[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    rows.push({ name, pass, detail })
  }
  /* ★ 结构判据：**调用**它，而不是搜字 */
  push(
    '结构：报文种类在闭集里',
    BRIDGE_MESSAGE_KINDS.includes('PROACTIVE_OPPORTUNITY'),
    `含=${String(BRIDGE_MESSAGE_KINDS.includes('PROACTIVE_OPPORTUNITY'))} 共${String(BRIDGE_MESSAGE_KINDS.length)} 种`
  )
  push(
    '★ 结构：它是**排队**那一档，**不是**控制类（不然 8 秒的机会评估会挡住 CANCEL_TURN）',
    isBridgeControlMessageKind('PROACTIVE_OPPORTUNITY') === false,
    `isBridgeControlMessageKind=${String(isBridgeControlMessageKind('PROACTIVE_OPPORTUNITY'))}`
  )
  push(
    '结构（正控）：其它四条仍在控制类里（没有把分类改坏）',
    isBridgeControlMessageKind('PREPARE_TURN') === true &&
      isBridgeControlMessageKind('REPORT_QQ_DELIVERY') === true &&
      isBridgeControlMessageKind('CANCEL_TURN') === true &&
      isBridgeControlMessageKind('SUBMIT_TURN') === false,
    'PREPARE/QQ回执/CANCEL 在；SUBMIT 不在'
  )
  push(
    '结构：`proactive_opening` 在**非紧急**来源闭集里（D07 让位的前提）',
    (NON_URGENT_CHARACTER_OUTPUT_SOURCES as readonly string[]).includes('proactive_opening'),
    [...NON_URGENT_CHARACTER_OUTPUT_SOURCES].join(',')
  )
  push(
    '结构：出站来源闭集是 4 项（没有把声明漏掉）',
    (['wake_response', 'mid_turn_correction', 'authorized_lookup_notice', 'proactive_opening'] as const).every((s) =>
      NON_URGENT_CHARACTER_OUTPUT_SOURCES.length > 0 && s.length > 0
    ),
    '四项都非空'
  )
  push('不变量：15 条具名码互不相同且非空', (() => {
    try {
      assertOpeningRefusalCodesWellFormed()
      return true
    } catch {
      return false
    }
  })(), `码数=${String(OPENING_REFUSAL_CODES.length)} 去重后=${String(new Set(OPENING_REFUSAL_CODES).size)}`)

  /* ⚠️ 以下三条是**窄范围文本判据**（无法 import：`main.ts` 的内联端口 / Python 外壳）。
     它们**只**锚一个很有辨识度的结构片段，不做全文按词找（`L-QQP-09` 的教训）。 */
  const mainTs = readRepoFile('src/main.ts')
  /* ★ 结构判据：把这个**解析器** import 进来**调用它**（不是搜字） */
  push(
    '★ 结构：开关 `CHARACTER_AVATAR_OPENING_MODE` 被正确解析（缺省 off · 三档 · **非法回落 off**）',
    readKernelFlags({}).avatarOpeningMode === 'off' &&
      readKernelFlags({ CHARACTER_AVATAR_OPENING_MODE: 'on' }).avatarOpeningMode === 'on' &&
      readKernelFlags({ CHARACTER_AVATAR_OPENING_MODE: 'shadow' }).avatarOpeningMode === 'shadow' &&
      readKernelFlags({ CHARACTER_AVATAR_OPENING_MODE: 'bogus' }).avatarOpeningMode === 'off',
    'off / on / shadow / 非法⇒off'
  )
  push(
    '文本（窄）：`main.ts` **真的消费**了开关（不是"加了开关没接线"）',
    mainTs.includes('readKernelFlags().avatarOpeningMode') && mainTs.includes('opening_shadow_no_emit'),
    '锚模式读取 + shadow 具名码'
  )
  push(
    '文本（窄）：`main.ts` 装了端口本体',
    mainTs.includes('host.openingOpportunity = async'),
    '锚 `host.openingOpportunity = async`'
  )
  const transportTs = readRepoFile('src/infrastructure/bridge/turn-bridge-transport.ts')
  push(
    '文本（窄）：transport 有注入线',
    transportTs.includes('if (options.openingOpportunity !== undefined) host.openingOpportunity'),
    '锚注入行'
  )
  const runtimePy = readRepoFile('scripts/postlv2_vtuber_runtime.py')
  push(
    '文本（窄）：外壳有**唯一的**上报函数 + 空闲上报器（裁定 C 的两半）',
    runtimePy.includes('async def report_opportunity():') &&
      runtimePy.includes('def start_idle_reporter():') &&
      runtimePy.includes('start_idle_reporter()'),
    '三处都在'
  )
  push(
    '文本（窄）：外壳把 `proactive_speak` **改走机会报文**（不再 `raise`）',
    runtimePy.includes('await self._report_opportunity()') && !/proactive_speak"\):\n\s+raise ValueError/u.test(runtimePy),
    '改走 + 原 raise 已不在那条分支'
  )
  push(
    '文本（窄）：诊断面暴露机会读数（`/lg/status` + `/lg/opportunity`）',
    runtimePy.includes('"opportunity": {') && runtimePy.includes('@router.post("/lg/opportunity")'),
    '两处都在'
  )
  return rows
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const sections: SectionResult[] = []
sections.push(await threePhase('§1 机会预检（15 条具名拒绝 + 顺序 + 幂等）', precheckCollect))
sections.push(await threePhase('§2 生成侧（提示词 / 解析 / 候选 / 信封）', generatorCollect))
sections.push(await threePhase('§3 编排（调用计数 / 守卫 / 双次复核 / 仲裁）', runnerCollect))
sections.push(await threePhase('§4 机会状态（时界 / 额度 / 幂等 / 局限实测）', stateCollect))

const wiring = wiringCollect()
const wiringFailed = wiring.filter((row) => !row.pass).length

process.stdout.write('\n=== ADR-131 离线门：皮套入口的系统发起开口 ===\n')
let measured = 0
for (const section of sections) {
  for (const line of section.lines) process.stdout.write(line + '\n')
  measured += section.measured
}
process.stdout.write('\n—— §5 接线（结构判据优先）——\n')
for (const row of wiring) process.stdout.write(`  ${row.pass ? '✅' : '❌'} ${row.name}  ${row.detail}\n`)
measured += wiring.length

const totalFailed = sections.reduce((sum, section) => sum + section.failed, 0) + wiringFailed
const mangleOk = sections.every((section) => section.mangleFailed > 0)
const measuredOk = measured > 0

process.stdout.write(`\n  量具有效性：四段都能报红 = ${String(mangleOk)}  ${mangleOk ? '✅' : '❌'}\n`)
process.stdout.write(`  measured_count = ${String(measured)}\n`)
process.stdout.write(
  `\n  verdict = ${totalFailed === 0 && mangleOk && measuredOk ? 'PASS' : 'FAIL'}` +
    ` · 断言 ${String(measured)} 项 · 失败 ${String(totalFailed)} 项\n\n`
)

process.exitCode = totalFailed === 0 && mangleOk && measuredOk ? 0 : 1
