import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { normalizeReference, referenceSummary, type ReferenceUnit } from './document-quality.ts'
import { runConverter, DEFAULT_DOC_RUNNER } from '../../src/infrastructure/action/adapters/document-read.ts'
import { PDF_READERS, type PdfReader } from '../../src/kernel/contracts/document-reading.ts'

const referencesPath = 'evals/world-model-pilot/document-reference-v3.json'
const references = JSON.parse(readFileSync(referencesPath, 'utf8')) as {version:string;review:unknown;documents:Array<{id:string;file:string;sha256:string;units:ReferenceUnit[];renders?:Array<{file:string;sha256:string}>}>}
const cases = references.documents.map(d => d.id)
if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case')+1], doc = references.documents.find(d=>d.id===selected)
assert.ok(doc)
const hash = (v: Buffer|string) => createHash('sha256').update(v).digest('hex')
const corpus = resolve(process.env.DOCUMENT_CORPUS_DIR ?? 'artifacts/local/document-corpus')
const renderRoot = resolve(process.env.DOCUMENT_REFERENCE_IMAGES ?? 'artifacts/local/p21-visual')
assert.equal(hash(readFileSync(resolve(corpus,doc.file))),doc.sha256)
assert.ok(doc.renders?.length, 'frozen independent page render references required')
for(const render of doc.renders!) assert.equal(hash(readFileSync(resolve(renderRoot,render.file))),render.sha256)
let active: PdfReader = 'markitdown', full = ''
const bed = await createDocumentReadingBed(`quality-${selected}`, {async convert(input) {
  const result = await runConverter({...input, pythonPath:process.env.PROJECT_LG_DOC_PYTHON!,
    runnerPath: active==='markitdown'?DEFAULT_DOC_RUNNER:resolve('scripts/cognitive/pdfminer-runner.py')})
  full = (result.markdown??'').normalize('NFKC').replace(/\r\n/g,'\n').trim()
  return result // Genuine converter result; capture happens inside the authorized Gateway action, before its content cap.
}})
const checks:string[]=[], check=(name:string,v:unknown)=>{assert.ok(v,name);checks.push(name);console.log(`PASS ${name}`)}
try {
  const canonical = doc.units.map(u=>u.needles.join(' | ')).join('\n')
  check('reference scoring accepts all explicitly labelled units',referenceSummary(canonical,doc.units).observed===doc.units.length)
  check('Markdown formatting does not create missing units',referenceSummary(canonical.split('\n').map(l=>`| **${l}** |`).join('\n\n'),doc.units).observed===doc.units.length)
  const last=doc.units.at(-1)!, removed=doc.units.slice(0,-1).map(u=>u.needles.join(' | ')).join('\n')
  check('deleted unit remains absent despite large duplicate padding',referenceSummary((removed+'\n').repeat(30),doc.units).scores.find(s=>s.id===last.id)?.verdict==='not_observed')
  const row=doc.units.find(u=>u.kind==='row')!
  check('disconnected labels and values are not asserted as a bound table row',referenceSummary(row.needles.join('\n'),[row]).associationUnknown===1)
  const wrong=row.needles.map((n,i)=>i===row.needles.length-1?'WRONG_VALUE':n).join(' | ')
  check('wrong table value is detected',referenceSummary(wrong,[row]).observed===0)
  check('decimal positions are not erased by normalization',normalizeReference('8.06')!==normalizeReference('80.6'))
  const negative=referenceSummary((removed+'\n').repeat(30),doc.units)
  const controls={annotationTextChars:canonical.length,inflatedMissingTextChars:(removed.length+1)*30,
    omittedUnit:last.id,omittedVerdict:negative.scores.find(s=>s.id===last.id)?.verdict,
    knownNormalizationCollisions:[['x²','x2'],['①','1']].map(([a,b])=>({a,b,equal:normalizeReference(a!)===normalizeReference(b!)})),
    conclusion:'character magnitude cannot certify the presence of required units; controls exercise the scorer, not reader benefit'}
  const rows=[]
  const inside=resolve(bed.root,doc.file);copyFileSync(resolve(corpus,doc.file),inside)
  for(const reader of PDF_READERS){
    active=reader;full=''
    const started=Date.now(),outcome=await bed.run(inside,'current',{forced:reader})
    const result=outcome?.results[0]?.result, item=result?.turnContent?.[0]
    check(`real authorized converter succeeded: ${reader}`,result?.executed&&result.status==='success'&&outcome?.epistemicFailures===0)
    check(`same source fingerprint: ${reader}`,item?.sourceFingerprint===doc.sha256)
    check(`captured full output agrees with formal scope: ${reader}`,item?.scope.totalChars===full.length)
    const normalizedFull=normalizeReference(full)
    const diagnostics=doc.units.filter(u=>referenceSummary(full,[u]).observed===0).map(u=>{
      const anchor=normalizeReference(u.needles[0]).slice(0,8),index=normalizedFull.indexOf(anchor)
      return{unit:u.id,anchorFound:index>=0,nearAnchor:index<0?undefined:normalizedFull.slice(index,Math.min(index+160,normalizedFull.length))}
    })
    rows.push({reader,elapsedMs:Date.now()-started,actionId:String(result?.actionId),
      fullChars:full.length,deliveredChars:item!.scope.includedChars,truncated:item!.scope.truncated,
      full:referenceSummary(full,doc.units),delivered:referenceSummary(item!.text,doc.units),diagnostics,
      rawOutputStored:false,modelVisible:'NOT_MEASURED (no model request in this measurement gate)'})
  }
  writeFileSync(resolve(bed.output,'quality.json'),JSON.stringify({status:'PASS',location:'serversim/simhost',backend:'fresh isolated pgtest',
    referenceSha256:hash(readFileSync(referencesPath)),referenceReview:references.review,document:selected,documentSha256:doc.sha256,
    scorerSha256:hash(readFileSync('scripts/cognitive/document-quality.ts')),checks,measured_count:checks.length,controls,rows,
    modelCalls:0,productionOpened:false,evidenceScope:'candidate visual-reference unit presence and row association, not full-document correctness or benefit'},null,2))
}finally{await bed.stop()}
