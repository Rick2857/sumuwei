/**
 * **F1 封存用的门读数索引（gate-bundle@1）**
 *
 * 把本批**实际跑过**的门报告合成一份机器可读索引：每条门读数记录
 * `{id, status, checks, covers?, sources:[{path, sha256}]}`。
 * 封存器（`f1-live-runner.ts --seal`）会：
 *   ① 复核索引里**每一份**来源文件的 sha256（漂移 ⇒ 拒绝封存）；
 *   ② 要求每个预注册门 id 都存在且 `status === 'PASS'`（缺项/非 PASS ⇒ 拒绝封存）。
 *
 * ⚠️ 这里**不**发明读数：只读文件里已经写下的 `status` / `checks` / `measured_count`。
 *    某个门没跑过 ⇒ 直接抛错（不生成"看起来完整"的索引）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileDigestOrMissing, sha256Text } from './f1-live-runner-guards.ts'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const slash = (value: string): string => value.split('\\').join('/')
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
const sourceOf = (path: string): { path: string; sha256: string } => ({ path: slash(path), sha256: fileDigestOrMissing(resolve(path)) })

const batchDir = arg('--batch') ?? 'artifacts/cognitive/local/f1-g8g9-20261025'
const bundlePath = resolve(arg('--output') ?? join(batchDir, 'gate-bundle.json'))

interface GateEntry {
  id: string
  status: 'PASS' | 'FAIL' | 'NOT RUN' | 'INVALID' | 'MISSING'
  checks: number | null
  covers?: string[]
  sources: Array<{ path: string; sha256: string }>
}

const checksOf = (value: unknown): number | null => {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function latestDir(parent: string, prefix: string): string | undefined {
  if (!existsSync(parent)) return undefined
  const names = readdirSync(parent)
    .filter(name => name.startsWith(`${prefix}-`) && existsSync(resolve(parent, name, 'verification.json')))
    .sort()
  return names.length === 0 ? undefined : join(parent, names[names.length - 1]!)
}

function gateFromFile(id: string, path: string, covers?: string[]): GateEntry {
  if (!existsSync(resolve(path))) throw new Error(`门 ${id} 的报告不存在：${path}（没有读数就不封存）`)
  const file = readJson(path)
  const status = (file.status ?? 'MISSING') as GateEntry['status']
  return {
    id, status,
    checks: checksOf(file.checks) ?? checksOf(file.measured_count),
    ...(covers === undefined ? {} : { covers }),
    sources: [sourceOf(path)],
  }
}

function gateFromFiles(id: string, paths: string[], covers?: string[]): GateEntry {
  const missing = paths.filter(path => !existsSync(resolve(path)))
  if (missing.length > 0) throw new Error(`门 ${id} 缺少报告：${missing.join(', ')}（没有读数就不封存）`)
  const files = paths.map(path => readJson(path))
  const status = files.every(file => file.status === 'PASS') ? 'PASS' : 'FAIL'
  const total = files.reduce((sum, file) => sum + (checksOf(file.checks) ?? checksOf(file.measured_count) ?? 0), 0)
  return {
    id, status, checks: files.length, ...(covers === undefined ? {} : { covers }),
    sources: paths.map(sourceOf),
  }
}

// ---------------------------------------------------------------------------
// 各门：路径都是既有门的**既定落盘位置**（不另造读数）
// ---------------------------------------------------------------------------
const gates: GateEntry[] = []
gates.push(gateFromFile('G1_common_assembly', 'artifacts/local/f1-three-arm-parity/verification.json', ['G1']))
gates.push(gateFromFiles('G2_timing_calibration',
  ['w01', 'w02', 'w03'].map(world => `artifacts/local/f1-readiness/${world}/report.json`), ['G2']))
const controlPaths = ['readback-withdrawal', 'family-withdrawal', 'marker-ownership', 'readback-evidence-change']
  .map(name => {
    const directory = latestDir('artifacts/local/f1-prereg-negative-controls', name)
    return directory === undefined ? undefined : join(directory, 'verification.json')
  })
if (controlPaths.some(item => item === undefined)) {
  throw new Error(`G3–G7 的四个破坏性控制报告不全：${controlPaths.map(item => item ?? 'MISSING').join(', ')}`)
}
gates.push(gateFromFiles('G3_G7_destructive_controls', controlPaths as string[], ['G3', 'G4', 'G5', 'G6', 'G7']))
gates.push(gateFromFile('G8_runner_guards', 'artifacts/local/f1-runner-guards/verification.json', ['G8']))
gates.push(gateFromFile('G9_quota_and_parameters', 'artifacts/local/f1-quota-params/verification.json', ['G9']))

// 额外产品门（C2 形成 / D 集成否决 / R1 可达性）：有就跑过、就一起绑；缺了就不声称
const extraCandidates = [
  latestDir('artifacts/local/f1-precondition-formation', 'postgres'),
  latestDir('artifacts/local/f1-precondition-veto-integration', 'postgres'),
  latestDir('artifacts/local/f1-precondition-reachability', 'postgres'),
].filter((path): path is string => path !== undefined)
if (extraCandidates.length === 3) {
  const entry = gateFromFiles('extra_product_gates', extraCandidates.map(path => join(path, 'verification.json')),
    ['C2_formation', 'D_integration_veto', 'R1_reachability'])
  gates.push(entry)
}

const ciPath = 'artifacts/cognitive/local/ci-run.json'
if (!existsSync(resolve(ciPath))) throw new Error(`完整 CI 读数不存在：${ciPath}`)
const ci = readJson(ciPath)
const ciStatus = ci.failed === 0 && ci.notRun === 0 && ci.allMandatoryGatesRan === true ? 'PASS' : 'FAIL'
gates.push({
  id: 'full_ci', status: ciStatus,
  checks: typeof ci.passed === 'number' ? ci.passed : null,
  covers: ['m4.5:ci'], sources: [sourceOf(ciPath)],
})

const preflightPath = join(batchDir, 'preflight.json')
if (!existsSync(resolve(preflightPath))) throw new Error(`前后预检读数不存在：${preflightPath}`)
const preflight = readJson(preflightPath) as {
  before?: { exitCode?: number; checks?: number; logPath?: string }
  after?: { exitCode?: number; checks?: number; logPath?: string }
}
const preflightStatus = (entry: { exitCode?: number } | undefined): GateEntry['status'] =>
  entry?.exitCode === 0 ? 'PASS' : 'FAIL'
const preflightSources = (entry: { logPath?: string } | undefined): Array<{ path: string; sha256: string }> =>
  [preflightPath, ...(entry?.logPath === undefined ? [] : [entry.logPath])].map(sourceOf)
gates.push({ id: 'preflight_before', status: preflightStatus(preflight.before),
  checks: preflight.before?.checks ?? null, covers: ['environment'], sources: preflightSources(preflight.before) })
gates.push({ id: 'preflight_after', status: preflightStatus(preflight.after),
  checks: preflight.after?.checks ?? null, covers: ['environment'], sources: preflightSources(preflight.after) })

const bundle = {
  schema: 'f1-gate-bundle@1',
  generatedAt: new Date().toISOString(),
  note: '只索引本批实际跑过的门报告；每份来源摘要由封存器再复核一次',
  gates,
}
const text = `${JSON.stringify(bundle, null, 2)}\n`
mkdirSync(resolve(bundlePath, '..'), { recursive: true })
writeFileSync(bundlePath, text, 'utf8')

console.log(`gate-bundle -> ${bundlePath}`)
console.log(`bundleSha256=${sha256Text(text)}`)
for (const gate of gates) {
  console.log(`  ${gate.status.padEnd(5)} ${gate.id.padEnd(28)} checks=${String(gate.checks)} sources=${String(gate.sources.length)}`)
}
const bad = gates.filter(gate => gate.status !== 'PASS')
if (bad.length > 0) {
  console.error(`拒绝生成可封存索引：${bad.map(gate => `${gate.id}=${gate.status}`).join(', ')}`)
  process.exit(1)
}
