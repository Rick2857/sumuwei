import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateM11Manifest } from './m11-evidence.ts'
import { pickLatest, rankReadings, type RankInput, type SelectionBasis } from './gate-evidence-select.ts'

type Status = 'PASS' | 'FAIL' | 'INVALID' | 'NOT RUN' | 'PARTIAL'
/** 单份档的判定（**不含选档信息** —— 选档是"聚合门"的事，不是"这一份档"的事） */
interface Inspection { runId: string | null; status: Status; recordedVerdict: string | null; problems: string[] }
interface Reading extends Inspection {
  /** 这一份是按哪一段选出来的（具名，见 `gate-evidence-select.ts`）；`NOT RUN` ⇒ `none` */
  selectionBasis: SelectionBasis
  /** 与选定档**时间并列**的其它档（runId 升序）；空数组 = 无并列 */
  tiedWith: readonly string[]
}
const components = {
  wiring: 'm111-wiring', recovery: 'm111-recovery', processes: 'm111-e2e',
  oracle: 'm111-measurement', batch: 'm111-batch-controls', collector: 'm111-behavior-control',
  semantic: 'm111-semantic', behavior: 'm111-behavior-scored', short: 'm111-short-live',
  long: 'm111-long-live', sources: 'm111-source-matrix', privacyPerformance: 'm111-privacy-performance',
  joint: 'm111-joint', human: 'm111-human-review', preview: 'm111-production-preview',
} as const
export function inspectM111Run(root: string, runId: string, manifest: any): Inspection {
  const problems = validateM11Manifest(manifest).map(row => `${row.field}: ${row.problem}`)
  if (manifest?.runId !== runId) problems.push('run identity does not match directory')
  if (manifest?.injection) problems.push('injection evidence is not a current acceptance run')
  if (manifest?.cleanClose !== true) problems.push('clean close not confirmed')
  const counts = manifest?.counts
  if (!counts || counts.passed < 0 || counts.failed < 0 || counts.passed + counts.failed !== counts.total) problems.push('invalid denominator')
  const fingerprints = manifest?.sourceFingerprints
  if (!fingerprints || typeof fingerprints !== 'object' || Object.keys(fingerprints).length === 0) problems.push('source fingerprints missing')
  else for (const [file, expected] of Object.entries(fingerprints)) {
    const path = resolve(root, file)
    const rel = relative(root, path)
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(path)) problems.push(`source unavailable: ${file}`)
    else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) problems.push(`source changed: ${file}`)
  }
  if (!Number.isInteger(manifest?.plannedRequests) || !Number.isInteger(manifest?.actualRequests) || manifest.actualRequests < 0 || manifest.actualRequests > manifest.plannedRequests) problems.push('request counts missing or inconsistent')
  const recordedVerdict = typeof manifest?.verdict === 'string' ? manifest.verdict : counts?.failed === 0 ? 'PASS' : 'FAIL'
  if (['formal-independent-semantic', 'formal-known-corpus-semantic'].includes(manifest?.testType) && (manifest.semanticCaseCount !== 160 || manifest.rounds !== 3 || counts?.total !== 480 || manifest.actualRequests !== 480 || manifest.plannedRequests !== 480)) problems.push('formal semantic batch shape is not 160 x 3')
  if (manifest?.testType === 'formal-real-candidate-short' && (counts?.total !== 12 || manifest.actualRequests !== 12 || manifest.plannedRequests !== 12)) problems.push('formal short batch denominator is not 12')
  return { runId, recordedVerdict, problems, status: problems.length ? 'INVALID' : recordedVerdict === 'PASS' ? 'PASS' : recordedVerdict === 'FAIL' ? 'FAIL' : 'PARTIAL' }
}
export function summarizeM111Evidence(root: string) {
  const parent = join(root, 'artifacts/m11.1')
  const directories = existsSync(parent) ? readdirSync(parent, { withFileTypes: true }).filter(row => row.isDirectory()) : []
  const readings = Object.fromEntries(Object.entries(components).map(([key, prefix]) => {
    const pattern = new RegExp(`^m11-${prefix}-\\d{8}-[a-f0-9]{12}-[a-f0-9]{4}$`)
    const candidates = directories.filter(row => pattern.test(row.name)).map(row => {
      const manifestPath = join(parent, row.name, 'manifest.json')
      let manifest: any
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
      return { runId: row.name, manifest, dir: join(parent, row.name), manifestPath }
    })
    /*
     * ⚠️ **选档不按 mtime**（`TD-23` / `AUD-20261005-02`）。
     *
     * 旧实现：`Date.parse(manifest.ended ?? manifest.started)`，日期**不可解析**时
     * 回退到 `statSync(目录).mtimeMs` ⇒ 复制 / 检出 / 恢复就能改变"最新一份"是谁。
     * 现在走共享的**身份优先**判据（自报结束时间 → head 提交时刻 → 证据提交时刻 →
     * 清单日期 → 具名降级），`mtime` 一个字节都不参与。
     */
    const ranked = rankReadings<(typeof candidates)[number]>(
      candidates.map(
        (candidate): RankInput<(typeof candidates)[number]> => ({
          item: candidate,
          dir: candidate.dir,
          runId: candidate.runId,
          manifest: candidate.manifest !== null && typeof candidate.manifest === 'object' ? candidate.manifest : {},
          /* m11.1 的读数**就在清单里**（`ended` / `started` / 判定都在 manifest）⇒ 无独立读数对象 */
          reading: {},
          evidencePath: candidate.manifestPath,
        })
      )
    )
    const latest = pickLatest(ranked)
    if (latest === undefined) {
      return [key, { runId: null, status: 'NOT RUN', recordedVerdict: null, problems: [], selectionBasis: 'none', tiedWith: [] }]
    }
    /*
     * ⚠️ **并列组里判定不同 ⇒ 失败关闭**（`INVALID`）：与 `m10-gates` / `m10.1:gates` 同一条纪律。
     *    `inspectM111Run` 只对**选定档与它的并列组**跑（判定要哈希指纹 ⇒ 不整档扫）。
     */
    const tieGroup = ranked.filter((row) => row.time === latest.picked.time)
    const inspectedTie = tieGroup.map((row) => ({ row, reading: inspectM111Run(root, row.runId, row.item.manifest) }))
    const pickedReading = inspectedTie.find((entry) => entry.row.runId === latest.picked.runId)!.reading
    const conflicting = inspectedTie.some((entry) => entry.reading.status !== pickedReading.status)
    if (!conflicting) {
      return [key, { ...pickedReading, selectionBasis: latest.picked.basis, tiedWith: latest.tiedWith }]
    }
    return [key, {
      ...pickedReading,
      status: 'INVALID' as Status,
      problems: [
        ...pickedReading.problems,
        `选档并列且判定不同（依据 ${latest.picked.basis}）：${[latest.picked.runId, ...latest.tiedWith].sort().join(', ')} ⇒ 归属不明（失败关闭）`,
      ],
      selectionBasis: latest.picked.basis,
      tiedWith: latest.tiedWith,
    }]
  })) as Record<keyof typeof components, Reading>
  const combine = (...keys: (keyof typeof components)[]): Status => {
    const statuses = keys.map(key => readings[key].status)
    return (['FAIL', 'INVALID', 'NOT RUN', 'PARTIAL'] as const).find(status => statuses.includes(status)) ?? 'PASS'
  }
  const gates: Record<string, Status | 'NOT OBSERVED' | 'OBSERVED'> = {
    G1: combine('wiring', 'sources'), G2: combine('wiring', 'processes'), G3: combine('recovery', 'processes'),
    G4: combine('oracle', 'batch', 'collector'), G5: combine('semantic'), G6: combine('behavior'),
    G7: 'NOT RUN', G8: combine('short', 'long'), G9: combine('privacyPerformance'),
    G10: readings.human.status === 'PASS' ? 'PARTIAL' : combine('human'), G11: combine('joint'),
  }
  if (readings.behavior.runId && ['PASS', 'FAIL'].includes(readings.behavior.status)) {
    try {
      const score = JSON.parse(readFileSync(join(parent, readings.behavior.runId, 'metrics.json'), 'utf8'))
      gates.G7 = score.valid === true && score.planned === 540 && score.actual === 540 && ['OBSERVED', 'NOT OBSERVED'].includes(score.gain) ? score.gain : 'INVALID'
    } catch { gates.G7 = 'INVALID' }
  }
  // G7 needs measured paired gains; neither successful injection nor a collected unscored batch qualifies.
  const required = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G8', 'G9', 'G11']
  return { version: 'm111-gates@1', readings, gates, required,
    overall: required.every(key => gates[key] === 'PASS') ? 'PASS' : 'NOT PASS',
    humanReview: readings.human.status, naturalFirstUse: 'NOT OBSERVED', capabilityImpact: 'NONE',
    limitation: 'Source fingerprints determine current applicability. Recorded FAIL remains visible even when the candidate changed. Missing source matrix, scored behavior, mixed-state long chain, privacy/performance or joint evidence is not accepted from narrower component controls.' }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = summarizeM111Evidence(process.cwd())
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.overall === 'PASS' ? 0 : 1)
}
