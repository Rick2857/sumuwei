/**
 * post-Lv2 / QQ 群任务 **P2.1-A · 群目标消歧链** 门。
 *
 * ============================================================================
 *  这道门回答什么（零真实 QQ · 零真实网络 · 零真实模型 · 不打开数据库）
 * ============================================================================
 * ```text
 * 01 `get_group_list` 走**真实 ws socket**（本机假 OneBot），回包群号统一成 string
 *    并逐个过 `qqId`（数字/字符串两种形状都收）
 * 02 ★ **只读负控**：解析链全程假 OneBot 收到 **0 条** `send_group_msg` /
 *    `send_private_msg`；且纯消歧模块里**没有**群名单/成员/放行标识符
 * 03 有界：200 个群接受、201 个群**具名拒绝**；上限按**回包原始条数**（清理前）计
 * 04 非对象 / 坏群号 / 超长群名 / 重复群号 ⇒ **整条丢弃并计入读数**（不静默放行）；
 *    回包 `data` 不是数组 ⇒ `qq_group_list_invalid`
 * 05 断线 ⇒ 具名错误（未连接 / 在途断线 / 关闭后三种）
 * 06 精确群号命中 ⇒ resolved（群名取自列表）
 * 07 群号不在列表 ⇒ not_found（不换一种找法）
 * 08 精确同名唯一 ⇒ resolved
 * 09 精确同名多个 ⇒ ambiguous（候选按群号升序稳定）
 * 10 名字含空白 / 前后空白归一后命中
 * 11 包含匹配唯一 ⇒ resolved
 * 12 包含匹配多个 ⇒ ambiguous
 * 13 零命中 ⇒ not_found
 * 14 群号与名字矛盾 ⇒ invalid / `group_hint_conflict`（一致时不误报）
 * 15 空 hint / 坏群号 / 超长名字 ⇒ invalid 具名码（上限按**码点**计）
 * 16 旧私聊发送路径逐字不变：`listGroups()` 不占发送队列，旧回复仍走 `send_private_msg`
 * ```
 *
 * ⚠️ **本门不证明**（必须与读数一起读）：
 * ```text
 * · 真实 LLBot / PMHQ 的 `get_group_list` 回包字段与形状 —— 假 OneBot 只是本机 ws 夹具
 * · 真实 QQ 群名长度分布 / 重名情况 —— 真值表是**合成**的
 * · 任务授权与准入判定 —— 本批**不接线**；消歧成功**不等于**可以发（纯消歧模块不做任何放行）
 * · 真机断线重连时序 —— 本门只测"在途断线 ⇒ 具名错误"
 * · 真实 QQ 送达 —— 零真实 QQ
 * ```
 *
 * ⚠️ 本门**不需要 PG**：只起本机 ws 夹具 + 纯函数，loopback + 临时证据目录。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  OneBotPrivateClient,
  QQ_GROUP_LIST_LIMITS,
  type QqGroupListEntry,
} from '../src/infrastructure/qq/onebot-private-client.ts'
import { qqId, readQqPrivateConfig } from '../src/infrastructure/qq/private-config.ts'
import {
  GROUP_NAME_MAX_CODEPOINTS,
  GROUP_TARGET_RESOLUTION_CODES,
  resolveGroupTarget,
  type QqGroupTargetHint,
} from '../src/infrastructure/qq/group-directory.ts'

const ROOT = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/\D/g, '')
const evidenceRoot = resolve(ROOT, 'artifacts/post-lv2', `qq-group-resolve-${stamp}`)

/* ------------------------------------------------------------------------- */
/* 极简检查器（每项具名 PASS/FAIL；失败计数非零 ⇒ 退出码非零）                  */
/* ------------------------------------------------------------------------- */
const checks: string[] = []
const failures: string[] = []
const check = async (name: string, run: () => void | Promise<void>): Promise<void> => {
  try {
    await run()
    checks.push(name)
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    const stack = error instanceof Error ? (error.stack ?? '') : ''
    const at = stack.split('\n').find((line) => line.includes('postlv2-qq-group-resolve-verify.ts')) ?? ''
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`
      + `${at === '' ? '' : `\n     ${at.trim()}`}`)
  }
}

/* ------------------------------------------------------------------------- */
/* 本机假 OneBot（ws 夹具；与 `scripts/qq/group-verify.ts` 同一种写法）        */
/* ------------------------------------------------------------------------- */
const OWNER = '10001'
const BOT = '10002'

type FixturePacket = { action: string; params: Record<string, any> }
const { WebSocketServer } = createRequire(import.meta.resolve('jsdom'))('ws') as {
  WebSocketServer: new (options: { host: string; port: number }) => {
    on: (event: string, handler: (connection: any) => void) => void
    once: (event: string, handler: () => void) => void
    address: () => { port: number }
    clients: Set<any>
    close: (done: () => void) => void
  }
}
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>((done) => server.once('listening', done))
const port = server.address().port

const packets: FixturePacket[] = []
const connections: any[] = []
/** 当前 `get_group_list` 回包的 `data`（每个读数自己设） */
let groupListPayload: unknown = []
/** `silent` = 收到请求不回包（用来测"在途断线"） */
let groupListBehaviour: 'reply' | 'silent' = 'reply'
let nextMessageId = 7000
let privateMessageId = 5000

server.on('connection', (connection: any) => {
  connections.push(connection)
  connection.on('message', (raw: Buffer) => {
    const packet = JSON.parse(raw.toString()) as { action: string; params: Record<string, any>; echo: string }
    packets.push({ action: packet.action, params: packet.params })
    if (packet.action === 'get_login_info') {
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: BOT }, echo: packet.echo }))
      return
    }
    if (packet.action === 'get_group_list') {
      if (groupListBehaviour === 'silent') return
      connection.send(JSON.stringify({ status: 'ok', retcode: 0, data: groupListPayload, echo: packet.echo }))
      return
    }
    /* 只有 16 号对照会走到这里（旧私聊发送路径） */
    connection.send(JSON.stringify({
      status: 'ok', retcode: 0, data: { message_id: ++nextMessageId }, echo: packet.echo,
    }))
  })
})

const settings = readQqPrivateConfig({
  QQ_OWNER_ID: OWNER,
  QQ_BOT_ID: BOT,
  QQ_ONEBOT_WS_URL: `ws://127.0.0.1:${port}/`,
  QQ_ONEBOT_ACCESS_TOKEN: 'offline-group-resolve-fixture-token-123456',
  /* ⚠️ 刻意**不开**多用户、也**不给**任何静态群名单：群列表读取不依赖它 */
  QQ_MULTI_USER_ENABLED: 'false',
})

type LogReading = { event: string; requestId?: string; messageId?: string | number; reason?: string }
const logs: LogReading[] = []
const client = new OneBotPrivateClient(
  settings,
  (async () => ({
    kind: 'TURN_RESULT', requestId: 'fixture', outcome: 'replied', replyText: '收到。', delivery: 'generated',
  })) as never,
  (reading) => logs.push(reading),
)

const captureError = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return 'NO_ERROR'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const waitFor = async (test: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (test()) return
    await delay(10)
  }
  throw new Error(`fixture_timeout:${label}`)
}

const cleanGroups = (count: number): unknown[] =>
  Array.from({ length: count }, (_, index) => ({ group_id: String(100000 + index), group_name: `群${index}` }))
const badIdGroups = (count: number): unknown[] =>
  Array.from({ length: count }, () => ({ group_id: 'not-a-group-id', group_name: '坏群号' }))

/** 夹具正常回包：数字群号 + 字符串群号混用，群名带前后空白（都应被 trim） */
const NORMAL_PAYLOAD: unknown[] = [
  { group_id: 123456789, group_name: ' 甲大学校友群 ' },
  { group_id: '234567890', group_name: '乙项目组' },
  { group_id: '345678901', group_name: '  丙大学校友群  ' },
]
/** 混入坏条目：每条坏法不同（采用 2 条、丢弃 8 条） */
const BAD_ENTRIES_PAYLOAD: unknown[] = [
  { group_id: 123456789, group_name: ' 甲大学校友群 ' },      // 采用（数字群号 + 空白）
  null,                                                       // not_object
  'not-an-object',                                            // not_object
  { group_id: 'abc', group_name: '坏群号' },                  // bad_group_id
  { group_id: 1234, group_name: '群号太短' },                 // bad_group_id
  { group_id: '234567890', group_name: 'x'.repeat(65) },      // bad_group_name（超 64 码点）
  { group_id: '234567890', group_name: '乙项目组' },          // 采用
  { group_id: '234567890', group_name: '乙项目组别名' },       // duplicate_group_id
  { group_id: '345678901', group_name: '   ' },               // bad_group_name（trim 后为空）
  { group_id: '456789012' },                                  // bad_group_name（非字符串）
]

/* ------------------------------------------------------------------------- */
/* 阶段 A：夹具读数（先只做"读"，再逐项断言；02 的负控要用**累计**读数）        */
/* ------------------------------------------------------------------------- */
const readings: Record<string, unknown> = {}

const injectPrivateMessage = (text: string): void => {
  const connection = connections.at(-1)
  if (connection === undefined) throw new Error('fixture_no_connection')
  privateMessageId += 1
  connection.send(JSON.stringify({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: BOT,
    user_id: OWNER, sender: { user_id: OWNER }, message_id: privateMessageId,
    message: [{ type: 'text', data: { text } }],
  }))
}

let neverConnectedCode = 'NOT_RUN'
let afterCloseCode = 'NOT_RUN'

try {
  await client.connect()

  /* --- A1：正常回包（01） ------------------------------------------------- */
  groupListPayload = NORMAL_PAYLOAD
  readings.normalList = await client.listGroups()
  readings.getGroupListActions = packets.filter((packet) => packet.action === 'get_group_list').length

  /* --- A2：有界（03） ----------------------------------------------------- */
  groupListPayload = cleanGroups(200)
  readings.exactly200 = ((await client.listGroups()) as readonly QqGroupListEntry[]).length
  groupListPayload = cleanGroups(201)
  readings.tooMany201 = await captureError(() => client.listGroups())
  /* raw 口径：201 条原始回包里只有 1 条能被清理出来，仍然必须是"太大" */
  groupListPayload = [...cleanGroups(1), ...badIdGroups(200)]
  readings.tooManyRawWithOneUsable = await captureError(() => client.listGroups())

  /* --- A3：坏条目（04） --------------------------------------------------- */
  groupListPayload = BAD_ENTRIES_PAYLOAD
  const dropLogsBefore = logs.length
  readings.badEntries = await client.listGroups()
  readings.badEntriesDrops = logs.slice(dropLogsBefore)
    .filter((entry) => entry.event === 'qq_group_list_entry_dropped')
    .map((entry) => entry.reason ?? '')
  readings.badEntriesSummary = logs.slice(dropLogsBefore)
    .find((entry) => entry.event === 'qq_group_list_read')?.reason ?? ''

  groupListPayload = [null, { group_id: 'abc' }, 'x']
  const allBadBefore = logs.length
  readings.allBadEntries = await client.listGroups()
  readings.allBadSummary = logs.slice(allBadBefore)
    .find((entry) => entry.event === 'qq_group_list_read')?.reason ?? ''

  /* 回包 `data` 不是数组 ⇒ 具名 invalid（05 的"具名错误"之外的形状失败） */
  groupListPayload = { groups: NORMAL_PAYLOAD }
  readings.nonArrayPayload = await captureError(() => client.listGroups())

  /* --- A4：只读负控快照（02）—— 取在**所有群列表读数之后**、旧路径对照之前 --- */
  readings.sendActionsDuringListPhase = packets
    .filter((packet) => packet.action === 'send_group_msg' || packet.action === 'send_private_msg').length
  readings.listPhaseActions = [...new Set(packets.map((packet) => packet.action))]

  /* --- A5：断线（05） ----------------------------------------------------- */
  groupListBehaviour = 'silent'
  const inFlight = captureError(() => client.listGroups())
  await delay(50)
  for (const socket of [...server.clients]) socket.terminate()
  readings.inFlightDisconnect = await inFlight
  groupListBehaviour = 'reply'

  {
    /* 从未连接过的外壳：`listGroups()` 不许返回空数组冒充成功 */
    const detached = new OneBotPrivateClient(settings, undefined, () => undefined)
    neverConnectedCode = await captureError(() => detached.listGroups())
  }
  readings.neverConnected = neverConnectedCode

  /* --- A6：重连 + 旧私聊路径对照（16） ------------------------------------ */
  await client.connect()
  readings.reconnected = client.connected
  groupListPayload = NORMAL_PAYLOAD
  readings.groupsAfterReconnect = ((await client.listGroups()) as readonly QqGroupListEntry[]).length
  const oldPathBefore = packets.length
  injectPrivateMessage('在吗')
  await waitFor(
    () => packets.slice(oldPathBefore).some((packet) => packet.action === 'send_private_msg'),
    'old-private-path',
  )
  await client.drain()
  readings.oldPathSend = packets.slice(oldPathBefore).find((packet) => packet.action === 'send_private_msg')

  /* --- A7：关闭后（05） --------------------------------------------------- */
  await client.close()
  afterCloseCode = await captureError(() => client.listGroups())
  readings.afterClose = afterCloseCode
} finally {
  try { await client.close() } catch { /* 夹具收尾：连接可能已经断了 */ }
  for (const connection of [...server.clients]) connection.terminate()
  await new Promise<void>((done) => server.close(() => done()))
}

/* ------------------------------------------------------------------------- */
/* 阶段 B：纯函数真值表（06–15）                                               */
/* ------------------------------------------------------------------------- */
const TABLE: readonly QqGroupListEntry[] = [
  { groupId: '11111111', groupName: '甲大学校友群' },
  { groupId: '22222222', groupName: '乙项目组' },
  { groupId: '33333333', groupName: '甲大学校友群' },      /* 与 11111111 精确同名 */
  { groupId: '44444444', groupName: '丙 大学 校友 群' },    /* 名字内**有**空白 */
  { groupId: '55555555', groupName: '甲大学研究生群' },
]
const resolveWith = (hint: QqGroupTargetHint, groups: readonly QqGroupListEntry[] = TABLE): unknown =>
  resolveGroupTarget({ hint, groups })
const resolvedOf = (groupId: string, groupName: string): unknown =>
  ({ kind: 'resolved', groupId, groupName })

/* 02 的结构化负控：去掉注释后再扫，避免"文档里写了不许"被误当成代码 */
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/* ========================================================================= */
await check('01 get_group_list 走真实 socket；回包群号统一成 string 且逐个过 qqId', () => {
  assert.equal(readings.getGroupListActions !== undefined
    && (readings.getGroupListActions as number) >= 1, true, '假 OneBot 没收到 get_group_list')
  assert.equal((readings.listPhaseActions as string[]).includes('get_group_list'), true)
  const normal = readings.normalList as readonly QqGroupListEntry[]
  assert.deepEqual(normal, [
    { groupId: '123456789', groupName: '甲大学校友群' },
    { groupId: '234567890', groupName: '乙项目组' },
    { groupId: '345678901', groupName: '丙大学校友群' },
  ])
  /* 数字群号（123456789）与字符串群号（'234567890'）都被统一成 string */
  assert.equal(typeof NORMAL_PAYLOAD[0] !== 'object', false)
  assert.equal(String((NORMAL_PAYLOAD[0] as { group_id: unknown }).group_id), normal[0]!.groupId)
  assert.equal(typeof (NORMAL_PAYLOAD[0] as { group_id: unknown }).group_id, 'number')
  assert.equal(typeof (NORMAL_PAYLOAD[1] as { group_id: unknown }).group_id, 'string')
  assert.equal(normal.every((entry) => typeof entry.groupId === 'string'), true)
  assert.equal(normal.every((entry) => qqId(entry.groupId) === entry.groupId), true, '有群号没过 qqId')
  assert.equal(normal.every((entry) => entry.groupName === entry.groupName.trim()), true, '群名没 trim')
})

/* ========================================================================= */
await check('02 ★ 只读负控：解析链全程假 OneBot 收到 0 条发送 action；纯消歧模块不含放行标识符', () => {
  assert.equal(readings.sendActionsDuringListPhase, 0,
    `群列表读数阶段竟然发出过消息：${String(readings.sendActionsDuringListPhase)} 条`)
  /* 这段读数期间只允许这两个只读/握手 action */
  assert.deepEqual((readings.listPhaseActions as string[]).sort(), ['get_group_list', 'get_login_info'])
  /*
   * 纯消歧模块的**代码**（去注释后）里不许出现群名单/成员核验/发送 action；
   * 也不许 import 除 `qqId` 之外的任何东西 —— "消歧 ≠ 授权"要能被静态判据守住。
   */
  const source = readFileSync(resolve(ROOT, 'src/infrastructure/qq/group-directory.ts'), 'utf8')
  const code = stripComments(source)
  for (const forbidden of ['allowedGroupIds', 'multiUserEnabled', 'isAllowedUser', 'send_group_msg', 'send_private_msg']) {
    assert.equal(code.includes(forbidden), false, `消歧模块的代码里出现了 ${forbidden}`)
  }
  const imports = [...code.matchAll(/from '([^']+)'/gu)].map((match) => match[1])
  assert.deepEqual(imports, ['./private-config.ts'], `消歧模块 import 了别的东西：${JSON.stringify(imports)}`)
})

/* ========================================================================= */
await check('03 有界：200 个群接受、201 个群具名拒绝；上限按回包原始条数（清理前）计', () => {
  assert.equal(QQ_GROUP_LIST_LIMITS.maxGroups, 200)
  assert.equal(readings.exactly200, 200, '200 个群应当被接受')
  assert.equal(readings.tooMany201, 'qq_group_list_too_large')
  /* 201 条原始回包里只有 1 条可清理 ⇒ 仍然"太大"（证明是 raw 口径，不是清理后口径） */
  assert.equal(readings.tooManyRawWithOneUsable, 'qq_group_list_too_large')
  assert.equal(logs.some((entry) => entry.event === 'qq_group_list_failed'
    && (entry.reason ?? '').startsWith('qq_group_list_too_large')), true, '超大回包没有留读数')
})

/* ========================================================================= */
await check('04 非对象/坏群号/超长群名/重复群号 ⇒ 整条丢弃并计入读数；非数组回包 ⇒ 具名 invalid', () => {
  assert.deepEqual(readings.badEntries, [
    { groupId: '123456789', groupName: '甲大学校友群' },
    { groupId: '234567890', groupName: '乙项目组' },
  ])
  assert.deepEqual(readings.badEntriesDrops, [
    'not_object', 'not_object',
    'bad_group_id', 'bad_group_id',
    'bad_group_name',
    'duplicate_group_id',
    'bad_group_name', 'bad_group_name',
  ])
  assert.equal(readings.badEntriesSummary, 'raw=10;groups=2;dropped=8')
  /* 全部坏条目 ⇒ 空列表 + 逐条读数（不是"静默成功"、也不是抛错冒充"没有群"） */
  assert.deepEqual(readings.allBadEntries, [])
  assert.equal(readings.allBadSummary, 'raw=3;groups=0;dropped=3')
  assert.equal(readings.nonArrayPayload, 'qq_group_list_invalid')
})

/* ========================================================================= */
await check('05 断线 ⇒ 具名错误：未连接 / 在途断线 / 关闭后三种，都不返回空数组', () => {
  assert.equal(readings.neverConnected, 'onebot_not_connected')
  assert.equal(readings.inFlightDisconnect, 'onebot_disconnected')
  assert.equal(readings.afterClose, 'onebot_not_connected')
  assert.equal(logs.filter((entry) => entry.event === 'qq_group_list_failed'
    && entry.reason === 'onebot_not_connected').length >= 1, true, '未连接失败没有留读数')
})

/* ========================================================================= */
await check('06 精确群号命中 ⇒ resolved（群名取自列表，不采信提示）', () => {
  const resolved = resolveWith({ groupId: '22222222' })
  assert.deepEqual(resolved, resolvedOf('22222222', '乙项目组'))
  /* 前后空白归一后再比 */
  assert.deepEqual(resolveWith({ groupId: '  22222222  ' }), resolvedOf('22222222', '乙项目组'))
  /* 数字形状的提示群号也认（入参允许 string | number 的字符串化） */
  assert.deepEqual(resolveWith({ groupId: String(55555555) }), resolvedOf('55555555', '甲大学研究生群'))
  /* resolved 出来的群号一定过 qqId（消歧出口不放行坏群号） */
  const allResolved = [resolveWith({ groupId: '11111111' }), resolveWith({ groupId: '44444444' })] as {
    groupId: string
  }[]
  assert.equal(allResolved.every((entry) => qqId(entry.groupId) === entry.groupId), true)
})

/* ========================================================================= */
await check('07 群号不在列表 ⇒ not_found（即使名字命中别的群，也不改判成按名字找）', () => {
  assert.deepEqual(resolveWith({ groupId: '99999999' }), { kind: 'not_found' })
  assert.deepEqual(resolveWith({ groupId: '99999999', nameHint: '乙项目组' }), { kind: 'not_found' })
})

/* ========================================================================= */
await check('08 精确同名唯一 ⇒ resolved', () => {
  assert.deepEqual(resolveWith({ nameHint: '乙项目组' }), resolvedOf('22222222', '乙项目组'))
  assert.deepEqual(resolveWith({ nameHint: '  乙项目组  ' }), resolvedOf('22222222', '乙项目组'))
  /* 精确同名命中 55555555 的是"甲大学研究生群"，它的名字里**包含**别的提示名 ⇒ 不该被包含匹配抢走 */
  assert.deepEqual(resolveWith({ nameHint: '甲大学研究生群' }), resolvedOf('55555555', '甲大学研究生群'))
})

/* ========================================================================= */
await check('09 精确同名多个 ⇒ ambiguous；候选按群号升序稳定（与输入顺序无关）', () => {
  const expected = {
    kind: 'ambiguous',
    candidates: [
      { groupId: '11111111', groupName: '甲大学校友群' },
      { groupId: '33333333', groupName: '甲大学校友群' },
    ],
  }
  assert.deepEqual(resolveWith({ nameHint: '甲大学校友群' }), expected)
  /* 输入顺序反过来，候选仍是群号升序 */
  assert.deepEqual(
    resolveWith({ nameHint: '甲大学校友群' }, [TABLE[2]!, TABLE[0]!, TABLE[1]!]),
    expected,
  )
  /* 精确阶段不许把"包含它的别的群"带进候选 */
  assert.equal(
    (resolveWith({ nameHint: '甲大学校友群' }) as { candidates: QqGroupListEntry[] }).candidates
      .some((entry) => entry.groupId === '55555555'), false,
  )
})

/* ========================================================================= */
await check('10 名字含空白 / 前后空白归一后命中（不因为多敲空格就 not_found）', () => {
  assert.deepEqual(resolveWith({ nameHint: '   乙项目组 ' }), resolvedOf('22222222', '乙项目组'))
  /* 内部空白差异：精确阶段不等 ⇒ 退到"去空白后包含"，仍精确命中同一个群 */
  assert.deepEqual(resolveWith({ nameHint: '丙 大学  校友 群' }), resolvedOf('44444444', '丙 大学 校友 群'))
  assert.deepEqual(resolveWith({ nameHint: '丙大学校友群' }), resolvedOf('44444444', '丙 大学 校友 群'))
  /* 群名里的空白被去掉后仍与提示全等/包含 ⇒ 唯一 */
  assert.deepEqual(resolveWith({ nameHint: ' 丙大学 校友群 ' }), resolvedOf('44444444', '丙 大学 校友 群'))
})

/* ========================================================================= */
await check('11 包含匹配唯一 ⇒ resolved', () => {
  assert.deepEqual(resolveWith({ nameHint: '研究生' }), resolvedOf('55555555', '甲大学研究生群'))
  assert.deepEqual(resolveWith({ nameHint: '校友群' }), {
    kind: 'ambiguous',
    candidates: [
      { groupId: '11111111', groupName: '甲大学校友群' },
      { groupId: '33333333', groupName: '甲大学校友群' },
      { groupId: '44444444', groupName: '丙 大学 校友 群' },
    ],
  })
})

/* ========================================================================= */
await check('12 包含匹配多个 ⇒ ambiguous（候选按群号升序稳定）', () => {
  const expected = {
    kind: 'ambiguous',
    candidates: [
      { groupId: '11111111', groupName: '甲大学校友群' },
      { groupId: '33333333', groupName: '甲大学校友群' },
      { groupId: '55555555', groupName: '甲大学研究生群' },
    ],
  }
  assert.deepEqual(resolveWith({ nameHint: '甲大学' }), expected)
  assert.deepEqual(resolveWith({ nameHint: '甲 大学' }), expected)
})

/* ========================================================================= */
await check('13 零命中 ⇒ not_found（不猜、不返回空候选）', () => {
  assert.deepEqual(resolveWith({ nameHint: '不存在的群名' }), { kind: 'not_found' })
  assert.deepEqual(resolveWith({ nameHint: '乙项目组⑨' }), { kind: 'not_found' })
  assert.deepEqual(resolveWith({ nameHint: '丙大学校友群②' }), { kind: 'not_found' })
})

/* ========================================================================= */
await check('14 群号与名字矛盾 ⇒ invalid / group_hint_conflict（一致时不误报）', () => {
  assert.equal(GROUP_TARGET_RESOLUTION_CODES.hintConflict, 'group_hint_conflict')
  assert.deepEqual(resolveWith({ groupId: '22222222', nameHint: '甲大学校友群' }),
    { kind: 'invalid', code: 'group_hint_conflict' })
  assert.deepEqual(resolveWith({ groupId: '11111111', nameHint: '乙项目组' }),
    { kind: 'invalid', code: 'group_hint_conflict' })
  /* 反例：一致时**不**误报矛盾（全等 + 包含两种一致都算指向同一个群） */
  assert.deepEqual(resolveWith({ groupId: '22222222', nameHint: '乙项目组' }),
    resolvedOf('22222222', '乙项目组'))
  assert.deepEqual(resolveWith({ groupId: '22222222', nameHint: '乙项' }),
    resolvedOf('22222222', '乙项目组'))
  /* 群号不在列表 ⇒ 仍是 07 的 not_found（矛盾判定只在"两个都指向列表里的群"时才有意义） */
  assert.deepEqual(resolveWith({ groupId: '99999999', nameHint: '甲大学校友群' }), { kind: 'not_found' })
})

/* ========================================================================= */
await check('15 空 hint / 坏群号 / 超长名字 ⇒ invalid 具名码（上限按码点计）', () => {
  assert.equal(GROUP_NAME_MAX_CODEPOINTS, 64)
  assert.deepEqual(resolveWith({}), { kind: 'invalid', code: 'group_hint_empty' })
  assert.deepEqual(resolveWith({ groupId: '   ', nameHint: '   ' }), { kind: 'invalid', code: 'group_hint_empty' })
  assert.deepEqual(resolveWith({ nameHint: '' }), { kind: 'invalid', code: 'group_hint_empty' })
  assert.deepEqual(resolveWith({ groupId: 'abc' }), { kind: 'invalid', code: 'group_hint_group_id_invalid' })
  assert.deepEqual(resolveWith({ groupId: '0123456789' }),
    { kind: 'invalid', code: 'group_hint_group_id_invalid' })
  /* 64 个码点本身合法（本条走到 not_found，不是 invalid）；65 个 ⇒ invalid */
  assert.deepEqual(resolveWith({ nameHint: 'x'.repeat(GROUP_NAME_MAX_CODEPOINTS) }), { kind: 'not_found' })
  assert.deepEqual(resolveWith({ nameHint: 'x'.repeat(GROUP_NAME_MAX_CODEPOINTS + 1) }),
    { kind: 'invalid', code: 'group_hint_name_too_long' })
  /* 码点口径：64 个 emoji = 128 个 UTF-16 单元，仍然合法 */
  assert.equal('😀'.repeat(GROUP_NAME_MAX_CODEPOINTS).length, 128)
  assert.deepEqual(resolveWith({ nameHint: '😀'.repeat(GROUP_NAME_MAX_CODEPOINTS) }), { kind: 'not_found' })
  assert.deepEqual(resolveWith({ nameHint: '😀'.repeat(GROUP_NAME_MAX_CODEPOINTS + 1) }),
    { kind: 'invalid', code: 'group_hint_name_too_long' })
})

/* ========================================================================= */
await check('16 旧私聊发送路径逐字不变：listGroups 不占发送队列，旧回复仍走 send_private_msg', () => {
  assert.equal(readings.reconnected, true)
  assert.equal(readings.groupsAfterReconnect, 3)
  const oldSend = readings.oldPathSend as FixturePacket | undefined
  if (oldSend === undefined) throw new Error('旧私聊路径没有发出回复')
  assert.equal(oldSend.action, 'send_private_msg')
  assert.equal(String(oldSend.params.user_id), OWNER)
  assert.equal(oldSend.params.group_id, undefined, '私聊发送不该带群号')
  assert.deepEqual(oldSend.params.message, [{ type: 'text', data: { text: '收到。' } }])
  /* 只读快照（02）与旧路径发出（16）分开：前者 0 条，后者恰好 1 条 */
  assert.equal(readings.sendActionsDuringListPhase, 0)
  assert.equal(packets.filter((packet) => packet.action === 'send_private_msg').length, 1)
  assert.equal(packets.filter((packet) => packet.action === 'send_group_msg').length, 0)
})

/* ------------------------------------------------------------------------- */
/* 证据 + 退出码（失败计数非零 ⇒ 非零退出）                                     */
/* ------------------------------------------------------------------------- */
const passed = checks.length
const total = passed + failures.length
const ranAt = new Date().toISOString()
mkdirSync(evidenceRoot, { recursive: true })
writeFileSync(resolve(evidenceRoot, 'result.json'), `${JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checks: total,
  passed,
  failed: failures.length,
  failures,
  controls: checks,
  ranAt,
  node: process.version,
  readings: {
    normalList: readings.normalList,
    exactly200: readings.exactly200,
    tooMany201: readings.tooMany201,
    tooManyRawWithOneUsable: readings.tooManyRawWithOneUsable,
    badEntries: readings.badEntries,
    badEntriesDrops: readings.badEntriesDrops,
    badEntriesSummary: readings.badEntriesSummary,
    allBadEntries: readings.allBadEntries,
    allBadSummary: readings.allBadSummary,
    nonArrayPayload: readings.nonArrayPayload,
    neverConnected: readings.neverConnected,
    inFlightDisconnect: readings.inFlightDisconnect,
    afterClose: readings.afterClose,
    sendActionsDuringListPhase: readings.sendActionsDuringListPhase,
    listPhaseActions: readings.listPhaseActions,
    oldPathSend: readings.oldPathSend,
    limits: { maxGroups: QQ_GROUP_LIST_LIMITS.maxGroups, maxGroupNameCodepoints: GROUP_NAME_MAX_CODEPOINTS },
    resolutionCodes: GROUP_TARGET_RESOLUTION_CODES,
  },
  boundary: {
    database: 'NOT_OPENED',
    network: 'LOCAL_LOOPBACK_ONLY',
    realOneBot: 'FAKE_WS_FIXTURE_ONLY',
    realQq: 'NOT RUN',
    realModel: 'NONE',
    authorization: 'NOT_EXERCISED —— 消歧不判授权；本门不让任何群消息发出',
    notProven: '真机 LLBot/PMHQ 的 get_group_list 回包字段与形状；真实群名长度分布与重名情况'
      + '（真值表是合成的）；任务授权与准入判定（P2.1 装配不在本批）；真机断线重连时序；真实 QQ 送达',
  },
}, null, 2)}\n`)

console.log('')
if (failures.length === 0) {
  console.log(`PASS: QQ 群目标消歧链（P2.1-A，${String(passed)}/${String(total)} 项）\n${evidenceRoot}`)
} else {
  console.log(`FAIL: QQ 群目标消歧链（P2.1-A，${String(passed)}/${String(total)} 项通过）`)
  console.log(`未通过：\n${failures.map((name) => `  · ${name}`).join('\n')}`)
  console.log(evidenceRoot)
  process.exitCode = 1
}
console.log(JSON.stringify({ checks: total, passed, failed: failures.length, ranAt }))
