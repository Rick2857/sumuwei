/**
 * U1 / `ADR-139` `D01`+`D04`：**桥上的入站平台事实**（受控登记表里那一格）。
 *
 * ============================================================================
 *  这个门守什么（用户 2026-10-14 裁定 `R-139-1`/`R-139-2` = ①）
 * ============================================================================
 * ```text
 * ① 形状判据**闭集**：未知键 / 空串 / 未知 transport / messageType 与 groupId 不匹配 ⇒ 具名拒绝
 * ② **只**严格校验这一格：别的未知字段照旧容忍（把容忍改成拒绝是未被要求的收紧 = 回归）
 * ③ **缺席 = 逐字旧行为**：不解析、不加键、不拒绝
 * ④ 非法 ⇒ **整轮具名拒绝**，且 **host.runTurn 一次都不跑**（失败关闭：不产生轮次）
 * ⑤ 合法 ⇒ 原样转交（本门只证"事实到达了 submit 那一层"；
 *    "谁来消费它、怎么算 scope" 是核心侧接线，属下一包）
 * ```
 * ⚠️ 本门**不**主张：非原主人私聊已开放（`R-139-3` = ①，本切片 owner-only）；
 *    也**不**主张入口/授权语义（那是 `u1:entry-scope` / `u1:scope` / `u1:gateway-scope` 的事）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TurnBridge,
  platformFactsProblems,
  type BridgeInboundPlatformFacts,
  type TurnBridgeHost,
} from '../src/kernel/app/bridge/turn-bridge.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}
/** 正控/负控/恢复的通用断言：判据码必须**逐字**等于期望值 */
const expectProblem = (name: string, value: unknown, expected: string | undefined): void => {
  const actual = platformFactsProblems(value)
  check(name, actual === expected, `期望 ${expected ?? '(合法)'}，实际 ${actual ?? '(合法)'}`)
}

// ---------------------------------------------------------------------------
// 1. 形状判据（正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------

const privateFacts: BridgeInboundPlatformFacts = {
  transport: 'qq', selfId: '987654321', senderUserId: '123456789', messageType: 'private',
}
const groupFacts: BridgeInboundPlatformFacts = {
  transport: 'qq', selfId: '987654321', senderUserId: '123456789', messageType: 'group', groupId: '12345',
}

expectProblem('正控 合法 private ⇒ 合法', privateFacts, undefined)
expectProblem('正控 合法 group（带 groupId）⇒ 合法', groupFacts, undefined)

expectProblem('负控 多一个未知键 ⇒ 整条作废', { ...privateFacts, extra: 'x' }, 'bridge_bad_platform_facts_key')
expectProblem('负控 transport 不在闭集', { ...privateFacts, transport: 'discord' }, 'bridge_bad_platform_facts_transport')
expectProblem('负控 selfId 空串', { ...privateFacts, selfId: '   ' }, 'bridge_bad_platform_facts_self')
expectProblem('负控 senderUserId 空串', { ...privateFacts, senderUserId: '' }, 'bridge_bad_platform_facts_sender')
expectProblem('负控 messageType 未知', { ...privateFacts, messageType: 'channel' }, 'bridge_bad_platform_facts_message_type')
expectProblem('负控 private 却带 groupId', { ...privateFacts, groupId: '12345' }, 'bridge_bad_platform_facts_group')
expectProblem('负控 group 缺 groupId', { transport: 'qq', selfId: '1', senderUserId: '2', messageType: 'group' }, 'bridge_bad_platform_facts_group')
expectProblem('负控 group 的 groupId 是空串', { ...groupFacts, groupId: '  ' }, 'bridge_bad_platform_facts_group')
expectProblem('负控 null', null, 'bridge_bad_platform_facts')
expectProblem('负控 数组', [], 'bridge_bad_platform_facts')
expectProblem('负控 字符串', 'qq', 'bridge_bad_platform_facts')

// 恢复：把刚被拒的那条**只改回**它出错的那一处 ⇒ 同一函数判合法
const withExtra: Record<string, unknown> = { ...privateFacts, extra: 'x' }
expectProblem('负控（恢复组前置）多一个未知键 ⇒ 拒', withExtra, 'bridge_bad_platform_facts_key')
delete withExtra.extra
expectProblem('恢复 去掉那个未知键 ⇒ 合法', withExtra, undefined)
expectProblem('恢复 未知键真的去掉后 ⇒ 合法', { transport: 'qq', selfId: '1', senderUserId: '2', messageType: 'private' }, undefined)
expectProblem('恢复 group 补上 groupId ⇒ 合法', { transport: 'qq', selfId: '1', senderUserId: '2', messageType: 'group', groupId: '9' }, undefined)

// ---------------------------------------------------------------------------
// 2. 接线（结构，锚点级：**判据只落在结构上**，不按词找）
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(ROOT, 'src/kernel/app/bridge/turn-bridge.ts'), 'utf8')
const wireBlock = source.slice(source.indexOf('export interface BridgeWireRequest'), source.indexOf('export interface BridgeWireResponse'))
check('接线 BridgeWireRequest 登记了 platformFacts（可选）',
  /platformFacts\?: BridgeInboundPlatformFacts/.test(wireBlock), wireBlock.includes('platformFacts') ? '字段在场' : '字段缺失')
const submitBlock = source.slice(source.indexOf('export interface BridgeSubmitRequest'), source.indexOf('export interface BridgeSubmitResult'))
check('接线 BridgeSubmitRequest 带 platformFacts（可选）',
  /platformFacts\?: BridgeInboundPlatformFacts/.test(submitBlock), submitBlock.includes('platformFacts') ? '字段在场' : '字段缺失')

const validateBlock = source.slice(source.indexOf('private validate(request: BridgeSubmitRequest)'), source.indexOf('private remember(requestId: string'))
check('接线 validate() 真的调用 platformFactsProblems（不是只在注释里提）',
  /platformFactsProblems\(facts\)/.test(validateBlock), 'validate 体内应有该调用')
check('D04 边界：validate() 仍以 imageInputShapeError 收尾（没被这次改动挤掉）',
  /return imageInputShapeError\(request\.images\)/.test(validateBlock), '末尾 return 应在场')

const submitSite = source.slice(source.indexOf('const submitPlatformFacts'), source.indexOf('kind: \'TURN_RESULT\'', source.indexOf('const submitPlatformFacts')))
check('接线 解析处**原样转交** facts 给 submit', /platformFacts: submitPlatformFacts as BridgeInboundPlatformFacts/.test(submitSite), '转交语句在场')
check('D03 缺席 ⇒ **不加这个键**', /submitPlatformFacts === undefined\s*\?\s*\{\}/.test(submitSite), '缺席分支在场')

// ---------------------------------------------------------------------------
// 3. 行为（真 `TurnBridge` + 桩 host：合法放行 / 非法拒绝且不跑轮次 / 缺席照旧）
// ---------------------------------------------------------------------------

const ran: string[] = []
const host: TurnBridgeHost = {
  characterId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
  runTurn: async (input) => {
    ran.push(input.requestId)
    /* ⚠️ `HostTurnResult` 的必填字段一个都不能少（少了会被桥如实判 failed —— 实测踩到过） */
    return {
      replyText: '好', replyId: `r-${input.requestId}`, traceId: `t-${input.requestId}`, domainEventIds: [],
    }
  },
} as TurnBridgeHost
const bridge = new TurnBridge({ host })

const legal = await bridge.submit({ requestId: 'facts-legal', userText: '你好', platformFacts: privateFacts })
check('行为 合法 facts ⇒ 真的回了（不是 rejected/failed）', legal.outcome === 'replied', `outcome=${legal.outcome}${legal.code === undefined ? '' : ` code=${legal.code}`}`)
check('行为 合法 facts ⇒ host.runTurn 跑了一次', ran.includes('facts-legal'), `跑了 ${ran.length} 次`)

const before = ran.length
const illegalFacts = { ...privateFacts, groupId: '12345' }
const illegal = await bridge.submit({ requestId: 'facts-illegal', userText: '你好', platformFacts: illegalFacts })
check('行为 非法 facts ⇒ rejected', illegal.outcome === 'rejected', `outcome=${illegal.outcome}`)
check('行为 非法 facts ⇒ 具名码', illegal.code === 'bridge_bad_platform_facts_group', `code=${String(illegal.code)}`)
check('行为 非法 facts ⇒ **host.runTurn 一次都没跑**（失败关闭）', ran.length === before, `轮次计数 ${before} → ${ran.length}`)

const absent = await bridge.submit({ requestId: 'facts-absent', userText: '你好' })
check('行为 缺席 facts ⇒ 逐字旧行为（照常回）', absent.outcome === 'replied' && ran.includes('facts-absent'), `outcome=${absent.outcome}`)

/* ⚠️ 重发必须**连非法 facts 一起**重发（少带它就成了另一条合法请求 —— 第一版门就是这样自己骗自己的） */
const idempotent = await bridge.submit({ requestId: 'facts-illegal', userText: '你好', platformFacts: illegalFacts })
check('行为 重复提交同一条非法 facts ⇒ 仍拒绝', idempotent.outcome === 'rejected' && idempotent.code === 'bridge_bad_platform_facts_group', `outcome=${idempotent.outcome} code=${String(idempotent.code)}`)
check('行为 重复提交非法 facts 不产生新轮次', ran.length === before + 1, `轮次计数 ${ran.length}（合法缺席那条 +1）`)

// ---------------------------------------------------------------------------
// 4. 汇总（失败关闭）
// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(
  `\nADR-139 平台事实：判据 ${checks.length} · 失败 ${failed.length} · ` +
    `measured_count=${checks.length}`
)
console.log('⚠️ 本门只证"这一格的形状与拒绝语义"：非原主人私聊（R-139-3 = ①）与核心侧 scope 接线不在本门。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
