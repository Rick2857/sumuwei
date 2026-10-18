/** Synthetic loopback WeChat API + real isolated identity storage. Never reads/sends real WeChat. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWechatConfig, WechatApi, WechatGroupClient, wechatMessageKey, type WechatMessage, type WechatTurnRequest } from '../src/infrastructure/wechat/group-client.ts'
import { platformFactsProblems, type BridgeWireResponse } from '../src/kernel/app/bridge/turn-bridge.ts'
import { resolveInboundTurnScope } from '../src/infrastructure/runtime/inbound-turn-scope.ts'
import { countTransportMappings } from '../src/infrastructure/runtime/inbound-identity-resolver.ts'
import { admittedUserIds, withReadScope } from '../src/infrastructure/persistence/read-scope.ts'
import { bindTransportIdentity } from '../src/infrastructure/persistence/identity-store.ts'
import { impressionQuery } from '../src/infrastructure/runtime/impression-query.ts'
import { createHumanWechatGroupUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { isolateDatabase, cleanupSandbox, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'

process.env.CHARACTER_DB_BACKEND='pglite'; process.env.POSTGRES_URL=''; process.env.DATABASE_URL=''
process.env.LG_PG_EXPECT_DATABASE='template1'; process.env.LG_PG_EXPECT_USER='postgres'
process.env.LG_PG_EXPECT_DATABASE_PREFIX=''; process.env.LG_PG_EXPECT_USER_PREFIX=''
const root=mkdtempSync(join(tmpdir(),'lg-wechat-verify-'))
const G='111@chatroom', H='222@chatroom', bot='wxid_bot', owner='wxid_owner', A='wxid_alice', B='wxid_bob'
const token='synthetic-wechat-token-123456789'
let account=bot, failedSend=false, sends=0, localId=0
const received: string[]=[]; const requests: WechatTurnRequest[]=[]; const paths: string[]=[]
const messages=new Map<string,WechatMessage[]>([[G,[]],[H,[]]])
const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end('{}');return}
  const url=new URL(req.url!,'http://127.0.0.1');paths.push(url.pathname)
  let result: unknown
  if(url.pathname==='/api/status/auth')result={status:'logged_in',loggedInUser:account+'_abcd'}
  else if(url.pathname.startsWith('/api/chats/')){const id=decodeURIComponent(url.pathname.split('/').at(-1)!);result=messages.has(id)?{id,isGroup:true}:null}
  else if(url.pathname==='/api/messages/send'){
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw);assert([G,H].includes(body.chatId));sends++;received.push(body.text);result={success:!failedSend}
  }else if(url.pathname.startsWith('/api/messages/'))result=messages.get(decodeURIComponent(url.pathname.split('/').at(-1)!))??[]
  else{res.writeHead(404).end('{}');return}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result))
})
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
const address=server.address();assert(address&&typeof address!=='string')
const config=readWechatConfig({WECHAT_ENABLED:'true',WECHAT_API_URL:`http://127.0.0.1:${address.port}`,WECHAT_API_TOKEN:token,
  WECHAT_BOT_ID:bot,WECHAT_OWNER_ID:owner,WECHAT_ALLOWED_GROUP_IDS:`${G},${H}`,WECHAT_STATE_FILE:join(root,'state.json')})!
const api=new WechatApi(config)
function add(group:string,sender:string,content:string,other:Partial<WechatMessage>={}){
  const m:WechatMessage={chatId:group,localId:++localId,sender,type:1,content,timestamp:new Date().toISOString(),isSelf:false,...other}
  messages.get(group)!.push(m);return m
}
const submit=async(r:WechatTurnRequest)=>{requests.push(r);await api.verifyFacts(r.platformFacts,r.userText);return {outcome:'replied',replyText:'checked LG reply'} as BridgeWireResponse}
let checks=0
function check(label:string,run:()=>void){run();console.log('PASS '+label);checks++}
const assess=async(r:WechatTurnRequest):Promise<BridgeWireResponse>=>{await api.verifyFacts(r.platformFacts,r.userText);const reply=!r.userText.startsWith('ordinary');return {kind:'GROUP_REPLY_DECISION',requestId:r.requestId,outcome:'accepted',groupReply:{reply,code:reply?'group_reply_chosen':'group_reply_silent'}}}
const client=new WechatGroupClient(config,submit,()=>{},assess)
const sandbox=isolateDatabase('wechat-group-identity',{keep:false})
const h=await createM4Harness({label:'wechat-group-identity'})
try{
  add(G,A,'苏沐薇，old history');await client.poll();check('startup never replays history',()=>assert.equal(sends,0))
  add(G,A,'ordinary unaddressed text');await client.poll();check('ordinary group text stays quiet',()=>assert.equal(sends,0))
  add(G,A,'苏沐薇，hello');await client.poll();check('name trigger -> checked LG reply',()=>{assert.equal(sends,1);assert.equal(requests[0]!.platformFacts.senderUserId,A);assert.equal(received[0],'checked LG reply')})
  await client.poll();check('duplicate polling does not resubmit',()=>assert.equal(sends,1))
  const restarted=new WechatGroupClient(config,submit,()=>{},assess);await restarted.poll();check('restart never replays a sent/uncertain message',()=>assert.equal(sends,1))
  add(H,B,'mention test',{isMentioned:true});await client.poll();check('second allowed group, @ trigger',()=>assert.equal(sends,2))
  add(H,bot,'苏沐薇，self',{isSelf:true});add(H,A,'苏沐薇，stale',{timestamp:new Date(Date.now()-400_000).toISOString()});await client.poll()
  check('self and stale events ignored',()=>assert.equal(sends,2))
  assert.equal(platformFactsProblems(requests[0]!.platformFacts),undefined)
  await assert.rejects(()=>api.verifyFacts({...requests[0]!.platformFacts,senderUserId:owner}),/not_verified/);checks++;console.log('PASS core rejects forged owner ID')
  await assert.rejects(()=>api.verifyFacts(requests[0]!.platformFacts,'forged text'),/not_verified/);checks++;console.log('PASS core rejects altered content')
  await assert.rejects(()=>api.messages('999@chatroom'),/not_authorized/);checks++;console.log('PASS unlisted groups blocked before HTTP')
  check('private input has no valid bridge shape',()=>assert(platformFactsProblems({...requests[0]!.platformFacts,messageType:'private'})))
  account='wxid_wrong';await assert.rejects(()=>api.verifyFacts(requests[0]!.platformFacts),/not_ready/);account=bot;checks++;console.log('PASS account mismatch fails closed at source verification')
  failedSend=true;add(G,B,'苏沐薇，uncertain send');await client.poll();await client.poll();check('failed send is attempted once only',()=>assert.equal(sends,3))
  check('message identity preserves distinct local IDs without unsafe serverId',()=>assert.notEqual(wechatMessageKey({...messages.get(G)![0]!,localId:100}),wechatMessageKey({...messages.get(G)![0]!,localId:101})))
  const derive=({externalId}:{externalId:string})=>externalId===owner?h.userId:`wechat-user-${externalId}`
  const scope=async(sender:string,group=G)=>resolveInboundTurnScope({db:h.db,ownerUserId:h.userId,ensureArchive:true,allowedFor:()=>true,deriveUserId:derive,
    groupAuthorized:true,facts:{transport:'wechat',botId:bot,selfId:bot,senderUserId:sender,messageType:'group',groupId:group}})
  const a=await scope(A),b=await scope(B),o=await scope(owner),again=await scope(A,H)
  check('different WeChat accounts have different durable identity archives',()=>{assert.notEqual(a.userId,b.userId);assert.notEqual(a.userId,o.userId);assert.equal(o.userId,h.userId);assert.equal(o.isOwner,true)})
  check('same account across groups retains identity, room remains separate',()=>{assert.equal(a.userId,again.userId);assert.notDeepEqual(a.scope!.room,again.scope!.room);assert.equal(a.boundFirstTime,true);assert.equal(again.boundFirstTime,false)})
  check('WeChat group has a namespace and truthful verifier',()=>{assert.deepEqual(a.scope!.room,{kind:'group',groupId:`wechat:${G}`});assert.equal(a.scope!.principal.kind,'user');assert.equal((a.scope!.principal as {verifiedBy:string}).verifiedBy,'wechat_inbound')})
  const mappingCount=await countTransportMappings(h.db,'wechat')
  check('mapping count is idempotent',()=>assert.equal(mappingCount,3))
  const admitted=await admittedUserIds(h.db,h.userId);check('background cognition includes WeChat archives',()=>{assert(admitted.includes(a.userId!));assert(admitted.includes(b.userId!))})
  await bindTransportIdentity(h.db,{transport:'qq',externalId:'11111111',userId:h.userId})
  const impression=await withReadScope({context:{principal:{kind:'owner',userId:h.userId,verifiedBy:'config_binding'},purpose:'external_query',room:{kind:'private',userId:h.userId}},ownerUserId:h.userId,roomAuthorized:true},()=>impressionQuery(h.db,h.characterId,'对 wxid_owner 和 11111111 的印象'))
  check('owner QQ/WeChat aliases resolve to one impression target',()=>{assert(impression);assert(!impression.includes('对象不明确'))})
  check('truthful WeChat ingress refuses a presenter mismatch',()=>assert.throws(()=>createHumanWechatGroupUserTurnIngress().attest({characterId:h.characterId,userId:A,presenterActorId:B})))
  const authReads=paths.filter(p=>p==='/api/status/auth').length
  await client.poll();check('idle polling does not rescan the desktop',()=>assert.equal(paths.filter(p=>p==='/api/status/auth').length,authReads))
  failedSend=false
  add(G,owner,'普通闲聊也可以接话');await client.poll()
  check('ordinary text accepted by LG reaches the formal pipeline',()=>assert.equal(sends,4))
  add(G,owner,'ordinary @ message declined by LG',{isMentioned:true});await client.poll()
  check('@ does not override LG silence',()=>assert.equal(sends,4))
  add(G,owner,'第一条突发消息');add(G,owner,'第三人称谈到苏沐薇');await client.poll()
  check('burst coalesces to one decision with preceding public context',()=>{assert.equal(sends,5);assert(requests.at(-1)!.groupContext?.some(line=>line.text==='第一条突发消息'))})
  client.stop();await client.poll();check('stop prevents further submission',()=>assert.equal(sends,5))
  check('no private message endpoint used',()=>assert(paths.every(p=>!p.includes('private'))))
  console.log(`PASS ${checks} WeChat checks; synthetic API + isolated identity storage, no real sends`)
}finally{client.stop();await h.stop();await resetPluginSqlConnection();cleanupSandbox(sandbox.dir);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true})}
