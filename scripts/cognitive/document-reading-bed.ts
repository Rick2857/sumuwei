import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createM4Harness } from '../m4-harness.ts'
import { isolateDatabase, resetPluginSqlConnection } from '../../src/dev/sandbox.ts'
import { createCapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { runTask, type TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'
import type { TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { attestActionInitiatorFromCausalOrigin, correlationSourceFromConversationEvent, triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import { DOCUMENT_EXTRACT, createDocumentExtractionDefinitions, type PdfReader } from '../../src/kernel/contracts/document-reading.ts'
import { createDocumentExtractionAdapter } from '../../src/infrastructure/action/adapters/document-extraction.ts'
import { resolveSandboxPath } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import type { DocumentReadOptions } from '../../src/infrastructure/action/adapters/document-read.ts'
import { resolveLocalTarget } from '../../src/kernel/action/local-target.ts'
import { createActionLedgerStore } from '../../src/infrastructure/action/action-ledger-store.ts'
import { createEblRuleSnapshotPort } from '../../src/infrastructure/runtime/ebl-rule-snapshot.ts'
import { createEblStore } from '../../src/infrastructure/persistence/epistemic-belief-store.ts'
import { createEblSourceReader } from '../../src/infrastructure/persistence/epistemic-belief-source.ts'
import { createDocumentBeliefObserver } from '../../src/infrastructure/runtime/document-belief.ts'
import { createDocumentRecoveryPlanning } from '../../src/infrastructure/runtime/document-recovery-planning.ts'
import { createDocumentProfileAdapter } from '../../src/infrastructure/action/adapters/document-profile.ts'
import { DOCUMENT_PROFILE } from '../../src/kernel/contracts/document-profile.ts'
import { createDocumentPagesAdapter } from '../../src/infrastructure/action/adapters/document-pages.ts'
import type { DocumentCoverageReferencePort } from '../../src/infrastructure/runtime/document-coverage-reference.ts'

/** Small real PDF, xref offsets computed from bytes; no mocked reader outcomes. */
export function pdfFixture(text: string, tag: string): Buffer {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : 'q Q'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let body = `%PDF-1.4\n% ${tag}\n`; const offsets = [0]
  objects.forEach((o,i) => { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${o}\nendobj\n` })
  const xref=Buffer.byteLength(body)
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}
export async function createDocumentReadingBed(label: string, adapterOptions: Partial<DocumentReadOptions> = {}, profileOptions: Partial<DocumentReadOptions> = {}, pageOptions: Partial<Parameters<typeof createDocumentPagesAdapter>[0]> = {}, coverage?: DocumentCoverageReferencePort) {
  assert.equal(isolateDatabase(label, { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } }).backend, 'postgres')
  const output=resolve('artifacts/local/document-reading', `${label}-${Date.now()}`);mkdirSync(output,{recursive:true})
  const root=mkdtempSync(resolve(output,'files-')), h=await createM4Harness({label,userId:'Alex'})
  const registry=createCapabilityRegistry(createDocumentExtractionDefinitions()), ledger=createActionLedgerStore(h.db), staging=createInMemoryPayloadStaging()
  const authorizations=createTaskAuthorizationRegistry({budget:{maxActions:2,maxPlans:3,deadlineMs:90_000}})
  const snapshots=createEblRuleSnapshotPort(h.db,h.kernel.characterId,h.userId), store=createEblStore(h.db,h.kernel.characterId,createEblSourceReader(h.userId))
  const modelOptions={db:h.db,characterId:h.kernel.characterId,activeUserId:h.userId,modelVersion:'document-route@1'}
  const resolveTarget = async ({request}: {request: {arguments:Record<string,unknown>}}) => resolveLocalTarget({targetType:'local_file',rawPath:String(request.arguments.path??''),platform:process.platform==='win32'?'win32':'posix'})
  let calls=0,sequence=0
  const options: DocumentReadOptions={root,staging,pythonPath:process.env.PROJECT_LG_DOC_PYTHON,
    async resolveTarget(path){const absolutePath=await resolveSandboxPath({root},relative(root,path));return{absolutePath,resourceRef:absolutePath,sourceKind:'local-disk'}}}
  const adapter=createDocumentExtractionAdapter({...options,...adapterOptions,
    ...(coverage?{coverageReferenceFor:(rawPath:string)=>coverage.find(rawPath)}:{})})
  const profileAdapter=createDocumentProfileAdapter({...options,...profileOptions})
  const pageAdapter=createDocumentPagesAdapter({...options,...pageOptions})
  const gateway=createActionGateway({registry,ledger,grantedPermissions:['document:read'],maxRiskLevel:'R1',resolveTarget,
    attribution:{decisionPointAdapterId:'document-reading',executorAdapterId:'document-extraction'},adapters:[adapter,profileAdapter,pageAdapter].map(a=>({...a,async execute(input){calls++;return await a.execute(input)}}))})
  async function run(path:string, strategy:'current'|'static'|'model'='model', extra:{forced?:PdfReader;viaTurn?:boolean;decision?:unknown;profile?:boolean;after?:(input:{request:{capability:string;arguments:Record<string,unknown>};result:{status:string;executed?:boolean;turnContent?:readonly {text:string;scope?:{truncated?:boolean}}[]}})=>Promise<void>;planner?:(base:TaskPlannerPort)=>TaskPlannerPort}={}) {
    const text=`帮我读取「${path}」的正文`,event=(await h.recordUserEvidence(text)).event
    const configure=createDocumentRecoveryPlanning({...modelOptions,strategy,profile:extra.profile,coverage})
    const configured=await configure(text);assert.ok(configured)
    let outcome: TaskRunOutcome | undefined
    if(extra.viaTurn){
      const port=createActionTurnPort({gateway,registry,detector:{detect(){throw Error('role_only')}},attribution:{adapterId:'document-reading'},
        toolDecision:{catalog:'PDF extraction',port:{id:'fixture-role',endpointHost:'offline',async decide(){return{ok:true,requestCount:1,raw:extra.decision??{branch:'tools',goal:'read',done:false,steps:[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path,reader:'markitdown'}}]}}}}},
        task:{authorizations,planner:configured.planner,configurePlanning:configure,staging,capabilitiesFor:()=>extra.profile?[DOCUMENT_PROFILE,DOCUMENT_EXTRACT]:[DOCUMENT_EXTRACT],
          ...(extra.profile?{replanContext:{knownDirectories:()=>[],contentTokens:4000}}:{}),riskLevelFor:()=>'R1',resolveTarget,onTaskOutcome:r=>{outcome=r}}})
      await port.handleTurn({text,characterId:h.kernel.characterId,eventId:String(event.id),conversationKey:String(event.conversationId),traceId:asTraceId(`${label}-${++sequence}`),speaker:{kind:'user',id:h.userId},triggeringEvent:triggeringConversationEventOf(event)})
      return outcome
    }
    const authorization=authorizations.issue({conversationKey:String(event.conversationId),originalText:text,triggeringEventId:String(event.id),allowedCapabilities:extra.profile?[DOCUMENT_PROFILE,DOCUMENT_EXTRACT]:[DOCUMENT_EXTRACT],maxRiskLevel:'R1',
      ...(extra.forced?{budget:{maxPlans:1,maxActions:1,deadlineMs:90_000}}:extra.profile?{budget:{maxPlans:4,maxActions:3,deadlineMs:90_000}}:{})})
    const initiatorEvidence=attestActionInitiatorFromCausalOrigin({adapterId:'document-reading',causalSource:correlationSourceFromConversationEvent({adapterId:'document-reading',triggeringEvent:triggeringConversationEventOf(event)})})
    const planner:TaskPlannerPort=extra.forced?{id:'independent-reading',endpointHost:'offline',async plan(){return{ok:true,requestCount:0,plan:{goal:'independent test',done:true,steps:[{capability:DOCUMENT_EXTRACT,operation:'read',args:{path,reader:extra.forced}}]}}}}:extra.planner?extra.planner(configured.planner):configured.planner
    const native=extra.forced?createDocumentBeliefObserver(h.db,h.userId,undefined,coverage):configured.epistemic
    const result = await runTask({registry,gateway,authorizations,planner,staging,resolveTarget,ruleSnapshot:configured.ruleSnapshot,
      ...(extra.profile?{replanContext:{knownDirectories:()=>[],contentTokens:4000}}:{}),
      invocationFor:()=>({initiatorEvidence,riskBudgetOverride:'R1'}),epistemic:{before:native!.before,async after(input){await native!.after(input);await extra.after?.(input)}}},
      {text,characterId:h.kernel.characterId,traceId:asTraceId(`${label}-${++sequence}`),authorization})
    writeFileSync(resolve(output,`run-${sequence}.json`),JSON.stringify({stopped:result.stopped,steps:result.steps,
      actions:result.actionsUsed,epistemicFailures:result.epistemicFailures,results:result.results.map(r=>({status:r.result.status,error:r.result.error}))},null,2))
    return result
  }
  function file(name:string,text:string){const path=resolve(root,`${name}.pdf`);writeFileSync(path,pdfFixture(text,name));return path}
  return{root,output,h,registry,store,snapshots,modelOptions,run,file,calls:()=>calls,
    turnHarness:{gateway,authorizations,staging,resolveTarget},
    async train(){for(let i=0;i<3;i++){for(const r of ['markitdown','pdfminer'] as const){const path=file(`train-${r}-${i}`,`Independent training ${r} ${i}`);const out=await run(path,'current',{forced:r});assert.ok(out?.results[0]?.result.status==='success'&&!out.epistemicFailures)}}},
    async stop(){await h.stop();await resetPluginSqlConnection()}}
}
