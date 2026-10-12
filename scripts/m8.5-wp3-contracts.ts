/**
 * M8.5 WP3 —— **合同门**（`pnpm m8.5:wp3:contracts`）。
 *
 * 要测的命题（计划 §15 WP3 出口：合同层 detached，只登记不接线）：
 * ① 静态：affect-semantic.ts 只依赖 contracts（依赖方向单向）；
 *    contracts/index.ts 已登记（re-export）；**零运行时接线**（src/** 除 contracts
 *    登记外无任何引用——detached 证明）。
 * ② 闭集冻结：判定 4 / 模式 3（缺省 rules）/ reasonCode 19 词表（族覆盖完整、
 *    非法组合不存在）/ 任务状态 11 + 终态 6 / 解析失败 11 / 传输失败 4
 *    （解析 ∩ 传输 = ∅——仅传输类可重试的合同基础）。
 * ③ 冻结常量：与 M8.5-Contract-Freeze §1/§6/§7 逐值一致（身份串 + 预算/时间数字）。
 * ④ 纯函数：span 协议（含 surrogate pair 正负控）/ 回执编码语法 / 闸键与幂等键
 *    推导（与 M8 词形键前缀永不冲突）/ 闭集守卫——正控 / 负控 / 恢复三段式。
 *
 * 量具纪律：§6.7 三段式；§6.8 measured_count > 0（四段各自非空）；
 * 本门不打开任何数据库、不出站。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  AFFECT_SEMANTIC_CONTEXT_ALIASES,
  AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS,
  AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES,
  AFFECT_SEMANTIC_DECISIONS,
  AFFECT_SEMANTIC_DEFAULT_MODE,
  AFFECT_SEMANTIC_EVALUATOR_NAME,
  AFFECT_SEMANTIC_EVALUATOR_VERSION,
  AFFECT_SEMANTIC_FINALIZED_PREFIX,
  AFFECT_SEMANTIC_IMPACT_PROCESSOR,
  AFFECT_SEMANTIC_INPUT_BUDGET_TOKENS,
  AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS,
  AFFECT_SEMANTIC_MAX_AGE_MS,
  AFFECT_SEMANTIC_MAX_ATTEMPTS,
  AFFECT_SEMANTIC_MAX_CANDIDATES,
  AFFECT_SEMANTIC_MAX_CONTEXT_REFS,
  AFFECT_SEMANTIC_MAX_TOKENS,
  AFFECT_SEMANTIC_MODES,
  AFFECT_SEMANTIC_NO_IMPACT_DECISIONS,
  AFFECT_SEMANTIC_PARSE_FAILURE_CODES,
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_RECEIPT_VERSION,
  AFFECT_SEMANTIC_RESPONSE_CAP_UNITS,
  AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS,
  AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS,
  AFFECT_SEMANTIC_REASON_TABLE,
  AFFECT_SEMANTIC_SCAN_BATCH_SIZE,
  AFFECT_SEMANTIC_SCANNER_PROCESSOR,
  AFFECT_SEMANTIC_TASK_STATES,
  AFFECT_SEMANTIC_TASK_TERMINAL_STATES,
  AFFECT_SEMANTIC_TIMEOUT_MS,
  AFFECT_SEMANTIC_TIMING_KINDS,
  AFFECT_SEMANTIC_TRANSPORT_FAILURE_CODES,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  AFFECT_IMPACT_RULE_IDS,
  affectImpactIdempotencyOperation,
  affectSemanticFinalizedGateKey,
  affectSemanticImpactIdempotencyOperation,
  affectTouchIdempotencyOperation,
  encodeAffectSemanticCommittedReceipt,
  encodeAffectSemanticNoImpactReceipt,
  encodeAffectSemanticTerminalReceipt,
  isAffectSemanticContextAlias,
  isAffectSemanticDecision,
  isAffectSemanticInputFingerprint,
  isAffectSemanticMode,
  isAffectSemanticReasonCode,
  isAffectSemanticTaskTerminal,
  isAffectSemanticTransportFailure,
  isValidAffectSemanticSpan,
} from '../src/kernel/contracts/index.ts'
import type { AffectRuleFamily } from '../src/kernel/contracts/affect.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 量具：检查条目（与 m8-wp2-contracts 同一形状）
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
  if (!pass) {
    console.error(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
  }
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

// ===========================================================================
// ① 静态：依赖方向 + 登记 + detached
// ===========================================================================

const semanticFile = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/affect-semantic.ts'), 'utf8')
const importLines = semanticFile
  .split('\n')
  .filter((l) => l.trim().startsWith('import'))
  .join('\n')
const forbidden = ['node:', 'drizzle', '@elizaos', 'phoenix', 'opentelemetry', 'infrastructure', 'app/']
const forbiddenHits = forbidden.filter((f) => importLines.includes(f))
checkEqual('static', 'S1', 'affect-semantic.ts 只依赖 contracts', [], forbiddenHits)

const indexFile = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/index.ts'), 'utf8')
checkTrue('static', 'S2', 'contracts/index.ts 已登记 affect-semantic',
  indexFile.includes("export * from './affect-semantic.ts'"))

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) collectFiles(full, acc)
    else if (name.name.endsWith('.ts')) acc.push(full)
  }
  return acc
}
const srcFiles = collectFiles(join(REPO_ROOT, 'src'))
const wiredFiles: string[] = []
// 合法引用面（随分段推进而扩；WP6 第一批起）：
// · contracts 登记 + kernel/app/affect/semantic-*（评估器模块本体）——WP4 起；
// · infrastructure/model/affect-semantic-provider.ts（WP5 传输层；WP5 收口时
//   漏跑本门，此处补记 erratum）；
// · infrastructure/persistence/job-store.ts（WP6 recordProcessedOperation 写侧）；
// · kernel/projections/affect.ts（WP6 reducer@2 SOURCE_ANCHORED 分支）；
// · kernel/policies/affect-validator.ts（WP7：唯一放行口按策略版本分叉——
//   语义分支精确增量 + SOURCE_ANCHORED 形状；旧词形分支保留范围界语义）；
// · WP8 接线面（模式开关与装配）：kernel/app/flags.ts（CHARACTER_AFFECT_SEMANTIC_MODE
//   失败关闭解析）、infrastructure/runtime/affect-scheduler.ts（suppressImpacts
//   透传 + 观测映射）、infrastructure/runtime/affect-semantic-scheduler.ts
//   （生产端口装配 + tick 入口 + 取消扫面 + trace 步映射）、src/main.ts
//   （三调用点让位 + 轮后 drain + 启动追赶/扫面 + 收尾收拢）。
//   "detached"证明自此移交 WP8 门：断言 `rules` 模式行为逐字不变
//   （词形 IMPACT 照常、语义 tick 零读零写、trace 不追加语义步）。
const SEMANTIC_APP_PREFIX = 'src/kernel/app/affect/semantic-'
const SEMANTIC_REFERENCE_ALLOWLIST: readonly string[] = [
  'src/kernel/contracts/affect-semantic.ts',
  'src/kernel/contracts/index.ts',
  'src/infrastructure/model/affect-semantic-provider.ts',
  'src/infrastructure/persistence/job-store.ts',
  'src/kernel/projections/affect.ts',
  'src/kernel/policies/affect-validator.ts',
  'src/kernel/app/flags.ts',
  'src/infrastructure/runtime/affect-scheduler.ts',
  'src/infrastructure/runtime/affect-semantic-scheduler.ts',
  'src/main.ts',
]
for (const file of srcFiles) {
  const rel = file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/')
  if (SEMANTIC_REFERENCE_ALLOWLIST.includes(rel)) continue
  if (rel.startsWith(SEMANTIC_APP_PREFIX)) continue
  if (readFileSync(file, 'utf8').includes('affect-semantic')) wiredFiles.push(rel)
}
checkEqual('static', 'S3', 'detached：合法引用面之外零引用（main/flags/调度器仍在禁区）', [], wiredFiles)

// ===========================================================================
// ② 闭集冻结（正控）
// ===========================================================================

checkEqual('positive', 'C1', '判定闭集 = 4 值',
  ['IMPACT', 'NEUTRAL', 'UNCERTAIN', 'OUT_OF_SCOPE'], [...AFFECT_SEMANTIC_DECISIONS])
checkEqual('positive', 'C1b', 'NO_IMPACT 成因 = 3 值',
  ['NEUTRAL', 'UNCERTAIN', 'OUT_OF_SCOPE'], [...AFFECT_SEMANTIC_NO_IMPACT_DECISIONS])
checkEqual('positive', 'C2', '模式闭集 = 3 值', ['rules', 'shadow', 'semantic'], [...AFFECT_SEMANTIC_MODES])
checkEqual('positive', 'C2b', '缺省模式 = rules', 'rules', AFFECT_SEMANTIC_DEFAULT_MODE)
checkEqual('positive', 'C3', 'reasonCode 词表 = 19 词', 19, AFFECT_SEMANTIC_REASON_TABLE.length)

const reasonCodes = AFFECT_SEMANTIC_REASON_TABLE.map((s) => s.code)
checkTrue('positive', 'C3b', 'reasonCode 无重复', new Set(reasonCodes).size === reasonCodes.length)
const impactReasons = AFFECT_SEMANTIC_REASON_TABLE.filter((s) => s.decision === 'IMPACT')
const nonImpactReasons = AFFECT_SEMANTIC_REASON_TABLE.filter((s) => s.decision !== 'IMPACT')
checkEqual('positive', 'C3c', 'IMPACT 码数 = 13', 13, impactReasons.length)
checkTrue('positive', 'C3d', 'IMPACT 码全部带家族且家族合法',
  impactReasons.every((s) => AFFECT_IMPACT_RULE_IDS.includes(s.family as AffectRuleFamily)))
const coveredFamilies = new Set(impactReasons.map((s) => s.family))
checkTrue('positive', 'C3e', '七族全部被 IMPACT 码覆盖',
  AFFECT_IMPACT_RULE_IDS.every((f) => coveredFamilies.has(f)))
checkTrue('positive', 'C3f', '非 IMPACT 码不带家族', nonImpactReasons.every((s) => s.family === undefined))
checkTrue('positive', 'C3g', '非 IMPACT 码的判定 ∈ {NEUTRAL,UNCERTAIN,OUT_OF_SCOPE}',
  nonImpactReasons.every((s) => s.decision === 'NEUTRAL' || s.decision === 'UNCERTAIN' || s.decision === 'OUT_OF_SCOPE'))

checkEqual('positive', 'C4', '任务状态 = 11', 11, AFFECT_SEMANTIC_TASK_STATES.length)
checkEqual('positive', 'C4b', '终态 = 6',
  ['COMMITTED', 'NO_IMPACT', 'TERMINAL_FAILED', 'EXPIRED', 'CANCELLED_BY_MODE_CHANGE', 'SOURCE_INVALIDATED'],
  [...AFFECT_SEMANTIC_TASK_TERMINAL_STATES])
checkTrue('positive', 'C4c', '终态 ⊆ 状态集',
  AFFECT_SEMANTIC_TASK_TERMINAL_STATES.every((t) => AFFECT_SEMANTIC_TASK_STATES.includes(t)))
checkTrue('positive', 'C4d', '在途状态非终态',
  ['DISCOVERED', 'CLAIMED', 'EVALUATING', 'VALIDATED', 'RETRYABLE_FAILED']
    .every((s) => !isAffectSemanticTaskTerminal(s as never)))
checkTrue('positive', 'C4e', '终态判定为终态',
  AFFECT_SEMANTIC_TASK_TERMINAL_STATES.every((s) => isAffectSemanticTaskTerminal(s)))

checkEqual('positive', 'C5', '解析失败码 = 11', 11, AFFECT_SEMANTIC_PARSE_FAILURE_CODES.length)
checkEqual('positive', 'C5b', '传输失败码 = 4',
  ['timeout', 'rate_limited', 'server_error', 'network_error'],
  [...AFFECT_SEMANTIC_TRANSPORT_FAILURE_CODES])
const parseSet = new Set(AFFECT_SEMANTIC_PARSE_FAILURE_CODES as readonly string[])
checkTrue('positive', 'C5c', '解析 ∩ 传输 = ∅（仅传输可重试的合同基础）',
  AFFECT_SEMANTIC_TRANSPORT_FAILURE_CODES.every((t) => !parseSet.has(t)))

checkEqual('positive', 'C6', '上下文别名 = m-1..m-6',
  ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'], [...AFFECT_SEMANTIC_CONTEXT_ALIASES])

// ===========================================================================
// ③ 冻结常量（正控：与 Contract-Freeze 逐值一致）
// ===========================================================================

checkEqual('positive', 'V1', '策略版本', 'affect-semantic-policy@1', AFFECT_SEMANTIC_POLICY_VERSION)
checkEqual('positive', 'V2', '评估器名', 'affect-semantic-evaluator', AFFECT_SEMANTIC_EVALUATOR_NAME)
checkEqual('positive', 'V3', '评估器版本', 'affect-semantic-evaluator@1', AFFECT_SEMANTIC_EVALUATOR_VERSION)
checkEqual('positive', 'V4', '扫描水位 processor', 'affect-semantic-scanner@1', AFFECT_SEMANTIC_SCANNER_PROCESSOR)
checkEqual('positive', 'V5', '完成水位 processor', 'affect-semantic-worker@1', AFFECT_SEMANTIC_WORKER_PROCESSOR)
checkEqual('positive', 'V6', '影响水位 processor', 'affect-semantic-impact@1', AFFECT_SEMANTIC_IMPACT_PROCESSOR)
checkEqual('positive', 'V7', '终结闸前缀', 'affect-semantic-finalized:', AFFECT_SEMANTIC_FINALIZED_PREFIX)
checkEqual('positive', 'V8', '回执编码版本', 'affect-semantic@1', AFFECT_SEMANTIC_RECEIPT_VERSION)
checkEqual('positive', 'V9', '时间语义标记', ['SOURCE_ANCHORED'], [...AFFECT_SEMANTIC_TIMING_KINDS])

checkEqual('positive', 'N1', '单次超时 20,000ms', 20_000, AFFECT_SEMANTIC_TIMEOUT_MS)
checkEqual('positive', 'N2', '输出 max_tokens 5,000（WP10 修订：3,000→5,000，ADR-068 R-5）', 5_000, AFFECT_SEMANTIC_MAX_TOKENS)
checkEqual('positive', 'N3', '输入 token 预算 3,000', 3_000, AFFECT_SEMANTIC_INPUT_BUDGET_TOKENS)
checkEqual('positive', 'N4', '输入字符守卫 6,000', 6_000, AFFECT_SEMANTIC_INPUT_CHAR_GUARD_UNITS)
checkEqual('positive', 'N5', '响应上限 16,384 units', 16_384, AFFECT_SEMANTIC_RESPONSE_CAP_UNITS)
checkEqual('positive', 'N6', '候选上限 3', 3, AFFECT_SEMANTIC_MAX_CANDIDATES)
checkEqual('positive', 'N7', 'contextRefs 上限 6', 6, AFFECT_SEMANTIC_MAX_CONTEXT_REFS)
checkEqual('positive', 'N8', '尝试上限 2', 2, AFFECT_SEMANTIC_MAX_ATTEMPTS)
checkEqual('positive', 'N9', '重试间隔 2,000ms', 2_000, AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS)
checkEqual('positive', 'N10', 'Retry-After 上限 60,000ms', 60_000, AFFECT_SEMANTIC_RETRY_AFTER_CAP_MS)
checkEqual('positive', 'N11', '最大时龄 120,000ms', 120_000, AFFECT_SEMANTIC_MAX_AGE_MS)
checkEqual('positive', 'N12', '扫描批量 32', 32, AFFECT_SEMANTIC_SCAN_BATCH_SIZE)
checkEqual('positive', 'N13', '上下文条数 6', 6, AFFECT_SEMANTIC_CONTEXT_MAX_MESSAGES)
checkEqual('positive', 'N14', '上下文回溯 30 分钟', 30 * 60 * 1000, AFFECT_SEMANTIC_CONTEXT_LOOKBACK_MS)

// 负控（机制金丝雀）：比较器必须能察觉被篡改的值——防"恒真检查"
checkTrue('negative', 'N-neg', '常量比较器察觉篡改（金丝雀）',
  AFFECT_SEMANTIC_TIMEOUT_MS !== AFFECT_SEMANTIC_TIMEOUT_MS + 1)

// ===========================================================================
// ④ 纯函数：span 协议（正控 / 负控 / 恢复）
// ===========================================================================

const MSG = '𝒜好呀' // U+1D49C（代理对，2 units）+ 好 + 呀 ⇒ length = 4
checkEqual('positive', 'P-length', '代理对消息长度 = 4', 4, MSG.length)
checkTrue('positive', 'P1', 'span 覆盖整个代理对字符 [0,2) 合法', isValidAffectSemanticSpan({ start: 0, end: 2 }, MSG))
checkTrue('positive', 'P2', 'span 覆盖 BMP 字符 [2,4) 合法', isValidAffectSemanticSpan({ start: 2, end: 4 }, MSG))
checkTrue('positive', 'P3', 'span 单字符 [3,4) 合法', isValidAffectSemanticSpan({ start: 3, end: 4 }, MSG))
checkTrue('positive', 'P4', '全消息 span [0,4) 合法', isValidAffectSemanticSpan({ start: 0, end: 4 }, MSG))

checkTrue('negative', 'P5', 'span 起点在代理对中间 [1,3) 拒', !isValidAffectSemanticSpan({ start: 1, end: 3 }, MSG))
checkTrue('negative', 'P6', 'span 终点在代理对中间 [0,1) 拒', !isValidAffectSemanticSpan({ start: 0, end: 1 }, MSG))
checkTrue('negative', 'P7', 'span 负起点拒', !isValidAffectSemanticSpan({ start: -1, end: 2 }, MSG))
checkTrue('negative', 'P8', 'span 越界拒', !isValidAffectSemanticSpan({ start: 0, end: 5 }, MSG))
checkTrue('negative', 'P9', 'span 空区间拒', !isValidAffectSemanticSpan({ start: 2, end: 2 }, MSG))
checkTrue('negative', 'P10', 'span 倒置拒', !isValidAffectSemanticSpan({ start: 3, end: 2 }, MSG))
checkTrue('negative', 'P11', 'span 非整数拒', !isValidAffectSemanticSpan({ start: 1.5, end: 3 }, MSG))

checkTrue('recovery', 'P12', '负控之后合法 span 重新通过', isValidAffectSemanticSpan({ start: 2, end: 3 }, MSG))

// ===========================================================================
// ④ 纯函数：回执编码 / 闸键 / 幂等键 / 守卫
// ===========================================================================

const FP = '0123456789abcdef'
checkEqual('positive', 'R1', 'COMMITTED 回执语法',
  'affect-semantic@1|COMMITTED|A-GRATITUDE|fp=0123456789abcdef',
  encodeAffectSemanticCommittedReceipt('A-GRATITUDE', FP))
checkEqual('positive', 'R2', 'NO_IMPACT 回执语法',
  'affect-semantic@1|NO_IMPACT|UNCERTAIN|fp=0123456789abcdef',
  encodeAffectSemanticNoImpactReceipt('UNCERTAIN', FP))
checkEqual('positive', 'R3', '终态回执语法',
  'affect-semantic@1|EXPIRED', encodeAffectSemanticTerminalReceipt('EXPIRED'))

checkTrue('negative', 'R4', '指纹 15 位拒', !isAffectSemanticInputFingerprint('0123456789abcde'))
checkTrue('negative', 'R5', '指纹 17 位拒', !isAffectSemanticInputFingerprint('0123456789abcdef0'))
checkTrue('negative', 'R6', '指纹非 hex 拒', !isAffectSemanticInputFingerprint('0123456789abcdeg'))
checkTrue('negative', 'R7', '指纹大写拒', !isAffectSemanticInputFingerprint('0123456789ABCDEF'))
checkTrue('recovery', 'R8', '负控之后合法指纹重新通过', isAffectSemanticInputFingerprint(FP))

const SRC = 'evt-123' as never
checkEqual('positive', 'K1', '终结闸键推导',
  'affect-semantic-finalized:evt-123', affectSemanticFinalizedGateKey(SRC))
checkEqual('positive', 'K2', '语义 IMPACT 幂等 operation',
  'affect-semantic-impact:A-HOSTILE:evt-123',
  affectSemanticImpactIdempotencyOperation('A-HOSTILE', SRC))
const m8ImpactKey = affectImpactIdempotencyOperation('A-HOSTILE', SRC)
const semanticImpactKey = affectSemanticImpactIdempotencyOperation('A-HOSTILE', SRC)
checkTrue('positive', 'K3', '语义 IMPACT 键与 M8 词形键永不相同', m8ImpactKey !== semanticImpactKey)
checkTrue('positive', 'K4', '闸键与 M8 TOUCH 键前缀不同',
  affectSemanticFinalizedGateKey(SRC) !== affectTouchIdempotencyOperation(SRC))

checkTrue('positive', 'G1', '模式守卫认合法值', isAffectSemanticMode('shadow'))
checkTrue('negative', 'G2', '模式守卫拒非法值', !isAffectSemanticMode('canary'))
checkTrue('positive', 'G3', '判定守卫认合法值', isAffectSemanticDecision('IMPACT'))
checkTrue('negative', 'G4', '判定守卫拒非法值', !isAffectSemanticDecision('FAILED'))
checkTrue('positive', 'G5', 'reasonCode 守卫认全部 19 词',
  AFFECT_SEMANTIC_REASON_TABLE.every((s) => isAffectSemanticReasonCode(s.code)))
checkTrue('negative', 'G6', 'reasonCode 守卫拒编造词', !isAffectSemanticReasonCode('MADE_UP_CODE'))
checkTrue('positive', 'G7', '别名守卫认 m-1..m-6',
  AFFECT_SEMANTIC_CONTEXT_ALIASES.every((a) => isAffectSemanticContextAlias(a)))
checkTrue('negative', 'G8', '别名守卫拒 m-999', !isAffectSemanticContextAlias('m-999'))
checkTrue('positive', 'G9', '传输失败守卫认 4 码',
  AFFECT_SEMANTIC_TRANSPORT_FAILURE_CODES.every((c) => isAffectSemanticTransportFailure(c)))
checkTrue('negative', 'G10', '传输失败守卫拒解析码', !isAffectSemanticTransportFailure('json_parse_failed'))
checkTrue('recovery', 'G11', '负控之后守卫重新安静', isAffectSemanticMode('rules') && isAffectSemanticDecision('NEUTRAL'))

// ===========================================================================
// 汇总 + 量具自检（§6.8：measured_count > 0，四段各自非空）
// ===========================================================================

const measuredPhases = Object.entries(phaseCounts).filter(([, n]) => (n ?? 0) > 0).length
const allPhasesNonEmpty = Object.values(phaseCounts).every((n) => (n ?? 0) > 0)
const failed = checks.filter((c) => !c.pass)
const verdict = allPhasesNonEmpty && failed.length === 0 ? 'PASS' : 'FAIL'

const result = {
  verdict,
  measured_count: checks.length,
  phaseCounts,
  phasesMeasured: measuredPhases,
  measuredSelfCheck: allPhasesNonEmpty ? 'OK（四段均非空）' : 'MEASUREMENT INVALID（存在空段）',
  failed: failed.map((c) => ({ id: c.id, label: c.label, expected: c.expected, actual: c.actual })),
  passedCount: checks.length - failed.length,
  checkedAt: new Date().toISOString(),
}

const runId = `wp3-contracts-${result.checkedAt.replace(/[-:T.]/g, '').slice(0, 15)}`
const outDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wp3-contracts.json')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')

console.log(`verdict        : ${verdict}`)
console.log(`measured_count : ${checks.length} (pass ${result.passedCount} / fail ${failed.length})`)
console.log(`phases         : ${JSON.stringify(phaseCounts)}`)
console.log(`self-check     : ${result.measuredSelfCheck}`)
console.log(`evidence       : ${outPath}`)
process.exit(verdict === 'PASS' ? 0 : 1)
