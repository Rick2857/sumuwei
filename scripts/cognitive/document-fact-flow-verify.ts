import 'dotenv/config'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed, pdfFixture } from './document-reading-bed.ts'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { DOCUMENT_EXTRACT } from '../../src/kernel/contracts/document-reading.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { createDocumentBeliefObserver } from '../../src/infrastructure/runtime/document-belief.ts'

const cases=['normal','zero-content-budget','no-context','wrong-target','changed-input','cancel-during-planning','cancel-before-execution','cancel-between-steps','cancel-after-last-step','superseded-during-planning','late-result']
if(process.argv.includes('--list-cases')){console.log(cases.join('\n'));process.exit(0)}
const selected=process.argv[process.argv.indexOf('--case')+1];assert.ok(cases.includes(selected))
const bed=await createDocumentReadingBed(`fact-flow-${selected}`)
const {gateway,authorizations,staging,resolveTarget}=bed.turnHarness
const path=bed.file('first','FACT_FLOW_WORD with real source bytes'), other=bed.file('other','Different authorized document')
const text=`读取「${path}」；需要时读取「${other}」。`, event=(await bed.h.recordUserEvidence(text)).event
const authorization=authorizations.issue({conversationKey:String(event.conversationId),originalText:text,triggeringEventId:String(event.id),
  allowedCapabilities:[DOCUMENT_EXTRACT],maxRiskLevel:'R1',budget:{maxActions:2,maxPlans:3,deadlineMs:60_000}})
const native=createDocumentBeliefObserver(bed.h.db,bed.h.userId)
type Fact={taskId:string;anchor:string;path:string;actionId:string;sourceFingerprint:string;totalChars:number;truncated:boolean}
let fact:Fact|undefined, plans=0, plannerSaw=false, hookSaw=false, matchedCurrentInput:boolean|undefined, provisional=false
const checks:string[]=[],check=(n:string,c:unknown)=>{assert.ok(c,n);checks.push(n);console.log(`PASS ${n}`)}
try{
  const outcome=await runTask({gateway,registry:bed.registry,authorizations,staging,resolveTarget,
    ...(selected==='no-context'?{}:{replanContext:{knownDirectories:()=>[],contentTokens:selected==='zero-content-budget'?0:4000}}),
    invocationFor:()=>({initiatorEvidence:attestActionInitiatorFromCausalOrigin({adapterId:'fact-flow',causalSource:correlationSourceFromConversationEvent({adapterId:'fact-flow',triggeringEvent:triggeringConversationEventOf(event)})}),riskBudgetOverride:'R1'}),
    planner:{id:'fact-flow-scripted',endpointHost:'offline',async plan(input){
      plans++
      if(plans===1)return{ok:true,requestCount:0,plan:{goal:'read a real source',done:selected==='cancel-after-last-step',steps:[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path,reader:'markitdown'}},
        ...(selected==='cancel-between-steps'?[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path,reader:'pdfminer'}}]:[])]}}
      plannerSaw=Boolean(input.content?.some(line=>line.includes('FACT_FLOW_WORD')&&line.includes('提取字符数')))
      if(selected==='cancel-during-planning')authorizations.close(authorization.taskId,'cancelled')
      if(selected==='superseded-during-planning')authorizations.issue({conversationKey:String(event.conversationId),originalText:'new owner task',triggeringEventId:String(event.id),allowedCapabilities:[DOCUMENT_EXTRACT],maxRiskLevel:'R1'})
      const target=selected==='wrong-target'?other:path
      if(!plannerSaw||!fact||fact.taskId!==authorization.taskId||fact.anchor!==String(event.id)||fact.path!==target)return{ok:false,requestCount:0,failure:'call_failed'}
      return{ok:true,requestCount:0,plan:{goal:'second real reader',done:true,steps:[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path:target,reader:'pdfminer'}}]}}
    }},
    epistemic:{async before(input){
      if(input.request.arguments.reader==='pdfminer'){
        hookSaw=Boolean(fact&&fact.taskId===input.authorization.taskId&&fact.anchor===input.authorization.triggeringEventId&&fact.path===input.request.arguments.path)
        provisional=hookSaw // Freshness is unproven until the current authorized read returns its own byte fingerprint.
        if(selected==='cancel-before-execution')authorizations.close(authorization.taskId,'cancelled')
      }
      return await native.before(input)
    },async after(input){
      await native.after(input)
      const item=input.result.turnContent?.[0]
      if(input.request.arguments.reader==='markitdown'&&item?.sourceFingerprint){
        fact={taskId:input.authorization.taskId,anchor:input.authorization.triggeringEventId,path:String(input.request.arguments.path),actionId:String(input.request.actionId),
          sourceFingerprint:item.sourceFingerprint,totalChars:item.scope.totalChars,truncated:item.scope.truncated}
        if(selected==='changed-input')writeFileSync(path,pdfFixture('CHANGED_INPUT_AFTER_FIRST_RECEIPT','external-state-drift'))
        if(selected==='late-result'){authorization.expiresAt=Date.now()-1;fact=undefined}
        if(['cancel-between-steps','cancel-after-last-step'].includes(selected))authorizations.close(authorization.taskId,'cancelled')
      }else if(input.request.arguments.reader==='pdfminer'){
        matchedCurrentInput=Boolean(provisional&&item?.sourceFingerprint===fact?.sourceFingerprint)
        if(!matchedCurrentInput)fact=undefined
      }
    }},
  },{text,characterId:bed.h.kernel.characterId,traceId:asTraceId(`flow-${selected}`),authorization})
  check('first source was read through the real Gateway',outcome.results[0]?.result.status==='success'&&outcome.results[0]?.result.executed)
  check('native EBL lifecycle observation completed',outcome.epistemicFailures===0)
  if(selected==='normal'){
    check('actual prior content and facts reached the next planner',plannerSaw)
    check('task-local actual receipt reached the next before callback',hookSaw&&outcome.actionsUsed===2)
    check('current input fingerprint confirmed the provisional condition',matchedCurrentInput===true)
  }else if(selected==='changed-input'){
    check('earlier receipt was available but explicitly provisional',plannerSaw&&hookSaw&&provisional)
    check('real changed bytes invalidate the old condition after readback',outcome.actionsUsed===2&&matchedCurrentInput===false&&fact===undefined)
  }else if(selected==='cancel-during-planning'){
    check('cancellation during awaited planning prevents the proposed next action',outcome.results.length===1&&outcome.stopped==='cancelled'&&!hookSaw)
  }else if(selected==='superseded-during-planning'){
    check('new task supersession prevents the old next action',outcome.results.length===1&&outcome.stopped==='superseded'&&!hookSaw)
  }else if(selected==='cancel-before-execution'){
    check('cancellation inside before hook prevents executor invocation',outcome.results.length===1&&outcome.stopped==='cancelled'&&hookSaw&&bed.calls()===1)
  }else if(['cancel-between-steps','cancel-after-last-step'].includes(selected)){
    check('closed authorization is preserved between actions and at completion',outcome.results.length===1&&outcome.stopped==='cancelled'&&!hookSaw&&bed.calls()===1)
  }else if(selected==='late-result'){
    check('expired result is not promoted to a next-step condition',outcome.results.length===1&&outcome.stopped==='deadline'&&!fact&&!hookSaw)
  }else if(selected==='wrong-target'){
    check('source fact cannot be reused for a different target',plannerSaw&&outcome.results.length===1&&!hookSaw)
  }else{
    check('missing or zero-budget context does not claim planner visibility',!plannerSaw&&outcome.results.length===1&&!hookSaw)
  }
  writeFileSync(resolve(bed.output,'flow.json'),JSON.stringify({status:'PASS',selected,checks,measured_count:checks.length,
    actions:outcome.actionsUsed,plans:outcome.plansUsed,stopped:outcome.stopped,plannerSaw,hookSaw,matchedCurrentInput,
    mechanism:'existing replanContext plus test-scoped after-to-before receipt handoff; no production profile consumer implemented',
    freshness:'prior facts remain provisional until matched by the current authorized read receipt',
    injection:selected==='changed-input'?'owned file state drift':selected==='late-result'?'controlled deadline expiry':'none',
    modelCalls:0,productionOpened:false,location:'serversim/simhost',backend:'fresh isolated pgtest'},null,2))
}catch(error){writeFileSync(resolve(bed.output,'flow-failure.json'),JSON.stringify({selected,error:String(error),checks,
  actionsUsed:authorization.actionsUsed,closedReason:authorization.closedReason,hookSaw,plannerSaw},null,2));throw error}
finally{await bed.stop()}
