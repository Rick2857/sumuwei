import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFilePlanningBed, scoreFileTask } from './file-planning-bed.ts'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { createEvaluationRecorder, evaluationDigest, type EvaluationRow } from './evaluation-recording.ts'
import { createSimulationTaskPlanner, type SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import type { TaskPlan } from '../../src/kernel/action/task-plan.ts'
import type { TaskRunOutcome, EblTaskObserver } from '../../src/kernel/action/task-loop.ts'
import { contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { createDocumentRecoveryPlanning } from '../../src/infrastructure/runtime/document-recovery-planning.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { TurnGateway } from '../../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../../src/kernel/recall/selector.ts'
import { DOCUMENT_PAGES } from '../../src/kernel/contracts/document-pages.ts'
import { DOCUMENT_PROFILE } from '../../src/kernel/contracts/document-profile.ts'
import { setPgTestEnvironment } from '../postgresql/test-harness.ts'

const controls=['equivalent','first-correct','permuted','condition','no-rule','recovery']
const cases=[...controls.flatMap(c=>[`${c}-0`,`${c}-1`]),'page-visible','page-zero','page-cut','page-before-compile','writer-fault','export-guard']
if(process.argv.includes('--list-cases')){console.log(cases.map(c=>`${c}\t1`).join('\n'));process.exit(0)}
const selected=process.argv[process.argv.indexOf('--case')+1];assert.ok(cases.includes(selected))
const arm=process.argv.includes('--arm')?process.argv[process.argv.indexOf('--arm')+1]:undefined
const runId=process.env.EVALUATION_RUN_ID??`recording-${selected}-${Date.now()}`
const output=resolve('artifacts/local/evaluation-recording',selected);mkdirSync(output,{recursive:true})
if(!arm){
  const reports=[]
  for(const mode of ['off','on']){
    const target=mode==='on'?process.env.LG_TEST_PG_URL_ALT_1:process.env.LG_TEST_PG_URL;assert.ok(target)
    const child=spawnSync(process.execPath,['--import','./node_modules/tsx/dist/loader.mjs',import.meta.filename,'--case',selected,'--arm',mode],
      {env:{...process.env,LG_TEST_PG_URL:target,EVALUATION_RUN_ID:runId},encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024})
    writeFileSync(resolve(output,`${mode}.log`),child.stdout+child.stderr)
    assert.equal(child.status,0,`worker ${mode}: ${child.stderr.slice(-1600)}`)
    reports.push(JSON.parse(readFileSync(resolve(output,`${mode}.json`),'utf8')))
  }
  assert.deepEqual(reports[0].parity,reports[1].parity,'recording must not change actions, goals or EBL transitions')
  assert.equal(reports[1].failures,selected==='writer-fault'?reports[1].attempts:0)
  assert.ok(selected==='writer-fault'||reports[1].rows.length>0)
  writeFileSync(resolve(output,'verification.json'),JSON.stringify({status:'PASS',runId,selected,parity:true,
    statusOfMeasurement:selected==='writer-fault'?'INVALID_MEASUREMENT':'COMPLETE',checks:reports[1].checks,
    assertionCount:reports[1].checks.length+3,modelCalls:0,productionOpened:false,execution:'serversim/simhost',
    database:'two separate caller-prepared pgtest databases, one per mode'},null,2))
  console.log(`PASS ${selected}: parity + ${reports[1].checks.length} checks`);process.exit(0)
}
const enabled=arm==='on',rows:EvaluationRow[]=[],checks:string[]=[]
setPgTestEnvironment(process.env.LG_TEST_PG_URL!,{allowedHosts:['pgtest'],productionTarget:process.env.LG_SIM_PRODUCTION_POSTGRES_URL})
let attempts=0
const recorder=createEvaluationRecorder({runId,worldId:selected,episodeId:'episode',arm:'C'},row=>{
  attempts++;if(selected==='writer-fault')throw Error('owned output fault');rows.push(row)
})
const check=(name:string,condition:unknown)=>{assert.ok(condition,name);checks.push(name)}
const eventMeaning=(all:EvaluationRow[])=>all.filter(r=>r.kind==='ebl-event').map(r=>({command:r.command,nextStatus:r.nextStatus,
  verdict:r.verdict,independent:r.independent,forecast:(r.model as {forecastVerdict?:string}|null)?.forecastVerdict??null}))
const report=(parity:unknown)=>{
  const text=JSON.stringify(rows)
  check('no source body, paths, prompt or arbitrary error text enters telemetry',!text.includes('fixture_body')&&!text.includes('fixture_path')&&!text.includes('owned output fault'))
  writeFileSync(resolve(output,`${arm}.json`),JSON.stringify({parity,rows,checks,failures:recorder.failures,attempts,modelCalls:0},null,2))
  if(enabled)writeFileSync(resolve(output,'records.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n')
}
if(selected.startsWith('page-')){
  const bed=await createDocumentReadingBed(`recording-${selected}`)
  try{
    const path=bed.file('fixture_path','fixture_body'),text=`读取「${path}」第 1 页的正文`
    const configure=createDocumentRecoveryPlanning({...bed.modelOptions,profile:true})
    const {gateway,authorizations,staging,resolveTarget}=bed.turnHarness
    let outcome:TaskRunOutcome|undefined
    const port=createActionTurnPort({gateway,registry:bed.registry,detector:{detect(){throw Error('role only')}},attribution:{adapterId:'document-reading'},
      toolDecision:{catalog:'PDF pages',port:{id:'offline',endpointHost:'offline',async decide(){return{ok:true,requestCount:0,raw:{branch:'tools',goal:'bounded page',done:false,
        steps:[{capability:DOCUMENT_PAGES,operation:'read',args:{path,firstPage:1,lastPage:1}}]}}}}},
      task:{authorizations,planner:(await configure(text))!.planner,async configurePlanning(input){
        const c=await configure(input);assert.ok(c)
        return{...c,planner:{...c.planner,async plan(p){const result=await c.planner.plan(p);if(enabled&&result.ok)recorder.begin([result.plan],null);return result}},
          epistemic:{async before(p){if(enabled)recorder.beforeAction(p.request);return c.epistemic!.before(p)},after:c.epistemic!.after}}
      },staging,resolveTarget,capabilitiesFor:()=>[DOCUMENT_PROFILE,DOCUMENT_PAGES],riskLevelFor:()=>'R1',
      replanContext:{knownDirectories:()=>[],contentTokens:4000},onTaskOutcome:o=>{outcome=o;if(enabled)recorder.outcome(o)}}})
    const turnGateway=new TurnGateway({kernel:bed.h.kernel,definition:bed.h.kernel.definition,identity:bed.h.kernel.identitySnapshot,
      recorder:bed.h.recorder,conversationSequence:bed.h.nextTurnSequence,slowPathEnabled:false,userId:bed.h.userId,actionEnabled:true,actionWriter:port,
      recallBudget:{...DEFAULT_CONTEXT_BUDGET,turnContentTokens:selected==='page-zero'?0:4000},...(selected==='page-cut'?{tokenBudget:1}:{})})
    const turn=await turnGateway.beginTurn(text)
    if(enabled&&selected==='page-before-compile'){
      recorder.final(turn)
      check('default delivered false before compilation is recorded as missing',
        (rows.find(r=>r.kind==='final')!.goals as {delivered:unknown}[])[0]?.delivered==='MISSING')
    }
    const packet=await turnGateway.compileTurn({turn,currentInput:text,recentLines:[]})
    if(enabled)recorder.final(turn)
    const goal=turn.actionResults![0]!.task!.goal!
    check('native page observer has zero hidden failures',outcome?.epistemicFailures===0)
    check('actual page retrieval is distinct from final delivery',goal.achieved&&goal.delivered===(selected==='page-visible'||selected==='page-before-compile'))
    check('packet body matches actual final delivery',packet.text.includes('fixture_body')===goal.delivered)
    if(enabled){
      const final=rows.filter(r=>r.kind==='final').at(-1)!
      check('final artifact preserves actual configured and delivered values',final.goalConfigured===true&&(final.goals as {delivered:boolean}[])[0]!.delivered===goal.delivered)
      const result=rows.find(r=>r.kind==='outcome')!
      const ids=(result.actions as {contents:{contentId:string}[]}[]).flatMap(a=>a.contents.map(c=>c.contentId))
      check('final IDs link to actual action content IDs',(final.contentIds as string[]).every(id=>ids.includes(id)))
    }
    await turnGateway.completeTurn({turn,replyText:'隔离校准占位回复。'})
    report({actions:outcome!.results.map(r=>({capability:r.request.capability,status:r.result.status})),goal:{achieved:goal.achieved,delivered:goal.delivered},observerFailures:outcome!.epistemicFailures})
  }finally{await bed.stop()}
}else{
  const bed=await createFilePlanningBed(`recording-${selected}`)
  try{
    const control=selected.replace(/-[01]$/,''),variant=selected.endsWith('-1')
    const {h}=bed.turnHarness,path=`fixture_path_${variant?1:0}.txt`,content='fixture_body',goal={path,expectedFingerprint:contentFingerprint(content)}
    const plan=(value:string):TaskPlan=>({goal:'untrusted model wording',done:true,steps:[
      {capability:'sandbox.file.write',operation:'write',args:{path,content:value}},
      {capability:'sandbox.file.read',operation:'read',args:{path}}]})
    if(control==='no-rule'){
      if(variant)await bed.store.commit(bed.rule.claimId,{kind:'withdraw'})
      else await bed.run({id:'actual-counterexample',endpointHost:'offline',async plan(){return{ok:true,requestCount:0,plan:plan(content)}}},
        {observe:true,after:async p=>{if(p.request.capability==='sandbox.file.write')writeFileSync(resolve(bed.root,path),'actual differing bytes')}})
    }
    let candidates=control==='equivalent'?[plan(content),{...plan(content),goal:'different explanation'}]
      :control==='first-correct'?[plan(content),plan('wrong')]:variant?[plan('wrong'),plan(content)]:[plan('wrong'),plan('also wrong'),plan(content)]
    let chosen:number|undefined,reason:string|undefined
    const makePlanner=()=>createSimulationTaskPlanner({...bed.modelOptions,registry:bed.registry,goal,
      ...(control==='condition'?{facts:variant?{encoding:'latin1'}:{}}:{}),
      candidateSource:{id:'offline-scripted',endpointHost:'offline',async propose(){if(enabled)recorder.begin(candidates,{policy:'first-candidate',index:0});return{candidates,requestCount:1}}},
      ...(enabled?{onSelection:(s:SimulationPlanSelection)=>{
        chosen=s.selectedIndex;reason=s.reason;recorder.selection(s)}}:{})})
    const outcome=await bed.run(makePlanner(),{observe:true,maxActions:3,
      ...(enabled?{before:async p=>{recorder.beforeAction(p.request)}}:{}),
      ...(control==='recovery'?{after:async(p:Parameters<EblTaskObserver['after']>[0])=>{
        if(p.request.capability==='sandbox.file.write')writeFileSync(resolve(bed.root,path),'controlled real drift')}}:{})})
    if(enabled)recorder.outcome(outcome,scoreFileTask(outcome,{root:bed.root,path,content}))
    check('native lifecycle observer has zero hidden failures',outcome.epistemicFailures===0)
    let recovered:TaskRunOutcome|undefined
    if(control==='recovery'){
      recovered=await bed.run({id:'recovery-without-stale-rule',endpointHost:'offline',async plan(){
        if(enabled)recorder.begin([plan(content)],{policy:'first-candidate',index:0});return{ok:true,requestCount:0,plan:plan(content)}}},
        {observe:true,maxActions:3,...(enabled?{before:async p=>{recorder.beforeAction(p.request)}}:{})})
      check('native recovery observer has zero hidden failures',recovered.epistemicFailures===0)
      if(enabled)recorder.outcome(recovered,scoreFileTask(recovered,{root:bed.root,path,content}))
      check('later independent goal recovers without deleting earlier mismatch',outcome.comparisons?.some(c=>c.verdict==='mismatch')&&scoreFileTask(recovered,{root:bed.root,path,content}).achieved)
      check('the real counterexample remains suspended',(await bed.store.get(bed.rule.claimId))?.status==='suspended')
    }
    if(enabled&&selected!=='writer-fault'){
      const choice=rows.find(r=>r.kind==='selection')!
      check('selection and actual eligibility are exported',choice.eligibilityStatus==='OBSERVED')
      if(control==='condition')check('unknown and mismatched conditions have distinct recorded reasons',
        (choice.skippedRules as {reason:string}[]).some(r=>r.reason===(variant?'condition_mismatch':'condition_unknown')))
      else if(control==='no-rule')check('unqualified rules are skipped rather than used',reason==='no_rule'&&(choice.eligibleRules as unknown[]).length===0)
      else check('actual native selection is measured',chosen===(control==='equivalent'||control==='first-correct'?0:variant?1:2))
      if(control==='equivalent')check('goal wording does not invent candidate diversity',rows.find(r=>r.kind==='decision')!.distinctActionSequences===1)
      check('unconfigured trusted goal is explicit, not false',rows.find(r=>r.kind==='outcome')!.retrieved==='NOT_CONFIGURED')
    }
    if(selected==='export-guard'){
      const saved=process.env.LG_TEST_PG_URL;process.env.LG_TEST_PG_URL='postgresql://invalid@pg/sumuwei'
      try{await assert.rejects(recorder.events(h.db,h.kernel.characterId),/requires_isolated_pgtest/)}finally{process.env.LG_TEST_PG_URL=saved}
      check('export rejects production-shaped target before event read',true)
    }
    const countBefore=await bed.counts()
    const eventRecorder=enabled?recorder:createEvaluationRecorder({runId:'parity',worldId:selected,episodeId:'episode',arm:'C'},r=>rows.push(r))
    await eventRecorder.events(h.db,h.kernel.characterId)
    check('event export adds no action or evidence',JSON.stringify(await bed.counts())===JSON.stringify(countBefore))
    if(selected!=='writer-fault'){
      check('D3 includes lifecycle transitions from the isolated scenario',rows.some(r=>r.kind==='ebl-event'&&r.command==='review'))
      if(enabled&&outcome.results.length)check('D3 links scenario actions to decisions',rows.some(r=>r.kind==='ebl-event'&&(r.actions as {decisionId:string|null}[]).some(a=>a.decisionId!==null)))
      if(enabled&&control==='recovery')check('export preserves the counterexample after recovery',rows.some(r=>r.kind==='ebl-event'&&r.verdict==='counterexample'&&r.nextStatus==='suspended'))
    }
    // A second bounded read supplies parity data even when the owned writer-fault sink rejects every row.
    const parityEvents:EvaluationRow[]=[]
    await createEvaluationRecorder({runId:'parity',worldId:selected,episodeId:'episode',arm:'C'},r=>parityEvents.push(r)).events(h.db,h.kernel.characterId)
    report({totalAdapterCallsIncludingSetup:countBefore.adapterCalls,actions:[outcome,...(recovered?[recovered]:[])].map(o=>({stopped:o.stopped,steps:o.results.map(r=>({capability:r.request.capability,status:r.result.status,
      effect:r.result.effect?.fingerprint??null})),comparisons:o.comparisons?.map(c=>c.verdict)??[],observerFailures:o.epistemicFailures})),
      score:scoreFileTask(recovered??outcome,{root:bed.root,path,content}),events:eventMeaning(parityEvents)})
  }finally{await bed.stop()}
}
