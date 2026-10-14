/** Real storage and RLS matrix, always a fresh directory sandbox. No production connection. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { stringToUuid } from '@elizaos/core'
import { isolateDatabase, cleanupSandbox, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { entityRef, asCharacterId, asConversationId } from '../src/kernel/contracts/index.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createNativeMemoryStore } from '../src/infrastructure/persistence/memory-store.ts'
import { labelRecordScope } from '../src/infrastructure/persistence/record-scope-store.ts'
import { bindConversationRoom, currentReadScope, ownerRequestedScope, scopeMemoryCandidate, scopedReadDb,
  sourceRootsVisible, withReadScope, type ReadScope } from '../src/infrastructure/persistence/read-scope.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { recentConversationEvents } from '../src/infrastructure/persistence/conversation-store.ts'
import { bindTransportIdentity, ensureUserIdentity } from '../src/infrastructure/persistence/identity-store.ts'
import { decideRecordVisibility } from '../src/kernel/contracts/record-visibility.ts'
import { GroupContextBuffer, addressedByName } from '../src/infrastructure/qq/group-context.ts'
import { AutomaticMemoryConsumer } from '../src/infrastructure/runtime/automatic-memory.ts'
import { seedRelationshipOriginForNewUser } from '../src/infrastructure/runtime/adapters.ts'
import { impressionQuery } from '../src/infrastructure/runtime/impression-query.ts'
import { scopeForConversation } from '../src/infrastructure/persistence/read-scope.ts'
import { PostTurnModelMemoryConsumer } from '../src/infrastructure/runtime/post-turn-model-memory.ts'
import { ensureSemanticIndexSchema } from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { createSemanticProbe } from '../src/infrastructure/semantic/semantic-probe.ts'
import { loadEmbeddingManifest, embeddingFingerprintOf } from '../src/infrastructure/semantic/embedding-manifest.ts'
import { DEFAULT_CONTEXT_BUDGET, selectMemoryContext } from '../src/kernel/recall/selector.ts'

process.env.CHARACTER_DB_BACKEND = 'pglite'
for (const key of ['POSTGRES_URL','DATABASE_URL','LG_PG_EXPECT_DATABASE','LG_PG_EXPECT_USER','LG_PG_EXPECT_DATABASE_PREFIX','LG_PG_EXPECT_USER_PREFIX']) process.env[key] = ''
const sandbox = isolateDatabase('u1-completion')
const h = await createM4Harness({ label: 'u1-completion' })
const A = stringToUuid('u1-a'), B = stringToUuid('u1-b'), O = String(h.user.id)
const scope = (id: string, room: ReadScope['context']['room']): ReadScope => ({ ownerUserId: O, roomAuthorized: true,
  context: { principal: id === O ? { kind: 'owner', userId: id, verifiedBy: 'config_binding' }
    : { kind: 'user', userId: id, verifiedBy: 'onebot_inbound' }, purpose: 'external_query', room } })
const AP = scope(A,{kind:'private',userId:A}), BP=scope(B,{kind:'private',userId:B}), OP=scope(O,{kind:'private',userId:O})
const G = scope(A,{kind:'group',groupId:'12345678'}), H=scope(B,{kind:'group',groupId:'87654321'})
let checks = 0
const check = (label: string, run: () => void): void => { run(); checks++; console.log(`PASS ${label}`) }
try {
  const store = createNativeMemoryStore(h.db)
  const create = async (id: string, room: ReadScope['context']['room'], value: string) => {
    const conversationId = asConversationId(`u1-${id}-${room.kind === 'group' ? room.groupId : 'private'}-${stringToUuid(value)}`)
    await bindConversationRoom(h.db,{ conversationId,characterId:h.characterId,userId:id,room })
    const recorder = new ConversationRecorder({db:h.db,characterId:asCharacterId(h.characterId),conversationId,
      dryRun:false,userName:id,characterName:'苏沐薇',userId:id,attribution:[createHumanConsoleUserTurnIngress()]})
    const {event}=await recorder.recordUserMessage(`我在${value}`,1)
    assert(event)
    const subject=entityRef('user',id)
    const candidate=h.makeCandidate('person_fact',{kind:'claim',subject,predicate:'education.institution',value},
      {subjects:[subject],sourceRefs:[{kind:'conversation_event',id:String(event.id)}]})
    const record=await h.commitAndFold(candidate,Date.now())
    assert(record)
    await labelRecordScope(h.db,{recordKind:'memory',recordId:String(record.id),originRoom:room,disclosure:'private_to_origin',labeledBy:'u1-fixture'})
    return {record,event,candidate}
  }
  const a1=await create(A,AP.context.room,'测试甲大学'),a2=await create(A,AP.context.room,'测试乙大学')
  const b=await create(B,BP.context.room,'私密丙大学')
  const g=await create(B,G.context.room,'群丁大学'),other=await create(A,H.context.room,'他群戊大学')
  const ae=await withReadScope(AP,()=>store.list({owner:h.owner,limit:2}))
  check('authorization precedes LIMIT',()=>assert.equal(ae.length,2))
  const deniedPrivate = await withReadScope(AP,()=>store.get(b.record.id))
  check('other private denied by id',()=>assert.equal(deniedPrivate,null))
  const unscopedPrivate=await store.get(b.record.id)
  check('without scope negative control exposes the fixture',()=>assert(unscopedPrivate))
  const many=await withReadScope(AP,()=>store.getMany([a1.record.id,b.record.id]))
  check('batched id read preserves denied null',()=>assert.deepEqual(many.map(Boolean),[true,false]))
  check('private record not visible to its owner in group',()=>assert.equal(decideRecordVisibility({context:G.context,
    label:{originRoom:AP.context.room,disclosure:'private_to_origin'},originRoom:AP.context.room,roomAuthorized:true}).allowed,false))
  const deniedHistory = await withReadScope(AP,()=>store.history(b.record.id))
  check('history denied',()=>assert.equal(deniedHistory.length,0))
  const groupRecords=await withReadScope(G,()=>store.list({owner:h.owner,limit:50}))
  check('group only sees same-group material',()=>assert.deepEqual(groupRecords.map(record=>String(record.id)),[String(g.record.id)]))
  const groupEvents=await withReadScope(G,()=>recentConversationEvents(h.db,{characterId:asCharacterId(h.characterId),limit:50}))
  check('Recent merges room and excludes other rooms',()=>assert.deepEqual(groupEvents.map(event=>String(event.id)),[String(g.event.id)]))
  const privateRoots = await withReadScope(G,()=>sourceRootsVisible(h.db,[String(b.event.id)]))
  const groupRoots = await withReadScope(G,()=>sourceRootsVisible(h.db,[String(g.event.id)]))
  check('derived source roots are audience-filtered',()=>{assert.equal(privateRoots,false);assert.equal(groupRoots,true)})
  const ids=await Promise.all(Array.from({length:12},(_,i)=>withReadScope(i%2?BP:AP,async()=>{
    await new Promise<void>(done=>setTimeout(done,i%3)); const read=await store.get(b.record.id); return Boolean(read)
  })))
  check('mixed async contexts do not inherit identity',()=>assert.deepEqual(ids,Array.from({length:12},(_,i)=>i%2===1)))
  check('scope is absent after async calls',()=>assert.equal(currentReadScope(),undefined))
  check('identical person content in private/group has distinct id',()=>assert.notEqual(
    withReadScope(AP,()=>scopeMemoryCandidate(a1.candidate).proposedId),withReadScope(G,()=>scopeMemoryCandidate(a1.candidate).proposedId)))
  await ensureUserIdentity(h.db,B,'QQ用户22222222')
  await bindTransportIdentity(h.db,{transport:'qq',externalId:'22222222',userId:B})
  const named=await ownerRequestedScope(h.db,OP,'22222222在哪个大学？')
  assert(named.auditCaseId)
  const unnamedRead = await withReadScope(OP,()=>store.get(b.record.id))
  const namedRead = await withReadScope(named,()=>store.get(b.record.id))
  check('owner named privilege audited and not inherited',()=>{assert.equal(unnamedRead,null);assert(namedRead)})
  const groupPrivilege = await ownerRequestedScope(h.db,G,'22222222')
  check('owner privilege unavailable in groups',()=>assert.equal(groupPrivilege.auditCaseId,undefined))
  if (!h.db.transaction) throw new Error('RLS test requires transactions')
  await exec(h.db,sql.raw('create role lg_scope_fixture nologin nosuperuser nobypassrls'),'create isolated RLS fixture role')
  await exec(h.db,sql.raw('grant usage on schema public to lg_scope_fixture'),'grant fixture schema')
  await exec(h.db,sql.raw('grant select on all tables in schema public to lg_scope_fixture'),'grant fixture reads')
  const rls = async (s:ReadScope) => h.db.transaction!(async tx=>{
    await exec(tx,sql.raw('set local role lg_scope_fixture'),'isolated non-bypass role')
    return withReadScope(s,async()=>rowsOf(await scopedReadDb(tx).execute(sql`select id from memory_records order by id`)).map(row=>String(row.id)))
  })
  const rlsA=await rls(AP)
  check('RLS omitted WHERE blocks other private records',()=>assert.deepEqual(rlsA.sort(),[String(a1.record.id),String(a2.record.id)].sort()))
  const rlsGroup=await rls(G), rlsOwner=await rls(named)
  check('RLS room and audited owner privilege positive controls',()=>{assert.deepEqual(rlsGroup,[String(g.record.id)]);assert(rlsOwner.includes(String(b.record.id)))})
  const settings=await exec(h.db,sql`select current_setting('lg.scope_mode',true) as mode`,'scope cleanup readback')
  check('transaction-local settings reset',()=>assert.notEqual(settings[0]?.mode,'external_query'))
  const buffer=new GroupContextBuffer(); const now=Date.now()
  buffer.add('g',{senderId:'11111111',text:'短期语境',at:now})
  check('buffers do not cross groups or persist indefinitely',()=>{assert.equal(buffer.read('h').length,0);assert.equal(buffer.read('g',now+300001).length,0)})
  check('name address positive and third-person/quotation negative',()=>{
    assert(addressedByName('沐薇，你觉得呢？'));assert(!addressedByName('我觉得苏沐薇很聪明'));assert(!addressedByName('他说“沐薇，你觉得呢？”'))
  })
  check('bypassing eligibility cannot render unauthorized ranked material',()=>assert.throws(()=>selectMemoryContext({
    request:{scope:G.context} as never,ranked:[{candidate:{memoryId:b.record.id}}] as never,
    budget:DEFAULT_CONTEXT_BUDGET,now:Date.now()}),/候选缺少当前作用域授权/))
  await ensureSemanticIndexSchema(h.db)
  const manifest=loadEmbeddingManifest(resolve(import.meta.dirname,'../evals/m9.5/embedding-manifest.json'))
  const fingerprint=embeddingFingerprintOf(manifest), vector=[1,...Array(383).fill(0)]
  await exec(h.db,sql`insert into memory_semantic_generations (generation_id,namespace,model_fingerprint,
    renderer_version,dimension,index_schema_version,build_state,created_at)
    values ('u1-vector',${h.characterId},${fingerprint},'fixture',384,2,'published',${Date.now()})`,'vector generation fixture')
  for (const id of [b.record.id,a1.record.id]) await exec(h.db,sql`insert into memory_semantic_index
    (namespace,memory_id,source_revision,generation_id,model_fingerprint,renderer_version,content_hash,
      tokenizer_fingerprint,pooling,normalize,dtype,dimension,embedding,created_at)
    values (${h.characterId},${String(id)},0,'u1-vector',${fingerprint},'fixture','fixture','fixture','mean',true,'fp32',384,
      ${JSON.stringify(vector)}::vector,${Date.now()})`,'vector row fixture')
  const probe=createSemanticProbe({db:h.db,manifest,maxResults:1,encoder:{encode:async()=>({ok:true,vectors:[vector],dimension:384})}})
  const query={characterId:asCharacterId(h.characterId),text:'学校',memoryIds:[b.record.id,a1.record.id]}
  const scopedScores=await withReadScope(AP,()=>probe.score(query))
  check('semantic score authorization occurs before database LIMIT',()=>{
    assert(scopedScores.ok);assert.deepEqual([...scopedScores.scores.keys()],[String(a1.record.id)])
  })
  const groupScores=await withReadScope(G,()=>probe.score(query))
  check('semantic probe cannot expose private candidate scores in a group',()=>assert.deepEqual(groupScores,{ok:false,reason:'missing_score'}))
  await seedRelationshipOriginForNewUser(h.runtime,h.characterId,A)
  await seedRelationshipOriginForNewUser(h.runtime,h.characterId,B)
  const ask = () => withReadScope(AP,()=>impressionQuery(h.db,h.characterId,'对22222222的印象？'))
  const initialImpression = await ask()
  check('new user cannot use impression to obtain another private record',()=>assert(initialImpression?.includes('拒绝评价')))
  const setRelation = async (trust:number,closeness:number) => exec(h.db,sql`update character_projections
    set state=jsonb_set(jsonb_set(jsonb_set(state,'{trust}',${JSON.stringify(trust)}::jsonb),'{closeness}',${JSON.stringify(closeness)}::jsonb),'{lastInteractionAt}',${JSON.stringify(Date.now())}::jsonb)
    where character_id=${h.characterId} and projection_type=${`relationship:user:${A}`}`,'isolated threshold fixture')
  await setRelation(.4,.5);const trustBoundary=await ask()
  await setRelation(.5,.4);const closenessBoundary=await ask()
  check('impression requires BOTH dimensions strictly above .4',()=>{assert(trustBoundary?.includes('拒绝评价'));assert(closenessBoundary?.includes('拒绝评价'))})
  await setRelation(.5,.5);const impression=await ask()
  check('allowed impression provides derived relation without private text or source ids',()=>{
    assert(impression);assert(impression.includes('仅派生关系'));assert(!impression.includes('私密丙大学'));assert(!impression.includes(String(b.event.id)))
    assert(!/\d|trust|closeness|更新于|小时/.test(impression))
  })
  await assert.rejects(()=>scopeForConversation(h.db,'unknown-source',A,O),/source_room_binding_missing/)
  checks++
  const readings: {created:number;status:string}[]=[]
  const worker=new AutomaticMemoryConsumer({db:h.db,characterId:asCharacterId(h.characterId),speaker:h.user,
    ownerUserId:O,registry:h.kernel.registry,onReading:reading=>readings.push(reading),
    extractor:{name:'u1-background-fixture',version:'u1-background-fixture@1',process:async(input)=>({
      extracted:true,rejected:[],candidates:[h.makeCandidate('preference',{kind:'claim',subject:input.speaker,
        predicate:'preferred.address',value:'后台己'},{subjects:[input.speaker],sourceRefs:input.views.map(view=>({kind:'conversation_event',id:String(view.id)}))})]
    })}})
  try {
    await worker.open();await worker.drain()
    for (const room of [BP.context.room,H.context.room]) {
      const conversationId=asConversationId(`background-${stringToUuid(JSON.stringify(room))}`)
      await bindConversationRoom(h.db,{conversationId,characterId:h.characterId,userId:B,room})
      const recorder=new ConversationRecorder({db:h.db,characterId:asCharacterId(h.characterId),conversationId,
        dryRun:false,userName:'background-B',characterName:'苏沐薇',userId:B,attribution:[createHumanConsoleUserTurnIngress()]})
      await recorder.recordUserMessage('叫我后台己',1)
    }
    await withReadScope(AP,()=>worker.drain()) // the triggering caller is A; actual sources belong to B.
    const background=await exec(h.db,sql`select m.id,m.content,l.origin_room_kind,l.origin_room_id from memory_records m
      join record_scope_labels l on l.record_id=m.id where m.content->>'value'='后台己'`,'background source readback')
    check('shared automatic worker uses source actor/room instead of triggering user',()=>{
      assert.equal(background.length,2);assert.equal(new Set(background.map(row=>String(row.id))).size,2)
      assert(background.every(row=>JSON.stringify(row.content).includes(B)))
      assert.deepEqual(background.map(row=>`${row.origin_room_kind}:${row.origin_room_id}`).sort(),[`group:87654321`,`private:${B}`].sort())
      assert.equal(readings.reduce((sum,row)=>sum+row.created,0),2)
    })
  } finally { await worker.close() }
  const modelPrompts:string[]=[]
  const modelWorker=new PostTurnModelMemoryConsumer({db:h.db,characterId:asCharacterId(h.characterId),speaker:h.user,
    ownerUserId:O,registry:h.kernel.registry,onReading:()=>{},invoke:async prompt=>{
      modelPrompts.push(prompt)
      return JSON.stringify({destination:'long_term',decisions:[{operation:'create',quote:'今天完成后台模型专用标记',explicit:false,
        memory:{type:'episode',summary:'今天完成后台模型专用标记',importance:.5,confidence:.9}}]})
    }})
  try {
    await modelWorker.open();await modelWorker.drain()
    for(const room of [BP.context.room,H.context.room]) {
      const conversationId=asConversationId(`model-background-${stringToUuid(JSON.stringify(room))}`)
      await bindConversationRoom(h.db,{conversationId,characterId:h.characterId,userId:B,room})
      const recorder=new ConversationRecorder({db:h.db,characterId:asCharacterId(h.characterId),conversationId,
        dryRun:false,userName:'model-B',characterName:'苏沐薇',userId:B,attribution:[createHumanConsoleUserTurnIngress()]})
      const {event,assistantSequence}=await recorder.recordUserMessage('今天完成后台模型专用标记',1)
      assert(event)
      assert(assistantSequence)
      await recorder.recordAssistantMessage({text:'收到。',conversationSequence:2,characterSequence:assistantSequence,
        replyToEventId:event.id})
    }
    await withReadScope(AP,()=>modelWorker.drain())
    const models=await exec(h.db,sql`select m.content,l.origin_room_kind,l.origin_room_id from memory_records m
      join record_scope_labels l on l.record_id=m.id where m.content->>'summary'='今天完成后台模型专用标记'`,'model background readback')
    check('post-turn model extraction reads/writes with actual source actor and room',()=>{
      assert.equal(models.length,2);assert(models.every(row=>JSON.stringify(row.content).includes(B)))
      assert.deepEqual(models.map(row=>`${row.origin_room_kind}:${row.origin_room_id}`).sort(),[`group:87654321`,`private:${B}`].sort())
      assert.equal(modelPrompts.length,2);assert(modelPrompts[0]?.includes('私密丙大学'));assert(!modelPrompts[1]?.includes('私密丙大学'))
    })
  } finally {await modelWorker.close()}
  const out=resolve(import.meta.dirname,'../artifacts/post-lv2',`u1-completion-${Date.now()}`)
  mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'result.json'),JSON.stringify({status:'PASS',checks,
    scope:'isolated storage + non-bypass RLS role + room/identity matrix',productionDatabaseOpened:false,realQq:'NOT RUN',externalModel:'NOT RUN'},null,2))
  console.log(`PASS U1 completion ${checks} checks; ${out}`)
} finally { await h.stop();await resetPluginSqlConnection();cleanupSandbox(sandbox.dir) }
