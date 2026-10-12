/**
 * M8.5 WP9 —— 部件级测试（§16.1 门清单第一件）
 *
 * 覆盖计划 §16.1 指名的六个部件的**纯函数面**（无 DB、无 fetch、无 .env）：
 *   契约纯函数 / 解析器 / 评估器 / worker 纯助手 / reducer / validator 判据面。
 * 场景级（真持久化端口、真 worker 生命周期、真放行口）归各 WP 门与
 * corpus:verify（回放门）——本门是"快而全"的部件底座。
 *
 * 量具纪律（AGENTS.md §6.6/§6.8）：正控/负控/恢复三段式；计数自检
 * measured_count > 0；证据落盘 artifacts/m8.5/<runId>/test.json。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AFFECT_SEMANTIC_CONTEXT_ALIASES,
  AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS,
  AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES,
  AFFECT_SEMANTIC_DEFAULT_MODE,
  AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS,
  AFFECT_SEMANTIC_INPUT_BUDGET_TOKENS,
  AFFECT_SEMANTIC_MAX_AGE_MS,
  AFFECT_SEMANTIC_MAX_ATTEMPTS,
  AFFECT_SEMANTIC_MAX_CANDIDATES,
  AFFECT_SEMANTIC_MAX_CONTEXT_REFS,
  AFFECT_SEMANTIC_MAX_TOKENS,
  AFFECT_SEMANTIC_MODES,
  AFFECT_SEMANTIC_REASON_TABLE,
  AFFECT_SEMANTIC_RESPONSE_CAP_UNITS,
  AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS,
  AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS,
  AFFECT_SEMANTIC_SCAN_BATCH_SIZE,
  AFFECT_SEMANTIC_TASK_TERMINAL_STATES,
  AFFECT_SEMANTIC_TIMEOUT_MS,
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_FINALIZED_PREFIX,
  AFFECT_SEMANTIC_RECEIPT_VERSION,
  AFFECT_SEMANTIC_TIMING_KINDS,
  affectSemanticFinalizedGateKey,
  affectSemanticImpactIdempotencyOperation,
  encodeAffectSemanticCommittedReceipt,
  encodeAffectSemanticNoImpactReceipt,
  encodeAffectSemanticTerminalReceipt,
  isAffectSemanticDecision,
  isAffectSemanticInputFingerprint,
  isAffectSemanticMode,
  isAffectSemanticReasonCode,
  isAffectSemanticTaskTerminal,
  isValidAffectSemanticSpan,
  type AffectSemanticContextMessage,
  type AffectSemanticSpan,
} from '../src/kernel/contracts/affect-semantic.ts'
import {
  assembleSemanticContextWindow,
  buildSemanticOutbound,
  evaluateSemanticResponse,
  mapSemanticJudgment,
  parseSemanticJudgment,
  type SemanticModelResponseEnvelope,
} from '../src/kernel/app/affect/semantic-evaluator.ts'
import { AFFECT_SEMANTIC_INSTRUCTION_VERSION } from '../src/kernel/app/affect/semantic-instruction.ts'
import { AFFECT_SEMANTIC_TASK_KEY_PREFIX, affectSemanticTaskIdempotencyKey } from '../src/kernel/app/affect/semantic-worker.ts'
import { AFFECT_RULE_DELTAS } from '../src/kernel/app/affect/patterns.ts'
import { reduceAffectState, reduceAffectStateV2 } from '../src/kernel/projections/affect.ts'
import { decayAffectBetween, type AffectState } from '../src/kernel/contracts/affect.ts'
import { AFFECT_IMPACT, AFFECT_ORIGIN, AFFECT_TOUCH } from '../src/kernel/contracts/domain-event.ts'
import type { DomainEvent } from '../src/kernel/contracts/index.ts'
import type { ConversationEvent } from '../src/kernel/contracts/conversation-event.ts'

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

type Phase = 'static' | 'positive' | 'negative' | 'recovery'
const results: Array<{ phase: Phase; id: string; label: string; expected: string; actual: string; pass: boolean }> = []
let measured = 0

function check(phase: Phase, id: string, label: string, expected: string, actual: string, pass: boolean): void {
  measured += 1
  results.push({ phase, id, label, expected, actual, pass })
  if (!pass) console.log(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
}

function checkTrue(phase: Phase, id: string, label: string, value: boolean): void {
  check(phase, id, label, 'true', String(value), value === true)
}

function checkEqual<T>(phase: Phase, id: string, label: string, expected: T, actual: T): void {
  check(phase, id, label, JSON.stringify(expected), JSON.stringify(actual), Object.is(expected, actual))
}

// ---------------------------------------------------------------------------
// S 段：冻结常量锁（Contract-Freeze 的机器面）
// ---------------------------------------------------------------------------

checkEqual('static', 'S1', '单次调用超时 = 20,000ms', 20_000, AFFECT_SEMANTIC_TIMEOUT_MS)
checkEqual('static', 'S2', '输出 max_tokens = 5,000（WP10 用户裁定：3,000→5,000，ADR-068 R-5）', 5_000, AFFECT_SEMANTIC_MAX_TOKENS)
checkEqual('static', 'S3', '输入预算 = 3,000 token（估算面）', 3_000, AFFECT_SEMANTIC_INPUT_BUDGET_TOKENS)
checkEqual('static', 'S4', '输入字符守卫 = 6,000 UTF-16 units', 6_000, AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS)
checkEqual('static', 'S5', '尝试上限 = 2（含首次）', 2, AFFECT_SEMANTIC_MAX_ATTEMPTS)
checkEqual('static', 'S6', '重试最短间隔 = 2,000ms', 2_000, AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS)
checkEqual('static', 'S7', 'Retry-After 封顶 = 60,000ms', 60_000, AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS)
checkEqual('static', 'S8', '最大影响时龄 = 120,000ms', 120_000, AFFECT_SEMANTIC_MAX_AGE_MS)
checkEqual('static', 'S9', '扫描批量 = 32', 32, AFFECT_SEMANTIC_SCAN_BATCH_SIZE)
checkEqual('static', 'S10', '上下文上限 = 6 条', 6, AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES)
checkEqual('static', 'S11', '上下文回溯 = 30 分钟', 30 * 60 * 1000, AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS)
checkEqual('static', 'S12', '响应体硬上限 = 16,384 units', 16_384, AFFECT_SEMANTIC_RESPONSE_CAP_UNITS)
checkEqual('static', 'S13', '候选上限 = 3', 3, AFFECT_SEMANTIC_MAX_CANDIDATES)
checkEqual('static', 'S14', 'contextRefs 上限 = 6', 6, AFFECT_SEMANTIC_MAX_CONTEXT_REFS)
checkEqual('static', 'S15', '三模式闭集 + 缺省 rules（M85-D03/D22）',
  JSON.stringify(['rules', 'shadow', 'semantic']), JSON.stringify([...AFFECT_SEMANTIC_MODES]))
checkEqual('static', 'S16', '缺省模式 = rules', 'rules', AFFECT_SEMANTIC_DEFAULT_MODE)
checkTrue('static', 'S17', '模式谓词：合法值放行、垃圾拒绝',
  isAffectSemanticMode('semantic') && isAffectSemanticMode('rules') && isAffectSemanticMode('shadow') &&
  !isAffectSemanticMode('canary') && !isAffectSemanticMode(''))
checkEqual('static', 'S18', '策略版本 = affect-semantic-policy@1（独立于 affect-rules@1）',
  'affect-semantic-policy@1', AFFECT_SEMANTIC_POLICY_VERSION)
checkEqual('static', 'S19', '回执版本 = affect-semantic@1', 'affect-semantic@1', AFFECT_SEMANTIC_RECEIPT_VERSION)
checkEqual('static', 'S20', '时间形状闭集 = [SOURCE_ANCHORED]',
  JSON.stringify(['SOURCE_ANCHORED']), JSON.stringify([...AFFECT_SEMANTIC_TIMING_KINDS]))
checkTrue('static', 'S21', '指令版本带 @5 后缀（@2/@5 机械格式；@3/@4 边界校准；指纹链的根）', AFFECT_SEMANTIC_INSTRUCTION_VERSION.endsWith('@5'))
checkEqual('static', 'S22', '任务终态集 = 6 态（可审计终态——M85-D17）',
  6, AFFECT_SEMANTIC_TASK_TERMINAL_STATES.length)
checkTrue('static', 'S23', '终态谓词：终态放行、非终态拒绝',
  AFFECT_SEMANTIC_TASK_TERMINAL_STATES.every((state) => isAffectSemanticTaskTerminal(state)) &&
  !isAffectSemanticTaskTerminal('DISCOVERED') && !isAffectSemanticTaskTerminal('EVALUATING'))

// ---------------------------------------------------------------------------
// C 段：契约纯函数
// ---------------------------------------------------------------------------

// —— span 协议（M85-D12：UTF-16 半开区间，不跨 surrogate）——
const SPAN_MSG = '谢谢你𝄞陪我。' // 𝄞 = U+1D11E（代理对，占 2 code units）
checkTrue('positive', 'C1', 'span：合法半开区间通过',
  isValidAffectSemanticSpan({ start: 0, end: 3 } as AffectSemanticSpan, SPAN_MSG))
checkTrue('negative', 'C2', 'span：end ≤ start 拒（空片段）',
  !isValidAffectSemanticSpan({ start: 2, end: 2 } as AffectSemanticSpan, SPAN_MSG))
checkTrue('negative', 'C3', 'span：越界拒（end > length）',
  !isValidAffectSemanticSpan({ start: 0, end: 99 } as AffectSemanticSpan, SPAN_MSG))
checkTrue('negative', 'C4', 'span：负起点拒',
  !isValidAffectSemanticSpan({ start: -1, end: 2 } as AffectSemanticSpan, SPAN_MSG))
checkTrue('negative', 'C5', 'span：从代理对中间开始拒（start 落在低位代理项）',
  !isValidAffectSemanticSpan({ start: 4, end: 6 } as AffectSemanticSpan, SPAN_MSG))
checkTrue('negative', 'C6', 'span：在代理对中间结束拒（end−1 落在高位代理项）',
  !isValidAffectSemanticSpan({ start: 3, end: 4 } as AffectSemanticSpan, SPAN_MSG))
checkTrue('positive', 'C7', 'span：完整覆盖代理对通过',
  isValidAffectSemanticSpan({ start: 3, end: 5 } as AffectSemanticSpan, SPAN_MSG))

// —— reasonCode 闭集词表（规格 §4：19 词；IMPACT 码带族、其余不带）——
checkEqual('positive', 'C8', 'reasonCode 词表 = 19 词（规格 §4 冻结）', 19, AFFECT_SEMANTIC_REASON_TABLE.length)
checkTrue('positive', 'C9', '词表自洽：IMPACT 码都带七族之一；其余码不带族',
  AFFECT_SEMANTIC_REASON_TABLE.every((spec) =>
    spec.decision === 'IMPACT'
      ? typeof spec.family === 'string' && spec.family in AFFECT_RULE_DELTAS
      : spec.family === undefined))
checkTrue('positive', 'C10', '词表自洽：每个 IMPACT 码的族都有冻结增量（映射面可达）',
  AFFECT_SEMANTIC_REASON_TABLE
    .filter((spec) => spec.decision === 'IMPACT')
    .every((spec) => AFFECT_RULE_DELTAS[spec.family as keyof typeof AFFECT_RULE_DELTAS] !== undefined))
checkTrue('negative', 'C11', '词表谓词：未知词拒绝（不静默收编）',
  !isAffectSemanticReasonCode('VERY_GRATEFUL') && !isAffectSemanticReasonCode(''))
checkTrue('positive', 'C12', '判定闭集谓词：四判定放行、其余拒绝',
  isAffectSemanticDecision('IMPACT') && isAffectSemanticDecision('NEUTRAL') &&
  isAffectSemanticDecision('UNCERTAIN') && isAffectSemanticDecision('OUT_OF_SCOPE') &&
  !isAffectSemanticDecision('FAILED') && !isAffectSemanticDecision('INELIGIBLE'))

// —— 回执编码（跨版本单次影响的持久面——M85-D20）——
const FP = '0123456789abcdef'
checkTrue('positive', 'C13', 'COMMITTED 回执：族 + 16hex 指纹',
  /^affect-semantic@1\|COMMITTED\|A-GRATITUDE\|fp=[0-9a-f]{16}$/.test(
    encodeAffectSemanticCommittedReceipt('A-GRATITUDE', FP)))
checkTrue('positive', 'C14', 'NO_IMPACT 回执：判定 + 指纹（NEUTRAL/UNCERTAIN/OUT_OF_SCOPE 三形）',
  encodeAffectSemanticNoImpactReceipt('NEUTRAL', FP) === 'affect-semantic@1|NO_IMPACT|NEUTRAL|fp=0123456789abcdef' &&
  encodeAffectSemanticNoImpactReceipt('UNCERTAIN', FP).includes('|UNCERTAIN|') &&
  encodeAffectSemanticNoImpactReceipt('OUT_OF_SCOPE', FP).includes('|OUT_OF_SCOPE|'))
checkEqual('positive', 'C15', '终态回执：无族无指纹（TERMINAL_FAILED）',
  'affect-semantic@1|TERMINAL_FAILED', encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'))
checkTrue('positive', 'C16', '指纹谓词：恰 16 hex',
  isAffectSemanticInputFingerprint(FP) && !isAffectSemanticInputFingerprint('xyz') &&
  !isAffectSemanticInputFingerprint('0123456789abcde'))

// —— 键名（终结闸 / 任务行 / 幂等操作——零 DDL 承载面）——
checkTrue('positive', 'C17', '终结闸键：前缀 + sourceEventId',
  affectSemanticFinalizedGateKey('cev-1' as never) === `${AFFECT_SEMANTIC_FINALIZED_PREFIX}cev-1`)
checkTrue('positive', 'C18', '任务键：前缀 + sourceEventId（跨尝试稳定）',
  affectSemanticTaskIdempotencyKey('cev-1' as never) === `${AFFECT_SEMANTIC_TASK_KEY_PREFIX}cev-1`)
checkTrue('positive', 'C19', '语义 IMPACT 幂等操作：affect-semantic-impact:<族>:<sourceEventId>',
  affectSemanticImpactIdempotencyOperation('A-GRATITUDE', 'cev-1' as never) === 'affect-semantic-impact:A-GRATITUDE:cev-1')

// ---------------------------------------------------------------------------
// P 段：解析器（11 失败码逐码可达——wp4 门的紧凑面）
// ---------------------------------------------------------------------------

const BASE_REQUEST = {
  characterAlias: '苏沐薇',
  context: [] as AffectSemanticContextMessage[],
  currentMessage: '谢谢你陪我聊这么久。',
}
const GRATITUDE_BODY =
  '{"decision":"IMPACT","target":"CHARACTER","candidates":[{"family":"A-GRATITUDE","span":{"start":0,"end":3}}],"contextRefs":[],"reasonCode":"DIRECT_APPRECIATION"}'
const NEUTRAL_BODY =
  '{"decision":"NEUTRAL","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"ORDINARY_INTERACTION"}'
const envelopeOf = (content: string | null): SemanticModelResponseEnvelope =>
  ({ content, finishReason: 'stop', hasToolCalls: false })

checkTrue('positive', 'P1', '解析：IMPACT 合法体通过（候选+span+自洽 reasonCode）',
  parseSemanticJudgment(envelopeOf(GRATITUDE_BODY), BASE_REQUEST).ok)
checkTrue('positive', 'P2', '解析：NEUTRAL 合法体通过（空候选）',
  parseSemanticJudgment(envelopeOf(NEUTRAL_BODY), BASE_REQUEST).ok)
checkTrue('positive', 'P3', '解析：UNCERTAIN/OUT_OF_SCOPE 合法体通过',
  parseSemanticJudgment(envelopeOf(
    '{"decision":"UNCERTAIN","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"INSUFFICIENT_CONTEXT"}'
  ), BASE_REQUEST).ok &&
  parseSemanticJudgment(envelopeOf(
    '{"decision":"OUT_OF_SCOPE","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"META_INSTRUCTION"}'
  ), BASE_REQUEST).ok)

const parseFailureOf = (envelope: SemanticModelResponseEnvelope, body?: string): string | undefined => {
  const result = parseSemanticJudgment(envelope, BASE_REQUEST)
  return result.ok ? undefined : result.failure
}
checkEqual('negative', 'P4', '失败码 tool_calls 可达（不读正文）',
  'tool_calls', parseFailureOf({ content: GRATITUDE_BODY, finishReason: 'stop', hasToolCalls: true }))
checkEqual('negative', 'P5', '失败码 refusal 可达（content_filter）',
  'refusal', parseFailureOf({ content: GRATITUDE_BODY, finishReason: 'content_filter', hasToolCalls: false }))
checkEqual('negative', 'P6', '失败码 refusal 可达（message.refusal 在场）',
  'refusal', parseFailureOf({ content: GRATITUDE_BODY, finishReason: 'stop', hasToolCalls: false, refusalPresent: true }))
checkEqual('negative', 'P7', '失败码 truncated 可达（finish=length）',
  'truncated', parseFailureOf({ content: GRATITUDE_BODY, finishReason: 'length', hasToolCalls: false }))
checkEqual('negative', 'P8', '失败码 missing_content 可达（null 正文）',
  'missing_content', parseFailureOf(envelopeOf(null)))
checkEqual('negative', 'P9', '失败码 response_too_large 可达（> 16,384 units）',
  'response_too_large', parseFailureOf(envelopeOf('x'.repeat(AFFECT_SEMANTIC_RESPONSE_CAP_UNITS + 1))))
checkEqual('negative', 'P10', '失败码 json_parse_failed 可达（坏 JSON 不修）',
  'json_parse_failed', parseFailureOf(envelopeOf('这不是JSON')))
checkEqual('negative', 'P11', '失败码 schema_failed 可达（未知字段拒）',
  'schema_failed', parseFailureOf(envelopeOf(
    '{"decision":"NEUTRAL","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"ORDINARY_INTERACTION","confidence":0.9}')))
checkEqual('negative', 'P12', '失败码 decision_candidate_mismatch 可达（IMPACT 空候选）',
  'decision_candidate_mismatch', parseFailureOf(envelopeOf(
    '{"decision":"IMPACT","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"DIRECT_APPRECIATION"}')))
checkEqual('negative', 'P13', '失败码 forged_context_ref 可达（无上下文却引用 m-1）',
  'forged_context_ref', parseFailureOf(envelopeOf(
    '{"decision":"NEUTRAL","target":"CHARACTER","candidates":[],"contextRefs":["m-1"],"reasonCode":"ORDINARY_INTERACTION"}')))
checkEqual('negative', 'P14', '失败码 span_out_of_bounds 可达（end 越界）',
  'span_out_of_bounds', parseFailureOf(envelopeOf(
    '{"decision":"IMPACT","target":"CHARACTER","candidates":[{"family":"A-GRATITUDE","span":{"start":0,"end":999}}],"contextRefs":[],"reasonCode":"DIRECT_APPRECIATION"}')))
// span_splits_surrogate：消息必须真的含代理对（P16）；无代理对的消息拆不出该码
{
  const surrogateRequest = { ...BASE_REQUEST, currentMessage: '𝄞谢谢你' }
  const result = parseSemanticJudgment(envelopeOf(
    '{"decision":"IMPACT","target":"CHARACTER","candidates":[{"family":"A-GRATITUDE","span":{"start":0,"end":1}}],"contextRefs":[],"reasonCode":"DIRECT_APPRECIATION"}'
  ), surrogateRequest)
  checkEqual('negative', 'P15', '失败码 span_splits_surrogate 可达（消息含代理对、span 拆开它）',
    'span_splits_surrogate', result.ok ? 'parsed' : result.failure)
}

// ---------------------------------------------------------------------------
// E 段：评估器（上下文装配 / 出站 / 映射）
// ---------------------------------------------------------------------------

// —— 上下文窗口（§6.1/§6.2：同会话、更早、user/assistant、30min、≤6、m-1 最近）——
const T0 = 1_700_000_000_000
const convEvent = (seq: number, type: string, at: number, text: string): ConversationEvent =>
  ({
    id: `cev-ctx-${String(seq)}`,
    characterId: 'chr-test',
    conversationId: 'conv-a',
    sequence: seq,
    type,
    content: text,
    createdAt: at,
  }) as unknown as ConversationEvent

{
  // sourceAt = T0+60min：回溯窗只收 (T0+30min, T0+60min] 内的事件
  const candidates = [
    convEvent(1, 'user_message', T0 + 20 * 60 * 1000, '超回溯窗的更早话（40min 前）'),
    convEvent(2, 'assistant_message', T0 + 31 * 60 * 1000, '她的回复（29min 前）'),
    convEvent(3, 'tool_result', T0 + 32 * 60 * 1000, '工具事件不进上下文'),
    convEvent(4, 'user_message', T0 + 33 * 60 * 1000, '较近的用户话'),
    convEvent(5, 'user_message', T0 + 45 * 60 * 1000, '最近的用户话'),
  ]
  const window = assembleSemanticContextWindow({
    conversationId: 'conv-a', sourceSequence: 10, sourceAt: T0 + 60 * 60 * 1000, candidates,
  })
  checkEqual('positive', 'E1', '窗口：只收 user/assistant + 30min 内 + 同会话更早（超窗与 tool 被滤）',
    3, window.messages.length)
  checkTrue('positive', 'E2', '窗口：m-1 = 最近（seq5 user）、m-2 = seq4、m-3 = 她的回复（seq2）',
    window.messages[0]?.alias === 'm-1' && window.messages[0]?.role === 'user' &&
    window.messages[1]?.alias === 'm-2' && window.messages[1]?.role === 'user' &&
    window.messages[2]?.alias === 'm-3' && window.messages[2]?.role === 'assistant')
  const otherConv = assembleSemanticContextWindow({
    conversationId: 'conv-b', sourceSequence: 10, sourceAt: T0 + 60 * 60 * 1000, candidates,
  })
  checkEqual('negative', 'E3', '窗口：跨会话不拼接（conv-b 看不到 conv-a 的事件）', 0, otherConv.messages.length)
  const eight = Array.from({ length: 8 }, (_, i) => convEvent(i + 1, 'user_message', T0 + i, `m${String(i)}`))
  const capped = assembleSemanticContextWindow({
    conversationId: 'conv-a', sourceSequence: 100, sourceAt: T0 + 1000, candidates: eight,
  })
  checkEqual('positive', 'E4', '窗口：≤ 6 条封顶（取最近）', 6, capped.messages.length)
  checkTrue('positive', 'E5', '窗口：别名闭集 = m-1..m-6',
    JSON.stringify(['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6']) === JSON.stringify([...AFFECT_SEMANTIC_CONTEXT_ALIASES]))
}

// —— 出站（指纹稳定性 / 字符守卫 / 当前消息永不截断）——
{
  const request = { characterAlias: '苏沐薇', currentMessage: '谢谢你。', context: [] as AffectSemanticContextMessage[] }
  const a = buildSemanticOutbound(request)
  const b = buildSemanticOutbound(request)
  checkTrue('positive', 'E6', '出站：同输入同指纹（确定性）',
    a.ok && b.ok && a.outbound.fingerprint === b.outbound.fingerprint)
  const c = buildSemanticOutbound({ ...request, currentMessage: '多谢你。' })
  checkTrue('positive', 'E7', '出站：消息变 ⇒ 指纹变（重验边界）',
    a.ok && c.ok && a.outbound.fingerprint !== c.outbound.fingerprint)
  checkTrue('positive', 'E8', '出站：文本含指令 + 输入块 + 角色别名',
    a.ok && a.outbound.text.includes('苏沐薇') && a.outbound.text.includes('谢谢你。'))
  const longContext: AffectSemanticContextMessage[] = Array.from({ length: 6 }, (_, i) => ({
    role: 'user', text: 'x'.repeat(1_200), alias: `m-${String(i + 1)}` as AffectSemanticContextMessage['alias'],
  }))
  const dropped = buildSemanticOutbound({ ...request, context: longContext })
  checkTrue('positive', 'E9', '守卫：超限整条移除最旧上下文（计数如实）',
    dropped.ok && dropped.outbound.droppedContextMessages > 0 &&
    dropped.outbound.text.length <= AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS)
  const overflow = buildSemanticOutbound({ ...request, currentMessage: 'x'.repeat(AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS + 1) })
  checkEqual('negative', 'E10', '守卫：当前消息过长 ⇒ input_budget_exceeded（不出站、不截断）',
    'input_budget_exceeded', overflow.ok ? 'built' : overflow.reason)
}

// —— 映射（§5.3 全序取主导 + 固定增量查表；模型无权指定数值）——
{
  const judgmentOf = (body: string) => {
    const parsed = parseSemanticJudgment(envelopeOf(body), {
      ...BASE_REQUEST, currentMessage: '谢谢你，不过你可真行，又忘了。',
    })
    if (!parsed.ok) throw new Error(`fixture 解析失败：${parsed.failure}`)
    return parsed.judgment
  }
  const multi = mapSemanticJudgment(judgmentOf(
    '{"decision":"IMPACT","target":"CHARACTER","candidates":[{"family":"A-GRATITUDE","span":{"start":0,"end":3}},{"family":"A-HOSTILE","span":{"start":4,"end":9}}],"contextRefs":[],"reasonCode":"DIRECT_ATTACK"}'))
  checkEqual('positive', 'E11', '映射：多候选按 M8 全序取主导（HOSTILE > GRATITUDE）',
    'A-HOSTILE', multi.dominantFamily)
  checkTrue('positive', 'E12', '映射：delta = 冻结表精确查表（不是模型给的）',
    multi.delta?.deltaValence === AFFECT_RULE_DELTAS['A-HOSTILE'].deltaValence &&
    multi.delta?.deltaArousal === AFFECT_RULE_DELTAS['A-HOSTILE'].deltaArousal)
  checkEqual('positive', 'E13', '映射：策略版本 = affect-semantic-policy@1',
    AFFECT_SEMANTIC_POLICY_VERSION, multi.policyVersion)
  const neutral = mapSemanticJudgment(judgmentOf(NEUTRAL_BODY))
  checkTrue('positive', 'E14', '映射：非 IMPACT ⇒ 无族无增量（弃权不改轴）',
    neutral.dominantFamily === undefined && neutral.delta === undefined)
  const facade = evaluateSemanticResponse(envelopeOf(GRATITUDE_BODY), BASE_REQUEST)
  checkTrue('positive', 'E15', '门面：判定 + 映射一步到位',
    facade.kind === 'judgment' && facade.mapping.dominantFamily === 'A-GRATITUDE')
  const facadeFail = evaluateSemanticResponse(envelopeOf('坏JSON'), BASE_REQUEST)
  checkEqual('negative', 'E16', '门面：解析失败如实透传（不修不猜）',
    'json_parse_failed', facadeFail.kind === 'parse_failed' ? facadeFail.failure : 'judgment')
}

// ---------------------------------------------------------------------------
// W 段：worker 纯助手（键面；生命周期场景归 wp6/corpus 门）
// ---------------------------------------------------------------------------

checkTrue('positive', 'W1', '任务键与闸键不同前缀（两套持久面不相撞）',
  affectSemanticTaskIdempotencyKey('cev-1' as never) !== affectSemanticFinalizedGateKey('cev-1' as never))
checkTrue('positive', 'W2', '同 source 的键跨调用稳定（幂等基础）',
  affectSemanticTaskIdempotencyKey('cev-1' as never) === affectSemanticTaskIdempotencyKey('cev-1' as never))
checkTrue('negative', 'W3', '不同 source 的键不同（不串台）',
  affectSemanticTaskIdempotencyKey('cev-1' as never) !== affectSemanticTaskIdempotencyKey('cev-2' as never))

// ---------------------------------------------------------------------------
// R 段：reducer（@2 SOURCE_ANCHORED 分支 + A==B + @1 失败关闭）
// ---------------------------------------------------------------------------

const OWNER = 'chr-test' as never
const affectEvent = (type: string, payload: Record<string, unknown>, at: number, seq: number): DomainEvent =>
  ({
    id: `dev-${String(seq)}`,
    type,
    payload: { characterId: OWNER, ...payload },
    createdAt: at,
    sequence: seq,
  }) as unknown as DomainEvent

const ORIGIN_PAYLOAD = {
  initialValence: 0, initialArousal: 0.5, originKind: 'ACTIVATION_BASELINE',
  activationId: 'm8.5-test', cutoverAt: T0, cutoverSequence: 0, policyVersion: 'affect-policy@1',
}
const SEMANTIC_IMPACT_PAYLOAD = {
  sourceEventId: 'cev-src', sourceSequence: 5, ruleId: 'A-GRATITUDE',
  ruleVersion: AFFECT_SEMANTIC_POLICY_VERSION,
  delta: { ...AFFECT_RULE_DELTAS['A-GRATITUDE'] },
  originKind: 'INTERACTION_DERIVED', evaluatorVersion: 'affect-semantic-evaluator@1',
  proposalId: '', timingKind: 'SOURCE_ANCHORED', sourceAt: T0 + 60_000,
}
const KEYWORD_IMPACT_PAYLOAD = {
  sourceEventId: 'cev-src', sourceSequence: 5, ruleId: 'A-GRATITUDE',
  ruleVersion: 'affect-rules@1', matchedPatternId: 'ag-thanks',
  delta: { ...AFFECT_RULE_DELTAS['A-GRATITUDE'] },
  originKind: 'INTERACTION_DERIVED', evaluatorVersion: 'affect-evaluator@1', proposalId: '',
}

const stateAfter = (events: DomainEvent[], version: 1 | 2): AffectState => {
  const fold = version === 1 ? reduceAffectState : reduceAffectStateV2
  let state: AffectState = {
    originated: false, valence: 0, arousal: 0, originKind: 'ACTIVATION_BASELINE',
    lastInteractionAt: null, lastAffectEventAt: null, lastDomainEventId: null, cutoverSequence: null,
  }
  for (const event of events) state = fold(state, event, OWNER)
  return state
}

{
  // R1：SOURCE_ANCHORED 折叠——衰减结算到 sourceAt、增量应用、交互锚不动、锚不后退
  const origin = affectEvent(AFFECT_ORIGIN, ORIGIN_PAYLOAD, T0, 1)
  const touch = affectEvent(AFFECT_TOUCH, { sourceEventId: 'cev-src', sourceSequence: 5 }, T0 + 10_000, 2)
  const semantic = affectEvent(AFFECT_IMPACT, SEMANTIC_IMPACT_PAYLOAD, T0 + 90_000, 3)
  const base = stateAfter([origin, touch], 2)
  const folded = stateAfter([origin, touch, semantic], 2)
  const decayed = decayAffectBetween(base, Number(base.lastAffectEventAt), SEMANTIC_IMPACT_PAYLOAD.sourceAt as never)
  checkEqual('positive', 'R1a', '@2 语义 IMPACT：valence = 衰减到 sourceAt + 精确增量',
    decayed.valence + AFFECT_RULE_DELTAS['A-GRATITUDE'].deltaValence, folded.valence)
  checkEqual('positive', 'R1b', '@2 语义 IMPACT：arousal = 衰减到 sourceAt + 精确增量',
    decayed.arousal + AFFECT_RULE_DELTAS['A-GRATITUDE'].deltaArousal, folded.arousal)
  checkEqual('positive', 'R1c', '@2 语义 IMPACT：lastInteractionAt 不推进（M85-D19 慢路径不误刷新互动）',
    base.lastInteractionAt, folded.lastInteractionAt)
  checkEqual('positive', 'R1d', '@2 语义 IMPACT：情绪轴锚 = sourceAt（衰减从来源时刻重新起算）',
    SEMANTIC_IMPACT_PAYLOAD.sourceAt, Number(folded.lastAffectEventAt))

  // R2：锚不后退——晚到的更早来源不"反衰减"
  const earlier = affectEvent(AFFECT_IMPACT, { ...SEMANTIC_IMPACT_PAYLOAD, sourceAt: T0 + 5_000 }, T0 + 120_000, 4)
  const anchored = stateAfter([origin, touch, semantic, earlier], 2)
  checkEqual('positive', 'R2', '@2 锚不后退：sourceAt 早于旧锚 ⇒ 锚保持（max 语义）',
    SEMANTIC_IMPACT_PAYLOAD.sourceAt, Number(anchored.lastAffectEventAt))

  // R3：@1 失败关闭——语义负载命中 @1 折叠 = 硬错误（不静默错折）
  let threwCode = ''
  let threwMessage = ''
  try {
    stateAfter([origin, touch, semantic], 1)
  } catch (error) {
    threwCode = String((error as { code?: string }).code ?? '')
    threwMessage = error instanceof Error ? error.message : String(error)
  }
  checkTrue('negative', 'R3', '@1 折叠语义负载 ⇒ 硬错误（code=affect_semantic_payload_requires_reducer_v2）',
    threwCode === 'affect_semantic_payload_requires_reducer_v2' && threwMessage.includes('affect-reducer@2'))

  // R4：A==B——历史事件（ORIGIN/TOUCH/词形 IMPACT）@1 与 @2 折叠逐字段一致
  const keyword = affectEvent(AFFECT_IMPACT, KEYWORD_IMPACT_PAYLOAD, T0 + 30_000, 3)
  const v1 = stateAfter([origin, touch, keyword], 1)
  const v2 = stateAfter([origin, touch, keyword], 2)
  checkTrue('recovery', 'R4', 'A==B：无语义负载的事件流 @1/@2 折叠逐字一致（混合重放的机器基础）',
    JSON.stringify(v1) === JSON.stringify(v2))

  // R5：词形 IMPACT 在 @2 下保留 M8 语义（双锚推进到事件时刻——不因 @2 改历史行为）
  const v2Keyword = stateAfter([origin, touch, keyword], 2)
  checkEqual('recovery', 'R5', '@2 词形 IMPACT：双锚推进到 createdAt（M8 语义原样）',
    T0 + 30_000, Number(v2Keyword.lastInteractionAt))
  checkEqual('recovery', 'R5b', '@2 词形 IMPACT：情绪轴锚 = createdAt',
    T0 + 30_000, Number(v2Keyword.lastAffectEventAt))

  // R6：TOUCH 只推进交互锚（两版一致）
  const touched1 = stateAfter([origin, touch], 1)
  const touched2 = stateAfter([origin, touch], 2)
  checkTrue('recovery', 'R6', 'TOUCH：只推进交互锚、不改轴（@1/@2 一致）',
    Number(touched1.lastInteractionAt) === T0 + 10_000 && JSON.stringify(touched1) === JSON.stringify(touched2))
}

// ---------------------------------------------------------------------------
// 收口：measured_count 自检 + 证据落盘
// ---------------------------------------------------------------------------

const passCount = results.filter((r) => r.pass).length
const failCount = results.length - passCount
const phaseCounts: Record<Phase, number> = { static: 0, positive: 0, negative: 0, recovery: 0 }
for (const r of results) phaseCounts[r.phase] += 1
const phasesNonEmpty =
  phaseCounts.static > 0 && phaseCounts.positive > 0 && phaseCounts.negative > 0 && phaseCounts.recovery > 0
const measuredValid = measured > 0 && measured === results.length

const runId = `test-${new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 17)}`
const outDir = join(process.cwd(), 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const evidence = {
  gate: 'm8.5:test',
  verdict: failCount === 0 && phasesNonEmpty && measuredValid ? 'PASS' : 'FAIL',
  measured_count: measured,
  pass: passCount,
  fail: failCount,
  phases: phaseCounts,
  self_check: phasesNonEmpty && measuredValid ? 'OK（四段均非空 + 计数自洽）' : 'INVALID',
  results: results.map((r) => ({ ...r, pass: r.pass ? 1 : 0 })),
}
writeFileSync(join(outDir, 'test.json'), JSON.stringify(evidence, null, 2), 'utf8')

console.log('========================================================================')
console.log(`M8.5 部件测试：${failCount === 0 && phasesNonEmpty && measuredValid ? 'PASS' : 'FAIL'}（${passCount}/${String(results.length)}）`)
console.log(`  static: ${String(phaseCounts.static)} · positive: ${String(phaseCounts.positive)} · negative: ${String(phaseCounts.negative)} · recovery: ${String(phaseCounts.recovery)}`)
console.log(`  证据：${join('artifacts', 'm8.5', runId, 'test.json')}`)
console.log('========================================================================')
if (failCount > 0 || !phasesNonEmpty || !measuredValid) process.exit(1)
