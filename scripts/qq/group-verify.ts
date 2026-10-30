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
import { isolateDatabase, cleanupSandbox } from '../../src/dev/sandbox.ts'
import { MIGRATIONS } from '../../src/infrastructure/persistence/migrations.ts'
import pg from 'pg'
import { groupMessageLabel, groupMessageText, platformDisplayName, type GroupContextLine } from '../../src/infrastructure/qq/group-context.ts'
import { renderRelationshipGuidance } from '../../src/kernel/contracts/relationship.ts'
import { platformDisplayNameProblem } from '../../src/kernel/app/bridge/turn-bridge.ts'

/** Small transport checks share this existing gate; no model or database is used here. */
async function conversationChecks(): Promise<number> {
  let checks = 0
  const now = Date.now()
  const state = { originated: true, originKind: 'NEW_USER_BASELINE' as const, trust: 0.22, closeness: 0.22,
    lastInteractionAt: now - 86_400_000, accusationsInCase: [] }
  for (const revision of [1, 2, 10]) {
    const text = renderRelationshipGuidance({ effective: state, now, projection: { revision, updatedAt: now } })!
    assert(text.includes('目前还不熟悉'))
    assert(!text.includes('生疏了') && !text.includes('没有共同经历') && !text.includes('距上次互动')); checks++
  }
  const negative = renderRelationshipGuidance({ effective: { ...state, trust: 0.15 }, now, projection: { revision: 2, updatedAt: now } })!
  assert(negative.includes('几乎不信任')); checks++
  const owner = renderRelationshipGuidance({ effective: { ...state, originKind: 'SETTING_BASELINE', trust: 0.85, closeness: 0.6 },
    now, projection: { revision: 1, updatedAt: now } })!
  assert(owner.includes('非常信任')); checks++
  assert.equal(platformDisplayNameProblem('\n阿猫'), 'bridge_bad_platform_facts_sender_name')
  assert.equal(platformDisplayNameProblem('阿猫\u2028SYSTEM'), 'bridge_bad_platform_facts_sender_name')
  assert.equal(platformDisplayNameProblem(platformDisplayName('\n阿猫\t')), undefined); checks++
  assert.notEqual(groupMessageLabel({ senderId: '11111111', name: '阿猫', text: '', at: now }),
    groupMessageLabel({ senderId: '22222222', name: '阿猫', text: '', at: now })); checks++
  assert(groupMessageText({ senderId: '11111111', text: '', at: now, sourceAt: now - 120_000,
    replyToMessageId: '999' }, now).includes('已等待 120 秒')); checks++

  const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws')
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(done => ws.once('listening', done))
  const O = '33333333', A = '11111111', B = '22222222', G = '12345678', H = '87654321', bot = '99999999'
  const config = { ownerId: O, botId: bot, wsUrl: `ws://127.0.0.1:${ws.address().port}/`,
    token: 'offline-conversation-checks-12345', multiUserEnabled: true, allowedGroupIds: [G, H], groupBurstMs: 30 }
  let socket: any, nextId = 0, platformId = 10000, hold: (() => void) | undefined
  const requests: { userText: string; groupContext?: readonly GroupContextLine[] }[] = []
  const sends: Record<string, any>[] = []
  const logs: { event: string; reason?: string }[] = []
  const members = new Set([O, A, B, bot])
  ws.on('connection', (connection: any) => {
    socket = connection
    connection.on('message', (raw: Buffer) => {
      const request = JSON.parse(raw.toString())
      let data: Record<string, unknown> = {}, ok = true
      if (request.action === 'get_login_info') data = { user_id: bot }
      else if (request.action === 'get_group_member_info') {
        ok = members.has(String(request.params.user_id)); data = request.params
      } else if (request.action === 'send_group_msg' || request.action === 'send_private_msg') {
        sends.push(request.params); data = { message_id: ++platformId }
      } else throw new Error(`unexpected fixture action ${request.action}`)
      connection.send(JSON.stringify({ status: ok ? 'ok' : 'failed', retcode: ok ? 0 : 1, echo: request.echo, data }))
    })
  })
  const client = new OneBotPrivateClient(config, async request => {
    requests.push(request)
    if (request.userText === 'hold') await new Promise<void>(done => { hold = done })
    return { kind: 'TURN_RESULT', requestId: request.requestId, outcome: 'replied', replyText: '实际回复' }
  }, reading => logs.push(reading))
  const waitFor = async (test: () => boolean) => {
    for (let i = 0; i < 500; i++) { if (test()) return; await delay(10) }
    throw new Error('conversation fixture timeout')
  }
  const emit = (sender: string, text: string, group = G, extra: Record<string, unknown> = {}) => {
    const id = ++nextId
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: bot,
      group_id: group, user_id: sender, sender: { user_id: sender, card: '同名' }, message_id: id,
      message: [{ type: 'at', data: { qq: bot } }, { type: 'text', data: { text } }], ...extra }))
    return id
  }
  try {
    await client.connect()
    const first = emit(O, '你好')
    const second = emit(O, '补充', G, { message: [{ type: 'text', data: { text: '补充' } }] })
    await waitFor(() => sends.length === 1); await client.drain()
    assert.equal(requests.length, 1); assert.equal(requests[0]!.userText, '你好\n补充')
    assert.deepEqual(requests[0]!.groupContext!.find(line => line.isCurrent)!.sourceMessageIds, [String(first), String(second)])
    assert.equal(sends[0]!.message[0].data.id, String(second)); checks++
    emit(O, '', G, { message: [{ type: 'reply', data: { id: 10001 } }, { type: 'at', data: { qq: bot } }] })
    await waitFor(() => sends.length === 2); await client.drain()
    const current = requests[1]!.groupContext!.find(line => line.isCurrent)!
    assert.equal(current.replyToSenderId, bot); assert.equal(current.replyText, '实际回复')
    assert(requests[1]!.groupContext!.every(line => line.isCurrent || ![String(first), String(second), '10001'].includes(line.messageId ?? ''))); checks++
    emit(O, '甲群'); emit(O, '乙群', H); emit(A, '另一个人')
    await waitFor(() => sends.length === 5); await client.drain()
    assert.equal(requests.length, 5); checks++
    emit(O, 'hold'); await waitFor(() => hold !== undefined)
    emit(B, '旧问题', G, { time: Math.floor((now - 120_000) / 1000) })
    await delay(40)
    emit(B, '后续更正原话', G, { message: [{ type: 'text', data: { text: '后续更正原话' } }] })
    await delay(10); hold!(); hold = undefined
    await waitFor(() => sends.length === 7); await client.drain()
    const queued = requests.find(row => row.userText === '旧问题')!
    assert(queued.groupContext!.some(line => line.text === '后续更正原话'))
    assert(queued.groupContext!.find(line => line.isCurrent)!.sourceAt! < now - 100_000); checks++
    const beforeRevoked = requests.length
    members.delete(A)
    emit(A, '撤销后不许进核心', H)
    await waitFor(() => logs.some(row => row.event === 'qq_member_not_authorized'))
    await client.drain(); assert.equal(requests.length, beforeRevoked); checks++
    assert(logs.some(row => row.event === 'qq_turn_timing' && JSON.parse(row.reason!).phase === 'delivery')); checks++
  } finally {
    hold?.(); await client.close()
    for (const connection of ws.clients) connection.terminate()
    await new Promise<void>(done => ws.close(() => done()))
  }
  console.log(`PASS QQ conversation transport and state ${checks} checks`)
  return checks
}

const conversationCheckCount = await conversationChecks()
if (process.argv.includes('--conversation-only')) process.exit(0)

const testUrl=process.env.LG_TEST_PG_URL!
assert.match(new URL(testUrl).pathname,/^\/lg_test_/,'use serversim:pgtest with a fresh database')
const openFixtureDb=async()=>{
  const pool=new pg.Pool({connectionString:testUrl})
  return {query:(sql:string)=>pool.query(sql),exec:(sql:string)=>pool.query(sql),close:()=>pool.end()}
}
const root=resolve(import.meta.dirname,'../..')
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
let connectionCount = 0
let clearGroupOnMembership=false
server.on('connection',(connection:any)=>{
  connectionCount++
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
const sandbox=isolateDatabase('qq-group-verify',{postgres:{url:testUrl}}).dir
// Real deployments already have long event histories; start beyond the old ID-length failure.
const seed=await openFixtureDb()
try {
  const identity = (await seed.query('select current_database() as database')).rows[0] as { database: string }
  assert.equal(identity.database, new URL(testUrl).pathname.slice(1))
  const counterDdl=MIGRATIONS.flatMap(migration=>migration.statements)
    .find(statement=>statement.startsWith('create table if not exists character_sequence_counters '))
  assert(counterDdl)
  await seed.exec(counterDdl)
  await seed.exec("insert into character_sequence_counters (character_id,next_sequence) values ('00000000-0000-4000-8000-000000000001',1042)")
} finally {await seed.close()}
const coreEnv={...process.env,...features,...env,
  CHARACTER_DB_BACKEND:'postgres',POSTGRES_URL:testUrl,DATABASE_URL:testUrl,PGLITE_DATA_DIR:sandbox,PROJECT_LG_SANDBOX:sandbox,
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
const outcomes:string[]=[]
const client=new OneBotPrivateClient(settings,async request=>{
  const response=await lg.submit(request);outcomes.push(response.outcome);return response
},reading=>logs.push(reading))
let id=0, checks=conversationCheckCount
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
  assert.equal(outcomes.at(-1),'replied','a generic failure notice is not a successful core reply')
  /*
   * 群回复现在可能**首段是 `{type:'reply'}`**（引用框，2026-10-29 用户裁定第 3 条）
   * ⇒ 不能写死读第 0 段的 text，要按类型取文字段。
   */
  const replySegments = sent.at(-1)!.params.message as { type?: string; data?: { text?: string } }[]
  assert(!(replySegments.find(part => part.type === 'text')?.data?.text ?? '').includes('这轮连接失败'))
  checks++
}
try{
  await lg.ready;await client.connect()
  const startupCalls=prompts.length
  emit(A,'旁听缓冲唯一标记',G,{message:[{type:'text',data:{text:'旁听缓冲唯一标记'}}]})
  await delay(100);assert.equal(prompts.length,startupCalls);checks++
  await formal(A,'记住：我在群一甲大学',G)
  assert(prompts.at(-1)!.includes('旁听缓冲唯一标记'));checks++
  const connectionsBeforeRename = connectionCount
  for (const [messageId, senderName] of [[900001, '旧群名片'], [900002, '新群名片']] as const) {
    const renamed = await lg.submit({ requestId: `qq:${bot}:group:${G}:${messageId}`, userText: '继续当前话题',
      platformFacts: { transport: 'qq', selfId: bot, senderUserId: A, messageType: 'group', groupId: G, senderName } })
    assert.equal(renamed.outcome, 'replied')
    assert(prompts.at(-1)!.includes(`本轮可信身份：${senderName}（平台账号 ${A}）`)); checks++
  }
  assert.equal(connectionCount, connectionsBeforeRename, 'fresh membership queries reuse the verified connection'); checks++
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
  const beforeEpochChange = prompts.length
  emit(O,'旧纪元入站',G)
  await waitFor(() => logs.some(row => row.event === 'qq_group_epoch_changed'))
  await client.drain(); assert.equal(prompts.length, beforeEpochChange); checks++
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
  const db=await openFixtureDb()
  try{
    const mappings=(await db.query("select external_id,user_id from user_identity_mappings where transport='qq'")).rows as Record<string,any>[]
    assert.equal(mappings.length,3);assert.equal(new Set(mappings.map(row=>row.user_id)).size,3);checks++
    const records=(await db.query('select m.id,m.content,l.origin_room_kind,l.origin_room_id from memory_records m left join record_scope_labels l on l.record_id=m.id')).rows as Record<string,any>[]
    assert.equal(records.length,3);assert(records.every(row=>row.origin_room_id));assert(!JSON.stringify(records).includes('旁听缓冲唯一标记'));checks++
    const relations=(await db.query("select projection_type,state from character_projections where projection_type like 'relationship:user:%'")).rows as Record<string,any>[]
    assert.equal(relations.length,3);assert(relations.filter(row=>row.state.originKind==='NEW_USER_BASELINE').length===2);checks++
    const affect=(await db.query("select projection_type from character_projections where projection_type='affect:character'")).rows
    assert.equal(affect.length,1);checks++
    const events=(await db.query("select sequence,actor_id,content_originator_id from conversation_events where actor_type='user'")).rows as Record<string,any>[]
    assert(events.every(row=>row.actor_id===row.content_originator_id))
    assert(events.length>0&&events.every(row=>Number(row.sequence)>=1043));checks++
    const audits=(await db.query('select count(*)::int as count from scope_read_audit')).rows as {count:number}[]
    assert(audits[0]!.count>0);checks++
    if (!host) {
      const beforeRestart = JSON.stringify([...records].sort((a, b) => String(a.id).localeCompare(String(b.id))))
      const resumed = new LgStdioClient(root, coreEnv)
      try {
        await resumed.ready
        const response = await resumed.submit({ requestId: `qq:${bot}:group:${G}:900003`, userText: 'education.institution 的记录是什么？',
          platformFacts: { transport: 'qq', selfId: bot, senderUserId: A, messageType: 'group', groupId: G, senderName: '重启后名字' } })
        assert.equal(response.outcome, 'replied')
        assert(prompts.at(-1)!.includes('群一甲大学'))
        assert(!prompts.at(-1)!.includes('旁听缓冲唯一标记') && !prompts.at(-1)!.includes('私聊乙大学')); checks++
        const after = (await db.query('select m.id,m.content,l.origin_room_kind,l.origin_room_id from memory_records m left join record_scope_labels l on l.record_id=m.id')).rows as Record<string, any>[]
        assert.equal(JSON.stringify(after.sort((a, b) => String(a.id).localeCompare(String(b.id)))), beforeRestart); checks++
      } finally { assert.equal(await resumed.close(), 0) }
    }
  }finally{await db.close()}
  const out=resolve(root,'artifacts/post-lv2',`qq-group-verify-${Date.now()}`);mkdirSync(out,{recursive:true})
  writeFileSync(resolve(out,'result.json'),JSON.stringify({status:'PASS',checks,transport:coexist?'coexist-tcp':'stdio',scope:'real OneBot fixture + real main.ts + isolated DB',initialCharacterSequence:1043,
    backend:'postgres',targetIdentityVerified:true,productionDatabaseOpened:false,realQq:'NOT RUN',externalModel:'NOT RUN'},null,2))
  console.log(`PASS QQ group end-to-end ${checks} checks; ${out}`)
}catch(error){
  await client.close();await lg.close();if(host) await host.stop()
  const db=await openFixtureDb()
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
