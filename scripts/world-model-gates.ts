/** Read existing evidence only; no database, model calls or combined benefit score. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const local = join(root, 'artifacts/post-lv2/local')
const specs = [
  { gate: 'worldmodel:application:verify', domain: 'stage0', dir: 'world-model-application',
    sources: ['evals/world-model-application/verify.ts'] },
  { gate: 'worldmodel:forecast:verify', domain: 'tool_task', dir: 'world-model-action-forecast',
    sources: ['scripts/world-model-action-forecast-verify.ts', 'src/kernel/action/action-forecast.ts', 'src/kernel/action/task-loop.ts'] },
  { gate: 'worldmodel:reflection:verify', domain: 'reflection', dir: 'world-model-reflection-comparison',
    sources: ['scripts/world-model-reflection-comparison-verify.ts', 'src/kernel/app/reflection/outcome-comparison.ts', 'src/infrastructure/model/openai-reflection.ts'] },
  { gate: 'worldmodel:reflection:e2e', domain: 'reflection', dir: 'world-model-reflection-e2e',
    sources: ['scripts/world-model-reflection-e2e-verify.ts', 'scripts/postgresql/test-harness.ts', 'src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/persistence/reflection-comparison-source.ts'], postgres: true },
  { gate: 'worldmodel:tools:ab', domain: 'tool_task', dir: 'world-model-tools-ab-v2', live: true,
    sources: ['scripts/world-model-tools-ab.ts', 'scripts/world-model/isolated-bed.ts', 'src/kernel/action/task-loop.ts', 'src/kernel/action/action-forecast.ts', 'src/infrastructure/model/openai-action-forecast.ts', 'src/infrastructure/model/openai-task-planner.ts'] },
  { gate: 'worldmodel:reflection:ab', domain: 'reflection', dir: 'world-model-reflection-ab-v2', live: true,
    sources: ['scripts/world-model-reflection-ab.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/kernel/app/reflection/outcome-comparison.ts', 'src/kernel/contracts/reflection.ts'] },
] as const

type State = 'PASS' | 'FAIL' | 'NOT RUN' | 'INVALID'
function assess(evidence: Record<string, any>, spec: { sources: readonly string[]; postgres?: boolean; live?: boolean }, hash = fileHash): { state: State; detail: string } {
  const hashes = evidence.sourceHashes
  if (hashes === null || typeof hashes !== 'object' || Array.isArray(hashes) ||
    spec.sources.some(file => typeof hashes[file] !== 'string')) {
    return { state: 'INVALID', detail: '缺少必需源码指纹' }
  }
  for (const [file, expected] of Object.entries(hashes)) {
    // Never follow arbitrary evidence paths outside the checkout.
    const path = resolve(root, file)
    if (!path.startsWith(root + '\\') && !path.startsWith(root + '/')) return { state: 'INVALID', detail: '源码路径越界' }
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || hash(file) !== expected) {
      return { state: 'INVALID', detail: `源码指纹失配: ${file}` }
    }
  }
  if (spec.postgres && evidence.backend !== 'postgres') return { state: 'INVALID', detail: '需要隔离 PostgreSQL；历史 PGlite 不接纳为当前验收' }
  if (evidence.status !== 'PASS' && evidence.status !== 'FAIL') return { state: 'INVALID', detail: '缺少有效执行状态' }
  if (!spec.live && (!Array.isArray(evidence.checks) || evidence.checks.length === 0 ||
    (evidence.status === 'PASS' && evidence.checks.some((row: any) => row.pass === false)))) {
    return { state: 'INVALID', detail: '机械面检查缺失或与状态矛盾' }
  }
  if (spec.live) {
    const rows = evidence.segments?.heldout?.rows
    if (!Array.isArray(rows) || rows.length !== 8) return { state: 'NOT RUN', detail: '没有完整的八例留出段' }
    if (rows.some((row: any) => row.off?.transportFailure || row.on?.transportFailure)) return { state: 'FAIL', detail: '真实模型调用失败，不能算模型收益' }
    if (!evidence.acquisitionComplete) return { state: 'FAIL', detail: '模型调用未完整采集' }
  }
  return { state: evidence.status, detail: spec.live ? '对照已执行；收益与代价须读分域报告' : `机械面 ${evidence.checks?.length ?? '?'} 项` }
}
function fileHash(file: string): string | undefined {
  const path = join(root, file)
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined
}

if (process.argv.includes('--verify')) {
  const digest = 'a'.repeat(64)
  const spec = { sources: ['src/example.ts'], postgres: true }
  const valid = { status: 'PASS', backend: 'postgres', checks: [{ id: 'fixture' }], sourceHashes: { 'src/example.ts': digest } }
  const grade = (e: Record<string, any>) => assess(e, spec, () => digest).state
  assert.equal(grade(valid), 'PASS')
  assert.equal(grade({ ...valid, status: 'FAIL' }), 'FAIL')
  assert.equal(grade({ ...valid, sourceHashes: {} }), 'INVALID')
  assert.equal(grade({ ...valid, sourceHashes: { 'src/example.ts': 'b'.repeat(64) } }), 'INVALID')
  assert.equal(grade({ ...valid, backend: 'pglite' }), 'INVALID')
  assert.equal(grade({ ...valid, status: undefined }), 'INVALID')
  const live = { ...valid, acquisitionComplete: true, segments: { heldout: { rows: Array.from({ length: 8 }, () => ({ off: {}, on: {} })) } } }
  assert.equal(assess(live, { ...spec, live: true }, () => digest).state, 'PASS')
  live.segments.heldout.rows[0] = { off: { transportFailure: true }, on: {} }
  assert.equal(assess(live, { ...spec, live: true }, () => digest).state, 'FAIL')
  assert.equal(grade(valid), 'PASS') // restored positive control
  console.log('PASS evidence controls 9/9')
} else {
  const readings = specs.map(spec => {
    const dir = join(local, spec.dir)
    const runs = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []
    const latest = runs.at(-1)
    let result: { state: State; detail: string } = { state: 'NOT RUN', detail: '没有证据' }
    let evidence: string | undefined
    if (latest) {
      evidence = join(dir, latest, 'live' in spec ? 'ab.json' : 'verification.json')
      try { result = assess(JSON.parse(readFileSync(evidence, 'utf8')), spec) }
      catch { result = { state: 'INVALID', detail: '最新证据缺失或损坏；不回选较早 PASS' } }
    }
    return { gate: spec.gate, domain: spec.domain, lane: 'live' in spec ? 'live' : 'offline', ...result, evidence }
  })
  const requireLive = process.argv.includes('--require-live')
  const blocking = readings.filter(row => (row.lane === 'offline' || requireLive) && row.state !== 'PASS')
  const report = { schema: 'world-model-gates@2', readings, blockingFailures: blocking.map(row => row.gate), note: 'execution status is not a benefit score' }
  const out = join(local, 'world-model-gates', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'gates.json'), JSON.stringify(report, null, 2) + '\n')
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else readings.forEach(row => console.log(`${row.domain} ${row.state} ${row.gate}: ${row.detail}`))
  process.exitCode = blocking.length === 0 ? 0 : 1
}
