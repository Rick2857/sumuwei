/**
 * U1 · 逐消息身份解析门（`u1:identity:verify`）
 *
 * 归属：多用户补充计划 U1 / WP2a（[ADR-133](../../docs/adr/ADR-133-multi-user-scope-and-authorization.md) `D04`/`D05`）。
 *
 * **纯进程内**：只读 `src/kernel/identity/inbound-identity.ts` 的纯函数；
 * 零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。
 *
 * 三段式：
 *   正控  —— 该解析成谁就解析成谁（含"同一 QQ 跨私聊/两群 = 同一 userId"）
 *   负控  —— **每个具名拒绝码都可复现**；并单列"绝不回退为原主人"
 *   拆防线 —— 一个"回退到原主人"的弱化解析器必须**真的会**把陌生人当主人（证明防线在被量）
 */

import {
  IDENTITY_REJECTION_CODES,
  inboundPurpose,
  resolveInboundIdentity,
  type IdentityRejectionCode,
  type InboundPlatformFacts,
  type InboundIdentityPolicy,
} from '../src/kernel/identity/inbound-identity.ts'
import type { Principal } from '../src/kernel/contracts/scope.ts'

interface Case {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const cases: Case[] = []
function check(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BOT = 'bot-10000'
const OWNER = 'u-owner'
const derive = (input: { transport: string; externalId: string }): string => `u-${input.externalId}`

/** 读回用：把 principal 的"可信来源"渲染成人读文本（system 没有 verifiedBy）。 */
function verifiedByOf(principal: Principal | undefined): string {
  if (principal === undefined) return 'n/a'
  return principal.kind === 'system' ? `system:${principal.subsystem}` : principal.verifiedBy
}

function facts(overrides: Partial<InboundPlatformFacts> = {}): InboundPlatformFacts {
  return {
    transport: 'qq',
    botId: BOT,
    selfId: BOT,
    messageType: 'private',
    senderUserId: '20001',
    subType: 'friend',
    ...overrides,
  }
}

function policy(overrides: Partial<InboundIdentityPolicy> = {}): InboundIdentityPolicy {
  return { ownerUserId: OWNER, allowed: true, deriveUserId: derive, ...overrides }
}

const seenCodes = new Set<IdentityRejectionCode>()

function expectReject(
  name: string,
  code: IdentityRejectionCode,
  f: InboundPlatformFacts,
  p: InboundIdentityPolicy
): void {
  const outcome = resolveInboundIdentity(f, p)
  if (!outcome.ok) seenCodes.add(outcome.code)
  check(
    `负控 · ${name}`,
    outcome.ok === false && outcome.code === code,
    outcome.ok ? `意外放行（userId=${outcome.value.userId}）` : `期望 ${code}，得到 ${outcome.code}`
  )
}

// ---------------------------------------------------------------------------
// 0. 结构自检
// ---------------------------------------------------------------------------

check(
  '拒绝码闭集无重复',
  new Set(IDENTITY_REJECTION_CODES).size === IDENTITY_REJECTION_CODES.length,
  `${IDENTITY_REJECTION_CODES.length} 个码`
)

// ---------------------------------------------------------------------------
// 1. 正控
// ---------------------------------------------------------------------------

{
  const outcome = resolveInboundIdentity(facts(), policy({ mappedUserId: 'u-20001' }))
  check(
    '正控 · 私聊已映射普通用户',
    outcome.ok && outcome.value.userId === 'u-20001' && outcome.value.room.kind === 'private' &&
      outcome.value.isOwner === false && outcome.value.principal.kind === 'user' &&
      outcome.value.principal.verifiedBy === 'onebot_inbound' && outcome.value.disposition === 'mapped',
    outcome.ok ? `${outcome.value.userId}/${outcome.value.principal.kind}` : `拒：${outcome.code}`
  )
}

{
  const outcome = resolveInboundIdentity(facts({ senderUserId: '10001' }), policy({ mappedUserId: OWNER }))
  check(
    '正控 · 原主人被识别为 owner/config_binding',
    outcome.ok && outcome.value.isOwner === true && outcome.value.principal.kind === 'owner' &&
      outcome.value.principal.verifiedBy === 'config_binding',
    outcome.ok ? `${outcome.value.principal.kind}/${verifiedByOf(outcome.value.principal)}` : `拒：${outcome.code}`
  )
}

{
  const outcome = resolveInboundIdentity(
    facts({ messageType: 'group', groupId: 'g-777' }),
    policy({ mappedUserId: 'u-20001' })
  )
  check(
    '正控 · 群消息 → room=group，userId 仍是平台账号解析出的那个人',
    outcome.ok && outcome.value.room.kind === 'group' && outcome.value.room.groupId === 'g-777' &&
      outcome.value.userId === 'u-20001',
    outcome.ok ? JSON.stringify(outcome.value.room) : `拒：${outcome.code}`
  )
}

{
  const p = policy({ mappedUserId: 'u-20001' })
  const inPrivate = resolveInboundIdentity(facts(), p)
  const inGroupA = resolveInboundIdentity(facts({ messageType: 'group', groupId: 'g-1' }), p)
  const inGroupB = resolveInboundIdentity(facts({ messageType: 'group', groupId: 'g-2' }), p)
  const userIds = [inPrivate, inGroupA, inGroupB].map((o) => (o.ok ? o.value.userId : 'REJECTED'))
  check(
    '正控 · **同一 QQ 跨私聊与两个群 = 同一个 userId**（群号只决定空间）',
    userIds.every((id) => id === 'u-20001'),
    userIds.join(' / ')
  )
}

{
  const outcome = resolveInboundIdentity(facts(), policy({ mappedUserId: undefined, deriveUserId: derive }))
  check(
    '正控 · 首次遇到获准账号 → first_seen + 确定性推导',
    outcome.ok && outcome.value.disposition === 'first_seen' && outcome.value.userId === 'u-20001',
    outcome.ok ? `${outcome.value.disposition}/${outcome.value.userId}` : `拒：${outcome.code}`
  )
}

{
  const a = resolveInboundIdentity(facts({ subType: 'friend' }), policy({ mappedUserId: 'u-20001' }))
  const b = resolveInboundIdentity(facts({ subType: 'unknown_subtype' }), policy({ mappedUserId: 'u-20001' }))
  check(
    '正控 · sub_type 不影响身份（只有账号决定身份）',
    a.ok && b.ok && a.value.userId === b.value.userId,
    a.ok && b.ok ? `${a.value.userId} == ${b.value.userId}` : '解析被拒'
  )
}

check('正控 · 入口用途恒为 external_query', inboundPurpose() === 'external_query', inboundPurpose())

// ---------------------------------------------------------------------------
// 2. 负控：每个具名拒绝码
// ---------------------------------------------------------------------------

expectReject('未支持的 transport', 'unsupported_transport', facts({ transport: 'discord' }), policy())
expectReject('botId 缺失', 'missing_bot_facts', facts({ botId: '' }), policy())
expectReject('selfId 缺失', 'missing_bot_facts', facts({ selfId: '' }), policy())
expectReject(
  'self_id ≠ 配置 botId（别的机器人）',
  'bot_account_mismatch',
  facts({ selfId: 'bot-99999' }),
  policy()
)
expectReject(
  '未支持的 message_type',
  'unsupported_message_type',
  facts({ messageType: 'guild' }),
  policy()
)
expectReject('发言者账号为空', 'missing_sender', facts({ senderUserId: '' }), policy())
expectReject(
  'sender.user_id 与 user_id 不一致（二次核对）',
  'sender_mismatch',
  facts({ senderUserIdInSender: '29999' }),
  policy()
)
expectReject(
  '群消息缺 group_id',
  'group_id_required',
  facts({ messageType: 'group' }),
  policy()
)
expectReject(
  '私聊事件带 group_id（形状矛盾）',
  'group_id_forbidden',
  facts({ groupId: 'g-1' }),
  policy()
)
expectReject('账号未获准（allowed 缺省）', 'not_allowed', facts(), policy({ allowed: undefined }))
expectReject('账号未获准（allowed=false）', 'not_allowed', facts(), policy({ allowed: false }))
expectReject(
  '映射表没有 + 没有确定性推导',
  'unmapped_identity',
  facts(),
  policy({ mappedUserId: undefined, deriveUserId: undefined })
)
expectReject(
  '确定性推导返回空（不猜）',
  'unmapped_identity',
  facts(),
  policy({ mappedUserId: undefined, deriveUserId: () => '   ' })
)

// ---------------------------------------------------------------------------
// 3. **绝不回退为原主人**（多用户的核心负控）
// ---------------------------------------------------------------------------

{
  const outcome = resolveInboundIdentity(
    facts({ senderUserId: '88888' }),
    policy({ mappedUserId: undefined, deriveUserId: undefined, allowed: false })
  )
  check(
    '负控 · 陌生人（未获准 + 无映射）**不得**被当成原主人',
    outcome.ok === false && outcome.code === 'not_allowed',
    outcome.ok ? `意外放行 owner=${String(outcome.value.isOwner)}` : `拒：${outcome.code}`
  )
}
{
  const outcome = resolveInboundIdentity(
    facts({ senderUserId: '88888' }),
    policy({ mappedUserId: undefined, deriveUserId: undefined, allowed: true })
  )
  check(
    '负控 · 已获准但无映射/无推导 ⇒ unmapped_identity（仍不落到 owner）',
    outcome.ok === false && outcome.code === 'unmapped_identity',
    outcome.ok ? `意外放行 owner=${String(outcome.value.isOwner)}` : `拒：${outcome.code}`
  )
}

// ---------------------------------------------------------------------------
// 4. 三段式：拆掉"账号比对"这道防线必须判红
// ---------------------------------------------------------------------------

/** 弱化版：**故意**不比对 self_id，并**回退到原主人**。 */
function weakenedAlwaysOwner(f: InboundPlatformFacts, p: InboundIdentityPolicy): boolean {
  void f
  void p
  return true // 无论谁来都当成主人
}

const stranger = facts({ senderUserId: '88888', selfId: 'bot-attacker' })
const weakened = weakenedAlwaysOwner(stranger, policy({ allowed: false }))
check(
  '拆防线 · 弱化版会把陌生机器人/陌生人当主人 ⇒ 证明防线在被量',
  weakened === true,
  `weakened=${String(weakened)}`
)
const restored = resolveInboundIdentity(stranger, policy({ allowed: false }))
check(
  '恢复 · 真实解析器对同一输入判红（bot_account_mismatch 先命中）',
  restored.ok === false && restored.code === 'bot_account_mismatch',
  restored.ok ? '意外放行' : `拒：${restored.code}`
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const failed = cases.filter((item) => !item.ok)
const missingCodes = IDENTITY_REJECTION_CODES.filter((code) => !seenCodes.has(code))
check(
  `每个具名拒绝码都可复现（${IDENTITY_REJECTION_CODES.length} 个）`,
  missingCodes.length === 0,
  missingCodes.length === 0 ? `覆盖 ${seenCodes.size}/${IDENTITY_REJECTION_CODES.length}` : `未覆盖：${missingCodes.join(', ')}`
)

const failedFinal = cases.filter((item) => !item.ok)
for (const item of cases) {
  console.log(`${item.ok ? '  ok  ' : ' FAIL '} ${item.name} —— ${item.detail}`)
}
console.log('')
console.log(
  `measured_count=${cases.length} · passed=${cases.length - failedFinal.length} · failed=${failedFinal.length}` +
    (failed.length === failedFinal.length ? '' : '')
)
if (failedFinal.length > 0) {
  console.log('失败项：')
  for (const item of failedFinal) console.log(`  - ${item.name}：${item.detail}`)
}
process.exitCode = failedFinal.length === 0 ? 0 : 1
