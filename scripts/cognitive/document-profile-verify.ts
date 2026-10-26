import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed, pdfFixture } from './document-reading-bed.ts'
import { DOCUMENT_EXTRACT } from '../../src/kernel/contracts/document-reading.ts'
import { DOCUMENT_PROFILE, PDF_PROFILE_PREFIX, PDF_PROFILE_READING_VERSION, readPdfProfile, type PdfProfile } from '../../src/kernel/contracts/document-profile.ts'
import { createDocumentBeliefObserver } from '../../src/infrastructure/runtime/document-belief.ts'
import { createDocumentRecoveryPlanning } from '../../src/infrastructure/runtime/document-recovery-planning.ts'
import { createEblSourceReader, documentReadingRef } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { makeEblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { ActionFailureError, actionFailure } from '../../src/kernel/action/errors.ts'
import { buildToolCatalog, renderToolCatalogForModel } from '../../src/kernel/action/tool-catalog.ts'
import { turnContentFactsOf } from '../../src/kernel/action/turn-content-reply.ts'
import { renderTurnContentEntry } from '../../src/kernel/contracts/turn-content.ts'

const cases=['normal','qualification','absent','partial','parse-failed','timeout','permission','bad-magic','size','changed-input','zero-budget','no-profile-permission','cancelled','late-profile','wrong-target','wrong-task','invalid-protocol']
if(process.argv.includes('--list-cases')){console.log(cases.join('\n'));process.exit(0)}
const selected=process.argv[process.argv.indexOf('--case')+1];assert.ok(cases.includes(selected))
const bed=await createDocumentReadingBed(`profile-${selected}`,{}, selected==='timeout'?{timeoutMs:1}:selected==='size'?{maxFileBytes:16}
  :selected==='permission'?{async resolveTarget(){throw new ActionFailureError(actionFailure('permission_denied','owned profile negative'))}}
  :selected==='invalid-protocol'?{async convert(){return{ok:true,timedOut:false,markdown:JSON.stringify({protocol:'pdf-profile@1',outcome:'complete',textLayer:'absent',pages:0})}}}:{})
const checks:string[]=[],check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`)}
const decode=(result: {evidence?:readonly {ref?:string}[];error?:{details?:Record<string,unknown>}}): PdfProfile|undefined=>{
  const raw=result.evidence?.find(e=>e.ref?.startsWith(PDF_PROFILE_PREFIX))?.ref?.slice(PDF_PROFILE_PREFIX.length)
  return raw?readPdfProfile(JSON.parse(raw)):readPdfProfile(result.error?.details?.documentProfile)
}
// Distinct real page objects; all 65 pages have empty content, not a parser stub.
function manyPages(){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:65},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count 65 >>`,
    ...Array.from({length:65},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>')]
  let data='%PDF-1.4\n',offsets=[0]
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${o}\nendobj\n`})
  const xref=Buffer.byteLength(data)
  data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(data)
}
try{
  if(selected==='qualification'){
    await bed.train() // Legacy rules remain separate and cannot qualify the new identity.
    const legacy=(await bed.snapshots.list()).filter(s=>s.usable)
    check('legacy observations form two legacy rules',legacy.length===2)
    for(let i=0;i<3;i++){
      const out=await bed.run(bed.file(`profile-train-${i}`,`Independent scoped marker ${i}`),'current',{profile:true})
      check(`independent scoped run ${i}`,out?.results.length===2&&out.epistemicFailures===0)
      if(i===0)check('new identity inherits no legacy qualification',!(await bed.snapshots.list()).some(s=>s.environment===PDF_PROFILE_READING_VERSION&&s.usable))
    }
    const scoped=(await bed.snapshots.list()).find(s=>s.environment===PDF_PROFILE_READING_VERSION&&s.usable)
    check('new scoped identity qualifies from its own independent observations',scoped?.conditions.text_layer==='present'&&scoped.conditions.reader==='markitdown'&&!legacy.some(s=>s.claimId===scoped.claimId))
    const out=await bed.run(bed.file('guided','Guided scoped marker'),'model',{profile:true,viaTurn:true})
    check('ordinary turn executes profile then conditional extraction',out?.results.length===2&&out.results[0]?.request.capability===DOCUMENT_PROFILE&&out.results[1]?.request.arguments.expectedInputFingerprint===decode(out.results[0].result)?.inputFingerprint)
    check('new qualified rule participates in real comparison',out?.simulationsUsed===1&&out.comparisons?.[0]?.verdict==='match'&&out.epistemicFailures===0)
    const state=await bed.store.get(scoped!.claimId)
    check('guided scoped observation is dependent evidence',state?.uses.length===1&&state.evidence.at(-1)?.independent===false)
    await bed.store.commit(scoped!.claimId,{kind:'withdraw'})
    const withdrawn=await bed.run(bed.file('withdrawn','After scoped withdrawal'),'model',{profile:true})
    check('withdrawn scoped rule is no longer used',withdrawn!==undefined&&(withdrawn.simulationsUsed??0)===0&&withdrawn.epistemicFailures===0)
  }else{
    const path=bed.file('target',selected==='absent'?'':'PROFILE_BODY_MARKER'),other=bed.file('other','Other body marker')
    if(selected==='partial')writeFileSync(path,manyPages())
    if(selected==='parse-failed')writeFileSync(path,'%PDF-1.4\ninvalid objects\n')
    if(selected==='bad-magic')writeFileSync(path,'not a PDF')
    const {gateway,authorizations,staging,resolveTarget}=bed.turnHarness
    const event=(await bed.h.recordUserEvidence(`帮我读取「${path}」的正文`)).event
    const auth=authorizations.issue({conversationKey:String(event.conversationId),originalText:`读取「${path}」及「${other}」的正文`,triggeringEventId:String(event.id),
      allowedCapabilities:selected==='no-profile-permission'?[DOCUMENT_EXTRACT]:[DOCUMENT_PROFILE,DOCUMENT_EXTRACT],maxRiskLevel:'R1',budget:{maxActions:3,maxPlans:4,deadlineMs:90000}})
    const configured=await createDocumentRecoveryPlanning({...bed.modelOptions,profile:true,strategy:'current'})(`帮我读取「${path}」的正文`)
    assert.ok(configured)
    const native=createDocumentBeliefObserver(bed.h.db,bed.h.userId)
    let calls=0,plannerSaw=false,profileAction='',readAction='',profile:PdfProfile|undefined
    const custom=['wrong-target','wrong-task'].includes(selected)
    const text=`帮我读取「${path}」的正文`,traceId=asTraceId(`profile-${selected}`)
    const outcome=await runTask({gateway,registry:bed.registry,authorizations,staging,resolveTarget,ruleSnapshot:configured.ruleSnapshot,
      replanContext:{knownDirectories:()=>[],contentTokens:selected==='zero-budget'?0:4000},
      invocationFor:()=>({initiatorEvidence:attestActionInitiatorFromCausalOrigin({adapterId:'document-profile',causalSource:correlationSourceFromConversationEvent({adapterId:'document-profile',triggeringEvent:triggeringConversationEventOf(event)})}),riskBudgetOverride:'R1'}),
      planner:custom?{id:'binding-negative',endpointHost:'offline',async plan(){
        calls++;return{ok:true,requestCount:0,plan:{goal:'owned binding negative',done:true,steps:[{capability:DOCUMENT_PROFILE,operation:'inspect',args:{path}},
          ...(selected==='wrong-target'?[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path:other,reader:'markitdown'}}]:[])]}}
      }}:{...configured.planner,async plan(input){calls++;if(calls>1)plannerSaw=input.content?.some(c=>c.includes('pdf-profile@1')&&c.includes('inspectedPages'))??false;return await configured.planner.plan(input)}},
      epistemic:{before:custom?native.before:configured.epistemic!.before,async after(input){
        await (custom?native:configured.epistemic!).after(input)
        if(input.request.capability===DOCUMENT_PROFILE){profile=decode(input.result);profileAction=String(input.request.actionId)
          if(selected==='changed-input')writeFileSync(path,pdfFixture('Changed bytes','controlled drift'))
          if(selected==='cancelled')authorizations.close(auth.taskId,'cancelled')
          if(selected==='late-profile'){auth.expiresAt=Date.now()-1; // Re-delivery must clear any previously cached fact.
            await configured.epistemic!.after(input)}
        }else readAction=String(input.request.actionId)
      }},
    },{text,characterId:bed.h.kernel.characterId,traceId,authorization:auth})
    check('native observation completes without hook failure',outcome.epistemicFailures===0)
    const first=outcome.results[0]?.result
    if(selected==='no-profile-permission')check('missing capability never invokes an adapter',outcome.results.length===0&&bed.calls()===0)
    else if(['bad-magic','size','permission'].includes(selected))check('existing format size and permission guards reject before conversion',first?.status==='rejected'&&profile===undefined&&outcome.results.length===1)
    else if(['parse-failed','timeout','invalid-protocol'].includes(selected)){
      check('failed parser never reports absent or zero statistics',profile?.textLayer==='unknown'&&profile.pages===null&&profile.chars===null)
      check('failure is a real failure status and no extraction follows',first?.status===(selected==='timeout'?'timeout':'failed')&&outcome.results.length===1)
    }else if(selected==='zero-budget')check('cropped profile is not claimed visible to the planner',!plannerSaw&&outcome.results.length===1)
    else if(['cancelled','late-profile'].includes(selected))check('cancelled or expired profile is not consumed',outcome.results.length===1&&outcome.stopped===(selected==='cancelled'?'cancelled':'deadline'))
    else if(selected==='changed-input'){
      check('real profile reaches planner before input drift is checked',plannerSaw&&profile?.outcome==='complete')
      check('current bytes mismatch rejects conversion',outcome.results.length===2&&outcome.results[1]?.result.error?.details?.profileBinding==='source_changed')
      check('stale profile cannot form a scoped belief',!(await bed.snapshots.list()).some(s=>s.environment===PDF_PROFILE_READING_VERSION))
    }else if(selected==='partial'){
      check('real 65 page document stays partial and unknown',profile?.outcome==='partial'&&profile.reason==='page_limit'&&profile.pages===65&&profile.inspectedPages===64&&profile.textLayer==='unknown')
      check('partial scope reaches planner but supplies no text-layer condition',plannerSaw&&outcome.results[1]?.request.arguments.expectedInputFingerprint===undefined&&!(await bed.snapshots.list()).some(s=>s.environment===PDF_PROFILE_READING_VERSION))
    }else if(selected==='absent'){
      check('fully inspected empty PDF has absent text layer',profile?.outcome==='complete'&&profile.textLayer==='absent'&&profile.chars===0)
      check('absence does not masquerade as extracted body or validated belief',outcome.results[1]?.result.status==='not_found'&&!(await bed.snapshots.list()).some(s=>s.usable))
    }else if(custom){
      if(selected==='wrong-task'){
        const next=authorizations.issue({conversationKey:String(event.conversationId),originalText:text,triggeringEventId:String(event.id),allowedCapabilities:[DOCUMENT_EXTRACT],maxRiskLevel:'R1'})
        const nextOut=await runTask({gateway,registry:bed.registry,authorizations,staging,resolveTarget,
          invocationFor:()=>({initiatorEvidence:attestActionInitiatorFromCausalOrigin({adapterId:'document-profile',causalSource:correlationSourceFromConversationEvent({adapterId:'document-profile',triggeringEvent:triggeringConversationEventOf(event)})}),riskBudgetOverride:'R1'}),
          epistemic:native,planner:{id:'next-task',endpointHost:'offline',async plan(){return{ok:true,requestCount:0,plan:{goal:'new task',done:true,steps:[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path,reader:'markitdown',expectedInputFingerprint:profile!.inputFingerprint}}]}}}},
        },{text,characterId:bed.h.kernel.characterId,traceId:asTraceId('different-task-trace'),authorization:next})
        readAction=String(nextOut.results[0]!.request.actionId)
        check('new task may read independently without reusing old task context',nextOut.epistemicFailures===0&&nextOut.results[0]?.result.status==='success')
      }
      const ref=documentReadingRef(readAction,String(event.id),profileAction)
      const forged=makeEblClaim({characterId:String(bed.h.kernel.characterId),subjectId:bed.h.userId,domain:'tool',predicate:'document_extracts',expected:true,scope:'pdf_text',environment:PDF_PROFILE_READING_VERSION,
        conditions:{format:'pdf',reader:'markitdown',text_layer:'present'},formation:ref})
      const observation=await createEblSourceReader(bed.h.userId)(bed.h.db,ref,forged,false)
      check('ledger source rejects wrong target or cross-task profile support',observation?.complete===false&&observation.value===undefined)
      check('native before formed no scoped claim from the wrong binding',!(await bed.snapshots.list()).some(s=>s.environment===PDF_PROFILE_READING_VERSION))
    }else{
      check('actual structural JSON reaches next planner input',plannerSaw&&profile?.outcome==='complete'&&profile.textLayer==='present')
      check('normal flow is profile plus fingerprint-bound native extraction',outcome.results.length===2&&outcome.results[1]?.request.arguments.expectedInputFingerprint===profile?.inputFingerprint)
      check('profile contains no document body',!first?.turnContent?.[0]?.text.includes('PROFILE_BODY_MARKER'))
      check('structural context is explicitly distinct from body text',renderTurnContentEntry(first!.turnContent![0]!,'C1').includes('结构统计（不含正文）'))
      check('scoped formation retains both real action roots',(await bed.snapshots.list()).some(s=>s.environment===PDF_PROFILE_READING_VERSION&&s.conditions.text_layer==='present'))
      check('protocol rejects unknown fields',!readPdfProfile({...profile,extra:'absent'}))
      check('protocol rejects fake completeness and fake absence',!readPdfProfile({...profile,inspectedPages:0})&&!readPdfProfile({...profile,outcome:'partial',reason:'page_limit',textLayer:'absent'}))
      check('formal wiring includes capability adapter and argument whitelist',readFileSync('src/main.ts','utf8').includes('profile: true')&&readFileSync('src/kernel/action/task-plan.ts','utf8').includes("'document.profile': ['path']"))
      const catalog=buildToolCatalog(bed.registry,{isGateEnabled:key=>key==='documentReadEnabled',grantedPermissions:['document:read']})
      check('all PDF capabilities have their actual composite gates and both observed content producers',catalog.length===3
        &&catalog.every(e=>e.gateKey==='documentRecoveryEnabled'&&e.alsoRequires.includes('documentReadEnabled')&&e.alsoRequires.includes('epistemicBeliefEnabled'))
        &&turnContentFactsOf(outcome.results.map(r=>({...r,kind:'executed' as const})))?.length===2)
      check('closed PDF gate is represented as disabled in the real catalog',catalog.every(e=>!e.enabled)&&renderToolCatalogForModel(catalog).includes('document.profile'))
    }
    writeFileSync(resolve(bed.output,'profile-flow.json'),JSON.stringify({selected,status:'PASS',profile,checks,actionsUsed:outcome.actionsUsed,plansUsed:outcome.plansUsed,stopped:outcome.stopped,
      plannerSaw,modelCalls:0,location:'serversim/simhost',backend:'fresh isolated pgtest',productionOpened:false},null,2))
  }
  writeFileSync(resolve(bed.output,'profile-verification.json'),JSON.stringify({selected,status:'PASS',checks,measured_count:checks.length,modelCalls:0,productionOpened:false},null,2))
}finally{await bed.stop()}
