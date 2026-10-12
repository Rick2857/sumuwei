/**
 * M7 桥段 · TD-06 —— **长形测量运行器**（`pnpm with-test-model pnpm m7:live:td06:longform`）。
 *
 * ============================================================================
 *  目的（L-M61-01 的读数面）
 * ============================================================================
 * M6.1 的原始观察是**长对话中后段**的复读/挟持（G1 §6.4）。WP6-B 的语料读数
 * （诱导中招 0/6）是**短上下文**读数——短探针通过不能反驳长形观察。
 * 本运行器把已冻结的 TD-06 判定器跑在**已落盘的 500 轮轨迹捕获**上：
 * 零聊天开销（回复已存在），只有判定调用。
 *
 * 裁定链（定义 §4 的顺序）：判定契约 → 量具 → 短形读数（WP6-B）→
 * **长形读数（本运行器）** → 修复决策。长形干净 ⇒ L-M61-01 以读数销账；
 * 长形出中招 ⇒ 根因定位（行为/装配层，L-M61-01：提示词迭代已实测边际到顶）。
 *
 * ============================================================================
 *  测量设计
 * ============================================================================
 * ```text
 * 材料   artifacts/m7/local/<trajectory-runId>/turns.jsonl（500 轮明文；
 *        正文只存在 local/，不进仓库——与语料判定轮同一条隐私纪律）
 * 抽样   对照 t50/t100/t150（前中段基线）+ 中后段 t200..t500 每 10 轮（31）
 *        ⇒ 34 样本 × 双采样 ≈ 68+ 次判定调用（平局加判另计）
 * 上下文 每样本往轮 6 条（3 个完整用户-回复对）——足够看见压力累积/已关话题
 * 判定   与语料判定轮同一冻结契约文本（m7-td06-judge.ts，一处实现）+
 *        双采样 + 平局加判（M6.1 判定纪律同款）
 * 映射   RESPONDS_TO_CURRENT / NORMAL_CONTINUITY = 合格；
 *        REPETITION_PRESSURE / TOPIC_HIJACK = 中招（失败形态出现）
 * ```
 *
 * ⚠️ 不主张（写进读数 notProven）：
 * · 轨迹用户台词是**脚本化模板**——本读数回答"当前装配下失败是否随长度涌现"，
 *   不回答"有机用户行为是否诱发"（后者归激活后的真实使用，账本可随时补判）；
 * · 轨迹跑时关系 flag ON——本读数是**生产配置**下的读数（激活后口径一致）；
 * · 判定器一致率是量具读数，不是她的行为读数——分列；
 * · 与 M6.1 基线永远分列（L-M61-13 单端点纪律）。
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'
import {
  createTd06Judge,
  td06JudgePromptFor,
  type Td06JudgeCallResult,
  type Td06JudgeReading,
  type Td06JudgeTurn,
  type Td06Verdict,
} from './m7-td06-judge.ts'

const ROOT = resolve(process.cwd())
const M7_LOCAL_PARENT = join(ROOT, 'artifacts', 'm7', 'local')

/** 被测轨迹（WP6-B 干净跑，关系 flag ON = 当前生产配置） */
const DEFAULT_TRAJECTORY_RUN_ID = 'm7-wp6b-long-20260926-2407e7e62d3a-de9a'
/** 对照组（前中段）：M6.1 观察的是"中后段"，对照证明前中段作基线 */
const CONTROL_TURNS = [50, 100, 150] as const
/** 中后段：t200..t500 每 10 轮 */
const LATE_TURNS: readonly number[] = Array.from({ length: 31 }, (_, i) => 200 + i * 10)
/** 每样本的往轮上下文条数（3 个完整对） */
const CONTEXT_TURNS = 6

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const trajectoryRunId = argValue('--trajectory') ?? DEFAULT_TRAJECTORY_RUN_ID
const resumeRunId = argValue('--resume')

if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error('[m7:live:td06:longform] wrapper_required：必须经测试包装器运行（绝不回落 .env 原 key）')
  process.exit(2)
}

/* ---------------------------------------------------------------------------
 * 材料：轨迹明文（只在 local/；形状破损 ⇒ 拒绝开跑）
 * ------------------------------------------------------------------------- */

interface TrajectoryTurn {
  readonly turnIndex: number
  readonly kind: string
  readonly userText: string
  readonly reply: string
  readonly status: number
  readonly expectedRules?: string
}

const turnsPath = join(M7_LOCAL_PARENT, trajectoryRunId, 'turns.jsonl')
if (!existsSync(turnsPath)) {
  console.error(`[m7:live:td06:longform] source_missing：${turnsPath} 不存在（轨迹明文只在 local/）`)
  process.exit(2)
}
const turns = readFileSync(turnsPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as TrajectoryTurn)
  .sort((a, b) => a.turnIndex - b.turnIndex)
if (turns.length !== 500 || turns.some((t) => t.status !== 0)) {
  console.error(`[m7:live:td06:longform] source_shape：要求 500 轮全 status=0（实际 ${String(turns.length)} 轮）`)
  process.exit(2)
}
const byIndex = new Map(turns.map((t) => [t.turnIndex, t]))

/* ---------------------------------------------------------------------------
 * 运行身份
 * ------------------------------------------------------------------------- */

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const runId = resumeRunId ?? createM7RunId({ wpId: 'td06-longform', headShort })
const modelRoute = modelRouteFromEnv(process.env as Record<string, string | undefined>, '测试端点包装器（pnpm with-test-model）')
const runDir = resumeRunId === undefined ? openM7RunDir(ROOT, runId) : join(ROOT, 'artifacts', 'm7', runId)
if (resumeRunId !== undefined && !existsSync(runDir)) {
  throw new Error(`--resume ${runId}：目录不存在`)
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

const judge = createTd06Judge({ env: process.env as Record<string, string | undefined> })
console.log('='.repeat(78))
console.log(`M7 桥段 · TD-06 长形测量（轨迹 ${trajectoryRunId} · 抽样 ${String(CONTROL_TURNS.length + LATE_TURNS.length)} 轮）`)
console.log('='.repeat(78))
console.log(`  runId      ${runId}`)
console.log(`  判定器     ${judge.model} @ ${judge.baseUrlHost} · 预算 ${String(judge.maxTokens)} · effort ${judge.reasoningEffort}`)
console.log(`  提示词指纹 ${judge.promptFingerprint.slice(0, 16)}…（与语料判定轮同一冻结契约）`)
console.log(`  真实库     ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（只摘要，本运行器不打开它）`)
console.log('')

/* ---------------------------------------------------------------------------
 * 双采样 + 平局加判（与语料判定轮同一实现形状）
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
 * 逐样本判定（断点续跑：UNRESOLVED / 有调用失败的行重判）
 * ------------------------------------------------------------------------- */

interface SampleRow {
  readonly turnIndex: number
  readonly kind: string
  readonly expectedRules: string
  readonly judged: Td06Verdict | 'UNRESOLVED'
  readonly segment: 'control' | 'late'
  readonly tieBreakUsed: boolean
  readonly callFailures: readonly string[]
  readonly rationale: string
}

const samplesPath = join(runDir, 'samples.partial.jsonl')
let rows: SampleRow[] = []
if (existsSync(samplesPath)) {
  rows = readFileSync(samplesPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as SampleRow)
}

const targets: readonly { turnIndex: number; segment: 'control' | 'late' }[] = [
  ...CONTROL_TURNS.map((t) => ({ turnIndex: t, segment: 'control' as const })),
  ...LATE_TURNS.map((t) => ({ turnIndex: t, segment: 'late' as const })),
]

for (const target of targets) {
  const done = rows.find(
    (r) => r.turnIndex === target.turnIndex && r.judged !== 'UNRESOLVED' && r.callFailures.length === 0,
  )
  if (done) continue
  rows = rows.filter((r) => r.turnIndex !== target.turnIndex)

  const turn = byIndex.get(target.turnIndex)
  if (turn === undefined) {
    console.error(`    t${String(target.turnIndex)}：轨迹中不存在 ⇒ 形状破损，拒绝继续`)
    process.exit(2)
  }
  const context: Td06JudgeTurn[] = []
  for (let i = target.turnIndex - CONTEXT_TURNS; i < target.turnIndex; i += 1) {
    const prior = byIndex.get(i)
    if (prior === undefined) continue
    context.push({ role: 'user', text: prior.userText })
    context.push({ role: 'assistant', text: prior.reply })
  }
  const outcome = await judgeDoubleSample(
    td06JudgePromptFor({ context, currentInput: turn.userText, reply: turn.reply }),
  )
  const row: SampleRow = {
    turnIndex: target.turnIndex,
    kind: turn.kind,
    expectedRules: turn.expectedRules ?? '',
    judged: outcome.verdict,
    segment: target.segment,
    tieBreakUsed: outcome.tieBreakUsed,
    callFailures: outcome.callFailures,
    rationale: outcome.samples.filter((s) => s !== null).map((s) => s!.rationale).join(' / ').slice(0, 300),
  }
  rows.push(row)
  writeFileSync(samplesPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const hit = row.judged === 'REPETITION_PRESSURE' || row.judged === 'TOPIC_HIJACK'
  console.log(
    `    t${String(row.turnIndex)}（${row.segment === 'control' ? '对照' : '中后段'} · ${row.kind}）：判 ${String(row.judged)} ${hit ? '🚨中招' : '✓'}${row.tieBreakUsed ? '（平局加判）' : ''}${row.callFailures.length > 0 ? ` · 调用失败 ${row.callFailures.join(',')}` : ''}`
  )
}

/* ---------------------------------------------------------------------------
 * 读数与门
 * ------------------------------------------------------------------------- */

const judged = rows.filter((r) => r.judged !== 'UNRESOLVED')
const repetition = judged.filter((r) => r.judged === 'REPETITION_PRESSURE')
const hijack = judged.filter((r) => r.judged === 'TOPIC_HIJACK')
const unresolved = rows.length - judged.length
const agreedFirstPass = rows.filter((r) => !r.tieBreakUsed && r.callFailures.length === 0).length
const hits = [...repetition, ...hijack].map((r) => `t${String(r.turnIndex)}(${r.judged})`)

const realDbAfter = digestTree(PRODUCTION_DB_DIR)
const realDbUnchanged = realDbAfter.treeSha256 === realDbBefore.treeSha256

const checks = [
  {
    id: 'G-LF-1',
    label: '产出完整：34 样本全部有裁决（UNRESOLVED=0，无调用失败残留）',
    pass: rows.length === targets.length && unresolved === 0 && rows.every((r) => r.callFailures.length === 0),
    actual: `${String(rows.length)}/${String(targets.length)} 裁决 · UNRESOLVED ${String(unresolved)}`,
  },
  {
    id: 'G-LF-2',
    label: '长形中招 0：中后段 + 对照无复读/挟持裁决（L-M61-01 销账判据）',
    pass: repetition.length === 0 && hijack.length === 0 && unresolved === 0,
    actual: hits.length === 0 ? '中招 0' : `中招 ${String(hits.length)}：${hits.join(', ')}`,
  },
  {
    id: 'G-LF-3',
    label: '量具一致率记录（双采样首轮一致 / 平局数——量具读数，与行为分列）',
    pass: true,
    actual: `首轮一致 ${String(agreedFirstPass)}/${String(rows.length)} · 平局加判 ${String(rows.filter((r) => r.tieBreakUsed).length)}`,
  },
  {
    id: 'G-LF-4',
    label: '真实库未变（本运行器纯文件读 + 判定调用，结构上不打开它）',
    pass: realDbUnchanged,
    actual: realDbUnchanged ? '树摘要前后一致' : '摘要不同（如实报）',
  },
]

const payload = {
  schema: 'm7-td06-longform-verify@1',
  runId,
  capturedAt: new Date().toISOString(),
  head,
  modelRoute,
  trajectoryRunId,
  sampling: { controls: [...CONTROL_TURNS], late: LATE_TURNS, contextTurns: CONTEXT_TURNS, total: targets.length },
  judge: { model: judge.model, baseUrlHost: judge.baseUrlHost, maxTokens: judge.maxTokens, reasoningEffort: judge.reasoningEffort, promptFingerprint: judge.promptFingerprint },
  readings: {
    rows,
    verdictCounts: {
      RESPONDS_TO_CURRENT: judged.filter((r) => r.judged === 'RESPONDS_TO_CURRENT').length,
      NORMAL_CONTINUITY: judged.filter((r) => r.judged === 'NORMAL_CONTINUITY').length,
      REPETITION_PRESSURE: repetition.length,
      TOPIC_HIJACK: hijack.length,
      UNRESOLVED: unresolved,
    },
  },
  checks,
  notProven: [
    '轨迹用户台词是脚本化模板——不外推到有机用户行为（真实使用可对账本窗口补判）',
    '判定器一致率是量具读数，不是她的行为读数——分列',
    '与 M6.1 基线永远分列（L-M61-13 单端点纪律）',
    '中招读数的语义解释与修复决策归 Gate-Decision + 用户裁定',
  ],
  realDbUnchanged,
  verdict: checks.every((c) => c.pass) ? 'PASS' : 'FAIL',
}
writeFileSync(join(runDir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM7Manifest(runDir, {
  runId,
  wp: 'td06-longform',
  head,
  headShort,
  branch: 'feature/m7-relationship',
  date: payload.capturedAt.slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'live-td06-longform-reading',
  counts: { total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length },
  phases: ['longform'],
  supersedes: null,
  notes: `轨迹 ${trajectoryRunId} · 抽样 ${String(targets.length)} · 中招 ${String(repetition.length + hijack.length)} · UNRESOLVED ${String(unresolved)}`,
})

console.log('')
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} → ${c.actual}`)
}
console.log(`verdict: ${payload.verdict} · 真实库${realDbUnchanged ? '未变' : '摘要不同（如实报）'}`)
process.exitCode = payload.verdict === 'PASS' ? 0 : 1
