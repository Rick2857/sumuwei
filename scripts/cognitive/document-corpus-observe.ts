/**
 * Natural-corpus observation for the document-recovery domain.
 *
 * Three modes (the scenario runner drives the first two):
 *   · `--list-cases`  -> one case id per document of the frozen corpus plan
 *   · `--case <id>`   -> measure that document on **both** routes and write
 *                        `<out>/cases/<id>.json`
 *   · `--aggregate`   -> merge the per-document files, run the cross-document
 *                        checks and write `<out>/observation.json`
 *
 * What it measures
 * ----------------
 * For every corpus document and every reader route it runs the **real**
 * `document.extract` capability: real gateway, real authorization, real
 * converter subprocess, real action ledger, one fresh isolated PostgreSQL
 * database per document. No converter result is injected and no reader fault
 * is simulated.
 *
 * It measures: the closed-set receipt outcome, the extracted length, whether
 * the **independent** content standard is met, the observable pre-read
 * profile, and whether the two routes differ.
 *
 * It does **not** measure: a benefit claim, a holdout result, or anything
 * about the semantic correctness of the extracted body text.
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { PDF_READERS, PDF_RECEIPT_PREFIX, readPdfReceipt } from '../../src/kernel/contracts/document-reading.ts'

const corpusDir = resolve(process.env.DOCUMENT_CORPUS_DIR ?? 'artifacts/local/document-corpus')
const planPath = resolve(process.env.DOCUMENT_CORPUS_PLAN ?? 'scripts/cognitive/document-corpus.json')
const outDir = resolve(process.env.DOCUMENT_CORPUS_OUT ?? 'artifacts/local/document-corpus/observation')
const pythonPath = process.env.PROJECT_LG_DOC_PYTHON ?? ''
const profileRunner = resolve('scripts/cognitive/document-profile-runner.py')
const markitdownRunner = resolve('scripts/utility-skills/doc-runner.py')
const pdfminerRunner = resolve('scripts/cognitive/pdfminer-runner.py')

interface PlanDocument {
  id: string
  kind: 'natural' | 'derived'
  category: string
  file: string
  variant?: string
  derivedFrom?: string
  standard: { kind: string; phrases: string[]; minChars: number }
  expected: { outcome: string; note: string }
}
interface Plan { version: string; frozenAt: string; documents: PlanDocument[] }
interface Readback { planSha256: string; documents: Array<{ id: string; status: string; file?: string; sha256?: string; bytes?: number }> }

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan
const readback = JSON.parse(readFileSync(resolve(corpusDir, 'corpus-readback.json'), 'utf8')) as Readback

if (process.argv.includes('--list-cases')) {
  for (const document of plan.documents) console.log(document.id)
  process.exit(0)
}

/**
 * The same normalization the preparation step used, plus **NFKC**.
 *
 * ⚠️ NFKC is not cosmetic: the Chinese Wikipedia PDF maps many glyphs to the
 *    **Kangxi radical** code points (电⼦ / U+2F66 instead of 电子). The text
 *    looks identical to a reader but is not code-point equal, so an exact
 *    content standard would fail on a document that was read perfectly.
 *    The raw comparison is kept alongside so the evidence shows it.
 */
function normalize(text: string): string {
  let out = ''
  for (const char of text.normalize('NFKC').toLowerCase()) {
    if (/[a-z0-9]/.test(char) || char.charCodeAt(0) > 0x2e80) out += char
  }
  return out
}

/** Comparison without NFKC, so compatibility-form damage stays visible. */
function normalizeRaw(text: string): string {
  let out = ''
  for (const char of text.toLowerCase()) {
    if (/[a-z0-9]/.test(char) || char.charCodeAt(0) > 0x2e80) out += char
  }
  return out
}

/** Observable pre-read profile: closed-set structural facts, no document text. */
function probeProfile(bytes: Buffer): Promise<Record<string, unknown>> {
  return runRunner(bytes, profileRunner, [])
}

/** Run one of the **real** converter runners and return its stdout text. */
function runRunner(bytes: Buffer, runner: string, extra: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonPath, [runner, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', () => {
      const line = stdout.trim().split('\n').filter(entry => entry.trim() !== '').pop()
      if (line === undefined) { rejectPromise(new Error(`runner produced no output: ${stderr.slice(0, 200)}`)); return }
      try { resolvePromise(JSON.parse(line) as Record<string, unknown>) }
      catch (error) { rejectPromise(error) }
    })
    child.stdin.write(bytes)
    child.stdin.end()
  })
}

/**
 * Full-fidelity shape of what each route produced.
 *
 * ⚠️ The capability caps the text it hands to the turn at 60 000 characters,
 *    so the turn content cannot be used to compare two routes on a long
 *    document. This runs the **same runner** the capability runs and keeps
 *    only counts - never the text.
 */
async function routeShape(bytes: Buffer, reader: string): Promise<Record<string, unknown>> {
  const runner = reader === 'markitdown' ? markitdownRunner : pdfminerRunner
  const payload = await runRunner(bytes, runner, ['--ext', '.pdf'])
  const text = typeof payload.markdown === 'string' ? payload.markdown : ''
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const tableLines = lines.filter(line => line.startsWith('|'))
  const proseLines = lines.filter(line => !line.startsWith('|'))
  const proseChars = proseLines.join('\n').length
  return {
    ok: payload.ok === true,
    chars: text.length,
    lines: lines.length,
    tableLines: tableLines.length,
    proseLines: proseLines.length,
    proseChars,
    tableChars: tableLines.join('\n').length,
    text,
  }
}

/**
 * Tokenizer-independent content containment: character k-grams.
 *
 * ⚠️ Both easier metrics are confounded on real documents:
 *    · line-level overlap - the two routes re-segment the page differently,
 *      so almost no line matches even when the content is the same;
 *    · word-level overlap - MarkItDown emits pipe-table rows (" Evaluation |")
 *      and CJK text has no spaces, so the same content yields different tokens.
 *    Character k-grams survive both, so containment is measured on them.
 */
function kgramSet(text: string, k = 5): Set<string> {
  const flat = text.normalize('NFKC').replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let index = 0; index + k <= flat.length; index += 1) grams.add(flat.slice(index, index + k))
  return grams
}
function containmentOf(from: Set<string>, into: Set<string>): number {
  if (from.size === 0) return 0
  let shared = 0
  for (const gram of from) if (into.has(gram)) shared += 1
  return shared / from.size
}
function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const word of text.split(/\s+/)) {
    const trimmed = word.trim()
    if (trimmed === '') continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
  return counts
}

const checks: string[] = []
function check(name: string, condition: unknown): void {
  assert.ok(condition, name)
  checks.push(name)
  console.log(`PASS ${name}`)
}

interface RouteReading {
  reader: string
  status: string
  executed: boolean
  outcome: string
  receiptPresent: boolean
  totalChars: number
  includedChars: number
  truncated: boolean
  phraseHits: string[]
  phraseMisses: string[]
  phraseHitsWithoutNfkc: string[]
  compatibilityFormDamage: boolean
  meetsStandard: boolean
  shape: {
    ok: boolean
    chars: number
    lines: number
    tableLines: number
    proseLines: number
    proseChars: number
    tableChars: number
  }
  elapsedMs: number
  failureCode: string | null
}
interface DocumentRow {
  id: string
  kind: string
  category: string
  variant: string | null
  derivedFrom: string | null
  bytes: number
  sha256: string
  profile: Record<string, unknown>
  expected: { outcome: string; note: string }
  routes: RouteReading[]
  overlap: {
    markitdownGramContainmentInPdfminer: number
    pdfminerGramContainmentInMarkitdown: number
    markitdownWordCount: number
    pdfminerWordCount: number
    markitdownProseWords: number
    pdfminerProseWords: number
  }
  ebl: Array<{ claimId: string; reader: string; usable: boolean; status: string; conditions: Record<string, string> }>
  checks: string[]
}

async function measure(document: PlanDocument): Promise<DocumentRow> {
  const readbackRecord = readback.documents.find(entry => entry.id === document.id)
  assert.ok(readbackRecord, `no readback record for ${document.id}`)
  assert.equal(readbackRecord!.status, 'OK', `${document.id} was not prepared: ${readbackRecord!.status}`)
  const filePath = resolve(corpusDir, document.file)
  const bytes = readFileSync(filePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  check(`corpus integrity for ${document.id}`, sha256 === readbackRecord!.sha256)

  const phrases = document.standard.phrases
  const profile = await probeProfile(bytes)
  const routes: RouteReading[] = []
  const lineSets = new Map<string, Set<string>>()
  const proseSets = new Map<string, Set<string>>()
  const wordSets = new Map<string, Map<string, number>>()
  const gramSets = new Map<string, Set<string>>()
  const proseWordTotals = new Map<string, number>()
  const bed = await createDocumentReadingBed(`document-corpus-${document.id}`)
  try {
    for (const reader of PDF_READERS) {
      const inside = resolve(bed.root, document.file)
      copyFileSync(filePath, inside)
      const started = Date.now()
      const outcome = await bed.run(inside, 'current', { forced: reader })
      const elapsedMs = Date.now() - started
      const result = outcome?.results[0]?.result
      assert.ok(result, `${document.id}/${reader} produced no action result`)
      const encoded = result!.evidence?.find(entry => entry.ref?.startsWith(PDF_RECEIPT_PREFIX))?.ref?.slice(PDF_RECEIPT_PREFIX.length)
      const failureDetails = result!.error?.details as { documentReading?: unknown } | undefined
      const settled = readPdfReceipt(encoded === undefined ? undefined : JSON.parse(encoded))
        ?? readPdfReceipt(failureDetails?.documentReading)
      const content = result!.turnContent?.find(item => item.capability === 'document.extract')
      const text = content?.text ?? ''
      const scope = content?.scope as { totalChars?: number; includedChars?: number; truncated?: boolean } | undefined
      const haystack = normalize(text)
      const haystackRaw = normalizeRaw(text)
      const hitPhrases = phrases.filter(phrase => haystack.includes(normalize(phrase)))
      const rawHitPhrases = phrases.filter(phrase => haystackRaw.includes(normalizeRaw(phrase)))
      const shape = await routeShape(bytes, reader)
      const words = wordCounts(String(shape.text ?? ''))
      wordSets.set(reader, words)
      gramSets.set(reader, kgramSet(String(shape.text ?? '')))
      const proseText = String(shape.text ?? '').split('\n')
        .map(line => line.trim()).filter(line => line !== '' && !line.startsWith('|')).join(' ')
      proseWordTotals.set(reader, [...wordCounts(proseText).values()].reduce((total, count) => total + count, 0))
      routes.push({
        reader,
        status: result!.status,
        executed: result!.executed,
        outcome: settled?.outcome ?? 'no_receipt',
        receiptPresent: settled !== undefined,
        totalChars: scope?.totalChars ?? 0,
        includedChars: scope?.includedChars ?? 0,
        truncated: scope?.truncated ?? false,
        phraseHits: hitPhrases,
        phraseMisses: phrases.filter(phrase => !hitPhrases.includes(phrase)),
        phraseHitsWithoutNfkc: rawHitPhrases,
        compatibilityFormDamage: rawHitPhrases.length < hitPhrases.length,
        meetsStandard: hitPhrases.length === phrases.length && (scope?.totalChars ?? 0) >= document.standard.minChars,
        shape: {
          ok: shape.ok === true,
          chars: Number(shape.chars ?? 0),
          lines: Number(shape.lines ?? 0),
          tableLines: Number(shape.tableLines ?? 0),
          proseLines: Number(shape.proseLines ?? 0),
          proseChars: Number(shape.proseChars ?? 0),
          tableChars: Number(shape.tableChars ?? 0),
        },
        elapsedMs,
        failureCode: result!.error?.code ?? null,
      })
    }
    const markitdownWords = wordSets.get('markitdown') ?? new Map<string, number>()
    const pdfminerWords = wordSets.get('pdfminer') ?? new Map<string, number>()
    const markitdownGrams = gramSets.get('markitdown') ?? new Set<string>()
    const pdfminerGrams = gramSets.get('pdfminer') ?? new Set<string>()
    const snapshots = await bed.snapshots.list()
    return {
      id: document.id,
      kind: document.kind,
      category: document.category,
      variant: document.variant ?? null,
      derivedFrom: document.derivedFrom ?? null,
      bytes: bytes.length,
      sha256,
      profile,
      expected: document.expected,
      routes,
      overlap: {
        markitdownGramContainmentInPdfminer: Number(containmentOf(markitdownGrams, pdfminerGrams).toFixed(4)),
        pdfminerGramContainmentInMarkitdown: Number(containmentOf(pdfminerGrams, markitdownGrams).toFixed(4)),
        markitdownWordCount: markitdownWords.size,
        pdfminerWordCount: pdfminerWords.size,
        markitdownProseWords: proseWordTotals.get('markitdown') ?? 0,
        pdfminerProseWords: proseWordTotals.get('pdfminer') ?? 0,
      },
      ebl: snapshots.map(snapshot => ({
        claimId: snapshot.claimId,
        reader: snapshot.conditions.reader ?? '',
        usable: snapshot.usable,
        status: snapshot.status,
        conditions: snapshot.conditions,
      })),
      checks: [...checks],
    }
  } finally {
    await bed.stop()
  }
}

if (process.argv.includes('--aggregate')) {
  const rows: DocumentRow[] = []
  for (const document of plan.documents) {
    const path = resolve(outDir, 'cases', `${document.id}.json`)
    assert.ok(existsSync(path), `missing per-document result: ${path}`)
    rows.push(JSON.parse(readFileSync(path, 'utf8')) as DocumentRow)
  }
  const aggregateChecks: string[] = []
  const aggregateCheck = (name: string, condition: unknown): void => {
    assert.ok(condition, name)
    aggregateChecks.push(name)
    console.log(`PASS ${name}`)
  }
  for (const row of rows) {
    const outcomes = row.routes.map(route => route.outcome)
    aggregateCheck(`${row.id}: both routes produced a real receipt`, row.routes.every(route => route.receiptPresent))
    aggregateCheck(`${row.id}: both routes produced a receipt from a real converter`, row.routes.every(route => route.executed || route.status !== 'success'))
    if (row.kind === 'natural') {
      aggregateCheck(`${row.id}: both routes returned non-empty text`, outcomes.every(outcome => outcome === 'nonempty'))
      aggregateCheck(`${row.id}: both routes met the independent content standard`, row.routes.every(route => route.meetsStandard))
    }
    if (row.id === 'derived-scan-alike') {
      aggregateCheck(`${row.id}: both routes reported empty, not text`, outcomes.every(outcome => outcome === 'empty'))
      aggregateCheck(`${row.id}: profile sees no text layer`, row.profile.textLayer === 'absent')
    }
    if (row.id === 'derived-damaged-xref') {
      aggregateCheck(`${row.id}: did not silently report empty`, outcomes.every(outcome => outcome !== 'empty'))
    }
    if (row.profile.textLayer === 'absent') {
      aggregateCheck(`${row.id}: absent text layer never produced text`, row.routes.every(route => route.outcome === 'empty'))
    }
    if (row.profile.textLayer === 'present' && row.kind === 'natural') {
      aggregateCheck(`${row.id}: present text layer produced text on both routes`, row.routes.every(route => route.outcome === 'nonempty'))
    }
    // NFKC: the extracted text must not carry compatibility forms any more.
    aggregateCheck(`${row.id}: extracted text carries no compatibility-form damage`,
      row.routes.every(route => route.compatibilityFormDamage === false))
  }
  const divergence = rows.map(row => {
    const [a, b] = row.routes
    return {
      id: row.id,
      differentOutcome: a!.outcome !== b!.outcome,
      differentStandard: a!.meetsStandard !== b!.meetsStandard,
      differentPhrases: JSON.stringify(a!.phraseHits) !== JSON.stringify(b!.phraseHits),
      compatibilityFormDamage: a!.compatibilityFormDamage || b!.compatibilityFormDamage,
      lengthRatio: b!.totalChars === 0 ? null : Number(a!.totalChars) / Number(b!.totalChars),
      outcomes: row.routes.map(route => route.outcome),
      totalChars: row.routes.map(route => route.totalChars),
      shapeChars: row.routes.map(route => route.shape.chars),
      proseLines: row.routes.map(route => route.shape.proseLines),
      tableLines: row.routes.map(route => route.shape.tableLines),
      phraseHits: row.routes.map(route => route.phraseHits),
      elapsedMs: row.routes.map(route => route.elapsedMs),
      overlap: row.overlap,
    }
  })
  aggregateCheck('every document was executed on both routes', rows.every(row => row.routes.length === PDF_READERS.length))
  aggregateCheck('route divergence was measured for every document', divergence.length === rows.length)
  const report = {
    status: 'PASS',
    version: 'document-corpus-observation@1',
    planSha256: createHash('sha256').update(readFileSync(planPath)).digest('hex'),
    readbackPlanSha256: readback.planSha256,
    corpusDir,
    location: 'serversim/simhost',
    backend: 'isolated-postgres (one fresh migrated database per document)',
    readers: [...PDF_READERS],
    injection: 'none - every route ran the real converter subprocess on the real bytes',
    modelCalls: 0,
    productionOpened: false,
    checks: aggregateChecks,
    measured_count: aggregateChecks.length,
    rows,
    divergence,
  }
  writeFileSync(resolve(outDir, 'observation.json'), JSON.stringify(report, null, 2))
  console.log(`\nobservation -> ${resolve(outDir, 'observation.json')}`)
  console.log(`aggregate checks: ${String(aggregateChecks.length)}`)
  for (const entry of divergence) {
    console.log(`${entry.id}: outcomes=${JSON.stringify(entry.outcomes)} chars=${JSON.stringify(entry.shapeChars)} prose=${JSON.stringify(entry.proseLines)} table=${JSON.stringify(entry.tableLines)} overlap=${JSON.stringify(entry.overlap)}`)
  }
  process.exit(0)
}

const caseIndex = process.argv.indexOf('--case')
assert.ok(caseIndex >= 0, 'explicit --case is required')
const selected = process.argv[caseIndex + 1]
const document = plan.documents.find(entry => entry.id === selected)
assert.ok(document, `unknown corpus document: ${String(selected)}`)
mkdirSync(resolve(outDir, 'cases'), { recursive: true })
const row = await measure(document)
writeFileSync(resolve(outDir, 'cases', `${document.id}.json`), JSON.stringify(row, null, 2))
console.log(`case ${document.id}: outcomes=${JSON.stringify(row.routes.map(route => route.outcome))} chars=${JSON.stringify(row.routes.map(route => route.totalChars))}`)
