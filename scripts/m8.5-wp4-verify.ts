/**
 * M8.5 WP4 —— **语义评估器门**（`pnpm m8.5:wp4:verify`）。
 *
 * 要测的命题（计划 §15 WP4 出口：评估器纯函数层 detached 可验）：
 * ① 指令 v1：版本冻结 / 关键段落齐备 / 指纹稳定且随文本变化（策略身份链）。
 * ② 上下文装配：资格过滤（同会话 / 序号早于 source / user+assistant / 30 分钟回溯）
 *    + ≤6 条 + 别名 m-1..m-6（最近 = m-1）。
 * ③ 出站构造：形状 / 确定性 / 字符守卫（整条移除最旧上下文；当前消息永不截断；
 *    零上下文仍超限 ⇒ input_budget_exceeded）。
 * ④ 严格解析：11 个失败码**逐码可达**（负控逐个注入）+ 合法判定通过（正控）+
 *    负控之后重新安静（恢复）。失败归因顺序与 Contract-Freeze §10 一致。
 * ⑤ 程序映射：§5.3 全序裁定 + AFFECT_RULE_DELTAS 固定增量 + 独立策略版本。
 *
 * 量具纪律：§6.7 三段式；§6.8 measured_count > 0（四段各自非空）；
 * 纯函数门——不打开任何数据库、不出站、不调模型。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  AFFECT_SEMANTIC_CONTEXT_ALIASES,
  AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS,
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_RESPONSE_CAP_UNITS,
  isAffectSemanticInputFingerprint,
  type AffectSemanticContextMessage,
  type AffectSemanticEvaluationRequest,
  type AffectSemanticJudgment,
  type AffectSemanticParseFailureCode,
} from '../src/kernel/contracts/index.ts'
import type { AffectRuleFamily } from '../src/kernel/contracts/affect.ts'
import type { ConversationEvent } from '../src/kernel/contracts/conversation-event.ts'
import {
  AFFECT_RULE_DELTAS,
  AFFECT_RULE_PRIORITY,
} from '../src/kernel/app/affect/patterns.ts'
import {
  AFFECT_SEMANTIC_INSTRUCTION,
  AFFECT_SEMANTIC_INSTRUCTION_VERSION,
  affectSemanticInstructionFingerprint,
} from '../src/kernel/app/affect/semantic-instruction.ts'
import {
  assembleSemanticContextWindow,
  buildSemanticOutbound,
  evaluateSemanticResponse,
  mapSemanticJudgment,
  parseSemanticJudgment,
  type SemanticModelResponseEnvelope,
} from '../src/kernel/app/affect/semantic-evaluator.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 量具（与 m8.5-wp3-contracts 同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
const phaseCounts = { static: 0, positive: 0, negative: 0, recovery: 0 } as Record<string, number>

function check(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ id, label, expected, actual, pass })
  phaseCounts[phase] += 1
  if (!pass) console.error(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
}

function checkEqual(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  check(phase, id, label, JSON.stringify(expected), JSON.stringify(actual),
    JSON.stringify(expected) === JSON.stringify(actual))
}

function checkTrue(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  value: boolean,
): void {
  check(phase, id, label, 'true', String(value), value === true)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface FakeEvent {
  conversationId?: string
  sequence: number
  type?: 'user_message' | 'assistant_message' | 'tool_event' | 'system_event'
  content: string
  /** 距 source 的分钟数（正 = 过去） */
  minutesBeforeSource?: number
}

function fakeEvent(spec: FakeEvent): ConversationEvent {
  return {
    conversationId: spec.conversationId ?? 'dm-test',
    sequence: spec.sequence,
    type: spec.type ?? 'user_message',
    content: spec.content,
    createdAt: (SOURCE_AT - (spec.minutesBeforeSource ?? 1) * 60_000) as never,
  } as unknown as ConversationEvent
}

const SOURCE_AT = 1_800_000_000_000
const SOURCE = { conversationId: 'dm-test', sourceSequence: 100, sourceAt: SOURCE_AT }

function ctx(role: 'user' | 'assistant', text: string, alias: string): AffectSemanticContextMessage {
  return { role, text, alias } as AffectSemanticContextMessage
}

const REQ_WITH_CTX: AffectSemanticEvaluationRequest = {
  characterAlias: '沐薇',
  currentMessage: '这回要是没有你，我真不知道怎么收场。',
  context: [
    ctx('user', '帮我看看这段代码哪里错了', 'm-3'),
    ctx('assistant', '我看了一下，问题出在边界条件。', 'm-2'),
    ctx('user', '改好了，能跑了', 'm-1'),
  ],
}

function envelope(content: string | null, extra?: Partial<SemanticModelResponseEnvelope>): SemanticModelResponseEnvelope {
  return { content, finishReason: 'stop', hasToolCalls: false, ...extra }
}

function judgmentJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    decision: 'IMPACT',
    target: 'CHARACTER',
    candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 6 } }],
    contextRefs: ['m-1'],
    reasonCode: 'DIRECT_APPRECIATION',
    ...overrides,
  })
}

function expectParseFailure(
  phase: 'negative' | 'positive',
  id: string,
  label: string,
  envelope: SemanticModelResponseEnvelope,
  request: AffectSemanticEvaluationRequest,
  failure: AffectSemanticParseFailureCode,
): void {
  const result = parseSemanticJudgment(envelope, request)
  checkTrue(phase, id, label, !result.ok && result.failure === failure)
}

// ===========================================================================
// ① 静态：依赖方向 + 指令冻结
// ===========================================================================

for (const file of ['semantic-instruction.ts', 'semantic-evaluator.ts']) {
  const text = readFileSync(join(REPO_ROOT, 'src/kernel/app/affect', file), 'utf8')
  const importLines = text.split('\n').filter((l) => l.trim().startsWith('import')).join('\n')
  const forbidden = ['@elizaos', 'drizzle', 'node:fs', 'node:path', 'node:child_process', 'phoenix', 'opentelemetry', 'infrastructure']
  const hits = forbidden.filter((f) => importLines.includes(f))
  checkEqual('static', `S1-${file}`, `${file} 依赖方向干净`, [], hits)
}

checkEqual('static', 'S2', '指令版本冻结（@2/@5 机械格式；@3/@4 边界校准；ADR-068 §7）', 'affect-semantic-instruction@5', AFFECT_SEMANTIC_INSTRUCTION_VERSION)
for (const section of ['【判定】', '【七族】', '【立场先行】', '【上下文】', '【免疫】', '【输出】']) {
  checkTrue('static', 'S3', `指令含关键段落 ${section}`, AFFECT_SEMANTIC_INSTRUCTION.includes(section))
}
checkTrue('static', 'S4', '指令不含真实身份/路径/召回词',
  !AFFECT_SEMANTIC_INSTRUCTION.includes('userId') &&
  !AFFECT_SEMANTIC_INSTRUCTION.includes('traceId') &&
  !AFFECT_SEMANTIC_INSTRUCTION.includes('pglite') &&
  !AFFECT_SEMANTIC_INSTRUCTION.includes('苏沐薇'))

const fp1 = affectSemanticInstructionFingerprint()
const fp2 = affectSemanticInstructionFingerprint()
checkTrue('static', 'S5', '指令指纹稳定', fp1 === fp2)
checkTrue('static', 'S6', '指令指纹形状 = 16 位小写 hex', isAffectSemanticInputFingerprint(fp1))

// ===========================================================================
// ② 上下文装配（正控）
// ===========================================================================

const window6 = assembleSemanticContextWindow({
  ...SOURCE,
  candidates: Array.from({ length: 9 }, (_, i) =>
    fakeEvent({ sequence: 91 + i, content: `消息${i}`, minutesBeforeSource: 1 })),
})
checkEqual('positive', 'A1', '9 条候选只取最近 6 条', 6, window6.messages.length)
checkEqual('positive', 'A2', '别名：最近 = m-1，最旧 = m-6',
  ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'],
  window6.messages.map((m) => m.alias))
checkEqual('positive', 'A3', '取的是最近 6 条（序号 94..99，内容倒序）',
  ['消息8', '消息7', '消息6', '消息5', '消息4', '消息3'],
  window6.messages.map((m) => m.text))

const windowFilter = assembleSemanticContextWindow({
  ...SOURCE,
  candidates: [
    fakeEvent({ sequence: 50, content: '太旧（31 分钟前）', minutesBeforeSource: 31 }),
    fakeEvent({ sequence: 60, content: '窗口内', minutesBeforeSource: 29 }),
    fakeEvent({ sequence: 70, content: '未来事件', minutesBeforeSource: -5 }),
    fakeEvent({ sequence: 101, content: '序号晚于 source', minutesBeforeSource: 1, conversationId: 'dm-test' }),
    fakeEvent({ sequence: 82, content: '别的会话', minutesBeforeSource: 1, conversationId: 'dm-other' }),
    fakeEvent({ sequence: 84, content: 'tool 事件', minutesBeforeSource: 1, type: 'tool_event' }),
    fakeEvent({ sequence: 86, content: 'assistant 也进上下文', minutesBeforeSource: 1, type: 'assistant_message' }),
  ],
})
// sequence 80 >= 100 排除；84 是别的会话；86 是 tool —— 全排除
checkEqual('positive', 'A4', '资格过滤后只剩 2 条（序号降序：86 在前）',
  ['assistant 也进上下文', '窗口内'], windowFilter.messages.map((m) => m.text))
checkEqual('positive', 'A5', 'assistant 角色标注正确', 'assistant', windowFilter.messages[0].role)

// ===========================================================================
// ③ 出站构造（正控 / 负控 / 恢复）
// ===========================================================================

const out1 = buildSemanticOutbound(REQ_WITH_CTX)
checkTrue('positive', 'O1', '出站 ok', out1.ok)
if (out1.ok) {
  checkTrue('positive', 'O2', '出站含指令 + 别名 + 当前消息 + 上下文行',
    out1.outbound.text.includes(AFFECT_SEMANTIC_INSTRUCTION.slice(0, 20)) &&
    out1.outbound.text.includes('角色别名：沐薇') &&
    out1.outbound.text.includes('这回要是没有你') &&
    out1.outbound.text.includes('[m-1] user: 改好了，能跑了'))
  checkTrue('positive', 'O3', '出站指纹 = 16 位 hex', isAffectSemanticInputFingerprint(out1.outbound.fingerprint))
  checkEqual('positive', 'O4', '未触发守卫截断', 0, out1.outbound.droppedContextMessages)
}
const out1b = buildSemanticOutbound(REQ_WITH_CTX)
checkTrue('positive', 'O5', '出站确定性：两次组装同文同指纹',
  out1.ok && out1b.ok && out1.outbound.text === out1b.outbound.text &&
  out1.outbound.fingerprint === out1b.outbound.fingerprint)

const outNoCtx = buildSemanticOutbound({ characterAlias: '沐薇', currentMessage: '嗯', context: [] })
checkTrue('positive', 'O6', '无上下文时不渲染先前消息段',
  outNoCtx.ok && !outNoCtx.outbound.text.includes('【先前消息】'))

// 负控：守卫触发 —— 6 条长上下文把总量顶过 6,000 units
const longCtx: AffectSemanticContextMessage[] = AFFECT_SEMANTIC_CONTEXT_ALIASES.map((alias, i) =>
  ctx('user', `第${i}条` + '长'.repeat(900), alias) as AffectSemanticContextMessage)
const outGuard = buildSemanticOutbound({ characterAlias: '沐薇', currentMessage: '你好', context: longCtx })
checkTrue('negative', 'O7', '守卫触发：整条移除最旧上下文后放行',
  outGuard.ok && outGuard.outbound.droppedContextMessages > 0)
if (outGuard.ok) {
  checkTrue('negative', 'O8', '放行文本 ≤ 守卫上限', outGuard.outbound.text.length <= AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS)
  checkTrue('negative', 'O9', '移除的是最旧端（m-6/m-5 不在，m-1 在）',
    !outGuard.outbound.text.includes('[m-6]') && outGuard.outbound.text.includes('[m-1]'))
}

// 负控：零上下文仍超限（当前消息过长）⇒ input_budget_exceeded
const outOver = buildSemanticOutbound({ characterAlias: '沐薇', currentMessage: '长'.repeat(5_000), context: [] })
checkTrue('negative', 'O10', '当前消息过长 ⇒ input_budget_exceeded（不出站）',
  !outOver.ok && outOver.reason === 'input_budget_exceeded')

// 恢复：正常请求重新通过
const outRecover = buildSemanticOutbound(REQ_WITH_CTX)
checkTrue('recovery', 'O11', '负控之后正常出站重新通过', outRecover.ok && outRecover.outbound.droppedContextMessages === 0)

// ===========================================================================
// ④ 严格解析（正控 / 负控逐码 / 恢复）
// ===========================================================================

const parsedOk = parseSemanticJudgment(envelope(judgmentJson()), REQ_WITH_CTX)
checkTrue('positive', 'P1', '合法 IMPACT 判定通过', parsedOk.ok)
if (parsedOk.ok) {
  checkEqual('positive', 'P2', '判定字段完整',
    { decision: 'IMPACT', target: 'CHARACTER', candidates: 1, contextRefs: ['m-1'], reasonCode: 'DIRECT_APPRECIATION' },
    { decision: parsedOk.judgment.decision, target: parsedOk.judgment.target, candidates: parsedOk.judgment.candidates.length, contextRefs: parsedOk.judgment.contextRefs, reasonCode: parsedOk.judgment.reasonCode })
}
const parsedNeutral = parseSemanticJudgment(
  envelope(judgmentJson({ decision: 'NEUTRAL', candidates: [], contextRefs: [], reasonCode: 'ORDINARY_INTERACTION' })),
  REQ_WITH_CTX,
)
checkTrue('positive', 'P3', '合法 NEUTRAL（空候选）通过', parsedNeutral.ok)

// —— 负控：11 个失败码逐码可达 ——
expectParseFailure('negative', 'F1', 'tool_calls', envelope(null, { hasToolCalls: true }), REQ_WITH_CTX, 'tool_calls')
expectParseFailure('negative', 'F2', 'refusal（content_filter）', envelope(null, { finishReason: 'content_filter' }), REQ_WITH_CTX, 'refusal')
expectParseFailure('negative', 'F2b', 'refusal（message.refusal 在场，finish=stop）',
  envelope(null, { refusalPresent: true }), REQ_WITH_CTX, 'refusal')
expectParseFailure('negative', 'F3', 'truncated（length）', envelope('{"decision":', { finishReason: 'length' }), REQ_WITH_CTX, 'truncated')
expectParseFailure('negative', 'F4', 'missing_content', envelope(null), REQ_WITH_CTX, 'missing_content')
expectParseFailure('negative', 'F5', 'response_too_large', envelope('x'.repeat(AFFECT_SEMANTIC_RESPONSE_CAP_UNITS + 1)), REQ_WITH_CTX, 'response_too_large')
expectParseFailure('negative', 'F6', 'json_parse_failed', envelope('这不是 JSON'), REQ_WITH_CTX, 'json_parse_failed')
expectParseFailure('negative', 'F7a', 'schema_failed：未知字段 confidence',
  envelope(judgmentJson({ confidence: 0.9 })), REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7b', 'schema_failed：未知 decision',
  envelope(judgmentJson({ decision: 'FAILED' })), REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7c', 'schema_failed：target 不是 CHARACTER',
  envelope(judgmentJson({ target: 'USER' })), REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7d', 'schema_failed：未知 reasonCode',
  envelope(judgmentJson({ reasonCode: 'MADE_UP' })), REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7e', 'schema_failed：reasonCode 与 decision 不匹配',
  envelope(judgmentJson({ decision: 'NEUTRAL', candidates: [], contextRefs: [], reasonCode: 'DIRECT_APPRECIATION' })),
  REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7f', 'schema_failed：候选 4 项超上限',
  envelope(judgmentJson({ candidates: [1, 2, 3, 4].map(() => ({ family: 'A-GRATITUDE', span: { start: 0, end: 1 } })) })),
  REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7g', 'schema_failed：contextRefs 形状不合法（m-999）',
  envelope(judgmentJson({ contextRefs: ['m-999'] })), REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7h', 'schema_failed：候选带未知字段',
  envelope(judgmentJson({ candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 1 }, note: 'x' }] })),
  REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7i', 'schema_failed：家族不在七族',
  envelope(judgmentJson({ candidates: [{ family: 'A-NEUTRAL-TOUCH', span: { start: 0, end: 1 } }] })),
  REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7j', 'schema_failed：span 非整数',
  envelope(judgmentJson({ candidates: [{ family: 'A-GRATITUDE', span: { start: 0.5, end: 2 } }] })),
  REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F7k', 'schema_failed：IMPACT 的 reasonCode 家族不在候选里',
  envelope(judgmentJson({ candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 1 } }], reasonCode: 'DIRECT_ATTACK' })),
  REQ_WITH_CTX, 'schema_failed')
expectParseFailure('negative', 'F8a', 'decision_candidate_mismatch：IMPACT 空候选',
  envelope(judgmentJson({ candidates: [] })), REQ_WITH_CTX, 'decision_candidate_mismatch')
expectParseFailure('negative', 'F8b', 'decision_candidate_mismatch：NEUTRAL 带候选',
  envelope(judgmentJson({ decision: 'NEUTRAL', candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 1 } }], contextRefs: [], reasonCode: 'ORDINARY_INTERACTION' })),
  REQ_WITH_CTX, 'decision_candidate_mismatch')
expectParseFailure('negative', 'F9', 'forged_context_ref：形状合法但未分配（m-5 不在本次请求）',
  envelope(judgmentJson({ contextRefs: ['m-5'] })), REQ_WITH_CTX, 'forged_context_ref')
const reqNoCtx: AffectSemanticEvaluationRequest = { characterAlias: '沐薇', currentMessage: '谢谢', context: [] }
expectParseFailure('negative', 'F9b', 'forged_context_ref：无上下文却引用 m-1',
  envelope(judgmentJson({ contextRefs: ['m-1'], candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 2 } }] })),
  reqNoCtx, 'forged_context_ref')
expectParseFailure('negative', 'F10', 'span_out_of_bounds',
  envelope(judgmentJson({ candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 999 } }] })),
  REQ_WITH_CTX, 'span_out_of_bounds')
const SURROGATE_MSG = '𝒜好呀'
const reqSurrogate: AffectSemanticEvaluationRequest = { characterAlias: '沐薇', currentMessage: SURROGATE_MSG, context: [] }
expectParseFailure('negative', 'F11', 'span_splits_surrogate（起点在代理对中间）',
  envelope(judgmentJson({ candidates: [{ family: 'A-GRATITUDE', span: { start: 1, end: 3 } }], contextRefs: [] })),
  reqSurrogate, 'span_splits_surrogate')

// 恢复：负控风暴之后合法判定重新通过
const parsedRecover = parseSemanticJudgment(envelope(judgmentJson()), REQ_WITH_CTX)
checkTrue('recovery', 'P4', '负控之后解析器重新安静', parsedRecover.ok)

// ===========================================================================
// ⑤ 程序映射（正控）
// ===========================================================================

function judgmentOf(decision: string, families: AffectRuleFamily[]): AffectSemanticJudgment {
  return {
    decision: decision as AffectSemanticJudgment['decision'],
    target: 'CHARACTER',
    candidates: families.map((family) => ({ family, span: { start: 0, end: 1 } })),
    contextRefs: [],
    reasonCode: (decision === 'IMPACT' ? 'DIRECT_APPRECIATION' : 'ORDINARY_INTERACTION') as never,
  }
}

const mapped = mapSemanticJudgment(judgmentOf('IMPACT', ['A-GRATITUDE', 'A-HOSTILE']))
checkEqual('positive', 'M1', '全序：HOSTILE 压过 GRATITUDE', 'A-HOSTILE', mapped.dominantFamily)
checkEqual('positive', 'M2', '固定增量查表（HOSTILE）', { deltaValence: -0.15, deltaArousal: 0.12 }, mapped.delta)
checkEqual('positive', 'M3', '策略版本独立', AFFECT_SEMANTIC_POLICY_VERSION, mapped.policyVersion)

const mappedNeutral = mapSemanticJudgment(judgmentOf('NEUTRAL', []))
checkTrue('positive', 'M4', 'NEUTRAL 无家族无增量',
  mappedNeutral.dominantFamily === undefined && mappedNeutral.delta === undefined)

for (const family of AFFECT_RULE_PRIORITY) {
  const m = mapSemanticJudgment(judgmentOf('IMPACT', [family]))
  checkEqual('positive', `M5-${family}`, `增量逐族对表 ${family}`, AFFECT_RULE_DELTAS[family], m.delta)
}
const mappedDup = mapSemanticJudgment(judgmentOf('IMPACT', ['A-GRATITUDE', 'A-GRATITUDE']))
checkEqual('positive', 'M6', '重复家族候选 → 唯一主导', 'A-GRATITUDE', mappedDup.dominantFamily)

// 门面：解析 + 映射一体
const outcome = evaluateSemanticResponse(envelope(judgmentJson()), REQ_WITH_CTX)
checkTrue('positive', 'M7', '门面产出 judgment + mapping',
  outcome.kind === 'judgment' && outcome.mapping.dominantFamily === 'A-GRATITUDE')
const outcomeFail = evaluateSemanticResponse(envelope('坏 JSON'), REQ_WITH_CTX)
checkTrue('positive', 'M8', '门面传导解析失败',
  outcomeFail.kind === 'parse_failed' && outcomeFail.failure === 'json_parse_failed')

// ===========================================================================
// 汇总 + 量具自检（§6.8）
// ===========================================================================

const allPhasesNonEmpty = Object.values(phaseCounts).every((n) => (n ?? 0) > 0)
const failed = checks.filter((c) => !c.pass)
const verdict = allPhasesNonEmpty && failed.length === 0 ? 'PASS' : 'FAIL'

const result = {
  verdict,
  measured_count: checks.length,
  phaseCounts,
  measuredSelfCheck: allPhasesNonEmpty ? 'OK（四段均非空）' : 'MEASUREMENT INVALID（存在空段）',
  failed: failed.map((c) => ({ id: c.id, label: c.label, expected: c.expected, actual: c.actual })),
  passedCount: checks.length - failed.length,
  checkedAt: new Date().toISOString(),
}

const runId = `wp4-verify-${result.checkedAt.replace(/[-:T.]/g, '').slice(0, 15)}`
const outDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wp4-verify.json')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

console.log(`verdict        : ${verdict}`)
console.log(`measured_count : ${checks.length} (pass ${result.passedCount} / fail ${failed.length})`)
console.log(`phases         : ${JSON.stringify(phaseCounts)}`)
console.log(`self-check     : ${result.measuredSelfCheck}`)
console.log(`evidence       : ${outPath}`)
process.exit(verdict === 'PASS' ? 0 : 1)
