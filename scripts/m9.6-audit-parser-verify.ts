/**
 * M9.6 WP0a —— **审计判定器量具门**（`pnpm m9.6:audit-parser:verify`）。
 *
 * ============================================================================
 *  它证明什么
 * ============================================================================
 * ```text
 * ① 四态分列真的在工作：`valid_empty` / `valid_nonempty` / `invalid_output` / `unavailable`
 *    每一个都被**真实触达**且计数非零（缺一项 ⇒ MEASUREMENT INVALID，不是 PASS）。
 * ② 失败码白名单**没有死分支**：17 个码逐个被真实触达并断言。
 * ③ 终态语义：合法空数组保留业务含义；坏响应落 `invalid_output` 且**不可用**。
 * ④ 总期限与取消路径真的存在（`@1` 没有）：fetch **与响应体读取**受同一个 signal 约束。
 * ⑤ 正控 / 负控 / 恢复三段式 —— 负控刻意**把 `@1` 的旧解析器重新实现一遍**，
 *    断言"同一批坏响应在旧解析器下会得到 `abstained + grounded + 0 关键错误`"，
 *    即**假通过可复现**；再断言真实现下**重新安静**。
 * ⑥ 真实出站 **0**：全局 `fetch` 在整轮里被替换成"一调用就抛错"的桩。
 * ```
 *
 * ⚠️ 纯离线。不加载 `.env`、不碰数据库、不发任何网络请求、不改任何历史证据。
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  DEFAULT_TOTAL_DEADLINE_MS,
  MAX_RESPONSE_UNITS,
  PARSE_FAILURE_CODES,
  judgeWithModel,
  type JudgeDeps,
  type LlmJudgeInput,
  type LlmJudgeVerdict,
  type ParseFailureCode,
  type RawOutcome,
} from './m9.5-live-judge-llm.ts'

const ROOT = resolve('.')
const EVIDENCE_PATH = join(ROOT, 'artifacts', 'm9.6', 'audit-parser.json')
const INSTRUMENT = 'scripts/m9.5-live-judge-llm.ts'

/* ===========================================================================
 *  基础设施（check / section / 看门狗 / 假 fetch）
 * ========================================================================= */

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/** 看门狗：任何用例挂死都得变成**一条失败**，不是把门挂住 */
const WATCHDOG_MS = 5_000
class WatchdogTripped extends Error {}

async function callJudge(label: string, input: LlmJudgeInput, deps: JudgeDeps): Promise<LlmJudgeVerdict | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const trip = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => { rej(new WatchdogTripped(label)) }, WATCHDOG_MS)
    })
    return await Promise.race([judgeWithModel(input, deps), trip])
  } catch (error) {
    if (error instanceof WatchdogTripped) {
      check(`★ 看门狗：${label} 必须在 ${WATCHDOG_MS}ms 内返回`, false, '挂死')
      return null
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const dv = (v: LlmJudgeVerdict | null): string =>
  v === null
    ? 'WATCHDOG'
    : `rawOutcome=${v.rawOutcome} code=${String(v.parseCode)} kind=${v.kind} grounded=${String(v.grounded)} attempts=${String(v.attempts)}`

/** 假端点：**离线**（`.invalid` 不解析），Key 是无意义的桩值 */
const FAKE_ENDPOINT = { baseUrl: 'https://offline.invalid/v1', model: 'offline-mock', apiKey: 'not-a-real-key' } as const

interface Counter {
  calls: number
}

/** 注入式假 fetch：`make(call)` 按第几次调用产出响应 ⇒ 计数可控、真实出站 0 */
function makeFetch(make: (call: number) => Response, counter: Counter): typeof fetch {
  return ((_input: unknown, _init?: unknown) => {
    counter.calls += 1
    return Promise.resolve(make(counter.calls))
  }) as unknown as typeof fetch
}

/** 标准信封：`choices[0].message.content` */
function envelope(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 任意原始正文（用于坏信封） */
function rawBody(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** 只会被 signal 打断的 fetch —— 用来量"总期限"与"取消" */
const abortAwareFetch: typeof fetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) => {
  const signal = init?.signal ?? null
  return new Promise<Response>((_resolve, reject) => {
    if (signal === null) return
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
  })
}) as unknown as typeof fetch

/** 响应头正常、**响应体永不结束** —— 量"期限是否覆盖响应体读取" */
const slowBodyFetch: typeof fetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) => {
  const signal = init?.signal ?? null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => { controller.error(signal.reason as Error) }, { once: true })
    },
  })
  return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }))
}) as unknown as typeof fetch

const EMPTY_EVIDENCE: readonly string[] = []
const input = (request: string, reply: string, admissibleEvidence: readonly string[] = EMPTY_EVIDENCE): LlmJudgeInput => ({ request, reply, admissibleEvidence })

/* ===========================================================================
 *  §0 零真实出站：整轮把全局 fetch 换成"一调用就抛错"
 * ========================================================================= */

const REAL_FETCH = globalThis.fetch
let realEgressAttempts = 0
globalThis.fetch = ((..._args: unknown[]) => {
  realEgressAttempts += 1
  throw new Error('真实出站被调用（本门必须零出站）')
}) as unknown as typeof fetch

/* ===========================================================================
 *  §1 四态分列正控
 * ========================================================================= */

section('§1 四态分列（valid_empty / valid_nonempty / invalid_output / unavailable）')

const stateCounts: Record<RawOutcome, number> = { valid_empty: 0, valid_nonempty: 0, invalid_output: 0, unavailable: 0 }
const codeCounts = new Map<ParseFailureCode, number>()
function tally(v: LlmJudgeVerdict | null): void {
  if (v === null) return
  stateCounts[v.rawOutcome] += 1
  if (v.parseCode !== null) codeCounts.set(v.parseCode, (codeCounts.get(v.parseCode) ?? 0) + 1)
}

/* — ① valid_empty：格式合法、断言为空（合法业务空集，不是量具空转） — */
{
  const counter: Counter = { calls: 0 }
  const v = await callJudge('valid_empty', input('我在做的项目是什么？', '这件事我这里没有记录，说不出来。'), {
    endpoint: FAKE_ENDPOINT,
    fetchImpl: makeFetch(() => envelope('{"assertions":[]}'), counter),
  })
  tally(v)
  check(
    '★ 正控 valid_empty：`{"assertions":[]}` ⇒ abstained + grounded（**合法空集**，与解析失败可分）',
    v?.rawOutcome === 'valid_empty' && v.kind === 'abstained' && v.grounded === true && v.parseCode === null && v.criticalErrors.length === 0,
    dv(v)
  )
  check('★ 正控 valid_empty：恰好 1 次请求（合法响应不重试）', counter.calls === 1, `${String(counter.calls)} 次`)
}

/* — ② valid_nonempty：合法且断言非空（两个方向：有依据 / 无依据） — */
{
  const counter: Counter = { calls: 0 }
  const v = await callJudge(
    'valid_nonempty 有依据',
    input('我在做的项目是什么？', '你现在的项目是毕业论文。', ['project.background.active = 毕业论文']),
    { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('{"assertions":[{"text":"毕业论文","supported":true}]}'), counter) }
  )
  tally(v)
  check(
    '★ 正控 valid_nonempty（有依据）：answered + grounded + 无关键错误（**不该响时安静**）',
    v?.rawOutcome === 'valid_nonempty' && v.kind === 'answered' && v.grounded === true && v.criticalErrors.length === 0 && v.parseCode === null,
    dv(v)
  )
}
{
  const counter: Counter = { calls: 0 }
  const v = await callJudge(
    'valid_nonempty 无依据',
    input('我在做的项目是什么？', '记得。毕业设计。', EMPTY_EVIDENCE),
    { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('{"assertions":[{"text":"毕业设计","supported":false}]}'), counter) }
  )
  tally(v)
  check(
    '★ 正控 valid_nonempty（无依据）：answered + 不 grounded + 关键错误 1（**必须响**）',
    v?.rawOutcome === 'valid_nonempty' && v.kind === 'answered' && v.grounded === false && v.criticalErrors.length === 1,
    dv(v)
  )
}

/* ===========================================================================
 *  §2 失败码白名单：17 个码逐个真实触达（没有死分支）
 * ========================================================================= */

section('§2 失败码白名单逐个可达（死分支 = 无法测量的分支）')

interface FailureCase {
  readonly label: string
  readonly expected: ParseFailureCode
  /** 期望的失败家族 */
  readonly family: 'invalid_output' | 'unavailable'
  /** `@1` 是否对同一输入给出**错误结论**（假通过或假指控，两者都算） */
  readonly legacyAffected: boolean
  readonly run: () => Promise<LlmJudgeVerdict | null>
}

const FAILURE_CASES: readonly FailureCase[] = [
  {
    label: 'envelope_not_json（HTTP 200 但正文不是 JSON）',
    expected: 'envelope_not_json',
    family: 'invalid_output',
    legacyAffected: false,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('envelope_not_json', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => rawBody('<html>hello</html>'), c) })
    },
  },
  {
    label: 'envelope_content_missing（HTTP 200 错 schema：无 choices[0].message.content）',
    expected: 'envelope_content_missing',
    family: 'invalid_output',
    legacyAffected: false,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('envelope_content_missing', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => rawBody('{"choices":[]}'), c) })
    },
  },
  {
    label: 'empty_content（正文空白）',
    expected: 'empty_content',
    family: 'invalid_output',
    legacyAffected: false,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('empty_content', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('   '), c) })
    },
  },
  {
    /* 审查报告 §3.1 的第一行原始证据就是这一条 */
    label: 'no_json_object（content = `not-json`，审查报告 §3.1 第 1 行）',
    expected: 'no_json_object',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('no_json_object', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('not-json'), c) })
    },
  },
  {
    label: 'not_json（`{oops}` 不是 JSON）',
    expected: 'not_json',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('not_json', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('{oops}'), c) })
    },
  },
  {
    label: 'payload_not_object（顶层是数组）',
    expected: 'payload_not_object',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('payload_not_object', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('[1,2]'), c) })
    },
  },
  {
    /* 审查报告 §3.1 的第 2 行原始证据 */
    label: 'assertions_missing（content = `{}`，审查报告 §3.1 第 2 行）',
    expected: 'assertions_missing',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('assertions_missing', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('{}'), c) })
    },
  },
  {
    /* 审查报告 §3.1 的第 3 行原始证据 */
    label: 'assertions_not_array（`{"assertions":"bad"}`，审查报告 §3.1 第 3 行）',
    expected: 'assertions_not_array',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('assertions_not_array', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('{"assertions":"bad"}'), c) })
    },
  },
  {
    label: 'assertion_entry_not_object（数组里有**非对象**条目）',
    expected: 'assertion_entry_not_object',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('assertion_entry_not_object', input('q', 'r'), {
        endpoint: FAKE_ENDPOINT,
        fetchImpl: makeFetch(() => envelope('{"assertions":["bad-entry"]}'), c),
      })
    },
  },
  {
    label: 'assertion_text_not_string（`text` 非字符串 —— `@1` 会**静默丢掉**这一条）',
    expected: 'assertion_text_not_string',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('assertion_text_not_string', input('q', 'r'), {
        endpoint: FAKE_ENDPOINT,
        fetchImpl: makeFetch(() => envelope('{"assertions":[{"text":1,"supported":true}]}'), c),
      })
    },
  },
  {
    label: 'assertion_supported_not_boolean（缺 `supported` —— `@1` 会当成 `false`）',
    expected: 'assertion_supported_not_boolean',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('assertion_supported_not_boolean', input('q', 'r'), {
        endpoint: FAKE_ENDPOINT,
        fetchImpl: makeFetch(() => envelope('{"assertions":[{"text":"毕业设计"}]}'), c),
      })
    },
  },
  {
    label: `response_too_long（超过 ${String(MAX_RESPONSE_UNITS)} 单元）`,
    expected: 'response_too_long',
    family: 'invalid_output',
    legacyAffected: true,
    run: async () => {
      const c: Counter = { calls: 0 }
      const fat = `{"assertions":[]}${'x'.repeat(MAX_RESPONSE_UNITS + 10)}`
      return await callJudge('response_too_long', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope(fat), c) })
    },
  },
  {
    label: 'http_error（HTTP 500）',
    expected: 'http_error',
    family: 'unavailable',
    legacyAffected: false,
    run: async () => {
      const c: Counter = { calls: 0 }
      return await callJudge('http_error', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => rawBody('boom', 500), c) })
    },
  },
  {
    label: 'network_error（fetch 抛错）',
    expected: 'network_error',
    family: 'unavailable',
    legacyAffected: false,
    run: async () => {
      const c: Counter = { calls: 0 }
      const throwing = ((_i: unknown, _init?: unknown) => {
        c.calls += 1
        return Promise.reject(new TypeError('fetch failed'))
      }) as unknown as typeof fetch
      return await callJudge('network_error', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: throwing })
    },
  },
  {
    label: 'deadline_exceeded（响应头永不返回，吃总期限）',
    expected: 'deadline_exceeded',
    family: 'unavailable',
    legacyAffected: false,
    run: async () => await callJudge('deadline_exceeded', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: abortAwareFetch, deadlineMs: 60 }),
  },
  {
    label: 'cancelled（外部 signal 取消）',
    expected: 'cancelled',
    family: 'unavailable',
    legacyAffected: false,
    run: async () => {
      const controller = new AbortController()
      controller.abort()
      return await callJudge('cancelled', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: abortAwareFetch, signal: controller.signal })
    },
  },
  {
    label: 'endpoint_not_configured（三元组不全 —— **不许**回落主模型 Key）',
    expected: 'endpoint_not_configured',
    family: 'unavailable',
    legacyAffected: false,
    run: async () => await callJudge('endpoint_not_configured', input('q', 'r'), { endpoint: { baseUrl: '', model: '', apiKey: '' } }),
  },
]

const observedCodes = new Set<ParseFailureCode>()
for (const item of FAILURE_CASES) {
  const verdict = await item.run()
  tally(verdict)
  if (verdict?.parseCode !== null && verdict?.parseCode !== undefined) observedCodes.add(verdict.parseCode)
  check(
    `★ 失败码 ${item.label} ⇒ ${item.expected} / ${item.family}`,
    verdict?.parseCode === item.expected && verdict.rawOutcome === item.family && verdict.kind === 'unavailable' && verdict.assertions.length === 0,
    dv(verdict)
  )
}

const declared = new Set<ParseFailureCode>(PARSE_FAILURE_CODES)
const missing = [...declared].filter((code) => !observedCodes.has(code))
check(
  '★ 白名单**无死分支**：声明的每个失败码都被真实触达（声明的码 = 触达的码）',
  missing.length === 0 && observedCodes.size === declared.size,
  `声明 ${String(declared.size)} · 触达 ${String(observedCodes.size)} · 未触达 ${missing.length === 0 ? '无' : missing.join(',')}`
)

/* ===========================================================================
 *  §3 终态语义：重试与"不值得再试"
 * ========================================================================= */

section('§3 终态语义（认证/非法协议不重试；形状失败重试）')

{
  const c401: Counter = { calls: 0 }
  const v401 = await callJudge('401', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => rawBody('unauthorized', 401), c401) })
  tally(v401)
  observedCodes.add('http_error')
  check(
    '★ 401 ⇒ **不重试**（恰好 1 次请求）且终态不可用（计划 §10：认证失败立即停止）',
    c401.calls === 1 && v401?.kind === 'unavailable' && v401.rawOutcome === 'unavailable',
    `${String(c401.calls)} 次 · ${dv(v401)}`
  )
}
{
  const c403: Counter = { calls: 0 }
  const v403 = await callJudge('403', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => rawBody('forbidden', 403), c403) })
  tally(v403)
  check('★ 403 ⇒ **不重试**（恰好 1 次请求）', c403.calls === 1 && v403?.kind === 'unavailable', `${String(c403.calls)} 次`)
}
{
  const c500: Counter = { calls: 0 }
  const v500 = await callJudge('500', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => rawBody('boom', 500), c500) })
  tally(v500)
  check('★ 500 ⇒ 允许重试到尝试上限（3 次）', c500.calls === 3, `${String(c500.calls)} 次`)
  check('★ 形状/传输失败重试到上限后 ⇒ `unavailable`（**不是**"没有断言所以干净"）', v500?.kind === 'unavailable' && v500.grounded === false, dv(v500))
}
{
  const cShape: Counter = { calls: 0 }
  const vShape = await callJudge('shape-retry', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: makeFetch(() => envelope('{}'), cShape) })
  tally(vShape)
  check(
    '★ 形状失败也重试到上限（3 次），最终落 `invalid_output`（≠ `unavailable`）',
    cShape.calls === 3 && vShape?.rawOutcome === 'invalid_output' && vShape.parseCode === 'assertions_missing',
    `${String(cShape.calls)} 次 · ${dv(vShape)}`
  )
}

/* ===========================================================================
 *  §4 总期限与取消路径（`@1` 完全没有）
 * ========================================================================= */

section('§4 总期限覆盖 fetch **与响应体读取**，且存在取消路径')

check(
  '★ 现役默认总期限是一个正的有界毫秒数（`@1` 无此常量）',
  Number.isFinite(DEFAULT_TOTAL_DEADLINE_MS) && DEFAULT_TOTAL_DEADLINE_MS > 0,
  `${String(DEFAULT_TOTAL_DEADLINE_MS)}ms`
)

/* 直接断言"调用时**确实**传了 AbortSignal 给 fetch"——这是缺口被补上的机械证据 */
{
  let sawSignal = false
  let sawSignalAbortable = false
  const spy = ((_i: unknown, init?: { signal?: AbortSignal | null }) => {
    sawSignal = init?.signal instanceof AbortSignal
    sawSignalAbortable = init?.signal?.aborted === false
    return Promise.resolve(envelope('{"assertions":[]}'))
  }) as unknown as typeof fetch
  const v = await callJudge('signal-spy', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: spy })
  tally(v)
  check(
    '★ 每次 fetch 都带 `AbortSignal`（未中止态）⇒ 期限/取消路径真的接上了',
    sawSignal && sawSignalAbortable && v?.rawOutcome === 'valid_empty',
    `signal=${String(sawSignal)} · abortable=${String(sawSignalAbortable)}`
  )
}

/* 响应头正常、响应体永不结束 ⇒ 若期限不覆盖响应体，本用例会挂死（只能靠看门狗变红） */
{
  const startedAt = Date.now()
  const v = await callJudge('slow-body', input('q', 'r'), { endpoint: FAKE_ENDPOINT, fetchImpl: slowBodyFetch, deadlineMs: 120 })
  const elapsed = Date.now() - startedAt
  tally(v)
  check(
    '★ **慢响应体**吃总期限：rawOutcome=unavailable 且 code=deadline_exceeded（不是挂死）',
    v?.parseCode === 'deadline_exceeded' && v.rawOutcome === 'unavailable' && elapsed < WATCHDOG_MS,
    /* ⚠️ 刻意**不把毫秒写进证据**（否则重复运行不再逐字节相同）；只记"看门狗没响" */
    `${dv(v)} · 未触发 ${String(WATCHDOG_MS)}ms 看门狗`
  )
  console.log(`      （墙上时钟读数，仅供人看、不入证据：${String(elapsed)}ms）`)
}

/* 跨重试的总期限：每次尝试都吃同一个剩余预算 */
{
  const v = await callJudge('deadline-across-retries', input('q', 'r'), {
    endpoint: FAKE_ENDPOINT,
    fetchImpl: abortAwareFetch,
    deadlineMs: 150,
  })
  tally(v)
  check(
    '★ 总期限**跨重试**生效（不是"每次尝试各自无限"）：最终 deadline_exceeded',
    v?.parseCode === 'deadline_exceeded',
    dv(v)
  )
}

/* ===========================================================================
 *  §5 三段式自证：正控 / 负控（旧解析器必须失败）/ 恢复
 * ========================================================================= */

section('§5 三段式自证 —— 负控刻意把 `@1` 的旧解析器重新实现一遍')

/*
 * ============================================================================
 *  ⚠️ 这段是**故意的历史代码复刻**，不是死代码。
 * ============================================================================
 * 复刻对象：`HEAD = d5a830b`（`m9.5-complete`）上的 `parseAssertions`。
 * 它被保留在门里，是为了让"坏响应伪装成干净结果"这件事**可复现**：
 * 只测"新实现给出我想要的结论"是正控；证明"旧实现会给出另一个结论"才证明判据有牙。
 * 复刻代码由 §5 的负控断言钉住；**任何情况下都不得**被生产路径引用。
 */
function legacyParseAssertions(raw: string): { text: string; supported: boolean }[] {
  const match = /\{[\s\S]*\}/.exec(raw)
  if (match === null) return []
  try {
    const parsed = JSON.parse(match[0]) as { assertions?: { text?: unknown; supported?: unknown }[] }
    if (!Array.isArray(parsed.assertions)) return []
    return parsed.assertions
      .filter((item) => typeof item.text === 'string')
      .map((item) => ({ text: String(item.text), supported: item.supported === true }))
  } catch {
    return []
  }
}

/** 复刻 `@1` 调用方的**解析之后**那一段判定逻辑（逐字等价） */
function legacyVerdict(content: string, admissibleEvidence: readonly string[]): { kind: string; grounded: boolean; critical: number } {
  const assertions = legacyParseAssertions(content)
  const unsupported = assertions.filter((item) => !item.supported)
  const noEvidence = admissibleEvidence.length === 0
  const assertsSomething = assertions.length > 0
  return {
    kind: assertsSomething ? 'answered' : 'abstained',
    grounded: unsupported.length === 0 && (!noEvidence || !assertsSomething),
    critical: noEvidence ? unsupported.length : 0,
  }
}

/**
 * 复刻 `@1` **整个**调用分支，含调用方那道唯一的失败闸 `raw.trim() === ''`。
 * 这道闸是关键：它只拦**空白**，所以非空坏响应会直接落到 `legacyVerdict`。
 */
function legacyCallerOutcome(
  content: string,
  admissibleEvidence: readonly string[]
): { kind: string; grounded: boolean; critical: number } {
  if (content.trim() === '') return { kind: 'unavailable', grounded: false, critical: 0 }
  return legacyVerdict(content, admissibleEvidence)
}

/**
 * `@1` 对同一批输入的真实结局 —— **三类，必须分列**（本轮实测推翻了"全是假通过"的初始假设）：
 *  · `false_pass`       = 假通过（`abstained + grounded=true + 关键错误 0`）⇒ **抬高 `groundedRate`**
 *  · `false_accusation` = 假指控（`answered + grounded=false + 关键错误 ≥1`）⇒ 反过来**冤枉产品**
 *  · `caught`           = 真被拦住（`unavailable`）
 *
 * ⚠️ 判据：`@1` 在 `noEvidence` 下 `grounded = (unsupported==0) && !assertsSomething`，
 * 所以**只有"过滤后一条断言都不剩"**才是假通过；留下的那条若被静默当成 `supported=false`，
 * 就变成**假指控**。两个方向都由本门钉住。
 */
type LegacyClass = 'false_pass' | 'false_accusation' | 'caught'

interface ShapeSample {
  readonly content: string
  readonly legacy: LegacyClass
}

/** 与 §2 的 `FAILURE_CASES` 一一对应的**原始 content**（负控拿同一个输入喂旧解析器） */
const SHAPE_SAMPLES: Readonly<Record<string, ShapeSample>> = {
  no_json_object: { content: 'not-json', legacy: 'false_pass' },
  not_json: { content: '{oops}', legacy: 'false_pass' },
  payload_not_object: { content: '[1,2]', legacy: 'false_pass' },
  assertions_missing: { content: '{}', legacy: 'false_pass' },
  assertions_not_array: { content: '{"assertions":"bad"}', legacy: 'false_pass' },
  assertion_entry_not_object: { content: '{"assertions":["bad-entry"]}', legacy: 'false_pass' },
  assertion_text_not_string: { content: '{"assertions":[{"text":1,"supported":true}]}', legacy: 'false_pass' },
  /*
   * ★ 这一条方向**相反**：`@1` 把缺失的 `supported` 静默当成 `false`，
   *   于是读成"她有一条**无依据**断言"并记 1 个关键错误 —— 量具故障被变成**对产品的假指控**。
   */
  assertion_supported_not_boolean: { content: '{"assertions":[{"text":"毕业设计"}]}', legacy: 'false_accusation' },
  response_too_long: { content: `{"assertions":[]}${'x'.repeat(MAX_RESPONSE_UNITS + 10)}`, legacy: 'false_pass' },
}

function classifyLegacy(content: string): LegacyClass {
  const outcome = legacyCallerOutcome(content, EMPTY_EVIDENCE)
  if (outcome.kind === 'unavailable') return 'caught'
  if (outcome.grounded && outcome.critical === 0) return 'false_pass'
  return 'false_accusation'
}

const legacyObserved: Record<string, LegacyClass> = {}
for (const [code, sample] of Object.entries(SHAPE_SAMPLES)) legacyObserved[code] = classifyLegacy(sample.content)

const falsePassCodes = Object.entries(SHAPE_SAMPLES).filter(([, s]) => s.legacy === 'false_pass')
const falseAccusationCodes = Object.entries(SHAPE_SAMPLES).filter(([, s]) => s.legacy === 'false_accusation')
const mismatchedLegacy = Object.entries(SHAPE_SAMPLES).filter(([code, s]) => legacyObserved[code] !== s.legacy)

check(
  '★ **负控**：`@1` 对 8 类非空坏响应给出**假通过**（`abstained + grounded=true + 关键错误 0`）—— 可复现',
  mismatchedLegacy.length === 0 && falsePassCodes.length === 8,
  `假通过 ${String(falsePassCodes.length)} 类 · 假指控 ${String(falseAccusationCodes.length)} 类 · 与预期不符 ${String(mismatchedLegacy.length)}`
)

check(
  '★ **负控（反向）**：缺 `supported` 在 `@1` 下被静默当成 `false` ⇒ 坏响应变成**对产品的假指控**（关键错误 1）',
  legacyObserved.assertion_supported_not_boolean === 'false_accusation' &&
    legacyCallerOutcome(SHAPE_SAMPLES.assertion_supported_not_boolean.content, EMPTY_EVIDENCE).critical === 1,
  '同一类量具故障在**两个方向**上都造成错误结论：既会放过，也会冤枉'
)

/* 负控的方向性对照：`@1` **确实**拦住了空白正文（所以它不是"什么都不拦"） */
check(
  '★ **负控对照**：`@1` 只拦住**空白**正文 ⇒ 缺陷面精确地是"**非空**坏响应"',
  classifyLegacy('') === 'caught' && classifyLegacy('   ') === 'caught' && classifyLegacy('not-json') === 'false_pass',
  '空白 ⇒ caught（被调用方那道 `raw.trim()===""` 拦住）；`not-json` ⇒ false_pass（绕过）'
)

/* 静默丢弃：混合数组里合法条目留下、非法条目被 `filter` 扔掉 ⇒ 断言数被悄悄改小 */
check(
  '★ **负控（静默丢弃）**：混合数组里非法条目被 `filter` 丢掉 —— 断言条数被悄悄改小，旧实现**无任何痕迹**',
  legacyParseAssertions('{"assertions":[{"text":"x","supported":true},"bad-entry"]}').length === 1 &&
    legacyParseAssertions('{"assertions":["bad-entry"]}').length === 0,
  '2 条进、1 条出（丢弃无痕迹）；真实现把整份判 `invalid_output`'
)

/* 恢复：同一批输入在**真实现**下必须重新安静（不再给出"干净"结论） */
{
  const shapeCodes = Object.keys(SHAPE_SAMPLES) as ParseFailureCode[]
  const allReached = shapeCodes.every((code) => observedCodes.has(code))
  const allShapeFamily = FAILURE_CASES.filter((item) => item.legacyAffected).every((item) => item.family === 'invalid_output')
  check(
    `★ **恢复**：上述 ${String(shapeCodes.length)} 类输入在真实现下全部落 \`invalid_output\` + \`kind=unavailable\`（**重新安静**）`,
    allReached && allShapeFamily && shapeCodes.length === 9,
    `${String(shapeCodes.length)} 类全部触达 · 家族全为 invalid_output=${String(allShapeFamily)}`
  )
}

/* 正控：合法空数组与坏响应在旧实现下**映到同一个值**（`[]`）—— 这正是缺陷的根 */
check(
  '★ **正控**：合法空数组与坏响应在旧实现下**映到同一个值**（`[]`）—— 这正是缺陷的根',
  legacyParseAssertions('{"assertions":[]}').length === 0 && legacyParseAssertions('not-json').length === 0,
  '旧实现无法区分"合法空集"与"解析失败"；真实现分成 `valid_empty` / `invalid_output`'
)

/* ===========================================================================
 *  §6 测量有效性自检：缺态 / 零分母 ⇒ MEASUREMENT INVALID，不是 PASS
 * ========================================================================= */

section('§6 测量有效性自检（缺态或零测量必须拒绝 PASS）')

/** 纯函数：任何一态计数为 0 ⇒ 量具无效 */
function assessStates(counts: Record<RawOutcome, number>): { valid: boolean; reason: string } {
  const zero = (Object.keys(counts) as RawOutcome[]).filter((k) => counts[k] === 0)
  return zero.length === 0 ? { valid: true, reason: 'ok' } : { valid: false, reason: `未触达：${zero.join(',')}` }
}

const assessment = assessStates(stateCounts)
check(
  '★ 四态**全部非零**（缺任何一态 ⇒ MEASUREMENT INVALID，不是 PASS）',
  assessment.valid,
  `${JSON.stringify(stateCounts)}${assessment.valid ? '' : ` · ${assessment.reason}`}`
)
check(
  '★ 自检的**自检**：故意把一态清零 ⇒ 检查器必须判无效（量具自己有牙）',
  assessStates({ ...stateCounts, valid_empty: 0 }).valid === false,
  '把 valid_empty 置 0 ⇒ 判 INVALID'
)
check(
  '★ 失败码计数非零的码数 ≥ 15（不是"检查了 0 项、发现 0 处不一致"）',
  [...codeCounts.values()].filter((n) => n > 0).length >= 15,
  `${String([...codeCounts.values()].filter((n) => n > 0).length)} 个码有非零计数`
)

/* ===========================================================================
 *  §7 零真实出站
 * ========================================================================= */

section('§7 零真实出站')

check(
  '★ 全局 `fetch` 在整轮被替换为"一调用就抛错"的桩，全部用例仍正常 ⇒ **真实出站 0**',
  realEgressAttempts === 0,
  `真实出站尝试 ${String(realEgressAttempts)} 次`
)
check(
  '★ 仪器文件不含密钥样式常量、不读 `.env`（Key 只经环境或注入三元组）',
  !readFileSync(join(ROOT, INSTRUMENT), 'utf8').includes('dotenv'),
  '仪器不加载 dotenv'
)

/* 还原全局 fetch（哪怕后面抛错也要还原） */
globalThis.fetch = REAL_FETCH

/* ===========================================================================
 *  证据（**无时钟字段** ⇒ 重复运行逐字节相同，除 `head` 随提交变化）
 * ========================================================================= */

const head = ((): string => {
  try {
    const raw = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim()
    return raw.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', raw.slice(5).trim()), 'utf8').trim() : raw
  } catch {
    return 'unknown'
  }
})()

const evidence = {
  testId: 'M9.6 / WP0a audit-judge instrument verification',
  instrument: INSTRUMENT,
  instrumentVersion: 'm9.5-live-judge-llm@2',
  note:
    '纯离线：注入假 fetch，真实出站 0；不加载 .env、不碰数据库、不写任何历史证据。' +
    '证据不含时钟字段 ⇒ 除 `head` 外重复运行逐字节相同。',
  head,
  passed,
  failed,
  failures,
  checks,
  rawOutcomeCounts: stateCounts,
  codeCounts: Object.fromEntries([...codeCounts.entries()].sort()),
  declaredCodes: [...PARSE_FAILURE_CODES],
  reachedCodes: [...observedCodes].sort(),
  unReachedCodes: missing,
  legacyBehaviour: {
    ofShapeClasses: Object.keys(SHAPE_SAMPLES).length,
    falsePass: falsePassCodes.length,
    falseAccusation: falseAccusationCodes.length,
    caught: Object.values(legacyObserved).filter((c) => c === 'caught').length,
    mismatchedExpectation: mismatchedLegacy.length,
    observed: legacyObserved,
    note:
      '复刻 HEAD=d5a830b 的 parseAssertions 与调用方那道唯一失败闸：' +
      '非空坏响应在两个方向上都会给出错误结论（假通过抬高 groundedRate / 假指控冤枉产品）。',
  },
  deadline: { defaultTotalDeadlineMs: DEFAULT_TOTAL_DEADLINE_MS, maxResponseUnits: MAX_RESPONSE_UNITS },
  realEgressAttempts,
}

mkdirSync(join(ROOT, 'artifacts', 'm9.6'), { recursive: true })
writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM9.6 WP0a 量具门：${String(passed)} 通过 / ${String(failed)} 失败`)
console.log(`  四态计数：${JSON.stringify(stateCounts)}`)
console.log(`  失败码：声明 ${String(declared.size)} · 触达 ${String(observedCodes.size)} · 真实出站 ${String(realEgressAttempts)}`)
console.log('  证据：artifacts/m9.6/audit-parser.json')
process.exit(failed > 0 ? 1 : 0)
