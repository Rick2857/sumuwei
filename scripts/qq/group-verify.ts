/** Real OneBot socket → real bridge/main.ts → isolated database. Artificial accounts only. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'
import { LgStdioClient } from '../../src/infrastructure/qq/lg-stdio-client.ts'
import { isolateDatabase, cleanupSandbox, PRODUCTION_DB_DIR } from '../../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../../src/infrastructure/persistence/production-db-safety.ts'

process.env.CHARACTER_DB_BACKEND='pglite'
process.env.POSTGRES_URL='';process.env.DATABASE_URL=''
const root=resolve(import.meta.dirname,'../..'), before=digestTree(PRODUCTION_DB_DIR).treeSha256
const {WebSocketServer}=createRequire(import.meta.resolve('jsdom'))('ws')
const server=new WebSocketServer({host:'127.0.0.1',port:0})
await new Promise<void>(done=>server.once('listening',done))
const O='33333333', A='11111111', B='22222222', G='12345678', H='87654321', bot='99999999'
const env={QQ_OWNER_ID:O,QQ_BOT_ID:bot,QQ_ONEBOT_WS_URL:`ws://127.0.0.1:${server.address().port}/`,
  QQ_ONEBOT_ACCESS_TOKEN:'offline-group-fixture-token-12345',QQ_MULTI_USER_ENABLED:'true',QQ_ALLOWED_GROUP_IDS:`${G},${H}`}
const settings=readQqPrivateConfig(env)
const members=new Map([[G,new Set([O,A,B,bot])],[H,new Set([O,A,B,bot])]])
const sent: {action:string;params:Record<string,any>}[]=[]
let socket:any
let clearGroupOnMembership=false
server.on('connection',(connection:any)=>{
  socket??=connection
  connection.on('message',(raw:Buffer)=>{
    const request=JSON.parse(raw.toString()), p=request.params
    let data:Record<string,unknown>={};let ok=true
    if(request.action==='get_login_info')data={user_id:bot}
    else if(request.action==='get_group_member_info'){
      if(clearGroupOnMembership){
        clearGroupOnMembership=false;members.get(G)!.delete(B)
        socket.send(JSON.stringify({post_type:'notice',notice_type:'group_decrease',self_id:bot,group_id:G,user_id:B}))
      }
      ok=members.get(String(p.group_id))?.has(String(p.user_id))===true
      data={group_id:p.group_id,user_id:p.user_id}
    }else if(['send_private_msg','send_group_msg'].includes(request.action)){
      sent.push({action:request.action,params:p});data={message_id:sent.length}
    }else throw new Error(`unexpected fixture action ${request.action}`)
    connection.send(JSON.stringify({status:ok?'ok':'failed',retcode:ok?0:1,data,echo:request.echo}))
  })
})
const prompts:string[]=[]
let revokeOnModel:string|undefined
const model=createServer(async(request,response)=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) {
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({data:[{id:'offline-fixture',object:'model'}]}));return
  }
  const body=JSON.parse(Buffer.concat(chunks).toString()), prompt=JSON.stringify(body.messages)
  prompts.push(prompt)
  if(revokeOnModel){members.get(G)!.delete(revokeOnModel);members.get(H)!.delete(revokeOnModel);revokeOnModel=undefined}
  response.writeHead(200,{'content-type':'application/json'})
  response.end(JSON.stringify({choices:[{message:{content:'<response><text>收到。</text></response>'}}]}))
})
await new Promise<void>(done=>model.listen(0,'127.0.0.1',done))
const features=Object.fromEntries([...readFileSync(resolve(root,'src/kernel/app/flags.ts'),'utf8').matchAll(/\b(CHARACTER_[A-Z0-9_]*ENABLED)\b/g)].map(match=>[match[1]!,'false']))
const sandbox=isolateDatabase('qq-group-verify').dir
const coreEnv={...process.env,...features,...env,
  CHARACTER_DB_BACKEND:'pglite',POSTGRES_URL:'',DATABASE_URL:'',PGLITE_DATA_DIR:sandbox,PROJECT_LG_SANDBOX:sandbox,
  LG_PG_EXPECT_DATABASE:'',LG_PG_EXPECT_USER:'',LG_PG_EXPECT_DATABASE_PREFIX:'',LG_PG_EXPECT_USER_PREFIX:'',
  USER_NAME:'qq-group-fixture-owner',OPENAI_API_KEY:'offline-local-fixture',OPENAI_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,
  OPENAI_LARGE_MODEL:'offline-fixture',OPENAI_SMALL_MODEL:'offline-fixture',LOG_LEVEL:'fatal',
  CHARACTER_KERNEL_ENABLED:'true',CHARACTER_CONTEXT_COMPILER_V1:'true',CHARACTER_MEMORY_ENABLED:'true',
  CHARACTER_MEMORY_EXPLICIT_ENABLED:'true',CHARACTER_RECALL_ENABLED:'true',
  CHARACTER_RELATIONSHIP_CONTEXT_ENABLED:'true',CHARACTER_AFFECT_CONTEXT_ENABLED:'true',
  CHARACTER_AFFECT_SEMANTIC_MODE:'rules',CHARACTER_MEMORY_SEMANTIC_MODE:'off',CHARACTER_MEMORY_RECALL_MODE:'lexical',CHARACTER_TOOL_DECISION_MODE:'rules',
  CHARACTER_QQ_PROACTIVE_MODE:'off',CHARACTER_EXPRESSIVE_SPEECH:'false',CHARACTER_ROLLUP_TOKENS:'100',
}
const coexist=process.argv.includes('--coexist')
const host=coexist ? await (await import('../coexist/harness.ts')).startCoexistHost({dbDir:sandbox,
  modelPort:(model.address() as any).port,userName:'qq-group-fixture-owner',
  env:Object.fromEntries(Object.entries(coreEnv).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))}) : undefined
if(host) await host.ready
const lg=new LgStdioClient(root,coreEnv,host?{connect:{host:'127.0.0.1',port:host.qqPort,token:host.qqToken}}:{})
const logs:{event:string;requestId?:string}[]=[]
const client=new OneBotPrivateClient(settings,request=>lg.submit(request),reading=>logs.push(reading))
let id=0, checks=0
const waitFor=async(test:()=>boolean)=>{for(let i=0;i<1000;i++){if(test())return;await delay(10)}throw new Error('group fixture timeout')}
const emit=(user:string,text:string,group?:string,extra:Record<string,unknown>={})=>{
  id++;socket.send(JSON.stringify({post_type:'message',message_type:group?'group':'private',sub_type:group?'normal':'friend',
    self_id:bot,user_id:user,sender:{user_id:user},message_id:id,...(group?{group_id:group}:{}),
    message:[...(group?[{type:'at',data:{qq:bot}}]:[]),{type:'text',data:{text}}],...extra}));return id
}
const formal=async(user:string,text:string,group?:string,extra:Record<string,unknown>={})=>{
  const n=sent.length;emit(user,text,group,extra);await waitFor(()=>sent.length>n);await client.drain()
  assert.equal(sent.at(-1)!.action,group?'send_group_msg':'send_private_msg')
  assert.equal(String(sent.at(-1)!.params[group?'group_id':'user_id']),group??user)
  assert(!sent.at(-1)!.params.message[0].data.text.includes('这轮连接失败'))
  checks++
}
try{
  await lg.ready;await client.connect()
  const startupCalls=prompts.length
  emit(A,'旁听缓冲唯一标记',G,{message:[{type:'text',data:{text:'旁听缓冲唯一标记'}}]})
  await delay(100);assert.equal(prompts.length,startupCalls);checks++
  await formal(A,'记住：我在群一甲大学',G)
  assert(prompts.at(-1)!.includes('旁听缓冲唯一标记'));checks++
  const duplicate=id;const count=sent.length
  emit(A,'重复消息',G,{message_id:duplicate});await delay(100);assert.equal(sent.length,count);checks++
  await formal(B,'记住：我在私聊乙大学',undefined,{sub_type:'group'})
  assert(!prompts.at(-1)!.includes('群一甲大学'));checks++
  await formal(A,'谢谢你',H)
  assert(!prompts.at(-1)!.includes('群一甲大学'));assert(!prompts.at(-1)!.includes('私聊乙大学'));checks++
  await formal(B,'沐薇，你觉得呢？',G,{message:[{type:'text',data:{text:'沐薇，你觉得呢？'}}]})
  assert(!prompts.at(-1)!.includes('私聊乙大学'));checks++
  await formal(A,'记住：我在私聊甲大学')
  assert(!prompts.at(-1)!.includes('群一甲大学'));checks++
  await formal(O,`${B}在什么大学？`,G)
  assert(!prompts.at(-1)!.includes('私聊乙大学'));assert(!prompts.at(-1)!.includes('私聊甲大学'));checks++
  await formal(O,`${B} education.institution 的记录是什么？`)
  assert(prompts.at(-1)!.includes('私聊乙大学'));checks++
  await formal(O,'请继续',G,{message:[{type:'reply',data:{id:6}},{type:'text',data:{text:'请继续'}}]})
  assert(!prompts.at(-1)!.includes('私聊乙大学'));checks++
  emit(A,'退群清缓冲唯一标记',G,{message:[{type:'text',data:{text:'退群清缓冲唯一标记'}}]})
  clearGroupOnMembership=true
  await formal(O,'缓冲失效检查',G)
  assert(!prompts.at(-1)!.includes('退群清缓冲唯一标记'));checks++
  const beforeRejected=prompts.length
  emit('44444444','陌生人');emit(A,'越权群','55555555');emit(A,'发言者不一致',G,{sender:{user_id:B}})
  emit(O,'伪造引用回复',H,{message:[{type:'reply',data:{id:6}},{type:'text',data:{text:'请继续'}}]})
  await delay(150);await client.drain();assert.equal(prompts.length,beforeRejected);checks++
  await delay(3100)
  revokeOnModel=B
  const beforeSend=sent.length;emit(B,'发送前撤销验证')
  await waitFor(()=>prompts.length>beforeRejected);await client.drain();assert.equal(sent.length,beforeSend);checks++
  const beforeRevoke=prompts.length;emit(B,'撤销后再次私聊')
  await delay(100);await client.drain();assert.equal(prompts.length,beforeRevoke);checks++
  if(host) {
    const avatar=new LgStdioClient(root,coreEnv,{connect:{host:'127.0.0.1',port:host.avatarPort,token:host.avatarToken}})
    try {
      await avatar.ready
      const response=await avatar.submit({requestId:'avatar-owner-scope',userText:'education.institution 的记录是什么？'})
      assert.equal(response.outcome,'replied');assert(!prompts.at(-1)?.includes('私聊乙大学'));checks++
      const named=await avatar.submit({requestId:'avatar-owner-named',userText:`${B} education.institution 的记录是什么？`})
      assert.equal(named.outcome,'replied');assert(prompts.at(-1)?.includes('私聊乙大学'));checks++
    } finally {await avatar.close()}
  }
  await client.close();assert.equal(await lg.close(),0)
  if(host) assert.equal(await host.stop(),0)
  const db=await openRawPGlite(sandbox)
  try{
    const mappings=(await db.query("select external_id,user_id from user_identity_mappings where transport='qq'")).rows as Record<string,any>[]
    assert.equal(mappings.length,3);assert.equal(new Set(mappings.map(row=>row.user_id)).size,3);checks++
    const records=(await db.query('select m.id,m.content,l.origin_room_kind,l.origin_room_id from memory_records m left join record_scope_labels l on l.record_id=m.id')).rows as Record<string,any>[]
    assert.equal(records.length,3);assert(records.every(row=>row.origin_room_id));assert(!JSON.stringify(records).includes('旁听缓冲唯一标记'));checks++
    const relations=(await db.query("select projection_type,state from character_projections where projection_type like 'relationship:user:%'")).rows as Record<string,any>[]
    assert.equal(relations.length,3);assert(relations.filter(row=>row.state.originKind==='NEW_USER_BASELINE').length===2);checks++
    const affect=(await db.query("select projection_type from character_projections where projection_type='affect:character'")).rows
    assert.equal(affect.length,1);checks++
    const events=(await db.query("select actor_id,content_originator_id from conversation_events where actor_type='user'")).rows as Record<string,any>[]
    assert(events.every(row=>row.actor_id===row.content_originator_id));checks++
    const audits=(await db.query('select count(*)::int as count from scope_read_audit')).rows as {count:number}[]
    assert(audits[0]!.count>0);checks++
  }finally{await db.close()}
  assert.equal(digestTree(PRODUCTION_DB_DIR).treeSha256,before);checks++
  const out=resolve(root,'artifacts/post-lv2',`qq-group-verify-${Date.now()}`);mkdirSync(out,{recursive:true})
  writeFileSync(resolve(out,'result.json'),JSON.stringify({status:'PASS',checks,transport:coexist?'coexist-tcp':'stdio',scope:'real OneBot fixture + real main.ts + isolated DB',
    productionDatabaseOpened:false,productionTreeUnchanged:true,realQq:'NOT RUN',externalModel:'NOT RUN'},null,2))
  console.log(`PASS QQ group end-to-end ${checks} checks; ${out}`)
}catch(error){
  await client.close();await lg.close();if(host) await host.stop()
  const db=await openRawPGlite(sandbox)
  try {
    const records=(await db.query('select id,content,status from memory_records')).rows
    const traces=(await db.query('select selected_memory_ids,steps from character_traces order by started_at desc limit 2')).rows as Record<string,any>[]
    const out=resolve(root,'artifacts/post-lv2/local',`qq-group-fail-${Date.now()}`);mkdirSync(out,{recursive:true})
    writeFileSync(resolve(out,'result.json'),JSON.stringify({status:'FAIL',reason:String(error),records,traces},null,2))
    console.log(JSON.stringify({recordCount:records.length,records,traces:traces.map(t=>({selected:t.selected_memory_ids,
      steps:t.steps.filter((s:any)=>/memory|recall/.test(s.kind))}))}))
  }finally{await db.close()}
  throw error
}finally{
  await client.close();await lg.close();model.closeAllConnections();await new Promise<void>(done=>model.close(()=>done()))
  if(host && host.child.exitCode===null) await host.stop()
  for(const connection of server.clients)connection.terminate();await new Promise<void>(done=>server.close(()=>done()))
  cleanupSandbox(sandbox)
}
