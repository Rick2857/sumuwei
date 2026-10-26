import 'dotenv/config'
import assert from 'node:assert/strict'
import { writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { documentReadingGoal } from '../../src/infrastructure/runtime/document-recovery-planning.ts'
import { readKernelFlags } from '../../src/kernel/app/flags.ts'
import { verifyPlanRulesStillUsable } from '../../src/kernel/contracts/cognitive-collaboration.ts'
import { ActionFailureError, actionFailure } from '../../src/kernel/action/errors.ts'
import { resolveLocalTarget } from '../../src/kernel/action/local-target.ts'

const cases = ['native', 'duplicate', 'counterexample', 'timeout', 'recovery', 'negative-formation', 'permission']
if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(cases.includes(selected), 'explicit isolated scenario required')
let injected = 0
const bed = await createDocumentReadingBed(`document-${selected}`, selected === 'timeout'
  ? { async convert() { return { ok: false, timedOut: true, exitCode: null, durationMs: 1 } } }
  : selected === 'recovery' ? { async convert() { return { ok: true, timedOut: false, exitCode: 0, durationMs: 1,
    markdown: ++injected === 1 ? '' : 'Controlled recovery marker' } } }
  : selected === 'permission' ? { async resolveTarget() { throw new ActionFailureError(actionFailure('permission_denied', 'owned permission negative control')) } } : {})
const checks: string[] = []
function check(name: string, condition: unknown) { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
try {
  if (selected === 'native') {
    check('code default off', !readKernelFlags({}).documentRecoveryEnabled)
    check('ordinary explicit POSIX PDF request', documentReadingGoal('帮我读取「/tmp/a b.pdf」的正文')?.path === '/tmp/a b.pdf')
    check('ordinary explicit Windows PDF request', documentReadingGoal('请读取「C:\\docs\\a b.pdf」的正文')?.path === 'C:\\docs\\a b.pdf')
    check('native POSIX target stays exact', resolveLocalTarget({targetType:'local_file',rawPath:'/tmp/a.pdf',platform:'posix'}).target.confidence === 'exact')
    check('historical Windows target default preserved', resolveLocalTarget({targetType:'local_file',rawPath:'C:\\docs\\a.pdf'}).target.confidence === 'exact')
    check('no inferred or ambiguous goals', ['读取那份PDF的正文', '不要读取「/tmp/a.pdf」的正文', '读取 a.pdf 的正文',
      '读取「/tmp/a.pdf」和「/tmp/b.pdf」的正文'].every(t => !documentReadingGoal(t)))
    await bed.train()
    const rules = (await bed.snapshots.list()).filter(s => s.usable)
    check('both real extraction pipelines independently qualified', rules.length === 2)
    const path = bed.file('ordinary with space', 'Actual source marker 41')
    const result = await bed.run(path, 'model', { viaTurn: true })
    check('ordinary role turn reached real native extraction', result?.results[0]?.result.turnContent?.[0]?.text.includes('Actual source marker 41'))
    check('qualified rule actually entered simulation and comparison', result?.simulationsUsed === 1 && result.comparisons?.[0]?.verdict === 'match')
    check('native EBL observer completed', result?.epistemicFailures === 0)
    const chosen = rules.find(r => r.conditions.reader === 'markitdown')!
    const state = await bed.store.get(chosen.claimId)
    check('guided success recorded as dependent evidence', state?.evidence.at(-1)?.independent === false && state.uses.length === 1)
    await bed.store.commit(chosen.claimId, { kind: 'withdraw' })
    check('withdrawn dependency invalidates old plan', !(await verifyPlanRulesStillUsable({ snapshot: bed.snapshots,
      dependencies: [{ claimId: chosen.claimId, ruleVersion: chosen.ruleVersion, evidenceFingerprint: chosen.evidenceFingerprint }] })).ok)
    const next = await bed.run(bed.file('after-withdrawal', 'Actual source marker 42'))
    check('current selection switches to qualified other pipeline', next?.results[0]?.request.arguments.reader === 'pdfminer')
    check('withdrawn rule stays withdrawn', (await bed.store.get(chosen.claimId))?.status === 'withdrawn')
  } else if (selected === 'duplicate') {
    const first = bed.file('formation', 'Formation unique')
    await bed.run(first, 'current', { forced: 'markitdown' })
    const a = bed.file('same-source-a', 'One independent input'), b = resolve(bed.root, 'same-source-b.pdf')
    copyFileSync(a, b)
    for (const p of [a, b]) await bed.run(p, 'current', { forced: 'markitdown' })
    const state = await bed.store.get((await bed.snapshots.list())[0]!.claimId)
    check('identical input bytes under another filename do not add independence', state?.evidence.filter(e => e.independent).length === 1)
    check('duplicated corpus cannot qualify rule', !(await bed.snapshots.list()).some(s => s.usable))
  } else if (selected === 'counterexample') {
    await bed.train()
    const before = (await bed.snapshots.list()).find(s => s.conditions.reader === 'markitdown')!
    const result = await bed.run(bed.file('blank-actual-pdf', ''), 'model')
    check('real empty PDF tried both readers within budget', result?.actionsUsed === 2 && result.results.every(r => r.result.status !== 'success'))
    check('empty reading never reports done', result?.stopped !== 'done')
    const state = await bed.store.get(before.claimId)
    check('real empty outcome suspends rule and preserves counterexample', state?.status === 'suspended' && state.evidence.at(-1)?.verdict === 'counterexample')
    check('counterexample is tied to actual forecast version', state?.evidence.at(-1)?.model?.forecastVerdict === 'mismatch')
    check('suspended rules leave model construction', !(await bed.snapshots.list()).some(s => s.usable))
  } else if (selected === 'timeout') {
    const result = await bed.run(bed.file('timeout', 'Timeout input'), 'static')
    check('timeout is bounded to two attempts', result?.actionsUsed === 2 && result.results.every(r => r.result.status === 'timeout'))
    check('transport failure cannot form a PDF counterexample or rule', (await bed.snapshots.list()).length === 0)
  } else if (selected === 'recovery') {
    const result = await bed.run(bed.file('recovery', 'Controlled fixture'), 'static')
    check('mechanism-only empty primary falls back to second reader', result?.results.length === 2 && result.results[0]?.result.status !== 'success'
      && result.results[1]?.request.arguments.reader === 'pdfminer' && result.results[1]?.result.turnContent?.[0]?.text.includes('Controlled recovery marker'))
    check('mechanism recovery stays inside authorization', result?.actionsUsed === 2 && bed.calls() === 2)
  } else if (selected === 'permission') {
    const result = await bed.run(bed.file('denied', 'Never extracted'), 'static')
    check('permission denial stops without switching reader', result?.actionsUsed === 1 && bed.calls() === 1 && result.results[0]?.result.status === 'rejected')
    check('permission denial cannot form a content rule', (await bed.snapshots.list()).length === 0)
  } else {
    await bed.run(bed.file('negative-first', ''), 'current', { forced: 'markitdown' })
    for (let i = 0; i < 3; i++) await bed.run(bed.file(`positive-${i}`, `Positive ${i}`), 'current', { forced: 'markitdown' })
    check('negative formation cannot be hidden by later successes', !(await bed.snapshots.list()).some(s => s.usable))
    const count = bed.calls(), result = await bed.run(resolve(bed.root, 'missing.pdf'), 'static')
    check('missing file stops without alternative access attempt', result?.actionsUsed === 1 && bed.calls() === count + 1)
  }
  writeFileSync(resolve(bed.output, 'verification.json'), JSON.stringify({ status: 'PASS', selected, checks, measured_count: checks.length,
    location: 'serversim/simhost', backend: 'isolated-postgres', modelCalls: 0,
    injection: ['timeout','recovery'].includes(selected) ? 'mechanism-only controlled converter result' : 'none', productionOpened: false }, null, 2))
} catch (error) {
  writeFileSync(resolve(bed.output, 'verification.json'), JSON.stringify({ status: 'FAIL', selected, checks, error: String(error) }, null, 2))
  throw error
} finally { await bed.stop() }
