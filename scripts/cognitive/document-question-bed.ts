/** Isolated D assembly. The supplied answer port sees only the compiled packet, never the rubric. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import type { TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import type { ContextPacket } from '../../src/kernel/contracts/context.ts'
import { DOCUMENT_PAGES, documentPageRequest } from '../../src/kernel/contracts/document-pages.ts'
import { DOCUMENT_PROFILE } from '../../src/kernel/contracts/document-profile.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../../src/kernel/recall/selector.ts'
import { TurnGateway } from '../../src/kernel/app/turn-gateway.ts'
import { createDocumentRecoveryPlanning } from '../../src/infrastructure/runtime/document-recovery-planning.ts'
import { createEvaluationRecorder, type EvaluationRow } from './evaluation-recording.ts'
import type { createDocumentReadingBed } from './document-reading-bed.ts'

export async function runDocumentQuestion(bed:Awaited<ReturnType<typeof createDocumentReadingBed>>,input:{
  runId:string;text:string;control:'normal'|'zero'|'replacement';answer:(packet:ContextPacket)=>Promise<string>
}){
  const parsed=documentPageRequest(input.text);assert.ok(parsed?.question)
  const rows:EvaluationRow[]=[],recorder=createEvaluationRecorder({runId:input.runId,worldId:'D',episodeId:input.runId,arm:input.control},r=>rows.push(r))
  const configure=createDocumentRecoveryPlanning({...bed.modelOptions,profile:true}),configured=await configure(input.text);assert.ok(configured)
  const {gateway,authorizations,staging,resolveTarget}=bed.turnHarness
  let outcome:TaskRunOutcome|undefined
  const port=createActionTurnPort({gateway,registry:bed.registry,detector:{detect(){throw Error('role only')}},attribution:{adapterId:'document-reading'},
    toolDecision:{catalog:'PDF pages',port:{id:'D-offline-role',endpointHost:'offline',async decide(){return{ok:true,requestCount:0,
      raw:{branch:'tools',goal:'explicit page question',done:false,steps:[{capability:DOCUMENT_PAGES,operation:'read',args:parsed.goal}]}}}}},
    task:{authorizations:{...authorizations,issue:i=>authorizations.issue({...i,budget:{maxActions:3,maxPlans:4,deadlineMs:120000}})},
      planner:configured.planner,async configurePlanning(text){
        const c=await configure(text);assert.ok(c)
        return{...c,planner:{...c.planner,async plan(p){const result=await c.planner.plan(p);if(result.ok)recorder.begin([result.plan],null);return result}},
          epistemic:{async before(p){recorder.beforeAction(p.request);return c.epistemic!.before(p)},after:c.epistemic!.after}}
      },staging,resolveTarget,capabilitiesFor:()=>[DOCUMENT_PROFILE,DOCUMENT_PAGES],riskLevelFor:()=>'R1',
      replanContext:{knownDirectories:()=>[],contentTokens:4000},onTaskOutcome:o=>{outcome=o;recorder.outcome(o)}}})
  const turnGateway=new TurnGateway({kernel:bed.h.kernel,definition:bed.h.kernel.definition,identity:bed.h.kernel.identitySnapshot,
    recorder:bed.h.recorder,conversationSequence:bed.h.nextTurnSequence,slowPathEnabled:false,userId:bed.h.userId,actionEnabled:true,actionWriter:port,
    recallBudget:{...DEFAULT_CONTEXT_BUDGET,turnContentTokens:input.control==='zero'?0:1200}})
  const turn=await turnGateway.beginTurn(input.text)
  assert.ok(outcome&&outcome.epistemicFailures===0,'native observation must succeed')
  assert.equal(authorizations.find(outcome.taskId)?.originalText,input.text,'original question remains the authorization source')
  const originals=(turn.turnContent??[]).filter(c=>c.capability===DOCUMENT_PAGES)
  assert.equal(originals.length,1)
  if(input.control==='replacement'){
    // Owned, predeclared control fixture. It does not replace the Gateway result or acquire PDF provenance.
    turn.turnContent=turn.turnContent?.map(c=>{
      if(c.capability!==DOCUMENT_PAGES)return c
      const text='~'.repeat(c.text.length),fingerprint=createHash('sha256').update(text).digest('hex')
      return{...c,contentId:`evaluation-control:${input.runId}`,text,resultFingerprint:fingerprint,sourceFingerprint:fingerprint,
        sourceKind:'program-calculation' as const,resourceRef:'evaluation-control:owned-tilde-fixture',
        scope:{totalChars:text.length,includedChars:text.length,truncated:false},
        facts:['EVALUATION CONTROL: owned same-length replacement; NOT original PDF content'],structure:[]}
    })
  }
  const packet=await turnGateway.compileTurn({turn,currentInput:input.text,recentLines:[]})
  assert.ok(packet.text.includes(input.text),'the full original question reaches the compiled packet')
  recorder.final(turn)
  const actualIds=new Set(turn.turnContentInContext?.refs.map(r=>r.contentId)??[])
  const visible=(turn.turnContent??[]).filter(c=>c.capability===DOCUMENT_PAGES&&actualIds.has(c.contentId))
  assert.ok(visible.every(c=>packet.text.includes(c.text)))
  const countsBefore=bed.calls(),raw=await input.answer(packet)
  assert.equal(bed.calls(),countsBefore,'answer port does not execute tools')
  await recorder.events(bed.h.db,bed.h.kernel.characterId)
  assert.equal(recorder.failures,0)
  // Controlled assembly/scorer checks do not persist a generated answer or injected content as an experience.
  await turnGateway.completeTurn({turn,replyText:'离线接线校准；无真实模型答题结论。'})
  return{packet,raw,rows,outcome,visible:visible.map(c=>({page:parsed.goal.firstPage,text:c.text})),originals,
    report:{runId:input.runId,control:input.control,originalRequestPreserved:true,actionsUsed:outcome.actionsUsed,
      actions:outcome.results.map(r=>({capability:r.request.capability,withinExplicitTarget:r.request.arguments.path===parsed.goal.path,status:r.result.status})),
      retrieved:outcome.goal?.achieved??null,originalDelivered:turn.actionResults?.[0]?.task?.goal?.delivered??null,
      visibleBodyCount:visible.length,observerFailures:outcome.epistemicFailures,answerPortCalls:1,
      packetFingerprint:createHash('sha256').update(packet.text).digest('hex'),injection:input.control==='replacement'?'owned same-length tilde fixture; eval only':'none'}}
}
