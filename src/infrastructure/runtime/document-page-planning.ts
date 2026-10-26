import { DOCUMENT_PAGES, PDF_PAGE_READERS, documentPageRequest, checkPdfPageGoal, type PdfPageReader } from '../../kernel/contracts/document-pages.ts'
import { DOCUMENT_PROFILE } from '../../kernel/contracts/document-profile.ts'
import type { ActionTurnPortOptions } from '../../kernel/action/action-turn.ts'
import type { ActionResult } from '../../kernel/action/action-result.ts'
import type { TaskPlannerPort } from '../../kernel/action/task-plan.ts'
import type { WorldModelForecastOptions } from './world-model-forecast.ts'
import { createEblRuleSnapshotPort } from './ebl-rule-snapshot.ts'
import { createDocumentBeliefObserver } from './document-belief.ts'

type Configure=NonNullable<NonNullable<ActionTurnPortOptions['task']>['configurePlanning']>
export function createDocumentPagePlanning(options:WorldModelForecastOptions):Configure {
  return async text=>{
    const goal=documentPageRequest(text)?.goal
    if(!goal)return undefined
    const native=createDocumentBeliefObserver(options.db,options.activeUserId),tried=new Set<PdfPageReader>()
    let profiled=false,last:ActionResult|undefined
    const planner:TaskPlannerPort={id:'document-pages@1',endpointHost:'local',async plan(input){
      if(!profiled){
        if(!input.allowedCapabilities.includes(DOCUMENT_PROFILE)||!input.allowedCapabilities.includes(DOCUMENT_PAGES)||input.remainingActions<2)
          return{ok:false,requestCount:0,failure:'call_failed'}
        profiled=true
        return{ok:true,requestCount:0,plan:{goal:'检查用户指定 PDF 的当前结构',done:false,steps:[{capability:DOCUMENT_PROFILE,operation:'inspect',args:{path:goal.path}}]}}
      }
      const observed=native.profileFor(goal.path)
      if(!observed||!input.content?.some(c=>c.includes(JSON.stringify(observed.profile))))return{ok:false,requestCount:0,failure:'call_failed'}
      // done is only a proposal. The trusted completion check decides whether the exact range reached context.
      if(last?.status==='success')return{ok:true,requestCount:0,plan:{goal:'核对明确页目标与实际交付范围',done:true,steps:[]}}
      if(tried.size>=2||input.remainingActions<1||!input.allowedCapabilities.includes(DOCUMENT_PAGES)
        ||last?.status==='rejected'||last?.status==='cancelled')return{ok:false,requestCount:0,failure:'call_failed'}
      const reader=PDF_PAGE_READERS.find(r=>!tried.has(r))!
      return{ok:true,requestCount:0,plan:{goal:'读取明确物理页和可选前缀',done:false,steps:[{capability:DOCUMENT_PAGES,operation:'read',args:{...goal,reader,expectedInputFingerprint:observed.profile.inputFingerprint}}]}}
    }}
    return{planner,ruleSnapshot:createEblRuleSnapshotPort(options.db,options.characterId,options.activeUserId),
      completion:({results,visibleContentIds})=>checkPdfPageGoal(goal,native.profileFor(goal.path)?.profile.inputFingerprint,results,visibleContentIds),
      epistemic:{before:native.before,async after(input){
        await native.after(input)
        if(input.request.capability===DOCUMENT_PAGES){tried.add(input.request.arguments.reader as PdfPageReader);last=input.result}
      }}}
  }
}
