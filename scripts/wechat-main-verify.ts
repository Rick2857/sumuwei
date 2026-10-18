/** Real shared LG core, isolated DB, synthetic WeChat API/model. No production or real sends. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LgStdioClient } from '../src/infrastructure/qq/lg-stdio-client.ts'
import { WechatGroupClient, type WechatMessage, type WechatConfig } from '../src/infrastructure/wechat/group-client.ts'
import { isolateDatabase, cleanupSandbox, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
process.env.CHARACTER_DB_BACKEND='pglite';process.env.POSTGRES_URL='';process.env.DATABASE_URL=''
const root=resolve(import.meta.dirname,'..'), before=digestTree(PRODUCTION_DB_DIR).treeSha256
const sandbox=isolateDatabase('wechat-main-verify').dir
const G='111@chatroom',H='222@chatroom',owner='wxid_owner',A='wxid_alice',B='wxid_bob',bot='wxid_bot'
const messages=new Map<string,WechatMessage[]>([[G,[]],[H,[]]])
let id=0,sends=0,assessments=0,authReads=0,account=bot
const prompts:string[]=[]
const model=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk
  const body=text?JSON.parse(text):{};if(body.messages)prompts.push(JSON.stringify(body.messages))
  const assessment=body.messages?.[0]?.content?.includes('判断此刻是否愿意接话')
  if(assessment)assessments++
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body.messages?
    {choices:[{message:{content:assessment?JSON.stringify({reply:!JSON.parse(body.messages.at(-1).content).current.text.includes('保持安静的测试消息')}):'<response><text>收到。</text></response>'}}]}:{data:[{id:'offline-fixture'}]}))
})
const token='synthetic-main-wechat-token-12345678'
const executorSockets=new Set<Socket>()
let executorConnections=0
const executor=createTcpServer(socket=>{
  executorConnections++;executorSockets.add(socket);socket.on('close',()=>executorSockets.delete(socket))
  socket.once('data',()=>socket.write('LG_ENTRY_READY v1\n'))
})
await new Promise<void>(done=>executor.listen(0,'127.0.0.1',done))
const api=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end('{}');return}
  const path=decodeURIComponent(new URL(req.url!,'http://127.0.0.1').pathname)
  let result:unknown
  if(path==='/api/status/auth'){authReads++;result={status:'logged_in',loggedInUser:account+'_1234'}}
  else if(path.startsWith('/api/chats/'))result={id:path.split('/').at(-1),isGroup:true}
  else if(path==='/api/messages/send'){let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);assert([G,H].includes(body.chatId));assert.equal(body.text,'收到。');sends++;result={success:true}}
  else result=messages.get(path.split('/').at(-1)!)??[]
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result))
})
await Promise.all([new Promise<void>(done=>model.listen(0,'127.0.0.1',done)),new Promise<void>(done=>api.listen(0,'127.0.0.1',done))])
const port=(s:typeof api)=>(s.address() as {port:number}).port
const config:WechatConfig={baseUrl:`http://127.0.0.1:${port(api)}`,token,botId:bot,ownerId:owner,groupIds:[G,H],stateFile:resolve(sandbox,'wechat-seen.json')}
const features=Object.fromEntries([...readFileSync(resolve(root,'src/kernel/app/flags.ts'),'utf8').matchAll(/\b(CHARACTER_[A-Z0-9_]*ENABLED)\b/g)].map(m=>[m[1]!,'false']))
const env={...process.env,...features,CHARACTER_DB_BACKEND:'pglite',POSTGRES_URL:'',DATABASE_URL:'',PGLITE_DATA_DIR:sandbox,PROJECT_LG_SANDBOX:sandbox,
  CHARACTER_EXECUTOR_ENABLED:'true',CHARACTER_EXECUTOR_HOST:'127.0.0.1',CHARACTER_EXECUTOR_PORT:String((executor.address() as {port:number}).port),CHARACTER_EXECUTOR_TOKEN:'isolated-executor-token',
  LG_PG_EXPECT_DATABASE:'',LG_PG_EXPECT_USER:'',LG_PG_EXPECT_DATABASE_PREFIX:'',LG_PG_EXPECT_USER_PREFIX:'',
  USER_NAME:'wechat-fixture-owner',OPENAI_API_KEY:'offline-fixture',OPENAI_BASE_URL:`http://127.0.0.1:${port(model)}`,
  OPENAI_LARGE_MODEL:'offline-fixture',OPENAI_SMALL_MODEL:'offline-fixture',LOG_LEVEL:'fatal',
  QQ_OWNER_ID:'11111111',QQ_BOT_ID:'99999999',QQ_ONEBOT_WS_URL:'ws://127.0.0.1:10000/',QQ_ONEBOT_ACCESS_TOKEN:'synthetic-main-qq-token-12345678',
  CHARACTER_KERNEL_ENABLED:'true',CHARACTER_CONTEXT_COMPILER_V1:'true',CHARACTER_MEMORY_ENABLED:'true',CHARACTER_MEMORY_EXPLICIT_ENABLED:'true',CHARACTER_RECALL_ENABLED:'true',
  CHARACTER_RELATIONSHIP_CONTEXT_ENABLED:'true',CHARACTER_AFFECT_CONTEXT_ENABLED:'true',CHARACTER_AFFECT_SEMANTIC_MODE:'rules',
  CHARACTER_MEMORY_SEMANTIC_MODE:'off',CHARACTER_MEMORY_RECALL_MODE:'lexical',CHARACTER_TOOL_DECISION_MODE:'rules',CHARACTER_QQ_PROACTIVE_MODE:'off',
  WECHAT_ENABLED:'true',WECHAT_API_URL:config.baseUrl,WECHAT_API_TOKEN:token,WECHAT_BOT_ID:bot,WECHAT_OWNER_ID:owner,
  WECHAT_ALLOWED_GROUP_IDS:`${G},${H}`,WECHAT_STATE_FILE:config.stateFile}
const lg=new LgStdioClient(root,env)
const logs:{event:string;code?:string}[]=[]
const client=new WechatGroupClient(config,request=>lg.submit(request),reading=>logs.push(reading),request=>lg.assessGroupReply(request))
async function turn(sender:string,text:string,group=G){
  const count=sends;messages.get(group)!.push({localId:++id,chatId:group,sender,type:1,content:text,timestamp:new Date().toISOString(),isSelf:false,isMentioned:false})
  await client.poll();assert.equal(sends,count+1,JSON.stringify(logs));assert.equal(logs.at(-1)!.event,'wechat_reply_api_accepted')
}
try{
  await lg.ready;await client.poll()
  const baselineAuthReads=authReads
  messages.get(G)!.push({localId:++id,chatId:G,sender:'wxid_silent',type:1,content:'保持安静的测试消息',timestamp:new Date().toISOString(),isSelf:false,isMentioned:true})
  await client.poll();assert.equal(sends,0);assert.equal(assessments,1)
  assert.equal(authReads,baselineAuthReads,'read-only attention must not repeat desktop account scans')
  account='wxid_wrong_account'
  messages.get(G)!.push({localId:++id,chatId:G,sender:'wxid_unverified',type:1,content:'账号错配测试',timestamp:new Date().toISOString(),isSelf:false})
  await client.poll();assert.equal(assessments,2);assert.equal(sends,0)
  assert.equal(authReads,baselineAuthReads+1,'formal admission must still check the live account')
  account=bot
  // Keep the declined message out of later model fixture decisions while preserving the real core's no-write assertion.
  messages.get(G)!.length=0
  await turn(A,'记住：我在微信甲大学')
  assert(prompts.at(-1)!.includes('微信甲大学'))
  await turn(B,'我在哪所大学？',H);assert(!prompts.at(-1)!.includes('微信甲大学'))
  await delay(3100)
  await turn(B,'记住：我在微信乙大学',H);assert(!prompts.at(-1)!.includes('微信甲大学'))
  await turn(owner,'请继续',G);assert(!prompts.at(-1)!.includes('微信乙大学'))
  assert.equal(executorConnections,1,'shared core and all group sessions must reuse one executor connection')
  client.stop();assert.equal(await Promise.race([lg.close(),delay(15000).then(()=>{throw new Error('core shutdown left live handles')})]),0)
  for(let i=0;i<40&&executorSockets.size>0;i++)await delay(25)
  assert.equal(executorSockets.size,0,'core shutdown must close its executor connection')
  const db=await openRawPGlite(sandbox)
  try{
    const maps=(await db.query("select external_id,user_id from user_identity_mappings where transport='wechat'")).rows as {external_id:string;user_id:string}[]
    assert.equal(maps.length,3);assert.equal(new Set(maps.map(m=>m.user_id)).size,3)
    const events=(await db.query("select actor_id,content_originator_id,metadata from conversation_events where metadata->>'transport'='wechat' and actor_type='user'")).rows as {actor_id:string;content_originator_id:string}[]
    assert.equal(events.length,4);assert(events.every(e=>e.actor_id===e.content_originator_id))
    const labels=(await db.query("select origin_room_id from record_scope_labels where origin_room_kind='group'")).rows as {origin_room_id:string}[]
    assert(labels.some(l=>l.origin_room_id===`wechat:${G}`));assert(labels.some(l=>l.origin_room_id===`wechat:${H}`))
    const memories=(await db.query('select id from memory_records')).rows;assert.equal(memories.length,2)
    const relations=(await db.query("select state from character_projections where projection_type like 'relationship:user:%'")).rows as {state:{originKind:string}}[]
    assert.equal(relations.filter(r=>r.state.originKind==='NEW_USER_BASELINE').length,2)
  }finally{await db.close()}
  assert.equal(digestTree(PRODUCTION_DB_DIR).treeSha256,before)
  console.log('PASS WeChat real main: 4 checked replies, 3 durable identities, 2 scoped memories, new-user relationships, cross-user/group privacy, truthful transport/attribution; production unchanged')
}finally{client.stop();for(const socket of executorSockets)socket.destroy();await lg.close();model.closeAllConnections();api.closeAllConnections();await Promise.all([new Promise<void>(done=>executor.close(()=>done())),new Promise<void>(done=>model.close(()=>done())),new Promise<void>(done=>api.close(()=>done()))]);cleanupSandbox(sandbox)}
