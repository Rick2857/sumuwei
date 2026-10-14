/**
 * U1 · 记录可见性判定门（`u1:record-visibility:verify`）—— WP5 的判定核心
 *
 * 归属：多用户补充计划 U1（`ADR-133` `D07`/`D08` + `ADR-137`；契约 §3/§4）。
 *
 * **纯进程内**：只读 `src/kernel/contracts/record-visibility.ts`（以及它组合的 scope 判定）；
 * 零数据库 / 零模型 / 零出网 / 不占端口 / 不写证据 / 不改工作树。
 *
 * 它回答：**读取面唯一该调的那个函数**在各种组合下的结论对不对。
 * ⚠️ 它**不**证明任何读取面已经接线（那是 WP5 的实现）；今天**一个面都还没接**。
 *
 * 三段式：正控（五种该放行的形状）· 负控（八种该拒的形状 + **缺标签的保守性专项**）
 *        · 拆防线（把缺标签当"公共" ⇒ 会在某一格放行，与真实判定相反）
 */

import {
  canReadRecord,
  decideOwnerPrivilegedRecordRead,
  decideRecordVisibility,
  readOperationFor,
} from '../src/kernel/contracts/record-visibility.ts'
import type { DisclosureClass, Principal, Room, VisibilityLabel } from '../src/kernel/contracts/scope.ts'

interface Check {
  readonly id: string
  readonly label: string
  readonly pass: boolean
  readonly detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const user = (id: string): Principal => ({ kind: 'user', userId: id, verifiedBy: 'onebot_inbound' })
const owner = (id = 'u-owner'): Principal => ({ kind: 'owner', userId: id, verifiedBy: 'config_binding' })
const system = (): Principal => ({ kind: 'system', subsystem: 'affect' })
const priv = (id: string): Room => ({ kind: 'private', userId: id })
const grp = (id: string): Room => ({ kind: 'group', groupId: id })
const label = (room: Room, disclosure: DisclosureClass): VisibilityLabel => ({ originRoom: room, disclosure })

/** 便捷：一次判定（默认 purpose=external_query） */
function ask(input: {
  principal: Principal
  viewerRoom: Room
  label?: VisibilityLabel
  originRoom: Room
  roomAuthorized?: boolean
  conditionMet?: boolean
  purpose?: 'external_query' | 'internal_cognition' | 'admin_operation'
}): ReturnType<typeof decideRecordVisibility> {
  return canReadRecord({
    principal: input.principal,
    purpose: input.purpose ?? 'external_query',
    viewerRoom: input.viewerRoom,
    label: input.label,
    originRoom: input.originRoom,
    ...(input.roomAuthorized === undefined ? {} : { roomAuthorized: input.roomAuthorized }),
    ...(input.conditionMet === undefined ? {} : { askerRelationshipConditionMet: input.conditionMet }),
  })
}

// ===========================================================================
// T1 正控 · 五种该放行的形状
// ===========================================================================
{
  const own = ask({ principal: user('u-a'), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a') })
  record('T1.1', '普通用户读**自己私聊来源**的记录 ⇒ 放行', own.allowed, `code=${own.scopeCode} · reason=${own.visibilityReason}`)
}
{
  const sameGroup = ask({
    principal: user('u-c'),
    viewerRoom: grp('g-1'),
    label: label(grp('g-1'), 'public_to_room'),
    originRoom: grp('g-1'),
    roomAuthorized: true,
  })
  record('T1.2', '**同群**公开记录（群已授权）⇒ 放行', sameGroup.allowed, `code=${sameGroup.scopeCode} · reason=${sameGroup.visibilityReason}`)
}
{
  /*
   * `explicit_shared` 的**放宽**在 `ADR-137` `R-WP4-2` 里被明确推迟（首版只做
   * `private_to_origin` + `character_internal`）⇒ 今天的正确读数是 **失败关闭：拒**。
   * 可见性侧说"可以"，但授权侧（矩阵里"他人的私聊来源"那一格）**还没有**放宽的格 ——
   * 两者都必须过，所以结果是拒。这条**不是**缺陷，是已裁定的首版范围。
   */
  const shared = ask({
    principal: user('u-b'),
    viewerRoom: priv('u-b'),
    label: label(priv('u-a'), 'explicit_shared'),
    originRoom: priv('u-a'),
    conditionMet: true,
  })
  record(
    'T1.3',
    '`explicit_shared` **尚未放宽**（R-WP4-2 已推迟）⇒ 今天拒且失败关闭（可见性侧说可以，授权侧还没这一格）',
    !shared.allowed && shared.scopeCode === 'operation_not_permitted' && shared.visibilityReason.includes('显式分享'),
    `code=${shared.scopeCode} · reason=${shared.visibilityReason}`
  )
}
{
  /*
   * ⚠️ **原主人特权不是"把普通读取放宽给 owner"**（那样它成了一条静默旁路）。
   *    普通读取面**拒**他（失败关闭）；特权读取走**独立、带审计**的那条通路。
   */
  const ownerGeneric = ask({ principal: owner(), viewerRoom: priv('u-owner'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a') })
  record(
    'T1.4',
    '普通读取面**拒**原主人读他人私聊来源（特权不在这里静默放宽）',
    !ownerGeneric.allowed,
    `code=${ownerGeneric.scopeCode} · reason=${ownerGeneric.visibilityReason}`
  )
  const withAudit = decideOwnerPrivilegedRecordRead({
    context: { principal: owner(), purpose: 'admin_operation', room: priv('u-owner') },
    label: label(priv('u-a'), 'private_to_origin'),
    originRoom: priv('u-a'),
    auditCaseId: 'case-u1-visibility-1',
  })
  record(
    'T1.4b',
    '特权通路：owner + admin_operation + **有审计条目** ⇒ 放行，且 `privileged=true`',
    withAudit.allowed && withAudit.privileged === true,
    `code=${withAudit.scopeCode} · privileged=${String(withAudit.privileged)}`
  )
  const noAudit = decideOwnerPrivilegedRecordRead({
    context: { principal: owner(), purpose: 'admin_operation', room: priv('u-owner') },
    label: label(priv('u-a'), 'private_to_origin'),
    originRoom: priv('u-a'),
    auditCaseId: '   ',
  })
  const wrongPurpose = decideOwnerPrivilegedRecordRead({
    context: { principal: owner(), purpose: 'external_query', room: priv('u-owner') },
    label: label(priv('u-a'), 'private_to_origin'),
    originRoom: priv('u-a'),
    auditCaseId: 'case-x',
  })
  const notOwner = decideOwnerPrivilegedRecordRead({
    context: { principal: user('u-b'), purpose: 'admin_operation', room: priv('u-b') },
    label: label(priv('u-a'), 'private_to_origin'),
    originRoom: priv('u-a'),
    auditCaseId: 'case-x',
  })
  record(
    'T1.4c',
    '特权通路**三处失败关闭**：无审计条目 / 用途不对 / 不是原主人 ⇒ 全拒',
    !noAudit.allowed && noAudit.scopeCode === 'condition_not_met' && !wrongPurpose.allowed && !notOwner.allowed,
    `noAudit=${noAudit.scopeCode} · wrongPurpose=${wrongPurpose.scopeCode} · notOwner=${notOwner.scopeCode}`
  )
}
{
  const internal = ask({ principal: system(), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a'), purpose: 'internal_cognition' })
  const operation = readOperationFor({ viewer: system(), viewerRoom: priv('u-a'), originRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin') })
  record(
    'T1.5',
    '内部认知（system / internal_cognition）读私聊来源 ⇒ 放行，且走的是 **internal_cognition_read** 那一格',
    internal.allowed && operation === 'internal_cognition_read',
    `operation=${operation} · allowed=${String(internal.allowed)}`
  )
}

// ===========================================================================
// T2 负控 · 八种该拒的形状
// ===========================================================================
{
  const other = ask({ principal: user('u-b'), viewerRoom: priv('u-b'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a') })
  record('T2.1', '普通用户读**他人私聊来源** ⇒ 拒', !other.allowed, `code=${other.scopeCode} · reason=${other.visibilityReason}`)
}
{
  const crossGroup = ask({ principal: user('u-c'), viewerRoom: grp('g-2'), label: label(grp('g-1'), 'public_to_room'), originRoom: grp('g-1'), roomAuthorized: true })
  record('T2.2', '**跨群**读同群公开记录 ⇒ 拒', !crossGroup.allowed, `code=${crossGroup.scopeCode} · reason=${crossGroup.visibilityReason}`)
}
{
  const inPrivate = ask({ principal: user('u-c'), viewerRoom: priv('u-c'), label: label(grp('g-1'), 'public_to_room'), originRoom: grp('g-1'), roomAuthorized: true })
  record('T2.3', '把**同群公开**记录拿到私聊里读 ⇒ 拒', !inPrivate.allowed, `code=${inPrivate.scopeCode} · reason=${inPrivate.visibilityReason}`)
}
{
  const unshared = ask({ principal: user('u-b'), viewerRoom: priv('u-b'), label: label(priv('u-a'), 'explicit_shared'), originRoom: priv('u-a'), conditionMet: false })
  record('T2.4', '**显式分享但条件不满足** ⇒ 拒', !unshared.allowed, `code=${unshared.scopeCode} · reason=${unshared.visibilityReason}`)
}
{
  const noRoomAuth = ask({ principal: user('u-c'), viewerRoom: grp('g-1'), label: label(grp('g-1'), 'public_to_room'), originRoom: grp('g-1') })
  record('T2.5', '群**未获授权**（`roomAuthorized` 未提供）⇒ 拒', !noRoomAuth.allowed && noRoomAuth.scopeCode === 'room_not_authorized', `code=${noRoomAuth.scopeCode}`)
}
{
  const sysExternal = ask({ principal: system(), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a'), purpose: 'external_query' })
  record('T2.6', '内部消费者持**对外查询**用途 ⇒ 拒（purpose_not_granted）', !sysExternal.allowed && sysExternal.scopeCode === 'purpose_not_granted', `code=${sysExternal.scopeCode}`)
}
{
  const adminByUser = ask({ principal: user('u-a'), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a'), purpose: 'admin_operation' })
  record('T2.7', '普通用户持**管理用途** ⇒ 拒（purpose_not_granted）', !adminByUser.allowed && adminByUser.scopeCode === 'purpose_not_granted', `code=${adminByUser.scopeCode}`)
}
{
  const internalLabel = ask({ principal: user('u-a'), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'character_internal'), originRoom: priv('u-a') })
  record('T2.8', '`character_internal` 的记录**不向人**回吐原文 ⇒ 拒', !internalLabel.allowed, `code=${internalLabel.scopeCode} · reason=${internalLabel.visibilityReason}`)
}

// ===========================================================================
// T3 **缺标签的保守性专项**（`ADR-137` `R-WP4-3` / X0 `VL-01`）
// ===========================================================================
{
  const ownNoLabel = ask({ principal: user('u-a'), viewerRoom: priv('u-a'), originRoom: priv('u-a') })
  record(
    'T3.1',
    '缺标签 + 来源域本人 ⇒ 放行，但 `labelMissing=true` 被**如实标出**',
    ownNoLabel.allowed && ownNoLabel.labelMissing === true,
    `allowed=${String(ownNoLabel.allowed)} · labelMissing=${String(ownNoLabel.labelMissing)}`
  )
}
{
  const strangerNoLabel = ask({ principal: user('u-b'), viewerRoom: priv('u-b'), originRoom: priv('u-a') })
  record(
    'T3.2',
    '缺标签 + 他人 ⇒ 拒（**不会**因为"没有标签"就放行）',
    !strangerNoLabel.allowed && strangerNoLabel.labelMissing === true,
    `code=${strangerNoLabel.scopeCode} · reason=${strangerNoLabel.visibilityReason}`
  )
}
{
  const groupNoLabel = ask({ principal: user('u-c'), viewerRoom: grp('g-1'), originRoom: grp('g-1'), roomAuthorized: true })
  record(
    'T3.3',
    '缺标签 + 群来源 ⇒ 拒（群**不**因缺标签而可见）',
    !groupNoLabel.allowed && groupNoLabel.labelMissing === true,
    `code=${groupNoLabel.scopeCode} · reason=${groupNoLabel.visibilityReason}`
  )
}
{
  const withLabel = ask({ principal: user('u-a'), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a') })
  record('T3.4', '有标签 ⇒ `labelMissing=false`（读数能区分"有标签"与"缺省"）', withLabel.labelMissing === false, `labelMissing=${String(withLabel.labelMissing)}`)
}

// ===========================================================================
// T4 `readOperationFor` 派生正确（矩阵格不能挑错）
// ===========================================================================
{
  const cases: { id: string; expected: string; actual: string }[] = [
    { id: 'T4.1', expected: 'read_own_private_memory', actual: readOperationFor({ viewer: user('u-a'), viewerRoom: priv('u-a'), originRoom: priv('u-a'), label: undefined }) },
    { id: 'T4.2', expected: 'read_other_private_memory', actual: readOperationFor({ viewer: user('u-b'), viewerRoom: priv('u-b'), originRoom: priv('u-a'), label: undefined }) },
    { id: 'T4.3', expected: 'read_current_group_material', actual: readOperationFor({ viewer: user('u-c'), viewerRoom: grp('g-1'), originRoom: grp('g-1'), label: undefined }) },
    { id: 'T4.4', expected: 'read_other_group_material', actual: readOperationFor({ viewer: user('u-c'), viewerRoom: grp('g-2'), originRoom: grp('g-1'), label: undefined }) },
    { id: 'T4.5', expected: 'internal_cognition_read', actual: readOperationFor({ viewer: system(), viewerRoom: priv('u-a'), originRoom: priv('u-a'), label: undefined }) },
  ]
  for (const item of cases) {
    const names: Record<string, string> = {
      'T4.1': '自己的私聊来源 ⇒ read_own_private_memory',
      'T4.2': '他人的私聊来源 ⇒ read_other_private_memory',
      'T4.3': '同一群 ⇒ read_current_group_material',
      'T4.4': '别的群 ⇒ read_other_group_material',
      'T4.5': '内部消费者 ⇒ internal_cognition_read（不是"读他人私聊"那一格）',
    }
    record(item.id, names[item.id] ?? item.id, item.actual === item.expected, `actual=${item.actual}`)
  }
}

// ===========================================================================
// T5 `allowed = 授权 && 可见性`（两侧都必须过）
// ===========================================================================
{
  const denied = ask({ principal: user('u-b'), viewerRoom: priv('u-b'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a') })
  const scopeDenied = denied.scopeCode !== 'allowed'
  record(
    'T5.1',
    '拒绝时**至少有一侧**给出具名否决（授权码 ≠ allowed 或可见性理由非空）',
    scopeDenied || denied.visibilityReason.length > 0,
    `scopeCode=${denied.scopeCode} · reason=${denied.visibilityReason}`
  )
  const allowed = ask({ principal: user('u-a'), viewerRoom: priv('u-a'), label: label(priv('u-a'), 'private_to_origin'), originRoom: priv('u-a') })
  record('T5.2', '放行时 `scopeCode === allowed`', allowed.allowed && allowed.scopeCode === 'allowed', `code=${allowed.scopeCode}`)
}

// ===========================================================================
// T6 拆防线 · 把缺标签当"公共"⇒ 会在某一格放行，与真实判定相反
// ===========================================================================
{
  // 弱化版：缺标签时按 public_to_room 处理 —— 正是"最保守"那条防线被拆掉的形状
  const weakened = (originRoom: Room, viewerRoom: Room): boolean =>
    originRoom.kind === 'group' && viewerRoom.kind === 'group' && originRoom.groupId === viewerRoom.groupId
  const real = ask({ principal: user('u-c'), viewerRoom: grp('g-1'), originRoom: grp('g-1'), roomAuthorized: true })
  record(
    'T6.1',
    '拆防线 · 缺标签当"同群可见" ⇒ 该格会放行，而**真实判定拒绝**（证明保守缺省被量到）',
    weakened(grp('g-1'), grp('g-1')) === true && real.allowed === false,
    `weakened=${String(weakened(grp('g-1'), grp('g-1')))} · real=${String(real.allowed)}`
  )
  record('T6.2', '恢复 · 真实判定对该格仍是拒绝', real.allowed === false, `code=${real.scopeCode}`)
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:record-visibility:verify = ${passed ? 'PASS' : 'FAIL'}`)
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}
process.exitCode = passed ? 0 : 1
