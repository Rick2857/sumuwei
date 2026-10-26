/**
 * 覆盖度**指标负控与校准门**（2026-10-23 · P2.1 第四批）
 *
 * ⚠️ 它回答的是"**哪个指标有区分力**"，不是"覆盖率是多少"。
 *    没有区分力的候选指标**舍弃**，不靠调阈值掩盖（P2.1 提案 §2 D6）。
 *
 * ⚠️ 门体在 Linux 仿真内执行，数据库场景用独立隔离库；**零真实模型调用**。
 * ⚠️ 参照仍是**代理视觉标注**（真人复核 PENDING）⇒ 本门只给**开发期校准**结论，
 *    不给"参照已被独立验收"的结论。
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { runConverter, DEFAULT_DOC_RUNNER } from '../../src/infrastructure/action/adapters/document-read.ts'
import { PDF_READERS, type PdfReader } from '../../src/kernel/contracts/document-reading.ts'
import { evaluateDocumentCoverage, documentCoverageView, type DocumentCoverageUnit } from '../../src/kernel/contracts/document-coverage.ts'
import {
  COVERAGE_METRICS, deleteNeedles, gramSet, measureResponses, padText, reflow,
  type MetricContext, type MetricResponse,
} from './document-coverage-metrics.ts'

const referencesPath = 'evals/world-model-pilot/document-reference-v3.json'
const references = JSON.parse(readFileSync(referencesPath, 'utf8')) as {
  version: string
  review: { method: string; humanReview: string }
  normalization: string
  documents: Array<{ id: string; file: string; sha256: string; units: DocumentCoverageUnit[]; renders?: Array<{ file: string; sha256: string }> }>
}
const cases = references.documents.map(document => document.id)
if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case') + 1]
const document = references.documents.find(entry => entry.id === selected)
assert.ok(document, `unknown document: ${String(selected)}`)

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const corpus = resolve(process.env.DOCUMENT_CORPUS_DIR ?? 'artifacts/local/document-corpus')
const renderRoot = resolve(process.env.DOCUMENT_REFERENCE_IMAGES ?? 'artifacts/local/p21-visual')
assert.equal(hash(readFileSync(resolve(corpus, document.file))), document.sha256, 'corpus bytes drifted from the frozen reference')
assert.ok(document.renders?.length, 'frozen independent page render references required')
for (const render of document.renders!) assert.equal(hash(readFileSync(resolve(renderRoot, render.file))), render.sha256)

const checks: string[] = []
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`) }

let active: PdfReader = 'markitdown'
let full = ''
const bed = await createDocumentReadingBed(`metric-${selected}`, { async convert(input) {
  const result = await runConverter({ ...input, pythonPath: process.env.PROJECT_LG_DOC_PYTHON!,
    runnerPath: active === 'markitdown' ? DEFAULT_DOC_RUNNER : resolve('scripts/cognitive/pdfminer-runner.py') })
  full = (result.markdown ?? '').normalize('NFKC').replace(/\r\n/g, '\n').trim()
  return result
} })

const readings = new Map<PdfReader, { full: string; delivered: string; unit: ReturnType<typeof evaluateDocumentCoverage> }>()
const rows: Array<Record<string, unknown>> = []
const admitted = new Set<string>()
try {
  const inside = resolve(bed.root, document.file)
  copyFileSync(resolve(corpus, document.file), inside)
  for (const reader of PDF_READERS) {
    active = reader; full = ''
    const outcome = await bed.run(inside, 'current', { forced: reader })
    const result = outcome?.results[0]?.result
    const item = result?.turnContent?.[0]
    check(`real authorized converter succeeded: ${reader}`, result?.executed && result.status === 'success' && outcome?.epistemicFailures === 0)
    check(`delivered body is the formal scope: ${reader}`, item?.scope.totalChars === full.length)
    readings.set(reader, { full, delivered: item!.text, unit: evaluateDocumentCoverage(item!.text, document.units) })
  }

  for (const [reader, reading] of readings) {
    const sibling = gramSet([...readings.entries()].find(([key]) => key !== reader)![1].full)
    const context: MetricContext = { units: document.units, siblingGrams: sibling }
    const observedIds = reading.unit.units.filter(unit => unit.present).map(unit => unit.id)
    const target = document.units.find(unit => unit.id === observedIds[0])
    const deletion = target ? deleteNeedles(reading.delivered, target.needles) : undefined
    const removedAll = deletion !== undefined && target !== undefined
      && deletion.removed.length === target.needles.length && deletion.missing.length === 0
    const responses: MetricResponse[] = measureResponses({
      metrics: COVERAGE_METRICS,
      baseline: reading.delivered,
      ...(removedAll ? { deleted: deletion!.text } : {}),
      padded: padText(reading.delivered, 3),
      reflowed: reflow(reading.delivered),
      context,
    })
    // ⚠️ 控制本身的自检：纯格式重排后**匹配视图必须逐字相同**。
    //    不相同 ⇒ 是控制坏了（不是指标的问题）⇒ 必须先修控制。
    check(`the format-only control preserves the matching view: ${reader}`,
      documentCoverageView(reflow(reading.delivered)) === documentCoverageView(reading.delivered))
    for (const response of responses) if (response.admitted) admitted.add(response.metric)

    const coverage = responses.find(response => response.metric === 'unit_coverage')!
    const association = responses.find(response => response.metric === 'row_association_ratio')!
    const chars = responses.find(response => response.metric === 'raw_chars')!
    const view = responses.find(response => response.metric === 'view_chars')!
    const cross = responses.find(response => response.metric === 'cross_route_gram_containment')!

    if (removedAll) {
      check(`coverage reading drops when a referenced unit is deleted: ${reader}`, coverage.deletionResponse !== null && coverage.deletionResponse > 0)
      check(`repeat padding cannot improve the coverage reading: ${reader}`, coverage.paddingResponse <= 0)
    }
    check(`format-only reflow cannot change the coverage reading: ${reader}`, coverage.reflowResponse === 0)
    check(`character magnitude is rewarded by repeat padding and rejected: ${reader}`, chars.paddingRewarded && !chars.admitted)
    check(`matching-view length is rewarded by repeat padding and rejected: ${reader}`, view.paddingRewarded && !view.admitted)
    check(`cross-route gram containment is not an independent standard: ${reader}`, !cross.admitted)

    rows.push({ reader,
      deliveredChars: reading.delivered.length, fullChars: reading.full.length,
      unitCoverage: { observed: reading.unit.observed, notObserved: reading.unit.notObserved, total: reading.unit.total,
        policyMet: reading.unit.policyMet },
      structureReading: { rows: document.units.filter(unit => unit.kind === 'row').length,
        associated: reading.unit.associated, associationUnknown: reading.unit.associationUnknown },
      fullTextUnitCoverage: evaluateDocumentCoverage(reading.full, document.units).observed,
      deletionTarget: target?.id, deletionRemoved: deletion?.removed ?? [], deletionMissing: deletion?.missing ?? [],
      deletionApplied: removedAll, responses })
  }

  check('only the independent reference metric is admitted as a coverage criterion', admitted.size === 1 && admitted.has('unit_coverage'))
} finally {
  // ⚠️ 读数**先落盘**再断言：失败的场景也留下完整诊断（不靠日志尾部猜）。
  writeFileSync(resolve(bed.output, 'metric-calibration.json'), JSON.stringify({
    status: checks.length > 0 ? 'PASS' : 'INCOMPLETE', location: 'serversim/simhost', backend: 'fresh isolated pgtest',
    referenceVersion: references.version, referenceSha256: hash(readFileSync(referencesPath)),
    referenceReview: references.review, referenceHumanReview: references.review.humanReview,
    normalization: references.normalization, document: selected, documentSha256: document.sha256,
    metricSha256: hash(readFileSync('scripts/cognitive/document-coverage-metrics.ts')),
    contractSha256: hash(readFileSync('src/kernel/contracts/document-coverage.ts')),
    checks, measured_count: checks.length, admittedMetrics: [...admitted], rows,
    modelCalls: 0, productionOpened: false,
    evidenceScope: 'metric discrimination under deletion/padding/reflow controls on the development corpus; not a benefit, holdout or human-approved reference result',
  }, null, 2))
  await bed.stop()
}
