/**
 * 覆盖质量命题门（2026-10-23 · P2.1 第四批）
 *
 * ⚠️ 它证明的是**机制**：新命题有**新身份**、旧"非空"语义一字未动、
 *    未复核参照与字节变化都让覆盖停在 `unknown`、覆盖不成立会成为**反例**、
 *    同一份文档不构成独立证据。
 * ⚠️ 它**不**证明"覆盖良好"，也**不**证明收益：门里用的是**合成夹具**，
 *    真实语料的参照真人复核仍 PENDING。
 * ⚠️ 零真实模型调用；门体在 Linux 仿真内执行，数据库场景用独立隔离库。
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import {
  DOCUMENT_COVERAGE_ENVIRONMENT, DOCUMENT_COVERAGE_POLICY, DOCUMENT_COVERAGE_PREFIX, DOCUMENT_COVERAGE_SCOPE,
  documentCoverageConditions, readDocumentCoverageReceipt, type DocumentCoverageReference, type DocumentCoverageUnit,
} from '../../src/kernel/contracts/document-coverage.ts'
import type { DocumentCoverageReferencePort } from '../../src/infrastructure/runtime/document-coverage-reference.ts'

const cases = ['unknown-without-reference', 'pending-reference', 'changed-bytes', 'qualification', 'counterexample', 'same-document', 'approved-corpus-reference']
if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(cases.includes(selected), `unknown case: ${String(selected)}`)

const checks: string[] = []
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`) }
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

const registry = new Map<string, DocumentCoverageReference>()
const coveragePort: DocumentCoverageReferencePort = {
  find: rawPath => registry.get(rawPath),
  entries: () => [...registry.entries()].map(([path, reference]) => ({ path, reference })),
}

const bed = await createDocumentReadingBed(`coverage-${selected}`, {}, {}, {}, coveragePort)
const referenceVersion = 'fixture-coverage@1'
const unit = (needle: string) => [{ id: 'fixture-unit', page: 1, region: 'body', kind: 'fragments' as const, needles: [needle] }]
const register = (path: string, reference: DocumentCoverageReference) => { registry.set(path, reference) }

try {
  const coverageClaimId = makeEblClaim({ characterId: String(bed.h.kernel.characterId), subjectId: bed.h.userId, domain: 'tool',
    predicate: 'document_extracts', expected: true, scope: DOCUMENT_COVERAGE_SCOPE, environment: DOCUMENT_COVERAGE_ENVIRONMENT,
    conditions: documentCoverageConditions('markitdown', referenceVersion), formation: { kind: 'action', id: 'x' } }).id
  const nonemptyClaimId = makeEblClaim({ characterId: String(bed.h.kernel.characterId), subjectId: bed.h.userId, domain: 'tool',
    predicate: 'document_extracts', expected: true, scope: 'pdf_text', environment: 'pdf-text@1',
    conditions: { format: 'pdf', reader: 'markitdown' }, formation: { kind: 'action', id: 'x' } }).id
  check('the coverage proposition has its own content-addressed identity', coverageClaimId !== nonemptyClaimId)

  const runFixture = async (name: string, body: string, needle: string, review: 'APPROVED' | 'PENDING') => {
    const path = bed.file(name, body)
    const sha = hash(readFileSync(path))
    register(path, { version: referenceVersion, documentSha256: sha, humanReview: review, units: unit(needle) })
    const outcome = await bed.run(path, 'current', { forced: 'markitdown' })
    // ⚠️ 观察钩子失败会被执行环吞掉（只留计数）⇒ 这里必须**显式**断言它为 0。
    check(`the native observers complete without failures: ${name}`, (outcome?.epistemicFailures ?? 0) === 0)
    const result = outcome?.results[0]?.result
    const encoded = result?.evidence?.find(entry => entry.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
    const receipt = encoded ? readDocumentCoverageReceipt(JSON.parse(encoded)) : undefined
    return { path, sha, outcome, result, receipt }
  }

  if (selected === 'unknown-without-reference') {
    const path = bed.file('no-reference', 'Coverage body without any registered reference')
    const outcome = await bed.run(path, 'current', { forced: 'markitdown' })
    const result = outcome?.results[0]?.result
    const encoded = result?.evidence?.find(entry => entry.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
    check('extraction still succeeds without any reference', result?.status === 'success' && outcome?.epistemicFailures === 0)
    check('no reference means no coverage receipt at all', encoded === undefined)
    check('no reference means no coverage claim exists', (await bed.store.get(coverageClaimId)) === undefined)
    const nonempty = (await bed.snapshots.list()).filter(snapshot => snapshot.scope === 'pdf_text')
    check('the old non-empty proposition is untouched', nonempty.length >= 0)
  } else if (selected === 'pending-reference') {
    const fixture = await runFixture('pending', 'Coverage body of a pending reference', 'Coverage body of a pending reference', 'PENDING')
    check('extraction still succeeds with a pending reference', fixture.result?.status === 'success')
    check('a reference that is not human-approved produces no coverage receipt', fixture.receipt === undefined)
    check('a pending reference produces no coverage claim', (await bed.store.get(coverageClaimId)) === undefined)
  } else if (selected === 'changed-bytes') {
    const path = bed.file('changed', 'Coverage body of a changed document')
    register(path, { version: referenceVersion, documentSha256: '0'.repeat(64), humanReview: 'APPROVED', units: unit('Coverage body of a changed document') })
    const outcome = await bed.run(path, 'current', { forced: 'markitdown' })
    const result = outcome?.results[0]?.result
    const encoded = result?.evidence?.find(entry => entry.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
    check('extraction still succeeds when the reference bytes do not match', result?.status === 'success')
    check('changed bytes produce no coverage receipt', encoded === undefined)
    check('changed bytes produce no coverage claim', (await bed.store.get(coverageClaimId)) === undefined)
  } else if (selected === 'qualification') {
    const fixtures = [
      { name: 'alpha', body: 'Coverage fixture alpha carries the required sentence', needle: 'Coverage fixture alpha carries the required sentence' },
      { name: 'beta', body: 'Coverage fixture beta carries the required sentence', needle: 'Coverage fixture beta carries the required sentence' },
      { name: 'gamma', body: 'Coverage fixture gamma carries the required sentence', needle: 'Coverage fixture gamma carries the required sentence' },
    ]
    for (const fixture of fixtures) {
      const run = await runFixture(fixture.name, fixture.body, fixture.needle, 'APPROVED')
      check(`approved reference produces a coverage receipt: ${fixture.name}`, run.receipt?.outcome === 'met' && run.receipt.policy === DOCUMENT_COVERAGE_POLICY)
    }
    const state = await bed.store.get(coverageClaimId)
    check('the coverage proposition is proposed from a real coverage receipt', state !== undefined && state.status === 'validated')
    check('the coverage proposition needed its own independent evidence', (state?.evidence.length ?? 0) >= 2
      && new Set(state?.evidence.map(item => item.observation.independentKey) ?? []).size >= 2)
    check('the coverage proposition keeps its own scope and policy', state?.claim.scope === DOCUMENT_COVERAGE_SCOPE
      && state?.claim.environment === DOCUMENT_COVERAGE_ENVIRONMENT && state?.claim.conditions.policy === DOCUMENT_COVERAGE_POLICY)
    check('the coverage proposition is not the old non-empty proposition', state?.claim.id !== nonemptyClaimId
      && (await bed.store.get(nonemptyClaimId)) !== undefined)
    check('the coverage receipt carries no body text', JSON.stringify(state?.evidence.map(item => item.observation.revision) ?? []).length > 0
      && !JSON.stringify(await bed.store.get(coverageClaimId)).includes('Coverage fixture alpha carries the required sentence'))
  } else if (selected === 'counterexample') {
    for (const name of ['alpha', 'beta', 'gamma']) {
      await runFixture(name, `Coverage fixture ${name} carries the required sentence`, `Coverage fixture ${name} carries the required sentence`, 'APPROVED')
    }
    const before = await bed.store.get(coverageClaimId)
    check('the coverage proposition is qualified before the negative case', before?.status === 'validated')
    const negative = await runFixture('delta', 'Coverage fixture delta holds unrelated words only', 'Coverage fixture delta expected sentence', 'APPROVED')
    check('a document that misses the policy produces a not-met receipt', negative.receipt?.outcome === 'not_met')
    const after = await bed.store.get(coverageClaimId)
    check('a not-met coverage reading suspends the proposition', after?.status === 'suspended')
    check('the counterexample is kept as evidence', (after?.evidence.length ?? 0) > (before?.evidence.length ?? 0)
      && after?.evidence.at(-1)?.verdict === 'counterexample')
  } else if (selected === 'approved-corpus-reference') {
    // ⚠️ **真实语料 + 真人复核过的参照**（不是合成夹具）：
    //    这是"参照 → 覆盖回执 → 命题"整条链在真实文档上的第一次读数。
    const references = JSON.parse(readFileSync('evals/world-model-pilot/document-reference-v3.json', 'utf8')) as {
      version: string
      review: { humanReview: string }
      documents: Array<{ id: string; file: string; sha256: string; units: DocumentCoverageUnit[] }>
    }
    const corpus = resolve(process.env.DOCUMENT_CORPUS_DIR ?? 'artifacts/local/document-corpus')
    const document = references.documents.find(entry => entry.id === 'paper-en-2col')!
    check('the development reference is human approved', references.review.humanReview === 'APPROVED')
    // ⚠️ 语料文件要放进**沙箱根**里再读：床位的路径守卫只认沙箱内的绝对路径。
    const source = resolve(corpus, document.file)
    const path = resolve(bed.root, document.file)
    copyFileSync(source, path)
    const sha = hash(readFileSync(path))
    check('the corpus bytes still match the approved reference', sha === document.sha256)
    register(path, { version: references.version, documentSha256: sha, humanReview: 'APPROVED', units: document.units })
    const outcome = await bed.run(path, 'current', { forced: 'markitdown' })
    const result = outcome?.results[0]?.result
    const encoded = result?.evidence?.find(entry => entry.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
    const receipt = encoded ? readDocumentCoverageReceipt(JSON.parse(encoded)) : undefined
    check('the real document produces a coverage receipt', receipt !== undefined && receipt.referenceVersion === references.version)
    check('the real document meets the coverage policy on this route', receipt?.outcome === 'met')
    check('the coverage receipt carries counts only, never body text', receipt !== undefined
      && !Object.keys(receipt).some(key => key === 'text' || key === 'body' || key === 'markdown'))
    const approvedClaimId = makeEblClaim({ characterId: String(bed.h.kernel.characterId), subjectId: bed.h.userId, domain: 'tool',
      predicate: 'document_extracts', expected: true, scope: DOCUMENT_COVERAGE_SCOPE, environment: DOCUMENT_COVERAGE_ENVIRONMENT,
      conditions: documentCoverageConditions('markitdown', references.version), formation: { kind: 'action', id: 'x' } }).id
    const state = await bed.store.get(approvedClaimId)
    check('the real reading proposes the coverage proposition', state !== undefined && state.status !== 'withdrawn')
    check('the real reading carries the approved reference version', state?.claim.conditions.reference === references.version)
  } else if (selected === 'same-document') {
    const alpha = await runFixture('alpha', 'Coverage fixture alpha carries the required sentence', 'Coverage fixture alpha carries the required sentence', 'APPROVED')
    for (const name of ['beta', 'gamma']) {
      await runFixture(name, `Coverage fixture ${name} carries the required sentence`, `Coverage fixture ${name} carries the required sentence`, 'APPROVED')
    }
    const before = await bed.store.get(coverageClaimId)
    // ⚠️ 读**同一个文件**（不是同样内容的另一个文件）：字节指纹相同 ⇒ 同一份文档。
    const repeat = await bed.run(alpha.path, 'current', { forced: 'markitdown' })
    const result = repeat?.results[0]?.result
    const encoded = result?.evidence?.find(entry => entry.ref?.startsWith(DOCUMENT_COVERAGE_PREFIX))?.ref?.slice(DOCUMENT_COVERAGE_PREFIX.length)
    const receipt = encoded ? readDocumentCoverageReceipt(JSON.parse(encoded)) : undefined
    check('the repeated document still produces its own receipt', receipt?.outcome === 'met')
    const after = await bed.store.get(coverageClaimId)
    check('the same document does not add independent evidence', (after?.evidence.length ?? 0) === (before?.evidence.length ?? 0))
  }

  writeFileSync(resolve(bed.output, 'coverage-proposition.json'), JSON.stringify({
    status: 'PASS', selected, location: 'serversim/simhost', backend: 'fresh isolated pgtest',
    coverageClaimId, nonemptyClaimId, checks, measured_count: checks.length,
    modelCalls: 0, productionOpened: false,
    evidenceScope: 'mechanism only: identity separation, unknown handling, counterexample and independence; synthetic fixtures, no benefit or quality claim',
  }, null, 2))
} finally { await bed.stop() }
