/** Evaluation-only observation/export. Never imported by src/ or used as evidence authority. */
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { TaskPlan } from '../../src/kernel/action/task-plan.ts'
import type { ActionRequest } from '../../src/kernel/action/action-request.ts'
import type { TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import type { IncomingTurn } from '../../src/kernel/app/turn-gateway.ts'
import type { SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { countDomainEvents, domainEventsFor } from '../../src/infrastructure/persistence/event-store.ts'
import { exec, type RawDb } from '../../src/infrastructure/persistence/db.ts'
import { EBL_EVENT, validateEblEventPayload } from '../../src/kernel/contracts/epistemic-belief.ts'
import type { CharacterId } from '../../src/kernel/contracts/ids.ts'

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])) : v
export const evaluationDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export type EvaluationRow = Record<string, unknown>
export function createEvaluationRecorder(identity:{runId:string;worldId:string;episodeId:string;arm:string},
  sink:(row:EvaluationRow)=>void) {
  let ordinal=0,active:string|null=null,task:string|null=null,failures=0
  const actions=new Map<string,string|null>(), candidates=new Map<string,string[]>()
  const emit=(row:EvaluationRow)=>{try{sink({protocol:'evaluation-record@1',...identity,recordedAt:Date.now(),...row})}catch{failures++}}
  return {
    get failures(){return failures},
    begin(plans:readonly TaskPlan[],anchor:{policy:'first-candidate';index:0}|null){
      active=`${identity.episodeId}:${++ordinal}`
      const digests=plans.map(p=>evaluationDigest(p.steps.map(s=>({capability:s.capability,operation:s.operation,args:s.args}))))
      candidates.set(active,digests)
      emit({kind:'decision',decisionId:active,ordinal,candidateCount:digests.length,actionableCandidateCount:plans.filter(p=>p.steps.length>0).length,candidateFingerprints:digests,
        distinctActionSequences:new Set(digests).size,anchor:anchor?{policy:anchor.policy,index:anchor.index}:null,
        anchorStatus:anchor?'CONFIGURED':'NOT_CONFIGURED'})
    },
    selection(selection:SimulationPlanSelection){
      const digests=active?candidates.get(active):undefined
      emit({kind:'selection',decisionId:active,reason:selection.reason,selectedIndex:selection.selectedIndex??null,
        selectedFingerprint:selection.selectedIndex===undefined?null:digests?.[selection.selectedIndex]??null,
        eligibilityStatus:selection.ruleSelection?'OBSERVED':'MISSING',
        eligibleRules:selection.ruleSelection?.selected.map(s=>({claimId:evaluationDigest(s.claimId),scope:s.scope,environment:s.environment,
          ruleVersion:s.ruleVersion,evidenceFingerprint:s.evidenceFingerprint}))??null,
        skippedRules:selection.ruleSelection?.skipped.map(s=>({claimId:evaluationDigest(s.claimId),reason:s.reason}))??null,
        simulation:selection.report?{paths:selection.report.comparedPaths,truncated:selection.report.truncated,
          outcomes:selection.report.traces.map(t=>({id:t.id,outcome:t.outcome,steps:t.steps.length}))}:null})
    },
    beforeAction(request:ActionRequest){actions.set(String(request.actionId),active)},
    outcome(outcome:TaskRunOutcome,goal?:{achieved:boolean}){
      task=evaluationDigest(outcome.taskId)
      emit({kind:'outcome',taskId:task,stopped:outcome.stopped,actionsUsed:outcome.actionsUsed,plansUsed:outcome.plansUsed,
        simulations:outcome.simulationsUsed??0,forecastPortCalls:outcome.forecastCallsUsed??0,
        observerFailures:outcome.epistemicFailures??null,telemetryFailures:failures,
        goalConfigured:outcome.goal!==undefined,retrieved:outcome.goal?.achieved??'NOT_CONFIGURED',
        independentGoal:goal?.achieved??'NOT_CONFIGURED',
        comparisons:outcome.comparisons?.map(c=>({capability:c.capability,verdict:c.verdict,
          actionId:c.actualSourceRef?evaluationDigest(c.actualSourceRef):null,modelVersion:c.modelVersion??null,
          refutedRuleVersion:c.refutedRuleVersion??null}))??[],
        actions:outcome.results.map(({request,result})=>({actionId:evaluationDigest(String(request.actionId)),
          decisionId:actions.get(String(request.actionId))??null,capability:request.capability,operation:request.operation,
          parameterFingerprint:evaluationDigest(request.arguments),status:result.status,executed:result.executed,
          contents:result.turnContent?.map(c=>({contentId:evaluationDigest(c.contentId),sourceFingerprint:c.sourceFingerprint,
            resultFingerprint:c.resultFingerprint,scope:c.scope}))??[]}))})
    },
    final(turn:IncomingTurn){
      const reality=turn.turnContentInContext
      const goals=(turn.actionResults??[]).flatMap(r=>r.task?.goal?[r.task.goal]:[])
      emit({kind:'final',taskId:task,traceId:evaluationDigest(String(turn.traceId)),
        contextStatus:reality?'OBSERVED':'MISSING',contentIds:reality?.refs.map(r=>evaluationDigest(r.contentId))??null,
        goalConfigured:goals.length>0,goals:goals.map(g=>({achieved:g.achieved,delivered:reality?(g.delivered??'MISSING'):'MISSING',
          contentIds:g.contentIds.map(evaluationDigest)})),telemetryFailures:failures})
    },
    async events(db:RawDb,characterId:CharacterId){
      // Both caller-prepared target and live identity are mandatory before reading events.
      const target=new URL(process.env.LG_TEST_PG_URL??'invalid:')
      const database=decodeURIComponent(target.pathname.replace(/^\//,''))
      if(target.hostname!=='pgtest'||!/^lg_test_[a-z0-9_]+$/.test(database))throw Error('evaluation_export_requires_isolated_pgtest')
      const identityRows=await exec(db,sql`select current_database() as database, current_user as role`,'evaluation isolated identity')
      if(identityRows[0]?.database!==database||identityRows[0]?.role!==decodeURIComponent(target.username))throw Error('evaluation_export_identity_mismatch')
      const count=await countDomainEvents(db,characterId,EBL_EVENT)
      if(count>=100000)throw Error('evaluation_export_would_truncate')
      const events=await domainEventsFor(db,characterId,{type:EBL_EVENT})
      for(const event of events){
        const p=validateEblEventPayload(event.payload),c=p.command
        const observation=p.settlement?.observation??p.formation
        const actionIds=[...(observation?.rootIds??[]).filter(id=>id.startsWith('action:')).map(id=>id.slice(7)),
          ...(c.kind==='register'?[c.test.id]:[]),...(c.kind==='use'?[c.use.decisionId]:[])]
        emit({kind:'ebl-event',eventId:evaluationDigest(String(event.id)),sequence:event.sequence,at:event.createdAt,
          claimId:evaluationDigest(p.claimId),command:c.kind,nextStatus:p.nextStatus,sourceFingerprint:p.sourceFingerprint,
          relatedClaimId:c.kind==='supersede'?evaluationDigest(c.successorId):c.kind==='propose'&&c.claim.predecessor?evaluationDigest(c.claim.predecessor):null,
          verdict:p.settlement?.verdict??null,independent:p.settlement?.independent??null,
          observedAt:observation?.observedAt??null,model:p.settlement?.model?{
            modelVersion:p.settlement.model.modelVersion,ruleVersion:p.settlement.model.ruleVersion,
            forecastVerdict:p.settlement.model.forecastVerdict??null}:null,
          sourceRoots:observation?.rootIds.map(evaluationDigest)??[],
          actions:actionIds.map(id=>({actionId:evaluationDigest(id),decisionId:actions.get(id)??null})),
          phase:actionIds.some(id=>actions.has(id))?'task':'setup'})
      }
      return{count:events.length,telemetryFailures:failures}
    },
  }
}
