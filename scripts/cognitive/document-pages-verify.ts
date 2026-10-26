import 'dotenv/config'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed, pdfFixture } from './document-reading-bed.ts'
import { DOCUMENT_PAGES, documentPageGoal, checkPdfPageGoal, readPdfPagesReceipt } from '../../src/kernel/contracts/document-pages.ts'
import { DOCUMENT_PROFILE } from '../../src/kernel/contracts/document-profile.ts'
import { createDocumentRecoveryPlanning } from '../../src/infrastructure/runtime/document-recovery-planning.ts'
import { runPdfPages } from '../../src/infrastructure/action/adapters/document-pages.ts'
import { ActionFailureError, actionFailure } from '../../src/kernel/action/errors.ts'
import { runTask, type TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { TurnGateway } from '../../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../../src/kernel/recall/selector.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'

const cases=['normal','range','prefix','truncated','tail','recovery','empty','changed-input','permission','no-page-permission','zero-planning-budget','zero-final-budget','context-cut','cancelled','superseded','wrong-target','invalid-protocol','legacy-refutation']
if(process.argv.includes('--list-cases')){console.log(cases.join('\n'));process.exit(0)}
const selected=process.argv[process.argv.indexOf('--case')+1];assert.ok(cases.includes(selected))
const bed=await createDocumentReadingBed(`pages-${selected}`,{},{},selected==='permission'?{async resolveTarget(){throw new ActionFailureError(actionFailure('permission_denied','owned page negative'))}}
  :selected==='recovery'||selected==='legacy-refutation'?{async readPages(input){return runPdfPages({...input,...(input.reader==='pdfplumber'?{pythonPath:'/missing-owned-page-python'}:{})})}}:{})
const checks:string[]=[],check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`)}
function pagesPdf(texts:string[]){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${texts.map((_,i)=>`${4+2*i} 0 R`).join(' ')}] /Count ${texts.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  texts.forEach(text=>{const stream=text?`BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g,'\\$&')}) Tj ET`:'q Q'
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length+2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)})
  let data='%PDF-1.4\n';const offsets:number[]=[]
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${o}\nendobj\n`})
  const xref=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(data)
}
let outcome:TaskRunOutcome|undefined
try{
  let evidenceBefore=''
  if(selected==='recovery'){
    await bed.train();await bed.run(bed.file('real-empty-counterexample',''),'model')
    const suspended=(await bed.snapshots.list()).find(s=>s.conditions.reader==='markitdown'&&!s.usable)
    check('existing real empty-PDF counterexample suspends legacy rule',suspended!==undefined)
    evidenceBefore=JSON.stringify(await bed.store.get(suspended!.claimId))
  }
  const path=bed.file('target','unused'),other=bed.file('other','UNRELATED_SUCCESS')
  const long=selected==='tail'?'A'.repeat(61000):'A'.repeat(1500)
  writeFileSync(path,pagesPdf([selected==='tail'?long:'FIRST_PAGE_ONLY',selected==='empty'?'':selected==='prefix'||selected==='truncated'?long:'PAGE_TWO_BODY_MARKER', 'PAGE_THREE_BODY_MARKER']))
  const text=`帮我读取「${path}」第 ${selected==='range'?'2–3':'2'} 页${selected==='prefix'?'前 400 字':''}的正文`
  const configure=createDocumentRecoveryPlanning({...bed.modelOptions,profile:true,strategy:'current'})
  const configured=await configure(text);assert.ok(configured?.completion)
  const {gateway,authorizations,staging,resolveTarget}=bed.turnHarness
  const allowed=selected==='no-page-permission'?[DOCUMENT_PROFILE]:[DOCUMENT_PROFILE,DOCUMENT_PAGES]
  const replanContext={knownDirectories:()=>[],contentTokens:selected==='zero-planning-budget'?0:4000}
  if(selected==='invalid-protocol'){
    check('explicit range parser rejects guessed, oversized and relative targets',!documentPageGoal('读取「x.pdf」第 1 页正文')&&!documentPageGoal(`读取「${path}」第 1–5 页正文`)&&!documentPageGoal(`读取「${path}」第 2 页前 1201 字正文`))
    check('closed receipt rejects fabricated completeness',!readPdfPagesReceipt({protocol:'pdf-pages@1',inputFingerprint:'a'.repeat(64),reader:'pdfplumber',firstPage:2,lastPage:2,prefixChars:null,pages:[{page:2,totalChars:10,includedChars:11}]}))
  }
  if(selected==='normal'||selected==='zero-final-budget'||selected==='context-cut'){
    const port=createActionTurnPort({gateway,registry:bed.registry,detector:{detect(){throw Error('role only')}},attribution:{adapterId:'document-reading'},
      toolDecision:{catalog:'PDF pages',port:{id:'offline-role',endpointHost:'offline',async decide(){return{ok:true,requestCount:0,raw:{branch:'tools',goal:'explicit page',done:false,steps:[{capability:DOCUMENT_PAGES,operation:'read',args:{path,firstPage:2,lastPage:2}}]}}}}},
      task:{authorizations,planner:configured.planner,configurePlanning:configure,staging,capabilitiesFor:()=>allowed,replanContext,riskLevelFor:()=>'R1',resolveTarget,onTaskOutcome:o=>{outcome=o}}})
    // Use ordinary action-turn assembly, including its scoped completion hook.
    const turnGateway=new TurnGateway({kernel:bed.h.kernel,definition:bed.h.kernel.definition,identity:bed.h.kernel.identitySnapshot,recorder:bed.h.recorder,
      conversationSequence:bed.h.nextTurnSequence,slowPathEnabled:false,userId:bed.h.userId,actionEnabled:true,actionWriter:port,
      recallBudget:{...DEFAULT_CONTEXT_BUDGET,turnContentTokens:selected==='zero-final-budget'?0:4000},...(selected==='context-cut'?{tokenBudget:1}:{})})
    const turn=await turnGateway.beginTurn(text),packet=await turnGateway.compileTurn({turn,currentInput:text,recentLines:[]})
    const goal=turn.actionResults?.[0]?.task?.goal
    check('trusted range goal retrieved through real action-turn assembly',outcome?.goal?.achieved&&outcome.stopped==='done'&&goal?.achieved)
    const delivered=selected==='normal'
    check('final compiler reports actual body visibility',goal?.delivered===delivered&&packet.text.includes('PAGE_TWO_BODY_MARKER')===delivered)
    check('unrequested first-page body never enters packet',!packet.text.includes('FIRST_PAGE_ONLY'))
    await turnGateway.completeTurn({turn,replyText:'隔离验收占位回复。'})
  }else{
    const event=(await bed.h.recordUserEvidence(text)).event
    const auth=authorizations.issue({conversationKey:String(event.conversationId),originalText:text,triggeringEventId:String(event.id),allowedCapabilities:allowed,maxRiskLevel:'R1',budget:{maxActions:3,maxPlans:8,deadlineMs:90000}})
    const forecast=selected==='recovery'||selected==='legacy-refutation'?{deadlineMs:1000,port:{id:'offline-status-fixture',endpointHost:'offline',async forecast(input:import('../../src/kernel/action/action-forecast.ts').ActionForecastInput){return{ok:true as const,requestCount:0,forecast:{schemaVersion:'action-forecast@1' as const,producedAt:input.producedAt,inputRevision:input.inputRevision,steps:input.candidateSteps.map(s=>({...s,dependsOn:[],expectedVisibleOutcome:'fixture success',check:{kind:'status_is' as const,status:'success' as const},uncertainty:'low' as const}))}}}}}:undefined
    outcome=await runTask({gateway,registry:bed.registry,authorizations,staging,resolveTarget,planner:configured.planner,ruleSnapshot:configured.ruleSnapshot,replanContext,
      ...(selected==='legacy-refutation'?{}:{completion:configured.completion}),...(forecast?{forecast}:{}),
      invocationFor:()=>({initiatorEvidence:attestActionInitiatorFromCausalOrigin({adapterId:'document-reading',causalSource:correlationSourceFromConversationEvent({adapterId:'document-reading',triggeringEvent:triggeringConversationEventOf(event)})}),riskBudgetOverride:'R1'}),
      epistemic:{before:configured.epistemic!.before,async after(input){await configured.epistemic!.after(input)
        if(input.request.capability===DOCUMENT_PROFILE){
          if(selected==='changed-input')writeFileSync(path,pdfFixture('Changed body','drift'))
          if(selected==='cancelled')authorizations.close(auth.taskId,'cancelled')
          if(selected==='superseded')authorizations.issue({conversationKey:String(event.conversationId),originalText:'next task',triggeringEventId:String(event.id),allowedCapabilities:allowed,maxRiskLevel:'R1'})
        }}}}, {text,characterId:bed.h.kernel.characterId,traceId:asTraceId(`pages-${selected}`),authorization:auth})
    check('native observers complete without errors',outcome.epistemicFailures===0)
    if(selected==='no-page-permission')check('missing capability executes nothing',outcome.results.length===0&&!outcome.goal?.achieved)
    else if(selected==='zero-planning-budget')check('invisible profile cannot authorize a page follow-up',outcome.results.length===1&&!outcome.goal?.achieved)
    else if(selected==='cancelled'||selected==='superseded')check('closed task cannot consume profile or claim goal',outcome.results.length===1&&outcome.stopped===selected&&!outcome.goal?.achieved)
    else if(selected==='permission'||selected==='changed-input')check('permission or changed bytes stop before successful body',outcome.results.length===2&&outcome.results[1]?.result.status==='rejected'&&!outcome.goal?.achieved)
    else if(selected==='truncated'||selected==='empty')check('partial or empty whole page cannot satisfy goal',!outcome.goal?.achieved&&outcome.stopped!=='done'&&outcome.results.length===3)
    else if(selected==='legacy-refutation')check('legacy completion still rejects an outstanding forecast mismatch',outcome.stopped==='check_refuted'&&outcome.comparisons?.some(c=>c.verdict==='mismatch')&&outcome.goal===undefined)
    else{
      check('exact bounded page goal completes',outcome.stopped==='done'&&outcome.goal?.achieved)
      const last=outcome.results.at(-1)!,item=last.result.turnContent![0]!
      check('only requested body is retrieved',item.text.includes(selected==='prefix'?'A'.repeat(400):'PAGE_TWO_BODY_MARKER')&&!item.text.includes('FIRST_PAGE_ONLY'))
      if(selected==='range')check('both requested physical pages arrive together',item.text.includes('PAGE_THREE_BODY_MARKER'))
      if(selected==='prefix')check('explicit prefix succeeds while full-page truncation remains honest',item.scope.truncated&&item.text.length<500)
      if(selected==='wrong-target')check('unrelated success cannot satisfy exact target',!checkPdfPageGoal({...documentPageGoal(text)!,path:other},item.sourceFingerprint,outcome.results,outcome.goal!.contentIds).achieved)
      if(selected==='tail'){
        const whole=await bed.run(path,'current',{forced:'pdfminer'})
        check('bounded tail survives where whole-file formal prefix misses it',!whole!.results[0]!.result.turnContent![0]!.text.includes('PAGE_TWO_BODY_MARKER')&&item.text.includes('PAGE_TWO_BODY_MARKER'))
      }
      if(selected==='recovery'){
        check('real subprocess failure recovers through second reader',outcome.results.length===3&&outcome.results[1]!.result.status==='failed'&&last.request.arguments.reader==='pdfminer')
        check('goal completion preserves prior mismatch',outcome.comparisons?.map(c=>c.verdict).join(',')==='match,mismatch,match')
        const suspended=(await bed.snapshots.list()).find(s=>s.conditions.reader==='markitdown'&&!s.usable)
        check('existing EBL counterexample and lifecycle remain byte-for-byte unchanged',JSON.stringify(await bed.store.get(suspended!.claimId))===evidenceBefore)
      }
    }
  }
  writeFileSync(resolve(bed.output,'pages-verification.json'),JSON.stringify({selected,status:'PASS',checks,measured_count:checks.length,stopped:outcome?.stopped,goal:outcome?.goal,
    actions:outcome?.results.map(r=>({capability:r.request.capability,reader:r.request.arguments.reader,status:r.result.status})),comparisons:outcome?.comparisons,
    injection:['recovery','legacy-refutation'].includes(selected)?'controlled real missing subprocess executable':'none',modelCalls:0,productionOpened:false,location:'serversim/simhost',backend:'fresh isolated pgtest'},null,2))
}finally{await bed.stop()}
