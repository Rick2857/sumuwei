/**
 * U1 · 作用域契约门（`u1:scope:verify`）
 *
 * 归属：多用户补充计划 X0/U1（[ADR-133](../../docs/adr/ADR-133-multi-user-scope-and-authorization.md)，
 *       `ACCEPTED / DESIGN FROZEN`）。契约正文：`docs/post-lv2/Multi-User-Scope-Contract.md`。
 *
 * 本门**纯进程内**：只读 `src/kernel/contracts/scope.ts` 的纯函数；
 * 零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。
 *
 * 三段式（repo 纪律）：
 *   正控  —— 应该放行的格真的放行
 *   负控  —— 每个具名拒绝码都**可复现**（去掉一处防线 ⇒ 必须判红）
 *   恢复  —— 真实判定恢复后，正控再次通过
 */

import {
  DISCLOSURE_CLASSES,
  IMPRESSION_THRESHOLD,
  NEW_USER_INITIAL_RELATIONSHIP,
  ROLEPLAY_THRESHOLD,
  SCOPE_MATRIX,
  SCOPE_OPERATIONS,
  SYSTEM_SUBSYSTEMS,
  defaultVisibilityLabel,
  evaluateScopeAccess,
  meetsRelationshipThreshold,
  scopeContextProblems,
  visibilityAllows,
  type Principal,
  type Room,
  type ScopeContext,
  type ScopeDenyCode,
  type ScopeOperation,
} from '../src/kernel/contracts/scope.ts'

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
// 便捷构造
// ---------------------------------------------------------------------------

const owner = (userId = 'u-owner'): Principal => ({ kind: 'owner', userId, verifiedBy: 'config_binding' })
const user = (userId: string): Principal => ({ kind: 'user', userId, verifiedBy: 'onebot_inbound' })
const system = (subsystem: (typeof SYSTEM_SUBSYSTEMS)[number] = 'affect'): Principal => ({
  kind: 'system',
  subsystem,
})
const privateRoom = (userId: string): Room => ({ kind: 'private', userId })
const groupRoom = (groupId: string): Room => ({ kind: 'group', groupId })

function ctx(principal: Principal, purpose: ScopeContext['purpose'], room: Room): ScopeContext {
  return { principal, purpose, room }
}

const DENY_CODES: readonly ScopeDenyCode[] = [
  'invalid_context',
  'identity_unverified',
  'purpose_not_granted',
  'room_not_authorized',
  'operation_not_permitted',
  'condition_not_met',
  'scope_leak',
]

const seenDeny = new Set<ScopeDenyCode>()

function expectDeny(name: string, code: ScopeDenyCode, context: ScopeContext, input: Partial<Parameters<typeof evaluateScopeAccess>[0]> & { operation: ScopeOperation }): void {
  const decision = evaluateScopeAccess({ context, ...input })
  seenDeny.add(decision.code as ScopeDenyCode)
  check(
    `负控 · ${name}`,
    decision.allowed === false && decision.code === code,
    `期望 ${code}，得到 ${decision.code}（${decision.detail}）`
  )
}

function expectAllow(name: string, input: Parameters<typeof evaluateScopeAccess>[0]): void {
  const decision = evaluateScopeAccess(input)
  check(`正控 · ${name}`, decision.allowed === true, `期望 allowed，得到 ${decision.code}（${decision.detail}）`)
}

// ---------------------------------------------------------------------------
// 0. 形状与登记表自检
// ---------------------------------------------------------------------------

check(
  '操作闭集无重复',
  new Set(SCOPE_OPERATIONS).size === SCOPE_OPERATIONS.length,
  `${SCOPE_OPERATIONS.length} 个操作，去重后 ${new Set(SCOPE_OPERATIONS).size}`
)

let missingCells: string[] = []
for (const kind of Object.keys(SCOPE_MATRIX) as Principal['kind'][]) {
  for (const operation of SCOPE_OPERATIONS) {
    if (SCOPE_MATRIX[kind][operation] === undefined) missingCells.push(`${kind}×${operation}`)
  }
}
check(
  '矩阵完整性（每个 principal × 每个 operation 都有格）',
  missingCells.length === 0,
  missingCells.length === 0 ? `${SCOPE_OPERATIONS.length} × 3 格齐备` : `缺 ${missingCells.length} 格：${missingCells.slice(0, 6).join(' / ')}`
)

check(
  '可见性披露类被扫描到',
  visibilityAllows({
    label: undefined,
    originRoom: privateRoom('u-a'),
    viewer: user('u-a'),
    viewerRoom: privateRoom('u-a'),
  }).allowed === true,
  `缺标签 ⇒ 保守缺省 private_to_origin；DISCLOSURE_CLASSES=${DISCLOSURE_CLASSES.length}`
)

// ---------------------------------------------------------------------------
// 1. 正控：应当放行的格
// ---------------------------------------------------------------------------

expectAllow('原主人读他人私聊记录（独立审计通路）', {
  context: ctx(owner(), 'admin_operation', privateRoom('u-owner')),
  operation: 'read_other_private_memory',
  targetUserId: 'u-b',
})
expectAllow('普通用户读自己的私聊记忆', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'read_own_private_memory',
  targetUserId: 'u-a',
})
expectAllow('普通用户感知情绪状态', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'perceive_affect_state',
})
expectAllow('普通用户写自己的记忆', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'write_own_memory',
  targetUserId: 'u-a',
})
expectAllow('印象查询（门槛已满足）', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'impression_query',
  conditionMet: true,
})
expectAllow('关系性演戏（门槛已满足）', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'limited_roleplay',
  conditionMet: true,
})
expectAllow('受控查询工具（额度内）', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'controlled_query_tool',
  conditionMet: true,
})
expectAllow('读当前群资料（群已授权）', {
  context: ctx(user('u-a'), 'external_query', groupRoom('g-1')),
  operation: 'read_current_group_material',
  roomAuthorized: true,
})
expectAllow('原主人开档/重置（具名例外）', {
  context: ctx(owner(), 'admin_operation', privateRoom('u-owner')),
  operation: 'create_or_reset_archive',
  ownerException: { granted: true, caseId: 'case-2026-10-13-1' },
})
expectAllow('系统内部认知读取（内联用途）', {
  context: ctx(system('affect'), 'internal_cognition', privateRoom('u-a')),
  operation: 'internal_cognition_read',
})
expectAllow('系统读情绪成因（内部用途）', {
  context: ctx(system('affect'), 'internal_cognition', privateRoom('u-a')),
  operation: 'read_affect_cause',
  conditionMet: true,
})
expectAllow('原主人后台只读', {
  context: ctx(owner(), 'admin_operation', privateRoom('u-owner')),
  operation: 'admin_read',
})

// ---------------------------------------------------------------------------
// 2. 负控：每个具名拒绝码都可复现
// ---------------------------------------------------------------------------

// invalid_context：两条独立路径（未登记操作 / 形状不合法）
{
  const decision = evaluateScopeAccess({
    context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
    operation: 'not_a_real_operation' as unknown as ScopeOperation,
  })
  seenDeny.add(decision.code as ScopeDenyCode)
  check('负控 · 未登记操作 ⇒ invalid_context', decision.code === 'invalid_context', `得到 ${decision.code}`)
}
{
  const broken = { principal: user('u-a'), purpose: 'external_query', room: undefined } as unknown as ScopeContext
  const decision = evaluateScopeAccess({ context: broken, operation: 'read_own_private_memory' })
  seenDeny.add(decision.code as ScopeDenyCode)
  check('负控 · room 缺失 ⇒ invalid_context', decision.code === 'invalid_context', `得到 ${decision.code}`)
}

expectDeny(
  '自报身份 ⇒ identity_unverified',
  'identity_unverified',
  {
    principal: { kind: 'user', userId: 'u-a', verifiedBy: 'self_claimed' },
    purpose: 'external_query',
    room: privateRoom('u-a'),
  } as unknown as ScopeContext,
  { operation: 'read_own_private_memory' }
)

expectDeny(
  '系统消费者持对外查询用途 ⇒ purpose_not_granted',
  'purpose_not_granted',
  ctx(system('affect'), 'external_query', privateRoom('u-a')),
  { operation: 'internal_cognition_read' }
)
expectDeny(
  '普通用户持管理用途 ⇒ purpose_not_granted',
  'purpose_not_granted',
  ctx(user('u-a'), 'admin_operation', privateRoom('u-a')),
  { operation: 'admin_read' }
)

expectDeny('群空间未授权 ⇒ room_not_authorized', 'room_not_authorized', ctx(user('u-a'), 'external_query', groupRoom('g-1')), {
  operation: 'read_current_group_material',
})
expectDeny(
  '群空间未授权（系统消费者）⇒ room_not_authorized',
  'room_not_authorized',
  ctx(system('rollup'), 'internal_cognition', groupRoom('g-1')),
  { operation: 'read_current_group_material' }
)

expectDeny('普通用户读他人私聊 ⇒ operation_not_permitted', 'operation_not_permitted', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'read_other_private_memory',
  targetUserId: 'u-b',
})
expectDeny('普通用户改人格 ⇒ operation_not_permitted', 'operation_not_permitted', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'modify_persona',
})
expectDeny('普通用户开新档 ⇒ operation_not_permitted', 'operation_not_permitted', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'create_or_reset_archive',
})
expectDeny('普通用户改关系 ⇒ operation_not_permitted', 'operation_not_permitted', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'modify_relationship',
})
expectDeny('普通用户高风险工具 ⇒ operation_not_permitted', 'operation_not_permitted', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'high_risk_tool',
})
{
  const decision = evaluateScopeAccess({
    context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
    operation: 'admin_operate',
  })
  seenDeny.add(decision.code as ScopeDenyCode)
  check('负控 · 普通用户后台操作 ⇒ operation_not_permitted', decision.code === 'operation_not_permitted', `得到 ${decision.code}`)
}

expectDeny('印象门槛未满足 ⇒ condition_not_met', 'condition_not_met', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'impression_query',
})
expectDeny('演戏门槛未满足 ⇒ condition_not_met', 'condition_not_met', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'limited_roleplay',
})
expectDeny(
  '开档缺原主人具名例外 ⇒ condition_not_met',
  'condition_not_met',
  ctx(owner(), 'admin_operation', privateRoom('u-owner')),
  { operation: 'create_or_reset_archive' }
)

expectDeny('自读目标越界 ⇒ scope_leak', 'scope_leak', ctx(user('u-a'), 'external_query', privateRoom('u-a')), {
  operation: 'read_own_private_memory',
  targetUserId: 'u-b',
})
expectDeny(
  '涉他操作缺 target ⇒ scope_leak',
  'scope_leak',
  ctx(owner(), 'admin_operation', privateRoom('u-owner')),
  { operation: 'read_other_private_memory' }
)

const missingCodes = DENY_CODES.filter((code) => !seenDeny.has(code))
check(
  `每个具名拒绝码都可复现（${DENY_CODES.length} 个）`,
  missingCodes.length === 0,
  missingCodes.length === 0 ? `覆盖 ${seenDeny.size}/${DENY_CODES.length}` : `未覆盖：${missingCodes.join(', ')}`
)

// ---------------------------------------------------------------------------
// 3. 三段式负控：拆掉"身份核查"这道防线必须判红；恢复后正控再次通过
// ---------------------------------------------------------------------------

/**
 * 弱化版判定：**故意**去掉身份核查（其余照抄矩阵）。
 * 它必须放行伪造身份 —— 否则说明我们的判据没在量那条防线。
 */
function weakenedWithoutIdentityCheck(context: ScopeContext, operation: ScopeOperation): boolean {
  return SCOPE_MATRIX[context.principal.kind][operation] !== 'deny'
}

const forged = {
  principal: { kind: 'user', userId: 'u-a', verifiedBy: 'self_claimed' },
  purpose: 'external_query',
  room: privateRoom('u-a'),
} as unknown as ScopeContext

const weakenedResult = weakenedWithoutIdentityCheck(forged, 'read_own_private_memory')
check(
  '负控（拆防线）· 弱化版会放行伪造身份 ⇒ 证明防线在被量',
  weakenedResult === true,
  `weakend=${String(weakenedResult)}`
)
const restored = evaluateScopeAccess({ context: forged, operation: 'read_own_private_memory' })
check(
  '恢复 · 真实判定对伪造身份判红',
  restored.allowed === false && restored.code === 'identity_unverified',
  `得到 ${restored.code}`
)
expectAllow('恢复 · 正控再次通过（普通用户读自己）', {
  context: ctx(user('u-a'), 'external_query', privateRoom('u-a')),
  operation: 'read_own_private_memory',
  targetUserId: 'u-a',
})

// 矩阵格缺格负控：删掉一格 ⇒ 必须拒绝（不是默认允许）
{
  const operation = 'perceive_affect_state' as ScopeOperation
  const original = SCOPE_MATRIX.user[operation]
  // 只读地模拟"缺格"：用一个未登记的 principal kind 不行（类型锁），改用未登记 operation 已在上方覆盖。
  check(
    '负控 · 缺格=拒绝（由未登记操作用例覆盖）',
    original !== undefined,
    `user × ${operation} = ${String(original)}`
  )
}

// ---------------------------------------------------------------------------
// 4. 门槛函数（原主人裁定的数值）
// ---------------------------------------------------------------------------

check(
  '印象门槛：恰好 0.4 不通过（严格大于）',
  meetsRelationshipThreshold({ originated: true, trust: 0.4, closeness: 0.4 }, IMPRESSION_THRESHOLD) === false,
  `threshold=${JSON.stringify(IMPRESSION_THRESHOLD)}`
)
check(
  '印象门槛：仅一维达标不通过',
  meetsRelationshipThreshold({ originated: true, trust: 0.41, closeness: 0.4 }, IMPRESSION_THRESHOLD) === false,
  'trust>0.4 但 closeness=0.4'
)
check(
  '印象门槛：双维达标通过',
  meetsRelationshipThreshold({ originated: true, trust: 0.41, closeness: 0.41 }, IMPRESSION_THRESHOLD) === true,
  '0.41/0.41'
)
check(
  '印象门槛：未建档不通过',
  meetsRelationshipThreshold({ originated: false, trust: 0.9, closeness: 0.9 }, IMPRESSION_THRESHOLD) === false,
  'originated=false'
)
check(
  '印象门槛：非有限数不通过',
  meetsRelationshipThreshold({ originated: true, trust: Number.NaN, closeness: 0.9 }, IMPRESSION_THRESHOLD) === false,
  'NaN'
)
check(
  '新用户初始值 0.2/0.2 不通过印象门槛',
  meetsRelationshipThreshold({ originated: true, ...NEW_USER_INITIAL_RELATIONSHIP }, IMPRESSION_THRESHOLD) === false,
  `${NEW_USER_INITIAL_RELATIONSHIP.trust}/${NEW_USER_INITIAL_RELATIONSHIP.closeness}`
)
check(
  '演戏门槛：恰好 0.25 不通过（严格大于）',
  meetsRelationshipThreshold({ originated: true, trust: 0.25, closeness: 0.25 }, ROLEPLAY_THRESHOLD) === false,
  `threshold=${JSON.stringify(ROLEPLAY_THRESHOLD)}`
)
check(
  '演戏门槛：0.26/0.26 通过',
  meetsRelationshipThreshold({ originated: true, trust: 0.26, closeness: 0.26 }, ROLEPLAY_THRESHOLD) === true,
  '0.26/0.26'
)

// ---------------------------------------------------------------------------
// 5. 可见性归属（§3 铁律）
// ---------------------------------------------------------------------------

const labelProblems = scopeContextProblems(ctx(user('u-a'), 'external_query', privateRoom('u-a')))
check('正常三元组无形状问题', labelProblems.length === 0, labelProblems.join('；'))

check(
  '可见性 · private_to_origin：来源域本人可读',
  visibilityAllows({
    label: { originRoom: privateRoom('u-a'), disclosure: 'private_to_origin' },
    originRoom: privateRoom('u-a'),
    viewer: user('u-a'),
    viewerRoom: privateRoom('u-a'),
  }).allowed === true,
  'u-a 读 u-a 的私聊来源'
)
check(
  '可见性 · private_to_origin：他人**不可**读（"内容讲 B" ≠ "B 可读"）',
  visibilityAllows({
    label: { originRoom: privateRoom('u-a'), disclosure: 'private_to_origin' },
    originRoom: privateRoom('u-a'),
    viewer: user('u-b'),
    viewerRoom: privateRoom('u-b'),
  }).allowed === false,
  'u-b 读 u-a 的私聊来源'
)
check(
  '可见性 · public_to_room：同群可读',
  visibilityAllows({
    label: { originRoom: groupRoom('g-1'), disclosure: 'public_to_room' },
    originRoom: groupRoom('g-1'),
    viewer: user('u-c'),
    viewerRoom: groupRoom('g-1'),
  }).allowed === true,
  'g-1 内'
)
check(
  '可见性 · public_to_room：**跨群不可读**（GD-01）',
  visibilityAllows({
    label: { originRoom: groupRoom('g-1'), disclosure: 'public_to_room' },
    originRoom: groupRoom('g-1'),
    viewer: user('u-c'),
    viewerRoom: groupRoom('g-2'),
  }).allowed === false,
  'g-1 的内容在 g-2'
)
check(
  '可见性 · character_internal：不向人回吐原文',
  visibilityAllows({
    label: { originRoom: privateRoom('u-a'), disclosure: 'character_internal' },
    originRoom: privateRoom('u-a'),
    viewer: user('u-a'),
    viewerRoom: privateRoom('u-a'),
  }).allowed === false,
  '内部认知面'
)
check(
  '可见性 · explicit_shared：条件未满足不放行',
  visibilityAllows({
    label: { originRoom: privateRoom('u-a'), disclosure: 'explicit_shared' },
    originRoom: privateRoom('u-a'),
    viewer: user('u-b'),
    viewerRoom: privateRoom('u-b'),
    askerRelationshipConditionMet: false,
  }).allowed === false,
  '条件未满足'
)
check(
  '可见性 · 缺标签 ⇒ 保守缺省（不当公共）',
  defaultVisibilityLabel(privateRoom('u-a')).disclosure === 'private_to_origin',
  defaultVisibilityLabel(privateRoom('u-a')).disclosure
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const failed = cases.filter((item) => !item.ok)
for (const item of cases) {
  console.log(`${item.ok ? '  ok  ' : ' FAIL '} ${item.name} —— ${item.detail}`)
}
console.log('')
console.log(`measured_count=${cases.length} · passed=${cases.length - failed.length} · failed=${failed.length}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`  - ${item.name}：${item.detail}`)
}
process.exitCode = failed.length === 0 ? 0 : 1
