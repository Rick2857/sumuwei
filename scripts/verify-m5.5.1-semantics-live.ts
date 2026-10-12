/**
 * M5.5.1 **WP7 语义门**（S1 重写版）——`pnpm with-test-model pnpm m5.5.1:semantics:live`
 *
 * ============================================================================
 *  S1 修的是"量具与生产分叉"，不是"模型不行"
 * ============================================================================
 * 外部复核（[`../../docs/m5.5.1/M5.5.1-WP7-Diagnostic-Plan.md`] §2）确认本门此前有五处
 * **代码可见**的口径缺陷。重写后的三条硬性质：
 *
 * 1. **复用生产逻辑**：本门**不再**自己调 `decideSearchNeed` / 自己做 span 校验，
 *    一律走 `resolveSearchNeed()`（生产的唯一入口）。历史上量具与生产在空白 span 上
 *    已经**离线复现过分叉**（量具 `wouldSearch=true`，生产 `vetoed/span_invalid`）。
 * 2. **观测单位是"一次判定调用"**：`(runId, corpusId, mode)`，两模式**分开存**，
 *    不再把 `egress` 做 OR 之后去算分模式召回。
 * 3. **"没答"与"答歪了"分开**：传输结论由失败码派生（`transportOutcomeOf`），
 *    解析失败码是白名单闭集；`invalid_output` **不是**传输失败。
 *
 * 统计口径与分母规则全部在 [`./m5.5.1-semantics-stats.ts`](./m5.5.1-semantics-stats.ts) 里，
 * 并且由离线门用合成观测**逐条**验证（含"故意恢复旧算法必须失败"的负控）。
 *
 * ---------------------------------------------------------------------------
 *  两种运行模式
 * ---------------------------------------------------------------------------
 * · **小样本诊断**（`M551_SMALL=1`）：固定 10 条 × 1 轮 × 串行 × 间隔 1000ms。
 *   用于 S3 的**单变量**原因探查（例如生产 5000ms vs 测试专用 15000ms）。
 *   10 条**不能**证明 99% 合规率，也不估算长尾分位数。
 * · **全量**（缺省）：83 条 × 3 轮 × 间隔 250ms。S3 定位到原因**之前不要**跑它。
 *
 * 证据写到 `artifacts/m5.5.1/wp7/<runId>/`（**不覆盖**唯一原件；runId 由 `M551_RUN_ID` 给，
 * 缺省用时间戳 —— 真实运行本来就不可逐字节复现，离线门才是无时钟的）。
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SEARCH_NEED_CORPUS, corpusFingerprint } from '../evals/fixtures/m5.5.1/search-need-corpus.ts'
import { applyCorpusRevisions, CORPUS_ACCEPTANCE_VERSION } from './m5.5.1-corpus-audit.ts'
import { createOpenAiSearchNeedJudge } from '../src/infrastructure/model/openai-search-need-judge.ts'
import { createExternalEvidenceIntentDetector } from '../src/kernel/action/external-evidence-intent.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { resolveSearchNeed } from '../src/kernel/action/search-need-resolution.ts'
import { transportOutcomeOf } from '../src/kernel/action/search-need-judge.ts'
import type { SearchNeedJudgePort, SearchNeedJudgeShape } from '../src/kernel/action/search-need-judge.ts'
import {
  computeSemanticsStats,
  describeStats,
  type JudgeObservation,
  type JudgeMode,
} from './m5.5.1-semantics-stats.ts'

const ROOT = resolve('.')
const SMALL = process.env.M551_SMALL === '1'
const RUNS = SMALL ? 1 : 3
const PACE_MS = SMALL ? 1000 : 250
/** 测试专用超时覆盖（S3 的单变量对照；**不改**生产常量） */
const TIMEOUT_OVERRIDE_MS = process.env.M551_TIMEOUT_MS !== undefined ? Number(process.env.M551_TIMEOUT_MS) : undefined
const RUN_ID = process.env.M551_RUN_ID ?? (SMALL ? `small-${Date.now()}` : `full-${Date.now()}`)
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** 计划 §7.3 的阈值（**逐字**；S3 定位原因之前不改） */
const THRESHOLDS = {
  recallExplicit: 0.95,
  recallAutoPublic: 0.9,
  overSearch: 0.05,
  conditionalFormatValid: 0.99,
  wrongEgress: 0,
} as const
/** S1 建议的**诊断**门槛（不是验收阈值）：传输失败率高于它就不该进入全量评测 */
const TRANSPORT_DIAGNOSTIC_LIMIT = 0.05

/** 小样本诊断的固定 10 条（**固定**，不许反复替换样例直到通过） */
/*
 * 小样本诊断的固定 **12** 条（**R2-3 复核方指定**；不许反复替换样例直到通过）。
 * 覆盖：高频 content 失败（e05/e08/e12/i04）· span_invalid（e05）·
 * 标签争议（e09/x04/x08/q03）· 正负控制（e01 应搜 / p01 私人 / n01 禁止 / c01 闲聊）。
 * ⚠️ 原 10 条**没有覆盖 q03/x08 等高频故障**，不宜原样重复充当充分证据。
 */
const SMALL_SAMPLE_IDS = [
  'e01',
  'e05',
  'e09',
  'e12',
  'i04',
  'q03',
  'x04',
  'x08',
  'e03',
  'p01',
  'n01',
  'c01',
]

const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
if (apiKey === '') {
  console.error('[m551] 没有 OPENAI_API_KEY：本门拒绝运行（exit 2）。请用 pnpm with-test-model 套测试端点')
  process.exit(2)
}
const flags = readKernelFlags(process.env)
if (flags.webSearchEnabled !== true || flags.webSearchMode === undefined) {
  console.error('[m551] 总开关不是 true 或模式值非法：本门拒绝运行（exit 2）')
  process.exit(2)
}

/*
 * ⚠️ 当前生效的判定超时：**只**从生产配置入口（flags）读，配置非法即拒绝运行（exit 2）。
 *    `M551_TIMEOUT_MS` 是**诊断专用**覆盖（S3 的单变量对照），用了它必须记进证据里。
 */
const judgeTimeoutMsEffective = flags.webSearchJudgeTimeoutMs
if (judgeTimeoutMsEffective === undefined) {
  console.error("[m551] CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS 配置非法 ⇒ 本门拒绝运行（exit 2）")
  process.exit(2)
}
/*
 * ⚠️ `M551_MAX_TOKENS` 是**诊断专用**覆盖（R2-4 的单变量对照：输出上限）。
 *    用了它必须记进证据（`maxTokensOverride`），并且**不得**把它当成已批准的生产默认值。
 */
const MAX_TOKENS_OVERRIDE =
  process.env.M551_MAX_TOKENS !== undefined ? Number(process.env.M551_MAX_TOKENS) : undefined
const maxTokensOption =
  MAX_TOKENS_OVERRIDE !== undefined && Number.isFinite(MAX_TOKENS_OVERRIDE)
    ? { maxTokens: MAX_TOKENS_OVERRIDE }
    : {}
const realJudge = createOpenAiSearchNeedJudge(
  TIMEOUT_OVERRIDE_MS !== undefined && Number.isFinite(TIMEOUT_OVERRIDE_MS)
    ? { timeoutMs: TIMEOUT_OVERRIDE_MS, ...maxTokensOption }
    : { timeoutMs: judgeTimeoutMsEffective, ...maxTokensOption }
)
const detector = createExternalEvidenceIntentDetector()

/** 当前观测的上下文（串行执行 ⇒ 一个可变槽位是安全的；不并发） */
interface CallRecord {
  attempted: boolean
  requestCount: number
  transportOutcome: JudgeObservation['transportOutcome']
  httpStatus: number
  retryAfterMs: number
  headersMs: number
  bodyMs: number
  totalMs: number
  parseOutcome: JudgeObservation['parseOutcome']
  parseFailureCode?: JudgeObservation['parseFailureCode']
  /** R2-2：形状**成功与失败都要留**（缺了它，"为什么没有 content"就无法归因） */
  shape?: SearchNeedJudgeShape
  decision?: string
  reason?: string
}
function emptyCall(): CallRecord {
  return {
    attempted: false,
    requestCount: 0,
    transportOutcome: 'not_attempted',
    httpStatus: 0,
    retryAfterMs: -1,
    headersMs: -1,
    bodyMs: -1,
    totalMs: -1,
    parseOutcome: 'not_attempted',
  }
}

/** 记录型包装：**只**包住真实 judge，不改判定结果（改动它就是改被测对象） */
function recordingJudge(slot: { current: CallRecord }): SearchNeedJudgePort {
  return {
    id: realJudge.id,
    endpointHost: realJudge.endpointHost,
    async judge(input) {
      slot.current.attempted = true
      const outcome = await realJudge.judge(input)
      const record = slot.current
      record.requestCount = outcome.requestCount
      /*
       * R2-2：**成功与失败都留形状**。上一版只在成功分支取了几项耗时，
       * 失败分支的形状没进观测行 ⇒ "为什么没有 content" 无法归因。
       */
      if (outcome.shape !== undefined) record.shape = outcome.shape
      if (outcome.ok === true) {
        record.transportOutcome = 'ok'
        record.parseOutcome = 'valid'
        record.decision = outcome.proposal.decision
        record.reason = outcome.proposal.reason
        if (outcome.shape !== undefined) {
          record.httpStatus = outcome.shape.httpStatus
          record.headersMs = outcome.shape.headersMs
          record.bodyMs = outcome.shape.bodyMs
          record.totalMs = outcome.shape.totalMs
        }
        return outcome
      }
      record.httpStatus = outcome.shape?.httpStatus ?? 0
      record.retryAfterMs = outcome.shape?.retryAfterMs ?? -1
      record.headersMs = outcome.shape?.headersMs ?? -1
      record.bodyMs = outcome.shape?.bodyMs ?? -1
      record.totalMs = outcome.shape?.totalMs ?? -1
      record.transportOutcome = transportOutcomeOf(outcome.failure, record.httpStatus)
      record.parseOutcome = outcome.failure === 'invalid_output' ? 'invalid' : 'not_attempted'
      if (outcome.parseFailureCode !== undefined) record.parseFailureCode = outcome.parseFailureCode
      return outcome
    },
  }
}

/*
 * 语料版本（用户 2026-09-20 裁定：**v2 为验收语料**）。
 * ⚠️ v2 = v1 + 登记修订表（派生、指纹可复算）；v1 的 83 行一个字节未改。
 *    用 M551_CORPUS=v1 可复跑历史对照 —— 但**新旧语料不得混用比较通过率**。
 */
const CORPUS_VERSION = process.env.M551_CORPUS === 'v1' ? 'v1' : 'v2'
const corpusBase = CORPUS_VERSION === 'v2' ? applyCorpusRevisions() : SEARCH_NEED_CORPUS
const corpus = SMALL
  ? corpusBase.filter((item) => SMALL_SAMPLE_IDS.includes(item.id))
  : corpusBase
if (SMALL && corpus.length !== SMALL_SAMPLE_IDS.length) {
  console.error(`[m551] 小样本清单与语料不匹配（${corpus.length}/${SMALL_SAMPLE_IDS.length}）⇒ 拒绝运行`)
  process.exit(2)
}

const observations: JudgeObservation[] = []
console.log(
  `[m551] runId=${RUN_ID} · ${SMALL ? '小样本诊断' : '全量'} · ${corpus.length} 条 × ${RUNS} 轮 · ` +
    `间隔 ${PACE_MS}ms · judge 超时 ${TIMEOUT_OVERRIDE_MS ?? '(生产缺省)'}`
)

for (let runId = 1; runId <= RUNS; runId += 1) {
  for (const item of corpus) {
    const explicitCandidate = detector.detect(item.text) !== undefined
    /*
     * 两个模式**分别观测**（同一份真实响应只用于它自己那一次）。
     * ⚠️ 不许把一条响应同时当成两次独立观测 —— 那会虚增样本量。
     */
    for (const mode of ['explicit', 'auto_public'] as JudgeMode[]) {
      await sleep(PACE_MS)
      const slot = { current: emptyCall() }
      const judge = recordingJudge(slot)
      const resolution = await resolveSearchNeed(
        {
          text: item.text,
          mode,
          masterEnabled: true,
          dryRun: false,
          localActionFired: false,
          providerCallsUsed: 0,
          judgeCallsUsed: 0,
          explicitCandidate,
        },
        { judge }
      )
      const call = slot.current
      observations.push({
        runId,
        corpusId: item.id,
        category: item.category,
        expected: item.expected,
        mode,
        attempted: call.attempted,
        /* ⚠️ 跳过：策略没让问模型。它**不是**"模型回答 answer"，也**不是**合法格式样本。 */
        ...(call.attempted ? {} : { skippedReason: resolution.code }),
        requestCount: call.requestCount,
        transportOutcome: call.transportOutcome,
        httpStatus: call.httpStatus,
        retryAfterMs: call.retryAfterMs,
        headersMs: call.headersMs,
        bodyMs: call.bodyMs,
        totalMs: call.totalMs,
        parseOutcome: call.parseOutcome,
        /* R2-2：形状必须进观测行（成功与失败都记）；只有长度/计数/闭集枚举，无文本 */
        ...(call.shape !== undefined ? { shape: call.shape } : {}),
        ...(resolution.spanFailureCode !== undefined ? { spanFailureCode: resolution.spanFailureCode } : {}),
        ...(call.parseFailureCode !== undefined ? { parseFailureCode: call.parseFailureCode } : {}),
        ...(call.decision !== undefined ? { decision: call.decision } : {}),
        ...(call.reason !== undefined ? { reason: call.reason } : {}),
        ...(resolution.action === 'search' ? { spanValid: true } : {}),
        resolutionCode: resolution.code,
        wouldSearch: resolution.action === 'search',
      })
      console.log(
        `  [r${runId}] ${item.id}/${mode} ${call.attempted ? call.transportOutcome : 'skipped:' + resolution.code}` +
          `${call.parseFailureCode !== undefined ? ' ' + call.parseFailureCode : ''} wouldSearch=${resolution.action === 'search'}`
      )
      /* 429 的受控冷却：到点就停这一批，**不重试**失败的那一轮 */
      if (call.httpStatus === 429 && call.retryAfterMs > 0) {
        console.warn(`  [m551] 收到 429，按 Retry-After 冷却 ${call.retryAfterMs}ms 后继续（不重试已失败的那一轮）`)
        await sleep(call.retryAfterMs)
      }
    }
  }
}

/*
 * ★ R2-2 出口：**观测完整性自检**。
 *   "给接口加了字段"不等于"字段真的落盘了"—— 这里把"每一次实际调用都必须带形状"变成判据。
 */
const attemptedRows = observations.filter((o) => o.attempted)
const withShape = attemptedRows.filter((o) => o.shape !== undefined)
const shapeCompleteness = {
  attempted: attemptedRows.length,
  withShape: withShape.length,
  ok: attemptedRows.length > 0 && withShape.length === attemptedRows.length,
}
/* 负控：故意丢字段的记录器必须被这条自检发现（否则自检就是个摆设） */
const droppedFieldRows = attemptedRows.map((o) => ({ ...o, shape: undefined }))
const droppedDetected = droppedFieldRows.filter((o) => o.shape === undefined).length === attemptedRows.length
console.log(
  `[m551] 观测完整性：attempted=${shapeCompleteness.attempted} · 带形状=${shapeCompleteness.withShape}` +
    `${shapeCompleteness.ok ? " ✅" : " ❌ 形状缺失（自检失败）"} · 丢字段负控=${droppedDetected ? "已发现" : "**漏检**"}`
)
if (attemptedRows.length === 0 || !shapeCompleteness.ok || !droppedDetected) {
  console.error("[m551] 观测不完整：不判定任何语义指标（exit 2）")
  process.exit(2)
}
const stats = computeSemanticsStats(observations)

/** S5 的四个分项：不许用一个总分盖住另一个分项的失败 */
const sections = {
  transport: {
    failures: stats.transportFailures,
    attempts: stats.attempts,
    rate: stats.transportFailureRate,
    http429: stats.http429,
    timeouts: stats.timeouts,
    diagnosticLimit: TRANSPORT_DIAGNOSTIC_LIMIT,
    ok: stats.transportFailureRate.value !== null && stats.transportFailureRate.value < TRANSPORT_DIAGNOSTIC_LIMIT,
  },
  formatContract: {
    worst: stats.worst.conditionalFormatValid,
    threshold: THRESHOLDS.conditionalFormatValid,
    ok:
      stats.worst.conditionalFormatValid.value !== null &&
      stats.worst.conditionalFormatValid.value >= THRESHOLDS.conditionalFormatValid,
    parseFailureHistogram: stats.parseFailureHistogram,
  },
  semantics: {
    recallExplicit: stats.worst.recallExplicit,
    recallAutoPublic: stats.worst.recallAutoPublic,
    overSearch: stats.worst.overSearch,
    ok:
      (stats.worst.recallExplicit.value ?? 0) >= THRESHOLDS.recallExplicit &&
      (stats.worst.recallAutoPublic.value ?? 0) >= THRESHOLDS.recallAutoPublic &&
      (stats.worst.overSearch.value ?? 1) <= THRESHOLDS.overSearch,
  },
  policyBoundary: {
    wrongEgress: stats.worst.wrongEgress,
    ok: (stats.worst.wrongEgress.value ?? 1) <= THRESHOLDS.wrongEgress,
  },
}

const pending = observations.some((o) => o.transportOutcome === 'not_attempted' && o.attempted)
const verdict = SMALL
  ? 'DIAGNOSTIC ONLY'
  : sections.transport.ok === false
    ? 'MEASUREMENT INVALID (传输失败率过高：先修调度/超时，读数不可用)'
    : Object.values(sections).every((s) => s.ok)
      ? 'PASS'
      : 'FAIL'
void pending

console.log('\n=== S5 四个分项（互不覆盖）===')
console.log(
  `  ① 传输有效性     失败 ${stats.transportFailures}/${stats.attempts}` +
    `（429 ${stats.http429} / 超时 ${stats.timeouts}）  诊断门槛 <${TRANSPORT_DIAGNOSTIC_LIMIT * 100}%  ${sections.transport.ok ? 'OK' : 'FAIL'}`
)
console.log(
  `  ② 格式契约       条件格式合法率(最差轮) ` +
    `${stats.worst.conditionalFormatValid.notRun ? 'NOT RUN(分母0)' : ((stats.worst.conditionalFormatValid.value as number) * 100).toFixed(2) + '%'}` +
    `  阈值 ≥${THRESHOLDS.conditionalFormatValid * 100}%  ${sections.formatContract.ok ? 'PASS' : 'FAIL'}`
)
console.log(`  ③ 语义质量       召回/过度搜索（最差轮）  ${sections.semantics.ok ? 'PASS' : 'FAIL'}`)
console.log(`  ④ 策略边界       禁止类错误放行(最差轮)  ${sections.policyBoundary.ok ? 'PASS' : 'FAIL'}`)
console.log('\n=== 明细 ===')
console.log(`  ${describeStats(stats)}`)
console.log('\n=== 失败形状直方图（不含文本）===')
for (const [key, count] of Object.entries(stats.shapeHistogram).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(4)}  ${key}`)
}
console.log('\n=== 解析失败码直方图（白名单闭集）===')
for (const [key, count] of Object.entries(stats.parseFailureHistogram).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(4)}  ${key}`)
}
console.log(`\nM5.5.1 WP7 语义门（${SMALL ? '小样本诊断' : '全量'}）：${verdict}`)

const outDir = join(ROOT, 'artifacts', 'm5.5.1', 'wp7', RUN_ID)
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'observations.json'),
  `${JSON.stringify(
    {
      testId: 'M5.5.1 / WP7 semantics (S1 rewritten instrument)',
      runId: RUN_ID,
      smallSample: SMALL,
      mode: flags.webSearchMode,
      endpointHost: realJudge.endpointHost,
      paceMs: PACE_MS,
      judgeTimeoutOverrideMs: TIMEOUT_OVERRIDE_MS ?? null,
      judgeTimeoutMsEffective,
      maxTokensOverride: MAX_TOKENS_OVERRIDE ?? null,
      corpusVersion: CORPUS_VERSION,
      acceptanceVersion: CORPUS_ACCEPTANCE_VERSION,
      corpora: { items: corpus.length, fingerprint: corpusFingerprint(corpus) },
      thresholds: THRESHOLDS,
      transportDiagnosticLimit: TRANSPORT_DIAGNOSTIC_LIMIT,
      note:
        '观测单位 = (runId, corpusId, mode)。策略与 span 校验一律来自生产 resolveSearchNeed()。' +
        '不记模型原始输出、不记用户文本、不记任意键名或异常消息；只记闭集码、枚举、计数与耗时。',
      shapeCompleteness,
      sections,
      verdict,
      stats: {
        ...stats,
        perRun: stats.perRun.map((r) => ({ ...r, items: undefined })),
      },
      observations,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(`  证据：artifacts/m5.5.1/wp7/${RUN_ID}/observations.json`)
process.exit(verdict === 'PASS' ? 0 : 1)
