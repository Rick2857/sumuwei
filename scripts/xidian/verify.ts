import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { createXidianClient, encryptPassword, IDS, EHALL, type XidianSession } from '../../src/infrastructure/xidian/client.ts'
import { buildTimetable, rowsOf, renderTimetable, parseDate, XidianError } from '../../src/infrastructure/xidian/timetable.ts'
import { createXidianTimetableAdapter } from '../../src/infrastructure/action/adapters/xidian-timetable.ts'
import { createXidianCapabilityDefinitions, XIDIAN_TIMETABLE, XIDIAN_PERMISSION, mayReadXidianTimetable } from '../../src/kernel/action/xidian-capability.ts'
import { createCapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import { buildToolCatalog } from '../../src/kernel/action/tool-catalog.ts'
import { createActionGateway } from '../../src/kernel/action/gateway.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { createMemoryLedger, FIXTURE_CHARACTER } from '../world-model/isolated-bed.ts'
import { asActionId, asTraceId } from '../../src/kernel/contracts/ids.ts'
import { validateTurnContentList } from '../../src/kernel/contracts/turn-content.ts'
import { readKernelFlags } from '../../src/kernel/app/flags.ts'
import { ActionFailureError } from '../../src/kernel/action/errors.ts'

let checks = 0
function check(name: string, test: () => unknown) { test(); checks++; console.log(`PASS ${name}`) }
async function checkAsync(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log(`PASS ${name}`) }
const now = Date.parse('2026-09-15T01:00:00Z')
const row = { KCH:'A', KXH:'01', KCM:'测试课程', SKJS:'测试教师', JASMC:'测试教室', SKXQ:'1', KSJC:'1', JSJC:'2', SKZC:'1111' }
const stop = { ...row, TKLXDM:'02', SKZC:'0100' }
const move = { ...row, TKLXDM:'01', SKZC:'0010', XSKZC:'0010', XSKXQ:2, XKSJC:3, XJSJC:4, XJASMC:'调课教室' }
const patch = { KCH:'B', KXH:'02', KCM:'补课', TKLXDM:'03', XSKZC:'0100', XSKXQ:3, XKSJC:5, XJSJC:6, XJASMC:'补课教室' }
function snapshot(changes: Record<string,unknown>[] = []) { return buildTimetable({ semester:'2026-2027-1',termStart:'2026-09-07',rows:[{...row}],changes,unarranged:[{KCM:'待安排课程'}],fetchedAt:now }) }
check('严格日期校验', () => { assert.throws(() => parseDate('2026-02-30')); assert.throws(() => parseDate('x')); assert.equal(parseDate('2026-09-07'),Date.parse('2026-09-07T00:00:00Z')) })
check('真实 eHall 学期起点的午夜格式明确归一化，其他时间不猜',()=>{
  const input={semester:'2026-2027-1',termStart:'2026-09-07 00:00:00',rows:[row],changes:[],unarranged:[],fetchedAt:now}
  assert.equal(buildTimetable(input).termStart,'2026-09-07')
  assert.throws(()=>buildTimetable({...input,termStart:'2026-09-07 23:59:59'}),/invalid_term_anchor/)
})
check('停课、调课、补课按周次落在独立期望日期', () => {
  const s = snapshot([move,stop,patch])
  const report = renderTimetable(s,'2026-09-14',7)
  assert.match(report,/2026-09-14[^\n]*\n  已同步的已排课记录中无课/)
  assert.match(report,/2026-09-16[^\n]*\n  第5–6节 14:00–15:35 补课/)
  const next = renderTimetable(s,'2026-09-21',2)
  assert.match(next,/2026-09-21[^\n]*\n  已同步的已排课记录中无课/)
  assert.match(next,/2026-09-22[^\n]*\n  第3–4节 10:25–12:00 测试课程；教室：调课教室/)
  assert.match(report,/待安排课程/)
})
check('学期范围外不解释成无课', () => assert.match(renderTimetable(snapshot(),'2027-01-01',1),/不能据此判断无课/))
check('未知调课类型、无来源调课、非周一起点失败关闭', () => {
  assert.throws(() => snapshot([{...move,TKLXDM:'99'}]),/unknown_change_type/)
  assert.throws(() => snapshot([{...move,KCH:'missing'}]),/unresolved_changes/)
  assert.throws(() => buildTimetable({semester:'2026-2027-1',termStart:'2026-09-08',rows:[],changes:[],unarranged:[],fetchedAt:now}),/invalid_term_anchor/)
})
check('缺表、未发布、分页截断不产生空课表', () => {
  assert.throws(() => rowsOf({},'xskcb'))
  assert.throws(() => rowsOf({datas:{xskcb:{rows:[],totalSize:2}}},'xskcb'))
  assert.throws(() => rowsOf({datas:{xskcb:{rows:[],extParams:{code:0}}}},'xskcb'))
})
check('密码 AES 与上游固定前缀和 IV 相符', () => {
  const salt='0123456789ABCDEF', decipher=createDecipheriv('aes-128-cbc',Buffer.from(salt),Buffer.from('xidianscriptsxdu'))
  const plain=Buffer.concat([decipher.update(Buffer.from(encryptPassword('fixture-password',salt),'base64')),decipher.final()]).toString()
  assert.equal(plain,'xidianscriptsxdu'.repeat(4)+'fixture-password')
})
check('默认关闭；目录闭集含新工具', () => {
  assert.equal(readKernelFlags({}).xidianTimetableEnabled,false)
  assert.equal(readKernelFlags({CHARACTER_XIDIAN_TIMETABLE_ENABLED:'true'}).xidianTimetableEnabled,true)
  const [entry]=buildToolCatalog(createCapabilityRegistry(createXidianCapabilityDefinitions()))
  assert.equal(entry!.gateKey,'xidianTimetableEnabled'); assert.equal(entry!.enabled,false)
  assert.equal(entry!.producesTurnContent,true); assert.deepEqual(entry!.operations[0]!.argKeys,['date','days'])
})
check('只允许主人私聊，普通用户与主人群聊拒绝', () => {
  const owner={kind:'owner' as const,userId:'o',verifiedBy:'config_binding' as const}
  assert.equal(mayReadXidianTimetable({principal:owner,purpose:'external_query',room:{kind:'private',userId:'o'}}),true)
  assert.equal(mayReadXidianTimetable({principal:owner,purpose:'external_query',room:{kind:'group',groupId:'g'}}),false)
  assert.equal(mayReadXidianTimetable({principal:{kind:'user',userId:'u',verifiedBy:'onebot_inbound'},purpose:'external_query',room:{kind:'private',userId:'u'}}),false)
  assert.equal(mayReadXidianTimetable({principal:owner,purpose:'external_query',room:{kind:'private',userId:'u'}}),false)
})

const tableResponse = (name: string, rows: unknown[]) => new Response(JSON.stringify({datas:{[name]:{rows,totalSize:rows.length,extParams:{code:1}}}}),{headers:{'content-type':'application/json'}})
function fixture(mode: 'valid' | 'login' | 'mfa' | 'foreign' | 'bad-password') {
  let authenticated = mode==='valid', logins=0
  const seen: {url:string;cookie:string}[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const u=new URL(String(url)), form=new URLSearchParams(String(init?.body ?? ''))
    const cookie=(init?.headers as Record<string,string>)?.cookie ?? ''
    seen.push({url:u.href,cookie})
    if (u.origin === EHALL && !authenticated) return new Response('',{status:302,headers:{location:`${IDS}/authserver/login`}})
    if (u.origin === EHALL && u.pathname.startsWith('/jwapp/')) {
      const name=u.pathname.split('/').at(-1)!.replace('.do','')
      return tableResponse(name,name==='dqxnxq'?[{DM:'2026-2027-1'}]:name==='cxjcs'?[{XQKSRQ:'2026-09-07'}]:name==='xskcb'?[row]:[])
    }
    if (u.pathname==='/authserver/login' && !init?.body) return new Response('<form id="pwdFromId"><input type="hidden" id="pwdEncryptSalt" value="0123456789ABCDEF"><input type="hidden" name="lt" value=""><input type="hidden" name="execution" value="e1s1"></form>',{headers:{'set-cookie':'ids-only=fixture-cookie; Path=/; Secure; HttpOnly'}})
    if (u.pathname==='/authserver/login' && form.has('password')) {
      logins++; authenticated=mode==='login'
      if (mode==='bad-password') return new Response('',{status:401})
      return new Response('',{status:302,headers:{'set-cookie':'irrelevant=fixture; Domain=not-xidian.invalid; Path=/; Secure',location:mode==='foreign'?'https://foreign.invalid/collect':mode==='mfa'?`${IDS}/authserver/reAuthCheck/reAuthLoginView.do`:`${EHALL}/appShow?appId=4770397878132218`}})
    }
    if (u.pathname.includes('openSlider')) return new Response(JSON.stringify({bigImage:'fixture',smallImage:Buffer.alloc(40,1).toString('base64')}))
    if (u.pathname.includes('verifySlider')) {
      assert.equal(new Headers(init?.headers).get('origin'),IDS)
      assert.equal(new Headers(init?.headers).get('x-requested-with'),'XMLHttpRequest')
      const decipher=createDecipheriv('aes-128-cbc',Buffer.alloc(16,1),Buffer.alloc(16))
      const plain=Buffer.concat([decipher.update(Buffer.from(form.get('sign')!,'base64')),decipher.final()])
      const payload=JSON.parse(plain.subarray(64).toString())
      assert.equal(payload.canvasLength,280);assert.equal(payload.moveLength,41)
      assert(payload.tracks.length>=12&&payload.tracks.length<=16)
      assert.deepEqual(payload.tracks[0],{a:0,b:0,c:0})
      assert(payload.tracks.slice(1).every((p:{c:number,b:number})=>p.c>=300&&p.c<=500&&p.b>=-10&&p.b<=10))
      assert.equal(payload.tracks.at(-1).a,41)
      return new Response('{"errorCode":1}')
    }
    return new Response('ok')
  }
  return {fetchImpl,seen,logins:()=>logins}
}
for (const mode of ['valid','login','mfa','foreign','bad-password'] as const) await checkAsync(`HTTP 夹具认证分支 ${mode}`,async () => {
  const f=fixture(mode), session:XidianSession={fingerprint:'A'.repeat(32)}; let attempts=0
  const client=createXidianClient({session,credentials:{username:'20000000000',password:'fixture-password'},saveSession:async () => {},beforePasswordLogin:async () => {attempts++},solveCaptcha:async () => 40,fetchImpl:f.fetchImpl})
  if (mode==='mfa') { await assert.rejects(()=>client.fetchTimetable(now),/human_verification_required/); assert.match(session.challenge!,/reAuthLoginView/); const before=f.seen.length; await assert.rejects(()=>client.fetchTimetable(now),/human_verification_required/); assert.equal(f.logins(),1); assert.equal(f.seen.length,before+1) }
  else if (mode==='foreign') { await assert.rejects(()=>client.fetchTimetable(now),/unexpected_auth_redirect/); assert(f.seen.every(s => new URL(s.url).hostname!=='foreign.invalid')) }
  else if (mode==='bad-password') await assert.rejects(()=>client.fetchTimetable(now),/password_rejected/)
  else { const s=await client.fetchTimetable(now); assert.equal(s.semester,'2026-2027-1'); assert.equal(s.courses.length,1); assert(!JSON.stringify(s).includes('fixture-password')); assert.equal(attempts,mode==='valid'?0:1)
    assert(f.seen.filter(s => s.url.startsWith(EHALL)).every(s=>!s.cookie.includes('ids-only')&&!s.cookie.includes('irrelevant')))
  }
})

await checkAsync('短信二次认证使用上游状态码与受信设备字段',async()=>{
  const session:XidianSession={fingerprint:'B'.repeat(32),challenge:`${IDS}/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true`}
  let verified=false, sent=false, submitted=false
  const client=createXidianClient({session,credentials:{username:'20000000000',password:'fixture-password'},saveSession:async()=>{},beforePasswordLogin:async()=>{throw new Error('unexpected password retry')},solveCaptcha:async()=>{throw new Error('unexpected captcha')},fetchImpl:async(url,init)=>{
    const u=new URL(String(url)), form=new URLSearchParams(String(init?.body??''))
    if(u.pathname.endsWith('reAuthLoginView.do')) return new Response('<script>const config={"reAuthUserId":"fixture-delivery-id"}</script>')
    if(u.pathname.endsWith('changeReAuthType.do')) {assert.equal(form.get('reAuthType'),'3');return new Response('{"code":"1","data":{}}')}
    if(u.pathname.endsWith('getDynamicCodeByReauth.do')) {assert.equal(form.get('userName'),'fixture-delivery-id');sent=true;return new Response('{"res":"success"}')}
    if(u.pathname.endsWith('reAuthSubmit.do')) {assert.equal(form.get('dynamicCode'),'123456');assert.equal(form.get('skipTmpReAuth'),'true');assert.equal(form.get('reAuthType'),'3');verified=true;submitted=true;return new Response('{"code":"reAuth_success"}')}
    if(u.pathname.endsWith('/login')) {assert(verified);return new Response('',{status:302,headers:{location:`${EHALL}/appShow?appId=4770397878132218`}})}
    return new Response('ok')
  }})
  await client.sendVerificationCode();await client.submitVerificationCode('123456')
  assert(sent&&submitted);assert.equal(session.challenge,undefined)
})

const dir=await mkdtemp(join(tmpdir(),'lg-xidian-'))
try {
  await writeFile(join(dir,'timetable.json'),JSON.stringify(snapshot([stop,move,patch])))
  await writeFile(join(dir,'status.json'),JSON.stringify({ok:true,attemptedAt:now}))
  let allowed=true, calls=0
  const adapter=createXidianTimetableAdapter({directory:dir})
  const execute=adapter.execute.bind(adapter)
  const wrapped={capabilityId:XIDIAN_TIMETABLE,execute:async (input:Parameters<typeof execute>[0])=>{calls++;return execute(input)}}
  const ledger=createMemoryLedger(), registry=createCapabilityRegistry(createXidianCapabilityDefinitions())
  const target={type:'external_service',canonicalId:'xidian:owner-undergraduate-timetable',displayName:'课表',confidence:'exact' as const}
  const makeGateway=(permissions: string[])=>createActionGateway({ledger,registry,adapters:[wrapped],grantedPermissions:permissions,maxRiskLevel:'R1',now:()=>now,resolveTarget:async()=>({target,scopeViolation:!allowed})})
  await checkAsync('真实 ActionTurn → Gateway → 文件快照 → 当轮内容',async () => {
    const port=createActionTurnPort({gateway:makeGateway([XIDIAN_PERMISSION]),registry,detector:{detect:()=>({capability:XIDIAN_TIMETABLE,operation:'query',args:{date:'2026-09-16',days:1},hints:[],rule:'fixed-fixture',phrase:'fixture'})}})
    const turn=await port.handleTurn({characterId:FIXTURE_CHARACTER,traceId:asTraceId('fixture-xidian'),eventId:'fixture-event',speaker:{kind:'user',id:'owner'},text:'查一下明天的课表'})
    assert.equal(turn.result?.status,'success')
    assert.match((turn.result?.turnContent?.[0] as {text:string}).text,/补课教室/)
    assert.deepEqual(validateTurnContentList(turn.result!.turnContent!),[])
    assert((await ledger.listEvents(FIXTURE_CHARACTER,99)).some(e=>e.type==='ACTION_SUCCEEDED'))
  })
  await checkAsync('缺权限被 Gateway 拒绝，零适配器调用',async () => {
    const before=calls
    const result=await makeGateway([]).execute(FIXTURE_CHARACTER,{actionId:asActionId('missing-permission'),traceId:asTraceId('x'),capability:XIDIAN_TIMETABLE,operation:'query',requestedBy:{kind:'user'},arguments:{},sideEffect:'read',createdAt:now})
    assert.equal(result.status,'rejected'); assert.equal(calls,before)
  })
  const input={actionId:asActionId('fixture-direct'),operation:'query',target,args:{date:'2026-09-16',days:1},now:()=>now}
  await checkAsync('群聊等越权读取在 Gateway 拒绝，零适配器 IO',async()=>{
    allowed=false; const before=calls
    const result=await makeGateway([XIDIAN_PERMISSION]).execute(FIXTURE_CHARACTER,{actionId:asActionId('wrong-scope'),traceId:asTraceId('x'),capability:XIDIAN_TIMETABLE,operation:'query',requestedBy:{kind:'user'},arguments:{},sideEffect:'read',createdAt:now})
    assert.equal(result.status,'rejected');assert.equal(calls,before);allowed=true
  })
  await checkAsync('非法日期、账号/URL/路径注入拒绝',async()=>{
    for (const args of [{date:'2026-02-30'},{username:'other'},{url:'https://foreign.invalid'},{path:'/etc/passwd'},{days:8}]) await assert.rejects(()=>adapter.execute({...input,args}),ActionFailureError)
  })
  await checkAsync('同步失败提示缓存，不冒充实时',async()=>{
    await writeFile(join(dir,'status.json'),JSON.stringify({ok:false,attemptedAt:now+1}))
    const result=await adapter.execute(input);assert.match((result.turnContent![0] as {text:string}).text,/最近同步未成功/)
  })
  await checkAsync('陈旧与未来快照均拒绝，不回吐空课表',async()=>{
    for (const fetchedAt of [now-6*3600000-1,now+120000]) {await writeFile(join(dir,'timetable.json'),JSON.stringify({...snapshot(),fetchedAt}));await assert.rejects(()=>adapter.execute(input),ActionFailureError)}
  })
  await checkAsync('坏快照与缺文件拒绝',async()=>{
    await writeFile(join(dir,'timetable.json'),'broken'); await assert.rejects(()=>adapter.execute(input),ActionFailureError)
    await rm(join(dir,'timetable.json'));await assert.rejects(()=>adapter.execute(input),ActionFailureError)
  })
} finally { await rm(dir,{recursive:true,force:true}) }
console.log(JSON.stringify({checks,failed:0,realSchoolLogins:0,realModelRequests:0,database:'none; in-memory ledger',location:process.platform}))
