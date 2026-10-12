/**
 * M10.1 —— **`A11` 行为级对照**（R-26：结清之后她还会不会重复提那件事）。
 *
 * ============================================================================
 *  它回答什么（**读数门**：数字如实分列，不与 PASS/FAIL 混在一起）
 * ============================================================================
 * ```text
 * 同一批 10 轮"结清之后"的用户话，跑两档：
 *   档 A：她的上下文里**有**那条已结清事实块（逐字含「已结清」+「不要再提」）
 *   档 B：**没有**那条块（其余逐字相同）
 * 读数 = 每档里"她的回复**又提了一次那件事**"的轮数（确定性词形检测；**只算她主动提的**：
 *        用户那句话里本来就有的词不算 —— 否则回声会被记成重复）。
 * ⚠️ **这是行为读数，不是判据**：三种结果都如实记（A<B 有下降 · A==B 没测出效果 · A>B 反了）。
 *
 * 附一条**慢路径的真模型识别读数**（WP2b 的行为面）：把约定那两句真的交给真模型，
 * 看它写不写得出来（`written` / `no_agreement` / `rejected` / `invalid`）—— 同样如实分列。
 * ```
 *
 * 先例：`m11-ablation-verify.ts`（同一个形状：渲染真块 → 真模型两档 → 数行为）。
 *
 * ⚠️ 纪律：缺 `DSH_TEST_MODEL_WRAPPER=1` 拒跑；显式加载 `.env.test` 覆盖；**拒绝**生产端点；
 *    只打印 host 与 key 长度，**永不打印取值**；隔离库一次性沙箱。
 */

import { existsSync } from 'node:fs'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-1-a11', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { config as loadEnvFromFile } from 'dotenv'
import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import {
  COMMITMENT_DO_NOT_RAISE,
  renderCommitmentStateBlock,
  type CommitmentFactRow,
} from '../src/kernel/app/goal/commitment-facts.ts'
import { assembleAgreementWindow } from '../src/kernel/app/agreement/inputs.ts'
import { recognizeAgreement } from '../src/kernel/contracts/agreement-model-draft.ts'
import { createOpenAiAgreementDraftProvider } from '../src/infrastructure/model/openai-agreement-understanding.ts'

const REPO_ROOT = resolve(process.cwd())
const quantify = (text: string): number => [...text].length

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
 * 0. 两条**失败关闭**的守卫（`m10.1:smoke:live` 同源）
 * ------------------------------------------------------------------------- */
if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(
    `⛔ 拒跑：本门走**真模型**，必须先经 \`pnpm with-test-model\`（缺 ${TEST_MODEL_WRAPPER_MARKER}=1）。`
  )
  process.exit(2)
}
if (existsSync('.env.test')) loadEnvFromFile({ path: '.env.test', override: true })
const host = ((): string => {
  try {
    return new URL((process.env.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').host
  } catch {
    return '(无法解析)'
  }
})()
if (host === '' || host === 'api.deepseek.com') {
  console.error(`⛔ 拒跑：解析出的端点是生产端点（host=${host}）—— 本门只跑测试端点。`)
  process.exit(2)
}
const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
console.log(`端点 host=${host} · model=${(process.env.OPENAI_SMALL_MODEL ?? '').trim()} · key 长度=${String(apiKey.length)}`)

/* ---------------------------------------------------------------------------
 * 1. 治疗项：**那条已结清的事实块**（逐字）
 * ------------------------------------------------------------------------- */
const closedRow: CommitmentFactRow = {
  goalId: 'gol:a11-closed',
  scope: '明天十点二十五在楼下见（带伞和外套）',
  status: 'fulfilled',
  criterionKind: 'user_report',
}
const block = renderCommitmentStateBlock({ rows: [closedRow], maxTokens: 400, quantify })[0]?.content ?? ''
record(
  'A11-P0',
  '【正控·治疗项在场】档 A 用的块**逐字**含「已结清」与「不要再提」（否则两档没有差别，读数无意义）',
  block.includes('已结清') && block.includes(COMMITMENT_DO_NOT_RAISE),
  `块长度=${String(quantify(block))} 码点 · 含已结清=${String(block.includes('已结清'))} · 含不要再提=${String(
    block.includes(COMMITMENT_DO_NOT_RAISE)
  )}`
)

/* ---------------------------------------------------------------------------
 * 2. 两档：同一批 10 轮（"结清之后"的对话）
 * ------------------------------------------------------------------------- */
/** 结清之后她会遇到的 10 句话（前两句**轻触**那件事的话题，其余无关） */
const TURNS: readonly string[] = [
  '明天还有什么安排吗？',
  '外面好像要下雨。',
  '你那本书我看了三章。',
  '晚饭吃什么好呢。',
  '今天有点累。',
  '周末想去远一点的地方。',
  '我那个提纲还没写完。',
  '你在忙什么？',
  '刚才那件事就这样吧。',
  '晚安。',
]
/** "她又提了一次那件事"的**确定性**词形（她主动提才算：用户那句话里本来就有的词不算） */
const AGREEMENT_TOKENS = ['楼下', '带伞', '外套', '十点二十五', '约好', '说好', '约定'] as const
/** 只有这几个词**单独**出现在约定里也足以判"她在说那件事"（时间词是最强的锚） */
const ANCHOR_TOKENS = ['十点二十五', '楼下', '外套'] as const

const mentionsOf = (reply: string, userLine: string): readonly string[] =>
  AGREEMENT_TOKENS.filter((token) => reply.includes(token) && !userLine.includes(token))
/*
 * ⚠️ **两套判据都记**（宽松词形 / 严格判据）—— 理由是实测出来的：
 *    宽松词形会把"泛泛的提醒"误判成"重复那件事"（本次实测：档 B 第 2 轮说「你出门记得带伞」，
 *    那与约定无关）。严格判据 = **≥2 个词形** 或 **命中锚点词**（时间/地点/物件里最不可替代的那些）。
 *    两套读数都进证据，**不覆盖**（判据变更纪律）。
 */
const mentionsStrictOf = (reply: string, userLine: string): readonly string[] => {
  const loose = mentionsOf(reply, userLine)
  const anchored = ANCHOR_TOKENS.some((token) => loose.includes(token))
  const multi = loose.length >= 2
  return anchored || multi ? loose : []
}

const PERSONA_SYSTEM =
  `你是苏沐薇。用一两句中文自然地回应用户；不要提"块""程序""上下文"这类内部词。` +
  `\n\n此时是 2026-10-02 晚上。`

let modelCalls = 0
/*
 * ⚠️ **端点与 key 必须在这里读**（不能提到模块顶层）：`.env.test` 的加载在本文件**正文里**
 *    （在守卫之后），模块顶层的常量会读到**加载前**的空值 ⇒ 第一版真的拿到 401。
 */
const askModel = async (system: string, userLine: string): Promise<string> => {
  const key = (process.env.OPENAI_API_KEY ?? '').trim()
  const baseURL = ((process.env.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = (process.env.OPENAI_SMALL_MODEL ?? '').trim() || 'deepseek-flash'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40_000)
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userLine },
        ],
      }),
      signal: controller.signal,
    })
    modelCalls += 1
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] }
    const content = payload.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : ''
  } finally {
    clearTimeout(timer)
  }
}

interface TurnReading {
  readonly turn: number
  readonly user: string
  readonly replyA: string
  readonly replyB: string
  readonly mentionsA: readonly string[]
  readonly mentionsB: readonly string[]
  readonly strictA: readonly string[]
  readonly strictB: readonly string[]
}
const readings: TurnReading[] = []
for (const [index, userLine] of TURNS.entries()) {
  const [replyA, replyB] = [
    await askModel(`${PERSONA_SYSTEM}\n\n【已经结清的事】\n${block}`, userLine),
    await askModel(PERSONA_SYSTEM, userLine),
  ]
  readings.push({
    turn: index + 1,
    user: userLine,
    replyA,
    replyB,
    mentionsA: mentionsOf(replyA, userLine),
    mentionsB: mentionsOf(replyB, userLine),
    strictA: mentionsStrictOf(replyA, userLine),
    strictB: mentionsStrictOf(replyB, userLine),
  })
  process.stdout.write(`  轮 ${String(index + 1)} ok（A 提 ${String(readings.at(-1)!.mentionsA.length)} / B 提 ${String(readings.at(-1)!.mentionsB.length)}）\n`)
}

const countA = readings.filter((row) => row.mentionsA.length > 0).length
const countB = readings.filter((row) => row.mentionsB.length > 0).length
const strictA = readings.filter((row) => row.strictA.length > 0).length
const strictB = readings.filter((row) => row.strictB.length > 0).length
const verdictOf2 = (a: number, b: number): string =>
  a < b ? '有下降' : a === b ? '没有测出效果' : '反了（档 A 提得更多）'
const verdict = verdictOf2(countA, countB)
const verdictStrict = verdictOf2(strictA, strictB)
record(
  'A11-R1',
  '【⭐ 读数·宽松词形】结清之后 10 轮里"**她主动又提那件事**"的轮数：档 A（有块）vs 档 B（无块）—— 三种结果都如实记',
  readings.length === TURNS.length && countA + countB >= 0,
  `档 A = ${String(countA)}/10 · 档 B = ${String(countB)}/10 ⇒ **${verdict}**（提了的轮：A=${JSON.stringify(
    readings.filter((row) => row.mentionsA.length > 0).map((row) => row.turn)
  )} B=${JSON.stringify(readings.filter((row) => row.mentionsB.length > 0).map((row) => row.turn))}）`
)
record(
  'A11-R1b',
  '【⭐ 读数·严格判据】（**同一批数据**：≥2 个词形 **或** 命中锚点词）—— 宽松词形会把"泛泛的提醒"误判成重复；两套读数**都留**，不覆盖',
  readings.length === TURNS.length,
  `档 A = ${String(strictA)}/10 · 档 B = ${String(strictB)}/10 ⇒ **${verdictStrict}**（` +
    `误报差 = ${String(countA - strictA)} / ${String(countB - strictB)}）`
)

/* ---------------------------------------------------------------------------
 * 3. 慢路径的**真模型识别读数**（WP2b 的行为面；纯读数）
 * ------------------------------------------------------------------------- */
const agreementWindow = assembleAgreementWindow({
  entries: [
    { id: 'cev:a11-u1', actorType: 'user', sequence: 1, text: '明天十点二十五，楼下，带伞和外套。' },
    { id: 'cev:a11-c1', actorType: 'character', sequence: 2, text: '行，那就这么定了。我到了跟你说。' },
  ],
})
const provider = createOpenAiAgreementDraftProvider()
let recognitionReading = 'transport_failed'
let recognitionDetail = ''
try {
  const raw = await provider.call({
    window: agreementWindow,
    signal: new AbortController().signal,
    deadlineMs: 30_000,
  })
  const verdictOf = recognizeAgreement(raw, agreementWindow)
  recognitionReading = verdictOf.ok ? 'written' : verdictOf.reason
  recognitionDetail = verdictOf.ok
    ? `content=${verdictOf.agreement.content} · criterion=${verdictOf.agreement.criterion} · 出处=${verdictOf.agreement.proposedByEventId}→${verdictOf.agreement.acceptedByEventId}`
    : verdictOf.detail
} catch (error) {
  recognitionDetail = error instanceof Error ? error.message : String(error)
}
record(
  'A11-R2',
  '【⭐ 读数·真模型在慢路径上的识别】把约定那两句真的交给真模型 ⇒ 写成了 / 说没有 / 被判拒 / 输出不合法（**如实分列**，不当判据）',
  recognitionReading !== 'transport_failed',
  `读数=${recognitionReading}（${recognitionDetail.slice(0, 160)}）`
)

/* ---------------------------------------------------------------------------
 * 4. 收尾：非零分母 + 落盘
 * ------------------------------------------------------------------------- */
const agentRuntime = new AgentRuntime({ character, plugins: [] })
await initDatabase(agentRuntime, sqlPlugin)
const db = getRawDb(agentRuntime)
void db
record(
  'A11-F1',
  '【非零分母】轮数 · 模型调用数 · 两档读数分母全部 > 0（`0 检查` 不算 PASS）',
  TURNS.length > 0 && modelCalls >= TURNS.length * 2 && block.length > 0,
  JSON.stringify({ turns: TURNS.length, modelCalls, blockCodepoints: quantify(block), countA, countB })
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-a11-behavior', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-a11-behavior@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  endpointHost: host,
  model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || 'deepseek-flash',
  realDbTouched: false,
  treatment: { blockCodepoints: quantify(block), hasDoNotRaise: block.includes(COMMITMENT_DO_NOT_RAISE) },
  denominators: { turns: TURNS.length, modelCalls, countA, countB, strictA, strictB },
  verdictReading: verdict,
  verdictReadingStrict: verdictStrict,
  recognitionReading: { reading: recognitionReading, detail: recognitionDetail },
  turns: readings,
  tokens: AGREEMENT_TOKENS,
  anchorTokens: ANCHOR_TOKENS,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '`A11` 是**行为读数**：它数"她主动又提那件事"的轮数（确定性词形）。' +
    '三种结果（有下降 / 没测出效果 / 反了）都如实记，**不**把它折成里程碑总分；' +
    '10 轮、单场景、词形检测 ⇒ 只能当**方向性**读数，不能外推成"她以后都不会再提"。',
}
writeFileSync(join(dir, 'a11-behavior.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-a11-behavior',
  head,
  headShort: head.slice(0, 12),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'a11-behavior',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['live'],
  supersedes: null,
  notes: `m10.1 A11 行为级对照（真模型；档 A vs 档 B；读数=${verdict}；识别读数=${recognitionReading}）`,
})
console.log(`runId: ${runId}`)
console.log(`读数：档 A = ${String(countA)}/10 · 档 B = ${String(countB)}/10 ⇒ ${verdict}`)
console.log(`识别读数：${recognitionReading}`)
console.log(
  `verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`
)
process.exit(failed.length === 0 ? 0 : 1)
