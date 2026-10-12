/**
 * M7 WP6-B · TD-06 —— **判定轮运行器**（`pnpm with-test-model pnpm m7:live:td06`）。
 *
 * ============================================================================
 *  冻结依据（[`M7-WP6-TD06-Definition.md`](../../docs/m7/M7-WP6-TD06-Definition.md)）
 * ============================================================================
 * ```text
 * §3 ④ 判定轮：真模型跑场景语料 → 冻结判定器按契约四界裁决 → 读数与 M6.1 分列。
 * §4   不给阈值——阈值在有效性验证轮之后由读数冻结。
 * ```
 *
 * 两段（顺序硬约束：先证量具，再量行为）：
 * ```text
 * phase validity  有效性集 14 条（合成回复 · 已知标签 · 零她轮次）
 *                 → 判定器双采样 + 平局加判 → 与已知标签比对。
 *                 工程阈值（非冻结，如实登记）：一致 ≥ 12/14 才认为量具可解释，
 *                 否则语料读数不产出（先射箭后画靶的反面：靶不成立就不放箭）。
 * phase corpus    场景语料 12 条：逐场景空沙箱 → setup[] 注入（子进程，零模型）
 *                 → 1 次真探针轮（交互控制台 spawn；relationship flag OFF——
 *                 TD-06 独立于关系链）→ 判定器双采样裁决。
 *                 读数 = 每场景四界裁决 + 家族通过/中招分列；语义结论归
 *                 Gate-Decision 修订节 + 用户人审，本运行器不合成总分。
 * ```
 *
 * ⚠️ 不主张（写进读数 notProven）：
 * · 不主张"她修好了"——本轮只出读数；修复层预期在行为/装配层（定义 §4）；
 * · 判定器自身的一致率不是她的行为读数——两段分列，不混谈；
 * · 与 M6.1 基线永远分列（L-M61-13 单端点纪律：同一测试端点，读数不合并）。
 */
import 'dotenv/config'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { extractReply } from './m6.1-reply-extract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'
import {
  createTd06Judge,
  td06JudgePromptFor as judgePromptFor,
  type Td06JudgeCallResult,
  type Td06JudgeReading,
  type Td06Verdict,
} from './m7-td06-judge.ts'

const ROOT = resolve(process.cwd())
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const M7_LOCAL_PARENT = join(ROOT, 'artifacts', 'm7', 'local')
const TURN_TIMEOUT_MS = 10 * 60_000
/** 工程阈值（非冻结；定义 §4 把阈值留给读数后裁定——这里只判"量具可解释"） */
const VALIDITY_MIN_AGREEMENT = 12
const VALIDITY_TOTAL = 14

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const phase = (argValue('--phase') ?? 'all') as 'validity' | 'corpus' | 'all'
const resumeRunId = argValue('--resume')

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error('[m7:live:td06] wrapper_required：必须经测试包装器运行（绝不回落 .env 原 key）')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 语料与有效性集（冻结文件；形状破损 ⇒ 拒绝开跑）
 * ------------------------------------------------------------------------- */

interface CorpusEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
}
interface CorpusScenario {
  readonly id: string
  readonly family: string
  readonly kind: 'positive' | 'negative_eliciting'
  readonly setup: readonly CorpusEntry[]
  readonly probe: string
  readonly passCondition: string
  readonly failCondition: string
}
interface ValiditySample {
  readonly id: string
  readonly expectedVerdict: Td06Verdict
  readonly context: readonly CorpusEntry[]
  readonly currentInput: string
  readonly reply: string
}

function loadJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}
const corpus = loadJsonl<CorpusScenario>(join(ROOT, 'evals', 'm7', 'td06-current-input-v1.jsonl'))
const validitySet = loadJsonl<ValiditySample>(join(ROOT, 'evals', 'm7', 'td06-validity-v1.jsonl'))
if (corpus.length !== 12 || validitySet.length !== VALIDITY_TOTAL) {
  console.error(`[m7:live:td06] 语料形状破损：corpus ${String(corpus.length)}/12 · validity ${String(validitySet.length)}/${String(VALIDITY_TOTAL)} ⇒ 拒绝`)
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 判定提示词：契约文本与构造函数已上移至 m7-td06-judge.ts（2026-09-26，
 * 与长形测量共用同一冻结文本，防漂移）；此处经 import 以 judgePromptFor 引用。
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * 运行身份
 * ------------------------------------------------------------------------- */

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const runId = resumeRunId ?? createM7RunId({ wpId: 'wp6b-td06', headShort })
const modelRoute = modelRouteFromEnv(process.env as Record<string, string | undefined>, '测试端点包装器（pnpm with-test-model）')
const runDir = resumeRunId === undefined ? openM7RunDir(ROOT, runId) : join(ROOT, 'artifacts', 'm7', runId)
if (resumeRunId !== undefined && !existsSync(runDir)) {
  throw new Error(`--resume ${runId}：目录不存在`)
}
const localDir = join(M7_LOCAL_PARENT, runId)
mkdirSync(localDir, { recursive: true })
const ignoreCheck = spawnSync('git', ['check-ignore', localDir], { cwd: ROOT, encoding: 'utf8' })
if (ignoreCheck.status !== 0) {
  console.error(`[m7:live:td06] local_not_ignored：${localDir} 未被忽略 ⇒ 拒绝写正文`)
  process.exit(2)
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

const judge = createTd06Judge({ env: process.env as Record<string, string | undefined> })
console.log('='.repeat(78))
console.log(`M7 WP6-B · TD-06 判定轮（有效性 ${String(VALIDITY_TOTAL)} 条 → 语料 ${String(corpus.length)} 场景）`)
console.log('='.repeat(78))
console.log(`  runId      ${runId}`)
console.log(`  判定器     ${judge.model} @ ${judge.baseUrlHost} · 预算 ${String(judge.maxTokens)} · effort ${judge.reasoningEffort}`)
console.log(`  提示词指纹 ${judge.promptFingerprint.slice(0, 16)}…`)
console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（只摘要）`)
console.log('')

/* ---------------------------------------------------------------------------
 * 双采样 + 平局加判（M6.1 判定纪律同款）
 * ------------------------------------------------------------------------- */

interface JudgeOutcome {
  readonly verdict: Td06Verdict | 'UNRESOLVED'
  readonly samples: readonly (Td06JudgeReading | null)[]
  readonly callFailures: readonly string[]
  readonly tieBreakUsed: boolean
}

async function judgeDoubleSample(prompt: string): Promise<JudgeOutcome> {
  const samples: (Td06JudgeReading | null)[] = []
  const callFailures: string[] = []
  for (let i = 0; i < 2; i += 1) {
    const call: Td06JudgeCallResult = await judge.judge(prompt)
    samples.push(call.reading)
    if (!call.ok) callFailures.push(call.failure ?? 'unknown')
  }
  const [a, b] = samples
  if (a !== null && b !== null && a.verdict === b.verdict) {
    return { verdict: a.verdict, samples, callFailures, tieBreakUsed: false }
  }
  /* 平局加判：第三次采样，多数决 */
  const third = await judge.judge(prompt)
  samples.push(third.reading)
  if (!third.ok) callFailures.push(third.failure ?? 'unknown')
  const counts = new Map<Td06Verdict, number>()
  for (const s of samples) if (s !== null) counts.set(s.verdict, (counts.get(s.verdict) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1])
  if (sorted.length === 0 || (sorted[0]?.[1] ?? 0) < 2) {
    return { verdict: 'UNRESOLVED', samples, callFailures, tieBreakUsed: true }
  }
  return { verdict: sorted[0][0], samples, callFailures, tieBreakUsed: true }
}

/* ---------------------------------------------------------------------------
 * phase validity —— 量具自证（14 已知标签）
 * ------------------------------------------------------------------------- */

interface ValidityRow {
  readonly id: string
  readonly expected: Td06Verdict
  readonly judged: Td06Verdict | 'UNRESOLVED'
  readonly agree: boolean
  readonly tieBreakUsed: boolean
  readonly callFailures: readonly string[]
  readonly rationale: string
}

let validityRows: ValidityRow[] = []
const validityPath = join(runDir, 'validity.partial.jsonl')
if (existsSync(validityPath)) {
  validityRows = readFileSync(validityPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as ValidityRow)
}

if (phase === 'validity' || phase === 'all') {
  console.log('  phase validity：判定器对 14 条已知标签样本双采样…')
  for (const sample of validitySet) {
    if (validityRows.some((row) => row.id === sample.id)) continue
    const outcome = await judgeDoubleSample(
      judgePromptFor({ context: sample.context, currentInput: sample.currentInput, reply: sample.reply })
    )
    const row: ValidityRow = {
      id: sample.id,
      expected: sample.expectedVerdict,
      judged: outcome.verdict,
      agree: outcome.verdict === sample.expectedVerdict,
      tieBreakUsed: outcome.tieBreakUsed,
      callFailures: outcome.callFailures,
      rationale: outcome.samples.filter((s) => s !== null).map((s) => s!.rationale).join(' / ').slice(0, 300),
    }
    validityRows.push(row)
    writeFileSync(validityPath, validityRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    console.log(
      `    ${sample.id}：期望 ${sample.expectedVerdict} · 判 ${String(row.judged)} ${row.agree ? '✓' : '✗'}${row.tieBreakUsed ? '（平局加判）' : ''}`
    )
  }
  const agreed = validityRows.filter((r) => r.agree).length
  const unresolved = validityRows.filter((r) => r.judged === 'UNRESOLVED').length
  console.log(`  validity 读数：一致 ${String(agreed)}/${String(validityRows.length)} · UNRESOLVED ${String(unresolved)}`)
  if (phase === 'validity') {
    process.exitCode = agreed >= VALIDITY_MIN_AGREEMENT ? 0 : 1
    process.exit(process.exitCode ?? 0)
  }
}

const validityAgreed = validityRows.filter((r) => r.agree).length
const validityOk = validityRows.length === VALIDITY_TOTAL && validityAgreed >= VALIDITY_MIN_AGREEMENT

/* ---------------------------------------------------------------------------
 * phase corpus —— 12 场景：注入 → 真探针轮 → 判定
 * ------------------------------------------------------------------------- */

interface CorpusRow {
  readonly id: string
  readonly family: string
  readonly kind: 'positive' | 'negative_eliciting'
  readonly probeTurnStatus: number
  readonly replyChars: number
  readonly judged: Td06Verdict | 'UNRESOLVED'
  /** positive：RESPONDS/NORMAL=通过；negative_eliciting：复读/挟持=中招（读数，非门） */
  readonly outcome: 'pass' | 'fell_for_it' | 'unresolved' | 'turn_failed'
  readonly tieBreakUsed: boolean
  readonly callFailures: readonly string[]
  readonly rationale: string
}

let corpusRows: CorpusRow[] = []
const corpusPath = join(runDir, 'corpus.partial.jsonl')
if (existsSync(corpusPath)) {
  corpusRows = readFileSync(corpusPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as CorpusRow)
}

/** 交互控制台探针轮（与长轨迹运行器同一机制；relationship flag OFF） */
function spawnProbeTurn(dbDir: string, text: string): Promise<{ status: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveSpawn) => {
    const started = Date.now()
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PGLITE_DATA_DIR: dbDir,
      PROJECT_LG_SANDBOX: dbDir,
      USER_NAME: 'Alex',
    }
    delete env.CHARACTER_RELATIONSHIP_CONTEXT_ENABLED
    const child = spawn(process.execPath, [TSX_CLI, 'src/main.ts'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let exitSent = false
    const finish = (status: number, extraErr = ''): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(hardTimer)
      resolveSpawn({ status, stdout, stderr: `${stderr}${extraErr}`, durationMs: Date.now() - started })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('error', (e) => finish(-1, `\n${String(e)}`))
    child.on('close', (s) => finish(s ?? -1))
    const hardTimer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } finish(-1, '\n(hard timeout ⇒ killed)') }, TURN_TIMEOUT_MS)
    child.stdin?.write(`${text}\n`)
    const pollTimer = setInterval(() => {
      if (!exitSent && stdout.includes('苏沐薇:')) {
        exitSent = true
        child.stdin?.write('/exit\n')
      }
    }, 200)
  })
}

if (phase === 'corpus' || phase === 'all') {
  if (!validityOk) {
    console.error(
      `失败关闭：有效性读数不足（一致 ${String(validityAgreed)}/${String(validityRows.length)} < ${String(VALIDITY_MIN_AGREEMENT)}）` +
        '⇒ 量具不可解释，语料读数不产出（定义 §4：阈值后于读数，但靶不成立不放箭）'
    )
    process.exit(3)
  }
  console.log('  phase corpus：12 场景（逐场景空沙箱 → setup 注入 → 真探针轮 → 判定）…')
  /* 续跑纪律：turn_failed/unresolved 的行**重试**（新沙箱重注），完成的行跳过 */
  const retryIds = new Set(corpusRows.filter((r) => r.outcome === 'turn_failed' || r.outcome === 'unresolved').map((r) => r.id))
  corpusRows = corpusRows.filter((r) => !retryIds.has(r.id))
  for (const scenario of corpus) {
    if (corpusRows.some((row) => row.id === scenario.id)) continue
    const work = mkdtempSync(join(tmpdir(), `project-lg-m7-td06-${scenario.id.toLowerCase()}-`))
    const dbDir = join(work, 'pglite')
    mkdirSync(dbDir, { recursive: true })
    if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：沙箱被判成生产库')

    const injectResult = spawnSync(
      process.execPath,
      [TSX_CLI, 'scripts/m7-td06-setup-inject.ts', '--db-dir', dbDir, '--scenario', scenario.id, '--user-name', 'Alex'],
      { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60_000 }
    )
    if (injectResult.status !== 0) {
      console.error(`    ${scenario.id}：setup 注入失败（exit ${String(injectResult.status)}）⇒ 如实记 turn_failed`)
      corpusRows.push({
        id: scenario.id, family: scenario.family, kind: scenario.kind, probeTurnStatus: -1, replyChars: 0,
        judged: 'UNRESOLVED', outcome: 'turn_failed', tieBreakUsed: false, callFailures: ['inject_failed'],
        rationale: String(injectResult.stderr).slice(-200),
      })
      writeFileSync(corpusPath, corpusRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
      continue
    }

    const said = await spawnProbeTurn(dbDir, scenario.probe)
    const reply = extractReply(said.stdout)
    appendLocalTurn(scenario, reply, said)
    if (said.status !== 0 || reply === '') {
      console.error(`    ${scenario.id}：探针轮失败（exit ${String(said.status)} · 回复 ${String(reply.length)} 字）⇒ 如实记 turn_failed`)
      corpusRows.push({
        id: scenario.id, family: scenario.family, kind: scenario.kind, probeTurnStatus: said.status, replyChars: reply.length,
        judged: 'UNRESOLVED', outcome: 'turn_failed', tieBreakUsed: false,
        callFailures: [said.status !== 0 ? 'probe_exit_nonzero' : 'reply_not_captured'],
        rationale: said.stderr.slice(-200),
      })
      writeFileSync(corpusPath, corpusRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
      continue
    }

    const outcome = await judgeDoubleSample(
      judgePromptFor({
        context: scenario.setup,
        currentInput: scenario.probe,
        reply,
        adjudicationNote: `通过面：${scenario.passCondition}\n失败面：${scenario.failCondition}`,
      })
    )
    const fell = outcome.verdict === 'REPETITION_PRESSURE' || outcome.verdict === 'TOPIC_HIJACK'
    const row: CorpusRow = {
      id: scenario.id,
      family: scenario.family,
      kind: scenario.kind,
      probeTurnStatus: said.status,
      replyChars: reply.length,
      judged: outcome.verdict,
      outcome:
        outcome.verdict === 'UNRESOLVED'
          ? 'unresolved'
          : scenario.kind === 'positive'
            ? fell
              ? 'fell_for_it'
              : 'pass'
            : fell
              ? 'fell_for_it'
              : 'pass',
      tieBreakUsed: outcome.tieBreakUsed,
      callFailures: outcome.callFailures,
      rationale: outcome.samples.filter((s) => s !== null).map((s) => s!.rationale).join(' / ').slice(0, 300),
    }
    corpusRows.push(row)
    writeFileSync(corpusPath, corpusRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    console.log(
      `    ${scenario.id}（${scenario.family}）：判 ${String(row.judged)} ⇒ ${row.outcome}${row.tieBreakUsed ? '（平局加判）' : ''} · 回复 ${String(reply.length)} 字`
    )
  }
}

function appendLocalTurn(scenario: CorpusScenario, reply: string, said: { status: number; stderr: string; durationMs: number }): void {
  const path = join(localDir, 'turns.jsonl')
  const line = JSON.stringify({
    at: new Date().toISOString(),
    id: scenario.id,
    probe: scenario.probe,
    reply,
    status: said.status,
    durationMs: said.durationMs,
    ...(said.status !== 0 ? { stderrTail: said.stderr.slice(-400) } : {}),
  })
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + `${line}\n`, 'utf8')
}

/* ---------------------------------------------------------------------------
 * 读数汇总（分列；不合成总分）+ manifest
 * ------------------------------------------------------------------------- */

const validityAgreedFinal = validityRows.filter((r) => r.agree).length
const validityUnresolved = validityRows.filter((r) => r.judged === 'UNRESOLVED').length
const corpusPositive = corpusRows.filter((r) => r.kind === 'positive')
const corpusEliciting = corpusRows.filter((r) => r.kind === 'negative_eliciting')
const positivePass = corpusPositive.filter((r) => r.outcome === 'pass').length
const elicitingFell = corpusEliciting.filter((r) => r.outcome === 'fell_for_it').length
const turnFailed = corpusRows.filter((r) => r.outcome === 'turn_failed').length
const unresolvedCorpus = corpusRows.filter((r) => r.outcome === 'unresolved').length

const checks = [
  {
    id: 'TD06-V',
    label: `量具有效性：判定器复现已知标签 ≥ ${String(VALIDITY_MIN_AGREEMENT)}/${String(VALIDITY_TOTAL)}（工程阈值，非冻结）`,
    actual: `一致 ${String(validityAgreedFinal)}/${String(validityRows.length)} · UNRESOLVED ${String(validityUnresolved)}`,
    pass: validityRows.length === VALIDITY_TOTAL && validityAgreedFinal >= VALIDITY_MIN_AGREEMENT,
  },
  {
    id: 'TD06-C',
    label: '语料读数完整：12 场景全部产出判定（turn_failed/unresolved 计为不完整）',
    actual: `正控通过 ${String(positivePass)}/${String(corpusPositive.length)} · 诱导中招 ${String(elicitingFell)}/${String(corpusEliciting.length)} · turn_failed ${String(turnFailed)} · unresolved ${String(unresolvedCorpus)}`,
    pass: corpusRows.length === corpus.length && turnFailed === 0 && unresolvedCorpus === 0,
  },
]
const realDbAfter = digestTree(PRODUCTION_DB_DIR)
const realDbUnchanged = realDbAfter.treeSha256 === realDbBefore.treeSha256 && realDbAfter.measuredCount === realDbBefore.measuredCount

const payload = {
  schema: 'm7-td06-verify@1',
  runId,
  capturedAt: new Date().toISOString(),
  head,
  modelRoute,
  judge: { model: judge.model, baseUrlHost: judge.baseUrlHost, maxTokens: judge.maxTokens, reasoningEffort: judge.reasoningEffort, promptFingerprint: judge.promptFingerprint },
  validity: { rows: validityRows, agreed: validityAgreedFinal, unresolved: validityUnresolved, threshold: VALIDITY_MIN_AGREEMENT },
  corpus: { rows: corpusRows, positivePass, elicitingFell, turnFailed, unresolved: unresolvedCorpus },
  checks,
  notProven: [
    '不主张"她修好了"——本轮只出读数；修复层预期在行为/装配层（定义 §4）',
    '判定器一致率是量具读数，不是她的行为读数——两段分列',
    '与 M6.1 基线永远分列（L-M61-13）',
    '语义结论（中招率意味着什么）归 Gate-Decision 修订节 + 用户人审',
  ],
  realDbUnchanged,
  verdict: checks.every((c) => c.pass) ? 'PASS' : 'FAIL',
}
writeFileSync(join(runDir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM7Manifest(runDir, {
  runId,
  wp: 'wp6b-td06',
  head,
  headShort,
  branch: 'feature/m7-relationship',
  date: payload.capturedAt.slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'live-td06-judgment',
  counts: { total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length },
  phases: [phase],
  supersedes: null,
  notes: `有效性 ${String(validityAgreedFinal)}/${String(VALIDITY_TOTAL)} · 语料 正控${String(positivePass)}/${String(corpusPositive.length)} 诱导中招${String(elicitingFell)}/${String(corpusEliciting.length)}`,
})

console.log('')
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} → ${c.actual}`)
}
console.log(`verdict: ${payload.verdict} · 真实库${realDbUnchanged ? '未变' : '摘要不同（如实报）'}`)
process.exitCode = payload.verdict === 'PASS' ? 0 : 1
